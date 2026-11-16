"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createMemoryVault } = require("../src/memory-vault.cjs");

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "hub-dream-runtime-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const homeDir = path.join(base, "home"), hubDir = path.join(base, "hub"), vaultDir = path.join(base, "vault"), projectRoot = path.join(base, "project"), bin = path.join(base, "bin");
  for (const dir of [homeDir, hubDir, vaultDir, projectRoot, bin]) fs.mkdirSync(dir, { recursive: true });
  const vault = createMemoryVault({ homeDir, hubDir, vaultDir, _dreamPath: bin, _embedFn: () => null, _healthFn: () => ({ modelId: "test", dim: 2 }) });
  return { base, homeDir, hubDir, vaultDir, projectRoot, bin, vault };
}
function fakeCli(f, name, body) {
  const file = path.join(f.bin, name);
  fs.writeFileSync(file, "#!/bin/sh\n" + body + "\n", { mode: 0o755 });
  return file;
}
function seedGray(f) {
  const ids = [
    ["different title alpha", "w1 w2 w3 w4 w5 w6 w7 w8 x9 x10 x11 x12"],
    ["unrelated title beta", "w1 w2 w3 w4 w5 w6 w7 w8 y9 y10 y11 y12"],
  ].map(([title, content]) => {
    const r = f.vault.saveMemory({ projectRoot: f.projectRoot, module: "topics", title, content, autoEvolve: false });
    assert.equal(r.ok, true); return r.item.id;
  });
  const db = new DatabaseSync(path.join(f.vaultDir, "index.sqlite"));
  try {
    const stmt = db.prepare("INSERT OR REPLACE INTO memory_vectors(id, model_id, dim, vec_f32, updated_at) VALUES (?,?,?,?,?)");
    stmt.run(ids[0], "test", 2, Buffer.from(new Float32Array([1, 0]).buffer), new Date().toISOString());
    stmt.run(ids[1], "test", 2, Buffer.from(new Float32Array([0.8, 0.6]).buffer), new Date().toISOString());
  } finally { db.close(); }
  return ids;
}

test("capability and schedule status use static checks without launching a CLI", t => {
  const f = fixture(t), touched = path.join(f.base, "started");
  fakeCli(f, "muse", `: > ${JSON.stringify(touched)}\nexit 1`);
  const overview = f.vault.getDreamOverview();
  assert.ok(overview.config && Array.isArray(overview.presets) && Array.isArray(overview.journal));
  assert.equal(overview.runtime.providers.find(p => p.id === "muse").status, "available");
  assert.ok(overview.runtime.providers.find(p => p.id === "muse").efforts.includes("max"));
  assert.equal(overview.runtime.providers.find(p => p.id === "antigravity").status, "unsupported");
  assert.equal(overview.runtime.providers.find(p => p.id === "codex").status, "unsupported");
  assert.equal(overview.runtime.scheduler.requiresHubActive, true);
  assert.equal(typeof overview.runtime.scheduler.timeZone, "string");
  assert.ok(overview.runtime.scheduler.nextDueAt === null || !Number.isNaN(Date.parse(overview.runtime.scheduler.nextDueAt)));
  assert.equal(fs.existsSync(touched), false);
});

test("existing AGY setting stays visible but fails before any runner call", async t => {
  const f = fixture(t); f.vault.getDreamState();
  const configFile = path.join(f.hubDir, "dream-config.json"), config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  Object.assign(config, { dreamMode: "agent", providerInstanceId: "antigravity", model: "carbon", reasoningEffort: "high" });
  fs.writeFileSync(configFile, JSON.stringify(config));
  const saved = f.vault.updateDreamConfig({ dreamTime: "03:30" });
  assert.equal(saved.ok, true); assert.equal(saved.config.providerInstanceId, "antigravity");
  assert.equal(f.vault.getDreamOverview().runtime.selected.status, "unsupported");
  let called = false;
  const result = await f.vault.runDreamCycle({ force: true, agentRunner: () => { called = true; return { merges: [] }; } });
  assert.equal(result.ok, false);
  assert.equal(result.report.agent.status, "failed");
  assert.equal(result.report.agent.error, "unsupported-provider");
  assert.equal(called, false);
});

test("Muse receives the selected model and effort through noninteractive stub CLI", async t => {
  const f = fixture(t), argsFile = path.join(f.base, "args"), promptFile = path.join(f.base, "prompt");
  fakeCli(f, "muse", `printf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\nwhile [ "$#" -gt 0 ]; do if [ "$1" = '--prompt-file' ]; then shift; cat "$1" > ${JSON.stringify(promptFile)}; break; fi; shift; done\nprintf '%s\\n' '{"merges":[]}'`);
  seedGray(f);
  const up = f.vault.updateDreamConfig({ dreamMode: "agent", providerInstanceId: "muse", model: "muse-ember-1.0", reasoningEffort: "max", minDeltaMemories: 1 });
  assert.equal(up.ok, true);
  const result = await f.vault.runDreamCycle({ force: true, projectRoot: f.projectRoot });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.report.agent.status, "success");
  const args = fs.readFileSync(argsFile, "utf8").trim().split("\n");
  assert.equal(args[0], "exec");
  assert.equal(args[args.indexOf("--model") + 1], "muse-ember-1.0");
  assert.equal(args[args.indexOf("--reasoning-effort") + 1], "max");
  assert.ok(args.includes("--disable-write") && args.includes("--disable-shell"));
  assert.ok(fs.readFileSync(promptFile, "utf8").includes("merges"));
});

