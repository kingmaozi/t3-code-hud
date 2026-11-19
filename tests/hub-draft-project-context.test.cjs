"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { DatabaseSync } = require("node:sqlite");
const { execFileSync } = require("node:child_process");

const PROJECT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const THREAD_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const UNKNOWN = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const NO_ROOT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const DELETED = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const ENVIRONMENT = "11111111-1111-4111-8111-111111111111";
const OTHER_ENVIRONMENT = "22222222-2222-4222-8222-222222222222";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-draft-context-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "environment-id"), `${ENVIRONMENT}\n`);
  const dbFile = path.join(dir, "state.sqlite"), db = new DatabaseSync(dbFile);
  db.exec(`CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, project_id TEXT, title TEXT, default_provider TEXT, updated_at TEXT, payload_json TEXT, archived_at TEXT, deleted_at TEXT);
    CREATE TABLE projection_projects (project_id TEXT, title TEXT, workspace_root TEXT, updated_at TEXT, deleted_at TEXT);`);
  db.prepare("INSERT INTO projection_projects VALUES (?,?,?,?,?)").run(PROJECT_A, "Project A", "/tmp/fixture-project-a", "2026-01-02", null);
  db.prepare("INSERT INTO projection_projects VALUES (?,?,?,?,?)").run(PROJECT_B, "Project B", "/tmp/fixture-project-b", "2026-01-01", null);
  db.prepare("INSERT INTO projection_projects VALUES (?,?,?,?,?)").run(NO_ROOT, "Unconfigured", "", "2026-01-01", null);
  db.prepare("INSERT INTO projection_projects VALUES (?,?,?,?,?)").run(DELETED, "Deleted", "/tmp/deleted", "2026-01-01", "2026-01-03");
  db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?,?,?,?,?,?)").run(THREAD_A, PROJECT_A, "Latest A", "codex", "2026-01-02", "{}", null, null);
  db.close();
  const source = fs.readFileSync(path.join(__dirname, "../src/backend.cjs"), "utf8");
  const extract = source.slice(source.indexOf("function extractThreadId("), source.indexOf("function aggregateSingleThreadTelemetry("));
  const helper = source.indexOf("function parseDraftProjectRoute(");
  const context = source.slice(helper >= 0 ? helper : source.indexOf("function resolveHubContext("), source.indexOf("// Bridge helpers for embed health"));
  const sandbox = { fs, path, DatabaseSync, DB_PATH: dbFile, URL, didAutoSyncHosts: false,
    mcpRouter: { autoSyncHosts() {}, listMcpServers: () => ({ items: [] }) },
    hubPlugins: { listPlugins: () => ({ items: [] }) }, hubHooks: { listHooks: () => ({ items: [] }) },
    hubSkills: { listAssets: () => ({ items: [] }) }, hubSubagents: { listSubagents: () => ({ effectiveItems: [] }) },
    memoryVault: {
      getOverview: () => ({ projects: [] }),
      resolveSessionProjectRoot: ({ projectRoot, worktreePath }) => {
        if (worktreePath && (!path.isAbsolute(worktreePath) || !fs.existsSync(worktreePath))) throw new Error("worktree unavailable");
        return worktreePath || projectRoot;
      },
    }, require: () => ({ slugFromProjectRoot: (root) => path.basename(root) }) };
  vm.runInNewContext(`${extract}\n${context}\nthis.resolve = resolveHubContext;`, sandbox);
  sandbox.resolve.dbFile = dbFile;
  return sandbox.resolve;
}

