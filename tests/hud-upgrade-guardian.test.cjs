"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  parseEtimeSeconds,
  buildLaunchAgentPlist,
  createGuardianManager,
  evaluateAndHandoff,
} = require("../src/update-guardian.cjs");

test("parseEtimeSeconds handles MM:SS, HH:MM:SS, and DD-HH:MM:SS", () => {
  assert.equal(parseEtimeSeconds("00:08"), 8);
  assert.equal(parseEtimeSeconds("02:15"), 135);
  assert.equal(parseEtimeSeconds("01:02:03"), 3723);
  assert.equal(parseEtimeSeconds("2-01:00:00"), 2 * 86400 + 3600);
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

test("LaunchAgent plist enable/disable is idempotent and uses WatchPaths with RunAtLoad=false", (t) => {
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
  const xml = fs.readFileSync(mgr.plistPath, "utf8");
  assert.match(xml, /<key>WatchPaths<\/key>/);
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<false\/>/);
  assert.match(xml, /Info\.plist/);

  const disabled = mgr.disable();
  assert.equal(disabled.ok, true);
  assert.equal(disabled.enabled, false);
  assert.ok(!fs.existsSync(mgr.plistPath));

  const sampleXml = buildLaunchAgentPlist({ nodeBin: "/a", scriptPath: "/b", pluginDir: "/c", watchPaths: ["/d/Info.plist"], logPath: "/e" });
  assert.match(sampleXml, /--mode=plist-changed/);
});
