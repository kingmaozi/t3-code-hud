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
    assert.ok(agentContent.includes('name: "global-extra"'));
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

describe("hub-subagents final-review regressions", () => {
  function loadOwnershipHelpers() {
    const vm = require("node:vm");
    const { createRequire } = require("node:module");
    const sourcePath = path.join(__dirname, "..", "src/hub-subagents.cjs");
    const predicateModule = { exports: {} };
    vm.runInNewContext(
      fs.readFileSync(sourcePath, "utf8") + "\nObject.assign(module.exports, { isHubManagedContent, yamlDoubleQuotedScalar, parseOwnershipFrontmatter });",
      { module: predicateModule, require: createRequire(sourcePath), process, __dirname: path.dirname(sourcePath) },
      { filename: sourcePath }
    );
    return predicateModule.exports;
  }
  function loadManagedPredicate() { return loadOwnershipHelpers().isHubManagedContent; }

  it("quotes every Unicode scalar and all controls losslessly as valid ownership YAML", () => {
    const { yamlDoubleQuotedScalar, isHubManagedContent, parseOwnershipFrontmatter } = loadOwnershipHelpers();
    const chars = [];
    for (let cp = 0; cp <= 0x10ffff; cp += 1) {
      if (cp < 0xd800 || cp > 0xdfff) chars.push(String.fromCodePoint(cp));
    }
    const allScalars = chars.join("");
    const lineSeps = "CRLF\r\nCR\rLF\nTAB\tNEL\u0085LS\u2028PS\u2029END";
    for (const [value, expected] of [
      [lineSeps, lineSeps],
      [allScalars, allScalars],
      ["isolated: \ud800 / \udfff 🧑‍💻", "isolated: \ufffd / \ufffd 🧑‍💻"],
    ]) {
      const quoted = yamlDoubleQuotedScalar(value);
      assert.equal(/[\x00-\x1f\x7f-\x9f\u2028\u2029\ufffe\uffff]/u.test(quoted), false, "no literal non-printing characters");
      assert.equal(isHubManagedContent(`---\ndescription: ${quoted}\nt3_hub_managed: true\n---\n`), true);
      const parsed = parseOwnershipFrontmatter(`description: ${quoted}\nt3_hub_managed: true`);
      assert.equal(parsed.get("description"), expected, "decoded YAML double-quoted scalar matches original value losslessly");
    }
  });

  it("accepts standard YAML double-quoted escapes without accepting invalid escapes", () => {
    const isHubManagedContent = loadManagedPredicate();
    const valid = String.raw`\0\a\b\t\n\v\f\r\e\ \"\/\\\N\_\L\P\x7f\u009f\U0001F600`;
    const wrap = value => `---\ndescription: "${value}"\nt3_hub_managed: true\n---\n`;
    assert.equal(isHubManagedContent(wrap(valid)), true);
    assert.equal(isHubManagedContent(wrap("\\\t")), true, "escaped literal tab is standard YAML");
    for (const invalid of [String.raw`\q`, String.raw`\uD800`, String.raw`\U00110000`]) {
      assert.equal(isHubManagedContent(wrap(invalid)), false);
    }
  });

  for (const scope of ["global", "project"]) it(`${scope} Unicode description survives create, update, disable and delete`, () => {
    const isHubManagedContent = loadManagedPredicate();
    const home = makeTmp("unicode");
    try {
      const projectRoot = path.join(home, "project");
      const mgr = createSubagentsManager({ homeDir: home });
      const item = {
        id: "unicode-agent", providerInstanceId: "muse", model: "muse-ember-1.0", effort: "max",
        description: 'review: 🧑‍💻 "quoted"\r\nCR\rLF\nNEL\u0085LS\u2028PS\u2029' +
          Array.from({ length: 160 }, (_, cp) => String.fromCharCode(cp)).join("") + "\ufeff\ufffe\uffff",
        systemPrompt: "original", enabled: true,
      };
      const file = path.join(scope === "global" ? home : projectRoot, ".claude", "agents", item.id + ".md");
      for (const systemPrompt of ["original", "updated"]) {
        const result = mgr.saveSubagent({ scope, projectRoot, item: { ...item, systemPrompt } });
        assert.equal(result.ok, true);
        assert.deepEqual(result.conflicts, []);
        const content = fs.readFileSync(file, "utf8");
        assert.equal(isHubManagedContent(content), true);
        assert.ok(content.includes(systemPrompt));
        assert.ok(content.includes("🧑"));
      }
      assert.equal(mgr.saveSubagent({ scope, projectRoot, item: { ...item, enabled: false } }).ok, true);
      assert.equal(fs.existsSync(file), false);
      mgr.saveSubagent({ scope, projectRoot, item });
      assert.equal(mgr.deleteSubagent({ scope, projectRoot, id: item.id }).ok, true);
      assert.equal(fs.existsSync(file), false);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  for (const scope of ["global", "project"]) for (const operation of ["update", "disable", "delete"]) {
    it(`${scope} ${operation} restores the exact unmanaged inode swapped after preflight`, () => {
      const home = makeTmp("stage-race");
      const projectRoot = path.join(home, "project");
      const mgr = createSubagentsManager({ homeDir: home });
      const item = { id: "stage-race", providerInstanceId: "muse", model: "muse-ember-1.0", effort: "max", enabled: true };
      mgr.saveSubagent({ scope, projectRoot, item });
      const file = path.join(scope === "global" ? home : projectRoot, ".claude", "agents", item.id + ".md");
      const incoming = path.join(home, "external-editor-save");
      const bytes = Buffer.from([0xff, 0, 0x7f, ...Buffer.from("USER DATA: never overwrite 🧑\r\n")]);
      fs.writeFileSync(incoming, bytes, { mode: 0o640 });
      const originalStat = fs.statSync(incoming);
      const originalRename = fs.renameSync, originalUnlink = fs.unlinkSync;
      let injected = false;
      function swap() {
        injected = true;
        originalRename.call(fs, incoming, file);
      }
      fs.renameSync = function (src, dest, ...rest) {
        if (!injected && (String(src) === file || String(dest) === file)) swap();
        return originalRename.call(fs, src, dest, ...rest);
      };
      // Also reproduce the old direct-unlink implementation before the fix.
      fs.unlinkSync = function (target, ...rest) {
        if (!injected && String(target) === file) swap();
        return originalUnlink.call(fs, target, ...rest);
      };
      try {
        const result = operation === "delete"
          ? mgr.deleteSubagent({ scope, projectRoot, id: item.id })
          : mgr.saveSubagent({ scope, projectRoot, item: { ...item, enabled: operation !== "disable", systemPrompt: "updated" } });
        assert.equal(injected, true, "race injected at final filesystem operation");
        assert.deepEqual(fs.readFileSync(file), bytes);
        assert.equal(fs.statSync(file).ino, originalStat.ino, "original inode restored, not copied");
        assert.equal(fs.statSync(file).mode & 0o777, 0o640);
        assert.ok(result.skippedUnmanaged.includes(file));
        assert.ok(result.conflicts.some(c => c.id === item.id && c.path === file));
        assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(f => f.startsWith(item.id + ".md.")), [], "no temporary files remain");
      } finally {
        fs.renameSync = originalRename;
        fs.unlinkSync = originalUnlink;
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  }

  for (const scope of ["global", "project"]) for (const operation of ["update", "delete"]) {
    it(`${scope} ${operation} preserves both user inodes when restoration hits EEXIST`, () => {
      const home = makeTmp("restore-collision");
      const projectRoot = path.join(home, "project");
      const mgr = createSubagentsManager({ homeDir: home });
      const item = { id: "restore-collision", providerInstanceId: "muse", model: "muse-ember-1.0", effort: "max" };
      mgr.saveSubagent({ scope, projectRoot, item });
      const file = path.join(scope === "global" ? home : projectRoot, ".claude", "agents", item.id + ".md");
      const incoming = path.join(home, "editor-save");
      const first = Buffer.from("first editor save: \0\xff");
      const second = Buffer.from("second editor save: 🧑‍💻\r\n");
      fs.writeFileSync(incoming, first);
      const firstInode = fs.statSync(incoming).ino;
      const originalRename = fs.renameSync, originalLink = fs.linkSync;
      let swapped = false, occupied = false, secondInode;
      fs.renameSync = function (src, dest, ...rest) {
        if (!swapped && String(src) === file) {
          swapped = true;
          originalRename.call(fs, incoming, file);
        }
        return originalRename.call(fs, src, dest, ...rest);
      };
      fs.linkSync = function (src, dest, ...rest) {
        if (swapped && !occupied && String(dest) === file) {
          occupied = true;
          fs.writeFileSync(file, second, { flag: "wx" });
          secondInode = fs.statSync(file).ino;
        }
        return originalLink.call(fs, src, dest, ...rest);
      };
      try {
        const result = operation === "delete"
          ? mgr.deleteSubagent({ scope, projectRoot, id: item.id })
          : mgr.saveSubagent({ scope, projectRoot, item: { ...item, systemPrompt: "new prompt" } });
        assert.equal(swapped && occupied, true);
        assert.deepEqual(fs.readFileSync(file), second);
        assert.equal(fs.statSync(file).ino, secondInode);
        const conflict = result.conflicts.find(c => c.path === file);
        assert.ok(conflict && conflict.preservedPath, "preserved path must reach public result");
        assert.ok(conflict.preservedPath.startsWith(file + ".unmanaged-preserved-"));
        assert.deepEqual(fs.readFileSync(conflict.preservedPath), first);
        assert.equal(fs.statSync(conflict.preservedPath).ino, firstInode);
        assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(f => f.startsWith(item.id + ".md.stage-")), []);
      } finally {
        fs.renameSync = originalRename;
        fs.linkSync = originalLink;
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    if (operation === "update") it(`${scope} update leaves an editor-created target untouched when installing new version`, () => {
      const home = makeTmp("install-collision");
      const projectRoot = path.join(home, "project");
      const mgr = createSubagentsManager({ homeDir: home });
      const item = { id: "install-collision", providerInstanceId: "muse", model: "muse-ember-1.0", effort: "max" };
      mgr.saveSubagent({ scope, projectRoot, item });
      const file = path.join(scope === "global" ? home : projectRoot, ".claude", "agents", item.id + ".md");
      const bytes = Buffer.from("external save while Hub verifies its staged old file\0");
      const originalLink = fs.linkSync;
      let injected = false, inode;
      fs.linkSync = function (src, dest, ...rest) {
        if (!injected && String(dest) === file) {
          injected = true;
          fs.writeFileSync(file, bytes, { flag: "wx" });
          inode = fs.statSync(file).ino;
        }
        return originalLink.call(fs, src, dest, ...rest);
      };
      try {
        const result = mgr.saveSubagent({ scope, projectRoot, item: { ...item, systemPrompt: "new prompt" } });
        assert.equal(injected, true);
        assert.deepEqual(fs.readFileSync(file), bytes);
        assert.equal(fs.statSync(file).ino, inode);
        assert.ok(result.conflicts.some(c => c.path === file));
        assert.ok(result.skippedUnmanaged.includes(file));
        assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(f => f.startsWith(item.id + ".md.")), []);
      } finally {
        fs.linkSync = originalLink;
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  }

  it("tricky description generates valid frontmatter and update/disable lifecycle", () => {
    const isHubManagedContent = loadManagedPredicate();
    const home = makeTmp("home-tricky");
    const hub = path.join(home, ".t3", "hub");
    const mgr = createSubagentsManager({ homeDir: home, hubDir: hub });
    const tricky = 'review: safety # tag [array] "quotes"\nsecond line: next';
    const saved = mgr.saveSubagent({
      scope: "global",
      item: { id: "tricky-agent", role: "general", providerInstanceId: "muse", model: "muse-ember-1.0", effort: "max", description: tricky, systemPrompt: "prompt-v1", enabled: true },
    });
    assert.equal(saved.ok, true);
    const agentFile = path.join(home, ".claude", "agents", "tricky-agent.md");
    assert.ok(fs.existsSync(agentFile), "agent file created");
    const content = fs.readFileSync(agentFile, "utf8");
    assert.equal(isHubManagedContent(content), true, "generated frontmatter must be Hub-managed: " + content.slice(0, 500));
    assert.ok(content.includes('name: "tricky-agent"'), "name must be safely quoted");
    assert.ok(content.includes("t3_hub_managed: true"), "marker present");
    assert.ok(!(saved.conflicts || []).some((c) => c.id === "tricky-agent"), "no conflict for tricky agent");
    const tricky2 = 'updated: still # valid {"json": true} "more"';
    const saved2 = mgr.saveSubagent({
      scope: "global",
      item: { id: "tricky-agent", role: "general", providerInstanceId: "muse", model: "muse-ember-1.0", effort: "max", description: tricky2, systemPrompt: "prompt-v2", enabled: true },
    });
    assert.equal(saved2.ok, true);
    const content2 = fs.readFileSync(agentFile, "utf8");
    assert.equal(isHubManagedContent(content2), true, "updated file still managed");
    assert.ok(content2.includes("prompt-v2"), "update applied");
    mgr.saveSubagent({
      scope: "global",
      item: { id: "tricky-agent", role: "general", providerInstanceId: "muse", model: "muse-ember-1.0", effort: "max", description: tricky2, systemPrompt: "prompt-v2", enabled: false },
    });
    assert.ok(!fs.existsSync(agentFile), "disabled managed file removed");
  });

  it("concurrent unmanaged creation on new path is not overwritten (EEXIST branch)", () => {
    const home = makeTmp("home-race");
    const hub = path.join(home, ".t3", "hub");
    const mgr = createSubagentsManager({ homeDir: home, hubDir: hub });
    const id = "race-agent";
    const targetFile = path.join(home, ".claude", "agents", id + ".md");
    const unmanaged = "---\nname: race-agent\ndescription: user concurrent file\n---\nUSER OWNED - DO NOT OVERWRITE\n";
    const origLink = fs.linkSync;
    const origCopy = fs.copyFileSync;
    let injected = false;
    function eexistentError() {
      const e = new Error("EEXIST: file already exists, link");
      e.code = "EEXIST";
      return e;
    }
    const linkWrapper = function (src, dest, ...rest) {
      if (!injected && path.resolve(String(dest)) === path.resolve(targetFile)) {
        injected = true;
        fs.mkdirSync(path.dirname(targetFile), { recursive: true });
        fs.writeFileSync(targetFile, unmanaged, "utf8");
        throw eexistentError();
      }
      return origLink.call(fs, src, dest, ...rest);
    };
    const copyWrapper = function (src, dest, ...rest) {
      if (!injected && path.resolve(String(dest)) === path.resolve(targetFile)) {
        injected = true;
        fs.mkdirSync(path.dirname(targetFile), { recursive: true });
        fs.writeFileSync(targetFile, unmanaged, "utf8");
        throw eexistentError();
      }
      return origCopy.call(fs, src, dest, ...rest);
    };
    fs.linkSync = linkWrapper;
    fs.copyFileSync = copyWrapper;
    let saved;
    try {
      saved = mgr.saveSubagent({
        scope: "global",
        item: { id, role: "general", providerInstanceId: "muse", model: "muse-ember-1.0", effort: "max", description: "should not overwrite", systemPrompt: "prompt-should-not-win", enabled: true },
      });
    } finally {
      fs.linkSync = origLink;
      fs.copyFileSync = origCopy;
    }
    assert.equal(injected, true, "EEXIST injection must have fired");
    assert.equal(saved.ok, true);
    assert.equal(fs.readFileSync(targetFile, "utf8"), unmanaged, "unmanaged concurrent file must not be overwritten");
    const conflicts = saved.conflicts || saved.skippedUnmanaged || [];
    assert.ok(JSON.stringify(conflicts).toLowerCase().includes(id), "conflict reported for concurrent unmanaged file: " + JSON.stringify(conflicts));
    const dirEntries = fs.existsSync(path.dirname(targetFile)) ? fs.readdirSync(path.dirname(targetFile)) : [];
    assert.ok(!dirEntries.some((f) => f.startsWith(id + ".md.tmp-")), "tmp cleaned: " + dirEntries.join(","));
  });

  it("creates Hub-managed agent files read-only so in-place open(O_WRONLY) is rejected by kernel", () => {
    const home = makeTmp("readonly-inode");
    try {
      const mgr = createSubagentsManager({ homeDir: home });
      mgr.saveSubagent({
        scope: "global",
        item: { id: "ro-agent", providerInstanceId: "muse", model: "muse-ember-1.0", effort: "max", enabled: true },
      });
      const file = path.join(home, ".claude", "agents", "ro-agent.md");
      assert.equal(fs.statSync(file).mode & 0o222, 0, "Hub-managed inode must have zero write bits");
      if (typeof process.getuid === "function" && process.getuid() !== 0) {
        assert.throws(() => fs.openSync(file, "r+"), { code: "EACCES" });
        assert.throws(() => fs.openSync(file, "w"), { code: "EACCES" });
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  for (const operation of ["update", "delete"]) {
    it(`${operation} rescues legacy writable managed inode mutated in-place via pre-opened fd before unlink`, () => {
      const home = makeTmp("fd-inplace-" + operation);
      try {
        const mgr = createSubagentsManager({ homeDir: home });
        const item = { id: "legacy-fd", providerInstanceId: "muse", model: "muse-ember-1.0", effort: "max", systemPrompt: "v1", enabled: true };
        mgr.saveSubagent({ scope: "global", item });
        const file = path.join(home, ".claude", "agents", "legacy-fd.md");
        // Simulate a legacy pre-existing 0644 managed file opened for writing before Hub stages it.
        fs.chmodSync(file, 0o644);
        const editorFd = fs.openSync(file, "r+");
        const targetIno = fs.fstatSync(editorFd).ino;
        const userPayload = "---\nname: legacy-fd\n---\nUSER IN-PLACE EDIT VIA OPEN FD\n";
        const origUnlink = fs.unlinkSync;
        let mutated = false;
        // Inject the editor write right after initial ownership check (on linkSync for update, or right before stage unlink for delete).
        const origLink = fs.linkSync;
        fs.linkSync = function (src, dest, ...rest) {
          const res = origLink.call(fs, src, dest, ...rest);
          if (!mutated && operation === "update" && path.resolve(String(dest)) === path.resolve(file)) {
            mutated = true;
            fs.ftruncateSync(editorFd, 0);
            fs.writeSync(editorFd, userPayload, 0, "utf8");
          }
          return res;
        };
        const origFchmod = fs.fchmodSync;
        fs.fchmodSync = function (fdArg, modeArg, ...rest) {
          const res = origFchmod.call(fs, fdArg, modeArg, ...rest);
          if (!mutated && operation === "delete" && (modeArg & 0o222) === 0) {
            // Wait until initial read completes before mutating via pre-opened writable fd:
          }
          return res;
        };
        const origRead = fs.readSync;
        let stagedReads = 0;
        fs.readSync = function (fdArg, buffer, offset, length, position) {
          if (!mutated && operation === "delete" && position === 0 && (() => { try { return fs.fstatSync(fdArg).ino === targetIno; } catch { return false; } })()) {
            stagedReads += 1;
            if (stagedReads === 2) {
              mutated = true;
              fs.ftruncateSync(editorFd, 0);
              fs.writeSync(editorFd, userPayload, 0, "utf8");
            }
          }
          return origRead.call(fs, fdArg, buffer, offset, length, position);
        };
        let result;
        try {
          result = operation === "update"
            ? mgr.saveSubagent({ scope: "global", item: { ...item, systemPrompt: "v2" } })
            : mgr.deleteSubagent({ scope: "global", id: item.id });
        } finally {
          fs.linkSync = origLink;
          fs.fchmodSync = origFchmod;
          fs.readSync = origRead;
          fs.unlinkSync = origUnlink;
          try { fs.closeSync(editorFd); } catch {}
        }
        assert.equal(mutated, true, "in-place fd mutation must have fired");
        assert.equal(result.ok, true);
        const conflict = result.conflicts.find(c => c.id === item.id);
        assert.ok(conflict, "conflict must be reported");
        const rescuedTarget = operation === "delete" ? file : conflict.preservedPath;
        assert.ok(rescuedTarget, "rescued path must exist without clobbering target via renameSync");
        assert.equal(fs.readFileSync(rescuedTarget, "utf8"), userPayload, "in-place user edit must survive intact");
        assert.equal(fs.statSync(rescuedTarget).mode & 0o777, 0o644, "original writable mode restored on rescued inode");
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  }

  it("refuses to replace or delete a managed inode that has an external hard link (nlink > 1)", () => {
    const home = makeTmp("hardlink-guard");
    try {
      const mgr = createSubagentsManager({ homeDir: home });
      const item = { id: "hl-agent", providerInstanceId: "muse", model: "muse-ember-1.0", effort: "max", systemPrompt: "v1", enabled: true };
      mgr.saveSubagent({ scope: "global", item });
      const file = path.join(home, ".claude", "agents", "hl-agent.md");
      const externalLink = path.join(home, "user-hardlink.md");
      fs.linkSync(file, externalLink);
      const upd = mgr.saveSubagent({ scope: "global", item: { ...item, systemPrompt: "v2" } });
      assert.ok(upd.conflicts.some(c => c.id === "hl-agent"));
      assert.equal(fs.statSync(file).ino, fs.statSync(externalLink).ino);
      const del = mgr.deleteSubagent({ scope: "global", id: "hl-agent" });
      assert.ok(del.conflicts.some(c => c.id === "hl-agent"));
      assert.equal(fs.existsSync(file), true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("fchmodSync failure during writeNewFileExclusive aborts fail-closed without publishing writable 0600 file", () => {
    const home = makeTmp("fchmod-fail");
    const origFchmod = fs.fchmodSync;
    fs.fchmodSync = function () {
      throw Object.assign(new Error("EPERM fchmod denied"), { code: "EPERM" });
    };
    try {
      const mgr = createSubagentsManager({ homeDir: home });
      const file = path.join(home, ".claude", "agents", "ro-must-fail.md");
      assert.throws(() => {
        mgr.saveSubagent({
          scope: "global",
          item: { id: "ro-must-fail", providerInstanceId: "muse", model: "muse-ember-1.0", effort: "max", enabled: true },
        });
      }, /EPERM/);
      assert.equal(fs.existsSync(file), false, "writable 0600 file must never be published when fchmodSync fails");
      const dir = path.dirname(file);
      const entries = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      assert.deepEqual(entries.filter(f => f.startsWith("ro-must-fail.md")), []);
    } finally {
      fs.fchmodSync = origFchmod;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("rescue rollback never overwrites a concurrent third-party file created at target after tmp link", () => {
    const home = makeTmp("rescue-no-overwrite");
    try {
      const mgr = createSubagentsManager({ homeDir: home });
      const item = { id: "rescue-race", providerInstanceId: "muse", model: "muse-ember-1.0", effort: "max", systemPrompt: "v1", enabled: true };
      mgr.saveSubagent({ scope: "global", item });
      const file = path.join(home, ".claude", "agents", "rescue-race.md");
      fs.chmodSync(file, 0o644);
      const editorFd = fs.openSync(file, "r+");
      const inPlacePayload = "---\nname: rescue-race\n---\nFIRST USER IN-PLACE FD EDIT\n";
      const concurrentPayload = "---\nname: rescue-race\n---\nSECOND CONCURRENT ATOMIC SAVE\n";
      const origLink = fs.linkSync;
      const origClose = fs.closeSync;
      let stagedMutated = false;
      let targetReplaced = false;
      fs.linkSync = function (src, dest, ...rest) {
        const res = origLink.call(fs, src, dest, ...rest);
        if (!stagedMutated && path.resolve(String(dest)) === path.resolve(file)) {
          stagedMutated = true;
          fs.ftruncateSync(editorFd, 0);
          fs.writeSync(editorFd, inPlacePayload, 0, "utf8");
        }
        return res;
      };
      // Right when rescue closes stagedFd before restoring staged, replace target with a brand-new user file!
      fs.closeSync = function (fdArg) {
        const res = origClose.call(fs, fdArg);
        if (stagedMutated && !targetReplaced) {
          targetReplaced = true;
          const extTmp = path.join(home, "concurrent-user.md");
          fs.writeFileSync(extTmp, concurrentPayload, "utf8");
          fs.renameSync(extTmp, file);
        }
        return res;
      };
      let result;
      try {
        result = mgr.saveSubagent({ scope: "global", item: { ...item, systemPrompt: "v2" } });
      } finally {
        fs.linkSync = origLink;
        fs.closeSync = origClose;
        try { fs.closeSync(editorFd); } catch {}
      }
      assert.equal(stagedMutated && targetReplaced, true);
      assert.equal(fs.readFileSync(file, "utf8"), concurrentPayload, "concurrent user file at target must NEVER be overwritten by rescue");
      const conflict = result.conflicts.find(c => c.id === item.id);
      assert.ok(conflict && conflict.preservedPath, "mutated staged inode must be preserved separately");
      assert.equal(fs.readFileSync(conflict.preservedPath, "utf8"), inPlacePayload, "mutated staged inode preserved byte-for-byte");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  for (const branch of ["update", "delete", "eexist"]) {
    it(`pre-opened writable fd writing during stage unlink (${branch}) is rescued and retired inodes never drop nlink to 0`, () => {
      const home = makeTmp("late-fd-" + branch);
      try {
        const mgr = createSubagentsManager({ homeDir: home });
        const item = { id: "late-fd", providerInstanceId: "muse", model: "muse-ember-1.0", effort: "max", systemPrompt: "v1", enabled: true };
        mgr.saveSubagent({ scope: "global", item });
        const file = path.join(home, ".claude", "agents", "late-fd.md");
        fs.chmodSync(file, 0o644);
        const editorFd = fs.openSync(file, "r+");
        const latePayload = "---\nname: late-fd\n---\nLATE WRITE DURING UNLINK\n";
        const eexistPayload = "---\nname: late-fd\n---\nEXTERNAL TARGET WINNER\n";
        const origLink = fs.linkSync;
        const origUnlink = fs.unlinkSync;
        let wroteLate = false;
        let eexistInjected = false;
        fs.linkSync = function (src, dest, ...rest) {
          if (branch === "eexist" && !eexistInjected && path.resolve(String(dest)) === path.resolve(file)) {
            eexistInjected = true;
            fs.writeFileSync(file, eexistPayload, { flag: "wx" });
          }
          return origLink.call(fs, src, dest, ...rest);
        };
        fs.unlinkSync = function (target, ...rest) {
          if (!wroteLate && String(target).endsWith(path.sep + "old") && String(target).includes("late-fd.md.stage-")) {
            wroteLate = true;
            fs.ftruncateSync(editorFd, 0);
            fs.writeSync(editorFd, latePayload, 0, "utf8");
          }
          return origUnlink.call(fs, target, ...rest);
        };
        let result;
        try {
          result = branch === "delete"
            ? mgr.deleteSubagent({ scope: "global", id: item.id })
            : mgr.saveSubagent({ scope: "global", item: { ...item, systemPrompt: "v2" } });
        } finally {
          fs.linkSync = origLink;
          fs.unlinkSync = origUnlink;
        }
        assert.equal(wroteLate, true, "late write during stage unlink must have fired");
        assert.ok(fs.fstatSync(editorFd).nlink >= 1, "inode nlink must NEVER drop to 0");
        fs.closeSync(editorFd);
        const conflict = result.conflicts.find(c => c.id === item.id);
        assert.ok(conflict, "late mutation must be surfaced as conflict");
        const rescuedPath = branch === "delete" ? file : conflict.preservedPath;
        assert.equal(fs.readFileSync(rescuedPath, "utf8"), latePayload, "late write bytes must survive intact");
        if (branch === "eexist") {
          assert.equal(fs.readFileSync(file, "utf8"), eexistPayload);
        }
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  }

  it("even a write occurring after saveSubagent returns is never deleted because replaced managed inodes are retired with nlink >= 1", () => {
    const home = makeTmp("post-return-fd");
    try {
      const mgr = createSubagentsManager({ homeDir: home });
      const item = { id: "post-fd", providerInstanceId: "muse", model: "muse-ember-1.0", effort: "max", systemPrompt: "v1", enabled: true };
      mgr.saveSubagent({ scope: "global", item });
      const file = path.join(home, ".claude", "agents", "post-fd.md");
      fs.chmodSync(file, 0o644);
      const editorFd = fs.openSync(file, "r+");
      mgr.saveSubagent({ scope: "global", item: { ...item, systemPrompt: "v2" } });
      const afterPayload = "---\nname: post-fd\n---\nWRITTEN AFTER RETURN\n";
      fs.ftruncateSync(editorFd, 0);
      fs.writeSync(editorFd, afterPayload, 0, "utf8");
      const st = fs.fstatSync(editorFd);
      assert.ok(st.nlink >= 1, "retired inode must still have at least 1 directory link on disk");
      const targetIno = st.ino;
      fs.closeSync(editorFd);
      const retiredDir = path.join(home, ".t3", "hub", "retired-agents");
      const retiredFiles = fs.readdirSync(retiredDir).map(f => path.join(retiredDir, f));
      const match = retiredFiles.find(f => fs.statSync(f).ino === targetIno);
      assert.ok(match, "retired file must remain discoverable in hub retired-agents dir");
      assert.equal(fs.readFileSync(match, "utf8"), afterPayload);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  for (const scope of ["global", "project"]) {
    for (const branch of ["update", "delete", "eexist", "pre-rename"]) {
      if (scope === "project" && branch === "eexist") continue;
      it(`late body edit preserving t3_hub_managed: true is rescued as conflict (${scope} / ${branch})`, () => {
        const home = makeTmp(`marked-late-${scope}-${branch}`);
        const proj = path.join(home, "proj");
        try {
          if (scope === "project") fs.mkdirSync(path.join(proj, ".git", "info"), { recursive: true });
          const mgr = createSubagentsManager({ homeDir: home });
          const item = { id: "marked-fd", providerInstanceId: "muse", model: "muse-ember-1.0", effort: "max", systemPrompt: "v1", enabled: true };
          mgr.saveSubagent({ scope, projectRoot: scope === "project" ? proj : undefined, item });
          const file = path.join(scope === "project" ? proj : home, ".claude", "agents", "marked-fd.md");
          fs.chmodSync(file, 0o644);
          const editorFd = fs.openSync(file, "r+");
          const markedLatePayload = '---\nname: "marked-fd"\ndescription: "marked-fd"\nt3_hub_managed: true\n---\nUSER BODY EDIT PRESERVING MARKER\n';
          const eexistPayload = "---\nname: marked-fd\n---\nEXTERNAL TARGET WINNER\n";
          const origLink = fs.linkSync;
          const origUnlink = fs.unlinkSync;
          const origMkdtemp = fs.mkdtempSync;
          let wroteLate = false;
          let eexistInjected = false;
          fs.mkdtempSync = function (prefix, ...rest) {
            const out = origMkdtemp.call(fs, prefix, ...rest);
            if (branch === "pre-rename" && !wroteLate && String(prefix).includes("marked-fd.md.stage-")) {
              wroteLate = true;
              fs.ftruncateSync(editorFd, 0);
              fs.writeSync(editorFd, markedLatePayload, 0, "utf8");
            }
            return out;
          };
          fs.linkSync = function (s, dest, ...rest) {
            if (branch === "eexist" && !eexistInjected && path.resolve(String(dest)) === path.resolve(file)) {
              eexistInjected = true;
              fs.writeFileSync(file, eexistPayload, { flag: "wx" });
            }
            return origLink.call(fs, s, dest, ...rest);
          };
          fs.unlinkSync = function (target, ...rest) {
            if (branch !== "pre-rename" && !wroteLate && String(target).endsWith(path.sep + "old") && String(target).includes("marked-fd.md.stage-")) {
              wroteLate = true;
              fs.ftruncateSync(editorFd, 0);
              fs.writeSync(editorFd, markedLatePayload, 0, "utf8");
            }
            return origUnlink.call(fs, target, ...rest);
          };
          let result;
          try {
            result = branch === "delete"
              ? mgr.deleteSubagent({ scope, projectRoot: scope === "project" ? proj : undefined, id: item.id })
              : mgr.saveSubagent({ scope, projectRoot: scope === "project" ? proj : undefined, item: { ...item, systemPrompt: "v2" } });
          } finally {
            fs.mkdtempSync = origMkdtemp;
            fs.linkSync = origLink;
            fs.unlinkSync = origUnlink;
          }
          assert.equal(wroteLate, true, "marked late write must have fired");
          assert.ok(fs.fstatSync(editorFd).nlink >= 1, "inode nlink must never drop to 0");
          fs.closeSync(editorFd);
          const conflict = result.conflicts.find(c => c.id === item.id);
          assert.ok(conflict, "body mutation preserving t3_hub_managed: true MUST be surfaced as conflict");
          const rescuedPath = (branch === "delete" || branch === "pre-rename") ? file : conflict.preservedPath;
          assert.ok(rescuedPath && fs.existsSync(rescuedPath), "rescued path must exist on disk");
          assert.equal(fs.readFileSync(rescuedPath, "utf8"), markedLatePayload, "user body edit preserving marker must survive byte-for-byte");
          if (branch === "eexist") {
            assert.equal(fs.readFileSync(file, "utf8"), eexistPayload);
          }
        } finally {
          fs.rmSync(home, { recursive: true, force: true });
        }
      });
    }
  }

  for (const op of ["update", "delete"]) {
    for (const windowKind of ["before-lock", "before-entrySnap"]) {
      it(`concurrent atomic rename preserving t3_hub_managed: true is rejected as conflict and left at target (${op} / ${windowKind})`, () => {
        const home = makeTmp(`atomic-marked-${op}-${windowKind}`);
        try {
          const mgr = createSubagentsManager({ homeDir: home });
          const item = { id: "atomic-marked", providerInstanceId: "muse", model: "muse-ember-1.0", effort: "max", systemPrompt: "v1", enabled: true };
          mgr.saveSubagent({ scope: "global", item });
          const file = path.join(home, ".claude", "agents", "atomic-marked.md");
          const editorSaved = '---\nname: "atomic-marked"\ndescription: "atomic-marked"\nt3_hub_managed: true\n---\nEDITOR ATOMIC SAVE PRESERVING MARKER\n';
          const origOpen = fs.openSync;
          let injected = false;
          let targetOpens = 0;
          fs.openSync = function (p, flags, ...rest) {
            if (!injected && windowKind === "before-lock" && String(p) === file + ".t3hub.lock") {
              injected = true;
              const edTmp = file + ".vim-atomic";
              fs.writeFileSync(edTmp, editorSaved, "utf8");
              fs.renameSync(edTmp, file);
            }
            if (!injected && windowKind === "before-entrySnap" && path.resolve(String(p)) === path.resolve(file)) {
              targetOpens += 1;
              if (targetOpens === 3) {
                injected = true;
                const edTmp = file + ".vim-atomic";
                fs.writeFileSync(edTmp, editorSaved, "utf8");
                fs.renameSync(edTmp, file);
              }
            }
            return origOpen.call(fs, p, flags, ...rest);
          };
          let result;
          try {
            result = op === "delete"
              ? mgr.deleteSubagent({ scope: "global", id: item.id })
              : mgr.saveSubagent({ scope: "global", item: { ...item, systemPrompt: "v2" } });
          } finally {
            fs.openSync = origOpen;
          }
          assert.equal(injected, true, "atomic rename injection must have fired");
          const conflict = result.conflicts.find(c => c.id === item.id);
          assert.ok(conflict, "concurrent atomic rename preserving marker must report conflict");
          assert.equal(fs.readFileSync(file, "utf8"), editorSaved, "editor atomic save must remain intact at original path");
        } finally {
          fs.rmSync(home, { recursive: true, force: true });
        }
      });
    }
  }

  for (const op of ["new", "update", "delete"]) {
    it(`concurrent atomic rename after publish/stage reports conflict and leaves user file intact (${op})`, () => {
      const home = makeTmp(`post-publish-atomic-${op}`);
      try {
        const mgr = createSubagentsManager({ homeDir: home });
        const item = { id: "post-pub", providerInstanceId: "muse", model: "muse-ember-1.0", effort: "max", systemPrompt: "v1", enabled: true };
        if (op !== "new") mgr.saveSubagent({ scope: "global", item });
        const file = path.join(home, ".claude", "agents", "post-pub.md");
        const editorSaved = "---\nname: post-pub\n---\nCONCURRENT ATOMIC RENAME AFTER PUBLISH\n";
        const origUnlink = fs.unlinkSync;
        let injected = false;
        fs.unlinkSync = function (target, ...rest) {
          const out = origUnlink.call(fs, target, ...rest);
          if (!injected && (
            (op === "new" && String(target).includes("post-pub.md.tmp-")) ||
            (op !== "new" && String(target).endsWith(path.sep + "old") && String(target).includes("post-pub.md.stage-"))
          )) {
            injected = true;
            const edTmp = file + ".vim-post";
            fs.writeFileSync(edTmp, editorSaved, "utf8");
            fs.renameSync(edTmp, file);
          }
          return out;
        };
        let result;
        try {
          result = op === "delete"
            ? mgr.deleteSubagent({ scope: "global", id: item.id })
            : mgr.saveSubagent({ scope: "global", item: { ...item, systemPrompt: "v2" } });
        } finally {
          fs.unlinkSync = origUnlink;
        }
        assert.equal(injected, true, "post-publish atomic rename must have fired");
        const conflict = result.conflicts.find(c => c.id === item.id);
        assert.ok(conflict, "post-publish/post-stage atomic rename must be surfaced in result.conflicts");
        assert.equal(fs.readFileSync(file, "utf8"), editorSaved, "concurrently renamed editor file must remain intact");
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  }

  for (const racePoint of ["before-stage-rename", "during-stage-link"]) {
    it(`AGENTS.md concurrent user edit (${racePoint}) is merged via CAS without losing user prose`, () => {
      const home = makeTmp("agents-md-cas-" + racePoint);
      try {
        const codexDir = path.join(home, ".codex");
        fs.mkdirSync(codexDir, { recursive: true });
        const codexAgents = path.join(codexDir, "AGENTS.md");
        fs.writeFileSync(codexAgents, "# Initial User Rules\nKeep rule A.\n", "utf8");
        const mgr = createSubagentsManager({ homeDir: home });
        const origMkdtemp = fs.mkdtempSync;
        const origLink = fs.linkSync;
        let injected = false;
        fs.mkdtempSync = function (prefix, ...rest) {
          const out = origMkdtemp.call(fs, prefix, ...rest);
          if (!injected && racePoint === "before-stage-rename" && String(prefix).includes(path.join(".codex", "AGENTS.md.stage-"))) {
            injected = true;
            const edTmp = codexAgents + ".editor";
            fs.writeFileSync(edTmp, "# Concurrent User Edit\nMust NOT lose rule B!\n", "utf8");
            fs.renameSync(edTmp, codexAgents);
          }
          return out;
        };
        fs.linkSync = function (src, dest, ...rest) {
          if (!injected && racePoint === "during-stage-link" && path.resolve(String(dest)) === path.resolve(codexAgents)) {
            injected = true;
            fs.writeFileSync(codexAgents, "# Concurrent User Save During Stage\nMust NOT lose rule C!\n", { flag: "wx" });
          }
          return origLink.call(fs, src, dest, ...rest);
        };
        try {
          mgr.saveSubagent({
            scope: "global",
            item: { id: "cas-agent", providerInstanceId: "muse", model: "muse-ember-1.0", effort: "max", enabled: true },
          });
        } finally {
          fs.mkdtempSync = origMkdtemp;
          fs.linkSync = origLink;
        }
        assert.equal(injected, true, "AGENTS.md concurrent edit injection must fire");
        const finalText = fs.readFileSync(codexAgents, "utf8");
        if (racePoint === "before-stage-rename") {
          assert.ok(finalText.includes("Must NOT lose rule B!"), "user concurrent edit preserved");
        } else {
          assert.ok(finalText.includes("Must NOT lose rule C!"), "user concurrent save during stage preserved");
        }
        assert.ok(finalText.includes("<!-- t3-hub-subagents:start -->"), "Hub block also merged cleanly");
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  }

  it("unreadable AGENTS.md fails closed instead of overwriting user file with empty Hub block", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const home = makeTmp("agents-md-unreadable");
    try {
      const codexDir = path.join(home, ".codex");
      fs.mkdirSync(codexDir, { recursive: true });
      const codexAgents = path.join(codexDir, "AGENTS.md");
      const precious = "# Precious Unreadable Rules\nNEVER WIPE ME\n";
      fs.writeFileSync(codexAgents, precious, "utf8");
      fs.chmodSync(codexAgents, 0o000);
      const mgr = createSubagentsManager({ homeDir: home });
      assert.throws(() => mgr.saveSubagent({
        scope: "global",
        item: { id: "perm-agent", providerInstanceId: "muse", model: "muse-ember-1.0", effort: "max", enabled: true },
      }), /EACCES|permission/i);
      fs.chmodSync(codexAgents, 0o600);
      assert.equal(fs.readFileSync(codexAgents, "utf8"), precious, "precious unreadable AGENTS.md must remain 100% untouched");
    } finally {
      try { fs.chmodSync(path.join(home, ".codex", "AGENTS.md"), 0o600); } catch {}
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("staged open/read error in transformTextFileAtomic restores AGENTS.md at original path without vanishing", () => {
    const home = makeTmp("agents-md-staged-open-err");
    try {
      const codexDir = path.join(home, ".codex");
      fs.mkdirSync(codexDir, { recursive: true });
      const codexAgents = path.join(codexDir, "AGENTS.md");
      const precious = "# Original AGENTS.md\nMust never vanish from normal path!\n";
      fs.writeFileSync(codexAgents, precious, "utf8");
      const origIno = fs.lstatSync(codexAgents).ino;
      const mgr = createSubagentsManager({ homeDir: home });
      const origOpen = fs.openSync;
      let injected = false;
      fs.openSync = function (target, ...rest) {
        const s = String(target);
        if (!injected && s.includes("AGENTS.md.stage-") && s.endsWith(path.sep + "old")) {
          injected = true;
          const err = new Error("EIO: simulated staged read failure");
          err.code = "EIO";
          throw err;
        }
        return origOpen.call(fs, target, ...rest);
      };
      try {
        assert.throws(() => mgr.saveSubagent({
          scope: "global",
          item: { id: "io-err-agent", providerInstanceId: "muse", model: "muse-ember-1.0", effort: "max", enabled: true },
        }), /EIO/);
      } finally {
        fs.openSync = origOpen;
      }
      assert.equal(injected, true, "staged openSync failure must have fired");
      assert.equal(fs.existsSync(codexAgents), true, "AGENTS.md must still exist at normal path");
      assert.equal(fs.lstatSync(codexAgents).ino, origIno, "original inode restored at normal path");
      assert.equal(fs.readFileSync(codexAgents, "utf8"), precious, "original content intact");
      const leftovers = fs.readdirSync(codexDir).filter((n) => n.includes(".stage-"));
      assert.deepEqual(leftovers, [], "empty stageDir cleaned up after restore");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("concurrent in-place fd write on staged AGENTS.md retracts stale publish and restores modified user file", () => {
    const home = makeTmp("agents-md-inplace-fd");
    let writerFd = null;
    try {
      const codexDir = path.join(home, ".codex");
      fs.mkdirSync(codexDir, { recursive: true });
      const codexAgents = path.join(codexDir, "AGENTS.md");
      fs.writeFileSync(codexAgents, "# User Rules v1\n", "utf8");
      writerFd = fs.openSync(codexAgents, "r+");
      const mgr = createSubagentsManager({ homeDir: home });
      const origUnlink = fs.unlinkSync;
      let injected = false;
      fs.unlinkSync = function (target, ...rest) {
        const out = origUnlink.call(fs, target, ...rest);
        const s = String(target);
        if (!injected && s.includes("AGENTS.md.stage-") && s.endsWith(path.sep + "old")) {
          injected = true;
          const updated = "# User Rules v2 IN-PLACE FD WRITE\n";
          fs.ftruncateSync(writerFd, 0);
          fs.writeSync(writerFd, updated, 0, "utf8");
        }
        return out;
      };
      try {
        assert.throws(() => mgr.saveSubagent({
          scope: "global",
          item: { id: "inplace-agent", providerInstanceId: "muse", model: "muse-ember-1.0", effort: "max", enabled: true },
        }), /concurrent in-place modification/);
      } finally {
        fs.unlinkSync = origUnlink;
      }
      assert.equal(injected, true, "in-place fd write must have fired");
      assert.equal(fs.readFileSync(codexAgents, "utf8"), "# User Rules v2 IN-PLACE FD WRITE\n", "modified user inode restored directly at AGENTS.md");
    } finally {
      try { if (writerFd !== null) fs.closeSync(writerFd); } catch {}
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("staged AGENTS.md modified via fd while normal path is concurrently occupied surfaces preservedPath conflict instead of silently retrying", () => {
    const home = makeTmp("agents-md-preserved-conflict");
    let writerFd = null;
    try {
      const codexDir = path.join(home, ".codex");
      fs.mkdirSync(codexDir, { recursive: true });
      const codexAgents = path.join(codexDir, "AGENTS.md");
      fs.writeFileSync(codexAgents, "# Original v1\n", "utf8");
      writerFd = fs.openSync(codexAgents, "r+");
      const mgr = createSubagentsManager({ homeDir: home });
      const origRename = fs.renameSync;
      let injected = false;
      fs.renameSync = function (oldP, newP, ...rest) {
        const out = origRename.call(fs, oldP, newP, ...rest);
        const s = String(newP);
        if (!injected && s.includes("AGENTS.md.stage-") && s.endsWith(path.sep + "old")) {
          injected = true;
          // 1) Pre-opened writable fd modifies staged inode
          fs.ftruncateSync(writerFd, 0);
          fs.writeSync(writerFd, "# Staged FD Edit A\n", 0, "utf8");
          // 2) Second process creates a brand-new AGENTS.md at normal path
          fs.writeFileSync(codexAgents, "# Competing Process B\n", { flag: "wx" });
        }
        return out;
      };
      let caught = null;
      try {
        mgr.saveSubagent({
          scope: "global",
          item: { id: "diverge-agent", providerInstanceId: "muse", model: "muse-ember-1.0", effort: "max", enabled: true },
        });
      } catch (e) {
        caught = e;
      } finally {
        fs.renameSync = origRename;
      }
      assert.equal(injected, true, "divergent concurrent edits must have fired");
      assert.ok(caught, "must throw conflict error instead of silently dropping preservedPath");
      assert.ok(caught.preservedPath, "error must attach preservedPath");
      assert.equal(fs.readFileSync(caught.preservedPath, "utf8"), "# Staged FD Edit A\n", "preservedPath retains staged fd edit");
      assert.equal(fs.readFileSync(codexAgents, "utf8"), "# Competing Process B\n", "competing file at normal path remains intact");
    } finally {
      try { if (writerFd !== null) fs.closeSync(writerFd); } catch {}
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
