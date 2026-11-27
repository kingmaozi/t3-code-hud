"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const {
  acquireExclusiveLock,
  isPidAlive,
  readRegularFileNoFollow,
  unlinkIfRegular,
  writeFileAtomicNoFollow,
} = require("./hud-runtime.cjs");

// GUI launches do not inherit the user's shell PATH. Set this before loading
// backend modules so every subprocess sees the same executable search.
process.env.PATH = [...new Set([
  path.join(os.homedir(), ".local", "bin"), path.join(os.homedir(), ".t3", "bin"),
  "/opt/homebrew/bin", "/usr/local/bin",
  ...(process.env.PATH || "").split(path.delimiter),
  "/usr/bin", "/bin", "/usr/sbin", "/sbin",
].filter(Boolean))].join(path.delimiter);

const watchPid = Number(process.env.T3_WATCH_PID || 0);
const pluginDir = process.env.T3_HUD_DIR || path.join(os.homedir(), ".t3", "hud-plugin");
const runDir = path.join(pluginDir, "run");
const sharedBridgeFile = path.join(runDir, "hub-bridge.json");
const instanceBridgeFile = watchPid > 0 ? path.join(runDir, `hub-bridge-${watchPid}.json`) : sharedBridgeFile;
const token = crypto.randomBytes(32).toString("hex");
const bridgeLockFile = path.join(runDir, "hub-bridge.lock");
const waitWord = new Int32Array(new SharedArrayBuffer(4));
let backend = null;
let shuttingDown = false;
let watchTimer = null;
const disposedBackends = new WeakSet();

function readJsonNoFollow(filePath) {
  try { return JSON.parse(readRegularFileNoFollow(filePath)); }
  catch { return null; }
}

function withBridgeLock(action) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const lock = acquireExclusiveLock(bridgeLockFile);
    if (lock.acquired) {
      try { return action(); }
      finally { lock.release(); }
    }
    if (lock.reason === "invalid_lock") break;
    Atomics.wait(waitWord, 0, 0, 10);
  }
  throw new Error("Bridge record lock unavailable");
}

function unlinkIfOwned(filePath) {
  const record = readJsonNoFollow(filePath);
  if (record?.pid === process.pid && record.token === token) unlinkIfRegular(filePath);
}

function stopBackendScheduler(target = backend) {
  if (!target || (typeof target !== "object" && typeof target !== "function") || disposedBackends.has(target)) return;
  disposedBackends.add(target);
  try { if (typeof target.stopDreamScheduler === "function") target.stopDreamScheduler(); } catch {}
}

function loadBackend() {
  stopBackendScheduler();
  let cacheRoot = path.resolve(pluginDir);
  try { cacheRoot = fs.realpathSync(pluginDir); } catch {}
  let backendPath = path.resolve(pluginDir, "backend.cjs");
  try { backendPath = fs.realpathSync(backendPath); } catch {}
  for (const k of Object.keys(require.cache)) {
    if (k === backendPath || k.startsWith(cacheRoot + path.sep)) delete require.cache[k];
  }
  const next = require(backendPath);
  backend = next;
  return next;
}
backend = loadBackend();

const EXACT_T3_ORIGINS = new Set(["t3code://app", "t3code-dev://app"]);
const LOOPBACK_ORIGIN_RE = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

function normalizeDesktopOrigin(value) {
  return typeof value === "string" && EXACT_T3_ORIGINS.has(value) ? value : null;
}

function normalizeLoopbackOrigin(value) {
  if (typeof value !== "string" || !LOOPBACK_ORIGIN_RE.test(value)) return null;
  try {
    const u = new URL(value);
    if (u.username || u.password) return null;
    if ((u.protocol === "http:" || u.protocol === "https:") &&
        (u.hostname === "127.0.0.1" || u.hostname === "localhost")) {
      return u.origin;
    }
  } catch {}
  return null;
}

let desktopOrigin = normalizeDesktopOrigin(process.env.T3_DESKTOP_ORIGIN);
let allowedLoopbackOrigin = normalizeLoopbackOrigin(process.env.T3_ALLOWED_LOOPBACK_ORIGIN);

function strippedDesktopOrigin() {
  if (desktopOrigin) return desktopOrigin;
  if (allowedLoopbackOrigin) return null;
  return "t3code://app";
}

function allowedOrigin(origin) {
  if (!origin || origin === "null") return null;
  if (EXACT_T3_ORIGINS.has(origin)) return origin;
  if (allowedLoopbackOrigin && origin === allowedLoopbackOrigin) return origin;
  return null;
}

