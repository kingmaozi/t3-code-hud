"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const { TextEncoder } = require("node:util");
const { createHostSettingsManager, CODEX_EDITABLE_KEYS, MUSE_KEYS, PI_KEYS } = require("../src/hub-host-settings.cjs");

const repo = path.resolve(__dirname, "..");
const drawerSource = fs.readFileSync(path.join(repo, "src/hub-drawer-ui.js"), "utf8");
const rendererSource = fs.readFileSync(path.join(repo, "src/renderer-ui.js"), "utf8");
const attacks = ['<img src=x onerror=alert(1)>', '" autofocus onfocus="alert(1)', "'</textarea><svg onload=alert(1)>&"];

function node() {
  const classes = new Set(), attrs = new Map(), properties = new Map();
  return {
    innerHTML: "", textContent: "", hidden: false, dataset: {}, children: [],
    style: { setProperty: (key, value) => properties.set(key, value), getPropertyValue: (key) => properties.get(key) || "", removeProperty: (key) => properties.delete(key) },
    setAttribute: (key, value) => attrs.set(key, String(value)), getAttribute: (key) => attrs.get(key) ?? null, removeAttribute: (key) => attrs.delete(key),
    getClientRects: () => [{ width: 200, height: 30 }], getBoundingClientRect: () => ({ left: 100, right: 700, top: 600, bottom: 720, width: 600, height: 120 }),
    appendChild(child) { child.parentElement = this; this.children.push(child); this.lastElementChild = child; },
    closest: () => null, matches: () => false, addEventListener() {}, removeEventListener() {}, remove() { this.removed = true; },
    classList: { add: (s) => classes.add(s), remove: (s) => classes.delete(s), toggle(s, on) { on ? classes.add(s) : classes.delete(s); }, contains: (s) => classes.has(s) },
    querySelector: () => null, querySelectorAll: () => [], contains: () => false,
  };
}

// Exercise the actual closed-over UI functions without adding production test hooks
// or depending on a browser/DOM package in the release-check environment.
function harness(rpc = async () => ({}), environment = {}) {
  const nodes = new Map();
  const root = node(), content = node();
  root.querySelector = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, node());
    return nodes.get(selector);
  };
  const sandbox = {
    window: { dispatchEvent() {}, ...environment.window },
    document: { body: null, hidden: false, activeElement: null, querySelectorAll: () => [], querySelector: () => null, getElementById: () => null, documentElement: { lang: "zh" }, ...environment.document },
    location: { pathname: "/threads/thread-a", href: "https://fixture.test/threads/thread-a", hash: "", ...environment.location },
    innerWidth: environment.innerWidth ?? 1280, innerHeight: environment.innerHeight ?? 800, getComputedStyle: () => ({ visibility: "visible" }),
    CustomEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
    localStorage: environment.localStorage || { getItem: () => null, setItem() {} },
    setTimeout: () => 1, clearTimeout() {}, console, crypto: webcrypto, TextEncoder,
  };
  const expose = `if (opts.__testHarness) {
    root = opts.root; content = opts.content;
    settingsPanel = root.querySelector("#t3-hub-settings-panel"); settingsPanel.querySelector = root.querySelector;
    handle = null; titleControls = root.querySelector("#t3-hub-title-controls"); memoryHandle = root.querySelector("#t3-hub-memory-handle"); memoryToggle = root.querySelector("#t3-hub-memory-toggle"); settingsHandle = root.querySelector("#t3-hub-settings-handle"); updateHandle = root.querySelector("#t3-hub-update-handle"); planHandle = root.querySelector("#t3-hub-plan-handle"); artifactDock = root.querySelector("#t3-hub-artifact-dock"); drawer = root.querySelector("#t3-hub-drawer"); liveBoard = root.querySelector("#t3-hub-live-board");

    return {state, cache, errors, settingsValues, renderSettings, loadSettings, saveNativeSettings, renderHubSettingsPanel, refreshOfficialTelemetry,
      renderHudUpdatePill, renderHudUpdateSection, checkHudUpdate, applyHudUpdate, handleHudUpdatePillClick, loadHudUpdateConfig, setAutoHotUpdate, maybeTriggerAutoHotUpdate, scheduleHudUpdateCheck, restoreHudUpdateCache, readHudUpdateCache, onExternalHudUpdateState, sanitizeHudReleaseUrl, copyHudUpdateCommand,
      onInput, onChange, onClick, onEditorKeydown, renderMemory, renderMemoryConnections, renderMemoryList, renderHooks, renderSkillList, renderMcpList,
      renderSubagents, renderCommander, renderPlugins, subagentItems, persistSubagent, setCooperationMode, hookItems, setDomainScope, saveHook, deleteHook, boardMarkup, boardSourceLabel, brandIcon, request, esc, agentHosts,
      hubThemes, themeSwitcher, applyTheme, setTheme, currentThreadId, syncThread, checkRoute, pollBoard, updateBoard, renderLiveBoard, renderArtifactDock, renderBoardTab, loadTab, flushBoardRender,
      composerSurface, findSessionRelationsCard, positionConversationTools, startBoardDrag, moveBoardDrag, endBoardDrag, cancelBoardDrag, formatExactTime, renderMemoryHistory,
      refreshContext, routeHint, routeKey, boardMismatch, projectContextReady, syncOcclusion,
      findConversationTitleAnchor, placePlanHandle, handlePlanPointerDown, handlePlanPointerEnter, handlePlanPointerLeave, handlePlanClick, setPlanPopover,
      normalizeRemoteThreadPlan, normalizeRemotePlanMirror, newestRemotePlan, planMirrorRelativePath, remotePlanEnvironmentId, remotePlanContextReady, resetProjectData,
      switchTab,
      runImport, setSkillScope, saveMcpMode, renderChrome, renderTab, parseScopeParts,
      renderMemoryAgentAccess, setMemoryAgentAccess, runMemorySetup, copyMemorySetupPrompt, providerMemorySetupPrompt, copyProviderMemorySetupPrompt, renderMemoryRuntime, memoryMcpConfigText, copyMemoryMcpConfig, refreshMemoryAgentAccess, openMemoryFromTitle, toggleMemoryAccessFromTitle, renderMemoryTitleControls,
      memoryPayload, memoryProjectReady, selectedMemoryRoot, selectedMemoryProject, loadMemories, refreshMemoryOverview, renderMemoryNav, renderMemoryList, renderNewMemory, memorySelection, runMemoryVectorTest,
      planStepProgress,
      saveMemory, deleteMemory, promoteMemory, consolidateMemory, rollbackMemory,
      isContextLoading: () => contextLoading,
      snapshot: ${drawerSource.match(/snapshot: (.*),\n destroy:/)[1]}, ready: () => { contextLoading = false; },
      setCurrentRoute: () => { lastRoute = routeKey(); lastBoardRoute = boardScopeRoute(); },
      routeScope: () => ({ cached: lastBoardRoute, current: boardScopeRoute() }),
      titleControls, memoryHandle, memoryToggle, settingsHandle, updateHandle, artifactDock, timers,
      setStyle: (fn) => { getComputedStyle = fn; }, destroy: () => { disposed = true; cancelTimer(updateBgTimer); updateBgTimer = null; timers.forEach(clearTimeout); timers.clear(); liveBoard?.remove(); artifactDock?.remove(); titleControls?.remove(); planHandle?.remove(); }};
  }`;
  vm.runInNewContext(drawerSource.replace("    const api = {", expose + "\n    const api = {"), sandbox, { filename: "hub-drawer-ui.js" });
  const ui = sandbox.window.__t3MountSidecarHub({ __testHarness: true, root, content, hubRpc: rpc });
  if (!sandbox.document.body) sandbox.document.body = node();
  return { ...ui, root, content, nodes, sandbox };
}

function confirmMemoryProject(ui, projectRoot = "/fixture", threadId = "thread-a") {
  ui.ready();
  Object.assign(ui.state, { open: true, connected: true, tab: "memory", projectRoot, threadId, context: { threadId, projectRoot } });
  ui.setCurrentRoute();
}

test("Hub exposes only the lightweight memory workspace", () => {
  const ui = harness();
  ui.renderChrome();
  const nav = ui.root.querySelector(".hub-tabs").innerHTML;
  const header = ui.root.querySelector(".hub-header").innerHTML;
  assert.deepEqual([...nav.matchAll(/data-tab="([^"]+)"/g)].map((match) => match[1]), ["memory"]);
  assert.match(nav, /记忆/);
  assert.doesNotMatch(nav, /个性化|子智能体|技能与 MCP|插件|Hooks/);
  assert.doesNotMatch(header, /本机 · 全局|Local · Global/);
});

test("General settings show bilingual telemetry switches and verified launch state", async () => {
  const calls = [];
  const snapshot = {
    config: { disableOfficialTelemetry: false, syncShellProfileTelemetryOptOut: false },
    runtime: { state: "not-enabled", restartRequired: false }, profile: "manual", policy: "locked-off",
  };
  const ui = harness(async (action, patch) => {
    calls.push([action, patch]);
    if (action.endsWith(":update")) {
      snapshot.config = { ...snapshot.config, ...patch };
      snapshot.runtime.restartRequired = true;
    }
    return snapshot;
  });
  ui.state.hubSettingsOpen = true;
  const html = () => ui.nodes.get("#t3-hub-settings-general-pane").innerHTML;
  await ui.refreshOfficialTelemetry();
  assert.match(html(), /T3 官方遥测/);
  assert.match(html(), /多台电脑的用量汇总照常显示/);
  assert.equal((html().match(/data-action="toggle-official-telemetry"/g) || []).length, 1);
  assert.match(html(), /检测到手动配置/);
  assert.match(html(), /策略锁定关闭/);
  assert.doesNotMatch(html(), /待重启生效|已生效/);
  ui.root.contains = () => true;
  const toggle = { dataset: { action: "toggle-official-telemetry", key: "disableOfficialTelemetry" }, getAttribute: () => "false" };
  ui.onClick({ target: { closest: () => toggle } });
  await new Promise(setImmediate);
  assert.equal(calls.at(-1)[0], "settings:officialTelemetry:update");
  assert.equal(calls.at(-1)[1].disableOfficialTelemetry, true);
  assert.match(html(), /待重启生效[\s\S]*T3 Code HUD/);
  snapshot.runtime = { state: "applied", injected: true, restartRequired: false };
  await ui.refreshOfficialTelemetry();
  assert.match(html(), /关闭设置已生效/);
  assert.doesNotMatch(html(), /待重启生效/);
  ui.state.lang = "en";
  ui.renderHubSettingsPanel();
  assert.match(html(), /Official Telemetry/);
  assert.match(html(), /Opt-out active/);
  assert.match(html(), /mobile activity notifications/);
});

test("legacy Hub tabs migrate to memory without deleting saved data", () => {
  for (const legacyTab of ["skills", "mcp", "plugins", "hooks", "agents", "settings", "subagents", "board"]) {
    const writes = [];
    const ui = harness(async () => ({}), { localStorage: { getItem: (key) => key === "t3-hub-tab" ? legacyTab : null, setItem: (...args) => writes.push(args) } });
    assert.equal(ui.state.tab, "memory", `${legacyTab} page is migrated`);
    assert.ok(writes.some(([key, value]) => key === "t3-hub-tab" && value === "memory"));
  }
});

test("restored global or other-project memory selection safely migrates to current project", () => {
  for (const previousMemoryProject of ["global", "/previous-project"]) {
    const writes = [];
    const ui = harness(async () => ({}), {
      window: { __t3SidecarHub: { snapshot: () => ({ scope: "global", memoryProject: previousMemoryProject, memoryScope: "global" }) } },
      localStorage: { getItem: key => key === "t3-hub-scope" ? "global" : null, setItem: (...args) => writes.push(args) },
    });
    assert.equal(ui.state.scope, "project");
    assert.equal(ui.state.memoryProject, "current");
    assert.equal(ui.state.memoryScope, "smart");
    assert.ok(writes.some(([key, value]) => key === "t3-hub-scope" && value === "project"));

    confirmMemoryProject(ui, "/confirmed-project");
    assert.deepEqual(JSON.parse(JSON.stringify(ui.memoryPayload())), { projectRoot: "/confirmed-project", scope: "project", scopeFilter: "default", query: "", limit: 500 });
    assert.equal(ui.selectedMemoryRoot(), "/confirmed-project");
    ui.renderMemoryNav(); ui.renderNewMemory();
    assert.doesNotMatch(ui.nodes.get("#t3-hub-memory-nav").innerHTML, /global|全局通用/i);
  }
});

test("without a confirmed project, memory content reads stop and local service status stays independent", async () => {
  const calls = [], ui = harness(async (action, payload) => { calls.push({ action, payload }); return { items: [{ id: "should-not-show", title: "Wrong scope" }], agents: [] }; });
  ui.ready(); Object.assign(ui.state, { open: true, tab: "memory", connected: false, projectRoot: null });
  ui.cache.overview = { total: 900, projects: [{ slug: "global", total: 900 }] };
  ui.cache.memory = { items: [{ id: "stale", title: "Stale project memory" }] };
  await ui.loadTab();
  ui.renderMemory();
  const nav = ui.nodes.get("#t3-hub-memory-nav").innerHTML;
  const list = ui.nodes.get("#t3-hub-memory-list").innerHTML;
  assert.match(nav, /尚未确认项目/);
  assert.match(list, /请先确认当前项目/);
  assert.doesNotMatch(`${nav}${list}`, /Stale project memory|should-not-show|全局通用记忆/);
  assert.match(ui.content.innerHTML, /name="memoryQuery"[^>]*disabled/);
  assert.ok(calls.some(({ action }) => action === "memory:connections"));
  assert.ok(calls.some(({ action }) => action === "memory:agentAccess:get"));
  const embed = calls.find(({ action }) => action === "embed:status");
  assert.deepEqual(JSON.parse(JSON.stringify(embed.payload)), {});
  assert.ok(!calls.some(({ action }) => ["memory:list", "memory:search", "memory:overview", "memory:worktreeInfo", "memory:health"].includes(action)));
  await ui.refreshMemoryOverview(); await ui.loadMemories();
  assert.ok(!calls.some(({ action }) => ["memory:list", "memory:search", "memory:overview"].includes(action)));
  Object.assign(ui.state, { projectRoot: "/stale-unconfirmed-project", connected: false });
  ui.cache.memory = { items: [{ id: "stale-write", title: "Must not be edited", content: "stale" }] };
  ui.snapshot().drafts.__new = { title: "Blocked draft", content: "No confirmed project", scope: "project" };
  await ui.saveMemory(null); await ui.deleteMemory("stale-write"); await ui.promoteMemory("stale-write"); await ui.consolidateMemory(); await ui.rollbackMemory("stale-write", 1, "rev");
  assert.ok(!calls.some(({ action }) => ["memory:save", "memory:delete", "memory:promote", "memory:consolidate", "memory:rollback"].includes(action)));
});

test("opening memory reads local access and vector status without Dream or hidden catalogs", async () => {
  const calls = [];
  const ui = harness(async action => { calls.push(action); return { items: [], agents: [] }; });
  confirmMemoryProject(ui);
  await ui.loadTab();
  assert.ok(calls.includes("memory:connections"));
  assert.ok(calls.includes("memory:agentAccess:get"));
  assert.ok(calls.includes("memory:list"));
  assert.ok(calls.includes("memory:overview"));
  assert.ok(calls.includes("memory:worktreeInfo"));
  assert.ok(calls.includes("embed:status"), "the memory page reads actual model and service status");
  assert.doesNotMatch(calls.join(" "), /mcp:list|skills:list|plugins:list|hooks:list|subagents:list|memory:dream|memory:health|embed:switch|download|restart|orchestration/);
  ui.renderMemory();
  assert.doesNotMatch(ui.content.innerHTML, /AutoDream|梦境|自动整理计划|memory:dream/);
});

test("local memory onboarding reports pending providers without claiming setup, and disable keeps memories", async () => {
  const calls = [], setupSummary = {
    configured: 1, missing: 0, conflict: 0, unsupported: 0, unknown: 0, pending: 1, runtime: "unverified",
    providers: [
      { instanceId: "codex", displayName: "Codex", status: "configured" },
      { instanceId: "agy", displayName: '<img src=x onerror=alert(1)>', status: "pending", reason: "agy_native_helper_compatibility" },
    ],
  };
  const ui = harness(async (action, payload) => {
    calls.push({ action, payload });
    if (action === "memory:agentAccess:get") return { ok: true, enabled: false, state: "disabled", setupSummary };
    if (action === "memory:setup") return { ok: false, enabled: true, state: "enabled", setupSummary };
    if (action === "memory:agentAccess:set") return { ok: true, enabled: false, state: "disabled", setupSummary };
    if (action === "memory:list") return { items: [{ id: "keep", title: "Existing local note", content: "Retain this memory" }] };
    return {};
  });
  confirmMemoryProject(ui);
  await ui.loadTab();
  ui.renderMemory();
  let html = ui.nodes.get("#t3-hub-memory-access").innerHTML;
  assert.match(html, /允许本机 T3 Agent 使用记忆/);
  assert.match(html, /检查并接入/);
  assert.match(html, /复制首次接入提示词/);
  assert.match(html, /AGY/);
  assert.match(html, /待处理/);
  assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/);
  assert.match(html, /本机设置，不用于 Connect 远端会话/);

  await ui.runMemorySetup();
  html = ui.nodes.get("#t3-hub-memory-access").innerHTML;
  assert.ok(calls.some(({ action }) => action === "memory:setup"));
  assert.match(html, /待处理/);
  assert.doesNotMatch(html, /已接入成功/);

  const priorMemory = ui.cache.memory;
  await ui.setMemoryAgentAccess(false);
  html = ui.nodes.get("#t3-hub-memory-access").innerHTML;
  assert.ok(calls.some(({ action, payload }) => action === "memory:agentAccess:set" && payload.enabled === false));
  assert.match(html, /已关闭/);
  assert.equal(ui.cache.memory, priorMemory, "disabling agent access does not delete stored memories");
});

test("title memory switch treats unknown as off, controls local access, and reports the resulting state", async () => {
  const calls = [], setupSummary = { configured: 1, missing: 0, conflict: 0, unsupported: 0, unknown: 0, pending: 0, runtime: "unverified", providers: [{ instanceId: "codex", displayName: "Codex", status: "configured" }] };
  const ui = harness(async (action, payload) => {
    calls.push({ action, payload });
    if (action === "memory:agentAccess:set") return { ok: true, enabled: payload.enabled, state: payload.enabled ? "enabled" : "disabled", setupSummary };
    return {};
  });
  ui.renderMemoryTitleControls();
  assert.equal(ui.memoryToggle.getAttribute("aria-checked"), "mixed", "unknown is never shown as already enabled");
  await ui.toggleMemoryAccessFromTitle();
  assert.ok(calls.some(({ action, payload }) => action === "memory:agentAccess:set" && payload.enabled === true));
  assert.equal(ui.memoryToggle.getAttribute("aria-checked"), "true");
  assert.match(ui.memoryToggle.innerHTML, /开/);
  await ui.toggleMemoryAccessFromTitle();
  assert.ok(calls.some(({ action, payload }) => action === "memory:agentAccess:set" && payload.enabled === false));
  assert.equal(ui.memoryToggle.getAttribute("aria-checked"), "false");
  assert.match(ui.memoryToggle.innerHTML, /关/);
  assert.match(drawerSource, /本机设置，不用于 Connect 远端会话/);
});

test("memory services show backend model and port separately from stdio MCP, and copy a private-data-free config", async () => {
  const copied = [], ui = harness(undefined, { window: { navigator: { clipboard: { writeText: async (value) => copied.push(value) } } } });
  ui.cache.embed = { mode: "mlx", running: true, activeModelId: "active/model", configuredModelId: "configured/model", port: 9234 };
  ui.cache.agentAccess = { enabled: true, setupSummary: { configured: 3, conflict: 0, missing: 0, unsupported: 0, unknown: 0, pending: 0, runtime: "unverified", providers: [
    { instanceId: "codex", displayName: "Codex", status: "configured" }, { instanceId: "muse", displayName: "Muse", status: "configured" }, { instanceId: "claude", displayName: "Claude", status: "configured" },
  ] } };
  ui.cache.connections = { agents: [{ id: "t3", mcp: { status: "unknown", summary: "Matrix aggregate has no row" }, runtime: { status: "unknown", summary: "Current chat not verified" } }] };
  ui.renderMemoryRuntime();
  const html = ui.root.querySelector("#t3-hub-memory-runtime").innerHTML;
  assert.match(html, /active\/model/);
  assert.match(html, /configured\/model/);
  assert.match(html, /http:\/\/127\.0\.0\.1:9234/);
  assert.match(html, /本机 stdio/);
  assert.match(html, /不是 HTTP 地址/);
  assert.match(html, /已配置 3 个 Agent/);
  assert.match(html, /冲突 0/);
  assert.doesNotMatch(html, /Hub MCP 配置（Agent 汇总）<\/span><strong data-status="unknown">无法确认/);
  assert.match(html, /未验证/);
  ui.cache.agentAccess.enabled = null;
  ui.renderMemoryRuntime();
  assert.match(ui.root.querySelector("#t3-hub-memory-runtime").innerHTML, /已配置 3 个 Agent/, "known setup summary remains visible when only the access switch is unknown");
  assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/);
  await ui.copyMemoryMcpConfig();
  const config = JSON.parse(copied[0]);
  assert.deepEqual(config.mcpServers.t3_hub, { command: "/bin/sh", args: ["-c", 'exec "$HOME/.t3/bin/t3-mcp-router" --memory-only'] });
  assert.doesNotMatch(copied[0], /\/Users\/|token|secret|127\.0\.0\.1|~\/\.t3/);
});

test("vector model testing is explicit, sends no project or caller text, and reports backend results", async () => {
  const calls = [];
  let finish;
  const ui = harness((action, payload) => {
    calls.push({ action, payload });
    return new Promise(resolve => { finish = resolve; });
  });
  ui.cache.embed = { mode: "mlx", running: true, activeModelId: "active/model" };
  ui.renderMemoryRuntime();
  assert.match(ui.root.querySelector("#t3-hub-memory-runtime").innerHTML, /测试向量模型/);
  assert.equal(calls.length, 0, "rendering or refreshing the service card does not run a vector test");
  const run = ui.runMemoryVectorTest();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, "embed:test");
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].payload)), {});
  assert.match(ui.root.querySelector("#t3-hub-memory-runtime").innerHTML, /正在测试向量模型/);
  const duplicate = ui.runMemoryVectorTest();
  assert.equal(calls.length, 1, "a second click cannot queue another test while one is running");
  finish({ ok: true, modelId: "mlx-community/Octen-Embedding-4B-MLX-4bit", dimensions: 2560, latencyMs: 366 });
  await Promise.all([run, duplicate]);
  const html = ui.root.querySelector("#t3-hub-memory-runtime").innerHTML;
  assert.match(html, /测试成功/);
  assert.match(html, /Octen-Embedding-4B-MLX-4bit/);
  assert.match(html, /2560 维度/);
  assert.match(html, /366 ms/);
  assert.match(html, /无需打开 oMLX/);
});

test("vector model test failures are reported without claiming success", async () => {
  const ui = harness(async action => action === "embed:test" ? { ok: false, error: "model_not_ready" } : {});
  await ui.runMemoryVectorTest();
  const html = ui.root.querySelector("#t3-hub-memory-runtime").innerHTML;
  assert.match(html, /测试失败/);
  assert.match(html, /model_not_ready/);
  assert.doesNotMatch(html, /测试成功/);
});

test("first memory setup prompt uses the fixed local commands and verifies memory_status", async () => {
  const copied = [], ui = harness(undefined, { window: { navigator: { clipboard: { writeText: async (value) => copied.push(value) } } } });
  await ui.copyMemorySetupPrompt();
  assert.equal(copied.length, 1);
  assert.match(copied[0], /~\/\.t3\/bin\/t3-memory-setup status/);
  assert.match(copied[0], /~\/\.t3\/bin\/t3-memory-setup setup/);
  assert.match(copied[0], /memory_status/);
  assert.match(copied[0], /先确认本会话当前选中的 T3 项目与工作树/);
  assert.match(copied[0], /传当前 T3 项目的绝对 projectRoot/);
  assert.match(copied[0], /如提示项目未绑定，不改传别的路径绕过，请报告缺口/);
  assert.match(copied[0], /不查找或使用全局通用记忆/);
  assert.match(copied[0], /只改 Hub MCP/);
  assert.match(copied[0], /不要修改.*认证.*模型.*原生路由/);
  assert.match(copied[0], /不要重启 T3/);
});

test("memory connection matrix safely shows all agent states without claiming a live connection", () => {
  const malicious = '<img src=x onerror=alert(1)>';
  const ui = harness();
  ui.cache.connections = { ok: true, checkedAt: "2026-11-17T00:00:00.000Z", agents: [
    { id: "t3", mcp: { status: "configured", summary: "配置已发现", evidence: [malicious] }, skill: { status: "missing", summary: "没有托管 Skill" }, hook: { status: "unsupported", summary: "不支持 Hook" }, runtime: { status: "unverified", summary: "当前会话未验证" } },
    { id: "codex", label: malicious, mcp: { status: "configured", summary: malicious, evidence: [malicious] }, skill: { status: "unknown", summary: "无法确认", evidence: [] }, hook: { status: "unsupported", summary: "不适用", evidence: [] }, runtime: { status: "unverified", summary: "当前会话未验证" } },
    { id: "muse", mcp: { status: "missing", summary: "未配置" }, skill: { status: "missing", summary: "未配置" }, hook: { status: "unsupported", summary: "非必需" }, runtime: { status: "unverified", summary: "未验证" } },
    { id: "agy", mcp: { status: "configured", summary: "Provider 本地配置" }, skill: { status: "unknown", summary: "无法确认" }, hook: { status: "unsupported", summary: "非必需" }, runtime: { status: "unverified", summary: "未验证" } },
    { id: "claude", mcp: { status: "unknown", summary: "无法确认" }, skill: { status: "missing", summary: "未托管" }, hook: { status: "configured", summary: "找到记忆 Hook" }, runtime: { status: "unverified", summary: "未验证" } },
    { id: "pi", mcp: { status: "missing", summary: "未配置" }, skill: { status: "missing", summary: "未托管" }, hook: { status: "unsupported", summary: "非必需" }, runtime: { status: "unverified", summary: "未验证" } },
  ] };
  ui.renderMemoryConnections();
  const html = ui.nodes.get("#t3-hub-memory-connections").innerHTML;
  assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /已配置/);
  assert.match(html, /未配置/);
  assert.match(html, /不支持/);
  assert.match(html, /无法确认/);
  assert.match(html, /当前会话未验证/);
  assert.match(html, /AGY/);
  assert.match(html, /Hook 属于可选能力/);
  assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/);
});

test("memory connection failures degrade safely and offer refresh", () => {
  const ui = harness();
  ui.errors.connections = new Error("private config path should not leak");
  ui.renderMemoryConnections();
  const html = ui.nodes.get("#t3-hub-memory-connections").innerHTML;
  assert.match(html, /暂时无法读取接入状态/);
  assert.match(html, /data-action="refresh-memory-connections"/);
  assert.doesNotMatch(html, /private config path/);
});

