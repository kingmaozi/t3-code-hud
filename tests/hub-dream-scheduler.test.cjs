"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createDreamScheduler, beginDreamRun, DEFAULT_INTERVAL_MS, DEFAULT_WAKE_DELAY_MS } = require("../src/hub-dream-scheduler.cjs");

function fakeTimers() {
  const timeouts = new Map(), intervals = new Map(), cleared = [];
  let id = 0;
  const make = (store, fn, delay) => {
    const timer = { id: ++id, fn, delay, unrefCalled: false, unref() { this.unrefCalled = true; } };
    store.set(timer.id, timer);
    return timer;
  };
  return {
    timeouts, intervals, cleared,
    setTimeout: (fn, delay) => make(timeouts, fn, delay),
    setInterval: (fn, delay) => make(intervals, fn, delay),
    clearTimeout(timer) { cleared.push(timer); timeouts.delete(timer.id); },
    clearInterval(timer) { cleared.push(timer); intervals.delete(timer.id); },
  };
}

test("scheduler is single-start, uses an unref'd wake and interval, and reports next check", () => {
  const timers = fakeTimers();
  const scheduler = createDreamScheduler({ getVault: () => ({ checkAndRunDueDream: async () => ({ ok: true, reason: "not-due" }) }), ...timers, isDisabled: () => false, now: () => Date.UTC(2026, 10, 16, 12) });
  assert.equal(scheduler.start(), true);
  assert.equal(scheduler.start(), true);
  assert.equal(timers.timeouts.size, 1);
  assert.equal(timers.intervals.size, 1);
  const [wake] = timers.timeouts.values();
  const [interval] = timers.intervals.values();
  assert.equal(wake.delay, DEFAULT_WAKE_DELAY_MS);
  assert.equal(interval.delay, DEFAULT_INTERVAL_MS);
  assert.equal(wake.unrefCalled, true);
  assert.equal(interval.unrefCalled, true);
  assert.equal(scheduler.getStatus().started, true);
  assert.equal(scheduler.getStatus().nextCheckAt, "2026-11-16T12:00:15.000Z");
});

test("overlapping ticks share one dream check and expose its safe outcome", async () => {
  const timers = fakeTimers();
  let resolveCheck, calls = 0;
  const scheduler = createDreamScheduler({ getVault: () => ({ checkAndRunDueDream: () => { calls++; return new Promise(resolve => { resolveCheck = resolve; }); } }), ...timers, isDisabled: () => false });
  scheduler.start();
  const one = scheduler.tick(), two = scheduler.tick();
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(scheduler.getStatus().running, true);
  resolveCheck({ ok: true, triggered: true, reason: "scheduled", report: { privateBody: "must not leak into scheduler status" } });
  assert.deepEqual(await one, { ok: true, reason: "scheduled" });
  assert.deepEqual(await two, { ok: true, reason: "scheduled" });
  assert.equal(scheduler.getStatus().lastOutcome, "scheduled");
  assert.equal(JSON.stringify(scheduler.getStatus()).includes("privateBody"), false);
  assert.equal(scheduler.getStatus().running, false);
});

test("a hot-reloaded scheduler waits for an existing run instead of starting a second one", async () => {
  const firstTimers = fakeTimers(), nextTimers = fakeTimers();
  let resolveOld, calls = 0;
  const schedulerBeforeReload = createDreamScheduler({
    getVault: () => ({ checkAndRunDueDream: () => { calls++; return new Promise(resolve => { resolveOld = resolve; }); } }),
    ...firstTimers, isDisabled: () => false,
  });
  const schedulerAfterReload = createDreamScheduler({
    getVault: () => ({ checkAndRunDueDream: async () => { calls++; return { ok: true, reason: "not-due" }; } }),
    ...nextTimers, isDisabled: () => false,
  });
  schedulerBeforeReload.start();
  const oldRun = schedulerBeforeReload.tick();
  await Promise.resolve();
  schedulerBeforeReload.stop();
  schedulerAfterReload.start();
  const reloadRun = schedulerAfterReload.tick();
  await Promise.resolve();
  assert.equal(calls, 1, "the replacement must not overlap the still active run");
  assert.equal(schedulerAfterReload.getStatus().running, true);
  resolveOld({ ok: true, reason: "not-due" });
  await Promise.all([oldRun, reloadRun]);
  assert.equal(schedulerAfterReload.getStatus().running, false);
  await schedulerAfterReload.tick();
  assert.equal(calls, 2, "a new check can start after the previous run settles");
});

