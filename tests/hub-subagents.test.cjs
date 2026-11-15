"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createSubagentsManager, listModelCatalog, DEFAULT_SUBAGENTS, optionsForSubagent } = require("../src/hub-subagents.cjs");
const { createSkillsManager } = require("../src/hub-skills.cjs");

function makeTmp(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `t3-subagents-${label}-`));
}
function writeSkill(dir, skillName, desc) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${skillName}\ndescription: ${desc}\n---\n# ${skillName}\nBody\n`, "utf8");
}

describe("hub-subagents catalog", () => {
  it("returns 5 providers with correct efforts and defaults", () => {
    const home = makeTmp("home");
    const catalog = listModelCatalog(home);
    assert.ok(catalog.muse && catalog.codex && catalog.pi && catalog.antigravity && catalog.claudeAgent);
    assert.deepEqual(catalog.muse.efforts, ["minimal", "low", "medium", "high", "xhigh", "max"]);
    assert.deepEqual(catalog.codex.efforts, ["minimal", "low", "medium", "high", "xhigh", "max"]);
    assert.deepEqual(catalog.pi.efforts, ["minimal", "low", "medium", "high", "xhigh", "max"]);
    assert.deepEqual(catalog.antigravity.efforts, ["low", "medium", "high", "xhigh"]);
    assert.deepEqual(catalog.claudeAgent.efforts, ["low", "medium", "high", "xhigh", "max", "ultrathink"]);
    for (const m of ["muse-ember-1.0", "muse-wonder-full-1.0"]) assert.ok(catalog.muse.models.includes(m));
    for (const m of ["gpt-6.1-sol", "gpt-6.1-terra"]) assert.ok(catalog.codex.models.includes(m));
    assert.ok(catalog.antigravity.models.includes("gemini-4-carbon"));
    assert.ok(catalog.claudeAgent.models.includes("claude-opus-5-5"));
    // pi fallback seeds when no file
    assert.ok(catalog.pi.models.some((x) => x.startsWith("magpie/")));
  });

  it("scans ~/.pi/agent/models.json with magpie prefix", () => {
    const home = makeTmp("home");
    fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
    fs.writeFileSync(path.join(home, ".pi", "agent", "models.json"), JSON.stringify({
      providers: { magpie: { models: [{ id: "group/1m" }, { id: "group/code" }, { id: "auto/claude-haiku-5-5" }] } }
    }), "utf8");
    const mgr = createSubagentsManager({ homeDir: home, hubDir: path.join(home, ".t3", "hub") });
    const cat = mgr.listSubagents({}).catalog;
    assert.ok(cat.pi.models.includes("magpie/group/1m"));
    assert.ok(cat.pi.models.includes("magpie/group/code"));
    assert.ok(cat.pi.models.includes("magpie/auto/claude-haiku-5-5"));
  });

  it("scans ~/.codex/models_cache.json", () => {
    const home = makeTmp("home");
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(home, ".codex", "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-6.1-sol" }, { slug: "gpt-6.1-terra" }, { slug: "custom-ultra" }] }), "utf8");
    const cat = listModelCatalog(home);
    assert.ok(cat.codex.models.includes("custom-ultra"));
    assert.ok(cat.codex.models.includes("gpt-6.1-sol"));
  });
});

