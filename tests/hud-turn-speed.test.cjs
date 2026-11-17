"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { DatabaseSync } = require("node:sqlite");

const repo = path.resolve(__dirname, "..");
const rendererSource = fs.readFileSync(path.join(repo, "src/renderer-ui.js"), "utf8");
// These VM cases isolate stats/selection handling; route promotion is covered separately.
const stableRouteStub = "function onRouteMaybeChanged() { return false; }\n";
const home = fs.mkdtempSync(path.join(os.tmpdir(), "hud-turn-speed-home-"));
process.env.HOME = home;
process.env.T3CODE_HOME = path.join(home, "userdata");
process.env.MUSE_DATA_DIR = path.join(home, "muse");
process.env.CODEX_HOME = path.join(home, "codex");
const backend = require(path.join(repo, "src/backend.cjs"));
after(() => fs.rmSync(home, { recursive: true, force: true }));

function extractFunction(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = rendererSource.match(new RegExp(`  function ${escaped}\\([\\s\\S]*?\\n  \\}`));
  assert.ok(match, `missing ${name} in renderer`);
  return vm.runInNewContext(`(${match[0].trim()})`);
}

const createState = extractFunction("createHudTurnSpeedState");
const resolveSpeed = extractFunction("resolveHudTurnSpeed");
const formatSpeed = extractFunction("formatHudTurnSpeed");
const isCurrentStatsSnapshot = extractFunction("isCurrentStatsSnapshot");
const getAssistantStreamSnapshot = extractFunction("getAssistantStreamSnapshot");
const canSampleHudStream = extractFunction("canSampleHudStream");
const createHudStreamSampler = extractFunction("createHudStreamSampler");
const advanceHudStreamSampler = extractFunction("advanceHudStreamSampler");
const estimateRenderedTokens = extractFunction("estimateRenderedTokens");

test("HUD shows the current turn, waits through stale completion data, and resets on thread changes", () => {
  const state = createState("thread-a");
  const idleA = { ok: true, threadId: "thread-a", isRunning: false, stepCount: 2, speed: { lastDecodeTps: 40 } };
  assert.deepEqual(resolveSpeed(state, idleA, null, "thread-a").kind, "turn");
  assert.equal(formatSpeed(resolveSpeed(state, idleA, null, "thread-a"), { approx: "≈", turn: "本轮", waiting: "生成中..." }), "本轮 40.0 tok/s");

  const runningA = { ...idleA, isRunning: true };
  const waiting = resolveSpeed(state, runningA, null, "thread-a");
  assert.equal(waiting.kind, "waiting");
  assert.equal(formatSpeed(waiting, { approx: "≈", turn: "本轮", waiting: "生成中..." }), "生成中...");
  assert.equal(resolveSpeed(state, runningA, 63.5, "thread-a").kind, "estimated");
  assert.equal(formatSpeed(resolveSpeed(state, runningA, 63.5, "thread-a"), { approx: "≈", turn: "本轮", waiting: "生成中..." }), "≈63.5 tok/s");

  const staleCompletion = { ...idleA, stepCount: 2, speed: { lastDecodeTps: 40 } };
  assert.equal(resolveSpeed(state, staleCompletion, null, "thread-a").kind, "none", "old completed-round speed is hidden until this round's stats advance");
  const freshCompletion = { ...idleA, stepCount: 3, speed: { lastDecodeTps: 100 } };
  assert.equal(resolveSpeed(state, freshCompletion, null, "thread-a").value, 100);

  const nextRunning = { ...freshCompletion, isRunning: true };
  assert.equal(resolveSpeed(state, nextRunning, null, "thread-a").kind, "waiting");
  const noOutputRound = { ...freshCompletion, stepCount: 4, speed: { lastDecodeTps: null } };
  assert.equal(resolveSpeed(state, noOutputRound, null, "thread-a").kind, "none", "zero-token or zero-duration rounds never inherit the previous rate");

  const routeBlank = { ok: false, nonThreadRoute: "new" };
  assert.equal(resolveSpeed(state, routeBlank, null, "thread-b").kind, "none", "switching route clears the previous session speed before new stats arrive");
  const idleB = { ok: true, threadId: "thread-b", isRunning: false, stepCount: 1, speed: { lastDecodeTps: 25 } };
  assert.equal(resolveSpeed(state, idleB, null, "thread-b").value, 25);
});

test("late stats responses cannot overwrite the current thread", () => {
  assert.equal(isCurrentStatsSnapshot(1, 2, "thread-a", "thread-b"), false);
  assert.equal(isCurrentStatsSnapshot(2, 2, "thread-a", "thread-b"), false);
  assert.equal(isCurrentStatsSnapshot(2, 2, "thread-b", "thread-b"), true);
});

test("live speed samples only visible assistant output while the backend confirms a running turn", () => {
  const userNode = { dataset: { messageRole: "user", messageId: "user-2" }, innerText: "x".repeat(5000) };
  const assistantNode = {
    dataset: { messageRole: "assistant", messageId: "assistant-1" },
    innerText: "first assistant output",
    getAttribute(name) { return name === "data-message-id" ? this.dataset.messageId : null; },
  };
  const chatCol = {
    nodes: [userNode, assistantNode],
    querySelectorAll(selector) {
      if (selector.includes('data-message-role="assistant"')) {
        return this.nodes.filter((node) => node.dataset.messageRole === "assistant");
      }
      if (selector.includes("data-message-role")) return this.nodes;
      return [];
    },
  };

  const sampler = createHudStreamSampler();
  const idleStats = { ok: true, isRunning: false };
  const initial = getAssistantStreamSnapshot(chatCol);
  assert.equal(initial.text, "first assistant output");
  assert.equal(canSampleHudStream(idleStats, initial), false, "idle DOM growth cannot be treated as model output");
  const idleResult = advanceHudStreamSampler(sampler, initial, 1000, canSampleHudStream(idleStats, initial), estimateRenderedTokens);
  assert.equal(idleResult.liveTps, null);

  const runningStats = { ok: true, isRunning: true };
  const runningSnapshot = getAssistantStreamSnapshot(chatCol);
  assert.equal(canSampleHudStream(runningStats, runningSnapshot), true);
  advanceHudStreamSampler(sampler, runningSnapshot, 1000, true, estimateRenderedTokens);
  assistantNode.innerText += " more assistant output".repeat(12);
  const growingAssistant = getAssistantStreamSnapshot(chatCol);
  const live = advanceHudStreamSampler(sampler, growingAssistant, 1300, true, estimateRenderedTokens);
  assert.ok(live.liveTps > 0, "assistant text growth during a confirmed running turn produces an estimate");

  // A large new user prompt and unrelated non-output DOM growth must not
  // produce a rate after the backend reports the turn idle.
  userNode.innerText += " user prompt growth".repeat(100);
  const idleAfterPrompt = getAssistantStreamSnapshot(chatCol);
  assert.equal(idleAfterPrompt.text, growingAssistant.text, "the prompt node is excluded from the assistant snapshot");
  assert.equal(canSampleHudStream(idleStats, idleAfterPrompt), false);
  const afterPrompt = advanceHudStreamSampler(sampler, idleAfterPrompt, 1600, false, estimateRenderedTokens);
  assert.equal(afterPrompt.liveTps, null, "idle user prompt growth clears any live estimate instead of becoming speed");

  chatCol.nodes = [userNode];
  assert.equal(getAssistantStreamSnapshot(chatCol), null, "no assistant message means no stream sample");
  const noAssistant = advanceHudStreamSampler(sampler, null, 1900, false, estimateRenderedTokens);
  assert.equal(noAssistant.liveTps, null);
});

test("live speed ignores growth in an old assistant message after a new user message arrives", () => {
  const oldAssistant = {
    dataset: { messageRole: "assistant", messageId: "assistant-old" },
    innerText: "old answer",
    getAttribute(name) { return name === "data-message-id" ? this.dataset.messageId : null; },
  };
  const latestUser = {
    dataset: { messageRole: "user", messageId: "user-new" },
    innerText: "new prompt",
    getAttribute(name) { return name === "data-message-id" ? this.dataset.messageId : null; },
  };
  const latestAssistant = {
    dataset: { messageRole: "assistant", messageId: "assistant-new" },
    innerText: "new answer",
    getAttribute(name) { return name === "data-message-id" ? this.dataset.messageId : null; },
  };
  const chatCol = {
    nodes: [oldAssistant, latestUser],
    querySelectorAll(selector) {
      if (selector.includes("data-message-role") && selector.includes("data-message-id")) {
        return this.nodes.filter((node) => node.dataset.messageId);
      }
      if (selector.includes('data-message-role="assistant"')) {
        return this.nodes.filter((node) => node.dataset.messageRole === "assistant");
      }
      if (selector.includes("data-message-role")) return this.nodes;
      return [];
    },
  };

  assert.equal(getAssistantStreamSnapshot(chatCol), null, "a latest user message means the new assistant turn has not started yet");
  assert.equal(canSampleHudStream({ ok: true, isRunning: true }, getAssistantStreamSnapshot(chatCol)), false);

  oldAssistant.innerText += " stale old response growth".repeat(40);
  assert.equal(getAssistantStreamSnapshot(chatCol), null, "growth in a prior assistant answer cannot become current-turn speed");

  chatCol.nodes.push(latestAssistant);
  assert.equal(getAssistantStreamSnapshot(chatCol).messageId, "assistant-new", "sampling resumes only after a new assistant message appears");
});

