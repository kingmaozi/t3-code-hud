"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../src/renderer-ui.js"), "utf8");
function chunk(start, end) {
  const a = source.indexOf(`  function ${start}(`), b = source.indexOf(`  function ${end}(`, a);
  assert.ok(a >= 0 && b > a, `${start} missing`);
  return source.slice(a, b);
}
const layoutContext = vm.createContext({});
vm.runInContext(`${chunk("hudFreeIntervals", "visibleHudRect")}\nthis.layout=calculateHudLayout;`, layoutContext);
const layout = value => JSON.parse(JSON.stringify(layoutContext.layout(value)));
const findAnchors = vm.runInNewContext(`${chunk("findHudLayoutAnchors", "updateLayoutPosition")}\nfindHudLayoutAnchors`, {});
const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
const base = {
  header: rect(277, 0, 1083, 52), title: rect(350, 15, 260, 22),
  headerObstacles: [rect(1260, 0, 92, 52), rect(615, 15, 30, 22)],
  attach: rect(314, 905, 28, 28), model: rect(820, 905, 136, 28),
  footerObstacles: [rect(960, 905, 28, 28)], viewportWidth: 1360,
};
test("T3 v0.1.11 uses the full localized title button and native attachment icon as layout anchors", () => {
  const title = { label: "示例会话 的会话操作" };
  const attach = { label: "添加附件" };
  const scope = nodes => ({ querySelector: selector => nodes[selector] ?? null });
  const header = scope({
    "[data-thread-title-chevron]": { closest: selector => selector === 'button[aria-haspopup="menu"]' ? title : null },
  });
  const footer = scope({ "svg.lucide-paperclip": { closest: selector => selector === "button" ? attach : null } });
  const anchors = findAnchors(header, scope({}), footer);
  assert.equal(anchors.title, title);
  assert.equal(anchors.attach, attach);
  assert.ok(layout({ ...base, title: anchors.title && base.title, attach: anchors.attach && base.attach }).stats);
});
test("keeps the English attachment and title selectors for older T3 markup", () => {
  const header = { querySelector: selector => selector.includes("Thread actions for") ? base.title : null };
  const composer = { querySelector: selector => selector === 'button[aria-label="Attach files"]' ? base.attach : null };
  const anchors = findAnchors(header, composer, null);
  assert.equal(anchors.title, base.title);
  assert.equal(anchors.attach, base.attach);
});
test("desktop positions quota and graph by title and telemetry between attachment and model", () => {
  const out = layout(base);
  assert.ok(out.header && out.context && out.stats);
  assert.ok(out.header.left >= 645 && out.header.left + out.header.width <= 1257);
  assert.equal(out.context.left + out.context.width, base.model.left - 3);
  assert.ok(out.stats.left >= base.attach.right && out.stats.left + out.stats.width <= out.context.left);
  assert.equal(out.stats.top, 905.5);
});
test("native footer buttons are never covered, including narrow layouts", () => {
  const out = layout({ ...base, attach: rect(20, 600, 28, 28), model: rect(250, 600, 92, 28), footerObstacles: [rect(135, 600, 32, 28)], viewportWidth: 380 });
  assert.ok(out.stats && out.context);
  const end = out.stats.left + out.stats.width;
  assert.ok(end <= 132 || out.stats.left >= 170);
  assert.ok(out.context.left + out.context.width <= 250);
});
test("no free slot means hide affected controls, never overlap native UI", () => {
  const out = layout({ ...base, header: rect(0, 0, 300, 52), title: rect(20, 10, 230, 28), headerObstacles: [rect(252, 0, 45, 52)], attach: rect(20, 600, 28, 28), model: rect(70, 600, 150, 28), footerObstacles: [rect(48, 600, 20, 28)], viewportWidth: 300 });
  assert.equal(out.header, null);
  assert.equal(out.context, null);
  assert.equal(out.stats, null);
});
test("header uses compact Git icon only when a limited free slot exists", () => {
  const out = layout({ ...base, header: rect(0, 0, 350, 52), title: rect(20, 10, 180, 28), headerObstacles: [rect(315, 0, 35, 52)], viewportWidth: 350 });
  assert.equal(out.header.compact, true);
  assert.ok(out.header.left + out.header.width <= 312);
});
test("header reserves the full dynamic provider and dirty badge widths before native controls", () => {
  const widths = { headerFullWidth: 260, headerCompactWidth: 218 };
  const out = layout({ ...base, ...widths });
  assert.equal(out.header.width, 260);
  assert.equal(out.header.compact, false);
  assert.ok(out.header.left + out.header.width <= 1257);
  const narrow = layout({ ...base, ...widths, header: rect(0, 0, 440, 52), title: rect(0, 10, 160, 28), headerObstacles: [rect(410, 0, 30, 52)], viewportWidth: 440 });
  assert.equal(narrow.header.compact, true);
  assert.equal(narrow.header.width, 218);
  assert.ok(narrow.header.left + narrow.header.width <= 407);
  const blocked = layout({ ...base, ...widths, header: rect(0, 0, 380, 52), title: rect(0, 10, 160, 28), headerObstacles: [rect(360, 0, 20, 52)], viewportWidth: 380 });
  assert.equal(blocked.header, null);
});
test("header measurement includes the current Git badge and every provider", () => {
  const label = { style: {} };
  let removed = false;
  const clone = { style: {}, setAttribute() {}, querySelector: () => label, getBoundingClientRect: () => ({ width: label.style.display === "none" ? 118 : 172 }), remove: () => { removed = true; } };
  const context = vm.createContext({ gitBtn: { cloneNode: () => clone }, root: { appendChild() {} }, quotaRings: { children: [1, 2, 3] } });
  vm.runInContext(`${chunk("measureHudHeaderWidths", "updateLayoutPosition")}\nthis.measure=measureHudHeaderWidths;`, context);
  const sizes = context.measure();
  assert.equal(sizes.headerFullWidth, 282);
  assert.equal(sizes.headerCompactWidth, 228);
  assert.equal(removed, true);
});
test("missing composer anchors hide statistics without placing guessed values", () => {
  const out = layout({ ...base, model: null });
  assert.equal(out.stats, null);
  assert.equal(out.context, null);
});
const quotaContext = vm.createContext({
  readLiveT3State: () => quotaContext.live,
  formatResetShort: () => null,
});
vm.runInContext(`${chunk("selectHudFiveHourWindow", "renderQuotaRowsHtml")}\nthis.compute=computeQuotaAndContext;`, quotaContext);
function quota(windows, model = "gemini") {
  quotaContext.live = { selectedProvider: "muse", selectedModel: model, usage: { providers: [{ instanceId: "muse", usageLimits: { windows } }] } };
  return JSON.parse(JSON.stringify(quotaContext.compute({ ok: true, provider: "muse", tokens: {}, cache: {} })));
}
test("weekly and explicitly identified five-hour windows use real remaining values", () => {
  const q = quota([{ kind: "weekly", label: "Weekly", usedPercent: 100 }, { id: "5-hour", label: "5-hour", usedPercent: 0 }]);
  assert.equal(q.primaryWeekly.remainingPct, 0);
  assert.equal(q.primaryFiveHour.remainingPct, 100);
});
test("a session of unspecified duration is not labelled 5h", () => {
  const q = quota([{ kind: "session", label: "Session", usedPercent: 10 }]);
  assert.equal(q.primaryFiveHour, null);
});
test("Muse session uses the actual 300-minute duration for its inner ring", () => {
  const q = quota([{ id: "session", kind: "session", label: "Session", windowDurationMins: 300, usedPercent: 25 }, { id: "weekly", kind: "weekly", label: "Weekly", windowDurationMins: 10080, usedPercent: 60 }]);
  assert.equal(q.primaryFiveHour.remainingPct, 75);
  assert.equal(q.providerQuotas[0].fiveHour.remainingPct, 75);
  assert.equal(q.providerQuotas[0].weekly.remainingPct, 40);
});
test("an explicit non-five-hour duration never becomes a 5h ring", () => {
  for (const duration of [60, 180, 301, 10080, "300"]) {
    const q = quota([{ id: "session", kind: "session", label: "5-hour", windowDurationMins: duration, usedPercent: 25 }]);
    assert.equal(q.primaryFiveHour, null, `duration ${duration}`);
  }
});
test("inactive Muse also gets its own actual 300-minute session quota", () => {
  quotaContext.live = { selectedProvider: "codex", usage: { providers: [
    { instanceId: "codex", driver: "codex", usageLimits: { windows: [{ id: "weekly", kind: "weekly", usedPercent: 50 }] } },
    { instanceId: "muse", driver: "muse", usageLimits: { windows: [{ id: "session", kind: "session", label: "Session", windowDurationMins: 300, usedPercent: 20 }, { id: "weekly", kind: "weekly", usedPercent: 30 }] } },
  ] } };
  const q = JSON.parse(JSON.stringify(quotaContext.compute({ ok: true, provider: "codex", tokens: {}, cache: {} })));
  assert.equal(q.providerQuotas[1].fiveHour.remainingPct, 80);
  assert.equal(q.providerQuotas[1].weekly.remainingPct, 70);
});
test("each provider gets only its own weekly and explicitly five-hour data", () => {
  quotaContext.live = { selectedProvider: "muse", selectedModel: "gemini", usage: { providers: [
    { instanceId: "muse", driver: "muse", usageLimits: { windows: [{ kind: "weekly", usedPercent: 30 }, { kind: "session", label: "Session", usedPercent: 20 }] } },
    { instanceId: "codex", driver: "codex", usageLimits: { windows: [{ kind: "weekly", usedPercent: 80 }, { id: "5-hour", usedPercent: 40 }] } },
    { instanceId: "no-quota", usageLimits: { windows: [{ kind: "session", usedPercent: 20 }] } },
  ] } };
  const q = JSON.parse(JSON.stringify(quotaContext.compute({ ok: true, provider: "muse", tokens: {}, cache: {} })));
  assert.equal(q.providerQuotas.length, 2);
  assert.equal(q.providerQuotas[0].instanceId, "muse");
  assert.equal(q.providerQuotas[0].weekly.remainingPct, 70);
  assert.equal(q.providerQuotas[0].fiveHour, null);
  assert.equal(q.providerQuotas[1].instanceId, "codex");
  assert.equal(q.providerQuotas[1].weekly.remainingPct, 20);
  assert.equal(q.providerQuotas[1].fiveHour.remainingPct, 60);
});
test("weekly-only and five-hour-only providers render only their real concentric arcs", () => {
  const ringContext = vm.createContext({ hudLang: "en", HUD_PROVIDER_LOGOS: {}, escapeHtml: value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;") });
  vm.runInContext(`${chunk("hudQuotaRingMarkup", "renderQuotaRing")}\nthis.markup=hudQuotaRingMarkup;`, ringContext);
  const weekly = ringContext.markup({ instanceId: "muse", name: "Muse", weekly: { remainingPct: 70, tone: "ok" }, fiveHour: null });
  assert.match(weekly, /quota-week-arc/);
  assert.doesNotMatch(weekly, /quota-five-arc/);
  assert.match(weekly, /Muse/);
  const both = ringContext.markup({ instanceId: "codex", name: "Codex", weekly: { remainingPct: 20, tone: "err" }, fiveHour: { remainingPct: 60, tone: "ok" } });
  assert.match(both, /quota-week-arc/);
  assert.match(both, /quota-five-arc/);
  const fiveOnly = ringContext.markup({ instanceId: "codex", name: "Codex", weekly: null, fiveHour: { remainingPct: 60, tone: "ok" } });
  assert.doesNotMatch(fiveOnly, /quota-week-arc/);
  assert.match(fiveOnly, /quota-five-arc/);
  const escaped = ringContext.markup({ instanceId: 'bad" onfocus="alert(1)', name: '<script>', weekly: { remainingPct: 25, tone: "mid" } });
  assert.doesNotMatch(escaped, /<script>|data-hud-provider="bad" onfocus/);
});
test("missing, malformed or out-of-range usage is unknown, never invented as 100%", () => {
  for (const value of [null, undefined, "0", NaN, -1, 101]) {
    const q = quota([{ kind: "weekly", label: "Weekly", usedPercent: value }, { kind: "5h", label: "5h", usedPercent: value }]);
    assert.equal(q.primaryWeekly, null);
    assert.equal(q.primaryFiveHour, null);
  }
});
test("both top header and context controls remain in the HUD root and are removed on cleanup", () => {
  assert.match(source, /id="t3-hud-header-tools"[^>]*data-t3-hud-header-tools/);
  assert.match(source, /id="t3-hud-context-control"[^>]*data-hud-hover="context"/);
  assert.match(source, /window\.__t3HudCleanup = \(\) => \{[\s\S]*?root\.remove\(\)/);
  assert.match(source, /setComposerTopSpacing\(null\)/);
  assert.doesNotMatch(chunk("updateLayoutPosition", "onPointerMove"), /appendChild|insertBefore|\.after\(/);
});


test("keyboard focus inside a stats popover keeps it open after leaving an anchor", () => {
  const callbacks = [], active = {};
  let closed = false;
  const popover = { matches: () => false, contains: (node) => node === active, classList: { remove: () => { closed = true; } } };
  const context = vm.createContext({ popover, document: { activeElement: active }, window: { dispatchEvent() {} }, CustomEvent: class {}, clearTimeout() {}, setTimeout(fn) { callbacks.push(fn); return 1; }, popoverHideTimer: null });
  const hideFn = source.match(/  function hidePopoverDelayed\(\) \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(hideFn);
  vm.runInContext(`${hideFn}\nthis.hide=hidePopoverDelayed;`, context);
  context.hide(); callbacks.shift()();
  assert.equal(closed, false);
  context.document.activeElement = null;
  context.hide(); callbacks.shift()();
  assert.equal(closed, true);
});
