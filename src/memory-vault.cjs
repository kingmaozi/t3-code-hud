"use strict";
// T3 Hub local memory vault: Markdown + SQLite FTS5 + optional local vectors.
// Vault layout: <vaultDir>/projects/<slug>/ + <vaultDir>/global/ + index.sqlite.
// Source of truth is the per-module Markdown files; index.sqlite is the
// searchable projection. Manual Markdown edits are reconciled back into the
// index by syncFromMarkdownIfChanged() via file mtime checks.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const MODULES = ["constraints", "architecture", "pitfalls", "topics"];
const MODULE_FILES = {
  constraints: "constraints.md",
  architecture: "architecture.md",
  pitfalls: "pitfalls.md",
  topics: "topics.md",
};
const MODULE_HEADERS = {
  constraints: "# 📌 项目铁律与约束",
  architecture: "# 🏗️ 架构与核心决策",
  pitfalls: "# 🪤 排障与踩坑经验",
  topics: "# 📚 模块专题与交接",
};
const MODULE_DEFAULT_KIND = {
  constraints: "constraint",
  architecture: "decision",
  pitfalls: "pitfall",
  topics: "topic",
};
const GLOBAL_SLUG = "_global";
const GLOBAL_TITLE = "全局通用记忆";
const SECRET_ERROR = "检测到疑似密钥或凭据，已拦截写入";
const DEFAULT_EMBED_URL = "http://127.0.0.1:8001/v1/embeddings";
const EMBED_TIMEOUT_MS = 800;
const ASYNC_SINGLE_EMBED_TIMEOUT_MS = 10000;
const BATCH_EMBED_TIMEOUT_MS = 30000;

