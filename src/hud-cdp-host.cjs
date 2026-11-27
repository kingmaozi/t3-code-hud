"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const {
  isPidAlive: defaultIsPidAlive,
  ensurePrivateDir,
  readRegularFileNoFollow,
  writeFileAtomicNoFollow,
  unlinkIfRegular,
  readLiveBridgeRecord,
} = require("./hud-runtime.cjs");

if (process.env) {
  process.env.PATH = [...new Set([
    path.join(os.homedir(), ".local", "bin"), path.join(os.homedir(), ".t3", "bin"),
    "/opt/homebrew/bin", "/usr/local/bin", ...(process.env.PATH || "").split(path.delimiter),
    "/usr/bin", "/bin", "/usr/sbin", "/sbin",
  ].filter(Boolean))].join(path.delimiter);
}

const MOUNT_CHECK = "Boolean(window.__t3HudInitialized && document.getElementById('t3-hud-topbar') && window.__t3SidecarHub && document.getElementById('t3-sidecar-hub-root'))";
// These are main desktop preload methods. Preview, permission and snapshot
// pages can share an origin or an empty title without hosting this application.
const MAIN_PAGE_CHECK = `Boolean(document.getElementById('root') &&
  typeof window.desktopBridge?.getAppBranding === 'function' &&
  typeof window.desktopBridge?.getLocalEnvironmentBootstraps === 'function' &&
  typeof window.desktopBridge?.getClientSettings === 'function')`;
const EXACT_T3_ORIGINS = new Set(["t3code://app", "t3code-dev://app"]);