test("topbar uses per-turn speed while the existing hover panel keeps the session average", () => {
  const topbar = rendererSource.match(/  function renderTopbarStats\([\s\S]*?\n  \}/)?.[0] || "";
  assert.match(topbar, /resolveHudTurnSpeed\(/);
  assert.match(topbar, /formatHudTurnSpeed\(/);
  assert.doesNotMatch(topbar, /resolveModelAvgSpeed\(/, "the topbar cannot fall back to the session average");
  assert.match(topbar, /stats\.cache\.turnRate/, "the main cache chip reads the latest user-turn aggregate");
  assert.doesNotMatch(topbar, /stats\.cache\.displayRate/, "the main chip never falls back to a cumulative cache rate");
  assert.match(rendererSource, /\$\{escapeHtml\(t\("avgDecodeSpeed"\)\)\}/, "the hover details retain their session-average row");
  assert.match(rendererSource, /\$\{escapeHtml\(t\("lastTurnSpeed"\)\)\}/, "the hover details retain their last-turn row");
  for (const key of ["turnCacheRate", "lastCallCacheRate", "mainSessionCacheRate", "inclusiveSessionCacheRate"]) {
    assert.match(rendererSource, new RegExp(`t\\("${key}"\\)`), `cache details expose ${key}`);
  }
  assert.match(rendererSource, /getAssistantStreamSnapshot\(chatCol\)/, "the live sampler reads explicit assistant message nodes");
  assert.match(rendererSource, /canSampleHudStream\(latestStats, assistantSnapshot\)/, "live estimation requires an authoritative running status");
  assert.doesNotMatch(rendererSource, /for \(let i = Math\.max\(0, kids\.length - 2\)/, "arbitrary tail text is never counted as model output");
});

test("backend keeps the session average separate and clears a zero-token latest-turn sample", () => {
  const file = path.join(home, "muse-speed.jsonl");
  const events = [
    { recorded_at: 1_000_000, payload: { event: { kind: "model_response_created" } } },
    { recorded_at: 3_000_000, payload: { event: { kind: "model_completed", model: "speed-model", duration_ms: 3000, usage: { input_tokens: 100, output_tokens: 100, reasoning_tokens: 0 } } } },
    { recorded_at: 4_000_000, payload: { event: { kind: "model_response_created" } } },
    { recorded_at: 6_000_000, payload: { event: { kind: "model_completed", model: "speed-model", duration_ms: 3000, usage: { input_tokens: 100, output_tokens: 200, reasoning_tokens: 0 } } } },
    { recorded_at: 7_000_000, payload: { event: { kind: "model_response_created" } } },
    { recorded_at: 7_000_000, payload: { event: { kind: "model_completed", model: "speed-model", duration_ms: 0, usage: { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0 } } } },
  ];
  fs.writeFileSync(file, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  const stats = backend.readMuseSessionFile(file, "speed-model");
  assert.equal(stats.tokPerSec, 75, "the average remains 300 output tokens / 4 decode seconds");
  assert.equal(stats.lastDecodeTps, null, "the empty latest round cannot reuse the previous 100 tok/s");
  assert.equal(stats.durationSec, null);
  assert.equal(stats.lastStepCacheRate, null);
});

test("Codex clears the latest native-call cache rate when a usage record has no payload", () => {
  const file = path.join(home, "codex-cache.jsonl");
  const records = [
    { timestamp: "2026-11-16T00:00:01.000Z", type: "event_msg", payload: { item: { type: "UserMessage" } } },
    { timestamp: "2026-11-16T00:00:02.000Z", type: "response_item", payload: { type: "reasoning" } },
    { timestamp: "2026-11-16T00:00:04.000Z", type: "token_usage_record", payload: { usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 100 } } },
    { timestamp: "2026-11-16T00:00:05.000Z", type: "event_msg", payload: { item: { type: "UserMessage" } } },
    { timestamp: "2026-11-16T00:00:06.000Z", type: "token_usage_record", payload: {} },
  ];
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  const stats = backend.readCodexSessionFile(file, "codex-cache-model");
  assert.equal(stats.lastStepCacheRate, null, "the blank latest native call is unknown, not the prior 20% rate");
  assert.equal(stats.cached, 200, "the session cache sum remains available");
});

test("remote backend reports each round independently and keeps the mean in tokPerSec", () => {
  const turns = [
    { id: "turn-1", startedMs: 1000, completedMs: 5000, usage: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 100, reasoningTokens: 0 }, streamDecode: { streamSec: 2, visFraction: 1 } },
    { id: "turn-2", startedMs: 6000, completedMs: 10000, usage: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 200, reasoningTokens: 0 }, streamDecode: { streamSec: 2, visFraction: 1 } },
  ];
  const twoRounds = backend.priceRemoteProjection({ threadId: "thread-r", provider: "muse", model: "speed-model", turns, isRunning: false });
  assert.equal(twoRounds.speed.tokPerSec, 75);
  assert.equal(twoRounds.speed.lastDecodeTps, 100);
  assert.equal(twoRounds.speed.durationSec, 2);

  const noOutput = backend.priceRemoteProjection({
    threadId: "thread-r",
    provider: "muse",
    model: "speed-model",
    turns: [...turns, { id: "turn-3", startedMs: 10000, completedMs: 10000, usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 } }],
    isRunning: false,
  });
  assert.equal(noOutput.speed.tokPerSec, 75);
  assert.equal(noOutput.speed.lastDecodeTps, null);
  assert.equal(noOutput.speed.durationSec, null);
  assert.equal(noOutput.cache.turnRate, null, "zero input makes the latest turn cache rate unknown");
  assert.equal(noOutput.cache.sessionRate, 0.2, "the cumulative rate remains available separately");

  const missingUsage = backend.priceRemoteProjection({
    threadId: "thread-r",
    provider: "codex",
    model: "speed-model",
    turns: [
      { id: "turn-1", status: "completed", usage: { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 100 } },
      { id: "turn-2", status: "completed", usage: null },
    ],
    isRunning: false,
  });
  assert.equal(missingUsage.cache.turnRate, null, "a completed turn with no usage cannot inherit a prior turn's rate");
  assert.equal(missingUsage.cache.sessionRate, 0.2);
  for (const [label, usage, expected] of [
    ["missing cache count", { inputTokens: 1000, outputTokens: 100 }, null],
    ["null cache count", { inputTokens: 1000, cachedInputTokens: null, outputTokens: 100 }, null],
    ["explicit zero cache count", { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 100 }, 0],
  ]) {
    const remote = backend.priceRemoteProjection({
      provider: "codex",
      model: "speed-model",
      turns: [{ status: "completed", usage }],
    });
    assert.equal(remote.cache.turnRate, expected, `remote projection distinguishes ${label} from a confirmed zero`);
  }

  const start = rendererSource.indexOf("function toEpochMs(");
  const end = rendererSource.indexOf("// Distinct, clean Git swimlane");
  const fallbackChunk = rendererSource.slice(start, end);
  const { buildLocalProjectionFallback } = new Function(`${fallbackChunk}\nreturn { buildLocalProjectionFallback };`)();
  const localMissingUsage = buildLocalProjectionFallback({
    provider: "codex",
    turns: [
      { status: "completed", usage: { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 100 } },
      { status: "completed", usage: null },
    ],
  });
  assert.equal(localMissingUsage.cache.turnRate, null);
  assert.equal(localMissingUsage.cache.sessionRate, 0.2);

  for (const [label, usage, expected] of [
    ["missing cache count", { inputTokens: 1000, outputTokens: 100 }, null],
    ["null cache count", { inputTokens: 1000, cachedInputTokens: null, outputTokens: 100 }, null],
    ["explicit zero cache count", { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 100 }, 0],
  ]) {
    const localResult = buildLocalProjectionFallback({
      provider: "codex",
      model: "speed-model",
      turns: [{ status: "completed", usage }],
    });
    assert.equal(localResult.cache.turnRate, expected, `local fallback distinguishes ${label} from a confirmed zero`);
  }

  const interruptedUsage = backend.priceRemoteProjection({
    provider: "codex",
    model: "speed-model",
    turns: [
      { status: "completed", usage: { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 100 } },
      { status: "interrupted", usage: null },
    ],
  });
  assert.equal(interruptedUsage.cache.turnRate, null, "an interrupted latest turn is a current unknown sample, not the previous rate");
});

test("context capacity reports its source and does not claim an automatic-compaction threshold", () => {
  const reported = backend.priceRemoteProjection({
    provider: "antigravity",
    model: "gemini-4-hydrogen",
    contextUsage: { usedTokens: 12000, maxTokens: 1048576 },
    turns: [],
  });
  assert.equal(reported.tokens.contextMax, 1048576);
  assert.equal(reported.tokens.contextMaxSource, "reported");

  const estimated = backend.priceRemoteProjection({
    provider: "antigravity",
    model: "gemini-4-hydrogen",
    contextUsage: { usedTokens: 12000 },
    turns: [],
  });
  assert.equal(estimated.tokens.contextMax, 1048576, "the current model-family estimate is preserved");
  assert.equal(estimated.tokens.contextMaxSource, "estimated");

  fs.mkdirSync(process.env.T3CODE_HOME, { recursive: true });
  fs.writeFileSync(path.join(process.env.T3CODE_HOME, "usage-model-rates.json"), JSON.stringify({ document: {
    "codex/catalog-fixture": { max_input_tokens: 777000 },
  } }));
  const catalog = backend.priceRemoteProjection({
    provider: "codex",
    model: "catalog-fixture",
    contextUsage: { usedTokens: 12000 },
    turns: [],
  });
  assert.equal(catalog.tokens.contextMax, 777000);
  assert.equal(catalog.tokens.contextMaxSource, "local-catalog");

  const start = rendererSource.indexOf("function toEpochMs(");
  const end = rendererSource.indexOf("// Distinct, clean Git swimlane");
  const { buildLocalProjectionFallback } = new Function(`${rendererSource.slice(start, end)}\nreturn { buildLocalProjectionFallback };`)();
  const local = buildLocalProjectionFallback({
    provider: "antigravity",
    model: "gemini-4-hydrogen",
    contextUsage: { usedTokens: 12000, maxTokens: 1048576 },
    turns: [],
  });
  assert.equal(local.tokens.contextMaxSource, "reported");
  assert.match(rendererSource, /contextMaxLabel: "模型\/上报容量"/);
  assert.match(rendererSource, /自动压缩阈值：未知/);
  assert.doesNotMatch(rendererSource, /约 26万 自动滑动压缩/);
});

function encodeProtoVarint(value) {
  let n = BigInt(value);
  const out = [];
  while (n > 0x7fn) {
    out.push(Number((n & 0x7fn) | 0x80n));
    n >>= 7n;
  }
  out.push(Number(n));
  return Buffer.from(out);
}

function protoUint(field, value) {
  return Buffer.concat([encodeProtoVarint((field << 3) | 0), encodeProtoVarint(value)]);
}

function protoBytes(field, value) {
  return Buffer.concat([encodeProtoVarint((field << 3) | 2), encodeProtoVarint(value.length), value]);
}

function agyStepMetadata({ uncached, cached, output }) {
  const usage = Buffer.concat([protoUint(2, uncached), protoUint(5, cached), protoUint(10, output)]);
  return protoBytes(9, usage);
}

function createAgyStateDb() {
  const userdata = process.env.T3CODE_HOME;
  fs.mkdirSync(userdata, { recursive: true });
  const db = new DatabaseSync(path.join(userdata, "statev2.sqlite"));
  db.exec(`
    CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, project_id TEXT, title TEXT, default_provider TEXT, updated_at TEXT, payload_json TEXT, archived_at TEXT, deleted_at TEXT);
    CREATE TABLE projection_projects (project_id TEXT, title TEXT, workspace_root TEXT);
    CREATE TABLE orchestration_v2_projection_provider_sessions (provider_session_id TEXT, thread_id TEXT, provider TEXT, status TEXT, model TEXT, updated_at TEXT, payload_json TEXT, driver TEXT);
    CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT, thread_id TEXT, driver TEXT, updated_at TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_provider_turns (provider_turn_id TEXT, thread_id TEXT, ordinal INTEGER, status TEXT, started_at TEXT, completed_at TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_turn_items (thread_id TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_subagents (subagent_id TEXT, thread_id TEXT, driver TEXT, child_thread_id TEXT);
  `);
  db.prepare("INSERT INTO projection_projects VALUES (?,?,?)").run("p1", "fixture", home);
  return db;
}

function insertProjectionThread(db, { threadId, provider, model = "fixture-model", providerThreads = [], turnRows = [] }) {
  const now = new Date().toISOString();
  db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?,?,?,?,?,?)")
    .run(threadId, "p1", threadId, provider, now, JSON.stringify({ modelSelection: { model, provider } }), null, null);
  db.prepare("INSERT INTO orchestration_v2_projection_provider_sessions VALUES (?,?,?,?,?,?,?,?)")
    .run(`${threadId}-session`, threadId, provider, "completed", model, now, "{}", provider);
  const insertProviderThread = db.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?,?,?,?,?)");
  providerThreads.forEach((pt, index) => insertProviderThread.run(
    `${threadId}-provider-thread-${index + 1}`,
    threadId,
    pt.driver,
    pt.updatedAt || now,
    JSON.stringify(pt.payload || {})
  ));
  const insertTurn = db.prepare("INSERT INTO orchestration_v2_projection_provider_turns VALUES (?,?,?,?,?,?,?)");
  turnRows.forEach((turn, index) => {
    const payload = { nativeTurnRef: { driver: turn.driver || provider, ...(turn.nativeId ? { nativeId: turn.nativeId } : {}) } };
    if (Object.hasOwn(turn, "usage")) payload.turnTokenUsage = turn.usage;
    if (turn.model) payload.model = turn.model;
    insertTurn.run(
      `${threadId}-turn-${index + 1}`,
      threadId,
      turn.ordinal ?? index + 1,
      turn.status || "completed",
      turn.startedAt ?? null,
      turn.completedAt ?? null,
      JSON.stringify({ ...payload, ...(turn.payload || {}) })
    );
  });
}

function writeIndexedMuseSession(sessionId, { mtime = Date.now(), output = 100 } = {}) {
  const file = path.join(process.env.MUSE_DATA_DIR, "fixtures", `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const records = [
    { recorded_at: 1_000_000_000_000, payload: { event: { kind: "model_response_created" } } },
    { recorded_at: 1_002_000_000_000, payload: { event: { kind: "model_completed", model: "muse-fixture-model", duration_ms: 2000, usage: { input_tokens: 1000, cache_read_tokens: 200, output_tokens: output, reasoning_tokens: 0 } } } },
  ];
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  fs.utimesSync(file, new Date(mtime), new Date(mtime));

  const indexPath = path.join(process.env.MUSE_DATA_DIR, "session-index.db");
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  const index = new DatabaseSync(indexPath);
  index.exec("CREATE TABLE IF NOT EXISTS sessions (session_id TEXT, session_log_path TEXT)");
  index.prepare("INSERT INTO sessions VALUES (?,?)").run(sessionId, file);
  index.close();
  return file;
}

function writeIndexedCodexSession(sessionId, { contextMax, mtime = 1000 } = {}) {
  const file = path.join(process.env.CODEX_HOME, "sessions", "2026", "11", "16", `fixture-${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const records = [
    { timestamp: "2026-11-16T00:00:01.000Z", type: "event_msg", payload: { type: "token_count", info: { model_context_window: contextMax } } },
    { timestamp: "2026-11-16T00:00:02.000Z", type: "token_usage_record", payload: { model: "codex-fixture-model", usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 100 } } },
  ];
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  fs.utimesSync(file, new Date(mtime), new Date(mtime));
  return file;
}

function writeAgyConversation(convId, calls) {
  const conversations = path.join(process.env.T3CODE_HOME, "providers", "antigravity", "fixture", "antigravity-acp", "conversations");
  fs.mkdirSync(conversations, { recursive: true });
  const file = path.join(conversations, `${convId}.db`);
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE steps (idx INTEGER, step_type INTEGER, metadata BLOB)");
  const insert = db.prepare("INSERT INTO steps VALUES (?,?,?)");
  calls.forEach((call, index) => insert.run(index + 1, 15, call ? agyStepMetadata(call) : Buffer.alloc(0)));
  db.close();
  return file;
}

function insertAgyThread(db, { threadId, convId, turnRows }) {
  const iso = "2026-11-16T00:00:00.000Z";
  db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?,?,?,?,?,?)")
    .run(threadId, "p1", threadId, "antigravity", iso, JSON.stringify({ modelSelection: { model: "gemini-fixture", provider: "antigravity" } }), null, null);
  db.prepare("INSERT INTO orchestration_v2_projection_provider_sessions VALUES (?,?,?,?,?,?,?,?)")
    .run(`${threadId}-session`, threadId, "antigravity", "completed", "gemini-fixture", iso, "{}", "antigravity");
  db.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?,?,?,?,?)")
    .run(`${threadId}-pt`, threadId, "antigravity", iso, JSON.stringify({ nativeThreadRef: { nativeId: convId } }));
  const insertTurn = db.prepare("INSERT INTO orchestration_v2_projection_provider_turns VALUES (?,?,?,?,?,?,?)");
  turnRows.forEach((turn, index) => insertTurn.run(
    `${threadId}-turn-${index + 1}`,
    threadId,
    index + 1,
    turn.status,
    turn.startedAt || iso,
    turn.completedAt || null,
    JSON.stringify({ nativeTurnRef: { driver: "antigravity", nativeId: `${convId}:${index + 1}` }, ...(turn.usage ? { turnTokenUsage: turn.usage } : {}) })
  ));
}

