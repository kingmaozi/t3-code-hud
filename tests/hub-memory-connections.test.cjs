"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createMemoryConnections } = require("../src/hub-memory-connections.cjs");

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hub-memory-connections-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, api: createMemoryConnections({ homeDir: home }) };
}
function write(home, relative, contents) {
  const file = path.join(home, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, { mode: 0o600 });
  return file;
}
const mcp = (command = "/home/test/.t3/bin/t3-mcp-router") => JSON.stringify({ mcpServers: { t3_hub: { command, args: [] } } });
const memorySkill = "---\nname: powercontext-memory\ndescription: memory search and write\n---\nUse memory_search before work and memory_write for verified durable facts.\n";
const routeSkill = "---\nname: t3-subagent-routing\n---\nUse delegate_task and resolveSubagentRoute.\n";

test("returns six stable host rows and distinguishes configuration from runtime", (t) => {
  const { home, api } = fixture(t);
  write(home, ".codex/config.toml", '[mcp_servers.t3_hub]\ncommand = "/home/test/.t3/bin/t3-mcp-router"\nargs = []\n');
  write(home, ".config/muse/settings.json", mcp());
  write(home, ".claude/mcp.json", mcp());
  write(home, ".pi/agent/mcp.json", mcp());
  write(home, ".t3/userdata/providers/antigravity/profile/config/mcp_config.json", mcp());
  write(home, ".agents/skills/powercontext-memory/SKILL.md", memorySkill);
  write(home, ".codex/hooks.json", JSON.stringify({ hooks: { Stop: [{ _t3HubHookId: "memory-stop-guard", hooks: [{ command: "node memory-stop-hook.mjs" }] }] } }));
  const result = api.getConnections();
  assert.equal(result.ok, true);
  assert.match(result.checkedAt, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(result.agents.map((agent) => agent.id), ["t3", "codex", "muse", "agy", "claude", "pi"]);
  assert.equal(result.agents.find((agent) => agent.id === "agy").mcp.status, "configured");
  assert.equal(result.agents.find((agent) => agent.id === "codex").mcp.status, "configured");
  assert.equal(result.agents.find((agent) => agent.id === "muse").mcp.status, "configured");
  assert.equal(result.agents.find((agent) => agent.id === "claude").mcp.status, "configured");
  assert.equal(result.agents.find((agent) => agent.id === "pi").mcp.status, "configured");
  assert.equal(result.agents.find((agent) => agent.id === "codex").skill.status, "configured");
  assert.equal(result.agents.find((agent) => agent.id === "codex").hook.status, "configured");
  assert.equal(result.agents.find((agent) => agent.id === "muse").hook.status, "unsupported");
  assert.equal(result.agents.find((agent) => agent.id === "agy").hook.status, "unsupported");
  assert.equal(result.agents.find((agent) => agent.id === "t3").mcp.status, "unknown");
  assert.ok(result.agents.every((agent) => agent.runtime.status === "unverified"));
});

test("Codex TOML reads enabled=false anywhere in Hub section and stops at next section", (t) => {
  const { home, api } = fixture(t);
  const file = ".codex/config.toml";
  write(home, file, '[mcp_servers.t3_hub]\ncommand = "/home/test/.t3/bin/t3-mcp-router"\nargs = []\nenabled = false\n\n[other]\nenabled = true\n');
  assert.equal(api.getConnections().agents.find((agent) => agent.id === "codex").mcp.status, "missing");
  write(home, file, '[mcp_servers.t3_hub]\ncommand = "/home/test/.t3/bin/t3-mcp-router"\nargs = []\n\n[other]\nenabled = false\n');
  assert.equal(api.getConnections().agents.find((agent) => agent.id === "codex").mcp.status, "configured");
  write(home, file, "[mcp_servers.t3_hub]\ncommand = [broken\n");
  assert.equal(api.getConnections().agents.find((agent) => agent.id === "codex").mcp.status, "unknown");
  write(home, file, '[mcp_servers.t3_hub]\ncommand = "node"\nargs = [\n  "/home/test/.t3/bin/t3-mcp-router",\n]\n');
  assert.equal(api.getConnections().agents.find((agent) => agent.id === "codex").mcp.status, "configured");
  write(home, file, '[mcp_servers.t3_hub]\ncommand = "node"\nargs = [\n  "/home/test/custom-launcher",\n]\n');
  assert.equal(api.getConnections().agents.find((agent) => agent.id === "codex").mcp.status, "unknown");
});

test("Codex launcher evidence uses parsed values, never comments or fake tables inside strings", (t) => {
  const { home, api } = fixture(t);
  const state = () => api.getConnections().agents.find((agent) => agent.id === "codex").mcp.status;
  write(home, ".codex/config.toml", "[mcp_servers.t3_hub]\ncommand = 'node'\nargs = [\n '/fixture/unrelated.js', # previously /fake/t3-mcp-router\n]\n");
  assert.notEqual(state(), "configured");
  write(home, ".codex/config.toml", "[mcp_servers.'t3_hub']\ncommand = '/usr/local/bin/node'\nargs = [\n # old /fake/unrelated\n '/fixture/bin/t3-mcp-router',\n]\n");
  assert.equal(state(), "configured");
  write(home, ".codex/config.toml", "notes = \"\"\"\n[mcp_servers.t3_hub]\ncommand = '/fake/t3-mcp-router'\n\"\"\"\n");
  assert.notEqual(state(), "configured");
  write(home, ".codex/config.toml", "[mcp_servers.t3_hub]\ncommand = '/fixture/bin/t3-mcp-router'\nenabled = 'false'\n");
  assert.equal(state(), "unknown");
  write(home, ".codex/config.toml", "[mcp_servers.t3_hub]\ncommand = 'node'\nargs = ['/fixture/unrelated.js', '/fixture/t3-mcp-router']\n");
  assert.notEqual(state(), "configured");
});

test("AGY reports partial instance configuration instead of treating one profile as every agent", (t) => {
  const { home, api } = fixture(t);
  const profile = name => `.t3/userdata/providers/antigravity/${name}/config/mcp_config.json`;
  const configured = JSON.stringify({ mcpServers: { t3_hub: { command: "/fixture/bin/t3-mcp-router" } } });
  write(home, profile("first-private-profile"), configured);
  write(home, profile("second-private-profile"), JSON.stringify({ mcpServers: {} }));
  let mcp = api.getConnections().agents.find(agent => agent.id === "agy").mcp;
  assert.equal(mcp.status, "unknown");
  assert.deepEqual(mcp.instances, { total: 2, configured: 1, missing: 1, unknown: 0 });
  assert.match(mcp.summary, /1\s*\/\s*2/);
  assert.doesNotMatch(JSON.stringify(mcp), /first-private-profile|second-private-profile/);
  write(home, profile("second-private-profile"), configured);
  mcp = api.getConnections().agents.find(agent => agent.id === "agy").mcp;
  assert.equal(mcp.status, "configured");
  assert.equal(mcp.instances.configured, 2);
  write(home, profile("skills-archived-backup"), JSON.stringify({ mcpServers: {} }));
  mcp = api.getConnections().agents.find(agent => agent.id === "agy").mcp;
  assert.equal(mcp.status, "configured");
  assert.equal(mcp.instances.total, 2, "archived skills are not provider instances");
});

test("routing-only Skill and route guard do not masquerade as memory connections", (t) => {
  const { home, api } = fixture(t);
  write(home, ".agents/skills/t3-subagent-routing/SKILL.md", routeSkill);
  write(home, ".codex/hooks.json", JSON.stringify({ hooks: { PreToolUse: [{ _t3HubHookId: "subagent-route-guard", hooks: [{ command: "node subagent-route-guard.mjs" }] }] } }));
  const result = api.getConnections();
  const codex = result.agents.find((agent) => agent.id === "codex");
  assert.equal(codex.skill.status, "missing");
  assert.equal(codex.hook.status, "missing");
});

test("malformed, unreadable, and absent files have distinct safe states without writes", (t) => {
  const { home, api } = fixture(t);
  write(home, ".codex/config.toml", "not valid TOML");
  write(home, ".config/muse/settings.json", "{");
  write(home, ".codex/hooks.json", JSON.stringify({ hooks: "not-an-object" }));
  write(home, ".agents/skills/powercontext-memory/SKILL.md", "---\nname: powercontext-memory\n");
  const skill = path.join(home, ".agents/skills/powercontext-memory/SKILL.md");
  fs.chmodSync(skill, 0o000);
  const result = api.getConnections();
  assert.equal(result.agents.find((agent) => agent.id === "codex").mcp.status, "unknown");
  assert.equal(result.agents.find((agent) => agent.id === "muse").mcp.status, "unknown");
  assert.equal(result.agents.find((agent) => agent.id === "codex").hook.status, "unknown");
  assert.equal(result.agents.find((agent) => agent.id === "codex").skill.status, "unknown");
  assert.equal(result.agents.find((agent) => agent.id === "pi").mcp.status, "missing");
  assert.equal(fs.existsSync(path.join(home, ".t3")), false);
  assert.equal(result.agents.every((agent) => agent.runtime.status === "unverified"), true);
});

test("project-local memory entries are recognized without exposing project names", (t) => {
  const { home, api } = fixture(t);
  const project = path.join(home, "private-project-name");
  fs.mkdirSync(project);
  write(project, ".codex/config.toml", '[mcp_servers.t3_hub]\ncommand = "/home/test/.t3/bin/t3-mcp-router"\n');
  write(project, ".agents/skills/powercontext-memory/SKILL.md", memorySkill);
  write(project, ".codex/hooks.json", JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: "node memory-stop-hook.mjs" }] }] } }));
  const result = api.getConnections({ projectRoot: project });
  const codex = result.agents.find((agent) => agent.id === "codex");
  assert.equal(codex.mcp.status, "configured");
  assert.equal(codex.skill.status, "configured");
  assert.equal(codex.hook.status, "configured");
  assert.ok(codex.mcp.evidence.every((item) => item.startsWith("project:")));
  assert.equal(JSON.stringify(result).includes("private-project-name"), false);
});

