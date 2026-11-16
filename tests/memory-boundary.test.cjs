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

test("explicit false excludes global in main and linked worktrees for list and search", () => {
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
  const global = v.saveMemory({ scope: "global", module: "pitfalls", title: "fixtureword global", content: "fixtureword global original", autoEvolve: false });
  assert.equal(project.ok, true); assert.equal(global.ok, true);
  for (const query of ["", "fixtureword"]) {
    for (const [root, opts, hasGlobal] of [[main, {}, false], [main, { includeGlobal: false }, false], [main, { includeGlobal: true }, true], [linked, {}, true], [linked, { includeGlobal: false }, false], [linked, { includeGlobal: true }, true], [linked, { scopeFilter: "shared", includeGlobal: true }, false]]) {
      const result = v.listMemories({ projectRoot: root, query, trackHits: false, ...opts });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.items.some((item) => item.id === project.item.id), true);
      assert.equal(result.items.some((item) => item.id === global.item.id), hasGlobal, JSON.stringify({ root, opts, query }));
    }
    const unscoped = v.listMemories({ includeGlobal: false, query, trackHits: false });
    assert.ok(unscoped.items.some((item) => item.id === project.item.id));
    assert.ok(!unscoped.items.some((item) => item.id === global.item.id));
  }
  const md = path.join(dir, "vault", "global", "pitfalls.md");
  fs.writeFileSync(md, fs.readFileSync(md, "utf8").replace("fixtureword global original", "fixtureword global edited"));
  const readIndex = () => { const db = new DatabaseSync(path.join(dir, "vault", "index.sqlite")); try { return db.prepare("SELECT content FROM memories WHERE id=?").get(global.item.id).content; } finally { db.close(); } };
  v.listMemories({ projectRoot: linked, includeGlobal: false });
  assert.match(readIndex(), /original/, "explicit false must not sync global Markdown");
  v.listMemories({ projectRoot: linked, includeGlobal: true, scopeFilter: "shared" });
  assert.match(readIndex(), /original/, "shared-only scope must not sync global Markdown");
  v.listMemories({ projectRoot: linked, includeGlobal: true });
  assert.match(readIndex(), /edited/, "including global must sync its changed Markdown");
});

test("corrupt statistics report a safe failure; a valid empty vault reports zero", () => {
  const dir = path.join(base, "stats"), broken = path.join(dir, "vault");
  fs.mkdirSync(broken, { recursive: true });
  fs.writeFileSync(path.join(broken, "index.sqlite"), "not a database; private example-secret");
  const failure = vault(dir).getStats();
  assert.equal(failure.ok, false);
  assert.match(failure.error, /记忆库|索引/);
  assert.doesNotMatch(failure.error, /example-secret|\/tmp\/|\/Users\//);
  assert.equal(failure.vectorStats, undefined);
  const empty = vault(path.join(base, "empty")).getStats();
  assert.equal(empty.ok, true);
  assert.equal(empty.vectorStats.totalMemories, 0);
  assert.equal(empty.vectorStats.syncedVectors, 0);
});

test("embedding status preserves a statistics error instead of reporting zero", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/backend.cjs"), "utf8");
  const start = source.indexOf('case "embed:status": {'), end = source.indexOf('case "embed:trim":', start);
  assert.ok(start > 0 && end > start);
  const invoke = (stats) => vm.runInNewContext(`(async () => { switch ("embed:status") { ${source.slice(start, end)} } })()`, {
    embedManager: { getStatus: async () => ({ ready: true, vectorStats: { totalMemories: 999 } }) }, memoryVault: { getStats: () => stats }, enrichWithEmbedMetrics: async () => {},
  });
  const bad = await invoke({ ok: false, error: "记忆统计不可用" });
  assert.equal(bad.vectorStatsError, "记忆统计不可用");
  assert.equal(bad.vectorStats, undefined);
  const empty = await invoke({ ok: true, vectorStats: { totalMemories: 0, syncedVectors: 0 } });
  assert.equal(empty.vectorStats.totalMemories, 0);
  assert.equal(empty.vectorStatsError, undefined);
});

test("memory summary distinguishes unavailable statistics from an empty vault", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/hub-drawer-ui.js"), "utf8");
  const start = source.indexOf("    function dreamEngineDraft() {"), end = source.indexOf("    async function saveDreamEngine(", start);
  assert.ok(start > 0 && end > start);
  function render(embed) {
    const target = { innerHTML: "" };
    vm.runInNewContext(`${source.slice(start, end)}; renderDream();`, {
      root: { querySelector: () => target }, cache: { embed, dream: {} }, state: { lang: "zh" }, errors: {},
      dreamConfig: () => ({ dreamMode: "local", enabled: false }), dreamPresets: () => [],
      tr: (zh) => zh, esc: String, icon: () => "", button: () => "", spinner: () => "", exactTimeMarkup: String,
    });
    return target.innerHTML;
  }
  const bad = render({ vectorStatsError: "记忆统计不可用" });
  assert.match(bad, /记忆.*统计.*不可用/);
  assert.doesNotMatch(bad, /0\/0 向量同步/);
  assert.match(render({ vectorStats: { totalMemories: 0, syncedVectors: 0 } }), /0\/0 向量同步/);
  assert.match(render({}), /统计读取中/);
});
