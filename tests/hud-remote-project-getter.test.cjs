"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const src = fs.readFileSync(path.join(__dirname, "../src/renderer-ui.js"), "utf8");
const start = src.indexOf("  function getHudRemoteProject(");
const end = src.indexOf("  function fallbackModelRate(", start);
assert.ok(start >= 0 && end > start, "scoped remote project getter missing");
const envA = "11111111-1111-4111-8111-111111111111", envB = "22222222-2222-4222-8222-222222222222";
function fixture(props, route = `/${envA}/thread-a`) {
  const committed = { memoizedProps: props };
  const root = { __reactContainer$fixture: { stateNode: { current: committed } } };
  const ctx = vm.createContext({ document: { getElementById: () => root }, getRouteHint: () => route,
    extractLastThreadIdFromHint: (hint) => decodeURIComponent(hint.split("/").at(-1)) });
  vm.runInContext(src.slice(start, end) + "\nthis.get=getHudRemoteProject;", ctx);
  return { ctx, committed, setRoute: value => { route = value; } };
}
const valid = { environmentId: envA, threadId: "thread-a", isServerThread: true, gitCwd: "/remote/project" };
function result(f, environmentId = envA, threadId = "thread-a") {
  return JSON.parse(JSON.stringify(f.ctx.get({ environmentId, threadId })));
}

test("getter returns only the route-bound Fiber cwd without telemetry or backend availability", () => {
  const f = fixture(valid);
  assert.deepEqual(result(f), { environmentId: envA, threadId: "thread-a", projectRoot: "/remote/project" });
});

test("route and caller must both match environment and thread exactly", () => {
  const f = fixture(valid);
  assert.equal(result(f, envB), null);
  assert.equal(result(f, envA, "thread-b"), null);
  f.setRoute(`/${envB}/thread-a`); assert.equal(result(f), null);
  f.setRoute(`/${envA}/thread-b`); assert.equal(result(f), null);
  f.setRoute("/draft/other"); assert.equal(result(f), null);
});

test("a matching thread without matching original environment or cwd is not accepted", () => {
  for (const props of [{ ...valid, environmentId: envB }, { ...valid, environmentId: "" }, { ...valid, threadId: "" }, { ...valid, isServerThread: false }, { ...valid, gitCwd: "relative/path" }, { ...valid, gitCwd: "/safe/../other" }]) {
    assert.equal(result(fixture(props)), null);
  }
});

test("only committed Fiber is inspected, never the stale alternate", () => {
  const f = fixture({ ...valid, environmentId: envB });
  f.committed.alternate = { memoizedProps: valid };
  assert.equal(result(f), null);
});

test("getter is installed and removed only if it is still the same function", () => {
  assert.match(src, /window\.__t3HudRemoteProject\s*=\s*getHudRemoteProject/);
  assert.match(src, /if\s*\(window\.__t3HudRemoteProject\s*===\s*getHudRemoteProject\)\s*delete window\.__t3HudRemoteProject/);
});
