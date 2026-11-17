"use strict";

// Discover a startup identity only from T3's local projections and the exact
// process working directory. A caller-supplied memory projectRoot is never a
// source of identity. This helper neither creates state nor selects a recent
// thread, and it does not authorize marker fallback for an unknown host.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { resolveSessionProjectRoot, resolveWorktreeContext } = require("./memory-vault.cjs");

function unbound(reason) {
  return { projectBound: false, projectRoot: null, source: null, reason };
}

function directory(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) return null;
  try {
    const real = fs.realpathSync(value);
    return fs.statSync(real).isDirectory() ? real : null;
  } catch { return null; }
}

function isInside(base, item) {
  const relative = path.relative(base, item);
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}

function safeProjectRoot(root, homeDir, t3Home) {
  const home = directory(homeDir);
  if (!root || root === path.parse(root).root || (home && root === home)) return false;
  const denied = [
    home && path.join(home, ".t3"), home && path.join(home, ".codex"),
    home && path.join(home, ".agents"), home && path.join(home, ".config"),
    home && path.join(home, "Applications"), "/Applications", "/System/Applications", "/System/Library", t3Home,
  ].filter(Boolean);
  return !denied.some(item => {
    const base = directory(item) || (path.isAbsolute(item) ? path.resolve(item) : null);
    return base && isInside(base, root);
  });
}

function selectDatabase(opts, homeDir) {
  if (opts.dbPath != null) {
    if (typeof opts.dbPath !== "string" || !path.isAbsolute(opts.dbPath)) return { error: "invalid_context" };
    return { file: opts.dbPath };
  }
  const t3Home = typeof opts.t3Home === "string" ? opts.t3Home : process.env.T3CODE_HOME;
  if (!t3Home) return { file: path.join(homeDir, ".t3", "userdata", "statev2.sqlite") };
  if (!path.isAbsolute(t3Home)) return { error: "invalid_context" };
  const files = [path.join(t3Home, "statev2.sqlite"), path.join(t3Home, "userdata", "statev2.sqlite")];
  const present = [];
  for (const file of files) {
    try {
      if (!fs.statSync(file).isFile()) return { error: "database_unavailable" };
      present.push(file);
    } catch (error) { if (error.code !== "ENOENT") return { error: "database_unavailable" }; }
  }
  if (present.length > 1) return { error: "database_ambiguous" };
  return { file: present[0] || files[0] };
}

function payloadWorktree(row) {
  if (row.payload_valid !== 1) return { invalid: true };
  const value = row.worktree_path;
  if (value == null || value === "") return { path: null };
  if (typeof value !== "string" || !path.isAbsolute(value)) return { invalid: true };
  return { path: value };
}

/**
 * `cwd`, `threadId`, and `dbPath` are trusted process/startup context, not
 * parameters supplied by an MCP tool call. Undefined threadId reads the
 * launch environment; an explicit null means no launch thread is available.
 * A successfully bound result must remain immutable for the process lifetime.
 */