const server = http.createServer((req, res) => {
  const reqOrigin = req.headers.origin || "";
  const cors = reqOrigin ? allowedOrigin(reqOrigin) : strippedDesktopOrigin();
  if (cors) {
    res.setHeader("Access-Control-Allow-Origin", cors);
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-T3-Hud-Token");
    res.setHeader("Access-Control-Allow-Private-Network", "true");
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.headers["x-t3-hud-token"] !== token) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Forbidden" }));
    return;
  }
  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 2e6) req.destroy(); });
  req.on("end", async () => {
    try {
      if (req.method === "POST" && req.url === "/reload") {
        const parsed = body.trim() ? JSON.parse(body) : {};
        let originChanged = false;
        if (parsed && typeof parsed === "object") {
          if (Object.prototype.hasOwnProperty.call(parsed, "desktopOrigin")) {
            const nextDesktop = normalizeDesktopOrigin(parsed.desktopOrigin);
            if (nextDesktop !== desktopOrigin) {
              desktopOrigin = nextDesktop;
              originChanged = true;
            }
          }
          if (Object.prototype.hasOwnProperty.call(parsed, "loopbackOrigin")) {
            const nextLoopback = normalizeLoopbackOrigin(parsed.loopbackOrigin);
            if (nextLoopback !== allowedLoopbackOrigin) {
              allowedLoopbackOrigin = nextLoopback;
              originChanged = true;
            }
          }
        }
        if (parsed?.originOnly !== true) {
          backend = loadBackend();
        }
        if (originChanged) {
          publishBridgeRecords();
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          desktopOrigin: strippedDesktopOrigin(),
          loopbackOrigin: allowedLoopbackOrigin,
        }));
        return;
      }
      if (req.method === "POST" && req.url === "/hub-rpc") {
        const { action, payload } = JSON.parse(body || "{}");
        const out = await backend.hubCall(action, payload || {});
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(out));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Not found" }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err?.message || String(err) }));
    }
  });
});

function cleanupFiles() {
  try {
    withBridgeLock(() => {
      if (instanceBridgeFile !== sharedBridgeFile) unlinkIfOwned(instanceBridgeFile);
      unlinkIfOwned(sharedBridgeFile);
    });
  } catch {}
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (watchTimer) {
    clearInterval(watchTimer);
    watchTimer = null;
  }
  stopBackendScheduler();
  cleanupFiles();
  try {
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    server.close(() => {
      process.exitCode = exitCode;
    });
  } catch {
    process.exitCode = exitCode;
  }
}

server.once("close", () => {
  stopBackendScheduler();
});
process.once("beforeExit", () => {
  stopBackendScheduler();
  cleanupFiles();
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => shutdown(0));
}

function canUpdateSharedBridge() {
  const existing = readJsonNoFollow(sharedBridgeFile);
  if (!existing || !isPidAlive(existing.pid)) return true;
  if (watchPid > 0 && existing.watchPid === watchPid) return true;
  return existing.watchPid > 0 && !isPidAlive(existing.watchPid);
}

function publishBridgeRecords() {
  const addr = server.address();
  if (!addr || typeof addr !== "object") return false;
  const payload = JSON.stringify({
    url: "http://127.0.0.1:" + addr.port,
    token,
    pid: process.pid,
    watchPid,
    desktopOrigin: strippedDesktopOrigin(),
    loopbackOrigin: allowedLoopbackOrigin,
  });
  return withBridgeLock(() => {
    if (instanceBridgeFile !== sharedBridgeFile) writeFileAtomicNoFollow(instanceBridgeFile, payload);
    const canPublishShared = canUpdateSharedBridge();
    if (canPublishShared) writeFileAtomicNoFollow(sharedBridgeFile, payload);
    return canPublishShared || instanceBridgeFile !== sharedBridgeFile;
  });
}

server.listen(0, "127.0.0.1", () => {
  try {
    const published = publishBridgeRecords();
    if (!published) shutdown(1);
  } catch (err) {
    console.error("[t3-hub-bridge] failed to write bridge record:", err?.message || err);
    shutdown(1);
  }
});

if (watchPid > 0) {
  const rawWatchMs = Number(process.env.T3_BRIDGE_WATCH_MS || 0);
  const watchMs = Number.isFinite(rawWatchMs) && rawWatchMs >= 50 && rawWatchMs <= 60000 ? rawWatchMs : 10000;
  watchTimer = setInterval(() => {
    if (!isPidAlive(watchPid)) {
      shutdown(0);
    }
  }, watchMs);
  watchTimer.unref();
}
