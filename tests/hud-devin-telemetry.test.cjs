"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { spawnSync } = require("node:child_process");

const backend = require("../src/backend.cjs");

function createDevinDb(dir, sessions, nodes) {
  const dbPath = path.join(dir, ".local", "share", "devin", "cli", "sessions.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, model TEXT, created_at INTEGER, last_activity_at INTEGER);
    CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, node_id INTEGER, created_at INTEGER, chat_message TEXT, metadata TEXT);
  `);
  const insSess = db.prepare("INSERT INTO sessions (id, model, created_at, last_activity_at) VALUES (?, ?, ?, ?)");
  for (const s of sessions) insSess.run(s.id, s.model || "", s.created_at || 1795270000, s.last_activity_at || 1795270010);
  const insNode = db.prepare("INSERT INTO message_nodes (session_id, node_id, created_at, chat_message, metadata) VALUES (?, ?, ?, ?, ?)");
  for (const n of nodes) insNode.run(n.session_id, n.node_id, n.created_at || 1795270005, JSON.stringify(n.chat_message), JSON.stringify(n.metadata || null));
  db.close();
  return dbPath;
}

test("readDevinSessionDb deduplicates request_id, computes pure decode speed, and falls back to e2e for buffered spikes", (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t3-devin-tel-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const dbPath = createDevinDb(
    tmp,
    [{ id: "devin-sess-1", model: "swe-2-max" }],
    [
      {
        session_id: "devin-sess-1",
        node_id: 1,
        chat_message: {
          role: "assistant",
          metadata: {
            request_id: "req-1",
            generation_model: "swe-2-max",
            created_at: "2026-11-21T14:55:45.102Z",
            metrics: {
              ttft_ms: 4286,
              total_time_ms: 5403,
              input_tokens: 200,
              output_tokens: 474,
              cache_read_tokens: 23808,
              cache_creation_tokens: null,
              context_input_tokens: 24008,
            },
          },
        },
      },
      // Duplicate node with identical request_id (Devin writes two nodes per inference)
      {
        session_id: "devin-sess-1",
        node_id: 2,
        chat_message: {
          role: "assistant",
          metadata: {
            request_id: "req-1",
            generation_model: "swe-2-max",
            created_at: "2026-11-21T14:55:45.102Z",
            metrics: {
              ttft_ms: 4286,
              total_time_ms: 5403,
              input_tokens: 200,
              output_tokens: 474,
              cache_read_tokens: 23808,
              cache_creation_tokens: null,
              context_input_tokens: 24008,
            },
          },
        },
      },
      // Buffered single-chunk response (decode_ms = 17ms => raw would be 13823 tok/s; must fall back to e2e 235 / 2.819s)
      {
        session_id: "devin-sess-1",
        node_id: 3,
        chat_message: {
          role: "assistant",
          metadata: {
            request_id: "req-2",
            generation_model: "swe-2-max",
            created_at: "2026-11-21T14:56:10.000Z",
            metrics: {
              ttft_ms: 2802,
              total_time_ms: 2819,
              input_tokens: 1000,
              output_tokens: 235,
              cache_read_tokens: 24000,
              context_input_tokens: 25000,
            },
          },
        },
      },
    ]
  );

  const parsed = backend.readDevinSessionDb("devin-sess-1", "swe-2-high", dbPath);
  assert.ok(parsed);
  assert.equal(parsed.stepCount, 2, "duplicate request_id must not be double counted");
  assert.equal(parsed.uncached, 1200);
  assert.equal(parsed.cached, 47808);
  assert.equal(parsed.output, 709);
  assert.equal(parsed.lastContextPrompt, 25235);
  assert.equal(Math.round(parsed.lastDecodeTps * 10) / 10, 83.4, "buffered 17ms spike must fall back to honest e2e rate");
  assert.ok(parsed.tokPerSec > 100 && parsed.tokPerSec < 300);
  assert.ok(parsed.lastStepCacheRate > 0.95);
});

test("getThreadStats resolves acpRegistry_devin context window, speed, and cache from statev2 + Devin sessions.db", (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t3-devin-e2e-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const t3Home = path.join(tmp, ".t3", "userdata");
  fs.mkdirSync(t3Home, { recursive: true });
  const stateDb = new DatabaseSync(path.join(t3Home, "statev2.sqlite"));
  stateDb.exec(`
    CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, title TEXT, workspace_root TEXT);
    CREATE TABLE orchestration_v2_projection_threads (
      thread_id TEXT PRIMARY KEY, project_id TEXT, title TEXT, default_provider TEXT,
      updated_at TEXT, archived_at TEXT, deleted_at TEXT, payload_json TEXT
    );
    CREATE TABLE orchestration_v2_projection_provider_sessions (
      provider_session_id TEXT PRIMARY KEY, thread_id TEXT, provider TEXT, driver TEXT,
      model TEXT, status TEXT, updated_at TEXT, payload_json TEXT
    );
    CREATE TABLE orchestration_v2_projection_provider_threads (
      provider_thread_id TEXT PRIMARY KEY, thread_id TEXT, provider TEXT, driver TEXT,
      updated_at TEXT, payload_json TEXT
    );
    CREATE TABLE orchestration_v2_projection_provider_turns (
      provider_turn_id TEXT PRIMARY KEY, thread_id TEXT, ordinal INTEGER, status TEXT,
      started_at TEXT, completed_at TEXT, payload_json TEXT
    );
    CREATE TABLE orchestration_v2_projection_turn_items (thread_id TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_subagents (subagent_id TEXT, thread_id TEXT, driver TEXT, child_thread_id TEXT);
  `);

  const threadId = "11111111-2222-3333-4444-555555555555";
  const pThreadId = "pt-devin-1";
  stateDb.prepare("INSERT INTO projection_projects VALUES (?, ?, ?)").run("proj-1", "demo", tmp);
  stateDb.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)").run(
    threadId,
    "proj-1",
    "Devin Check",
    "acpRegistry_devin",
    "2026-11-21T14:55:45.200Z",
    JSON.stringify({
      activeProviderThreadId: pThreadId,
      modelSelection: { provider: "acpRegistry_devin", instanceId: "acpRegistry_devin", model: "swe-2-high" },
    })
  );
  stateDb.prepare("INSERT INTO orchestration_v2_projection_provider_sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    "ps-1", threadId, "acpRegistry_devin", "acpRegistry", "swe-2-high", "ready", "2026-11-21T14:55:20.000Z", "{}"
  );
  stateDb.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, ?, ?, ?, ?)").run(
    pThreadId,
    threadId,
    "acpRegistry_devin",
    "acpRegistry",
    "2026-11-21T14:55:45.200Z",
    JSON.stringify({
      id: pThreadId,
      driver: "acpRegistry",
      providerInstanceId: "acpRegistry_devin",
      nativeThreadRef: { driver: "acpRegistry", nativeId: "legend-test", strength: "strong" },
      contextUsage: { usedTokens: 24482, maxTokens: 262000 },
    })
  );
  stateDb.prepare("INSERT INTO orchestration_v2_projection_provider_turns VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "turn-1",
    threadId,
    1,
    "completed",
    "2026-11-21T14:55:20.976Z",
    "2026-11-21T14:55:45.103Z",
    JSON.stringify({
      id: "turn-1",
      providerThreadId: pThreadId,
      nativeTurnRef: { driver: "acpRegistry", nativeId: "legend-test:turn:1", strength: "weak" },
      status: "completed",
      startedAt: "2026-11-21T14:55:20.976Z",
      completedAt: "2026-11-21T14:55:45.103Z",
      turnTokenUsage: { usageScope: "main_agent", hasSubagents: false, usageStatus: "unavailable" },
    })
  );
  stateDb.close();

  createDevinDb(
    tmp,
    [{ id: "legend-test", model: "swe-2-max" }],
    [
      {
        session_id: "legend-test",
        node_id: 10,
        chat_message: {
          role: "assistant",
          metadata: {
            request_id: "req-legend-1",
            generation_model: "swe-2-max",
            started_generation_at: "2026-11-21T14:55:39.698Z",
            created_at: "2026-11-21T14:55:45.102Z",
            metrics: {
              ttft_ms: 4286,
              total_time_ms: 5403,
              input_tokens: 200,
              output_tokens: 474,
              cache_read_tokens: 23808,
              context_input_tokens: 24008,
            },
          },
        },
      },
    ]
  );

  const repo = path.resolve(__dirname, "..");
  const script = `const b = require(${JSON.stringify(path.join(repo, "src/backend.cjs"))}); process.stdout.write(JSON.stringify(b.getThreadStats(${JSON.stringify(threadId)})));`;
  const run = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    env: { ...process.env, HOME: tmp, T3CODE_HOME: t3Home, NODE_ENV: "test" },
    timeout: 10000,
  });
  assert.equal(run.status, 0, run.stderr);
  const stats = JSON.parse(run.stdout);
  assert.equal(stats.ok, true);
  assert.equal(stats.provider, "acpRegistry_devin");
  assert.equal(stats.telemetrySource, "native");
  assert.equal(stats.tokens.contextUsed, 24482);
  assert.equal(stats.tokens.contextMax, 262000);
  assert.equal(stats.tokens.contextMaxSource, "reported");
  assert.equal(stats.speed.lastDecodeTps, 424.4);
  assert.equal(stats.speed.tokPerSec, 424.4);
  assert.ok(stats.cache.turnRate > 0.99);
});

test("multi-step Devin turn uses token-weighted turnRate instead of single-call lastStepCacheRate and clears zero-prompt steps", (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t3-devin-multi-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const t3Home = path.join(tmp, ".t3", "userdata");
  fs.mkdirSync(t3Home, { recursive: true });
  const stateDb = new DatabaseSync(path.join(t3Home, "statev2.sqlite"));
  stateDb.exec(`
    CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, title TEXT, workspace_root TEXT);
    CREATE TABLE orchestration_v2_projection_threads (
      thread_id TEXT PRIMARY KEY, project_id TEXT, title TEXT, default_provider TEXT,
      updated_at TEXT, archived_at TEXT, deleted_at TEXT, payload_json TEXT
    );
    CREATE TABLE orchestration_v2_projection_provider_sessions (
      provider_session_id TEXT PRIMARY KEY, thread_id TEXT, provider TEXT, driver TEXT,
      model TEXT, status TEXT, updated_at TEXT, payload_json TEXT
    );
    CREATE TABLE orchestration_v2_projection_provider_threads (
      provider_thread_id TEXT PRIMARY KEY, thread_id TEXT, provider TEXT, driver TEXT,
      updated_at TEXT, payload_json TEXT
    );
    CREATE TABLE orchestration_v2_projection_provider_turns (
      provider_turn_id TEXT PRIMARY KEY, thread_id TEXT, ordinal INTEGER, status TEXT,
      started_at TEXT, completed_at TEXT, payload_json TEXT
    );
    CREATE TABLE orchestration_v2_projection_turn_items (thread_id TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_subagents (subagent_id TEXT, thread_id TEXT, driver TEXT, child_thread_id TEXT);
  `);

  const threadId = "22222222-3333-4444-5555-666666666666";
  const pThreadId = "pt-devin-multi";
  stateDb.prepare("INSERT INTO projection_projects VALUES (?, ?, ?)").run("proj-1", "demo", tmp);
  stateDb.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)").run(
    threadId, "proj-1", "Devin Multi", "acpRegistry_devin", "2026-11-21T15:01:00.000Z",
    JSON.stringify({ activeProviderThreadId: pThreadId, modelSelection: { provider: "acpRegistry_devin", instanceId: "acpRegistry_devin", model: "swe-2-high" } })
  );
  stateDb.prepare("INSERT INTO orchestration_v2_projection_provider_sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    "ps-m", threadId, "acpRegistry_devin", "acpRegistry", "swe-2-high", "ready", "2026-11-21T15:00:00.000Z", "{}"
  );
  stateDb.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, ?, ?, ?, ?)").run(
    pThreadId, threadId, "acpRegistry_devin", "acpRegistry", "2026-11-21T15:01:00.000Z",
    JSON.stringify({ id: pThreadId, driver: "acpRegistry", providerInstanceId: "acpRegistry_devin", nativeThreadRef: { driver: "acpRegistry", nativeId: "multi-sess", strength: "strong" }, contextUsage: { usedTokens: 20000, maxTokens: 262000 } })
  );
  stateDb.prepare("INSERT INTO orchestration_v2_projection_provider_turns VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "turn-m1", threadId, 1, "completed", "2026-11-21T15:00:00.000Z", "2026-11-21T15:01:00.000Z",
    JSON.stringify({ id: "turn-m1", providerThreadId: pThreadId, nativeTurnRef: { driver: "acpRegistry", nativeId: "multi-sess:turn:1" }, status: "completed", startedAt: "2026-11-21T15:00:00.000Z", completedAt: "2026-11-21T15:01:00.000Z", turnTokenUsage: { usageStatus: "unavailable" } })
  );
  stateDb.close();

  const dbPath = createDevinDb(tmp, [{ id: "multi-sess", model: "swe-2-max" }], [
    {
      session_id: "multi-sess", node_id: 1,
      chat_message: { role: "assistant", metadata: { request_id: "r1", created_at: "2026-11-21T15:00:10.000Z", metrics: { input_tokens: 1000, cache_read_tokens: 9000, output_tokens: 100, ttft_ms: 500, total_time_ms: 1500 } } },
    },
    {
      session_id: "multi-sess", node_id: 2,
      chat_message: { role: "assistant", metadata: { request_id: "r2", created_at: "2026-11-21T15:00:40.000Z", metrics: { input_tokens: 10000, cache_read_tokens: 0, output_tokens: 100, ttft_ms: 500, total_time_ms: 1500 } } },
    },
  ]);

  const repo = path.resolve(__dirname, "..");
  const script = `const b = require(${JSON.stringify(path.join(repo, "src/backend.cjs"))}); process.stdout.write(JSON.stringify(b.getThreadStats(${JSON.stringify(threadId)})));`;
  const run = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    env: { ...process.env, HOME: tmp, T3CODE_HOME: t3Home, NODE_ENV: "test" },
    timeout: 10000,
  });
  assert.equal(run.status, 0, run.stderr);
  const stats = JSON.parse(run.stdout);
  assert.equal(stats.cache.lastCallRate, 0, "last call missed cache");
  assert.ok(Math.abs(stats.cache.turnRate - 0.45) < 1e-9, `whole turn must be token-weighted 9000/20000=0.45, got ${stats.cache.turnRate}`);

  // Zero-prompt final call must clear lastStepCacheRate to null instead of leaking prior rate
  const zDbPath = createDevinDb(path.join(tmp, "z"), [{ id: "zero-sess", model: "swe-2-max" }], [
    { session_id: "zero-sess", node_id: 1, chat_message: { role: "assistant", metadata: { request_id: "z1", created_at: "2026-11-21T15:00:10.000Z", metrics: { input_tokens: 100, cache_read_tokens: 900, output_tokens: 50 } } } },
    { session_id: "zero-sess", node_id: 2, chat_message: { role: "assistant", metadata: { request_id: "z2", created_at: "2026-11-21T15:00:20.000Z", metrics: { input_tokens: 0, cache_read_tokens: 0, output_tokens: 10 } } } },
  ]);
  const zParsed = backend.readDevinSessionDb("zero-sess", "swe-2-max", zDbPath);
  assert.equal(zParsed.lastStepCacheRate, null, "zero-prompt latest step must clear lastStepCacheRate");
});