test("agent failure preserves successful local result and does not publish stderr secrets", async t => {
  const f = fixture(t);
  fakeCli(f, "muse", "cat >/dev/null\nprintf '%s\\n' 'access_token=EXAMPLE_SECRET_VALUE' >&2\nexit 7");
  seedGray(f);
  assert.equal(f.vault.updateDreamConfig({ dreamMode: "agent", providerInstanceId: "muse", model: "muse-ember-1.0", minDeltaMemories: 1 }).ok, true);
  const result = await f.vault.runDreamCycle({ force: true, projectRoot: f.projectRoot, now: new Date(2026, 10, 16, 3, 30) });
  assert.equal(result.ok, false);
  assert.equal(result.status, "partial");
  assert.equal(result.report.local.status, "success");
  assert.equal(result.report.agent.status, "failed");
  assert.match(result.report.agent.error, /^cli-exit/);
  assert.equal(result.config.hasDeferredClusters, true);
  assert.equal(result.config.lastAgentDreamAt ?? null, null);
  const state = f.vault.getDreamOverview();
  assert.equal(state.config.lastReport.agent.status, "failed");
  assert.ok(!JSON.stringify(state).includes("EXAMPLE_SECRET_VALUE"));
});

test("no new memory skips the model and does not fabricate an agent run", async t => {
  const f = fixture(t); let called = false;
  assert.equal(f.vault.updateDreamConfig({ dreamMode: "agent", providerInstanceId: "muse", minDeltaMemories: 3 }).ok, true);
  const result = await f.vault.runDreamCycle({ agentRunner: () => { called = true; return { merges: [] }; } });
  assert.equal(result.ok, true);
  assert.equal(result.report.agent.status, "skipped");
  assert.equal(result.report.agent.reason, "gate-skip-delta");
  assert.equal(result.report.local.status, "success");
  assert.equal(called, false);
});

for (const [provider, model, effort] of [
  ["codex", "gpt-6.1-terra", "high"],
  ["claude", "claude-sonnet-4-6", "xhigh"],
  ["pi", "magpie/group/code", "max"],
]) {
  test(`${provider} is unsupported without running even an installed stub`, async t => {
    const f = fixture(t), touched = path.join(f.base, "started");
    fakeCli(f, provider, `: > ${JSON.stringify(touched)}\nexit 0`);
    f.vault.getDreamState();
    assert.equal(f.vault.getDreamOverview().runtime.providers.find(p => p.id === provider).reason, "adapter-unverified");
    assert.equal(f.vault.updateDreamConfig({ dreamMode: "agent", providerInstanceId: provider, model, reasoningEffort: effort }).ok, false);
    const file = path.join(f.hubDir, "dream-config.json"), raw = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...raw, dreamMode: "agent", providerInstanceId: provider, model, reasoningEffort: effort }));
    const saved = f.vault.updateDreamConfig({ dreamTime: "04:30" });
    assert.equal(saved.ok, true);
    assert.equal(saved.config.providerInstanceId, provider);
    let called = false;
    const result = await f.vault.runDreamCycle({ force: true, agentRunner: () => { called = true; return { merges: [] }; } });
    assert.equal(result.ok, false);
    assert.equal(result.report.agent.error, "unsupported-provider");
    assert.equal(called, false);
    assert.equal(fs.existsSync(touched), false);
  });
}

test("a failed scheduled run is visible and waits for the next day's window", async t => {
  const f = fixture(t);
  fakeCli(f, "muse", "cat >/dev/null\nexit 7");
  seedGray(f);
  assert.equal(f.vault.updateDreamConfig({ enabled: true, dreamTime: "03:30", dreamMode: "agent", providerInstanceId: "muse", model: "muse-ember-1.0", minDeltaMemories: 1 }).ok, true);
  const now = new Date(2026, 10, 16, 3, 30, 0);
  const scheduled = await f.vault.checkAndRunDueDream({ now });
  assert.equal(scheduled.triggered, true);
  assert.equal(scheduled.ok, false);
  assert.equal(scheduled.report.local.status, "success");
  assert.equal(scheduled.report.agent.status, "failed");
  const repeat = await f.vault.checkAndRunDueDream({ now: new Date(2026, 10, 16, 3, 31, 0) });
  assert.equal(repeat.triggered, false);
  assert.equal(repeat.reason, "already-dreamed-today");
  const due = f.vault.getDreamOverview({ now }).runtime.scheduler.nextDueAt;
  assert.equal(due, new Date(2026, 10, 17, 3, 30, 0).toISOString());
});

test("disabled scheduling has no due time and unsupported AGY cannot be newly enabled", t => {
  const f = fixture(t);
  assert.equal(f.vault.updateDreamConfig({ enabled: false }).ok, true);
  assert.equal(f.vault.getDreamOverview().runtime.scheduler.nextDueAt, null);
  assert.equal(f.vault.updateDreamConfig({ dreamMode: "agent", providerInstanceId: "antigravity" }).ok, false);
  assert.equal(f.vault.getDreamOverview().config.providerInstanceId, "muse");
  assert.equal(f.vault.updateDreamConfig({ model: "--bad value" }).ok, false);
});

