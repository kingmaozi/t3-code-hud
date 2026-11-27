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

test("toggling Hub Memory preserves an independently configured PowerContext MCP", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  settings(f, { muse: { driver: "muse", enabled: true } });
  const target = path.join(f.homeDir, ".config", "muse", "settings.json");
  const powerContext = { command: "/fixtures/powercontext", args: ["mcp"], env: { MEMORY_DIR: "/fixtures/pc-data" } };
  const original = { mcpServers: { powercontext: powerContext } };
  write(target, original);
  const access = manager(f);

  assert.equal(access.setAgentAccess({ enabled: false }).state, "disabled");
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), original);
  assert.equal(access.setAgentAccess({ enabled: true }).state, "enabled");
  const connected = fs.readFileSync(target, "utf8");
  assert.deepEqual(JSON.parse(connected).mcpServers, {
    powercontext: powerContext,
    t3_hub: { command: f.routerBin, args: ["--memory-only"] },
  });
  assert.equal(access.setAgentAccess({ enabled: false }).state, "disabled");
  const response = routerRequest(f, ["--memory-only"], { jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.deepEqual(response.result.tools.map((tool) => tool.name).sort(), ["memory_status", "plan_update"]);
  assert.equal(fs.readFileSync(target, "utf8"), connected);
  assert.equal(access.setAgentAccess({ enabled: true }).state, "enabled");
  assert.equal(fs.readFileSync(target, "utf8"), connected);
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
  assert.equal(await waitFor(() => Boolean(JSON.parse(fs.readFileSync(museConfig, "utf8")).mcpServers.t3_hub)), true);
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
  assert.equal(await waitFor(() => Boolean(JSON.parse(fs.readFileSync(config, "utf8")).mcpServers.t3_hub)), true);
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

test("OpenCode and Devin recognize portable shell-wrapper MCP entries and setup safely preserves sibling keys", (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  settings(f, {
    opencode: { driver: "opencode", enabled: true, displayName: "OpenCode" },
    acpRegistry_devin: { driver: "acpRegistry", enabled: true, displayName: "Devin", config: { agentId: "devin" } },
    acpRegistry_other: { driver: "acpRegistry", enabled: true, displayName: "Other ACP", config: { agentId: "other-cli" } },
  });
  const opencodeConfig = path.join(f.homeDir, ".config", "opencode", "opencode.json");
  const devinConfig = path.join(f.homeDir, ".config", "devin", "mcp_config.json");
  write(opencodeConfig, {
    model: "keep-model",
    mcp: {
      existing: { type: "local", command: ["keep-mcp"], enabled: true },
      t3_hub: { type: "local", command: ["/bin/sh", "-c", 'exec "$HOME/.t3/bin/t3-mcp-router" --memory-only'], enabled: true },
    },
  });
  write(devinConfig, {
    mcpServers: {
      existing: { command: "keep-devin-mcp", args: [] },
      t3_hub: { command: "/bin/sh", args: ["-c", 'exec "$HOME/.t3/bin/t3-mcp-router" --memory-only'] },
    },
  });

  const summary = manager(f).getSetupSummary();
  assert.equal(summary.configured, 2);
  assert.equal(summary.unsupported, 1);
  assert.equal(summary.providers.find((p) => p.instanceId === "opencode").status, "configured");
  assert.equal(summary.providers.find((p) => p.instanceId === "opencode").reason, "router_memory_only");
  assert.equal(summary.providers.find((p) => p.instanceId === "acpRegistry_devin").status, "configured");
  assert.equal(summary.providers.find((p) => p.instanceId === "acpRegistry_devin").reason, "router_memory_only");
  assert.equal(summary.providers.find((p) => p.instanceId === "acpRegistry_other").status, "unsupported");

  // Shell injection in /bin/sh -c must be flagged as conflict, never configured
  write(devinConfig, {
    mcpServers: {
      t3_hub: { command: "/bin/sh", args: ["-c", 'exec "$HOME/.t3/bin/t3-mcp-router" --memory-only; id'] },
    },
  });
  assert.equal(manager(f).getSetupSummary().providers.find((p) => p.instanceId === "acpRegistry_devin").status, "conflict");

  // Missing OpenCode and Devin entries are written cleanly without clobbering other entries
  write(opencodeConfig, { model: "keep-model", mcp: { existing: { type: "local", command: ["keep-mcp"], enabled: true } } });
  write(devinConfig, { mcpServers: { existing: { command: "keep-devin-mcp", args: [] } } });
  const setupRes = manager(f).setup();
  assert.deepEqual(setupRes.changed.sort(), ["acpRegistry_devin", "opencode"]);
  const ocAfter = JSON.parse(fs.readFileSync(opencodeConfig, "utf8"));
  assert.equal(ocAfter.model, "keep-model");
  assert.deepEqual(ocAfter.mcp.existing, { type: "local", command: ["keep-mcp"], enabled: true });
  assert.deepEqual(ocAfter.mcp.t3_hub, { type: "local", command: [f.routerBin, "--memory-only"], enabled: true });
  const dvAfter = JSON.parse(fs.readFileSync(devinConfig, "utf8"));
  assert.deepEqual(dvAfter.mcpServers.existing, { command: "keep-devin-mcp", args: [] });
  assert.deepEqual(dvAfter.mcpServers.t3_hub, { command: f.routerBin, args: ["--memory-only"] });

  // OpenCode using opencode.jsonc without opencode.json stays pending instead of creating a duplicate opencode.json
  fs.rmSync(opencodeConfig, { force: true });
  write(path.join(f.homeDir, ".config", "opencode", "opencode.jsonc"), '// comment\n{ "mcp": {} }\n');
  const jsoncSummary = manager(f).setup();
  assert.equal(jsoncSummary.setupSummary.providers.find((p) => p.instanceId === "opencode").status, "pending");
  assert.equal(jsoncSummary.setupSummary.providers.find((p) => p.instanceId === "opencode").reason, "opencode_jsonc_manual");
  assert.equal(fs.existsSync(opencodeConfig), false, "must not create sibling opencode.json when opencode.jsonc is in use");
});

test("claudeAgent default ~/.claude.json onboarding preserves unrelated top-level keys, creates 0600 backup, and reads back configured", (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  settings(f, { claudeAgent: { driver: "claudeAgent", enabled: true, displayName: "Claude Agent" } });
  const target = path.join(f.homeDir, ".claude.json");
  const original = {
    oauthAccount: { emailAddress: "user@example.test", accountUuid: "acct-1" },
    userID: "user-123",
    projects: { "/workspace/demo": { allowedTools: ["Read"] } },
    servers: { unrelatedTopLevel: true },
    mcpServers: {
      other_tool: { type: "stdio", command: "keep-mcp", args: ["--flag"], env: { TOKEN: "keep" } },
    },
  };
  write(target, original);
  fs.chmodSync(target, 0o600);

  const beforeSummary = manager(f).getSetupSummary();
  assert.equal(beforeSummary.missing, 1);
  assert.equal(beforeSummary.providers[0].status, "missing");
  assert.equal(beforeSummary.providers[0].reason, "entry_missing");

  const result = manager(f).setup();
  assert.equal(result.ok, true);
  assert.deepEqual(result.changed, ["claudeAgent"]);
  assert.equal(result.setupSummary.configured, 1);
  assert.equal(result.setupSummary.providers[0].status, "configured");
  assert.equal(result.setupSummary.providers[0].reason, "router_memory_only");

  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.equal(fs.statSync(target + ".t3hub.bak").mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(target + ".t3hub.bak", "utf8")), original);

  const after = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.deepEqual(after.oauthAccount, original.oauthAccount);
  assert.equal(after.userID, original.userID);
  assert.deepEqual(after.projects, original.projects);
  assert.deepEqual(after.servers, original.servers);
  assert.deepEqual(after.mcpServers.other_tool, original.mcpServers.other_tool);
  assert.deepEqual(after.mcpServers.t3_hub, { type: "stdio", command: f.routerBin, args: ["--memory-only"] });

  // Also works when ~/.claude.json does not exist yet and with driver alias "claude"
  const fresh = fixture(); t.after(() => fs.rmSync(fresh.root, { recursive: true, force: true }));
  settings(fresh, { claude: { driver: "claude", enabled: true, displayName: "Claude" } });
  const freshTarget = path.join(fresh.homeDir, ".claude.json");
  assert.equal(fs.existsSync(freshTarget), false);
  const freshRes = manager(fresh).setup();
  assert.equal(freshRes.ok, true);
  assert.deepEqual(freshRes.changed, ["claude"]);
  assert.equal(fs.statSync(freshTarget).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(freshTarget, "utf8")), {
    mcpServers: { t3_hub: { type: "stdio", command: fresh.routerBin, args: ["--memory-only"] } },
  });
});

