"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const BRIDGE = path.resolve(__dirname, "../src/hub-bridge.cjs");

test("bridge preserves memory RPC but never starts the Dream scheduler on boot or reload", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hub-dream-bridge-"));
  const pluginDir = path.join(home, ".t3", "hud-plugin");
  fs.mkdirSync(pluginDir, { recursive: true });
  const events = path.join(home, "scheduler-events.log");
  const stub = `const fs=require('node:fs');const events=${JSON.stringify(events)};module.exports={ensureDreamScheduler(){fs.appendFileSync(events,'start\\n')},stopDreamScheduler(){fs.appendFileSync(events,'stop\\n')},hubCall:async(action,payload)=>({ok:true,action,payload})};\n`;
  fs.writeFileSync(path.join(pluginDir, "backend.cjs"), stub);
  const child = spawn(process.execPath, [BRIDGE], {
    env: { HOME: home, PATH: process.env.PATH || "/usr/bin:/bin", T3_HUD_DIR: pluginDir, T3_WATCH_PID: "0" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let childError = "";
  child.stderr.setEncoding("utf8").on("data", chunk => { childError += chunk; });
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const waitForExit = (timeoutMs) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("bridge failed to stop")), timeoutMs);
    exit.then(value => { clearTimeout(timer); resolve(value); }, reject);
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null) await waitForExit(1500).catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  });

  let rpc;
  const deadline = Date.now() + 3000;
  while (!rpc && Date.now() < deadline) {
    try { rpc = JSON.parse(fs.readFileSync(path.join(pluginDir, "run", "hub-bridge.json"), "utf8")); }
    catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  assert.ok(rpc, `bridge did not publish RPC settings: ${childError}`);
  assert.equal(fs.existsSync(events), false, "bridge startup must not start the Dream scheduler");
  const headers = { "X-T3-Hud-Token": rpc.token, "Content-Type": "application/json" };
  const memoryResponse = await fetch(rpc.url + "/hub-rpc", { method: "POST", headers, body: JSON.stringify({ action: "memory:search", payload: { query: "isolated" } }) });
  assert.equal(memoryResponse.status, 200);
  assert.deepEqual(await memoryResponse.json(), { ok: true, action: "memory:search", payload: { query: "isolated" } }, "memory RPC remains available");
  const response = await fetch(rpc.url + "/reload", { method: "POST", headers: { "X-T3-Hud-Token": rpc.token } });
  assert.equal(response.status, 200);
  assert.deepEqual(fs.readFileSync(events, "utf8").trim().split("\n"), ["stop"], "reload may stop a compatible old scheduler but must not start a replacement");
  child.kill("SIGTERM");
  assert.deepEqual(await waitForExit(1500), { code: 0, signal: null });
  assert.deepEqual(fs.readFileSync(events, "utf8").trim().split("\n"), ["stop", "stop"], childError);
});

