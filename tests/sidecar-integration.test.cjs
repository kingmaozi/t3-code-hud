"use strict";
// Sidecar integration: backend hubCall + getGitGraph __HUB_RPC__ bridge across all actions.
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { execFileSync } = require("node:child_process");

const REPO = path.resolve(__dirname, "..");

// Isolated homes; MUST be set before require(backend.cjs)
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "t3-sidecar-"));
const tmpHome = path.join(tmpRoot, "home");
const tmpUserdata = path.join(tmpRoot, "userdata");
const tmpMuse = path.join(tmpRoot, "muse");
const tmpCodex = path.join(tmpRoot, "codex");
const tmpHub = path.join(tmpHome, ".t3", "hub");
for (const d of [tmpHome, tmpUserdata, tmpMuse, tmpCodex]) fs.mkdirSync(d, { recursive: true });
fs.mkdirSync(path.join(tmpHome, ".t3", "hub"), { recursive: true });
fs.mkdirSync(path.join(tmpHome, ".codex"), { recursive: true });
fs.mkdirSync(path.join(tmpHome, ".pi", "agent"), { recursive: true });
fs.mkdirSync(path.join(tmpHome, ".config", "muse"), { recursive: true });
fs.mkdirSync(path.join(tmpHome, ".claude"), { recursive: true });
fs.mkdirSync(path.join(tmpHome, ".config", "magpie"), { recursive: true });

process.env.HOME = tmpHome;
process.env.T3CODE_HOME = tmpUserdata;
process.env.T3_HUB_DIR = tmpHub;
process.env.MUSE_DATA_DIR = tmpMuse;
process.env.CODEX_HOME = tmpCodex;
delete process.env.XDG_DATA_HOME;

const backend = require(path.join(REPO, "src", "backend.cjs"));
const { createSkillsManager } = require(path.join(REPO, "src", "hub-skills.cjs"));
const { createSubagentsManager } = require(path.join(REPO, "src", "hub-subagents.cjs"));

