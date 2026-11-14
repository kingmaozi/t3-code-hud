"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const bridge = {
  getThreadStats: (threadHint) => ipcRenderer.invoke("t3hud:get-thread-stats", threadHint),
  getGitGraph: (threadHint, maxCommits) =>
    ipcRenderer.invoke("t3hud:get-git-graph", threadHint, maxCommits),
  getCommitDetail: (threadHint, commitHash) =>
    ipcRenderer.invoke("t3hud:get-commit-detail", threadHint, commitHash),
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
