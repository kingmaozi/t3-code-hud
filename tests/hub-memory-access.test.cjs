"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { createMemoryAccessManager } = require("../src/hub-memory-access.cjs");

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3-memory-access-")));
  const homeDir = path.join(root, "home");
  const hubDir = path.join(homeDir, ".t3", "hub");
  const userDataDir = path.join(homeDir, ".t3", "userdata");
  const routerBin = path.join(homeDir, ".t3", "bin", "t3-mcp-router");
  fs.mkdirSync(path.dirname(routerBin), { recursive: true });
  fs.writeFileSync(routerBin, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  return { root, homeDir, hubDir, userDataDir, routerBin };
}
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n");
}
function manager(f, options = {}) { return createMemoryAccessManager({ ...f, ...options }); }
function settings(f, providerInstances, extra = {}) {
  write(path.join(f.userDataDir, "settings.json"), {
    providerInstances,
    defaultModelSelection: { instanceId: Object.keys(providerInstances)[0] || "" },
    ...extra,
  });
}
async function waitFor(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return check();
}
function routerRequest(f, args, request) {
  const res = spawnSync(process.execPath, [path.join(__dirname, "..", "bin", "t3-mcp-router"), ...args], {
    input: JSON.stringify(request) + "\n",
    encoding: "utf8",
    env: { ...process.env, HOME: f.homeDir, T3_HUB_DIR: f.hubDir, T3CODE_HOME: f.userDataDir },
    timeout: 10000,
  });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  return JSON.parse(res.stdout.trim().split(/\r?\n/).at(-1));
}

test("missing access config preserves legacy-enabled read without creating files", (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const access = manager(f);
  assert.equal(access.getAgentAccess().enabled, true);
  assert.equal(access.getAgentAccess().state, "enabled");
  assert.equal(fs.existsSync(f.hubDir), false);
});

test("toggle is atomic 0600 state, unknown config fails closed, and does not delete memory", (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const memoryDir = path.join(f.hubDir, "memory"); fs.mkdirSync(memoryDir, { recursive: true });
  write(path.join(memoryDir, "keep.md"), "private memory");
  assert.equal(manager(f).setAgentAccess({ enabled: false }).ok, true);
  const config = path.join(f.hubDir, "memory-access.json");
  assert.equal(fs.statSync(config).mode & 0o777, 0o600);
  assert.equal(manager(f).getAgentAccess().state, "disabled");
  assert.equal(fs.readFileSync(path.join(memoryDir, "keep.md"), "utf8"), "private memory");
  fs.writeFileSync(config, "not-json");
  const unknown = manager(f);
  assert.equal(unknown.getAgentAccess().state, "unknown");
  assert.equal(unknown.isAccessEnabled(), false);
  assert.equal(unknown.setAgentAccess({ enabled: true }).ok, true, "an explicit human toggle can replace a malformed regular config");
  assert.equal(manager(f).getAgentAccess().state, "enabled");
});

test("access toggle refuses to follow a symlinked Hub directory", (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const elsewhere = path.join(f.root, "elsewhere"); fs.mkdirSync(elsewhere);
  fs.mkdirSync(path.dirname(f.hubDir), { recursive: true }); fs.symlinkSync(elsewhere, f.hubDir);
  assert.equal(manager(f).setAgentAccess({ enabled: false }).ok, false);
  assert.equal(fs.existsSync(path.join(elsewhere, "memory-access.json")), false);
});

test("setup adds memory-only router to supported enabled Muse provider and preserves other MCPs", (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  settings(f, { muse: { driver: "muse", enabled: true, displayName: "Muse" } });
  const target = path.join(f.homeDir, ".config", "muse", "settings.json");
  write(target, { mcpServers: { existing: { command: "keep-tool", args: ["--keep"] } } });
  const result = manager(f).setup();
  assert.equal(result.enabled, true);
  assert.deepEqual(result.changed, ["muse"]);
  const config = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.deepEqual(config.mcpServers.existing, { command: "keep-tool", args: ["--keep"] });
  assert.deepEqual(config.mcpServers.t3_hub, { command: f.routerBin, args: ["--memory-only"] });
  assert.equal(result.setupSummary.configured, 1);
});

