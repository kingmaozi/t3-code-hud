"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { backupOnce, readTextFileStrict, writeTextAtomic } = require("./hub-host-settings.cjs");
const { hudPluginDir, readHudConfig, updateHudConfig } = require("./hud-config.cjs");

const OPT_OUT_ENV = Object.freeze({
  T3CODE_TELEMETRY_ENABLED: "false",
  T3CODE_OTEL_SDK_DISABLED: "true",
  OTEL_SDK_DISABLED: "true",
});
const PROCESS_ENV_ALLOWLIST = Object.freeze([
  "T3CODE_TELEMETRY_ENABLED",
  "T3CODE_OTEL_SDK_DISABLED",
  "OTEL_SDK_DISABLED",
  "T3CODE_HOME",
]);
const MAIN = "disableOfficialTelemetry";
const SYNC = "syncShellProfileTelemetryOptOut";
const BEGIN = "# >>> t3-hub official-telemetry-opt-out >>>";
const END = "# <<< t3-hub official-telemetry-opt-out <<<";
const JOIN = "# HUD added the preceding line break";
const PRODUCT_EXPORT = `export T3CODE_TELEMETRY_ENABLED=${OPT_OUT_ENV.T3CODE_TELEMETRY_ENABLED}`;
const LEGACY_EXPORTS = Object.entries(OPT_OUT_ENV).map(([name, value]) => `export ${name}=${value}`);
const POLICY_PATH = "/Library/Application Support/T3Code/policy.json";
const LAUNCH_FILE = "official-telemetry-launch.json";
const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;

function readRegularNoFollow(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | O_NOFOLLOW);
    if (!fs.fstatSync(fd).isFile()) return null;
    return fs.readFileSync(fd, "utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function writePrivateAtomicNoFollow(filePath, content) {
  const dir = path.dirname(filePath);
  let dirStat = null;
  try { dirStat = fs.lstatSync(dir); } catch {}
  if (dirStat && (dirStat.isSymbolicLink() || !dirStat.isDirectory())) {
    throw new Error("Refusing unsafe run directory");
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
  let targetStat = null;
  try { targetStat = fs.lstatSync(filePath); } catch {}
  if (targetStat && (targetStat.isSymbolicLink() || !targetStat.isFile())) {
    throw new Error("Refusing symlink or non-regular target file");
  }
  const temp = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temp, content, { flag: "wx", mode: 0o600 });
    try { fs.chmodSync(temp, 0o600); } catch {}
    fs.renameSync(temp, filePath);
  } finally {
    try { fs.unlinkSync(temp); } catch {}
  }
}

function settings(config) {
  const enabled = config[MAIN] !== false;
  return { [MAIN]: enabled, [SYNC]: enabled };
}

function startupConfig(pluginDir) {
  // Leave invalid config untouched. Fall back to the private launch default.
  try { return settings(readHudConfig(path.join(pluginDir, "config.json"))); }
  catch { return settings({}); }
}

function buildTelemetryLaunch(env, pluginDir) {
  const injected = startupConfig(pluginDir)[MAIN];
  return { env: injected ? { ...env, ...OPT_OUT_ENV } : env, injected };
}

function processStart(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    return execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, timeout: 1000, stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch { return null; }
}

function optOutFlags(env) {
  const normalized = (name) => String(env[name] ?? "").trim().toLowerCase();
  const t3Otel = normalized("T3CODE_OTEL_SDK_DISABLED");
  const otelOff = ["true", "yes", "on", "1", "y"].includes(t3Otel) ||
    (!["false", "no", "off", "0", "n"].includes(t3Otel) && normalized("OTEL_SDK_DISABLED") === "true");
  return { productOff: normalized("T3CODE_TELEMETRY_ENABLED") === "false", otelOff };
}

/**
 * Parse a macOS KERN_PROCARGS2 binary buffer strictly separating execPath,
 * argc argv entries, and NUL-delimited envp entries. Returns null on any
 * truncation, invalid argc, or absence of real envp KEY=VALUE entries.
 */