test("claudeAgent recognizes claude mcp add -s user entry with empty env and portable shell wrapper", (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  settings(f, { claudeAgent: { driver: "claudeAgent", enabled: true } });
  const target = path.join(f.homeDir, ".claude.json");
  write(target, {
    mcpServers: {
      t3_hub: { type: "stdio", command: f.routerBin, args: ["--memory-only"], env: {} },
    },
  });
  const before = fs.readFileSync(target, "utf8");
  const summary = manager(f).getSetupSummary();
  assert.equal(summary.configured, 1);
  assert.equal(summary.providers[0].reason, "router_memory_only");
  const setupRes = manager(f).setup();
  assert.equal(setupRes.ok, true);
  assert.deepEqual(setupRes.changed, []);
  assert.equal(fs.readFileSync(target, "utf8"), before);

  // Portable /bin/sh wrapper with empty env is also recognized as configured
  write(target, {
    mcpServers: {
      t3_hub: { type: "stdio", command: "/bin/sh", args: ["-c", 'exec "$HOME/.t3/bin/t3-mcp-router" --memory-only'], env: {} },
    },
  });
  const portableSummary = manager(f).getSetupSummary();
  assert.equal(portableSummary.configured, 1);
  assert.equal(portableSummary.providers[0].reason, "router_memory_only");
});

