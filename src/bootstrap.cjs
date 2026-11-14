"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

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

try {
  fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(RUN_DIR, 0o700);
  } catch {}
  let st = null;
  try {
    st = fs.lstatSync(RUN_DIR);
  } catch {}
  if (st && st.isSymbolicLink()) {
    try {
      fs.unlinkSync(RUN_DIR);
    } catch {}
    fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(RUN_DIR, 0o700);
    } catch {}
  }
  try {
    const mst = fs.lstatSync(MARKER_FILE);
    if (mst.isSymbolicLink()) fs.unlinkSync(MARKER_FILE);
  } catch {}
  fs.writeFileSync(MARKER_FILE, String(child.pid), { flag: "w", mode: 0o600 });
} catch {}

let injected = false;
let stderrBuf = "";

const finish = (code = 0) => {
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
  finish(injected ? 0 : 1);
}, 10000);
timer.unref();

child.on("error", (err) => {
  console.error("[t3-hud] Failed to launch T3 Code:", err.message);
  finish(1);
});

child.stderr.on("data", (chunk) => {
  if (injected) return;
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

  const ws = new WebSocket(wsUrl);
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
          try {
            ws.close();
          } catch {}
          finish(0);
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
  ws.onerror = () => {
    finish(1);
  };
});
