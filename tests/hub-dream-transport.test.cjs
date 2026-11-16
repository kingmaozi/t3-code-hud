"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const REPO = path.resolve(__dirname, "..");
const rendererSource = fs.readFileSync(path.join(REPO, "src", "renderer-ui.js"), "utf8");
const start = rendererSource.indexOf("window.__t3HubRpc = async");
const end = rendererSource.indexOf("\n  };", start);
assert.ok(start >= 0 && end > start, "Hub RPC dispatcher found");
const dispatcherSource = rendererSource.slice(start, end + "\n  };".length);

function createDispatcher({ bridge, callRpc, fetch, language = "zh" } = {}) {
  const sandbox = {
    window: bridge === undefined ? {} : { __t3HubSidecarBridge: bridge },
    callRpc: callRpc || (async () => ({ ok: true, via: "main" })),
    fetch: fetch || (async () => ({ ok: true, json: async () => ({ ok: true, via: "sidecar" }) })),
    hudLang: language,
  };
  vm.createContext(sandbox);
  vm.runInContext(dispatcherSource, sandbox);
  return sandbox.window.__t3HubRpc;
}

test("AutoDream get/save/run use only the authenticated sidecar", async () => {
  const actions = [];
  let mainCalls = 0;
  const rpc = createDispatcher({
    bridge: { url: "http://127.0.0.1:43123", token: "sidecar-token" },
    callRpc: async () => { mainCalls++; return { ok: true, via: "main" }; },
    fetch: async (url, options) => {
      assert.equal(url, "http://127.0.0.1:43123/hub-rpc");
      assert.equal(options.headers["X-T3-Hud-Token"], "sidecar-token");
      const request = JSON.parse(options.body);
      actions.push(request.action);
      return { ok: true, json: async () => ({ ok: true, via: "sidecar", action: request.action }) };
    },
  });

  for (const action of ["memory:dream:get", "memory:dream:save", "memory:dream:update", "memory:dream:run"]) {
    const result = await rpc(action, { marker: action });
    assert.equal(result.via, "sidecar");
    assert.equal(result.action, action);
  }
  assert.deepEqual(actions, ["memory:dream:get", "memory:dream:save", "memory:dream:update", "memory:dream:run"]);
  assert.equal(mainCalls, 0, "dream actions must never enter the T3 main-process RPC");
});

test("missing or unreachable sidecar returns the actual error without main-process retry", async (t) => {
  let mainCalls = 0, fetchCalls = 0;
  const missing = createDispatcher({ callRpc: async () => { mainCalls++; return { ok: true }; } });
  const missingResult = await missing("memory:dream:get", {});
  assert.equal(missingResult.ok, false);
  assert.match(missingResult.error, /梦境服务未连接/);
  assert.equal(mainCalls, 0);

  const missingEnglish = createDispatcher({ language: "en" });
  assert.match((await missingEnglish("memory:dream:get", {})).error, /Dream service is not connected/);

  let sidecarExecutions = 0;
  const unreachable = createDispatcher({
    bridge: { url: "http://127.0.0.1:43123", token: "sidecar-token" },
    callRpc: async () => { mainCalls++; return { ok: true, via: "main" }; },
    fetch: async () => {
      fetchCalls++;
      sidecarExecutions++; // The sidecar accepted and executed the request before its reply was lost.
      const error = new Error("socket closed after response was lost");
      error.code = "ECONNRESET";
      throw error;
    },
  });
  const unreachableResult = await unreachable("memory:dream:run", {});
  assert.equal(unreachableResult.ok, false);
  assert.equal(unreachableResult.status, "unknown");
  assert.match(unreachableResult.error, /整理结果暂无法确认/);
  assert.match(unreachableResult.error, /ECONNRESET/);
  assert.match(unreachableResult.error, /查看最近记录/);
  assert.equal(sidecarExecutions, 1, "the simulated sidecar executed exactly one run");
  assert.equal(fetchCalls, 1, "only one sidecar request is made");
  assert.equal(mainCalls, 0, "an ambiguous run must never retry through the main process");
});

test("other Hub actions keep the existing main-first then sidecar fallback order", async () => {
  let mainCalls = 0, fetchCalls = 0;
  const modern = createDispatcher({
    bridge: { url: "http://127.0.0.1:43123", token: "sidecar-token" },
    callRpc: async () => { mainCalls++; return { ok: true, via: "main" }; },
    fetch: async () => { fetchCalls++; throw new Error("must not fetch"); },
  });
  assert.equal((await modern("memory:save", {})).via, "main");
  assert.equal(mainCalls, 1);
  assert.equal(fetchCalls, 0);

  const legacy = createDispatcher({
    bridge: { url: "http://127.0.0.1:43123", token: "sidecar-token" },
    callRpc: async () => { mainCalls++; return { ok: false, error: "unknown action: plugins:list" }; },
    fetch: async () => { fetchCalls++; return { ok: true, json: async () => ({ ok: true, via: "sidecar" }) }; },
  });
  assert.equal((await legacy("plugins:list", {})).via, "sidecar");
  assert.equal(mainCalls, 2);
  assert.equal(fetchCalls, 1);
});

test("HTTP and invalid-JSON run responses are unknown and never retry", async () => {
  let mainCalls = 0, httpFetchCalls = 0, httpSidecarExecutions = 0;
  const httpRpc = createDispatcher({
    bridge: { url: "http://127.0.0.1:43123", token: "sidecar-token" },
    callRpc: async () => { mainCalls++; return { ok: true, via: "main" }; },
    fetch: async () => {
      httpFetchCalls++;
      httpSidecarExecutions++;
      return { ok: false, status: 503, json: async () => ({ ok: false, error: "dream backend unavailable" }) };
    },
  });
  const httpUnknown = await httpRpc("memory:dream:run", {});
  assert.equal(httpUnknown.ok, false);
  assert.equal(httpUnknown.status, "unknown");
  assert.match(httpUnknown.error, /整理结果暂无法确认/);
  assert.match(httpUnknown.error, /HTTP 503/);
  assert.equal(httpFetchCalls, 1);
  assert.equal(httpSidecarExecutions, 1);

  let jsonFetchCalls = 0, jsonSidecarExecutions = 0;
  const invalidJsonRpc = createDispatcher({
    bridge: { url: "http://127.0.0.1:43123", token: "sidecar-token" },
    callRpc: async () => { mainCalls++; return { ok: true, via: "main" }; },
    fetch: async () => {
      jsonFetchCalls++;
      jsonSidecarExecutions++; // The handler ran, but its response body cannot be decoded.
      return { ok: true, status: 200, json: async () => { throw new SyntaxError("invalid JSON"); } };
    },
  });
  const invalidJson = await invalidJsonRpc("memory:dream:run", {});
  assert.equal(invalidJson.ok, false);
  assert.equal(invalidJson.status, "unknown");
  assert.match(invalidJson.error, /整理结果暂无法确认/);
  assert.match(invalidJson.error, /HTTP 200, invalid JSON/);
  assert.equal(jsonFetchCalls, 1);
  assert.equal(jsonSidecarExecutions, 1);
  assert.equal(mainCalls, 0);
});
