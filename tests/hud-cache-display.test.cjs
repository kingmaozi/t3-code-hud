"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const rendererPath = process.env.HUD_RENDERER_SOURCE || path.resolve(__dirname, "../src/renderer-ui.js");
const rendererSource = fs.readFileSync(rendererPath, "utf8");
const start = rendererSource.indexOf("  function isValidHudCacheRate(");
const end = rendererSource.indexOf("  function cacheColor(", start);
assert.ok(start >= 0 && end > start, "cache display helpers missing");
const context = vm.createContext({});
vm.runInContext(`${rendererSource.slice(start, end)}; this.resolve = resolveHudCacheDisplay;`, context);
const resolve = stats => JSON.parse(JSON.stringify(context.resolve(stats)));

test("current-turn cache wins over the cumulative session rate", () => {
  assert.deepEqual(resolve({ ok: true, isRunning: true, cache: { turnRate: 0.42, sessionRate: 0.81 } }), { kind: "turn", rate: 0.42 });
});

test("real zero-percent current-turn cache is a valid value", () => {
  assert.deepEqual(resolve({ ok: true, isRunning: true, cache: { turnRate: 0, sessionRate: 0.62 } }), { kind: "turn", rate: 0 });
});

test("missing current-turn cache falls back to the labelled cumulative session rate", () => {
  assert.deepEqual(resolve({ ok: true, isRunning: true, cache: { turnRate: null, withSubagentsSessionRate: 0.56, sessionRate: 0.49 } }), { kind: "session", rate: 0.56 });
});

test("main-session cumulative rate supports older stats snapshots", () => {
  assert.deepEqual(resolve({ ok: true, cache: { mainSessionRate: 0.31 } }), { kind: "session", rate: 0.31 });
});

test("absent current-turn and cumulative values remain unknown", () => {
  assert.deepEqual(resolve({ ok: true, isRunning: true, cache: { turnRate: null, sessionRate: null } }), { kind: "unknown", rate: null });
});

test("invalid current-turn cache is unknown and does not fall back to session data", () => {
  for (const turnRate of [NaN, -0.01, 1.01, "0.42"]) {
    assert.deepEqual(resolve({ ok: true, cache: { turnRate, sessionRate: 0.77 } }), { kind: "unknown", rate: null }, String(turnRate));
  }
});

test("invalid preferred cumulative value is not hidden by another session field", () => {
  assert.deepEqual(resolve({ ok: true, cache: { turnRate: null, withSubagentsSessionRate: 1.1, sessionRate: 0.62 } }), { kind: "unknown", rate: null });
});

test("new sessions and failed stats never inherit a prior cache rate", () => {
  const oldValues = { turnRate: null, sessionRate: 0.88, withSubagentsSessionRate: 0.88 };
  assert.deepEqual(resolve({ ok: true, nonThreadRoute: "new", cache: oldValues }), { kind: "unknown", rate: null });
  assert.deepEqual(resolve({ ok: false, cache: oldValues }), { kind: "unknown", rate: null });
});

test("an open stats popover refreshes current-thread stats, skips context mode, and preserves focus across switches", () => {
  const start = rendererSource.indexOf("  function refreshHudStatsPopover(");
  const end = rendererSource.indexOf("  function cacheColor(", start);
  assert.ok(start >= 0 && end > start, "popover refresh helper missing");
  const context = vm.createContext({});
  vm.runInContext(`${rendererSource.slice(start, end)}; this.refresh = refreshHudStatsPopover;`, context);

  const rendered = [];
  let visible = true;
  let focused = null;
  let restoredFocus = null;
  const makeButton = () => ({ focus() { restoredFocus = this; } });
  let buttons = [makeButton()];
  const popover = {
    classList: { contains: name => name === "visible" && visible },
    contains: element => element != null && element === focused,
    querySelectorAll: selector => selector === "button" ? buttons : [],
  };
  let latestStats = { threadId: "thread-a", cache: { turnRate: 0.25 } };
  const render = () => {
    rendered.push(latestStats);
    buttons = [makeButton()];
  };

  assert.equal(context.refresh(popover, "stats", null, render), true);
  latestStats = { threadId: "thread-b", cache: { sessionRate: 0.62 } };
  focused = buttons[0]; // keyboard focus on the language button must survive refresh
  assert.equal(context.refresh(popover, "stats", focused, render), true);
  assert.equal(restoredFocus, buttons[0], "re-render must restore focus to the matching control");
  latestStats = null; // route switch clears the old chat while the new snapshot loads
  focused = restoredFocus;
  assert.equal(context.refresh(popover, "stats", focused, render), true);
  assert.deepEqual(rendered.map(stats => stats?.threadId ?? null), ["thread-a", "thread-b", null]);

  focused = null;
  assert.equal(context.refresh(popover, "context", null, render), false, "context ring must keep its renderer");
  visible = false;
  assert.equal(context.refresh(popover, "stats", null, render), false, "hidden popover has no stale visible content");
});

test("topbar refreshes the visible stats popover while retaining same-chat session speed", () => {
  const topbar = rendererSource.match(/  function renderTopbarStats\([\s\S]*?\n  \}/)?.[0] || "";
  assert.match(topbar, /latestStats = stats;[\s\S]*refreshHudStatsPopover\(popover,\s*currentPopoverMode,\s*document\.activeElement,\s*renderStatsPopover\)/,
    "visible stats popover must be refreshed from the same latest snapshot as the topbar");
  assert.match(topbar, /resolveHudSessionSpeed\(/, "the stable rate comes from the active chat");
  assert.doesNotMatch(topbar, /t\("waitingForOutput"\)/, "the speed slot is never replaced by waiting text");
  assert.match(topbar, /liveStreamTps/,
    "a proven real-time stream sample must continue through the live-speed resolver");
});
