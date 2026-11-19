"use strict";
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3-project-memory-")));
process.env.T3_MEMORY_VAULT_DIR = path.join(tmp, "default-vault");
process.env.T3_HUB_DIR = path.join(tmp, "default-hub");
const { createMemoryVault, resolveSessionProjectRoot } = require("../src/memory-vault.cjs");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let count = 0;
function fixture() {
  const dir = path.join(tmp, String(++count));
  const rootA = path.join(dir, "one", "same"), rootB = path.join(dir, "two", "same"), homeDir = path.join(dir, "home"), vaultDir = path.join(dir, "vault");
  for (const dirPath of [rootA, rootB, homeDir]) fs.mkdirSync(dirPath, { recursive: true });
  const options = { homeDir, vaultDir, _embedFn: texts => texts.map(() => [1, 0]), _healthFn: () => ({ modelId: "fixture", dim: 2 }), autoConsolidateThreshold: 0 };
  const v = createMemoryVault(options);
  const save = (args) => { const r = v.saveMemory({ module: "pitfalls", title: "sharedneedle", content: "sharedneedle durable fixture", autoEvolve: false, ...args }); assert.equal(r.ok, true, JSON.stringify(r)); return r.item; };
  const A = save({ projectRoot: rootA, content: "sharedneedle content A" });
  const B = save({ projectRoot: rootB, content: "sharedneedle content B" });
  // Seed legacy data directly, including a global-scoped anomaly stored under
  // a project slug. Production APIs no longer provide global writes.
  v._ensureProjectVault("_global", {});
  const G = { id: "mem_legacy_global", projectSlug: "_global" };
  const anomaly = { id: "mem_legacy_bad_scope", projectSlug: A.projectSlug };
  const db = new DatabaseSync(path.join(vaultDir, "index.sqlite"));
  for (const item of [G, anomaly]) {
    const content = "sharedneedle global old";
    db.prepare("INSERT INTO memories(id,project_slug,project_root,module,kind,title,content,agent,tags_json,content_hash,created_at,updated_at,memory_scope) VALUES(?,?,NULL,'pitfalls','pitfall','sharedneedle',?,'legacy','[]','fixture','2026-01-01','2026-01-01','global')").run(item.id, item.projectSlug, content);
    db.prepare("INSERT INTO memories_fts(id,title,content,tags) VALUES(?,?,?,?)").run(item.id, "sharedneedle", content, "[]");
    db.prepare("INSERT INTO memory_vectors(id,model_id,dim,vec_f32,updated_at) VALUES(?,'fixture',2,?,'2026-01-01')").run(item.id, Buffer.from(new Float32Array([1, 0]).buffer));
  }
  db.close();
  const md = path.join(vaultDir, "global", "pitfalls.md");
  const snapshot = fs.readFileSync(md);
  return { dir, rootA, rootB, homeDir, vaultDir, A, B, G, anomaly, md, snapshot, v };
}

test("all read paths isolate same-named projects and never include old global records", () => {
  const f = fixture();
  assert.notEqual(f.A.projectSlug, f.B.projectSlug);
  for (const projectRoot of [f.rootA, f.rootB]) for (const query of ["", "sharedneedle", "semantic-only-query"]) for (const opts of [{}, { includeGlobal: true }, { scopeFilter: "all", includeGlobal: true }, { scopeFilter: "shared" }]) {
    const r = f.v.listMemories({ projectRoot, query, trackHits: false, ...opts });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(r.items.every(i => i.projectSlug === (projectRoot === f.rootA ? f.A.projectSlug : f.B.projectSlug)));
    if (query !== "semantic-only-query") assert.ok(r.items.some(i => i.id === (projectRoot === f.rootA ? f.A.id : f.B.id)));
  }
  assert.equal(f.v.listMemories({ projectRoot: f.rootA, id: f.G.id }).items.length, 0);
  assert.equal(f.v.listMemories({ projectRoot: f.rootA, id: f.anomaly.id, scopeFilter: "all" }).items.length, 0);
  assert.equal(f.v.listMemories({ projectRoot: f.rootA, id: f.B.id }).items.length, 0);
  assert.deepEqual(fs.readFileSync(f.md), f.snapshot);
});

