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
const home = fs.mkdtempSync(path.join(os.tmpdir(), "hud-active-turn-"));
for (const d of [path.join(home, "userdata"), path.join(home, "muse"), path.join(home, "codex")]) fs.mkdirSync(d, { recursive: true });
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

function stripTokenStr(str) {
  // helper for estimate mock: char-based tokens
  if (!str) return 0;
  let cjk = 0; const len = str.length;
  for (let i = 0; i < len; i++) if (str.charCodeAt(i) > 0x2e80) cjk++;
  return cjk * 0.72 + (len - cjk) * 0.27;
}

// 1. Normal streaming turn: DOM increment real-time estimated
test("P1: streaming turn shows estimated live speed from DOM growth", () => {
  const state = createState("thread-stream");
  const running = { ok: true, threadId: "thread-stream", isRunning: true, stepCount: 3, speed: { lastDecodeTps: null, currentTurnEstimateTps: null } };
  // No live rate yet => waiting
  assert.equal(resolveSpeed(state, running, null, "thread-stream").kind, "waiting");
  // With live rate => estimated with approx
  const view = resolveSpeed(state, running, 63.5, "thread-stream");
  assert.equal(view.kind, "estimated");
  assert.equal(view.value, 63.5);
  assert.equal(formatSpeed(view, { approx: "≈", turn: "本轮", waiting: "生成中..." }), "≈63.5 tok/s");
});

// 2. Tool gap with currentTurnEstimateTps keeps estimated
test("P1: tool-gap keeps estimated via currentTurnEstimateTps when DOM stalls", () => {
  const state = createState("thread-tool-gap");
  const runningWithEstimate = {
    ok: true,
    threadId: "thread-tool-gap",
    isRunning: true,
    stepCount: 5,
    speed: { lastDecodeTps: null, currentTurnEstimateTps: 42.5, tokPerSec: 75, byModel: { "m": 75 } },
  };
  // live null but estimate present => estimated, not waiting, not lastDecode, not average
  const view = resolveSpeed(state, runningWithEstimate, null, "thread-tool-gap");
  assert.equal(view.kind, "estimated", "backend current-turn estimate should be used in tool gap");
  assert.equal(view.value, 42.5);
  assert.equal(formatSpeed(view, { approx: "≈", turn: "本轮", waiting: "生成中..." }), "≈42.5 tok/s");
  // Must NOT use lastDecodeTps (null) nor tokPerSec (75)
  assert.notEqual(view.value, 75);
  // live takes precedence over estimate
  const viewLive = resolveSpeed(state, runningWithEstimate, 88.8, "thread-tool-gap");
  assert.equal(viewLive.kind, "estimated");
  assert.equal(viewLive.value, 88.8, "live DOM wins over backend estimate");
});

// 3. First token no data shows waiting
test("P1: running turn with no live and no estimate shows waiting, never falls back to averages", () => {
  const state = createState("thread-first-token");
  const runningNoData = {
    ok: true,
    threadId: "thread-first-token",
    isRunning: true,
    stepCount: 2,
    speed: { lastDecodeTps: 100, tokPerSec: 75, byModel: { "m": 75 }, currentTurnEstimateTps: null },
  };
  // lastDecodeTps and tokPerSec exist but must be ignored during running
  const view = resolveSpeed(state, runningNoData, null, "thread-first-token");
  assert.equal(view.kind, "waiting", "running without live/estimate must wait, not inherit completed or average");
});

// 4. advanceHudStreamSampler sensitivity: dt 0.22 and dTok 1.8 should produce estimate (new sensitivity)
test("P1: sampler sensitivity allows early growth dt>=0.22 dTok>=1.8", () => {
  const sampler = createHudStreamSampler();
  const snap1 = { messageId: "a1", text: "a".repeat(40) };
  const snap2 = { messageId: "a1", text: "a".repeat(48) }; // +8 chars ~2.16 tokens
  // seeded baseline
  advanceHudStreamSampler(sampler, snap1, 1000, true, estimateRenderedTokens);
  // 220ms later, growth ~2 tokens
  const res = advanceHudStreamSampler(sampler, snap2, 1220, true, estimateRenderedTokens);
  assert.ok(res.liveTps != null && res.liveTps > 0, `expected liveTps from sensitive threshold, got ${res.liveTps} (old threshold required 3 tokens)`);
  // anti-noise floor: tiny growth 1 token over 100ms should NOT produce
  const sampler2 = createHudStreamSampler();
  const sA = { messageId: "a2", text: "x".repeat(40) };
  const sB = { messageId: "a2", text: "x".repeat(43) }; // ~0.8 tokens
  advanceHudStreamSampler(sampler2, sA, 2000, true, estimateRenderedTokens);
  const res2 = advanceHudStreamSampler(sampler2, sB, 2100, true, estimateRenderedTokens);
  assert.equal(res2.liveTps, null, "sub-threshold noise should not produce rate");
});

// 5. getAssistantStreamSnapshot captures visible thinking/streaming text and excludes old expansion
test("P1: snapshot returns visible assistant text, not hidden or old user", () => {
  // Old assistant expansion when latest is user => null
  const oldAssistant = { dataset: { messageRole: "assistant", messageId: "old-1" }, innerText: "old output".repeat(5), getAttribute(n){ return n==="data-message-id" ? this.dataset.messageId : null; } };
  const latestUser = { dataset: { messageRole: "user", messageId: "u-2" }, innerText: "prompt".repeat(5), getAttribute(n){ return n==="data-message-id" ? this.dataset.messageId : null; } };
  const chatCol = {
    nodes: [oldAssistant, latestUser],
    querySelectorAll(sel){
      if (sel.includes("data-message-role") && sel.includes("data-message-id")) return this.nodes.filter(n=>n.dataset.messageId);
      if (sel.includes('data-message-role="assistant"')) return this.nodes.filter(n=>n.dataset.messageRole==="assistant");
      if (sel.includes("data-message-role")) return this.nodes;
      return [];
    }
  };
  assert.equal(getAssistantStreamSnapshot(chatCol), null, "latest user means new turn not started");
  // New assistant appears with streaming text including thinking sub-node visible
  const newAssistant = { dataset: { messageRole: "assistant", messageId: "a-new" }, innerText: "streaming output".repeat(3), getAttribute(n){ return n==="data-message-id" ? this.dataset.messageId : "assistant"; } , // role via dataset
    textContent: "streaming output".repeat(3) };
  newAssistant.getAttribute = function(name){ if(name==="data-message-role") return "assistant"; if(name==="data-message-id") return "a-new"; return null; };
  chatCol.nodes.push(newAssistant);
  const snap = getAssistantStreamSnapshot(chatCol);
  assert.ok(snap, "new assistant snapshot should exist");
  assert.equal(snap.messageId, "a-new");
  assert.ok(snap.text.length > 0, "visible text increment should be captured");
});

// 6. canSample requires isRunning true, never uses old message as generation
test("P1: canSample requires authoritative running, idle growth ignored", () => {
  const chatCol = {
    nodes: [{ dataset: { messageRole: "assistant", messageId: "a1" }, innerText: "hello".repeat(10), getAttribute(n){ return n==="data-message-role" ? "assistant" : n==="data-message-id" ? "a1" : null; } }],
    querySelectorAll(sel){ if(sel.includes('data-message-role="assistant"')) return this.nodes; if(sel.includes("data-message-role")) return this.nodes; return []; }
  };
  const snap = getAssistantStreamSnapshot(chatCol);
  assert.equal(canSampleHudStream({ ok:true, isRunning:false }, snap), false);
  assert.equal(canSampleHudStream({ ok:true, isRunning:true }, snap), true);
  assert.equal(canSampleHudStream({ ok:true, isRunning:true }, null), false);
});

