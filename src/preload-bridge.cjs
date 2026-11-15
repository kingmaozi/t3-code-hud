"use strict";

const { contextBridge, ipcRenderer, webFrame } = require("electron");

const bridge = {
  getThreadStats: (threadHint) => ipcRenderer.invoke("t3hud:get-thread-stats", threadHint),
  priceRemoteProjection: (payload) => ipcRenderer.invoke("t3hud:price-remote-projection", payload),
  getGitGraph: (threadHint, maxCommits, fallbackCwd) =>
    ipcRenderer.invoke("t3hud:get-git-graph", threadHint, maxCommits, fallbackCwd),
  getCommitDetail: (threadHint, commitHash, fallbackCwd) =>
    ipcRenderer.invoke("t3hud:get-commit-detail", threadHint, commitHash, fallbackCwd),
  getRemoteGitGraph: (bundle) => ipcRenderer.invoke("t3hud:get-remote-git-graph", bundle),
  getRemoteCommitDetail: (req) => ipcRenderer.invoke("t3hud:get-remote-commit-detail", req),
  getConfig: () => ipcRenderer.invoke("t3hud:get-config"),
  setConfig: (patch) => ipcRenderer.invoke("t3hud:set-config", patch),
};

try {
  if (process.contextIsolated) {
    contextBridge.exposeInMainWorld("__t3HudBridge", bridge);
  } else {
    window.__t3HudBridge = bridge;
  }
} catch {
  // Ignore if already exposed
}

