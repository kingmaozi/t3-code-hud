"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../src/renderer-ui.js"), "utf8");
function fn(name) {
  const match = source.match(new RegExp(`  (?:async )?function ${name}\\([^]*?\\n  \\}`));
  assert.ok(match, `missing ${name}`);
  return match[0];
}
function fixture({ stored, fiber, fiberKey = "__reactContainer$test", storageError = false, hash = "#/draft/draft-a", routerPath = null } = {}) {
  const root = fiber ? { [fiberKey]: fiber } : null;
  const router = { state: { location: { pathname: routerPath } } };
  const ctx = vm.createContext({
    window: { location: { hash, pathname: "/" } },
    localStorage: { getItem(key) { assert.equal(key, "t3code:composer-drafts:v1"); if (storageError) throw Error("denied"); return stored === undefined ? null : typeof stored === "string" ? stored : JSON.stringify(stored); } },
    document: { getElementById: () => root },
    findTanStackRouter: () => router, getRouterPathname: value => value?.state?.location?.pathname || null,
  });
  vm.runInContext(fn("resolvePromotedDraftRoute") + "\n" + fn("getRouteHint"), ctx);
  return { ctx, router, setRouterPath: pathname => { router.state.location.pathname = pathname; }, resolve: route => ctx.resolvePromotedDraftRoute(route), route: () => ctx.getRouteHint() };
}
const ref = { environmentId: "env-a", threadId: "thread:server-a" };
for (const sourceKey of ["promotedDraftRedirects", "drafts", "draftThreadsByThreadKey"]) {
  for (const versioned of [true, false]) test(`${sourceKey} resolves ${versioned ? "v9 persisted" : "unwrapped"} promotion on unchanged hash`, () => {
    const state = { [sourceKey]: { "draft-a": sourceKey === "promotedDraftRedirects" ? ref : { promotedTo: ref } } };
    const f = fixture({ stored: versioned ? { version: 9, state } : state });
    assert.equal(f.route(), "/_t3_env_/env-a/thread%3Aserver-a");
    assert.equal(f.ctx.window.location.hash, "#/draft/draft-a");
  });
}
test("an unpromoted draft never inherits other draft/server telemetry", () => {
  const f = fixture({ stored: { state: { promotedDraftRedirects: { other: ref }, draftThreadsByThreadKey: { "draft-a": { ...ref, promotedTo: null } } } }, fiber: { memoizedProps: { draftId: "other", isServerThread: true, threadRef: ref }, child: { memoizedProps: { draftId: "draft-a", isServerThread: false, threadRef: ref } } } });
  assert.equal(f.route(), "__NEW__");
});
test("decoded draft ids, optional environment, invalid redirects and malformed encoding stay safe", () => {
  const f = fixture({ stored: { promotedDraftRedirects: { "draft a": { threadId: "thread:one" }, "%broken": ref, "draft-a": { threadId: ".." } } } });
  assert.equal(f.resolve("/draft/draft%20a?x=1"), "/thread%3Aone");
  assert.equal(f.resolve("/draft/%broken"), "__ROUTE_invalid__");
  assert.equal(f.resolve("/draft/draft-a"), "__NEW__");
  assert.equal(f.resolve("/draft/"), "__NEW__");
  for (const route of ["/thread:one", "/settings", "/draftish/a", "__NEW__", "__ROUTE_invalid__"]) assert.equal(f.resolve(route), route);
});
for (const props of [
  { threadRef: ref }, { activeThreadKey: ref }, { activeThreadKey: "thread:server-a", environmentId: "env-a" }, { thread: { id: ref.threadId }, environmentId: "env-a" }, ref,
]) test(`mounted same-draft Fiber resolves promotion (${Object.keys(props)[0]})`, () => {
  const active = { memoizedProps: { draftId: "draft-a", isServerThread: true, ...props } };
  const stale = { memoizedProps: { draftId: "draft-a", isServerThread: true, threadRef: { threadId: "thread:stale" } } };
  const f = fixture({ storageError: true, fiber: { stateNode: { current: { child: active } }, alternate: stale } });
  assert.equal(f.route(), "/_t3_env_/env-a/thread%3Aserver-a");
});
test("Fiber fallback survives malformed storage and is bounded even with cycles", () => {
  const first = {}; let last = first;
  for (let i = 0; i < 405; i++) { last.child = {}; last = last.child; }
  last.memoizedProps = { draftId: "draft-a", isServerThread: true, threadRef: ref };
  last.child = first;
  assert.equal(fixture({ stored: "{", fiber: first }).route(), "__NEW__");
  assert.equal(fixture({ stored: "{", fiber: { memoizedProps: { draftId: "draft-a", isServerThread: true, threadRef: ref } } }).route(), "/_t3_env_/env-a/thread%3Aserver-a");
});
for (const promoted of [true, false]) test(`child Fiber expando climbs to committed tree (promoted=${promoted})`, () => {
  const stale = { memoizedProps: { draftId: "draft-a", isServerThread: true, threadRef: { ...ref, threadId: "thread:stale" } } };
  const committed = { child: { memoizedProps: { draftId: "draft-a", isServerThread: promoted, threadRef: ref } } };
  const hostRoot = { stateNode: { current: committed }, child: stale };
  stale.return = { return: hostRoot };
  const f = fixture({ fiber: stale, fiberKey: "__reactFiber$test" });
  assert.equal(f.route(), promoted ? "/_t3_env_/env-a/thread%3Aserver-a" : "__NEW__");
});
for (const shape of ["cycle", "depth limit"]) test(`unresolved Fiber ancestry fails closed at ${shape}`, () => {
  const stale = { memoizedProps: { draftId: "draft-a", isServerThread: true, threadRef: ref } };
  let last = stale;
  for (let i = 0; i < (shape === "cycle" ? 2 : 405); i++) last = last.return = {};
  if (shape === "cycle") last.return = stale;
  else last.stateNode = { current: {} };
  assert.equal(fixture({ fiber: stale, fiberKey: "__reactFiber$test" }).route(), "__NEW__");
});
test("router route takes precedence over a stale draft hash", () => {
  const routerPath = "/11111111-1111-4111-8111-111111111111/thread%3Aactive";
  const f = fixture({ hash: "#/draft/draft-a", routerPath });
  assert.equal(f.route(), routerPath);
});
test("resolved home route prevents a stale hash from selecting an older chat", () => {
  const f = fixture({ hash: "#/draft/draft-a", routerPath: "/" });
  assert.equal(f.route(), "__NEW__");
});
test("router chat changes with an unchanged hash trigger a fresh HUD poll", () => {
  const first = "/11111111-1111-4111-8111-111111111111/thread:first";
  const next = "/11111111-1111-4111-8111-111111111111/thread:next";
  const f = fixture({ hash: "#/draft/old-draft", routerPath: first }), calls = [];
  Object.assign(f.ctx, { currentPathHint: f.route(), scheduleLayoutSync() {}, refreshStats: changed => calls.push(changed) });
  vm.runInContext(fn("onRouteMaybeChanged"), f.ctx);
  f.setRouterPath(next);
  assert.equal(f.ctx.onRouteMaybeChanged(), true);
  assert.equal(f.ctx.currentPathHint, next);
  assert.deepEqual(Array.from(calls), [true]);
  assert.equal(f.ctx.window.location.hash, "#/draft/old-draft");
});
test("router and pathname fallbacks also resolve promoted drafts", () => {
  const f = fixture({ hash: "", routerPath: "/draft/draft-a", stored: { promotedDraftRedirects: { "draft-a": ref } } });
  assert.equal(f.route(), "/_t3_env_/env-a/thread%3Aserver-a");
});

