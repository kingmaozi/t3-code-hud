"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../src/renderer-ui.js"), "utf8");

function sourceBetween(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first);
  return source.slice(first, last);
}

function createFooter(rpc, lang = "zh") {
  const document = { activeElement: null };
  const window = { __t3HubRpc: rpc, __t3HudReleaseVersion: "1.0.9" };
  const controls = {};
  const makeButton = action => ({
    hidden: action === "apply",
    attributes: {},
    closest: () => controls[action],
    getAttribute: () => action,
    setAttribute(name, value) { this.attributes[name] = value; },
    focus() { document.activeElement = this; },
  });
  const popover = {
    style: {},
    classList: { contains: key => key === "visible" },
    set innerHTML(value) {
      this.markup = value;
      controls.check = value.includes('data-t3-hud-update="check"') ? makeButton("check") : null;
      controls.apply = value.includes('data-t3-hud-update="apply"') ? makeButton("apply") : null;
      controls.status = value.includes("data-t3-hud-update-status") ? { textContent: "" } : null;
      controls.releases = value.includes("data-t3-hud-update-release") ? { hidden: true } : null;
    },
    querySelector(selector) {
      switch (selector) {
        case '[data-t3-hud-update="check"]': return controls.check;
        case '[data-t3-hud-update="apply"]': return controls.apply;
        case "[data-t3-hud-update-status]": return controls.status;
        case "[data-t3-hud-update-release]": return controls.releases;
        default: return null;
      }
    },
  };
  const sandbox = {
    document, window, popover, hudLang: lang,
    latestStats: null, disposed: false, currentPopoverMode: "stats", hudUpdateState: {},
    langSwitchLabel: () => "EN",
    computeQuotaAndContext: () => ({ currentWindows: [], otherWindows: [] }),
  };
  vm.runInNewContext(
    sourceBetween("  function escapeHtml(", "  // Bilingual i18n") +
    sourceBetween("  const I18N = {", "  let hudLang = null;") +
    sourceBetween("  function t(key)", "  function detectLangFromDom(") +
    sourceBetween("  function syncHudUpdateFooter(", "  function showPopoverAbove("),
    sandbox,
  );
  return {
    controls,
    window,
    popover,
    render: sandbox.renderStatsPopover,
    click: (action) => sandbox.onHudUpdateClick({ target: controls[action], stopPropagation() {} }),
  };
}

test("the stats footer reports the injected version without making a network request on render", () => {
  const calls = [];
  const footer = createFooter((...args) => calls.push(args), "en");
  footer.render();
  assert.match(footer.popover.markup, /HUD version/);
  assert.match(footer.popover.markup, /v1\.0\.9/);
  assert.match(footer.popover.markup, /Check for updates/);
  assert.equal(footer.controls.apply.hidden, true);
  assert.equal(footer.controls.releases.hidden, true);
  assert.deepEqual(calls, []);

  delete footer.window.__t3HudReleaseVersion;
  footer.render();
  assert.equal(footer.controls.check, null);
  assert.deepEqual(calls, []);
});

test("checking and applying require separate clicks and ignore repeat activation while requests are pending", async () => {
  const calls = [];
  const checkResult = Promise.withResolvers();
  const applyResult = Promise.withResolvers();
  const footer = createFooter((action, payload) => {
    calls.push([action, { ...payload }]);
    return action.endsWith(":check") ? checkResult.promise : applyResult.promise;
  });
  footer.render();

  const pendingCheck = footer.click("check");
  assert.equal(footer.controls.status.textContent, "正在检查更新…");
  assert.equal(footer.controls.check.attributes["aria-disabled"], "true");
  await footer.click("check");
  await footer.click("apply");
  assert.deepEqual(calls, [["hub:update:check", {}]]);
  checkResult.resolve({ ok: true, status: "available", currentVersion: "1.0.9", availableVersion: "1.0.10" });
  await pendingCheck;

  footer.render();
  assert.equal(footer.controls.apply.hidden, false);
  assert.equal(footer.controls.apply.textContent, "更新至 v1.0.10");
  assert.equal(footer.controls.check.attributes["aria-disabled"], "false");
  assert.deepEqual(calls, [["hub:update:check", {}]]);

  const pendingApply = footer.click("apply");
  footer.render();
  assert.equal(footer.controls.status.textContent, "正在安装更新…");
  assert.equal(footer.controls.apply.attributes["aria-disabled"], "true");
  await footer.click("apply");
  await footer.click("check");
  assert.deepEqual(calls, [["hub:update:check", {}], ["hub:update:apply", { expectedVersion: "1.0.10" }]]);
  applyResult.resolve({ ok: true, status: "updated", currentVersion: "1.0.10" });
  await pendingApply;
  assert.equal(footer.controls.status.textContent, "已更新至 v1.0.10");
  assert.equal(footer.controls.apply.hidden, true);
  assert.equal(footer.window.__t3HudReleaseVersion, "1.0.9", "only the injected renderer controls its version label");
});

