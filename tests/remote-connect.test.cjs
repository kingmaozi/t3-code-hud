"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ui = fs.readFileSync(path.join(__dirname, "../src/renderer-ui.js"), "utf8");
const tip = "b".repeat(40);
const root = "a".repeat(40);
const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

function remoteBundleHarness() {
  const start = ui.indexOf("  async function fetchRemoteGitBundle(");
  const end = ui.indexOf("\n  async function openCommitDetail", start);
  const calls = [];
  const ctx = { window: { __t3HudRemoteRpc: async (_env, tag, input) => {
    calls.push({ tag, input });
    let value;
    if (tag === "projects.readFile") {
      const files = {
        ".git/HEAD": "ref: refs/heads/main\n",
        ".git/refs/heads/main": tip + "\n",
        ".git/logs/HEAD": `${"0".repeat(40)} ${root} Tester <test@example.test> 1 +0000\tcommit (initial): first\n${root} ${tip} Tester <test@example.test> 2 +0000\tcommit: second\n`,
      };
      value = { contents: files[input.relativePath] || "", exists: input.relativePath in files, truncated: false };
    } else if (tag === "vcs.listRefs") value = { isRepo: true, refs: [{ name: "main", current: true, isDefault: true }] };
    else if (tag === "review.getBranchCommits") value = { commits: [], truncated: false };
    else if (tag === "review.getDiffPreview") {
      assert.match(input.commitSha, /^[a-f0-9]{40}$/);
      value = { sources: [{ kind: "commit", headRef: input.commitSha, baseRef: input.commitSha === tip ? root : emptyTree, commitSubject: input.commitSha === tip ? "second" : "first", diff: "", files: [], patchesDeferred: true }] };
    } else return { ok: false, error: "unsupported" };
    return { ok: true, value };
  } }, callBackend: async (_method, bundle) => bundle };
  vm.createContext(ctx);
  vm.runInContext(ui.slice(start, end) + "\nthis.fetchBundle = fetchRemoteGitBundle;", ctx);
  return { ctx, calls };
}

test("uses native contents and does not probe commit details for the initial graph", async () => {
  const { ctx, calls } = remoteBundleHarness();
  const bundle = await ctx.fetchBundle("env", "/private/repo", "main");
  assert.match(bundle.gitHead || "", /refs\/heads\/main/);
  assert.ok(bundle.headLog?.includes(root));
  assert.deepEqual(Array.from(bundle.nativeCommits || []), []);
  assert.equal(bundle.nativeHistoryTruncated, true);
  assert.equal(calls.filter(c => c.tag === "review.getDiffPreview").length, 0);

});

for (const blobMode of [false, true]) test(`hot reload adopts a legacy socket and reassembles split ${blobMode ? "Blob" : "text"} frames`, async () => {
  const listeners = new Map();
  const env = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  class NativeSocket {
    constructor(url) { this.url = url; this.readyState = 1; this.sent = []; listeners.set(this, {}); }
    addEventListener(name, fn) { (listeners.get(this)[name] ||= []).push(fn); }
    removeEventListener(name, fn) { listeners.get(this)[name] = (listeners.get(this)[name] || []).filter(x => x !== fn); }
    send(data) {
      this.sent.push(data);
      let req;
      try { req = JSON.parse(data); } catch { return "native-result"; }
      const value = req.tag === "server.getConfig" ? { environment: { environmentId: env } } : "remote-result";
      queueMicrotask(() => {
        const wire = JSON.stringify({ _tag: "Exit", requestId: req.id, exit: { _tag: "Success", value } });
        const parts = ["\u001e" + wire.slice(0, 25), "\u001e" + wire.slice(25, 50), wire.slice(50)];
        for (const [index, part] of parts.entries()) {
          const data = blobMode && index < 2 ? { arrayBuffer: () => new Promise(resolve => setTimeout(() => resolve(new TextEncoder().encode(part).buffer), index === 0 ? 20 : 0)) } : part;
          for (const fn of listeners.get(this).message || []) fn({ data });
        }
      });
      return "native-result";
    }
  }
  class LegacyTrackedSocket extends NativeSocket {}
  LegacyTrackedSocket.__t3HudTracked = true;
  const existing = new LegacyTrackedSocket("wss://already-authorized.example.test");
  const win = { WebSocket: LegacyTrackedSocket, __t3HudWsRpcInstalled: true, __t3HudRemoteRpc: async () => ({ ok: false, error: "legacy" }) };
  const context = { window: win, document: { getElementById: () => null }, setTimeout, clearTimeout, TextDecoder, ArrayBuffer, URL, queueMicrotask };
  vm.runInNewContext(ui, context);
  assert.equal(existing.send("heartbeat"), "native-result");
  const [reply, concurrent] = await Promise.all([
    win.__t3HudRemoteRpc(env, "vcs.listRefs", {}, 100),
    win.__t3HudRemoteRpc(env, "vcs.refreshStatus", {}, 100),
  ]);
  assert.equal(reply.ok, true);
  assert.equal(concurrent.ok, true);
  assert.equal(reply.value, "remote-result");
  assert.equal(existing.sent.filter(data => { try { return JSON.parse(data).tag === "server.getConfig"; } catch { return false; } }).length, 1);
  const listenerCount = listeners.get(existing).message.length;
  vm.runInNewContext(ui, context);
  assert.equal(listeners.get(existing).message.length, listenerCount);
});

