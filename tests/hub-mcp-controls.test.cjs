"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const vm = require("node:vm");
const { createMcpRouter } = require("../src/mcp-router.cjs");

const drawerSource = fs.readFileSync(path.join(__dirname, "../src/hub-drawer-ui.js"), "utf8");
const ROUTER_BIN = path.resolve(__dirname, "../bin/t3-mcp-router");

function fakeNode() {
  const classes = new Set();
  return {
    innerHTML: "", textContent: "", hidden: false, dataset: {}, disabled: false, isConnected: true,
    classList: { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); }, add(name) { classes.add(name); }, remove(name) { classes.delete(name); } },
    setAttribute() {}, querySelectorAll: () => [],
  };
}

function mountUi(hubRpc) {
  const nodes = new Map();
  const root = fakeNode(), content = fakeNode();
  root.contains = () => true;
  root.querySelector = (selector) => { if (!nodes.has(selector)) nodes.set(selector, fakeNode()); return nodes.get(selector); };
  const context = {
    window: { dispatchEvent() {} },
    document: { body: null, hidden: false, activeElement: null, querySelectorAll: () => [], querySelector: () => null, getElementById: () => null, documentElement: { lang: "zh" } },
    location: { pathname: "/threads/thread-a", href: "https://fixture.test/threads/thread-a", hash: "" },
    innerWidth: 1280, innerHeight: 800, getComputedStyle: () => ({ visibility: "visible" }),
    CustomEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
    localStorage: { getItem: () => null, setItem() {} },
    setTimeout: () => 1, clearTimeout() {}, console,
  };
  const testExpose = `if (opts.__testHarness) { root = opts.root; content = opts.content; return { state, cache, errors, onClick, onChange, resourceFilters, renderSkillList, renderMcpList, resourceMatches, agentActivationState, setProjectRoot(projectRoot) { state.projectRoot = projectRoot; contextVersion++; } }; }\n`;
  const instrumented = drawerSource.replace("    const api = {", `    ${testExpose}    const api = {`);
  assert.notEqual(instrumented, drawerSource, "test hook anchor must exist");
  vm.runInNewContext(instrumented, context, { filename: "hub-drawer-ui.js" });
  const ui = context.window.__t3MountSidecarHub({ __testHarness: true, root, content, hubRpc });
  ui.state.tab = "skills";
  ui.state.libraryView = "mcp";
  ui.state.projectRoot = "/fixture/project-a";
  return { ui, root, content, nodes };
}

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hub-mcp-controls-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const paths = {
    agy: path.join(home, ".t3/userdata/providers/antigravity/test/config/mcp_config.json"),
    muse: path.join(home, ".config/muse/settings.json"),
    codex: path.join(home, ".codex/config.toml"),
    pi: path.join(home, ".pi/agent/mcp.json"),
    claude: path.join(home, ".claude/mcp.json"),
  };
  for (const file of Object.values(paths)) fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(paths.agy, JSON.stringify({ mcpServers: { keep: { command: "agy-keep" }, agy_only: { command: "agy-only" } } }, null, 2));
  fs.writeFileSync(paths.muse, JSON.stringify({ mcpServers: { keep: { command: "muse-keep" }, muse_only: { command: "muse-only" } } }, null, 2));
  fs.writeFileSync(paths.codex, '[mcp_servers.keep]\ncommand = "codex-keep"\n\n[mcp_servers.codex_only]\ncommand = "codex-only"\n');
  fs.writeFileSync(paths.pi, JSON.stringify({ mcpServers: { keep: { command: "pi-keep" }, pi_only: { command: "pi-only" } } }, null, 2));
  fs.writeFileSync(paths.claude, JSON.stringify({ mcpServers: { keep: { command: "claude-keep" }, claude_only: { command: "claude-only" } } }, null, 2));
  return { home, paths };
}

function namesFromMarkup(markup) {
  return [...markup.matchAll(/data-mcp-name="([^"]+)"/g)].map((match) => match[1]);
}

function clickResourceHost(ui, { name, agent, enabled }) {
  const row = fakeNode();
  const target = fakeNode();
  target.dataset = { action: "resource-toggle", domain: "mcp", id: name, name, agent, enabled: String(enabled) };
  target.closest = (selector) => selector === "[data-action],#t3-hub-handle" ? target : selector === ".hub-resource-toggle" ? row : null;
  ui.onClick({ target });
  return row;
}

