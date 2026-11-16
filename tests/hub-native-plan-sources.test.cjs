"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createTaskBoard } = require("../src/hub-task-board.cjs");

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-native-plan-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const projectA = path.join(dir, "project-a"), projectB = path.join(dir, "project-b");
  fs.mkdirSync(projectA); fs.mkdirSync(projectB);
  const brain = path.join(dir, "brain"), plans = path.join(dir, "hub-plans");
  const dbFile = path.join(dir, "statev2.sqlite");
  const db = new DatabaseSync(dbFile);
  db.exec(`
    CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, workspace_root TEXT, deleted_at TEXT);
    CREATE TABLE orchestration_v2_projection_threads (
      thread_id TEXT PRIMARY KEY, project_id TEXT, title TEXT, created_at TEXT,
      updated_at TEXT, deleted_at TEXT, payload_json TEXT
    );
    CREATE TABLE orchestration_v2_projection_plans (
      plan_id TEXT PRIMARY KEY, thread_id TEXT, run_id TEXT, node_id TEXT,
      kind TEXT, status TEXT, payload_json TEXT
    );
    CREATE TABLE orchestration_v2_projection_turn_items (
      turn_item_id TEXT PRIMARY KEY, thread_id TEXT, ordinal INTEGER,
      type TEXT, updated_at TEXT, payload_json TEXT
    );
    CREATE TABLE orchestration_v2_projection_subagents (
      subagent_id TEXT PRIMARY KEY, thread_id TEXT, status TEXT,
      started_at TEXT, updated_at TEXT, payload_json TEXT
    );
  `);
  db.prepare("INSERT INTO projection_projects VALUES (?, ?, NULL)").run("p-a", projectA);
  db.prepare("INSERT INTO projection_projects VALUES (?, ?, NULL)").run("p-b", projectB);
  for (const [tid, pid] of [["thread-a", "p-a"], ["thread-b", "p-b"]]) {
    db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, ?, ?, ?, NULL, ?)")
      .run(tid, pid, tid, "2026-11-15T00:00:00Z", "2026-11-16T00:00:00Z", "{}");
  }
  let nowMs = Date.parse("2026-11-16T11:00:00.000Z");
  const board = createTaskBoard({ homeDir: dir, t3DbPath: dbFile, agyBrainDirs: [brain], hubPlansDir: plans, now: () => nowMs });
  return {
    db, board, brain, projectA, projectB, dbFile, dir,
    setNow(value) { nowMs = Date.parse(value); },
    snapshot(threadId = "thread-a", root = projectA) {
      return board.getBoardSnapshot({ threadId, projectRoot: root, strictThreadMatch: true, excludeSubagentInference: true });
    },
    plan({ id, threadId = "thread-a", kind = "todo_list", status = "active", payload, itemAt, itemThread = threadId }) {
      const data = { id, threadId, kind, status, ...payload };
      db.prepare("INSERT INTO orchestration_v2_projection_plans VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, threadId, "run", "node", kind, status, JSON.stringify(data));
      if (itemAt) db.prepare("INSERT INTO orchestration_v2_projection_turn_items VALUES (?, ?, ?, ?, ?, ?)")
        .run("item-" + id + "-" + itemThread, itemThread, 1, kind, itemAt, JSON.stringify({ planId: id, threadId: itemThread, type: kind }));
    },
  };
}

test("native todo lists use matching turn-item update times when choosing among plans and Hub", t => {
  const f = fixture(t);
  f.plan({ id: "updated-first-row", payload: { steps: [{ id: "s", text: "native recent", status: "running" }] }, itemAt: "2026-11-16T12:00:00.000Z" });
  f.plan({ id: "older-last-row", payload: { steps: [{ id: "s", text: "native old", status: "completed" }] }, itemAt: "2026-11-16T10:00:00.000Z" });
  f.board.updatePlan({ threadId: "thread-a", projectRoot: f.projectA, steps: [{ text: "hub middle", status: "pending" }] });
  const native = f.snapshot();
  assert.equal(native.source, "t3-native");
  assert.equal(native.steps[0].text, "native recent");
  assert.equal(native.steps[0].status, "in_progress");
  assert.equal(native.updatedAt, "2026-11-16T12:00:00.000Z");
  assert.equal(native.progressKnown, true);
  f.setNow("2026-11-16T13:00:00.000Z");
  f.board.updatePlan({ threadId: "thread-a", projectRoot: f.projectA, steps: [{ text: "hub newer", status: "completed" }] });
  const hub = f.snapshot();
  assert.equal(hub.source, "hub-mcp");
  assert.equal(hub.steps[0].text, "hub newer");
  f.db.close();
});

