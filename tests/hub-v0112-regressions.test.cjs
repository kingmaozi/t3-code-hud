"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");
const vm = require("node:vm");
const { createTaskBoard } = require("../src/hub-task-board.cjs");

const source = fs.readFileSync(path.join(__dirname, "../src/renderer-ui.js"), "utf8");
const envA = "11111111-1111-4111-8111-111111111111";
const envB = "22222222-2222-4222-8222-222222222222";
function renderer(names, globals = {}) {
  const functions = names.map((name) => {
    const match = source.match(new RegExp(`  function ${name}\\([^]*?\\n  \\}(?=\\n)`));
    assert.ok(match, name);
    return match[0];
  });
  return vm.runInNewContext(`${functions.join("\n")}\n({${names.join(",")}})`, globals);
}
const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
const plain = (value) => JSON.parse(JSON.stringify(value));

test("draft layout uses rendered title text, reserves rename inputs and header spacers", () => {
  const header = rect(100, 0, 660, 48);
  const titleBox = rect(136, 13, 426, 22);
  const span = { getBoundingClientRect: () => rect(136, 15, 62, 18) };
  const title = { tagName: "H2", getBoundingClientRect: () => titleBox, querySelectorAll: () => [span] };
  const input = { ...title, tagName: "INPUT" };
  const spacer = {
    contains: () => false,
    matches: () => true,
    closest: (selector) => selector.includes("aria-hidden") ? spacer : null,
    getBoundingClientRect: () => rect(660, 5, 68, 32),
  };
  const titleControls = { ...spacer, matches: () => false, closest: () => null, getBoundingClientRect: () => rect(562, 5, 96, 32) };
  const offRow = { ...spacer, getBoundingClientRect: () => rect(265, 100, 100, 32) };
  const textNode = { data: "新建会话" };
  const document = {
    createRange: () => ({ selectNodeContents: (node) => assert.equal(node, textNode), getClientRects: () => [rect(126, 15, 77, 18)] }),
    createTreeWalker: () => {
      const nodes = [textNode, null].values();
      return { nextNode: () => nodes.next().value };
    },
  };
  const dom = renderer(["visibleHudRect", "measureHudTitleRect", "findHudLayoutAnchors", "collectHudLayoutObstacles", "hudFreeIntervals", "calculateHudLayout"], { document });
  assert.equal(dom.measureHudTitleRect(title).right, 203);
  assert.equal(dom.measureHudTitleRect(title).left, 136);
  assert.equal(dom.measureHudTitleRect(input), titleBox);
  document.createRange = () => { throw new Error("Range unavailable"); };
  assert.equal(dom.measureHudTitleRect(title).right, 198);
  const nativeHeader = {
    querySelector: (selector) => selector === 'input[aria-label="Thread title"]' ? input : title,
    querySelectorAll: () => [spacer, titleControls, offRow],
  };
  assert.equal(dom.findHudLayoutAnchors(nativeHeader).title, input);
  const headerObstacles = dom.collectHudLayoutObstacles(nativeHeader, "button, span", header, [], "span");
  assert.deepEqual(plain(headerObstacles).map((item) => item.left), [660, 562]);
  const layout = (titleRect) => dom.calculateHudLayout({ header, title: titleRect, headerObstacles, viewportWidth: 760 });
  const placed = layout(dom.measureHudTitleRect(title)).header;
  assert.ok(placed && placed.left + placed.width <= 559);
  assert.equal(layout(titleBox).header, null);
});

function classes() {
  const state = new Set();
  return {
    contains: (name) => state.has(name),
    add: (...names) => names.forEach((name) => state.add(name)),
    remove: (...names) => names.forEach((name) => state.delete(name)),
    toggle: (name, on) => on ? state.add(name) : state.delete(name),
  };
}

