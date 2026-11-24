"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile, execFileSync } = require("node:child_process");
const { promisify } = require("node:util");
const { buildTelemetryLaunch, optOutFlags, processStart, recordTelemetryLaunch, verifyLegacyTelemetryLaunch, createTelemetryGuard } = require("../src/hub-telemetry-guard.cjs");

const run = promisify(execFile);
const repo = path.resolve(__dirname, "..");
const disable = "disableOfficialTelemetry";
const sync = "syncShellProfileTelemetryOptOut";

function fixture(t, pid = null) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-telemetry-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const pluginDir = path.join(homeDir, "plugin");
  const runDir = path.join(pluginDir, "run");
  const profile = path.join(homeDir, ".zshrc");
  const configFile = path.join(pluginDir, "config.json");
  const policyPath = path.join(homeDir, "policy.json");
  fs.mkdirSync(runDir, { recursive: true });
  const guard = createTelemetryGuard({ homeDir, pluginDir, policyPath, pid });
  return { homeDir, pluginDir, runDir, profile, configFile, policyPath, guard };
}

test("status is read-only and first HUD launch applies the default to both startup paths", (t) => {
  const { guard, profile, configFile } = fixture(t);
  assert.deepEqual(guard.status().config, { [disable]: true, [sync]: true });
  assert.equal(guard.status().runtime.state, "not-running");
  assert.equal(guard.status().profile, "unconfigured");
  assert.equal(fs.existsSync(profile), false);
  guard.reconcileProfile();
  assert.equal(guard.status().profile, "managed");
  assert.equal(fs.existsSync(configFile), false);
  guard.update({ [disable]: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, "utf8")), { [disable]: true, [sync]: true });
});

for (const [label, original] of [
  ["missing profile", null], ["empty profile", ""], ["trailing newline", "# 用户设置\nexport OTHER=keep\n"],
  ["no trailing newline", "export OTHER=keep"], ["CRLF and BOM", "\ufeff# 原始内容\r\nexport OTHER=keep\r\n"],
]) {
  test(`shell sync preserves ${label}, backs up once and is idempotent`, (t) => {
    const { guard, profile } = fixture(t);
    if (original !== null) fs.writeFileSync(profile, original, { mode: 0o640 });
    assert.equal(guard.update({ [disable]: true }).profile, "managed");
    const written = fs.readFileSync(profile, "utf8");
    assert.match(written, /export T3CODE_TELEMETRY_ENABLED=false\n/);
    assert.doesNotMatch(written, /OTEL_SDK_DISABLED/);
    const inode = fs.statSync(profile).ino;
    assert.equal(guard.update({ [disable]: true }).profile, "managed");
    assert.equal(fs.statSync(profile).ino, inode);
    if (original !== null) {
      assert.equal(fs.statSync(profile).mode & 0o777, 0o640);
      assert.equal(fs.readFileSync(profile + ".t3hub.bak", "utf8"), original);
    }
    assert.equal(guard.update({ [disable]: false }).profile, "unconfigured");
    assert.equal(fs.readFileSync(profile, "utf8"), original ?? "");
    assert.equal(guard.update({ [disable]: true }).profile, "managed", "saved sync restores the block");
    assert.equal(guard.update({ [disable]: false }).profile, "unconfigured");
    assert.equal(fs.readFileSync(profile, "utf8"), original ?? "");
  });
}

test("manual opt-out and lines added after a managed block survive cleanup", (t) => {
  const { guard, profile } = fixture(t);
  fs.writeFileSync(profile, "export T3CODE_TELEMETRY_ENABLED=false#not-a-comment");
  assert.equal(guard.status().profile, "unconfigured");
  const manual = "export T3CODE_TELEMETRY_ENABLED='false' # manually set";
  fs.writeFileSync(profile, manual);
  assert.equal(guard.status().profile, "manual");
  guard.update({ [disable]: true });
  fs.appendFileSync(profile, "export AFTER=keep");
  assert.equal(guard.update({ [disable]: false }).profile, "manual");
  assert.equal(fs.readFileSync(profile, "utf8"), manual + "\nexport AFTER=keep");
  assert.equal(fs.readFileSync(profile + ".t3hub.bak", "utf8"), manual);
});

