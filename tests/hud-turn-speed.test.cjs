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