for (const hash of ["#/draft/draft-a", "#/_t3_env_/env-a/draft/draft-a"]) {
  test(`unpromoted draft is always a new conversation (${hash})`, () => {
    assert.equal(fixture({ hash }).route(), "__NEW__");
  });
  test(`redirect survives draft cleanup and environment-scoped route (${hash})`, () => {
    const f = fixture({ hash, stored: { state: { drafts: {}, promotedDraftRedirects: { "draft-a": ref } } } });
    assert.equal(f.route(), "/_t3_env_/env-a/thread%3Aserver-a");
  });
}
test("pathname draft is normalized without hash or router state", () => {
  const f = fixture({ hash: "" });
  f.ctx.window.location.pathname = "/_t3_env_/local/draft/draft-a";
  assert.equal(f.route(), "__NEW__");
});

for (const field of ["memoizedProps", "pendingProps", "hook-state", "direct-state"]) {
  test(`v0.1.10 direct promotion fields in ${field}`, () => {
    const p = { draftId: "draft-a", isServerThread: true, ...ref };
    const fiber = field === "hook-state" ? { memoizedState: { memoizedState: null, next: { memoizedState: p } } }
      : field === "direct-state" ? { memoizedState: p } : { [field]: p };
    assert.equal(fixture({ fiber }).route(), "/_t3_env_/env-a/thread%3Aserver-a");
  });
}
for (const [activeThreadKey, environmentId, env, tid] of [
  ["6ee0c274-d218-41d6-b277-cbfc803dfbc0:thread:delegated-task:command%3A7", undefined, "6ee0c274-d218-41d6-b277-cbfc803dfbc0", "thread:delegated-task:command%3A7"],
  ["local:f7f4208e-30c8-42ea-86d7-d822aaea645a", undefined, "local", "f7f4208e-30c8-42ea-86d7-d822aaea645a"],
  ["thread:delegated-task:command%3A7", undefined, null, "thread:delegated-task:command%3A7"],
  ["thread:delegated-task:command%3A7", "explicit", "explicit", "thread:delegated-task:command%3A7"],
  ["local:thread:delegated-task:command%3A7", "local", "local", "thread:delegated-task:command%3A7"],
  ["local:legacy-thread-42", "previous-env", "local", "legacy-thread-42"],
  ["6ee0c274-d218-41d6-b277-cbfc803dfbc0/legacy-thread-42", undefined, "6ee0c274-d218-41d6-b277-cbfc803dfbc0", "legacy-thread-42"],
  ["local/legacy-thread-42", "local", "local", "legacy-thread-42"],
  ["remote:west/thread:delegated-task:command%3A7", "remote:west", "remote:west", "thread:delegated-task:command%3A7"],
  ["remote:west:thread:one", "remote:west", "remote:west", "thread:one"],
  ["remote:west/thread:one", undefined, "remote:west", "thread:one"],
  ["thread:one", "remote:west", "remote:west", "thread:one"],
]) test(`activeThreadKey preserves thread identity: ${activeThreadKey} (${environmentId || "inferred"})`, () => {
  const fiber = { memoizedProps: { draftId: "draft-a", isServerThread: true, activeThreadKey, environmentId } };
  const route = fixture({ fiber }).route();
  assert.equal(route, env ? `/_t3_env_/${encodeURIComponent(env)}/${encodeURIComponent(tid)}` : `/${encodeURIComponent(tid)}`);
  assert.equal(decodeURIComponent(route.split("/").at(-1)), tid);
});
for (const sourceKey of ["promotedDraftRedirects", "drafts", "draftThreadsByThreadKey"]) test(`scoped route supplies omitted environment for ${sourceKey}`, () => {
  const promoted = { threadId: "legacy-thread-42" };
  const stored = { [sourceKey]: { "draft-a": sourceKey === "promotedDraftRedirects" ? promoted : { promotedTo: promoted } } };
  assert.equal(fixture({ hash: "#/_t3_env_/remote%3Awest/draft/draft-a", stored }).route(), "/_t3_env_/remote%3Awest/legacy-thread-42");
});
test("scoped route supplies omitted Fiber environment without overriding explicit promotion environment", () => {
  const f = fixture({ hash: "#/_t3_env_/remote%3Awest/draft/draft-a", fiber: { memoizedProps: { draftId: "draft-a", isServerThread: true, activeThreadKey: "thread:server-a" } } });
  assert.equal(f.route(), "/_t3_env_/remote%3Awest/thread%3Aserver-a");
  assert.equal(fixture({ hash: "#/_t3_env_/remote%3Awest/draft/draft-a", stored: { promotedDraftRedirects: { "draft-a": ref } } }).route(), "/_t3_env_/env-a/thread%3Aserver-a");
});
for (const ref of [
  { environmentId: "env:%25:一", threadId: "thread:delegated-task:command%3A7" },
  { environmentId: "remote/west", threadId: "thread:promoted/7" },
  { environmentId: "remote?# west", threadId: "thread:promoted?x#7" },
  { threadId: "thread:delegated-task:command%3A7" },
]) test(`storage redirect encodes all route segments (${ref.environmentId || "no environment"})`, () => {
  const route = fixture({ stored: { promotedDraftRedirects: { "draft-a": ref } } }).route();
  assert.equal(route, ref.environmentId ? `/_t3_env_/${encodeURIComponent(ref.environmentId)}/${encodeURIComponent(ref.threadId)}` : `/${encodeURIComponent(ref.threadId)}`);
  if (ref.environmentId) assert.equal(decodeURIComponent(route.split("/")[2]), ref.environmentId);
  assert.equal(decodeURIComponent(route.split("/").at(-1)), ref.threadId);
});

