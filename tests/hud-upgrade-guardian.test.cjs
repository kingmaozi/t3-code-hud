"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const {
  parseEtimeSeconds,
  isElectronRunAsNodeEnabled,
  resolveNodeRuntime,
  hasActiveT3Work,
  buildLaunchAgentPlist,
  createGuardianManager,
  evaluateAndHandoff,
  runPollingMode,
} = require("../src/update-guardian.cjs");

test("parseEtimeSeconds handles MM:SS, HH:MM:SS, and DD-HH:MM:SS", () => {
  assert.equal(parseEtimeSeconds("00:08"), 8);
  assert.equal(parseEtimeSeconds("02:15"), 135);
  assert.equal(parseEtimeSeconds("01:02:03"), 3723);
  assert.equal(parseEtimeSeconds("2-01:00:00"), 2 * 86400 + 3600);
});

test("hasActiveT3Work is strictly fail-safe for missing DB, unknown schema, and unreadable target env", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3-guardian-work-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // Missing DB -> busy (true)
  assert.equal(hasActiveT3Work({ homeDir: root }), true);

  // Unreadable process env -> busy (true)
  assert.equal(hasActiveT3Work({ homeDir: root, targetPid: 1234, readEnv: () => null }), true);

  // Unknown schema DB (no orchestration tables) -> busy (true)
  const customHome = path.join(root, "custom-t3-home");
  fs.mkdirSync(customHome, { recursive: true });
  const dbPath = path.join(customHome, "statev2.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE unrelated_table (id INTEGER);");
  db.close();
  assert.equal(hasActiveT3Work({ homeDir: root, targetPid: 1234, readEnv: () => ({ env: { T3CODE_HOME: customHome } }) }), true);

  // Valid schema with 0 active runs -> idle (false)
  const db2 = new DatabaseSync(dbPath);
  db2.exec("CREATE TABLE orchestration_v2_projection_runs (id TEXT, status TEXT);");
  db2.exec("INSERT INTO orchestration_v2_projection_runs VALUES ('r1', 'completed');");
  db2.close();
  assert.equal(hasActiveT3Work({ homeDir: root, targetPid: 1234, readEnv: () => ({ env: { T3CODE_HOME: customHome } }) }), false);

  // Active run present -> busy (true)
  const db3 = new DatabaseSync(dbPath);
  db3.exec("INSERT INTO orchestration_v2_projection_runs VALUES ('r2', 'running');");
  db3.close();
  assert.equal(hasActiveT3Work({ homeDir: root, targetPid: 1234, readEnv: () => ({ env: { T3CODE_HOME: customHome } }) }), true);
});

test("guardian auto-reattaches ONLY on fresh idle cold boot, and never kills busy or long-running T3", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3-guardian-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const fakeApp = path.join(home, "Applications", "T3 Code.app");
  fs.mkdirSync(path.join(fakeApp, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(fakeApp, "Contents", "MacOS", "T3 Code"), "");

  let relaunches = 0;
  let notifications = 0;

  // Case 1: Already mounted -> no-op
  const resMounted = await evaluateAndHandoff({
    homeDir: home,
    getProcessStart: () => "start-1",
    findProcess: () => ({ pid: 1001, elapsedSec: 3, binPath: "/fake", appBundle: fakeApp }),
    isMounted: async () => true,
    checkActiveWork: () => false,
    relaunch: async () => { relaunches++; },
    notify: () => { notifications++; },
  });
  assert.equal(resMounted.action, "already_mounted");
  assert.equal(relaunches, 0);
  assert.equal(notifications, 0);

  // Case 2: Unmounted + active work -> notify only, NEVER relaunch
  const resBusy = await evaluateAndHandoff({
    homeDir: home,
    getProcessStart: () => "start-2",
    findProcess: () => ({ pid: 1002, elapsedSec: 4, binPath: "/fake", appBundle: fakeApp }),
    isMounted: async () => false,
    checkActiveWork: () => true,
    relaunch: async () => { relaunches++; },
    notify: () => { notifications++; },
  });
  assert.equal(resBusy.action, "notified_only");
  assert.equal(relaunches, 0);
  assert.equal(notifications, 1);

  // Case 3: Unmounted + already running > 18s -> notify only, NEVER relaunch
  const resOld = await evaluateAndHandoff({
    homeDir: home,
    getProcessStart: () => "start-3",
    findProcess: () => ({ pid: 1003, elapsedSec: 60, binPath: "/fake", appBundle: fakeApp }),
    isMounted: async () => false,
    checkActiveWork: () => false,
    relaunch: async () => { relaunches++; },
    notify: () => { notifications++; },
  });
  assert.equal(resOld.action, "notified_only");
  assert.equal(relaunches, 0);
  assert.equal(notifications, 2);

  // Case 4: Unmounted + fresh cold boot (5s) + 0 active work -> safe reattach
  const resCold = await evaluateAndHandoff({
    homeDir: home,
    getProcessStart: () => "start-4",
    findProcess: () => ({ pid: 1004, elapsedSec: 5, binPath: "/fake", appBundle: fakeApp }),
    isMounted: async () => false,
    checkActiveWork: () => false,
    relaunch: async () => { relaunches++; },
    notify: () => { notifications++; },
  });
  assert.equal(resCold.action, "reattached");
  assert.equal(relaunches, 1);
  assert.equal(notifications, 2);
});

