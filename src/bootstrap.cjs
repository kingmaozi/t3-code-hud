"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { checkHud } = require("./hud-health.cjs");
const { acquireExclusiveLock } = require("./hud-runtime.cjs");
const {
  buildTelemetryLaunch,
  createTelemetryGuard,
  optOutFlags,
  observeProcessTelemetry,
  processStart,
  recordTelemetryLaunch,
} = require("./hub-telemetry-guard.cjs");

const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const MAX_STDERR_BUF = 16 * 1024;
const MAX_LOG_BYTES = 64 * 1024;
const KEEP_LOG_BYTES = 32 * 1024;
const CDP_LINE_RE = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:\s|$)/;
const INSPECT_LINE_RE = /(ws:\/\/127\.0\.0\.1:\d+\/[0-9a-fA-F-]{6,})(?:\s|$)/;

function resolveT3Bundle() {
  const candidates = [
    process.env.T3_APP_PATH,
    "/Applications/T3 Code (Beta).app",
    "/Applications/T3 Code.app",
    "/Applications/T3 Code (Nightly).app",
    path.join(os.homedir(), "Applications", "T3 Code (Beta).app"),
    path.join(os.homedir(), "Applications", "T3 Code.app"),
    path.join(os.homedir(), "Applications", "T3 Code (Nightly).app"),
  ].filter(Boolean);

  for (const appBundle of candidates) {
    const macosDir = path.join(appBundle, "Contents", "MacOS");
    const appAsar = path.join(appBundle, "Contents", "Resources", "app.asar");
    const asarPkg = path.join(appAsar, "package.json");
    if (!fs.existsSync(macosDir) || !fs.existsSync(appAsar)) continue;
    try {
      const bins = fs.readdirSync(macosDir).filter((n) => !n.startsWith("."));
      const mainBin = bins.find((n) => /t3\s*code/i.test(n)) || bins[0];
      if (mainBin) {
        return {
          appBundle,
          binPath: path.join(macosDir, mainBin),
          appAsar,
          asarPkg,
        };
      }
    } catch {}
  }
  return null;
}

const resolved = resolveT3Bundle();
if (!resolved) {
  console.error(
    "[t3-hud] Could not locate T3 Code.app or T3 Code (Beta).app. Set T3_APP_PATH=/path/to/T3\\ Code.app"
  );
  process.exit(1);
}

const HOOK_PATH = path.join(__dirname, "main-hook.cjs");
const CDP_HOST_PATH = path.join(__dirname, "hud-cdp-host.cjs");
const PLUGIN_DIR = process.env.T3_HUD_DIR || path.join(os.homedir(), ".t3", "hud-plugin");
const TELEMETRY_PLUGIN_DIR = process.env.T3_HUD_DIR || __dirname;
const RUN_DIR = path.join(PLUGIN_DIR, "run");
const MARKER_FILE = path.join(RUN_DIR, "active.pid");
const LOCK_FILE = path.join(RUN_DIR, "bootstrap.lock");
const LOG_FILE = path.join(RUN_DIR, "bootstrap.log");

const transport = String(process.env.T3_HUD_TRANSPORT || "cdp").trim().toLowerCase() === "inspect" ? "inspect" : "cdp";
const bootStartedAt = Date.now();

function resolveBootTimeoutMs() {
  const raw = process.env.T3_HUD_BOOT_TIMEOUT_MS;
  if (raw == null || raw === "") return 20000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1000 || parsed > 120000) return 20000;
  return Math.round(parsed);
}
const BOOT_TIMEOUT_MS = resolveBootTimeoutMs();

function isPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function ensureRunDirSafe() {
  let st = null;
  try { st = fs.lstatSync(RUN_DIR); } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
  if (st && (st.isSymbolicLink() || !st.isDirectory())) {
    throw new Error("HUD run directory is a symlink or non-directory");
  }
  fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(RUN_DIR).isSymbolicLink()) {
    throw new Error("HUD run directory is a symlink");
  }
  try { fs.chmodSync(RUN_DIR, 0o700); } catch {}
}

function readRegularNoFollow(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | O_NOFOLLOW);
    if (!fs.fstatSync(fd).isFile()) return null;
    return fs.readFileSync(fd, "utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function writePrivateAtomic(filePath, content) {
  ensureRunDirSafe();
  let existing = null;
  try { existing = fs.lstatSync(filePath); } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
    throw new Error(`Refusing unsafe target file: ${filePath}`);
  }
  const temp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temp, content, { flag: "wx", mode: 0o600 });
    try { fs.chmodSync(temp, 0o600); } catch {}
    fs.renameSync(temp, filePath);
  } finally {
    try { fs.unlinkSync(temp); } catch {}
  }
}