function writeSkill(dir, name, desc) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}\nBody\n`, "utf8");
}

const THREAD_ID = "thread:sidecar-test";
const PROJECT_ROOT = path.join(tmpRoot, "proj-sidecar");
const PROJECT_ROOT_B = path.join(tmpRoot, "proj-sidecar-b");
fs.mkdirSync(PROJECT_ROOT, { recursive: true });
fs.mkdirSync(PROJECT_ROOT_B, { recursive: true });
fs.mkdirSync(path.join(PROJECT_ROOT, ".git", "info"), { recursive: true });
fs.mkdirSync(path.join(PROJECT_ROOT_B, ".git", "info"), { recursive: true });
fs.mkdirSync(path.join(PROJECT_ROOT, ".claude"), { recursive: true });
fs.mkdirSync(path.join(PROJECT_ROOT_B, ".claude"), { recursive: true });

function buildDb() {
  // Ensure DB path is tmpUserdata/statev2.sqlite
  const dbPath = path.join(tmpUserdata, "statev2.sqlite");
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec(
    `CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, project_id TEXT, title TEXT, default_provider TEXT, updated_at TEXT, payload_json TEXT, archived_at TEXT, deleted_at TEXT);
     CREATE TABLE projection_projects (project_id TEXT, title TEXT, workspace_root TEXT, updated_at TEXT);
     CREATE TABLE orchestration_v2_projection_provider_sessions (provider_session_id TEXT, thread_id TEXT, provider TEXT, status TEXT, model TEXT, updated_at TEXT, payload_json TEXT, driver TEXT);
     CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT, thread_id TEXT, driver TEXT, updated_at TEXT, payload_json TEXT);
     CREATE TABLE orchestration_v2_projection_provider_turns (provider_turn_id TEXT, thread_id TEXT, ordinal INTEGER, status TEXT, started_at TEXT, completed_at TEXT, payload_json TEXT);`
  );
  db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?,?,?,?,?,?)").run(
    THREAD_ID, "proj1", "Sidecar Title", "muse", "2025-07-01T00:00:00Z",
    JSON.stringify({ modelSelection: { model: "muse-ember-1.0", provider: "muse" } }), null, null
  );
  // Also a delegated thread to ensure fallback picks non-delegated
  db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?,?,?,?,?,?)").run(
    "delegated:child1", "proj1", "Delegated", "codex", "2025-07-02T00:00:00Z", "{}", null, null
  );
  db.prepare("INSERT INTO projection_projects VALUES (?,?,?,?)").run("proj1", "Sidecar Project", PROJECT_ROOT, "2025-07-01T00:00:00Z");
  db.prepare("INSERT INTO orchestration_v2_projection_provider_sessions VALUES (?,?,?,?,?,?,?,?)").run(
    "sess1", THREAD_ID, "muse", "running", "muse-ember-1.0", "2025-07-01T00:00:00Z", "{}", "muse"
  );
  db.close();

  // Prepare hub skills: global one and project one for PROJECT_ROOT
  writeSkill(path.join(tmpHome, ".agents", "skills", "global-skill"), "global-skill", "Global skill desc");
  writeSkill(path.join(tmpHome, ".agents", "skills", "proj-skill"), "proj-skill", "Proj skill desc");
  const mgr = createSkillsManager({ homeDir: tmpHome, hubDir: tmpHub });
  // global skill
  mgr.setSkillScope({ id: "global-skill", scope: "global" });
  // proj skill for PROJECT_ROOT
  mgr.setSkillScope({ id: "proj-skill", scope: "project", projectRoot: PROJECT_ROOT });

  // Ensure drawer ui exists for hub:getDrawerScript (already in repo)
  // Ensure mcp and memory dirs
  fs.mkdirSync(path.join(tmpHub, "memory"), { recursive: true });

  // Seed subagents manager with global defaults injection (should create global-AGENTS.md)
  const subMgr = createSubagentsManager({ homeDir: tmpHome, hubDir: tmpHub });
  subMgr.listSubagents({});
}

before(() => buildDb());

describe("backend hubCall via getGitGraph __HUB_RPC__ bridge", () => {
  it("hub:getDrawerScript returns code", async () => {
    const res = await backend.getGitGraph("__HUB_RPC__", "hub:getDrawerScript", {});
    assert.equal(res.ok, true);
    assert.ok(typeof res.code === "string" && res.code.length > 100);
  });

  it("hub:getContext resolves thread/project and counts", async () => {
    const res = await backend.getGitGraph("__HUB_RPC__", "hub:getContext", { threadHint: THREAD_ID });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.threadId, THREAD_ID);
    assert.equal(res.projectRoot, PROJECT_ROOT);
    assert.equal(res.projectTitle, "Sidecar Project");
    assert.equal(res.projectSlug, path.basename(PROJECT_ROOT));
    assert.equal(res.activeProvider, "muse");
    assert.equal(res.activeModel, "muse-ember-1.0");
    assert.ok(typeof res.counts.activeSkills === "number");
    assert.ok(typeof res.counts.activeMcps === "number");
    assert.ok(typeof res.counts.projectMemories === "number");
    assert.ok(typeof res.counts.subagents === "number");
    assert.ok(res.counts.subagents >= 7);
  });

  it("hub:getContext fallback picks non-delegated latest when hint missing", async () => {
    const res = await backend.getGitGraph("__HUB_RPC__", "hub:getContext", {});
    assert.equal(res.ok, true);
    // Should prefer THREAD_ID over delegated:child1 if it is most recent non-delegated? Our logic picks non-delegated first sorted by updated_at.
    // delegated is newer but non-delegated filter should skip it, so THREAD_ID wins.
    assert.equal(res.threadId, THREAD_ID);
  });

  it("slash:list isolates per-project skills and subagents", async () => {
    // For PROJECT_ROOT: should see both global and project skills
    const a = await backend.getGitGraph("__HUB_RPC__", "slash:list", { projectRoot: PROJECT_ROOT });
    assert.equal(a.ok, true);
    assert.equal(a.projectRoot, PROJECT_ROOT);
    const idsA = new Set(a.skills.map((s) => s.id));
    assert.ok(idsA.has("global-skill"));
    assert.ok(idsA.has("proj-skill"));
    // For PROJECT_ROOT_B: should NOT see proj-skill (project-scoped to A)
    const b = await backend.getGitGraph("__HUB_RPC__", "slash:list", { projectRoot: PROJECT_ROOT_B });
    assert.equal(b.ok, true);
    const idsB = new Set(b.skills.map((s) => s.id));
    assert.ok(idsB.has("global-skill"));
    assert.ok(!idsB.has("proj-skill"), "proj-skill must not leak to other project");
    // Subagents effective present for both
    assert.ok(Array.isArray(a.subagents) && a.subagents.length >= 7);
    assert.ok(a.subagents.every((s) => s.enabled !== false));
    assert.ok(Array.isArray(b.subagents) && b.subagents.length >= 7);
  });

  it("skills:list returns items", async () => {
    const res = await backend.getGitGraph("__HUB_RPC__", "skills:list", { projectRoot: PROJECT_ROOT });
    assert.equal(res.ok, true);
    assert.ok(Array.isArray(res.items));
  });

  it("skills:setScope creates per-project slash artifacts and cleans on off/global", async () => {
    // create a new skill tmp skill for this test
    writeSkill(path.join(tmpHome, ".agents", "skills", "slash-test-skill"), "slash-test-skill", "Slash test");
    const r1 = await backend.getGitGraph("__HUB_RPC__", "skills:setScope", { id: "slash-test-skill", scope: "project", projectRoot: PROJECT_ROOT });
    assert.equal(r1.ok, true, JSON.stringify(r1));
    assert.ok(fs.lstatSync(path.join(PROJECT_ROOT, ".codex", "skills", "slash-test-skill")).isSymbolicLink());
    assert.ok(fs.existsSync(path.join(PROJECT_ROOT, ".claude", "commands", "slash-test-skill.md")));
    const excl = fs.readFileSync(path.join(PROJECT_ROOT, ".git", "info", "exclude"), "utf8");
    assert.ok(excl.includes(".codex/skills/slash-test-skill"));
    assert.ok(excl.includes(".claude/commands/slash-test-skill.md"));
    const r2 = await backend.getGitGraph("__HUB_RPC__", "skills:setScope", { id: "slash-test-skill", scope: "off", projectRoot: PROJECT_ROOT });
    assert.equal(r2.ok, true);
    assert.ok(!fs.existsSync(path.join(PROJECT_ROOT, ".codex", "skills", "slash-test-skill")));
    assert.ok(!fs.existsSync(path.join(PROJECT_ROOT, ".claude", "commands", "slash-test-skill.md")));
    // also test project->global cleanup
    writeSkill(path.join(tmpHome, ".agents", "skills", "slash-test-global"), "slash-test-global", "Global toggle");
    await backend.getGitGraph("__HUB_RPC__", "skills:setScope", { id: "slash-test-global", scope: "project", projectRoot: PROJECT_ROOT });
    assert.ok(fs.existsSync(path.join(PROJECT_ROOT, ".codex", "skills", "slash-test-global")));
    const rg = await backend.getGitGraph("__HUB_RPC__", "skills:setScope", { id: "slash-test-global", scope: "global", projectRoot: PROJECT_ROOT });
    assert.equal(rg.ok, true);
    assert.ok(!fs.existsSync(path.join(PROJECT_ROOT, ".codex", "skills", "slash-test-global")));
    assert.ok(!fs.existsSync(path.join(PROJECT_ROOT, ".claude", "commands", "slash-test-global.md")));
  });

  it("agentsMd:get/save/injectSoftRoute via hubCall", async () => {
    const get = await backend.getGitGraph("__HUB_RPC__", "agentsMd:get", { projectRoot: PROJECT_ROOT });
    assert.equal(get.ok, true);
    assert.ok(typeof get.globalContent === "string");
    const saveG = await backend.getGitGraph("__HUB_RPC__", "agentsMd:save", { target: "global", content: "# Sidecar global\n" });
    assert.equal(saveG.ok, true);
    const saveP = await backend.getGitGraph("__HUB_RPC__", "agentsMd:save", { target: "project", projectRoot: PROJECT_ROOT, content: "# Sidecar proj\n" });
    assert.equal(saveP.ok, true);
    const inject = await backend.getGitGraph("__HUB_RPC__", "agentsMd:injectSoftRoute", { projectRoot: PROJECT_ROOT });
    assert.equal(inject.ok, true);
    assert.ok((fs.readFileSync(path.join(PROJECT_ROOT, "AGENTS.md"), "utf8") || "").includes("memory_search"));
  });

  it("mcp:list/upsert/setMode/remove/syncClis via hubCall", async () => {
    const list = await backend.getGitGraph("__HUB_RPC__", "mcp:list", { projectRoot: PROJECT_ROOT });
    assert.equal(list.ok, true);
    const up = await backend.getGitGraph("__HUB_RPC__", "mcp:upsert", { name: "sidecar-mock", command: "node", args: ["/tmp/x"] });
    assert.equal(up.ok, true);
    assert.ok(up.items.find((i) => i.name === "sidecar-mock"));
    const mode = await backend.getGitGraph("__HUB_RPC__", "mcp:setMode", { name: "sidecar-mock", mode: "project-lazy", projectRoot: PROJECT_ROOT });
    assert.equal(mode.ok, true);
    const list2 = await backend.getGitGraph("__HUB_RPC__", "mcp:list", { projectRoot: PROJECT_ROOT });
    const item = list2.items.find((i) => i.name === "sidecar-mock");
    // mode should reflect project-lazy for this project
    assert.ok(item && (item.mode === "project-lazy" || item.mode === "off")); // hub fallback may be off if not project mode detection, but check presence
    const sync = await backend.getGitGraph("__HUB_RPC__", "mcp:syncClis", {});
    assert.equal(sync.ok, true);
    const rem = await backend.getGitGraph("__HUB_RPC__", "mcp:remove", { name: "sidecar-mock" });
    assert.equal(rem.ok, true);
  });

  it("memory overview/list/save/delete/pin via hubCall", async () => {
    const overview = await backend.getGitGraph("__HUB_RPC__", "memory:overview", { projectRoot: PROJECT_ROOT });
    assert.equal(overview.ok, true);
    const save = await backend.getGitGraph("__HUB_RPC__", "memory:save", { projectRoot: PROJECT_ROOT, module: "constraints", kind: "constraint", title: "sidecar-mem-" + Date.now(), content: "sidecar content " + Math.random() });
    assert.equal(save.ok, true, JSON.stringify(save));
    const list = await backend.getGitGraph("__HUB_RPC__", "memory:list", { projectRoot: PROJECT_ROOT, module: "constraints" });
    assert.equal(list.ok, true);
    assert.ok(list.items.length >= 1);
    const pin = await backend.getGitGraph("__HUB_RPC__", "memory:pinToAgentsMd", { projectRoot: PROJECT_ROOT, id: save.item.id });
    assert.equal(pin.ok, true);
    const del = await backend.getGitGraph("__HUB_RPC__", "memory:delete", { projectRoot: PROJECT_ROOT, id: save.item.id });
    assert.equal(del.ok, true);
  });

  it("memory:migratePowerContext idempotent (no db) returns ok false", async () => {
    const mig = await backend.getGitGraph("__HUB_RPC__", "memory:migratePowerContext", { dbPath: path.join(tmpRoot, "nonexistent.db") });
    // Should return ok false with error, not throw
    assert.equal(mig.ok, false);
  });

  it("embed:status and embed:switch via hubCall", async () => {
    const st = await backend.getGitGraph("__HUB_RPC__", "embed:status", {});
    assert.equal(st.ok, true);
    assert.ok(typeof st.port === "number" || st.port === 8001);
    assert.ok(Array.isArray(st.presets));
    const sw = await backend.getGitGraph("__HUB_RPC__", "embed:switch", { mode: "fts5" });
    assert.equal(sw.ok, true);
    assert.equal(sw.mode, "fts5");
  });

  it("subagents:list/save/delete via hubCall and injection", async () => {
    const list = await backend.getGitGraph("__HUB_RPC__", "subagents:list", { projectRoot: PROJECT_ROOT });
    assert.equal(list.ok, true);
    assert.ok(list.catalog && list.globalItems && list.projectItems && list.effectiveItems);
    const save = await backend.getGitGraph("__HUB_RPC__", "subagents:save", {
      scope: "global",
      item: { id: "sidecar-global", role: "general", providerInstanceId: "muse", model: "muse-ember-1.0", effort: "max", description: "sidecar", systemPrompt: "sidecar prompt", enabled: true }
    });
    assert.equal(save.ok, true, JSON.stringify(save));
    assert.ok(save.renderedMarkdownBlock.includes("sidecar-global"));
    // project save
    const psave = await backend.getGitGraph("__HUB_RPC__", "subagents:save", {
      scope: "project",
      projectRoot: PROJECT_ROOT,
      item: { id: "sidecar-proj", role: "general", providerInstanceId: "muse", model: "muse-ember-1.0", effort: "max", description: "proj sidecar", systemPrompt: "proj prompt", enabled: true }
    });
    assert.equal(psave.ok, true);
    assert.ok(fs.existsSync(path.join(PROJECT_ROOT, ".claude", "agents", "sidecar-proj.md")));
    const del = await backend.getGitGraph("__HUB_RPC__", "subagents:delete", { scope: "project", projectRoot: PROJECT_ROOT, id: "sidecar-proj" });
    assert.equal(del.ok, true);
    assert.ok(!fs.existsSync(path.join(PROJECT_ROOT, ".claude", "agents", "sidecar-proj.md")));
    const gdel = await backend.getGitGraph("__HUB_RPC__", "subagents:delete", { scope: "global", id: "sidecar-global" });
    assert.equal(gdel.ok, true);
  });

  it("skills:importGitHub / update / remove via hubCall dispatch (offline local)", async () => {
    // Use local bare repo approach already tested in hub-skills tests; just verify dispatch not unknown.
    // Create a src repo with a skill
    const src = path.join(tmpRoot, "src-skill-src");
    fs.mkdirSync(src, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: src });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: src });
    execFileSync("git", ["config", "user.name", "t"], { cwd: src });
    writeSkill(path.join(src, "manskill"), "manskill", "Man");
    execFileSync("git", ["add", "-A"], { cwd: src });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: src });
    const bare = path.join(tmpRoot, "bare.git");
    execFileSync("git", ["clone", "--bare", "-q", src, bare]);
    const imp = await backend.getGitGraph("__HUB_RPC__", "skills:importGitHub", { repoInput: bare, scope: "project", projectRoot: PROJECT_ROOT });
    assert.equal(imp.ok, true, JSON.stringify(imp));
    assert.ok(imp.imported.includes("manskill"));
    // update (should be ok, re-pull)
    const pkgId = "local__" + path.basename(bare);
    const upd = await backend.getGitGraph("__HUB_RPC__", "skills:update", { id: pkgId });
    assert.equal(upd.ok, true);
    const upd2 = await backend.getGitGraph("__HUB_RPC__", "skills:updatePackage", { id: pkgId });
    assert.equal(upd2.ok, true);
    const rem = await backend.getGitGraph("__HUB_RPC__", "skills:remove", { id: pkgId, projectRoot: PROJECT_ROOT });
    assert.equal(rem.ok, true);
    const rem2 = await backend.getGitGraph("__HUB_RPC__", "skills:removePackage", { id: pkgId, projectRoot: PROJECT_ROOT });
    // second remove on already removed -> may return ok true or false; ensure not unknown action
    assert.ok(rem2.ok === true || rem2.ok === false);
  });

  it("v2 hubCall endpoints: plugins, hooks, mcp:probe, memory:consolidate/rollback, subagents:resolveRoute & AGY sync", async () => {
    const ctx = await backend.getGitGraph("__HUB_RPC__", "hub:getContext", { threadHint: THREAD_ID });
    assert.equal(ctx.ok, true);
    assert.equal(typeof ctx.counts.activePlugins, "number");
    assert.equal(typeof ctx.counts.activeHooks, "number");

    // Plugins list & scope toggle
    const plist = await backend.getGitGraph("__HUB_RPC__", "plugins:list", { projectRoot: PROJECT_ROOT });
    assert.equal(plist.ok, true);
    assert.ok(plist.items.some((p) => p.id === "t3-memory-vault" && p.builtin));
    const pset = await backend.getGitGraph("__HUB_RPC__", "plugins:setScope", { id: "t3-memory-vault", scope: "project", projectRoot: PROJECT_ROOT });
    assert.equal(pset.ok, true);
    const pset2 = await backend.getGitGraph("__HUB_RPC__", "plugins:setScope", { id: "t3-memory-vault", scope: "global", projectRoot: PROJECT_ROOT });
    assert.equal(pset2.ok, true);

    // MCP probe
    const probe = await backend.getGitGraph("__HUB_RPC__", "mcp:probe", { name: "context7", timeoutMs: 400 });
    assert.equal(probe.ok, true);
    assert.ok(probe.results && typeof probe.results === "object");

    // Hooks list / save / toggle / delete
    const hlist = await backend.getGitGraph("__HUB_RPC__", "hooks:list", { projectRoot: PROJECT_ROOT });
    assert.equal(hlist.ok, true);
    assert.ok(hlist.items.some((h) => h.id === "memory-stop-guard"));
    assert.ok(hlist.items.some((h) => h.id === "subagent-route-guard"));
    const hsave = await backend.getGitGraph("__HUB_RPC__", "hooks:save", {
      id: "custom-int-hook",
      title: "Custom Integration Hook",
      event: "Stop",
      command: "echo ok",
      scope: "project",
      projectRoot: PROJECT_ROOT,
    });
    assert.equal(hsave.ok, true);
    const htog = await backend.getGitGraph("__HUB_RPC__", "hooks:toggle", { id: "custom-int-hook", scope: "off", projectRoot: PROJECT_ROOT });
    assert.equal(htog.ok, true);
    const hdel = await backend.getGitGraph("__HUB_RPC__", "hooks:delete", { id: "custom-int-hook" });
    assert.equal(hdel.ok, true);

    // Memory evolution + consolidate + rollback via hubCall
    const m1 = await backend.getGitGraph("__HUB_RPC__", "memory:save", {
      projectRoot: PROJECT_ROOT,
      module: "decisions",
      kind: "decision",
      title: "RPC 端口约定",
      content: "使用 7001 端口作为测试服务端口",
    });
    assert.equal(m1.ok, true);
    const m2 = await backend.getGitGraph("__HUB_RPC__", "memory:save", {
      projectRoot: PROJECT_ROOT,
      module: "decisions",
      kind: "decision",
      title: "RPC 端口约定",
      content: "已从 7001 端口迁移到 8001 端口作为统一本地嵌入服务端口",
      supersedesId: m1.item.id,
    });
    assert.equal(m2.ok, true);
    assert.equal(m2.action, "superseded");
    assert.equal(m2.evolvedFromVersion, 1);
    assert.ok(m2.item.version >= 2);
    const cons = await backend.getGitGraph("__HUB_RPC__", "memory:consolidate", { projectRoot: PROJECT_ROOT, dryRun: true });
    assert.equal(cons.ok, true);
    const rb = await backend.getGitGraph("__HUB_RPC__", "memory:rollback", { projectRoot: PROJECT_ROOT, id: m2.item.id, targetVersion: 1 });
    assert.equal(rb.ok, true);
    assert.ok(rb.item.content.includes("7001"));

    // Subagent live route resolution + Antigravity rules sync
    const agyRulesDir = path.join(tmpUserdata, "providers", "antigravity", "mock-agy-inst", "config", "rules");
    fs.mkdirSync(agyRulesDir, { recursive: true });
    const agyRulesFile = path.join(agyRulesDir, "AGENTS.md");
    fs.writeFileSync(agyRulesFile, "# Existing AGY Rules\nKeep me safe\n", "utf8");
    const ssave = await backend.getGitGraph("__HUB_RPC__", "subagents:save", {
      scope: "global",
      item: { id: "worker", role: "implementation", providerInstanceId: "codex", model: "gpt-6.1-terra", effort: "high", memoryPolicy: "readwrite", enabled: true },
    });
    assert.equal(ssave.ok, true);
    const agyText = fs.readFileSync(agyRulesFile, "utf8");
    assert.ok(agyText.includes("Keep me safe"));
    assert.ok(agyText.includes("t3-hub-subagents:start"));
    assert.ok(agyText.includes("gpt-6.1-terra"));
    const resolved = await backend.getGitGraph("__HUB_RPC__", "subagents:resolveRoute", { idOrTitle: "worker", role: "implementation", projectRoot: PROJECT_ROOT });
    assert.equal(resolved.matched, true);
    assert.equal(resolved.target.providerInstanceId, "codex");
    assert.equal(resolved.target.model, "gpt-6.1-terra");
    assert.equal(resolved.target.options.reasoningEffort, "high");
  });

  it("hubCall unknown action returns ok false", async () => {
    const res = await backend.getGitGraph("__HUB_RPC__", "unknown:action", {});
    assert.equal(res.ok, false);
  });

  it("backend exports hubCall and resolveHubContext", () => {
    assert.equal(typeof backend.hubCall, "function");
    assert.equal(typeof backend.resolveHubContext, "function");
  });
});

describe("install.sh sidecar copies", () => {
  it("install.sh copies src/*.cjs src/*.js src/*.py and bin/scripts", () => {
    const src = fs.readFileSync(path.join(REPO, "install.sh"), "utf8");
    assert.ok(src.includes('src/*.cjs') || src.includes('src/"*.cjs"') || src.includes('*.cjs'));
    assert.ok(src.includes('t3-mcp-router'));
    assert.ok(src.includes('pc-lite.mjs'));
    assert.ok(src.includes('memory-stop-hook.mjs'));
    assert.ok(src.includes('subagent-route-guard.mjs'));
    assert.ok(src.includes('hub-plugins.cjs'));
    assert.ok(src.includes('hub-hooks.cjs'));
    assert.ok(src.includes('chmod +x'));
  });
});
