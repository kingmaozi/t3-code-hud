"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawn, spawnSync } = require("node:child_process");
const { webcrypto } = require("node:crypto");
const { TextEncoder } = require("node:util");

const {
  createMemoryAccessManager,
  RUNTIME_HINTS_FILE,
  RUNTIME_HINTS_SCOPE,
  RUNTIME_HINTS_MAX_LENGTH,
  RUNTIME_HINTS_TRUNCATED_TOOLS,
  RUNTIME_HINTS_LOCK_FILE,
  RUNTIME_HINTS_LOCK_TIMEOUT_MS,
  DEFAULT_T3_RUNTIME_HINTS,
  getT3RuntimeHints,
  setT3RuntimeHints,
} = require("../src/hub-memory-access.cjs");
const { assembleRenderer } = require("../src/hud-release.cjs");

const REPO = path.resolve(__dirname, "..");
const ROUTER_PATH = path.join(REPO, "bin", "t3-mcp-router");
const MEMORY_ACCESS_PATH = path.join(REPO, "src", "hub-memory-access.cjs");
const drawerSource = fs.readFileSync(path.join(REPO, "src", "hub-drawer-ui.js"), "utf8");
const rendererSource = fs.readFileSync(path.join(REPO, "src", "renderer-ui.js"), "utf8");

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3-runtime-hints-")));
  const homeDir = path.join(root, "home");
  const hubDir = path.join(homeDir, ".t3", "hub");
  const userDataDir = path.join(homeDir, ".t3", "userdata");
  fs.mkdirSync(homeDir, { recursive: true });
  return { root, homeDir, hubDir, userDataDir };
}

function sanitizedRouterEnv(f, extraEnv = {}) {
  const env = { ...process.env };
  for (const key of [
    "T3_ACP_MCP_NODE",
    "T3_ACP_MCP_ENTRYPOINT",
    "T3_ACP_MCP_ENDPOINT",
    "T3CODE_THREAD_ID",
    "T3_THREAD_ID",
    "T3CODE_HOME",
    "T3_CODE_ENV",
    "ANTIGRAVITY_SOURCE_METADATA",
    "CODEX_HOME",
    "T3_PROJECT_ROOT",
    "T3_HUB_MEMORY_ACCESS",
    "T3_MEMORY_VAULT",
  ]) {
    delete env[key];
  }
  return {
    ...env,
    HOME: f.homeDir,
    T3_HUB_DIR: f.hubDir,
    ...extraEnv,
  };
}

