"use strict";

// Guard: Only run inside T3 Code's Electron main ("browser") process, once.
if (
  globalThis.__t3HudMainHookLoaded ||
  !process.versions ||
  !process.versions.electron ||
  process.type !== "browser" ||
  String(process.execPath || "").indexOf("T3 Code") === -1
) {
  return;
}
globalThis.__t3HudMainHookLoaded = true;

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const electron = require("electron");
const BACKEND_PATH = path.join(__dirname, "backend.cjs");
let backend = require(BACKEND_PATH);
function reloadBackend() {
  try {
    delete require.cache[require.resolve(BACKEND_PATH)];
    backend = require(BACKEND_PATH);
    return true;
  } catch {
    return false;
  }
}

const PRELOAD_BRIDGE_PATH = path.join(__dirname, "preload-bridge.cjs");
const RENDERER_UI_PATH = path.join(__dirname, "renderer-ui.js");
const HUD_RUN_DIR = path.join(os.homedir(), ".t3", "hud-plugin", "run");
const RPC_INFO_FILE = path.join(HUD_RUN_DIR, "rpc.json");

let httpFallbackConfig = null;
let lastInjectError = null;
let capturedT3Origin = null;
let rpcToken = null;
let adminToken = null;

function ensureRunDir() {
  try {
    let st = null;
    try {
      st = fs.lstatSync(HUD_RUN_DIR);
    } catch {
      st = null;
    }
    if (st && st.isSymbolicLink()) {
      try {
        fs.unlinkSync(HUD_RUN_DIR);
      } catch {}
      st = null;
    }
    if (st && !st.isDirectory()) {
      try {
        fs.unlinkSync(HUD_RUN_DIR);
      } catch {}
      st = null;
    }
    fs.mkdirSync(HUD_RUN_DIR, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(HUD_RUN_DIR, 0o700);
    } catch {}
  } catch {}
}

function writeRpcInfo() {
  ensureRunDir();
  try {
    const st = fs.lstatSync(RPC_INFO_FILE);
    if (st.isSymbolicLink()) {
      try {
        fs.unlinkSync(RPC_INFO_FILE);
      } catch {}
    } else {
      try {
        fs.unlinkSync(RPC_INFO_FILE);
      } catch {}
    }
  } catch {}
  try {
    fs.writeFileSync(
      RPC_INFO_FILE,
      JSON.stringify({
        ...httpFallbackConfig,
        adminToken,
        rpcToken,
        pid: process.pid,
      }),
      { flag: "wx", mode: 0o600 }
    );
  } catch {
    try {
      fs.rmSync(RPC_INFO_FILE, { force: true });
    } catch {}
    try {
      fs.writeFileSync(
        RPC_INFO_FILE,
        JSON.stringify({
          ...httpFallbackConfig,
          adminToken,
          rpcToken,
          pid: process.pid,
        }),
        { flag: "wx", mode: 0o600 }
      );
    } catch {}
  }
}

function captureT3Origin() {
  if (capturedT3Origin) return capturedT3Origin;
  try {
    for (const win of electron.BrowserWindow.getAllWindows()) {
      if (!win || win.isDestroyed() || isHelperWindow(win)) continue;
      const wc = win.webContents;
      if (!wc || wc.isDestroyed()) continue;
      const url = wc.getURL();
      if (!url) continue;
      const title = win.getTitle() || "";
      const isT3Title = title === "T3 Code" || title === "T3 Code (Beta)";
      const urlHasT3 = url.includes("t3code");
      if (url.startsWith("t3code://") || url.startsWith("t3code-dev://")) {
        try {
          capturedT3Origin = new URL(url).origin;
        } catch {
          capturedT3Origin = url.split("/").slice(0, 3).join("/");
        }
        return capturedT3Origin;
      }
      if (isT3Title || urlHasT3) {
        if (url.match(/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/)) {
          try {
            capturedT3Origin = new URL(url).origin;
          } catch {}
          if (capturedT3Origin) return capturedT3Origin;
        }
      }
    }
  } catch {}
  return capturedT3Origin;
}

function isMainT3Url(url) {
  if (!url || typeof url !== "string") return false;
  if (url.startsWith("t3code://") || url.startsWith("t3code-dev://")) return true;
  // For http(s) loopback URLs, strictly require match to captured origin or t3code marker,
  // and reject arbitrary localhost preview windows.
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)) {
    if (capturedT3Origin) {
      try {
        const u = new URL(url);
        return u.origin === capturedT3Origin;
      } catch {
        return false;
      }
    }
    // No capture yet: only accept if URL itself mentions t3code (heuristic upgrade path).
    return url.includes("t3code");
  }
  return false;
}