test("explicit project draft routes resolve their own project instead of the most recent thread", (t) => {
  const resolve = fixture(t);
  for (const route of [`/projects/${PROJECT_B}/new`, `/projects/${PROJECT_B.toUpperCase()}/new`, `/projects/${PROJECT_B}/draft/${UNKNOWN}`, `/workspaces/${PROJECT_B}/new`, `/workspaces/${PROJECT_B}/draft`, `t3code://app/#/projects/${PROJECT_B}/new?view=chat`]) {
    const context = resolve({ routeHint: route });
    assert.equal(context.ok, true, `${route}: ${JSON.stringify(context)}`);
    assert.equal(context.projectId, PROJECT_B, route);
    assert.equal(context.projectRoot, "/tmp/fixture-project-b", route);
    assert.equal(context.threadId, "__NEW__", route);
    assert.equal(context.draftProjectVerified, true, route);
  }
  const existing = resolve({ routeHint: `/${ENVIRONMENT}/${THREAD_A}` });
  assert.equal(existing.ok, true);
  assert.equal(existing.threadId, THREAD_A);
  assert.equal(existing.projectId, PROJECT_A);
  assert.equal(existing.projectRoot, "/tmp/fixture-project-a");
  assert.equal(existing.environmentId, ENVIRONMENT);
});

test("a normal thread requires its local environment and never inherits a missing or deleted project's root", (t) => {
  const resolve = fixture(t);
  const mismatched = resolve({ routeHint: `/${OTHER_ENVIRONMENT}/${THREAD_A}` });
  assert.equal(mismatched.ok, false, "a foreign environment must not resolve local data");
  fs.unlinkSync(path.join(path.dirname(resolve.dbFile), "environment-id"));
  assert.equal(resolve({ routeHint: `/${ENVIRONMENT}/${THREAD_A}` }).ok, false, "a missing local identity must fail closed");
  fs.writeFileSync(path.join(path.dirname(resolve.dbFile), "environment-id"), ENVIRONMENT);
  for (const route of [`/${ENVIRONMENT}/${UNKNOWN}`, `/threads/${UNKNOWN}`]) {
    assert.equal(resolve({ routeHint: route }).ok, false, "an unknown explicit thread must not use the latest one");
  }
  const db = new DatabaseSync(resolve.dbFile);
  try {
    db.prepare("UPDATE orchestration_v2_projection_threads SET payload_json=? WHERE thread_id=?").run(JSON.stringify({ worktreePath: "/tmp/fixture-project-b" }), THREAD_A);
    for (const [root, deleted] of [["", null], ["/tmp/fixture-project-a", "2026-01-03"]]) {
      db.prepare("UPDATE projection_projects SET workspace_root=?, deleted_at=? WHERE project_id=?").run(root, deleted, PROJECT_A);
      const context = resolve({ routeHint: `/${ENVIRONMENT}/${THREAD_A}` });
      assert.equal(context.ok, false, "unusable project must not use the latest project");
    }
    db.prepare("DELETE FROM projection_projects WHERE project_id=?").run(PROJECT_A);
    const missing = resolve({ routeHint: `/${ENVIRONMENT}/${THREAD_A}` });
    assert.equal(missing.ok, false, "missing project must not use the latest project");
  } finally { db.close(); }
});

test("a non-UUID thread ID cannot bypass the foreign environment guard", (t) => {
  const resolve = fixture(t);
  const db = new DatabaseSync(resolve.dbFile);
  try {
    db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?,?,?,?,?,?)").run("thread:local", PROJECT_A, "Local", "codex", "2026-01-02", "{}", null, null);
  } finally { db.close(); }
  for (const id of ["thread:local", "thread%3Alocal", "thread%3alocal"]) {
    const remote = resolve({ routeHint: `/${OTHER_ENVIRONMENT}/${id}` });
    assert.equal(remote.ok, false, `${id} must not read a local thread through a remote environment`);
    assert.notEqual(remote.projectRoot, "/tmp/fixture-project-a");
  }
});

test("native routes use a plain string thread ID rather than the environment UUID", (t) => {
  const resolve = fixture(t);
  const db = new DatabaseSync(resolve.dbFile);
  try {
    db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?,?,?,?,?,?)").run("thread-a", PROJECT_A, "Local", "codex", "2026-01-02", "{}", null, null);
  } finally { db.close(); }
  for (const suffix of ["", "?view=chat", "#pane"]) {
    const context = resolve({ routeHint: `/${ENVIRONMENT}/thread-a${suffix}` });
    assert.equal(context.ok, true, `local route with ${suffix || "no suffix"}: ${JSON.stringify(context)}`);
    assert.equal(context.threadId, "thread-a");
    assert.equal(context.projectId, PROJECT_A);
    const remote = resolve({ routeHint: `/${OTHER_ENVIRONMENT}/thread-a${suffix}` });
    assert.equal(remote.ok, false, "a foreign environment must not resolve a matching local thread");
  }
});