test("legacy profile sync removes only HUD-owned OTel settings and preserves adjacent user bytes", (t) => {
  const { guard, profile } = fixture(t);
  const prefix = "export OTEL_SDK_DISABLED=false\nexport OTHER=keep";
  const legacy = '\n# >>> t3-hub official-telemetry-opt-out >>>\n# HUD added the preceding line break\n' +
    'export T3CODE_TELEMETRY_ENABLED=false\nexport T3CODE_OTEL_SDK_DISABLED=true\nexport OTEL_SDK_DISABLED=true\n' +
    '# <<< t3-hub official-telemetry-opt-out <<<\n';
  fs.writeFileSync(profile, prefix + legacy);
  assert.equal(guard.status().profile, "managed");
  assert.equal(guard.update({ [disable]: true }).profile, "managed");
  assert.equal(fs.readFileSync(profile, "utf8"), prefix + legacy.replace(/^export (?:T3CODE_)?OTEL_SDK_DISABLED=true\n/gm, ""));
  assert.equal(guard.update({ [disable]: false }).profile, "unconfigured");
  assert.equal(fs.readFileSync(profile, "utf8"), prefix);
  assert.equal(fs.readFileSync(profile + ".t3hub.bak", "utf8"), prefix + legacy);
});

test("broken markers, unsupported encoding and corrupted config are preserved", (t) => {
  const { guard, profile, configFile } = fixture(t);
  const malformed = "# >>> t3-hub official-telemetry-opt-out >>>\nexport PRIVATE=keep\n";
  fs.writeFileSync(profile, malformed);
  assert.equal(guard.status().profile, "unreadable");
  assert.throws(() => guard.update({ [disable]: true }), /markers/);
  assert.equal(fs.readFileSync(profile, "utf8"), malformed);
  assert.equal(fs.existsSync(configFile), false);
  const invalidUtf8 = Buffer.from([0xff, 0xfe]);
  fs.writeFileSync(profile, invalidUtf8);
  assert.throws(() => guard.update({ [disable]: true }), /UTF-8/i);
  assert.deepEqual(fs.readFileSync(profile), invalidUtf8);
  fs.writeFileSync(configFile, "broken config");
  assert.equal(guard.status().configurationError, true);
  assert.throws(() => guard.update({ [disable]: false }), /invalid JSON/);
  assert.equal(fs.readFileSync(configFile, "utf8"), "broken config");
});

test("policy detection is read-only and distinguishes missing, invalid, and disabled", (t) => {
  const { guard, policyPath } = fixture(t);
  assert.equal(guard.status().policy, "missing");
  fs.writeFileSync(policyPath, "{broken");
  assert.equal(guard.status().policy, "invalid");
  fs.writeFileSync(policyPath, '{"limits":{"telemetry":true}}');
  assert.equal(guard.status().policy, "not-enforced");
  const locked = '{"limits":{"telemetry":false}}';
  fs.writeFileSync(policyPath, locked);
  assert.equal(guard.status().policy, "locked-off");
  guard.update({ [disable]: false });
  assert.equal(fs.readFileSync(policyPath, "utf8"), locked);
});

test("runtime distinguishes saved settings, applied launches, stale receipts and external overrides", (t) => {
  const pid = process.pid, started = processStart(pid);
  const { guard, pluginDir, runDir } = fixture(t, pid);
  assert.ok(started);
  assert.deepEqual(guard.status().runtime, { state: "unverified", restartRequired: true });
  recordTelemetryLaunch(runDir, pid, "stale", buildTelemetryLaunch({}, pluginDir), { pid, productOff: true, otelOff: true });
  assert.equal(guard.status().runtime.state, "unverified");
  const start = (env, flags) => {
    const launch = buildTelemetryLaunch(env, pluginDir);
    recordTelemetryLaunch(runDir, pid, started, launch, { pid, ...optOutFlags(launch.env), ...flags });
  };
  start({}, { otelOff: false });
  assert.equal(guard.status().runtime.state, "partial");
  assert.equal(guard.status().runtime.restartRequired, true);
  start({});
  assert.deepEqual(guard.status().runtime, { state: "applied", injected: true, productOff: true, otelOff: true, restartRequired: false });
  const pending = guard.update({ [disable]: false }).runtime;
  assert.equal(pending.state, "applied");
  assert.equal(pending.restartRequired, true);
  start({ T3CODE_TELEMETRY_ENABLED: "false", OTEL_SDK_DISABLED: "true", T3CODE_OTEL_SDK_DISABLED: "false" });
  assert.deepEqual(guard.status().runtime, { state: "partial", injected: false, productOff: true, otelOff: false, restartRequired: false });
  start({ T3CODE_TELEMETRY_ENABLED: "false", OTEL_SDK_DISABLED: "true" });
  assert.equal(guard.status().runtime.state, "applied");
  assert.equal(guard.status().runtime.injected, false);
  start({});
  assert.equal(guard.status().runtime.state, "not-enabled");
});

