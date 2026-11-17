"use strict";
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const REPO = path.resolve(__dirname, "..");
const { createMemoryVault, resolveWorktreeContext } = require(path.join(REPO, "src", "memory-vault.cjs"));
const { createSubagentsManager } = require(path.join(REPO, "src", "hub-subagents.cjs"));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hub-v3-wt-"));
const vaultDir = path.join(tmpRoot, "vault");
const homeDir = path.join(tmpRoot, "home");
const hubDir = path.join(homeDir, ".t3", "hub");
fs.mkdirSync(vaultDir, { recursive: true });
fs.mkdirSync(homeDir, { recursive: true });

function makeVault(extra = {}) {
  return createMemoryVault({
    vaultDir,
    homeDir,
    hubDir,
    embeddingUrl: "http://127.0.0.1:59999/v1/embeddings",
    embeddingTimeoutMs: 200,
    _embedFn: () => null,
    _healthFn: () => ({ modelId: null, dim: null }),
    ...extra,
  });
}

function setupWorktrees() {
  const mainRoot = path.join(tmpRoot, "main-proj");
  fs.mkdirSync(mainRoot, { recursive: true });
  fs.mkdirSync(path.join(mainRoot, ".git", "info"), { recursive: true });
  fs.writeFileSync(path.join(mainRoot, ".git", "info", "exclude"), "");
  fs.writeFileSync(path.join(mainRoot, ".git", "HEAD"), "ref: refs/heads/main\n");

  function mkWorktree(name, branch) {
    const wtPath = path.join(tmpRoot, name);
    const gitDir = path.join(mainRoot, ".git", "worktrees", name);
    fs.mkdirSync(wtPath, { recursive: true });
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, "commondir"), "../..\n");
    fs.writeFileSync(path.join(gitDir, "HEAD"), `ref: refs/heads/${branch}\n`);
    fs.writeFileSync(path.join(wtPath, ".git"), `gitdir: ${gitDir}\n`);
    return wtPath;
  }
  const wtKefu = mkWorktree("wt-kefu", "feat-kefu");
  const wtTmall = mkWorktree("wt-tmall", "feat-tmall");
  return { mainRoot, wtKefu, wtTmall };
}

let wt;
before(() => {
  wt = setupWorktrees();
});

