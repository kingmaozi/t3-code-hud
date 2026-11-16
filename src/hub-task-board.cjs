"use strict";
/**
 * hub-task-board.cjs —— 五宿主统一「计划 / 进程 x/y + 子代理实况 + 产物」实时看板引擎
 *
 * 三源聚合（只读，零副作用）：
 *   源 A：T3 原生 statev2.sqlite（node:sqlite + { readOnly: true }，绝不锁库）
 *   源 B：Antigravity brain 目录 task.md / implementation_plan.md
 *   源 C：Hub 通用打卡存储 ~/.t3/hub/task-plans/<key>.json（Pi / plan_update 通用保底）
 * 智能合并：按 updatedAt 取最新一份 steps，同时保留 subagents 与 artifacts；
 * 无显式计划时从子代理状态自动推断进度列表，永不空白。
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { assertSafeFsPath } = require("./hub-skills.cjs");

const STATUS_COMPLETED = "completed";
const STATUS_IN_PROGRESS = "in_progress";
const STATUS_PENDING = "pending";
const STATUS_CANCELLED = "cancelled";
const KNOWN_STATUSES = new Set([STATUS_COMPLETED, STATUS_IN_PROGRESS, STATUS_PENDING, STATUS_CANCELLED]);

// 简写状态归一：done/✓ -> completed；running/active -> in_progress
const STATUS_ALIASES = new Map([
  ["done", STATUS_COMPLETED], ["complete", STATUS_COMPLETED], ["completed", STATUS_COMPLETED],
  ["finish", STATUS_COMPLETED], ["finished", STATUS_COMPLETED], ["✓", STATUS_COMPLETED],
  ["✔", STATUS_COMPLETED], ["x", STATUS_COMPLETED], ["checked", STATUS_COMPLETED],
  ["running", STATUS_IN_PROGRESS], ["active", STATUS_IN_PROGRESS], ["in_progress", STATUS_IN_PROGRESS],
  ["in-progress", STATUS_IN_PROGRESS], ["inprogress", STATUS_IN_PROGRESS], ["current", STATUS_IN_PROGRESS],
  ["◉", STATUS_IN_PROGRESS], ["/", STATUS_IN_PROGRESS], ["~", STATUS_IN_PROGRESS],
  ["进行中", STATUS_IN_PROGRESS], ["working", STATUS_IN_PROGRESS], ["started", STATUS_IN_PROGRESS],
  ["pending", STATUS_PENDING], ["todo", STATUS_PENDING], ["open", STATUS_PENDING],
  ["○", STATUS_PENDING], ["queued", STATUS_PENDING], ["waiting", STATUS_PENDING], ["not_started", STATUS_PENDING],
  ["cancelled", STATUS_CANCELLED], ["canceled", STATUS_CANCELLED], ["cancel", STATUS_CANCELLED],
  ["skipped", STATUS_CANCELLED], ["skip", STATUS_CANCELLED], ["failed", STATUS_CANCELLED], ["error", STATUS_CANCELLED],
]);

function normalizeStepStatus(raw) {
  if (typeof raw !== "string") return STATUS_PENDING;
  const s = raw.trim().toLowerCase();
  if (!s) return STATUS_PENDING;
  if (KNOWN_STATUSES.has(s)) return s;
  return STATUS_ALIASES.get(s) || STATUS_PENDING;
}

function expandTilde(p) {
  if (typeof p !== "string") return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function safeReadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}
function fileMtimeIso(file) {
  try { return fs.statSync(file).mtime.toISOString(); } catch { return ""; }
}
function dirExists(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function fileExists(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function safeMkdir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function writeJsonAtomic(file, obj) {
  safeMkdir(path.dirname(file));
  const tmp = file + ".tmp-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  fs.renameSync(tmp, file);
}

function slugify(raw) {
  let s = String(raw ?? "").trim();
  if (!s) return "project";
  s = s.replace(/[\/\\\0-\x1f\x7f]/g, "-");
  s = s.replace(/[\s_]+/g, "-").replace(/[^\p{L}\p{N}-]/gu, "");
  s = s.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  return (s.slice(0, 80) || "project");
}

function canonicalProjectPath(p) {
  const resolved = path.resolve(String(p));
  try {
    return fs.realpathSync(resolved);
  } catch {}
  let cur = resolved;
  const rest = [];
  while (true) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    rest.unshift(path.basename(cur));
    cur = parent;
    try {
      const real = fs.realpathSync(cur);
      return path.join(real, ...rest);
    } catch {}
  }
  if (resolved === "/tmp" || resolved.startsWith("/tmp/")) return "/private/tmp" + resolved.slice(4);
  if (resolved === "/var" || resolved.startsWith("/var/")) return "/private/var" + resolved.slice(4);
  return resolved;
}

function sameProject(a, b) {
  return typeof a === "string" && typeof b === "string" && !!a && !!b && canonicalProjectPath(a) === canonicalProjectPath(b);
}

// Keep legacy filenames for lossless thread IDs. Hash every lossy/scoped key:
// slugs and project basenames alone are not unique identities. The dot keeps
// hashed keys distinct from all lossless slug keys. Hash-only names also bound
// filename byte length for Unicode identities. Legacy files remain readable.
function planFileKey(input) {
  validatePlanInput(input);
  const threadId = input && input.threadId ? String(input.threadId) : "";
  const projectRoot = input && input.projectRoot ? String(input.projectRoot) : "";
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  if (threadId === "__NEW__") {
    const scope = projectRoot ? threadId + "::" + path.resolve(projectRoot) : threadId;
    return "t-NEW." + hash(scope);
  }
  if (threadId && projectRoot) {
    return "t-p." + hash(threadId + "::" + canonicalProjectPath(projectRoot));
  }
  if (threadId) {
    const slug = slugify(threadId);
    return slug === threadId ? "t-" + slug : "t-." + hash(threadId);
  }
  if (projectRoot) return "p-" + hash(path.resolve(projectRoot));
  return "default";
}

function validatePlanInput(input = {}) {
  if (input.threadId != null && (typeof input.threadId !== "string" || !/^[\p{L}\p{N}_][\p{L}\p{N}._:%-]{0,240}$/u.test(input.threadId) || input.threadId.includes("..") || input.threadId.includes("/") || input.threadId.includes("\\") || /[\0-\x1f\x7f]/.test(input.threadId))) throw new Error("invalid thread id");
  if (input.projectRoot != null && (typeof input.projectRoot !== "string" || !path.isAbsolute(input.projectRoot) || /[\0\\]/.test(input.projectRoot) || input.projectRoot.split(path.sep).some(p => p === "." || p === ".."))) throw new Error("invalid projectRoot");
}
function assertPlansStore(dir, anchorDir) {
  const target = path.resolve(dir);
  // HOME, tmpdir and caller-supplied anchors can themselves have linked parents.
  // Inspect the entire lexical chain, allowing only macOS's fixed top-level aliases.
  const root = path.parse(target).root;
  if (target === root) throw new Error("unsafe path: filesystem root is not a plan store");
  let cur = root;
  for (const part of target.slice(root.length).split(path.sep).filter(Boolean)) {
    cur = path.join(cur, part);
    let st = null;
    try { st = fs.lstatSync(cur); } catch (e) { if (e.code !== "ENOENT") throw e; }
    if (!st) break;
    if (st.isSymbolicLink()) {
      const systemAlias = process.platform === "darwin" && ["/var", "/tmp", "/etc"].includes(cur) && fs.realpathSync(cur) === "/private" + cur;
      if (!systemAlias) throw new Error("unsafe path: symbolic link");
    } else if (!st.isDirectory()) throw new Error("unsafe path: plan store ancestor is not a directory");
  }
  if (anchorDir && typeof anchorDir === "string") {
    const anchor = path.resolve(anchorDir);
    const inside = (base, child) => {
      const rel = path.relative(base, child);
      return !!rel && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
    };
    if (!inside(anchor, target)) throw new Error("unsafe path: escapes plan anchor");
    if (fs.existsSync(target) && !inside(fs.realpathSync(anchor), fs.realpathSync(target))) throw new Error("unsafe path: real plan store escapes anchor");
  }
}
function planPath(dir, name) {
  if (!/^[\p{L}\p{N}_-][\p{L}\p{N}._-]*\.json$/u.test(name) || name.includes("..")) throw new Error("invalid plan filename");
  return assertSafeFsPath(dir, path.resolve(dir, name));
}

function openDbReadOnly(dbPath) {
  const abs = expandTilde(String(dbPath || ""));
  if (!abs || !fileExists(abs)) return null;
  try {
    return new DatabaseSync(abs, { readOnly: true });
  } catch {
    return null;
  }
}

function tableExists(db, table) {
  try {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table);
    return Boolean(row);
  } catch { return false; }
}
function tableColumns(db, table) {
  try {
    const rows = db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all();
    return new Set(rows.map((r) => r.name));
  } catch { return new Set(); }
}
function safeJson(raw, fallback) {
  if (typeof raw !== "string" || !raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

// 解析 Antigravity task.md 任务列表 -> 标准化 steps
function parseTaskMd(text) {
  const steps = [];
  const lines = String(text || "").split(/\r?\n/);
  let n = 0;
  for (const line of lines) {
    const m = line.match(/^\s*-\s*\[([ xX\/~])\]\s*(.+?)\s*$/);
    if (!m) continue;
    const mark = m[1];
    const label = m[2].trim();
    if (!label) continue;
    n += 1;
    let status;
    if (mark === "x" || mark === "X") status = STATUS_COMPLETED;
    else if (mark === "/" || mark === "~") status = STATUS_IN_PROGRESS;
    else status = STATUS_PENDING;
    if (status === STATUS_PENDING && /进行中/.test(label)) status = STATUS_IN_PROGRESS;
    steps.push({ id: `step-${n}`, text: label, status });
  }
  return steps;
}

function elapsedSec(startedAt, updatedAt, nowFn) {
  const now = nowFn ? nowFn() : Date.now();
  const t0 = Date.parse(startedAt || "");
  if (Number.isNaN(t0)) return 0;
  const t1 = updatedAt ? Date.parse(updatedAt) : now;
  const end = Number.isNaN(t1) ? now : t1;
  return Math.max(0, Math.round((end - t0) / 1000));
}

function defaultAgyBrainRoots(homeDir) {
  const roots = [];
  const acpBase = path.join(homeDir, ".t3", "userdata", "providers", "antigravity");
  try {
    for (const ent of fs.readdirSync(acpBase, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const brain = path.join(acpBase, ent.name, "antigravity-acp", "brain");
      if (dirExists(brain)) roots.push(brain);
    }
  } catch {}
  const geminiBrain = path.join(homeDir, ".gemini", "antigravity", "brain");
  if (dirExists(geminiBrain)) roots.push(geminiBrain);
  return roots;
}

function normalizeBrainRoots(input, homeDir) {
  if (input == null) return defaultAgyBrainRoots(homeDir);
  const arr = Array.isArray(input) ? input : [input];
  return arr.filter((x) => typeof x === "string" && x.trim()).map((x) => expandTilde(x.trim()));
}

// ---------------------------------------------------------------------------
// T3 原生读取（源 A）—— 全部只读、表/列自适应容错
// ---------------------------------------------------------------------------
function pickThreadsTable(db) {
  if (tableExists(db, "orchestration_v2_projection_threads")) {
    return { table: "orchestration_v2_projection_threads", modern: true };
  }
  if (tableExists(db, "projection_threads")) {
    return { table: "projection_threads", modern: false };
  }
  return null;
}

function lookupThreadWorkspaceRoot(db, picked, threadId) {
  if (!db || !picked || threadId == null || String(threadId) === "") return null;
  try {
    const cols = tableColumns(db, picked.table);
    if (!cols.has("project_id")) return null;
    let projectId = null;
    try {
      const row = db.prepare(`SELECT project_id FROM ${picked.table} WHERE thread_id = ?`).get(String(threadId));
      if (!row || row.project_id == null || String(row.project_id) === "") return null;
      projectId = String(row.project_id);
    } catch { return null; }
    if (!projectId) return null;
    if (tableExists(db, "projection_projects")) {
      try {
        const projCols = tableColumns(db, "projection_projects");
        if (projCols.has("workspace_root")) {
          const hasDeleted = projCols.has("deleted_at");
          const sql = hasDeleted
            ? "SELECT workspace_root FROM projection_projects WHERE project_id = ? AND deleted_at IS NULL LIMIT 1"
            : "SELECT workspace_root FROM projection_projects WHERE project_id = ? LIMIT 1";
          const row = db.prepare(sql).get(projectId);
          if (row && typeof row.workspace_root === "string" && row.workspace_root.trim()) return row.workspace_root;
        }
      } catch {}
    }
    if (tableExists(db, "projects")) {
      try {
        const projCols = tableColumns(db, "projects");
        if (projCols.has("workspace_root")) {
          const hasDeleted = projCols.has("deleted_at");
          const sql = hasDeleted
            ? "SELECT workspace_root FROM projects WHERE project_id = ? AND deleted_at IS NULL LIMIT 1"
            : "SELECT workspace_root FROM projects WHERE project_id = ? LIMIT 1";
          const row = db.prepare(sql).get(projectId);
          if (row && typeof row.workspace_root === "string" && row.workspace_root.trim()) return row.workspace_root;
        }
      } catch {}
    }
    return null;
  } catch { return null; }
}

function resolveCurrentThread(db, opts) {
  if (!db) return opts.projectRoot && !opts.threadId ? null : { threadId: opts.threadId || "", title: "" };
  const picked = pickThreadsTable(db);
  if (opts.threadId) {
    if (picked) {
      const cols = tableColumns(db, picked.table);
      try {
        const row = db
          .prepare(`SELECT thread_id, title FROM ${picked.table} WHERE thread_id = ?`)
          .get(String(opts.threadId));
        if (row) return { threadId: String(row.thread_id), title: String(row.title || "") };
      } catch {}
      void cols;
    }
    return { threadId: String(opts.threadId), title: "" };
  }
  if (!picked) return opts.projectRoot ? null : { threadId: "", title: "" };
  const cols = tableColumns(db, picked.table);
  const projectRoot = opts.projectRoot ? String(opts.projectRoot) : "";
  // 优先匹配 projectRoot（经 projection_projects 关联）
  if (projectRoot && picked.modern) {
    try {
      if (tableExists(db, "projection_projects")) {
        const row = db.prepare(`
          SELECT t.thread_id AS thread_id, t.title AS title
          FROM ${picked.table} t
          JOIN projection_projects p ON t.project_id = p.project_id
          WHERE t.deleted_at IS NULL AND p.workspace_root = ? AND p.deleted_at IS NULL
          ORDER BY t.updated_at DESC LIMIT 1
        `).get(projectRoot);
        if (row) return { threadId: String(row.thread_id), title: String(row.title || "") };
      }
      if (tableExists(db, "projects")) {
        const row = db.prepare(`
          SELECT t.thread_id AS thread_id, t.title AS title
          FROM ${picked.table} t
          JOIN projects p ON t.project_id = p.project_id
          WHERE t.deleted_at IS NULL AND p.workspace_root = ?
          ORDER BY t.updated_at DESC LIMIT 1
        `).get(projectRoot);
        if (row) return { threadId: String(row.thread_id), title: String(row.title || "") };
      }
    } catch {}
  }
  // A scoped lookup must fail closed, including missing/legacy project tables
  // or schema errors. Global recency is only meaningful for unscoped queries.
  if (projectRoot) return null;
  // 最近活跃的顶层用户线程（若有 parent_thread_id 列则过滤顶层）
  try {
    let sql = `SELECT thread_id, title FROM ${picked.table} WHERE deleted_at IS NULL`;
    if (cols.has("parent_thread_id")) sql += " AND parent_thread_id IS NULL";
    sql += " ORDER BY updated_at DESC, created_at DESC LIMIT 1";
    const row = db.prepare(sql).get();
    if (row) return { threadId: String(row.thread_id), title: String(row.title || "") };
  } catch {}
  // 兜底：任意最近活跃线程
  try {
    const row = db.prepare(`SELECT thread_id, title FROM ${picked.table} WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1`).get();
    if (row) return { threadId: String(row.thread_id), title: String(row.title || "") };
  } catch {}
  return { threadId: "", title: "" };
}

function readT3Plan(db, threadId) {
  if (!db || !threadId || !tableExists(db, "orchestration_v2_projection_plans")) return null;
  let rows = [];
  try {
    rows = db.prepare(
      "SELECT payload_json FROM orchestration_v2_projection_plans WHERE thread_id = ? ORDER BY rowid DESC LIMIT 8"
    ).all(String(threadId));
  } catch { return null; }
  for (const row of rows) {
    const payload = safeJson(row.payload_json, null);
    if (!payload) continue;
    const rawSteps = Array.isArray(payload.steps) ? payload.steps : [];
    if (!rawSteps.length) continue;
    const steps = rawSteps.map((s, i) => {
      const step = {
        id: String((s && (s.id || s.stepId)) || `step-${i + 1}`),
        text: String((s && (s.text || s.title || s.content)) || ""),
        status: normalizeStepStatus(s && s.status),
      };
      if (s && typeof s.durationMs === "number") step.durationMs = s.durationMs;
      if (s && typeof s.note === "string" && s.note.trim()) step.note = s.note;
      return step;
    });
    const updatedAt =
      payload.updatedAt || payload.updated_at || payload.createdAt || payload.created_at || "";
    return {
      steps,
      background: payload.explanation || payload.background || "",
      updatedAt: updatedAt || "",
      source: "t3-native",
    };
  }
  return null;
}

function readT3Subagents(db, threadId, nowFn) {
  if (!db || !threadId) return [];
  const byThread = new Map();
  // 1) orchestration_v2_projection_subagents（thread_id = 父线程）
  if (tableExists(db, "orchestration_v2_projection_subagents")) {
    const cols = tableColumns(db, "orchestration_v2_projection_subagents");
    const sel = ["subagent_id", "thread_id", "status"];
    for (const c of ["provider", "provider_instance_id", "child_thread_id", "started_at", "completed_at", "updated_at", "payload_json"]) {
      if (cols.has(c)) sel.push(c);
    }
    try {
      const rows = db.prepare(
        `SELECT ${sel.join(", ")} FROM orchestration_v2_projection_subagents WHERE thread_id = ?`
      ).all(String(threadId));
      for (const r of rows) {
        const payload = safeJson(r.payload_json, {});
        const child = r.child_thread_id || (payload && payload.childThreadId) || r.subagent_id;
        const createdAt = r.started_at || (payload && payload.startedAt) || "";
        const updatedAt = r.updated_at || (payload && payload.updatedAt) || (r.completed_at || "");
        byThread.set(String(child), {
          threadId: String(child || r.subagent_id),
          title: String((payload && (payload.title || payload.model)) || child || r.subagent_id),
          status: normalizeStepStatus(r.status === "completed" ? "completed" : r.status === "running" ? "running" : r.status),
          providerInstanceId: String(r.provider_instance_id || (payload && payload.providerInstanceId) || r.provider || ""),
          model: String((payload && payload.model) || ""),
          createdAt: createdAt || "",
          updatedAt: updatedAt || "",
          elapsedSec: elapsedSec(createdAt, updatedAt, nowFn),
        });
      }
    } catch {}
  }
  // 2) v2 线程谱系 parentThreadId（去重合并）
  if (tableExists(db, "orchestration_v2_projection_threads")) {
    const cols = tableColumns(db, "orchestration_v2_projection_threads");
    if (cols.has("payload_json")) {
      try {
        const rows = db.prepare(
          `SELECT thread_id, title, updated_at, created_at, payload_json FROM orchestration_v2_projection_threads
           WHERE deleted_at IS NULL AND json_extract(payload_json, '$.lineage.parentThreadId') = ?`
        ).all(String(threadId));
        for (const r of rows) {
          if (byThread.has(String(r.thread_id))) continue;
          const payload = safeJson(r.payload_json, {});
          const createdAt = r.created_at || (payload && payload.createdAt) || "";
          const updatedAt = r.updated_at || (payload && payload.updatedAt) || "";
          byThread.set(String(r.thread_id), {
            threadId: String(r.thread_id),
            title: String(r.title || ""),
            status: "running",
            providerInstanceId: String((payload && (payload.providerInstanceId || payload.driver)) || ""),
            model: String((payload && (payload.model || payload.modelSelection && payload.modelSelection.model)) || ""),
            createdAt: createdAt || "",
            updatedAt: updatedAt || "",
            elapsedSec: elapsedSec(createdAt, updatedAt, nowFn),
          });
        }
      } catch {}
    }
  }
  // 3) legacy：projection_threads.parent_thread_id
  if (tableExists(db, "projection_threads")) {
    const cols = tableColumns(db, "projection_threads");
    if (cols.has("parent_thread_id")) {
      try {
        const rows = db.prepare(
          "SELECT thread_id, title, created_at, updated_at FROM projection_threads WHERE parent_thread_id = ? AND deleted_at IS NULL"
        ).all(String(threadId));
        for (const r of rows) {
          if (byThread.has(String(r.thread_id))) continue;
          byThread.set(String(r.thread_id), {
            threadId: String(r.thread_id),
            title: String(r.title || ""),
            status: "running",
            providerInstanceId: "",
            model: "",
            createdAt: String(r.created_at || ""),
            updatedAt: String(r.updated_at || ""),
            elapsedSec: elapsedSec(String(r.created_at || ""), String(r.updated_at || ""), nowFn),
          });
        }
      } catch {}
    }
  }
  return [...byThread.values()];
}

// Per-Thread native ID 映射：thread_id -> [nativeThreadRef.nativeId, ...]
// Antigravity brain 目录名是 nativeId（如 agy-conv-111），与 thread_id 不同。
function readThreadNativeIds(db, threadId) {
  const out = new Set();
  if (threadId != null && String(threadId)) out.add(String(threadId));
  if (!db || !threadId || !String(threadId)) return [...out];
  try {
    if (!tableExists(db, "orchestration_v2_projection_provider_threads")) return [...out];
  } catch { return [...out]; }
  try {
    let rows = [];
    let cols = null;
    try { cols = tableColumns(db, "orchestration_v2_projection_provider_threads"); } catch {}
    if (cols && cols.has("payload_json") && cols.has("provider_session_id")) {
      rows = db.prepare("SELECT payload_json, provider_session_id FROM orchestration_v2_projection_provider_threads WHERE thread_id = ?").all(String(threadId));
    } else if (cols && cols.has("payload_json")) {
      rows = db.prepare("SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE thread_id = ?").all(String(threadId));
    } else {
      rows = db.prepare("SELECT payload_json, provider_session_id FROM orchestration_v2_projection_provider_threads WHERE thread_id = ?").all(String(threadId));
    }
    for (const r of rows || []) {
      try {
        const payload = safeJson(r.payload_json, null);
        const nid = payload && payload.nativeThreadRef && payload.nativeThreadRef.nativeId;
        if (typeof nid === "string" && nid) out.add(nid);
      } catch {}
      try {
        if (r && typeof r.provider_session_id === "string" && r.provider_session_id && r.provider_session_id !== String(threadId)) {
          // 保留 provider_session_id 作为潜在映射（部分租户用它作目录名）
          // 仅当 payload 未给出时补充，不覆盖主路径
          // 注意：若严格同步需避免误匹配，此处不作为候选？为兼容保留尝试，若目录存在则可匹配
          // 实际目录匹配仍需 candidateSet 命中才生效
        }
      } catch {}
    }
  } catch {}
  return [...out];
}

// ---------------------------------------------------------------------------
// 源 B：Antigravity brain 目录解析
// ---------------------------------------------------------------------------
function listSessionDirs(brainRoots) {
  const sessions = [];
  for (const root of brainRoots) {
    if (!dirExists(root)) continue;
    // root 本身可能就是单个会话目录
    if (fileExists(path.join(root, "task.md")) || fileExists(path.join(root, "implementation_plan.md"))) {
      sessions.push(root);
    }
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const dir = path.join(root, ent.name);
      if (fileExists(path.join(dir, "task.md")) || fileExists(path.join(dir, "implementation_plan.md"))) {
        sessions.push(dir);
      }
    }
  }
  return sessions;
}

function collectArtifacts(sessionDir) {
  const artifacts = [];
  if (!sessionDir || !dirExists(sessionDir)) return artifacts;
  let entries = [];
  try { entries = fs.readdirSync(sessionDir, { withFileTypes: true }); } catch { return artifacts; }
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const full = path.join(sessionDir, ent.name);
    if (ent.name.endsWith(".metadata.json")) {
      const meta = safeReadJson(full) || {};
      if (meta.userFacing === true) {
        artifacts.push({
          name: ent.name.replace(/\.metadata\.json$/, ""),
          path: full,
          summary: String(meta.summary || ""),
          updatedAt: String(meta.updatedAt || meta.updated_at || fileMtimeIso(full)),
        });
      }
    }
  }
  // 主文档兜底（即使无 metadata 也可点击预览；已有 metadata 的名称不重复）
  const knownNames = new Set(artifacts.map((a) => a.name));
  for (const doc of ["task.md", "implementation_plan.md"]) {
    if (knownNames.has(doc)) continue;
    const full = path.join(sessionDir, doc);
    if (!fileExists(full)) continue;
    if (artifacts.some((a) => a.path === full)) continue;
    artifacts.push({ name: doc, path: full, summary: "", updatedAt: fileMtimeIso(full) });
  }
  artifacts.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  return artifacts;
}

function readAgyBrain(brainRoots, threadOrIds, opts = {}) {
  if (!brainRoots || !brainRoots.length) return null;
  const sessions = listSessionDirs(brainRoots);
  if (!sessions.length) return null;
  // 归一化候选集合：支持字符串 / 字符串数组 / Set
  let candidateSet = new Set();
  if (Array.isArray(threadOrIds)) {
    for (const x of threadOrIds) if (x != null && String(x)) candidateSet.add(String(x));
  } else if (threadOrIds instanceof Set) {
    for (const x of threadOrIds) if (x != null && String(x)) candidateSet.add(String(x));
  } else if (threadOrIds != null && String(threadOrIds)) {
    candidateSet.add(String(threadOrIds));
  }
  let chosen = null;
  if (candidateSet.size) {
    const match = sessions.find((d) => candidateSet.has(path.basename(d)));
    if (match) chosen = match;
  }
  if (!chosen) {
    if (opts && opts.strictThreadMatch === true) return null;
    let best = -Infinity;
    for (const dir of sessions) {
      const t = Date.parse(fileMtimeIso(path.join(dir, "task.md"))) || 0;
      if (t > best) { best = t; chosen = dir; }
    }
  }
  if (!chosen) chosen = sessions[0];
  const taskMdPath = path.join(chosen, "task.md");
  if (!fileExists(taskMdPath)) return { steps: [], background: "", updatedAt: "", source: "agy-brain", artifacts: [] };
  let raw = "";
  try { raw = fs.readFileSync(taskMdPath, "utf8"); } catch { return null; }
  const steps = parseTaskMd(raw);
  const artifacts = collectArtifacts(chosen);
  // background：取 task.md 一级标题
  let background = "";
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*#\s+(.+?)\s*$/);
    if (m) { background = m[1].trim(); break; }
  }
  return {
    steps,
    background,
    updatedAt: fileMtimeIso(taskMdPath),
    source: "agy-brain",
    artifacts,
  };
}

// ---------------------------------------------------------------------------
// 源 C：Hub 通用打卡存储（Pi / plan_update 保底）
// ---------------------------------------------------------------------------
const PLAN_STALE_MS = 30 * 24 * 60 * 60 * 1000;
const PLAN_MAX_FILES = 200;
function gcTaskPlans(hubPlansDir, nowMs, anchorDir) {
  try {
    assertPlansStore(hubPlansDir, anchorDir);
    if (!dirExists(hubPlansDir)) return { deleted: 0 };
    const now = nowMs != null ? nowMs : Date.now();
    let entries = [];
    try { entries = fs.readdirSync(hubPlansDir, { withFileTypes: true }); } catch { return { deleted: 0 }; }
    const files = [];
    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.endsWith(".json")) continue;
      try {
        const full = planPath(hubPlansDir, ent.name);
        const st = fs.statSync(full);
        files.push({ file: full, mtimeMs: st.mtimeMs });
      } catch {}
    }
    let deleted = 0;
    for (const f of files) {
      if (now - f.mtimeMs > PLAN_STALE_MS) {
        const data = safeReadJson(f.file);
        const steps = data && Array.isArray(data.steps) ? data.steps : [];
        const allDone = steps.length > 0 && steps.every((s) => {
          const st = normalizeStepStatus(s && s.status);
          return st === STATUS_COMPLETED || st === STATUS_CANCELLED;
        });
        const updatedAtMs = data && data.updatedAt ? Date.parse(data.updatedAt) : NaN;
        const noActiveUpdate = Number.isNaN(updatedAtMs) || now - updatedAtMs > PLAN_STALE_MS;
        if (allDone || noActiveUpdate || now - f.mtimeMs > PLAN_STALE_MS) {
          try { assertPlansStore(hubPlansDir, anchorDir); assertSafeFsPath(hubPlansDir, f.file); fs.unlinkSync(f.file); deleted += 1; } catch {}
        }
      }
    }
    try {
      const remaining = [];
      for (const f of files) {
        try {
          if (fs.statSync(f.file).isFile()) remaining.push(f);
        } catch {}
      }
      if (remaining.length > PLAN_MAX_FILES) {
        remaining.sort((a, b) => a.mtimeMs - b.mtimeMs);
        for (const f of remaining.slice(0, remaining.length - PLAN_MAX_FILES)) {
          try { assertPlansStore(hubPlansDir, anchorDir); assertSafeFsPath(hubPlansDir, f.file); fs.unlinkSync(f.file); deleted += 1; } catch {}
        }
      }
    } catch {}
    return { deleted };
  } catch { return { deleted: 0 }; }
}
function listHubPlans(hubPlansDir, nowMs, anchorDir) {
  assertPlansStore(hubPlansDir, anchorDir);
  try { gcTaskPlans(hubPlansDir, nowMs, anchorDir); } catch {}
  if (!dirExists(hubPlansDir)) return [];
  let entries = [];
  try { entries = fs.readdirSync(hubPlansDir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith(".json")) continue;
    let full;
    try { full = planPath(hubPlansDir, ent.name); } catch { continue; }
    const data = safeReadJson(full);
    if (!data || !Array.isArray(data.steps)) continue;
    out.push({ file: full, data });
  }
  return out;
}

function findHubPlan(hubPlansDir, opts) {
  const plans = listHubPlans(hubPlansDir);
  if (!plans.length) return null;
  const hasThread = opts && opts.threadId;
  const hasRoot = opts && opts.projectRoot;
  const byUpdated = (a, b) => String(b.data.updatedAt || "").localeCompare(String(a.data.updatedAt || ""));
  let matched = plans;
  if (hasThread) {
    const tid = String(opts.threadId);
    if (tid === "__NEW__") {
      // New-thread draft isolation: a __NEW__ plan must never surface another
      // session's plan. Always require the exact projectRoot (empty matches
      // only empty) so concurrent projects' drafts stay scoped.
      matched = plans.filter((p) => p.data.threadId === tid && (hasRoot ? sameProject(p.data.projectRoot, opts.projectRoot) : !p.data.projectRoot));
    } else {
      matched = plans.filter((p) => String(p.data.threadId || "") === tid && (!hasRoot || !p.data.projectRoot || sameProject(p.data.projectRoot, opts.projectRoot)));
    }
  } else if (hasRoot) {
    // Project-level lookup only matches thread-less (project-scoped) plans;
    // never surface another thread's plan just because the projectRoot fits.
    matched = plans.filter((p) => sameProject(p.data.projectRoot, opts.projectRoot) && !p.data.threadId);
  }
  if (!matched.length) return null;
  matched.sort(byUpdated);
  const best = matched[0].data;
  return {
    steps: best.steps.map((s, i) => ({
      id: String((s && s.id) || `step-${i + 1}`),
      text: String((s && s.text) || ""),
      status: normalizeStepStatus(s && s.status),
      ...(s && typeof s.note === "string" && s.note.trim() ? { note: s.note } : {}),
    })),
    background: String(best.background || best.title || ""),
    updatedAt: String(best.updatedAt || ""),
    source: "hub-mcp",
  };
}

function inferStepsFromSubagents(subagents) {
  const sorted = [...subagents].sort((a, b) =>
    String(a.createdAt || "").localeCompare(String(b.createdAt || ""))
  );
  let updatedAt = "";
  for (const s of sorted) if (String(s.updatedAt || "") > updatedAt) updatedAt = String(s.updatedAt);
  return {
    steps: sorted.map((s, i) => ({
      id: `sub-${i + 1}`,
      text: String(s.title || s.threadId || `子代理 ${i + 1}`),
      status: normalizeStepStatus(s.status),
    })),
    background: "",
    updatedAt,
    source: "subagents-inferred",
  };
}

function computeProgress(steps) {
  let completed = 0, inProgress = 0, pending = 0;
  for (const s of steps) {
    if (s.status === STATUS_COMPLETED) completed += 1;
    else if (s.status === STATUS_IN_PROGRESS) inProgress += 1;
    else pending += 1;
  }
  const total = steps.length;
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
  return { completed, inProgress, pending, total, label: `${completed}/${total}`, percent };
}

function freshnessScore(plan) {
  if (!plan || !plan.steps || !plan.steps.length) return -Infinity;
  const t = Date.parse(plan.updatedAt || "");
  return Number.isNaN(t) ? 0 : t;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------
function createTaskBoard(opts = {}) {
  const homeDir = opts.homeDir || os.homedir();
  const t3DbPath = expandTilde(opts.t3DbPath || path.join(homeDir, ".t3", "userdata", "statev2.sqlite"));
  const hubPlansDir = expandTilde(opts.hubPlansDir || path.join(homeDir, ".t3", "hub", "task-plans"));
  const brainRoots = normalizeBrainRoots(opts.agyBrainDirs ?? opts.agyBrainDir ?? null, homeDir);
  const nowFn = typeof opts.now === "function" ? opts.now : () => Date.now();
  function checkPlansStore() {
    const resolved = path.resolve(hubPlansDir);
    const homeRes = path.resolve(homeDir);
    if (resolved === homeRes || resolved.startsWith(homeRes + path.sep)) assertPlansStore(hubPlansDir, homeRes);
    else assertPlansStore(hubPlansDir);
  }

  function getBoardSnapshot(query = {}) {
    const q = query || {};
    validatePlanInput(q);
    checkPlansStore();
    const requestedThreadId = q.threadId != null ? String(q.threadId) : "";
    const isNewDraft = requestedThreadId === "__NEW__";
    // Any explicit scope disables the global brain mtime fallback, even when
    // strictThreadMatch:false is supplied. Only an unscoped query may use it.
    const strictThreadMatch = Boolean(q.strictThreadMatch === true || requestedThreadId || q.projectRoot);
    // /threads/new and any strict request without a real thread id are
    // isolated drafts: surface only an explicitly __NEW__ hub plan (scoped
    // to the project when one is present) or the empty 0/0 plan.
    const treatAsNew = isNewDraft || (q.strictThreadMatch === true && !requestedThreadId);
    // A project-only query reads the threadless Hub plan. It must not pick an
    // implicit session, even within that project, or collect its artifacts and
    // subagents. Explicit strict draft queries retain their __NEW__ semantics.
    const projectOnly = Boolean(q.projectRoot && !requestedThreadId);
    const db = treatAsNew || projectOnly ? null : openDbReadOnly(t3DbPath);
    if (treatAsNew) {
      const hub = findHubPlan(hubPlansDir, { threadId: "__NEW__", projectRoot: q.projectRoot ? String(q.projectRoot) : "" });
      const steps = hub && Array.isArray(hub.steps) ? hub.steps : [];
      const winner = hub || { steps: [], background: "", updatedAt: "", source: "t3-native" };
      return {
        threadId: "__NEW__",
        projectRoot: q.projectRoot ? String(q.projectRoot) : "",
        title: "",
        background: String(winner.background || ""),
        steps,
        subagents: [],
        artifacts: [],
        source: hub ? winner.source || "hub-mcp" : "t3-native",
        progress: computeProgress(steps),
        updatedAt: String(winner.updatedAt || new Date(nowFn()).toISOString()),
      };
    }
    let resolved = { threadId: q.threadId ? String(q.threadId) : "", title: "" };
    let t3Plan = null;
    let subagents = [];
    let nativeIds = null;
    let candidateIds = null;
    try {
      if (db) resolved = resolveCurrentThread(db, { threadId: q.threadId, projectRoot: q.projectRoot }) || { threadId: "", title: "" };
      const tid = resolved.threadId || (q.threadId ? String(q.threadId) : "");
      // Foreign SQLite thread ownership: when both threadId (non-__NEW__) and
      // projectRoot are supplied and SQLite proves the thread is bound to a
      // different workspace, block all foreign SQLite/AGY/unscoped reads.
      if (db && q.threadId && q.projectRoot && String(q.threadId) !== "__NEW__") {
        const picked = pickThreadsTable(db);
        const bound = picked ? lookupThreadWorkspaceRoot(db, picked, tid) : null;
        if (bound && String(bound).trim() && !sameProject(bound, String(q.projectRoot))) {
          try { if (db) db.close(); } catch {}
          let scopedHub = null;
          try {
            const all = listHubPlans(hubPlansDir, undefined, (() => {
              try {
                const rp = path.resolve(hubPlansDir);
                const hp = path.resolve(homeDir);
                return (rp === hp || rp.startsWith(hp + path.sep)) ? homeDir : undefined;
              } catch { return undefined; }
            })());
            const reqTid = String(q.threadId);
            const reqRoot = String(q.projectRoot);
            const matched = all.filter((p) => String(p.data.threadId || "") === reqTid && p.data.projectRoot && sameProject(p.data.projectRoot, reqRoot));
            if (matched.length) {
              matched.sort((a, b) => String(b.data.updatedAt || "").localeCompare(String(a.data.updatedAt || "")));
              const best = matched[0].data;
              scopedHub = {
                steps: best.steps.map((s, i) => ({
                  id: String((s && s.id) || `step-${i + 1}`),
                  text: String((s && s.text) || ""),
                  status: normalizeStepStatus(s && s.status),
                  ...(s && typeof s.note === "string" && s.note.trim() ? { note: s.note } : {}),
                })),
                background: String(best.background || best.title || ""),
                updatedAt: String(best.updatedAt || ""),
                source: "hub-mcp",
              };
            }
          } catch {}
          const scopedSteps = scopedHub && Array.isArray(scopedHub.steps) ? scopedHub.steps : [];
          const winner = scopedHub || { steps: [], background: "", updatedAt: "", source: "t3-native" };
          return {
            threadId: "",
            projectRoot: String(q.projectRoot),
            title: "",
            background: String(winner.background || ""),
            steps: scopedSteps,
            subagents: [],
            artifacts: [],
            source: winner.source || "t3-native",
            progress: computeProgress(scopedSteps),
            updatedAt: String(winner.updatedAt || new Date(nowFn()).toISOString()),
          };
        }
      }
      if (db) {
        t3Plan = readT3Plan(db, tid);
        subagents = readT3Subagents(db, tid, nowFn);
        try { nativeIds = readThreadNativeIds(db, tid); } catch { nativeIds = tid ? [tid] : []; }
      } else {
        nativeIds = tid ? [tid] : [];
      }
      candidateIds = nativeIds && nativeIds.length ? nativeIds : (tid ? [tid] : []);
      if (!candidateIds.includes(tid) && tid) candidateIds.push(tid);
      resolved.threadId = tid;
      if (!resolved.title && tid && db) {
        try {
          const picked = pickThreadsTable(db);
          if (picked) {
            const row = db.prepare(`SELECT title FROM ${picked.table} WHERE thread_id = ?`).get(tid);
            if (row) resolved.title = String(row.title || "");
          }
        } catch {}
      }
    } finally {
      try { if (db) db.close(); } catch {}
    }

    const agy = readAgyBrain(brainRoots, candidateIds, { strictThreadMatch });
    const hub = findHubPlan(hubPlansDir, { threadId: resolved.threadId || q.threadId, projectRoot: q.projectRoot });

    const candidates = [hub, t3Plan, agy].filter(Boolean).filter((c) => c.steps && c.steps.length);
    candidates.sort((a, b) => freshnessScore(b) - freshnessScore(a));
    let winner = candidates[0] || null;
    if (!winner && subagents.length && q.excludeSubagentInference !== true) winner = inferStepsFromSubagents(subagents);
    if (!winner) winner = { steps: [], background: "", updatedAt: "", source: "t3-native" };

    const artifacts = agy && Array.isArray(agy.artifacts) ? agy.artifacts : [];
    const steps = winner.steps || [];
    return {
      threadId: resolved.threadId || "",
      projectRoot: q.projectRoot ? String(q.projectRoot) : "",
      title: resolved.title || "",
      background: String(winner.background || ""),
      steps,
      subagents,
      artifacts,
      source: winner.source || "t3-native",
      progress: computeProgress(steps),
      updatedAt: String(winner.updatedAt || new Date(nowFn()).toISOString()),
    };
  }

  function updatePlan(input) {
    const o = input || {};
    validatePlanInput(o);
    const threadId = o.threadId ? String(o.threadId) : "";
    const projectRoot = o.projectRoot ? String(o.projectRoot) : "";
    if (!threadId && !projectRoot) throw new Error("updatePlan requires threadId or projectRoot");
    if (!Array.isArray(o.steps)) throw new Error("updatePlan requires steps array");
    const steps = o.steps.map((s, i) => {
      const step = {
        id: String((s && (s.id || s.stepId)) || `step-${i + 1}`),
        text: String((s && (s.text || s.title || s.content)) || ""),
        status: normalizeStepStatus(s && s.status),
      };
      if (s && typeof s.note === "string" && s.note.trim()) step.note = s.note;
      if (s && typeof s.durationMs === "number") step.durationMs = s.durationMs;
      return step;
    });
    const record = {
      threadId,
      projectRoot,
      title: String(o.title || ""),
      background: String(o.background || ""),
      steps,
      updatedAt: new Date(nowFn()).toISOString(),
    };
    checkPlansStore();
    const file = planPath(hubPlansDir, planFileKey({ threadId: threadId || undefined, projectRoot: projectRoot || undefined }) + ".json");
    try {
      const rp = path.resolve(hubPlansDir);
      const hp = path.resolve(homeDir);
      const anchor = (rp === hp || rp.startsWith(hp + path.sep)) ? homeDir : undefined;
      gcTaskPlans(hubPlansDir, nowFn(), anchor);
    } catch {}
    writeJsonAtomic(file, record);
    return record;
  }

  function clearPlan(input) {
    const o = input || {};
    validatePlanInput(o);
    if (!o.threadId && !o.projectRoot) throw new Error("clearPlan requires threadId or projectRoot");
    checkPlansStore();
    let deleted = 0;
    let plansAnchor;
    try {
      const rp = path.resolve(hubPlansDir);
      const hp = path.resolve(homeDir);
      plansAnchor = (rp === hp || rp.startsWith(hp + path.sep)) ? homeDir : undefined;
    } catch { plansAnchor = undefined; }
    const hasThread = o.threadId != null && String(o.threadId) !== "";
    const hasRoot = o.projectRoot != null && String(o.projectRoot) !== "";
    let foreignThreadMismatch = false;
    if (hasThread && hasRoot && String(o.threadId) !== "__NEW__") {
      const db = openDbReadOnly(t3DbPath);
      try {
        if (db) {
          const picked = pickThreadsTable(db);
          const bound = picked ? lookupThreadWorkspaceRoot(db, picked, String(o.threadId)) : null;
          if (bound && String(bound).trim() && !sameProject(bound, String(o.projectRoot))) {
            foreignThreadMismatch = true;
          }
        }
      } finally {
        try { if (db) db.close(); } catch {}
      }
    }
    for (const p of listHubPlans(hubPlansDir, undefined, plansAnchor)) {
      const d = p.data;
      const dThread = String(d.threadId || "");
      const dRoot = String(d.projectRoot || "");
      let shouldDelete = false;
      if (o.threadId === "__NEW__") {
        // The sentinel is shared across projects; unlike real thread IDs it
        // only identifies a draft together with its (possibly empty) scope.
        shouldDelete = d.threadId === "__NEW__" && (hasRoot ? sameProject(d.projectRoot, o.projectRoot) : !d.projectRoot);
      } else if (hasThread) {
        // Strict thread isolation: when a threadId is supplied, only that
        // thread's plans are removed. Never cross-delete other threads that
        // merely share the same projectRoot.
        shouldDelete = dThread === String(o.threadId) && (!hasRoot || (dRoot ? sameProject(dRoot, o.projectRoot) : !foreignThreadMismatch));
      } else if (hasRoot) {
        // Project-level clear only removes plans without an explicit
        // threadId (project-scoped drafts), never other sessions' plans.
        shouldDelete = sameProject(dRoot, o.projectRoot) && dThread === "";
      }
      if (shouldDelete) {
        try { checkPlansStore(); assertSafeFsPath(hubPlansDir, p.file); fs.unlinkSync(p.file); deleted += 1; } catch {}
      }
    }
    return { deleted };
  }

  return { getBoardSnapshot, updatePlan, clearPlan };
}

module.exports = {
  createTaskBoard,
  normalizeStepStatus,
  parseTaskMd,
  computeProgress,
  planFileKey,
  gcTaskPlans,
  PLAN_STALE_MS,
  PLAN_MAX_FILES,
};