test("incomplete remote diffs render their notice and retain the available files and patch", () => {
  const start = ui.indexOf("  function renderCommitDetail(res)");
  const end = ui.indexOf("\n  gitListEl.addEventListener", start);
  for (const hudLang of ["zh", "en"]) {
    const ctx = { hudLang, commitMsgEl: {}, commitMetaEl: {}, commitBodyEl: {}, t: key => key, escapeHtml: text => text, formatColoredPatch: text => text };
    vm.createContext(ctx);
    vm.runInContext(ui.slice(start, end) + "\nthis.renderDetail = renderCommitDetail;", ctx);
    assert.doesNotThrow(() => ctx.renderDetail({ hash: tip, message: "second", files: [{ path: "visible.txt", added: 1, deleted: 0 }], patch: "+available patch", diffUnavailable: true }));
    assert.ok(ctx.commitBodyEl.innerHTML.includes("visible.txt"));
    assert.ok(ctx.commitBodyEl.innerHTML.includes("+available patch"));
    assert.match(ctx.commitBodyEl.innerHTML, hudLang === "en" ? /incomplete/ : /不完整/);
  }
});

function graphPerformanceHarness({ gateStatus = false, failBackend = false, failPreview = false } = {}) {
  const start = ui.indexOf("  async function fetchRemoteGitBundle(");
  const end = ui.indexOf("\n  async function openCommitDetail", start);
  const calls = [], builds = [], releaseStatus = [];
  let dirty = 0, backendFailure = failBackend, previewFailure = failPreview;
  const ctx = { window: { __t3HudRemoteRpc: async (env, tag, input) => {
    calls.push({ env, tag, input });
    if (tag === "projects.readFile") return { ok: true, value: { contents: input.relativePath === ".git/HEAD" ? tip : "", exists: true } };
    if (tag === "vcs.listRefs") return { ok: true, value: { refs: [] } };
    if (tag === "vcs.refreshStatus") {
      if (gateStatus) await new Promise(resolve => releaseStatus.push(resolve));
      return { ok: true, value: { dirtyCount: dirty } };
    }
    if (tag === "review.getBranchCommits") return { ok: true, value: { commits: [{ sha: tip, subject: "latest" }] } };
    if (tag === "review.getDiffPreview") return previewFailure ? { ok: false } : { ok: true, value: { sources: [{ kind: "commit", headRef: input.commitSha, baseRef: root, commitSubject: "latest" }] } };
    return { ok: false };
  } }, callBackend: async (_method, bundle) => {
    const snapshot = JSON.parse(JSON.stringify(bundle)); builds.push(snapshot);
    return { ok: !backendFailure, snapshot };
  } };
  vm.createContext(ctx);
  vm.runInContext(ui.slice(start, end) + "\nthis.fetchBundle=fetchRemoteGitBundle;this.fetchPreview=fetchRemoteCommitPreview;", ctx);
  return { ctx, calls, builds, releaseStatus, setDirty: value => { dirty = value; }, setBackendFailure: value => { backendFailure = value; }, setPreviewFailure: value => { previewFailure = value; } };
}

