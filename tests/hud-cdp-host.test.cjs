"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const {
  MOUNT_CHECK,
  extractT3CandidateOrigin,
  isAllowedT3Origin,
  createCdpClient,
  isHelperTarget,
  isMainT3Url,
  createCdpHost,
} = require("../src/hud-cdp-host.cjs");
const { checkHud } = require("../src/hud-health.cjs");

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function encodeWsFrame(text, opcode = 0x1) {
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function createMockCdpServer(initialTargets = []) {
  const targets = new Map();
  for (const t of initialTargets) {
    targets.set(t.targetId, { ...t });
  }
  const pageState = new Map();
  const sockets = new Set();
  let sessionSeq = 1;
  let contextSeq = 10;
  const sessionToTarget = new Map();
  const targetToSession = new Map();
  const attachedTargetIds = [];
  const injectedTargetIds = [];
  const injectedPayloads = [];
  const injectedContextIds = [];
  let injectException = null;
  let injectDelayMs = 0;
  let onRootCheckHook = null;
  let onDetachHook = null;
  const rejectedContextIds = [];

  function originOf(url) {
    try {
      const u = new URL(url);
      if (u.protocol === "t3code:" || u.protocol === "t3code-dev:") {
        return `${u.protocol}//${u.hostname}`;
      }
      return u.origin;
    } catch {
      return "";
    }
  }

  function ensureState(targetId) {
    if (!pageState.has(targetId)) {
      const t = targets.get(targetId);
      pageState.set(targetId, {
        hasRoot: true,
        hasDesktopBridge: targetId.startsWith("main-"),
        mounted: false,
        drawerMounted: true,
        httpConfig: null,
        bridgeConfig: null,
        frameId: `frame-${targetId}`,
        contextId: contextSeq++,
        uniqueId: crypto.randomUUID(),
        origin: originOf(t?.url || ""),
      });
    }
    return pageState.get(targetId);
  }

  function broadcast(msg) {
    const frame = encodeWsFrame(JSON.stringify(msg));
    for (const sock of sockets) {
      if (!sock.destroyed) sock.write(frame);
    }
  }

  function handleMessage(sock, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { id, method, params = {}, sessionId } = msg;
    const reply = (result) => {
      if (!sock.destroyed) sock.write(encodeWsFrame(JSON.stringify({ id, result })));
    };
    const replyErr = (message) => {
      if (!sock.destroyed) sock.write(encodeWsFrame(JSON.stringify({ id, error: { code: -32000, message } })));
    };

    if (method === "Target.setDiscoverTargets") {
      reply({});
      return;
    }
    if (method === "Target.getTargets") {
      reply({ targetInfos: [...targets.values()] });
      return;
    }
    if (method === "Target.attachToTarget") {
      const targetId = params.targetId;
      if (!targets.has(targetId)) {
        replyErr("Target not found");
        return;
      }
      const sid = `sess-${sessionSeq++}`;
      sessionToTarget.set(sid, targetId);
      targetToSession.set(targetId, sid);
      attachedTargetIds.push(targetId);
      reply({ sessionId: sid });
      return;
    }
    if (method === "Target.detachFromTarget") {
      if (params.sessionId) {
        const tid = sessionToTarget.get(params.sessionId);
        sessionToTarget.delete(params.sessionId);
        if (tid && targetToSession.get(tid) === params.sessionId) targetToSession.delete(tid);
      }
      if (onDetachHook) onDetachHook(reply);
      else reply({});
      return;
    }
    if (method === "Page.enable") {
      reply({});
      return;
    }
    if (method === "Page.getFrameTree") {
      const targetId = sessionToTarget.get(sessionId);
      const t = targets.get(targetId);
      const st = ensureState(targetId);
      reply({
        frameTree: {
          frame: { id: st.frameId, url: t?.url || "" },
        },
      });
      return;
    }
    if (method === "Runtime.enable") {
      const targetId = sessionToTarget.get(sessionId);
      const t = targets.get(targetId);
      const st = ensureState(targetId);
      st.origin = originOf(t?.url || st.origin);
      reply({});
      broadcast({
        method: "Runtime.executionContextCreated",
        sessionId,
        params: {
          context: {
            id: st.contextId,
            uniqueId: st.uniqueId,
            origin: st.origin,
            auxData: { isDefault: true, frameId: st.frameId },
          },
        },
      });
      return;
    }
    if (method === "Runtime.evaluate") {
      const targetId = sessionToTarget.get(sessionId);
      if (!targetId) {
        replyErr("Session not found");
        return;
      }
      const st = ensureState(targetId);
      // Model both CDP selectors so this fixture catches unsafe numeric
      // binding when Chromium recycles the same id in another process.
      const contextMatches = params.uniqueContextId !== undefined
        ? params.uniqueContextId === st.uniqueId
        : params.contextId === st.contextId;
      if (!contextMatches) {
        rejectedContextIds.push(params.uniqueContextId);
        replyErr("Execution context no longer exists");
        return;
      }
      const expr = String(params.expression || "");
      if (expr.includes("window.desktopBridge") || expr.includes("document.getElementById('root')")) {
        const mainPage = st.hasRoot && (!expr.includes("window.desktopBridge") || st.hasDesktopBridge);
        if (typeof onRootCheckHook === "function") {
          onRootCheckHook({ targetId, sessionId, st });
        }
        reply({ result: { type: "boolean", value: Boolean(mainPage) } });
        return;
      }
      if (expr === MOUNT_CHECK) {
        reply({ result: { type: "boolean", value: Boolean(st.mounted && st.drawerMounted) } });
        return;
      }
      if (expr.includes("window.__t3HudInitialized") && expr.includes("window.__t3SidecarHub") && expr.includes("window.__t3HudHttpConfig")) {
        reply({ result: { type: "boolean", value: Boolean(st.mounted && st.drawerMounted) } });
        return;
      }
      // Actual HUD renderer injection
      const finalize = () => {
        injectedTargetIds.push(targetId);
        injectedPayloads.push(expr);
        injectedContextIds.push(params.uniqueContextId ?? params.contextId);
        if (injectException) {
          reply({
            result: { type: "object", subtype: "error" },
            exceptionDetails: { text: "Uncaught", exception: { description: injectException } },
          });
          return;
        }
        st.mounted = true;
        st.drawerMounted = !st.omitDrawerOnInject;
        reply({ result: { type: "undefined" } });
      };
      if (injectDelayMs > 0) {
        setTimeout(finalize, injectDelayMs);
      } else {
        finalize();
      }
      return;
    }
    reply({});
  }

  const server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });

  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    sockets.add(socket);

    let buf = Buffer.alloc(0);
    let fragmentedChunks = [];
    let fragmentedOpcode = 0;

    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const fin = Boolean(buf[0] & 0x80);
        const opcode = buf[0] & 0x0f;
        const masked = Boolean(buf[1] & 0x80);
        let payloadLen = buf[1] & 0x7f;
        let offset = 2;
        if (payloadLen === 126) {
          if (buf.length < 4) return;
          payloadLen = buf.readUInt16BE(2);
          offset = 4;
        } else if (payloadLen === 127) {
          if (buf.length < 10) return;
          payloadLen = Number(buf.readBigUInt64BE(2));
          offset = 10;
        }
        const maskBytes = masked ? 4 : 0;
        if (buf.length < offset + maskBytes + payloadLen) return;
        let payload = buf.subarray(offset + maskBytes, offset + maskBytes + payloadLen);
        if (masked) {
          const mask = buf.subarray(offset, offset + 4);
          payload = Buffer.from(payload);
          for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        } else {
          payload = Buffer.from(payload);
        }
        buf = buf.subarray(offset + maskBytes + payloadLen);

        if (opcode === 0x8) {
          socket.destroy();
          return;
        }
        if (opcode === 0x9) {
          socket.write(encodeWsFrame(payload.toString("utf8"), 0xA));
          continue;
        }
        if (opcode === 0x1 || opcode === 0x2) {
          if (fin) {
            handleMessage(socket, payload.toString("utf8"));
          } else {
            fragmentedOpcode = opcode;
            fragmentedChunks = [payload];
          }
        } else if (opcode === 0x0 && fragmentedOpcode) {
          fragmentedChunks.push(payload);
          if (fin) {
            const full = Buffer.concat(fragmentedChunks);
            fragmentedChunks = [];
            fragmentedOpcode = 0;
            handleMessage(socket, full.toString("utf8"));
          }
        }
      }
    });

    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));
  });

  return {
    async listen() {
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      const { port } = server.address();
      return `ws://127.0.0.1:${port}/devtools/browser/11111111-2222-3333-4444-555555555555`;
    },
    async close() {
      for (const s of sockets) s.destroy();
      sockets.clear();
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
    dropConnections() {
      for (const s of sockets) s.destroy();
      sockets.clear();
    },
    setPageState(targetId, patch) {
      Object.assign(ensureState(targetId), patch);
    },
    setDetachHook(fn) {
      onDetachHook = fn;
    },
    removeTargets(...ids) {
      for (const id of ids) targets.delete(id);
    },
    addTarget(info) {
      targets.set(info.targetId, info);
      broadcast({ method: "Target.targetCreated", params: { targetInfo: info } });
    },
    setInjectException(msg) {
      injectException = msg;
    },
    setInjectDelay(ms) {
      injectDelayMs = ms;
    },
    setOnRootCheck(fn) {
      onRootCheckHook = fn;
    },
    navigateTopFrame(targetId, newUrl) {
      const sid = targetToSession.get(targetId);
      const st = ensureState(targetId);
      const info = targets.get(targetId);
      if (info) targets.set(targetId, { ...info, url: newUrl });
      const oldCtx = st.contextId;
      st.contextId = contextSeq++;
      st.uniqueId = crypto.randomUUID();
      st.origin = originOf(newUrl);
      st.mounted = false;
      if (sid) {
        broadcast({ method: "Runtime.executionContextDestroyed", sessionId: sid, params: { executionContextId: oldCtx } });
        broadcast({ method: "Page.frameNavigated", sessionId: sid, params: { frame: { id: st.frameId, url: newUrl } } });
        broadcast({
          method: "Runtime.executionContextCreated",
          sessionId: sid,
          params: {
            context: {
              id: st.contextId,
            uniqueId: st.uniqueId,
              origin: st.origin,
              auxData: { isDefault: true, frameId: st.frameId },
            },
          },
        });
      }
    },
    emitStaleDetach(targetId, fakeSessionId) {
      broadcast({ method: "Target.detachedFromTarget", params: { targetId, sessionId: fakeSessionId } });
    },
    attachedTargetIds,
    injectedTargetIds,
    injectedPayloads,
    injectedContextIds,
    rejectedContextIds,
  };
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

test("strict origin/target whitelist rejects unknown t3code hosts, data/about/devtools URLs, and arbitrary loopback paths", () => {
  assert.equal(extractT3CandidateOrigin("t3code://app/thread/1"), "t3code://app");
  assert.equal(extractT3CandidateOrigin("t3code-dev://app/"), "t3code-dev://app");
  assert.equal(extractT3CandidateOrigin("t3code://other/"), null);
  assert.equal(extractT3CandidateOrigin("t3code://app:8080/"), null);
  assert.equal(extractT3CandidateOrigin("data:text/html,<h1>hi</h1>"), null);
  assert.equal(extractT3CandidateOrigin("about:blank"), null);
  assert.equal(extractT3CandidateOrigin("devtools://devtools/bundled/inspector.html"), null);
  assert.equal(extractT3CandidateOrigin("https://evil.example.com/"), null);

  assert.equal(isAllowedT3Origin("t3code://app"), true);
  assert.equal(isAllowedT3Origin("t3code-dev://app"), true);
  assert.equal(isAllowedT3Origin("t3code://other"), false);
  assert.equal(isAllowedT3Origin("http://127.0.0.1:8080"), false);
  assert.equal(isAllowedT3Origin("http://127.0.0.1:5173", "http://127.0.0.1:5173"), true);

  // Even when title is empty, non-T3 schemes/hosts are immediately rejected as helpers
  assert.equal(isHelperTarget({ type: "page", title: "", url: "data:text/html,x" }), true);
  assert.equal(isHelperTarget({ type: "page", title: "", url: "about:blank" }), true);
  assert.equal(isHelperTarget({ type: "page", title: "", url: "devtools://devtools/bundled/inspector.html" }), true);
  assert.equal(isHelperTarget({ type: "page", title: "", url: "https://example.com/" }), true);
  assert.equal(isHelperTarget({ type: "page", title: "", url: "t3code://other/" }), true);
  assert.equal(isHelperTarget({ type: "page", title: "Preview · localhost:3000", url: "http://127.0.0.1:3000/" }), true);
  assert.equal(isHelperTarget({ type: "page", title: "Browser preview", url: "https://example.com/" }), true);
  assert.equal(isHelperTarget({ type: "page", title: "T3 Code Snapshot Animation", url: "t3code://app/snapshot" }), true);
  assert.equal(isHelperTarget({ type: "page", title: "Set up Codex", url: "t3code://app/setup" }), true);
  assert.equal(isHelperTarget({ type: "service_worker", title: "T3 Code", url: "t3code://app/sw.js" }), true);
  assert.equal(isHelperTarget({ type: "page", title: "T3 Code", url: "t3code://app/" }), false);

  // Path containing "t3code" on arbitrary loopback port is rejected without captured origin
  assert.equal(isMainT3Url("http://127.0.0.1:8080/t3code-preview"), false);
  assert.equal(isMainT3Url("t3code://other/app"), false);
  assert.equal(isMainT3Url("t3code://app/"), true);
});

test("CDP host discovers targets, skips helpers/third-party, binds uniqueContextId, serves status/reload/rpc, and surfaces backend reload errors", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hud-cdp-host-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pluginDir = path.join(root, "plugin");
  const runDir = path.join(pluginDir, "run");
  fs.mkdirSync(runDir, { recursive: true });

  fs.writeFileSync(
    path.join(pluginDir, "renderer-ui.js"),
    'window.__t3HubSidecarBridge = { url: "http://127.0.0.1:1", token: "stale" };\nwindow.__hudRendered = true;\n'
  );
  fs.writeFileSync(path.join(pluginDir, "hub-drawer-ui.js"), "window.__drawerLoaded = true;\n");
  fs.writeFileSync(
    path.join(pluginDir, "backend.cjs"),
    `module.exports = {
  version: "v1",
  stopDreamScheduler() { globalThis.__testDreamStops = (globalThis.__testDreamStops || 0) + 1; },
  getConfig() { return { userLang: "zh", backendVersion: "v1" }; },
  setConfig(p) { return { ...p, saved: true }; },
  getThreadStats(h) { return { ok: true, hint: h }; },
  priceRemoteProjection(p) { return { ok: true, p }; },
  getGitGraph: async () => ({ ok: true, commits: [] }),
  getCommitDetail: async () => ({ ok: true }),
  getRemoteGitGraph: async () => ({ ok: true }),
  getRemoteCommitDetail: async () => ({ ok: true }),
  hubCall: async (action, payload) => ({ ok: true, action, payload, version: "v1" }),
};`
  );
  globalThis.__testDreamStops = 0;

  const cdpServer = createMockCdpServer([
    { targetId: "preview-1", type: "page", title: "Preview · localhost:3000", url: "http://127.0.0.1:3000/" },
    { targetId: "loop-t3", type: "page", title: "T3 Code", url: "http://127.0.0.1:8080/t3code" },
    { targetId: "snap-untitled", type: "page", title: "", url: "t3code://app/snapshot" },
    { targetId: "main-no-unique", type: "page", title: "T3 Code", url: "t3code://app/" },
    { targetId: "other-host", type: "page", title: "", url: "t3code://other/" },
    { targetId: "data-1", type: "page", title: "", url: "data:text/html,<h1>x</h1>" },
    { targetId: "snap-1", type: "page", title: "T3 Code Snapshot Animation", url: "t3code://app/snapshot" },
    { targetId: "setup-1", type: "page", title: "Set up Codex", url: "t3code://app/setup" },
    { targetId: "ext-1", type: "page", title: "External", url: "https://evil.example.com/" },
    { targetId: "sw-1", type: "service_worker", title: "Worker", url: "t3code://app/sw.js" },
    { targetId: "main-1", type: "page", title: "T3 Code (Beta)", url: "t3code://app/" },
  ]);
  cdpServer.setPageState("main-1", { hasRoot: false, mounted: false });
  cdpServer.setPageState("main-no-unique", { uniqueId: undefined });
  const wsUrl = await cdpServer.listen();
  let hostRef = null;
  t.after(async () => {
    if (hostRef) await hostRef.stop({ checkUpgrade: false });
    await cdpServer.close();
  });

  const host = hostRef = createCdpHost({
    pid: process.pid,
    cdpUrl: wsUrl,
    pluginDir,
    runDir,
    pollIntervalMs: 70,
    watchIntervalMs: 120,
    skipSidecarBridge: true,
    allowBackendReload: true,
  });
  const info = await host.start();

  const rpcFile = path.join(runDir, `rpc-${process.pid}.json`);
  assert.equal(fs.statSync(rpcFile).mode & 0o777, 0o600);
  const rpcCfg = JSON.parse(fs.readFileSync(rpcFile, "utf8"));
  assert.equal(rpcCfg.pid, process.pid);
  assert.equal(rpcCfg.hostPid, process.pid);
  assert.equal(rpcCfg.transport, "cdp");
  assert.match(rpcCfg.rpcToken, /^[0-9a-f]{64}$/);
  assert.match(rpcCfg.adminToken, /^[0-9a-f]{64}$/);

  // Before #root mounts: silent wait, no error
  await new Promise((r) => setTimeout(r, 120));
  const statusBefore = await fetch(`${info.url}/admin/status`, {
    headers: { "X-T3-Hud-Token": info.adminToken, Origin: "t3code://app" },
  });
  assert.equal(statusBefore.status, 200);
  assert.equal(statusBefore.headers.get("access-control-allow-origin"), "t3code://app");
  const statusBeforeJson = await statusBefore.json();
  assert.equal(statusBeforeJson.mounted, false);
  assert.equal(statusBeforeJson.lastInjectError, null);
  assert.deepEqual(cdpServer.injectedTargetIds, []);

  // Disallowed origin t3code://other receives NO CORS header; rpcToken rejected on /admin/status
  const badOriginRes = await fetch(`${info.url}/admin/status`, {
    headers: { "X-T3-Hud-Token": info.rpcToken, Origin: "t3code://other" },
  });
  assert.equal(badOriginRes.status, 403);
  assert.equal(badOriginRes.headers.get("access-control-allow-origin"), null);

  // Mount #root on main-1
  cdpServer.setPageState("main-1", { hasRoot: true });
  assert.equal(await waitFor(() => checkHud({ rpcFile, pid: process.pid })), true);

  assert.deepEqual(new Set(cdpServer.attachedTargetIds), new Set(["main-1", "loop-t3", "snap-untitled", "main-no-unique"]));
  assert.notEqual(host.getState().capturedT3Origin, "http://127.0.0.1:8080");
  const unverifiedOrigin = await fetch(`${info.url}/admin/status`, {
    headers: { "X-T3-Hud-Token": info.adminToken, Origin: "http://127.0.0.1:8080" },
  });
  assert.equal(unverifiedOrigin.headers.get("access-control-allow-origin"), null);
  const statusNoOrigin = await fetch(`${info.url}/admin/status`, {
    headers: { "X-T3-Hud-Token": info.adminToken },
  }).then((r) => r.json());
  assert.deepEqual(statusNoOrigin.windows.map((w) => w.id), ["main-1"]);
  assert.deepEqual(cdpServer.injectedTargetIds, ["main-1"]);
  assert.match(cdpServer.injectedContextIds[0], /^[a-f0-9-]{36}$/);
  const injectedCode = cdpServer.injectedPayloads[0];
  assert.doesNotMatch(injectedCode, /http:\/\/127\.0\.0\.1:1/);
  assert.match(injectedCode, /window\.__t3HudHttpConfig = /);
  assert.match(injectedCode, /window\.__t3HubDrawerEmbedded = true;/);

  // Missing drawer triggers automatic recovery on steady-state poll
  cdpServer.setPageState("main-1", { drawerMounted: false });
  assert.equal(await waitFor(() => cdpServer.injectedTargetIds.length >= 2), true);

  // Stale detach with old sessionId must NOT drop active session
  cdpServer.emitStaleDetach("main-1", "sess-stale-999");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await checkHud({ rpcFile, pid: process.pid }), true);

  // /rpc with rpcToken
  const rpcRes = await fetch(`${info.url}/rpc`, {
    method: "POST",
    headers: { "X-T3-Hud-Token": info.rpcToken, "Content-Type": "application/json" },
    body: JSON.stringify({ method: "hubCall", args: ["ping", { a: 1 }] }),
  }).then((r) => r.json());
  assert.deepEqual(rpcRes, { ok: true, action: "ping", payload: { a: 1 }, version: "v1" });

  // Broken backend.cjs during /admin/reload-ui MUST fail explicitly (never swallowed)
  fs.writeFileSync(path.join(pluginDir, "backend.cjs"), "throw new Error('broken-backend-syntax');\n");
  const brokenReload = await fetch(`${info.url}/admin/reload-ui`, {
    method: "POST",
    headers: { "X-T3-Hud-Token": info.adminToken },
  });
  assert.equal(brokenReload.status, 500);
  const brokenJson = await brokenReload.json();
  assert.equal(brokenJson.ok, false);
  assert.match(brokenJson.error, /broken-backend-syntax/);

  // Restore valid v2 backend.cjs -> reload succeeds
  fs.writeFileSync(
    path.join(pluginDir, "backend.cjs"),
    `module.exports = {
  version: "v2",
  stopDreamScheduler() { globalThis.__testDreamStops = (globalThis.__testDreamStops || 0) + 1; },
  getConfig() { return { userLang: "en", backendVersion: "v2" }; },
  hubCall: async (action) => ({ ok: true, action, version: "v2" }),
};`
  );
  const reloadRes = await fetch(`${info.url}/admin/reload-ui`, {
    method: "POST",
    headers: { "X-T3-Hud-Token": info.adminToken },
  }).then((r) => r.json());
  assert.equal(reloadRes.ok, true);
  assert.deepEqual(reloadRes.results, [{ id: "main-1", injected: true }]);
  assert.ok(globalThis.__testDreamStops >= 1);

  const rpcAfter = await fetch(`${info.url}/rpc`, {
    method: "POST",
    headers: { "X-T3-Hud-Token": info.rpcToken, "Content-Type": "application/json" },
    body: JSON.stringify({ method: "hubCall", args: ["ping"] }),
  }).then((r) => r.json());
  assert.equal(rpcAfter.version, "v2");
});

