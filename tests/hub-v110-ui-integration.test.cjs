"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const drawerSource = fs.readFileSync(path.join(__dirname, "../src/hub-drawer-ui.js"), "utf8");

function makeFakeNode() {
  const attrs = new Map();
  const classes = new Set();
  const children = new Map();
  return {
    innerHTML: "",
    textContent: "",
    dataset: {},
    style: { setProperty() {} },
    hidden: false,
    disabled: false,
    inert: false,
    isConnected: true,
    setAttribute(k, v) { attrs.set(k, String(v)); },
    getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
    removeAttribute(k) { attrs.delete(k); },
    querySelector(sel) {
      if (!children.has(sel)) children.set(sel, makeFakeNode());
      return children.get(sel);
    },
    querySelectorAll() { return []; },
    contains() { return true; },
    getBoundingClientRect() { return { left: 100, top: 10, right: 200, bottom: 36, width: 100, height: 26 }; },
    classList: {
      add(c) { classes.add(c); },
      remove(c) { classes.delete(c); },
      toggle(c, force) { if (force === undefined) { if (classes.has(c)) classes.delete(c); else classes.add(c); } else if (force) classes.add(c); else classes.delete(c); },
      contains(c) { return classes.has(c); },
    },
    closest() { return null; },
    addEventListener() {},
    removeEventListener() {},
    remove() {},
  };
}

function createUiHarness(rpcHandler) {
  const storage = new Map();
  const root = makeFakeNode();
  const content = makeFakeNode();
  const settingsPanel = makeFakeNode();
  const artifactDock = makeFakeNode();
  const settingsHandle = makeFakeNode();
  const liveBoard = makeFakeNode();
  const planHandle = makeFakeNode();
  const nodes = new Map([
    ["#t3-hub-settings-panel", settingsPanel],
    ["#t3-hub-artifact-dock", artifactDock],
    ["#t3-hub-settings-handle", settingsHandle],
    ["#t3-hub-live-board", liveBoard],
    ["#t3-hub-plan-handle", planHandle],
    [".hub-content", content],
  ]);
  root.querySelector = (sel) => {
    if (!nodes.has(sel)) nodes.set(sel, makeFakeNode());
    return nodes.get(sel);
  };
  const sandbox = {
    window: { dispatchEvent() {}, addEventListener() {}, removeEventListener() {} },
    document: {
      body: makeFakeNode(),
      head: { appendChild() {} },
      hidden: false,
      activeElement: null,
      querySelectorAll: () => [],
      querySelector: () => null,
      getElementById: () => null,
      createElement: () => makeFakeNode(),
      documentElement: { lang: "zh" },
    },
    location: { pathname: "/threads/t-1", href: "https://fixture.test/threads/t-1", hash: "" },
    innerWidth: 1280,
    innerHeight: 800,
    getComputedStyle: () => ({ visibility: "visible" }),
    CustomEvent: class {},
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
    },
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    console,
  };
  const expose = `if (opts.__testHarness) { root=opts.root; content=opts.content; drawer=root.querySelector('#drawer'); settingsHandle=root.querySelector('#t3-hub-settings-handle'); settingsPanel=root.querySelector('#t3-hub-settings-panel'); artifactDock=root.querySelector('#t3-hub-artifact-dock'); liveBoard=root.querySelector('#t3-hub-live-board'); planHandle=root.querySelector('#t3-hub-plan-handle'); contextLoading=false; return { state, cache, storage: opts.storage, settingsPanel, artifactDock, settingsHandle, content, onClick, renderMemory, renderMemoryAgentAccess, renderEngine, renderArtifactDock, renderHubSettingsPanel, setHubSettingsOpen, setArtifactDockEnabled, loadProviderResources, toggleProviderResourceItem, providerMemorySetupPrompt, copyProviderMemorySetupPrompt, dockToggleMenu, dockOpenDefault, dockOpenWith, dockPreviewMarkdown }; }`;
  const instrumented = drawerSource.replace("    const api = {", expose + "\n    const api = {");
  assert.notEqual(instrumented, drawerSource);
  vm.runInNewContext(instrumented, sandbox);
  const ui = sandbox.window.__t3MountSidecarHub({ __testHarness: true, root, content, storage, hubRpc: rpcHandler });
  return { ui, storage, nodes, settingsPanel, artifactDock, settingsHandle, content };
}