test("an unknown environment segment cannot access local threads", (t) => {
  const resolve = fixture(t);
  for (const route of [`/remote-host/${THREAD_A}`, `t3code://app/#/remote-host/${THREAD_A}`]) {
    const context = resolve({ routeHint: route });
    assert.equal(context.ok, false, `${route} must not resolve a local thread`);
    assert.notEqual(context.projectRoot, "/tmp/fixture-project-a");
  }
  const legacy = resolve({ routeHint: `/threads/${THREAD_A}` });
  assert.equal(legacy.ok, true, "the supported legacy thread route remains available");
  assert.equal(legacy.threadId, THREAD_A);
  assert.equal(legacy.projectId, PROJECT_A);
});

test("native thread routes tolerate query strings and fragment suffixes", (t) => {
  const resolve = fixture(t);
  for (const route of [`/${ENVIRONMENT}/${THREAD_A}?view=chat`, `/${ENVIRONMENT}/${THREAD_A}#pane`, `t3code://app/#/${ENVIRONMENT}/${THREAD_A}?view=chat`]) {
    const context = resolve({ routeHint: route });
    assert.equal(context.ok, true, `${route}: ${JSON.stringify(context)}`);
    assert.equal(context.environmentId, ENVIRONMENT);
    assert.equal(context.threadId, THREAD_A);
    assert.equal(context.projectId, PROJECT_A);
  }
  for (const route of [`/${OTHER_ENVIRONMENT}/${THREAD_A}?view=chat`, `/${OTHER_ENVIRONMENT}/${THREAD_A}#pane`, `t3code://app/#/${OTHER_ENVIRONMENT}/${THREAD_A}?view=chat`]) {
    const context = resolve({ routeHint: route });
    assert.equal(context.ok, false, `${route} must not bypass the foreign environment check`);
    assert.notEqual(context.projectRoot, "/tmp/fixture-project-a");
  }
});

test("an unknown or unscoped draft must not inherit a recent project's context", (t) => {
  const resolve = fixture(t);
  for (const route of [`/draft/${PROJECT_B}`, `/draft/${PROJECT_B.toUpperCase()}`, `t3code://app/#/draft/${PROJECT_B}?view=chat`, `/${PROJECT_B}/new`, `/draft/${UNKNOWN}`, `/${UNKNOWN}/new`, `/projects/${UNKNOWN}/new`, `/projects/${NO_ROOT}/new`, `/workspaces/${DELETED}/draft`, `/new/${PROJECT_B}`, "/threads/new", "/draft/new"]) {
    const context = resolve({ routeHint: route });
    assert.equal(context.ok, false, `${route}: ${JSON.stringify(context)}`);
    assert.match(context.error, /无法确认.*项目/);
    assert.notEqual(context.projectId, PROJECT_A);
    assert.notEqual(context.projectRoot, "/tmp/fixture-project-a");
  }
});

test("missing active context never selects the most recently updated thread", (t) => {
  const resolve = fixture(t);
  for (const args of [{}, { routeHint: "/" }, { routeHint: "/settings" }]) {
    assert.equal(resolve(args).ok, false);
  }
});

test("memory context uses the exact current thread worktree and rejects a missing one", (t) => {
  const resolve = fixture(t);
  const root = path.join(path.dirname(resolve.dbFile), "worktree", "selected-subproject");
  fs.mkdirSync(root, { recursive: true });
  const db = new DatabaseSync(resolve.dbFile);
  try {
    db.prepare("UPDATE orchestration_v2_projection_threads SET payload_json=? WHERE thread_id=?").run(JSON.stringify({ worktreePath: root }), THREAD_A);
    assert.equal(resolve({ routeHint: `/${ENVIRONMENT}/${THREAD_A}` }).projectRoot, root);
    fs.rmdirSync(root);
    const missing = resolve({ routeHint: `/${ENVIRONMENT}/${THREAD_A}` });
    assert.equal(missing.ok, false);
    assert.equal(missing.projectRoot, undefined);
  } finally { db.close(); }
});

