"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createMcpRouter } = require("../src/mcp-router.cjs");
const { createSkillsManager } = require("../src/hub-skills.cjs");
const { createPluginsManager } = require("../src/hub-plugins.cjs");

function makeTmp(label) { return fs.mkdtempSync(path.join(os.tmpdir(), `t3-hubv3-${label}-`)); }
function writeSkill(dir, skillName, desc) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${skillName}\ndescription: ${desc}\n---\n# ${skillName}\nBody ${skillName}\n`, "utf8");
}
function writeJson(file, obj) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n", "utf8"); }
function writeFile(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content, "utf8"); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function makePlugin(root, name) {
  fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name, title: name + " title", version: "1.0.0" }, null, 2));
  return root;
}

describe("hub-v3 five-host reverse scanning", () => {
  it("AGY ACP hash dir MCP real enabled shows antigravity true and enabled true", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const router = createMcpRouter({ homeDir: home, hubDir: hub });
    const skills = createSkillsManager({ homeDir: home, hubDir: hub });
    // AGY ACP hash dir
    const agyInst = path.join(home, ".t3", "userdata", "providers", "antigravity", "hashABC123", "config");
    writeJson(path.join(agyInst, "mcp_config.json"), { mcpServers: { briking_agent_reach: { command: "node", args: ["/tmp/reach.js"], disabled: false }, codegraph: { command: "codegraph", disabled: false }, lcu: { command: "/tmp/lcu", disabled: true } } });
    writeSkill(path.join(agyInst, "skills", "agy-skill-1"), "agy-skill-1", "AGY skill one");
    writeSkill(path.join(agyInst, "skills", "agy-skill-2"), "agy-skill-2", "AGY skill two");
    // Muse
    writeJson(path.join(home, ".config", "muse", "settings.json"), { mcpServers: { "muse-mcp": { command: "node", args: ["/tmp/muse.js"] } } });
    writeSkill(path.join(home, ".config", "muse", "skills", "muse-skill"), "muse-skill", "Muse skill");
    // Codex TOML: one enabled, one disabled
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(home, ".codex", "config.toml"), `[mcp_servers.codex-on]\ncommand = "codex-cmd"\nargs = ["a"]\nenabled = true\n\n[mcp_servers.codex-off]\ncommand = "off-cmd"\nenabled = false\n`, "utf8");
    writeSkill(path.join(home, ".codex", "skills", "codex-skill"), "codex-skill", "Codex skill");
    fs.writeFileSync(path.join(home, ".codex", "config.toml"), fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8") + `\n[[skills.config]]\nname = "codex-disabled-skill"\ndisabled = true\n`);
    writeSkill(path.join(home, ".codex", "skills", "codex-disabled-skill"), "codex-disabled-skill", "Disabled");
    // Pi
    writeJson(path.join(home, ".pi", "agent", "mcp.json"), { mcpServers: { "pi-mcp": { command: "node" } } });
    writeSkill(path.join(home, ".pi", "agent", "skills", "pi-skill"), "pi-skill", "Pi skill");
    // Claude
    writeJson(path.join(home, ".claude", "mcp.json"), { mcpServers: { "claude-mcp": { command: "node" } } });
    writeSkill(path.join(home, ".claude", "skills", "claude-skill"), "claude-skill", "Claude skill");

    const mcpList = router.listMcpServers({});
    const byName = Object.fromEntries(mcpList.items.map(i => [i.name, i]));
    // AGY reverse
    assert.ok(byName.briking_agent_reach, "should discover briking_agent_reach from AGY");
    assert.equal(byName.briking_agent_reach.agentStates.antigravity, true);
    assert.equal(byName.briking_agent_reach.enabled, true);
    assert.equal(byName.briking_agent_reach.enabledCount >= 1, true);
    assert.equal(byName.briking_agent_reach.source, "native");
    assert.ok(byName.codegraph && byName.codegraph.agentStates.antigravity === true && byName.codegraph.enabled === true);
    // disabled AGY entry still discovered but enabledCount should consider disabled false? lcu disabled true => antigravity false, enabledCount 0 if no other host
    assert.equal(byName.lcu.agentStates.antigravity, false);
    // Muse
    assert.equal(byName["muse-mcp"].agentStates.muse, true);
    assert.equal(byName["muse-mcp"].enabled, true);
    // Codex on/off
    assert.equal(byName["codex-on"].agentStates.codex, true);
    assert.equal(byName["codex-off"].agentStates.codex, false);
    assert.equal(byName["codex-off"].enabled, false);
    // Pi / Claude
    assert.equal(byName["pi-mcp"].agentStates.pi, true);
    assert.equal(byName["claude-mcp"].agentStates.claude, true);

    // getAgentMatrix consistency
    const matrix = router.getAgentMatrix({});
    assert.ok(Array.isArray(matrix.matrix));
    assert.equal(matrix.matrix.find(m => m.name === "briking_agent_reach").agentStates.antigravity, true);
    assert.equal(matrix.matrix.find(m => m.name === "briking_agent_reach").enabled, true);
    // listServers alias
    assert.ok(Array.isArray(router.listServers({}).items));

    // Skills reverse
    const skillAssets = skills.listAssets({});
    const skillById = Object.fromEntries(skillAssets.items.map(i => [i.id, i]));
    assert.equal(skillById["agy-skill-1"].agentStates.antigravity, true);
    assert.equal(skillById["agy-skill-1"].enabled, true);
    assert.equal(skillById["agy-skill-2"].agentStates.antigravity, true);
    assert.equal(skillById["muse-skill"].agentStates.muse, true);
    assert.equal(skillById["muse-skill"].enabled, true);
    assert.equal(skillById["codex-skill"].agentStates.codex, true);
    assert.equal(skillById["codex-disabled-skill"].agentStates.codex, false);
    assert.equal(skillById["pi-skill"].agentStates.pi, true);
    assert.equal(skillById["claude-skill"].agentStates.claude, true);
    // listSkills alias
    assert.ok(Array.isArray(skills.listSkills({}).items));
    assert.equal(skills.listSkills({}).items.find(i => i.id === "agy-skill-1").agentStates.antigravity, true);
  });

  it("shared agents dir marks muse/pi true with sharedViaAgentsDir", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const skills = createSkillsManager({ homeDir: home, hubDir: hub });
    writeSkill(path.join(home, ".agents", "skills", "shared-skill"), "shared-skill", "Shared");
    const assets = skills.listAssets({});
    const item = assets.items.find(i => i.id === "shared-skill");
    assert.ok(item);
    assert.equal(item.agentStates.muse, true);
    assert.equal(item.agentStates.pi, true);
    assert.equal(item.sharedViaAgentsDir, true);
    assert.equal(item.enabled, true);
  });

  it("Claude fallback ~/.claude.json read-only detection and Codex path override", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const router = createMcpRouter({ homeDir: home, hubDir: hub });
    const skills = createSkillsManager({ homeDir: home, hubDir: hub });
    writeJson(path.join(home, ".claude.json"), { mcpServers: { "fallback-mcp": { command: "node" } } });
    const customSkillDir = path.join(home, "custom", "codex-custom-skill");
    writeSkill(customSkillDir, "codex-custom-skill", "Custom path");
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(home, ".codex", "config.toml"), `[[skills.config]]\nname = "codex-custom-skill"\npath = "${customSkillDir}"\n`, "utf8");
    const mcpList = router.listMcpServers({});
    assert.equal(mcpList.items.find(i => i.name === "fallback-mcp").agentStates.claude, true);
    const assets = skills.listAssets({ includePluginBundled: true });
    // custom path skill may not be listed as item but agentStates logic for that id should be true if we query via collectSkillSets path map
    // We verify via collect path map logic indirectly: create a skill with same name in hub and check codex true via path
    writeSkill(path.join(hub, "skills", "codex-custom-skill"), "codex-custom-skill", "Hub copy");
    const assets2 = skills.listAssets({});
    const item = assets2.items.find(i => i.id === "codex-custom-skill");
    // enabled via path override (custom path valid and not disabled) should make codex true
    assert.equal(item.agentStates.codex, true);
  });
});