test("Antigravity native SQLite keeps raw per-call cache while turn aggregate stays separate and unknown on an unmetered run", () => {
  const db = createAgyStateDb();
  const convId = "00000000-0000-4000-8000-000000000123";
  // Twenty three native inference calls have a weighted cache rate of 87.53%;
  // the most recent call is 97.27%. Values are raw protobuf uncached/cache fields.
  const calls = [
    ...Array.from({ length: 16 }, () => ({ uncached: 1291, cached: 8709, output: 100 })),
    ...Array.from({ length: 6 }, () => ({ uncached: 1292, cached: 8708, output: 100 })),
    { uncached: 273, cached: 9727, output: 100 },
  ];
  writeAgyConversation(convId, calls);
  const turnUsage = { inputTokens: 230000, cachedInputTokens: 201319, cacheCreationTokens: 0, outputTokens: 2300, reasoningTokens: 0 };
  const threadId = "thread:agy-cache-aggregate";
  insertAgyThread(db, { threadId, convId, turnRows: [{ status: "completed", usage: turnUsage }] });
  db.close();

  const completed = backend.getThreadStats(threadId);
  assert.equal(completed.ok, true, JSON.stringify(completed.error || completed));
  assert.ok(Math.abs(completed.cache.turnRate - 0.8753) < 1e-9, `turn rate=${completed.cache.turnRate}`);
  assert.ok(Math.abs(completed.cache.lastCallRate - 0.9727) < 1e-9, `latest native call=${completed.cache.lastCallRate}`);
  assert.ok(Math.abs(completed.cache.mainSessionRate - 0.8753) < 1e-9, `native cumulative=${completed.cache.mainSessionRate}`);
  assert.equal(completed.cache.withSubagentsSessionRate, completed.cache.mainSessionRate);

  const lowConvId = "00000000-0000-4000-8000-000000000124";
  const lowThreadId = "thread:agy-cache-dedupe";
  writeAgyConversation(lowConvId, [{ uncached: 1200, cached: 800, output: 100 }]);
  const stateDbWithLow = new DatabaseSync(path.join(process.env.T3CODE_HOME, "statev2.sqlite"));
  insertAgyThread(stateDbWithLow, {
    threadId: lowThreadId,
    convId: lowConvId,
    turnRows: [{ status: "completed", usage: { inputTokens: 2000, cachedInputTokens: 800, cacheCreationTokens: 0, outputTokens: 100, reasoningTokens: 0 } }],
  });
  stateDbWithLow.close();
  const lowCache = backend.getThreadStats(lowThreadId);
  assert.equal(lowCache.cache.mainSessionRate, 0.4, "native protobuf f2/f5 remain uncached/cache and are not deduped");
  assert.ok(Math.abs(lowCache.cache.turnRate - 2 / 3) < 1e-9, "T3's doubled input is deduped once for the user-turn aggregate");
  assert.equal(lowCache.cache.lastCallRate, 0.4);

  const missingCallConvId = "00000000-0000-4000-8000-000000000125";
  const missingCallThreadId = "thread:agy-missing-call-usage";
  writeAgyConversation(missingCallConvId, [
    { uncached: 1200, cached: 800, output: 100 },
    null,
  ]);
  const stateDbWithMissingCall = new DatabaseSync(path.join(process.env.T3CODE_HOME, "statev2.sqlite"));
  insertAgyThread(stateDbWithMissingCall, {
    threadId: missingCallThreadId,
    convId: missingCallConvId,
    turnRows: [{ status: "completed", usage: turnUsage }],
  });
  stateDbWithMissingCall.close();
  const missingNativeCall = backend.getThreadStats(missingCallThreadId);
  assert.equal(missingNativeCall.cache.lastCallRate, null, "a typed native inference step without usage clears the previous call rate");
  assert.equal(missingNativeCall.cache.mainSessionRate, 0.4, "the known prior native session total remains intact");

  const stateDb = new DatabaseSync(path.join(process.env.T3CODE_HOME, "statev2.sqlite"));
  stateDb.prepare("INSERT INTO orchestration_v2_projection_provider_turns VALUES (?,?,?,?,?,?,?)")
    .run(`${threadId}-turn-running`, threadId, 2, "running", "2026-11-16T00:01:00.000Z", null,
      JSON.stringify({ nativeTurnRef: { driver: "antigravity", nativeId: `${convId}:2` } }));
  stateDb.close();

  const runningWithoutUsage = backend.getThreadStats(threadId);
  assert.equal(runningWithoutUsage.ok, true);
  assert.equal(runningWithoutUsage.cache.turnRate, null, "an unmetered current turn cannot reuse the previous completed turn rate");
  assert.ok(Math.abs(runningWithoutUsage.cache.lastCallRate - 0.9727) < 1e-9, "the latest raw native call remains available with its own label");
});

test("latest statev2 turn evidence outranks reset ordinals, missing cache fields, and stale native provider samples", () => {
  const dbPath = path.join(process.env.T3CODE_HOME, "statev2.sqlite");
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  const db = createAgyStateDb();
  const oldRate = { inputTokens: 1000, cachedInputTokens: 900, outputTokens: 300 };
  const newRate = { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 100 };

  insertProjectionThread(db, {
    threadId: "thread:turn-order-running",
    provider: "codex",
    turnRows: [
      { ordinal: 264, status: "completed", driver: "codex", startedAt: "2026-11-15T18:27:53.000Z", completedAt: "2026-11-15T18:28:03.000Z", usage: oldRate },
      { ordinal: 13, status: "running", driver: "codex", startedAt: "2026-11-16T15:17:03.000Z" },
    ],
  });
  insertProjectionThread(db, {
    threadId: "thread:turn-order-completed",
    provider: "codex",
    turnRows: [
      { ordinal: 264, status: "completed", driver: "codex", startedAt: "2026-11-15T18:27:53.000Z", completedAt: "2026-11-15T18:28:03.000Z", usage: oldRate },
      { ordinal: 13, status: "completed", driver: "codex", startedAt: "2026-11-16T15:17:03.000Z", completedAt: "2026-11-16T15:17:08.000Z", usage: newRate },
    ],
  });
  insertProjectionThread(db, {
    threadId: "thread:turn-order-interrupted",
    provider: "codex",
    turnRows: [
      { ordinal: 264, status: "completed", driver: "codex", startedAt: "2026-11-15T18:27:53.000Z", completedAt: "2026-11-15T18:28:03.000Z", usage: oldRate },
      { ordinal: 13, status: "interrupted", driver: "codex", startedAt: "2026-11-16T15:17:03.000Z" },
    ],
  });

  for (const [label, usage, expected] of [
    ["missing", { inputTokens: 1000, outputTokens: 100 }, null],
    ["null", { inputTokens: 1000, cachedInputTokens: null, outputTokens: 100 }, null],
    ["explicit zero", { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 100 }, 0],
  ]) {
    insertProjectionThread(db, {
      threadId: `thread:statev2-cache-${label.replaceAll(" ", "-")}`,
      provider: "codex",
      turnRows: [{ status: "completed", driver: "codex", usage }],
    });
    assert.equal(backend.getThreadStats(`thread:statev2-cache-${label.replaceAll(" ", "-")}`).cache.turnRate, expected,
      `statev2 ${label} cache count is distinct from a reported zero`);
  }
  db.close();

  const runningLatest = backend.getThreadStats("thread:turn-order-running");
  assert.equal(runningLatest.cache.turnRate, null, "new running ordinal 13 with no usage outranks old completed ordinal 264");
  const completedLatest = backend.getThreadStats("thread:turn-order-completed");
  assert.equal(completedLatest.cache.turnRate, 0.2, "new completed ordinal 13 supplies the current turn rate");

  const oldNativeId = "native-muse-stale-speed";
  const oldNativeFile = writeIndexedMuseSession(oldNativeId, { mtime: 1000, output: 100 });
  const codexNativeId = "00000000-0000-4000-8000-000000000321";
  const oldCodexFile = writeIndexedCodexSession(codexNativeId, { contextMax: 999000, mtime: 1000 });

  const nativeDb = new DatabaseSync(dbPath);
  insertProjectionThread(nativeDb, {
    threadId: "thread:latest-unknown-speed",
    provider: "muse",
    model: "muse-fixture-model",
    providerThreads: [{ driver: "muse", updatedAt: "2026-11-15T18:00:00.000Z", payload: { nativeThreadRef: { nativeId: oldNativeId } } }],
    turnRows: [
      { ordinal: 1, status: "completed", driver: "muse", startedAt: "2026-11-15T18:00:00.000Z", completedAt: "2026-11-15T18:00:05.000Z", usage: { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 100 } },
      { ordinal: 2, status: "completed", driver: "claudeAgent", model: "claude-opus-4-test" },
    ],
  });
  insertProjectionThread(nativeDb, {
    threadId: "thread:provider-context-does-not-leak",
    provider: "muse",
    model: "muse-fixture-model",
    providerThreads: [{ driver: "muse", updatedAt: "2026-11-15T18:00:00.000Z", payload: {
      nativeThreadRef: { nativeId: oldNativeId },
      contextUsage: { usedTokens: 700, maxTokens: 888 },
    } }],
    turnRows: [
      { ordinal: 1, status: "completed", driver: "muse", startedAt: "2026-11-15T18:00:00.000Z", completedAt: "2026-11-15T18:00:05.000Z", usage: { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 100 } },
      {
        ordinal: 2,
        status: "completed",
        driver: "claudeAgent",
        model: "claude-opus-4-test",
        startedAt: new Date(Date.now() + 1000).toISOString(),
        completedAt: new Date(Date.now() + 3000).toISOString(),
        usage: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 100 },
      },
    ],
  });
  insertProjectionThread(nativeDb, {
    threadId: "thread:reported-context-beats-stale-native",
    provider: "codex",
    model: "codex-fixture-model",
    providerThreads: [{ driver: "codex", updatedAt: new Date(Date.now() + 5000).toISOString(), payload: {
      nativeThreadRef: { nativeId: codexNativeId },
      contextUsage: { usedTokens: 700, maxTokens: 888 },
    } }],
    turnRows: [{
      ordinal: 1,
      status: "completed",
      driver: "codex",
      startedAt: new Date(Date.now() + 1000).toISOString(),
      completedAt: new Date(Date.now() + 3000).toISOString(),
      usage: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 100 },
    }],
  });
  insertProjectionThread(nativeDb, {
    threadId: "thread:claude-does-not-inherit-codex-native-context",
    provider: "codex",
    model: "codex-fixture-model",
    providerThreads: [{ driver: "codex", updatedAt: "2026-11-15T18:00:00.000Z", payload: {
      nativeThreadRef: { nativeId: codexNativeId },
    } }],
    turnRows: [
      { ordinal: 1, status: "completed", driver: "codex", startedAt: "2026-11-15T18:00:00.000Z", completedAt: "2026-11-15T18:00:05.000Z", usage: { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 100 } },
      {
        ordinal: 2,
        status: "completed",
        driver: "claudeAgent",
        model: "claude-opus-4-test",
        startedAt: new Date(Date.now() + 1000).toISOString(),
        completedAt: new Date(Date.now() + 3000).toISOString(),
      },
    ],
  });
  // These fixtures represent a completed provider switch. Persist that current
  // selection too: a selected Muse/Codex session now correctly outranks an old different-driver turn.
  for (const threadId of ["thread:latest-unknown-speed", "thread:provider-context-does-not-leak", "thread:claude-does-not-inherit-codex-native-context"]) {
    nativeDb.prepare("UPDATE orchestration_v2_projection_threads SET payload_json=? WHERE thread_id=?")
      .run(JSON.stringify({ modelSelection: { provider: "claudeAgent", model: "claude-opus-4-test" } }), threadId);
    nativeDb.prepare("UPDATE orchestration_v2_projection_provider_sessions SET driver=?, provider=?, model=? WHERE thread_id=?")
      .run("claudeAgent", "claudeAgent", "claude-opus-4-test", threadId);
  }
  nativeDb.close();

  const latestUnknownSpeed = backend.getThreadStats("thread:latest-unknown-speed");
  assert.equal(latestUnknownSpeed.speed.lastDecodeTps, null, "latest Claude turn without timing/usage cannot inherit Muse's prior 50 tok/s");
  const providerCapacity = backend.getThreadStats("thread:provider-context-does-not-leak");
  assert.notEqual(providerCapacity.tokens.contextMax, 888, "old Muse capacity cannot be labeled as the current Claude capacity");
  assert.notEqual(providerCapacity.tokens.contextMaxSource, "reported", "a different provider's context report is not a current report");
  const reportedCapacityWins = backend.getThreadStats("thread:reported-context-beats-stale-native");
  assert.equal(reportedCapacityWins.tokens.contextMax, 888, "current T3/ACP context report wins over an older native context sample");
  assert.equal(reportedCapacityWins.tokens.contextMaxSource, "reported");
  const noCrossProviderCapacity = backend.getThreadStats("thread:claude-does-not-inherit-codex-native-context");
  assert.equal(noCrossProviderCapacity.tokens.contextMax, null, "Claude without a current capacity report cannot inherit old Codex native 999000");
  assert.equal(noCrossProviderCapacity.tokens.contextMaxSource, null, "cross-provider capacity remains unknown instead of mislabeled reported");
  const interruptedLatest = backend.getThreadStats("thread:turn-order-interrupted");
  assert.equal(interruptedLatest.cache.turnRate, null, "an interrupted ordinal 13 with no usage supersedes old ordinal 264");
  fs.accessSync(oldNativeFile);
  fs.accessSync(oldCodexFile);
});


