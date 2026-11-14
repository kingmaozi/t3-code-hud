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
const path = require("node:path");
const electron = require("electron");
const BACKEND_PATH = path.join(__dirname, "backend.cjs");
let backend = require(BACKEND_PATH);

const PRELOAD_BRIDGE_PATH = path.join(__dirname, "preload-bridge.cjs");
const RENDERER_UI_PATH = path.join(__dirname, "renderer-ui.js");
const RPC_INFO_FILE = "/tmp/t3-hud-rpc.json";

let httpFallbackConfig = null;
let lastInjectError = null;

function isMainT3Url(url) {
  if (!url || typeof url !== "string") return false;
  return (
    url.startsWith("t3code://") ||
    url.startsWith("t3code-dev://") ||
    url.startsWith("http://127.0.0.1:") ||
    url.startsWith("http://localhost:") ||
    url.startsWith("https://127.0.0.1:") ||
    url.startsWith("https://localhost:")
  );
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
      ? `window.__t3HudHttpConfig = ${JSON.stringify(httpFallbackConfig)};\n`
      : "";
    await wc.executeJavaScript(bootstrapCfg + uiCode, true);
    lastInjectError = null;
    return true;
  } catch (err) {
    lastInjectError = err && err.message ? err.message : String(err);
    return false;
  }
}

function startLoopbackFallbackServer() {
  return new Promise((resolve) => {
    try {
      const token = crypto.randomBytes(24).toString("hex");
      const server = http.createServer(async (req, res) => {
        const origin = req.headers.origin || "*";
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-T3-Hud-Token");
        res.setHeader("Access-Control-Allow-Private-Network", "true");

        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }

        if (req.headers["x-t3-hud-token"] !== token) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Forbidden" }));
          return;
        }

        if (req.method === "GET" && req.url === "/admin/status") {
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

        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
          if (body.length > 1e6) req.destroy();
        });
        req.on("end", async () => {
          try {
            if (req.method === "POST" && req.url === "/admin/reload-ui") {
              try {
                delete require.cache[require.resolve(BACKEND_PATH)];
                backend = require(BACKEND_PATH);
              } catch {}
              const results = [];
              for (const w of getMainWindows()) {
                results.push({ id: w.id, injected: await injectHudIntoWindow(w, true) });
              }
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: true, results, lastInjectError }));
              return;
            }

            if (req.method === "POST" && req.url === "/admin/eval") {
              const { code } = JSON.parse(body || "{}");
              const win = getMainWindows()[0];
              if (!win) {
                res.writeHead(404, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: "No main T3 window found" }));
                return;
              }
              const val = await win.webContents.executeJavaScript(code, true);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: true, result: val }));
              return;
            }

            if (req.method === "POST" && req.url === "/rpc") {
              const { method, args = [] } = JSON.parse(body || "{}");
              let out;
              if (method === "getThreadStats") {
                out = backend.getThreadStats(args[0]);
              } else if (method === "getGitGraph") {
                out = await backend.getGitGraph(args[0], args[1]);
              } else if (method === "getCommitDetail") {
                out = await backend.getCommitDetail(args[0], args[1]);
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
          httpFallbackConfig = { url: `http://127.0.0.1:${addr.port}`, token };
          try {
            fs.writeFileSync(
              RPC_INFO_FILE,
              JSON.stringify({ ...httpFallbackConfig, pid: process.pid }),
              { mode: 0o600 }
            );
          } catch {}
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
    ipcMain.handle("t3hud:get-thread-stats", (_evt, threadHint) => backend.getThreadStats(threadHint));
    ipcMain.handle("t3hud:get-git-graph", (_evt, threadHint, maxCommits) =>
      backend.getGitGraph(threadHint, maxCommits)
    );
    ipcMain.handle("t3hud:get-commit-detail", (_evt, threadHint, commitHash) =>
      backend.getCommitDetail(threadHint, commitHash)
    );
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

  wc.on("did-finish-load", () => injectHudIntoWindow(win));
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