test("concurrent /admin/reload-ui accurately reports injected:false to every caller when injection fails", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hud-cdp-concurrent-reload-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pluginDir = path.join(root, "plugin");
  const runDir = path.join(pluginDir, "run");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "renderer-ui.js"), "window.__hud = true;\n");

  const cdpServer = createMockCdpServer([
    { targetId: "main-1", type: "page", title: "T3 Code", url: "t3code://app/" },
  ]);
  const wsUrl = await cdpServer.listen();
  let hostRef = null;
  t.after(async () => {
    if (hostRef) await hostRef.stop({ checkUpgrade: false });
    await cdpServer.close();
  });

  const host = hostRef = createCdpHost({
    pid: process.pid,
    cdpUrl: wsUrl,
    pluginDir,
    runDir,
    pollIntervalMs: 5000,
    watchIntervalMs: 5000,
    skipSidecarBridge: true,
    backend: { stopDreamScheduler() {} },
  });
  const info = await host.start();
  assert.equal(await waitFor(() => cdpServer.injectedTargetIds.length === 1), true);

  cdpServer.setInjectDelay(60);
  cdpServer.setInjectException("SyntaxError: bad bundle");
  const [r1, r2, r3] = await Promise.all([
    fetch(`${info.url}/admin/reload-ui`, { method: "POST", headers: { "X-T3-Hud-Token": info.adminToken } }).then((r) => r.json()),
    fetch(`${info.url}/admin/reload-ui`, { method: "POST", headers: { "X-T3-Hud-Token": info.adminToken } }).then((r) => r.json()),
    fetch(`${info.url}/admin/reload-ui`, { method: "POST", headers: { "X-T3-Hud-Token": info.adminToken } }).then((r) => r.json()),
  ]);
  for (const res of [r1, r2, r3]) {
    assert.equal(res.results.length, 1);
    assert.equal(res.results[0].injected, false, "concurrent forceReload must NEVER falsely report injected:true on failure");
  }
});