test("two concurrent evaluateAndHandoff calls execute relaunch at most once via handoff.lock", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3-guardian-race-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const pluginDir = path.join(home, ".t3", "hud-plugin");
  const fakeApp = path.join(home, "Applications", "T3 Code.app");
  fs.mkdirSync(path.join(fakeApp, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(fakeApp, "Contents", "MacOS", "T3 Code"), "");

  let relaunches = 0;
  const opts = {
    homeDir: home,
    pluginDir,
    getProcessStart: () => "start-race",
    findProcess: () => ({ pid: 4001, elapsedSec: 3, binPath: "/fake", appBundle: fakeApp, command: "/fake" }),
    isMounted: async () => {
      await new Promise((r) => setTimeout(r, 30));
      return false;
    },
    checkActiveWork: () => false,
    relaunch: async () => {
      relaunches++;
      await new Promise((r) => setTimeout(r, 40));
    },
    notify: () => {},
  };

  const [r1, r2] = await Promise.all([evaluateAndHandoff(opts), evaluateAndHandoff(opts)]);
  assert.equal(relaunches, 1, "concurrent handoff calls must never run relaunch twice");
  const actions = [r1.action, r2.action].sort();
  assert.deepEqual(actions, ["handoff_in_progress", "reattached"]);
});

test("formal relaunch aborts when old process refuses to exit, fails on bootstrap error/unmounted, and succeeds only when new PID mounts", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3-guardian-formal-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const pluginDir = path.join(home, ".t3", "hud-plugin");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "bootstrap.cjs"), "// stub\n");
  const stateFile = path.join(pluginDir, "run", "guardian-state.json");
  const fakeApp = path.join(home, "Applications", "T3 Code.app");
  fs.mkdirSync(path.join(fakeApp, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(fakeApp, "Contents", "MacOS", "T3 Code"), "");

  let nowMs = 1_700_000_000_000;
  let bootSpawns = 0;

  // Case A: Old process stays alive -> old_process_still_alive, NEVER spawns bootstrap
  const resStillAlive = await evaluateAndHandoff({
    homeDir: home,
    pluginDir,
    now: () => nowMs,
    quitPollIntervalMs: 5,
    quitMaxChecks: 2,
    getProcessStart: () => "start-a",
    findProcess: () => ({ pid: 5001, elapsedSec: 3, binPath: "/fake", appBundle: fakeApp, command: "/fake" }),
    isMounted: async () => false,
    checkActiveWork: () => false,
    readEnv: () => ({ env: {} }),
    isPidAlive: () => true,
    quitProcess: () => {},
    resolveRuntime: () => ({ bin: process.execPath, useRunAsNode: false }),
    spawnBootstrap: async () => { bootSpawns++; return { code: 0 }; },
    notify: () => {},
  });
  assert.equal(resStillAlive.ok, false);
  assert.equal(resStillAlive.action, "old_process_still_alive");
  assert.equal(bootSpawns, 0, "must NOT launch bootstrap while old PID is still alive");

  // Case B: Old process exits, bootstrap exits non-zero -> reattach_failed, increments consecutiveFailures -> triggers cooldown
  nowMs += 60_000;
  let oldAlive = true;
  const resBootFail = await evaluateAndHandoff({
    homeDir: home,
    pluginDir,
    now: () => nowMs,
    quitPollIntervalMs: 5,
    quitMaxChecks: 3,
    getProcessStart: () => "start-b",
    findProcess: () => ({ pid: 5002, elapsedSec: 3, binPath: "/fake", appBundle: fakeApp, command: "/fake" }),
    isMounted: async () => false,
    checkActiveWork: () => false,
    readEnv: () => ({ env: {} }),
    isPidAlive: (p) => (p === 5002 ? oldAlive : true),
    quitProcess: () => { oldAlive = false; },
    resolveRuntime: () => ({ bin: process.execPath, useRunAsNode: false }),
    spawnBootstrap: async () => ({ code: 1 }),
    notify: () => {},
  });
  assert.equal(resBootFail.ok, false);
  assert.equal(resBootFail.action, "reattach_failed");
  assert.equal(resBootFail.reason, "bootstrap_failed");
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).consecutiveFailures, 2);

  // Next attempt hits cooldown because consecutiveFailures >= 2 in 10m window
  nowMs += 60_000;
  const resCooldown = await evaluateAndHandoff({
    homeDir: home,
    pluginDir,
    now: () => nowMs,
    getProcessStart: () => "start-c",
    findProcess: () => ({ pid: 5003, elapsedSec: 3, binPath: "/fake", appBundle: fakeApp, command: "/fake" }),
    isMounted: async () => false,
    checkActiveWork: () => false,
    readEnv: () => ({ env: {} }),
    notify: () => {},
  });
  assert.equal(resCooldown.action, "cooldown_notified");

  // Case C: After cooldown window passes, bootstrap exits 0 AND new PID is unmounted -> reattach_failed
  nowMs += 15 * 60 * 1000;
  oldAlive = true;
  let currentPid = 5004;
  const resUnmountedNew = await evaluateAndHandoff({
    homeDir: home,
    pluginDir,
    now: () => nowMs,
    quitPollIntervalMs: 5,
    quitMaxChecks: 3,
    getProcessStart: () => "start-d",
    findProcess: () => ({ pid: currentPid, elapsedSec: 3, binPath: "/fake", appBundle: fakeApp, command: "/fake" }),
    isMounted: async () => false,
    checkActiveWork: () => false,
    readEnv: () => ({ env: {} }),
    isPidAlive: (p) => (p === 5004 ? oldAlive : true),
    quitProcess: () => { oldAlive = false; },
    resolveRuntime: () => ({ bin: process.execPath, useRunAsNode: false }),
    spawnBootstrap: async () => { currentPid = 5005; return { code: 0 }; },
    notify: () => {},
  });
  assert.equal(resUnmountedNew.ok, false);
  assert.equal(resUnmountedNew.action, "reattach_failed");
  assert.equal(resUnmountedNew.reason, "mount_not_confirmed");

  // Case D: Bootstrap exits 0 AND new PID confirms mounted -> reattached + consecutiveFailures reset to 0
  nowMs += 60_000;
  oldAlive = true;
  currentPid = 5006;
  const resOk = await evaluateAndHandoff({
    homeDir: home,
    pluginDir,
    now: () => nowMs,
    quitPollIntervalMs: 5,
    quitMaxChecks: 3,
    getProcessStart: () => "start-e",
    findProcess: () => ({ pid: currentPid, elapsedSec: 3, binPath: "/fake", appBundle: fakeApp, command: "/fake" }),
    isMounted: async (pid) => pid === 5007,
    checkActiveWork: () => false,
    readEnv: () => ({ env: {} }),
    isPidAlive: (p) => (p === 5006 ? oldAlive : true),
    quitProcess: () => { oldAlive = false; },
    resolveRuntime: () => ({ bin: process.execPath, useRunAsNode: false }),
    spawnBootstrap: async () => { currentPid = 5007; return { code: 0 }; },
    notify: () => {},
  });
  assert.equal(resOk.ok, true);
  assert.equal(resOk.action, "reattached");
  assert.equal(resOk.newPid, 5007);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).consecutiveFailures, 0);
});

