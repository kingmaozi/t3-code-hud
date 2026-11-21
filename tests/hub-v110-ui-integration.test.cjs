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
  const expose = `if (opts.__testHarness) { root=opts.root; content=opts.content; drawer=root.querySelector('#drawer'); settingsHandle=root.querySelector('#t3-hub-settings-handle'); settingsPanel=root.querySelector('#t3-hub-settings-panel'); artifactDock=root.querySelector('#t3-hub-artifact-dock'); liveBoard=root.querySelector('#t3-hub-live-board'); planHandle=root.querySelector('#t3-hub-plan-handle'); contextLoading=false; return { state, cache, storage: opts.storage, settingsPanel, artifactDock, settingsHandle, content, onClick, renderMemory, renderEngine, renderArtifactDock, renderHubSettingsPanel, setHubSettingsOpen, setArtifactDockEnabled, loadProviderResources, dockToggleMenu, dockOpenDefault, dockOpenWith, dockPreviewMarkdown }; }`;
  const instrumented = drawerSource.replace("    const api = {", expose + "\n    const api = {");
  assert.notEqual(instrumented, drawerSource);
  vm.runInNewContext(instrumented, sandbox);
  const ui = sandbox.window.__t3MountSidecarHub({ __testHarness: true, root, content, storage, hubRpc: rpcHandler });
  return { ui, storage, nodes, settingsPanel, artifactDock, settingsHandle, content };
}

test("Memory drawer mounts #t3-hub-engine with model selector and download controls", () => {
  const { ui, content, nodes } = createUiHarness(async () => ({ ok: true }));
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
  assert.match(content.innerHTML, /id="t3-hub-engine"/);
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
  assert.match(settingsPanel.innerHTML, /T3 Hub 设置/);
  assert.match(settingsPanel.innerHTML, /右侧圆弧产物悬浮窗/);
  assert.match(settingsPanel.innerHTML, /T3 升级自动防掉线守护/);
  assert.match(settingsPanel.innerHTML, /codegraph/);
  assert.doesNotMatch(settingsPanel.innerHTML, /magpie/i, "Settings UI must be 100% Magpie-free");
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

test("project-github-benchmark skill has valid YAML frontmatter", () => {
  const raw = fs.readFileSync(path.join(__dirname, "../skills/project-github-benchmark/SKILL.md"), "utf8");
  assert.match(raw, /^---\nname: project-github-benchmark\ndescription: .+\n---/);
});
