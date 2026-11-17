"use strict";
// Hermetic Re-Memory v2 regressions. No state or requests to the live Hub.
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { createMemoryVault } = require("../src/memory-vault.cjs");
const REPO = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rememory-v2-"));
let serial = 0;
after(() => fs.rmSync(temp, { recursive: true, force: true }));
function fixture(embedFn = () => null, vaultOptions = {}) {
  const base = path.join(temp, String(++serial));
  const projectRoot = path.join(base, "project");
  const vaultDir = path.join(base, "vault");
  const homeDir = path.join(base, "home");
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(path.join(projectRoot, ".project"), "fixture");
  fs.mkdirSync(homeDir, { recursive: true });
  const vault = createMemoryVault({ vaultDir, homeDir, _embedFn: embedFn, ...vaultOptions });
  const save = (args) => {
    const result = vault.saveMemory({ projectRoot, module: "constraints", title: "构建流程", content: "构建之前必须先检查依赖环境", ...args });
    assert.equal(result.ok, true, JSON.stringify(result));
    return result;
  };
  const list = (args = {}) => {
    const result = vault.listMemories({ projectRoot, ...args });
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.items;
  };
  const md = (module = "constraints") => path.join(vaultDir, "projects", "project", module + ".md");
  const db = () => new DatabaseSync(path.join(vaultDir, "index.sqlite"));
  return { base, projectRoot, vaultDir, homeDir, vault, save, list, md, db };
}

test("supersedes replaces in place across modules; history never enters FTS or vector input", () => {
  const inputs = [];
  const f = fixture((texts) => { inputs.push(...texts); return texts.map((text) => text.includes("obsoletequartz") ? [1, 0] : [0, 1]); });
  const first = f.save({ title: "Legacy", content: "obsoletequartz obsolete directive", tags: ["old"] });
  inputs.length = 0;
  const next = f.save({ supersedesId: first.item.id, module: "architecture", title: "Current", content: "freshwillow current directive", tags: ["new"], agent: "codex" });
  assert.equal(next.action, "superseded");
  assert.equal(next.evolvedFromVersion, 1);
  assert.equal(next.item.id, first.item.id);
  assert.equal(next.item.version, 2);
  assert.equal(next.item.supersedesId, first.item.id);
  assert.equal(next.item.history[0].reason, "superseded");
  assert.equal(next.item.history[0].content, first.item.content);
  assert.ok(!fs.readFileSync(f.md(), "utf8").includes(first.item.id));
  assert.ok(fs.readFileSync(f.md("architecture"), "utf8").includes(first.item.id));
  assert.ok(inputs.every((text) => !text.includes("obsoletequartz")));
  const db = f.db();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memories_fts WHERE memories_fts MATCH 'obsoletequartz'").get().n, 0);
  db.close();
  assert.equal(f.list({ query: "obsoletequartz" }).length, 0, "active vector must replace the obsolete vector");
  const offline = createMemoryVault({ vaultDir: f.vaultDir, _embedFn: () => null });
  assert.equal(offline.listMemories({ projectRoot: f.projectRoot, query: "obsoletequartz" }).items.length, 0);
  assert.equal(offline.listMemories({ projectRoot: f.projectRoot, query: "freshwillow" }).items[0].id, first.item.id);
});

test("manual edits increment revisions, honor recordHistory, deduplicate, and cap history at 10", () => {
  const f = fixture();
  const first = f.save();
  assert.equal(first.item.version, 1);
  assert.equal(first.item.hitCount, 0);
  assert.equal(first.item.lastRecalledAt, null);
  assert.deepEqual(first.item.history, []);
  assert.equal(f.save().action, "deduplicated");
  const edited = f.save({ id: first.item.id, title: "更新标题" });
  assert.equal(edited.item.version, 2);
  assert.equal(edited.item.history[0].reason, "manual-edit");
  const unrecorded = f.save({ id: first.item.id, content: "小调整", recordHistory: false });
  assert.equal(unrecorded.item.version, 2);
  assert.equal(unrecorded.item.history.length, 1);
  for (let i = 0; i < 12; i++) f.save({ id: first.item.id, content: "第 " + i + " 次修改" });
  const item = f.list()[0];
  assert.equal(item.version, 14);
  assert.equal(item.history.length, 10);
  assert.equal(item.history.at(-1).version, 13);
});

test("offline English and CJK lexical fallback merges fuller duplicates and evolves changed rules", () => {
  const f = fixture();
  const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron";
  const old = f.save({ title: "Build", content: text });
  const merged = f.save({ title: "Build", content: text + " pi", tags: ["fresh"] });
  assert.equal(merged.action, "merged");
  assert.equal(merged.deduplicated, true);
  assert.equal(merged.item.id, old.item.id);
  assert.equal(merged.item.version, 2);
  assert.equal(merged.item.history[0].reason, "auto-merge");
  const short = f.save({ title: "Build", content: text.replace(" omicron", ""), tags: ["short"] });
  assert.equal(short.action, "merged");
  assert.equal(short.item.version, 2);
  assert.ok(short.item.tags.includes("fresh"));
  assert.ok(short.item.tags.includes("short"));
  const cjk = f.save({ title: "上线部署规则", content: "上线部署之前必须运行单元测试并且核验构建结果" });
  const evolved = f.save({ title: "上线部署规则", content: "上线部署之前必须运行集成测试并且核验发布结果" });
  assert.equal(evolved.action, "evolved");
  assert.equal(evolved.item.id, cjk.item.id);
  assert.equal(evolved.item.history[0].reason, "auto-evolve");
  assert.equal(evolved.evolvedFromVersion, 1);
  const separate = f.save({ autoEvolve: false, title: "上线部署规则", content: "上线部署之前必须运行手动测试并且核验发布结果" });
  assert.notEqual(separate.item.id, cjk.item.id);
});