test("runPollingMode keeps polling through no_app and not_running for plist-changed and upgrade-handoff", async () => {
  const sequence = ["no_app", "no_app", "not_running", "reattached"];
  let idx = 0;
  let clock = 0;
  const resPlist = await runPollingMode({
    mode: "plist-changed",
    deadlineMs: 5000,
    pollIntervalMs: 100,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    evaluate: async () => ({ ok: true, action: sequence[Math.min(idx++, sequence.length - 1)] }),
  });
  assert.equal(resPlist.action, "reattached");
  assert.equal(idx, 4);

  // upgrade-handoff waits for prevPid to exit AND polls past no_app
  let oldChecks = 0;
  let evalIdx = 0;
  clock = 0;
  const resHandoff = await runPollingMode({
    mode: "upgrade-handoff",
    prevPid: 7777,
    deadlineMs: 5000,
    pollIntervalMs: 100,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    isPidAlive: () => (++oldChecks) < 2,
    evaluate: async () => ({ ok: true, action: ["no_app", "not_running", "already_mounted"][Math.min(evalIdx++, 2)] }),
  });
  assert.equal(resHandoff.action, "already_mounted");
  assert.equal(evalIdx, 3);
});

test("guardian backs off during live bootstrap.lock and avoids double-killing --remote-debugging-port cold boot", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3-guardian-lock-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const pluginDir = path.join(home, ".t3", "hud-plugin");
  const runDir = path.join(pluginDir, "run");
  fs.mkdirSync(runDir, { recursive: true });
  const fakeApp = path.join(home, "Applications", "T3 Code.app");
  fs.mkdirSync(path.join(fakeApp, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(fakeApp, "Contents", "MacOS", "T3 Code"), "");

  let nowMs = 1_700_000_000_000;
  let relaunches = 0;

  fs.writeFileSync(
    path.join(runDir, "bootstrap.lock"),
    JSON.stringify({ pid: process.pid, targetPid: 2001, startedAt: nowMs - 5000 }),
    { mode: 0o600 }
  );
  const resLocked = await evaluateAndHandoff({
    homeDir: home,
    pluginDir,
    now: () => nowMs,
    getProcessStart: () => "start-lock",
    findProcess: () => ({ pid: 2001, elapsedSec: 3, binPath: "/fake", appBundle: fakeApp, command: "/fake" }),
    isMounted: async () => false,
    checkActiveWork: () => false,
    relaunch: async () => { relaunches++; },
    notify: () => {},
  });
  assert.equal(resLocked.action, "bootstrap_in_progress");
  assert.equal(relaunches, 0);

  fs.unlinkSync(path.join(runDir, "bootstrap.lock"));
  nowMs += 40_000;
  let checks = 0;
  const resHudStillBooting = await evaluateAndHandoff({
    homeDir: home,
    pluginDir,
    hudColdWaitMs: 10,
    now: () => nowMs,
    getProcessStart: () => "start-hud",
    findProcess: () => ({
      pid: 2002,
      elapsedSec: 4,
      binPath: "/fake",
      appBundle: fakeApp,
      command: "/fake --remote-debugging-port=0",
    }),
    isMounted: async () => { checks++; return false; },
    checkActiveWork: () => false,
    relaunch: async () => { relaunches++; },
    notify: () => {},
  });
  assert.equal(resHudStillBooting.action, "hud_booting_skipped");
  assert.equal(checks, 2);
  assert.equal(relaunches, 0);

  checks = 0;
  const resHudBecameReady = await evaluateAndHandoff({
    homeDir: home,
    pluginDir,
    hudColdWaitMs: 10,
    now: () => nowMs,
    getProcessStart: () => "start-hud2",
    findProcess: () => ({
      pid: 2003,
      elapsedSec: 4,
      binPath: "/fake",
      appBundle: fakeApp,
      command: "/fake --remote-debugging-port=0",
    }),
    isMounted: async () => { checks++; return checks >= 2; },
    checkActiveWork: () => false,
    relaunch: async () => { relaunches++; },
    notify: () => {},
  });
  assert.equal(resHudBecameReady.action, "already_mounted");
  assert.equal(relaunches, 0);
});