test("title controls follow the native Thread actions heading without a floating Hub handle", () => {
  const parent = { inserted: null };
  const button = { parentElement: parent, after(element) { parent.inserted = element; element.parentElement = parent; element.previousElementSibling = this; }, appendChild() { throw new Error("plan button must not be nested inside native button"); } };
  const heading = {
    textContent: "Current chat", tagName: "H1", parentElement: button,
    getBoundingClientRect: () => ({ left: 40, right: 220, top: 18, bottom: 44, width: 180, height: 26 }),
    getClientRects: () => [{ width: 180, height: 26 }], getAttribute: () => null,
    closest: (selector) => selector === "button,[role=button]" ? button : null,
  };
  const ui = harness(undefined, { document: { querySelectorAll: (selector) => selector.includes("thread-actions") ? [heading] : [] } });
  const entry = ui.root.querySelector("#t3-hub-plan-handle");
  const controls = ui.titleControls;
  assert.equal(ui.findConversationTitleAnchor(), heading, "breadcrumb headings in native navigation remain eligible");
  controls.appendChild(entry);
  assert.equal(ui.placePlanHandle(), true);
  assert.equal(parent.inserted, controls);
  assert.equal(controls.parentElement, parent);
  assert.equal(entry.parentElement, controls, "the current plan pill stays in the inline title controls");
  assert.equal(entry.style.WebkitAppRegion, "no-drag");
  assert.match(drawerSource, /id="t3-hub-memory-handle"[^>]*data-action="open-memory"/);
  assert.match(drawerSource, /id="t3-hub-memory-toggle" role="switch"/);
  assert.doesNotMatch(drawerSource, /<button type="button" id="t3-hub-handle"/);
  assert.doesNotMatch(drawerSource, /#t3-hub-handle\{position:fixed/);
  ui.applyTheme("dark");
  assert.equal(entry.style.getPropertyValue("--hub-ink"), "#f8fafc");
  ui.destroy();
  assert.equal(entry.removed, true, "destroy removes a button already moved outside the Hub root");
  assert.equal(controls.removed, true, "destroy removes the whole external title control group");
  assert.match(drawerSource, /getElementById\("t3-hub-title-controls"\)\?\.remove\(\)/, "a hot rebuild removes the previous external title controls");
});

test("plan indicator hover, touch and keyboard activation keep the popover usable", () => {
  const ui = harness(), entry = ui.root.querySelector("#t3-hub-plan-handle");
  ui.ready();
  const heading = { textContent: "Current chat", parentElement: null, getBoundingClientRect: () => ({ left: 40, right: 220, top: 18, bottom: 44, width: 180, height: 26 }), getClientRects: () => [{ width: 180, height: 26 }], getAttribute: () => null, closest: () => null, after(element) { element.parentElement = this.parentElement; element.previousElementSibling = this; } };
  ui.sandbox.document.querySelectorAll = (selector) => selector.includes("thread-actions") ? [heading] : [];
  ui.state.connected = true; ui.state.threadId = "thread-a"; ui.cache.board = { steps: [{ id: "step", text: "Plan", status: "pending" }] };
  ui.renderLiveBoard();
  assert.equal(entry.hidden, false);
  const event = (detail = 1) => ({ detail, preventDefault() {}, stopPropagation() {} });
  ui.handlePlanPointerEnter({ pointerType: "touch" });
  assert.equal(ui.state.planOpen, false, "touch pointerenter does not act like hover");
  ui.handlePlanPointerDown({ pointerType: "touch" });
  ui.handlePlanClick(event());
  assert.equal(ui.state.planOpen, true); assert.equal(ui.state.planPinned, true);
  ui.handlePlanPointerLeave({ relatedTarget: null });
  assert.equal(ui.state.planPinned, true, "pointerleave cannot dismiss a touch-pinned popover");
  ui.handlePlanPointerDown({ pointerType: "touch" });
  ui.handlePlanClick(event());
  assert.equal(ui.state.planOpen, false, "a second touch click closes the pinned popover");

  ui.handlePlanPointerEnter({ pointerType: "mouse" });
  assert.equal(ui.state.planOpen, true); assert.equal(ui.state.planPinned, false, "mouse hover opens without pinning");
  ui.handlePlanPointerLeave({ relatedTarget: null });
  ui.handlePlanClick(event(0));
  assert.equal(ui.state.planPinned, true, "keyboard activation pins the popover for reading");
});

test("title plan pill shows the active step in a blue progress ring and marks a finished plan", () => {
  const ui = harness();
  ui.ready(); Object.assign(ui.state, { connected: true, threadId: "thread-a", context: { threadId: "thread-a" } });
  ui.cache.board = { steps: [
    { id: "1", text: "First", status: "completed" }, { id: "2", text: "Second", status: "in-progress" },
    { id: "3", text: "Third", status: "pending" }, { id: "4", text: "Fourth", status: "pending" },
    { id: "5", text: "Fifth", status: "pending" }, { id: "6", text: "Sixth", status: "pending" },
  ], progress: { completed: 1, total: 6 } };
  ui.renderLiveBoard();
  const pill = ui.root.querySelector("#t3-hub-plan-handle");
  assert.match(pill.innerHTML, /hub-plan-ring/);
  assert.match(pill.innerHTML, /第 2 \/ 6 步/);
  assert.match(drawerSource, /\.hub-plan-ring-progress\{[^}]*stroke:#3980f6/);
  assert.equal(ui.planStepProgress().current, 2);

  ui.cache.board = { steps: Array.from({ length: 6 }, (_, index) => ({ id: String(index), text: `Done ${index + 1}`, status: "completed" })), progress: { completed: 6, total: 6 } };
  ui.renderLiveBoard();
  assert.match(pill.innerHTML, /第 6 \/ 6 步 · 已完成/);
  assert.match(pill.innerHTML, /stroke-dashoffset="0\.00"/);
});

test("project changes invalidate connection status before the next memory refresh", async () => {
  const calls = [], ui = harness(async (action, payload) => { calls.push({ action, payload }); return { agents: [] }; });
  Object.assign(ui.state, { open: true, connected: true, tab: "memory", projectRoot: "/project-b", threadId: "thread-b", context: { threadId: "thread-b", projectRoot: "/project-b" } });
  ui.ready(); ui.setCurrentRoute();
  ui.cache.connections = { agents: [{ id: "codex", mcp: { status: "configured" } }] };
  ui.errors.connections = new Error("stale project error");
  ui.resetProjectData();
  assert.equal(ui.cache.connections, null);
  assert.equal(ui.errors.connections, undefined);
  await ui.loadTab();
  assert.ok(calls.some(({ action }) => action === "memory:connections"));
});

test("switching project scopes clears prior memory before the new project responds", async () => {
  const envA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", envB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", calls = [];
  const ui = harness(async (action, payload) => {
    calls.push({ action, payload });
    if (action === "hub:getContext") return { threadId: "thread-b", environmentId: envB, projectRoot: "/project-b" };
    if (action === "memory:connections") return { agents: [] };
    if (action === "memory:overview") return { currentProjectSlug: "project-b" };
    if (action === "memory:worktreeInfo") return {};
    if (action === "memory:list") return { items: [] };
    return {};
  });
  ui.ready();
  Object.assign(ui.state, { open: true, connected: true, tab: "memory", threadId: "thread-a", projectRoot: "/project-a", context: { threadId: "thread-a", environmentId: envA, projectRoot: "/project-a" } });
  Object.assign(ui.sandbox.location, { pathname: "/", hash: `#/${envA}/thread-a`, href: `t3code://app/#/${envA}/thread-a` });
  ui.setCurrentRoute();
  ui.cache.memory = { items: [{ id: "secret-a", title: "Private from project A", content: "Private from project A" }] };
  ui.renderMemoryList();
  assert.match(ui.root.querySelector("#t3-hub-memory-list").innerHTML, /Private from project A/);

  Object.assign(ui.sandbox.location, { hash: `#/${envB}/thread-b`, href: `t3code://app/#/${envB}/thread-b` });
  ui.checkRoute();
  assert.equal(ui.cache.memory, null);
  assert.equal(ui.cache.connections, null);
  assert.doesNotMatch(ui.root.querySelector("#t3-hub-memory-list").innerHTML, /Private from project A/, "old memory disappears synchronously on scope switch");
  await new Promise((resolve) => setImmediate(resolve));
  assert.doesNotMatch(ui.root.querySelector("#t3-hub-memory-list").innerHTML, /Private from project A/);
  assert.ok(calls.some((entry) => entry.action === "memory:list" && entry.payload.projectRoot === "/project-b"));
});

test("Connect plan projection selects only the latest matching main-thread plan", () => {
  const ui = harness(), threadId = "main-thread", env = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const projection = {
    thread: { id: threadId },
    plans: [
      { id: "old", threadId, kind: "todo_list", status: "active", steps: [{ id: "old-step", text: "Old plan", status: "pending" }] },
      { id: "latest", threadId, kind: "proposed_plan", status: "active", steps: [{ id: "done", title: "Completed", status: "completed" }, { id: "next", title: "Next", status: "running" }] },
      { id: "superseded", threadId, kind: "proposed_plan", status: "superseded", steps: [{ text: "Superseded" }] },
      { id: "child", threadId: "child-thread", kind: "todo_list", status: "active", steps: [{ text: "Child task" }] },
    ],
    turnItems: [
      { threadId, type: "todo_list", planId: "old", updatedAt: "2026-11-17T09:00:00Z" },
      { threadId, type: "proposed_plan", planId: "latest", updatedAt: "2026-11-17T10:00:00Z" },
      { threadId, type: "todo_list", planId: "latest", updatedAt: "2026-11-17T12:00:00Z" },
      { threadId: "sibling-thread", type: "proposed_plan", planId: "latest", updatedAt: "2026-11-17T13:00:00Z" },
    ],
    visibleTurnItems: [{ item: { threadId, type: "proposed_plan", planId: "latest", updatedAt: "2026-11-17T10:00:00Z" } }],
  };
  const board = ui.normalizeRemoteThreadPlan(projection, env, threadId);
  assert.equal(board.remote, true); assert.equal(board.environmentId, env); assert.equal(board.threadId, threadId);
  assert.equal(board.source, "t3-connect");
  assert.deepEqual(JSON.parse(JSON.stringify(board.steps)), [
    { id: "done", text: "Completed", status: "completed" }, { id: "next", text: "Next", status: "in-progress" },
  ]);
  assert.equal(board.updatedAt, "2026-11-17T10:00:00Z");
  assert.doesNotMatch(JSON.stringify(board), /Old plan|Superseded|Child task/);
  assert.throws(() => ui.normalizeRemoteThreadPlan({ ...projection, thread: { id: "sibling-thread" } }, env, threadId), /remote thread mismatch/);
});

test("Connect can read only the validated Hub plan mirror from the current remote project", async () => {
  const environment = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", threadId = "11111111-1111-4111-8111-111111111111", projectRoot = "/remote/current-project", calls = [];
  const mirror = { schemaVersion: 1, threadId, projectRoot, steps: [{ id: "a", text: "First", status: "completed" }, { id: "b", text: "Next", status: "running" }, { id: "xss", text: '<img src=x onerror=alert(1)>', status: "pending" }], progress: { completed: 1, inProgress: 1, pending: 0, total: 2, label: "1/2", percent: 50 }, source: "hub-mcp", updatedAt: "2026-11-17T12:00:00.000Z" };
  const ui = harness(async (action, payload) => { calls.push({ local: true, action, payload }); return {}; }, {
    location: { pathname: `/${environment}/${threadId}`, hash: `#/${environment}/${threadId}` },
    window: { __TSR_ROUTER__: { state: { location: { pathname: `/${environment}/${threadId}`, searchStr: "" } } }, __t3HudRemoteProject: (identity) => {
      calls.push({ remote: true, tag: "projectResolver", payload: identity });
      return identity.environmentId === environment && identity.threadId === threadId ? { environmentId: environment, threadId, projectRoot } : null;
    }, __t3HudRemoteRpc: async (environmentId, tag, payload) => {
      calls.push({ remote: true, environmentId, tag, payload });
      return tag === "orchestration.getThreadProjection" ? { ok: true, value: { thread: { id: threadId }, plans: [], turnItems: [], visibleTurnItems: [] } } : { ok: true, value: { contents: JSON.stringify(mirror) } };
    } },
  });
  ui.ready(); Object.assign(ui.state, { threadId, connected: false, context: { threadId, environmentId: environment, remote: true, projectRoot: "/stale-context-project" }, projectRoot: "/local/project" });
  await ui.pollBoard();
  const fileRead = calls.find((call) => call.remote && call.tag === "projects.readFile");
  assert.equal(fileRead.environmentId, environment);
  assert.deepEqual(JSON.parse(JSON.stringify(fileRead.payload)), { cwd: projectRoot, relativePath: `.t3-hub/plans/${threadId}.json`, allowMissing: true });
  assert.equal(ui.cache.board.source, "hub-mirror");
  assert.deepEqual(JSON.parse(JSON.stringify(ui.cache.board.steps)), [{ id: "a", text: "First", status: "completed" }, { id: "b", text: "Next", status: "in-progress" }, { id: "xss", text: '<img src=x onerror=alert(1)>', status: "pending" }]);
  ui.renderLiveBoard();
  const planHtml = ui.root.querySelector("#t3-hub-live-board").innerHTML;
  assert.match(planHtml, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(planHtml, /<img src=x onerror=alert\(1\)>/);
  assert.equal(calls.some((call) => call.local && call.action === "board:get"), false);

  const olderMirror = ui.normalizeRemotePlanMirror(JSON.stringify({ ...mirror, updatedAt: "2026-11-17T11:00:00.000Z" }), environment, threadId, projectRoot);
  const newerNative = ui.normalizeRemoteThreadPlan({ thread: { id: threadId }, plans: [{ id: "native", threadId, kind: "todo_list", status: "active", steps: [{ text: "Native" }] }], turnItems: [{ threadId, type: "todo_list", planId: "native", updatedAt: "2026-11-17T12:30:00.000Z" }] }, environment, threadId);
  assert.equal(ui.newestRemotePlan(newerNative, olderMirror).source, "t3-connect");
  const newerClear = ui.normalizeRemotePlanMirror(JSON.stringify({ ...mirror, source: "hub-clear", cleared: true, steps: [], updatedAt: "2026-11-17T13:00:00.000Z" }), environment, threadId, projectRoot);
  assert.equal(ui.newestRemotePlan(newerNative, newerClear).cleared, true, "a newer Hub clear suppresses the older native plan");
  const sameTimeClear = ui.normalizeRemotePlanMirror(JSON.stringify({ ...mirror, source: "hub-clear", cleared: true, steps: [], updatedAt: newerNative.updatedAt }), environment, threadId, projectRoot);
  assert.equal(ui.newestRemotePlan(newerNative, sameTimeClear).cleared, true, "a clear marker wins a timestamp tie rather than reviving the native plan");
  const newerUnavailable = ui.normalizeRemotePlanMirror(JSON.stringify({ schemaVersion: 1, threadId, projectRoot, steps: [], progress: {}, source: "hub-unavailable", unavailable: true, updatedAt: "2026-11-17T13:30:00.000Z" }), environment, threadId, projectRoot);
  assert.equal(ui.newestRemotePlan(newerNative, newerUnavailable).unavailable, true, "a newer oversized-plan marker suppresses an older native plan");
  assert.throws(() => ui.normalizeRemotePlanMirror(JSON.stringify({ ...mirror, projectRoot: "/other/project" }), environment, threadId, projectRoot), /remote plan unavailable/);
  assert.throws(() => ui.normalizeRemotePlanMirror(JSON.stringify({ ...mirror, threadId: "other-thread" }), environment, threadId, projectRoot), /remote plan unavailable/);
});

test("Connect never borrows the stale context or local project when its strict project lookup misses", async () => {
  const environment = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", threadId = "thread-a", calls = [];
  const ui = harness(async (action, payload) => { calls.push({ local: true, action, payload }); throw new Error("remote route leaked to local board"); }, {
    location: { pathname: `/${environment}/${threadId}`, hash: `#/${environment}/${threadId}` },
    window: {
      __TSR_ROUTER__: { state: { location: { pathname: `/${environment}/${threadId}`, searchStr: "" } } },
      __t3HudRemoteProject: () => ({ environmentId: environment, threadId: "another-thread", projectRoot: "/remote/wrong-thread" }),
      __t3HudRemoteRpc: async (environmentId, tag, payload) => {
        calls.push({ remote: true, environmentId, tag, payload });
        return { ok: true, value: { thread: { id: threadId }, plans: [], turnItems: [] } };
      },
    },
  });
  ui.ready(); Object.assign(ui.state, { connected: false, threadId, context: { threadId, environmentId: environment, remote: true, projectRoot: "/stale-context-project" }, projectRoot: "/local/project" });
  await ui.pollBoard();
  assert.equal(calls.some(({ remote, tag }) => remote && tag === "projects.readFile"), false);
  assert.equal(calls.some(({ local, action }) => local && action === "board:get"), false);
  assert.equal(ui.cache.board.remote, true);
  assert.equal(ui.cache.board.steps.length, 0, "an empty remote projection never borrows a local plan");
  assert.equal(ui.root.querySelector("#t3-hub-plan-handle").hidden, true);
});

test("the title pill reads a verified local Codex child directly and discards its plan after navigating away", async () => {
  const environmentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const threadId = "thread:delegated-task:command%3Afixture", parentId = "parent-thread";
  const projectRoot = "/fixture/project", route = (env, tid) => `/${env}/${encodeURIComponent(tid)}`;
  const router = { state: { location: { pathname: route(environmentId, threadId) } } };
  const context = (tid) => ({ threadId: tid, projectRoot, environmentId });
  const plan = { threadId, projectRoot, source: "t3-native", progress: { completed: 2, total: 5 }, steps: [
    { text: "First checked step", status: "completed" },
    { text: "Second checked step", status: "completed" },
    { text: "Current child step", status: "in_progress" },
    { text: "Child step four", status: "pending" },
    { text: "Child step five", status: "pending" },
  ] };
  const calls = [];
  let finishChildRead;
  const heading = {
    ...node(), textContent: "Current child chat",
    getBoundingClientRect: () => ({ left: 40, right: 220, top: 18, bottom: 44, width: 180, height: 26 }),
    after(element) { element.parentElement = {}; element.previousElementSibling = this; },
  };
  const ui = harness(async (action, payload) => {
    calls.push({ action, payload });
    if (action === "hub:getContext") return context(parentId);
    assert.equal(action, "board:get");
    if (payload.threadId === parentId) return { ...context(parentId), steps: [] };
    assert.equal(payload.threadId, threadId);
    if (calls.length === 1) return plan;
    return new Promise((resolve) => { finishChildRead = resolve; });
  }, {
    document: { querySelectorAll: (selector) => selector.includes("thread-actions") ? [heading] : [] },
    window: {
      __TSR_ROUTER__: router,
      // Native local chat components expose the same workspace props as Connect.
      __t3HudRemoteProject: (identity) => ({ ...identity, projectRoot }),
      __t3HudRemoteRpc: async (env, tag) => {
        calls.push({ action: tag, env });
        return { ok: false, error: "projection unavailable" };
      },
    },
  });
  ui.ready();
  Object.assign(ui.state, { threadId, projectRoot, connected: true, context: context(threadId) });
  ui.setCurrentRoute();
  assert.equal(await ui.pollBoard(), true);
  assert.deepEqual(calls.map(({ action }) => action), ["board:get"]);
  assert.equal(calls[0].payload.environmentId, environmentId);
  assert.equal(calls[0].payload.projectRoot, projectRoot);
  assert.equal(ui.planStepProgress().completed, 2);
  assert.equal(ui.planStepProgress().total, 5);
  const pill = ui.root.querySelector("#t3-hub-plan-handle");
  const popover = ui.root.querySelector("#t3-hub-live-board");
  assert.equal(pill.hidden, false);
  assert.match(pill.innerHTML, /第 3 \/ 5 步/);
  ui.setPlanPopover(true);
  assert.equal(popover.hidden, false);
  assert.match(popover.innerHTML, /Current child step/);
  assert.match(popover.innerHTML, /已完成 2 项/);
  const oldRead = ui.pollBoard();
  router.state.location.pathname = route(environmentId, parentId);
  finishChildRead(plan);
  assert.equal(await oldRead, false, "a child response after the route changes is stale before the route observer runs");
  ui.positionConversationTools();
  assert.equal(pill.hidden, true);
  ui.checkRoute();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ui.cache.board.threadId, parentId);
  assert.equal(pill.hidden, true, "a parent without its own plan does not display the child's steps");
  assert.doesNotMatch(popover.innerHTML, /Current child step/);
});

test("a Connect child reusing a local thread and workspace is read only from its active environment", async () => {
  const local = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", remote = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const threadId = "thread:delegated-task:command%3Afixture", projectRoot = "/fixture/project";
  const route = `/${remote}/${encodeURIComponent(threadId)}`;
  const calls = [];
  const ui = harness(async (action) => { calls.push({ action }); return {}; }, {
    window: {
      __TSR_ROUTER__: { state: { location: { pathname: route } } },
      __t3HudRemoteProject: (identity) => ({ ...identity, projectRoot }),
      __t3HudRemoteRpc: async (environmentId, tag, payload) => {
        calls.push({ environmentId, tag, payload });
        if (tag === "projects.readFile") return { ok: true, value: { contents: "" } };
        return { ok: true, value: { thread: { id: threadId }, plans: [
          { id: "child-plan", threadId, kind: "proposed_plan", markdown: "Exact remote child plan" },
          { id: "parent-plan", threadId: "parent-thread", kind: "proposed_plan", markdown: "Parent plan" },
        ], turnItems: [
          { threadId, type: "proposed_plan", planId: "child-plan", updatedAt: "2026-11-17T10:00:00Z" },
          { threadId: "parent-thread", type: "proposed_plan", planId: "parent-plan", updatedAt: "2026-11-17T11:00:00Z" },
        ] } };
      },
    },
  });
  ui.ready();
  Object.assign(ui.state, { threadId, projectRoot, connected: true, context: { threadId, projectRoot, environmentId: local } });
  assert.equal(await ui.pollBoard(), true);
  assert.equal(ui.cache.board.planMarkdown, "Exact remote child plan");
  assert.ok(calls.every((call) => call.environmentId === remote));
  assert.equal(calls[0].payload.threadId, threadId);
});

test("Hub plan mirror path is a stable UUID and cannot inject a path segment", async () => {
  const ui = harness();
  const first = await ui.planMirrorRelativePath("main-thread:local"), second = await ui.planMirrorRelativePath("main-thread:local");
  assert.equal(first, second);
  assert.match(first, /^\.t3-hub\/plans\/[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/);
});

test("Connect plan uses the active router environment despite a stale hash and never falls back locally", async () => {
  const envA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", envB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", calls = [];
  const projection = { thread: { id: "thread-b" }, plans: [], turnItems: [] };
  const ui = harness(async (action, payload) => { calls.push({ local: true, action, payload }); return {}; }, {
    location: { pathname: `/${envA}/thread-a`, hash: `#/${envA}/thread-a` },
    window: {
      __TSR_ROUTER__: { state: { location: { pathname: `/${envB}/thread-b`, searchStr: "" } } },
      __t3HudRemoteRpc: async (environmentId, tag, payload) => { calls.push({ remote: true, environmentId, tag, payload }); return { ok: true, value: projection }; },
    },
  });
  ui.ready();
  Object.assign(ui.state, { connected: false, context: null, contextError: "无法确认当前运行环境", threadId: "thread-b" });
  assert.equal(ui.remotePlanEnvironmentId(), envB);
  await ui.pollBoard();
  const remote = calls.find((call) => call.remote);
  assert.equal(remote.environmentId, envB);
  assert.equal(remote.tag, "orchestration.getThreadProjection");
  assert.deepEqual(JSON.parse(JSON.stringify(remote.payload)), { threadId: "thread-b" });
  assert.equal(calls.some((call) => call.local && call.action === "board:get"), false);
  assert.equal(ui.cache.board.environmentId, envB);
  assert.equal(ui.remotePlanContextReady(), true);

  const down = harness(async action => { calls.push({ local: true, action }); return {}; }, {
    location: { pathname: `/${envB}/thread-b`, hash: "" },
    window: { __t3HudRemoteRpc: async (environmentId) => { calls.push({ remote: true, environmentId }); return { ok: false, error: "forbidden" }; } },
  });
  down.ready(); Object.assign(down.state, { connected: false, context: null, contextError: "remote", threadId: "thread-b" });
  await down.pollBoard();
  assert.equal(down.errors.board.message, "remote plan unavailable");
  assert.equal(calls.some((call) => call.local && call.action === "board:get"), false, "remote denial never leaks into a local board read");
});

test("a late Connect plan reply from the previous environment cannot replace the new thread", async () => {
  const envA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", envB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const pending = new Map(), routed = [];
  const ui = harness(async () => { assert.fail("a remote thread must never read the local board"); }, {
    location: { pathname: `/${envA}/thread-a`, hash: `#/${envA}/thread-a` },
    window: { __TSR_ROUTER__: { state: { location: { pathname: `/${envA}/thread-a`, searchStr: "" } } }, __t3HudRemoteRpc: (environmentId, tag, payload) => {
      routed.push({ environmentId, tag, payload });
      if (tag === "projects.readFile") return Promise.resolve({ ok: true, value: { contents: "" } });
      return new Promise((resolve) => pending.set(environmentId, resolve));
    } },
  });
  ui.ready(); Object.assign(ui.state, { threadId: "thread-a", context: { threadId: "thread-a", environmentId: envA, remote: true, projectRoot: "/remote/a" }, connected: false });
  const oldRead = ui.pollBoard();
  ui.sandbox.window.__TSR_ROUTER__.state.location.pathname = `/${envB}/thread-b`;
  ui.state.context = { threadId: "thread-b", environmentId: envB, remote: true, projectRoot: "/remote/b" };
  ui.syncThread(true);
  ui.state.threadId = "thread-b";
  const newRead = ui.pollBoard();
  assert.deepEqual(routed.filter((entry) => entry.tag === "orchestration.getThreadProjection").map((entry) => entry.environmentId), [envA, envB]);
  assert.equal(ui.remotePlanEnvironmentId(), envB, "the router's active environment wins over a stale location hash");
  pending.get(envB)({ ok: true, value: { thread: { id: "thread-b" }, plans: [], turnItems: [], visibleTurnItems: [] } });
  await newRead;
  assert.equal(ui.cache.board.environmentId, envB);
  pending.get(envA)({ ok: true, value: { thread: { id: "thread-a" }, plans: [{ id: "old", threadId: "thread-a", kind: "todo_list", steps: [{ text: "old plan" }] }], turnItems: [] } });
  await oldRead;
  assert.equal(ui.cache.board.environmentId, envB, "the late old response is discarded");
  assert.equal(ui.root.querySelector("#t3-hub-plan-handle").hidden, true, "an empty current-thread projection has no plan button");
});

test("Hub no longer intercepts native composer input or keyboard shortcuts", () => {
  assert.doesNotMatch(drawerSource, /listen\(document,\s*"(?:input|focusin|click|keyup|keydown)"[^;]*onComposer/);
  assert.doesNotMatch(drawerSource, /function (?:openPicker|renderSlash|onComposerKeydown)\b/);
  assert.doesNotMatch(drawerSource, /t3-hub-slash-palette|request\("slash:list"/);
});

function fixture(t) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-v3-frontend-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  for (const dir of [".codex", ".config/muse", ".pi/agent"]) fs.mkdirSync(path.join(homeDir, dir), { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".codex/config.toml"), '# Preserve this comment\nmodel = "codex-only"\nmodel_reasoning_effort = "medium"\n[mcp_servers.keep]\ncommand = "keep"\n');
  fs.writeFileSync(path.join(homeDir, ".config/muse/settings.json"), JSON.stringify({ model: "muse-only", permissionMode: "ask", preserved: 42 }));
  fs.writeFileSync(path.join(homeDir, ".pi/agent/settings.json"), JSON.stringify({ defaultModel: "pi-only", defaultProvider: "pi-provider", thinkingLevel: "high" }));
  const manager = createHostSettingsManager({ homeDir });
  const calls = [];
  const rpc = async (action, payload) => {
    calls.push({ action, payload: JSON.parse(JSON.stringify(payload)) });
    try {
      if (action === "settings:get") return manager.getSettingsSnapshot();
      if (action === "settings:update") return manager.updateHostSetting(payload);
      if (action === "settings:getRule") return manager.getRuleContent(payload.host);
      if (action === "settings:saveRule") return manager.saveRuleContent(payload.host, payload.content, payload.expectedContent, payload.expectedTarget);
      throw new Error(`Unexpected RPC: ${action}`);
    } catch (error) { return { ok: false, error: error.message }; }
  };
  return { homeDir, manager, calls, rpc };
}

function change(ui, key, value) {
  ui.onInput({ target: { name: "native-setting", dataset: { settingsKey: key }, value } });
}

function nativeControl(ui, key) {
  const controls = [...ui.content.innerHTML.matchAll(/<input\b[^>]*>|<textarea\b[^>]*>[^]*?<\/textarea>/g)];
  const control = controls.find(([tag]) => tag.slice(0, tag.indexOf(">") + 1).includes(`data-settings-key="${key}"`));
  assert.ok(control, `missing native settings control: ${key}`);
  const [opening, tagName, attributes] = control[0].match(/^<(input|textarea)\b([^>]*)>/);
  const body = tagName === "textarea" ? control[0].slice(opening.length, -"</textarea>".length) : "";
  const text = tagName === "textarea" ? body.replace(/\r\n?/g, "\n").replace(/^\n/, "") : attributes.match(/\bvalue="([^"]*)"/)[1];
  const entities = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#13": "\r", "#10": "\n" };
  const value = text.replace(/&(amp|lt|gt|quot|#39|#13|#10);/g, (_, name) => entities[name]);
  return { tagName, attributes, value: tagName === "textarea" ? value.replace(/\r\n?/g, "\n") : value.replace(/[\r\n]/g, "") };
}

function inputValue(ui, key) { return nativeControl(ui, key).value; }

function clickSettingsAction(ui, dataset) {
  const button = node();
  Object.assign(button, { dataset, tagName: "BUTTON", isConnected: true });
  ui.root.contains = (target) => target === button;
  ui.onClick({ target: { closest: () => button } });
  return button;
}

function clickClearSettings(ui, key) {
  assert.match(ui.content.innerHTML, new RegExp(`data-host-field-clear="${key}"`), `missing clear action for ${key}`);
  clickSettingsAction(ui, { action: "clear-native-setting", hostFieldClear: key });
}

async function clickSaveSettings(ui) {
  const button = clickSettingsAction(ui, { action: "save-native-settings" });
  await new Promise(setImmediate);
  assert.equal(button.disabled, false, "the save button finishes its work");
}

function assertInert(html) {
  for (const attack of attacks) assert.ok(!html.includes(attack), `raw attack in HTML: ${attack}`);
  for (const [tag] of html.matchAll(/<[A-Za-z](?:"[^"]*"|'[^']*'|[^"'<>])*>/g)) {
    const attributes = tag.replace(/"[^"]*"|'[^']*'/g, '""');
    assert.doesNotMatch(attributes, /\s(?:on\w+|autofocus)\s*(?:=|>)/i);
  }
  assert.doesNotMatch(html, /(?:src|href)\s*=\s*["'](?:javascript|vbscript|file):/i);
}

test("settings renders only the selected host from real flat snapshots and wrapped snapshots", (t) => {
  const { manager, homeDir } = fixture(t);
  const ui = harness();
  for (const wrapped of [false, true]) for (const host of ["codex", "muse", "pi"]) {
    const snapshot = manager.getSettingsSnapshot();
    ui.cache.settings = wrapped ? { hosts: snapshot } : snapshot;
    ui.state.settingsHost = host;
    ui.renderSettings();
    assert.equal(ui.settingsValues().path, snapshot[host].path);
    assert.ok(ui.content.innerHTML.includes(path.join(homeDir, host === "codex" ? ".codex/config.toml" : host === "muse" ? ".config/muse/settings.json" : ".pi/agent/settings.json")));
    assert.match(ui.content.innerHTML, new RegExp(`${host}-only`));
    for (const other of ["codex", "muse", "pi"].filter((x) => x !== host)) assert.ok(!ui.content.innerHTML.includes(`${other}-only`));
  }
});

test("settings submits changed keys as {host,key,value}, persists and refreshes without touching unrelated content", async (t) => {
  const f = fixture(t), ui = harness(f.rpc);
  await ui.loadSettings();
  ui.renderSettings();
  change(ui, "model", "new-model");
  change(ui, "model_reasoning_effort", "high");
  await ui.saveNativeSettings();
  assert.deepEqual(f.calls.filter((x) => x.action === "settings:update").map((x) => x.payload), [
    { host: "codex", key: "model", value: "new-model" },
    { host: "codex", key: "model_reasoning_effort", value: "high" },
  ]);
  const disk = fs.readFileSync(path.join(f.homeDir, ".codex/config.toml"), "utf8");
  assert.match(disk, /model = "new-model"/);
  assert.match(disk, /# Preserve this comment/);
  assert.match(disk, /\[mcp_servers.keep\]\ncommand = "keep"/);
  assert.equal(ui.settingsValues().model, "new-model");
  assert.equal(ui.state.settingsDirty, false);
  assert.match(ui.nodes.get(".hub-toast").innerHTML, /已保存/);
  assert.ok(f.calls.filter((x) => x.action === "settings:get").length >= 2);
});

test("host field whitelists match the manager, and Muse/Pi save their own JSON files", async (t) => {
  const f = fixture(t), ui = harness(f.rpc);
  for (const [host, keys] of [["codex", CODEX_EDITABLE_KEYS], ["muse", MUSE_KEYS], ["pi", PI_KEYS]]) {
    ui.state.settingsHost = host;
    await ui.loadSettings(true);
    ui.renderSettings();
    assert.deepEqual([...ui.content.innerHTML.matchAll(/data-settings-key="([^"]+)"/g)].map((m) => m[1]).sort(), [...keys].sort());
    if (host === "codex") continue;
    const key = host === "muse" ? "permissionMode" : "thinkingLevel";
    const value = host === "muse" ? "ask-before-edits" : "medium";
    change(ui, key, value);
    await ui.saveNativeSettings();
    assert.equal(f.calls.filter((x) => x.action === "settings:update").at(-1).payload.host, host);
    const disk = JSON.parse(fs.readFileSync(path.join(f.homeDir, host === "muse" ? ".config/muse/settings.json" : ".pi/agent/settings.json"), "utf8"));
    assert.equal(disk[key], value);
    if (host === "muse") assert.equal(disk.preserved, 42);
    else assert.equal(disk.defaultProvider, "pi-provider");
  }
});

test("Muse defaultModel and permissionMode populate their own inputs without copying the overview model", async (t) => {
  const f = fixture(t), ui = harness(f.rpc);
  fs.writeFileSync(path.join(f.homeDir, ".config/muse/settings.json"), JSON.stringify({ defaultModel: "muse-default-only", permissionMode: "ask-before-edits" }));
  ui.state.settingsHost = "muse";
  await ui.loadSettings();
  ui.renderSettings();
  assert.equal(ui.settingsValues().model, "muse-default-only", "the overview retains its compatible fallback summary");
  assert.equal(inputValue(ui, "model"), "");
  assert.equal(inputValue(ui, "defaultModel"), "muse-default-only");
  assert.equal(inputValue(ui, "permissionMode"), "ask-before-edits");
  change(ui, "model", "");
  assert.equal(ui.state.settingsDirty, false, "an unset field left blank is unchanged");
  await clickSaveSettings(ui);
  assert.equal(f.calls.filter((x) => x.action === "settings:update").length, 0);
});

test("clearing Muse defaultModel and permissionMode with the save button removes disk keys and reloads empty inputs", async (t) => {
  const f = fixture(t), ui = harness(f.rpc);
  const file = path.join(f.homeDir, ".config/muse/settings.json");
  fs.writeFileSync(file, JSON.stringify({ defaultModel: "muse-default-only", permissionMode: "ask-before-edits", preserved: 42 }));
  ui.state.settingsHost = "muse";
  ui.state.tab = "settings";
  ui.state.open = true;
  await ui.loadSettings();
  change(ui, "defaultModel", "");
  change(ui, "permissionMode", "");
  assert.equal(ui.state.settingsDirty, true);
  await clickSaveSettings(ui);
  assert.deepEqual(f.calls.filter((x) => x.action === "settings:update").map((x) => x.payload), [
    { host: "muse", key: "defaultModel", value: null },
    { host: "muse", key: "permissionMode", value: null },
  ]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { preserved: 42 });
  assert.equal(ui.settingsValues().editableValues.defaultModel, null);
  assert.equal(ui.settingsValues().editableValues.permissionMode, null);
  for (const key of ["model", "defaultModel", "permissionMode"]) assert.equal(inputValue(ui, key), "");
  assert.equal(ui.state.settingsDirty, false);
  assert.match(ui.nodes.get(".hub-toast").innerHTML, /已保存/);
  await ui.loadSettings(true);
  for (const key of ["model", "defaultModel", "permissionMode"]) assert.equal(inputValue(ui, key), "");
});

for (const [host, keys, relativePath] of [
  ["muse", MUSE_KEYS, ".config/muse/settings.json"],
  ["pi", PI_KEYS, ".pi/agent/settings.json"],
]) test(`${host} renders every editable raw value independently and clears each field without changing other keys`, async (t) => {
  const f = fixture(t), ui = harness(f.rpc);
  const file = path.join(f.homeDir, relativePath);
  const original = { ...Object.fromEntries(keys.map((key) => [key, ` raw-${key} `])), preserved: { keep: true } };
  fs.writeFileSync(file, JSON.stringify(original));
  ui.state.settingsHost = host;
  await ui.loadSettings();
  ui.renderSettings();
  for (const key of keys) {
    assert.equal(inputValue(ui, key), original[key]);
    change(ui, key, "");
  }
  await clickSaveSettings(ui);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { preserved: { keep: true } });
  assert.equal(f.calls.filter((x) => x.action === "settings:update").length, keys.length);
  ui.renderSettings();
  for (const key of keys) assert.equal(inputValue(ui, key), "");
  await clickSaveSettings(ui);
  assert.equal(f.calls.filter((x) => x.action === "settings:update").length, keys.length, "empty fields are not resubmitted after refresh");
});

test("clearing Codex inputs deletes only the top-level values and refreshes empty inputs", async (t) => {
  const f = fixture(t), ui = harness(f.rpc);
  await ui.loadSettings();
  change(ui, "model", "");
  change(ui, "model_reasoning_effort", "");
  await clickSaveSettings(ui);
  const disk = fs.readFileSync(path.join(f.homeDir, ".codex/config.toml"), "utf8");
  assert.doesNotMatch(disk, /^\s*(?:model|model_reasoning_effort)\s*=/m);
  assert.match(disk, /# Preserve this comment/);
  assert.match(disk, /\[mcp_servers.keep\]\ncommand = "keep"/);
  ui.renderSettings();
  assert.equal(inputValue(ui, "model"), "");
  assert.equal(inputValue(ui, "model_reasoning_effort"), "");
  assert.equal(ui.state.settingsDirty, false);
});

for (const [host, relativePath] of [
  ["codex", ".codex/config.toml"],
  ["muse", ".config/muse/settings.json"],
  ["pi", ".pi/agent/settings.json"],
]) {
  test(`${host} multiline values retain leading/trailing newlines, do not write on unchanged input, and submit edits intact`, async (t) => {
    const f = fixture(t), ui = harness(f.rpc), original = "\nalpha\nbeta & <safe>\n";
    const file = path.join(f.homeDir, relativePath);
    const before = host === "codex" ? `# Keep\nmodel = """\n${original}"""\n[mcp_servers.keep]\ncommand = "keep"\n` : JSON.stringify({ model: original, preserved: 42 });
    fs.writeFileSync(file, before);
    ui.state.settingsHost = host;
    await ui.loadSettings();
    ui.renderSettings();
    assert.equal(ui.settingsValues().editableValues.model, original);
    assert.equal(nativeControl(ui, "model").tagName, "textarea", "a real input would strip line breaks");
    assert.match(nativeControl(ui, "model").attributes, /rows="[2-9]"/);
    assert.equal(inputValue(ui, "model"), original);
    assert.doesNotMatch(nativeControl(ui, "model").attributes, /aria-describedby="[^"]*model-empty/);
    change(ui, "model", inputValue(ui, "model"));
    assert.equal(ui.state.settingsDirty, false);
    await clickSaveSettings(ui);
    assert.equal(f.calls.filter((x) => x.action === "settings:update").length, 0);
    assert.equal(fs.readFileSync(file, "utf8"), before);
    const edited = original + "last\nline";
    change(ui, "model", edited);
    ui.renderSettings();
    assert.equal(inputValue(ui, "model"), edited);
    await clickSaveSettings(ui);
    assert.deepEqual(f.calls.filter((x) => x.action === "settings:update").map((x) => x.payload), [{ host, key: "model", value: edited }]);
    if (host === "codex") {
      // The existing backend deliberately rejects multiline TOML writes; the UI
      // must retain the draft and report it, never flatten it to bypass validation.
      assert.equal(fs.readFileSync(file, "utf8"), before);
      assert.equal(ui.state.settingsDraft.model, edited);
      assert.match(ui.nodes.get(".hub-toast").innerHTML, /unsafe value for model/);
    } else {
      assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).model, edited);
      assert.equal(ui.settingsValues().editableValues.model, edited);
      assert.equal(ui.state.settingsDirty, false);
    }
  });

  for (const clearFirst of [false, true]) test(`${host} explicit empty keys survive ${clearFirst ? "cancelling a clear with a textarea roundtrip" : "a textarea roundtrip"} without writes`, async (t) => {
    const f = fixture(t), ui = harness(f.rpc), file = path.join(f.homeDir, relativePath);
    const before = host === "codex" ? '# Keep\nmodel = ""\n[mcp_servers.keep]\ncommand = "keep"\n' : JSON.stringify({ model: "", preserved: 42 });
    fs.writeFileSync(file, before);
    ui.state.settingsHost = host;
    await ui.loadSettings();
    ui.renderSettings();
    if (clearFirst) {
      clickClearSettings(ui, "model");
      assert.equal(ui.state.clearedHostFields.has("model"), true);
      assert.equal(ui.state.settingsDirty, true);
    }
    change(ui, "model", "temp");
    assert.equal(ui.state.clearedHostFields.has("model"), false);
    assert.equal(ui.state.settingsDirty, true);
    change(ui, "model", "");
    assert.equal(ui.state.clearedHostFields.has("model"), false, "returning to the saved empty string cancels deletion intent");
    assert.equal(ui.state.settingsDirty, false);
    assert.equal(Object.prototype.hasOwnProperty.call(ui.state.settingsDraft, "model"), false);
    ui.renderSettings();
    assert.equal(inputValue(ui, "model"), "");
    assert.match(nativeControl(ui, "model").attributes, /aria-describedby="[^"]*model-empty/);
    const badge = ui.content.innerHTML.match(/<span\b[^>]*id="t3-hub-native-setting-model-empty"[^>]*>[^<]*<\/span>/)?.[0];
    assert.ok(badge, "the explicit empty badge is present");
    assert.match(badge, /当前显式为空 &quot;&quot;/);
    assert.doesNotMatch(badge, /\bhidden\b/);
    const clearButton = ui.content.innerHTML.match(/<button\b[^>]*data-host-field-clear="model"[^>]*>/)?.[0];
    assert.ok(clearButton, "the clear button is present");
    assert.doesNotMatch(clearButton, /\bhidden\b|\bdisabled\b/, "an explicit empty value can still be explicitly cleared");
    await clickSaveSettings(ui);
    assert.equal(f.calls.filter((x) => x.action === "settings:update").length, 0);
    assert.equal(ui.settingsValues().editableValues.model, "");
    assert.equal(fs.readFileSync(file, "utf8"), before, "saving a roundtrip preserves the explicit empty key on disk");
  });

  test(`${host} explicit empty keys remain visible and can be deleted with an explicit null while unset fields stay untouched`, async (t) => {
    const f = fixture(t), ui = harness(f.rpc), file = path.join(f.homeDir, relativePath);
    fs.writeFileSync(file, host === "codex" ? '# Keep\nmodel = ""\n[mcp_servers.keep]\ncommand = "keep"\n' : JSON.stringify({ model: "", preserved: 42 }));
    ui.state.settingsHost = host;
    await ui.loadSettings();
    ui.renderSettings();
    assert.equal(ui.settingsValues().editableValues.model, "");
    assert.match(ui.content.innerHTML, /当前显式为空/);
    assert.match(nativeControl(ui, "model").attributes, /placeholder="显式空字符串/);
    assert.match(nativeControl(ui, "model").attributes, /aria-describedby="[^"]*model-empty/);
    assert.doesNotMatch(ui.content.innerHTML.match(/<button\b[^>]*data-host-field-clear="model"[^>]*>/)?.[0] || "missing clear button", /\bhidden\b|missing clear button/);
    await clickSaveSettings(ui);
    assert.equal(f.calls.filter((x) => x.action === "settings:update").length, 0, "an untouched explicit empty value is not deletion intent");
    clickClearSettings(ui, "model");
    assert.equal(ui.state.clearedHostFields.has("model"), true, "the clear button explicitly requests deletion");
    await ui.loadSettings(true);
    assert.equal(ui.state.clearedHostFields.size, 0, "reload discards deletion intent");
    ui.renderSettings();
    clickClearSettings(ui, "model");
    assert.equal(ui.state.clearedHostFields.has("model"), true);
    assert.doesNotMatch(nativeControl(ui, "model").attributes, /aria-describedby="[^"]*model-empty/);
    assert.equal(ui.state.settingsDirty, true);
    await clickSaveSettings(ui);
    assert.deepEqual(f.calls.filter((x) => x.action === "settings:update").map((x) => x.payload), [{ host, key: "model", value: null }]);
    assert.equal(ui.settingsValues().editableValues.model, null);
    assert.equal(ui.state.clearedHostFields.size, 0);
    assert.equal(ui.state.settingsDirty, false);
    if (host === "codex") {
      assert.doesNotMatch(fs.readFileSync(file, "utf8"), /^model\s*=/m);
      assert.match(fs.readFileSync(file, "utf8"), /# Keep\n[\s\S]*\[mcp_servers.keep\]\ncommand = "keep"/);
    } else assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { preserved: 42 });
    ui.renderSettings();
    assert.match(ui.content.innerHTML.match(/<button\b[^>]*data-host-field-clear="model"[^>]*>/)?.[0] || "", /\bhidden\b/);
    change(ui, "model", "");
    await clickSaveSettings(ui);
    assert.equal(f.calls.filter((x) => x.action === "settings:update").length, 1, "an unchanged null field is never resubmitted");
  });
}

test("CRLF and CR display normalization does not turn untouched JSON values into edits", async (t) => {
  const f = fixture(t), ui = harness(f.rpc);
  const original = "\r\nalpha\rbeta\r\n";
  fs.writeFileSync(path.join(f.homeDir, ".config/muse/settings.json"), JSON.stringify({ model: original }));
  ui.state.settingsHost = "muse";
  await ui.loadSettings();
  ui.renderSettings();
  assert.equal(nativeControl(ui, "model").tagName, "textarea");
  assert.equal(inputValue(ui, "model"), "\nalpha\nbeta\n");
  change(ui, "model", inputValue(ui, "model"));
  await clickSaveSettings(ui);
  assert.equal(f.calls.filter((x) => x.action === "settings:update").length, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.homeDir, ".config/muse/settings.json"), "utf8")).model, original);
});

test("clear intent is cancelled by restoring a value, and clearing an unset draft does not write", async (t) => {
  const f = fixture(t), ui = harness(f.rpc);
  await ui.loadSettings();
  ui.renderSettings();
  clickClearSettings(ui, "model");
  change(ui, "model", "codex-only");
  assert.equal(ui.state.clearedHostFields.size, 0);
  assert.equal(ui.state.settingsDirty, false);
  change(ui, "sandbox_mode", "workspace-write");
  ui.renderSettings();
  clickClearSettings(ui, "sandbox_mode");
  assert.equal(ui.state.clearedHostFields.size, 0);
  assert.equal(ui.state.settingsDirty, false);
  await clickSaveSettings(ui);
  assert.equal(f.calls.filter((x) => x.action === "settings:update").length, 0);
});

test("native textareas keep Tab and Shift+Tab as field navigation instead of inserting code indentation", () => {
  const ui = harness();
  const input = { tagName: "TEXTAREA", name: "native-setting", getAttribute: () => null, value: "original", setRangeText() { assert.fail("native fields must not be indented"); } };
  for (const shiftKey of [false, true]) {
    let prevented = false;
    ui.onEditorKeydown({ target: input, key: "Tab", shiftKey, preventDefault() { prevented = true; } });
    assert.equal(prevented, false);
    assert.equal(input.value, "original");
  }
});

test("a failed clear remains retryable and successful clear intents are not replayed after partial failure", async (t) => {
  const f = fixture(t);
  let reject = true;
  const ui = harness(async (action, payload) => action === "settings:update" && payload.key === "model_reasoning_effort" && reject ? { ok: false, error: "try again" } : f.rpc(action, payload));
  await ui.loadSettings();
  ui.renderSettings();
  clickClearSettings(ui, "model");
  clickClearSettings(ui, "model_reasoning_effort");
  await clickSaveSettings(ui);
  assert.equal(ui.state.clearedHostFields.has("model"), false);
  assert.equal(ui.state.clearedHostFields.has("model_reasoning_effort"), true);
  assert.equal(ui.state.settingsDirty, true);
  assert.match(ui.nodes.get(".hub-toast").innerHTML, /try again/);
  reject = false;
  await clickSaveSettings(ui);
  assert.equal(f.calls.filter((x) => x.action === "settings:update" && x.payload.key === "model").length, 1);
  assert.equal(ui.state.clearedHostFields.size, 0);
  assert.equal(ui.state.settingsDirty, false);
});

test("missing managed config is explicitly creatable and only the edited field is written", async (t) => {
  const f = fixture(t), ui = harness(f.rpc);
  fs.unlinkSync(path.join(f.homeDir, ".codex/config.toml"));
  await ui.loadSettings();
  ui.renderSettings();
  assert.match(ui.content.innerHTML, /文件不存在.*保存时创建/);
  change(ui, "model", "first-model");
  await ui.saveNativeSettings();
  assert.equal(fs.readFileSync(path.join(f.homeDir, ".codex/config.toml"), "utf8"), 'model = "first-model"\n');
});

test("unchanged settings do not write, and saving configuration preserves an unsaved rule", async (t) => {
  const f = fixture(t), ui = harness(f.rpc);
  await ui.loadSettings();
  await ui.saveNativeSettings();
  assert.equal(f.calls.filter((x) => x.action === "settings:update").length, 0);
  assert.match(ui.nodes.get(".hub-toast").innerHTML, /没有.*修改|无需/);
  ui.state.settingsRule = "Unsaved rule draft";
  ui.state.settingsRuleDirty = true;
  change(ui, "model", "updated");
  await ui.saveNativeSettings();
  assert.equal(ui.state.settingsRule, "Unsaved rule draft");
  assert.equal(ui.state.settingsRuleDirty, true);
});

test("unsupported/missing/corrupt hosts show a scoped explanation and block configuration writes", async (t) => {
  const f = fixture(t), ui = harness(f.rpc);
  ui.cache.settings = f.manager.getSettingsSnapshot();
  for (const host of ["antigravity", "claude", "unknown"]) {
    ui.state.settingsHost = host;
    ui.renderSettings();
    assert.doesNotMatch(ui.content.innerHTML, /name="native-setting"/);
    assert.match(ui.content.innerHTML, /未.*(?:托管|支持)|只读|无.*配置/);
    assert.ok(!ui.content.innerHTML.includes("codex-only"));
  }
  fs.writeFileSync(path.join(f.homeDir, ".pi/agent/settings.json"), '{broken');
  ui.state.settingsHost = "pi";
  await ui.loadSettings(true);
  ui.renderSettings();
  assert.match(ui.content.innerHTML, /只读/);
  assert.match(ui.content.innerHTML, /invalid JSON/);
  change(ui, "model", "blocked");
  await ui.saveNativeSettings();
  assert.equal(f.calls.filter((x) => x.action === "settings:update").length, 0);
  assert.equal(fs.readFileSync(path.join(f.homeDir, ".pi/agent/settings.json"), "utf8"), '{broken');
});

test("backend rejection is shown accurately and partial saves refresh the baseline while retaining remaining changes", async (t) => {
  const f = fixture(t), ui = harness(f.rpc);
  await ui.loadSettings();
  change(ui, "model", "saved-first");
  change(ui, "model_reasoning_effort", 'bad"value');
  await ui.saveNativeSettings();
  assert.equal(f.manager.getSettingsSnapshot().codex.model, "saved-first");
  assert.equal(ui.settingsValues().model, "saved-first");
  assert.equal(ui.state.settingsDirty, true);
  assert.match(ui.nodes.get(".hub-toast").innerHTML, /unsafe value for model_reasoning_effort/);
  assert.doesNotMatch(ui.nodes.get(".hub-toast").innerHTML, /原生配置已保存/);
  change(ui, "model_reasoning_effort", "high");
  await ui.saveNativeSettings();
  assert.equal(f.calls.filter((x) => x.action === "settings:update" && x.payload.key === "model").length, 1, "a successful field is not replayed on retry");
  assert.equal(ui.state.settingsDirty, false);
});

test("rule writes include the read version and keep unsaved configuration changes", async (t) => {
  const f = fixture(t), ui = harness(f.rpc);
  await ui.loadSettings();
  change(ui, "model", "unsaved-model");
  ui.state.settingsRule = "# Verified rule\n";
  ui.state.settingsRuleDirty = true;
  await ui.saveNativeSettings(undefined, true);
  assert.equal(fs.readFileSync(path.join(f.homeDir, ".codex/AGENTS.md"), "utf8"), "# Verified rule\n");
  const request = f.calls.find((x) => x.action === "settings:saveRule").payload;
  assert.equal(request.host, "codex"); assert.equal(request.content, "# Verified rule\n"); assert.equal(typeof request.expectedContent, "string"); assert.ok(request.expectedTarget.endsWith("/.codex/AGENTS.md"));
  assert.equal(ui.state.settingsDraft.model, "unsaved-model");
  assert.equal(ui.state.settingsDirty, true);
  assert.equal(ui.state.settingsRuleDirty, false);
});

test("a late settings response cannot replace a newer reload of the same host", async () => {
  let resolveOld, reads = 0;
  const ui = harness(async (action) => action === "settings:getRule" ? { content: "rule" } : ++reads === 1 ? new Promise((resolve) => { resolveOld = resolve; }) : { codex: { model: "newest", path: "new.toml" } });
  const old = ui.loadSettings(true);
  await ui.loadSettings(true);
  resolveOld({ codex: { model: "stale", path: "old.toml" } });
  await old;
  assert.equal(ui.settingsValues().model, "newest");
});

test("memory, settings and avatar attributes escape hostile text", (t) => {
  const f = fixture(t), ui = harness();
  confirmMemoryProject(ui);
  const attack = attacks.join(" ");
  ui.state.tab = "memory";
  ui.cache.memory = { items: [{ id: attack, title: attack, content: attack, tags: [attack], agent: attack }] };
  ui.state.selectedMemory = attack;
  ui.renderMemoryList();
  assertInert(ui.nodes.get("#t3-hub-memory-list").innerHTML);
  assert.ok(ui.nodes.get("#t3-hub-memory-list").innerHTML.includes(ui.esc(attack)));
  ui.cache.settings = { codex: { ...f.manager.getSettingsSnapshot().codex, path: attack, model: attack, editableValues: { model: attack } } };
  ui.state.settingsRule = attack;
  ui.renderSettings();
  assertInert(ui.content.innerHTML);
  assert.equal(inputValue(ui, "model"), attack);
  assert.ok(ui.content.innerHTML.includes(ui.esc(attack)));
  for (const url of ['javascript:alert(1)', 'file:///tmp/avatar.png', '//evil.test/icon.png', '/icon.png', 'data:text/html,<svg onload=alert(1)>']) assert.doesNotMatch(ui.brandIcon({ iconUrl: url }), /<img/);
  for (const url of ['https://example.test/avatar.png', 'http://example.test/a.png', 'data:image/png;base64,AAAA']) assert.match(ui.brandIcon({ iconUrl: url, name: attack }), /<img/);
});

test("hooks, skills, MCP, agents, models and task-board templates keep hostile values inert", () => {
  const ui = harness(), attack = attacks.join(" ");
  ui.cache.hooks = { items: [{ id: attack, title: attack, command: attack, event: attack, events: [attack], source: attack }] };
  ui.renderHooks();
  assertInert(ui.content.innerHTML);
  assert.ok(ui.content.innerHTML.includes(ui.esc(attack)));
  ui.cache.skills = { items: [{ id: attack, name: attack, description: attack }] };
  ui.state.tab = "skills";
  ui.renderSkillList();
  assertInert(ui.nodes.get("#t3-hub-skill-list").innerHTML);
  assert.ok(ui.nodes.get("#t3-hub-skill-list").innerHTML.includes(ui.esc(attack)));
  ui.state.tab = "skills"; ui.state.libraryView = "mcp";
  ui.cache.mcp = { servers: [{ name: attack, description: attack, error: attack, summary: attack }] };
  ui.renderMcpList();
  assertInert(ui.nodes.get("#t3-hub-mcp-list").innerHTML);
  assert.ok(ui.nodes.get("#t3-hub-mcp-list").innerHTML.includes(ui.esc(attack)));
  ui.cache.subagents = { globalItems: [{ id: attack, role: "general", description: attack, systemPrompt: attack, target: { providerInstanceId: attack, model: attack } }], providers: [{ id: attack, label: attack, models: [{ id: attack, label: attack }] }] };
  ui.renderSubagents();
  assertInert(ui.content.innerHTML);
  assert.ok(ui.content.innerHTML.includes(ui.esc(attack)));
  ui.cache.orchestration = { config: { maxConcurrency: attack, swarmEnabled: attack, autoWorktreeIsolation: attack } };
  assertInert(ui.renderCommander());
  ui.cache.board = { title: attack, background: attack, steps: [{ text: attack, status: attack }], subagents: [{ role: attack, model: attack }], artifacts: [{ path: attack, name: attack }] };
  assertInert(ui.boardMarkup(true));
  assert.ok(ui.boardMarkup(true).includes(ui.esc(attack)));
});

test("the memory workbench contains no Dream controls or Dream RPC path", async () => {
  const calls = [];
  const ui = harness(async (action) => { calls.push(action); return { items: [] }; });
  ui.ready(); Object.assign(ui.state, { open: true, connected: true, projectRoot: "/fixture" });
  await ui.loadTab(); ui.renderMemory();
  assert.doesNotMatch(ui.content.innerHTML, /AutoDream|梦境|memory:dream|自动整理计划/);
  assert.doesNotMatch(drawerSource, /memory:dream:(?:get|run)/);
  assert.doesNotMatch(calls.join(" "), /memory:dream/);
});

test("edits made during a settings save, including reverting to the old value, remain unsaved drafts", async (t) => {
  const f = fixture(t);
  let release;
  const ui = harness(async (action, payload) => {
    if (action === "settings:update") await new Promise((resolve) => { release = resolve; });
    return f.rpc(action, payload);
  });
  await ui.loadSettings();
  change(ui, "model", "in-flight-model");
  const saving = ui.saveNativeSettings();
  change(ui, "model", "codex-only");
  release();
  await saving;
  assert.equal(ui.settingsValues().model, "in-flight-model");
  assert.equal(ui.state.settingsDraft.model, "codex-only");
  assert.equal(ui.state.settingsDirty, true);
});

for (const submitted of ["codex-in-flight", null]) test(`switching to Muse while Codex saves ${JSON.stringify(submitted)} isolates its explicit empty model and clears the captured host`, async (t) => {
  const f = fixture(t), file = path.join(f.homeDir, ".config/muse/settings.json");
  const before = JSON.stringify({ model: "", defaultModel: "muse-fallback", preserved: 42 });
  fs.writeFileSync(file, before);
  let release;
  const ui = harness(async (action, payload) => {
    if (action === "settings:update" && payload.host === "codex") await new Promise((resolve) => { release = resolve; });
    return f.rpc(action, payload);
  });
  ui.state.tab = "settings";
  await ui.loadSettings();
  ui.renderSettings();
  if (submitted === null) clickClearSettings(ui, "model");
  else change(ui, "model", submitted);
  const saving = ui.saveNativeSettings();
  assert.equal(typeof release, "function", "Codex's model write is still pending");
  try {
    clickSettingsAction(ui, { action: "settings-host", agent: "muse" });
    await new Promise(setImmediate);
    ui.renderSettings();
    assert.equal(inputValue(ui, "model"), "");
    assert.equal(ui.settingsValues().editableValues.model, "");
    assert.match(nativeControl(ui, "model").attributes, /aria-describedby="[^"]*model-empty/);
    change(ui, "model", "temporary");
    change(ui, "model", "");
    ui.renderSettings();
    assert.equal(ui.state.clearedHostFields.has("model"), false, "Codex's pending value must not turn Muse's empty string into deletion intent");
    assert.equal(Object.hasOwn(ui.state.settingsDraft, "model"), false, "returning to Muse's saved value leaves no draft");
    assert.equal(ui.state.settingsDirty, false);
    assert.equal(inputValue(ui, "model"), "");
    clickClearSettings(ui, "model");
    assert.equal(ui.state.clearedHostFields.has("model"), true, "a pending Codex clear must not suppress Muse's explicit clear action");
  } finally {
    release();
    await saving;
  }
  assert.equal(ui.state.settingsHost, "muse");
  assert.equal(ui.state.clearedHostFields.has("model"), true, "the old save must not consume the new host's intent");
  change(ui, "model", "temporary");
  change(ui, "model", "");
  await ui.saveNativeSettings();
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.equal(f.calls.some((call) => call.action === "settings:update" && call.payload.host === "muse"), false);
  clickSettingsAction(ui, { action: "settings-host", agent: "codex" });
  await new Promise(setImmediate);
  change(ui, "model", submitted === null ? "" : submitted);
  assert.equal(ui.state.settingsDirty, false, "finally must remove Codex's captured key after the active host has changed");
});

test("an untouched explicit empty field roundtrip during another field's save leaves no deletion or stale draft", async (t) => {
  const f = fixture(t), file = path.join(f.homeDir, ".codex/config.toml");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('model = "codex-only"', 'model = ""'));
  let release;
  const ui = harness(async (action, payload) => {
    if (action === "settings:update" && payload.key === "approval_policy") await new Promise((resolve) => { release = resolve; });
    return f.rpc(action, payload);
  });
  await ui.loadSettings();
  assert.equal(ui.settingsValues().editableValues.model, "");
  change(ui, "approval_policy", "never");
  const saving = ui.saveNativeSettings();
  assert.equal(typeof release, "function", "the approval policy save is in flight");
  change(ui, "model", "tmp");
  change(ui, "model", "");
  change(ui, "model_reasoning_effort", "high");
  change(ui, "model_reasoning_effort", "medium");
  release();
  await saving;
  assert.equal(ui.state.clearedHostFields.has("model"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(ui.state.settingsDraft, "model"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(ui.state.settingsDraft, "model_reasoning_effort"), false);
  assert.equal(ui.state.settingsDirty, false);
  assert.deepEqual(f.calls.filter((x) => x.action === "settings:update").map((x) => x.payload), [{ host: "codex", key: "approval_policy", value: "never" }]);
  const before = fs.readFileSync(file, "utf8"), updateCount = f.calls.filter((x) => x.action === "settings:update").length;
  await ui.saveNativeSettings();
  assert.equal(f.calls.filter((x) => x.action === "settings:update").length - updateCount, 0);
  assert.equal(ui.settingsValues().editableValues.model, "");
  assert.equal(f.manager.getSettingsSnapshot().codex.editableValues.model, "");
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

for (const [key, initial, submitted] of [["sandbox_mode", null, "workspace-write"], ["model", "", "new-model"]]) test(`clearing ${key} from ${JSON.stringify(initial)} during its own non-empty save preserves deletion intent`, async (t) => {
  const f = fixture(t), file = path.join(f.homeDir, ".codex/config.toml");
  if (initial === "") fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('model = "codex-only"', 'model = ""'));
  let release, delay = true;
  const ui = harness(async (action, payload) => {
    if (action === "settings:update" && delay) {
      delay = false;
      await new Promise((resolve) => { release = resolve; });
    }
    return f.rpc(action, payload);
  });
  await ui.loadSettings();
  assert.equal(ui.settingsValues().editableValues[key], initial);
  change(ui, key, submitted);
  const saving = ui.saveNativeSettings();
  assert.equal(typeof release, "function", "the field's non-empty save is in flight");
  change(ui, key, "");
  release();
  await saving;
  assert.equal(ui.settingsValues().editableValues[key], submitted);
  assert.equal(ui.state.clearedHostFields.has(key), true);
  assert.equal(ui.state.settingsDirty, true);
  await ui.saveNativeSettings();
  assert.deepEqual(f.calls.filter((x) => x.action === "settings:update").map((x) => x.payload), [
    { host: "codex", key, value: submitted },
    { host: "codex", key, value: null },
  ]);
  assert.equal(ui.settingsValues().editableValues[key], null);
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), new RegExp(`^${key}\\s*=`, "m"));
  assert.equal(ui.state.clearedHostFields.has(key), false);
  assert.equal(ui.state.settingsDirty, false);
});

for (const clearFirst of [false, true]) test(`${clearFirst ? "a restored value after clearing" : "a clear after typing"} during an in-flight save remains a separate unsaved intent`, async (t) => {
  const f = fixture(t);
  let release, delay = true;
  const ui = harness(async (action, payload) => {
    if (action === "settings:update" && delay) {
      delay = false;
      await new Promise((resolve) => { release = resolve; });
    }
    return f.rpc(action, payload);
  });
  await ui.loadSettings();
  ui.renderSettings();
  if (clearFirst) clickClearSettings(ui, "model");
  else change(ui, "model", "in-flight-model");
  const saving = ui.saveNativeSettings();
  if (clearFirst) change(ui, "model", "codex-only");
  else clickClearSettings(ui, "model");
  release();
  await saving;
  assert.equal(ui.settingsValues().editableValues.model, clearFirst ? null : "in-flight-model");
  assert.equal(ui.state.settingsDraft.model, clearFirst ? "codex-only" : "");
  assert.equal(ui.state.clearedHostFields.has("model"), !clearFirst);
  assert.equal(ui.state.settingsDirty, true);
  await clickSaveSettings(ui);
  assert.equal(ui.settingsValues().editableValues.model, clearFirst ? "codex-only" : null);
  assert.equal(ui.state.clearedHostFields.size, 0);
  assert.equal(ui.state.settingsDirty, false);
});

test("switching hosts discards scoped clear intent without deleting the new host's value", async (t) => {
  const f = fixture(t), ui = harness(f.rpc);
  ui.state.tab = "settings";
  await ui.loadSettings();
  ui.renderSettings();
  clickClearSettings(ui, "model");
  clickSettingsAction(ui, { action: "settings-host", agent: "muse" });
  await new Promise(setImmediate);
  assert.equal(ui.state.clearedHostFields.size, 0);
  assert.equal(ui.state.settingsDirty, false);
  await clickSaveSettings(ui);
  assert.equal(f.calls.filter((x) => x.action === "settings:update").length, 0);
  assert.equal(f.manager.getSettingsSnapshot().muse.editableValues.model, "muse-only");
});

test("the memory-only Hub keeps its supported RPCs dispatched and exposes no legacy page routes", () => {
  const backend = fs.readFileSync(path.join(repo, "src/backend.cjs"), "utf8");
  const cases = new Set([...backend.matchAll(/case\s+"([\w:]+)"\s*:/g)].map((m) => m[1]));
  const actions = new Set([...drawerSource.matchAll(/"((?:hub|plugins|hooks|skills|subagents|mcp|memory|board|settings|agentsMd|embed|slash):[\w:]+)"/g)].map((m) => m[1]));
  for (const domain of ["skills", "mcp"]) for (const op of ["list", "toggleAgent"]) actions.add(`${domain}:${op}`);
  for (const action of actions) assert.ok(cases.has(action), `missing backend RPC: ${action}`);
  assert.deepEqual(JSON.parse(drawerSource.match(/const tabKeys = (\[[^;]+\]);/)[1]), ["memory"]);
  for (const tab of ["skills", "mcp", "plugins", "hooks", "subagents", "settings", "board", "agents"]) assert.ok(drawerSource.includes(`case "${tab}"` ) === false, `${tab} must not be a routable page`);
});

test("renderer escapes both quote types and file change counts, and tolerates a missing detail hash", () => {
  const escapeSource = rendererSource.match(/  function escapeHtml\([^]*?\n  \}/)[0];
  const escape = vm.runInNewContext(`(${escapeSource.trim()})`);
  assert.equal(escape('&<>"\''), "&amp;&lt;&gt;&quot;&#39;");
  const renderSource = rendererSource.match(/  function renderCommitDetail\([^]*?\n  \}/)[0];
  const commitBodyEl = node();
  const sandbox = { commitBodyEl, commitMsgEl: node(), commitMetaEl: node(), escapeHtml: escape, t: (x) => x, hudLang: "en", formatColoredPatch: escape };
  vm.runInNewContext(renderSource + ";renderCommitDetail({files:[{path:'safe',added:'<img src=x onerror=alert(1)>',deleted:'\" autofocus onfocus=\"alert(1)'}]})", sandbox);
  assertInert(commitBodyEl.innerHTML);
});

test("appearance defaults to pure white regardless of the OS, validates saved values, and synchronizes every surface", () => {
  for (const saved of [null, "bogus", ...["white", "dark", "sky", "emerald", "violet"]]) {
    const persisted = new Map(saved ? [["t3-hub-theme", saved]] : []), events = [];
    const ui = harness(undefined, {
      localStorage: { getItem: (key) => persisted.get(key), setItem: (key, value) => persisted.set(key, value) },
      window: { matchMedia: () => ({ matches: true }), dispatchEvent: (event) => events.push(event) },
    });
    const expected = saved && saved !== "bogus" ? saved : "white";
    assert.equal(ui.state.theme, expected);
    ui.applyTheme();
    assert.equal(ui.root.style.getPropertyValue("--hub-bg"), ui.hubThemes[expected].bg);
    for (const theme of ["dark", "sky", "emerald", "violet", "white"]) {
      ui.setTheme(theme);
      assert.equal(persisted.get("t3-hub-theme"), theme);
      for (const surface of [ui.root, ...["#t3-hub-title-controls", "#t3-hub-plan-handle", "#t3-hub-live-board"].map((id) => ui.nodes.get(id))]) {
        assert.equal(surface.dataset.theme, theme);
        assert.equal(surface.style.getPropertyValue("--hub-bg"), ui.hubThemes[theme].bg);
      }
      assert.equal(events.at(-1).type, "t3-hub-theme-change");
      assert.equal(events.at(-1).detail.theme, theme);
      const buttons = ui.themeSwitcher();
      assert.equal([...buttons.matchAll(/aria-pressed="true"/g)].length, 1);
      assert.match(buttons, new RegExp(`data-theme="${theme}"[^>]+aria-label="[^"]+"[^>]+aria-pressed="true"`));
    }
  }
  assert.doesNotMatch(drawerSource, /t3-hub-left-dock|leftDock/);
});

test("resident HUD uses the same stored white/color/dark palettes and removes its theme listeners on cleanup", () => {
  const themes = rendererSource.match(/  const hudThemes = \{[^]*?\n  \};/)[0];
  const sync = rendererSource.match(/  function syncHudTheme\([^]*?\n  \}/)[0];
  let saved = null;
  const root = node();
  const sandbox = { root, localStorage: { getItem: () => saved } };
  vm.runInNewContext(themes + "\n" + sync + "\nthis.syncTheme = syncHudTheme;", sandbox);
  sandbox.syncTheme();
  assert.equal(root.dataset.theme, "white");
  assert.equal(root.style.getPropertyValue("--hud-bg-solid"), "#ffffff");
  for (const [theme, bg] of [["dark", "#14161a"], ["sky", "#f4f9ff"], ["emerald", "#f2fdf7"], ["violet", "#faf7ff"]]) {
    sandbox.syncTheme({ detail: { theme } });
    assert.equal(root.dataset.theme, theme);
    assert.equal(root.style.getPropertyValue("--hud-bg-solid"), bg);
    saved = theme;
    sandbox.syncTheme({ type: "storage" });
    assert.equal(root.dataset.theme, theme);
  }
  saved = "invalid";
  sandbox.syncTheme();
  assert.equal(root.dataset.theme, "white");
  for (const event of ["t3-hub-theme-change", "storage"]) {
    assert.ok(rendererSource.includes(`window.addEventListener("${event}", syncHudTheme)`));
    assert.ok(rendererSource.includes(`window.removeEventListener("${event}", syncHudTheme)`));
  }
  assert.doesNotMatch(rendererSource, /@media\(prefers-color-scheme:dark\)/);
});

function relationFixture() {
  const card = node(), section = node(), label = node();
  label.textContent = "会话关系";
  label.parentElement = section; section.parentElement = card;
  label.getBoundingClientRect = () => ({ left: 970, right: 1070, top: 320, width: 100, height: 18 });
  card.isConnected = true;
  card.getBoundingClientRect = () => ({ left: 930, right: 1250, top: 90, bottom: 510, width: 320, height: 420 });
  const sidebar = node(); sidebar.querySelectorAll = () => [label];
  const ui = harness(undefined, { document: { querySelectorAll: () => [sidebar] } });
  ui.sandbox.document.body = node();
  ui.setStyle((element) => element === card ? { visibility: "visible", borderRadius: "14px", borderTopWidth: "1px", borderTopStyle: "solid" } : { visibility: "visible", borderRadius: "0px", borderTopWidth: "0px" });
  card.children = [node(), section];
  card.appendChild = (child) => { card.children = card.children.filter((x) => x !== child); card.children.push(child); card.lastElementChild = child; child.parentElement = card; };
  ui.root.appendChild = (child) => { card.children = card.children.filter((x) => x !== child); child.parentElement = ui.root; };
  ui.nodes.get("#t3-hub-live-board").parentElement = ui.root;
  return { ui, card, section, label, sidebar };
}


test("title-side plan entry appears only for the current main plan and is read-only", async () => {
  const calls = [];
  const heading = {
    textContent: "Current chat", parentElement: null,
    getBoundingClientRect: () => ({ left: 40, right: 220, top: 18, bottom: 44, width: 180, height: 26 }),
    getClientRects: () => [{ width: 180, height: 26 }], getAttribute: () => null,
    closest: () => null,
    after(element) { const parent = { inserted: element }; element.parentElement = parent; element.previousElementSibling = this; this.inserted = element; },
  };
  const ui = harness(async (action, payload) => { calls.push({ action, payload }); return {}; }, { document: { querySelectorAll: (selector) => selector.includes("thread-actions") ? [heading] : [] } });
  ui.ready(); Object.assign(ui.state, { connected: true, projectRoot: "/fixture", threadId: "thread-a", context: { threadId: "thread-a", projectRoot: "/fixture" } });
  ui.cache.board = { source: "t3-native", steps: [] }; ui.renderLiveBoard();
  assert.equal(ui.root.querySelector("#t3-hub-plan-handle").hidden, true, "no plan means no header entry");
  ui.cache.board = { source: "t3-native", steps: [
    { id: "done", text: "Completed step", status: "completed" },
    { id: "todo", text: "Next step", status: "pending" },
  ], artifacts: [{ name: "private.md" }], subagents: [{ title: "Child task" }] };
  ui.renderLiveBoard();
  const entry = ui.root.querySelector("#t3-hub-plan-handle"), popover = ui.root.querySelector("#t3-hub-live-board");
  assert.equal(entry.hidden, false);
  assert.equal(popover.hidden, true, "the progress list is hidden until hover, focus or click");
  entry.closest = () => null;
  ui.setPlanPopover(true);
  assert.equal(popover.hidden, false);
  assert.match(popover.innerHTML, /Completed step/); assert.match(popover.innerHTML, /Next step/);
  assert.match(popover.innerHTML, /第 2 \/ 2 步/);
  assert.match(popover.innerHTML, /已完成 1 项/);
  assert.doesNotMatch(popover.innerHTML, /private\.md|Child task|data-action=|<button/);
  await ui.pollBoard();
  assert.equal(calls[0].action, "board:get");
  assert.equal(calls[0].payload.threadId, "thread-a");
  assert.equal(calls[0].payload.strictThreadMatch, true);
  assert.equal(calls[0].payload.excludeSubagentInference, true);
  assert.equal(calls[0].payload.environmentId, undefined);
});


test("a mismatched or unresolved plan stays hidden and cannot open a removed board page", async () => {
  for (const returnedThread of ["another-thread", ""]) {
    const ui = harness(async () => ({ threadId: returnedThread, steps: [] }));
    const entry = ui.root.querySelector("#t3-hub-plan-handle");
    ui.ready();
    Object.assign(ui.state, { connected: true, threadId: "thread-a", projectRoot: "/fixture" });
    await ui.pollBoard();
    assert.equal(ui.cache.board, null);
    assert.equal(entry.hidden, true, "unknown or mismatched data is not presented as a plan");
    ui.switchTab("board");
    assert.equal(ui.state.tab, "memory", "legacy board navigation is unreachable");
    ui.renderTab();
    assert.match(ui.content.innerHTML, /记忆工作台/);
  }
});

test("plan progress is display-only and legacy mutation routes are not reachable", () => {
  const ui = harness();
  ui.renderTab();
  assert.equal(ui.state.tab, "memory");
  assert.doesNotMatch(ui.content.innerHTML, /data-action="board-(?:add|clear|step)"|name="board-step-draft"/);
  ui.switchTab("board");
  assert.equal(ui.state.tab, "memory");
  ui.renderChrome();
  assert.equal(ui.root.querySelector(".hub-tabs").innerHTML.match(/data-tab=/g)?.length || 0, 1);
});

test("native thread routes bind the environment and thread rather than the project UUID", async () => {
  const project = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", environment = "11111111-1111-4111-8111-111111111111", otherEnvironment = "22222222-2222-4222-8222-222222222222", tid = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", calls = [];
  const ui = harness(async (action, payload) => { calls.push({ action, payload }); return { threadId: tid, steps: [] }; });
  ui.ready();
  Object.assign(ui.sandbox.location, { pathname: "/", hash: `#/${environment}/${tid}`, href: `t3code://app/#/${environment}/${tid}` });
  Object.assign(ui.state, { connected: true, threadId: tid, projectRoot: "/tmp/a", context: { threadId: tid, projectId: project, projectRoot: "/tmp/a", environmentId: environment }, boardDraft: "test" });
  ui.cache.board = { steps: [] };
  await ui.pollBoard();
  assert.equal(calls.length, 1, "the environment ID need not equal the thread's project ID");
  assert.equal(calls[0].payload.threadId, tid);
  assert.equal(calls[0].payload.projectRoot, "/tmp/a");
  calls.length = 0;
  ui.state.context.environmentId = otherEnvironment;
  await ui.pollBoard();
  assert.equal(calls.length, 0, "a different environment must not use the local context");
  assert.equal(ui.root.querySelector("#t3-hub-plan-handle").hidden, true);
  delete ui.state.context.environmentId;
  await ui.pollBoard();
  assert.equal(calls.length, 0, "an unverified environment must fail closed");
  ui.state.context.environmentId = environment;
  ui.state.context.projectRoot = "/tmp/other-project";
  await ui.pollBoard(); await ui.updateBoard(null, "add"); await ui.updateBoard(null, "clear");
  assert.equal(calls.length, 0, "a stale project root must fail closed");
});

test("non-UUID thread routes cannot use a stale local context from another environment", async () => {
  const local = "11111111-1111-4111-8111-111111111111", remote = "22222222-2222-4222-8222-222222222222", calls = [];
  const ui = harness(async (action, payload) => { calls.push({ action, payload }); return { threadId: payload.threadId, steps: [] }; });
  ui.ready();
  Object.assign(ui.state, { connected: true, threadId: "thread:local", projectRoot: "/tmp/a", context: { threadId: "thread:local", projectId: "project-a", projectRoot: "/tmp/a", environmentId: local }, boardDraft: "do not write" });
  ui.cache.board = { steps: [] };
  for (const id of ["thread:local", "thread%3Alocal", "thread%3alocal"]) {
    Object.assign(ui.sandbox.location, { pathname: "/", hash: `#/${remote}/${id}`, href: `t3code://app/#/${remote}/${id}` });
    await ui.pollBoard();
    assert.equal(calls.length, 0, `${id} must not read or write the previous local context`);
  }
  Object.assign(ui.sandbox.location, { hash: `#/${local}/thread%3Alocal`, href: `t3code://app/#/${local}/thread%3Alocal` });
  assert.equal(ui.currentThreadId(), "thread:local", "the native route decodes the actual thread ID");
  ui.syncThread(true);
  await ui.pollBoard();
  assert.equal(calls.length, 1, "the matching local environment can read its thread");
  assert.equal(calls[0].payload.threadId, "thread:local");
  calls.length = 0;
  ui.state.threadId = "thread-a";
  ui.state.context.threadId = "thread-a";
  Object.assign(ui.sandbox.location, { hash: `#/${remote}/thread-a`, href: `t3code://app/#/${remote}/thread-a` });
  assert.equal(ui.currentThreadId(), "thread-a");
  await ui.pollBoard();
  assert.equal(calls.length, 0, "plain string thread IDs still require the matching environment");
  Object.assign(ui.sandbox.location, { hash: `#/${local}/thread-a`, href: `t3code://app/#/${local}/thread-a` });
  ui.syncThread(true);
  await ui.pollBoard();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.threadId, "thread-a");
});