function isHelperWindow(win) {
  if (!win || win.isDestroyed()) return true;
  const title = win.getTitle() || "";
  return (
    title === "T3 Code Snapshot Animation" ||
    title.startsWith("Preview ·") ||
    title === "Browser preview" ||
    title.startsWith("Set up ")
  );
}

function getMainWindows() {
  captureT3Origin();
  return electron.BrowserWindow.getAllWindows().filter((win) => {
    if (!win || win.isDestroyed() || isHelperWindow(win)) return false;
    const wc = win.webContents;
    if (!wc || wc.isDestroyed()) return false;
    return isMainT3Url(wc.getURL());
  });
}

async function injectHudIntoWindow(win, forceReload = false) {
  if (!win || win.isDestroyed() || isHelperWindow(win)) return false;
  const wc = win.webContents;
  if (!wc || wc.isDestroyed()) return false;

  const url = wc.getURL();
  if (!isMainT3Url(url)) return false;

  try {
    if (!forceReload) {
      const alreadyMounted = await wc.executeJavaScript(
        "Boolean(window.__t3HudInitialized && document.getElementById('t3-hud-topbar'))",
        true
      );
      if (alreadyMounted) return true;
    }

    const uiCode = fs.readFileSync(RENDERER_UI_PATH, "utf8");
    const bootstrapCfg = httpFallbackConfig
      ? `window.__t3HudHttpConfig = ${JSON.stringify({ url: httpFallbackConfig.url, token: rpcToken })};\n`
      : "";
    await wc.executeJavaScript(bootstrapCfg + uiCode, true);
    lastInjectError = null;
    return true;
  } catch (err) {
    lastInjectError = err && err.message ? err.message : String(err);
    return false;
  }
}

function allowedOrigin(origin) {
  if (!origin || origin === "null") return null;
  if (origin.startsWith("t3code://") || origin.startsWith("t3code-dev://")) return origin;
  if (capturedT3Origin && origin === capturedT3Origin) return origin;
  return null;
}

function startLoopbackFallbackServer() {
  return new Promise((resolve) => {
    try {
      rpcToken = crypto.randomBytes(32).toString("hex");
      adminToken = crypto.randomBytes(32).toString("hex");
      const server = http.createServer(async (req, res) => {
        const reqOrigin = req.headers.origin || "";
        const corsOrigin = allowedOrigin(reqOrigin);
        if (corsOrigin) {
          res.setHeader("Access-Control-Allow-Origin", corsOrigin);
          res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
          res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-T3-Hud-Token");
          res.setHeader("Access-Control-Allow-Private-Network", "true");
        }

        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }

        const token = req.headers["x-t3-hud-token"];
        const isRpcToken = token === rpcToken;
        const isAdminToken = token === adminToken;

        // RPC: allowed for both tokens (rpcToken is read/write to local config via RPC only)
        const bodyReader = (cb) => {
          let body = "";
          req.on("data", (chunk) => {
            body += chunk;
            if (body.length > 1e6) req.destroy();
          });
          req.on("end", () => cb(body));
        };

        if (req.method === "GET" && req.url === "/admin/status") {
          if (!isAdminToken) {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Forbidden" }));
            return;
          }
          const wins = electron.BrowserWindow.getAllWindows().map((w) => ({
            id: w.id,
            title: w.getTitle(),
            url: w.webContents.getURL(),
            loading: w.webContents.isLoading(),
          }));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, pid: process.pid, lastInjectError, windows: wins }));
          return;
        }

        bodyReader(async (body) => {
          try {
            if (req.method === "POST" && req.url === "/admin/reload-ui") {
              if (!isAdminToken) {
                res.writeHead(403, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: "Forbidden" }));
                return;
              }
              reloadBackend();
              const results = [];
              for (const w of getMainWindows()) {
                results.push({ id: w.id, injected: await injectHudIntoWindow(w, true) });
              }
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: true, results, lastInjectError }));
              return;
            }

            if (req.method === "POST" && req.url === "/rpc") {
              if (!isRpcToken && !isAdminToken) {
                res.writeHead(403, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: "Forbidden" }));
                return;
              }
              const { method, args = [] } = JSON.parse(body || "{}");
              let out;
              if (method === "getThreadStats") {
                out = backend.getThreadStats(args[0]);
              } else if (method === "priceRemoteProjection") {
                out = backend.priceRemoteProjection(args[0]);
              } else if (method === "getGitGraph") {
                out = await backend.getGitGraph(args[0], args[1], args[2]);
              } else if (method === "getCommitDetail") {
                out = await backend.getCommitDetail(args[0], args[1], args[2]);
              } else if (method === "getConfig") {
                out = backend.getConfig();
              } else if (method === "setConfig") {
                out = backend.setConfig(args[0]);
              } else {
                out = { ok: false, error: "Unknown method" };
              }
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify(out));
              return;
            }

            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Not found" }));
          } catch (err) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: err?.message || "RPC failed" }));
          }
        });
      });

      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          httpFallbackConfig = { url: `http://127.0.0.1:${addr.port}`, token: rpcToken };
          captureT3Origin();
          writeRpcInfo();
        }
        resolve();
      });
      server.on("error", () => resolve());
      server.unref();
    } catch {
      resolve();
    }
  });
}

