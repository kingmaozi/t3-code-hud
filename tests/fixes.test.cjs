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
    // The newest uncovered turn uses its own 200 tokens / 4 effective seconds.
    assert.equal(s.speed.lastDecodeTps, 50);
    assert.equal(s.provider, "claudeAgent");
    assert.equal(s.model, "claude-opus-4-test");
    assert.equal(s.tokens.contextUsed, 12345);
    assert.equal(s.tokens.contextMax, 200000);
    assert.equal(s.cache.turnRate, 0, "latest provider turn cache wins even when native parts belong to older providers");
    assert.equal(s.cache.lastCallRate, null, "a newer statev2 turn without a native call record does not relabel the previous native call");
    assert.equal(s.cache.mainSessionRate, 0.16);
    assert.ok(Math.abs(s.cache.withSubagentsSessionRate - 800 / 5100) < 1e-12);
    assert.equal(s.cache.sessionRate, s.cache.withSubagentsSessionRate);
    // 530 proves the covered Muse turn (9999) was not double-counted.
    assert.equal(s.tokens.output, 580); // 530 main + 50 subagent (covered Muse 9999 not double-counted!)
  });

  it("older uncovered turn keeps provider and average; newer same-provider context wins", () => {
    const s = backend.getThreadStats(THREAD_B);
    assert.equal(s.ok, true, JSON.stringify(s.error || s));
    assert.equal(s.telemetrySource, "native");
    assert.equal(s.speed.tokPerSec, 53.3);
    assert.equal(s.provider, "codex");
    assert.equal(s.model, "codex-model-b");
    // The Codex projection (June 2) is newer than its native sample (June 1).
    assert.equal(s.tokens.contextMax, 888);
    assert.equal(s.tokens.contextUsed, 777);
  });

  it("latest completed turn without cache usage cannot inherit a previous provider's rate", () => {
    const db = new DatabaseSync(path.join(tmpUserdata, "statev2.sqlite"));
    const update = db.prepare("UPDATE orchestration_v2_projection_provider_turns SET payload_json = ? WHERE provider_turn_id = 'a-unc'");
    for (const usage of [null, { inputTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0 }]) {
      const payload = { nativeTurnRef: { driver: "claudeAgent", nativeId: "x" } };
      if (usage) payload.turnTokenUsage = usage;
      update.run(JSON.stringify(payload));
      const s = backend.getThreadStats(THREAD_A);
      assert.equal(s.ok, true);
      assert.equal(s.cache.turnRate, null);
      assert.equal(s.cache.lastTurnRate, null);
      assert.ok(s.cache.sessionRate > 0, "cumulative cache statistics stay available as a separate field");
      assert.equal(s.cache.lastCallRate, null);
    }
    db.close();
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

describe("Remote: priceRemoteProjection backend", () => {
  const T0 = 1735689600000;
  function payload(overrides = {}) {
    return {
      environmentId: "env-1",
      threadId: "remote-thread-1",
      title: "Remote thread",
      provider: "codex",
      model: "test-model-remote",
      branch: "main",
      repoPath: "/tmp/repo",
      isServerThread: true,
      isRunning: false,
      subagentCount: 2,
      contextUsage: { usedTokens: 5000, maxTokens: 200000 },
      toolIntervals: [[T0 + 1000, T0 + 3000]],
      turns: [
        {
          status: "completed",
          driver: "codex",
          startedMs: T0,
          completedMs: T0 + 5000,
          usage: { inputTokens: 1000, cachedInputTokens: 200, cacheCreationTokens: 0, outputTokens: 150, reasoningTokens: 0, models: ["test-model-remote"] },
        },
      ],
      ...overrides,
    };
  }
  it("prices a simple remote turn with tool-wait subtraction", () => {
    const r = backend.priceRemoteProjection(payload());
    assert.equal(r.ok, true, JSON.stringify(r.error || r));
    assert.equal(r.telemetrySource, "remote-projection");
    assert.equal(r.isRemote, true);
    assert.equal(r.threadId, "remote-thread-1");
    assert.equal(r.provider, "codex");
    assert.equal(r.model, "test-model-remote");
    assert.equal(r.tokens.input, 1000);
    assert.equal(r.tokens.uncached, 800);
    assert.equal(r.tokens.cached, 200);
    assert.equal(r.tokens.output, 150);
    assert.equal(r.tokens.total, 1150);
    assert.equal(r.cache.sessionRate, 0.2);
    assert.equal(r.cost.subagentCount, 2);
    assert.equal(r.cost.subagentUsd, 0);
    assert.equal(r.cost.withSubagentsUsd, r.cost.sessionUsd);
    assert.equal(r.cost.estimated, false);
    assert.ok(r.cost.sessionUsd > 0, "cost should be positive");
    assert.equal(r.speed.tokPerSec, 50);
    assert.equal(r.speed.lastDecodeTps, 50);
    assert.equal(r.speed.byModel["test-model-remote"], 50);
    assert.equal(r.tokens.contextUsed, 5000);
    assert.equal(r.tokens.contextMax, 200000);
    assert.equal(r.turnCount, 1);
    assert.equal(r.stepCount, 1);
  });
  it("dedupes Antigravity double-counted cached tokens", () => {
    const r = backend.priceRemoteProjection(
      payload({
        provider: "antigravity",
        model: "gemini-test",
        contextUsage: null,
        toolIntervals: [],
        turns: [
          {
            status: "completed",
            driver: "antigravity",
            startedMs: T0,
            completedMs: T0 + 4000,
            usage: { inputTokens: 2000, cachedInputTokens: 800, cacheCreationTokens: 0, outputTokens: 100, reasoningTokens: 0, models: ["gemini-test"] },
          },
        ],
      })
    );
    assert.equal(r.ok, true);
    // inp 2000 >= 800*2 -> inp = 1200, unc = 400
    assert.equal(r.tokens.uncached, 400);
    assert.equal(r.tokens.cached, 800);
    assert.equal(r.tokens.input, 1200);
    // context falls back to lastPromptTotal (inp + out = 1300) and AGY max 1048576
    assert.equal(r.tokens.contextUsed, 1300);
    assert.equal(r.tokens.contextMax, 1048576);
  });
  it("prefers lastPromptTotal when AGY contextUsage is double-counted", () => {
    const r = backend.priceRemoteProjection(
      payload({
        provider: "antigravity",
        model: "gemini-test",
        contextUsage: { usedTokens: 999999, maxTokens: 1048576 },
        toolIntervals: [],
        turns: [
          {
            status: "completed",
            driver: "antigravity",
            startedMs: T0,
            completedMs: T0 + 4000,
            usage: { inputTokens: 2000, cachedInputTokens: 800, cacheCreationTokens: 0, outputTokens: 100, reasoningTokens: 0, models: ["gemini-test"] },
          },
        ],
      })
    );
    assert.equal(r.tokens.contextUsed, 1300);
  });
  it("rejects invalid payloads", () => {
    assert.equal(backend.priceRemoteProjection(null).ok, false);
    assert.equal(backend.priceRemoteProjection("nope").ok, false);
  });
});

describe("Remote: getGitGraph fallbackCwd", () => {
  it("reads local repo via fallbackCwd when thread has no local rows", async () => {
    const repoDir = path.join(tmpRoot, "remote-local-repo");
    fs.mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "t@t.t"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, "a.txt"), "hello\n");
    execFileSync("git", ["add", "a.txt"], { cwd: repoDir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoDir });
    const g = await backend.getGitGraph("thread:remote-unknown-xyz", 10, repoDir);
    assert.equal(g.ok, true, JSON.stringify(g));
    assert.equal(g.repoPath, repoDir);
    assert.ok(g.commits.length >= 1);
  });
  it("returns remoteOnly for non-existent remote cwd", async () => {
    const g = await backend.getGitGraph("thread:remote-unknown-xyz", 10, "/root/app-nonexistent-xyz-123");
    assert.equal(g.ok, false);
    assert.equal(g.remoteOnly, true);
    assert.equal(g.remoteCwd, "/root/app-nonexistent-xyz-123");
    assert.equal(g.error, "Remote workspace");
  });
  it("getCommitDetail forwards remoteOnly", async () => {
    const d = await backend.getCommitDetail("thread:remote-unknown-xyz", "deadbeef", "/root/app-nonexistent-xyz-123");
    assert.equal(d.ok, false);
    assert.equal(d.remoteOnly, true);
  });
});

