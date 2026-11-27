"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const hostSettings = require("./hub-host-settings.cjs");
const mcpRouter = require("./mcp-router.cjs");

const CONFIG_VERSION = 1;
const ACCESS_FILE = "memory-access.json";
const RUNTIME_HINTS_FILE = "t3-runtime-hints.json";
const RUNTIME_HINTS_SCOPE = "t3-code-only";
const RUNTIME_HINTS_MAX_LENGTH = 2000;
const RUNTIME_HINTS_MAX_BYTES = 32 * 1024;
const RUNTIME_HINTS_LOCK_FILE = ".t3-runtime-hints.lock.sqlite";
const RUNTIME_HINTS_LOCK_TIMEOUT_MS = 3000;
const RUNTIME_HINTS_STRICT_READ = Object.freeze({ rejectUnsafeMode: true, strictUtf8: true });
const RUNTIME_HINTS_TRUNCATED_TOOLS = Object.freeze([
  "delegate_task",
  "html_render",
  "t3_thread_launch",
  "schedule_task",
  "t3_project_update",
]);
const DEFAULT_T3_RUNTIME_HINTS = Object.freeze({
  version: CONFIG_VERSION,
  enabled: true,
  scope: RUNTIME_HINTS_SCOPE,
  planUpdateHint: "仅 T3 Code 顶层主会话执行 >=3 步复杂多步任务时，开干前及关键阶段变化时顺手调一次 plan_update(title, steps:[{text,status}])（status 用 pending|in_progress|completed）点亮顶栏蓝环进度；简单问答、<=2 步小活及所有子代理不调。",
  acp48kFallbackHint: "若 antigravity-acp 因 48KiB 上限截断 t3-code 原生工具（delegate_task / html_render / t3_thread_launch / schedule_task / t3_project_update），必须以单条直连命令直接执行 ELECTRON_RUN_AS_NODE=1 \"$T3_ACP_MCP_NODE\" ${T3_ACP_MCP_ENTRYPOINT:+\"$T3_ACP_MCP_ENTRYPOINT\"} acp-mcp-call <tool> '<json>'（严禁外包 node -e / python3 / 脚本套壳或尾部串联其他命令，否则 T3 正则失配、html_render 不会内嵌卡片；按需读 <appDataDir>/mcp/t3-code/<tool>.json 核对参数）。",
});
const SUMMARY_STATES = ["configured", "missing", "conflict", "unsupported", "unknown", "pending"];
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const MEMORY_ONLY_ARGS = ["--memory-only"];
const HUB_NAMES = ["t3_hub", "t3-hub"];
const DRIVER_HOSTS = Object.freeze({
  codex: "codex",
  muse: "muse",
  antigravity: "antigravity",
  opencode: "opencode",
  devin: "devin",
  claudeagent: "claude",
  claude: "claude",
});
function resolveTargetHost(target) {
  const driver = String(target?.driver || "").toLowerCase();
  if (DRIVER_HOSTS[driver]) return DRIVER_HOSTS[driver];
  if (driver === "acpregistry") {
    const agentId = String(target?.config?.agentId || "").trim().toLowerCase();
    const instanceId = String(target?.instanceId || "").trim().toLowerCase();
    if (agentId === "devin" || instanceId === "acpregistry_devin") return "devin";
  }
  return null;
}

function isPlainObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function hasInvalidToggle(entry) {
  return Object.prototype.hasOwnProperty.call(entry, "enabled") && typeof entry.enabled !== "boolean" ||
    Object.prototype.hasOwnProperty.call(entry, "disabled") && typeof entry.disabled !== "boolean";
}
function normHubName(value) { return String(value || "").trim().toLowerCase(); }
function isHubName(value) { return HUB_NAMES.includes(normHubName(value)); }
function safeReason(value) { return String(value || "unknown").replace(/[^a-z0-9_-]/gi, "_").slice(0, 48) || "unknown"; }
function within(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));
}
function isTrustedMacAlias(target) {
  const expected = target === "/tmp" ? "/private/tmp" : target === "/var" ? "/private/var" : null;
  if (!expected) return false;
  try { return fs.realpathSync(target) === expected; } catch { return false; }
}
function isDirectoryEntry(target, stat) {
  if (stat.isDirectory()) return true;
  if (!stat.isSymbolicLink() || !isTrustedMacAlias(target)) return false;
  try { return fs.statSync(target).isDirectory(); } catch { return false; }
}
function assertNoSymlinkPath(target, { allowMissing = true, includeTarget = true } = {}) {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  const limit = includeTarget ? parts.length : Math.max(0, parts.length - 1);
  for (let i = 0; i < limit; i += 1) {
    current = path.join(current, parts[i]);
    let st;
    try { st = fs.lstatSync(current); }
    catch (error) {
      if (error?.code === "ENOENT" && allowMissing) break;
      throw error;
    }
    if (st.isSymbolicLink() && !isTrustedMacAlias(current)) throw new Error("unsafe_symlink");
    if (i < limit - 1 && !isDirectoryEntry(current, st)) throw new Error("unsafe_path");
  }
  return absolute;
}
function ensureDirectory(target, mode = 0o700) {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let st = lstatOptional(current);
    if (!st) {
      try { fs.mkdirSync(current, { mode }); }
      catch (error) { if (error?.code !== "EEXIST") throw error; }
      st = lstatOptional(current);
    }
    if (!st || (st.isSymbolicLink() && !isTrustedMacAlias(current)) || !isDirectoryEntry(current, st)) throw new Error("unsafe_directory");
  }
  return absolute;
}
function lstatOptional(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}
const STRICT_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function readRegular(file, maxBytes = MAX_CONFIG_BYTES, { rejectUnsafeMode = false, strictUtf8 = false } = {}) {
  assertNoSymlinkPath(file, { includeTarget: true });
  const st = lstatOptional(file);
  if (!st) return { exists: false, text: "", mode: null };
  if (st.isSymbolicLink() || !st.isFile()) throw new Error("unsafe_file");
  if (st.size > maxBytes) throw new Error("file_too_large");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== st.dev || opened.ino !== st.ino) throw new Error("file_changed");
    const mode = opened.mode & 0o777;
    if (rejectUnsafeMode && (mode & 0o022) !== 0) throw new Error("unsafe_permissions");
    if (opened.size > maxBytes) throw new Error("file_too_large");
    const buf = fs.readFileSync(fd);
    if (buf.length > maxBytes) throw new Error("file_too_large");
    let text;
    if (strictUtf8) {
      try { text = STRICT_UTF8_DECODER.decode(buf); } catch { throw new Error("invalid_utf8"); }
    } else {
      text = buf.toString("utf8");
    }
    return { exists: true, text, mode };
  } finally { fs.closeSync(fd); }
}
function atomicWrite(file, text, { backup = true, mode = 0o600, expectedText, preserveMode = true, readOptions = {} } = {}) {
  assertNoSymlinkPath(path.dirname(file), { includeTarget: true });
  const before = readRegular(file, MAX_CONFIG_BYTES, readOptions);
  if (expectedText !== undefined && before.text !== expectedText) throw new Error("concurrent_change");
  if (before.exists && backup) {
    const backupPath = file + ".t3hub.bak";
    const priorBackup = lstatOptional(backupPath);
    if (priorBackup && (priorBackup.isSymbolicLink() || !priorBackup.isFile())) throw new Error("unsafe_backup");
    if (!priorBackup) {
      const sourceFd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      let backupFd = null;
      try {
        const opened = fs.fstatSync(sourceFd);
        if (!opened.isFile()) throw new Error("unsafe_file");
        backupFd = fs.openSync(backupPath, "wx", 0o600);
        const buf = Buffer.alloc(64 * 1024);
        let pos = 0;
        while (true) {
          const n = fs.readSync(sourceFd, buf, 0, buf.length, pos);
          if (!n) break;
          fs.writeSync(backupFd, buf, 0, n);
          pos += n;
        }
        fs.fsyncSync(backupFd);
        fs.fchmodSync(backupFd, 0o600);
      } finally {
        try { if (backupFd !== null) fs.closeSync(backupFd); } catch {}
        fs.closeSync(sourceFd);
      }
    }
  }
  const temp = file + `.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  let fd = null;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, text, "utf8");
    fs.fsyncSync(fd);
    fs.fchmodSync(fd, preserveMode ? before.mode ?? mode : mode);
    fs.closeSync(fd); fd = null;
    // Recheck the destination immediately before publish. Rename replaces a
    // symlink itself; it never follows a raced final-component symlink.
    assertNoSymlinkPath(path.dirname(file), { includeTarget: true });
    const current = lstatOptional(file);
    if (current?.isSymbolicLink() || (current && !current.isFile())) throw new Error("unsafe_file");
    if (expectedText !== undefined) {
      const latest = readRegular(file, MAX_CONFIG_BYTES, readOptions);
      if (latest.text !== expectedText) throw new Error("concurrent_change");
    }
    fs.renameSync(temp, file);
    try { fs.chmodSync(file, preserveMode ? before.mode ?? mode : mode); } catch {}
  } finally {
    try { if (fd !== null) fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(temp); } catch {}
  }
}
function copyStatus(status) {
  const code = status && status.code ? safeReason(status.code) : "unknown";
  return { status: SUMMARY_STATES.includes(status?.status) ? status.status : "unknown", reason: code };
}

function createMemoryAccessManager(options = {}) {
  const homeDir = path.resolve(options.homeDir || process.env.HOME || os.homedir());
  const hubDir = path.resolve(options.hubDir || process.env.T3_HUB_DIR || path.join(homeDir, ".t3", "hub"));
  const userDataDir = path.resolve(options.userDataDir || process.env.T3CODE_HOME || path.join(homeDir, ".t3", "userdata"));
  const settingsPath = path.join(userDataDir, "settings.json");
  const magpiePath = path.join(homeDir, ".config", "magpie", "library.json");
  const configPath = path.join(hubDir, ACCESS_FILE);
  const runtimeHintsPath = path.join(hubDir, RUNTIME_HINTS_FILE);
  const runtimeHintsLockPath = path.join(hubDir, RUNTIME_HINTS_LOCK_FILE);
  const routerBin = path.resolve(options.routerBin || path.join(homeDir, ".t3", "bin", "t3-mcp-router"));
  const vaultDir = path.resolve(options.vaultDir || process.env.T3_MEMORY_VAULT_DIR || process.env.T3_HUB_MEMORY_DIR || path.join(hubDir, "memory"));
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const watcherPollMs = Number.isInteger(options.watcherPollMs) && options.watcherPollMs >= 25 ? options.watcherPollMs : 60_000;

  function resolveConfigHome() {
    const rawXdg = options.xdgConfigHome
      || (path.resolve(homeDir) === path.resolve(os.homedir()) && process.env.XDG_CONFIG_HOME ? process.env.XDG_CONFIG_HOME : "");
    if (typeof rawXdg === "string" && rawXdg.trim() && path.isAbsolute(rawXdg.trim())) {
      const candidate = path.resolve(rawXdg.trim());
      if (within(homeDir, candidate)) {
        try {
          assertNoSymlinkPath(candidate, { includeTarget: true });
          return candidate;
        } catch {}
      }
    }
    return path.join(homeDir, ".config");
  }

  function readAccess() {
    try {
      const file = readRegular(configPath, 16 * 1024);
      if (!file.exists) return { ok: true, enabled: true, state: "enabled", persisted: false, legacyDefault: true, revision: "missing" };
      let config;
      try { config = JSON.parse(file.text); } catch { return { ok: false, enabled: null, state: "unknown", persisted: true, legacyDefault: false, revision: "invalid" }; }
      if (!isPlainObject(config) || config.version !== CONFIG_VERSION || typeof config.enabled !== "boolean") {
        return { ok: false, enabled: null, state: "unknown", persisted: true, legacyDefault: false, revision: "invalid" };
      }
      return {
        ok: true, enabled: config.enabled, state: config.enabled ? "enabled" : "disabled", persisted: true,
        legacyDefault: false, revision: crypto.createHash("sha256").update(file.text).digest("hex"),
      };
    } catch {
      return { ok: false, enabled: null, state: "unknown", persisted: true, legacyDefault: false, revision: "unsafe" };
    }
  }

  function parseRuntimeHintsFile(file) {
    if (!file.exists) {
      return {
        trusted: true,
        exists: false,
        corrupted: false,
        fallback: false,
        warning: null,
        enabled: DEFAULT_T3_RUNTIME_HINTS.enabled,
        planUpdateHint: DEFAULT_T3_RUNTIME_HINTS.planUpdateHint,
        acp48kFallbackHint: DEFAULT_T3_RUNTIME_HINTS.acp48kFallbackHint,
        updatedAt: null,
      };
    }
    if (typeof file.mode === "number" && (file.mode & 0o022) !== 0) {
      return {
        trusted: false,
        exists: true,
        corrupted: true,
        fallback: true,
        warning: "unsafe_permissions",
        enabled: false,
        planUpdateHint: "",
        acp48kFallbackHint: "",
        updatedAt: null,
      };
    }
    let doc;
    try { doc = JSON.parse(file.text); }
    catch {
      return {
        trusted: false,
        exists: true,
        corrupted: true,
        fallback: true,
        warning: "invalid_json",
        enabled: false,
        planUpdateHint: "",
        acp48kFallbackHint: "",
        updatedAt: null,
      };
    }
    if (
      !isPlainObject(doc) ||
      doc.version !== CONFIG_VERSION ||
      typeof doc.enabled !== "boolean" ||
      (doc.scope !== undefined && doc.scope !== RUNTIME_HINTS_SCOPE) ||
      typeof doc.planUpdateHint !== "string" ||
      doc.planUpdateHint.includes("\0") ||
      doc.planUpdateHint.length > RUNTIME_HINTS_MAX_LENGTH ||
      typeof doc.acp48kFallbackHint !== "string" ||
      doc.acp48kFallbackHint.includes("\0") ||
      doc.acp48kFallbackHint.length > RUNTIME_HINTS_MAX_LENGTH
    ) {
      return {
        trusted: false,
        exists: true,
        corrupted: true,
        fallback: true,
        warning: "invalid_schema",
        enabled: false,
        planUpdateHint: "",
        acp48kFallbackHint: "",
        updatedAt: null,
      };
    }
    return {
      trusted: true,
      exists: true,
      corrupted: false,
      fallback: false,
      warning: null,
      enabled: doc.enabled,
      planUpdateHint: doc.planUpdateHint,
      acp48kFallbackHint: doc.acp48kFallbackHint,
      updatedAt: typeof doc.updatedAt === "string" && doc.updatedAt.trim() ? doc.updatedAt.trim() : null,
    };
  }

  function formatRuntimeHintsState(parsed) {
    const isDefault =
      parsed.trusted === true &&
      parsed.enabled === DEFAULT_T3_RUNTIME_HINTS.enabled &&
      parsed.planUpdateHint === DEFAULT_T3_RUNTIME_HINTS.planUpdateHint &&
      parsed.acp48kFallbackHint === DEFAULT_T3_RUNTIME_HINTS.acp48kFallbackHint;
    return {
      ok: true,
      trusted: parsed.trusted === true,
      version: CONFIG_VERSION,
      enabled: parsed.trusted === true ? parsed.enabled : false,
      scope: RUNTIME_HINTS_SCOPE,
      planUpdateHint: parsed.planUpdateHint,
      acp48kFallbackHint: parsed.acp48kFallbackHint,
      updatedAt: parsed.updatedAt,
      persisted: parsed.exists === true && parsed.trusted === true,
      isDefault,
      fallback: parsed.fallback === true,
      corrupted: parsed.corrupted === true,
      ...(parsed.warning ? { warning: parsed.warning } : {}),
      maxLength: RUNTIME_HINTS_MAX_LENGTH,
      defaults: {
        planUpdateHint: DEFAULT_T3_RUNTIME_HINTS.planUpdateHint,
        acp48kFallbackHint: DEFAULT_T3_RUNTIME_HINTS.acp48kFallbackHint,
      },
    };
  }

  function getT3RuntimeHints() {
    try {
      const file = readRegular(runtimeHintsPath, RUNTIME_HINTS_MAX_BYTES, RUNTIME_HINTS_STRICT_READ);
      return formatRuntimeHintsState(parseRuntimeHintsFile(file));
    } catch (error) {
      return formatRuntimeHintsState({
        trusted: false,
        exists: true,
        corrupted: true,
        fallback: true,
        warning: safeReason(error?.message) || "runtime_hints_untrusted",
        enabled: false,
        planUpdateHint: "",
        acp48kFallbackHint: "",
        updatedAt: null,
      });
    }
  }

  function sleepSyncMs(ms) {
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {}
  }

  function isSqliteBusy(error) {
    return error?.errcode === 5 || error?.errcode === 6 || /database is (locked|busy)/i.test(String(error?.message || ""));
  }

  function prepareRuntimeHintsLockFile() {
    ensureDirectory(hubDir, 0o700);
    assertNoSymlinkPath(hubDir, { includeTarget: true });
    const existing = lstatOptional(runtimeHintsLockPath);
    if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw new Error("unsafe_lock_file");
    const fd = fs.openSync(
      runtimeHintsLockPath,
      fs.constants.O_RDWR | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.nlink !== 1) throw new Error("unsafe_lock_file");
      if ((opened.mode & 0o077) !== 0) fs.fchmodSync(fd, 0o600);
      return opened;
    } finally { fs.closeSync(fd); }
  }

  // Cross-process mutex backed by SQLite's POSIX advisory lock (BEGIN IMMEDIATE).
  // The kernel drops the lock when the holder exits, so a live holder can never be
  // pre-empted by lock age; waiters give up at a strict wall-clock deadline.
  function withRuntimeHintsLock(fn, timeoutMs = RUNTIME_HINTS_LOCK_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    const lockStat = prepareRuntimeHintsLockFile();
    const { DatabaseSync } = require("node:sqlite");
    let db = null, locked = false;
    try {
      db = new DatabaseSync(runtimeHintsLockPath, { timeout: 0 });
      const current = lstatOptional(runtimeHintsLockPath);
      if (!current || current.isSymbolicLink() || !current.isFile() || current.dev !== lockStat.dev || current.ino !== lockStat.ino) {
        throw new Error("unsafe_lock_file");
      }
      // SQLite's own busy handler can overshoot coarse sleeps; poll against our deadline instead.
      db.exec("PRAGMA busy_timeout = 0");
      let attempts = 0;
      while (!locked) {
        if (attempts > 0 && Date.now() >= deadline) throw new Error("lock_timeout");
        attempts += 1;
        try {
          db.exec("BEGIN IMMEDIATE");
          if (attempts > 1 && Date.now() >= deadline) {
            try { db.exec("ROLLBACK"); } catch {}
            throw new Error("lock_timeout");
          }
          locked = true;
        } catch (error) {
          if (!isSqliteBusy(error)) throw error;
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw new Error("lock_timeout");
          sleepSyncMs(Math.min(10, remaining));
        }
      }
      return fn();
    } finally {
      if (locked) { try { db.exec("ROLLBACK"); } catch {} }
      try { db?.close(); } catch {}
    }
  }

  function setT3RuntimeHints(payload = {}) {
    if (payload != null && !isPlainObject(payload)) {
      return { ok: false, error: "invalid_payload", hints: getT3RuntimeHints() };
    }
    const input = payload || {};
    if (input.reset !== undefined && typeof input.reset !== "boolean") {
      return { ok: false, error: "reset_must_be_boolean", hints: getT3RuntimeHints() };
    }
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
      return { ok: false, error: "enabled_must_be_boolean", hints: getT3RuntimeHints() };
    }
    for (const field of ["planUpdateHint", "acp48kFallbackHint"]) {
      if (input[field] === undefined) continue;
      if (typeof input[field] !== "string") {
        return { ok: false, error: `${field}_must_be_string`, hints: getT3RuntimeHints() };
      }
      if (input[field].includes("\0")) {
        return { ok: false, error: `${field}_invalid_char`, hints: getT3RuntimeHints() };
      }
      if (input[field].length > RUNTIME_HINTS_MAX_LENGTH) {
        return { ok: false, error: `${field}_too_long`, maxLength: RUNTIME_HINTS_MAX_LENGTH, hints: getT3RuntimeHints() };
      }
    }
    const isReset = input.reset === true;
    const hasEnabled = input.enabled !== undefined;
    const hasPlan = input.planUpdateHint !== undefined;
    const hasAcp = input.acp48kFallbackHint !== undefined;
    try {
      return withRuntimeHintsLock(() => {
        const before = isReset
          ? readRegular(runtimeHintsPath, MAX_CONFIG_BYTES)
          : readRegular(runtimeHintsPath, RUNTIME_HINTS_MAX_BYTES, RUNTIME_HINTS_STRICT_READ);
        const parsed = parseRuntimeHintsFile(before);
        if (!isReset && !parsed.trusted) {
          return { ok: false, error: parsed.warning || "runtime_hints_untrusted", hints: formatRuntimeHintsState(parsed) };
        }
        const documentObj = {
          version: CONFIG_VERSION,
          enabled: isReset ? DEFAULT_T3_RUNTIME_HINTS.enabled : hasEnabled ? input.enabled : parsed.enabled,
          scope: RUNTIME_HINTS_SCOPE,
          planUpdateHint: isReset
            ? DEFAULT_T3_RUNTIME_HINTS.planUpdateHint
            : hasPlan ? input.planUpdateHint.trim() : parsed.planUpdateHint,
          acp48kFallbackHint: isReset
            ? DEFAULT_T3_RUNTIME_HINTS.acp48kFallbackHint
            : hasAcp ? input.acp48kFallbackHint.trim() : parsed.acp48kFallbackHint,
          updatedAt: new Date(now()).toISOString(),
        };
        atomicWrite(runtimeHintsPath, JSON.stringify(documentObj, null, 2) + "\n", {
          backup: false,
          mode: 0o600,
          preserveMode: false,
          expectedText: before.text,
          readOptions: isReset ? {} : RUNTIME_HINTS_STRICT_READ,
        });
        const after = getT3RuntimeHints();
        if (!after.persisted || !after.trusted || after.fallback) {
          return { ok: false, error: "readback_failed", hints: after };
        }
        return { ...after, ok: true };
      });
    } catch (error) {
      return { ok: false, error: safeReason(error?.message), hints: getT3RuntimeHints() };
    }
  }

  function readTrustedSettings() {
    try {
      const file = readRegular(settingsPath, MAX_CONFIG_BYTES);
      if (!file.exists) return { state: "unknown", reason: "settings_missing", targets: [] };
      let settings;
      try { settings = JSON.parse(file.text); } catch { return { state: "unknown", reason: "settings_invalid", targets: [] }; }
      if (!isPlainObject(settings) || !isPlainObject(settings.providerInstances)) return { state: "unknown", reason: "provider_map_invalid", targets: [] };
      const targets = [];
      const instances = settings.providerInstances;
      const selectedIds = new Set(["defaultModelSelection", "fallbackModelSelection"]
        .map((name) => settings[name]?.instanceId)
        .filter((value) => typeof value === "string" && value.trim()));
      for (const [instanceId, value] of Object.entries(instances)) {
        if (!isPlainObject(value)) {
          if (selectedIds.has(instanceId)) targets.push({ instanceId: safeReason(instanceId), displayName: "T3 Agent", driver: "unknown", state: "unknown", reason: "provider_invalid" });
          continue;
        }
        const driverLower = String(value.driver || "").toLowerCase();
        const isClaudeEntry = instanceId === "claudeAgent" || driverLower === "claudeagent" || driverLower === "claude";
        const rawConfig = isPlainObject(value.config) ? value.config : {};
        const configInvalid = isClaudeEntry && Object.prototype.hasOwnProperty.call(value, "config") && value.config !== undefined && !isPlainObject(value.config);
        const envExtra = Object.prototype.hasOwnProperty.call(value, "environment") ? { environment: value.environment } : {};
        if (value.enabled === false || (isClaudeEntry && rawConfig.enabled === false)) {
          if (selectedIds.has(instanceId)) targets.push({ instanceId, displayName: safeLabel(value.displayName || instanceId), driver: String(value.driver || ""), state: "unknown", reason: "selected_provider_disabled" });
          continue;
        }
        if (value.enabled !== true) {
          if (instanceId === "codex" && selectedIds.has(instanceId) && driverLower === "codex") {
            targets.push({ instanceId, displayName: safeLabel(value.displayName || "Codex"), driver: "codex", config: rawConfig, implicit: true });
          } else if (isClaudeEntry && value.enabled === undefined && selectedIds.has(instanceId)) {
            const effectiveDriver = driverLower === "claude" ? "claude" : "claudeAgent";
            targets.push({ instanceId, displayName: safeLabel(value.displayName || "Claude"), driver: effectiveDriver, config: rawConfig, configInvalid, ...envExtra, implicit: true });
          } else if (selectedIds.has(instanceId)) {
            targets.push({ instanceId: safeReason(instanceId), displayName: safeLabel(value.displayName), driver: safeReason(value.driver), state: "unknown", reason: "enabled_state_unknown" });
          }
          continue;
        }
        targets.push({ instanceId, displayName: safeLabel(value.displayName || instanceId), driver: typeof value.driver === "string" ? value.driver : "", config: rawConfig, ...(isClaudeEntry ? { configInvalid } : {}), ...envExtra, implicit: false });
      }
      for (const selectionName of ["defaultModelSelection", "fallbackModelSelection"]) {
        const instanceId = settings[selectionName]?.instanceId;
        if (typeof instanceId !== "string" || !instanceId.trim()) continue;
        if (Object.prototype.hasOwnProperty.call(instances, instanceId)) {
          if (!targets.some((target) => target.instanceId === instanceId)) targets.push({ instanceId: safeReason(instanceId), displayName: safeLabel(instanceId), driver: "unknown", state: "unknown", reason: "selected_provider_disabled" });
          continue;
        }
        if (instanceId === "codex") targets.push({ instanceId: "codex", displayName: "Codex", driver: "codex", config: {}, implicit: true });
        else if (instanceId === "claudeAgent") targets.push({ instanceId: "claudeAgent", displayName: "Claude", driver: "claudeAgent", config: {}, implicit: true });
        else targets.push({ instanceId, displayName: safeLabel(instanceId), driver: "", config: {}, implicit: true, unknownSelection: true });
      }
      const deduped = new Map();
      for (const target of targets) deduped.set(target.instanceId, target);
    return { state: "ok", reason: null, targets: [...deduped.values()] };
    } catch {
      return { state: "unknown", reason: "settings_unsafe", targets: [] };
    }
  }

  function safeLabel(value) {
    const label = typeof value === "string" ? value.trim() : "";
    return label ? label.replace(/[\r\n\0]/g, " ").slice(0, 64) : "T3 Agent";
  }

  function readMagpieOwnership() {
    try {
      const file = readRegular(magpiePath, MAX_CONFIG_BYTES);
      if (!file.exists) return { state: "missing", hosts: new Set(), hubStatus: new Map() };
      let library;
      try { library = JSON.parse(file.text); } catch { return { state: "unknown", hosts: new Set(), hubStatus: new Map() }; }
      if (!isPlainObject(library) || library.mcp != null && !Array.isArray(library.mcp)) return { state: "unknown", hosts: new Set(), hubStatus: new Map() };
      const hosts = new Set();
      const hubStatus = new Map();
      for (const entry of library.mcp || []) {
        if (!isPlainObject(entry)) return { state: "unknown", hosts: new Set(), hubStatus: new Map() };
        if (entry.agents == null) continue;
        if (!Array.isArray(entry.agents) || !entry.agents.every(value => typeof value === "string")) return { state: "unknown", hosts: new Set(), hubStatus: new Map() };
        const entryIsHub = isHubName(entry.name);
        const identity = entryIsHub && !hasInvalidToggle(entry) && entry.enabled !== false && entry.disabled !== true
          ? routerCommand(entry.command, entry.args, routerBin)
          : { ok: false };
        for (const agent of entry.agents) {
          const host = agent.trim().toLowerCase();
          hosts.add(host);
          if (!entryIsHub) continue;
          const next = identity.ok ? "configured" : "conflict";
          if (hubStatus.has(host)) hubStatus.set(host, "conflict");
          else hubStatus.set(host, next);
        }
      }
      return { state: "ok", hosts, hubStatus };
    } catch { return { state: "unknown", hosts: new Set(), hubStatus: new Map() }; }
  }

  function validateClaudeHomePath(raw) {
    const trimmed = raw.trim();
    const expanded = trimmed === "~" ? homeDir : trimmed.startsWith("~/") ? path.join(homeDir, trimmed.slice(2)) : trimmed;
    if (!path.isAbsolute(expanded)) return { ok: false, status: "unknown", reason: "claude_home_not_absolute", file: null, format: null, customConfigDir: true };
    const claudeHome = path.resolve(expanded);
    if (!within(homeDir, claudeHome)) return { ok: false, status: "unknown", reason: "claude_home_outside_home", file: null, format: null, customConfigDir: true };
    let dirStat;
    try {
      assertNoSymlinkPath(claudeHome, { includeTarget: true });
      dirStat = lstatOptional(claudeHome);
    } catch {
      return { ok: false, status: "unknown", reason: "claude_home_unsafe", file: null, format: null, customConfigDir: true };
    }
    const targetFile = path.join(claudeHome, ".claude.json");
    if (!dirStat) return { ok: false, status: "pending", reason: "claude_home_not_ready", file: targetFile, format: "claude-json", customConfigDir: true };
    if (!isDirectoryEntry(claudeHome, dirStat)) return { ok: false, status: "unknown", reason: "claude_home_unsafe", file: null, format: null, customConfigDir: true };
    return { ok: true, file: targetFile, customConfigDir: true };
  }

  function extractClaudeConfigDirFromEnv(envValue) {
    if (envValue === undefined) return { invalid: false, state: "absent", value: "" };
    if (Array.isArray(envValue)) {
      let seen = false;
      let matched = "";
      for (const item of envValue) {
        if (!isPlainObject(item)) return { invalid: true, state: "absent", value: "" };
        if (item.name === "CLAUDE_CONFIG_DIR") {
          if (typeof item.value !== "string") return { invalid: true, state: "absent", value: "" };
          seen = true;
          matched = item.value.trim();
        }
      }
      if (!seen) return { invalid: false, state: "absent", value: "" };
      return matched
        ? { invalid: false, state: "set", value: matched }
        : { invalid: false, state: "cleared", value: "" };
    }
    if (isPlainObject(envValue)) {
      if (Object.prototype.hasOwnProperty.call(envValue, "CLAUDE_CONFIG_DIR")) {
        const val = envValue.CLAUDE_CONFIG_DIR;
        if (val === undefined) return { invalid: false, state: "absent", value: "" };
        if (typeof val !== "string") return { invalid: true, state: "absent", value: "" };
        const trimmed = val.trim();
        return trimmed
          ? { invalid: false, state: "set", value: trimmed }
          : { invalid: false, state: "cleared", value: "" };
      }
      return { invalid: false, state: "absent", value: "" };
    }
    return { invalid: true, state: "absent", value: "" };
  }

  function resolveClaudeHome(target) {
    if (target.configInvalid) {
      return { ok: false, status: "unknown", reason: "claude_home_invalid", file: null, format: null, customConfigDir: false };
    }
    const config = isPlainObject(target.config) ? target.config : {};
    if (Object.prototype.hasOwnProperty.call(config, "homePath") && config.homePath !== undefined) {
      if (typeof config.homePath !== "string") {
        return { ok: false, status: "unknown", reason: "claude_home_invalid", file: null, format: null, customConfigDir: true };
      }
      const trimmedHome = config.homePath.trim();
      if (trimmedHome) return validateClaudeHomePath(trimmedHome);
    }
    const envSource = Object.prototype.hasOwnProperty.call(target, "environment") ? target.environment : undefined;
    const extracted = extractClaudeConfigDirFromEnv(envSource);
    if (extracted.invalid) {
      return { ok: false, status: "unknown", reason: "claude_home_invalid", file: null, format: null, customConfigDir: true };
    }
    if (extracted.state === "set") return validateClaudeHomePath(extracted.value);
    if (extracted.state === "cleared") {
      return { ok: true, file: path.join(homeDir, ".claude.json"), customConfigDir: false };
    }
    let rawHostDir = "";
    if (options.claudeConfigDir !== undefined) {
      if (typeof options.claudeConfigDir !== "string") {
        return { ok: false, status: "unknown", reason: "claude_home_invalid", file: null, format: null, customConfigDir: true };
      }
      rawHostDir = options.claudeConfigDir.trim();
    }
    if (!rawHostDir && path.resolve(homeDir) === path.resolve(os.homedir()) && process.env.CLAUDE_CONFIG_DIR) {
      rawHostDir = String(process.env.CLAUDE_CONFIG_DIR).trim();
    }
    if (rawHostDir) return validateClaudeHomePath(rawHostDir);
    return { ok: true, file: path.join(homeDir, ".claude.json"), customConfigDir: false };
  }

  function detectTarget(target, magpie) {
    const driver = String(target.driver || "").toLowerCase();
    if (target.state === "unknown") return { target, status: "unknown", reason: target.reason || "provider_invalid", file: null, format: null, managedByMagpie: false };
    if (target.unknownSelection) return { target, status: "unsupported", reason: "unknown_default_provider", file: null, format: null, managedByMagpie: false };
    const host = resolveTargetHost(target);
    if (!host) return { target, status: "unsupported", reason: driver ? "unsupported_driver" : "driver_missing", file: null, format: null, managedByMagpie: false };
    let file, format, customConfigDir = false;
    if (host === "codex") {
      let codexHome = path.join(homeDir, ".codex");
      if (Object.prototype.hasOwnProperty.call(target.config || {}, "homePath")) {
        const raw = target.config.homePath;
        if (typeof raw !== "string" || !raw.trim()) return { target, status: "unknown", reason: "codex_home_invalid", file: null, format: null, managedByMagpie: false };
        const expanded = raw.trim() === "~" ? homeDir : raw.trim().startsWith("~/") ? path.join(homeDir, raw.trim().slice(2)) : raw.trim();
        if (!path.isAbsolute(expanded)) return { target, status: "unknown", reason: "codex_home_not_absolute", file: null, format: null, managedByMagpie: false };
        codexHome = path.resolve(expanded);
        if (!within(homeDir, codexHome)) return { target, status: "unknown", reason: "codex_home_outside_home", file: null, format: null, managedByMagpie: false };
        try { assertNoSymlinkPath(codexHome, { includeTarget: true }); } catch { return { target, status: "unknown", reason: "codex_home_unsafe", file: null, format: null, managedByMagpie: false }; }
      }
      file = path.join(codexHome, "config.toml"); format = "toml";
    } else if (host === "claude") {
      const resolved = resolveClaudeHome(target);
      customConfigDir = Boolean(resolved.customConfigDir);
      if (!resolved.ok) {
        return { target, status: resolved.status, reason: resolved.reason, file: resolved.file, format: resolved.format, managedByMagpie: false, customConfigDir };
      }
      file = resolved.file;
      format = "claude-json";
    } else if (host === "muse") {
      file = path.join(resolveConfigHome(), "muse", "settings.json"); format = "json";
    } else if (host === "opencode") {
      const ocDir = path.join(resolveConfigHome(), "opencode");
      const jsonFile = path.join(ocDir, "opencode.json");
      const jsoncFile = path.join(ocDir, "opencode.jsonc");
      try {
        const hasJson = Boolean(lstatOptional(jsonFile));
        const hasJsonc = Boolean(lstatOptional(jsoncFile));
        if (!hasJson && hasJsonc) {
          return { target, status: "pending", reason: "opencode_jsonc_manual", file: jsoncFile, format: "opencode-json", managedByMagpie: false };
        }
      } catch {
        return { target, status: "unknown", reason: "target_unreadable", file: null, format: null, managedByMagpie: false };
      }
      file = jsonFile; format = "opencode-json";
    } else if (host === "devin") {
      file = path.join(resolveConfigHome(), "devin", "mcp_config.json"); format = "json";
    } else {
      const profileId = crypto.createHash("sha256").update(target.instanceId, "utf8").digest("hex");
      const profileDir = path.join(userDataDir, "providers", "antigravity", profileId);
      const configDir = path.join(profileDir, "config");
      try {
        assertNoSymlinkPath(profileDir, { includeTarget: true });
        const profileStat = lstatOptional(profileDir), configStat = lstatOptional(configDir);
        if (!profileStat || !profileStat.isDirectory() || !configStat || !configStat.isDirectory()) return { target, status: "pending", reason: "agy_profile_not_ready", file: path.join(configDir, "mcp_config.json"), format: "json", managedByMagpie: false };
      } catch { return { target, status: "unknown", reason: "agy_profile_unsafe", file: null, format: null, managedByMagpie: false }; }
      file = path.join(configDir, "mcp_config.json"); format = "json";
    }
    let status = "missing", reason = "entry_missing", sourceText = "", mode = null, targetFileExists = false;
    try {
      const read = readRegular(file);
      targetFileExists = read.exists;
      if (read.exists) {
        sourceText = read.text; mode = read.mode;
        const identity = format === "claude-json"
          ? inspectClaudeJsonEntry(sourceText, routerBin)
          : format === "opencode-json"
            ? inspectOpenCodeJsonEntry(sourceText, routerBin)
            : format === "json"
              ? inspectJsonEntry(sourceText, routerBin)
              : inspectTomlEntry(sourceText, routerBin);
        status = identity.status; reason = identity.reason;
      } else if (format === "toml") {
        // Validate the existing Codex document before allowing an appended table.
        hostSettings.readTomlTable("", ["__t3_validation_probe__"], []);
      }
    } catch (error) {
      status = "unknown"; reason = safeReason(error?.message === "unsafe_symlink" ? "target_symlink" : "target_unreadable");
    }
    const managedByMagpie = magpie.state === "ok" && magpie.hosts.has(host) || magpie.state === "unknown" && host === "codex";
    if (managedByMagpie && status !== "configured") {
      if (status === "missing" && magpie.hubStatus?.get(host) === "configured") {
        return { target, status: "configured", reason: "managed_by_magpie", file, format, sourceText, mode, managedByMagpie: true, customConfigDir };
      }
      return { target, status: "pending", reason: "managed_by_magpie", underlyingStatus: status, file, format, sourceText, mode, managedByMagpie: true, customConfigDir };
    }
    if (magpie.state === "unknown" && !managedByMagpie && status === "missing") {
      return { target, status: "unknown", reason: "magpie_ownership_unknown", file, format, sourceText, mode, managedByMagpie: false, customConfigDir };
    }
    if (driver === "antigravity" && !targetFileExists) {
      return { target, status: "pending", reason: "agy_native_helper_compatibility", file, format, sourceText, mode, managedByMagpie, customConfigDir };
    }
    if (driver === "antigravity" && status === "missing") {
      let hasOtherMcp = false;
      try {
        const document = JSON.parse(sourceText);
        const servers = document.mcpServers || {};
        hasOtherMcp = isPlainObject(servers) && Object.keys(servers).some((name) => !isHubName(name));
      } catch {}
      if (!hasOtherMcp) return { target, status: "pending", reason: "agy_native_helper_compatibility", file, format, sourceText, mode, managedByMagpie, customConfigDir };
    }
    return { target, status, reason, file, format, sourceText, mode, managedByMagpie, customConfigDir };
  }

  function inspectJsonEntry(text, expectedRouter) {
    let document;
    try { document = JSON.parse(text); } catch { return { status: "unknown", reason: "json_invalid" }; }
    if (!isPlainObject(document)) return { status: "unknown", reason: "json_root_invalid" };
    if (document.servers != null) return { status: "unknown", reason: "agy_mcp_schema_unsupported" };
    if (document.mcpServers != null && !isPlainObject(document.mcpServers)) return { status: "unknown", reason: "mcp_servers_invalid" };
    const servers = document.mcpServers || {};
    const matches = Object.entries(servers).filter(([name]) => isHubName(name));
    if (!matches.length) return { status: "missing", reason: "entry_missing" };
    if (matches.length !== 1) return { status: "conflict", reason: "duplicate_hub_entries" };
    return inspectJsonRouter(matches[0][1], expectedRouter);
  }

  function inspectJsonRouter(entry, expectedRouter) {
    if (!isPlainObject(entry)) return { status: "conflict", reason: "hub_entry_invalid" };
    if (hasInvalidToggle(entry)) return { status: "unknown", reason: "hub_entry_toggle_invalid" };
    if (entry.enabled === false || entry.disabled === true) return { status: "conflict", reason: "hub_entry_disabled" };
    const keys = Object.keys(entry);
    if (keys.some(key => !["command", "args", "enabled", "disabled"].includes(key))) return { status: "conflict", reason: "hub_entry_custom_options" };
    const identity = routerCommand(entry.command, entry.args, expectedRouter);
    if (!identity.ok) return { status: "conflict", reason: identity.reason };
    return identity.memoryOnly ? { status: "configured", reason: "router_memory_only" } : { status: "configured", reason: "legacy_broad_mode" };
  }

  function inspectOpenCodeJsonEntry(text, expectedRouter) {
    let document;
    try { document = JSON.parse(text); } catch { return { status: "unknown", reason: "json_invalid" }; }
    if (!isPlainObject(document)) return { status: "unknown", reason: "json_root_invalid" };
    if (document.mcp != null && !isPlainObject(document.mcp)) return { status: "unknown", reason: "mcp_servers_invalid" };
    const servers = document.mcp || {};
    const matches = Object.entries(servers).filter(([name]) => isHubName(name));
    if (!matches.length) return { status: "missing", reason: "entry_missing" };
    if (matches.length !== 1) return { status: "conflict", reason: "duplicate_hub_entries" };
    return inspectOpenCodeRouter(matches[0][1], expectedRouter);
  }

  function inspectOpenCodeRouter(entry, expectedRouter) {
    if (!isPlainObject(entry)) return { status: "conflict", reason: "hub_entry_invalid" };
    if (hasInvalidToggle(entry)) return { status: "unknown", reason: "hub_entry_toggle_invalid" };
    if (entry.enabled === false || entry.disabled === true) return { status: "conflict", reason: "hub_entry_disabled" };
    if (entry.type != null && entry.type !== "local") return { status: "conflict", reason: "hub_entry_custom_options" };
    const keys = Object.keys(entry);
    if (keys.some(key => !["type", "command", "enabled", "disabled"].includes(key))) return { status: "conflict", reason: "hub_entry_custom_options" };
    if (!Array.isArray(entry.command) || entry.command.length < 1 || !entry.command.every(value => typeof value === "string")) {
      return { status: "conflict", reason: "hub_command_unknown" };
    }
    const identity = routerCommand(entry.command[0], entry.command.slice(1), expectedRouter);
    if (!identity.ok) return { status: "conflict", reason: identity.reason };
    return identity.memoryOnly ? { status: "configured", reason: "router_memory_only" } : { status: "configured", reason: "legacy_broad_mode" };
  }

  function scanJsonDuplicateKeys(text) {
    const len = text.length;
    let i = 0;
    const stack = [];
    let duplicateHub = false;
    let duplicateOther = false;
    let pendingKey = null;

    function skipWs() {
      while (i < len) {
        const c = text.charCodeAt(i);
        if (c === 32 || c === 9 || c === 10 || c === 13) i += 1;
        else break;
      }
    }
    function readString() {
      const start = i;
      i += 1;
      while (i < len) {
        const c = text.charCodeAt(i);
        if (c === 92) { i += 2; continue; }
        if (c === 34) { i += 1; break; }
        i += 1;
      }
      return JSON.parse(text.slice(start, i));
    }
    function skipPrimitive() {
      const start = i;
      while (i < len) {
        const c = text.charCodeAt(i);
        if (c === 32 || c === 9 || c === 10 || c === 13 || c === 44 || c === 93 || c === 125) break;
        i += 1;
      }
      if (i === start) i += 1;
    }
    function finishValue() {
      const top = stack[stack.length - 1];
      if (top) top.state = "comma_or_end";
    }

    while (true) {
      skipWs();
      if (i >= len) break;
      const top = stack[stack.length - 1];
      const ch = text[i];

      if (top && top.type === "object") {
        if (top.state === "key_or_end") {
          if (ch === "}") { i += 1; stack.pop(); finishValue(); continue; }
          const key = readString();
          if (top.keys.has(key)) {
            if (top.isMcpServers && isHubName(key)) duplicateHub = true;
            else duplicateOther = true;
          } else {
            top.keys.add(key);
          }
          if (top.isMcpServers && isHubName(key)) {
            top.hubCount += 1;
            if (top.hubCount > 1) duplicateHub = true;
          }
          pendingKey = key;
          top.state = "colon";
          continue;
        }
        if (top.state === "colon") {
          i += 1;
          top.state = "value";
          continue;
        }
        if (top.state === "comma_or_end") {
          if (ch === ",") { i += 1; top.state = "key_or_end"; continue; }
          if (ch === "}") { i += 1; stack.pop(); finishValue(); continue; }
        }
      } else if (top && top.type === "array") {
        if (top.state === "value_or_end" && ch === "]") {
          i += 1; stack.pop(); finishValue(); continue;
        }
        if (top.state === "comma_or_end") {
          if (ch === ",") { i += 1; top.state = "value_or_end"; continue; }
          if (ch === "]") { i += 1; stack.pop(); finishValue(); continue; }
        }
      }

      if (ch === "{") {
        const isMcpServers = stack.length === 1 && stack[0].type === "object" && stack[0].state === "value" && pendingKey === "mcpServers";
        pendingKey = null;
        i += 1;
        stack.push({ type: "object", state: "key_or_end", keys: new Set(), hubCount: 0, isMcpServers });
      } else if (ch === "[") {
        pendingKey = null;
        i += 1;
        stack.push({ type: "array", state: "value_or_end" });
      } else if (ch === '"') {
        pendingKey = null;
        readString();
        finishValue();
      } else {
        pendingKey = null;
        skipPrimitive();
        finishValue();
      }
    }
    return { duplicateHub, duplicateOther };
  }

  function inspectClaudeJsonEntry(text, expectedRouter) {
    let document;
    try { document = JSON.parse(text); } catch { return { status: "unknown", reason: "json_invalid" }; }
    if (!isPlainObject(document)) return { status: "unknown", reason: "json_root_invalid" };
    const dup = scanJsonDuplicateKeys(text);
    if (dup.duplicateHub) return { status: "conflict", reason: "duplicate_hub_entries" };
    if (dup.duplicateOther) return { status: "unknown", reason: "json_duplicate_keys" };
    if (document.mcpServers != null && !isPlainObject(document.mcpServers)) return { status: "unknown", reason: "mcp_servers_invalid" };
    const servers = document.mcpServers || {};
    const matches = Object.entries(servers).filter(([name]) => isHubName(name));
    if (!matches.length) return { status: "missing", reason: "entry_missing" };
    if (matches.length !== 1) return { status: "conflict", reason: "duplicate_hub_entries" };
    return inspectClaudeJsonRouter(matches[0][1], expectedRouter);
  }

  function inspectClaudeJsonRouter(entry, expectedRouter) {
    if (!isPlainObject(entry)) return { status: "conflict", reason: "hub_entry_invalid" };
    if (hasInvalidToggle(entry)) return { status: "unknown", reason: "hub_entry_toggle_invalid" };
    if (entry.enabled === false || entry.disabled === true) return { status: "conflict", reason: "hub_entry_disabled" };
    if (entry.type !== undefined && entry.type !== "stdio") return { status: "conflict", reason: "hub_entry_custom_options" };
    if (entry.env !== undefined && (!isPlainObject(entry.env) || Object.keys(entry.env).length > 0)) {
      return { status: "conflict", reason: "hub_entry_custom_options" };
    }
    const keys = Object.keys(entry);
    if (keys.some(key => !["type", "command", "args", "env", "enabled", "disabled"].includes(key))) {
      return { status: "conflict", reason: "hub_entry_custom_options" };
    }
    const identity = routerCommand(entry.command, entry.args, expectedRouter);
    if (!identity.ok) return { status: "conflict", reason: identity.reason };
    return identity.memoryOnly ? { status: "configured", reason: "router_memory_only" } : { status: "configured", reason: "legacy_broad_mode" };
  }

  function expandHomeToken(raw) {
    const s = String(raw || "");
    if (s.startsWith("$HOME/")) return path.join(homeDir, s.slice(6));
    if (s.startsWith("${HOME}/")) return path.join(homeDir, s.slice(8));
    if (s.startsWith("~/")) return path.join(homeDir, s.slice(2));
    return s;
  }

  function routerCommand(command, args, expectedRouter) {
    if (typeof command !== "string" || command.trim() === "") return { ok: false, reason: "hub_command_unknown" };
    const values = args === undefined ? [] : args;
    if (!Array.isArray(values) || !values.every(value => typeof value === "string")) return { ok: false, reason: "hub_args_unknown" };
    let isRouter = path.resolve(expandHomeToken(command)) === expectedRouter;
    let rest = values;
    if (!isRouter && /^(?:node|nodejs)(?:\.exe)?$/i.test(path.basename(command))) {
      isRouter = path.resolve(expandHomeToken(values[0] || "")) === expectedRouter;
      rest = values.slice(1);
    }
    // Accept the portable stdio shell wrapper generated by Hub UI:
    // /bin/sh -c 'exec "$HOME/.t3/bin/t3-mcp-router" --memory-only'
    if (!isRouter && path.basename(command) === "sh" && values.length === 2 && values[0] === "-c") {
      const script = values[1].trim();
      if (!/[;&|`\r\n]|\$\(/.test(script)) {
        const m = script.match(/^(?:exec\s+)?(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s+(--memory-only))?$/);
        if (m) {
          const bin = m[1] || m[2] || m[3] || "";
          if (bin && path.resolve(expandHomeToken(bin)) === expectedRouter) {
            return { ok: true, memoryOnly: m[4] === "--memory-only" };
          }
        }
      }
    }
    if (!isRouter) return { ok: false, reason: "hub_command_custom" };
    if (rest.length === 0) return { ok: true, memoryOnly: false };
    if (rest.length === 1 && rest[0] === "--memory-only") return { ok: true, memoryOnly: true };
    return { ok: false, reason: "hub_args_custom" };
  }

  function parseCodexEntry(text) {
    // readTomlTable uses the host-settings TOML lexer, so comments and fake
    // sections inside strings cannot masquerade as a managed server.
    const primary = hostSettings.readTomlTable(text, ["mcp_servers", "t3_hub"], ["command", "args", "enabled", "disabled"]);
    const alternate = hostSettings.readTomlTable(text, ["mcp_servers", "t3-hub"], ["command", "args", "enabled", "disabled"]);
    if (primary && alternate) return { present: true, conflict: true, table: null, key: null };
    if (primary) return { present: true, conflict: false, table: primary, key: "t3_hub" };
    if (alternate) return { present: true, conflict: false, table: alternate, key: "t3-hub" };
    return { present: false, table: null, key: null };
  }

  function inspectTomlEntry(text, expectedRouter) {
    // Full lexical validation is performed by scanToml via readTomlTable.
    hostSettings.readTomlTable(text, ["__t3_validation_probe__"], []);
    if (/^\s*mcp_servers\s*=/m.test(text)) return { status: "unknown", reason: "mcp_servers_root_value" };
    const parsed = parseCodexEntry(text);
    if (!parsed.present) return { status: "missing", reason: "entry_missing" };
    if (parsed.conflict) return { status: "conflict", reason: "duplicate_hub_entries" };
    const entry = parsed.table;
    if (hasInvalidToggle(entry)) return { status: "unknown", reason: "hub_entry_toggle_invalid" };
    if (entry.enabled === false || entry.disabled === true) return { status: "conflict", reason: "hub_entry_disabled" };
    const identity = routerCommand(entry.command, entry.args, expectedRouter);
    if (!identity.ok) return { status: "conflict", reason: identity.reason };
    return identity.memoryOnly ? { status: "configured", reason: "router_memory_only" } : { status: "configured", reason: "legacy_broad_mode" };
  }

  function getSetupSummary() {
    const settings = readTrustedSettings();
    const magpie = readMagpieOwnership();
    const providers = [];
    if (settings.state !== "ok") {
      providers.push({ instanceId: "t3", displayName: "T3", status: "unknown", reason: settings.reason, runtime: "unverified" });
    } else {
      for (const target of settings.targets) {
        const result = detectTarget(target, magpie);
        providers.push({
          instanceId: safeLabel(target.instanceId), displayName: safeLabel(target.displayName),
          host: resolveTargetHost(target) || null,
          customConfigDir: Boolean(result.customConfigDir),
          status: SUMMARY_STATES.includes(result.status) ? result.status : "unknown",
          reason: safeReason(result.reason), runtime: "unverified",
        });
      }
    }
    const counts = Object.fromEntries(SUMMARY_STATES.map(state => [state, providers.filter(item => item.status === state).length]));
    return { ...counts, providers, runtime: "unverified", checkedAt: new Date(now()).toISOString() };
  }

  function getAgentAccess() {
    const access = readAccess();
    return { ok: access.ok, enabled: access.enabled, state: access.state, setupSummary: getSetupSummary() };
  }

  function readMemoryOnlyStatus() {
    const access = readAccess();
    let vaultAvailable = false;
    try {
      assertNoSymlinkPath(vaultDir, { includeTarget: true });
      const dir = lstatOptional(vaultDir);
      const database = lstatOptional(path.join(vaultDir, "index.sqlite"));
      vaultAvailable = Boolean(dir && dir.isDirectory() && database && database.isFile());
    } catch {}
    return { ok: access.ok, enabled: access.enabled === true, state: access.state, serverVersion: "1", vaultAvailable };
  }

  function writeAccess(enabled) {
    if (typeof enabled !== "boolean") return { ok: false, error: "enabled must be boolean" };
    const document = JSON.stringify({ version: CONFIG_VERSION, enabled }) + "\n";
    try {
      ensureDirectory(hubDir, 0o700);
      const current = readRegular(configPath, 16 * 1024);
      atomicWrite(configPath, document, { backup: false, mode: 0o600, preserveMode: false, expectedText: current.text });
      const after = readAccess();
      if (after.state !== (enabled ? "enabled" : "disabled") || !after.persisted) return { ok: false, error: "readback_failed", access: getAgentAccess() };
      return { ok: true, access: getAgentAccess() };
    } catch (error) {
      return { ok: false, error: safeReason(error?.message), access: getAgentAccess() };
    }
  }

  function setup() {
    const saved = writeAccess(true);
    if (!saved.ok) return { ...saved, setupSummary: getSetupSummary() };
    const reconcileResult = reconcile();
    return { ok: reconcileResult.ok, enabled: true, state: "enabled", ...reconcileResult, setupSummary: getSetupSummary() };
  }

  function setAgentAccess(payload = {}) {
    const saved = writeAccess(payload.enabled);
    if (!saved.ok) return { ...saved, setupSummary: getSetupSummary() };
    if (payload.enabled === false) {
      stopProviderWatching();
      return { ok: true, enabled: false, state: "disabled", setupSummary: getSetupSummary() };
    }
    const result = reconcile();
    return { ...result, ok: true, enabled: true, state: "enabled", setupOk: result.ok, setupSummary: getSetupSummary() };
  }

  function writeOpenCodeJsonTarget(target, detected) {
    const file = detected.file;
    if (!file) throw new Error("target_unknown");
    const parent = path.dirname(file);
    const parentStat = lstatOptional(parent);
    if (!parentStat || !parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error("target_directory_missing");
    assertNoSymlinkPath(file, { includeTarget: true });
    const before = readRegular(file);
    if (detected.sourceText !== undefined && before.text !== detected.sourceText) throw new Error("concurrent_change");
    let document = {};
    if (before.exists) {
      try { document = JSON.parse(before.text); } catch { throw new Error("json_invalid"); }
      if (!isPlainObject(document)) throw new Error("json_root_invalid");
    }
    if (document.mcp != null && !isPlainObject(document.mcp)) throw new Error("mcp_servers_invalid");
    document.mcp ||= {};
    const matches = Object.keys(document.mcp).filter(isHubName);
    if (matches.length) {
      if (matches.length !== 1) throw new Error("duplicate_hub_entries");
      const current = document.mcp[matches[0]];
      const identity = inspectOpenCodeRouter(current, routerBin);
      if (!current || !isPlainObject(current) || identity.status === "conflict") throw new Error(identity.reason || "hub_entry_conflict");
      document.mcp[matches[0]] = { ...current, type: "local", command: [routerBin, ...MEMORY_ONLY_ARGS], enabled: true };
    } else {
      document.mcp.t3_hub = { type: "local", command: [routerBin, ...MEMORY_ONLY_ARGS], enabled: true };
    }
    atomicWrite(file, JSON.stringify(document, null, 2) + "\n", { backup: true, mode: 0o600, expectedText: before.text });
  }

  function writeClaudeJsonTarget(target, detected) {
    const file = detected.file;
    if (!file) throw new Error("target_unknown");
    const parent = path.dirname(file);
    const parentStat = lstatOptional(parent);
    if (!parentStat || !parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error("target_directory_missing");
    assertNoSymlinkPath(file, { includeTarget: true });
    const before = readRegular(file);
    if (detected.sourceText !== undefined && before.text !== detected.sourceText) throw new Error("concurrent_change");
    let document = {};
    if (before.exists) {
      try { document = JSON.parse(before.text); } catch { throw new Error("json_invalid"); }
      if (!isPlainObject(document)) throw new Error("json_root_invalid");
      const dup = scanJsonDuplicateKeys(before.text);
      if (dup.duplicateHub) throw new Error("duplicate_hub_entries");
      if (dup.duplicateOther) throw new Error("json_duplicate_keys");
    }
    if (document.mcpServers != null && !isPlainObject(document.mcpServers)) throw new Error("mcp_servers_invalid");
    document.mcpServers ||= {};
    const matches = Object.keys(document.mcpServers).filter(isHubName);
    if (matches.length) {
      if (matches.length !== 1) throw new Error("duplicate_hub_entries");
      const current = document.mcpServers[matches[0]];
      const identity = inspectClaudeJsonRouter(current, routerBin);
      if (!current || !isPlainObject(current) || identity.status !== "configured") throw new Error(identity.reason || "hub_entry_conflict");
      document.mcpServers[matches[0]] = { ...current, type: "stdio", args: MEMORY_ONLY_ARGS };
    } else {
      document.mcpServers.t3_hub = { type: "stdio", command: routerBin, args: MEMORY_ONLY_ARGS };
    }
    atomicWrite(file, JSON.stringify(document, null, 2) + "\n", { backup: true, mode: 0o600, preserveMode: false, expectedText: before.text });
  }

  function writeJsonTarget(target, detected) {
    const file = detected.file;
    if (!file) throw new Error("target_unknown");
    const parent = path.dirname(file);
    const parentStat = lstatOptional(parent);
    if (!parentStat || !parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error("target_directory_missing");
    assertNoSymlinkPath(file, { includeTarget: true });
    const before = readRegular(file);
    if (detected.sourceText !== undefined && before.text !== detected.sourceText) throw new Error("concurrent_change");
    let document = {};
    if (before.exists) {
      try { document = JSON.parse(before.text); } catch { throw new Error("json_invalid"); }
      if (!isPlainObject(document)) throw new Error("json_root_invalid");
    }
    if (document.mcpServers != null && !isPlainObject(document.mcpServers)) throw new Error("mcp_servers_invalid");
    document.mcpServers ||= {};
    const matches = Object.keys(document.mcpServers).filter(isHubName);
    if (matches.length) {
      if (matches.length !== 1) throw new Error("duplicate_hub_entries");
      const current = document.mcpServers[matches[0]];
      const identity = inspectJsonRouter(current, routerBin);
      if (!current || !isPlainObject(current) || identity.status === "conflict") throw new Error(identity.reason || "hub_entry_conflict");
      document.mcpServers[matches[0]] = { ...current, args: MEMORY_ONLY_ARGS };
    } else {
      document.mcpServers.t3_hub = { command: routerBin, args: MEMORY_ONLY_ARGS };
    }
    atomicWrite(file, JSON.stringify(document, null, 2) + "\n", { backup: true, mode: 0o600, expectedText: before.text });
  }

  function findTomlTargetSection(raw, key) {
    const lines = raw.split(/\r?\n/);
    const offsets = [];
    let pos = 0;
    for (const line of lines) { offsets.push(pos); pos += line.length + 1; }
    let stringMode = null, arrayDepth = 0, braceDepth = 0;
    const delimiters = [];
    let currentPath = [];
    let start = -1, end = lines.length;
    const wanted = ["mcp_servers", key];
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      const atStart = stringMode === null && arrayDepth === 0 && braceDepth === 0;
      let i = 0;
      if (atStart) {
        if (/^\s*(?:#|$)/.test(line)) continue;
        if (/^\s*\[/.test(line)) {
          const header = mcpRouter.parseTomlTableHeader(line);
          if (!header || header.isArrayTable) throw new Error("toml_section_unknown");
          currentPath = header.path;
          if (start >= 0) { end = lineIndex; break; }
          if (currentPath.length === 2 && currentPath[0] === wanted[0] && currentPath[1] === wanted[1]) start = lineIndex;
          continue;
        }
        const eq = line.indexOf("=");
        if (eq < 0) throw new Error("toml_statement_unknown");
        i = eq + 1;
      }
      while (i < line.length) {
        const c = line[i];
        if (stringMode) {
          const basic = stringMode[0] === '"';
          if (basic && c === "\\") { i += 2; continue; }
          if (stringMode.length === 3 && c === stringMode[0]) {
            let j = i; while (line[j] === c) j++;
            const count = j - i; if (count >= 3) { if (count > 5) throw new Error("toml_string_unknown"); stringMode = null; }
            i = j; continue;
          }
          if (stringMode.length === 1 && c === stringMode) stringMode = null;
          i += 1; continue;
        }
        if (c === "#") break;
        if (c === '"' || c === "'") { stringMode = line.startsWith(c.repeat(3), i) ? c.repeat(3) : c; i += stringMode.length; continue; }
        if (c === "[" || c === "{") { delimiters.push(c); if (c === "[") arrayDepth++; else braceDepth++; }
        else if (c === "]" || c === "}") { const opening = c === "]" ? "[" : "{"; if (delimiters.pop() !== opening) throw new Error("toml_value_unknown"); if (c === "]") arrayDepth--; else braceDepth--; }
        i += 1;
      }
    }
    if (start < 0) return null;
    return { lines, start, end, offsets };
  }

  function writeTomlTarget(target, detected) {
    const file = detected.file;
    const parent = path.dirname(file);
    const parentStat = lstatOptional(parent);
    if (!parentStat || !parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error("target_directory_missing");
    assertNoSymlinkPath(file, { includeTarget: true });
    const before = readRegular(file);
    if (detected.sourceText !== undefined && before.text !== detected.sourceText) throw new Error("concurrent_change");
    let raw = before.text;
    // The host-settings lexer validates the whole TOML document before edits.
    hostSettings.readTomlTable(raw, ["__t3_validation_probe__"], []);
    if (!findTomlTargetSection(raw, "t3_hub") && !findTomlTargetSection(raw, "t3-hub")) {
      if (/^\s*mcp_servers\s*=/m.test(raw)) throw new Error("mcp_servers_root_value");
      raw = (raw.trimEnd() ? raw.trimEnd() + "\n\n" : "") + `[mcp_servers.t3_hub]\ncommand = ${JSON.stringify(routerBin)}\nargs = ["--memory-only"]\n`;
    } else {
      const found = findTomlTargetSection(raw, "t3_hub") || findTomlTargetSection(raw, "t3-hub");
      const section = raw.slice(found.offsets[found.start], found.end < found.lines.length ? found.offsets[found.end] : raw.length);
      const values = hostSettings.readTomlTable(raw, ["mcp_servers", found.lines[found.start].includes("t3-hub") ? "t3-hub" : "t3_hub"], ["command", "args", "enabled", "disabled"]);
      if (!values || values.enabled === false || values.disabled === true) throw new Error("hub_entry_conflict");
      const identity = routerCommand(values.command, values.args, routerBin);
      if (!identity.ok) throw new Error(identity.reason || "hub_entry_conflict");
      if (identity.memoryOnly) return;
      const sectionLines = section.split(/\r?\n/);
      let argsLine = -1;
      for (let i = 0; i < sectionLines.length; i += 1) if (/^\s*args\s*=/.test(sectionLines[i])) { if (argsLine >= 0) throw new Error("duplicate_args"); argsLine = i; }
      if (argsLine >= 0) {
        const line = sectionLines[argsLine];
        if (!/^\s*args\s*=\s*\[[^\r\n]*\]\s*(?:#.*)?$/.test(line)) throw new Error("hub_args_custom");
        const commentAt = line.indexOf("#");
        const comment = commentAt >= 0 ? " " + line.slice(commentAt) : "";
        sectionLines[argsLine] = line.match(/^\s*/)[0] + 'args = ["--memory-only"]' + comment;
      } else {
        const commandLine = sectionLines.findIndex(line => /^\s*command\s*=/.test(line));
        if (commandLine < 0) throw new Error("hub_command_unknown");
        sectionLines.splice(commandLine + 1, 0, 'args = ["--memory-only"]');
      }
      const replacement = sectionLines.join("\n");
      raw = raw.slice(0, found.offsets[found.start]) + replacement + raw.slice(found.end < found.lines.length ? found.offsets[found.end] : raw.length);
    }
    // Validate readback before publishing and after rename.
    hostSettings.readTomlTable(raw, ["__t3_validation_probe__"], []);
    atomicWrite(file, raw, { backup: true, mode: 0o600, expectedText: before.text });
  }

  function reconcile() {
    const access = readAccess();
    if (access.state !== "enabled") return { ok: false, changed: [], skipped: [], error: access.state === "unknown" ? "access_unknown" : "disabled" };
    const settings = readTrustedSettings();
    const magpie = readMagpieOwnership();
    if (settings.state !== "ok") return { ok: false, changed: [], skipped: [{ status: "unknown", reason: settings.reason }], error: "settings_unavailable" };
    const changed = [], skipped = [];
    for (const target of settings.targets) {
      const detected = detectTarget(target, magpie);
      if (detected.status === "configured") continue;
      if (detected.status !== "missing") { skipped.push({ instanceId: safeLabel(target.instanceId), status: detected.status, reason: safeReason(detected.reason) }); continue; }
      if (!detected.file) { skipped.push({ instanceId: safeLabel(target.instanceId), status: "unknown", reason: "target_unavailable" }); continue; }
      if (!fs.existsSync(routerBin)) { skipped.push({ instanceId: safeLabel(target.instanceId), status: "unsupported", reason: "router_not_installed" }); continue; }
      try {
        if (detected.format === "claude-json") writeClaudeJsonTarget(target, detected);
        else if (detected.format === "opencode-json") writeOpenCodeJsonTarget(target, detected);
        else if (detected.format === "json") writeJsonTarget(target, detected);
        else if (detected.format === "toml") writeTomlTarget(target, detected);
        else throw new Error("format_unsupported");
        const after = detectTarget(target, magpie);
        if (after.status !== "configured") throw new Error("readback_failed");
        changed.push(safeLabel(target.instanceId));
      } catch (error) {
        skipped.push({ instanceId: safeLabel(target.instanceId), status: "unknown", reason: safeReason(error?.message) });
      }
    }
    const summary = getSetupSummary();
    return { ok: skipped.length === 0 && summary.missing === 0 && summary.conflict === 0 && summary.unknown === 0 && summary.pending === 0 && summary.unsupported === 0, changed, skipped };
  }

  let accessWatcher = null;
  let accessWatcherPath = "";
  let providerWatchers = [];
  let watcherDebounce = null;
  let accessSyncDebounce = null;
  let accessPollTimer = null;
  let providerWatching = false;
  function closeProviderWatchers() {
    for (const watcher of providerWatchers) { try { watcher.close(); } catch {} }
    providerWatchers = [];
  }
  function closeAccessWatcher() {
    try { if (accessWatcher) accessWatcher.close(); } catch {}
    accessWatcher = null;
    accessWatcherPath = "";
    if (accessSyncDebounce) clearTimeout(accessSyncDebounce);
    accessSyncDebounce = null;
  }
  function scheduleReconcile() {
    if (watcherDebounce) clearTimeout(watcherDebounce);
    watcherDebounce = setTimeout(() => { watcherDebounce = null; try { reconcile(); } catch {} }, 300);
    watcherDebounce.unref?.();
  }
  function closestExistingDirectory(targetDir) {
    const target = path.resolve(targetDir);
    let current = target;
    let childName = null;
    while (true) {
      const stat = lstatOptional(current);
      if (stat) {
        if (!isDirectoryEntry(current, stat)) return null;
        assertNoSymlinkPath(current, { includeTarget: true });
        return { dir: current, direct: current === target, childName };
      }
      const parent = path.dirname(current);
      if (parent === current) return null;
      childName = path.basename(current);
      current = parent;
    }
  }
  function createDirectoryWatcher(targetDir, onEvent) {
    try {
      const target = closestExistingDirectory(targetDir);
      if (!target) return null;
      const watcher = fs.watch(target.dir, { persistent: false }, (_event, filename) => {
        const name = filename ? String(filename) : "";
        if (!target.direct && name && name !== target.childName) return;
        onEvent({ name, direct: target.direct });
      });
      watcher.unref?.();
      return { watcher, ...target };
    } catch { return null; }
  }
  function scheduleAccessSync() {
    if (accessSyncDebounce) clearTimeout(accessSyncDebounce);
    accessSyncDebounce = setTimeout(() => {
      accessSyncDebounce = null;
      const access = readAccess();
      if (access.state === "enabled" && access.persisted) startProviderWatching({ reconcileOnStart: true });
      else stopProviderWatching();
    }, 120);
    accessSyncDebounce.unref?.();
  }
  function ensureAccessWatcher() {
    const target = closestExistingDirectory(hubDir);
    if (!target) return false;
    if (accessWatcher && accessWatcherPath === target.dir) return true;
    closeAccessWatcher();
    const result = createDirectoryWatcher(hubDir, ({ name, direct }) => {
      if (direct && name && name !== ACCESS_FILE) return;
      if (!direct) ensureAccessWatcher();
      scheduleAccessSync();
    });
    if (!result) return false;
    accessWatcher = result.watcher;
    accessWatcherPath = result.dir;
    return true;
  }
  function addProviderPathWatcher(targetDir, expectedFileName = null) {
    const result = createDirectoryWatcher(targetDir, ({ name, direct }) => {
      if (direct && expectedFileName && name && name !== expectedFileName) return;
      refreshProviderWatchers();
      scheduleReconcile();
    });
    if (!result) return false;
    providerWatchers.push(result.watcher);
    return true;
  }
  function refreshProviderWatchers() {
    closeProviderWatchers();
    providerWatching = false;
    const userDataWatcher = createDirectoryWatcher(userDataDir, ({ name, direct }) => {
      if (direct && name && name !== "settings.json" && name !== "providers") return;
      refreshProviderWatchers();
      scheduleReconcile();
    });
    if (!userDataWatcher) return;
    providerWatchers.push(userDataWatcher.watcher);
    providerWatching = true;
    try {
      const settings = readTrustedSettings();
      if (settings.state === "ok") {
        const magpie = readMagpieOwnership();
        const watchedFiles = new Set();
        for (const target of settings.targets) {
          const detected = detectTarget(target, magpie);
          if (!detected.file) continue;
          const file = path.resolve(detected.file);
          if (watchedFiles.has(file)) continue;
          watchedFiles.add(file);
          addProviderPathWatcher(path.dirname(file), path.basename(file));
        }
      }
    } catch {}
  }
  function stopProviderWatching() {
    closeProviderWatchers();
    providerWatching = false;
    if (watcherDebounce) clearTimeout(watcherDebounce);
    watcherDebounce = null;
  }
  function stopWatching() {
    stopProviderWatching();
    closeAccessWatcher();
    if (accessPollTimer) clearInterval(accessPollTimer);
    accessPollTimer = null;
  }
  function startWatching({ reconcileOnStart = false } = {}) {
    const accessWatcherStarted = ensureAccessWatcher();
    if (!accessPollTimer) {
      accessPollTimer = setInterval(() => {
        const access = readAccess();
        if (access.state !== "enabled" || !access.persisted) {
          stopProviderWatching();
          return;
        }
        if (!providerWatching) startProviderWatching({ reconcileOnStart: true });
        else {
          refreshProviderWatchers();
          try { reconcile(); } catch {}
        }
      }, watcherPollMs);
      accessPollTimer.unref?.();
    }
    const access = readAccess();
    if (access.state !== "enabled" || !access.persisted) {
      stopProviderWatching();
      return { started: false, reason: access.state === "unknown" ? "access_unknown" : "not_enabled", accessWatcherStarted };
    }
    startProviderWatching({ reconcileOnStart });
    return { started: providerWatching, reason: providerWatching ? null : "settings_watch_unavailable", accessWatcherStarted };
  }
  function startProviderWatching({ reconcileOnStart = false } = {}) {
    stopProviderWatching();
    const access = readAccess();
    if (access.state !== "enabled" || !access.persisted) return { started: false, reason: access.state === "unknown" ? "access_unknown" : "not_enabled" };
    refreshProviderWatchers();
    if (!providerWatching) return { started: false, reason: "settings_watch_unavailable" };
    if (reconcileOnStart) { try { reconcile(); } catch {} }
    return { started: true, reason: null };
  }

  return {
    homeDir, hubDir, configPath, runtimeHintsPath, settingsPath, routerBin,
    getAgentAccess, getSetupSummary, readMemoryOnlyStatus,
    getT3RuntimeHints, setT3RuntimeHints,
    setAgentAccess, setup, reconcile, startWatching, stopWatching,
    isAccessEnabled: () => readAccess().state === "enabled",
    getAccessState: readAccess,
  };
}

function getT3RuntimeHints(options = {}) {
  return createMemoryAccessManager(options).getT3RuntimeHints();
}
function setT3RuntimeHints(payload = {}, options = {}) {
  return createMemoryAccessManager(options).setT3RuntimeHints(payload);
}

module.exports = {
  createMemoryAccessManager,
  CONFIG_VERSION,
  ACCESS_FILE,
  MEMORY_ONLY_ARGS,
  RUNTIME_HINTS_FILE,
  RUNTIME_HINTS_SCOPE,
  RUNTIME_HINTS_MAX_LENGTH,
  RUNTIME_HINTS_TRUNCATED_TOOLS,
  RUNTIME_HINTS_LOCK_FILE,
  RUNTIME_HINTS_LOCK_TIMEOUT_MS,
  DEFAULT_T3_RUNTIME_HINTS,
  getT3RuntimeHints,
  setT3RuntimeHints,
};