test("pinned and suspected-credential records are not merged, archived, or sent to the agent", async t => {
  const f = fixture(t), ids = seedGray(f);
  const protectedItem = f.vault.saveMemory({ projectRoot: f.projectRoot, module: "topics", title: "a protected worktree note", content: "separate old worktree note", scope: "worktree", worktreeId: "gone", tags: ["pinned"], autoEvolve: false });
  assert.equal(protectedItem.ok, true);
  const credential = f.vault.saveMemory({ projectRoot: f.projectRoot, module: "topics", title: "credential record", content: "ordinary record content", autoEvolve: false });
  assert.equal(credential.ok, true);
  const db = new DatabaseSync(path.join(f.vaultDir, "index.sqlite"));
  try {
    db.prepare("UPDATE memories SET updated_at = ?, created_at = ? WHERE id = ?").run("2020-01-01T00:00:00Z", "2020-01-01T00:00:00Z", protectedItem.item.id);
    db.prepare("UPDATE memories SET content = ? WHERE id = ?").run("api_key=EXAMPLE_SECRET_VALUE", credential.item.id);
    const stmt = db.prepare("INSERT OR REPLACE INTO memory_vectors(id,model_id,dim,vec_f32,updated_at) VALUES(?,?,?,?,?)");
    stmt.run(credential.item.id, "test", 2, Buffer.from(new Float32Array([1, 0]).buffer), new Date().toISOString());
  } finally { db.close(); }
  f.vault.updateDreamConfig({ dreamMode: "agent", providerInstanceId: "muse", minDeltaMemories: 1 });
  let captured = null;
  const result = await f.vault.runDreamCycle({ force: true, projectRoot: f.projectRoot, agentRunner: (payload) => { captured = payload; return { merges: [] }; } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(captured && captured.clusters.length > 0);
  assert.ok(!JSON.stringify(captured).includes("EXAMPLE_SECRET_VALUE"));
  const after = new DatabaseSync(path.join(f.vaultDir, "index.sqlite"), { readOnly: true });
  try {
    const present = after.prepare("SELECT id FROM memories WHERE id IN (?, ?)").all(protectedItem.item.id, credential.item.id);
    assert.equal(present.length, 2);
    assert.ok(ids.every(id => after.prepare("SELECT id FROM memories WHERE id=?").get(id)));
  } finally { after.close(); }
});

test("scheduler due time includes the 28-hour wake catch-up rule", t => {
  const f = fixture(t); f.vault.getDreamState();
  const configFile = path.join(f.hubDir, "dream-config.json"), config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  const now = new Date(2026, 10, 16, 2, 0, 0);
  Object.assign(config, { enabled: true, dreamTime: "03:30", catchUpOnWake: true, lastDreamAt: new Date(now.getTime() - 29 * 3600000).toISOString(), lastDreamDate: "2026-11-14" });
  fs.writeFileSync(configFile, JSON.stringify(config));
  assert.equal(f.vault.getDreamOverview({ now }).runtime.scheduler.nextDueAt, now.toISOString());
  assert.equal(f.vault.updateDreamConfig({ catchUpOnWake: false }).ok, true);
  assert.equal(f.vault.getDreamOverview({ now }).runtime.scheduler.nextDueAt, new Date(2026, 10, 16, 3, 30, 0).toISOString());
});

test("a force-run with no ambiguous clusters never invokes the agent", async t => {
  const f = fixture(t); let called = false;
  const result = await f.vault.runDreamCycle({ force: true, agentRunner: () => { called = true; return { merges: [] }; } });
  assert.equal(result.ok, true);
  assert.equal(result.report.agent.status, "skipped");
  assert.equal(result.report.agent.reason, "no-ambiguous-clusters");
  assert.equal(called, false);
});

test("thrown runner errors never expose raw credentials in saved reports", async t => {
  const f = fixture(t); seedGray(f);
  f.vault.updateDreamConfig({ dreamMode: "agent", minDeltaMemories: 1 });
  const result = await f.vault.runDreamCycle({ force: true, agentRunner: () => { throw new Error("api_key=EXAMPLE_SECRET_VALUE"); } });
  assert.equal(result.ok, false);
  assert.equal(result.report.agent.error, "agent-run-failed");
  assert.equal(result.report.agent.status, "failed");
  assert.ok(!JSON.stringify(f.vault.getDreamOverview()).includes("EXAMPLE_SECRET_VALUE"));
});

test("automatic local consolidation never removes a merely similar conclusion", async t => {
  const f = fixture(t), ids = seedGray(f);
  const db = new DatabaseSync(path.join(f.vaultDir, "index.sqlite"));
  try {
    db.prepare("UPDATE memory_vectors SET vec_f32=? WHERE id=?").run(Buffer.from(new Float32Array([0.99, 0.141]).buffer), ids[1]);
  } finally { db.close(); }
  f.vault.updateDreamConfig({ dreamMode: "local" });
  const result = await f.vault.runDreamCycle({ force: true });
  assert.equal(result.ok, true);
  assert.equal(result.report.mergedCount, 0);
  assert.equal(result.report.retainedExactDuplicates, 0);
  const after = new DatabaseSync(path.join(f.vaultDir, "index.sqlite"), { readOnly: true });
  try { assert.ok(ids.every(id => after.prepare("SELECT id FROM memories WHERE id=?").get(id))); }
  finally { after.close(); }
});

function duplicatePair(f, historyCount = 0) {
  const ids = seedGray(f), db = new DatabaseSync(path.join(f.vaultDir, "index.sqlite"));
  try {
    db.prepare("UPDATE memories SET title=(SELECT title FROM memories WHERE id=?), content=(SELECT content FROM memories WHERE id=?), content_hash=(SELECT content_hash FROM memories WHERE id=?), kind=(SELECT kind FROM memories WHERE id=?) WHERE id=?")
      .run(ids[0], ids[0], ids[0], ids[0], ids[1]);
    if (historyCount) {
      const hist = JSON.stringify(Array.from({ length: historyCount }, (_, i) => ({ version: i + 1, title: "old", content: "old version " + i })));
      for (const id of ids) db.prepare("UPDATE memories SET history_json=? WHERE id=?").run(hist, id);
    }
  } finally { db.close(); }
  return ids;
}

test("automatic local consolidation may combine only exact duplicates with complete history", async t => {
  const f = fixture(t), ids = duplicatePair(f);
  f.vault.updateDreamConfig({ dreamMode: "local" });
  const result = await f.vault.runDreamCycle({ force: true });
  assert.equal(result.ok, true);
  assert.equal(result.report.mergedCount, 1);
  const after = new DatabaseSync(path.join(f.vaultDir, "index.sqlite"), { readOnly: true });
  try { assert.equal(after.prepare("SELECT COUNT(*) c FROM memories WHERE id IN (?,?)").get(...ids).c, 1); }
  finally { after.close(); }
});

test("automatic exact consolidation preserves both records when revision history would overflow", async t => {
  const f = fixture(t), ids = duplicatePair(f, 5);
  f.vault.updateDreamConfig({ dreamMode: "local" });
  const result = await f.vault.runDreamCycle({ force: true });
  assert.equal(result.ok, true);
  assert.equal(result.report.mergedCount, 0);
  assert.equal(result.report.retainedExactDuplicates, 1);
  const after = new DatabaseSync(path.join(f.vaultDir, "index.sqlite"), { readOnly: true });
  try { assert.equal(after.prepare("SELECT COUNT(*) c FROM memories WHERE id IN (?,?)").get(...ids).c, 2); }
  finally { after.close(); }
});

test("scheduler exposes the earliest future 12-hour catch-up deadline", t => {
  const f = fixture(t); f.vault.getDreamState();
  const configFile = path.join(f.hubDir, "dream-config.json"), config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  const now = new Date(2026, 10, 16, 10, 0, 0);
  const last = new Date(2026, 10, 15, 23, 0, 0);
  Object.assign(config, { enabled: true, dreamTime: "03:30", catchUpOnWake: true, lastDreamAt: last.toISOString(), lastDreamDate: "2026-11-15" });
  fs.writeFileSync(configFile, JSON.stringify(config));
  assert.equal(f.vault.getDreamOverview({ now }).runtime.scheduler.nextDueAt, new Date(last.getTime() + 12 * 3600000 + 1).toISOString());
});

test("automatic worktree archival never deletes unmanaged files in that directory", async t => {
  const f = fixture(t);
  const saved = f.vault.saveMemory({ projectRoot: f.projectRoot, module: "topics", title: "old worktree note", content: "temporary note", scope: "worktree", worktreeId: "gone", autoEvolve: false });
  assert.equal(saved.ok, true);
  const db = new DatabaseSync(path.join(f.vaultDir, "index.sqlite"));
  try { db.prepare("UPDATE memories SET updated_at=?, created_at=? WHERE id=?").run("2020-01-01T00:00:00Z", "2020-01-01T00:00:00Z", saved.item.id); }
  finally { db.close(); }
  const slug = f.vault.resolveProjectSlug(f.projectRoot), dir = path.join(f.vaultDir, "projects", slug, "_worktrees", "gone");
  fs.mkdirSync(dir, { recursive: true });
  const unmanaged = path.join(dir, "unmanaged-note.txt"); fs.writeFileSync(unmanaged, "keep this file");
  f.vault.updateDreamConfig({ dreamMode: "local" });
  const result = await f.vault.runDreamCycle({ now: new Date(2026, 10, 16), force: true, activeWorktreeIds: [], activeWorktreeIdsAuthoritative: true });
  assert.equal(result.ok, true);
  assert.ok(result.report.archivedCount > 0);
  assert.equal(fs.readFileSync(unmanaged, "utf8"), "keep this file");
});

for (const [label, activeWorktreeIds] of [["known active", ["live"]], ["unknown status", undefined], ["an incomplete list", ["other"]]]) {
  test(`automatic archival preserves old worktree memory when ${label}`, async t => {
    const f = fixture(t);
    const saved = f.vault.saveMemory({ projectRoot: f.projectRoot, module: "topics", title: "old but needed", content: "worktree working knowledge", scope: "worktree", worktreeId: "live", autoEvolve: false });
    assert.equal(saved.ok, true);
    const db = new DatabaseSync(path.join(f.vaultDir, "index.sqlite"));
    try { db.prepare("UPDATE memories SET updated_at=?, created_at=? WHERE id=?").run("2020-01-01T00:00:00Z", "2020-01-01T00:00:00Z", saved.item.id); }
    finally { db.close(); }
    f.vault.updateDreamConfig({ dreamMode: "local" });
    const result = await f.vault.runDreamCycle({ now: new Date(2026, 10, 16), force: true, ...(activeWorktreeIds ? { activeWorktreeIds } : {}) });
    assert.equal(result.ok, true);
    const after = new DatabaseSync(path.join(f.vaultDir, "index.sqlite"), { readOnly: true });
    try { assert.ok(after.prepare("SELECT id FROM memories WHERE id=?").get(saved.item.id)); }
    finally { after.close(); }
  });
}

test("new installations start disabled while explicit existing enablement is preserved", t => {
  const f = fixture(t), initial = f.vault.getDreamOverview();
  assert.equal(initial.config.enabled, false);
  assert.equal(initial.runtime.scheduler.nextDueAt, null);
  const file = path.join(f.hubDir, "dream-config.json"), config = JSON.parse(fs.readFileSync(file, "utf8"));
  config.enabled = true; fs.writeFileSync(file, JSON.stringify(config));
  const existing = f.vault.getDreamOverview();
  assert.equal(existing.config.enabled, true);
  assert.ok(existing.runtime.scheduler.nextDueAt);
});

for (const type of ["worktrees", "cold"]) {
  test(`unreadable existing ${type} archive remains untouched while the new batch is stored separately`, async t => {
    if (process.getuid?.() === 0) { t.skip("requires non-root permissions"); return; }
    const f = fixture(t);
    const saved = f.vault.saveMemory({ projectRoot: f.projectRoot, module: "topics", title: "old note", content: "retained test record", ...(type === "worktrees" ? { scope: "worktree", worktreeId: "gone" } : {}), autoEvolve: false });
    assert.equal(saved.ok, true);
    const db = new DatabaseSync(path.join(f.vaultDir, "index.sqlite"));
    try { db.prepare("UPDATE memories SET updated_at=?, created_at=? WHERE id=?").run("2020-01-01T00:00:00Z", "2020-01-01T00:00:00Z", saved.item.id); }
    finally { db.close(); }
    const slug = f.vault.resolveProjectSlug(f.projectRoot), archive = path.join(f.vaultDir, "projects", slug, "_archive", type + ".md");
    fs.mkdirSync(path.dirname(archive), { recursive: true }); fs.writeFileSync(archive, "old archive marker\n"); fs.chmodSync(archive, 0o000);
    f.vault.updateDreamConfig({ dreamMode: "local" });
    const result = await f.vault.runDreamCycle({ now: new Date(2026, 10, 16), force: true, activeWorktreeIds: [], activeWorktreeIdsAuthoritative: true, maxActivePerProject: 0, staleDays: 0 });
    assert.equal(result.ok, true);
    fs.chmodSync(archive, 0o600);
    assert.equal(fs.readFileSync(archive, "utf8"), "old archive marker\n");
    const newFiles = fs.readdirSync(path.dirname(archive)).filter(name => name.startsWith(type + "-dream-") && name.endsWith(".md"));
    assert.equal(newFiles.length, 1);
    assert.ok(fs.readFileSync(path.join(path.dirname(archive), newFiles[0]), "utf8").includes("retained test record"));
  });
}

test("automatic archive publication failure preserves old archive and live memory", async t => {
  const f = fixture(t);
  const saved = f.vault.saveMemory({ projectRoot: f.projectRoot, module: "topics", title: "old note", content: "retained test record", scope: "worktree", worktreeId: "gone", autoEvolve: false });
  const slug = f.vault.resolveProjectSlug(f.projectRoot), archive = path.join(f.vaultDir, "projects", slug, "_archive", "worktrees.md");
  fs.mkdirSync(path.dirname(archive), { recursive: true }); const original = "X".repeat(256 * 1024 + 1); fs.writeFileSync(archive, original);
  f.vault.updateDreamConfig({ dreamMode: "local" });
  const link = fs.linkSync;
  fs.linkSync = function(from, to) { if (path.basename(String(from)).startsWith(".dream-archive-")) throw new Error("injected publication failure"); return link.apply(this, arguments); };
  let result;
  try { result = await f.vault.runDreamCycle({ force: true, activeWorktreeIds: [], activeWorktreeIdsAuthoritative: true }); }
  finally { fs.linkSync = link; }
  assert.equal(result.ok, false);
  assert.equal(result.report.local.status, "partial");
  assert.equal(fs.readFileSync(archive, "utf8"), original);
  const after = new DatabaseSync(path.join(f.vaultDir, "index.sqlite"), { readOnly: true });
  try { assert.ok(after.prepare("SELECT id FROM memories WHERE id=?").get(saved.item.id)); }
  finally { after.close(); }
});

for (const change of ["content", "pinned"]) {
  test(`automatic archive retains a record concurrently changed to ${change}`, async t => {
    const f = fixture(t);
    const saved = f.vault.saveMemory({ projectRoot: f.projectRoot, module: "topics", title: "worktree note", content: "old snapshot", scope: "worktree", worktreeId: "gone", autoEvolve: false });
    f.vault.updateDreamConfig({ dreamMode: "local" });
    const link = fs.linkSync; let injected = false;
    fs.linkSync = function(from, to) {
      const out = link.apply(this, arguments);
      if (!injected && path.basename(String(from)).startsWith(".dream-archive-")) {
        injected = true;
        const db = new DatabaseSync(path.join(f.vaultDir, "index.sqlite"));
        try {
          if (change === "content") db.prepare("UPDATE memories SET content=? WHERE id=?").run("newer content", saved.item.id);
          else db.prepare("UPDATE memories SET tags_json=? WHERE id=?").run(JSON.stringify(["pinned"]), saved.item.id);
        } finally { db.close(); }
      }
      return out;
    };
    let result;
    try { result = await f.vault.runDreamCycle({ force: true, activeWorktreeIds: [], activeWorktreeIdsAuthoritative: true }); }
    finally { fs.linkSync = link; }
    assert.equal(injected, true);
    assert.equal(result.ok, false);
    assert.equal(result.report.local.status, "partial");
    assert.equal(result.report.archiveConflicts, 1);
    const after = new DatabaseSync(path.join(f.vaultDir, "index.sqlite"), { readOnly: true });
    try {
      const row = after.prepare("SELECT content,tags_json FROM memories WHERE id=?").get(saved.item.id);
      assert.ok(row);
      if (change === "content") assert.equal(row.content, "newer content");
      else assert.ok(JSON.parse(row.tags_json).includes("pinned"));
    } finally { after.close(); }
  });
}

test("malformed enabled values fail closed", t => {
  const f = fixture(t); f.vault.getDreamState();
  const file = path.join(f.hubDir, "dream-config.json"), original = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const enabled of [null, "true", 1, {}]) {
    fs.writeFileSync(file, JSON.stringify({ ...original, enabled }));
    const state = f.vault.getDreamOverview();
    assert.equal(state.config.enabled, false);
    assert.equal(state.runtime.scheduler.nextDueAt, null);
  }
});

test("automatic archive never overwrites an existing archive modified concurrently", async t => {
  const f = fixture(t);
  const saved = f.vault.saveMemory({ projectRoot: f.projectRoot, module: "topics", title: "worktree note", content: "archive this snapshot", scope: "worktree", worktreeId: "gone", autoEvolve: false });
  const slug = f.vault.resolveProjectSlug(f.projectRoot), archive = path.join(f.vaultDir, "projects", slug, "_archive", "worktrees.md");
  fs.mkdirSync(path.dirname(archive), { recursive: true }); fs.writeFileSync(archive, "existing\n");
  f.vault.updateDreamConfig({ dreamMode: "local" });
  const link = fs.linkSync; let injected = false;
  fs.linkSync = function(from, to) {
    if (!injected && path.basename(String(from)).startsWith(".dream-archive-")) { injected = true; fs.appendFileSync(archive, "concurrent addition\n"); }
    return link.apply(this, arguments);
  };
  let result;
  try { result = await f.vault.runDreamCycle({ force: true, activeWorktreeIds: [], activeWorktreeIdsAuthoritative: true }); }
  finally { fs.linkSync = link; }
  assert.equal(injected, true);
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(archive, "utf8"), "existing\nconcurrent addition\n");
  const batches = fs.readdirSync(path.dirname(archive)).filter(n => n.startsWith("worktrees-dream-") && n.endsWith(".md"));
  assert.equal(batches.length, 1);
  assert.ok(fs.readFileSync(path.join(path.dirname(archive), batches[0]), "utf8").includes("archive this snapshot"));
  const after = new DatabaseSync(path.join(f.vaultDir, "index.sqlite"), { readOnly: true });
  try { assert.equal(after.prepare("SELECT id FROM memories WHERE id=?").get(saved.item.id), undefined); }
  finally { after.close(); }
});

