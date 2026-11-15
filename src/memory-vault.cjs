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
const { spawnSync } = require("node:child_process");
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
  const embedTimeoutMs = opts.embeddingTimeoutMs || EMBED_TIMEOUT_MS;
  const embedFn = opts._embedFn || opts.embedFn || null;
  const healthFn = opts._healthFn || opts.healthFn || null;
  const embedHealthUrl = opts.embeddingHealthUrl || embedUrl.replace(/\/v1\/embeddings\/?$/, "/health");
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
    db.exec(
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
      "last_recalled_at TEXT", "history_json TEXT NOT NULL DEFAULT '[]'", "supersedes_id TEXT"]) {
      try { db.exec("ALTER TABLE memories ADD COLUMN " + column); }
      catch (e) { if (!/duplicate column name/i.test(e.message)) { db.close(); throw e; } }
    }
    return db;
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
  function recordSyncState(filePath) {
    try {
      const st = fs.statSync(filePath);
      const text = fs.readFileSync(filePath, "utf8");
      const h = crypto.createHash("sha256").update(text).digest("hex");
      const db = openDb();
      try {
        db.prepare("INSERT OR REPLACE INTO vault_sync(file_path, mtime_ms, content_hash) VALUES (?,?,?)").run(filePath, st.mtimeMs, h);
      } finally {
        db.close();
      }
    } catch {}
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
      ...revisionMeta({ id: row.id, version: row.version, hitCount: row.hit_count, lastRecalledAt: row.last_recalled_at,
        supersedesId: row.supersedes_id, history }),
    };
  }
  function upsertRow(db, { id, projectSlug, projectRoot, module, kind, title, content, agent, tags, createdAt, updatedAt, ...extra }) {
    const meta = revisionMeta(extra);
    const tagsJson = JSON.stringify(Array.isArray(tags) ? tags : []);
    const ch = contentHashFor(content);
    db.prepare("DELETE FROM memories_fts WHERE id = ?").run(id);
    db.prepare(
      "INSERT INTO memories(id, project_slug, project_root, module, kind, title, content, agent, tags_json, content_hash, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_slug=excluded.project_slug, project_root=excluded.project_root, module=excluded.module, kind=excluded.kind, title=excluded.title, content=excluded.content, agent=excluded.agent, tags_json=excluded.tags_json, content_hash=excluded.content_hash, updated_at=excluded.updated_at"
    ).run(id, projectSlug, projectRoot || null, module, kind, title, content, agent, tagsJson, ch, createdAt, updatedAt);
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
  function rewriteModuleFile(slug, module, entries) {
    const f = moduleFileFor(slug, module);
    writeTextAtomic(f, serializeEntries(module, entries));
    recordSyncState(f);
  }
  function rewriteModules(db, slug, modules) {
    for (const mod of new Set(modules)) {
      const rows = db.prepare("SELECT * FROM memories WHERE project_slug=? AND module=? ORDER BY created_at ASC, id ASC").all(slug, mod);
      rewriteModuleFile(slug, mod, rows.map(rowToItem));
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
      }));
      writeTextAtomic(f, serializeEntries(module, withIds));
      recordSyncState(f);
    } else {
      db.prepare("INSERT OR REPLACE INTO vault_sync(file_path, mtime_ms, content_hash) VALUES (?,?,?)").run(f, st.mtimeMs, h);
    }
    return { changed: upserted > 0 || deleted > 0 || needsRewrite, upserted, deleted };
  }
  function syncFromMarkdownIfChanged(projectSlug) {
    const db = openDb();
    try {
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
      }
      return { ok: true, synced: changedFiles > 0, changedFiles, upserted, deleted };
    } finally {
      db.close();
    }
  }
  function embedTextsSync(texts, embedOpts = {}) {
    const inputType = embedOpts.inputType ?? embedOpts.input_type ?? null;
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
        ["-s", "-m", String(embedTimeoutMs / 1000), "--connect-timeout", String(embedTimeoutMs / 1000), "-X", "POST", embedUrl, "-H", "Content-Type: application/json", "-d", payload],
        { encoding: "utf8", timeout: embedTimeoutMs + 200 }
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
      const t = setTimeout(() => ctrl.abort(), embedTimeoutMs);
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
      const B = 32;
      for (let i = 0; i < rows.length; i += B) {
        const chunk = rows.slice(i, i + B);
        const texts = chunk.map((r) => (String(r.title || "") + "\n" + String(r.content || "")).slice(0, 8000));
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
    const normRoot = normalizeProjectRoot(raw);
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
      const slug = resolveSlug(args.projectSlug ? String(args.projectSlug) : null, projectRoot);
      if (!slug) return { ok: false, error: "projectRoot or projectSlug required" };
      const mod = MODULES.includes(args.module) ? args.module : args.kind ? kindToModule(args.kind) : "constraints";
      const title = String(args.title ?? "").trim();
      const content = String(args.content ?? "").trim();
      if (!title) return { ok: false, error: "title required" };
      if (!content) return { ok: false, error: "content required" };
      if (containsSecret(title) || containsSecret(content)) return { ok: false, error: SECRET_ERROR };
      syncFromMarkdownIfChanged(slug);
      const incoming = {
        id: generateMemId(), projectSlug: slug, module: mod,
        kind: args.kind ? String(args.kind) : MODULE_DEFAULT_KIND[mod], title, content,
        agent: args.agent ? String(args.agent) : "user",
        tags: Array.isArray(args.tags) ? args.tags.map(String) : [],
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
          const dup = db.prepare("SELECT * FROM memories WHERE project_slug=? AND module=? AND content_hash=?")
            .get(slug, mod, contentHashFor(content));
          if (dup) return { ok: true, item: { ...rowToItem(dup), score: 0 }, deduplicated: true, action: "deduplicated" };
          if (args.autoEvolve !== false) {
            const candidates = db.prepare("SELECT * FROM memories WHERE project_slug=? ORDER BY updated_at DESC, id ASC").all(slug).map(rowToItem);
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
        const meta = ensureProjectVault(slug, { title: path.basename(projectRoot || slug), projectRoot });
        const projectPath = projectRoot || meta.projectRoot || null;
        const textChanged = !existing || embeddingText(existing) !== embeddingText(item);
        db.exec("BEGIN");
        try {
          upsertRow(db, { ...item, projectRoot: projectPath });
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
        return { ok: true, deduplicated: action === "merged", action,
          ...(evolvedFromVersion != null ? { evolvedFromVersion } : {}), item: { ...item, score: 0 } };
      } finally { db.close(); }
    } catch (e) { return { ok: false, error: e.message || String(e) }; }
  }
  function deleteMemory(args = {}) {
    try {
      const id = args.id ? String(args.id) : null;
      if (!id) return { ok: false, error: "id required" };
      const db = openDb();
      try {
        const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
        if (!row) return { ok: true, deleted: false };
        const slug = args.projectSlug ? String(args.projectSlug) : row.project_slug;
        const mod = row.module;
        deleteRowById(db, id);
        // Rewrite module file without the deleted entry.
        try {
          const rows = db.prepare("SELECT * FROM memories WHERE project_slug = ? AND module = ? ORDER BY created_at ASC").all(slug, mod);
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
        } catch {}
        return { ok: true, deleted: true };
      } finally {
        db.close();
      }
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
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
        return { ok: true, currentProjectSlug, migratedCount, totalMemories, projects };
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
      let slug = resolveSlug(args.projectSlug ? String(args.projectSlug) : null, args.projectRoot ? String(args.projectRoot) : null);
      // Auto-sync Markdown edits before reading.
      try {
        if (slug) syncFromMarkdownIfChanged(slug);
        if (args.includeGlobal) syncFromMarkdownIfChanged(GLOBAL_SLUG);
      } catch {}
      const db = openDb();
      try {
        const buildFilter = () => {
          const conds = [];
          const params = [];
          if (slug) {
            if (args.includeGlobal && slug !== GLOBAL_SLUG) {
              conds.push("(project_slug = ? OR project_slug = ?)");
              params.push(slug, GLOBAL_SLUG);
            } else {
              conds.push("project_slug = ?");
              params.push(slug);
            }
          } else if (args.includeGlobal) {
            // No slug: everything (global already included).
          }
          if (module !== "all") {
            conds.push("module = ?");
            params.push(module);
          }
          return { conds, params };
        };
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
            const rows = db
              .prepare("SELECT m.*, bm25(memories_fts) AS _rank FROM memories_fts JOIN memories m ON m.id = memories_fts.id WHERE memories_fts MATCH ?" + (whereSuffix ? whereSuffix.replace(/project_slug/g, "m.project_slug").replace(/module/g, "m.module") : ""))
              .all(ftsQuery, ...params);
            rows.sort((a, b) => Number(a._rank) - Number(b._rank));
            for (const r of rows) {
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
            for (const r of rows) {
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
              // Apply project/module filter for vectors as well.
              if (slug) {
                const ok = args.includeGlobal ? row.project_slug === slug || row.project_slug === GLOBAL_SLUG : row.project_slug === slug;
                if (!ok) continue;
              }
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
    try {
      const slug = resolveSlug(args.projectSlug, args.projectRoot);
      if (!slug) return { ok: false, error: "projectRoot or projectSlug required" };
      syncFromMarkdownIfChanged(slug);
      const db = openDb();
      try {
        const items = db.prepare("SELECT * FROM memories WHERE project_slug=? ORDER BY created_at ASC, id ASC").all(slug).map(rowToItem);
        const vectors = vectorsFor(db, items);
        const overlaps = (sim) => sim.cosine >= 0.82 || sim.titleSim >= 0.75 || sim.lexicalSim >= 0.60;
        const pairs = [];
        for (let i = 0; i < items.length; i++) {
          for (let j = i + 1; j < items.length; j++) {
            const sim = similarity(items[i], items[j], vectors);
            if (overlaps(sim)) pairs.push({ id: items[i].id, mergeId: items[j].id, ...sim });
          }
        }
        if (args.dryRun) return { ok: true, dryRun: true, mergedCount: 0, pairs, candidates: pairs, items: [] };
        const active = new Map(items.map((item) => [item.id, item]));
        const changed = new Map();
        const modules = new Set();
        let mergedCount = 0;
        db.exec("BEGIN");
        try {
          for (const pair of pairs) {
            const keep = active.get(pair.id), remove = active.get(pair.mergeId);
            if (!keep || !remove || !overlaps(similarity(keep, remove, vectors))) continue;
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
            modules.add(keep.module); modules.add(remove.module);
            mergedCount++;
          }
          db.exec("COMMIT");
        } catch (e) { db.exec("ROLLBACK"); throw e; }
        if (mergedCount) {
          rewriteModules(db, slug, modules);
          touchProject(slug, nowIso());
          for (const item of changed.values()) triggerBackgroundEmbedding(item.id, item.title, item.content);
        }
        return { ok: true, mergedCount, items: [...changed.values()] };
      } finally { db.close(); }
    } catch (e) { return { ok: false, error: e.message || String(e) }; }
  }
  function rollbackMemory(args = {}) {
    try {
      const slug = resolveSlug(args.projectSlug, args.projectRoot);
      if (!slug || !args.id) return { ok: false, error: "projectRoot or projectSlug and id required" };
      syncFromMarkdownIfChanged(slug);
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
  return {
    vaultDir,
    hubDir,
    homeDir,
    getOverview,
    listMemories,
    saveMemory,
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
function invalidateEmbedHealthCache() {
  return getDefaultMemoryVault().invalidateEmbedHealthCache();
}
module.exports = {
  createMemoryVault,
  getDefaultMemoryVault,
  getOverview,
  listMemories,
  saveMemory,
  consolidateMemories,
  rollbackMemory,
  deleteMemory,
  pinToAgentsMd,
  migrateFromPowerContext,
  syncFromMarkdownIfChanged,
  getStats,
  reindexVectors,
  invalidateEmbedHealthCache,
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
