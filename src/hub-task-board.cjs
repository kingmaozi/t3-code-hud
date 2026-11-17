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
const { performance } = require("node:perf_hooks");
const NATIVE_ATOMICS_WAIT = Atomics.wait;
// VM fixtures may replace Atomics before module evaluation, so identity alone
// cannot distinguish virtual waits from physical blocking.
const HAS_NATIVE_ATOMICS_WAIT = /\{\s*\[native code\]\s*\}/.test(Function.prototype.toString.call(NATIVE_ATOMICS_WAIT));
const { assertSafeFsPath } = require("./hub-skills.cjs");
const { captureArtifactIdentity } = require("./hub-artifact-access.cjs");

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
function planRecordRevision(record) {
  const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return createHash("sha256").update(JSON.stringify(canonical(record))).digest("hex");
}
function planRevision(plans) {
  if (!plans.length) return ""; // An absent manual scope is itself a CAS baseline.
  const files = plans.map(({ file, data }) => [path.basename(file), planRecordRevision(data)]);
  files.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return createHash("sha256").update(JSON.stringify(files)).digest("hex");
}
function planConflict() {
  const error = new Error("PLAN_CONFLICT: 计划已被其他窗口更新，请刷新后重试");
  error.code = "PLAN_CONFLICT";
  return error;
}
// SQLite's OS-backed lock serializes the CAS and mutation across processes,
// and releases even after a crash. No manual plan content goes into this DB.
function withPlansLock(hubPlansDir, scope, work, options = {}) {
  const { timeoutMs = 5000 } = options;
  const hasCustomMono = typeof options.monotonicNow === "function";
  const monotonicNow = hasCustomMono ? options.monotonicNow : () => performance.now();
  assertPlansStore(hubPlansDir);
  safeMkdir(hubPlansDir);
  // Canonical project aliases must share a lock, including drafts and old files.
  const key = planFileKey({ threadId: scope.threadId || undefined, projectRoot: scope.projectRoot ? canonicalProjectPath(scope.projectRoot) : undefined });
  const hash = createHash("sha256").update(key).digest("hex");
  const file = assertSafeFsPath(hubPlansDir, path.join(hubPlansDir, `.plan-write-lock.${hash}.sqlite`));
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    const entry = assertSafeFsPath(hubPlansDir, file + suffix);
    try { if (!fs.lstatSync(entry).isFile()) throw new Error("unsafe plan lock path"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const lock = new DatabaseSync(file);
  let acquired = false;
  try {
    const lockBusy = () => {
      const error = new Error("PLAN_LOCK_BUSY: 计划正在保存，等待超时，请稍后重试");
      error.code = "PLAN_LOCK_BUSY";
      return error;
    };
    if (Number.isFinite(timeoutMs) && timeoutMs <= 0) {
      lock.exec("PRAGMA busy_timeout=0");
      try { lock.exec("BEGIN IMMEDIATE"); acquired = true; }
      catch (error) {
        if ((error.errcode & 255) !== 5 && error.code !== "SQLITE_BUSY" && !/database.*locked/i.test(error.message)) throw error;
        throw lockBusy();
      }
      return work();
    }
    const maxWaitMs = Math.max(1, Math.min(5000, Number.isFinite(timeoutMs) ? timeoutMs : 5000));
    const hasHrtime = typeof process?.hrtime?.bigint === "function";
    const physicalWait = HAS_NATIVE_ATOMICS_WAIT && Atomics.wait === NATIVE_ATOMICS_WAIT;
    let monoBase = monotonicNow(), perfBase = performance.now(), hrBase = hasHrtime ? process.hrtime.bigint() : null;
    let lastMono = monoBase, lastPerf = perfBase, lastHr = hrBase, physicalLockStep = false;
    let monoMax = 0, perfMax = 0, hrMax = 0, elapsedFloor = 0;
    const currentElapsed = () => Math.max(monoMax, perfMax, hrMax, elapsedFloor);
    const sampleElapsed = (usePerf = true, lockStep = false) => {
      const now = monotonicNow();
      if (Number.isFinite(now)) {
        if (!Number.isFinite(monoBase)) monoBase = now;
        else if (now - monoBase > monoMax) monoMax = now - monoBase;
      }
      const perfNow = performance.now();
      const monoStepMs = now - lastMono, perfStepMs = perfNow - lastPerf;
      lastMono = now; lastPerf = perfNow;
      if (Number.isFinite(perfNow)) {
        if (!Number.isFinite(perfBase)) perfBase = perfNow;
        else if (usePerf && perfNow - perfBase > perfMax) perfMax = perfNow - perfBase;
      }
      if (hasHrtime) {
        const hrNow = process.hrtime.bigint();
        if (hrBase === null) hrBase = hrNow;
        // A real SQLite call can block even in a VM with virtual Atomics.wait.
        // Ignore small CPU jitter in healthy virtual clocks (e.g. +0.9ms ticks).
        if (lockStep && lastHr !== null && Number(hrNow - lastHr) / 1e6 >= 5 && perfStepMs === 0 && monoStepMs < 1) physicalLockStep = true;
        if (usePerf && (physicalWait || physicalLockStep || perfMax === 0 && monoMax === 0)) {
          const hrMs = Number(hrNow - hrBase) / 1e6;
          if (hrMs > hrMax) hrMax = hrMs;
        }
        lastHr = hrNow;
      }
      return currentElapsed();
    };
    for (let attempt = 0; !acquired; attempt++) {
      let remainingWholeMs;
      if (attempt === 0) {
        perfBase = performance.now();
        perfMax = 0;
        if (hasHrtime) { hrBase = process.hrtime.bigint(); lastHr = hrBase; hrMax = 0; }
        remainingWholeMs = hasCustomMono ? Math.floor(maxWaitMs - sampleElapsed(false)) : Math.floor(maxWaitMs);
      } else {
        remainingWholeMs = Math.floor(maxWaitMs - sampleElapsed(true));
      }
      if (remainingWholeMs < 1) throw lockBusy();
      let busyTimeout = Math.min(maxWaitMs, remainingWholeMs);
      for (let tighten = 0; ; tighten++) {
        const beforePragma = currentElapsed();
        if (Math.floor(maxWaitMs - beforePragma) < 1) throw lockBusy();
        lock.exec(`PRAGMA busy_timeout=${busyTimeout}`);
        const afterPragma = sampleElapsed(true, true);
        const afterPragmaRem = Math.floor(maxWaitMs - afterPragma);
        if (afterPragmaRem < 1) throw lockBusy();
        if (tighten === 0 && !hasCustomMono && attempt === 0 && afterPragma < 1) break;
        if (afterPragmaRem >= busyTimeout) break;
        busyTimeout = afterPragmaRem;
      }
      try { lock.exec("BEGIN IMMEDIATE"); acquired = true; }
      catch (error) {
        if ((error.errcode & 255) !== 5 && error.code !== "SQLITE_BUSY" && !/database.*locked/i.test(error.message)) throw error;
        const beforeWait = sampleElapsed(true, true);
        const remainingRetryMs = Math.floor(maxWaitMs - beforeWait);
        if (remainingRetryMs < 1) throw lockBusy();
        // Retry VFS-level immediate BUSY with bounded backoff, clamped to remaining budget.
        const delay = Math.min(10 * 2 ** Math.min(attempt, 4), 100, remainingRetryMs);
        const floorBeforeWait = currentElapsed();
        const monoBeforeWait = monoMax, perfBeforeWait = perfMax;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
        sampleElapsed();
        // A clock that measured the full wait already covers it. Adding that
        // wait to another clock's fractional read ticks would count it twice.
        if (monoMax - monoBeforeWait < delay && perfMax - perfBeforeWait < delay) {
          elapsedFloor = Math.max(elapsedFloor, floorBeforeWait + delay);
        }
      }
    }
    return work();
  } finally {
    try { if (acquired) lock.exec("ROLLBACK"); }
    finally { lock.close(); }
  }
}
function assertPlanVersion(input, current) {
  if (Object.hasOwn(input, "expectedRevision") && (typeof input.expectedRevision !== "string" || input.expectedRevision !== (current?.planRevision || ""))) throw planConflict();
  if (Object.hasOwn(input, "expectedUpdatedAt") && (typeof input.expectedUpdatedAt !== "string" || input.expectedUpdatedAt !== (current?.updatedAt || ""))) throw planConflict();
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
  const projectRoot = input && input.projectRoot ? canonicalProjectPath(input.projectRoot) : "";
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
    const itemCols = tableExists(db, "orchestration_v2_projection_turn_items")
      ? tableColumns(db, "orchestration_v2_projection_turn_items") : new Set();
    const hasItems = ["thread_id", "type", "updated_at", "payload_json"].every(c => itemCols.has(c));
    // Native plan payloads do not include their modification time. The
    // corresponding turn item does, and planId is scoped to the same thread.
    // The JSON guard keeps an unrelated malformed item from breaking a poll.
    const sql = hasItems ? `
      SELECT p.rowid AS plan_rowid, p.kind, p.status, p.payload_json,
             MAX(i.updated_at) AS item_updated_at
      FROM orchestration_v2_projection_plans p
      LEFT JOIN orchestration_v2_projection_turn_items i
        ON i.thread_id = p.thread_id AND i.type = p.kind
       AND CASE WHEN json_valid(i.payload_json)
                THEN json_extract(i.payload_json, '$.planId') END = p.plan_id
      WHERE p.thread_id = ? GROUP BY p.rowid ORDER BY p.rowid DESC
    ` : `SELECT rowid AS plan_rowid, kind, status, payload_json
         FROM orchestration_v2_projection_plans WHERE thread_id = ? ORDER BY rowid DESC`;
    rows = db.prepare(sql).all(String(threadId));
  } catch { return null; }
  let best = null;
  for (const row of rows) {
    const payload = safeJson(row.payload_json, null);
    if (!payload || row.status === "superseded" || payload.status === "superseded") continue;
    const rawSteps = Array.isArray(payload.steps) ? payload.steps : [];
    const planMarkdown = row.kind === "proposed_plan" && typeof payload.markdown === "string"
      ? payload.markdown : "";
    if (!rawSteps.length && !planMarkdown.trim()) continue;
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
    const updatedAt = row.item_updated_at || payload.updatedAt || payload.updated_at || payload.createdAt || payload.created_at || "";
    const candidate = {
      steps,
      planMarkdown,
      planStatus: String(row.status || payload.status || ""),
      background: payload.explanation || payload.background || "",
      updatedAt: updatedAt || "",
      source: "t3-native",
    };
    // Rows are initially in rowid order, which remains the legacy tie-breaker
    // when timestamps are unavailable; a known newer timestamp wins otherwise.
    if (!best || freshnessScore(candidate) > freshnessScore(best)) best = candidate;
  }
  return best;
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
          rawStatus: typeof r.status === "string" && r.status ? r.status : "unknown",
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
            rawStatus: "unknown",
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
            rawStatus: "unknown",
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

// For a scoped request, only examine its exact verified session IDs. A
// symlinked session directory must not redirect a plan lookup outside a root.
function hasBrainPlanEntry(dir) {
  return ["task.md", "implementation_plan.md"].some((name) => {
    try { fs.lstatSync(path.join(dir, name)); return true; }
    catch (error) { return error && error.code !== "ENOENT" && error.code !== "ENOTDIR"; }
  });
}
function resolveBrainHomeAnchor(dir, homeDir) {
  if (!homeDir) return null;
  const anchor = path.resolve(homeDir), target = path.resolve(dir);
  const rel = path.relative(anchor, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel) ? anchor : null;
}
function captureBrainSession(dir, homeDir = null) {
  try {
    const anchorDir = resolveBrainHomeAnchor(dir, homeDir);
    const anchorIdentity = anchorDir ? captureArtifactIdentity(anchorDir, dir) : null;
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    return { dir, realPath: fs.realpathSync(dir), dev: stat.dev, ino: stat.ino, anchorDir, anchorIdentity };
  } catch { return null; }
}
function sameBrainSession(session) {
  if (!session) return false;
  try {
    if (session.anchorDir && JSON.stringify(captureArtifactIdentity(session.anchorDir, session.dir)) !== JSON.stringify(session.anchorIdentity)) return false;
    const stat = fs.lstatSync(session.dir);
    return !stat.isSymbolicLink() && stat.isDirectory() && stat.dev === session.dev && stat.ino === session.ino && fs.realpathSync(session.dir) === session.realPath;
  } catch { return false; }
}
function findScopedBrainSessions(brainRoots, candidateIds, homeDir = null) {
  const sessions = new Map();
  for (const root of brainRoots) {
    if (!dirExists(root)) continue;
    for (const id of candidateIds) {
      if (!id || id === "." || id === ".." || path.basename(id) !== id || id.includes("\\")) continue;
      if (path.basename(root) === id && hasBrainPlanEntry(root)) {
        const session = captureBrainSession(root, homeDir);
        if (session) sessions.set(session.realPath, session);
      }
      const dir = path.join(root, id);
      try {
        if (!fs.lstatSync(dir).isDirectory()) continue;
        const relative = path.relative(fs.realpathSync(root), fs.realpathSync(dir));
        if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) continue;
        if (hasBrainPlanEntry(dir)) {
          const session = captureBrainSession(dir, homeDir);
          if (session) sessions.set(session.realPath, session);
        }
      } catch {}
    }
  }
  return [...sessions.values()];
}

const MAX_AGY_PLAN_BYTES = 512 * 1024;
function readBrainFile(session, documentName) {
  if (!session || path.basename(documentName) !== documentName) return null;
  const file = path.join(session.dir, documentName);
  let fd, updatedAt = "";
  try {
    if (!sameBrainSession(session)) return { error: "unsafe_path", updatedAt };
    const entry = fs.lstatSync(file);
    updatedAt = entry.mtime.toISOString();
    if (entry.isSymbolicLink()) return { error: "unsafe_path", updatedAt };
    if (!entry.isFile()) return { error: "unreadable", updatedAt };
    if (fs.realpathSync(file) !== path.join(session.realPath, documentName)) {
      return { error: "unsafe_path", updatedAt };
    }
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.dev !== entry.dev || stat.ino !== entry.ino) return { error: "unreadable", updatedAt };
    updatedAt = stat.mtime.toISOString();
    if (stat.size > MAX_AGY_PLAN_BYTES) return { error: "too_large", updatedAt: stat.mtime.toISOString() };
    const buffer = Buffer.allocUnsafe(MAX_AGY_PLAN_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const n = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (!n) break;
      length += n;
    }
    if (length > MAX_AGY_PLAN_BYTES) return { error: "too_large", updatedAt: stat.mtime.toISOString() };
    if (!sameBrainSession(session)) return { error: "unsafe_path", updatedAt };
    return { markdown: buffer.subarray(0, length).toString("utf8"), updatedAt: stat.mtime.toISOString() };
  } catch (error) {
    if (error && error.code === "ENOENT" && !updatedAt) return null;
    return { error: error && error.code === "ELOOP" ? "unsafe_path" : "unreadable", updatedAt };
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}
function readAgyPlanDocument(session, documentName) {
  if (documentName !== "task.md" && documentName !== "implementation_plan.md") return null;
  return readBrainFile(session, documentName);
}

function collectArtifacts(session) {
  const artifacts = [];
  if (!sameBrainSession(session)) return artifacts;
  const sessionDir = session.dir;
  let entries = [];
  try { entries = fs.readdirSync(sessionDir, { withFileTypes: true }); } catch { return artifacts; }
  if (!sameBrainSession(session)) return [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const full = path.join(sessionDir, ent.name);
    if (ent.name.endsWith(".metadata.json")) {
      const content = readBrainFile(session, ent.name);
      let meta = {};
      try { if (content && !content.error) meta = JSON.parse(content.markdown) || {}; } catch {}
      if (meta.userFacing === true) {
        const name = ent.name.replace(/\.metadata\.json$/, "");
        artifacts.push({
          name,
          path: path.join(sessionDir, name),
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
  const resolvedSessionDir = path.resolve(sessionDir);
  const bound = artifacts.flatMap(artifact => {
    try {
      const accessIdentity = captureArtifactIdentity(session.dir, artifact.path, session.anchorDir || null);
      const rootEntry = accessIdentity.entries.find((e) => e.path === resolvedSessionDir);
      if (accessIdentity.realRoot !== session.realPath || !rootEntry || rootEntry.dev !== session.dev || rootEntry.ino !== session.ino) return [];
      return [{ ...artifact, accessIdentity }];
    } catch { return []; }
  });
  return sameBrainSession(session) ? bound : [];
}

function readAgyBrain(brainRoots, threadOrIds, opts = {}) {
  if (!brainRoots || !brainRoots.length) return null;
  const homeDir = opts && opts.homeDir ? opts.homeDir : null;
  // 归一化候选集合：支持字符串 / 字符串数组 / Set
  let candidateSet = new Set();
  if (Array.isArray(threadOrIds)) {
    for (const x of threadOrIds) if (x != null && String(x)) candidateSet.add(String(x));
  } else if (threadOrIds instanceof Set) {
    for (const x of threadOrIds) if (x != null && String(x)) candidateSet.add(String(x));
  } else if (threadOrIds != null && String(threadOrIds)) {
    candidateSet.add(String(threadOrIds));
  }
  let sessions;
  if (opts && opts.strictThreadMatch === true) {
    sessions = findScopedBrainSessions(brainRoots, candidateSet, homeDir);
  } else {
    sessions = listSessionDirs(brainRoots).map((d) => captureBrainSession(d, homeDir)).filter(Boolean);
    const matching = sessions.filter((session) => candidateSet.has(path.basename(session.dir)));
    if (matching.length) sessions = matching;
  }
  if (!sessions.length) return null;
  const candidates = [], artifactsByPath = new Map();
  // Several provider runs can belong to one verified T3 thread. Compare only
  // those exact directories, and retain their independently scoped artifacts.
  for (const session of sessions) {
    const sessionArtifacts = collectArtifacts(session), sessionPlans = [];
    for (const name of ["task.md", "implementation_plan.md"]) {
      const document = readAgyPlanDocument(session, name);
      if (!document) continue;
      const raw = document.markdown || "";
      const steps = name === "task.md" ? parseTaskMd(raw) : [];
      const heading = raw.split(/\r?\n/).find((line) => /^\s*#\s+(.+?)\s*$/.test(line));
      const plan = {
        steps,
        background: heading ? heading.replace(/^\s*#\s+/, "").trim() : "",
        planMarkdown: steps.length ? "" : raw,
        planReadError: document.error || "",
        updatedAt: document.updatedAt,
        source: "agy-brain",
      };
      if (freshnessScore(plan) !== -Infinity) sessionPlans.push(plan);
    }
    if (!sameBrainSession(session)) {
      sessionPlans.length = 0;
      sessionPlans.push({ steps: [], background: "", planReadError: "unsafe_path", updatedAt: "", source: "agy-brain" });
    } else {
      for (const artifact of sessionArtifacts) artifactsByPath.set(artifact.path, artifact);
    }
    candidates.push(...sessionPlans);
  }
  candidates.sort((a, b) => freshnessScore(b) - freshnessScore(a));
  const artifacts = [...artifactsByPath.values()].sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  return { ...(candidates[0] || { steps: [], background: "", updatedAt: "", source: "agy-brain" }), artifacts };
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
    return gcTaskPlansCandidates(hubPlansDir, nowMs, anchorDir);
  } catch { return { deleted: 0 }; }
}
function gcTaskPlansCandidates(hubPlansDir, nowMs, anchorDir) {
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
        const st = fs.statSync(full, { bigint: true });
        files.push({ file: full, mtimeMs: Number(st.mtimeMs), signature: [st.dev, st.ino, st.ctimeNs, st.mtimeNs, st.size].join(":") });
      } catch {}
    }
    const remove = (candidate) => {
      try {
        const data = safeReadJson(candidate.file) || {};
        // Opportunistic GC must neither wait on unrelated scopes nor bypass
        // the CAS lock of a live writer (including the caller's own scope).
        return withPlansLock(hubPlansDir, data, () => {
          assertPlansStore(hubPlansDir, anchorDir);
          assertSafeFsPath(hubPlansDir, candidate.file);
          const st = fs.lstatSync(candidate.file, { bigint: true });
          if (!st.isFile() || [st.dev, st.ino, st.ctimeNs, st.mtimeNs, st.size].join(":") !== candidate.signature) return 0;
          fs.unlinkSync(candidate.file);
          return 1;
        }, { timeoutMs: 0 });
      } catch { return 0; }
    };
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
          deleted += remove(f);
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
          deleted += remove(f);
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

function matchingHubPlans(plans, opts) {
  const hasThread = opts && opts.threadId;
  const hasRoot = opts && opts.projectRoot;
  let matched = plans;
  if (hasThread) {
    const tid = String(opts.threadId);
    if (tid === "__NEW__") {
      // New-thread draft isolation: a __NEW__ plan must never surface another
      // session's plan. Always require the exact projectRoot (empty matches
      // only empty) so concurrent projects' drafts stay scoped.
      matched = plans.filter((p) => p.data.threadId === tid && (hasRoot ? sameProject(p.data.projectRoot, opts.projectRoot) : !p.data.projectRoot));
    } else {
      matched = plans.filter((p) => String(p.data.threadId || "") === tid && (hasRoot ? p.data.projectRoot && sameProject(p.data.projectRoot, opts.projectRoot) : !p.data.projectRoot));
    }
  } else if (hasRoot) {
    // Project-level lookup only matches thread-less (project-scoped) plans;
    // never surface another thread's plan just because the projectRoot fits.
    matched = plans.filter((p) => sameProject(p.data.projectRoot, opts.projectRoot) && !p.data.threadId);
  }
  return matched;
}

function findHubPlan(hubPlansDir, opts, plans = listHubPlans(hubPlansDir)) {
  const matched = matchingHubPlans(plans, opts);
  if (!matched.length) return null;
  matched.sort((a, b) => String(b.data.updatedAt || "").localeCompare(String(a.data.updatedAt || "")) || (path.basename(a.file) < path.basename(b.file) ? -1 : 1));
  const best = matched[0].data;
  // Global fallback still displays one plan; its revision belongs to that
  // selected (threadId, projectRoot) scope, never every unrelated plan.
  const scoped = opts?.threadId || opts?.projectRoot ? matched : matchingHubPlans(matched, best);
  return {
    planRevision: planRevision(scoped),
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
  if (!plan || (!(plan.steps && plan.steps.length) && !(typeof plan.planMarkdown === "string" && plan.planMarkdown.trim()) && !plan.planReadError)) return -Infinity;
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
  const lockOptions = { monotonicNow: opts.monotonicNow };
  function checkPlansStore() {
    const resolved = path.resolve(hubPlansDir);
    const homeRes = path.resolve(homeDir);
    if (resolved === homeRes || resolved.startsWith(homeRes + path.sep)) assertPlansStore(hubPlansDir, homeRes);
    else assertPlansStore(hubPlansDir);
  }

  // Artifact access needs an authoritative thread-to-project binding; a
  // matching brain directory name is not evidence of project ownership.
  function verifyArtifactScope({ threadId, projectRoot } = {}) {
    if (typeof threadId !== "string" || !threadId || threadId === "__NEW__" || typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)) return { ok: false, reason: "unknown" };
    const db = openDbReadOnly(t3DbPath);
    if (!db) return { ok: false, reason: "unknown" };
    try {
      const bound = lookupThreadWorkspaceRoot(db, pickThreadsTable(db), threadId);
      if (!bound) return { ok: false, reason: "unknown" };
      return sameProject(bound, projectRoot) ? { ok: true } : { ok: false, reason: "mismatch" };
    } catch { return { ok: false, reason: "unknown" }; }
    finally { try { db.close(); } catch {} }
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
        planMarkdown: "",
        planStatus: "",
        planReadError: "",
        progressKnown: steps.length > 0,
        ...(!steps.length ? { emptyPlanReason: "no_explicit_plan" } : {}),
        subagents: [],
        artifacts: [],
        source: hub ? winner.source || "hub-mcp" : "t3-native",
        planRevision: hub?.planRevision || "",
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
      // Scoped native reads require proven ownership. Missing database/project
      // rows are not permission to borrow native plans or subagents. Only an
      // explicitly matching Hub-authored plan can survive this boundary.
      if (q.threadId && q.projectRoot && String(q.threadId) !== "__NEW__") {
        const picked = db ? pickThreadsTable(db) : null;
        const bound = picked ? lookupThreadWorkspaceRoot(db, picked, tid) : null;
        if (!bound || !String(bound).trim() || !sameProject(bound, String(q.projectRoot))) {
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
            scopedHub = findHubPlan(hubPlansDir, { threadId: String(q.threadId), projectRoot: String(q.projectRoot) }, all);
          } catch {}
          const scopedSteps = scopedHub && Array.isArray(scopedHub.steps) ? scopedHub.steps : [];
          const winner = scopedHub || { steps: [], background: "", updatedAt: "", source: "t3-native" };
          return {
            threadId: "",
            projectRoot: String(q.projectRoot),
            title: "",
            background: String(winner.background || ""),
            steps: scopedSteps,
            planMarkdown: "",
            planStatus: "",
            planReadError: "",
            progressKnown: scopedSteps.length > 0,
            ...(!scopedSteps.length ? { emptyPlanReason: "scope_unverified" } : {}),
            subagents: [],
            artifacts: [],
            artifactScopeError: bound ? "mismatch" : "unknown",
            source: winner.source || "t3-native",
            planRevision: scopedHub?.planRevision || "",
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

    // A brain directory name alone cannot prove workspace ownership. Verify
    // before reading any of it: task.md contains private plan text just as
    // artifacts do. Hub-authored plans retain their own explicit scope.
    const artifactScope = verifyArtifactScope({ projectRoot: q.projectRoot, threadId: requestedThreadId || resolved.threadId });
    const agy = artifactScope.ok ? readAgyBrain(brainRoots, candidateIds, { strictThreadMatch: true, homeDir }) : null;
    const hub = findHubPlan(hubPlansDir, { threadId: resolved.threadId || q.threadId, projectRoot: q.projectRoot });

    const candidates = [hub, t3Plan, agy].filter(Boolean).filter((c) =>
      (c.steps && c.steps.length) || (typeof c.planMarkdown === "string" && c.planMarkdown.trim()) || c.planReadError);
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
      planMarkdown: String(winner.planMarkdown || ""),
      planStatus: String(winner.planStatus || ""),
      planReadError: String(winner.planReadError || ""),
      progressKnown: steps.length > 0,
      ...(!candidates.length ? { emptyPlanReason: "no_explicit_plan" } : {}),
      subagents,
      artifacts,
      ...(!artifactScope.ok && candidateIds?.length ? { artifactScopeError: artifactScope.reason } : {}),
      source: winner.source || "t3-native",
      planRevision: hub?.planRevision || "",
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
    return withPlansLock(hubPlansDir, { threadId, projectRoot }, () => {
      checkPlansStore();
      const file = planPath(hubPlansDir, planFileKey({ threadId: threadId || undefined, projectRoot: projectRoot || undefined }) + ".json");
      const matched = matchingHubPlans(listHubPlans(hubPlansDir), { threadId, projectRoot });
      assertPlanVersion(o, findHubPlan(hubPlansDir, { threadId, projectRoot }, matched));
      writeJsonAtomic(file, record);
      // Consolidate legacy names under the same lock as the scope-wide CAS.
      for (const plan of matched) {
        if (plan.file === file) continue;
        checkPlansStore(); assertSafeFsPath(hubPlansDir, plan.file); fs.unlinkSync(plan.file);
      }
      return { ...record, planRevision: planRevision([{ file, data: record }]) };
    }, lockOptions);
  }

  function clearPlan(input) {
    const o = input || {};
    validatePlanInput(o);
    if (!o.threadId && !o.projectRoot) throw new Error("clearPlan requires threadId or projectRoot");
    checkPlansStore();
    return withPlansLock(hubPlansDir, o, () => {
      checkPlansStore();
      let deleted = 0;
      let plansAnchor;
      try {
        const rp = path.resolve(hubPlansDir);
        const hp = path.resolve(homeDir);
        plansAnchor = (rp === hp || rp.startsWith(hp + path.sep)) ? homeDir : undefined;
      } catch { plansAnchor = undefined; }
      const matched = matchingHubPlans(listHubPlans(hubPlansDir, undefined, plansAnchor), o);
      assertPlanVersion(o, findHubPlan(hubPlansDir, o, matched));
      for (const p of matched) {
        checkPlansStore(); assertSafeFsPath(hubPlansDir, p.file); fs.unlinkSync(p.file); deleted += 1;
      }
      return { deleted };
    }, lockOptions);
  }

  return { getBoardSnapshot, updatePlan, clearPlan, verifyArtifactScope };
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