function clickMcpMode(ui, { name, scope, mode }) {
  const selected = {
    '[name="mcp-mode-scope"]': { value: scope },
    '[name="mcp-mode"]': { value: mode },
  };
  const controls = fakeNode();
  controls.querySelector = (selector) => selected[selector] || null;
  const target = fakeNode();
  target.dataset = { action: "save-mcp-mode", name };
  target.closest = (selector) => selector === "[data-action],#t3-hub-handle" ? target : selector === ".hub-mcp-mode-controls" ? controls : null;
  ui.onClick({ target });
  return target;
}

function changeMcpModeScope(ui, { name, scope, currentMode }) {
  const inheritOption = { hidden: false };
  const modeSelect = { value: currentMode, querySelector: selector => selector === 'option[value="inherit"]' ? inheritOption : null };
  const hint = fakeNode();
  const controls = fakeNode();
  controls.querySelector = selector => selector === '[name="mcp-mode"]' ? modeSelect : selector === ".hub-mcp-mode-hint" ? hint : null;
  const target = fakeNode();
  target.name = "mcp-mode-scope";
  target.value = scope;
  target.dataset = { name };
  target.closest = selector => selector === ".hub-mcp-mode-controls" ? controls : null;
  ui.onChange({ target });
  return { modeSelect, inheritOption, hint };
}

test("skills catalog uses source-badged cards with per-Agent controls and working source filters", () => {
  const { ui, nodes } = mountUi(async () => ({}));
  ui.state.libraryView = "skills";
  ui.cache.skills = { items: [
    { id: "magpie-skill", name: "Magpie Notes", source: "magpie", description: "A configured local skill.", agentStates: { antigravity: false, muse: false, codex: true, pi: false, claude: false } },
    { id: "market-skill", name: "Plugin Skill", source: "codex-market", description: "A catalog skill.", agentStates: { antigravity: false, muse: false, codex: false, pi: false, claude: false } },
  ] };

  ui.renderSkillList();
  let markup = nodes.get("#t3-hub-skill-list").innerHTML;
  assert.match(markup, /class="hub-card hub-market-card hub-resource-card"/);
  assert.match(markup, /data-skill-id="magpie-skill"/);
  assert.match(markup, /Magpie/);
  assert.match(markup, /启用到 Codex/);
  assert.match(nodes.get("#t3-hub-skill-filters").innerHTML, /data-filter="codex-market"/);

  ui.state.skillFilter = "codex-market";
  ui.renderSkillList();
  markup = nodes.get("#t3-hub-skill-list").innerHTML;
  assert.match(markup, /data-skill-id="market-skill"/);
  assert.doesNotMatch(markup, /data-skill-id="magpie-skill"/);
});

const MOCK_UPSTREAM = `"use strict";
let buf = "";
process.stdin.on("data", (c) => {
  buf += c.toString("utf8");
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mock", version: "1" } } }) + "\\n");
    else if (msg.method === "tools/list") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "mock_echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] } }) + "\\n");
    else if (msg.method === "tools/call") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "echo:" + (msg.params?.arguments?.text || "") }] } }) + "\\n");
  }
});
`;

