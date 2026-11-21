"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../src/renderer-ui.js"), "utf8");

function sliceBetween(startMarker, endMarker) {
  const a = source.indexOf(startMarker);
  const b = source.indexOf(endMarker, a);
  assert.ok(a >= 0 && b > a, `missing slice ${startMarker} -> ${endMarker}`);
  return source.slice(a, b);
}

test("Antigravity splits Gemini and Claude/GPT pools into two concentric header rings with dual crossed icon", () => {
  const ctx = vm.createContext({
    readLiveT3State: () => ctx.live,
    formatResetShort: (v) => v || null,
    escapeHtml: (v) => String(v).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;"),
    hudLang: "zh",
  });
  vm.runInContext(
    `${sliceBetween("  const quotaBurnSamples = new Map();", "  function formatContextPair(")}\n` +
    `${sliceBetween("  const HUD_PROVIDER_LOGOS = ", "  let lastQuotaRingsSig = ")}\n` +
    `this.compute = computeQuotaAndContext; this.markup = hudQuotaRingMarkup; this.rows = renderQuotaRowsHtml; this.burn = recordQuotaBurnEstimate;`,
    ctx
  );

  ctx.live = {
    selectedProvider: "antigravity",
    selectedModel: "gemini-4-neon",
    usage: {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          usageLimits: { windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 100, resetsAt: "16h" }] },
        },
        {
          instanceId: "antigravity",
          driver: "antigravity",
          usageLimits: {
            windows: [
              { id: "3p-5h", kind: "fiveHour", label: "Claude & GPT · 5-hour", windowDurationMins: 300, usedPercent: 49, resetsAt: "2h57m" },
              { id: "gem-5h", kind: "fiveHour", label: "Gemini · 5-hour", windowDurationMins: 300, usedPercent: 19, resetsAt: "57m" },
              { id: "3p-wk", kind: "weekly", label: "Claude & GPT · Weekly", windowDurationMins: 10080, usedPercent: 53, resetsAt: "4.1d" },
              { id: "gem-wk", kind: "weekly", label: "Gemini · Weekly", windowDurationMins: 10080, usedPercent: 5, resetsAt: "6.8d" },
            ],
          },
        },
        {
          instanceId: "muse",
          driver: "muse",
          usageLimits: {
            windows: [
              { id: "session", kind: "session", label: "Session", windowDurationMins: 300, usedPercent: 2, resetsAt: "8m" },
              { id: "weekly", kind: "weekly", label: "Weekly", windowDurationMins: 10080, usedPercent: 65, resetsAt: "35h" },
            ],
          },
        },
      ],
    },
  };

  const out = JSON.parse(JSON.stringify(ctx.compute({ ok: true, provider: "antigravity", tokens: {}, cache: {} })));
  assert.equal(out.providerQuotas.length, 4, "Codex + AGY Gemini + AGY Claude + Muse = 4 rings");

  const agyGem = out.providerQuotas.find((p) => p.instanceId === "antigravity:gemini");
  const agyClaude = out.providerQuotas.find((p) => p.instanceId === "antigravity:claude");
  assert.ok(agyGem, "Gemini ring exists");
  assert.ok(agyClaude, "Claude/3P ring exists");
  assert.equal(agyGem.weekly.remainingPct, 95);
  assert.equal(agyGem.fiveHour.remainingPct, 81);
  assert.equal(agyClaude.weekly.remainingPct, 47);
  assert.equal(agyClaude.fiveHour.remainingPct, 51);
  assert.equal(agyClaude.logoKey, "antigravity-claude");

  const dualHtml = ctx.markup(agyClaude);
  assert.match(dualHtml, /quota-week-arc/);
  assert.match(dualHtml, /quota-five-arc/);
  assert.match(dualHtml, /is-dual/);
  assert.match(dualHtml, /t3-agy-dual/);
  assert.match(dualHtml, /#d97757/);
});