test("missing or spoofed project identity and global mode fail closed for reads and writes", () => {
  const f = fixture();
  for (const args of [{}, { projectRoot: "/" }, { projectRoot: path.join(f.dir, "missing") }, { projectRoot: f.rootA, projectSlug: f.B.projectSlug }, { projectRoot: f.rootA, scope: "global" }, { projectRoot: f.rootA, scopeFilter: "global" }, { projectRoot: f.rootA, projectSlug: "_global" }]) {
    assert.equal(f.v.listMemories(args).ok, false, JSON.stringify(args));
    assert.equal(f.v.saveMemory({ module: "topics", title: "guard", content: "guard fixture", ...args }).ok, false, JSON.stringify(args));
  }
  assert.deepEqual(fs.readFileSync(f.md), f.snapshot);
});

test("id mutations and overview cannot operate on another project or global data", () => {
  const f = fixture();
  const overview = f.v.getOverview({ projectRoot: f.rootA });
  assert.equal(overview.ok, true);
  assert.equal(overview.totalMemories, 1);
  assert.deepEqual(overview.projects.map(p => p.slug), [f.A.projectSlug]);
  assert.equal(f.v.getOverview({}).ok, false);
  for (const id of [f.B.id, f.G.id, f.anomaly.id]) {
    assert.notEqual(f.v.deleteMemory({ projectRoot: f.rootA, id }).deleted, true);
    assert.equal(f.v.pinToAgentsMd({ projectRoot: f.rootA, id }).ok, false);
    assert.equal(f.v.promoteWorktreeMemory({ projectRoot: f.rootA, id }).ok, false);
    assert.equal(f.v.rollbackMemory({ projectRoot: f.rootA, id }).ok, false);
  }
  assert.equal(f.v.deleteMemory({ id: f.A.id }).ok, false);
  assert.equal(f.v.consolidateMemories({ projectSlug: f.A.projectSlug }).ok, false);
  assert.equal(f.v.getMemoryHealth({ projectRoot: f.rootA }).total, 1);
  assert.equal(f.v.getStats({ projectRoot: f.rootA }).vectorStats.totalMemories, 1);
  assert.deepEqual(fs.readFileSync(f.md), f.snapshot);
});

test("legacy unscoped bulk maintenance and cross-host migration cannot rewrite old data", () => {
  const f = fixture();
  assert.equal(f.v.importHostMemories({ projectRoot: f.rootA }).ok, false);
  assert.equal(f.v.migrateFromPowerContext({ projectRoot: f.rootA }).ok, false);
  assert.equal(f.v.runHygiene({ projectRoot: f.rootA }).ok, false);
  assert.equal(f.v.reindexVectors({}).ok, false);
  assert.deepEqual(fs.readFileSync(f.md), f.snapshot);
});