test("current, unsupported and unknown install results do not leave an active update button", async () => {
  const replies = [
    { ok: true, status: "current", currentVersion: "1.0.9" },
    { ok: true, status: "unsupported", currentVersion: "1.0.9" },
    { ok: true, status: "available", currentVersion: "1.0.9", availableVersion: "1.0.10" },
  ];
  const footer = createFooter(async (action) => {
    if (action === "hub:update:apply") throw new TypeError("connection dropped");
    return replies.shift();
  }, "en");
  footer.render();
  await footer.click("check");
  assert.equal(footer.controls.status.textContent, "Up to date");
  assert.equal(footer.controls.apply.hidden, true);

  await footer.click("check");
  assert.match(footer.controls.status.textContent, /no compatible update package/);
  assert.equal(footer.controls.apply.hidden, true);
  assert.equal(footer.controls.releases.hidden, false);
  assert.match(footer.popover.markup, /href="https:\/\/github\.com\/kingmaozi\/t3-code-hud\/releases"/);

  await footer.click("check");
  await footer.click("apply");
  assert.match(footer.controls.status.textContent, /Update result unconfirmed/);
  assert.equal(footer.controls.apply.hidden, true);
  await footer.click("apply");
  assert.match(footer.controls.status.textContent, /Update result unconfirmed/);
});

test("an interrupted update offers a localized recovery and applies only the reported version on click", async () => {
  for (const [locale, actionLabel, resultLabel] of [
    ["zh", "恢复上次更新", "已恢复上次更新。"],
    ["en", "Recover interrupted update", "The interrupted update was recovered."],
  ]) {
    const calls = [];
    const footer = createFooter(async (action, payload) => {
      calls.push([action, { ...payload }]);
      if (action.endsWith(":check")) {
        return { ok: true, status: "recoverable", currentVersion: "1.0.9", availableVersion: "1.0.9" };
      }
      return { ok: true, status: "current", currentVersion: "1.0.9" };
    }, locale);
    footer.render();
    await footer.click("check");
    assert.equal(footer.controls.apply.hidden, false);
    assert.equal(footer.controls.apply.textContent, actionLabel);
    assert.deepEqual(calls, [["hub:update:check", {}]]);

    await footer.click("apply");
    assert.deepEqual(calls, [["hub:update:check", {}], ["hub:update:apply", { expectedVersion: "1.0.9" }]]);
    assert.equal(footer.controls.status.textContent, resultLabel);
    assert.equal(footer.controls.apply.hidden, true);
  }
});

test("the mutating RPC sends one authenticated local request even if a response is lost", async () => {
  const requests = [];
  const window = {
    __t3HudHttpConfig: { url: "http://127.0.0.1:43210", token: "fixture" },
    __t3HudOverrideRpc: { url: "http://127.0.0.1:43211", token: "override" },
    __t3HubSidecarBridge: { url: "http://127.0.0.1:43212", token: "sidecar" },
  };
  vm.runInNewContext(sourceBetween("  window.__t3HubRpc = async", "  function formatCompactTokens("), {
    window,
    callRpc: () => assert.fail("applying must not call the generic RPC transport"),
    fetch: async (url, options) => {
      requests.push({ url, ...options });
      throw new TypeError("connection dropped");
    },
  });
  await assert.rejects(window.__t3HubRpc("hub:update:apply", { expectedVersion: "1.0.10" }), /connection dropped/);
  assert.equal(requests.length, 1);
  const [{ url, method, headers, body, redirect }] = requests;
  assert.equal(url, "http://127.0.0.1:43210/rpc");
  assert.equal(method, "POST");
  assert.equal(headers["X-T3-Hud-Token"], "fixture");
  assert.equal(redirect, "error");
  assert.deepEqual(JSON.parse(body), { method: "hubCall", args: ["hub:update:apply", { expectedVersion: "1.0.10" }] });

  window.__t3HudHttpConfig.url = "https://example.com";
  const unavailable = await window.__t3HubRpc("hub:update:apply", { expectedVersion: "1.0.10" });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.code, "HUD_UNAVAILABLE");
  assert.equal(requests.length, 1);
});

