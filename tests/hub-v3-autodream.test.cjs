"use strict";
// Hermetic transaction fault injection: every vault, home and hub is under /tmp.
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync, spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { createMemoryVault } = require("../src/memory-vault.cjs");
const source = require.resolve("../src/memory-vault.cjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-tx-regression-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let serial = 0;
function fixture(worktree = false) {
  const base = path.join(root, String(++serial));
  const opts = { vaultDir: path.join(base, "vault"), homeDir: path.join(base, "home"), hubDir: path.join(base, "hub") };
  const options = () => ({ ...opts, _embedFn: () => null, _healthFn: () => null });
  const vault = createMemoryVault(options());
  const projectRoot = path.join(base, "project");
  fs.mkdirSync(projectRoot, { recursive: true });
  const saved = [];
  for (const module of ["topics", "architecture"]) {
    const r = vault.saveMemory({ projectRoot, module, title: "matching-title", content: "alpha beta gamma delta epsilon " + module,
      autoEvolve: false, ...(worktree ? { scope: "worktree", worktreeId: "branch-a" } : {}) });
    assert.equal(r.ok, true, JSON.stringify(r));
    saved.push(r.item);
  }
  // Set a deterministic survivor across modules.
  const db = new DatabaseSync(path.join(opts.vaultDir, "index.sqlite"));
  db.prepare("UPDATE memories SET created_at=? WHERE id=?").run("2020-01-01T00:00:00Z", saved[0].id);
  db.close();
  const md = (module = "topics") => path.join(opts.vaultDir, "projects", "project", ...(worktree ? ["_worktrees", "branch-a"] : []), module + ".md");
  const journal = path.join(opts.vaultDir, "_state", "dream-tx-journal.json");
  const lock = path.join(opts.vaultDir, "_state", "dream-tx.lock");
  const reopen = () => createMemoryVault(options());
  const rows = () => {
    const db = new DatabaseSync(path.join(opts.vaultDir, "index.sqlite"));
    try { return db.prepare("SELECT * FROM memories ORDER BY id").all(); } finally { db.close(); }
  };
  const intent = (committed = false, extra = {}) => {
    const cl = { projectSlug: "project", module: "topics", modules: ["topics", "architecture"], deletedWorktreeHints: worktree ? ["branch-a"] : [],
      markdownPreImages: ["topics", "architecture"].map((m) => ({ filePath: md(m), pre: { exists: true, content: fs.readFileSync(md(m), "utf8") } })), proposals: [], ...extra };
    const j = { version: 2, kind: "consolidate", txId: "test-transaction", clusters: [cl] };
    fs.mkdirSync(path.dirname(journal), { recursive: true });
    fs.writeFileSync(journal, JSON.stringify(j));
    const db = new DatabaseSync(path.join(opts.vaultDir, "index.sqlite"));
    try {
      db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      if (committed) db.prepare("INSERT OR REPLACE INTO meta VALUES ('last_committed_tx_id', ?)").run(j.txId);
    } finally { db.close(); }
    return j;
  };
  return { opts, options, vault, projectRoot, saved, md, journal, lock, reopen, rows, intent };
}
function injectedRename(file, action) {
  const original = fs.renameSync;
  fs.renameSync = function(from, to) { if (to === file) throw new Error("injected-file-failure"); return original.apply(this, arguments); };
  try { return action(); } finally { fs.renameSync = original; }
}
function childMain(source, opts, projectRoot, mode, dream = false) {
  const fs = require("node:fs"), path = require("node:path");
  const { DatabaseSync } = require("node:sqlite");
  const journal = path.join(opts.vaultDir, "_state", "dream-tx-journal.json");
  const original = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function(sql) {
    if (sql === "COMMIT" && fs.existsSync(journal)) {
      if (mode === "before") process.exit(73);
      if (mode === "active") { process.stdout.write("LOCKED\n"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); }
      const result = original.call(this, sql);
      process.exit(73);
      return result;
    }
    return original.call(this, sql);
  };
  const v = require(source).createMemoryVault({ ...opts, _embedFn: () => null, _healthFn: () => dream ? ({ modelId: "test", dim: 2 }) : null });
  if (dream) v.runDreamCycle({ force: true, agentRunner: ({ clusters }) => ({ merges: [{ keepId: clusters[0].items[0].id, mergeIds: [clusters[0].items[1].id], content: "merged result" }] }) });
  else v.consolidateMemories({ projectRoot });
}
function crash(f, mode = "after", dream = false) {
  const r = spawnSync(process.execPath, ["-e", `(${childMain})(${JSON.stringify(source)},${JSON.stringify(f.opts)},${JSON.stringify(f.projectRoot)},${JSON.stringify(mode)},${dream})`], { encoding: "utf8", timeout: 10000 });
  assert.equal(r.status, 73, r.stderr || String(r.error));
}

for (const committed of [false, true]) {
  for (const worktree of [false, true]) test(`recovery retains intent on ${committed ? "forward" : "rollback"} ${worktree ? "worktree" : "shared"} rewrite failure and retries`, () => {
    const f = fixture(worktree);
    f.intent(committed);
    injectedRename(f.md(), () => { try { f.reopen(); } catch (e) { assert.match(e.message, /injected-file-failure/); } });
    assert.ok(fs.existsSync(f.journal), "failed recovery must retain intent");
    f.reopen();
    assert.equal(fs.existsSync(f.journal), false);
    assert.equal(f.rows().length, 2);
  });
}
test("archive restoration failure retains intent; retry restores exact pre-image", () => {
  const f = fixture();
  const archivePath = path.join(f.opts.vaultDir, "projects/project/_archive/dream-merged.md");
  f.intent(false, { archivePath, archivePre: { exists: true, content: "original archive\n" } });
  injectedRename(archivePath, () => { try { f.reopen(); } catch {} });
  assert.ok(fs.existsSync(f.journal));
  f.reopen();
  assert.equal(fs.readFileSync(archivePath, "utf8"), "original archive\n");
  assert.equal(fs.existsSync(f.journal), false);
});
test("live lock prevents startup recovery; dead pid permits recovery", () => {
  const f = fixture();
  f.intent();
  fs.writeFileSync(f.lock, JSON.stringify({ pid: process.pid, token: "active-owner", createdAt: new Date().toISOString() }));
  const before = fs.readFileSync(f.journal, "utf8");
  f.reopen();
  assert.equal(fs.readFileSync(f.journal, "utf8"), before);
  assert.equal(JSON.parse(fs.readFileSync(f.lock)).token, "active-owner");
  // A completed child supplies a real, now-dead PID.
  const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  fs.writeFileSync(f.lock, JSON.stringify({ pid: Number(dead.stdout), token: "dead-owner", createdAt: new Date().toISOString() }));
  f.reopen();
  assert.equal(fs.existsSync(f.journal), false);
  assert.equal(fs.existsSync(f.lock), false);
});
test("fresh partial lock is never stolen", () => {
  const f = fixture(); f.intent(); fs.writeFileSync(f.lock, '{"pid":');
  f.reopen();
  assert.ok(fs.existsSync(f.journal)); assert.equal(fs.readFileSync(f.lock, "utf8"), '{"pid":');
});
for (const worktree of [false, true]) {
  for (const mode of ["before", "after"]) test(`consolidate crash ${mode} COMMIT recovers ${worktree ? "empty worktree module" : "empty source module"} without resurrection`, () => {
    const f = fixture(worktree); crash(f, mode);
    assert.ok(fs.existsSync(f.journal));
    const j = JSON.parse(fs.readFileSync(f.journal));
    const db = new DatabaseSync(path.join(f.opts.vaultDir, "index.sqlite"));
    try { assert.equal(db.prepare("SELECT value FROM meta WHERE key='last_committed_tx_id'").get()?.value === j.txId, mode === "after"); } finally { db.close(); }
    const v = f.reopen();
    assert.equal(fs.existsSync(f.journal), false);
    assert.equal(f.rows().length, mode === "after" ? 1 : 2);
    if (mode === "after") assert.doesNotMatch(fs.readFileSync(f.md("architecture"), "utf8"), /<!-- mem:/);
    // Force a real Markdown re-import rather than relying only on mtime caching.
    const db2 = new DatabaseSync(path.join(f.opts.vaultDir, "index.sqlite")); db2.exec("DELETE FROM vault_sync"); db2.close();
    v.syncFromMarkdownIfChanged();
    assert.equal(f.rows().length, mode === "after" ? 1 : 2);
  });
}
test("active transaction in another process is not recovered on open", async () => {
  const f = fixture();
  const child = spawn(process.execPath, ["-e", `(${childMain})(${JSON.stringify(source)},${JSON.stringify(f.opts)},${JSON.stringify(f.projectRoot)},"active")`], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("child did not reach locked transaction")), 8000);
      child.stdout.once("data", () => { clearTimeout(timer); resolve(); });
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error("early child exit " + code)); });
    });
    const before = fs.readFileSync(f.journal, "utf8");
    const v = f.reopen();
    assert.equal(fs.readFileSync(f.journal, "utf8"), before);
    assert.equal(JSON.parse(fs.readFileSync(f.lock)).pid, child.pid);
    assert.throws(() => v.syncFromMarkdownIfChanged(), /busy|lock|active/i);
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await new Promise((resolve) => child.once("exit", resolve)); } }
  f.reopen();
  assert.equal(fs.existsSync(f.journal), false);
});
test("committed archive forward completion is exact and idempotent after a partial write", () => {
  const f = fixture();
  const archivePath = path.join(f.opts.vaultDir, "projects/project/_archive/dream-merged.md");
  const archivePost = "old archive\n## archived item\ncomplete body\n";
  f.intent(true, { archivePath, archivePre: { exists: true, content: "old archive\n" }, archivePost });
  fs.mkdirSync(path.dirname(archivePath), { recursive: true }); fs.writeFileSync(archivePath, "old archive\n## archived item\ncomp");
  injectedRename(f.md(), () => { try { f.reopen(); } catch {} });
  assert.ok(fs.existsSync(f.journal));
  f.reopen(); f.reopen();
  assert.equal(fs.readFileSync(archivePath, "utf8"), archivePost);
});
test("consolidate postcommit failure keeps committed DB and intent until recovery", () => {
  const f = fixture();
  const result = injectedRename(f.md(), () => f.vault.consolidateMemories({ projectRoot: f.projectRoot }));
  assert.equal(result.ok, false); assert.equal(f.rows().length, 1);
  assert.ok(fs.existsSync(f.journal)); f.reopen(); assert.equal(f.rows().length, 1);
});
function dreamFixture() {
  const f = fixture();
  // Keep pairs below consolidate's 0.82 cosine threshold but in dream's gray band.
  // Rewrite authoritative Markdown by changing the original files manually.
  fs.writeFileSync(f.md(), fs.readFileSync(f.md(), "utf8").replace("matching-title", "first-title").replace(/alpha beta gamma delta epsilon topics/, "north"));
  fs.writeFileSync(f.md("architecture"), fs.readFileSync(f.md("architecture"), "utf8").replace("matching-title", "second-title").replace(/alpha beta gamma delta epsilon architecture/, "south").replace(/"id":"[^"]+"/, `"id":"${f.saved[1].id}"`));
  // Move both items into one module, without triggering semantic consolidation.
  fs.appendFileSync(f.md(), fs.readFileSync(f.md("architecture"), "utf8").split("\n").slice(2).join("\n"));
  fs.writeFileSync(f.md("architecture"), "# Architecture\n\n");
  const v = createMemoryVault({ ...f.opts, _embedFn: () => null, _healthFn: () => ({ modelId: "test", dim: 2 }) });
  v.syncFromMarkdownIfChanged();
  const db2 = new DatabaseSync(path.join(f.opts.vaultDir, "index.sqlite"));
  for (const [i, row] of f.rows().entries()) db2.prepare("INSERT OR REPLACE INTO memory_vectors VALUES (?,?,?,?,?)").run(row.id, "test", 2, Buffer.from(new Float32Array(i ? [0.8, 0.6] : [1, 0]).buffer), new Date().toISOString());
  db2.close();
  v.updateDreamConfig({ dreamMode: "agent", minDeltaMemories: 0 });
  return { ...f, dreamVault: v };
}
test("dream rollback failure throws a compound error with cause and retains intent", async () => {
  const f = dreamFixture(), v = f.dreamVault;
  const originalRename = fs.renameSync;
  fs.renameSync = function(from, to) { if (fs.existsSync(f.journal) && to === f.md()) throw new Error("dream-rewrite-or-rollback-failure"); return originalRename.apply(this, arguments); };
  try {
    await assert.rejects(v.runDreamCycle({ force: true, agentRunner: ({ clusters }) => ({ merges: [{ keepId: clusters[0].items[0].id, mergeIds: [clusters[0].items[1].id], content: "merged result" }] }) }), (e) => {
      assert.ok(e.cause); assert.ok(e instanceof AggregateError); assert.ok(e.errors.length >= 2); return true;
    });
  } finally { fs.renameSync = originalRename; }
  assert.ok(fs.existsSync(f.journal)); f.reopen(); assert.equal(fs.existsSync(f.journal), false);
});

for (const mode of ["before", "after"]) test(`dream crash ${mode} COMMIT uses atomic marker and exact archive recovery`, () => {
  const f = dreamFixture(); crash(f, mode, true);
  assert.ok(fs.existsSync(f.journal));
  const j = JSON.parse(fs.readFileSync(f.journal));
  const archive = j.clusters[0];
  f.reopen();
  assert.equal(f.rows().length, mode === "after" ? 1 : 2);
  if (mode === "after") assert.equal(fs.readFileSync(archive.archivePath, "utf8"), archive.archivePost);
  else assert.equal(fs.existsSync(archive.archivePath), false);
  const v = f.reopen();
  const db = new DatabaseSync(path.join(f.opts.vaultDir, "index.sqlite")); db.exec("DELETE FROM vault_sync"); db.close();
  v.syncFromMarkdownIfChanged();
  assert.equal(f.rows().length, mode === "after" ? 1 : 2);
});
for (const afterCommit of [false, true]) test(`COMMIT ${afterCommit ? "success then exception" : "exception before success"} does not confuse uncommitted marker`, () => {
  const f = fixture();
  const original = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function(sql) {
    if (sql === "COMMIT" && fs.existsSync(f.journal)) {
      if (afterCommit) original.call(this, sql);
      throw new Error("injected-commit-failure");
    }
    return original.call(this, sql);
  };
  try { assert.equal(f.vault.consolidateMemories({ projectRoot: f.projectRoot }).ok, false); }
  finally { DatabaseSync.prototype.exec = original; }
  assert.equal(f.rows().length, afterCommit ? 1 : 2);
  assert.equal(fs.existsSync(f.journal), afterCommit);
  f.reopen(); assert.equal(fs.existsSync(f.journal), false);
});
test("rollback removes files that did not exist before the transaction", () => {
  const f = fixture(true), file = f.md("pitfalls");
  const j = f.intent();
  j.clusters[0].modules.push("pitfalls");
  j.clusters[0].markdownPreImages.push({ filePath: file, pre: { exists: false, content: null } });
  fs.writeFileSync(f.journal, JSON.stringify(j)); fs.writeFileSync(file, "uncommitted data");
  f.reopen(); assert.equal(fs.existsSync(file), false); assert.equal(fs.existsSync(f.journal), false);
});
test("EPERM owner is alive and corrupt journal is preserved for diagnosis", () => {
  const f = fixture(); f.intent();
  fs.writeFileSync(f.lock, JSON.stringify({ pid: 999999, token: "permission-owner" }));
  const original = process.kill;
  process.kill = () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); };
  try { f.reopen(); assert.ok(fs.existsSync(f.journal)); } finally { process.kill = original; }
  fs.unlinkSync(f.lock); fs.writeFileSync(f.journal, "{broken");
  assert.throws(() => f.reopen()); assert.equal(fs.readFileSync(f.journal, "utf8"), "{broken");
});
test("forward recovery empties an entire deleted worktree and never reimports its rows", () => {
  const f = fixture(true); f.intent(true);
  const db = new DatabaseSync(path.join(f.opts.vaultDir, "index.sqlite"));
  db.exec("DELETE FROM memories; DELETE FROM memories_fts; DELETE FROM memory_vectors"); db.close();
  const v = f.reopen();
  for (const module of ["topics", "architecture"]) assert.doesNotMatch(fs.readFileSync(f.md(module), "utf8"), /<!-- mem:/);
  const db2 = new DatabaseSync(path.join(f.opts.vaultDir, "index.sqlite")); db2.exec("DELETE FROM vault_sync"); db2.close();
  v.syncFromMarkdownIfChanged(); assert.equal(f.rows().length, 0);
});
test("lock release never unlinks a different ownership token", () => {
  const f = fixture();
  const unlink = fs.unlinkSync;
  let replaced = false;
  fs.unlinkSync = function(file) {
    const result = unlink.apply(this, arguments);
    if (file === f.journal) {
      fs.writeFileSync(f.lock, JSON.stringify({ pid: process.pid, token: "successor-owner" })); replaced = true;
    }
    return result;
  };
  try { assert.equal(f.vault.consolidateMemories({ projectRoot: f.projectRoot }).ok, true); }
  finally { fs.unlinkSync = unlink; }
  assert.ok(replaced); assert.equal(JSON.parse(fs.readFileSync(f.lock)).token, "successor-owner");
});
test("journal fsync failure forbids commit, restores files, and removes no retry record prematurely", () => {
  const f = fixture();
  const original = fs.fsyncSync;
  let calls = 0;
  fs.fsyncSync = function(fd) {
    if (fs.existsSync(f.journal) && ++calls === 1) throw new Error("injected-journal-fsync-failure");
    return original.apply(this, arguments);
  };
  try { assert.equal(f.vault.consolidateMemories({ projectRoot: f.projectRoot }).ok, false); }
  finally { fs.fsyncSync = original; }
  assert.ok(calls); assert.equal(f.rows().length, 2);
  f.reopen(); assert.equal(fs.existsSync(f.journal), false);
});

