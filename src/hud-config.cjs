"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readJsonFileStrict, writeTextAtomic } = require("./hub-host-settings.cjs");

function hudPluginDir() {
  return process.env.T3_HUD_DIR || path.join(os.homedir(), ".t3", "hud-plugin");
}

function readHudConfig(file) {
  return readJsonFileStrict(file).data;
}

// CLI, Electron main and the Hub bridge can all save this file. SQLite's OS
// lock serializes read/modify/write and releases even when a writer exits.
function updateHudConfig(file, edit, beforeSave = () => {}) {
  const { DatabaseSync } = require("node:sqlite");
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(dir, ".config-write-lock.sqlite");
  const fd = fs.openSync(lockPath, fs.constants.O_APPEND | fs.constants.O_CREAT |
    fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error("Invalid HUD config lock");
  } finally {
    fs.closeSync(fd);
  }
  const db = new DatabaseSync(lockPath);
  try {
    db.exec("PRAGMA busy_timeout=750; BEGIN IMMEDIATE");
    const current = readHudConfig(file);
    const next = edit(current);
    const rollback = beforeSave(current, next);
    try {
      if (JSON.stringify(next) !== JSON.stringify(current)) {
        writeTextAtomic(file, JSON.stringify(next, null, 2) + "\n");
      }
    } catch (error) {
      try { rollback?.(); } catch {
        throw new Error("HUD config save failed and shell profile rollback could not be completed");
      }
      throw error;
    }
  } finally {
    db.close();
  }
}

function updateHudLanguage(file, patch) {
  updateHudConfig(file, (current) => {
    const next = { defaultLang: "zh", ...current };
    if (patch.defaultLang === "zh" || patch.defaultLang === "en") next.defaultLang = patch.defaultLang;
    if (["zh", "en", "auto", null].includes(patch.userLang)) next.userLang = patch.userLang;
    const updatedAt = Number(patch.langUpdatedAt);
    if (Number.isFinite(updatedAt) && updatedAt > 0) next.langUpdatedAt = Math.round(updatedAt);
    return next;
  });
}

module.exports = { hudPluginDir, readHudConfig, updateHudConfig, updateHudLanguage };