test("linked worktree uses its own project's shared memories without global fallback", () => {
  const f = fixture();
  const git = (...args) => execFileSync("git", args, { stdio: "ignore", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  git("init", "-b", "main", f.rootA); fs.writeFileSync(path.join(f.rootA, "x"), "fixture"); git("-C", f.rootA, "add", "x");
  git("-C", f.rootA, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture");
  const linked = path.join(f.dir, "linked"); git("-C", f.rootA, "worktree", "add", "-b", "work", linked);
  const linkedProject = f.v.ensureProject({ projectRoot: linked });
  assert.equal(linkedProject.ok, true, JSON.stringify(linkedProject));
  assert.equal(linkedProject.slug, f.A.projectSlug);
  const linkedMemory = f.v.ensureProjectMemoryLink(linked);
  assert.equal(linkedMemory.ok, true, JSON.stringify(linkedMemory));
  const list = f.v.listMemories({ projectRoot: linked, query: "sharedneedle", includeGlobal: true, trackHits: false });
  assert.equal(list.ok, true); assert.deepEqual(list.items.map(i => i.id), [f.A.id]);
});

test("current worktree cannot read, change or overwrite a sibling's unsynced memory", async () => {
  const f = fixture();
  const git = (...args) => execFileSync("git", args, { stdio: "ignore", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  git("init", "-b", "main", f.rootA); fs.writeFileSync(path.join(f.rootA, "x"), "fixture"); git("-C", f.rootA, "add", "x");
  git("-C", f.rootA, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture");
  const linked = path.join(f.dir, "linked"); git("-C", f.rootA, "worktree", "add", "-b", "work", linked);
  const w = f.v.saveMemory({ projectRoot: linked, module: "pitfalls", title: "worktree private", content: "worktree fixture only", scope: "worktree", autoEvolve: false });
  assert.equal(w.ok, true, JSON.stringify(w));
  const wtFile = path.join(f.vaultDir, "projects", f.A.projectSlug, "_worktrees", w.item.worktreeId, "pitfalls.md");
  fs.writeFileSync(wtFile, fs.readFileSync(wtFile, "utf8").replace("worktree fixture only", "worktree unsynced private edit"));
  const siblingBefore = fs.readFileSync(wtFile);
  const projectFile = path.join(f.vaultDir, "projects", f.A.projectSlug, "pitfalls.md"); fs.appendFileSync(projectFile, "\n");
  for (const query of ["", "worktree", "semantic query"]) {
    const r = f.v.listMemories({ projectRoot: f.rootA, scopeFilter: "all", query });
    assert.equal(r.ok, true, JSON.stringify(r)); assert.ok(!r.items.some(item => item.id === w.item.id));
  }
  assert.equal(f.v.getOverview({ projectRoot: f.rootA }).totalMemories, 1);
  assert.equal(f.v.getMemoryHealth({ projectRoot: f.rootA }).total, 1);
  assert.equal(f.v.getStats({ projectRoot: f.rootA }).vectorStats.totalMemories, 1);
  assert.notEqual(f.v.deleteMemory({ projectRoot: f.rootA, id: w.item.id }).deleted, true);
  assert.equal(f.v.promoteWorktreeMemory({ projectRoot: f.rootA, id: w.item.id }).ok, false);
  assert.equal(f.v.rollbackMemory({ projectRoot: f.rootA, id: w.item.id }).ok, false);
  assert.equal(f.v.pinToAgentsMd({ projectRoot: f.rootA, id: w.item.id }).ok, false);
  assert.equal(f.v.saveMemory({ projectRoot: f.rootA, id: w.item.id, title: "overwrite", content: "wrong" }).ok, false);
  assert.deepEqual(fs.readFileSync(wtFile), siblingBefore);
  const extra = f.v.saveMemory({ projectRoot: f.rootA, module: "pitfalls", title: "shared extra", content: "main worktree fixture extra", autoEvolve: false });
  assert.equal(extra.ok, true, JSON.stringify(extra));
  const consolidated = f.v.consolidateMemories({ projectRoot: f.rootA });
  assert.equal(consolidated.ok, true, JSON.stringify(consolidated));
  assert.deepEqual(fs.readFileSync(wtFile), siblingBefore, "saving and consolidation must not rewrite a sibling");
  const vectorInputs = [];
  const spy = createMemoryVault({ homeDir: f.homeDir, vaultDir: f.vaultDir, _healthFn: () => ({ modelId: "new-fixture", dim: 2 }), _embedFn: texts => { vectorInputs.push(...texts); return texts.map(() => [1, 0]); } });
  const reindex = spy.reindexVectors({ projectRoot: f.rootA, targetModelId: "new-fixture" });
  assert.equal(reindex.ok, true, JSON.stringify(reindex)); assert.equal((await reindex.promise).ok, true);
  assert.ok(vectorInputs.every(text => !/worktree private|worktree fixture only|worktree unsynced private edit|global old/.test(text)), "reindex must not read sibling/global text");
  assert.deepEqual(fs.readFileSync(wtFile), siblingBefore);
  const linkedRead = f.v.listMemories({ projectRoot: linked, id: w.item.id });
  assert.equal(linkedRead.ok, true, JSON.stringify(linkedRead)); assert.equal(linkedRead.items[0].content, "worktree unsynced private edit");
  const db = new DatabaseSync(path.join(f.vaultDir, "index.sqlite"));
  try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memories WHERE id=?").get(f.anomaly.id).n, 1); } finally { db.close(); }
  assert.deepEqual(fs.readFileSync(f.md), f.snapshot);
});

test("a pasted foreign ID fails closed without rewriting either project's records", () => {
  const f = fixture();
  const fileA = path.join(f.vaultDir, "projects", f.A.projectSlug, "pitfalls.md");
  const fileB = path.join(f.vaultDir, "projects", f.B.projectSlug, "pitfalls.md");
  const contentB = fs.readFileSync(fileB, "utf8");
  fs.appendFileSync(fileA, "\n" + contentB);
  const input = fs.readFileSync(fileA);
  const result = f.v.listMemories({ projectRoot: f.rootA });
  assert.equal(result.ok, false);
  assert.match(result.error, /another scope/);
  assert.deepEqual(fs.readFileSync(fileA), input);
  assert.deepEqual(fs.readFileSync(fileB), Buffer.from(contentB));
  assert.equal(f.v.listMemories({ projectRoot: f.rootB, id: f.B.id }).items[0].id, f.B.id);
  assert.deepEqual(fs.readFileSync(f.md), f.snapshot);
});

test("id-less identical Markdown in distinct projects receives distinct IDs", () => {
  const f = fixture();
  for (const slug of [f.A.projectSlug, f.B.projectSlug]) {
    const file = path.join(f.vaultDir, "projects", slug, "topics.md");
    fs.appendFileSync(file, "\n## Same manual topic\n\nidentical manual text\n");
  }
  const a = f.v.listMemories({ projectRoot: f.rootA, module: "topics" });
  const b = f.v.listMemories({ projectRoot: f.rootB, module: "topics" });
  assert.equal(a.ok, true, JSON.stringify(a)); assert.equal(b.ok, true, JSON.stringify(b));
  assert.equal(a.items.length, 1); assert.equal(b.items.length, 1);
  assert.notEqual(a.items[0].id, b.items[0].id);
});

test("pending old multi-project transaction is left untouched and project operations fail closed", () => {
  const f = fixture();
  const state = path.join(f.vaultDir, "_state"); fs.mkdirSync(state, { recursive: true });
  const journal = path.join(state, "dream-tx-journal.json");
  const original = Buffer.from('{"legacy":"retain unchanged"}\n'); fs.writeFileSync(journal, original);
  const fresh = createMemoryVault({ vaultDir: f.vaultDir, homeDir: f.homeDir, _embedFn: () => null });
  assert.deepEqual(fs.readFileSync(journal), original);
  assert.equal(fresh.listMemories({ projectRoot: f.rootA }).ok, false);
  assert.equal(fresh.saveMemory({ projectRoot: f.rootA, title: "guard", content: "guard" }).ok, false);
  assert.deepEqual(fs.readFileSync(journal), original);
  assert.deepEqual(fs.readFileSync(f.md), f.snapshot);
});

test("separate T3 projects in one Git repo stay distinct across linked worktrees", () => {
  const f = fixture();
  const git = (...args) => execFileSync("git", args, { stdio: "ignore", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  const repo = path.join(f.dir, "repo"), a = path.join(repo, "service-a"), b = path.join(repo, "service-b");
  fs.mkdirSync(a, { recursive: true }); fs.mkdirSync(b, { recursive: true });
  git("init", "-b", "main", repo); fs.writeFileSync(path.join(a, "x"), "A"); fs.writeFileSync(path.join(b, "x"), "B"); git("-C", repo, "add", ".");
  git("-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture");
  const linked = path.join(f.dir, "repo-linked"); git("-C", repo, "worktree", "add", "-b", "other", linked);
  assert.equal(resolveSessionProjectRoot({ projectRoot: a }), fs.realpathSync(a));
  assert.equal(resolveSessionProjectRoot({ projectRoot: a, worktreePath: linked }), fs.realpathSync(path.join(linked, "service-a")));
  assert.equal(resolveSessionProjectRoot({ projectRoot: a, worktreePath: path.join(linked, "service-a") }), fs.realpathSync(path.join(linked, "service-a")));
  assert.throws(() => resolveSessionProjectRoot({ projectRoot: a, worktreePath: path.join(linked, "service-b") }), /mismatch/);
  assert.throws(() => resolveSessionProjectRoot({ projectRoot: a, worktreePath: f.rootB }), /another project repository/);
  const missingOnLinked = path.join(repo, "untracked-only"); fs.mkdirSync(missingOnLinked);
  assert.throws(() => resolveSessionProjectRoot({ projectRoot: missingOnLinked, worktreePath: linked }), /absent/);
  const saveA = f.v.saveMemory({ projectRoot: a, title: "service A", content: "separate project A", autoEvolve: false });
  const saveB = f.v.saveMemory({ projectRoot: b, title: "service B", content: "separate project B", autoEvolve: false });
  assert.equal(saveA.ok, true, JSON.stringify(saveA)); assert.equal(saveB.ok, true, JSON.stringify(saveB));
  assert.notEqual(saveA.item.projectSlug, saveB.item.projectSlug);
  for (const [root, good, other] of [[a, saveA.item, saveB.item], [b, saveB.item, saveA.item], [path.join(linked, "service-a"), saveA.item, saveB.item], [path.join(linked, "service-b"), saveB.item, saveA.item]]) {
    const r = f.v.listMemories({ projectRoot: root, scopeFilter: "all" });
    assert.equal(r.ok, true, JSON.stringify(r)); assert.deepEqual(r.items.map(i => i.id), [good.id]);
    assert.equal(f.v.listMemories({ projectRoot: root, id: other.id }).items.length, 0);
  }
});

test("a colliding legacy suffix and a project named _global remain isolated", () => {
  const f = fixture();
  const c = path.join(f.dir, "three", "same"); fs.mkdirSync(c, { recursive: true });
  const crypto = require("node:crypto");
  const hash = crypto.createHash("sha256").update(fs.realpathSync(c)).digest("hex");
  const occupied = path.join(f.vaultDir, "projects", `same-${hash.slice(0, 6)}`);
  assert.ok(!fs.existsSync(occupied)); fs.mkdirSync(occupied);
  fs.writeFileSync(path.join(occupied, "_meta.json"), JSON.stringify({ projectRoot: f.rootB }));
  const save = f.v.saveMemory({ projectRoot: c, title: "C", content: "only C", autoEvolve: false });
  assert.equal(save.ok, true, JSON.stringify(save)); assert.equal(save.item.projectSlug, `same-${hash}`);
  const reserved = path.join(f.dir, "other", "_global"); fs.mkdirSync(reserved, { recursive: true });
  const d = f.v.saveMemory({ projectRoot: reserved, title: "D", content: "only D", autoEvolve: false });
  assert.equal(d.ok, true, JSON.stringify(d)); assert.notEqual(d.item.projectSlug, "_global");
  assert.deepEqual(fs.readFileSync(f.md), f.snapshot);
});

test("public sync requires bound project identity and refuses a foreign slug", () => {
  const f = fixture();
  assert.equal(f.v.syncFromMarkdownIfChanged({}).ok, false);
  assert.equal(f.v.syncFromMarkdownIfChanged({ projectRoot: f.rootA, projectSlug: f.B.projectSlug }).ok, false);
  assert.equal(f.v.syncFromMarkdownIfChanged({ projectRoot: f.rootA }).ok, true);
  assert.deepEqual(fs.readFileSync(f.md), f.snapshot);
});

test("pinning never reads or replaces an AGENTS.md link and leaves the target untouched", () => {
  const f = fixture(), external = path.join(f.dir, "other-rules.md"), link = path.join(f.rootA, "AGENTS.md");
  fs.writeFileSync(external, "private outside fixture\n"); fs.symlinkSync(external, link);
  const originalOpen = fs.openSync; let attemptedOpen = false;
  fs.openSync = function(file, ...args) { if (String(file) === link) attemptedOpen = true; return originalOpen.call(this, file, ...args); };
  try { assert.equal(f.v.pinToAgentsMd({ projectRoot: f.rootA, id: f.A.id }).ok, false); }
  finally { fs.openSync = originalOpen; }
  assert.equal(attemptedOpen, false); assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(link), external); assert.equal(fs.readFileSync(external, "utf8"), "private outside fixture\n");
});

test("pinning an ordinary project AGENTS.md preserves prior text and is idempotent", () => {
  const f = fixture(), file = path.join(f.rootA, "AGENTS.md"); fs.writeFileSync(file, "# Project\n\nExisting rule.\n");
  assert.equal(f.v.pinToAgentsMd({ projectRoot: f.rootA, id: f.A.id }).ok, true);
  const first = fs.readFileSync(file, "utf8"); assert.match(first, /Existing rule/); assert.match(first, /pinned:mem_/);
  assert.equal(f.v.pinToAgentsMd({ projectRoot: f.rootA, id: f.A.id }).ok, true); assert.equal(fs.readFileSync(file, "utf8"), first);
});

test("colliding and recreated Git worktrees never inherit unverified legacy private records", () => {
  const f = fixture();
  const git = (...args) => execFileSync("git", args, { stdio: "ignore", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  git("init", "-b", "main", f.rootA); fs.writeFileSync(path.join(f.rootA, "x"), "fixture"); git("-C", f.rootA, "add", "x");
  git("-C", f.rootA, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture");
  const a = path.join(f.dir, "alpha+beta"), b = path.join(f.dir, "alphabeta");
  git("-C", f.rootA, "worktree", "add", "-b", "first", a);
  git("-C", f.rootA, "worktree", "add", "-b", "second", b);
  const saveA = f.v.saveMemory({ projectRoot: a, scope: "worktree", title: "A private", content: "A private fixture", autoEvolve: false });
  const saveB = f.v.saveMemory({ projectRoot: b, scope: "worktree", title: "B private", content: "B private fixture", autoEvolve: false });
  assert.equal(saveA.ok, true, JSON.stringify(saveA)); assert.equal(saveB.ok, true, JSON.stringify(saveB));
  assert.match(saveA.item.worktreeId, /^~[a-f0-9]{64}$/); assert.notEqual(saveA.item.worktreeId, saveB.item.worktreeId);
  assert.equal(f.v.listMemories({ projectRoot: b, id: saveA.item.id, scopeFilter: "all" }).items.length, 0);
  const db = new DatabaseSync(path.join(f.vaultDir, "index.sqlite"));
  try {
    db.prepare("INSERT INTO memories(id,project_slug,project_root,module,kind,title,content,agent,tags_json,content_hash,created_at,updated_at,memory_scope,worktree_id) VALUES('old-ambiguous',?,?, 'pitfalls','pitfall','Legacy','legacy private','legacy','[]','legacy','2026-01-01','2026-01-01','worktree','alphabeta')").run(f.A.projectSlug, f.rootA);
  } finally { db.close(); }
  assert.equal(f.v.listMemories({ projectRoot: b, id: "old-ambiguous", scopeFilter: "all" }).items.length, 0);
  git("-C", f.rootA, "worktree", "remove", a);
  git("-C", f.rootA, "worktree", "add", "-b", "recreated", a);
  const fresh = f.v.listMemories({ projectRoot: a, id: saveA.item.id, scopeFilter: "all" });
  assert.equal(fresh.ok, true, JSON.stringify(fresh)); assert.equal(fresh.items.length, 0);
  const check = new DatabaseSync(path.join(f.vaultDir, "index.sqlite"));
  try {
    assert.equal(check.prepare("SELECT COUNT(*) AS n FROM memories WHERE id='old-ambiguous'").get().n, 1);
    assert.equal(check.prepare("SELECT COUNT(*) AS n FROM memories WHERE id=?").get(saveA.item.id).n, 1);
  } finally { check.close(); }
});

test("pinning never reads or replaces a hard-linked AGENTS.md", () => {
  const f = fixture(), external = path.join(f.dir, "hard-linked-rules.md"), file = path.join(f.rootA, "AGENTS.md");
  fs.writeFileSync(external, "shared inode fixture\n"); fs.linkSync(external, file);
  const before = fs.statSync(external); assert.equal(before.nlink, 2);
  assert.equal(f.v.pinToAgentsMd({ projectRoot: f.rootA, id: f.A.id }).ok, false);
  const after = fs.statSync(file); assert.equal(after.ino, before.ino); assert.equal(after.nlink, 2);
  assert.equal(fs.readFileSync(external, "utf8"), "shared inode fixture\n");
});

test("main Git and non-Git projects can persist their own worktree-private memories", () => {
  const f = fixture();
  const plain = f.v.saveMemory({ projectRoot: f.rootA, scope: "worktree", title: "Plain private", content: "plain private content", autoEvolve: false });
  assert.equal(plain.ok, true, JSON.stringify(plain)); assert.match(plain.item.worktreeId, /^~[a-f0-9]{64}$/);
  assert.equal(f.v.listMemories({ projectRoot: f.rootA, id: plain.item.id }).items[0].id, plain.item.id);
  const repo = path.join(f.dir, "main-repo"); fs.mkdirSync(repo);
  const git = (...args) => execFileSync("git", args, { stdio: "ignore", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  git("init", "-b", "main", repo); fs.writeFileSync(path.join(repo, "x"), "fixture"); git("-C", repo, "add", "x");
  git("-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture");
  const linked = path.join(f.dir, "linked-main-check"); git("-C", repo, "worktree", "add", "-b", "linked-check", linked);
  const main = f.v.saveMemory({ projectRoot: repo, scope: "worktree", title: "Main private", content: "main private content", autoEvolve: false });
  assert.equal(main.ok, true, JSON.stringify(main)); assert.match(main.item.worktreeId, /^~[a-f0-9]{64}$/);
  assert.equal(f.v.listMemories({ projectRoot: repo, id: main.item.id }).items[0].id, main.item.id);
  assert.equal(f.v.listMemories({ projectRoot: linked, id: main.item.id, scopeFilter: "all" }).items.length, 0);
});

test("concurrent first access atomically claims project identity across all entry points", async () => {
  const crypto = require("node:crypto");
  for (const operation of ["save", "list", "overview", "health", "stats", "delete", "pin", "rollback", "consolidate", "promote", "ensure", "link", "sync", "reindex"]) {
    const dir = path.join(tmp, `race-${operation}`), rootA = path.join(dir, "one", "same"), rootB = path.join(dir, "two", "same"), vaultDir = path.join(dir, "vault"), homeDir = path.join(dir, "home");
    for (const entry of [rootA, rootB, homeDir]) fs.mkdirSync(entry, { recursive: true });
    const opts = { homeDir, vaultDir, _embedFn: () => null, _healthFn: () => ({ modelId: "fixture", dim: 2 }), autoConsolidateThreshold: 0 };
    const vault = createMemoryVault(opts), ownerA = createMemoryVault(opts);
    const fullHash = crypto.createHash("sha256").update(fs.realpathSync(rootB)).digest("hex");
    const point = path.join(vaultDir, "projects", `same-${fullHash}`), nativeLstat = fs.lstatSync;
    let triggered = false, savedA;
    fs.lstatSync = function(file, ...rest) {
      if (!triggered && String(file) === point) {
        triggered = true;
        savedA = ownerA.saveMemory({ projectRoot: rootA, id: "known-race-id", title: "owner A", content: "private project A", autoEvolve: false });
      }
      return nativeLstat.call(this, file, ...rest);
    };
    let result;
    try {
      const actions = {
        save: () => vault.saveMemory({ projectRoot: rootB, title: "owner B", content: "private project B", autoEvolve: false }),
        list: () => vault.listMemories({ projectRoot: rootB }),
        overview: () => vault.getOverview({ projectRoot: rootB }),
        health: () => vault.getMemoryHealth({ projectRoot: rootB }),
        stats: () => vault.getStats({ projectRoot: rootB }),
        delete: () => vault.deleteMemory({ projectRoot: rootB, id: "known-race-id" }),
        pin: () => vault.pinToAgentsMd({ projectRoot: rootB, id: "known-race-id" }),
        rollback: () => vault.rollbackMemory({ projectRoot: rootB, id: "known-race-id" }),
        consolidate: () => vault.consolidateMemories({ projectRoot: rootB }),
        promote: () => vault.promoteWorktreeMemory({ projectRoot: rootB, id: "known-race-id" }),
        ensure: () => vault.ensureProject({ projectRoot: rootB }),
        link: () => vault.ensureProjectMemoryLink(rootB),
        sync: () => vault.syncFromMarkdownIfChanged({ projectRoot: rootB }),
        reindex: () => vault.reindexVectors({ projectRoot: rootB }),
      };
      result = actions[operation]();
    } finally { fs.lstatSync = nativeLstat; }
    assert.equal(triggered, true, operation);
    assert.equal(savedA.ok, true, JSON.stringify({ operation, savedA }));
    if (operation === "reindex" && result.ok) await result.promise;
    const viewA = ownerA.listMemories({ projectRoot: rootA, scopeFilter: "all" });
    const viewB = vault.listMemories({ projectRoot: rootB, scopeFilter: "all" });
    assert.equal(viewA.ok, true, JSON.stringify({ operation, viewA }));
    assert.equal(viewB.ok, true, JSON.stringify({ operation, viewB }));
    assert.ok(viewA.items.some(item => item.id === "known-race-id"), operation + " must preserve A's memory");
    assert.ok(viewB.items.every(item => item.id !== "known-race-id"), operation + " must never expose A's memory to B");
    assert.notEqual(viewA.projectSlug, viewB.projectSlug, operation + " must have distinct identity claims");
    if (operation === "list") assert.ok(!result.items.some(item => item.id === "known-race-id"));
    if (operation === "overview") assert.equal(result.totalMemories, 0);
    if (operation === "health") assert.equal(result.total, 0);
    if (operation === "stats") assert.equal(result.vectorStats.totalMemories, 0);
    if (operation === "pin") assert.equal(fs.existsSync(path.join(rootB, "AGENTS.md")), false);
  }
});

test("an orphaned database slug is never claimed by an unrelated same-named project", () => {
  const f = fixture(), ownerDir = path.join(f.vaultDir, "projects", f.A.projectSlug);
  const hidden = path.join(f.dir, "legacy-owner-preserved"); fs.renameSync(ownerDir, hidden);
  const rootC = path.join(f.dir, "third", "same"); fs.mkdirSync(rootC, { recursive: true });
  const result = f.v.listMemories({ projectRoot: rootC });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.deepEqual(result.items, []);
  assert.notEqual(result.projectSlug, f.A.projectSlug);
  assert.ok(fs.existsSync(path.join(hidden, "pitfalls.md")), "orphan data stays untouched");
});

test("mixed project roots from an old process fail closed and preserve all records", async () => {
  const f = fixture();
  const db = new DatabaseSync(path.join(f.vaultDir, "index.sqlite"));
  const before = db.prepare("SELECT * FROM memories WHERE id=?").get(f.B.id);
  db.prepare("UPDATE memories SET project_slug=? WHERE id=?").run(f.A.projectSlug, f.B.id);
  db.close();
  const root = { projectRoot: f.rootA };
  const results = [
    f.v.listMemories(root), f.v.listMemories({ ...root, query: "sharedneedle" }),
    f.v.getOverview(root), f.v.getMemoryHealth(root), f.v.getStats(root),
    f.v.saveMemory({ ...root, title: "guard", content: "guard content", autoEvolve: false }),
    f.v.deleteMemory({ ...root, id: f.B.id }), f.v.pinToAgentsMd({ ...root, id: f.B.id }),
    f.v.consolidateMemories(root), f.v.reindexVectors(root), f.v.syncFromMarkdownIfChanged(root),
    await f.v.triggerBatchEmbedding(root),
  ];
  for (const result of results) {
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.match(result.error, /归属无法确认/);
  }
  const verify = new DatabaseSync(path.join(f.vaultDir, "index.sqlite"));
  try {
    const after = verify.prepare("SELECT * FROM memories WHERE id=?").get(f.B.id);
    assert.equal(after.project_slug, f.A.projectSlug);
    assert.equal(after.project_root, before.project_root);
    assert.equal(after.content, before.content);
    assert.equal(verify.prepare("SELECT COUNT(*) AS n FROM memories WHERE id=?").get(f.A.id).n, 1);
  } finally { verify.close(); }
  assert.deepEqual(fs.readFileSync(f.md), f.snapshot);
});