test("ACP/Codex projected proposed_plan returns exact markdown without inventing completion", t => {
  const f = fixture(t);
  const markdown = "# Planned approach\n\n- review\n- implement\n\n<script>text only</script>";
  f.plan({ id: "proposed", kind: "proposed_plan", payload: { markdown }, itemAt: "2026-11-16T12:00:00.000Z" });
  const board = f.snapshot();
  assert.equal(board.source, "t3-native");
  assert.equal(board.planMarkdown, markdown);
  assert.deepEqual(board.steps, []);
  assert.equal(board.progressKnown, false);
  assert.equal(board.progress.total, 0);
  assert.equal(board.emptyPlanReason, undefined);
  f.db.close();
});

test("proposed plan participates in source freshness in both directions", t => {
  const f = fixture(t);
  f.plan({ id: "proposed", kind: "proposed_plan", payload: { markdown: "Native plan" }, itemAt: "2026-11-16T12:00:00.000Z" });
  f.board.updatePlan({ threadId: "thread-a", projectRoot: f.projectA, steps: [{ text: "Older hub", status: "pending" }] });
  assert.equal(f.snapshot().planMarkdown, "Native plan");
  f.setNow("2026-11-16T13:00:00.000Z");
  f.board.updatePlan({ threadId: "thread-a", projectRoot: f.projectA, steps: [{ text: "Newer hub", status: "pending" }] });
  const later = f.snapshot();
  assert.equal(later.source, "hub-mcp");
  assert.equal(later.steps[0].text, "Newer hub");
  assert.equal(later.planMarkdown, "");
  f.db.close();
});

test("superseded plans do not resurrect; absent plan retains real subagent results", t => {
  const f = fixture(t);
  f.plan({ id: "removed", kind: "proposed_plan", status: "superseded", payload: { markdown: "Removed plan" }, itemAt: "2026-11-16T12:00:00.000Z" });
  for (const [i, status] of ["completed", "failed", "cancelled", "interrupted", "running"].entries()) {
    f.db.prepare("INSERT INTO orchestration_v2_projection_subagents VALUES (?, ?, ?, ?, ?, ?)")
      .run("sub-" + i, "thread-a", status, "2026-11-16T11:00:00Z", "2026-11-16T12:00:00Z", "{}");
  }
  const board = f.snapshot();
  assert.equal(board.emptyPlanReason, "no_explicit_plan");
  assert.equal(board.planMarkdown, "");
  assert.deepEqual(board.steps, []);
  assert.equal(board.progressKnown, false);
  assert.deepEqual(board.subagents.map(s => s.rawStatus).sort(), ["cancelled", "completed", "failed", "interrupted", "running"]);
  f.db.close();
});

test("native plan content never crosses known, missing, or draft project ownership", t => {
  const f = fixture(t);
  f.plan({ id: "private-plan", kind: "proposed_plan", payload: { markdown: "project A only" }, itemAt: "2026-11-16T12:00:00.000Z" });
  const wrong = f.snapshot("thread-a", f.projectB);
  assert.equal(wrong.artifactScopeError, "mismatch");
  assert.equal(wrong.planMarkdown, "");
  assert.deepEqual(wrong.steps, []);
  const absent = f.snapshot("thread-missing", f.projectA);
  assert.equal(absent.artifactScopeError, "unknown");
  assert.equal(absent.planMarkdown, "");
  const draft = f.snapshot("__NEW__", f.projectA);
  assert.equal(draft.planMarkdown, "");
  assert.deepEqual(draft.steps, []);
  assert.equal(f.snapshot().planMarkdown, "project A only");
  f.db.close();
});

test("turn-item freshness must match both plan ID and exact thread", t => {
  const f = fixture(t);
  f.plan({ id: "plan-a", payload: { updatedAt: "2026-11-16T10:00:00Z", steps: [{ text: "A", status: "pending" }] }, itemAt: "2026-11-16T15:00:00Z", itemThread: "thread-b" });
  f.board.updatePlan({ threadId: "thread-a", projectRoot: f.projectA, steps: [{ text: "Hub A", status: "pending" }] });
  const board = f.snapshot();
  assert.equal(board.source, "hub-mcp");
  assert.equal(board.steps[0].text, "Hub A");
  f.db.close();
});