test("a matching legacy receipt stays unverified until Electron main observes its own flags", (t) => {
  const pid = process.pid;
  const { guard, runDir } = fixture(t, pid);
  const receipt = path.join(runDir, "official-telemetry-launch.json");
  const legacy = { pid, started: processStart(pid), injected: true, productOff: true, otelOff: true };
  fs.writeFileSync(receipt, JSON.stringify(legacy));
  assert.equal(guard.status().runtime.state, "unverified");
  verifyLegacyTelemetryLaunch(runDir, pid, { T3CODE_TELEMETRY_ENABLED: "false" });
  assert.equal(guard.status().runtime.state, "partial");
  assert.equal(guard.status().runtime.restartRequired, true);
  fs.writeFileSync(receipt, JSON.stringify(legacy));
  verifyLegacyTelemetryLaunch(runDir, pid, { T3CODE_TELEMETRY_ENABLED: "false", T3CODE_OTEL_SDK_DISABLED: "true", OTEL_SDK_DISABLED: "true" });
  assert.equal(guard.status().runtime.state, "applied");
  assert.equal(guard.status().runtime.restartRequired, false);
});

test("CLI, language and authenticated backend use the same persisted configuration", { skip: process.platform !== "darwin" }, async (t) => {
  const { homeDir, pluginDir, runDir, configFile } = fixture(t);
  const app = path.join(homeDir, "T3 Code Fixture.app");
  const exe = path.join(app, "Contents/MacOS/T3 Code");
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, '#!/bin/sh\nexec "$TEST_NODE" "$@"\n', { mode: 0o700 });
  for (const mod of ["hub-telemetry-guard.cjs", "hud-config.cjs", "hub-host-settings.cjs"]) {
    fs.copyFileSync(path.join(repo, "src", mod), path.join(pluginDir, mod));
  }
  const env = {
    ...process.env, HOME: homeDir, T3_HUD_DIR: pluginDir, T3_APP_PATH: app, TEST_NODE: process.execPath,
    T3_WATCH_PID: String(process.pid), T3_HUB_TEST: "1", T3_HUB_DIR: path.join(homeDir, "hub"),
  };
  delete env.ZDOTDIR;
  const cli = (...args) => run("bash", [path.join(repo, "bin", "t3-hud"), ...args], { env });
  assert.match((await cli("telemetry", "status")).stdout, /Running T3: not-running/);
  await Promise.all([cli("telemetry", "on"), cli("lang", "en")]);
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, "utf8"))[disable], false);
  assert.equal(JSON.parse(fs.readFileSync(configFile, "utf8")).userLang, "en");
  assert.match((await cli("telemetry", "off")).stdout, /HUD launch opt-out: on/);
  await assert.rejects(cli("telemetry", "toggle"), /Usage: t3-hud telemetry/);
  recordTelemetryLaunch(runDir, process.pid, processStart(process.pid), buildTelemetryLaunch({}, pluginDir), {
    pid: process.pid, productOff: true, otelOff: true,
  });
  const probe = `const { hubCall } = require("./src/backend.cjs");
    (async () => {
      const status = await hubCall("settings:officialTelemetry:get", {});
      const invalid = await hubCall("settings:officialTelemetry:update", { policyPath: "/etc/passwd" });
      const saved = await hubCall("settings:officialTelemetry:update", { disableOfficialTelemetry: false });
      console.log(JSON.stringify({ status, invalid, saved }));
    })().catch((error) => { console.error(error); process.exitCode = 1; });`;
  const result = JSON.parse(execFileSync(process.execPath, ["-e", probe], { env, cwd: repo, encoding: "utf8" }));
  assert.equal(result.status.runtime.state, "applied");
  assert.equal(result.invalid.ok, false);
  assert.equal(result.saved.runtime.restartRequired, true);
  assert.equal(JSON.parse(fs.readFileSync(configFile, "utf8")).userLang, "en");
});