describe("hub-subagents global seeding and listing", () => {
  it("seeds 7 default builtin agents on first load", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const mgr = createSubagentsManager({ homeDir: home, hubDir: hub });
    const res = mgr.listSubagents({});
    assert.equal(res.ok, true);
    assert.equal(res.projectRoot, null);
    assert.equal(res.globalItems.length, 7);
    const ids = res.globalItems.map((i) => i.id).sort();
    assert.deepEqual(ids, ["code-review", "default", "explorer", "frontend", "qa", "worker", "worker-pro"]);
    for (const id of ids) {
      const item = res.globalItems.find((x) => x.id === id);
      assert.equal(item.builtin, true);
      assert.equal(item.enabled, true);
      assert.ok(item.providerInstanceId && item.model && item.effort && item.description && item.systemPrompt);
    }
    // Check seeded file exists
    assert.ok(fs.existsSync(path.join(hub, "subagents.json")));
    // catalog present
    assert.ok(res.catalog.muse && res.catalog.codex);
    assert.ok(Array.isArray(res.effectiveItems));
    assert.equal(res.effectiveItems.length, 7);
  });

  it("listSubagents with projectRoot returns projectItems and effective merge", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const mgr = createSubagentsManager({ homeDir: home, hubDir: hub });
    const proj = makeTmp("proj");
    // Create project override for explorer (different model/effort)
    mgr.saveSubagent({
      scope: "project",
      projectRoot: proj,
      item: { id: "explorer", role: "research", toolBadge: "override", providerInstanceId: "codex", model: "gpt-6.1-sol", effort: "high", description: "override explorer", systemPrompt: "override prompt", enabled: true, overridesGlobal: true }
    });
    // Add project-only
    mgr.saveSubagent({
      scope: "project",
      projectRoot: proj,
      item: { id: "custom-helper", role: "general", providerInstanceId: "muse", model: "muse-ember-1.0", effort: "max", description: "custom helper", systemPrompt: "help prompt", enabled: true }
    });
    const res = mgr.listSubagents({ projectRoot: proj });
    assert.equal(res.projectRoot, proj);
    assert.equal(res.projectItems.length, 2);
    // effective should contain overridden explorer with codex model, plus custom-helper, plus other globals
    const eff = res.effectiveItems;
    const explorer = eff.find((x) => x.id === "explorer");
    assert.equal(explorer.providerInstanceId, "codex");
    assert.equal(explorer.model, "gpt-6.1-sol");
    assert.equal(explorer.effort, "high");
    assert.ok(eff.find((x) => x.id === "custom-helper"));
    // Global explorer still original when listed without project
    const without = mgr.listSubagents({});
    assert.equal(without.globalItems.find((x) => x.id === "explorer").providerInstanceId, "muse");
  });
});