function parseKernProcargs2Buffer(raw, allowlist = PROCESS_ENV_ALLOWLIST) {
  if (!Buffer.isBuffer(raw) || raw.length < 6) return null;
  const argc = raw.readInt32LE(0);
  if (!Number.isInteger(argc) || argc < 1 || argc > 65536) return null;

  const endExec = raw.indexOf(0, 4);
  if (endExec <= 4) return null;
  const execPath = raw.subarray(4, endExec).toString("utf8");
  // XNU aligns the executable path (including NUL) to the target's
  // pointer size. Supported macOS T3 processes are 64-bit. A zero byte at
  // the first aligned offset is argv[0], not extra padding.
  let pos = 4 + Math.ceil((endExec - 4 + 1) / 8) * 8;
  if (pos >= raw.length || raw.subarray(endExec + 1, pos).some((byte) => byte !== 0)) return null;

  // Consume exactly argc NUL-terminated argv strings (never inspect argv as env)
  for (let i = 0; i < argc; i++) {
    const nxt = raw.indexOf(0, pos);
    if (nxt < 0) return null;
    pos = nxt + 1;
  }

  const allow = new Set(allowlist);
  const env = Object.create(null);
  let envCount = 0;
  while (pos < raw.length) {
    if (raw[pos] === 0) {
      // Padding or zeroed applev data marks the end of the envp strings.
      break;
    }
    const nxt = raw.indexOf(0, pos);
    if (nxt < 0) return null; // Truncated env entry
    const entry = raw.subarray(pos, nxt).toString("utf8");
    pos = nxt + 1;
    const eq = entry.indexOf("=");
    if (eq > 0) {
      const key = entry.slice(0, eq);
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        envCount++;
        if (allow.has(key)) {
          env[key] = entry.slice(eq + 1);
        }
      }
    }
  }
  if (pos >= raw.length || envCount === 0) return null;
  return { execPath, env, envCount };
}

function parseNulEnvironBuffer(raw, allowlist = PROCESS_ENV_ALLOWLIST) {
  if (!Buffer.isBuffer(raw) || raw.length === 0) return null;
  // Require trailing NUL to guard against partial/truncated read
  if (raw[raw.length - 1] !== 0) return null;
  const allow = new Set(allowlist);
  const env = Object.create(null);
  let envCount = 0;
  let pos = 0;
  while (pos < raw.length) {
    const nxt = raw.indexOf(0, pos);
    if (nxt < 0) return null;
    if (nxt === pos) {
      pos = nxt + 1;
      continue;
    }
    const entry = raw.subarray(pos, nxt).toString("utf8");
    pos = nxt + 1;
    const eq = entry.indexOf("=");
    if (eq > 0) {
      const key = entry.slice(0, eq);
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        envCount++;
        if (allow.has(key)) {
          env[key] = entry.slice(eq + 1);
        }
      }
    }
  }
  if (envCount === 0) return null;
  return { execPath: null, env, envCount };
}

const MACOS_PROCARGS2_PY = `
import ctypes, json, re, struct, sys

pid = int(sys.argv[1])
allow = set(sys.argv[2:])
libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
mib = (ctypes.c_int * 3)(1, 49, pid)
size = ctypes.c_size_t(0)
if libc.sysctl(mib, 3, None, ctypes.byref(size), None, 0) != 0 or size.value < 6:
    sys.exit(2)

buf_len = size.value + 65536
raw = None
for _ in range(3):
    buf = ctypes.create_string_buffer(buf_len)
    sz = ctypes.c_size_t(buf_len)
    if libc.sysctl(mib, 3, buf, ctypes.byref(sz), None, 0) == 0:
        if sz.value < buf_len:
            raw = buf.raw[:sz.value]
            break
    buf_len *= 2
if raw is None or len(raw) < 6:
    sys.exit(3)

argc = struct.unpack("<i", raw[:4])[0]
if argc < 1 or argc > 65536:
    sys.exit(4)
end_exec = raw.find(b"\\x00", 4)
if end_exec <= 4:
    sys.exit(5)
exec_path = raw[4:end_exec].decode("utf-8", "replace")
pos = 4 + ((end_exec - 4 + 8) // 8) * 8
if pos >= len(raw) or any(raw[end_exec + 1:pos]):
    sys.exit(6)

for _ in range(argc):
    nxt = raw.find(b"\\x00", pos)
    if nxt < 0:
        sys.exit(7)
    pos = nxt + 1

env = {}
env_count = 0
while pos < len(raw):
    if raw[pos] == 0:
        break
    nxt = raw.find(b"\\x00", pos)
    if nxt < 0:
        sys.exit(8)
    item = raw[pos:nxt].decode("utf-8", "replace")
    pos = nxt + 1
    if "=" in item:
        k, v = item.split("=", 1)
        if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", k):
            env_count += 1
            if k in allow:
                env[k] = v

if pos >= len(raw) or env_count == 0:
    sys.exit(9)
sys.stdout.write(json.dumps({"execPath": exec_path, "env": env, "envCount": env_count}))
`;

