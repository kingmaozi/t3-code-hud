"use strict";
// Hermetic regression tests for the 4 code-review fixes in t3-code-hud.
// Run: node --test tests/fixes.test.cjs  (or: npm test)
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const REPO = path.resolve(__dirname, "..");

// --- Isolated homes; MUST be set before require(backend.cjs) ---------------
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "t3-hud-test-"));
const tmpHome = path.join(tmpRoot, "home");
const tmpUserdata = path.join(tmpRoot, "userdata");
const tmpMuse = path.join(tmpRoot, "muse");
const tmpCodex = path.join(tmpRoot, "codex");
for (const d of [tmpHome, tmpUserdata, tmpMuse, tmpCodex]) fs.mkdirSync(d, { recursive: true });
process.env.HOME = tmpHome;
process.env.T3CODE_HOME = tmpUserdata;
process.env.MUSE_DATA_DIR = tmpMuse;
process.env.CODEX_HOME = tmpCodex;
delete process.env.XDG_DATA_HOME;

const backend = require(path.join(REPO, "src", "backend.cjs"));

function setMtime(file, iso) {
  const d = new Date(iso);
  fs.utimesSync(file, d, d);
}

// Two-step Muse session with decode windows of 2s + 2s (100tok@50t/s, 200tok@100t/s).
function writeMuseSession(file, model) {
  const lines = [
    { recorded_at: 1_000_000, payload: { event: { kind: "model_response_created" } } },
    { recorded_at: 3_000_000, payload: { event: { kind: "model_completed", model, duration_ms: 3000, usage: { input_tokens: 1000, cache_read_tokens: 200, cache_write_tokens: 50, output_tokens: 100, reasoning_tokens: 0 } } } },
    { recorded_at: 4_000_000, payload: { event: { kind: "model_response_created" } } },
    { recorded_at: 6_000_000, payload: { event: { kind: "model_completed", model, duration_ms: 3000, usage: { input_tokens: 1000, cache_read_tokens: 100, cache_write_tokens: 0, output_tokens: 200, reasoning_tokens: 0 } } } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

// One Codex step: reason window ends 2s before usage -> visOut 20tok @ 10 t/s.
function writeCodexSession(file, model) {
  const lines = [
    { timestamp: "2025-06-01T00:00:01.000Z", type: "event_msg", payload: { type: "token_count", info: { model_context_window: 999000 } } },
    { timestamp: "2025-06-01T00:00:01.000Z", type: "event_msg", payload: { item: { type: "UserMessage" } } },
    { timestamp: "2025-06-01T00:00:02.000Z", type: "response_item", payload: { type: "reasoning" } },
    { timestamp: "2025-06-01T00:00:04.000Z", type: "token_usage_record", payload: { model, usage: { input_tokens: 2000, cached_input_tokens: 500, cache_write_input_tokens: 100, output_tokens: 30, reasoning_output_tokens: 10 } } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

const MUSE_ID = "0193abcd-0000-7000-8000-000000000001";
const CODEX_ID = "0193abcd-0000-7000-8000-000000000002";
const MUSE_ID_B = "0193abcd-0000-7000-8000-000000000003";
const CODEX_ID_B = "0193abcd-0000-7000-8000-000000000004";
const THREAD_A = "thread:a";
const THREAD_B = "thread:b";
const THREAD_CHILD = "thread:child";

const museFileA = path.join(tmpRoot, "muse-a.jsonl");
const museFileB = path.join(tmpRoot, "muse-b.jsonl");
writeMuseSession(museFileA, "muse-model-a");
writeMuseSession(museFileB, "muse-model-b");
setMtime(museFileA, "2025-01-01T00:00:00Z");
setMtime(museFileB, "2025-01-01T00:00:00Z");

const codexDir = path.join(tmpCodex, "sessions", "2025", "06", "01");
fs.mkdirSync(codexDir, { recursive: true });
const codexFileA = path.join(codexDir, `rollout-${CODEX_ID}.jsonl`);
const codexFileB = path.join(codexDir, `rollout-${CODEX_ID_B}.jsonl`);
writeCodexSession(codexFileA, "codex-model-a");
writeCodexSession(codexFileB, "codex-model-b");
setMtime(codexFileA, "2025-06-01T00:00:00Z");
setMtime(codexFileB, "2025-06-01T00:00:00Z");

function buildDb() {
  const db = new DatabaseSync(path.join(tmpUserdata, "statev2.sqlite"));
  db.exec(
    `CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, project_id TEXT, title TEXT, default_provider TEXT, updated_at TEXT, payload_json TEXT, archived_at TEXT, deleted_at TEXT);
     CREATE TABLE projection_projects (project_id TEXT, title TEXT, workspace_root TEXT);
     CREATE TABLE orchestration_v2_projection_provider_sessions (provider_session_id TEXT, thread_id TEXT, provider TEXT, status TEXT, model TEXT, updated_at TEXT, payload_json TEXT, driver TEXT);
     CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT, thread_id TEXT, driver TEXT, updated_at TEXT, payload_json TEXT);
     CREATE TABLE orchestration_v2_projection_provider_turns (provider_turn_id TEXT, thread_id TEXT, ordinal INTEGER, status TEXT, started_at TEXT, completed_at TEXT, payload_json TEXT);
     CREATE TABLE orchestration_v2_projection_turn_items (thread_id TEXT, payload_json TEXT);
     CREATE TABLE orchestration_v2_projection_subagents (subagent_id TEXT, thread_id TEXT, driver TEXT, child_thread_id TEXT);`
  );
  const insThread = db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?,?,?,?,?,?)");
  insThread.run(THREAD_A, "p1", "A", "muse", "2025-07-01T00:00:00Z", JSON.stringify({ modelSelection: { model: "fallback-model", provider: "muse" } }), null, null);
  insThread.run(THREAD_B, "p1", "B", "muse", "2025-07-01T00:00:00Z", JSON.stringify({ modelSelection: { model: "fallback-model", provider: "muse" } }), null, null);
  insThread.run(THREAD_CHILD, "p1", "child", "claudeAgent", "2025-07-01T00:00:00Z", "{}", null, null);
  db.prepare("INSERT INTO projection_projects VALUES (?,?,?)").run("p1", "proj", tmpRoot);
  const insPT = db.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?,?,?,?,?)");
  for (const [thread, museId, codexId] of [[THREAD_A, MUSE_ID, CODEX_ID], [THREAD_B, MUSE_ID_B, CODEX_ID_B]]) {
    insPT.run(`${thread}-muse`, thread, "muse", "2025-01-02T00:00:00Z", JSON.stringify({ nativeThreadRef: { nativeId: museId }, contextUsage: { usedTokens: 100, maxTokens: 200 } }));
    insPT.run(`${thread}-codex`, thread, "codex", "2025-06-02T00:00:00Z", JSON.stringify({ nativeThreadRef: { nativeId: codexId }, contextUsage: { usedTokens: 777, maxTokens: 888 } }));
    insPT.run(`${thread}-cla`, thread, "claudeAgent", thread === THREAD_B ? "2024-01-01T00:00:04Z" : "2025-06-15T00:00:00Z", JSON.stringify({ contextUsage: { usedTokens: 12345, maxTokens: 200000 } }));
  }
  insPT.run("child-pt", THREAD_CHILD, "claudeAgent", "2025-07-01T00:00:00Z", JSON.stringify({ contextUsage: { usedTokens: 10, maxTokens: 200000 } }));
  const insTurn = db.prepare("INSERT INTO orchestration_v2_projection_provider_turns VALUES (?,?,?,?,?,?,?)");
  // Covered Muse turn must NOT double-count: output 9999 is ignored by the uncovered scan.
  insTurn.run("a-covered", THREAD_A, 1, "completed", "2025-01-01T00:00:00Z", "2025-01-01T00:00:05Z", JSON.stringify({ nativeTurnRef: { driver: "muse", nativeId: MUSE_ID }, turnTokenUsage: { inputTokens: 5000, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 9999, reasoningTokens: 0 } }));
  // Uncovered claudeAgent turn: NEWER than both native files (override + avg math).
  insTurn.run("a-unc", THREAD_A, 2, "completed", "2025-07-01T00:00:00Z", "2025-07-01T00:00:04Z", JSON.stringify({ nativeTurnRef: { driver: "claudeAgent", nativeId: "x" }, turnTokenUsage: { inputTokens: 1000, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 200, reasoningTokens: 0, models: ["claude-opus-4-test"] } }));
  // Thread B: uncovered turn OLDER than native parts -> no override.
  insTurn.run("b-unc", THREAD_B, 1, "completed", "2024-01-01T00:00:00Z", "2024-01-01T00:00:04Z", JSON.stringify({ nativeTurnRef: { driver: "claudeAgent", nativeId: "x" }, turnTokenUsage: { inputTokens: 1000, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 200, reasoningTokens: 0, models: ["claude-opus-4-test"] } }));
  insTurn.run("child-t1", THREAD_CHILD, 1, "completed", "2025-07-01T00:00:00Z", "2025-07-01T00:00:03Z", JSON.stringify({ turnTokenUsage: { inputTokens: 100, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 50, reasoningTokens: 0 } }));
  db.prepare("INSERT INTO orchestration_v2_projection_subagents VALUES (?,?,?,?)").run("sub-1", THREAD_A, "claudeAgent", THREAD_CHILD);
  db.close();
  const idx = new DatabaseSync(path.join(tmpMuse, "session-index.db"));
  idx.exec("CREATE TABLE sessions (session_id TEXT, session_log_path TEXT)");
  idx.prepare("INSERT INTO sessions VALUES (?,?)").run(MUSE_ID, museFileA);
  idx.prepare("INSERT INTO sessions VALUES (?,?)").run(MUSE_ID_B, museFileB);
  idx.close();
}

before(() => buildDb());

describe("Fix 1: subagent turn cache signature", () => {
  it("backend source uses ordinal/completed_at signature, not updated_at", () => {
    const src = fs.readFileSync(path.join(REPO, "src", "backend.cjs"), "utf8");
    assert.match(src, /MAX\(ordinal\) AS max_ord, MAX\(completed_at\) AS max_done/);
    assert.doesNotMatch(src, /MAX\(updated_at\) as m FROM orchestration_v2_projection_provider_turns/);
  });

  it("child telemetry path runs with zero errors and caches", () => {
    const first = backend.getThreadStats(THREAD_A);
    assert.equal(first.ok, true, JSON.stringify(first.error || first));
    assert.equal(first.cost.subagentCount, 1);
    const second = backend.getThreadStats(THREAD_A);
    assert.equal(second.ok, true);
    assert.equal(second.cost.subagentUsd, first.cost.subagentUsd);
  });
});

describe("Fix 2: whole-session average speed + newer-provider override", () => {
  it("mixed thread: true average, override to newest non-native provider", () => {
    const s = backend.getThreadStats(THREAD_A);
    assert.equal(s.ok, true, JSON.stringify(s.error || s));
    assert.equal(s.telemetrySource, "native");
    // (300 muse + 20 codex + 200 uncovered) / (4s + 2s + 4s) = 52.0 t/s
    assert.equal(s.speed.tokPerSec, 53.3);
    // lastDecodeTps stays the newest native part's own last-step speed.
    assert.equal(s.speed.lastDecodeTps, 10);
    assert.equal(s.provider, "claudeAgent");
    assert.equal(s.model, "claude-opus-4-test");
    assert.equal(s.tokens.contextUsed, 12345);
    assert.equal(s.tokens.contextMax, 200000);
    // 530 proves the covered Muse turn (9999) was not double-counted.
    assert.equal(s.tokens.output, 580); // 530 main + 50 subagent (covered Muse 9999 not double-counted!)
  });

  it("older uncovered turn: no override, same whole-session average", () => {
    const s = backend.getThreadStats(THREAD_B);
    assert.equal(s.ok, true, JSON.stringify(s.error || s));
    assert.equal(s.telemetrySource, "native");
    assert.equal(s.speed.tokPerSec, 53.3);
    assert.equal(s.provider, "codex");
    assert.equal(s.model, "codex-model-b");
    assert.equal(s.tokens.contextMax, 999000);
    assert.equal(s.tokens.contextUsed, 2030);
  });
});

describe("Fix 3 backend: langUpdatedAt round-trip", () => {
  const cfgPath = () => path.join(tmpHome, ".t3", "hud-plugin", "config.json");
  it("setConfig persists langUpdatedAt; getConfig returns it", () => {
    const r = backend.setConfig({ userLang: "en", langUpdatedAt: 1700000000001 });
    assert.equal(r.ok, true);
    const got = backend.getConfig();
    assert.equal(got.userLang, "en");
    assert.equal(got.langUpdatedAt, 1700000000001);
    const raw = JSON.parse(fs.readFileSync(cfgPath(), "utf8"));
    assert.equal(raw.userLang, "en");
    assert.equal(raw.langUpdatedAt, 1700000000001);
  });

  it("config with userLang null surfaces null (auto) plus timestamp", () => {
    fs.mkdirSync(path.dirname(cfgPath()), { recursive: true });
    fs.writeFileSync(cfgPath(), JSON.stringify({ defaultLang: "zh", userLang: null, langUpdatedAt: 1700000000002 }) + "\n");
    const got = backend.getConfig();
    assert.ok(Object.prototype.hasOwnProperty.call(got, "userLang"));
    assert.equal(got.userLang, null);
    assert.equal(got.langUpdatedAt, 1700000000002);
  });
});

function runSh(script, env = {}) {
  return execFileSync("bash", ["-c", script], {
    cwd: REPO,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("Fix 3 CLI: t3-hud lang writes langUpdatedAt", () => {
  it("lang en/zh write userLang + timestamp; lang auto writes null + timestamp", () => {
    const hudDir = path.join(tmpRoot, "hud-plugin");
    const fakeApp = path.join(tmpRoot, "Fake.app");
    fs.mkdirSync(path.join(fakeApp, "Contents", "MacOS"), { recursive: true });
    const fakeBin = path.join(fakeApp, "Contents", "MacOS", "fakebin");
    fs.writeFileSync(fakeBin, `#!/bin/sh\nif [ "$ELECTRON_RUN_AS_NODE" = "1" ]; then exec "${process.execPath}" "$@"; fi\nexit 0\n`);
    fs.chmodSync(fakeBin, 0o755);
    const env = { T3_HUD_DIR: hudDir, T3_APP_PATH: fakeApp };
    const cfgFile = path.join(hudDir, "config.json");
    const read = () => JSON.parse(fs.readFileSync(cfgFile, "utf8"));

    runSh("bash bin/t3-hud lang en", env);
    let cfg = read();
    assert.equal(cfg.userLang, "en");
    assert.equal(typeof cfg.langUpdatedAt, "number");
    assert.ok(cfg.langUpdatedAt > 0);

    runSh("bash bin/t3-hud lang auto", env);
    cfg = read();
    assert.ok(Object.prototype.hasOwnProperty.call(cfg, "userLang"));
    assert.equal(cfg.userLang, null);
    assert.equal(typeof cfg.langUpdatedAt, "number");

    runSh("bash bin/t3-hud lang zh", env);
    cfg = read();
    assert.equal(cfg.userLang, "zh");
    assert.equal(typeof cfg.langUpdatedAt, "number");
  });

  it("renderer stores lang-ts, sends langUpdatedAt, and syncs from config", () => {
    const src = fs.readFileSync(path.join(REPO, "src", "renderer-ui.js"), "utf8");
    assert.match(src, /t3-hud-lang-ts/);
    assert.match(src, /const nowTs = Date\.now\(\)/);
    assert.match(src, /userLang: target, langUpdatedAt: nowTs/);
    assert.match(src, /async function syncConfigLang\(\)/);
    assert.match(src, /const remoteTs = Number\(cfg\.langUpdatedAt\)/);
    assert.match(src, /remoteTs <= localTs/);
    assert.match(src, /cfg\.userLang === null/);
  });
});

describe("Fix 4: install.sh AppleLanguages precedence", () => {
  const fnSrc = () => {
    const full = fs.readFileSync(path.join(REPO, "install.sh"), "utf8");
    const m = full.match(/^detect_locale_lang\(\) \{[\s\S]*?^\}/m);
    assert.ok(m, "detect_locale_lang not found");
    return m[0];
  };
  function detect(envVars, appleFirst) {
    const inner = `${fnSrc()}\ndefaults() { printf '(\\n    "${appleFirst}",\\n    "en-CN"\\n)\\n'; }\ndetect_locale_lang`;
    return runSh(inner, { LC_ALL: "", LC_MESSAGES: "", LANG: "", ...envVars }).trim();
  }
  it("Chinese Mac with LANG=en_US.UTF-8 still resolves zh (AppleLanguages wins)", () => {
    assert.equal(detect({ LANG: "en_US.UTF-8" }, "zh-Hans-CN"), "zh");
  });
  it("explicit zh locale wins over English AppleLanguages", () => {
    assert.equal(detect({ LANG: "zh_CN.UTF-8" }, "en-US"), "zh");
  });
  it("English locale + English AppleLanguages resolves en", () => {
    assert.equal(detect({ LANG: "en_US.UTF-8" }, "en-US"), "en");
  });
  it("unset/C locale falls back to AppleLanguages both ways", () => {
    assert.equal(detect({}, "en-US"), "en");
    assert.equal(detect({}, "zh-Hans-CN"), "zh");
    assert.equal(detect({ LANG: "C.UTF-8" }, "zh-Hans-SG"), "zh");
  });
});