test("mid-flight navigation invalidates uniqueContextId and prevents token injection into untrusted document", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hud-cdp-nav-race-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pluginDir = path.join(root, "plugin");
  const runDir = path.join(pluginDir, "run");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "renderer-ui.js"), "window.__hud = true;\n");

  const cdpServer = createMockCdpServer([
    { targetId: "main-1", type: "page", title: "T3 Code", url: "t3code://app/" },
  ]);
  // Navigate to untrusted origin right as #root check fires
  cdpServer.setOnRootCheck(({ targetId }) => {
    cdpServer.navigateTopFrame(targetId, "https://evil.example.com/");
  });
  const wsUrl = await cdpServer.listen();
  let hostRef = null;
  t.after(async () => {
    if (hostRef) await hostRef.stop({ checkUpgrade: false });
    await cdpServer.close();
  });

  const host = hostRef = createCdpHost({
    pid: process.pid,
    cdpUrl: wsUrl,
    pluginDir,
    runDir,
    pollIntervalMs: 120,
    watchIntervalMs: 200,
    skipSidecarBridge: true,
    backend: { stopDreamScheduler() {} },
  });
  await host.start();
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(cdpServer.injectedTargetIds, [], "tokens must NEVER be injected after navigation to untrusted document");
});

test("transfers and hot-reloads a realistic >=420KB renderer bundle over real loopback WebSocket", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hud-cdp-large-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pluginDir = path.join(root, "plugin");
  const runDir = path.join(pluginDir, "run");
  fs.mkdirSync(runDir, { recursive: true });

  const pad = "// " + "X".repeat(430 * 1024) + "\n";
  fs.writeFileSync(path.join(pluginDir, "renderer-ui.js"), `${pad}window.__largeHudV1 = true;\n`);

  const cdpServer = createMockCdpServer([
    { targetId: "main-1", type: "page", title: "T3 Code", url: "t3code://app/" },
  ]);
  const wsUrl = await cdpServer.listen();
  let hostRef = null;
  t.after(async () => {
    if (hostRef) await hostRef.stop({ checkUpgrade: false });
    await cdpServer.close();
  });

  const host = hostRef = createCdpHost({
    pid: process.pid,
    cdpUrl: wsUrl,
    pluginDir,
    runDir,
    pollIntervalMs: 5000,
    watchIntervalMs: 5000,
    skipSidecarBridge: true,
    backend: { stopDreamScheduler() {} },
  });
  const info = await host.start();
  assert.equal(await waitFor(() => cdpServer.injectedPayloads.length === 1), true);
  assert.ok(cdpServer.injectedPayloads[0].length > 420 * 1024);
  assert.match(cdpServer.injectedPayloads[0], /window\.__largeHudV1 = true;/);

  // Hot-reload with updated >=420KB bundle
  fs.writeFileSync(path.join(pluginDir, "renderer-ui.js"), `${pad}window.__largeHudV2 = true;\n`);
  const reload = await fetch(`${info.url}/admin/reload-ui`, {
    method: "POST",
    headers: { "X-T3-Hud-Token": info.adminToken },
  }).then((r) => r.json());
  assert.equal(reload.ok, true);
  assert.deepEqual(reload.results, [{ id: "main-1", injected: true }]);
  assert.equal(cdpServer.injectedPayloads.length, 2);
  assert.ok(cdpServer.injectedPayloads[1].length > 420 * 1024);
  assert.match(cdpServer.injectedPayloads[1], /window\.__largeHudV2 = true;/);
});

