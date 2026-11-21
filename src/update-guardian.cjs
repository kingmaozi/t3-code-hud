"use strict";

/**
 * T3 Code Upgrade Anti-Drop Guardian
 *
 * Prevents HUD from silently disappearing after T3 Code auto-updates (Squirrel/ShipIt),
 * without modifying app.asar, without breaking signatures, and NEVER interrupting live tasks.
 *
 * Safety contract:
 *   1. If T3 is already mounted with HUD -> no-op.
 *   2. If T3 is unmounted AND freshly booted (<= COLD_BOOT_MAX_AGE_SEC) AND has 0 active runs
 *      -> gracefully hand off to bootstrap.cjs so HUD re-mounts automatically.
 *   3. If T3 is already running (> COLD_BOOT_MAX_AGE_SEC) OR has active runs (or DB unreadable)
 *      -> NEVER kill or restart T3; send a non-intrusive macOS notification instead.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn, spawnSync } = require("node:child_process");
const { checkHud } = require("./hud-health.cjs");

const LAUNCH_AGENT_LABEL = "com.t3hud.guardian";
const COLD_BOOT_MAX_AGE_SEC = 18;
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
    return { pid, elapsedSec: etimeSec, binPath, appBundle };
  }
  return null;
}

function hasActiveT3Work({ homeDir = os.homedir(), dbPath } = {}) {
  const targetDb = dbPath || path.join(homeDir, ".t3", "userdata", "statev2.sqlite");
  if (!fs.existsSync(targetDb)) return false;
  let db = null;
  try {
    const { DatabaseSync } = require("node:sqlite");
    db = new DatabaseSync(targetDb, { open: true, readOnly: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    if (tables.includes("orchestration_v2_projection_runs")) {
      const row = db.prepare("SELECT COUNT(*) AS cnt FROM orchestration_v2_projection_runs WHERE status IN ('running','starting','queued','preparing')").get();
      if (Number(row?.cnt || 0) > 0) return true;
    }
    if (tables.includes("orchestration_v2_projection_sessions")) {
      const row = db.prepare("SELECT COUNT(*) AS cnt FROM orchestration_v2_projection_sessions WHERE status IN ('running','starting','busy')").get();
      if (Number(row?.cnt || 0) > 0) return true;
    }
    return false;
  } catch {
    // Fail safe: if SQLite cannot be read, assume work might be active so we never interrupt.
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

function buildLaunchAgentPlist({ nodeBin, scriptPath, pluginDir, watchPaths, logPath }) {
  const watchItems = (watchPaths || []).map((p) => `    <string>${escapeXml(p)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodeBin)}</string>
    <string>${escapeXml(scriptPath)}</string>
    <string>--mode=plist-changed</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ELECTRON_RUN_AS_NODE</key>
    <string>1</string>
    <key>T3_HUD_DIR</key>
    <string>${escapeXml(pluginDir)}</string>
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

function createGuardianManager({ homeDir = os.homedir(), pluginDir = path.join(os.homedir(), ".t3", "hud-plugin"), launchctl = null } = {}) {
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
    const apps = resolveT3AppBundles(homeDir);
    const list = apps.length ? apps : ["/Applications/T3 Code.app", "/Applications/T3 Code (Beta).app"];
    return list.map((app) => path.join(app, "Contents", "Info.plist"));
  }

  function resolveNodeRuntime() {
    const apps = resolveT3AppBundles(homeDir);
    for (const app of apps) {
      const macosDir = path.join(app, "Contents", "MacOS");
      try {
        const bins = fs.readdirSync(macosDir).filter((n) => !n.startsWith("."));
        const mainBin = bins.find((n) => /t3\s*code/i.test(n)) || bins[0];
        if (mainBin) return path.join(macosDir, mainBin);
      } catch {}
    }
    return process.execPath;
  }

  function getStatus() {
    const installed = fs.existsSync(plistPath);
    const watchPaths = getWatchPaths();
    let loaded = false;
    if (installed && process.platform === "darwin") {
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
    fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
    const watchPaths = getWatchPaths();
    const xml = buildLaunchAgentPlist({
      nodeBin: resolveNodeRuntime(),
      scriptPath,
      pluginDir,
      watchPaths,
      logPath,
    });
    fs.writeFileSync(plistPath, xml, { encoding: "utf8", mode: 0o644 });
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (uid != null) {
      runLaunchctl(["bootout", `gui/${uid}/${LAUNCH_AGENT_LABEL}`]);
      runLaunchctl(["bootstrap", `gui/${uid}`, plistPath]);
    } else {
      runLaunchctl(["unload", plistPath]);
      runLaunchctl(["load", plistPath]);
    }
    return { ...getStatus(), ok: true, enabled: true };
  }

  function disable() {
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (uid != null) runLaunchctl(["bootout", `gui/${uid}/${LAUNCH_AGENT_LABEL}`]);
    else runLaunchctl(["unload", plistPath]);
    try { fs.unlinkSync(plistPath); } catch {}
    return { ...getStatus(), ok: true, enabled: false };
  }

  return { getStatus, enable, disable, plistPath };
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

async function evaluateAndHandoff({
  homeDir = os.homedir(),
  pluginDir = process.env.T3_HUD_DIR || path.join(os.homedir(), ".t3", "hud-plugin"),
  coldBootMaxAgeSec = COLD_BOOT_MAX_AGE_SEC,
  findProcess = findRunningT3MainProcess,
  isMounted = async (pid) => checkHud({ rpcFile: path.join(pluginDir, "run", `rpc-${pid}.json`), pid }),
  checkActiveWork = () => hasActiveT3Work({ homeDir }),
  relaunch = null,
  notify = sendMacNotification,
} = {}) {
  const apps = resolveT3AppBundles(homeDir);
  if (!apps.length) return { ok: true, action: "no_app" };

  let proc = null;
  for (const app of apps) {
    proc = findProcess(app);
    if (proc) break;
  }
  if (!proc) return { ok: true, action: "not_running" };

  if (await isMounted(proc.pid)) {
    return { ok: true, action: "already_mounted", pid: proc.pid };
  }

  const coldBoot = proc.elapsedSec != null && proc.elapsedSec <= coldBootMaxAgeSec;
  const busy = checkActiveWork();
  if (!coldBoot || busy) {
    notify(
      "T3 Code 已升级（HUD 待重挂）",
      "检测到活跃会话或运行中任务，已保留现场；任务结束后执行 t3-hud restart 即可重新挂载 HUD。"
    );
    return { ok: true, action: "notified_only", pid: proc.pid, coldBoot, busy };
  }

  if (typeof relaunch === "function") {
    await relaunch(proc);
    return { ok: true, action: "reattached", pid: proc.pid };
  }

  // Graceful handoff for freshly booted, idle upgraded T3
  try {
    execFileSync("/usr/bin/osascript", ["-e", `tell application "${proc.appBundle}" to quit`], { timeout: 5000 });
  } catch {}
  for (let i = 0; i < 25; i++) {
    let alive = false;
    try { process.kill(proc.pid, 0); alive = true; } catch {}
    if (!alive) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const bootstrapPath = path.join(pluginDir, "bootstrap.cjs");
  if (fs.existsSync(bootstrapPath)) {
    const child = spawn(proc.binPath, [bootstrapPath], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", T3_APP_PATH: proc.appBundle },
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return { ok: true, action: "reattached", pid: proc.pid };
  }
  return { ok: false, action: "missing_bootstrap" };
}

async function runCli(argv = process.argv.slice(2)) {
  const modeArg = argv.find((a) => a.startsWith("--mode="))?.slice(7) || "status";
  const prevPid = Number(argv.find((a) => a.startsWith("--prev-pid="))?.slice(11) || 0);
  const pluginDir = process.env.T3_HUD_DIR || path.join(os.homedir(), ".t3", "hud-plugin");
  const mgr = createGuardianManager({ pluginDir });

  if (modeArg === "enable") { console.log(JSON.stringify(mgr.enable())); return; }
  if (modeArg === "disable") { console.log(JSON.stringify(mgr.disable())); return; }
  if (modeArg === "status") { console.log(JSON.stringify(mgr.getStatus())); return; }

  if (modeArg === "upgrade-handoff") {
    const deadline = Date.now() + 90_000;
    // Wait for old PID to exit, then wait for upgraded T3 to spawn
    while (Date.now() < deadline) {
      let oldAlive = false;
      if (prevPid > 0) {
        try { process.kill(prevPid, 0); oldAlive = true; } catch {}
      }
      if (!oldAlive) {
        const res = await evaluateAndHandoff({ pluginDir });
        if (res.action !== "not_running") {
          console.log(JSON.stringify(res));
          return;
        }
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
    return;
  }

  if (modeArg === "plist-changed") {
    // Allow ShipIt a brief moment to relaunch T3 after updating Info.plist
    await new Promise((r) => setTimeout(r, 2500));
    const res = await evaluateAndHandoff({ pluginDir });
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
  resolveT3AppBundles,
  hasActiveT3Work,
  buildLaunchAgentPlist,
  createGuardianManager,
  evaluateAndHandoff,
};