// R7–R12 exercise the production functions with deterministic DOM/clock/transport fakes.
function telemetryDomNode(attrs, text = "", children = []) {
  const node = {
    nodeType: 1, tagName: "DIV", style: {}, innerText: text, textContent: text,
    childNodes: { ...children, length: children.length, [Symbol.iterator]: children[Symbol.iterator].bind(children) },
    getAttribute(name) { return attrs[name] ?? null; },
    querySelectorAll() { return children; },
  };
  for (const child of children) child.parentElement = node;
  return node;
}
function telemetryColumn(nodes) {
  return { querySelectorAll(selector) { return nodes.filter(n => n.getAttribute("data-message-role") || (selector.includes("thinking") && n.getAttribute("data-timeline-row-kind") === "thinking")); } };
}
function telemetryRendererHarness(nodes, stats = { ok: true, provider: "codex", isRunning: false }) {
  const context = vm.createContext({
    document: { hidden: false, querySelector: () => telemetryColumn(nodes) },
    performance: { now: () => 2000 }, setTimeout: () => 1, clearTimeout() {},
  });
  const funcs = ["createHudTurnSpeedState", "resolveHudTurnSpeed", "getAssistantStreamSnapshot", "createHudStreamSampler", "resetLiveStreamSampler"]
    .map(name => rendererSource.match(new RegExp(`  function ${name}\\([\\s\\S]*?\\n  \\}`))[0]).join("\n");
  const clearSamples = rendererSource.match(/  function clearActiveStreamSamples\([\s\S]*?\n  \}/)?.[0] || "";
  const topbar = rendererSource.slice(rendererSource.indexOf("  function renderTopbarStats("), rendererSource.indexOf("    const qInfo = computeQuotaAndContext(stats);")) + "return speedView;\n}";
  vm.runInContext(`let currentPathHint='r7', streamRouteSnap='r7', latestStats=null, liveStreamTps=null;
    let lastIdleMessageId='',lastIdleTextLen=0,lastFastRefreshAt=0;
    ${funcs}\n${clearSamples}\nlet streamSampler=createHudStreamSampler(),turnSpeedState=createHudTurnSpeedState('r7');\n${topbar}`, context);
  context.stats = stats;
  return { context, run: code => vm.runInContext(code, context) };
}

test("R7: empty baseline never authorizes bare/unconfirmed first-frame speed", () => {
  const running = { ok: true, provider: "codex", isRunning: true, speed: {} };
  for (const sample of [undefined, true, { messageId: "", liveSampleConfirmedNewTurn: true }, { messageId: "arbitrary-old", liveSampleConfirmedNewTurn: false }]) {
    assert.equal(resolveSpeed(createState("r7"), running, 70, "r7", sample).kind, "waiting");
  }
  const unobserved = createState("r7");
  assert.equal(unobserved.baselineCaptured, false);
  assert.equal(resolveSpeed(unobserved, running, 70, "r7", { messageId: "old", liveSampleConfirmedNewTurn: true }).kind, "waiting");
  const captured = createState("r7");
  captured.baselineCaptured = true;
  assert.equal(resolveSpeed(captured, running, 70, "r7", { messageId: "new", liveSampleConfirmedNewTurn: true }).value, 70);
  const conflict = createState("r7");
  Object.assign(conflict, { baselineCaptured: true, baselineProvider: "codex" });
  assert.equal(resolveSpeed(conflict, { ...running, provider: "muse" }, 70, "r7", { messageId: "new", liveSampleConfirmedNewTurn: true }).kind, "waiting");
});

test("R7: render synchronously captures empty/final idle baseline and clears the completed sampler", () => {
  const nodes = [telemetryDomNode({ "data-message-role": "user", "data-message-id": "u" })];
  const h = telemetryRendererHarness(nodes);
  h.run("renderTopbarStats(stats)");
  assert.equal(h.run("turnSpeedState.baselineCaptured"), true);
  assert.equal(h.run("turnSpeedState.baselineMessageId"), "");
  nodes.push(telemetryDomNode({ "data-message-role": "assistant", "data-message-id": "final" }, "done"));
  h.run("turnSpeedState.active=true; liveStreamTps=70; streamSampler.messageId='final'; streamSampler.liveTps=70; renderTopbarStats(stats)");
  assert.equal(h.run("liveStreamTps"), null);
  assert.equal(h.run("streamSampler.messageId"), "");
  assert.equal(h.run("turnSpeedState.baselineMessageId"), "final");
  h.run("stats.isRunning=true");
  assert.equal(h.run("renderTopbarStats(stats).kind"), "waiting", "next turn before 260ms tick cannot reuse 70");
});

test("R7: topbar proof requires sampler growth rather than an arbitrary new ID", () => {
  const h = telemetryRendererHarness([]);
  h.run("renderTopbarStats(stats); stats.isRunning=true; liveStreamTps=70; streamSampler.messageId='arbitrary'");
  assert.equal(h.run("renderTopbarStats(stats).kind"), "waiting");
});

test("R10: independent thinking rows join assistant text under a stable current-turn anchor", () => {
  const old = telemetryDomNode({ "data-message-role": "assistant", "data-message-id": "old" }, "OLD");
  const user = telemetryDomNode({ "data-message-role": "user", "data-message-id": "user" });
  const thinking = telemetryDomNode({ "data-timeline-row-kind": "thinking", "data-timeline-row-id": "thought" }, "thinking grows");
  const nodes = [old, user, thinking];
  const first = getAssistantStreamSnapshot(telemetryColumn(nodes));
  assert.ok(first, "a thinking-only current turn is streamable");
  assert.equal(first.text, "thinking grows");
  assert.ok(first.messageId.includes("thought"));
  nodes.push(telemetryDomNode({ "data-message-role": "assistant", "data-message-id": "answer" }, "answer grows"));
  const second = getAssistantStreamSnapshot(telemetryColumn(nodes));
  assert.equal(second.messageId, first.messageId);
  assert.ok(second.text.includes("thinking grows"));
  assert.ok(second.text.includes("answer grows"));
  assert.ok(!second.text.includes("OLD"));
  nodes.push(telemetryDomNode({ "data-message-role": "user", "data-message-id": "next" }));
  assert.equal(getAssistantStreamSnapshot(telemetryColumn(nodes)), null);
  assert.ok(getAssistantStreamSnapshot(telemetryColumn([thinking])), "history without user rows still samples thinking");
});

test("R11: real NodeList recursion filters aria/CSS/closed details, including extras", () => {
  const aria = telemetryDomNode({ "aria-hidden": "true" }, "ARIA");
  const css = telemetryDomNode({}, "CSS");
  css.ownerDocument = { defaultView: { getComputedStyle: () => ({ display: "none" }) } };
  const collapse = telemetryDomNode({}, "COLLAPSE");
  collapse.ownerDocument = { defaultView: { getComputedStyle: () => ({ visibility: "collapse" }) } };
  const details = telemetryDomNode({}, "CLOSED"); details.tagName = "DETAILS";
  const visible = telemetryDomNode({}, "visible");
  const root = telemetryDomNode({ "data-message-role": "assistant", "data-message-id": "r11" }, "visibleARIACSSCOLLAPSECLOSED", [visible, aria, css, collapse, details]);
  assert.equal(getAssistantStreamSnapshot(telemetryColumn([root])).text, "visible");
  const allHidden = telemetryDomNode({ "data-message-role": "assistant", "data-message-id": "r11b" }, "ARIA", [aria]);
  assert.equal(getAssistantStreamSnapshot(telemetryColumn([allHidden])).text, "", "empty filtered children must never fall back to container text");
  const hiddenRow = telemetryDomNode({ "data-message-role": "assistant", "aria-hidden": "true" }, "HIDDEN-ROW");
  assert.equal(getAssistantStreamSnapshot(telemetryColumn([hiddenRow])), null);
});

test("R12: trailing refresh does not schedule timers while in flight and resumes from finally", async () => {
  const timers = [];
  const ctx = vm.createContext({ document: { hidden: false }, performance: { now: () => 2000 }, setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {} });
  const scheduler = rendererSource.match(/  function scheduleTrailingFastRefresh\([\s\S]*?\n  \}/)[0];
  vm.runInContext(`let trailingFastRefreshTimer=null,lastFastRefreshAt=0,statsInFlight=true,pendingFastRefresh=true,disposed=false,calls=0;
    function refreshStats(){calls++}\n${scheduler}\nscheduleTrailingFastRefresh();`, ctx);
  assert.equal(timers.length, 0, "in-flight work must have no timer polling");
  vm.runInContext("statsInFlight=false;scheduleTrailingFastRefresh();statsInFlight=true", ctx);
  assert.equal(timers.length, 1);
  timers.shift()();
  assert.equal(timers.length, 0, "timer firing during an RPC must not recursively reschedule");
  assert.equal(vm.runInContext("pendingFastRefresh", ctx), true);
  vm.runInContext("statsInFlight=false;scheduleTrailingFastRefresh()", ctx);
  timers.shift()();
  assert.equal(vm.runInContext("calls", ctx), 1);
  let finish;
  ctx.callBackend = () => new Promise(resolve => { finish = resolve; });
  Object.assign(ctx, { getRouteHint: () => "r", isCurrentStatsSnapshot: () => false });
  const refresh = stableRouteStub + rendererSource.match(/  async function refreshStats\([\s\S]*?\n  \}/)[0];
  vm.runInContext(`let statsRequestSeq=0;${refresh}; pendingFastRefresh=true; trailingFastRefreshTimer=null;`, ctx);
  const pending = vm.runInContext("refreshStats(false)", ctx);
  finish({ ok: true });
  await pending;
  assert.equal(timers.length, 1, "RPC completion must schedule the pending trailing refresh");
});

test("R12: hung bridge and both fetch transports time out, abort, and clear timers", async () => {
  const source = rendererSource.match(/  async function callBackend\([\s\S]*?\n  \}/)[0];
  for (const transport of ["bridge", "http", "override"]) {
    const timers = new Map(); let serial = 0; let signal;
    const window = transport === "bridge" ? { __t3HudBridge: { hung: () => new Promise(() => {}) } }
      : transport === "http" ? { __t3HudHttpConfig: { url: "http://test", token: "fixture" } } : { __t3HudOverrideRpc: { url: "http://test", token: "fixture" } };
    const ctx = vm.createContext({ window, AbortController,
      fetch: (_url, options) => { signal = options.signal; return new Promise(() => {}); },
      setTimeout: (fn, ms) => { assert.ok(ms > 0 && ms <= 8000); timers.set(++serial, fn); return serial; },
      clearTimeout: id => timers.delete(id),
    });
    const call = vm.runInContext(`(${source.trim()})`, ctx);
    let settled = false;
    const pending = call("hung").then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    assert.equal(timers.size, 1, `${transport}: must arm a bounded RPC timeout`);
    for (const fn of [...timers.values()]) fn();
    for (let i=0; i<12; i++) await Promise.resolve();
    assert.equal(settled, true, `${transport}: must settle even if transport ignores abort`);
    await pending;
    assert.equal(timers.size, 0, `${transport}: timeout must be cleared`);
    if (transport !== "bridge") assert.equal(signal.aborted, true);
  }
});


test("R7: route changes retain the newly captured idle baseline and provider changes drop old live rates", () => {
  const nodes = [telemetryDomNode({ "data-message-role": "assistant", "data-message-id": "idle" }, "idle")];
  const h = telemetryRendererHarness(nodes);
  h.run("currentPathHint='new-route';renderTopbarStats(stats)");
  assert.equal(h.run("turnSpeedState.baselineCaptured"), true);
  assert.equal(h.run("turnSpeedState.baselineMessageId"), "idle");
  h.run("stats.isRunning=true; renderTopbarStats(stats); liveStreamTps=70; streamSampler.messageId='codex-live'; streamSampler.liveTps=70");
  assert.equal(h.run("renderTopbarStats(stats).value"), 70);
  h.run("stats.provider='muse'");
  assert.equal(h.run("renderTopbarStats(stats).kind"), "waiting");
  assert.equal(h.run("liveStreamTps"), null);
});

test("R7: idle watcher captures an empty snapshot even before any stats response", () => {
  const h = telemetryRendererHarness([]);
  const watcher = rendererSource.match(/  const streamWatchTimer = setInterval\(\(\) => \{[\s\S]*?\n  \}, 260\);/)[0];
  Object.assign(h.context, { setInterval: fn => { h.context.tick = fn; }, getRouteHint: () => "r7", disposed: false,
    advanceHudStreamSampler, canSampleHudStream, estimateRenderedTokens });
  h.run(watcher);
  h.context.tick();
  assert.equal(h.run("turnSpeedState.baselineCaptured"), true);
  assert.equal(h.run("turnSpeedState.baselineMessageId"), "");
});