test("header compacts Git and hides only surplus rings with active provider priority", () => {
  const dom = renderer(["hudFreeIntervals", "calculateHudLayout", "fitHudQuotaRings"]);
  const headerFor = (gap) => dom.calculateHudLayout({
    header: rect(0, 0, 116 + gap, 48), title: rect(10, 14, 90, 20), viewportWidth: 1200,
    headerFullWidth: 168, headerCompactWidth: 132, headerCompactGitWidth: 24, ringCount: 3,
  }).header;
  assert.deepEqual([headerFor(168).compact, headerFor(168).maxVisibleRings], [false, 3]);
  assert.deepEqual([headerFor(132).compact, headerFor(132).maxVisibleRings], [true, 3]);
  assert.deepEqual([headerFor(96).compact, headerFor(96).maxVisibleRings, headerFor(96).width], [true, 2, 96]);
  assert.equal(headerFor(60).maxVisibleRings, 1);
  assert.equal(headerFor(24).maxVisibleRings, 0);
  assert.equal(headerFor(23), null);
  const buttons = ["codex", "agy-gemini", "agy-claude"].map((id) => ({
    id, classList: classes(),
    hasAttribute: (name) => name === "data-hud-quota-primary" ? id === "agy-claude" : id.startsWith("agy-"),
  }));
  const rings = { children: buttons };
  const visible = () => rings.children.filter((button) => !button.classList.contains("is-overflow-hidden")).map((button) => button.id);
  dom.fitHudQuotaRings(rings, 1);
  assert.deepEqual(visible(), ["agy-claude"]);
  dom.fitHudQuotaRings(rings, 2);
  assert.deepEqual(visible(), ["agy-gemini", "agy-claude"]);
  dom.fitHudQuotaRings(rings, 3);
  assert.deepEqual(visible(), ["codex", "agy-gemini", "agy-claude"]);
  assert.equal(rings.children, buttons);
});