test("automatic archive rejects a symlinked archive directory without touching its target", async t => {
  const f = fixture(t);
  const saved = f.vault.saveMemory({ projectRoot: f.projectRoot, module: "topics", title: "worktree note", content: "do not relocate", scope: "worktree", worktreeId: "gone", autoEvolve: false });
  const slug = f.vault.resolveProjectSlug(f.projectRoot), dir = path.join(f.vaultDir, "projects", slug, "_archive"), outside = path.join(f.base, "outside");
  fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "marker"), "untouched"); fs.symlinkSync(outside, dir);
  f.vault.updateDreamConfig({ dreamMode: "local" });
  const result = await f.vault.runDreamCycle({ force: true, activeWorktreeIds: [], activeWorktreeIdsAuthoritative: true });
  assert.equal(result.ok, false);
  assert.equal(result.report.local.status, "partial");
  assert.deepEqual(fs.readdirSync(outside), ["marker"]);
  const after = new DatabaseSync(path.join(f.vaultDir, "index.sqlite"), { readOnly: true });
  try { assert.ok(after.prepare("SELECT id FROM memories WHERE id=?").get(saved.item.id)); }
  finally { after.close(); }
});

test("automatic exact dedup leaves referenced IDs intact and creates no broken links", async t => {
  const f = fixture(t), ids = duplicatePair(f);
  const ref = f.vault.saveMemory({ projectRoot: f.projectRoot, module: "constraints", title: "links", content: `References [[#${ids[0]}]] and [[#${ids[1]}]].`, autoEvolve: false });
  assert.equal(ref.ok, true);
  assert.equal(f.vault.getMemoryHealth().brokenCount, 0);
  f.vault.updateDreamConfig({ dreamMode: "local" });
  const result = await f.vault.runDreamCycle({ force: true });
  assert.equal(result.ok, true);
  assert.ok(result.report.retainedReferencedCount > 0);
  assert.equal(f.vault.getMemoryHealth().brokenCount, 0);
  const db = new DatabaseSync(path.join(f.vaultDir, "index.sqlite"), { readOnly: true });
  try { assert.equal(db.prepare("SELECT COUNT(*) c FROM memories WHERE id IN (?,?)").get(...ids).c, 2); }
  finally { db.close(); }
});