test("Magpie-managed Codex is reported pending and never rewritten by Hub setup", (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  settings(f, {}, { fallbackModelSelection: { instanceId: "codex" } });
  const codex = path.join(f.homeDir, ".codex", "config.toml");
  write(codex, "model = 'keep'\n");
  const magpie = path.join(f.homeDir, ".config", "magpie", "library.json");
  write(magpie, { mcp: [{ name: "existing", agents: ["codex"] }], agents: ["codex"] });
  const before = fs.readFileSync(codex, "utf8");
  const result = manager(f).setup();
  assert.equal(result.setupSummary.pending, 1);
  assert.equal(result.setupSummary.providers[0].reason, "managed_by_magpie");
  assert.equal(fs.readFileSync(codex, "utf8"), before);
  assert.equal(fs.readFileSync(magpie, "utf8"), JSON.stringify({ mcp: [{ name: "existing", agents: ["codex"] }], agents: ["codex"] }, null, 2) + "\n");
});

test("existing canonical Magpie Hub MCP is recognized as configured without touching native or source files", (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  settings(f, {}, { fallbackModelSelection: { instanceId: "codex" } });
  const codex = path.join(f.homeDir, ".codex", "config.toml");
  write(codex, "model = 'keep'\n");
  const magpie = path.join(f.homeDir, ".config", "magpie", "library.json");
  write(magpie, { mcp: [{ name: "t3_hub", command: f.routerBin, args: [], agents: ["codex"] }], agents: ["codex"] });
  const nativeBefore = fs.readFileSync(codex, "utf8"), sourceBefore = fs.readFileSync(magpie, "utf8");
  const result = manager(f).getSetupSummary();
  assert.equal(result.configured, 1);
  assert.equal(result.providers[0].reason, "managed_by_magpie");
  assert.equal(fs.readFileSync(codex, "utf8"), nativeBefore);
  assert.equal(fs.readFileSync(magpie, "utf8"), sourceBefore);
});

test("custom same-name Muse MCP entry is a conflict and remains untouched", (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  settings(f, { muse: { driver: "muse", enabled: true } });
  const target = path.join(f.homeDir, ".config", "muse", "settings.json");
  write(target, { mcpServers: { t3_hub: { command: "custom-router", args: ["--user-arg"] } } });
  const before = fs.readFileSync(target, "utf8");
  const result = manager(f).setup();
  assert.equal(result.setupSummary.conflict, 1);
  assert.equal(fs.readFileSync(target, "utf8"), before);
});

test("Codex TOML adapter adds only the Hub table and preserves unrelated settings", (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  settings(f, {}, { fallbackModelSelection: { instanceId: "codex" } });
  const target = path.join(f.homeDir, ".codex", "config.toml");
  write(target, "model = 'keep-model'\n\n[mcp_servers.other]\ncommand = 'keep-tool'\nargs = ['keep-arg']\n");
  const result = manager(f).setup();
  assert.deepEqual(result.changed, ["codex"]);
  const after = fs.readFileSync(target, "utf8");
  assert.match(after, /model = 'keep-model'/);
  assert.match(after, /\[mcp_servers\.other\]\ncommand = 'keep-tool'\nargs = \['keep-arg'\]/);
  assert.ok(after.includes(`[mcp_servers.t3_hub]\ncommand = "${f.routerBin}"\nargs = ["--memory-only"]`));
  assert.equal(fs.statSync(target + ".t3hub.bak").mode & 0o777, 0o600);
});