test("a 440px middle pane keeps the active quota ring when Git and the ring cannot fit together", () => {
  const dom = renderer(["hudFreeIntervals", "calculateHudLayout", "fitHudQuotaRings"]);
  const headerFor = (available, ringCount = 2) => dom.calculateHudLayout({
    header: rect(0, 0, 440, 48), title: rect(20, 12, 210, 22),
    headerObstacles: [rect(241 + available, 8, 199 - available, 32)], viewportWidth: 1400,
    headerFullWidth: 82 + ringCount * 36, headerCompactWidth: 28 + ringCount * 36,
    headerCompactGitWidth: 28, ringCount,
  }).header;
  const narrow = headerFor(45.45);
  assert.equal(narrow.quotaOnly, true);
  assert.equal(narrow.maxVisibleRings, 1);
  assert.equal(narrow.width, 32);
  assert.ok(narrow.left >= 238 && narrow.left + narrow.width <= 283.45);
  const rings = { children: ["codex", "agy"].map((id) => ({ id, classList: classes(), hasAttribute: () => id === "agy" })) };
  dom.fitHudQuotaRings(rings, narrow.maxVisibleRings);
  assert.deepEqual(rings.children.filter((button) => !button.classList.contains("is-overflow-hidden")).map((button) => button.id), ["agy"]);
  assert.equal(headerFor(45.45, 0).width, 28);
  assert.equal(headerFor(31.99).maxVisibleRings, 0);
  assert.equal(headerFor(64).quotaOnly, false);
  assert.equal(headerFor(64).maxVisibleRings, 1);
  assert.equal(headerFor(160).compact, false);
  assert.equal(headerFor(160).maxVisibleRings, 2);
  assert.match(source, /#t3-hud-header-tools\.is-quota-only #t3-hud-git-btn\s*\{\s*display: none;/);
  assert.match(source, /headerTools\.classList\.toggle\("is-quota-only", !!layout\.header\?\.quotaOnly\)/);
});

test("Composer respects the resting controls and fits only complete stats with their separators", () => {
  const dom = renderer(["visibleHudRect", "collectHudLayoutObstacles", "hudFreeIntervals", "calculateHudLayout", "fitHudStatsBar"]);
  const model = rect(320, 100, 100, 28);
  const element = (bounds, hidden = false) => ({ contains: () => false, getBoundingClientRect: () => bounds, hidden });
  const resting = [element(rect(129, 104, 14, 16)), element(rect(148, 104, 20, 16)), element(rect(173, 104, 20, 16))];
  const footer = { querySelectorAll(selector) {
    assert.match(selector, /data-resting-block/);
    assert.match(selector, /data-resting-controls-separator/);
    assert.match(selector, /data-resting-controls-overflow/);
    return [...resting, element(rect(210, 132, 20, 16)), element(rect(220, 104, 20, 16), true)];
  } };
  assert.match(source, /'button, \[role="button"\], \[data-resting-block\], \[data-resting-controls-separator\], \[data-resting-controls-overflow\]'/);
  const obstacles = dom.collectHudLayoutObstacles(footer, "[data-resting-block], [data-resting-controls-separator], [data-resting-controls-overflow]", model, []);
  assert.equal(obstacles.length, 3);
  const layout = dom.calculateHudLayout({ attach: rect(20, 100, 28, 28), model, footerObstacles: obstacles });
  assert.ok(layout.stats.left >= 196);
  assert.ok(layout.stats.left + layout.stats.width + 4 <= layout.context.left);

  const metric = (width) => ({ width, classList: classes(), previousElementSibling: { classList: classes() } });
  const parts = { cache: metric(34), tokens: metric(46), cost: metric(50) };
  const bar = {
    classList: classes(),
    querySelector: (selector) => parts[selector.match(/"(.+)"/)[1]],
    getBoundingClientRect() {
      const widths = Object.values(parts).filter((part) => !part.classList.contains("is-overflow-hidden")).map((part) => part.width + 3);
      const overhead = this.classList.contains("is-mini") ? 68 : this.classList.contains("is-tight") ? 96 : 122;
      return { width: widths.reduce((sum, width) => sum + width, overhead) };
    },
  };
  const fit = (width) => dom.fitHudStatsBar(bar, { left: 2, width });
  assert.ok(fit(280));
  assert.ok(!bar.classList.contains("is-tight"));
  assert.ok(fit(240));
  assert.ok(bar.classList.contains("is-tight") && !bar.classList.contains("is-mini"));
  assert.ok(fit(175));
  assert.ok(bar.classList.contains("is-mini"));
  assert.ok(parts.cache.previousElementSibling.classList.contains("is-overflow-hidden"));
  assert.ok(!parts.cost.classList.contains("is-overflow-hidden"));
  assert.ok(fit(122));
  assert.ok(parts.tokens.previousElementSibling.classList.contains("is-overflow-hidden"));
  assert.ok(!parts.cost.classList.contains("is-overflow-hidden"), "the entire cost still fits");
  assert.equal(fit(50), null);
  assert.ok(fit(280));
  assert.ok(Object.values(parts).every((part) => !part.classList.contains("is-overflow-hidden") && !part.previousElementSibling.classList.contains("is-overflow-hidden")));
});

test("0.1.12 committed Fiber reads source-only usage and proves the matching draft or server environment", () => {
  const usage = { model: "gemini-4-neon", providerInstanceId: "agy-one", sources: [] };
  const localDraft = { draftId: "draft-a", isServerThread: false, environmentId: envA, usage };
  const remoteThread = { threadId: "thread-b", isServerThread: true, environmentId: envB, usage: { providers: [], model: "remote" } };
  const committed = { memoizedProps: remoteThread, child: { memoizedProps: localDraft } };
  const settings = { location: { pathname: "/", hash: "#/draft/draft-a" } };
  let promotedRoute = "__NEW__";
  const dom = renderer(["readLiveT3State"], {
    window: settings,
    getRouteHint: () => promotedRoute,
    document: { getElementById: () => ({ __reactContainer: { memoizedProps: remoteThread, stateNode: { current: committed } } }) },
  });
  let state = dom.readLiveT3State();
  assert.equal(state.usage, usage);
  assert.equal(state.environmentId, envA);
  assert.equal(state.selectedModel, "gemini-4-neon");
  assert.equal(state.selectedProvider, "agy-one");
  committed.child.child = { memoizedProps: { modelSelection: { model: "picked-explicitly", instanceId: "picked-provider" } } };
  assert.equal(dom.readLiveT3State().selectedModel, "picked-explicitly");
  assert.equal(dom.readLiveT3State().selectedProvider, "picked-provider");
  settings.location.hash = `#/${envB}/thread-b`;
  assert.equal(dom.readLiveT3State().usage, remoteThread.usage);
  settings.location.hash = `#/${envB}/thread-pending`;
  state = dom.readLiveT3State();
  assert.equal(state.environmentId, envB);
  assert.equal(state.usage, null);
  settings.location.hash = "#/draft/not-mounted";
  assert.equal(dom.readLiveT3State().environmentId, null);
  promotedRoute = `/_t3_env_/${envB}/thread-b`;
  assert.equal(dom.readLiveT3State().environmentId, envB);
  assert.equal(dom.readLiveT3State().usage, null, "a promoted hint identifies the cache bucket while its committed owner is missing");
  settings.location.hash = `#/_t3_env_/${envA}/draft/draft-a`;
  assert.equal(dom.readLiveT3State().usage, usage);
  settings.location.hash = "#/new";
  committed.child = { memoizedProps: { isServerThread: false, usage: { providers: [] } } };
  assert.equal(dom.readLiveT3State().environmentId, "");
});

const quota = (usedPercent, extras = {}) => ({ id: "weekly", kind: "weekly", label: "Weekly", usedPercent, ...extras });
const provider = (id, driver, windows, checkedAt) => ({ instanceId: id, driver, usageLimits: { windows, checkedAt } });

test("adds HTTP and account-pool quotas using provider identity and newer measurements", () => {
  const dom = renderer(["toEpochMs", "mergeUsageLimitProviders"]);
  const base = [provider("agy-one", "antigravity", []), { ...provider("muse-one", "muse", [quota(15)], 20), displayName: "Muse Workspace" }];
  const sources = [
    { kind: "http", checkedAt: 30, quotaAccounts: [
      { id: "agy-account", providerInstanceId: "agy-one", label: "AGY", windows: [quota(58)] },
      { id: "invalid", windows: [quota(-5)] },
      { id: "standalone", label: "External Credits", windows: [quota(0)] },
    ] },
    { kind: "cliproxy", checkedAt: 10, accounts: [{ id: "muse-account", driver: "muse", usageLimits: { windows: [quota(70)] } }] },
    { kind: "cliproxy", checkedAt: 40, accounts: [{ id: "muse-account", driver: "muse", usageLimits: { windows: [
      quota(39), quota(42, { id: "session", kind: "session", windowDurationMins: 180 }),
    ] } }] },
  ];
  const merged = dom.mergeUsageLimitProviders(base, sources, [provider("acpRegistry_devin", "devin", [quota(17)])]);
  assert.deepEqual(plain(merged).map((p) => p.instanceId), ["agy-one", "muse-one", "standalone", "acpRegistry_devin"]);
  assert.equal(merged[0].driver, "antigravity");
  assert.equal(merged[1].displayName, "Muse Workspace");
  assert.equal(merged[1].usageLimits.windows[0].usedPercent, 39);
  assert.equal(merged[1].usageLimits.windows[1].windowDurationMins, 180);
  assert.equal(merged[2].usageLimits.windows[0].usedPercent, 0);
  const oldOnly = dom.mergeUsageLimitProviders(base, [sources[1]]);
  assert.equal(oldOnly[0].usageLimits.windows[0].usedPercent, 15);
  const preferredDevin = dom.mergeUsageLimitProviders([provider("devin", "devin", [quota(80)])], [], [merged.at(-1)]);
  assert.equal(preferredDevin.length, 1);
  assert.equal(preferredDevin[0].usageLimits.windows[0].usedPercent, 80);
});

test("a partial HTTP update refreshes only its window and preserves the native five-hour quota", () => {
  const dom = renderer(["toEpochMs", "mergeUsageLimitProviders"]);
  const session = quota(24, { id: "session", kind: "session", label: "Session", windowDurationMins: 300 });
  const codex = provider("codex-main", "codex", [quota(10, { windowDurationMins: 10080 }), session], 15);
  const http = (checkedAt, windows) => ({
    kind: "http", checkedAt, quotaAccounts: [{ id: "codex", providerInstanceId: "codex-main", windows }],
  });
  const [merged] = dom.mergeUsageLimitProviders([codex], [
    http(35, [quota(58, { id: "WEEKLY" })]),
    http(25, [quota(45)]),
  ]);
  assert.equal(merged.usageLimits.windows.length, 2);
  assert.equal(merged.usageLimits.windows[0].usedPercent, 58);
  assert.equal(merged.usageLimits.windows[0].windowDurationMins, 10080);
  assert.deepEqual(plain(merged.usageLimits.windows[1]), session);
  assert.equal(codex.usageLimits.windows[0].usedPercent, 10);
});

test("two HTTP AGY accounts with colliding window IDs and timestamps yield both quota rings", () => {
  const usage = {
    providers: [provider("agy-main", "antigravity", [])],
    sources: [{
      kind: "http", checkedAt: 30, quotaAccounts: [
        { id: "account-a", providerInstanceId: "agy-main", label: "Gemini Pool", windows: [quota(20)] },
        { id: "account-b", providerInstanceId: "agy-main", label: "Claude Pool", windows: [quota(60)] },
      ],
    }],
  };
  const dom = renderer(["toEpochMs", "selectHudFiveHourWindow", "hudUsageSources", "mergeUsageLimitProviders", "readHudQuotaProviders", "computeQuotaAndContext"], {
    hudQuotaSnapshots: new Map(), HUD_QUOTA_SNAPSHOT_TTL_MS: 30 * 60_000,
    readLiveT3State: () => ({ usage, environmentId: envA, selectedProvider: "agy-main", selectedModel: "claude-sonnet" }),
    formatResetShort: () => "",
  });
  const providers = dom.mergeUsageLimitProviders(usage.providers, usage.sources);
  assert.equal(providers.length, 1);
  assert.equal(providers[0].usageLimits.windows.length, 2);
  const result = dom.computeQuotaAndContext(null);
  assert.deepEqual(plain(result.providerQuotas).map((ring) => [ring.instanceId, ring.weekly.remainingPct]), [
    ["agy-main:gemini", 80], ["agy-main:claude", 40],
  ]);
  assert.equal(result.activeQuotaRingId, "agy-main:claude");
});

test("draft quota snapshots expire after 30 minutes and stay isolated across environment switches", () => {
  const globals = { hudQuotaSnapshots: new Map(), HUD_QUOTA_SNAPSHOT_TTL_MS: 30 * 60_000 };
  const dom = renderer(["toEpochMs", "hudUsageSources", "mergeUsageLimitProviders", "readHudQuotaProviders"], globals);
  const external = [provider("devin", "devin", [quota(20)])];
  const local = { providers: [provider("codex", "codex", [quota(10)])] };
  const read = (live, env, now) => plain(dom.readHudQuotaProviders(live, env, envA, external, now));
  assert.equal(read(local, envA, 3).length, 2);
  assert.deepEqual(read(null, null, 5), []);
  assert.deepEqual(read(null, envB, 5), []);
  const remote = { usageLimitSources: [{ kind: "http", quotaAccounts: [{ id: "remote", windows: [quota(60)] }] }] };
  assert.equal(read(remote, envB, 10)[0].instanceId, "remote");
  assert.deepEqual(read({ sources: [], providers: [] }, envB, 11).map((p) => p.instanceId), ["remote"]);
  assert.deepEqual(read(null, "", 12).map((p) => p.instanceId), ["codex", "devin"]);
  assert.equal(read({ providers: [provider("codex", "codex", [quota(33)])] }, envA, 13)[0].usageLimits.windows[0].usedPercent, 33);
  assert.equal(read(null, envA, 14)[0].usageLimits.windows[0].usedPercent, 33);
  assert.deepEqual(read(null, envB, 10 + globals.HUD_QUOTA_SNAPSHOT_TTL_MS), []);
  assert.deepEqual(read(null, envA, 13 + globals.HUD_QUOTA_SNAPSHOT_TTL_MS).map((p) => p.instanceId), ["devin"]);
  globals.hudQuotaSnapshots.clear();
  dom.readHudQuotaProviders(local, envA, "", [], 30);
  dom.readHudQuotaProviders({ providers: [provider("codex", "codex", [quota(27)])] }, "", "", [], 40);
  assert.equal(read(null, envA, 41)[0].usageLimits.windows[0].usedPercent, 27);
});

test("a failed quota source can reuse a verified same-environment snapshot without extending its lifetime", () => {
  const ttl = 30 * 60_000;
  const dom = renderer(["toEpochMs", "hudUsageSources", "mergeUsageLimitProviders", "readHudQuotaProviders"], {
    hudQuotaSnapshots: new Map(), HUD_QUOTA_SNAPSHOT_TTL_MS: ttl,
  });
  const failed = { providers: [provider("codex-main", "codex", [quota(-1)])], sources: [
    { kind: "http", checkedAt: 20, accounts: [], error: "Could not read the HTTP quota source." },
  ] };
  const read = (live, environmentId, now) => plain(dom.readHudQuotaProviders(live, environmentId, envA, [], now));
  read({ providers: [provider("codex-main", "codex", [quota(35)])] }, envA, 10);
  assert.deepEqual(read(failed, envB, 20), []);
  assert.equal(read(failed, envA, 20)[0].usageLimits.windows[0].usedPercent, 35);
  assert.equal(read(failed, envA, 10 + ttl - 1).length, 1);
  assert.deepEqual(read(failed, envA, 10 + ttl), []);
  assert.equal(read({ providers: [provider("codex-main", "codex", [quota(50)])] }, envA, 10 + ttl + 1)[0].usageLimits.windows[0].usedPercent, 50);
});

test("the external quota RPC identifies the local T3 environment without a configured Devin account", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3-hub-0112-quota-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, "environment-id"), envA + "\n");
  const backend = path.join(__dirname, "../src/backend.cjs");
  const run = spawnSync(process.execPath, ["-e",
    "require(process.argv[1]).hubCall('quota:external').then(result => process.stdout.write(JSON.stringify(result)))", backend], {
    env: { ...process.env, HOME: home, T3CODE_HOME: home, XDG_DATA_HOME: home }, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(run.status, 0, run.stderr || String(run.error || ""));
  assert.deepEqual(JSON.parse(run.stdout), { ok: true, providers: [], t3EnvironmentId: envA });
});