function resolvePython3() {
  for (const cand of ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"]) {
    try {
      const st = fs.statSync(cand);
      if (st.isFile()) {
        fs.accessSync(cand, fs.constants.X_OK);
        return cand;
      }
    } catch {}
  }
  return "python3";
}

function pathsMatch(observedExec, expectedExec) {
  if (!expectedExec) return true;
  if (!observedExec) return false;
  if (observedExec === expectedExec) return true;
  try {
    return fs.realpathSync(observedExec) === fs.realpathSync(expectedExec);
  } catch {
    return false;
  }
}

function readProcessEnv(pid, options = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const allowlist = Array.isArray(options.allowlist) ? options.allowlist : PROCESS_ENV_ALLOWLIST;
  const getStart = typeof options.processStartImpl === "function" ? options.processStartImpl : processStart;
  const expectedExecPath = options.expectedExecPath || null;

  const startBefore = getStart(pid);
  if (!startBefore) return null;

  let parsed = null;
  try {
    if (options.rawProcargs2 !== undefined) {
      parsed = parseKernProcargs2Buffer(options.rawProcargs2, allowlist);
    } else if (options.rawEnviron !== undefined) {
      parsed = parseNulEnvironBuffer(options.rawEnviron, allowlist);
    } else if (typeof options.probeImpl === "function") {
      parsed = options.probeImpl(pid, allowlist);
    } else if (process.platform === "darwin") {
      const py = resolvePython3();
      const out = execFileSync(py, ["-c", MACOS_PROCARGS2_PY, String(pid), ...allowlist], {
        encoding: "utf8",
        timeout: 1500,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const data = JSON.parse(out);
      if (data && typeof data === "object" && data.env && typeof data.env === "object" && Number(data.envCount) > 0) {
        parsed = { execPath: data.execPath || null, env: data.env, envCount: Number(data.envCount) };
      }
    } else if (process.platform === "linux") {
      const raw = fs.readFileSync(`/proc/${pid}/environ`);
      parsed = parseNulEnvironBuffer(raw, allowlist);
      if (parsed) {
        try { parsed.execPath = fs.readlinkSync(`/proc/${pid}/exe`); } catch {}
      }
    }
  } catch {
    return null;
  }

  if (!parsed || !parsed.env || !(parsed.envCount > 0)) return null;
  const startAfter = getStart(pid);
  if (!startAfter || startAfter !== startBefore) return null;
  if (!pathsMatch(parsed.execPath, expectedExecPath)) return null;

  const filtered = Object.create(null);
  const allow = new Set(allowlist);
  for (const [k, v] of Object.entries(parsed.env)) {
    if (allow.has(k) && typeof v === "string") {
      filtered[k] = v;
    }
  }
  return {
    pid,
    started: startBefore,
    execPath: parsed.execPath || null,
    env: filtered,
  };
}

function observeProcessTelemetry(pid, options = {}) {
  const info = readProcessEnv(pid, options);
  if (!info) return null;
  return { pid, ...optOutFlags(info.env) };
}

function recordTelemetryLaunch(runDir, pid, started, launch, observed) {
  if (!started || observed?.pid !== pid || typeof observed.productOff !== "boolean" || typeof observed.otelOff !== "boolean") return;
  const { productOff, otelOff } = observed;
  const receipt = { pid, started, injected: launch.injected, observed: true, productOff, otelOff };
  writePrivateAtomicNoFollow(path.join(runDir, LAUNCH_FILE), JSON.stringify(receipt) + "\n");
}

function readLaunchReceipt(runDir) {
  try {
    const content = readRegularNoFollow(path.join(runDir, LAUNCH_FILE));
    return content ? JSON.parse(content) : null;
  } catch { return null; }
}

// Only Electron main can upgrade an older receipt with its own live environment.
function verifyLegacyTelemetryLaunch(runDir, pid, env) {
  const receipt = readLaunchReceipt(runDir);
  if (receipt?.pid !== pid || receipt.observed === true || typeof receipt.injected !== "boolean") return;
  const started = processStart(pid);
  if (started && receipt.started === started) {
    recordTelemetryLaunch(runDir, pid, started, receipt, { pid, ...optOutFlags(env) });
  }
}

function runtimeStatus(runDir, pid, desired, configured) {
  if (!pid) return { state: "not-running", restartRequired: false };
  const started = processStart(pid);
  const receipt = readLaunchReceipt(runDir);
  if (!started || receipt?.pid !== pid || receipt.started !== started || receipt.observed !== true ||
      [receipt.injected, receipt.productOff, receipt.otelOff].some((value) => typeof value !== "boolean")) {
    return { state: "unverified", restartRequired: desired || configured };
  }
  const { injected, productOff, otelOff } = receipt;
  const state = productOff && otelOff ? "applied" : productOff || otelOff ? "partial" : "not-enabled";
  return { state, injected, productOff, otelOff, restartRequired: injected !== desired || (desired && state !== "applied") };
}

function profileBlock(join, exports = [PRODUCT_EXPORT]) {
  return [BEGIN, ...(join ? [JOIN] : []), ...exports, END].join("\n") + "\n";
}

function readProfile(file) {
  const { content, missing } = readTextFileStrict(file, { requireUtf8: true });
  const starts = [...content.matchAll(new RegExp(`^${BEGIN}\\r?$`, "gm"))];
  const ends = [...content.matchAll(new RegExp(`^${END}\\r?$`, "gm"))];
  let before = content, after = "";
  let managed = null;
  if (starts.length || ends.length) {
    const start = starts[0]?.index;
    const end = ends[0]?.index;
    if (starts.length !== 1 || ends.length !== 1 || end <= start) throw new Error("Invalid telemetry profile markers");
    const endOfBlock = end + ends[0][0].length + Number(content[end + ends[0][0].length] === "\n");
    const block = content.slice(start, endOfBlock);
    const joined = block.startsWith(`${BEGIN}\n${JOIN}\n`);
    const current = block === profileBlock(joined);
    if (!current && block !== profileBlock(joined, LEGACY_EXPORTS)) throw new Error("Unexpected content in telemetry profile block");
    before = content.slice(0, start);
    after = content.slice(endOfBlock);
    if (joined && !after && before.endsWith("\n")) before = before.slice(0, -1);
    managed = { start, endOfBlock, joined, current };
  }
  const unmanaged = before + after;
  const manual = /^[ \t]*export[ \t]+T3CODE_TELEMETRY_ENABLED=(?:false|"false"|'false')(?:[ \t]+#.*)?[ \t]*\r?$/m.test(unmanaged);
  return { content, missing, unmanaged, managed, manual };
}

function syncProfile(file, enable) {
  const profile = readProfile(file);
  const { content, managed } = profile;
  if (enable ? managed?.current : !managed) return;
  let next = profile.unmanaged;
  if (enable && managed) {
    next = content.slice(0, managed.start) + profileBlock(managed.joined) + content.slice(managed.endOfBlock);
  } else if (enable) {
    const join = Boolean(content && !content.endsWith("\n"));
    next = content + (join ? "\n" : "") + profileBlock(join);
  }
  backupOnce(file);
  if (readProfile(file).content !== profile.content) throw new Error("Shell profile changed while saving; try again");
  writeTextAtomic(file, next);
  return () => {
    if (readProfile(file).content !== next) throw new Error("Shell profile changed during rollback");
    if (profile.missing) fs.unlinkSync(file);
    else writeTextAtomic(file, profile.content);
  };
}

function readPolicy(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return "unreadable";
    const policy = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!policy || typeof policy !== "object" || Array.isArray(policy)) return "invalid";
    if (policy.limits !== undefined && (!policy.limits || typeof policy.limits !== "object" || Array.isArray(policy.limits))) return "invalid";
    const value = policy.limits?.telemetry;
    if (value !== undefined && typeof value !== "boolean") return "invalid";
    return value === false ? "locked-off" : "not-enforced";
  } catch (error) {
    if (error.code === "ENOENT") return "missing";
    return error instanceof SyntaxError ? "invalid" : "unreadable";
  }
}

function resolveZshProfilePath(homeDir, env) {
  const inheritHostZdotdir = env !== undefined || homeDir === os.homedir();
  const baseEnv = env || process.env;
  const fallbackDir = inheritHostZdotdir && baseEnv.ZDOTDIR ? String(baseEnv.ZDOTDIR).trim() : "";
  let zdotdir = fallbackDir;
  const hasStartupFile = fs.existsSync(path.join(homeDir, ".zshenv")) || fs.existsSync(path.join(homeDir, ".zprofile"));
  if ((hasStartupFile || fallbackDir) && fs.existsSync("/bin/zsh")) {
    const probeEnv = { ...baseEnv, HOME: homeDir };
    if (!inheritHostZdotdir) delete probeEnv.ZDOTDIR;
    if (!probeEnv.PATH) probeEnv.PATH = "/usr/bin:/bin";
    const probeScript = [
      "setopt rcs",
      '[[ -r "${ZDOTDIR:-$HOME}/.zshenv" ]] && source "${ZDOTDIR:-$HOME}/.zshenv"',
      '[[ -r /etc/zprofile ]] && source /etc/zprofile',
      '[[ -r "${ZDOTDIR:-$HOME}/.zprofile" ]] && source "${ZDOTDIR:-$HOME}/.zprofile"',
      'printf "\\n__T3_ZDOTDIR__=%s\\n" "${ZDOTDIR:-}"',
    ].join("\n");
    try {
      const out = execFileSync("/bin/zsh", ["-i", "-l", "-f", "-c", probeScript], {
        encoding: "utf8", env: probeEnv, timeout: 1000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "ignore"],
      });
      const marker = out.lastIndexOf("__T3_ZDOTDIR__=");
      if (marker !== -1) {
        zdotdir = out.slice(marker + "__T3_ZDOTDIR__=".length).split(/\r?\n/, 1)[0].trim();
      }
    } catch {}
  }
  const targetDir = zdotdir ? (path.isAbsolute(zdotdir) ? zdotdir : path.resolve(homeDir, zdotdir)) : homeDir;
  return path.join(targetDir, ".zshrc");
}