test("built-in Codex fallback works without an override and unsafe custom Codex homes fail closed", (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  settings(f, {}, { fallbackModelSelection: { instanceId: "codex" } });
  const codex = path.join(f.homeDir, ".codex", "config.toml");
  write(codex, "model = 'default'\n");
  const result = manager(f).setup();
  assert.deepEqual(result.changed, ["codex"]);

  settings(f, { codex: { driver: "codex", enabled: true, config: { homePath: path.join(f.root, "elsewhere") } } });
  const summary = manager(f).getSetupSummary();
  assert.equal(summary.unknown, 1);
  assert.equal(summary.providers[0].reason, "codex_home_outside_home");
  assert.equal(fs.existsSync(path.join(f.root, "elsewhere", "config.toml")), false);
});

test("AGY onboarding only writes the existing settings-selected profile", (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  settings(f, { agyWork: { driver: "antigravity", enabled: true, displayName: "AGY Work" } });
  const profile = crypto.createHash("sha256").update("agyWork").digest("hex");
  const target = path.join(f.userDataDir, "providers", "antigravity", profile, "config", "mcp_config.json");
  write(target, { mcpServers: { existing: { command: "other", args: [] } } });
  const result = manager(f).setup();
  assert.deepEqual(result.changed, ["agyWork"]);
  const config = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.deepEqual(config.mcpServers.existing, { command: "other", args: [] });
  assert.deepEqual(config.mcpServers.t3_hub, { command: f.routerBin, args: ["--memory-only"] });
});

test("persisted opt-in watches T3 provider settings once and stops watching after disable", async (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  fs.mkdirSync(f.userDataDir, { recursive: true });
  const museConfig = path.join(f.homeDir, ".config", "muse", "settings.json");
  write(museConfig, { mcpServers: {} });
  write(path.join(f.userDataDir, "settings.json"), { providerInstances: {} });
  const access = manager(f);
  t.after(() => access.stopWatching());
  assert.equal(access.setup().enabled, true);
  assert.equal(access.startWatching().started, true);
  settings(f, { muse: { driver: "muse", enabled: true } });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(JSON.parse(fs.readFileSync(museConfig, "utf8")).mcpServers.t3_hub, { command: f.routerBin, args: ["--memory-only"] });
  assert.equal(access.setAgentAccess({ enabled: false }).state, "disabled");
  const codexConfig = path.join(f.homeDir, ".codex", "config.toml");
  settings(f, { muse: { driver: "muse", enabled: true }, codex: { driver: "codex", enabled: true } });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(fs.existsSync(codexConfig), false);
});

test("provider watcher reconnects an AGY profile that appears after the provider setting", async (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  fs.mkdirSync(f.userDataDir, { recursive: true });
  settings(f, { agyLater: { driver: "antigravity", enabled: true } });
  const access = manager(f);
  t.after(() => access.stopWatching());
  const initial = access.setup();
  assert.equal(initial.setupSummary.pending, 1);
  assert.equal(access.startWatching().started, true);
  const profile = crypto.createHash("sha256").update("agyLater").digest("hex");
  const config = path.join(f.userDataDir, "providers", "antigravity", profile, "config", "mcp_config.json");
  write(config, { mcpServers: { existing: { command: "known", args: [] } } });
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.deepEqual(JSON.parse(fs.readFileSync(config, "utf8")).mcpServers.t3_hub, { command: f.routerBin, args: ["--memory-only"] });
});

test("empty AGY MCP profile stays pending to preserve native helper compatibility", (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  settings(f, { agyEmpty: { driver: "antigravity", enabled: true } });
  const profile = crypto.createHash("sha256").update("agyEmpty").digest("hex");
  const target = path.join(f.userDataDir, "providers", "antigravity", profile, "config", "mcp_config.json");
  write(target, { mcpServers: {} });
  const before = fs.readFileSync(target, "utf8");
  const result = manager(f).setup();
  assert.equal(result.setupSummary.pending, 1);
  assert.equal(result.setupSummary.providers[0].reason, "agy_native_helper_compatibility");
  assert.equal(fs.readFileSync(target, "utf8"), before);
});