test("native, legacy, draft and new routes retain exact thread and project identity", () => {
  let route = `/${envA}/thread%3Aone?tab=1`;
  const props = { environmentId: envA, threadId: "thread:one", isServerThread: true, gitCwd: "/remote/work" };
  const globals = {
    getRouteHint: () => route,
    document: { getElementById: () => ({ __reactContainer: { stateNode: { current: { memoizedProps: props } } } }) },
    localStorage: { getItem: () => JSON.stringify({ state: { draftThreadsByThreadKey: { promoted: { promotedTo: props } } } }) },
  };
  const dom = renderer(["extractLastThreadIdFromHint", "resolvePromotedDraftRoute", "getHudRemoteProject"], globals);
  assert.equal(dom.extractLastThreadIdFromHint(route), "thread:one");
  const remote = () => plain(dom.getHudRemoteProject({ environmentId: envA, threadId: "thread:one" }));
  assert.deepEqual(remote(), { environmentId: envA, threadId: "thread:one", projectRoot: props.gitCwd });
  route = dom.resolvePromotedDraftRoute("/draft/promoted");
  assert.equal(route, `/_t3_env_/${envA}/thread%3Aone`);
  assert.equal(remote().environmentId, envA);
  route = "/draft/unpromoted";
  assert.equal(dom.resolvePromotedDraftRoute(route), "__NEW__");
  assert.equal(remote(), null);
  route = "/new?start=1";
  assert.equal(dom.extractLastThreadIdFromHint(route), "__NEW__");
  assert.equal(remote(), null);
});

function boardFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-hub-0112-"));
  const project = path.join(dir, "workspace");
  const plans = path.join(dir, "hub", "task-plans");
  const dbFile = path.join(dir, "statev2.sqlite");
  fs.mkdirSync(project);
  const db = new DatabaseSync(dbFile);
  db.exec(`
    CREATE TABLE projection_projects (project_id TEXT, workspace_root TEXT, deleted_at TEXT);
    CREATE TABLE orchestration_v2_projection_threads (
      thread_id TEXT, project_id TEXT, title TEXT, updated_at TEXT, created_at TEXT, deleted_at TEXT
    );
    CREATE TABLE orchestration_v2_projection_turn_items (
      thread_id TEXT, type TEXT, ordinal INTEGER, updated_at TEXT, status TEXT, parent_item_id TEXT, payload_json TEXT
    );
    INSERT INTO orchestration_v2_projection_threads VALUES ('main', 'p', 'Thread title', '2026-11-25', '2026-11-25', NULL);
  `);
  db.prepare("INSERT INTO projection_projects VALUES ('p', ?, NULL)").run(project);
  const fixedNow = Date.parse("2026-11-25T07:00:00Z");
  const board = createTaskBoard({ homeDir: dir, t3DbPath: dbFile, hubPlansDir: plans, agyBrainDirs: [], now: () => fixedNow });
  t.after(() => {
    board.disposePlanMirrors();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  let ordinal = 0;
  function item({ threadId = "main", type = "dynamic_tool", start, updated = start, name = "t3_hub.plan_update",
    status = "completed", input, parent = null, toolSource = { key: "mcp:t3_hub", kind: "integration" } }) {
    db.prepare("INSERT INTO orchestration_v2_projection_turn_items VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(threadId, type, ++ordinal, updated, status, parent, JSON.stringify({
        threadId, type, status, startedAt: start, toolName: name, input, toolSource,
      }));
  }
  const snapshot = (threadId = "main") => board.getBoardSnapshot({
    threadId, projectRoot: project, strictThreadMatch: true, excludeSubagentInference: true,
  });
  return { db, dbFile, project, board, item, snapshot, dir };
}