test("Memory settings migrate into Settings panel while Memory drawer stays clean with shortcut", () => {
  const { ui, content, nodes, settingsPanel } = createUiHarness(async () => ({ ok: true }));
  ui.cache.embed = {
    running: true,
    ready: true,
    mode: "mlx",
    port: 8001,
    activeModelId: "mlx-community/Qwen3-Embedding-4B-4bit-DWQ",
    configuredModelId: "mlx-community/Qwen3-Embedding-4B-4bit-DWQ",
    models: [
      { id: "mlx-community/Qwen3-Embedding-4B-4bit-DWQ", name: "Qwen3 4B", sizeMb: 2080, dim: 2560, downloaded: true },
      { id: "mlx-community/bge-m3-mlx-8bit", name: "BGE-M3 8-bit", sizeMb: 576, dim: 1024, downloaded: false },
    ],
  };
  ui.renderMemory();
  assert.match(content.innerHTML, /data-action="open-hub-memory-settings"/, "Memory drawer provides quick shortcut to Settings");
  assert.doesNotMatch(content.innerHTML, /id="t3-hub-engine"/, "Vector engine settings moved out of Memory drawer into Settings");
  assert.match(drawerSource, /id="t3-hub-settings-memory-pane"[\s\S]*id="t3-hub-engine"/, "Settings panel hosts memory & vector settings");
  assert.match(drawerSource, /class="hub-memory-combo"[\s\S]*id="t3-hub-memory-handle"[\s\S]*id="t3-hub-memory-toggle"/, "Memory and on/off toggle joined in one combo pill");
  ui.setHubSettingsOpen(true, "memory");
  assert.equal(settingsPanel.querySelector("#t3-hub-settings-memory-pane").hidden, false);
  const engineHtml = nodes.get("#t3-hub-engine").innerHTML;
  assert.match(engineHtml, /name="embed-model"/);
  assert.match(engineHtml, /data-action="switch-embed"/);
  assert.match(engineHtml, /hf-mirror/);
  assert.match(engineHtml, /BGE-M3 8-bit/);
});

test("Settings panel lazily loads standalone provider resources & guardian with zero Magpie references", async () => {
  const calls = [];
  const { ui, settingsPanel } = createUiHarness(async (action, payload) => {
    calls.push({ action, payload });
    if (action === "providerResources:list") {
      return {
        ok: true,
        providers: [
          {
            id: "codex",
            label: "Codex",
            counts: { mcp: 1, skills: 1, plugins: 1 },
            mcp: [{ id: "codegraph", name: "codegraph", description: "/usr/local/bin/codegraph", enabled: true, provider: "codex", kind: "mcp" }],
            skills: [{ id: "pdf", name: "pdf", description: "PDF tools", enabled: false, provider: "codex", kind: "skills" }],
            plugins: [{ id: "github@openai-curated", name: "github", description: "openai-curated", enabled: true, provider: "codex", kind: "plugins" }],
          },
        ],
      };
    }
    if (action === "guardian:status") return { ok: true, enabled: false };
    if (action === "guardian:set") return { ok: true, enabled: payload.enabled };
    return { ok: true };
  });

  ui.setHubSettingsOpen(true);
  await new Promise((r) => setImmediate(r));
  assert.ok(calls.some((c) => c.action === "providerResources:list"));
  assert.ok(calls.some((c) => c.action === "guardian:status"));
  const chromeHtml = settingsPanel.querySelector("#t3-hub-settings-chrome").innerHTML;
  const generalHtml = settingsPanel.querySelector("#t3-hub-settings-general-pane").innerHTML;
  assert.match(chromeHtml, /T3 Hub 设置/);
  assert.match(chromeHtml, /记忆与向量/);
  assert.match(generalHtml, /右侧圆弧产物悬浮窗/);
  assert.match(generalHtml, /T3 升级自动防掉线守护/);
  assert.match(generalHtml, /codegraph/);
  assert.doesNotMatch(chromeHtml + generalHtml, /magpie/i, "Settings UI must be 100% Magpie-free");
});