for (const kind of ["id", "title", "module", "supersedes"]) {
  test(`automatic cold archival preserves in-vault ${kind} references`, async t => {
    const f = fixture(t);
    const target = f.vault.saveMemory({ projectRoot: f.projectRoot, module: "topics", title: "unique target", content: "older needed content", autoEvolve: false });
    const token = kind === "id" ? `#${target.item.id}` : kind === "title" ? "unique target" : kind === "module" ? "topics" : "other";
    const ref = f.vault.saveMemory({ projectRoot: f.projectRoot, module: "constraints", title: "protect reference", content: kind === "supersedes" ? "existing decision" : `keep [[${token}]]`, autoEvolve: false });
    const db = new DatabaseSync(path.join(f.vaultDir, "index.sqlite"));
    try {
      db.prepare("UPDATE memories SET updated_at=?, created_at=? WHERE id=?").run("2020-01-01T00:00:00Z", "2020-01-01T00:00:00Z", target.item.id);
      if (kind === "supersedes") db.prepare("UPDATE memories SET supersedes_id=? WHERE id=?").run(target.item.id, ref.item.id);
    } finally { db.close(); }
    f.vault.updateDreamConfig({ dreamMode: "local" });
    const result = await f.vault.runDreamCycle({ force: true, maxActivePerProject: 0, staleDays: 0 });
    assert.equal(result.ok, true);
    assert.ok(result.report.retainedReferencedCount > 0);
    const after = new DatabaseSync(path.join(f.vaultDir, "index.sqlite"), { readOnly: true });
    try { assert.ok(after.prepare("SELECT id FROM memories WHERE id=?").get(target.item.id)); }
    finally { after.close(); }
    assert.equal(f.vault.getMemoryHealth().brokenCount, 0);
  });
}