test("remote graph loads existing rows without any per-commit preview or extra GitHub request", async () => {
  const h = graphPerformanceHarness();
  const result = await h.ctx.fetchBundle("env-a", "/repo", "main", { threadId: "chat-a" });
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.nativeCommits.length, 0);
  assert.equal(result.snapshot.gitConfig, null);
  assert.equal(result.snapshot.nativeHistoryTruncated, true);
  assert.equal(h.calls.filter(call => call.tag === "review.getDiffPreview").length, 0);
  assert.equal(h.calls.length, 7);
});

test("simultaneous opens of the same remote graph share the in-flight metadata request", async () => {
  const h = graphPerformanceHarness({ gateStatus: true });
  const first = h.ctx.fetchBundle("env", "/repo", "main", { threadId: "chat" });
  const second = h.ctx.fetchBundle("env", "/repo", "main", { threadId: "chat" });
  await new Promise(setImmediate);
  assert.equal(h.calls.filter(call => call.tag === "vcs.refreshStatus").length, 1);
  h.releaseStatus.splice(0).forEach(fn => fn());
  assert.equal((await first).ok, true); assert.equal((await second).ok, true);
  assert.equal(h.builds.length, 1);
});

test("graph cache isolates environment, repository, branch, chat and refreshes dirty status", async () => {
  const h = graphPerformanceHarness();
  const run = (env, cwd, branch, threadId) => h.ctx.fetchBundle(env, cwd, branch, { threadId });
  await run("env-a", "/repo-a", "main", "chat-a");
  await run("env-a", "/repo-a", "main", "chat-a");
  assert.equal(h.builds.length, 1, "unchanged, freshly verified metadata reuses the graph");
  h.setDirty(9);
  assert.equal((await run("env-a", "/repo-a", "main", "chat-a")).snapshot.vcsStatus.dirtyCount, 9);
  assert.equal(h.builds.length, 2, "changed worktree status rebuilds the graph");
  for (const args of [["env-b", "/repo-a", "main", "chat-a"], ["env-a", "/repo-b", "main", "chat-a"], ["env-a", "/repo-a", "other", "chat-a"], ["env-a", "/repo-a", "main", "chat-b"]]) {
    const before = h.builds.length; await run(...args); assert.equal(h.builds.length, before + 1);
  }
});

test("a failed graph build is never cached", async () => {
  const h = graphPerformanceHarness({ failBackend: true });
  assert.equal((await h.ctx.fetchBundle("env", "/repo", "main", { threadId: "chat" })).ok, false);
  h.setBackendFailure(false);
  assert.equal((await h.ctx.fetchBundle("env", "/repo", "main", { threadId: "chat" })).ok, true);
  assert.equal(h.builds.length, 2);
});

test("commit details load only the selected SHA, deduplicate and isolate identities", async () => {
  const h = graphPerformanceHarness();
  const run = (env, cwd, branch, thread, hash) => h.ctx.fetchPreview(env, cwd, branch, thread, hash);
  const [a, b] = await Promise.all([run("env", "/repo", "main", "chat", tip), run("env", "/repo", "main", "chat", tip)]);
  assert.equal(a.ok, true); assert.equal(b.ok, true);
  assert.equal(h.calls.filter(call => call.tag === "review.getDiffPreview").length, 1);
  await run("env", "/repo", "main", "chat", tip);
  assert.equal(h.calls.filter(call => call.tag === "review.getDiffPreview").length, 1);
  await run("env", "/repo", "main", "other-chat", tip);
  await run("env2", "/repo", "main", "chat", tip);
  assert.equal(h.calls.filter(call => call.tag === "review.getDiffPreview").length, 3);
  assert.ok(h.calls.filter(call => call.tag === "review.getDiffPreview").every(call => call.input.commitSha === tip));
});