test("guardian enforces anti-loop cooldown in guardian-state.json and resets failures on already_mounted", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3-guardian-cooldown-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const pluginDir = path.join(home, ".t3", "hud-plugin");
  const stateFile = path.join(pluginDir, "run", "guardian-state.json");
  const fakeApp = path.join(home, "Applications", "T3 Code.app");
  fs.mkdirSync(path.join(fakeApp, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(fakeApp, "Contents", "MacOS", "T3 Code"), "");
  fs.writeFileSync(
    path.join(fakeApp, "Contents", "Info.plist"),
    "<plist><dict><key>CFBundleShortVersionString</key><string>0.1.13</string><key>CFBundleVersion</key><string>13</string></dict></plist>"
  );

  let nowMs = 1_700_000_000_000;
  let relaunches = 0;
  let notifications = 0;
  const runOnce = (mounted = false) => evaluateAndHandoff({
    homeDir: home,
    pluginDir,
    now: () => nowMs,
    getProcessStart: () => "start-cd",
    findProcess: () => ({ pid: 3001, elapsedSec: 4, binPath: "/fake", appBundle: fakeApp, command: "/fake" }),
    isMounted: async () => mounted,
    checkActiveWork: () => false,
    relaunch: async () => { relaunches++; },
    notify: () => { notifications++; },
  });

  assert.equal((await runOnce(false)).action, "reattached");
  assert.equal(relaunches, 1);
  assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).consecutiveFailures, 1);

  nowMs += 10_000;
  assert.equal((await runOnce(false)).action, "cooldown_notified");
  assert.equal(relaunches, 1);
  assert.equal(notifications, 1);

  nowMs += 50_000;
  assert.equal((await runOnce(false)).action, "reattached");
  assert.equal(relaunches, 2);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).consecutiveFailures, 2);

  nowMs += 60_000;
  assert.equal((await runOnce(false)).action, "cooldown_notified");
  assert.equal(relaunches, 2);
  assert.equal(notifications, 2);

  assert.equal((await runOnce(true)).action, "already_mounted");
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).consecutiveFailures, 0);
});

