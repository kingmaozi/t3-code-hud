"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
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
    closest: () => null, matches: () => false, addEventListener() {}, removeEventListener() {}, remove() {},
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
    innerWidth: 1280, innerHeight: 800, getComputedStyle: () => ({ visibility: "visible" }),
    CustomEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
    localStorage: environment.localStorage || { getItem: () => null, setItem() {} },
    setTimeout: () => 1, clearTimeout() {}, console,
  };
  const expose = `if (opts.__testHarness) {
    root = opts.root; content = opts.content;
    handle = root.querySelector("#t3-hub-handle"); planHandle = root.querySelector("#t3-hub-plan-handle"); drawer = root.querySelector("#t3-hub-drawer"); liveBoard = root.querySelector("#t3-hub-live-board"); palette = root.querySelector("#t3-hub-slash-palette");

    return {state, cache, errors, settingsValues, renderSettings, loadSettings, saveNativeSettings,
      onInput, onClick, onEditorKeydown, renderMemoryList, renderHooks, renderSkillList, renderMcpList,
      renderSubagents, renderCommander, boardMarkup, brandIcon, request, esc, agentHosts,
      hubThemes, themeSwitcher, applyTheme, setTheme, currentThreadId, syncThread, checkRoute, pollBoard, updateBoard, renderLiveBoard, renderBoardTab,
      composerToken, composerSurface, positionSlash, closeSlash, selectSlash, onComposerInput, onComposerKeydown,
      findSessionRelationsCard, positionConversationTools, formatExactTime, renderMemoryHistory, renderDream,
      ready: () => { contextLoading = false; },
      setCurrentRoute: () => { lastRoute = routeKey(); },
      setSlash: (session) => { slashSession = session; }, getSlash: () => slashSession,
      setStyle: (fn) => { getComputedStyle = fn; }};
  }`;
  vm.runInNewContext(drawerSource.replace("    const api = {", expose + "\n    const api = {"), sandbox, { filename: "hub-drawer-ui.js" });
  const ui = sandbox.window.__t3MountSidecarHub({ __testHarness: true, root, content, hubRpc: rpc });
  if (!sandbox.document.body) sandbox.document.body = node();
  return { ...ui, root, content, nodes, sandbox };
}

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