test("unknown environment routes cannot reuse the previous local thread context", async () => {
  const environment = "11111111-1111-4111-8111-111111111111", thread = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", calls = [];
  const ui = harness(async (action, payload) => { calls.push({ action, payload }); return { threadId: payload.threadId, steps: [] }; });
  ui.ready();
  Object.assign(ui.state, { connected: true, threadId: thread, projectRoot: "/tmp/a", context: { threadId: thread, projectId: "project-a", projectRoot: "/tmp/a", environmentId: environment }, boardDraft: "do not write" });
  ui.cache.board = { steps: [] };
  Object.assign(ui.sandbox.location, { pathname: "/", hash: `#/remote-host/${thread}`, href: `t3code://app/#/remote-host/${thread}` });
  await ui.pollBoard(); await ui.updateBoard(null, "add"); await ui.updateBoard(null, "clear");
  assert.equal(calls.length, 0);
  Object.assign(ui.sandbox.location, { pathname: `/threads/${thread}`, hash: "", href: `https://fixture.test/threads/${thread}` });
  await ui.pollBoard();
  assert.equal(calls.length, 1, "the supported legacy thread route remains available");
  assert.equal(calls[0].payload.threadId, thread);
});

for (const prefix of ["/", "", "/_t3_env_/", "_t3_env_/"]) test(`Round-2 P2 #7 board scope decodes both environment and thread (${prefix || "no leading slash"})`, async () => {
  const environmentId = "remote:west", threadId = "thread:task/7%3A", calls = [];
  const route = `${prefix}${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
  const ui = harness(async (action, payload) => { calls.push({ action, payload }); return { threadId, steps: [] }; }, {
    location: { pathname: "/", hash: `#${route}`, href: `t3code://app/#${route}` },
  });
  ui.ready();
  Object.assign(ui.state, { connected: true, threadId, projectRoot: "/remote-project", context: { environmentId: environmentId.toUpperCase(), threadId, projectRoot: "/remote-project" }, boardDraft: "do not cross scopes" });
  ui.setCurrentRoute();
  assert.equal(ui.boardMismatch(), false);
  assert.equal(ui.projectContextReady(), true);
  assert.equal(await ui.pollBoard(), true);
  assert.equal(calls[0].payload.threadId, threadId, "decode the thread once without changing its literal percent escape");
  calls.length = 0;
  ui.state.context.environmentId = "remote:east";
  assert.equal(ui.boardMismatch(), true);
  await ui.pollBoard(); await ui.updateBoard(null, "add");
  assert.equal(calls.length, 0, "a different decoded environment still blocks plan reads and writes");
  ui.state.context.environmentId = environmentId;
  for (const badRoute of [`${prefix}%E0%A4%A/${encodeURIComponent(threadId)}`, `${prefix}${encodeURIComponent(environmentId)}/%E0%A4%A`, `${prefix}${encodeURIComponent(environmentId)}/another-thread`]) {
    ui.sandbox.location.hash = `#${badRoute}`;
    assert.equal(ui.boardMismatch(), true, "malformed escapes and another thread must fail closed");
  }
});

