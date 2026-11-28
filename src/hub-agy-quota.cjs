"use strict";

/**
 * Read-Only Antigravity (AGY) Quota Reader via T3-Managed Official CLI.
 *
 * Invokes ONLY a verified T3-managed `agy`/`antigravity` binary with:
 *   -p /usage --output-format json --print-timeout 20s --log-file /dev/null
 * under a hard 10-minute (600s) low-frequency TTL cache / backoff, single-flight
 * deduplication, non-blocking RPC wait budget, and 4-layer safety guards:
 *   1. Strict version gate: <bin> --version must match official CLI version >= 1.1.11
 *      and binary canonical identity is re-verified immediately before /usage
 *   2. Persistent model-turn latch-off: streaming/final num_turns > 0 or non-empty
 *      conversation_id immediately kills child and persists latch across hot reloads
 *      (globalThis.__t3HubAgyQuotaLatch) and restarts (0600 run/agy-quota-latch.json)
 *   3. Interactive sign-in kill switch: live stderr/stdout monitoring kills child
 *      immediately on auth-required / signed-out output with hard 10m backoff
 *   4. Minimal allowlist non-interactive environment: closed stdin, minimal system
 *      env allowlist only, verified non-symlink profileDir as GEMINI_HOME,
 *      AGY_CLI_DISABLE_AUTO_UPDATE=true, NO_BROWSER=1, non-interactive BROWSER
 *
 * Never calls internal Google HTTP APIs, never reads OAuth tokens or Keychain,
 * and never modifies AGY auth, endpoints, binaries, or configuration.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const MIN_USAGE_CLI_VERSION = "1.1.11";
const DEFAULT_CACHE_TTL_MS = 600_000;
const DEFAULT_ERROR_BACKOFF_MS = 300_000;
const DEFAULT_SIGNED_OUT_BACKOFF_MS = 600_000;
const DEFAULT_RPC_WAIT_MS = 3_500;
const DEFAULT_VERSION_TIMEOUT_MS = 5_000;
const DEFAULT_PROBE_TIMEOUT_MS = 25_000;
const DEFAULT_SIGKILL_GRACE_MS = 1_000;
const DEFAULT_HARD_KILL_DEADLINE_MS = 1_000;
const DEFAULT_CONFIG_POLL_MS = 50;
const MAX_OUTPUT_BYTES = 512 * 1024;
const MAX_VERSION_OUTPUT_BYTES = 64 * 1024;
const MIN_VALID_RESET_MS = Date.UTC(2000, 0, 1);
const MAX_VALID_RESET_MS = 8.64e15;

const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const RELEASE_ID_RE = /^[0-9a-f]{64}$/;
const SKIPPED_AUTH_METHODS = new Set(["gemini-api-key", "agent-platform"]);
const DIRECT_USERDATA_MARKERS = ["environment-id", "settings.json", "statev2.sqlite"];

const POSIX_ENV_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
]);

const WIN32_ENV_ALLOWLIST = new Set([
  ...POSIX_ENV_ALLOWLIST,
  "SYSTEMROOT",
  "COMSPEC",
  "WINDIR",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "PATHEXT",
  "TEMP",
  "TMP",
]);

const GLOBAL_LATCH_PROP = "__t3HubAgyQuotaLatch";
const GLOBAL_LOCK_PROP = "__t3HubAgyQuotaProbeQueues";

function getGlobalLatchSet() {
  if (!(globalThis[GLOBAL_LATCH_PROP] instanceof Set)) {
    globalThis[GLOBAL_LATCH_PROP] = new Set();
  }
  return globalThis[GLOBAL_LATCH_PROP];
}

function getGlobalProbeQueues() {
  if (!(globalThis[GLOBAL_LOCK_PROP] instanceof Map)) {
    globalThis[GLOBAL_LOCK_PROP] = new Map();
  }
  return globalThis[GLOBAL_LOCK_PROP];
}

function withProbeQueue(runPath, fn) {
  const locks = getGlobalProbeQueues();
  const prev = locks.get(runPath) || Promise.resolve();
  let release;
  const next = new Promise((resolve) => {
    release = resolve;
  });
  const chained = prev.catch(() => {}).then(() => next);
  locks.set(runPath, chained);

  return prev.catch(() => {}).then(async () => {
    try {
      return await fn();
    } finally {
      release();
      if (locks.get(runPath) === chained) {
        locks.delete(runPath);
      }
    }
  });
}

function isWithinPath(rootPath, candidatePath) {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  if (candidate === root) return true;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return candidate.startsWith(prefix);
}

// macOS supplies these system aliases. No user-configured root is dereferenced.
function normalizeSystemPath(value) {
  const absolute = path.resolve(value);
  if (process.platform !== "darwin") return absolute;
  const alias = absolute.match(/^\/(?:tmp|var|etc)(?=\/|$)/)?.[0];
  if (alias && fs.realpathSync(alias) === "/private" + alias) return "/private" + absolute;
  return absolute;
}

function assertNoSymlinkSegments(anchorDir, targetPath, { expectFinalType = null, allowMissingFinal = false } = {}) {
  if (typeof anchorDir !== "string" || !anchorDir.trim() || typeof targetPath !== "string" || !targetPath.trim()) {
    return { ok: false, missing: false, reason: "invalid_path" };
  }
  try {
    const anchor = normalizeSystemPath(anchorDir);
    const target = normalizeSystemPath(targetPath);
    if (!isWithinPath(anchor, target)) return { ok: false, missing: false, reason: "outside_root" };

    const root = path.parse(target).root;
    const segments = target.slice(root.length).split(path.sep).filter(Boolean);
    let current = root;
    let stat = fs.lstatSync(root);
    for (const segment of segments) {
      current = path.join(current, segment);
      stat = fs.lstatSync(current, { throwIfNoEntry: false });
      if (!stat) {
        if (current === target && allowMissingFinal) return { ok: true, missing: true, resolvedPath: target };
        return { ok: false, missing: true, reason: "missing" };
      }
      if (stat.isSymbolicLink()) return { ok: false, missing: false, reason: "symlink" };
      if ((current !== target || expectFinalType === "dir") && !stat.isDirectory()) {
        return { ok: false, missing: false, reason: "not_dir" };
      }
    }

    if (expectFinalType === "file" && !stat.isFile()) return { ok: false, missing: false, reason: "not_file" };
    const realPath = fs.realpathSync(target);
    if (!isWithinPath(anchor, realPath)) return { ok: false, missing: false, reason: "realpath_escape" };
    return { ok: true, missing: false, stat, resolvedPath: target, realPath };
  } catch {
    return { ok: false, missing: false, reason: "stat_failed" };
  }
}

function readRegularFileSafe(anchorDir, filePath, maxBytes = 256 * 1024) {
  const check = assertNoSymlinkSegments(anchorDir, filePath, {
    expectFinalType: "file",
    allowMissingFinal: true,
  });
  if (!check.ok) {
    return { ok: false, missing: check.missing === true, reason: check.reason, text: null, stat: null };
  }
  if (check.missing) {
    return { ok: true, missing: true, reason: null, text: null, stat: null };
  }
  if (check.stat.size > maxBytes) {
    return { ok: false, missing: false, reason: "too_large", text: null, stat: check.stat };
  }

  let fd = null;
  try {
    fd = fs.openSync(check.resolvedPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | O_NOFOLLOW);
    const fstat = fs.fstatSync(fd);
    const current = assertNoSymlinkSegments(anchorDir, filePath, { expectFinalType: "file" });
    if (!fstat.isFile() || !current.ok ||
        ![check.stat, current.stat].every(stat => stat.dev === fstat.dev && stat.ino === fstat.ino)) {
      return { ok: false, missing: false, reason: "file_changed", text: null, stat: fstat };
    }
    if (fstat.size > maxBytes) {
      return { ok: false, missing: false, reason: "too_large", text: null, stat: fstat };
    }
    const bytes = Buffer.alloc(fstat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = fs.readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size !== fstat.size) return { ok: false, missing: false, reason: "file_changed", text: null, stat: fstat };
    const text = bytes.toString("utf8", 0, size);
    return { ok: true, missing: false, reason: null, text, stat: fstat };
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { ok: true, missing: true, reason: null, text: null, stat: null };
    }
    return { ok: false, missing: false, reason: "read_failed", text: null, stat: null };
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function resolveT3Paths({ homeDir = os.homedir(), t3CodeHome } = {}) {
  const resolvedHome = path.resolve(homeDir);
  let rawCustom = "";
  if (typeof t3CodeHome === "string") {
    rawCustom = t3CodeHome.trim();
  } else if (t3CodeHome === undefined && resolvedHome === path.resolve(os.homedir()) && process.env.T3CODE_HOME) {
    rawCustom = String(process.env.T3CODE_HOME).trim();
  }

  if (!rawCustom) {
    const baseDir = path.join(resolvedHome, ".t3");
    return {
      homeDir: resolvedHome,
      baseDir,
      userDataDir: path.join(baseDir, "userdata"),
      toolsDir: path.join(baseDir, "tools"),
      isCustom: false,
      isDirectDataDir: false,
    };
  }

  const baseDir = path.resolve(rawCustom);
  const stdUserdata = path.join(baseDir, "userdata");
  let hasStdUserdata = false;
  try {
    fs.lstatSync(stdUserdata);
    hasStdUserdata = true;
  } catch {}

  let hasDirectMarker = false;
  if (!hasStdUserdata) {
    for (const marker of DIRECT_USERDATA_MARKERS) {
      try {
        fs.lstatSync(path.join(baseDir, marker));
        hasDirectMarker = true;
        break;
      } catch {}
    }
  }

  return {
    homeDir: resolvedHome,
    baseDir,
    userDataDir: hasDirectMarker ? baseDir : stdUserdata,
    toolsDir: path.join(baseDir, "tools"),
    isCustom: true,
    isDirectDataDir: hasDirectMarker,
  };
}

function readT3EnvironmentId({ baseDir, userDataDir }) {
  const file = readRegularFileSafe(baseDir, path.join(userDataDir, "environment-id"), 128);
  const id = file.ok ? file.text?.trim() : "";
  return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id || "") ? id : "";
}

function resolvePluginDir({ homeDir = os.homedir(), pluginDir } = {}) {
  if (typeof pluginDir === "string" && pluginDir.trim()) {
    return path.resolve(pluginDir);
  }
  const resolvedHome = path.resolve(homeDir);
  if (resolvedHome === path.resolve(os.homedir()) && process.env.T3_HUD_DIR) {
    return path.resolve(process.env.T3_HUD_DIR);
  }
  return path.join(resolvedHome, ".t3", "hud-plugin");
}

function pickAnchorDir(preferredRoot, targetPath) {
  if (preferredRoot && isWithinPath(preferredRoot, targetPath)) {
    return path.resolve(preferredRoot);
  }
  return path.resolve(targetPath);
}

/**
 * Fail-closed config.json kill-switch check.
 * Allows probing ONLY when config.json genuinely does not exist (ENOENT)
 * or is a valid non-symlink JSON object with agyCliQuotaEnabled !== false.
 */