function registerIpcAndPreload() {
  const { ipcMain, session } = electron;

  try {
    const guard = (evt) => {
      try {
        const url = evt?.senderFrame?.url;
        if (!url) return false;
        captureT3Origin();
        return isMainT3Url(url);
      } catch {
        return false;
      }
    };
    ipcMain.handle("t3hud:get-thread-stats", (evt, threadHint) => {
      if (!guard(evt)) return { ok: false, error: "Forbidden" };
      return backend.getThreadStats(threadHint);
    });
    ipcMain.handle("t3hud:price-remote-projection", (evt, payload) => {
      if (!guard(evt)) return { ok: false, error: "Forbidden" };
      return backend.priceRemoteProjection(payload);
    });
    ipcMain.handle("t3hud:get-git-graph", (evt, threadHint, maxCommits, fallbackCwd) => {
      if (!guard(evt)) return { ok: false, error: "Forbidden" };
      return backend.getGitGraph(threadHint, maxCommits, fallbackCwd);
    });
    ipcMain.handle("t3hud:get-commit-detail", (evt, threadHint, commitHash, fallbackCwd) => {
      if (!guard(evt)) return { ok: false, error: "Forbidden" };
      return backend.getCommitDetail(threadHint, commitHash, fallbackCwd);
    });
    ipcMain.handle("t3hud:get-config", (evt) => {
      if (!guard(evt)) return { ok: false, error: "Forbidden" };
      return backend.getConfig();
    });
    ipcMain.handle("t3hud:set-config", (evt, patch) => {
      if (!guard(evt)) return { ok: false, error: "Forbidden" };
      return backend.setConfig(patch);
    });
  } catch {
    // Ignore duplicate registration
  }

  try {
    const ses = session.defaultSession;
    if (ses && typeof ses.registerPreloadScript === "function") {
      ses.registerPreloadScript({
        id: "t3-hud-preload-bridge",
        type: "frame",
        filePath: PRELOAD_BRIDGE_PATH,
      });
    } else if (ses && typeof ses.setPreloads === "function") {
      const existing = typeof ses.getPreloads === "function" ? ses.getPreloads() : [];
      if (!existing.includes(PRELOAD_BRIDGE_PATH)) {
        ses.setPreloads([...existing, PRELOAD_BRIDGE_PATH]);
      }
    }
  } catch {
    // Loopback HTTP fallback covers RPC seamlessly
  }
}

const hookedWindows = new WeakSet();
function attachWindowHooks(win) {
  if (!win || win.isDestroyed() || hookedWindows.has(win)) return;
  hookedWindows.add(win);

  const wc = win.webContents;
  if (!wc) return;

  wc.on("did-finish-load", () => {
    captureT3Origin();
    injectHudIntoWindow(win);
  });
  wc.on("did-navigate", () => setTimeout(() => injectHudIntoWindow(win), 150));
  wc.on("dom-ready", () => setTimeout(() => injectHudIntoWindow(win), 150));

  if (!wc.isLoading() && isMainT3Url(wc.getURL())) {
    injectHudIntoWindow(win);
  }
  setTimeout(() => injectHudIntoWindow(win), 800);
  setTimeout(() => injectHudIntoWindow(win), 2500);
}

if (electron.app) {
  electron.app.on("browser-window-created", (_event, win) => {
    attachWindowHooks(win);
  });

  electron.app.whenReady().then(async () => {
    await startLoopbackFallbackServer();
    registerIpcAndPreload();
    for (const win of electron.BrowserWindow.getAllWindows()) {
      attachWindowHooks(win);
    }
    // Gentle self-healing check in case window opens or reloads later
    const ensureTimer = setInterval(() => {
      for (const win of getMainWindows()) {
        attachWindowHooks(win);
        injectHudIntoWindow(win);
      }
    }, 3000);
    ensureTimer.unref();
  });
}