function spawnRouter({ cwd, home, hubDir }) {
  const proc = spawn(ROUTER_BIN, [], { cwd, env: { ...process.env, HOME: home, T3_HUB_DIR: hubDir }, stdio: ["pipe", "pipe", "inherit"] });
  let buffer = "", nextId = 1;
  const waiters = new Map();
  proc.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message; try { message = JSON.parse(line); } catch { continue; }
      const waiter = waiters.get(message.id);
      if (waiter) { waiters.delete(message.id); waiter(message); }
    }
  });
  proc.on("exit", (code, signal) => { for (const waiter of waiters.values()) waiter({ error: { message: `router exited ${code ?? signal}` } }); waiters.clear(); });
  return {
    request(method, params) {
      return new Promise((resolve, reject) => {
        const id = nextId++, timer = setTimeout(() => { waiters.delete(id); reject(new Error(`router timeout: ${method}`)); }, 10000);
        timer.unref?.();
        waiters.set(id, (message) => { clearTimeout(timer); message.error ? reject(new Error(message.error.message)) : resolve(message.result); });
        proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    },
    stop() { try { proc.kill(); } catch {} },
  };
}

async function waitUntil(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("timed out waiting for MCP UI action");
}

test("Agent-native switches stay independent while Hub mode controls explain scope and forwarding", (t) => {
  const { home } = tempHome(t), router = createMcpRouter({ homeDir: home });
  router.upsertMcpServer({ name: "sample", transport: "stdio", command: "node", args: ["/tmp/sample-mcp.js"] });
  const { ui, nodes } = mountUi(async (action, payload) => {
    if (action === "mcp:list") return router.listMcpServers(payload);
    throw new Error(`Unexpected action: ${action}`);
  });
  ui.cache.mcp = router.listMcpServers({ projectRoot: ui.state.projectRoot });
  ui.renderMcpList();
  const markup = nodes.get("#t3-hub-mcp-list").innerHTML;
  const filters = ui.resourceFilters("mcp", "mcpQuery", "");

  assert.match(filters, /查看谁的启用状态/);
  assert.match(filters, /未启用项仍可直接点行内 Agent 添加/);
  assert.match(markup, /该 Agent 的各项目共用/);
  assert.match(markup, /启用到 AGY/);
  assert.match(markup, /全部 Agent/);
  assert.match(markup, /mcp-mode-scope/);
  assert.match(markup, /mcp-mode/);
  assert.match(markup, /不经 Hub 不会关闭 Agent 原生配置/);
  assert.match(markup, /项目单独设置优先于全局默认/);
  assert.match(markup, /当前 Agent 工具列表是否刷新由 Agent 决定/);
  assert.doesNotMatch(markup, /免重启已生效/);

  ui.state.resourceFilters.mcp = { agent: "codex", status: "enabled" };
  ui.renderMcpList();
  let names = namesFromMarkup(nodes.get("#t3-hub-mcp-list").innerHTML);
  assert.ok(names.includes("codex_only"));
  assert.ok(!names.includes("agy_only"));
  assert.ok(!names.includes("sample"));

  ui.state.resourceFilters.mcp.status = "disabled";
  ui.renderMcpList();
  names = namesFromMarkup(nodes.get("#t3-hub-mcp-list").innerHTML);
  assert.ok(names.includes("sample"), "unconfigured MCP stays visible so it can be enabled for Codex");
  assert.ok(names.includes("agy_only"));
  assert.ok(!names.includes("codex_only"));

  ui.cache.mcp = { items: [
    { name: "null-state", agentStates: { codex: null }, agents: ["codex"] },
    { name: "empty-host-state", agentStates: { codex: {} }, agents: ["codex"] },
    { name: "empty-authoritative-state", agentStates: {}, agents: ["codex"] },
    { name: "no-authoritative-state", agents: ["codex"] },
    { name: "explicitly-off", agentStates: { codex: false }, agents: ["codex"] },
  ] };
  ui.state.resourceFilters.mcp = { agent: "codex", status: "disabled" };
  ui.renderMcpList();
  assert.deepEqual(namesFromMarkup(nodes.get("#t3-hub-mcp-list").innerHTML), ["explicitly-off"], "unknown status is not treated as an explicit disabled state");
  ui.state.resourceFilters.mcp.status = "all";
  ui.renderMcpList();
  const unknownMarkup = nodes.get("#t3-hub-mcp-list").innerHTML;
  assert.deepEqual(namesFromMarkup(unknownMarkup), ["null-state", "empty-host-state", "empty-authoritative-state", "no-authoritative-state", "explicitly-off"], "unknown resources remain visible and can be enabled");
  assert.match(unknownMarkup, /aria-pressed="mixed"[^>]*>[^]*?<span>Codex<\/span><span class="hub-agent-unknown">未知<\/span>/);
  assert.match(unknownMarkup, /agentStates|状态未知/);
  assert.equal(ui.agentActivationState({ agentStates: { codex: {} }, agents: ["codex"] }, { id: "codex", aliases: ["codex"] }), null,
    "static discovery metadata cannot override an empty authoritative state");
});

test("UI Hub modes change live lazy/direct routing while project overrides win over global defaults", async (t) => {
  const { home, paths } = tempHome(t);
  const hub = path.join(home, ".t3", "hub");
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "hub-mcp-project-"));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  fs.mkdirSync(path.join(project, ".git"));
  const otherProject = fs.mkdtempSync(path.join(os.tmpdir(), "hub-mcp-other-project-"));
  t.after(() => fs.rmSync(otherProject, { recursive: true, force: true }));
  const mockFile = path.join(home, "mock-upstream.cjs");
  fs.writeFileSync(mockFile, MOCK_UPSTREAM, "utf8");
  const router = createMcpRouter({ homeDir: home, hubDir: hub });
  router.upsertMcpServer({ name: "mock", command: process.execPath, args: [mockFile] });
  router.setMcpMode({ name: "mock", mode: "global-lazy" });

  const calls = [];
  const { ui, nodes } = mountUi(async (action, payload) => {
    calls.push({ action, payload });
    if (action === "mcp:setMode") return router.setMcpMode(payload);
    if (action === "mcp:list") return router.listMcpServers(payload);
    throw new Error(`Unexpected action: ${action}`);
  });
  ui.setProjectRoot(project);
  ui.cache.mcp = router.listMcpServers({ projectRoot: project });
  ui.renderMcpList();
  assert.match(nodes.get("#t3-hub-mcp-list").innerHTML, /所有项目默认/);

  const runtime = spawnRouter({ cwd: project, home, hubDir: hub });
  t.after(() => runtime.stop());
  await runtime.request("initialize", { protocolVersion: "2024-11-05" });

  async function saveMode(scope, mode, expectedMode, expectedScope = scope) {
    const previousLists = calls.filter((call) => call.action === "mcp:list").length;
    clickMcpMode(ui, { name: "mock", scope, mode });
    await waitUntil(() => calls.filter((call) => call.action === "mcp:list").length > previousLists
      && router.listMcpServers(scope === "global" ? {} : { projectRoot: project }).items.find((item) => item.name === "mock")?.mode === expectedMode);
    await waitUntil(() => nodes.get(".hub-toast").innerHTML.includes(scope === "global" && expectedScope === "project" ? "单独设置仍优先" : "已保存 Hub 调用方式"));
  }

  await saveMode("project", "off", "off");
  let projectMode = router.listMcpServers({ projectRoot: project }).items.find((item) => item.name === "mock");
  assert.equal(projectMode.modeScope, "project");
  assert.equal(projectMode.modeProject, "off");
  assert.equal(projectMode.modeGlobal, "global-lazy");
  assert.equal(projectMode.agentStates.codex, false, "Hub off does not disable native Agent MCP configuration");
  assert.equal((await runtime.request("tools/list", {})).tools.some((tool) => tool.name.startsWith("hub_")), false);

  await saveMode("project", "lazy", "project-lazy");
  const lazyNames = (await runtime.request("tools/list", {})).tools.map((tool) => tool.name);
  assert.ok(lazyNames.includes("hub_list_mcp_tools") && lazyNames.includes("hub_call_mcp_tool"));
  const lazyListed = await runtime.request("tools/call", { name: "hub_list_mcp_tools", arguments: { server: "mock" } });
  assert.match(lazyListed.content[0].text, /mock_echo/);
  const lazyCall = await runtime.request("tools/call", { name: "hub_call_mcp_tool", arguments: { server: "mock", tool: "mock_echo", arguments: { text: "lazy" } } });
  assert.match(lazyCall.content[0].text, /echo:lazy/);

  await saveMode("project", "direct", "project-direct");
  const directNames = (await runtime.request("tools/list", {})).tools.map((tool) => tool.name);
  assert.ok(directNames.includes("mock__mock_echo"));
  assert.ok(!directNames.includes("hub_list_mcp_tools"));
  const directCall = await runtime.request("tools/call", { name: "mock__mock_echo", arguments: { text: "direct" } });
  assert.match(directCall.content[0].text, /echo:direct/);

  await saveMode("global", "off", "off", "project");
  projectMode = router.listMcpServers({ projectRoot: project }).items.find((item) => item.name === "mock");
  assert.equal(projectMode.mode, "project-direct", "global off leaves the current project's explicit route untouched");
  assert.equal(projectMode.modeGlobal, "off");
  assert.equal(router.listMcpServers({ projectRoot: otherProject }).items.find((item) => item.name === "mock").mode, "off");
  assert.equal((await runtime.request("tools/list", {})).tools.some((tool) => tool.name === "mock__mock_echo"), true);
  assert.match(nodes.get(".hub-toast").innerHTML, /单独设置仍优先/);
  assert.match(fs.readFileSync(paths.codex, "utf8"), /codex_only/);
  assert.doesNotMatch(fs.readFileSync(paths.codex, "utf8"), /mcp_servers\.mock/);
});

