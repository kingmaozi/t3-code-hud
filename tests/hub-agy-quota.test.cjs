"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const vm = require("node:vm");

const {
  MIN_USAGE_CLI_VERSION,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_ERROR_BACKOFF_MS,
  DEFAULT_SIGNED_OUT_BACKOFF_MS,
  createAgyQuotaReader,
  parseAgyCliUsageWindows,
  parseStrictCliVersionOutput,
  normalizeResetTime,
  outputShowsModelTurn,
  outputLooksSignedOut,
  buildUsageCliEnv,
  compareSemver,
  resolveT3Paths,
  resolveManagedAgyBinary,
  resolveAgyInstances,
  checkAgyCliQuotaEnabled,
} = require("../src/hub-agy-quota.cjs");

const VALID_RELEASE_ID = "a".repeat(64);
const SAMPLE_REQUESTED_AT = Date.UTC(2026, 10, 27, 10, 0, 0);

function makeFakeChild({ ignoreKill = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.destroyed = false;
  child.stderr.destroyed = false;
  child.stdout.destroy = () => { child.stdout.destroyed = true; };
  child.stderr.destroy = () => { child.stderr.destroyed = true; };
  child.unreffed = false;
  child.unref = () => { child.unreffed = true; };
  child.killed = false;
  child.killSignals = [];
  child.kill = (signal = "SIGTERM") => {
    child.killed = true;
    child.killSignals.push(signal);
    if (!ignoreKill && !child._closed) {
      child._closed = true;
      queueMicrotask(() => child.emit("close", null, signal));
    }
    return true;
  };
  child.finish = (code = 0) => {
    if (!child._closed) {
      child._closed = true;
      child.emit("close", code, null);
    }
  };
  return child;
}

function createFixture(t, {
  instanceId = "antigravity",
  displayName = "AGY",
  enabled = true,
  authMethod,
  binaryPath,
  releaseId = VALID_RELEASE_ID,
  execName = "antigravity",
  releaseVersion = "1.5.15",
  createProfileDir = true,
  createManagedBinary = true,
  pluginConfig = null,
  extraInstances = {},
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3-agy-q-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const t3Dir = path.join(root, ".t3");
  const userDataDir = path.join(t3Dir, "userdata");
  const toolsDir = path.join(t3Dir, "tools");
  const pluginDir = path.join(t3Dir, "hud-plugin");
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(pluginDir, { recursive: true });

  const providerInstances = {
    [instanceId]: {
      driver: "antigravity",
      displayName,
      enabled,
      ...(authMethod ? { authMethod } : {}),
      config: {
        ...(binaryPath ? { binaryPath } : {}),
      },
    },
    ...extraInstances,
  };
  fs.writeFileSync(
    path.join(userDataDir, "settings.json"),
    JSON.stringify({ providerInstances }, null, 2)
  );

  if (pluginConfig !== null) {
    const text = typeof pluginConfig === "string" ? pluginConfig : JSON.stringify(pluginConfig, null, 2);
    fs.writeFileSync(path.join(pluginDir, "config.json"), text);
  }

  const profileHash = crypto.createHash("sha256").update(instanceId, "utf8").digest("hex");
  const profileDir = path.join(userDataDir, "providers", "antigravity", profileHash);
  if (createProfileDir) {
    fs.mkdirSync(profileDir, { recursive: true });
  }

  let managedBinPath = null;
  if (createManagedBinary) {
    const archDir = path.join(toolsDir, "antigravity-acp", `${platform}-${arch}`);
    const versionDir = path.join(archDir, "versions", releaseId);
    fs.mkdirSync(versionDir, { recursive: true });
    fs.writeFileSync(path.join(archDir, "active.json"), JSON.stringify({ releaseId }));
    fs.writeFileSync(
      path.join(versionDir, ".install-complete.json"),
      JSON.stringify({
        releaseId,
        version: releaseVersion,
        executable: { name: execName },
      })
    );
    managedBinPath = path.join(versionDir, execName);
    fs.writeFileSync(managedBinPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }

  return {
    root,
    t3Dir,
    userDataDir,
    toolsDir,
    pluginDir,
    profileDir,
    profileHash,
    managedBinPath,
    platform,
    arch,
  };
}

function runIsolatedReader(homeDir, clock) {
  const script = `
    const { createAgyQuotaReader } = require(process.argv[1]);
    let spawns = 0;
    const reader = createAgyQuotaReader({
      homeDir: process.argv[2],
      now: () => Number(process.argv[3]),
      spawnImpl() { spawns++; throw new Error("unexpected spawn in second process"); },
    });
    reader.readAgyQuotas({ force: true }).then(result => {
      process.stdout.write(JSON.stringify({ spawns, result }));
    });
  `;
  const run = spawnSync(process.execPath, [
    "-e", script, require.resolve("../src/hub-agy-quota.cjs"), homeDir, String(clock),
  ], { encoding: "utf8", timeout: 10_000, env: { HOME: homeDir } });
  assert.equal(run.status, 0, run.stderr || String(run.error || ""));
  const response = JSON.parse(run.stdout);
  assert.equal(response.spawns, 0);
  return response.result;
}


function makeUsageEnvelope({
  requestedAt = SAMPLE_REQUESTED_AT,
  extraGroups = [],
} = {}) {
  const untouched5hReset = new Date(requestedAt + 300 * 60_000 + 5_000).toISOString();
  const real5hReset = new Date(requestedAt + 120 * 60_000).toISOString();
  const realWeeklyReset = new Date(requestedAt + 3 * 86400 * 1000).toISOString();

  return JSON.stringify({
    status: "SUCCESS",
    num_turns: 0,
    conversation_id: "",
    command: {
      name: "usage",
      data: {
        groups: [
          {
            id: "gemini-argon",
            name: "Gemini Argon",
            buckets: [
              {
                id: "gemini-argon-weekly",
                window: "weekly",
                remaining_fraction: 0.4,
                reset_time: realWeeklyReset,
              },
            ],
          },
          {
            id: "3p",
            name: "Third Party",
            buckets: [
              {
                id: "3p-5h",
                window: "5h",
                remaining_fraction: 0.51,
                reset_time: real5hReset,
              },
              {
                id: "3p-weekly",
                window: "weekly",
                remaining_fraction: 0.47,
                reset_time: realWeeklyReset,
              },
            ],
          },
          {
            id: "gemini",
            name: "Gemini",
            buckets: [
              {
                id: "gemini-weekly",
                window: "weekly",
                remaining_fraction: 0.95,
                reset_time: realWeeklyReset,
              },
              {
                id: "gemini-5h",
                window: "5h",
                remaining_fraction: 1,
                reset_time: untouched5hReset,
              },
              {
                id: "gemini-disabled",
                window: "5h",
                disabled: true,
                remaining_fraction: 0.1,
              },
              {
                id: "gemini-invalid",
                window: "5h",
                remaining_fraction: null,
              },
            ],
          },
          ...extraGroups,
        ],
      },
    },
  });
}

// --- Fix #1: Verified T3-managed binary only, component-by-component symlink guard, fail-closed config ---

test("Fix #1: resolves verified T3-managed binary only, rejects arbitrary binaryPath, parent/leaf symlinks, traversal, and fail-closed corrupt/symlink config.json", async (t) => {
  const fx = createFixture(t, {
    instanceId: "antigravity-work",
    displayName: "AGY Work",
    extraInstances: {
      agy_disabled: { driver: "antigravity", enabled: false },
      agy_apikey: { driver: "antigravity", enabled: true, authMethod: "gemini-api-key" },
      agy_platform: { driver: "antigravity", enabled: true, config: { authMethod: "agent-platform" } },
      codex: { driver: "codex", enabled: true },
    },
  });

  const instances = resolveAgyInstances({ homeDir: fx.root, userDataDir: fx.userDataDir });
  assert.equal(instances.length, 1);
  assert.equal(instances[0].instanceId, "antigravity-work");
  assert.equal(instances[0].displayName, "AGY Work");
  assert.equal(instances[0].profileDir, fx.profileDir);

  const bin = resolveManagedAgyBinary({
    homeDir: fx.root,
    userDataDir: fx.userDataDir,
    toolsDir: fx.toolsDir,
    platform: fx.platform,
    arch: fx.arch,
  });
  assert.ok(bin);
  assert.equal(bin.binPath, fx.managedBinPath);
  assert.equal(bin.source, "managed");

  // Explicit config.binaryPath matching exact verified managed binary is allowed
  const matchingResolved = resolveManagedAgyBinary({
    homeDir: fx.root,
    userDataDir: fx.userDataDir,
    toolsDir: fx.toolsDir,
    binaryPath: fx.managedBinPath,
  });
  assert.equal(matchingResolved?.binPath, fx.managedBinPath);

  // Arbitrary unverified config.binaryPath MUST be rejected before spawn (0 spawns)
  const customBin = path.join(fx.root, "custom-agy");
  fs.writeFileSync(customBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  assert.equal(
    resolveManagedAgyBinary({ homeDir: fx.root, userDataDir: fx.userDataDir, toolsDir: fx.toolsDir, binaryPath: customBin }),
    null,
    "Arbitrary custom binaryPath outside verified T3-managed release must be rejected"
  );

  // End-to-end check: unverified custom binaryPath in settings.json causes 0 spawns
  const fxArbitrary = createFixture(t, { binaryPath: customBin });
  let spawns = 0;
  const rArb = createAgyQuotaReader({
    homeDir: fxArbitrary.root,
    spawnImpl: () => { spawns++; return makeFakeChild(); },
  });
  assert.equal((await rArb.readAgyQuotas()).available, false);
  assert.equal(spawns, 0, "Unverified binaryPath must trigger 0 spawns");

  // Parent directory symlink (tools/antigravity-acp -> external dir) rejected before spawn
  const fxParentSym = createFixture(t, { createManagedBinary: false });
  const externalTools = path.join(fxParentSym.root, "external-acp");
  const extVersionDir = path.join(externalTools, `${fxParentSym.platform}-${fxParentSym.arch}`, "versions", VALID_RELEASE_ID);
  fs.mkdirSync(extVersionDir, { recursive: true });
  fs.writeFileSync(path.join(externalTools, `${fxParentSym.platform}-${fxParentSym.arch}`, "active.json"), JSON.stringify({ releaseId: VALID_RELEASE_ID }));
  fs.writeFileSync(path.join(extVersionDir, ".install-complete.json"), JSON.stringify({ releaseId: VALID_RELEASE_ID, executable: { name: "antigravity" } }));
  fs.writeFileSync(path.join(extVersionDir, "antigravity"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.mkdirSync(fxParentSym.toolsDir, { recursive: true });
  fs.symlinkSync(externalTools, path.join(fxParentSym.toolsDir, "antigravity-acp"));
  const rParentSym = createAgyQuotaReader({
    homeDir: fxParentSym.root,
    spawnImpl: () => { spawns++; return makeFakeChild(); },
  });
  assert.equal((await rParentSym.readAgyQuotas()).available, false);
  assert.equal(spawns, 0, "Parent symlink in tools path must trigger 0 spawns");

  // Malformed releaseId, path traversal in executable.name, and leaf symlink executable rejected
  const archDir = path.join(fx.toolsDir, "antigravity-acp", `${fx.platform}-${fx.arch}`);
  fs.writeFileSync(path.join(archDir, "active.json"), JSON.stringify({ releaseId: "../escape" }));
  assert.equal(resolveManagedAgyBinary({ homeDir: fx.root, toolsDir: fx.toolsDir }), null);

  fs.writeFileSync(path.join(archDir, "active.json"), JSON.stringify({ releaseId: VALID_RELEASE_ID }));
  const versionDir = path.join(archDir, "versions", VALID_RELEASE_ID);
  fs.writeFileSync(
    path.join(versionDir, ".install-complete.json"),
    JSON.stringify({ releaseId: VALID_RELEASE_ID, executable: { name: "../custom-agy" } })
  );
  assert.equal(resolveManagedAgyBinary({ homeDir: fx.root, toolsDir: fx.toolsDir }), null);

  fs.unlinkSync(fx.managedBinPath);
  fs.symlinkSync(customBin, fx.managedBinPath);
  fs.writeFileSync(
    path.join(versionDir, ".install-complete.json"),
    JSON.stringify({ releaseId: VALID_RELEASE_ID, executable: { name: "antigravity" } })
  );
  assert.equal(resolveManagedAgyBinary({ homeDir: fx.root, toolsDir: fx.toolsDir }), null);

  // Fail-closed config.json: corrupt JSON and symlink config.json both block with 0 spawns
  const fxCorrupt = createFixture(t, { pluginConfig: "{ broken json" });
  assert.equal(checkAgyCliQuotaEnabled(fxCorrupt.pluginDir, fxCorrupt.t3Dir).enabled, false);
  const rCorrupt = createAgyQuotaReader({
    homeDir: fxCorrupt.root,
    spawnImpl: () => { spawns++; return makeFakeChild(); },
  });
  const corruptRes = await rCorrupt.readAgyQuotas();
  assert.equal(corruptRes.available, false);
  assert.equal(corruptRes.reason, "config_invalid");
  assert.equal(spawns, 0, "Corrupt config.json must fail closed with 0 spawns");

  const fxSymConfig = createFixture(t);
  const outsideCfg = path.join(fxSymConfig.root, "outside-config.json");
  fs.writeFileSync(outsideCfg, JSON.stringify({ agyCliQuotaEnabled: true }));
  fs.symlinkSync(outsideCfg, path.join(fxSymConfig.pluginDir, "config.json"));
  assert.equal(checkAgyCliQuotaEnabled(fxSymConfig.pluginDir, fxSymConfig.t3Dir).enabled, false);
  const rSymCfg = createAgyQuotaReader({
    homeDir: fxSymConfig.root,
    spawnImpl: () => { spawns++; return makeFakeChild(); },
  });
  const symCfgRes = await rSymCfg.readAgyQuotas();
  assert.equal(symCfgRes.available, false);
  assert.equal(symCfgRes.reason, "config_unsafe");
  assert.equal(spawns, 0, "Symlink config.json must fail closed with 0 spawns");

  // Missing settings.json & explicit agyCliQuotaEnabled:false -> 0 spawns
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "t3-agy-empty-"));
  t.after(() => fs.rmSync(emptyHome, { recursive: true, force: true }));
  const emptyReader = createAgyQuotaReader({
    homeDir: emptyHome,
    spawnImpl: () => { spawns++; return makeFakeChild(); },
  });
  assert.deepEqual(await emptyReader.readAgyQuotas(), { ok: true, available: false, providers: [] });

  const fxDisabled = createFixture(t, { pluginConfig: { agyCliQuotaEnabled: false } });
  const disabledReader = createAgyQuotaReader({
    homeDir: fxDisabled.root,
    spawnImpl: () => { spawns++; return makeFakeChild(); },
  });
  assert.deepEqual(await disabledReader.readAgyQuotas(), {
    ok: true,
    available: false,
    reason: "disabled_by_config",
    providers: [],
  });
  assert.equal(spawns, 0);
});

test("trust checks start above custom anchors and enforce the managed executable byte count", async t => {
  const fx = createFixture(t);
  const calls = [];
  const spawnImpl = (bin, args) => { calls.push([bin, args]); throw new Error("unexpected spawn"); };
  const aliasedHome = path.join(fx.root, "aliased-parent");
  fs.symlinkSync(fx.root, aliasedHome);
  const viaAlias = value => path.join(aliasedHome, path.relative(fx.root, value));
  const unsafePaths = [
    { homeDir: aliasedHome },
    { t3CodeHome: viaAlias(fx.t3Dir) },
    { userDataDir: viaAlias(fx.userDataDir) },
    { toolsDir: viaAlias(fx.toolsDir) },
    { pluginDir: viaAlias(fx.pluginDir) },
  ];
  for (const options of unsafePaths) {
    const reader = createAgyQuotaReader({ homeDir: fx.root, ...options, spawnImpl });
    assert.equal((await reader.readAgyQuotas()).available, false, JSON.stringify(options));
  }

  const complete = path.join(path.dirname(fx.managedBinPath), ".install-complete.json");
  const record = JSON.parse(fs.readFileSync(complete, "utf8"));
  record.executable.bytes = fs.statSync(fx.managedBinPath).size;
  fs.writeFileSync(complete, JSON.stringify(record));
  assert.ok(resolveManagedAgyBinary({ homeDir: fx.root }));
  record.executable.bytes += 1;
  fs.writeFileSync(complete, JSON.stringify(record));
  assert.equal(resolveManagedAgyBinary({ homeDir: fx.root }), null);
  assert.equal((await createAgyQuotaReader({ homeDir: fx.root, spawnImpl }).readAgyQuotas()).available, false);
  assert.deepEqual(calls, []);
});

test("rechecks a queued executable before version and rechecks the active record before usage", async t => {
  const fx = createFixture(t, { extraInstances: { queued: { driver: "antigravity" } } });
  const queuedProfile = path.join(path.dirname(fx.profileDir), crypto.createHash("sha256").update("queued").digest("hex"));
  fs.mkdirSync(queuedProfile);
  const calls = [];
  const reader = createAgyQuotaReader({
    homeDir: fx.root,
    spawnImpl(bin, args, options) {
      calls.push([args[0], options.env.GEMINI_HOME]);
      const child = makeFakeChild();
      queueMicrotask(() => {
        const replacement = bin + ".replacement";
        fs.copyFileSync(bin, replacement);
        fs.renameSync(replacement, bin);
        child.stdout.emit("data", "1.5.15\n");
        child.finish(0);
      });
      return child;
    },
  });
  assert.equal((await reader.readAgyQuotas()).available, false);
  assert.deepEqual(calls, [["--version", fx.profileDir]]);

  const changed = createFixture(t);
  const phases = [];
  const metadataReader = createAgyQuotaReader({
    homeDir: changed.root,
    spawnImpl(bin, args) {
      phases.push(args[0]);
      const child = makeFakeChild();
      queueMicrotask(() => {
        const recordPath = path.join(path.dirname(bin), ".install-complete.json");
        const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
        record.version = "1.6.0";
        fs.writeFileSync(recordPath, JSON.stringify(record));
        child.stdout.emit("data", "1.5.15\n");
        child.finish(0);
      });
      return child;
    },
  });
  assert.equal((await metadataReader.readAgyQuotas()).available, false);
  assert.deepEqual(phases, ["--version"]);
});

test("a version process with valid stdout and a login prompt on stderr stops and shares the 600s backoff", async t => {
  const fx = createFixture(t);
  let clock = SAMPLE_REQUESTED_AT;
  const starts = [];
  const options = {
    homeDir: fx.root, now: () => clock,
    spawnImpl(bin, args, opts) {
      starts.push(args[0]);
      assert.equal(opts.env.GEMINI_HOME, fx.profileDir);
      const child = makeFakeChild();
      queueMicrotask(() => {
        child.stdout.emit("data", "1.5.15\n");
        child.stderr.emit("data", "Authentication re");
        assert.equal(child.killed, false);
        child.stderr.emit("data", "quired. Please visit the URL.");
        assert.deepEqual(child.killSignals, ["SIGTERM"]);
      });
      return child;
    },
  };
  assert.equal((await createAgyQuotaReader(options).readAgyQuotas()).available, false);
  clock += DEFAULT_SIGNED_OUT_BACKOFF_MS - 1;
  assert.equal((await createAgyQuotaReader(options).readAgyQuotas({ force: true })).available, false);
  assert.equal(runIsolatedReader(fx.root, clock).available, false);
  assert.deepEqual(starts, ["--version"]);
});

// --- Fix #2: Strong profile isolation, minimal env allowlist, non-interactive browser block ---

test("Fix #2: skips missing/symlink profileDir with 0 spawns and uses minimal env allowlist + non-interactive browser vars", async (t) => {
  let spawns = 0;

  // Missing profileDir -> 0 spawns
  const fxMissingProfile = createFixture(t, { createProfileDir: false });
  const rMissing = createAgyQuotaReader({
    homeDir: fxMissingProfile.root,
    spawnImpl: () => { spawns++; return makeFakeChild(); },
  });
  assert.equal((await rMissing.readAgyQuotas()).available, false);
  assert.equal(spawns, 0, "Missing profileDir must never spawn CLI");

  // Symlinked profileDir -> 0 spawns
  const fxSymProfile = createFixture(t, { createProfileDir: false });
  const realProfile = path.join(fxSymProfile.root, "real-profile");
  fs.mkdirSync(realProfile, { recursive: true });
  fs.mkdirSync(path.dirname(fxSymProfile.profileDir), { recursive: true });
  fs.symlinkSync(realProfile, fxSymProfile.profileDir);
  const rSymProf = createAgyQuotaReader({
    homeDir: fxSymProfile.root,
    spawnImpl: () => { spawns++; return makeFakeChild(); },
  });
  assert.equal((await rSymProf.readAgyQuotas()).available, false);
  assert.equal(spawns, 0, "Symlinked profileDir must never spawn CLI");

  // Symlinked parent directory (providers/antigravity) -> 0 spawns
  const fxSymParent = createFixture(t, { createProfileDir: false });
  const outsideAgyDir = path.join(fxSymParent.root, "outside-agy-profiles");
  fs.mkdirSync(path.join(outsideAgyDir, fxSymParent.profileHash), { recursive: true });
  fs.mkdirSync(path.join(fxSymParent.userDataDir, "providers"), { recursive: true });
  fs.symlinkSync(outsideAgyDir, path.join(fxSymParent.userDataDir, "providers", "antigravity"));
  const rSymParent = createAgyQuotaReader({
    homeDir: fxSymParent.root,
    spawnImpl: () => { spawns++; return makeFakeChild(); },
  });
  assert.equal((await rSymParent.readAgyQuotas()).available, false);
  assert.equal(spawns, 0, "Symlinked providers/antigravity parent must never spawn CLI");

  // Minimal allowlist env check: arbitrary custom credentials MUST NOT leak into child env
  const fx = createFixture(t);
  const dirtyEnv = {
    PATH: "/usr/bin:/bin",
    HOME: fx.root,
    LANG: "en_US.UTF-8",
    TERM: "xterm-256color",
    OPENAI_API_KEY: "sk-openai-secret",
    ANTHROPIC_API_KEY: "sk-ant-secret",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    CUSTOM_CORP_TOKEN: "corp-secret",
    GEMINI_API_KEY: "secret-gemini",
    GOOGLE_API_KEY: "secret-google",
    GEMINI_HOME: "/wrong/home",
    BROWSER: "/usr/bin/open",
    ELECTRON_RUN_AS_NODE: "1",
    SSH_AUTH_SOCK: "/tmp/ssh.sock",
    ANTIGRAVITY_TOKEN: "secret-agy",
    AGY_SESSION_ID: "secret-session",
  };

  const cleanEnv = buildUsageCliEnv(dirtyEnv, fx.profileDir, {
    platform: "darwin",
    userDataAnchor: fx.t3Dir,
    requireProfileDir: true,
  });
  assert.ok(cleanEnv);
  assert.equal(cleanEnv.PATH, "/usr/bin:/bin");
  assert.equal(cleanEnv.HOME, fx.root);
  assert.equal(cleanEnv.GEMINI_HOME, fx.profileDir);
  assert.equal(cleanEnv.AGY_CLI_DISABLE_AUTO_UPDATE, "true");
  assert.equal(cleanEnv.NO_BROWSER, "1");
  assert.equal(cleanEnv.BROWSER, "/usr/bin/false");
  for (const forbidden of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "AWS_SECRET_ACCESS_KEY",
    "CUSTOM_CORP_TOKEN",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "ELECTRON_RUN_AS_NODE",
    "SSH_AUTH_SOCK",
    "ANTIGRAVITY_TOKEN",
    "AGY_SESSION_ID",
  ]) {
    assert.equal(Object.hasOwn(cleanEnv, forbidden), false, `Allowlist must exclude ${forbidden}`);
  }
  assert.equal(
    buildUsageCliEnv(dirtyEnv, path.join(fx.root, "missing"), { requireProfileDir: true }),
    null,
    "requireProfileDir must reject missing profileDir"
  );

  let capturedUsageCall = null;
  let capturedVersionCall = null;
  const reader = createAgyQuotaReader({
    homeDir: fx.root,
    baseEnv: dirtyEnv,
    spawnImpl: (bin, args, opts) => {
      const child = makeFakeChild();
      if (args[0] === "--version") {
        capturedVersionCall = opts;
        queueMicrotask(() => { child.stdout.emit("data", "1.5.15\n"); child.finish(0); });
      } else {
        capturedUsageCall = { bin, args, opts };
        queueMicrotask(() => {
          child.stdout.emit("data", makeUsageEnvelope() + "\n");
          child.finish(0);
        });
      }
      return child;
    },
  });

  await reader.readAgyQuotas();
  assert.ok(capturedUsageCall);
  assert.deepEqual(capturedVersionCall, capturedUsageCall.opts, "Both phases use the same isolated environment and closed stdin");
  assert.deepEqual(capturedUsageCall.args, [
    "-p",
    "/usage",
    "--output-format",
    "json",
    "--print-timeout",
    "20s",
    "--log-file",
    process.platform === "win32" ? "NUL" : "/dev/null",
  ]);
  assert.equal(capturedUsageCall.args.includes("--disable-slash-commands"), false);
  assert.deepEqual(capturedUsageCall.opts.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(capturedUsageCall.opts.env.GEMINI_HOME, fx.profileDir);
  assert.equal(capturedUsageCall.opts.env.AGY_CLI_DISABLE_AUTO_UPDATE, "true");
  assert.equal(capturedUsageCall.opts.env.NO_BROWSER, "1");
  assert.equal(Object.hasOwn(capturedUsageCall.opts.env, "OPENAI_API_KEY"), false);
  assert.equal(Object.hasOwn(capturedUsageCall.opts.env, "CUSTOM_CORP_TOKEN"), false);
});

// --- Fix #3: Strict --version parsing, pre-usage identity re-check, streaming + persistent latch, hard kill deadline ---

test("Fix #3: strict version parsing rejects embedded numbers in unrelated text and allows official formats >= 1.1.11", async (t) => {
  assert.equal(compareSemver("1.1.11", MIN_USAGE_CLI_VERSION), 0);
  assert.equal(compareSemver("1.5.15", MIN_USAGE_CLI_VERSION), 1);
  assert.equal(compareSemver("1.1.10", MIN_USAGE_CLI_VERSION), -1);
  assert.equal(compareSemver("1.1.11-rc.1", MIN_USAGE_CLI_VERSION), -1);

  assert.equal(parseStrictCliVersionOutput("1.5.15\n")?.raw, "1.5.15");
  assert.equal(parseStrictCliVersionOutput("v1.5.15\n")?.raw, "1.5.15");
  assert.equal(parseStrictCliVersionOutput("antigravity 1.5.15\n")?.raw, "1.5.15");
  assert.equal(parseStrictCliVersionOutput("agy cli v1.5.15\n")?.raw, "1.5.15");
  assert.equal(parseStrictCliVersionOutput("Error connecting to 127.0.0.1 (node 22.1.0)\n"), null);
  assert.equal(parseStrictCliVersionOutput("See docs 2.0.0 for details\n"), null);
  assert.equal(parseStrictCliVersionOutput("line1\n1.5.15\n"), null);

  // Unrelated text containing version-like numbers must NOT pass version gate
  const fxNoise = createFixture(t, { releaseVersion: "" });
  const noiseCalls = [];
  const noiseReader = createAgyQuotaReader({
    homeDir: fxNoise.root,
    spawnImpl: (bin, args) => {
      noiseCalls.push(args);
      const child = makeFakeChild();
      queueMicrotask(() => {
        child.stdout.emit("data", "Warning: proxy 9.9.9 failed\n");
        child.finish(0);
      });
      return child;
    },
  });
  assert.equal((await noiseReader.readAgyQuotas()).available, false);
  assert.deepEqual(noiseCalls, [["--version"]], "Must reject non-official version text before /usage");

  // Old binary (< 1.1.11) blocked before /usage
  const fxOld = createFixture(t, { releaseVersion: "" });
  const oldCalls = [];
  const oldReader = createAgyQuotaReader({
    homeDir: fxOld.root,
    spawnImpl: (bin, args) => {
      oldCalls.push(args);
      const child = makeFakeChild();
      queueMicrotask(() => {
        child.stdout.emit("data", "agy 1.1.10\n");
        child.finish(0);
      });
      return child;
    },
  });
  assert.equal((await oldReader.readAgyQuotas()).available, false);
  assert.deepEqual(oldCalls, [["--version"]], "Must NEVER invoke /usage on < 1.1.11");
});

test("Fix #3: streaming model-turn kill persists latch across reader reload and process restart, blocks queued instances, and enforces hard kill deadline", async (t) => {
  assert.equal(outputShowsModelTurn('{"num_turns":0,"conversation_id":""}\n'), false);
  assert.equal(outputShowsModelTurn('{"num_turns":1,"conversation_id":""}\n'), true);
  assert.equal(outputShowsModelTurn('{"num_turns":0,"conversation_id":"conv-123"}\n'), true);

  // Two instances sharing the same binary: instance 1 triggers streaming model turn -> kills live, latches, blocks queued instance 2
  const fx = createFixture(t, {
    instanceId: "agy-one",
    extraInstances: {
      "agy-two": { driver: "antigravity", displayName: "AGY Two", enabled: true },
    },
  });
  const profileTwo = path.join(
    fx.userDataDir,
    "providers",
    "antigravity",
    crypto.createHash("sha256").update("agy-two", "utf8").digest("hex")
  );
  fs.mkdirSync(profileTwo, { recursive: true });

  let usageCalls = 0;
  let usageChild = null;
  const reader1 = createAgyQuotaReader({
    homeDir: fx.root,
    spawnImpl: (bin, args) => {
      const child = makeFakeChild();
      if (args[0] === "--version") {
        queueMicrotask(() => { child.stdout.emit("data", "1.5.15\n"); child.finish(0); });
      } else {
        usageCalls++;
        usageChild = child;
        // Emit streaming chunk with num_turns: 1 without closing -> reader must kill immediately
        queueMicrotask(() => {
          child.stdout.emit("data", makeUsageEnvelope());
          child.stderr.emit("data", '{"status":"RUNNING","num_tu');
          child.stderr.emit("data", 'rns":1,');
          assert.equal(child.killed, true, "Kill before terminal output arrives");
        });
      }
      return child;
    },
  });

  const res1 = await reader1.readAgyQuotas();
  assert.equal(res1.available, false);
  assert.equal(usageCalls, 1, "Queued second instance sharing binary must be blocked by latch");
  assert.equal(usageChild.killed, true, "Streaming model turn must kill child immediately");

  // Verify latch file persisted at 0600 inside pluginDir/run/agy-quota-latch.json
  const latchFile = path.join(fx.pluginDir, "run", "agy-quota-latch.json");
  assert.equal(fs.existsSync(latchFile), true);
  assert.equal(fs.lstatSync(latchFile).mode & 0o777, 0o600);

  // Simulate hot reload (brand new reader instance, globalThis.__t3HubAgyQuotaLatch still set)
  const reader2 = createAgyQuotaReader({
    homeDir: fx.root,
    spawnImpl: () => { usageCalls++; return makeFakeChild(); },
  });
  assert.equal((await reader2.readAgyQuotas({ force: true })).available, false);
  assert.equal(usageCalls, 1, "New reader after hot reload must stay latched off");

  // Simulate full process restart (clear globalThis latch, keep disk latch file)
  const savedGlobal = globalThis.__t3HubAgyQuotaLatch;
  t.after(() => { globalThis.__t3HubAgyQuotaLatch = savedGlobal; });
  globalThis.__t3HubAgyQuotaLatch = new Set();
  const reader3 = createAgyQuotaReader({
    homeDir: fx.root,
    spawnImpl: () => { usageCalls++; return makeFakeChild(); },
  });
  assert.equal((await reader3.readAgyQuotas({ force: true })).available, false);
  assert.equal(usageCalls, 1, "New reader after process restart must stay latched off via disk file");
  assert.equal(runIsolatedReader(fx.root, Date.now() + DEFAULT_CACHE_TTL_MS).available, false);

  // Pre-usage binary identity re-verification: if binary is modified between --version and /usage, refuse /usage
  const fxMutate = createFixture(t);
  let mutateUsageCalls = 0;
  const mutateReader = createAgyQuotaReader({
    homeDir: fxMutate.root,
    spawnImpl: (bin, args) => {
      const child = makeFakeChild();
      if (args[0] === "--version") {
        queueMicrotask(() => {
          // Mutate binary contents (changes size) during --version
          fs.writeFileSync(fxMutate.managedBinPath, "#!/bin/sh\necho swapped\nexit 0\n", { mode: 0o755 });
          child.stdout.emit("data", "1.5.15\n");
          child.finish(0);
        });
      } else {
        mutateUsageCalls++;
        queueMicrotask(() => child.finish(0));
      }
      return child;
    },
  });
  assert.equal((await mutateReader.readAgyQuotas()).available, false);
  assert.equal(mutateUsageCalls, 0, "Binary modified between --version and /usage must not spawn /usage");

  // Hard kill deadline: child that ignores SIGTERM AND SIGKILL (never emits close) still settles cleanly
  const fxUnkillable = createFixture(t);
  let unkillableChild = null;
  const unkillableReader = createAgyQuotaReader({
    homeDir: fxUnkillable.root,
    probeTimeoutMs: 30,
    sigkillGraceMs: 25,
    hardKillDeadlineMs: 25,
    rpcWaitMs: 500,
    spawnImpl: (bin, args) => {
      if (args[0] === "--version") {
        const c = makeFakeChild();
        queueMicrotask(() => { c.stdout.emit("data", "1.5.15\n"); c.finish(0); });
        return c;
      }
      unkillableChild = makeFakeChild({ ignoreKill: true });
      return unkillableChild;
    },
  });
  const unkillRes = await unkillableReader.readAgyQuotas();
  assert.equal(unkillRes.ok, true);
  assert.equal(unkillRes.available, false);
  assert.equal(unkillRes.pending, undefined, "Single-flight must settle cleanly past hard kill deadline");
  assert.deepEqual(unkillableChild.killSignals, ["SIGTERM", "SIGKILL"]);
  assert.equal(unkillableChild.stdout.destroyed, true);
  assert.equal(unkillableChild.stderr.destroyed, true);
  assert.equal(unkillableChild.unreffed, true);
});

// --- Fix #4: Hard 600s rate limit & 600s signed-out backoff (even with force:true) + mid-flight config disable ---

test("Fix #4: 600s TTL & 600s signed-out backoff apply even to force:true, and mid-flight config disable immediately aborts", async (t) => {
  assert.equal(DEFAULT_CACHE_TTL_MS, 600_000);
  assert.equal(DEFAULT_ERROR_BACKOFF_MS, 300_000);
  assert.equal(DEFAULT_SIGNED_OUT_BACKOFF_MS, 600_000);
  assert.equal(outputLooksSignedOut("Authentication required. Please visit the URL: https://accounts.google.com/..."), true);
  assert.equal(outputLooksSignedOut("Error: not logged in"), true);
  assert.equal(outputLooksSignedOut("not signed in"), true);
  assert.equal(outputLooksSignedOut("Please run agy login first"), true);
  assert.equal(outputLooksSignedOut("No credentials available"), true);
  assert.equal(outputLooksSignedOut("AGY_ERROR status=UNAUTHENTICATED"), true);
  assert.equal(outputLooksSignedOut('{"type":"AGY_ERROR","error_code":401}'), true);
  assert.equal(outputLooksSignedOut('{"status":"SUCCESS"}'), false);

  // 1. Concurrent normal + force:true dedupes to 1 spawn; subsequent force:true within 600s does NOT re-spawn
  const fx = createFixture(t);
  let clock = SAMPLE_REQUESTED_AT;
  let usageCalls = 0;
  let nextSignedOut = false;

  const reader = createAgyQuotaReader({
    homeDir: fx.root,
    now: () => clock,
    spawnImpl: (bin, args) => {
      const child = makeFakeChild();
      if (args[0] === "--version") {
        queueMicrotask(() => { child.stdout.emit("data", "1.5.15\n"); child.finish(0); });
      } else {
        usageCalls++;
        if (nextSignedOut) {
          queueMicrotask(() => {
            child.stderr.emit("data", "Authentication required. Please visit the URL: https://example.com/auth\n");
          });
        } else {
          queueMicrotask(() => {
            child.stdout.emit("data", makeUsageEnvelope({ requestedAt: clock }) + "\n");
            child.finish(0);
          });
        }
      }
      return child;
    },
  });

  const [a, b] = await Promise.all([reader.readAgyQuotas(), reader.readAgyQuotas({ force: true })]);
  assert.equal(a.available, true);
  assert.equal(b.available, true);
  assert.equal(usageCalls, 1, "Concurrent normal + force:true must trigger only 1 probe");

  // Force calls inside 600s cache TTL must NOT bypass rate limit
  clock += DEFAULT_CACHE_TTL_MS - 1_000;
  const forcedWithinTtl = await reader.readAgyQuotas({ force: true });
  assert.equal(forcedWithinTtl.available, true);
  assert.equal(forcedWithinTtl.cached, true);
  assert.equal(usageCalls, 1, "force:true within 600s TTL must not trigger another /usage");

  // Past 600s TTL, trigger signed-out -> 600s backoff blocks even force:true
  clock += 2_000;
  nextSignedOut = true;
  const signedOutRes = await reader.readAgyQuotas();
  assert.equal(signedOutRes.available, false);
  assert.equal(usageCalls, 2);

  clock += DEFAULT_SIGNED_OUT_BACKOFF_MS - 5_000;
  const forcedDuringSignedOut = await reader.readAgyQuotas({ force: true });
  assert.equal(forcedDuringSignedOut.available, false);
  assert.equal(usageCalls, 2, "force:true within 600s signed-out backoff must not re-probe");

  // Past 600s signed-out backoff -> allowed again
  clock += 6_000;
  nextSignedOut = false;
  const recovered = await reader.readAgyQuotas();
  assert.equal(recovered.available, true);
  assert.equal(usageCalls, 3);

  // 2. Flipping config.json to agyCliQuotaEnabled:false during --version aborts and never spawns /usage
  const fxDisableVer = createFixture(t);
  let verChild = null;
  let verUsageCalls = 0;
  const rDisableVer = createAgyQuotaReader({
    homeDir: fxDisableVer.root,
    configPollMs: 15,
    rpcWaitMs: 500,
    spawnImpl: (bin, args) => {
      const child = makeFakeChild();
      if (args[0] === "--version") {
        verChild = child;
      } else {
        verUsageCalls++;
      }
      return child;
    },
  });
  const pVer = rDisableVer.readAgyQuotas();
  await new Promise((r) => setTimeout(r, 10));
  fs.writeFileSync(path.join(fxDisableVer.pluginDir, "config.json"), JSON.stringify({ agyCliQuotaEnabled: false }));
  const resDisableVer = await pVer;
  assert.equal(verChild.killed, true, "Disabling config during --version must kill child");
  assert.equal(verUsageCalls, 0, "Must never start /usage after config disabled during --version");
  assert.equal(resDisableVer.available, false);
  assert.equal(resDisableVer.reason, "disabled_by_config");

  // 3. Flipping config.json to agyCliQuotaEnabled:false during /usage aborts immediately and does NOT publish result
  const fxDisableUsage = createFixture(t);
  let activeUsageChild = null;
  const rDisableUsage = createAgyQuotaReader({
    homeDir: fxDisableUsage.root,
    configPollMs: 15,
    rpcWaitMs: 500,
    spawnImpl: (bin, args) => {
      const child = makeFakeChild();
      if (args[0] === "--version") {
        queueMicrotask(() => { child.stdout.emit("data", "1.5.15\n"); child.finish(0); });
      } else {
        activeUsageChild = child;
      }
      return child;
    },
  });
  const pUsage = rDisableUsage.readAgyQuotas();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(activeUsageChild, "/usage child should be running");
  fs.writeFileSync(path.join(fxDisableUsage.pluginDir, "config.json"), JSON.stringify({ agyCliQuotaEnabled: false }));
  const resDisableUsage = await pUsage;
  assert.equal(activeUsageChild.killed, true, "Disabling config during /usage must kill child immediately");
  assert.equal(resDisableUsage.available, false);
  assert.equal(resDisableUsage.reason, "disabled_by_config");
  assert.deepEqual(resDisableUsage.providers, []);
});

test("shares in-flight probes, successful samples, and errors across readers and OS processes", async t => {
  const fx = createFixture(t);
  let clock = SAMPLE_REQUESTED_AT;
  let calls = 0;
  let childInFlight;
  let fail = false;
  const options = {
    homeDir: fx.root,
    now: () => clock,
    rpcWaitMs: 20,
    spawnImpl(bin, args) {
      const child = makeFakeChild();
      if (args[0] === "--version") {
        queueMicrotask(() => { child.stdout.emit("data", "1.5.15\n"); child.finish(0); });
      } else {
        calls++;
        childInFlight = child;
        if (fail) queueMicrotask(() => child.finish(1));
      }
      return child;
    },
  };
  const reader = createAgyQuotaReader(options);
  assert.equal((await reader.readAgyQuotas()).pending, true);
  assert.equal((await createAgyQuotaReader(options).readAgyQuotas({ force: true })).pending, true);
  assert.equal(runIsolatedReader(fx.root, clock).pending, true);
  assert.equal(calls, 1);

  childInFlight.stdout.emit("data", makeUsageEnvelope({ requestedAt: clock }));
  childInFlight.finish(0);
  await new Promise(resolve => setImmediate(resolve));

  const file = path.join(fx.pluginDir, "run", "agy-quota-state.json");
  assert.equal(fs.lstatSync(file).mode & 0o777, 0o600);
  clock += DEFAULT_CACHE_TTL_MS - 1;
  const cached = await createAgyQuotaReader(options).readAgyQuotas({ force: true });
  assert.equal(cached.cached, true);
  assert.equal(cached.available, true);
  assert.deepEqual(runIsolatedReader(fx.root, clock).providers, cached.providers);
  assert.equal(calls, 1);

  clock += 1;
  fail = true;
  assert.deepEqual((await reader.readAgyQuotas()).providers, cached.providers);
  assert.equal(calls, 2);
  clock += DEFAULT_ERROR_BACKOFF_MS - 1;
  assert.deepEqual(runIsolatedReader(fx.root, clock).providers, cached.providers);
  assert.equal((await createAgyQuotaReader(options).readAgyQuotas({ force: true })).cached, true);
  assert.equal(calls, 2);
});

test("a symlinked quota state, latch or lock prevents all managed CLI spawns", async t => {
  for (const name of ["agy-quota-state.json", "agy-quota-latch.json", "agy-quota.lock"]) {
    const fx = createFixture(t);
    const runDir = path.join(fx.pluginDir, "run");
    fs.mkdirSync(runDir);
    fs.symlinkSync(path.join(fx.root, "absent"), path.join(runDir, name));
    let calls = 0;
    const reader = createAgyQuotaReader({
      homeDir: fx.root,
      spawnImpl() { calls++; throw new Error("unexpected spawn"); },
    });
    assert.equal((await reader.readAgyQuotas()).available, false);
    assert.equal(calls, 0, name);
  }
});

// --- Fix #7: Per-window reset_time fault tolerance + window normalization & ordering ---

test("Fix #7: parseAgyCliUsageWindows tolerates out-of-range/invalid reset_time per window without losing valid Gemini & Claude rings", () => {
  assert.equal(normalizeResetTime(9e15, { clampedRemaining: 0.5, description: undefined, windowDurationMins: 300, requestedAt: SAMPLE_REQUESTED_AT }), null);
  assert.equal(normalizeResetTime(1e20, { clampedRemaining: 0.5, description: undefined, windowDurationMins: 300, requestedAt: SAMPLE_REQUESTED_AT }), null);
  assert.equal(normalizeResetTime("not-a-date", { clampedRemaining: 0.5, description: undefined, windowDurationMins: 300, requestedAt: SAMPLE_REQUESTED_AT }), null);
  assert.equal(normalizeResetTime("1970-01-01T00:00:00Z", { clampedRemaining: 0.5, description: undefined, windowDurationMins: 300, requestedAt: SAMPLE_REQUESTED_AT }), null);

  const envelope = makeUsageEnvelope({
    requestedAt: SAMPLE_REQUESTED_AT,
    extraGroups: [
      {
        id: "gemini-carbon",
        name: "Gemini Carbon",
        buckets: [
          {
            id: "gemini-carbon-weekly",
            window: "weekly",
            remaining_fraction: 0.75,
            reset_time: "1970-01-01T00:00:00Z", // pre-2000 sentinel -> stripped
          },
          {
            id: "gemini-carbon-5h",
            window: "5h",
            remaining_fraction: 1,
            description: "Active window",
            reset_time: new Date(SAMPLE_REQUESTED_AT + 300 * 60_000).toISOString(), // kept
          },
          {
            id: "gemini-carbon-impossible-date",
            window: "5h",
            remaining_fraction: 0.5,
            reset_time: "2026-02-30T11:00:00Z",
          },
          {
            id: "gemini-carbon-overflow",
            window: "5h",
            remaining_fraction: 0.6,
            reset_time: 9e15, // exceeds JS Date max 8.64e15 -> only this resetsAt dropped!
          },
        ],
      },
    ],
  });

  const windows = parseAgyCliUsageWindows(envelope, { requestedAt: SAMPLE_REQUESTED_AT });
  assert.ok(Array.isArray(windows));

  // Primary gemini-5h/gemini-weekly still ordered first, followed by argon/carbon, then 3p-*
  assert.deepEqual(
    windows.map((w) => w.id),
    [
      "gemini-5h",
      "gemini-weekly",
      "gemini-carbon-5h",
      "gemini-carbon-impossible-date",
      "gemini-carbon-overflow",
      "gemini-argon-weekly",
      "gemini-carbon-weekly",
      "3p-5h",
      "3p-weekly",
    ]
  );

  const impossible = windows.find(w => w.id === "gemini-carbon-impossible-date");
  assert.equal(impossible.usedPercent, 50);
  assert.equal(impossible.resetsAt, undefined);
  const resetOptions = { clampedRemaining: 0.5, windowDurationMins: 300, requestedAt: SAMPLE_REQUESTED_AT };
  assert.equal(normalizeResetTime("2026-11-27T24:00:00Z", resetOptions), null);
  assert.equal(normalizeResetTime("2026-11-27T11:60:00Z", resetOptions), null);
  assert.equal(normalizeResetTime("2026-11-27T11:00:60Z", resetOptions), null);
  assert.equal(normalizeResetTime("2028-02-29T12:00:00+01:00", resetOptions), "2028-02-29T11:00:00.000Z");

  const overflowWin = windows.find((w) => w.id === "gemini-carbon-overflow");
  assert.equal(overflowWin.usedPercent, 40);
  assert.equal(overflowWin.resetsAt, undefined, "Out-of-range reset_time dropped cleanly without throwing");

  const gem5h = windows.find((w) => w.id === "gemini-5h");
  assert.equal(gem5h.usedPercent, 0);
  assert.equal(gem5h.resetsAt, undefined, "Untouched rolling full-window sentinel reset_time stripped");

  const gemWk = windows.find((w) => w.id === "gemini-weekly");
  assert.equal(gemWk.usedPercent, 5);
  assert.ok(gemWk.resetsAt);

  const p5h = windows.find((w) => w.id === "3p-5h");
  assert.equal(p5h.label, "Claude & GPT (shared) · 5-hour");
  assert.equal(p5h.usedPercent, 49);
  const pWk = windows.find((w) => w.id === "3p-weekly");
  assert.equal(pWk.label, "Claude & GPT (shared) · Weekly");
  assert.equal(pWk.usedPercent, 53);
});

// --- Non-blocking RPC wait budget & 5-minute error backoff ---

test("non-blocking rpcWaitMs returns pending:true on slow cold start and 5-minute error backoff preserves stale cache", async (t) => {
  const fx = createFixture(t);
  let clock = SAMPLE_REQUESTED_AT;
  let usageCalls = 0;
  let pendingUsageChild = null;
  let failNext = false;

  const reader = createAgyQuotaReader({
    homeDir: fx.root,
    now: () => clock,
    rpcWaitMs: 40,
    spawnImpl: (bin, args) => {
      const child = makeFakeChild();
      if (args[0] === "--version") {
        queueMicrotask(() => { child.stdout.emit("data", "1.5.15\n"); child.finish(0); });
      } else {
        usageCalls++;
        if (failNext) {
          queueMicrotask(() => { child.stderr.emit("data", "temporary error\n"); child.finish(1); });
        } else {
          pendingUsageChild = child;
        }
      }
      return child;
    },
  });

  const [c1, c2] = await Promise.all([reader.readAgyQuotas(), reader.readAgyQuotas()]);
  assert.equal(usageCalls, 1);
  assert.equal(c1.pending, true);
  assert.equal(c2.pending, true);

  pendingUsageChild.stdout.emit("data", makeUsageEnvelope({ requestedAt: clock }) + "\n");
  pendingUsageChild.finish(0);
  await new Promise((r) => setTimeout(r, 10));

  clock += 60_000;
  const cached = await reader.readAgyQuotas();
  assert.equal(cached.available, true);
  assert.equal(cached.cached, true);
  assert.equal(cached.pending, undefined);
  assert.equal(usageCalls, 1);

  clock += DEFAULT_CACHE_TTL_MS;
  failNext = true;
  const afterErr = await reader.readAgyQuotas();
  assert.equal(usageCalls, 2);
  assert.equal(afterErr.available, true, "Stale cache preserved on transient error");

  clock += DEFAULT_ERROR_BACKOFF_MS - 30_000;
  const duringBackoff = await reader.readAgyQuotas({ force: true });
  assert.equal(usageCalls, 2, "5m error backoff applies even with force:true");
  assert.equal(duringBackoff.cached, true);
});

// --- Fix #6: Unified T3CODE_HOME path resolution (default, custom standard userdata+tools, direct-data fixture, zero cross-instance leak) ---

test("Fix #6: resolveT3Paths and backend share unified default, custom T3CODE_HOME (userdata+tools), and direct data-dir resolution with zero cross-leak", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3-paths-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const fakeHome = path.join(root, "home");
  fs.mkdirSync(path.join(fakeHome, ".t3", "userdata"), { recursive: true });
  fs.mkdirSync(path.join(fakeHome, ".t3", "tools", "antigravity-acp", `${process.platform}-${process.arch}`, "versions", VALID_RELEASE_ID), { recursive: true });
  const defaultBinDir = path.join(fakeHome, ".t3", "tools", "antigravity-acp", `${process.platform}-${process.arch}`);
  fs.writeFileSync(path.join(defaultBinDir, "active.json"), JSON.stringify({ releaseId: VALID_RELEASE_ID }));
  fs.writeFileSync(path.join(defaultBinDir, "versions", VALID_RELEASE_ID, ".install-complete.json"), JSON.stringify({ releaseId: VALID_RELEASE_ID, executable: { name: "antigravity" } }));
  fs.writeFileSync(path.join(defaultBinDir, "versions", VALID_RELEASE_ID, "antigravity"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const defaultEnvId = "11111111-1111-4111-8111-111111111111";
  fs.writeFileSync(path.join(fakeHome, ".t3", "userdata", "environment-id"), defaultEnvId + "\n");

  // 1. Default layout
  const defPaths = resolveT3Paths({ homeDir: fakeHome, t3CodeHome: "" });
  assert.equal(defPaths.baseDir, path.join(fakeHome, ".t3"));
  assert.equal(defPaths.userDataDir, path.join(fakeHome, ".t3", "userdata"));
  assert.equal(defPaths.toolsDir, path.join(fakeHome, ".t3", "tools"));

  // 2. Custom T3CODE_HOME with standard userdata/ + tools/ (without its own tools -> must NOT fall back to ~/.t3/tools!)
  const customBase = path.join(root, "custom-t3");
  fs.mkdirSync(path.join(customBase, "userdata"), { recursive: true });
  const customEnvId = "22222222-2222-4222-8222-222222222222";
  fs.writeFileSync(path.join(customBase, "userdata", "environment-id"), customEnvId + "\n");
  const customPaths = resolveT3Paths({ homeDir: fakeHome, t3CodeHome: customBase });
  assert.equal(customPaths.baseDir, customBase);
  assert.equal(customPaths.userDataDir, path.join(customBase, "userdata"));
  assert.equal(customPaths.toolsDir, path.join(customBase, "tools"));
  assert.equal(
    resolveManagedAgyBinary({ homeDir: fakeHome, t3CodeHome: customBase }),
    null,
    "Custom T3CODE_HOME must NEVER fall back to default ~/.t3/tools"
  );

  const backendPath = path.join(__dirname, "../src/backend.cjs");
  const readEnv = (t3CodeHome) => {
    const run = spawnSync(process.execPath, ["-e", `
      require(process.argv[1]).hubCall("quota:external").then(r => process.stdout.write(JSON.stringify(r)));
    `, backendPath], {
      env: { HOME: fakeHome, T3CODE_HOME: t3CodeHome, XDG_DATA_HOME: root, T3_HUB_TEST: "1" },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(run.status, 0, run.stderr || String(run.error || ""));
    return JSON.parse(run.stdout);
  };
  assert.deepEqual(readEnv(""), { ok: true, providers: [], t3EnvironmentId: defaultEnvId });
  assert.deepEqual(readEnv(customBase), { ok: true, providers: [], t3EnvironmentId: customEnvId });

  // 3. Direct data-dir fixture (like hub-v0112-regressions.test.cjs:339)
  const directDir = path.join(root, "direct-userdata");
  fs.mkdirSync(directDir, { recursive: true });
  const directEnvId = "33333333-3333-4333-8333-333333333333";
  fs.writeFileSync(path.join(directDir, "environment-id"), directEnvId + "\n");
  const directPaths = resolveT3Paths({ homeDir: fakeHome, t3CodeHome: directDir });
  assert.equal(directPaths.userDataDir, directDir);
  assert.equal(directPaths.toolsDir, path.join(directDir, "tools"));
  assert.equal(
    resolveManagedAgyBinary({ homeDir: fakeHome, t3CodeHome: directDir }),
    null,
    "Direct data-dir T3CODE_HOME must NEVER fall back to default ~/.t3/tools"
  );
  assert.deepEqual(readEnv(directDir), { ok: true, providers: [], t3EnvironmentId: directEnvId });
  const customId = path.join(customBase, "userdata", "environment-id");
  fs.unlinkSync(customId);
  fs.symlinkSync(path.join(directDir, "environment-id"), customId);
  assert.equal(readEnv(customBase).t3EnvironmentId, "");
  const linkDir = path.join(root, "via-symlink");
  fs.symlinkSync(root, linkDir);
  assert.equal(readEnv(path.join(linkDir, path.basename(directDir))).t3EnvironmentId, "");
});

// --- Fix #5: Remote Connect vs Local environment isolation, unknown env, and instant local switch re-evaluation ---

test("Fix #5: decouples remote Connect native AGY from local CLI, handles cold-start remote & bidirectional switches without 115s throttle block", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/renderer-ui.js"), "utf8");
  const sliceBetween = (startMarker, endMarker) => {
    const a = source.indexOf(startMarker);
    const b = source.indexOf(endMarker, a);
    assert.ok(a >= 0 && b > a, `missing slice ${startMarker} -> ${endMarker}`);
    return source.slice(a, b);
  };

  const LOCAL_ENV = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const REMOTE_ENV = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  const localAgyWindows = parseAgyCliUsageWindows(makeUsageEnvelope({ requestedAt: SAMPLE_REQUESTED_AT }), {
    requestedAt: SAMPLE_REQUESTED_AT,
  });
  const localAgyProvider = {
    instanceId: "antigravity",
    driver: "antigravity",
    displayName: "AGY",
    usageLimits: { checkedAt: new Date(SAMPLE_REQUESTED_AT).toISOString(), windows: localAgyWindows },
  };
  const remoteNativeAgy = {
    instanceId: "antigravity",
    driver: "antigravity",
    displayName: "AGY Remote",
    usageLimits: {
      checkedAt: new Date(SAMPLE_REQUESTED_AT).toISOString(),
      windows: [{ id: "gemini-weekly", kind: "weekly", label: "Gemini · Weekly", windowDurationMins: 10080, usedPercent: 77 }],
    },
  };

  let fakeNow = SAMPLE_REQUESTED_AT;
  const rpcCalls = [];
  let nextRpcResponse = { ok: true, providers: [localAgyProvider], t3EnvironmentId: LOCAL_ENV };

  const ctx = vm.createContext({
    Date: { now: () => fakeNow },
    Math,
    Number,
    String,
    Array,
    Object,
    Map,
    Set,
    JSON,
    disposed: false,
    document: { hidden: false },
    latestStats: null,
    window: {
      __t3HubRpc: (action, payload) => {
        rpcCalls.push({ action, payload: JSON.parse(JSON.stringify(payload)) });
        return Promise.resolve(nextRpcResponse);
      },
    },
    setTimeout: () => 1,
    clearTimeout: () => {},
    renderQuotaRing: () => {},
    scheduleLayoutSync: () => {},
    readLiveT3State: () => ctx.live,
    toEpochMs: (v) => (typeof v === "number" ? v : typeof v === "string" ? (Number.isFinite(Date.parse(v)) ? Date.parse(v) : null) : null),
    formatResetShort: (v) => v || null,
    escapeHtml: (v) => String(v),
    hudLang: "zh",
  });

  vm.runInContext(
    `${sliceBetween("  let externalQuotaProviders = [];", "  function createHudTurnSpeedState(")}\n` +
    `${sliceBetween("  const quotaBurnSamples = new Map();", "  function formatContextPair(")}\n` +
    `this.compute = computeQuotaAndContext;\n` +
    `this.hasNativeAgy = hasNativeAgyQuotaWindows;\n` +
    `this.refreshExternal = refreshExternalQuotas;\n` +
    `this.getExternal = () => externalQuotaProviders;\n` +
    `this.readProviders = readHudQuotaProviders;\n`,
    ctx
  );

  // The first observation is scoped by its own ID before the backend returns the local ID.
  ctx.live = {
    environmentId: REMOTE_ENV,
    selectedProvider: "antigravity",
    selectedModel: "gemini-4-neon",
    usage: { providers: [remoteNativeAgy] },
  };
  assert.equal(ctx.hasNativeAgy(), true);
  ctx.refreshExternal(false);
  await new Promise((r) => setImmediate(r));
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].payload.hasNativeAgyQuota, true);
  assert.equal(rpcCalls[0].payload.observedEnvId, REMOTE_ENV);

  // On remote, computeQuotaAndContext shows ONLY remote's 23% remaining (usedPercent 77), never local's 95%
  const remoteView = JSON.parse(JSON.stringify(ctx.compute({ ok: true, provider: "antigravity", tokens: {}, cache: {} })));
  assert.equal(remoteView.providerQuotas.length, 1);
  assert.equal(remoteView.providerQuotas[0].weekly.remainingPct, 23);

  // 2. Switch REMOTE -> LOCAL within 5s (well inside 115s throttle) -> must bypass 115s throttle immediately!
  fakeNow += 5_000;
  ctx.live = {
    environmentId: LOCAL_ENV,
    selectedProvider: "antigravity",
    selectedModel: "gemini-4-neon",
    usage: { providers: [] },
  };
  ctx.refreshExternal(false);
  await new Promise((r) => setImmediate(r));
  assert.equal(rpcCalls.length, 2, "Switching back to local must bypass 115s throttle for immediate re-evaluation");
  assert.equal(rpcCalls[1].payload.environmentId, LOCAL_ENV);
  assert.equal(rpcCalls[1].payload.hasNativeAgyQuota, undefined);

  // Local view shows local AGY · Gemini (95% remaining) + AGY · Claude (47%/51%) rings, unaffected by remote!
  const localView = JSON.parse(JSON.stringify(ctx.compute({ ok: true, provider: "antigravity", tokens: {}, cache: {} })));
  assert.equal(localView.providerQuotas.length, 2);
  assert.equal(localView.providerQuotas.find((p) => p.instanceId === "antigravity:gemini").weekly.remainingPct, 95);
  assert.equal(localView.providerQuotas.find((p) => p.instanceId === "antigravity:claude").weekly.remainingPct, 47);

  // 3. Switch LOCAL -> REMOTE -> LOCAL with empty remote response preserves cached local externalQuotaProviders
  fakeNow += 120_000;
  ctx.live = {
    environmentId: REMOTE_ENV,
    selectedProvider: "antigravity",
    selectedModel: "gemini-4-neon",
    usage: { providers: [remoteNativeAgy] },
  };
  nextRpcResponse = { ok: true, providers: [], t3EnvironmentId: LOCAL_ENV };
  assert.equal(ctx.hasNativeAgy(), false, "Remote env with known localEnvId must never report local native AGY");
  ctx.refreshExternal(false);
  await new Promise((r) => setImmediate(r));
  assert.equal(ctx.getExternal().length, 1, "Cached local externalQuotaProviders preserved when remote returns empty");

  // 4. Unknown environment (null / undefined) -> never sets hasNativeAgyQuota:true
  ctx.live = { environmentId: null, selectedProvider: "antigravity", usage: { providers: [remoteNativeAgy] } };
  assert.equal(ctx.hasNativeAgy(), false, "Unknown environment must not suppress local AGY");
  for (const unknown of ["", null, "unrecognized"]) {
    assert.equal(ctx.readProviders({}, unknown, LOCAL_ENV, [localAgyProvider]).length, 0);
  }
  assert.equal(ctx.readProviders({}, undefined, LOCAL_ENV, [localAgyProvider]).length, 1);

  // 5. Confirmed local env WITH native AGY -> sets hasNativeAgyQuota:true + matching environmentId, then clearing it bypasses 115s throttle
  fakeNow += 5_000;
  ctx.live = {
    environmentId: LOCAL_ENV,
    selectedProvider: "antigravity",
    selectedModel: "gemini-4-neon",
    usage: {
      providers: [{
        instanceId: "antigravity",
        driver: "antigravity",
        usageLimits: { windows: [{ id: "gemini-weekly", kind: "weekly", label: "Gemini · Weekly", windowDurationMins: 10080, usedPercent: 12 }] },
      }],
    },
  };
  nextRpcResponse = { ok: true, providers: [], agySkippedNative: true, t3EnvironmentId: LOCAL_ENV };
  assert.equal(ctx.hasNativeAgy(), true);
  ctx.refreshExternal(false);
  await new Promise((r) => setImmediate(r));
  const localNativeCall = rpcCalls[rpcCalls.length - 1];
  assert.equal(localNativeCall.payload.hasNativeAgyQuota, true);
  assert.equal(localNativeCall.payload.environmentId, LOCAL_ENV);
  assert.equal(ctx.getExternal().length, 1, "agySkippedNative:true must preserve prior local external AGY state");

  // Native AGY disappears on local 3s later -> bypasses 115s throttle immediately
  fakeNow += 3_000;
  ctx.live = { environmentId: LOCAL_ENV, selectedProvider: "antigravity", usage: { providers: [] } };
  nextRpcResponse = { ok: true, providers: [localAgyProvider], t3EnvironmentId: LOCAL_ENV };
  ctx.refreshExternal(false);
  await new Promise((r) => setImmediate(r));
  const clearedCall = rpcCalls[rpcCalls.length - 1];
  assert.equal(clearedCall.payload.hasNativeAgyQuota, undefined);
  assert.equal(clearedCall.payload.environmentId, LOCAL_ENV);

  // Hold the remote RPC open, then return to a local route before resolving it.
  fakeNow += 120_000;
  ctx.live = { environmentId: REMOTE_ENV, usage: { providers: [remoteNativeAgy] } };
  let finishRemote;
  nextRpcResponse = new Promise(resolve => { finishRemote = resolve; });
  ctx.refreshExternal();
  const callsDuringRemote = rpcCalls.length;
  ctx.live = { environmentId: LOCAL_ENV, usage: { providers: [] } };
  ctx.refreshExternal();
  assert.equal(rpcCalls.length, callsDuringRemote, "Only a single RPC is in flight");
  nextRpcResponse = { ok: true, providers: [localAgyProvider], t3EnvironmentId: LOCAL_ENV };
  finishRemote({ ok: true, providers: [], t3EnvironmentId: LOCAL_ENV });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rpcCalls.length, callsDuringRemote + 1);
  assert.deepEqual(rpcCalls.at(-1).payload, { environmentId: LOCAL_ENV });
  assert.equal(ctx.getExternal().length, 1);

  // A cold local native observation suppresses the initial probe. If native
  // data disappears during that RPC, the response immediately triggers another.
  vm.runInContext('hudLocalQuotaEnvironmentId = ""; externalQuotaFetchedAt = 0;', ctx);
  ctx.live = { environmentId: LOCAL_ENV, usage: { providers: [localAgyProvider] } };
  let finishLocal;
  nextRpcResponse = new Promise(resolve => { finishLocal = resolve; });
  ctx.refreshExternal();
  assert.deepEqual(rpcCalls.at(-1).payload, {
    environmentId: LOCAL_ENV, observedEnvId: LOCAL_ENV, hasNativeAgyQuota: true,
  });
  const callsWithNative = rpcCalls.length;
  ctx.live = { environmentId: LOCAL_ENV, usage: { providers: [] } };
  nextRpcResponse = { ok: true, providers: [localAgyProvider], t3EnvironmentId: LOCAL_ENV };
  finishLocal({ ok: true, providers: [], agySkippedNative: true, t3EnvironmentId: LOCAL_ENV });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rpcCalls.length, callsWithNative + 1);
  assert.deepEqual(rpcCalls.at(-1).payload, { environmentId: LOCAL_ENV });

});

test("renderer refreshExternalQuotas schedules bounded pending follow-up retries without force:true", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/renderer-ui.js"), "utf8");
  const sliceBetween = (startMarker, endMarker) => {
    const a = source.indexOf(startMarker);
    const b = source.indexOf(endMarker, a);
    assert.ok(a >= 0 && b > a, `missing slice ${startMarker} -> ${endMarker}`);
    return source.slice(a, b);
  };

  const rpcCalls = [];
  const timers = [];
  const ctx = vm.createContext({
    Date,
    Math,
    Number,
    String,
    Array,
    Object,
    Map,
    Set,
    JSON,
    disposed: false,
    document: { hidden: false },
    latestStats: null,
    window: {
      __t3HubRpc: (action, payload) => {
        rpcCalls.push({ action, payload });
        return Promise.resolve({ ok: true, providers: [], pending: true, t3EnvironmentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
      },
    },
    setTimeout: (fn, ms) => {
      const entry = { id: timers.length + 1, fn, ms, cleared: false };
      timers.push(entry);
      return entry.id;
    },
    clearTimeout: (id) => {
      const item = timers.find((t) => t.id === id);
      if (item) item.cleared = true;
    },
    renderQuotaRing: () => {},
    scheduleLayoutSync: () => {},
    readLiveT3State: () => ({ environmentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", usage: { providers: [] } }),
    toEpochMs: (v) => (typeof v === "number" ? v : typeof v === "string" ? (Number.isFinite(Date.parse(v)) ? Date.parse(v) : null) : null),
    formatResetShort: () => null,
    escapeHtml: (v) => String(v),
    hudLang: "zh",
  });

  vm.runInContext(
    `${sliceBetween("  let externalQuotaProviders = [];", "  function createHudTurnSpeedState(")}\n` +
    `${sliceBetween("  const quotaBurnSamples = new Map();", "  function formatContextPair(")}\n` +
    `this.refreshExternal = refreshExternalQuotas;\n`,
    ctx
  );

  ctx.refreshExternal(true);
  await new Promise((r) => setImmediate(r));
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].payload.force, true);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 6000);

  for (let i = 0; i < 3; i++) {
    const nextTimer = timers[i];
    assert.ok(nextTimer && !nextTimer.cleared);
    nextTimer.fn();
    await new Promise((r) => setImmediate(r));
  }

  assert.equal(rpcCalls.length, 4, "Initial call + max 3 bounded follow-up retries");
  assert.equal(timers.length, 3, "Must stop scheduling retries after max retries");
  for (let i = 1; i < rpcCalls.length; i++) {
    assert.equal(rpcCalls[i].payload.force, undefined, "Pending follow-up must NOT pass force:true");
  }
});