// 7. renderTopbarStats must not clear采样 on started when live already valid; source check
test("P1: topbar renderer preserves live sample on started tick", () => {
  const topbar = rendererSource.match(/  function renderTopbarStats\([\s\S]*?\n  \}/)?.[0] || "";
  assert.ok(topbar, "renderTopbarStats missing");
  // New invariant: only reset when sampler not sampling current message; allow liveRate through
  // Old unconditional reset would be: if (speedView.started && stats?.isRunning) resetLiveStreamSampler
  // Must contain guard that checks liveStreamTps or sampler message
  assert.match(topbar, /liveStreamTps/, "renderTopbarStats must consider liveStreamTps before clearing");
  assert.doesNotMatch(topbar, /if \(speedView\.routeChanged \|\| \(speedView\.started && stats\?\.isRunning\)\) \{\s*resetLiveStreamSampler/, "unconditional clear on started is forbidden after fix");
  assert.match(topbar, /resolveHudTurnSpeed\(/, "topbar must use resolveHudTurnSpeed");
  assert.match(topbar, /resolveHudSessionSpeed\(/, "topbar keeps an actual same-chat session speed");
  assert.doesNotMatch(topbar, /t\("waitingForOutput"\)/, "the displayed speed is never replaced by waiting text");
  assert.match(topbar, /resolveHudCacheDisplay\(stats\)/, "topbar cache uses the validated turn-first resolver");
  assert.doesNotMatch(topbar, /stats\.cache\.displayRate/, "topbar never falls back to displayRate");
});

// 8. streamWatchTimer triggers throttled refresh on new assistant while isRunning false
test("P1: streamWatchTimer fast-path refreshes when new assistant appears before backend flips", () => {
  const watcher = rendererSource.match(/const streamWatchTimer[\s\S]*?refreshStats\(false\)/)?.[0] || "";
  assert.ok(watcher, "streamWatchTimer block not found");
  // Must detect new message id or growth while isRunning false and refresh
  assert.match(rendererSource, /assistantSnapshot\.messageId/, "must compare messageId to detect new turn");
  assert.match(rendererSource, /latestStats.*isRunning/, "must check isRunning false case");
  assert.match(rendererSource, /refreshStats\(false\)/, "must trigger throttled refresh");
  // Must keep canSample gate
  assert.match(rendererSource, /canSampleHudStream\(latestStats, assistantSnapshot\)/, "live estimation still requires authoritative running");
});

// 9. Missing current-turn cache shows an explicitly labelled session rate when available.
test("P1: cache display labels turn vs session values and never says pending", () => {
  assert.match(rendererSource, /function resolveHudCacheDisplay\(/, "cache display resolver missing");
  assert.match(rendererSource, /cacheSessionShort:\s*"累计缓存"/, "zh cumulative label missing");
  assert.match(rendererSource, /cacheSessionShort:\s*"Session cache"/, "en cumulative label missing");
  assert.match(rendererSource, /cacheUnknownTitle:\s*"暂无缓存数据"/, "zh unknown label missing");
  assert.match(rendererSource, /cacheUnknownTitle:\s*"No cache data"/, "en unknown label missing");
  assert.doesNotMatch(rendererSource, /cachePending|待上报/, "cache must not show a pending-report label");
  const topbar = rendererSource.match(/  function renderTopbarStats\([\s\S]*?\n  \}/)?.[0] || "";
  assert.match(topbar, /resolveHudCacheDisplay\(stats\)/, "topbar must use the validated cache display");
  assert.match(topbar, /cacheLblEl\.textContent\s*=\s*nextCacheLabel/, "topbar label must identify cumulative fallback");
  const popover = rendererSource.match(/  function renderStatsPopover\([\s\S]*?\n  \}/)?.[0] || "";
  assert.match(popover, /turnCacheUnavailableNote/, "popover must explain current-turn unknown");
  assert.match(popover, /turnCacheRate/, "popover retains turnCacheRate row");
  assert.match(rendererSource, /typeof rate === "number" && Number\.isFinite\(rate\) && rate >= 0 && rate <= 1/, "cache rates must reject nonnumeric, nonfinite, or out-of-range values");
});

// 10. Backend: running with no usage returns null, with usage returns rate immediately
test("P1: backend cache returns null for running without usage, rate once reported even while running", () => {
  const dbPath = path.join(process.env.T3CODE_HOME, "statev2.sqlite");
  for (const suffix of ["", "-wal", "-shm"]) try { fs.rmSync(`${dbPath}${suffix}`, { force:true }); } catch{}
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, project_id TEXT, title TEXT, default_provider TEXT, updated_at TEXT, payload_json TEXT, archived_at TEXT, deleted_at TEXT);
    CREATE TABLE projection_projects (project_id TEXT, title TEXT, workspace_root TEXT);
    CREATE TABLE orchestration_v2_projection_provider_sessions (provider_session_id TEXT, thread_id TEXT, provider TEXT, status TEXT, model TEXT, updated_at TEXT, payload_json TEXT, driver TEXT);
    CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT, thread_id TEXT, driver TEXT, updated_at TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_provider_turns (provider_turn_id TEXT, thread_id TEXT, ordinal INTEGER, status TEXT, started_at TEXT, completed_at TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_turn_items (thread_id TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_subagents (subagent_id TEXT, thread_id TEXT, driver TEXT, child_thread_id TEXT);
  `);
  db.prepare("INSERT INTO projection_projects VALUES (?,?,?)").run("p1","proj",home);
  const threadId = "thread:cache-pending";
  const isoNow = new Date().toISOString();
  db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?,?,?,?,?,?)").run(threadId,"p1",threadId,"codex",isoNow,JSON.stringify({modelSelection:{model:"codex-fixture",provider:"codex"}}),null,null);
  db.prepare("INSERT INTO orchestration_v2_projection_provider_sessions VALUES (?,?,?,?,?,?,?,?)").run(`${threadId}-sess`,threadId,"codex","running","codex-fixture",isoNow,"{}","codex");
  db.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?,?,?,?,?)").run(`${threadId}-pt`,threadId,"codex",isoNow,JSON.stringify({}));
  // prior completed turn with high cache (should not leak)
  db.prepare("INSERT INTO orchestration_v2_projection_provider_turns VALUES (?,?,?,?,?,?,?)").run(`${threadId}-t1`,threadId,1,"completed","2026-11-16T10:00:00.000Z","2026-11-16T10:00:05.000Z",JSON.stringify({nativeTurnRef:{driver:"codex",nativeId:"n1"},turnTokenUsage:{inputTokens:1000,cachedInputTokens:900,outputTokens:100}}));
  // current running turn without usage
  db.prepare("INSERT INTO orchestration_v2_projection_provider_turns VALUES (?,?,?,?,?,?,?)").run(`${threadId}-t2`,threadId,2,"running","2026-11-16T11:00:00.000Z",null,JSON.stringify({nativeTurnRef:{driver:"codex",nativeId:"n2"}}));
  db.close();
  const runningNoUsage = backend.getThreadStats(threadId);
  assert.equal(runningNoUsage.ok, true, JSON.stringify(runningNoUsage.error||""));
  assert.equal(runningNoUsage.isRunning, true);
  assert.equal(runningNoUsage.cache.turnRate, null, "running without turnTokenUsage must not inherit prior 90%");
  assert.equal(runningNoUsage.cache.lastCallRate, null, "no lastCall fallback for running unmetered");
  // Now add usage to running turn (upstream finally reports even while still running)
  const db2 = new DatabaseSync(dbPath);
  db2.prepare("UPDATE orchestration_v2_projection_provider_turns SET payload_json=? WHERE provider_turn_id=?").run(JSON.stringify({nativeTurnRef:{driver:"codex",nativeId:"n2"},turnTokenUsage:{inputTokens:1000,cachedInputTokens:880,outputTokens:0}}),`${threadId}-t2`);
  db2.close();
  // need fresh read; clear file caches? backend caches via fileParseCache but statev2 is DB read each time, so should be fresh
  const runningWithUsage = backend.getThreadStats(threadId);
  assert.equal(runningWithUsage.cache.turnRate, 0.88, "once turnTokenUsage arrives, even while running, immediate rate");
});

// 11. Backend ordinal reset + provider switch never leak
test("P1: ordinal reset and provider switch never inherit prior cache/speed", () => {
  const dbPath = path.join(process.env.T3CODE_HOME, "statev2.sqlite");
  // reuse existing DB (thread cache-pending exists) add more threads
  const db = new DatabaseSync(dbPath);
  const insert = (threadId, provider, rows) => {
    const iso = "2026-11-16T12:00:00.000Z";
    db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?,?,?,?,?,?)").run(threadId,"p1",threadId,provider,iso,JSON.stringify({modelSelection:{model:"m",provider}}),null,null);
    db.prepare("INSERT INTO orchestration_v2_projection_provider_sessions VALUES (?,?,?,?,?,?,?,?)").run(`${threadId}-sess`,threadId,provider,"completed","m",iso,"{}",provider);
    db.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?,?,?,?,?)").run(`${threadId}-pt`,threadId,provider,iso,JSON.stringify({}));
    const stmt = db.prepare("INSERT INTO orchestration_v2_projection_provider_turns VALUES (?,?,?,?,?,?,?)");
    rows.forEach((r,i)=> stmt.run(`${threadId}-t${i+1}`,threadId,r.ordinal??i+1,r.status,r.startedAt||null,r.completedAt||null,JSON.stringify({nativeTurnRef:{driver:r.driver||provider,nativeId:`n-${i}`},...(r.usage?{turnTokenUsage:r.usage}:{})})));
  };
  // ordinal 264 older completed high cache, ordinal 13 newer running no usage => must be null
  insert("thread:ordinal-reset","codex",[
    { ordinal:264, status:"completed", driver:"codex", startedAt:"2026-11-15T18:27:53.000Z", completedAt:"2026-11-15T18:28:03.000Z", usage:{inputTokens:1000,cachedInputTokens:900,outputTokens:100}},
    { ordinal:13, status:"running", driver:"codex", startedAt:"2026-11-16T15:17:03.000Z" }
  ]);
  // provider switch: older muse high cache, newer claudeAgent no usage => null cache, null speed
  insert("thread:provider-switch","claudeAgent",[
    { ordinal:1, status:"completed", driver:"muse", startedAt:"2026-11-15T18:00:00.000Z", completedAt:"2026-11-15T18:00:05.000Z", usage:{inputTokens:1000,cachedInputTokens:900,outputTokens:100}},
    { ordinal:2, status:"completed", driver:"claudeAgent", startedAt:"2026-11-16T15:17:03.000Z", completedAt:"2026-11-16T15:17:08.000Z" }
  ]);
  db.close();
  const ordinal = backend.getThreadStats("thread:ordinal-reset");
  assert.equal(ordinal.cache.turnRate, null, "new running ordinal 13 outranks old 264");
  const switchT = backend.getThreadStats("thread:provider-switch");
  assert.equal(switchT.cache.turnRate, null, "new provider turn without usage cannot inherit old provider cache");
  assert.equal(switchT.speed.lastDecodeTps, null, "new provider without sample cannot inherit old speed");
  assert.notEqual(switchT.provider, "muse", "provider should be latest");
});

// 12. Backend currentTurnEstimateTps: strictly attributed estimate, not polluting lastDecode
test("P1: backend exposes currentTurnEstimateTps only for strictly attributed current-turn sample", () => {
  const dbPath = path.join(process.env.T3CODE_HOME, "statev2.sqlite");
  const db = new DatabaseSync(dbPath);
  const threadId = "thread:estimate-active";
  const iso = "2026-11-16T13:00:00.000Z";
  db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?,?,?,?,?,?)").run(threadId,"p1",threadId,"codex",iso,JSON.stringify({modelSelection:{model:"codex-fixture",provider:"codex"}}),null,null);
  db.prepare("INSERT INTO orchestration_v2_projection_provider_sessions VALUES (?,?,?,?,?,?,?,?)").run(`${threadId}-sess`,threadId,"codex","running","codex-fixture",iso,"{}","codex");
  db.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?,?,?,?,?)").run(`${threadId}-pt`,threadId,"codex",iso,JSON.stringify({}));
  // latest running turn started 13:00
  db.prepare("INSERT INTO orchestration_v2_projection_provider_turns VALUES (?,?,?,?,?,?,?)").run(`${threadId}-t1`,threadId,1,"running","2026-11-16T13:00:00.000Z",null,JSON.stringify({nativeTurnRef:{driver:"codex",nativeId:"n1"}}));
  // turn_items: one assistant_message belonging to current turn (>=13:00) with output 100 tokens over 2s => 50 tps
  // payload includes outputTokens explicitly for estimate path (spec requires positive output + valid duration)
  db.prepare("INSERT INTO orchestration_v2_projection_turn_items VALUES (?,?)").run(threadId, JSON.stringify({type:"assistant_message", providerTurnId:`${threadId}-t1`, driver:"codex", startedAt:"2026-11-16T13:00:01.000Z", completedAt:"2026-11-16T13:00:03.000Z", outputTokens:100}));
  // tool interval overlapping 13:00:01-13:00:02 (should be subtracted? but our simple estimate uses net duration)
  db.prepare("INSERT INTO orchestration_v2_projection_turn_items VALUES (?,?)").run(threadId, JSON.stringify({type:"tool_call", providerTurnId:`${threadId}-t1`, driver:"codex", startedAt:"2026-11-16T13:00:01.000Z", completedAt:"2026-11-16T13:00:02.000Z"}));
  // prior turn item before current stamp should be ignored (old sample)
  db.prepare("INSERT INTO orchestration_v2_projection_turn_items VALUES (?,?)").run(threadId, JSON.stringify({type:"assistant_message", providerTurnId:`${threadId}-t0`, driver:"codex", startedAt:"2026-11-16T12:59:00.000Z", completedAt:"2026-11-16T12:59:01.000Z", outputTokens:9999}));
  db.close();
  const stats = backend.getThreadStats(threadId);
  assert.equal(stats.ok, true);
  assert.equal(stats.isRunning, true);
  // currentTurnEstimateTps should be present and finite positive, not polluted lastDecode
  assert.ok(stats.speed.currentTurnEstimateTps != null, `currentTurnEstimateTps missing, got ${JSON.stringify(stats.speed)}`);
  assert.ok(Number.isFinite(stats.speed.currentTurnEstimateTps) && stats.speed.currentTurnEstimateTps > 0, "estimate must be positive finite");
  // Must NOT be the old 9999/1s sample nor the prior turn's lastDecode
  assert.ok(stats.speed.currentTurnEstimateTps < 1000, "must not inherit old 9999 tok sample");
  // lastDecodeTps for running uncompleted turn must stay null (not polluted)
  assert.equal(stats.speed.lastDecodeTps, null, "running estimate must not pollute lastDecodeTps");
  // zero output leg fails
  const db2 = new DatabaseSync(dbPath);
  // create another thread with only zero-output item for current turn => estimate null
  const threadZero = "thread:estimate-zero";
  const iso2 = "2026-11-16T14:00:00.000Z";
  db2.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?,?,?,?,?,?)").run(threadZero,"p1",threadZero,"codex",iso2,JSON.stringify({modelSelection:{model:"codex-fixture",provider:"codex"}}),null,null);
  db2.prepare("INSERT INTO orchestration_v2_projection_provider_sessions VALUES (?,?,?,?,?,?,?,?)").run(`${threadZero}-sess`,threadZero,"codex","running","codex-fixture",iso2,"{}","codex");
  db2.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?,?,?,?,?)").run(`${threadZero}-pt`,threadZero,"codex",iso2,JSON.stringify({}));
  db2.prepare("INSERT INTO orchestration_v2_projection_provider_turns VALUES (?,?,?,?,?,?,?)").run(`${threadZero}-t1`,threadZero,1,"running","2026-11-16T14:00:00.000Z",null,JSON.stringify({nativeTurnRef:{driver:"codex",nativeId:"n1"}}));
  db2.prepare("INSERT INTO orchestration_v2_projection_turn_items VALUES (?,?)").run(threadZero, JSON.stringify({type:"assistant_message", providerTurnId:`${threadZero}-t1`, driver:"codex", startedAt:"2026-11-16T14:00:01.000Z", completedAt:"2026-11-16T14:00:02.000Z", outputTokens:0}));
  db2.close();
  const zero = backend.getThreadStats(threadZero);
  assert.equal(zero.speed.currentTurnEstimateTps, null, "zero-output current item must not produce estimate");
});

// 13. Completed zero-output never inherits previous (frontend + backend)
test("P1: completed zero-output and zero-duration never inherit prior speed/cache", () => {
  const state = createState("thread-zero2");
  const idle1 = { ok:true, threadId:"thread-zero2", isRunning:false, stepCount:2, speed:{lastDecodeTps:40, currentTurnEstimateTps:null} };
  assert.equal(resolveSpeed(state, idle1, null, "thread-zero2").value, 40);
  const nextRunning = { ...idle1, isRunning:true };
  assert.equal(resolveSpeed(state, nextRunning, null, "thread-zero2").kind, "waiting");
  const zeroCompleted = { ok:true, threadId:"thread-zero2", isRunning:false, stepCount:3, speed:{lastDecodeTps:null, currentTurnEstimateTps:null} };
  assert.equal(resolveSpeed(state, zeroCompleted, null, "thread-zero2").kind, "none");
  // stale completion with same stepCount hides prior (fresh state to avoid polluted baseline)
  const stateStale = createState("thread-stale2");
  const idleStale = { ok:true, threadId:"thread-stale2", isRunning:false, stepCount:2, speed:{lastDecodeTps:40} };
  assert.equal(resolveSpeed(stateStale, idleStale, null, "thread-stale2").value, 40);
  const staleRunning = { ...idleStale, isRunning:true };
  assert.equal(resolveSpeed(stateStale, staleRunning, null, "thread-stale2").kind, "waiting");
  const stale = { ok:true, threadId:"thread-stale2", isRunning:false, stepCount:2, speed:{lastDecodeTps:40} };
  assert.equal(resolveSpeed(stateStale, stale, null, "thread-stale2").kind, "none");
  // backend via priceRemoteProjection zero output
  const remote = backend.priceRemoteProjection({
    threadId:"r-zero", provider:"codex", model:"m", isRunning:false,
    turns:[{status:"completed", driver:"codex", startedMs:1000, completedMs:10000, usage:{inputTokens:1000,cachedInputTokens:200,outputTokens:100,reasoningTokens:0}, streamDecode:{streamSec:2,visFraction:1}}],
  });
  assert.equal(remote.speed.lastDecodeTps, 50);
  const zeroRemote = backend.priceRemoteProjection({
    threadId:"r-zero", provider:"codex", model:"m", isRunning:false,
    turns:[{status:"completed", driver:"codex", startedMs:1000, completedMs:10000, usage:{inputTokens:0,outputTokens:0,reasoningTokens:0}}],
  });
  assert.equal(zeroRemote.speed.lastDecodeTps, null, "zero output completed cannot inherit");
  assert.equal(zeroRemote.cache.turnRate, null);
});

// 14. Route switch and late stats snapshot
test("P1: route switch and late stats never leak prior session speed/cache", () => {
  const state = createState("thread-a");
  const idleA = { ok:true, threadId:"thread-a", isRunning:false, stepCount:2, speed:{lastDecodeTps:40, currentTurnEstimateTps:null} };
  assert.equal(resolveSpeed(state, idleA, null, "thread-a").value, 40);
  const routeBlank = { ok:false, nonThreadRoute:"new" };
  assert.equal(resolveSpeed(state, routeBlank, null, "thread-b").kind, "none", "switch clears prior");
  // late stats: isCurrentStatsSnapshot must reject stale requestId or mismatched route
  assert.equal(isCurrentStatsSnapshot(1,2,"thread-a","thread-b"), false);
  assert.equal(isCurrentStatsSnapshot(2,2,"thread-a","thread-b"), false);
  assert.equal(isCurrentStatsSnapshot(2,2,"thread-b","thread-b"), true);
  assert.equal(isCurrentStatsSnapshot(1,2,"thread-b","thread-b"), false, "late packet with old id rejected");
});

// 15. Topbar shows stable session average; details keep turn metrics
test("P1: topbar shows the same-chat session speed and popover retains both details", () => {
  const topbar = rendererSource.match(/  function renderTopbarStats\([\s\S]*?\n  \}/)?.[0] || "";
  const popover = rendererSource.match(/  function renderStatsPopover\([\s\S]*?\n  \}/)?.[0] || "";
  assert.match(topbar, /resolveHudSessionSpeed\(/, "topbar resolves the current chat average");
  assert.match(popover, /avgDecodeSpeed/, "popover keeps session average row");
  assert.match(popover, /lastTurnSpeed/, "popover keeps last-turn row");
  assert.doesNotMatch(topbar, /t\("waitingForOutput"\)/, "the speed slot never becomes waiting text");
});

// 16. i18n and format: estimated shows approx, waiting shows generating
test("P1: estimated vs waiting formatting with approx sign", () => {
  const state = createState("thread-fmt");
  const running = { ok:true, threadId:"thread-fmt", isRunning:true, stepCount:1, speed:{currentTurnEstimateTps:55.5, lastDecodeTps:null} };
  const est = resolveSpeed(state, running, null, "thread-fmt");
  assert.equal(formatSpeed(est, { approx:"≈", turn:"本轮", waiting:"生成中..." }), "≈55.5 tok/s");
  const state2 = createState("thread-fmt2");
  const running2 = { ok:true, threadId:"thread-fmt2", isRunning:true, stepCount:1, speed:{currentTurnEstimateTps:null, lastDecodeTps:100} };
  const wait = resolveSpeed(state2, running2, null, "thread-fmt2");
  assert.equal(formatSpeed(wait, { approx:"≈", turn:"本轮", waiting:"生成中..." }), "生成中...");
});

// 17. priceRemoteProjection running estimate not leaking provider
test("P1: priceRemoteProjection strictly scopes currentTurnEstimateTps", () => {
  // remote running with no current sample => no estimate, even if prior turn had high speed
  const payload = {
    threadId:"remote-est", provider:"codex", model:"m", isRunning:true,
    toolIntervals:[[2000,3000]],
    turns:[
      { status:"completed", driver:"codex", startedMs:1000, completedMs:5000, usage:{inputTokens:1000,cachedInputTokens:200,outputTokens:100,reasoningTokens:0}, streamDecode:{streamSec:2,visFraction:1} },
      // current running turn with no usage yet (no estimate source)
      { status:"running", driver:"codex", startedMs:6000, completedMs:6000, usage:null },
    ]
  };
  const r = backend.priceRemoteProjection(payload);
  // last completed turn's decode is 50, but current running estimate must be null (not inherit)
  // If backend incorrectly falls back to prior lastDecode as estimate, this would be 50
  assert.ok(r.speed.currentTurnEstimateTps == null, `running without current sample must not inherit prior 50, got ${r.speed.currentTurnEstimateTps}`);
  assert.equal(r.speed.lastDecodeTps, null, "running latest without usage clears lastDecode, not prior");
});

// 18. Backend helpers exist and are strict
test("P1: backend helpers enforce strict attribution", () => {
  const backendSource = fs.readFileSync(path.join(repo,"src/backend.cjs"),"utf8");
  assert.match(backendSource, /function cacheRateForTurnUsage/, "cacheRateForTurnUsage missing");
  assert.match(backendSource, /function latestProviderTurnCacheRate/, "latestProviderTurnCacheRate missing");
  assert.match(backendSource, /turnRows.*length - 1/, "must only look at latest turnRow");
  assert.match(backendSource, /currentTurnEstimateTps/, "currentTurnEstimateTps field missing in backend");
  // ensure no char-count cache estimate
  assert.doesNotMatch(backendSource, /length.*cache|cache.*length/i, "cache must never be estimated from char count");
});

// R1 [P1] New-round first frame must not show stale liveStreamTps from prior turn
test("R1: new-round first frame with stale live sample shows waiting, confirmed new sample shows estimated", () => {
  const state = createState("thread-r1");
  // Record idle baseline: last assistant message from prior turn + step count
  state.baselineMessageId = "old-assistant-msg";
  state.baselineProvider = "codex";
  state.lastIdleStepCount = 2;
  const runningFirst = { ok: true, threadId: "thread-r1", isRunning: true, stepCount: 3, provider: "codex", speed: { lastDecodeTps: null, currentTurnEstimateTps: null } };
  // Bare liveTps without proof of new-turn ownership must be waiting (old 70 tok/s must not leak)
  const bare = resolveSpeed(state, runningFirst, 70, "thread-r1");
  assert.equal(bare.kind, "waiting", `bare stale liveTps on started must wait, got ${bare.kind}`);
  // Empty or equal-to-baseline messageId must also wait
  const state2 = createState("thread-r1b");
  state2.baselineMessageId = "old-msg";
  state2.lastIdleStepCount = 2;
  const w2 = resolveSpeed(state2, { ok: true, threadId: "thread-r1b", isRunning: true, stepCount: 3 }, 70, "thread-r1b", { messageId: "old-msg", liveSampleConfirmedNewTurn: false });
  assert.equal(w2.kind, "waiting");
  // Confirmed new-turn sample (new messageId != baseline, confirmed flag) keeps estimated
  const state3 = createState("thread-r1c");
  state3.baselineMessageId = "old-msg";
  state3.baselineCaptured = true;
  state3.lastIdleStepCount = 2;
  const confirmed = resolveSpeed(state3, { ok: true, threadId: "thread-r1c", isRunning: true, stepCount: 3 }, 70, "thread-r1c", { messageId: "brand-new-msg", liveSampleConfirmedNewTurn: true });
  assert.equal(confirmed.kind, "estimated", "confirmed new-turn live sample must be shown");
  assert.equal(confirmed.value, 70);
  // Source must bind sampler baseline identity and clear stale sampler on first frame
  assert.match(rendererSource, /baselineMessageId/, "createHudTurnSpeedState must track baselineMessageId");
  assert.match(rendererSource, /liveSampleConfirmedNewTurn/, "resolveHudTurnSpeed must require liveSampleConfirmedNewTurn on started");
  const topbar = rendererSource.match(/  function renderTopbarStats\([\s\S]*?\n  \}/)?.[0] || "";
  assert.match(topbar, /baselineMessageId/, "renderTopbarStats must compare sampler messageId against baseline before keeping live rate");
  assert.match(topbar, /liveSampleConfirmedNewTurn/, "renderTopbarStats must pass confirmation flag to resolver");
});

// R2 [P1] Backend estimate must strictly attribute sub-items to current turn (turnId + driver), exclude other-turn/other-provider items
test("R2: computeCurrentTurnEstimateTps excludes other-turn and other-provider sub-items", () => {
  const dbPath = path.join(process.env.T3CODE_HOME, "statev2.sqlite");
  const db = new DatabaseSync(dbPath);
  const threadId = "thread:r2-strict";
  const iso = "2026-11-16T15:00:00.000Z";
  db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?,?,?,?,?,?)").run(threadId, "p1", threadId, "codex", iso, JSON.stringify({ modelSelection: { model: "codex-fixture", provider: "codex" } }), null, null);
  db.prepare("INSERT INTO orchestration_v2_projection_provider_sessions VALUES (?,?,?,?,?,?,?,?)").run(`${threadId}-sess`, threadId, "codex", "running", "codex-fixture", iso, "{}", "codex");
  db.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?,?,?,?,?)").run(`${threadId}-pt`, threadId, "codex", iso, JSON.stringify({}));
  // Current running turn: id thread:r2-strict-t1
  db.prepare("INSERT INTO orchestration_v2_projection_provider_turns VALUES (?,?,?,?,?,?,?)").run(`${threadId}-t1`, threadId, 1, "running", "2026-11-16T15:00:00.000Z", null, JSON.stringify({ nativeTurnRef: { driver: "codex", nativeId: "n1" } }));
  // Other-turn item: same-ms start but belongs to other turnId + other driver, high output
  db.prepare("INSERT INTO orchestration_v2_projection_turn_items VALUES (?,?)").run(threadId, JSON.stringify({ type: "assistant_message", startedAt: "2026-11-16T15:00:01.000Z", completedAt: "2026-11-16T15:00:03.000Z", outputTokens: 200, providerTurnId: "other-turn-id", turnId: "other-turn-id", driver: "muse" }));
  // Other-provider item: turnId matches via providerTurnId but driver mismatches effDriver
  db.prepare("INSERT INTO orchestration_v2_projection_turn_items VALUES (?,?)").run(threadId, JSON.stringify({ type: "assistant_message", startedAt: "2026-11-16T15:00:01.000Z", completedAt: "2026-11-16T15:00:03.000Z", outputTokens: 200, providerTurnId: `${threadId}-t1`, driver: "muse" }));
  // Tool interval from other turn should also be excluded (should not subtract from current)
  db.prepare("INSERT INTO orchestration_v2_projection_turn_items VALUES (?,?)").run(threadId, JSON.stringify({ type: "tool_call", startedAt: "2026-11-16T15:00:01.000Z", completedAt: "2026-11-16T15:00:02.000Z", providerTurnId: "other-turn-id", driver: "muse" }));
  db.close();
  const stats = backend.getThreadStats(threadId);
  assert.equal(stats.ok, true, JSON.stringify(stats.error || ""));
  assert.equal(stats.isRunning, true);
  assert.equal(stats.speed.currentTurnEstimateTps, null, `other-turn/other-provider items must be excluded, got ${stats.speed.currentTurnEstimateTps}`);
  // Positive control: item proven to current turn (matching turnId + driver) does produce estimate
  const db2 = new DatabaseSync(dbPath);
  const thread2 = "thread:r2-positive";
  const iso2 = "2026-11-16T15:10:00.000Z";
  db2.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?,?,?,?,?,?)").run(thread2, "p1", thread2, "codex", iso2, JSON.stringify({ modelSelection: { model: "codex-fixture", provider: "codex" } }), null, null);
  db2.prepare("INSERT INTO orchestration_v2_projection_provider_sessions VALUES (?,?,?,?,?,?,?,?)").run(`${thread2}-sess`, thread2, "codex", "running", "codex-fixture", iso2, "{}", "codex");
  db2.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?,?,?,?,?)").run(`${thread2}-pt`, thread2, "codex", iso2, JSON.stringify({}));
  db2.prepare("INSERT INTO orchestration_v2_projection_provider_turns VALUES (?,?,?,?,?,?,?)").run(`${thread2}-t1`, thread2, 1, "running", "2026-11-16T15:10:00.000Z", null, JSON.stringify({ nativeTurnRef: { driver: "codex", nativeId: "n1" } }));
  db2.prepare("INSERT INTO orchestration_v2_projection_turn_items VALUES (?,?)").run(thread2, JSON.stringify({ type: "assistant_message", startedAt: "2026-11-16T15:10:01.000Z", completedAt: "2026-11-16T15:10:03.000Z", outputTokens: 100, providerTurnId: `${thread2}-t1`, driver: "codex" }));
  db2.close();
  const pos = backend.getThreadStats(thread2);
  assert.ok(pos.speed.currentTurnEstimateTps != null && pos.speed.currentTurnEstimateTps > 0, `proven current-turn item must produce estimate, got ${pos.speed.currentTurnEstimateTps}`);
  // Source must check turn identity and driver
  const backendSource = fs.readFileSync(path.join(repo, "src/backend.cjs"), "utf8");
  assert.match(backendSource, /providerTurnId/, "computeCurrentTurnEstimateTps must check providerTurnId");
  assert.match(backendSource, /turnId/, "computeCurrentTurnEstimateTps must check turnId");
});

// R3 [P1] Running without an active current-turn row must force cache/speed null (all three paths)
test("R3: running with only completed latest turn forces turnRate and speeds null", () => {
  const dbPath = path.join(process.env.T3CODE_HOME, "statev2.sqlite");
  const db = new DatabaseSync(dbPath);
  const threadId = "thread:r3-stale-running";
  const iso = "2026-11-16T16:00:00.000Z";
  db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?,?,?,?,?,?)").run(threadId, "p1", threadId, "codex", iso, JSON.stringify({ modelSelection: { model: "codex-fixture", provider: "codex" } }), null, null);
  // Session reports running, but provider_turns latest row is completed (new turn not yet persisted)
  db.prepare("INSERT INTO orchestration_v2_projection_provider_sessions VALUES (?,?,?,?,?,?,?,?)").run(`${threadId}-sess`, threadId, "codex", "running", "codex-fixture", iso, "{}", "codex");
  db.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?,?,?,?,?)").run(`${threadId}-pt`, threadId, "codex", iso, JSON.stringify({}));
  db.prepare("INSERT INTO orchestration_v2_projection_provider_turns VALUES (?,?,?,?,?,?,?)").run(`${threadId}-t1`, threadId, 1, "completed", "2026-11-16T15:50:00.000Z", "2026-11-16T15:50:05.000Z", JSON.stringify({ nativeTurnRef: { driver: "codex", nativeId: "n1" }, turnTokenUsage: { inputTokens: 1000, cachedInputTokens: 900, outputTokens: 100 } }));
  db.close();
  const stale = backend.getThreadStats(threadId);
  assert.equal(stale.ok, true, JSON.stringify(stale.error || ""));
  assert.equal(stale.isRunning, true);
  assert.equal(stale.cache.turnRate, null, "running without active turn must not show prior 90% cache");
  assert.equal(stale.cache.lastTurnRate, null);
  assert.equal(stale.speed.currentTurnEstimateTps, null);
  assert.equal(stale.speed.lastDecodeTps, null);
  // priceRemoteProjection: isRunning + last turn completed => null even though turn has usage/decode
  const remote = backend.priceRemoteProjection({
    threadId: "remote-r3", provider: "codex", model: "m", isRunning: true,
    turns: [
      { status: "completed", driver: "codex", startedMs: 1000, completedMs: 5000, usage: { inputTokens: 1000, cachedInputTokens: 900, outputTokens: 100, reasoningTokens: 0 }, streamDecode: { streamSec: 2, visFraction: 1 } },
    ],
  });
  assert.equal(remote.cache.turnRate, null, `remote running without active turn must not inherit 0.9, got ${remote.cache.turnRate}`);
  assert.equal(remote.speed.lastDecodeTps, null);
  assert.equal(remote.speed.currentTurnEstimateTps, null);
  // Driver mismatch while running => also null
  const mismatch = backend.priceRemoteProjection({
    threadId: "remote-r3b", provider: "codex", model: "m", isRunning: true,
    turns: [
      { status: "completed", driver: "muse", startedMs: 1000, completedMs: 5000, usage: { inputTokens: 1000, cachedInputTokens: 900, outputTokens: 100, reasoningTokens: 0 }, streamDecode: { streamSec: 2, visFraction: 1 } },
    ],
  });
  assert.equal(mismatch.cache.turnRate, null);
  assert.equal(mismatch.speed.currentTurnEstimateTps, null);
  // buildLocalProjectionFallback same iron rule
  const start = rendererSource.indexOf("function toEpochMs(");
  const end = rendererSource.indexOf("// Distinct, clean Git swimlane");
  const fallbackChunk = rendererSource.slice(start, end);
  const { buildLocalProjectionFallback } = new Function(`${fallbackChunk}\nreturn { buildLocalProjectionFallback };`)();
  const local = buildLocalProjectionFallback({
    threadId: "local-r3", provider: "codex", model: "m", isRunning: true,
    turns: [
      { status: "completed", driver: "codex", startedMs: 1000, completedMs: 5000, usage: { inputTokens: 1000, cachedInputTokens: 900, outputTokens: 100, reasoningTokens: 0 }, streamDecode: { streamSec: 2, visFraction: 1 } },
    ],
  });
  assert.equal(local.cache.turnRate, null, `local fallback running without active turn must null, got ${local.cache.turnRate}`);
  assert.equal(local.speed.currentTurnEstimateTps, null);
  assert.equal(local.speed.lastDecodeTps, null);
});

// R4 [P2] Bare charCount must not be divided as tokens; text-based CJK estimation instead
test("R4: bare charCount is never reported as raw tok/s", () => {
  const dbPath = path.join(process.env.T3CODE_HOME, "statev2.sqlite");
  const db = new DatabaseSync(dbPath);
  const threadId = "thread:r4-charcount";
  const iso = "2026-11-16T17:00:00.000Z";
  db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?,?,?,?,?,?)").run(threadId, "p1", threadId, "codex", iso, JSON.stringify({ modelSelection: { model: "codex-fixture", provider: "codex" } }), null, null);
  db.prepare("INSERT INTO orchestration_v2_projection_provider_sessions VALUES (?,?,?,?,?,?,?,?)").run(`${threadId}-sess`, threadId, "codex", "running", "codex-fixture", iso, "{}", "codex");
  db.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?,?,?,?,?)").run(`${threadId}-pt`, threadId, "codex", iso, JSON.stringify({}));
  db.prepare("INSERT INTO orchestration_v2_projection_provider_turns VALUES (?,?,?,?,?,?,?)").run(`${threadId}-t1`, threadId, 1, "running", "2026-11-16T17:00:00.000Z", null, JSON.stringify({ nativeTurnRef: { driver: "codex", nativeId: "n1" } }));
  // 400 chars over 2s must NOT be 200 tok/s; conservative 0.28 => 56 tok/s
  db.prepare("INSERT INTO orchestration_v2_projection_turn_items VALUES (?,?)").run(threadId, JSON.stringify({ type: "assistant_message", providerTurnId: `${threadId}-t1`, driver: "codex", startedAt: "2026-11-16T17:00:01.000Z", completedAt: "2026-11-16T17:00:03.000Z", charCount: 400 }));
  db.close();
  const stats = backend.getThreadStats(threadId);
  assert.equal(stats.ok, true);
  // Must not be the buggy 200
  assert.notEqual(stats.speed.currentTurnEstimateTps, 200, "charCount/2s must not be 200 tok/s");
  assert.ok(stats.speed.currentTurnEstimateTps != null && stats.speed.currentTurnEstimateTps > 0 && stats.speed.currentTurnEstimateTps < 100, `charCount estimate must be conservative (<100), got ${stats.speed.currentTurnEstimateTps}`);
  // Text-bearing item without explicit tokens uses CJK-aware estimate
  const db2 = new DatabaseSync(dbPath);
  const thread2 = "thread:r4-text";
  const iso2 = "2026-11-16T17:10:00.000Z";
  db2.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?,?,?,?,?,?)").run(thread2, "p1", thread2, "codex", iso2, JSON.stringify({ modelSelection: { model: "codex-fixture", provider: "codex" } }), null, null);
  db2.prepare("INSERT INTO orchestration_v2_projection_provider_sessions VALUES (?,?,?,?,?,?,?,?)").run(`${thread2}-sess`, thread2, "codex", "running", "codex-fixture", iso2, "{}", "codex");
  db2.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?,?,?,?,?)").run(`${thread2}-pt`, thread2, "codex", iso2, JSON.stringify({}));
  db2.prepare("INSERT INTO orchestration_v2_projection_provider_turns VALUES (?,?,?,?,?,?,?)").run(`${thread2}-t1`, thread2, 1, "running", "2026-11-16T17:10:00.000Z", null, JSON.stringify({ nativeTurnRef: { driver: "codex", nativeId: "n1" } }));
  db2.prepare("INSERT INTO orchestration_v2_projection_turn_items VALUES (?,?)").run(thread2, JSON.stringify({ type: "assistant_message", providerTurnId: `${thread2}-t1`, driver: "codex", startedAt: "2026-11-16T17:10:01.000Z", completedAt: "2026-11-16T17:10:03.000Z", text: "a".repeat(400) }));
  db2.close();
  const textStats = backend.getThreadStats(thread2);
  assert.ok(textStats.speed.currentTurnEstimateTps != null && textStats.speed.currentTurnEstimateTps > 0 && textStats.speed.currentTurnEstimateTps < 100, `text estimate must be CJK-aware ~54 tok/s, got ${textStats.speed.currentTurnEstimateTps}`);
  const backendSource = fs.readFileSync(path.join(repo, "src/backend.cjs"), "utf8");
  assert.doesNotMatch(backendSource, /\?\? p\.charCount\s*;/, "raw charCount must not be used directly as tokens");
  assert.match(backendSource, /0\.72/, "CJK 0.72 factor missing");
  assert.match(backendSource, /0\.27/, "CJK 0.27 factor missing");
});

// R5 [P2] Empty innerText must not leak hidden textContent; hidden subtree filtered
test("R5: snapshot respects empty innerText and filters hidden thinking/streaming nodes", () => {
  // Real-DOM: innerText === \"\" must NOT fall back to raw textContent
  const realNode = {
    dataset: { messageRole: "assistant", messageId: "a-real" },
    innerText: "",
    textContent: "hidden secret thinking",
    getAttribute(name) { if (name === "data-message-role") return "assistant"; if (name === "data-message-id") return "a-real"; return null; },
    querySelectorAll() { return []; },
  };
  const realCol = {
    nodes: [realNode],
    querySelectorAll(sel) { if (sel.includes('data-message-role="assistant"')) return this.nodes; if (sel.includes("data-message-role")) return this.nodes; return []; },
  };
  const realSnap = getAssistantStreamSnapshot(realCol);
  assert.ok(realSnap, "real-DOM node should produce a snapshot");
  assert.equal(realSnap.text, "", `innerText=\"\" must stay empty, got ${JSON.stringify(realSnap.text)}`);
  // Virtual DOM (no innerText property): hidden children must be excluded
  function makeTextNode(text) { return { nodeType: 3, textContent: text }; }
  function makeEl({ text = "", children = [], hidden, ariaHidden, display, visibility, tagName = "div", open, getAttrs = {} }) {
    const el = {
      tagName,
      nodeType: 1,
      hidden: hidden === true,
      textContent: text,
      style: {},
      children: [],
      childNodes: [],
      dataset: {},
      getAttribute(name) { if (name in getAttrs) return getAttrs[name]; return null; },
      querySelectorAll() { return []; },
    };
    if (display !== undefined) el.style.display = display;
    if (visibility !== undefined) el.style.visibility = visibility;
    if (open !== undefined) el.open = open;
    if (ariaHidden !== undefined) getAttrs["aria-hidden"] = ariaHidden ? "true" : null;
    if (hidden !== undefined && hidden !== true) el.hidden = false;
    for (const child of children) {
      child.parentElement = el;
      el.children.push(child);
      el.childNodes.push(child);
      if (child.nodeType === 3) el.textContent += child.textContent;
      else if (typeof child.textContent === "string") el.textContent += child.textContent;
    }
    if (tagName === "details") { el.getAttribute = function(name) { if (name in getAttrs) return getAttrs[name]; if (name === "open") return open === true ? "" : null; return null; }; }
    return el;
  }
  const visibleChild = makeEl({ text: "visible streaming body", getAttrs: {} });
  const hiddenChild = makeEl({ text: "HIDDEN-THINKING-SECRET", hidden: true, getAttrs: {} });
  const ariaChild = makeEl({ text: "ARIA-SECRET", ariaHidden: true, getAttrs: {} });
  const noneChild = makeEl({ text: "DISPLAY-NONE-SECRET", display: "none", getAttrs: {} });
  const invisChild = makeEl({ text: "VIS-HIDDEN-SECRET", visibility: "hidden", getAttrs: {} });
  const attrHiddenChild = makeEl({ text: "ATTR-HIDDEN-SECRET", getAttrs: { hidden: "" } });
  const detailsClosedChild = makeEl({ text: "DETAILS-SECRET", tagName: "details", open: false, children: [makeTextNode("DETAILS-INNER-SECRET")], getAttrs: {} });
  const detailsOpenChild = makeEl({ text: "DETAILS-OPEN-VISIBLE", tagName: "details", open: true, children: [makeTextNode("DETAILS-OPEN-VISIBLE")], getAttrs: {} });
  const virtNode = {
    dataset: { messageRole: "assistant", messageId: "a-virt" },
    // intentionally NO innerText property (typeof !== \"string\")
    textContent: "visible streaming body" + "HIDDEN-THINKING-SECRET" + "ARIA-SECRET" + "DISPLAY-NONE-SECRET" + "VIS-HIDDEN-SECRET" + "ATTR-HIDDEN-SECRET" + "DETAILS-SECRET" + "DETAILS-OPEN-VISIBLE",
    style: {},
    hidden: false,
    tagName: "div",
    children: [visibleChild, hiddenChild, ariaChild, noneChild, invisChild, attrHiddenChild, detailsClosedChild, detailsOpenChild],
    childNodes: [makeTextNode("visible streaming body"), hiddenChild, ariaChild, noneChild, invisChild, attrHiddenChild, detailsClosedChild, detailsOpenChild],
    getAttribute(name) { if (name === "data-message-role") return "assistant"; if (name === "data-message-id") return "a-virt"; return null; },
    querySelectorAll() { return []; },
  };
  delete virtNode.innerText;
  const virtCol = {
    nodes: [virtNode],
    querySelectorAll(sel) { if (sel.includes('data-message-role="assistant"')) return this.nodes; if (sel.includes("data-message-role")) return this.nodes; return []; },
  };
  const virtSnap = getAssistantStreamSnapshot(virtCol);
  assert.ok(virtSnap, "virtual-DOM snapshot should exist");
  assert.ok(virtSnap.text.includes("visible streaming body"), `visible text must be captured, got ${JSON.stringify(virtSnap.text)}`);
  assert.ok(!virtSnap.text.includes("HIDDEN-THINKING-SECRET"), "hidden child must be skipped");
  assert.ok(!virtSnap.text.includes("ARIA-SECRET"), "aria-hidden child must be skipped");
  assert.ok(!virtSnap.text.includes("DISPLAY-NONE-SECRET"), "display:none child must be skipped");
  assert.ok(!virtSnap.text.includes("VIS-HIDDEN-SECRET"), "visibility:hidden child must be skipped");
  assert.ok(!virtSnap.text.includes("ATTR-HIDDEN-SECRET"), "hidden-attr child must be skipped");
  assert.ok(!virtSnap.text.includes("DETAILS-SECRET"), "closed details secret must be skipped");
  assert.match(rendererSource, /function isHiddenStreamNode/, "isHiddenStreamNode helper missing");
  assert.match(rendererSource, /typeof.*innerText.*!==.*string/, "must gate textContent fallback on innerText absence");
  assert.doesNotMatch(rendererSource, /viaInner\.length > 0[\s\S]{0,200}viaText[\s\S]{0,200}\|\| node\.textContent/, "empty innerText must not leak raw textContent");
});

// R6 [P2] 900ms throttle must keep pendingFastRefresh and trailing-fire
test("R6: throttled fast-refresh keeps pending flag and trailing timer", () => {
  assert.match(rendererSource, /pendingFastRefresh/, "pendingFastRefresh marker missing");
  assert.match(rendererSource, /trailingFastRefreshTimer|fastRefreshTimer/, "trailing timer missing");
  const watcher = rendererSource.match(/const streamWatchTimer[\s\S]*?\}, 260\);/)?.[0] || "";
  assert.ok(watcher, "streamWatchTimer block not found");
  assert.match(watcher, /pendingFastRefresh\s*=\s*true/, "throttled detection must set pendingFastRefresh");
  assert.match(watcher, /scheduleTrailingFastRefresh/, "trailing refresh must be scheduled");
  assert.match(rendererSource, /trailingFastRefreshTimer\s*=\s*setTimeout/, "trailing refresh must use setTimeout");
  // Baseline must not be discarded without a pending marker; trailing path must call refreshStats(false)
  assert.match(rendererSource, /refreshStats\(false\)[\s\S]{0,300}pendingFastRefresh|pendingFastRefresh[\s\S]{0,300}refreshStats\(false\)/, "trailing fire must call refreshStats(false)");
  // Cleanup must clear the timer
  const cleanup = rendererSource.match(/window\.__t3HudCleanup = \(\) =>[\s\S]*?\n  \};/)?.[0] || "";
  assert.match(cleanup, /trailingFastRefreshTimer|pendingFastRefresh/, "cleanup must clear trailing timer");
});




function regressionDb(threadId, provider = "codex") {
  const dbPath = path.join(process.env.T3CODE_HOME, "statev2.sqlite");
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(dbPath + suffix, { force: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, project_id TEXT, title TEXT, default_provider TEXT, updated_at TEXT, payload_json TEXT, archived_at TEXT, deleted_at TEXT);
    CREATE TABLE projection_projects (project_id TEXT, title TEXT, workspace_root TEXT);
    CREATE TABLE orchestration_v2_projection_provider_sessions (provider_session_id TEXT, thread_id TEXT, provider TEXT, status TEXT, model TEXT, updated_at TEXT, payload_json TEXT, driver TEXT);
    CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT, thread_id TEXT, driver TEXT, updated_at TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_provider_turns (provider_turn_id TEXT, thread_id TEXT, ordinal INTEGER, status TEXT, started_at TEXT, completed_at TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_turn_items (thread_id TEXT, updated_at TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_subagents (subagent_id TEXT, thread_id TEXT, driver TEXT, child_thread_id TEXT);
  `);
  const iso = "2026-11-16T10:00:00.000Z";
  db.prepare("INSERT INTO projection_projects VALUES (?,?,?)").run("p", "fixture", home);
  db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?,?,?,?,?,?)").run(threadId, "p", "fixture", provider, iso, JSON.stringify({ modelSelection: { provider, model: "fixture" } }), null, null);
  return db;
}

test("local context follows the active provider thread, then report time", () => {
  const id = "thread:context-projection";
  for (const [activeProviderThreadId, expected] of [["current", 24000], ["idle", 0], [undefined, 24000]]) {
    const db = regressionDb(id, "antigravity");
    db.prepare("UPDATE orchestration_v2_projection_threads SET payload_json=? WHERE thread_id=?")
      .run(JSON.stringify({ activeProviderThreadId, modelSelection: { provider: "antigravity", model: "gemini-fixture" } }), id);
    const insert = db.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?,?,?,?,?)");
    insert.run("current", id, "antigravity", "2026-11-16T12:00:00Z", JSON.stringify({ contextUsage: { usedTokens: 24000, maxTokens: 1000000 } }));
    insert.run("idle", id, "antigravity", "2026-11-16T09:00:00Z", JSON.stringify({ contextUsage: { usedTokens: 0, maxTokens: 1000000 } }));
    db.close();
    const stats = backend.getThreadStats(id);
    assert.equal(stats.ok, true, stats.error);
    assert.equal(stats.tokens.contextUsed, expected, activeProviderThreadId || "latest report");
    assert.equal(stats.tokens.contextMax, 1000000);
  }
});

test("R54: new turn start cannot refresh a prior turn's two native calls or its 90% per-call cache", async (t) => {
  const varint = value => {
    let n = BigInt(value); const bytes = [];
    while (n > 127n) { bytes.push(Number(n & 127n) | 128); n >>= 7n; }
    return Buffer.from([...bytes, Number(n)]);
  };
  const uint = (field, value) => Buffer.concat([varint(field * 8), varint(value)]);
  const bytes = (field, value) => Buffer.concat([varint(field * 8 + 2), varint(value.length), value]);
  const timestamp = (field, ms) => bytes(field, uint(1, ms / 1000));
  for (const provider of ["muse", "codex", "antigravity"]) {
    for (const mode of ["dated-start", "undated-start", "fresh-nonusage-event"]) {
      await t.test(`${provider}/${mode}`, () => {
        const id = `thread:r54-${provider}-${mode}`;
        const db = regressionDb(id, provider);
        const start = Date.parse("2026-11-16T10:01:00Z");
        const old = mode === "undated-start" ? 1000 : start - 60000;
        const iso = ms => new Date(ms).toISOString();
        const stampHex = start.toString(16).padStart(12, "0");
        const nativeId = provider === "codex"
          ? `${stampHex.slice(0, 8)}-${stampHex.slice(8)}-7000-8000-000000000${["dated-start", "undated-start", "fresh-nonusage-event"].indexOf(mode) + 901}`
          : provider === "antigravity"
          ? `00000000-0000-4000-8000-000000000${["dated-start", "undated-start", "fresh-nonusage-event"].indexOf(mode) + 901}`
          : `r54-${provider}-${mode}`;
        let file;
        if (provider === "antigravity") {
          const dir = path.join(process.env.T3CODE_HOME, "providers", "antigravity", "fixture", "antigravity-acp", "conversations");
          fs.mkdirSync(dir, { recursive: true });
          file = path.join(dir, `${nativeId}.db`);
          const native = new DatabaseSync(file);
          native.exec("CREATE TABLE steps (idx INTEGER, step_type INTEGER, metadata BLOB)");
          const insert = native.prepare("INSERT INTO steps VALUES (?,?,?)");
          for (let i = 0; i < 2; i++) insert.run(i, 15, Buffer.concat([
            timestamp(1, old + i * 2000), timestamp(6, old + i * 2000), timestamp(7, old + (i + 1) * 2000),
            bytes(9, Buffer.concat([uint(2, 100), uint(5, 900), uint(10, 100)])),
          ]));
          insert.run(2, mode === "fresh-nonusage-event" ? 2 : 15, mode === "undated-start" ? Buffer.alloc(0) : timestamp(1, start));
          native.close();
        } else {
          file = provider === "muse"
            ? path.join(process.env.MUSE_DATA_DIR, `${nativeId}.jsonl`)
            : path.join(process.env.CODEX_HOME, "sessions", "2026", "11", "16", `${nativeId}.jsonl`);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          const rows = [];
          for (let i = 0; i < 2; i++) {
            if (provider === "muse") rows.push(
              { recorded_at: (old + i * 2000) * 1000, payload: { event: { kind: "model_response_created" } } },
              { recorded_at: (old + (i + 1) * 2000) * 1000, payload: { event: { kind: "model_completed", usage: { input_tokens: 1000, cache_read_tokens: 900, output_tokens: 100 } } } },
            );
            else rows.push(
              { timestamp: iso(old + i * 2000), type: "response_item", payload: { type: "reasoning" } },
              { timestamp: iso(old + (i + 1) * 2000), type: "token_usage_record", payload: { usage: { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 100 } } },
            );
          }
          rows.push(provider === "muse"
            ? { ...(mode === "undated-start" ? {} : { recorded_at: start * 1000 }), payload: { event: { kind: mode === "fresh-nonusage-event" ? "turn_started" : "model_response_created" } } }
            : { ...(mode === "undated-start" ? {} : { timestamp: iso(start) }), type: "event_msg", payload: { type: mode === "fresh-nonusage-event" ? "task_started" : "model_response_created" } });
          fs.writeFileSync(file, rows.map(JSON.stringify).join("\n") + "\n");
          if (provider === "muse") {
            const index = new DatabaseSync(path.join(process.env.MUSE_DATA_DIR, "session-index.db"));
            index.exec("CREATE TABLE IF NOT EXISTS sessions (session_id TEXT, session_log_path TEXT)");
            index.prepare("INSERT INTO sessions VALUES (?,?)").run(nativeId, file);
            index.close();
          }
        }
        fs.utimesSync(file, new Date(start + 1000), new Date(start + 1000));
        db.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?,?,?,?,?)").run("pt", id, provider, iso(start), JSON.stringify({ nativeThreadRef: { nativeId } }));
        const insert = db.prepare("INSERT INTO orchestration_v2_projection_provider_turns VALUES (?,?,?,?,?,?,?)");
        insert.run("old", id, 1, "completed", iso(start - 60000), iso(start - 56000), JSON.stringify({ nativeTurnRef: { driver: provider }, turnTokenUsage: { inputTokens: 2000, cachedInputTokens: 1800, outputTokens: 200 } }));
        insert.run("live", id, 2, "running", iso(start), null, JSON.stringify({ nativeTurnRef: { driver: provider } }));
        db.close();
        const result = backend.getThreadStats(id);
        assert.equal(result.ok, true);
        assert.equal(result.telemetrySource, "native", "this regression must exercise the actual native reader");
        assert.equal(result.isRunning, true);
        assert.equal(result.cache.lastCallRate, null, "two calls in one completed turn cannot authorize an old 90% cache sample");
        assert.equal(result.cache.turnRate, null);
        assert.equal(result.speed.lastDecodeTps, null);
        assert.equal(result.speed.currentTurnEstimateTps, null);
        assert.equal(result.cache.sessionRate, 0.9, "historical totals are preserved");
        const parsed = backend._fileParseCache.get(file).data;
        assert.equal(parsed.stepCount, 2);
        assert.equal(parsed.lastUsageEventMs, mode === "undated-start" ? null : old + 4000);
        assert.equal(parsed.lastSpeedEventMs, mode === "undated-start" || (provider === "antigravity" && mode === "dated-start") ? null : old + 4000);
        assert.equal(parsed.hasPendingUnfinishedCallAfterLastUsage, mode !== "fresh-nonusage-event" || provider !== "antigravity");

        // Once this turn really reports usage, restore its own call cache and
        // completed speed; suppressing every sample would also pass the negatives.
        if (provider === "antigravity") {
          const native = new DatabaseSync(file);
          native.prepare("INSERT INTO steps VALUES (?,?,?)").run(3, 15, Buffer.concat([
            timestamp(1, start), timestamp(6, start), timestamp(7, start + 5000),
            bytes(9, Buffer.concat([uint(2, 600), uint(5, 400), uint(10, 100)])),
          ]));
          native.close();
        } else {
          const rows = provider === "muse" ? [
            { recorded_at: start * 1000, payload: { event: { kind: "model_response_created" } } },
            { recorded_at: (start + 5000) * 1000, payload: { event: { kind: "model_completed", usage: { input_tokens: 1000, cache_read_tokens: 400, output_tokens: 100 } } } },
          ] : [
            { timestamp: iso(start), type: "response_item", payload: { type: "reasoning" } },
            { timestamp: iso(start + 5000), type: "token_usage_record", payload: { usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 100 } } },
          ];
          fs.appendFileSync(file, rows.map(JSON.stringify).join("\n") + "\n");
        }
        fs.utimesSync(file, new Date(start + 5000), new Date(start + 5000));
        const withUsage = backend.getThreadStats(id);
        assert.equal(withUsage.cache.lastCallRate, 0.4, "fresh current call cache is accepted");
        const finished = new DatabaseSync(path.join(process.env.T3CODE_HOME, "statev2.sqlite"));
        finished.prepare("UPDATE orchestration_v2_projection_provider_turns SET status='completed', completed_at=?, payload_json=? WHERE provider_turn_id='live'")
          .run(iso(start + 5000), JSON.stringify({ nativeTurnRef: { driver: provider }, turnTokenUsage: { inputTokens: provider === "antigravity" ? 1400 : 1000, cachedInputTokens: 400, outputTokens: 100 } }));
        finished.close();
        const completed = backend.getThreadStats(id);
        assert.equal(completed.cache.turnRate, 0.4);
        assert.equal(completed.speed.lastDecodeTps, 20, "current 100 tokens / 5s replaces historical 50 tok/s");
        const fresh = backend._fileParseCache.get(file).data;
        assert.equal(fresh.lastUsageEventMs, start + 5000);
        assert.equal(fresh.lastSpeedEventMs, start + 5000);
        assert.equal(fresh.hasPendingUnfinishedCallAfterLastUsage, false);
      });
    }
  }
});
function projectionFallback() {
  const start = rendererSource.indexOf("  function fallbackModelRate(");
  const end = rendererSource.indexOf("// Distinct, clean Git swimlane", start);
  return new Function(`${rendererSource.slice(start, end)};return buildLocalProjectionFallback;`)();
}

function regressionProjection(p) {
  const functions = ["toEpochMs", "buildProjectionPayload"].map(name =>
    rendererSource.match(new RegExp(`  function ${name}\\([\\s\\S]*?\\n  \\}`))[0]).join("\n");
  return vm.runInNewContext(`${functions}\nbuildProjectionPayload`)(p, "fixture-env", null);
}

test("R13: thread selection beats an absent/stale cross-provider session, including missing dates", () => {
  const selection = "2026-11-16T10:00:00Z";
  for (const [threadDate, sessionDate, turnStart, expected] of [
    [selection, "2026-11-16T09:59:59Z", selection, "muse"],
    [selection, selection, selection, "muse"],
    [selection, null, selection, "muse"],
    [null, selection, selection, "muse"],
    [null, null, selection, "muse"],
    [selection, "2026-11-16T10:00:01Z", selection, "muse"],
    [selection, "2026-11-16T10:00:01Z", "2026-11-16T10:00:02Z", "codex"],
  ]) {
    for (const withTurn of turnStart > selection ? [true] : [false, true]) {
      const id = "thread:r13"; const db = regressionDb(id, "muse");
      db.prepare("UPDATE orchestration_v2_projection_threads SET updated_at=?,payload_json=?").run(threadDate, JSON.stringify({ modelSelection: { provider: "muse", model: "current-muse" } }));
      db.prepare("INSERT INTO orchestration_v2_projection_provider_sessions VALUES (?,?,?,?,?,?,?,?)").run("old", id, "codex", "running", "old-codex-model", sessionDate, "{}", "codex");
      db.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?,?,?,?,?)").run("old-ctx", id, "codex", selection, JSON.stringify({ contextUsage: { usedTokens: 9999, maxTokens: 20000 } }));
      if (withTurn) db.prepare("INSERT INTO orchestration_v2_projection_provider_turns VALUES (?,?,?,?,?,?,?)").run("old-turn", id, 1, "running", turnStart, null, JSON.stringify({ nativeTurnRef: { driver: "codex" }, turnTokenUsage: { inputTokens: 1000, cachedInputTokens: 900, outputTokens: 270 } }));
      db.close();
      const stats = backend.getThreadStats(id);
      assert.equal(stats.ok, true, stats.error);
      assert.equal(stats.provider, expected, `${threadDate}/${sessionDate}/${turnStart}, turn=${withTurn}`);
      if (expected === "muse") {
        assert.equal(stats.model, "current-muse"); assert.equal(stats.isRunning, false);
        assert.equal(stats.tokens.contextUsed, null); assert.notEqual(stats.tokens.contextMax, 20000);
        assert.equal(stats.cache.turnRate, null); assert.equal(stats.cache.lastCallRate, null);
        for (const k of ["lastDecodeTps", "currentTurnEstimateTps", "durationSec"]) assert.equal(stats.speed[k], null, k);
      }
    }
  }
});

test("R14: only the latest current-provider turn/session can indicate running", () => {
  for (const sessionStatus of ["completed", "running"]) {
    for (const sessionDate of ["2026-11-16T10:00:00Z", "2026-11-16T10:00:05Z", "2026-11-16T10:00:06Z"]) {
      const id = "thread:r14"; const db = regressionDb(id, "muse");
      db.prepare("INSERT INTO orchestration_v2_projection_provider_sessions VALUES (?,?,?,?,?,?,?,?)").run("new", id, "muse", sessionStatus, "current-muse", sessionDate, "{}", "muse");
      for (const [tid, driver, status, start, end] of [
        ["old", "codex", "running", "2026-11-16T09:00:00Z", null],
        ["new", "muse", "completed", "2026-11-16T10:00:00Z", "2026-11-16T10:00:05Z"],
      ]) db.prepare("INSERT INTO orchestration_v2_projection_provider_turns VALUES (?,?,?,?,?,?,?)").run(tid, id, 1, status, start, end, JSON.stringify({ nativeTurnRef: { driver }, turnTokenUsage: { inputTokens: 100, cachedInputTokens: 50, outputTokens: 100 } }));
      db.close();
      const stats = backend.getThreadStats(id);
      const newSessionStarted = sessionStatus === "running" && sessionDate.endsWith("06Z");
      assert.equal(stats.isRunning, newSessionStarted, `${sessionStatus}/${sessionDate}`);
      assert.equal(stats.cache.turnRate, newSessionStarted ? null : 0.5);
      assert.equal(stats.speed.lastDecodeTps, newSessionStarted ? null : 20);
      assert.equal(stats.speed.durationSec, newSessionStarted ? null : 5);
    }
  }
});

test("R16: unfinished projection items use observation time and carry text/char/token output to both pricing paths", () => {
  for (const kind of ["assistant_message", "reasoning"]) {
    for (const output of [{ text: "a".repeat(300) }, { charCount: 300 }, { outputTokens: 100 }]) {
      const expectedOut = output.text ? 99 : output.charCount ? 84 : 100;
      const p = regressionProjection({ sampledAtMs: 5000, thread: { id: "r16", providerInstanceId: "muse" }, runs: [{ status: "running" }],
        providerTurns: [{ id: "live", status: "running", startedAt: 1000, nativeTurnRef: { driver: "muse" } }],
        turnItems: [{ type: kind, providerTurnId: "live", startedAt: 1000, ...output }] });
      assert.equal(p.sampledAtMs, 5000); assert.equal(p.turns[0].lastItemMs, 5000);
      assert.ok(Math.abs(p.turns[0].itemOutputTokens - expectedOut) < 0.001);
      const expected = Math.round(expectedOut / 4 * 10) / 10;
      assert.equal(p.turns[0].itemEstimateTps, expected);
      for (const price of [backend.priceRemoteProjection, projectionFallback()]) {
        assert.equal(price(p).speed.currentTurnEstimateTps, expected);
        const withoutEstimate = JSON.parse(JSON.stringify(p)); withoutEstimate.turns[0].itemEstimateTps = null;
        assert.equal(price(withoutEstimate).speed.currentTurnEstimateTps, expected, "itemOutputTokens fallback");
      }
    }
  }
});

test("R17: ongoing tool waits merge/clip at observation time in projection, remote/local pricing and SQLite", () => {
  for (const status of [undefined, "running", "pending", "in_progress", "cancelled", "completed"]) {
    const active = status == null || ["running", "pending", "in_progress"].includes(status);
    const p = regressionProjection({ sampledAtMs: 4000, thread: { id: "r17", providerInstanceId: "muse" }, runs: [{ status: "running" }],
      providerTurns: [{ id: "live", status: "running", startedAt: 0, nativeTurnRef: { driver: "muse" }, turnTokenUsage: { inputTokens: 100, outputTokens: 90 } }],
      turnItems: [{ type: "assistant_message", providerTurnId: "live", startedAt: 0, updatedAt: 4000, outputTokens: 90 },
        ...[1000, 2000].map(startedAt => ({ type: "tool_call", providerTurnId: "live", startedAt, status }))] });
    const expected = active ? 90 : 22.5;
    assert.equal(p.turns[0].itemEstimateTps, expected, String(status));
    assert.equal(p.toolIntervals.length, active ? 2 : 0);
    for (const price of [backend.priceRemoteProjection, projectionFallback()]) {
      assert.equal(price(p).speed.currentTurnEstimateTps, expected);
      p.turns[0].itemEstimateTps = null;
      assert.equal(price(p).speed.currentTurnEstimateTps, expected);
    }
    const id = "thread:r17"; const db = regressionDb(id); const s = Date.parse("2026-11-16T10:00:00Z");
    const iso = delta => new Date(s + delta).toISOString();
    db.prepare("INSERT INTO orchestration_v2_projection_provider_turns VALUES (?,?,?,?,?,?,?)").run("live", id, 1, "running", iso(0), null, JSON.stringify({ nativeTurnRef: { driver: "codex" } }));
    const items = [{ type: "assistant_message", providerTurnId: "live", driver: "codex", startedAt: iso(0), updatedAt: iso(4000), outputTokens: 90 },
      ...[1000, 2000].map(t => ({ type: "tool_call", providerTurnId: "live", driver: "codex", startedAt: iso(t), status })),
      { type: "tool_call", providerTurnId: "old", driver: "codex", startedAt: iso(0) },
      { type: "tool_call", providerTurnId: "live", driver: "muse", startedAt: iso(0) }];
    for (const it of items) db.prepare("INSERT INTO orchestration_v2_projection_turn_items VALUES (?,?,?)").run(id, iso(4000), JSON.stringify(it));
    db.close(); const originalNow = Date.now;
    try { Date.now = () => s + 4000; assert.equal(backend.getThreadStats(id).speed.currentTurnEstimateTps, expected, `SQLite ${status}`); }
    finally { Date.now = originalNow; }
  }
});

test("R8: latest session tie wins over old running provider, model and context", () => {
  const id = "thread:r8";
  const db = regressionDb(id, "muse");
  const iso = "2026-11-16T10:00:00.000Z";
  db.prepare("INSERT INTO orchestration_v2_projection_provider_sessions VALUES (?,?,?,?,?,?,?,?)").run("old", id, "codex", "running", "old-model", iso, "{}", "codex");
  db.prepare("INSERT INTO orchestration_v2_projection_provider_sessions VALUES (?,?,?,?,?,?,?,?)").run("new", id, "muse", "running", "current-model", iso, "{}", "muse");
  db.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?,?,?,?,?)").run("old-ctx", id, "codex", iso, JSON.stringify({ contextUsage: { usedTokens: 9999, maxTokens: 20000 } }));
  db.prepare("INSERT INTO orchestration_v2_projection_provider_turns VALUES (?,?,?,?,?,?,?)").run("old-turn", id, 1, "running", iso, null, JSON.stringify({ nativeTurnRef: { driver: "codex" }, turnTokenUsage: { inputTokens: 1000, cachedInputTokens: 900, outputTokens: 270 } }));
  db.prepare("INSERT INTO orchestration_v2_projection_turn_items VALUES (?,?,?)").run(id, iso, JSON.stringify({ type: "assistant_message", providerTurnId: "old-turn", driver: "codex", startedAt: iso, completedAt: "2026-11-16T10:00:05Z", outputTokens: 270 }));
  db.close();
  const result = backend.getThreadStats(id);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.provider, "muse");
  assert.equal(result.model, "current-model");
  assert.equal(result.tokens.contextUsed, null);
  assert.equal(result.tokens.contextMax, 1007997);
  assert.equal(result.cache.turnRate, null);
  assert.equal(result.cache.lastCallRate, null);
  assert.equal(result.speed.lastDecodeTps, null);
  assert.equal(result.speed.currentTurnEstimateTps, null);
  assert.equal(result.speed.durationSec, null);
  assert.ok(result.tokens.output > 0, "thread totals remain available");
  assert.equal(result.cache.sessionRate, 0.9);
  const updated = new DatabaseSync(path.join(process.env.T3CODE_HOME, "statev2.sqlite"));
  updated.prepare("UPDATE orchestration_v2_projection_provider_sessions SET status='completed' WHERE provider_session_id='new'").run();
  updated.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?,?,?,?,?)").run("muse-ctx", id, "muse", iso, JSON.stringify({ contextUsage: { usedTokens: 123, maxTokens: 777 } }));
  updated.close();
  const idle = backend.getThreadStats(id);
  assert.equal(idle.isRunning, false, "old provider running flag cannot keep the new provider running");
  assert.equal(idle.tokens.contextUsed, 123);
  assert.equal(idle.tokens.contextMax, 777);
  assert.equal(idle.speed.currentTurnEstimateTps, null);
});

test("R9: remote and renderer fallback estimate running incomplete turns and prefer own item sample", () => {
  for (const price of [backend.priceRemoteProjection, projectionFallback()]) {
    const payload = { threadId: "r9", provider: "muse", model: "fixture", isRunning: true, sampledAtMs: 5000, toolIntervals: [[2000, 3000, "live", "muse"]], turns: [{ id: "live", status: "running", driver: "muse", startedMs: 1000, completedMs: null, usage: { inputTokens: 100, outputTokens: 90 } }] };
    assert.equal(price(payload).speed.currentTurnEstimateTps, 30);
    payload.turns[0].lastItemMs = 6000;
    assert.equal(price(payload).speed.currentTurnEstimateTps, 22.5);
    payload.turns[0].itemEstimateTps = 45;
    assert.equal(price(payload).speed.currentTurnEstimateTps, 45);
    payload.turns[0].streamDecode = { streamSec: 3, visFraction: 1 };
    assert.equal(price(payload).speed.currentTurnEstimateTps, 30, "this turn's decode sample has priority over its item estimate");
    payload.turns[0].usage = null;
    assert.equal(price(payload).speed.currentTurnEstimateTps, 45, "text-only current items suffice");
    payload.turns[0].driver = "codex";
    assert.equal(price(payload).speed.currentTurnEstimateTps, null);
    payload.turns[0].driver = "muse"; payload.turns[0].status = "completed";
    assert.equal(price(payload).speed.currentTurnEstimateTps, null);
  }
});

test("R9: projection captures own item timestamps/text estimate without treating reasoning as tool wait", () => {
  const toEpochMs = rendererSource.match(/  function toEpochMs\([\s\S]*?\n  \}/)[0];
  const build = rendererSource.match(/  function buildProjectionPayload\([\s\S]*?\n  \}/)[0];
  const payload = vm.runInNewContext(`${toEpochMs}\n${build}\nbuildProjectionPayload`, {})({
    thread: { id: "r9", providerInstanceId: "muse" }, runs: [{ status: "running" }],
    providerTurns: [{ id: "t", status: "running", nativeTurnRef: { driver: "muse" }, startedAt: 1000 }],
    turnItems: [ { type: "reasoning", providerTurnId: "t", startedMs: 1000, updatedAt: 3000, text: "a".repeat(100) }, { type: "tool_call", providerTurnId: "t", startedMs: 1500, completedMs: 2000 } ],
    nodes: [{ type: "reasoning", providerTurnId: "t", startedMs: 1000, completedMs: 3000 }],
  }, "env", null);
  assert.equal(payload.turns[0].lastItemMs, 3000);
  assert.equal(payload.turns[0].itemEstimateTps, 22);
  assert.ok(Number.isFinite(payload.sampledAtMs));
  assert.equal(payload.toolIntervals.some(iv => iv[0] === 1000 && iv[1] === 3000), false);
});

test("R9: SQLite partial turn usage estimates without a completion timestamp", () => {
  const id = "thread:r9"; const db = regressionDb(id);
  const s = Date.now() - 5000;
  db.prepare("INSERT INTO orchestration_v2_projection_provider_turns VALUES (?,?,?,?,?,?,?)").run("live", id, 1, "running", new Date(s).toISOString(), null, JSON.stringify({ nativeTurnRef: { driver: "codex" }, turnTokenUsage: { inputTokens: 100, outputTokens: 90 } }));
  db.prepare("INSERT INTO orchestration_v2_projection_turn_items VALUES (?,?,?)").run(id, new Date(s+4000).toISOString(), JSON.stringify({ type: "tool_call", providerTurnId: "live", driver: "codex", startedAt: new Date(s+1000).toISOString(), completedAt: new Date(s+2000).toISOString(), updatedAt: new Date(s+4000).toISOString() }));
  db.close();
  const result = backend.getThreadStats(id);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.speed.currentTurnEstimateTps, 30);
});

test("R10: SQLite unfinished reasoning/assistant items use own updated timestamp", () => {
  for (const type of ["reasoning", "assistant_message"]) {
    const id = "thread:r10"; const db = regressionDb(id);
    const s = "2026-11-16T10:00:00.000Z";
    db.prepare("INSERT INTO orchestration_v2_projection_provider_turns VALUES (?,?,?,?,?,?,?)").run("live", id, 1, "running", s, null, JSON.stringify({ nativeTurnRef: { driver: "codex" } }));
    db.prepare("INSERT INTO orchestration_v2_projection_turn_items VALUES (?,?,?)").run(id, "2026-11-16T10:00:02.000Z", JSON.stringify({ type, providerTurnId: "live", driver: "codex", startedAt: s, text: "x".repeat(300) }));
    db.close();
    const result = backend.getThreadStats(id);
    assert.equal(result.ok, true, result.error);
    assert.ok(result.speed.currentTurnEstimateTps > 0, type);
  }
});

test("R20: stale cross-provider session updated after selection without a newer turn cannot override selected provider", () => {
  const id = "thread:r20-late-old-session";
  const db = regressionDb(id, "muse");
  db.prepare("UPDATE orchestration_v2_projection_threads SET updated_at=?,payload_json=?").run(
    "2026-11-16T10:00:00Z",
    JSON.stringify({ modelSelection: { provider: "muse", model: "new-muse" } })
  );
  db.prepare("INSERT INTO orchestration_v2_projection_provider_sessions VALUES (?,?,?,?,?,?,?,?)").run(
    "old-codex", id, "codex", "running", "old-codex", "2026-11-16T10:00:01Z", "{}", "codex"
  );
  db.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?,?,?,?,?)").run(
    "old-context", id, "codex", "2026-11-16T09:59:00Z", JSON.stringify({ contextUsage: { usedTokens: 9999, maxTokens: 20000 } })
  );
  db.close();
  const s = backend.getThreadStats(id);
  assert.equal(s.ok, true, s.error);
  assert.equal(s.provider, "muse");
  assert.equal(s.model, "new-muse");
  assert.equal(s.isRunning, false);
  assert.equal(s.tokens.contextUsed, null);
  assert.equal(s.tokens.contextMax, 1007997);
});

test("R21: same-provider model switch newer than prior session updates model immediately", () => {
  const id = "thread:r21-model-switch";
  const db = regressionDb(id, "muse");
  db.prepare("UPDATE orchestration_v2_projection_threads SET payload_json=?,updated_at=?").run(
    JSON.stringify({ modelSelection: { provider: "muse", model: "new-model" } }),
    "2026-11-16T10:01:00Z"
  );
  db.prepare("INSERT INTO orchestration_v2_projection_provider_sessions VALUES (?,?,?,?,?,?,?,?)").run(
    "old", id, "muse", "completed", "old-model", "2026-11-16T10:00:00Z", "{}", "muse"
  );
  db.close();
  const s = backend.getThreadStats(id);
  assert.equal(s.ok, true, s.error);
  assert.equal(s.provider, "muse");
  assert.equal(s.model, "new-model");
});

test("R22: remote projection and local fallback isolate old provider cache, speed, context, and running flags after selection switch", () => {
  const p = {
    thread: { id: "thread:r22-remote-switch", providerInstanceId: "muse", modelSelection: { provider: "muse", model: "new-muse" } },
    providerThreads: [{ driver: "codex", contextUsage: { usedTokens: 9999, maxTokens: 20000 } }],
    providerSessions: [{ driver: "codex", status: "running" }],
    runs: [],
    turnItems: [],
    providerTurns: [{
      id: "old",
      nativeTurnRef: { driver: "codex" },
      status: "completed",
      startedAt: "2026-11-16T10:00:00Z",
      completedAt: "2026-11-16T10:00:05Z",
      turnTokenUsage: { inputTokens: 1000, cachedInputTokens: 900, outputTokens: 200, models: ["old-codex"] },
    }],
  };
  const proj = regressionProjection(p);
  assert.equal(proj.provider, "muse");
  assert.equal(proj.contextUsage, null);
  assert.equal(proj.isRunning, false);
  for (const [label, result] of [["remote", backend.priceRemoteProjection(proj)], ["fallback", projectionFallback()(proj)]]) {
    assert.equal(result.provider, "muse", label);
    assert.equal(result.model, "new-muse", label);
    assert.equal(result.isRunning, false, label);
    assert.equal(result.cache.turnRate, null, label);
    assert.equal(result.speed.lastDecodeTps, null, label);
    assert.equal(result.speed.durationSec, null, label);
    assert.equal(result.tokens.contextUsed, null, label);
    assert.equal(result.tokens.contextMax, 1007997, label);
    assert.equal(result.cache.sessionRate, 0.9, `${label}: cumulative session rate preserved`);
  }
});

test("R23: unattributed orphan SQLite turn_items row cannot produce currentTurnEstimateTps", () => {
  const id = "thread:r23-orphan";
  const db = regressionDb(id, "codex");
  db.prepare("INSERT INTO orchestration_v2_projection_provider_turns VALUES (?,?,?,?,?,?,?)").run(
    "current", id, 1, "running", "2026-11-16T10:00:00Z", null, JSON.stringify({ nativeTurnRef: { driver: "codex" } })
  );
  const orphan = { type: "assistant_message", startedAt: "2026-11-16T10:00:01Z", completedAt: "2026-11-16T10:00:03Z", outputTokens: 100 };
  db.prepare("INSERT INTO orchestration_v2_projection_turn_items VALUES (?,?,?)").run(id, "2026-11-16T10:00:03Z", JSON.stringify(orphan));
  db.close();
  const s = backend.getThreadStats(id);
  assert.equal(s.ok, true, s.error);
  assert.equal(s.speed.currentTurnEstimateTps, null);
});

test("R29: turn_items with matching nativeItemRef.driver/driver but missing turnId cannot produce currentTurnEstimateTps", () => {
  const id = "thread:r29-driver-only-orphan";
  const db = regressionDb(id, "codex");
  db.prepare("INSERT INTO orchestration_v2_projection_provider_turns VALUES (?,?,?,?,?,?,?)").run(
    "current-turn", id, 1, "running", "2026-11-16T10:00:00Z", null, JSON.stringify({ nativeTurnRef: { driver: "codex" } })
  );
  for (const orphan of [
    { type: "assistant_message", nativeItemRef: { driver: "codex" }, startedAt: "2026-11-16T10:00:01Z", completedAt: "2026-11-16T10:00:03Z", outputTokens: 120 },
    { type: "assistant_message", driver: "codex", startedAt: "2026-11-16T10:00:01Z", completedAt: "2026-11-16T10:00:03Z", outputTokens: 120 },
  ]) {
    db.prepare("INSERT INTO orchestration_v2_projection_turn_items VALUES (?,?,?)").run(id, "2026-11-16T10:00:03Z", JSON.stringify(orphan));
  }
  db.close();
  const s = backend.getThreadStats(id);
  assert.equal(s.ok, true, s.error);
  assert.equal(s.speed.currentTurnEstimateTps, null);
});

test("R30: newly selected provider never inherits unattributed providerThreads contextUsage in buildProjectionPayload", () => {
  const proj = regressionProjection({
    thread: { id: "thread:r30-unattributed-ctx", modelSelection: { provider: "muse", model: "new-muse" } },
    providerThreads: [{ contextUsage: { usedTokens: 9999, maxTokens: 20000 } }],
    providerSessions: [],
    runs: [],
    turnItems: [],
    providerTurns: [],
  });
  assert.equal(proj.provider, "muse");
  assert.equal(proj.contextUsage, null);
  for (const [label, res] of [["remote", backend.priceRemoteProjection(proj)], ["fallback", projectionFallback()(proj)]]) {
    assert.equal(res.tokens.contextUsed, null, label);
    assert.equal(res.tokens.contextMax, 1007997, label);
  }
});

test("R31: switching provider ignores foreign or unattributed runs and sessions until the new provider has active work", () => {
  for (const scenario of [
    {
      label: "foreign-driver run",
      runs: [{ status: "running", driver: "codex" }],
      providerSessions: [],
      providerTurns: [],
    },
    {
      label: "turn-linked foreign run",
      runs: [{ status: "running", providerTurnId: "old-codex" }],
      providerSessions: [],
      providerTurns: [{ id: "old-codex", status: "running", nativeTurnRef: { driver: "codex" } }],
    },
    {
      label: "unattributed run + unattributed session while foreign turn exists",
      runs: [{ status: "running" }],
      providerSessions: [{ status: "running" }],
      providerTurns: [{ id: "old-codex", status: "running", nativeTurnRef: { driver: "codex" } }],
    },
  ]) {
    const proj = regressionProjection({
      thread: { id: "thread:r31", modelSelection: { provider: "muse", model: "new-muse" } },
      providerThreads: [],
      ...scenario,
      turnItems: [],
    });
    assert.equal(proj.isRunning, false, scenario.label);
    assert.equal(backend.priceRemoteProjection(proj).isRunning, false, `${scenario.label}: remote`);
    assert.equal(projectionFallback()(proj).isRunning, false, `${scenario.label}: fallback`);
  }
});

test("R32: buildProjectionPayload rejects items with mismatched nativeItemRef.driver across streamDecode and item estimates", () => {
  const proj = regressionProjection({
    thread: { id: "thread:r32", modelSelection: { provider: "muse", model: "new-muse" } },
    providerThreads: [],
    providerSessions: [{ driver: "muse", status: "running" }],
    runs: [{ status: "running", driver: "muse" }],
    providerTurns: [{
      id: "turn-muse",
      status: "running",
      nativeTurnRef: { driver: "muse" },
      startedAt: 1000,
    }],
    turnItems: [{
      type: "assistant_message",
      providerTurnId: "turn-muse",
      nativeItemRef: { driver: "codex" },
      startedMs: 1200,
      completedMs: 2200,
      text: "x".repeat(400),
      outputTokens: 200,
    }],
  });
  assert.equal(proj.turns[0].streamDecode, null);
  assert.equal(proj.turns[0].itemEstimateTps, null);
  assert.equal(proj.turns[0].itemOutputTokens, 0);
  assert.equal(backend.priceRemoteProjection(proj).speed.currentTurnEstimateTps, null);
  assert.equal(projectionFallback()(proj).speed.currentTurnEstimateTps, null);
});

test("R33: toolIntervals from another turn, another provider, or orphan items never inflate current turn speed", () => {
  const id = "thread:r33-sqlite-tools";
  const db = regressionDb(id, "claudeAgent");
  db.prepare("UPDATE orchestration_v2_projection_threads SET default_provider='claudeAgent', payload_json=?").run(
    JSON.stringify({ modelSelection: { provider: "claudeAgent", model: "claude-opus-4-test" } })
  );
  db.prepare("UPDATE orchestration_v2_projection_provider_sessions SET driver='claudeAgent', provider='claudeAgent', model='claude-opus-4-test'").run();
  db.prepare("INSERT INTO orchestration_v2_projection_provider_turns VALUES (?,?,?,?,?,?,?)").run(
    "t1", id, 1, "completed", "2026-11-16T10:00:00.000Z", "2026-11-16T10:00:10.000Z",
    JSON.stringify({ nativeTurnRef: { driver: "claudeAgent" }, turnTokenUsage: { inputTokens: 100, outputTokens: 100 } })
  );
  db.prepare("INSERT INTO orchestration_v2_projection_provider_turns VALUES (?,?,?,?,?,?,?)").run(
    "t2", id, 2, "completed", "2026-11-16T10:00:00.000Z", "2026-11-16T10:00:10.000Z",
    JSON.stringify({ nativeTurnRef: { driver: "claudeAgent" }, turnTokenUsage: { inputTokens: 100, outputTokens: 100 } })
  );
  // Tool belongs to t1 (overlapping t2's timestamps) + an orphan tool without turnId + foreign driver tool
  db.prepare("INSERT INTO orchestration_v2_projection_turn_items VALUES (?,?,?)").run(
    id, "2026-11-16T10:00:09.000Z",
    JSON.stringify({ type: "tool_call", providerTurnId: "t1", driver: "claudeAgent", startedAt: "2026-11-16T10:00:01.000Z", completedAt: "2026-11-16T10:00:09.000Z" })
  );
  db.prepare("INSERT INTO orchestration_v2_projection_turn_items VALUES (?,?,?)").run(
    id, "2026-11-16T10:00:09.000Z",
    JSON.stringify({ type: "tool_call", startedAt: "2026-11-16T10:00:01.000Z", completedAt: "2026-11-16T10:00:09.000Z" })
  );
  db.prepare("INSERT INTO orchestration_v2_projection_turn_items VALUES (?,?,?)").run(
    id, "2026-11-16T10:00:09.000Z",
    JSON.stringify({ type: "tool_call", providerTurnId: "t2", driver: "codex", startedAt: "2026-11-16T10:00:01.000Z", completedAt: "2026-11-16T10:00:09.000Z" })
  );
  db.close();
  const s = backend.getThreadStats(id);
  assert.equal(s.ok, true, s.error);
  assert.equal(s.speed.lastDecodeTps, 10, "t2 has 100 tok over 10s without its own valid tools -> 10 tok/s, not 50 tok/s");

  const proj = regressionProjection({
    thread: { id: "thread:r33-remote", modelSelection: { provider: "muse", model: "new-muse" } },
    providerThreads: [],
    providerSessions: [],
    runs: [],
    providerTurns: [
      { id: "t1", status: "completed", nativeTurnRef: { driver: "muse" }, startedAt: 1000, completedAt: 11000, turnTokenUsage: { inputTokens: 100, outputTokens: 100 } },
      { id: "t2", status: "completed", nativeTurnRef: { driver: "muse" }, startedAt: 1000, completedAt: 11000, turnTokenUsage: { inputTokens: 100, outputTokens: 100 } },
    ],
    turnItems: [
      { type: "tool_call", providerTurnId: "t1", startedMs: 2000, completedMs: 10000 },
      { type: "tool_call", startedMs: 2000, completedMs: 10000 },
      { type: "tool_call", providerTurnId: "t2", nativeItemRef: { driver: "codex" }, startedMs: 2000, completedMs: 10000 },
    ],
  });
  for (const [label, res] of [["remote", backend.priceRemoteProjection(proj)], ["fallback", projectionFallback()(proj)]]) {
    assert.equal(res.speed.lastDecodeTps, 10, `${label}: t2 must not subtract t1/orphan/foreign tool wait`);
  }
});

test("R37: unattributed running run alone without active driver work never marks newly selected provider as running", () => {
  const proj = regressionProjection({
    thread: { id: "thread:r37", modelSelection: { provider: "muse", model: "new-muse" } },
    providerThreads: [],
    providerSessions: [],
    providerTurns: [],
    runs: [{ status: "running" }],
    turnItems: [],
  });
  assert.equal(proj.isRunning, false, "unattributed run without session/turn evidence must not mark Muse running");
  assert.equal(backend.priceRemoteProjection(proj).isRunning, false);
  assert.equal(projectionFallback()(proj).isRunning, false);
});

test("R38: stale running session of the same provider cannot override a newer completed session and turn", () => {
  const proj = regressionProjection({
    thread: { id: "thread:r38", modelSelection: { provider: "muse", model: "muse-ember-1.0" } },
    providerThreads: [],
    providerSessions: [
      { id: "s-old", driver: "muse", status: "running", updatedAt: "2026-11-16T10:00:01.000Z" },
      { id: "s-new", driver: "muse", status: "completed", updatedAt: "2026-11-16T10:00:20.000Z" },
    ],
    runs: [
      { id: "r-old", driver: "muse", status: "running", updatedAt: "2026-11-16T10:00:01.000Z" },
      { id: "r-new", driver: "muse", status: "completed", updatedAt: "2026-11-16T10:00:20.000Z" },
    ],
    providerTurns: [{
      id: "t-done",
      status: "completed",
      nativeTurnRef: { driver: "muse" },
      startedAt: "2026-11-16T10:00:10.000Z",
      completedAt: "2026-11-16T10:00:20.000Z",
      turnTokenUsage: { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 100 },
    }],
    turnItems: [],
  });
  assert.equal(proj.isRunning, false, "older running session/run must not override newer completed session/run");
  for (const [label, res] of [["remote", backend.priceRemoteProjection(proj)], ["fallback", projectionFallback()(proj)]]) {
    assert.equal(res.isRunning, false, label);
    assert.equal(res.cache.turnRate, 0.8, label);
    assert.equal(res.speed.lastDecodeTps, 10, label);
  }
});

test("R39: unattributed legacy providerTurn is NOT attributed to newly selected provider", () => {
  const proj = regressionProjection({
    thread: { id: "thread:r39", modelSelection: { provider: "muse", model: "muse-ember-1.0" } },
    providerThreads: [],
    providerSessions: [],
    runs: [],
    providerTurns: [{
      id: "old-unattributed",
      status: "completed",
      startedAt: 1000,
      completedAt: 11000,
      turnTokenUsage: { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 100 },
    }],
    turnItems: [],
  });
  assert.equal(proj.turns[0].driver, null, "unattributed providerTurn must not inherit activeDriver");
  for (const [label, res] of [["remote", backend.priceRemoteProjection(proj)], ["fallback", projectionFallback()(proj)]]) {
    assert.equal(res.provider, "muse", label);
    assert.equal(res.cache.turnRate, null, `${label}: must not inherit unattributed turn cache rate`);
    assert.equal(res.speed.lastDecodeTps, null, `${label}: must not inherit unattributed turn speed`);
    assert.equal(res.tokens.contextUsed, null, `${label}: must not inherit unattributed turn context`);
  }
});

test("R40: conflicting item provider refs (nativeTurnRef=muse vs nativeItemRef=codex) are rejected in projection and SQLite", () => {
  const proj = regressionProjection({
    thread: { id: "thread:r40", modelSelection: { provider: "muse", model: "muse-ember-1.0" } },
    providerThreads: [],
    providerSessions: [],
    runs: [],
    providerTurns: [{
      id: "t-muse",
      status: "completed",
      nativeTurnRef: { driver: "muse" },
      startedAt: 1000,
      completedAt: 11000,
      turnTokenUsage: { inputTokens: 100, outputTokens: 100 },
    }],
    turnItems: [{
      type: "tool_call",
      providerTurnId: "t-muse",
      nativeTurnRef: { driver: "muse" },
      nativeItemRef: { driver: "codex" },
      startedMs: 2000,
      completedMs: 10000,
    }],
  });
  assert.equal(proj.toolIntervals.length, 0, "conflicting item provider refs must be excluded from toolIntervals");
  for (const [label, res] of [["remote", backend.priceRemoteProjection(proj)], ["fallback", projectionFallback()(proj)]]) {
    assert.equal(res.speed.lastDecodeTps, 10, `${label}: conflicting tool item must not inflate speed to 50 tok/s`);
  }

  const id = "thread:r40-sqlite";
  const db = regressionDb(id, "claudeAgent");
  db.prepare("UPDATE orchestration_v2_projection_threads SET default_provider='claudeAgent', payload_json=?").run(
    JSON.stringify({ modelSelection: { provider: "claudeAgent", model: "claude-opus-4-test" } })
  );
  db.prepare("UPDATE orchestration_v2_projection_provider_sessions SET driver='claudeAgent', provider='claudeAgent', model='claude-opus-4-test'").run();
  db.prepare("INSERT INTO orchestration_v2_projection_provider_turns VALUES (?,?,?,?,?,?,?)").run(
    "t-c", id, 1, "completed", "2026-11-16T10:00:00.000Z", "2026-11-16T10:00:10.000Z",
    JSON.stringify({ nativeTurnRef: { driver: "claudeAgent" }, turnTokenUsage: { inputTokens: 100, outputTokens: 100 } })
  );
  db.prepare("INSERT INTO orchestration_v2_projection_turn_items VALUES (?,?,?)").run(
    id, "2026-11-16T10:00:09.000Z",
    JSON.stringify({ type: "tool_call", providerTurnId: "t-c", driver: "claudeAgent", nativeItemRef: { driver: "codex" }, startedAt: "2026-11-16T10:00:01.000Z", completedAt: "2026-11-16T10:00:09.000Z" })
  );
  db.close();
  const s = backend.getThreadStats(id);
  assert.equal(s.speed.lastDecodeTps, 10, "SQLite must also reject conflicting driver + nativeItemRef.driver");
});

test("R41: unattributed 2-element toolIntervals [[start, end]] are NOT subtracted in remote pricing or local fallback", () => {
  const payload = {
    threadId: "thread:r41",
    provider: "muse",
    model: "muse-ember-1.0",
    isRunning: false,
    toolIntervals: [[2000, 10000]],
    turns: [{
      id: "t-cur",
      status: "completed",
      driver: "muse",
      startedMs: 1000,
      completedMs: 11000,
      usage: { inputTokens: 100, outputTokens: 100 },
    }],
  };
  for (const [label, res] of [["remote", backend.priceRemoteProjection(payload)], ["fallback", projectionFallback()(payload)]]) {
    assert.equal(res.speed.lastDecodeTps, 10, `${label}: unattributed 2-element toolIntervals must not inflate 10 tok/s to 50 tok/s`);
  }
});
