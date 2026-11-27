"use strict";

/**
 * T3 Code Upgrade Anti-Drop Guardian
 *
 * Prevents HUD from silently disappearing after T3 Code auto-updates (Squirrel/ShipIt),
 * without modifying app.asar, without breaking signatures, and NEVER interrupting live tasks.
 *
 * Safety contract:
 *   1. Acquire exclusive run/handoff.lock before critical handoff evaluation.
 *   2. If bootstrap.lock shows a live bootstrap in progress -> no-op.
 *   3. If T3 is already mounted with HUD -> reset failure counter & no-op.
 *   4. If T3 is freshly booted WITH --remote-debugging-port= -> wait & re-check, never double-kill.
 *   5. If T3 is unmounted AND freshly booted (<= COLD_BOOT_MAX_AGE_SEC) AND strictly verified idle
 *      AND not in cooldown -> quit old PID, confirm old PID exited, run bootstrap.cjs and confirm
 *      new PID mounted before reporting reattached.
 *   6. If T3 is already running (> COLD_BOOT_MAX_AGE_SEC) OR busy / DB missing / schema unknown /
 *      env unreadable OR cooldown triggered -> NEVER kill or restart T3; notify instead.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn, spawnSync } = require("node:child_process");
const { checkHud } = require("./hud-health.cjs");
let processStart = () => null;
let readProcessEnv = () => null;
try {
  const telemetryGuard = require("./hub-telemetry-guard.cjs");
  if (typeof telemetryGuard.processStart === "function") processStart = telemetryGuard.processStart;
  if (typeof telemetryGuard.readProcessEnv === "function") readProcessEnv = telemetryGuard.readProcessEnv;
} catch {}
const {
  isPidAlive: defaultIsPidAlive,
  ensurePrivateDir,
  ensurePrivateLogFile,
  readRegularFileNoFollow,
  writeFileAtomicNoFollow,
  acquireExclusiveLock,
  isElectronRunAsNodeEnabled,
  checkNodeCapabilities,
  resolveNodeRuntime: resolveRuntimeCore,
} = require("./hud-runtime.cjs");

const LAUNCH_AGENT_LABEL = "com.t3hud.guardian";
const COLD_BOOT_MAX_AGE_SEC = 18;
const COOLDOWN_MIN_INTERVAL_MS = 45_000;
const COOLDOWN_FAILURE_WINDOW_MS = 10 * 60 * 1000;
const COOLDOWN_MAX_FAILURES = 2;
const APP_CANDIDATES = [
  "/Applications/T3 Code (Beta).app",
  "/Applications/T3 Code.app",
  "/Applications/T3 Code (Nightly).app",
];

function parseEtimeSeconds(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  let days = 0;
  let rest = s;
  const dashIdx = rest.indexOf("-");
  if (dashIdx >= 0) {
    days = Number(rest.slice(0, dashIdx));
    rest = rest.slice(dashIdx + 1);
  }
  const parts = rest.split(":").map((v) => Number(v));
  if (parts.some((n) => !Number.isFinite(n) || n < 0) || !Number.isFinite(days)) return null;
  if (parts.length === 2) return days * 86400 + parts[0] * 60 + parts[1];
  if (parts.length === 3) return days * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function readBundleVersion(appBundle) {
  try {
    const plistPath = path.join(appBundle, "Contents", "Info.plist");
    if (!fs.existsSync(plistPath)) return null;
    const raw = fs.readFileSync(plistPath, "utf8");
    const verMatch = raw.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
    const buildMatch = raw.match(/<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/);
    const st = fs.statSync(plistPath);
    return {
      shortVersion: verMatch ? verMatch[1].trim() : "",
      buildVersion: buildMatch ? buildMatch[1].trim() : "",
      mtimeMs: Math.round(st.mtimeMs),
    };
  } catch {
    return null;
  }
}

function resolveT3AppBundles(homeDir = os.homedir(), envAppPath = process.env.T3_APP_PATH) {
  const all = [
    envAppPath,
    ...APP_CANDIDATES,
    path.join(homeDir, "Applications", "T3 Code (Beta).app"),
    path.join(homeDir, "Applications", "T3 Code.app"),
    path.join(homeDir, "Applications", "T3 Code (Nightly).app"),
  ].filter(Boolean);
  const found = [];
  const seen = new Set();
  for (const app of all) {
    const resolved = path.resolve(app);
    if (seen.has(resolved)) continue;
    const macosDir = path.join(resolved, "Contents", "MacOS");
    if (!fs.existsSync(macosDir)) continue;
    seen.add(resolved);
    found.push(resolved);
  }
  return found;
}

function resolveNodeRuntime({
  appBundle = null,
  homeDir = os.homedir(),
  envAppPath = process.env.T3_APP_PATH,
  systemNodeCandidates = null,
  checkCapabilities = true,
  probeCapability = checkNodeCapabilities,
} = {}) {
  const apps = appBundle
    ? [path.resolve(appBundle)]
    : (envAppPath ? [path.resolve(envAppPath)] : resolveT3AppBundles(homeDir, envAppPath));
  return resolveRuntimeCore({
    apps,
    systemNodeCandidates,
    checkCapabilities,
    probeCapability,
  });
}

function findRunningT3MainProcess(appBundle) {
  const macosDir = path.join(appBundle, "Contents", "MacOS");
  let binPath = null;
  try {
    const bins = fs.readdirSync(macosDir).filter((n) => !n.startsWith("."));
    const mainBin = bins.find((n) => /t3\s*code/i.test(n)) || bins[0];
    if (mainBin) binPath = path.join(macosDir, mainBin);
  } catch {
    return null;
  }
  if (!binPath) return null;
  const r = spawnSync("/bin/ps", ["-ax", "-o", "pid=,etime=,command="], { encoding: "utf8", timeout: 3000 });
  if (r.status !== 0 || !r.stdout) return null;
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const etimeSec = parseEtimeSeconds(m[2]);
    const cmd = m[3];
    if (!cmd.startsWith(binPath)) continue;
    if (cmd.length > binPath.length && cmd[binPath.length] !== " ") continue;
    if (/\.[cm]?js(\s|$)/.test(cmd) || /(^|\s)(-e|-p|--eval|--print)(\s|=|$)/.test(cmd) || /(^|\s)--type=/.test(cmd)) continue;
    return { pid, elapsedSec: etimeSec, binPath, appBundle, command: cmd };
  }
  return null;
}

function resolveProcessDataHome(pid, homeDir, readEnv, expectedExecPath) {
  const info = readEnv(pid, { expectedExecPath });
  if (!info?.env) return null;
  const override = info.env.T3CODE_HOME;
  if (override != null && typeof override !== "string") return null;
  if (override && !path.isAbsolute(override)) return null;
  let directory = path.resolve(override || path.join(homeDir, ".t3", "userdata"));
  try { directory = fs.realpathSync(directory); } catch {}
  return { override: override || null, directory };
}

/**
 * Strictly fail-safe active work detection.
 * Returns true (assume busy -> never interrupt) whenever:
 *  - targetPid env cannot be verified from kernel (when dbPath not explicitly given)
 *  - statev2.sqlite is missing or unreadable
 *  - expected orchestration tables are absent (unknown/migrated schema)
 *  - any active run or busy session exists
 */