test("CDP host polls upgrade window after target exit, survives temporary missing .app, cleans rpc, and triggers handoff", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hud-cdp-exit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pluginDir = path.join(root, "plugin");
  const runDir = path.join(pluginDir, "run");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "renderer-ui.js"), "window.__hud = true;\n");

  const cdpServer = createMockCdpServer([
    { targetId: "main-1", type: "page", title: "T3 Code", url: "t3code://app/" },
  ]);
  const wsUrl = await cdpServer.listen();
  let hostRef = null;
  t.after(async () => {
    if (hostRef) await hostRef.stop({ checkUpgrade: false });
    await cdpServer.close();
  });

  let alive = true;
  let pollCount = 0;
  const handoffs = [];
  let exited = false;
  let dreamStops = 0;
  const fakePid = 987654;

  const host = hostRef = createCdpHost({
    pid: fakePid,
    cdpUrl: wsUrl,
    appBundle: "/Applications/FakeT3.app",
    pluginDir,
    runDir,
    pollIntervalMs: 60,
    watchIntervalMs: 40,
    upgradeWindowMs: 1000,
    upgradePollMs: 25,
    skipSidecarBridge: true,
    isPidAlive: (p) => (p === fakePid ? alive : false),
    readBundleVersion: () => {
      pollCount++;
      if (pollCount === 1) return { shortVersion: "0.1.13", buildVersion: "100", mtimeMs: 1000 };
      if (pollCount <= 3) return null; // Squirrel mid-swap: bundle temporarily missing!
      return { shortVersion: "0.1.14", buildVersion: "101", mtimeMs: 2000 };
    },
    spawnUpgradeHandoff: (payload) => handoffs.push(payload),
    backend: { stopDreamScheduler() { dreamStops++; } },
    onExit: () => { exited = true; },
  });

  await host.start();
  const rpcFile = path.join(runDir, `rpc-${fakePid}.json`);
  assert.equal(fs.existsSync(rpcFile), true);

  // Target exits BEFORE bundle replacement completes
  alive = false;

  assert.equal(await waitFor(() => exited), true);
  assert.equal(fs.existsSync(rpcFile), false, "own rpc file must be cleaned up on exit");
  assert.equal(dreamStops, 1, "dream scheduler must stop on exit");
  assert.equal(handoffs.length, 1, "delayed bundle replacement after missing .app must trigger upgrade-handoff");
  assert.equal(handoffs[0].prevPid, fakePid);
});