test("vector similarity drives merges and same-module evolution with dissimilar wording", () => {
  for (const [sim, expected] of [[0.96, "merged"], [0.87, "evolved"]]) {
    const f = fixture((texts) => texts.map((text) => text.startsWith("Anchor") ? [1, 0] : [sim, Math.sqrt(1 - sim * sim)]));
    const first = f.save({ title: "Anchor", content: "north" });
    const next = f.save({ title: "Rewrite", content: "southern explanation has more details" });
    assert.equal(next.action, expected);
    assert.equal(next.item.id, first.item.id);
    assert.equal(next.item.version, 2);
  }
  const f = fixture((texts) => texts.map((text) => text.startsWith("Anchor") ? [1, 0] : [0.87, Math.sqrt(1 - 0.87 ** 2)]));
  const first = f.save({ title: "Anchor", content: "north" });
  const next = f.save({ module: "topics", title: "Rewrite", content: "south" });
  assert.notEqual(next.item.id, first.item.id, "moderate vector similarity must stay within its module");
});

test("Markdown manual round trips, adjacent deletes, and index rebuild preserve v2 metadata", async () => {
  const f = fixture();
  const first = f.save({ content: "historical </comment> --> text" });
  const second = f.save({ id: first.item.id, content: "current manual body" });
  const history = second.item.history;
  const neighbour = f.save({ title: "Unrelated", content: "other independent material", autoEvolve: false });
  assert.equal(f.vault.deleteMemory({ projectRoot: f.projectRoot, id: neighbour.item.id }).ok, true);
  let text = fs.readFileSync(f.md(), "utf8");
  assert.ok(text.includes("<!-- meta:"));
  text = text.replace("current manual body", "edited manual body");
  fs.writeFileSync(f.md(), text);
  assert.equal(f.vault.syncFromMarkdownIfChanged({ projectRoot: f.projectRoot }).ok, true);
  assert.equal(f.list()[0].version, 2);
  assert.deepEqual(f.list()[0].history, history);
  // An editor that strips only the v2 comment must not reset the DB history.
  fs.writeFileSync(f.md(), fs.readFileSync(f.md(), "utf8").replace(/^<!-- meta:.*-->\n/gm, "").replace("edited manual body", "edited twice body"));
  f.vault.syncFromMarkdownIfChanged({ projectRoot: f.projectRoot });
  assert.deepEqual(f.list()[0].history, history);
  assert.equal(f.list()[0].content, "edited twice body");
  await new Promise((resolve) => setImmediate(resolve));
  fs.rmSync(path.join(f.vaultDir, "index.sqlite"));
  const restored = createMemoryVault({ vaultDir: f.vaultDir, _embedFn: () => null });
  restored.syncFromMarkdownIfChanged({ projectRoot: f.projectRoot });
  const item = restored.listMemories({ projectRoot: f.projectRoot }).items[0];
  assert.equal(item.version, 2);
  assert.deepEqual(item.history, history);
});

test("consolidation dry run is read-only; execution archives duplicates and leaves other projects alone", () => {
  const f = fixture();
  const a = f.save({ autoEvolve: false, content: "alpha beta gamma delta epsilon zeta eta theta" });
  f.save({ autoEvolve: false, content: "alpha beta gamma delta epsilon zeta eta theta iota" });
  const otherRoot = path.join(f.base, "other"); fs.mkdirSync(otherRoot);
  f.save({ projectRoot: otherRoot, content: "alpha beta gamma delta epsilon zeta eta theta kappa", autoEvolve: false });
  const before = fs.readFileSync(f.md(), "utf8");
  const preview = f.vault.consolidateMemories({ projectRoot: f.projectRoot, dryRun: true });
  assert.equal(preview.ok, true);
  assert.equal(preview.pairs.length, 1);
  assert.equal(fs.readFileSync(f.md(), "utf8"), before);
  assert.equal(f.list().length, 2);
  const result = f.vault.consolidateMemories({ projectRoot: f.projectRoot });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.mergedCount, 1);
  assert.equal(result.items[0].id, a.item.id);
  assert.equal(result.items[0].version, result.items[0].history.length + 1);
  assert.ok(result.items[0].history.some((h) => h.reason === "consolidated"));
  assert.equal(f.list().length, 1);
  assert.equal(f.list({ projectRoot: otherRoot }).length, 1);
  assert.equal(f.vault.consolidateMemories({ projectRoot: f.projectRoot }).mergedCount, 0);
});