test("Round-2 P2 #7 thread wrappers are environments only with an explicit prefix; project wrappers stay project routes", () => {
  const ui = harness();
  Object.assign(ui.state, { threadId: "thread-a", projectRoot: "/fixture", context: { threadId: "thread-a", projectRoot: "/fixture" } });
  for (const segment of ["threads", "_chat", "projects", "project", "workspaces", "workspace"]) {
    Object.assign(ui.sandbox.location, { pathname: "/", hash: `#/${segment}/thread-a` });
    assert.equal(ui.boardMismatch(), false, `${segment} must not become an implicit environment`);
    ui.sandbox.location.hash = `#/_t3_env_/${segment}/thread-a`;
    assert.equal(ui.boardMismatch(), ["threads", "_chat"].includes(segment), "only explicit thread wrappers require an environment match");
    ui.state.context.environmentId = segment;
    assert.equal(ui.boardMismatch(), false);
    delete ui.state.context.environmentId;
  }
});


test("dialog occlusion ignores hidden, closed and transparent elements including hidden ancestors", () => {
  const dialog = node(), parent = node(); dialog.parentElement = parent; dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-modal", "true");
  const ui = harness(undefined, { document: { querySelectorAll: (selector) => selector.includes('[role="dialog"]') ? [dialog] : [] } });
  ui.setStyle((element) => ({ display: "block", visibility: "visible", opacity: "1", ...element.css }));
  ui.syncOcclusion(); assert.equal(ui.root.classList.contains("is-occluded"), true);
  for (const hidden of [() => { dialog.hidden = true; }, () => dialog.setAttribute("aria-hidden", "true"), () => dialog.setAttribute("data-closed", ""), () => { dialog.css = { display: "none" }; }, () => { dialog.css = { visibility: "hidden" }; }, () => { dialog.css = { opacity: "0" }; }, () => { parent.css = { opacity: "0" }; }, () => { parent.hidden = true; }, () => { dialog.tagName = "DIALOG"; dialog.open = false; }]) {
    dialog.hidden = false; dialog.tagName = "DIV"; dialog.open = true; dialog.css = {}; parent.css = {}; parent.hidden = false; dialog.removeAttribute("aria-hidden"); dialog.removeAttribute("data-closed");
    hidden(); ui.syncOcclusion(); assert.equal(ui.root.classList.contains("is-occluded"), false);
  }
});

test("non-modal inline dialogs occlude only overlapping composer or visible Hub surfaces", () => {
  const dialog = node(); dialog.setAttribute("role", "dialog");
  const ui = harness(undefined, { document: { querySelectorAll: (selector) => selector.includes('[role="dialog"]') ? [dialog] : [] } });
  dialog.getBoundingClientRect = () => ({ left: 0, top: 0, right: 70, bottom: 50, width: 70, height: 50 });
  ui.syncOcclusion(); assert.equal(ui.root.classList.contains("is-occluded"), false);
  dialog.getBoundingClientRect = () => ({ left: 110, top: 610, right: 180, bottom: 660, width: 70, height: 50 });
  ui.syncOcclusion(); assert.equal(ui.root.classList.contains("is-occluded"), true);
  dialog.getBoundingClientRect = () => ({ left: 0, top: 0, right: 70, bottom: 50, width: 70, height: 50 });
  dialog.setAttribute("aria-modal", "true"); ui.syncOcclusion(); assert.equal(ui.root.classList.contains("is-occluded"), true, "a real modal remains a blocker even outside Hub geometry");
  dialog.removeAttribute("aria-modal");
  const editor = node(); editor.nodeType = 1; editor.isConnected = true; editor.tagName = "TEXTAREA"; editor.closest = (selector) => selector.includes("textarea") ? editor : null; editor.parentElement = null;
  editor.getBoundingClientRect = dialog.getBoundingClientRect;
  ui.sandbox.document.querySelectorAll = (selector) => selector.includes('[role="dialog"]') ? [dialog] : selector.includes("textarea") ? [editor] : [];
  ui.syncOcclusion(); assert.equal(ui.root.classList.contains("is-occluded"), true, "composer overlap also hides Hub controls");
});



test("narrow inspector can be found without accepting an unscoped left-side title", () => {
  const { ui, sidebar, card, label } = relationFixture();
  ui.sandbox.innerWidth = 600;
  card.getBoundingClientRect = () => ({ left: 270, right: 590, top: 90, bottom: 450, width: 320, height: 360 });
  label.getBoundingClientRect = () => ({ left: 280, right: 380, top: 120, bottom: 138, width: 100, height: 18 });
  assert.equal(ui.findSessionRelationsCard().card, card);
  sidebar.querySelectorAll = () => [];
  ui.sandbox.document.body.querySelectorAll = () => [label];
  assert.equal(ui.findSessionRelationsCard(), null);
});






function issue8BoardFixture(t) {
  const { DatabaseSync } = require("node:sqlite");
  const { createTaskBoard } = require("../src/hub-task-board.cjs");
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3-issue8-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, ".gemini/antigravity/brain"), session = path.join(root, "thread-a"), sibling = path.join(root, "thread-b");
  for (const dir of [session, sibling]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "task.md"), `# ${path.basename(dir)}\n- [ ] task\n`);
    fs.utimesSync(path.join(dir, "task.md"), new Date("2020-01-01"), new Date("2020-01-01"));
  }
  const projectRoot = path.join(home, "project"), dbPath = path.join(home, "state.sqlite"), db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, title TEXT, project_id TEXT); CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, workspace_root TEXT, deleted_at TEXT)");
  db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?)").run("thread-a", "fixture", "p");
  db.prepare("INSERT INTO projection_projects VALUES (?,?,NULL)").run("p", projectRoot); db.close();
  const board = createTaskBoard({ homeDir: home, t3DbPath: dbPath, hubPlansDir: path.join(home, "plans"), agyBrainDirs: [root], now: () => Date.parse("2026-11-16T12:00:00Z") });
  return { home, root, session, sibling, board, query: { threadId: "thread-a", projectRoot, strictThreadMatch: true } };
}

for (const operation of ["preview", "reveal"]) for (const replacement of ["symlink", "directory"]) {
  test(`Issue #8 [1] ${operation} rejects a session ${replacement} replacement after listing`, async (t) => {
    const f = issue8BoardFixture(t), calls = [];
    const { createArtifactAccess } = require("../src/hub-artifact-access.cjs");
    const board = { verifyArtifactScope: f.board.verifyArtifactScope, getBoardSnapshot(q) {
      const snapshot = f.board.getBoardSnapshot(q);
      assert.ok(snapshot.artifacts.some(a => a.name === "task.md"));
      fs.renameSync(f.session, f.session + "-old");
      if (replacement === "symlink") fs.symlinkSync(f.sibling, f.session);
      else { fs.mkdirSync(f.session); fs.copyFileSync(path.join(f.sibling, "task.md"), path.join(f.session, "task.md")); }
      return snapshot;
    } };
    const access = createArtifactAccess({ homeDir: f.home, board, open: async (...args) => calls.push(args) });
    await assert.rejects(access({ ...f.query, path: path.join(f.session, "task.md"), operation }), /会话|路径|变化|实体/);
    assert.equal(calls.length, 0, "a replaced session must never reach Finder");
  });
}

test("Issue #8 [1] preview binds the opened fd to the listed file inode", async (t) => {
  const f = issue8BoardFixture(t), target = path.join(f.session, "task.md");
  const source = fs.readFileSync(path.join(repo, "src/hub-artifact-access.cjs"), "utf8"), module = { exports: {} };
  let swapped = false;
  const guardedFs = Object.create(fs);
  guardedFs.openSync = (file, ...args) => {
    if (file === target && !swapped) {
      swapped = true; fs.renameSync(target, target + ".old"); fs.writeFileSync(target, "SIBLING CONTENT MUST NOT LEAK");
    }
    return fs.openSync(file, ...args);
  };
  vm.runInNewContext(source, { module, exports: module.exports, require: name => name === "node:fs" ? guardedFs : require(name), Buffer, process });
  const access = module.exports.createArtifactAccess({ homeDir: f.home, board: f.board, open: async () => assert.fail("preview must not reach Finder") });
  await assert.rejects(access({ ...f.query, path: target, operation: "preview" }), /会话|路径|变化|实体/);
  assert.equal(swapped, true, "the race must occur between path validation and open");
});

function issue8Ui(rpc, environment = {}) {
  const ui = harness(rpc, environment);
  ui.ready(); Object.assign(ui.state, { connected: true, open: true, tab: "board", threadId: "thread-a", projectRoot: "/fixture", context: { threadId: "thread-a" } });
  return ui;
}
test("Issue #8 [1] preview rechecks the directory chain even when the fd still points to the original inode", async (t) => {
  const f = issue8BoardFixture(t), target = path.join(f.session, "task.md"), module = { exports: {} }, guardedFs = Object.create(fs);
  let swapped = false;
  guardedFs.openSync = (file, ...args) => {
    const fd = fs.openSync(file, ...args);
    if (file === target && !swapped) {
      swapped = true; fs.renameSync(f.session, f.session + "-old"); fs.symlinkSync(f.sibling, f.session);
    }
    return fd;
  };
  vm.runInNewContext(fs.readFileSync(path.join(repo, "src/hub-artifact-access.cjs"), "utf8"), { module, exports: module.exports, require: name => name === "node:fs" ? guardedFs : require(name), Buffer, process });
  const access = module.exports.createArtifactAccess({ homeDir: f.home, board: f.board, open: async () => assert.fail("must not reveal a replaced directory") });
  await assert.rejects(access({ ...f.query, path: target, operation: "preview" }), /会话|路径|变化|实体/);
  assert.equal(swapped, true);
});

for (const kind of ["file", "directory"]) for (const ancestor of ["session", "trusted-parent", "provider-parent", "home", "leaf"]) {
  test(`Issue #8 tail [2] reveal rejects an ABA ${ancestor} replacement for a ${kind}`, async (t) => {
    const f = issue8BoardFixture(t), { createArtifactAccess } = require("../src/hub-artifact-access.cjs");
    const target = path.join(f.session, kind === "file" ? "task.md" : "output");
    if (kind === "directory") {
      fs.mkdirSync(target);
      fs.writeFileSync(target + ".metadata.json", JSON.stringify({ userFacing: true }));
    }
    const replaced = ancestor === "session" ? f.session : ancestor === "trusted-parent" ? path.dirname(f.root) : ancestor === "provider-parent" ? path.dirname(path.dirname(f.root)) : ancestor === "home" ? f.home : target;
    const before = fs.lstatSync(replaced, { bigint: true });
    let revealed = false;
    const access = createArtifactAccess({ homeDir: f.home, board: f.board, open: async () => {
      revealed = true;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
      fs.renameSync(replaced, replaced + ".aba-original");
      fs.symlinkSync(kind === "file" && ancestor === "leaf" ? path.join(f.sibling, "task.md") : f.sibling, replaced);
      assert.equal(fs.lstatSync(replaced).isSymbolicLink(), true);
      await new Promise(setImmediate);
      fs.unlinkSync(replaced);
      fs.renameSync(replaced + ".aba-original", replaced);
      const after = fs.lstatSync(replaced, { bigint: true });
      assert.equal(after.dev, before.dev); assert.equal(after.ino, before.ino);
      assert.notEqual(after.ctimeNs, before.ctimeNs, "the restored entity retains inode identity but records the rename");
    } });
    await assert.rejects(access({ ...f.query, path: target, operation: "reveal" }), /会话|路径|变化|实体/);
    assert.equal(revealed, true, "the ABA must occur during the external reveal");
  });
}

for (const kind of ["file", "directory"]) for (const outcome of ["success", "failure"]) {
  test(`Issue #8 tail [2] reveal retains nofollow ${kind} and ancestor handles until ${outcome}`, async (t) => {
    const f = issue8BoardFixture(t), module = { exports: {} }, guardedFs = Object.create(fs), handles = new Map();
    const target = path.join(f.session, kind === "file" ? "task.md" : "output");
    if (kind === "directory") {
      fs.mkdirSync(target);
      fs.writeFileSync(target + ".metadata.json", JSON.stringify({ userFacing: true }));
    }
    guardedFs.openSync = (file, flags, ...args) => {
      const fd = fs.openSync(file, flags, ...args); handles.set(fd, { file, flags }); return fd;
    };
    guardedFs.closeSync = (fd) => { handles.delete(fd); return fs.closeSync(fd); };
    vm.runInNewContext(fs.readFileSync(path.join(repo, "src/hub-artifact-access.cjs"), "utf8"), { module, exports: module.exports, require: name => name === "node:fs" ? guardedFs : require(name), Buffer, process });
    const access = module.exports.createArtifactAccess({ homeDir: f.home, board: f.board, open: async () => {
      for (const file of [path.dirname(f.root), f.root, f.session, target]) {
        const held = [...handles].find(([, item]) => item.file === file);
        assert.ok(held, `reveal must retain the verified handle for ${path.basename(file)}`);
        assert.ok(held[1].flags & fs.constants.O_NOFOLLOW);
        const stat = fs.fstatSync(held[0], { bigint: true });
        assert.equal(typeof stat.ctimeNs, "bigint");
      }
      await new Promise(setImmediate);
      assert.ok(handles.size >= 4, "handles must remain open across the asynchronous boundary");
      if (outcome === "failure") throw new Error("simulated Finder failure");
    } });
    try {
      if (outcome === "failure") await assert.rejects(access({ ...f.query, path: target, operation: "reveal" }), /simulated Finder failure/);
      else assert.equal((await access({ ...f.query, path: target, operation: "reveal" })).kind, "revealed");
      assert.equal(handles.size, 0, "all handles are released on either outcome");
    } finally { for (const fd of handles.keys()) fs.closeSync(fd); }
  });
}
test("Issue #8 [2] clearing an absent manual slot preserves the external plan and rejects a newly created manual plan", (t) => {
  const { board, query, session } = issue8BoardFixture(t), file = path.join(session, "task.md"), original = fs.readFileSync(file, "utf8");
  const external = board.getBoardSnapshot(query);
  assert.equal(external.source, "agy-brain"); assert.equal(external.planRevision, "");
  assert.deepEqual(board.clearPlan({ ...query, expectedRevision: "" }), { deleted: 0 });
  assert.equal(fs.readFileSync(file, "utf8"), original);
  board.updatePlan({ ...query, steps: [{ text: "new manual plan" }] });
  assert.throws(() => board.clearPlan({ ...query, expectedRevision: "" }), { code: "PLAN_CONFLICT" });
  assert.equal(board.getBoardSnapshot(query).steps[0].text, "new manual plan");
});
test("Issue #8 [2] clearPlan CAS refuses a newer on-disk manual plan", (t) => {
  const f = issue8BoardFixture(t), { board, query } = f;
  board.updatePlan({ ...query, steps: [{ text: "old" }] });
  const old = board.getBoardSnapshot(query);
  board.updatePlan({ ...query, steps: [{ text: "unseen new plan" }] });
  assert.throws(() => board.clearPlan({ ...query, expectedRevision: old.planRevision }), { code: "PLAN_CONFLICT" });
  assert.equal(board.getBoardSnapshot(query).steps[0].text, "unseen new plan");
});