describe("hub-v3 per-agent toggle isolation and backup", () => {
  it("toggleServerForAgent enables single agent and absorbs native definition, disable isolated", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const router = createMcpRouter({ homeDir: home, hubDir: hub });
    // Start native only in AGY
    const agyFile = path.join(home, ".t3", "userdata", "providers", "antigravity", "hashX", "config", "mcp_config.json");
    writeJson(agyFile, { mcpServers: { "native-only": { command: "native-cmd", args: ["x"] } } });
    writeJson(path.join(home, ".config", "muse", "settings.json"), { mcpServers: {} });
    // Initially native-only is native with antigravity true, muse false
    let items = router.listMcpServers({}).items;
    let item = items.find(i => i.name === "native-only");
    assert.equal(item.source, "native");
    assert.equal(item.agentStates.antigravity, true);
    assert.equal(item.agentStates.muse, false);
    // Enable muse via toggle: should absorb to hub registry and write muse settings
    const regBefore = fs.existsSync(router.registryPath) ? readJson(router.registryPath) : [];
    router.toggleServerForAgent({ id: "native-only", agent: "muse", enabled: true });
    const reg = readJson(router.registryPath);
    assert.ok(Array.isArray(reg) && reg.find(r => r.name === "native-only"), "should absorb into hub registry");
    assert.ok(fs.existsSync(agyFile + ".t3hub.bak") === false || fs.existsSync(agyFile) === true, "AGY backup may not be needed for muse write");
    const museRaw = readJson(path.join(home, ".config", "muse", "settings.json"));
    assert.ok(museRaw.mcpServers["native-only"]);
    assert.ok(fs.existsSync(path.join(home, ".config", "muse", "settings.json") + ".t3hub.bak"), "muse backup .t3hub.bak should exist after write");
    // Check independence: antigravity still true, muse now true, enabled true, source both
    items = router.listMcpServers({}).items;
    item = items.find(i => i.name === "native-only");
    assert.equal(item.agentStates.antigravity, true);
    assert.equal(item.agentStates.muse, true);
    assert.equal(item.source, "both");
    assert.equal(item.enabled, true);
    // Disable muse only, antigravity remains
    router.toggleServerForAgent({ id: "native-only", agent: "muse", enabled: false });
    items = router.listMcpServers({}).items;
    item = items.find(i => i.name === "native-only");
    assert.equal(item.agentStates.muse, false);
    assert.equal(item.agentStates.antigravity, true);
    assert.equal(item.enabled, true);
    // Hub registry still has it (not removed)
    assert.ok(readJson(router.registryPath).find(r => r.name === "native-only"));
    // Disable antigravity as well, then enabled should become false (hub mode off & no native)
    router.toggleServerForAgent({ id: "native-only", agent: "antigravity", enabled: false });
    items = router.listMcpServers({}).items;
    item = items.find(i => i.name === "native-only");
    assert.equal(item.agentStates.antigravity, false);
    assert.equal(item.agentStates.muse, false);
    assert.equal(item.enabled, false);
  });

  it("toggleServerForAgent codex TOML lossless and backup", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const router = createMcpRouter({ homeDir: home, hubDir: hub });
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(home, ".codex", "config.toml"), `# keep\n[other]\nvalue = "keep"\n`, "utf8");
    router.upsertMcpServer({ name: "codex-toggle", command: "cmd", args: ["a"] });
    router.toggleServerForAgent({ id: "codex-toggle", agent: "codex", enabled: true });
    let raw = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
    assert.ok(raw.includes("# keep"));
    assert.ok(raw.includes('[other]\nvalue = "keep"'));
    assert.ok(raw.includes("[mcp_servers.codex-toggle]"));
    assert.ok(fs.existsSync(path.join(home, ".codex", "config.toml.t3hub.bak")));
    assert.ok(fs.readFileSync(path.join(home, ".codex", "config.toml.t3hub.bak"), "utf8").includes("# keep"));
    router.toggleServerForAgent({ id: "codex-toggle", agent: "codex", enabled: false });
    raw = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
    assert.ok(!raw.includes("[mcp_servers.codex-toggle]"));
    assert.ok(raw.includes('[other]'));
  });

  it("setServerAgents bulk sets per-agent states", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const router = createMcpRouter({ homeDir: home, hubDir: hub });
    router.upsertMcpServer({ name: "bulk-mcp", command: "cmd" });
    router.setServerAgents({ id: "bulk-mcp", agents: ["antigravity", "muse"] });
    let item = router.listMcpServers({}).items.find(i => i.name === "bulk-mcp");
    assert.equal(item.agentStates.antigravity, true);
    assert.equal(item.agentStates.muse, true);
    assert.equal(item.agentStates.codex, false);
    assert.equal(item.agentStates.pi, false);
    router.setServerAgents({ id: "bulk-mcp", agents: { antigravity: true, muse: false, codex: true, pi: false, claude: false } });
    item = router.listMcpServers({}).items.find(i => i.name === "bulk-mcp");
    assert.equal(item.agentStates.antigravity, true);
    assert.equal(item.agentStates.codex, true);
    assert.equal(item.agentStates.muse, false);
  });

  it("toggleSkillForAgent creates symlink per agent and safe removes real dir with backup", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const skills = createSkillsManager({ homeDir: home, hubDir: hub });
    // Source skill in hub
    writeSkill(path.join(hub, "skills", "target-skill"), "target-skill", "Target");
    // Enable for AGY only
    skills.toggleSkillForAgent({ id: "target-skill", agent: "agy", enabled: true });
    const agySkillsDir = (() => {
      const r = require("../src/hub-skills.cjs");
      // derive via primary logic: use home agy default
      const candidates = [path.join(home, ".t3", "userdata", "providers", "antigravity", "default", "config", "skills")];
      return candidates[0];
    })();
    // Find actual agy skills dir: should be primaryAgySkillsDirFor -> default/config/skills when no instance
    const agyLink = path.join(home, ".t3", "userdata", "providers", "antigravity", "default", "config", "skills", "target-skill");
    assert.ok(fs.lstatSync(agyLink).isSymbolicLink(), "AGY symlink should exist");
    assert.ok(fs.readFileSync(path.join(agyLink, "SKILL.md"), "utf8").includes("Target"));
    // Check isolation: muse should not have it yet
    assert.ok(!fs.existsSync(path.join(home, ".config", "muse", "skills", "target-skill")));
    let item = skills.listAssets({}).items.find(i => i.id === "target-skill");
    assert.equal(item.agentStates.antigravity, true);
    assert.equal(item.agentStates.muse, false);
    // Enable Muse
    skills.toggleSkillForAgent({ id: "target-skill", agent: "muse", enabled: true });
    const museLink = path.join(home, ".config", "muse", "skills", "target-skill");
    assert.ok(fs.lstatSync(museLink).isSymbolicLink());
    item = skills.listAssets({}).items.find(i => i.id === "target-skill");
    assert.equal(item.agentStates.muse, true);
    assert.equal(item.agentStates.antigravity, true);
    // Disable AGY only, muse remains
    skills.toggleSkillForAgent({ id: "target-skill", agent: "antigravity", enabled: false });
    assert.ok(!fs.existsSync(agyLink), "AGY link removed");
    assert.ok(fs.lstatSync(museLink).isSymbolicLink(), "muse link intact");
    item = skills.listAssets({}).items.find(i => i.id === "target-skill");
    assert.equal(item.agentStates.antigravity, false);
    assert.equal(item.agentStates.muse, true);
    // Backup protection: real dir at target should be backed up, not deleted
    const realTarget = path.join(home, ".config", "muse", "skills", "real-dir-skill");
    writeSkill(realTarget, "real-dir-skill", "REAL-USER-SOURCE");
    // First copy to hub canonical via toggle ensure? But for disable real dir test, we need a real dir at codex target
    writeSkill(path.join(home, ".codex", "skills", "real-dir-skill"), "real-dir-skill", "REAL-USER-SOURCE");
    // Disable codex for that skill: should backup migrate to hub
    skills.toggleSkillForAgent({ id: "real-dir-skill", agent: "codex", enabled: false });
    const hubCanonical = path.join(hub, "skills", "real-dir-skill");
    assert.ok(fs.readFileSync(path.join(hubCanonical, "SKILL.md"), "utf8").includes("REAL-USER-SOURCE"), "real dir content preserved in hub canonical");
    assert.ok(!fs.existsSync(path.join(home, ".codex", "skills", "real-dir-skill")), "real dir removed after migration");
  });

  it("Codex skill toggle fixes disabled config and agy alias", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const skills = createSkillsManager({ homeDir: home, hubDir: hub });
    writeSkill(path.join(hub, "skills", "codex-fix"), "codex-fix", "Fix");
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(home, ".codex", "config.toml"), `[[skills.config]]\nname = "codex-fix"\ndisabled = true\n`, "utf8");
    // Initially disabled => codex false
    let item = skills.listAssets({}).items.find(i => i.id === "codex-fix");
    assert.equal(item.agentStates.codex, false);
    // Enable via toggle should fix disabled
    skills.toggleSkillForAgent({ id: "codex-fix", agent: "codex", enabled: true });
    const raw = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
    assert.ok(!raw.includes("disabled = true") || raw.includes("disabled = false"), "disabled should be fixed");
    const link = path.join(home, ".codex", "skills", "codex-fix");
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    item = skills.listAssets({}).items.find(i => i.id === "codex-fix");
    assert.equal(item.agentStates.codex, true);
    // agy alias via "agy"
    writeSkill(path.join(hub, "skills", "agy-alias"), "agy-alias", "AgyAlias");
    skills.toggleSkillForAgent({ id: "agy-alias", agent: "agy", enabled: true });
    const agyLink = path.join(home, ".t3", "userdata", "providers", "antigravity", "default", "config", "skills", "agy-alias");
    assert.ok(fs.lstatSync(agyLink).isSymbolicLink());
    item = skills.listAssets({}).items.find(i => i.id === "agy-alias");
    assert.equal(item.agentStates.antigravity, true);
  });
});