test("Right-edge curved artifact dock expands, lists apps, previews escaped Markdown, and respects Settings toggle", async () => {
  const calls = [];
  const { ui, artifactDock, storage } = createUiHarness(async (action, payload) => {
    calls.push({ action, payload });
    if (action === "artifact:listApps") {
      return { ok: true, kind: "apps", apps: [{ name: "Typora", path: "/Applications/Typora.app", isDefault: true }] };
    }
    if (action === "artifact:openDefault") return { ok: true, kind: "opened" };
    if (action === "artifact:openWith") return { ok: true, kind: "opened-with", appName: "Typora" };
    if (action === "board:openArtifact" && payload.operation === "preview") {
      return { ok: true, kind: "markdown", name: "plan.md", content: "# Hello <script>xss()</script>" };
    }
    return { ok: true };
  });

  Object.assign(ui.state, { connected: true, projectRoot: "/proj", threadId: "t-1", context: { threadId: "t-1", projectRoot: "/proj" } });
  ui.cache.board = { artifacts: [{ name: "plan.md", path: "/brain/t-1/plan.md", sizeBytes: 2048 }], steps: [], progress: { completed: 0, total: 0 } };

  ui.renderArtifactDock();
  assert.equal(artifactDock.hidden, false);
  assert.match(artifactDock.innerHTML, /hub-arc-tab/);
  assert.match(artifactDock.innerHTML, />1</);

  // Expand dock
  ui.state.artifactDockOpen = true;
  ui.renderArtifactDock();
  assert.match(artifactDock.innerHTML, /plan\.md/);
  assert.match(artifactDock.innerHTML, /data-action="dock-open-default"/);
  assert.match(artifactDock.innerHTML, /data-action="dock-toggle-menu"/);

  // Open-with menu lists apps
  await ui.dockToggleMenu(0);
  assert.match(artifactDock.innerHTML, /Typora/);
  assert.match(artifactDock.innerHTML, /选择其他应用/);

  // Markdown preview escapes HTML
  await ui.dockPreviewMarkdown(0, null);
  assert.match(artifactDock.innerHTML, /&lt;script&gt;xss\(\)&lt;\/script&gt;/);

  // Open default + open with
  await ui.dockOpenDefault(0, null);
  await ui.dockOpenWith(0, "/Applications/Typora.app", false, null);
  assert.ok(calls.some((c) => c.action === "artifact:openDefault"));
  assert.ok(calls.some((c) => c.action === "artifact:openWith" && c.payload.appPath === "/Applications/Typora.app"));

  // Disabling dock in Settings hides it and persists
  ui.setArtifactDockEnabled(false);
  assert.equal(artifactDock.hidden, true);
  assert.equal(storage.get("t3-hub-artifact-dock-v1"), "false");
});