test("CDP host preserves rpc file owned by another hostPid and skips upgrade-handoff when bundle unchanged", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hud-cdp-preserve-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pluginDir = path.join(root, "plugin");
  const runDir = path.join(pluginDir, "run");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "renderer-ui.js"), "window.__hud = true;\n");

  const cdpServer = createMockCdpServer([]);
  const wsUrl = await cdpServer.listen();
  let hostRef = null;
  t.after(async () => {
    if (hostRef) await hostRef.stop({ checkUpgrade: false });
    await cdpServer.close();
  });

  let alive = true;
  const handoffs = [];
  let exited = false;
  const fakePid = 987655;

  const host = hostRef = createCdpHost({
    pid: fakePid,
    cdpUrl: wsUrl,
    appBundle: "/Applications/FakeT3.app",
    pluginDir,
    runDir,
    pollIntervalMs: 60,
    watchIntervalMs: 40,
    upgradeWindowMs: 80,
    upgradePollMs: 20,
    skipSidecarBridge: true,
    isPidAlive: (p) => (p === fakePid ? alive : false),
    readBundleVersion: () => ({ shortVersion: "0.1.13", buildVersion: "100", mtimeMs: 1000 }),
    spawnUpgradeHandoff: (payload) => handoffs.push(payload),
    backend: { stopDreamScheduler() {} },
    onExit: () => { exited = true; },
  });

  await host.start();
  const rpcFile = path.join(runDir, `rpc-${fakePid}.json`);
  fs.writeFileSync(rpcFile, JSON.stringify({ pid: fakePid, hostPid: process.pid + 999 }));
  alive = false;

  assert.equal(await waitFor(() => exited), true);
  assert.equal(fs.existsSync(rpcFile), true, "rpc file owned by another hostPid must not be deleted");
  assert.equal(handoffs.length, 0, "no upgrade-handoff when bundle version is unchanged");
});

test("createCdpClient handles WS reconnect when target remains alive", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hud-cdp-reconnect-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pluginDir = path.join(root, "plugin");
  const runDir = path.join(pluginDir, "run");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "renderer-ui.js"), "window.__hud = true;\n");

  const cdpServer = createMockCdpServer([
    { targetId: "main-1", type: "page", title: "T3 Code", url: "t3code://app/" },
  ]);
  const wsUrl = await cdpServer.listen();
  let hostRef = null;
  t.after(async () => {
    if (hostRef) await hostRef.stop({ checkUpgrade: false });
    await cdpServer.close();
  });

  const direct = createCdpClient(wsUrl);
  await direct.connect();
  const res = await direct.send("Target.getTargets", {});
  assert.equal(res.targetInfos.length, 1);
  direct.close();

  const host = hostRef = createCdpHost({
    pid: process.pid,
    cdpUrl: wsUrl,
    pluginDir,
    runDir,
    pollIntervalMs: 100,
    watchIntervalMs: 200,
    skipSidecarBridge: true,
    backend: { stopDreamScheduler() {} },
  });
  const info = await host.start();

  assert.equal(await waitFor(() => cdpServer.injectedTargetIds.length === 1), true);
  cdpServer.setPageState("main-1", { hasRoot: true, mounted: false });
  cdpServer.dropConnections();

  assert.equal(await waitFor(() => cdpServer.injectedTargetIds.length >= 2, 4000), true);
  const status = await fetch(`${info.url}/admin/status`, {
    headers: { "X-T3-Hud-Token": info.adminToken },
  }).then((r) => r.json());
  assert.equal(status.mounted, true);
});

async function cdpFixture(t, targets, options = {}) {
  const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), "hud-cdp-fixture-"));
  const runDir = path.join(pluginDir, "run");
  fs.writeFileSync(path.join(pluginDir, "renderer-ui.js"), "window.__fixtureHud = true;\n");
  const server = createMockCdpServer(targets);
  const host = createCdpHost({
    pid: process.pid,
    cdpUrl: await server.listen(),
    pluginDir,
    runDir,
    pollIntervalMs: 70,
    skipSidecarBridge: true,
    backend: {},
    ...options,
  });
  t.after(async () => {
    await host.stop({ checkUpgrade: false });
    await server.close();
    fs.rmSync(pluginDir, { recursive: true, force: true });
  });
  return { server, host, pluginDir, runDir };
}