function extractT3CandidateOrigin(urlOrOrigin) {
  if (!urlOrOrigin || typeof urlOrOrigin !== "string") return null;
  let u;
  try {
    u = new URL(urlOrOrigin);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  if (u.protocol === "t3code:" || u.protocol === "t3code-dev:") {
    if (u.hostname === "app" && !u.port) {
      return `${u.protocol}//app`;
    }
    return null;
  }
  if (u.protocol === "http:" || u.protocol === "https:") {
    if (u.hostname === "127.0.0.1" || u.hostname === "localhost") {
      return u.origin;
    }
    return null;
  }
  return null;
}

function isAllowedT3Origin(origin, capturedT3Origin = null) {
  if (!origin || typeof origin !== "string" || origin === "null") return false;
  const canonical = extractT3CandidateOrigin(origin);
  if (!canonical || canonical !== origin) return false;
  if (EXACT_T3_ORIGINS.has(canonical)) return true;
  if (capturedT3Origin && canonical === capturedT3Origin) return true;
  return false;
}

function isHelperTarget(targetInfo) {
  if (!targetInfo || typeof targetInfo !== "object") return true;
  if (targetInfo.type && targetInfo.type !== "page") return true;
  const url = typeof targetInfo.url === "string" ? targetInfo.url : "";
  if (url) {
    // Reject non-T3 schemes/hosts even before title is populated (data:, about:, devtools:, third-party http(s), t3code://other)
    if (!extractT3CandidateOrigin(url)) return true;
  }
  const title = String(targetInfo.title || "");
  return (
    title === "T3 Code Snapshot Animation" ||
    title.startsWith("Preview ·") ||
    title === "Browser preview" ||
    title.startsWith("Set up ")
  );
}

function isMainT3Url(url, capturedT3Origin = null) {
  const origin = extractT3CandidateOrigin(url);
  if (!origin) return false;
  return isAllowedT3Origin(origin, capturedT3Origin);
}

function createCdpClient(wsUrl, { WebSocketImpl = globalThis.WebSocket, connectTimeoutMs = 5000 } = {}) {
  const emitter = new EventEmitter();
  let ws = null;
  let nextId = 1;
  let closed = false;
  const pending = new Map();

  function rejectAll(err) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    pending.clear();
  }

  function connect() {
    return new Promise((resolve, reject) => {
      if (closed) {
        reject(new Error("CDP client closed"));
        return;
      }
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ws?.close(); } catch {}
        reject(new Error("CDP connect timeout"));
      }, connectTimeoutMs);
      if (typeof timer.unref === "function") timer.unref();

      try {
        ws = new WebSocketImpl(wsUrl);
      } catch (err) {
        clearTimeout(timer);
        reject(err);
        return;
      }

      const onOpen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };

      const onError = (evt) => {
        if (closed) return;
        const err = evt?.error || new Error(evt?.message || "CDP WebSocket error");
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
          return;
        }
        if (emitter.listenerCount("error") > 0) {
          emitter.emit("error", err);
        }
      };

      const onClose = () => {
        clearTimeout(timer);
        const err = new Error("CDP WebSocket closed");
        if (!settled) {
          settled = true;
          reject(err);
        }
        rejectAll(err);
        if (!closed) {
          emitter.emit("close");
        }
      };

      const onMessage = (evt) => {
        let raw = evt?.data;
        if (raw && typeof raw !== "string") {
          try {
            raw = Buffer.isBuffer(raw) ? raw.toString("utf8") : Buffer.from(raw).toString("utf8");
          } catch {
            return;
          }
        }
        let msg;
        try {
          msg = JSON.parse(raw);
        } catch {
          return;
        }
        if (msg && msg.id != null) {
          const entry = pending.get(msg.id);
          if (!entry) return;
          pending.delete(msg.id);
          clearTimeout(entry.timer);
          if (msg.error) {
            entry.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          } else {
            entry.resolve(msg.result || {});
          }
          return;
        }
        if (msg && typeof msg.method === "string") {
          const params = msg.params || {};
          const sessionId = msg.sessionId || null;
          emitter.emit(msg.method, params, sessionId);
          emitter.emit("event", { method: msg.method, params, sessionId });
        }
      };

      if (typeof ws.addEventListener === "function") {
        ws.addEventListener("open", onOpen);
        ws.addEventListener("error", onError);
        ws.addEventListener("close", onClose);
        ws.addEventListener("message", onMessage);
      } else {
        ws.onopen = onOpen;
        ws.onerror = onError;
        ws.onclose = onClose;
        ws.onmessage = onMessage;
      }
    });
  }

  function isOpen() {
    return Boolean(!closed && ws && ws.readyState === 1);
  }

  function send(method, params = {}, sessionId = undefined, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      if (!isOpen()) {
        reject(new Error("CDP WebSocket not open"));
        return;
      }
      const id = nextId++;
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP call timeout: ${method}`));
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      pending.set(id, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify(payload));
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(err);
      }
    });
  }

  function close() {
    closed = true;
    rejectAll(new Error("CDP client closed"));
    try { ws?.close(); } catch {}
    ws = null;
  }

  return {
    connect,
    send,
    close,
    isOpen,
    on: (ev, fn) => emitter.on(ev, fn),
    off: (ev, fn) => emitter.off(ev, fn),
    once: (ev, fn) => emitter.once(ev, fn),
  };
}

function createCdpHost(options = {}) {
  const targetPid = Number(options.pid || 0);
  const cdpUrl = String(options.cdpUrl || "");
  const appBundle = options.appBundle ? String(options.appBundle) : null;
  const pluginDir = path.resolve(options.pluginDir || process.env.T3_HUD_DIR || __dirname);
  const runDir = path.resolve(options.runDir || path.join(pluginDir, "run"));
  const rpcInfoFile = path.join(runDir, `rpc-${targetPid}.json`);
  const WebSocketImpl = options.WebSocketImpl || globalThis.WebSocket;
  const isPidAlive = typeof options.isPidAlive === "function" ? options.isPidAlive : defaultIsPidAlive;
  const pollIntervalMs = Number(options.pollIntervalMs || 3000);
  const watchIntervalMs = Number(options.watchIntervalMs || 2000);
  const upgradeWindowMs = Number.isFinite(options.upgradeWindowMs) ? options.upgradeWindowMs : 15_000;
  const upgradePollMs = Number.isFinite(options.upgradePollMs) ? options.upgradePollMs : 250;
  const skipSidecarBridge = Boolean(options.skipSidecarBridge);
  const onExit = typeof options.onExit === "function" ? options.onExit : null;

  let guardianMod = null;
  try {
    guardianMod = require(path.join(__dirname, "update-guardian.cjs"));
  } catch {}

  const readBundleVersionFn = typeof options.readBundleVersion === "function"
    ? options.readBundleVersion
    : (b) => (guardianMod && typeof guardianMod.readBundleVersion === "function" ? guardianMod.readBundleVersion(b) : null);

  let initialBundleInfo = null;
  if (appBundle) {
    try { initialBundleInfo = readBundleVersionFn(appBundle); } catch {}
  }

  const disposedBackends = new WeakSet();
  let backend = options.backend || null;

  function stopBackendScheduler(target = backend) {
    if (!target || (typeof target !== "object" && typeof target !== "function") || disposedBackends.has(target)) return;
    disposedBackends.add(target);
    try {
      if (typeof target.stopDreamScheduler === "function") target.stopDreamScheduler();
    } catch {}
  }

  function loadBackend() {
    if (options.backend && !options.allowBackendReload) return options.backend;
    stopBackendScheduler();
    let cacheRoot = path.resolve(pluginDir);
    try { cacheRoot = fs.realpathSync(pluginDir); } catch {}
    let backendPath = path.resolve(pluginDir, "backend.cjs");
    try { backendPath = fs.realpathSync(backendPath); } catch {}
    const rawRoot = path.resolve(pluginDir);
    for (const k of Object.keys(require.cache)) {
      if (k === backendPath || k.startsWith(cacheRoot + path.sep) || k.startsWith(rawRoot + path.sep)) {
        delete require.cache[k];
      }
    }
    const next = require(backendPath);
    backend = next;
    return next;
  }

  let httpServer = null;
  let httpFallbackConfig = null;
  let rpcToken = null;
  let adminToken = null;
  let lastInjectError = null;
  let cdp = null;
  let connGen = 0;
  let connectPromise = null;
  let shuttingDown = false;
  let upgradeHandoffSpawned = false;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let pollTimer = null;
  let watchTimer = null;
  const scheduledTimers = new Set();

  const targets = new Map();
  const sessions = new Map();
  const sessionToTarget = new Map();
  const attachingPromises = new Map();
  let polling = null;

  function trackTimeout(fn, ms) {
    const t = setTimeout(() => {
      scheduledTimers.delete(t);
      fn();
    }, ms);
    if (typeof t.unref === "function") t.unref();
    scheduledTimers.add(t);
    return t;
  }

  function writeRpcInfo() {
    const record = {
      ...httpFallbackConfig,
      adminToken,
      rpcToken,
      pid: targetPid,
      hostPid: process.pid,
      transport: "cdp",
    };
    writeFileAtomicNoFollow(rpcInfoFile, JSON.stringify(record), { mode: 0o600 });
  }

  function cleanupOwnRpcInfo() {
    try {
      const raw = readRegularFileNoFollow(rpcInfoFile);
      const parsed = JSON.parse(raw);
      if (Number(parsed?.hostPid) === process.pid) {
        unlinkIfRegular(rpcInfoFile);
      }
    } catch {}
  }

  function isProbeCandidate(info) {
    return info?.type === "page" && !isHelperTarget(info) && Boolean(extractT3CandidateOrigin(info.url));
  }

  function getMainTargets() {
    return [...targets.values()].filter((info) => {
      const sess = sessions.get(info.targetId);
      return sess?.verifiedContext && isCurrentContext(sess, sess.verifiedContext);
    });
  }

  function allowedOrigin(origin) {
    if (isAllowedT3Origin(origin)) return origin;
    const mainOrigin = getMainTargets().find((info) => extractT3CandidateOrigin(info.url) === origin);
    return mainOrigin ? origin : null;
  }

  function invalidateSessionContext(sess) {
    sess.context = null;
    sess.verifiedContext = null;
    sess.mountedConfig = null;
  }

  function removeSessionIfMatch(targetId, sessionId, expectedGen) {
    const sess = sessions.get(targetId);
    if (!sess) return false;
    if (sessionId && sess.sessionId !== sessionId) return false;
    if (expectedGen != null && sess.connGen !== expectedGen) return false;
    sessions.delete(targetId);
    if (sessionToTarget.get(sess.sessionId) === targetId) {
      sessionToTarget.delete(sess.sessionId);
    }
    return true;
  }

  let sidecarBridgePromise = null;
  async function ensureSidecarBridge() {
    if (skipSidecarBridge) return null;
    if (sidecarBridgePromise) return sidecarBridgePromise;
    sidecarBridgePromise = (async () => {
      const existing = readLiveBridgeRecord(runDir, targetPid, { checkAlive: isPidAlive });
      if (existing) return existing.record;

      const bridgePath = path.join(pluginDir, "hub-bridge.cjs");
      if (!fs.existsSync(bridgePath)) return null;
      const runtime = guardianMod && typeof guardianMod.resolveNodeRuntime === "function"
        ? guardianMod.resolveNodeRuntime({ appBundle })
        : { bin: process.execPath, useRunAsNode: Boolean(process.versions?.electron) };
      if (!runtime) return null;
      const childEnv = { ...(process.env || {}), T3_HUD_DIR: pluginDir, T3_WATCH_PID: String(targetPid) };
      delete childEnv.NODE_OPTIONS;
      if (runtime.useRunAsNode) childEnv.ELECTRON_RUN_AS_NODE = "1";
      else delete childEnv.ELECTRON_RUN_AS_NODE;
      const child = spawn(runtime.bin, [bridgePath], {
        env: childEnv,
        detached: true,
        stdio: "ignore",
      });
      child.on("error", () => {});
      child.unref();
      for (let attempt = 0; attempt < 30; attempt++) {
        if (shuttingDown) return null;
        await new Promise((resolve) => setTimeout(resolve, 80));
        const live = readLiveBridgeRecord(runDir, targetPid, { checkAlive: isPidAlive });
        if (live) return live.record;
      }
      return null;
    })().catch(() => null).finally(() => { sidecarBridgePromise = null; });
    return sidecarBridgePromise;
  }

  function readValidBridge() {
    if (skipSidecarBridge) return null;
    const live = readLiveBridgeRecord(runDir, targetPid, { checkAlive: isPidAlive });
    if (!live) return null;
    return { url: live.record.url, token: live.record.token };
  }

  function ownsSession(sess) {
    return !shuttingDown && cdp?.isOpen() && sess.connGen === connGen && sessions.get(sess.targetId) === sess;
  }

  function isCurrentContext(sess, context) {
    if (!context || !ownsSession(sess) || sess.context !== context) return false;
    const info = targets.get(sess.targetId);
    return isProbeCandidate(info) && extractT3CandidateOrigin(info.url) === context.origin;
  }

  async function evaluateValue(sess, context, expression, timeoutMs) {
    if (!isCurrentContext(sess, context)) throw new Error("Execution context changed before evaluate");
    const res = await cdp.send("Runtime.evaluate", {
      expression,
      uniqueContextId: context.uniqueId,
      returnByValue: true,
      awaitPromise: false,
    }, sess.sessionId, timeoutMs);
    if (!isCurrentContext(sess, context)) throw new Error("Execution context changed during evaluate");
    if (res?.exceptionDetails) {
      const msg = res.exceptionDetails.exception?.description || res.exceptionDetails.text || "Runtime.evaluate exception";
      throw new Error(msg);
    }
    return res?.result?.value;
  }

  async function isTargetMounted(targetId) {
    const sess = sessions.get(targetId);
    if (!sess?.verifiedContext || sess.loading) return false;
    try {
      return (await evaluateValue(sess, sess.verifiedContext, MOUNT_CHECK, 400)) === true && !sess.loading;
    } catch {
      return false;
    }
  }

  async function attachTarget(targetId) {
    const myGen = connGen;
    if (shuttingDown || !cdp || !cdp.isOpen()) return null;
    const existing = sessions.get(targetId);
    if (existing && existing.connGen === myGen) return existing;
    const attachKey = `${myGen}:${targetId}`;
    if (attachingPromises.has(attachKey)) return attachingPromises.get(attachKey);

    const p = (async () => {
      const info = targets.get(targetId);
      if (!info || !isProbeCandidate(info)) return null;
      const client = cdp;
      const res = await client.send("Target.attachToTarget", { targetId, flatten: true }, undefined, 4000);
      const sessionId = res?.sessionId;
      if (!sessionId || shuttingDown || myGen !== connGen || cdp !== client || !client.isOpen()) return null;
      if (!isProbeCandidate(targets.get(targetId))) {
        void client.send("Target.detachFromTarget", { sessionId }, undefined, 1500).catch(() => {});
        return null;
      }
      const sess = {
        targetId,
        sessionId,
        connGen: myGen,
        loading: false,
        topFrameId: null,
        context: null,
        verifiedContext: null,
        mountedConfig: null,
        activeInject: null,
        queuedForce: null,
      };
      sessions.set(targetId, sess);
      sessionToTarget.set(sessionId, targetId);

      // Enable Page + getFrameTree first so topFrameId is known before Runtime.enable replays contexts
      await client.send("Page.enable", {}, sessionId, 3000).catch(() => {});
      if (!ownsSession(sess)) return null;
      const tree = await client.send("Page.getFrameTree", {}, sessionId, 3000).catch(() => null);
      if (!ownsSession(sess)) return null;
      if (!sess.topFrameId) sess.topFrameId = tree?.frameTree?.frame?.id || null;
      await client.send("Runtime.enable", {}, sessionId, 3000).catch(() => {});
      if (!ownsSession(sess)) return null;
      return sess;
    })().catch(() => null).finally(() => {
      if (attachingPromises.get(attachKey) === p) attachingPromises.delete(attachKey);
    });

    attachingPromises.set(attachKey, p);
    return p;
  }

  async function detachTarget(targetId, expectedGen = connGen) {
    const sess = sessions.get(targetId);
    if (!sess || (expectedGen != null && sess.connGen !== expectedGen)) return;
    removeSessionIfMatch(targetId, sess.sessionId, sess.connGen);
    if (cdp && cdp.isOpen() && sess.connGen === connGen) {
      await cdp.send("Target.detachFromTarget", { sessionId: sess.sessionId }, undefined, 1500).catch(() => {});
    }
  }

  async function runSingleInjection(sess, forceReload) {
    const context = sess.context;
    if (!isCurrentContext(sess, context)) return false;

    try {
      // The first evaluation contains no HUD configuration or credentials.
      const isMainPage = await evaluateValue(sess, context, MAIN_PAGE_CHECK, 1500);
      if (!isCurrentContext(sess, context)) return false;
      sess.verifiedContext = isMainPage === true ? context : null;
      if (!sess.verifiedContext) return false;

      await ensureSidecarBridge();
      if (!isCurrentContext(sess, context)) return false;
      const validBridge = readValidBridge();

      const previousConfig = sess.mountedConfig;
      if (!forceReload && previousConfig?.bridgeUrl === validBridge?.url &&
          previousConfig?.bridgeToken === validBridge?.token && previousConfig?.rpcToken === rpcToken) {
        if ((await evaluateValue(sess, context, MOUNT_CHECK, 1500)) === true) return true;
      }

      const rendererPath = path.join(pluginDir, "renderer-ui.js");
      let uiCode = fs.readFileSync(rendererPath, "utf8");
      uiCode = uiCode.replace(/^(?:window\.__t3HubSidecarBridge\s*=\s*[^\n]*|delete window\.__t3HubSidecarBridge;)\n?/gm, "");
      let bootstrapCfg = httpFallbackConfig
        ? `window.__t3HudHttpConfig = ${JSON.stringify({ url: httpFallbackConfig.url, token: rpcToken })};\n`
        : "";
      bootstrapCfg = (validBridge
        ? `window.__t3HubSidecarBridge = ${JSON.stringify(validBridge)};\n`
        : "delete window.__t3HubSidecarBridge;\n") + bootstrapCfg;
      if (!uiCode.includes("__T3_HUB_DRAWER_EMBED_START__")) {
        const drawerPath = path.join(pluginDir, "hub-drawer-ui.js");
        if (fs.existsSync(drawerPath)) {
          const drawerCode = fs.readFileSync(drawerPath, "utf8");
          uiCode += ";\nwindow.__t3HubDrawerEmbedded = true;\n" + drawerCode;
        }
      }

      if (!isCurrentContext(sess, context)) return false;

      const evalRes = await cdp.send("Runtime.evaluate", {
        expression: bootstrapCfg + uiCode,
        uniqueContextId: context.uniqueId,
        returnByValue: false,
        awaitPromise: false,
      }, sess.sessionId, 15000);
      if (!isCurrentContext(sess, context)) return false;

      if (evalRes?.exceptionDetails) {
        const msg = evalRes.exceptionDetails.exception?.description ||
          evalRes.exceptionDetails.text ||
          "Runtime.evaluate exception";
        lastInjectError = String(msg);
        return false;
      }

      const mounted = await evaluateValue(sess, context, MOUNT_CHECK, 1500);
      if (!isCurrentContext(sess, context)) return false;
      sess.mountedConfig = mounted === true ? {
        bridgeUrl: validBridge?.url, bridgeToken: validBridge?.token, rpcToken,
      } : null;
      lastInjectError = mounted === true ? null : "HUD mount incomplete";
      return mounted === true;
    } catch (err) {
      if (!isCurrentContext(sess, context)) return false;
      lastInjectError = err && err.message ? err.message : String(err);
      return false;
    }
  }

  function startSessionInject(sess, forceReload) {
    const promise = runSingleInjection(sess, forceReload).finally(() => {
      if (!ownsSession(sess)) {
        sess.queuedForce?.resolve(false);
        return;
      }
      if (sess.activeInject && sess.activeInject.promise === promise) {
        sess.activeInject = null;
      }
      if (sess.queuedForce) {
        const next = sess.queuedForce;
        sess.queuedForce = null;
        startSessionInject(sess, true).then(next.resolve, () => next.resolve(false));
      }
    });
    sess.activeInject = { promise, force: forceReload };
    return promise;
  }

  async function injectTarget(targetId, { forceReload = false } = {}) {
    const info = targets.get(targetId);
    if (!info || !isProbeCandidate(info)) return false;
    const sess = await attachTarget(targetId);
    if (!sess || !ownsSession(sess)) return false;

    if (!sess.activeInject) {
      return startSessionInject(sess, forceReload);
    }

    if (!forceReload) {
      // Return actual result of in-flight injection (never hardcoded true)
      return sess.activeInject.promise;
    }

    // Queue a dedicated follow-up forced injection after activeInject finishes so every
    // concurrent /admin/reload-ui observes the true result of a fresh post-request injection.
    if (!sess.queuedForce) {
      let resolveQueued;
      const queuedPromise = new Promise((resolve) => { resolveQueued = resolve; });
      sess.queuedForce = { promise: queuedPromise, resolve: resolveQueued };
    }
    return sess.queuedForce.promise;
  }

  function syncTargetsAndInject() {
    const client = cdp;
    const myGen = connGen;
    const isCurrent = () => !shuttingDown && cdp === client && client?.isOpen() && connGen === myGen;
    if (!isCurrent()) return;
    if (polling?.gen === myGen) return polling.promise;

    const promise = (async () => {
      const before = new Map(targets);
      const res = await client.send("Target.getTargets", {}, undefined, 4000);
      if (!isCurrent()) return;
      const infos = Array.isArray(res?.targetInfos) ? res.targetInfos : [];
      const seen = new Set();
      for (const info of infos) {
        if (!info?.targetId) continue;
        const id = info.targetId;
        seen.add(id);
        if (before.get(id) === targets.get(id)) targets.set(id, info);
      }
      for (const [id, info] of before) {
        if (!isCurrent()) return;
        if (!seen.has(id) && targets.get(id) === info) {
          targets.delete(id);
          await detachTarget(id, myGen);
        }
      }
      for (const [id, info] of targets) {
        if (!isCurrent()) return;
        if (isProbeCandidate(info)) await injectTarget(id);
        else await detachTarget(id, myGen);
      }
    })().catch(() => {}).finally(() => {
      if (polling?.promise === promise) polling = null;
    });
    polling = { gen: myGen, promise };
    return promise;
  }

  function scheduleReconnect() {
    if (shuttingDown || reconnectTimer || connectPromise) return;
    if (!isPidAlive(targetPid)) {
      void handleTargetExited();
      return;
    }
    const delay = Math.min(2000, 250 * Math.pow(2, reconnectAttempt));
    reconnectAttempt = Math.min(reconnectAttempt + 1, 4);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connectCdp();
    }, delay);
    if (typeof reconnectTimer.unref === "function") reconnectTimer.unref();
  }

  async function connectCdp() {
    if (shuttingDown || !cdpUrl) return;
    if (connectPromise) return connectPromise;
    if (!isPidAlive(targetPid)) {
      void handleTargetExited();
      return;
    }

    connectPromise = (async () => {
      const myGen = ++connGen;
      if (cdp) {
        const old = cdp;
        cdp = null;
        try { old.close(); } catch {}
      }
      targets.clear();
      sessions.clear();
      sessionToTarget.clear();
      attachingPromises.clear();

      const client = createCdpClient(cdpUrl, { WebSocketImpl });
      cdp = client;

      client.on("Target.targetCreated", (params) => {
        if (myGen !== connGen || cdp !== client) return;
        const info = params?.targetInfo;
        if (!info?.targetId) return;
        targets.set(info.targetId, info);
        if (isProbeCandidate(info)) {
          void injectTarget(info.targetId);
        }
      });

      client.on("Target.targetInfoChanged", (params) => {
        if (myGen !== connGen || cdp !== client) return;
        const info = params?.targetInfo;
        if (!info?.targetId) return;
        targets.set(info.targetId, info);
        if (isProbeCandidate(info)) {
          void injectTarget(info.targetId);
        } else if (sessions.has(info.targetId)) {
          void detachTarget(info.targetId, myGen);
        }
      });

      client.on("Target.targetDestroyed", (params) => {
        if (myGen !== connGen || cdp !== client) return;
        const targetId = params?.targetId;
        if (!targetId) return;
        targets.delete(targetId);
        removeSessionIfMatch(targetId, null, myGen);
      });

      client.on("Target.detachedFromTarget", (params) => {
        if (myGen !== connGen || cdp !== client) return;
        const sid = params?.sessionId || null;
        const tid = params?.targetId || (sid ? sessionToTarget.get(sid) : null);
        if (tid) {
          removeSessionIfMatch(tid, sid, myGen);
        } else if (sid) {
          sessionToTarget.delete(sid);
        }
      });

      client.on("Runtime.executionContextCreated", (params, sessionId) => {
        if (myGen !== connGen || cdp !== client || !sessionId) return;
        const tid = sessionToTarget.get(sessionId);
        const sess = tid ? sessions.get(tid) : null;
        if (!sess || sess.sessionId !== sessionId || sess.connGen !== myGen) return;
        const ctx = params?.context;
        if (!ctx || typeof ctx.id !== "number") return;
        const aux = ctx.auxData || {};
        if (aux.isDefault !== true || !sess.topFrameId || aux.frameId !== sess.topFrameId) return;
        invalidateSessionContext(sess);
        const origin = extractT3CandidateOrigin(ctx.origin);
        if (!origin || typeof ctx.uniqueId !== "string" || !ctx.uniqueId.trim()) return;
        sess.context = { id: ctx.id, uniqueId: ctx.uniqueId, origin };
        if (isProbeCandidate(targets.get(tid))) void injectTarget(tid);
      });

      client.on("Runtime.executionContextDestroyed", (params, sessionId) => {
        if (myGen !== connGen || cdp !== client || !sessionId) return;
        const tid = sessionToTarget.get(sessionId);
        const sess = tid ? sessions.get(tid) : null;
        if (!sess || sess.sessionId !== sessionId || sess.connGen !== myGen) return;
        const uniqueId = params?.executionContextUniqueId;
        if (sess.context && (uniqueId
          ? sess.context.uniqueId === uniqueId
          : sess.context.id === params?.executionContextId)) {
          invalidateSessionContext(sess);
        }
      });

      client.on("Runtime.executionContextsCleared", (_params, sessionId) => {
        if (myGen !== connGen || cdp !== client || !sessionId) return;
        const tid = sessionToTarget.get(sessionId);
        const sess = tid ? sessions.get(tid) : null;
        if (!sess || sess.sessionId !== sessionId || sess.connGen !== myGen) return;
        invalidateSessionContext(sess);
      });

      client.on("Page.frameStartedLoading", (params, sessionId) => {
        if (myGen !== connGen || cdp !== client || !sessionId) return;
        const tid = sessionToTarget.get(sessionId);
        const sess = tid ? sessions.get(tid) : null;
        if (sess && sess.sessionId === sessionId && sess.connGen === myGen && params?.frameId === sess.topFrameId) sess.loading = true;
      });

      client.on("Page.frameStoppedLoading", (params, sessionId) => {
        if (myGen !== connGen || cdp !== client || !sessionId) return;
        const tid = sessionToTarget.get(sessionId);
        const sess = tid ? sessions.get(tid) : null;
        if (sess && sess.sessionId === sessionId && sess.connGen === myGen && params?.frameId === sess.topFrameId) sess.loading = false;
      });

      client.on("Page.loadEventFired", (_params, sessionId) => {
        if (myGen !== connGen || cdp !== client || !sessionId) return;
        const tid = sessionToTarget.get(sessionId);
        const sess = tid ? sessions.get(tid) : null;
        if (!sess || sess.sessionId !== sessionId || sess.connGen !== myGen) return;
        sess.loading = false;
        void injectTarget(tid);
      });

      client.on("Page.domContentEventFired", (_params, sessionId) => {
        if (myGen !== connGen || cdp !== client || !sessionId) return;
        const tid = sessionToTarget.get(sessionId);
        const sess = tid ? sessions.get(tid) : null;
        if (!sess || sess.sessionId !== sessionId || sess.connGen !== myGen) return;
        trackTimeout(() => { if (ownsSession(sess)) void injectTarget(tid); }, 150);
      });

      client.on("Page.frameNavigated", (params, sessionId) => {
        if (myGen !== connGen || cdp !== client || !sessionId) return;
        if (params?.frame?.parentId) return;
        const tid = sessionToTarget.get(sessionId);
        const sess = tid ? sessions.get(tid) : null;
        if (!sess || sess.sessionId !== sessionId || sess.connGen !== myGen) return;
        if (params?.frame?.id) sess.topFrameId = params.frame.id;
        // Top-level navigation invalidates the old execution context immediately
        invalidateSessionContext(sess);
        const info = targets.get(tid);
        if (info && typeof params?.frame?.url === "string" && params.frame.url) {
          targets.set(tid, { ...info, url: params.frame.url });
        }
        const updated = targets.get(tid);
        if (updated && isProbeCandidate(updated)) {
          trackTimeout(() => { if (ownsSession(sess)) void injectTarget(tid); }, 150);
        } else {
          void detachTarget(tid, myGen);
        }
      });

      client.on("close", () => {
        if (cdp !== client || myGen !== connGen) return;
        targets.clear();
        sessions.clear();
        sessionToTarget.clear();
        if (!shuttingDown) {
          scheduleReconnect();
        }
      });

      client.on("error", () => {});

      try {
        await client.connect();
        if (shuttingDown || cdp !== client || myGen !== connGen) {
          client.close();
          return;
        }
        reconnectAttempt = 0;
        await client.send("Target.setDiscoverTargets", { discover: true }, undefined, 4000).catch(() => {});
        if (cdp === client && myGen === connGen) await syncTargetsAndInject();
      } catch {
        if (cdp === client && myGen === connGen) {
          try { client.close(); } catch {}
          cdp = null;
        }
        if (!shuttingDown && myGen === connGen) {
          scheduleReconnect();
        }
      }
    })().finally(() => {
      connectPromise = null;
      if (!shuttingDown && !cdp?.isOpen()) scheduleReconnect();
    });

    return connectPromise;
  }

  function triggerUpgradeHandoff(nowInfo) {
    if (upgradeHandoffSpawned) return false;
    upgradeHandoffSpawned = true;
    if (typeof options.spawnUpgradeHandoff === "function") {
      options.spawnUpgradeHandoff({ prevPid: targetPid, appBundle, initialBundleInfo, currentBundleInfo: nowInfo });
      return true;
    }
    try {
      const guardianPath = path.join(pluginDir, "update-guardian.cjs");
      if (!fs.existsSync(guardianPath)) return false;
      const runtime = guardianMod && typeof guardianMod.resolveNodeRuntime === "function"
        ? guardianMod.resolveNodeRuntime({ appBundle })
        : { bin: process.execPath, useRunAsNode: Boolean(process.versions?.electron) };
      if (!runtime) return false;
      const childEnv = { ...(process.env || {}), T3_HUD_DIR: pluginDir };
      delete childEnv.NODE_OPTIONS;
      if (runtime.useRunAsNode) childEnv.ELECTRON_RUN_AS_NODE = "1";
      else delete childEnv.ELECTRON_RUN_AS_NODE;
      const child = spawn(runtime.bin, [guardianPath, "--mode=upgrade-handoff", `--prev-pid=${targetPid}`], {
        env: childEnv,
        detached: true,
        stdio: "ignore",
      });
      child.on("error", () => {});
      child.unref();
      return true;
    } catch {
      return false;
    }
  }

  function bundleChanged(nowInfo) {
    if (!nowInfo || !initialBundleInfo) return false;
    return (
      nowInfo.shortVersion !== initialBundleInfo.shortVersion ||
      nowInfo.buildVersion !== initialBundleInfo.buildVersion ||
      nowInfo.mtimeMs !== initialBundleInfo.mtimeMs
    );
  }

  async function waitAndTriggerUpgradeHandoff() {
    if (upgradeHandoffSpawned || !appBundle || !initialBundleInfo) return false;
    const deadline = Date.now() + Math.max(0, upgradeWindowMs);
    let sawMissing = false;
    for (;;) {
      let nowInfo = null;
      try { nowInfo = readBundleVersionFn(appBundle); } catch {}
      if (!nowInfo) {
        sawMissing = true;
      } else if (sawMissing || bundleChanged(nowInfo)) {
        return triggerUpgradeHandoff(nowInfo);
      }
      if (Date.now() >= deadline) return false;
      const remaining = deadline - Date.now();
      await new Promise((r) => setTimeout(r, Math.min(Math.max(10, upgradePollMs), Math.max(10, remaining))));
    }
  }

  async function stop({ checkUpgrade = false } = {}) {
    if (shuttingDown) return;
    shuttingDown = true;
    connGen++;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    clearInterval(pollTimer);
    pollTimer = null;
    clearInterval(watchTimer);
    watchTimer = null;
    for (const t of scheduledTimers) clearTimeout(t);
    scheduledTimers.clear();

    try { cdp?.close(); } catch {}
    cdp = null;
    sessions.clear();
    sessionToTarget.clear();

    cleanupOwnRpcInfo();
    stopBackendScheduler();

    if (httpServer) {
      const srv = httpServer;
      httpServer = null;
      await new Promise((resolve) => {
        try {
          if (typeof srv.closeAllConnections === "function") srv.closeAllConnections();
          srv.close(() => resolve());
        } catch {
          resolve();
        }
      });
    }

    if (checkUpgrade) {
      await waitAndTriggerUpgradeHandoff();
    }
  }

  async function handleTargetExited() {
    if (shuttingDown) return;
    await stop({ checkUpgrade: true });
    if (onExit) onExit(0);
  }

  function startHttpServer() {
    return new Promise((resolve, reject) => {
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
          const wins = await Promise.all(getMainTargets().map(async (info) => {
            const sess = sessions.get(info.targetId);
            return {
              id: info.targetId,
              title: info.title || "",
              url: info.url || "",
              loading: Boolean(sess?.loading),
              mounted: await isTargetMounted(info.targetId),
            };
          }));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            ok: true,
            pid: targetPid,
            hostPid: process.pid,
            transport: "cdp",
            lastInjectError,
            mounted: wins.some((w) => w.mounted),
            windows: wins,
          }));
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
              try {
                loadBackend();
              } catch (reloadErr) {
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({
                  ok: false,
                  error: reloadErr?.message || "Backend reload failed",
                  results: [],
                  lastInjectError,
                }));
                return;
              }
              const results = [];
              for (const info of getMainTargets()) {
                results.push({ id: info.targetId, injected: await injectTarget(info.targetId, { forceReload: true }) });
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
              if (!backend) loadBackend();
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

      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        httpServer = server;
        const addr = server.address();
        httpFallbackConfig = { url: `http://127.0.0.1:${addr.port}`, token: rpcToken };
        try {
          ensurePrivateDir(runDir);
          writeRpcInfo();
        } catch (err) {
          reject(err);
          return;
        }
        resolve({ url: httpFallbackConfig.url, rpcToken, adminToken, rpcInfoFile });
      });
    });
  }

  async function start() {
    if (!Number.isSafeInteger(targetPid) || targetPid <= 0) {
      throw new Error("Invalid target pid");
    }
    if (!cdpUrl) {
      throw new Error("Missing cdpUrl");
    }
    if (!backend) {
      loadBackend();
    }
    const info = await startHttpServer();
    await ensureSidecarBridge();
    await connectCdp();

    pollTimer = setInterval(() => {
      if (shuttingDown) return;
      if (!isPidAlive(targetPid)) {
        void handleTargetExited();
        return;
      }
      if (cdp && cdp.isOpen()) {
        void syncTargetsAndInject();
      } else if (!reconnectTimer && !connectPromise) {
        scheduleReconnect();
      }
    }, pollIntervalMs);
    if (typeof pollTimer.unref === "function") pollTimer.unref();

    watchTimer = setInterval(() => {
      if (shuttingDown) return;
      if (!isPidAlive(targetPid)) {
        void handleTargetExited();
      }
    }, watchIntervalMs);
    if (typeof watchTimer.unref === "function") watchTimer.unref();

    return info;
  }

  return {
    start,
    stop,
    getState: () => ({
      targetPid,
      capturedT3Origin: getMainTargets().map((info) => extractT3CandidateOrigin(info.url))[0] || null,
      lastInjectError,
      rpcInfoFile,
      url: httpFallbackConfig?.url || null,
      rpcToken,
      adminToken,
      connGen,
      targetCount: targets.size,
      sessionCount: sessions.size,
    }),
  };
}