test("AGY profile labels, MCP commands, args, and secrets never leave the status response", (t) => {
  const { home, api } = fixture(t);
  const secret = "TEST_SECRET_DO_NOT_EXPOSE_09e778";
  const profile = ".t3/userdata/providers/antigravity/private-profile/config/mcp_config.json";
  write(home, profile, JSON.stringify({ mcpServers: { t3_hub: { command: "/private/path/t3-mcp-router", args: ["--token", secret], env: { TOKEN: secret } } } }));
  const result = api.getConnections();
  const serialized = JSON.stringify(result);
  assert.equal(result.agents.find((agent) => agent.id === "agy").mcp.status, "configured");
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("private-profile"), false);
  assert.equal(serialized.includes("/private/path"), false);
});

test("AGY-only memory Skill evidence masks provider profile names", (t) => {
  const { home, api } = fixture(t);
  write(home, ".t3/userdata/providers/antigravity/profile-name/config/skills/powercontext-memory/SKILL.md", memorySkill);
  const result = api.getConnections();
  const agy = result.agents.find((agent) => agent.id === "agy");
  assert.equal(agy.skill.status, "configured");
  assert.deepEqual(agy.skill.evidence, [".t3/userdata/providers/antigravity/*/config/skills/powercontext-memory/SKILL.md"]);
  assert.equal(JSON.stringify(result).includes("profile-name"), false);
});