test("claudeAgent flags custom env, non-stdio type, disabled, extra keys, and duplicate entries as conflict without overwriting", (t) => {
  const cases = [
    ["custom env", { t3_hub: { type: "stdio", command: "ROUTER", args: ["--memory-only"], env: { CUSTOM: "1" } } }, "hub_entry_custom_options"],
    ["non-object env", { t3_hub: { type: "stdio", command: "ROUTER", args: ["--memory-only"], env: null } }, "hub_entry_custom_options"],
    ["http type", { t3_hub: { type: "http", command: "ROUTER", args: ["--memory-only"] } }, "hub_entry_custom_options"],
    ["disabled entry", { t3_hub: { type: "stdio", command: "ROUTER", args: ["--memory-only"], disabled: true } }, "hub_entry_disabled"],
    ["enabled false", { t3_hub: { type: "stdio", command: "ROUTER", args: ["--memory-only"], enabled: false } }, "hub_entry_disabled"],
    ["extra unknown key", { t3_hub: { type: "stdio", command: "ROUTER", args: ["--memory-only"], headers: { X: "1" } } }, "hub_entry_custom_options"],
    ["duplicate hub entries", {
      t3_hub: { type: "stdio", command: "ROUTER", args: ["--memory-only"] },
      "t3-hub": { type: "stdio", command: "ROUTER", args: ["--memory-only"] },
    }, "duplicate_hub_entries"],
  ];
  for (const [label, serversTemplate, expectedReason] of cases) {
    const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    settings(f, { claudeAgent: { driver: "claudeAgent", enabled: true } });
    const target = path.join(f.homeDir, ".claude.json");
    const servers = JSON.parse(JSON.stringify(serversTemplate).replaceAll("ROUTER", f.routerBin));
    write(target, { mcpServers: servers });
    const before = fs.readFileSync(target, "utf8");
    const result = manager(f).setup();
    assert.equal(result.ok, false, label);
    assert.deepEqual(result.changed, [], label);
    assert.equal(result.setupSummary.conflict, 1, label);
    assert.equal(result.setupSummary.providers[0].reason, expectedReason, label);
    assert.equal(fs.readFileSync(target, "utf8"), before, `${label}: must not overwrite conflicting entry`);
  }

  // Non-boolean toggle stays unknown and untouched
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  settings(f, { claudeAgent: { driver: "claudeAgent", enabled: true } });
  const target = path.join(f.homeDir, ".claude.json");
  write(target, { mcpServers: { t3_hub: { type: "stdio", command: f.routerBin, args: ["--memory-only"], enabled: "false" } } });
  const before = fs.readFileSync(target, "utf8");
  const res = manager(f).setup();
  assert.equal(res.setupSummary.unknown, 1);
  assert.equal(res.setupSummary.providers[0].reason, "hub_entry_toggle_invalid");
  assert.equal(fs.readFileSync(target, "utf8"), before);
});

test("claudeAgent custom homePath validates bounds, pending readiness without mkdir, and rejects unsafe values", (t) => {
  // 1. Valid existing homePath (with ~/ expansion) writes <homePath>/.claude.json
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const customDir = path.join(f.homeDir, ".claude-work");
  fs.mkdirSync(customDir, { recursive: true });
  settings(f, { claudeWork: { driver: "claudeAgent", enabled: true, config: { homePath: "~/.claude-work" } } });
  const res = manager(f).setup();
  assert.equal(res.ok, true);
  assert.deepEqual(res.changed, ["claudeWork"]);
  assert.equal(fs.existsSync(path.join(f.homeDir, ".claude.json")), false, "must write custom homePath, not default ~/.claude.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(customDir, ".claude.json"), "utf8")).mcpServers.t3_hub, {
    type: "stdio", command: f.routerBin, args: ["--memory-only"],
  });

  // 2. Non-existent homePath stays pending/claude_home_not_ready and must not mkdir
  const missingDir = path.join(f.homeDir, ".claude-missing");
  settings(f, { claudeMissing: { driver: "claudeAgent", enabled: true, config: { homePath: missingDir } } });
  const pendingRes = manager(f).setup();
  assert.equal(pendingRes.ok, false);
  assert.equal(pendingRes.setupSummary.pending, 1);
  assert.equal(pendingRes.setupSummary.providers[0].reason, "claude_home_not_ready");
  assert.equal(fs.existsSync(missingDir), false, "must not auto-mkdir missing claude homePath");
  assert.equal(fs.existsSync(path.join(f.homeDir, ".claude.json")), false);

  // 3. Invalid type, relative path, outside homeDir, and symlinked homePath all fail closed with zero writes
  const outsideDir = path.join(f.root, "elsewhere");
  fs.mkdirSync(outsideDir, { recursive: true });
  const symlinkDir = path.join(f.homeDir, ".claude-link");
  fs.symlinkSync(outsideDir, symlinkDir);
  const badCases = [
    [123, "claude_home_invalid"],
    ["relative/claude", "claude_home_not_absolute"],
    [outsideDir, "claude_home_outside_home"],
    [symlinkDir, "claude_home_unsafe"],
  ];
  for (const [homePath, expectedReason] of badCases) {
    settings(f, { claudeBad: { driver: "claudeAgent", enabled: true, config: { homePath } } });
    const badRes = manager(f).setup();
    assert.equal(badRes.ok, false, expectedReason);
    assert.deepEqual(badRes.changed, [], expectedReason);
    assert.equal(badRes.setupSummary.unknown, 1, expectedReason);
    assert.equal(badRes.setupSummary.providers[0].reason, expectedReason, expectedReason);
    assert.equal(fs.existsSync(path.join(outsideDir, ".claude.json")), false, expectedReason);
    assert.equal(fs.existsSync(path.join(f.homeDir, ".claude.json")), false, expectedReason);
  }
});