test("Issue #8 [3] content revision rejects a stale full-plan overwrite even at the same timestamp", (t) => {
  const { board, query } = issue8BoardFixture(t);
  board.updatePlan({ ...query, steps: [{ id: "a", text: "A" }] });
  const old = board.getBoardSnapshot(query);
  board.updatePlan({ ...query, steps: [{ id: "a", text: "A" }, { id: "c", text: "concurrent C" }] });
  const latest = board.getBoardSnapshot(query);
  assert.equal(old.updatedAt, latest.updatedAt, "timestamp equality cannot establish content identity");
  assert.throws(() => board.updatePlan({ ...query, expectedRevision: old.planRevision, steps: [{ id: "a", text: "A", status: "completed" }] }), { code: "PLAN_CONFLICT" });
  assert.ok(board.getBoardSnapshot(query).steps.some(s => s.text === "concurrent C"));
});
function issue8Plan(revision, text = revision) {
  return { threadId: "thread-a", source: "hub-mcp", planRevision: revision, updatedAt: "2026-11-16T12:00:00Z", steps: [{ id: "hub-a", text, status: "pending" }], artifacts: [] };
}
function issue8Button(ui, action, dataset = {}) {
  const target = node(); Object.assign(target, { dataset: { action, ...dataset }, tagName: "BUTTON", isConnected: true }); target.closest = () => target;
  ui.root.contains = item => item === target; ui.content.contains = item => item === target || item === ui.sandbox.document.activeElement && item !== null;
  return target;
}

