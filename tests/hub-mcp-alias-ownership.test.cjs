"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createMcpRouter } = require("../src/mcp-router.cjs");

function fixture(t) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-mcp-alias-ownership-"));
  const hubDir = path.join(homeDir, "hub"), projectRoot = path.join(homeDir, "project");
  fs.mkdirSync(projectRoot, { recursive: true });
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  return { homeDir, hubDir, projectRoot, router: createMcpRouter({ homeDir, hubDir }) };
}
function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
}
function plugin(f, id, name, command) {
  const root = path.join(f.hubDir, "plugins", id);
  write(path.join(root, ".claude-plugin", "plugin.json"), { name: id, version: "1.0.0" });
  write(path.join(root, ".mcp.json"), { mcpServers: { [name]: { command } } });
  return { name, command };
}
const normalized = name => name.toLowerCase().replace(/_/g, "-");
const matching = (r, name, projectRoot) => r.listMcpServers({ projectRoot }).items.filter(s => normalized(s.name) === normalized(name));

test("a plugin alias cannot turn an independent registry server off or replace its endpoint", t => {
  const f = fixture(t), r = f.router;
  r.upsertMcpServer({ name: "shared_mcp", command: "/user/endpoint", args: ["--user-owned"] });
  r.setMcpMode({ name: "shared_mcp", mode: "global-lazy" });
  const registryBefore = fs.readFileSync(r.registryPath, "utf8");
  const modesBefore = JSON.parse(fs.readFileSync(r.statePath)).mcpModes;
  const bundled = plugin(f, "collision", "shared-mcp", "/plugin/endpoint");
  for (const scope of ["global", "project", "off"]) {
    const result = r.setPluginMcpScope({ pluginId: "collision", servers: [bundled], scope, projectRoot: f.projectRoot });
    if (scope !== "off") assert.deepEqual(result.skippedMcps, ["shared-mcp"]);
    assert.equal(fs.readFileSync(r.registryPath, "utf8"), registryBefore);
    assert.deepEqual(JSON.parse(fs.readFileSync(r.statePath)).mcpModes, modesBefore);
    const rows = matching(r, "shared_mcp", f.projectRoot);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, "shared_mcp"); assert.equal(rows[0].command, "/user/endpoint");
    assert.equal(rows[0].pluginId, null); assert.equal(rows[0].mode, "global-lazy"); assert.equal(rows[0].modeConflict, false);
  }
});

test("a native definition is found even when a plugin alias appears first", t => {
  const f = fixture(t), r = f.router, bundled = plugin(f, "collision", "host-mcp", "/plugin/endpoint");
  const host = path.join(f.homeDir, ".claude", "mcp.json");
  write(host, { mcpServers: { host_mcp: { command: "/user/host-endpoint" } } });
  const before = fs.readFileSync(host, "utf8");
  const result = r.setPluginMcpScope({ pluginId: "collision", servers: [bundled], scope: "global" });
  assert.deepEqual(result.skippedMcps, ["host-mcp"]);
  assert.equal(fs.readFileSync(host, "utf8"), before);
  assert.ok(!fs.existsSync(r.registryPath));
  const rows = matching(r, "host_mcp");
  assert.equal(rows.length, 1); assert.equal(rows[0].name, "host_mcp");
  assert.equal(rows[0].command, "/user/host-endpoint"); assert.equal(rows[0].pluginId, null);
  assert.equal(rows[0].modeConflict, false);
});

test("two independent normalized definitions remain visible and fail closed", t => {
  const f = fixture(t), r = f.router;
  const host = path.join(f.homeDir, ".claude", "mcp.json");
  write(host, { mcpServers: { echo_server: { command: "/user/one" }, "echo-server": { command: "/user/two" } } });
  write(r.statePath, { mcpModes: { global: { echo_server: "global-lazy" }, projects: {} } });
  const beforeHost = fs.readFileSync(host, "utf8"), beforeState = fs.readFileSync(r.statePath, "utf8");
  plugin(f, "third", "ECHO-SERVER", "/plugin/endpoint");
  const rows = matching(r, "echo-server");
  assert.deepEqual(rows.map(s => s.name).sort(), ["echo-server", "echo_server"]);
  assert.ok(rows.every(s => s.modeConflict && s.mode === "off" && !s.enabled));
  assert.throws(() => r.setMcpMode({ name: "echo_server", mode: "global-direct" }), /normalized MCP name conflict/);
  assert.throws(() => r.toggleServerForAgent({ name: "echo_server", agent: "codex", enabled: true }), /normalized MCP name conflict/);
  assert.equal(fs.readFileSync(host, "utf8"), beforeHost); assert.equal(fs.readFileSync(r.statePath, "utf8"), beforeState);
});

test("probe results use the same cache entry for a project symlink and its real path", async t => {
  const f = fixture(t), r = f.router, alias = path.join(f.homeDir, "project-link");
  fs.symlinkSync(f.projectRoot, alias, "dir");
  const mock = path.join(f.projectRoot, "mock-mcp.js");
  fs.writeFileSync(mock, `process.stdin.on('data', data => {
    const request = JSON.parse(String(data));
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
      protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fixture', version: '1.0.0' }
    } }) + '\\n');
  });`);
  r.upsertMcpServer({ name: "probe-fixture", command: process.execPath, args: [mock] });
  const result = await r.probeMcpServers({ name: "probe-fixture", projectRoot: alias, timeoutMs: 3000 });
  assert.equal(result.results["probe-fixture"].connected, true, "the isolated mock must complete MCP initialization");
  for (const projectRoot of [alias, fs.realpathSync(f.projectRoot)]) {
    const row = r.listMcpServers({ projectRoot }).items.find(item => item.name === "probe-fixture");
    assert.equal(row.connected, true); assert.equal(row.probed, true);
  }
});