test("AGY's structured 0.1.12 MCP plan competes by time within the current main thread", (t) => {
  const f = boardFixture(t);
  const at = (hour) => `2026-11-25T${hour}:00:00Z`;
  const steps = [{ id: "check", text: "Validated task", status: "running" }];
  f.board.updatePlan({ threadId: "main", projectRoot: f.project, steps: [{ text: "Old Hub plan", status: "pending" }] });
  f.item({ start: at("08"), input: { title: "AGY task", background: "Checklist context", steps, projectRoot: f.project } });
  for (const type of ["command_execution", "reasoning", "assistant_message"]) {
    f.item({ type, start: at("23"), input: { steps: [{ text: "Do not import", status: "completed" }] } });
  }
  f.item({ threadId: "other", start: at("23"), input: { clear: true } });
  f.item({ start: at("23"), parent: "subagent-item", input: { clear: true } });
  f.item({ start: at("23"), input: { threadId: "other", clear: true } });
  f.item({ start: at("23"), input: { projectRoot: "/other/workspace", clear: true } });
  f.item({ start: at("23"), status: "failed", input: { clear: true } });
  f.item({ start: at("23"), name: "plan_update", toolSource: null, input: { clear: true } });
  f.item({ start: at("23"), name: { toString: "unexpected projection data" }, input: { clear: true } });
  const before = fs.readFileSync(f.dbFile);
  const snapshot = f.snapshot();
  assert.equal(snapshot.source, "t3-mcp-plan-update");
  assert.equal(snapshot.title, "AGY task");
  assert.equal(snapshot.background, "Checklist context");
  assert.deepEqual(snapshot.steps, [{ ...steps[0], status: "in_progress" }]);
  assert.notEqual(f.board.getBoardSnapshot({}).source, "t3-mcp-plan-update", "an unscoped request cannot read projected tool calls");
  assert.deepEqual(fs.readFileSync(f.dbFile), before);
  f.item({ start: at("07"), updated: at("10"), input: { steps } });
  f.item({ type: "mcp_tool_call", start: at("09"), name: "mcp__t3_hub__plan_update", input: { clear: true } });
  const cleared = f.snapshot();
  assert.deepEqual(cleared.steps, []);
  assert.equal(cleared.progress.label, "0/0");
  assert.equal(cleared.emptyPlanReason, "no_explicit_plan");
  f.item({ start: at("11"), name: "plan_update", input: { steps: [{ text: "Fresh after clear", status: "completed" }] } });
  assert.deepEqual(f.snapshot().steps.map((step) => step.text), ["Fresh after clear"]);
});