test("changing Hub mode scope restores its saved value and project can follow global", async (t) => {
  const { home } = tempHome(t);
  const hub = path.join(home, ".t3", "hub");
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "hub-mcp-scope-project-"));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  fs.mkdirSync(path.join(project, ".git"));
  const router = createMcpRouter({ homeDir: home, hubDir: hub });
  router.upsertMcpServer({ name: "scope-sample", command: process.execPath, args: ["-e", "process.exit(0)"] });
  router.setMcpMode({ name: "scope-sample", mode: "off" });
  router.setMcpMode({ name: "scope-sample", mode: "project-direct", projectRoot: project });

  const calls = [];
  const { ui, nodes } = mountUi(async (action, payload) => {
    calls.push({ action, payload });
    if (action === "mcp:setMode") return router.setMcpMode(payload);
    if (action === "mcp:list") return router.listMcpServers(payload);
    throw new Error(`Unexpected action: ${action}`);
  });
  ui.setProjectRoot(project);
  ui.cache.mcp = router.listMcpServers({ projectRoot: project });
  ui.renderMcpList();

  let selection = changeMcpModeScope(ui, { name: "scope-sample", scope: "global", currentMode: "direct" });
  assert.equal(selection.modeSelect.value, "off", "switching to global restores global off instead of carrying project direct");
  assert.equal(selection.inheritOption.hidden, true, "inherit is unavailable while editing the global default");

  clickMcpMode(ui, { name: "scope-sample", scope: "global", mode: selection.modeSelect.value });
  await waitUntil(() => calls.some(call => call.action === "mcp:list") && nodes.get(".hub-toast").innerHTML.includes("单独设置仍优先"));
  let saved = router.listMcpServers({ projectRoot: project }).items.find(item => item.name === "scope-sample");
  assert.equal(saved.modeGlobal, "off");
  assert.equal(saved.modeProject, "project-direct", "saving global off preserves the project override");

  selection = changeMcpModeScope(ui, { name: "scope-sample", scope: "project", currentMode: "off" });
  assert.equal(selection.modeSelect.value, "direct", "switching back restores the project's saved direct mode");
  assert.equal(selection.inheritOption.hidden, false);
  clickMcpMode(ui, { name: "scope-sample", scope: "project", mode: "inherit" });
  await waitUntil(() => nodes.get(".hub-toast").innerHTML.includes("跟随全局"));

  saved = router.listMcpServers({ projectRoot: project }).items.find(item => item.name === "scope-sample");
  assert.equal(saved.mode, "off");
  assert.equal(saved.modeScope, "global");
  assert.equal(saved.modeProject, null, "follow-global removes only this project's override");
  assert.equal(saved.modeGlobal, "off", "follow-global preserves the global default");
  selection = changeMcpModeScope(ui, { name: "scope-sample", scope: "project", currentMode: "direct" });
  assert.equal(selection.modeSelect.value, "inherit", "an unset project override is shown as following global");
  assert.match(selection.hint.textContent, /正跟随全局默认/);
});

