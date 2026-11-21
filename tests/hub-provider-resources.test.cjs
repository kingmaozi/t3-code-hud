"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createProviderResourcesManager, DISABLED_SKILLS_DIRNAME } = require("../src/hub-provider-resources.cjs");

test("standalone provider resources lists and toggles Codex TOML, Claude JSON, AGY JSON, and Skills with zero Magpie dependency", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3-prov-res-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  // 1. Codex config.toml with MCP servers + plugins + secrets that must survive untouched
  const codexDir = path.join(home, ".codex");
  fs.mkdirSync(path.join(codexDir, "skills", "feature-dev"), { recursive: true });
  fs.writeFileSync(path.join(codexDir, "skills", "feature-dev", "SKILL.md"), "---\nname: feature-dev\ndescription: Guided feature development\n---\n# Body\n");
  fs.mkdirSync(path.join(codexDir, "skills", "pdf-tool"), { recursive: true });
  fs.writeFileSync(path.join(codexDir, "skills", "pdf-tool", "SKILL.md"), "---\nname: pdf-tool\ndescription: PDF rendering\n---\n");
  const codexToml = path.join(codexDir, "config.toml");
  fs.writeFileSync(codexToml, [
    'model = "gpt-6.2-sol"',
    "",
    "[mcp_servers.codegraph]",
    'command = "/usr/local/bin/codegraph"',
    'api_key = "sk-keep-me-intact"',
    "",
    "[mcp_servers.t3_hub]",
    'command = "/usr/local/bin/t3-mcp-router"',
    "enabled = true",
    "",
    '[plugins."pdf@openai-primary-runtime"]',
    "enabled = true",
    "",
    '[plugins."github@openai-curated"]',
    "enabled = false",
    "",
  ].join("\n"));

  // 2. Antigravity MCP & skills
  const agyCfgDir = path.join(home, ".t3", "userdata", "providers", "antigravity", "inst-1", "config");
  fs.mkdirSync(path.join(agyCfgDir, "skills", "design-kit"), { recursive: true });
  fs.writeFileSync(path.join(agyCfgDir, "skills", "design-kit", "SKILL.md"), "---\nname: design-kit\ndescription: UI design helper\n---\n");
  const agyMcp = path.join(agyCfgDir, "mcp_config.json");
  fs.writeFileSync(agyMcp, JSON.stringify({
    mcpServers: {
      context7: { url: "https://mcp.context7.com/mcp", headers: { Authorization: "Bearer secret-val" } },
    },
  }, null, 2));

  // 3. Claude Code settings.json + ~/.claude/mcp.json
  const claudeDir = path.join(home, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  const claudeSettings = path.join(claudeDir, "settings.json");
  fs.writeFileSync(claudeSettings, JSON.stringify({
    enabledPlugins: { "review-kit@official": true },
    unrelatedKey: "preserve-me",
  }, null, 2));
  const claudeMcp = path.join(claudeDir, "mcp.json");
  fs.writeFileSync(claudeMcp, JSON.stringify({
    mcpServers: { playwright: { command: "npx", args: ["-y", "@playwright/mcp"] }, t3_hub: { command: "/usr/local/bin/t3-mcp-router" } },
  }, null, 2));

  // 4. Muse Code XDG layout (~/.config/muse/settings.json, ~/.config/muse/skills, ~/.local/share/muse/plugins/installed.json)
  const museCfgDir = path.join(home, ".config", "muse");
  fs.mkdirSync(path.join(museCfgDir, "skills", "cdp-inject"), { recursive: true });
  fs.writeFileSync(path.join(museCfgDir, "skills", "cdp-inject", "SKILL.md"), "---\nname: cdp-inject\ndescription: CDP helper\n---\n# Body\n");
  const museSettings = path.join(museCfgDir, "settings.json");
  fs.writeFileSync(museSettings, JSON.stringify({
    schema_version: 1,
    mcpServers: { t3_hub: { command: "/usr/local/bin/t3-mcp-router" }, context7: { url: "https://mcp.context7.com/mcp" } },
  }, null, 2));
  const musePluginsDir = path.join(home, ".local", "share", "muse", "plugins");
  fs.mkdirSync(musePluginsDir, { recursive: true });
  const musePluginsFile = path.join(musePluginsDir, "installed.json");
  fs.writeFileSync(musePluginsFile, JSON.stringify({
    version: 1,
    plugins: {
      "powercontext-memory": { id: "powercontext-memory", display_name: "PowerContext Memory", description: "Project memory", enabled: true },
    },
  }, null, 2));

  const mgr = createProviderResourcesManager({ homeDir: home });
  const listed = mgr.listProviderResources();
  assert.equal(listed.ok, true);
  assert.ok(!JSON.stringify(listed).toLowerCase().includes("magpie"), "zero Magpie references");

  const codex = listed.providers.find((p) => p.id === "codex");
  assert.equal(codex.counts.mcp, 2);
  assert.equal(codex.counts.plugins, 2);
  assert.equal(codex.counts.skills, 2);

  const claude = listed.providers.find((p) => p.id === "claude");
  assert.equal(claude.counts.mcp, 2, "Claude reads ~/.claude/mcp.json");
  assert.equal(claude.counts.plugins, 1);

  const muse = listed.providers.find((p) => p.id === "muse");
  assert.equal(muse.counts.mcp, 2, "Muse reads ~/.config/muse/settings.json");
  assert.equal(muse.counts.skills, 1, "Muse reads ~/.config/muse/skills");
  assert.equal(muse.counts.plugins, 1, "Muse reads ~/.local/share/muse/plugins/installed.json");
  assert.equal(muse.plugins[0].name, "PowerContext Memory");

  // Toggle Muse plugin OFF -> preserves version and updates enabled flag
  mgr.toggleProviderResource({ provider: "muse", kind: "plugins", id: "powercontext-memory", enabled: false, sourceFile: musePluginsFile });
  const musePluginsAfter = JSON.parse(fs.readFileSync(musePluginsFile, "utf8"));
  assert.equal(musePluginsAfter.version, 1);
  assert.equal(musePluginsAfter.plugins["powercontext-memory"].enabled, false);

  // Toggle Muse MCP OFF -> preserves schema_version
  mgr.toggleProviderResource({ provider: "muse", kind: "mcp", id: "t3_hub", enabled: false, sourceFile: museSettings });
  const museSettingsAfter = JSON.parse(fs.readFileSync(museSettings, "utf8"));
  assert.equal(museSettingsAfter.schema_version, 1);
  assert.equal(museSettingsAfter.mcpServers.t3_hub.disabled, true);

  // Toggle Codex MCP OFF -> preserves secret & model line
  mgr.toggleProviderResource({ provider: "codex", kind: "mcp", id: "codegraph", enabled: false, sourceFile: codexToml });
  const afterToml = fs.readFileSync(codexToml, "utf8");
  assert.match(afterToml, /api_key = "sk-keep-me-intact"/);
  assert.match(afterToml, /\[mcp_servers\.codegraph\]\nenabled = false/);

  // Toggle Codex plugin OFF -> ON
  mgr.toggleProviderResource({ provider: "codex", kind: "plugins", id: "pdf@openai-primary-runtime", enabled: false, sourceFile: codexToml });
  let refreshed = mgr.listProviderResources().providers.find((p) => p.id === "codex");
  assert.equal(refreshed.plugins.find((x) => x.id === "pdf@openai-primary-runtime").enabled, false);
  assert.equal(refreshed.mcp.find((x) => x.id === "codegraph").enabled, false);

  // Toggle Skill OFF -> safely moved to .disabled-skills and still visible; toggle back ON -> restored
  const skillDir = path.join(codexDir, "skills");
  mgr.toggleProviderResource({ provider: "codex", kind: "skills", id: "pdf-tool", enabled: false, sourceDir: skillDir });
  assert.ok(fs.existsSync(path.join(skillDir, DISABLED_SKILLS_DIRNAME, "pdf-tool", "SKILL.md")));
  assert.ok(!fs.existsSync(path.join(skillDir, "pdf-tool")));
  refreshed = mgr.listProviderResources().providers.find((p) => p.id === "codex");
  assert.equal(refreshed.skills.find((x) => x.id === "pdf-tool").enabled, false);

  mgr.toggleProviderResource({ provider: "codex", kind: "skills", id: "pdf-tool", enabled: true, sourceDir: skillDir });
  assert.ok(fs.existsSync(path.join(skillDir, "pdf-tool", "SKILL.md")));

  // Toggle AGY MCP OFF -> preserves Authorization header
  mgr.toggleProviderResource({ provider: "antigravity", kind: "mcp", id: "context7", enabled: false, sourceFile: agyMcp });
  const agyParsed = JSON.parse(fs.readFileSync(agyMcp, "utf8"));
  assert.equal(agyParsed.mcpServers.context7.disabled, true);
  assert.equal(agyParsed.mcpServers.context7.headers.Authorization, "Bearer secret-val");

  // Toggle Claude plugin OFF -> preserves unrelatedKey
  mgr.toggleProviderResource({ provider: "claude", kind: "plugins", id: "review-kit@official", enabled: false, sourceFile: claudeSettings });
  const claudeParsed = JSON.parse(fs.readFileSync(claudeSettings, "utf8"));
  assert.equal(claudeParsed.enabledPlugins["review-kit@official"], false);
  assert.equal(claudeParsed.unrelatedKey, "preserve-me");
});

