"use strict";

const { contextBridge, ipcRenderer } = require("electron");

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

// The main-world WebSocket bridge lives in renderer-ui.js so UI hot reloads
// can upgrade it without recreating the window or interrupting active runs.