// Passive main-world T3 Connect WebSocket RPC bridge. T3 Connect multiplexes
// every remote environment over WebSockets in the main world; this tracks them
// so the HUD can pull remote git metadata straight from the relay. Wrapped in
// try/catch so non-Electron Node contexts (unit tests) never crash on require.
(function installT3HudWsRpc() {
  try {
    if (!webFrame || typeof webFrame.executeJavaScript !== "function") return;
    const injected = `(function () {
      if (window.__t3HudWsRpcInstalled) return;
      window.__t3HudWsRpcInstalled = true;
      var OrigWS = window.WebSocket;
      if (typeof OrigWS !== "function" || OrigWS.__t3HudTracked) return;
      var openSockets = new Set();
      var socketByEnv = new Map();
      var pending = new Map();
      var seq = 0;
      var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

      function scanForEnv(ws, node, depth) {
        if (!ws || !node || typeof node !== "object" || depth > 6) return;
        var id = null;
        if (typeof node.environmentId === "string" && UUID_RE.test(node.environmentId)) {
          if (node.serverVersion || node.capabilities || node.projects || node.environment) {
            id = node.environmentId;
          }
        }
        if (!id && node.environment && typeof node.environment === "object" && typeof node.environment.environmentId === "string" && UUID_RE.test(node.environment.environmentId)) {
          id = node.environment.environmentId;
        }
        if (id) socketByEnv.set(id, ws);
        for (var k in node) {
          var v = node[k];
          if (v && typeof v === "object") scanForEnv(ws, v, depth + 1);
        }
      }

      function unwrapExitValue(exit) {
        var val = exit ? exit.value : undefined;
        if (val && typeof val === "object" && val._tag === "Success" && "value" in val) return val.value;
        return val;
      }

      function handleFrames(ws, text) {
        if (!text) return;
        var parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          return;
        }
        var frames = Array.isArray(parsed) ? parsed : [parsed];
        for (var i = 0; i < frames.length; i++) {
          var msg = frames[i];
          if (!msg || typeof msg !== "object") continue;
          scanForEnv(ws, msg, 0);
          if (msg._tag === "Exit" && msg.requestId != null) {
            var id = String(msg.requestId);
            var entry = pending.get(id);
            if (entry) {
              pending.delete(id);
              try { clearTimeout(entry.timer); } catch {}
              var exit = msg.exit;
              if (exit && exit._tag === "Success") {
                entry.resolve({ ok: true, value: unwrapExitValue(exit) });
              } else {
                var err = (exit && (exit.message || exit.error)) || "RPC Failure";
                entry.resolve({ ok: false, error: String(err) });
              }
            }
          }
        }
      }

      function sendTagged(ws, tag, payload, timeoutMs) {
        return new Promise(function (resolve) {
          var id = String(990000000 + (++seq));
          var timer = setTimeout(function () {
            pending.delete(id);
            resolve({ ok: false, error: "timeout" });
          }, timeoutMs);
          pending.set(id, { resolve: resolve, timer: timer });
          try {
            ws.send(JSON.stringify({ _tag: "Request", id: id, tag: tag, payload: payload, headers: [] }));
          } catch (e) {
            pending.delete(id);
            try { clearTimeout(timer); } catch {}
            resolve({ ok: false, error: String((e && e.message) || e) });
          }
        });
      }

      function isLoopbackSocket(ws) {
        try {
          return /127\\.0\\.0\\.1|localhost/.test(String((ws && ws.url) || ""));
        } catch {
          return false;
        }
      }

      function pickWs(envId) {
        var ws = envId ? socketByEnv.get(envId) : null;
        if (ws && ws.readyState === 1) return ws;
        if (!envId) return null;
        var nonLoop = [];
        openSockets.forEach(function (s) {
          if (s && s.readyState === 1 && !isLoopbackSocket(s)) nonLoop.push(s);
        });
        if (nonLoop.length === 1) return nonLoop[0];
        return null;
      }

      window.__t3HudRemoteRpc = function (environmentId, tag, payload, timeoutMs) {
        timeoutMs = timeoutMs || 4500;
        var envId = String(environmentId || "");
        var ws = pickWs(envId);
        if (ws) return sendTagged(ws, tag, payload, timeoutMs);
        var open = [];
        openSockets.forEach(function (s) {
          if (s && s.readyState === 1) open.push(s);
        });
        if (!open.length) return Promise.resolve({ ok: false, error: "no open WebSocket" });
        open.sort(function (a, b) {
          return (isLoopbackSocket(a) ? 1 : 0) - (isLoopbackSocket(b) ? 1 : 0);
        });
        return Promise.all(
          open.map(function (s) {
            return sendTagged(s, "server.getConfig", {}, 1200).catch(function () {
              return { ok: false };
            });
          })
        ).then(function () {
          var retry = pickWs(envId);
          if (retry) return sendTagged(retry, tag, payload, timeoutMs);
          return { ok: false, error: "environment not mapped" };
        });
      };

      class T3HudTrackedWebSocket extends OrigWS {
        constructor(url, protocols) {
          super(url, protocols);
          var self = this;
          openSockets.add(self);
          self.addEventListener("open", function () {
            openSockets.add(self);
          });
          self.addEventListener("close", function () {
            openSockets.delete(self);
          });
          self.addEventListener("message", function (ev) {
            var d = ev && ev.data;
            if (typeof d === "string") {
              handleFrames(self, d);
            } else if (typeof ArrayBuffer !== "undefined" && d instanceof ArrayBuffer) {
              try {
                handleFrames(self, new TextDecoder().decode(d));
              } catch {}
            } else if (d && typeof d.arrayBuffer === "function") {
              d.arrayBuffer()
                .then(function (buf) {
                  try {
                    handleFrames(self, new TextDecoder().decode(buf));
                  } catch {}
                })
                .catch(function () {});
            }
          });
        }
      }
      T3HudTrackedWebSocket.CONNECTING = OrigWS.CONNECTING;
      T3HudTrackedWebSocket.OPEN = OrigWS.OPEN;
      T3HudTrackedWebSocket.CLOSING = OrigWS.CLOSING;
      T3HudTrackedWebSocket.CLOSED = OrigWS.CLOSED;
      T3HudTrackedWebSocket.__t3HudTracked = true;
      window.WebSocket = T3HudTrackedWebSocket;
    })();`;
    const maybe = webFrame.executeJavaScript(injected, false);
    if (maybe && typeof maybe.then === "function") maybe.catch(() => {});
  } catch {
    // No webFrame (unit tests) or no Electron: skip silently.
  }
})();
