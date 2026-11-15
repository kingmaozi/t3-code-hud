"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { execFileSync } = require("node:child_process");
const pluginsModule = require("../src/hub-plugins.cjs");
const { createPluginsManager } = pluginsModule;
const { createSkillsManager } = require("../src/hub-skills.cjs");
const { createMcpRouter, BUILTIN_UPSTREAM_MCPS, redactArgs, redactUrl, redactSummary } = require("../src/mcp-router.cjs");
function fixture(t) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-v2-plugins-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  return { homeDir, hubDir: path.join(homeDir, "hub"), projectRoot: path.join(homeDir, "project") };
}
function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)); }
function skill(dir, name = path.basename(dir)) { write(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: fixture\n---\nBody\n`); }
function plugin(root, name, extras = {}) { write(path.join(root, ".claude-plugin", "plugin.json"), { name, title: name + " title", version: "1.0.0", ...extras }); return root; }
function hooksSpy() {
  const calls = [];
  return { calls, toggleHook(args) { calls.push({ kind: "toggle", ...args }); }, setPluginHooks(args) { calls.push({ kind: "plugin", ...args }); } };
}
function managers(opts, hooksManager = hooksSpy()) {
  const skills = createSkillsManager(opts), router = createMcpRouter(opts);
  return { skills, router, hooks: hooksManager, manager: createPluginsManager({ ...opts, skillsManager: skills, mcpRouter: router, hooksManager }) };
}
function row(router, name, projectRoot) { return router.listMcpServers({ projectRoot }).items.find(s => s.name === name); }

test("builtin memory plugin has its exact capabilities and persists all scopes with hook linkage", t => {
  const f = fixture(t), { manager, hooks } = managers(f);
  const builtin = manager.listPlugins().items[0];
  assert.equal(builtin.id, "t3-memory-vault");
  assert.equal(builtin.title, "T3 Memory Vault · 智能再记忆");
  assert.equal(builtin.version, "2.0.0");
  assert.equal(builtin.scope, "global");
  assert.equal(builtin.marketplace, "t3-builtin");
  assert.equal(builtin.installed, true);
  assert.deepEqual(builtin.capabilities, { skillsCount: 1, mcpCount: 1, hooksCount: 1, commandsCount: 1, agentsCount: 0, skillNames: ["powercontext-memory"], mcpNames: ["t3_hub"], hookEvents: ["Stop", "SubagentStop"] });
  for (const scope of ["off", "project", "global"]) {
    manager.setPluginScope({ id: builtin.id, scope, projectRoot: f.projectRoot });
    assert.equal(manager.listPlugins({ projectRoot: f.projectRoot }).items[0].scope, scope);
    assert.equal(hooks.calls.at(-1).id, "memory-stop-guard");
    assert.equal(hooks.calls.at(-1).scope, scope);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.hubDir, "state.json"))).pluginScopes[builtin.id], scope);
  }
});

test("composite plugins enable and disable skills, lazy MCP and expanded hooks across scopes", t => {
  const f = fixture(t), root = plugin(path.join(f.hubDir, "plugins", "example"), "example");
  skill(path.join(root, "skills", "bundle"));
  write(path.join(root, ".mcp.json"), { mcpServers: { demo: { command: process.execPath, args: ["${PLUGIN_ROOT}/server.js"], env: { ROOT: "${CLAUDE_PLUGIN_ROOT}", Z: "${ZCODE_PLUGIN_ROOT}", C: "${CODEX_PLUGIN_ROOT}" } } } });
  write(path.join(root, "servers.mcp.json"), { other: { command: process.execPath } });
  write(path.join(root, "hooks", "hooks.json"), { hooks: { Stop: [{ hooks: [{ type: "command", command: "node ${PLUGIN_ROOT}/stop.js" }] }] } });
  write(path.join(root, "commands", "run.md"), "run"); write(path.join(root, "agents", "helper.md"), "helper");
  const { skills, router, hooks, manager } = managers(f);
  const details = manager.listPlugins().items.find(p => p.id === "example");
  assert.equal(details.capabilities.mcpCount, 2); assert.equal(details.capabilities.commandsCount, 1); assert.equal(details.capabilities.agentsCount, 1);
  assert.equal(skills.listAssets({}).items.some(s => s.id === "bundle"), false);
  assert.equal(skills.listAssets({ includePluginBundled: true }).items.find(s => s.id === "bundle").fromCompositePlugin, true);
  manager.setPluginScope({ id: "example", scope: "global" });
  assert.equal(skills.listAssets({}).items.find(s => s.id === "bundle").scope, "global");
  assert.equal(skills.listAssets({}).items.find(s => s.id === "bundle").fromCompositePlugin, true);
  const raw = router.discoverServerDefinitions().get("demo");
  assert.equal(raw.args[0], path.join(root, "server.js"));
  assert.deepEqual(raw.env, { ROOT: root, Z: root, C: root });
  assert.equal(row(router, "demo").mode, "global-lazy");
  assert.equal(row(router, "demo").pluginId, "example");
  assert.equal(hooks.calls.at(-1).hooks.hooks.Stop[0].hooks[0].command, "node " + path.join(root, "stop.js"));
  manager.setPluginScope({ id: "example", scope: "project", projectRoot: f.projectRoot });
  assert.equal(row(router, "demo", f.projectRoot).mode, "project-lazy");
  assert.equal(row(router, "demo").mode, "off");
  assert.ok(fs.lstatSync(path.join(f.projectRoot, ".agents", "skills", "bundle")).isSymbolicLink());
  manager.setPluginScope({ id: "example", scope: "global", projectRoot: f.projectRoot });
  assert.equal(row(router, "demo", f.projectRoot).mode, "global-lazy");
  manager.setPluginScope({ id: "example", scope: "off", projectRoot: f.projectRoot });
  assert.equal(row(router, "demo", f.projectRoot).mode, "off");
  assert.equal(row(router, "demo").mode, "off");
  assert.equal(hooks.calls.at(-1).scope, "off");
  assert.equal(skills.listAssets({ projectRoot: f.projectRoot }).items.some(s => s.id === "bundle"), false);
  assert.equal(skills.listAssets({ includePluginBundled: true }).items.find(s => s.id === "bundle").fromCompositePlugin, true);
  assert.ok(fs.existsSync(path.join(f.hubDir, "skills", "bundle", "SKILL.md")));
  const state = JSON.parse(fs.readFileSync(path.join(f.hubDir, "state.json")));
  assert.equal(state.skills.bundle.scope, "off"); assert.equal(state.pluginScopes.example, "off");
});

test("project changes remove the previous project's skill links and MCP modes", t => {
  const f = fixture(t), root = plugin(path.join(f.hubDir, "plugins", "move"), "move");
  skill(path.join(root, "skills", "moving")); write(path.join(root, ".mcp.json"), { mcpServers: { moving: { command: process.execPath } } });
  const { manager, router } = managers(f); const second = path.join(f.homeDir, "second");
  manager.setPluginScope({ id: "move", scope: "project", projectRoot: f.projectRoot });
  manager.setPluginScope({ id: "move", scope: "project", projectRoot: second });
  assert.equal(fs.existsSync(path.join(f.projectRoot, ".agents", "skills", "moving")), false);
  assert.equal(row(router, "moving", f.projectRoot).mode, "off");
  assert.equal(row(router, "moving", second).mode, "project-lazy");
  assert.equal(manager.listPlugins({ projectRoot: f.projectRoot }).items.find(p => p.id === "move").scope, "off");
  manager.setPluginScope({ id: "move", scope: "off" });
  assert.equal(fs.existsSync(path.join(second, ".agents", "skills", "moving")), false);
  assert.equal(row(router, "moving", second).mode, "off");
});

test("discovers hub, zcode installed/marketplace and latest codex versions, metadata and bounded icons", t => {
  const f = fixture(t), market = path.join(f.homeDir, ".zcode", "cli", "plugins", "marketplaces", "acme");
  plugin(path.join(market, "plugins", "zplug"), "zplug");
  write(path.join(market, "icon-sources.json"), { zplug: "https://example.test/zplug.png" });
  const installedRoot = plugin(path.join(f.homeDir, "external", "installed"), "installed");
  write(path.join(f.homeDir, ".zcode", "cli", "plugins", "installed_plugins.json"), { plugins: { "installed@acme": [{ installPath: installedRoot }] } });
  write(path.join(installedRoot, "icon.png"), Buffer.from([137, 80, 78, 71]));
  const cache = path.join(f.homeDir, ".codex", "plugins", "cache", "acme", "cplug");
  plugin(path.join(cache, "1.9.0"), "cplug", { version: "1.9.0" });
  plugin(path.join(cache, "1.10.0"), "cplug", { version: "1.10.0" });
  const { manager } = managers(f); let items = manager.listPlugins().items;
  assert.equal(items.find(p => p.id === "cplug").version, "1.10.0");
  assert.equal(items.find(p => p.id === "zplug").icon, "https://example.test/zplug.png");
  assert.ok(items.find(p => p.id === "installed").icon.startsWith("data:image/png;base64,"));
  fs.symlinkSync(path.join(cache, "1.9.0"), path.join(cache, "latest"), "dir");
  assert.equal(manager.listPlugins().items.find(p => p.id === "cplug").version, "1.9.0");
  write(path.join(installedRoot, "icon.png"), Buffer.alloc(256 * 1024));
  assert.equal(manager.listPlugins().items.find(p => p.id === "installed").icon, null);
});

test("all composite markers and multi-skill bundles are separated from standalone skills", t => {
  const f = fixture(t);
  for (const [i, marker] of [".zcode-plugin", ".codex-plugin", ".claude-plugin", ".mcp.json", "servers.mcp.json", "hooks/hooks.json", "commands/run.md"].entries()) {
    const root = path.join(f.hubDir, "plugins", "marker" + i);
    write(path.join(root, marker), {}); skill(path.join(root, "skills", "skill" + i));
  }
  const bundle = path.join(f.hubDir, "plugins", "multi"); skill(path.join(bundle, "skills", "a")); skill(path.join(bundle, "skills", "b"));
  skill(path.join(f.homeDir, ".agents", "skills", "standalone"));
  const { skills, manager } = managers(f);
  assert.equal(manager.listPlugins().items.length, 9);
  assert.deepEqual(skills.listAssets({}).items.map(x => x.id), ["standalone"]);
  const bundled = skills.listAssets({ includePluginBundled: true }).items.filter(x => x.id !== "standalone");
  assert.equal(bundled.length, 9); assert.ok(bundled.every(x => x.fromCompositePlugin));
  skills.setSkillScope({ id: "skill1", scope: "global", sourceDir: path.join(f.hubDir, "plugins", "marker1", "skills", "skill1") });
  assert.ok(skills.listAssets({}).items.some(x => x.id === "skill1" && x.fromCompositePlugin));
});

test("sourceDir import preserves unrelated canonical files and external symlinks", t => {
  const f = fixture(t), mgr = createSkillsManager(f), source = path.join(f.homeDir, "source"); skill(source, "safe");
  const target = path.join(f.hubDir, "skills", "safe"); write(path.join(target, "keep.txt"), "keep");
  const external = path.join(f.homeDir, "external"); skill(external, "external");
  fs.mkdirSync(path.join(f.homeDir, ".agents", "skills"), { recursive: true });
  fs.symlinkSync(external, path.join(f.homeDir, ".agents", "skills", "safe"), "dir");
  mgr.setSkillScope({ id: "safe", scope: "global", sourceDir: source });
  assert.ok(fs.existsSync(path.join(target, "SKILL.md")));
  assert.ok(fs.readdirSync(path.dirname(target)).some(n => n.startsWith("safe.bak-t3hub-") && fs.readFileSync(path.join(path.dirname(target), n, "keep.txt"), "utf8") === "keep"));
  assert.ok(fs.existsSync(path.join(external, "SKILL.md")));
  const backups = fs.readdirSync(path.join(f.homeDir, ".agents", "skills")).filter(n => n.startsWith("safe.bak-t3hub-"));
  assert.ok(backups.some(n => fs.lstatSync(path.join(f.homeDir, ".agents", "skills", n)).isSymbolicLink()));
  assert.throws(() => mgr.setSkillScope({ id: "bad", scope: "global", sourceDir: "relative" }), /sourceDir/);
});

test("plugin IDs and scope/input validation reject traversal before any writes", async t => {
  const f = fixture(t), { manager } = managers(f);
  for (const id of ["../bad", "a/b", "a\\b", "..", "a..b", "__proto__", "constructor", "bad\0id", "a;pwd", "-flag"]) assert.throws(() => manager.setPluginScope({ id, scope: "global" }), /invalid plugin id/);
  assert.throws(() => manager.setPluginScope({ id: "t3-memory-vault", scope: "project" }), /projectRoot/);
  assert.throws(() => manager.setPluginScope({ id: "t3-memory-vault", scope: "global", projectRoot: "relative" }), /projectRoot/);
  for (const input of ["-rf", "owner/repo;echo hi", "https://evil.test/o/r", "https://github.com/o/r?token=x", "https://user:pass@github.com/o/r", "https://github.com/o/r/tree/main", "https://github.com/o/r#x"]) await assert.rejects(manager.installPluginFromGitHub({ input }), /invalid/);
  assert.equal(fs.existsSync(f.hubDir), false);
});

test("installs a local git composite plugin and applies scope without shell interpolation", async t => {
  const f = fixture(t), source = plugin(path.join(f.homeDir, "local-repo"), "local-plugin"); skill(path.join(source, "skills", "local-skill"));
  execFileSync("git", ["init", source], { stdio: "pipe" });
  execFileSync("git", ["-C", source, "add", "."], { stdio: "pipe" });
  execFileSync("git", ["-C", source, "-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"], { stdio: "pipe" });
  const { manager, skills } = managers(f);
  const installed = await manager.installPluginFromGitHub({ input: source, scope: "project", projectRoot: f.projectRoot });
  assert.equal(installed.ok, true); assert.equal(installed.id, "local-plugin");
  assert.equal(installed.installPath, path.join(f.hubDir, "plugins", "local-repo"));
  assert.equal(skills.listAssets({ projectRoot: f.projectRoot }).items.find(x => x.id === "local-skill").scope, "project");
  await assert.rejects(manager.installPluginFromGitHub({ input: source }), /already exists/);
});

test("direct catalog supplies all seven upstream templates without Magpie and expands plugin roots", t => {
  const f = fixture(t);
  const root = plugin(path.join(f.homeDir, ".zcode", "cli", "plugins", "marketplaces", "acme", "plugins", "upstream"), "upstream");
  write(path.join(root, ".mcp.json"), { mcpServers: { direct: { command: process.execPath, args: ["${CLAUDE_PLUGIN_ROOT}/one.js", "${ZCODE_PLUGIN_ROOT}/two.js"], env: { ROOT: "${CODEX_PLUGIN_ROOT}" } } } });
  const local = path.join(f.homeDir, "plugins", "local"); write(path.join(local, ".mcp.json"), { mcpServers: { local: { command: process.execPath, args: ["${PLUGIN_ROOT}/local.js"] } } });
  const router = createMcpRouter(f), definitions = router.discoverServerDefinitions(), items = router.listMcpServers().items;
  assert.equal(BUILTIN_UPSTREAM_MCPS.length, 7);
  for (const name of ["chrome-devtools", "codegraph", "context7", "playwright", "lcu", "fetch", "github"]) {
    const item = items.find(x => x.name === name); assert.ok(item, name); assert.equal(item.builtin, true); assert.equal(item.installed, false);
  }
  assert.deepEqual(definitions.get("chrome-devtools").args, ["-y", "chrome-devtools-mcp@latest"]);
  assert.deepEqual(definitions.get("codegraph").args, ["serve", "--mcp"]);
  assert.equal(definitions.get("context7").url, "https://mcp.context7.com/mcp");
  assert.deepEqual(definitions.get("playwright").args, ["-y", "@playwright/mcp@latest"]);
  assert.equal(definitions.get("lcu").command, path.join(f.homeDir, ".local", "share", "lcu"));
  assert.deepEqual(definitions.get("fetch").args, ["mcp-server-fetch"]);
  assert.equal(definitions.get("github").url, "https://api.githubcopilot.com/mcp/");
  assert.equal(definitions.get("direct").args[0], path.join(root, "one.js"));
  assert.equal(definitions.get("direct").env.ROOT, root);
  assert.equal(definitions.get("local").args[0], path.join(local, "local.js"));
  assert.equal(items.find(x => x.name === "direct").pluginId, "upstream");
  for (const item of items) {
    for (const field of ["title", "groupTitle", "icon", "builtin", "pluginId", "installed"]) assert.ok(Object.hasOwn(item, field), field);
    assert.ok(item.connected === null || item.connected === false); assert.equal(item.probed, false);
  }
});

test("name aliases deduplicate discovery/registry and retain scopes and registry precedence", t => {
  const f = fixture(t);
  write(path.join(f.homeDir, ".pi", "agent", "mcp.json"), { mcpServers: { briking_agent_reach: { command: "old-command" }, T3_HUB: { command: "never" } } });
  write(path.join(f.hubDir, "state.json"), { pluginScopes: { keep: "off" }, mcpModes: { global: { briking_agent_reach: "global-lazy" }, projects: {} } });
  const router = createMcpRouter(f); router.upsertMcpServer({ name: "briking-agent-reach", command: process.execPath });
  const items = router.listMcpServers().items.filter(x => x.name.toLowerCase().replace(/_/g, "-") === "briking-agent-reach");
  assert.equal(items.length, 1); assert.equal(items[0].command, process.execPath); assert.equal(items[0].mode, "global-lazy");
  assert.ok(!router.listMcpServers().items.some(x => /t3[_-]hub/i.test(x.name)));
  router.setMcpMode({ name: "BRIKING_AGENT_REACH", mode: "project-lazy", projectRoot: f.projectRoot });
  assert.equal(row(router, "briking-agent-reach", f.projectRoot).mode, "project-lazy");
  router.upsertMcpServer({ name: "BRIKING_AGENT_REACH", command: process.execPath });
  const raw = JSON.parse(fs.readFileSync(router.registryPath)); assert.equal(raw.length, 1);
  router.removeMcpServer({ name: "briking-agent-reach" });
  const state = JSON.parse(fs.readFileSync(router.statePath)); assert.deepEqual(state.mcpModes.global, {}); assert.deepEqual(state.mcpModes.projects[f.projectRoot], {}); assert.equal(state.pluginScopes.keep, "off");
});

test("registry and returned argument/url/summary fields preserve permission and redaction guarantees", t => {
  const f = fixture(t), router = createMcpRouter(f), secret = "super-secret-value";
  router.upsertMcpServer({ name: "redacted", command: process.execPath, args: ["--token", secret, "--api-key=" + secret], env: { API_KEY: secret }, url: "https://u:pass@example.test/mcp?token=" + secret });
  const item = row(router, "redacted"); assert.ok(!JSON.stringify(item).includes(secret)); assert.ok(!item.url.includes("pass"));
  assert.equal(fs.statSync(router.registryPath).mode & 0o777, 0o600);
  assert.equal(redactArgs(["--password", secret])[1], "***");
  assert.ok(!redactUrl("https://example.test/?key=" + secret).includes(secret));
  assert.ok(!redactSummary({ name: "x", env: { TOKEN: secret } }).includes(secret));
});

test("stdio probes verify real MCP initialize handshake and reject broken or missing scripts", async t => {
  const f = fixture(t), router = createMcpRouter(f);
  write(path.join(f.projectRoot, "good-mcp.js"), `
    process.stdin.setEncoding("utf8");
    let buf = "";
    process.stdin.on("data", (c) => {
      buf += c;
      let idx;
      while ((idx = buf.indexOf("\\n")) >= 0) {
        const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.method === "initialize") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "good-mcp", version: "1.0.0" } } }) + "\\n");
        }
      }
    });
  `);
  write(path.join(f.projectRoot, "broken.js"), "console.log('not an mcp server'); process.exit(1);");
  const definitions = {
    good: { command: process.execPath, args: ["good-mcp.js"] },
    broken: { command: process.execPath, args: ["broken.js"] },
    missing: { command: process.execPath, args: ["missing.js"] },
    multiple: { command: process.execPath, args: [path.join(f.projectRoot, "good-mcp.js"), path.join(f.homeDir, "missing.js")] },
    no_command: { command: path.join(f.homeDir, "absent") },
    directory: { command: f.projectRoot },
  };
  router.upsertMcpServer({ jsonRaw: JSON.stringify({ mcpServers: definitions }) });
  assert.equal(row(router, "good", f.projectRoot).connected, null);
  const probes = Object.assign({}, ...(await Promise.all(Object.keys(definitions).map(name => router.probeMcpServers({ name, projectRoot: f.projectRoot, timeoutMs: 1200 })))).map(p => p.results));
  assert.equal(probes.good.connected, true);
  for (const name of ["broken", "missing", "multiple", "no_command", "directory"]) assert.equal(probes[name].connected, false, name);
  for (const name of Object.keys(definitions)) { assert.equal(row(router, name, f.projectRoot).connected, probes[name].connected); assert.equal(row(router, name, f.projectRoot).probed, true); }
  const one = await router.probeMcpServers({ name: "GOOD", projectRoot: f.projectRoot, timeoutMs: 1200 }); assert.deepEqual(Object.keys(one.results), ["good"]);
  assert.deepEqual((await router.probeMcpServers({ name: "unknown" })).results, {});
});

test("HTTP/SSE probes require valid MCP initialize handshake and reject plain 200 non-MCP responses", async t => {
  const f = fixture(t), router = createMcpRouter(f);
  let sseClient = null;
  const server = http.createServer((req, res) => {
    if (req.url === "/timeout") return;
    if (req.url === "/rejected") { res.writeHead(403); res.end(); return; }
    if (req.url === "/plain200") { res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}"); return; }
    if (req.url === "/ok" && req.method === "POST") {
      let body = ""; req.on("data", c => { body += c; });
      req.on("end", () => {
        const msg = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "http-mcp", version: "1.0" } } }));
      });
      return;
    }
    if (req.url === "/sse" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      sseClient = res;
      res.write("event: endpoint\ndata: /sse-msg\n\n");
      return;
    }
    if (req.url === "/sse-msg" && req.method === "POST") {
      let body = ""; req.on("data", c => { body += c; });
      req.on("end", () => {
        const msg = JSON.parse(body);
        if (sseClient) sseClient.write("event: message\ndata: " + JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "sse-mcp", version: "1.0" } } }) + "\n\n");
        res.writeHead(202); res.end("Accepted");
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  for (const name of ["ok", "sse", "plain200", "rejected", "timeout"]) router.upsertMcpServer({ name, transport: name === "sse" ? "sse" : "http", url: url + "/" + name });
  router.upsertMcpServer({ name: "unreachable", url: "http://127.0.0.1:1/mcp" });
  for (const [name, connected] of [["ok", true], ["sse", true], ["plain200", false], ["rejected", false], ["unreachable", false], ["timeout", false]]) {
    const start = Date.now(); const result = await router.probeMcpServers({ name, timeoutMs: 250 });
    assert.equal(result.results[name].connected, connected, name); assert.ok(Date.now() - start < 1500);
  }
  await assert.rejects(router.probeMcpServers({ timeoutMs: 0 }), /timeoutMs/);
});

test("autoSyncHosts idempotently updates existing hosts, preserves other settings and secures backups", t => {
  const f = fixture(t), router = createMcpRouter(f);
  const codex = path.join(f.homeDir, ".codex", "config.toml");
  write(codex, '# keep\n[mcp_servers.t3_hub]\ncommand = "old"\n[mcp_servers.t3_hub.env]\nTOKEN = "private"\n[other]\nvalue = "keep"\n');
  const files = [path.join(f.homeDir, ".pi", "agent", "mcp.json"), path.join(f.homeDir, ".config", "muse", "settings.json"), path.join(f.homeDir, ".claude", "mcp.json"), path.join(f.homeDir, ".zcode", "cli", "mcp.json"), path.join(f.homeDir, ".t3", "userdata", "providers", "antigravity", "one", "config", "mcp_config.json")];
  for (const file of files) write(file, { other: true, mcpServers: { keep: { command: "keep" }, "t3-hub": { command: "old" } } });
  const first = router.autoSyncHosts(); assert.equal(first.syncedTargets.length, 6);
  const contents = [codex, ...files].map(file => fs.readFileSync(file, "utf8"));
  const stamps = [codex, ...files].map(file => fs.statSync(file).mtimeMs);
  router.autoSyncHosts();
  for (const [i, file] of [codex, ...files].entries()) {
    assert.equal(fs.readFileSync(file, "utf8"), contents[i]); assert.equal(fs.statSync(file).mtimeMs, stamps[i]);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.equal(fs.statSync(file + ".bak-t3hub").mode & 0o777, 0o600);
  }
  const raw = fs.readFileSync(codex, "utf8"); assert.equal((raw.match(/\[mcp_servers.t3_hub\]/g) || []).length, 1); assert.ok(raw.includes('[other]\nvalue = "keep"')); assert.ok(!raw.includes("TOKEN"));
  for (const file of files) { const json = JSON.parse(fs.readFileSync(file)); assert.equal(json.other, true); assert.equal(json.mcpServers.keep.command, "keep"); assert.ok(json.mcpServers.t3_hub.command.endsWith("t3-mcp-router")); assert.equal(json.mcpServers["t3-hub"], undefined); }
  assert.equal(fs.existsSync(path.join(f.homeDir, ".nonexistent")), false);
});

test("autoSyncHosts skips absent CLI directories and malformed configurations", t => {
  const f = fixture(t), router = createMcpRouter(f);
  assert.equal(router.autoSyncHosts().syncedTargets.length, 0);
  const file = path.join(f.homeDir, ".claude", "mcp.json"); write(file, "{broken");
  assert.ok(router.autoSyncHosts().skippedTargets.includes(file)); assert.equal(fs.readFileSync(file, "utf8"), "{broken");
});


test("registry overrides change transport cleanly instead of inheriting stale upstream endpoints", t => {
  const f = fixture(t), router = createMcpRouter(f);
  router.upsertMcpServer({ jsonRaw: JSON.stringify({ mcpServers: { context7: { command: process.execPath, args: [] } } }) });
  const raw = router.discoverServerDefinitions().get("context7");
  assert.equal(raw.url, null); assert.equal(raw.transport, "stdio");
  assert.equal(raw.command, process.execPath); assert.equal(row(router, "context7").builtin, true);
});

test("broken directory links never hide healthy packages", t => {
  const f = fixture(t), root = path.join(f.hubDir, "plugins");
  plugin(path.join(root, "healthy"), "healthy"); fs.symlinkSync(path.join(f.homeDir, "missing"), path.join(root, "broken"));
  assert.ok(managers(f).manager.listPlugins().items.some(p => p.id === "healthy"));
});

test("lazy hooks factory uses isolated home for real memory and composite plugin linkage", t => {
  const f = fixture(t), manager = createPluginsManager(f);
  manager.setPluginScope({ id: "t3-memory-vault", scope: "off" });
  let state = JSON.parse(fs.readFileSync(path.join(f.hubDir, "hooks-state.json")));
  assert.equal(state.hooks.find(h => h.id === "memory-stop-guard").scope, "off");
  manager.setPluginScope({ id: "t3-memory-vault", scope: "project", projectRoot: f.projectRoot });
  state = JSON.parse(fs.readFileSync(path.join(f.hubDir, "hooks-state.json")));
  assert.equal(state.hooks.find(h => h.id === "memory-stop-guard").scope, "project");
  const root = plugin(path.join(f.hubDir, "plugins", "hooked"), "hooked");
  write(path.join(root, "hooks", "hooks.json"), { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node ${PLUGIN_ROOT}/check.js" }] }] } });
  manager.setPluginScope({ id: "hooked", scope: "global" });
  const globalFile = path.join(f.homeDir, ".claude", "settings.json");
  const global = JSON.parse(fs.readFileSync(globalFile));
  assert.ok(global.hooks.PreToolUse.some(group => group.hooks.some(hook => hook.command.endsWith("node " + path.join(root, "check.js")))));
  manager.setPluginScope({ id: "hooked", scope: "off" });
  const off = JSON.parse(fs.readFileSync(globalFile));
  assert.ok(!off.hooks.PreToolUse.some(group => group.hooks.some(hook => hook.command.endsWith("node " + path.join(root, "check.js")))));
});


test("project to global promotion uses the persisted project root when omitted by caller", t => {
  const f = fixture(t), root = plugin(path.join(f.hubDir, "plugins", "promote"), "promote");
  skill(path.join(root, "skills", "promote"));
  write(path.join(root, ".mcp.json"), { mcpServers: { promote: { command: process.execPath } } });
  const { manager, router, skills } = managers(f);
  manager.setPluginScope({ id: "promote", scope: "project", projectRoot: f.projectRoot });
  manager.setPluginScope({ id: "promote", scope: "global" });
  assert.equal(row(router, "promote", f.projectRoot).mode, "global-lazy");
  assert.equal(skills.listAssets({ projectRoot: f.projectRoot }).items.find(x => x.id === "promote").scope, "global");
  assert.equal(fs.existsSync(path.join(f.projectRoot, ".agents", "skills", "promote")), false);
});


for (const independentName of ["shared-mcp", "shared_mcp"]) test(`plugin scope preserves independent ${independentName} definition and modes`, t => {
  const f = fixture(t), { router, manager } = managers(f);
  router.upsertMcpServer({ name: independentName, command: process.execPath, args: ["--user-owned"], env: { OWNER: "user" } });
  router.setMcpMode({ name: independentName, mode: "global-lazy" });
  const registry = fs.readFileSync(router.registryPath, "utf8");
  const state = JSON.parse(fs.readFileSync(router.statePath));
  const root = plugin(path.join(f.hubDir, "plugins", "collision"), "collision");
  write(path.join(root, ".mcp.json"), { mcpServers: { "shared-mcp": { command: "plugin-command" } } });
  for (const scope of ["global", "project", "off"]) {
    const result = manager.setPluginScope({ id: "collision", scope, projectRoot: f.projectRoot });
    if (scope !== "off") assert.deepEqual(result.skippedMcps, ["shared-mcp"]);
    assert.equal(fs.readFileSync(router.registryPath, "utf8"), registry);
    assert.deepEqual(JSON.parse(fs.readFileSync(router.statePath)).mcpModes, state.mcpModes);
    assert.equal(row(router, independentName, f.projectRoot).mode, "global-lazy");
    assert.equal(row(router, independentName).pluginId, null);
  }
});

test("plugins preserve other plugin ownership and unowned active catalog modes", t => {
  const f = fixture(t), { router, manager } = managers(f);
  for (const id of ["first", "second"]) {
    const root = plugin(path.join(f.hubDir, "plugins", id), id);
    write(path.join(root, ".mcp.json"), { mcpServers: { shared: { command: process.execPath, args: [id] } } });
  }
  manager.setPluginScope({ id: "first", scope: "global" });
  const before = fs.readFileSync(router.registryPath, "utf8");
  assert.deepEqual(manager.setPluginScope({ id: "second", scope: "global" }).skippedMcps, ["shared"]);
  manager.setPluginScope({ id: "second", scope: "off" });
  assert.equal(fs.readFileSync(router.registryPath, "utf8"), before);
  assert.equal(row(router, "shared").mode, "global-lazy");
  assert.equal(row(router, "shared").pluginId, "first");
  // A user-created mode must not subsequently become plugin-owned.
  router.setMcpMode({ name: "shared", mode: "project-direct", projectRoot: f.projectRoot });
  manager.setPluginScope({ id: "first", scope: "off" });
  assert.equal(row(router, "shared", f.projectRoot).mode, "project-direct");
  assert.equal(row(router, "shared").mode, "off");
});

test("plugin cannot claim active modes without an ownership record or overwrite foreign registry directly", t => {
  const f = fixture(t), { router, manager } = managers(f);
  const root = plugin(path.join(f.hubDir, "plugins", "active"), "active");
  write(path.join(root, ".mcp.json"), { mcpServers: { shared: { command: process.execPath } } });
  write(router.statePath, { mcpModes: { global: { shared: "global-lazy" }, projects: {} } });
  assert.deepEqual(manager.setPluginScope({ id: "active", scope: "global" }).skippedMcps, ["shared"]);
  manager.setPluginScope({ id: "active", scope: "off" });
  assert.equal(row(router, "shared").mode, "global-lazy");
  router.upsertMcpServer({ name: "independent", command: process.execPath });
  const before = fs.readFileSync(router.registryPath, "utf8");
  assert.deepEqual(router.upsertMcpServer({ name: "independent", command: "foreign", pluginId: "active" }).skippedMcps, ["independent"]);
  assert.equal(fs.readFileSync(router.registryPath, "utf8"), before);
});

test("MCP list uses persisted probe results and never probes on listing", async t => {
  const f = fixture(t), router = createMcpRouter(f);
  let requests = 0;
  const server = http.createServer((req, res) => { requests++; res.writeHead(req.url === "/good" ? 200 : 403, { "Content-Type": "application/json" }); res.end(req.url === "/good" ? JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "good", version: "1.0" } } }) : "{}"); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  for (const name of ["good", "bad"]) router.upsertMcpServer({ name, url: url + "/" + name });
  router.upsertMcpServer({ name: "absent", command: path.join(f.homeDir, "missing-executable") });
  for (const name of ["good", "bad"]) { assert.equal(row(router, name).connected, null); assert.equal(row(router, name).probed, false); }
  assert.equal(row(router, "absent").connected, false);
  assert.equal(row(router, "absent").statusText, "未检测到可执行命令，请检查安装或探测连通性。");
  assert.equal(requests, 0);
  await Promise.all([router.probeMcpServers({ name: "good" }), router.probeMcpServers({ name: "bad" })]);
  assert.equal(row(router, "good").connected, true); assert.equal(row(router, "good").probed, true);
  assert.equal(row(router, "bad").connected, false); assert.equal(row(router, "bad").probed, true);
  const again = createMcpRouter(f);
  assert.equal(row(again, "good").connected, true); assert.equal(row(again, "bad").connected, false);
  assert.ok(fs.existsSync(path.join(f.hubDir, "mcp-probe-cache.json")));
  assert.equal(requests, 2);
  router.upsertMcpServer({ name: "good", url: url + "/changed" });
  assert.equal(row(router, "good").connected, null, "changed endpoints cannot inherit an old successful probe");
  assert.equal(requests, 2);
});


test("discovered independent host definition takes priority over a plugin alias", t => {
  const f = fixture(t), { router, manager } = managers(f);
  const root = plugin(path.join(f.hubDir, "plugins", "host-collision"), "host-collision");
  write(path.join(root, ".mcp.json"), { mcpServers: { "host-mcp": { command: "plugin-exec" } } });
  write(path.join(f.homeDir, ".claude/mcp.json"), { mcpServers: { host_mcp: { command: process.execPath } } });
  assert.deepEqual(manager.setPluginScope({ id: "host-collision", scope: "global" }).skippedMcps, ["host-mcp"]);
  manager.setPluginScope({ id: "host-collision", scope: "off" });
  assert.equal(row(router, "host_mcp").command, process.execPath);
  assert.equal(row(router, "host_mcp").pluginId, null);
});


test("MCP drawer renders only confirmed connections as available", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/hub-drawer-ui.js"), "utf8");
  const extract = name => {
    const start = source.indexOf(`    function ${name}(`);
    assert.ok(start >= 0);
    const rest = source.slice(start);
    return rest.slice(0, rest.slice(1).search(/\n    (?:async )?function /) + 1);
  };
  const servers = [
    { name: "unknown", connected: null }, { name: "good", connected: true },
    { name: "bad", connected: false, statusText: "不可访问" },
  ];
  const node = { innerHTML: "" };
  const dependencies = {
    root: { querySelector: () => node }, state: { tab: "mcp", mcpQuery: "", freshModes: {} },
    disposed: false, errors: {}, cache: { mcp: {} }, mcpServers: () => servers,
    tr: zh => zh, esc: String, icon: () => "", redact: String,
    items: (item, keys) => item[keys[0]] || [], mcpMode: s => s.mode || "off",
    mcpModes: () => [["off", "关闭"], ["global-lazy", "懒加载"]],
    mcpGroupTitle: () => "MCP", projectDisabled: () => false, button: () => "", empty: () => "",
  };
  const render = new Function(...Object.keys(dependencies), extract("brandIcon") + extract("renderMcpList") + ";return renderMcpList;")(...Object.values(dependencies));
  render();
  for (const server of servers) {
    const article = node.innerHTML.match(new RegExp(`<article[^>]*data-mcp-name="${server.name}"[\\s\\S]*?</article>`))?.[0];
    assert.ok(article, server.name);
    assert.equal(article.includes("is-connected"), server.connected === true);
    assert.equal(article.includes("is-available"), server.connected === true);
    if (server.connected === null) { assert.match(article, /按需唤醒/); assert.doesNotMatch(article, /已连接并可用/); }
    if (server.connected === false) assert.match(article, /不可访问/);
  }
});

test("MCP probes handle chunked Content-Length frames, reap SIGTERM-ignoring children via SIGKILL, block cross-origin 307 redirects, and reject incomplete InitializeResult", async t => {
  const f = fixture(t), router = createMcpRouter(f);
  const pidFile = path.join(f.projectRoot, "stubborn.pid");
  write(path.join(f.projectRoot, "chunked-framed.js"), `
    process.stdin.once("data", () => {
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "framed", version: "1.0" } } });
      const head = "Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n";
      process.stdout.write(head.slice(0, 10));
      setTimeout(() => process.stdout.write(head.slice(10, 22)), 10);
      setTimeout(() => process.stdout.write(head.slice(22) + body.slice(0, 20)), 20);
      setTimeout(() => process.stdout.write(body.slice(20)), 30);
    });
  `);
  write(path.join(f.projectRoot, "stubborn.js"), `
    const fs = require("fs");
    process.on("SIGTERM", () => {});
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    setInterval(() => {}, 1000);
  `);
  write(path.join(f.projectRoot, "incomplete-init.js"), `
    process.stdin.once("data", () => {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } }) + "\\n");
    });
  `);

  let evilHit = false;
  const evil = http.createServer((req, res) => { evilHit = true; res.writeHead(200); res.end(); });
  await new Promise(r => evil.listen(0, "127.0.0.1", r));
  t.after(() => { evil.closeAllConnections(); evil.close(); });
  const evilUrl = `http://127.0.0.1:${evil.address().port}/steal`;

  const srv = http.createServer((req, res) => {
    if (req.url === "/sse" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("event: endpoint\ndata: /bounce\n\n");
      return;
    }
    if (req.url === "/bounce" && req.method === "POST") {
      res.writeHead(307, { Location: evilUrl });
      res.end();
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  t.after(() => { srv.closeAllConnections(); srv.close(); });

  router.upsertMcpServer({
    jsonRaw: JSON.stringify({
      mcpServers: {
        framed: { command: process.execPath, args: ["chunked-framed.js"] },
        stubborn: { command: process.execPath, args: ["stubborn.js"] },
        incomplete: { command: process.execPath, args: ["incomplete-init.js"] },
        redirect_sse: { transport: "sse", url: `http://127.0.0.1:${srv.address().port}/sse`, headers: { Authorization: "Bearer secret" } },
      },
    }),
  });

  const rFramed = await router.probeMcpServers({ name: "framed", projectRoot: f.projectRoot, timeoutMs: 800 });
  assert.equal(rFramed.results.framed.connected, true);

  const rInc = await router.probeMcpServers({ name: "incomplete", projectRoot: f.projectRoot, timeoutMs: 300 });
  assert.equal(rInc.results.incomplete.connected, false);

  const rStub = await router.probeMcpServers({ name: "stubborn", projectRoot: f.projectRoot, timeoutMs: 120 });
  assert.equal(rStub.results.stubborn.connected, false);
  await new Promise(r => setTimeout(r, 150));
  const stubbornPid = Number(fs.readFileSync(pidFile, "utf8"));
  assert.throws(() => process.kill(stubbornPid, 0), /ESRCH/, "SIGKILL reaps SIGTERM-ignoring stdio servers");

  const rSse = await router.probeMcpServers({ name: "redirect_sse", timeoutMs: 300 });
  assert.equal(rSse.results.redirect_sse.connected, false);
  assert.equal(evilHit, false, "cross-origin 307 redirect must never be followed");
});

test("autoSyncHosts preserves [mcp_servers.t3_hub] lines inside multiline TOML strings and skips malformed TOML", t => {
  const f = fixture(t), router = createMcpRouter(f);
  const codex = path.join(f.homeDir, ".codex", "config.toml");
  const multi = [
    'developer_instructions = """',
    'Example block:',
    '[mcp_servers.t3_hub]',
    'command = "keep-inside-string"',
    '"""',
    '[mcp_servers.t3_hub]',
    'command = "stale-real-section"',
    '[model_providers.custom]',
    'name = "keep-provider"',
    '',
  ].join("\n");
  write(codex, multi);
  const res = router.autoSyncHosts();
  assert.ok(res.syncedTargets.includes(codex));
  const out = fs.readFileSync(codex, "utf8");
  assert.ok(out.includes('developer_instructions = """\nExample block:\n[mcp_servers.t3_hub]\ncommand = "keep-inside-string"\n"""'));
  assert.ok(out.includes('[model_providers.custom]\nname = "keep-provider"'));
  assert.ok(!out.includes("stale-real-section"));

  const broken = 'developer_instructions = """\nunclosed multiline\n[mcp_servers.t3_hub]\n';
  write(codex, broken);
  const resBroken = router.autoSyncHosts();
  assert.ok(resBroken.skippedTargets.includes(codex));
  assert.equal(fs.readFileSync(codex, "utf8"), broken);
});

test("autoSyncHosts replaces spaced TOML hub header without duplicate table", t => {
  const f = fixture(t), router = createMcpRouter(f);
  const codex = path.join(f.homeDir, ".codex", "config.toml");
  const original = [
    "[ mcp_servers . t3_hub ]",
    'command = "old-spaced"',
    '[other]',
    'value = "keep"',
    '',
  ].join("\n");
  write(codex, original);
  const res = router.autoSyncHosts();
  assert.ok(res.syncedTargets.includes(codex));
  const out = fs.readFileSync(codex, "utf8");
  assert.equal((out.match(/\[mcp_servers\.t3_hub\]/g) || []).length, 1);
  assert.ok(!out.includes("old-spaced"));
  assert.ok(out.includes('[other]\nvalue = "keep"'));
  assert.ok(!out.includes("[ mcp_servers . t3_hub ]"));
});

test("autoSyncHosts replaces quoted TOML hub headers without duplicate table", t => {
  for (const variant of ['["mcp_servers"."t3_hub"]', "['mcp_servers'.'t3_hub'] # trailing comment"]) {
    const f = fixture(t), router = createMcpRouter(f);
    const codex = path.join(f.homeDir, ".codex", "config.toml");
    const original = [
      variant,
      'command = "old-quoted"',
      '[other]',
      'value = "keep"',
      '',
    ].join("\n");
    write(codex, original);
    const res = router.autoSyncHosts();
    assert.ok(res.syncedTargets.includes(codex), variant);
    const out = fs.readFileSync(codex, "utf8");
    assert.equal((out.match(/\[mcp_servers\.t3_hub\]/g) || []).length, 1, variant);
    assert.ok(!out.includes("old-quoted"), variant);
    assert.ok(out.includes('[other]\nvalue = "keep"'), variant);
    assert.ok(!out.includes(variant.split("#")[0].trim()), variant);
  }
});

test("autoSyncHosts preserves hub header text inside multiline TOML strings", t => {
  const f = fixture(t), router = createMcpRouter(f);
  const codex = path.join(f.homeDir, ".codex", "config.toml");
  const original = [
    'a = """',
    '[mcp_servers.t3_hub]',
    'command = "keep-basic"',
    '"""',
    "b = '''",
    '[mcp_servers.t3_hub]',
    'command = "keep-literal"',
    "'''",
    '[mcp_servers.t3_hub]',
    'command = "stale-real-section"',
    '[other]',
    'value = "keep"',
    '',
  ].join("\n");
  write(codex, original);
  const res = router.autoSyncHosts();
  assert.ok(res.syncedTargets.includes(codex));
  const out = fs.readFileSync(codex, "utf8");
  assert.ok(out.includes('a = """\n[mcp_servers.t3_hub]\ncommand = "keep-basic"\n"""'));
  assert.ok(out.includes("b = '''\n[mcp_servers.t3_hub]\ncommand = \"keep-literal\"\n'''"));
  assert.ok(out.includes('[other]\nvalue = "keep"'));
  assert.ok(!out.includes("stale-real-section"));
  assert.equal((out.match(/\[mcp_servers\.t3_hub\]/g) || []).length, 3);
});

test("autoSyncHosts does not append conflicting table for inline/dotted mcp definitions", t => {
  for (const original of [
    'mcp_servers = { t3_hub = { command = "node" } }\n',
    '[mcp_servers]\nt3_hub = { command = "node" }\n',
    'mcp_servers.t3_hub.command = "node"\n',
    '[mcp_servers]\nt3_hub.command = "node"\n',
  ]) {
    const f = fixture(t), router = createMcpRouter(f);
    const codex = path.join(f.homeDir, ".codex", "config.toml");
    write(codex, original);
    const res = router.autoSyncHosts();
    const out = fs.readFileSync(codex, "utf8");
    assert.equal(out, original, original);
    assert.ok(res.skippedTargets.includes(codex), original);
    assert.ok(!out.includes("[mcp_servers.t3_hub]") || original.includes("[mcp_servers.t3_hub]"), original);
  }
});

test("autoSyncHosts preserves case/underscore variants of the hub TOML table and skips array tables", t => {
  const f = fixture(t), router = createMcpRouter(f);
  const codex = path.join(f.homeDir, ".codex", "config.toml");
  const original = [
    "[mcp_servers.T3_HUB]",
    'command = "keep-uppercase"',
    "[mcp-servers.t3-hub]",
    'command = "keep-hyphen-servers"',
    "[mcp_servers.t3-hub]",
    'command = "legacy-hyphen-hub"',
    "[mcp_servers.t3_hub]",
    'command = "stale-exact-hub"',
    "[mcp_servers.t3_hub.env]",
    'TOKEN = "stale-exact-secret"',
    "[other]",
    'value = "keep"',
    "",
  ].join("\n");
  write(codex, original);
  const res = router.autoSyncHosts();
  assert.ok(res.syncedTargets.includes(codex));
  const out = fs.readFileSync(codex, "utf8");
  assert.ok(out.includes('[mcp_servers.T3_HUB]\ncommand = "keep-uppercase"'));
  assert.ok(out.includes('[mcp-servers.t3-hub]\ncommand = "keep-hyphen-servers"'));
  assert.ok(!out.includes("legacy-hyphen-hub"), "legacy lowercase [mcp_servers.t3-hub] migrated to canonical t3_hub");
  assert.ok(!out.includes("stale-exact-hub"));
  assert.ok(!out.includes("stale-exact-secret"));
  assert.ok(out.includes('[other]\nvalue = "keep"'));
  assert.equal((out.match(/\[mcp_servers\.t3_hub\]/g) || []).length, 1);
  for (const originalArray of ["[[mcp_servers]]\ncommand = \"keep-array\"\n", "[[mcp_servers.t3_hub]]\ncommand = \"keep-array-hub\"\n"]) {
    const f2 = fixture(t), router2 = createMcpRouter(f2);
    const codex2 = path.join(f2.homeDir, ".codex", "config.toml");
    write(codex2, originalArray);
    const res2 = router2.autoSyncHosts();
    assert.ok(res2.skippedTargets.includes(codex2), originalArray);
    assert.equal(fs.readFileSync(codex2, "utf8"), originalArray, originalArray);
  }
});

test("autoSyncHosts skips unmanaged MCP definitions after multiline values without touching TOML", t => {
  for (const original of [
    'arr = [\n  ["x"]\n]\nmcp_servers.t3_hub.command = "old"\n',
    'arr = [\n  ["x"]\n]\nmcp_servers = { t3_hub = { command = "old" } }\n',
    '[mcp_servers]\narr = [\n  ["x"]\n]\nt3_hub.command = "old"\n',
    'config = { nested = [\n  ["x"]\n] }\nmcp_servers.t3_hub.command = "old"\n',
  ]) {
    const f = fixture(t), router = createMcpRouter(f);
    const codex = path.join(f.homeDir, ".codex", "config.toml");
    write(codex, original);
    const result = router.autoSyncHosts();
    assert.ok(result.skippedTargets.includes(codex), original);
    assert.ok(!result.syncedTargets.includes(codex), original);
    assert.equal(fs.readFileSync(codex, "utf8"), original);
    assert.ok(!fs.existsSync(codex + ".bak-t3hub"), "skip creates no backup");
  }
});

test("autoSyncHosts replaces complete hub multiline values and preserves other nested values", t => {
  const prefix = [
    'arr = [ # unmatched delimiters in comments do not count: [ {',
    '  ["x"],',
    '  { value = "# ] } [", nested = ["y"] },',
    '  """multiline basic',
    '[mcp_servers.t3_hub]',
    'brackets ] } and an escaped quote: \\"',
    '""",',
    "  '''multiline literal",
    '[mcp_servers.t3_hub.env]',
    "brackets [ { and backslash \\",
    "''',",
    ']',
    '',
  ].join("\n");
  const suffix = '[other]\nargs = [\n  ["keep"]\n]\n';
  const hub = [
    '[mcp_servers.t3_hub]',
    'command = "old"',
    'args = [',
    '  "--foo",',
    '  ["--flag"]',
    ']',
    '[mcp_servers.t3_hub.env]',
    'config = { nested = [',
    '  ["stale"]',
    '] }',
    'text = """',
    '[other]',
    '"""',
    '',
  ].join("\n");
  for (const beforeHub of ["", prefix]) {
    const f = fixture(t), router = createMcpRouter(f);
    const codex = path.join(f.homeDir, ".codex", "config.toml");
    write(codex, beforeHub + hub + suffix);
    const result = router.autoSyncHosts();
    assert.ok(result.syncedTargets.includes(codex));
    const expected = beforeHub + suffix.trimEnd() + '\n\n[mcp_servers.t3_hub]\ncommand = ' + JSON.stringify(path.join(__dirname, "..", "bin", "t3-mcp-router")) + '\nargs = []\n';
    assert.equal(fs.readFileSync(codex, "utf8"), expected, "no removed array/table/string fragments survive");
    router.autoSyncHosts();
    assert.equal(fs.readFileSync(codex, "utf8"), expected, "sync is idempotent");
  }
});

test("autoSyncHosts skips unbalanced TOML values and malformed headers even inside replaced sections", t => {
  for (const broken of [
    'arr = [\n  ["x"]\n',
    'config = { nested = ["x"]\n',
    'arr = [\n  { key = "x" ]\n}\n',
    'arr = ["x"] ]\n',
    'config = { key = "x" } }\n',
    'text = "unclosed\n',
    "text = 'unclosed\n",
    'text = """unclosed\n',
    "text = '''unclosed\n",
    '[broken\n',
    '["unclosed]\n',
    '[valid] trailing garbage\n',
  ]) {
    for (const prefix of ["", '[mcp_servers.t3_hub]\ncommand = "old"\n']) {
      const f = fixture(t), router = createMcpRouter(f);
      const codex = path.join(f.homeDir, ".codex", "config.toml");
      const original = prefix + broken;
      write(codex, original);
      const result = router.autoSyncHosts();
      assert.ok(result.skippedTargets.includes(codex), original);
      assert.equal(fs.readFileSync(codex, "utf8"), original);
      assert.ok(!fs.existsSync(codex + ".bak-t3hub"), "skip creates no backup");
    }
  }
});