test("threshold and explicit consolidation never merge pinned/core, while ordinary duplicates still consolidate", async () => {
  const f = fixture(() => null, { autoConsolidateThreshold: 1 });
  const pinned = f.save({ title: "Human pinned deployment rule", content: "quartz amber cobalt indigo violet preserve the exact release gate", tags: [" PiNnEd "], autoEvolve: false });
  const core = f.save({ title: "Core deployment rule", content: "quartz amber cobalt indigo violet preserve the exact release gate with a second human note", tags: ["CORE"], autoEvolve: false });
  const ordinary = f.save({ title: "Ordinary deployment note", content: "alpha beta gamma delta epsilon zeta eta theta", autoEvolve: false });
  f.save({ title: "Ordinary deployment duplicate", content: "alpha beta gamma delta epsilon zeta eta theta iota", autoEvolve: false });
  // The final save schedules the same consolidation used by the memory-count
  // threshold. Let those queued passes finish before inspecting the vault.
  await new Promise((resolve) => setImmediate(resolve));

  let current = f.list();
  assert.equal(current.find((item) => item.id === pinned.item.id).content, pinned.item.content);
  assert.equal(current.find((item) => item.id === pinned.item.id).version, pinned.item.version);
  assert.equal(current.find((item) => item.id === core.item.id).content, core.item.content);
  assert.equal(current.find((item) => item.id === core.item.id).version, core.item.version);
  assert.ok(current.some((item) => item.id === ordinary.item.id), "ordinary duplicate survivor remains");
  assert.equal(current.filter((item) => item.title.startsWith("Ordinary deployment")).length, 1,
    "ordinary duplicate was consolidated by the scheduled threshold pass");

  // Even a caller setting the old opt-out flag cannot expose protected rows.
  const explicit = f.vault.consolidateMemories({ projectRoot: f.projectRoot, excludeProtected: false });
  assert.equal(explicit.ok, true);
  assert.equal(explicit.mergedCount, 0);
  current = f.list();
  assert.ok(current.some((item) => item.id === pinned.item.id));
  assert.ok(current.some((item) => item.id === core.item.id));
});

test("consolidation handles three semantic-only duplicates in one pass", () => {
  const f = fixture((texts) => texts.map(() => [1, 0]));
  f.save({ autoEvolve: false, title: "North", content: "alpha" });
  f.save({ autoEvolve: false, title: "South", content: "beta beta" });
  f.save({ autoEvolve: false, title: "East", content: "gamma gamma gamma" });
  const result = f.vault.consolidateMemories({ projectRoot: f.projectRoot });
  assert.equal(result.ok, true);
  assert.equal(result.mergedCount, 2);
  assert.equal(f.list().length, 1);
  assert.equal(result.items[0].content, "gamma gamma gamma");
  assert.equal(result.items[0].version, result.items[0].history.length + 1);
});

test("late Markdown embedding responses cannot restore superseded or deleted vectors", async () => {
  const deferred = [];
  const f = fixture((texts) => {
    if (texts.some((text) => text.includes("delayedquartz"))) return new Promise((resolve) => deferred.push(resolve));
    return texts.map(() => [0, 1]);
  });
  const first = f.save({ title: "Async", content: "initial body" });
  fs.writeFileSync(f.md(), fs.readFileSync(f.md(), "utf8").replace("initial body", "delayedquartz body"));
  f.vault.syncFromMarkdownIfChanged({ projectRoot: f.projectRoot });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deferred.length, 1);
  f.save({ supersedesId: first.item.id, title: "Async", content: "freshwillow body" });
  deferred.shift()([[1, 0]]);
  await new Promise((resolve) => setImmediate(resolve));
  let db = f.db();
  const bytes = Uint8Array.from(db.prepare("SELECT vec_f32 FROM memory_vectors WHERE id=?").get(first.item.id).vec_f32);
  assert.deepEqual([...new Float32Array(bytes.buffer)], [0, 1]);
  db.close();
  // Edit only active content; the history comment remains unchanged.
  const lines = fs.readFileSync(f.md(), "utf8").split("\n");
  fs.writeFileSync(f.md(), lines.map((line) => line === "freshwillow body" ? "delayedquartz again" : line).join("\n"));
  f.vault.syncFromMarkdownIfChanged({ projectRoot: f.projectRoot });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deferred.length, 1);
  f.vault.deleteMemory({ projectRoot: f.projectRoot, id: first.item.id });
  deferred.shift()([[1, 0]]);
  await new Promise((resolve) => setImmediate(resolve));
  db = f.db();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_vectors").get().n, 0);
  db.close();
});

test("explicit supersedes stays inside its project and rejects global memory", () => {
  const f = fixture();
  const first = f.save();
  const otherRoot = path.join(f.base, "other"); fs.mkdirSync(otherRoot);
  assert.equal(f.vault.saveMemory({ projectRoot: otherRoot, supersedesId: first.item.id, title: "Wrong", content: "wrong scope" }).ok, false);
  assert.equal(f.vault.saveMemory({ projectRoot: f.projectRoot, supersedesId: "missing", title: "Missing", content: "no target" }).ok, false);
  assert.equal(f.vault.saveMemory({ projectRoot: f.projectRoot, scope: "global", title: "Global", content: "unavailable" }).ok, false);
  assert.equal(f.list()[0].id, first.item.id);
});

