"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);

function safeMkdir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function readJsonFile(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJsonFile(file, obj) {
  safeMkdir(path.dirname(file));
  const tmp = file + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  fs.renameSync(tmp, file);
}
function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => path.join(dir, e.name));
  } catch { return []; }
}
function dirExists(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function fileExists(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function lstatSafe(p) { try { return fs.lstatSync(p); } catch { return null; } }
const CANONICAL_HOSTS = ["antigravity", "muse", "codex", "pi", "claude"];
function normalizeAgentHost(input) {
  if (typeof input !== "string") return null;
  const s = input.trim().toLowerCase();
  if (s === "agy" || s === "antigravity") return "antigravity";
  if (CANONICAL_HOSTS.includes(s)) return s;
  if (s === "all") return "all";
  return null;
}
function agyRootFor(homeDir) { return path.join(homeDir, ".t3", "userdata", "providers", "antigravity"); }
function agyConfigFilesFor(homeDir) {
  const out = [];
  try { for (const inst of listDirs(agyRootFor(homeDir))) { const f = path.join(inst, "config", "mcp_config.json"); if (fileExists(f)) out.push(f); } } catch {}
  out.sort((a, b) => { try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; } });
  return out;
}
function primaryAgyConfigFileFor(homeDir) {
  const files = agyConfigFilesFor(homeDir);
  if (files.length) return files[0];
  const insts = listDirs(agyRootFor(homeDir));
  if (insts.length) { insts.sort((a, b) => { try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; } }); return path.join(insts[0], "config", "mcp_config.json"); }
  return path.join(agyRootFor(homeDir), "default", "config", "mcp_config.json");
}
function primaryAgySkillsDirFor(homeDir) { return path.join(path.dirname(primaryAgyConfigFileFor(homeDir)), "skills"); }