test("native and AGY task file compete by their actual modification times", t => {
  const f = fixture(t);
  const session = path.join(f.brain, "thread-a");
  fs.mkdirSync(session, { recursive: true });
  const task = path.join(session, "task.md");
  fs.writeFileSync(task, "# Local plan\n- [ ] AGY task\n");
  fs.utimesSync(task, new Date("2026-11-16T10:00:00Z"), new Date("2026-11-16T10:00:00Z"));
  f.plan({ id: "plan-a", payload: { steps: [{ text: "Native task", status: "pending" }] }, itemAt: "2026-11-16T12:00:00Z" });
  assert.equal(f.snapshot().steps[0].text, "Native task");
  fs.utimesSync(task, new Date("2026-11-16T13:00:00Z"), new Date("2026-11-16T13:00:00Z"));
  const later = f.snapshot();
  assert.equal(later.source, "agy-brain");
  assert.equal(later.steps[0].text, "AGY task");
  f.db.close();
});

test("a malformed unrelated turn item does not hide a valid native plan", t => {
  const f = fixture(t);
  f.plan({ id: "plan-a", payload: { steps: [{ text: "Plan survives", status: "pending" }] }, itemAt: "2026-11-16T12:00:00Z" });
  f.db.prepare("INSERT INTO orchestration_v2_projection_turn_items VALUES (?, ?, ?, ?, ?, ?)")
    .run("broken", "thread-a", 2, "todo_list", "2026-11-16T13:00:00Z", "{broken");
  const board = f.snapshot();
  assert.equal(board.steps[0].text, "Plan survives");
  assert.equal(board.updatedAt, "2026-11-16T12:00:00Z");
  f.db.close();
});

test("removing one native plan leaves independently active plans and labels completed history", t => {
  const f = fixture(t);
  f.plan({ id: "finished", kind: "proposed_plan", status: "completed", payload: { markdown: "Finished plan" }, itemAt: "2026-11-16T10:00:00Z" });
  f.plan({ id: "removed", kind: "proposed_plan", status: "superseded", payload: { markdown: "Removed plan" }, itemAt: "2026-11-16T12:00:00Z" });
  let board = f.snapshot();
  assert.equal(board.planMarkdown, "Finished plan");
  assert.equal(board.planStatus, "completed");
  assert.equal(board.updatedAt, "2026-11-16T10:00:00Z");
  f.plan({ id: "active", kind: "proposed_plan", status: "active", payload: { markdown: "Still active" }, itemAt: "2026-11-16T11:00:00Z" });
  board = f.snapshot();
  assert.equal(board.planMarkdown, "Still active");
  assert.equal(board.planStatus, "active");
  assert.equal(board.updatedAt, "2026-11-16T11:00:00Z");
  f.db.close();
});

test("AGY implementation-only plan is read from the verified exact native session", t => {
  const f = fixture(t);
  f.db.exec("CREATE TABLE orchestration_v2_projection_provider_threads (thread_id TEXT, provider_session_id TEXT, payload_json TEXT)");
  f.db.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, ?)")
    .run("thread-a", "session", JSON.stringify({ nativeThreadRef: { nativeId: "native-session-a" } }));
  const session = path.join(f.brain, "native-session-a"); fs.mkdirSync(session, { recursive: true });
  const file = path.join(session, "implementation_plan.md");
  fs.writeFileSync(file, "# Actual implementation plan\n\nFirst verify; then deliver.\n");
  fs.utimesSync(file, new Date("2026-11-16T12:00:00Z"), new Date("2026-11-16T12:00:00Z"));
  const board = f.snapshot();
  assert.equal(board.source, "agy-brain");
  assert.equal(board.planMarkdown, "# Actual implementation plan\n\nFirst verify; then deliver.\n");
  assert.equal(board.progressKnown, false);
  assert.equal(board.emptyPlanReason, undefined);
  assert.equal(board.updatedAt, "2026-11-16T12:00:00.000Z");
  assert.ok(board.artifacts.some(a => a.name === "implementation_plan.md"));
  assert.equal(f.snapshot("thread-a", f.projectB).planMarkdown, "");
  assert.equal(f.snapshot("thread-b", f.projectB).planMarkdown, "");
  f.db.close();
});

test("AGY implementation plan cannot escape its session through a symlink", t => {
  const f = fixture(t);
  const session = path.join(f.brain, "thread-a"); fs.mkdirSync(session, { recursive: true });
  const secret = path.join(f.projectB, "foreign.md"); fs.writeFileSync(secret, "foreign private data");
  fs.symlinkSync(secret, path.join(session, "implementation_plan.md"));
  const board = f.snapshot();
  assert.equal(board.planMarkdown, "");
  assert.equal(board.planReadError, "unsafe_path");
  assert.equal(board.progressKnown, false);
  f.db.close();
});