test("clicking a row Agent writes only that host config, rereads the state, and reports actual activation", async (t) => {
  const { home, paths } = tempHome(t), router = createMcpRouter({ homeDir: home });
  router.upsertMcpServer({ name: "sample", transport: "stdio", command: "node", args: ["/tmp/sample-mcp.js"] });
  const calls = [];
  const { ui, nodes } = mountUi(async (action, payload) => {
    calls.push({ action, payload });
    if (action === "mcp:toggleAgent") return router.toggleServerForAgent(payload);
    if (action === "mcp:list") return router.listMcpServers(payload);
    throw new Error(`Unexpected action: ${action}`);
  });
  ui.cache.mcp = router.listMcpServers({ projectRoot: ui.state.projectRoot });

  const row = clickResourceHost(ui, { name: "sample", agent: "codex", enabled: true });
  await waitUntil(() => row.dataset.busy !== "true" && calls.some((call) => call.action === "mcp:list"));
  const write = calls.find((call) => call.action === "mcp:toggleAgent");
  assert.equal(write.payload.agent, "codex");
  assert.equal(write.payload.enabled, true);
  assert.equal(write.payload.projectRoot, "/fixture/project-a");

  let config = fs.readFileSync(paths.codex, "utf8");
  assert.match(config, /\[mcp_servers\.sample\]/);
  assert.match(config, /\[mcp_servers\.keep\]/);
  assert.doesNotMatch(fs.readFileSync(paths.muse, "utf8"), /sample/);
  assert.doesNotMatch(fs.readFileSync(paths.agy, "utf8"), /sample/);
  assert.doesNotMatch(fs.readFileSync(paths.pi, "utf8"), /sample/);
  assert.doesNotMatch(fs.readFileSync(paths.claude, "utf8"), /sample/);
  assert.equal(router.listMcpServers({ projectRoot: "/fixture/project-b" }).items.find((item) => item.name === "sample").agentStates.codex, true,
    "the native Codex config is shared when listing a different project");
  assert.match(nodes.get(".hub-toast").innerHTML, /新会话通常会读取/);

  calls.length = 0;
  const disableRow = clickResourceHost(ui, { name: "sample", agent: "codex", enabled: false });
  await waitUntil(() => disableRow.dataset.busy !== "true" && calls.some((call) => call.action === "mcp:list"));
  config = fs.readFileSync(paths.codex, "utf8");
  assert.doesNotMatch(config, /\[mcp_servers\.sample\]/);
  assert.match(config, /\[mcp_servers\.keep\]/, "disabling one MCP preserves unrelated Codex servers");
  assert.match(fs.readFileSync(paths.muse, "utf8"), /muse_only/);
  assert.match(fs.readFileSync(paths.pi, "utf8"), /pi_only/);
  assert.match(nodes.get(".hub-toast").innerHTML, /已从 Codex 的 MCP 配置移除/);
});