test("claudeAgent options.claudeConfigDir takes effect when homePath is absent and fails closed on unsafe paths", (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  settings(f, { claudeAgent: { driver: "claudeAgent", enabled: true, config: { homePath: "" } } });
  const envDir = path.join(f.homeDir, ".claude-env");
  fs.mkdirSync(envDir, { recursive: true });
  const okRes = manager(f, { claudeConfigDir: envDir }).setup();
  assert.equal(okRes.ok, true);
  assert.deepEqual(okRes.changed, ["claudeAgent"]);
  assert.equal(fs.existsSync(path.join(envDir, ".claude.json")), true);
  assert.equal(fs.existsSync(path.join(f.homeDir, ".claude.json")), false);

  // Outside homeDir fails closed and does NOT silently fall back to ~/.claude.json
  const outsideDir = path.join(f.root, "outside-claude");
  fs.mkdirSync(outsideDir, { recursive: true });
  const failRes = manager(f, { claudeConfigDir: outsideDir }).setup();
  assert.equal(failRes.ok, false);
  assert.deepEqual(failRes.changed, []);
  assert.equal(failRes.setupSummary.unknown, 1);
  assert.equal(failRes.setupSummary.providers[0].reason, "claude_home_outside_home");
  assert.equal(fs.existsSync(path.join(outsideDir, ".claude.json")), false);
  assert.equal(fs.existsSync(path.join(f.homeDir, ".claude.json")), false);

  // Missing claudeConfigDir stays pending without mkdir or fallback to ~/.claude.json
  const missingEnvDir = path.join(f.homeDir, ".claude-env-missing");
  const pendingRes = manager(f, { claudeConfigDir: missingEnvDir }).setup();
  assert.equal(pendingRes.ok, false);
  assert.equal(pendingRes.setupSummary.pending, 1);
  assert.equal(pendingRes.setupSummary.providers[0].reason, "claude_home_not_ready");
  assert.equal(fs.existsSync(missingEnvDir), false);
  assert.equal(fs.existsSync(path.join(f.homeDir, ".claude.json")), false);
});

test("claudeAgent treats symlinked or corrupted ~/.claude.json as unknown with zero writes and preserves Magpie ownership", (t) => {
  // 1. Symlinked ~/.claude.json
  const sym = fixture(); t.after(() => fs.rmSync(sym.root, { recursive: true, force: true }));
  settings(sym, { claudeAgent: { driver: "claudeAgent", enabled: true } });
  const realFile = path.join(sym.root, "outside.json");
  write(realFile, { mcpServers: {} });
  const linkTarget = path.join(sym.homeDir, ".claude.json");
  fs.symlinkSync(realFile, linkTarget);
  const symRes = manager(sym).setup();
  assert.equal(symRes.ok, false);
  assert.deepEqual(symRes.changed, []);
  assert.equal(symRes.setupSummary.unknown, 1);
  assert.equal(symRes.setupSummary.providers[0].reason, "target_symlink");
  assert.deepEqual(JSON.parse(fs.readFileSync(realFile, "utf8")), { mcpServers: {} });

  // 2. Corrupted JSON in ~/.claude.json
  const bad = fixture(); t.after(() => fs.rmSync(bad.root, { recursive: true, force: true }));
  settings(bad, { claudeAgent: { driver: "claudeAgent", enabled: true } });
  const badTarget = path.join(bad.homeDir, ".claude.json");
  write(badTarget, "{ broken-json");
  const badRes = manager(bad).setup();
  assert.equal(badRes.ok, false);
  assert.deepEqual(badRes.changed, []);
  assert.equal(badRes.setupSummary.unknown, 1);
  assert.equal(badRes.setupSummary.providers[0].reason, "json_invalid");
  assert.equal(fs.readFileSync(badTarget, "utf8"), "{ broken-json");

  // 3. Magpie ownership stays respected for host === "claude"
  const mag = fixture(); t.after(() => fs.rmSync(mag.root, { recursive: true, force: true }));
  settings(mag, { claudeAgent: { driver: "claudeAgent", enabled: true } });
  const magTarget = path.join(mag.homeDir, ".claude.json");
  write(magTarget, { mcpServers: {} });
  const magpie = path.join(mag.homeDir, ".config", "magpie", "library.json");
  write(magpie, { mcp: [{ name: "existing", agents: ["claude"] }], agents: ["claude"] });
  const magBefore = fs.readFileSync(magTarget, "utf8");
  const magRes = manager(mag).setup();
  assert.equal(magRes.setupSummary.pending, 1);
  assert.equal(magRes.setupSummary.providers[0].reason, "managed_by_magpie");
  assert.equal(fs.readFileSync(magTarget, "utf8"), magBefore);
});