function checkAgyCliQuotaEnabled(pluginDir, anchorDir = null) {
  const resolvedPlugin = path.resolve(pluginDir);
  const anchor = anchorDir && isWithinPath(anchorDir, resolvedPlugin) ? path.resolve(anchorDir) : resolvedPlugin;

  // Check pluginDir path itself (if pluginDir doesn't exist yet at all -> default enabled; if symlink -> fail closed)
  const dirCheck = assertNoSymlinkSegments(anchor, resolvedPlugin, {
    expectFinalType: "dir",
    allowMissingFinal: true,
  });
  if (!dirCheck.ok) {
    if (dirCheck.missing) return { enabled: true, reason: null };
    return { enabled: false, reason: "config_unsafe" };
  }
  if (dirCheck.missing) {
    return { enabled: true, reason: null };
  }

  const configPath = path.join(resolvedPlugin, "config.json");
  const file = readRegularFileSafe(anchor, configPath, 256 * 1024);
  if (!file.ok) {
    return { enabled: false, reason: "config_unsafe" };
  }
  if (file.missing) {
    return { enabled: true, reason: null };
  }

  let parsed;
  try {
    parsed = JSON.parse(file.text);
  } catch {
    return { enabled: false, reason: "config_invalid" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { enabled: false, reason: "config_invalid" };
  }
  if (parsed.agyCliQuotaEnabled === false) {
    return { enabled: false, reason: "disabled_by_config" };
  }
  if (parsed.agyCliQuotaEnabled !== undefined && typeof parsed.agyCliQuotaEnabled !== "boolean") {
    return { enabled: false, reason: "config_invalid" };
  }
  return { enabled: true, reason: null };
}

function parseSemver(input) {
  if (typeof input !== "string" || !input.trim()) return null;
  const match = input.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null;
  }
  const prerelease = match[4] ? match[4].split(".") : [];
  return { major, minor, patch, prerelease, raw: `${major}.${minor}.${patch}${match[4] ? `-${match[4]}` : ""}` };
}

const STRICT_CLI_VERSION_LINE_RE = /^(?:antigravity|agy)(?:\s+cli)?\s+v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+[0-9A-Za-z.-]+)?$/i;
const STRICT_BARE_VERSION_LINE_RE = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+[0-9A-Za-z.-]+)?$/;

function parseStrictCliVersionOutput(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) return null;
  const line = lines[0];
  const m = line.match(STRICT_CLI_VERSION_LINE_RE) || line.match(STRICT_BARE_VERSION_LINE_RE);
  if (!m) return null;
  return parseSemver(m[1]);
}

function compareSemver(a, b) {
  const pa = parseSemver(typeof a === "string" ? a.trim() : "");
  const pb = parseSemver(typeof b === "string" ? b.trim() : "");
  if (!pa || !pb) return null;
  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1;

  const aPre = pa.prerelease;
  const bPre = pb.prerelease;
  if (aPre.length === 0 && bPre.length === 0) return 0;
  if (aPre.length === 0) return 1;
  if (bPre.length === 0) return -1;

  const len = Math.max(aPre.length, bPre.length);
  for (let i = 0; i < len; i++) {
    if (i >= aPre.length) return -1;
    if (i >= bPre.length) return 1;
    const ai = aPre[i];
    const bi = bPre[i];
    if (ai === bi) continue;
    const aNum = /^\d+$/.test(ai);
    const bNum = /^\d+$/.test(bi);
    if (aNum && bNum) {
      const na = Number(ai);
      const nb = Number(bi);
      if (na !== nb) return na > nb ? 1 : -1;
    } else if (aNum) {
      return -1;
    } else if (bNum) {
      return 1;
    } else {
      return ai > bi ? 1 : -1;
    }
  }
  return 0;
}

function resolveAgyInstances({ homeDir = os.homedir(), t3CodeHome, userDataDir, baseDir } = {}) {
  const paths = resolveT3Paths({ homeDir, t3CodeHome });
  const ud = typeof userDataDir === "string" && userDataDir.trim() ? path.resolve(userDataDir) : paths.userDataDir;
  const anchor = pickAnchorDir(baseDir || paths.baseDir, ud);

  const file = readRegularFileSafe(anchor, path.join(ud, "settings.json"), 2 * 1024 * 1024);
  if (!file.ok || file.missing || !file.text) return [];

  let parsed;
  try {
    parsed = JSON.parse(file.text);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const rawMap =
    parsed.providerInstances && typeof parsed.providerInstances === "object" && !Array.isArray(parsed.providerInstances)
      ? parsed.providerInstances
      : parsed.providers && typeof parsed.providers === "object" && !Array.isArray(parsed.providers)
        ? parsed.providers
        : null;
  if (!rawMap) return [];

  const instances = [];
  for (const [instanceId, entry] of Object.entries(rawMap)) {
    if (!instanceId || !entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const driver = String(entry.driver || "").trim().toLowerCase();
    if (driver !== "antigravity") continue;
    if (entry.enabled === false) continue;

    const cfg = entry.config && typeof entry.config === "object" && !Array.isArray(entry.config) ? entry.config : {};
    const authMethod = String(entry.authMethod ?? cfg.authMethod ?? "").trim().toLowerCase();
    if (SKIPPED_AUTH_METHODS.has(authMethod)) continue;

    const key = crypto.createHash("sha256").update(instanceId, "utf8").digest("hex");
    const profileDir = path.join(ud, "providers", "antigravity", key);
    const rawBin =
      typeof cfg.binaryPath === "string" && cfg.binaryPath.trim()
        ? cfg.binaryPath.trim()
        : typeof entry.binaryPath === "string" && entry.binaryPath.trim()
          ? entry.binaryPath.trim()
          : "";
    const displayName =
      typeof entry.displayName === "string" && entry.displayName.trim()
        ? entry.displayName.trim().replace(/[\r\n\0]/g, " ").slice(0, 64)
        : "AGY";

    instances.push({
      instanceId,
      driver: "antigravity",
      displayName,
      authMethod: authMethod || null,
      binaryPath: rawBin || null,
      profileDir,
    });
  }
  return instances;
}

function computeBinaryIdentity(anchorDir, binPath, platform = process.platform) {
  const check = assertNoSymlinkSegments(anchorDir, binPath, {
    expectFinalType: "file",
    allowMissingFinal: false,
  });
  if (!check.ok || !check.stat || !check.realPath) return null;
  if (platform !== "win32") {
    try {
      fs.accessSync(check.resolvedPath, fs.constants.X_OK);
    } catch {
      return null;
    }
  }
  const st = check.stat;
  return {
    binPath: check.resolvedPath,
    realPath: check.realPath,
    canonicalKey: `${check.realPath}|${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`,
    dev: st.dev,
    ino: st.ino,
    size: st.size,
    mtimeMs: st.mtimeMs,
  };
}

/**
 * Resolves ONLY a verified T3-managed AGY binary under
 * ${toolsDir}/antigravity-acp/${platform}-${arch}/versions/${releaseId}/${execName}.
 * If instance config.binaryPath is set, it is allowed ONLY when it resolves
 * without symlinks to the exact same verified T3-managed binary.
 */
function resolveManagedAgyBinary({
  homeDir = os.homedir(),
  t3CodeHome,
  userDataDir,
  toolsDir,
  baseDir,
  platform = process.platform,
  arch = process.arch,
  binaryPath,
} = {}) {
  const paths = resolveT3Paths({ homeDir, t3CodeHome });
  let resolvedTools;
  if (typeof toolsDir === "string" && toolsDir.trim()) {
    resolvedTools = path.resolve(toolsDir);
  } else if (typeof userDataDir === "string" && userDataDir.trim()) {
    const ud = path.resolve(userDataDir);
    resolvedTools = path.basename(ud) === "userdata" ? path.join(path.dirname(ud), "tools") : path.join(ud, "tools");
  } else {
    resolvedTools = paths.toolsDir;
  }

  const toolsAnchor = pickAnchorDir(baseDir || paths.baseDir, resolvedTools);
  const archDir = path.join(resolvedTools, "antigravity-acp", `${platform}-${arch}`);

  const activeFile = readRegularFileSafe(toolsAnchor, path.join(archDir, "active.json"), 64 * 1024);
  if (!activeFile.ok || activeFile.missing || !activeFile.text) return null;

  let active;
  try {
    active = JSON.parse(activeFile.text);
  } catch {
    return null;
  }
  const releaseId = active?.releaseId;
  if (typeof releaseId !== "string" || !RELEASE_ID_RE.test(releaseId)) return null;

  const versionDir = path.join(archDir, "versions", releaseId);
  const versionDirCheck = assertNoSymlinkSegments(toolsAnchor, versionDir, {
    expectFinalType: "dir",
    allowMissingFinal: false,
  });
  if (!versionDirCheck.ok || !versionDirCheck.realPath) return null;

  const completeFile = readRegularFileSafe(toolsAnchor, path.join(versionDir, ".install-complete.json"), 64 * 1024);
  if (!completeFile.ok || completeFile.missing || !completeFile.text) return null;

  let record;
  try {
    record = JSON.parse(completeFile.text);
  } catch {
    return null;
  }
  if (!record || typeof record !== "object" || Array.isArray(record) || record.releaseId !== releaseId) return null;

  const execName = record?.executable?.name;
  if (
    typeof execName !== "string" ||
    !execName ||
    execName === "." ||
    execName === ".." ||
    execName.includes("/") ||
    execName.includes("\\") ||
    execName.includes("\0") ||
    path.basename(execName) !== execName
  ) {
    return null;
  }

  const candidate = path.join(versionDir, execName);
  const identity = computeBinaryIdentity(toolsAnchor, candidate, platform);
  if (!identity) return null;
  const recordedBytes = record.executable.bytes;
  if (Number.isInteger(recordedBytes) && recordedBytes > 0 && identity.size !== recordedBytes) return null;

  // Verify binary realpath is strictly inside versionDir realpath
  if (!isWithinPath(versionDirCheck.realPath, identity.realPath) || identity.realPath === versionDirCheck.realPath) {
    return null;
  }

  // If explicit config.binaryPath was configured, allow ONLY if it resolves cleanly
  // without symlinks to the exact same verified T3-managed binary.
  if (typeof binaryPath === "string" && binaryPath.trim()) {
    const trimmed = binaryPath.trim();
    if (!path.isAbsolute(trimmed)) return null;
    const explicitIdentity = computeBinaryIdentity(toolsAnchor, trimmed, platform);
    if (
      !explicitIdentity ||
      explicitIdentity.realPath !== identity.realPath ||
      explicitIdentity.dev !== identity.dev ||
      explicitIdentity.ino !== identity.ino
    ) {
      return null;
    }
  }

  const releaseVersion =
    typeof record.version === "string" && record.version.trim()
      ? record.version.trim()
      : typeof record.releaseVersion === "string" && record.releaseVersion.trim()
        ? record.releaseVersion.trim()
        : typeof record.executable?.version === "string" && record.executable.version.trim()
          ? record.executable.version.trim()
          : null;

  return {
    binPath: identity.binPath,
    realPath: identity.realPath,
    canonicalKey: identity.canonicalKey,
    recordKey: crypto.createHash("sha256").update(activeFile.text).update("\0").update(completeFile.text).digest("hex"),
    source: "managed",
    releaseId,
    releaseVersion,
  };
}

function buildUsageCliEnv(baseEnv = process.env, profileDir = null, {
  platform = process.platform,
  userDataAnchor = null,
  requireProfileDir = false,
} = {}) {
  const allowlist = platform === "win32" ? WIN32_ENV_ALLOWLIST : POSIX_ENV_ALLOWLIST;
  const out = {};
  if (baseEnv && typeof baseEnv === "object") {
    for (const [key, val] of Object.entries(baseEnv)) {
      if (typeof val !== "string") continue;
      if (allowlist.has(key.toUpperCase())) {
        out[key] = val;
      }
    }
  }

  if (profileDir) {
    const anchor = userDataAnchor && isWithinPath(userDataAnchor, profileDir) ? userDataAnchor : profileDir;
    const check = assertNoSymlinkSegments(anchor, profileDir, {
      expectFinalType: "dir",
      allowMissingFinal: false,
    });
    if (check.ok) {
      out.GEMINI_HOME = check.resolvedPath;
    } else if (requireProfileDir) {
      return null;
    }
  } else if (requireProfileDir) {
    return null;
  }

  out.AGY_CLI_DISABLE_AUTO_UPDATE = "true";
  out.NO_BROWSER = "1";
  out.BROWSER = platform === "win32" ? "" : "/usr/bin/false";
  return out;
}

function parseJsonObjectsFromText(text) {
  if (typeof text !== "string" || !text.trim()) return [];
  const objects = [];
  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || (line[0] !== "{" && line[0] !== "[")) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") objects.push(parsed);
    } catch {
      // Ignore non-JSON lines
    }
  }
  if (objects.length === 0) {
    const trimmed = text.trim();
    if (trimmed[0] === "{" || trimmed[0] === "[") {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object") objects.push(parsed);
      } catch {
        // Ignore malformed output
      }
    }
  }
  return objects;
}