test("failed commit details are never cached", async () => {
  const h = graphPerformanceHarness({ failPreview: true });
  assert.equal((await h.ctx.fetchPreview("env", "/repo", "main", "chat", tip)).ok, false);
  h.setPreviewFailure(false);
  assert.equal((await h.ctx.fetchPreview("env", "/repo", "main", "chat", tip)).ok, true);
  assert.equal(h.calls.filter(call => call.tag === "review.getDiffPreview").length, 2);
});

test("late graph and commit detail replies are guarded by route and repository snapshots", () => {
  const start = ui.indexOf("  async function openCommitDetail(");
  const end = ui.indexOf("\n  function renderCommitDetail", start);
  const detail = ui.slice(start, end);
  assert.match(detail, /getRouteHint\(\) !== hintSnap/);
  assert.match(detail, /getFallbackCwd\(\)\?\.environmentId !== envId/);
  assert.match(detail, /getFallbackCwd\(\)\?\.cwd !== cwd/);
  const refresh = ui.match(/  async function refreshGitGraph\([\s\S]*?\n  \}/)?.[0] || "";
  assert.match(refresh, /reqSeq !== gitGraphReqSeq/);
  assert.match(refresh, /getFallbackCwd\(\)\?\.environmentId !== envId/);
});


test("recent reflog commits do not impersonate HEAD after switching branches", async () => {
  const backend = require("../src/backend.cjs");
  const start = ui.indexOf("  async function fetchRemoteGitBundle(");
  const end = ui.indexOf("\n  async function openCommitDetail", start);
  const headLog = `${"0".repeat(40)} ${root} Tester <test@example.test> 1 +0000\tcommit (initial): main\n${root} ${tip} Tester <test@example.test> 2 +0000\tcommit: feature\n${tip} ${root} Tester <test@example.test> 3 +0000\tcheckout: moving from feature to main\n`;
  const ctx = { window: { __t3HudRemoteRpc: async (_env, tag, input) => {
    if (tag === "projects.readFile") {
      const files = { ".git/HEAD": "ref: refs/heads/main\n", ".git/refs/heads/main": root, ".git/logs/HEAD": headLog };
      return { ok: true, value: { contents: files[input.relativePath] || "", exists: input.relativePath in files } };
    }
    if (tag === "vcs.refreshStatus") return { ok: true, value: {} };
    if (tag === "vcs.listRefs") return { ok: true, value: { refs: [] } };
    if (tag === "review.getBranchCommits") return { ok: true, value: { commits: [] } };
    throw new Error(`unexpected ${tag}`);
  } }, callBackend: (_method, bundle) => backend.getRemoteGitGraph(bundle) };
  vm.createContext(ctx); vm.runInContext(ui.slice(start, end) + "\nthis.fetchBundle=fetchRemoteGitBundle;", ctx);
  const graph = await ctx.fetchBundle("env", "/repo", "main");
  assert.equal(graph.historyScope, "repo-activity");
  const main = graph.commits.find(commit => commit.hash === root), feature = graph.commits.find(commit => commit.hash === tip);
  assert.ok(main.refs.some(ref => ref.isHead && ref.label === "HEAD"));
  assert.ok(main.refs.some(ref => ref.kind === "branch" && ref.label === "main"));
  assert.equal(feature.refs.some(ref => ref.isHead || ref.label === "main"), false);
});

test("an unverified remote HEAD is never assigned to an arbitrary commit", async () => {
  const backend = require("../src/backend.cjs");
  const start = ui.indexOf("  async function fetchRemoteGitBundle(");
  const end = ui.indexOf("\n  async function openCommitDetail", start);
  const ctx = { window: { __t3HudRemoteRpc: async (_env, tag, input) => {
    if (tag === "projects.readFile") return { ok: true, value: { contents: input.relativePath === ".git/HEAD" ? "ref: refs/heads/main\n" : "", exists: input.relativePath === ".git/HEAD" } };
    if (tag === "vcs.refreshStatus") return { ok: true, value: {} };
    if (tag === "vcs.listRefs") return { ok: true, value: { refs: [] } };
    if (tag === "review.getBranchCommits") return { ok: true, value: { commits: [{ sha: tip, subject: "latest" }] } };
    throw new Error(`unexpected ${tag}`);
  } }, callBackend: (_method, bundle) => backend.getRemoteGitGraph(bundle) };
  vm.createContext(ctx); vm.runInContext(ui.slice(start, end) + "\nthis.fetchBundle=fetchRemoteGitBundle;", ctx);
  const graph = await ctx.fetchBundle("env", "/repo", "main");
  assert.equal(graph.historyScope, "branch-range");
  assert.equal(graph.commits.some(commit => commit.refs.some(ref => ref.isHead || ref.label === "HEAD")), false);
});