function createTelemetryGuard({
  homeDir = os.homedir(), pluginDir = hudPluginDir(), policyPath = POLICY_PATH, pid = null, env,
} = {}) {
  const configFile = path.join(pluginDir, "config.json");
  const profileFile = resolveZshProfilePath(homeDir, env);
  const runDir = path.join(pluginDir, "run");
  function status() {
    let saved = {}, configurationError = false;
    try { saved = readHudConfig(configFile); }
    catch { configurationError = true; }
    const config = settings(saved);
    let profile = "unreadable";
    try {
      const info = readProfile(profileFile);
      profile = info.managed ? "managed" : info.manual ? "manual" : "unconfigured";
    } catch {}
    return {
      ok: true, config, configurationError, profile, policy: readPolicy(policyPath),
      runtime: runtimeStatus(runDir, pid, config[MAIN], typeof saved[MAIN] === "boolean"),
    };
  }
  function update(patch) {
    if (Object.keys(patch || {}).length !== 1 || typeof patch?.[MAIN] !== "boolean") {
      throw new Error("Invalid telemetry settings");
    }
    const enabled = patch[MAIN];
    updateHudConfig(configFile, (current) => ({ ...current, [MAIN]: enabled, [SYNC]: enabled }),
      () => syncProfile(profileFile, enabled));
    return status();
  }
  function reconcileProfile() {
    updateHudConfig(configFile, (current) => current, (current) => syncProfile(profileFile, settings(current)[MAIN]));
  }
  return { status, update, reconcileProfile };
}