test("projected clear supersedes older native plans while a newer native plan can reopen the checklist", (t) => {
  const f = boardFixture(t);
  f.db.exec(`CREATE TABLE orchestration_v2_projection_plans (plan_id TEXT, thread_id TEXT, kind TEXT, status TEXT, payload_json TEXT)`);
  const native = (id, updatedAt) => f.db.prepare("INSERT INTO orchestration_v2_projection_plans VALUES (?, 'main', 'todo_list', 'active', ?)")
    .run(id, JSON.stringify({ steps: [{ text: id, status: "completed" }], updatedAt }));
  native("Old native", "2026-11-25T08:00:00Z");
  f.item({ start: "2026-11-25T09:00:00Z", input: { clear: true } });
  assert.equal(f.snapshot().progress.label, "0/0");
  native("New native", "2026-11-25T10:00:00Z");
  assert.equal(f.snapshot().steps[0].text, "New native");
});

function runPlanUpdates(f, updates, hostThreadId) {
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    ...updates.map((args, i) => ({ jsonrpc: "2.0", id: i + 2, method: "tools/call", params: { name: "plan_update", arguments: args } })),
  ];
  const env = { ...process.env, HOME: f.dir, T3CODE_HOME: f.dir, T3_HUB_DIR: path.join(f.dir, "hub") };
  if (hostThreadId) env.T3_THREAD_ID = hostThreadId;
  else delete env.T3_THREAD_ID;
  const run = spawnSync(process.execPath, [path.join(__dirname, "../bin/t3-mcp-router"), "--memory-only"], {
    cwd: f.project, env,
    input: messages.map((message) => JSON.stringify(message)).join("\n") + "\n", encoding: "utf8", timeout: 10_000,
  });
  assert.equal(run.status, 0, run.stderr || String(run.error || ""));
  const replies = new Map(run.stdout.trim().split("\n").map((line) => { const reply = JSON.parse(line); return [reply.id, reply]; }));
  assert.match(replies.get(1).result.tools.find((tool) => tool.name === "plan_update").description, /threadId.*header/);
  return updates.map((_, i) => {
    const reply = replies.get(i + 2);
    assert.ok(reply?.result, JSON.stringify(reply));
    return JSON.parse(reply.result.content[0].text);
  });
}