test("agent merge is blocked if it would remove a referenced memory", async t => {
  const f = fixture(t), ids = seedGray(f);
  f.vault.saveMemory({ projectRoot: f.projectRoot, module: "constraints", title: "references", content: `Remember [[#${ids[1]}]].`, autoEvolve: false });
  f.vault.updateDreamConfig({ dreamMode: "agent", minDeltaMemories: 1 });
  const result = await f.vault.runDreamCycle({ force: true, agentRunner: ({ clusters }) => {
    const items = clusters[0].items, keep = items.find(i => i.id !== ids[1]), remove = items.find(i => i.id === ids[1]);
    return { merges: [{ keepId: keep.id, mergeIds: [remove.id], content: "merged summary" }] };
  } });
  assert.equal(result.ok, false);
  assert.equal(result.report.agent.status, "partial");
  assert.ok(result.report.retainedReferencedCount > 0);
  assert.equal(f.vault.getMemoryHealth().brokenCount, 0);
  const db = new DatabaseSync(path.join(f.vaultDir, "index.sqlite"), { readOnly: true });
  try { assert.equal(db.prepare("SELECT COUNT(*) c FROM memories WHERE id IN (?,?)").get(...ids).c, 2); }
  finally { db.close(); }
});

test("cold archival never treats an active old worktree as ordinary cold data", async t => {
  const f = fixture(t);
  const target = f.vault.saveMemory({ projectRoot: f.projectRoot, module: "topics", title: "active worktree", content: "old but active", scope: "worktree", worktreeId: "live", autoEvolve: false });
  const db = new DatabaseSync(path.join(f.vaultDir, "index.sqlite"));
  try { db.prepare("UPDATE memories SET updated_at=?, created_at=? WHERE id=?").run("2020-01-01T00:00:00Z", "2020-01-01T00:00:00Z", target.item.id); }
  finally { db.close(); }
  f.vault.updateDreamConfig({ dreamMode: "local" });
  const result = await f.vault.runDreamCycle({ force: true, maxActivePerProject: 0, staleDays: 0, activeWorktreeIds: ["live"] });
  assert.equal(result.ok, true);
  const after = new DatabaseSync(path.join(f.vaultDir, "index.sqlite"), { readOnly: true });
  try { assert.ok(after.prepare("SELECT id FROM memories WHERE id=?").get(target.item.id)); }
  finally { after.close(); }
});