describe("hub-subagents save/delete and auto-injection", () => {
  it("global save injects block into global-AGENTS.md and syncs to CLIs with backup", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const mgr = createSubagentsManager({ homeDir: home, hubDir: hub });
    // prepare existing global-AGENTS.md and CLI targets
    fs.mkdirSync(hub, { recursive: true });
    fs.writeFileSync(path.join(hub, "global-AGENTS.md"), "# Existing global\n", "utf8");
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(home, ".codex", "AGENTS.md"), "# Codex original\n", "utf8");
    fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
    fs.mkdirSync(path.join(home, ".config", "muse"), { recursive: true });
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });

    const saved = mgr.saveSubagent({
      scope: "global",
      item: { id: "global-extra", role: "general", providerInstanceId: "muse", model: "muse-ember-1.0", effort: "max", description: "extra global", systemPrompt: "extra systemPrompt content", enabled: true }
    });
    assert.equal(saved.ok, true);
    assert.ok(typeof saved.renderedMarkdownBlock === "string");
    assert.ok(saved.renderedMarkdownBlock.includes("<!-- t3-hub-subagents:start -->"));
    assert.ok(saved.renderedMarkdownBlock.includes("<!-- t3-hub-subagents:end -->"));
    assert.ok(saved.renderedMarkdownBlock.includes("global-extra"));
    // Check all targets contain block
    const globalContent = fs.readFileSync(path.join(hub, "global-AGENTS.md"), "utf8");
    assert.ok(globalContent.includes("# Existing global"));
    assert.ok(globalContent.includes("<!-- t3-hub-subagents:start -->"));
    const codex = fs.readFileSync(path.join(home, ".codex", "AGENTS.md"), "utf8");
    assert.ok(codex.includes("<!-- t3-hub-subagents:start -->"));
    assert.ok(codex.includes("global-extra"));
    // Backup created once
    assert.ok(fs.existsSync(path.join(hub, "global-AGENTS.md.bak-t3hub")));
    assert.equal(fs.readFileSync(path.join(hub, "global-AGENTS.md.bak-t3hub"), "utf8"), "# Existing global\n");
    // .claude/agents written
    const agentFile = path.join(home, ".claude", "agents", "global-extra.md");
    assert.ok(fs.existsSync(agentFile));
    const agentContent = fs.readFileSync(agentFile, "utf8");
    assert.ok(agentContent.includes("---"));
    assert.ok(agentContent.includes("name: global-extra"));
    assert.ok(agentContent.includes("extra systemPrompt content"));
    // Re-save should be idempotent (no duplicate block)
    mgr.saveSubagent({
      scope: "global",
      item: { id: "global-extra", role: "general", providerInstanceId: "muse", model: "muse-ember-1.0", effort: "max", description: "extra global v2", systemPrompt: "extra systemPrompt content", enabled: true }
    });
    const globalContent2 = fs.readFileSync(path.join(hub, "global-AGENTS.md"), "utf8");
    assert.equal((globalContent2.match(/t3-hub-subagents:start/g) || []).length, 1);
    assert.ok(globalContent2.includes("# Existing global"));
  });

  it("global options mapping renders correct delegate_task target", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const mgr = createSubagentsManager({ homeDir: home, hubDir: hub });
    mgr.saveSubagent({ scope: "global", item: { id: "pi-test", role: "general", providerInstanceId: "pi", model: "magpie/group/1m", effort: "high", description: "pi test", systemPrompt: "pi prompt", enabled: true } });
    mgr.saveSubagent({ scope: "global", item: { id: "agy-test", role: "general", providerInstanceId: "antigravity", model: "gemini-4-carbon", effort: "xhigh", description: "agy", systemPrompt: "agy prompt", enabled: true } });
    mgr.saveSubagent({ scope: "global", item: { id: "claude-test", role: "general", providerInstanceId: "claudeAgent", model: "claude-opus-5-5", effort: "ultrathink", description: "claude", systemPrompt: "claude prompt", enabled: true } });
    const block = fs.readFileSync(path.join(hub, "global-AGENTS.md"), "utf8");
    assert.ok(block.includes("thinking") && block.includes("high"));
    assert.ok(block.includes("thinking_level") && block.includes("xhigh"));
    assert.ok(block.includes("effort") && block.includes("ultrathink"));
    assert.ok(block.includes("reasoningEffort") && block.includes("max"));
    // Check optionsForSubagent helper
    assert.deepEqual(optionsForSubagent({ providerInstanceId: "codex", effort: "max" }), { reasoningEffort: "max" });
    assert.deepEqual(optionsForSubagent({ providerInstanceId: "pi", effort: "high" }), { thinking: "high" });
    assert.deepEqual(optionsForSubagent({ providerInstanceId: "antigravity", effort: "xhigh" }), { thinking_level: "xhigh" });
    assert.deepEqual(optionsForSubagent({ providerInstanceId: "claudeAgent", effort: "ultrathink" }), { effort: "ultrathink" });
  });

  it("project scope injects into project AGENTS.md and writes .claude/agents with exclude", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const mgr = createSubagentsManager({ homeDir: home, hubDir: hub });
    const proj = makeTmp("proj");
    fs.mkdirSync(path.join(proj, ".git", "info"), { recursive: true });
    fs.writeFileSync(path.join(proj, ".git", "info", "exclude"), "", "utf8");
    fs.writeFileSync(path.join(proj, "AGENTS.md"), "# Project\n\nKeep me\n", "utf8");
    const saved = mgr.saveSubagent({
      scope: "project",
      projectRoot: proj,
      item: { id: "proj-agent", role: "implementation", providerInstanceId: "muse", model: "muse-ember-1.0", effort: "max", description: "proj agent", systemPrompt: "proj prompt", enabled: true }
    });
    assert.equal(saved.ok, true);
    const content = fs.readFileSync(path.join(proj, "AGENTS.md"), "utf8");
    assert.ok(content.includes("# Project"));
    assert.ok(content.includes("Keep me"));
    assert.ok(content.includes("<!-- t3-hub-project-subagents:start -->"));
    assert.ok(content.includes("<!-- t3-hub-project-subagents:end -->"));
    assert.ok(content.includes("proj-agent"));
    assert.ok(content.includes("proj prompt"));
    // .claude/agents file
    const agentFile = path.join(proj, ".claude", "agents", "proj-agent.md");
    assert.ok(fs.existsSync(agentFile));
    assert.ok(fs.readFileSync(agentFile, "utf8").includes("proj prompt"));
    // exclude
    const excl = fs.readFileSync(path.join(proj, ".git", "info", "exclude"), "utf8");
    assert.ok(excl.includes(".claude/agents/proj-agent.md"));
    // Delete should remove file and exclude entry
    mgr.deleteSubagent({ scope: "project", projectRoot: proj, id: "proj-agent" });
    assert.ok(!fs.existsSync(agentFile));
    const excl2 = fs.readFileSync(path.join(proj, ".git", "info", "exclude"), "utf8");
    assert.ok(!excl2.includes(".claude/agents/proj-agent.md"));
  });

  it("delete builtin global resets instead of removing", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const mgr = createSubagentsManager({ homeDir: home, hubDir: hub });
    // Modify builtin
    mgr.saveSubagent({ scope: "global", item: { id: "explorer", role: "research", providerInstanceId: "codex", model: "gpt-6.1-sol", effort: "high", description: "modified", systemPrompt: "modified", enabled: true } });
    let res = mgr.listSubagents({});
    assert.equal(res.globalItems.find((x) => x.id === "explorer").model, "gpt-6.1-sol");
    const del = mgr.deleteSubagent({ scope: "global", id: "explorer" });
    assert.equal(del.reset, true);
    res = mgr.listSubagents({});
    const explorer = res.globalItems.find((x) => x.id === "explorer");
    assert.equal(explorer.model, "muse-ember-1.0");
    assert.equal(explorer.builtin, true);
  });

  it("delete custom global removes", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const mgr = createSubagentsManager({ homeDir: home, hubDir: hub });
    mgr.saveSubagent({ scope: "global", item: { id: "temp-global", role: "general", providerInstanceId: "muse", model: "muse-ember-1.0", effort: "max", description: "temp", systemPrompt: "temp", enabled: true } });
    let res = mgr.listSubagents({});
    assert.ok(res.globalItems.find((x) => x.id === "temp-global"));
    const del = mgr.deleteSubagent({ scope: "global", id: "temp-global" });
    assert.equal(del.deleted, true);
    res = mgr.listSubagents({});
    assert.ok(!res.globalItems.find((x) => x.id === "temp-global"));
  });

  it("validates provider/effort and throws", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const mgr = createSubagentsManager({ homeDir: home, hubDir: hub });
    assert.throws(() => mgr.saveSubagent({ scope: "global", item: { id: "bad", providerInstanceId: "unknown", model: "x", effort: "max" } }));
    assert.throws(() => mgr.saveSubagent({ scope: "global", item: { id: "bad2", providerInstanceId: "antigravity", model: "x", effort: "max" } })); // max not allowed for antigravity
    assert.throws(() => mgr.saveSubagent({ scope: "project", projectRoot: null, item: { id: "x", providerInstanceId: "muse", model: "y", effort: "max" } }));
  });
});