test("rollback creates a new revision, supports target and latest, and reindexes active content only", () => {
  const f = fixture();
  const first = f.save({ content: "oldquartz rule" });
  f.save({ id: first.item.id, content: "newwillow rule" });
  const rolled = f.vault.rollbackMemory({ projectRoot: f.projectRoot, id: first.item.id, targetVersion: 1 });
  assert.equal(rolled.ok, true);
  assert.equal(rolled.item.version, 3);
  assert.equal(rolled.item.content, "oldquartz rule");
  assert.equal(rolled.item.history.at(-1).reason, "rollback");
  assert.equal(f.list({ query: "newwillow" }).length, 0);
  const latest = f.vault.rollbackMemory({ projectRoot: f.projectRoot, id: first.item.id });
  assert.equal(latest.item.content, "newwillow rule");
  assert.equal(latest.item.version, 4);
  assert.equal(f.vault.rollbackMemory({ projectRoot: f.projectRoot, id: first.item.id, targetVersion: 99 }).ok, false);
  assert.equal(f.vault.rollbackMemory({ projectSlug: "other", id: first.item.id }).ok, false);
});

test("recall counters survive Markdown sync and mildly boost RRF; empty query and trackHits=false do not count", () => {
  const f = fixture();
  const a = f.save({ title: "Recall", content: "sharedneedle alpha" });
  f.save({ title: "Recall", content: "sharedneedle beta", autoEvolve: false });
  f.list();
  assert.equal(f.list().find((i) => i.id === a.item.id).hitCount, 0);
  const hits = f.list({ query: "sharedneedle", limit: 1 });
  assert.equal(hits[0].hitCount, 1);
  assert.ok(hits[0].lastRecalledAt);
  const next = f.list({ query: "sharedneedle", trackHits: false });
  const hot = next.find((i) => i.id === hits[0].id);
  assert.equal(hot.hitCount, 1);
  assert.ok(hot.score > hits[0].score);
  assert.equal(next[0].id, hot.id);
  fs.writeFileSync(f.md(), fs.readFileSync(f.md(), "utf8") + "\n");
  f.vault.syncFromMarkdownIfChanged({ projectRoot: f.projectRoot });
  assert.equal(f.list().find((i) => i.id === hot.id).hitCount, 1);
});

test("v1 SQLite projection is migrated without losing old cards", () => {
  const f = fixture();
  fs.mkdirSync(f.vaultDir, { recursive: true });
  const db = f.db();
  db.exec("CREATE TABLE memories(id TEXT PRIMARY KEY, project_slug TEXT NOT NULL, project_root TEXT, module TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, agent TEXT NOT NULL, tags_json TEXT NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
  db.prepare("INSERT INTO memories VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run("legacy", "project", f.projectRoot, "topics", "topic", "Legacy", "old body", "user", "[]", "hash", "2026-01-01", "2026-01-01");
  db.close();
  // An older project needs a proven ownership record; unbound database rows
  // remain preserved but cannot be attributed to an arbitrary same name.
  const legacyDir = path.join(f.vaultDir, "projects", "project"); fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, "_meta.json"), JSON.stringify({ slug: "project", projectRoot: f.projectRoot }));
  const item = f.list()[0];
  assert.equal(item.id, "legacy");
  assert.equal(item.version, 1);
  assert.equal(item.hitCount, 0);
  assert.deepEqual(item.history, []);
});

test("pc-lite write/rule/experience forward --supersedes and support consolidate --dry-run", () => {
  const f = fixture();
  const cli = (args) => execFileSync(process.execPath, [path.join(REPO, "scripts/pc-lite.mjs"), ...args,
    "--root", f.projectRoot, "--vault-dir", f.vaultDir, "--home-dir", f.homeDir, "--embed-url", "http://127.0.0.1:1/v1/embeddings"],
  { cwd: f.projectRoot, env: { ...process.env, HOME: f.homeDir, T3_HUB_DIR: path.join(f.base, "hub"), T3_MEMORY_VAULT_DIR: f.vaultDir }, encoding: "utf8" });
  const first = f.save({ content: "old CLI body" });
  cli(["write", "--title", "CLI", "--content", "new CLI body", "--supersedes", first.item.id]);
  assert.equal(f.list()[0].version, 2);
  cli(["rule", "--text", "new CLI rule", "--supersedes", first.item.id]);
  assert.equal(f.list()[0].version, 3);
  cli(["experience", "--situation", "context", "--action", "fix", "--outcome", "works", "--lesson", "new lesson", "--supersedes", first.item.id]);
  assert.equal(f.list()[0].version, 4);
  assert.equal(f.list()[0].module, "pitfalls");
  f.save({ module: "pitfalls", title: "new lesson", content: "new lesson context fix works extra", autoEvolve: false });
  const preview = JSON.parse(cli(["consolidate", "--dry-run"]));
  assert.equal(preview.dryRun, true);
  assert.equal(preview.pairs.length, 1);
  const result = JSON.parse(cli(["consolidate"]));
  assert.equal(result.ok, true);
  assert.equal(result.mergedCount, 1);
});

