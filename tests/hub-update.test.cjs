"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { ASSET_NAME, createBundle, createHudUpdater, sha256 } = require("../src/hub-update.cjs");

const repo = path.dirname(__dirname);
const latest = "https://api.github.com/repos/kingmaozi/t3-code-hud/releases/latest";
const releaseRoot = "https://github.com/kingmaozi/t3-code-hud/releases/download";
const cdn = "https://release-assets.githubusercontent.com/candidate";
const main = "http://127.0.0.1:41893";
const bridge = "http://127.0.0.1:41894";
const target = "1.0.10";
const assetUrl = `${releaseRoot}/v${target}/${ASSET_NAME}`;
const leaseToken = "4".repeat(64);
const bridgeToken = "7".repeat(64);

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3-hub-update-"));
  const pluginDir = path.join(root, "hud-plugin");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(pluginDir, "run"), { recursive: true });
  const put = (name, value) => fs.writeFileSync(path.join(pluginDir, name), value);
  const read = name => fs.readFileSync(path.join(pluginDir, name), "utf8");
  put("run/active.pid", String(process.pid));
  put(`run/rpc-${process.pid}.json`, JSON.stringify({ pid: process.pid, url: main, adminToken: leaseToken }));
  put("run/hub-bridge.json", JSON.stringify({ watchPid: process.pid, pid: process.ppid, url: bridge, token: bridgeToken }));
  put("hud-release.json", '{"version":"1.0.9"}');
  put("renderer-ui.js", 'window.__t3HudReleaseVersion = "1.0.9";\n');
  put("renderer-base.js", "window.original = true;");
  put("hub-drawer-ui.js", "window.localDrawer = true;");
  put("config.json", '{"memory":"disabled","custom":"keep"}');
  put("backend.cjs", "module.exports = { original: true };\n");
  const bytes = Buffer.from(JSON.stringify({ ...createBundle(repo), version: target }));
  const asset = {
    name: ASSET_NAME, state: "uploaded", browser_download_url: assetUrl,
    digest: "sha256:" + sha256(bytes), size: bytes.length,
  };
  const release = { tag_name: "v" + target, draft: false, prerelease: false, assets: [asset] };
  const paths = [];
  const versionsAtReload = [];
  const fetchImpl = async (url, init) => {
    const address = String(url);
    paths.push(address);
    if (address === latest) {
      assert.equal(init.redirect, "manual");
      assert.equal(init.headers["X-T3-Hud-Token"], undefined);
      return Response.json(release);
    }
    if (address === assetUrl) return new Response(null, { status: 302, headers: { Location: options.location || cdn } });
    if (address === cdn) {
      assert.equal(init.headers["X-T3-Hud-Token"], undefined);
      return new Response(options.corrupt ? Buffer.alloc(bytes.length) : bytes);
    }
    if (url.origin !== main && url.origin !== bridge) throw new Error("Unexpected endpoint");
    assert.equal(init.headers["X-T3-Hud-Token"], url.origin === main ? leaseToken : bridgeToken);
    if (url.pathname === "/admin/status") {
      return Response.json({ ok: true, pid: process.pid, mounted: true, windows: [{ loading: false }] });
    }
    if (url.pathname === "/admin/reload-ui") {
      const version = JSON.parse(read("hud-release.json")).version;
      versionsAtReload.push(version);
      if (options.backendReloadFailure && version === target) {
        return Response.json({ ok: false, error: "Backend reload failed" }, { status: 500 });
      }
      const injected = !(options.reloadFailure && version === target);
      return Response.json({ ok: true, results: [{ injected }] });
    }
    if (url.pathname === "/reload") return Response.json({ ok: true });
    if (url.pathname === "/rpc" || url.pathname === "/hub-rpc") {
      return Response.json({ ok: true, backendHash: options.backendMismatch ? "old" : sha256(read("backend.cjs")) });
    }
    throw new Error("Unexpected local RPC");
  };
  const updater = createHudUpdater({ pluginDir, fetchImpl });
  return { updater, read, put, release, paths, versionsAtReload, pluginDir, root };
}

test("a manual check reads GitHub and leaves installed files and live processes alone", async t => {
  const f = fixture(t);
  const result = await f.updater.check();
  assert.deepEqual(result, {
    ok: true, status: "available", currentVersion: "1.0.9", availableVersion: target,
    releaseUrl: `https://github.com/kingmaozi/t3-code-hud/releases/tag/v${target}`,
  });
  assert.deepEqual(f.paths, [latest]);
  assert.equal(f.read("hud-release.json"), '{"version":"1.0.9"}');
  f.release.assets = [];
  assert.equal((await f.updater.check()).status, "unsupported");
  f.release.tag_name = "v1.0.8";
  assert.equal((await f.updater.check()).status, "current");
});

test("only the confirmed GitHub candidate updates once and verifies both running backends", async t => {
  const f = fixture(t);
  assert.equal((await f.updater.apply("1.0.11")).code, "UPDATE_CHANGED");
  const pending = f.updater.apply(target);
  assert.equal((await f.updater.apply(target)).code, "UPDATE_BUSY");
  assert.equal((await f.updater.check()).code, "UPDATE_BUSY");
  assert.deepEqual(await pending, { ok: true, status: "updated", currentVersion: target });
  assert.deepEqual(f.versionsAtReload, [target]);
  assert.equal(f.read("config.json"), '{"memory":"disabled","custom":"keep"}');
  assert.match(f.read("renderer-ui.js"), /window\.__t3HudReleaseVersion = "1\.0\.10";/);
  assert.match(f.read("renderer-ui.js"), /window\.localDrawer = true;/);
  assert.equal(f.read("hub-drawer-ui.js"), "window.localDrawer = true;");
  assert.ok(f.paths.includes(main + "/rpc") && f.paths.includes(bridge + "/hub-rpc"));
  assert.equal((await f.updater.apply(target)).status, "current");
  assert.equal((await f.updater.check()).currentVersion, target);
});

