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

  // 3. Claude Code settings.json
  const claudeDir = path.join(home, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  const claudeSettings = path.join(claudeDir, "settings.json");
  fs.writeFileSync(claudeSettings, JSON.stringify({
    mcpServers: { playwright: { command: "npx", args: ["-y", "@playwright/mcp"] } },
    enabledPlugins: { "review-kit@official": true },
    unrelatedKey: "preserve-me",
  }, null, 2));

  const mgr = createProviderResourcesManager({ homeDir: home });
  const listed = mgr.listProviderResources();
  assert.equal(listed.ok, true);
  assert.ok(!JSON.stringify(listed).toLowerCase().includes("magpie"), "zero Magpie references");

  const codex = listed.providers.find((p) => p.id === "codex");
  assert.equal(codex.counts.mcp, 2);
  assert.equal(codex.counts.plugins, 2);
  assert.equal(codex.counts.skills, 2);

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