after(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("worktree context canonical slug", () => {
  it("maps main and both worktrees to same canonicalProjectRoot/slug", () => {
    const v = makeVault();
    const ctxMain = resolveWorktreeContext(wt.mainRoot);
    const ctxKefu = resolveWorktreeContext(wt.wtKefu);
    const ctxTmall = resolveWorktreeContext(wt.wtTmall);
    const canon = fs.realpathSync(wt.mainRoot);
    assert.equal(ctxMain.canonicalProjectRoot, canon);
    assert.equal(ctxKefu.canonicalProjectRoot, canon);
    assert.equal(ctxTmall.canonicalProjectRoot, canon);
    assert.equal(ctxKefu.canonicalProjectRoot, ctxTmall.canonicalProjectRoot);
    assert.equal(ctxKefu.canonicalSlug, ctxTmall.canonicalSlug);
    assert.equal(ctxMain.canonicalSlug, ctxKefu.canonicalSlug);
    assert.equal(ctxKefu.isLinkedWorktree, true);
    assert.equal(ctxTmall.isLinkedWorktree, true);
    assert.equal(ctxMain.isLinkedWorktree, false);
    assert.equal(ctxKefu.worktreeId, "wt-kefu");
    assert.equal(ctxTmall.worktreeId, "wt-tmall");
    assert.equal(ctxKefu.branchName, "feat-kefu");
    assert.equal(ctxTmall.branchName, "feat-tmall");
    // Vault slug unified by canonical root
    assert.equal(v.resolveProjectSlug(wt.mainRoot), v.resolveProjectSlug(wt.wtKefu));
    assert.equal(v.resolveProjectSlug(wt.wtTmall), v.resolveProjectSlug(wt.wtKefu));
    // Also ensure .git file parsing zero subprocess works (no need git)
    assert.ok(ctxKefu.worktreeName);
  });
});

describe("shared vs worktree isolation auto", () => {
  it("shared visible across worktrees, worktree isolated, smart default wip", () => {
    const v = makeVault();
    const uid = crypto.randomBytes(4).toString("hex");
    const sharedToken = `SHARED_${uid}`;
    const worktreeToken = `WT_${uid}`;
    const smartToken = `SMART_${uid}`;

    const s = v.saveMemory({
      projectRoot: wt.wtKefu,
      scope: "shared",
      module: "architecture",
      kind: "decision",
      title: "shared-arch-" + sharedToken,
      content: "shared content " + sharedToken + " architecture foundation",
      autoEvolve: false,
    });
    assert.equal(s.ok, true, JSON.stringify(s));
    assert.equal(s.item.scope, "shared");

    const w = v.saveMemory({
      projectRoot: wt.wtKefu,
      scope: "worktree",
      module: "topics",
      kind: "wip",
      title: "wip-" + worktreeToken,
      content: "wip worktree secret " + worktreeToken + " temporary",
      autoEvolve: false,
    });
    assert.equal(w.ok, true, JSON.stringify(w));
    assert.equal(w.item.scope, "worktree");
    assert.equal(w.item.worktreeId, "wt-kefu");

    // Smart default: kind progress -> auto worktree
    const smart = v.saveMemory({
      projectRoot: wt.wtKefu,
      kind: "progress",
      title: "smart-" + smartToken,
      content: "progress not explicitly scoped " + smartToken,
      autoEvolve: false,
    });
    assert.equal(smart.ok, true, JSON.stringify(smart));
    assert.equal(smart.item.scope, "worktree", "smart default should be worktree for progress kind");
    assert.equal(smart.item.worktreeId, "wt-kefu");

    // Search from other worktree with default auto
    const foundShared = v.listMemories({ projectRoot: wt.wtTmall, query: sharedToken });
    assert.equal(foundShared.ok, true);
    assert.ok(foundShared.items.some((i) => i.title.includes(sharedToken)), "shared should be searchable from other worktree");

    const foundWorktreeFromOther = v.listMemories({ projectRoot: wt.wtTmall, query: worktreeToken });
    assert.equal(foundWorktreeFromOther.ok, true);
    assert.ok(!foundWorktreeFromOther.items.some((i) => i.title.includes(worktreeToken)), "worktree from wt-kefu must NOT leak to wt-tmall via auto");

    const foundSmartFromOther = v.listMemories({ projectRoot: wt.wtTmall, query: smartToken });
    assert.ok(!foundSmartFromOther.items.some((i) => i.title.includes(smartToken)), "smart wip also isolated");

    // Control: wt-kefu itself can see its own worktree
    const foundWorktreeFromSelf = v.listMemories({ projectRoot: wt.wtKefu, query: worktreeToken });
    assert.ok(foundWorktreeFromSelf.items.some((i) => i.title.includes(worktreeToken)), "self worktree should be visible via auto");

    const foundSmartFromSelf = v.listMemories({ projectRoot: wt.wtKefu, query: smartToken });
    assert.ok(foundSmartFromSelf.items.some((i) => i.title.includes(smartToken)));

    // scopeFilter variants
    const onlyShared = v.listMemories({ projectRoot: wt.wtTmall, scopeFilter: "shared", query: sharedToken });
    assert.ok(onlyShared.items.some((i) => i.title.includes(sharedToken)));
    const onlyWorktreeOther = v.listMemories({ projectRoot: wt.wtTmall, scopeFilter: "worktree", query: worktreeToken });
    assert.ok(!onlyWorktreeOther.items.some((i) => i.title.includes(worktreeToken)), "worktree filter from other worktree should be empty");
    const onlyWorktreeSelf = v.listMemories({ projectRoot: wt.wtKefu, scopeFilter: "worktree", query: worktreeToken });
    assert.ok(onlyWorktreeSelf.items.some((i) => i.title.includes(worktreeToken)));
    const allFromTmall = v.listMemories({ projectRoot: wt.wtTmall, scopeFilter: "all", query: worktreeToken });
    // "all" includes all worktrees for the project, so should see worktree from kefu
    assert.ok(allFromTmall.items.some((i) => i.title.includes(worktreeToken)), "all should include all worktree memories");

    // Stash ids for next test via closure? Save to global for promotion test.
    // Store on vault instance via property for next test.
    v._sharedId = s.item.id;
    v._worktreeId = w.item.id;
    v._worktreeToken = worktreeToken;
  });
});

describe("promoteWorktreeMemory", () => {
  it("promotes worktree memory to shared and makes it visible everywhere", () => {
    const v = makeVault();
    // Re-create source memories if previous test's tmp was isolated? We use same vault, so query existing ids.
    // In previous test, they may not persist if test order shuffled; just recreate a new worktree memory for promotion test isolation.
    const uid = crypto.randomBytes(4).toString("hex");
    const token = `PROMOTE_${uid}`;
    const w = v.saveMemory({
      projectRoot: wt.wtKefu,
      scope: "worktree",
      module: "topics",
      kind: "wip",
      title: "promote-" + token,
      content: "to promote " + token,
      autoEvolve: false,
    });
    assert.equal(w.ok, true);
    assert.equal(w.item.scope, "worktree");
    const before = v.listMemories({ projectRoot: wt.wtTmall, query: token });
    assert.ok(!before.items.some((i) => i.title.includes(token)), "before promote, other worktree should not see");
    const promoted = v.promoteWorktreeMemory({ id: w.item.id });
    assert.equal(promoted.ok, true, JSON.stringify(promoted));
    assert.equal(promoted.item.scope, "shared");
    assert.equal(promoted.item.worktreeId, "");
    const after = v.listMemories({ projectRoot: wt.wtTmall, query: token });
    assert.ok(after.items.some((i) => i.title.includes(token)), "after promote, other worktree should see shared");
    // Also markdown file check: shared file should contain token, worktree file should not
    const slug = v.resolveProjectSlug(wt.wtKefu);
    const sharedFile = path.join(vaultDir, "projects", slug, "topics.md");
    const content = fs.readFileSync(sharedFile, "utf8");
    assert.ok(content.includes(token), "promoted token should be in shared markdown");
    const wtFile = path.join(vaultDir, "projects", slug, "_worktrees", "wt-kefu", "topics.md");
    if (fs.existsSync(wtFile)) {
      const wtContent = fs.readFileSync(wtFile, "utf8");
      // The promoted entry must not remain in worktree file as worktree scoped? It should be removed from worktree file.
      // We assert it no longer appears as worktree entry (or at least not with same id)
      assert.ok(!wtContent.includes(w.item.id), "worktree file should not contain promoted id");
    }
  });
});

describe("ensureProjectMemoryLink", () => {
  it("creates .t3/memory symlink and exclude entry", () => {
    const v = makeVault();
    const v2 = makeVault();
    const res = v2.ensureProjectMemoryLink(wt.wtKefu);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.ok(res.vaultPath);
    assert.ok(res.linkPath);
    assert.equal(res.linkPath, path.join(wt.wtKefu, ".t3", "memory"));
    assert.equal(res.linked, true);
    // symlink exists and points to vaultPath
    const st = fs.lstatSync(res.linkPath);
    assert.ok(st.isSymbolicLink());
    assert.equal(fs.readlinkSync(res.linkPath), res.vaultPath);
    // vaultPath directory exists
    assert.ok(fs.existsSync(path.join(res.vaultPath, "_meta.json")) || fs.existsSync(res.vaultPath));
    // exclude contains entry
    const excludePath = path.join(wt.mainRoot, ".git", "info", "exclude");
    const excl = fs.readFileSync(excludePath, "utf8");
    assert.ok(excl.includes(".t3/memory"), "exclude should contain .t3/memory");
    // idempotent second call
    const res2 = v2.ensureProjectMemoryLink(wt.wtKefu);
    assert.equal(res2.ok, true);
    assert.equal(res2.linked, true);
  });
});

describe("hub-subagents orchestration Carbon/Argon + /swarm", () => {
  it("persists config, 7-role override, idempotent directive and cleanup", () => {
    const subHome = path.join(tmpRoot, "sub-home");
    const subHub = path.join(subHome, ".t3", "hub");
    fs.mkdirSync(subHub, { recursive: true });
    const mgr = createSubagentsManager({ homeDir: subHome, hubDir: subHub });
    // default config
    const def = mgr.getOrchestrationConfig();
    assert.equal(def.orchestratorMode, "off");
    assert.equal(def.swarmMode, "auto");
    assert.equal(def.maxParallelAgents, 6);
    assert.ok(def.agyModels.carbon);
    assert.equal(def.agyModels.carbon.id, "gemini-4-carbon");
    assert.equal(def.agyModels.carbon.label, "Orchestrator (Carbon)");
    assert.equal(def.agyModels.carbon.badge, "New");
    assert.equal(def.agyModels.argon.id, "gemini-4-argon");

    // 7 role defaults
    const list = mgr.listSubagents({});
    const ids = list.globalItems.map((i) => i.id).sort();
    assert.deepEqual(ids, ["code-review", "default", "explorer", "frontend", "qa", "review-fast", "review-pro", "worker", "worker-pro"]);
    const explorer = list.globalItems.find((i) => i.id === "explorer");
    assert.equal(explorer.providerInstanceId, "muse");
    assert.equal(explorer.model, "muse-ember-1.0");
    assert.equal(explorer.effort, "max");
    const workerPro = list.globalItems.find((i) => i.id === "worker-pro");
    assert.equal(workerPro.providerInstanceId, "codex");
    assert.equal(workerPro.model, "gpt-6-astra");
    assert.equal(workerPro.effort, "xhigh");
    const codeReview = list.globalItems.find((i) => i.id === "code-review");
    assert.equal(codeReview.providerInstanceId, "codex");
    assert.equal(codeReview.model, "gpt-6.1-terra");
    assert.equal(codeReview.effort, "max");

    // Custom override for one role
    mgr.saveSubagent({ scope: "global", item: { id: "explorer", role: "research", providerInstanceId: "codex", model: "gpt-6.1-sol", effort: "high", description: "custom explorer", systemPrompt: "custom", enabled: true } });
    const afterOverride = mgr.listSubagents({});
    const customExplorer = afterOverride.globalItems.find((i) => i.id === "explorer");
    assert.equal(customExplorer.model, "gpt-6.1-sol");
    const route = mgr.resolveSubagentRoute({ idOrTitle: "explorer", projectRoot: wt.mainRoot });
    assert.equal(route.matched, true);
    assert.equal(route.target.model, "gpt-6.1-sol");
    // Reset explorer to default for later? Not needed; restore default via delete reset?
    // Keep override for further asserts but clean later not required.
    mgr.saveSubagent({ scope: "global", item: { id: "explorer", role: "research", providerInstanceId: "muse", model: "muse-ember-1.0", effort: "max", description: "只读阅读、查找代码、梳理调用链与排查故障证据，不修改代码", systemPrompt: "你作为只读调查子代理（explorer），专注于阅读源码、检索调用链、核查日志与配置证据。严格只读，不修改业务代码；汇报时明确区分“已确认事实”与“待验证假设”。", enabled: true } });

    // Legacy commander/swarm can be read but cannot be reactivated.
    const fakeAgents = path.join(tmpRoot, "fake-AGENTS.md");
    const original = "# My Rules\n\nHello world\n";
    fs.writeFileSync(fakeAgents, original);
    const rev = mgr.getOrchestrationState({ hosts: [fakeAgents] }).modeRevision;
    assert.throws(() => mgr.updateOrchestrationConfig({ orchestratorMode: "carbon", swarmMode: "on", expectedRevision: rev }, { hostRulePaths: [fakeAgents] }), /请选择/);
    assert.equal(fs.readFileSync(fakeAgents, "utf8"), original);
    assert.throws(() => mgr.updateOrchestrationConfig({ orchestratorMode: "argon", swarmMode: "on", expectedRevision: rev }, { hostRulePaths: [fakeAgents] }), /请选择/);
    for (const mode of ["swarm", "carbon", "argon", "plan"]) {
      const prompt = mgr.buildSlashCommandPrompt(mode);
      assert.match(prompt, /角色/);
      assert.doesNotMatch(prompt, /严禁亲自改业务代码/);
    }
    const disabled = mgr.updateOrchestrationConfig({ orchestratorMode: "off", swarmMode: "off", expectedRevision: rev }, { hostRulePaths: [fakeAgents] });
    assert.equal(disabled.ok, true);
    assert.ok(fs.readFileSync(fakeAgents, "utf8").startsWith(original));
    assert.match(fs.readFileSync(fakeAgents, "utf8"), /常规协作/);

  });
});