test("CDP never sends a renderer token to a recycled numeric context", async (t) => {
  const { server, host } = await cdpFixture(t, [
    { targetId: "main-1", type: "page", title: "", url: "t3code://app/" },
  ]);
  const oldUniqueId = crypto.randomUUID();
  server.setPageState("main-1", { uniqueId: oldUniqueId });
  server.setOnRootCheck(({ targetId }) => {
    // Chromium switches process before the host receives navigation events.
    // The numeric id is unchanged, and only the unique id distinguishes it.
    server.setPageState(targetId, { uniqueId: crypto.randomUUID(), hasDesktopBridge: false });
    server.setOnRootCheck(null);
  });
  await host.start();
  assert.equal(await waitFor(() => server.rejectedContextIds.includes(oldUniqueId)), true);
  assert.deepEqual(server.injectedPayloads, []);
});

test("CDP allows a loopback origin only while its main document is verified", async (t) => {
  const origin = "http://127.0.0.1:8080";
  const { server, host } = await cdpFixture(t, [
    { targetId: "main-local", type: "page", title: "", url: origin + "/" },
  ]);
  const info = await host.start();
  assert.equal(await waitFor(() => host.getState().capturedT3Origin === origin), true);
  const getStatus = (headers) => fetch(info.url + "/admin/status", {
    headers: { "X-T3-Hud-Token": info.adminToken, ...headers },
  });
  assert.equal((await getStatus({ Origin: origin })).headers.get("access-control-allow-origin"), origin);
  server.setPageState("main-local", { hasDesktopBridge: false });
  server.navigateTopFrame("main-local", origin + "/preview");
  assert.equal(await waitFor(() => host.getState().capturedT3Origin === null), true);
  assert.equal((await getStatus({ Origin: origin })).headers.get("access-control-allow-origin"), null);
  assert.equal((await getStatus()).status, 200);
  assert.deepEqual(server.injectedTargetIds, ["main-local"]);
});

test("CDP force reload with a successful evaluation fails if the drawer did not mount", async (t) => {
  const { server, host } = await cdpFixture(t, [
    { targetId: "main-1", type: "page", title: "", url: "t3code://app/" },
  ]);
  const info = await host.start();
  assert.equal(await waitFor(() => checkHud({ rpcFile: info.rpcInfoFile, pid: process.pid })), true);
  server.setPageState("main-1", { omitDrawerOnInject: true });
  const response = await fetch(info.url + "/admin/reload-ui", {
    method: "POST",
    headers: { "X-T3-Hud-Token": info.adminToken },
  }).then((res) => res.json());
  assert.deepEqual(response.results, [{ id: "main-1", injected: false }]);
  assert.equal(response.lastInjectError, "HUD mount incomplete");
  assert.equal(await checkHud({ rpcFile: info.rpcInfoFile, pid: process.pid }), false);
});

test("CDP startup surfaces backend load errors before publishing an RPC lease", async (t) => {
  const { server, host, pluginDir, runDir } = await cdpFixture(t, [], { backend: null });
  fs.writeFileSync(path.join(pluginDir, "backend.cjs"), "throw new Error('fixture cold backend error');\n");
  await assert.rejects(host.start(), /fixture cold backend error/);
  assert.equal(fs.existsSync(path.join(runDir, `rpc-${process.pid}.json`)), false);
  assert.equal(host.getState().url, null);
  assert.deepEqual(server.injectedPayloads, []);
});

test("an old CDP poll suspended in detach leaves the reconnected targets intact", async (t) => {
  const first = { targetId: "main-old-first", type: "page", title: "", url: "t3code://app/" };
  const second = { ...first, targetId: "main-reused" };
  const { server, host } = await cdpFixture(t, [first, second]);
  const info = await host.start();
  assert.equal(await waitFor(() => server.injectedTargetIds.length === 2), true);
  let finishOldDetach;
  server.setDetachHook((reply) => { finishOldDetach ||= reply; });
  server.removeTargets(first.targetId, second.targetId);
  assert.equal(await waitFor(() => finishOldDetach), true);
  const generation = host.getState().connGen;
  server.dropConnections();
  server.addTarget(second);
  server.setPageState(second.targetId, { uniqueId: crypto.randomUUID(), mounted: false });
  assert.equal(await waitFor(async () => host.getState().connGen > generation &&
    await checkHud({ rpcFile: info.rpcInfoFile, pid: process.pid })), true);
  finishOldDetach({});
  const status = await fetch(info.url + "/admin/status", {
    headers: { "X-T3-Hud-Token": info.adminToken },
  }).then((res) => res.json());
  assert.deepEqual(status.windows.map((w) => w.id), [second.targetId]);
  assert.equal(host.getState().targetCount, 1);
});

