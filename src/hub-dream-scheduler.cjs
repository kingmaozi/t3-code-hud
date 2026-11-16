"use strict";

const DEFAULT_WAKE_DELAY_MS = 15_000;
const DEFAULT_INTERVAL_MS = 60_000;
const SINGLE_FLIGHT_KEY = Symbol.for("t3.hud.memory.dream-scheduler.single-flight.v1");

function sharedFlight() {
  let value = globalThis[SINGLE_FLIGHT_KEY];
  if (!value || typeof value !== "object") {
    value = { owner: null, promise: null };
    globalThis[SINGLE_FLIGHT_KEY] = value;
  }
  return value;
}

function beginDreamRun(kind, operation) {
  const flight = sharedFlight();
  if (flight.promise) return { started: false, kind: flight.kind || "dream-run", promise: flight.promise };
  if (typeof operation !== "function") throw new TypeError("dream run requires an operation");
  const owner = {};
  const work = Promise.resolve().then(operation);
  const promise = work.finally(() => {
    if (flight.owner === owner) {
      flight.owner = null;
      flight.kind = null;
      flight.promise = null;
    }
  });
  flight.owner = owner;
  flight.kind = String(kind || "dream-run");
  flight.promise = promise;
  return { started: true, kind: flight.kind, promise };
}

function errorCode(error) {
  const code = error && typeof error.code === "string" ? error.code : "";
  if (/^[A-Za-z][A-Za-z0-9_-]{0,47}$/.test(code)) return code;
  return "dream_schedule_failed";
}

function safeReason(value) {
  const allowed = new Set([
    "disabled", "already-dreamed-today", "not-due", "no-memories",
    "busy", "scheduled", "catchup",
  ]);
  return allowed.has(value) ? value : "unavailable";
}

function createDreamScheduler(options = {}) {
  const getVault = typeof options.getVault === "function" ? options.getVault : () => null;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const setTimeoutFn = options.setTimeout || setTimeout;
  const clearTimeoutFn = options.clearTimeout || clearTimeout;
  const setIntervalFn = options.setInterval || setInterval;
  const clearIntervalFn = options.clearInterval || clearInterval;
  const wakeDelayMs = Math.max(0, Number(options.wakeDelayMs ?? DEFAULT_WAKE_DELAY_MS) || 0);
  const intervalMs = Math.max(1, Number(options.intervalMs ?? DEFAULT_INTERVAL_MS) || DEFAULT_INTERVAL_MS);
  const isDisabled = typeof options.isDisabled === "function"
    ? options.isDisabled
    : () => !!(process.env.NODE_TEST_CONTEXT || process.env.T3_DISABLE_DREAM_SCHEDULER === "1");

  let started = false;
  let running = false;
  let wakeTimer = null;
  let intervalTimer = null;
  let inFlight = null;
  let nextCheckAt = null;
  let lastCheckAt = null;
  let lastOutcome = null;
  let lastError = null;
  const owner = {};

  function timestamp() {
    const n = Number(now());
    return new Date(Number.isFinite(n) ? n : Date.now()).toISOString();
  }

  function unref(timer) {
    if (timer && typeof timer.unref === "function") timer.unref();
    return timer;
  }

  function adoptSharedRun(promise, kind = "scheduler-check") {
    if (kind === "manual-run") {
      lastOutcome = "busy";
      return Promise.resolve({ ok: true, reason: "busy" });
    }
    running = true;
    inFlight = Promise.resolve(promise).then((result) => {
      if (result && result.ok === false) {
        lastError = typeof result.code === "string" ? errorCode({ code: result.code }) : "dream_schedule_failed";
        lastOutcome = "failed";
        return { ok: false, reason: lastOutcome };
      }
      lastError = null;
      lastOutcome = safeReason(result && result.reason);
      return { ok: true, reason: lastOutcome };
    }).catch((error) => {
      lastError = errorCode(error);
      lastOutcome = "failed";
      return { ok: false, reason: lastOutcome };
    }).finally(() => {
      running = false;
      inFlight = null;
    });
    return inFlight;
  }

  function tick() {
    if (!started) return Promise.resolve({ ok: false, reason: "stopped" });
    if (inFlight) return inFlight;
    const flight = sharedFlight();
    if (flight.promise) return adoptSharedRun(flight.promise, flight.kind);

    running = true;
    lastCheckAt = timestamp();
    nextCheckAt = new Date(Number(now()) + intervalMs).toISOString();
    const lease = beginDreamRun("scheduler-check", async () => {
      const vault = getVault();
      if (!vault || typeof vault.checkAndRunDueDream !== "function") {
        const error = new Error("Dream scheduler is unavailable");
        error.code = "vault_unavailable";
        throw error;
      }
      const result = await vault.checkAndRunDueDream();
      if (result && result.ok === false || result && result.error) {
        lastError = result && result.error && typeof result.error.code === "string"
          ? errorCode(result.error)
          : "dream_schedule_failed";
        lastOutcome = "failed";
        return { ok: false, reason: lastOutcome };
      }
      lastError = null;
      lastOutcome = result && result.triggered ? safeReason(result.reason) : safeReason(result && result.reason);
      return { ok: true, reason: lastOutcome };
    });
    if (!lease.started) return adoptSharedRun(lease.promise, lease.kind);
    const work = lease.promise.catch((error) => {
      lastError = errorCode(error);
      lastOutcome = "failed";
      return { ok: false, reason: lastOutcome };
    }).finally(() => {
      running = false;
      inFlight = null;
    });
    inFlight = work;
    return work;
  }

  function start() {
    if (started) return true;
    if (isDisabled()) return false;
    started = true;
    nextCheckAt = new Date(Number(now()) + wakeDelayMs).toISOString();
    try {
      wakeTimer = unref(setTimeoutFn(() => {
        wakeTimer = null;
        void tick();
      }, wakeDelayMs));
      intervalTimer = unref(setIntervalFn(() => { void tick(); }, intervalMs));
      return true;
    } catch (error) {
      stop();
      lastError = errorCode(error);
      lastOutcome = "failed";
      return false;
    }
  }

  function stop() {
    if (wakeTimer != null) {
      try { clearTimeoutFn(wakeTimer); } catch {}
      wakeTimer = null;
    }
    if (intervalTimer != null) {
      try { clearIntervalFn(intervalTimer); } catch {}
      intervalTimer = null;
    }
    started = false;
    nextCheckAt = null;
    return true;
  }

  function getStatus() {
    const flight = sharedFlight();
    return {
      started,
      running: running || !!flight.promise,
      nextCheckAt,
      lastCheckAt,
      lastOutcome,
      lastError,
      requiresHubRunning: true,
    };
  }

  return { start, stop, tick, getStatus };
}

module.exports = { createDreamScheduler, beginDreamRun, DEFAULT_WAKE_DELAY_MS, DEFAULT_INTERVAL_MS };
