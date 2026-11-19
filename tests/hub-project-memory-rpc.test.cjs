"use strict";
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hub-project-memory-rpc-")));
const home = path.join(fixture, "home"), project = path.join(fixture, "project");
for (const dir of [home, project]) fs.mkdirSync(dir, { recursive: true });
process.env.HOME = home;
process.env.T3_HUB_DIR = path.join(home, ".t3", "hub");
process.env.T3CODE_HOME = path.join(home, ".t3", "userdata");
process.env.T3_MEMORY_VAULT_DIR = path.join(home, "vault");
process.env.T3_HUB_TEST = "1";
process.env.NODE_ENV = "test";
const originalFetch = global.fetch;
global.fetch = async () => ({ ok: false, status: 503 });
const backend = require("../src/backend.cjs");
const vault = require("../src/memory-vault.cjs");
const embed = require("../src/embed-manager.cjs");
after(() => { global.fetch = originalFetch; fs.rmSync(fixture, { recursive: true, force: true }); });

const actions = ["overview", "list", "search", "write", "save", "worktreeInfo", "promote", "ensureLink", "openFolder", "consolidate", "rollback", "delete", "pinToAgentsMd", "migratePowerContext", "importHostMemories", "health", "stats", "vectorStats", "hygiene"];
test("all memory content RPCs reject missing or unsafe project context before dispatch", async () => {
  for (const action of actions) for (const projectRoot of [undefined, "", ".", home, path.parse(home).root, path.join(fixture, "absent")]) {
    const result = await backend.hubCall("memory:" + action, { projectRoot });
    assert.equal(result.ok, false, action);
    assert.match(result.error, /project_memory_context_required/, action);
  }
});

test("legacy global payload aliases are rejected even with a valid project", async () => {
  for (const action of actions) for (const [key, value] of [["scope", "global"], ["scopeFilter", "global"], ["memory_scope", "global"], ["memoryScope", "global"], ["projectSlug", "_global"]]) {
    const result = await backend.hubCall("memory:" + action, { projectRoot: project, [key]: value });
    assert.equal(result.ok, false, action);
    assert.match(result.error, /global_memory_disabled/, action);
  }
});

test("content reads and ID mutations retain the explicit project and disable global inclusion", async () => {
  const mappings = { list: "listMemories", search: "listMemories", save: "saveMemory", delete: "deleteMemory", promote: "promoteWorktreeMemory", rollback: "rollbackMemory", consolidate: "consolidateMemories", overview: "getOverview", health: "getMemoryHealth" };
  for (const [action, method] of Object.entries(mappings)) {
    const original = vault[method]; let received;
    vault[method] = args => { received = args; return { ok: true }; };
    try {
      const result = await backend.hubCall("memory:" + action, { projectRoot: project, id: "project-record", includeGlobal: true });
      assert.equal(result.ok, true);
      assert.equal(received.projectRoot, project);
      assert.equal(received.includeGlobal, false);
      assert.equal(received.id, "project-record");
    } finally { vault[method] = original; }
  }
});

test("embedding health without a project never requests cross-project memory statistics", async () => {
  const oldStatus = embed.getStatus, oldStats = vault.getStats;
  let calls = 0;
  embed.getStatus = () => ({ ok: true, running: true, vectorStats: { totalMemories: 999 } });
  vault.getStats = args => { calls++; assert.equal(args.projectRoot, project); return { ok: true, vectorStats: { totalMemories: 2 } }; };
  try {
    const service = await backend.hubCall("embed:status", {});
    assert.equal(service.ok, true);
    assert.equal(service.vectorStats, undefined);
    assert.equal(calls, 0);
    const scoped = await backend.hubCall("embed:status", { projectRoot: project });
    assert.equal(scoped.vectorStats.totalMemories, 2);
    assert.equal(calls, 1);
  } finally { embed.getStatus = oldStatus; vault.getStats = oldStats; }
});

test("embedding probe forwards no caller content and does not require memory access", async () => {
  const original = embed.testEmbedding;
  const expected = { ok: true, modelId: "test-model", dimensions: 3, latencyMs: 12 };
  embed.testEmbedding = async (...args) => { assert.deepEqual(args, []); return expected; };
  try {
    assert.deepEqual(await backend.hubCall("embed:test", { text: "must not be forwarded", projectRoot: project }), expected);
  } finally { embed.testEmbedding = original; }
});

test("retired Dream RPCs cannot expose project journals or start cross-project work", async () => {
  const state = await backend.hubCall("memory:dream:get", {});
  assert.equal(state.config.enabled, false);
  assert.equal(state.journal, undefined);
  for (const action of ["save", "update", "run"]) {
    const result = await backend.hubCall("memory:dream:" + action, { enabled: true, projectRoot: project });
    assert.equal(result.ok, false);
    assert.match(result.error, /dream_disabled_project_memory_only/);
  }
});