test("R12: successful/rejected RPCs clear their deadline and override failure falls back within the same deadline", async () => {
  const source = rendererSource.match(/  async function callBackend\([\s\S]*?\n  \}/)[0];
  for (const fail of [false, true]) {
    const timers = new Map();
    const ctx = vm.createContext({ window: { __t3HudOverrideRpc: { url: "http://fixture", token: "test" }, __t3HudBridge: { run: () => fail ? Promise.reject(new Error("fixture rejection")) : Promise.resolve(42) } },
      fetch: () => Promise.reject(new Error("override offline")), AbortController,
      setTimeout: fn => { timers.set(1, fn); return 1; }, clearTimeout: id => timers.delete(id) });
    const call = vm.runInContext(`(${source.trim()})`, ctx);
    if (fail) await assert.rejects(call("run"), /fixture rejection/);
    else assert.equal(await call("run"), 42);
    assert.equal(timers.size, 0);
  }
});


test("R8: switched provider cannot inherit native Codex cache, model, speed or context", () => {
  const dbPath = path.join(process.env.T3CODE_HOME, "statev2.sqlite");
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(dbPath + suffix, { force: true });
  const db = createAgyStateDb();
  const stamp = Date.parse("2026-11-16T00:00:00Z").toString(16).padStart(12, "0");
  const sessionId = `${stamp.slice(0, 8)}-${stamp.slice(8)}-7000-8000-000000000008`;
  writeIndexedCodexSession(sessionId, { contextMax: 20000 });
  insertProjectionThread(db, {
    threadId: "thread:r8-native", provider: "muse", model: "current-muse",
    providerThreads: [{ driver: "codex", payload: { nativeThreadRef: { nativeId: sessionId }, contextUsage: { usedTokens: 900, maxTokens: 20000 } } }],
    turnRows: [{ driver: "codex", status: "running", startedAt: "2026-11-16T00:00:00Z", usage: { inputTokens: 1000, cachedInputTokens: 900, outputTokens: 270 } }],
  });
  db.close();
  const result = backend.getThreadStats("thread:r8-native");
  assert.equal(result.ok, true, result.error);
  assert.equal(result.telemetrySource, "native");
  assert.equal(result.provider, "muse");
  assert.equal(result.model, "current-muse");
  assert.equal(result.isRunning, false);
  assert.equal(result.cache.turnRate, null);
  assert.equal(result.cache.lastCallRate, null);
  assert.equal(result.speed.lastDecodeTps, null);
  assert.equal(result.speed.currentTurnEstimateTps, null);
  assert.equal(result.speed.durationSec, null);
  assert.equal(result.tokens.contextUsed, null);
  assert.equal(result.tokens.contextMax, 1007997);
  assert.ok(result.tokens.output > 0);
});

test("R15: repeated idle render/tick round trips never trigger fast refresh for unchanged text", () => {
  const h = telemetryRendererHarness([telemetryDomNode({ "data-message-role": "assistant", "data-message-id": "idle" }, "unchanged")]);
  const timers = []; let refreshes = 0; let now = 2000;
  Object.assign(h.context, { setInterval: fn => { h.context.tick = fn; }, getRouteHint: () => "r7", disposed: false,
    performance: { now: () => now },
    advanceHudStreamSampler, canSampleHudStream, estimateRenderedTokens,
    setTimeout: fn => { timers.push(fn); return timers.length; }, refreshStats: () => { refreshes++; } });
  h.run(`let pendingFastRefresh=false,trailingFastRefreshTimer=null,statsInFlight=false;
    ${rendererSource.match(/  function scheduleTrailingFastRefresh\([\s\S]*?\n  \}/)[0]}
    ${rendererSource.match(/  const streamWatchTimer = setInterval\(\(\) => \{[\s\S]*?\n  \}, 260\);/)[0]}
    lastFastRefreshAt=1234;`);
  for (let i=0; i<12; i++) {
    now += 260;
    h.run("renderTopbarStats(stats)"); h.context.tick();
    while (timers.length) timers.shift()();
  }
  assert.equal(refreshes, 0);
  assert.equal(h.run("lastFastRefreshAt"), 1234);
  assert.equal(h.run("lastIdleMessageId"), "idle");
  assert.equal(h.run("lastIdleTextLen"), 9);
});

test("R18: no-user DOM must prove a turn boundary or return null; a lone unbounded row cannot reuse baseline growth", () => {
  const row = (id, text, turn) => telemetryDomNode({ "data-message-role": "assistant", "data-message-id": id, ...(turn ? { "data-turn-id": turn } : {}) }, text);
  const old = row("old", "OLD OUTPUT");
  const thinking = telemetryDomNode({ "data-timeline-row-kind": "thinking", "data-timeline-row-id": "new" }, "NEW THINKING");
  assert.equal(getAssistantStreamSnapshot(telemetryColumn([old, thinking])), null);
  assert.equal(getAssistantStreamSnapshot(telemetryColumn([old, row("a", "A")])), null);
  const hiddenOld = row("hidden-old", "hidden"); hiddenOld.style.display = "none";
  assert.equal(getAssistantStreamSnapshot(telemetryColumn([hiddenOld, thinking])), null, "hidden history also leaves the boundary unproven");
  const identified = [row("old", "OLD", "t0"), row("first", "FIRST", "t1"), row("last", "LAST", "t1")];
  const snap = getAssistantStreamSnapshot(telemetryColumn(identified));
  assert.equal(snap.text, "FIRST\nLAST"); assert.equal(snap.messageId, "first");
  const lone = getAssistantStreamSnapshot(telemetryColumn([thinking]));
  assert.equal(lone.unboundedNoUser, true);
  const nodes = [thinking]; const h = telemetryRendererHarness(nodes);
  Object.assign(h.context, { setInterval: fn => { h.context.tick = fn; }, getRouteHint: () => "r7", disposed: false,
    advanceHudStreamSampler, canSampleHudStream, estimateRenderedTokens });
  h.run("renderTopbarStats(stats);stats.isRunning=true;renderTopbarStats(stats)");
  h.run(rendererSource.match(/  const streamWatchTimer = setInterval\(\(\) => \{[\s\S]*?\n  \}, 260\);/)[0]);
  h.context.tick();
  thinking.innerText += " growing old text".repeat(20); h.context.tick();
  assert.equal(h.run("streamSampler.samples.length"), 0);
  assert.equal(h.run("liveStreamTps"), null);
});

test("R19: rejected/timed-out stats degrade through pricing to local projection and reject stale routes", async () => {
  const refresh = stableRouteStub + rendererSource.match(/  async function refreshStats\([\s\S]*?\n  \}/)[0];
  for (const changeAt of [null, "stats", "price"]) {
    for (const priceFails of [false, true]) {
      const calls = []; const renders = []; let reads = 0; let route = "r19";
      const ctx = vm.createContext({ getRouteHint: () => route, isCurrentStatsSnapshot,
        callBackend: async method => { calls.push(method); if (method === "getThreadStats") { if (changeAt === "stats") route = "other"; throw new Error("rpc_timeout:getThreadStats"); }
          if (changeAt === "price") route = "other";
          if (priceFails) throw new Error("rpc_timeout:priceRemoteProjection"); return { ok: true, source: "priced" }; },
        readFiberThreadProjection: () => { reads++; return { threadId: "r19", isRunning: true, turns: [] }; },
        buildLocalProjectionFallback: () => ({ ok: true, source: "local" }), renderTopbarStats: stats => renders.push(stats),
        document: { hidden: false } });
      vm.runInContext(`let statsInFlight=false,statsRequestSeq=0,pendingFastRefresh=false,disposed=false,drawerOpen=false,lastLoadedGraphThreadId=null,lastRemotePayload=null;${refresh}`, ctx);
      await vm.runInContext("refreshStats(false)", ctx);
      assert.equal(reads, changeAt === "stats" ? 0 : 1);
      assert.equal(renders.length, changeAt ? 0 : 1);
      if (!changeAt) assert.equal(renders[0].source, priceFails ? "local" : "priced");
      assert.equal(vm.runInContext("statsInFlight", ctx), false);
    }
  }
});

test("R13: native-only history without any provider turn cannot override a newly selected provider", () => {
  const dbPath = path.join(process.env.T3CODE_HOME, "statev2.sqlite");
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(dbPath + suffix, { force: true });
  const db = createAgyStateDb();
  const stamp = Date.parse("2026-11-16T00:00:00Z").toString(16).padStart(12, "0");
  const sessionId = `${stamp.slice(0, 8)}-${stamp.slice(8)}-7000-8000-000000000013`;
  writeIndexedCodexSession(sessionId, { contextMax: 20000 });
  const id = "thread:r13-native-only";
  insertProjectionThread(db, { threadId: id, provider: "muse", model: "current-muse",
    providerThreads: [{ driver: "codex", payload: { nativeThreadRef: { nativeId: sessionId }, contextUsage: { usedTokens: 9999, maxTokens: 20000 } } }] });
  // No provider_turns at all: only stale native history and an old session remain.
  db.prepare("UPDATE orchestration_v2_projection_provider_sessions SET driver='codex',provider='codex',model='old-codex',status='running',updated_at='2026-11-16T00:00:00Z'").run();
  db.close();
  const stats = backend.getThreadStats(id);
  assert.equal(stats.ok, true, stats.error); assert.equal(stats.provider, "muse"); assert.equal(stats.model, "current-muse");
  assert.equal(stats.telemetrySource, "native"); assert.ok(stats.tokens.output > 0);
  assert.equal(stats.isRunning, false); assert.equal(stats.cache.turnRate, null); assert.equal(stats.cache.lastCallRate, null);
  for (const k of ["lastDecodeTps", "currentTurnEstimateTps", "durationSec"]) assert.equal(stats.speed[k], null, k);
  assert.equal(stats.tokens.contextUsed, null); assert.notEqual(stats.tokens.contextMax, 20000);
});

test("R24: HUD mounted mid-stream without idle baseline never samples a lone unbounded row", () => {
  const orphan = telemetryDomNode({ "data-message-role": "assistant", "data-message-id": "unbounded" }, "old");
  const h = telemetryRendererHarness([orphan], { ok: true, provider: "codex", isRunning: true, speed: {} });
  let now = 1000;
  Object.assign(h.context, {
    setInterval: fn => { h.context.tick = fn; },
    getRouteHint: () => "r7",
    disposed: false,
    performance: { now: () => now },
    advanceHudStreamSampler,
    canSampleHudStream,
    estimateRenderedTokens,
  });
  h.run("renderTopbarStats(stats)");
  h.run(rendererSource.match(/  const streamWatchTimer = setInterval\(\(\) => \{[\s\S]*?\n  \}, 260\);/)[0]);
  h.context.tick();
  now += 260;
  orphan.innerText += " x".repeat(30);
  h.context.tick();
  assert.equal(h.run("turnSpeedState.baselineCaptured"), false);
  assert.equal(h.run("streamSampler.samples.length"), 0);
  assert.equal(h.run("liveStreamTps"), null);
  assert.equal(h.run("renderTopbarStats(stats)").kind, "waiting");
});

test("R25: newly selected provider never inherits unattributed stale live contextWindow usedTokens", () => {
  const fn = rendererSource.match(/  function computeQuotaAndContext\([\s\S]*?\n  \}/)[0];
  const ctx = vm.createContext({
    readLiveT3State: () => ({
      usage: null,
      contextWindow: { usedTokens: 9999, maxTokens: 20000 },
      selectedProvider: "muse",
      selectedModel: "new-muse",
    }),
  });
  vm.runInContext(fn, ctx);
  const s = { ok: true, provider: "muse", tokens: { contextUsed: null, contextMax: 1007997, contextMaxSource: "estimated" }, cache: {} };
  const got = ctx.computeQuotaAndContext(s);
  assert.equal(got.ctxUsed, null);
  assert.equal(got.ctxMax, 1007997);
});

test("R26: same-thread provider switch while refreshStats is in flight discards stale response and queues re-fetch", async () => {
  const refresh = stableRouteStub + rendererSource.match(/  async function refreshStats\([\s\S]*?\n  \}/)[0];
  let selectedProvider = "codex", finish, trailingScheduled = 0;
  const rendered = [];
  const previous = { ok: true, provider: "codex", model: "old-model", isRunning: false, cache: { turnRate: 0.9 }, tokens: { contextUsed: 9999 } };
  const ctx = vm.createContext({
    getRouteHint: () => "same-thread",
    isCurrentStatsSnapshot,
    callBackend: () => new Promise(resolve => { finish = resolve; }),
    readLiveT3State: () => ({ selectedProvider }),
    scheduleTrailingFastRefresh: () => { trailingScheduled++; },
    renderTopbarStats: s => rendered.push(s),
    document: { hidden: false },
  });
  vm.runInContext(`let statsInFlight=false,statsRequestSeq=0,pendingFastRefresh=false,disposed=false,drawerOpen=false,lastLoadedGraphThreadId=null,lastRemotePayload=null;${refresh}`, ctx);
  const request = vm.runInContext("refreshStats(false)", ctx);
  selectedProvider = "muse";
  finish(previous);
  await request;
  assert.equal(rendered.length, 0);
  assert.equal(vm.runInContext("pendingFastRefresh", ctx), true);
  assert.equal(trailingScheduled, 1);
});