for (const mode of ["before", "after"]) test(`dream archive rotation ${mode} COMMIT is recovered without duplicates or lost history`, () => {
  const f = dreamFixture();
  const file = path.join(f.opts.vaultDir, "projects/project/_archive/dream-merged.md");
  const original = "# old archive\n" + "old history\n".repeat(24000);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, original);
  crash(f, mode, true);
  const cl = JSON.parse(fs.readFileSync(f.journal)).clusters[0];
  assert.ok(cl.archiveRotatedPath);
  f.reopen();
  if (mode === "after") {
    assert.equal(fs.readFileSync(cl.archiveRotatedPath, "utf8"), original);
    assert.equal(fs.readFileSync(file, "utf8"), cl.archivePost);
    assert.ok(fs.statSync(file).size < 256 * 1024);
  } else {
    assert.equal(fs.readFileSync(file, "utf8"), original);
    assert.equal(fs.existsSync(cl.archiveRotatedPath), false);
  }
});

test("stale empty or partial lockfile (>5s) self-heals and never permanently blocks recovery", () => {
  const f = fixture();
  f.intent();
  for (const broken of ["", "{\"pid\":"]) {
    f.intent();
    fs.writeFileSync(f.lock, broken);
    const oldTime = new Date(Date.now() - 10000);
    fs.utimesSync(f.lock, oldTime, oldTime);
    f.reopen();
    assert.equal(fs.existsSync(f.journal), false, "recovery must succeed after reaping stale partial lock");
    assert.equal(fs.existsSync(f.lock), false, "stale partial lock must be cleaned");
  }
});