test("burn rate only estimates after >=5 min span and positive delta, and flags resets cleanly", () => {
  const ctx = vm.createContext({
    escapeHtml: (v) => String(v),
    hudLang: "zh",
  });
  vm.runInContext(
    `${sliceBetween("  const quotaBurnSamples = new Map();", "  function selectHudFiveHourWindow(")}\n` +
    `${sliceBetween("  function renderQuotaRowsHtml(", "  function formatContextPair(")}\n` +
    `this.burn = recordQuotaBurnEstimate; this.rows = renderQuotaRowsHtml;`,
    ctx
  );

  const t0 = 1_700_000_000_000;
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.burn("agy:3p-5h", 40, t0))), { burnShort: null, justReset: false });
  // Too soon (2 min) -> no invented rate
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.burn("agy:3p-5h", 50, t0 + 2 * 60_000))), { burnShort: null, justReset: false });
  // 10 min later, +10% used (60%/h), 50% remaining -> ~0.8h (~50m)
  const est = JSON.parse(JSON.stringify(ctx.burn("agy:3p-5h", 50, t0 + 10 * 60_000)));
  assert.equal(est.burnShort, "~50m");
  assert.equal(est.justReset, false);

  const html = ctx.rows([{ label: "Claude & GPT · 5-hour", remainingPct: 50, tone: "ok", reset: "2h", burnShort: est.burnShort, justReset: false }]);
  assert.match(html, /约~50m · 2h/);

  // Quota reset jump (>40% drop in usedPercent)
  const reset = JSON.parse(JSON.stringify(ctx.burn("agy:3p-5h", 2, t0 + 15 * 60_000)));
  assert.equal(reset.justReset, true);
  assert.equal(reset.burnShort, null);
});

test("single-ring quota popover card renders only that ring's own windows with outer/inner labels and preserves Muse window duration", () => {
  const ctx = vm.createContext({
    escapeHtml: (v) => String(v).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;"),
    hudLang: "zh",
  });
  vm.runInContext(
    `${sliceBetween("  function renderQuotaRingCardHtml(", "  function renderQuotaRingPopover(")}\nthis.card = renderQuotaRingCardHtml;`,
    ctx
  );

  const claudeHtml = ctx.card({
    instanceId: "antigravity:claude",
    providerInstanceId: "antigravity",
    driver: "antigravity-claude",
    logoKey: "antigravity-claude",
    name: "AGY · Claude",
    weekly: { remainingPct: 42, tone: "mid", reset: "4d 6h", burnShort: "~14.5h", justReset: false },
    fiveHour: { remainingPct: 31, tone: "err", reset: "2h 18m", burnShort: "~1.2h", justReset: false },
  });
  assert.match(claudeHtml, /Antigravity · Claude \/ 3P/);
  assert.match(claudeHtml, /双标独立池/);
  assert.match(claudeHtml, /周额度（外圈）/);
  assert.match(claudeHtml, /5 小时（内圈）/);
  assert.match(claudeHtml, /42%/);
  assert.match(claudeHtml, /31%/);
  assert.match(claudeHtml, /偏快 · 约 1\.2h 触顶/);
  assert.match(claudeHtml, /4d 6h 重置/);
  assert.doesNotMatch(claudeHtml, /Codex|Muse|HUD 版本/);

  const museHtml = ctx.card({
    instanceId: "muse",
    driver: "muse",
    name: "Muse",
    weekly: { remainingPct: 35, tone: "mid", reset: "35h", burnShort: null, justReset: false },
    fiveHour: { label: "Session", windowDurationMins: 180, remainingPct: 98, tone: "ok", reset: "8m", burnShort: null, justReset: false },
  });
  assert.match(museHtml, /3 小时（内圈）/, "Preserves Muse reported window duration");
});