test("the real bootstrap passes telemetry flags to a newly spawned desktop executable", async (t) => {
  const { homeDir, pluginDir, guard } = fixture(t);
  const app = path.join(homeDir, "T3 Code Fixture.app");
  const bin = path.join(app, "Contents/MacOS/T3 Code");
  const asar = path.join(app, "Contents/Resources/app.asar");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.mkdirSync(asar, { recursive: true });
  fs.writeFileSync(path.join(asar, "package.json"), "{}");
  fs.writeFileSync(bin, '#!/bin/sh\nprintf "%s\\n" "${T3CODE_TELEMETRY_ENABLED-unset}" "${T3CODE_OTEL_SDK_DISABLED-unset}" "${OTEL_SDK_DISABLED-unset}" > "$TEST_TELEMETRY_FLAGS"\n', { mode: 0o700 });
  for (const mod of ["bootstrap.cjs", "hud-health.cjs", "hub-telemetry-guard.cjs", "hud-config.cjs", "hub-host-settings.cjs"]) {
    fs.copyFileSync(path.join(repo, "src", mod), path.join(pluginDir, mod));
  }
  const output = path.join(homeDir, "flags.txt");
  const env = {
    ...process.env, HOME: homeDir, T3_HUD_DIR: pluginDir, T3_APP_PATH: app, TEST_TELEMETRY_FLAGS: output,
    T3CODE_TELEMETRY_ENABLED: "true", T3CODE_OTEL_SDK_DISABLED: "custom", OTEL_SDK_DISABLED: "false",
  };
  delete env.ZDOTDIR;
  const launch = () => run(process.execPath, [path.join(pluginDir, "bootstrap.cjs")], { env, timeout: 5000 });
  // The fixture exits after capturing its environment, before HUD readiness.
  await assert.rejects(launch(), { code: 1 });
  assert.equal(fs.readFileSync(output, "utf8"), "false\ntrue\ntrue\n");
  guard.update({ [disable]: false });
  await assert.rejects(launch(), { code: 1 });
  assert.equal(fs.readFileSync(output, "utf8"), "true\ncustom\nfalse\n");
});

test("legacy hot-update payload can load the backend without new launcher modules", (t) => {
  const { homeDir, pluginDir } = fixture(t);
  const legacy = path.join(homeDir, "legacy");
  fs.cpSync(path.join(repo, "src"), legacy, { recursive: true, filter: (entry) => !["hud-config.cjs", "hub-telemetry-guard.cjs"].includes(path.basename(entry)) });
  const probe = `const backend = require(process.argv[1]);
    (async () => console.log(JSON.stringify({
      language: backend.setConfig({userLang:"en"}),
      telemetry: await backend.hubCall("settings:officialTelemetry:get", {}),
    })))().catch((error) => { console.error(error); process.exitCode = 1; });`;
  const env = { ...process.env, HOME: homeDir, T3_HUD_DIR: pluginDir, T3_HUB_TEST: "1", T3_HUB_DIR: path.join(homeDir, "hub") };
  delete env.ZDOTDIR;
  const result = JSON.parse(execFileSync(process.execPath, ["-e", probe, path.join(legacy, "backend.cjs")], { env, encoding: "utf8" }));
  assert.equal(result.language.userLang, "en");
  assert.equal(result.telemetry.ok, false);
  assert.match(result.telemetry.error, /full HUD install/);
});

