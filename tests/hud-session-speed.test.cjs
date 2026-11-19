"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../src/renderer-ui.js"), "utf8");
const start = source.indexOf("  function createHudSessionSpeedState(");
const end = source.indexOf("  function isCurrentStatsSnapshot(", start);
assert.ok(start >= 0 && end > start, "session-speed state is required");
const ctx = vm.createContext({});
vm.runInContext(source.slice(start, end) + "\nthis.createState=createHudSessionSpeedState;this.resolve=resolveHudSessionSpeed;", ctx);
const get = (state, stats, route) => JSON.parse(JSON.stringify(ctx.resolve(state, stats, route)));
const stat = (threadId, speed, extra = {}) => ({ ok: true, threadId, provider: "muse", speed, ...extra });

test("uses actual session average while running, thinking, or idle", () => {
  const state = ctx.createState();
  for (const isRunning of [true, false, true]) {
    const r = get(state, stat("chat-a", { tokPerSec: 42.3, lastDecodeTps: 200, currentTurnEstimateTps: 400 }, { isRunning }), "route-a");
    assert.equal(r.kind, "average"); assert.equal(r.value, 42.3);
  }
});

test("falls back to actual last-turn speed and retains a same-chat value through temporary gaps", () => {
  const state = ctx.createState();
  assert.deepEqual(get(state, stat("chat-a", { tokPerSec: null, lastDecodeTps: 57.1 }), "route-a"), { kind: "last", value: 57.1 });
  assert.deepEqual(get(state, stat("chat-a", { tokPerSec: null, lastDecodeTps: null }, { isRunning: true }), "route-a"), { kind: "last", value: 57.1 });
  assert.deepEqual(get(state, { ok: false }, "route-a"), { kind: "last", value: 57.1 });
});

test("a saved average stays preferred over a transient last-turn value in the same chat", () => {
  const state = ctx.createState();
  get(state, stat("chat-a", { tokPerSec: 44, lastDecodeTps: 50 }), "route-a");
  assert.deepEqual(get(state, stat("chat-a", { tokPerSec: null, lastDecodeTps: 300 }), "route-a"), { kind: "average", value: 44 });
});

test("switching routes or thread IDs clears the previous chat's speed", () => {
  const state = ctx.createState();
  get(state, stat("chat-a", { tokPerSec: 44 }), "route-a");
  assert.deepEqual(get(state, { ok: false }, "route-b"), { kind: "unknown", value: null });
  get(state, stat("chat-b", { tokPerSec: 12 }), "route-b");
  assert.deepEqual(get(state, stat("chat-c", { tokPerSec: null, lastDecodeTps: null }), "route-b"), { kind: "unknown", value: null });
});

test("a provider change cannot retain a last-turn fallback from the previous provider", () => {
  const state = ctx.createState();
  get(state, stat("chat-a", { lastDecodeTps: 44 }), "route-a");
  const next = stat("chat-a", { tokPerSec: null, lastDecodeTps: null }); next.provider = "codex";
  assert.deepEqual(get(state, next, "route-a"), { kind: "unknown", value: null });
});

test("only a confirmed new zero-output chat can show 0; unavailable historic data stays unknown", () => {
  const state = ctx.createState();
  assert.deepEqual(get(state, { ok: false, nonThreadRoute: "new" }, "draft-a"), { kind: "new", value: 0 });
  assert.deepEqual(get(state, stat("chat-b", { tokPerSec: null, lastDecodeTps: null }, { turnCount: 9, tokens: { output: 0 } }), "route-b"), { kind: "unknown", value: null });
  for (const bad of [-1, 0, NaN, Infinity, "42"]) {
    assert.deepEqual(get(ctx.createState(), stat("chat-c", { tokPerSec: bad, lastDecodeTps: null }), "route-c"), { kind: "unknown", value: null });
  }
});