test("overlapping bridge instances isolate per-watchPid records, clean up on watchPid exit with scheduler stop, and refuse symlinks", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hub-bridge-multi-"));
  const pluginDir = path.join(home, ".t3", "hud-plugin");
  const runDir = path.join(pluginDir, "run");
  fs.mkdirSync(runDir, { recursive: true });
  const events = path.join(home, "events.log");
  fs.writeFileSync(
    path.join(pluginDir, "backend.cjs"),
    `const fs=require('node:fs');module.exports={stopDreamScheduler(){fs.appendFileSync(${JSON.stringify(events)},process.pid+'\\n')},hubCall:async()=>({ok:true})};\n`
  );

  // Spawn two dummy watched processes
  const watched1 = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { stdio: "ignore" });
  const watched2 = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { stdio: "ignore" });
  const bridge1 = spawn(process.execPath, [BRIDGE], {
    env: { HOME: home, PATH: process.env.PATH || "/usr/bin:/bin", T3_HUD_DIR: pluginDir, T3_WATCH_PID: String(watched1.pid), T3_BRIDGE_WATCH_MS: "60" },
    stdio: "ignore",
  });
  let bridge2 = null;
  t.after(() => {
    for (const p of [bridge1, bridge2, watched1, watched2]) {
      try { if (p && p.exitCode === null) p.kill("SIGKILL"); } catch {}
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  const waitJson = async (filePath) => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
      catch { await new Promise((r) => setTimeout(r, 25)); }
    }
    return null;
  };

  const f1 = path.join(runDir, `hub-bridge-${watched1.pid}.json`);
  const f2 = path.join(runDir, `hub-bridge-${watched2.pid}.json`);
  const shared = path.join(runDir, "hub-bridge.json");

  const rec1 = await waitJson(f1);
  assert.ok(rec1);
  assert.equal(fs.statSync(f1).mode & 0o777, 0o600);
  assert.equal(fs.statSync(shared).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(shared, "utf8")).pid, bridge1.pid);

  // Start bridge2 while bridge1 & watched1 are still alive
  bridge2 = spawn(process.execPath, [BRIDGE], {
    env: { HOME: home, PATH: process.env.PATH || "/usr/bin:/bin", T3_HUD_DIR: pluginDir, T3_WATCH_PID: String(watched2.pid), T3_BRIDGE_WATCH_MS: "60" },
    stdio: "ignore",
  });
  const rec2 = await waitJson(f2);
  assert.ok(rec2);
  assert.equal(fs.statSync(f2).mode & 0o777, 0o600);
  // Shared hub-bridge.json remains owned by live bridge1
  assert.equal(JSON.parse(fs.readFileSync(shared, "utf8")).pid, bridge1.pid);

  // Kill watched1 -> bridge1 must stop scheduler, exit cleanly, delete f1 & shared, and preserve f2!
  const b1Exit = new Promise((resolve) => bridge1.once("exit", (code) => resolve(code)));
  watched1.kill("SIGKILL");
  assert.equal(await b1Exit, 0);
  assert.equal(fs.existsSync(f1), false, "old per-watchPid record must be cleaned up");
  assert.equal(fs.existsSync(shared), false, "shared record owned by old bridge must be cleaned up");
  assert.equal(fs.existsSync(f2), true, "new bridge per-watchPid record must survive old bridge exit");
  assert.ok(fs.readFileSync(events, "utf8").includes(String(bridge1.pid)), "stopDreamScheduler must run on watchPid exit");

  // Symlink at hub-bridge-<pid>.json must be refused without touching target
  const victim = path.join(home, "victim.txt");
  fs.writeFileSync(victim, "preserve");
  const badBridgeFile = path.join(runDir, "hub-bridge-999999.json");
  fs.symlinkSync(victim, badBridgeFile);
  const badBridge = spawn(process.execPath, [BRIDGE], {
    env: { HOME: home, PATH: process.env.PATH || "/usr/bin:/bin", T3_HUD_DIR: pluginDir, T3_WATCH_PID: "999999", T3_BRIDGE_WATCH_MS: "60" },
    stdio: "ignore",
  });
  const badExit = await new Promise((resolve) => badBridge.once("exit", (code) => resolve(code)));
  assert.equal(badExit, 1);
  assert.equal(fs.readFileSync(victim, "utf8"), "preserve");
});

test("simultaneous bridge publishers keep distinct private records and old cleanup preserves the successor", async (t) => {
  const { once } = require("node:events");
  const { readLiveBridgeRecord } = require("../src/hud-runtime.cjs");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hub-bridge-publish-"));
  const pluginDir = path.join(home, "plugin");
  const runDir = path.join(pluginDir, "run");
  fs.mkdirSync(pluginDir);
  fs.writeFileSync(path.join(pluginDir, "backend.cjs"), "module.exports = {hubCall: () => ({ok: true})};\n");
  const children = [];
  t.after(async () => {
    await Promise.all(children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const done = once(child, "exit");
      child.kill("SIGKILL");
      await done;
    }));
    fs.rmSync(home, { recursive: true, force: true });
  });
  function spawnTracked(args, env = process.env) {
    const child = spawn(process.execPath, args, { env, stdio: "ignore" });
    children.push(child);
    return child;
  }
  const watch = () => spawnTracked(["-e", "setInterval(() => {}, 1000)"]);
  const bridge = (watched) => spawnTracked([BRIDGE], {
    HOME: home, PATH: process.env.PATH, T3_HUD_DIR: pluginDir,
    T3_WATCH_PID: String(watched.pid), T3_BRIDGE_WATCH_MS: "60000",
  });
  const shared = path.join(runDir, "hub-bridge.json");
  const readShared = () => JSON.parse(fs.readFileSync(shared, "utf8"));
  async function waitForRecord(watched, owner) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const live = readLiveBridgeRecord(runDir, watched.pid);
      if (live?.record.pid === owner.pid) return live;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.fail("bridge did not publish a live PID-scoped record");
  }

  const entries = [watch(), watch()].map((watched) => ({ watched, owner: bridge(watched) }));
  const records = await Promise.all(entries.map(({ watched, owner }) => waitForRecord(watched, owner)));
  for (const [index, record] of records.entries()) {
    assert.equal(record.filePath, path.join(runDir, `hub-bridge-${entries[index].watched.pid}.json`));
    assert.equal(fs.statSync(record.filePath).mode & 0o777, 0o600);
  }
  const oldest = entries.find(({ owner }) => owner.pid === readShared().pid);
  assert.ok(oldest);
  const watcherExit = once(oldest.watched, "exit");
  oldest.watched.kill();
  await watcherExit;

  const nextWatched = watch();
  const successor = bridge(nextWatched);
  const next = await waitForRecord(nextWatched, successor);
  const oldExit = once(oldest.owner, "exit");
  oldest.owner.kill();
  assert.deepEqual(await oldExit, [0, null]);
  assert.equal(readShared().pid, successor.pid);
  assert.equal(fs.statSync(shared).mode & 0o777, 0o600);
  assert.equal(readLiveBridgeRecord(runDir, nextWatched.pid).record.token, next.record.token);
  const remaining = entries.find((entry) => entry !== oldest);
  assert.equal(readLiveBridgeRecord(runDir, remaining.watched.pid).record.pid, remaining.owner.pid);
});