test("relative parent cwd is resolved from the real project, matching its probe cache", async t => {
  const f = fixture(t), r = f.router, parent = path.join(f.homeDir, "real-parent"), project = path.join(parent, "project"), alias = path.join(f.homeDir, "project-link");
  fs.mkdirSync(project, { recursive: true }); fs.symlinkSync(project, alias, "dir");
  const decoy = path.join(f.homeDir, "fixture"), actual = path.join(parent, "fixture");
  const mock = `process.stdin.on('data', data => { const request = JSON.parse(String(data)); process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fixture', version: '1.0.0' } } }) + '\\n'); });`;
  fs.mkdirSync(decoy); fs.writeFileSync(path.join(decoy, "mock.js"), mock);
  r.upsertMcpServer({ name: "relative-cwd", command: process.execPath, args: ["mock.js"], cwd: "../fixture" });
  const first = await r.probeMcpServers({ name: "relative-cwd", projectRoot: alias, timeoutMs: 3000 });
  assert.equal(first.results["relative-cwd"].connected, false, "the unrelated directory beside the symlink must not be used");
  assert.equal(r.listMcpServers({ projectRoot: project }).items.find(item => item.name === "relative-cwd").connected, false);
  fs.mkdirSync(actual); fs.writeFileSync(path.join(actual, "mock.js"), mock);
  const second = await r.probeMcpServers({ name: "relative-cwd", projectRoot: alias, timeoutMs: 3000 });
  assert.equal(second.results["relative-cwd"].connected, true);
  assert.equal(r.listMcpServers({ projectRoot: project }).items.find(item => item.name === "relative-cwd").connected, true);
});

test("plugin scope and plugin upsert never overwrite damaged registry data", t => {
  for (const contents of ["{corrupted registry", '{"servers":"not-an-array"}', '[{"name":""}]']) {
    const f = fixture(t), r = f.router;
    fs.mkdirSync(path.dirname(r.registryPath), { recursive: true });
    fs.writeFileSync(r.registryPath, contents);
    write(r.statePath, { pluginScopes: { other: "global" }, mcpModes: { global: { keep: "global-lazy" }, projects: {} } });
    const stateBefore = fs.readFileSync(r.statePath, "utf8");
    for (const action of [
      () => r.setPluginMcpScope({ pluginId: "demo", servers: [{ name: "demo-server", command: "/bin/true" }], scope: "global" }),
      () => r.upsertMcpServer({ name: "demo-server", command: "/bin/true", pluginId: "demo" }),
    ]) {
      assert.throws(action, /registry|mcp-registry|malformed|invalid|corrupt/i);
      assert.equal(fs.readFileSync(r.registryPath, "utf8"), contents);
      assert.equal(fs.readFileSync(r.statePath, "utf8"), stateBefore);
    }
  }
});

test("plugin writes reject malformed shared state before changing either file", t => {
  const invalid = ["{broken", "null", "[]", '"text"', '{"mcpModes":[]}', '{"mcpModes":{"global":{"demo":[]}}}', '{"mcpModes":{"projects":{"/project":[]}}}', '{"pluginMcpOwned":{"demo":[{"name":"demo-server","projects":[]}]}}', '{"pluginMcpOwned":{"demo":[{"name":"demo-server","global":{}}]}}', '{"pluginMcpOwned":{"demo":[{"name":"demo-server","projects":{"/project":[]}}]}}', '{"pluginScopes":[]}'];
  for (const contents of invalid) {
    const f = fixture(t), r = f.router;
    write(r.registryPath, [{ name: "user", command: "/user/endpoint" }]);
    fs.writeFileSync(r.statePath, contents);
    const before = fs.readFileSync(r.registryPath, "utf8");
    for (const action of [
      () => r.setPluginMcpScope({ pluginId: "demo", servers: [{ name: "demo-server", command: "/bin/true" }], scope: "global" }),
      () => r.upsertMcpServer({ name: "demo-server", command: "/bin/true", pluginId: "demo" }),
    ]) {
      assert.throws(action, /state|malformed|invalid|unreadable/i);
      assert.equal(fs.readFileSync(r.statePath, "utf8"), contents);
      assert.equal(fs.readFileSync(r.registryPath, "utf8"), before);
    }
  }
});

test("plugin writes refuse an unreadable registry or state without changing the other file", t => {
  if (typeof process.getuid === "function" && process.getuid() === 0) return;
  for (const damaged of ["registry", "state"]) {
    const f = fixture(t), r = f.router;
    write(r.registryPath, [{ name: "user", command: "/user/endpoint" }]);
    write(r.statePath, { mcpModes: { global: {}, projects: {} } });
    const registryBefore = fs.readFileSync(r.registryPath, "utf8"), stateBefore = fs.readFileSync(r.statePath, "utf8");
    const file = damaged === "registry" ? r.registryPath : r.statePath;
    fs.chmodSync(file, 0);
    try {
      for (const action of [
        () => r.setPluginMcpScope({ pluginId: "demo", servers: [{ name: "demo-server", command: "/bin/true" }], scope: "global" }),
        () => r.upsertMcpServer({ name: "demo-server", command: "/bin/true", pluginId: "demo" }),
      ]) assert.throws(action, /unreadable|EACCES|permission/i);
    } finally { fs.chmodSync(file, 0o600); }
    assert.equal(fs.readFileSync(r.registryPath, "utf8"), registryBefore);
    assert.equal(fs.readFileSync(r.statePath, "utf8"), stateBefore);
  }
});