function resolveMemoryProjectContext(opts = {}) {
  if (!opts || typeof opts !== "object") return unbound("invalid_context");
  const cwd = directory(opts.cwd === undefined ? process.cwd() : opts.cwd);
  const homeDir = opts.homeDir || process.env.HOME || os.homedir();
  const t3Home = typeof opts.t3Home === "string" ? opts.t3Home : process.env.T3CODE_HOME;
  if (!cwd || !safeProjectRoot(cwd, homeDir, t3Home)) return unbound("invalid_context");
  const rawThreadId = opts.threadId === undefined ? process.env.T3CODE_THREAD_ID : opts.threadId;
  if (rawThreadId != null && typeof rawThreadId !== "string") return unbound("invalid_context");
  const threadId = String(rawThreadId || "").trim();
  const selectedDb = selectDatabase(opts, homeDir);
  if (selectedDb.error) return unbound(selectedDb.error);
  try { if (!fs.statSync(selectedDb.file).isFile()) return unbound("database_missing"); }
  catch (error) { return unbound(error.code === "ENOENT" ? "database_missing" : "database_unavailable"); }

  let db;
  try {
    db = new DatabaseSync(selectedDb.file, { readOnly: true });
    db.exec("PRAGMA query_only=ON; BEGIN");
    const projectCols = new Set(db.prepare("PRAGMA table_info(projection_projects)").all().map(row => row.name));
    const threadCols = new Set(db.prepare("PRAGMA table_info(orchestration_v2_projection_threads)").all().map(row => row.name));
    if (!["project_id", "workspace_root"].every(col => projectCols.has(col)) ||
        !["thread_id", "project_id", "payload_json"].every(col => threadCols.has(col))) return unbound("schema_unavailable");
    const projectSql = `SELECT project_id, workspace_root${projectCols.has("deleted_at") ? ", deleted_at" : ""} FROM projection_projects`;
    // SQLite parses the JSON in place and returns only the worktree field.
    // CASE guards every json_type/json_extract call against malformed JSON;
    // an unrelated large conversation payload is never copied into JS.
    const payloadValid = `(CASE
      WHEN payload_json IS NULL OR payload_json = '' THEN 1
      WHEN json_valid(payload_json) = 0 THEN 0
      WHEN json_type(payload_json) <> 'object' THEN 0
      WHEN COALESCE(json_type(payload_json, '$.worktreePath'), 'null') NOT IN ('null', 'text') THEN 0
      ELSE 1 END)`;
    const extractedPath = `(CASE WHEN ${payloadValid} = 1 AND payload_json IS NOT NULL AND payload_json <> ''
      THEN json_extract(payload_json, '$.worktreePath') ELSE NULL END)`;
    const threadSql = `SELECT thread_id, project_id${threadCols.has("deleted_at") ? ", deleted_at" : ""}, ${payloadValid} AS payload_valid, ${extractedPath} AS worktree_path FROM orchestration_v2_projection_threads`;
    const projects = db.prepare(projectSql).all().filter(row => !row.deleted_at);
    const byId = new Map();
    for (const project of projects) {
      if (typeof project.project_id !== "string" || !project.project_id) continue;
      if (byId.has(project.project_id)) byId.set(project.project_id, null);
      else byId.set(project.project_id, project);
    }
    const makeCandidate = (project, worktree) => {
      if (!project || typeof project.workspace_root !== "string") return null;
      try {
        const root = resolveSessionProjectRoot({ projectRoot: project.workspace_root, worktreePath: worktree || undefined });
        return safeProjectRoot(root, homeDir, t3Home) ? root : null;
      } catch { return null; }
    };

    if (threadId) {
      const threads = db.prepare(threadSql + " WHERE thread_id = ?").all(threadId).filter(row => !row.deleted_at);
      if (!threads.length) return unbound("thread_not_found");
      if (threads.length !== 1) return unbound("invalid_context");
      const thread = threads[0], project = byId.get(thread.project_id), worktree = payloadWorktree(thread);
      if (!project || worktree.invalid) return unbound("invalid_context");
      const workspace = directory(project.workspace_root);
      if (workspace && projects.some(other => other.project_id !== project.project_id && directory(other.workspace_root) === workspace)) return unbound("ambiguous");
      const projectRoot = makeCandidate(project, worktree.path);
      const worktreeRoot = worktree.path ? directory(worktree.path) : null;
      if (!projectRoot || (worktree.path && !worktreeRoot)) return unbound("invalid_context");
      if (cwd !== projectRoot && cwd !== worktreeRoot) return unbound("cwd_mismatch");
      return { projectBound: true, projectRoot, source: "t3-thread", reason: "matched", projectId: project.project_id, threadId };
    }

    const candidates = new Map();
    const addCandidate = (root, source, projectId) => {
      if (!candidates.has(root)) candidates.set(root, { sources: new Set(), projectIds: new Set() });
      const candidate = candidates.get(root);
      candidate.sources.add(source); candidate.projectIds.add(projectId);
    };
    for (const project of projects) {
      if (directory(project.workspace_root) !== cwd) continue;
      if (!byId.get(project.project_id)) return unbound("invalid_context");
      const root = makeCandidate(project, null);
      if (!root) return unbound("invalid_context");
      addCandidate(root, "t3-workspace", project.project_id);
    }
    const worktreePaths = new Map(), considered = new Set(), expandedCheckouts = new Set(), contexts = new Map();
    const worktreeContext = value => {
      if (!contexts.has(value)) {
        try { contexts.set(value, resolveWorktreeContext(value)); } catch { contexts.set(value, null); }
      }
      return contexts.get(value);
    };
    const expandCheckoutRoot = checkoutRoot => {
      if (expandedCheckouts.has(checkoutRoot)) return null;
      const checkout = worktreeContext(checkoutRoot);
      if (!checkout) return "invalid_context";
      if (directory(checkout.worktreePath) !== checkoutRoot) return null;
      expandedCheckouts.add(checkoutRoot);
      const repository = directory(checkout.canonicalProjectRoot);
      if (!repository) return "invalid_context";
      for (const registered of projects) {
        if (typeof registered.workspace_root !== "string" || !path.isAbsolute(registered.workspace_root)) continue;
        const registeredContext = worktreeContext(registered.workspace_root);
        if (!registeredContext || directory(registeredContext.canonicalProjectRoot) !== repository) continue;
        if (!byId.get(registered.project_id)) return "invalid_context";
        const mapped = makeCandidate(registered, checkoutRoot);
        if (!mapped) return "invalid_context";
        addCandidate(mapped, "t3-worktree", registered.project_id);
      }
      return null;
    };
    // A registered workspace can itself be a checkout root, even when the
    // database has no thread history for that checkout yet.
    if (candidates.has(cwd)) {
      const error = expandCheckoutRoot(cwd);
      if (error) return unbound(error);
    }
    let insideUnmatchedWorktree = false;
    const worktreesSql = `WITH worktrees AS MATERIALIZED (${threadSql}) SELECT * FROM worktrees WHERE payload_valid=1 AND worktree_path IS NOT NULL AND worktree_path <> ''`;
    for (const thread of db.prepare(worktreesSql).all()) {
      if (thread.deleted_at) continue;
      const worktree = payloadWorktree(thread);
      if (worktree.invalid || !worktree.path) continue;
      if (!worktreePaths.has(worktree.path)) worktreePaths.set(worktree.path, directory(worktree.path));
      const worktreeRoot = worktreePaths.get(worktree.path);
      if (!worktreeRoot || !isInside(worktreeRoot, cwd)) continue;
      const key = JSON.stringify([thread.project_id, worktreeRoot]);
      if (considered.has(key)) continue;
      considered.add(key);
      const project = byId.get(thread.project_id), root = makeCandidate(project, worktree.path);
      if (!root) {
        // An unrelated historical thread may refer to a project directory
        // absent from this checkout. Ignore it only if its verified repo and
        // relative path prove that it cannot be this exact subproject cwd.
        const workspace = project && directory(project.workspace_root);
        const source = workspace && worktreeContext(workspace);
        const target = cwd !== worktreeRoot && worktreeContext(worktreeRoot);
        const sourceRoot = source && directory(source.worktreePath), targetRoot = target && directory(target.worktreePath);
        const sourceRepo = source && directory(source.canonicalProjectRoot), targetRepo = target && directory(target.canonicalProjectRoot);
        if (sourceRoot && targetRoot && sourceRepo && sourceRepo === targetRepo && isInside(sourceRoot, workspace)) {
          const expected = path.join(targetRoot, path.relative(sourceRoot, workspace));
          if (expected !== cwd) continue;
        }
        return unbound("invalid_context");
      }
      if (cwd === worktreeRoot || cwd === root) addCandidate(root, "t3-worktree", project.project_id);
      else insideUnmatchedWorktree = true;
      // A thread's historical presence proves this checkout exists; it does
      // not prove that its project is the only project selectable there.
      if (cwd === worktreeRoot) {
        const error = expandCheckoutRoot(worktreeRoot);
        if (error) return unbound(error);
      }
    }
    if (!candidates.size) return unbound(insideUnmatchedWorktree ? "cwd_mismatch" : "unmatched");
    if (candidates.size !== 1) return unbound("ambiguous");
    const [projectRoot, candidate] = candidates.entries().next().value;
    // Distinct registered project IDs sharing a directory are still distinct
    // T3 projects; a path alone cannot safely choose between them.
    if (candidate.projectIds.size !== 1) return unbound("ambiguous");
    const result = { projectBound: true, projectRoot, source: candidate.sources.has("t3-workspace") ? "t3-workspace" : "t3-worktree", reason: "matched" };
    result.projectId = candidate.projectIds.values().next().value;
    return result;
  } catch { return unbound("database_unavailable"); }
  finally {
    if (db) {
      try { db.exec("ROLLBACK"); } catch {}
      try { db.close(); } catch {}
    }
  }
}

module.exports = { resolveMemoryProjectContext };