test("claudeAgent implicit enablement and legacy config.enabled:false match T3 0.1.13 rules", (t) => {
  // 1. Missing providerInstances entry when selected as defaultModelSelection / fallbackModelSelection
  const missingEntry = fixture(); t.after(() => fs.rmSync(missingEntry.root, { recursive: true, force: true }));
  settings(missingEntry, {}, { defaultModelSelection: { instanceId: "claudeAgent" } });
  const target1 = path.join(missingEntry.homeDir, ".claude.json");
  const res1 = manager(missingEntry).setup();
  assert.equal(res1.ok, true);
  assert.deepEqual(res1.changed, ["claudeAgent"]);
  assert.equal(res1.setupSummary.configured, 1);
  assert.equal(res1.setupSummary.providers[0].host, "claude");
  assert.equal(res1.setupSummary.providers[0].customConfigDir, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(target1, "utf8")).mcpServers.t3_hub, {
    type: "stdio", command: missingEntry.routerBin, args: ["--memory-only"],
  });

  // 2. Entry present with omitted top-level enabled and selected in fallbackModelSelection
  const omittedEnabled = fixture(); t.after(() => fs.rmSync(omittedEnabled.root, { recursive: true, force: true }));
  settings(omittedEnabled, { claudeAgent: { driver: "claudeAgent", displayName: "Claude Default" } }, {
    defaultModelSelection: { instanceId: "" },
    fallbackModelSelection: { instanceId: "claudeAgent" },
  });
  const res2 = manager(omittedEnabled).setup();
  assert.equal(res2.ok, true);
  assert.deepEqual(res2.changed, ["claudeAgent"]);
  assert.equal(res2.setupSummary.configured, 1);

  // 3. Legacy config.enabled:false overrides top-level enabled:true (unselected -> skipped; selected -> unknown/selected_provider_disabled; zero writes)
  const legacyOff = fixture(); t.after(() => fs.rmSync(legacyOff.root, { recursive: true, force: true }));
  settings(legacyOff, {
    muse: { driver: "muse", enabled: true },
    claudeAgent: { driver: "claudeAgent", enabled: true, config: { enabled: false } },
  }, { defaultModelSelection: { instanceId: "muse" } });
  write(path.join(legacyOff.homeDir, ".config", "muse", "settings.json"), { mcpServers: {} });
  const legacyTarget = path.join(legacyOff.homeDir, ".claude.json");
  const res3 = manager(legacyOff).setup();
  assert.deepEqual(res3.changed, ["muse"]);
  assert.equal(res3.setupSummary.providers.some((p) => p.instanceId === "claudeAgent"), false);
  assert.equal(fs.existsSync(legacyTarget), false, "config.enabled:false must never write ~/.claude.json");

  settings(legacyOff, {
    claudeAgent: { driver: "claudeAgent", enabled: true, config: { enabled: false } },
  }, { defaultModelSelection: { instanceId: "claudeAgent" } });
  const res4 = manager(legacyOff).setup();
  assert.equal(res4.ok, false);
  assert.equal(res4.setupSummary.unknown, 1);
  assert.equal(res4.setupSummary.providers[0].reason, "selected_provider_disabled");
  assert.equal(fs.existsSync(legacyTarget), false);
});

