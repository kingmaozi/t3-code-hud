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
