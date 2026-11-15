"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const bridge = {
  getThreadStats: (threadHint) => ipcRenderer.invoke("t3hud:get-thread-stats", threadHint),
  priceRemoteProjection: (payload) => ipcRenderer.invoke("t3hud:price-remote-projection", payload),
  getGitGraph: (threadHint, maxCommits, fallbackCwd) =>
    ipcRenderer.invoke("t3hud:get-git-graph", threadHint, maxCommits, fallbackCwd),
  getCommitDetail: (threadHint, commitHash, fallbackCwd) =>
    ipcRenderer.invoke("t3hud:get-commit-detail", threadHint, commitHash, fallbackCwd),
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
