"use strict";

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
const MAIN = "disableOfficialTelemetry";
const SYNC = "syncShellProfileTelemetryOptOut";
const BEGIN = "# >>> t3-hub official-telemetry-opt-out >>>";
const END = "# <<< t3-hub official-telemetry-opt-out <<<";
const JOIN = "# HUD added the preceding line break";
const PRODUCT_EXPORT = `export T3CODE_TELEMETRY_ENABLED=${OPT_OUT_ENV.T3CODE_TELEMETRY_ENABLED}`;
const LEGACY_EXPORTS = Object.entries(OPT_OUT_ENV).map(([name, value]) => `export ${name}=${value}`);
const POLICY_PATH = "/Library/Application Support/T3Code/policy.json";
const LAUNCH_FILE = "official-telemetry-launch.json";

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

function recordTelemetryLaunch(runDir, pid, started, launch, observed) {
  if (!started || observed?.pid !== pid || typeof observed.productOff !== "boolean" || typeof observed.otelOff !== "boolean") return;
  const { productOff, otelOff } = observed;
  const receipt = { pid, started, injected: launch.injected, observed: true, productOff, otelOff };
  writeTextAtomic(path.join(runDir, LAUNCH_FILE), JSON.stringify(receipt) + "\n");
}

function readLaunchReceipt(runDir) {
  try { return JSON.parse(readTextFileStrict(path.join(runDir, LAUNCH_FILE)).content); }
  catch { return null; }
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

module.exports = { buildTelemetryLaunch, optOutFlags, processStart, recordTelemetryLaunch, verifyLegacyTelemetryLaunch, createTelemetryGuard };