test("RunAsNode=0 fuse triggers capability-verified fallback to system node and returns null when no capable runtime exists", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3-guardian-fuse-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const sentinel = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX", "ascii");

  const makeApp = (name, fuseWireBuf) => {
    const app = path.join(home, "Applications", name);
    fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
    fs.writeFileSync(path.join(app, "Contents", "MacOS", "T3 Code"), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
    const fwDir = path.join(app, "Contents", "Frameworks", "Electron Framework.framework", "Versions", "A");
    fs.mkdirSync(fwDir, { recursive: true });
    fs.writeFileSync(path.join(fwDir, "Electron Framework"), Buffer.concat([Buffer.from("HEADER"), sentinel, fuseWireBuf, Buffer.from("TAIL")]));
    return app;
  };

  const appEnabled = makeApp("T3 Enabled.app", Buffer.concat([Buffer.from([1, 9]), Buffer.from("101000011", "ascii")]));
  assert.equal(isElectronRunAsNodeEnabled(appEnabled), true);
  const rtEnabled = resolveNodeRuntime({ appBundle: appEnabled, systemNodeCandidates: [process.execPath] });
  assert.equal(rtEnabled.useRunAsNode, true);
  assert.equal(rtEnabled.bin, path.join(appEnabled, "Contents", "MacOS", "T3 Code"));

  const appDisabled = makeApp("T3 Disabled.app", Buffer.concat([Buffer.from([1, 9]), Buffer.from("001000011", "ascii")]));
  assert.equal(isElectronRunAsNodeEnabled(appDisabled), false);
  const rtDisabled = resolveNodeRuntime({ appBundle: appDisabled, systemNodeCandidates: [process.execPath] });
  assert.equal(rtDisabled.useRunAsNode, false);
  assert.equal(rtDisabled.bin, process.execPath);

  // Incapable node + RunAsNode=0 -> returns null (never returns disabled Electron binary!)
  const oldNode = path.join(home, "old-node");
  fs.writeFileSync(oldNode, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  assert.equal(resolveNodeRuntime({ appBundle: appDisabled, systemNodeCandidates: [oldNode] }), null);

  // Direct sentinel + "0..." format also detected as disabled
  const appDirectDisabled = makeApp("T3 Direct.app", Buffer.from("001000011", "ascii"));
  assert.equal(isElectronRunAsNodeEnabled(appDirectDisabled), false);
});

test("LaunchAgent plist uses stable CLI entrypoint, pre-creates 0600 non-symlink guardian.log, and rejects symlink log", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3-guardian-plist-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const cmds = [];
  const mgr = createGuardianManager({
    homeDir: home,
    pluginDir: path.join(home, ".t3", "hud-plugin"),
    launchctl: (args) => { cmds.push(args); return { ok: true }; },
  });

  const enabled = mgr.enable();
  assert.equal(enabled.ok, true);
  assert.equal(enabled.enabled, true);
  assert.ok(fs.existsSync(mgr.plistPath));
  assert.equal(fs.statSync(mgr.logPath).mode & 0o777, 0o600);
  const xml = fs.readFileSync(mgr.plistPath, "utf8");
  assert.match(xml, /<string>\/bin\/bash<\/string>/);
  assert.match(xml, /t3-hud<\/string>/);
  assert.match(xml, /--mode=plist-changed/);
  assert.doesNotMatch(xml, /ELECTRON_RUN_AS_NODE/);
  assert.match(xml, /<key>WatchPaths<\/key>/);
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<false\/>/);
  assert.match(xml, /Info\.plist/);

  // Symlink guardian.log is refused
  const victim = path.join(home, "victim.txt");
  fs.writeFileSync(victim, "keep", { mode: 0o644 });
  fs.unlinkSync(mgr.logPath);
  fs.symlinkSync(victim, mgr.logPath);
  assert.throws(() => mgr.enable(), /unsafe log file/);
  assert.equal(fs.statSync(victim).mode & 0o777, 0o644);

  const disabled = mgr.disable();
  assert.equal(disabled.ok, true);
  assert.equal(disabled.enabled, false);
  assert.ok(!fs.existsSync(mgr.plistPath));

  const sampleXml = buildLaunchAgentPlist({ nodeBin: "/a", scriptPath: "/b", pluginDir: "/c", watchPaths: ["/d/Info.plist"], logPath: "/e" });
  assert.match(sampleXml, /--mode=plist-changed/);
});