describe("Remote: renderer fiber projection + router (source + local fallback)", () => {
  const src = () => fs.readFileSync(path.join(REPO, "src", "renderer-ui.js"), "utf8");
  function loadPure() {
    const s = src();
    const start = s.indexOf("function toEpochMs(");
    const end = s.indexOf("// Distinct, clean Git swimlane");
    assert.ok(start !== -1 && end !== -1 && end > start, "pure chunk not found");
    const chunk = s.slice(start, end);
    // eslint-disable-next-line no-new-func
    return new Function(chunk + "\nreturn { toEpochMs, buildLocalProjectionFallback, fallbackModelRate };")();
  }
  it("implements fiber walk, router lookup, and draft handling", () => {
    const s = src();
    assert.match(s, /function readFiberThreadProjection\(/);
    assert.match(s, /function findTanStackRouter\(/);
    assert.match(s, /window\.__TSR_ROUTER__/);
    assert.match(s, /visited < 20000/);
    assert.match(s, /visited < 400/);
    assert.match(s, /function buildLocalProjectionFallback\(/);
    assert.match(s, /function toEpochMs\(/);
    assert.match(s, /r\.subscribe\("onResolved"/);
    assert.match(s, /unsubscribeRouter/);
    assert.match(s, /isServerThread === false/);
    assert.match(s, /isDraftThread: true/);
    assert.match(s, /priceRemoteProjection/);
    assert.match(s, /remoteOnly/);
    assert.match(s, /This thread runs on a remote server \(/);
    assert.match(s, /"gitCwd" in mp/);
    assert.match(s, /isServerThread" in mp/);
  });
  it("toEpochMs normalizes numbers, epoch objects, and parenthesized strings", () => {
    const { toEpochMs } = loadPure();
    assert.equal(toEpochMs(123), 123);
    assert.equal(toEpochMs({ epochMilliseconds: 456 }), 456);
    assert.equal(toEpochMs("foo (2025-01-01T00:00:00Z)"), Date.parse("2025-01-01T00:00:00Z"));
    assert.equal(toEpochMs("2025-01-01T00:00:00Z"), Date.parse("2025-01-01T00:00:00Z"));
    assert.equal(toEpochMs(null), null);
    assert.equal(toEpochMs("not-a-date"), null);
  });
  it("buildLocalProjectionFallback mirrors backend pricing without a main process", () => {
    const { buildLocalProjectionFallback } = loadPure();
    assert.equal(buildLocalProjectionFallback(null).ok, false);
    const r = buildLocalProjectionFallback({
      threadId: "t1",
      title: "x",
      provider: "codex",
      model: "test-model-remote",
      contextUsage: { usedTokens: 5000, maxTokens: 200000 },
      toolIntervals: [[1000, 3000]],
      turns: [
        { driver: "codex", startedMs: 0, completedMs: 5000, usage: { inputTokens: 1000, cachedInputTokens: 200, cacheCreationTokens: 0, outputTokens: 150, reasoningTokens: 0, models: ["test-model-remote"] } },
      ],
    });
    assert.equal(r.ok, true);
    assert.equal(r.telemetrySource, "remote-projection");
    assert.equal(r.speed.tokPerSec, 50);
    assert.equal(r.speed.byModel["test-model-remote"], 50);
    assert.equal(r.tokens.total, 1150);
    assert.ok(r.cost.sessionUsd > 0);
    assert.equal(r.tokens.contextUsed, 5000);
  });
  it("buildLocalProjectionFallback dedupes Antigravity cache", () => {
    const { buildLocalProjectionFallback } = loadPure();
    const r = buildLocalProjectionFallback({
      provider: "antigravity",
      model: "gemini-test",
      contextUsage: null,
      toolIntervals: [],
      turns: [
        { driver: "antigravity", startedMs: 0, completedMs: 4000, usage: { inputTokens: 2000, cachedInputTokens: 800, cacheCreationTokens: 0, outputTokens: 100, reasoningTokens: 0, models: ["gemini-test"] } },
      ],
    });
    assert.equal(r.tokens.uncached, 400);
    assert.equal(r.tokens.input, 1200);
  });
  it("main-hook and preload wire price-remote IPC/RPC and hot-reload", () => {
    const mh = fs.readFileSync(path.join(REPO, "src", "main-hook.cjs"), "utf8");
    const pl = fs.readFileSync(path.join(REPO, "src", "preload-bridge.cjs"), "utf8");
    assert.match(mh, /function reloadBackend\(\)/);
    assert.match(mh, /reloadBackend\(\);/);
    assert.match(mh, /t3hud:price-remote-projection/);
    assert.match(mh, /priceRemoteProjection/);
    assert.match(mh, /args\[2\]/);
    assert.match(pl, /priceRemoteProjection: \(payload\) => ipcRenderer\.invoke\("t3hud:price-remote-projection", payload\)/);
    assert.match(pl, /fallbackCwd/);
  });
});

describe("Review regressions: dual-UUID, multi-projection, env collision & codesign order", () => {
  it("extractLastThreadIdFromHint picks threadId (2nd UUID) on /environmentId/threadId", () => {
    const src = fs.readFileSync(path.join(REPO, "src", "renderer-ui.js"), "utf8");
    const m = src.match(/function extractLastThreadIdFromHint\(rawHint\) \{[\s\S]*?\n  \}/);
    assert.ok(m, "extractLastThreadIdFromHint missing");
    const fn = new Function("return (" + m[0] + ")")();
    assert.equal(
      fn("/394c13c6-05ea-4538-8e6d-7fafe1a362d5/af3a2a24-7338-407b-9e28-e9a03f91b3e3"),
      "af3a2a24-7338-407b-9e28-e9a03f91b3e3"
    );
  });

  it("readFiberThreadProjection returns matched 2nd projection instead of 1st projection", () => {
    const src = fs.readFileSync(path.join(REPO, "src", "renderer-ui.js"), "utf8");
    const m1 = src.match(/function toEpochMs\(v\) \{[\s\S]*?\n  \}/);
    const m2 = src.match(/function extractLastThreadIdFromHint\(rawHint\) \{[\s\S]*?\n  \}/);
    const m3 = src.match(/function buildProjectionPayload\(p, stEnvId, uhProps\) \{[\s\S]*?\n  \}/);
    const m4 = src.match(/function readFiberThreadProjection\(expectedThreadId\) \{[\s\S]*?\n  \}/);
    assert.ok(m1 && m2 && m3 && m4);
    const proj1 = { thread: { id: "11111111-1111-4111-8111-111111111111", title: "WrongFirst", providerInstanceId: "muse" }, providerTurns: [{ turnTokenUsage: { inputTokens: 10, outputTokens: 5 } }] };
    const proj2 = { thread: { id: "af3a2a24-7338-407b-9e28-e9a03f91b3e3", title: "RightSecond", providerInstanceId: "codex" }, providerTurns: [{ turnTokenUsage: { inputTokens: 900, outputTokens: 80 } }] };
    const fakeDoc = {
      getElementById: () => ({
        __reactContainer$1: {
          child: { memoizedState: { memoizedState: { environmentId: "env-1", projection: proj1 }, next: null }, sibling: { memoizedState: { memoizedState: { environmentId: "env-2", projection: proj2 }, next: null } } }
        }
      })
    };
    const runner = new Function("document", `${m1[0]}; ${m2[0]}; ${m3[0]}; return (${m4[0]});`)(fakeDoc);
    const got = runner("/394c13c6-05ea-4538-8e6d-7fafe1a362d5/af3a2a24-7338-407b-9e28-e9a03f91b3e3");
    assert.equal(got.threadId, "af3a2a24-7338-407b-9e28-e9a03f91b3e3");
    assert.equal(got.title, "RightSecond");
    assert.equal(got.environmentId, "env-2");
  });

  it("getGitGraph rejects local-existing path when remote environmentId differs from local environment-id", async () => {
    fs.writeFileSync(path.join(tmpUserdata, "environment-id"), "6ee0c274-d218-41d6-b277-cbfc803dfbc0\n");
    const res = await backend.getGitGraph("/394c13c6-05ea-4538-8e6d-7fafe1a362d5/af3a2a24-7338-407b-9e28-e9a03f91b3e3", 20, {
      cwd: REPO,
      environmentId: "394c13c6-05ea-4538-8e6d-7fafe1a362d5"
    });
    assert.equal(res.ok, false);
    assert.equal(res.remoteOnly, true);
    const withLocalThread = await backend.getGitGraph(THREAD_A, 20, {
      cwd: REPO,
      environmentId: "394c13c6-05ea-4538-8e6d-7fafe1a362d5"
    });
    assert.equal(withLocalThread.remoteOnly, true, "a known local thread must not override an explicitly selected remote environment");
    fs.unlinkSync(path.join(tmpUserdata, "environment-id"));
    const resMissing = await backend.getGitGraph("/394c13c6-05ea-4538-8e6d-7fafe1a362d5/af3a2a24-7338-407b-9e28-e9a03f91b3e3", 20, {
      cwd: REPO,
      environmentId: "394c13c6-05ea-4538-8e6d-7fafe1a362d5"
    });
    assert.equal(resMissing.ok, false);
    assert.equal(resMissing.remoteOnly, true);
  });

  it("install.sh runs codesign AFTER Info.plist and icon.icns", () => {
    const sh = fs.readFileSync(path.join(REPO, "install.sh"), "utf8");
    const plistIdx = sh.indexOf("Contents/Info.plist");
    const iconIdx = sh.indexOf("Contents/Resources/icon.icns");
    const signIdx = sh.indexOf("codesign --force --deep --sign -");
    assert.ok(plistIdx > 0 && iconIdx > plistIdx && signIdx > iconIdx);
  });
});

describe("Fix A: Antigravity contextUsage double-count dedup (278570 @ 96% -> ~142127)", () => {
  const T0 = 1735689600000;
  function agyPayload() {
    return {
      provider: "antigravity",
      model: "gemini-test",
      contextUsage: { usedTokens: 278570, maxTokens: 1048576 },
      toolIntervals: [],
      turns: [
        {
          status: "completed",
          driver: "antigravity",
          startedMs: T0,
          completedMs: T0 + 4000,
          usage: { inputTokens: 142128, cachedInputTokens: 136443, cacheCreationTokens: 0, outputTokens: 2000, reasoningTokens: 500, models: ["gemini-test"] },
        },
      ],
    };
  }
  it("backend priceRemoteProjection divides by (1 + 96% cache rate)", () => {
    const r = backend.priceRemoteProjection(agyPayload());
    assert.equal(r.ok, true, JSON.stringify(r.error || r));
    assert.ok(Math.abs(r.tokens.contextUsed - 142127) <= 2, `contextUsed=${r.tokens.contextUsed}`);
    const pct = (r.tokens.contextUsed / r.tokens.contextMax) * 100;
    assert.ok(pct >= 13.4 && pct <= 13.8, `pct=${pct}`);
  });
  it("renderer buildLocalProjectionFallback divides by (1 + 96% cache rate)", () => {
    const src = fs.readFileSync(path.join(REPO, "src", "renderer-ui.js"), "utf8");
    const start = src.indexOf("function toEpochMs(");
    const end = src.indexOf("// Distinct, clean Git swimlane");
    assert.ok(start !== -1 && end !== -1 && end > start);
    const chunk = src.slice(start, end);
    // eslint-disable-next-line no-new-func
    const { buildLocalProjectionFallback } = new Function(chunk + "\nreturn { buildLocalProjectionFallback };")();
    const r = buildLocalProjectionFallback(agyPayload());
    assert.equal(r.ok, true);
    assert.ok(Math.abs(r.tokens.contextUsed - 142127) <= 2, `contextUsed=${r.tokens.contextUsed}`);
  });
});

describe("Fix A: remote pure streaming decode speed (~214 tok/s, tool wait ignored)", () => {
  const T0 = 1735689600000;
  function decodePayload() {
    return {
      provider: "antigravity",
      model: "gemini-test",
      contextUsage: { usedTokens: 142128, maxTokens: 1048576 },
      // 78s of file_search inside a 95s wall turn: invisible to decode speed.
      toolIntervals: [[T0 + 1000, T0 + 79400]],
      turns: [
        {
          status: "completed",
          driver: "antigravity",
          startedMs: T0,
          completedMs: T0 + 95000,
          streamDecode: { streamSec: 2, visFraction: 1 },
          usage: { inputTokens: 142128, cachedInputTokens: 136443, cacheCreationTokens: 0, outputTokens: 429, reasoningTokens: 0, models: ["gemini-test"] },
        },
      ],
    };
  }
  it("backend prefers streamDecode over wall clock (429 tok / 2s = 214.5 t/s)", () => {
    const r = backend.priceRemoteProjection(decodePayload());
    assert.equal(r.ok, true, JSON.stringify(r.error || r));
    assert.equal(r.speed.tokPerSec, 214.5);
    assert.equal(r.speed.lastDecodeTps, 214.5);
    assert.equal(r.speed.byModel["gemini-test"], 214.5);
  });
  it("renderer fallback mirrors streamDecode pricing", () => {
    const src = fs.readFileSync(path.join(REPO, "src", "renderer-ui.js"), "utf8");
    const start = src.indexOf("function toEpochMs(");
    const end = src.indexOf("// Distinct, clean Git swimlane");
    assert.ok(start !== -1 && end !== -1 && end > start);
    const chunk = src.slice(start, end);
    // eslint-disable-next-line no-new-func
    const { buildLocalProjectionFallback } = new Function(chunk + "\nreturn { buildLocalProjectionFallback };")();
    const r = buildLocalProjectionFallback(decodePayload());
    assert.equal(r.speed.tokPerSec, 214.5);
  });
  it("fiber walk emits streamDecode + toolIntervals incl. file_search", () => {
    const src = fs.readFileSync(path.join(REPO, "src", "renderer-ui.js"), "utf8");
    const m1 = src.match(/function toEpochMs\(v\) \{[\s\S]*?\n  \}/);
    const m2 = src.match(/function extractLastThreadIdFromHint\(rawHint\) \{[\s\S]*?\n  \}/);
    const m3 = src.match(/function buildProjectionPayload\(p, stEnvId, uhProps\) \{[\s\S]*?\n  \}/);
    const m4 = src.match(/function readFiberThreadProjection\(expectedThreadId\) \{[\s\S]*?\n  \}/);
    assert.ok(m1 && m2 && m3 && m4);
    const T = 1735689600000;
    const turnItems = [
      { type: "file_search", providerTurnId: "turn-1", startedAt: T + 1000, completedAt: T + 79400, input: "query" },
      { type: "assistant_message", providerTurnId: "turn-1", startedAt: T + 80000, completedAt: T + 81000, text: "x".repeat(650) },
    ];
    const proj = {
      thread: { id: "af3a2a24-7338-407b-9e28-e9a03f91b3e3", title: "Fiber", providerInstanceId: "antigravity" },
      providerTurns: [
        { id: "turn-1", status: "completed", startedAt: T, completedAt: T + 95000, nativeTurnRef: { driver: "antigravity" },
          turnTokenUsage: { inputTokens: 142128, cachedInputTokens: 136443, cacheCreationTokens: 0, outputTokens: 215, reasoningTokens: 0, models: ["gemini-test"] } },
      ],
      nodes: turnItems.map((it) => ({ kind: it.type, providerTurnId: it.providerTurnId, startedAt: it.startedAt, completedAt: it.completedAt })),
      turnItems,
    };
    const fakeDoc = {
      getElementById: () => ({
        __reactContainer$1: {
          child: { memoizedState: { memoizedState: { environmentId: "env-1", projection: proj }, next: null }, sibling: null }
        }
      })
    };
    const runner = new Function("document", `${m1[0]}; ${m2[0]}; ${m3[0]}; return (${m4[0]});`)(fakeDoc);
    const got = runner("/394c13c6-05ea-4538-8e6d-7fafe1a362d5/af3a2a24-7338-407b-9e28-e9a03f91b3e3");
    assert.equal(got.threadId, "af3a2a24-7338-407b-9e28-e9a03f91b3e3");
    // file_search (78.4s) must be inside toolIntervals now.
    assert.ok(got.toolIntervals.some(([s, e]) => e - s === 78400), JSON.stringify(got.toolIntervals));
    // Final assistant_message span: 80000 -> 81000 = 1s pure decode window.
    assert.equal(got.turns.length, 1);
    assert.equal(got.turns[0].streamDecode.streamSec, 1);
    assert.ok(got.turns[0].streamDecode.visFraction > 0 && got.turns[0].streamDecode.visFraction < 1);
  });
});

describe("Fix B: subagent %3A id preservation + running Turn 1 live tokens", () => {
  const RAW_ID = "thread:delegated-task:command%3Amcp%3Aremote%3Aworker-7";
  const ENC_ID = "thread%3Adelegated-task%3Acommand%253Amcp%253Aremote%253Aworker-7";
  function extractFn() {
    const src = fs.readFileSync(path.join(REPO, "src", "renderer-ui.js"), "utf8");
    const m = src.match(/function extractLastThreadIdFromHint\(rawHint\) \{[\s\S]*?\n  \}/);
    assert.ok(m, "extractLastThreadIdFromHint missing");
    // eslint-disable-next-line no-new-func
    return new Function("return (" + m[0] + ")")();
  }
  it("raw thread: id with literal %3A is returned undecoded", () => {
    assert.equal(extractFn()(RAW_ID), RAW_ID);
    assert.equal(extractFn()("/some/route/" + RAW_ID), RAW_ID);
  });
  it("single-encoded thread%3A id decodes once, preserving inner %3A", () => {
    assert.equal(extractFn()(ENC_ID), RAW_ID);
  });
  it("readFiberThreadProjection matches raw-pid against encoded hint and vice versa", () => {
    const src = fs.readFileSync(path.join(REPO, "src", "renderer-ui.js"), "utf8");
    const m1 = src.match(/function toEpochMs\(v\) \{[\s\S]*?\n  \}/);
    const m2 = src.match(/function extractLastThreadIdFromHint\(rawHint\) \{[\s\S]*?\n  \}/);
    const m3 = src.match(/function buildProjectionPayload\(p, stEnvId, uhProps\) \{[\s\S]*?\n  \}/);
    const m4 = src.match(/function readFiberThreadProjection\(expectedThreadId\) \{[\s\S]*?\n  \}/);
    assert.ok(m1 && m2 && m3 && m4);
    const makeDoc = (pid) => ({
      getElementById: () => ({
        __reactContainer$1: {
          child: { memoizedState: { memoizedState: { environmentId: "env-1",
            projection: { thread: { id: pid, title: "Sub", providerInstanceId: "codex" },
              providerTurns: [{ turnTokenUsage: { inputTokens: 10, outputTokens: 5 } }] } }, next: null }, sibling: null }
        }
      })
    });
    // pid raw, hint encoded.
    let runner = new Function("document", `${m1[0]}; ${m2[0]}; ${m3[0]}; return (${m4[0]});`)(makeDoc(RAW_ID));
    let got = runner(ENC_ID);
    assert.equal(got.threadId, RAW_ID, `raw-pid vs enc-hint: ${JSON.stringify(got)}`);
    // pid encoded, hint raw.
    runner = new Function("document", `${m1[0]}; ${m2[0]}; ${m3[0]}; return (${m4[0]});`)(makeDoc(ENC_ID));
    got = runner(RAW_ID);
    assert.equal(got.threadId, ENC_ID, `enc-pid vs raw-hint: ${JSON.stringify(got)}`);
  });
  it("running Turn 1 (pricedTurns 0) surfaces live contextUsed as tokens + cost", () => {
    const r = backend.priceRemoteProjection({
      environmentId: "env-1",
      threadId: "thread:delegated-task:command%3Amcp%3Aremote%3Aworker-7",
      provider: "codex",
      model: "gpt-6.1-sol",
      isRunning: true,
      isServerThread: true,
      contextUsage: { usedTokens: 50000, maxTokens: 200000 },
      toolIntervals: [],
      turns: [{ status: "running", driver: "codex", startedMs: 1735689600000, completedMs: null, usage: null }],
    });
    assert.equal(r.ok, true, JSON.stringify(r.error || r));
    assert.equal(r.tokens.total, 50000);
    assert.equal(r.tokens.input, 50000);
    assert.equal(r.cost.estimated, true);
    assert.ok(r.cost.sessionUsd > 0, "live cost must be positive");
    assert.equal(r.cost.withSubagentsUsd, r.cost.sessionUsd);
  });
  it("renderer fallback mirrors live Turn 1 tokens + estimated cost", () => {
    const src = fs.readFileSync(path.join(REPO, "src", "renderer-ui.js"), "utf8");
    const start = src.indexOf("function toEpochMs(");
    const end = src.indexOf("// Distinct, clean Git swimlane");
    assert.ok(start !== -1 && end !== -1 && end > start);
    const chunk = src.slice(start, end);
    // eslint-disable-next-line no-new-func
    const { buildLocalProjectionFallback } = new Function(chunk + "\nreturn { buildLocalProjectionFallback };")();
    const r = buildLocalProjectionFallback({
      provider: "codex",
      model: "gpt-6.1-sol",
      isRunning: true,
      contextUsage: { usedTokens: 50000, maxTokens: 200000 },
      toolIntervals: [],
      turns: [],
    });
    assert.equal(r.tokens.total, 50000);
    assert.equal(r.cost.estimated, true);
    assert.ok(r.cost.sessionUsd > 0);
  });
});

describe("Fix C: remote Git bundle (getRemoteGitGraph / getRemoteCommitDetail)", () => {
  const SHA1 = "a".repeat(40);
  const SHA2 = "b".repeat(40);
  const ZERO = "0".repeat(40);
  const nowSec = Math.floor(Date.now() / 1000);
  const headLog = [
    `${ZERO} ${SHA1} Jane Doe <jane@example.com> ${nowSec - 7200} +0000\tcommit (initial): Add feature`,
    `${SHA1} ${SHA2} Jane Doe <jane@example.com> ${nowSec - 3600} +0000\tcommit: Second commit`,
    `${SHA2} ${SHA2} Jane Doe <jane@example.com> ${nowSec - 1800} +0000\tcheckout: moving from main to main`,
  ].join("\n") + "\n";

  it("preserves native review response when git metadata is unavailable", async () => {
    const g = await backend.getRemoteGitGraph({ cwd: "/remote/myrepo", branchCommits: { commits: [
      { sha: SHA2, subject: "Unpushed", committedAt: "2026-01-01T00:00:00Z" }
    ], truncated: false } });
    assert.equal(g.commits.length, 1);
    assert.equal(g.commits[0].hash, SHA2);
  });

  it("marks inaccessible history and parent relationships as incomplete", async () => {
    const g = await backend.getRemoteGitGraph({ cwd: "/remote/repo", branch: "main", branchCommits: { commits: [{ sha: SHA2, subject: "tip", committedAt: "2026-01-01T00:00:00Z" }], truncated: false } });
    assert.equal(g.partialHistory, true);
    assert.equal(g.parentsUnavailable, true);
    assert.deepEqual(g.commits[0].parents, []);
    const missing = await backend.getRemoteGitGraph({ cwd: "/remote/repo" });
    assert.equal(missing.ok, false);
  });

  it("pure local remote repo: reflog -> commits (newest first, parents, badges)", async () => {
    const g = await backend.getRemoteGitGraph({
      environmentId: "env-1",
      cwd: "/remote/myrepo",
      branch: null,
      gitConfig: "[core]\n\trepositoryformatversion = 0\n",
      gitHead: "ref: refs/heads/main\n",
      packedRefs: `${SHA2} refs/heads/main\n`,
      headLog,
      vcsRefs: [{ sha: SHA1, ref: "refs/heads/feature-x" }],
      vcsStatus: { total: 2 },
      branchCommits: null,
    });
    assert.equal(g.ok, true, JSON.stringify(g));
    assert.equal(g.isRemoteGit, true);
    assert.equal(g.remoteSource, "t3-connect");
    assert.equal(g.githubRepo, null);
    assert.equal(g.branch, "main");
    assert.equal(g.repoName, "myrepo");
    assert.equal(g.commits.length, 2);
    assert.equal(g.commits[0].hash, SHA2);
    assert.equal(g.commits[0].subject, "Second commit");
    assert.deepEqual(g.commits[0].parents, []);
    assert.deepEqual(g.commits[1].parents, []);
    assert.equal(g.commits[1].subject, "Add feature");
    assert.match(g.commits[0].relTime, /hour/);
    assert.ok(g.commits[0].refs.some((r) => r.isHead), JSON.stringify(g.commits[0].refs));
    assert.ok(g.commits[0].refs.some((r) => r.label === "main"));
    assert.ok(g.commits[1].refs.some((r) => r.label === "feature-x"), JSON.stringify(g.commits[1].refs));
    assert.equal(g.workingTree.total, 2);
    assert.equal(g.dirtyCount, 2);
  });

  it("github remote URL is extracted; unreachable API falls back to local history", async () => {
    const g = await backend.getRemoteGitGraph({
      environmentId: "env-1",
      cwd: "/remote/myrepo",
      gitConfig: '[remote "origin"]\n\turl = git@github.com:octocat-t3hud-nonexistent-xyz123/nope.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n',
      gitHead: "ref: refs/heads/main\n",
      packedRefs: "",
      headLog,
      vcsRefs: null,
      vcsStatus: null,
      branchCommits: null,
    });
    assert.equal(g.ok, true, JSON.stringify(g));
    assert.equal(g.isRemoteGit, true);
    assert.equal(g.githubRepo, "octocat-t3hud-nonexistent-xyz123/nope");
    assert.ok(g.commits.length >= 2, JSON.stringify(g.commits));
  });

  it("getRemoteCommitDetail returns metadata summary for unpushed local commits", async () => {
    const d = await backend.getRemoteCommitDetail({
      githubRepo: null,
      hash: SHA2,
      cwd: "/remote/myrepo",
      environmentId: "env-1",
      commitMeta: { author: "Jane Doe", subject: "Second commit", relTime: "1 hour ago" },
    });
    assert.equal(d.ok, true, JSON.stringify(d));
    assert.equal(d.hash, SHA2);
    assert.equal(d.authorName, "Jane Doe");
    assert.equal(d.message, "Second commit");
    assert.deepEqual(d.files, []);
    assert.equal(d.patch, "");
    assert.equal((await backend.getRemoteCommitDetail({ hash: "not-a-sha" })).ok, false);
  });

  it("renderer hot reload installs the WebSocket bridge; main-hook and preload keep RPC wired", () => {
    const pl = fs.readFileSync(path.join(REPO, "src", "preload-bridge.cjs"), "utf8");
    assert.match(pl, /getRemoteGitGraph: \(bundle\) => ipcRenderer\.invoke\("t3hud:get-remote-git-graph", bundle\)/);
    assert.match(pl, /getRemoteCommitDetail: \(req\) => ipcRenderer\.invoke\("t3hud:get-remote-commit-detail", req\)/);
    const mh = fs.readFileSync(path.join(REPO, "src", "main-hook.cjs"), "utf8");
    assert.match(mh, /t3hud:get-remote-git-graph/);
    assert.match(mh, /t3hud:get-remote-commit-detail/);
    assert.match(mh, /getRemoteGitGraph/);
    assert.match(mh, /getRemoteCommitDetail/);
    const ui = fs.readFileSync(path.join(REPO, "src", "renderer-ui.js"), "utf8");
    assert.match(ui, /T3HudTrackedWebSocket/);
    assert.match(ui, /server\.getConfig/);
    assert.match(ui, /NativeWS\.prototype\.send =/);
    assert.match(ui, /function fetchRemoteGitBundle\(/);
    assert.match(ui, /projects\.readFile/);
    assert.match(ui, /__t3HudRemoteRpc/);
    assert.match(ui, /isRemoteGit/);
    assert.match(ui, /callBackend\("getRemoteGitGraph", bundle\)/);
    assert.match(ui, /callBackend\("getRemoteCommitDetail", \{/);
  });
});

describe("PR Review Round 2 regressions", () => {
  it("getRemoteCommitDetail flags diffUnavailable: true on unpushed local commits", async () => {
    const d = await backend.getRemoteCommitDetail({
      githubRepo: null,
      hash: "abcdef1234567",
      commitMeta: { author: "Alice", subject: "wip local", relTime: "1m ago" }
    });
    assert.equal(d.ok, true);
    assert.equal(d.diffUnavailable, true);
    assert.equal(d.message, "wip local");
  });

  it("Antigravity live running turn preserves legitimate growing contextUsed (>1.6x previous turn)", () => {
    const r = backend.priceRemoteProjection({
      threadId: "t-grow",
      provider: "antigravity",
      model: "gemini-4-hydrogen",
      isRunning: true,
      contextUsage: { usedTokens: 98000, maxTokens: 1048576 },
      toolIntervals: [],
      turns: [
        { driver: "antigravity", status: "completed", startedMs: 1000, completedMs: 3000, usage: { inputTokens: 39200, cachedInputTokens: 19200, cacheCreationTokens: 0, outputTokens: 200, reasoningTokens: 0, models: ["gemini-4-hydrogen"] } }
      ]
    });
    // Turn 1 true input = 20000, cacheRate = 19200/20000 = 0.96; Turn 2 running raw 98000 / 1.96 = 50000 (> 20200 * 1.6, NOT clamped!)
    assert.equal(r.tokens.contextUsed, 50000);
  });

  it("renderer source guards stale gitGraphReqSeq, running zero-turn threads, and untagged turnItems", () => {
    const s = fs.readFileSync(path.join(REPO, "src", "renderer-ui.js"), "utf8");
    assert.match(s, /let gitGraphReqSeq = 0;/);
    assert.match(s, /reqSeq !== gitGraphReqSeq/);
    assert.match(s, /!proj\.isRunning && !\(proj\.contextUsage\?\.usedTokens > 0\)/);
    assert.match(s, /if \(itTurnId == null \|\| String\(itTurnId\) !== turnId\) continue;/);
    assert.match(s, /res\.diffUnavailable/);
  });
});

describe("PR Review Round 3 regression: turnItems with threadId", () => {
  it("buildProjectionPayload handles turnItems carrying threadId without ReferenceError and filters cross-thread items", () => {
    const src = fs.readFileSync(path.join(REPO, "src", "renderer-ui.js"), "utf8");
    const m1 = src.match(/function toEpochMs\(v\) \{[\s\S]*?\n  \}/);
    const m2 = src.match(/function extractLastThreadIdFromHint\(rawHint\) \{[\s\S]*?\n  \}/);
    const m3 = src.match(/function buildProjectionPayload\(p, stEnvId, uhProps\) \{[\s\S]*?\n  \}/);
    const m4 = src.match(/function readFiberThreadProjection\(expectedThreadId\) \{[\s\S]*?\n  \}/);
    assert.ok(m1 && m2 && m3 && m4);
    const proj = {
      thread: { id: "thread:delegated-task:command%3Amcp%3Aabc", title: "Sub", providerInstanceId: "antigravity" },
      turnItems: [
        { threadId: "other-thread", providerTurnId: "turn-1", type: "assistant_message", startedAt: 1000, completedAt: 9000, text: "wrong thread" },
        { threadId: "thread:delegated-task:command%3Amcp%3Aabc", providerTurnId: "turn-1", type: "assistant_message", startedAt: 2000, completedAt: 4000, text: "right thread streaming output text here" }
      ],
      providerTurns: [{ id: "turn-1", status: "completed", startedAt: 1000, completedAt: 5000, turnTokenUsage: { inputTokens: 1000, outputTokens: 200, reasoningTokens: 0 } }]
    };
    const fakeDoc = { getElementById: () => ({ __reactContainer$1: { memoizedState: { memoizedState: { environmentId: "env-r", projection: proj }, next: null } } }) };
    const runner = new Function("document", `${m1[0]}; ${m2[0]}; ${m3[0]}; return (${m4[0]});`)(fakeDoc);
    const got = runner("/env-r/thread%3Adelegated-task%3Acommand%253Amcp%253Aabc");
    assert.ok(got && got.turns.length === 1);
    assert.equal(got.turns[0].streamDecode.streamSec, 2);
    assert.equal(got.turns[0].streamDecode.visFraction, 1);
  });
});

describe("remote RPC existing connection", () => {
  it("discovers a pre-existing socket and correlates replies to the originating socket", async () => {
    const vm = require("node:vm");
    const listeners = new Map();
    class WS {
      constructor(url) { this.url = url; this.readyState = 1; this.sent = []; listeners.set(this, {}); }
      addEventListener(type, fn) { (listeners.get(this)[type] ||= []).push(fn); }
      send(data) { this.sent.push(data); return "original-result"; }
      receive(value) { for (const fn of listeners.get(this).message || []) fn({data: JSON.stringify(value)}); }
    }
    const existing = new WS("wss://remote");
    const other = new WS("wss://other");
    const code = fs.readFileSync(path.join(REPO, "src/renderer-ui.js"), "utf8");
    const win = {WebSocket: WS};
    vm.runInNewContext(code, {window: win, document: { getElementById: () => null }, setTimeout, clearTimeout, Promise, Set, Map, ArrayBuffer, TextDecoder});
    assert.equal(existing.send("heartbeat"), "original-result");
    other.send("heartbeat");
    const env = "394c13c6-05ea-4538-8e6d-7fafe1a362d5";
    const result = win.__t3HudRemoteRpc(env, "test.read", {}, 200);
    const a = JSON.parse(existing.sent.at(-1));
    const b = JSON.parse(other.sent.at(-1));
    assert.equal(a.tag, "server.getConfig");
    existing.receive({_tag:"Exit", requestId:a.id, exit:{_tag:"Success", value:{environment:{environmentId:env, serverVersion:"1"}}}});
    other.receive({_tag:"Exit", requestId:b.id, exit:{_tag:"Success", value:{environment:{environmentId:"11111111-1111-1111-1111-111111111111", serverVersion:"1"}}}});
    await new Promise(resolve => setImmediate(resolve));
    const req = JSON.parse(existing.sent.at(-1));
    assert.equal(req.tag, "test.read");
    other.receive({_tag:"Exit", requestId:req.id, exit:{_tag:"Success", value:"wrong"}});
    existing.receive({_tag:"Exit", requestId:req.id, exit:{_tag:"Success", value:"right"}});
    assert.equal((await result).value, "right");
    assert.equal(listeners.get(existing).message.length, 1);
  });
});

describe("remote graph native review", () => {
  it("returns partial native range when the remote has no upstream", async () => {
    const vm = require("node:vm");
    const src = fs.readFileSync(path.join(REPO, "src/renderer-ui.js"), "utf8");
    const start = src.indexOf("  async function fetchRemoteGitBundle(");
    const end = src.indexOf("\n  async function openCommitDetail", start);
    const calls = [];
    const a = "a".repeat(40), b = "b".repeat(40);
    const ctx = { window: { __t3HudRemoteRpc: async (_env, tag, payload) => {
      calls.push({tag, payload});
      if (tag === "review.getBranchCommits" && payload.baseRef === "HEAD~1") return {ok:true,value:{commits:[{sha:b,subject:"second",committedAt:"2026-01-01T00:00:00Z"}],truncated:false}};
      return {ok:false};
    } }, callBackend: async (_method, bundle) => backend.getRemoteGitGraph(bundle) };
    vm.createContext(ctx); vm.runInContext(src.slice(start, end) + "\nthis.fetchBundle = fetchRemoteGitBundle;", ctx);
    const g = await ctx.fetchBundle("env", "/remote/repo", "main");
    assert.equal(g.ok, true);
    assert.deepEqual(Array.from(g.commits, c => c.hash), [b]);
    assert.equal(g.partialHistory, true);
    assert.ok(calls.some(c => c.tag === "review.getBranchCommits" && c.payload.baseRef === "HEAD~1"));
  });
});
