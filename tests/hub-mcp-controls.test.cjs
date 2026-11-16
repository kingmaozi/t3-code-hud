"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createMcpRouter } = require("../src/mcp-router.cjs");

const drawerSource = fs.readFileSync(path.join(__dirname, "../src/hub-drawer-ui.js"), "utf8");

function fakeNode() {
  const classes = new Set();
  return {
    innerHTML: "", textContent: "", hidden: false, dataset: {}, disabled: false, isConnected: true,
    classList: { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); } },
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
  const testExpose = `if (opts.__testHarness) { root = opts.root; content = opts.content; return { state, cache, errors, onClick, resourceFilters, renderMcpList, resourceMatches, agentActivationState, setProjectRoot(projectRoot) { state.projectRoot = projectRoot; contextVersion++; } }; }\n`;
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

async function waitUntil(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("timed out waiting for MCP UI action");
}

test("MCP mode controls are removed and Agent buttons explain config scope and status filtering", (t) => {
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
  assert.doesNotMatch(markup, /mcp-mode|懒加载|直连|按需唤醒|免重启已生效/);

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