test("saveMemory/deleteMemory/rollbackMemory serialize under dream-tx.lock and consolidate skips concurrently mutated rows", () => {
  const f = fixture();
  fs.writeFileSync(f.lock, JSON.stringify({ pid: process.pid, token: "held-by-active-tx", createdAt: new Date().toISOString() }));
  assert.equal(f.vault.saveMemory({ projectRoot: f.projectRoot, module: "topics", title: "blocked", content: "blocked write" }).ok, false);
  assert.equal(f.vault.deleteMemory({ id: f.saved[0].id }).ok, false);
  assert.equal(f.vault.rollbackMemory({ projectRoot: f.projectRoot, id: f.saved[0].id }).ok, false);
  fs.unlinkSync(f.lock);

  // Simulate concurrent row update right BEFORE consolidate enters BEGIN IMMEDIATE (during captureMarkdownPreImages):
  const origReaddir = fs.readdirSync;
  let injected = false;
  fs.readdirSync = function (dir, ...rest) {
    if (!injected && String(dir).endsWith("_worktrees")) {
      injected = true;
      const db2 = new DatabaseSync(path.join(f.opts.vaultDir, "index.sqlite"));
      try {
        db2.prepare("UPDATE memories SET content = ?, content_hash = ?, version = version + 1, updated_at = ? WHERE id = ?")
          .run("brand new user update that must never be clobbered", "newhash", "2099-01-01T00:00:00.000Z", f.saved[1].id);
      } finally {
        db2.close();
      }
    }
    return origReaddir.call(fs, dir, ...rest);
  };
  try {
    const res = f.vault.consolidateMemories({ projectRoot: f.projectRoot });
    assert.equal(res.ok, true);
    assert.equal(res.mergedCount, 0, "stale candidate snapshot must be skipped when live row mutated");
  } finally {
    fs.readdirSync = origReaddir;
  }
  const afterRows = f.rows();
  assert.equal(afterRows.length, 2, "concurrently updated row must not be deleted");
  assert.ok(afterRows.some(r => String(r.content).includes("brand new user update")));
});
test("linkSync EOPNOTSUPP fails closed without copyFile fallback and leaves no lock/tmp", () => {
  const f = fixture();
  const origLink = fs.linkSync;
  const origCopy = fs.copyFileSync;
  let copyCalled = false;
  fs.linkSync = function(a, b) {
    if (String(b).endsWith("dream-tx.lock")) throw Object.assign(new Error("not supported"), { code: "EOPNOTSUPP" });
    return origLink.apply(this, arguments);
  };
  fs.copyFileSync = function(...args) { copyCalled = true; return origCopy.apply(this, args); };
  try {
    let threw = null, result = null;
    try { result = f.vault.saveMemory({ projectRoot: f.projectRoot, module: "topics", title: "blocked2", content: "should fail" }); }
    catch (e) { threw = e; }
    if (threw) assert.equal(threw.code, "EOPNOTSUPP");
    else { assert.equal(result.ok, false); assert.match(String(result.error || ""), /not supported/); }
    assert.equal(copyCalled, false, "must not fall back to copyFileSync");
    assert.equal(fs.existsSync(f.lock), false, "dream-tx.lock must not exist after fail-closed");
    const stateDir = path.dirname(f.lock);
    const entries = fs.existsSync(stateDir) ? fs.readdirSync(stateDir) : [];
    assert.equal(entries.some((n) => n.startsWith("dream-tx.lock.tmp-")), false, "no .tmp-* file must remain");
  } finally { fs.linkSync = origLink; fs.copyFileSync = origCopy; }
});

