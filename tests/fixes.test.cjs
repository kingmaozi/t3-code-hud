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