test("Unsupported memory agents expose tailored setup prompts, Settings memory tab has history quickbar, and Skills sync switch passes syncAllProviders", async () => {
  const calls = [];
  const { ui, nodes, settingsPanel } = createUiHarness(async (action, payload) => {
    calls.push({ action, payload });
    if (action === "providerResources:toggle") return { ok: true, enabled: payload.enabled, syncedProviders: ["Codex", "OpenCode"] };
    if (action === "providerResources:list") return { ok: true, providers: [] };
    return { ok: true };
  });

  // 1. Unsupported agents (OpenCode / Devin) show tailored setup prompt buttons & generated prompts
  ui.cache.agentAccess = {
    enabled: true,
    setupSummary: {
      configured: 1,
      unsupported: 2,
      providers: [
        { instanceId: "codex", displayName: "Codex", status: "configured" },
        { instanceId: "opencode", displayName: "OpenCode", status: "unsupported", reason: "unsupported_driver" },
        { instanceId: "acpRegistry_devin", displayName: "Devin", status: "unsupported", reason: "unsupported_driver" },
      ],
    },
  };
  ui.renderMemoryAgentAccess();
  const accessHtml = nodes.get("#t3-hub-memory-access").innerHTML;
  assert.match(accessHtml, /data-action="copy-provider-memory-prompt"[^>]*data-provider-id="opencode"/);
  assert.match(accessHtml, /data-action="copy-provider-memory-prompt"[^>]*data-provider-id="acpRegistry_devin"/);
  assert.match(accessHtml, /自动写入暂不支持，可复制专属接入提示词/);

  const ocPrompt = ui.providerMemorySetupPrompt("opencode", "OpenCode");
  assert.match(ocPrompt, /~\/\.config\/opencode\/opencode\.json/);
  assert.match(ocPrompt, /t3-mcp-router\\" --memory-only/);
  assert.doesNotMatch(ocPrompt, /magpie/i);

  const devinPrompt = ui.providerMemorySetupPrompt("acpRegistry_devin", "Devin");
  assert.match(devinPrompt, /~\/\.config\/devin\/mcp_config\.json/);
  assert.match(devinPrompt, /mcpServers/);
  assert.doesNotMatch(devinPrompt, /magpie/i);

  await ui.copyProviderMemorySetupPrompt("opencode", "OpenCode");
  assert.match(nodes.get("#t3-hub-memory-access").innerHTML, /OpenCode 专属接入提示词/);

  // 2. Settings -> Memory tab shows quickbar to Memory Workspace & local folder
  ui.setHubSettingsOpen(true, "memory");
  const quickbarHtml = settingsPanel.querySelector("#t3-hub-settings-memory-quickbar").innerHTML;
  assert.match(quickbarHtml, /data-action="open-memory-from-settings"/);
  assert.match(quickbarHtml, /data-action="open-memory-folder"/);

  // 3. Skills tab shows cross-provider sync toggle & passes syncAllProviders: true
  ui.state.hubSettingsTab = "general";
  ui.state.providerResKind = "skills";
  ui.state.skillSyncAllProviders = true;
  ui.renderHubSettingsPanel();
  const generalHtml = settingsPanel.querySelector("#t3-hub-settings-general-pane").innerHTML;
  assert.match(generalHtml, /同名 Skill 跨端同步开关/);
  assert.match(generalHtml, /data-action="toggle-skill-sync-all"/);

  const fakeToggleBtn = {
    dataset: { provider: "codex", kind: "skills", id: "cdp-inject", sourceDir: "/fake/.codex/skills" },
    getAttribute: (k) => (k === "aria-checked" ? "true" : null),
    classList: { add() {}, remove() {} },
    isConnected: true,
    tagName: "BUTTON",
    innerHTML: "",
  };
  await ui.toggleProviderResourceItem(fakeToggleBtn);
  const toggleCall = calls.find((c) => c.action === "providerResources:toggle");
  assert.ok(toggleCall, "providerResources:toggle called");
  assert.equal(toggleCall.payload.syncAllProviders, true);

  // 4. Clicking a memory card (data-action="open-memory" WITH data-id) selects & expands it instead of being shadowed by title openMemoryFromTitle
  ui.state.tab = "memory";
  ui.state.selectedMemory = null;
  const fakeMemCardBtn = {
    dataset: { action: "open-memory", id: "mem-42" },
    disabled: false,
    closest(sel) { return sel === "[data-action]" ? this : null; },
  };
  ui.onClick({ target: fakeMemCardBtn });
  assert.equal(ui.state.selectedMemory, "mem-42", "Clicking memory card expands it rather than invoking title openMemoryFromTitle");
  assert.match(drawerSource, /#t3-hub-drawer\.is-single-tab\{grid-template-columns:minmax\(0,1fr\)\}/);
  assert.match(drawerSource, /#t3-hub-settings-panel\{[^}]*width:min\(740px,92vw\)/);
});

test("project-github-benchmark skill has valid YAML frontmatter", () => {
  const raw = fs.readFileSync(path.join(__dirname, "../skills/project-github-benchmark/SKILL.md"), "utf8");
  assert.match(raw, /^---\nname: project-github-benchmark\ndescription: .+\n---/);
});