test("directory fsync failure after lock publish cleans up owned dream-tx.lock so subsequent calls recover", () => {
  const f = fixture();
  const stateDir = path.dirname(f.lock);
  const origOpen = fs.openSync;
  const origFsync = fs.fsyncSync;
  let dirFds = new Set();
  let failNextDirFsync = true;
  fs.openSync = function(target, flags, mode) {
    const fd = origOpen.apply(this, arguments);
    if (failNextDirFsync && path.resolve(String(target)) === path.resolve(stateDir)) dirFds.add(fd);
    return fd;
  };
  fs.fsyncSync = function(fd) {
    if (failNextDirFsync && dirFds.has(fd)) {
      dirFds.delete(fd);
      failNextDirFsync = false;
      throw Object.assign(new Error("transient dir fsync EIO"), { code: "EIO" });
    }
    return origFsync.apply(this, arguments);
  };
  try {
    let firstErr = null;
    let firstRes = null;
    try {
      firstRes = f.vault.saveMemory({ projectRoot: f.projectRoot, module: "topics", title: "first", content: "aborted on dir fsync" });
    } catch (e) {
      firstErr = e;
    }
    assert.ok(firstErr || (firstRes && firstRes.ok === false), "first save must fail when dir fsync throws");
    assert.equal(fs.existsSync(f.lock), false, "published dream-tx.lock must be cleaned up by token when dir fsync fails");
  } finally {
    fs.openSync = origOpen;
    fs.fsyncSync = origFsync;
  }
  const secondRes = f.vault.saveMemory({ projectRoot: f.projectRoot, module: "topics", title: "recovered", content: "succeeds after transient fsync error" });
  assert.equal(secondRes.ok, true, "subsequent save must recover cleanly without self-deadlock: " + JSON.stringify(secondRes));
  assert.ok(secondRes.item && secondRes.item.id);
});