function nodeIndicatesModelTurn(node) {
  if (!node || typeof node !== "object") return false;
  if (typeof node.num_turns === "number" && node.num_turns > 0) return true;
  if (typeof node.conversation_id === "string" && node.conversation_id.trim().length > 0) return true;
  return false;
}

function outputShowsModelTurn(stdoutText) {
  if (typeof stdoutText !== "string" || !stdoutText.trim()) return false;
  const objects = parseJsonObjectsFromText(stdoutText);
  for (const obj of objects) {
    if (nodeIndicatesModelTurn(obj)) return true;
    if (nodeIndicatesModelTurn(obj.stats)) return true;
    if (nodeIndicatesModelTurn(obj.result)) return true;
  }
  // A marker can be complete before the surrounding output is valid JSON.
  for (const [, value] of stdoutText.matchAll(/"num_turns"\s*:\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g)) {
    if (Number(value) > 0) return true;
  }
  for (const [, value] of stdoutText.matchAll(/"conversation_id"\s*:\s*("(?:[^"\\]|\\.)*")/g)) {
    try { if (JSON.parse(value).trim()) return true; } catch {}
  }
  return false;
}

const SIGNED_OUT_TEXT_PATTERNS = [
  /authentication\s+required\.\s*please\s+visit\s+the\s+url/i,
  /\bauthentication\s+required\b/i,
  /\bnot\s+logged\s+in\b/i,
  /\bnot\s+signed\s+in\b/i,
  /\bunauthenticated\b/i,
  /\brun\s+(?:agy|antigravity)\s+login\b/i,
  /\bno\s+credentials\b/i,
  /AGY_ERROR[^\r\n]*(?:status\s*[=:]\s*["']?UNAUTHENTICATED["']?|error_code\s*[=:]\s*["']?401["']?)/i,
];

function outputLooksSignedOut(text) {
  if (typeof text !== "string" || !text.trim()) return false;
  for (const re of SIGNED_OUT_TEXT_PATTERNS) {
    if (re.test(text)) return true;
  }
  const objects = parseJsonObjectsFromText(text);
  for (const obj of objects) {
    const status = String(obj.status || obj.error?.status || "").trim().toUpperCase();
    const errorCode = Number(obj.error_code ?? obj.errorCode ?? obj.error?.error_code ?? obj.error?.code);
    if (status === "UNAUTHENTICATED") return true;
    if (
      errorCode === 401 &&
      (obj.type === "AGY_ERROR" || obj.error === "AGY_ERROR" || status === "ERROR" || status === "FAILED" || text.includes("AGY_ERROR"))
    ) {
      return true;
    }
  }
  return false;
}

function parseResetTimestampMs(rawReset) {
  if (typeof rawReset === "number") {
    if (!Number.isFinite(rawReset) || rawReset <= 0) return null;
    return rawReset > 1e12 ? rawReset : rawReset * 1000;
  }
  if (typeof rawReset === "string" && rawReset.trim()) {
    const iso = rawReset.trim();
    const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/i.exec(iso);
    if (!parts) return null;
    const [year, month, day, hours, minutes, seconds] = parts.slice(1).map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day ||
        hours > 23 || minutes > 59 || seconds > 59) return null;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function normalizeResetTime(rawReset, { clampedRemaining, description, windowDurationMins, requestedAt }) {
  try {
    const parsedResetMs = parseResetTimestampMs(rawReset);
    if (
      parsedResetMs === null ||
      !Number.isFinite(parsedResetMs) ||
      parsedResetMs < MIN_VALID_RESET_MS ||
      parsedResetMs > MAX_VALID_RESET_MS
    ) {
      return null;
    }
    const isUntouchedRollingSentinel =
      clampedRemaining === 1 &&
      description === undefined &&
      windowDurationMins !== null &&
      Math.abs(parsedResetMs - requestedAt - windowDurationMins * 60_000) <= 60_000;
    if (isUntouchedRollingSentinel) return null;
    const date = new Date(parsedResetMs);
    if (!Number.isFinite(date.getTime())) return null;
    return date.toISOString();
  } catch {
    return null;
  }
}

function windowSortRank(win) {
  const idLow = String(win.id || "").toLowerCase();
  const is5h = win.kind === "session" || win.windowDurationMins === 300;
  const isWeekly = win.kind === "weekly" || win.windowDurationMins === 10080;
  const subRank = is5h ? 0 : isWeekly ? 1 : 2;

  if (idLow.startsWith("gemini-argon-") || idLow.startsWith("gemini-carbon-")) {
    return 20 + subRank;
  }
  if (idLow.startsWith("gemini-")) {
    return 10 + subRank;
  }
  if (idLow.startsWith("3p-")) {
    return 30 + subRank;
  }
  return 40 + subRank;
}

function parseAgyCliUsageWindows(stdoutText, { requestedAt = Date.now() } = {}) {
  const objects = parseJsonObjectsFromText(stdoutText);
  const usageObj = objects.find(
    (obj) =>
      obj &&
      obj.status === "SUCCESS" &&
      obj.command &&
      obj.command.name === "usage" &&
      Array.isArray(obj.command.data?.groups)
  );
  if (!usageObj) return null;

  const windows = [];
  for (const group of usageObj.command.data.groups) {
    if (!group || typeof group !== "object" || !Array.isArray(group.buckets)) continue;
    const rawGroupId = typeof group.id === "string" ? group.id.trim() : "";
    const rawGroupName = typeof group.name === "string" ? group.name.trim() : "";
    const groupIdLow = rawGroupId.toLowerCase();

    for (const bucket of group.buckets) {
      if (!bucket || typeof bucket !== "object" || bucket.disabled === true) continue;
      const rawRemaining = bucket.remaining_fraction;
      if (typeof rawRemaining !== "number" || !Number.isFinite(rawRemaining)) continue;

      const clampedRemaining = Math.min(1, Math.max(0, rawRemaining));
      const usedPercent = Math.round((1 - clampedRemaining) * 1000) / 10;

      const rawBucketId = typeof bucket.id === "string" ? bucket.id.trim() : "";
      const winType = String(bucket.window || "").trim().toLowerCase();
      const id =
        rawBucketId ||
        (rawGroupId && winType ? `${rawGroupId}-${winType}` : rawGroupId || winType || String(bucket.name || "quota"));
      const idLow = id.toLowerCase();

      let kind = "other";
      let windowDurationMins = null;
      let windowLabel = typeof bucket.name === "string" && bucket.name.trim() ? bucket.name.trim() : "Quota";
      if (winType === "5h") {
        kind = "session";
        windowDurationMins = 300;
        windowLabel = "5-hour";
      } else if (winType === "weekly") {
        kind = "weekly";
        windowDurationMins = 10080;
        windowLabel = "Weekly";
      }

      let family;
      if (idLow.startsWith("gemini-argon-") || groupIdLow === "gemini-argon") {
        family = rawGroupName || "Gemini Argon";
      } else if (idLow.startsWith("gemini-carbon-") || groupIdLow === "gemini-carbon") {
        family = rawGroupName || "Gemini Carbon";
      } else if (idLow.startsWith("gemini-") || groupIdLow === "gemini") {
        family = "Gemini";
      } else if (idLow.startsWith("3p-") || groupIdLow === "3p") {
        family = "Claude & GPT (shared)";
      } else {
        family = rawGroupName || id;
      }

      const label = `${family} · ${windowLabel}`;
      const resetsAt = normalizeResetTime(bucket.reset_time, {
        clampedRemaining,
        description: bucket.description,
        windowDurationMins,
        requestedAt,
      });

      windows.push({
        id,
        kind,
        label,
        usedPercent,
        ...(windowDurationMins !== null ? { windowDurationMins } : {}),
        ...(resetsAt !== null ? { resetsAt } : {}),
      });
    }
  }

  windows.sort((a, b) => windowSortRank(a) - windowSortRank(b));
  return windows;
}

function unrefTimer(timer) {
  if (timer && typeof timer.unref === "function") timer.unref();
  return timer;
}

const GLOBAL_STATE_PROP = "__t3HubAgyQuotaInstanceStates";
const STATE_FILE = "agy-quota-state.json";
const LATCH_FILE = "agy-quota-latch.json";

function getInstanceState(key) {
  const states = globalThis[GLOBAL_STATE_PROP] ??= new Map();
  if (!states.has(key)) states.set(key, { record: null, inFlight: null });
  return states.get(key);
}

function readPrivateJson(runDir, name, maxBytes) {
  const target = path.join(runDir, name);
  let file = readRegularFileSafe(runDir, target, maxBytes);
  // An atomic rename by the other process can replace a regular file while
  // it is being opened. Retry only an identity change, never an unsafe path.
  if (file.reason === "file_changed") file = readRegularFileSafe(runDir, target, maxBytes);
  if (!file.ok) throw new Error("unsafe_quota_file");
  if (file.missing) return null;
  if (process.platform !== "win32" && (file.stat.mode & 0o777) !== 0o600) {
    throw new Error("unsafe_quota_permissions");
  }
  const data = JSON.parse(file.text);
  if (!data || data.version !== 1) throw new Error("invalid_quota_file");
  return data;
}

function writePrivateJson(runDir, name, data) {
  const target = path.join(runDir, name);
  const check = assertNoSymlinkSegments(runDir, target, { expectFinalType: "file", allowMissingFinal: true });
  if (!check.ok || (!check.missing && process.platform !== "win32" && (check.stat.mode & 0o777) !== 0o600)) {
    throw new Error("unsafe_quota_file");
  }
  const tmp = path.join(runDir, `${name}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(data) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, target);
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

function readLatchKeys(runDir) {
  const data = readPrivateJson(runDir, LATCH_FILE, 128 * 1024);
  if (data && (!Array.isArray(data.latched) || !data.latched.every(key => typeof key === "string"))) {
    throw new Error("invalid_quota_latch");
  }
  return new Set(data?.latched);
}

function persistLatchKeys(runDir, keysToAdd) {
  const memory = getGlobalLatchSet();
  for (const key of keysToAdd) memory.add(key);
  const keys = readLatchKeys(runDir);
  for (const key of keysToAdd) keys.add(key);
  writePrivateJson(runDir, LATCH_FILE, { version: 1, latched: [...keys] });
}

function isBinaryLatched(runDir, { canonicalKey, realPath }) {
  const memory = getGlobalLatchSet();
  if (memory.has(canonicalKey) || memory.has(realPath)) return true;
  const disk = readLatchKeys(runDir);
  if (!disk.has(canonicalKey) && !disk.has(realPath)) return false;
  memory.add(canonicalKey);
  memory.add(realPath);
  return true;
}

function readQuotaRecords(runDir) {
  const data = readPrivateJson(runDir, STATE_FILE, 1024 * 1024);
  if (!data) return {};
  if (!data.instances || typeof data.instances !== "object" || Array.isArray(data.instances)) {
    throw new Error("invalid_quota_state");
  }
  return data.instances;
}

function readInstanceRecord(records, key, state) {
  if (Object.hasOwn(records, key)) {
    const record = records[key];
    if (!record || !Number.isFinite(record.nextProbeAt) ||
        (record.owner !== null && typeof record.owner !== "string") ||
        (record.usageLimits !== null && !Array.isArray(record.usageLimits?.windows))) {
      throw new Error("invalid_quota_state");
    }
    state.record = record;
  }
  return state.record;
}

function lockOwner(runDir) {
  const lock = path.join(runDir, "agy-quota.lock");
  const check = assertNoSymlinkSegments(runDir, lock, { expectFinalType: "dir", allowMissingFinal: true });
  if (!check.ok) throw new Error("unsafe_quota_lock");
  if (check.missing) return null;
  let names;
  try { names = fs.readdirSync(lock); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!names.length) return { name: null, alive: false };
  const name = names[0];
  const match = /^owner-([1-9][0-9]{0,9})-[a-f0-9-]{36}$/.exec(name);
  if (names.length !== 1 || !match) throw new Error("invalid_quota_lock");
  const marker = assertNoSymlinkSegments(runDir, path.join(lock, name), { expectFinalType: "file", allowMissingFinal: true });
  if (!marker.ok && !marker.missing) throw new Error("unsafe_quota_lock");
  if (!marker.ok || marker.missing) return null;
  try { process.kill(Number(match[1]), 0); }
  catch (error) {
    if (error.code === "ESRCH") return { name, alive: false };
    if (error.code !== "EPERM") throw error;
  }
  return { name, alive: true };
}

// One host-wide probe lock serializes version checks, usage, and state/latch writes
// across the primary backend and Hub Bridge, including different instances of a binary.
function takeQuotaLock(runDir) {
  const lock = path.join(runDir, "agy-quota.lock");
  const owner = `owner-${process.pid}-${crypto.randomUUID()}`;
  const candidate = fs.mkdtempSync(path.join(runDir, ".agy-quota-lock-"));
  try {
    fs.writeFileSync(path.join(candidate, owner), "", { mode: 0o600, flag: "wx" });
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = lockOwner(runDir);
      if (current?.alive) return null;
      if (current?.name) fs.rmSync(path.join(lock, current.name), { force: true });
      try { fs.renameSync(candidate, lock); }
      catch (error) {
        if (error.code === "EEXIST" || error.code === "ENOTEMPTY") continue;
        throw error;
      }
      return {
        owner,
        release() {
          fs.unlinkSync(path.join(lock, owner));
          try { fs.rmdirSync(lock); }
          catch (error) {
            if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
          }
        },
      };
    }
    return null;
  } finally {
    fs.rmSync(candidate, { recursive: true, force: true });
  }
}

function runCliProcess({
  spawnImpl,
  binPath,
  args,
  env,
  timeoutMs,
  maxBytes,
  sigkillGraceMs = DEFAULT_SIGKILL_GRACE_MS,
  hardKillDeadlineMs = DEFAULT_HARD_KILL_DEADLINE_MS,
  configPollMs = DEFAULT_CONFIG_POLL_MS,
  killOnSignedOut = false,
  killOnModelTurn = false,
  onModelTurn = null,
  onSignedOut = null,
  shouldAbort = null,
}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(binPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env,
        windowsHide: true,
      });
    } catch (err) {
      resolve({
        exitCode: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        overflowed: false,
        signedOutDetected: false,
        modelTurnDetected: false,
        abortedByConfig: false,
        killDeadlineExceeded: false,
        spawnError: err,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let totalBytes = 0;
    let settled = false;
    let timedOut = false;
    let overflowed = false;
    let signedOutDetected = false;
    let modelTurnDetected = false;
    let abortedByConfig = false;
    let killDeadlineExceeded = false;
    let killed = false;
    let sigkillTimer = null;
    let hardDeadlineTimer = null;
    let timeoutTimer = null;
    let configPollTimer = null;

    const clearAllTimers = () => {
      if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
      if (sigkillTimer) { clearTimeout(sigkillTimer); sigkillTimer = null; }
      if (hardDeadlineTimer) { clearTimeout(hardDeadlineTimer); hardDeadlineTimer = null; }
      if (configPollTimer) { clearInterval(configPollTimer); configPollTimer = null; }
    };

    const forceDetachChild = () => {
      try { child.stdout?.destroy?.(); } catch {}
      try { child.stderr?.destroy?.(); } catch {}
      try { child.unref?.(); } catch {}
    };

    const finish = (exitCode, spawnError = null) => {
      if (settled) return;
      settled = true;
      clearAllTimers();
      resolve({
        exitCode,
        stdout,
        stderr,
        timedOut,
        overflowed,
        signedOutDetected,
        modelTurnDetected,
        abortedByConfig,
        killDeadlineExceeded,
        spawnError,
      });
    };

    const killChild = () => {
      if (killed || settled) return;
      killed = true;
      try { child.kill("SIGTERM"); } catch {}
      if (settled) return;
      sigkillTimer = unrefTimer(setTimeout(() => {
        sigkillTimer = null;
        if (settled) return;
        try { child.kill("SIGKILL"); } catch {}
        if (settled) return;
        hardDeadlineTimer = unrefTimer(setTimeout(() => {
          hardDeadlineTimer = null;
          if (settled) return;
          killDeadlineExceeded = true;
          forceDetachChild();
          finish(null, new Error("kill_deadline_exceeded"));
        }, Math.max(10, hardKillDeadlineMs)));
      }, Math.max(10, sigkillGraceMs)));
    };

    const abortNow = () => {
      if (settled) return;
      abortedByConfig = true;
      killChild();
    };

    timeoutTimer = unrefTimer(setTimeout(() => {
      timeoutTimer = null;
      timedOut = true;
      killChild();
    }, Math.max(10, timeoutMs)));

    if (typeof shouldAbort === "function" && configPollMs > 0) {
      configPollTimer = unrefTimer(setInterval(() => {
        if (settled || killed) return;
        try {
          if (shouldAbort()) abortNow();
        } catch {
          abortNow();
        }
      }, configPollMs));
    }

    const appendChunk = (target, chunk) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      const previous = target === "stdout" ? stdout : stderr;
      const text = (overflowed ? previous.slice(-512) : previous) + buf.toString("utf8");
      totalBytes += buf.length;
      if (totalBytes <= maxBytes) {
        if (target === "stdout") stdout = text;
        else stderr = text;
      } else {
        overflowed = true;
      }

      if (killOnModelTurn && !modelTurnDetected && outputShowsModelTurn(text)) {
        modelTurnDetected = true;
        killChild();
        try { onModelTurn?.(); } catch {}
      }
      if (killOnSignedOut && !signedOutDetected && outputLooksSignedOut(text)) {
        signedOutDetected = true;
        killChild();
        try { onSignedOut?.(); } catch {}
      }
      if (overflowed) killChild();
      try {
        if (shouldAbort?.()) abortNow();
      } catch {
        abortNow();
      }
    };

    if (child.stdout && typeof child.stdout.on === "function") {
      child.stdout.on("data", (chunk) => appendChunk("stdout", chunk));
    }
    if (child.stderr && typeof child.stderr.on === "function") {
      child.stderr.on("data", (chunk) => appendChunk("stderr", chunk));
    }

    child.on("error", (err) => finish(null, err));
    child.on("close", (code) => finish(typeof code === "number" ? code : null, null));
  });
}

const QUOTA_MIRROR_DIR = ".t3-hub/quota";
const QUOTA_MIRROR_FILE = ".t3-hub/quota/snapshot.json";
const QUOTA_MIRROR_MARKER = "# t3-hub connect quota mirror v1 (local only)";
const QUOTA_MIRROR_SOURCE = "hub-quota-mirror";
const MAX_MIRROR_PROVIDERS = 8;
const MAX_MIRROR_WINDOWS = 16;
const MAX_MIRROR_BYTES = 32 * 1024;
const MAX_EXISTING_MIRROR_BYTES = 64 * 1024;
const MAX_MIRROR_TARGET_ROOTS = 24;
const RECENT_WORKTREE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MIRROR_VERIFY_TTL_MS = 60_000;
const MIRROR_UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const ALLOWED_MIRROR_WINDOW_KINDS = new Set(["session", "weekly", "other", "daily", "monthly"]);

function sanitizeMirrorText(value, maxLen) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maxLen);
}

function normalizeMirrorIso(raw) {
  const ms = parseResetTimestampMs(raw);
  if (ms === null || !Number.isFinite(ms) || ms < MIN_VALID_RESET_MS || ms > MAX_VALID_RESET_MS) {
    return null;
  }
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function buildQuotaMirrorPayload(input, { now = () => Date.now() } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const environmentId = typeof input.environmentId === "string" ? input.environmentId.trim() : "";
  if (!MIRROR_UUID_RE.test(environmentId)) return null;

  const rawProviders = Array.isArray(input.providers) ? input.providers : [];
  if (!rawProviders.length) return null;

  const providers = [];
  let latestCheckedAtMs = -Infinity;
  let latestCheckedAtIso = null;

  for (const raw of rawProviders) {
    if (providers.length >= MAX_MIRROR_PROVIDERS) break;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    if (String(raw.driver || "").trim().toLowerCase() !== "antigravity") continue;
    if (!sanitizeMirrorText(raw.instanceId, 128)) continue;

    const ul = raw.usageLimits && typeof raw.usageLimits === "object" && !Array.isArray(raw.usageLimits)
      ? raw.usageLimits
      : null;
    if (!ul || !Array.isArray(ul.windows)) continue;

    const windows = [];
    const seenWindowIds = new Set();
    const otherIndexByPool = { gemini: 0, "3p": 0 };

    for (const w of ul.windows) {
      if (windows.length >= MAX_MIRROR_WINDOWS) break;
      if (!w || typeof w !== "object" || Array.isArray(w)) continue;
      if (typeof w.usedPercent !== "number" || !Number.isFinite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100) {
        continue;
      }

      const rawId = typeof w.id === "string" ? w.id : "";
      const rawLabel = typeof w.label === "string" ? w.label : "";
      const rawKind = typeof w.kind === "string" ? w.kind.trim().toLowerCase() : "";
      const descriptor = `${rawId} ${rawLabel}`;
      const pool = /claude|gpt|3p/i.test(descriptor) ? "3p" : "gemini";
      const windowDurationMins =
        typeof w.windowDurationMins === "number" && Number.isFinite(w.windowDurationMins) && w.windowDurationMins > 0
          ? w.windowDurationMins
          : null;

      const is5h =
        rawKind !== "weekly" &&
        (windowDurationMins === 300 ||
          rawKind === "session" ||
          /5\s*[-_ ]?\s*h|five\s*[-_ ]?\s*hour|session/i.test(descriptor));
      const isWeekly =
        !is5h &&
        (rawKind === "weekly" || windowDurationMins === 10080 || /week/i.test(descriptor));

      let id;
      let kind;
      let label;
      if (is5h) {
        id = `${pool}-5h`;
        kind = "session";
        label = pool === "3p" ? "Claude & GPT (shared) · 5-hour" : "Gemini · 5-hour";
      } else if (isWeekly) {
        id = `${pool}-weekly`;
        kind = "weekly";
        label = pool === "3p" ? "Claude & GPT (shared) · Weekly" : "Gemini · Weekly";
      } else {
        otherIndexByPool[pool] += 1;
        id = `${pool}-quota-${otherIndexByPool[pool]}`;
        kind = "other";
        label = pool === "3p" ? "Claude & GPT (shared) · Quota" : "Gemini · Quota";
      }

      if (seenWindowIds.has(id)) continue;
      seenWindowIds.add(id);

      const resetsAt = normalizeMirrorIso(w.resetsAt);
      windows.push({
        id,
        kind,
        label,
        usedPercent: w.usedPercent,
        ...(resetsAt !== null ? { resetsAt } : {}),
        ...(windowDurationMins !== null ? { windowDurationMins } : {}),
      });
    }

    if (!windows.length) continue;

    const checkedAtIso = normalizeMirrorIso(ul.checkedAt);
    if (checkedAtIso) {
      const ms = Date.parse(checkedAtIso);
      if (Number.isFinite(ms) && ms > latestCheckedAtMs) {
        latestCheckedAtMs = ms;
        latestCheckedAtIso = checkedAtIso;
      }
    }

    const opaqueInstanceId = providers.length === 0 ? "antigravity" : `antigravity-${providers.length + 1}`;
    providers.push({
      instanceId: opaqueInstanceId,
      driver: "antigravity",
      displayName: "AGY",
      usageLimits: {
        checkedAt: checkedAtIso,
        windows,
      },
    });
  }

  if (!providers.length) return null;

  const updatedAt = normalizeMirrorIso(input.updatedAt) || latestCheckedAtIso || new Date(now()).toISOString();
  for (const p of providers) {
    if (!p.usageLimits.checkedAt) p.usageLimits.checkedAt = updatedAt;
  }

  const payload = {
    schemaVersion: 1,
    source: QUOTA_MIRROR_SOURCE,
    environmentId,
    updatedAt,
    providers,
  };

  if (Buffer.byteLength(JSON.stringify(payload, null, 2) + "\n", "utf8") > MAX_MIRROR_BYTES) {
    return null;
  }
  return payload;
}

function isStrictInsidePath(rootPath, candidatePath) {
  const rel = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return Boolean(rel) && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
}

function assertNoSymlinkTail(targetPath, { expectFinalType = null, allowMissingTail = true } = {}) {
  if (
    typeof targetPath !== "string" ||
    !targetPath.trim() ||
    !path.isAbsolute(targetPath) ||
    /[\u0000-\u001f\u007f]/.test(targetPath)
  ) {
    return { ok: false, missing: false, reason: "invalid_path" };
  }
  try {
    const normalized = normalizeSystemPath(targetPath);
    const parsed = path.parse(normalized);
    let current = parsed.root;
    let stat = fs.lstatSync(current);
    for (const part of normalized.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      let next;
      try {
        next = fs.lstatSync(current);
      } catch (err) {
        if (err && err.code === "ENOENT" && allowMissingTail) {
          return { ok: true, missing: true, resolvedPath: normalized };
        }
        return { ok: false, missing: err?.code === "ENOENT", reason: "missing" };
      }
      if (next.isSymbolicLink()) return { ok: false, missing: false, reason: "symlink" };
      if (current !== normalized && !next.isDirectory()) return { ok: false, missing: false, reason: "not_dir" };
      stat = next;
    }
    if (expectFinalType === "dir" && !stat.isDirectory()) return { ok: false, missing: false, reason: "not_dir" };
    if (expectFinalType === "file" && !stat.isFile()) return { ok: false, missing: false, reason: "not_file" };
    const realPath = fs.realpathSync(normalized);
    return { ok: true, missing: false, stat, resolvedPath: normalized, realPath };
  } catch {
    return { ok: false, missing: false, reason: "stat_failed" };
  }
}

function mirrorTableExists(db, table) {
  try {
    return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table));
  } catch {
    return false;
  }
}

function mirrorTableColumns(db, table) {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all().map((r) => r.name));
  } catch {
    return new Set();
  }
}

function parseTimestampMsLoose(raw) {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw > 1e12 ? raw : raw * 1000;
  }
  if (typeof raw === "string" && raw.trim()) {
    const ms = Date.parse(raw.trim());
    return Number.isFinite(ms) ? ms : NaN;
  }
  return NaN;
}

function discoverQuotaMirrorRoots({ t3DbPath, targetRoots, now = () => Date.now() } = {}) {
  const roots = [];
  const seen = new Set();
  const addRoot = (raw) => {
    if (roots.length >= MAX_MIRROR_TARGET_ROOTS) return;
    if (typeof raw !== "string") return;
    const trimmed = raw.trim();
    if (!trimmed || !path.isAbsolute(trimmed) || /[\u0000-\u001f\u007f]/.test(trimmed)) return;
    const key = normalizeSystemPath(trimmed);
    if (seen.has(key)) return;
    seen.add(key);
    roots.push(trimmed);
  };

  if (typeof targetRoots === "function") {
    const list = targetRoots();
    if (Array.isArray(list)) {
      for (const item of list) addRoot(item);
    }
    return roots;
  }
  if (Array.isArray(targetRoots)) {
    for (const item of targetRoots) addRoot(item);
    return roots;
  }

  if (typeof t3DbPath !== "string" || !t3DbPath.trim()) return roots;
  const dbCheck = assertNoSymlinkTail(t3DbPath, { expectFinalType: "file", allowMissingTail: false });
  if (!dbCheck.ok || !dbCheck.realPath) return roots;

  let db = null;
  try {
    db = new DatabaseSync(dbCheck.realPath, { readOnly: true });

    if (mirrorTableExists(db, "projection_projects")) {
      const cols = mirrorTableColumns(db, "projection_projects");
      if (cols.has("workspace_root")) {
        const where = cols.has("deleted_at") ? " WHERE deleted_at IS NULL" : "";
        const order = cols.has("updated_at") ? " ORDER BY updated_at DESC" : "";
        try {
          const rows = db.prepare(`SELECT workspace_root FROM projection_projects${where}${order}`).all();
          for (const row of rows) {
            if (roots.length >= MAX_MIRROR_TARGET_ROOTS) break;
            addRoot(row?.workspace_root);
          }
        } catch {}
      }
    }

    if (roots.length < MAX_MIRROR_TARGET_ROOTS) {
      const childIds = new Set();
      if (mirrorTableExists(db, "orchestration_v2_projection_subagents")) {
        const subCols = mirrorTableColumns(db, "orchestration_v2_projection_subagents");
        if (subCols.has("child_thread_id")) {
          try {
            for (const r of db.prepare("SELECT child_thread_id FROM orchestration_v2_projection_subagents").all()) {
              if (r?.child_thread_id != null && String(r.child_thread_id)) childIds.add(String(r.child_thread_id));
            }
          } catch {}
        }
      }

      const table = mirrorTableExists(db, "orchestration_v2_projection_threads")
        ? "orchestration_v2_projection_threads"
        : mirrorTableExists(db, "projection_threads")
          ? "projection_threads"
          : null;

      if (table) {
        const cols = mirrorTableColumns(db, table);
        const sel = ["thread_id", "updated_at", "created_at", "payload_json", "parent_thread_id", "worktree_path"].filter((c) => cols.has(c));
        if (sel.length && (cols.has("payload_json") || cols.has("worktree_path"))) {
          const clauses = [];
          if (cols.has("deleted_at")) clauses.push("deleted_at IS NULL");
          if (table === "projection_threads" && cols.has("parent_thread_id")) clauses.push("parent_thread_id IS NULL");
          const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
          const order = cols.has("updated_at") ? " ORDER BY updated_at DESC" : cols.has("created_at") ? " ORDER BY created_at DESC" : "";
          const cutoffMs = now() - RECENT_WORKTREE_WINDOW_MS;
          try {
            const rows = db.prepare(`SELECT ${sel.join(", ")} FROM ${table}${where}${order}`).all();
            for (const row of rows) {
              if (roots.length >= MAX_MIRROR_TARGET_ROOTS) break;
              if (row?.thread_id != null && childIds.has(String(row.thread_id))) continue;
              const tsMs = parseTimestampMsLoose(row?.updated_at ?? row?.created_at);
              if (!Number.isFinite(tsMs) || tsMs < cutoffMs) continue;
              let payload = null;
              if (typeof row?.payload_json === "string" && row.payload_json) {
                try { payload = JSON.parse(row.payload_json); } catch {}
              }
              if (table === "orchestration_v2_projection_threads") {
                if (payload?.lineage?.parentThreadId != null) continue;
              }
              const wt =
                typeof payload?.worktreePath === "string" && payload.worktreePath
                  ? payload.worktreePath
                  : typeof row?.worktree_path === "string" && row.worktree_path
                    ? row.worktree_path
                    : "";
              if (wt) addRoot(wt);
            }
          } catch {}
        }
      }
    }
  } catch {
    // Read-only discovery must never fail callers.
  } finally {
    try { db?.close(); } catch {}
  }

  return roots;
}

function createAgyQuotaMirror({
  t3DbPath = null,
  targetRoots = null,
  now = () => Date.now(),
  execFileImpl = execFile,
} = {}) {
  const pendingByEnv = new Map();
  const verifiedCache = new Map();
  let drainPromise = null;
  let disposed = false;

  function runLocalGit(cwd, args) {
    return new Promise((resolve) => {
      try {
        execFileImpl(
          "git",
          args,
          { cwd, encoding: "utf8", windowsHide: true, timeout: 3000, maxBuffer: 1024 * 1024 },
          (error, stdout) => resolve(error ? null : String(stdout || "").replace(/\r?\n$/, ""))
        );
      } catch {
        resolve(null);
      }
    });
  }

  function fileFingerprint(file) {
    try {
      const st = fs.lstatSync(file);
      return [st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs, st.mode].join(":");
    } catch {
      return "missing";
    }
  }

  function existingQuotaMirror(file) {
    const check = assertNoSymlinkTail(file, { allowMissingTail: true });
    if (!check.ok) return false;
    if (check.missing) return null;
    try {
      const stat = fs.lstatSync(check.resolvedPath);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size > MAX_EXISTING_MIRROR_BYTES ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid())
      ) {
        return false;
      }
      const text = fs.readFileSync(check.resolvedPath, "utf8");
      const data = JSON.parse(text);
      if (
        !data ||
        typeof data !== "object" ||
        Array.isArray(data) ||
        data.schemaVersion !== 1 ||
        data.source !== QUOTA_MIRROR_SOURCE
      ) {
        return false;
      }
      return { text, data, stat, mode: stat.mode & 0o777, resolvedPath: check.resolvedPath };
    } catch (error) {
      if (error && error.code === "ENOENT") return null;
      return false;
    }
  }

  function unlinkManagedQuotaMirror(file) {
    const existing = existingQuotaMirror(file);
    if (!existing || !existing.stat) return false;
    try {
      const after = fs.lstatSync(existing.resolvedPath);
      if (
        after.isFile() &&
        after.dev === existing.stat.dev &&
        after.ino === existing.stat.ino &&
        after.size === existing.stat.size &&
        after.mtimeMs === existing.stat.mtimeMs
      ) {
        fs.unlinkSync(existing.resolvedPath);
        verifiedCache.delete(existing.resolvedPath);
        return true;
      }
    } catch {}
    return false;
  }

  async function ensureLocalQuotaIgnore(cwd, repoRoot, canonicalGitDir, relFile) {
    const relDir = path.posix.dirname(relFile);
    const tracked = await runLocalGit(repoRoot, ["ls-files", "-z", "--", relDir]);
    if (tracked == null) return { ok: false, reason: "git_unavailable" };
    if (tracked) return { ok: false, reason: "mirror_dir_tracked" };

    const excludeRaw = await runLocalGit(cwd, ["rev-parse", "--git-path", "info/exclude"]);
    if (!excludeRaw) return { ok: false, reason: "exclude_unavailable" };
    const absoluteExclude = normalizeSystemPath(path.resolve(cwd, excludeRaw));
    if (!isStrictInsidePath(canonicalGitDir, absoluteExclude)) {
      return { ok: false, reason: "exclude_outside_gitdir" };
    }
    const excludeCheck = assertNoSymlinkTail(absoluteExclude, { allowMissingTail: true });
    if (!excludeCheck.ok) return { ok: false, reason: "exclude_unsafe" };

    try {
      fs.mkdirSync(path.dirname(absoluteExclude), { recursive: true, mode: 0o700 });
      let content = "";
      try {
        const st = fs.lstatSync(absoluteExclude);
        if (!st.isFile() || st.nlink !== 1 || (typeof process.getuid === "function" && st.uid !== process.getuid())) {
          return { ok: false, reason: "exclude_unsafe" };
        }
        content = fs.readFileSync(absoluteExclude, "utf8");
      } catch (error) {
        if (!error || error.code !== "ENOENT") throw error;
      }

      const pattern = "/" + relDir.replace(/[\\*?\[\] ]/g, "\\$&") + "/";
      const lines = content.split(/\r?\n/);
      if (!lines.includes(pattern)) {
        const addition = `${content && !content.endsWith("\n") ? "\n" : ""}${QUOTA_MIRROR_MARKER}\n${pattern}\n`;
        fs.writeFileSync(absoluteExclude, addition, { encoding: "utf8", flag: "a", mode: 0o600 });
      }

      const ignored = await runLocalGit(repoRoot, ["check-ignore", "-q", "--no-index", "--", relFile]);
      if (ignored == null) return { ok: false, reason: "exclude_not_effective" };
      return { ok: true, excludePath: absoluteExclude, relDir };
    } catch {
      return { ok: false, reason: "exclude_write_failed" };
    }
  }

  async function publishToRoot(targetRoot, serializedText) {
    if (disposed) return false;
    const rootCheck = assertNoSymlinkTail(targetRoot, { expectFinalType: "dir", allowMissingTail: false });
    if (!rootCheck.ok || !rootCheck.realPath) return false;

    const cwd = rootCheck.realPath;
    const file = path.join(cwd, QUOTA_MIRROR_FILE);
    let previous = existingQuotaMirror(file);
    if (previous === false) return false;

    const cached = verifiedCache.get(file);
    const unchanged = previous && previous.text === serializedText && (process.platform === "win32" || previous.mode === 0o600);
    if (unchanged && cached && cached.until > now() && cached.files.every(([name, sig]) => fileFingerprint(name) === sig)) {
      return true;
    }

    const [repoRootRaw, commonRaw, indexRaw] = await Promise.all([
      runLocalGit(cwd, ["rev-parse", "--show-toplevel"]),
      runLocalGit(cwd, ["rev-parse", "--git-common-dir"]),
      runLocalGit(cwd, ["rev-parse", "--git-path", "index"]),
    ]);
    if (!repoRootRaw || !commonRaw || !indexRaw) return false;

    const repoCheck = assertNoSymlinkTail(repoRootRaw, { expectFinalType: "dir", allowMissingTail: false });
    const commonCheck = assertNoSymlinkTail(path.resolve(cwd, commonRaw), { expectFinalType: "dir", allowMissingTail: false });
    if (!repoCheck.ok || !commonCheck.ok) return false;

    const repoRoot = repoCheck.realPath;
    const canonicalGitDir = commonCheck.realPath;
    if (!isStrictInsidePath(repoRoot, file)) return false;

    const relFile = path.relative(repoRoot, file).split(path.sep).join("/");
    const ignored = await ensureLocalQuotaIgnore(cwd, repoRoot, canonicalGitDir, relFile);
    if (!ignored.ok) {
      if (ignored.reason === "exclude_not_effective") {
        unlinkManagedQuotaMirror(file);
      }
      return false;
    }

    if (disposed) return false;
    previous = existingQuotaMirror(file);
    if (previous === false) return false;

    if (!(previous && previous.text === serializedText && (process.platform === "win32" || previous.mode === 0o600))) {
      const pathCheck = assertNoSymlinkTail(file, { allowMissingTail: true });
      if (!pathCheck.ok) return false;
      const mirrorDir = path.dirname(file);
      fs.mkdirSync(mirrorDir, { recursive: true, mode: 0o700 });
      const dirCheck = assertNoSymlinkTail(mirrorDir, { expectFinalType: "dir", allowMissingTail: false });
      if (!dirCheck.ok) return false;

      const tmp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
      try {
        fs.writeFileSync(tmp, serializedText, { flag: "wx", mode: 0o600 });
        fs.renameSync(tmp, file);
      } finally {
        try { fs.unlinkSync(tmp); } catch {}
      }
    }

    const watchedFiles = [
      ignored.excludePath,
      path.resolve(cwd, indexRaw),
      path.join(canonicalGitDir, "config"),
      cwd,
      path.join(cwd, ".git"),
    ];
    for (let dir = path.dirname(file); dir === repoRoot || isStrictInsidePath(repoRoot, dir); dir = path.dirname(dir)) {
      watchedFiles.push(path.join(dir, ".gitignore"));
      if (dir === repoRoot) break;
    }
    verifiedCache.set(file, {
      until: now() + MIRROR_VERIFY_TTL_MS,
      files: watchedFiles.map((name) => [name, fileFingerprint(name)]),
    });
    if (verifiedCache.size > 64) {
      verifiedCache.delete(verifiedCache.keys().next().value);
    }
    return true;
  }

  async function drainQueue() {
    while (!disposed && pendingByEnv.size > 0) {
      const [envId, payload] = pendingByEnv.entries().next().value;
      pendingByEnv.delete(envId);
      const serializedText = JSON.stringify(payload, null, 2) + "\n";
      const roots = discoverQuotaMirrorRoots({ t3DbPath, targetRoots, now });
      for (const root of roots) {
        if (disposed) break;
        try {
          await publishToRoot(root, serializedText);
        } catch {}
      }
    }
  }

  function startDrain() {
    if (!disposed && !drainPromise && pendingByEnv.size > 0) {
      drainPromise = new Promise((resolve) => setImmediate(resolve))
        .then(drainQueue)
        .finally(() => {
          drainPromise = null;
          if (!disposed && pendingByEnv.size > 0) startDrain();
        });
    }
  }

  function queueQuotaMirror(input) {
    if (disposed) return false;
    const payload = buildQuotaMirrorPayload(input, { now });
    if (!payload) return false;
    pendingByEnv.set(payload.environmentId, payload);
    startDrain();
    return true;
  }

  async function flushQuotaMirrors() {
    while (drainPromise) {
      await drainPromise;
    }
  }

  function disposeQuotaMirrors() {
    disposed = true;
    pendingByEnv.clear();
    verifiedCache.clear();
  }

  return {
    queueQuotaMirror,
    flushQuotaMirrors,
    disposeQuotaMirrors,
  };
}

function createAgyQuotaReader({
  homeDir = os.homedir(),
  t3CodeHome,
  baseDir,
  userDataDir,
  toolsDir,
  pluginDir,
  t3DbPath,
  targetRoots,
  platform = process.platform,
  arch = process.arch,
  baseEnv = process.env,
  spawnImpl = spawn,
  execFileImpl = execFile,
  now = () => Date.now(),
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  errorBackoffMs = DEFAULT_ERROR_BACKOFF_MS,
  signedOutBackoffMs = DEFAULT_SIGNED_OUT_BACKOFF_MS,
  rpcWaitMs = DEFAULT_RPC_WAIT_MS,
  versionTimeoutMs = DEFAULT_VERSION_TIMEOUT_MS,
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  sigkillGraceMs = DEFAULT_SIGKILL_GRACE_MS,
  hardKillDeadlineMs = DEFAULT_HARD_KILL_DEADLINE_MS,
  configPollMs = DEFAULT_CONFIG_POLL_MS,
  maxOutputBytes = MAX_OUTPUT_BYTES,
} = {}) {
  const paths = resolveT3Paths({ homeDir, t3CodeHome });
  const resolvedHome = paths.homeDir;
  const resolvedBaseDir = typeof baseDir === "string" && baseDir.trim() ? path.resolve(baseDir) : paths.baseDir;
  const resolvedUserDataDir =
    typeof userDataDir === "string" && userDataDir.trim() ? path.resolve(userDataDir) : paths.userDataDir;
  const resolvedToolsDir =
    typeof toolsDir === "string" && toolsDir.trim()
      ? path.resolve(toolsDir)
      : typeof userDataDir === "string" && userDataDir.trim()
        ? path.basename(resolvedUserDataDir) === "userdata"
          ? path.join(path.dirname(resolvedUserDataDir), "tools")
          : path.join(resolvedUserDataDir, "tools")
        : paths.toolsDir;
  const resolvedPluginDir = resolvePluginDir({ homeDir: resolvedHome, pluginDir });

  const userDataAnchor = pickAnchorDir(resolvedBaseDir, resolvedUserDataDir);
  const pluginAnchor = pickAnchorDir(resolvedBaseDir, resolvedPluginDir);

  const runDir = path.join(resolvedPluginDir, "run");
  const instanceOptions = {
    homeDir: resolvedHome,
    t3CodeHome,
    baseDir: resolvedBaseDir,
    userDataDir: resolvedUserDataDir,
  };
  const binaryOptions = { ...instanceOptions, toolsDir: resolvedToolsDir, platform, arch };
  const versionCache = new Set();

  const isEnabled = () => checkAgyCliQuotaEnabled(resolvedPluginDir, pluginAnchor);
  const resolveBinary = (instance) => resolveManagedAgyBinary({ ...binaryOptions, binaryPath: instance.binaryPath });
  const checkProfile = (instance) => assertNoSymlinkSegments(userDataAnchor, instance.profileDir, { expectFinalType: "dir" });

  function prepareRunDir() {
    const plugin = assertNoSymlinkSegments(pluginAnchor, resolvedPluginDir, { expectFinalType: "dir" });
    if (!plugin.ok) throw new Error("unsafe_quota_plugin");
    const run = assertNoSymlinkSegments(pluginAnchor, runDir, { expectFinalType: "dir", allowMissingFinal: true });
    if (!run.ok) throw new Error("unsafe_quota_run");
    if (run.missing) {
      try { fs.mkdirSync(run.resolvedPath, { mode: 0o700 }); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
    }
    const current = assertNoSymlinkSegments(pluginAnchor, runDir, { expectFinalType: "dir" });
    if (!current.ok) throw new Error("unsafe_quota_run");
    return current.realPath;
  }

  function startPhase(candidate) {
    const { instance, binary, profile } = candidate;
    if (!isEnabled().enabled) return null;
    const currentInstance = resolveAgyInstances(instanceOptions).find(entry => entry.instanceId === instance.instanceId);
    if (!currentInstance || currentInstance.binaryPath !== instance.binaryPath) return null;
    const currentProfile = checkProfile(currentInstance);
    if (!currentProfile.ok || currentProfile.stat.dev !== profile.stat.dev || currentProfile.stat.ino !== profile.stat.ino) {
      return null;
    }
    const env = buildUsageCliEnv(baseEnv, instance.profileDir, { platform, userDataAnchor, requireProfileDir: true });
    const currentBinary = resolveBinary(currentInstance);
    if (!env || !currentBinary || currentBinary.canonicalKey !== binary.canonicalKey || currentBinary.recordKey !== binary.recordKey) {
      return null;
    }
    return env;
  }

  async function probeInstance(runPath, candidate) {
    const { key, state, binary } = candidate;
    const lock = takeQuotaLock(runPath);
    if (!lock) return "busy";
    try {
      const records = readQuotaRecords(runPath);
      const previous = readInstanceRecord(records, key, state);
      if ((previous && now() < previous.nextProbeAt) || isBinaryLatched(runPath, binary)) return;

      let env;
      if (!startPhase(candidate)) return;
      const versionKey = binary.canonicalKey + ":" + binary.recordKey;
      const knownVersion = binary.releaseVersion && compareSemver(binary.releaseVersion, MIN_USAGE_CLI_VERSION);
      if (knownVersion < 0) return;

      const save = (usageLimits, delay, owner = null) => {
        const record = { usageLimits, nextProbeAt: now() + delay, owner };
        records[key] = record;
        writePrivateJson(runPath, STATE_FILE, { version: 1, instances: records });
        state.record = record;
      };
      // Persist the cooldown before any process starts, so an interrupted owner
      // cannot make the other RPC path retry the same instance immediately.
      save(previous?.usageLimits ?? null, errorBackoffMs, lock.owner);

      let signedOut = false;
      let modelTurn = false;
      const latchNow = () => {
        if (modelTurn) return;
        modelTurn = true;
        persistLatchKeys(runPath, [binary.canonicalKey, binary.realPath]);
      };
      const backOffSignedOut = () => {
        if (signedOut) return;
        signedOut = true;
        save(null, signedOutBackoffMs, lock.owner);
      };
      const run = async (args, timeoutMs, maxBytes) => {
        const result = await runCliProcess({
          spawnImpl, binPath: binary.binPath, args, env, timeoutMs, maxBytes,
          sigkillGraceMs, hardKillDeadlineMs, configPollMs,
          killOnSignedOut: true,
          killOnModelTurn: true,
          onSignedOut: backOffSignedOut,
          onModelTurn: latchNow,
          shouldAbort: () => !isEnabled().enabled,
        });
        const outputs = [result.stdout, result.stderr];
        if (result.modelTurnDetected || outputs.some(outputShowsModelTurn)) latchNow();
        if (result.signedOutDetected || outputs.some(outputLooksSignedOut)) backOffSignedOut();
        return result;
      };
      const completed = result => !signedOut && !modelTurn && !result.abortedByConfig &&
        !result.spawnError && !result.timedOut && !result.overflowed && !result.killDeadlineExceeded &&
        result.exitCode === 0 && isEnabled().enabled;

      let usageLimits = previous?.usageLimits ?? null;
      let succeeded = false;
      try {
        if (!versionCache.has(versionKey)) {
          env = startPhase(candidate);
          if (!env) return;
          const version = await run(["--version"], versionTimeoutMs, MAX_VERSION_OUTPUT_BYTES);
          if (!completed(version)) return;
          const parsed = parseStrictCliVersionOutput(version.stdout);
          if (!parsed || compareSemver(parsed.raw, MIN_USAGE_CLI_VERSION) < 0) {
            usageLimits = null;
            return;
          }
          versionCache.add(versionKey);
        }

        // The active release record, executable, and profile can all change
        // between or during phases, including while this instance was queued.
        env = startPhase(candidate);
        if (!env || isBinaryLatched(runPath, binary)) {
          usageLimits = null;
          return;
        }
        const requestedAt = now();
        const logFile = platform === "win32" ? "NUL" : "/dev/null";
        const result = await run(
          ["-p", "/usage", "--output-format", "json", "--print-timeout", "20s", "--log-file", logFile],
          probeTimeoutMs,
          maxOutputBytes,
        );
        if (!completed(result)) return;
        if (!startPhase(candidate)) {
          usageLimits = null;
          return;
        }
        const windows = parseAgyCliUsageWindows(result.stdout, { requestedAt });
        if (!windows.length) return;
        usageLimits = { checkedAt: new Date(requestedAt).toISOString(), windows };
        succeeded = true;
      } finally {
        if (signedOut || modelTurn || !isEnabled().enabled) usageLimits = null;
        save(usageLimits, signedOut ? signedOutBackoffMs : succeeded ? cacheTtlMs : errorBackoffMs);
      }
    } finally {
      lock.release();
    }
  }

  async function readAgyQuotas() {
    // A caller's force flag never bypasses either persisted cooldown.
    const enabledCheck = isEnabled();
    if (!enabledCheck.enabled) {
      return { ok: true, available: false, reason: enabledCheck.reason, providers: [] };
    }

    const instances = resolveAgyInstances(instanceOptions);
    if (!instances.length) return { ok: true, available: false, providers: [] };

    try {
      const base = assertNoSymlinkSegments(resolvedBaseDir, resolvedBaseDir, { expectFinalType: "dir" });
      const data = assertNoSymlinkSegments(userDataAnchor, resolvedUserDataDir, { expectFinalType: "dir" });
      if (!base.ok || !data.ok) return { ok: true, available: false, providers: [] };
      const runPath = prepareRunDir();
      const records = readQuotaRecords(runPath);
      const candidates = [];
      const activePromises = [];

      for (const instance of instances) {
        const profile = checkProfile(instance);
        const binary = profile.ok ? resolveBinary(instance) : null;
        if (!binary || isBinaryLatched(runPath, binary)) continue;

        const key = crypto.createHash("sha256")
          .update(JSON.stringify([base.realPath, data.realPath, instance.instanceId])).digest("hex");
        const state = getInstanceState(key);
        const record = readInstanceRecord(records, key, state);
        const candidate = { instance, profile, binary, key, state };
        candidates.push(candidate);
        if (!state.inFlight && (!record || now() >= record.nextProbeAt)) {
          state.inFlight = withProbeQueue(runPath, () => probeInstance(runPath, candidate))
            .finally(() => { state.inFlight = null; });
        }
        if (state.inFlight) activePromises.push(state.inFlight);
      }

      let settled = [];
      if (activePromises.length) {
        let timer;
        try {
          settled = await Promise.race([
            Promise.allSettled(activePromises),
            new Promise(resolve => { timer = unrefTimer(setTimeout(() => resolve([]), Math.max(0, rpcWaitMs))); }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }

      const postCheck = isEnabled();
      if (!postCheck.enabled) {
        return { ok: true, available: false, reason: postCheck.reason, providers: [] };
      }

      const latest = readQuotaRecords(runPath);
      const owner = lockOwner(runPath);
      let pending = settled.some(result => result.value === "busy");
      const providers = [];
      for (const { instance, binary, key, state } of candidates) {
        if (isBinaryLatched(runPath, binary)) continue;
        const record = readInstanceRecord(latest, key, state);
        if (state.inFlight || (owner?.alive && owner.name === record?.owner)) pending = true;
        if (record?.usageLimits) {
          providers.push({
            instanceId: instance.instanceId,
            driver: "antigravity",
            displayName: instance.displayName || "AGY",
            usageLimits: record.usageLimits,
          });
        }
      }

      return {
        ok: true,
        available: providers.length > 0,
        cached: !activePromises.length && !pending,
        ...(pending ? { pending: true } : {}),
        providers,
      };
    } catch {
      return { ok: true, available: false, providers: [] };
    }
  }

  const resolvedT3DbPath =
    typeof t3DbPath === "string" && t3DbPath.trim()
      ? path.resolve(t3DbPath)
      : path.join(resolvedUserDataDir, "statev2.sqlite");
  const quotaMirror = createAgyQuotaMirror({
    t3DbPath: resolvedT3DbPath,
    targetRoots,
    now,
    execFileImpl,
  });

  return {
    readAgyQuotas,
    queueQuotaMirror: quotaMirror.queueQuotaMirror,
    flushQuotaMirrors: quotaMirror.flushQuotaMirrors,
    disposeQuotaMirrors: quotaMirror.disposeQuotaMirrors,
  };
}

module.exports = {
  MIN_USAGE_CLI_VERSION,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_ERROR_BACKOFF_MS,
  DEFAULT_SIGNED_OUT_BACKOFF_MS,
  DEFAULT_RPC_WAIT_MS,
  DEFAULT_VERSION_TIMEOUT_MS,
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_SIGKILL_GRACE_MS,
  DEFAULT_HARD_KILL_DEADLINE_MS,
  MAX_OUTPUT_BYTES,
  MIN_VALID_RESET_MS,
  MAX_VALID_RESET_MS,
  createAgyQuotaReader,
  createAgyQuotaMirror,
  buildQuotaMirrorPayload,
  parseAgyCliUsageWindows,
  parseStrictCliVersionOutput,
  normalizeResetTime,
  outputShowsModelTurn,
  outputLooksSignedOut,
  buildUsageCliEnv,
  compareSemver,
  resolveT3Paths,
  readT3EnvironmentId,
  resolveManagedAgyBinary,
  resolveAgyInstances,
  checkAgyCliQuotaEnabled,
  assertNoSymlinkSegments,
};