test("R27: mutating Hub RPC writes are not aborted by the 8s HUD read deadline while read-only Hub RPCs stay bounded", async () => {
  const call = rendererSource.match(/  async function callBackend\([\s\S]*?\n  \}/)[0];
  const wrapper = rendererSource.slice(rendererSource.indexOf("  const callRpc = "), rendererSource.indexOf("  function formatCompactTokens("));
  const timers = new Map();
  let serial = 0, releaseWrite, writeCompleted = false;
  const window = {
    __t3HudBridge: {
      getGitGraph: async (_tag, action) => {
        if (action === "skills:importGitHub") {
          await new Promise(resolve => { releaseWrite = resolve; });
          writeCompleted = true;
          return { ok: true, imported: true };
        }
        return new Promise(() => {});
      },
    },
  };
  const ctx = vm.createContext({
    window,
    AbortController,
    setTimeout: fn => { timers.set(++serial, fn); return serial; },
    clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(`${call}\n${wrapper}`, ctx);
  const writeReq = window.__t3HubRpc("skills:importGitHub", { url: "https://example.invalid/fixture" });
  assert.equal(timers.size, 0, "mutating Hub write must not arm 8s read timeout");
  releaseWrite();
  const writeRes = await writeReq;
  assert.equal(writeCompleted, true);
  assert.deepEqual(writeRes, { ok: true, imported: true });

  const readReq = window.__t3HubRpc("hub:getDrawerScript", {});
  await Promise.resolve();
  assert.equal(timers.size, 1, "read-only Hub query keeps bounded timeout");
  for (const fn of [...timers.values()]) fn();
  await assert.rejects(readReq, /HUD RPC timed out/);
});

test("R28: an identified old turn growing while a new turn is running never produces live stream speed", () => {
  const old = telemetryDomNode({ "data-message-role": "assistant", "data-message-id": "old-message", "data-turn-id": "old-turn" }, "old");
  const h = telemetryRendererHarness([old]);
  let now = 1000;
  Object.assign(h.context, {
    setInterval: fn => { h.context.tick = fn; },
    getRouteHint: () => "r7",
    disposed: false,
    performance: { now: () => now },
    advanceHudStreamSampler,
    canSampleHudStream,
    estimateRenderedTokens,
  });
  h.run("renderTopbarStats(stats); stats.isRunning=true; renderTopbarStats(stats)");
  h.run(rendererSource.match(/  const streamWatchTimer = setInterval\(\(\) => \{[\s\S]*?\n  \}, 260\);/)[0]);
  h.context.tick();
  now += 260;
  old.innerText += " more old output".repeat(4);
  h.context.tick();
  assert.equal(h.run("turnSpeedState.baselineMessageId"), "old-message");
  assert.equal(h.run("streamSampler.samples.length"), 0);
  assert.equal(h.run("liveStreamTps"), null);
  assert.equal(h.run("renderTopbarStats(stats)").kind, "waiting");
});

test("R34: an identified old-turn DOM row mounting and growing after an empty idle baseline never produces live stream speed", () => {
  const nodes = [];
  const h = telemetryRendererHarness(nodes, { ok: true, provider: "codex", isRunning: false, activeTurnIds: [], speed: {} });
  let now = 1000;
  Object.assign(h.context, {
    setInterval: fn => { h.context.tick = fn; },
    getRouteHint: () => "r7",
    disposed: false,
    performance: { now: () => now },
    advanceHudStreamSampler,
    canSampleHudStream,
    estimateRenderedTokens,
  });
  h.run("renderTopbarStats(stats); stats.isRunning=true; stats.activeTurnIds=['new-turn']; renderTopbarStats(stats)");
  h.run(rendererSource.match(/  const streamWatchTimer = setInterval\(\(\) => \{[\s\S]*?\n  \}, 260\);/)[0]);
  const user = telemetryDomNode({ "data-message-role": "user", "data-message-id": "u-1" }, "prompt");
  const old = telemetryDomNode({ "data-message-role": "assistant", "data-message-id": "old-message", "data-turn-id": "old-turn" }, "old");
  nodes.push(user, old);
  h.context.tick();
  now += 260;
  old.innerText += " late hydrated old turn text".repeat(8);
  h.context.tick();
  assert.equal(h.run("streamSampler.samples.length"), 0);
  assert.equal(h.run("liveStreamTps"), null);
  assert.equal(h.run("renderTopbarStats(stats)").kind, "waiting");

  // Also when activeTurnIds is omitted in harness, an identified turnId without activeTurnIds match is rejected
  h.run("delete stats.activeTurnIds");
  now += 260;
  old.innerText += " more text".repeat(8);
  h.context.tick();
  assert.equal(h.run("streamSampler.samples.length"), 0);
  assert.equal(h.run("liveStreamTps"), null);
});

test("R35: mid-flight provider selection when requestedProvider started empty discards pre-switch response and schedules trailing refresh", async () => {
  const refresh = stableRouteStub + rendererSource.match(/  async function refreshStats\([\s\S]*?\n  \}/)[0];
  let selectedProvider = "", finish, trailingScheduled = 0;
  const rendered = [];
  const staleCodex = {
    ok: true,
    provider: "codex",
    model: "old-codex",
    isRunning: true,
    speed: { lastDecodeTps: 42, currentTurnEstimateTps: 38, durationSec: 2 },
    cache: { turnRate: 0.9, sessionRate: 0.8 },
    tokens: { contextUsed: 9999, contextMax: 20000, contextMaxSource: "reported" },
  };
  const ctx = vm.createContext({
    getRouteHint: () => "same-thread",
    isCurrentStatsSnapshot,
    callBackend: () => new Promise(resolve => { finish = resolve; }),
    readLiveT3State: () => ({ selectedProvider, selectedModel: selectedProvider ? "new-muse" : null }),
    scheduleTrailingFastRefresh: () => { trailingScheduled++; },
    renderTopbarStats: s => rendered.push(s),
    document: { hidden: false },
  });
  vm.runInContext(`let statsInFlight=false,statsRequestSeq=0,pendingFastRefresh=false,disposed=false,drawerOpen=false,lastLoadedGraphThreadId=null,lastRemotePayload=null;${refresh}`, ctx);
  const request = vm.runInContext("refreshStats(false)", ctx);
  selectedProvider = "muse";
  finish(staleCodex);
  await request;
  assert.equal(rendered.length, 0, "pre-switch codex response must not render when picker resolved to muse mid-flight");
  assert.equal(vm.runInContext("pendingFastRefresh", ctx), true);
  assert.equal(trailingScheduled, 1);
});

test("R36: multi-segment and stat/catalog read-only Hub RPCs arm 8s read deadline while mutating actions do not", async () => {
  const call = rendererSource.match(/  async function callBackend\([\s\S]*?\n  \}/)[0];
  const wrapper = rendererSource.slice(rendererSource.indexOf("  const callRpc = "), rendererSource.indexOf("  function formatCompactTokens("));
  for (const readAction of [
    "subagents:orchestration:get",
    "memory:dream:get",
    "memory:health",
    "memory:stats",
    "memory:vectorStats",
    "memory:worktreeInfo",
    "plugins:catalog",
    "mcp:matrix",
    "board:readArtifact",
    "subagents:slashPrompt",
  ]) {
    const timers = new Map();
    let serial = 0;
    const window = {
      __t3HudBridge: { getGitGraph: () => new Promise(() => {}) },
      __t3HubSidecarBridge: { url: "http://127.0.0.1:59999", token: "fixture" },
    };
    const ctx = vm.createContext({
      window,
      AbortController,
      fetch: () => new Promise(() => {}),
      setTimeout: fn => { timers.set(++serial, fn); return serial; },
      clearTimeout: id => timers.delete(id),
    });
    vm.runInContext(`${call}\n${wrapper}`, ctx);
    const req = window.__t3HubRpc(readAction, {});
    await Promise.resolve();
    assert.equal(timers.size, 1, `${readAction} must arm bounded read timeout`);
    for (const fn of [...timers.values()]) fn();
    if (readAction === "memory:dream:get") {
      const dreamRes = await req;
      assert.equal(dreamRes.ok, false);
      assert.equal(dreamRes.status, "unavailable");
      // Also verify direct callBackend Hub tunnel for memory:dream:get
      const directReq = vm.runInContext(`callBackend('getGitGraph', '__HUB_RPC__', 'memory:dream:get', {})`, ctx);
      await Promise.resolve();
      assert.equal(timers.size, 1, "direct callBackend memory:dream:get must arm bounded read timeout");
      for (const fn of [...timers.values()]) fn();
      await assert.rejects(directReq, /HUD RPC timed out/);
    } else {
      await assert.rejects(req, /HUD RPC timed out/);
    }
  }
  for (const writeAction of [
    "subagents:orchestration:update",
    "memory:dream:run",
    "memory:dream:update",
    "board:openArtifact",
    "embed:switch",
  ]) {
    const timers = new Map();
    let release;
    const window = {
      __t3HudBridge: { getGitGraph: () => new Promise(r => { release = () => r({ ok: true }); }) },
      __t3HubSidecarBridge: { url: "http://127.0.0.1:59999", token: "fixture" },
    };
    const ctx = vm.createContext({
      window,
      AbortController,
      fetch: () => new Promise(r => { release = () => r({ ok: true, status: 200, json: async () => ({ ok: true }) }); }),
      setTimeout: fn => { timers.set(1, fn); return 1; },
      clearTimeout: id => timers.delete(id),
    });
    vm.runInContext(`${call}\n${wrapper}`, ctx);
    const req = window.__t3HubRpc(writeAction, {});
    assert.equal(timers.size, 0, `${writeAction} must NOT arm 8s read deadline`);
    release();
    assert.deepEqual(await req, { ok: true });
  }
});

test("R42: unattributed DOM growth without turnId cannot fabricate live speed when activeTurnIds is non-empty or explicit empty", () => {
  const nodes = [];
  const h = telemetryRendererHarness(nodes, { ok: true, provider: "codex", isRunning: false, activeTurnIds: [], speed: {} });
  let now = 1000;
  Object.assign(h.context, {
    setInterval: fn => { h.context.tick = fn; },
    getRouteHint: () => "r7",
    disposed: false,
    performance: { now: () => now },
    advanceHudStreamSampler,
    canSampleHudStream,
    estimateRenderedTokens,
  });
  h.run("renderTopbarStats(stats); stats.isRunning=true; stats.activeTurnIds=['new-turn']; renderTopbarStats(stats)");
  h.run(rendererSource.match(/  const streamWatchTimer = setInterval\(\(\) => \{[\s\S]*?\n  \}, 260\);/)[0]);
  const user = telemetryDomNode({ "data-message-role": "user", "data-message-id": "u-old" }, "old prompt");
  const unattributedOld = telemetryDomNode({ "data-message-role": "assistant", "data-message-id": "old-no-turn" }, "old text");
  nodes.push(user, unattributedOld);
  h.context.tick();
  now += 260;
  unattributedOld.innerText += " late hydrated unattributed text".repeat(10);
  h.context.tick();
  assert.equal(h.run("streamSampler.samples.length"), 0, "unattributed DOM row must not sample when activeTurnIds=['new-turn']");
  assert.equal(h.run("liveStreamTps"), null);
  assert.equal(h.run("renderTopbarStats(stats)").kind, "waiting");

  // Explicit empty activeTurnIds=[] (runningWithoutActiveTurn) must also reject unattributed DOM growth
  h.run("stats.activeTurnIds=[]");
  now += 260;
  unattributedOld.innerText += " more unattributed text".repeat(10);
  h.context.tick();
  assert.equal(h.run("streamSampler.samples.length"), 0);
  assert.equal(h.run("liveStreamTps"), null);
});

test("R43: empty initial baselineProvider still drops previous provider live speed immediately on provider switch", () => {
  const nodes = [
    telemetryDomNode({ "data-message-role": "user", "data-message-id": "u-1" }, "prompt"),
    telemetryDomNode({ "data-message-role": "assistant", "data-message-id": "a-codex", "data-turn-id": "codex-turn" }, "init"),
  ];
  const h = telemetryRendererHarness(nodes, { ok: true, provider: "", isRunning: false, activeTurnIds: [], speed: {} });
  let now = 1000;
  Object.assign(h.context, {
    setInterval: fn => { h.context.tick = fn; },
    getRouteHint: () => "r7",
    disposed: false,
    performance: { now: () => now },
    advanceHudStreamSampler,
    canSampleHudStream,
    estimateRenderedTokens,
  });
  // Capture initial idle baseline with empty provider ("")
  h.run("nodes = undefined; renderTopbarStats({ ok: true, provider: '', isRunning: false, activeTurnIds: [], speed: {} })");
  nodes.length = 0;
  h.run("renderTopbarStats({ ok: true, provider: '', isRunning: false, activeTurnIds: [], speed: {} })");
  assert.equal(h.run("turnSpeedState.baselineProvider"), "");

  // Codex starts running and streams live speed (~100+ tok/s)
  const u1 = telemetryDomNode({ "data-message-role": "user", "data-message-id": "u-1" }, "prompt");
  const aCodex = telemetryDomNode({ "data-message-role": "assistant", "data-message-id": "a-codex", "data-turn-id": "codex-turn" }, "hello ");
  nodes.push(u1, aCodex);
  h.run("stats = { ok: true, provider: 'codex', isRunning: true, activeTurnIds: ['codex-turn'], speed: {} }; renderTopbarStats(stats)");
  h.run(rendererSource.match(/  const streamWatchTimer = setInterval\(\(\) => \{[\s\S]*?\n  \}, 260\);/)[0]);
  h.context.tick();
  now += 300;
  aCodex.innerText += "codex streaming tokens ".repeat(15);
  h.context.tick();
  assert.ok(h.run("liveStreamTps") > 0, "Codex live stream speed established");

  // Switch directly to running Muse before any idle frame intervened
  const museView = h.run("stats = { ok: true, provider: 'muse', isRunning: true, activeTurnIds: ['muse-turn'], speed: {} }; renderTopbarStats(stats)");
  assert.equal(museView.kind, "waiting", "first Muse render must NOT inherit Codex liveStreamTps");
  assert.equal(h.run("liveStreamTps"), null);
});

test("R44: memory:dream:get bounds response.json() body read inside 8s deadline", async () => {
  const call = rendererSource.match(/  async function callBackend\([\s\S]*?\n  \}/)[0];
  const wrapper = rendererSource.slice(rendererSource.indexOf("  const callRpc = "), rendererSource.indexOf("  function formatCompactTokens("));
  const timers = new Map();
  let serial = 0;
  let aborted = false;
  const window = {
    __t3HudBridge: {},
    __t3HubSidecarBridge: { url: "http://127.0.0.1:59999", token: "fixture" },
  };
  const ctx = vm.createContext({
    window,
    AbortController,
    fetch: (_url, opts) => {
      opts?.signal?.addEventListener("abort", () => { aborted = true; });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => new Promise(() => {}), // headers arrived, body hangs forever!
      });
    },
    setTimeout: fn => { timers.set(++serial, fn); return serial; },
    clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(`${call}\n${wrapper}`, ctx);
  const req = window.__t3HubRpc("memory:dream:get", {});
  for (let i = 0; i < 6; i++) await Promise.resolve();
  assert.equal(timers.size, 1, "deadline timer must remain armed while response.json() is pending");
  for (const fn of [...timers.values()]) fn();
  const res = await req;
  assert.equal(res.ok, false);
  assert.equal(res.status, "unavailable");
  assert.equal(aborted, true);
  assert.equal(timers.size, 0);
});

test("R45: fallback sidecar /hub-rpc fetch for read-only Hub RPC is bounded by 8s deadline", async () => {
  const call = rendererSource.match(/  async function callBackend\([\s\S]*?\n  \}/)[0];
  const wrapper = rendererSource.slice(rendererSource.indexOf("  const callRpc = "), rendererSource.indexOf("  function formatCompactTokens("));
  const timers = new Map();
  let serial = 0;
  let fallbackAborted = false;
  const window = {
    __t3HudBridge: { getGitGraph: async () => ({ ok: false, error: "Unknown method" }) },
    __t3HubSidecarBridge: { url: "http://127.0.0.1:59999", token: "fixture" },
  };
  const ctx = vm.createContext({
    window,
    AbortController,
    fetch: (_url, opts) => {
      opts?.signal?.addEventListener("abort", () => { fallbackAborted = true; });
      return new Promise(() => {});
    },
    setTimeout: fn => { timers.set(++serial, fn); return serial; },
    clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(`${call}\n${wrapper}`, ctx);
  let settled = false;
  const req = window.__t3HubRpc("memory:health", {}).then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(timers.size, 1, "fallback /hub-rpc fetch must arm bounded read timeout");
  for (const fn of [...timers.values()]) fn();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(settled, true, "hung fallback /hub-rpc fetch must settle when deadline fires");
  assert.equal(fallbackAborted, true);
  await req;
  assert.equal(timers.size, 0);
});

test("R46: non-Hub mutating backend RPC (setConfig) does NOT arm 8s read deadline", async () => {
  const call = rendererSource.match(/  async function callBackend\([\s\S]*?\n  \}/)[0];
  const timers = new Map();
  let release;
  const window = {
    __t3HudBridge: { setConfig: () => new Promise(r => { release = () => r({ ok: true }); }) },
  };
  const ctx = vm.createContext({
    window,
    AbortController,
    fetch: () => new Promise(() => {}),
    setTimeout: fn => { timers.set(1, fn); return 1; },
    clearTimeout: id => timers.delete(id),
  });
  const fn = vm.runInContext(`(${call.trim()})`, ctx);
  const pending = fn("setConfig", { userLang: "zh" });
  await Promise.resolve();
  assert.equal(timers.size, 0, "setConfig write RPC must NOT arm 8s read timeout");
  release();
  assert.deepEqual(await pending, { ok: true });
});

test("R47 (#9-1): growing un-ID'd prior DOM row while an identified current turn row stays unchanged never produces live stream speed", () => {
  const oldRow = telemetryDomNode({ "data-message-role": "assistant", "data-message-id": "legacy-no-turn" }, "legacy prefix");
  const curUser = telemetryDomNode({ "data-message-role": "user", "data-message-id": "u-cur", "data-turn-id": "turn-cur" }, "question");
  const curAsst = telemetryDomNode({ "data-message-role": "assistant", "data-message-id": "a-cur", "data-turn-id": "turn-cur" }, "thinking...");
  // A legacy row may hydrate after the current user anchor; only tailTurnId may join the snapshot.
  const h = telemetryRendererHarness([curUser, oldRow, curAsst], {
    ok: true,
    provider: "codex",
    isRunning: false,
    activeTurnIds: ["turn-cur"],
    speed: {},
  });
  let now = 1000;
  Object.assign(h.context, {
    setInterval: fn => { h.context.tick = fn; },
    getRouteHint: () => "r7",
    disposed: false,
    performance: { now: () => now },
    advanceHudStreamSampler,
    canSampleHudStream,
    estimateRenderedTokens,
  });
  const readSnapshot = () => h.run("getAssistantStreamSnapshot(document.querySelector('[data-chat-column]'))");
  assert.equal(readSnapshot().messageId, "a-cur");
  assert.equal(readSnapshot().turnId, "turn-cur");
  assert.equal(readSnapshot().text, "thinking...");
  h.run("renderTopbarStats(stats); stats.isRunning=true; renderTopbarStats(stats)");
  h.run(rendererSource.match(/  const streamWatchTimer = setInterval\(\(\) => \{[\s\S]*?\n  \}, 260\);/)[0]);
  h.context.tick();
  now += 260;
  oldRow.innerText += " hydrated old markdown block ".repeat(20);
  h.context.tick();
  now += 260;
  oldRow.innerText += " more old markdown block ".repeat(20);
  h.context.tick();
  assert.equal(readSnapshot().text, "thinking...", "unattributed legacy DOM growth must not enter the current-turn snapshot");
  assert.equal(h.run("liveStreamTps"), null, "un-ID'd prior row growth must not contaminate current turn live speed");
});

test("R48 (#9-2): late completion of a pre-switch Codex turn after selecting Muse keeps Muse selected without reverting to Codex stats", () => {
  const dbPath = path.join(process.env.T3CODE_HOME, "statev2.sqlite");
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  const db = createAgyStateDb();
  const threadId = "thread:r48-late-pre-switch-completion";
  db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?,?,?,?,?,?)").run(
    threadId, "p1", threadId, "muse", "2026-11-16T10:00:01.000Z",
    JSON.stringify({ modelSelection: { provider: "muse", model: "muse-ember-1.0" } }), null, null
  );
  db.prepare("INSERT INTO orchestration_v2_projection_provider_sessions VALUES (?,?,?,?,?,?,?,?)").run(
    `${threadId}-ps`, threadId, "codex", "completed", "old-codex", "2026-11-16T10:00:02.000Z", "{}", "codex"
  );
  db.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?,?,?,?,?)").run(
    `${threadId}-pt`, threadId, "codex", "2026-11-16T10:00:02.000Z",
    JSON.stringify({ contextUsage: { usedTokens: 9999, maxTokens: 200000 } })
  );
  db.prepare("INSERT INTO orchestration_v2_projection_provider_turns VALUES (?,?,?,?,?,?,?)").run(
    `${threadId}-t1`, threadId, 1, "completed", "2026-11-16T10:00:00.000Z", "2026-11-16T10:00:02.000Z",
    JSON.stringify({
      nativeTurnRef: { driver: "codex" },
      turnTokenUsage: { inputTokens: 1000, cachedInputTokens: 900, outputTokens: 100, models: ["old-codex"] },
    })
  );
  db.close();
  const res = backend.getThreadStats(threadId);
  assert.equal(res.ok, true);
  assert.equal(res.provider, "muse", "turn started at 10:00:00 before 10:00:01 selection must not revert provider to codex");
  assert.equal(res.model, "muse-ember-1.0");
  assert.equal(res.cache.turnRate, null);
  assert.equal(res.speed.lastDecodeTps, null);
  assert.equal(res.tokens.contextUsed, null);
});