test("a delayed list reply from an old project cannot overwrite the current project's MCP cache", async (t) => {
  const { home } = tempHome(t), router = createMcpRouter({ homeDir: home });
  router.upsertMcpServer({ name: "sample", transport: "stdio", command: "node", args: ["/tmp/sample-mcp.js"] });
  let releaseList;
  const { ui } = mountUi(async (action, payload) => {
    if (action === "mcp:toggleAgent") return router.toggleServerForAgent(payload);
    if (action === "mcp:list") return new Promise((resolve) => { releaseList = () => resolve(router.listMcpServers(payload)); });
    throw new Error(`Unexpected action: ${action}`);
  });
  ui.cache.mcp = { project: "A" };
  const row = clickResourceHost(ui, { name: "sample", agent: "codex", enabled: true });
  await waitUntil(() => typeof releaseList === "function");
  ui.setProjectRoot("/fixture/project-b");
  ui.cache.mcp = { project: "B" };
  releaseList();
  await waitUntil(() => row.dataset.busy !== "true");
  assert.deepEqual(ui.cache.mcp, { project: "B" });
});

test("a disable request with a null/empty readback cannot claim the MCP was removed", async () => {
  for (const codexState of [null, {}]) {
    const { ui, nodes } = mountUi(async (action) => {
      if (action === "mcp:toggleAgent") return { ok: true };
      if (action === "mcp:list") return { items: [{ name: "sample", agentStates: { codex: codexState }, agents: ["codex"] }] };
      throw new Error(`Unexpected action: ${action}`);
    });
    ui.cache.mcp = { items: [{ name: "sample", agentStates: { codex: true } }] };
    const row = clickResourceHost(ui, { name: "sample", agent: "codex", enabled: false });
    await waitUntil(() => row.dataset.busy !== "true");
    const toast = nodes.get(".hub-toast").innerHTML;
    assert.match(toast, /配置已提交 0\/1 个 Agent/);
    assert.doesNotMatch(toast, /已从 Codex 的 MCP 配置移除/);
  }
});

