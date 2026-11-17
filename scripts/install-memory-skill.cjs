"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

// Exact shipped legacy template only. Never replace a user's edited skill.
const LEGACY_SHA256 = "d3d77e8c0a8c7e477a606dce3506d7f7aceddf959607c461f179ca58ae84859e";
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function hasLinkedPath(file, homeDir) {
  for (let current = file; current !== path.dirname(homeDir); current = path.dirname(current)) {
    try { if (fs.lstatSync(current).isSymbolicLink()) return true; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (current === homeDir || current === path.dirname(current)) break;
  }
  return false;
}

function installMemorySkill({ homeDir = os.homedir(), templatePath = path.join(__dirname, "..", "skills", "powercontext-memory", "SKILL.md") } = {}) {
  const destination = path.join(homeDir, ".agents", "skills", "powercontext-memory", "SKILL.md");
  const template = fs.readFileSync(templatePath);
  // Preserve links and custom shared roots as well as custom skill text.
  if (hasLinkedPath(destination, homeDir)) return { status: "preserved", reason: "symlink" };
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const lockPath = destination + ".install.lock";
  let lock;
  try { lock = fs.openSync(lockPath, "wx", 0o600); }
  catch (error) {
    if (error.code === "EEXIST") return { status: "preserved", reason: "installation_in_progress" };
    throw error;
  }
  try { return installLocked({ homeDir, destination, template }); }
  finally { fs.closeSync(lock); fs.unlinkSync(lockPath); }
}

function installLocked({ homeDir, destination, template }) {
  let previous;
  let identity;
  if (hasLinkedPath(destination, homeDir)) return { status: "preserved", reason: "symlink" };
  try { identity = fs.lstatSync(destination); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  try { previous = fs.readFileSync(destination); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (previous && sha(previous) === sha(template)) return { status: "current" };
  if (previous && sha(previous) !== LEGACY_SHA256) return { status: "preserved", reason: "custom_skill" };
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  let backup;
  if (previous) {
    const backupDir = path.join(homeDir, ".t3", "hub", "backups");
    if (hasLinkedPath(backupDir, homeDir)) return { status: "preserved", reason: "symlink" };
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    backup = path.join(backupDir, `powercontext-memory-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.md`);
    fs.writeFileSync(backup, previous, { mode: 0o600, flag: "wx" });
  }
  const temp = destination + `.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    fs.writeFileSync(temp, template, { mode: 0o600, flag: "wx" });
    if (hasLinkedPath(destination, homeDir)) return { status: "preserved", reason: "symlink" };
    if (previous) {
      let current, currentIdentity;
      try { currentIdentity = fs.lstatSync(destination); current = fs.readFileSync(destination); }
      catch { return { status: "preserved", reason: "changed_during_install" }; }
      if (currentIdentity.dev !== identity.dev || currentIdentity.ino !== identity.ino || !previous.equals(current)) {
        return { status: "preserved", reason: "changed_during_install" };
      }
      fs.renameSync(temp, destination);
    } else {
      // Creating a missing skill must never replace a concurrently created file.
      try { fs.linkSync(temp, destination); }
      catch (error) {
        if (error.code === "EEXIST") return { status: "preserved", reason: "changed_during_install" };
        throw error;
      }
    }
  } finally {
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return { status: previous ? "updated" : "installed", backedUp: !!backup };
}

module.exports = { installMemorySkill };
if (require.main === module) {
  try { console.log(JSON.stringify(installMemorySkill())); }
  catch (error) { console.error("Memory skill installation failed:", error.code || "unavailable"); process.exitCode = 1; }
}