test("apply refuses the other T3 process and any active manual installation", async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, "hud-install.lock"));
  assert.equal((await f.updater.apply(target)).code, "UPDATE_BUSY");
  fs.rmdirSync(path.join(f.root, "hud-install.lock"));
  f.put("run/active.pid", String(process.ppid));
  f.put(`run/rpc-${process.ppid}.json`, JSON.stringify({ pid: process.ppid, url: main, adminToken: leaseToken }));
  f.put("run/hub-bridge.json", JSON.stringify({ watchPid: process.ppid, pid: process.pid, url: bridge, token: bridgeToken }));
  assert.equal((await f.updater.apply(target)).code, "HUD_UNAVAILABLE");
  assert.deepEqual(f.paths, []);
});

test("can recover an interrupted write offline after the previous lock owner exited", async t => {
  const f = fixture(t);
  const release = createBundle(repo);
  fs.mkdirSync(path.join(f.pluginDir, "backups"));
  const backup = fs.mkdtempSync(path.join(f.pluginDir, "backups", "hud-update-"));
  const files = {};
  for (const name of [...Object.keys(release.files), "renderer-ui.js", "hud-release.json"]) {
    const filename = path.join(f.pluginDir, name);
    const original = fs.existsSync(filename) ? fs.readFileSync(filename) : null;
    if (original) fs.writeFileSync(path.join(backup, name), original);
    files[name] = original ? { hash: sha256(original), mode: 0o600 } : null;
  }
  f.put("run/hud-update-pending.json", JSON.stringify({ backup: path.basename(backup), version: "1.0.9", files }));
  f.put("renderer-base.js", "window.interrupted = true;");
  f.put("hud-release.json", '{"version":"1.0.10"}');
  fs.mkdirSync(path.join(f.pluginDir, "run/hud-update.lock"));
  f.put("run/hud-update.lock/owner-2147483647-abcdefab-abcd-abcd-abcd-abcdefabcdef", "");
  assert.deepEqual(await f.updater.check(), {
    ok: true, status: "recoverable", currentVersion: "1.0.9", availableVersion: "1.0.9",
  });
  assert.equal(f.read("renderer-base.js"), "window.interrupted = true;");
  assert.deepEqual(await f.updater.apply("1.0.9"), { ok: true, status: "current", currentVersion: "1.0.9" });
  assert.deepEqual(f.versionsAtReload, ["1.0.9"]);
  assert.equal(f.paths.includes(latest), false);
  assert.equal(f.read("renderer-base.js"), "window.original = true;");
  assert.equal(fs.existsSync(path.join(f.pluginDir, "run", "hud-update-pending.json")), false);
});

test("rejects a corrupt asset and an untrusted redirect before local changes", async t => {
  for (const options of [{ corrupt: true }, { location: "https://127.0.0.1/artifact" }]) {
    const f = fixture(t, options);
    assert.equal((await f.updater.apply(target)).code, "UPDATE_INVALID");
    assert.deepEqual(f.versionsAtReload, []);
    assert.equal(f.read("renderer-base.js"), "window.original = true;");
  }
});

test("failed renderer injection or backend replacement rolls back bytes and version", async t => {
  for (const options of [{ reloadFailure: true }, { backendReloadFailure: true }, { backendMismatch: true }]) {
    const f = fixture(t, options);
    const before = f.read("backend.cjs");
    assert.equal((await f.updater.apply(target)).code, "UPDATE_FAILED");
    assert.deepEqual(f.versionsAtReload, [target, "1.0.9"]);
    assert.equal(f.read("backend.cjs"), before);
    assert.equal(f.read("hud-release.json"), '{"version":"1.0.9"}');
    assert.equal(f.read("renderer-base.js"), "window.original = true;");
    assert.equal(fs.existsSync(path.join(f.pluginDir, "hub-update.cjs")), false);
    assert.equal(fs.existsSync(path.join(f.pluginDir, "run", "hud-update-pending.json")), false);
    assert.equal(fs.readdirSync(path.join(f.pluginDir, "backups")).length, 1);
  }
});

test("updater prefers per-instance hub-bridge-<pid>.json and refuses symlinked run records", async t => {
  const f = fixture(t);
  // Put a stale/wrong shared hub-bridge.json and a valid per-instance hub-bridge-<pid>.json
  f.put("run/hub-bridge.json", JSON.stringify({ watchPid: process.pid + 1, pid: process.ppid, url: bridge, token: bridgeToken }));
  f.put(`run/hub-bridge-${process.pid}.json`, JSON.stringify({ watchPid: process.pid, pid: process.ppid, url: bridge, token: bridgeToken }));
  assert.deepEqual(await f.updater.apply(target), { ok: true, status: "updated", currentVersion: target });

  // Symlinked active.pid must be rejected
  const realActive = path.join(f.root, "real-active.pid");
  fs.writeFileSync(realActive, String(process.pid));
  fs.unlinkSync(path.join(f.pluginDir, "run", "active.pid"));
  fs.symlinkSync(realActive, path.join(f.pluginDir, "run", "active.pid"));
  assert.equal((await f.updater.apply("1.0.11")).code, "HUD_UNAVAILABLE");
});
