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
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
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

function cpDirRecursive(src, dest) {
  if (!dirExists(src)) return false;
  safeMkdir(dest);
  for (const entry of fs.readdirSync(src)) {
    if (entry === ".git") continue;
    const s = path.join(src, entry), d = path.join(dest, entry);
    const st = lstatSafe(s);
    if (!st) continue;
    if (st.isDirectory() && !st.isSymbolicLink()) cpDirRecursive(s, d);
    else if (st.isSymbolicLink()) {
      const t = fs.readlinkSync(s);
      fs.symlinkSync(t, d);
    } else fs.copyFileSync(s, d);
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
  const parent = path.resolve(String(parentDir));
  const child = path.resolve(String(childPath));
  if (!child.startsWith(parent + path.sep)) throw new Error("invalid skill id: path escapes parent");
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
    if (!dirExists(dir)) return;
    if (fileExists(path.join(dir, "SKILL.md"))) out.push(dir);
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
  if (/[;\n\r$`&|\\<>(){}!'"*?~]/.test(input)) return null;
  if (input.startsWith("-")) return null;
  if (input.startsWith("file://")) {
    try {
      const p = decodeURIComponent(new URL(input).pathname);
      const base = path.basename(p.replace(/\/$/, ""));
      if (!base) return null;
      return { owner: "local", repo: base, subpath: "", cloneUrl: p, isLocal: true, pkgId: "local__" + base };
    } catch { return null; }
  }
  if (path.isAbsolute(input) || input.startsWith("./") || input.startsWith("../") || input.startsWith("~/")) {
    const p = input.startsWith("~/") ? path.join(os.homedir(), input.slice(2)) : input;
    const base = path.basename(path.resolve(p).replace(/\/$/, ""));
    if (!base) return null;
    return { owner: "local", repo: base, subpath: "", cloneUrl: path.resolve(p), isLocal: true, pkgId: "local__" + base };
  }
  const gh = input.match(/^https:\/\/github\.com\/([^\/]+)\/([^\/\.]+?)(?:\.git)?(?:\/tree\/([^\/]+)(?:\/(.*))?)?\/?$/);
  if (gh) {
    const owner = gh[1], repo = gh[2];
    if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return null;
    if (owner.startsWith("-") || repo.startsWith("-")) return null;
    const subpath = gh[4] ? gh[4].replace(/^\/+|\/+$/g, "") : "";
    return { owner, repo, subpath, cloneUrl: `https://github.com/${owner}/${repo}.git`, isLocal: false, pkgId: `${owner}__${repo}` };
  }
  const short = input.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (short) {
    const owner = short[1], repo = short[2];
    if (owner.startsWith("-") || repo.startsWith("-")) return null;
    return { owner, repo, subpath: "", cloneUrl: `https://github.com/${owner}/${repo}.git`, isLocal: false, pkgId: `${owner}__${repo}` };
  }
  if (opts.allowCloneUrl) {
    if (input.startsWith("https://") || input.startsWith("git@")) {
      const m = input.match(/([^\/:]+)\/([^\/]+?)(?:\.git)?$/);
      if (m) return { owner: m[1], repo: m[2], subpath: "", cloneUrl: input, isLocal: false, pkgId: `${m[1]}__${m[2]}` };
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

  function readHubState() {
    const s = readJsonFile(hubStatePath, {});
    if (!s || typeof s !== "object") return {};
    return s;
  }
  function writeHubState(state) { writeJsonFile(hubStatePath, state); }

  function disabledSkillIds() {
    const out = new Set();
    const cfg = path.join(codexDir, "config.toml");
    let raw = "";
    try { raw = fs.readFileSync(cfg, "utf8"); } catch { return out; }
    const blocks = raw.split("[[skills.config]]");
    for (let i = 1; i < blocks.length; i++) {
      const b = blocks[i];
      const nm = b.match(/name\s*=\s*"([^"]+)"/);
      const dis = b.match(/disabled\s*=\s*(true|false)/);
      if (nm && dis && dis[1] === "true") out.add(nm[1]);
    }
    return out;
  }

  function readLock() {
    const raw = readJsonFile(lockPath, null);
    if (!raw) return { version: 3, skills: {} };
    if (Array.isArray(raw)) { const skills = {}; for (const e of raw) { if (e && e.id) skills[e.id] = e; } return { version: 3, skills }; }
    if (typeof raw === "object" && raw.skills && typeof raw.skills === "object") return { version: raw.version || 3, skills: raw.skills };
    if (typeof raw === "object") return { version: raw.version || 3, skills: raw };
    return { version: 3, skills: {} };
  }
  function writeLock(lock) { writeJsonFile(lockPath, lock); }

  function ensureCanonical(skillId) {
    assertSafeSkillId(skillId);
    const dest = path.join(hubSkillsDir, skillId);
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
    for (const pd of listDirs(hubPackagesDir)) {
      const found = findSkillDirsRecursive(pd, 4).find((d) => path.basename(d) === skillId);
      if (found) {
        if (lstatSafe(dest)) clearIncompleteCanonical(dest, hubDir);
        cpDirRecursive(found, dest);
        stampManagedDir(dest);
        return dest;
      }
      if (fileExists(path.join(pd, "SKILL.md")) && path.basename(pd) === skillId) {
        if (lstatSafe(dest)) clearIncompleteCanonical(dest, hubDir);
        cpDirRecursive(pd, dest);
        stampManagedDir(dest);
        return dest;
      }
    }
    if (dirExists(codexCacheDir)) {
      for (const mp of listDirs(codexCacheDir)) for (const pl of listDirs(mp)) {
        const cands = [pl];
        cands.push(path.join(pl, "skills", skillId));
        for (const c of cands) if (fileExists(path.join(c, "SKILL.md"))) {
          if (lstatSafe(dest)) clearIncompleteCanonical(dest, hubDir);
          cpDirRecursive(c, dest);
          stampManagedDir(dest);
          return dest;
        }
        const alt = findSkillDirsRecursive(pl, 4).find((d) => path.basename(d) === skillId);
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
      const dest = path.join(hubSkillsDir, skillId);
      assertContained(hubSkillsDir, dest);
      if (!dirExists(dest)) { safeMkdir(hubSkillsDir); cpDirRecursive(p, dest); stampManagedDir(dest); }
    } else if (st.isFile()) {
      const dest = path.join(hubSkillsDir, skillId);
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
      fs.writeFileSync(tmp, out, "utf8");
      fs.renameSync(tmp, excl);
    }
  }

  function listAssets(args = {}) {
    const projectRoot = args.projectRoot || null;
    const lock = readLock();
    const lockSkills = lock.skills || {};
    const disabled = disabledSkillIds();
    const byId = new Map();
    function addItem(it) {
      if (!it || !it.id) return;
      const existing = byId.get(it.id);
      if (!existing) { byId.set(it.id, it); return; }
      const rank = (s) => (s === "project" ? 0 : s === "global" ? 1 : s === "claude" || s === "zcode" ? 2 : s === "codex-market" ? 3 : s === "agy" ? 4 : 5);
      if (rank(it.source) < rank(existing.source)) byId.set(it.id, it);
    }
    function mkItem(id, dir, source, sourceLabel) {
      const meta = parseSkillMd(path.join(dir, "SKILL.md"));
      const lockEntry = lockSkills[id] || {};
      return {
        id, name: meta.name || id, description: meta.description || "",
        source, sourceLabel: sourceLabel || source,
        repoUrl: lockEntry.repoUrl || lockEntry.repo || lockEntry.url || "",
        scope: "off", path: dir,
        updatable: !!(lockEntry.repoUrl || lockEntry.repo || lockEntry.url),
      };
    }
    for (const d of listDirs(hubSkillsDir)) if (fileExists(path.join(d, "SKILL.md"))) addItem(mkItem(path.basename(d), d, "github", "hub"));
    for (const pd of listDirs(hubPackagesDir)) {
      if (fileExists(path.join(pd, "SKILL.md"))) { const id = path.basename(pd); addItem(mkItem(id, pd, "github", path.basename(pd))); }
      for (const sd of findSkillDirsRecursive(pd, 4)) { const id = path.basename(sd); if (fileExists(path.join(sd, "SKILL.md"))) addItem(mkItem(id, sd, "github", path.basename(pd))); }
    }
    if (dirExists(codexCacheDir)) {
      for (const mp of listDirs(codexCacheDir)) for (const pl of listDirs(mp)) {
        const plugId = path.basename(pl);
        if (fileExists(path.join(pl, "SKILL.md"))) addItem(mkItem(plugId, pl, "codex-market", `${path.basename(mp)}/${plugId}`));
        const inner = path.join(pl, "skills");
        if (dirExists(inner)) for (const sd of listDirs(inner)) if (fileExists(path.join(sd, "SKILL.md"))) addItem(mkItem(path.basename(sd), sd, "codex-market", `${path.basename(mp)}/${plugId}`));
      }
    }
    if (dirExists(agentsSkillsDir)) for (const d of listDirs(agentsSkillsDir)) if (fileExists(path.join(d, "SKILL.md"))) addItem(mkItem(path.basename(d), d, "global", "global"));
    if (dirExists(zcodeSkillsDir)) for (const d of listDirs(zcodeSkillsDir)) if (fileExists(path.join(d, "SKILL.md"))) addItem(mkItem(path.basename(d), d, "zcode", "zcode"));
    if (dirExists(claudeSkillsDir)) for (const d of listDirs(claudeSkillsDir)) if (fileExists(path.join(d, "SKILL.md"))) addItem(mkItem(path.basename(d), d, "claude", "claude"));
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
    const items = [...byId.values()].map((it) => {
      const g = path.join(agentsSkillsDir, it.id);
      const isGlobalActive = dirExists(g) && !disabled.has(it.id);
      const isProject = projectRoot ? dirExists(path.join(projectRoot, ".agents", "skills", it.id)) : false;
      let scope = "off";
      if (isGlobalActive) scope = "global";
      else if (isProject) scope = "project";
      return { ...it, scope, updatable: !!(it.repoUrl || it.source === "codex-market" || it.source === "github") };
    }).sort((a, b) => a.id.localeCompare(b.id));
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
    state.skills[id] = { scope, updatedAt: new Date().toISOString() };
    writeHubState(state);
    const listed = listAssets({ projectRoot });
    const item = listed.items.find((i) => i.id === id) || { id, name: id, description: "", source: "github", sourceLabel: "hub", repoUrl: "", scope, path: canonical, updatable: false };
    return { ok: true, item: { ...item, scope } };
  }

  async function importFromGitHub(args = {}) {
    const { repoInput } = args;
    const scope = args.scope || "project";
    const projectRoot = args.projectRoot || null;
    const parsed = parseGitHubInput(repoInput);
    if (!parsed) throw new Error("invalid repo input");
    if (!["off", "project", "global"].includes(scope)) throw new Error("invalid scope");
    if (scope === "project" && (!projectRoot || !dirExists(projectRoot))) throw new Error("projectRoot required for project scope");
    safeMkdir(hubPackagesDir); safeMkdir(hubSkillsDir);
    const pkgDir = path.join(hubPackagesDir, parsed.pkgId);
    if (dirExists(pkgDir) && dirExists(path.join(pkgDir, ".git"))) {
      await execFileAsync("git", ["pull", "--ff-only"], { cwd: pkgDir });
    } else if (dirExists(pkgDir)) {
      fs.rmSync(pkgDir, { recursive: true, force: true });
      await execFileAsync("git", ["clone", "--depth", "1", parsed.cloneUrl, pkgDir]);
    } else {
      await execFileAsync("git", ["clone", "--depth", "1", parsed.cloneUrl, pkgDir]);
    }
    const searchRoot = parsed.subpath ? path.join(pkgDir, parsed.subpath) : pkgDir;
    let skillDirs = findSkillDirsRecursive(searchRoot, 5);
    if (skillDirs.length === 0 && dirExists(pkgDir)) skillDirs = findSkillDirsRecursive(pkgDir, 5);
    const imported = [];
    for (const sd of skillDirs) {
      let id = path.basename(sd);
      if (sd === pkgDir) id = parsed.repo;
      try { assertSafeSkillId(id); } catch { continue; }
      const dest = path.join(hubSkillsDir, id);
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
    if (!id) throw new Error("id required");
    const pkgId = String(id).replace("/", "__");
    const dirs = listDirs(hubPackagesDir);
    const exact = dirs.find((d) => path.basename(d) === pkgId);
    if (!exact) return { ok: false, error: "Package not found: " + id };
    const pkgDir = exact;
    if (!dirExists(path.join(pkgDir, ".git"))) throw new Error("not a git package: " + pkgId);
    await execFileAsync("git", ["pull", "--ff-only"], { cwd: pkgDir });
    const skillDirs = findSkillDirsRecursive(pkgDir, 5);
    const updated = [];
    for (const sd of skillDirs) {
      const sid = sd === pkgDir ? path.basename(pkgDir).split("__").pop() : path.basename(sd);
      try { assertSafeSkillId(sid); } catch { continue; }
      const dest = path.join(hubSkillsDir, sid);
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
    if (!id) throw new Error("id required");
    const pkgId = String(id).replace("/", "__");
    const pkgDir = path.join(hubPackagesDir, pkgId);
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
    if (dirExists(pkgDir)) fs.rmSync(pkgDir, { recursive: true, force: true });
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

  return { homeDir, hubDir, listAssets, setSkillScope, importFromGitHub, updatePackage, removePackage, getAgentsMd, saveAgentsMd, injectSoftRoute };
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

module.exports = {
  createSkillsManager,
  parseGitHubInput,
  listAssets, setSkillScope, importFromGitHub, updatePackage, removePackage,
  getAgentsMd, saveAgentsMd, injectSoftRoute,
  getDefaultSkillsManager,
  default: getDefaultSkillsManager(),
};