test("AGY implementation plan over the size limit is reported rather than read", t => {
  const f = fixture(t);
  const session = path.join(f.brain, "thread-a"); fs.mkdirSync(session, { recursive: true });
  fs.writeFileSync(path.join(session, "implementation_plan.md"), Buffer.alloc(512 * 1024 + 1, 65));
  const board = f.snapshot();
  assert.equal(board.planMarkdown, "");
  assert.equal(board.planReadError, "too_large");
  assert.equal(board.progressKnown, false);
  assert.ok(board.artifacts.some(a => a.name === "implementation_plan.md"));
  f.db.close();
});

test("a linked AGY session directory is not used to discover a plan", t => {
  const f = fixture(t);
  fs.mkdirSync(f.brain, { recursive: true });
  fs.writeFileSync(path.join(f.projectB, "implementation_plan.md"), "foreign plan");
  fs.symlinkSync(f.projectB, path.join(f.brain, "thread-a"));
  const board = f.snapshot();
  assert.equal(board.planMarkdown, "");
  assert.equal(board.emptyPlanReason, "no_explicit_plan");
  f.db.close();
});

test("AGY task checklist cannot escape its session through a symlink", t => {
  const f = fixture(t);
  const session = path.join(f.brain, "thread-a"); fs.mkdirSync(session, { recursive: true });
  const foreign = path.join(f.projectB, "foreign-task.md");
  fs.writeFileSync(foreign, "# Outside\n- [ ] foreign private task\n");
  fs.symlinkSync(foreign, path.join(session, "task.md"));
  const board = f.snapshot();
  assert.deepEqual(board.steps, []);
  assert.equal(board.planReadError, "unsafe_path");
  f.db.close();
});

test("AGY task checklist over the size limit is reported rather than read", t => {
  const f = fixture(t);
  const session = path.join(f.brain, "thread-a"); fs.mkdirSync(session, { recursive: true });
  fs.writeFileSync(path.join(session, "task.md"), Buffer.alloc(512 * 1024 + 1, 65));
  const board = f.snapshot();
  assert.deepEqual(board.steps, []);
  assert.equal(board.planReadError, "too_large");
  assert.equal(board.progressKnown, false);
  f.db.close();
});

for (const name of ["task.md", "implementation_plan.md"]) {
  test(`broken AGY ${name} symlink reports an unsafe path`, t => {
    const f = fixture(t);
    const session = path.join(f.brain, "thread-a"); fs.mkdirSync(session, { recursive: true });
    fs.symlinkSync(path.join(f.projectB, "missing.md"), path.join(session, name));
    const board = f.snapshot();
    assert.equal(board.planReadError, "unsafe_path");
    assert.equal(board.emptyPlanReason, undefined);
    assert.deepEqual(board.steps, []);
    f.db.close();
  });
}

test("a named pipe at the AGY plan path cannot block the board", t => {
  const { spawnSync } = require("node:child_process");
  const f = fixture(t);
  const session = path.join(f.brain, "thread-a"); fs.mkdirSync(session, { recursive: true });
  const made = spawnSync("mkfifo", [path.join(session, "task.md")]);
  assert.equal(made.status, 0);
  const code = `const {createTaskBoard}=require(${JSON.stringify(path.resolve("src/hub-task-board.cjs"))});
    const b=createTaskBoard(${JSON.stringify({ homeDir: f.dir, t3DbPath: f.dbFile, agyBrainDirs: [f.brain], hubPlansDir: path.join(f.dir, "hub-plans") })});
    const v=b.getBoardSnapshot(${JSON.stringify({ threadId: "thread-a", projectRoot: f.projectA, strictThreadMatch: true, excludeSubagentInference: true })});
    process.stdout.write(v.planReadError || "missing");`;
  const result = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", timeout: 1200 });
  assert.equal(result.error, undefined, "the plan read must not block");
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "unreadable");
  f.db.close();
});

