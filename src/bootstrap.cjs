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
const MARKER_FILE = "/tmp/t3-hud-active.pid";

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
  fs.writeFileSync(MARKER_FILE, String(child.pid), "utf8");
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
  ws.onmessage = () => {
    try {
      ws.close();
    } catch {}
    finish(0);
  };
  ws.onerror = () => {
    finish(1);
  };
});