function sanitizeDiagnostic(text) {
  return String(text || "")
    .replace(/\r?\n/g, " ")
    .replace(/wss?:\/\/\S+/gi, "[ws-redacted]")
    .replace(/https?:\/\/\S+/gi, "[url-redacted]")
    .replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, "[uuid-redacted]")
    .replace(/[0-9a-fA-F]{32,}/g, "[hex-redacted]")
    .slice(0, 300);
}

function appendBootstrapFailureLog(reason, targetPid) {
  try {
    ensureRunDirSafe();
    let existing = "";
    try {
      const st = fs.lstatSync(LOG_FILE);
      if (st.isSymbolicLink() || !st.isFile()) return;
      const content = readRegularNoFollow(LOG_FILE) || "";
      if (Buffer.byteLength(content, "utf8") > MAX_LOG_BYTES) {
        const buf = Buffer.from(content, "utf8");
        existing = buf.subarray(Math.max(0, buf.length - KEEP_LOG_BYTES)).toString("utf8");
        const nl = existing.indexOf("\n");
        if (nl >= 0) existing = existing.slice(nl + 1);
      } else {
        existing = content;
      }
    } catch {}
    const line = `${new Date().toISOString()} [bootstrap] fail reason=${sanitizeDiagnostic(reason)} transport=${transport} pid=${targetPid || 0} elapsedMs=${Date.now() - bootStartedAt}\n`;
    writePrivateAtomic(LOG_FILE, existing + line);
  } catch {}
}


function resolveHostNodeRuntime() {
  try {
    const guardian = require("./update-guardian.cjs");
    if (guardian && typeof guardian.resolveNodeRuntime === "function") {
      return guardian.resolveNodeRuntime({ appBundle: resolved.appBundle });
    }
  } catch {}
  try {
    const runtime = require("./hud-runtime.cjs");
    if (runtime && typeof runtime.resolveNodeRuntime === "function") {
      return runtime.resolveNodeRuntime({ appBundle: resolved.appBundle });
    }
  } catch {}
  return { bin: process.execPath, useRunAsNode: Boolean(process.versions?.electron) };
}

// Acquire exclusive bootstrap.lock BEFORE spawning T3 so concurrent bootstraps never collide.
let bootstrapLock = null;
try {
  bootstrapLock = acquireExclusiveLock(LOCK_FILE, { targetPid: 0, startedAt: bootStartedAt }, { isPidAlive });
} catch (err) {
  console.error("[t3-hud] Could not acquire bootstrap lock:", err.message);
  appendBootstrapFailureLog(`bootstrap_lock_error:${err.message}`, 0);
  process.exit(1);
}
if (!bootstrapLock || !bootstrapLock.acquired) {
  console.error("[t3-hud] Another HUD bootstrap is already in progress");
  appendBootstrapFailureLog(`bootstrap_lock_${bootstrapLock?.reason || "held"}`, 0);
  process.exit(1);
}

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
delete childEnv.NODE_OPTIONS;
const basePath = childEnv.PATH || "";
childEnv.PATH = [...new Set([
  path.join(os.homedir(), ".local", "bin"), path.join(os.homedir(), ".t3", "bin"),
  "/opt/homebrew/bin", "/usr/local/bin", ...basePath.split(path.delimiter),
  "/usr/bin", "/bin", "/usr/sbin", "/sbin",
].filter(Boolean))].join(path.delimiter);

const extraArgs = process.argv.slice(2);
try { createTelemetryGuard({ pluginDir: TELEMETRY_PLUGIN_DIR }).reconcileProfile(); }
catch { console.error("[t3-hud] Could not sync the product telemetry setting to the shell profile"); }
const telemetryLaunch = buildTelemetryLaunch(childEnv, TELEMETRY_PLUGIN_DIR);

const launchFlag = transport === "inspect" ? "--inspect=127.0.0.1:0" : "--remote-debugging-port=0";
const child = spawn(resolved.binPath, [launchFlag, ...extraArgs], {
  env: telemetryLaunch.env,
  detached: true,
  stdio: ["ignore", "ignore", "pipe"],
});
try { bootstrapLock.update({ targetPid: child.pid }); } catch {}
const childStarted = processStart(child.pid);