test("R49 (#9-3): second Muse turn completing after a prior 50 tok/s native log reports its own 20 tok/s instead of stale 50 tok/s", () => {
  const dbPath = path.join(process.env.T3CODE_HOME, "statev2.sqlite");
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  const db = createAgyStateDb();
  const museSid = "muse-r49-stale-native";
  writeIndexedMuseSession(museSid, { mtime: Date.parse("2026-11-16T10:00:02.000Z"), output: 100 }); // 100 tok / 2s = 50 tok/s
  insertProjectionThread(db, {
    threadId: "thread:r49-same-provider-new-turn",
    provider: "muse",
    model: "muse-fixture-model",
    providerThreads: [{ driver: "muse", updatedAt: "2026-11-16T10:01:10.000Z", payload: { nativeThreadRef: { nativeId: museSid } } }],
    turnRows: [
      { ordinal: 1, status: "completed", driver: "muse", startedAt: "2026-11-16T10:00:00.000Z", completedAt: "2026-11-16T10:00:02.000Z", usage: { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 100 } },
      { ordinal: 2, status: "completed", driver: "muse", startedAt: "2026-11-16T10:01:00.000Z", completedAt: "2026-11-16T10:01:10.000Z", usage: { inputTokens: 1000, cachedInputTokens: 500, outputTokens: 200 } },
    ],
  });
  db.close();
  const res = backend.getThreadStats("thread:r49-same-provider-new-turn");
  assert.equal(res.ok, true);
  assert.equal(res.speed.lastDecodeTps, 20, "new 200 tok / 10s turn must report 20 tok/s rather than prior native log's 50 tok/s");
  assert.equal(res.cache.lastCallRate, null, "stale native log must not claim latest per-call cache rate");
});

test("R50 (#9-4): A->B->A provider/model bounce while refreshStats is in flight discards stale response and queues trailing refresh", async () => {
  const refresh = stableRouteStub + rendererSource.match(/  async function refreshStats\([\s\S]*?\n  \}/)[0];
  let selectedProvider = "codex", selectedModel = "old-codex", finish, trailingScheduled = 0;
  const rendered = [];
  const stalePreSwitch = {
    ok: true,
    provider: "codex",
    model: "old-codex",
    isRunning: true,
    cache: { turnRate: 0.9, sessionRate: 0.9 },
    speed: { lastDecodeTps: 50 },
    tokens: { contextUsed: 9999 },
  };
  const ctx = vm.createContext({
    getRouteHint: () => "same-thread",
    isCurrentStatsSnapshot,
    callBackend: () => new Promise(resolve => { finish = resolve; }),
    readLiveT3State: () => ({ selectedProvider, selectedModel }),
    scheduleTrailingFastRefresh: () => { trailingScheduled++; },
    renderTopbarStats: s => rendered.push(s),
    document: { hidden: false },
  });
  vm.runInContext(`let statsInFlight=false,statsRequestSeq=0,pendingFastRefresh=false,disposed=false,drawerOpen=false,lastLoadedGraphThreadId=null,lastRemotePayload=null;${refresh}`, ctx);
  const req = vm.runInContext("refreshStats(false)", ctx);
  // Switch to Muse, then back to Codex (even same or new model!) while req is in flight
  selectedProvider = "muse"; selectedModel = "muse-ember-1.0";
  await vm.runInContext("refreshStats(false)", ctx);
  selectedProvider = "codex"; selectedModel = "new-codex";
  await vm.runInContext("refreshStats(false)", ctx);
  finish(stalePreSwitch);
  await req;
  assert.equal(rendered.length, 0, "stale pre-bounce Codex response must be discarded");
  assert.equal(vm.runInContext("pendingFastRefresh", ctx), true, "must queue pendingFastRefresh");
  assert.equal(trailingScheduled, 1);
});