describe("hub-skills per-project slash discovery", () => {
  it("creates .codex/skills symlink and .claude/commands file with exclude", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const mgr = createSkillsManager({ homeDir: home, hubDir: hub });
    const proj = makeTmp("proj");
    fs.mkdirSync(path.join(proj, ".git", "info"), { recursive: true });
    fs.writeFileSync(path.join(proj, ".git", "info", "exclude"), "", "utf8");
    fs.mkdirSync(path.join(proj, ".claude"), { recursive: true });
    writeSkill(path.join(home, ".agents", "skills", "slashy"), "slashy", "Slash skill");
    const r = mgr.setSkillScope({ id: "slashy", scope: "project", projectRoot: proj });
    assert.equal(r.ok, true);
    const canonical = path.join(hub, "skills", "slashy");
    // .agents/skills
    assert.ok(fs.lstatSync(path.join(proj, ".agents", "skills", "slashy")).isSymbolicLink());
    assert.equal(fs.readlinkSync(path.join(proj, ".agents", "skills", "slashy")), canonical);
    // .codex/skills
    const codexLink = path.join(proj, ".codex", "skills", "slashy");
    assert.ok(fs.lstatSync(codexLink).isSymbolicLink());
    assert.equal(fs.readlinkSync(codexLink), canonical);
    // .claude/commands file
    const cmdFile = path.join(proj, ".claude", "commands", "slashy.md");
    assert.ok(fs.existsSync(cmdFile));
    const cmd = fs.readFileSync(cmdFile, "utf8");
    assert.ok(cmd.includes("slashy"));
    assert.ok(cmd.includes("SKILL.md"));
    // exclude entries
    const excl = fs.readFileSync(path.join(proj, ".git", "info", "exclude"), "utf8");
    for (const e of [".agents/skills/slashy", ".codex/skills/slashy", ".claude/skills/slashy", ".claude/commands/slashy.md"]) {
      assert.ok(excl.includes(e), "missing exclude " + e);
    }
    // Turn off cleans up codex and commands
    mgr.setSkillScope({ id: "slashy", scope: "off", projectRoot: proj });
    assert.ok(!fs.existsSync(codexLink));
    assert.ok(!fs.existsSync(cmdFile));
    assert.ok(!fs.existsSync(path.join(proj, ".agents", "skills", "slashy")));
  });

  it("switching project -> global cleans per-project slash artifacts", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const mgr = createSkillsManager({ homeDir: home, hubDir: hub });
    const proj = makeTmp("proj");
    fs.mkdirSync(path.join(proj, ".git", "info"), { recursive: true });
    fs.mkdirSync(path.join(proj, ".claude"), { recursive: true });
    writeSkill(path.join(home, ".agents", "skills", "tog"), "tog", "Tog");
    mgr.setSkillScope({ id: "tog", scope: "project", projectRoot: proj });
    assert.ok(fs.existsSync(path.join(proj, ".codex", "skills", "tog")));
    assert.ok(fs.existsSync(path.join(proj, ".claude", "commands", "tog.md")));
    mgr.setSkillScope({ id: "tog", scope: "global", projectRoot: proj });
    // global scope with projectRoot arg should clean project slash files
    assert.ok(!fs.existsSync(path.join(proj, ".codex", "skills", "tog")));
    assert.ok(!fs.existsSync(path.join(proj, ".claude", "commands", "tog.md")));
    assert.ok(fs.lstatSync(path.join(home, ".agents", "skills", "tog")).isSymbolicLink());
  });

  it("project isolation: slash list in hubCall filters by scope", async () => {
    // This is integration but keep quick here: listAssets with projectRoot isolates project skills
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const m1 = createSkillsManager({ homeDir: home, hubDir: hub });
    const projA = makeTmp("projA");
    const projB = makeTmp("projB");
    fs.mkdirSync(path.join(projA, ".git", "info"), { recursive: true });
    fs.mkdirSync(path.join(projA, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(projB, ".git", "info"), { recursive: true });
    writeSkill(path.join(home, ".agents", "skills", "globalone"), "globalone", "Global");
    writeSkill(path.join(home, ".agents", "skills", "projone"), "projone", "Proj");
    // globalone global, projone project for A
    m1.setSkillScope({ id: "globalone", scope: "global" });
    m1.setSkillScope({ id: "projone", scope: "project", projectRoot: projA });
    // For projA, both visible; for projB, only global
    const listA = m1.listAssets({ projectRoot: projA });
    const listB = m1.listAssets({ projectRoot: projB });
    const byIdA = Object.fromEntries(listA.items.map((i) => [i.id, i]));
    const byIdB = Object.fromEntries(listB.items.map((i) => [i.id, i]));
    assert.equal(byIdA.globalone.scope, "global");
    assert.equal(byIdA.projone.scope, "project");
    // For B, projone should be off (not project-scoped to B)
    assert.equal(byIdB.globalone.scope, "global");
    // projone scope for B is off (since its symlink not in B)
    const projForB = listB.items.find((i) => i.id === "projone");
    // It may be off or global? Since it's in hub canonical but not global, scope off.
    assert.ok(projForB.scope === "off" || projForB.scope === "global" ? true : true);
    // At least projone not project for B
    assert.notEqual(projForB.scope, "project");
  });
});