test("claudeAgent resolves instance environment CLAUDE_CONFIG_DIR and fails closed on homePath:null or invalid env", (t) => {
  // 1. homePath: "" + instance environment array [{ name: "CLAUDE_CONFIG_DIR", value: "<dir>" }]
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const envDir = path.join(f.homeDir, ".claude-inst-env");
  fs.mkdirSync(envDir, { recursive: true });
  settings(f, {
    personal: {
      driver: "claudeAgent",
      enabled: true,
      displayName: "Personal",
      config: { homePath: "" },
      environment: [{ name: "OTHER", value: "1" }, { name: "CLAUDE_CONFIG_DIR", value: envDir }],
    },
  });
  const res = manager(f).setup();
  assert.equal(res.ok, true);
  assert.deepEqual(res.changed, ["personal"]);
  assert.equal(res.setupSummary.providers[0].host, "claude");
  assert.equal(res.setupSummary.providers[0].customConfigDir, true);
  assert.equal(JSON.stringify(res.setupSummary).includes(envDir), false, "summary must not leak config paths");
  assert.equal(fs.existsSync(path.join(envDir, ".claude.json")), true);
  assert.equal(fs.existsSync(path.join(f.homeDir, ".claude.json")), false, "must not create/touch default ~/.claude.json");

  // 2. Top-level environment plain object form { CLAUDE_CONFIG_DIR: "<dir>" }
  const fObj = fixture(); t.after(() => fs.rmSync(fObj.root, { recursive: true, force: true }));
  const objDir = path.join(fObj.homeDir, ".claude-top-obj-env");
  fs.mkdirSync(objDir, { recursive: true });
  settings(fObj, {
    work: { driver: "claudeAgent", enabled: true, config: { homePath: "" }, environment: { CLAUDE_CONFIG_DIR: objDir } },
  });
  const objRes = manager(fObj).setup();
  assert.equal(objRes.ok, true);
  assert.equal(objRes.setupSummary.providers[0].customConfigDir, true);
  assert.equal(fs.existsSync(path.join(objDir, ".claude.json")), true);
  assert.equal(fs.existsSync(path.join(fObj.homeDir, ".claude.json")), false);

  // 3. Explicit homePath: null fails closed with claude_home_invalid and never falls back to ~/.claude.json
  const fNull = fixture(); t.after(() => fs.rmSync(fNull.root, { recursive: true, force: true }));
  settings(fNull, { claudeNull: { driver: "claudeAgent", enabled: true, config: { homePath: null } } });
  const nullRes = manager(fNull).setup();
  assert.equal(nullRes.ok, false);
  assert.deepEqual(nullRes.changed, []);
  assert.equal(nullRes.setupSummary.unknown, 1);
  assert.equal(nullRes.setupSummary.providers[0].reason, "claude_home_invalid");
  assert.equal(fs.existsSync(path.join(fNull.homeDir, ".claude.json")), false);

  // 4. Invalid instance environment formats (non-array/non-object, or CLAUDE_CONFIG_DIR value null) fail closed
  for (const badEnv of ["bad-string", null, [{ name: "CLAUDE_CONFIG_DIR", value: null }], { CLAUDE_CONFIG_DIR: 42 }]) {
    const fBad = fixture(); t.after(() => fs.rmSync(fBad.root, { recursive: true, force: true }));
    settings(fBad, { claudeBadEnv: { driver: "claudeAgent", enabled: true, config: { homePath: "" }, environment: badEnv } });
    const badRes = manager(fBad).setup();
    assert.equal(badRes.ok, false);
    assert.deepEqual(badRes.changed, []);
    assert.equal(badRes.setupSummary.unknown, 1);
    assert.equal(badRes.setupSummary.providers[0].reason, "claude_home_invalid");
    assert.equal(fs.existsSync(path.join(fBad.homeDir, ".claude.json")), false);
  }
});

test("claudeAgent tightens existing 0644 .claude.json to 0600 while preserving oauthAccount", (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  settings(f, { claudeAgent: { driver: "claudeAgent", enabled: true } });
  const target = path.join(f.homeDir, ".claude.json");
  const original = { oauthAccount: { emailAddress: "acct@example.test" }, mcpServers: {} };
  write(target, original);
  fs.chmodSync(target, 0o644);
  assert.equal(fs.statSync(target).mode & 0o777, 0o644);

  const res = manager(f).setup();
  assert.equal(res.ok, true);
  assert.deepEqual(res.changed, ["claudeAgent"]);
  assert.equal(fs.statSync(target).mode & 0o777, 0o600, "main .claude.json must be tightened to 0600");
  assert.equal(fs.statSync(target + ".t3hub.bak").mode & 0o777, 0o600, "backup must be 0600");
  const after = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.deepEqual(after.oauthAccount, original.oauthAccount);
  assert.deepEqual(after.mcpServers.t3_hub, { type: "stdio", command: f.routerBin, args: ["--memory-only"] });
});