test("R51 (#9-5): standalone Hub dispatcher shares one 8s deadline with real or stubbed callBackend", async () => {
  const call = rendererSource.match(/  async function callBackend\([\s\S]*?\n  \}/)[0];
  const wrapper = rendererSource.slice(rendererSource.indexOf("  const callRpc = "), rendererSource.indexOf("  function formatCompactTokens("));

  for (const realBackend of [true, false]) {
    for (const error of ["Unknown method", "unknown action: hub:getDrawerScript", "当前会话未绑定本地 Git 仓库目录"]) {
      for (const elapsedMs of [7990, 8000]) {
        let nowMs = 1000;
        const scheduledDelays = [];
        const timers = new Map();
        let serial = 0, resolvePrimary, fallbackCalls = 0, fallbackAborted = false;
        const primary = () => new Promise(resolve => { resolvePrimary = resolve; });
        const window = {
          __t3HudBridge: { getGitGraph: primary },
          __t3HubSidecarBridge: { url: "http://127.0.0.1:59999", token: "fixture" },
        };
        const ctx = vm.createContext({
          window,
          callBackend: primary,
          Date: { now: () => nowMs },
          AbortController,
          fetch: (_url, opts) => {
            fallbackCalls++;
            opts.signal.addEventListener("abort", () => { fallbackAborted = true; });
            return new Promise(() => {});
          },
          setTimeout: (fn, ms) => { scheduledDelays.push(ms); timers.set(++serial, fn); return serial; },
          clearTimeout: id => timers.delete(id),
        });
        vm.runInContext(`${realBackend ? call : ""}\n${wrapper}`, ctx);
        const pending = window.__t3HubRpc("hub:getDrawerScript", {});
        const rejected = assert.rejects(pending, /HUD RPC timed out/);
        assert.deepEqual(scheduledDelays, realBackend ? [8000] : []);
        nowMs += elapsedMs;
        resolvePrimary({ ok: false, error });
        for (let i = 0; i < 8; i++) await Promise.resolve();
        assert.equal(fallbackCalls, elapsedMs < 8000 ? 1 : 0, "an exhausted read budget must prevent fallback");
        assert.deepEqual(scheduledDelays, [
          ...(realBackend ? [8000] : []),
          ...(elapsedMs < 8000 ? [10] : []),
        ], "fallback must use exactly the remaining budget");
        for (const fn of [...timers.values()]) fn();
        await rejected;
        assert.equal(fallbackAborted, elapsedMs < 8000);
        assert.equal(timers.size, 0);
      }
    }
  }
});

test("R52 (#9-6): standalone Hub dispatcher works without timers or AbortController", async () => {
  const call = rendererSource.match(/  async function callBackend\([\s\S]*?\n  \}/)[0];
  const wrapper = rendererSource.slice(rendererSource.indexOf("  const callRpc = "), rendererSource.indexOf("  function formatCompactTokens("));
  for (const realBackend of [true, false]) {
    for (const withAbortController of [true, false]) {
      for (const route of ["primary", "fallback", "dream"]) {
        let primaryCalls = 0, fetchCalls = 0;
        const primaryResult = { ok: true, via: "primary" };
        const sidecarResult = { ok: true, via: "sidecar" };
        const primary = async () => {
          primaryCalls++;
          return route === "fallback" ? { ok: false, error: "Unknown method" } : primaryResult;
        };
        const window = {
          __t3HudBridge: { getGitGraph: primary },
          __t3HubSidecarBridge: { url: "http://127.0.0.1:59999", token: "fixture" },
        };
        const ctx = vm.createContext({
          window,
          callBackend: primary,
          ...(withAbortController ? { AbortController } : {}),
          fetch: async () => {
            fetchCalls++;
            return { ok: true, json: async () => sidecarResult };
          },
        });
        vm.runInContext(`${realBackend ? call : ""}\n${wrapper}`, ctx);
        const action = route === "dream" ? "memory:dream:get" : "hub:getContext";
        assert.deepEqual(await window.__t3HubRpc(action, {}), route === "primary" ? primaryResult : sidecarResult);
        assert.equal(primaryCalls, route === "dream" ? 0 : 1);
        assert.equal(fetchCalls, route === "primary" ? 0 : 1);
      }
    }
  }
});

test("R51 additional: mutating Hub fallback never acquires a read timeout even after 8s primary", async () => {
  const call = rendererSource.match(/  async function callBackend\([\s\S]*?\n  \}/)[0];
  const wrapper = rendererSource.slice(rendererSource.indexOf("  const callRpc = "), rendererSource.indexOf("  function formatCompactTokens("));
  for (const realBackend of [true, false]) {
    let nowMs = 1000, timerCalls = 0, release;
    const primary = async () => {
      nowMs += 9000;
      return { ok: false, error: "Unknown method" };
    };
    const window = {
      __t3HudBridge: { getGitGraph: primary },
      __t3HubSidecarBridge: { url: "http://127.0.0.1:59999", token: "fixture" },
    };
    const ctx = vm.createContext({
      window,
      callBackend: primary,
      Date: { now: () => nowMs },
      AbortController,
      setTimeout: () => { timerCalls++; return 1; },
      clearTimeout: () => {},
      fetch: (_url, opts) => {
        assert.equal(opts.signal, undefined, "fallback writes must not receive a read abort signal");
        return new Promise(resolve => { release = () => resolve({ ok: true, json: async () => ({ ok: true }) }); });
      },
    });
    vm.runInContext(`${realBackend ? call : ""}\n${wrapper}`, ctx);
    const pending = window.__t3HubRpc("skills:importGitHub", {});
    for (let i = 0; i < 8; i++) await Promise.resolve();
    assert.equal(timerCalls, 0);
    assert.equal(typeof release, "function", "write fallback must still execute after 8s primary");
    release();
    assert.equal((await pending).ok, true);
    assert.equal(timerCalls, 0);
  }
});

test("R53: an unidentified tail cannot join growing historical rows above the first identified current row", () => {
  const user = telemetryDomNode({ "data-message-role": "user" }, "question");
  const old = telemetryDomNode({ "data-message-role": "assistant", "data-message-id": "old" }, "history");
  const current = telemetryDomNode({ "data-message-role": "assistant", "data-message-id": "current", "data-turn-id": "live" }, "answer");
  const tail = telemetryDomNode({ "data-timeline-row-kind": "thinking" }, "thinking");
  const read = () => getAssistantStreamSnapshot(telemetryColumn([user, old, current, tail]));
  const first = read();
  assert.equal(first.text, "answer\nthinking");
  assert.equal(first.turnId, "live");
  assert.equal(first.messageId, "current");
  old.innerText += " expanding old markdown".repeat(100);
  const second = read();
  assert.equal(second.text, first.text, "old text cannot contribute a token delta");
  const sampler = createHudStreamSampler();
  advanceHudStreamSampler(sampler, { threadId: "r53", messageId: second.messageId, textLen: estimateRenderedTokens(first.text), nowMs: 1000 });
  const sample = advanceHudStreamSampler(sampler, { threadId: "r53", messageId: second.messageId, textLen: estimateRenderedTokens(second.text), nowMs: 1260 });
  assert.equal(sample.liveTps, null);
  const unknown = getAssistantStreamSnapshot(telemetryColumn([user, old, tail]));
  assert.equal(unknown.turnId, null);
  assert.equal(canSampleHudStream({ ok: true, isRunning: true, activeTurnIds: ["live"] }, unknown), false);
  assert.equal(getAssistantStreamSnapshot(telemetryColumn([old, current, tail])).text, first.text, "virtualized user anchor still locks the first nonempty turn ID");
});

test("R55: exact A->B->A between route ticks invalidates an in-flight refresh through calls, reads and capture events", async () => {
  const refresh = stableRouteStub + rendererSource.match(/  async function refreshStats\([\s\S]*?\n  \}/)[0];
  const install = rendererSource.match(/  function installHudSelectionObservers\([\s\S]*?\n  \}/)?.[0];
  assert.ok(install, "selection changes need an immediate event hook");
  const read = rendererSource.match(/  function readLiveT3State\([\s\S]*?\n  \}/)[0];
  for (const via of ["refresh", "read", "click", "keydown", "input", "change", "mutation"]) {
    const props = { selectedProvider: "codex", selectedModel: "same-model" };
    const listeners = new Map();
    const rendered = [];
    let finish, trailing = 0;
    const ctx = vm.createContext({
      document: {
        hidden: false, getElementById: () => ({ "__reactFiber$fixture": { memoizedProps: props } }),
        addEventListener: (type, fn, capture) => { assert.equal(capture, true); listeners.set(type, fn); },
        removeEventListener: type => listeners.delete(type),
      },
      queueMicrotask, getRouteHint: () => "same-thread", isCurrentStatsSnapshot,
      callBackend: () => new Promise(resolve => { finish = resolve; }),
      renderTopbarStats: s => rendered.push(s), scheduleTrailingFastRefresh: () => { trailing++; },
    });
    vm.runInContext(`let statsInFlight=false, statsRequestSeq=0, pendingFastRefresh=false, disposed=false;
      let lastRemotePayload=null, latestStats=null, lastTopbarSig='', lastLoadedGraphThreadId=null;
      ${read}\n${refresh}\n${install}\nconst stopSelectionWatch=installHudSelectionObservers();`, ctx);
    const pending = vm.runInContext("refreshStats(false)", ctx);
    for (const provider of ["muse", "codex"]) {
      props.selectedProvider = provider;
      if (via === "refresh") await vm.runInContext("refreshStats(false)", ctx);
      else if (via === "read") vm.runInContext("readLiveT3State()", ctx);
      else if (via === "mutation") {
        const observer = rendererSource.match(/  const domObserver = new MutationObserver\(\(records\) => \{[\s\S]*?\n  \}\);/)[0];
        Object.assign(ctx, { MutationObserver: class { constructor(fn) { ctx.mutate = fn; } }, isHudOwnNode: () => true });
        vm.runInContext(`{ ${observer} }`, ctx);
        ctx.mutate([{ target: {} }]);
      } else listeners.get(via)();
      await Promise.resolve();
    }
    finish({ ok: true, provider: "codex", model: "same-model", speed: { lastDecodeTps: 50 } });
    await pending;
    assert.equal(rendered.length, 0, `${via}: old response must be discarded even though selection returned to the same value`);
    assert.equal(vm.runInContext("pendingFastRefresh", ctx), true);
    assert.equal(trailing, 1);
    vm.runInContext("stopSelectionWatch()", ctx);
    assert.equal(listeners.size, 0, "event handlers must be removable on cleanup");
  }
});

test("R56: trailing refresh without timers preserves pending work without throwing", async () => {
  const scheduler = rendererSource.match(/  function scheduleTrailingFastRefresh\([\s\S]*?\n  \}/)[0];
  const refresh = stableRouteStub + rendererSource.match(/  async function refreshStats\([\s\S]*?\n  \}/)[0];
  const ctx = vm.createContext({
    performance: { now: () => 2000 }, document: { hidden: false },
    getRouteHint: () => "r56", isCurrentStatsSnapshot,
    readLiveT3State: () => ({ selectedProvider: "codex" }),
    callBackend: async () => ({ ok: true, provider: "codex" }), renderTopbarStats() {},
  });
  vm.runInContext(`let statsInFlight=false, statsRequestSeq=0, pendingFastRefresh=true, disposed=false;
    let trailingFastRefreshTimer=null, lastFastRefreshAt=0, lastLoadedGraphThreadId=null;
    let lastRemotePayload=null; ${scheduler}\n${refresh}`, ctx);
  assert.doesNotThrow(() => vm.runInContext("scheduleTrailingFastRefresh()", ctx));
  await assert.doesNotReject(vm.runInContext("refreshStats(false)", ctx));
  assert.equal(vm.runInContext("pendingFastRefresh", ctx), true);
  assert.equal(vm.runInContext("trailingFastRefreshTimer", ctx), null);
});

test("R57: Hub fallback shares the 8s budget across wall-clock rollback and virtual-clock advances", async () => {
  const call = rendererSource.match(/  async function callBackend\([\s\S]*?\n  \}/)[0];
  const wrapper = rendererSource.slice(rendererSource.indexOf("  const callRpc = "), rendererSource.indexOf("  function formatCompactTokens("));
  for (const realBackend of [false, true]) {
    for (const clock of ["rollback", "date-only-advance", "invalid-performance", "no-performance"]) {
      let wallMs = 20000, monoMs = 100, release, aborted = false;
      const delays = [], timers = new Map();
      let serial = 0;
      const primary = () => new Promise(resolve => { release = resolve; });
      const window = { __t3HudBridge: { getGitGraph: primary }, __t3HubSidecarBridge: { url: "http://127.0.0.1:59999", token: "fixture" } };
      const ctx = vm.createContext({
        window, callBackend: primary, Date: { now: () => wallMs }, AbortController,
        ...(clock === "no-performance" ? {} : { performance: { now: () => clock === "invalid-performance" ? NaN : monoMs } }),
        setTimeout: (fn, ms) => { delays.push(ms); timers.set(++serial, fn); return serial; },
        clearTimeout: id => timers.delete(id),
        fetch: (_url, opts) => { opts.signal.addEventListener("abort", () => { aborted = true; }); return new Promise(() => {}); },
      });
      vm.runInContext(`${realBackend ? call : ""}\n${wrapper}`, ctx);
      const pending = window.__t3HubRpc("hub:getDrawerScript", {});
      const rejected = assert.rejects(pending, /HUD RPC timed out/);
      wallMs += clock === "rollback" ? -3000 : 7000;
      monoMs += clock === "date-only-advance" ? 0 : 7000;
      release({ ok: false, error: "Unknown method" });
      for (let i = 0; i < 8; i++) await Promise.resolve();
      const fallbackDelay = delays.at(-1);
      // Fire before asserting so a failed assertion cannot leave a pending rejection.
      for (const fn of [...timers.values()]) fn();
      await rejected;
      assert.equal(fallbackDelay, 1000, `${clock}: primary used 7s, fallback has only 1s left`);
      assert.equal(aborted, true);
      assert.equal(timers.size, 0);
    }
  }
});