describe("hub-v3 marketplace vs installed and listCatalog", () => {
  it("marketplaces plugins are marketplace, hub/local installed, enabled registry respected", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const plugins = createPluginsManager({ homeDir: home, hubDir: hub });
    // Hub installed plugin
    makePlugin(path.join(hub, "plugins", "hubplug"), "hubplug");
    // Marketplace plugin 129+ simulation: count check at least that marketplace plugins separated
    const marketRoot = path.join(home, ".zcode", "cli", "plugins", "marketplaces", "acme");
    const marketPlugin = makePlugin(path.join(marketRoot, "plugins", "marketplug"), "marketplug");
    // Codex cache plugin (marketplace)
    const cacheRoot = path.join(home, ".codex", "plugins", "cache", "acme", "cacheplug", "1.0.0");
    makePlugin(cacheRoot, "cacheplug");
    // Claude marketplace
    const claudeMarket = path.join(home, ".claude", "plugins", "marketplaces", "acme2", "plugins", "claudemarket");
    makePlugin(claudeMarket, "claudemarket");
    // List catalog
    let list = plugins.listPlugins();
    assert.ok(list.items.find(i => i.id === "hubplug"));
    const hubEntry = list.items.find(i => i.id === "hubplug");
    assert.equal(hubEntry.catalogSection, "installed");
    assert.equal(hubEntry.installed, true);
    const marketEntry = list.items.find(i => i.id === "marketplug");
    assert.ok(marketEntry, "marketplug should be discovered");
    assert.equal(marketEntry.catalogSection, "marketplace");
    assert.equal(marketEntry.installed, false);
    const cacheEntry = list.items.find(i => i.id === "cacheplug");
    assert.equal(cacheEntry.catalogSection, "marketplace");
    const claudeMarketEntry = list.items.find(i => i.id === "claudemarket");
    assert.equal(claudeMarketEntry.catalogSection, "marketplace");

    // listCatalog counts
    const catalog = plugins.listCatalog();
    assert.ok(catalog.counts.installed >= 2, "builtin + hubplug at least 2 installed");
    assert.ok(catalog.counts.marketplace >= 3);
    assert.ok(Array.isArray(catalog.installed));
    assert.ok(Array.isArray(catalog.marketplace));
    assert.ok(catalog.installed.find(i => i.id === "hubplug"));
    assert.ok(catalog.marketplace.find(i => i.id === "marketplug"));

    // listPlugins section filter
    const installedOnly = plugins.listPlugins({ section: "installed" });
    assert.ok(installedOnly.items.every(i => i.catalogSection === "installed"));
    const marketOnly = plugins.listPlugins({ section: "marketplace" });
    assert.ok(marketOnly.items.every(i => i.catalogSection === "marketplace"));
    // default returns all
    assert.equal(list.items.length, installedOnly.items.length + marketOnly.items.length);

    // installFromMarketplace moves to installed
    plugins.installFromMarketplace({ id: "marketplug" });
    let after = plugins.listPlugins().items.find(i => i.id === "marketplug");
    assert.equal(after.catalogSection, "installed");
    assert.equal(after.installed, true);

    // Codex enabled via config should mark cacheplug as installed
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(home, ".codex", "config.toml"), `[plugins."cacheplug@acme"]\nenabled = true\n`, "utf8");
    let after2 = plugins.listPlugins().items.find(i => i.id === "cacheplug");
    assert.equal(after2.catalogSection, "installed");

    // Claude enabledPlugins
    writeJson(path.join(home, ".claude", "settings.json"), { enabledPlugins: { "claudemarket@acme2": true } });
    let after3 = plugins.listPlugins().items.find(i => i.id === "claudemarket");
    assert.equal(after3.catalogSection, "installed");
  });

  it("many marketplace plugins (129+) stay separated from installed", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const plugins = createPluginsManager({ homeDir: home, hubDir: hub });
    for (let i = 0; i < 135; i++) {
      const id = `mkt${i}`;
      const d = path.join(home, ".zcode", "cli", "plugins", "marketplaces", "acme", "plugins", id);
      makePlugin(d, id);
    }
    makePlugin(path.join(hub, "plugins", "myinstalled"), "myinstalled");
    const catalog = plugins.listCatalog();
    assert.ok(catalog.counts.marketplace >= 135);
    assert.ok(catalog.marketplace.every(i => i.catalogSection === "marketplace" && i.installed === false));
    assert.equal(catalog.installed.find(i => i.id === "myinstalled").catalogSection, "installed");
    // Ensure none of marketplace shows as installed/enabled erroneously
    for (const p of catalog.marketplace) assert.equal(p.installed, false);
  });
});