test("manual run returns busy while a pre-reload scheduled dream is still pending", async () => {
  const timers = fakeTimers();
  let resolveOld, calls = 0;
  const beforeReload = createDreamScheduler({
    getVault: () => ({ checkAndRunDueDream: () => { calls++; return new Promise(resolve => { resolveOld = resolve; }); } }),
    ...timers, isDisabled: () => false,
  });
  beforeReload.start();
  const oldScheduledRun = beforeReload.tick();
  await Promise.resolve();
  beforeReload.stop();

  let manualCalls = 0;
  const manual = beginDreamRun("manual-run", async () => { manualCalls++; return { ok: true }; });
  assert.equal(manual.started, false);
  assert.equal(manual.kind, "scheduler-check");
  assert.equal(manualCalls, 0);
  assert.equal(calls, 1);

  resolveOld({ ok: true, reason: "scheduled" });
  await oldScheduledRun;
  const afterSettled = beginDreamRun("manual-run", async () => { manualCalls++; return { ok: true }; });
  assert.equal(afterSettled.started, true);
  assert.deepEqual(await afterSettled.promise, { ok: true });
  assert.equal(manualCalls, 1);
});

test("scheduler failures are observable without persisting error text that may contain private data", async () => {
  const scheduler = createDreamScheduler({ getVault: () => ({ checkAndRunDueDream: async () => { const error = new Error("private memory contents"); error.code = "EHOSTDOWN"; throw error; } }), isDisabled: () => false });
  scheduler.start();
  assert.deepEqual(await scheduler.tick(), { ok: false, reason: "failed" });
  const status = scheduler.getStatus();
  assert.equal(status.lastOutcome, "failed");
  assert.equal(status.lastError, "EHOSTDOWN");
  assert.equal(JSON.stringify(status).includes("private memory contents"), false);
});

test("stop clears both timers and prevents further scheduled work", async () => {
  const timers = fakeTimers(); let calls = 0;
  const scheduler = createDreamScheduler({ getVault: () => ({ checkAndRunDueDream: async () => { calls++; return { ok: true, reason: "not-due" }; } }), ...timers, isDisabled: () => false });
  scheduler.start();
  const wake = [...timers.timeouts.values()][0]; const interval = [...timers.intervals.values()][0];
  scheduler.stop();
  assert.equal(scheduler.getStatus().started, false);
  assert.equal(scheduler.getStatus().nextCheckAt, null);
  assert.equal(timers.timeouts.size + timers.intervals.size, 0);
  wake.fn(); interval.fn();
  await Promise.resolve();
  assert.equal(calls, 0);
});

test("disabled scheduler creates no timer and reports that it is not running", () => {
  const timers = fakeTimers();
  const scheduler = createDreamScheduler({ getVault: () => null, ...timers, isDisabled: () => true });
  assert.equal(scheduler.start(), false);
  assert.deepEqual([timers.timeouts.size, timers.intervals.size], [0, 0]);
  assert.equal(scheduler.getStatus().started, false);
});

test("legacy ensureDreamScheduler stops timers and reports status without restarting", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hub-dream-getter-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const backendPath = path.resolve(__dirname, "../src/backend.cjs");
  const code = `
    const assert = require('node:assert/strict');
    const created = [], cleared = [];
    global.setTimeout = (fn, delay) => { const x={fn,delay,unref(){}}; created.push(['timeout',x]); return x; };
    global.setInterval = (fn, delay) => { const x={fn,delay,unref(){}}; created.push(['interval',x]); return x; };
    global.clearTimeout = x => cleared.push(x);
    global.clearInterval = x => cleared.push(x);
    const backend = require(${JSON.stringify(backendPath)});
    assert.ok(backend.getMemoryVault());
    assert.equal(created.length, 0, 'the vault getter must not create a process-local scheduler');
    assert.equal(backend.getDreamSchedulerStatus().started, false);
    const scheduler = globalThis[Symbol.for('t3.hud.memory.dream-scheduler.v1')];
    assert.equal(scheduler.start(), true, 'simulate a legacy scheduler without real timers or Dream execution');
    assert.equal(created.length, 2);
    const compatibilityStatus = backend.ensureDreamScheduler();
    assert.deepEqual(compatibilityStatus, backend.getDreamSchedulerStatus());
    assert.equal(compatibilityStatus.started, false, 'legacy ensure must report the scheduler stopped');
    assert.equal(created.length, 2, 'ensure must not create replacement timers');
    assert.equal(cleared.length, 2, 'ensure must clear timers from an older scheduler');
    backend.stopDreamScheduler();
    assert.equal(cleared.length, 2);
  `;
  const result = spawnSync(process.execPath, ["-e", code], {
    encoding: "utf8", timeout: 5000,
    env: { HOME: home, T3CODE_HOME: path.join(home, "userdata"), PATH: process.env.PATH || "/usr/bin:/bin" },
  });
  assert.equal(result.error, undefined, result.stderr);
  assert.equal(result.status, 0, result.stderr);
});