function hasActiveT3Work({ homeDir = os.homedir(), dbPath = null, targetPid = null, readEnv = readProcessEnv } = {}) {
  let targetDb = dbPath;
  if (!targetDb) {
    const directory = targetPid == null ? path.join(homeDir, ".t3", "userdata")
      : resolveProcessDataHome(targetPid, homeDir, readEnv)?.directory;
    if (!directory) return true;
    targetDb = path.join(directory, "statev2.sqlite");
  }
  if (!targetDb || !fs.existsSync(targetDb)) return true;

  let db = null;
  try {
    const { DatabaseSync } = require("node:sqlite");
    db = new DatabaseSync(targetDb, { open: true, readOnly: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    const hasRuns = tables.includes("orchestration_v2_projection_runs");
    const hasSessions = tables.includes("orchestration_v2_projection_sessions");
    if (!hasRuns && !hasSessions) {
      // Unknown or migrated schema -> fail safe
      return true;
    }
    if (hasRuns) {
      const row = db.prepare("SELECT COUNT(*) AS cnt FROM orchestration_v2_projection_runs WHERE status IN ('running','starting','queued','preparing')").get();
      if (Number(row?.cnt || 0) > 0) return true;
    }
    if (hasSessions) {
      const row = db.prepare("SELECT COUNT(*) AS cnt FROM orchestration_v2_projection_sessions WHERE status IN ('running','starting','busy')").get();
      if (Number(row?.cnt || 0) > 0) return true;
    }
    return false;
  } catch {
    return true;
  } finally {
    try { db?.close(); } catch {}
  }
}

function escapeXml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function buildLaunchAgentPlist({
  cliPath, nodeBin, scriptPath, pluginDir, watchPaths, logPath, useRunAsNode, envAppPath, systemNodeBin,
}) {
  const watchItems = (watchPaths || []).map((p) => `    <string>${escapeXml(p)}</string>`).join("\n");
  let progArgs;
  const envEntries = [];

  if (cliPath) {
    // Stable entrypoint independent of the .app bundle being upgraded or RunAsNode fuse
    progArgs = [
      `    <string>/bin/bash</string>`,
      `    <string>${escapeXml(cliPath)}</string>`,
      `    <string>guardian</string>`,
      `    <string>--mode=plist-changed</string>`,
    ].join("\n");
    envEntries.push(`    <key>PATH</key>\n    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>`);
    envEntries.push(`    <key>T3_HUD_DIR</key>\n    <string>${escapeXml(pluginDir)}</string>`);
    if (envAppPath) envEntries.push(`    <key>T3_APP_PATH</key>\n    <string>${escapeXml(envAppPath)}</string>`);
    if (systemNodeBin) envEntries.push(`    <key>T3_HUD_NODE_BIN</key>\n    <string>${escapeXml(systemNodeBin)}</string>`);
  } else {
    const includeRunAsNode = useRunAsNode !== undefined
      ? Boolean(useRunAsNode)
      : !/(^|\/)node$/.test(String(nodeBin || ""));
    progArgs = [
      `    <string>${escapeXml(nodeBin)}</string>`,
      `    <string>${escapeXml(scriptPath)}</string>`,
      `    <string>--mode=plist-changed</string>`,
    ].join("\n");
    if (includeRunAsNode) {
      envEntries.push(`    <key>ELECTRON_RUN_AS_NODE</key>\n    <string>1</string>`);
    }
    envEntries.push(`    <key>T3_HUD_DIR</key>\n    <string>${escapeXml(pluginDir)}</string>`);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${progArgs}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries.join("\n")}
  </dict>
  <key>WatchPaths</key>
  <array>
${watchItems}
  </array>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logPath)}</string>
</dict>
</plist>
`;
}

function createGuardianManager({
  homeDir = os.homedir(),
  pluginDir = path.join(homeDir, ".t3", "hud-plugin"),
  cliPath = path.join(homeDir, ".t3", "bin", "t3-hud"),
  launchctl = null,
  envAppPath = process.env.T3_APP_PATH,
  systemNodeBin = process.env.T3_HUD_NODE_BIN,
} = {}) {
  const plistPath = path.join(homeDir, "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
  const scriptPath = path.join(pluginDir, "update-guardian.cjs");
  const logPath = path.join(pluginDir, "run", "guardian.log");

  const runLaunchctl = (args) => {
    if (typeof launchctl === "function") return launchctl(args);
    if (process.platform !== "darwin") return { ok: false, error: "unsupported_platform" };
    const r = spawnSync("/bin/launchctl", args, { encoding: "utf8", timeout: 4000 });
    return { ok: r.status === 0, status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
  };

  function getWatchPaths() {
    const apps = resolveT3AppBundles(homeDir, envAppPath);
    const list = envAppPath ? [path.resolve(envAppPath)]
      : (apps.length ? apps : ["/Applications/T3 Code.app", "/Applications/T3 Code (Beta).app"]);
    const paths = list.map((app) => path.join(app, "Contents", "Info.plist"));
    const appSupportDir = path.join(homeDir, "Library", "Application Support", "t3code-v2");
    if (fs.existsSync(appSupportDir)) {
      paths.push(path.join(appSupportDir, "SingletonLock"));
    }
    return paths;
  }

  function getStatus() {
    const installed = fs.existsSync(plistPath);
    const watchPaths = getWatchPaths();
    let loaded = false;
    if (installed && (process.platform === "darwin" || typeof launchctl === "function")) {
      const uid = typeof process.getuid === "function" ? process.getuid() : null;
      const probe = uid != null
        ? runLaunchctl(["print", `gui/${uid}/${LAUNCH_AGENT_LABEL}`])
        : runLaunchctl(["list", LAUNCH_AGENT_LABEL]);
      loaded = Boolean(probe?.ok);
    }
    return {
      ok: true,
      enabled: installed,
      loaded,
      label: LAUNCH_AGENT_LABEL,
      plistPath,
      watchPaths,
    };
  }

  function enable() {
    if (process.platform !== "darwin" && typeof launchctl !== "function") {
      return { ok: false, error: "macOS only" };
    }
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    ensurePrivateDir(path.dirname(logPath));
    ensurePrivateLogFile(logPath);
    const watchPaths = getWatchPaths();
    const xml = buildLaunchAgentPlist({
      cliPath,
      scriptPath,
      pluginDir,
      watchPaths,
      logPath,
      envAppPath: envAppPath ? path.resolve(envAppPath) : null,
      systemNodeBin: systemNodeBin ? path.resolve(systemNodeBin) : null,
    });
    fs.writeFileSync(plistPath, xml, { encoding: "utf8", mode: 0o644 });
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    let loadRes;
    if (uid != null) {
      runLaunchctl(["bootout", `gui/${uid}/${LAUNCH_AGENT_LABEL}`]);
      loadRes = runLaunchctl(["bootstrap", `gui/${uid}`, plistPath]);
    } else {
      runLaunchctl(["unload", plistPath]);
      loadRes = runLaunchctl(["load", plistPath]);
    }
    const status = getStatus();
    return {
      ...status,
      ok: Boolean(status.enabled && (status.loaded || loadRes?.ok)),
      enabled: true,
      loadError: loadRes?.ok ? null : (loadRes?.stderr?.trim() || loadRes?.error || null),
    };
  }

  function disable() {
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (uid != null) runLaunchctl(["bootout", `gui/${uid}/${LAUNCH_AGENT_LABEL}`]);
    else runLaunchctl(["unload", plistPath]);
    try { fs.unlinkSync(plistPath); } catch {}
    return { ...getStatus(), ok: true, enabled: false };
  }

  return { getStatus, enable, disable, plistPath, logPath };
}

function sendMacNotification(title, message) {
  if (process.platform !== "darwin") return false;
  try {
    const safeTitle = String(title || "T3 Code HUD").replaceAll('"', '\\"');
    const safeMsg = String(message || "").replaceAll('"', '\\"');
    execFileSync("/usr/bin/osascript", ["-e", `display notification "${safeMsg}" with title "${safeTitle}"`], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function readGuardianState(stateFile) {
  try {
    const raw = readRegularFileNoFollow(stateFile);
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return { bundleKey: "", lastAttemptAt: 0, consecutiveFailures: 0 };
    return {
      bundleKey: typeof data.bundleKey === "string" ? data.bundleKey : "",
      lastAttemptAt: Number.isFinite(data.lastAttemptAt) ? data.lastAttemptAt : 0,
      consecutiveFailures: Number.isInteger(data.consecutiveFailures) && data.consecutiveFailures >= 0 ? data.consecutiveFailures : 0,
    };
  } catch {
    return { bundleKey: "", lastAttemptAt: 0, consecutiveFailures: 0 };
  }
}

function writeGuardianState(stateFile, state) {
  try {
    writeFileAtomicNoFollow(stateFile, JSON.stringify(state) + "\n", { mode: 0o600 });
  } catch {
    // Best-effort state persistence
  }
}

function computeBundleKey(appBundle) {
  const ver = readBundleVersion(appBundle);
  if (!ver) return `${appBundle}|unknown`;
  return `${appBundle}|${ver.shortVersion}|${ver.buildVersion}|${ver.mtimeMs}`;
}

function isBootstrapInProgress(runDir, isPidAlive) {
  const lockFile = path.join(runDir, "bootstrap.lock");
  try {
    const raw = readRegularFileNoFollow(lockFile);
    const lock = JSON.parse(raw);
    const pid = Number(lock?.pid || 0);
    const startedAt = Number(lock?.startedAt || 0);
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    if (!Number.isFinite(startedAt) || startedAt <= 0) return null;
    if (isPidAlive(pid)) {
      return { pid, targetPid: Number(lock?.targetPid || 0) || null, startedAt };
    }
  } catch {}
  return null;
}

function defaultQuitProcess(proc) {
  try {
    execFileSync("/usr/bin/osascript", ["-e", `tell application "${proc.appBundle}" to quit`], { timeout: 5000 });
  } catch {}
}

function defaultSpawnBootstrap({ runtime, bootstrapPath, childEnv, timeoutMs = 30_000 }) {
  return new Promise((resolve) => {
    delete childEnv.NODE_OPTIONS;
    if (runtime.useRunAsNode) childEnv.ELECTRON_RUN_AS_NODE = "1";
    else delete childEnv.ELECTRON_RUN_AS_NODE;
    let settled = false;
    let child;
    const done = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    };
    const timer = setTimeout(() => {
      try { child?.kill("SIGTERM"); } catch {}
      done({ code: 1, signal: "SIGTERM", timedOut: true });
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    try {
      child = spawn(runtime.bin, [bootstrapPath], {
        env: childEnv,
        stdio: "ignore",
      });
      child.once("error", (err) => done({ code: 1, error: err?.message || String(err) }));
      child.once("exit", (code, signal) => done({ code: code ?? 1, signal: signal || null }));
    } catch (err) {
      done({ code: 1, error: err?.message || String(err) });
    }
  });
}

async function evaluateAndHandoff({
  homeDir = os.homedir(),
  pluginDir = process.env.T3_HUD_DIR || path.join(homeDir, ".t3", "hud-plugin"),
  coldBootMaxAgeSec = COLD_BOOT_MAX_AGE_SEC,
  hudColdWaitMs = 2500,
  quitPollIntervalMs = 200,
  quitMaxChecks = 25,
  findProcess = findRunningT3MainProcess,
  isMounted = async (pid) => checkHud({ rpcFile: path.join(pluginDir, "run", `rpc-${pid}.json`), pid }),
  readEnv = readProcessEnv,
  checkActiveWork = (proc, dataHome) => hasActiveT3Work({
    homeDir, dbPath: dataHome && path.join(dataHome.directory, "statev2.sqlite"), targetPid: proc.pid, readEnv,
  }),
  getProcessStart = processStart,
  relaunch = null,
  quitProcess = defaultQuitProcess,
  spawnBootstrap = defaultSpawnBootstrap,
  resolveRuntime = (appBundle) => resolveNodeRuntime({ appBundle, homeDir }),
  notify = sendMacNotification,
  now = () => Date.now(),
  isPidAlive = defaultIsPidAlive,
} = {}) {
  const runDir = path.join(pluginDir, "run");
  const stateFile = path.join(runDir, "guardian-state.json");
  const handoffLockFile = path.join(runDir, "handoff.lock");

  let handoffLock;
  try {
    handoffLock = acquireExclusiveLock(
      handoffLockFile,
      { kind: "handoff" },
      { isPidAlive, now }
    );
  } catch {
    return { ok: false, action: "handoff_lock_error" };
  }
  if (!handoffLock.acquired) {
    return { ok: true, action: "handoff_in_progress", ownerPid: handoffLock.owner?.pid || null };
  }

  try {
    const nowMs = now();
    const activeBootstrap = isBootstrapInProgress(runDir, isPidAlive);
    if (activeBootstrap) {
      return { ok: true, action: "bootstrap_in_progress", pid: activeBootstrap.targetPid, bootstrapPid: activeBootstrap.pid };
    }

    const explicitApp = process.env.T3_APP_PATH;
    const apps = resolveT3AppBundles(homeDir).filter((app) => !explicitApp || app === path.resolve(explicitApp));
    if (!apps.length) return { ok: true, action: "no_app" };

    let proc = null;
    for (const app of apps) {
      proc = findProcess(app);
      if (proc) break;
    }
    if (!proc) return { ok: true, action: "not_running" };

    const procStartBefore = getProcessStart(proc.pid);
    const bundleKey = computeBundleKey(proc.appBundle);
    const state = readGuardianState(stateFile);

    if (await isMounted(proc.pid)) {
      if (state.consecutiveFailures > 0 || fs.existsSync(stateFile)) {
        writeGuardianState(stateFile, { ...state, bundleKey, consecutiveFailures: 0 });
      }
      return { ok: true, action: "already_mounted", pid: proc.pid };
    }

    const coldBoot = proc.elapsedSec != null && proc.elapsedSec <= coldBootMaxAgeSec;
    const hasHudFlag = typeof proc.command === "string" && /(^|\s)--remote-debugging-port=/.test(proc.command);
    if (coldBoot && hasHudFlag) {
      if (hudColdWaitMs > 0) {
        await new Promise((r) => setTimeout(r, hudColdWaitMs));
      }
      if (await isMounted(proc.pid)) {
        if (state.consecutiveFailures > 0 || fs.existsSync(stateFile)) {
          writeGuardianState(stateFile, { ...state, bundleKey, consecutiveFailures: 0 });
        }
        return { ok: true, action: "already_mounted", pid: proc.pid };
      }
      return { ok: true, action: "hud_booting_skipped", pid: proc.pid };
    }

    const busy = checkActiveWork(proc);
    if (!coldBoot || busy) {
      notify(
        "T3 Code 已升级（HUD 待重挂）",
        "检测到活跃会话或运行中任务，已保留现场；任务结束后执行 t3-hud restart 即可重新挂载 HUD。"
      );
      return { ok: true, action: "notified_only", pid: proc.pid, coldBoot, busy };
    }

    const elapsedSinceAttempt = state.lastAttemptAt > 0 ? (nowMs - state.lastAttemptAt) : Infinity;
    const sameBundleInWindow = state.bundleKey === bundleKey && elapsedSinceAttempt < COOLDOWN_FAILURE_WINDOW_MS;
    const inShortCooldown = elapsedSinceAttempt >= 0 && elapsedSinceAttempt < COOLDOWN_MIN_INTERVAL_MS;
    const tooManyFailures = sameBundleInWindow && state.consecutiveFailures >= COOLDOWN_MAX_FAILURES;

    if (inShortCooldown || tooManyFailures) {
      notify(
        "T3 Code HUD 自动重挂已暂停",
        "检测到短时间内多次挂载未就绪，已停止自动重启以保护现场；请稍后手动执行 t3-hud restart。"
      );
      return {
        ok: true,
        action: "cooldown_notified",
        pid: proc.pid,
        bundleKey,
        consecutiveFailures: state.consecutiveFailures,
      };
    }

    const nextFailures = sameBundleInWindow ? (state.consecutiveFailures + 1) : 1;

    const injectedRelaunch = typeof relaunch === "function";
    const bootstrapPath = path.join(pluginDir, "bootstrap.cjs");
    let runtime;
    let targetHome;
    if (!injectedRelaunch) {
      if (!fs.existsSync(bootstrapPath)) return { ok: false, action: "missing_bootstrap" };
      targetHome = resolveProcessDataHome(proc.pid, homeDir, readEnv, proc.binPath);
      if (!targetHome) return { ok: true, action: "process_data_home_unverified", pid: proc.pid };
      runtime = resolveRuntime(proc.appBundle);
      if (!runtime || !runtime.bin) {
        writeGuardianState(stateFile, { bundleKey, lastAttemptAt: nowMs, consecutiveFailures: nextFailures });
        notify(
          "T3 Code HUD 重挂失败",
          "未找到可用的 Node 运行时（需支持 node:sqlite 与 WebSocket），已保留现场。"
        );
        return { ok: false, action: "reattach_failed", reason: "no_capable_node_runtime", pid: proc.pid };
      }
    }
    if (await isMounted(proc.pid)) {
      writeGuardianState(stateFile, { ...state, bundleKey, consecutiveFailures: 0 });
      return { ok: true, action: "already_mounted", pid: proc.pid };
    }

    if (targetHome) {
      const currentHome = resolveProcessDataHome(proc.pid, homeDir, readEnv, proc.binPath);
      if (!currentHome || currentHome.directory !== targetHome.directory || currentHome.override !== targetHome.override) {
        return { ok: true, action: "process_data_home_unverified", pid: proc.pid };
      }
    }
    const stillBusy = checkActiveWork(proc, targetHome);
    if (!procStartBefore || getProcessStart(proc.pid) !== procStartBefore) {
      return { ok: true, action: "process_identity_changed", pid: proc.pid };
    }
    if (stillBusy) {
      notify("T3 Code 已升级（HUD 待重挂）", "检测到活跃会话或运行中任务，已保留现场。");
      return { ok: true, action: "notified_only", pid: proc.pid, coldBoot, busy: true };
    }

    if (injectedRelaunch) {
      writeGuardianState(stateFile, { bundleKey, lastAttemptAt: nowMs, consecutiveFailures: nextFailures });
      await relaunch(proc);
      return { ok: true, action: "reattached", pid: proc.pid };
    }

    quitProcess(proc);
    for (let i = 0; i < quitMaxChecks; i++) {
      if (!isPidAlive(proc.pid)) break;
      if (quitPollIntervalMs > 0) {
        await new Promise((r) => setTimeout(r, quitPollIntervalMs));
      }
    }
    if (isPidAlive(proc.pid)) {
      writeGuardianState(stateFile, { bundleKey, lastAttemptAt: nowMs, consecutiveFailures: nextFailures });
      return { ok: false, action: "old_process_still_alive", pid: proc.pid };
    }

    const childEnv = { ...process.env, T3_APP_PATH: proc.appBundle, T3_HUD_DIR: pluginDir };
    if (targetHome.override === null) delete childEnv.T3CODE_HOME;
    else childEnv.T3CODE_HOME = targetHome.override;
    const bootRes = await spawnBootstrap({
      runtime,
      bootstrapPath,
      appBundle: proc.appBundle,
      pluginDir,
      childEnv,
    });
    if (!bootRes || bootRes.code !== 0) {
      writeGuardianState(stateFile, { bundleKey, lastAttemptAt: nowMs, consecutiveFailures: nextFailures });
      return {
        ok: false,
        action: "reattach_failed",
        reason: "bootstrap_failed",
        code: bootRes?.code ?? 1,
        pid: proc.pid,
      };
    }

    const newProc = findProcess(proc.appBundle);
    const newStart = newProc && newProc.pid !== proc.pid ? getProcessStart(newProc.pid) : null;
    const newMounted = newStart && await isMounted(newProc.pid);
    const newHome = newMounted && resolveProcessDataHome(newProc.pid, homeDir, readEnv, newProc.binPath);
    if (!newHome || newHome.directory !== targetHome.directory || getProcessStart(newProc.pid) !== newStart) {
      writeGuardianState(stateFile, { bundleKey, lastAttemptAt: nowMs, consecutiveFailures: nextFailures });
      return {
        ok: false,
        action: "reattach_failed",
        reason: "mount_not_confirmed",
        pid: proc.pid,
        newPid: newProc?.pid || null,
      };
    }

    writeGuardianState(stateFile, {
      bundleKey,
      lastAttemptAt: nowMs,
      consecutiveFailures: 0,
    });
    return { ok: true, action: "reattached", pid: proc.pid, newPid: newProc.pid };
  } finally {
    handoffLock.release();
  }
}

async function runPollingMode({
  mode,
  prevPid = 0,
  pluginDir = process.env.T3_HUD_DIR || path.join(os.homedir(), ".t3", "hud-plugin"),
  deadlineMs = mode === "upgrade-handoff" ? 90_000 : 30_000,
  pollIntervalMs = mode === "upgrade-handoff" ? 1200 : 1000,
  evaluate = (opts) => evaluateAndHandoff(opts),
  isPidAlive = defaultIsPidAlive,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const deadline = now() + deadlineMs;
  let lastRes = { ok: true, action: "not_running" };

  while (now() < deadline) {
    let oldAlive = false;
    if (mode === "upgrade-handoff" && prevPid > 0) {
      oldAlive = isPidAlive(prevPid);
    }
    if (!oldAlive) {
      lastRes = await evaluate({ pluginDir });
      if (lastRes.action !== "not_running" && lastRes.action !== "no_app") {
        return lastRes;
      }
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollIntervalMs, remaining));
  }
  return lastRes;
}

async function runCli(argv = process.argv.slice(2)) {
  const modeArg = argv.find((a) => a.startsWith("--mode="))?.slice(7) || "status";
  const prevPid = Number(argv.find((a) => a.startsWith("--prev-pid="))?.slice(11) || 0);
  const pluginDir = process.env.T3_HUD_DIR || path.join(os.homedir(), ".t3", "hud-plugin");
  const mgr = createGuardianManager({ pluginDir });

  if (modeArg === "enable") {
    const res = mgr.enable();
    console.log(JSON.stringify(res));
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (modeArg === "disable") { console.log(JSON.stringify(mgr.disable())); return; }
  if (modeArg === "status") { console.log(JSON.stringify(mgr.getStatus())); return; }

  if (modeArg === "upgrade-handoff" || modeArg === "plist-changed") {
    const res = await runPollingMode({ mode: modeArg, prevPid, pluginDir });
    console.log(JSON.stringify(res));
  }
}

if (require.main === module) {
  runCli().catch((err) => {
    console.error("[t3-hud-guardian]", err?.message || err);
    process.exit(1);
  });
}

module.exports = {
  LAUNCH_AGENT_LABEL,
  COLD_BOOT_MAX_AGE_SEC,
  parseEtimeSeconds,
  readBundleVersion,
  isElectronRunAsNodeEnabled,
  checkNodeCapabilities,
  resolveNodeRuntime,
  resolveT3AppBundles,
  findRunningT3MainProcess,
  hasActiveT3Work,
  buildLaunchAgentPlist,
  createGuardianManager,
  evaluateAndHandoff,
  runPollingMode,
};