test("exact dedup rechecks a newly pinned record inside the transaction", async t => {
  const f = fixture(t), ids = duplicatePair(f);
  f.vault.updateDreamConfig({ dreamMode: "local" });
  const exec = DatabaseSync.prototype.exec; let changed = false;
  DatabaseSync.prototype.exec = function(sql) {
    if (!changed && sql === "BEGIN IMMEDIATE") {
      changed = true;
      const other = new DatabaseSync(path.join(f.vaultDir, "index.sqlite"));
      try { other.prepare("UPDATE memories SET tags_json=? WHERE id=?").run(JSON.stringify(["pinned"]), ids[1]); }
      finally { other.close(); }
    }
    return exec.apply(this, arguments);
  };
  let result;
  try { result = await f.vault.runDreamCycle({ force: true }); }
  finally { DatabaseSync.prototype.exec = exec; }
  assert.equal(changed, true);
  assert.equal(result.report.mergedCount, 0);
  const after = new DatabaseSync(path.join(f.vaultDir, "index.sqlite"), { readOnly: true });
  try {
    assert.equal(after.prepare("SELECT COUNT(*) c FROM memories WHERE id IN (?,?)").get(...ids).c, 2);
    assert.ok(JSON.parse(after.prepare("SELECT tags_json FROM memories WHERE id=?").get(ids[1]).tags_json).includes("pinned"));
  } finally { after.close(); }
});