function cli() {
  const [action, pidArg] = process.argv.slice(2);
  if (!["status", "off", "on"].includes(action)) throw new Error("Usage: t3-hud telemetry status|off|on");
  const guard = createTelemetryGuard({ pid: Number(pidArg) || null });
  const result = action === "status" ? guard.status() : guard.update({ [MAIN]: action === "off" });
  console.log(`HUD launch opt-out: ${result.config[MAIN] ? "on" : "off"}${result.configurationError ? " (using fallback; config unreadable)" : ""}`);
  const { state, injected } = result.runtime;
  const launch = state === "applied" ? `opt-out flags verified in the desktop process${injected ? "" : " (inherited)"}` : state;
  console.log(`Running T3: ${launch}`);
  console.log(`~/.zshrc: ${result.profile}`);
  console.log(`Managed Policy file: ${result.policy}`);
  if (result.runtime.restartRequired || (action !== "status" && result.runtime.state === "unverified")) {
    console.log("Restart T3 through t3-hud when your work can be interrupted to apply the launch setting.");
  }
}

if (require.main === module) {
  try { cli(); } catch (error) {
    console.error("[t3-hud] " + error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  PROCESS_ENV_ALLOWLIST,
  buildTelemetryLaunch,
  optOutFlags,
  parseKernProcargs2Buffer,
  parseNulEnvironBuffer,
  readProcessEnv,
  observeProcessTelemetry,
  processStart,
  recordTelemetryLaunch,
  verifyLegacyTelemetryLaunch,
  createTelemetryGuard,
};
