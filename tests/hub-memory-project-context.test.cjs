"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { resolveMemoryProjectContext } = require("../src/hub-memory-project-context.cjs");

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3-context-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let counter = 0;
function fixture() {
  const dir = path.join(tmp, String(++counter)), dbPath = path.join(dir, "statev2.sqlite");
  const homeDir = path.join(dir, "home"), a = path.join(dir, "project-a"), b = path.join(dir, "project-b");
  for (const value of [dir, homeDir, a, b]) fs.mkdirSync(value, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE projection_projects(project_id TEXT, workspace_root TEXT, deleted_at TEXT); CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT, project_id TEXT, payload_json TEXT, deleted_at TEXT)");
  const project = (id, root, deleted = null) => db.prepare("INSERT INTO projection_projects VALUES(?,?,?)").run(id, root, deleted);
  const thread = (id, pid, worktree = null, deleted = null) => db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?,?)").run(id, pid, JSON.stringify({ worktreePath: worktree }), deleted);
  const resolve = (opts = {}) => resolveMemoryProjectContext({ cwd: a, dbPath, homeDir, t3Home: "", threadId: null, ...opts });
  return { dir, dbPath, homeDir, a, b, db, project, thread, resolve };
}
function git(...args) {
  execFileSync("git", args, { stdio: "ignore", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
}

test("exact registered workspace binds without a project marker or a caller-asserted root", () => {
  const f = fixture(); f.project("A", f.a); f.project("B", f.b);
  assert.deepEqual(f.resolve(), { projectBound: true, projectRoot: f.a, source: "t3-workspace", reason: "matched", projectId: "A" });
  const nested = path.join(f.a, "nested"); fs.mkdirSync(nested);
  assert.equal(f.resolve({ cwd: nested, projectRoot: f.a }).reason, "unmatched");
  assert.equal(f.resolve({ cwd: f.homeDir, projectRoot: f.a }).reason, "invalid_context");
  assert.equal(f.resolve({ cwd: f.b, projectRoot: f.a }).projectRoot, f.b);
  f.db.close();
});

test("a supplied launch thread resolves only that live thread and its project", () => {
  const f = fixture(); f.project("A", f.a); f.project("B", f.b); f.thread("ta", "A"); f.thread("tb", "B"); f.thread("deleted", "A", null, "deleted");
  assert.deepEqual(f.resolve({ threadId: "ta" }), { projectBound: true, projectRoot: f.a, source: "t3-thread", reason: "matched", projectId: "A", threadId: "ta" });
  assert.equal(f.resolve({ threadId: "tb" }).reason, "cwd_mismatch");
  assert.equal(f.resolve({ threadId: "unknown" }).reason, "thread_not_found");
  assert.equal(f.resolve({ threadId: "deleted" }).reason, "thread_not_found");
  f.db.prepare("UPDATE orchestration_v2_projection_threads SET payload_json='broken' WHERE thread_id='ta'").run();
  assert.equal(f.resolve({ threadId: "ta" }).reason, "invalid_context");
  f.db.close();
});

test("large and malformed thread payloads stay in SQLite while only the worktree field is projected", () => {
  const f = fixture(); f.project("A", f.a);
  const raw = JSON.stringify({ worktreePath: f.a, conversation: "PRIVATE_PAYLOAD_FIXTURE".repeat(50000) });
  const insert = f.db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?,NULL)");
  insert.run("large", "A", raw); insert.run("broken", "A", "{broken");
  insert.run("wrong-type", "A", JSON.stringify({ worktreePath: 123 }));
  insert.run("wrong-object", "A", "[]"); insert.run("null-value", "A", JSON.stringify({ worktreePath: null }));
  const originalParse = JSON.parse;
  try {
    JSON.parse = function(value, ...rest) {
      if (typeof value === "string" && value.includes("PRIVATE_PAYLOAD_FIXTURE")) throw new Error("entire payload was read into JS");
      return originalParse.call(this, value, ...rest);
    };
    const plain = f.resolve(), exact = f.resolve({ threadId: "large" });
    assert.equal(plain.projectRoot, f.a); assert.equal(exact.projectRoot, f.a);
    assert.ok(!JSON.stringify({ plain, exact }).includes("PRIVATE_PAYLOAD_FIXTURE"));
    for (const threadId of ["broken", "wrong-type", "wrong-object"]) assert.equal(f.resolve({ threadId }).reason, "invalid_context");
    assert.equal(f.resolve({ threadId: "null-value" }).projectRoot, f.a);
  } finally { JSON.parse = originalParse; f.db.close(); }
});

test("distinct project IDs at the same exact directory are refused even with a thread", () => {
  const f = fixture(); f.project("A", f.a); f.project("B", f.a); f.thread("ta", "A"); f.thread("tb", "B");
  assert.equal(f.resolve().reason, "ambiguous");
  assert.equal(f.resolve({ threadId: "ta" }).reason, "ambiguous");
  assert.equal(f.resolve({ threadId: "tb" }).reason, "ambiguous");
  f.db.close();
});

test("linked Git worktrees map registered subprojects and ambiguous cwd fails closed", () => {
  const f = fixture(), repo = path.join(f.dir, "repo"), linked = path.join(f.dir, "worktree");
  fs.mkdirSync(repo); git("init", "-b", "main", repo);
  for (const name of ["service-a", "service-b"]) { fs.mkdirSync(path.join(repo, name)); fs.writeFileSync(path.join(repo, name, "tracked"), name); }
  git("-C", repo, "add", "."); git("-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture");
  git("-C", repo, "worktree", "add", "-b", "other", linked);
  f.project("A", path.join(repo, "service-a"));
  f.thread("ta", "A", linked); f.thread("ta2", "A", linked);
  const a = path.join(linked, "service-a"), b = path.join(linked, "service-b");
  assert.equal(f.resolve({ cwd: linked }).projectRoot, a);
  assert.equal(f.resolve({ cwd: a }).projectRoot, a);
  assert.equal(f.resolve({ cwd: linked, threadId: "ta" }).projectRoot, a);
  // Project B has no thread at all: its registration still prevents inferring
  // that a checkout-root cwd belongs uniquely to A.
  f.project("B", path.join(repo, "service-b"));
  assert.equal(f.resolve({ cwd: linked }).reason, "ambiguous");
  assert.equal(f.resolve({ cwd: a }).projectRoot, a);
  assert.equal(f.resolve({ cwd: linked, threadId: "ta" }).projectRoot, a);
  f.thread("tb", "B", linked);
  fs.unlinkSync(path.join(b, "tracked")); fs.rmdirSync(b);
  assert.equal(f.resolve({ cwd: a }).projectRoot, a, "a missing unrelated project with thread history must not block an exact subproject cwd");
  assert.equal(f.resolve({ cwd: linked }).reason, "invalid_context");
  fs.mkdirSync(b); fs.writeFileSync(path.join(b, "tracked"), "service-b");
  assert.equal(f.resolve({ cwd: linked }).reason, "ambiguous");
  assert.equal(f.resolve({ cwd: linked, threadId: "ta" }).projectRoot, a);
  assert.equal(f.resolve({ cwd: linked, threadId: "tb" }).projectRoot, b);
  assert.equal(f.resolve({ cwd: a, threadId: "tb" }).reason, "cwd_mismatch");
  assert.equal(f.resolve({ cwd: a }).projectRoot, a);
  const nested = path.join(a, "unregistered"); fs.mkdirSync(nested);
  assert.equal(f.resolve({ cwd: nested }).reason, "cwd_mismatch");
  assert.equal(f.resolve({ cwd: nested, threadId: "ta" }).reason, "cwd_mismatch");
  f.db.close();
});

test("a registered checkout-root project cannot hide a registered nested project without a thread", () => {
  const f = fixture(), repo = path.join(f.dir, "repo"), linked = path.join(f.dir, "worktree");
  fs.mkdirSync(repo); git("init", "-b", "main", repo);
  fs.mkdirSync(path.join(repo, "nested")); fs.writeFileSync(path.join(repo, "nested", "tracked"), "fixture");
  git("-C", repo, "add", "."); git("-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture");
  git("-C", repo, "worktree", "add", "-b", "other", linked);
  f.project("root", repo); f.project("nested", path.join(repo, "nested"));
  assert.equal(f.resolve({ cwd: repo }).reason, "ambiguous", "a registered checkout root is ambiguous even without thread history");
  f.thread("root-thread", "root", linked);
  assert.equal(f.resolve({ cwd: linked }).reason, "ambiguous");
  assert.equal(f.resolve({ cwd: linked, threadId: "root-thread" }).projectRoot, linked);
  assert.equal(f.resolve({ cwd: path.join(linked, "nested") }).reason, "cwd_mismatch");
  f.db.close();
});

test("unverified, deleted and mismatched identities never fall back to another project", () => {
  const f = fixture(); f.project("A", f.a); f.project("B", f.b, "deleted"); f.thread("missing-project", "missing", f.a); f.thread("deleted-project", "B", f.b);
  assert.equal(f.resolve({ threadId: "missing-project" }).reason, "invalid_context");
  assert.equal(f.resolve({ cwd: f.b, threadId: "deleted-project" }).reason, "invalid_context");
  assert.equal(f.resolve({ cwd: f.b }).reason, "invalid_context");
  assert.equal(f.resolve({ threadId: "missing-thread", projectRoot: f.a }).reason, "thread_not_found");
  f.db.close();
});

test("a non-repository or missing linked target never binds using a different project", () => {
  const f = fixture(); f.project("A", f.a); f.thread("bad", "A", f.b);
  assert.equal(f.resolve({ cwd: f.b, threadId: "bad" }).reason, "invalid_context");
  assert.equal(f.resolve({ cwd: f.b }).reason, "invalid_context");
  f.db.close();
});

test("missing, corrupt and schema-incompatible databases fail closed without creating files", () => {
  const f = fixture(); f.db.close();
  const absent = path.join(f.dir, "absent.sqlite");
  assert.equal(f.resolve({ dbPath: absent }).reason, "database_missing");
  assert.equal(fs.existsSync(absent), false);
  const corrupt = path.join(f.dir, "corrupt.sqlite"); fs.writeFileSync(corrupt, "invalid sqlite");
  assert.equal(f.resolve({ dbPath: corrupt }).reason, "database_unavailable");
  const empty = path.join(f.dir, "empty.sqlite"); new DatabaseSync(empty).close();
  assert.equal(f.resolve({ dbPath: empty }).reason, "schema_unavailable");
  assert.equal(fs.readFileSync(corrupt, "utf8"), "invalid sqlite");
});

test("T3CODE_HOME layouts are explicit and two existing databases are ambiguous", () => {
  const f = fixture(); f.project("A", f.a); f.db.close();
  const base = path.join(f.dir, "t3home"), userdata = path.join(base, "userdata"); fs.mkdirSync(userdata, { recursive: true });
  fs.copyFileSync(f.dbPath, path.join(userdata, "statev2.sqlite"));
  const options = { cwd: f.a, homeDir: f.homeDir, t3Home: base, threadId: null };
  assert.equal(resolveMemoryProjectContext(options).projectRoot, f.a);
  fs.copyFileSync(f.dbPath, path.join(base, "statev2.sqlite"));
  assert.equal(resolveMemoryProjectContext(options).reason, "database_ambiguous");
  assert.equal(resolveMemoryProjectContext({ ...options, dbPath: f.dbPath }).projectRoot, f.a);
});

test("an unusable candidate database does not fall through to another layout", () => {
  const f = fixture(); f.project("A", f.a); f.db.close();
  const base = path.join(f.dir, "t3home"), userdata = path.join(base, "userdata"); fs.mkdirSync(userdata, { recursive: true });
  fs.copyFileSync(f.dbPath, path.join(userdata, "statev2.sqlite"));
  fs.mkdirSync(path.join(base, "statev2.sqlite"));
  assert.equal(resolveMemoryProjectContext({ cwd: f.a, homeDir: f.homeDir, t3Home: base, threadId: null }).reason, "database_unavailable");
});

test("the launch thread environment is validated and never replaced with another thread", () => {
  const f = fixture(); f.project("A", f.a); f.thread("ta", "A");
  const previous = process.env.T3CODE_THREAD_ID;
  try {
    process.env.T3CODE_THREAD_ID = "ta";
    assert.equal(resolveMemoryProjectContext({ cwd: f.a, dbPath: f.dbPath, homeDir: f.homeDir, t3Home: "" }).threadId, "ta");
    process.env.T3CODE_THREAD_ID = "missing";
    assert.equal(resolveMemoryProjectContext({ cwd: f.a, dbPath: f.dbPath, homeDir: f.homeDir, t3Home: "" }).reason, "thread_not_found");
  } finally {
    if (previous === undefined) delete process.env.T3CODE_THREAD_ID; else process.env.T3CODE_THREAD_ID = previous;
    f.db.close();
  }
});

test("reads are read-only and repeated threads for one project are not ambiguous", () => {
  const f = fixture(); f.project("A", f.a); f.thread("one", "A"); f.thread("two", "A"); f.db.close();
  const before = fs.readFileSync(f.dbPath);
  assert.equal(f.resolve().projectRoot, f.a);
  assert.deepEqual(fs.readFileSync(f.dbPath), before);
  assert.equal(fs.existsSync(f.dbPath + "-journal"), false);
});
