"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createDevinQuotaReader, parseCredentialsToml, normalizeDevinStatusResponse } = require("../src/hub-devin-quota.cjs");

test("Devin quota reader skips network when credentials missing or provider disabled in T3", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3-devin-q-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  let calls = 0;
  const reader = createDevinQuotaReader({
    homeDir: home,
    postJson: async () => { calls++; return {}; },
  });

  const r1 = await reader.readDevinQuota();
  assert.equal(r1.ok, true);
  assert.equal(r1.available, false);
  assert.equal(calls, 0, "Zero network calls without credentials.toml");

  // Create credentials.toml but disable acpRegistry_devin in T3 settings
  const devinDir = path.join(home, ".local", "share", "devin");
  fs.mkdirSync(devinDir, { recursive: true });
  fs.writeFileSync(path.join(devinDir, "credentials.toml"), 'windsurf_api_key = "sk-ws-secret-123"\napi_server_url = "https://server.codeium.com"\n');
  const t3Dir = path.join(home, ".t3", "userdata");
  fs.mkdirSync(t3Dir, { recursive: true });
  fs.writeFileSync(path.join(t3Dir, "settings.json"), JSON.stringify({ providers: { acpRegistry_devin: { enabled: false } } }));

  const r2 = await reader.readDevinQuota({ force: true });
  assert.equal(r2.available, false);
  assert.equal(r2.reason, "disabled");
  assert.equal(calls, 0, "Zero network calls when Devin disabled in T3");
});

test("Devin quota reader parses weekly/daily quota, caches for 120s, backs off on errors, and never leaks secrets", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3-devin-q2-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const devinDir = path.join(home, ".local", "share", "devin");
  fs.mkdirSync(devinDir, { recursive: true });
  fs.writeFileSync(path.join(devinDir, "credentials.toml"), 'windsurf_api_key = "sk-ws-super-secret-value"\napi_server_url = "https://server.codeium.com"\n');

  let clock = 1_700_000_000_000;
  let calls = 0;
  const reader = createDevinQuotaReader({
    homeDir: home,
    checkT3Enabled: false,
    now: () => clock,
    postJson: async (url, body) => {
      calls++;
      assert.match(url, /SeatManagementService\/GetUserStatus$/);
      assert.equal(body.metadata.api_key, "sk-ws-super-secret-value");
      return {
        userStatus: {
          email: "private@example.com",
          planStatus: {
            planInfo: { planName: "Pro", isDevin: true, billingStrategy: "BILLING_STRATEGY_QUOTA" },
            weeklyQuotaRemainingPercent: 79,
            dailyQuotaRemainingPercent: 100,
            weeklyQuotaResetAtUnix: "1795334400",
            dailyQuotaResetAtUnix: "1795334400",
          },
        },
      };
    },
  });

  const first = await reader.readDevinQuota();
  assert.equal(first.ok, true);
  assert.equal(first.available, true);
  assert.equal(first.provider.instanceId, "acpRegistry_devin");
  assert.equal(first.provider.displayName, "Devin · Pro");
  assert.equal(first.provider.usageLimits.windows.length, 2);
  assert.equal(first.provider.usageLimits.windows[0].usedPercent, 21);
  assert.equal(first.provider.usageLimits.windows[1].usedPercent, 0);
  assert.doesNotMatch(JSON.stringify(first), /super-secret|private@example/, "Zero secrets or PII leaked");

  // Cached hit within 120s
  clock += 30_000;
  const second = await reader.readDevinQuota();
  assert.equal(second.cached, true);
  assert.equal(calls, 1);

  // After TTL expires, refreshes
  clock += 100_000;
  const third = await reader.readDevinQuota();
  assert.equal(third.cached, false);
  assert.equal(calls, 2);
});

test("normalizeDevinStatusResponse supports Enterprise monthlyPromptCredits fallback and rejects invalid percentages", () => {
  const ent = normalizeDevinStatusResponse({
    userStatus: {
      planStatus: {
        planInfo: { planName: "Enterprise", monthlyPromptCredits: 1000 },
        availablePromptCredits: 350,
        planEnd: "2026-12-01T00:00:00Z",
      },
    },
  });
  assert.equal(ent.displayName, "Devin · Enterprise");
  assert.equal(ent.usageLimits.windows[0].kind, "monthly");
  assert.equal(ent.usageLimits.windows[0].usedPercent, 65);

  assert.equal(normalizeDevinStatusResponse({ userStatus: { planStatus: { weeklyQuotaRemainingPercent: 150 } } }), null);
  assert.equal(parseCredentialsToml('api_server_url = "https://server.codeium.com"'), null);
});