test("AutoDream run consumes the backend journal while preserving presets and its wrapped config", async () => {
  const source = drawerSource.match(/    async function runDream\([^]*?\n    \}/)[0];
  const cache = { dream: { config: { enabled: true }, presets: [{ id: "keep" }], journal: [{ id: "old" }] }, overview: {} };
  const context = {
    cache, state: { projectRoot: "/fixture", tab: "board" }, errors: {}, disposed: false, contextVersion: 1,
    dreamConfig: () => cache.dream.config, request: async () => ({ config: { enabled: true }, journal: [{ id: "new" }], report: { merged: 1 } }),
    renderDream() {}, refreshMemoryOverview() {}, refreshEmbed() {}, loadMemories() {}, toast() {}, tr: (zh) => zh,
  };
  await vm.runInNewContext(source + ";runDream()", context);
  assert.equal(cache.dream.journal[0].id, "new");
  assert.equal(cache.dream.presets[0].id, "keep");
  assert.equal(cache.dream.config.lastReport.merged, 1);
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

test("core tabs and their literal/dynamic RPC actions have backend dispatch cases", () => {
  const backend = fs.readFileSync(path.join(repo, "src/backend.cjs"), "utf8");
  const cases = new Set([...backend.matchAll(/case\s+"([\w:]+)"\s*:/g)].map((m) => m[1]));
  const actions = new Set([...drawerSource.matchAll(/"((?:hub|plugins|hooks|skills|subagents|mcp|memory|board|settings|agentsMd|embed|slash):[\w:]+)"/g)].map((m) => m[1]));
  for (const domain of ["skills", "mcp"]) for (const op of ["list", "toggleAgent"]) actions.add(`${domain}:${op}`);
  for (const action of actions) assert.ok(cases.has(action), `missing backend RPC: ${action}`);
  assert.deepEqual(JSON.parse(drawerSource.match(/const tabKeys = (\[[^;]+\]);/)[1]), ["memory", "skills", "subagents", "settings", "board", "agents"]);
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
      for (const surface of [ui.root, ...["#t3-hub-handle", "#t3-hub-live-board", "#t3-hub-slash-palette"].map((id) => ui.nodes.get(id))]) {
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

test("plan stays outside React card and follows its geometry, hiding when disconnected", () => {
  const { ui, card, section, label } = relationFixture();
  const anchor = ui.findSessionRelationsCard();
  assert.equal(anchor.card, card);
  const board = ui.nodes.get("#t3-hub-live-board");
  ui.positionConversationTools();
  assert.equal(board.parentElement, ui.root);
  assert.equal(card.children[1], section);
  assert.equal(board.style.left, "930px");
  assert.equal(board.style.width, "320px");
  assert.equal(board.style.top, "509px");
  assert.equal(board.hidden, false);
  for (const title of ["Session relationships", "之前的智能体", "Previous agents"]) {
    label.textContent = title;
    assert.equal(ui.findSessionRelationsCard().card, card);
  }
  label.textContent = "unrelated";
  card.isConnected = false;
  ui.positionConversationTools();
  assert.equal(board.hidden, true);
  assert.equal(board.parentElement, ui.root);
  label.textContent = "会话关系";
  label.closest = () => node();
  assert.equal(ui.findSessionRelationsCard(), null);
  const css = drawerSource.match(/#t3-hub-live-board\{([^}]+)\}/)[1];
  assert.match(css, /position:fixed/);
  assert.doesNotMatch(drawerSource, /anchor\.card\.appendChild\(liveBoard\)/);
});

test("missing or hidden inspector exposes a direct plan entry with the current session's status", () => {
  const { ui, card, sidebar } = relationFixture();
  const entry = ui.root.querySelector("#t3-hub-plan-handle");
  ui.ready();
  Object.assign(ui.state, { connected: true, threadId: "thread-a", context: { threadId: "thread-a" } });
  ui.cache.board = { steps: [{ text: "当前任务", status: "pending" }] };
  ui.renderLiveBoard();
  assert.equal(ui.nodes.get("#t3-hub-live-board").hidden, false);
  assert.equal(entry.hidden, true, "do not duplicate a visible inline panel");
  card.isConnected = false;
  sidebar.querySelectorAll = () => [];
  ui.positionConversationTools();
  assert.equal(entry.hidden, false);
  assert.match(entry.textContent, /计划.*0\/1/);
  assert.match(entry.title, /详情|侧栏/);
  Object.assign(entry, { dataset: { action: "open-board-studio" }, closest: () => entry });
  ui.root.contains = (target) => target === entry;
  ui.onClick({ target: entry });
  assert.equal(ui.state.open, true);
  assert.equal(ui.state.tab, "board");
  assert.match(ui.content.innerHTML, /当前任务/);
});

test("plan entry distinguishes no plan, loading, read failure, and a mismatched session", async () => {
  const calls = [];
  const ui = harness(async (action, payload) => { calls.push({ action, payload }); return { steps: [] }; });
  const entry = ui.root.querySelector("#t3-hub-plan-handle");
  ui.ready();
  Object.assign(ui.state, { connected: true, projectRoot: "/fixture", threadId: "thread-a", context: { threadId: "thread-a" } });
  ui.renderLiveBoard();
  assert.match(entry.textContent, /读取中/);
  ui.cache.board = { steps: [] };
  ui.renderLiveBoard();
  assert.match(entry.textContent, /暂无计划/);
  ui.renderBoardTab();
  assert.match(ui.content.innerHTML, /当前没有计划步骤|暂无计划/);
  ui.errors.board = new Error("unavailable");
  ui.renderLiveBoard();
  assert.match(entry.textContent, /读取失败/);
  ui.state.context = { threadId: "other-thread" };
  ui.renderLiveBoard();
  assert.match(entry.textContent, /会话未匹配/);
  await ui.pollBoard();
  assert.equal(calls.filter((item) => item.action === "board:get").length, 0);
  ui.state.boardDraft = "must not be saved";
  await ui.updateBoard(null, "add");
  assert.equal(calls.filter((item) => item.action === "board:update").length, 0);
  const draftProject = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  Object.assign(ui.sandbox.location, { pathname: "/", hash: `#/projects/${draftProject}/new`, href: `t3code://app/#/projects/${draftProject}/new` });
  ui.state.threadId = "__NEW__";
  ui.state.context = { threadId: "__NEW__", projectId: draftProject, projectRoot: "/fixture", draftProjectVerified: true };
  delete ui.errors.board;
  ui.renderLiveBoard();
  assert.match(entry.textContent, /暂无计划/);
});

test("a mismatched or unresolved board response never claims there is no plan", async () => {
  for (const returnedThread of ["another-thread", ""]) {
    const ui = harness(async () => ({ threadId: returnedThread, steps: [] }));
    const entry = ui.root.querySelector("#t3-hub-plan-handle");
    ui.ready();
    Object.assign(ui.state, { connected: true, threadId: "thread-a", projectRoot: "/fixture" });
    await ui.pollBoard();
    assert.equal(ui.cache.board, null);
    assert.match(entry.textContent, /会话未匹配/);
    ui.renderBoardTab();
    assert.match(ui.content.innerHTML, /会话未匹配/);
  }
});

test("draft plan read/write needs the current route's verified project", async () => {
  const projectA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", projectB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", calls = [];
  let board = { threadId: "__NEW__", steps: [] };
  const ui = harness(async (action, payload) => {
    calls.push({ action, payload });
    if (action === "board:update") board = { threadId: "__NEW__", steps: payload.steps };
    if (action === "board:clear") board = { threadId: "__NEW__", steps: [] };
    return action === "board:get" ? board : {};
  });
  ui.ready();
  Object.assign(ui.sandbox.location, { pathname: "/", hash: `#/projects/${projectB}/new`, href: `t3code://app/#/projects/${projectB}/new` });
  Object.assign(ui.state, { connected: true, threadId: "__NEW__", projectRoot: "/tmp/project-a", context: { threadId: "__NEW__", projectId: projectA, projectRoot: "/tmp/project-a", draftProjectVerified: true }, boardDraft: "draft" });
  ui.cache.board = { steps: [] };
  await ui.pollBoard(); await ui.updateBoard(null, "add"); await ui.updateBoard(null, "clear");
  assert.equal(calls.filter((entry) => /^board:/.test(entry.action)).length, 0, "a stale project must never be read or written");
  ui.state.context = { threadId: "__NEW__", projectId: projectB, projectRoot: "/tmp/project-b", draftProjectVerified: true };
  ui.state.projectRoot = "/tmp/project-b";
  for (const hash of [`#/draft/${projectB}`, `#/${projectB}/new`]) {
    Object.assign(ui.sandbox.location, { hash, href: `t3code://app/${hash}` });
    calls.length = 0;
    await ui.pollBoard(); await ui.updateBoard(null, "add"); await ui.updateBoard(null, "clear");
    assert.equal(calls.length, 0, `${hash} cannot prove project ownership even when the UUID matches`);
  }
  Object.assign(ui.sandbox.location, { hash: `#/projects/${projectB}/new`, href: `t3code://app/#/projects/${projectB}/new` });
  await ui.pollBoard(); await ui.updateBoard(null, "add"); await ui.updateBoard(null, "clear");
  const requests = calls.filter((entry) => /^board:/.test(entry.action));
  assert.ok(requests.some((entry) => entry.action === "board:update"));
  assert.ok(requests.some((entry) => entry.action === "board:clear"));
  for (const entry of requests) { assert.equal(entry.payload.threadId, "__NEW__"); assert.equal(entry.payload.projectRoot, "/tmp/project-b"); }
  ui.state.context.draftProjectVerified = false;
  calls.length = 0;
  await ui.pollBoard(); await ui.updateBoard(null, "add");
  assert.equal(calls.length, 0, "legacy unverified contexts must not write a draft");
  ui.state.connected = false;
  ui.state.contextError = "无法确认新会话所属项目，请先选择项目";
  ui.renderLiveBoard();
  assert.match(ui.root.querySelector("#t3-hub-plan-handle").textContent, /未确认所属项目/);
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
  await ui.pollBoard(); await ui.updateBoard(null, "add"); await ui.updateBoard(null, "clear");
  assert.equal(calls.length, 0, "a different environment must not use the local context");
  assert.match(ui.root.querySelector("#t3-hub-plan-handle").textContent, /会话未匹配/);
  delete ui.state.context.environmentId;
  await ui.pollBoard(); await ui.updateBoard(null, "add"); await ui.updateBoard(null, "clear");
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
    await ui.pollBoard(); await ui.updateBoard(null, "add"); await ui.updateBoard(null, "clear");
    assert.equal(calls.length, 0, `${id} must not read or write the previous local context`);
  }
  Object.assign(ui.sandbox.location, { hash: `#/${local}/thread%3Alocal`, href: `t3code://app/#/${local}/thread%3Alocal` });
  assert.equal(ui.currentThreadId(), "thread:local", "the native route decodes the actual thread ID");
  await ui.pollBoard();
  assert.equal(calls.length, 1, "the matching local environment can read its thread");
  assert.equal(calls[0].payload.threadId, "thread:local");
  calls.length = 0;
  ui.state.threadId = "thread-a";
  ui.state.context.threadId = "thread-a";
  Object.assign(ui.sandbox.location, { hash: `#/${remote}/thread-a`, href: `t3code://app/#/${remote}/thread-a` });
  assert.equal(ui.currentThreadId(), "thread-a");
  await ui.pollBoard(); await ui.updateBoard(null, "add"); await ui.updateBoard(null, "clear");
  assert.equal(calls.length, 0, "plain string thread IDs still require the matching environment");
  Object.assign(ui.sandbox.location, { hash: `#/${local}/thread-a`, href: `t3code://app/#/${local}/thread-a` });
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

test("low space uses the plan entry; settings and native dialogs do not add floating controls", () => {
  const { ui, card } = relationFixture();
  const entry = ui.root.querySelector("#t3-hub-plan-handle");
  ui.ready();
  Object.assign(ui.state, { connected: true, threadId: "thread-a", context: { threadId: "thread-a" } });
  ui.cache.board = { steps: [] };
  card.getBoundingClientRect = () => ({ left: 930, right: 1250, top: 400, bottom: 790, width: 320, height: 390 });
  ui.positionConversationTools();
  assert.equal(entry.hidden, false);
  assert.match(entry.title, /空间不足/);
  ui.root.classList.add("is-occluded");
  ui.positionConversationTools();
  assert.equal(entry.hidden, true);
  ui.root.classList.remove("is-occluded");
  Object.assign(ui.sandbox.location, { pathname: "/", hash: "", href: "https://fixture.test/" });
  ui.positionConversationTools();
  assert.equal(entry.hidden, true, "the home page must not suggest another thread's plan");
  Object.assign(ui.sandbox.location, { pathname: "/settings", hash: "", href: "https://fixture.test/settings" });
  ui.positionConversationTools();
  assert.equal(entry.hidden, true);
});

test("plan board stays in place near the window bottom and never shifts beside the card", () => {
  const { ui, card } = relationFixture();
  const board = ui.nodes.get("#t3-hub-live-board");
  let bottom = 730;
  card.getBoundingClientRect = () => ({ left: 930, right: 1250, top: 400, bottom, width: 320, height: bottom - 400 });
  ui.state.boardExpanded = false;
  ui.positionConversationTools();
  assert.equal(board.hidden, false);
  assert.equal(board.style.left, "930px");
  assert.equal(board.style.top, "729px");
  assert.equal(board.style.maxHeight, "63px");
  ui.state.boardExpanded = true;
  ui.positionConversationTools();
  assert.equal(board.style.top, "729px", "expanding must not move the header");
  assert.equal(board.style.left, "930px");
  bottom = 790;
  ui.positionConversationTools();
  assert.equal(board.hidden, true, "with no room for its toolbar, the board must not cover native controls");
  assert.equal(board.parentElement, ui.root);
});

test("a short viewport shows the full-plan link instead of a nearly invisible expanded step", () => {
  const { ui, card } = relationFixture();
  const board = ui.nodes.get("#t3-hub-live-board"), toggle = node();
  board.querySelector = (selector) => selector === ".hub-board-toggle" ? toggle : null;
  let bottom = 730;
  card.getBoundingClientRect = () => ({ left: 930, right: 1250, top: 400, bottom, width: 320, height: bottom - 400 });
  ui.state.boardExpanded = true;
  for (const edge of [730, 713]) {
    bottom = edge;
    ui.positionConversationTools();
    assert.equal(board.hidden, false);
    assert.equal(board.classList.contains("is-space-limited"), true);
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(ui.state.boardExpanded, true, "space restrictions must not change the saved preference");
  }
  bottom = 650;
  ui.positionConversationTools();
  assert.equal(board.classList.contains("is-space-limited"), false);
  assert.equal(toggle.getAttribute("aria-expanded"), "true", "expansion resumes when space returns");
  assert.equal(ui.state.boardExpanded, true);
  ui.renderLiveBoard();
  assert.match(board.innerHTML, /在 Hub 查看完整计划/);
  assert.match(drawerSource, /is-space-limited \.hub-board-content\{display:none/);
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

test("plan opens downwards below a content-sized inspector without moving its header", () => {
  const { ui, card } = relationFixture();
  const board = ui.nodes.get("#t3-hub-live-board");
  const viewport = node();
  ui.sandbox.innerHeight = 998;
  viewport.getBoundingClientRect = () => ({ left: 930, right: 1250, top: 100, bottom: 501, width: 320, height: 401 });
  card.closest = (selector) => selector.startsWith("aside,") ? viewport : null;
  card.getBoundingClientRect = () => ({ left: 930, right: 1250, top: 140, bottom: 477, width: 320, height: 337 });
  ui.state.boardExpanded = false;
  ui.positionConversationTools();
  assert.equal(board.hidden, false);
  assert.equal(board.style.top, "476px");
  assert.equal(board.style.maxHeight, "514px");
  ui.state.boardExpanded = true;
  ui.positionConversationTools();
  assert.equal(board.style.top, "476px", "expanding must only grow downwards");
  assert.equal(board.style.maxHeight, "514px");
  assert.equal(board.parentElement, ui.root);
  assert.match(drawerSource, /#t3-hub-live-board\{[^}]*display:flex[^}]*flex-direction:column/);
  assert.match(drawerSource, /#t3-hub-live-board \.hub-board-content\{[^}]*min-height:0[^}]*overflow:auto/);
});

test("progress defaults to open even after the old version saved it collapsed", () => {
  const legacy = { getItem: (key) => key === "t3-hub-board-expanded" ? "false" : null, setItem() {} };
  const oldUi = { snapshot: () => ({ boardExpanded: false }), destroy() {} };
  assert.equal(harness(undefined, { localStorage: legacy, window: { __t3SidecarHub: oldUi } }).state.boardExpanded, true);
  const migrated = { getItem: (key) => key === "t3-hub-board-expanded-v2" ? "false" : null, setItem() {} };
  assert.equal(harness(undefined, { localStorage: migrated }).state.boardExpanded, false, "a new explicit collapse is remembered");
});

test("plan scrolling survives polling and geometry updates but resets for a new thread", () => {
  const { ui } = relationFixture();
  const board = ui.nodes.get("#t3-hub-live-board");
  let scroll = { scrollTop: 220 }, html = "";
  board.dataset.threadId = "thread-a";
  board.querySelector = (selector) => selector === ".hub-board-content" ? scroll : null;
  Object.defineProperty(board, "innerHTML", { get: () => html, set: (value) => { html = value; scroll = { scrollTop: 0 }; } });
  Object.defineProperty(board.style, "maxHeight", { set: (value) => { if (value === "none") scroll.scrollTop = Math.min(scroll.scrollTop, 180); } });
  ui.state.threadId = "thread-a";
  ui.state.boardExpanded = true;
  ui.renderLiveBoard();
  assert.equal(scroll.scrollTop, 220, "poll redraw must retain the user's scroll position");
  ui.positionConversationTools();
  assert.equal(scroll.scrollTop, 220, "resizing must retain the user's scroll position");
  ui.state.threadId = "thread-b";
  ui.renderLiveBoard();
  assert.equal(scroll.scrollTop, 0, "new threads start at the top");
});

test("empty plans stay visible, inline plan supports check/add/Studio/theme actions, and subagent lists never repeat", () => {
  const { ui } = relationFixture();
  const board = ui.nodes.get("#t3-hub-live-board");
  ui.ready();
  Object.assign(ui.state, { connected: true, threadId: "thread-a" });
  ui.cache.board = { steps: [] };
  ui.renderLiveBoard();
  assert.equal(board.hidden, false);
  assert.match(board.innerHTML, /计划进度 暂无计划/);
  ui.cache.board = { steps: [{ text: "核对页面", status: "pending" }], subagents: [{ name: "duplicate-agent", status: "running" }] };
  ui.state.boardExpanded = true;
  ui.renderLiveBoard();
  assert.match(board.innerHTML, /计划进度 0\/1/);
  for (const action of ["board-step", "board-add", "open-board-studio", "set-theme"]) assert.ok(board.innerHTML.includes(`data-action="${action}"`));
  assert.ok(board.innerHTML.includes("+ 添加本会话步骤"));
  assert.doesNotMatch(board.innerHTML + ui.boardMarkup(true), /hub-board-subagent|子代理运行中|duplicate-agent/);
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

test("native two-UUID routes use the thread UUID; drafts and project-only routes never reuse stale context", async () => {
  const calls = [];
  const ui = harness(async (action, payload) => { calls.push({ action, payload }); return { steps: [] }; });
  const environment = "6ee0c274-d218-41d6-b277-cbfc803dfbc0";
  const project = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const thread = "3972c780-3288-4f8b-9990-c6cd999f70ba";
  ui.state.context = { threadId: "stale-thread" };
  Object.assign(ui.sandbox.location, { pathname: "/", hash: `#/${environment}/${thread}`, href: `t3code://app/#/${environment}/${thread}` });
  assert.equal(ui.currentThreadId(), thread);
  ui.state.context = { threadId: thread, projectId: project, projectRoot: "/fixture", environmentId: environment };
  Object.assign(ui.state, { connected: true, projectRoot: "/fixture", threadId: ui.currentThreadId() });
  await ui.pollBoard();
  const call = calls.find((entry) => entry.action === "board:get");
  assert.equal(call.payload.threadId, thread);
  assert.equal(call.payload.strictThreadMatch, true);
  for (const hash of [`#/draft/${project}`, `#/draft/${project}/${thread}`, `#/${project}`, `#/projects/${project}`, `#/${project}/new`, `#/projects/${project}/new`, `#/workspace/${project}/new`, `#/projects/${project}/draft/${thread}`]) {
    ui.sandbox.location.hash = hash;
    assert.equal(ui.currentThreadId(), "__NEW__", `${hash} must not look up another thread`);
  }
});

test("route changes clear old plans and artifacts synchronously, request the new thread, and reject late old replies", async () => {
  const calls = [], replies = new Map();
  const ui = harness(async (action, payload) => {
    calls.push({ action, ...payload });
    if (action === "hub:getContext") return { projectRoot: "/fixture" };
    if (action === "board:get") return new Promise((resolve) => replies.set(payload.threadId, resolve));
    return {};
  });
  Object.assign(ui.state, { connected: true, projectRoot: "/fixture", threadId: "thread-a" });
  const old = ui.pollBoard();
  ui.cache.board = { steps: [{ text: "old", status: "completed" }] };
  ui.state.artifact = { content: "old artifact" };
  Object.assign(ui.sandbox.location, { pathname: "/_chat/thread-b", href: "https://fixture.test/_chat/thread-b" });
  ui.checkRoute();
  assert.equal(ui.state.threadId, "thread-b");
  assert.equal(ui.cache.board, null);
  assert.equal(ui.state.artifact, null);
  assert.match(ui.nodes.get("#t3-hub-live-board").innerHTML, /计划进度 读取中/);
  await new Promise(setImmediate);
  assert.ok(calls.some((x) => x.action === "board:get" && x.threadId === "thread-b" && x.excludeSubagentInference === true));
  replies.get("thread-b")({ steps: [{ text: "new plan" }] });
  await new Promise(setImmediate);
  replies.get("thread-a")({ steps: [{ text: "old late plan" }] });
  await old;
  assert.equal(ui.cache.board.steps[0].text, "new plan");
});

test("inline add, check and clear send the captured current thread on every mutation", async () => {
  const calls = [];
  let data = { steps: [] };
  const ui = harness(async (action, payload) => {
    calls.push({ action, payload });
    if (action === "board:update") data = { steps: payload.steps };
    if (action === "board:clear") data = { steps: [] };
    return action === "board:get" ? data : {};
  });
  Object.assign(ui.state, { connected: true, projectRoot: "/fixture", threadId: "thread-b", boardDraft: "追加步骤" });
  await ui.updateBoard(null, "add");
  assert.equal(ui.cache.board.steps[0].text, "追加步骤");
  await ui.updateBoard(null, "toggle", 0);
  assert.equal(ui.cache.board.steps[0].status, "completed");
  await ui.updateBoard(null, "clear");
  assert.equal(ui.cache.board.steps.length, 0);
  for (const call of calls) {
    assert.equal(call.payload.threadId, "thread-b");
    assert.equal(call.payload.projectRoot, "/fixture");
  }
});

for (const prefix of ["$", "￥"]) test(`${prefix} triggers a left-aligned palette and replaces the token without damaging adjacent text`, () => {
  class Textarea {
    constructor(value) { Object.assign(this, node()); this.tagName = "TEXTAREA"; this.value = value; this.selectionStart = this.selectionEnd = 9; this.isConnected = true; }
    get value() { return this._value; } set value(value) { this._value = value; }
    focus() {} setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; } dispatchEvent(event) { this.lastEvent = event; }
  }
  const editor = new Textarea(`请核验 ${prefix}mem 保留后文`);
  editor.selectionStart = editor.selectionEnd = 8;
  const ui = harness();
  ui.sandbox.HTMLTextAreaElement = Textarea;
  ui.sandbox.InputEvent = class { constructor(type, detail) { this.type = type; Object.assign(this, detail); } };
  ui.ready();
  Object.assign(ui.state, { connected: true, projectRoot: "/fixture" });
  const token = ui.composerToken(editor);
  assert.equal(token.raw, `${prefix}mem`);
  assert.equal(token.query, "mem");
  assert.equal(token.start, 4);
  const palette = ui.nodes.get("#t3-hub-slash-palette");
  const session = { editor, token, manual: false, projectRoot: "/fixture", route: "https://fixture.test/threads/thread-a|/threads/thread-a", rows: [{ type: "skill", trigger: "$memory" }], aria: {} };
  ui.setSlash(session);
  palette.hidden = false;
  ui.positionSlash();
  assert.equal(palette.style.left, "100px");
  assert.equal(palette.style.bottom, "206px", "palette bottom is exactly 6px above the visible input top");
  ui.selectSlash(0);
  assert.equal(editor.value, "请核验 $memory  保留后文");
  assert.equal(editor.lastEvent.type, "input");
  assert.equal(palette.hidden, true);
  assert.equal(ui.getSlash(), null);
});

test("plain / is native, compositionend triggers $/￥ immediately, and Escape closes the palette", () => {
  const ui = harness();
  for (const value of ["/plan", "text/plan", "a$mem", "￥bad/name", "$bad/name", "no token", ""]) {
    assert.equal(ui.composerToken({ tagName: "TEXTAREA", value, selectionStart: value.length, selectionEnd: value.length }), null, value);
  }
  for (const value of ["$", "￥", "你好\n￥技能", "text $plugin"]) {
    const token = ui.composerToken({ tagName: "TEXTAREA", value, selectionStart: value.length, selectionEnd: value.length });
    assert.ok(token, value);
  }
  assert.match(drawerSource, /listen\(document, "compositionend", \(event\) => \{ composing = false; onComposerInput\(event\); \}/);
  const editor = { focus() {} };
  const palette = ui.nodes.get("#t3-hub-slash-palette");
  palette.hidden = false;
  ui.setSlash({ editor, aria: {} });
  ui.onComposerKeydown({ key: "Escape", preventDefault() {}, stopPropagation() {} });
  assert.equal(ui.getSlash(), null);
  assert.equal(palette.hidden, true);
});

test("HUD is centered on the visible rounded surface with a 2px gap on desktop and narrow viewports", () => {
  const find = rendererSource.match(/  function findComposerSurface\([^]*?\n  \}/)[0];
  const update = rendererSource.match(/  function updateLayoutPosition\([^]*?\n  \}/)[0];
  for (const [viewportWidth, rect] of [[1280, { left: 250, top: 650, width: 640 }], [390, { left: 16, top: 650, width: 358 }]]) {
    const topbar = node(); topbar.offsetWidth = viewportWidth < 500 ? 270 : 520; topbar.offsetHeight = 27;
    const surface = node(); surface.getBoundingClientRect = () => ({ ...rect, right: rect.left + rect.width, bottom: 780, height: 130 });
    const wrapper = node(); wrapper.parentElement = surface;
    const editor = { parentElement: wrapper };
    const shell = node(); shell.querySelector = () => editor; shell.contains = () => true;
    const column = node(); column.getBoundingClientRect = () => ({ left: rect.left - 20, width: rect.width + 40 });
    const header = node(); header.getBoundingClientRect = () => ({ top: 0, height: 55, width: rect.width });
    const sandbox = { innerWidth: viewportWidth, window: { innerWidth: viewportWidth }, topbar, branchBtnText: node(), drawer: node(), popover: node(), t: (x) => x,
      document: { hidden: false, querySelector: (selector) => selector === '[data-slot="composer-shell"]' ? shell : selector === '[data-chat-column]' ? column : header },
      getComputedStyle: (el) => el === surface ? { borderRadius: "18px", backgroundColor: "rgb(255, 255, 255)", borderTopWidth: "1px", borderTopStyle: "solid" } : { borderRadius: "0px", backgroundColor: "rgba(0, 0, 0, 0)", borderTopWidth: "0px" },
      customDrawerPos: null, ensureLayoutObservers() {}, syncUiVisibility: () => true, setComposerTopSpacing() {}, lastLayoutState: {} };
    vm.runInNewContext(find + "\n" + update + "\nupdateLayoutPosition();", sandbox);
    assert.equal(Number.parseInt(topbar.style.left) + topbar.offsetWidth / 2, rect.left + rect.width / 2);
    assert.equal(Number.parseInt(topbar.style.top) + topbar.offsetHeight, rect.top - 2);
    assert.equal(topbar.style.maxWidth, `${Math.max(200, Math.min(rect.width - 16, viewportWidth - 24))}px`);
  }
  assert.doesNotMatch(update, /- 153/);
  assert.doesNotMatch(rendererSource, /padding-top:40px/);
});

test("memory list/detail, version rollback, recall and both AutoDream watermarks show local YYYY-MM-DD HH:mm", () => {
  const ui = harness();
  const timestamp = new Date(2026, 10, 15, 22, 55, 37).toISOString();
  assert.equal(ui.formatExactTime(timestamp), "2026-11-15 22:55");
  assert.equal(ui.formatExactTime(timestamp, true), "2026-11-15 22:55:37");
  assert.match(ui.formatExactTime(0), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(ui.formatExactTime(null), "");
  assert.equal(ui.formatExactTime("not a date"), "未知");
  const item = { id: "precise-time", title: "主题与排版约定", content: "纯白默认", updatedAt: timestamp, lastRecalledAt: timestamp, version: 2, history: [{ version: 1, timestamp, content: "old" }] };
  Object.assign(ui.state, { tab: "memory", selectedMemory: item.id, historyExpanded: { [`current\u0000${item.id}`]: true } });
  ui.cache.memory = { items: [item] };
  ui.renderMemoryList();
  const html = ui.nodes.get("#t3-hub-memory-list").innerHTML;
  assert.ok([...html.matchAll(/2026-11-15 22:55<\/time>/g)].length >= 4, html);
  assert.match(html, /title="2026-11-15 22:55:37"/);
  assert.ok(html.includes("最近召回"));
  assert.ok(html.includes("v1"));
  assert.match(html, /class="hub-history-list" >/, "revision history is expanded and its exact time is visible");
  ui.cache.dream = { config: { enabled: true, lastDreamAt: timestamp, lastAgentDreamAt: timestamp } };
  ui.renderDream();
  const dream = ui.nodes.get("#t3-hub-dream").innerHTML;
  assert.ok(dream.includes("最近浅睡"));
  assert.ok(dream.includes("最近深睡"));
  assert.equal([...dream.matchAll(/2026-11-15 22:55<\/time>/g)].length, 2);
});


test("a plan mutation invalidates a pre-write poll so its late reply cannot revert a checked step", async () => {
  let release;
  const ui = harness(async (action) => {
    if (action === "board:get" && !release) return new Promise((resolve) => { release = resolve; });
    if (action === "board:get") return { steps: [{ id: "step", text: "checked", status: "completed" }] };
    return {};
  });
  Object.assign(ui.state, { connected: true, projectRoot: "/fixture", threadId: "thread-a" });
  ui.cache.board = { steps: [{ id: "step", text: "checked", status: "pending" }] };
  const old = ui.pollBoard();
  await ui.updateBoard(null, "toggle", 0);
  release({ steps: [{ id: "step", text: "old poll", status: "pending" }] });
  await old;
  assert.equal(ui.cache.board.steps[0].status, "completed");
  assert.equal(ui.cache.board.steps[0].text, "checked");
});

for (const prefix of ["$", "￥"]) test(`${prefix} is detected across adjacent contenteditable text nodes`, () => {
  const ui = harness();
  const first = { nodeType: 3, data: `第一行\n${prefix}` }, second = { nodeType: 3, data: "memory" };
  const editor = { tagName: "DIV", nodeType: 1, childNodes: [first, second], contains: (node) => node === first || node === second };
  ui.sandbox.window.getSelection = () => ({ rangeCount: 1, isCollapsed: true, anchorNode: second, anchorOffset: 3 });
  const token = ui.composerToken(editor);
  assert.equal(token.query, "mem");
  assert.equal(token.raw, `${prefix}memory`);
  assert.equal(token.point(token.start).node, first);
  assert.equal(token.point(token.end).node, second);
  assert.equal(token.point(token.end).offset, 6);
});

test("native card lookup falls back past unrelated asides and accepts shadow-drawn borders", () => {
  const { ui, sidebar, card, label } = relationFixture();
  sidebar.querySelectorAll = () => [];
  ui.sandbox.document.body.querySelectorAll = () => [label];
  ui.setStyle((element) => element === card ? { visibility: "visible", borderRadius: "14px", borderTopWidth: "0px", boxShadow: "0 0 0 1px rgb(226, 232, 240)" } : { visibility: "visible", borderRadius: "0px" });
  assert.equal(ui.findSessionRelationsCard().card, card);
});

test("[P1] unscoped drafts are blocked; verified project drafts stay strictly isolated", async () => {
  const calls = [];
  let boardData = { steps: [] };
  const ui = harness(async (action, payload) => {
    calls.push({ action, payload });
    if (action === "board:get") return boardData;
    if (action === "board:update") { boardData = { steps: payload.steps }; return {}; }
    if (action === "board:clear") { boardData = { steps: [] }; return {}; }
    return {};
  });
  for (const [pathname, hash] of [["/threads/new", ""], ["/_chat/new", ""], ["/threads/NEW", ""], ["/", "#/threads/new"]]) {
    Object.assign(ui.sandbox.location, { pathname, hash, href: `https://fixture.test${pathname}${hash}` });
    assert.equal(ui.currentThreadId(), "__NEW__", `${pathname}${hash}`);
  }
  Object.assign(ui.state, { connected: true, projectRoot: "/fixture", threadId: "__NEW__", boardDraft: "草稿步骤" });
  ui.cache.board = { steps: [] };
  calls.length = 0;
  await ui.pollBoard(); await ui.updateBoard(null, "add"); await ui.updateBoard(null, "clear");
  assert.equal(calls.length, 0, "unscoped drafts must not use a fallback project");
  const projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  Object.assign(ui.sandbox.location, { pathname: "/", hash: `#/projects/${projectId}/new`, href: `t3code://app/#/projects/${projectId}/new` });
  ui.state.context = { threadId: "__NEW__", projectId, projectRoot: "/fixture", draftProjectVerified: true };
  await ui.pollBoard();
  const pollCall = calls.find((x) => x.action === "board:get");
  assert.equal(pollCall.payload.threadId, "__NEW__");
  assert.equal(pollCall.payload.strictThreadMatch, true);
  assert.equal(pollCall.payload.excludeSubagentInference, true);
  calls.length = 0;
  boardData = { steps: [] };
  await ui.updateBoard(null, "add");
  const updateCall = calls.find((x) => x.action === "board:update");
  assert.equal(updateCall.payload.threadId, "__NEW__");
  assert.equal(updateCall.payload.strictThreadMatch, true);
  assert.equal(updateCall.payload.projectRoot, "/fixture");
  calls.length = 0;
  await ui.updateBoard(null, "clear");
  const clearCall = calls.find((x) => x.action === "board:clear");
  assert.equal(clearCall.payload.threadId, "__NEW__");
  assert.equal(clearCall.payload.strictThreadMatch, true);
});

test("[P1] clear on thread-a sends only that threadId, never a bare projectRoot wipe", async () => {
  const calls = [];
  const ui = harness(async (action, payload) => {
    calls.push({ action, payload });
    return action === "board:get" ? { steps: [] } : {};
  });
  Object.assign(ui.state, { connected: true, projectRoot: "/fixture", threadId: "thread-a" });
  ui.cache.board = { steps: [{ id: "1", text: "a", status: "pending" }] };
  await ui.updateBoard(null, "clear");
  const clearCall = calls.find((x) => x.action === "board:clear");
  assert.equal(clearCall.payload.threadId, "thread-a", "clear carries the exact thread, not undefined/project-only");
  assert.equal(clearCall.payload.projectRoot, "/fixture");
  assert.equal(clearCall.payload.strictThreadMatch, true);
  assert.ok(clearCall.payload.threadId, "threadId present so backend cannot widen to sibling threads by projectRoot");
});


test("four core navigation entries exclude the plugin market and shortcuts", () => {
  const tabs = drawerSource.match(/const tabs = (\[\["memory"[^;]+);/)[1];
  assert.deepEqual([...tabs.matchAll(/\["(memory|skills|subagents|settings)"/g)].map(x => x[1]), ["memory", "skills", "subagents", "settings"]);
  assert.doesNotMatch(drawerSource, /function (?:renderPlugins|renderPluginList|installMarketplace|pluginItems)\b/);
  const slash = drawerSource.slice(drawerSource.indexOf("function scopedSlashItems"), drawerSource.indexOf("function nativeSlashMenu"));
  assert.doesNotMatch(slash, /type: "plugin"/);
  const palette = drawerSource.slice(drawerSource.indexOf("function renderSlash"), drawerSource.indexOf("function setSlashActive"));
  assert.doesNotMatch(palette, /\["plugin"/);
  // The approved card catalog, scoped artifact preview and host/rules controls
  // expand the former 300 KB navigation-only budget. Keep a bounded allowance
  // without minifying maintained source or weakening the behavioral checks.
  assert.ok(Buffer.byteLength(drawerSource) < 350000);
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