function readStdinJson() {
  return new Promise((resolve, reject) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error("stdin config too large"));
      }
    });
    process.stdin.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch (err) {
        reject(err);
      }
    });
    process.stdin.on("error", reject);
  });
}

if (require.main === module) {
  readStdinJson()
    .then(async (cfg) => {
      const targetPid = Number(cfg?.pid || 0);
      if (targetPid > 0) process.env.T3_WATCH_PID = String(targetPid);
      if (cfg?.pluginDir) process.env.T3_HUD_DIR = String(cfg.pluginDir);

      const host = createCdpHost({
        pid: targetPid,
        cdpUrl: cfg?.cdpUrl,
        appBundle: cfg?.appBundle,
        pluginDir: cfg?.pluginDir,
        runDir: cfg?.runDir,
        onExit: (code) => process.exit(code),
      });

      const handleSignal = () => {
        host.stop({ checkUpgrade: false }).finally(() => process.exit(0));
      };
      process.once("SIGINT", handleSignal);
      process.once("SIGTERM", handleSignal);
      process.once("beforeExit", () => {
        void host.stop({ checkUpgrade: false });
      });

      await host.start();
    })
    .catch((err) => {
      console.error("[t3-hud-cdp-host]", err?.message || String(err));
      process.exit(1);
    });
}

module.exports = {
  MOUNT_CHECK,
  EXACT_T3_ORIGINS,
  extractT3CandidateOrigin,
  isAllowedT3Origin,
  createCdpClient,
  isHelperTarget,
  isMainT3Url,
  createCdpHost,
};