function runRouterBatch(f, args, requests, extraEnv = {}) {
  const input = requests.map((req) => JSON.stringify(req)).join("\n") + "\n";
  const res = spawnSync(process.execPath, [ROUTER_PATH, ...args], {
    input,
    encoding: "utf8",
    env: sanitizedRouterEnv(f, extraEnv),
    timeout: 10000,
  });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  return res.stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function spawnSetHintsWorker(f, payload) {
  const script = `
    const { setT3RuntimeHints } = require(${JSON.stringify(MEMORY_ACCESS_PATH)});
    const res = setT3RuntimeHints(${JSON.stringify(payload)}, {
      homeDir: ${JSON.stringify(f.homeDir)},
      hubDir: ${JSON.stringify(f.hubDir)},
      userDataDir: ${JSON.stringify(f.userDataDir)},
    });
    process.stdout.write(JSON.stringify(res));
    process.exit(res.ok ? 0 : 1);
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script], {
      env: sanitizedRouterEnv(f),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, out, err, json: out ? JSON.parse(out) : null });
    });
  });
}

function stubNode() {
  const classes = new Set(), attrs = new Map(), properties = new Map();
  return {
    innerHTML: "",
    textContent: "",
    hidden: false,
    dataset: {},
    children: [],
    style: {
      setProperty: (key, value) => properties.set(key, value),
      getPropertyValue: (key) => properties.get(key) || "",
      removeProperty: (key) => properties.delete(key),
    },
    setAttribute: (key, value) => attrs.set(key, String(value)),
    getAttribute: (key) => attrs.get(key) ?? null,
    removeAttribute: (key) => attrs.delete(key),
    getClientRects: () => [{ width: 200, height: 30 }],
    getBoundingClientRect: () => ({ left: 100, right: 700, top: 600, bottom: 720, width: 600, height: 120 }),
    appendChild(child) { child.parentElement = this; this.children.push(child); this.lastElementChild = child; },
    closest: () => null,
    matches: () => false,
    addEventListener() {},
    removeEventListener() {},
    remove() { this.removed = true; },
    classList: {
      add: (s) => classes.add(s),
      remove: (s) => classes.delete(s),
      toggle(s, on) { on ? classes.add(s) : classes.delete(s); },
      contains: (s) => classes.has(s),
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    contains: () => false,
  };
}

function drawerHarness(rpc = async () => ({}), environment = {}) {
  const nodes = new Map();
  const root = stubNode(), content = stubNode();
  root.contains = () => true;
  root.querySelector = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, stubNode());
    return nodes.get(selector);
  };
  const sandbox = {
    window: { dispatchEvent() {}, ...environment.window },
    document: {
      body: null,
      hidden: false,
      activeElement: null,
      querySelectorAll: () => [],
      querySelector: () => null,
      getElementById: () => null,
      documentElement: { lang: "zh" },
      ...environment.document,
    },
    location: { pathname: "/threads/thread-a", href: "https://fixture.test/threads/thread-a", hash: "" },
    innerWidth: 1280,
    innerHeight: 800,
    getComputedStyle: () => ({ visibility: "visible" }),
    CustomEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
    localStorage: { getItem: () => null, setItem() {} },
    setTimeout: () => 1,
    clearTimeout() {},
    console,
    crypto: webcrypto,
    TextEncoder,
  };
  const expose = `if (opts.__testHarness) {
    root = opts.root; content = opts.content;
    settingsPanel = root.querySelector("#t3-hub-settings-panel"); settingsPanel.querySelector = root.querySelector;
    handle = null; titleControls = root.querySelector("#t3-hub-title-controls"); memoryHandle = root.querySelector("#t3-hub-memory-handle"); memoryToggle = root.querySelector("#t3-hub-memory-toggle"); planHandle = root.querySelector("#t3-hub-plan-handle"); drawer = root.querySelector("#t3-hub-drawer"); liveBoard = root.querySelector("#t3-hub-live-board");
    return {
      state, cache, errors, onInput, onChange, onClick, request, esc, memorySetupPrompt,
      setHubSettingsOpen, renderHubSettingsPanel, ensureMemorySettingsLoaded,
      refreshMemoryRuntimeHints, renderMemoryRuntimeHints, toggleMemoryRuntimeHintsEnabled, saveMemoryRuntimeHints, resetMemoryRuntimeHints,
      copyMemorySetupPrompt,
      destroy: () => { disposed = true; liveBoard?.remove(); titleControls?.remove(); planHandle?.remove(); }
    };
  }`;
  vm.runInNewContext(drawerSource.replace("    const api = {", expose + "\n    const api = {"), sandbox, { filename: "hub-drawer-ui.js" });
  const ui = sandbox.window.__t3MountSidecarHub({ __testHarness: true, root, content, hubRpc: rpc });
  if (!sandbox.document.body) sandbox.document.body = stubNode();
  return { ...ui, root, content, nodes, sandbox };
}

test("persistence: defaults, 0600 atomic write, partial update, reset, and strict validation", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));

  assert.equal(DEFAULT_T3_RUNTIME_HINTS.version, 1);
  assert.equal(DEFAULT_T3_RUNTIME_HINTS.enabled, true);
  assert.equal(DEFAULT_T3_RUNTIME_HINTS.scope, RUNTIME_HINTS_SCOPE);
  assert.match(DEFAULT_T3_RUNTIME_HINTS.planUpdateHint, /plan_update\(title, steps:\[\{text,status\}\]\)/);
  assert.match(DEFAULT_T3_RUNTIME_HINTS.acp48kFallbackHint, /acp-mcp-call/);
  assert.deepEqual(RUNTIME_HINTS_TRUNCATED_TOOLS, [
    "delegate_task",
    "html_render",
    "t3_thread_launch",
    "schedule_task",
    "t3_project_update",
  ]);

  const initial = getT3RuntimeHints({ homeDir: f.homeDir, hubDir: f.hubDir, userDataDir: f.userDataDir });
  assert.equal(initial.ok, true);
  assert.equal(initial.trusted, true);
  assert.equal(initial.corrupted, false);
  assert.equal(initial.enabled, true);
  assert.equal(initial.scope, "t3-code-only");
  assert.equal(initial.persisted, false);
  assert.equal(initial.fallback, false);
  assert.equal(initial.planUpdateHint, DEFAULT_T3_RUNTIME_HINTS.planUpdateHint);
  assert.equal(initial.acp48kFallbackHint, DEFAULT_T3_RUNTIME_HINTS.acp48kFallbackHint);
  assert.equal(fs.existsSync(f.hubDir), false, "reading missing hints must not create files");

  const updated = setT3RuntimeHints(
    {
      enabled: false,
      planUpdateHint: "  custom plan hint  ",
      acp48kFallbackHint: "",
    },
    { homeDir: f.homeDir, hubDir: f.hubDir, userDataDir: f.userDataDir }
  );
  assert.equal(updated.ok, true);
  assert.equal(updated.trusted, true);
  assert.equal(updated.enabled, false);
  assert.equal(updated.planUpdateHint, "custom plan hint");
  assert.equal(updated.acp48kFallbackHint, "");
  assert.equal(updated.persisted, true);
  assert.ok(typeof updated.updatedAt === "string" && updated.updatedAt.length > 0);

  const filePath = path.join(f.hubDir, RUNTIME_HINTS_FILE);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  const disk = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(disk.version, 1);
  assert.equal(disk.scope, "t3-code-only");
  assert.equal(disk.enabled, false);
  assert.equal(disk.planUpdateHint, "custom plan hint");
  assert.equal(disk.acp48kFallbackHint, "");

  // Partial update keeps custom hints intact
  const reenabled = setT3RuntimeHints({ enabled: true }, { homeDir: f.homeDir, hubDir: f.hubDir, userDataDir: f.userDataDir });
  assert.equal(reenabled.ok, true);
  assert.equal(reenabled.enabled, true);
  assert.equal(reenabled.planUpdateHint, "custom plan hint");
  assert.equal(reenabled.acp48kFallbackHint, "");

  // Max length boundary (2000 ok, 2001 rejected)
  const exact2000 = "x".repeat(RUNTIME_HINTS_MAX_LENGTH);
  const ok2000 = setT3RuntimeHints({ planUpdateHint: exact2000 }, { homeDir: f.homeDir, hubDir: f.hubDir, userDataDir: f.userDataDir });
  assert.equal(ok2000.ok, true);
  assert.equal(ok2000.planUpdateHint.length, RUNTIME_HINTS_MAX_LENGTH);

  const over2001 = setT3RuntimeHints({ planUpdateHint: exact2000 + "y" }, { homeDir: f.homeDir, hubDir: f.hubDir, userDataDir: f.userDataDir });
  assert.equal(over2001.ok, false);
  assert.equal(over2001.error, "planUpdateHint_too_long");

  const overAcp = setT3RuntimeHints({ acp48kFallbackHint: "z".repeat(2001) }, { homeDir: f.homeDir, hubDir: f.hubDir, userDataDir: f.userDataDir });
  assert.equal(overAcp.ok, false);
  assert.equal(overAcp.error, "acp48kFallbackHint_too_long");

  const badType = setT3RuntimeHints({ enabled: "true" }, { homeDir: f.homeDir, hubDir: f.hubDir, userDataDir: f.userDataDir });
  assert.equal(badType.ok, false);
  assert.equal(badType.error, "enabled_must_be_boolean");

  // Previous 2000-char value remains untouched after invalid writes
  assert.equal(getT3RuntimeHints({ homeDir: f.homeDir, hubDir: f.hubDir, userDataDir: f.userDataDir }).planUpdateHint, exact2000);

  // Reset restores default hints
  const reset = setT3RuntimeHints({ reset: true }, { homeDir: f.homeDir, hubDir: f.hubDir, userDataDir: f.userDataDir });
  assert.equal(reset.ok, true);
  assert.equal(reset.enabled, true);
  assert.equal(reset.planUpdateHint, DEFAULT_T3_RUNTIME_HINTS.planUpdateHint);
  assert.equal(reset.acp48kFallbackHint, DEFAULT_T3_RUNTIME_HINTS.acp48kFallbackHint);
  assert.equal(reset.isDefault, true);
});

test("fail-closed security: corrupted config, 0o666 permissions, NUL chars, and symlinks never default-enable", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  fs.mkdirSync(f.hubDir, { recursive: true });
  const filePath = path.join(f.hubDir, RUNTIME_HINTS_FILE);

  // 1. Broken JSON -> fail-closed (enabled: false, trusted: false, corrupted: true)
  fs.writeFileSync(filePath, "{broken json", { mode: 0o600 });
  const corrupt = getT3RuntimeHints({ homeDir: f.homeDir, hubDir: f.hubDir, userDataDir: f.userDataDir });
  assert.equal(corrupt.ok, true);
  assert.equal(corrupt.trusted, false);
  assert.equal(corrupt.corrupted, true);
  assert.equal(corrupt.fallback, true);
  assert.equal(corrupt.enabled, false);
  assert.equal(corrupt.warning, "invalid_json");

  // 2. Partial schema corruption with enabled:false OR enabled:true -> fail-closed enabled:false
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, enabled: false, scope: "t3-code-only", planUpdateHint: 123, acp48kFallbackHint: "ok" }), { mode: 0o600 });
  const disabledCorrupt = getT3RuntimeHints({ homeDir: f.homeDir, hubDir: f.hubDir, userDataDir: f.userDataDir });
  assert.equal(disabledCorrupt.trusted, false);
  assert.equal(disabledCorrupt.corrupted, true);
  assert.equal(disabledCorrupt.enabled, false);

  fs.writeFileSync(filePath, JSON.stringify({ version: 1, enabled: true, scope: "t3-code-only", planUpdateHint: 123, acp48kFallbackHint: "ok" }), { mode: 0o600 });
  const enabledCorrupt = getT3RuntimeHints({ homeDir: f.homeDir, hubDir: f.hubDir, userDataDir: f.userDataDir });
  assert.equal(enabledCorrupt.trusted, false);
  assert.equal(enabledCorrupt.corrupted, true);
  assert.equal(enabledCorrupt.enabled, false, "must fail closed instead of falling back to enabled:true");

  // Partial update on untrusted file must fail closed rather than merge onto corrupted file
  const mergeBlocked = setT3RuntimeHints({ enabled: true }, { homeDir: f.homeDir, hubDir: f.hubDir, userDataDir: f.userDataDir });
  assert.equal(mergeBlocked.ok, false);

  // 3. Over-permissive 0o666 permissions -> fail-closed
  fs.writeFileSync(
    filePath,
    JSON.stringify({ version: 1, enabled: true, scope: "t3-code-only", planUpdateHint: "valid", acp48kFallbackHint: "valid" }),
    { mode: 0o600 }
  );
  fs.chmodSync(filePath, 0o666);
  const permBad = getT3RuntimeHints({ homeDir: f.homeDir, hubDir: f.hubDir, userDataDir: f.userDataDir });
  assert.equal(permBad.trusted, false);
  assert.equal(permBad.corrupted, true);
  assert.equal(permBad.enabled, false);
  assert.equal(permBad.warning, "unsafe_permissions");

  // Explicit reset rewrites clean 0o600 file
  const repaired = setT3RuntimeHints({ reset: true }, { homeDir: f.homeDir, hubDir: f.hubDir, userDataDir: f.userDataDir });
  assert.equal(repaired.ok, true);
  assert.equal(repaired.trusted, true);
  assert.equal(repaired.corrupted, false);
  assert.equal(repaired.fallback, false);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);

  // 4. Symlinked target file must fail-closed on read and refuse write
  const outside = path.join(f.root, "outside.json");
  fs.writeFileSync(outside, JSON.stringify({ version: 1, enabled: true, scope: "t3-code-only", planUpdateHint: "evil", acp48kFallbackHint: "evil" }));
  fs.rmSync(filePath);
  fs.symlinkSync(outside, filePath);

  const symRead = getT3RuntimeHints({ homeDir: f.homeDir, hubDir: f.hubDir, userDataDir: f.userDataDir });
  assert.equal(symRead.trusted, false);
  assert.equal(symRead.corrupted, true);
  assert.equal(symRead.enabled, false);

  const symWrite = setT3RuntimeHints({ reset: true }, { homeDir: f.homeDir, hubDir: f.hubDir, userDataDir: f.userDataDir });
  assert.equal(symWrite.ok, false);
  assert.match(fs.readFileSync(outside, "utf8"), /evil/);
});

test("concurrent save safety: single-pass CAS refuses silent overwrite + cross-process lock preserves edits from both processes", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));

  setT3RuntimeHints(
    { enabled: true, planUpdateHint: "INITIAL_PLAN", acp48kFallbackHint: "INITIAL_ACP" },
    { homeDir: f.homeDir, hubDir: f.hubDir, userDataDir: f.userDataDir }
  );

  // 1. A non-locking external writer races inside the critical section -> explicit error, never a silent overwrite
  let injectedConcurrentWrite = false;
  const casManager = createMemoryAccessManager({
    homeDir: f.homeDir,
    hubDir: f.hubDir,
    userDataDir: f.userDataDir,
    now: () => {
      if (!injectedConcurrentWrite) {
        injectedConcurrentWrite = true;
        const p = path.join(f.hubDir, RUNTIME_HINTS_FILE);
        const cur = JSON.parse(fs.readFileSync(p, "utf8"));
        cur.planUpdateHint = "CONCURRENT_B_PLAN";
        fs.writeFileSync(p, JSON.stringify(cur, null, 2) + "\n", { mode: 0o600 });
      }
      return Date.now();
    },
  });
  const casResult = casManager.setT3RuntimeHints({ enabled: false });
  assert.equal(casResult.ok, false);
  assert.equal(casResult.error, "concurrent_change");
  const afterCas = getT3RuntimeHints({ homeDir: f.homeDir, hubDir: f.hubDir, userDataDir: f.userDataDir });
  assert.equal(afterCas.planUpdateHint, "CONCURRENT_B_PLAN", "concurrent edit must survive");
  assert.equal(afterCas.enabled, true, "conflicting write must not be applied");

  // 2. Real dual-process concurrent writes across multiple rounds
  for (let round = 0; round < 5; round += 1) {
    setT3RuntimeHints(
      { enabled: true, planUpdateHint: `BASE_${round}`, acp48kFallbackHint: `ACP_BASE_${round}` },
      { homeDir: f.homeDir, hubDir: f.hubDir, userDataDir: f.userDataDir }
    );
    const [resA, resB] = await Promise.all([
      spawnSetHintsWorker(f, { enabled: false }),
      spawnSetHintsWorker(f, { planUpdateHint: `PROC_B_${round}`, acp48kFallbackHint: `ACP_B_${round}` }),
    ]);
    assert.equal(resA.code, 0, resA.err);
    assert.equal(resB.code, 0, resB.err);
    assert.equal(resA.json.ok, true);
    assert.equal(resB.json.ok, true);
    const finalState = getT3RuntimeHints({ homeDir: f.homeDir, hubDir: f.hubDir, userDataDir: f.userDataDir });
    assert.equal(finalState.enabled, false, `round ${round}: enabled=false must survive concurrent text save`);
    assert.equal(finalState.planUpdateHint, `PROC_B_${round}`, `round ${round}: text edit must survive concurrent toggle`);
    assert.equal(finalState.acp48kFallbackHint, `ACP_B_${round}`);
  }
});

test("router isT3CodeRuntime strictly isolates T3 Code from standalone agents", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const { isT3CodeRuntime } = require(ROUTER_PATH);

  // Non-T3-Code environments (must all be false)
  assert.equal(isT3CodeRuntime({}), false);
  assert.equal(isT3CodeRuntime(null), false);
  assert.equal(isT3CodeRuntime({ HOME: f.homeDir, T3CODE_HOME: f.userDataDir }), false, "T3CODE_HOME alone must not match");
  assert.equal(isT3CodeRuntime({ HOME: f.homeDir, T3_CODE_ENV: "false" }), false);
  assert.equal(isT3CodeRuntime({ HOME: f.homeDir, T3_CODE_ENV: "0" }), false);
  assert.equal(isT3CodeRuntime({ HOME: f.homeDir, T3_CODE_ENV: "custom" }), false);
  assert.equal(isT3CodeRuntime({ HOME: f.homeDir, T3_ACP_MCP_ENDPOINT: "https://example.com/mcp" }), false);
  assert.equal(isT3CodeRuntime({ HOME: f.homeDir, T3_ACP_MCP_ENDPOINT: "/tmp/non-url" }), false);
  assert.equal(isT3CodeRuntime({ HOME: f.homeDir, T3CODE_THREAD_ID: "   " }), false);
  assert.equal(isT3CodeRuntime({ HOME: f.homeDir, CODEX_HOME: path.join(f.homeDir, ".codex") }), false);
  assert.equal(isT3CodeRuntime({ HOME: f.homeDir, CODEX_HOME: "/tmp/unrelated/.t3/userdata/providers/codex" }), false);
  assert.equal(isT3CodeRuntime({ HOME: f.homeDir, CODEX_HOME: path.join(f.homeDir, ".t3", "userdata", "providers") }), false);
  assert.equal(isT3CodeRuntime({ HOME: f.homeDir, CODEX_HOME: path.join(f.homeDir, ".t3", "userdata", "providers", "codex", "..", "..", "other") }), false);
  assert.equal(isT3CodeRuntime({ HOME: f.homeDir, CODEX_HOME: path.join(f.homeDir, ".t3", "userdata", "providers-fake", "codex") }), false);
  assert.equal(isT3CodeRuntime({ HOME: f.homeDir, ANTIGRAVITY_SOURCE_METADATA: path.join(f.homeDir, ".gemini", "antigravity") }), false);
  assert.equal(isT3CodeRuntime({
    HOME: f.homeDir,
    ANTIGRAVITY_SOURCE_METADATA: JSON.stringify({ [path.join(f.homeDir, ".t3", "userdata", "providers", "antigravity", "abc")]: "key-only" }),
  }), false, "JSON keys containing provider paths must not match");
  assert.equal(isT3CodeRuntime({
    HOME: f.homeDir,
    ANTIGRAVITY_SOURCE_METADATA: JSON.stringify({ note: `docs mention ${path.join(f.homeDir, ".t3", "userdata", "providers", "antigravity", "abc")}` }),
  }), false, "prose/non-path fields must not match");
  assert.equal(isT3CodeRuntime({
    HOME: f.homeDir,
    ANTIGRAVITY_SOURCE_METADATA: `${path.join(f.homeDir, ".t3", "userdata", "providers", "antigravity", "abc")} prose suffix`,
  }), false);

  // Positive T3 Code runtime signals
  fs.mkdirSync(path.join(f.userDataDir, "providers", "codex"), { recursive: true });
  fs.mkdirSync(path.join(f.userDataDir, "providers", "antigravity", "abc", "config"), { recursive: true });
  assert.equal(isT3CodeRuntime({ HOME: f.homeDir, T3_ACP_MCP_NODE: "/Applications/T3.app/Contents/MacOS/Electron" }), true);
  assert.equal(isT3CodeRuntime({ HOME: f.homeDir, T3_ACP_MCP_ENDPOINT: "http://127.0.0.1:4321/mcp" }), true);
  assert.equal(isT3CodeRuntime({ HOME: f.homeDir, T3_ACP_MCP_ENDPOINT: "http://localhost:4321" }), true);
  assert.equal(isT3CodeRuntime({ HOME: f.homeDir, T3CODE_THREAD_ID: "thread-123" }), true);
  assert.equal(isT3CodeRuntime({ HOME: f.homeDir, T3_THREAD_ID: "thread-456" }), true);
  assert.equal(isT3CodeRuntime({ HOME: f.homeDir, T3_CODE_ENV: "1" }), true);
  assert.equal(isT3CodeRuntime({ HOME: f.homeDir, T3_CODE_ENV: "true" }), true);
  assert.equal(isT3CodeRuntime({ HOME: f.homeDir, CODEX_HOME: path.join(f.userDataDir, "providers", "codex") }), true);
  assert.equal(isT3CodeRuntime({ HOME: f.homeDir, ANTIGRAVITY_SOURCE_METADATA: path.join(f.userDataDir, "providers", "antigravity", "abc", "config") }), true);
  assert.equal(isT3CodeRuntime({
    HOME: f.homeDir,
    ANTIGRAVITY_SOURCE_METADATA: JSON.stringify({ configDir: path.join(f.userDataDir, "providers", "antigravity", "abc") }),
  }), true);
});

test("t3-mcp-router injects only in verified T3 Code and fails closed on untrusted files (including fallback)", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));

  const reqs = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory_status", arguments: {} } },
  ];

  // 1. T3 Code runtime + default config -> both injected
  const t3Default = runRouterBatch(f, ["--memory-only"], reqs, { T3_ACP_MCP_NODE: "/Applications/T3.app/Contents/MacOS/Electron" });
  assert.match(t3Default[0].result.instructions, /plan_update/);
  assert.match(t3Default[0].result.instructions, /acp-mcp-call/);
  const statusDefault = JSON.parse(t3Default[1].result.content[0].text);
  assert.equal(statusDefault.t3RuntimeHints.scope, "t3-code-only");
  assert.deepEqual(statusDefault.t3RuntimeHints.truncatedTools, RUNTIME_HINTS_TRUNCATED_TOOLS);
  assert.equal(fs.existsSync(path.join(f.hubDir, "memory")), false);

  // 2. Spoofed / non-T3-Code signals must NOT emit instructions or t3RuntimeHints
  for (const nonT3Env of [
    { CODEX_HOME: path.join(f.homeDir, ".codex") },
    { T3CODE_HOME: f.userDataDir },
    { T3_CODE_ENV: "false" },
    { ANTIGRAVITY_SOURCE_METADATA: JSON.stringify({ [path.join(f.userDataDir, "providers", "agy", "x")]: "k" }) },
  ]) {
    const out = runRouterBatch(f, ["--memory-only"], reqs, nonT3Env);
    assert.equal(Object.hasOwn(out[0].result, "instructions"), false);
    assert.equal(Object.hasOwn(JSON.parse(out[1].result.content[0].text), "t3RuntimeHints"), false);
  }

  // 3. Partial non-empty field + both empty + disabled
  setT3RuntimeHints({ enabled: true, planUpdateHint: "ONLY_PLAN", acp48kFallbackHint: "" }, { homeDir: f.homeDir, hubDir: f.hubDir, userDataDir: f.userDataDir });
  const onlyPlan = runRouterBatch(f, ["--memory-only"], reqs, { T3_THREAD_ID: "thread-1" });
  assert.match(onlyPlan[0].result.instructions, /ONLY_PLAN/);
  assert.deepEqual(JSON.parse(onlyPlan[1].result.content[0].text).t3RuntimeHints, { scope: "t3-code-only", planUpdate: "ONLY_PLAN" });

  setT3RuntimeHints({ enabled: true, planUpdateHint: "", acp48kFallbackHint: "" }, { homeDir: f.homeDir, hubDir: f.hubDir, userDataDir: f.userDataDir });
  const bothEmpty = runRouterBatch(f, ["--memory-only"], reqs, { T3_THREAD_ID: "thread-1" });
  assert.equal(Object.hasOwn(bothEmpty[0].result, "instructions"), false);
  assert.equal(Object.hasOwn(JSON.parse(bothEmpty[1].result.content[0].text), "t3RuntimeHints"), false);

  setT3RuntimeHints({ enabled: false, planUpdateHint: "HIDDEN", acp48kFallbackHint: "HIDDEN" }, { homeDir: f.homeDir, hubDir: f.hubDir, userDataDir: f.userDataDir });
  const disabled = runRouterBatch(f, ["--memory-only"], reqs, { T3_ACP_MCP_NODE: "/Applications/T3.app/Contents/MacOS/Electron" });
  assert.equal(Object.hasOwn(disabled[0].result, "instructions"), false);
  assert.equal(Object.hasOwn(JSON.parse(disabled[1].result.content[0].text), "t3RuntimeHints"), false);

  // 4. Corrupted / 0o666 / NUL config -> fail-closed (router must NOT fall back to enabled:true!)
  const hintsFile = path.join(f.hubDir, RUNTIME_HINTS_FILE);
  fs.writeFileSync(hintsFile, "not-json", { mode: 0o600 });
  const corruptRouter = runRouterBatch(f, [], reqs, { T3_ACP_MCP_NODE: "/Applications/T3.app/Contents/MacOS/Electron" });
  assert.equal(Object.hasOwn(corruptRouter[0].result, "instructions"), false);
  assert.equal(Object.hasOwn(JSON.parse(corruptRouter[1].result.content[0].text), "t3RuntimeHints"), false);

  fs.writeFileSync(hintsFile, JSON.stringify({ version: 1, enabled: true, scope: "t3-code-only", planUpdateHint: "ok", acp48kFallbackHint: "ok" }), { mode: 0o600 });
  fs.chmodSync(hintsFile, 0o666);
  const permRouter = runRouterBatch(f, [], reqs, { T3_ACP_MCP_NODE: "/Applications/T3.app/Contents/MacOS/Electron" });
  assert.equal(Object.hasOwn(permRouter[0].result, "instructions"), false);
  assert.equal(Object.hasOwn(JSON.parse(permRouter[1].result.content[0].text), "t3RuntimeHints"), false);

  // 5. Fallback reader parity (simulate older module without getT3RuntimeHints)
  const stubAccessPath = path.join(f.root, "legacy-memory-access.cjs");
  fs.writeFileSync(stubAccessPath, `module.exports = { createMemoryAccessManager: () => ({ readMemoryOnlyStatus: () => ({ ok: true, enabled: true, state: "enabled", serverVersion: "1", vaultAvailable: false }) }) };`);

  // 0o666 rejected in fallback
  const fallbackPerm = runRouterBatch(f, ["--memory-only"], reqs, {
    T3_ACP_MCP_NODE: "/Applications/T3.app/Contents/MacOS/Electron",
    T3_HUB_MEMORY_ACCESS: stubAccessPath,
  });
  assert.equal(Object.hasOwn(fallbackPerm[0].result, "instructions"), false);

  // NUL character rejected in fallback
  fs.chmodSync(hintsFile, 0o600);
  fs.writeFileSync(hintsFile, JSON.stringify({ version: 1, enabled: true, scope: "t3-code-only", planUpdateHint: "bad\0hint", acp48kFallbackHint: "ok" }), { mode: 0o600 });
  const fallbackNul = runRouterBatch(f, ["--memory-only"], reqs, {
    T3_ACP_MCP_NODE: "/Applications/T3.app/Contents/MacOS/Electron",
    T3_HUB_MEMORY_ACCESS: stubAccessPath,
  });
  assert.equal(Object.hasOwn(fallbackNul[0].result, "instructions"), false);

  // Valid 0o600 works in fallback
  fs.writeFileSync(hintsFile, JSON.stringify({ version: 1, enabled: true, scope: "t3-code-only", planUpdateHint: "FALLBACK_OK", acp48kFallbackHint: "" }), { mode: 0o600 });
  const fallbackValid = runRouterBatch(f, ["--memory-only"], reqs, {
    T3_ACP_MCP_NODE: "/Applications/T3.app/Contents/MacOS/Electron",
    T3_HUB_MEMORY_ACCESS: stubAccessPath,
  });
  assert.match(fallbackValid[0].result.instructions, /FALLBACK_OK/);

  // Symlinked parent directory rejected by fallback
  const symParent = path.join(f.root, "sym-hub");
  fs.symlinkSync(f.hubDir, symParent);
  const { readT3RuntimeHintsFallback } = require(ROUTER_PATH);
  const symRes = readT3RuntimeHintsFallback(path.join(symParent, RUNTIME_HINTS_FILE));
  assert.equal(symRes.trusted, false);
  assert.equal(symRes.enabled, false);
  assert.equal(symRes.corrupted, true);
});

test("backend RPC memory:runtimeHints:get/set, renderer allowlist, and assembleRenderer syntax", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const previous = Object.fromEntries(["NODE_ENV", "HOME", "T3_HUB_DIR", "T3CODE_HOME"].map((k) => [k, process.env[k]]));
  process.env.NODE_ENV = "test";
  process.env.HOME = f.homeDir;
  process.env.T3_HUB_DIR = f.hubDir;
  process.env.T3CODE_HOME = f.userDataDir;

  try {
    const backend = require("../src/backend.cjs");
    const initial = await backend.hubCall("memory:runtimeHints:get");
    assert.equal(initial.ok, true);
    assert.equal(initial.enabled, true);
    assert.equal(initial.scope, "t3-code-only");

    const updated = await backend.hubCall("memory:runtimeHints:set", {
      enabled: true,
      planUpdateHint: "RPC_PLAN",
      acp48kFallbackHint: "RPC_ACP",
    });
    assert.equal(updated.ok, true);
    assert.equal(updated.planUpdateHint, "RPC_PLAN");
    assert.equal(updated.acp48kFallbackHint, "RPC_ACP");

    const tooLong = await backend.hubCall("memory:runtimeHints:set", { planUpdateHint: "a".repeat(2001) });
    assert.equal(tooLong.ok, false);
    assert.equal(tooLong.error, "planUpdateHint_too_long");

    const reset = await backend.hubCall("memory:runtimeHints:set", { reset: true });
    assert.equal(reset.ok, true);
    assert.equal(reset.planUpdateHint, DEFAULT_T3_RUNTIME_HINTS.planUpdateHint);

    assert.equal((rendererSource.match(/"memory:runtimeHints:get"/g) || []).length, 2);
    assert.doesNotMatch(rendererSource, /"memory:runtimeHints:set"/);

    const bundle = assembleRenderer(rendererSource, drawerSource);
    new vm.Script(bundle, { filename: "assembled-renderer.js" });
  } finally {
    try { globalThis[Symbol.for("t3.hud.memory.agent-access.v1")]?.stopWatching?.(); } catch {}
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("frontend card: initial-load gate, decoupled switch/draft saves, corrupted reset, and XSS escaping", async () => {
  assert.match(drawerSource, /id="t3-hub-settings-memory-pane"[\s\S]*id="t3-hub-memory-access"[\s\S]*id="t3-hub-memory-runtime-hints"/);

  let serverHints = {
    ok: true,
    trusted: true,
    corrupted: false,
    fallback: false,
    version: 1,
    enabled: true,
    scope: "t3-code-only",
    planUpdateHint: DEFAULT_T3_RUNTIME_HINTS.planUpdateHint,
    acp48kFallbackHint: DEFAULT_T3_RUNTIME_HINTS.acp48kFallbackHint,
    maxLength: 2000,
    persisted: false,
  };
  let resolveInitialGet;
  let failNextGet = false;
  const calls = [];
  const ui = drawerHarness(async (action, payload) => {
    calls.push({ action, payload });
    if (action === "memory:runtimeHints:get") {
      if (failNextGet) {
        failNextGet = false;
        throw new Error('load_err <svg onload="alert(1)">');
      }
      if (resolveInitialGet) {
        const fn = resolveInitialGet;
        resolveInitialGet = null;
        return new Promise((resolve) => { fn(() => resolve({ ...serverHints })); });
      }
      return { ...serverHints };
    }
    if (action === "memory:runtimeHints:set") {
      if (payload?.reset) {
        serverHints = {
          ...serverHints,
          trusted: true,
          corrupted: false,
          fallback: false,
          enabled: true,
          planUpdateHint: DEFAULT_T3_RUNTIME_HINTS.planUpdateHint,
          acp48kFallbackHint: DEFAULT_T3_RUNTIME_HINTS.acp48kFallbackHint,
          persisted: true,
        };
      } else {
        serverHints = {
          ...serverHints,
          enabled: typeof payload?.enabled === "boolean" ? payload.enabled : serverHints.enabled,
          planUpdateHint: typeof payload?.planUpdateHint === "string" ? payload.planUpdateHint : serverHints.planUpdateHint,
          acp48kFallbackHint: typeof payload?.acp48kFallbackHint === "string" ? payload.acp48kFallbackHint : serverHints.acp48kFallbackHint,
          persisted: true,
        };
      }
      return { ...serverHints };
    }
    if (action === "memory:agentAccess:get") return { ok: true, enabled: true, state: "enabled", setupSummary: { configured: 0, providers: [] } };
    if (action === "memory:connections") return { ok: true, agents: [] };
    if (action === "embed:status") return { mode: "mlx", running: false };
    return { ok: true };
  });

  // Verify memorySetupPrompt contains the extra T3 Code runtime hints guidance
  assert.match(ui.memorySetupPrompt, /设置 → 记忆与向量/);
  assert.match(ui.memorySetupPrompt, /plan_update/);
  assert.match(ui.memorySetupPrompt, /48KiB/);

  const cardHtml = () => ui.nodes.get("#t3-hub-memory-runtime-hints").innerHTML;

  // 1. Initial load failed -> editing, checkbox, Save, and Reset stay disabled; Retry stays available
  failNextGet = true;
  ui.setHubSettingsOpen(true, "memory");
  await new Promise(setImmediate);
  assert.match(cardHtml(), /读取失败/);
  assert.match(cardHtml(), /data-action="memory-runtime-hints-refresh"/);
  assert.match(cardHtml(), /<input type="checkbox" name="memoryRuntimeHintsEnabled"[^>]*disabled/);
  assert.match(cardHtml(), /name="memoryRuntimeHintsPlanUpdate"[^>]*disabled/);
  assert.match(cardHtml(), /data-action="memory-runtime-hints-save"[^>]*disabled/);
  assert.match(cardHtml(), /data-action="memory-runtime-hints-reset"[^>]*disabled/);
  assert.doesNotMatch(cardHtml(), /<svg onload=/);

  const callsBeforeBlocked = calls.length;
  await ui.saveMemoryRuntimeHints();
  await ui.toggleMemoryRuntimeHintsEnabled(false);
  await ui.resetMemoryRuntimeHints();
  assert.equal(calls.length, callsBeforeBlocked, "failed load must block Save, toggle, and Reset");

  // 2. While in-flight GET is pending -> all controls including Reset are disabled and actions no-op
  let releaseGet;
  resolveInitialGet = (done) => { releaseGet = done; };
  const pendingLoad = ui.refreshMemoryRuntimeHints(true);
  assert.match(cardHtml(), /正在读取/);
  assert.match(cardHtml(), /<input type="checkbox" name="memoryRuntimeHintsEnabled"[^>]*disabled/);
  assert.match(cardHtml(), /data-action="memory-runtime-hints-save"[^>]*disabled/);
  assert.match(cardHtml(), /data-action="memory-runtime-hints-reset"[^>]*disabled/);
  const callsWhilePending = calls.length;
  ui.onInput({ target: { name: "memoryRuntimeHintsPlanUpdate", value: "ignored" } });
  await ui.saveMemoryRuntimeHints();
  await ui.resetMemoryRuntimeHints();
  assert.equal(calls.length, callsWhilePending, "pending load must not submit empty draft or reset");
  releaseGet();
  await pendingLoad;

  // 3. Loaded -> switch toggle sends ONLY { enabled } and preserves unsaved textarea draft!
  const xssPlan = '</textarea><img src=x onerror=alert(1)>';
  const xssAcp = '" autofocus onfocus="alert(1)';
  ui.onInput({ target: { name: "memoryRuntimeHintsPlanUpdate", value: xssPlan } });
  ui.onInput({ target: { name: "memoryRuntimeHintsAcp48k", value: xssAcp } });
  assert.equal(ui.nodes.get("#t3-hub-runtime-hints-plan-count").textContent, `${xssPlan.length}/2000`);

  ui.onChange({ target: { name: "memoryRuntimeHintsEnabled", checked: false } });
  await new Promise(setImmediate);
  const lastToggle = calls.filter((c) => c.action === "memory:runtimeHints:set").at(-1);
  assert.deepEqual(JSON.parse(JSON.stringify(lastToggle.payload)), { enabled: false });
  assert.equal(serverHints.planUpdateHint, DEFAULT_T3_RUNTIME_HINTS.planUpdateHint, "toggle must not push unsaved text");
  assert.equal(ui.state.memoryRuntimeHintsDraft.planUpdateHint, xssPlan, "toggle must preserve unsaved text draft");
  assert.match(cardHtml(), /已关闭/);
  assert.match(cardHtml(), /&lt;\/textarea&gt;&lt;img src=x onerror=alert\(1\)&gt;/);

  // 4. Explicit Save sends ONLY { planUpdateHint, acp48kFallbackHint } without overwriting enabled
  const saveBtn = { dataset: { action: "memory-runtime-hints-save" } };
  ui.onClick({ target: { closest: () => saveBtn } });
  await new Promise(setImmediate);
  const lastSave = calls.filter((c) => c.action === "memory:runtimeHints:set").at(-1);
  assert.deepEqual(JSON.parse(JSON.stringify(lastSave.payload)), {
    planUpdateHint: xssPlan,
    acp48kFallbackHint: xssAcp,
  });
  assert.equal(serverHints.enabled, false, "Save must not overwrite enabled");
  assert.doesNotMatch(cardHtml(), /<img src=x onerror=alert\(1\)>/);
  assert.match(cardHtml(), /&quot; autofocus onfocus=&quot;alert\(1\)/);

  // 5. Client-side >2000-char guard
  const callsBeforeOver = calls.length;
  ui.onInput({ target: { name: "memoryRuntimeHintsPlanUpdate", value: "a".repeat(2001) } });
  await ui.saveMemoryRuntimeHints();
  assert.equal(calls.length, callsBeforeOver, "oversized draft must not call backend");
  assert.match(cardHtml(), /2000/);

  // 6. Untrusted/corrupted state disables editing/Save, warns user, and allows Reset
  ui.cache.runtimeHints = {
    ok: true,
    trusted: false,
    corrupted: true,
    fallback: true,
    enabled: false,
    warning: "unsafe_permissions",
    planUpdateHint: "",
    acp48kFallbackHint: "",
  };
  ui.renderMemoryRuntimeHints();
  assert.match(cardHtml(), /配置异常 · 已暂停下发/);
  assert.match(cardHtml(), /data-action="memory-runtime-hints-save"[^>]*disabled/);
  assert.doesNotMatch(cardHtml(), /data-action="memory-runtime-hints-reset"[^>]*disabled/);

  const resetBtn = { dataset: { action: "memory-runtime-hints-reset" } };
  ui.onClick({ target: { closest: () => resetBtn } });
  await new Promise(setImmediate);
  const lastReset = calls.filter((c) => c.action === "memory:runtimeHints:set").at(-1);
  assert.deepEqual(JSON.parse(JSON.stringify(lastReset.payload)), { reset: true });
  assert.match(cardHtml(), /已启用/);
  assert.match(cardHtml(), /已恢复默认提示/);
});

function spawnLockHolder(f, { holdMs, writeDoc = null }) {
  const lockPath = path.join(f.hubDir, RUNTIME_HINTS_LOCK_FILE);
  const hintsPath = path.join(f.hubDir, RUNTIME_HINTS_FILE);
  const script = `
    const fs = require("node:fs");
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(${JSON.stringify(lockPath)}, { timeout: 0 });
    db.exec("BEGIN IMMEDIATE");
    process.stdout.write("locked\\n");
    const until = Date.now() + ${Number(holdMs)};
    while (Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    const doc = ${JSON.stringify(writeDoc)};
    if (doc) fs.writeFileSync(${JSON.stringify(hintsPath)}, JSON.stringify(doc, null, 2) + "\\n", { mode: 0o600 });
    db.exec("ROLLBACK");
    db.close();
  `;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  const locked = new Promise((resolve, reject) => {
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; if (out.includes("locked")) resolve(); });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("close", (code) => { if (!out.includes("locked")) reject(new Error(`holder exited ${code}: ${err}`)); });
  });
  const exited = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
  return { child, locked, exited };
}

test("kernel-level SQLite lock: live holder is never pre-empted by age, waits are bounded by 3s, crashes release, unsafe lock files fail fast", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const opts = { homeDir: f.homeDir, hubDir: f.hubDir, userDataDir: f.userDataDir };
  const hintsPath = path.join(f.hubDir, RUNTIME_HINTS_FILE);
  const lockPath = path.join(f.hubDir, RUNTIME_HINTS_LOCK_FILE);
  assert.equal(RUNTIME_HINTS_LOCK_TIMEOUT_MS, 3000);

  assert.equal(setT3RuntimeHints({ enabled: true, planUpdateHint: "BASE", acp48kFallbackHint: "BASE_ACP" }, opts).ok, true);
  assert.equal(fs.lstatSync(lockPath).mode & 0o777, 0o600, "lock database must be 0600");
  assert.equal(fs.existsSync(hintsPath + ".lock"), false, "legacy unlink-able lock file must not be used");

  // 1. Live holder with a lock file aged far beyond 10s/11s must NOT be pre-empted; waiter times out strictly ~3s.
  const holder = spawnLockHolder(f, { holdMs: 6000 });
  await holder.locked;
  const ancient = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(lockPath, ancient, ancient);
  const beforeText = fs.readFileSync(hintsPath, "utf8");
  const started = Date.now();
  const blocked = setT3RuntimeHints({ planUpdateHint: "SHOULD_NOT_WRITE" }, opts);
  const elapsed = Date.now() - started;
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, "lock_timeout");
  assert.ok(elapsed >= 2900 && elapsed < 4000, `lock wait must honor the 3s deadline (took ${elapsed}ms)`);
  assert.equal(fs.readFileSync(hintsPath, "utf8"), beforeText, "timed-out writer must not touch the file");
  holder.child.kill("SIGKILL");
  await holder.exited;

  // 2. Crashed holder: the kernel releases the lock immediately.
  const crashed = spawnLockHolder(f, { holdMs: 60000 });
  await crashed.locked;
  crashed.child.kill("SIGKILL");
  await crashed.exited;
  const afterCrashStart = Date.now();
  const afterCrash = setT3RuntimeHints({ planUpdateHint: "AFTER_CRASH" }, opts);
  assert.equal(afterCrash.ok, true, JSON.stringify(afterCrash));
  assert.ok(Date.now() - afterCrashStart < 1000, "crashed holder must not block waiters");

  // 3. Strict serialization: the waiter merges on top of what the holder wrote while holding the lock.
  const writer = spawnLockHolder(f, {
    holdMs: 800,
    writeDoc: { version: 1, enabled: true, scope: "t3-code-only", planUpdateHint: "HOLDER_PLAN", acp48kFallbackHint: "HOLDER_ACP" },
  });
  await writer.locked;
  const merged = setT3RuntimeHints({ enabled: false }, opts);
  await writer.exited;
  assert.equal(merged.ok, true, JSON.stringify(merged));
  assert.equal(merged.enabled, false);
  assert.equal(merged.planUpdateHint, "HOLDER_PLAN", "waiter must read the holder's committed write inside its own critical section");
  assert.equal(merged.acp48kFallbackHint, "HOLDER_ACP");

  // 4. Permission error on the lock file fails fast and never bypasses the deadline by retrying.
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    fs.chmodSync(lockPath, 0o000);
    const permStart = Date.now();
    const denied = setT3RuntimeHints({ planUpdateHint: "DENIED" }, opts);
    const permElapsed = Date.now() - permStart;
    fs.chmodSync(lockPath, 0o600);
    assert.equal(denied.ok, false);
    assert.notEqual(denied.error, "lock_timeout");
    assert.ok(permElapsed < 1000, `permission errors must fail fast (took ${permElapsed}ms)`);
    assert.equal(getT3RuntimeHints(opts).planUpdateHint, "HOLDER_PLAN");
  }

  // 5. Symlinked lock database is refused without touching the link target.
  const decoy = path.join(f.root, "decoy.sqlite");
  fs.writeFileSync(decoy, "decoy");
  fs.rmSync(lockPath);
  fs.symlinkSync(decoy, lockPath);
  const symlinked = setT3RuntimeHints({ planUpdateHint: "SYMLINK" }, opts);
  assert.equal(symlinked.ok, false);
  assert.equal(symlinked.error, "unsafe_lock_file");
  assert.equal(fs.readFileSync(decoy, "utf8"), "decoy");
  assert.equal(getT3RuntimeHints(opts).planUpdateHint, "HOLDER_PLAN");
});

test("router provider path trust requires real, existing paths strictly inside the real providers root; metadata is never scanned recursively", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const { isT3CodeRuntime, isTrustedT3ProviderPath } = require(ROUTER_PATH);
  const providers = path.join(f.userDataDir, "providers");
  const env = (extra) => ({ HOME: f.homeDir, ...extra });

  // providers root itself missing -> false even for lexically valid paths
  assert.equal(isT3CodeRuntime(env({ CODEX_HOME: path.join(providers, "codex") })), false);

  fs.mkdirSync(path.join(providers, "codex"), { recursive: true });
  fs.mkdirSync(path.join(providers, "antigravity", "real"), { recursive: true });
  fs.writeFileSync(path.join(providers, "antigravity", "real", "meta.json"), "{}");
  const outside = path.join(f.root, "outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(path.join(providers, "does-not-exist"), path.join(providers, "dangling"));
  fs.symlinkSync(outside, path.join(providers, "escape"));

  assert.equal(isT3CodeRuntime(env({ CODEX_HOME: path.join(providers, "missing") })), false, "missing directory");
  assert.equal(isT3CodeRuntime(env({ CODEX_HOME: path.join(providers, "dangling") })), false, "dangling symlink");
  assert.equal(isT3CodeRuntime(env({ CODEX_HOME: path.join(providers, "escape") })), false, "symlink escaping providers root");
  assert.equal(isT3CodeRuntime(env({ CODEX_HOME: path.join(providers, "antigravity", "real", "meta.json") })), false, "CODEX_HOME must be a directory");
  assert.equal(isT3CodeRuntime(env({ ANTIGRAVITY_SOURCE_METADATA: path.join(providers, "missing") })), false);
  assert.equal(isT3CodeRuntime(env({ ANTIGRAVITY_SOURCE_METADATA: path.join(providers, "dangling") })), false);
  assert.equal(isTrustedT3ProviderPath(path.join(providers, "missing"), providers), false);
  assert.equal(isTrustedT3ProviderPath(providers, providers), false, "root itself is not inside");

  // Nested / non-top-level JSON values never count, even when they point at real provider dirs.
  const realDir = path.join(providers, "antigravity", "real");
  for (const doc of [
    { description: { path: realDir } },
    { nested: { configDir: realDir } },
    { items: [{ path: realDir }] },
    [realDir],
    { note: realDir },
    { path: path.join(providers, "missing") },
  ]) {
    assert.equal(isT3CodeRuntime(env({ ANTIGRAVITY_SOURCE_METADATA: JSON.stringify(doc) })), false, JSON.stringify(doc));
  }

  // Positive: existing real paths, pure string or top-level known field.
  assert.equal(isT3CodeRuntime(env({ CODEX_HOME: path.join(providers, "codex") })), true);
  assert.equal(isT3CodeRuntime(env({ ANTIGRAVITY_SOURCE_METADATA: realDir })), true);
  assert.equal(isT3CodeRuntime(env({ ANTIGRAVITY_SOURCE_METADATA: path.join(realDir, "meta.json") })), true);
  assert.equal(isT3CodeRuntime(env({ ANTIGRAVITY_SOURCE_METADATA: JSON.stringify({ path: realDir, description: "x" }) })), true);
});

test("both readers use fstat(fd) permissions and strict UTF-8, failing closed identically", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const opts = { homeDir: f.homeDir, hubDir: f.hubDir, userDataDir: f.userDataDir };
  const hintsPath = path.join(f.hubDir, RUNTIME_HINTS_FILE);
  const { readT3RuntimeHintsFallback } = require(ROUTER_PATH);
  const validDoc = { version: 1, enabled: true, scope: "t3-code-only", planUpdateHint: "OK_PLAN", acp48kFallbackHint: "OK_ACP" };
  assert.equal(setT3RuntimeHints(validDoc, opts).ok, true);
  assert.equal(getT3RuntimeHints(opts).trusted, true);
  assert.equal(readT3RuntimeHintsFallback(hintsPath).trusted, true);

  // 1. Mode widened to 0o666 on the same inode between lstat and open -> rejected by fstat in both readers.
  const realOpen = fs.openSync;
  const racedOpen = (file, ...rest) => {
    const fd = realOpen(file, ...rest);
    if (path.resolve(String(file)) === hintsPath) fs.chmodSync(hintsPath, 0o666);
    return fd;
  };
  for (const read of [() => getT3RuntimeHints(opts), () => readT3RuntimeHintsFallback(hintsPath)]) {
    fs.chmodSync(hintsPath, 0o600);
    fs.openSync = racedOpen;
    let res;
    try { res = read(); } finally { fs.openSync = realOpen; }
    assert.equal(res.trusted, false);
    assert.equal(res.enabled, false);
    assert.equal(res.corrupted, true);
    assert.equal(res.warning, "unsafe_permissions");
    assert.equal(res.planUpdateHint, "");
  }
  fs.chmodSync(hintsPath, 0o600);

  // 2. Invalid UTF-8 (0xFF) is never replaced with U+FFFD and trusted.
  const json = JSON.stringify({ ...validDoc, planUpdateHint: "BAD__BYTE" });
  const bytes = Buffer.from(json, "utf8");
  const at = bytes.indexOf(Buffer.from("__"));
  bytes[at] = 0xff;
  fs.writeFileSync(hintsPath, bytes, { mode: 0o600 });
  const primary = getT3RuntimeHints(opts);
  const fallback = readT3RuntimeHintsFallback(hintsPath);
  for (const res of [primary, fallback]) {
    assert.equal(res.trusted, false);
    assert.equal(res.enabled, false);
    assert.equal(res.corrupted, true);
    assert.equal(res.warning, "invalid_utf8");
    assert.doesNotMatch(String(res.planUpdateHint), /\uFFFD/);
  }
  const blockedWrite = setT3RuntimeHints({ enabled: false }, opts);
  assert.equal(blockedWrite.ok, false);
  assert.equal(blockedWrite.error, "invalid_utf8");
  assert.deepEqual(fs.readFileSync(hintsPath), bytes, "non-reset writes must not rewrite corrupted bytes");

  const reqs = [{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }];
  const stubAccessPath = path.join(f.root, "legacy-memory-access.cjs");
  fs.writeFileSync(stubAccessPath, `module.exports = { createMemoryAccessManager: () => ({ readMemoryOnlyStatus: () => ({ ok: true, enabled: true, state: "enabled", serverVersion: "1", vaultAvailable: false }) }) };`);
  for (const extra of [{}, { T3_HUB_MEMORY_ACCESS: stubAccessPath }]) {
    const out = runRouterBatch(f, ["--memory-only"], reqs, { T3_ACP_MCP_NODE: "/Applications/T3.app/Contents/MacOS/Electron", ...extra });
    assert.equal(Object.hasOwn(out[0].result, "instructions"), false, JSON.stringify(extra));
  }

  // Reset still repairs the corrupted file.
  const reset = setT3RuntimeHints({ reset: true }, opts);
  assert.equal(reset.ok, true);
  assert.equal(getT3RuntimeHints(opts).trusted, true);
  assert.equal(readT3RuntimeHintsFallback(hintsPath).trusted, true);
});

test("frontend card: shared gate, read-vs-save errors with Retry, invalid GET payloads, and per-field dirty saves", async () => {
  const base = {
    ok: true, trusted: true, corrupted: false, fallback: false, version: 1, enabled: true, scope: "t3-code-only",
    planUpdateHint: "P0", acp48kFallbackHint: "A0", maxLength: 2000, persisted: true,
  };
  let serverHints = { ...base };
  let getMode = "empty";
  let failSet = false;
  const calls = [];
  const ui = drawerHarness(async (action, payload) => {
    calls.push({ action, payload });
    if (action === "memory:runtimeHints:get") {
      if (getMode === "empty") return {};
      if (getMode === "fail") throw new Error("refresh_failed");
      return { ...serverHints };
    }
    if (action === "memory:runtimeHints:set") {
      if (failSet) throw new Error("save_failed");
      serverHints = {
        ...serverHints,
        ...(typeof payload?.enabled === "boolean" ? { enabled: payload.enabled } : {}),
        ...(typeof payload?.planUpdateHint === "string" ? { planUpdateHint: payload.planUpdateHint } : {}),
        ...(typeof payload?.acp48kFallbackHint === "string" ? { acp48kFallbackHint: payload.acp48kFallbackHint } : {}),
      };
      return { ...serverHints };
    }
    if (action === "memory:agentAccess:get") return { ok: true, enabled: true, state: "enabled", setupSummary: { configured: 0, providers: [] } };
    if (action === "memory:connections") return { ok: true, agents: [] };
    if (action === "embed:status") return { mode: "mlx", running: false };
    return { ok: true };
  });
  const cardHtml = () => ui.nodes.get("#t3-hub-memory-runtime-hints").innerHTML;
  const setCalls = () => calls.filter((c) => c.action === "memory:runtimeHints:set");
  const assertLocked = () => {
    assert.match(cardHtml(), /<input type="checkbox" name="memoryRuntimeHintsEnabled"[^>]*disabled/);
    assert.match(cardHtml(), /name="memoryRuntimeHintsPlanUpdate"[^>]*disabled/);
    assert.match(cardHtml(), /name="memoryRuntimeHintsAcp48k"[^>]*disabled/);
    assert.match(cardHtml(), /data-action="memory-runtime-hints-save"[^>]*disabled/);
  };
  const tryWrites = async () => {
    const before = setCalls().length;
    ui.onInput({ target: { name: "memoryRuntimeHintsPlanUpdate", value: "BLOCKED" } });
    await ui.saveMemoryRuntimeHints();
    await ui.toggleMemoryRuntimeHintsEnabled(false);
    ui.onChange({ target: { name: "memoryRuntimeHintsEnabled", checked: false } });
    await new Promise(setImmediate);
    assert.equal(setCalls().length, before, "blocked state must not write");
  };

  // 1. GET returns {} -> read-failure state, everything locked, Retry offered.
  ui.setHubSettingsOpen(true, "memory");
  await new Promise(setImmediate);
  await ui.refreshMemoryRuntimeHints(true);
  assert.match(cardHtml(), /无法读取本机设置/);
  assert.match(cardHtml(), /data-action="memory-runtime-hints-refresh"/);
  assert.doesNotMatch(cardHtml(), /无法保存本机设置/);
  assertLocked();
  await tryWrites();
  assert.equal(ui.cache.runtimeHints, null, "invalid payload must not be cached");

  // 2. Valid load -> Save disabled until something is actually edited.
  getMode = "ok";
  await ui.refreshMemoryRuntimeHints(true);
  assert.match(cardHtml(), /已启用/);
  assert.doesNotMatch(cardHtml(), /<input type="checkbox" name="memoryRuntimeHintsEnabled"[^>]*disabled/);
  assert.match(cardHtml(), /data-action="memory-runtime-hints-save"[^>]*disabled/, "no dirty fields -> Save disabled");
  const beforeNoop = setCalls().length;
  await ui.saveMemoryRuntimeHints();
  assert.equal(setCalls().length, beforeNoop, "no-op save must not write");

  // 3. Cached state + forced refresh failure -> read error (not save error), locked, Retry offered; stale cache unusable.
  getMode = "fail";
  await ui.refreshMemoryRuntimeHints(true);
  assert.ok(ui.cache.runtimeHints, "old cache still present");
  assert.match(cardHtml(), /无法读取本机设置/);
  assert.match(cardHtml(), /读取失败/);
  assert.doesNotMatch(cardHtml(), /无法保存本机设置/);
  assert.match(cardHtml(), /data-action="memory-runtime-hints-refresh"/);
  assertLocked();
  await tryWrites();

  // 4. Retry succeeds -> unlocked again.
  getMode = "ok";
  ui.onClick({ target: { closest: () => ({ dataset: { action: "memory-runtime-hints-refresh" } }) } });
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.match(cardHtml(), /已启用/);
  assert.doesNotMatch(cardHtml(), /无法读取本机设置/);

  // 5. Edit only planUpdateHint; another window saves a new acp48kFallbackHint; toggle brings it in; Save sends ONLY plan.
  ui.onInput({ target: { name: "memoryRuntimeHintsPlanUpdate", value: "MINE_PLAN" } });
  serverHints = { ...serverHints, acp48kFallbackHint: "OTHER_WINDOW_ACP" };
  await ui.toggleMemoryRuntimeHintsEnabled(false);
  assert.deepEqual(JSON.parse(JSON.stringify(setCalls().at(-1).payload)), { enabled: false });
  assert.equal(ui.state.memoryRuntimeHintsDraft.planUpdateHint, "MINE_PLAN", "dirty field keeps user edit");
  assert.equal(ui.state.memoryRuntimeHintsDraft.acp48kFallbackHint, "OTHER_WINDOW_ACP", "clean field follows backend");
  assert.match(cardHtml(), /OTHER_WINDOW_ACP/);
  await ui.saveMemoryRuntimeHints();
  assert.deepEqual(JSON.parse(JSON.stringify(setCalls().at(-1).payload)), { planUpdateHint: "MINE_PLAN" });
  assert.equal(serverHints.acp48kFallbackHint, "OTHER_WINDOW_ACP", "untouched field must not be overwritten");
  assert.equal(serverHints.planUpdateHint, "MINE_PLAN");
  assert.equal(ui.state.memoryRuntimeHintsDraft.dirtyPlanUpdate, false);
  assert.match(cardHtml(), /data-action="memory-runtime-hints-save"[^>]*disabled/);

  // 6. Editing back to the saved value is not dirty.
  ui.onInput({ target: { name: "memoryRuntimeHintsAcp48k", value: "X" } });
  ui.onInput({ target: { name: "memoryRuntimeHintsAcp48k", value: "OTHER_WINDOW_ACP" } });
  const beforeRevert = setCalls().length;
  await ui.saveMemoryRuntimeHints();
  assert.equal(setCalls().length, beforeRevert);

  // 7. Save failure is reported as a save error, distinct from read errors, and keeps the dirty draft.
  failSet = true;
  ui.onInput({ target: { name: "memoryRuntimeHintsAcp48k", value: "MY_ACP" } });
  await ui.saveMemoryRuntimeHints();
  assert.match(cardHtml(), /无法保存本机设置/);
  assert.doesNotMatch(cardHtml(), /无法读取本机设置/);
  assert.equal(ui.state.memoryRuntimeHintsDraft.dirtyAcp48k, true);
  failSet = false;
  await ui.saveMemoryRuntimeHints();
  assert.deepEqual(JSON.parse(JSON.stringify(setCalls().at(-1).payload)), { acp48kFallbackHint: "MY_ACP" });
  assert.equal(serverHints.planUpdateHint, "MINE_PLAN");
});