test("stdio plan_update uses the host thread ID for updates and clears, with explicit ID taking precedence", (t) => {
  const f = boardFixture(t);
  const [bound, explicit, cleared] = runPlanUpdates(f, [
    { steps: [{ text: "Bound", status: "pending" }] },
    { threadId: "explicit", steps: [{ text: "Explicit", status: "completed" }] },
    { clear: true },
  ], "main");
  assert.equal(bound.threadId, "main");
  assert.equal(explicit.threadId, "explicit");
  assert.equal(cleared.deleted, 1);
  assert.deepEqual(f.snapshot().steps, []);
  assert.deepEqual(f.snapshot("explicit").steps.map((step) => step.text), ["Explicit"]);
});

test("stdio plan_update updates and clears only the project checklist when neither source supplies a thread ID", (t) => {
  const f = boardFixture(t);
  f.board.updatePlan({ threadId: "main", projectRoot: f.project, steps: [{ text: "Keep the thread checklist", status: "pending" }] });
  const [updated] = runPlanUpdates(f, [{ steps: [{ text: "Project checklist", status: "pending" }] }]);
  assert.equal(updated.threadId, "");
  assert.equal(updated.projectRoot, f.project);
  assert.equal(f.board.getBoardSnapshot({ projectRoot: f.project }).steps[0].text, "Project checklist");
  const [cleared] = runPlanUpdates(f, [{ clear: true }]);
  assert.equal(cleared.deleted, 1);
  assert.deepEqual(f.board.getBoardSnapshot({ projectRoot: f.project }).steps, []);
  assert.equal(f.snapshot().steps[0].text, "Keep the thread checklist");
});