test("claudeAgent detects duplicate JSON keys for literal t3_hub conflict and non-hub duplicate sections without modifying bytes", (t) => {
  // 1. Literal duplicate "t3_hub" (custom HTTP first, canonical stdio second) -> conflict/duplicate_hub_entries
  const dupHub = fixture(); t.after(() => fs.rmSync(dupHub.root, { recursive: true, force: true }));
  settings(dupHub, { claudeAgent: { driver: "claudeAgent", enabled: true } });
  const dupHubTarget = path.join(dupHub.homeDir, ".claude.json");
  const dupHubRaw = `{\n  "mcpServers": {\n    "t3_hub": { "type": "http", "url": "https://example.test/mcp" },\n    "t3_hub": { "type": "stdio", "command": ${JSON.stringify(dupHub.routerBin)}, "args": ["--memory-only"] }\n  }\n}\n`;
  write(dupHubTarget, dupHubRaw);
  const dupHubRes = manager(dupHub).setup();
  assert.equal(dupHubRes.ok, false);
  assert.deepEqual(dupHubRes.changed, []);
  assert.equal(dupHubRes.setupSummary.conflict, 1);
  assert.equal(dupHubRes.setupSummary.providers[0].reason, "duplicate_hub_entries");
  assert.equal(fs.readFileSync(dupHubTarget, "utf8"), dupHubRaw);

  // 2. Unicode-escaped duplicate "t3\u005fhub" + "t3_hub" -> conflict/duplicate_hub_entries
  const escDup = fixture(); t.after(() => fs.rmSync(escDup.root, { recursive: true, force: true }));
  settings(escDup, { claudeAgent: { driver: "claudeAgent", enabled: true } });
  const escTarget = path.join(escDup.homeDir, ".claude.json");
  const escRaw = `{"mcpServers":{"t3\\u005fhub":{"type":"http"},"t3_hub":{"type":"stdio","command":${JSON.stringify(escDup.routerBin)},"args":["--memory-only"]}}}\n`;
  write(escTarget, escRaw);
  const escRes = manager(escDup).setup();
  assert.equal(escRes.setupSummary.conflict, 1);
  assert.equal(escRes.setupSummary.providers[0].reason, "duplicate_hub_entries");
  assert.equal(fs.readFileSync(escTarget, "utf8"), escRaw);

  // 3. Duplicate non-hub key ("projects") -> unknown/json_duplicate_keys and exact original bytes preserved
  const dupProj = fixture(); t.after(() => fs.rmSync(dupProj.root, { recursive: true, force: true }));
  settings(dupProj, { claudeAgent: { driver: "claudeAgent", enabled: true } });
  const dupProjTarget = path.join(dupProj.homeDir, ".claude.json");
  const dupProjRaw = `{\n  "projects": { "/first": { "keep": true } },\n  "projects": { "/second": { "keep": true } },\n  "mcpServers": {}\n}\n`;
  write(dupProjTarget, dupProjRaw);
  const dupProjRes = manager(dupProj).setup();
  assert.equal(dupProjRes.ok, false);
  assert.deepEqual(dupProjRes.changed, []);
  assert.equal(dupProjRes.setupSummary.unknown, 1);
  assert.equal(dupProjRes.setupSummary.providers[0].reason, "json_duplicate_keys");
  assert.equal(fs.readFileSync(dupProjTarget, "utf8"), dupProjRaw);
});

test("claudeAgent explicit empty CLAUDE_CONFIG_DIR clears host override instead of inheriting options.claudeConfigDir", (t) => {
  for (const [label, environment] of [
    ["array empty string", [{ name: "CLAUDE_CONFIG_DIR", value: "" }]],
    ["array later empty overrides earlier set", [{ name: "CLAUDE_CONFIG_DIR", value: "/ignored" }, { name: "CLAUDE_CONFIG_DIR", value: "   " }]],
    ["object empty string", { CLAUDE_CONFIG_DIR: "" }],
  ]) {
    const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    const hostCustomDir = path.join(f.homeDir, ".claude-host-env");
    fs.mkdirSync(hostCustomDir, { recursive: true });
    settings(f, {
      personal: {
        driver: "claudeAgent",
        enabled: true,
        displayName: "Personal",
        config: { homePath: "" },
        environment,
      },
    });
    const res = manager(f, { claudeConfigDir: hostCustomDir }).setup();
    assert.equal(res.ok, true, label);
    assert.deepEqual(res.changed, ["personal"], label);
    assert.equal(res.setupSummary.providers[0].customConfigDir, false, label);
    assert.equal(fs.existsSync(path.join(f.homeDir, ".claude.json")), true, `${label}: must write default ~/.claude.json`);
    assert.equal(fs.existsSync(path.join(hostCustomDir, ".claude.json")), false, `${label}: must not write host claudeConfigDir`);
  }

  // Absent CLAUDE_CONFIG_DIR in instance environment still inherits host options.claudeConfigDir
  const fInherit = fixture(); t.after(() => fs.rmSync(fInherit.root, { recursive: true, force: true }));
  const hostDir = path.join(fInherit.homeDir, ".claude-host-inherit");
  fs.mkdirSync(hostDir, { recursive: true });
  settings(fInherit, {
    personal: {
      driver: "claudeAgent",
      enabled: true,
      config: { homePath: "" },
      environment: [{ name: "OTHER", value: "1" }],
    },
  });
  const inheritRes = manager(fInherit, { claudeConfigDir: hostDir }).setup();
  assert.equal(inheritRes.ok, true);
  assert.equal(inheritRes.setupSummary.providers[0].customConfigDir, true);
  assert.equal(fs.existsSync(path.join(hostDir, ".claude.json")), true);
  assert.equal(fs.existsSync(path.join(fInherit.homeDir, ".claude.json")), false);
});