function parseSkillMd(skillFile) {
  let raw = "";
  try { raw = fs.readFileSync(skillFile, "utf8"); } catch { return { name: "", description: "" }; }
  let name = "", description = "";
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fm) {
    const block = fm[1];
    const nd = block.match(/^name:\s*(.+)$/m);
    const dd = block.match(/^description:\s*(.+)$/m);
    if (nd) name = nd[1].trim().replace(/^["']|["']$/g, "");
    if (dd) description = dd[1].trim().replace(/^["']|["']$/g, "");
  }
  if (!description) {
    const body = fm ? raw.slice(fm[0].length) : raw;
    for (const line of body.split("\n")) {
      const t = line.trim();
      if (t && !t.startsWith("#")) { description = t.slice(0, 200); break; }
    }
  }
  if (!name) {
    const h = raw.match(/^#\s*(.+)$/m);
    if (h) name = h[1].trim().slice(0, 80);
  }
  return { name, description };
}

function cpDirRecursive(src, dest, destRoot = dest) {
  if (!dirExists(src)) return false;
  safeMkdir(dest);
  for (const entry of fs.readdirSync(src)) {
    if (entry === ".git") continue;
    const s = path.join(src, entry), d = path.join(dest, entry);
    const st = lstatSafe(s);
    if (!st) continue;
    // Imported bundles must be self-contained. Never copy links that can later
    // redirect SKILL.md, marker writes or recursive copies outside the store.
    if (st.isSymbolicLink()) continue;
    assertSafeFsPath(destRoot, d);
    if (st.isDirectory()) cpDirRecursive(s, d, destRoot);
    else fs.copyFileSync(s, d);
  }
  return true;
}

const MANAGED_DIR_MARKER = ".t3-hub-managed";
const MANAGED_CMD_MARKER = "<!-- t3-hub-managed-skill -->";

function isManagedDir(p) {
  const st = lstatSafe(p);
  return Boolean(st && st.isDirectory() && !st.isSymbolicLink() && fileExists(path.join(p, MANAGED_DIR_MARKER)));
}
function stampManagedDir(p) {
  try {
    if (dirExists(p) && !fileExists(path.join(p, MANAGED_DIR_MARKER))) {
      fs.writeFileSync(path.join(p, MANAGED_DIR_MARKER), "t3-hub-managed\n", "utf8");
    }
  } catch {}
}
function backupPathFor(target) {
  const ts = Date.now();
  let bak = String(target) + ".bak-t3hub-" + ts;
  let n = 0;
  while (lstatSafe(bak)) { n += 1; bak = String(target) + ".bak-t3hub-" + ts + "-" + n; }
  return bak;
}
function backupUnmanagedDir(target) {
  const bak = backupPathFor(target);
  try { fs.renameSync(target, bak); } catch (e) {
    if (e.code !== "EXDEV") throw e;
    fs.cpSync(target, bak, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    fs.rmSync(target, { recursive: true });
  }
  return bak;
}
function backupUnmanagedFile(target) {
  const bak = backupPathFor(target);
  try { fs.renameSync(target, bak); } catch (e) {
    if (e.code !== "EXDEV") throw e;
    fs.copyFileSync(target, bak, fs.constants.COPYFILE_EXCL);
    fs.unlinkSync(target);
  }
  return bak;
}
function isHubManagedSymlink(p, hubDir) {
  const st = lstatSafe(p);
  if (!st || !st.isSymbolicLink()) return false;
  const target = path.resolve(path.dirname(p), fs.readlinkSync(p));
  const relative = path.relative(path.resolve(hubDir), target);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}
function assertSafeSkillId(id) {
  if (typeof id !== "string") throw new Error("invalid skill id");
  if (id === "." || id === "..") throw new Error("invalid skill id");
  if (id.includes("\0") || id.includes("/") || id.includes("\\")) throw new Error("invalid skill id");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)) throw new Error("invalid skill id");
  if (id.includes("..")) throw new Error("invalid skill id");
}
function assertContained(parentDir, childPath) {
  assertSafeFsPath(parentDir, childPath, { allowLeafSymlink: true });
}
// Shared store invariant: lexical containment, no symlink ancestors, and real
// containment of existing parents. A leaf link may only be renamed/unlinked.
function assertSafeFsPath(baseDir, targetPath, { allowLeafSymlink = false } = {}) {
  const base = path.resolve(baseDir), target = path.resolve(targetPath);
  const inside = (root, p) => p !== root && p.startsWith(root + path.sep);
  if (!inside(base, target)) throw new Error("unsafe path: escapes parent");
  let current = target;
  while (true) {
    let st;
    try { st = fs.lstatSync(current); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (st?.isSymbolicLink() && !(current === target && allowLeafSymlink)) throw new Error("unsafe path: symbolic link");
    if (current === base) break;
    current = path.dirname(current);
  }
  if (fs.existsSync(base) && fs.existsSync(path.dirname(target))) {
    const realBase = fs.realpathSync(base), realParent = fs.realpathSync(path.dirname(target));
    // A flat store's direct child has parent === base; the target is always strict.
    if (realParent !== realBase && !inside(realBase, realParent)) throw new Error("unsafe path: real parent escapes store");
    const st = lstatSafe(target);
    if (st && !st.isSymbolicLink() && !inside(realBase, fs.realpathSync(target))) throw new Error("unsafe path: real target escapes store");
  }
  return target;
}
function packageDirectoryName(id) {
  if (typeof id !== "string") throw new Error("invalid package id");
  const parts = id.split("/");
  if (parts.length < 1 || parts.length > 2 || parts.some(p => !/^[A-Za-z0-9_.-]{1,255}$/.test(p) || p === "." || p === ".." || p.startsWith("-"))) throw new Error("invalid package id");
  return parts.join("__");
}
function isHubManagedCmdFile(p) {
  const st = lstatSafe(p);
  if (!st) return false;
  if (st.isSymbolicLink()) return true;
  if (st.isFile()) {
    try { return fs.readFileSync(p, "utf8").includes(MANAGED_CMD_MARKER); } catch { return false; }
  }
  return false;
}
function safeRemoveCmdFile(p, hubDir) {
  const st = lstatSafe(p);
  if (!st) return false;
  if (st.isSymbolicLink()) { if (!isHubManagedSymlink(p, hubDir)) return false; fs.unlinkSync(p); return true; }
  if (st.isFile()) {
    if (isHubManagedCmdFile(p)) { try { fs.unlinkSync(p); } catch {} return true; }
    return false;
  }
  return false;
}
function safeWriteCmdFile(target, content) {
  const st = lstatSafe(target);
  if (st) {
    if (st.isSymbolicLink()) { fs.renameSync(target, backupPathFor(target)); }
    else if (st.isFile()) { if (!isHubManagedCmdFile(target)) return false; }
    else if (st.isDirectory()) { return false; }
  }
  safeMkdir(path.dirname(target));
  const stamped = String(content).includes(MANAGED_CMD_MARKER) ? String(content) : MANAGED_CMD_MARKER + "\n" + String(content);
  fs.writeFileSync(target, stamped, "utf8");
  return true;
}
function clearIncompleteCanonical(dest, hubDir) {
  const st = lstatSafe(dest);
  if (!st) return;
  if (st.isSymbolicLink()) {
    if (hubDir && isHubManagedSymlink(dest, hubDir)) fs.unlinkSync(dest);
    else fs.renameSync(dest, backupPathFor(dest));
    return;
  }
  if (st.isFile()) {
    backupUnmanagedFile(dest);
    return;
  }
  if (st.isDirectory()) {
    if (isManagedDir(dest)) { fs.rmSync(dest, { recursive: true, force: true }); return; }
    const entries = fs.readdirSync(dest);
    if (entries.length === 0) fs.rmSync(dest, { recursive: true, force: true });
    else backupUnmanagedDir(dest);
  }
}
function ensureSymlink(target, linkPath, hubDir) {
  safeMkdir(path.dirname(linkPath));
  const st = lstatSafe(linkPath);
  if (st) {
    if (st.isSymbolicLink()) {
      try { if (fs.readlinkSync(linkPath) === target) return; } catch {}
      if (isHubManagedSymlink(linkPath, hubDir)) fs.unlinkSync(linkPath);
      else fs.renameSync(linkPath, backupPathFor(linkPath));
    } else if (st.isDirectory()) {
      if (isManagedDir(linkPath)) {
        fs.rmSync(linkPath, { recursive: true, force: true });
      } else if (target && !dirExists(target)) {
        safeMkdir(path.dirname(target));
        cpDirRecursive(linkPath, target);
        stampManagedDir(target);
        fs.rmSync(linkPath, { recursive: true, force: true });
      } else {
        backupUnmanagedDir(linkPath);
      }
    } else {
      backupUnmanagedFile(linkPath);
      try { if (lstatSafe(linkPath)) fs.unlinkSync(linkPath); } catch {}
    }
  }
  fs.symlinkSync(target, linkPath, "dir");
}

function removePath(p, canonicalPath, hubDir) {
  const st = lstatSafe(p);
  if (!st) return;
  if (st.isSymbolicLink()) { if (isHubManagedSymlink(p, hubDir)) fs.unlinkSync(p); return; }
  if (st.isFile()) { backupUnmanagedFile(p); return; }
  if (st.isDirectory()) {
    if (isManagedDir(p)) { fs.rmSync(p, { recursive: true, force: true }); return; }
    if (canonicalPath && !dirExists(canonicalPath)) {
      safeMkdir(path.dirname(canonicalPath));
      cpDirRecursive(p, canonicalPath);
      stampManagedDir(canonicalPath);
      fs.rmSync(p, { recursive: true, force: true });
      return;
    }
    backupUnmanagedDir(p);
  }
}

function findSkillDirsRecursive(root, maxDepth = 4) {
  const out = [];
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    try { assertSafeFsPath(path.dirname(root), dir); } catch { return; }
    if (!dirExists(dir)) return;
    try { assertSafeFsPath(dir, path.join(dir, "SKILL.md")); if (fileExists(path.join(dir, "SKILL.md"))) out.push(dir); } catch {}
    if (depth >= maxDepth) return;
    for (const child of listDirs(dir)) {
      if (path.basename(child) === ".git") continue;
      walk(child, depth + 1);
    }
  }
  walk(root, 0);
  return out;
}

function parseGitHubInput(repoInput, opts = {}) {
  if (typeof repoInput !== "string") return null;
  const input = repoInput.trim();
  if (!input) return null;
  if (/[;\0\n\r$`&|\\<>(){}!'"*?~]/.test(input)) return null;
  if (input.startsWith("-")) return null;
  if (input.startsWith("file://")) {
    try {
      const p = decodeURIComponent(new URL(input).pathname);
      const base = path.basename(p.replace(/\/$/, ""));
      try { packageDirectoryName(base); } catch { return null; }
      return { owner: "local", repo: base, subpath: "", cloneUrl: p, isLocal: true, pkgId: "local__" + base };
    } catch { return null; }
  }
  if (path.isAbsolute(input) || input.startsWith("./") || input.startsWith("../") || input.startsWith("~/")) {
    const p = input.startsWith("~/") ? path.join(os.homedir(), input.slice(2)) : input;
    const base = path.basename(path.resolve(p).replace(/\/$/, ""));
    try { packageDirectoryName(base); } catch { return null; }
    return { owner: "local", repo: base, subpath: "", cloneUrl: path.resolve(p), isLocal: true, pkgId: "local__" + base };
  }
  const gh = input.match(/^https:\/\/github\.com\/([^\/]+)\/([^\/\.]+?)(?:\.git)?(?:\/tree\/([^\/]+)(?:\/(.*))?)?\/?$/);
  if (gh) {
    const owner = gh[1], repo = gh[2];
    try { packageDirectoryName(owner + "/" + repo); } catch { return null; }
    const subpath = gh[4] ? gh[4].replace(/^\/+|\/+$/g, "") : "";
    if (subpath && subpath.split("/").some(p => !/^[A-Za-z0-9_.-]+$/.test(p) || p === "." || p === "..")) return null;
    return { owner, repo, subpath, cloneUrl: `https://github.com/${owner}/${repo}.git`, isLocal: false, pkgId: `${owner}__${repo}` };
  }
  const short = input.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (short) {
    const owner = short[1], repo = short[2];
    try { packageDirectoryName(owner + "/" + repo); } catch { return null; }
    return { owner, repo, subpath: "", cloneUrl: `https://github.com/${owner}/${repo}.git`, isLocal: false, pkgId: `${owner}__${repo}` };
  }
  if (opts.allowCloneUrl) {
    if (input.startsWith("https://") || input.startsWith("git@")) {
      const m = input.match(/([^\/:]+)\/([^\/]+?)(?:\.git)?$/);
      if (m) {
        try { packageDirectoryName(m[1] + "/" + m[2]); } catch { return null; }
        return { owner: m[1], repo: m[2], subpath: "", cloneUrl: input, isLocal: false, pkgId: `${m[1]}__${m[2]}` };
      }
    }
  }
  return null;
}

function createSkillsManager(opts = {}) {
  const homeDir = opts.homeDir || process.env.HOME || os.homedir();
  const hubDir = opts.hubDir || path.join(homeDir, ".t3", "hub");
  const hubSkillsDir = path.join(hubDir, "skills");
  const hubPackagesDir = path.join(hubDir, "packages");
  const hubStatePath = path.join(hubDir, "state.json");
  const hubGlobalAgentsPath = path.join(hubDir, "global-AGENTS.md");
  const codexDir = path.join(homeDir, ".codex");
  const agentsDir = path.join(homeDir, ".agents");
  const agentsSkillsDir = path.join(agentsDir, "skills");
  const lockPath = path.join(agentsDir, ".skill-lock.json");
  const zcodeSkillsDir = path.join(homeDir, ".zcode", "skills");
  const claudeSkillsDir = path.join(homeDir, ".claude", "skills");
  const codexCacheDir = path.join(codexDir, "plugins", "cache");
  const agyRoot = path.join(homeDir, ".t3", "userdata", "providers", "antigravity");

  function assertHubPath(target, options) {
    if (path.resolve(target).startsWith(path.resolve(homeDir) + path.sep)) assertSafeFsPath(homeDir, target, options);
    return assertSafeFsPath(hubDir, target, options);
  }
  function pluginBoundary(pluginDir, storeRoot) {
    try {
      const plugin = path.resolve(pluginDir);
      if (!storeRoot) {
        const stores = [
          path.join(hubDir, "plugins"), path.join(homeDir, "plugins"), codexCacheDir,
          ...[".zcode/cli/plugins", ".claude/plugins"].flatMap(p => [p, p + "/cache", p + "/marketplaces"]).map(p => path.join(homeDir, p)),
          ...[".config/muse/plugins", ".muse/plugins", ".pi/agent/plugins", ".pi/plugins", ".gemini/antigravity/plugins"].map(p => path.join(homeDir, p)),
        ];
        const agyRelative = path.relative(agyRoot, plugin).split(path.sep);
        if (agyRelative.length > 2 && agyRelative[0] !== ".." && agyRelative[1] === "plugins") stores.push(path.join(agyRoot, agyRelative[0], "plugins"));
        // Select the owning store before resolving links; a cache may not borrow
        // the wider plugins directory's authority to reach a sibling store.
        storeRoot = stores.map(p => path.resolve(p)).sort((a, b) => b.length - a.length)
          .find(p => plugin === p || plugin.startsWith(p + path.sep));
      }
      if (!storeRoot) return null;
      storeRoot = path.resolve(storeRoot);
      if (!plugin.startsWith(storeRoot + path.sep)) return null;
      assertSafeFsPath(homeDir, storeRoot);
      const realStoreRoot = fs.realpathSync(storeRoot);
      const realPlugin = fs.realpathSync(plugin);
      if (!realPlugin.startsWith(realStoreRoot + path.sep) || !fs.statSync(realPlugin).isDirectory()) return null;
      // Internal version aliases are permitted, but no component may leave its store.
      let current = storeRoot;
      for (const part of path.relative(storeRoot, plugin).split(path.sep)) {
        current = path.join(current, part);
        if (!fs.realpathSync(current).startsWith(realStoreRoot + path.sep)) return null;
      }
      return { realStoreRoot, realPlugin };
    } catch { return null; }
  }
  function packagePath(id, options) {
    const target = path.resolve(hubPackagesDir, packageDirectoryName(id));
    assertHubPath(target, options);
    return assertSafeFsPath(hubPackagesDir, target, options);
  }
  function packageDirs() {
    try {
      assertHubPath(path.join(hubPackagesDir, ".store-check"));
      return listDirs(hubPackagesDir).filter(dir => { try { packagePath(path.basename(dir)); return true; } catch { return false; } });
    } catch { return []; }
  }
  function containedSkillFile(dir) {
    try { return fileExists(assertSafeFsPath(dir, path.join(dir, "SKILL.md"))); } catch { return false; }
  }
  function canonicalPath(id) {
    assertSafeSkillId(id);
    const target = path.resolve(hubSkillsDir, id);
    assertHubPath(target);
    assertSafeFsPath(hubSkillsDir, target);
    assertSafeFsPath(target, path.join(target, "SKILL.md"));
    assertSafeFsPath(target, path.join(target, MANAGED_DIR_MARKER));
    return target;
  }
  function preflightSkillPaths(id, projectRoot, targets = []) {
    canonicalPath(id);
    assertHubPath(hubStatePath);
    assertSafeFsPath(homeDir, lockPath);
    for (const dir of [agentsSkillsDir, claudeSkillsDir, ...targets.map(agentSkillsDir)]) {
      assertSafeFsPath(homeDir, path.resolve(dir, id), { allowLeafSymlink: true });
    }
    if (projectRoot) for (const rel of [".agents/skills", ".claude/skills", ".codex/skills", ".claude/commands"]) {
      assertSafeFsPath(projectRoot, path.resolve(projectRoot, rel, id + (rel.endsWith("commands") ? ".md" : "")), { allowLeafSymlink: true });
    }
  }

  function readHubState() {
    assertHubPath(hubStatePath);
    const s = readJsonFile(hubStatePath, {});
    if (!s || typeof s !== "object") return {};
    return s;
  }
  function writeHubState(state) { assertHubPath(hubStatePath); writeJsonFile(hubStatePath, state); }

  function disabledSkillIds() {
    const out = new Set();
    try {
      const cfg = path.join(codexDir, "config.toml");
      let raw = "";
      try { raw = fs.readFileSync(cfg, "utf8"); } catch { return out; }
      const blocks = raw.split("[[skills.config]]");
      for (let i = 1; i < blocks.length; i++) {
        const b = blocks[i];
        const nm = b.match(/name\s*=\s*"([^"]+)"/);
        const dis = b.match(/disabled\s*=\s*(true|false)/);
        const en = b.match(/enabled\s*=\s*(true|false)/);
        if (!nm) continue;
        const isDisabled = (dis && dis[1] === "true") || (en && en[1] === "false");
        if (isDisabled) out.add(nm[1]);
      }
    } catch {}
    return out;
  }
  function codexSkillsPathMap() {
    const map = new Map();
    try {
      const cfg = path.join(codexDir, "config.toml");
      let raw = "";
      try { raw = fs.readFileSync(cfg, "utf8"); } catch { return map; }
      const blocks = raw.split("[[skills.config]]");
      for (let i = 1; i < blocks.length; i++) {
        const b = blocks[i];
        const nm = b.match(/name\s*=\s*"([^"]+)"/);
        const pm = b.match(/path\s*=\s*"([^"]+)"/);
        if (nm && pm) map.set(nm[1], pm[1]);
        else if (nm) map.set(nm[1], null);
      }
    } catch {}
    return map;
  }
  function skillDirForAgent(agent, homeDir = this?.homeDir) {
    // overridden per closure below; placeholder for global use not called
    return "";
  }
  function agentSkillsDir(agent) {
    if (agent === "antigravity") return primaryAgySkillsDirFor(homeDir);
    if (agent === "muse") return path.join(homeDir, ".config", "muse", "skills");
    if (agent === "codex") return path.join(codexDir, "skills");
    if (agent === "pi") return path.join(homeDir, ".pi", "agent", "skills");
    if (agent === "claude") return path.join(claudeSkillsDir);
    if (agent === "zcode") return path.join(zcodeSkillsDir);
    return null;
  }
  function allAgySkillsDirs() {
    const dirs = [];
    try { for (const inst of listDirs(agyRoot)) { dirs.push(path.join(inst, "config", "skills")); for (const arch of listDirs(inst)) if (path.basename(arch).startsWith("skills-archived-")) dirs.push(arch); } } catch {}
    if (!dirs.length) dirs.push(primaryAgySkillsDirFor(homeDir));
    return dirs;
  }
  function collectSkillSets() {
    const sets = {
      antigravity: new Set(),
      muse: new Set(),
      codex: new Set(),
      pi: new Set(),
      claude: new Set(),
      shared: new Set(),
    };
    function addFromDir(dir, set) {
      if (!dirExists(dir)) return;
      for (const d of listDirs(dir)) {
        const id = path.basename(d);
        try { if (fileExists(path.join(d, "SKILL.md"))) set.add(id); } catch {}
      }
    }
    for (const dir of allAgySkillsDirs()) addFromDir(dir, sets.antigravity);
    addFromDir(path.join(homeDir, ".config", "muse", "skills"), sets.muse);
    addFromDir(path.join(homeDir, ".pi", "agent", "skills"), sets.pi);
    addFromDir(claudeSkillsDir, sets.claude);
    addFromDir(path.join(codexDir, "skills"), sets.codex);
    addFromDir(agentsSkillsDir, sets.shared);
    const disabled = disabledSkillIds();
    const pathMap = codexSkillsPathMap();
    // apply codex path overrides: if path exists and not disabled, treat as present
    for (const [skillId, p] of pathMap.entries()) {
      if (!p) continue;
      if (disabled.has(skillId)) continue;
      const expanded = p.startsWith("~/") ? path.join(homeDir, p.slice(2)) : p;
      if (fileExists(path.join(expanded, "SKILL.md"))) sets.codex.add(skillId);
    }
    // disabled remove
    for (const id of disabled) sets.codex.delete(id);
    return sets;
  }
  function agentStatesForSkill(id, sets = collectSkillSets()) {
    let muse = sets.muse.has(id) || sets.shared.has(id);
    let pi = sets.pi.has(id) || sets.shared.has(id);
    const sharedViaAgentsDir = sets.shared.has(id) && (muse || pi);
    return {
      agentStates: {
        antigravity: sets.antigravity.has(id),
        muse,
        codex: sets.codex.has(id),
        pi,
        claude: sets.claude.has(id),
      },
      sharedViaAgentsDir: !!sharedViaAgentsDir,
    };
  }

  function readLock() {
    assertSafeFsPath(homeDir, lockPath);
    const raw = readJsonFile(lockPath, null);
    if (!raw) return { version: 3, skills: {} };
    if (Array.isArray(raw)) { const skills = {}; for (const e of raw) { if (e && e.id) skills[e.id] = e; } return { version: 3, skills }; }
    if (typeof raw === "object" && raw.skills && typeof raw.skills === "object") return { version: raw.version || 3, skills: raw.skills };
    if (typeof raw === "object") return { version: raw.version || 3, skills: raw };
    return { version: 3, skills: {} };
  }
  function writeLock(lock) { assertSafeFsPath(homeDir, lockPath); writeJsonFile(lockPath, lock); }

  function ensureCanonical(skillId) {
    assertSafeSkillId(skillId);
    const dest = canonicalPath(skillId);
    assertContained(hubSkillsDir, dest);
    if (dirExists(dest) && fileExists(path.join(dest, "SKILL.md"))) { stampManagedDir(dest); return dest; }
    const candidates = [
      path.join(agentsSkillsDir, skillId),
      path.join(claudeSkillsDir, skillId),
      path.join(zcodeSkillsDir, skillId),
    ];
    for (const c of candidates) {
      assertContained(path.dirname(c), c);
      const st = lstatSafe(c);
      if (!st) continue;
      let real;
      try { real = st.isSymbolicLink() ? fs.realpathSync(c) : c; } catch { continue; }
      if (fileExists(path.join(real, "SKILL.md"))) {
        if (lstatSafe(dest)) clearIncompleteCanonical(dest, hubDir);
        cpDirRecursive(real, dest);
        stampManagedDir(dest);
        return dest;
      }
    }
    for (const pd of packageDirs()) {
      const found = findSkillDirsRecursive(pd, 4).find((d) => path.basename(d) === skillId);
      if (found) {
        if (lstatSafe(dest)) clearIncompleteCanonical(dest, hubDir);
        cpDirRecursive(found, dest);
        stampManagedDir(dest);
        return dest;
      }
      if (containedSkillFile(pd) && path.basename(pd) === skillId) {
        if (lstatSafe(dest)) clearIncompleteCanonical(dest, hubDir);
        cpDirRecursive(pd, dest);
        stampManagedDir(dest);
        return dest;
      }
    }
    if (dirExists(codexCacheDir)) {
      for (const mp of listDirs(codexCacheDir)) for (const pl of listDirs(mp)) {
        const boundary = pluginBoundary(pl, codexCacheDir);
        if (!boundary) continue;
        const { realPlugin } = boundary;
        const cands = [realPlugin, path.join(realPlugin, "skills", skillId)];
        for (const c of cands) {
          try { assertSafeFsPath(realPlugin, path.join(c, "SKILL.md")); } catch { continue; }
          if (!containedSkillFile(c)) continue;
          if (lstatSafe(dest)) clearIncompleteCanonical(dest, hubDir);
          cpDirRecursive(c, dest);
          stampManagedDir(dest);
          return dest;
        }
        const alt = findSkillDirsRecursive(realPlugin, 4).find((d) => path.basename(d) === skillId);
        if (alt) {
          if (lstatSafe(dest)) clearIncompleteCanonical(dest, hubDir);
          cpDirRecursive(alt, dest);
          stampManagedDir(dest);
          return dest;
        }
      }
    }
    if (dirExists(agyRoot)) {
      for (const inst of listDirs(agyRoot)) {
        const roots = [path.join(inst, "config", "skills")];
        for (const arch of listDirs(inst)) if (path.basename(arch).startsWith("skills-archived-")) roots.push(arch);
        for (const r of roots) {
          const c = path.join(r, skillId);
          if (fileExists(path.join(c, "SKILL.md"))) {
            if (lstatSafe(dest)) clearIncompleteCanonical(dest, hubDir);
            cpDirRecursive(c, dest);
            stampManagedDir(dest);
            return dest;
          }
        }
      }
    }
    if (dirExists(dest)) { stampManagedDir(dest); return dest; }
    safeMkdir(dest);
    stampManagedDir(dest);
    return dest;
  }

  function backupIfRealDir(p, skillId) {
    assertSafeSkillId(skillId);
    const st = lstatSafe(p);
    if (!st) return;
    if (st.isSymbolicLink()) return;
    assertContained(path.dirname(p), p);
    if (st.isDirectory()) {
      const dest = canonicalPath(skillId);
      assertContained(hubSkillsDir, dest);
      if (!dirExists(dest)) { safeMkdir(hubSkillsDir); cpDirRecursive(p, dest); stampManagedDir(dest); }
    } else if (st.isFile()) {
      const dest = canonicalPath(skillId);
      assertContained(hubSkillsDir, dest);
      safeMkdir(hubSkillsDir);
      if (!dirExists(dest)) { safeMkdir(dest); fs.copyFileSync(p, path.join(dest, path.basename(p))); stampManagedDir(dest); }
    }
  }

  function resolveExcludePath(projectRoot) {
    if (!projectRoot || !dirExists(projectRoot)) return null;
    const gitPath = path.join(projectRoot, ".git");
    const st = lstatSafe(gitPath);
    if (!st) return null;
    if (st.isDirectory()) return path.join(gitPath, "info", "exclude");
    if (st.isFile()) {
      try {
        const content = fs.readFileSync(gitPath, "utf8").trim();
        const m = content.match(/^gitdir:\s*(.+)$/m);
        if (m) {
          let gd = m[1].trim();
          if (!path.isAbsolute(gd)) gd = path.resolve(path.dirname(gitPath), gd);
          return path.join(gd, "info", "exclude");
        }
      } catch {}
    }
    return null;
  }
  function ensureExclude(projectRoot, entries) {
    const excl = resolveExcludePath(projectRoot);
    if (!excl) return;
    safeMkdir(path.dirname(excl));
    let existing = "";
    try { existing = fs.readFileSync(excl, "utf8"); } catch {}
    const lines = existing.split(/\r?\n/);
    let changed = false;
    for (const e of entries) {
      if (!lines.includes(e)) { lines.push(e); changed = true; }
    }
    if (changed || !existing) {
      const out = lines.join("\n").replace(/\n+$/, "") + "\n";
      const tmp = excl + ".tmp-" + process.pid;
      fs.writeFileSync(tmp, out, { encoding: "utf8", flag: "wx" });
      fs.renameSync(tmp, excl);
    }
  }

  function listAssets(args = {}) {
    const projectRoot = args.projectRoot || null;
    const lock = readLock();
    const lockSkills = lock.skills || {};
    const disabled = disabledSkillIds();
    const byId = new Map();
    const state = readHubState();
    const { discoverPluginDirectories, pluginDetails } = require("./hub-plugins.cjs");
    const pluginRoots = discoverPluginDirectories({ homeDir, hubDir }).filter(d => pluginBoundary(d) && pluginDetails(d).composite);
    const compositeRoots = new Set(pluginRoots.map(d => { try { return fs.realpathSync(d); } catch { return d; } }));
    function addItem(it) {
      if (!it || !it.id) return;
      const existing = byId.get(it.id);
      if (!existing) { byId.set(it.id, it); return; }
      const rank = (s) => (s === "project" ? 0 : s === "global" ? 1 : s === "claude" || s === "zcode" ? 2 : s === "codex-market" ? 3 : s === "agy" ? 4 : 5);
      if (rank(it.source) < rank(existing.source)) byId.set(it.id, it);
    }
    function compositeRoot(dir) {
      let real = dir;
      try { real = fs.realpathSync(dir); } catch {}
      let current = path.dirname(real);
      for (let i = 0; i < 6 && current !== homeDir && current !== hubDir; i++, current = path.dirname(current)) {
        if (compositeRoots.has(current) || [".codex-plugin", ".zcode-plugin", ".claude-plugin", ".mcp.json", "servers.mcp.json", "hooks"].some(f => fs.existsSync(path.join(current, f)))) return current;
        if (current === path.dirname(current)) break;
      }
      return null;
    }
    function mkItem(id, dir, source, sourceLabel, pluginDir, realStoreRoot) {
      const skillMdPath = path.join(dir, "SKILL.md");
      try {
        if (pluginDir) {
          const realBase = fs.realpathSync(pluginDir);
          if (realStoreRoot && !realBase.startsWith(realStoreRoot + path.sep)) return null;
          const rel = path.relative(path.resolve(pluginDir), skillMdPath);
          const absReal = path.resolve(realBase, rel);
          assertSafeFsPath(realBase, absReal);
          const st = fs.lstatSync(absReal);
          if (!st.isFile() || st.isSymbolicLink()) return null;
          const realSkill = fs.realpathSync(absReal);
          if (!(realSkill !== realBase && realSkill.startsWith(realBase + path.sep))) return null;
          if (realStoreRoot && !realSkill.startsWith(realStoreRoot + path.sep)) return null;
        } else {
          assertSafeFsPath(dir, skillMdPath);
          const st = fs.lstatSync(skillMdPath);
          if (!st.isFile() || st.isSymbolicLink()) return null;
          const realBase = fs.realpathSync(dir);
          const realSkill = fs.realpathSync(skillMdPath);
          if (!(realSkill !== realBase && realSkill.startsWith(realBase + path.sep))) return null;
        }
      } catch { return null; }
      const meta = parseSkillMd(skillMdPath);
      const lockEntry = lockSkills[id] || {};
      return {
        id, name: meta.name || id, description: meta.description || "", fromCompositePlugin: !!compositeRoot(dir) || !!(state.skills?.[id]?.sourceDir && compositeRoot(state.skills[id].sourceDir)),
        source, sourceLabel: sourceLabel || source,
        repoUrl: lockEntry.repoUrl || lockEntry.repo || lockEntry.url || "",
        scope: "off", path: dir,
        updatable: !!(lockEntry.repoUrl || lockEntry.repo || lockEntry.url),
      };
    }
    for (const d of listDirs(hubSkillsDir)) {
      try { canonicalPath(path.basename(d)); } catch { continue; }
      if (containedSkillFile(d)) addItem(mkItem(path.basename(d), d, "github", "hub"));
    }
    for (const pd of packageDirs()) {
      if (containedSkillFile(pd)) { const id = path.basename(pd); addItem(mkItem(id, pd, "github", path.basename(pd), pd)); }
      for (const sd of findSkillDirsRecursive(pd, 4)) { const id = path.basename(sd); addItem(mkItem(id, sd, "github", path.basename(pd), pd)); }
    }
    for (const plugin of pluginRoots) {
      const boundary = pluginBoundary(plugin);
      if (!boundary) continue;
      const { realPlugin, realStoreRoot } = boundary;
      try {
        assertSafeFsPath(realPlugin, path.resolve(realPlugin, "skills"));
      } catch { continue; }
      for (const sd of listDirs(path.join(plugin, "skills"))) {
        const skillMdPath = path.join(sd, "SKILL.md");
        try {
          const rel = path.relative(path.resolve(plugin), skillMdPath);
          const absReal = path.resolve(realPlugin, rel);
          assertSafeFsPath(realPlugin, absReal);
          const st = fs.lstatSync(absReal);
          if (!st.isFile() || st.isSymbolicLink()) continue;
          const realSkill = fs.realpathSync(absReal);
          if (!(realSkill !== realPlugin && realSkill.startsWith(realPlugin + path.sep))) continue;
        } catch { continue; }
        addItem(mkItem(path.basename(sd), sd, "github", path.basename(plugin), plugin, realStoreRoot));
      }
    }
    if (dirExists(codexCacheDir)) {
      for (const mp of listDirs(codexCacheDir)) for (const pl of listDirs(mp)) {
        const boundary = pluginBoundary(pl, codexCacheDir);
        if (!boundary) continue;
        const { realStoreRoot } = boundary;
        const plugId = path.basename(pl);
        addItem(mkItem(plugId, pl, "codex-market", `${path.basename(mp)}/${plugId}`, pl, realStoreRoot));
        for (const root of [pl, ...listDirs(pl)]) {
          const rootBoundary = pluginBoundary(root, codexCacheDir);
          if (!rootBoundary) continue;
          const realRoot = rootBoundary.realPlugin;
          const inner = path.join(root, "skills");
          if (!dirExists(inner)) continue;
          let absInner;
          try {
            absInner = path.join(realRoot, "skills");
            assertSafeFsPath(realRoot, absInner);
          } catch { continue; }
          for (const sd of listDirs(inner)) {
            const skillMdPath = path.join(sd, "SKILL.md");
            try {
              const rel = path.relative(path.resolve(root), skillMdPath);
              const absReal = path.resolve(realRoot, rel);
              assertSafeFsPath(realRoot, absReal);
              const st = fs.lstatSync(absReal);
              if (!st.isFile() || st.isSymbolicLink()) continue;
              const realSkill = fs.realpathSync(absReal);
              if (!realSkill.startsWith(realRoot + path.sep) || !realSkill.startsWith(realStoreRoot + path.sep)) continue;
            } catch { continue; }
            addItem(mkItem(path.basename(sd), sd, "codex-market", `${path.basename(mp)}/${plugId}`, root, realStoreRoot));
          }
        }
      }
    }
    if (dirExists(agentsSkillsDir)) for (const d of listDirs(agentsSkillsDir)) if (fileExists(path.join(d, "SKILL.md"))) addItem(mkItem(path.basename(d), d, "global", "global"));
    if (dirExists(zcodeSkillsDir)) for (const d of listDirs(zcodeSkillsDir)) if (fileExists(path.join(d, "SKILL.md"))) addItem(mkItem(path.basename(d), d, "zcode", "zcode"));
    if (dirExists(claudeSkillsDir)) for (const d of listDirs(claudeSkillsDir)) if (fileExists(path.join(d, "SKILL.md"))) addItem(mkItem(path.basename(d), d, "claude", "claude"));
    if (dirExists(path.join(homeDir, ".config", "muse", "skills"))) for (const d of listDirs(path.join(homeDir, ".config", "muse", "skills"))) if (fileExists(path.join(d, "SKILL.md"))) addItem(mkItem(path.basename(d), d, "muse", "muse"));
    if (dirExists(path.join(homeDir, ".pi", "agent", "skills"))) for (const d of listDirs(path.join(homeDir, ".pi", "agent", "skills"))) if (fileExists(path.join(d, "SKILL.md"))) addItem(mkItem(path.basename(d), d, "pi", "pi"));
    if (dirExists(path.join(codexDir, "skills"))) for (const d of listDirs(path.join(codexDir, "skills"))) if (fileExists(path.join(d, "SKILL.md"))) addItem(mkItem(path.basename(d), d, "codex", "codex"));
    if (dirExists(agyRoot)) {
      for (const inst of listDirs(agyRoot)) {
        const roots = [path.join(inst, "config", "skills")];
        for (const arch of listDirs(inst)) if (path.basename(arch).startsWith("skills-archived-")) roots.push(arch);
        for (const r of roots) if (dirExists(r)) for (const d of listDirs(r)) if (fileExists(path.join(d, "SKILL.md"))) addItem(mkItem(path.basename(d), d, "agy", "agy"));
      }
    }
    if (projectRoot && dirExists(projectRoot)) {
      const ps = [path.join(projectRoot, ".agents", "skills"), path.join(projectRoot, ".claude", "skills")];
      for (const base of ps) if (dirExists(base)) for (const d of listDirs(base)) if (fileExists(path.join(d, "SKILL.md"))) addItem(mkItem(path.basename(d), d, "project", "project"));
    }
    const sets = collectSkillSets();
    const items = [...byId.values()].map((it) => {
      const g = path.join(agentsSkillsDir, it.id);
      const isGlobalActive = dirExists(g) && !disabled.has(it.id);
      const isProject = projectRoot ? dirExists(path.join(projectRoot, ".agents", "skills", it.id)) : false;
      let scope = "off";
      if (isGlobalActive) scope = "global";
      else if (isProject) scope = "project";
      const { agentStates, sharedViaAgentsDir } = agentStatesForSkill(it.id, sets);
      const enabledCount = Object.values(agentStates).filter(Boolean).length;
      const enabled = enabledCount > 0 || scope !== "off";
      return { ...it, scope, updatable: !!(it.repoUrl || it.source === "codex-market" || it.source === "github"), agentStates, enabledCount, enabled, sharedViaAgentsDir };
    }).filter(it => args.includePluginBundled === true || !it.fromCompositePlugin || it.scope !== "off").sort((a, b) => a.id.localeCompare(b.id));
    return { ok: true, projectRoot: projectRoot || null, items };
  }

  function removeProjectSlash(id, projectRoot, canonical) {
    assertSafeSkillId(id);
    const codexLink = projectRoot ? path.join(projectRoot, ".codex", "skills", id) : null;
    const cmdFile = projectRoot ? path.join(projectRoot, ".claude", "commands", id + ".md") : null;
    if (codexLink) {
      assertContained(path.join(projectRoot, ".codex", "skills"), codexLink);
      removePath(codexLink, canonical, hubDir);
    }
    if (cmdFile) {
      assertContained(path.join(projectRoot, ".claude", "commands"), cmdFile);
      safeRemoveCmdFile(cmdFile, hubDir);
    }
  }

  function setSkillScope(args = {}) {
    const { id, scope } = args;
    const projectRoot = args.projectRoot || null;
    if (!["off", "project", "global"].includes(scope)) throw new Error("invalid id or scope");
    assertSafeSkillId(id);
    if (scope === "project" && (!projectRoot || !path.isAbsolute(projectRoot))) throw new Error("projectRoot required for project scope");
    if (projectRoot && !path.isAbsolute(projectRoot)) throw new Error("projectRoot must be absolute");
    if (args.sourceDir && (!path.isAbsolute(args.sourceDir) || !fileExists(path.join(args.sourceDir, "SKILL.md")))) throw new Error("sourceDir must be an absolute skill directory");
    preflightSkillPaths(id, projectRoot);
    safeMkdir(hubSkillsDir);
    const globalLink = path.join(agentsSkillsDir, id);
    const claudeLink = path.join(claudeSkillsDir, id);
    const projLink = projectRoot ? path.join(projectRoot, ".agents", "skills", id) : null;
    const projClaudeLink = projectRoot ? path.join(projectRoot, ".claude", "skills", id) : null;
    const projCodexLink = projectRoot ? path.join(projectRoot, ".codex", "skills", id) : null;
    const projCmdFile = projectRoot ? path.join(projectRoot, ".claude", "commands", id + ".md") : null;
    assertContained(agentsSkillsDir, globalLink);
    assertContained(claudeSkillsDir, claudeLink);
    if (projectRoot) {
      assertContained(path.join(projectRoot, ".agents", "skills"), projLink);
      assertContained(path.join(projectRoot, ".claude", "skills"), projClaudeLink);
      assertContained(path.join(projectRoot, ".codex", "skills"), projCodexLink);
      assertContained(path.join(projectRoot, ".claude", "commands"), projCmdFile);
    }
    backupIfRealDir(globalLink, id);
    if (projLink) backupIfRealDir(projLink, id);
    const canonicalPath = path.join(hubSkillsDir, id);
    const hadCanonical = fileExists(path.join(canonicalPath, "SKILL.md"));
    if (!hadCanonical && args.sourceDir) {
      if (lstatSafe(canonicalPath)) clearIncompleteCanonical(canonicalPath, hubDir);
      cpDirRecursive(fs.realpathSync(args.sourceDir), canonicalPath);
    }
    const canonical = ensureCanonical(id);
    if (!hadCanonical && fileExists(path.join(canonical, "SKILL.md"))) {
      for (const candidate of [globalLink, claudeLink]) {
        const st = lstatSafe(candidate);
        if (st && st.isSymbolicLink() && !isHubManagedSymlink(candidate, hubDir) && fileExists(path.join(candidate, "SKILL.md"))) {
          fs.renameSync(candidate, backupPathFor(candidate));
          break;
        }
      }
    }
    if (scope === "global") {
      ensureSymlink(canonical, globalLink, hubDir);
      if (dirExists(path.dirname(claudeLink))) ensureSymlink(canonical, claudeLink, hubDir);
      if (projLink) removePath(projLink, canonical, hubDir);
      if (projClaudeLink) removePath(projClaudeLink, canonical, hubDir);
      // Switching project -> global must clean Hub-managed per-project slash artifacts.
      if (projectRoot) removeProjectSlash(id, projectRoot, canonical);
    } else if (scope === "project") {
      removePath(globalLink, canonical, hubDir);
      removePath(claudeLink, canonical, hubDir);
      ensureSymlink(canonical, projLink, hubDir);
      if (dirExists(path.join(projectRoot, ".claude"))) ensureSymlink(canonical, projClaudeLink, hubDir);
      // Native / per-project slash discovery: also expose via .codex/skills and .claude/commands.
      ensureSymlink(canonical, projCodexLink, hubDir);
      const skillMeta = parseSkillMd(path.join(canonical, "SKILL.md"));
      const skillDesc = skillMeta.description || id;
      const cmdContent =
        `---\n` +
        `description: ${String(skillDesc).replace(/"/g, "'").slice(0, 200)}\n` +
        `---\n\n` +
        `> Delegates to skill "${id}" located at \`${path.join(canonical, "SKILL.md")}\`\n\n` +
        `Use this skill when the task matches: ${skillDesc}\n\n` +
        `Canonical: ${canonical}\n` +
        `SKILL.md: ${path.join(canonical, "SKILL.md")}\n`;
      assertContained(path.join(projectRoot, ".claude", "commands"), projCmdFile);
      try { safeWriteCmdFile(projCmdFile, cmdContent); } catch {}
      ensureExclude(projectRoot, [`.agents/skills/${id}`, `.codex/skills/${id}`, `.claude/skills/${id}`, `.claude/commands/${id}.md`]);
    } else {
      removePath(globalLink, canonical, hubDir);
      removePath(claudeLink, canonical, hubDir);
      if (projLink) removePath(projLink, canonical, hubDir);
      if (projClaudeLink) removePath(projClaudeLink, canonical, hubDir);
      if (projectRoot) removeProjectSlash(id, projectRoot, canonical);
    }
    const state = readHubState();
    state.skills = state.skills || {};
    state.skills[id] = { ...state.skills[id], scope, updatedAt: new Date().toISOString(), ...(args.sourceDir ? { sourceDir: args.sourceDir } : {}) };
    writeHubState(state);
    const listed = listAssets({ projectRoot });
    const item = listed.items.find((i) => i.id === id) || { id, name: id, description: "", source: "github", sourceLabel: "hub", repoUrl: "", scope, path: canonical, updatable: false };
    return { ok: true, item: { ...item, scope } };
  }

  function backupOnceHub(file) {
    const bak = file + ".t3hub.bak";
    if (fileExists(file) && !fileExists(bak)) { try { fs.copyFileSync(file, bak); fs.chmodSync(bak, 0o600); } catch {} }
  }
  function findSkillSourceDir(skillId) {
    assertSafeSkillId(skillId);
    const candidates = [
      path.join(hubSkillsDir, skillId),
      path.join(agentsSkillsDir, skillId),
      path.join(path.join(homeDir, ".config", "muse", "skills"), skillId),
      path.join(path.join(homeDir, ".pi", "agent", "skills"), skillId),
      path.join(path.join(codexDir, "skills"), skillId),
      path.join(claudeSkillsDir, skillId),
      path.join(zcodeSkillsDir, skillId),
    ];
    for (const dir of allAgySkillsDirs()) candidates.push(path.join(dir, skillId));
    for (const c of candidates) {
      try {
        const st = lstatSafe(c);
        if (!st) continue;
        const real = st.isSymbolicLink() ? fs.realpathSync(c) : c;
        if (fileExists(path.join(real, "SKILL.md"))) return real;
      } catch {}
    }
    // search packages and plugins recursively
    for (const pd of packageDirs()) {
      const found = findSkillDirsRecursive(pd, 4).find(d => path.basename(d) === skillId);
      if (found && fileExists(path.join(found, "SKILL.md"))) return found;
    }
    try {
      const { discoverPluginDirectories, pluginDetails } = require("./hub-plugins.cjs");
      for (const plug of discoverPluginDirectories({ homeDir, hubDir })) {
        const boundary = pluginBoundary(plug);
        if (!boundary) continue;
        const det = pluginDetails(boundary.realPlugin);
        for (const sd of det.skillDirs) if (path.basename(sd) === skillId && fileExists(path.join(sd, "SKILL.md"))) return sd;
      }
    } catch {}
    return null;
  }
  function ensureSkillCanonical(skillId) {
    assertSafeSkillId(skillId);
    const dest = canonicalPath(skillId);
    assertContained(hubSkillsDir, dest);
    if (dirExists(dest) && fileExists(path.join(dest, "SKILL.md"))) { stampManagedDir(dest); return dest; }
    const src = findSkillSourceDir(skillId);
    if (src) {
      if (lstatSafe(dest)) clearIncompleteCanonical(dest, hubDir);
      const real = (() => { try { return fs.realpathSync(src); } catch { return src; } })();
      cpDirRecursive(real, dest);
      stampManagedDir(dest);
      return dest;
    }
    // fallback to existing ensureCanonical (creates empty)
    return ensureCanonical(skillId);
  }
  function fixCodexSkillsDisabled(skillId) {
    const cfg = path.join(codexDir, "config.toml");
    assertSafeFsPath(homeDir, cfg);
    let raw = "";
    try { raw = fs.readFileSync(cfg, "utf8"); } catch { return; }
    if (!raw.includes("[[skills.config]]")) return;
    const lines = raw.split(/\r?\n/);
    const out = [];
    let inTarget = false;
    let needsFix = false;
    let nameSeen = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().startsWith("[[skills.config]]")) {
        inTarget = true;
        nameSeen = false;
        out.push(line);
        continue;
      }
      if (inTarget && line.trim().startsWith("[")) { inTarget = false; }
      if (inTarget) {
        const nm = line.match(/name\s*=\s*"([^"]+)"/);
        if (nm) nameSeen = nm[1] === skillId;
        if (nameSeen) {
          if (line.match(/disabled\s*=\s*true/)) { out.push(line.replace(/disabled\s*=\s*true/, "disabled = false")); needsFix = true; continue; }
          if (line.match(/enabled\s*=\s*false/)) { out.push(line.replace(/enabled\s*=\s*false/, "enabled = true")); needsFix = true; continue; }
        }
      }
      out.push(line);
    }
    if (needsFix) {
      backupOnceHub(cfg);
      const tmp = cfg + ".tmp-" + process.pid;
      fs.writeFileSync(tmp, out.join("\n"), { mode: 0o600, flag: "wx" });
      fs.renameSync(tmp, cfg);
      try { fs.chmodSync(cfg, 0o600); } catch {}
    }
  }
  function addCodexSkillsDisabled(skillId) {
    const cfg = path.join(codexDir, "config.toml");
    assertSafeFsPath(homeDir, cfg);
    let raw = "";
    try { raw = fs.readFileSync(cfg, "utf8"); } catch { raw = ""; }
    if (raw.includes(`name = "${skillId}"`) || raw.includes(`name = '${skillId}'`)) return;
    backupOnceHub(cfg);
    safeMkdir(path.dirname(cfg));
    const prefix = raw.trim() ? raw.replace(/\n+$/, "\n") + "\n" : "";
    const block = `[[skills.config]]\nname = "${String(skillId).replace(/"/g, '\\"')}"\ndisabled = true\n`;
    const tmp = cfg + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, prefix + block, { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, cfg);
    try { fs.chmodSync(cfg, 0o600); } catch {}
  }
  function toggleSkillForAgent({ id, name, agent, enabled } = {}) {
    const skillId = id || name;
    if (!skillId || typeof skillId !== "string") throw new Error("id or name required");
    assertSafeSkillId(skillId);
    const canonicalAgent = normalizeAgentHost(agent);
    if (!canonicalAgent) throw new Error("invalid agent");
    if (typeof enabled !== "boolean") throw new Error("enabled must be boolean");
    const targets = canonicalAgent === "all" ? CANONICAL_HOSTS : [canonicalAgent];
    preflightSkillPaths(skillId, null, targets);
    if (targets.includes("codex")) assertSafeFsPath(homeDir, path.join(codexDir, "config.toml"));
    const canonical = ensureSkillCanonical(skillId);
    // ensure canonical points to hub dir for symlink creation
    const hubCanonical = path.join(hubSkillsDir, skillId);
    assertContained(hubSkillsDir, hubCanonical);
    if (!dirExists(hubCanonical) || !fileExists(path.join(hubCanonical, "SKILL.md"))) {
      // fallback src already copied above canonical is hubCanonical itself
    }
    const effectiveSource = dirExists(hubCanonical) && fileExists(path.join(hubCanonical, "SKILL.md")) ? hubCanonical : canonical;
    let sharedViaAgentsDir = false;
    let hint = null;
    for (const ag of targets) {
      const dir = agentSkillsDir(ag);
      if (!dir) throw new Error("invalid agent");
      const linkPath = path.join(dir, skillId);
      assertContained(dir, linkPath);
      safeMkdir(dir);
      if (enabled) {
        ensureSymlink(effectiveSource, linkPath, hubDir);
        if (ag === "codex") fixCodexSkillsDisabled(skillId);
        // shared detection
        if (ag === "muse" || ag === "pi") {
          if (dirExists(path.join(agentsSkillsDir, skillId)) && fileExists(path.join(agentsSkillsDir, skillId, "SKILL.md"))) {
            sharedViaAgentsDir = true;
          }
        }
      } else {
        const st = lstatSafe(linkPath);
        if (!st) {
          // no link to remove; for codex still mark disabled via config if needed
          if (ag === "codex") addCodexSkillsDisabled(skillId);
          continue;
        }
        if (st.isSymbolicLink()) {
          if (isHubManagedSymlink(linkPath, hubDir)) fs.unlinkSync(linkPath);
          else {
            // external symlink: backup then unlink
            fs.renameSync(linkPath, backupPathFor(linkPath));
          }
        } else if (st.isDirectory()) {
          if (isManagedDir(linkPath)) fs.rmSync(linkPath, { recursive: true, force: true });
          else {
            // Real dir: backup migrate to hub canonical then remove
            const canonicalPath = hubCanonical;
            if (!dirExists(canonicalPath)) { safeMkdir(path.dirname(canonicalPath)); cpDirRecursive(linkPath, canonicalPath); stampManagedDir(canonicalPath); }
            else {
              // backup unmanaged dir to backupPath and keep canonical intact
              const bak = backupPathFor(linkPath);
              fs.renameSync(linkPath, bak);
            }
            // after copy, remove the original location (already moved or copied)
            if (lstatSafe(linkPath)) {
              // if symlink case not, removePath logic
            }
            if (dirExists(linkPath)) fs.rmSync(linkPath, { recursive: true, force: true });
          }
        } else if (st.isFile()) {
          // file at target: backup
          backupUnmanagedFile(linkPath);
        }
        // For muse/pi shared skill: hint
        if (ag === "muse" || ag === "pi") {
          if (dirExists(path.join(agentsSkillsDir, skillId)) && fileExists(path.join(agentsSkillsDir, skillId, "SKILL.md"))) {
            sharedViaAgentsDir = true;
            if (!hint) hint = "共享目录 ~/.agents/skills 与 Muse/Pi 共享同一入口，单独关闭 " + ag + " 需迁移到 Hub 规范库后拆分，当前仅移除专属软链，共享目录仍保持启用。";
          }
        }
        // For codex, adding disabled entry ensures disable persists even if other source path exists
        if (ag === "codex") {
          // after removing symlink, also ensure disabled config so it stays off
          try { addCodexSkillsDisabled(skillId); } catch {}
        }
      }
    }
    // persist hub state hint
    const state = readHubState();
    state.skills = state.skills || {};
    if (!state.skills[skillId]) state.skills[skillId] = {};
    state.skills[skillId].updatedAt = new Date().toISOString();
    if (sharedViaAgentsDir) state.skills[skillId].sharedViaAgentsDir = true;
    if (hint) state.skills[skillId].migrationHint = hint;
    writeHubState(state);
    const listed = listAssets({});
    const item = listed.items.find(i => i.id === skillId);
    const result = { ok: true, id: skillId, agent: canonicalAgent, enabled, sharedViaAgentsDir };
    if (hint) result.hint = hint;
    if (item) result.item = item;
    return result;
  }
  function listSkills(args = {}) { return listAssets(args); }

  async function importFromGitHub(args = {}) {
    const { repoInput } = args;
    const scope = args.scope || "project";
    const projectRoot = args.projectRoot || null;
    const parsed = parseGitHubInput(repoInput);
    if (!parsed) throw new Error("invalid repo input");
    if (!["off", "project", "global"].includes(scope)) throw new Error("invalid scope");
    if (scope === "project" && (!projectRoot || !dirExists(projectRoot))) throw new Error("projectRoot required for project scope");
    const pkgDir = packagePath(parsed.pkgId);
    assertSafeFsPath(pkgDir, path.join(pkgDir, ".git"));
    assertHubPath(path.join(hubSkillsDir, ".store-check"));
    safeMkdir(hubPackagesDir); safeMkdir(hubSkillsDir);
    if (dirExists(pkgDir) && dirExists(path.join(pkgDir, ".git"))) {
      await execFileAsync("git", ["pull", "--ff-only"], { cwd: pkgDir });
    } else if (dirExists(pkgDir)) {
      fs.rmSync(pkgDir, { recursive: true, force: true });
      await execFileAsync("git", ["clone", "--depth", "1", parsed.cloneUrl, pkgDir]);
    } else {
      await execFileAsync("git", ["clone", "--depth", "1", parsed.cloneUrl, pkgDir]);
    }
    // git is asynchronous: revalidate the store before every subsequent FS use.
    packagePath(parsed.pkgId);
    assertSafeFsPath(pkgDir, path.join(pkgDir, ".git"));
    const searchRoot = parsed.subpath ? assertSafeFsPath(pkgDir, path.resolve(pkgDir, parsed.subpath)) : pkgDir;
    let skillDirs = findSkillDirsRecursive(searchRoot, 5);
    if (skillDirs.length === 0 && dirExists(pkgDir)) skillDirs = findSkillDirsRecursive(pkgDir, 5);
    const imported = [];
    for (const sd of skillDirs) {
      let id = path.basename(sd);
      if (sd === pkgDir) id = parsed.repo;
      try { assertSafeSkillId(id); } catch { continue; }
      const dest = canonicalPath(id);
      assertContained(hubSkillsDir, dest);
      if (lstatSafe(dest)) clearIncompleteCanonical(dest, hubDir);
      cpDirRecursive(sd, dest);
      stampManagedDir(dest);
      imported.push(id);
      const lock = readLock();
      lock.skills[id] = { id, repoUrl: parsed.cloneUrl, source: parsed.isLocal ? "local" : "github", package: parsed.pkgId, installedAt: new Date().toISOString() };
      writeLock(lock);
    }
    for (const id of imported) {
      const s = scope === "project" ? "project" : scope === "global" ? "global" : "off";
      setSkillScope({ id, scope: s, projectRoot: s === "project" ? projectRoot : projectRoot });
    }
    return { ok: true, imported, message: `Imported ${imported.length} skill(s) from ${repoInput}` };
  }

  async function updatePackage(args = {}) {
    const { id } = args;
    const pkgId = packageDirectoryName(id);
    const target = packagePath(id);
    const dirs = listDirs(hubPackagesDir);
    const exact = dirs.find((d) => path.basename(d) === pkgId);
    if (!exact) return { ok: false, error: "Package not found: " + id };
    const pkgDir = target;
    assertSafeFsPath(pkgDir, path.join(pkgDir, ".git"));
    if (!dirExists(path.join(pkgDir, ".git"))) throw new Error("not a git package: " + pkgId);
    await execFileAsync("git", ["pull", "--ff-only"], { cwd: pkgDir });
    packagePath(id);
    const skillDirs = findSkillDirsRecursive(pkgDir, 5);
    const updated = [];
    for (const sd of skillDirs) {
      const sid = sd === pkgDir ? path.basename(pkgDir).split("__").pop() : path.basename(sd);
      try { assertSafeSkillId(sid); } catch { continue; }
      const dest = canonicalPath(sid);
      assertContained(hubSkillsDir, dest);
      if (lstatSafe(dest)) clearIncompleteCanonical(dest, hubDir);
      cpDirRecursive(sd, dest);
      stampManagedDir(dest);
      updated.push(sid);
    }
    return { ok: true, package: pkgId, updated };
  }

  async function removePackage(args = {}) {
    const { id } = args;
    const projectRoot = args.projectRoot || null;
    const pkgId = packageDirectoryName(id);
    const pkgDir = packagePath(id, { allowLeafSymlink: true });
    const st = lstatSafe(pkgDir);
    if (st?.isSymbolicLink()) {
      fs.unlinkSync(pkgDir);
      return { ok: true, package: pkgId, removedSkills: [] };
    }
    let skillIds = [];
    if (dirExists(pkgDir)) {
      skillIds = findSkillDirsRecursive(pkgDir, 5).map((d) => (d === pkgDir ? path.basename(pkgDir).split("__").pop() : path.basename(d)));
      skillIds = [...new Set(skillIds)];
    } else {
      const lock = readLock();
      skillIds = Object.values(lock.skills || {}).filter((e) => e.package === pkgId).map((e) => e.id);
    }
    for (const sid of skillIds) {
      try { setSkillScope({ id: sid, scope: "off", projectRoot }); } catch {}
    }
    packagePath(id);
    if (st?.isDirectory()) fs.rmSync(pkgDir, { recursive: true, force: true });
    return { ok: true, package: pkgId, removedSkills: skillIds };
  }

  function estimateTokens(text) { return Math.ceil(Buffer.byteLength(text || "", "utf8") / 3.5); }
  function getAgentsMd(args = {}) {
    const projectRoot = args.projectRoot || null;
    let globalContent = "";
    if (!fileExists(hubGlobalAgentsPath)) {
      const seed = path.join(codexDir, "AGENTS.md");
      if (fileExists(seed)) {
        safeMkdir(hubDir);
        try { globalContent = fs.readFileSync(seed, "utf8"); fs.writeFileSync(hubGlobalAgentsPath, globalContent, "utf8"); } catch {}
      }
    } else { try { globalContent = fs.readFileSync(hubGlobalAgentsPath, "utf8"); } catch {} }
    const targets = [];
    const cands = [
      path.join(codexDir, "AGENTS.md"),
      path.join(homeDir, ".pi", "agent", "AGENTS.md"),
      path.join(homeDir, ".config", "muse", "AGENTS.md"),
      path.join(homeDir, ".claude", "CLAUDE.md"),
    ];
    for (const c of cands) {
      if (c === cands[0] || dirExists(path.dirname(c))) {
        try { if (fs.readFileSync(c, "utf8") === globalContent && globalContent) targets.push(c); } catch {}
      }
    }
    let projectContent = "", projectPath = null, projectExists = false;
    if (projectRoot) {
      projectPath = path.join(projectRoot, "AGENTS.md");
      if (fileExists(projectPath)) { projectExists = true; try { projectContent = fs.readFileSync(projectPath, "utf8"); } catch {} }
    }
    return {
      ok: true, globalContent, globalTokens: estimateTokens(globalContent), globalSyncedTargets: targets,
      projectContent, projectExists, projectTokens: estimateTokens(projectContent), projectPath,
      agyTargetHint: path.join(agyRoot, "<instance>", "config", "AGENTS.md"),
    };
  }
  function atomicWrite(file, content) {
    safeMkdir(path.dirname(file));
    const tmp = file + ".tmp-" + process.pid + "-" + Date.now();
    fs.writeFileSync(tmp, content, "utf8");
    fs.renameSync(tmp, file);
  }
  function backupProjectAgentsMd(projectRoot) {
    if (!projectRoot) return;
    const p = path.join(projectRoot, "AGENTS.md");
    if (!fileExists(p)) return;
    const bak = p + ".bak-t3hub";
    if (!fileExists(bak)) { try { fs.copyFileSync(p, bak); } catch {} }
    try { ensureExclude(projectRoot, ["AGENTS.md.bak-t3hub"]); } catch {}
  }
  function syncOne(target, content) {
    const bak = target + ".bak-t3hub";
    if (fileExists(target) && !fileExists(bak)) { try { fs.copyFileSync(target, bak); } catch {} }
    atomicWrite(target, content);
    return target;
  }
  function saveAgentsMd(args = {}) {
    const { target, content } = args;
    const projectRoot = args.projectRoot || null;
    if (typeof content !== "string") throw new Error("content must be string");
    if (target === "global") {
      atomicWrite(hubGlobalAgentsPath, content);
      const synced = [syncOne(path.join(codexDir, "AGENTS.md"), content)];
      const pi = path.join(homeDir, ".pi", "agent", "AGENTS.md");
      if (dirExists(path.dirname(pi))) synced.push(syncOne(pi, content));
      const mu = path.join(homeDir, ".config", "muse", "AGENTS.md");
      if (dirExists(path.dirname(mu))) synced.push(syncOne(mu, content));
      const cl = path.join(homeDir, ".claude", "CLAUDE.md");
      if (dirExists(path.dirname(cl))) synced.push(syncOne(cl, content));
      return { ok: true, tokens: estimateTokens(content), syncedTargets: synced, agyTargetHint: path.join(agyRoot, "<instance>", "config", "AGENTS.md") };
    } else if (target === "project") {
      if (!projectRoot || !path.isAbsolute(projectRoot)) throw new Error("projectRoot required");
      const p = path.join(projectRoot, "AGENTS.md");
      backupProjectAgentsMd(projectRoot);
      atomicWrite(p, content);
      return { ok: true, tokens: estimateTokens(content), syncedTargets: [p] };
    }
    throw new Error("invalid target");
  }
  function injectSoftRoute(args = {}) {
    const { projectRoot } = args;
    if (!projectRoot || !dirExists(projectRoot)) throw new Error("projectRoot required");
    const p = path.join(projectRoot, "AGENTS.md");
    let content = "";
    if (fileExists(p)) { try { content = fs.readFileSync(p, "utf8"); } catch {} }
    const section = [
      "<!-- t3-hub-memory-route -->",
      "## Shared memory (T3 Hub)",
      "1. Before debugging or architectural edits, call `memory_search` (or `node ~/.t3/hub/bin/pc-lite.mjs recall --query \"...\"`) to read shared project rules & pitfalls.",
      "2. On the FINAL turn after verifying a non-obvious pitfall or new durable constraint, piggyback on the warm cache by calling `memory_write` in the same turn (0 extra input tokens; never store unverified chatter or secrets).",
    ].join("\n");
    const marker = "<!-- t3-hub-memory-route -->";
    if (content.includes(marker)) {
      const re = /<!-- t3-hub-memory-route -->[\s\S]*?(?=\n<!-- |\n## |\n# |$)/;
      content = content.replace(re, section);
    } else {
      content = (content.trim() ? content.replace(/\s+$/, "") + "\n\n" : "") + section + "\n";
    }
    backupProjectAgentsMd(projectRoot);
    atomicWrite(p, content);
    const claudeMd = path.join(projectRoot, "CLAUDE.md");
    if (fileExists(claudeMd)) {
      let c = "";
      try { c = fs.readFileSync(claudeMd, "utf8"); } catch {}
      if (!c.includes("@AGENTS.md")) atomicWrite(claudeMd, "@AGENTS.md\n" + c);
    }
    return { ok: true, content, tokens: estimateTokens(content) };
  }

  return { homeDir, hubDir, listAssets, listSkills, toggleSkillForAgent, setSkillScope, importFromGitHub, updatePackage, removePackage, getAgentsMd, saveAgentsMd, injectSoftRoute };
}

