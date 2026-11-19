"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const embed = require("../src/embed-manager.cjs");

const health = { ok: true, modelId: "vendor/current-model", servedName: "current-model", dim: 3 };
const vector = { object: "list", model: "current-model", data: [{ index: 0, embedding: [0.1, -0.2, 0.3] }] };
const reply = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
function makeManager(t, fetch, config = { mode: "mlx", modelId: "old-config-model" }, opts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t3-embed-probe-"));
  fs.writeFileSync(path.join(tmp, "embed-config.json"), JSON.stringify(config));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  return embed.createEmbedManager({ homeDir: tmp, hubDir: tmp, port: 18230, launchAgentPlistPath: null, _fetch: fetch, _probeTimeoutMs: 200, ...opts });
}

test("exports a probe and checks the active local model with only a fixed short input", async (t) => {
  assert.equal(typeof embed.testEmbedding, "function");
  const requests = [];
  const mgr = makeManager(t, async (url, options) => {
    requests.push({ url, options });
    return reply(url.endsWith("/health") ? health : vector);
  });
  const result = await mgr.testEmbedding();
  assert.equal(result.ok, true);
  assert.equal(result.modelId, "vendor/current-model");
  assert.equal(result.dimensions, 3);
  assert.ok(Number.isFinite(result.latencyMs) && result.latencyMs >= 0);
  assert.deepEqual(requests.map((r) => r.url), ["http://127.0.0.1:18230/health", "http://127.0.0.1:18230/v1/embeddings"]);
  assert.equal(requests[1].options.method, "POST");
  const payload = JSON.parse(requests[1].options.body);
  assert.deepEqual(payload, { input: ["T3 Hub embedding connectivity test."], input_type: "query" });
  assert.equal(Object.hasOwn(payload, "model"), false);
});

test("FTS mode without a running vector service is explicitly unavailable", async (t) => {
  const requests = [];
  const mgr = makeManager(t, async (url) => { requests.push(url); throw new Error("unreachable"); }, { mode: "fts5", modelId: "fts5-zero-ram" });
  const result = await mgr.testEmbedding();
  assert.equal(result.ok, false);
  assert.equal(result.error, "fts_unavailable");
  assert.equal(result.modelId, null);
  assert.equal(result.dimensions, null);
  assert.equal(requests.length, 1);
  assert.match(requests[0], /\/health$/);
});

test("an actually running model can be tested even when saved mode is FTS", async (t) => {
  const mgr = makeManager(t, async (url) => reply(url.endsWith("/health") ? health : vector), { mode: "fts5", modelId: "fts5-zero-ram" });
  const result = await mgr.testEmbedding();
  assert.equal(result.ok, true);
  assert.equal(result.modelId, "vendor/current-model");
});

test("rejects empty, all-zero, non-finite, malformed and multi-item vectors", async (t) => {
  const malformed = [[], [0, 0, -0], [NaN], [Infinity], ["1"], null, { 0: 0.1 }];
  for (const candidate of malformed) {
    const mgr = makeManager(t, async (url) => reply(url.endsWith("/health") ? health : { ...vector, data: [{ index: 0, embedding: candidate }] }));
    const result = await mgr.testEmbedding();
    assert.equal(result.ok, false, String(candidate));
    assert.equal(result.error, "invalid_response");
    assert.equal(result.dimensions, null);
  }
  const mgr = makeManager(t, async (url) => reply(url.endsWith("/health") ? health : { ...vector, data: [...vector.data, ...vector.data] }));
  assert.equal((await mgr.testEmbedding()).error, "invalid_response");
});

test("fails safely if the server switches model or its response fails", async (t) => {
  const switched = makeManager(t, async (url) => reply(url.endsWith("/health") ? health : { ...vector, model: "other-model" }));
  assert.equal((await switched.testEmbedding()).error, "model_changed");
  const failed = makeManager(t, async (url) => url.endsWith("/health") ? reply(health) : reply({ error: { message: "bad" } }, 503));
  assert.equal((await failed.testEmbedding()).error, "service_unavailable");
});

test("entire probe has a deadline even if an implementation ignores abort", async (t) => {
  let signal;
  const mgr = makeManager(t, async (_url, options) => { signal = options.signal; return new Promise(() => {}); }, { mode: "mlx" }, { _probeTimeoutMs: 30 });
  const start = Date.now();
  const result = await mgr.testEmbedding();
  assert.equal(result.ok, false);
  assert.equal(result.error, "timeout");
  assert.equal(signal.aborted, true);
  assert.ok(Date.now() - start < 1000);
});

test("a health response that arrives after timeout cannot start an embedding request", async (t) => {
  let finishHealth, calls = 0;
  const delayed = new Promise((resolve) => { finishHealth = resolve; });
  const mgr = makeManager(t, async () => { calls++; return delayed; }, { mode: "mlx" }, { _probeTimeoutMs: 25 });
  const result = await mgr.testEmbedding();
  assert.equal(result.error, "timeout");
  finishHealth(reply(health));
  await new Promise(setImmediate);
  assert.equal(calls, 1);
});

test("concurrent clicks share one probe and a later click can retry", async (t) => {
  let healthCalls = 0, vectorCalls = 0, finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  const mgr = makeManager(t, async (url) => {
    if (url.endsWith("/health")) { healthCalls++; return reply(health); }
    vectorCalls++;
    await gate;
    return reply(vector);
  });
  const probes = [mgr.testEmbedding(), mgr.testEmbedding(), mgr.testEmbedding()];
  await new Promise(setImmediate);
  assert.equal(healthCalls, 1);
  assert.equal(vectorCalls, 1);
  finish();
  const results = await Promise.all(probes);
  assert.ok(results.every((r) => r.ok));
  await mgr.testEmbedding();
  assert.equal(healthCalls, 2);
  assert.equal(vectorCalls, 2);
});
