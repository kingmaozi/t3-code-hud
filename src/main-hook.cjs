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
const { spawn } = require("node:child_process");
const electron = require("electron");
if (process.env) {
  process.env.PATH = [...new Set([
    path.join(os.homedir(), ".local", "bin"), path.join(os.homedir(), ".t3", "bin"),
    "/opt/homebrew/bin", "/usr/local/bin", ...(process.env.PATH || "").split(path.delimiter),
    "/usr/bin", "/bin", "/usr/sbin", "/sbin",
  ].filter(Boolean))].join(path.delimiter);
}
const BACKEND_PATH = path.join(__dirname, "backend.cjs");
let backend = require(BACKEND_PATH);
function reloadBackend() {
  try {
    for (const k of Object.keys(require.cache)) {
      if (k === BACKEND_PATH || k.startsWith(__dirname + path.sep)) {
        delete require.cache[k];
      }
    }
    backend = require(BACKEND_PATH);
    return true;
  } catch {
    return false;
  }
}

const PRELOAD_BRIDGE_PATH = path.join(__dirname, "preload-bridge.cjs");
const RENDERER_UI_PATH = path.join(__dirname, "renderer-ui.js");
const HUD_RUN_DIR = path.join(os.homedir(), ".t3", "hud-plugin", "run");
// Per-process records prevent a second launch from replacing the active RPC.
const RPC_INFO_FILE = path.join(HUD_RUN_DIR, `rpc-${process.pid}.json`);

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
  const temp = `${RPC_INFO_FILE}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify({ ...httpFallbackConfig, adminToken, rpcToken, pid: process.pid }),
      { flag: "wx", mode: 0o600 });
    fs.renameSync(temp, RPC_INFO_FILE);
  } catch {
    // Failure leaves readiness unconfirmed; never touch another PID's record.
  } finally { try { fs.unlinkSync(temp); } catch {} }
}

const MOUNT_CHECK = "Boolean(window.__t3HudInitialized && document.getElementById('t3-hud-topbar') && window.__t3SidecarHub && document.getElementById('t3-sidecar-hub-root'))";
async function isWindowMounted(win) {
  let timer;
  try {
    if (win.isDestroyed() || win.webContents.isDestroyed() || win.webContents.isLoading()) return false;
    return (await Promise.race([
      win.webContents.executeJavaScript(MOUNT_CHECK, true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), 400); }),
    ])) === true;
  } catch { return false; }
  finally { clearTimeout(timer); }
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

let sidecarBridgePromise = null;
async function ensureSidecarBridge() {
  if (sidecarBridgePromise) return sidecarBridgePromise;
  sidecarBridgePromise = (async () => {
    const bridgeFile = path.join(HUD_RUN_DIR, "hub-bridge.json");
    const readRecord = () => {
      try { return JSON.parse(fs.readFileSync(bridgeFile, "utf8")); } catch { return null; }
    };
    const isOwnedLiveBridge = (b) => {
      if (!b || !Number.isInteger(b.pid) || b.pid <= 0 || typeof b.url !== "string" || !b.url ||
          typeof b.token !== "string" || !b.token || !(process.pid > 0) || Number(b.watchPid) !== process.pid) return false;
      try { process.kill(b.pid, 0); return true; } catch { return false; }
    };
    const previous = readRecord();
    if (isOwnedLiveBridge(previous)) return previous;
    if (previous?.pid > 0 && Number(previous.watchPid) > 0 && Number(previous.watchPid) !== process.pid) {
      let ownerDead = false;
      try { process.kill(Number(previous.watchPid), 0); } catch { ownerDead = true; }
      if (ownerDead) {
        try { process.kill(previous.pid, "SIGTERM"); } catch {}
        try { fs.unlinkSync(bridgeFile); } catch {}
      }
    }
    const bridgePath = path.join(__dirname, "hub-bridge.cjs");
    if (!fs.existsSync(bridgePath)) return null;
    const child = spawn(process.execPath, [bridgePath], {
      env: { ...(process.env || {}), ELECTRON_RUN_AS_NODE: "1", T3_HUD_DIR: __dirname, T3_WATCH_PID: String(process.pid) },
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {});
    child.unref();
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 80));
      const b = readRecord();
      if (isOwnedLiveBridge(b)) return b;
    }
    return null;
  })().catch(() => null).finally(() => { sidecarBridgePromise = null; });
  return sidecarBridgePromise;
}

async function injectHudIntoWindow(win, forceReload = false) {
  if (!win || win.isDestroyed() || isHelperWindow(win)) return false;
  const wc = win.webContents;
  if (!wc || wc.isDestroyed()) return false;

  const url = wc.getURL();
  if (!isMainT3Url(url)) return false;

  try {
    if (typeof ensureSidecarBridge === "function") await ensureSidecarBridge();
    let validBridge = null;
    try {
      const b = JSON.parse(fs.readFileSync(path.join(HUD_RUN_DIR, "hub-bridge.json"), "utf8"));
      if (b && Number.isInteger(b.pid) && b.pid > 0 && typeof b.url === "string" && b.url && typeof b.token === "string" && b.token &&
          process.pid > 0 && Number(b.watchPid) === process.pid) {
        process.kill(b.pid, 0);
        validBridge = { url: b.url, token: b.token };
      }
    } catch {}
    if (!forceReload) {
      const bridgeMatches = validBridge
        ? `window.__t3HubSidecarBridge?.url === ${JSON.stringify(validBridge.url)} && window.__t3HubSidecarBridge?.token === ${JSON.stringify(validBridge.token)}`
        : "!window.__t3HubSidecarBridge";
      const alreadyMounted = await wc.executeJavaScript(
        `Boolean(window.__t3HudInitialized && document.getElementById('t3-hud-topbar') && (${bridgeMatches}))`,
        true
      );
      if (alreadyMounted) return true;
    }

    let uiCode = fs.readFileSync(RENDERER_UI_PATH, "utf8");
    // Installed bundles can carry another T3 process's old bridge header.
    // Strip assignments, never use a bridge READ in the renderer as a guard.
    uiCode = uiCode.replace(/^(?:window\.__t3HubSidecarBridge\s*=\s*[^\n]*|delete window\.__t3HubSidecarBridge;)\n?/gm, "");
    let bootstrapCfg = httpFallbackConfig
      ? `window.__t3HudHttpConfig = ${JSON.stringify({ url: httpFallbackConfig.url, token: rpcToken })};\n`
      : "";
    bootstrapCfg = (validBridge
      ? `window.__t3HubSidecarBridge = ${JSON.stringify(validBridge)};\n`
      : "delete window.__t3HubSidecarBridge;\n") + bootstrapCfg;
    // CSP-free path: append the drawer in the same payload instead of
    // relying on a later (0, eval), which script-src blocks in t3code://app.
    if (!uiCode.includes("__T3_HUB_DRAWER_EMBED_START__")) {
      const drawerPath = path.join(__dirname, "hub-drawer-ui.js");
      if (fs.existsSync(drawerPath)) {
        const drawerCode = fs.readFileSync(drawerPath, "utf8");
        uiCode += ";\nwindow.__t3HubDrawerEmbedded = true;\n" + drawerCode;
      }
    }
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
          const wins = await Promise.all(getMainWindows().map(async w => ({
            id: w.id, title: w.getTitle(), url: w.webContents.getURL(), loading: w.webContents.isLoading(),
            mounted: await isWindowMounted(w),
          })));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, pid: process.pid, lastInjectError, mounted: wins.some(w => w.mounted), windows: wins }));
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
              } else if (method === "getRemoteGitGraph") {
                out = await backend.getRemoteGitGraph(args[0]);
              } else if (method === "getRemoteCommitDetail") {
                out = await backend.getRemoteCommitDetail(args[0]);
              } else if (method === "getConfig") {
                out = backend.getConfig();
              } else if (method === "setConfig") {
                out = backend.setConfig(args[0]);
              } else if (method === "hubCall") {
                out = await backend.hubCall(args[0], args[1]);
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
    ipcMain.handle("t3hud:get-remote-git-graph", (evt, bundle) => {
      if (!guard(evt)) return { ok: false, error: "Forbidden" };
      return backend.getRemoteGitGraph(bundle);
    });
    ipcMain.handle("t3hud:get-remote-commit-detail", (evt, req) => {
      if (!guard(evt)) return { ok: false, error: "Forbidden" };
      return backend.getRemoteCommitDetail(req);
    });
    ipcMain.handle("t3hud:get-config", (evt) => {
      if (!guard(evt)) return { ok: false, error: "Forbidden" };
      return backend.getConfig();
    });
    ipcMain.handle("t3hud:set-config", (evt, patch) => {
      if (!guard(evt)) return { ok: false, error: "Forbidden" };
      return backend.setConfig(patch);
    });
    ipcMain.handle("t3hud:hub-call", (evt, action, payload) => {
      if (!guard(evt)) return { ok: false, error: "Forbidden" };
      return backend.hubCall(action, payload || {});
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
  let upgradeHandoffSpawned = false;
  let initialBundleInfo = null;
  function resolveOwnBundlePath() {
    const exe = String(process.execPath || "");
    const idx = exe.indexOf(".app/Contents/");
    return idx > 0 ? exe.slice(0, idx + 4) : null;
  }
  function spawnUpgradeHandoff() {
    if (upgradeHandoffSpawned) return;
    upgradeHandoffSpawned = true;
    try {
      const guardianPath = path.join(__dirname, "update-guardian.cjs");
      if (!fs.existsSync(guardianPath)) return;
      const child = spawn(process.execPath, [guardianPath, "--mode=upgrade-handoff", `--prev-pid=${process.pid}`], {
        env: { ...(process.env || {}), ELECTRON_RUN_AS_NODE: "1", T3_HUD_DIR: __dirname },
        detached: true,
        stdio: "ignore",
      });
      child.on("error", () => {});
      child.unref();
    } catch {}
  }
  try {
    const guardian = require(path.join(__dirname, "update-guardian.cjs"));
    const ownBundle = resolveOwnBundlePath();
    if (ownBundle) initialBundleInfo = guardian.readBundleVersion(ownBundle);
    if (electron.autoUpdater && typeof electron.autoUpdater.on === "function") {
      electron.autoUpdater.on("before-quit-for-update", () => spawnUpgradeHandoff());
    }
    electron.app.on("before-quit", () => {
      try {
        const b = resolveOwnBundlePath();
        if (!b || !initialBundleInfo) return;
        const now = guardian.readBundleVersion(b);
        if (now && (now.shortVersion !== initialBundleInfo.shortVersion || now.buildVersion !== initialBundleInfo.buildVersion || now.mtimeMs !== initialBundleInfo.mtimeMs)) {
          spawnUpgradeHandoff();
        }
      } catch {}
    });
  } catch {}

  electron.app.on("browser-window-created", (_event, win) => {
    attachWindowHooks(win);
  });

  electron.app.whenReady().then(async () => {
    await startLoopbackFallbackServer();
    await ensureSidecarBridge();
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
