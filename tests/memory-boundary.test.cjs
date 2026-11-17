"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

// The module constructs a default vault on import; isolate even that instance.
const base = fs.mkdtempSync(path.join(os.tmpdir(), "t3-memory-boundary-"));
const vars = ["HOME", "T3_HUB_DIR", "T3_MEMORY_VAULT_DIR"];
const old = Object.fromEntries(vars.map((key) => [key, process.env[key]]));
process.env.HOME = base;
process.env.T3_HUB_DIR = path.join(base, "default-hub");
process.env.T3_MEMORY_VAULT_DIR = path.join(base, "default-vault");
const { createMemoryVault, resolveWorktreeContext } = require("../src/memory-vault.cjs");
for (const key of vars) old[key] === undefined ? delete process.env[key] : process.env[key] = old[key];
process.on("exit", () => fs.rmSync(base, { recursive: true, force: true }));

function vault(dir) {
  return createMemoryVault({ homeDir: base, hubDir: path.join(dir, "hub"), vaultDir: path.join(dir, "vault"), _embedFn: () => null, _healthFn: () => ({ modelId: "fixture", dim: 2 }) });
}

test("project-only reads exclude legacy global data in main and linked worktrees", () => {
  const dir = path.join(base, "worktrees"), main = path.join(dir, "main"), linked = path.join(dir, "linked");
  fs.mkdirSync(main, { recursive: true });
  const git = (...args) => execFileSync("git", args, { stdio: "ignore", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  git("init", "-b", "main", main);
  fs.writeFileSync(path.join(main, "fixture.txt"), "fixture");
  git("-C", main, "add", "fixture.txt");
  git("-C", main, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture");
  git("-C", main, "worktree", "add", "-b", "linked", linked);
  assert.equal(resolveWorktreeContext(main).isLinkedWorktree, false);
  assert.equal(resolveWorktreeContext(linked).isLinkedWorktree, true);
  const v = vault(dir);
  const project = v.saveMemory({ projectRoot: main, scope: "shared", module: "pitfalls", title: "fixtureword project", content: "fixtureword project only", autoEvolve: false });
  assert.equal(project.ok, true);
  v._ensureProjectVault("_global", {});
  const db = new DatabaseSync(path.join(dir, "vault", "index.sqlite"));
  try {
    db.prepare("INSERT INTO memories(id,project_slug,project_root,module,kind,title,content,agent,tags_json,content_hash,created_at,updated_at,memory_scope) VALUES('legacy-global','_global',NULL,'pitfalls','pitfall','fixtureword global','fixtureword global original','legacy','[]','fixture','2026-01-01','2026-01-01','global')").run();
    db.prepare("INSERT INTO memories_fts(id,title,content,tags) VALUES('legacy-global','fixtureword global','fixtureword global original','[]')").run();
  } finally { db.close(); }
  for (const query of ["", "fixtureword"]) {
    for (const root of [main, linked]) for (const opts of [{}, { includeGlobal: false }, { includeGlobal: true }, { scopeFilter: "all" }]) {
      const result = v.listMemories({ projectRoot: root, query, trackHits: false, ...opts });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.deepEqual(result.items.map(item => item.id), [project.item.id]);
    }
    assert.equal(v.listMemories({ query }).ok, false);
  }
  assert.equal(v.listMemories({ projectRoot: main, scopeFilter: "global" }).ok, false);
  assert.equal(v.saveMemory({ projectRoot: main, scope: "global", title: "x", content: "y" }).ok, false);
  const check = new DatabaseSync(path.join(dir, "vault", "index.sqlite"));
  try { assert.equal(check.prepare("SELECT content FROM memories WHERE id='legacy-global'").get().content, "fixtureword global original"); } finally { check.close(); }
});

test("corrupt statistics report a safe failure; a valid empty vault reports zero", () => {
  const dir = path.join(base, "stats"), broken = path.join(dir, "vault");
  fs.mkdirSync(broken, { recursive: true });
  fs.writeFileSync(path.join(broken, "index.sqlite"), "not a database; private example-secret");
  const projectRoot = path.join(dir, "project"); fs.mkdirSync(projectRoot, { recursive: true });
  const failure = vault(dir).getStats({ projectRoot });
  assert.equal(failure.ok, false);
  assert.match(failure.error, /记忆库|索引/);
  assert.doesNotMatch(failure.error, /example-secret|\/tmp\/|\/Users\//);
  assert.equal(failure.vectorStats, undefined);
  const empty = vault(path.join(base, "empty")).getStats({ projectRoot });
  assert.equal(empty.ok, true);
  assert.equal(empty.vectorStats.totalMemories, 0);
  assert.equal(empty.vectorStats.syncedVectors, 0);
});

test("embedding status preserves a statistics error instead of reporting zero", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/backend.cjs"), "utf8");
  const start = source.indexOf('case "embed:status": {'), end = source.indexOf('case "embed:trim":', start);
  assert.ok(start > 0 && end > start);
  const invoke = (stats) => vm.runInNewContext(`(async () => { switch ("embed:status") { ${source.slice(start, end)} } })()`, {
    payload: { projectRoot: "/fixture" }, projectMemoryPayload: input => input, embedManager: { getStatus: async () => ({ ready: true, vectorStats: { totalMemories: 999 } }) }, memoryVault: { getStats: () => stats }, enrichWithEmbedMetrics: async () => {},
  });
  const bad = await invoke({ ok: false, error: "记忆统计不可用" });
  assert.equal(bad.vectorStatsError, "记忆统计不可用");
  assert.equal(bad.vectorStats, undefined);
  const empty = await invoke({ ok: true, vectorStats: { totalMemories: 0, syncedVectors: 0 } });
  assert.equal(empty.vectorStats.totalMemories, 0);
  assert.equal(empty.vectorStatsError, undefined);
});

test("embedding status without a project never reports aggregate memory counts", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/backend.cjs"), "utf8");
  const start = source.indexOf('case "embed:status": {'), end = source.indexOf('case "embed:trim":', start);
  let reads = 0;
  const result = await vm.runInNewContext(`(async () => { switch ("embed:status") { ${source.slice(start, end)} } })()`, {
    payload: {}, projectMemoryPayload: input => input,
    embedManager: { getStatus: async () => ({ running: true, vectorStats: { totalMemories: 999 }, vectorStatsError: "stale" }) },
    memoryVault: { getStats: () => { reads++; return { ok: true }; } }, enrichWithEmbedMetrics: async () => {},
  });
  assert.equal(reads, 0);
  assert.equal(result.running, true);
  assert.equal(result.vectorStats, undefined);
  assert.equal(result.vectorStatsError, undefined);
});