test("bridge CORS sets verified desktop origin and Vary: Origin when Origin is stripped, and rejects disallowed origins", async (t) => {
  async function startBridge(extraEnv = {}) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "hub-bridge-cors-"));
    const pluginDir = path.join(home, ".t3", "hud-plugin");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "backend.cjs"),
      "module.exports = { hubCall: async (action, payload) => ({ ok: true, action, payload }) };\n"
    );
    const child = spawn(process.execPath, [BRIDGE], {
      env: { HOME: home, PATH: process.env.PATH || "/usr/bin:/bin", T3_HUD_DIR: pluginDir, T3_WATCH_PID: "0", ...extraEnv },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const exit = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await Promise.race([exit, new Promise((r) => setTimeout(r, 1500))]);
      }
      fs.rmSync(home, { recursive: true, force: true });
    });
    let rpc;
    const deadline = Date.now() + 3000;
    while (!rpc && Date.now() < deadline) {
      try { rpc = JSON.parse(fs.readFileSync(path.join(pluginDir, "run", "hub-bridge.json"), "utf8")); }
      catch { await new Promise((r) => setTimeout(r, 20)); }
    }
    assert.ok(rpc, "bridge did not publish RPC settings");
    return rpc;
  }

  // Default desktop origin (t3code://app)
  const rpcDefault = await startBridge();
  const optMissing = await fetch(rpcDefault.url + "/hub-rpc", { method: "OPTIONS" });
  assert.equal(optMissing.status, 204);
  assert.equal(optMissing.headers.get("access-control-allow-origin"), "t3code://app");
  assert.equal(optMissing.headers.get("vary"), "Origin");
  assert.equal(optMissing.headers.get("access-control-allow-private-network"), "true");

  const postMissing = await fetch(rpcDefault.url + "/hub-rpc", {
    method: "POST",
    headers: { "X-T3-Hud-Token": rpcDefault.token, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "ping", payload: { ok: 1 } }),
  });
  assert.equal(postMissing.status, 200);
  assert.equal(postMissing.headers.get("access-control-allow-origin"), "t3code://app");
  assert.equal(postMissing.headers.get("vary"), "Origin");
  assert.deepEqual(await postMissing.json(), { ok: true, action: "ping", payload: { ok: 1 } });

  for (const badOrigin of ["https://evil.com", "null", "t3code://other", "http://localhost:4100", "http://127.0.0.1:4100"]) {
    const optBad = await fetch(rpcDefault.url + "/hub-rpc", {
      method: "OPTIONS",
      headers: { Origin: badOrigin },
    });
    assert.equal(optBad.status, 204);
    assert.equal(optBad.headers.get("access-control-allow-origin"), null, `OPTIONS must reject ${badOrigin}`);

    const postBad = await fetch(rpcDefault.url + "/hub-rpc", {
      method: "POST",
      headers: { "X-T3-Hud-Token": rpcDefault.token, "Content-Type": "application/json", Origin: badOrigin },
      body: JSON.stringify({ action: "ping" }),
    });
    assert.equal(postBad.headers.get("access-control-allow-origin"), null, `POST must reject ${badOrigin}`);
  }

  // Valid T3_DESKTOP_ORIGIN override (t3code-dev://app)
  const rpcDev = await startBridge({ T3_DESKTOP_ORIGIN: "t3code-dev://app" });
  assert.equal(rpcDev.desktopOrigin, "t3code-dev://app");
  assert.equal(rpcDev.loopbackOrigin, null);
  const optDev = await fetch(rpcDev.url + "/hub-rpc", { method: "OPTIONS" });
  assert.equal(optDev.headers.get("access-control-allow-origin"), "t3code-dev://app");
  assert.equal(optDev.headers.get("vary"), "Origin");

  // Single verified loopback origin allowed; other loopback ports remain blocked
  const rpcLoop = await startBridge({ T3_ALLOWED_LOOPBACK_ORIGIN: "http://127.0.0.1:5173" });
  assert.equal(rpcLoop.desktopOrigin, null);
  assert.equal(rpcLoop.loopbackOrigin, "http://127.0.0.1:5173");
  const optLoopNoOrigin = await fetch(rpcLoop.url + "/hub-rpc", { method: "OPTIONS" });
  assert.equal(optLoopNoOrigin.headers.get("access-control-allow-origin"), null);

  const optLoopOk = await fetch(rpcLoop.url + "/hub-rpc", {
    method: "OPTIONS",
    headers: { Origin: "http://127.0.0.1:5173" },
  });
  assert.equal(optLoopOk.status, 204);
  assert.equal(optLoopOk.headers.get("access-control-allow-origin"), "http://127.0.0.1:5173");
  assert.equal(optLoopOk.headers.get("vary"), "Origin");

  const postLoopOk = await fetch(rpcLoop.url + "/hub-rpc", {
    method: "POST",
    headers: { "X-T3-Hud-Token": rpcLoop.token, "Content-Type": "application/json", Origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ action: "ping", payload: { loop: 1 } }),
  });
  assert.equal(postLoopOk.status, 200);
  assert.equal(postLoopOk.headers.get("access-control-allow-origin"), "http://127.0.0.1:5173");
  assert.deepEqual(await postLoopOk.json(), { ok: true, action: "ping", payload: { loop: 1 } });

  const postLoopWrongToken = await fetch(rpcLoop.url + "/hub-rpc", {
    method: "POST",
    headers: { "X-T3-Hud-Token": "wrong-token", "Content-Type": "application/json", Origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ action: "ping" }),
  });
  assert.equal(postLoopWrongToken.status, 403);

  for (const unverifiedLoop of ["http://localhost:4100", "http://127.0.0.1:4100"]) {
    const optUnverified = await fetch(rpcLoop.url + "/hub-rpc", {
      method: "OPTIONS",
      headers: { Origin: unverifiedLoop },
    });
    assert.equal(optUnverified.headers.get("access-control-allow-origin"), null);
    const postUnverified = await fetch(rpcLoop.url + "/hub-rpc", {
      method: "POST",
      headers: { "X-T3-Hud-Token": rpcLoop.token, "Content-Type": "application/json", Origin: unverifiedLoop },
      body: JSON.stringify({ action: "ping" }),
    });
    assert.equal(postUnverified.headers.get("access-control-allow-origin"), null);
  }

  // Authenticated /reload can update origin policy without reloading backend
  const syncRes = await fetch(rpcLoop.url + "/reload", {
    method: "POST",
    headers: { "X-T3-Hud-Token": rpcLoop.token, "Content-Type": "application/json" },
    body: JSON.stringify({ desktopOrigin: "t3code-dev://app", loopbackOrigin: null, originOnly: true }),
  });
  assert.equal(syncRes.status, 200);
  assert.deepEqual(await syncRes.json(), { ok: true, desktopOrigin: "t3code-dev://app", loopbackOrigin: null });
  const optAfterSync = await fetch(rpcLoop.url + "/hub-rpc", { method: "OPTIONS" });
  assert.equal(optAfterSync.headers.get("access-control-allow-origin"), "t3code-dev://app");
  const optOldLoopAfterSync = await fetch(rpcLoop.url + "/hub-rpc", {
    method: "OPTIONS",
    headers: { Origin: "http://127.0.0.1:5173" },
  });
  assert.equal(optOldLoopAfterSync.headers.get("access-control-allow-origin"), null);

  // Invalid T3_DESKTOP_ORIGIN falls back safely to t3code://app (never wildcard or untrusted origin)
  const rpcSanitized = await startBridge({ T3_DESKTOP_ORIGIN: "https://evil.com" });
  const optSanitized = await fetch(rpcSanitized.url + "/hub-rpc", { method: "OPTIONS" });
  assert.equal(optSanitized.headers.get("access-control-allow-origin"), "t3code://app");
  assert.equal(optSanitized.headers.get("vary"), "Origin");
});