function handoffFixture(t) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-guardian-handoff-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const pluginDir = path.join(homeDir, "hud-plugin");
  const appBundle = path.join(homeDir, "Applications", "T3 Code.app");
  const binPath = path.join(appBundle, "Contents/MacOS/T3 Code");
  fs.mkdirSync(path.dirname(binPath), { recursive: true });
  fs.mkdirSync(pluginDir, { recursive: true });
  const bootstrap = path.join(pluginDir, "bootstrap.cjs");
  fs.writeFileSync(bootstrap, "// fixture");
  return {
    bootstrap, homeDir, pluginDir, appBundle,
    find(pid) { return { pid, elapsedSec: 2, binPath, appBundle, command: binPath }; },
  };
}

test("guardian will not quit if identity is unreadable or work starts during mount recheck", async (t) => {
  for (const readStart of ["missing-initial", "missing-final", "changed-final", "busy-final"]) {
    await t.test(readStart, async (t) => {
      const f = handoffFixture(t);
      const dataHome = path.join(f.homeDir, "target-data");
      fs.mkdirSync(dataHome);
      const db = new DatabaseSync(path.join(dataHome, "statev2.sqlite"));
      db.exec("CREATE TABLE orchestration_v2_projection_runs (id TEXT, status TEXT)");
      t.after(() => db.close());
      let mountChecks = 0;
      let reads = 0;
      let quits = 0;
      const result = await evaluateAndHandoff({
        ...f,
        findProcess: () => f.find(4111),
        readEnv: () => ({ env: { T3CODE_HOME: dataHome } }),
        getProcessStart: () => {
          reads++;
          if (readStart === "missing-initial" && reads === 1) return null;
          if (readStart === "missing-final" && reads > 1) return null;
          if (readStart === "changed-final" && reads > 1) return "successor";
          return "original";
        },
        resolveRuntime: () => ({ bin: process.execPath }),
        isMounted: async () => {
          if (++mountChecks === 2 && readStart === "busy-final") {
            db.exec("INSERT INTO orchestration_v2_projection_runs VALUES ('started-during-mount-check', 'running')");
          }
          return false;
        },
        quitProcess: () => { quits++; },
        notify: () => {},
      });
      assert.equal(result.action, readStart === "busy-final" ? "notified_only" : "process_identity_changed");
      assert.equal(quits, 0);
    });
  }
});