test("normalized name conflicts stay visible, allow safe off/removal, and block enables", async (t) => {
  const { home, paths } = tempHome(t);
  fs.writeFileSync(paths.codex, `${fs.readFileSync(paths.codex, "utf8")}\n[mcp_servers.echo_server]\ncommand = "node"\nargs = ["/tmp/one.cjs"]\n\n[mcp_servers.echo-server]\ncommand = "node"\nargs = ["/tmp/two.cjs"]\n`);
  const router = createMcpRouter({ homeDir: home });
  router.upsertMcpServer({ name: "echo_server", command: "node", args: ["/tmp/one.cjs"] });
  router.upsertMcpServer({ name: "echo-server", command: "node", args: ["/tmp/two.cjs"] });
  const { ui, nodes } = mountUi(async (action, payload) => {
    if (action === "mcp:toggleAgent") return router.toggleServerForAgent(payload);
    if (action === "mcp:setMode") return router.setMcpMode(payload);
    if (action === "mcp:list") return router.listMcpServers({ projectRoot: ui.state.projectRoot });
    throw new Error(`Unexpected action: ${action}`);
  });
  ui.cache.mcp = { items: router.listMcpServers({ projectRoot: ui.state.projectRoot }).items.filter((item) => ["echo_server", "echo-server"].includes(item.name)) };
  ui.renderMcpList();
  const markup = nodes.get("#t3-hub-mcp-list").innerHTML;
  assert.equal((markup.match(/data-mcp-name=/g) || []).length, 2, "both definitions remain visible for repair");
  assert.match(markup, /名称冲突已暂停/);
  assert.match(markup, /data-action="resource-toggle"[^>]*data-enabled="false"/);
  assert.doesNotMatch(markup, /data-action="resource-toggle"[^>]*data-enabled="true"/, "conflicted exact definitions cannot be enabled");
  assert.match(markup, /name="mcp-mode"[^>]*><option value="off"[^>]*>不经 Hub/);
  assert.match(markup, /value="lazy"[^>]*disabled/);
  assert.doesNotMatch(markup, /data-action="save-mcp-mode" disabled/, "Hub off remains available during conflict");
  assert.equal((markup.match(/data-action="remove-mcp"/g) || []).length, 2, "each exact custom definition can be removed explicitly");

  const disable = clickResourceHost(ui, { name: "echo_server", agent: "codex", enabled: false });
  await waitUntil(() => disable.dataset.busy !== "true");
  assert.match(nodes.get(".hub-toast").innerHTML, /确切名称/);
  let codex = fs.readFileSync(paths.codex, "utf8");
  assert.doesNotMatch(codex, /mcp_servers\.echo_server\]/);
  assert.match(codex, /mcp_servers\.echo-server\]/, "turning one ambiguous entry off preserves the other exact name");

  clickMcpMode(ui, { name: "echo_server", scope: "global", mode: "off" });
  await waitUntil(() => nodes.get(".hub-toast").innerHTML.includes("已保存 Hub 调用方式"));
  assert.equal(router.listMcpServers({}).items.find((item) => item.name === "echo_server").modeGlobal, "off");
});

test("MCP market separates source, launchability, Agent state, Hub mode, and probe state", () => {
  const { ui, nodes } = mountUi(async () => ({}));
  const baseStates = { antigravity: false, muse: false, codex: false, pi: false, claude: false };
  ui.cache.mcp = { items: [
    { name: "magpie-missing", source: "magpie", sourceLabel: "magpie", command: null, launchable: false, launchReason: "missing-endpoint", connected: null, probed: false, agentStates: { ...baseStates, codex: true }, mode: "global-direct", modeScope: "global", modeGlobal: "global-direct", modeProject: null },
    { name: "builtin-ready", source: "builtin", sourceLabel: "builtin", builtin: true, command: "node", launchable: true, connected: null, probed: false, agentStates: baseStates, mode: "off", modeScope: "global", modeGlobal: "off", modeProject: null },
  ] };
  ui.renderMcpList();
  let markup = nodes.get("#t3-hub-mcp-list").innerHTML;
  assert.match(markup, /Magpie/);
  assert.match(markup, /内置/);
  assert.match(markup, /入口不可用/);
  assert.match(markup, /Agent 原生: 部分启用/);
  assert.match(markup, /Hub: 列出全部工具/);
  assert.match(markup, /连通性未检测/);
  assert.match(markup, /data-name="magpie-missing" data-agent="codex" data-enabled="false"[^>]*>/, "existing Agent entry can still be disabled");
  assert.match(markup, /data-name="magpie-missing" data-agent="muse" data-enabled="true"[^>]*disabled/, "missing launch endpoint cannot be enabled");
  assert.match(markup, /name="mcp-mode"[^>]*><option value="off"/);
  assert.match(markup, /value="direct"[^>]*disabled/);
  assert.doesNotMatch(markup, /data-action="save-mcp-mode" disabled/);

  const filter = fakeNode();
  filter.dataset = { action: "mcp-filter", filter: "magpie" };
  filter.closest = (selector) => selector === "[data-action],#t3-hub-handle" ? filter : null;
  ui.onClick({ target: filter });
  markup = nodes.get("#t3-hub-mcp-list").innerHTML;
  assert.equal((markup.match(/data-mcp-name=/g) || []).length, 1);
  assert.match(markup, /data-mcp-name="magpie-missing"/);
  assert.doesNotMatch(markup, /data-mcp-name="builtin-ready"/);
});