test("CDP CORS responds with verified desktop origin when Origin header is stripped, while rejecting disallowed origins and non-desktop targets", async (t) => {
  // 1. Verified t3code://app main window
  {
    const { host } = await cdpFixture(
      t,
      [{ targetId: "main-desktop", type: "page", title: "T3 Code", url: "t3code://app/" }],
      { backend: { hubCall: async (action, payload) => ({ ok: true, action, payload }) } }
    );
    const info = await host.start();
    assert.equal(await waitFor(() => host.getState().capturedT3Origin === "t3code://app"), true);

    const optStripped = await fetch(`${info.url}/rpc`, { method: "OPTIONS" });
    assert.equal(optStripped.status, 204);
    assert.equal(optStripped.headers.get("access-control-allow-origin"), "t3code://app");
    assert.equal(optStripped.headers.get("vary"), "Origin");
    assert.equal(optStripped.headers.get("access-control-allow-private-network"), "true");

    const postStripped = await fetch(`${info.url}/rpc`, {
      method: "POST",
      headers: { "X-T3-Hud-Token": info.rpcToken, "Content-Type": "application/json" },
      body: JSON.stringify({ method: "hubCall", args: ["ping", { stripped: true }] }),
    });
    assert.equal(postStripped.status, 200);
    assert.equal(postStripped.headers.get("access-control-allow-origin"), "t3code://app");
    assert.equal(postStripped.headers.get("vary"), "Origin");
    assert.deepEqual(await postStripped.json(), { ok: true, action: "ping", payload: { stripped: true } });

    for (const badOrigin of ["https://evil.com", "null", "t3code://other"]) {
      const optBad = await fetch(`${info.url}/rpc`, {
        method: "OPTIONS",
        headers: { Origin: badOrigin },
      });
      assert.equal(optBad.status, 204);
      assert.equal(optBad.headers.get("access-control-allow-origin"), null, `OPTIONS must reject ${badOrigin}`);

      const postBad = await fetch(`${info.url}/rpc`, {
        method: "POST",
        headers: {
          "X-T3-Hud-Token": info.rpcToken,
          "Content-Type": "application/json",
          Origin: badOrigin,
        },
        body: JSON.stringify({ method: "hubCall", args: ["ping"] }),
      });
      assert.equal(postBad.headers.get("access-control-allow-origin"), null, `POST must reject ${badOrigin}`);
    }
  }

  // 2. Verified loopback-only main window -> stripped Origin must NOT receive ACAO
  {
    const loopbackOrigin = "http://127.0.0.1:8080";
    const { host } = await cdpFixture(
      t,
      [{ targetId: "main-loopback", type: "page", title: "T3 Code", url: `${loopbackOrigin}/` }],
      { backend: { hubCall: async () => ({ ok: true }) } }
    );
    const info = await host.start();
    assert.equal(await waitFor(() => host.getState().capturedT3Origin === loopbackOrigin), true);

    const optNoOrigin = await fetch(`${info.url}/rpc`, { method: "OPTIONS" });
    assert.equal(optNoOrigin.status, 204);
    assert.equal(optNoOrigin.headers.get("access-control-allow-origin"), null);

    const postNoOrigin = await fetch(`${info.url}/rpc`, {
      method: "POST",
      headers: { "X-T3-Hud-Token": info.rpcToken, "Content-Type": "application/json" },
      body: JSON.stringify({ method: "hubCall", args: ["ping"] }),
    });
    assert.equal(postNoOrigin.status, 200);
    assert.equal(postNoOrigin.headers.get("access-control-allow-origin"), null);
  }

  // 3. No verified desktop main window -> stripped Origin must NOT receive ACAO
  {
    const { host } = await cdpFixture(
      t,
      [],
      { backend: { hubCall: async () => ({ ok: true }) } }
    );
    const info = await host.start();

    const optNoOrigin = await fetch(`${info.url}/rpc`, { method: "OPTIONS" });
    assert.equal(optNoOrigin.status, 204);
    assert.equal(optNoOrigin.headers.get("access-control-allow-origin"), null);

    const postNoOrigin = await fetch(`${info.url}/rpc`, {
      method: "POST",
      headers: { "X-T3-Hud-Token": info.rpcToken, "Content-Type": "application/json" },
      body: JSON.stringify({ method: "hubCall", args: ["ping"] }),
    });
    assert.equal(postNoOrigin.status, 200);
    assert.equal(postNoOrigin.headers.get("access-control-allow-origin"), null);
  }
});