// Model the relevant DOM lifecycle: innerHTML disconnects the old editor and
// drops its focus/selection. Restoring only the old object cannot pass this.
function issue8DraftDom(ui) {
  let html = ui.content.innerHTML, editor, add, bodySlot, footSlot, prevSlot, countSlot, renders = 0;
  const spliceBetween = (openTag, closeSuffix, nextInner) => {
    const start = html.indexOf(openTag);
    if (start < 0) return;
    const contentStart = start + openTag.length;
    const end = closeSuffix ? html.indexOf(closeSuffix, contentStart) : html.lastIndexOf("</div>");
    if (end < 0) return;
    html = html.slice(0, contentStart) + nextInner + html.slice(end);
  };
  Object.defineProperty(ui.content, "innerHTML", {
    get: () => html,
    set(value) {
      html = value; renders++;
      if (editor) { editor.isConnected = false; add.isConnected = false; }
      if (bodySlot) bodySlot.isConnected = false;
      if (footSlot) footSlot.isConnected = false;
      if (prevSlot) prevSlot.isConnected = false;
      if (countSlot) countSlot.isConnected = false;
      if (ui.content.contains(ui.sandbox.document.activeElement)) ui.sandbox.document.activeElement = null;
      bodySlot = html.includes("<div data-board-body>") ? Object.defineProperty({ ...node(), isConnected: true }, "innerHTML", {
        get: () => "",
        set(v) {
          const suffix = html.includes('</div><div class="hub-board-add">') ? '</div><div class="hub-board-add">' : "</div><div data-board-foot>";
          spliceBetween("<div data-board-body>", suffix, String(v));
        },
      }) : null;
      footSlot = html.includes("<div data-board-foot>") ? Object.defineProperty({ ...node(), isConnected: true }, "innerHTML", {
        get: () => "",
        set(v) { spliceBetween("<div data-board-foot>", "</div></section><div data-board-preview>", String(v)); },
      }) : null;
      prevSlot = html.includes("<div data-board-preview>") ? Object.defineProperty({ ...node(), isConnected: true }, "innerHTML", {
        get: () => "",
        set(v) { spliceBetween("<div data-board-preview>", null, String(v)); },
      }) : null;
      countSlot = html.includes('<span class="hub-count">') ? Object.defineProperty({ ...node(), isConnected: true }, "textContent", {
        get: () => "",
        set(v) { html = html.replace(/<span class="hub-count">[^<]*<\/span>/, `<span class="hub-count">${ui.esc(v)}</span>`); },
      }) : null;
      const raw = html.match(/name="board-step-draft" value="([^"]*)"/)?.[1];
      if (raw === undefined) { editor = add = null; return; }
      const entities = { amp: "&", quot: '"', lt: "<", gt: ">", "#39": "'" };
      const valueText = raw.replace(/&(amp|quot|lt|gt|#39);/g, (_, key) => entities[key]);
      editor = node(); add = node();
      const origAddSet = add.setAttribute, origAddRem = add.removeAttribute;
      Object.assign(add, { tagName: "BUTTON", dataset: { action: "board-add" }, isConnected: true, disabled: /data-action="board-add"[^>]*\bdisabled\b/.test(html),
        setAttribute(k, v) { origAddSet(k, v); if (k === "disabled") html = html.replace(/(data-action="board-add")(?! disabled)/, "$1 disabled"); },
        removeAttribute(k) { origAddRem(k); if (k === "disabled") html = html.replace(/(data-action="board-add")\s+disabled\b/, "$1"); },
      });
      const origEdSet = editor.setAttribute, origEdRem = editor.removeAttribute;
      Object.assign(editor, { name: "board-step-draft", tagName: "INPUT", value: valueText, isConnected: true, disabled: false, readOnly: /name="board-step-draft"[^>]*\breadonly\b/.test(html),
        selectionStart: valueText.length, selectionEnd: valueText.length, selectionDirection: "none",
        setAttribute(k, v) {
          origEdSet(k, v);
          if (k === "value") html = html.replace(/(name="board-step-draft" value=")[^"]*"/, (_, prefix) => `${prefix}${ui.esc(v)}"`);
          if (k === "readonly") html = html.replace(/(name="board-step-draft" value="[^"]*")(?![^>]*\breadonly\b)/, "$1 readonly");
        },
        removeAttribute(k) { origEdRem(k); if (k === "readonly") html = html.replace(/(name="board-step-draft" value="[^"]*")\s+readonly\b/, "$1"); },
        focus() { assert.equal(this.isConnected, true); ui.sandbox.document.activeElement = this; },
        setSelectionRange(start, end, direction) { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; },
        closest: selector => selector === ".hub-board-add" ? { querySelector: () => add } : null,
      });
    },
  });
  ui.content.querySelector = selector => {
    if (selector === "[data-board-body]") return bodySlot;
    if (selector === "[data-board-foot]") return footSlot;
    if (selector === "[data-board-preview]") return prevSlot;
    if (selector === ".hub-section-heading .hub-count") return countSlot;
    return selector.includes("board-add") ? add : selector.includes("board-step-draft") ? editor : null;
  };
  ui.content.contains = item => !!item && (item === editor || item === add || item === bodySlot || item === footSlot || item === prevSlot || item === countSlot);
  ui.root.contains = item => ui.content.contains(item);
  return { get editor() { return editor; }, get add() { return add; }, get renders() { return renders; },
    type(text, start = text.length, end = start, direction = "none") {
      editor.value = text; editor.setSelectionRange(start, end, direction); ui.onInput({ target: editor });
    },
    enter() { ui.onEditorKeydown({ target: editor, key: "Enter", preventDefault() {} }); },
  };
}








for (const change of ["revision", "route", "project", "thread"]) test(`Issue #8 [2] old clear rejects a changed ${change}`, async () => {
  const calls = [], ui = issue8Ui(async (action, payload) => { calls.push({ action, payload }); return issue8Plan("new"); });
  ui.cache.board = issue8Plan("old"); ui.renderBoardTab();
  const button = issue8Button(ui, "board-clear");
  if (change === "revision") ui.cache.board = issue8Plan("new");
  if (change === "route") { ui.sandbox.location.pathname = "/threads/thread-b"; ui.sandbox.location.href = "https://fixture.test/threads/thread-b"; }
  if (change === "project") ui.state.projectRoot = "/other-project";
  if (change === "thread") { ui.state.threadId = "thread-b"; ui.state.context.threadId = "thread-b"; }
  ui.onClick({ target: button }); await new Promise(setImmediate);
  assert.equal(calls.filter(c => c.action === "board:clear").length, 0, "an unseen plan or another scope cannot be cleared");
  assert.equal(ui.root.querySelector(".hub-toast").hidden, false);
});











test("thread IDs follow threads, _chat, hash, UUID, then current context", () => {
  const ui = harness();
  const uuid = "4cdaf1fc-2929-415a-b055-3c06ef547683";
  for (const [pathname, hash, expected] of [["/threads/thread-a", "", "thread-a"], ["/_chat/thread-b", "", "thread-b"], ["/", "#/threads/hash-thread", "hash-thread"], [`/threads/${uuid}`, "", uuid], [`/workspace/${uuid}`, "", "__NEW__"]]) {
    Object.assign(ui.sandbox.location, { pathname, hash });
    assert.equal(ui.currentThreadId(), expected);
  }
  Object.assign(ui.sandbox.location, { pathname: "/", hash: "" });
  ui.state.context = { threadId: "context-thread" };
  assert.equal(ui.currentThreadId(), "context-thread");
});


for (const source of ["promotedTo", "promotedDraftRedirects"]) for (const wrapped of [false, true]) {
  test(`promoted draft ${source} (${wrapped ? "persisted state" : "flat store"}) resolves context and loads only its server plan`, async () => {
    const environmentId = "6ee0c274-d218-41d6-b277-cbfc803dfbc0", draftId = "draft-active", threadId = "3972c780-3288-4f8b-9990-c6cd999f70ba";
    const route = `/_t3_env_/${environmentId}/${threadId}`, ref = { environmentId, threadId }, calls = [];
    const store = source === "promotedTo" ? { draftThreadsByThreadKey: { [draftId]: { environmentId, threadId: "not-the-promoted-thread", promotedTo: ref } } } : { promotedDraftRedirects: { [draftId]: ref }, draftThreadsByThreadKey: { [draftId]: { promotedTo: null } } };
    const ui = harness(async (action, payload) => {
      calls.push({ action, payload });
      if (action === "hub:getContext") {
        assert.equal(payload.threadHint, `t3code://app/#${route}`); assert.equal(payload.routeHint, route);
        assert.doesNotMatch(payload.threadHint + payload.routeHint, /\/draft\//);
        return { environmentId, threadId, projectRoot: "/fixture", projectId: "fixture-project" };
      }
      return { threadId, source: "t3-native", steps: [{ text: "晋升后的当前会话计划", status: "in_progress" }] };
    }, { location: { pathname: "/", hash: `#/draft/${draftId}`, href: `t3code://app/#/draft/${draftId}` }, localStorage: { getItem: (key) => key === "t3code:composer-drafts:v1" ? JSON.stringify(wrapped ? { state: store } : store) : null, setItem() {} } });
    assert.equal(ui.currentThreadId(), threadId); assert.equal(ui.routeHint(), route);
    await ui.refreshContext();
    await new Promise(setImmediate); // refreshContext starts the initial board poll without blocking the closed drawer.
    assert.equal(ui.state.connected, true); assert.equal(ui.state.projectRoot, "/fixture"); assert.equal(ui.state.threadId, threadId);
    assert.equal(ui.boardMismatch(), false); assert.equal(ui.projectContextReady(), true);
    assert.equal(await ui.pollBoard(), true);
    assert.ok(calls.some((entry) => entry.action === "board:get" && entry.payload.threadId === threadId && entry.payload.strictThreadMatch === true));
    assert.match(ui.nodes.get("#t3-hub-live-board").innerHTML, /晋升后的当前会话计划/);
    assert.doesNotMatch(ui.nodes.get("#t3-hub-live-board").innerHTML, /会话未匹配/);
  });
}

test("promoted draft detection refreshes context when storage changes without a hash change", async () => {
  const environmentId = "6ee0c274-d218-41d6-b277-cbfc803dfbc0", threadId = "thread:promoted", draftId = "draft-active", calls = [];
  let promotedTo = null;
  const ui = harness(async (action, payload) => {
    calls.push({ action, payload });
    return action === "hub:getContext" ? { environmentId, threadId, projectRoot: "/fixture" } : { threadId, steps: [{ text: "原地址内晋升的计划", status: "pending" }] };
  }, { location: { pathname: "/", hash: `#/draft/${draftId}`, href: `t3code://app/#/draft/${draftId}` }, localStorage: { getItem: (key) => key === "t3code:composer-drafts:v1" ? JSON.stringify({ state: { draftThreadsByThreadKey: { [draftId]: { promotedTo } } } }) : null, setItem() {} } });
  ui.state.threadId = "__NEW__"; ui.setCurrentRoute(); const previousKey = ui.routeKey(), href = ui.sandbox.location.href;
  assert.equal(ui.currentThreadId(), "__NEW__");
  promotedTo = { environmentId, threadId }; assert.notEqual(ui.routeKey(), previousKey);
  ui.checkRoute(); assert.equal(ui.state.threadId, threadId);
  await new Promise(setImmediate);
  assert.equal(ui.sandbox.location.href, href); assert.equal(ui.boardMismatch(), false);
  assert.ok(calls.some((entry) => entry.action === "hub:getContext" && entry.payload.routeHint === `/_t3_env_/${environmentId}/thread%3Apromoted`));
  assert.match(ui.nodes.get("#t3-hub-live-board").innerHTML, /原地址内晋升的计划/);
  assert.match(drawerSource, /listen\(window, "storage", checkRoute\)/);
  assert.match(drawerSource, /routeTimer = setInterval\([^]*?checkRoute\(\)/);
});

test("resolved router route overrides a stale draft hash and route polling follows chat switches", async () => {
  const environmentId = "11111111-1111-4111-8111-111111111111", calls = [];
  const router = { state: { location: { pathname: `/${environmentId}/thread-a`, searchStr: "" } } };
  const ui = harness(async (action, payload) => {
    calls.push({ action, payload });
    if (action === "hub:getContext") return { environmentId, threadId: payload.routeHint.split("/").at(-1), projectRoot: "/fixture" };
    return { threadId: payload.threadId, steps: [] };
  }, {
    window: { __TSR_ROUTER__: router },
    location: { pathname: "/", hash: "#/draft/old-draft", href: "t3code://app/#/draft/old-draft" },
  });
  const firstRoute = `/${environmentId}/thread-a`, nextRoute = `/${environmentId}/thread-b`;
  assert.equal(ui.routeHint(), firstRoute);
  assert.equal(ui.currentThreadId(), "thread-a");
  await ui.refreshContext();
  assert.equal(ui.state.connected, true);
  assert.equal(ui.state.threadId, "thread-a");

  // T3 v0.1.10 updates the resolved route while retaining its initial draft hash.
  router.state.location = { pathname: nextRoute, searchStr: "" };
  ui.checkRoute();
  await new Promise(setImmediate);
  assert.equal(ui.routeHint(), nextRoute);
  assert.equal(ui.state.threadId, "thread-b");
  assert.ok(calls.some(({ action, payload }) => action === "hub:getContext" && payload.routeHint === nextRoute));
  assert.equal(ui.sandbox.location.hash, "#/draft/old-draft");

  router.state.location = { pathname: "/", searchStr: "" };
  ui.checkRoute();
  assert.equal(ui.routeHint(), "__NEW__");
  assert.equal(ui.currentThreadId(), "__NEW__");
  assert.equal(ui.state.threadId, "__NEW__");
  assert.equal(ui.state.connected, false);
});

for (const source of ["storage", "fiber"]) for (const candidate of ["hash", "router", "pathname"]) test(`Round-2 P2 #5 environment-prefixed draft stays isolated until in-place promotion (${source}, ${candidate})`, async () => {
  const environmentId = "remote:west", draftId = "draft:active/7", threadId = "thread:promoted/7", calls = [];
  const route = `${candidate === "router" ? "" : "/"}_t3_env_/${encodeURIComponent(environmentId)}/draft/${encodeURIComponent(draftId)}`;
  const store = { promotedDraftRedirects: {} }, props = { draftId, isServerThread: false, threadId };
  const host = { __reactFiber$fixture: { memoizedProps: props } };
  const href = `t3code://app/${candidate === "hash" ? `#${route}` : candidate === "pathname" ? route : ""}`;
  const ui = harness(async (action, payload) => {
    calls.push({ action, payload });
    return action === "hub:getContext" ? { environmentId, threadId, projectRoot: "/promoted-project" } : { threadId, steps: [{ text: "promoted environment plan" }] };
  }, {
    location: { pathname: candidate === "pathname" ? route : "/", hash: candidate === "hash" ? `#${route}` : "", href },
    window: candidate === "router" ? { __TSR_ROUTER__: { state: { location: { pathname: route } } } } : {},
    localStorage: { getItem: (key) => key === "t3code:composer-drafts:v1" ? JSON.stringify({ state: store }) : null, setItem() {} },
    document: { getElementById: (id) => source === "fiber" && id === "root" ? host : null },
  });
  Object.assign(ui.state, { connected: true, threadId: "old-thread", projectRoot: "/old-project", context: { environmentId: "old-environment", threadId: "old-thread", projectRoot: "/old-project" } });
  ui.setCurrentRoute();
  assert.equal(ui.routeHint(), route); assert.equal(ui.currentThreadId(), "__NEW__");
  await ui.refreshContext(); await ui.pollBoard(); await ui.updateBoard(null, "add");
  assert.equal(calls.length, 0, "an unpromoted prefixed draft never requests context or a plan for the previous project");
  assert.equal(ui.state.connected, false); assert.equal(ui.state.context, null); assert.equal(ui.state.projectRoot, null);
  assert.equal(ui.state.threadId, "__NEW__"); assert.equal(ui.cache.board, null);
  const before = ui.routeKey();
  if (source === "storage") store.promotedDraftRedirects[draftId] = { environmentId: "   ", threadId };
  else props.isServerThread = true;
  const promoted = `/_t3_env_/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
  assert.equal(ui.routeHint(), promoted, "promotion without an environment in the ref uses the decoded path environment");
  assert.notEqual(ui.routeKey(), before);
  ui.checkRoute(); await new Promise(setImmediate);
  assert.equal(ui.sandbox.location.href, href, "promotion does not require navigating away from the draft URL");
  assert.equal(ui.state.connected, true); assert.equal(ui.state.threadId, threadId); assert.equal(ui.state.projectRoot, "/promoted-project");
  assert.equal(ui.boardMismatch(), false); assert.equal(ui.projectContextReady(), true);
  const contextCall = calls.find((entry) => entry.action === "hub:getContext");
  assert.equal(contextCall.payload.routeHint, promoted);
  assert.equal(contextCall.payload.threadHint, `t3code://app/#${promoted}`);
  assert.ok(calls.some((entry) => entry.action === "board:get" && entry.payload.projectRoot === "/promoted-project" && entry.payload.threadId === threadId && entry.payload.strictThreadMatch === true));
  assert.match(ui.nodes.get("#t3-hub-live-board").innerHTML, /promoted environment plan/);
});

for (const malformed of ["environment", "draft"]) test(`Round-2 P2 #5 malformed prefixed draft ${malformed} cannot promote or fetch old context`, async () => {
  const calls = [], route = `/_t3_env_/${malformed === "environment" ? "%E0%A4%A" : "remote%3Awest"}/draft/${malformed === "draft" ? "%E0%A4%A" : "draft-a"}`;
  const ui = harness(async (action) => { calls.push(action); return {}; }, {
    location: { pathname: "/", hash: `#${route}`, href: `t3code://app/#${route}` },
    localStorage: { getItem: () => JSON.stringify({ promotedDraftRedirects: { "draft-a": { environmentId: "remote:west", threadId: "server-thread" }, "%E0%A4%A": { threadId: "server-thread" } } }), setItem() {} },
  });
  ui.state.context = { environmentId: "old", threadId: "old-thread", projectRoot: "/old-project" };
  assert.equal(ui.routeHint(), route); assert.equal(ui.currentThreadId(), "__NEW__");
  await ui.refreshContext();
  assert.equal(calls.length, 0); assert.equal(ui.state.context, null); assert.equal(ui.state.connected, false);
});

test("Round-2 P2 #5 an explicit promoted environment takes precedence over the draft path", () => {
  const ui = harness(undefined, {
    location: { pathname: "/", hash: "#/_t3_env_/path%3Aenvironment/draft/draft-a" },
    localStorage: { getItem: () => JSON.stringify({ promotedDraftRedirects: { "draft-a": { environmentId: "ref:environment", threadId: "server-thread" } } }), setItem() {} },
  });
  assert.equal(ui.routeHint(), "/_t3_env_/ref%3Aenvironment/server-thread");
});

for (const kind of ["threadRef", "activeThreadKey", "thread"]) test(`promoted draft Fiber fallback accepts only matching server props (${kind})`, () => {
  const environmentId = "6ee0c274-d218-41d6-b277-cbfc803dfbc0", threadId = "fiber-thread", draftId = "current-draft";
  const props = { draftId, isServerThread: true, environmentId, [kind]: kind === "threadRef" ? { environmentId, threadId } : kind === "thread" ? { id: threadId } : `${environmentId}:${threadId}` };
  const fiber = { memoizedProps: { draftId: "another-draft", isServerThread: true, threadRef: { environmentId, threadId: "other-thread" } }, child: { memoizedProps: props } };
  const host = { __reactContainer$fixture: { current: fiber } };
  const ui = harness(undefined, { location: { pathname: "/", hash: `#/draft/${draftId}`, href: `t3code://app/#/draft/${draftId}` }, document: { getElementById: (id) => id === "root" ? host : null } });
  assert.equal(ui.routeHint(), `/_t3_env_/${environmentId}/${threadId}`); assert.equal(ui.currentThreadId(), threadId);
  props.isServerThread = false; assert.equal(ui.currentThreadId(), "__NEW__");
  props.isServerThread = true; props.draftId = "another-draft"; assert.equal(ui.currentThreadId(), "__NEW__");
});

test("promoted draft Fiber walk is bounded to 400 nodes and tolerates invalid or denied storage", () => {
  const props = { draftId: "bounded-draft", isServerThread: true, threadRef: { threadId: "fiber-thread" } }, start = {};
  let leaf = start; for (let index = 1; index < 400; index++) leaf = leaf.child = {};
  leaf.child = { memoizedProps: props, sibling: start };
  const ui = harness(undefined, { location: { pathname: "/", hash: "#/draft/bounded-draft" }, document: { getElementById: () => ({ __reactFiber$fixture: start }) }, localStorage: { getItem() { throw new Error("storage denied"); }, setItem() {} } });
  assert.equal(ui.currentThreadId(), "__NEW__", "node 401 must not be inspected");
  leaf.memoizedProps = props;
  assert.equal(ui.currentThreadId(), "fiber-thread"); assert.equal(ui.routeHint(), "/fiber-thread");
  ui.sandbox.localStorage.getItem = () => "{invalid JSON";
  assert.equal(ui.currentThreadId(), "fiber-thread", "invalid persisted data must still permit a verified matching Fiber");
});

for (const source of ["memoizedProps", "pendingProps", "memoizedState", "hookState"]) {
  test(`promoted draft uses direct T3 v0.1.10 thread fields from the same Fiber (${source})`, () => {
    const draftId = "real-t3-draft", environmentId = "env:local/1", threadId = "thread:delegated-task:command%3A7";
    const props = { draftId, isServerThread: true, environmentId, threadId, activeThreadKey: "wrong-env:wrong-thread" };
    const fiber = source === "hookState" ? { memoizedState: { memoizedState: null, next: { memoizedState: props } } } : { [source]: props };
    const ui = harness(undefined, { location: { pathname: "/", hash: `#/draft/${draftId}` }, document: { getElementById: () => ({ __reactFiber$fixture: fiber }) } });
    assert.equal(ui.routeHint(), `/_t3_env_/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`);
    assert.equal(ui.currentThreadId(), threadId);
    props.isServerThread = false;
    assert.equal(ui.currentThreadId(), "__NEW__", "a matching draft ID alone does not prove promotion");
  });
}

for (const activeThreadKey of ["env-1:thread:delegated-task:command%3A7", "thread:delegated-task:command%3A7"]) {
  test(`promoted draft parses the first activeThreadKey separator without truncating thread IDs (${activeThreadKey})`, () => {
    const draftId = "key-draft", threadId = "thread:delegated-task:command%3A7";
    const fiber = { memoizedProps: { draftId, isServerThread: true, activeThreadKey, environmentId: "explicit-environment" } };
    const ui = harness(undefined, { location: { pathname: "/", hash: `#/draft/${draftId}` }, document: { getElementById: () => ({ __reactContainer$fixture: fiber }) } });
    assert.equal(ui.routeHint(), `/_t3_env_/${activeThreadKey.startsWith("thread:") ? "explicit-environment" : "env-1"}/${encodeURIComponent(threadId)}`);
    assert.equal(ui.currentThreadId(), threadId);
  });
}

for (const kind of ["bare-key", "known-environment-slash-key", "uuid-slash-key"]) {
  test(`promoted draft keeps existing environment-aware key compatibility (${kind})`, () => {
    const environmentId = kind === "uuid-slash-key" ? "6ee0c274-d218-41d6-b277-cbfc803dfbc0" : "env-1", threadId = "fiber-thread", draftId = "compatible-key-draft";
    const props = { draftId, isServerThread: true, activeThreadKey: kind === "bare-key" ? threadId : `${environmentId}/${threadId}` };
    if (kind !== "uuid-slash-key") props.environmentId = environmentId;
    const ui = harness(undefined, { location: { pathname: "/", hash: `#/draft/${draftId}` }, document: { getElementById: () => ({ __reactFiber$fixture: { memoizedProps: props } }) } });
    assert.equal(ui.routeHint(), `/_t3_env_/${environmentId}/${threadId}`);
    assert.equal(ui.currentThreadId(), threadId);
  });
}

for (const wrapped of [false, true]) for (const cleanup of [false, true]) {
  test(`promoted draft reads native drafts/promotedDraftRedirects (${wrapped ? "persisted state" : "flat store"}, ${cleanup ? "draft deleted" : "draft present"})`, async () => {
    const draftId = "native-store-draft", environmentId = "env-1", threadId = "thread:delegated-task:command%3A7";
    const ref = { environmentId, threadId }, route = `/_t3_env_/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`, calls = [];
    const store = cleanup ? { drafts: {}, promotedDraftRedirects: { [draftId]: ref } } : { drafts: { [draftId]: { promotedTo: ref } } };
    const ui = harness(async (action, payload) => {
      calls.push({ action, payload });
      return action === "hub:getContext" ? { ...ref, projectRoot: "/fixture" } : { steps: [] };
    }, { location: { pathname: "/", hash: `#/draft/${draftId}`, href: `t3code://app/#/draft/${draftId}` }, localStorage: { getItem: (key) => key === "t3code:composer-drafts:v1" ? JSON.stringify(wrapped ? { state: store } : store) : null, setItem() {} } });
    assert.equal(ui.routeHint(), route);
    assert.equal(ui.currentThreadId(), threadId);
    await ui.refreshContext();
    const contextCall = calls.find((entry) => entry.action === "hub:getContext");
    assert.equal(contextCall.payload.routeHint, route);
    assert.equal(contextCall.payload.threadHint, `t3code://app/#${route}`);
    assert.equal(ui.state.connected, true);
    assert.equal(ui.state.threadId, threadId);
  });
}

for (const key of ["__reactContainer$fixture", "__reactFiber$fixture"]) for (const attachment of ["root", "descendant"]) {
  test(`promoted draft inspects the committed FiberRoot and ignores an older server tree (${key}, ${attachment})`, () => {
    const draftId = "double-buffered-draft", environmentId = "env-1", threadId = "old-server-thread";
    const oldChild = { memoizedProps: { draftId, isServerThread: true, environmentId, threadId, threadRef: { environmentId, threadId } } };
    const committedChild = { memoizedProps: { draftId, isServerThread: false, environmentId, threadId } };
    const oldRoot = { child: oldChild }, committedRoot = { child: committedChild }, fiberRoot = { current: committedRoot };
    oldChild.return = oldRoot; committedChild.return = committedRoot;
    oldRoot.stateNode = committedRoot.stateNode = fiberRoot;
    oldRoot.alternate = committedRoot; committedRoot.alternate = oldRoot;
    const host = { [key]: attachment === "root" ? oldRoot : oldChild };
    const ui = harness(undefined, { location: { pathname: "/", hash: `#/draft/${draftId}` }, document: { getElementById: () => host } });
    assert.equal(ui.currentThreadId(), "__NEW__", "the old tree's promotion must not override the committed tree");
    assert.equal(ui.routeHint(), `/draft/${draftId}`);
    committedChild.memoizedProps.isServerThread = true;
    assert.equal(ui.routeHint(), `/_t3_env_/${environmentId}/${threadId}`, "promotion in the current tree is still detected");
  });
}

for (const tab of ["skills", "memory"]) {
  test(`late Project A context after a draft hash change is discarded before checkRoute runs (${tab})`, async () => {
    const calls = [];
    let finishContext;
    const ui = harness(async (action, payload) => {
      calls.push({ action, payload });
      if (action === "hub:getContext") return new Promise((resolve) => { finishContext = resolve; });
      return {};
    });
    Object.assign(ui.state, { open: true, tab, connected: true, projectRoot: "/project-a", threadId: "thread-a", context: { projectRoot: "/project-a", threadId: "thread-a", project: { name: "Project A" } } });
    ui.setCurrentRoute();
    const pending = ui.refreshContext();
    Object.assign(ui.sandbox.location, { pathname: "/", hash: "#/draft/draft-b", href: "t3code://app/#/draft/draft-b" });
    // Deliberately resolve before the hashchange listener / route timer runs.
    finishContext({ projectRoot: "/project-a", threadId: "thread-a", project: { name: "Project A" } });
    await pending;
    await new Promise(setImmediate);
    assert.equal(ui.state.connected, false);
    assert.equal(ui.state.context, null);
    assert.equal(ui.state.projectRoot, null);
    assert.equal(ui.state.threadId, "__NEW__");
    assert.equal(ui.isContextLoading(), false);
    assert.equal(ui.routeScope().cached, ui.routeScope().current);
    assert.deepEqual(calls.map((entry) => entry.action), ["hub:getContext"], "neither draft lookup nor Project A tab RPCs may start");
    assert.doesNotMatch(ui.root.querySelector(".hub-header").innerHTML, /Project A/);
    for (const key of ["skills", "mcp", "memory", "overview"]) assert.equal(ui.cache[key], null);
  });
}

for (const outcome of ["resolve", "reject"]) {
  test(`stale Project A context ${outcome} starts the new route without clearing its loading state`, async () => {
    const calls = [];
    let finishA, finishB;
    const ui = harness(async (action, payload) => {
      calls.push({ action, payload });
      if (action !== "hub:getContext") return {};
      return new Promise((resolve, reject) => {
        if (payload.routeHint === "/threads/thread-a") finishA = () => outcome === "resolve" ? resolve({ projectRoot: "/project-a", threadId: "thread-a" }) : reject(new Error("Project A failed late"));
        else finishB = resolve;
      });
    });
    ui.setCurrentRoute();
    const pending = ui.refreshContext();
    Object.assign(ui.sandbox.location, { pathname: "/threads/thread-b", href: "https://fixture.test/threads/thread-b" });
    finishA(); await pending;
    assert.equal(typeof finishB, "function", "a route change missed by the listener must be processed immediately");
    assert.equal(ui.state.connected, false);
    assert.equal(ui.state.context, null);
    assert.equal(ui.state.projectRoot, null);
    assert.equal(ui.state.threadId, "thread-b");
    assert.equal(ui.isContextLoading(), true, "the old request must not finish the new request's loading state");
    finishB({ projectRoot: "/project-b", threadId: "thread-b" });
    await new Promise(setImmediate);
    assert.equal(ui.state.projectRoot, "/project-b");
    assert.equal(ui.state.connected, true);
    assert.equal(ui.isContextLoading(), false);
    assert.ok(!calls.some((entry) => entry.action !== "hub:getContext" && entry.payload.projectRoot === "/project-a"));
  });
}

for (const source of ["search", "href", "router"]) for (const outcome of ["resolve", "reject"]) test(`Round-2 P2 #1 late context ${outcome} after ${source} environment switch is rejected before route listeners run`, async () => {
  const envA = "environment-a", envB = "environment-b", calls = [];
  const query = (env) => `?environmentId=${env}`;
  let finishA, finishB, contextCalls = 0;
  const ui = harness(async (action, payload) => {
    calls.push({ action, payload });
    if (action !== "hub:getContext") return { threadId: "thread-a", steps: [] };
    return new Promise((resolve, reject) => {
      if (++contextCalls === 1) finishA = () => outcome === "resolve" ? resolve({ environmentId: envA, projectRoot: "/project-a", threadId: "thread-a" }) : reject(new Error("Environment A failed late"));
      else finishB = resolve;
    });
  }, {
    location: { search: source === "search" ? query(envA) : "", href: `https://fixture.test/threads/thread-a${source === "href" ? query(envA) : ""}` },
    window: source === "router" ? { __TSR_ROUTER__: { state: { location: { pathname: "/threads/thread-a", searchStr: query(envA) } } } } : {},
  });
  ui.setCurrentRoute();
  const requestedRoute = ui.routeHint(), previousKey = ui.routeKey(), pending = ui.refreshContext();
  if (source === "search") ui.sandbox.location.search = query(envB);
  else if (source === "href") ui.sandbox.location.href = `https://fixture.test/threads/thread-a${query(envB)}`;
  else ui.sandbox.window.__TSR_ROUTER__.state.location.searchStr = query(envB);
  assert.equal(ui.routeHint(), requestedRoute, "the pathname and hash deliberately stay unchanged");
  // No hashchange, router callback, checkRoute or timer has run yet.
  finishA(); await pending;
  assert.equal(typeof finishB, "function", "the stale completion must immediately refresh the live URL scope");
  assert.notEqual(ui.routeKey(), previousKey, "routeKey must also observe search-only and router-only changes");
  assert.equal(ui.state.connected, false); assert.equal(ui.state.context, null); assert.equal(ui.state.projectRoot, null);
  assert.equal(ui.state.contextError, "", "the old environment's failure must not replace the new request's status");
  assert.equal(ui.isContextLoading(), true, "the old completion must not finish the new request");
  assert.equal(calls.filter((entry) => entry.action === "board:get").length, 0);
  finishB({ environmentId: envB, projectRoot: "/project-b", threadId: "thread-a" });
  await new Promise(setImmediate);
  assert.equal(ui.state.connected, true); assert.equal(ui.state.projectRoot, "/project-b"); assert.equal(ui.state.context.environmentId, envB);
  assert.equal(ui.isContextLoading(), false, "resolving context on an unchanged URL must not invalidate its own identity");
  assert.ok(calls.some((entry) => entry.action === "board:get" && entry.payload.projectRoot === "/project-b"));
  assert.ok(!calls.some((entry) => entry.action !== "hub:getContext" && entry.payload.projectRoot === "/project-a"));
});



test("unpromoted draft with stale row IDs, other redirects and unrelated server Fibers stays isolated", async () => {
  const calls = [], environmentId = "6ee0c274-d218-41d6-b277-cbfc803dfbc0", draftId = "unpromoted";
  const store = { state: { draftThreadsByThreadKey: { [draftId]: { environmentId, threadId: "old-server", projectId: "old-project", promotedTo: null } }, promotedDraftRedirects: { another: { environmentId, threadId: "other-server" } } } };
  const host = { __reactFiber$fixture: { memoizedProps: { draftId, isServerThread: false, threadRef: { environmentId, threadId: "old-server" } }, child: { memoizedProps: { draftId: "another", isServerThread: true, threadRef: { environmentId, threadId: "other-server" } } } } };
  const ui = harness(async (action, payload) => { calls.push({ action, payload }); return { ok: false, error: "无法确认新会话所属项目，请先选择项目" }; }, { location: { pathname: "/", hash: `#/draft/${draftId}`, href: `t3code://app/#/draft/${draftId}` }, localStorage: { getItem: (key) => key === "t3code:composer-drafts:v1" ? JSON.stringify(store) : null, setItem() {} }, document: { getElementById: (id) => id === "root" ? host : null } });
  ui.state.context = { environmentId, threadId: "old-server", projectRoot: "/old-project" };
  assert.equal(ui.currentThreadId(), "__NEW__"); assert.equal(ui.routeHint(), `/draft/${draftId}`);
  await ui.refreshContext();
  assert.equal(ui.state.threadId, "__NEW__"); assert.equal(ui.state.connected, false); assert.equal(ui.state.projectRoot, null);
  await ui.pollBoard(); await ui.updateBoard(null, "add");
  assert.equal(calls.filter((entry) => entry.action.startsWith("board:")).length, 0);
  assert.equal(calls.length, 0, "an unpromoted draft never asks the backend for the previous project's context");
  assert.equal(ui.cache.board, null);
});

test("promoted draft router and pathname candidates resolve without borrowing stale context", async () => {
  for (const candidate of ["router", "pathname"]) {
    const route = "/draft/no-environment", ui = harness(undefined, { location: { pathname: candidate === "pathname" ? route : "/", hash: "" }, window: candidate === "router" ? { __TSR_ROUTER__: { state: { location: { pathname: route } } } } : {}, localStorage: { getItem: (key) => key === "t3code:composer-drafts:v1" ? JSON.stringify({ promotedDraftRedirects: { "no-environment": { threadId: "thread:local" } } }) : null, setItem() {} } });
    ui.state.context = { threadId: "stale-thread" };
    assert.equal(ui.routeHint(), "/thread%3Alocal"); assert.equal(ui.currentThreadId(), "thread:local");
  }
});




test("memory list/detail, version rollback and recall show local YYYY-MM-DD HH:mm", () => {
  const ui = harness();
  confirmMemoryProject(ui);
  const timestamp = new Date(2026, 10, 15, 22, 55, 37).toISOString();
  assert.equal(ui.formatExactTime(timestamp), "2026-11-15 22:55");
  assert.equal(ui.formatExactTime(timestamp, true), "2026-11-15 22:55:37");
  assert.match(ui.formatExactTime(0), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(ui.formatExactTime(null), "");
  assert.equal(ui.formatExactTime("not a date"), "未知");
  const item = { id: "precise-time", title: "主题与排版约定", content: "纯白默认", updatedAt: timestamp, lastRecalledAt: timestamp, version: 2, history: [{ version: 1, timestamp, content: "old" }] };
  Object.assign(ui.state, { tab: "memory", selectedMemory: item.id, historyExpanded: { [`/fixture\u0000${item.id}`]: true } });
  ui.cache.memory = { items: [item] };
  ui.renderMemoryList();
  const html = ui.nodes.get("#t3-hub-memory-list").innerHTML;
  assert.ok([...html.matchAll(/2026-11-15 22:55<\/time>/g)].length >= 4, html);
  assert.match(html, /title="2026-11-15 22:55:37"/);
  assert.ok(html.includes("最近召回"));
  assert.ok(html.includes("v1"));
  assert.match(html, /class="hub-history-list" >/, "revision history is expanded and its exact time is visible");
});




test("native card lookup falls back past unrelated asides and accepts shadow-drawn borders", () => {
  const { ui, sidebar, card, label } = relationFixture();
  sidebar.querySelectorAll = () => [];
  ui.sandbox.document.body.querySelectorAll = () => [label];
  ui.setStyle((element) => element === card ? { visibility: "visible", borderRadius: "14px", borderTopWidth: "0px", boxShadow: "0 0 0 1px rgb(226, 232, 240)" } : { visibility: "visible", borderRadius: "0px" });
  assert.equal(ui.findSessionRelationsCard().card, card);
});


test("[P1] clear on thread-a sends only that threadId, never a bare projectRoot wipe", async () => {
  const calls = [];
  const ui = harness(async (action, payload) => {
    calls.push({ action, payload });
    return action === "board:get" ? { steps: [] } : {};
  });
  Object.assign(ui.state, { connected: true, projectRoot: "/fixture", threadId: "thread-a" });
  ui.cache.board = { source: "hub-mcp", steps: [{ id: "1", text: "a", status: "pending" }] };
  await ui.updateBoard(null, "clear");
  const clearCall = calls.find((x) => x.action === "board:clear");
  assert.equal(clearCall.payload.threadId, "thread-a", "clear carries the exact thread, not undefined/project-only");
  assert.equal(clearCall.payload.projectRoot, "/fixture");
  assert.equal(clearCall.payload.strictThreadMatch, true);
  assert.ok(clearCall.payload.threadId, "threadId present so backend cannot widen to sibling threads by projectRoot");
});



test("memory-only navigation loads its live data without requesting hidden catalogs", async () => {
  const calls = [], ui = harness(async (action) => { calls.push(action); return { items: [], agents: [] }; });
  confirmMemoryProject(ui);
  ui.renderChrome();
  const tabs = ui.root.querySelector(".hub-tabs").innerHTML;
  assert.deepEqual([...tabs.matchAll(/data-tab="([^"]+)"/g)].map((match) => match[1]), ["memory"]);
  await ui.loadTab();
  assert.ok(calls.includes("memory:connections"));
  assert.ok(calls.includes("memory:list"));
  assert.doesNotMatch(calls.join(" "), /mcp:list|skills:list|plugins:list|hooks:list|subagents:list|memory:dream|orchestration/);
  assert.doesNotMatch(drawerSource, /listen\(document,\s*"(?:input|focusin|click|keyup|keydown)"[^;]*onComposer/);
});

test("project tier edits start with effective inherited values and save only that project item", async () => {
  const calls = [], ui = harness(async (action, payload) => { calls.push({ action, payload }); return { item: payload.item }; });
  const globalItem = { id: "worker", name: "worker", role: "implementation", providerInstanceId: "muse", model: "global-model", effort: "max", systemPrompt: "global prompt", enabled: true };
  const projectItem = { id: "worker", overridesGlobal: true, model: "project-model" };
  const effective = { ...globalItem, ...projectItem };
  ui.cache.subagents = { globalItems: [globalItem], projectItems: [projectItem], tierGroups: [{ id: "work", levels: [{ level: 1, id: "worker", kind: "agent", globalItem, projectItem, item: effective, source: "project", configured: true }] }] };
  ui.ready(); ui.setCurrentRoute();
  Object.assign(ui.state, { connected: true, tab: "subagents", subagentScope: "project", threadId: "thread-a", projectRoot: "/fixture", context: { threadId: "thread-a", projectRoot: "/fixture" } });
  assert.equal(ui.subagentItems()[0].systemPrompt, "global prompt");
  await ui.persistSubagent("worker", { model: "new-model" });
  const save = calls.find((call) => call.action === "subagents:update");
  assert.equal(save.payload.scope, "project"); assert.equal(save.payload.projectRoot, "/fixture");
  assert.equal(save.payload.item.model, "new-model"); assert.equal(save.payload.item.systemPrompt, "global prompt");
  assert.equal(save.payload.item.overridesGlobal, true); assert.equal(ui.cache.subagents.projectItems.length, 1);
  assert.equal(ui.cache.subagents.globalItems[0].model, "global-model");
});

test("mode changes use the observed revision and re-read after a rejected update", async () => {
  const calls = [], ui = harness(async (action, payload) => {
    calls.push({ action, payload });
    return action === "subagents:orchestration:update" ? { ok: false, error: "revision changed" } : { policyVersion: 2, swarmMode: "off", modeRevision: "new", modeApplied: false };
  });
  ui.cache.orchestration = { policyVersion: 2, swarmMode: "off", modeRevision: "old", modeApplied: true };
  await ui.setCooperationMode(null, "on");
  assert.equal(calls[0].payload.expectedRevision, "old"); assert.equal(calls[0].payload.swarmMode, "on");
  assert.equal(calls[1].action, "subagents:orchestration:get"); assert.equal(ui.cache.orchestration.modeRevision, "new");
  assert.match(ui.renderCommander(), /待同步/);
});

test("a concurrent mode reversal reports the actual readback instead of claiming success", async () => {
  const ui = harness(async (action) => action === "subagents:orchestration:update" ? { ok: true } : { policyVersion: 2, swarmMode: "off", modeRevision: "new", modeApplied: true });
  ui.cache.orchestration = { policyVersion: 2, swarmMode: "off", modeRevision: "old", modeApplied: true };
  await ui.setCooperationMode(null, "on");
  assert.equal(ui.cache.orchestration.swarmMode, "off");
  const message = ui.root.querySelector(".hub-toast").innerHTML;
  assert.match(message, /其他操作改为常规分工/); assert.doesNotMatch(message, /已保存并同步/);
});

test("T3 collaboration mode exposes a clear selected style for the verified choice", () => {
  const ui = harness();
  for (const selected of ["off", "on"]) {
    ui.cache.orchestration = { policyVersion: 2, swarmMode: selected, modeApplied: true, modeRevision: "revision" };
    const html = ui.renderCommander();
    for (const mode of ["off", "on"]) assert.match(html, new RegExp(`data-mode="${mode}" aria-pressed="${mode === selected}"`));
  }
  ui.cache.orchestration = { policyVersion: 1, swarmMode: "off" };
  assert.doesNotMatch(ui.renderCommander(), /aria-pressed="true"/, "an unverified mode is not marked selected");
  assert.match(drawerSource, /\.hub-commander \.hub-segments>button\[aria-pressed=true\][^{]*\{[^}]*background:var\(--hub-active\)[^}]*color:var\(--hub-on-active\)/);
});

test("incomplete mode rollback warns that rule files need inspection", async () => {
  const ui = harness(async (action) => action === "subagents:orchestration:update" ? { ok: false, error: "write_failed", rolledBack: false, rollbackFailures: [{ path: "/fixture/rules" }] } : { policyVersion: 2, swarmMode: "off", modeRevision: "new", modeApplied: false });
  ui.cache.orchestration = { policyVersion: 2, swarmMode: "off", modeRevision: "old", modeApplied: true };
  await ui.setCooperationMode(null, "on");
  assert.match(ui.root.querySelector(".hub-toast").innerHTML, /1 个规则文件未能自动恢复/);
  assert.match(ui.renderCommander(), /待同步/);
});




test("hook project writes require the resolved current project and exclude other project hooks", async () => {
  const calls = [], ui = harness(async (action, payload) => { calls.push({ action, payload }); return action === "hooks:list" ? { items: [{ id: "global", scope: "off", configured: false, configurationStatus: "not-configured" }] } : { item: { scope: payload.scope } }; });
  const hooks = [{ id: "global", title: "Global", scope: "global" }, { id: "project-a", title: "A", scope: "project", projectRoot: "/project-a", custom: true }, { id: "project-b", title: "B", scope: "project", projectRoot: "/project-b", custom: true }];
  ui.cache.hooks = { items: hooks };
  ui.ready(); ui.setCurrentRoute();
  Object.assign(ui.state, { connected: true, threadId: "thread-a", projectRoot: "/project-a", context: { threadId: "thread-a", projectRoot: "/project-a" }, hookDraft: { title: "new", command: "true", scope: "project" } });
  assert.deepEqual(Array.from(ui.hookItems(), (item) => item.id), ["global", "project-a"]);
  await ui.setDomainScope("hooks", "global", "project", null);
  await ui.setDomainScope("hooks", "project-a", "off", null);
  await ui.saveHook(null); await ui.deleteHook("project-a", null);
  assert.equal(calls.length, 0, "project hooks are read-only even when the project is verified");
  Object.assign(ui.sandbox.location, { pathname: "/threads/thread-b", href: "https://fixture.test/threads/thread-b" });
  await ui.setDomainScope("hooks", "global", "project", null);
  await ui.setDomainScope("hooks", "project-a", "off", null);
  await ui.saveHook(null); await ui.deleteHook("project-a", null);
  assert.equal(calls.length, 0, "stale A cannot be written while B is resolving");
  assert.deepEqual(Array.from(ui.hookItems(), (item) => item.id), ["global"]);
  await ui.setDomainScope("hooks", "global", "off", null);
  assert.equal(calls.length, 2, "explicit global operation remains available and is read back");
  assert.equal(calls[0].payload.projectRoot, null);
});

test("Hook cards distinguish saved scope from missing, partial and actual host configuration", () => {
  const ui = harness();
  ui.cache.hooks = { items: [
    { id: "missing", title: "Missing", scope: "global", configured: false, configuredIn: [], configurationStatus: "not-configured" },
    { id: "partial", title: "Partial", scope: "global", configured: true, configuredIn: ["codex"], configurationStatus: "partial" },
    { id: "missing-handler", title: "Missing handler", scope: "global", configured: false, configuredIn: [], partialIn: ["codex"], configurationStatus: "partial" },
    { id: "both", title: "Both", scope: "global", configured: true, configuredIn: ["codex", "claude"], configurationStatus: "configured" },
  ] };
  ui.renderHooks(); const html = ui.content.innerHTML;
  assert.match(html, /未检测到配置/); assert.match(html, /部分宿主已配置 · Codex/);
  assert.match(html, /配置不完整 · 未完整: Codex/);
  assert.match(html, /已检测到配置 · Codex \/ Claude/); assert.match(html, /保存范围（实际配置状态见上方）/);
});

test("partial Hook readback does not claim that both hosts are configured", async () => {
  const ui = harness(async (action) => action === "hooks:list" ? { items: [{ id: "h", title: "H", scope: "global", configured: true, configuredIn: ["codex"], configurationStatus: "partial" }] } : { ok: true });
  ui.cache.hooks = { items: [{ id: "h", title: "H", scope: "off", configured: false }] };
  await ui.setDomainScope("hooks", "h", "global", null);
  assert.equal(ui.cache.hooks.items[0].configurationStatus, "partial");
  assert.match(ui.root.querySelector(".hub-toast").innerHTML, /尚未全部确认/);
});

test("partially remaining Hook entries do not count as fully disabled", async () => {
  const ui = harness(async (action) => action === "hooks:list" ? { items: [{ id: "h", title: "H", scope: "off", configured: false, partialIn: ["codex"], configurationStatus: "partial" }] } : { ok: true });
  ui.cache.hooks = { items: [{ id: "h", title: "H", scope: "global", configured: true }] };
  await ui.setDomainScope("hooks", "h", "off", null);
  assert.match(ui.root.querySelector(".hub-toast").innerHTML, /尚未全部确认/);
});

test("late global hook update cannot update another session's visible cache", async () => {
  let resolve;
  const ui = harness(async () => new Promise((done) => { resolve = done; }));
  ui.cache.hooks = { items: [{ id: "h", title: "H", scope: "global" }] };
  ui.ready(); ui.setCurrentRoute();
  Object.assign(ui.state, { connected: true, threadId: "thread-a", projectRoot: "/project-a", context: { threadId: "thread-a", projectRoot: "/project-a" } });
  const pending = ui.setDomainScope("hooks", "h", "off", null);
  Object.assign(ui.sandbox.location, { pathname: "/threads/thread-b", href: "https://fixture.test/threads/thread-b" });
  resolve({ item: { id: "h", scope: "off" } });
  await pending;
  assert.equal(ui.cache.hooks.items[0].scope, "global");
  assert.equal(ui.root.querySelector(".hub-toast").innerHTML, "", "a stale save does not report success in the new route");
});

test('project rule and role writes stay blocked while a new route is resolving', async () => {
  const writes = [];
  const ui = harness(async (action, payload) => {
    if (action === 'hub:getContext') return new Promise(() => {});
    if (/^(agentsMd:(save|injectSoftRoute|syncProjectReference)|subagents:(update|delete))$/.test(action)) writes.push({ action, payload });
    return { ok: true, items: [] };
  });
  ui.ready(); ui.state.open = true; ui.state.connected = true; ui.state.projectRoot = '/tmp/project-a'; ui.state.threadId = 'thread-a';
  ui.state.context = { projectRoot: '/tmp/project-a', threadId: 'thread-a' }; ui.setCurrentRoute();
  ui.state.agentsTarget = 'project'; ui.state.agentDrafts['project:/tmp/project-a'] = { content: 'edit', saved: 'old', syncedTargets: [] };
  ui.state.subagentScope = 'project';
  const item = { id: 'explorer', model: 'model-a', providerInstanceId: 'codex', effort: 'high', role: 'research' };
  ui.cache.subagents = { globalItems: [item], projectItems: [item] };
  ui.sandbox.location.href = 'https://fixture.test/threads/thread-b'; ui.sandbox.location.pathname = '/threads/thread-b'; ui.state.tab = 'agents';
  ui.checkRoute();
  for (const action of ['save-agents', 'inject-soft-route', 'sync-project-rule-reference', 'save-subagent', 'clone-subagent', 'confirm-delete-subagent']) clickSettingsAction(ui, { action, id: 'explorer' });
  await new Promise(setImmediate);
  assert.deepEqual(writes, []);
});

test('late project rule save does not mark a stale draft saved or alter another project', async () => {
  let release; const writes = [];
  const ui = harness(async (action, payload) => {
    if (action === 'agentsMd:save') { writes.push(payload); return new Promise(resolve => { release = resolve; }); }
    if (action === 'hub:getContext') return new Promise(() => {});
    return { ok: true, projectContent: 'saved', items: [] };
  });
  ui.ready(); ui.state.open = true; ui.state.connected = true; ui.state.tab = 'agents'; ui.state.projectRoot = '/tmp/project-a'; ui.state.threadId = 'thread-a';
  ui.state.context = { projectRoot: '/tmp/project-a', threadId: 'thread-a' }; ui.setCurrentRoute(); ui.state.agentsTarget = 'project';
  const draft = { content: 'new-a', saved: 'old-a', syncedTargets: [] }; ui.state.agentDrafts['project:/tmp/project-a'] = draft;
  clickSettingsAction(ui, { action: 'save-agents' }); await new Promise(setImmediate);
  assert.equal(writes.length, 1); assert.equal(writes[0].expectedContent, 'old-a');
  ui.sandbox.location.href = 'https://fixture.test/threads/thread-b'; ui.sandbox.location.pathname = '/threads/thread-b'; ui.checkRoute();
  ui.state.projectRoot = '/tmp/project-b'; ui.state.agentDrafts['project:/tmp/project-b'] = { content: 'b', saved: 'b', syncedTargets: [] };
  release({ ok: true, sourceSaved: true }); await new Promise(setImmediate);
  assert.equal(draft.saved, 'old-a'); assert.equal(ui.state.agentDrafts['project:/tmp/project-b'].content, 'b');
});

test('global rule saves remain available while the project route is resolving', async () => {
  const writes=[];
  const ui=harness(async (action,payload)=>{
    if(action==='hub:getContext') return new Promise(()=>{});
    if(action==='agentsMd:save'){writes.push(payload);return {ok:true,sourceSaved:true,syncedTargets:[]};}
    if(action==='agentsMd:get') return {ok:true,globalContent:'new global',projectContent:''};
    return {ok:true,items:[]};
  });
  ui.ready();ui.state.open=true;ui.state.connected=true;ui.state.tab='agents';ui.state.projectRoot='/tmp/a';ui.state.threadId='thread-a';ui.state.context={projectRoot:'/tmp/a',threadId:'thread-a'};ui.setCurrentRoute();
  ui.state.agentsTarget='global';ui.state.agentDrafts.global={content:'new global',saved:'old global',syncedTargets:[]};
  ui.sandbox.location.href='https://fixture.test/threads/thread-b';ui.sandbox.location.pathname='/threads/thread-b';ui.checkRoute();
  clickSettingsAction(ui,{action:'save-agents'});await new Promise(setImmediate);
  assert.equal(writes.length,1);assert.equal(writes[0].target,'global');assert.equal(writes[0].expectedContent,'old global');assert.equal(ui.state.agentDrafts.global.saved,'new global');
});

test('stale host rule editor refuses to overwrite a newly injected role block', async (t) => {
  const f=fixture(t),ui=harness(f.rpc),file=path.join(f.homeDir,'.codex/AGENTS.md');fs.writeFileSync(file,'# old host rules\n');await ui.loadSettings();
  const before=fs.readFileSync(file,'utf8');
  const block='<!-- t3-hub-subagents:start -->\nnew routing\n<!-- t3-hub-subagents:end -->\n';fs.appendFileSync(file,block);
  ui.state.settingsRule='# stale editor text\n';ui.state.settingsRuleDirty=true;await ui.saveNativeSettings(undefined,true);
  assert.equal(fs.readFileSync(file,'utf8'),before+block);assert.equal(ui.state.settingsRuleDirty,true);
  assert.match(ui.nodes.get('.hub-toast').innerHTML,/变更|重新读取/);
});












for (const change of ["thread", "environment", "project"]) test(`Round-3 #1 scope switch clears the whole project context synchronously (${change})`, async () => {
  const calls = [];
  let finishContext;
  const ui = harness(async (action, payload) => {
    calls.push({ action, payload });
    if (action === "hub:getContext") return new Promise(resolve => { finishContext = resolve; });
    return { threadId: payload.threadId, steps: [] };
  });
  ui.ready();
  Object.assign(ui.state, { connected: true, threadId: "thread-a", projectRoot: "/project-a", context: { environmentId: "env-a", threadId: "thread-a", projectRoot: "/project-a" } });
  for (const key of ["skills", "mcp", "hooks", "subagents", "agents", "board"]) ui.cache[key] = { private: "project-a" };
  ui.setCurrentRoute();
  if (change === "thread") Object.assign(ui.sandbox.location, { pathname: "/threads/thread-b", href: "https://fixture.test/threads/thread-b" });
  else ui.sandbox.location.search = change === "environment" ? "?environmentId=env-b" : "?projectRoot=%2Fproject-b";
  ui.checkRoute();
  assert.equal(ui.isContextLoading(), true);
  assert.equal(ui.state.connected, false);
  assert.equal(ui.state.context, null);
  assert.equal(ui.state.projectRoot, null, "the previous root must disappear before getContext settles");
  assert.equal(ui.state.contextError, "");
  assert.equal(ui.projectContextReady(), false);
  for (const key of ["skills", "mcp", "hooks", "subagents", "agents", "board"]) assert.equal(ui.cache[key], null);
  assert.deepEqual(calls.map(call => call.action), ["hub:getContext"]);
  finishContext({ environmentId: "env-b", threadId: change === "thread" ? "thread-b" : "thread-a", projectRoot: "/project-b" });
  await new Promise(setImmediate);
  assert.equal(ui.state.projectRoot, "/project-b");
  assert.equal(ui.projectContextReady(), true);
});

function round3McpModeButton(scope = "project") {
  const button = node(), controls = node();
  button.dataset.name = "fixture-server";
  controls.querySelector = selector => ({ value: selector === '[name="mcp-mode-scope"]' ? scope : "direct" });
  button.closest = () => controls;
  return button;
}


for (const scope of ["project", "global"]) test(`Round-3 #1 verified project writes and independent global writes remain available (${scope})`, async () => {
  const calls = [], ui = harness(async (action, payload) => {
    calls.push({ action, payload });
    if (action === "mcp:list") return { items: [{ name: "fixture-server", mode: `${scope}-direct`, modeScope: scope }] };
    return { item: { id: "fixture-skill", scope } };
  });
  ui.ready();
  Object.assign(ui.state, { connected: scope === "project", threadId: "thread-a", projectRoot: scope === "project" ? "/verified-project" : null, context: scope === "project" ? { threadId: "thread-a", projectRoot: "/verified-project" } : null, importRepo: "owner/fixture", importScope: scope });
  ui.setCurrentRoute();
  await ui.runImport();
  await ui.setSkillScope("fixture-skill", scope);
  await ui.saveMcpMode(round3McpModeButton(scope));
  const writes = calls.filter(call => ["skills:importGitHub", "skills:setScope", "mcp:setMode"].includes(call.action));
  assert.equal(writes.length, 3);
  if (scope === "project") for (const call of writes) assert.equal(call.payload.projectRoot, "/verified-project");
});


test("removed background catalog loader is not exposed", () => {
  const ui = harness();
  assert.equal(ui.primeCatalogs, undefined);
});

for (const action of ["import", "set-scope"]) test(`Round-3 #1 late skill ${action} replies cannot change a new route's form or cache`, async () => {
  let finish;
  const ui = harness(async () => new Promise(resolve => { finish = resolve; }));
  ui.ready();
  Object.assign(ui.state, { connected: true, threadId: "thread-a", projectRoot: "/same-root", context: { threadId: "thread-a", projectRoot: "/same-root" }, importRepo: "owner/old", importScope: "project" });
  ui.setCurrentRoute();
  const pending = action === "import" ? ui.runImport() : ui.setSkillScope("fixture-skill", "project");
  ui.sandbox.location.search = "?environmentId=another-environment";
  ui.state.importRepo = "owner/new";
  ui.cache.skills = { items: [{ id: "fixture-skill", scope: "off" }] };
  finish({ item: { scope: "project" } }); await pending;
  assert.equal(ui.state.importRepo, "owner/new");
  assert.equal(ui.cache.skills.items[0].scope, "off");
  assert.equal(ui.root.querySelector(".hub-toast").innerHTML, "");
});

const round3PromotedKeys = [
  { name: "thread key with explicit environment", props: { environmentId: "remote:west", activeThreadKey: "thread:one" }, environmentId: "remote:west", threadId: "thread:one" },
  { name: "thread key with nested environment", props: { thread: { environmentId: "remote:west" }, activeThreadKey: "thread:one" }, environmentId: "remote:west", threadId: "thread:one" },
  { name: "thread key with path environment", pathEnv: "remote:west", props: { activeThreadKey: "thread:one" }, environmentId: "remote:west", threadId: "thread:one" },
  { name: "colon key with colon environment", props: { environmentId: "remote:west", activeThreadKey: "remote:west:thread:one" }, environmentId: "remote:west", threadId: "thread:one" },
  { name: "slash key with colon environment", props: { environmentId: "remote:west", activeThreadKey: "remote:west/thread:one" }, environmentId: "remote:west", threadId: "thread:one" },
  { name: "colon key with path environment", pathEnv: "remote:west", props: { activeThreadKey: "remote:west:thread:one" }, environmentId: "remote:west", threadId: "thread:one" },
  { name: "slash key without explicit environment", props: { activeThreadKey: "remote:west/thread:one" }, environmentId: "remote:west", threadId: "thread:one" },
  { name: "legacy colon separator", props: { activeThreadKey: "remote:thread:one" }, environmentId: "remote", threadId: "thread:one" },
  { name: "bare thread with explicit environment", props: { environmentId: "remote:west", activeThreadKey: "one" }, environmentId: "remote:west", threadId: "one" },
  { name: "thread without environment", props: { activeThreadKey: "thread:one" }, environmentId: "", threadId: "thread:one" },
  { name: "threads environment", props: { environmentId: "threads", activeThreadKey: "thread:one" }, environmentId: "threads", threadId: "thread:one" },
  { name: "chat environment", props: { environmentId: "_chat", activeThreadKey: "_chat:thread:one" }, environmentId: "_chat", threadId: "thread:one" },
  { name: "literal percent and slash", props: { environmentId: "remote:west/1", activeThreadKey: "remote:west/1:thread:one/7%3A" }, environmentId: "remote:west/1", threadId: "thread:one/7%3A" },
];

for (const entry of round3PromotedKeys) test(`Round-3 #2 #3 #5 promoted key preserves identity and uses the canonical RPC route (${entry.name})`, async () => {
  const calls = [], draftId = "round-3-draft", { environmentId, threadId } = entry;
  const props = { draftId, isServerThread: true, ...entry.props };
  const raw = `${entry.pathEnv ? `/_t3_env_/${encodeURIComponent(entry.pathEnv)}` : ""}/draft/${draftId}`;
  const canonical = `${environmentId ? `/_t3_env_/${encodeURIComponent(environmentId)}` : ""}/${encodeURIComponent(threadId)}`;
  const ui = harness(async (action, payload) => {
    calls.push({ action, payload });
    return action === "hub:getContext" ? { environmentId, threadId, projectRoot: "/promoted-project" } : { threadId, steps: [] };
  }, { location: { pathname: "/", hash: `#${raw}`, href: `t3code://app/#${raw}` }, document: { getElementById: () => ({ __reactFiber$fixture: { memoizedProps: props } }) } });
  ui.state.context = { environmentId: "stale-environment", threadId: "stale-thread", projectRoot: "/stale-project" };
  assert.equal(ui.routeHint(), canonical);
  assert.equal(ui.currentThreadId(), threadId);
  await ui.refreshContext();
  const contextCall = calls.find(call => call.action === "hub:getContext");
  assert.equal(contextCall.payload.routeHint, canonical);
  assert.equal(contextCall.payload.threadHint, `t3code://app/#${canonical}`);
  assert.equal(ui.state.threadId, threadId);
  assert.equal(ui.boardMismatch(), false);
  assert.equal(ui.projectContextReady(), true);
  if (environmentId) { ui.state.context.environmentId = "another-environment"; assert.equal(ui.boardMismatch(), true); }
});

for (const prefix of ["/_t3_env_/", "_t3_env_/"]) for (const environmentId of ["remote:west", "threads", "_chat"]) test(`Round-3 #3 #10 currentThreadId decodes explicit environment routes before wrapper matching (${prefix}${environmentId})`, () => {
  const threadId = "thread:one/7%3A", route = `${prefix}${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
  const ui = harness(undefined, { location: { pathname: "/", hash: `#${route}` } });
  ui.ready();
  Object.assign(ui.state, { connected: true, threadId, projectRoot: "/fixture", context: { environmentId, threadId, projectRoot: "/fixture" } });
  ui.setCurrentRoute();
  assert.equal(ui.currentThreadId(), threadId);
  assert.equal(ui.boardMismatch(), false);
  assert.equal(ui.projectContextReady(), true);
});

for (const route of ["/_t3_env_/%E0%A4%A/thread-a", "/_t3_env_/threads/%E0%A4%A", "/_t3_env_/remote%3Awest/%ZZ", "/_t3_env_//thread-a", "/_t3_env_/remote%3Awest//thread-a", "/_t3_env_/remote%3Awest/thread-a//", "/_t3_env_/remote%3Awest/", "/_t3_env_/"]) test(`Round-3 #3 #10 malformed explicit routes fail closed (${route})`, async () => {
  const calls = [], ui = harness(async action => { calls.push(action); return {}; }, { location: { pathname: "/", hash: `#${route}` } });
  ui.ready();
  Object.assign(ui.state, { connected: true, threadId: "thread-a", projectRoot: "/fixture", context: { environmentId: "remote:west", threadId: "thread-a", projectRoot: "/fixture" } });
  ui.setCurrentRoute();
  assert.equal(ui.currentThreadId(), "__ROUTE_invalid__");
  assert.equal(ui.boardMismatch(), true);
  assert.equal(ui.projectContextReady(), false);
  await ui.pollBoard(); await ui.setSkillScope("fixture-skill", "project");
  assert.equal(calls.length, 0);
});

test("Round-3 #10 explicit wrapper-named environments decode once; query URLs do not create empty path segments", () => {
  const ui = harness(undefined, { location: { pathname: "/", hash: "#/_t3_env_/%74hreads/thread-a?return=https://fixture.test//next" } });
  ui.ready();
  Object.assign(ui.state, { connected: true, threadId: "thread-a", projectRoot: "/fixture", context: { environmentId: "threads", threadId: "thread-a", projectRoot: "/fixture" } });
  ui.setCurrentRoute();
  assert.equal(ui.currentThreadId(), "thread-a");
  assert.equal(ui.boardMismatch(), false);
  assert.equal(ui.projectContextReady(), true);
});

for (const prefix of ["", "_t3_env_/"]) for (const wrapper of ["projects", "project", "workspaces", "workspace"]) for (const action of ["draft", "new"]) test(`Round-3 #11 verified project draft remains usable with scoped routing (${prefix}${wrapper}/${action})`, async () => {
  const projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", route = `/${prefix}${wrapper}/${projectId}/${action}/new-a`, calls = [];
  const ui = harness(async (rpc, payload) => { calls.push({ rpc, payload }); return { threadId: "__NEW__", steps: [] }; }, { location: { pathname: "/", hash: `#${route}`, href: `t3code://app/#${route}` } });
  ui.ready();
  Object.assign(ui.state, { connected: true, threadId: "__NEW__", projectRoot: "/verified-draft", context: { threadId: "__NEW__", projectId, projectRoot: "/verified-draft", draftProjectVerified: true } });
  ui.setCurrentRoute();
  assert.equal(ui.currentThreadId(), "__NEW__");
  assert.equal(ui.boardMismatch(), false);
  assert.equal(ui.projectContextReady(), true);
  const workspace = wrapper.startsWith("workspace"), parts = ui.parseScopeParts();
  assert.equal(workspace ? parts.pWs : parts.pProj, projectId);
  assert.equal(await ui.pollBoard(), true);
  assert.equal(calls[0].payload.projectRoot, "/verified-draft");
  assert.equal(calls[0].payload.threadId, "__NEW__");
  assert.equal(calls[0].payload.strictThreadMatch, true);
  const before = ui.routeScope().current;
  ui.sandbox.location.hash = `#${route}?${workspace ? "workspaceId" : "projectId"}=${projectId}`;
  assert.equal(ui.routeScope().current, before, "redundant scope queries do not invalidate a verified draft");
  ui.state.context.draftProjectVerified = false;
  assert.equal(ui.boardMismatch(), true);
  ui.state.context.draftProjectVerified = true; ui.state.context.projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  assert.equal(ui.boardMismatch(), true, "another project's verified draft is never accepted");
});

for (const operation of ["create", "save", "delete", "promote", "consolidate", "rollback", "pin"]) test(`Round-3 #1 current-project memory ${operation} cannot use a root from an unprocessed route`, async () => {
  const calls = [], ui = harness(async (action, payload) => { calls.push({ action, payload }); return { item: { id: "memory-a" }, items: [] }; });
  ui.ready();
  Object.assign(ui.state, { connected: true, threadId: "thread-a", projectRoot: "/project-a", context: { threadId: "thread-a", projectRoot: "/project-a" }, memoryProject: "current", tab: "board" });
  ui.cache.memory = { items: [{ id: "memory-a", title: "Memory", content: "Project A memory", scope: "project" }] };
  ui.snapshot().drafts.__new = { title: "New memory", content: "New project memory", scope: "project" };
  ui.setCurrentRoute();
  ui.sandbox.location.search = "?projectRoot=%2Fproject-b";
  assert.equal(ui.projectContextReady(), false);
  if (operation === "create") await ui.saveMemory(null);
  if (operation === "save") await ui.saveMemory("memory-a");
  if (operation === "delete") await ui.deleteMemory("memory-a");
  if (operation === "promote") await ui.promoteMemory("memory-a");
  if (operation === "consolidate") await ui.consolidateMemory();
  if (operation === "rollback") await ui.rollbackMemory("memory-a", 1, "revision-a");
  if (operation === "pin") { clickSettingsAction(ui, { action: "pin-memory", id: "memory-a" }); await new Promise(setImmediate); }
  assert.equal(calls.length, 0);
  assert.match(ui.root.querySelector(".hub-toast").innerHTML, /当前项目/);
});

test("current project writes always carry the confirmed root and never a global scope", async () => {
  const calls = [], ui = harness(async (action, payload) => { calls.push({ action, payload }); return { item: { id: "memory-a" }, items: [] }; });
  confirmMemoryProject(ui, "/project-a");
  ui.state.tab = "board";
  ui.cache.memory = { items: [{ id: "memory-a", title: "Memory", content: "Project memory", scope: "project" }] };
  await ui.saveMemory("memory-a");
  const write = calls.find(call => call.action === "memory:save");
  assert.ok(write);
  assert.equal(write.payload.projectRoot, "/project-a");
  assert.equal(write.payload.scope, "project");
  assert.equal("projectSlug" in write.payload, false);
  assert.equal(write.payload.projectRoot === null, false);
});

test("restored global memory draft is rebound to the confirmed current project before saving", async () => {
  const calls = [];
  const ui = harness(async (action, payload) => { calls.push({ action, payload }); return action === "memory:save" ? { item: { id: "saved-current" } } : { items: [], total: 0 }; }, {
    window: { __t3SidecarHub: { snapshot: () => ({ scope: "global", memoryProject: "global", memoryScope: "global", drafts: { __new: { open: true, scope: "global", title: "Migrated note", content: "Saved only in the confirmed project" } } }) } },
  });
  confirmMemoryProject(ui, "/project-current");
  ui.renderMemory();
  const form = ui.nodes.get("#t3-hub-new-memory").innerHTML;
  assert.match(form, /本项目共享/);
  assert.doesNotMatch(form, /全局通用|Global/);
  await ui.saveMemory(null);
  const write = calls.find(call => call.action === "memory:save");
  assert.ok(write);
  assert.equal(write.payload.projectRoot, "/project-current");
  assert.equal(write.payload.scope, "project");
  assert.equal("projectSlug" in write.payload, false);
});

test("provider setup prompt routes by detected host, binds custom Claude config dirs, and warns on Magpie/conflict", async () => {
  const copied = [];
  const ui = harness(undefined, { window: { navigator: { clipboard: { writeText: async (value) => copied.push(value) } } } });
  ui.cache.agentAccess = {
    enabled: true,
    setupSummary: {
      configured: 0, missing: 1, conflict: 1, unsupported: 0, unknown: 0, pending: 1, runtime: "unverified",
      providers: [
        { instanceId: "personal", displayName: "Personal", host: "claude", customConfigDir: false, status: "missing", reason: "entry_missing" },
        { instanceId: "work", displayName: "Work", host: "claude", customConfigDir: true, status: "pending", reason: "claude_home_not_ready" },
        { instanceId: "magpieClaude", displayName: '<img src=x onerror=alert(1)>', host: "claude", customConfigDir: true, status: "pending", reason: "managed_by_magpie" },
        { instanceId: "conflictClaude", displayName: "Conflict Claude", host: "claude", customConfigDir: false, status: "conflict", reason: "hub_entry_custom_options" },
      ],
    },
  };
  ui.renderMemoryAgentAccess();
  const html = ui.nodes.get("#t3-hub-memory-access").innerHTML;
  assert.match(html, /data-provider-id="personal"[^>]*data-provider-host="claude"[^>]*data-provider-custom-dir="false"/);
  assert.match(html, /data-provider-id="work"[^>]*data-provider-host="claude"[^>]*data-provider-custom-dir="true"/);
  assert.match(html, /Claude 配置目录尚未就绪/);
  assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/);

  // 1. Custom instanceId "personal" with host:"claude" gets Claude-specific prompt
  await ui.copyProviderMemorySetupPrompt("personal", "Personal");
  assert.match(copied.at(-1), /claude mcp add -s user/);
  assert.match(copied.at(-1), /~\/\.claude\.json/);
  assert.doesNotMatch(copied.at(-1), /\/Users\//);

  // 2. Custom config dir Claude instance must not offer bare `claude mcp add -s user` as a direct command
  await ui.copyProviderMemorySetupPrompt("work", "Work");
  assert.match(copied.at(-1), /CLAUDE_CONFIG_DIR=/);
  assert.match(copied.at(-1), /请勿在默认终端直接运行不带目录绑定的/);
  assert.doesNotMatch(copied.at(-1), /^\s*`claude mcp add -s user/m);

  // 3. Magpie-managed & conflict states explicitly warn to preserve existing entries
  await ui.copyProviderMemorySetupPrompt("magpieClaude", "Magpie Claude");
  assert.match(copied.at(-1), /Magpie/);
  assert.match(copied.at(-1), /保留原有 Magpie/);

  await ui.copyProviderMemorySetupPrompt("conflictClaude", "Conflict Claude");
  assert.match(copied.at(-1), /冲突/);
  assert.match(copied.at(-1), /保留原条目/);
});

test("selected_provider_disabled hides setup prompt button and never emits claude mcp add or ~/.claude.json steps", async () => {
  const copied = [];
  const ui = harness(undefined, { window: { navigator: { clipboard: { writeText: async (value) => copied.push(value) } } } });
  ui.cache.agentAccess = {
    enabled: true,
    setupSummary: {
      configured: 0, missing: 1, conflict: 0, unsupported: 0, unknown: 1, pending: 0, runtime: "unverified",
      providers: [
        { instanceId: "personal", displayName: "Personal", host: "claude", customConfigDir: false, status: "unknown", reason: "selected_provider_disabled" },
        { instanceId: "work", displayName: "Work", host: "claude", customConfigDir: false, status: "missing", reason: "entry_missing" },
      ],
    },
  };
  ui.renderMemoryAgentAccess();
  const zhHtml = ui.nodes.get("#t3-hub-memory-access").innerHTML;
  assert.match(zhHtml, /该实例已在 T3 设置中禁用，未执行自动接入/);
  assert.doesNotMatch(zhHtml, /data-action="copy-provider-memory-prompt"[^>]*data-provider-id="personal"/);
  assert.match(zhHtml, /data-action="copy-provider-memory-prompt"[^>]*data-provider-id="work"/);

  // Direct call to providerMemorySetupPrompt and copyProviderMemorySetupPrompt returns status-only guidance
  const directZh = ui.providerMemorySetupPrompt("personal", "Personal", { host: "claude", status: "unknown", reason: "selected_provider_disabled", customConfigDir: false });
  assert.match(directZh, /已在 T3 设置中禁用/);
  assert.match(directZh, /启用/);
  assert.doesNotMatch(directZh, /claude mcp add|~\/\.claude\.json|\.claude\.json|mcpServers|t3-mcp-router/);

  await ui.copyProviderMemorySetupPrompt("personal", "Personal");
  assert.equal(copied.at(-1), directZh);

  // English localization also renders disabled issue text and status-only prompt without executable steps
  ui.state.lang = "en";
  ui.renderMemoryAgentAccess();
  const enHtml = ui.nodes.get("#t3-hub-memory-access").innerHTML;
  assert.match(enHtml, /Disabled in T3 settings; skipped/);
  assert.doesNotMatch(enHtml, /data-action="copy-provider-memory-prompt"[^>]*data-provider-id="personal"/);
  const directEn = ui.providerMemorySetupPrompt("personal", "Personal", { host: "claude", status: "unknown", reason: "selected_provider_disabled", customConfigDir: true });
  assert.match(directEn, /disabled in T3 settings/i);
  assert.doesNotMatch(directEn, /claude mcp add|~\/\.claude\.json|\.claude\.json|mcpServers|t3-mcp-router|CLAUDE_CONFIG_DIR/);
});

test("topbar update pill hides on current/error, shows available/recoverable/unsupported states, and sanitizes release URLs against XSS", async () => {
  const calls = [];
  const copied = [];
  let applyGate = null;
  const ui = harness(async (action, payload) => {
    calls.push({ action, payload });
    if (action === "hub:update:check") {
      return ui.__nextCheck;
    }
    if (action === "hub:update:apply") {
      if (applyGate) return applyGate.promise;
      return { ok: true, status: "updated", currentVersion: payload.expectedVersion };
    }
    if (action === "hub:update:config:get") {
      return { ok: true, autoHotUpdate: true, currentVersion: "1.1.0" };
    }
    if (action === "hub:update:config:set") {
      return { ok: true, autoHotUpdate: payload.autoHotUpdate };
    }
    return {};
  }, { window: { __t3HudReleaseVersion: "1.1.0", navigator: { clipboard: { writeText: async (v) => copied.push(v) } } } });

  // Hidden on idle and current
  ui.renderHudUpdatePill();
  assert.equal(ui.updateHandle.hidden, true);
  ui.__nextCheck = { ok: true, status: "current", currentVersion: "1.1.0" };
  await ui.checkHudUpdate({ background: true });
  assert.equal(ui.updateHandle.hidden, true);

  // Hidden on error
  ui.__nextCheck = { ok: false, code: "UPDATE_UNAVAILABLE" };
  await ui.checkHudUpdate({ background: true });
  assert.equal(ui.updateHandle.hidden, true);

  // Available shows ↑ v1.2.0 and clicking applies once while ignoring duplicate clicks
  ui.__nextCheck = {
    ok: true, status: "available", currentVersion: "1.1.0", availableVersion: "1.2.0",
    releaseUrl: "https://github.com/kingmaozi/t3-code-hud/releases/tag/v1.2.0",
  };
  await ui.checkHudUpdate({ background: false });
  assert.equal(ui.updateHandle.hidden, false);
  assert.equal(ui.updateHandle.classList.contains("is-available"), true);
  assert.match(ui.updateHandle.innerHTML, /↑ v1\.2\.0/);

  applyGate = Promise.withResolvers();
  const pendingApply = ui.handleHudUpdatePillClick();
  assert.equal(ui.updateHandle.getAttribute("aria-disabled"), "true");
  assert.match(ui.updateHandle.innerHTML, /hub-spinner/);
  assert.match(ui.updateHandle.innerHTML, /更新中\.\.\./);
  ui.handleHudUpdatePillClick(); // duplicate click ignored
  assert.equal(calls.filter(c => c.action === "hub:update:apply").length, 1);
  applyGate.resolve({ ok: true, status: "updated", currentVersion: "1.2.0" });
  applyGate = null;
  await pendingApply;
  assert.equal(ui.updateHandle.hidden, true);

  // Recoverable shows amber ↻ 恢复更新 and clicking triggers apply with expectedVersion
  ui.__nextCheck = { ok: true, status: "recoverable", currentVersion: "1.1.0", availableVersion: "1.1.0" };
  await ui.checkHudUpdate({ background: false });
  assert.equal(ui.updateHandle.hidden, false);
  assert.equal(ui.updateHandle.classList.contains("is-recoverable"), true);
  assert.match(ui.updateHandle.innerHTML, /↻ 恢复更新/);

  // Unsupported with malicious XSS releaseUrl opens settings General tab and blocks unsafe href
  for (const badUrl of [
    "javascript:alert(1)",
    "https://evil.example/kingmaozi/t3-code-hud/releases/tag/v2.0.0",
    'https://github.com/kingmaozi/t3-code-hud/releases/tag/v2.0.0" onclick="alert(1)',
    "data:text/html,<script>alert(1)</script>",
  ]) {
    assert.equal(ui.sanitizeHudReleaseUrl(badUrl), "");
  }
  assert.equal(
    ui.sanitizeHudReleaseUrl("https://github.com/kingmaozi/t3-code-hud/releases/tag/v2.0.0"),
    "https://github.com/kingmaozi/t3-code-hud/releases/tag/v2.0.0"
  );

  ui.__nextCheck = {
    ok: true, status: "unsupported", currentVersion: "1.1.0", availableVersion: "2.0.0",
    releaseUrl: "javascript:alert(1)",
  };
  await ui.checkHudUpdate({ background: false });
  assert.equal(ui.updateHandle.hidden, false);
  assert.equal(ui.updateHandle.classList.contains("is-manual"), true);
  assert.match(ui.updateHandle.innerHTML, /↑ v2\.0\.0/);

  ui.handleHudUpdatePillClick();
  assert.equal(ui.state.hubSettingsOpen, true);
  assert.equal(ui.state.hubSettingsTab, "general");
  const generalHtml = ui.nodes.get("#t3-hub-settings-general-pane").innerHTML;
  assert.match(generalHtml, /HUD 版本与热更新/);
  assert.match(generalHtml, /默认开启。仅在空闲（抽屉与设置均关闭、窗口可见）且新版本支持热更包时自动静默热加载，绝不重启 T3。/);
  assert.match(generalHtml, /git pull &amp;&amp; bash \.\/install\.sh/);
  assert.match(generalHtml, /href="https:\/\/github\.com\/kingmaozi\/t3-code-hud\/releases"/);
  assert.doesNotMatch(generalHtml, /javascript:/i);

  await ui.copyHudUpdateCommand();
  assert.equal(copied.at(-1), "git pull && bash ./install.sh");

  // Toggle autoHotUpdate persists via hub:update:config:set (opt-out false, then back to true)
  assert.equal(ui.state.autoHotUpdate, true);
  await ui.setAutoHotUpdate(false);
  assert.equal(ui.state.autoHotUpdate, false);
  assert.ok(calls.some(c => c.action === "hub:update:config:set" && c.payload.autoHotUpdate === false));
  await ui.setAutoHotUpdate(true);
  assert.equal(ui.state.autoHotUpdate, true);
  assert.ok(calls.some(c => c.action === "hub:update:config:set" && c.payload.autoHotUpdate === true));

  // External event from renderer updates topbar pill without RPC
  const beforeCalls = calls.length;
  ui.onExternalHudUpdateState({
    detail: { source: "renderer", busy: false, status: "available", availableVersion: "1.3.0", currentVersion: "1.1.0" },
  });
  assert.equal(calls.length, beforeCalls);
  assert.equal(ui.updateHandle.hidden, false);
  assert.match(ui.updateHandle.innerHTML, /↑ v1\.3\.0/);
});

test("autoHotUpdate defaults to true, loads disk config before auto-apply, fails closed on error, triggers only when idle, never retries same version after failure, and destroy clears timers", async () => {
  const scheduled = [];
  const cleared = [];
  let nextTimerId = 10;
  const calls = [];
  let configGetReply = { ok: true, autoHotUpdate: true, currentVersion: "1.1.0" };
  let configGetGate = null;
  const ui = harness(async (action, payload) => {
    calls.push({ action, payload });
    if (action === "hub:update:config:get") {
      if (configGetGate) await configGetGate.promise;
      return configGetReply;
    }
    if (action === "hub:update:check") {
      return { ok: true, status: "available", currentVersion: "1.1.0", availableVersion: "1.2.0" };
    }
    if (action === "hub:update:apply") {
      return { ok: false, code: "UPDATE_FAILED" };
    }
    return {};
  });
  ui.sandbox.setTimeout = (fn, delay) => {
    const id = nextTimerId++;
    scheduled.push({ id, fn, delay });
    return id;
  };
  ui.sandbox.clearTimeout = (id) => { cleared.push(id); };

  // 1. Default state is autoHotUpdate === true (unloaded until verified from disk)
  assert.equal(ui.state.autoHotUpdate, true);
  assert.equal(ui.state.autoHotUpdateLoaded, false);

  // 1a. If disk explicitly turned autoHotUpdate off, maybeTriggerAutoHotUpdate loads config first and sends 0 apply calls
  configGetReply = { ok: true, autoHotUpdate: false, currentVersion: "1.1.0" };
  await ui.checkHudUpdate({ background: true });
  await new Promise(setImmediate);
  assert.equal(ui.state.autoHotUpdateLoaded, true);
  assert.equal(ui.state.autoHotUpdate, false);
  assert.equal(calls.filter(c => c.action === "hub:update:config:get").length, 1);
  assert.equal(calls.filter(c => c.action === "hub:update:apply").length, 0);

  // 1b. If hub:update:config:get fails closed (ok: false, e.g. symlink/corrupt/non-boolean), state fails closed to false and sends 0 apply calls
  ui.state.autoHotUpdate = true;
  ui.state.autoHotUpdateLoaded = false;
  configGetReply = { ok: false, autoHotUpdate: false, currentVersion: "1.1.0", error: "autoHotUpdate must be boolean" };
  await ui.checkHudUpdate({ background: true });
  await new Promise(setImmediate);
  assert.equal(ui.state.autoHotUpdate, false);
  assert.equal(ui.state.autoHotUpdateLoaded, false);
  assert.equal(calls.filter(c => c.action === "hub:update:apply").length, 0);

  // 2. When drawer or settings is open or document is hidden, autoHotUpdate === true does not trigger
  configGetReply = { ok: true, autoHotUpdate: true, currentVersion: "1.1.0" };
  await ui.loadHudUpdateConfig();
  assert.equal(ui.state.autoHotUpdate, true);
  assert.equal(ui.state.autoHotUpdateLoaded, true);
  // Loading valid disk config while idle & available immediately triggers one auto-apply for v1.2.0
  const applyAfterLoad = calls.filter(c => c.action === "hub:update:apply").length;
  assert.equal(applyAfterLoad, 1);
  assert.equal(ui.state.autoAttemptedVersion, "1.2.0");

  // Reset attempted version to verify non-idle guards and idle auto-trigger with loaded config
  ui.state.autoAttemptedVersion = "";
  ui.state.open = true;
  await ui.checkHudUpdate({ background: true });
  await new Promise(setImmediate);
  assert.equal(calls.filter(c => c.action === "hub:update:apply").length, 1);

  ui.state.open = false;
  ui.state.hubSettingsOpen = true;
  await ui.checkHudUpdate({ background: true });
  await new Promise(setImmediate);
  assert.equal(calls.filter(c => c.action === "hub:update:apply").length, 1);

  ui.state.hubSettingsOpen = false;
  ui.sandbox.document.hidden = true;
  await ui.checkHudUpdate({ background: true });
  await new Promise(setImmediate);
  assert.equal(calls.filter(c => c.action === "hub:update:apply").length, 1);

  // 3. Re-entrancy guard: concurrent maybeTriggerAutoHotUpdate while config:get is pending sends only 1 config:get and 1 apply
  ui.sandbox.document.hidden = false;
  ui.state.autoHotUpdateLoaded = false;
  const configCallsBefore = calls.filter(c => c.action === "hub:update:config:get").length;
  const applyCallsBefore = calls.filter(c => c.action === "hub:update:apply").length;
  configGetGate = Promise.withResolvers();
  const p1 = ui.maybeTriggerAutoHotUpdate();
  const p2 = ui.maybeTriggerAutoHotUpdate();
  configGetGate.resolve();
  configGetGate = null;
  await Promise.all([p1, p2]);
  assert.equal(calls.filter(c => c.action === "hub:update:config:get").length, configCallsBefore + 1);
  const autoApplyCalls = calls.filter(c => c.action === "hub:update:apply");
  assert.equal(autoApplyCalls.length, applyCallsBefore + 1);
  assert.deepEqual(JSON.parse(JSON.stringify(autoApplyCalls.at(-1).payload)), { expectedVersion: "1.2.0", auto: true });
  assert.equal(ui.state.autoAttemptedVersion, "1.2.0");

  // 4. Same version is never auto-retried after a failed auto attempt
  await ui.checkHudUpdate({ background: true });
  await new Promise(setImmediate);
  assert.equal(calls.filter(c => c.action === "hub:update:apply").length, applyCallsBefore + 1);

  // 5. destroy() while config:get is pending prevents any post-dispose apply, and cancels scheduled timers
  ui.state.autoAttemptedVersion = "";
  ui.state.autoHotUpdateLoaded = false;
  configGetGate = Promise.withResolvers();
  const disposedPending = ui.maybeTriggerAutoHotUpdate();
  ui.scheduleHudUpdateCheck(true);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 15000);
  const timerId = scheduled[0].id;
  ui.destroy();
  configGetGate.resolve();
  configGetGate = null;
  await disposedPending;
  assert.equal(calls.filter(c => c.action === "hub:update:apply").length, applyCallsBefore + 1);
  assert.ok(cleared.includes(timerId));
  assert.equal(ui.timers.size, 0);
  const countBefore = calls.length;
  await scheduled[0].fn();
  assert.equal(calls.length, countBefore);
});

test("P1 #5 + P0 #1: structured background check cache restores pill on remount with zero extra checks, applies failure backoff, and keeps manual check immediate", async () => {
  const store = new Map();
  const sharedStorage = {
    getItem: (k) => store.has(k) ? store.get(k) : null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };

  // Mount #1: background check discovers available v1.2.0
  const calls1 = [];
  const ui1 = harness(async (action, payload) => {
    calls1.push({ action, payload });
    if (action === "hub:update:check") {
      return {
        ok: true, status: "available", currentVersion: "1.1.0", availableVersion: "1.2.0",
        releaseUrl: "https://github.com/kingmaozi/t3-code-hud/releases/tag/v1.2.0",
      };
    }
    return {};
  }, { window: { __t3HudReleaseVersion: "1.1.0" }, localStorage: sharedStorage });
  await ui1.checkHudUpdate({ background: true });
  assert.equal(calls1.filter(c => c.action === "hub:update:check").length, 1);
  assert.equal(ui1.updateHandle.hidden, false);
  ui1.destroy();

  // Mount #2: destroys & remounts with same localStorage -> pill immediately visible, 0 immediate checks, delay > 15s (6h window)
  const calls2 = [];
  const scheduled2 = [];
  const ui2 = harness(async (action, payload) => {
    calls2.push({ action, payload });
    if (action === "hub:update:apply") return { ok: false, code: "AUTO_UPDATE_DISABLED" };
    return {};
  }, { window: { __t3HudReleaseVersion: "1.1.0" }, localStorage: sharedStorage });
  ui2.sandbox.setTimeout = (fn, delay) => { scheduled2.push({ fn, delay }); return scheduled2.length; };
  ui2.scheduleHudUpdateCheck(true);
  assert.equal(ui2.updateHandle.hidden, false);
  assert.match(ui2.updateHandle.innerHTML, /↑ v1\.2\.0/);
  assert.equal(calls2.length, 0);
  assert.equal(scheduled2.length, 1);
  assert.ok(scheduled2[0].delay > 60 * 60 * 1000, "should defer next check for remaining 6h window");

  // Auto-apply rejected with AUTO_UPDATE_DISABLED turns local autoHotUpdate off while keeping pill visible
  ui2.state.autoHotUpdate = true;
  await ui2.applyHudUpdate("1.2.0", false, { silent: true, auto: true });
  assert.equal(ui2.state.autoHotUpdate, false);
  assert.equal(ui2.updateHandle.hidden, false);
  assert.match(ui2.updateHandle.innerHTML, /↑ v1\.2\.0/);
  ui2.destroy();

  // Mount #3: failed background check persists backoff -> remount does NOT schedule 15s retry; manual check still fires immediately
  store.clear();
  const ui3 = harness(async (action) => {
    if (action === "hub:update:check") return { ok: false, code: "UPDATE_UNAVAILABLE" };
    return {};
  }, { window: { __t3HudReleaseVersion: "1.1.0" }, localStorage: sharedStorage });
  await ui3.checkHudUpdate({ background: true });
  assert.equal(ui3.updateHandle.hidden, true);
  ui3.destroy();

  const calls4 = [];
  const scheduled4 = [];
  const ui4 = harness(async (action, payload) => {
    calls4.push({ action, payload });
    if (action === "hub:update:check") return { ok: true, status: "current", currentVersion: "1.1.0" };
    return {};
  }, { window: { __t3HudReleaseVersion: "1.1.0" }, localStorage: sharedStorage });
  ui4.sandbox.setTimeout = (fn, delay) => { scheduled4.push({ fn, delay }); return scheduled4.length; };
  ui4.scheduleHudUpdateCheck(true);
  assert.equal(scheduled4.length, 1);
  assert.ok(scheduled4[0].delay > 20 * 60 * 1000, "failed background check backs off (~30m) instead of 15s");
  assert.equal(calls4.length, 0);

  // Manual check bypasses backoff immediately
  await ui4.checkHudUpdate({ background: false });
  assert.equal(calls4.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls4[0])), { action: "hub:update:check", payload: { background: false } });
  ui4.destroy();
});

test("P1 #5a: steady mounted session backs off 30m after background failure, returns to 6h after success, and keeps manual check immediate", async () => {
  const store = new Map();
  const sharedStorage = {
    getItem: (k) => store.has(k) ? store.get(k) : null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const calls = [];
  const scheduled = [];
  let nextCheckResult = { ok: false, code: "UPDATE_UNAVAILABLE" };
  const ui = harness(async (action, payload) => {
    calls.push({ action, payload });
    if (action === "hub:update:check") return nextCheckResult;
    return {};
  }, { window: { __t3HudReleaseVersion: "1.1.0" }, localStorage: sharedStorage });
  ui.sandbox.setTimeout = (fn, delay) => {
    scheduled.push({ fn, delay });
    return scheduled.length;
  };

  // Initial mount schedules 15s check
  ui.scheduleHudUpdateCheck(true);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 15_000);

  // First background check returns UPDATE_UNAVAILABLE -> next timer uses 30m backoff (1_800_000 ms)
  scheduled[0].fn();
  await new Promise(setImmediate);
  assert.equal(calls.length, 1);
  assert.equal(ui.state.hudUpdateStatus, "error");
  assert.equal(scheduled.length, 2);
  assert.equal(scheduled[1].delay, 1_800_000);

  // Manual check still runs immediately while backoff timer is pending
  nextCheckResult = { ok: true, status: "current", currentVersion: "1.1.0" };
  await ui.checkHudUpdate({ background: false });
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1])), { action: "hub:update:check", payload: { background: false } });

  // Next scheduled background check succeeds -> restores 6h interval (21_600_000 ms)
  scheduled[1].fn();
  await new Promise(setImmediate);
  assert.equal(calls.length, 3);
  assert.equal(ui.state.hudUpdateStatus, "current");
  assert.equal(scheduled.length, 3);
  assert.equal(scheduled[2].delay, 21_600_000);

  // When document.hidden is true, check is skipped and reasonable 6h interval is preserved
  ui.sandbox.document.hidden = true;
  scheduled[2].fn();
  await new Promise(setImmediate);
  assert.equal(calls.length, 3);
  assert.equal(scheduled.length, 4);
  assert.equal(scheduled[3].delay, 21_600_000);

  ui.destroy();
});

test("P1 #5b: external recovered/updated broadcast clears persisted recoverable cache and prevents stale recovery pill on remount", async () => {
  const store = new Map();
  const sharedStorage = {
    getItem: (k) => store.has(k) ? store.get(k) : null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const cacheKey = "t3-hub-update-bg-check-v1";
  store.set(cacheKey, JSON.stringify({
    checkedAt: Date.now(),
    installedVersion: "1.1.0",
    ok: true,
    status: "recoverable",
    availableVersion: "1.1.0",
    releaseUrl: "",
  }));

  // Mount #1 restores recoverable pill from cache
  const ui1 = harness(async () => ({}), { window: { __t3HudReleaseVersion: "1.1.0" }, localStorage: sharedStorage });
  ui1.renderHudUpdatePill();
  ui1.restoreHudUpdateCache();
  assert.equal(ui1.updateHandle.hidden, false);
  assert.equal(ui1.updateHandle.classList.contains("is-recoverable"), true);

  // Renderer stats panel broadcasts recovered -> clears localStorage cache and hides pill
  ui1.onExternalHudUpdateState({
    detail: {
      source: "renderer",
      status: "recovered",
      busy: false,
      busyKind: "",
      currentVersion: "1.1.0",
      availableVersion: "1.1.0",
    },
  });
  assert.equal(store.has(cacheKey), false);
  assert.equal(ui1.readHudUpdateCache(), null);
  assert.equal(ui1.state.hudUpdateAvailableVersion, "");
  assert.equal(ui1.state.hudUpdateReleaseUrl, "");
  assert.equal(ui1.updateHandle.hidden, true);
  ui1.destroy();

  // Mount #2 remounts drawer (initial pill starts hidden as in DOM) -> recovery pill must not reappear
  const ui2 = harness(async () => ({}), { window: { __t3HudReleaseVersion: "1.1.0" }, localStorage: sharedStorage });
  ui2.renderHudUpdatePill();
  ui2.scheduleHudUpdateCheck(true);
  assert.equal(ui2.state.hudUpdateStatus, "idle");
  assert.equal(ui2.updateHandle.hidden, true);
  assert.equal(ui2.updateHandle.classList.contains("is-recoverable"), false);

  // External available status refreshes persisted cache for remount, then updated clears it
  ui2.onExternalHudUpdateState({
    detail: {
      source: "renderer",
      status: "available",
      busy: false,
      currentVersion: "1.1.0",
      availableVersion: "1.2.0",
      releaseUrl: "https://github.com/kingmaozi/t3-code-hud/releases/tag/v1.2.0",
    },
  });
  assert.equal(store.has(cacheKey), true);
  const synced = ui2.readHudUpdateCache();
  assert.equal(synced?.status, "available");
  assert.equal(synced?.availableVersion, "1.2.0");

  ui2.onExternalHudUpdateState({
    detail: {
      source: "renderer",
      status: "updated",
      busy: false,
      currentVersion: "1.2.0",
      availableVersion: "1.2.0",
    },
  });
  assert.equal(store.has(cacheKey), false);
  assert.equal(ui2.state.hudUpdateAvailableVersion, "");
  assert.equal(ui2.state.hudUpdateReleaseUrl, "");
  ui2.destroy();
});

test("reload-before-RPC-return still emits confirmed recovered/updated completion to new drawer and clears cache", async () => {
  const rendererSrc = fs.readFileSync(path.join(__dirname, "../src/renderer-ui.js"), "utf8");
  const sliceBetween = (start, end) => {
    const a = rendererSrc.indexOf(start);
    const b = rendererSrc.indexOf(end, a);
    assert.ok(a >= 0 && b > a, `missing renderer slice: ${start}`);
    return rendererSrc.slice(a, b);
  };
  const cacheKey = "t3-hub-update-bg-check-v1";
  const store = new Map();
  const sharedStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const listeners = new Map();
  const sharedWindow = {
    __t3HubDrawerEmbedded: true,
    __t3HudReleaseVersion: "1.1.0",
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatchEvent(evt) {
      for (const fn of [...(listeners.get(evt.type) || [])]) fn(evt);
    },
  };
  const mountDrawer = (rpc) => {
    const ui = harness(rpc, {
      window: { ...sharedWindow, __t3HubRpc: undefined },
      document: { addEventListener() {}, removeEventListener() {} },
      localStorage: sharedStorage,
      CustomEvent: TestCustomEvent,
    });
    sharedWindow.addEventListener("t3-hud-update-state", ui.onExternalHudUpdateState);
    const origDestroy = ui.destroy;
    ui.destroy = () => {
      sharedWindow.removeEventListener("t3-hud-update-state", ui.onExternalHudUpdateState);
      origDestroy();
    };
    return ui;
  };
  class TestCustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  }

  // Case A: Stats panel initiates recovery, backend reloads UI (disposing old stats panel & drawer) before RPC resolves
  store.set(cacheKey, JSON.stringify({
    checkedAt: Date.now(),
    installedVersion: "1.1.0",
    ok: true,
    status: "recoverable",
    availableVersion: "1.1.0",
    releaseUrl: "",
  }));
  let resolveRecoveryRpc;
  sharedWindow.__t3HubRpc = (action) => {
    assert.equal(action, "hub:update:apply");
    return new Promise((resolve) => { resolveRecoveryRpc = resolve; });
  };
  const controls = {};
  const makeButton = (action) => ({
    hidden: action === "apply",
    attributes: {},
    closest: () => controls[action],
    getAttribute: () => action,
    setAttribute(name, value) { this.attributes[name] = value; },
    focus() {},
  });
  let domUpdatesAfterDispose = 0;
  const rendererDoc = { activeElement: null };
  const popover = {
    style: {},
    classList: { contains: (key) => key === "visible" },
    set innerHTML(value) {
      controls.check = value.includes('data-t3-hud-update="check"') ? makeButton("check") : null;
      controls.apply = value.includes('data-t3-hud-update="apply"') ? makeButton("apply") : null;
      controls.status = value.includes("data-t3-hud-update-status") ? {
        _text: "",
        get textContent() { return this._text; },
        set textContent(v) {
          if (rendererSandbox.disposed) domUpdatesAfterDispose += 1;
          this._text = v;
        },
      } : null;
      controls.releases = value.includes("data-t3-hud-update-release") ? { hidden: true } : null;
    },
    querySelector(selector) {
      switch (selector) {
        case '[data-t3-hud-update="check"]': return controls.check;
        case '[data-t3-hud-update="apply"]': return controls.apply;
        case "[data-t3-hud-update-status]": return controls.status;
        case "[data-t3-hud-update-release]": return controls.releases;
        default: return null;
      }
    },
  };
  const rendererSandbox = {
    document: rendererDoc,
    window: sharedWindow,
    popover,
    hudLang: "zh",
    latestStats: null,
    disposed: false,
    currentPopoverMode: "stats",
    hudUpdateState: { message: "hudUpdateInterrupted", availableVersion: "1.1.0", recoverable: true },
    CustomEvent: TestCustomEvent,
    langSwitchLabel: () => "EN",
    computeQuotaAndContext: () => ({ currentWindows: [], otherWindows: [] }),
  };
  vm.runInNewContext(
    sliceBetween("  function escapeHtml(", "  // Bilingual i18n") +
    sliceBetween("  const I18N = {", "  let hudLang = null;") +
    sliceBetween("  function t(key)", "  function detectLangFromDom(") +
    sliceBetween("  function syncHudUpdateFooter(", "  function showPopoverAbove("),
    rendererSandbox,
  );
  rendererSandbox.renderStatsPopover();
  const uiOld = mountDrawer(async () => ({}));
  uiOld.renderHudUpdatePill();
  uiOld.restoreHudUpdateCache();
  assert.equal(uiOld.updateHandle.hidden, false);

  // Start recovery click (RPC remains pending)
  const recoveryPromise = rendererSandbox.onHudUpdateClick({ target: controls.apply, stopPropagation() {} });
  // Simulate backend /admin/reload-ui: old stats panel & old drawer disposed, new drawer mounted while RPC still in-flight
  rendererSandbox.disposed = true;
  uiOld.destroy();
  const uiReloaded = mountDrawer(async () => ({}));
  uiReloaded.renderHudUpdatePill();
  uiReloaded.restoreHudUpdateCache();
  assert.equal(uiReloaded.updateHandle.hidden, false, "new drawer initially sees recoverable cache before RPC resolves");

  // RPC resolves with confirmed recovery after reload
  resolveRecoveryRpc({ ok: true, status: "current", currentVersion: "1.1.0" });
  await recoveryPromise;

  assert.equal(domUpdatesAfterDispose, 0, "disposed stats panel must not mutate its dead DOM");
  assert.equal(store.has(cacheKey), false, "confirmed recovered completion must clear persisted cache");
  assert.equal(uiReloaded.updateHandle.hidden, true, "currently mounted drawer must immediately hide recovery pill");
  assert.equal(uiReloaded.state.hudUpdateStatus, "recovered");
  uiReloaded.destroy();

  // Remounting again must not revive recovery prompt
  const uiAfterRemount = mountDrawer(async () => ({}));
  uiAfterRemount.renderHudUpdatePill();
  uiAfterRemount.scheduleHudUpdateCheck(true);
  assert.equal(uiAfterRemount.updateHandle.hidden, true);
  assert.equal(uiAfterRemount.state.hudUpdateStatus, "idle");
  uiAfterRemount.destroy();

  // Case B: Drawer pill initiates update, backend reloads (disposing old drawer) before RPC resolves
  store.set(cacheKey, JSON.stringify({
    checkedAt: Date.now(),
    installedVersion: "1.1.0",
    ok: true,
    status: "available",
    availableVersion: "1.2.0",
    releaseUrl: "",
  }));
  let resolveDrawerApply;
  const uiDrawer1 = mountDrawer(async (action) => {
    if (action === "hub:update:apply") {
      return await new Promise((resolve) => { resolveDrawerApply = resolve; });
    }
    return { ok: true };
  });
  uiDrawer1.renderHudUpdatePill();
  uiDrawer1.restoreHudUpdateCache();
  const applyPromise = uiDrawer1.applyHudUpdate("1.2.0", false);
  // Backend reloads UI before RPC returns
  uiDrawer1.destroy();
  sharedWindow.__t3HudReleaseVersion = "1.2.0";
  const uiDrawer2 = mountDrawer(async () => ({}));
  uiDrawer2.renderHudUpdatePill();
  resolveDrawerApply({ ok: true, status: "updated", currentVersion: "1.2.0" });
  await applyPromise;
  assert.equal(store.has(cacheKey), false, "disposed drawer confirmed update must clear cache");
  assert.equal(uiDrawer2.updateHandle.hidden, true);
  uiDrawer2.destroy();
});

test("v1.1.6 P1 #1 + NOTE: autoHotUpdateSaving blocks auto apply while disabling, and failed config reads clear switch state for retry", async () => {
  const calls = [];
  let resolveCheck;
  let resolveSave;
  const ui = harness(async (action, payload) => {
    calls.push({ action, payload });
    if (action === "hub:update:config:get") return { ok: true, autoHotUpdate: true, currentVersion: "1.1.5" };
    if (action === "hub:update:check") return await new Promise((resolve) => { resolveCheck = resolve; });
    if (action === "hub:update:config:set") return await new Promise((resolve) => { resolveSave = resolve; });
    if (action === "hub:update:apply") return { ok: true, status: "updated", currentVersion: payload.expectedVersion };
    return { ok: true };
  }, { window: { __t3HudReleaseVersion: "1.1.5" } });

  await ui.loadHudUpdateConfig({ triggerAuto: false });
  assert.equal(ui.state.autoHotUpdate, true);
  assert.equal(ui.state.autoHotUpdateLoaded, true);

  // Start background check (held pending), then user disables autoHotUpdate and closes settings before save finishes
  const checkPromise = ui.checkHudUpdate({ background: true });
  ui.state.hubSettingsOpen = true;
  const savePromise = ui.setAutoHotUpdate(false);
  assert.equal(ui.state.autoHotUpdateSaving, true);
  ui.state.hubSettingsOpen = false;

  // Background check completes while save is still in flight -> must NOT fire auto apply
  resolveCheck({ ok: true, status: "available", currentVersion: "1.1.5", availableVersion: "1.1.6" });
  await checkPromise;
  assert.equal(calls.filter((c) => c.action === "hub:update:apply").length, 0);
  assert.equal(ui.state.autoAttemptedVersion, "");

  // Save resolves with autoHotUpdate: false -> still 0 auto apply calls
  resolveSave({ ok: true, autoHotUpdate: false });
  await savePromise;
  assert.equal(ui.state.autoHotUpdateSaving, false);
  assert.equal(ui.state.autoHotUpdate, false);
  assert.equal(calls.filter((c) => c.action === "hub:update:apply").length, 0);
  ui.destroy();

  // NOTE: config read returning null, missing boolean, or throwing clears switch to false and keeps autoHotUpdateLoaded false for retry
  for (const mode of ["null", "missing-bool", "throw"]) {
    const uiErr = harness(async (action) => {
      if (action === "hub:update:config:get") {
        if (mode === "null") return null;
        if (mode === "missing-bool") return { ok: true, currentVersion: "1.1.5" };
        throw new Error("rpc offline");
      }
      return { ok: true };
    }, { window: { __t3HudReleaseVersion: "1.1.5" } });
    assert.equal(uiErr.state.autoHotUpdate, true);
    await uiErr.loadHudUpdateConfig({ triggerAuto: false });
    assert.equal(uiErr.state.autoHotUpdate, false, `mode=${mode} must clear switch to false`);
    assert.equal(uiErr.state.autoHotUpdateLoaded, false, `mode=${mode} must remain unloaded for retry`);
    uiErr.destroy();
  }
});

test("Connect projection parses t3_hub.plan_update with strict filtering, clear semantics, source label, and timestamp competition", async () => {
  const ui = harness();
  const env = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const threadId = "main-thread";
  const projectRoot = "/remote/workspace";

  // boardSourceLabel must identify plan_update sources as Hub plan, not T3 native
  ui.state.lang = "zh";
  assert.equal(ui.boardSourceLabel("t3-connect-plan-update"), "Hub 打卡");
  assert.equal(ui.boardSourceLabel("t3-mcp-plan-update"), "Hub 打卡");
  assert.equal(ui.boardSourceLabel("t3-connect"), "T3 原生");
  ui.state.lang = "en";
  assert.equal(ui.boardSourceLabel("t3-connect-plan-update"), "Hub plan");
  assert.equal(ui.boardSourceLabel("t3-connect"), "T3 native");

  // Strict filtering: subagent, wrong thread, failed/isError, unknown dynamic tool, wrong/invalid projectRoot are rejected
  const filteredProjection = {
    thread: { id: threadId },
    plans: [
      { id: "native-old", threadId, kind: "todo_list", status: "active", steps: [{ id: "n1", text: "Old native", status: "pending" }] },
    ],
    turnItems: [
      { threadId, type: "todo_list", planId: "native-old", updatedAt: "2026-11-28T08:00:00Z" },
      // Valid earlier plan_update (trailing slash on projectRoot must normalize and match)
      {
        threadId, type: "dynamic_tool", toolName: "t3_hub.plan_update", status: "completed",
        startedAt: "2026-11-28T09:00:00Z", ordinal: 1,
        toolSource: { kind: "integration", key: "mcp:t3_hub" },
        input: {
          projectRoot: "/remote/workspace/",
          steps: [
            { id: "s1".repeat(80), text: "Done step", status: "done" },
            { text: "Working <img src=x onerror=alert(1)>", status: "in_progress" },
            { text: "   ", status: "pending" },
            { text: "Bad status", status: 123 },
          ],
        },
      },
      // Rejected: subagent parentItemId
      {
        threadId, type: "mcp_tool_call", toolName: "mcp__t3_hub__plan_update", status: "completed",
        parentItemId: "sub-1", startedAt: "2026-11-28T10:00:00Z", ordinal: 2,
        input: { steps: [{ text: "Subagent leak", status: "pending" }] },
      },
      // Rejected: wrapper parent_item_id
      {
        parent_item_id: "sub-2",
        item: {
          threadId, type: "mcp_tool_call", toolName: "plan_update", status: "completed",
          startedAt: "2026-11-28T10:01:00Z", ordinal: 3,
          input: { steps: [{ text: "Wrapper subagent leak", status: "pending" }] },
        },
      },
      // Rejected: different threadId on item & args
      {
        threadId: "other-thread", type: "mcp_tool_call", toolName: "t3_hub.plan_update", status: "completed",
        startedAt: "2026-11-28T10:02:00Z", ordinal: 4,
        input: { steps: [{ text: "Wrong item thread", status: "pending" }] },
      },
      {
        threadId, type: "mcp_tool_call", toolName: "t3_hub.plan_update", status: "completed",
        startedAt: "2026-11-28T10:03:00Z", ordinal: 5,
        input: { threadId: "other-thread", steps: [{ text: "Wrong args thread", status: "pending" }] },
      },
      // Rejected: failed status & output.isError
      {
        threadId, type: "mcp_tool_call", toolName: "t3_hub.plan_update", status: "failed",
        startedAt: "2026-11-28T10:04:00Z", ordinal: 6,
        input: { steps: [{ text: "Failed call", status: "pending" }] },
      },
      {
        threadId, type: "mcp_tool_call", toolName: "t3_hub.plan_update", status: "completed",
        startedAt: "2026-11-28T10:05:00Z", ordinal: 7, output: { isError: true },
        input: { steps: [{ text: "Errored output", status: "pending" }] },
      },
      // Rejected: spoofed dynamic_tool without known namespace or matching integration source
      {
        threadId, type: "dynamic_tool", toolName: "evil.plan_update", status: "completed",
        startedAt: "2026-11-28T10:06:00Z", ordinal: 8,
        input: { steps: [{ text: "Spoofed tool", status: "pending" }] },
      },
      // Rejected: wrong projectRoot
      {
        threadId, type: "mcp_tool_call", toolName: "t3_hub.plan_update", status: "completed",
        startedAt: "2026-11-28T10:07:00Z", ordinal: 9,
        input: { projectRoot: "/remote/other", steps: [{ text: "Wrong project", status: "pending" }] },
      },
      // Rejected: non-string projectRoot
      {
        threadId, type: "mcp_tool_call", toolName: "t3_hub.plan_update", status: "completed",
        startedAt: "2026-11-28T10:08:00Z", ordinal: 10,
        input: { projectRoot: 42, steps: [{ text: "Invalid projectRoot type", status: "pending" }] },
      },
    ],
    visibleTurnItems: [],
  };

  const parsed = ui.normalizeRemoteThreadPlan(filteredProjection, env, threadId, projectRoot);
  assert.equal(parsed.source, "t3-connect-plan-update");
  assert.equal(parsed.planStatus, "active");
  assert.equal(parsed.steps.length, 2);
  assert.equal(parsed.steps[0].id.length, 120);
  assert.equal(parsed.steps[0].status, "completed");
  assert.equal(parsed.steps[1].id, "step-2");
  assert.equal(parsed.steps[1].status, "in-progress");
  assert.equal(parsed.steps[1].text, "Working <img src=x onerror=alert(1)>");

  // When projectRoot is unresolved (""), explicit args.projectRoot MUST be rejected (fail closed),
  // while a same-thread call without args.projectRoot is still accepted.
  const parsedNoRoot = ui.normalizeRemoteThreadPlan(
    {
      thread: { id: threadId },
      plans: [],
      turnItems: [
        {
          threadId, type: "tool_call", toolName: "briking_t3_hub.plan_update", status: "completed",
          startedAt: "2026-11-28T09:00:00Z", ordinal: 1,
          arguments: { steps: [{ text: "Allowed without projectRoot", status: "pending" }] },
        },
        {
          threadId, type: "tool_call", toolName: "briking_t3_hub.plan_update", status: "completed",
          startedAt: "2026-11-28T09:04:00Z", ordinal: 2,
          arguments: { projectRoot: "/other/project", steps: [{ text: "Must reject when expected root missing", status: "pending" }] },
        },
        {
          threadId, type: "tool_call", toolName: "briking_t3_hub.plan_update", status: "completed",
          startedAt: "2026-11-28T09:05:00Z", ordinal: 3,
          arguments: { projectRoot: { bad: true }, steps: [{ text: "Must reject non-string", status: "pending" }] },
        },
      ],
    },
    env,
    threadId,
    ""
  );
  assert.equal(parsedNoRoot.source, "t3-connect-plan-update");
  assert.deepEqual(JSON.parse(JSON.stringify(parsedNoRoot.steps)), [{ id: "step-1", text: "Allowed without projectRoot", status: "pending" }]);

  // P1 #3 regressions:
  // (a) Third-party evil_mcp.plan_update (even as mcp_tool_call with mcp:evil_mcp integration source or conflicting namespace) cannot overwrite or clear plans
  // (b) Incomplete statuses (running / pending / in_progress / empty) cannot clear or overwrite plans
  // (c) Unresolved projectRoot rejects explicit args.projectRoot: "/other/project" even when clearing
  const hardenedProjection = ui.normalizeRemoteThreadPlan(
    {
      thread: { id: threadId },
      plans: [],
      turnItems: [
        {
          threadId, type: "dynamic_tool", toolName: "t3_hub.plan_update", status: "completed",
          startedAt: "2026-11-28T09:00:00Z", ordinal: 1,
          toolSource: { kind: "integration", key: "mcp:t3_hub" },
          input: { steps: [{ text: "Legit Hub step", status: "in_progress" }] },
        },
        {
          threadId, type: "mcp_tool_call", toolName: "evil_mcp.plan_update", status: "completed",
          startedAt: "2026-11-28T10:00:00Z", ordinal: 2,
          toolSource: { kind: "integration", key: "mcp:evil_mcp" },
          input: { clear: true },
        },
        {
          threadId, type: "mcp_tool_call", toolName: "plan_update", status: "completed",
          startedAt: "2026-11-28T10:01:00Z", ordinal: 3,
          input: { steps: [{ text: "Bare mcp_tool_call without Hub namespace", status: "pending" }] },
        },
        {
          threadId, type: "dynamic_tool", toolName: "t3_hub.plan_update", status: "completed",
          startedAt: "2026-11-28T10:02:00Z", ordinal: 4,
          toolSource: { kind: "integration", key: "mcp:evil_mcp" },
          input: { clear: true },
        },
        {
          threadId, type: "dynamic_tool", toolName: "t3_hub.plan_update", status: "running",
          startedAt: "2026-11-28T10:03:00Z", ordinal: 5,
          toolSource: { kind: "integration", key: "mcp:t3_hub" },
          input: { clear: true },
        },
        {
          threadId, type: "dynamic_tool", toolName: "t3_hub.plan_update", status: "pending",
          startedAt: "2026-11-28T10:04:00Z", ordinal: 6,
          toolSource: { kind: "integration", key: "mcp:t3_hub" },
          input: { clear: true },
        },
        {
          threadId, type: "dynamic_tool", toolName: "t3_hub.plan_update", status: "in_progress",
          startedAt: "2026-11-28T10:05:00Z", ordinal: 7,
          toolSource: { kind: "integration", key: "mcp:t3_hub" },
          input: { clear: true },
        },
        {
          threadId, type: "dynamic_tool", toolName: "t3_hub.plan_update", status: "",
          startedAt: "2026-11-28T10:06:00Z", ordinal: 8,
          toolSource: { kind: "integration", key: "mcp:t3_hub" },
          input: { clear: true },
        },
        {
          threadId, type: "dynamic_tool", toolName: "t3_hub.plan_update", status: "completed",
          startedAt: "2026-11-28T10:07:00Z", ordinal: 9,
          toolSource: { kind: "integration", key: "mcp:t3_hub" },
          input: { projectRoot: "/other/project", clear: true },
        },
      ],
    },
    env,
    threadId,
    ""
  );
  assert.equal(hardenedProjection.source, "t3-connect-plan-update");
  assert.equal(hardenedProjection.cleared, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(hardenedProjection.steps)), [
    { id: "step-1", text: "Legit Hub step", status: "in-progress" },
  ]);

  // Native plan wins when newer than plan_update (preserves source: "t3-connect")
  const nativeNewer = ui.normalizeRemoteThreadPlan(
    {
      thread: { id: threadId },
      plans: [{ id: "n-new", threadId, kind: "todo_list", status: "active", steps: [{ id: "n", text: "Native newer", status: "completed" }] }],
      turnItems: [
        { threadId, type: "todo_list", planId: "n-new", updatedAt: "2026-11-28T11:00:00Z" },
        {
          threadId, type: "dynamic_tool_call", toolName: "t3_hub.plan_update", status: "completed",
          startedAt: "2026-11-28T10:00:00Z",
          input: { steps: [{ text: "Older tool plan", status: "pending" }] },
        },
      ],
    },
    env,
    threadId,
    projectRoot
  );
  assert.equal(nativeNewer.source, "t3-connect");
  assert.equal(nativeNewer.steps[0].text, "Native newer");

  // Clear wins on timestamp tie against native plan AND wins against same-time active mirror in newestRemotePlan
  const sameTs = "2026-11-28T12:00:00.000Z";
  const clearedTool = ui.normalizeRemoteThreadPlan(
    {
      thread: { id: threadId },
      plans: [{ id: "n-tie", threadId, kind: "todo_list", status: "active", steps: [{ text: "Tie native", status: "pending" }] }],
      turnItems: [
        { threadId, type: "todo_list", planId: "n-tie", updatedAt: sameTs },
        {
          threadId, type: "mcp_tool_call", serverName: "t3_hub", toolName: "plan_update", status: "completed",
          startedAt: sameTs, ordinal: 1,
          input: { steps: [{ text: "Same-ts active", status: "pending" }] },
        },
      ],
      visibleTurnItems: [
        {
          item: {
            threadId, type: "mcp_tool_call", serverName: "t3_hub", toolName: "plan_update", status: "completed",
            startedAt: sameTs, ordinal: 1,
            input: { clear: true },
          },
        },
      ],
    },
    env,
    threadId,
    projectRoot
  );
  assert.equal(clearedTool.source, "t3-connect-plan-update");
  assert.equal(clearedTool.cleared, true);
  assert.equal(clearedTool.planStatus, "");
  assert.deepEqual(JSON.parse(JSON.stringify(clearedTool.steps)), []);

  const sameTimeMirror = ui.normalizeRemotePlanMirror(
    JSON.stringify({
      schemaVersion: 1, threadId, projectRoot,
      steps: [{ id: "m1", text: "Stale mirror", status: "pending" }],
      source: "hub-mcp", updatedAt: sameTs,
    }),
    env,
    threadId,
    projectRoot
  );
  const winner = ui.newestRemotePlan(clearedTool, sameTimeMirror);
  assert.equal(winner.cleared, true, "cleared plan_update must win timestamp tie over active mirror");
  assert.deepEqual(JSON.parse(JSON.stringify(winner.steps)), []);
  ui.destroy();
});

test("Connect remote sessions hide the artifact dock while local sessions keep showing it", async () => {
  const env = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const threadId = "11111111-1111-4111-8111-111111111111";
  const projectRoot = "/remote/project";
  const ui = harness(async () => ({}), {
    location: { pathname: `/${env}/${threadId}`, hash: `#/${env}/${threadId}` },
    window: {
      __TSR_ROUTER__: { state: { location: { pathname: `/${env}/${threadId}`, searchStr: "" } } },
      __t3HudRemoteProject: (identity) => identity.environmentId === env && identity.threadId === threadId ? { environmentId: env, threadId, projectRoot } : null,
      __t3HudRemoteRpc: async (environmentId, tag) => {
        if (tag === "orchestration.getThreadProjection") {
          return {
            ok: true,
            value: {
              thread: { id: threadId },
              plans: [],
              turnItems: [{
                threadId, type: "dynamic_tool", toolName: "t3_hub.plan_update", status: "completed",
                startedAt: "2026-11-28T13:00:00Z",
                toolSource: { kind: "integration", key: "mcp:t3_hub" },
                input: { projectRoot, steps: [{ text: "Remote plan step", status: "in_progress" }] },
              }],
              visibleTurnItems: [],
            },
          };
        }
        return { ok: true, value: { contents: null } };
      },
    },
  });
  ui.ready();
  Object.assign(ui.state, {
    threadId,
    connected: false,
    artifactDockEnabled: true,
    open: false,
    hubSettingsOpen: false,
    context: { threadId, environmentId: env, remote: true },
  });
  await ui.pollBoard();
  assert.equal(ui.cache.board.source, "t3-connect-plan-update");
  assert.equal(ui.cache.board.steps[0].text, "Remote plan step");
  ui.renderArtifactDock();
  assert.equal(ui.artifactDock.hidden, true, "remote Connect session must hide the empty artifact dock");

  // Local session with verified local context must still show the artifact dock
  const localUi = harness(async () => ({}), {
    location: { pathname: "/threads/local-thread", hash: "#/threads/local-thread" },
  });
  localUi.ready();
  Object.assign(localUi.state, {
    threadId: "local-thread",
    projectRoot: "/local/project",
    connected: true,
    artifactDockEnabled: true,
    open: false,
    hubSettingsOpen: false,
    context: { threadId: "local-thread", projectRoot: "/local/project" },
  });
  localUi.cache.board = { threadId: "local-thread", projectRoot: "/local/project", steps: [], artifacts: [{ name: "report.md", path: "/local/project/report.md", sizeBytes: 128 }] };
  localUi.renderArtifactDock();
  assert.equal(localUi.artifactDock.hidden, false, "local session must keep showing the artifact dock");
  assert.match(localUi.artifactDock.innerHTML, /hub-arc-badge">1</);

  // Even without remote route, a board marked remote: true hides the dock
  localUi.cache.board = { remote: true, environmentId: env, threadId: "local-thread", steps: [], artifacts: [] };
  localUi.renderArtifactDock();
  assert.equal(localUi.artifactDock.hidden, true);
  ui.destroy();
  localUi.destroy();
});