let _singleton = null;
function getDefaultSkillsManager() {
  if (!_singleton) _singleton = createSkillsManager();
  return _singleton;
}
function listAssets(args) { return getDefaultSkillsManager().listAssets(args || {}); }
function setSkillScope(args) { return getDefaultSkillsManager().setSkillScope(args || {}); }
async function importFromGitHub(args) { return getDefaultSkillsManager().importFromGitHub(args || {}); }
async function updatePackage(args) { return getDefaultSkillsManager().updatePackage(args || {}); }
async function removePackage(args) { return getDefaultSkillsManager().removePackage(args || {}); }
function getAgentsMd(args) { return getDefaultSkillsManager().getAgentsMd(args || {}); }
function saveAgentsMd(args) { return getDefaultSkillsManager().saveAgentsMd(args || {}); }
function injectSoftRoute(args) { return getDefaultSkillsManager().injectSoftRoute(args || {}); }
function listSkills(args) { return getDefaultSkillsManager().listSkills(args || {}); }
function toggleSkillForAgent(args) { return getDefaultSkillsManager().toggleSkillForAgent(args || {}); }

module.exports = {
  assertSafeFsPath,
  createSkillsManager,
  parseGitHubInput,
  listAssets, listSkills, toggleSkillForAgent, setSkillScope, importFromGitHub, updatePackage, removePackage,
  getAgentsMd, saveAgentsMd, injectSoftRoute,
  getDefaultSkillsManager,
  default: getDefaultSkillsManager(),
};