test("CDP cold start defers bridge launch until main window verification, ignores inherited origin env, and syncs reused bridge origin", async (t) => {
  const { spawn } = require("node:child_process");
  const { readLiveBridgeRecord } = require("../src/hud-runtime.cjs");
  const srcDir = path.resolve(__dirname, "../src");
  const bridgePids = new Set();
  const prevDesktopEnv = process.env.T3_DESKTOP_ORIGIN;
  const prevLoopbackEnv = process.env.T3_ALLOWED_LOOPBACK_ORIGIN;

  t.after(() => {
    if (prevDesktopEnv === undefined) delete process.env.T3_DESKTOP_ORIGIN;
    else process.env.T3_DESKTOP_ORIGIN = prevDesktopEnv;
    if (prevLoopbackEnv === undefined) delete process.env.T3_ALLOWED_LOOPBACK_ORIGIN;
    else process.env.T3_ALLOWED_LOOPBACK_ORIGIN = prevLoopbackEnv;
    for (const pid of bridgePids) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  });

  function setupRealBridgePlugin(pluginDir) {
    fs.copyFileSync(path.join(srcDir, "hub-bridge.cjs"), path.join(pluginDir, "hub-bridge.cjs"));
    fs.copyFileSync(path.join(srcDir, "hud-runtime.cjs"), path.join(pluginDir, "hud-runtime.cjs"));
    fs.writeFileSync(
      path.join(pluginDir, "backend.cjs"),
      "module.exports = { hubCall: async (action, payload) => ({ ok: true, action, payload }) };\n"
    );
  }

  // Case 1: t3code://app cold start while parent process inherited conflicting T3_DESKTOP_ORIGIN=t3code-dev://app
  {
    process.env.T3_DESKTOP_ORIGIN = "t3code-dev://app";
    process.env.T3_ALLOWED_LOOPBACK_ORIGIN = "http://127.0.0.1:4100";
    const { server, host, pluginDir, runDir } = await cdpFixture(
      t,
      [{ targetId: "main-prod", type: "page", title: "T3 Code", url: "t3code://app/" }],
      {
        skipSidecarBridge: false,
        backend: { hubCall: async (action, payload) => ({ ok: true, action, payload }) },
      }
    );
    setupRealBridgePlugin(pluginDir);
    server.setPageState("main-prod", { hasRoot: false });
    const info = await host.start();

    // Before #root mounts, bridge must NOT be launched prematurely
    await new Promise((r) => setTimeout(r, 140));
    assert.equal(readLiveBridgeRecord(runDir, process.pid), null, "sidecar bridge must wait for verified main window");

    // Mount #root -> host verifies t3code://app and spawns bridge with exact verified origin
    server.setPageState("main-prod", { hasRoot: true });
    assert.equal(await waitFor(() => server.injectedTargetIds.length >= 1 && Boolean(readLiveBridgeRecord(runDir, process.pid)), 5000), true);
    const bridge = readLiveBridgeRecord(runDir, process.pid).record;
    bridgePids.add(bridge.pid);
    assert.equal(bridge.desktopOrigin, "t3code://app");
    assert.equal(bridge.loopbackOrigin, null);

    // Both /rpc and /hub-rpc must respond with t3code://app (never inherited t3code-dev://app)
    for (const reqSpec of [
      { url: `${info.url}/rpc`, token: info.rpcToken, body: { method: "hubCall", args: ["ping", { via: "rpc" }] } },
      { url: `${bridge.url}/hub-rpc`, token: bridge.token, body: { action: "ping", payload: { via: "bridge" } } },
    ]) {
      const opt = await fetch(reqSpec.url, { method: "OPTIONS" });
      assert.equal(opt.status, 204);
      assert.equal(opt.headers.get("access-control-allow-origin"), "t3code://app");
      assert.equal(opt.headers.get("vary"), "Origin");

      const post = await fetch(reqSpec.url, {
        method: "POST",
        headers: { "X-T3-Hud-Token": reqSpec.token, "Content-Type": "application/json" },
        body: JSON.stringify(reqSpec.body),
      });
      assert.equal(post.status, 200);
      assert.equal(post.headers.get("access-control-allow-origin"), "t3code://app");
      assert.equal(post.headers.get("vary"), "Origin");

      // Inherited loopback env must NOT leak into allowed CORS origins
      const badLoop = await fetch(reqSpec.url, {
        method: "OPTIONS",
        headers: { Origin: "http://127.0.0.1:4100" },
      });
      assert.equal(badLoop.headers.get("access-control-allow-origin"), null);
    }
  }

  // Case 2: t3code-dev://app cold start with NO T3_DESKTOP_ORIGIN in environment
  {
    delete process.env.T3_DESKTOP_ORIGIN;
    delete process.env.T3_ALLOWED_LOOPBACK_ORIGIN;
    const { server, host, pluginDir, runDir } = await cdpFixture(
      t,
      [{ targetId: "main-dev", type: "page", title: "T3 Code (Beta)", url: "t3code-dev://app/" }],
      {
        skipSidecarBridge: false,
        backend: { hubCall: async (action, payload) => ({ ok: true, action, payload }) },
      }
    );
    setupRealBridgePlugin(pluginDir);
    const info = await host.start();
    assert.equal(await waitFor(() => server.injectedTargetIds.length >= 1 && Boolean(readLiveBridgeRecord(runDir, process.pid)), 5000), true);
    const bridge = readLiveBridgeRecord(runDir, process.pid).record;
    bridgePids.add(bridge.pid);
    assert.equal(bridge.desktopOrigin, "t3code-dev://app");

    for (const reqSpec of [
      { url: `${info.url}/rpc`, token: info.rpcToken, body: { method: "hubCall", args: ["ping", { via: "rpc" }] } },
      { url: `${bridge.url}/hub-rpc`, token: bridge.token, body: { action: "ping", payload: { via: "bridge" } } },
    ]) {
      const opt = await fetch(reqSpec.url, { method: "OPTIONS" });
      assert.equal(opt.status, 204);
      assert.equal(opt.headers.get("access-control-allow-origin"), "t3code-dev://app");
      assert.equal(opt.headers.get("vary"), "Origin");

      const post = await fetch(reqSpec.url, {
        method: "POST",
        headers: { "X-T3-Hud-Token": reqSpec.token, "Content-Type": "application/json" },
        body: JSON.stringify(reqSpec.body),
      });
      assert.equal(post.status, 200);
      assert.equal(post.headers.get("access-control-allow-origin"), "t3code-dev://app");
      assert.equal(post.headers.get("vary"), "Origin");
    }
  }

  // Case 3: Reusing a live bridge with mismatched desktopOrigin syncs it via authenticated /reload before injection
  {
    delete process.env.T3_DESKTOP_ORIGIN;
    delete process.env.T3_ALLOWED_LOOPBACK_ORIGIN;
    const { server, host, pluginDir, runDir } = await cdpFixture(
      t,
      [{ targetId: "main-dev-reuse", type: "page", title: "T3 Code (Beta)", url: "t3code-dev://app/" }],
      {
        skipSidecarBridge: false,
        backend: { hubCall: async (action, payload) => ({ ok: true, action, payload }) },
      }
    );
    setupRealBridgePlugin(pluginDir);

    // Pre-start a live bridge configured for t3code://app
    const preBridge = spawn(process.execPath, [path.join(pluginDir, "hub-bridge.cjs")], {
      env: {
        HOME: pluginDir,
        PATH: process.env.PATH || "/usr/bin:/bin",
        T3_HUD_DIR: pluginDir,
        T3_WATCH_PID: String(process.pid),
        T3_DESKTOP_ORIGIN: "t3code://app",
      },
      stdio: "ignore",
    });
    bridgePids.add(preBridge.pid);
    assert.equal(await waitFor(() => readLiveBridgeRecord(runDir, process.pid)?.record?.pid === preBridge.pid, 4000), true);
    assert.equal(readLiveBridgeRecord(runDir, process.pid).record.desktopOrigin, "t3code://app");

    await host.start();
    assert.equal(await waitFor(() => server.injectedTargetIds.length >= 1, 5000), true);

    const synced = readLiveBridgeRecord(runDir, process.pid).record;
    assert.equal(synced.pid, preBridge.pid, "existing healthy bridge should be synced in place");
    assert.equal(synced.desktopOrigin, "t3code-dev://app");
    const optSynced = await fetch(`${synced.url}/hub-rpc`, { method: "OPTIONS" });
    assert.equal(optSynced.headers.get("access-control-allow-origin"), "t3code-dev://app");
    assert.equal(optSynced.headers.get("vary"), "Origin");
  }

  // Case 4: Stale bridge record with recycled PID belonging to an unrelated live process must NEVER be signaled
  {
    delete process.env.T3_DESKTOP_ORIGIN;
    delete process.env.T3_ALLOWED_LOOPBACK_ORIGIN;
    const { server, host, pluginDir, runDir } = await cdpFixture(
      t,
      [{ targetId: "main-dev-recycled", type: "page", title: "T3 Code (Beta)", url: "t3code-dev://app/" }],
      {
        skipSidecarBridge: false,
        backend: { hubCall: async (action, payload) => ({ ok: true, action, payload }) },
      }
    );
    setupRealBridgePlugin(pluginDir);

    // Reserve an unused loopback port that immediately refuses connections
    const probeServer = http.createServer();
    await new Promise((r) => probeServer.listen(0, "127.0.0.1", r));
    const closedPort = probeServer.address().port;
    await new Promise((r) => probeServer.close(r));

    // Spawn an unrelated live process whose PID appears in the stale bridge record
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    bridgePids.add(unrelated.pid);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, `hub-bridge-${process.pid}.json`),
      JSON.stringify({
        url: `http://127.0.0.1:${closedPort}`,
        token: "a".repeat(64),
        pid: unrelated.pid,
        watchPid: process.pid,
        desktopOrigin: "t3code://app",
        loopbackOrigin: null,
      }),
      { mode: 0o600 }
    );

    const origKill = process.kill;
    const nonZeroSignals = [];
    process.kill = function patchedKill(pid, signal) {
      if (signal !== 0) nonZeroSignals.push({ pid, signal });
      return origKill.call(process, pid, signal);
    };
    try {
      await host.start();
      assert.equal(
        await waitFor(
          () => server.injectedTargetIds.length >= 1 && readLiveBridgeRecord(runDir, process.pid)?.record?.pid !== unrelated.pid,
          5000
        ),
        true
      );
    } finally {
      process.kill = origKill;
    }

    const fresh = readLiveBridgeRecord(runDir, process.pid).record;
    bridgePids.add(fresh.pid);
    assert.deepEqual(nonZeroSignals, [], "must never send non-zero kill signals to a PID from a stale bridge record");
    assert.equal(unrelated.exitCode, null);
    assert.equal(unrelated.signalCode, null);
    assert.doesNotThrow(() => process.kill(unrelated.pid, 0), "unrelated process must remain alive");
    assert.notEqual(fresh.pid, unrelated.pid);
    assert.equal(fresh.desktopOrigin, "t3code-dev://app");

    const optFresh = await fetch(`${fresh.url}/hub-rpc`, { method: "OPTIONS" });
    assert.equal(optFresh.status, 204);
    assert.equal(optFresh.headers.get("access-control-allow-origin"), "t3code-dev://app");
    assert.equal(optFresh.headers.get("vary"), "Origin");
  }
});