test("OpenCode Go uses geometric square-frame logo and Devin non-weekly/ACU windows are retained instead of dropped", () => {
  const ctx = vm.createContext({
    readLiveT3State: () => ctx.live,
    formatResetShort: (v) => v || null,
    escapeHtml: (v) => String(v).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;"),
    hudLang: "zh",
  });
  vm.runInContext(
    `${sliceBetween("  const quotaBurnSamples = new Map();", "  function formatContextPair(")}\n` +
    `${sliceBetween("  const HUD_PROVIDER_LOGOS = ", "  let lastQuotaRingsSig = ")}\n` +
    `this.compute = computeQuotaAndContext; this.markup = hudQuotaRingMarkup;`,
    ctx
  );

  ctx.live = {
    selectedProvider: "opencode",
    selectedModel: "opencode-go/beam-free",
    usage: {
      providers: [
        {
          instanceId: "opencode-go",
          driver: "opencode",
          usageLimits: { windows: [{ id: "wk", kind: "weekly", label: "Weekly", usedPercent: 20, resetsAt: "3d" }] },
        },
        {
          instanceId: "acpRegistry_devin",
          driver: "acpRegistry",
          usageLimits: { windows: [{ id: "acu", kind: "monthly", label: "Monthly ACUs", windowDurationMins: 43200, usedPercent: 30, resetsAt: "18d" }] },
        },
      ],
    },
  };

  const out = JSON.parse(JSON.stringify(ctx.compute({ ok: true, provider: "opencode", tokens: {}, cache: {} })));
  assert.equal(out.providerQuotas.length, 2, "Both OpenCode Go and Devin non-weekly window must appear");
  const oc = out.providerQuotas.find((p) => p.instanceId === "opencode-go");
  const devin = out.providerQuotas.find((p) => p.instanceId === "acpRegistry_devin");
  assert.equal(oc.logoKey, "opencode");
  assert.equal(devin.logoKey, "devin");
  assert.equal(devin.name, "Devin");
  assert.equal(devin.weekly.remainingPct, 70);
  assert.match(ctx.markup(oc), /fill-opacity="0\.3"/, "OpenCode Go uses geometric frame logo SVG");
  assert.match(ctx.markup(devin), /<polygon points="7\.8,1\.4/, "Devin uses authentic 3-hexagon cluster logo SVG");
});

test("externalQuotaProviders merges Devin weekly+daily rings and renders Daily (inner) card label", () => {
  const ctx = vm.createContext({
    readLiveT3State: () => ctx.live,
    formatResetShort: (v) => v || null,
    escapeHtml: (v) => String(v).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;"),
    hudLang: "zh",
    externalQuotaProviders: [
      {
        instanceId: "acpRegistry_devin",
        driver: "devin",
        displayName: "Devin · Pro",
        usageLimits: {
          windows: [
            { id: "devin-weekly", kind: "weekly", label: "Weekly", windowDurationMins: 10080, usedPercent: 21, resetsAt: "4d" },
            { id: "devin-daily", kind: "daily", label: "Daily", windowDurationMins: 1440, usedPercent: 10, resetsAt: "8h" },
          ],
        },
      },
    ],
  });
  vm.runInContext(
    `${sliceBetween("  const quotaBurnSamples = new Map();", "  function formatContextPair(")}\n` +
    `${sliceBetween("  function renderQuotaRingCardHtml(", "  function renderQuotaRingPopover(")}\n` +
    `this.compute = computeQuotaAndContext; this.card = renderQuotaRingCardHtml;`,
    ctx
  );
  ctx.live = { selectedProvider: "antigravity", selectedModel: "gemini-4-neon", usage: { providers: [] } };
  const out = JSON.parse(JSON.stringify(ctx.compute({ ok: true, provider: "antigravity", tokens: {}, cache: {} })));
  assert.equal(out.providerQuotas.length, 1);
  assert.equal(out.providerQuotas[0].name, "Devin · Pro");
  assert.equal(out.providerQuotas[0].weekly.remainingPct, 79);
  assert.equal(out.providerQuotas[0].fiveHour.remainingPct, 90);
  const html = ctx.card(out.providerQuotas[0]);
  assert.match(html, /Devin · Pro/);
  assert.match(html, /周额度（外圈）/);
  assert.match(html, /日额度（内圈）/);
});
