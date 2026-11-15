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

test("uses the native contents field and includes the initial unpublished commit", async () => {
  const { ctx, calls } = remoteBundleHarness();
  const bundle = await ctx.fetchBundle("env", "/private/repo", "main");
  assert.match(bundle.gitHead || "", /refs\/heads\/main/);
  assert.ok(bundle.headLog?.includes(root));
  assert.deepEqual(Array.from(bundle.nativeCommits || [], c => c.hash), [tip, root]);
  assert.deepEqual(Array.from(bundle.nativeCommits[0].parents), [root]);
  assert.deepEqual(Array.from(bundle.nativeCommits[1].parents), []);
  assert.equal(bundle.nativeHistoryTruncated, false);
  assert.ok(calls.some(c => c.input.commitSha === root));
});

test("hot reload adopts a legacy socket and reassembles native split response frames", async () => {
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
        for (const part of ["\u001e" + wire.slice(0, 25), "\u001e" + wire.slice(25, 50), wire.slice(50)]) {
          for (const fn of listeners.get(this).message || []) fn({ data: part });
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