test("OpenCode and Devin resources are discovered, secrets redacted, and editable MCP/skills toggled safely", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3-prov-oc-devin-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  // OpenCode config + skills
  const ocDir = path.join(home, ".config", "opencode");
  fs.mkdirSync(path.join(ocDir, "skills", "nextjs"), { recursive: true });
  fs.writeFileSync(path.join(ocDir, "skills", "nextjs", "SKILL.md"), "---\nname: nextjs\ndescription: Next.js guide\n---\n");
  const ocJson = path.join(ocDir, "opencode.json");
  fs.writeFileSync(ocJson, JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    mcp: { context7: { type: "local", enabled: true, command: ["npx", "-y", "@upstash/context7-mcp", "--api-key", "ctx7sk-supersecretvalue12345"] } },
    plugin: ["superpowers@git+https://github.com/obra/superpowers.git"],
  }, null, 2));

  // Devin config + plugins lock + plugin-cache skill
  const devinCfg = path.join(home, ".config", "devin");
  fs.mkdirSync(devinCfg, { recursive: true });
  const devinMcp = path.join(devinCfg, "mcp_config.json");
  fs.writeFileSync(devinMcp, JSON.stringify({ mcpServers: { t3_hub: { command: "/usr/local/bin/t3-mcp-router" } } }, null, 2));
  const devinPlugDir = path.join(home, ".local", "share", "devin", "cli", "plugins");
  fs.mkdirSync(path.join(devinPlugDir, "cache", "pkg-1", "0.1.0", "skills", "hi-devin"), { recursive: true });
  fs.writeFileSync(path.join(devinPlugDir, "cache", "pkg-1", "0.1.0", "skills", "hi-devin", "SKILL.md"), "---\nname: hi-devin\ndescription: Playbook skill\n---\n");
  fs.writeFileSync(path.join(devinPlugDir, "lock.json"), JSON.stringify({
    resolved: [{ name: "devin-playbooks", spec: { source: "account-upload" }, version_dir: "0.1.0" }],
  }, null, 2));

  const mgr = createProviderResourcesManager({ homeDir: home });
  const listed = mgr.listProviderResources();
  const oc = listed.providers.find((p) => p.id === "opencode");
  const devin = listed.providers.find((p) => p.id === "devin");

  assert.equal(oc.counts.mcp, 1);
  assert.equal(oc.counts.skills, 1);
  assert.equal(oc.counts.plugins, 1);
  assert.doesNotMatch(oc.mcp[0].description, /ctx7sk-supersecret/, "API key must be redacted from MCP summary");
  assert.equal(oc.plugins[0].readonly, true);

  assert.equal(devin.counts.mcp, 1);
  assert.equal(devin.counts.plugins, 1);
  assert.equal(devin.counts.skills, 1);
  assert.equal(devin.skills[0].readonly, true);

  // Toggle OpenCode MCP OFF -> preserves $schema & command
  mgr.toggleProviderResource({ provider: "opencode", kind: "mcp", id: "context7", enabled: false, sourceFile: ocJson });
  const ocAfter = JSON.parse(fs.readFileSync(ocJson, "utf8"));
  assert.equal(ocAfter.mcp.context7.enabled, false);
  assert.equal(ocAfter.$schema, "https://opencode.ai/config.json");

  // Toggle Devin MCP OFF
  mgr.toggleProviderResource({ provider: "devin", kind: "mcp", id: "t3_hub", enabled: false, sourceFile: devinMcp });
  const devinAfter = JSON.parse(fs.readFileSync(devinMcp, "utf8"));
  assert.equal(devinAfter.mcpServers.t3_hub.disabled, true);
});
