"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
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
  const bytes = Buffer.from(JSON.stringify({ ...createBundle(repo, { includeOptional: false }), version: target }));
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

// This is the installed v1.1.4 validator. Keep its fixed four-file contract
// in the fixture so a shallow checkout can exercise the transition offline.
const baselineValidateBundle = String.raw`function validateBundle(bundle, expectedVersion) {
  if (!bundle || bundle.schema !== 1 || !isStable(expectedVersion) || bundle.version !== expectedVersion ||
      !bundle.files || typeof bundle.files !== "object" || Array.isArray(bundle.files) ||
      Object.keys(bundle.files).length !== Object.keys(HOT_SOURCES).length) throw invalidPackage();
  for (const name of Object.keys(HOT_SOURCES)) {
    const code = bundle.files[name];
    if (!Object.hasOwn(bundle.files, name) || typeof code !== "string" || !code.trim()) throw invalidPackage();
    try { new Script(name.endsWith(".cjs") ? wrap(code) : code, { filename: name }); }
    catch { throw invalidPackage(); }
  }
  return bundle;
}`;

test("a four-file transition upgrades the baseline validator before optional AGY activation and rolls back a failed activation", async t => {
  const f = fixture(t);
  const transition = { ...createBundle(repo, { includeOptional: false }), version: target };
  const full = { ...createBundle(repo), version: "1.0.11" };
  assert.equal(Object.keys(transition.files).length, 4);
  assert.equal(Object.keys(full.files).length, 12);

  const updaterPath = path.join(f.pluginDir, "hub-update.cjs");
  const includedUpdater = transition.files["hub-update.cjs"];
  const validatorStart = includedUpdater.indexOf("function validateBundle(");
  const validatorEnd = includedUpdater.indexOf("\n// Publish", validatorStart);
  assert.ok(validatorStart >= 0 && validatorEnd > validatorStart);
  f.put("hub-update.cjs", includedUpdater.slice(0, validatorStart) + baselineValidateBundle + includedUpdater.slice(validatorEnd));
  f.put("hud-release.cjs", transition.files["hud-release.cjs"]);
  const optional = path.join(f.pluginDir, "hub-agy-quota.cjs");

  let failNextActivation = false;
  const reloads = [];
  const runtime = {
    async ready() {},
    async reload(expectedHash) {
      const version = JSON.parse(f.read("hud-release.json")).version;
      reloads.push({ version, optional: fs.existsSync(optional) });
      assert.equal(expectedHash, sha256(f.read("backend.cjs")));
      if (failNextActivation && version === full.version) throw new Error("fixture activation failure");
    },
  };
  const getRuntime = () => runtime;
  const baselineUpdater = require(updaterPath).createHudUpdater({ pluginDir: f.pluginDir, getRuntime });
  assert.equal((await baselineUpdater.activateLocal(full, full.version)).code, "UPDATE_INVALID");
  assert.deepEqual(await baselineUpdater.activateLocal(transition, target), {
    ok: true, status: "updated", currentVersion: target,
  });
  assert.equal(fs.existsSync(optional), false);

  delete require.cache[updaterPath];
  const upgradedUpdater = require(updaterPath).createHudUpdater({ pluginDir: f.pluginDir, getRuntime });
  const unknown = { ...full, files: { ...full.files, "unexpected.cjs": "module.exports = {};" } };
  assert.equal((await upgradedUpdater.activateLocal(unknown, full.version)).code, "UPDATE_INVALID");

  const targets = [...Object.keys(transition.files), "renderer-ui.js", "hud-release.json"];
  const readInstalled = () => targets.map(name => [f.read(name), fs.statSync(path.join(f.pluginDir, name)).mode]);
  const previous = readInstalled();
  failNextActivation = true;
  assert.equal((await upgradedUpdater.activateLocal(full, full.version)).code, "UPDATE_FAILED");
  assert.deepEqual(readInstalled(), previous);
  assert.equal(fs.existsSync(optional), false);
  assert.equal(fs.existsSync(path.join(f.pluginDir, "run/hud-update-pending.json")), false);

  failNextActivation = false;
  assert.deepEqual(await upgradedUpdater.activateLocal(full, full.version), {
    ok: true, status: "updated", currentVersion: full.version,
  });
  assert.deepEqual(reloads, [
    { version: target, optional: false },
    { version: full.version, optional: true },
    { version: target, optional: false },
    { version: full.version, optional: true },
  ]);
  assert.equal(f.read("hub-agy-quota.cjs"), full.files["hub-agy-quota.cjs"]);

  const src = path.join(repo, "src");
  for (const name of fs.readdirSync(src)) {
    const installed = path.join(f.pluginDir, name);
    if (name.endsWith(".cjs") && !fs.existsSync(installed)) fs.copyFileSync(path.join(src, name), installed);
  }

  const home = path.join(f.root, "home");
  const t3Base = path.join(home, ".t3");
  const data = path.join(t3Base, "userdata");
  const environmentId = "11111111-1111-4111-8111-111111111111";
  const otherEnvId = "22222222-2222-4222-8222-222222222222";
  const instanceId = "antigravity";
  const profile = path.join(data, "providers", "antigravity", createHash("sha256").update(instanceId).digest("hex"));
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(data, "environment-id"), environmentId);
  fs.writeFileSync(path.join(data, "settings.json"), JSON.stringify({
    providerInstances: { [instanceId]: { driver: "antigravity" } },
  }));
  const archDir = path.join(t3Base, "tools", "antigravity-acp", `${process.platform}-${process.arch}`);
  const releaseId = "a".repeat(64);
  const releaseDir = path.join(archDir, "versions", releaseId);
  fs.mkdirSync(releaseDir, { recursive: true });
  fs.writeFileSync(path.join(archDir, "active.json"), JSON.stringify({ releaseId }));
  const binary = path.join(releaseDir, "antigravity");
  const binaryBytes = "mock only, never executed";
  fs.writeFileSync(binary, binaryBytes, { mode: 0o700 });
  fs.writeFileSync(path.join(releaseDir, ".install-complete.json"), JSON.stringify({
    releaseId, version: "1.5.15", executable: { name: "antigravity", bytes: Buffer.byteLength(binaryBytes) },
  }));

  const script = `
    const { EventEmitter } = require("node:events");
    const assert = require("node:assert/strict");
    const [backend, binary, profile, localId, remoteId, source] = process.argv.slice(1);
    const starts = [];
    globalThis.fetch = () => { throw new Error("Unexpected network access"); };
    require("node:child_process").spawn = (binPath, args, options) => {
      assert.equal(binPath, binary);
      assert.equal(options.env.GEMINI_HOME, profile);
      assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
      const version = args[0] === "--version";
      if (!version) assert.deepEqual(args.slice(0, 2), ["-p", "/usage"]);
      starts.push(version ? "--version" : "/usage");
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        const groups = [
          { id: "gemini", buckets: [
            { id: "gemini-5h", window: "5h", remaining_fraction: 0.6 },
            { id: "gemini-weekly", window: "weekly", remaining_fraction: 0.8 },
          ] },
          { id: "3p", buckets: [
            { id: "3p-5h", window: "5h", remaining_fraction: 0.5 },
            { id: "3p-weekly", window: "weekly", remaining_fraction: 0.7 },
          ] },
        ];
        const stdout = version ? "1.5.15" : JSON.stringify({
          status: "SUCCESS", num_turns: 0, command: { name: "usage", data: { groups } },
        });
        child.stdout.emit("data", stdout);
        child.emit("close", 0);
      });
      return child;
    };

    const { hubCall } = require(backend);
    delete process.env.T3_HUB_TEST;
    (async () => {
      const native = await hubCall("quota:external", { observedEnvId: localId, hasNativeAgyQuota: true });
      assert.deepEqual(native, { ok: true, providers: [], t3EnvironmentId: localId, agySkippedNative: true });
      assert.deepEqual(starts, [], "Cold local native quota must prevent any CLI spawn");
      const result = await hubCall("quota:external", { observedEnvId: remoteId, hasNativeAgyQuota: true });
      assert.equal(result.agySkippedNative, undefined);
      const expectedStarts = source === "primary" ? ["--version", "/usage"] : [];
      assert.deepEqual(starts, expectedStarts);
      assert.deepEqual(await hubCall("quota:external", { force: true }), result);
      assert.deepEqual(starts, expectedStarts);
      process.stdout.write(JSON.stringify(result));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const callInstalledBackend = source => {
    const result = spawnSync(process.execPath, [
      "-e", script, path.join(f.pluginDir, "backend.cjs"), binary, profile, environmentId, otherEnvId, source,
    ], {
      env: { HOME: home, T3_HUB_DIR: path.join(f.root, "hub"), T3_HUD_DIR: f.pluginDir, T3_HUB_TEST: "1" },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr || String(result.error || ""));
    return JSON.parse(result.stdout);
  };
  const output = callInstalledBackend("primary");
  assert.deepEqual(callInstalledBackend("bridge"), output);
  assert.equal(output.ok, true);
  assert.equal(output.t3EnvironmentId, environmentId);
  assert.equal(output.providers.length, 1);
  const [provider] = output.providers;
  assert.equal(provider.instanceId, instanceId);
  assert.equal(provider.driver, "antigravity");
  assert.deepEqual(provider.usageLimits.windows.map(w => [w.id, w.windowDurationMins, w.usedPercent]), [
    ["gemini-5h", 300, 40], ["gemini-weekly", 10080, 20],
    ["3p-5h", 300, 50], ["3p-weekly", 10080, 30],
  ]);
});

test("full hot-update bundle updates hub-drawer-ui.js and optional modules, assembles new drawer, and rolls back on failure", async t => {
  const f = fixture(t);
  const fullBundle = createBundle(repo, { includeOptional: true });
  assert.ok(Object.hasOwn(fullBundle.files, "hub-drawer-ui.js"));
  assert.ok(Object.hasOwn(fullBundle.files, "hub-memory-access.cjs"));
  assert.ok(Object.hasOwn(fullBundle.files, "hud-config.cjs"));
  const customDrawer = "window.upgradedDrawerMarker = 'v1.0.10-hot';\n";
  const candidate = {
    ...fullBundle,
    version: target,
    files: { ...fullBundle.files, "hub-drawer-ui.js": customDrawer },
  };
  let failReload = true;
  const runtime = {
    bridge: { url: bridge, token: bridgeToken },
    async ready() {},
    async reload(expectedHash) {
      if (expectedHash) assert.equal(expectedHash, sha256(f.read("backend.cjs")));
      if (failReload && JSON.parse(f.read("hud-release.json")).version === target) {
        throw new Error("simulated reload failure");
      }
    },
  };
  const updater = createHudUpdater({ pluginDir: f.pluginDir, getRuntime: () => runtime });

  // Failed activation rolls back hub-drawer-ui.js and removes newly-added optional modules
  assert.equal((await updater.activateLocal(candidate, target)).code, "UPDATE_FAILED");
  assert.equal(f.read("hub-drawer-ui.js"), "window.localDrawer = true;");
  assert.equal(fs.existsSync(path.join(f.pluginDir, "hub-memory-access.cjs")), false);
  assert.equal(f.read("hud-release.json"), '{"version":"1.0.9"}');

  // Successful activation updates hub-drawer-ui.js + hub-memory-access.cjs and assembles new drawer
  failReload = false;
  assert.deepEqual(await updater.activateLocal(candidate, target), {
    ok: true, status: "updated", currentVersion: target,
  });
  assert.equal(f.read("hub-drawer-ui.js"), customDrawer);
  assert.equal(f.read("hub-memory-access.cjs"), fullBundle.files["hub-memory-access.cjs"]);
  assert.match(f.read("renderer-ui.js"), /window\.upgradedDrawerMarker = 'v1\.0\.10-hot';/);
  assert.doesNotMatch(f.read("renderer-ui.js"), /window\.localDrawer = true;/);
});

test("autoHotUpdate config persists atomically, defaults to true, fails closed on invalid/corrupt/symlink, rejects non-booleans, and preserves other keys", t => {
  const { readHudConfig, updateHudAutoHotUpdate } = require("../src/hud-config.cjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3-hud-cfg-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pluginDir = path.join(root, "hud-plugin");
  const configFile = path.join(pluginDir, "config.json");
  fs.mkdirSync(pluginDir, { recursive: true });

  // Missing config returns {} safely
  assert.deepEqual(readHudConfig(configFile), {});

  // Preserves existing keys across atomic update
  fs.writeFileSync(configFile, JSON.stringify({
    defaultLang: "en",
    userLang: "zh",
    syncShellProfileTelemetryOptOut: true,
    customKey: "keep-me",
  }, null, 2));
  assert.throws(() => updateHudAutoHotUpdate("true", { pluginDir }), /boolean/i);
  assert.throws(() => updateHudAutoHotUpdate(1, { pluginDir }), /boolean/i);
  assert.throws(() => updateHudAutoHotUpdate(null, { pluginDir }), /boolean/i);

  const savedTrue = updateHudAutoHotUpdate(true, { pluginDir });
  assert.equal(savedTrue.autoHotUpdate, true);
  assert.equal(savedTrue.defaultLang, "en");
  assert.equal(savedTrue.userLang, "zh");
  assert.equal(savedTrue.syncShellProfileTelemetryOptOut, true);
  assert.equal(savedTrue.customKey, "keep-me");
  assert.equal(readHudConfig(configFile).autoHotUpdate, true);

  const savedFalse = updateHudAutoHotUpdate(false, { pluginDir });
  assert.equal(savedFalse.autoHotUpdate, false);
  assert.equal(readHudConfig(configFile).defaultLang, "en");

  // Symlinked config.json is refused and its target is untouched
  const targetFile = path.join(root, "outside.json");
  fs.writeFileSync(targetFile, '{"autoHotUpdate":false,"untouched":true}');
  fs.unlinkSync(configFile);
  fs.symlinkSync(targetFile, configFile);
  assert.throws(() => readHudConfig(configFile), /symlink|non-regular/i);
  assert.throws(() => updateHudAutoHotUpdate(true, { pluginDir }), /symlink|non-regular/i);
  assert.equal(fs.readFileSync(targetFile, "utf8"), '{"autoHotUpdate":false,"untouched":true}');

  // Backend RPC contract via isolated subprocess
  fs.unlinkSync(configFile);
  fs.writeFileSync(path.join(pluginDir, "hud-release.json"), '{"version":"1.2.3"}\n');
  const rpcScript = `
    const assert = require("node:assert/strict");
    const fs = require("node:fs");
    const path = require("node:path");
    const pluginDir = process.env.T3_HUD_DIR;
    const configFile = path.join(pluginDir, "config.json");
    const { hubCall } = require(${JSON.stringify(path.join(repo, "src/backend.cjs"))});
    (async () => {
      // Missing config.json defaults to autoHotUpdate: true
      const missing = await hubCall("hub:update:config:get", {});
      assert.deepEqual(missing, { ok: true, autoHotUpdate: true, currentVersion: "1.2.3" });

      // Existing config.json without autoHotUpdate key defaults to true
      fs.writeFileSync(configFile, JSON.stringify({ defaultLang: "zh", syncShellProfileTelemetryOptOut: false }));
      const initial = await hubCall("hub:update:config:get", {});
      assert.deepEqual(initial, { ok: true, autoHotUpdate: true, currentVersion: "1.2.3" });

      // Non-boolean set is rejected
      const bad = await hubCall("hub:update:config:set", { autoHotUpdate: "yes" });
      assert.equal(bad.ok, false);
      assert.match(bad.error, /boolean/);

      // Explicit false disables autoHotUpdate
      const disabled = await hubCall("hub:update:config:set", { autoHotUpdate: false });
      assert.deepEqual(disabled, { ok: true, autoHotUpdate: false });
      const afterDisable = await hubCall("hub:update:config:get", {});
      assert.deepEqual(afterDisable, { ok: true, autoHotUpdate: false, currentVersion: "1.2.3" });

      // Non-boolean on disk fails closed
      for (const badValue of ["true", "false", 1, 0, null, {}, []]) {
        fs.writeFileSync(configFile, JSON.stringify({ defaultLang: "zh", autoHotUpdate: badValue }));
        const invalidGet = await hubCall("hub:update:config:get", {});
        assert.deepEqual(invalidGet, {
          ok: false,
          autoHotUpdate: false,
          currentVersion: "1.2.3",
          error: "autoHotUpdate must be boolean",
        });
      }

      // Corrupt JSON fails closed
      fs.writeFileSync(configFile, "{corrupt json");
      const corruptGet = await hubCall("hub:update:config:get", {});
      assert.equal(corruptGet.ok, false);
      assert.equal(corruptGet.autoHotUpdate, false);

      // Symlink config.json fails closed
      const outside = path.join(path.dirname(pluginDir), "outside-rpc.json");
      fs.writeFileSync(outside, JSON.stringify({ autoHotUpdate: true }));
      fs.unlinkSync(configFile);
      fs.symlinkSync(outside, configFile);
      const symGet = await hubCall("hub:update:config:get", {});
      assert.equal(symGet.ok, false);
      assert.equal(symGet.autoHotUpdate, false);

      // Restore normal config and re-enable via RPC
      fs.unlinkSync(configFile);
      fs.writeFileSync(configFile, JSON.stringify({ defaultLang: "zh", syncShellProfileTelemetryOptOut: false }));
      const enabled = await hubCall("hub:update:config:set", { autoHotUpdate: true });
      assert.deepEqual(enabled, { ok: true, autoHotUpdate: true });
      const after = await hubCall("hub:update:config:get", {});
      assert.deepEqual(after, { ok: true, autoHotUpdate: true, currentVersion: "1.2.3" });
    })().catch(err => { console.error(err); process.exitCode = 1; });
  `;
  const run = spawnSync(process.execPath, ["-e", rpcScript], {
    env: { ...process.env, T3_HUD_DIR: pluginDir, T3_HUB_DIR: path.join(root, "hub"), T3_HUB_TEST: "1" },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(run.status, 0, run.stderr || String(run.error || ""));
  const onDisk = JSON.parse(fs.readFileSync(configFile, "utf8"));
  assert.equal(onDisk.autoHotUpdate, true);
  assert.equal(onDisk.defaultLang, "zh");
  assert.equal(onDisk.syncShellProfileTelemetryOptOut, false);
});

test("auto apply defaults to enabled when config.json is absent or omits autoHotUpdate, honors explicit false, and fails closed on symlink/corrupt/non-boolean config", async t => {
  // 1. Missing config.json (ENOENT) defaults to enabled
  const fMissing = fixture(t);
  fs.unlinkSync(path.join(fMissing.pluginDir, "config.json"));
  assert.deepEqual(await fMissing.updater.apply(target, { auto: true }), {
    ok: true, status: "updated", currentVersion: target,
  });

  // 2. Valid config.json without autoHotUpdate key defaults to enabled
  const fOmitted = fixture(t);
  fOmitted.put("config.json", JSON.stringify({ memory: "disabled", custom: "keep" }));
  assert.deepEqual(await fOmitted.updater.apply(target, { auto: true }), {
    ok: true, status: "updated", currentVersion: target,
  });

  // 3. Explicit false disables auto apply with 0 network/reload calls
  const fFalse = fixture(t);
  fFalse.put("config.json", JSON.stringify({ autoHotUpdate: false }));
  const resFalse = await fFalse.updater.apply(target, { auto: true });
  assert.equal(resFalse.ok, false);
  assert.equal(resFalse.code, "AUTO_UPDATE_DISABLED");
  assert.deepEqual(fFalse.paths, []);

  // 4. Non-boolean values, corrupt JSON, and non-plain-object JSON all fail closed
  const invalidPayloads = [
    JSON.stringify({ autoHotUpdate: "true" }),
    JSON.stringify({ autoHotUpdate: 1 }),
    JSON.stringify({ autoHotUpdate: null }),
    "{corrupt json",
    "[]",
    "null",
    '"true"',
  ];
  for (const raw of invalidPayloads) {
    const fBad = fixture(t);
    fBad.put("config.json", raw);
    const resBad = await fBad.updater.apply(target, { auto: true });
    assert.equal(resBad.ok, false, `Expected fail-closed for payload: ${raw}`);
    assert.equal(resBad.code, "AUTO_UPDATE_DISABLED");
    assert.deepEqual(fBad.paths, []);
  }

  // 5. Symlinked config.json (pointing to valid true file OR dangling) fails closed
  const fSym = fixture(t);
  const outside = path.join(fSym.root, "outside-auto.json");
  fs.writeFileSync(outside, JSON.stringify({ autoHotUpdate: true }));
  fs.unlinkSync(path.join(fSym.pluginDir, "config.json"));
  fs.symlinkSync(outside, path.join(fSym.pluginDir, "config.json"));
  const resSym = await fSym.updater.apply(target, { auto: true });
  assert.equal(resSym.ok, false);
  assert.equal(resSym.code, "AUTO_UPDATE_DISABLED");
  assert.deepEqual(fSym.paths, []);

  fs.unlinkSync(outside); // dangling symlink
  const resDangling = await fSym.updater.apply(target, { auto: true });
  assert.equal(resDangling.ok, false);
  assert.equal(resDangling.code, "AUTO_UPDATE_DISABLED");
  assert.deepEqual(fSym.paths, []);
});

test("background check caches for 6h, deduplicates concurrent background checks, manual bypasses cache, and apply clears cache", async t => {
  const f = fixture(t);
  let clock = 1_000_000;
  let releaseGate = null;
  let fetchCount = 0;
  const bytes = Buffer.from(JSON.stringify({ ...createBundle(repo, { includeOptional: false }), version: target }));
  const release = {
    tag_name: "v" + target,
    draft: false,
    prerelease: false,
    assets: [{
      name: ASSET_NAME, state: "uploaded", browser_download_url: assetUrl,
      digest: "sha256:" + sha256(bytes), size: bytes.length,
    }],
  };
  const fetchImpl = async (url) => {
    const address = String(url);
    if (address === latest) {
      fetchCount++;
      if (releaseGate) await releaseGate.promise;
      return Response.json(release);
    }
    if (address === assetUrl) return new Response(null, { status: 302, headers: { Location: cdn } });
    if (address === cdn) return new Response(bytes);
    if (url.pathname === "/admin/status") return Response.json({ ok: true, pid: process.pid, mounted: true, windows: [{ loading: false }] });
    if (url.pathname === "/admin/reload-ui") return Response.json({ ok: true, results: [{ injected: true }] });
    if (url.pathname === "/reload") return Response.json({ ok: true });
    if (url.pathname === "/rpc" || url.pathname === "/hub-rpc") return Response.json({ ok: true, backendHash: sha256(f.read("backend.cjs")) });
    throw new Error("Unexpected URL: " + address);
  };
  const updater = createHudUpdater({
    pluginDir: f.pluginDir,
    fetchImpl,
    backgroundCacheMs: 6 * 60 * 60 * 1000,
    now: () => clock,
  });

  // 1. Concurrent background checks share one single-flight lookupRelease call
  releaseGate = Promise.withResolvers();
  const c1 = updater.check({ background: true });
  const c2 = updater.check({ background: true });
  assert.equal(fetchCount, 1);
  releaseGate.resolve();
  releaseGate = null;
  const [r1, r2] = await Promise.all([c1, c2]);
  assert.equal(r1.status, "available");
  assert.equal(r2.status, "available");
  assert.equal(fetchCount, 1);

  // 2. Background check within 6h hits memory cache with zero network requests
  clock += 5 * 60 * 60 * 1000;
  const cached = await updater.check({ background: true });
  assert.equal(cached.ok, true);
  assert.equal(cached.status, "available");
  assert.equal(cached.cached, true);
  assert.equal(fetchCount, 1);

  // 3. Manual check bypasses cache and refreshes it
  const manual = await updater.check({ background: false });
  assert.equal(manual.ok, true);
  assert.equal(manual.cached, undefined);
  assert.equal(fetchCount, 2);

  // 4. Advancing clock past 6h invalidates background cache
  clock += 6 * 60 * 60 * 1000 + 1;
  const expired = await updater.check({ background: true });
  assert.equal(expired.ok, true);
  assert.equal(expired.cached, undefined);
  assert.equal(fetchCount, 3);

  // 5. apply() clears check cache so subsequent background check never returns stale available
  const applied = await updater.apply(target);
  assert.deepEqual(applied, { ok: true, status: "updated", currentVersion: target });
  const postApply = await updater.check({ background: true });
  assert.equal(postApply.ok, true);
  assert.equal(postApply.status, "current");
  assert.equal(postApply.cached, undefined);
});

test("P0 #1: auto apply re-verifies persisted autoHotUpdate under lock and persists per-version attempt dedup across remounts", async t => {
  // Part A: Cross-window race — both windows saw true, Window 1 turns it off, Window 2 triggers auto apply -> 0 actual applies
  const f1 = fixture(t);
  f1.put("config.json", JSON.stringify({ autoHotUpdate: true }));
  // Window 1 flips persisted setting to false before Window 2's auto apply enters lock
  f1.put("config.json", JSON.stringify({ autoHotUpdate: false }));
  const disabledRes = await f1.updater.apply(target, { auto: true });
  assert.equal(disabledRes.ok, false);
  assert.equal(disabledRes.code, "AUTO_UPDATE_DISABLED");
  assert.deepEqual(f1.paths, [], "zero network or reload calls when autoHotUpdate is disabled on disk");
  assert.deepEqual(f1.versionsAtReload, []);

  // Part B: Auto update failure persists attempt record (0600); subsequent auto attempt after remount is rejected, manual still succeeds
  let failReload = true;
  const f2 = fixture(t, { reloadFailure: true });
  f2.put("config.json", JSON.stringify({ autoHotUpdate: true }));
  const firstFail = await f2.updater.apply(target, { auto: true });
  assert.equal(firstFail.ok, false);
  assert.equal(firstFail.code, "UPDATE_FAILED");
  const attemptPath = path.join(f2.pluginDir, "run", "hud-auto-update-attempted.json");
  assert.equal(fs.existsSync(attemptPath), true);
  assert.equal(fs.lstatSync(attemptPath).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(attemptPath, "utf8")).version, target);

  // Simulate remount / fresh updater instance on the same pluginDir
  const pathsBeforeRetry = f2.paths.length;
  const secondAuto = await f2.updater.apply(target, { auto: true });
  assert.equal(secondAuto.ok, false);
  assert.equal(secondAuto.code, "AUTO_UPDATE_ALREADY_ATTEMPTED");
  assert.equal(f2.paths.length, pathsBeforeRetry, "second auto attempt must not re-fetch or re-apply");

  // Manual apply on a healthy runtime succeeds and clears the persisted attempt file
  const f3 = fixture(t);
  f3.put("config.json", JSON.stringify({ autoHotUpdate: true }));
  f3.put("run/hud-auto-update-attempted.json", JSON.stringify({ version: target, attemptedAt: Date.now() }));
  const blockedAuto = await f3.updater.apply(target, { auto: true });
  assert.equal(blockedAuto.code, "AUTO_UPDATE_ALREADY_ATTEMPTED");
  const manualOk = await f3.updater.apply(target);
  assert.deepEqual(manualOk, { ok: true, status: "updated", currentVersion: target });
  assert.equal(fs.existsSync(path.join(f3.pluginDir, "run", "hud-auto-update-attempted.json")), false);
  void failReload;
});

test("P0 #2: backend config RPC stays compatible with v1.1.5 hud-config.cjs, serializes concurrent writes, and rejects symlink/corrupt config", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3-v115-cfg-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pluginDir = path.join(root, "hud-plugin");
  fs.mkdirSync(pluginDir, { recursive: true });
  const srcDir = path.join(repo, "src");
  for (const name of fs.readdirSync(srcDir)) {
    if (name.endsWith(".cjs") || name === "hub-drawer-ui.js") {
      fs.copyFileSync(path.join(srcDir, name), path.join(pluginDir, name));
    }
  }
  // Overwrite installed hud-config.cjs with v1.1.5-shaped module (only readHudConfig(filePath), updateHudConfig, updateHudLanguage)
  const v115HudConfig = `"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readJsonFileStrict, writeTextAtomic } = require("./hub-host-settings.cjs");
function hudPluginDir() { return process.env.T3_HUD_DIR || path.join(os.homedir(), ".t3", "hud-plugin"); }
function readHudConfig(file) { return readJsonFileStrict(file).data; }
function updateHudConfig(file, edit, beforeSave = () => {}) {
  const { DatabaseSync } = require("node:sqlite");
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(dir, ".config-write-lock.sqlite");
  const fd = fs.openSync(lockPath, fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
  try { if (!fs.fstatSync(fd).isFile()) throw new Error("Invalid lock"); } finally { fs.closeSync(fd); }
  const db = new DatabaseSync(lockPath);
  try {
    db.exec("PRAGMA busy_timeout=750; BEGIN IMMEDIATE");
    const current = readHudConfig(file);
    const next = edit(current);
    beforeSave(current, next);
    if (JSON.stringify(next) !== JSON.stringify(current)) writeTextAtomic(file, JSON.stringify(next, null, 2) + "\\n");
  } finally { db.close(); }
}
function updateHudLanguage(file, patch) {
  updateHudConfig(file, (current) => ({ defaultLang: "zh", ...current, ...(patch.userLang ? { userLang: patch.userLang } : {}) }));
}
module.exports = { hudPluginDir, readHudConfig, updateHudConfig, updateHudLanguage };
`;
  fs.writeFileSync(path.join(pluginDir, "hud-config.cjs"), v115HudConfig);
  fs.writeFileSync(path.join(pluginDir, "hud-release.json"), '{"version":"1.1.5"}\n');

  const script = `
    const assert = require("node:assert/strict");
    const fs = require("node:fs");
    const path = require("node:path");
    const pluginDir = process.env.T3_HUD_DIR;
    const configFile = path.join(pluginDir, "config.json");
    const { hubCall, setConfig } = require(path.join(pluginDir, "backend.cjs"));
    const { createTelemetryGuard } = require(path.join(pluginDir, "hub-telemetry-guard.cjs"));
    (async () => {
      // 1. v1.1.5 hud-config.cjs set(true) + get() returns true
      assert.deepEqual(await hubCall("hub:update:config:set", { autoHotUpdate: true }), { ok: true, autoHotUpdate: true });
      assert.deepEqual(await hubCall("hub:update:config:get", {}), { ok: true, autoHotUpdate: true, currentVersion: "1.1.5" });

      // 2. Concurrent / interleaved writes with language & telemetry preserve all keys
      const guard = createTelemetryGuard({ homeDir: path.dirname(pluginDir), pluginDir });
      await Promise.all([
        hubCall("hub:update:config:set", { autoHotUpdate: true }),
        Promise.resolve().then(() => setConfig({ defaultLang: "en", userLang: "en" })),
        Promise.resolve().then(() => guard.update({ disableOfficialTelemetry: false })),
      ]);
      const saved = JSON.parse(fs.readFileSync(configFile, "utf8"));
      assert.equal(saved.autoHotUpdate, true);
      assert.equal(saved.userLang, "en");
      assert.equal(saved.disableOfficialTelemetry, false);

      // 3. Symlink config.json must fail closed and leave symlink target untouched
      const outside = path.join(path.dirname(pluginDir), "outside-secret.json");
      fs.writeFileSync(outside, '{"secret":true}');
      fs.unlinkSync(configFile);
      fs.symlinkSync(outside, configFile);
      const symSet = await hubCall("hub:update:config:set", { autoHotUpdate: false });
      assert.equal(symSet.ok, false);
      assert.equal(fs.readFileSync(outside, "utf8"), '{"secret":true}');
      const symGet = await hubCall("hub:update:config:get", {});
      assert.equal(symGet.ok, false);

      // 4. Corrupt JSON config.json must fail closed and keep original bytes untouched
      fs.unlinkSync(configFile);
      fs.writeFileSync(configFile, "{corrupt json");
      const corruptSet = await hubCall("hub:update:config:set", { autoHotUpdate: false });
      assert.equal(corruptSet.ok, false);
      assert.equal(fs.readFileSync(configFile, "utf8"), "{corrupt json");
    })().catch(err => { console.error(err); process.exitCode = 1; });
  `;
  const run = spawnSync(process.execPath, ["-e", script], {
    env: { ...process.env, HOME: root, T3_HUD_DIR: pluginDir, T3_HUB_DIR: path.join(root, "hub"), T3_HUB_TEST: "1" },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(run.status, 0, run.stderr || String(run.error || ""));
});

test("P1 #3: check() produces zero unhandled rejections under strict mode and isolates generations across apply()", async t => {
  // Part A: --unhandled-rejections=strict subprocess with rejected fetch exits 0
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3-strict-rej-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pluginDir = path.join(root, "hud-plugin");
  fs.mkdirSync(path.join(pluginDir, "run"), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "hud-release.json"), '{"version":"1.0.9"}');
  const strictScript = `
    const assert = require("node:assert/strict");
    const { createHudUpdater } = require(${JSON.stringify(path.join(repo, "src/hub-update.cjs"))});
    const updater = createHudUpdater({
      pluginDir: ${JSON.stringify(pluginDir)},
      fetchImpl: async () => { throw new TypeError("offline network failure"); },
    });
    (async () => {
      const res = await updater.check({ background: true });
      assert.equal(res.ok, false);
      assert.equal(res.code, "UPDATE_UNAVAILABLE");
    })();
  `;
  const run = spawnSync(process.execPath, ["--unhandled-rejections=strict", "-e", strictScript], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(run.status, 0, run.stderr || String(run.error || ""));

  // Part B: Same-version apply during pending check bumps cacheGen; manual check issues fresh 2nd fetch
  const f = fixture(t);
  let fetchCount = 0;
  const gate1 = Promise.withResolvers();
  const fetchImpl = async (url) => {
    const address = String(url);
    if (address === latest) {
      fetchCount++;
      const callNum = fetchCount;
      if (callNum === 1) await gate1.promise;
      return Response.json({
        tag_name: callNum === 1 ? "v1.0.10" : "v1.0.9",
        draft: false,
        prerelease: false,
        assets: [],
      });
    }
    if (url.pathname === "/admin/status") return Response.json({ ok: true, pid: process.pid, mounted: true, windows: [{ loading: false }] });
    if (url.pathname === "/admin/reload-ui") return Response.json({ ok: true, results: [{ injected: true }] });
    if (url.pathname === "/reload") return Response.json({ ok: true });
    if (url.pathname === "/rpc" || url.pathname === "/hub-rpc") return Response.json({ ok: true, backendHash: sha256(f.read("backend.cjs")) });
    throw new Error("Unexpected URL: " + address);
  };
  const updater = createHudUpdater({ pluginDir: f.pluginDir, fetchImpl });

  const stalePending = updater.check({ background: true });
  assert.equal(fetchCount, 1);
  // Complete same-version apply ("1.0.9") while stalePending is still in flight
  const sameApply = await updater.apply("1.0.9");
  assert.deepEqual(sameApply, { ok: true, status: "current", currentVersion: "1.0.9" });

  // Manual check must issue a 2nd fresh fetch and not reuse stalePending
  const freshManual = await updater.check();
  assert.equal(fetchCount, 2);
  assert.equal(freshManual.status, "current");

  // Letting the old generation resolve must not overwrite cachedCheck with stale unsupported/v1.0.10
  gate1.resolve();
  await stalePending;
  const afterBg = await updater.check({ background: true });
  assert.equal(afterBg.status, "current");
  assert.equal(afterBg.cached, true);
});

test("P1 #4: build-hud-update.cjs --transition builds a v1.1.5-compatible 4-file bundle and enables two-step upgrade to full bundle", async t => {
  const f = fixture(t);
  const outTransition = path.join(f.root, "transition-update.json");
  const outFull = path.join(f.root, "full-update.json");
  const scriptPath = path.join(repo, "scripts", "build-hud-update.cjs");

  const r1 = spawnSync(process.execPath, [scriptPath, "--transition", outTransition], { encoding: "utf8", timeout: 10_000 });
  assert.equal(r1.status, 0, r1.stderr);
  const r2 = spawnSync(process.execPath, [scriptPath, outFull], { encoding: "utf8", timeout: 10_000 });
  assert.equal(r2.status, 0, r2.stderr);

  const builtTransition = JSON.parse(fs.readFileSync(outTransition, "utf8"));
  const builtFull = JSON.parse(fs.readFileSync(outFull, "utf8"));
  assert.equal(Object.keys(builtTransition.files).length, 4);
  assert.equal(Object.keys(builtFull.files).length, 12);
  assert.ok(Object.hasOwn(builtFull.files, "hub-drawer-ui.js"));
  assert.ok(Object.hasOwn(builtFull.files, "hud-config.cjs"));

  // Exercise real two-step upgrade from v1.1.5 baseline 4-file validator
  const step1 = { ...builtTransition, version: "1.0.10" };
  const step2 = { ...builtFull, version: "1.0.11" };
  const updaterPath = path.join(f.pluginDir, "hub-update.cjs");
  const includedUpdater = step1.files["hub-update.cjs"];
  const validatorStart = includedUpdater.indexOf("function validateBundle(");
  const validatorEnd = includedUpdater.indexOf("\n// Publish", validatorStart);
  f.put("hub-update.cjs", includedUpdater.slice(0, validatorStart) + baselineValidateBundle + includedUpdater.slice(validatorEnd));
  f.put("hud-release.cjs", step1.files["hud-release.cjs"]);

  const runtime = {
    bridge: { url: bridge, token: bridgeToken },
    async ready() {},
    async reload(expectedHash) {
      if (expectedHash) assert.equal(expectedHash, sha256(f.read("backend.cjs")));
    },
  };
  const baselineUpdater = require(updaterPath).createHudUpdater({ pluginDir: f.pluginDir, getRuntime: () => runtime });
  assert.equal((await baselineUpdater.activateLocal(step2, step2.version)).code, "UPDATE_INVALID");
  assert.deepEqual(await baselineUpdater.activateLocal(step1, step1.version), {
    ok: true, status: "updated", currentVersion: step1.version,
  });

  delete require.cache[updaterPath];
  const upgradedUpdater = require(updaterPath).createHudUpdater({ pluginDir: f.pluginDir, getRuntime: () => runtime });
  assert.deepEqual(await upgradedUpdater.activateLocal(step2, step2.version), {
    ok: true, status: "updated", currentVersion: step2.version,
  });
  assert.equal(f.read("hub-drawer-ui.js"), step2.files["hub-drawer-ui.js"]);
  assert.equal(f.read("hud-config.cjs"), step2.files["hud-config.cjs"]);
});

test("P0 #1a: disabling autoHotUpdate while download is suspended aborts before any disk write or reload", async t => {
  const f = fixture(t);
  f.put("config.json", JSON.stringify({ autoHotUpdate: true }));
  const bytes = Buffer.from(JSON.stringify({ ...createBundle(repo, { includeOptional: false }), version: target }));
  const release = {
    tag_name: "v" + target,
    draft: false,
    prerelease: false,
    assets: [{
      name: ASSET_NAME, state: "uploaded", browser_download_url: assetUrl,
      digest: "sha256:" + sha256(bytes), size: bytes.length,
    }],
  };
  const downloadStarted = Promise.withResolvers();
  const downloadGate = Promise.withResolvers();
  let reloadCount = 0;
  const fetchImpl = async (url) => {
    const address = String(url);
    if (address === latest) return Response.json(release);
    if (address === assetUrl) return new Response(null, { status: 302, headers: { Location: cdn } });
    if (address === cdn) {
      downloadStarted.resolve();
      await downloadGate.promise;
      return new Response(bytes);
    }
    if (url.pathname === "/admin/status") {
      return Response.json({ ok: true, pid: process.pid, mounted: true, windows: [{ loading: false }] });
    }
    if (url.pathname === "/reload" || url.pathname === "/admin/reload-ui") {
      reloadCount += 1;
      return Response.json({ ok: true, results: [{ injected: true }] });
    }
    if (url.pathname === "/rpc" || url.pathname === "/hub-rpc") {
      return Response.json({ ok: true, backendHash: sha256(f.read("backend.cjs")) });
    }
    throw new Error("Unexpected URL: " + address);
  };
  const updater = createHudUpdater({ pluginDir: f.pluginDir, fetchImpl });

  const pending = updater.apply(target, { auto: true });
  await downloadStarted.promise;

  // User turns off autoHotUpdate while the bundle download is still in flight
  f.put("config.json", JSON.stringify({ autoHotUpdate: false }));
  downloadGate.resolve();

  const res = await pending;
  assert.equal(res.ok, false);
  assert.equal(res.code, "AUTO_UPDATE_DISABLED");
  assert.equal(reloadCount, 0);
  assert.equal(f.read("hud-release.json"), '{"version":"1.0.9"}');
  assert.equal(f.read("renderer-base.js"), "window.original = true;");
  assert.equal(fs.existsSync(path.join(f.pluginDir, "backups")), false);
  assert.equal(fs.existsSync(path.join(f.pluginDir, "run", "hud-update-pending.json")), false);
});

test("P0 #1b: multi-version auto attempt dedup survives UPDATE_CHANGED across separate updater instances while manual apply still works", async t => {
  const f = fixture(t);
  f.put("hud-release.json", '{"version":"1.1.5"}');
  f.put("config.json", JSON.stringify({ autoHotUpdate: true }));

  const v117 = "1.1.7";
  const v117AssetUrl = `${releaseRoot}/v${v117}/${ASSET_NAME}`;
  const v117Bytes = Buffer.from(JSON.stringify({ ...createBundle(repo, { includeOptional: false }), version: v117 }));
  const v118 = "1.1.8";
  const v118AssetUrl = `${releaseRoot}/v${v118}/${ASSET_NAME}`;
  const v118Bytes = Buffer.from(JSON.stringify({ ...createBundle(repo, { includeOptional: false }), version: v118 }));

  let activeVersion = v117;
  let failReload = true;
  let v117Activations = 0;

  const fetchImpl = async (url) => {
    const address = String(url);
    const bytes = activeVersion === v118 ? v118Bytes : v117Bytes;
    const dlUrl = activeVersion === v118 ? v118AssetUrl : v117AssetUrl;
    if (address === latest) {
      return Response.json({
        tag_name: "v" + activeVersion,
        draft: false,
        prerelease: false,
        assets: [{
          name: ASSET_NAME, state: "uploaded", browser_download_url: dlUrl,
          digest: "sha256:" + sha256(bytes), size: bytes.length,
        }],
      });
    }
    if (address === dlUrl) return new Response(null, { status: 302, headers: { Location: cdn } });
    if (address === cdn) return new Response(bytes);
    if (url.pathname === "/admin/status") {
      return Response.json({ ok: true, pid: process.pid, mounted: true, windows: [{ loading: false }] });
    }
    if (url.pathname === "/reload") return Response.json({ ok: true });
    if (url.pathname === "/admin/reload-ui") {
      const installed = JSON.parse(f.read("hud-release.json")).version;
      if (installed === v117) v117Activations += 1;
      const injected = !(failReload && installed === activeVersion);
      return Response.json({ ok: true, results: [{ injected }] });
    }
    if (url.pathname === "/rpc" || url.pathname === "/hub-rpc") {
      return Response.json({ ok: true, backendHash: sha256(f.read("backend.cjs")) });
    }
    throw new Error("Unexpected URL: " + address);
  };

  const attemptPath = path.join(f.pluginDir, "run", "hud-auto-update-attempted.json");

  // Instance 1: requests 1.1.7 -> activation fails and records 1.1.7
  const updater1 = createHudUpdater({ pluginDir: f.pluginDir, fetchImpl, now: () => 1_700_000_000_000 });
  const r1 = await updater1.apply(v117, { auto: true });
  assert.equal(r1.ok, false);
  assert.equal(r1.code, "UPDATE_FAILED");
  assert.equal(v117Activations, 1);
  const record1 = JSON.parse(fs.readFileSync(attemptPath, "utf8"));
  assert.equal(record1.versions[v117], 1_700_000_000_000);

  // Instance 2: stale window requests 1.1.6 -> UPDATE_CHANGED without polluting attempt record
  const updater2 = createHudUpdater({ pluginDir: f.pluginDir, fetchImpl, now: () => 1_700_000_001_000 });
  const r2 = await updater2.apply("1.1.6", { auto: true });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, "UPDATE_CHANGED");
  const record2 = JSON.parse(fs.readFileSync(attemptPath, "utf8"));
  assert.equal(record2.versions[v117], 1_700_000_000_000);
  assert.equal(Object.hasOwn(record2.versions, "1.1.6"), false);

  // Instance 3: requests 1.1.7 again -> AUTO_UPDATE_ALREADY_ATTEMPTED, 1.1.7 activation count stays 1
  const updater3 = createHudUpdater({ pluginDir: f.pluginDir, fetchImpl, now: () => 1_700_000_002_000 });
  const r3 = await updater3.apply(v117, { auto: true });
  assert.equal(r3.ok, false);
  assert.equal(r3.code, "AUTO_UPDATE_ALREADY_ATTEMPTED");
  assert.equal(v117Activations, 1);

  // Another version failure merges into versions map without overwriting 1.1.7
  activeVersion = v118;
  const r4 = await updater3.apply(v118, { auto: true });
  assert.equal(r4.ok, false);
  assert.equal(r4.code, "UPDATE_FAILED");
  const record4 = JSON.parse(fs.readFileSync(attemptPath, "utf8"));
  assert.equal(record4.versions[v117], 1_700_000_000_000);
  assert.equal(record4.versions[v118], 1_700_000_002_000);

  // Switching back to 1.1.7 still rejects auto apply, while manual apply succeeds and clears record
  activeVersion = v117;
  const r5 = await updater3.apply(v117, { auto: true });
  assert.equal(r5.ok, false);
  assert.equal(r5.code, "AUTO_UPDATE_ALREADY_ATTEMPTED");
  assert.equal(v117Activations, 1);

  failReload = false;
  const manualOk = await updater3.apply(v117);
  assert.deepEqual(manualOk, { ok: true, status: "updated", currentVersion: v117 });
  assert.equal(v117Activations, 2);
  assert.equal(fs.existsSync(attemptPath), false);
});

test("v1.1.6 P1 #2: writerless FIFO at config.json returns AUTO_UPDATE_DISABLED immediately without blocking or downloading", { skip: process.platform === "win32" }, t => {
  const f = fixture(t);
  const configFile = path.join(f.pluginDir, "config.json");
  fs.rmSync(configFile, { force: true });
  const mkfifo = spawnSync("mkfifo", [configFile], { encoding: "utf8" });
  assert.equal(mkfifo.status, 0, mkfifo.stderr || "mkfifo failed");
  const probe = `
    const { createHudUpdater } = require(${JSON.stringify(path.join(repo, "src", "hub-update.cjs"))});
    let fetchCalls = 0;
    const updater = createHudUpdater({
      pluginDir: ${JSON.stringify(f.pluginDir)},
      fetchImpl: async () => { fetchCalls += 1; throw new Error("unexpected fetch"); },
    });
    updater.apply(${JSON.stringify(target)}, { auto: true }).then(result => {
      process.stdout.write(JSON.stringify({ result, fetchCalls }));
    }).catch(err => {
      console.error(err);
      process.exitCode = 1;
    });
  `;
  const run = spawnSync(process.execPath, ["-e", probe], { encoding: "utf8", timeout: 3000 });
  assert.equal(run.signal, null, "FIFO read must not block until external timeout");
  assert.equal(run.status, 0, run.stderr || String(run.error || ""));
  const { result, fetchCalls } = JSON.parse(run.stdout);
  assert.equal(result.ok, false);
  assert.equal(result.code, "AUTO_UPDATE_DISABLED");
  assert.equal(fetchCalls, 0);
});