test("agent merge preserves a full keep history rather than truncating old revisions", async t => {
  const f = fixture(t), ids = seedGray(f), hist = JSON.stringify(Array.from({ length: 10 }, (_, i) => ({ version: i + 1, title: "revision", content: "revision " + i })));
  const db = new DatabaseSync(path.join(f.vaultDir, "index.sqlite"));
  try { for (const id of ids) db.prepare("UPDATE memories SET history_json=? WHERE id=?").run(hist, id); }
  finally { db.close(); }
  f.vault.updateDreamConfig({ dreamMode: "agent", minDeltaMemories: 1 });
  const result = await f.vault.runDreamCycle({ force: true, agentRunner: ({ clusters }) => ({ merges: [{ keepId: clusters[0].items[0].id, mergeIds: [clusters[0].items[1].id], content: "candidate" }] }) });
  assert.equal(result.ok, false);
  assert.equal(result.report.agent.status, "partial");
  assert.equal(result.report.retainedAgentHistoryCount, 1);
  const after = new DatabaseSync(path.join(f.vaultDir, "index.sqlite"), { readOnly: true });
  try {
    const rows = after.prepare("SELECT history_json FROM memories WHERE id IN (?,?)").all(...ids);
    assert.equal(rows.length, 2);
    assert.ok(rows.every(row => JSON.parse(row.history_json).length === 10));
  } finally { after.close(); }
});

test("automatic worktree archival preserves records referenced from active memories", async t => {
  const f = fixture(t);
  const target = f.vault.saveMemory({ projectRoot: f.projectRoot, module: "topics", title: "linked worktree", content: "worktree result", scope: "worktree", worktreeId: "gone", autoEvolve: false });
  f.vault.saveMemory({ projectRoot: f.projectRoot, module: "constraints", title: "reference", content: `Keep [[#${target.item.id}]].`, autoEvolve: false });
  f.vault.updateDreamConfig({ dreamMode: "local" });
  const result = await f.vault.runDreamCycle({ force: true, activeWorktreeIds: [], activeWorktreeIdsAuthoritative: true });
  assert.equal(result.ok, true);
  assert.ok(result.report.retainedReferencedCount > 0);
  assert.equal(f.vault.getMemoryHealth().brokenCount, 0);
  const after = new DatabaseSync(path.join(f.vaultDir, "index.sqlite"), { readOnly: true });
  try { assert.ok(after.prepare("SELECT id FROM memories WHERE id=?").get(target.item.id)); }
  finally { after.close(); }
});

test("an unrepresentable prompt budget is an explicit model skip, not a fake failure", async t => {
  const f = fixture(t); seedGray(f); let called = false;
  f.vault.updateDreamConfig({ dreamMode: "agent", minDeltaMemories: 1, maxInputTokens: 100 });
  const result = await f.vault.runDreamCycle({ force: true, agentRunner: () => { called = true; return { merges: [] }; } });
  assert.equal(result.ok, true);
  assert.equal(result.report.agent.status, "skipped");
  assert.equal(result.report.agent.reason, "prompt-over-budget");
  assert.equal(result.config.lastAgentDreamAt ?? null, null);
  assert.equal(called, false);
});

for (const history of [JSON.stringify(Array.from({ length: 11 }, (_, i) => ({ version: i + 1, content: "old " + i }))), "invalid-json"]) {
  test(`automatic archive preserves a record with ${history === "invalid-json" ? "invalid" : "oversized"} history`, async t => {
    const f = fixture(t);
    const target = f.vault.saveMemory({ projectRoot: f.projectRoot, module: "topics", title: "history protected", content: "old item", autoEvolve: false });
    const db = new DatabaseSync(path.join(f.vaultDir, "index.sqlite"));
    try { db.prepare("UPDATE memories SET updated_at=?, created_at=?, history_json=? WHERE id=?").run("2020-01-01T00:00:00Z", "2020-01-01T00:00:00Z", history, target.item.id); }
    finally { db.close(); }
    f.vault.updateDreamConfig({ dreamMode: "local" });
    const result = await f.vault.runDreamCycle({ force: true, maxActivePerProject: 0, staleDays: 0 });
    assert.equal(result.ok, true);
    assert.equal(result.report.retainedArchiveHistoryCount, 1);
    const after = new DatabaseSync(path.join(f.vaultDir, "index.sqlite"), { readOnly: true });
    try { assert.equal(after.prepare("SELECT history_json FROM memories WHERE id=?").get(target.item.id).history_json, history); }
    finally { after.close(); }
  });
}