// Mirrors ~/.agents/skills/powercontext-memory/scripts/pc.mjs SECRET_PATTERN.
const SECRET_PATTERN =
  /(?:(?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|access[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|authorization|(?:set-)?cookie|session[_-]?id|phpsessid|jsessionid|connect\.sid|[A-Za-z0-9]*(?:password|passwd|pwd)|secret|private[_-]?key|client[_-]?secret)["']?\s*[:=]\s*\S+|\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#@]+:[^\s/?#@]+@|\b(?:sk|rk)_live_[A-Za-z0-9]{8,}|\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])|\bbearer\s+[A-Za-z0-9._~+/=-]{8,}|\bsk-[A-Za-z0-9_-]{8,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b|-----BEGIN [^-]*PRIVATE KEY-----)/iu;

function safeMkdir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}
function dirExists(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function fileExists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJsonFileAtomic(file, obj) {
  safeMkdir(path.dirname(file));
  const tmp = file + ".tmp-" + process.pid + "-" + crypto.randomBytes(4).toString("hex");
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}
function writeTextAtomic(file, text) {
  safeMkdir(path.dirname(file));
  const tmp = file + ".tmp-" + process.pid + "-" + crypto.randomBytes(4).toString("hex");
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}
function nowIso() {
  return new Date().toISOString();
}
function containsSecret(value) {
  if (typeof value !== "string" || !value) return false;
  return SECRET_PATTERN.test(value);
}
function normalizeSpace(s) {
  return String(s ?? "")
    .replace(/\s+/gu, " ")
    .trim();
}
function contentHashFor(content) {
  return crypto.createHash("sha256").update(normalizeSpace(content)).digest("hex");
}
function normalizeProjectRoot(projectRoot) {
  if (projectRoot == null) return null;
  const raw = String(projectRoot);
  try {
    return fs.realpathSync(raw);
  } catch {
    try {
      return path.resolve(raw);
    } catch {
      return raw;
    }
  }
}
function scopeHashFor(projectRoot) {
  if (!projectRoot) return null;
  try {
    return crypto.createHash("sha256").update(normalizeProjectRoot(String(projectRoot))).digest("hex");
  } catch {
    return null;
  }
}
function slugify(raw) {
  let s = String(raw ?? "").trim();
  if (!s) return "project";
  s = s.replace(/[\/\\\0-\x1f\x7f]/g, "-");
  s = s.replace(/\s+/g, "-");
  s = s.replace(/-+/g, "-").replace(/^-|-$/g, "");
  s = s.replace(/[^\p{L}\p{N}_-]/gu, "");
  s = s.replace(/-+/g, "-").replace(/^-|-$/g, "");
  return s || "project";
}
function slugFromProjectRoot(projectRoot) {
  const resolved = normalizeProjectRoot(String(projectRoot)) || path.resolve(String(projectRoot));
  const base = path.basename(resolved) || resolved;
  return slugify(base);
}
function resolveWorktreeContext(cwd) {
  const raw = cwd == null ? "" : String(cwd);
  if (!raw) {
    return { canonicalProjectRoot: null, worktreePath: null, worktreeId: "", worktreeName: "", branchName: "", isLinkedWorktree: false, canonicalSlug: null };
  }
  let worktreePath = "";
  try { worktreePath = fs.realpathSync(raw); } catch { worktreePath = path.resolve(raw); }
  let cur = worktreePath;
  while (true) {
    const gitPath = path.join(cur, ".git");
    let st = null;
    try { st = fs.lstatSync(gitPath); } catch { st = null; }
    if (st) {
      if (st.isDirectory()) {
        let branchName = "";
        try {
          const head = fs.readFileSync(path.join(gitPath, "HEAD"), "utf8").trim();
          const m = head.match(/^ref:\s*refs\/heads\/(.+)$/);
          if (m) branchName = m[1].trim();
          else if (head && !head.startsWith("ref:")) branchName = head;
        } catch {}
        if (!branchName) {
          try {
            const r = spawnSync("git", ["-C", cur, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", timeout: 1000, maxBuffer: 2 * 1024 * 1024 });
            if (r.status === 0) {
              const out = r.stdout.trim();
              if (out && out !== "HEAD" && !out.startsWith("detached")) branchName = out;
            }
          } catch {}
        }
        return { canonicalProjectRoot: fs.realpathSync(cur) || cur, worktreePath: cur, worktreeId: "", worktreeName: "", branchName, isLinkedWorktree: false, canonicalSlug: slugFromProjectRoot(cur) };
      } else if (st.isFile()) {
        let gd = null;
        try {
          const gitFileContent = fs.readFileSync(gitPath, "utf8").trim();
          const m = gitFileContent.match(/^gitdir:\s*(.+)$/m);
          if (m) {
            gd = m[1].trim();
            if (!path.isAbsolute(gd)) gd = path.resolve(cur, gd);
          }
        } catch {}
        if (gd) {
          let commonGitDir = null;
          try {
            const commondirFile = path.join(gd, "commondir");
            if (fileExists(commondirFile)) {
              const cd = fs.readFileSync(commondirFile, "utf8").trim();
              if (cd) commonGitDir = path.isAbsolute(cd) ? cd : path.resolve(gd, cd);
            }
          } catch {}
          if (!commonGitDir) {
            commonGitDir = path.resolve(gd, "../..");
            if (!dirExists(commonGitDir)) {
              try {
                const r = spawnSync("git", ["-C", worktreePath, "rev-parse", "--git-common-dir"], { encoding: "utf8", timeout: 1000, maxBuffer: 2 * 1024 * 1024 });
                if (r.status === 0) {
                  let out = r.stdout.trim();
                  if (!path.isAbsolute(out)) out = path.resolve(worktreePath, out);
                  commonGitDir = out;
                }
              } catch {}
            }
          }
          const canonicalRoot = path.dirname(commonGitDir);
          const worktreeName = path.basename(gd);
          let branchName = "";
          try {
            const headPath = path.join(gd, "HEAD");
            if (fileExists(headPath)) {
              const head = fs.readFileSync(headPath, "utf8").trim();
              const m2 = head.match(/^ref:\s*refs\/heads\/(.+)$/);
              if (m2) branchName = m2[1].trim();
              else if (head && !head.startsWith("ref:")) branchName = head;
            }
          } catch {}
          if (!branchName) {
            try {
              const r = spawnSync("git", ["-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", timeout: 1000, maxBuffer: 2 * 1024 * 1024 });
              if (r.status === 0) {
                const out = r.stdout.trim();
                if (out && out !== "HEAD" && !out.startsWith("detached")) branchName = out;
              }
            } catch {}
          }
          let canon = canonicalRoot;
          try { canon = fs.realpathSync(canonicalRoot); } catch { canon = path.resolve(canonicalRoot); }
          return { canonicalProjectRoot: canon, worktreePath: cur, worktreeId: slugify(worktreeName), worktreeName, branchName, isLinkedWorktree: true, canonicalSlug: slugFromProjectRoot(canon) };
        }
        // Fallback via git rev-parse
        try {
          const r = spawnSync("git", ["-C", worktreePath, "rev-parse", "--git-common-dir"], { encoding: "utf8", timeout: 1000, maxBuffer: 2 * 1024 * 1024 });
          if (r.status === 0) {
            let out = r.stdout.trim();
            if (!path.isAbsolute(out)) out = path.resolve(worktreePath, out);
            const canon = path.dirname(out);
            let b = "";
            try { const r2 = spawnSync("git", ["-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", timeout: 1000, maxBuffer: 2 * 1024 * 1024 }); if (r2.status === 0) b = r2.stdout.trim(); } catch {}
            if (b === "HEAD" || b.startsWith("detached")) b = "";
            return { canonicalProjectRoot: canon, worktreePath, worktreeId: "", worktreeName: "", branchName: b, isLinkedWorktree: true, canonicalSlug: slugFromProjectRoot(canon) };
          }
        } catch {}
      }
      break;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return { canonicalProjectRoot: worktreePath, worktreePath, worktreeId: "", worktreeName: "", branchName: "", isLinkedWorktree: false, canonicalSlug: slugFromProjectRoot(worktreePath) };
}
function inferScopeFromKindAndTags(kind, tags) {
  const k = String(kind ?? "").trim().toLowerCase();
  const tagSet = Array.isArray(tags) ? tags.map((t) => String(t).toLowerCase()) : [];
  if (["progress", "wip", "scratch"].includes(k) || tagSet.includes("wip") || tagSet.includes("worktree")) return "worktree";
  return "shared";
}
function kindToModule(kind) {
  const k = String(kind ?? "").trim().toLowerCase();
  if (k === "constraint" || k === "preference") return "constraints";
  if (k === "decision" || k === "fact") return "architecture";
  if (k === "pitfall" || k === "experience" || k === "working_note" || k === "troubleshooting") return "pitfalls";
  if (k === "topic" || k === "handoff") return "topics";
  return "topics";
}
function generateMemId() {
  return "mem_" + crypto.randomBytes(12).toString("hex");
}
function cosine(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na <= 0 || nb <= 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
function tagsToText(tags) {
  if (Array.isArray(tags)) return tags.join(" ");
  return String(tags ?? "");
}
function escapeLike(term) {
  return String(term).replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}
function revisionMeta(value = {}) {
  return {
    version: Number.isInteger(value.version) && value.version > 0 ? value.version : 1,
    hitCount: Number.isInteger(value.hitCount) && value.hitCount >= 0 ? value.hitCount : 0,
    lastRecalledAt: value.lastRecalledAt || null,
    supersedesId: value.supersedesId || null,
    history: Array.isArray(value.history) ? value.history.slice(-10).map((entry, index) => ({
      ...entry,
      // Legacy histories get deterministic IDs so reads and index rebuilds do
      // not change the selector shown in an already-open drawer.
      revisionId: entry.revisionId || "rev_" + crypto.createHash("sha256")
        .update(JSON.stringify([value.id || null, index, entry])).digest("hex").slice(0, 32),
    })) : [],
  };
}
function snapshot(item, reason) {
  return { revisionId: "rev_" + crypto.randomUUID(), version: item.version || 1, title: item.title, content: item.content,
    updatedAt: item.updatedAt, agent: item.agent, reason };
}
function lexicalTokens(text) {
  const tokens = new Set();
  for (const run of String(text || "").toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []) {
    // CJK bigrams bridge spaces/punctuation naturally without treating an
    // entire Chinese sentence as one word. Latin words remain whole tokens.
    for (const part of run.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu) || []) {
      if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(part)) {
        const chars = [...part];
        if (chars.length === 1) tokens.add(part);
        for (let i = 0; i + 1 < chars.length; i++) tokens.add(chars[i] + chars[i + 1]);
      } else tokens.add(part);
    }
  }
  return tokens;
}
function jaccard(a, b) {
  const union = new Set([...a, ...b]);
  if (!union.size) return 0;
  let common = 0;
  for (const token of a) if (b.has(token)) common++;
  return common / union.size;
}
function embeddingText(item) {
  // Only the active revision is ever sent to the embedding service.
  return (String(item.title || "") + "\n" + String(item.content || "")).slice(0, 8000);
}
function validVector(vec) {
  return (Array.isArray(vec) || vec instanceof Float32Array) && vec.length > 0 &&
    Array.from(vec).every(Number.isFinite) && vec.some((n) => n !== 0);
}
function extractMemoryLinks(text) {
  if (typeof text !== "string" || !text) return [];
  const found = [];
  const re = /\[\[([^\]\[\n]{1,200}?)\]\]/g;
  let m;
  const seen = new Set();
  while ((m = re.exec(text)) !== null) {
    let t = String(m[1] || "").trim();
    if (!t) continue;
    // 去重、限长：单目标限 200 字符，总数限 200 个
    if (t.length > 200) t = t.slice(0, 200);
    if (seen.has(t)) continue;
    seen.add(t);
    found.push(t);
    if (found.length >= 200) break;
  }
  return found;
}
function parseMarkdownEntries(text, fallbackKind) {
  const entries = [];
  if (typeof text !== "string" || !text) return entries;
  const lines = text.split(/\r?\n/);
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const content = cur.contentLines.join("\n").trim();
    entries.push({
      id: cur.marker && cur.marker.id ? String(cur.marker.id) : null,
      title: cur.title || "(无标题)",
      kind: cur.marker && cur.marker.kind ? String(cur.marker.kind) : fallbackKind,
      agent: cur.marker && cur.marker.agent ? String(cur.marker.agent) : "user",
      tags: cur.marker && Array.isArray(cur.marker.tags) ? cur.marker.tags.map(String) : [],
      createdAt: cur.marker && cur.marker.createdAt ? String(cur.marker.createdAt) : null,
      updatedAt: cur.marker && cur.marker.updatedAt ? String(cur.marker.updatedAt) : null,
      scope: cur.marker && (cur.marker.scope || cur.marker.memory_scope) ? String(cur.marker.scope || cur.marker.memory_scope) : null,
      worktreeId: cur.marker && (cur.marker.worktree_id || cur.marker.worktreeId) ? String(cur.marker.worktree_id || cur.marker.worktreeId) : null,
      branchName: cur.marker && (cur.marker.branch || cur.marker.branch_name || cur.marker.branchName) ? String(cur.marker.branch || cur.marker.branch_name || cur.marker.branchName) : null,
      content,
      ...revisionMeta({ ...(cur.meta || cur.marker || {}), id: cur.marker?.id }),
      _hasMeta: Boolean(cur.meta),
      _marker: cur.marker || null,
      _hasMarker: Boolean(cur.marker),
    });
    cur = null;
  };
  for (const line of lines) {
    if (line.startsWith("## ")) {
      flush();
      cur = { title: line.slice(3).trim(), marker: null, meta: null, contentLines: [] };
      continue;
    }
    if (cur) {
      const t = line.trim();
      if (t.startsWith("<!-- meta:") && t.endsWith("-->")) {
        try { cur.meta = JSON.parse(t.slice("<!-- meta:".length, -3).trim()); } catch {}
        continue;
      }
      if (!cur.marker && t.startsWith("<!-- mem:") && t.endsWith("-->")) {
        try {
          cur.marker = JSON.parse(t.slice("<!-- mem:".length, -3).trim());
        } catch {
          cur.marker = null;
        }
        continue;
      }
      // Skip the file H1 header line if it appears before first entry.
      cur.contentLines.push(line);
    }
  }
  flush();
  return entries;
}
function serializeEntries(module, entries) {
  const header = MODULE_HEADERS[module] || "# 记忆";
  const parts = [header, ""];
  for (const e of entries) {
    const marker = {
      id: e.id,
      kind: e.kind || MODULE_DEFAULT_KIND[module] || "fact",
      agent: e.agent || "user",
      tags: Array.isArray(e.tags) ? e.tags : [],
      createdAt: e.createdAt || e.updatedAt || nowIso(),
      updatedAt: e.updatedAt || nowIso(),
    };
    if (e.scope) marker.scope = String(e.scope);
    if (e.worktreeId) marker.worktree_id = String(e.worktreeId);
    if (e.branchName) marker.branch = String(e.branchName);
    const title = e.title || "(无标题)";
    const content = e.content || "";
    parts.push("## " + title);
    parts.push("<!-- mem:" + JSON.stringify(marker) + " -->");
    // Escape angle brackets so historical HTML/comment text cannot close the
    // comment. JSON parsing restores the exact original revision text.
    parts.push("<!-- meta: " + JSON.stringify(revisionMeta(e)).replace(/</g, "\\u003c").replace(/>/g, "\\u003e") + " -->");
    parts.push(content);
    parts.push("");
  }
  return parts.join("\n").replace(/\n{3,}$/g, "\n\n").replace(/\n{3,}/g, "\n\n\n");
}
function createMemoryVault(opts = {}) {
  const homeDir = opts.homeDir || process.env.HOME || os.homedir();
  const hubDir = opts.hubDir || process.env.T3_HUB_DIR || path.join(homeDir, ".t3", "hub");
  const vaultDir =
    opts.vaultDir || opts.vaultRoot || opts.dir || process.env.T3_MEMORY_VAULT_DIR || process.env.T3_HUB_MEMORY_DIR || path.join(hubDir, "memory");
  const indexDbPath = path.join(vaultDir, "index.sqlite");
  const receiptPath = path.join(vaultDir, "migration-receipt.json");
  const embedUrl = opts.embeddingUrl || process.env.T3_EMBED_URL || DEFAULT_EMBED_URL;
  const hasExplicitEmbedTimeout = opts.embeddingTimeoutMs != null;
  const embedTimeoutMs = hasExplicitEmbedTimeout ? Number(opts.embeddingTimeoutMs) : EMBED_TIMEOUT_MS;
  const embedFn = opts._embedFn || opts.embedFn || null;
  const healthFn = opts._healthFn || opts.healthFn || null;
  const embedHealthUrl = opts.embeddingHealthUrl || embedUrl.replace(/\/v1\/embeddings\/?$/, "/health");
  const vaultAutoConsolidateThreshold = opts.autoConsolidateThreshold != null ? Number(opts.autoConsolidateThreshold) : 60;
  let _healthCache = { modelId: null, dim: null, at: 0 };
  let _reindexing = false;

  function projectsDir() {
    return path.join(vaultDir, "projects");
  }
  function projectDirFor(slug) {
    if (slug === GLOBAL_SLUG) return path.join(vaultDir, "global");
    return path.join(projectsDir(), String(slug));
  }
  function ensureVaultDirs() {
    safeMkdir(vaultDir);
    safeMkdir(projectsDir());
    safeMkdir(path.join(vaultDir, "global"));
  }
  function openDb() {
    ensureVaultDirs();
    const db = new DatabaseSync(indexDbPath);
    try {
      db.exec("PRAGMA busy_timeout = 5000;");
      db.exec("PRAGMA journal_size_limit = 4194304;");
      db.exec("PRAGMA cache_size = -16000;");
      db.exec("PRAGMA synchronous = NORMAL;");
    } catch {}
    db.exec(
      "CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY, project_slug TEXT NOT NULL, project_root TEXT, module TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, agent TEXT NOT NULL, tags_json TEXT NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);" +
        "CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id UNINDEXED, title, content, tags, tokenize='unicode61');" +
        "CREATE TABLE IF NOT EXISTS memory_vectors(id TEXT PRIMARY KEY, model_id TEXT NOT NULL, dim INTEGER NOT NULL, vec_f32 BLOB NOT NULL, updated_at TEXT NOT NULL);" +
        "CREATE TABLE IF NOT EXISTS vault_sync(file_path TEXT PRIMARY KEY, mtime_ms REAL NOT NULL, content_hash TEXT NOT NULL);" +
        "CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_slug);" +
        "CREATE INDEX IF NOT EXISTS idx_memories_module ON memories(project_slug, module);" +
        "CREATE INDEX IF NOT EXISTS idx_memories_hash ON memories(project_slug, module, content_hash);"
    );
    // Existing v1 projections remain usable; duplicate-column errors are
    // expected on subsequent opens. Other migration failures must surface.
    for (const column of ["version INTEGER NOT NULL DEFAULT 1", "hit_count INTEGER NOT NULL DEFAULT 0",
      "last_recalled_at TEXT", "history_json TEXT NOT NULL DEFAULT '[]'", "supersedes_id TEXT", "memory_scope TEXT NOT NULL DEFAULT 'shared'", "worktree_id TEXT NOT NULL DEFAULT ''", "branch_name TEXT NOT NULL DEFAULT ''"]) {
      try { db.exec("ALTER TABLE memories ADD COLUMN " + column); }
      catch (e) { if (!/duplicate column name/i.test(e.message)) { db.close(); throw e; } }
    }
    return db;
  }
  function worktreeDirFor(slug, worktreeId) {
    return path.join(projectDirFor(slug), "_worktrees", String(worktreeId));
  }
  function worktreeModuleFileFor(slug, worktreeId, module) {
    return path.join(worktreeDirFor(slug, worktreeId), MODULE_FILES[module]);
  }
  function moduleFileFor(slug, module) {
    return path.join(projectDirFor(slug), MODULE_FILES[module]);
  }
  function readMetaFor(slug) {
    return readJsonFile(path.join(projectDirFor(slug), "_meta.json"), null);
  }
  function ensureProjectVault(slug, { title, projectRoot } = {}) {
    ensureVaultDirs();
    const dir = projectDirFor(slug);
    safeMkdir(dir);
    const metaPath = path.join(dir, "_meta.json");
    let meta = readJsonFile(metaPath, null);
    const t = nowIso();
    if (!meta || typeof meta !== "object") {
      meta = {
        slug,
        title: title || (slug === GLOBAL_SLUG ? GLOBAL_TITLE : slug),
        projectRoot: projectRoot || null,
        scopeHash: projectRoot ? scopeHashFor(projectRoot) : null,
        createdAt: t,
        updatedAt: t,
      };
    } else {
      if (title && !meta.title) meta.title = title;
      if (projectRoot && !meta.projectRoot) {
        meta.projectRoot = projectRoot;
        meta.scopeHash = scopeHashFor(projectRoot);
      }
      meta.slug = slug;
      meta.updatedAt = meta.updatedAt || t;
    }
    writeJsonFileAtomic(metaPath, meta);
    for (const m of MODULES) {
      const f = path.join(dir, MODULE_FILES[m]);
      if (!fileExists(f)) {
        writeTextAtomic(f, MODULE_HEADERS[m] + "\n\n");
        try {
          const st = fs.statSync(f);
          const db = openDb();
          try {
            db.prepare("INSERT OR REPLACE INTO vault_sync(file_path, mtime_ms, content_hash) VALUES (?,?,?)").run(
              f,
              st.mtimeMs,
              crypto.createHash("sha256").update(fs.readFileSync(f, "utf8")).digest("hex")
            );
          } finally {
            db.close();
          }
        } catch {}
      }
    }
    return meta;
  }
  function recordSyncState(filePath, transactionDb = null) {
    try {
      const st = fs.statSync(filePath);
      const text = fs.readFileSync(filePath, "utf8");
      const h = crypto.createHash("sha256").update(text).digest("hex");
      const db = transactionDb || openDb();
      try {
        db.prepare("INSERT OR REPLACE INTO vault_sync(file_path, mtime_ms, content_hash) VALUES (?,?,?)").run(filePath, st.mtimeMs, h);
      } finally {
        if (!transactionDb) db.close();
      }
    } catch (e) { if (transactionDb) throw e; }
  }
  function rowToItem(row) {
    let tags = [];
    try {
      tags = JSON.parse(row.tags_json || "[]");
      if (!Array.isArray(tags)) tags = [];
    } catch {
      tags = [];
    }
    let history = [];
    try { history = JSON.parse(row.history_json || "[]"); } catch {}
    const scope = row.memory_scope || row.scope || "shared";
    const worktreeId = row.worktree_id || row.worktreeId || "";
    const branchName = row.branch_name || row.branchName || "";
    return {
      id: row.id,
      projectSlug: row.project_slug,
      module: row.module,
      kind: row.kind,
      title: row.title,
      content: row.content,
      agent: row.agent,
      tags,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      scope,
      memory_scope: scope,
      memoryScope: scope,
      worktreeId,
      worktree_id: worktreeId,
      branchName,
      branch_name: branchName,
      ...revisionMeta({ id: row.id, version: row.version, hitCount: row.hit_count, lastRecalledAt: row.last_recalled_at,
        supersedesId: row.supersedes_id, history }),
    };
  }
  function upsertRow(db, { id, projectSlug, projectRoot, module, kind, title, content, agent, tags, createdAt, updatedAt, scope, memoryScope, memory_scope, worktreeId, worktree_id, branchName, branch_name, branch, ...extra }) {
    const meta = revisionMeta(extra);
    const tagsJson = JSON.stringify(Array.isArray(tags) ? tags : []);
    const ch = contentHashFor(content);
    const _scope = String(scope || memoryScope || memory_scope || "shared");
    const _wid = String(worktreeId || worktree_id || "");
    const _br = String(branchName || branch_name || branch || "");
    db.prepare("DELETE FROM memories_fts WHERE id = ?").run(id);
    db.prepare(
      "INSERT INTO memories(id, project_slug, project_root, module, kind, title, content, agent, tags_json, content_hash, created_at, updated_at, memory_scope, worktree_id, branch_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_slug=excluded.project_slug, project_root=excluded.project_root, module=excluded.module, kind=excluded.kind, title=excluded.title, content=excluded.content, agent=excluded.agent, tags_json=excluded.tags_json, content_hash=excluded.content_hash, updated_at=excluded.updated_at, memory_scope=excluded.memory_scope, worktree_id=excluded.worktree_id, branch_name=excluded.branch_name"
    ).run(id, projectSlug, projectRoot || null, module, kind, title, content, agent, tagsJson, ch, createdAt, updatedAt, _scope, _wid, _br);
    db.prepare("UPDATE memories SET version=?, hit_count=?, last_recalled_at=?, history_json=?, supersedes_id=? WHERE id=?")
      .run(meta.version, meta.hitCount, meta.lastRecalledAt, JSON.stringify(meta.history), meta.supersedesId, id);
    db.prepare("INSERT INTO memories_fts(id, title, content, tags) VALUES (?,?,?,?)").run(id, title, content, tagsToText(tags));
  }
  function deleteRowById(db, id) {
    db.prepare("DELETE FROM memories WHERE id = ?").run(id);
    try {
      db.prepare("DELETE FROM memories_fts WHERE id = ?").run(id);
    } catch {}
    try {
      db.prepare("DELETE FROM memory_vectors WHERE id = ?").run(id);
    } catch {}
  }
  function rememberFileRollback(file, actions) {
    const previous = fs.existsSync(file) ? fs.readFileSync(file) : null;
    actions.push(() => {
      if (previous === null) { if (fs.existsSync(file)) fs.unlinkSync(file); }
      else fs.writeFileSync(file, previous);
    });
  }
  function rewriteModuleFile(slug, module, entries, transaction = null) {
    const f = moduleFileFor(slug, module);
    if (transaction?.rollbackActions) rememberFileRollback(f, transaction.rollbackActions);
    writeTextAtomic(f, serializeEntries(module, entries));
    recordSyncState(f, transaction && transaction.db);
  }
  function rewriteWorktreeModuleFile(slug, worktreeId, module, entries, transaction = null) {
    const f = worktreeModuleFileFor(slug, worktreeId, module);
    if (transaction?.rollbackActions) rememberFileRollback(f, transaction.rollbackActions);
    writeTextAtomic(f, serializeEntries(module, entries));
    recordSyncState(f, transaction && transaction.db);
  }
  function rewriteModules(db, slug, modules, transaction = null, deletedWorktreeHints = null) {
    for (const mod of new Set(modules)) {
      if (slug === GLOBAL_SLUG) {
        const rows = db.prepare("SELECT * FROM memories WHERE project_slug=? AND module=? ORDER BY created_at ASC, id ASC").all(slug, mod);
        rewriteModuleFile(slug, mod, rows.map(rowToItem), transaction);
        continue;
      }
      const sharedRows = db.prepare("SELECT * FROM memories WHERE project_slug=? AND module=? AND (memory_scope='shared' OR memory_scope IS NULL OR memory_scope='') ORDER BY created_at ASC, id ASC").all(slug, mod);
      rewriteModuleFile(slug, mod, sharedRows.map(rowToItem), transaction);
      // Include deleted worktrees and directories whose final row was removed.
      // Query, enumeration and write failures must reach journal recovery.
      const candidate = new Set(db.prepare("SELECT DISTINCT worktree_id FROM memories WHERE project_slug=? AND module=? AND memory_scope='worktree'").all(slug, mod).map((r) => String(r.worktree_id || "")).filter(Boolean));
      for (const h of deletedWorktreeHints || []) {
        const wid = typeof h === "string" ? h : (h && (h.worktree_id || h.worktreeId || h.id));
        if (wid) candidate.add(String(wid));
      }
      const wtRoot = path.join(projectDirFor(slug), "_worktrees");
      let dirs = [];
      try { dirs = fs.readdirSync(wtRoot, { withFileTypes: true }); }
      catch (e) { if (e.code !== "ENOENT") throw e; }
      for (const ent of dirs) if (ent.isDirectory()) candidate.add(ent.name);
      for (const wid of candidate) {
        const rows = db.prepare("SELECT * FROM memories WHERE project_slug=? AND module=? AND memory_scope='worktree' AND worktree_id=? ORDER BY created_at ASC, id ASC").all(slug, mod, wid);
        rewriteWorktreeModuleFile(slug, wid, mod, rows.map(rowToItem), transaction);
      }
    }
  }
  // ---- P1-A: dream worktree isolation helpers ----
  function normalizedDreamScopeFromRow(row) {
    const slug = String((row && row.project_slug) || "");
    let s = String((row && row.memory_scope) || "").trim();
    if (!s) s = (slug === GLOBAL_SLUG ? "global" : "shared");
    if (slug === GLOBAL_SLUG && !s) s = "global";
    return s;
  }
  function normalizedDreamScopeFromItem(it) {
    const slug = String((it && it.projectSlug) || "");
    let s = String((it && (it.scope || it.memoryScope || it.memory_scope)) || "").trim();
    if (!s) s = (slug === GLOBAL_SLUG ? "global" : "shared");
    if (slug === GLOBAL_SLUG && !s) s = "global";
    return s;
  }
  function normalizedWorktreeFromRow(row) {
    return String((row && row.worktree_id) || "").trim();
  }
  function normalizedWorktreeFromItem(it) {
    return String((it && (it.worktreeId || it.worktree_id)) || "").trim();
  }
  // ---- P1-B: durable journal crash recovery helpers ----
  function dreamTxJournalPath() {
    return path.join(vaultDir, "_state", "dream-tx-journal.json");
  }
  function snapshotFile(file) {
    try { return { exists: true, content: fs.readFileSync(file, "utf8") }; }
    catch (e) { if (e.code !== "ENOENT") throw e; return { exists: false, content: null }; }
  }
  function fsyncFile(file) {
    const fd = fs.openSync(file, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  function fsyncDir(dir) { fsyncFile(dir); }
  function restoreFile(file, snap) {
    if (!file || !snap) return;
    safeMkdir(path.dirname(file));
    if (snap.exists) {
      const tmp = file + ".tmp-" + process.pid + "-" + crypto.randomBytes(4).toString("hex");
      try {
        fs.writeFileSync(tmp, snap.content, "utf8");
        fsyncFile(tmp);
        fs.renameSync(tmp, file);
      } finally {
        try { fs.unlinkSync(tmp); } catch (e) { if (e.code !== "ENOENT") throw e; }
      }
      fsyncFile(file);
    } else {
      try { fs.unlinkSync(file); } catch (e) { if (e.code !== "ENOENT") throw e; }
    }
    fsyncDir(path.dirname(file));
  }
  function writeDreamTxJournal(obj) {
    restoreFile(dreamTxJournalPath(), { exists: true, content: JSON.stringify(obj, null, 2) + "\n" });
  }
  function clearDreamTxJournal() {
    const file = dreamTxJournalPath();
    let previous;
    try { previous = fs.readFileSync(file); }
    catch (e) { if (e.code === "ENOENT") return; throw e; }
    // Check directory durability before removing the last retry record.
    fsyncDir(path.dirname(file));
    fs.unlinkSync(file);
    try { fsyncDir(path.dirname(file)); }
    catch (e) {
      // If unlink durability failed, leave a retry record even if fsync fails again.
      fs.writeFileSync(file, previous);
      throw e;
    }
  }
  function dreamTxLockPath() { return path.join(vaultDir, "_state", "dream-tx.lock"); }
  function pidIsAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return true; // unknown owners are unsafe to steal
    try { process.kill(pid, 0); return true; }
    catch (e) { return e.code !== "ESRCH"; } // EPERM is alive
  }
  const DREAM_LOCK_CORRUPT_STALE_MS = 5000;
  function readDreamTxLock() {
    try {
      const parsed = JSON.parse(fs.readFileSync(dreamTxLockPath(), "utf8"));
      if (parsed && Number.isInteger(parsed.pid) && parsed.pid > 0 && typeof parsed.token === "string" && parsed.token) {
        return parsed;
      }
      return { pid: null, corrupt: true };
    } catch (e) {
      if (e.code === "ENOENT") return null;
      return { pid: null, corrupt: true };
    }
  }
  function acquireDreamTxLock() {
    const file = dreamTxLockPath();
    const dir = path.dirname(file);
    safeMkdir(dir);
    for (let attempt = 0; attempt < 4; attempt++) {
      const owner = { pid: process.pid, token: crypto.randomUUID(), createdAt: nowIso() };
      const tmp = file + ".tmp-" + process.pid + "-" + owner.token;
      let published = false;
      try {
        const fd = fs.openSync(tmp, "wx", 0o600);
        try {
          fs.writeFileSync(fd, JSON.stringify(owner) + "\n");
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        fs.linkSync(tmp, file);
        published = true;
      } catch (e) {
        try { fs.unlinkSync(tmp); } catch {}
        if (!e || e.code !== "EEXIST") throw e;
      } finally {
        if (published) {
          try { fs.unlinkSync(tmp); } catch {}
        }
      }
      if (published) {
        try {
          fsyncDir(dir);
        } catch (syncErr) {
          try {
            if (readDreamTxLock()?.token === owner.token) fs.unlinkSync(file);
          } catch {}
          throw syncErr;
        }
        return owner;
      }
      const existing = readDreamTxLock();
      if (!existing) continue;
      if (existing.corrupt) {
        let st = null;
        try { st = fs.lstatSync(file); } catch (e) { if (e.code === "ENOENT") continue; return null; }
        if (Date.now() - st.mtimeMs < DREAM_LOCK_CORRUPT_STALE_MS) {
          if (attempt < 3) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); continue; }
          return null;
        }
        const db = openDb();
        try {
          db.exec("BEGIN IMMEDIATE");
          let curStat = null;
          try { curStat = fs.lstatSync(file); } catch (e) { if (e.code !== "ENOENT") throw e; }
          const current = curStat ? readDreamTxLock() : null;
          if (curStat && curStat.ino === st.ino && current?.corrupt && Date.now() - curStat.mtimeMs >= DREAM_LOCK_CORRUPT_STALE_MS) {
            fs.unlinkSync(file);
            fsyncDir(dir);
          }
          db.exec("COMMIT");
        } finally { db.close(); }
        continue;
      }
      if (pidIsAlive(existing.pid)) return null;
      // Serialize stale-lock reapers using SQLite's process-safe write lock.
      const db = openDb();
      try {
        db.exec("BEGIN IMMEDIATE");
        const current = readDreamTxLock();
        if (current && current.token === existing.token && current.pid === existing.pid && !pidIsAlive(current.pid)) {
          fs.unlinkSync(file);
          fsyncDir(dir);
        }
        db.exec("COMMIT");
      } finally { db.close(); }
    }
    return null;
  }
  function releaseDreamTxLock(owner) {
    if (!owner) return;
    if (readDreamTxLock()?.token === owner.token) {
      fs.unlinkSync(dreamTxLockPath());
      fsyncDir(path.dirname(dreamTxLockPath()));
    }
  }
  function requireDreamTxLock() {
    const lock = acquireDreamTxLock();
    if (!lock) throw new Error("dream transaction lock busy: active or unknown owner");
    return lock;
  }
  function captureMarkdownPreImages(slug, module, currentRows) {
    const out = [{ filePath: moduleFileFor(slug, module), pre: snapshotFile(moduleFileFor(slug, module)) }];
    if (slug === GLOBAL_SLUG) return out;
    const wids = new Set();
    for (const row of currentRows?.values() || []) {
      if (normalizedDreamScopeFromRow(row) === "worktree" && normalizedWorktreeFromRow(row)) wids.add(normalizedWorktreeFromRow(row));
    }
    let dirs = [];
    try { dirs = fs.readdirSync(path.join(projectDirFor(slug), "_worktrees"), { withFileTypes: true }); }
    catch (e) { if (e.code !== "ENOENT") throw e; }
    for (const ent of dirs) if (ent.isDirectory()) wids.add(ent.name);
    for (const wid of wids) {
      const file = worktreeModuleFileFor(slug, wid, module);
      out.push({ filePath: file, pre: snapshotFile(file) });
    }
    return out;
  }
  function committedDreamTx(db, journal) {
    // The same connection sees its own uncommitted marker. Only an ended
    // transaction can prove a durable commit (including COMMIT-then-throw).
    return !db.isTransaction && Boolean(journal.txId) && db.prepare("SELECT value FROM meta WHERE key='last_committed_tx_id'").get()?.value === journal.txId;
  }
  function finishDreamTx(db, journal, committed) {
    for (const cl of journal.clusters) {
      const images = cl.markdownPreImages || [];
      if (cl.archiveRotatedPath && committed) restoreFile(cl.archiveRotatedPath, cl.archivePre);
      if (cl.archivePath) {
        if (committed) {
          // Exact post-image avoids duplicate/partial appends after a crash.
          const post = cl.archivePost ?? renderHygieneArchive("dream-merged.md", (cl.proposals || []).flatMap((p) => p.mergeItems || []), cl.archivePre?.content || "");
          restoreFile(cl.archivePath, { exists: true, content: post });
        } else if (cl.archivePre) restoreFile(cl.archivePath, cl.archivePre);
      }
      if (!committed && cl.archiveRotatedPath) restoreFile(cl.archiveRotatedPath, cl.archiveRotatedPre);
      if (!committed) for (const m of images) restoreFile(m.filePath, m.pre);
      const hints = new Set(cl.deletedWorktreeHints || []);
      if (cl.worktreeId) hints.add(cl.worktreeId);
      for (const m of images) {
        const relative = path.relative(projectDirFor(cl.projectSlug), m.filePath).split(path.sep);
        if (relative[0] === "_worktrees" && relative[1]) hints.add(relative[1]);
      }
      const modules = cl.modules || [cl.module];
      rewriteModules(db, cl.projectSlug, modules, { db }, [...hints]);
      if (!committed) for (const m of images) {
        // Rewrites can create formerly absent files. Rollback must remove them.
        if (!m.pre.exists) {
          restoreFile(m.filePath, m.pre);
          db.prepare("DELETE FROM vault_sync WHERE file_path=?").run(m.filePath);
        }
      }
      // Flush every rewritten destination, including empty directories/worktrees.
      for (const mod of modules) for (const m of captureMarkdownPreImages(cl.projectSlug, mod, [])) {
        if (m.pre.exists) { fsyncFile(m.filePath); fsyncDir(path.dirname(m.filePath)); }
      }
    }
    clearDreamTxJournal();
  }
  function recoverPendingDreamJournal(heldLock = null) {
    const owner = heldLock || acquireDreamTxLock();
    if (!owner) return { recovered: false, reason: "active-transaction" };
    try {
      let text;
      try { text = fs.readFileSync(dreamTxJournalPath(), "utf8"); }
      catch (e) { if (e.code === "ENOENT") return { recovered: false, reason: "no-journal" }; throw e; }
      const journal = JSON.parse(text);
      if (!journal || !Array.isArray(journal.clusters)) throw new Error("invalid dream transaction journal");
      const db = openDb();
      try {
        const committed = committedDreamTx(db, journal);
        finishDreamTx(db, journal, committed);
        return { recovered: true, committed, clusters: journal.clusters.length };
      } finally { db.close(); }
    } finally { if (!heldLock) releaseDreamTxLock(owner); }
  }
  function rollbackDreamTx(db, journal, originalError) {
    const errors = [];
    try { db.exec("ROLLBACK"); } catch (e) { errors.push(e); }
    // A failed SQLite rollback cannot authorize any filesystem rollback.
    if (!errors.length && journal) {
      try { finishDreamTx(db, journal, false); } catch (e) { errors.push(e); }
    }
    if (errors.length) {
      const error = new AggregateError([originalError, ...errors], "dream transaction failed: " + originalError.message + "; rollback failed: " + errors.map((e) => e.message).join("; "), { cause: originalError });
      error.dreamTxFatal = true;
      throw error;
    }
  }
  function discoverSlugs(db) {
    const set = new Set([GLOBAL_SLUG]);
    try {
      const pd = projectsDir();
      if (dirExists(pd)) {
        for (const e of fs.readdirSync(pd, { withFileTypes: true })) {
          if (e.isDirectory()) set.add(e.name);
        }
      }
    } catch {}
    try {
      const rows = db.prepare("SELECT DISTINCT project_slug FROM memories").all();
      for (const r of rows) if (r.project_slug && r.project_slug !== GLOBAL_SLUG) set.add(String(r.project_slug));
    } catch {}
    if (dirExists(path.join(vaultDir, "global"))) set.add(GLOBAL_SLUG);
    return [...set];
  }
  function invalidateEmbedHealthCache() {
    _healthCache = { modelId: null, dim: null, at: 0 };
  }
  function getEmbedHealthSync() {
    const now = Date.now();
    if (_healthCache.modelId && now - _healthCache.at < 5000) return _healthCache;
    if (healthFn) {
      try {
        const h = healthFn();
        if (h && (h.modelId || h.model_id)) {
          _healthCache = { modelId: String(h.modelId || h.model_id), dim: h.dim != null ? Number(h.dim) : null, at: now };
        } else if (h && h.dim != null) {
          _healthCache = { modelId: h.modelId || h.model_id || null, dim: Number(h.dim), at: now };
        } else if (h == null) {
          _healthCache = { modelId: null, dim: null, at: now };
        }
        return _healthCache;
      } catch {
        _healthCache = { modelId: null, dim: null, at: now };
        return _healthCache;
      }
    }
    try {
      const res = spawnSync(
        "curl",
        ["-s", "-m", "0.8", "--connect-timeout", "0.8", embedHealthUrl],
        { encoding: "utf8", timeout: 1200 }
      );
      if (!res.error && res.status === 0 && res.stdout) {
        const j = JSON.parse(res.stdout);
        const mid = j && (j.modelId || j.model_id || j.model);
        const dim = j && (j.dim != null ? Number(j.dim) : null);
        if (mid) _healthCache = { modelId: String(mid), dim: Number.isFinite(dim) ? dim : null, at: now };
        else _healthCache = { modelId: null, dim: null, at: now };
      } else {
        _healthCache = { modelId: null, dim: null, at: now };
      }
    } catch {
      _healthCache = { modelId: null, dim: null, at: now };
    }
    return _healthCache;
  }
  function activeEmbedModelId() {
    return getEmbedHealthSync().modelId || "local";
  }
  function syncWorktreeOneFile(db, slug, worktreeId, module) {
    const f = worktreeModuleFileFor(slug, worktreeId, module);
    if (!fileExists(f)) return { changed: false, upserted: 0, deleted: 0 };
    let st = null;
    try { st = fs.statSync(f); } catch { return { changed: false, upserted: 0, deleted: 0 }; }
    const snap = db.prepare("SELECT mtime_ms, content_hash FROM vault_sync WHERE file_path = ?").get(f);
    const text = fs.readFileSync(f, "utf8");
    const h = crypto.createHash("sha256").update(text).digest("hex");
    if (snap && Number(snap.mtime_ms) === st.mtimeMs && String(snap.content_hash) === h) {
      return { changed: false, upserted: 0, deleted: 0 };
    }
    const fallbackKind = MODULE_DEFAULT_KIND[module];
    const entries = parseMarkdownEntries(text, fallbackKind);
    const existing = db.prepare("SELECT * FROM memories WHERE project_slug = ? AND module = ? AND memory_scope='worktree' AND worktree_id=?").all(slug, module, worktreeId);
    const byId = new Map(existing.map((r) => [r.id, r]));
    const seenIds = new Set();
    let upserted = 0;
    let deleted = 0;
    let needsRewrite = false;
    for (const e of entries) {
      if (!e.id) {
        const ch = contentHashFor(e.content);
        const dup = existing.find((r) => r.content_hash === ch && r.title === e.title);
        if (dup) e.id = dup.id;
        else e.id = "mem_" + ch.slice(0, 16);
        e.createdAt = e.createdAt || nowIso();
        e.updatedAt = e.updatedAt || nowIso();
        needsRewrite = true;
      } else {
        e.createdAt = e.createdAt || (byId.get(e.id) ? byId.get(e.id).created_at : nowIso());
        e.updatedAt = e.updatedAt || nowIso();
      }
      if (containsSecret(e.title) || containsSecret(e.content)) continue;
      seenIds.add(e.id);
    }
    const filtered = entries.filter((e) => !e.id || (!containsSecret(e.title) && !containsSecret(e.content)));
    for (const e of filtered) {
      const row = byId.get(e.id);
      if (!e._hasMeta && row) Object.assign(e, revisionMeta(rowToItem(row)));
      const meta = readMetaFor(slug);
      const projectRoot = meta && meta.projectRoot ? meta.projectRoot : null;
      const ch = contentHashFor(e.content);
      const scopeVal = e.scope || "worktree";
      const wid = e.worktreeId || worktreeId;
      const br = e.branchName || "";
      if (!row) {
        upsertRow(db, { ...revisionMeta(e), id: e.id, projectSlug: slug, projectRoot, module, kind: e.kind, title: e.title, content: e.content, agent: e.agent, tags: e.tags, createdAt: e.createdAt, updatedAt: e.updatedAt, scope: scopeVal, memory_scope: scopeVal, memoryScope: scopeVal, worktreeId: wid, worktree_id: wid, branchName: br, branch_name: br });
        triggerBackgroundEmbedding(e.id, e.title, e.content);
        upserted += 1;
      } else {
        let oldTags = [];
        try { oldTags = JSON.parse(row.tags_json || "[]"); if (!Array.isArray(oldTags)) oldTags = []; } catch {}
        const same = row.title === e.title && row.content === e.content && row.kind === e.kind && row.agent === e.agent && JSON.stringify(revisionMeta(rowToItem(row))) === JSON.stringify(revisionMeta(e)) && JSON.stringify(oldTags) === JSON.stringify(e.tags) && row.content_hash === ch;
        if (!same) {
          upsertRow(db, { ...revisionMeta(e), id: e.id, projectSlug: slug, projectRoot, module, kind: e.kind, title: e.title, content: e.content, agent: e.agent, tags: e.tags, createdAt: row.created_at, updatedAt: nowIso(), scope: scopeVal, memory_scope: scopeVal, memoryScope: scopeVal, worktreeId: wid, worktree_id: wid, branchName: br, branch_name: br });
          if (row.title !== e.title || row.content !== e.content) { db.prepare("DELETE FROM memory_vectors WHERE id=?").run(e.id); triggerBackgroundEmbedding(e.id, e.title, e.content); }
          upserted += 1;
          e.updatedAt = nowIso();
          needsRewrite = true;
        }
      }
    }
    for (const row of existing) if (!seenIds.has(row.id)) { deleteRowById(db, row.id); deleted += 1; }
    if (needsRewrite) {
      const withIds = entries.map((e) => ({ ...revisionMeta(e), id: e.id, title: e.title, kind: e.kind, agent: e.agent, tags: e.tags, createdAt: e.createdAt, updatedAt: e.updatedAt, content: e.content, scope: e.scope || "worktree", worktreeId: e.worktreeId || worktreeId, branchName: e.branchName || "" }));
      writeTextAtomic(f, serializeEntries(module, withIds));
      recordSyncState(f);
    } else {
      db.prepare("INSERT OR REPLACE INTO vault_sync(file_path, mtime_ms, content_hash) VALUES (?,?,?)").run(f, st.mtimeMs, h);
    }
    return { changed: upserted > 0 || deleted > 0 || needsRewrite, upserted, deleted };
  }
  function syncOneFile(db, slug, module) {
    const f = moduleFileFor(slug, module);
    if (!fileExists(f)) return { changed: false, upserted: 0, deleted: 0 };
    let st = null;
    try {
      st = fs.statSync(f);
    } catch {
      return { changed: false, upserted: 0, deleted: 0 };
    }
    const snap = db.prepare("SELECT mtime_ms, content_hash FROM vault_sync WHERE file_path = ?").get(f);
    const text = fs.readFileSync(f, "utf8");
    const h = crypto.createHash("sha256").update(text).digest("hex");
    if (snap && Number(snap.mtime_ms) === st.mtimeMs && String(snap.content_hash) === h) {
      return { changed: false, upserted: 0, deleted: 0 };
    }
    const fallbackKind = MODULE_DEFAULT_KIND[module];
    const entries = parseMarkdownEntries(text, fallbackKind);
    const existing = db.prepare("SELECT * FROM memories WHERE project_slug = ? AND module = ?").all(slug, module);
    const byId = new Map(existing.map((r) => [r.id, r]));
    const seenIds = new Set();
    let upserted = 0;
    let deleted = 0;
    let needsRewrite = false;
    // Resolve id-less entries deterministically and check secrets.
    for (const e of entries) {
      if (!e.id) {
        const ch = contentHashFor(e.content);
        const dup = existing.find((r) => r.content_hash === ch && r.title === e.title);
        if (dup) {
          e.id = dup.id;
        } else {
          e.id = "mem_" + ch.slice(0, 16);
        }
        e.createdAt = e.createdAt || nowIso();
        e.updatedAt = e.updatedAt || nowIso();
        needsRewrite = true;
      } else {
        e.createdAt = e.createdAt || (byId.get(e.id) ? byId.get(e.id).created_at : nowIso());
        e.updatedAt = e.updatedAt || nowIso();
      }
      if (containsSecret(e.title) || containsSecret(e.content)) continue;
      seenIds.add(e.id);
    }
    const filtered = entries.filter((e) => !e.id || (!containsSecret(e.title) && !containsSecret(e.content)));
    for (const e of filtered) {
      const row = byId.get(e.id);
      // Old Markdown without a meta comment must not reset an indexed v2
      // card's revision history or recall counters.
      if (!e._hasMeta && row) Object.assign(e, revisionMeta(rowToItem(row)));
      const meta = readMetaFor(slug);
      const projectRoot = meta && meta.projectRoot ? meta.projectRoot : null;
      const ch = contentHashFor(e.content);
      const _syncScope = e.scope || (slug === GLOBAL_SLUG ? "global" : "shared");
      const _syncWid = e.worktreeId || "";
      const _syncBr = e.branchName || "";
      if (!row) {
        upsertRow(db, {
          ...revisionMeta(e),
          id: e.id,
          projectSlug: slug,
          projectRoot,
          module,
          kind: e.kind,
          title: e.title,
          content: e.content,
          agent: e.agent,
          tags: e.tags,
          createdAt: e.createdAt,
          updatedAt: e.updatedAt,
          scope: _syncScope,
          memory_scope: _syncScope,
          memoryScope: _syncScope,
          worktreeId: _syncWid,
          worktree_id: _syncWid,
          branchName: _syncBr,
          branch_name: _syncBr,
        });
        triggerBackgroundEmbedding(e.id, e.title, e.content);
        upserted += 1;
      } else {
        let oldTags = [];
        try {
          oldTags = JSON.parse(row.tags_json || "[]");
          if (!Array.isArray(oldTags)) oldTags = [];
        } catch {}
        const same =
          row.title === e.title &&
          row.content === e.content &&
          row.kind === e.kind &&
          row.agent === e.agent &&
          JSON.stringify(revisionMeta(rowToItem(row))) === JSON.stringify(revisionMeta(e)) &&
          JSON.stringify(oldTags) === JSON.stringify(e.tags) &&
          row.content_hash === ch;
        if (!same) {
          upsertRow(db, {
            ...revisionMeta(e),
            id: e.id,
            projectSlug: slug,
            projectRoot,
            module,
            kind: e.kind,
            title: e.title,
            content: e.content,
            agent: e.agent,
            tags: e.tags,
            createdAt: row.created_at,
            updatedAt: nowIso(),
            scope: e.scope || _syncScope,
            memory_scope: e.scope || _syncScope,
            memoryScope: e.scope || _syncScope,
            worktreeId: e.worktreeId || _syncWid,
            worktree_id: e.worktreeId || _syncWid,
            branchName: e.branchName || _syncBr,
            branch_name: e.branchName || _syncBr,
          });
          if (row.title !== e.title || row.content !== e.content) {
            db.prepare("DELETE FROM memory_vectors WHERE id=?").run(e.id);
            triggerBackgroundEmbedding(e.id, e.title, e.content);
          }
          upserted += 1;
          e.updatedAt = nowIso();
          needsRewrite = true;
        }
      }
    }
    // Deletions: DB rows whose id no longer appears in the file.
    for (const row of existing) {
      if (!seenIds.has(row.id)) {
        deleteRowById(db, row.id);
        deleted += 1;
      }
    }
    if (needsRewrite) {
      // Persist generated ids / fresh timestamps back into Markdown so future
      // syncs match by id. Secret entries are kept as-is (not imported) to
      // avoid silently dropping user text.
      const withIds = entries.map((e) => ({
        ...revisionMeta(e),
        id: e.id,
        title: e.title,
        kind: e.kind,
        agent: e.agent,
        tags: e.tags,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
        content: e.content,
        scope: e.scope || (slug === GLOBAL_SLUG ? "global" : "shared"),
        worktreeId: e.worktreeId || "",
        branchName: e.branchName || "",
      }));
      writeTextAtomic(f, serializeEntries(module, withIds));
      recordSyncState(f);
    } else {
      db.prepare("INSERT OR REPLACE INTO vault_sync(file_path, mtime_ms, content_hash) VALUES (?,?,?)").run(f, st.mtimeMs, h);
    }
    return { changed: upserted > 0 || deleted > 0 || needsRewrite, upserted, deleted };
  }
  function syncFromMarkdownIfChanged(projectSlug, heldLock = null) {
    const lock = heldLock || requireDreamTxLock();
    let db;
    try {
      recoverPendingDreamJournal(lock);
      db = openDb();
      const slugs = projectSlug ? [String(projectSlug)] : discoverSlugs(db);
      let changedFiles = 0;
      let upserted = 0;
      let deleted = 0;
      for (const slug of slugs) {
        if (!dirExists(projectDirFor(slug))) continue;
        for (const m of MODULES) {
          const r = syncOneFile(db, slug, m);
          if (r.changed) changedFiles += 1;
          upserted += r.upserted;
          deleted += r.deleted;
        }
        // Also sync per-worktree markdown files if present.
        try {
          const wtRoot = path.join(projectDirFor(slug), "_worktrees");
          if (dirExists(wtRoot)) {
            for (const ent of fs.readdirSync(wtRoot, { withFileTypes: true })) {
              if (!ent.isDirectory()) continue;
              const wtId = ent.name;
              for (const m of MODULES) {
                const r = syncWorktreeOneFile(db, slug, wtId, m);
                if (r.changed) changedFiles += 1;
                upserted += r.upserted;
                deleted += r.deleted;
              }
            }
          }
        } catch {}
      }
      return { ok: true, synced: changedFiles > 0, changedFiles, upserted, deleted };
    } finally {
      try { if (db) db.close(); } finally { if (!heldLock) releaseDreamTxLock(lock); }
    }
  }
  function embedTextsSync(texts, embedOpts = {}) {
    const inputType = embedOpts.inputType ?? embedOpts.input_type ?? null;
    const effectiveTimeoutMs = embedOpts.timeoutMs != null ? Number(embedOpts.timeoutMs) : embedTimeoutMs;
    if (embedFn) {
      try {
        const active = getEmbedHealthSync();
        const fnOpts = { inputType, input_type: inputType, modelId: active.modelId || "local", dim: active.dim || null };
        const out = embedFn(texts, fnOpts);
        return out || null;
      } catch {
        return null;
      }
    }
    try {
      const payloadObj = inputType ? { input: texts, input_type: inputType } : { input: texts };
      const payload = JSON.stringify(payloadObj);
      const res = spawnSync(
        "curl",
        ["-s", "-m", String(effectiveTimeoutMs / 1000), "--connect-timeout", String(effectiveTimeoutMs / 1000), "-X", "POST", embedUrl, "-H", "Content-Type: application/json", "-d", payload],
        { encoding: "utf8", timeout: effectiveTimeoutMs + 200 }
      );
      if (res.error || res.status !== 0 || !res.stdout) return null;
      const j = JSON.parse(res.stdout);
      if (!j || !Array.isArray(j.data)) return null;
      return j.data.map((d) => d.embedding);
    } catch {
      return null;
    }
  }
  async function embedTextsAsync(texts, embedOpts = {}) {
    const inputType = embedOpts.inputType ?? embedOpts.input_type ?? null;
    let effectiveAsyncMs;
    if (embedOpts.timeoutMs != null) effectiveAsyncMs = Number(embedOpts.timeoutMs);
    else if (hasExplicitEmbedTimeout) effectiveAsyncMs = embedTimeoutMs;
    else effectiveAsyncMs = (Array.isArray(texts) && texts.length > 1) ? BATCH_EMBED_TIMEOUT_MS : ASYNC_SINGLE_EMBED_TIMEOUT_MS;
    if (embedFn) {
      try {
        const active = getEmbedHealthSync();
        const fnOpts = { inputType, input_type: inputType, modelId: active.modelId || "local", dim: active.dim || null };
        return await Promise.resolve(embedFn(texts, fnOpts));
      } catch {
        return null;
      }
    }
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), effectiveAsyncMs);
      const res = await fetch(embedUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(inputType ? { input: texts, input_type: inputType } : { input: texts }),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (!res.ok) return null;
      const j = await res.json();
      if (!j || !Array.isArray(j.data)) return null;
      return j.data.map((d) => d.embedding);
    } catch {
      return null;
    }
  }
  function putVector(db, id, vec, modelId = "local") {
    if (!validVector(vec)) return;
    const f32 = new Float32Array(vec);
    db.prepare("INSERT OR REPLACE INTO memory_vectors(id, model_id, dim, vec_f32, updated_at) VALUES (?,?,?,?,?)")
      .run(id, modelId, f32.length, Buffer.from(f32.buffer), nowIso());
  }
  function storeVector(id, modelId, vec, expectedText) {
    try {
      if (!validVector(vec) || !fileExists(indexDbPath)) return;
      const db = openDb();
      try {
        const row = db.prepare("SELECT title, content FROM memories WHERE id=?").get(id);
        // A slow request for an old/deleted revision must never resurrect its
        // vector after a newer save, Markdown sync, consolidation or rollback.
        if (!row || (expectedText != null && embeddingText(row) !== expectedText)) return;
        putVector(db, id, vec, modelId);
      } finally {
        db.close();
      }
    } catch {}
  }
  function triggerBackgroundEmbedding(id, title, content) {
    const combined = embeddingText({ title, content });
    const targetModelId = activeEmbedModelId();
    setImmediate(() => {
      embedTextsAsync([combined], { inputType: "document" }).then((vecs) => {
        if (!vecs || !vecs[0]) return;
        storeVector(id, targetModelId, vecs[0], combined);
      }).catch(() => {});
    });
  }
  function needsReindexRow(row, activeId, activeDim) {
    if (row.v_model == null) return true;
    if (activeId === "mlx-community/embeddinggemma-2-8bit") {
      return !((row.v_model === "mlx-community/embeddinggemma-2-8bit" || row.v_model === "local" || row.v_model === "powercontext-legacy") && Number(row.v_dim) === 768);
    }
    if (row.v_model !== activeId) return true;
    if (activeDim != null && activeDim > 0 && Number(row.v_dim) !== Number(activeDim)) return true;
    return false;
  }
  async function performBatchEmbedding({ targetModelId } = {}) {
    if (_reindexing) return { ok: true, queued: 0, alreadyReindexing: true };
    _reindexing = true;
    try {
      const health = getEmbedHealthSync();
      const activeId = targetModelId || health.modelId || "local";
      const activeDim = health.dim || null;
      const db = openDb();
      let rows = [];
      try {
        const all = db.prepare("SELECT m.id, m.title, m.content, v.model_id AS v_model, v.dim AS v_dim FROM memories m LEFT JOIN memory_vectors v ON v.id = m.id").all();
        rows = all.filter((r) => needsReindexRow(r, activeId, activeDim));
      } finally {
        db.close();
      }
      const total = rows.length;
      const B = 16;
      for (let i = 0; i < rows.length; i += B) {
        const chunk = rows.slice(i, i + B);
        const texts = chunk.map((r) => embeddingText(r));
        const vecs = await embedTextsAsync(texts, { inputType: "document" });
        if (!vecs) break;
        for (let k = 0; k < chunk.length; k += 1) {
          if (vecs[k]) storeVector(chunk[k].id, activeId, vecs[k], texts[k]);
        }
      }
      return { ok: true, queued: total };
    } catch {
      return { ok: true, queued: 0 };
    } finally {
      _reindexing = false;
    }
  }
  function triggerBatchEmbedding(opts = {}) {
    const targetModelId = opts && typeof opts === "object" ? (opts.targetModelId || null) : null;
    const promise = performBatchEmbedding({ targetModelId });
    promise.catch(() => {});
    return promise;
  }
  function resolveVaultSlug(projectRoot) {
    const raw = String(projectRoot);
    let normRoot = "";
    try { normRoot = normalizeProjectRoot(raw); } catch { normRoot = path.resolve(raw); }
    // Unified canonical slug: worktrees of same repo share canonicalProjectRoot slug.
    let canonRoot = normRoot;
    try {
      const ctx = resolveWorktreeContext(raw);
      if (ctx && ctx.canonicalProjectRoot) canonRoot = ctx.canonicalProjectRoot;
    } catch {}
    if (canonRoot) {
      try { normRoot = normalizeProjectRoot(canonRoot); } catch {}
      const baseSlug = slugFromProjectRoot(normRoot);
      const expectedHash = scopeHashFor(normRoot);
      const hash6 = expectedHash ? expectedHash.slice(0, 6) : "000000";
      const candidateDir = path.join(projectsDir(), baseSlug);
      if (!dirExists(candidateDir)) return baseSlug;
      let meta = readJsonFile(path.join(candidateDir, "_meta.json"), null);
      if (!meta) meta = readJsonFile(path.join(candidateDir, "meta.json"), null);
      if (meta && typeof meta === "object") {
        const metaRaw = meta.projectRoot ? String(meta.projectRoot) : null;
        let metaRoot = metaRaw ? normalizeProjectRoot(metaRaw) : null;
        // Canonicalize meta root as well: if meta stored a worktree path, its canonical is same repo root.
        if (metaRaw) {
          try {
            const mctx = resolveWorktreeContext(metaRaw);
            if (mctx && mctx.canonicalProjectRoot) metaRoot = normalizeProjectRoot(mctx.canonicalProjectRoot);
          } catch {}
          // Also canonicalize scopeHash equivalently via canonical root hash.
          // If stored hash was of worktree path, recompute expected hash for canonical comparison when needed.
        }
        if ((metaRoot && metaRoot === normRoot) || (meta.scopeHash && expectedHash && String(meta.scopeHash) === expectedHash)) return baseSlug;
        // Also accept if stored hash equals hash of meta canonical root (legacy worktree-stored)
        try {
          if (metaRaw) {
            const metaCanon = resolveWorktreeContext(metaRaw).canonicalProjectRoot;
            const metaHash = scopeHashFor(metaCanon);
            if (metaHash && meta.scopeHash && String(meta.scopeHash) === metaHash && metaCanon === normRoot) return baseSlug;
          }
        } catch {}
        return baseSlug + "-" + hash6;
      }
      return baseSlug + "-" + hash6;
    }
    const baseSlug = slugFromProjectRoot(normRoot);
    const expectedHash = scopeHashFor(normRoot);
    const hash6 = expectedHash ? expectedHash.slice(0, 6) : "000000";
    const candidateDir = path.join(projectsDir(), baseSlug);
    if (!dirExists(candidateDir)) return baseSlug;
    let meta = readJsonFile(path.join(candidateDir, "_meta.json"), null);
    if (!meta) meta = readJsonFile(path.join(candidateDir, "meta.json"), null);
    if (meta && typeof meta === "object") {
      const metaRoot = meta.projectRoot ? normalizeProjectRoot(String(meta.projectRoot)) : null;
      if ((metaRoot && metaRoot === normRoot) || (meta.scopeHash && expectedHash && String(meta.scopeHash) === expectedHash)) return baseSlug;
      return baseSlug + "-" + hash6;
    }
    return baseSlug + "-" + hash6;
  }
  function resolveSlug(projectSlug, projectRoot) {
    if (projectSlug) return String(projectSlug);
    if (projectRoot) return resolveVaultSlug(String(projectRoot));
    return null;
  }
  function vectorsFor(db, items) {
    const vectors = new Map();
    const missing = [];
    const health = getEmbedHealthSync();
    const activeId = health.modelId || "local";
    const activeDim = health.dim || null;
    const isLegacy = activeId === "mlx-community/embeddinggemma-2-8bit";
    for (const item of items) {
      let stored = null;
      try {
        if (isLegacy) {
          stored = db.prepare("SELECT * FROM memory_vectors WHERE id=? AND model_id IN ('mlx-community/embeddinggemma-2-8bit','local','powercontext-legacy') AND dim=768").get(item.id);
        } else if (activeDim) {
          stored = db.prepare("SELECT * FROM memory_vectors WHERE id=? AND model_id=? AND dim=?").get(item.id, activeId, activeDim);
        } else {
          stored = db.prepare("SELECT * FROM memory_vectors WHERE id=? AND model_id=?").get(item.id, activeId);
        }
      } catch { stored = null; }
      let vec = null;
      if (stored) {
        try {
          const raw = stored.vec_f32;
          const byteLength = raw && raw.byteLength != null ? raw.byteLength : (raw && raw.length != null ? raw.length : 0);
          if (byteLength === stored.dim * 4) {
            const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
            vec = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
            vec = new Float32Array(vec);
          }
        } catch { vec = null; }
      }
      const dimOk = !activeDim || !vec || vec.length === activeDim || (isLegacy && vec.length === 768);
      if (validVector(vec) && dimOk) vectors.set(item.id, vec);
      else missing.push(item);
    }
    if (missing.length) {
      const result = embedTextsSync(missing.map(embeddingText), { inputType: "document" });
      for (let i = 0; i < missing.length; i++) {
        if (result && validVector(result[i])) vectors.set(missing[i].id, result[i]);
      }
    }
    return vectors;
  }
  function similarity(a, b, vectors) {
    const av = vectors.get(a.id), bv = vectors.get(b.id);
    return {
      cosine: av && bv && av.length === bv.length ? cosine(av, bv) : null,
      titleSim: jaccard(lexicalTokens(a.title), lexicalTokens(b.title)),
      lexicalSim: jaccard(lexicalTokens(a.title + " " + a.content), lexicalTokens(b.title + " " + b.content)),
    };
  }
  function isNearDuplicate(sim) {
    return sim.cosine >= 0.92 || sim.lexicalSim >= 0.85;
  }
  function isSameTopic(sim) {
    return (sim.cosine >= 0.84 && sim.cosine < 0.92) || (sim.titleSim >= 0.78 && sim.lexicalSim >= 0.45);
  }
  function archiveRevision(item, reason) {
    return [...item.history, snapshot(item, reason)].slice(-10);
  }
  function touchProject(slug, timestamp) {
    const file = path.join(projectDirFor(slug), "_meta.json");
    const meta = readJsonFile(file, null);
    if (meta) writeJsonFileAtomic(file, { ...meta, updatedAt: timestamp });
  }
  function saveMemory(args = {}) {
    try {
      const projectRoot = args.projectRoot ? path.resolve(String(args.projectRoot)) : null;
      // Determine scope up-front: explicit scope or smart default by kind/tags.
      const explicitScope = args.scope || args.memory_scope || args.memoryScope || null;
      const inferredScope = inferScopeFromKindAndTags(args.kind, args.tags);
      let determinedScope = explicitScope ? String(explicitScope) : inferredScope;
      if (!["shared","worktree","global"].includes(determinedScope)) determinedScope = "shared";
      const ctxForScope = projectRoot ? resolveWorktreeContext(projectRoot) : null;
      const worktreeIdForScope = String(args.worktreeId || args.worktree_id || (determinedScope === "worktree" ? (ctxForScope && ctxForScope.worktreeId ? ctxForScope.worktreeId : "") : ""));
      const branchForScope = String(args.branchName || args.branch || args.branch_name || (ctxForScope && ctxForScope.branchName ? ctxForScope.branchName : ""));
      let slug = null;
      if (determinedScope === "global") slug = GLOBAL_SLUG;
      else slug = resolveSlug(args.projectSlug ? String(args.projectSlug) : null, projectRoot);
      if (!slug) return { ok: false, error: "projectRoot or projectSlug required" };
      // Preserve scope fields for later upsert, unless overridden by args.worktreeId/etc.
      const _saveScope = determinedScope;
      const _saveWorktreeId = worktreeIdForScope;
      const _saveBranch = branchForScope;
      const mod = MODULES.includes(args.module) ? args.module : args.kind ? kindToModule(args.kind) : "constraints";
      const title = String(args.title ?? "").trim();
      const content = String(args.content ?? "").trim();
      if (!title) return { ok: false, error: "title required" };
      if (!content) return { ok: false, error: "content required" };
      if (containsSecret(title) || containsSecret(content)) return { ok: false, error: SECRET_ERROR };
      const saveTxLock = requireDreamTxLock();
      try {
      syncFromMarkdownIfChanged(slug, saveTxLock);
      const incoming = {
        id: generateMemId(), projectSlug: slug, module: mod,
        kind: args.kind ? String(args.kind) : MODULE_DEFAULT_KIND[mod], title, content,
        agent: args.agent ? String(args.agent) : "user",
        tags: Array.isArray(args.tags) ? args.tags.map(String) : [],
        scope: _saveScope,
        memory_scope: _saveScope,
        memoryScope: _saveScope,
        worktreeId: _saveWorktreeId,
        worktree_id: _saveWorktreeId,
        branchName: _saveBranch,
        branch_name: _saveBranch,
        createdAt: nowIso(), updatedAt: nowIso(), ...revisionMeta(),
      };
      const db = openDb();
      try {
        let existing = null, action = "created", reason = null;
        let vectors = new Map();
        const targetId = args.id || args.supersedesId;
        if (targetId) {
          const row = db.prepare("SELECT * FROM memories WHERE id=?").get(String(targetId));
          if (row && row.project_slug !== slug) return { ok: false, error: "memory belongs to another project" };
          if (!row && args.supersedesId) return { ok: false, error: "memory not found: " + targetId };
          existing = row ? rowToItem(row) : null;
          incoming.id = String(targetId);
          action = args.supersedesId && !args.id ? "superseded" : "updated";
          reason = action === "superseded" ? "superseded" : "manual-edit";
        } else {
          let dup = null;
          try {
            if (_saveScope === "global") {
              dup = db.prepare("SELECT * FROM memories WHERE project_slug=? AND module=? AND content_hash=? AND memory_scope='global'").get(slug, mod, contentHashFor(content));
            } else if (_saveScope === "worktree") {
              dup = db.prepare("SELECT * FROM memories WHERE project_slug=? AND module=? AND content_hash=? AND memory_scope='worktree' AND worktree_id=?").get(slug, mod, contentHashFor(content), _saveWorktreeId);
            } else {
              dup = db.prepare("SELECT * FROM memories WHERE project_slug=? AND module=? AND content_hash=? AND (memory_scope='shared' OR memory_scope IS NULL OR memory_scope='')").get(slug, mod, contentHashFor(content));
            }
          } catch {
            dup = db.prepare("SELECT * FROM memories WHERE project_slug=? AND module=? AND content_hash=?").get(slug, mod, contentHashFor(content));
          }
          if (dup) return { ok: true, item: { ...rowToItem(dup), score: 0 }, deduplicated: true, action: "deduplicated" };
          if (args.autoEvolve !== false) {
            let candidates = [];
            try {
              if (_saveScope === "global") candidates = db.prepare("SELECT * FROM memories WHERE project_slug=? ORDER BY updated_at DESC, id ASC").all(slug).map(rowToItem);
              else if (_saveScope === "worktree") candidates = db.prepare("SELECT * FROM memories WHERE project_slug=? AND memory_scope='worktree' AND worktree_id=? ORDER BY updated_at DESC, id ASC").all(slug, _saveWorktreeId).map(rowToItem);
              else candidates = db.prepare("SELECT * FROM memories WHERE project_slug=? AND (memory_scope='shared' OR memory_scope IS NULL OR memory_scope='') ORDER BY updated_at DESC, id ASC").all(slug).map(rowToItem);
            } catch {
              candidates = db.prepare("SELECT * FROM memories WHERE project_slug=? ORDER BY updated_at DESC, id ASC").all(slug).map(rowToItem);
            }
            vectors = vectorsFor(db, [...candidates, incoming]);
            const ranked = candidates.map((item) => ({ item, sim: similarity(incoming, item, vectors) }));
            ranked.sort((a, b) => (b.sim.cosine ?? b.sim.lexicalSim) - (a.sim.cosine ?? a.sim.lexicalSim));
            const match = ranked.find((c) => isNearDuplicate(c.sim)) ||
              ranked.find((c) => c.item.module === mod && isSameTopic(c.sim));
            if (match) {
              existing = match.item;
              action = isNearDuplicate(match.sim) ? "merged" : "evolved";
              reason = action === "merged" ? "auto-merge" : "auto-evolve";
            }
          }
        }
        let item = incoming;
        let evolvedFromVersion;
        if (existing) {
          item = { ...existing, ...incoming, id: existing.id, createdAt: existing.createdAt,
            scope: incoming.scope || existing.scope,
            memory_scope: incoming.scope || existing.memory_scope,
            memoryScope: incoming.scope || existing.memoryScope,
            worktreeId: incoming.worktreeId ?? existing.worktreeId,
            worktree_id: incoming.worktree_id ?? existing.worktree_id,
            branchName: incoming.branchName ?? existing.branchName,
            branch_name: incoming.branch_name ?? existing.branch_name,
            ...revisionMeta(existing) };
          if (action === "merged") {
            item.module = existing.module;
            item.kind = existing.kind;
            item.title = existing.title;
            item.tags = [...new Set([...existing.tags, ...incoming.tags])];
            // Prefer a fuller current explanation; never concatenate an old
            // rule into a contradictory replacement rule.
            if (content.length <= existing.content.length) item.content = existing.content;
          }
          const changed = existing.title !== item.title || existing.content !== item.content;
          if (!changed && action !== "merged" && item.module === existing.module &&
              item.kind === existing.kind && JSON.stringify(item.tags) === JSON.stringify(existing.tags) && item.agent === existing.agent) {
            return { ok: true, item: { ...existing, score: 0 }, deduplicated: true, action: "deduplicated" };
          }
          if ((changed && args.recordHistory !== false) || action === "superseded" || action === "evolved") {
            evolvedFromVersion = existing.version;
            item.version = existing.version + 1;
            item.history = archiveRevision(existing, reason);
          }
          if (args.supersedesId) item.supersedesId = String(args.supersedesId);
        }
        const canonForVault = ctxForScope && ctxForScope.canonicalProjectRoot ? ctxForScope.canonicalProjectRoot : projectRoot;
        const meta = ensureProjectVault(slug, { title: path.basename(canonForVault || projectRoot || slug), projectRoot: canonForVault });
        const projectPath = canonForVault || projectRoot || meta.projectRoot || null;
        const textChanged = !existing || embeddingText(existing) !== embeddingText(item);
        db.exec("BEGIN");
        try {
          upsertRow(db, { ...item, projectRoot: projectPath, scope: item.scope || _saveScope, memoryScope: item.scope || _saveScope, memory_scope: item.scope || _saveScope, worktreeId: item.worktreeId ?? _saveWorktreeId, worktree_id: item.worktree_id ?? _saveWorktreeId, branchName: item.branchName ?? _saveBranch, branch_name: item.branch_name ?? _saveBranch });
          if (textChanged) db.prepare("DELETE FROM memory_vectors WHERE id=?").run(item.id);
          db.exec("COMMIT");
        } catch (e) { db.exec("ROLLBACK"); throw e; }
        if (textChanged) {
          const vec = embeddingText(item) === embeddingText(incoming) ? vectors.get(incoming.id) : null;
          const embedded = vec || embedTextsSync([embeddingText(item)], { inputType: "document" })?.[0];
          if (validVector(embedded)) putVector(db, item.id, embedded, activeEmbedModelId());
        }
        rewriteModules(db, slug, [mod, ...(existing ? [existing.module] : [])]);
        touchProject(slug, item.updatedAt);
        // 第 4 重：水位线自动合并 —— 同项目同模块活跃条目数超水位时异步静默合并（不阻塞写入返回）
        try {
          const threshold = args.autoConsolidateThreshold != null ? Number(args.autoConsolidateThreshold) : vaultAutoConsolidateThreshold;
          if (threshold != null && Number.isFinite(threshold) && threshold > 0) {
            const cntRow = db.prepare("SELECT COUNT(*) AS c FROM memories WHERE project_slug = ? AND module = ?").get(slug, mod);
            if (cntRow && Number(cntRow.c) > threshold) {
              const slugForConsolidate = slug;
              setImmediate(() => { try { consolidateMemories({ projectSlug: slugForConsolidate }); } catch {} });
            }
          }
        } catch {}
        return { ok: true, deduplicated: action === "merged", action,
          ...(evolvedFromVersion != null ? { evolvedFromVersion } : {}), item: { ...item, score: 0 } };
      } finally { db.close(); }
      } finally { releaseDreamTxLock(saveTxLock); }
    } catch (e) { return { ok: false, error: e.message || String(e) }; }
  }
  function deleteMemory(args = {}) {
    let delTxLock = null;
    try {
      const id = args.id ? String(args.id) : null;
      if (!id) return { ok: false, error: "id required" };
      delTxLock = requireDreamTxLock();
      recoverPendingDreamJournal(delTxLock);
      const db = openDb();
      try {
        const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
        if (!row) return { ok: true, deleted: false };
        const slug = args.projectSlug ? String(args.projectSlug) : row.project_slug;
        const mod = row.module;
        const widHint = (String(row.memory_scope || "") === "worktree" && String(row.worktree_id || "")) ? [String(row.worktree_id)] : [];
        deleteRowById(db, id);
        // Rewrite scope-aware modules (shared + per-worktree) without the deleted entry.
        // P1-A: 删除前已记录 widHint，空 worktree 同步清空防止复活
        try { rewriteModules(db, slug, [mod], null, widHint); } catch {}
        try {
          if (slug !== GLOBAL_SLUG) {
            const allRows = db.prepare("SELECT * FROM memories WHERE project_slug = ? AND module = ? ORDER BY created_at ASC").all(slug, mod);
          }
        } catch {}
        return { ok: true, deleted: true };
      } finally {
        db.close();
      }
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    } finally {
      releaseDreamTxLock(delTxLock);
    }
  }
  function pinToAgentsMd(args = {}) {
    try {
      if (!args.projectRoot) return { ok: false, error: "projectRoot required" };
      if (!args.id) return { ok: false, error: "id required" };
      const projectRoot = path.resolve(String(args.projectRoot));
      const id = String(args.id);
      const db = openDb();
      let row = null;
      try {
        row = db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
      } finally {
        db.close();
      }
      if (!row) return { ok: false, error: "memory not found: " + id };
      const agentsMdPath = path.join(projectRoot, "AGENTS.md");
      let content = "";
      if (fileExists(agentsMdPath)) {
        try {
          content = fs.readFileSync(agentsMdPath, "utf8");
        } catch {
          content = "";
        }
      }
      const marker = "<!-- pinned:" + id + " -->";
      if (content.includes(marker)) return { ok: true, agentsMdPath };
      const flat = String(row.content || "").replace(/\s+/g, " ").trim();
      const entry = "- **[" + String(row.kind || "") + "] " + String(row.title || "") + "**: " + flat + " " + marker;
      const header = "## 📌 Pinned Project Rules";
      if (!content.includes(header)) {
        content = (content.trim() ? content.replace(/\s+$/, "") + "\n\n" : "") + header + "\n\n" + entry + "\n";
      } else {
        const idx = content.indexOf(header);
        const after = content.slice(idx + header.length);
        const nextIdx = after.search(/\n## /);
        if (nextIdx === -1) {
          content = content.replace(/\s*$/, "\n\n" + entry + "\n");
        } else {
          const insertAt = idx + header.length + nextIdx + 1;
          content = content.slice(0, insertAt) + entry + "\n" + content.slice(insertAt);
        }
      }
      safeMkdir(projectRoot);
      writeTextAtomic(agentsMdPath, content);
      return { ok: true, agentsMdPath };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  }
  function getOverview(args = {}) {
    try {
      const db = openDb();
      try {
        const slugs = discoverSlugs(db);
        try {
          ensureProjectVault(GLOBAL_SLUG, { title: GLOBAL_TITLE, projectRoot: null });
        } catch {}
        const migrated = readJsonFile(receiptPath, null);
        const migratedCount = migrated && migrated.stats && Number.isFinite(migrated.stats.total) ? Number(migrated.stats.total) : 0;
        const totalRow = db.prepare("SELECT COUNT(*) AS c FROM memories").get();
        const totalMemories = totalRow ? Number(totalRow.c) : 0;
        const currentProjectSlug = args.projectRoot ? resolveVaultSlug(String(args.projectRoot)) : null;
        const projects = [];
        for (const slug of slugs) {
          const meta = readMetaFor(slug);
          const cnt = db.prepare("SELECT COUNT(*) AS c FROM memories WHERE project_slug = ?").get(slug);
          const byRows = db.prepare("SELECT module, COUNT(*) AS c FROM memories WHERE project_slug = ? GROUP BY module").all(slug);
          const byModule = { constraints: 0, architecture: 0, pitfalls: 0, topics: 0 };
          for (const r of byRows) byModule[String(r.module)] = Number(r.c);
          const mx = db.prepare("SELECT MAX(updated_at) AS m FROM memories WHERE project_slug = ?").get(slug);
          if (slug === GLOBAL_SLUG) {
            projects.push({
              slug: GLOBAL_SLUG,
              title: (meta && meta.title) || GLOBAL_TITLE,
              projectRoot: null,
              total: cnt ? Number(cnt.c) : 0,
              byModule,
              updatedAt: (mx && mx.m) || (meta && meta.updatedAt) || null,
            });
          } else {
            projects.push({
              slug,
              title: (meta && meta.title) || slug,
              projectRoot: (meta && meta.projectRoot) || null,
              total: cnt ? Number(cnt.c) : 0,
              byModule,
              updatedAt: (mx && mx.m) || (meta && meta.updatedAt) || null,
            });
          }
        }
        projects.sort((a, b) => {
          if (a.slug === GLOBAL_SLUG) return -1;
          if (b.slug === GLOBAL_SLUG) return 1;
          return String(a.slug).localeCompare(String(b.slug));
        });
        // 体积健康字段：第 4 重容量监控指标
        let dbSizeBytes = 0;
        try {
          const st = fs.statSync(indexDbPath);
          dbSizeBytes = Number(st.size) || 0;
        } catch {
          dbSizeBytes = 0;
        }
        const dbSizeMb = Math.round((dbSizeBytes / (1024 * 1024)) * 100) / 100;
        let vectorCount = 0;
        let staleVectorCount = 0;
        let worktreeMemoryCount = 0;
        try {
          const vc = db.prepare("SELECT COUNT(*) AS c FROM memory_vectors").get();
          vectorCount = vc ? Number(vc.c) : 0;
        } catch { vectorCount = 0; }
        try {
          const sv = db.prepare("SELECT COUNT(*) AS c FROM memory_vectors WHERE id NOT IN (SELECT id FROM memories)").get();
          staleVectorCount = sv ? Number(sv.c) : 0;
        } catch { staleVectorCount = 0; }
        try {
          const wc = db.prepare("SELECT COUNT(*) AS c FROM memories WHERE memory_scope = 'worktree'").get();
          worktreeMemoryCount = wc ? Number(wc.c) : 0;
        } catch { worktreeMemoryCount = 0; }
        let archivedCount = 0;
        try {
          for (const slug of slugs) {
            try {
              const dir = path.join(projectDirFor(slug), "_archive");
              if (!dirExists(dir)) continue;
              for (const name of fs.readdirSync(dir)) {
                if (!name.endsWith(".md")) continue;
                const f = path.join(dir, name);
                try {
                  const text = fs.readFileSync(f, "utf8");
                  const parsed = parseMarkdownEntries(text, "topic");
                  if (parsed && parsed.length) archivedCount += parsed.length;
                  else {
                    const m = text.match(/^## /gm);
                    if (m) archivedCount += m.length;
                  }
                } catch {}
              }
            } catch {}
          }
        } catch { archivedCount = 0; }
        let dream = null;
        try { dream = readDreamConfig(); } catch { dream = defaultDreamConfig(); }
        let health = null;
        try {
          health = getMemoryHealth({});
        } catch {}
        if (!health) {
          health = { total: totalMemories, pinnedCount: 0, staleCount: 0, brokenLinks: [], isolatedCount: 0, ceilingStatus: "ok", brokenCount: 0 };
        }
        return { ok: true, currentProjectSlug, migratedCount, totalMemories, projects, dbSizeBytes, dbSizeMb, vectorCount, staleVectorCount, worktreeMemoryCount, archivedCount, dream, health };
      } finally {
        db.close();
      }
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  }
  function listMemories(args = {}) {
    try {
      const limit = Number(args.limit) > 0 ? Math.min(500, Math.floor(Number(args.limit))) : 50;
      const module = args.module && args.module !== "all" ? String(args.module) : "all";
      const query = typeof args.query === "string" ? args.query : "";
      // Resolve scopeFilter: auto/shared/worktree/global/all
      const rawScopeFilter = String(args.scopeFilter || args.scope || "auto").toLowerCase();
      const scopeFilter = ["auto","shared","worktree","global","all"].includes(rawScopeFilter) ? rawScopeFilter : "auto";
      // For legacy callers that pass scopeFilter explicitly as separate param "scope", treat same.
      const ctxForFilter = args.projectRoot ? resolveWorktreeContext(String(args.projectRoot)) : null;
      const worktreeIdForFilter = ctxForFilter && ctxForFilter.worktreeId ? ctxForFilter.worktreeId : "";
      const isLinkedForFilter = !!(ctxForFilter && ctxForFilter.isLinkedWorktree);
      const effectiveIncludeGlobal = scopeFilter === "global" || scopeFilter === "all" || (scopeFilter === "auto" && (isLinkedForFilter || args.includeGlobal === true)) || (scopeFilter === "auto" && args.includeGlobal === true) || args.includeGlobal === true && scopeFilter === "auto" ? (scopeFilter === "shared" || scopeFilter === "worktree" ? false : (isLinkedForFilter || args.includeGlobal === true || scopeFilter === "all" || scopeFilter === "global")) : false;
      // Simpler: determine includeGlobalEffective for auto case.
      const autoIncludeGlobal = isLinkedForFilter || args.includeGlobal === true;
      let slug = null;
      if (scopeFilter === "global") slug = GLOBAL_SLUG;
      else slug = resolveSlug(args.projectSlug ? String(args.projectSlug) : null, args.projectRoot ? String(args.projectRoot) : null);
      // Auto-sync Markdown edits before reading.
      try {
        if (slug) syncFromMarkdownIfChanged(slug);
        if (args.includeGlobal || scopeFilter === "global" || scopeFilter === "all" || (scopeFilter === "auto" && isLinkedForFilter)) syncFromMarkdownIfChanged(GLOBAL_SLUG);
      } catch {}
      const db = openDb();
      try {
        const buildFilter = () => {
          const conds = [];
          const params = [];
          const filt = scopeFilter;
          if (filt === "global") {
            conds.push("project_slug = ?");
            params.push(GLOBAL_SLUG);
          } else if (filt === "shared") {
            if (slug) {
              conds.push("project_slug = ? AND (memory_scope='shared' OR memory_scope IS NULL OR memory_scope='')");
              params.push(slug);
            } else {
              conds.push("(memory_scope='shared' OR memory_scope IS NULL)");
            }
          } else if (filt === "worktree") {
            if (slug) {
              conds.push("project_slug = ? AND memory_scope='worktree' AND worktree_id=?");
              params.push(slug, worktreeIdForFilter);
            } else {
              conds.push("memory_scope='worktree' AND worktree_id=?");
              params.push(worktreeIdForFilter);
            }
          } else if (filt === "all") {
            if (slug && slug !== GLOBAL_SLUG) {
              conds.push("(project_slug = ? OR project_slug = ?)");
              params.push(slug, GLOBAL_SLUG);
            } else if (slug === GLOBAL_SLUG) {
              conds.push("project_slug = ?");
              params.push(GLOBAL_SLUG);
            }
          } else { // auto
            if (slug) {
              if (slug === GLOBAL_SLUG) {
                conds.push("project_slug = ?");
                params.push(GLOBAL_SLUG);
              } else {
                const incG = autoIncludeGlobal;
                if (incG) {
                  conds.push("((project_slug = ? AND (memory_scope='shared' OR memory_scope IS NULL OR memory_scope='' OR (memory_scope='worktree' AND worktree_id=?))) OR project_slug=?)");
                  params.push(slug, worktreeIdForFilter, GLOBAL_SLUG);
                } else {
                  conds.push("project_slug = ? AND (memory_scope='shared' OR memory_scope IS NULL OR memory_scope='' OR (memory_scope='worktree' AND worktree_id=?))");
                  params.push(slug, worktreeIdForFilter);
                }
              }
            } else if (args.includeGlobal) {
              // No slug: everything
            } else {
              // No slug and no global: filter by scope shared+global? For auto with no project, show all.
            }
          }
          if (module !== "all") {
            conds.push("module = ?");
            params.push(module);
          }
          return { conds, params, filt, worktreeId: worktreeIdForFilter, isLinked: isLinkedForFilter, autoIncludeGlobal };
        };
        function rowMatchesScope(row, filterInfo) {
          const r = row;
          const ps = r.project_slug;
          const ms = r.memory_scope || "shared";
          const wid = r.worktree_id || "";
          const filt = filterInfo.filt;
          const curWid = filterInfo.worktreeId;
          const slugVal = slug;
          if (filt === "global") return ps === GLOBAL_SLUG;
          if (filt === "shared") {
            if (ps !== slugVal) return false;
            return ms === "shared" || ms === "" || ms == null;
          }
          if (filt === "worktree") {
            if (ps !== slugVal) return false;
            return ms === "worktree" && wid === curWid;
          }
          if (filt === "all") {
            return ps === slugVal || ps === GLOBAL_SLUG;
          }
          // auto
          if (slugVal === GLOBAL_SLUG) {
            if (ps === GLOBAL_SLUG) return true;
            return false;
          }
          if (ps === GLOBAL_SLUG) return filterInfo.autoIncludeGlobal;
          if (ps === slugVal) {
            if (ms === "shared" || ms === "" || ms == null) return true;
            if (ms === "worktree" && wid === curWid) return true;
            return false;
          }
          return false;
        }
        if (!query || !query.trim()) {
          const { conds, params } = buildFilter();
          const where = conds.length ? " WHERE " + conds.join(" AND ") : "";
          const rows = db.prepare("SELECT * FROM memories" + where + " ORDER BY updated_at DESC, created_at DESC LIMIT ?").all(...params, limit);
          const items = rows.map((r) => {
            const it = rowToItem(r);
            it.score = 0;
            return it;
          });
          return { ok: true, projectSlug: slug, items };
        }
        // Hybrid search: lexical (FTS BM25 + CJK LIKE) + semantic RRF.
        const q = query.trim();
        const tokens = (q.match(/[\p{L}\p{N}_]+/gu) || []).filter((t) => t.length > 0);
        const lexMap = new Map();
        const lexOrder = [];
        const { conds, params } = buildFilter();
        const whereSuffix = conds.length ? " AND " + conds.join(" AND ") : "";
        // FTS probe.
        if (tokens.length) {
          const ftsQuery = tokens
            .map((t) => '"' + String(t).replace(/"/g, '""') + '"')
            .join(" OR ");
          try {
            const qualified = whereSuffix.replace(/project_slug/g, "m.project_slug").replace(/memory_scope/g, "m.memory_scope").replace(/worktree_id/g, "m.worktree_id").replace(/\bmodule\b/g, "m.module");
            const filterInfoForFts = buildFilter();
            const rows = db
              .prepare("SELECT m.*, bm25(memories_fts) AS _rank FROM memories_fts JOIN memories m ON m.id = memories_fts.id WHERE memories_fts MATCH ?" + (whereSuffix ? qualified : ""))
              .all(ftsQuery, ...params);
            rows.sort((a, b) => Number(a._rank) - Number(b._rank));
            for (const r of rows) {
              if (!rowMatchesScope(r, filterInfoForFts)) continue;
              if (lexMap.has(r.id)) continue;
              lexMap.set(r.id, { row: r, rank: lexOrder.length + 1 });
              lexOrder.push(r.id);
            }
          } catch {}
        }
        // CJK substring LIKE fallback (2-4 char terms never miss).
        const likeTerms = new Set(tokens);
        const cjkRuns = q.match(/[\u4e00-\u9fff]+/g) || [];
        for (const run of cjkRuns) {
          if (run.length >= 2) {
            for (let i = 0; i + 1 < run.length; i += 1) likeTerms.add(run.slice(i, i + 2));
            if (run.length >= 3) for (let i = 0; i + 2 < run.length; i += 1) likeTerms.add(run.slice(i, i + 3));
          }
        }
        // Also include whole query and compact (no spaces) so multi-word CJK still hits.
        if (q.length >= 2 && q.length <= 40) likeTerms.add(q);
        for (const term of [...likeTerms].slice(0, 40)) {
          if (!term) continue;
          const pat = "%" + escapeLike(term) + "%";
          try {
            const rows = db
              .prepare("SELECT * FROM memories WHERE " + (conds.length ? conds.join(" AND ") + " AND " : "") + "(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR tags_json LIKE ? ESCAPE '\\') ORDER BY updated_at DESC")
              .all(...params, pat, pat, pat);
            const filterInfoLike = buildFilter();
            for (const r of rows) {
              if (!rowMatchesScope(r, filterInfoLike)) continue;
              if (lexMap.has(r.id)) continue;
              lexMap.set(r.id, { row: r, rank: lexOrder.length + 1 });
              lexOrder.push(r.id);
            }
          } catch {}
        }
        // Semantic rank.
        const vecMap = new Map();
        const vecOrder = [];
        try {
          const vecs = embedTextsSync([q], { inputType: "query" });
          if (vecs && vecs[0]) {
            const qv = vecs[0];
            const dim = qv.length;
            const health = getEmbedHealthSync();
            const activeId = health.modelId || "local";
            const isLegacy = activeId === "mlx-community/embeddinggemma-2-8bit";
            let vrows = [];
            try {
              if (isLegacy) vrows = db.prepare("SELECT * FROM memory_vectors WHERE model_id IN ('mlx-community/embeddinggemma-2-8bit','local','powercontext-legacy') AND dim = ?").all(dim);
              else vrows = db.prepare("SELECT * FROM memory_vectors WHERE model_id = ? AND dim = ?").all(activeId, dim);
            } catch {
              vrows = [];
            }
            const cand = [];
            for (const vr of vrows) {
              let row = null;
              try {
                row = db.prepare("SELECT * FROM memories WHERE id = ?").get(vr.id);
              } catch {}
              if (!row) continue;
              // Apply scope-aware isolation for vectors as well.
              if (!rowMatchesScope(row, buildFilter())) continue;
              if (module !== "all" && row.module !== module) continue;
              let vec = null;
              try {
                const blob = vr.vec_f32;
                const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
                vec = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
              } catch {
                continue;
              }
              const sim = cosine(qv, vec);
              if (sim <= 0) continue;
              cand.push({ id: vr.id, row, sim });
            }
            cand.sort((a, b) => b.sim - a.sim);
            for (const c of cand) {
              vecMap.set(c.id, { row: c.row, rank: vecOrder.length + 1, sim: c.sim });
              vecOrder.push(c.id);
            }
          }
        } catch {}
        const union = new Map();
        for (const [id, v] of lexMap) union.set(id, { row: v.row, lexRank: v.rank, vecRank: vecMap.has(id) ? vecMap.get(id).rank : null });
        for (const [id, v] of vecMap) {
          if (!union.has(id)) union.set(id, { row: v.row, lexRank: null, vecRank: v.rank });
          else union.get(id).vecRank = v.rank;
        }
        const items = [...union.values()].map((u) => {
          const lexPart = u.lexRank ? 1 / (60 + u.lexRank) : 0;
          const vecPart = u.vecRank ? 1.2 / (60 + u.vecRank) : 0;
          const it = rowToItem(u.row);
          it.score = (lexPart + vecPart) * (1 + 0.05 * Math.min(5, Math.log2(1 + it.hitCount)));
          return it;
        });
        items.sort((a, b) => b.score - a.score);
        const hits = items.slice(0, limit);
        if (args.trackHits !== false && hits.length) {
          const t = nowIso();
          const touched = new Map();
          const update = db.prepare("UPDATE memories SET hit_count=hit_count+1, last_recalled_at=? WHERE id=?");
          for (const item of hits) {
            update.run(t, item.id);
            item.hitCount++;
            item.lastRecalledAt = t;
            if (!touched.has(item.projectSlug)) touched.set(item.projectSlug, new Set());
            touched.get(item.projectSlug).add(item.module);
          }
          for (const [project, modules] of touched) rewriteModules(db, project, modules);
        }
        return { ok: true, projectSlug: slug, items: hits };
      } finally {
        db.close();
      }
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  }
  function consolidateMemories(args = {}) {
    let lock;
    try {
      const slug = resolveSlug(args.projectSlug, args.projectRoot);
      if (!slug) return { ok: false, error: "projectRoot or projectSlug required" };
      lock = requireDreamTxLock();
      syncFromMarkdownIfChanged(slug, lock);
      const db = openDb();
      try {
        const items = db.prepare("SELECT * FROM memories WHERE project_slug=? ORDER BY created_at ASC, id ASC").all(slug).map(rowToItem);
        const vectors = vectorsFor(db, items);
        const overlaps = (sim) => sim.cosine >= 0.82 || sim.titleSim >= 0.75 || sim.lexicalSim >= 0.60;
        const pairs = [];
        for (let i = 0; i < items.length; i++) {
          for (let j = i + 1; j < items.length; j++) {
            // P1-A: consolidate 亦按 scope+worktree 隔离，禁止跨树合并
            if (normalizedDreamScopeFromItem(items[i]) !== normalizedDreamScopeFromItem(items[j])) continue;
            if (normalizedWorktreeFromItem(items[i]) !== normalizedWorktreeFromItem(items[j])) continue;
            const sim = similarity(items[i], items[j], vectors);
            if (overlaps(sim)) pairs.push({ id: items[i].id, mergeId: items[j].id, ...sim });
          }
        }
        if (args.dryRun) return { ok: true, dryRun: true, mergedCount: 0, pairs, candidates: pairs, items: [] };
        const active = new Map(items.map((item) => [item.id, item]));
        const changed = new Map();
        let mergedCount = 0;
        if (!pairs.length) return { ok: true, mergedCount: 0, items: [] };
        const affected = new Set(pairs.flatMap((p) => [active.get(p.id).module, active.get(p.mergeId).module]));
        const currentRows = db.prepare("SELECT * FROM memories WHERE project_slug=?").all(slug);
        const journal = { version: 2, kind: "consolidate", txId: crypto.randomUUID(), createdAt: nowIso(), clusters: [{
          projectSlug: slug, modules: [...affected],
          deletedWorktreeHints: [...new Set(currentRows.map(normalizedWorktreeFromRow).filter(Boolean))],
          markdownPreImages: [...affected].flatMap((mod) => captureMarkdownPreImages(slug, mod, currentRows)), proposals: [],
        }] };
        let committed = false;
        db.exec("PRAGMA synchronous = FULL");
        db.exec("BEGIN IMMEDIATE");
        try {
          const checkLiveStmt = db.prepare("SELECT version, updated_at, content_hash FROM memories WHERE id = ?");
          const rowStillMatchesSnapshot = (snapItem) => {
            if (changed.has(snapItem.id)) return true;
            const live = checkLiveStmt.get(snapItem.id);
            if (!live) return false;
            return Number(live.version) === Number(snapItem.version)
              && String(live.updated_at || "") === String(snapItem.updatedAt || "")
              && String(live.content_hash || "") === contentHashFor(snapItem.content);
          };
          writeDreamTxJournal(journal);
          for (const pair of pairs) {
            const keep = active.get(pair.id), remove = active.get(pair.mergeId);
            if (!keep || !remove || normalizedDreamScopeFromItem(keep) !== normalizedDreamScopeFromItem(remove) || normalizedWorktreeFromItem(keep) !== normalizedWorktreeFromItem(remove)) continue;
            if (!rowStillMatchesSnapshot(keep) || !rowStillMatchesSnapshot(remove)) continue;
            if (!overlaps(similarity(keep, remove, vectors))) continue;
            // Preserve the fuller explanation for near duplicates. For a
            // changed rule on the same topic, the newer revision wins.
            const sim = similarity(keep, remove, vectors);
            const source = isNearDuplicate(sim)
              ? (remove.content.length > keep.content.length ? remove : keep)
              : (remove.updatedAt >= keep.updatedAt ? remove : keep);
            const combinedHistory = [...keep.history, ...remove.history, snapshot(remove, "consolidated"), snapshot(keep, "consolidated")];
            const prevMaxVersion = Math.max(
              Number(keep.version) || 1,
              Number(remove.version) || 1,
              ...combinedHistory.map((entry) => Number(entry.version) || 0)
            );
            let lastHistoryVersion = 0;
            const history = combinedHistory.slice(-10).map((entry) => {
              lastHistoryVersion = Math.max(lastHistoryVersion + 1, Number(entry.version) || 1);
              return { ...entry, sourceVersion: entry.sourceVersion ?? entry.version, version: lastHistoryVersion };
            });
            const merged = { ...keep, title: source.title, content: source.content, agent: source.agent,
              version: Math.max(prevMaxVersion, lastHistoryVersion) + 1, updatedAt: nowIso(),
              tags: [...new Set([...keep.tags, ...remove.tags])],
              hitCount: keep.hitCount + remove.hitCount,
              lastRecalledAt: [keep.lastRecalledAt, remove.lastRecalledAt].filter(Boolean).sort().pop() || null,
              history };
            const sourceVector = vectors.get(source.id);
            const root = db.prepare("SELECT project_root FROM memories WHERE id=?").get(keep.id).project_root;
            upsertRow(db, { ...merged, projectRoot: root });
            deleteRowById(db, remove.id);
            db.prepare("DELETE FROM memory_vectors WHERE id=?").run(keep.id);
            vectors.delete(keep.id);
            vectors.delete(remove.id);
            // The active text is exactly source's text. Retain that vector
            // for subsequent pairs in this pass (including semantic-only
            // matches), rather than falling back mid-consolidation.
            if (sourceVector) {
              vectors.set(keep.id, sourceVector);
              putVector(db, keep.id, sourceVector, activeEmbedModelId());
            }
            active.set(keep.id, merged);
            active.delete(remove.id);
            changed.delete(remove.id);
            changed.set(keep.id, merged);
            mergedCount++;
          }
          db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('last_committed_tx_id',?)").run(journal.txId);
          db.exec("COMMIT");
          committed = true;
          finishDreamTx(db, journal, true);
        } catch (e) {
          // COMMIT may have succeeded even if its caller observed an exception.
          if (!committed && !committedDreamTx(db, journal)) rollbackDreamTx(db, journal, e);
          throw e;
        }
        if (mergedCount) {
          touchProject(slug, nowIso());
          for (const item of changed.values()) triggerBackgroundEmbedding(item.id, item.title, item.content);
        }
        return { ok: true, mergedCount, items: [...changed.values()] };
      } finally { db.close(); }
    } catch (e) { if (e.dreamTxFatal) throw e; return { ok: false, error: e.message || String(e) }; }
    finally { releaseDreamTxLock(lock); }
  }
  function rollbackMemory(args = {}) {
    let rbTxLock = null;
    try {
      const slug = resolveSlug(args.projectSlug, args.projectRoot);
      if (!slug || !args.id) return { ok: false, error: "projectRoot or projectSlug and id required" };
      rbTxLock = requireDreamTxLock();
      syncFromMarkdownIfChanged(slug, rbTxLock);
      const db = openDb();
      try {
        const row = db.prepare("SELECT * FROM memories WHERE project_slug=? AND id=?").get(slug, String(args.id));
        if (!row) return { ok: false, error: "memory not found: " + args.id };
        const current = rowToItem(row);
        const matches = args.revisionId != null
          ? current.history.filter((entry) => entry.revisionId === args.revisionId)
          : args.targetVersion != null
            ? current.history.filter((entry) => entry.version === Number(args.targetVersion))
            : current.history.slice(-1);
        if (matches.length > 1) return { ok: false, error: "ambiguous history version; revisionId required" };
        const target = matches[0];
        if (!target) return { ok: false, error: "history version not found" };
        if (containsSecret(target.title) || containsSecret(target.content)) return { ok: false, error: SECRET_ERROR };
        const item = { ...current, title: target.title, content: target.content, agent: target.agent,
          version: current.version + 1, updatedAt: nowIso(), history: archiveRevision(current, "rollback") };
        upsertRow(db, { ...item, projectRoot: row.project_root });
        db.prepare("DELETE FROM memory_vectors WHERE id=?").run(item.id);
        rewriteModules(db, slug, [item.module]);
        touchProject(slug, item.updatedAt);
        triggerBackgroundEmbedding(item.id, item.title, item.content);
        return { ok: true, action: "rolled-back", restoredFromVersion: target.version, restoredFromRevisionId: target.revisionId, item };
      } finally { db.close(); }
    } catch (e) { return { ok: false, error: e.message || String(e) }; }
    finally { releaseDreamTxLock(rbTxLock); }
  }
  function tableExists(src, name) {
    try {
      const r = src.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name);
      return Boolean(r);
    } catch {
      return false;
    }
  }
  function decodeBlobText(v) {
    if (v == null) return "";
    if (typeof v === "string") return v;
    if (v instanceof Uint8Array) {
      try {
        return Buffer.from(v).toString("utf8");
      } catch {
        return "";
      }
    }
    if (Buffer.isBuffer(v)) return v.toString("utf8");
    return String(v);
  }
  function migrateFromPowerContext(args = {}) {
    try {
      const dbPath = args.dbPath ? String(args.dbPath) : path.join(homeDir, "Library", "Application Support", "powercontext", "powercontext.db");
      const force = Boolean(args.force);
      const existing = readJsonFile(receiptPath, null);
      if (existing && !force && existing.dbPath && String(existing.dbPath) === String(dbPath)) {
        return { ok: true, alreadyMigrated: true, stats: existing.stats || { projects: 0, constraints: 0, architecture: 0, pitfalls: 0, topics: 0, total: 0 } };
      }
      if (!fileExists(dbPath)) return { ok: false, error: "powercontext db not found: " + dbPath };
      let stats = null;
      const src = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const scopes = tableExists(src, "pc_scopes") ? src.prepare("SELECT * FROM pc_scopes").all() : [];
        // Bindings are sha -> scope maps; paths come from the scope summary.
        // We read them only to prove the mapping was considered; real paths
        // are embedded in summaries like "Project memory for <path>".
        try {
          if (tableExists(src, "pc_scope_bindings")) src.prepare("SELECT * FROM pc_scope_bindings").all();
        } catch {}
        const usedSlugs = new Map();
        stats = { projects: 0, constraints: 0, architecture: 0, pitfalls: 0, topics: 0, total: 0 };
        const now = nowIso();
        // Map each scope to slug/projectRoot/title, ensuring zero loss.
        const scopeMap = new Map();
        for (const s of scopes) {
          const scopeId = String(s.scope_id || "");
          const title = String(s.title || "project");
          const summary = String(s.summary || "");
          const m = summary.match(/^Project memory for (.+)$/);
          let projectRoot = m ? String(m[1]).trim() : null;
          let slug = null;
          if (/Default fallback scope/i.test(summary) && title === "Default") {
            slug = GLOBAL_SLUG;
            projectRoot = null;
          } else if (projectRoot) {
            slug = slugFromProjectRoot(projectRoot);
          } else {
            slug = slugify(title);
          }
          if (!slug) slug = slugify(title || scopeId);
          if (slug !== GLOBAL_SLUG && projectRoot) {
            const candDir = path.join(projectsDir(), slug);
            if (dirExists(candDir)) {
              let existingMeta = readJsonFile(path.join(candDir, "_meta.json"), null);
              if (!existingMeta) existingMeta = readJsonFile(path.join(candDir, "meta.json"), null);
              const normR = normalizeProjectRoot(String(projectRoot));
              const expHash = scopeHashFor(String(projectRoot));
              const metaRoot = existingMeta && existingMeta.projectRoot ? normalizeProjectRoot(String(existingMeta.projectRoot)) : null;
              const matches = (metaRoot && metaRoot === normR) || (existingMeta && existingMeta.scopeHash && expHash && String(existingMeta.scopeHash) === expHash);
              if (!matches) {
                const h6 = expHash ? expHash.slice(0, 6) : crypto.createHash("sha256").update(scopeId).digest("hex").slice(0, 6);
                slug = slug + "-" + h6;
              }
            }
          }
          if (usedSlugs.has(slug) && usedSlugs.get(slug) !== scopeId) {
            const suffix = crypto.createHash("sha256").update(scopeId).digest("hex").slice(0, 8);
            slug = slug + "-" + suffix;
          }
          usedSlugs.set(slug, scopeId);
          scopeMap.set(scopeId, { slug, projectRoot, title, scopeId });
        }
        stats.projects = scopeMap.size;
        // Prepare vault DB and ensure each target project exists.
        const vdb = openDb();
        try {
          for (const info of scopeMap.values()) {
            if (info.slug === GLOBAL_SLUG) ensureProjectVault(GLOBAL_SLUG, { title: GLOBAL_TITLE, projectRoot: null });
            else ensureProjectVault(info.slug, { title: info.title, projectRoot: info.projectRoot });
            if (info.projectRoot && info.slug !== GLOBAL_SLUG) {
              const metaPath = path.join(projectDirFor(info.slug), "_meta.json");
              const meta = readJsonFile(metaPath, null);
              if (meta) {
                meta.title = info.title;
                meta.projectRoot = info.projectRoot;
                meta.scopeHash = scopeHashFor(info.projectRoot);
                meta.updatedAt = now;
                writeJsonFileAtomic(metaPath, meta);
              }
            }
          }
          // Atomic memories.
          const atomicRows = tableExists(src, "pc_atomic_memory_current")
            ? src.prepare("SELECT scope_id, artifact_id, revision, state_version, content_hash, projection_format, kind, text, searchable_text, tag_keys, embedding, description FROM pc_atomic_memory_current").all()
            : [];
          const artCreated = new Map();
          if (tableExists(src, "pc_artifacts")) {
            try {
              const rows = src.prepare("SELECT scope_id, family, artifact_id, created_at FROM pc_artifacts WHERE family = 'atomic-memory'").all();
              for (const r of rows) artCreated.set(String(r.scope_id) + "|" + String(r.artifact_id), r.created_at || null);
            } catch {}
          }
          for (const r of atomicRows) {
            const info = scopeMap.get(String(r.scope_id));
            if (!info) continue;
            const mod = kindToModule(String(r.kind || ""));
            const kind = String(r.kind || MODULE_DEFAULT_KIND[mod]);
            const title = (r.description && String(r.description).trim()) || String(r.text || "").split("\n")[0].trim().slice(0, 120) || kind;
            const content = String(r.text || "");
            if (containsSecret(title) || containsSecret(content)) continue;
            let tags = [];
            try {
              const j = JSON.parse(String(r.tag_keys || "[]"));
              if (Array.isArray(j)) tags = j.map(String);
            } catch {
              tags = [];
            }
            const memId = "mem_" + String(r.artifact_id || generateMemId()).replace(/[^A-Za-z0-9_-]/g, "_");
            const caRaw = artCreated.get(String(r.scope_id) + "|" + String(r.artifact_id));
            let createdAt = now;
            if (caRaw) {
              try {
                const d = new Date(String(caRaw).replace(" ", "T"));
                if (!Number.isNaN(d.getTime())) createdAt = d.toISOString();
                else createdAt = String(caRaw);
              } catch {}
            }
            upsertRow(vdb, { id: memId, projectSlug: info.slug, projectRoot: info.projectRoot, module: mod, kind, title, content, agent: "powercontext", tags, createdAt, updatedAt: createdAt });
            stats[mod] += 1;
            stats.total += 1;
            // Legacy 768-dim vectors are preserved for cosine reuse.
            if (r.embedding) {
              try {
                const blob = r.embedding;
                const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
                if (buf.length > 0 && buf.length % 4 === 0) {
                  vdb.prepare("INSERT OR REPLACE INTO memory_vectors(id, model_id, dim, vec_f32, updated_at) VALUES (?,?,?,?,?)").run(
                    memId,
                    "powercontext-legacy",
                    Math.floor(buf.length / 4),
                    buf,
                    now
                  );
                }
              } catch {}
            }
          }
          // Topic memories (+ chunks).
          const topicRows = tableExists(src, "pc_topic_memory_active_topics")
            ? src.prepare("SELECT scope_id, family, artifact_id, revision, title, summary, source_count FROM pc_topic_memory_active_topics").all()
            : [];
          const chunkMap = new Map();
          if (tableExists(src, "pc_topic_memory_active_chunks")) {
            try {
              const chunks = src.prepare("SELECT scope_id, artifact_id, chunk_ordinal, chunk_text FROM pc_topic_memory_active_chunks ORDER BY chunk_ordinal ASC").all();
              for (const c of chunks) {
                const k = String(c.scope_id) + "|" + String(c.artifact_id);
                if (!chunkMap.has(k)) chunkMap.set(k, []);
                chunkMap.get(k).push(String(c.chunk_text || ""));
              }
            } catch {}
          }
          for (const r of topicRows) {
            const info = scopeMap.get(String(r.scope_id));
            if (!info) continue;
            const chunks = chunkMap.get(String(r.scope_id) + "|" + String(r.artifact_id)) || [];
            let content = String(r.summary || "");
            for (const c of chunks) {
              if (c && !content.includes(c)) content = content ? content + "\n\n" + c : c;
            }
            if (!content.trim()) content = String(r.title || "");
            const title = String(r.title || "topic");
            if (containsSecret(title) || containsSecret(content)) continue;
            const memId = "mem_" + String(r.artifact_id || generateMemId()).replace(/[^A-Za-z0-9_-]/g, "_");
            upsertRow(vdb, { id: memId, projectSlug: info.slug, projectRoot: info.projectRoot, module: "topics", kind: "topic", title, content, agent: "powercontext", tags: [], createdAt: now, updatedAt: now });
            stats.topics += 1;
            stats.total += 1;
          }
          // Experience / handoff artifacts (active heads when available).
          const expItems = [];
          if (tableExists(src, "pc_artifact_heads") && tableExists(src, "pc_artifacts")) {
            try {
              const heads = src.prepare("SELECT scope_id, family, artifact_id, revision, lifecycle_state FROM pc_artifact_heads WHERE lifecycle_state = 'active' AND family IN ('experience','handoff')").all();
              for (const h of heads) {
                const art = src.prepare("SELECT content, created_at FROM pc_artifacts WHERE scope_id = ? AND family = ? AND artifact_id = ? AND revision = ?").get(String(h.scope_id), String(h.family), String(h.artifact_id), h.revision);
                if (!art) continue;
                expItems.push({ scopeId: String(h.scope_id), family: String(h.family), artifactId: String(h.artifact_id), content: art.content, createdAt: art.created_at, revision: h.revision });
              }
            } catch {}
          }
          if (!expItems.length && tableExists(src, "pc_artifacts")) {
            try {
              const rows = src.prepare("SELECT scope_id, family, artifact_id, content, created_at FROM pc_artifacts WHERE family IN ('experience','handoff')").all();
              for (const r of rows) expItems.push({ scopeId: String(r.scope_id), family: String(r.family), artifactId: String(r.artifact_id), content: r.content, createdAt: r.created_at, revision: null });
            } catch {}
          }
          for (const it of expItems) {
            const info = scopeMap.get(String(it.scopeId));
            if (!info) continue;
            const raw = decodeBlobText(it.content);
            let obj = null;
            try {
              obj = JSON.parse(raw);
            } catch {
              obj = null;
            }
            let title = "";
            let content = "";
            const isHandoff = it.family === "handoff";
            if (obj && typeof obj === "object" && (obj.situation || obj.action || obj.lesson || obj.summary || obj.content)) {
              const sit = String(obj.situation || "");
              const act = String(obj.action || "");
              const out = String(obj.outcome || "");
              const les = String(obj.lesson || "");
              title = (les || sit).trim().slice(0, 120) || it.artifactId;
              const lines = [];
              if (sit) lines.push("情境：" + sit);
              if (act) lines.push("动作：" + act);
              if (out) lines.push("结果：" + out);
              if (les) lines.push("经验：" + les);
              if (obj.failure != null) lines.push("失败：" + String(obj.failure));
              content = lines.join("\n\n") || raw;
            } else if (obj && typeof obj === "object" && obj.title) {
              title = String(obj.title).slice(0, 120);
              content = String(obj.content || obj.summary || raw);
            } else {
              title = raw.split("\n")[0].trim().slice(0, 120) || it.artifactId;
              content = raw;
            }
            if (!content || !String(content).trim()) continue;
            if (containsSecret(title) || containsSecret(content)) continue;
            const memId = "mem_" + String(it.artifactId || generateMemId()).replace(/[^A-Za-z0-9_-]/g, "_");
            const mod = isHandoff ? "topics" : "pitfalls";
            const kind = isHandoff ? "handoff" : "experience";
            let createdAt = now;
            if (it.createdAt) {
              try {
                const d = new Date(String(it.createdAt).replace(" ", "T"));
                if (!Number.isNaN(d.getTime())) createdAt = d.toISOString();
                else createdAt = String(it.createdAt);
              } catch {}
            }
            upsertRow(vdb, { id: memId, projectSlug: info.slug, projectRoot: info.projectRoot, module: mod, kind, title: String(title || "").trim() || kind, content: String(content), agent: "powercontext", tags: [], createdAt, updatedAt: createdAt });
            stats[mod] += 1;
            stats.total += 1;
          }
          // Regenerate Markdown files from the migrated projection.
          const slugs = [...scopeMap.values()].map((v) => v.slug);
          const uniq = [...new Set(slugs)];
          for (const slug of uniq) {
            for (const mod of MODULES) {
              const rows = vdb.prepare("SELECT * FROM memories WHERE project_slug = ? AND module = ? ORDER BY created_at ASC").all(slug, mod);
              const entries = rows.map((r) => ({
                ...revisionMeta(rowToItem(r)),
                id: r.id,
                title: r.title,
                kind: r.kind,
                agent: r.agent,
                tags: (() => {
                  try {
                    const x = JSON.parse(r.tags_json || "[]");
                    return Array.isArray(x) ? x : [];
                  } catch {
                    return [];
                  }
                })(),
                createdAt: r.created_at,
                updatedAt: r.updated_at,
                content: r.content,
              }));
              rewriteModuleFile(slug, mod, entries);
            }
          }
        } finally {
          vdb.close();
        }
      } finally {
        src.close();
      }
      writeJsonFileAtomic(receiptPath, { dbPath, migratedAt: nowIso(), stats });
      triggerBatchEmbedding();
      return { ok: true, alreadyMigrated: false, stats };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  }
  function ensureProject(args = {}) {
    try {
      const slug = resolveSlug(args.projectSlug ? String(args.projectSlug) : null, args.projectRoot ? String(args.projectRoot) : null);
      if (!slug) return { ok: false, error: "projectRoot or projectSlug required" };
      const existed = dirExists(projectDirFor(slug));
      const meta = ensureProjectVault(slug, { title: args.title, projectRoot: args.projectRoot ? String(args.projectRoot) : null });
      return { ok: true, slug, projectSlug: slug, created: !existed, meta };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  }
  function reindexVectors(opts = {}) {
    const targetModelId = opts && typeof opts === "object" ? (opts.targetModelId || null) : null;
    let queued = 0;
    try {
      const health = getEmbedHealthSync();
      const activeId = targetModelId || health.modelId || "local";
      const activeDim = health.dim || null;
      const db = openDb();
      try {
        const all = db.prepare("SELECT m.id, v.model_id AS v_model, v.dim AS v_dim FROM memories m LEFT JOIN memory_vectors v ON v.id = m.id").all();
        queued = all.filter((r) => needsReindexRow(r, activeId, activeDim)).length;
      } finally {
        db.close();
      }
    } catch {}
    const promise = triggerBatchEmbedding({ targetModelId });
    return { ok: true, queued, promise };
  }
  function promoteWorktreeMemory(args = {}) {
    try {
      const id = args.id ? String(args.id) : null;
      if (!id) return { ok: false, error: "id required" };
      const db = openDb();
      try {
        const row = db.prepare("SELECT * FROM memories WHERE id=?").get(id);
        if (!row) return { ok: false, error: "memory not found" };
        if ((row.memory_scope || "shared") !== "worktree") return { ok: false, error: "memory is not worktree scoped" };
        const slug = row.project_slug;
        const mod = row.module;
        const wid = row.worktree_id || "";
        db.exec("BEGIN");
        try {
          db.prepare("UPDATE memories SET memory_scope='shared', worktree_id='', branch_name='' WHERE id=?").run(id);
          db.exec("COMMIT");
        } catch (e) { db.exec("ROLLBACK"); throw e; }
        try { rewriteModules(db, slug, [mod]); } catch {}
        try { touchProject(slug, nowIso()); } catch {}
        const updated = db.prepare("SELECT * FROM memories WHERE id=?").get(id);
        return { ok: true, promoted: true, item: rowToItem(updated), fromWorktreeId: wid };
      } finally { db.close(); }
    } catch (e) { return { ok: false, error: e.message || String(e) }; }
  }
  function resolveWorktreeContextLocal(cwd) {
    return resolveWorktreeContext(cwd);
  }
  function ensureProjectMemoryLink(projectRoot) {
    try {
      if (!projectRoot) return { ok: false, error: "projectRoot required" };
      const rawRoot = path.resolve(String(projectRoot));
      const ctx = resolveWorktreeContext(rawRoot);
      const canonRoot = ctx.canonicalProjectRoot || rawRoot;
      const slug = resolveVaultSlug(canonRoot);
      const vaultPath = projectDirFor(slug);
      ensureProjectVault(slug, { title: path.basename(canonRoot), projectRoot: canonRoot });
      const linkDir = path.join(rawRoot, ".t3");
      const linkPath = path.join(linkDir, "memory");
      safeMkdir(linkDir);
      let linked = false;
      try {
        const st = fs.lstatSync(linkPath);
        if (st.isSymbolicLink()) {
          const target = fs.readlinkSync(linkPath);
          const resolvedTarget = path.isAbsolute(target) ? target : path.resolve(linkDir, target);
          let canonVault = vaultPath;
          try { canonVault = fs.realpathSync(vaultPath); } catch { canonVault = path.resolve(vaultPath); }
          let canonResolved = resolvedTarget;
          try { canonResolved = fs.realpathSync(resolvedTarget); } catch { canonResolved = path.resolve(resolvedTarget); }
          if (canonResolved === canonVault || resolvedTarget === vaultPath) linked = true;
          else {
            fs.unlinkSync(linkPath);
            fs.symlinkSync(vaultPath, linkPath, "dir");
            linked = true;
          }
        } else if (st.isDirectory()) {
          linked = false;
        } else {
          fs.unlinkSync(linkPath);
          fs.symlinkSync(vaultPath, linkPath, "dir");
          linked = true;
        }
      } catch (e) {
        if (e && e.code === "ENOENT") {
          fs.symlinkSync(vaultPath, linkPath, "dir");
          linked = true;
        } else throw e;
      }
      // Add .t3/memory to .git/info/exclude (shared exclude for worktree).
      try {
        let excludePath = null;
        const gp = path.join(rawRoot, ".git");
        let st2 = null;
        try { st2 = fs.lstatSync(gp); } catch { st2 = null; }
        if (st2) {
          if (st2.isDirectory()) excludePath = path.join(gp, "info", "exclude");
          else if (st2.isFile()) {
            const content = fs.readFileSync(gp, "utf8").trim();
            const m = content.match(/^gitdir:\s*(.+)$/m);
            if (m) {
              let gd = m[1].trim();
              if (!path.isAbsolute(gd)) gd = path.resolve(path.dirname(gp), gd);
              // Resolve commondir for shared exclude
              let commonGitDir = null;
              try {
                const cf = path.join(gd, "commondir");
                if (fileExists(cf)) {
                  const cd = fs.readFileSync(cf, "utf8").trim();
                  if (cd) commonGitDir = path.isAbsolute(cd) ? cd : path.resolve(gd, cd);
                }
              } catch {}
              if (!commonGitDir) commonGitDir = path.resolve(gd, "../..");
              excludePath = path.join(commonGitDir, "info", "exclude");
            }
          }
        } else {
          let cur = rawRoot;
          while (true) {
            const gp2 = path.join(cur, ".git");
            let st3 = null;
            try { st3 = fs.lstatSync(gp2); } catch { st3 = null; }
            if (st3) {
              if (st3.isDirectory()) { excludePath = path.join(gp2, "info", "exclude"); break; }
              if (st3.isFile()) {
                const content = fs.readFileSync(gp2, "utf8").trim();
                const m = content.match(/^gitdir:\s*(.+)$/m);
                if (m) {
                  let gd = m[1].trim();
                  if (!path.isAbsolute(gd)) gd = path.resolve(cur, gd);
                  let commonGitDir = null;
                  try {
                    const cf = path.join(gd, "commondir");
                    if (fileExists(cf)) {
                      const cd = fs.readFileSync(cf, "utf8").trim();
                      if (cd) commonGitDir = path.isAbsolute(cd) ? cd : path.resolve(gd, cd);
                    }
                  } catch {}
                  if (!commonGitDir) commonGitDir = path.resolve(gd, "../..");
                  excludePath = path.join(commonGitDir, "info", "exclude");
                }
                break;
              }
            }
            const parent = path.dirname(cur);
            if (parent === cur) break;
            cur = parent;
          }
        }
        if (excludePath) {
          safeMkdir(path.dirname(excludePath));
          let existing = "";
          try { existing = fs.readFileSync(excludePath, "utf8"); } catch { existing = ""; }
          const entry = ".t3/memory";
          const lines = existing.split(/\r?\n/);
          if (!lines.includes(entry)) {
            lines.push(entry);
            const out = lines.join("\n").replace(/\n+$/, "") + "\n";
            writeTextAtomic(excludePath, out);
          }
        }
      } catch {}
      return { ok: true, vaultPath, linkPath, linked };
    } catch (e) { return { ok: false, error: e.message || String(e) }; }
  }
  // ---- T3 Memory Vault 防膨胀四重治理引擎 ----
  // 第 1 重（已有保留）：写入时 SHA-256 精确去重 + cosine>=0.92 自动合并 + 0.84~0.92 版本演化（见 saveMemory）。
  function isHygieneImmortalRow(row) {
    if (!row) return false;
    if (row.module === "constraints" || row.module === "architecture") return true;
    if (Number(row.hit_count) >= 1) return true;
    let tags = [];
    try { tags = JSON.parse(row.tags_json || "[]"); if (!Array.isArray(tags)) tags = []; } catch { tags = []; }
    const lowered = tags.map((t) => String(t).trim().toLowerCase());
    if (lowered.includes("pinned") || lowered.includes("core")) return true;
    return false;
  }
  function hygieneAgeMs(updatedAtStr, nowMs) {
    const t = Date.parse(String(updatedAtStr || ""));
    if (!Number.isFinite(t)) return 0;
    return Math.max(0, Number(nowMs) - t);
  }
  function renderHygieneArchive(fileName, items, existing) {
    if (!existing.trim()) {
      existing = fileName === "worktrees.md" ? "# 🗄️ 工作树临时记忆归档\n\n" : "# 🗄️ 冷数据归档\n\n";
    }
    const parts = [existing.replace(/\n+$/, "")];
    for (const e of items) {
      const marker = {
        id: e.id,
        kind: e.kind || "topic",
        agent: e.agent || "user",
        tags: Array.isArray(e.tags) ? e.tags : [],
        createdAt: e.createdAt || e.updatedAt || nowIso(),
        updatedAt: e.updatedAt || nowIso(),
        module: e.module || "topics",
      };
      if (e.scope) marker.scope = String(e.scope);
      if (e.worktreeId) marker.worktree_id = String(e.worktreeId);
      if (e.branchName) marker.branch = String(e.branchName);
      parts.push("## " + (e.title || "(无标题)"));
      parts.push("<!-- mem:" + JSON.stringify(marker) + " -->");
      parts.push("<!-- meta: " + JSON.stringify(revisionMeta(e)).replace(/</g, "\\u003c").replace(/>/g, "\\u003e") + " -->");
      parts.push(String(e.content || ""));
      parts.push("");
    }
    return parts.join("\n");
  }
  function appendHygieneArchive(slug, fileName, items, rollbackActions = null) {
    if (!items || !items.length) return 0;
    const dir = path.join(projectDirFor(slug), "_archive");
    safeMkdir(dir);
    const file = path.join(dir, fileName);
    // Dream 在数据库事务失败时恢复归档（包括本次发生的轮转），避免假归档和重复归档。
    let rotatedFile = null;
    if (rollbackActions) {
      const previous = fs.existsSync(file) ? fs.readFileSync(file) : null;
      rollbackActions.push(() => {
        if (previous === null) { if (fs.existsSync(file)) fs.unlinkSync(file); }
        else fs.writeFileSync(file, previous);
        if (rotatedFile && fs.existsSync(rotatedFile)) fs.unlinkSync(rotatedFile);
      });
    }
    let existing = "";
    // 256KB 自动旋转：超限先封存为 <stem>-<YYYYMM>-<timestamp>.md 再开新文件
    const ARCHIVE_ROTATE_BYTES = 256 * 1024;
    try {
      if (fs.existsSync(file)) {
        const st = fs.statSync(file);
        if (st.size > ARCHIVE_ROTATE_BYTES) {
          try {
            const ext = path.extname(file);
            const stem = path.basename(file, ext);
            const now = new Date();
            const yyyymm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
            const ts = Date.now();
            const suffix = rollbackActions ? "-" + crypto.randomBytes(6).toString("hex") : "";
            const rotated = path.join(dir, `${stem}-${yyyymm}-${ts}${suffix}.md`);
            fs.renameSync(file, rotated);
            rotatedFile = rotated;
          } catch {}
        }
      }
    } catch {}
    try { existing = fs.readFileSync(file, "utf8"); } catch { existing = ""; }
    writeTextAtomic(file, renderHygieneArchive(fileName, items, existing));
    return items.length;
  }
  function runHygiene(opts = {}) {
    try {
      const o = opts && typeof opts === "object" ? opts : {};
      const orphanWorktreeDays = o.orphanWorktreeDays != null ? Number(o.orphanWorktreeDays) : 7;
      const maxActivePerProject = o.maxActivePerProject != null ? Number(o.maxActivePerProject) : 250;
      const staleDays = o.staleDays != null ? Number(o.staleDays) : 60;
      const purgeStaleModelVectors = o.purgeStaleModelVectors !== false;
      const keepModelIdRaw = o.keepModelId != null ? String(o.keepModelId) : (o.keepModelID != null ? String(o.keepModelID) : null);
      const vacuum = o.vacuum === true;
      const dryRun = o.dryRun === true;
      let nowMs = Date.now();
      if (o.now != null) {
        const t = typeof o.now === "number" ? Number(o.now) : Date.parse(String(o.now));
        if (Number.isFinite(t)) nowMs = t;
      } else if (o.nowMs != null && Number.isFinite(Number(o.nowMs))) {
        nowMs = Number(o.nowMs);
      }
      let activeSet = null;
      const rawActive = o.activeWorktreeIds != null ? o.activeWorktreeIds : (o.activeWorktreeIDs != null ? o.activeWorktreeIDs : null);
      if (rawActive != null) {
        if (rawActive instanceof Set) activeSet = new Set([...rawActive].map((v) => String(v)));
        else if (Array.isArray(rawActive)) activeSet = new Set(rawActive.map((v) => String(v)));
        else activeSet = new Set([String(rawActive)]);
      }
      const db = openDb();
      let worktreeArchived = 0;
      let coldArchived = 0;
      let orphanVectorsDeleted = 0;
      let staleVectorsDeleted = 0;
      let optimized = false;
      let vacuumed = false;
      try {
        // 先同步 Markdown 投影，保证活跃表与文件一致
        try {
          const slugsForSync = discoverSlugs(db);
          for (const s of slugsForSync) {
            try { syncFromMarkdownIfChanged(s); } catch {}
          }
        } catch {}
        // Re-open after sync (sync opens its own connections)
        // ---- 第 2 重：孤儿工作树临时记忆自动归档回收 ----
        const worktreeRows = db.prepare("SELECT * FROM memories WHERE memory_scope = 'worktree' ORDER BY updated_at ASC, id ASC").all();
        const orphanRows = [];
        const orphanMs = Number.isFinite(orphanWorktreeDays) && orphanWorktreeDays >= 0 ? Number(orphanWorktreeDays) * 86400000 : 7 * 86400000;
        for (const r of worktreeRows) {
          const wid = String(r.worktree_id || "");
          const updatedAt = r.updated_at || r.created_at || "";
          const ageMs = hygieneAgeMs(updatedAt, nowMs);
          let orphan = false;
          if (activeSet && !activeSet.has(wid)) orphan = true;
          if (!orphan && Number.isFinite(orphanWorktreeDays) && ageMs > orphanMs) orphan = true;
          if (!orphan) {
            // 原工作树路径已不存在于磁盘
            try {
              const pr = r.project_root ? String(r.project_root) : null;
              if (pr && !fs.existsSync(pr)) orphan = true;
              else if (pr && wid) {
                const gitDir = path.join(pr, ".git");
                let gitExists = false;
                try { gitExists = dirExists(gitDir) || fileExists(gitDir); } catch { gitExists = false; }
                if (gitExists) {
                  // 规范根的 .git 为目录时，检查 worktrees/<id> 是否仍存在
                  try {
                    if (dirExists(gitDir)) {
                      const wtGitDir = path.join(gitDir, "worktrees", wid);
                      if (!dirExists(wtGitDir)) orphan = true;
                    }
                  } catch {}
                }
              }
            } catch {}
          }
          if (orphan) orphanRows.push(r);
        }
        if (orphanRows.length) {
          if (dryRun) {
            worktreeArchived = orphanRows.length;
          } else {
            // 按 slug 分组归档
            const bySlug = new Map();
            for (const r of orphanRows) {
              const slug = String(r.project_slug || "");
              if (!bySlug.has(slug)) bySlug.set(slug, []);
              bySlug.get(slug).push(r);
            }
            const affectedModules = new Map(); // slug -> Set(module)
            const affectedWorktrees = new Map(); // slug -> Set(wid)
            for (const [slug, rows] of bySlug) {
              const items = rows.map((r) => rowToItem(r));
              appendHygieneArchive(slug, "worktrees.md", items);
              worktreeArchived += rows.length;
              if (!affectedModules.has(slug)) affectedModules.set(slug, new Set());
              if (!affectedWorktrees.has(slug)) affectedWorktrees.set(slug, new Set());
              for (const r of rows) {
                affectedModules.get(slug).add(String(r.module || "topics"));
                const wid = String(r.worktree_id || "");
                if (wid) affectedWorktrees.get(slug).add(wid);
                deleteRowById(db, r.id);
              }
            }
            try { for (const [slug, mods] of affectedModules) { const h = affectedWorktrees.get(slug) ? [...affectedWorktrees.get(slug)] : []; rewriteModules(db, slug, [...mods], null, h); } } catch {}
            // 清理空的 _worktrees/<worktreeId> 目录
            try {
              for (const [slug, wids] of affectedWorktrees) {
                for (const wid of wids) {
                  const remaining = db.prepare("SELECT COUNT(*) AS c FROM memories WHERE project_slug = ? AND memory_scope = 'worktree' AND worktree_id = ?").get(slug, wid);
                  if (remaining && Number(remaining.c) === 0) {
                    const d = path.join(projectDirFor(slug), "_worktrees", wid);
                    try { if (dirExists(d)) fs.rmSync(d, { recursive: true, force: true }); } catch {}
                  }
                }
              }
            } catch {}
          }
        }
        // ---- 第 3 重：冷数据水位线归档 + 四道免死金牌 ----
        const slugs = discoverSlugs(db);
        // 补充 memories 中的 slug（discover 已含，但保险）
        try {
          const extra = db.prepare("SELECT DISTINCT project_slug FROM memories").all();
          for (const r of extra) if (r.project_slug && !slugs.includes(String(r.project_slug))) slugs.push(String(r.project_slug));
        } catch {}
        const staleMs = Number.isFinite(staleDays) && staleDays >= 0 ? Number(staleDays) * 86400000 : 60 * 86400000;
        for (const r of slugs) {
          if (!r) continue;
          let activeCount = 0;
          try {
            const c = db.prepare("SELECT COUNT(*) AS c FROM memories WHERE project_slug = ?").get(r);
            activeCount = c ? Number(c.c) : 0;
          } catch { activeCount = 0; }
          if (!(activeCount > maxActivePerProject)) continue;
          let candidates = [];
          try {
            candidates = db.prepare("SELECT * FROM memories WHERE project_slug = ? ORDER BY updated_at ASC, id ASC").all(r);
          } catch { candidates = []; }
          const cold = candidates.filter((row) => !isHygieneImmortalRow(row) && Number(row.hit_count) === 0 && hygieneAgeMs(row.updated_at || row.created_at || "", nowMs) > staleMs);
          if (!cold.length) continue;
          if (dryRun) {
            coldArchived += cold.length;
          } else {
            const items = cold.map((row) => rowToItem(row));
            appendHygieneArchive(r, "cold.md", items);
            coldArchived += cold.length;
            const mods = new Set(cold.map((row) => String(row.module || "topics")));
            const wHints = [];
            for (const row of cold) { if (String(row.memory_scope||"")==="worktree" && String(row.worktree_id||"")) wHints.push(String(row.worktree_id)); }
            for (const row of cold) deleteRowById(db, row.id);
            try { rewriteModules(db, r, [...mods], null, wHints); } catch {}
          }
        }
        // ---- 第 4 重：陈旧/孤儿向量清扫 ----
        // 孤儿向量：无条件清理
        try {
          const c = db.prepare("SELECT COUNT(*) AS c FROM memory_vectors WHERE id NOT IN (SELECT id FROM memories)").get();
          const orphanVecCount = c ? Number(c.c) : 0;
          if (dryRun) orphanVectorsDeleted = orphanVecCount;
          else if (orphanVecCount > 0) {
            db.prepare("DELETE FROM memory_vectors WHERE id NOT IN (SELECT id FROM memories)").run();
            orphanVectorsDeleted = orphanVecCount;
          } else orphanVectorsDeleted = 0;
        } catch {}
        if (purgeStaleModelVectors) {
          let activeId = null;
          let activeDim = null;
          try {
            const health = getEmbedHealthSync();
            if (health && health.modelId) { activeId = String(health.modelId); activeDim = health.dim != null ? Number(health.dim) : null; }
          } catch {}
          if (keepModelIdRaw) activeId = keepModelIdRaw;
          if (activeId) {
            // 检查当前激活模型已完成全量向量覆盖
            let fullyCovered = true;
            try {
              const memIds = db.prepare("SELECT id FROM memories").all().map((r) => String(r.id));
              if (memIds.length) {
                // 批量查已有当前模型向量
                const isLegacyActive = activeId === "mlx-community/embeddinggemma-2-8bit";
                let vecRows = [];
                try {
                  if (isLegacyActive) vecRows = db.prepare("SELECT id FROM memory_vectors WHERE model_id IN ('mlx-community/embeddinggemma-2-8bit','local','powercontext-legacy') AND dim = 768").all();
                  else if (activeDim != null && Number.isFinite(activeDim) && activeDim > 0) vecRows = db.prepare("SELECT id FROM memory_vectors WHERE model_id = ? AND dim = ?").all(activeId, activeDim);
                  else vecRows = db.prepare("SELECT id FROM memory_vectors WHERE model_id = ?").all(activeId);
                } catch { vecRows = []; }
                const vecSet = new Set(vecRows.map((r) => String(r.id)));
                for (const id of memIds) if (!vecSet.has(id)) { fullyCovered = false; break; }
              } else {
                fullyCovered = true;
              }
            } catch { fullyCovered = false; }
            if (fullyCovered) {
              let staleCount = 0;
              try {
                const isLegacyActive = activeId === "mlx-community/embeddinggemma-2-8bit";
                if (isLegacyActive) {
                  const c = db.prepare("SELECT COUNT(*) AS c FROM memory_vectors WHERE NOT (model_id IN ('mlx-community/embeddinggemma-2-8bit','local','powercontext-legacy') AND dim = 768)").get();
                  staleCount = c ? Number(c.c) : 0;
                  if (dryRun) staleVectorsDeleted = staleCount;
                  else if (staleCount > 0) {
                    db.prepare("DELETE FROM memory_vectors WHERE NOT (model_id IN ('mlx-community/embeddinggemma-2-8bit','local','powercontext-legacy') AND dim = 768)").run();
                    staleVectorsDeleted = staleCount;
                  }
                } else if (activeDim != null && Number.isFinite(activeDim) && activeDim > 0) {
                  const c = db.prepare("SELECT COUNT(*) AS c FROM memory_vectors WHERE model_id <> ? OR dim <> ?").get(activeId, activeDim);
                  staleCount = c ? Number(c.c) : 0;
                  if (dryRun) staleVectorsDeleted = staleCount;
                  else if (staleCount > 0) {
                    db.prepare("DELETE FROM memory_vectors WHERE model_id <> ? OR dim <> ?").run(activeId, activeDim);
                    staleVectorsDeleted = staleCount;
                  }
                } else {
                  const c = db.prepare("SELECT COUNT(*) AS c FROM memory_vectors WHERE model_id <> ?").get(activeId);
                  staleCount = c ? Number(c.c) : 0;
                  if (dryRun) staleVectorsDeleted = staleCount;
                  else if (staleCount > 0) {
                    db.prepare("DELETE FROM memory_vectors WHERE model_id <> ?").run(activeId);
                    staleVectorsDeleted = staleCount;
                  }
                }
              } catch {}
            }
          }
        }
        if (!dryRun && (orphanVectorsDeleted > 0 || staleVectorsDeleted > 0)) {
          try { db.exec("PRAGMA optimize;"); optimized = true; } catch {}
          if (vacuum) {
            try { db.exec("VACUUM;"); vacuumed = true; } catch {}
          }
        }
      } finally {
        db.close();
      }
      return {
        ok: true,
        dryRun,
        worktreeArchived,
        worktreeArchivedCount: worktreeArchived,
        coldArchived,
        coldArchivedCount: coldArchived,
        orphanVectorsDeleted,
        staleVectorsDeleted,
        deletedVectors: orphanVectorsDeleted + staleVectorsDeleted,
        staleVectorDeleted: staleVectorsDeleted,
        orphanVectorDeleted: orphanVectorsDeleted,
        optimized,
        vacuumed,
      };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  }
  // ---- AutoDream 梦境系统 ----
  let _dreaming = false;
  const DREAM_AGENT_PRESETS = [
    { id: "local-zero", dreamMode: "local", providerInstanceId: "local", model: "mlx-vector-only", label: "纯本地向量聚变 · 0 Token ($0/晚)", estCostPerNightUsd: 0 },
    { id: "muse-ember", dreamMode: "agent", providerInstanceId: "muse", model: "muse-ember-1.0", reasoningEffort: "medium", label: "Muse · muse-ember-1.0（推荐 · 约 $0.002/晚）", estCostPerNightUsd: 0.0018 },
    { id: "codex-terra", dreamMode: "agent", providerInstanceId: "codex", model: "gpt-6.1-terra", reasoningEffort: "medium", label: "Codex · gpt-6.1-terra（精炼 · 约 $0.012/晚）", estCostPerNightUsd: 0.012 },
    { id: "codex-sol", dreamMode: "agent", providerInstanceId: "codex", model: "gpt-6.1-sol", reasoningEffort: "medium", label: "Codex · gpt-6.1-sol（深度 · 约 $0.018/晚）", estCostPerNightUsd: 0.018 },
    { id: "claude-sonnet", dreamMode: "agent", providerInstanceId: "claude", model: "claude-sonnet-4-6", reasoningEffort: "medium", label: "Claude · claude-sonnet-4-6（约 $0.015/晚）", estCostPerNightUsd: 0.015 },
    { id: "pi-magpie", dreamMode: "agent", providerInstanceId: "pi", model: "magpie/group/code", reasoningEffort: "medium", label: "Pi · magpie/group/code（约 $0.005/晚）", estCostPerNightUsd: 0.005 },
  ];
  const DREAM_MODES = ["local", "agent"];
  const DREAM_PROVIDERS = ["local", "muse", "codex", "claude", "antigravity", "pi"];
  const DREAM_EFFORTS = ["low", "medium", "high"];
  // 梦境 Agent 输入硬闸门：严格 < 8000 token，配置上限钉死 7900（留指令头余量）。
  const DREAM_MAX_INPUT_TOKENS = 7900;
  const DREAM_MAX_REVIEWED_SIGS = 8192;
  const DREAM_PROMPT_HEAD = "你作为 T3 梦境精炼子智能体(dream-worker)，只读精炼以下记忆簇的冲突/近义条目，绝不倾倒全库全文。要求只输出严格 JSON：{\"merges\":[{\"keepId\":12,\"mergeIds\":[15],\"title\":\"...\",\"summary\":\"...\",\"content\":\"...\",\"reason\":\"...\"}]}。簇数据：";
  const DREAM_PROMPT_TAIL = "\n\n必须只输出 JSON，不要 Markdown、不要解释。";
  const DEFAULT_DREAM_CONFIG = { enabled: true, dreamTime: "03:00", catchUpOnWake: true, lastDreamAt: null, lastDreamDate: null, dreamCount: 0, lastReport: null, dreamMode: "agent", providerInstanceId: "muse", model: "muse-ember-1.0", reasoningEffort: "medium", minDeltaMemories: 3, maxClustersPerDream: 8, maxInputTokens: DREAM_MAX_INPUT_TOKENS, hasDeferredClusters: false, reviewedClusterSigs: [] };
  function defaultDreamConfig() {
    return { enabled: true, dreamTime: "03:00", catchUpOnWake: true, lastDreamAt: null, lastDreamDate: null, dreamCount: 0, lastReport: null, dreamMode: "agent", providerInstanceId: "muse", model: "muse-ember-1.0", reasoningEffort: "medium", minDeltaMemories: 3, maxClustersPerDream: 8, maxInputTokens: DREAM_MAX_INPUT_TOKENS, hasDeferredClusters: false, reviewedClusterSigs: [] };
  }
  function clampMaxInputTokens(raw, fallback) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 100) return fallback == null ? DREAM_MAX_INPUT_TOKENS : Number(fallback);
    return Math.min(DREAM_MAX_INPUT_TOKENS, Math.max(100, Math.floor(n)));
  }
  function estimateDreamTokens(text) {
    const s = String(text || "");
    if (!s) return 0;
    // 中日韩保守估算：CJK 每字 1.35 tokens，其余每字符 0.32 tokens（相对 chars/4 恒更保守）。
    const cjkMatches = s.match(/[\u3400-\u9fff\uf900-\ufaff]/g);
    const cjk = cjkMatches ? cjkMatches.length : 0;
    const others = Math.max(0, s.length - cjk);
    return Math.ceil(cjk * 1.35 + others * 0.32);
  }
  function estimateTokensForText(text) {
    return estimateDreamTokens(text);
  }
  function dreamClusterSignature(items) {
    const arr = Array.isArray(items) ? items : [];
    // 同毫秒内容/标签修改也必须重新送审；固定长度摘要避免大库签名随正文膨胀。
    const parts = arr.map((it) => JSON.stringify([it.id, it.updatedAt, it.title, it.content, it.tags,
      it.projectSlug, it.module, it.memoryScope, it.worktreeId, it.version])).sort();
    return crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  }
  function dreamRowFingerprint(row) {
    return JSON.stringify([row.id, row.updated_at, row.title, row.content, row.tags_json,
      row.project_slug, row.project_root, row.module, row.kind, row.agent, row.created_at,
      row.memory_scope, row.worktree_id, row.branch_name, row.version, row.history_json, row.supersedes_id]);
  }
  function dreamRowPinned(row) {
    const tags = rowToItem(row).tags;
    return tags.some((tag) => ["pinned", "core"].includes(String(tag).trim().toLowerCase()));
  }
  function buildDreamPrompt(clusters) {
    return DREAM_PROMPT_HEAD + JSON.stringify(clusters) + DREAM_PROMPT_TAIL;
  }
  // 梦境 CLI 纯异步非阻塞执行：child_process.spawn + stdin，stdout/stderr 流式收集（512KB 封顶），
  // 60s 超时先 SIGTERM、100ms 后 SIGKILL，超时/溢出/非零退出均经 Promise 拒绝优雅降级。
  function runDreamAgentCli(opts = {}) {
    const cmd = opts.cmd;
    const args = Array.isArray(opts.args) ? opts.args : [];
    const prompt = String(opts.prompt || "");
    const timeoutMs = opts.timeoutMs != null ? Number(opts.timeoutMs) : 60000;
    const maxOutputBytes = opts.maxOutputBytes != null ? Number(opts.maxOutputBytes) : 512 * 1024;
    return new Promise((resolve, reject) => {
      let child = null;
      try {
        child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, T3_SUBAGENT_ROLE: "dream-worker" } });
      } catch (e) {
        reject(new Error("cli-spawn-failed:" + String((e && e.message) || e)));
        return;
      }
      let settled = false;
      let timedOut = false;
      let killTimer = null;
      let stdoutLen = 0, stderrLen = 0;
      let stdoutBuf = [], stderrBuf = [];
      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGTERM"); } catch {}
        killTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 100);
        if (killTimer && typeof killTimer.unref === "function") killTimer.unref();
        finish(new Error("cli-timeout:exceeded-" + timeoutMs + "ms"));
      }, timeoutMs);
      if (timeoutTimer && typeof timeoutTimer.unref === "function") timeoutTimer.unref();
      function finish(err, val) {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        if (err) reject(err);
        else resolve(val);
      }
      child.on("error", (e) => {
        finish(new Error("cli-unavailable:" + String((e && e.message) || e)));
      });
      child.stdout.on("data", (chunk) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (!buf.length) return;
        const nextBytes = stdoutLen + buf.length;
        if (nextBytes > maxOutputBytes) {
          try { child.kill("SIGKILL"); } catch {}
          finish(new Error("cli-output-overflow:stdout>" + maxOutputBytes + "B"));
          return;
        }
        stdoutBuf.push(buf);
        stdoutLen = nextBytes;
      });
      child.stderr.on("data", (chunk) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (!buf.length) return;
        const nextBytes = stderrLen + buf.length;
        if (nextBytes > maxOutputBytes) {
          try { child.kill("SIGKILL"); } catch {}
          finish(new Error("cli-output-overflow:stderr>" + maxOutputBytes + "B"));
          return;
        }
        stderrBuf.push(buf);
        stderrLen = nextBytes;
      });
      child.on("close", (code) => {
        if (killTimer) clearTimeout(killTimer);
        if (settled) return;
        const stdout = Buffer.concat(stdoutBuf).toString("utf8");
        const stderr = Buffer.concat(stderrBuf).toString("utf8");
        if (timedOut) {
          finish(new Error("cli-timeout:exceeded-" + timeoutMs + "ms"));
          return;
        }
        if (code !== 0) {
          finish(new Error("cli-exit-" + code + ":" + String(stderr || "").slice(0, 500)));
          return;
        }
        finish(null, { stdout, stderr, status: code });
      });
      child.stdin.on("error", () => {});
      try {
        child.stdin.end(prompt);
      } catch (e) {
        finish(new Error("cli-spawn-failed:" + String((e && e.message) || e)));
      }
    });
  }
  function dreamAgentRate(providerInstanceId, model) {
    const prov = String(providerInstanceId || "").toLowerCase();
    const m = String(model || "").toLowerCase();
    if (prov === "local" || m === "mlx-vector-only") return { input: 0, output: 0 };
    if (prov === "muse" || m.includes("muse-ember")) return { input: 0.1 / 1e6, output: 0.5 / 1e6 };
    if (m.includes("gpt-6.1-terra")) return { input: 1.0 / 1e6, output: 5.0 / 1e6 };
    if (m.includes("gpt-6.1-sol") || m.includes("sol")) return { input: 2.0 / 1e6, output: 10.0 / 1e6 };
    if (m.includes("sonnet") || prov === "claude") return { input: 3.0 / 1e6, output: 15.0 / 1e6 };
    if (m.includes("magpie") || prov === "pi") return { input: 0.8 / 1e6, output: 4.0 / 1e6 };
    if (prov === "antigravity" || m.includes("carbon") || m.includes("argon")) return { input: 2.0 / 1e6, output: 10.0 / 1e6 };
    return { input: 0.1 / 1e6, output: 0.5 / 1e6 };
  }
  function summarizeMemoryForDream(item) {
    const content = String(item.content || "");
    // 绝不读取全文倾倒：仅摘要 500 字符
    const summary = content.split("\n")[0].slice(0, 220);
    const contentSnippet = content.slice(0, 500);
    return { id: item.id, title: item.title || "(无标题)", module: item.module || item.module || "topics", summary, content: contentSnippet };
  }
  function countDeltaSinceLastDream(db, lastDreamAt) {
    try {
      const totalRow = db.prepare("SELECT COUNT(*) AS c FROM memories").get();
      const total = totalRow ? Number(totalRow.c) || 0 : 0;
      if (!lastDreamAt) return total;
      const t = Date.parse(String(lastDreamAt));
      if (!Number.isFinite(t)) return total;
      const since = new Date(t).toISOString();
      const row = db.prepare("SELECT COUNT(*) AS c FROM memories WHERE updated_at > ? OR created_at > ?").get(since, since);
      return row ? Number(row.c) || 0 : 0;
    } catch {
      return 0;
    }
  }
  function dreamConfigPath() {
    return path.join(hubDir, "dream-config.json");
  }
  function dreamJournalPath() {
    return path.join(hubDir, "dream-journal.json");
  }
  function dreamConfigMirrorPath() {
    return path.join(path.dirname(vaultDir), "dream-config.json");
  }
  function dreamJournalMirrorPath() {
    return path.join(path.dirname(vaultDir), "dream-journal.json");
  }
  function normalizeDreamConfig(raw) {
    const base = defaultDreamConfig();
    if (!raw || typeof raw !== "object") return base;
    const out = { ...base, ...raw };
    if (typeof out.enabled !== "boolean") out.enabled = true;
    if (typeof out.dreamTime !== "string" || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(out.dreamTime)) out.dreamTime = "03:00";
    if (typeof out.catchUpOnWake !== "boolean") out.catchUpOnWake = true;
    if (out.lastDreamAt != null && typeof out.lastDreamAt !== "string") out.lastDreamAt = null;
    if (out.lastDreamDate != null && typeof out.lastDreamDate !== "string") out.lastDreamDate = null;
    // Agent 深睡水位（独立于每次浅睡都刷新的 lastDreamAt，防低频饥饿）。
    if (out.lastAgentDreamAt != null && typeof out.lastAgentDreamAt !== "string") out.lastAgentDreamAt = null;
    if (!Number.isFinite(Number(out.dreamCount)) || Number(out.dreamCount) < 0) out.dreamCount = 0;
    else out.dreamCount = Number(out.dreamCount);
    if (out.lastReport != null && typeof out.lastReport !== "object") out.lastReport = null;
    // 新增字段向后兼容
    if (!DREAM_MODES.includes(String(out.dreamMode || "").toLowerCase())) out.dreamMode = base.dreamMode;
    else out.dreamMode = String(out.dreamMode).toLowerCase();
    if (!DREAM_PROVIDERS.includes(String(out.providerInstanceId || "").toLowerCase())) out.providerInstanceId = base.providerInstanceId;
    else out.providerInstanceId = String(out.providerInstanceId).toLowerCase();
    if (typeof out.model !== "string" || !out.model.trim()) out.model = base.model;
    if (!DREAM_EFFORTS.includes(String(out.reasoningEffort || "").toLowerCase())) out.reasoningEffort = base.reasoningEffort;
    else out.reasoningEffort = String(out.reasoningEffort).toLowerCase();
    const nd = Number(out.minDeltaMemories);
    if (!Number.isFinite(nd) || nd < 0) out.minDeltaMemories = base.minDeltaMemories;
    else out.minDeltaMemories = Math.max(0, Math.floor(nd));
    const mc = Number(out.maxClustersPerDream);
    if (!Number.isFinite(mc) || mc < 1) out.maxClustersPerDream = base.maxClustersPerDream;
    else out.maxClustersPerDream = Math.max(1, Math.min(32, Math.floor(mc)));
    const mt = Number(out.maxInputTokens);
    if (!Number.isFinite(mt) || mt < 100) out.maxInputTokens = base.maxInputTokens;
    else out.maxInputTokens = clampMaxInputTokens(mt, base.maxInputTokens);
    // 分批截断去重：已审簇签名 + 剩余簇标记（向后兼容）
    if (typeof out.hasDeferredClusters !== "boolean") out.hasDeferredClusters = false;
    if (!Array.isArray(out.reviewedClusterSigs)) out.reviewedClusterSigs = [];
    else {
      const seen = new Set();
      const cleaned = [];
      for (const s of out.reviewedClusterSigs) {
        if (typeof s !== "string") continue;
        const sig = s.trim();
        if (!sig || seen.has(sig)) continue;
        seen.add(sig);
        cleaned.push(sig);
      }
      out.reviewedClusterSigs = cleaned.slice(-DREAM_MAX_REVIEWED_SIGS);
    }
    return out;
  }
  function readDreamConfig() {
    const primary = readJsonFile(dreamConfigPath(), null);
    if (primary && typeof primary === "object") return normalizeDreamConfig(primary);
    const mirror = dreamConfigMirrorPath();
    if (mirror !== dreamConfigPath()) {
      const fallback = readJsonFile(mirror, null);
      if (fallback && typeof fallback === "object") {
        const merged = normalizeDreamConfig(fallback);
        try { writeJsonFileAtomic(dreamConfigPath(), merged); } catch {}
        return merged;
      }
    }
    return defaultDreamConfig();
  }
  function writeDreamConfig(config) {
    try { writeJsonFileAtomic(dreamConfigPath(), config); } catch {}
    const mirror = dreamConfigMirrorPath();
    if (mirror !== dreamConfigPath()) {
      try { writeJsonFileAtomic(mirror, config); } catch {}
    }
  }
  function readDreamJournal() {
    let raw = readJsonFile(dreamJournalPath(), null);
    if (raw == null) {
      const mirror = dreamJournalMirrorPath();
      if (mirror !== dreamJournalPath()) raw = readJsonFile(mirror, null);
    }
    if (Array.isArray(raw)) return raw.slice(-30);
    if (raw && typeof raw === "object" && Array.isArray(raw.entries)) return raw.entries.slice(-30);
    return [];
  }
  function writeDreamJournal(entries) {
    const trimmed = Array.isArray(entries) ? entries.slice(-30) : [];
    const obj = { entries: trimmed };
    try { writeJsonFileAtomic(dreamJournalPath(), obj); } catch {}
    const mirror = dreamJournalMirrorPath();
    if (mirror !== dreamJournalPath()) {
      try { writeJsonFileAtomic(mirror, obj); } catch {}
    }
  }
  function ensureDreamFiles() {
    try {
      if (!fileExists(dreamConfigPath()) && !fileExists(dreamConfigMirrorPath())) writeDreamConfig(defaultDreamConfig());
    } catch {}
    try {
      if (!fileExists(dreamJournalPath()) && !fileExists(dreamJournalMirrorPath())) writeDreamJournal([]);
    } catch {}
  }
  function formatLocalDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }
  function getDreamState() {
    ensureDreamFiles();
    const config = readDreamConfig();
    const journal = readDreamJournal();
    return { ok: true, config, journal, presets: DREAM_AGENT_PRESETS, dreamAgentPresets: DREAM_AGENT_PRESETS, DREAM_AGENT_PRESETS: DREAM_AGENT_PRESETS };
  }
  function getDreamOverview() {
    ensureDreamFiles();
    const config = readDreamConfig();
    const journal = readDreamJournal();
    // 当前命中预设
    let currentPreset = null;
    try {
      const match = DREAM_AGENT_PRESETS.find((p) => p.dreamMode === config.dreamMode && p.providerInstanceId === config.providerInstanceId && p.model === config.model);
      currentPreset = match || null;
    } catch {}
    const nextPresetCost = currentPreset ? currentPreset.estCostPerNightUsd : 0;
    return { ok: true, config, journal, presets: DREAM_AGENT_PRESETS, dreamAgentPresets: DREAM_AGENT_PRESETS, DREAM_AGENT_PRESETS: DREAM_AGENT_PRESETS, currentPreset, estCostPerNightUsd: nextPresetCost };
  }
  function updateDreamConfig(patch = {}) {
    const p = patch && typeof patch === "object" ? patch : {};
    const current = readDreamConfig();
    const next = { ...current };
    if ("enabled" in p) {
      if (typeof p.enabled !== "boolean") return { ok: false, error: "invalid enabled (expected boolean)" };
      next.enabled = p.enabled;
    }
    if ("dreamTime" in p) {
      const v = p.dreamTime;
      if (typeof v !== "string" || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(v)) return { ok: false, error: "invalid dreamTime (expected HH:MM)" };
      next.dreamTime = v;
    }
    if ("catchUpOnWake" in p) {
      if (typeof p.catchUpOnWake !== "boolean") return { ok: false, error: "invalid catchUpOnWake (expected boolean)" };
      next.catchUpOnWake = p.catchUpOnWake;
    }
    // 新增 Agent 自选字段校验
    if ("dreamMode" in p) {
      const v = String(p.dreamMode || "").toLowerCase();
      if (!DREAM_MODES.includes(v)) return { ok: false, error: "invalid dreamMode (expected local|agent)" };
      next.dreamMode = v;
    }
    if ("providerInstanceId" in p) {
      const v = String(p.providerInstanceId || "").toLowerCase();
      if (!DREAM_PROVIDERS.includes(v)) return { ok: false, error: "invalid providerInstanceId (expected local|muse|codex|claude|antigravity|pi)" };
      next.providerInstanceId = v;
    }
    if ("model" in p) {
      if (typeof p.model !== "string" || !p.model.trim()) return { ok: false, error: "invalid model (expected string)" };
      next.model = p.model.trim();
    }
    if ("reasoningEffort" in p) {
      const v = String(p.reasoningEffort || "").toLowerCase();
      if (!DREAM_EFFORTS.includes(v)) return { ok: false, error: "invalid reasoningEffort (expected low|medium|high)" };
      next.reasoningEffort = v;
    }
    if ("minDeltaMemories" in p) {
      const n = Number(p.minDeltaMemories);
      if (!Number.isFinite(n) || n < 0) return { ok: false, error: "invalid minDeltaMemories (expected non-negative number)" };
      next.minDeltaMemories = Math.floor(n);
    }
    if ("maxClustersPerDream" in p) {
      const n = Number(p.maxClustersPerDream);
      if (!Number.isFinite(n) || n < 1 || n > 32) return { ok: false, error: "invalid maxClustersPerDream (expected 1..32)" };
      next.maxClustersPerDream = Math.floor(n);
    }
    if ("maxInputTokens" in p) {
      const n = Number(p.maxInputTokens);
      if (!Number.isFinite(n) || n < 100) return { ok: false, error: "invalid maxInputTokens (expected >= 100)" };
      // 硬锁：超大值直接 clamp 到上限（严格 < 8000），不原样落盘。
      next.maxInputTokens = clampMaxInputTokens(n, current.maxInputTokens);
    }
    writeDreamConfig(next);
    return { ok: true, config: next };
  }
  async function runDreamCycle(opts = {}) {
    if (_dreaming) return { ok: false, error: "dream already in progress" };
    const o = opts && typeof opts === "object" ? opts : {};
    const reason = typeof o.reason === "string" && o.reason ? o.reason : "manual";
    let now = o.now ? (o.now instanceof Date ? o.now : new Date(o.now)) : new Date();
    if (Number.isNaN(now.getTime())) now = new Date();
    _dreaming = true;
    const startedAt = Date.now();
    try {
      const recovery = recoverPendingDreamJournal();
      if (recovery.reason === "active-transaction") return { ok: false, error: "dream transaction lock busy" };
      let slugs = [];
      try {
        const db = openDb();
        try { slugs = discoverSlugs(db); } finally { db.close(); }
      } catch { slugs = [GLOBAL_SLUG]; }
      if (!slugs.includes(GLOBAL_SLUG)) slugs.unshift(GLOBAL_SLUG);
      const scannedProjects = slugs.length;
      let mergedCount = 0;
      for (const slug of slugs) {
        try {
          const r = consolidateMemories({ projectSlug: slug });
          if (r && r.ok && Number.isFinite(Number(r.mergedCount))) mergedCount += Number(r.mergedCount) || 0;
        } catch {}
      }
      let promotedCount = 0;
      try {
        const db = openDb();
        let rows = [];
        try { rows = db.prepare("SELECT * FROM memories WHERE memory_scope='worktree'").all(); } finally { db.close(); }
        const candidates = [];
        for (const r of rows) {
          const hc = Number(r.hit_count) || 0;
          let tags = [];
          try { const j = JSON.parse(r.tags_json || "[]"); if (Array.isArray(j)) tags = j; } catch { tags = []; }
          const lowered = tags.map((t) => String(t).trim().toLowerCase());
          const tagged = lowered.includes("promote") || lowered.includes("shared") || lowered.includes("important");
          if (hc >= 2 || tagged) candidates.push(r);
        }
        for (const r of candidates) {
          try {
            const res = promoteWorktreeMemory({ id: r.id });
            if (res && res.ok) promotedCount += 1;
          } catch {}
        }
      } catch {}
      let archivedCount = 0;
      let purgedVectorsCount = 0;
      for (const slug of slugs) {
        try {
          const hygieneOpts = { projectSlug: slug, purgeStaleModelVectors: true, ...o };
          if (hygieneOpts.now == null) hygieneOpts.now = now.toISOString();
          const res = runHygiene(hygieneOpts);
          if (res && res.ok) {
            const orphan = Number(res.worktreeArchivedCount ?? res.worktreeArchived ?? 0) || 0;
            const cold = Number(res.coldArchivedCount ?? res.coldArchived ?? 0) || 0;
            archivedCount += orphan + cold;
            const purged = Number(res.deletedVectors ?? ((Number(res.orphanVectorsDeleted) || 0) + (Number(res.staleVectorsDeleted) || 0))) || 0;
            purgedVectorsCount += purged;
          }
        } catch {}
      }
      let vectorsSynced = 0;
      try {
        let beforeCount = 0;
        try {
          const db = openDb();
          try {
            const r = db.prepare("SELECT COUNT(*) AS c FROM memory_vectors").get();
            beforeCount = r ? Number(r.c) || 0 : 0;
          } finally { db.close(); }
        } catch { beforeCount = 0; }
        let afterCount = beforeCount;
        try {
          await performBatchEmbedding();
          try {
            const db2 = openDb();
            try {
              const cr = db2.prepare("SELECT COUNT(*) AS c FROM memory_vectors").get();
              afterCount = cr ? Number(cr.c) || 0 : beforeCount;
            } finally { db2.close(); }
          } catch {}
          vectorsSynced = Math.max(0, afterCount - beforeCount);
        } catch { vectorsSynced = 0; }
      } catch { vectorsSynced = 0; }
      // ---- 第二层：深睡 Agent 语义消歧（严格 <8000 Token） ----
      let dreamMode = "agent";
      let agentUsed = null;
      let ambiguousClustersFound = 0;
      let agentMergedCount = 0;
      let agentDeepSleepSucceeded = false;
      let scannedClusterCount = 0;
      let deferredClusterCount = 0;
      let hasDeferredClusters = false;
      let newlyReviewedSigs = [];
      let mergeErrors = 0;
      let invalidSuggestions = 0;
      let conflictSkippedCount = 0;
      let estimatedInputTokens = 0;
      let estimatedOutputTokens = 0;
      let estimatedCostUsd = 0;
      let agentFallbackReason = null;
      let deltaSince = null;
      const earlyConfig = readDreamConfig();
      dreamMode = earlyConfig.dreamMode || "agent";
      const providerInstanceId = earlyConfig.providerInstanceId || "muse";
      const model = earlyConfig.model || "muse-ember-1.0";
      const reasoningEffort = earlyConfig.reasoningEffort || "medium";
      const minDeltaMemories = earlyConfig.minDeltaMemories != null ? Number(earlyConfig.minDeltaMemories) : 3;
      const maxClustersPerDream = earlyConfig.maxClustersPerDream != null ? Number(earlyConfig.maxClustersPerDream) : 8;
      const maxInputTokens = clampMaxInputTokens(earlyConfig.maxInputTokens, DREAM_MAX_INPUT_TOKENS);
      // 深睡门槛水位：以 lastAgentDreamAt 为基准（为空则取全量），绝不用每次浅睡都刷新的 lastDreamAt，
      // 否则低频新增（< minDeltaMemories）会每天从 0 重算、永远凑不够深睡门槛。
      let agentBaseline = earlyConfig.lastAgentDreamAt != null ? String(earlyConfig.lastAgentDreamAt) : null;
      // 计算 delta（距上次 Agent 深睡新增或更新条数）
      try {
        const dbTmp = openDb();
        try { deltaSince = countDeltaSinceLastDream(dbTmp, agentBaseline); } finally { dbTmp.close(); }
      } catch { deltaSince = 0; }
      const forced = o.force === true;
      const prevReviewedSigs = Array.isArray(earlyConfig.reviewedClusterSigs) ? earlyConfig.reviewedClusterSigs.filter((s) => typeof s === "string") : [];
      const prevReviewedSet = new Set(prevReviewedSigs);
      const prevHasDeferred = earlyConfig.hasDeferredClusters === true;
      let shouldRunAgent = false;
      if (dreamMode === "agent" && !forced) {
        if (prevHasDeferred) {
          // 剩余簇待消化：跳过 minDelta 门槛，下次无需新增即可继续
          shouldRunAgent = true;
          agentFallbackReason = null;
        } else if (deltaSince != null && deltaSince < minDeltaMemories) {
          agentFallbackReason = "gate-skip-delta";
          shouldRunAgent = false;
        } else {
          shouldRunAgent = true;
        }
      } else if (dreamMode === "agent" && forced) {
        shouldRunAgent = true;
      } else if (dreamMode === "local") {
        shouldRunAgent = false;
        agentFallbackReason = null;
      }
      // 仅在 agent 模式且有潜在簇时才计算簇，但 gate 跳过时也直接 0 Token
      if (dreamMode === "agent" && shouldRunAgent) {
        try {
          // 找灰区簇：同 project_slug + module + scope + worktree，0.75<=cos<0.92 (P1-A 工作树隔离)
          const allClusters = [];
          const db = openDb();
          let rowsAll = [];
          try { rowsAll = db.prepare("SELECT * FROM memories").all(); } finally { db.close(); }
          const snapshotRows = new Map(rowsAll.map((row) => [String(row.id), row]));
          const itemsAll = rowsAll.filter((row) => !dreamRowPinned(row)).map(rowToItem);
          // 按 slug+module+scope+worktree 分组，隔离不同 worktree 专属记忆
          const groups = new Map();
          for (const it of itemsAll) {
            const s = normalizedDreamScopeFromItem(it);
            const w = normalizedWorktreeFromItem(it);
            const key = String(it.projectSlug || "") + "|" + String(it.module || "") + "|" + s + "|" + w;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(it);
          }
          const db2 = openDb();
          try {
            for (const [key, groupItems] of groups) {
              if (groupItems.length < 2) continue;
              const vectors = vectorsFor(db2, groupItems);
              // 构建边表
              const adj = new Map();
              for (const a of groupItems) adj.set(a.id, new Set());
              for (let i = 0; i < groupItems.length; i++) {
                for (let j = i + 1; j < groupItems.length; j++) {
                  const a = groupItems[i], b = groupItems[j];
                  const sim = similarity(a, b, vectors);
                  const c = sim.cosine;
                  if (c == null) continue;
                  if (c >= 0.75 && c < 0.92) {
                    adj.get(a.id).add(b.id);
                    adj.get(b.id).add(a.id);
                  }
                }
              }
              // 连通分量
              const visited = new Set();
              for (const start of groupItems) {
                if (visited.has(start.id)) continue;
                // BFS
                const stack = [start.id];
                const comp = new Set();
                while (stack.length) {
                  const cur = stack.pop();
                  if (comp.has(cur) || visited.has(cur)) continue;
                  visited.add(cur);
                  comp.add(cur);
                  const neigh = adj.get(cur);
                  if (neigh) for (const nb of neigh) if (!comp.has(nb) && !visited.has(nb)) stack.push(nb);
                }
                if (comp.size < 2) continue;
                // 簇内条目
                let compItems = groupItems.filter((x) => comp.has(x.id));
                // 若超过 5 条，切分
                if (compItems.length > 5) {
                  // 按 id 排序后切 5 为一组，避免信息丢失
                  compItems.sort((a,b)=>String(a.id).localeCompare(String(b.id)));
                  for (let s=0; s<compItems.length; s+=5) {
                    const chunk = compItems.slice(s, s+5);
                    if (chunk.length < 2) continue;
                    allClusters.push({ projectSlug: chunk[0].projectSlug, module: chunk[0].module, scope: normalizedDreamScopeFromItem(chunk[0]), worktreeId: normalizedWorktreeFromItem(chunk[0]), items: chunk, rawItems: chunk });
                  }
                } else {
                  allClusters.push({ projectSlug: compItems[0].projectSlug, module: compItems[0].module, scope: normalizedDreamScopeFromItem(compItems[0]), worktreeId: normalizedWorktreeFromItem(compItems[0]), items: compItems, rawItems: compItems });
                }
              }
            }
          } finally { db2.close(); }
          // 按簇大小与平均相似度排序（优先送审更一致的簇）
          // 简单按 items.length 降序
          allClusters.sort((a,b)=> b.items.length - a.items.length);
          // 已审未合并簇去重：签名未变的已审簇跳过，防止固定挑同一批反复送审
          const unreviewedClusters = allClusters.filter((cl) => !prevReviewedSet.has(dreamClusterSignature(cl.rawItems || cl.items)));
          scannedClusterCount = unreviewedClusters.length;
          // 先按 maxClustersPerDream 截断（基于未审簇）
          let candidateClusters = unreviewedClusters.slice(0, maxClustersPerDream);
          // Token 闸门：估算并截断
          let kept = [];
          let accTokens = 0;
          for (const cl of candidateClusters) {
            const summary = { projectSlug: cl.projectSlug, module: cl.module, items: cl.items.map(summarizeMemoryForDream) };
            const tokens = estimateTokensForText(JSON.stringify(summary));
            if (kept.length > 0 && accTokens + tokens > maxInputTokens) {
              // 第一簇即使粗估超限也须进入完整 Prompt 裁剪器，避免永久饥饿。
              continue;
            }
            accTokens += tokens;
            kept.push({ ...cl, summaryItems: summary.items, estimatedTokens: tokens });
          }
          // 完整 Prompt 守卫：含指令头 + JSON 簇列表后重估，若 >= 上限则弹尾部簇，
          // 单簇仍超限则截正文，确保实际送出的完整 Prompt 严格 < maxInputTokens（≤7900 < 8000）。
          let promptClusters = kept.map((cl, idx) => ({ id: idx, projectSlug: cl.projectSlug, module: cl.module, items: cl.summaryItems.map((it) => ({ ...it })) }));
          let fullPrompt = buildDreamPrompt(promptClusters);
          while (promptClusters.length > 1 && estimateDreamTokens(fullPrompt) >= maxInputTokens) {
            promptClusters.pop();
            kept.pop();
            fullPrompt = buildDreamPrompt(promptClusters);
          }
          if (promptClusters.length === 1 && estimateDreamTokens(fullPrompt) >= maxInputTokens) {
            const singleItems = promptClusters[0].items;
            while (singleItems.length && estimateDreamTokens(fullPrompt) >= maxInputTokens) {
              let shrunk = false;
              for (let i = singleItems.length - 1; i >= 0; i--) {
                for (const field of ["content", "summary"]) {
                  const c = String(singleItems[i][field] || "");
                  if (c.length > 0) {
                    singleItems[i] = { ...singleItems[i], [field]: c.slice(0, Math.floor(c.length / 2)) };
                    shrunk = true;
                    break;
                  }
                }
                if (shrunk) break;
              }
              if (!shrunk) break;
              fullPrompt = buildDreamPrompt(promptClusters);
            }
          }
          if (promptClusters.length > 0 && estimateDreamTokens(fullPrompt) >= maxInputTokens) {
            // 指令头本身已逼近上限（如极小 maxInputTokens）：不发送，0 Token 降级。
            promptClusters = [];
            kept = [];
            fullPrompt = "";
            agentFallbackReason = "prompt-over-budget";
          }
          ambiguousClustersFound = promptClusters.length;
          deferredClusterCount = Math.max(0, unreviewedClusters.length - ambiguousClustersFound);
          // 骨架预算不足需要调整配置，不得开启无意义的 deferred 自动重入。
          hasDeferredClusters = deferredClusterCount > 0 && agentFallbackReason !== "prompt-over-budget";
          // 若有簇则调用 Agent
          if (promptClusters.length > 0) {
            estimatedInputTokens = estimateDreamTokens(fullPrompt);
            const payloadForAgent = { clusters: promptClusters, dreamMode, providerInstanceId, model, reasoningEffort };
            let agentResult = null;
            let runnerError = null;
            const runner = typeof o.agentRunner === "function" ? o.agentRunner : null;
            if (runner) {
              try {
                const out = await runner(payloadForAgent);
                if (typeof out === "string") {
                  try { agentResult = JSON.parse(out); } catch(e) { runnerError = "json-parse-failed"; }
                } else if (out && typeof out === "object") {
                  agentResult = out;
                } else {
                  runnerError = "invalid-agent-result";
                }
              } catch(e) {
                runnerError = String((e && e.message) || e);
              }
            } else {
              // 默认生产实现：子进程调用宿主 CLI，非交互，timeout 60000，环境 T3_SUBAGENT_ROLE=dream-worker
              try {
                const prompt = fullPrompt;
                let cmd, args;
                const prov = String(providerInstanceId).toLowerCase();
                if (prov === "codex") { cmd = "codex"; args = ["exec", "--skip-git-repo-check", "-m", model]; }
                else if (prov === "claude") { cmd = "claude"; args = ["-p", "--model", model]; }
                else if (prov === "pi") { cmd = "pi"; args = ["-p", "--model", model]; }
                else if (prov === "muse") { cmd = "muse"; args = []; }
                else if (prov === "antigravity") { cmd = "antigravity"; args = ["--model", model]; }
                else { cmd = "muse"; args = []; }
                try {
                  // 纯异步非阻塞执行：await 让出事件循环，深睡等待期间 Node 仍可并发响应。
                  const res = await runDreamAgentCli({ cmd, args, prompt, timeoutMs: 60000, maxOutputBytes: 512 * 1024 });
                  const txt = String(res.stdout || "").trim();
                  // 截取首个 JSON
                  const m = txt.match(/\{[\s\S]*\}/);
                  if (!m) runnerError = "json-parse-failed";
                  else {
                    try { agentResult = JSON.parse(m[0]); } catch(e) { runnerError = "json-parse-failed"; }
                  }
                } catch(e) {
                  runnerError = String(e && e.message || e);
                }
              } catch(e) {
                runnerError = String(e && e.message || e);
              }
            }
            if (runnerError) {
              agentFallbackReason = runnerError;
              estimatedInputTokens = 0;
              estimatedOutputTokens = 0;
              estimatedCostUsd = 0;
              agentUsed = null;
              // 调用失败未消化任何簇，剩余全部待重审且不推进水位
              deferredClusterCount = unreviewedClusters.length;
              hasDeferredClusters = deferredClusterCount > 0;
              newlyReviewedSigs = [];
            } else if (agentResult && Array.isArray(agentResult.merges)) {
              // 校验并执行合并
              const merges = agentResult.merges;
              // 准备簇 id 集合映射
              const clusterIdSet = new Map(); // id -> cluster idx
              for (let idx=0; idx<kept.length; idx++) {
                for (const it of kept[idx].rawItems) clusterIdSet.set(String(it.id), idx);
              }
              let applied = 0;
              const appliedClusterIndices = new Set();
              const failedClusterIndices = new Set();
              const proposalsByCluster = new Map();
              const claimedIds = new Set();
              // 先验证整批建议再执行。无法定位的坏建议保守地使整批待审；
              // 跨簇建议同时污染所有提到的簇，绝不能按 keepId 的“出现”虚报完成。
              for (const m of merges) {
                const keepRaw = m && (m.keepId ?? m.keep_id ?? m.keep);
                const idsRaw = m && (m.mergeIds ?? m.merge_ids ?? m.mergeIdsList);
                const isId = (id) => typeof id === "string" || (typeof id === "number" && Number.isFinite(id));
                const keepId = isId(keepRaw) ? String(keepRaw) : null;
                const mergeIds = Array.isArray(idsRaw) ? idsRaw.filter(isId).map(String) : [];
                const touched = new Set([keepId, ...mergeIds].filter((id) => clusterIdSet.has(id)).map((id) => clusterIdSet.get(id)));
                const clIdx = clusterIdSet.get(keepId);
                const content = m && (typeof m.content === "string" && m.content.trim() ? m.content.trim()
                  : typeof m.summary === "string" ? m.summary.trim() : "");
                const title = m && typeof m.title === "string" ? m.title.trim().slice(0, 300) : "";
                const ids = [keepId, ...mergeIds];
                const valid = m && typeof m === "object" && clIdx != null && Array.isArray(idsRaw)
                  && mergeIds.length > 0 && mergeIds.length === idsRaw.length
                  && new Set(ids).size === ids.length && !ids.some((id) => claimedIds.has(id))
                  && mergeIds.every((id) => clusterIdSet.get(id) === clIdx)
                  && content && !containsSecret(content) && !containsSecret(title);
                if (!valid) {
                  invalidSuggestions++;
                  mergeErrors++;
                  for (const idx of touched.size ? touched : kept.keys()) failedClusterIndices.add(idx);
                  continue;
                }
                ids.forEach((id) => claimedIds.add(id));
                if (!proposalsByCluster.has(clIdx)) proposalsByCluster.set(clIdx, []);
                proposalsByCluster.get(clIdx).push({ keepId, mergeIds, title, content: content.slice(0, 10000) });
              }
              const db3 = openDb();
              try {
                for (let clIdx = 0; clIdx < kept.length; clIdx++) {
                  if (failedClusterIndices.has(clIdx)) continue;
                  const proposals = proposalsByCluster.get(clIdx) || [];
                  let clusterApplied = 0;
                  let journalWritten = false;
                  let journalObj = null;
                  let txLock = null;
                  let began = false;
                  let committed = false;
                  try {
                    try {
                      txLock = requireDreamTxLock();
                      recoverPendingDreamJournal(txLock);
                    } catch (e) { e.dreamTxFatal = true; throw e; }
                    db3.exec("PRAGMA synchronous = FULL");
                    // 写锁内逐条 CAS，包含未合并成员：Agent 的判断基于完整簇。
                    // 无建议的簇也验证快照，不能把等待期间变化的旧版本标为已审。
                    db3.exec("BEGIN IMMEDIATE");
                    began = true;
                    const currentRows = new Map();
                    for (const it of kept[clIdx].rawItems) {
                      const id = String(it.id);
                      const current = db3.prepare("SELECT * FROM memories WHERE id=?").get(id);
                      const original = snapshotRows.get(id);
                      if (!current || dreamRowPinned(current) || dreamRowFingerprint(current) !== dreamRowFingerprint(original)) {
                        const error = new Error("dream-snapshot-conflict");
                        error.dreamConflict = true;
                        throw error;
                      }
                      currentRows.set(id, current);
                    }
                    // P1-A: 校验 scope+worktree 隔离，禁止跨树合并
                    for (const m of proposals) {
                      const keepRow = currentRows.get(m.keepId);
                      const mergeRows = m.mergeIds.map((id) => currentRows.get(id));
                      const kScope = normalizedDreamScopeFromRow(keepRow);
                      const kWid = normalizedWorktreeFromRow(keepRow);
                      if (mergeRows.some((row) => row.project_slug !== keepRow.project_slug || row.module !== keepRow.module || normalizedDreamScopeFromRow(row) !== kScope || normalizedWorktreeFromRow(row) !== kWid)) throw new Error("dream-cluster-mismatch");
                    }
                    // P1-B: 快照前像并原子写入意图日志（崩溃前置）
                    if (proposals.length) {
                      try {
                        const slug = kept[clIdx].projectSlug;
                        const mod = kept[clIdx].module;
                        const scope = kept[clIdx].scope || normalizedDreamScopeFromItem(kept[clIdx].rawItems[0] || {});
                        const worktreeId = kept[clIdx].worktreeId || normalizedWorktreeFromItem(kept[clIdx].rawItems[0] || {});
                        const archivePath = path.join(projectDirFor(slug), "_archive", "dream-merged.md");
                        const archivePre = snapshotFile(archivePath);
                        const markdownPreImages = captureMarkdownPreImages(slug, mod, currentRows);
                        journalObj = {
                          version: 2, kind: "dream",
                          txId: crypto.randomUUID(),
                          createdAt: nowIso(),
                          clusters: [{
                            projectSlug: slug,
                            module: mod,
                            deletedWorktreeHints: worktreeId ? [worktreeId] : [],
                            scope: String(scope || ""),
                            worktreeId: String(worktreeId || ""),
                            archivePath,
                            archivePre,
                            markdownPreImages,
                            proposals: proposals.map((m) => ({
                              keepId: String(m.keepId),
                              mergeIds: m.mergeIds.map(String),
                              mergeItems: m.mergeIds.map((id) => rowToItem(currentRows.get(id))),
                            })),
                          }],
                        };
                        const cl = journalObj.clusters[0];
                        // Keep the existing 256 KiB rotation policy, with a deterministic
                        // destination recorded before either archive file is changed.
                        let archiveBase = archivePre.content || "";
                        if (Buffer.byteLength(archiveBase, "utf8") > 256 * 1024) {
                          cl.archiveRotatedPath = archivePath.replace(/\.md$/, "-" + journalObj.txId + ".md");
                          cl.archiveRotatedPre = snapshotFile(cl.archiveRotatedPath);
                          archiveBase = "";
                        }
                        cl.archivePost = renderHygieneArchive("dream-merged.md", cl.proposals.flatMap((p) => p.mergeItems), archiveBase);
                        journalWritten = true;
                        writeDreamTxJournal(journalObj);
                      } catch (jErr) {
                        // journal 写失败则禁止提交，避免崩溃时无恢复
                        throw jErr;
                      }
                    }
                    for (const m of proposals) {
                      const keepRow = currentRows.get(m.keepId);
                      const mergeRows = m.mergeIds.map((id) => currentRows.get(id));
                      const keepItem = rowToItem(keepRow);
                      const updated = { ...keepItem, title: m.title || keepItem.title, content: m.content,
                        updatedAt: nowIso(), version: (Number(keepItem.version) || 1) + 1, history: archiveRevision(keepItem, "dream-merge") };
                      // 归档成功后才写保留项/删除，任何失败同时回滚整个簇与归档。
                      // The journal owns the exact archive image, including partial-write retries.
                      const archive = journalObj.clusters[0];
                      if (archive.archiveRotatedPath) restoreFile(archive.archiveRotatedPath, archive.archivePre);
                      restoreFile(archive.archivePath, { exists: true, content: archive.archivePost });
                      upsertRow(db3, { ...updated, projectRoot: keepRow.project_root });
                      db3.prepare("DELETE FROM memory_vectors WHERE id=?").run(m.keepId);
                      for (const row of mergeRows) deleteRowById(db3, row.id);
                      clusterApplied += m.mergeIds.length;
                    }
                    // Markdown 是真源：写入失败也必须在 COMMIT 前回滚数据库与归档。
                    // P1-A: 删除前收集 hints（mergeRows 的 wid），确保空 worktree 重写为空
                    if (proposals.length) {
                      const hints = [];
                      try {
                        for (const m of proposals) {
                          for (const id of m.mergeIds) {
                            const r = currentRows.get(id);
                            const w = normalizedWorktreeFromRow(r);
                            if (w) hints.push(w);
                            const ks = normalizedDreamScopeFromRow(currentRows.get(m.keepId));
                            if (ks === "worktree" && normalizedWorktreeFromRow(r)) hints.push(normalizedWorktreeFromRow(r));
                          }
                        }
                      } catch {}
                      rewriteModules(db3, kept[clIdx].projectSlug, [kept[clIdx].module], { db: db3 }, hints);
                    }
                    if (journalObj) db3.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('last_committed_tx_id',?)").run(journalObj.txId);
                    db3.exec("COMMIT");
                    committed = true;
                    if (journalWritten) finishDreamTx(db3, journalObj, true);
                  } catch (e) {
                    if (e.dreamTxFatal) throw e;
                    if (began && !committed && !(journalObj && committedDreamTx(db3, journalObj))) {
                      rollbackDreamTx(db3, journalWritten ? journalObj : null, e);
                    } else if (committed || (journalObj && committedDreamTx(db3, journalObj))) {
                      // Never undo committed data or let another cluster overwrite its journal.
                      e.dreamTxFatal = true;
                      throw e;
                    }
                    mergeErrors++;
                    if (e.dreamConflict) conflictSkippedCount++;
                    failedClusterIndices.add(clIdx);
                    continue;
                  } finally { releaseDreamTxLock(txLock); }
                  if (proposals.length) {
                    appliedClusterIndices.add(clIdx);
                    applied += clusterApplied;
                  } else {
                    const sig = dreamClusterSignature(kept[clIdx].rawItems);
                    newlyReviewedSigs.push(sig);
                  }
                }
              } finally { db3.close(); }
              // 同步刷新向量（删向量后续批量会自动补齐，这里触发异步）
              try { await performBatchEmbedding(); } catch {}
              // 只有真正提交成功或明确无建议且快照未变的簇才算完成。
              const completedClusterCount = [...kept.keys()].filter((idx) => !failedClusterIndices.has(idx)
                && (appliedClusterIndices.has(idx) || !proposalsByCluster.has(idx))).length;
              deferredClusterCount = unreviewedClusters.length - completedClusterCount;
              hasDeferredClusters = deferredClusterCount > 0;
              agentMergedCount = applied;
              // 估算输出 tokens 与成本
              estimatedOutputTokens = Math.ceil(estimatedInputTokens * 0.25) || 100;
              const rate = dreamAgentRate(providerInstanceId, model);
              estimatedCostUsd = estimatedInputTokens * rate.input + estimatedOutputTokens * rate.output;
              agentUsed = { providerInstanceId, model };
              agentDeepSleepSucceeded = failedClusterIndices.size === 0;
              if (estimatedInputTokens > maxInputTokens) {
                // 理论上不应超；完整 Prompt 守卫已压到 < 上限，此处仅作诚实计量兜底。
                estimatedInputTokens = maxInputTokens;
              }
            } else {
              agentFallbackReason = "invalid-agent-result";
              estimatedInputTokens = 0;
              estimatedOutputTokens = 0;
              estimatedCostUsd = 0;
              deferredClusterCount = unreviewedClusters.length;
              hasDeferredClusters = deferredClusterCount > 0;
              newlyReviewedSigs = [];
            }
          } else {
            // 无簇：扫描确认 0 灰区冲突需送审，推进 Agent 水位以免空转重扫。
            if (scannedClusterCount === 0) agentDeepSleepSucceeded = true;
            estimatedInputTokens = 0;
            estimatedOutputTokens = 0;
            estimatedCostUsd = 0;
            agentUsed = null;
          }
        } catch (e) {
          if (e.dreamTxFatal) throw e;
          agentFallbackReason = String((e&&e.message)||e||"unknown");
          estimatedInputTokens = 0;
          estimatedOutputTokens = 0;
          estimatedCostUsd = 0;
          agentUsed = null;
          // 异常未完成扫描：保留旧水位与待处理标记以便下次重审
          hasDeferredClusters = true;
          deferredClusterCount = Math.max(1, scannedClusterCount, deferredClusterCount);
          agentDeepSleepSucceeded = false;
          newlyReviewedSigs = [];
        }
      } else if (dreamMode === "agent" && !shouldRunAgent) {
        // gate 跳过
        estimatedInputTokens = 0;
        estimatedOutputTokens = 0;
        estimatedCostUsd = 0;
        agentUsed = null;
        // ambiguousClustersFound 保持 0，表示未送审；保留旧待处理标记
        hasDeferredClusters = prevHasDeferred;
        if (prevHasDeferred && !(deferredClusterCount > 0)) deferredClusterCount = 1;
        // ambiguousClustersFound 保持 0，表示未送审
      } else {
        // local 模式
        estimatedInputTokens = 0;
        estimatedOutputTokens = 0;
        estimatedCostUsd = 0;
        agentUsed = null;
        // local 模式不消费 deferred，保留标记供切回 agent 时重审
        hasDeferredClusters = prevHasDeferred;
        if (prevHasDeferred && !(deferredClusterCount > 0)) deferredClusterCount = 1;
      }
      const durationMs = Date.now() - startedAt;
      let dbSizeMb = 0;
      try {
        const st = fs.statSync(indexDbPath);
        dbSizeMb = Math.round((Number(st.size) / (1024 * 1024)) * 100) / 100;
      } catch { dbSizeMb = 0; }
      const report = {
        at: now.toISOString(),
        date: formatLocalDate(now),
        reason,
        durationMs,
        scannedProjects,
        mergedCount,
        promotedCount,
        archivedCount,
        purgedVectorsCount,
        vectorsSynced,
        dbSizeMb,
        dreamMode,
        agentUsed,
        ambiguousClustersFound,
        agentMergedCount,
        mergeErrors,
        invalidSuggestions,
        conflictSkippedCount,
        deferredClusterCount,
        hasDeferredClusters,
        scannedClusterCount,
        estimatedInputTokens,
        estimatedOutputTokens,
        estimatedCostUsd: Math.round(estimatedCostUsd * 1e6) / 1e6,
        agentFallbackReason,
        deltaSinceLastDream: deltaSince,
        minDeltaMemories,
        maxInputTokens,
        maxClustersPerDream,
      };
      const currentConfig = readDreamConfig();
      // 水位规则：仅 Agent 深睡成功且无剩余簇（或确认无灰区）才推进 lastAgentDreamAt；
      // 门槛跳过 / 调用失败降级 / 分批截断剩余簇时只推进浅睡时间 lastDreamAt，绝不推进 Agent 水位。
      const nextAgentDreamAt = (agentDeepSleepSucceeded && deferredClusterCount === 0) ? report.at : (currentConfig.lastAgentDreamAt != null ? String(currentConfig.lastAgentDreamAt) : null);
      report.lastAgentDreamAt = nextAgentDreamAt;
      const prevCount = Number(currentConfig.dreamCount) || 0;
      // 已审签名合并落盘：覆盖数千簇的完整扫描周期，避免 200 条上限淘汰抖动。
      let mergedReviewedSigs = [];
      {
        const base = Array.isArray(currentConfig.reviewedClusterSigs) ? currentConfig.reviewedClusterSigs.filter((s) => typeof s === "string") : [];
        const baseSet = new Set(base);
        mergedReviewedSigs = [...base];
        for (const s of newlyReviewedSigs) {
          if (typeof s !== "string" || !s || baseSet.has(s)) continue;
          baseSet.add(s);
          mergedReviewedSigs.push(s);
        }
        mergedReviewedSigs = mergedReviewedSigs.slice(-DREAM_MAX_REVIEWED_SIGS);
      }
      const nextHasDeferred = hasDeferredClusters === true;
      report.hasDeferredClusters = nextHasDeferred;
      report.reviewedClusterSigs = mergedReviewedSigs;
      const nextConfig = {
        ...currentConfig,
        lastDreamAt: report.at,
        lastDreamDate: report.date,
        lastAgentDreamAt: nextAgentDreamAt,
        dreamCount: prevCount + 1,
        lastReport: report,
        hasDeferredClusters: nextHasDeferred,
        reviewedClusterSigs: mergedReviewedSigs,
      };
      writeDreamConfig(nextConfig);
      const journal = readDreamJournal();
      journal.push(report);
      writeDreamJournal(journal.slice(-30));
      return { ok: true, report, config: nextConfig };
    } finally {
      _dreaming = false;
    }
  }
  async function checkAndRunDueDream(opts = {}) {
    const o = opts && typeof opts === "object" ? opts : {};
    let now = o.now ? (o.now instanceof Date ? o.now : new Date(o.now)) : new Date();
    if (Number.isNaN(now.getTime())) now = new Date();
    const config = readDreamConfig();
    if (!config.enabled) return { ok: true, triggered: false, reason: "disabled" };
    const today = formatLocalDate(now);
    const nowMins = now.getHours() * 60 + now.getMinutes();
    const dm = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(config.dreamTime || "03:00"));
    let targetMins = 3 * 60;
    if (dm) targetMins = Number(dm[1]) * 60 + Number(dm[2]);
    if (config.lastDreamDate === today) return { ok: true, triggered: false, reason: "already-dreamed-today" };
    if (nowMins >= targetMins && nowMins < targetMins + 5) {
      const res = await runDreamCycle({ reason: "scheduled", now });
      if (res && res.ok) return { ok: true, triggered: true, reason: "scheduled", report: res.report, config: res.config };
      return { ok: true, triggered: false, reason: res && res.error ? String(res.error) : "busy", error: res && res.error };
    }
    if (config.catchUpOnWake !== false) {
      const lastAtRaw = config.lastDreamAt || null;
      let lastMs = null;
      if (lastAtRaw) {
        const t = Date.parse(String(lastAtRaw));
        if (Number.isFinite(t)) lastMs = t;
      }
      const nowMs = now.getTime();
      const elapsedMs = lastMs != null ? nowMs - lastMs : null;
      const cond1 = nowMins >= targetMins + 5 && (lastMs == null || elapsedMs > 12 * 3600 * 1000);
      const cond2 = lastMs != null && elapsedMs > 28 * 3600 * 1000;
      if (cond1 || cond2) {
        if (lastMs == null) {
          let total = 0;
          try {
            const db = openDb();
            try {
              const r = db.prepare("SELECT COUNT(*) AS c FROM memories").get();
              total = r ? Number(r.c) || 0 : 0;
            } finally { db.close(); }
          } catch { total = 0; }
          if (!(total > 0)) return { ok: true, triggered: false, reason: "no-memories" };
        }
        const res = await runDreamCycle({ reason: "catchup", now });
        if (res && res.ok) return { ok: true, triggered: true, reason: "catchup", report: res.report, config: res.config };
        return { ok: true, triggered: false, reason: res && res.error ? String(res.error) : "busy", error: res && res.error };
      }
    }
    return { ok: true, triggered: false, reason: "not-due" };
  }
  function getMemoryHealth(opts = {}) {
    try {
      const o = opts && typeof opts === "object" ? opts : {};
      const staleDays = o.staleDays != null ? Number(o.staleDays) : 60;
      let nowMs = Date.now();
      if (o.now != null) {
        const t = typeof o.now === "number" ? Number(o.now) : Date.parse(String(o.now));
        if (Number.isFinite(t)) nowMs = t;
      }
      const ceiling = o.ceiling != null ? Number(o.ceiling) : 250;
      const db = openDb();
      let rows = [];
      try {
        rows = db.prepare("SELECT id, title, module, content, tags_json, updated_at, created_at FROM memories").all();
      } finally { db.close(); }
      const total = rows.length;
      const titleSet = new Set(rows.map((r) => String(r.title || "").trim()));
      const moduleSet = new Set(rows.map((r) => String(r.module || "").trim()));
      const idSet = new Set(rows.map((r) => String(r.id || "").trim()));
      const referenced = new Set();
      const hasOut = new Set();
      const brokenLinks = [];
      let pinnedCount = 0;
      let staleCount = 0;
      const staleMs = staleDays * 86400000;
      for (const r of rows) {
        let tags = [];
        try { const j = JSON.parse(r.tags_json || "[]"); if (Array.isArray(j)) tags = j; } catch { tags = []; }
        const lowered = tags.map((t) => String(t).trim().toLowerCase());
        if (lowered.includes("pinned") || lowered.includes("core")) pinnedCount++;
        const ts = Date.parse(String(r.updated_at || r.created_at || ""));
        if (Number.isFinite(ts) && (nowMs - ts) > staleMs) staleCount++;
        const text = String(r.title || "") + "\n" + String(r.content || "");
        const links = extractMemoryLinks(text);
        if (links.length) hasOut.add(String(r.id));
        for (const raw of links) {
          const tRaw = String(raw).trim();
          const idPart = tRaw.startsWith("#") ? tRaw.slice(1).trim() : tRaw;
          const valid = idSet.has(tRaw) || idSet.has(idPart) || titleSet.has(tRaw) || titleSet.has(idPart) || moduleSet.has(tRaw) || moduleSet.has(idPart);
          if (!valid) {
            brokenLinks.push({ fromId: String(r.id), fromTitle: String(r.title || ""), target: tRaw });
          } else {
            referenced.add(tRaw);
            referenced.add(idPart);
            referenced.add("#" + idPart);
          }
        }
      }
      let isolatedCount = 0;
      for (const r of rows) {
        const id = String(r.id);
        const title = String(r.title || "").trim();
        if (!hasOut.has(id) && !referenced.has(id) && !referenced.has(title) && !referenced.has("#" + id)) isolatedCount++;
      }
      const ceilingStatus = total > ceiling ? "over" : total > ceiling * 0.8 ? "warn" : "ok";
      return { ok: true, total, pinnedCount, staleCount, brokenLinks, isolatedCount, ceilingStatus, brokenCount: brokenLinks.length };
    } catch (e) {
      return { ok: false, error: e.message || String(e), total: 0, pinnedCount: 0, staleCount: 0, brokenLinks: [], isolatedCount: 0, ceilingStatus: "ok", brokenCount: 0 };
    }
  }
  function importHostMemories(opts = {}) {
    try {
      const o = opts && typeof opts === "object" ? opts : {};
      const scanRoots = o.scanRoots;
      const destSlugRaw = o.projectSlug || o.destSlug || GLOBAL_SLUG;
      const destSlug = (o.projectRoot ? resolveVaultSlug(String(o.projectRoot)) : null) || destSlugRaw || GLOBAL_SLUG;
      const homeRaw = homeDir;
      const candidates = [];
      const byHost = {};
      const ensureHost = (h) => { if (!byHost[h]) byHost[h] = { scanned: 0, imported: 0, skipped: 0 }; };
      function collectFromDir(host, dir) {
        try {
          const st = fs.statSync(dir);
          if (!st.isDirectory()) return;
          const walk = (d) => {
            const ents = fs.readdirSync(d, { withFileTypes: true });
            for (const e of ents) {
              const full = path.join(d, e.name);
              if (e.isDirectory()) walk(full);
              else if (e.name.endsWith(".md")) candidates.push({ host, filePath: full });
            }
          };
          walk(dir);
        } catch {}
      }
      if (Array.isArray(scanRoots) && scanRoots.length) {
        for (const entry of scanRoots) {
          if (typeof entry === "string") {
            const abs = path.resolve(entry);
            const low = abs.toLowerCase();
            let host = "host";
            if (low.includes("claude")) host = "claude";
            else if (low.includes("codex")) host = "codex";
            else if (low.includes("gemini")) host = "gemini";
            ensureHost(host);
            try {
              const st = fs.statSync(abs);
              if (st.isDirectory()) collectFromDir(host, abs);
              else if (st.isFile() && abs.endsWith(".md")) candidates.push({ host, filePath: abs });
            } catch {}
          } else if (entry && typeof entry === "object") {
            const host = String(entry.host || entry.from || "host");
            const dir = entry.path || entry.dir || entry.root;
            if (!dir) continue;
            ensureHost(host);
            try {
              const abs = path.resolve(String(dir));
              const st = fs.statSync(abs);
              if (st.isDirectory()) collectFromDir(host, abs);
              else if (st.isFile() && abs.endsWith(".md")) candidates.push({ host, filePath: abs });
            } catch {}
          }
        }
      } else if (scanRoots && typeof scanRoots === "object" && !Array.isArray(scanRoots)) {
        for (const [host, vals] of Object.entries(scanRoots)) {
          ensureHost(host);
          const arr = Array.isArray(vals) ? vals : [vals];
          for (const v of arr) {
            try {
              const abs = path.resolve(String(v));
              const st = fs.statSync(abs);
              if (st.isDirectory()) collectFromDir(host, abs);
              else if (st.isFile() && abs.endsWith(".md")) candidates.push({ host, filePath: abs });
            } catch {}
          }
        }
      } else {
        // default real host dirs
        ensureHost("claude"); ensureHost("codex"); ensureHost("gemini");
        const home = homeRaw;
        const claudeRoot = path.join(home, ".claude", "projects");
        try {
          if (fs.existsSync(claudeRoot)) {
            const projs = fs.readdirSync(claudeRoot, { withFileTypes: true });
            for (const p of projs) {
              if (!p.isDirectory()) continue;
              const memDir = path.join(claudeRoot, p.name, "memory");
              if (!fs.existsSync(memDir)) continue;
              try {
                const files = fs.readdirSync(memDir);
                for (const f of files) if (f.endsWith(".md")) candidates.push({ host: "claude", filePath: path.join(memDir, f) });
              } catch {}
            }
          }
        } catch {}
        const codexDir = path.join(home, ".codex", "memories");
        try {
          if (fs.existsSync(codexDir)) {
            const files = fs.readdirSync(codexDir);
            for (const f of files) if (f.endsWith(".md")) candidates.push({ host: "codex", filePath: path.join(codexDir, f) });
          }
        } catch {}
        const geminiDir = path.join(home, ".gemini", "memories");
        try {
          if (fs.existsSync(geminiDir)) {
            const files = fs.readdirSync(geminiDir);
            for (const f of files) if (f.endsWith(".md")) candidates.push({ host: "gemini", filePath: path.join(geminiDir, f) });
          }
        } catch {}
      }
      let scanned = 0, imported = 0, skipped = 0;
      const seenTitles = new Set();
      // existing dedup set
      let existingTitles = new Set();
      try {
        const db = openDb();
        try {
          const rows = db.prepare("SELECT title FROM memories WHERE project_slug = ?").all(destSlug);
          existingTitles = new Set(rows.map((r) => String(r.title || "").trim()));
          const allRows = db.prepare("SELECT title FROM memories").all();
          for (const r of allRows) existingTitles.add(String(r.title || "").trim());
        } finally { db.close(); }
      } catch {}
      for (const { host, filePath } of candidates) {
        ensureHost(host);
        byHost[host].scanned++;
        scanned++;
        let st;
        try { st = fs.statSync(filePath); } catch { byHost[host].skipped++; skipped++; continue; }
        if (st.size > 64 * 1024 || st.size === 0) { byHost[host].skipped++; skipped++; continue; }
        let text;
        try { text = fs.readFileSync(filePath, "utf8"); } catch { byHost[host].skipped++; skipped++; continue; }
        if (!text.trim()) { byHost[host].skipped++; skipped++; continue; }
        let title = null;
        const ls = text.split(/\r?\n/);
        for (const line of ls) {
          const t = line.trim();
          if (!t) continue;
          if (t.startsWith("#")) title = t.replace(/^#+\s*/, "").trim();
          else title = t.slice(0, 120).trim();
          break;
        }
        if (!title) title = path.basename(filePath, ".md");
        title = String(title).slice(0, 200);
        if (existingTitles.has(title) || seenTitles.has(title)) { byHost[host].skipped++; skipped++; continue; }
        const content = String(text).trim();
        const fromTag = "from:" + (host === "claude" ? "claude" : host === "codex" ? "codex" : host === "gemini" ? "gemini" : String(host));
        let tags = ["imported-host-memory", fromTag].filter((t) => !/pinned/i.test(t));
        const scope = destSlug === GLOBAL_SLUG ? "global" : "shared";
        const res = saveMemory({ projectSlug: destSlug, module: "topics", kind: "topic", title, content, tags, autoEvolve: false, scope });
        if (res && res.ok && !res.deduplicated && res.action !== "deduplicated") {
          imported++; byHost[host].imported++;
          seenTitles.add(title);
          existingTitles.add(title);
        } else {
          byHost[host].skipped++; skipped++;
        }
      }
      // ensure byHost has counts for hosts with zero scanned
      return { ok: true, scanned, imported, skipped, byHost };
    } catch (e) {
      return { ok: false, error: e.message || String(e), scanned: 0, imported: 0, skipped: 0, byHost: {} };
    }
  }
  function getStats() {
    let totalMemories = 0;
    let syncedVectors = 0;
    let activeModelId = "local";
    try {
      const health = getEmbedHealthSync();
      activeModelId = health.modelId || "local";
      const activeDim = health.dim || null;
      const isLegacy = activeModelId === "mlx-community/embeddinggemma-2-8bit";
      const db = openDb();
      try {
        const t = db.prepare("SELECT COUNT(*) AS c FROM memories").get();
        totalMemories = t ? Number(t.c) : 0;
        if (isLegacy) {
          const s = db.prepare("SELECT COUNT(*) AS c FROM memory_vectors WHERE model_id IN ('mlx-community/embeddinggemma-2-8bit','local','powercontext-legacy') AND dim=768").get();
          syncedVectors = s ? Number(s.c) : 0;
        } else if (activeDim) {
          const s = db.prepare("SELECT COUNT(*) AS c FROM memory_vectors WHERE model_id=? AND dim=?").get(activeModelId, activeDim);
          syncedVectors = s ? Number(s.c) : 0;
        } else {
          const s = db.prepare("SELECT COUNT(*) AS c FROM memory_vectors WHERE model_id=?").get(activeModelId);
          syncedVectors = s ? Number(s.c) : 0;
        }
      } finally {
        db.close();
      }
    } catch {}
    return { ok: true, vectorStats: { totalMemories, syncedVectors, activeModelId, reindexing: _reindexing } };
  }
  // P1-B: vault 初始化时恢复遗留意图日志
  recoverPendingDreamJournal();
  return {
    vaultDir,
    hubDir,
    homeDir,
    getOverview,
    listMemories,
    saveMemory,
    getMemoryHealth,
    importHostMemories,
    promoteWorktreeMemory,
    ensureProjectMemoryLink,
    resolveWorktreeContext: resolveWorktreeContextLocal,
    consolidateMemories,
    rollbackMemory,
    deleteMemory,
    pinToAgentsMd,
    migrateFromPowerContext,
    syncFromMarkdownIfChanged,
    ensureProject,
    resolveProjectSlug: resolveVaultSlug,
    getStats,
    reindexVectors,
    triggerBatchEmbedding,
    invalidateEmbedHealthCache,
    runHygiene,
    getDreamState,
    getDreamOverview,
    updateDreamConfig,
    runDreamCycle,
    checkAndRunDueDream,
    DREAM_AGENT_PRESETS,
    estimateDreamTokens,
    estimateTokensForText,
    buildDreamPrompt,
    runDreamAgentCli,
    DREAM_MAX_INPUT_TOKENS,
    _ensureProjectVault: ensureProjectVault,
  };
}
let _singleton = null;
function getDefaultMemoryVault() {
  if (!_singleton) _singleton = createMemoryVault();
  return _singleton;
}
function getOverview(a) {
  return getDefaultMemoryVault().getOverview(a || {});
}
function listMemories(a) {
  return getDefaultMemoryVault().listMemories(a || {});
}
function saveMemory(a) {
  return getDefaultMemoryVault().saveMemory(a || {});
}
function consolidateMemories(a) {
  return getDefaultMemoryVault().consolidateMemories(a || {});
}
function rollbackMemory(a) {
  return getDefaultMemoryVault().rollbackMemory(a || {});
}
function deleteMemory(a) {
  return getDefaultMemoryVault().deleteMemory(a || {});
}
function pinToAgentsMd(a) {
  return getDefaultMemoryVault().pinToAgentsMd(a || {});
}
function migrateFromPowerContext(a) {
  return getDefaultMemoryVault().migrateFromPowerContext(a || {});
}
function syncFromMarkdownIfChanged(a) {
  return getDefaultMemoryVault().syncFromMarkdownIfChanged(a);
}
function getStats(a) {
  return getDefaultMemoryVault().getStats(a || {});
}
function reindexVectors(a) {
  return getDefaultMemoryVault().reindexVectors(a || {});
}
function runHygiene(a) {
  return getDefaultMemoryVault().runHygiene(a || {});
}
function getDreamState(a) {
  return getDefaultMemoryVault().getDreamState(a || {});
}
function getDreamOverview(a) {
  return getDefaultMemoryVault().getDreamOverview(a || {});
}
function updateDreamConfig(a) {
  return getDefaultMemoryVault().updateDreamConfig(a || {});
}
async function runDreamCycle(a) {
  return getDefaultMemoryVault().runDreamCycle(a || {});
}
async function checkAndRunDueDream(a) {
  return getDefaultMemoryVault().checkAndRunDueDream(a || {});
}
function estimateDreamTokens(a) {
  return getDefaultMemoryVault().estimateDreamTokens(a);
}
function estimateTokensForText(a) {
  return getDefaultMemoryVault().estimateTokensForText(a);
}
function buildDreamPrompt(a) {
  return getDefaultMemoryVault().buildDreamPrompt(a);
}
function runDreamAgentCli(a) {
  return getDefaultMemoryVault().runDreamAgentCli(a || {});
}
function invalidateEmbedHealthCache() {
  return getDefaultMemoryVault().invalidateEmbedHealthCache();
}
function resolveWorktreeContextExport(cwd) {
  return resolveWorktreeContext(cwd);
}
function promoteWorktreeMemoryExport(args) {
  return getDefaultMemoryVault().promoteWorktreeMemory(args || {});
}
function ensureProjectMemoryLinkExport(projectRoot) {
  return getDefaultMemoryVault().ensureProjectMemoryLink(projectRoot);
}
const DREAM_AGENT_PRESETS_SHARED = [
  { id: "local-zero", dreamMode: "local", providerInstanceId: "local", model: "mlx-vector-only", label: "纯本地向量聚变 · 0 Token ($0/晚)", estCostPerNightUsd: 0 },
  { id: "muse-ember", dreamMode: "agent", providerInstanceId: "muse", model: "muse-ember-1.0", reasoningEffort: "medium", label: "Muse · muse-ember-1.0（推荐 · 约 $0.002/晚）", estCostPerNightUsd: 0.0018 },
  { id: "codex-terra", dreamMode: "agent", providerInstanceId: "codex", model: "gpt-6.1-terra", reasoningEffort: "medium", label: "Codex · gpt-6.1-terra（精炼 · 约 $0.012/晚）", estCostPerNightUsd: 0.012 },
  { id: "codex-sol", dreamMode: "agent", providerInstanceId: "codex", model: "gpt-6.1-sol", reasoningEffort: "medium", label: "Codex · gpt-6.1-sol（深度 · 约 $0.018/晚）", estCostPerNightUsd: 0.018 },
  { id: "claude-sonnet", dreamMode: "agent", providerInstanceId: "claude", model: "claude-sonnet-4-6", reasoningEffort: "medium", label: "Claude · claude-sonnet-4-6（约 $0.015/晚）", estCostPerNightUsd: 0.015 },
  { id: "pi-magpie", dreamMode: "agent", providerInstanceId: "pi", model: "magpie/group/code", reasoningEffort: "medium", label: "Pi · magpie/group/code（约 $0.005/晚）", estCostPerNightUsd: 0.005 },
];
module.exports = {
  createMemoryVault,
  getDefaultMemoryVault,
  getOverview,
  getMemoryHealth: function getMemoryHealthProxy(a) { return getDefaultMemoryVault().getMemoryHealth(a || {}); },
  getVaultOverview: function getVaultOverview(a) { return getDefaultMemoryVault().getOverview(a || {}); },
  importHostMemories: function importHostMemoriesProxy(a) { return getDefaultMemoryVault().importHostMemories(a || {}); },
  extractMemoryLinks,
  listMemories,
  saveMemory,
  promoteWorktreeMemory: promoteWorktreeMemoryExport,
  ensureProjectMemoryLink: ensureProjectMemoryLinkExport,
  resolveWorktreeContext: resolveWorktreeContextExport,
  consolidateMemories,
  rollbackMemory,
  deleteMemory,
  pinToAgentsMd,
  migrateFromPowerContext,
  syncFromMarkdownIfChanged,
  getStats,
  reindexVectors,
  runHygiene,
  getDreamState,
  getDreamOverview,
  updateDreamConfig,
  runDreamCycle,
  checkAndRunDueDream,
  estimateDreamTokens,
  estimateTokensForText,
  buildDreamPrompt,
  runDreamAgentCli,
  DREAM_MAX_INPUT_TOKENS: 7900,
  invalidateEmbedHealthCache,
  DREAM_AGENT_PRESETS: DREAM_AGENT_PRESETS_SHARED,
  slugify,
  slugFromProjectRoot,
  scopeHashFor,
  contentHashFor,
  kindToModule,
  containsSecret,
  SECRET_PATTERN,
  GLOBAL_SLUG,
  GLOBAL_TITLE,
  MODULES,
  MODULE_FILES,
  MODULE_HEADERS,
  default: getDefaultMemoryVault(),
};
