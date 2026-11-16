"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const watchPid = Number(process.env.T3_WATCH_PID || 0);
const pluginDir = process.env.T3_HUD_DIR || path.join(os.homedir(), ".t3", "hud-plugin");
const runDir = path.join(pluginDir, "run");
const bridgeFile = path.join(runDir, "hub-bridge.json");
const token = crypto.randomBytes(32).toString("hex");
let backend = null;
const disposedBackends = new WeakSet();

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
  try { if (typeof next.ensureDreamScheduler === "function") next.ensureDreamScheduler(); } catch {}
  return next;
}
backend = loadBackend();

function allowedOrigin(origin) {
  if (!origin || origin === "null") return null;
  if (origin.startsWith("t3code://") || origin.startsWith("t3code-dev://")) return origin;
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return origin;
  return null;
}

const server = http.createServer((req, res) => {
  const cors = allowedOrigin(req.headers.origin || "");
  if (cors) {
    res.setHeader("Access-Control-Allow-Origin", cors);
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-T3-Hud-Token");
    res.setHeader("Access-Control-Allow-Private-Network", "true");
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
        backend = loadBackend();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
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

server.once("close", () => {
  stopBackendScheduler();
});
process.once("beforeExit", () => {
  stopBackendScheduler();
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    stopBackendScheduler();
    server.close(() => { process.exitCode = 0; });
  });
}

server.listen(0, "127.0.0.1", () => {
  const addr = server.address();
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    bridgeFile,
    JSON.stringify({ url: "http://127.0.0.1:" + addr.port, token, pid: process.pid, watchPid }),
    { mode: 0o600 }
  );
});

if (watchPid > 0) {
  setInterval(() => {
    try { process.kill(watchPid, 0); } catch {
      try { fs.unlinkSync(bridgeFile); } catch {}
      process.exit(0);
    }
  }, 10000).unref();
}