test("renderer update footer syncs bidirectionally via t3-hud-update-state without extra RPCs", async () => {
  const dispatched = [];
  const calls = [];
  const document = { activeElement: null };
  const window = {
    __t3HubRpc: async (action, payload) => {
      calls.push([action, { ...payload }]);
      return {
        ok: true, status: "available", currentVersion: "1.0.9", availableVersion: "1.0.11",
        releaseUrl: "https://github.com/kingmaozi/t3-code-hud/releases/tag/v1.0.11",
      };
    },
    __t3HudReleaseVersion: "1.0.9",
    dispatchEvent(evt) { dispatched.push(evt); },
  };
  const controls = {};
  const makeButton = action => ({
    hidden: action === "apply",
    attributes: {},
    closest: () => controls[action],
    getAttribute: () => action,
    setAttribute(name, value) { this.attributes[name] = value; },
    focus() { document.activeElement = this; },
  });
  const popover = {
    style: {},
    classList: { contains: key => key === "visible" },
    set innerHTML(value) {
      this.markup = value;
      controls.check = value.includes('data-t3-hud-update="check"') ? makeButton("check") : null;
      controls.apply = value.includes('data-t3-hud-update="apply"') ? makeButton("apply") : null;
      controls.status = value.includes("data-t3-hud-update-status") ? { textContent: "" } : null;
      controls.releases = value.includes("data-t3-hud-update-release") ? { hidden: true } : null;
    },
    querySelector(selector) {
      switch (selector) {
        case '[data-t3-hud-update="check"]': return controls.check;
        case '[data-t3-hud-update="apply"]': return controls.apply;
        case "[data-t3-hud-update-status]": return controls.status;
        case "[data-t3-hud-update-release]": return controls.releases;
        default: return null;
      }
    },
  };
  const sandbox = {
    document, window, popover, hudLang: "zh",
    latestStats: null, disposed: false, currentPopoverMode: "stats", hudUpdateState: {},
    CustomEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
    langSwitchLabel: () => "EN",
    computeQuotaAndContext: () => ({ currentWindows: [], otherWindows: [] }),
  };
  vm.runInNewContext(
    sourceBetween("  function escapeHtml(", "  // Bilingual i18n") +
    sourceBetween("  const I18N = {", "  let hudLang = null;") +
    sourceBetween("  function t(key)", "  function detectLangFromDom(") +
    sourceBetween("  function syncHudUpdateFooter(", "  function showPopoverAbove("),
    sandbox,
  );
  sandbox.renderStatsPopover();
  assert.equal(calls.length, 0);

  // Incoming state from drawer updates footer without RPC
  sandbox.onExternalHudUpdateState({
    detail: { source: "drawer", busy: false, status: "available", availableVersion: "1.0.10", currentVersion: "1.0.9" },
  });
  assert.equal(controls.apply.hidden, false);
  assert.equal(controls.apply.textContent, "更新至 v1.0.10");
  assert.equal(controls.status.textContent, "有可用更新");
  assert.equal(calls.length, 0);

  // Own-source events are ignored
  sandbox.onExternalHudUpdateState({
    detail: { source: "renderer", busy: false, status: "current", currentVersion: "1.0.9" },
  });
  assert.equal(controls.apply.hidden, false);

  // Clicking check broadcasts busy + final state with source: "renderer"
  await sandbox.onHudUpdateClick({ target: controls.check, stopPropagation() {} });
  assert.equal(dispatched.length, 2);
  assert.equal(dispatched[0].type, "t3-hud-update-state");
  assert.equal(dispatched[0].detail.source, "renderer");
  assert.equal(dispatched[0].detail.busy, true);
  assert.equal(dispatched[1].detail.source, "renderer");
  assert.equal(dispatched[1].detail.busy, false);
  assert.equal(dispatched[1].detail.status, "available");
  assert.equal(dispatched[1].detail.availableVersion, "1.0.11");
});