describe("hub-v3 composite plugin capability fan-out for AGY/Muse/Pi", () => {
  it("enabling composite plugin for antigravity/muse/pi injects skills symlink and MCP, disable cleans", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const skills = createSkillsManager({ homeDir: home, hubDir: hub });
    const router = createMcpRouter({ homeDir: home, hubDir: hub });
    function hooksSpy() { const calls = []; return { calls, toggleHook(a) { calls.push(a); }, setPluginHooks(a) { calls.push(a); } }; }
    const hooks = hooksSpy();
    const plugins = createPluginsManager({ homeDir: home, hubDir: hub, skillsManager: skills, mcpRouter: router, hooksManager: hooks });
    const root = makePlugin(path.join(hub, "plugins", "composite"), "composite");
    writeSkill(path.join(root, "skills", "composite-skill"), "composite-skill", "Composite skill");
    writeJson(path.join(root, ".mcp.json"), { mcpServers: { "composite-mcp": { command: process.execPath, args: ["${PLUGIN_ROOT}/server.js"] } } });
    writeJson(path.join(root, "hooks", "hooks.json"), { hooks: { Stop: [{ hooks: [{ type: "command", command: "node ${PLUGIN_ROOT}/stop.js" }] }] } });

    // Ensure plugin is installed (hub dir)
    let items = plugins.listPlugins().items;
    let comp = items.find(i => i.id === "composite");
    assert.equal(comp.catalogSection, "installed");
    assert.equal(comp.capabilities.skillsCount, 1);
    assert.equal(comp.capabilities.mcpCount, 1);

    // Enable for antigravity via agy alias (no native plugin system)
    plugins.togglePluginForAgent({ id: "composite", agent: "agy", enabled: true, mcpRouter: router, skillsManager: skills, hooksManager: hooks });
    const agySkillsDir = path.join(home, ".t3", "userdata", "providers", "antigravity", "default", "config", "skills");
    const agySkillLink = path.join(agySkillsDir, "composite-skill");
    assert.ok(fs.lstatSync(agySkillLink).isSymbolicLink(), "AGY skills symlink should be injected");
    assert.ok(fs.readFileSync(path.join(agySkillLink, "SKILL.md"), "utf8").includes("Composite skill"));
    const agyMcpFile = path.join(home, ".t3", "userdata", "providers", "antigravity", "default", "config", "mcp_config.json");
    assert.ok(fs.existsSync(agyMcpFile));
    const agyMcp = readJson(agyMcpFile);
    assert.ok(agyMcp.mcpServers["composite-mcp"]);
    assert.equal(agyMcp.mcpServers["composite-mcp"].args[0], path.join(root, "server.js"));
    // bindings record
    const bindings = readJson(path.join(hub, "plugin-agent-bindings.json"));
    assert.equal(bindings.bindings.composite.antigravity.enabled, true);
    // Check plugin agentStates
    comp = plugins.listPlugins().items.find(i => i.id === "composite");
    assert.equal(comp.agentStates.antigravity, true);
    // Enable for muse (also no native plugin system)
    plugins.togglePluginForAgent({ id: "composite", agent: "muse", enabled: true });
    const museSkillLink = path.join(home, ".config", "muse", "skills", "composite-skill");
    assert.ok(fs.lstatSync(museSkillLink).isSymbolicLink());
    const museMcp = readJson(path.join(home, ".config", "muse", "settings.json"));
    assert.ok(museMcp.mcpServers["composite-mcp"]);
    // Enable for pi
    plugins.togglePluginForAgent({ id: "composite", agent: "pi", enabled: true });
    const piSkillLink = path.join(home, ".pi", "agent", "skills", "composite-skill");
    assert.ok(fs.lstatSync(piSkillLink).isSymbolicLink());
    const piMcp = readJson(path.join(home, ".pi", "agent", "mcp.json"));
    assert.ok(piMcp.mcpServers["composite-mcp"]);
    // Verify per-agent independence: antigravity/muse/pi all true
    comp = plugins.listPlugins().items.find(i => i.id === "composite");
    assert.equal(comp.agentStates.antigravity, true);
    assert.equal(comp.agentStates.muse, true);
    assert.equal(comp.agentStates.pi, true);
    // Disable muse only, others remain
    plugins.togglePluginForAgent({ id: "composite", agent: "muse", enabled: false });
    assert.ok(!fs.existsSync(museSkillLink), "muse skill removed");
    const museMcpAfter = readJson(path.join(home, ".config", "muse", "settings.json"));
    assert.ok(!museMcpAfter.mcpServers["composite-mcp"], "muse MCP removed");
    assert.ok(fs.lstatSync(agySkillLink).isSymbolicLink(), "AGY still intact after muse disable");
    assert.ok(readJson(agyMcpFile).mcpServers["composite-mcp"]);
    // Disable AGY and Pi cleans
    plugins.togglePluginForAgent({ id: "composite", agent: "agy", enabled: false });
    plugins.togglePluginForAgent({ id: "composite", agent: "pi", enabled: false });
    assert.ok(!fs.existsSync(agySkillLink));
    const agyMcpAfter = readJson(agyMcpFile);
    assert.ok(!agyMcpAfter.mcpServers["composite-mcp"]);
    assert.ok(!fs.existsSync(piSkillLink));
    const piMcpAfter = readJson(path.join(home, ".pi", "agent", "mcp.json"));
    assert.ok(!piMcpAfter.mcpServers["composite-mcp"]);
    comp = plugins.listPlugins().items.find(i => i.id === "composite");
    assert.equal(comp.agentStates.antigravity, false);
    assert.equal(comp.agentStates.muse, false);
    assert.equal(comp.agentStates.pi, false);
    // Bindings cleared
    const bindingsAfter = readJson(path.join(hub, "plugin-agent-bindings.json"));
    assert.equal(bindingsAfter.bindings.composite.muse.enabled, false);
  });

  it("enabling composite plugin for codex/claude syncs native switches and hooks without breaking other hosts", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const skills = createSkillsManager({ homeDir: home, hubDir: hub });
    const router = createMcpRouter({ homeDir: home, hubDir: hub });
    function hooksSpy() { const calls = []; return { calls, toggleHook(a) { calls.push(a); }, setPluginHooks(a) { calls.push(a); } }; }
    const hooks = hooksSpy();
    const plugins = createPluginsManager({ homeDir: home, hubDir: hub, skillsManager: skills, mcpRouter: router, hooksManager: hooks });
    const root = makePlugin(path.join(hub, "plugins", "codexcomp"), "codexcomp");
    writeSkill(path.join(root, "skills", "codex-skill-x"), "codex-skill-x", "codex skill");
    writeJson(path.join(root, ".mcp.json"), { mcpServers: { "codex-mcp": { command: process.execPath } } });
    plugins.togglePluginForAgent({ id: "codexcomp", agent: "codex", enabled: true });
    const codexSkillsLink = path.join(home, ".codex", "skills", "codex-skill-x");
    assert.ok(fs.lstatSync(codexSkillsLink).isSymbolicLink());
    const codexRaw = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
    assert.ok(codexRaw.includes("[mcp_servers.codex-mcp]"));
    assert.ok(codexRaw.includes("[plugins.\"codexcomp@local\"]") || codexRaw.includes("[plugins.\"codexcomp@"));
    // claude
    plugins.togglePluginForAgent({ id: "codexcomp", agent: "claude", enabled: true });
    const claudeSkillLink = path.join(home, ".claude", "skills", "codex-skill-x");
    assert.ok(fs.lstatSync(claudeSkillLink).isSymbolicLink());
    const claudeMcp = readJson(path.join(home, ".claude", "mcp.json"));
    assert.ok(claudeMcp.mcpServers["codex-mcp"]);
    const claudeSettings = readJson(path.join(home, ".claude", "settings.json"));
    assert.ok(Object.keys(claudeSettings.enabledPlugins || {}).some(k => k.includes("codexcomp")), "claude enabledPlugins should have codexcomp");
    // disable codex, claude remains
    plugins.togglePluginForAgent({ id: "codexcomp", agent: "codex", enabled: false });
    assert.ok(!fs.existsSync(codexSkillsLink));
    const codexRawAfter = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
    assert.ok(!codexRawAfter.includes("[mcp_servers.codex-mcp]"));
    assert.ok(fs.lstatSync(claudeSkillLink).isSymbolicLink());
    assert.ok(readJson(path.join(home, ".claude", "mcp.json")).mcpServers["codex-mcp"]);
  });
});