test("multiple verified native IDs and brain roots select the newest AGY plan", t => {
  const f = fixture(t);
  f.db.exec("CREATE TABLE orchestration_v2_projection_provider_threads (thread_id TEXT, provider_session_id TEXT, payload_json TEXT)");
  for (const id of ["native-old", "native-new"]) {
    f.db.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, ?)")
      .run("thread-a", id, JSON.stringify({ nativeThreadRef: { nativeId: id } }));
  }
  const second = path.join(f.dir, "second-brain");
  for (const [root, id, text, time] of [
    [f.brain, "native-old", "Older plan", "2026-11-16T10:00:00Z"],
    [second, "native-new", "Newer plan", "2026-11-16T13:00:00Z"],
  ]) {
    const dir = path.join(root, id); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "implementation_plan.md"); fs.writeFileSync(file, text);
    fs.utimesSync(file, new Date(time), new Date(time));
  }
  const board = createTaskBoard({ homeDir: f.dir, t3DbPath: f.dbFile, agyBrainDirs: [f.brain, second], hubPlansDir: path.join(f.dir, "hub-plans") });
  const query = { threadId: "thread-a", projectRoot: f.projectA, strictThreadMatch: true, excludeSubagentInference: true };
  const snap = board.getBoardSnapshot(query);
  assert.equal(snap.planMarkdown, "Newer plan");
  assert.equal(snap.updatedAt, "2026-11-16T13:00:00.000Z");
  assert.equal(snap.artifacts.length, 2);
  assert.equal(board.getBoardSnapshot({ ...query, projectRoot: f.projectB }).planMarkdown, "");
  f.db.close();
});

test("a newer AGY implementation plan is not hidden by an older task checklist", t => {
  const f = fixture(t), session = path.join(f.brain, "thread-a"); fs.mkdirSync(session, { recursive: true });
  const task = path.join(session, "task.md"), plan = path.join(session, "implementation_plan.md");
  fs.writeFileSync(task, "# Older checklist\n- [ ] prior task\n"); fs.writeFileSync(plan, "Current implementation plan");
  fs.utimesSync(task, new Date("2026-11-16T10:00:00Z"), new Date("2026-11-16T10:00:00Z"));
  fs.utimesSync(plan, new Date("2026-11-16T13:00:00Z"), new Date("2026-11-16T13:00:00Z"));
  const board = f.snapshot();
  assert.equal(board.planMarkdown, "Current implementation plan");
  assert.deepEqual(board.steps, []);
  assert.equal(board.progressKnown, false);
  f.db.close();
});

test("a newer unreadable AGY plan keeps its timestamp and is not hidden by an older native plan", t => {
  const f = fixture(t), session = path.join(f.brain, "thread-a"); fs.mkdirSync(session, { recursive: true });
  const plan = path.join(session, "implementation_plan.md");
  fs.writeFileSync(plan, "synthetic inaccessible plan");
  fs.utimesSync(plan, new Date("2026-11-16T13:00:00Z"), new Date("2026-11-16T13:00:00Z"));
  fs.chmodSync(plan, 0o000);
  if (process.getuid?.() === 0) { t.skip("requires a non-root user to exercise EACCES"); f.db.close(); return; }
  f.plan({ id: "older-native", payload: { steps: [{ text: "Old plan", status: "pending" }] }, itemAt: "2026-11-16T10:00:00Z" });
  const board = f.snapshot();
  assert.equal(board.source, "agy-brain");
  assert.equal(board.planReadError, "unreadable");
  assert.equal(board.updatedAt, "2026-11-16T13:00:00.000Z");
  assert.deepEqual(board.steps, []);
  assert.equal(board.progressKnown, false);
  f.db.close();
});

test("a replaced verified session directory cannot publish another directory's plan or artifact metadata", t => {
  const f = fixture(t);
  const session = path.join(f.brain, "thread-a"), saved = path.join(f.brain, "saved-thread-a");
  fs.mkdirSync(session, { recursive: true });
  fs.writeFileSync(path.join(session, "implementation_plan.md"), "Owned plan");
  fs.writeFileSync(path.join(f.projectB, "implementation_plan.md"), "Other project plan");
  fs.writeFileSync(path.join(f.projectB, "implementation_plan.md.metadata.json"), JSON.stringify({ userFacing: true, summary: "Other project metadata" }));
  const original = fs.readdirSync;
  let replaced = false, board;
  fs.readdirSync = function (dir, ...args) {
    if (dir === session && !replaced) {
      replaced = true;
      fs.renameSync(session, saved);
      fs.symlinkSync(f.projectB, session);
    }
    return original.call(this, dir, ...args);
  };
  try { board = f.snapshot(); }
  finally { fs.readdirSync = original; }
  assert.equal(replaced, true);
  assert.equal(board.planReadError, "unsafe_path");
  assert.equal(board.planMarkdown, "");
  assert.deepEqual(board.steps, []);
  assert.deepEqual(board.artifacts, []);
  f.db.close();
});