for (const route of ["draft/draft-a", "/draft/draft-a", "_t3_env_/local/draft/draft-a", "/_t3_env_/local/draft/draft-a"]) test(`draft recognition with optional leading slash: ${route}`,()=>{
  assert.equal(fixture().resolve(route),"__NEW__");
  assert.equal(fixture({stored:{drafts:{"draft-a":{promotedTo:ref}}}}).resolve(route),"/_t3_env_/env-a/thread%3Aserver-a");
});
for (const route of ["/draft", "draft/", "/draft/", "/_t3_env_/local/draft/"]) test(`empty draft never resolves unrelated promotion: ${route}`,()=>{
  assert.equal(fixture({stored:{promotedDraftRedirects:{"":ref}}}).resolve(route),"__NEW__");
});
for (const route of ["/draft/%broken", "draft/%E0%A4%A", "/_t3_env_/%broken/draft/draft-a", "/_t3_env_/%E0%A4%A/draft/draft-a"]) test(`broken percent encoding fails closed before storage or Fiber: ${route}`,()=>{
  const f=fixture({stored:{promotedDraftRedirects:{"%broken":ref,"%E0%A4%A":ref,"draft-a":ref}},fiber:{memoizedProps:{draftId:"draft-a",isServerThread:true,...ref}}});
  assert.equal(f.resolve(route),"__ROUTE_invalid__");
});
for (const field of ["thread", "path"]) for (const separator of [":", "/"]) test(`colon environment from ${field} takes precedence over composite ${separator}`,()=>{
  const p={draftId:"draft-a",isServerThread:true,activeThreadKey:`remote:west${separator}thread:one`};
  if(field==="thread")p.thread={environmentId:"remote:west"};
  const f=fixture({hash:field==="path"?"#/_t3_env_/remote%3Awest/draft/draft-a":"#/draft/draft-a",fiber:{memoizedProps:p}});
  assert.equal(f.route(),"/_t3_env_/remote%3Awest/thread%3Aone");
});
for (const id of ["", "   ", ".", "..", "bad\u0000id", "bad\u007fid"]) for (const field of ["threadId","environmentId"]) test(`rejects unsafe ${field}: ${JSON.stringify(id)}`,()=>{
  if(field==="environmentId"&&id==="")return; // Empty environment intentionally means unscoped.
  assert.equal(fixture({stored:{drafts:{"draft-a":{promotedTo:{...ref,[field]:id}}}}}).route(),"__NEW__");
});
test("Fiber never combines draft identity and promotion fields across nodes or hook states", () => {
  const hook = { memoizedState: { draftId: "other", isServerThread: true, ...ref } };
  hook.next = hook;
  const fiber = { memoizedProps: { draftId: "draft-a", isServerThread: false, activeThreadKey: "env:thread:other" },
    pendingProps: { draftId: "other", isServerThread: true, ...ref }, memoizedState: hook,
    child: { memoizedProps: { isServerThread: true, ...ref } } };
  assert.equal(fixture({ fiber }).route(), "__NEW__");
});
test("hash changes always re-read the active draft rather than caching promotion", () => {
  const f = fixture({ stored: { promotedDraftRedirects: { "draft-a": ref } } });
  assert.equal(f.route(), "/_t3_env_/env-a/thread%3Aserver-a");
  f.ctx.window.location.hash = "#/draft/other";
  assert.equal(f.route(), "__NEW__");
});
test("poll entry and storage events notice promotion without navigation", async () => {
  const f = fixture();
  const ctx = f.ctx;
  Object.assign(ctx, { currentPathHint: f.route(), scheduleLayoutSync() {}, calls: [] });
  assert.equal(ctx.currentPathHint, "__NEW__");
  ctx.localStorage.getItem = () => JSON.stringify({state:{promotedDraftRedirects:{"draft-a":ref}}});
  vm.runInContext(fn("onRouteMaybeChanged") + "\nasync function refreshStats(changed) { calls.push(changed); }", ctx);
  assert.equal(ctx.onRouteMaybeChanged(), true);
  assert.equal(ctx.currentPathHint, "/_t3_env_/env-a/thread%3Aserver-a");
  assert.equal(ctx.window.location.hash, "#/draft/draft-a");
  assert.deepEqual(Array.from(ctx.calls), [true]);
  assert.equal(ctx.onRouteMaybeChanged(), false);
  assert.match(fn("refreshStats"), /if\s*\(onRouteMaybeChanged\(\)\)\s*return/);
  assert.match(source, /window\.addEventListener\("storage", onRouteMaybeChanged\)/);
  assert.match(source, /window\.addEventListener\("hashchange", onRouteMaybeChanged\)/);
  assert.match(source, /window\.removeEventListener\("storage", onRouteMaybeChanged\)/);
});
test("promotion during an in-flight poll immediately requests the server and discards the draft reply", async () => {
  const f = fixture();
  const requests=[],renders=[],resets=[];
  const ctx=f.ctx;
  Object.assign(ctx,{currentPathHint:f.route(),scheduleLayoutSync(){},
    callBackend:(method,hint)=>new Promise(resolve=>requests.push({method,hint,resolve})),
    resetLiveStreamSampler:hint=>resets.push(hint),resolveHudTurnSpeed(){},turnSpeedState:{},
    isCurrentStatsSnapshot:(id,seq,hint,current)=>id===seq&&hint===current,
    renderTopbarStats:stats=>renders.push(stats),document:{hidden:false},gitListEl:{childElementCount:0},
  });
  vm.runInContext(`let statsInFlight=false,statsRequestSeq=0,pendingFastRefresh=false,disposed=false,drawerOpen=false,lastLoadedGraphThreadId=null,lastRemotePayload=null,latestStats=null,lastTopbarSig='',latestGraph=null;\n${fn("onRouteMaybeChanged")}\n${fn("refreshStats")}`,ctx);
  const old=ctx.refreshStats(false);
  ctx.localStorage.getItem=()=>JSON.stringify({state:{promotedDraftRedirects:{"draft-a":ref}}});
  const route="/_t3_env_/env-a/thread%3Aserver-a";
  await ctx.refreshStats(false);
  assert.deepEqual(requests.map(r=>r.hint),["__NEW__",route]);
  assert.deepEqual(resets,[route]);
  assert.equal(ctx.currentPathHint,route);
  requests[0].resolve({ok:true,threadId:"old-thread",tokens:{contextUsed:999}});
  await old;
  assert.equal(renders.some(s=>s.threadId==="old-thread"),false);
  requests[1].resolve({ok:true,threadId:"thread:server-a",tokens:{contextUsed:42}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(renders.at(-1).threadId,"thread:server-a");
  assert.equal(renders.at(-1).tokens.contextUsed,42);
  assert.equal(vm.runInContext("statsInFlight",ctx),false);
});

function visibility(dialogs) {
  const sRect = { top: 500, bottom: 600, left: 100, right: 600, width: 500, height: 100 };
  const shell = { getBoundingClientRect: () => sRect };
  const ctx = vm.createContext({
    getRouteHint: () => "/thread:one", window: { location: { pathname: "/" }, innerHeight: 800 },
    document: { body: {}, querySelector: () => shell, querySelectorAll: () => dialogs, elementFromPoint: () => null },
    findComposerSurface: s => s, getComputedStyle: d => ({ opacity: "1", ...d.css }),
  });
  return vm.runInContext(`(${fn("isChatComposerVisibleAndUncovered")})()`, ctx);
}

const uuidEnv = "6ee0c274-d218-41d6-b277-cbfc803dfbc0";
function projectionFixture(tid="legacy-other") {
  let scans=0;
  const ctx=vm.createContext({document:{getElementById(){scans++;return {__reactContainer$test:{memoizedState:{memoizedState:{environmentId:uuidEnv,projection:{thread:{id:tid,title:"Fixture"},providerTurns:[]}}}}};}}});
  vm.runInContext(["toEpochMs","extractLastThreadIdFromHint","buildProjectionPayload","readFiberThreadProjection"].map(fn).join("\n"),ctx);
  return {ctx,get scans(){return scans;}};
}
for (const tid of ["legacy-thread-42","thread:promoted/7","thread:delegated-task:command%3A7"]) for(const prefix of [`/_t3_env_/${uuidEnv}/`,`/${uuidEnv}/`]) test(`Fiber picks exact decoded thread rather than UUID environment: ${prefix}${tid}`,()=>{
  const f=projectionFixture(tid), hint=prefix+encodeURIComponent(tid)+"?other=thread:wrong#thread:hash";
  assert.equal(f.ctx.extractLastThreadIdFromHint(hint),tid);
  assert.equal(f.ctx.readFiberThreadProjection(hint).threadId,tid);
});
for(const hint of ["__NEW__","__ROUTE_invalid__","draft/draft-a","/draft/","/_t3_env_/local/draft/draft-a?thread=thread:wrong"]) test(`draft/sentinel never scans Fiber: ${hint}`,()=>{
  const f=projectionFixture();
  assert.equal(f.ctx.extractLastThreadIdFromHint(hint),"__NEW__");
  assert.equal(f.ctx.readFiberThreadProjection(hint),null);assert.equal(f.scans,0);
});
for(const hint of ["/_t3_env_/local/%broken",`/${uuidEnv}/%E0%A4%A`]) test(`Fiber rejects broken thread encoding: ${hint}`,()=>{
  const f=projectionFixture();
  assert.equal(f.ctx.extractLastThreadIdFromHint(hint),"__ROUTE_invalid__");
  assert.equal(f.ctx.readFiberThreadProjection(hint),null);assert.equal(f.scans,0);
});
test("Fiber only falls back without an explicit hint and ignores query/hash identities",()=>{
  const f=projectionFixture();
  for(const hint of ["/unknown","/unknown?thread=thread:wrong#thread:hash",`/_t3_env_/${uuidEnv}/legacy-missing`])assert.equal(f.ctx.readFiberThreadProjection(hint),null,hint);
  assert.equal(f.ctx.extractLastThreadIdFromHint("/unknown?thread=thread:wrong#thread:hash"),null);
  assert.equal(f.ctx.readFiberThreadProjection("").threadId,"legacy-other");
});
function popup(attrs = {}, css = {}, rect = {}) {
  return { hidden: false, css, getAttribute: k => attrs[k] ?? null, hasAttribute: k => k in attrs,
    getBoundingClientRect: () => ({ width: 300, height: 200, top: 100, bottom: 300, left: 100, right: 400, ...rect }) };
}
for (const [name, d] of [
  ["hidden", { ...popup({ role: "dialog", "aria-modal": "true" }), hidden: true }],
  ["aria hidden", popup({ role: "dialog", "aria-hidden": "true" })],
  ["inert", { ...popup({ role: "dialog", "aria-modal": "true" }), inert: true }],
  ["closed", popup({ "data-slot": "dialog-popup", "data-closed": "" })],
  ...["display", "visibility", "opacity"].map(k => [k, popup({ role: "dialog", "aria-modal": "true" }, { [k]: k === "display" ? "none" : k === "visibility" ? "hidden" : "0" })]),
  ["non-overlapping inline popover", popup({ role: "dialog" })],
]) test(`composer remains visible with ${name}`, () => assert.ok(visibility([d])));
for (const [name, ancestor] of [
  ["hidden", { ...popup(), hidden: true }], ["inert", { ...popup(), inert: true }],
  ["inert attribute", popup({ inert: "" })], ["aria-hidden", popup({ "aria-hidden": "true" })],
  ["display:none", popup({}, { display: "none" })], ["visibility:hidden", popup({}, { visibility: "hidden" })],
  ["opacity:0", popup({}, { opacity: "0.0" })],
]) {
  for (const depth of [1, 3]) test(`composer ignores modal with ${name} ancestor at depth ${depth}`, () => {
    const dialog = popup({ role: "dialog", "aria-modal": "true" });
    let node = dialog;
    for (let i = 1; i < depth; i++) node = node.parentElement = popup();
    node.parentElement = ancestor;
    assert.ok(visibility([dialog]));
  });
}
test("visible ancestors do not suppress a real modal", () => {
  const dialog = popup({ role: "dialog", "aria-modal": "true" });
  dialog.parentElement = popup({}, { opacity: "0.5" });
  assert.equal(visibility([dialog]), null);
});
for (const d of [popup({ role: "dialog", "aria-modal": "true" }), popup({ role: "alertdialog" }), popup({ "data-slot": "dialog-popup" }), popup({ "data-slot": "sheet-popup" }), popup({ role: "dialog" }, {}, { top: 450, bottom: 650 })]) {
  test("visible modal or overlapping popup hides composer HUD", () => assert.equal(visibility([d]), null));
}