test("real Hub RPC keeps two projects' drafts isolated across get, update and clear", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-draft-rpc-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home"), userdata = path.join(dir, "userdata"), rootA = path.join(dir, "project-a"), rootB = path.join(dir, "project-b"), resultFile = path.join(dir, "result.json");
  for (const folder of [home, userdata, rootA, rootB]) fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(userdata, "environment-id"), ENVIRONMENT);
  const db = new DatabaseSync(path.join(userdata, "statev2.sqlite"));
  db.exec(`CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, project_id TEXT, title TEXT, default_provider TEXT, updated_at TEXT, payload_json TEXT, archived_at TEXT, deleted_at TEXT);
    CREATE TABLE projection_projects (project_id TEXT, title TEXT, workspace_root TEXT, updated_at TEXT);`);
  db.prepare("INSERT INTO projection_projects VALUES (?,?,?,?)").run(PROJECT_A, "A", rootA, "2026-01-02");
  db.prepare("INSERT INTO projection_projects VALUES (?,?,?,?)").run(PROJECT_B, "B", rootB, "2026-01-01");
  db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?,?,?,?,?,?)").run(THREAD_A, PROJECT_A, "A", "codex", "2026-01-02", "{}", null, null);
  db.close();
  const script = `const fs=require('node:fs'); const backend=require(process.env.TEST_BACKEND);
    const call=(action,payload)=>backend.getGitGraph('__HUB_RPC__',action,payload);
    (async()=>{const a={threadId:'__NEW__',projectRoot:process.env.TEST_ROOT_A};
      await call('board:update',{...a,steps:[{text:'A-only',status:'pending'}]});
      const unverified=await call('hub:getContext',{routeHint:'/draft/'+process.env.TEST_PROJECT_B});
      const ctx=await call('hub:getContext',{routeHint:'/projects/'+process.env.TEST_PROJECT_B+'/new'});
      const b={threadId:ctx.threadId,projectRoot:ctx.projectRoot,strictThreadMatch:true};
      const before=await call('board:get',b);
      await call('board:update',{...b,steps:[{text:'B-only',status:'pending'}]});
      const afterA=await call('board:get',{...a,strictThreadMatch:true});
      const afterB=await call('board:get',b);
      await call('board:clear',b);
      const finalA=await call('board:get',{...a,strictThreadMatch:true});
      fs.writeFileSync(process.env.TEST_OUTPUT,JSON.stringify({unverified,ctx,before,afterA,afterB,finalA}));
    })().catch(e=>{console.error(e.message);process.exitCode=1});`;
  const env = { ...process.env, HOME: home, T3CODE_HOME: userdata, T3_HUB_DIR: path.join(home, ".t3", "hub"), T3_MEMORY_VAULT_DIR: path.join(home, "vault"), T3_DISABLE_DREAM_SCHEDULER: "1", T3_EMBED_URL: "http://127.0.0.1:1/v1/embeddings", TEST_BACKEND: path.resolve(__dirname, "../src/backend.cjs"), TEST_ROOT_A: rootA, TEST_PROJECT_B: PROJECT_B, TEST_OUTPUT: resultFile };
  execFileSync(process.execPath, ["-e", script], { env, stdio: "pipe", timeout: 30000 });
  const result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  assert.equal(result.unverified.ok, false, "a draft ID matching a project ID is not proof of ownership");
  assert.equal(result.ctx.projectId, PROJECT_B);
  assert.equal(result.ctx.projectRoot, rootB);
  assert.equal(result.ctx.threadId, "__NEW__");
  assert.equal(result.before.steps.length, 0);
  assert.equal(result.afterA.steps[0].text, "A-only");
  assert.equal(result.afterB.steps[0].text, "B-only");
  assert.equal(result.finalA.steps[0].text, "A-only");
});