// A failed secondary launch must not mutate the active instance's marker.
// Publish atomically, only after both evaluate/attach and authenticated RPC succeed.
function writeMarker() {
  ensureRunDirSafe();
  let previous;
  try { previous = Number((readRegularNoFollow(MARKER_FILE) || "").trim()); } catch {}
  if (previous > 0 && previous !== child.pid) {
    if (isPidAlive(previous)) throw new Error("HUD marker belongs to another live process");
  }
  writePrivateAtomic(MARKER_FILE, String(child.pid));
}

let injected = false;
let finished = false;
let verifying = false;
let retryTimer;
let inspectorSocket;
let hostChildRef = null;
let stderrBuf = "";
let observedTelemetry = null;

const finish = (code = 0, failureReason = null) => {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  clearTimeout(retryTimer);
  try { inspectorSocket?.close(); } catch {}
  try {
    child.stderr.removeAllListeners();
    child.stderr.destroy();
  } catch {}
  try { child.unref(); } catch {}
  if (hostChildRef) {
    try { hostChildRef.removeAllListeners("exit"); } catch {}
    try { hostChildRef.removeAllListeners("error"); } catch {}
    try { hostChildRef.stdin?.removeAllListeners?.("error"); } catch {}
    try { hostChildRef.unref(); } catch {}
  }
  if (code !== 0 && failureReason) {
    appendBootstrapFailureLog(failureReason, child.pid);
  }
  bootstrapLock.release();
  process.exit(code);
};

const timer = setTimeout(() => {
  console.error("[t3-hud] Timed out waiting for confirmed HUD readiness");
  finish(1, "timeout_waiting_for_hud_readiness");
}, BOOT_TIMEOUT_MS);

child.on("error", (err) => {
  console.error("[t3-hud] Failed to launch T3 Code:", err.message);
  finish(1, `launch_error:${err.message}`);
});
child.on("exit", (code, signal) => finish(1, `target_exited:${code ?? ""}:${signal ?? ""}`));

async function confirmReady() {
  if (finished) return;
  const ready = await checkHud({ rpcFile: path.join(RUN_DIR, `rpc-${child.pid}.json`), pid: child.pid });
  if (finished) return;
  if (!ready) {
    retryTimer = setTimeout(confirmReady, 100);
    return;
  }
  try {
    writeMarker();
  } catch (err) {
    console.error("[t3-hud] Could not record HUD readiness:", err.message);
    finish(1, `marker_write_failed:${err.message}`);
    return;
  }
  if (!observedTelemetry && transport === "cdp" && typeof observeProcessTelemetry === "function") {
    try { observedTelemetry = observeProcessTelemetry(child.pid, { expectedExecPath: resolved.binPath }); } catch {}
  }
  try {
    recordTelemetryLaunch(RUN_DIR, child.pid, childStarted, telemetryLaunch, observedTelemetry);
  } catch (err) {
    console.error("[t3-hud] Could not record telemetry launch evidence:", err.message);
  }
  finish(0);
}

function launchCdpHost(cdpUrl) {
  if (typeof observeProcessTelemetry === "function") {
    try { observedTelemetry = observeProcessTelemetry(child.pid, { expectedExecPath: resolved.binPath }); } catch {}
  }
  const runtime = resolveHostNodeRuntime();
  if (!runtime || !runtime.bin) {
    console.error("[t3-hud] No capable Node runtime available for CDP host (requires node:sqlite and WebSocket)");
    finish(1, "no_capable_node_runtime");
    return;
  }
  const hostEnv = {
    ...process.env,
    T3_HUD_DIR: PLUGIN_DIR,
    T3_WATCH_PID: String(child.pid),
  };
  delete hostEnv.NODE_OPTIONS;
  if (runtime.useRunAsNode) hostEnv.ELECTRON_RUN_AS_NODE = "1";
  else delete hostEnv.ELECTRON_RUN_AS_NODE;

  let hostChild;
  try {
    hostChild = spawn(runtime.bin, [CDP_HOST_PATH], {
      env: hostEnv,
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
    });
  } catch (err) {
    console.error("[t3-hud] Failed to spawn CDP host:", err.message);
    finish(1, `cdp_host_spawn_error:${err.message}`);
    return;
  }
  hostChildRef = hostChild;

  hostChild.on("error", (err) => {
    if (!finished) {
      console.error("[t3-hud] CDP host error:", err.message);
      finish(1, `cdp_host_error:${err.message}`);
    }
  });

  hostChild.on("exit", (code, signal) => {
    if (!finished) {
      console.error("[t3-hud] CDP host exited before HUD became ready");
      finish(1, `cdp_host_early_exit:${code ?? ""}:${signal ?? ""}`);
    }
  });

  if (hostChild.stdin && typeof hostChild.stdin.on === "function") {
    hostChild.stdin.on("error", (err) => {
      if (!finished) {
        console.error("[t3-hud] CDP host stdin error:", err.message);
        finish(1, `cdp_host_stdin_error:${err.message}`);
      }
    });
  }

  try {
    const payload = JSON.stringify({
      pid: child.pid,
      cdpUrl,
      appBundle: resolved.appBundle,
      pluginDir: PLUGIN_DIR,
      runDir: RUN_DIR,
    });
    hostChild.stdin.end(payload + "\n");
  } catch (err) {
    console.error("[t3-hud] Failed to pass config to CDP host:", err.message);
    finish(1, `cdp_host_stdin_error:${err.message}`);
    return;
  }

  verifying = true;
  void confirmReady();
}