test("AGY servers alias is treated as an unknown schema and left untouched", (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  settings(f, { agyLegacy: { driver: "antigravity", enabled: true } });
  const profile = crypto.createHash("sha256").update("agyLegacy").digest("hex");
  const target = path.join(f.userDataDir, "providers", "antigravity", profile, "config", "mcp_config.json");
  write(target, { servers: { existing: { command: "keep-tool", args: ["--keep"] } } });
  const before = fs.readFileSync(target, "utf8");
  const result = manager(f).setup();
  assert.equal(result.setupSummary.unknown, 1);
  assert.equal(result.setupSummary.providers[0].reason, "agy_mcp_schema_unsupported");
  assert.equal(fs.readFileSync(target, "utf8"), before);
});

test("memory-only MCP exposes only gated memory and plan tools without upstream discovery", (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  write(path.join(f.hubDir, "memory-access.json"), { version: 1, enabled: false });
  write(path.join(f.hubDir, "mcp-registry.json"), [{ name: "should_not_connect", mode: "global-direct", command: "/no/such/upstream", args: [] }]);
  const list = routerRequest(f, ["--memory-only"], { jsonrpc: "2.0", id: 1, method: "tools/list" });
  const names = list.result.tools.map((tool) => tool.name);
  assert.deepEqual(names.sort(), ["memory_status", "plan_update"]);
  const status = routerRequest(f, ["--memory-only"], { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory_status", arguments: {} } });
  const body = JSON.parse(status.result.content[0].text);
  assert.equal(body.enabled, false);
  assert.equal(body.vaultAvailable, false);
  assert.equal(fs.existsSync(path.join(f.hubDir, "memory")), false);
});

test("memory status stays read-only even with legacy-enabled access and no existing vault", (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const status = routerRequest(f, ["--memory-only"], { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_status", arguments: {} } });
  const body = JSON.parse(status.result.content[0].text);
  assert.equal(body.enabled, true);
  assert.equal(body.state, "enabled");
  assert.equal(body.vaultAvailable, false);
  assert.equal(fs.existsSync(path.join(f.hubDir, "memory")), false);
});

test("full router hides and rejects Agent memory tools when access is off", (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  write(path.join(f.hubDir, "memory-access.json"), { version: 1, enabled: false });
  const list = routerRequest(f, [], { jsonrpc: "2.0", id: 1, method: "tools/list" });
  const names = list.result.tools.map((tool) => tool.name);
  assert.ok(names.includes("memory_status"));
  assert.ok(names.includes("plan_update"));
  assert.ok(!names.includes("memory_search"));
  assert.ok(!names.includes("context_search"));
  const denied = routerRequest(f, [], { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory_search", arguments: { query: "no database read" } } });
  assert.match(denied.error.message, /disabled or unavailable/);
  assert.equal(fs.existsSync(path.join(f.hubDir, "memory")), false);
});

test("memory setup CLI accepts only fixed operations and prints a path-free summary", async (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const cli = await import("../scripts/memory-setup.mjs");
  let stdout = "", stderr = "";
  const code = await cli.main({ argv: ["status"], stdout: (value) => { stdout += value; }, stderr: (value) => { stderr += value; }, manager: manager(f) });
  assert.equal(code, 0, stderr);
  const status = JSON.parse(stdout);
  assert.equal(status.enabled, true);
  assert.equal(JSON.stringify(status).includes(f.homeDir), false);
  stdout = "";
  assert.equal(await cli.main({ argv: ["setup", "--home-dir", f.homeDir], stdout: (value) => { stdout += value; }, stderr: () => {}, manager: manager(f) }), 2);
});

test("pc-lite exits before constructing or invoking a vault when agent access is off", async (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  write(path.join(f.hubDir, "memory-access.json"), { version: 1, enabled: false });
  const beforeHome = process.env.HOME;
  const beforeHub = process.env.T3_HUB_DIR;
  const beforeUserData = process.env.T3CODE_HOME;
  process.env.HOME = f.homeDir;
  process.env.T3_HUB_DIR = f.hubDir;
  process.env.T3CODE_HOME = f.userDataDir;
  try {
    const cli = await import("../scripts/pc-lite.mjs");
    let called = false;
    const code = await cli.main({ argv: ["ensure"], vault: { ensureProject() { called = true; return { ok: true }; } }, stderr: () => {} });
    assert.equal(code, 1);
    assert.equal(called, false);
    assert.equal(fs.existsSync(path.join(f.hubDir, "memory")), false);
  } finally {
    if (beforeHome === undefined) delete process.env.HOME; else process.env.HOME = beforeHome;
    if (beforeHub === undefined) delete process.env.T3_HUB_DIR; else process.env.T3_HUB_DIR = beforeHub;
    if (beforeUserData === undefined) delete process.env.T3CODE_HOME; else process.env.T3CODE_HOME = beforeUserData;
  }
});

test("stop hook is silent and does not create a reminder while access is off", (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  write(path.join(f.hubDir, "memory-access.json"), { version: 1, enabled: false });
  const result = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "memory-stop-hook.mjs")], {
    input: JSON.stringify({ cwd: process.cwd(), session_id: "isolated-stop-hook" }),
    encoding: "utf8",
    env: { ...process.env, HOME: f.homeDir, T3_HUB_DIR: f.hubDir },
    timeout: 10000,
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(fs.existsSync(path.join(f.hubDir, "run")), false);
});

test("backend get/set RPC uses the same persisted access state", async (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const previous = Object.fromEntries(["NODE_ENV", "HOME", "T3_HUB_DIR", "T3CODE_HOME"].map((key) => [key, process.env[key]]));
  process.env.NODE_ENV = "test";
  process.env.HOME = f.homeDir;
  process.env.T3_HUB_DIR = f.hubDir;
  process.env.T3CODE_HOME = f.userDataDir;
  let backend;
  try {
    backend = require("../src/backend.cjs");
    const initial = await backend.hubCall("memory:agentAccess:get");
    assert.equal(initial.enabled, true);
    const disabled = await backend.hubCall("memory:agentAccess:set", { enabled: false });
    assert.equal(disabled.state, "disabled");
    const readback = await backend.hubCall("memory:agentAccess:get");
    assert.equal(readback.enabled, false);
  } finally {
    try { globalThis[Symbol.for("t3.hud.memory.agent-access.v1")]?.stopWatching?.(); } catch {}
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test("running disabled sidecar sees CLI enable and watches providers added afterward", async (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  settings(f, {});
  const museConfig = path.join(f.homeDir, ".config", "muse", "settings.json");
  write(museConfig, { mcpServers: {} });
  manager(f).setAgentAccess({ enabled: false });
  const sidecar = manager(f);
  t.after(() => sidecar.stopWatching());
  const initial = sidecar.startWatching();
  assert.equal(initial.started, false);
  assert.equal(initial.accessWatcherStarted, true, "the disabled sidecar must still watch only the access flag");

  const runSetup = (command) => spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "memory-setup.mjs"), command], {
      encoding: "utf8",
      env: { ...process.env, HOME: f.homeDir, T3_HUB_DIR: f.hubDir, T3CODE_HOME: f.userDataDir },
      timeout: 10000,
    });
  const enabled = runSetup("enable");
  assert.equal(enabled.status, 0, enabled.stderr || enabled.stdout);
  assert.equal(await waitFor(() => sidecar.getAccessState().state === "enabled"), true);
  const disabled = runSetup("disable");
  assert.equal(disabled.status, 0, disabled.stderr || disabled.stdout);
  settings(f, { muse: { driver: "muse", enabled: true } });
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(JSON.parse(fs.readFileSync(museConfig, "utf8")).mcpServers.t3_hub, undefined,
    "provider changes while disabled must not be connected");
  const reenabled = runSetup("enable");
  assert.equal(reenabled.status, 0, reenabled.stderr || reenabled.stdout);
  assert.equal(await waitFor(() => {
    try { return Boolean(JSON.parse(fs.readFileSync(museConfig, "utf8")).mcpServers.t3_hub); } catch { return false; }
  }), true, "sidecar should restart provider watching after the CLI enables access");

  settings(f, {
    muse: { driver: "muse", enabled: true },
    agyLater: { driver: "antigravity", enabled: true },
  });
  const profile = crypto.createHash("sha256").update("agyLater").digest("hex");
  const agyConfig = path.join(f.userDataDir, "providers", "antigravity", profile, "config", "mcp_config.json");
  write(agyConfig, { mcpServers: { existing: { command: "keep-tool", args: [] } } });
  assert.equal(await waitFor(() => {
    try { return Boolean(JSON.parse(fs.readFileSync(agyConfig, "utf8")).mcpServers.t3_hub); } catch { return false; }
  }), true, "a provider added after the CLI operation should be detected by the running sidecar");
  assert.deepEqual(JSON.parse(fs.readFileSync(agyConfig, "utf8")).mcpServers.existing, { command: "keep-tool", args: [] });
});

test("enabled watcher recovers when T3 userdata and a provider config directory appear later", async (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const access = manager(f, { watcherPollMs: 40 });
  access.setAgentAccess({ enabled: true });
  t.after(() => access.stopWatching());
  assert.equal(fs.existsSync(f.userDataDir), false);
  assert.equal(access.startWatching().started, true, "watching a trusted ancestor should cover a not-yet-created userdata directory");

  settings(f, { muse: { driver: "muse", enabled: true } });
  const museConfig = path.join(f.homeDir, ".config", "muse", "settings.json");
  fs.mkdirSync(path.dirname(museConfig), { recursive: true });
  write(museConfig, { mcpServers: {} });
  assert.equal(await waitFor(() => {
    try { return Boolean(JSON.parse(fs.readFileSync(museConfig, "utf8")).mcpServers.t3_hub); } catch { return false; }
  }), true, "watching should recover through both missing directory layers and attach the provider: " + JSON.stringify(manager(f).getSetupSummary()));
});

test("manager keeps the provider watcher active after setup reports a provider conflict", async (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  settings(f, {
    museConflict: { driver: "muse", enabled: true },
    agyLater: { driver: "antigravity", enabled: true },
  });
  const museConfig = path.join(f.homeDir, ".config", "muse", "settings.json");
  write(museConfig, { mcpServers: { t3_hub: { command: "custom-muse-router", args: ["--custom"] } } });
  const access = manager(f, { watcherPollMs: 40 });
  t.after(() => access.stopWatching());
  const setup = access.setup();
  assert.equal(setup.enabled, true);
  assert.equal(setup.ok, false, "the existing Muse conflict should keep setup incomplete");
  assert.equal(setup.setupSummary.conflict, 1);
  assert.equal(setup.setupSummary.pending, 1);
  assert.equal(access.startWatching().started, true, "provider status must not gate the watcher");

  const profile = crypto.createHash("sha256").update("agyLater").digest("hex");
  const agyConfig = path.join(f.userDataDir, "providers", "antigravity", profile, "config", "mcp_config.json");
  write(agyConfig, { mcpServers: { existing: { command: "keep-tool", args: [] } } });
  assert.equal(await waitFor(() => {
    try { return Boolean(JSON.parse(fs.readFileSync(agyConfig, "utf8")).mcpServers.t3_hub); } catch { return false; }
  }), true, "enabled access must keep the watcher active despite the unrelated conflict: " + JSON.stringify(manager(f).getSetupSummary()));
});

test("backend starts watcher after setup even when another provider conflicts", async (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  settings(f, {
    museConflict: { driver: "muse", enabled: true },
    agyLater: { driver: "antigravity", enabled: true },
  });
  const museConfig = path.join(f.homeDir, ".config", "muse", "settings.json");
  write(museConfig, { mcpServers: { t3_hub: { command: "custom-muse-router", args: ["--custom"] } } });
  write(path.join(f.hubDir, "memory-access.json"), { version: 1, enabled: false });

  const envKeys = ["NODE_ENV", "T3_HUB_TEST", "UNDER_TEST", "HOME", "T3_HUB_DIR", "T3CODE_HOME"];
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  for (const key of ["NODE_ENV", "T3_HUB_TEST", "UNDER_TEST"]) delete process.env[key];
  process.env.HOME = f.homeDir;
  process.env.T3_HUB_DIR = f.hubDir;
  process.env.T3CODE_HOME = f.userDataDir;
  let runtime;
  let originalStartWatching;
  try {
    const backend = require("../src/backend.cjs");
    await backend.hubCall("memory:agentAccess:get");
    runtime = globalThis[Symbol.for("t3.hud.memory.agent-access.v1")];
    originalStartWatching = runtime.startWatching;
    const startWatching = originalStartWatching.bind(runtime);
    let startCalls = 0;
    let startResult = null;
    runtime.startWatching = (...args) => { startCalls += 1; startResult = startWatching(...args); return startResult; };
    const setup = await backend.hubCall("memory:setup");
    assert.equal(setup.enabled, true);
    assert.equal(setup.ok, false, "the existing Muse conflict should keep setup incomplete");
    assert.equal(setup.setupSummary.conflict, 1);
    assert.equal(setup.setupSummary.pending, 1);
    assert.equal(startCalls, 1, "backend must start its watcher regardless of setup result.ok");
    assert.equal(startResult?.started, true);
  } finally {
    if (runtime && originalStartWatching) runtime.startWatching = originalStartWatching;
    try { globalThis[Symbol.for("t3.hud.memory.agent-access.v1")]?.stopWatching?.(); } catch {}
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test("nonboolean JSON/TOML router toggle fields stay unknown and are never rewritten", (t) => {
  const muse = fixture(); t.after(() => fs.rmSync(muse.root, { recursive: true, force: true }));
  settings(muse, { muse: { driver: "muse", enabled: true } });
  const museConfig = path.join(muse.homeDir, ".config", "muse", "settings.json");
  write(museConfig, { mcpServers: { t3_hub: { command: muse.routerBin, args: ["--memory-only"], enabled: "false" } } });
  const museBefore = fs.readFileSync(museConfig, "utf8");
  const museResult = manager(muse).setup();
  assert.equal(museResult.setupSummary.unknown, 1);
  assert.equal(museResult.setupSummary.providers[0].reason, "hub_entry_toggle_invalid");
  assert.equal(fs.readFileSync(museConfig, "utf8"), museBefore);

  const codex = fixture(); t.after(() => fs.rmSync(codex.root, { recursive: true, force: true }));
  settings(codex, {}, { fallbackModelSelection: { instanceId: "codex" } });
  write(path.join(codex.homeDir, ".config", "magpie", "library.json"), { mcp: [] });
  const codexConfig = path.join(codex.homeDir, ".codex", "config.toml");
  write(codexConfig, `[mcp_servers.t3_hub]\ncommand = ${JSON.stringify(codex.routerBin)}\nargs = ["--memory-only"]\ndisabled = "false"\n`);
  const codexBefore = fs.readFileSync(codexConfig, "utf8");
  const codexResult = manager(codex).setup();
  assert.equal(codexResult.setupSummary.unknown, 1);
  assert.equal(codexResult.setupSummary.providers[0].reason, "hub_entry_toggle_invalid");
  assert.equal(fs.readFileSync(codexConfig, "utf8"), codexBefore);
});