for (const [label, setup] of [
  [".zshenv setting ZDOTDIR from HOME", (homeDir, zdotdir) => {
    fs.writeFileSync(path.join(homeDir, ".zshenv"), 'export ZDOTDIR="$HOME/.config/zsh"\n');
    return { HOME: homeDir, PATH: process.env.PATH || "/usr/bin:/bin" };
  }],
  [".zprofile setting ZDOTDIR", (homeDir, zdotdir) => {
    fs.writeFileSync(path.join(homeDir, ".zprofile"), 'export ZDOTDIR="$HOME/.config/zsh"\n');
    return { HOME: homeDir, PATH: process.env.PATH || "/usr/bin:/bin" };
  }],
  [".zprofile setting ZDOTDIR only in interactive login shells with rcs", (homeDir, zdotdir) => {
    fs.writeFileSync(path.join(homeDir, ".zprofile"), '[[ -o interactive && -o login && -o rcs ]] && export ZDOTDIR="$HOME/.config/zsh"\n');
    return { HOME: homeDir, PATH: process.env.PATH || "/usr/bin:/bin" };
  }],
  [".zshenv setting ZDOTDIR from XDG_CONFIG_HOME", (homeDir, zdotdir) => {
    const xdg = path.dirname(zdotdir);
    fs.writeFileSync(path.join(homeDir, ".zshenv"), 'export ZDOTDIR="${XDG_CONFIG_HOME:-$HOME/.config}/zsh"\n');
    return { HOME: homeDir, XDG_CONFIG_HOME: xdg, PATH: process.env.PATH || "/usr/bin:/bin" };
  }],
]) {
  test(`shell profile sync follows ZDOTDIR via ${label}`, { skip: !fs.existsSync("/bin/zsh") }, (t) => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-telemetry-zdotdir-"));
    t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
    const pluginDir = path.join(homeDir, "plugin");
    const zdotdir = path.join(homeDir, label.includes("XDG") ? "xdg" : ".config", "zsh");
    fs.mkdirSync(path.join(pluginDir, "run"), { recursive: true });
    fs.mkdirSync(zdotdir, { recursive: true });
    const shellEnv = setup(homeDir, zdotdir);
    const guard = createTelemetryGuard({ homeDir, pluginDir, policyPath: path.join(homeDir, "policy.json"), env: shellEnv });
    const probe = () => execFileSync("/bin/zsh", ["-ilc", 'printf "%s" "${T3CODE_TELEMETRY_ENABLED-unset}"'], {
      encoding: "utf8", env: shellEnv, timeout: 5000,
    });
    assert.equal(guard.update({ [disable]: true }).profile, "managed");
    assert.equal(fs.existsSync(path.join(homeDir, ".zshrc")), false);
    assert.match(fs.readFileSync(path.join(zdotdir, ".zshrc"), "utf8"), /export T3CODE_TELEMETRY_ENABLED=false\n/);
    assert.equal(probe(), "false");
    assert.equal(guard.update({ [disable]: false }).profile, "unconfigured");
    assert.equal(probe(), "unset");
  });
}

test("ZDOTDIR probe targets startup .zshrc before .zshrc mutates ZDOTDIR and stays bounded under SIGTERM-ignoring scripts", { skip: !fs.existsSync("/bin/zsh") }, (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-telemetry-zdotdir-order-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const pluginDir = path.join(homeDir, "plugin");
  const startupDir = path.join(homeDir, "startup");
  const childDir = path.join(homeDir, "child");
  fs.mkdirSync(path.join(pluginDir, "run"), { recursive: true });
  fs.mkdirSync(startupDir, { recursive: true });
  fs.mkdirSync(childDir, { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".zprofile"), 'export ZDOTDIR="$HOME/startup"\n');
  fs.writeFileSync(path.join(startupDir, ".zshrc"), 'export ZDOTDIR="$HOME/child"\n');
  const shellEnv = { HOME: homeDir, PATH: process.env.PATH || "/usr/bin:/bin" };
  const guard = createTelemetryGuard({ homeDir, pluginDir, policyPath: path.join(homeDir, "policy.json"), env: shellEnv });
  assert.equal(guard.update({ [disable]: true }).profile, "managed");
  assert.equal(fs.existsSync(path.join(childDir, ".zshrc")), false);
  assert.match(fs.readFileSync(path.join(startupDir, ".zshrc"), "utf8"), /export T3CODE_TELEMETRY_ENABLED=false\n/);
  const observed = execFileSync("/bin/zsh", ["-ilc", 'printf "%s" "${T3CODE_TELEMETRY_ENABLED-unset}"'], {
    encoding: "utf8", env: shellEnv, timeout: 5000,
  });
  assert.equal(observed, "false");

  const hungHome = fs.mkdtempSync(path.join(os.tmpdir(), "hub-telemetry-zdotdir-timeout-"));
  t.after(() => fs.rmSync(hungHome, { recursive: true, force: true }));
  fs.writeFileSync(path.join(hungHome, ".zprofile"), 'trap "" TERM\nsleep 3\n');
  const start = Date.now();
  const hungGuard = createTelemetryGuard({ homeDir: hungHome, pluginDir, policyPath: path.join(hungHome, "policy.json"), env: { HOME: hungHome, PATH: process.env.PATH || "/usr/bin:/bin" } });
  assert.equal(hungGuard.status().profile, "unconfigured");
  assert.ok(Date.now() - start < 2200, "ZDOTDIR probe must terminate promptly via SIGKILL");
});