test("pc-lite Agent writes reject reserved tags and cannot supersede protected records; manual Hub edits remain available", () => {
  const f = fixture();
  const cli = (args) => execFileSync(process.execPath, [path.join(REPO, "scripts/pc-lite.mjs"), ...args,
    "--root", f.projectRoot, "--vault-dir", f.vaultDir, "--home-dir", f.homeDir, "--embed-url", "http://127.0.0.1:1/v1/embeddings"],
  { cwd: f.projectRoot, env: { ...process.env, HOME: f.homeDir, T3_HUB_DIR: path.join(f.base, "hub"), T3_MEMORY_VAULT_DIR: f.vaultDir }, encoding: "utf8" });
  const assertCliRejected = (args, pattern) => {
    assert.throws(() => cli(args), (error) => {
      const output = String(error.stdout || "") + String(error.stderr || "");
      assert.match(output, pattern);
      return true;
    });
  };

  const reservedTagWrites = [
    ["write", "--module", "topics", "--kind", "topic", "--title", "Agent core tag", "--content", "agent-created core tag body", "--tags", "  CoRe  "],
    ["rule", "--text", "agent-created pinned rule", "--tags", " PiNnEd "],
    ["experience", "--situation", "context", "--action", "fix", "--outcome", "works", "--lesson", "agent-created pinned experience", "--tags", "PINNED"],
  ];
  for (const args of reservedTagWrites) assertCliRejected(args, /reserved.*(?:core|pinned)|(?:core|pinned).*human/i);
  assert.equal(f.list().length, 0, "reserved-tag attempts must not create records");

  const pinned = f.save({ title: "Protected pinned", content: "human-owned pinned content", tags: ["pinned"], autoEvolve: false });
  const core = f.save({ title: "Protected core", content: "human-owned core content", tags: ["core"], autoEvolve: false });
  const protectedTargets = [pinned.item, core.item];
  const supersedingWrites = (target) => [
    ["write", "--module", "constraints", "--kind", "constraint", "--title", "replace " + target.title, "--content", "Agent replacement body for " + target.id, "--supersedes", target.id],
    ["rule", "--text", "Agent replacement rule for " + target.id, "--supersedes", target.id],
    ["experience", "--situation", "Agent replacement for " + target.id, "--action", "overwrite", "--outcome", "unexpected", "--lesson", "Agent replacement lesson", "--supersedes", target.id],
  ];
  for (const target of protectedTargets) {
    for (const args of supersedingWrites(target)) assertCliRejected(args, /protected memory/i);
  }
  const unchanged = f.list().find((item) => item.id === pinned.item.id);
  const unchangedCore = f.list().find((item) => item.id === core.item.id);
  assert.equal(unchanged.content, pinned.item.content);
  assert.equal(unchanged.version, pinned.item.version);
  assert.equal(unchangedCore.content, core.item.content);
  assert.equal(unchangedCore.version, core.item.version);

  const manualEdit = f.vault.saveMemory({ projectRoot: f.projectRoot, id: pinned.item.id, title: pinned.item.title,
    content: "human explicitly edited pinned content", tags: pinned.item.tags });
  assert.equal(manualEdit.ok, true, JSON.stringify(manualEdit));
  assert.equal(f.list().find((item) => item.id === pinned.item.id).content, "human explicitly edited pinned content");
});