test("a stale reflog never overrides the verified current branch ref", async () => {
  const backend = require("../src/backend.cjs");
  const start = ui.indexOf("  async function fetchRemoteGitBundle(");
  const end = ui.indexOf("\n  async function openCommitDetail", start);
  const log = `${"0".repeat(40)} ${root} Tester <test@example.test> 1 +0000\tcommit (initial): main\n${root} ${tip} Tester <test@example.test> 2 +0000\tcommit: feature\n`;
  const ctx = { window: { __t3HudRemoteRpc: async (_env, tag, input) => {
    if (tag === "projects.readFile") {
      const files = { ".git/HEAD": "ref: refs/heads/main\n", ".git/refs/heads/main": root, ".git/logs/HEAD": log };
      return { ok: true, value: { contents: files[input.relativePath] || "", exists: input.relativePath in files } };
    }
    if (tag === "vcs.refreshStatus") return { ok: true, value: {} };
    if (tag === "vcs.listRefs") return { ok: true, value: { refs: [] } };
    if (tag === "review.getBranchCommits") return { ok: true, value: { commits: [] } };
    throw new Error(`unexpected ${tag}`);
  } }, callBackend: (_method, bundle) => backend.getRemoteGitGraph(bundle) };
  vm.createContext(ctx); vm.runInContext(ui.slice(start, end) + "\nthis.fetchBundle=fetchRemoteGitBundle;", ctx);
  const graph = await ctx.fetchBundle("env", "/repo", "main");
  assert.ok(graph.commits.find(commit => commit.hash === root).refs.some(ref => ref.isHead));
  assert.equal(graph.commits.find(commit => commit.hash === tip).refs.some(ref => ref.isHead || ref.label === "main"), false);
});

test("a loose current branch ref overrides a stale packed branch label", async () => {
  const backend = require("../src/backend.cjs");
  const start = ui.indexOf("  async function fetchRemoteGitBundle(");
  const end = ui.indexOf("\n  async function openCommitDetail", start);
  const log = `${"0".repeat(40)} ${root} Tester <test@example.test> 1 +0000\tcommit (initial): old\n${root} ${tip} Tester <test@example.test> 2 +0000\tcommit: new\n`;
  const ctx = { window: { __t3HudRemoteRpc: async (_env, tag, input) => {
    if (tag === "projects.readFile") {
      const files = { ".git/HEAD": "ref: refs/heads/main\n", ".git/refs/heads/main": tip, ".git/packed-refs": `${root} refs/heads/main\n`, ".git/logs/HEAD": log };
      return { ok: true, value: { contents: files[input.relativePath] || "", exists: input.relativePath in files } };
    }
    if (tag === "vcs.refreshStatus") return { ok: true, value: {} };
    if (tag === "vcs.listRefs") return { ok: true, value: { refs: [] } };
    if (tag === "review.getBranchCommits") return { ok: true, value: { commits: [] } };
    throw new Error(`unexpected ${tag}`);
  } }, callBackend: (_method, bundle) => backend.getRemoteGitGraph(bundle) };
  vm.createContext(ctx); vm.runInContext(ui.slice(start, end) + "\nthis.fetchBundle=fetchRemoteGitBundle;", ctx);
  const graph = await ctx.fetchBundle("env", "/repo", "main");
  assert.ok(graph.commits.find(commit => commit.hash === tip).refs.some(ref => ref.isHead));
  assert.equal(graph.commits.flatMap(commit => commit.refs.filter(ref => ref.kind === "branch" && ref.label === "main").map(() => commit.hash)).join(), tip);
});