test("guardian propagates the old T3CODE_HOME and confirms the new PID in the same data directory", async (t) => {
  for (const scenario of ["custom-matches", "custom-wrong-new-home", "default-clears-guardian-env"]) {
    await t.test(scenario, async (t) => {
      const f = handoffFixture(t);
      const inherited = path.join(f.homeDir, "guardian-data");
      const custom = path.join(f.homeDir, "target data");
      const previous = process.env.T3CODE_HOME;
      process.env.T3CODE_HOME = inherited;
      t.after(() => {
        if (previous === undefined) delete process.env.T3CODE_HOME;
        else process.env.T3CODE_HOME = previous;
      });
      const override = scenario === "default-clears-guardian-env" ? undefined : custom;
      const output = path.join(f.homeDir, "bootstrap-env.json");
      fs.writeFileSync(f.bootstrap, `require("node:fs").writeFileSync(${JSON.stringify(output)}, JSON.stringify({
        home: process.env.T3CODE_HOME ?? null
      }));`);
      let oldAlive = true;
      const res = await evaluateAndHandoff({
        ...f,
        findProcess: () => f.find(oldAlive ? 5101 : 5102),
        getProcessStart: (pid) => "start-" + pid,
        readEnv: (pid) => ({
          env: { T3CODE_HOME: pid === 5102 && scenario === "custom-wrong-new-home" ? inherited : override },
        }),
        checkActiveWork: () => false,
        isMounted: async (pid) => pid === 5102,
        isPidAlive: (pid) => pid !== 5101 || oldAlive,
        quitProcess: () => { oldAlive = false; },
        resolveRuntime: () => ({ bin: process.execPath, useRunAsNode: false }),
        notify: () => {},
      });
      assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), { home: override ?? null });
      if (scenario === "custom-wrong-new-home") {
        assert.equal(res.action, "reattach_failed");
        assert.equal(res.reason, "mount_not_confirmed");
      } else {
        assert.equal(res.action, "reattached");
        assert.equal(res.newPid, 5102);
      }
    });
  }
});

test("bootstrap and handoff locks atomically publish one complete live owner under process contention", async (t) => {
  const { spawn } = require("node:child_process");
  const { once } = require("node:events");
  const { acquireExclusiveLock } = require("../src/hud-runtime.cjs");
  const f = handoffFixture(t);
  const runDir = path.join(f.pluginDir, "run");
  fs.mkdirSync(runDir, { mode: 0o700 });
  for (const name of ["bootstrap.lock", "handoff.lock"]) {
    const lockPath = path.join(runDir, name);
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 2147483647, startedAt: 1, lockId: "stale" }), { mode: 0o600 });
    const stat = fs.statSync(lockPath);
    const interruptedReclaim = `${lockPath}.reap-${stat.dev}-${stat.ino}`;
    fs.mkdirSync(interruptedReclaim);
    fs.writeFileSync(path.join(interruptedReclaim, "owner-2147483647-" + "a".repeat(24)), "");
    const script = `
      const { acquireExclusiveLock } = require(process.argv[1]);
      let lock;
      process.on("message", ({ start }) => {
        if (start) {
          lock = acquireExclusiveLock(process.argv[2]);
          process.send({ acquired: lock.acquired, owner: lock.payload });
        } else {
          if (lock?.acquired) lock.release();
          process.disconnect();
        }
      });
      process.send("ready");
    `;
    const children = Array.from({ length: 12 }, () => spawn(process.execPath, [
      "-e", script, require.resolve("../src/hud-runtime.cjs"), lockPath,
    ], { stdio: ["ignore", "ignore", "inherit", "ipc"] }));
    t.after(() => { for (const child of children) if (child.exitCode === null) child.kill(); });
    await Promise.all(children.map((child) => once(child, "message")));
    const claims = children.map((child) => once(child, "message"));
    for (const child of children) child.send({ start: true });
    const owners = (await Promise.all(claims)).map(([result]) => result).filter((result) => result.acquired);
    assert.equal(owners.length, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(lockPath, "utf8")), owners[0].owner);
    assert.equal(fs.statSync(lockPath).mode & 0o777, 0o600);
    const exits = children.map((child) => once(child, "exit"));
    for (const child of children) child.send({ start: false });
    assert.deepEqual(await Promise.all(exits), children.map(() => [0, null]));
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(fs.existsSync(interruptedReclaim), false);
    const before = acquireExclusiveLock(lockPath);
    assert.equal(before.acquired, true);
    fs.renameSync(lockPath, lockPath + ".old");
    const successor = acquireExclusiveLock(lockPath);
    assert.equal(successor.acquired, true);
    assert.equal(before.update({ targetPid: 1234 }), false);
    before.release();
    assert.deepEqual(JSON.parse(fs.readFileSync(lockPath, "utf8")), successor.payload);
    successor.release();
  }
});