test("MCP router exposes and executes memory_write evolution and memory_consolidate", async (t) => {
  const f = fixture();
  const child = spawn(process.execPath, [path.join(REPO, "bin/t3-mcp-router")], {
    cwd: f.projectRoot,
    env: { ...process.env, HOME: f.homeDir, T3_HUB_DIR: path.join(f.base, "hub"), T3_MEMORY_VAULT_DIR: f.vaultDir,
      T3_EMBED_URL: "http://127.0.0.1:1/v1/embeddings" }, stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  let buf = "", seq = 0;
  const pending = new Map();
  child.stderr.resume();
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let end;
    while ((end = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, end); buf = buf.slice(end + 1);
      let response; try { response = JSON.parse(line); } catch { continue; }
      pending.get(response.id)?.(response);
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("MCP request timed out: " + method)); }, 5000);
    pending.set(id, (response) => { clearTimeout(timer); pending.delete(id); resolve(response); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  const tools = (await request("tools/list", {})).result.tools;
  const writeDef = tools.find((tool) => tool.name === "memory_write");
  assert.equal(writeDef.inputSchema.properties.supersedesId.type, "string");
  assert.equal(writeDef.inputSchema.properties.autoEvolve.type, "boolean");
  assert.ok(tools.some((tool) => tool.name === "memory_consolidate"));
  assert.equal(tools.find(tool => tool.name === "memory_rollback").inputSchema.properties.revisionId.type, "string");
  const call = async (name, args) => {
    const response = await request("tools/call", { name, arguments: { projectRoot: f.projectRoot, ...args } });
    assert.ok(!response.error, JSON.stringify(response));
    return JSON.parse(response.result.content[0].text);
  };
  const first = await call("memory_write", { module: "constraints", title: "MCP", content: "MCP original", autoEvolve: false });
  const next = await call("memory_write", { module: "constraints", title: "MCP", content: "MCP current", supersedesId: first.item.id });
  assert.equal(next.action, "superseded");
  assert.equal(next.item.id, first.item.id);
  const pinned = f.vault.saveMemory({ projectRoot: f.projectRoot, module: "constraints", title: "Human-pinned rule", content: "Preserve this exact protected memory", tags: ["pinned"], autoEvolve: false });
  const refused = await call("memory_write", { module: "constraints", title: "Human-pinned rule", content: "Replace protected memory", supersedesId: pinned.item.id });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /protected memory/);
  assert.equal(f.list().find((item) => item.id === pinned.item.id).content, pinned.item.content);
  const tagged = await call("memory_write", { module: "constraints", title: "Agent-created core", content: "must not become core", tags: ["  CoRe  "] });
  assert.equal(tagged.ok, false);
  assert.match(tagged.error, /human-only/);
  assert.ok(!f.list().some((item) => item.title === "Agent-created core"));
  const core = f.vault.saveMemory({ projectRoot: f.projectRoot, module: "constraints", title: "Human-pinned rule", content: "Preserve this exact protected memory with a core note", tags: ["core"], autoEvolve: false });
  const consolidated = await call("memory_consolidate", {});
  assert.equal(consolidated.mergedCount, 0, "MCP consolidation must not merge protected records");
  assert.ok(f.list().some((item) => item.id === pinned.item.id));
  assert.ok(f.list().some((item) => item.id === core.item.id));
  const pinnedEditedByHuman = f.vault.saveMemory({ projectRoot: f.projectRoot, id: pinned.item.id, title: pinned.item.title, content: "Human explicitly edited this protected rule", tags: pinned.item.tags });
  assert.equal(pinnedEditedByHuman.ok, true);
  const protectedRollback = await call("memory_rollback", { id: pinned.item.id, targetVersion: 1 });
  assert.equal(protectedRollback.ok, false);
  assert.match(protectedRollback.error, /protected memory/);
  assert.equal(f.list().find((item) => item.id === pinned.item.id).content, pinnedEditedByHuman.item.content);
  const humanRollback = f.vault.rollbackMemory({ projectRoot: f.projectRoot, id: pinned.item.id, targetVersion: 1 });
  assert.equal(humanRollback.ok, true, "Hub's explicit human rollback remains available");
  assert.equal(humanRollback.item.content, pinned.item.content);
  assert.equal((await call("memory_consolidate", { dryRun: true })).dryRun, true);
  const rollback = await call("memory_rollback", { id: first.item.id, revisionId: next.item.history[0].revisionId, targetVersion: 999 });
  assert.equal(rollback.ok, true); assert.equal(rollback.item.content, "MCP original");
});

test("MCP memory_read finds old search hits by ID and stays inside selected project/worktree scopes", async (t) => {
  const f = fixture();
  const old = f.save({ title: "Ancient readable rule", content: "ancient-read-token original rule body", autoEvolve: false, autoConsolidateThreshold: 0 }).item;
  const edited = f.vault.saveMemory({ projectRoot: f.projectRoot, id: old.id, title: old.title, content: "ancient-read-token current rule body", autoEvolve: false, autoConsolidateThreshold: 0 });
  assert.equal(edited.ok, true);
  // Seed historical foreign scopes directly: current APIs cannot create them.
  const otherWorktree = { item: { id: "foreign-worktree-fixture" } };
  const global = { item: { id: "legacy-global-fixture" } };
  const seed = f.db();
  try {
    const insert = seed.prepare("INSERT INTO memories(id,project_slug,project_root,module,kind,title,content,agent,tags_json,content_hash,created_at,updated_at,memory_scope,worktree_id) VALUES(?, ?, ?, 'constraints','constraint',? ,?,'legacy','[]',?,'2026-01-01','2026-01-01',?,?)");
    insert.run(otherWorktree.item.id, old.projectSlug, f.projectRoot, "Other worktree only", "worktree-only-read-token", "foreign-wt", "worktree", "different-worktree");
    insert.run(global.item.id, "_global", null, "Global readable rule", "global-readable-token", "global-old", "global", "");
  } finally { seed.close(); }
  const projectB = path.join(f.base, "project-b");
  fs.mkdirSync(projectB, { recursive: true });
  const foreign = f.vault.saveMemory({ projectRoot: projectB, module: "constraints", title: "Project B only", content: "project-b-read-token", autoEvolve: false, autoConsolidateThreshold: 0 });
  assert.equal(foreign.ok, true);
  for (let i = 0; i < 205; i++) {
    const saved = f.vault.saveMemory({ projectRoot: f.projectRoot, module: "constraints", title: `Recent filler ${i}`, content: `filler-unique-token-${i} unrelated recent body`, autoEvolve: false, autoConsolidateThreshold: 0 });
    assert.equal(saved.ok, true, JSON.stringify(saved));
  }
  const recent = f.vault.listMemories({ projectRoot: f.projectRoot, includeGlobal: true, limit: 200 });
  assert.ok(!recent.items.some((item) => item.id === old.id), "target is outside the old 200-row recency fallback");

  const child = spawn(process.execPath, [path.join(REPO, "bin/t3-mcp-router")], {
    cwd: f.projectRoot,
    env: { ...process.env, HOME: f.homeDir, T3_HUB_DIR: path.join(f.base, "hub"), T3_MEMORY_VAULT_DIR: f.vaultDir,
      T3_EMBED_URL: "http://127.0.0.1:1/v1/embeddings" }, stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  let buf = "", seq = 0;
  const pending = new Map();
  child.stderr.resume();
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let end;
    while ((end = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, end); buf = buf.slice(end + 1);
      let response; try { response = JSON.parse(line); } catch { continue; }
      pending.get(response.id)?.(response);
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("MCP request timed out: " + method)); }, 5000);
    pending.set(id, (response) => { clearTimeout(timer); pending.delete(id); resolve(response); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  const call = async (name, args) => {
    const response = await request("tools/call", { name, arguments: args });
    assert.ok(!response.error, JSON.stringify(response));
    return JSON.parse(response.result.content[0].text);
  };

  const search = await call("memory_search", { projectRoot: f.projectRoot, query: "ancient-read-token", limit: 5 });
  const hit = search.items.find((item) => item.id === old.id);
  assert.ok(hit, "search still finds the target outside the most-recent 200 rows");
  assert.equal(Object.hasOwn(hit, "history"), false);
  const read = await call("memory_read", { projectRoot: f.projectRoot, id: old.id });
  assert.equal(read.ok, true);
  assert.equal(read.item.content, "ancient-read-token current rule body");
  assert.equal(read.item.history[0].content, "ancient-read-token original rule body");

  const foreignAtA = await call("memory_read", { projectRoot: f.projectRoot, id: foreign.item.id });
  assert.equal(foreignAtA.ok, false, "an ID from another project is not returned in the selected project context");
  assert.equal(foreignAtA.item, null);
  const otherWorktreeAtMain = await call("memory_read", { projectRoot: f.projectRoot, id: otherWorktree.item.id });
  assert.equal(otherWorktreeAtMain.ok, false, "other worktree memories are outside the current auto scope");
  const globalRead = await call("memory_read", { projectRoot: f.projectRoot, id: global.item.id });
  assert.equal(globalRead.ok, false, "global scope is unavailable from a project context");
  const searchB = await request("tools/call", { name: "memory_search", arguments: { projectRoot: projectB, query: "project-b-read-token" } });
  assert.ok(searchB.error, "a process bound to project A cannot select project B");
  const readB = await request("tools/call", { name: "memory_read", arguments: { projectRoot: projectB, id: foreign.item.id } });
  assert.ok(readB.error, "a process bound to project A cannot read project B by ID");
});

test("listMemories keeps an exact ID filter through semantic query candidates", () => {
  const f = fixture((texts) => texts.map(() => [1, 0]));
  const target = f.save({ title: "Exact target", content: "target payload", autoEvolve: false }).item;
  const other = f.save({ title: "Other candidate", content: "other payload", autoEvolve: false }).item;
  const result = f.vault.listMemories({ projectRoot: f.projectRoot, id: target.id, query: "no lexical hit at all", limit: 20 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.items.map((item) => item.id), [target.id]);
  assert.ok(!result.items.some((item) => item.id === other.id));
});


test("consolidated histories have unique stable revisions and unambiguous rollback versions", () => {
  const f = fixture();
  const a = f.save({ title: "Build rule", content: "alpha original", autoEvolve: false }).item;
  const b = f.save({ title: "Build rule", content: "beta original", autoEvolve: false }).item;
  const ae = f.save({ id: a.id, title: "Build rule", content: "alpha current" }).item;
  const be = f.save({ id: b.id, title: "Build rule", content: "beta current" }).item;
  assert.equal(ae.history[0].version, 1); assert.equal(be.history[0].version, 1);
  assert.ok(ae.history[0].revisionId); assert.ok(be.history[0].revisionId);
  const merged = f.vault.consolidateMemories({ projectRoot: f.projectRoot });
  assert.equal(merged.ok, true); assert.equal(merged.mergedCount, 1);
  const item = merged.items[0];
  assert.deepEqual(item.history.map(h => h.version), [1, 2, 3, 4]);
  assert.equal(new Set(item.history.map(h => h.revisionId)).size, 4);
  assert.equal(item.version, 5);
  const ah = item.history.find(h => h.revisionId === ae.history[0].revisionId);
  const bh = item.history.find(h => h.revisionId === be.history[0].revisionId);
  assert.equal(ah.sourceVersion, 1); assert.equal(bh.sourceVersion, 1);
  const restored = createMemoryVault({ homeDir: f.homeDir, vaultDir: f.vaultDir, _embedFn: () => null });
  restored.syncFromMarkdownIfChanged({ projectRoot: f.projectRoot });
  assert.deepEqual(restored.listMemories({ projectRoot: f.projectRoot }).items[0].history, item.history);
  // revisionId takes precedence over a conflicting numeric selector.
  const ra = restored.rollbackMemory({ projectRoot: f.projectRoot, id: item.id, revisionId: ah.revisionId, targetVersion: bh.version });
  assert.equal(ra.ok, true); assert.equal(ra.item.content, "alpha original");
  const rb = restored.rollbackMemory({ projectRoot: f.projectRoot, id: item.id, targetVersion: bh.version });
  assert.equal(rb.ok, true); assert.equal(rb.item.content, "beta original");
  assert.equal(restored.rollbackMemory({ projectRoot: f.projectRoot, id: item.id, revisionId: "absent", targetVersion: ah.version }).ok, false);
});


test("legacy histories receive stable IDs and duplicate numeric versions require a revision selector", () => {
  const f = fixture();
  const a = f.save({ content: "current" }).item;
  const md = fs.readFileSync(f.md(), "utf8").replace(/^<!-- meta:.*-->$/m, `<!-- meta: ${JSON.stringify({ version: 2, history: [
    { version: 1, title: "first", content: "legacy alpha", agent: "user" },
    { version: 1, title: "second", content: "legacy beta", agent: "user" },
  ] })} -->`);
  fs.writeFileSync(f.md(), md);
  f.vault.syncFromMarkdownIfChanged({ projectRoot: f.projectRoot });
  const history = f.list()[0].history;
  assert.equal(new Set(history.map(h => h.revisionId)).size, 2);
  assert.deepEqual(f.list()[0].history, history);
  assert.equal(f.vault.rollbackMemory({ projectRoot: f.projectRoot, id: a.id, targetVersion: 1 }).ok, false);
  const result = f.vault.rollbackMemory({ projectRoot: f.projectRoot, id: a.id, revisionId: history[0].revisionId });
  assert.equal(result.ok, true); assert.equal(result.item.content, "legacy alpha");
  assert.equal(f.list()[0].history[0].revisionId, history[0].revisionId);
});


test("memory drawer keeps the selected revision ID from history button through rollback RPC", async () => {
  const source = fs.readFileSync(path.join(REPO, "src/hub-drawer-ui.js"), "utf8");
  const extract = name => {
    const start = source.search(new RegExp(`    (?:async )?function ${name}\\(`));
    assert.ok(start >= 0);
    const rest = source.slice(start);
    return rest.slice(0, rest.slice(1).search(/\n    (?:async )?function /) + 1);
  };
  const calls = [], buttons = [];
  const dependencies = {
    items: item => item.history, memoryId: item => item.id, memoryDraftKey: id => id,
    state: { historyExpanded: {}, tab: "plugins" }, esc: String, icon: () => "", tr: zh => zh,
    button: (action, label, options) => { buttons.push(options.attrs); return `<button data-action="${action}" ${options.attrs}>${label}</button>`; },
    memorySelection: () => "project", selectedMemoryRoot: () => "/sandbox/project", memoryWriteReady: () => true, drafts: {},
    busy: async (key, element, action) => action(), request: async (action, payload) => calls.push({ action, payload }),
    disposed: false, renderChrome: () => {}, toast: () => {},
    exactTimeMarkup: value => String(value || ""),
  };
  const ui = new Function(...Object.keys(dependencies), extract("renderMemoryHistory") + extract("rollbackMemory") + ";return {renderMemoryHistory, rollbackMemory};")(...Object.values(dependencies));
  const html = ui.renderMemoryHistory({ id: "memory", history: [{ version: 1, revisionId: "revision-a", content: "alpha" }, { version: 1, revisionId: "revision-b", content: "beta" }] });
  assert.match(html, /data-revision-id="revision-a"/); assert.match(html, /data-revision-id="revision-b"/);
  const selected = buttons[1].match(/data-revision-id="([^"]+)"/)[1];
  await ui.rollbackMemory("memory", 1, selected, {});
  assert.deepEqual(calls, [{ action: "memory:rollback", payload: { projectRoot: "/sandbox/project", id: "memory", targetVersion: 1, revisionId: "revision-b" } }]);
});

test("consolidating a high-version memory never regresses version numbers or creates duplicate history versions", () => {
  const f = fixture();
  let high = f.save({ title: "Port rule", content: "use port 8001 step 1", autoEvolve: false }).item;
  for (let i = 2; i <= 16; i++) {
    high = f.save({ id: high.id, title: "Port rule", content: "use port 8001 step " + i }).item;
  }
  assert.equal(high.version, 16);
  const low = f.save({ title: "Port rule", content: "use port 8001 step 16 with extra detail", autoEvolve: false }).item;
  const low2 = f.save({ id: low.id, title: "Port rule", content: "use port 8001 step 16 with extra detail v2" }).item;
  assert.equal(low2.version, 2);

  const merged = f.vault.consolidateMemories({ projectRoot: f.projectRoot });
  assert.equal(merged.ok, true);
  assert.equal(merged.mergedCount, 1);
  const item = merged.items[0];
  assert.ok(item.version > 16, "merged version must strictly exceed previous max version 16, got " + item.version);
  const versions = item.history.map((h) => h.version);
  for (let i = 1; i < versions.length; i++) {
    assert.ok(versions[i] > versions[i - 1], "history versions must be strictly increasing: " + JSON.stringify(versions));
  }
  assert.ok(versions.at(-1) < item.version, "all history versions must be strictly less than active item.version");
  const next = f.save({ id: item.id, title: "Port rule", content: "use port 8001 step 17 after merge" }).item;
  assert.equal(next.version, item.version + 1);
});
