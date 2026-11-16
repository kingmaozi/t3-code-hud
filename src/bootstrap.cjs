"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { checkHud } = require("./hud-health.cjs");

function resolveT3Bundle() {
  const candidates = [
    process.env.T3_APP_PATH,
    "/Applications/T3 Code (Beta).app",
    "/Applications/T3 Code.app",
    "/Applications/T3 Code (Nightly).app",
    path.join(os.homedir(), "Applications", "T3 Code (Beta).app"),
    path.join(os.homedir(), "Applications", "T3 Code.app"),
    path.join(os.homedir(), "Applications", "T3 Code (Nightly).app"),
  ].filter(Boolean);

  for (const appBundle of candidates) {
    const macosDir = path.join(appBundle, "Contents", "MacOS");
    const asarPkg = path.join(appBundle, "Contents", "Resources", "app.asar", "package.json");
    if (!fs.existsSync(macosDir) || !fs.existsSync(asarPkg)) continue;
    try {
      const bins = fs.readdirSync(macosDir).filter((n) => !n.startsWith("."));
      const mainBin = bins.find((n) => /t3\s*code/i.test(n)) || bins[0];
      if (mainBin) {
        return {
          appBundle,
          binPath: path.join(macosDir, mainBin),
          asarPkg,
        };
      }
    } catch {}
  }
  return null;
}

const resolved = resolveT3Bundle();
if (!resolved) {
  console.error(
    "[t3-hud] Could not locate T3 Code.app or T3 Code (Beta).app. Set T3_APP_PATH=/path/to/T3\\ Code.app"
  );
  process.exit(1);
}

const HOOK_PATH = path.join(__dirname, "main-hook.cjs");
const RUN_DIR = path.join(os.homedir(), ".t3", "hud-plugin", "run");
const MARKER_FILE = path.join(RUN_DIR, "active.pid");


const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
delete childEnv.NODE_OPTIONS;
const basePath = childEnv.PATH || "/usr/bin:/bin:/usr/sbin:/sbin";
if (!basePath.includes("/opt/homebrew/bin")) {
  childEnv.PATH = `/opt/homebrew/bin:/usr/local/bin:${basePath}`;
}

const extraArgs = process.argv.slice(2);
const child = spawn(resolved.binPath, ["--inspect=127.0.0.1:0", ...extraArgs], {
  env: childEnv,
  detached: true,
  stdio: ["ignore", "ignore", "pipe"],
});

// A failed secondary launch must not mutate the active instance's marker.
// Publish atomically, only after both evaluate and authenticated RPC succeed.
function writeMarker() {
  fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(RUN_DIR).isSymbolicLink()) throw new Error("HUD run directory is a symlink");
  let previous;
  try { previous = Number(fs.readFileSync(MARKER_FILE, "utf8").trim()); } catch {}
  if (previous > 0 && previous !== child.pid) {
    let alive = false;
    try { process.kill(previous, 0); alive = true; } catch (err) { alive = err.code !== "ESRCH"; }
    if (alive) throw new Error("HUD marker belongs to another live process");
  }
  const temp = `${MARKER_FILE}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, String(child.pid), { flag: "wx", mode: 0o600 });
    fs.renameSync(temp, MARKER_FILE);
  } finally {
    try { fs.unlinkSync(temp); } catch {}
  }
}

let injected = false;
let finished = false;
let verifying = false;
let retryTimer;
let inspectorSocket;
let stderrBuf = "";

const finish = (code = 0) => {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  clearTimeout(retryTimer);
  try { inspectorSocket?.close(); } catch {}
  try {
    child.stderr.removeAllListeners();
    child.stderr.destroy();
  } catch {}
  try {
    child.unref();
  } catch {}
  process.exit(code);
};

const timer = setTimeout(() => {
  console.error("[t3-hud] Timed out waiting for confirmed HUD readiness");
  finish(1);
}, 10000);

child.on("error", (err) => {
  console.error("[t3-hud] Failed to launch T3 Code:", err.message);
  finish(1);
});
child.on("exit", () => finish(1));

async function confirmReady() {
  if (finished) return;
  const ready = await checkHud({rpcFile: path.join(RUN_DIR, `rpc-${child.pid}.json`), pid: child.pid});
  if (finished) return;
  if (!ready) { retryTimer = setTimeout(confirmReady, 100); return; }
  try { writeMarker(); finish(0); }
  catch (err) { console.error("[t3-hud] Could not record HUD readiness:", err.message); finish(1); }
}

child.stderr.on("data", (chunk) => {
  if (finished || injected) return;
  stderrBuf += chunk.toString("utf8");
  const match = stderrBuf.match(/ws:\/\/127\.0\.0\.1:\d+\/[0-9a-fA-F-]+/);
  if (!match) return;

  injected = true;
  const wsUrl = match[0];
  const expr = `(() => {
    try {
      const mod = process.getBuiltinModule("node:module");
      const req = mod.createRequire(${JSON.stringify(resolved.asarPkg)});
      req(${JSON.stringify(HOOK_PATH)});
      const ins = process.getBuiltinModule("node:inspector");
      setTimeout(() => { try { ins.close(); } catch {} }, 80);
      return "OK";
    } catch (e) {
      return "ERR:" + (e && e.stack ? e.stack : e);
    }
  })()`;

  const ws = inspectorSocket = new WebSocket(wsUrl);
  ws.onopen = () => {
    ws.send(
      JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: {
          expression: expr,
          returnByValue: true,
        },
      })
    );
  };
  ws.onmessage = (event) => {
    if (finished || verifying) return;
    try {
      let msg = null;
      try {
        msg = JSON.parse(event.data);
      } catch {
        console.error("[t3-hud] WebSocket message is not JSON");
        finish(1);
        return;
      }
      if (msg && msg.id === 1) {
        const val = msg.result?.result?.value;
        const hasException = Boolean(msg.result?.exceptionDetails);
        if (!msg.error && !hasException && val === "OK") {
          verifying = true;
          try {
            ws.close();
          } catch {}
          void confirmReady();
        } else {
          const detail = msg.error?.message || JSON.stringify(msg.result?.exceptionDetails || msg.result?.result || msg);
          console.error("[t3-hud] HUD injection failed:", detail);
          try {
            ws.close();
          } catch {}
          finish(1);
        }
      }
    } catch (err) {
      console.error("[t3-hud] WebSocket handling failed:", err.message);
      finish(1);
    }
  };
  ws.onerror = () => { if (!verifying) finish(1); };
});
