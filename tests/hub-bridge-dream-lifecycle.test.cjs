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