function launchLegacyInspect(wsUrl) {
  const expr = `(() => {
    try {
      const mod = process.getBuiltinModule("node:module");
      const req = mod.createRequire(${JSON.stringify(resolved.asarPkg)});
      req(${JSON.stringify(HOOK_PATH)});
      const ins = process.getBuiltinModule("node:inspector");
      setTimeout(() => { try { ins.close(); } catch {} }, 80);
      return { ready: true, telemetry: { pid: process.pid, ...(${optOutFlags.toString()})(process.env) } };
    } catch (e) {
      return "ERR:" + (e && e.stack ? e.stack : e);
    }
  })()`;

  const ws = inspectorSocket = new WebSocket(wsUrl);
  ws.onopen = () => {
    ws.send(
      JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: {
          expression: expr,
          returnByValue: true,
        },
      })
    );
  };
  ws.onmessage = (event) => {
    if (finished || verifying) return;
    try {
      let msg = null;
      try {
        msg = JSON.parse(event.data);
      } catch {
        console.error("[t3-hud] WebSocket message is not JSON");
        finish(1, "inspect_non_json");
        return;
      }
      if (msg && msg.id === 1) {
        const val = msg.result?.result?.value;
        const hasException = Boolean(msg.result?.exceptionDetails);
        if (!msg.error && !hasException && val?.ready === true) {
          observedTelemetry = val.telemetry;
          verifying = true;
          try {
            ws.close();
          } catch {}
          void confirmReady();
        } else {
          const detail = msg.error?.message || JSON.stringify(msg.result?.exceptionDetails || msg.result?.result || msg);
          console.error("[t3-hud] HUD injection failed:", detail);
          try {
            ws.close();
          } catch {}
          finish(1, "inspect_eval_failed");
        }
      }
    } catch (err) {
      console.error("[t3-hud] WebSocket handling failed:", err.message);
      finish(1, `inspect_ws_failed:${err.message}`);
    }
  };
  ws.onerror = () => { if (!verifying) finish(1, "inspect_ws_error"); };
}

function consumeStderrLine(line) {
  if (finished || injected) return;
  const trimmed = line.replace(/\r$/, "");
  if (transport === "inspect") {
    const match = trimmed.match(INSPECT_LINE_RE);
    if (!match) return;
    injected = true;
    launchLegacyInspect(match[1]);
    return;
  }
  const match = trimmed.match(CDP_LINE_RE);
  if (!match) return;
  injected = true;
  launchCdpHost(match[1]);
}

child.stderr.on("data", (chunk) => {
  if (finished || injected) return;
  stderrBuf += chunk.toString("utf8");
  let nlIdx = stderrBuf.indexOf("\n");
  while (nlIdx >= 0) {
    const line = stderrBuf.slice(0, nlIdx);
    stderrBuf = stderrBuf.slice(nlIdx + 1);
    consumeStderrLine(line);
    if (finished || injected) {
      stderrBuf = "";
      return;
    }
    nlIdx = stderrBuf.indexOf("\n");
  }
  if (stderrBuf.length > MAX_STDERR_BUF) {
    stderrBuf = stderrBuf.slice(stderrBuf.length - MAX_STDERR_BUF);
  }
});