test("backend RPC is connected and installer fallback includes the new sidecar", (t) => {
  const repo = path.resolve(__dirname, "..");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "hub-memory-rpc-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const script = `const {hubCall}=require(${JSON.stringify(path.join(repo, "src/backend.cjs"))});Promise.resolve(hubCall("memory:connections",{})).then(x=>process.stdout.write(JSON.stringify(x)));`;
  const run = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", env: { ...process.env, HOME: temp, T3_HUB_DIR: path.join(temp, ".t3/hub"), NODE_ENV: "test" }, timeout: 10000 });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout).agents.map((agent) => agent.id), ["t3", "codex", "muse", "agy", "claude", "pi"]);

  const installer = fs.readFileSync(path.join(repo, "install.sh"), "utf8");
  const loop = installer.match(/for f in hub-plugins\.cjs[^\n]*\n[^\n]*\ndone/);
  assert.ok(loop, "installer sidecar fallback loop must exist");
  assert.match(loop[0], /hub-memory-connections\.cjs/);
  const sourceRoot = path.join(temp, "source"), source = path.join(sourceRoot, "src"), dest = path.join(temp, "installed");
  fs.mkdirSync(source, { recursive: true }); fs.mkdirSync(dest);
  fs.copyFileSync(path.join(repo, "src/hub-memory-connections.cjs"), path.join(source, "hub-memory-connections.cjs"));
  const copy = spawnSync("/bin/bash", ["-c", loop[0]], { encoding: "utf8", env: { ...process.env, SCRIPT_DIR: sourceRoot, DEST_DIR: dest } });
  assert.equal(copy.status, 0, copy.stderr);
  assert.deepEqual(fs.readFileSync(path.join(dest, "hub-memory-connections.cjs")), fs.readFileSync(path.join(source, "hub-memory-connections.cjs")));
});