test("Magpie source filter retains entries merged with native and Hub definitions", t => {
  const { home, paths } = tempHome(t);
  const magpiePath = path.join(home, ".config/magpie/library.json");
  fs.mkdirSync(path.dirname(magpiePath), { recursive: true });
  fs.writeFileSync(magpiePath, JSON.stringify({ mcp: [
    { name: "shared-native", command: "node", args: ["-e", "process.exit(0)"] },
    { name: "shared-hub", command: "node", args: ["-e", "process.exit(0)"] },
    { name: "magpie-only", command: "node", args: ["-e", "process.exit(0)"] },
  ] }, null, 2));
  const muse = JSON.parse(fs.readFileSync(paths.muse, "utf8"));
  muse.mcpServers["shared-native"] = { command: "node", args: ["-e", "process.exit(0)"] };
  fs.writeFileSync(paths.muse, JSON.stringify(muse, null, 2));

  const router = createMcpRouter({ homeDir: home });
  router.upsertMcpServer({ name: "shared-hub", command: "node", args: ["-e", "process.exit(0)"] });
  const { ui, nodes } = mountUi(async () => ({}));
  ui.cache.mcp = router.listMcpServers({});
  ui.renderMcpList();

  const nativeEntry = ui.cache.mcp.items.find(item => item.name === "shared-native");
  const hubEntry = ui.cache.mcp.items.find(item => item.name === "shared-hub");
  assert.ok(nativeEntry.sources.includes("magpie"), "source metadata retains Magpie after native definition merge");
  assert.ok(hubEntry.sources.includes("magpie"), "source metadata retains Magpie after registry definition merge");

  const filter = fakeNode();
  filter.dataset = { action: "mcp-filter", filter: "magpie" };
  filter.closest = selector => selector === "[data-action],#t3-hub-handle" ? filter : null;
  ui.onClick({ target: filter });
  const markup = nodes.get("#t3-hub-mcp-list").innerHTML;
  assert.deepEqual(namesFromMarkup(markup).sort(), ["magpie-only", "shared-hub", "shared-native"]);
  const nativeCard = markup.split('data-mcp-name="shared-native"')[1]?.split("</article>")[0] || "";
  assert.match(nativeCard, /<span class="hub-badge">Magpie<\/span>/);
});

test("saving a Magpie Hub mode before enabling Muse preserves all source badges", t => {
  const { home } = tempHome(t);
  const magpiePath = path.join(home, ".config/magpie/library.json");
  fs.mkdirSync(path.dirname(magpiePath), { recursive: true });
  fs.writeFileSync(magpiePath, JSON.stringify({ mcp: [
    { name: "ordered-shared", command: process.execPath, args: ["-e", "process.exit(0)"] },
  ] }, null, 2));
  const router = createMcpRouter({ homeDir: home });
  router.setMcpMode({ name: "ordered-shared", mode: "global-lazy" });
  router.toggleServerForAgent({ name: "ordered-shared", agent: "muse", enabled: true });
  const item = router.listMcpServers({}).items.find(entry => entry.name === "ordered-shared");
  assert.ok(item.sources.includes("magpie"));
  assert.ok(item.sources.includes("hub"), "registry mirror is tracked as a Hub source without discarding Magpie");
  assert.ok(item.sources.includes("muse"));
  assert.equal(item.agentStates.muse, true);

  const { ui, nodes } = mountUi(async () => ({}));
  ui.cache.mcp = { items: [item] };
  ui.renderMcpList();
  const card = nodes.get("#t3-hub-mcp-list").innerHTML.split('data-mcp-name="ordered-shared"')[1]?.split("</article>")[0] || "";
  assert.match(card, /<span class="hub-badge">Magpie<\/span>/);
  assert.match(card, /<span class="hub-badge">本机 Agent<\/span>/);
  assert.match(card, /<span class="hub-badge">Hub<\/span>/);
});