test("installed LaunchAgent entrypoint survives a missing bundle and runs handoff after it returns", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const { spawn, execFileSync } = require("node:child_process");
  const { once } = require("node:events");
  const f = handoffFixture(t);
  const cliPath = path.join(f.homeDir, "bin", "t3-hud");
  fs.mkdirSync(path.dirname(cliPath));
  fs.copyFileSync(path.join(__dirname, "../bin/t3-hud"), cliPath);
  const removed = f.appBundle + ".replacing";
  fs.renameSync(f.appBundle, removed);
  const plist = path.join(f.homeDir, "fixture.plist");
  fs.writeFileSync(plist, buildLaunchAgentPlist({
    cliPath, pluginDir: f.pluginDir, watchPaths: [], logPath: "/dev/null",
    envAppPath: f.appBundle, systemNodeBin: process.execPath,
  }));
  const args = JSON.parse(execFileSync("/usr/bin/plutil", ["-extract", "ProgramArguments", "json", "-o", "-", plist]));
  const environment = JSON.parse(execFileSync("/usr/bin/plutil", ["-extract", "EnvironmentVariables", "json", "-o", "-", plist]));
  const guardian = require.resolve("../src/update-guardian.cjs");
  // Execute the actual shell entry and polling/handoff code with isolated
  // process and runtime hooks. This fixture never invokes a macOS quit event.
  fs.writeFileSync(path.join(f.pluginDir, "update-guardian.cjs"), `
    const { evaluateAndHandoff, runPollingMode } = require(${JSON.stringify(guardian)});
    let oldAlive = true;
    runPollingMode({
      mode: process.argv[2].slice("--mode=".length),
      pollIntervalMs: 35,
      deadlineMs: 4000,
      evaluate: async ({pluginDir}) => {
        const result = await evaluateAndHandoff({
          pluginDir,
          findProcess: (appBundle) => ({ appBundle, pid: oldAlive ? 6101 : 6102, elapsedSec: 2 }),
          getProcessStart: (pid) => "start-" + pid,
          readEnv: () => ({ env: {} }),
          checkActiveWork: () => false,
          isMounted: async (pid) => pid === 6102,
          isPidAlive: (pid) => pid !== 6101 || oldAlive,
          quitProcess: () => { oldAlive = false; },
          resolveRuntime: () => ({ bin: process.execPath, useRunAsNode: false }),
          notify: () => {},
        });
        if (result.action === "no_app") console.log("awaiting-bundle");
        return result;
      },
    }).then((result) => console.log(JSON.stringify(result)));
  `);
  const proc = spawn(args[0], args.slice(1), {
    env: { ...environment, HOME: f.homeDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (proc.exitCode === null) proc.kill(); });
  let stdout = "";
  let stderr = "";
  let restored = false;
  proc.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
    if (!restored && stdout.includes("awaiting-bundle")) {
      fs.renameSync(removed, f.appBundle);
      restored = true;
    }
  });
  proc.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const [exit] = await once(proc, "close");
  assert.equal(exit, 0, stderr);
  assert.equal(restored, true);
  assert.deepEqual(JSON.parse(stdout.trim().split("\n").at(-1)), {
    ok: true, action: "reattached", pid: 6101, newPid: 6102,
  });
});