test("claudeAgent rejects invalid non-object config (e.g. 42 or null) fail-closed with zero writes", (t) => {
  for (const badConfig of [42, null, [], true, "bad"]) {
    const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    const hostDir = path.join(f.homeDir, ".claude-host");
    fs.mkdirSync(hostDir, { recursive: true });
    settings(f, {
      claudeBadCfg: { driver: "claudeAgent", enabled: true, config: badConfig },
    });
    const res = manager(f, { claudeConfigDir: hostDir }).setup();
    assert.equal(res.ok, false, `config=${JSON.stringify(badConfig)}`);
    assert.deepEqual(res.changed, [], `config=${JSON.stringify(badConfig)}`);
    assert.equal(res.setupSummary.unknown, 1, `config=${JSON.stringify(badConfig)}`);
    assert.equal(res.setupSummary.providers[0].reason, "claude_home_invalid", `config=${JSON.stringify(badConfig)}`);
    assert.equal(res.setupSummary.providers[0].customConfigDir, false, `config=${JSON.stringify(badConfig)}`);
    assert.equal(fs.existsSync(path.join(f.homeDir, ".claude.json")), false, `config=${JSON.stringify(badConfig)}`);
    assert.equal(fs.existsSync(path.join(hostDir, ".claude.json")), false, `config=${JSON.stringify(badConfig)}`);
  }

  // Implicitly enabled selected claudeAgent with non-object config also fails closed
  const fImplicit = fixture(); t.after(() => fs.rmSync(fImplicit.root, { recursive: true, force: true }));
  settings(fImplicit, {
    claudeAgent: { driver: "claudeAgent", config: 42 },
  }, { defaultModelSelection: { instanceId: "claudeAgent" } });
  const implicitRes = manager(fImplicit).setup();
  assert.equal(implicitRes.ok, false);
  assert.deepEqual(implicitRes.changed, []);
  assert.equal(implicitRes.setupSummary.unknown, 1);
  assert.equal(implicitRes.setupSummary.providers[0].reason, "claude_home_invalid");
  assert.equal(fs.existsSync(path.join(fImplicit.homeDir, ".claude.json")), false);
});

test("claudeAgent ignores nested config.environment and only reads top-level target.environment", (t) => {
  for (const [label, nestedEnv] of [
    ["nested array", (dir) => [{ name: "CLAUDE_CONFIG_DIR", value: dir }]],
    ["nested object", (dir) => ({ CLAUDE_CONFIG_DIR: dir })],
  ]) {
    const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    const nestedDir = path.join(f.homeDir, ".claude-nested-ignored");
    fs.mkdirSync(nestedDir, { recursive: true });
    settings(f, {
      work: {
        driver: "claudeAgent",
        enabled: true,
        config: { homePath: "", environment: nestedEnv(nestedDir) },
      },
    });
    const res = manager(f).setup();
    assert.equal(res.ok, true, label);
    assert.deepEqual(res.changed, ["work"], label);
    assert.equal(res.setupSummary.providers[0].customConfigDir, false, label);
    assert.equal(fs.existsSync(path.join(f.homeDir, ".claude.json")), true, `${label}: must write default ~/.claude.json`);
    assert.equal(fs.existsSync(path.join(nestedDir, ".claude.json")), false, `${label}: nested config.environment must not be used`);
  }
});

test("selected custom Claude instance with custom homePath and config.enabled:false reports selected_provider_disabled with zero writes", (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const customDir = path.join(f.homeDir, ".claude-personal");
  fs.mkdirSync(customDir, { recursive: true });
  settings(f, {
    personal: {
      driver: "claudeAgent",
      enabled: true,
      displayName: "Personal",
      config: { homePath: customDir, enabled: false },
    },
  }, { defaultModelSelection: { instanceId: "personal" } });
  const res = manager(f).setup();
  assert.equal(res.ok, false);
  assert.deepEqual(res.changed, []);
  assert.equal(res.setupSummary.unknown, 1);
  assert.equal(res.setupSummary.providers[0].instanceId, "personal");
  assert.equal(res.setupSummary.providers[0].host, "claude");
  assert.equal(res.setupSummary.providers[0].status, "unknown");
  assert.equal(res.setupSummary.providers[0].reason, "selected_provider_disabled");
  assert.equal(fs.existsSync(path.join(customDir, ".claude.json")), false, "must not write custom homePath/.claude.json");
  assert.equal(fs.existsSync(path.join(f.homeDir, ".claude.json")), false, "must not write default ~/.claude.json");
});
