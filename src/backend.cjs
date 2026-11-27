"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { StringDecoder } = require("node:string_decoder");
const { DatabaseSync } = require("node:sqlite");
const hubSkills = require("./hub-skills.cjs");
const mcpRouter = require("./mcp-router.cjs");
const memoryVault = require("./memory-vault.cjs");
const { createMemoryAccessManager } = require("./hub-memory-access.cjs");
const embedManager = require("./embed-manager.cjs");
const hubSubagents = require("./hub-subagents.cjs");
const hubPlugins = require("./hub-plugins.cjs");
const hubHooks = require("./hub-hooks.cjs");
const hubMemoryConnections = require("./hub-memory-connections.cjs");
const hubTaskBoard = require("./hub-task-board.cjs");
const { createArtifactAccess } = require("./hub-artifact-access.cjs");
const { createProviderResourcesManager } = require("./hub-provider-resources.cjs");
const { createDevinQuotaReader } = require("./hub-devin-quota.cjs");
const { createGuardianManager } = require("./update-guardian.cjs");
const hubHostSettings = require("./hub-host-settings.cjs");
const { createHudUpdater, sha256 } = require("./hub-update.cjs");
const { readInstalledVersion } = require("./hud-release.cjs");
const { createDreamScheduler, beginDreamRun } = require("./hub-dream-scheduler.cjs");

const execFileAsync = promisify(execFile);
const loadedBackendHash = sha256(fs.readFileSync(__filename));
const hudUpdater = createHudUpdater({
  installLock: path.join(os.homedir(), ".t3", "hud-install.lock"),
  configPath: path.join(process.env.T3_HUD_DIR || path.join(os.homedir(), ".t3", "hud-plugin"), "config.json"),
});

// Hub v3 engines (lazy singletons respecting process.env.HOME for tests)
let _taskBoardInstance = null;
let _taskBoardHome = null;
let _hostSettingsInstance = null;
let _hostSettingsHome = null;
let _devinQuotaInstance = null;
let _devinQuotaHome = null;
function getDevinQuotaReader() {
  const curHome = process.env.HOME || os.homedir();
  if (_devinQuotaInstance && _devinQuotaHome === curHome) return _devinQuotaInstance;
  _devinQuotaInstance = createDevinQuotaReader({ homeDir: curHome });
  _devinQuotaHome = curHome;
  return _devinQuotaInstance;
}
const agyQuotaModule = path.join(__dirname, "hub-agy-quota.cjs");
function resolveActiveT3Paths() {
  const homeDir = process.env.HOME || os.homedir();
  const t3CodeHome = process.env.T3CODE_HOME || "";
  if (fs.existsSync(agyQuotaModule)) {
    try {
      const mod = require(agyQuotaModule);
      if (typeof mod.resolveT3Paths === "function") {
        return mod.resolveT3Paths({ homeDir, t3CodeHome });
      }
    } catch {}
  }
  const resolvedHome = path.resolve(homeDir);
  const rawCustom = String(t3CodeHome).trim();
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
  try { fs.lstatSync(stdUserdata); hasStdUserdata = true; } catch {}
  const hasDirectMarker = !hasStdUserdata && ["environment-id", "settings.json", "statev2.sqlite"].some((name) => {
    try { fs.lstatSync(path.join(baseDir, name)); return true; } catch { return false; }
  });
  return {
    homeDir: resolvedHome,
    baseDir,
    userDataDir: hasDirectMarker ? baseDir : stdUserdata,
    toolsDir: path.join(baseDir, "tools"),
    isCustom: true,
    isDirectDataDir: hasDirectMarker,
  };
}
let _agyQuotaInstance = null;
let _agyQuotaKey = null;
function getAgyQuotaReader() {
  if (!fs.existsSync(agyQuotaModule)) return null;
  const t3Paths = resolveActiveT3Paths();
  const pluginDir = process.env.T3_HUD_DIR ? path.resolve(process.env.T3_HUD_DIR) : path.join(t3Paths.homeDir, ".t3", "hud-plugin");
  const key = `${t3Paths.homeDir}\0${t3Paths.baseDir}\0${t3Paths.userDataDir}\0${t3Paths.toolsDir}\0${pluginDir}`;
  if (_agyQuotaInstance && _agyQuotaKey === key) return _agyQuotaInstance;
  try {
    const { createAgyQuotaReader } = require(agyQuotaModule);
    if (typeof createAgyQuotaReader !== "function") return null;
    _agyQuotaInstance = createAgyQuotaReader({
      homeDir: t3Paths.homeDir,
      t3CodeHome: process.env.T3CODE_HOME || "",
      baseDir: t3Paths.baseDir,
      userDataDir: t3Paths.userDataDir,
      toolsDir: t3Paths.toolsDir,
      pluginDir,
    });
    _agyQuotaKey = key;
    return _agyQuotaInstance;
  } catch {
    return null;
  }
}
function getTaskBoard() {
  const curHome = process.env.HOME || os.homedir();
  if (_taskBoardInstance && _taskBoardHome === curHome) return _taskBoardInstance;
  _taskBoardInstance = hubTaskBoard.createTaskBoard({});
  _taskBoardHome = curHome;
  return _taskBoardInstance;
}
function getHostSettingsManager() {
  const curHome = process.env.HOME || os.homedir();
  const curKey = `${curHome}\0${process.env.T3_HUB_DIR || ""}\0${process.env.T3CODE_HOME || ""}`;
  if (_hostSettingsInstance && _hostSettingsHome === curKey) return _hostSettingsInstance;
  _hostSettingsInstance = hubHostSettings.createHostSettingsManager({
    homeDir: curHome,
    ...(process.env.T3_HUB_DIR ? { hubDir: process.env.T3_HUB_DIR } : {}),
  });
  _hostSettingsHome = curKey;
  return _hostSettingsInstance;
}
function isTestEnv() {
  return !!(process.env.NODE_ENV === "test" || process.env.T3_HUB_TEST || process.env.UNDER_TEST);
}

const MEMORY_ACCESS_RUNTIME_KEY = Symbol.for("t3.hud.memory.agent-access.v1");
const priorMemoryAccessRuntime = globalThis[MEMORY_ACCESS_RUNTIME_KEY];
try { priorMemoryAccessRuntime?.stopWatching?.(); } catch {}
let memoryAccessRuntime = null;
let memoryAccessRuntimeKey = "";
function getMemoryAccessRuntime() {
  const homeDir = process.env.HOME || os.homedir();
  const hubDir = process.env.T3_HUB_DIR || path.join(homeDir, ".t3", "hub");
  const userDataDir = process.env.T3CODE_HOME || path.join(homeDir, ".t3", "userdata");
  const key = `${homeDir}\0${hubDir}\0${userDataDir}`;
  if (memoryAccessRuntime && memoryAccessRuntimeKey === key) return memoryAccessRuntime;
  try { memoryAccessRuntime?.stopWatching?.(); } catch {}
  memoryAccessRuntime = createMemoryAccessManager({ homeDir, hubDir, userDataDir });
  memoryAccessRuntimeKey = key;
  globalThis[MEMORY_ACCESS_RUNTIME_KEY] = memoryAccessRuntime;
  return memoryAccessRuntime;
}
function startMemoryAccessRuntime() {
  const runtime = getMemoryAccessRuntime();
  if (!isTestEnv()) runtime.startWatching({ reconcileOnStart: true });
  return runtime;
}
if (!isTestEnv()) startMemoryAccessRuntime();

function getMemoryVault() {
  try {
    if (memoryVault && typeof memoryVault.getDefaultMemoryVault === "function") return memoryVault.getDefaultMemoryVault();
  } catch {}
  return memoryVault;
}

const DREAM_SCHEDULER_KEY = Symbol.for("t3.hud.memory.dream-scheduler.v1");
const priorDreamScheduler = globalThis[DREAM_SCHEDULER_KEY];
try { if (priorDreamScheduler && typeof priorDreamScheduler.stop === "function") priorDreamScheduler.stop(); } catch {}
const dreamScheduler = createDreamScheduler({
  getVault: () => memoryVault && typeof memoryVault.getDefaultMemoryVault === "function"
    ? memoryVault.getDefaultMemoryVault()
    : memoryVault,
});
globalThis[DREAM_SCHEDULER_KEY] = dreamScheduler;
function ensureDreamScheduler() {
  // Older bridge instances may still call this during a hot reload. Keep the
  // export for compatibility, but never restart Dream automation from Hub.
  dreamScheduler.stop();
  return dreamScheduler.getStatus();
}
function stopDreamScheduler() {
  return dreamScheduler.stop();
}
function getDreamSchedulerStatus() {
  return dreamScheduler.getStatus();
}

const HOME_DIR = os.homedir();
const T3_USERDATA = process.env.T3CODE_HOME
  ? path.resolve(process.env.T3CODE_HOME)
  : path.join(HOME_DIR, ".t3", "userdata");
const DB_PATH = path.join(T3_USERDATA, "statev2.sqlite");
const MODEL_RATES_PATH = path.join(T3_USERDATA, "usage-model-rates.json");
const MUSE_DATA_ROOT = process.env.MUSE_DATA_DIR
  ? path.resolve(process.env.MUSE_DATA_DIR)
  : process.env.XDG_DATA_HOME
    ? path.join(path.resolve(process.env.XDG_DATA_HOME), "muse")
    : path.join(HOME_DIR, ".local", "share", "muse");
const MUSE_SESSIONS_ROOT = path.join(MUSE_DATA_ROOT, "sessions");
const MUSE_INDEX_DB_PATH = path.join(MUSE_DATA_ROOT, "session-index.db");
const CODEX_HOME_ROOT = process.env.CODEX_HOME
  ? path.resolve(process.env.CODEX_HOME)
  : path.join(HOME_DIR, ".codex");
const CODEX_SESSIONS_ROOT = path.join(CODEX_HOME_ROOT, "sessions");
const AGY_PROVIDERS_ROOT = path.join(T3_USERDATA, "providers", "antigravity");
const HUD_PLUGIN_DIR = process.env.T3_HUD_DIR || path.join(HOME_DIR, ".t3", "hud-plugin");
const HUD_CONFIG_PATH = path.join(HUD_PLUGIN_DIR, "config.json");
// Older HUD hot-update bundles replace this file without installing new siblings.
const hudConfigModule = path.join(__dirname, "hud-config.cjs");
const telemetryGuardModule = path.join(__dirname, "hub-telemetry-guard.cjs");
if (process.type === "browser" && fs.existsSync(telemetryGuardModule)) {
  try {
    const { verifyLegacyTelemetryLaunch } = require(telemetryGuardModule);
    verifyLegacyTelemetryLaunch(path.join(path.dirname(HUD_CONFIG_PATH), "run"), process.pid, process.env);
  } catch {}
}

// ============================================================================
// 1. Official T3 / LiteLLM Model Rate Catalog Loader (5,900+ models + tiers)
// ============================================================================
const FIRST_PARTY_PROVIDERS = new Set([
  "anthropic",
  "deepseek",
  "gemini",
  "meta",
  "mistral",
  "openai",
  "xai",
]);

let cachedRateTable = null;
let cachedRateMtimeMs = 0;

function finiteNum(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function readTokenRates(entry, suffix = "", standard = null, outputFallback = null) {
  const input = finiteNum(entry[`input_cost_per_token${suffix}`]);
  const output = finiteNum(entry[`output_cost_per_token${suffix}`]) ?? outputFallback ?? null;
  if (input === null || output === null) return null;
  const cacheRead =
    finiteNum(entry[`cache_read_input_token_cost${suffix}`]) ??
    (standard && standard.input > 0 ? (standard.cacheRead / standard.input) * input : input * 0.1);
  const cacheWrite =
    finiteNum(entry[`cache_creation_input_token_cost${suffix}`]) ??
    (standard && standard.input > 0 ? (standard.cacheWrite / standard.input) * input : input);
  return { input, output, cacheRead, cacheWrite };
}

function loadOfficialRateTable() {
  try {
    const st = fs.statSync(MODEL_RATES_PATH);
    if (cachedRateTable && st.mtimeMs === cachedRateMtimeMs) return cachedRateTable;

    const raw = JSON.parse(fs.readFileSync(MODEL_RATES_PATH, "utf8"));
    const doc = raw?.document || raw;
    const table = new Map();

    if (doc && typeof doc === "object") {
      for (const [name, entry] of Object.entries(doc)) {
        if (!entry || typeof entry !== "object") continue;
        const base = readTokenRates(entry, "");
        if (!base) continue;

        const thresholds = [];
        for (const k of Object.keys(entry)) {
          const m = /^input_cost_per_token_above_(\d{1,7})k_tokens$/.exec(k);
          if (m) {
            const tierRate = readTokenRates(entry, `_above_${m[1]}k_tokens`, base, base.output);
            if (tierRate) {
              thresholds.push({ thresholdTokens: Number(m[1]) * 1000, rate: tierRate });
            }
          }
        }
        thresholds.sort((a, b) => b.thresholdTokens - a.thresholdTokens);

        const key = name.trim().toLowerCase();
        table.set(key, { ...base, contextTiers: thresholds });
      }

      // Build bare-name aliases preferring first-party providers (exact T3 logic)
      const aliasMap = new Map();
      for (const [key, rate] of table.entries()) {
        const slash = key.indexOf("/");
        let alias = "";
        let firstParty = false;
        if (slash !== -1) {
          firstParty = FIRST_PARTY_PROVIDERS.has(key.slice(0, slash));
          alias = key.slice(slash + 1);
        } else if (key.startsWith("anthropic.")) {
          alias = key.slice(10).replace(/-v\d+$/, "");
        }
        if (!alias || alias === key || table.has(alias)) continue;
        const prev = aliasMap.get(alias);
        if (!prev || (firstParty && !prev.firstParty)) {
          aliasMap.set(alias, { rate, firstParty });
        }
      }
      for (const [alias, { rate }] of aliasMap.entries()) {
        if (!table.has(alias)) table.set(alias, rate);
      }
    }

    cachedRateTable = table;
    cachedRateMtimeMs = st.mtimeMs;
    return table;
  } catch {
    return cachedRateTable || new Map();
  }
}

function normalizeModelForRate(model) {
  if (!model) return "";
  let m = String(model).trim().toLowerCase();
  const bracket = m.indexOf("[");
  if (bracket !== -1) m = m.slice(0, bracket);
  m = m.replace(/-(?:extra-low|low|medium|high|tiered|control|thinking|agent)$/, "");
  if (m === "muse-wonder-full-1.0") return "muse-wonder-1.0";
  return m;
}

function lookupCatalogContextMax(model, provider) {
  if (!model) return null;
  try {
    const st = fs.statSync(MODEL_RATES_PATH);
    void st;
    const raw = JSON.parse(fs.readFileSync(MODEL_RATES_PATH, "utf8"));
    const doc = raw?.document || raw;
    if (!doc || typeof doc !== "object") return null;
    const norm = normalizeModelForRate(model);
    const candidates = [
      norm,
      provider ? `${String(provider).toLowerCase()}/${norm}` : "",
      `meta/${norm}`,
      `gemini/${norm}`,
      `openai/${norm}`,
      `anthropic/${norm}`,
    ].filter(Boolean);
    for (const key of candidates) {
      const entry = doc[key];
      if (!entry || typeof entry !== "object") continue;
      const v =
        entry.max_input_tokens ?? entry.maxInputTokens ?? entry.context_window ?? entry.contextWindow;
      if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
    }
    // Case-insensitive scan for exact model name
    for (const [name, entry] of Object.entries(doc)) {
      if (!entry || typeof entry !== "object") continue;
      if (name.toLowerCase() === norm) {
        const v =
          entry.max_input_tokens ?? entry.maxInputTokens ?? entry.context_window ?? entry.contextWindow;
        if (typeof v === "number" && v > 0) return v;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function resolveModelRate(model, provider, promptTokens = 0) {
  const table = loadOfficialRateTable();
  const norm = normalizeModelForRate(model);
  const candidates = [
    norm,
    provider ? `${String(provider).toLowerCase()}/${norm}` : "",
    `meta/${norm}`,
    `gemini/${norm}`,
    `openai/${norm}`,
    `azure_ai/${norm}`,
    `anthropic/${norm}`,
  ].filter(Boolean);

  for (const key of candidates) {
    const found = table.get(key);
    if (found) {
      const tier = found.contextTiers?.find((t) => promptTokens > t.thresholdTokens)?.rate;
      return tier || found;
    }
  }

  // Muse Wonder 灯塔最贵费率（kyma/muse-wonder 真实费率 $5.40/$27.00）
  const MUSE_WONDER_RATE = { input: 5.4 / 1e6, output: 27.0 / 1e6, cacheRead: 0.54 / 1e6, cacheWrite: 5.4 / 1e6 };
  // Safe fallback rates (USD per token) if model is absent from catalog
  if (norm.includes("muse-ember")) {
    return { input: 0.1 / 1e6, output: 0.5 / 1e6, cacheRead: 0.004 / 1e6, cacheWrite: 0.1 / 1e6 };
  }
  if (norm.includes("muse-wonder")) {
    return { ...MUSE_WONDER_RATE };
  }
  if (norm.includes("opus")) {
    return { input: 5.0 / 1e6, output: 25.0 / 1e6, cacheRead: 0.5 / 1e6, cacheWrite: 6.25 / 1e6 };
  }
  if (norm.includes("sonnet")) {
    return { input: 3.0 / 1e6, output: 15.0 / 1e6, cacheRead: 0.3 / 1e6, cacheWrite: 3.75 / 1e6 };
  }
  if (norm.includes("gpt-6.1-terra")) {
    return { input: 1.0 / 1e6, output: 5.0 / 1e6, cacheRead: 0.05 / 1e6, cacheWrite: 1.0 / 1e6 };
  }
  if (norm.includes("gpt-6") || norm.includes("carbon") || norm.includes("argon")) {
    return { input: 2.0 / 1e6, output: 10.0 / 1e6, cacheRead: 0.1 / 1e6, cacheWrite: 2.0 / 1e6 };
  }
  if (norm.includes("hydrogen")) {
    return { input: 1.5 / 1e6, output: 7.5 / 1e6, cacheRead: 0.075 / 1e6, cacheWrite: 1.5 / 1e6 };
  }
  // 未知模型一律按最贵 muse-wonder 计费，替换旧 $2/$10 兜底
  return { ...MUSE_WONDER_RATE, isWonderFallback: true };
}

const MUSE_WONDER_RATES_EXPORT = { input: 5.4 / 1e6, output: 27.0 / 1e6, cacheRead: 0.54 / 1e6, cacheWrite: 5.4 / 1e6 };
function getWonderFallbackRate() {
  return { ...MUSE_WONDER_RATES_EXPORT, isWonderFallback: true };
}
function getMuseWonderRate() {
  return { ...MUSE_WONDER_RATES_EXPORT };
}
// 纯函数：未知模型兜底，供单测直接断言
function resolveModelRateWithWonderFallback(model, provider, promptTokens = 0) {
  return resolveModelRate(model, provider, promptTokens);
}
function priceStep(totals, model, provider) {
  const prompt = totals.uncached + totals.cached + totals.cacheWrite;
  const r = resolveModelRate(model, provider, prompt);
  // Note: reasoningTokens are already included inside outputTokens across Muse, Antigravity, and Codex!
  const usd =
    totals.uncached * r.input +
    totals.cached * r.cacheRead +
    totals.cacheWrite * r.cacheWrite +
    totals.output * r.output;
  const savedUsd = totals.cached * Math.max(0, r.input - r.cacheRead);
  return { usd, savedUsd };
}

function mergeToolIntervals(intervals) {
  const valid = (Array.isArray(intervals) ? intervals : [])
    .filter((iv) => Array.isArray(iv) && Number.isFinite(iv[0]) && Number.isFinite(iv[1]) && iv[1] > iv[0])
    .map(([s, e]) => [s, e])
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [s, e] of valid) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) {
      if (e > last[1]) last[1] = e;
    } else {
      merged.push([s, e]);
    }
  }
  return merged;
}

function subtractToolWait(startMs, endMs, toolIntervals) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0;
  const merged = mergeToolIntervals(toolIntervals);
  let waitMs = 0;
  for (const [s, e] of merged) {
    const os = Math.max(startMs, s);
    const oe = Math.min(endMs, e);
    if (oe > os) waitMs += oe - os;
  }
  const netMs = Math.max(0, endMs - startMs - waitMs);
  return netMs / 1000;
}

// ============================================================================
// 2. Native Provider Telemetry Readers (Muse, Antigravity, Codex) with Cache
// ============================================================================
const CACHE_LIMIT = 500;
const fileParseCache = new Map(); // key -> { sig, data }

function lruGet(map, key) {
  if (!map.has(key)) return undefined;
  const v = map.get(key);
  map.delete(key);
  map.set(key, v);
  return v;
}
function lruSet(map, key, value) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > CACHE_LIMIT) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

// Full-session accounting MUST scan every line. Retain only the current record,
// never the complete file or an array of historical records. The I/O buffer is
// fixed; oversized/corrupt records are skipped without retaining their contents.
function forEachJsonlLineSync(filePath, onLine, { chunkBytes = 256 * 1024, maxLineChars = 8 * 1024 * 1024 } = {}) {
  if (!Number.isInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > 256 * 1024) {
    throw new RangeError("JSONL chunkBytes must be between 1 and 262144");
  }
  if (!Number.isSafeInteger(maxLineChars) || maxLineChars < 1) {
    throw new RangeError("JSONL maxLineChars must be a positive safe integer");
  }
  const stats = { skippedOversizedLines: 0, maxBufferedLineChars: 0 };
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(chunkBytes);
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let overflowingLine = false;
    const consume = (text) => {
      let start = 0;
      while (start < text.length) {
        const end = text.indexOf("\n", start);
        const stop = end === -1 ? text.length : end;
        if (!overflowingLine) {
          if (pending.length + stop - start > maxLineChars) {
            pending = "";
            overflowingLine = true;
            stats.skippedOversizedLines++;
          } else {
            pending += text.slice(start, stop);
            stats.maxBufferedLineChars = Math.max(stats.maxBufferedLineChars, pending.length);
          }
        }
        if (end === -1) break;
        if (!overflowingLine) onLine(pending);
        pending = "";
        overflowingLine = false;
        start = end + 1;
      }
    };
    let bytesRead;
    while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      consume(decoder.write(buffer.subarray(0, bytesRead)));
    }
    consume(decoder.end());
    if (!overflowingLine && pending) onLine(pending);
    return stats;
  } finally {
    fs.closeSync(fd);
  }
}

// Lossy preview-only helper retained for compatibility. Never use it for
// cumulative tokens, cost, cache savings, or other full-session accounting.
const JSONL_LARGE_THRESHOLD = 24 * 1024 * 1024;
const JSONL_HEAD_BYTES = 2 * 1024 * 1024;
const JSONL_TAIL_BYTES = 16 * 1024 * 1024;
function readJsonlLinesSafe(filePath) {
  let st;
  try {
    st = fs.statSync(filePath);
  } catch {
    return [];
  }
  if (st.size <= JSONL_LARGE_THRESHOLD) {
    try {
      const content = fs.readFileSync(filePath, "utf8");
      return content.split("\n");
    } catch {
      return [];
    }
  }
  // Large file: head 2MB (first metadata) + tail 16MB (newest stats), newline-aligned
  const fd = fs.openSync(filePath, "r");
  try {
    const headBuf = Buffer.alloc(JSONL_HEAD_BYTES);
    const headRead = fs.readSync(fd, headBuf, 0, JSONL_HEAD_BYTES, 0);
    let headText = headBuf.slice(0, headRead).toString("utf8");
    const lastNl = headText.lastIndexOf("\n");
    if (lastNl !== -1) headText = headText.slice(0, lastNl + 1);
    const tailOffset = st.size - JSONL_TAIL_BYTES;
    const tailBuf = Buffer.alloc(JSONL_TAIL_BYTES);
    const tailRead = fs.readSync(fd, tailBuf, 0, JSONL_TAIL_BYTES, tailOffset);
    let tailText = tailBuf.slice(0, tailRead).toString("utf8");
    const firstNl = tailText.indexOf("\n");
    if (firstNl !== -1) tailText = tailText.slice(firstNl + 1);
    const combined = headText + tailText;
    return combined.split("\n");
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

function getFileSig(filePath) {
  try {
    const st = fs.statSync(filePath);
    let walSig = "";
    try {
      const wst = fs.statSync(filePath + "-wal");
      walSig = `:${wst.mtimeMs}:${wst.size}`;
    } catch {}
    return `${st.mtimeMs}:${st.size}${walSig}`;
  } catch {
    return null;
  }
}

function dateDirsFromUuidV7(id, rootDir) {
  const clean = String(id || "").replace(/-/g, "");
  if (clean.length < 12) return [];
  const ms = parseInt(clean.slice(0, 12), 16);
  if (!Number.isFinite(ms) || ms < 1e12) return [];
  const dirs = new Set();
  for (const offset of [0, -86400000, 86400000]) {
    const d = new Date(ms + offset);
    for (const utc of [false, true]) {
      const y = String(utc ? d.getUTCFullYear() : d.getFullYear());
      const m = String((utc ? d.getUTCMonth() : d.getMonth()) + 1).padStart(2, "0");
      const day = String(utc ? d.getUTCDate() : d.getDate()).padStart(2, "0");
      dirs.add(path.join(rootDir, y, m, day));
    }
  }
  return [...dirs];
}

// --- A. Muse Native Reader (`session.jsonl` with microsecond decode timestamps) ---
function findMuseSessionJsonl(nativeId) {
  if (!nativeId) return null;
  // 1) Try UUIDv7 O(1) path first (< 0.1ms)
  for (const dayDir of dateDirsFromUuidV7(nativeId, MUSE_SESSIONS_ROOT)) {
    const candidate = path.join(dayDir, nativeId, "session.jsonl");
    if (fs.existsSync(candidate)) return candidate;
  }
  // 2) Fallback to session-index.db
  if (fs.existsSync(MUSE_INDEX_DB_PATH)) {
    let mdb;
    try {
      mdb = new DatabaseSync(MUSE_INDEX_DB_PATH, { open: true, readOnly: true });
      const row = mdb
        .prepare("SELECT session_log_path FROM sessions WHERE session_id = ? LIMIT 1")
        .get(nativeId);
      if (row?.session_log_path && fs.existsSync(row.session_log_path)) {
        return row.session_log_path;
      }
    } catch {
    } finally {
      try {
        mdb?.close();
      } catch {}
    }
  }
  return null;
}

function readMuseSessionFile(jsonlPath, fallbackModel) {
  const sig = getFileSig(jsonlPath);
  if (!sig) return null;
  const cached = lruGet(fileParseCache, jsonlPath);
  if (cached && cached.sig === sig) return cached.data;

  let sumUncached = 0;
  let sumCached = 0;
  let sumCacheWrite = 0;
  let sumOutput = 0;
  let sumReasoning = 0;
  let sumUsd = 0;
  let sumSavedUsd = 0;

  let decodeTokensSum = 0;
  let decodeSecSum = 0;
  let e2eTokensSum = 0;
  let e2eSecSum = 0;
  const byModelDecode = {};

  let lastDecodeTps = null;
  let lastDecodeSec = null;
  let lastStepCacheRate = null;
  let lastContextPrompt = null;
  let lastEventMs = null;
  let lastUsageEventMs = null;
  let lastSpeedEventMs = null;
  let hasPendingUnfinishedCallAfterLastUsage = false;
  let latestModel = fallbackModel || null;
  let stepCount = 0;

  let pendingResponseCreatedUs = null;

  forEachJsonlLineSync(jsonlPath, (line) => {
    if (!line) return;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      return;
    }
    const evt = rec?.payload?.event;
    if (!evt) return;
    const eventMs = Number.isFinite(rec.recorded_at) && rec.recorded_at / 1e3 >= 946684800000
      ? rec.recorded_at / 1e3 : null;
    if (eventMs != null) lastEventMs = eventMs;

    if (evt.kind === "model_response_created") {
      hasPendingUnfinishedCallAfterLastUsage = true;
      pendingResponseCreatedUs = typeof rec.recorded_at === "number" ? rec.recorded_at : null;
    } else if (evt.kind === "turn_started" || evt.kind === "turn_start" || evt.kind === "request_started") {
      hasPendingUnfinishedCallAfterLastUsage = true;
    } else if (evt.kind === "model_completed") {
      // A completed response supersedes the previous turn even when it did not
      // yield enough visible output for a valid decode-rate sample.
      lastDecodeTps = null;
      lastDecodeSec = null;
      lastStepCacheRate = null;
      lastSpeedEventMs = null;
      lastUsageEventMs = null;
      hasPendingUnfinishedCallAfterLastUsage = false;
      if (!evt.usage) {
        pendingResponseCreatedUs = null;
        return;
      }
      const u = evt.usage;
      const inputTotal = Math.max(0, Number(u.input_tokens) || 0);
      const cacheRead = Math.min(
        inputTotal,
        Math.max(0, Number(u.cache_read_tokens ?? u.cached_tokens) || 0)
      );
      const cacheWrite = Math.min(
        inputTotal - cacheRead,
        Math.max(0, Number(u.cache_write_tokens) || 0)
      );
      const uncached = Math.max(0, inputTotal - cacheRead - cacheWrite);
      const output = Math.max(0, Number(u.output_tokens) || 0);
      const reasoning = Math.min(output, Math.max(0, Number(u.reasoning_tokens) || 0));
      const model =
        (typeof evt.model === "string" ? evt.model : evt.model?.model_id) || latestModel;
      if (model) latestModel = model;

      if (inputTotal + output === 0) {
        pendingResponseCreatedUs = null;
        return;
      }
      stepCount++;
      lastUsageEventMs = eventMs;

      sumUncached += uncached;
      sumCached += cacheRead;
      sumCacheWrite += cacheWrite;
      sumOutput += output;
      sumReasoning += reasoning;

      const priced = priceStep({ uncached, cached: cacheRead, cacheWrite, output }, model, "meta");
      sumUsd += priced.usd;
      sumSavedUsd += priced.savedUsd;

      if (inputTotal > 0) {
        lastStepCacheRate = cacheRead / inputTotal;
        lastContextPrompt = inputTotal + output;
      }

      // Pure streaming decode window: model_response_created -> model_completed
      if (pendingResponseCreatedUs && typeof rec.recorded_at === "number" && output >= 20) {
        const decSec = (rec.recorded_at - pendingResponseCreatedUs) / 1e6;
        if (decSec >= 0.12 && output / decSec <= 1200) {
          decodeTokensSum += output;
          decodeSecSum += decSec;
          if (latestModel) { const bm = (byModelDecode[latestModel] ||= { tok: 0, sec: 0 }); bm.tok += output; bm.sec += decSec; }
          lastDecodeTps = output / decSec;
          lastDecodeSec = decSec;
          lastSpeedEventMs = eventMs;
        }
      }
      if (evt.duration_ms > 50 && output > 0) {
        e2eTokensSum += output;
        e2eSecSum += evt.duration_ms / 1000;
      }
      pendingResponseCreatedUs = null;
    }
  });

  const avgDecodeTps = decodeSecSum > 0.05 ? decodeTokensSum / decodeSecSum : null;
  const avgE2eTps = e2eSecSum > 0.1 ? e2eTokensSum / e2eSecSum : null;

  const data = {
    stepCount,
    model: latestModel,
    uncached: sumUncached,
    cached: sumCached,
    cacheWrite: sumCacheWrite,
    output: sumOutput,
    reasoning: sumReasoning,
    usd: sumUsd,
    savedUsd: sumSavedUsd,
    lastStepCacheRate,
    lastContextPrompt,
    contextMax: null,
    tokPerSec: avgDecodeTps ?? lastDecodeTps ?? avgE2eTps,
    lastDecodeTps,
    avgDecodeTps,
    decodeTokensSum,
    decodeSecSum,
    byModelDecode,
    e2eTokPerSec: avgE2eTps,
    durationSec: lastDecodeSec,
    lastEventMs,
    lastUsageEventMs,
    lastSpeedEventMs,
    hasPendingUnfinishedCallAfterLastUsage,
  };

  lruSet(fileParseCache, jsonlPath, { sig, data });
  return data;
}

// --- B. Antigravity Native Protobuf Reader (`conversations/<convId>.db`) ---
function parseProtoSimple(buf) {
  const out = {};
  let pos = 0;
  const len = buf.length;
  while (pos < len) {
    let tag = 0;
    let shift = 0;
    while (pos < len) {
      const b = buf[pos++];
      tag |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7;
    }
    const field = tag >>> 3;
    const wire = tag & 7;
    if (!field) break;
    let val;
    if (wire === 0) {
      let v = 0n;
      let s = 0n;
      while (pos < len) {
        const b = BigInt(buf[pos++]);
        v |= (b & 0x7fn) << s;
        if (!(b & 0x80n)) break;
        s += 7n;
      }
      val = Number(v);
    } else if (wire === 2) {
      let blen = 0;
      let s = 0;
      while (pos < len) {
        const b = buf[pos++];
        blen |= (b & 0x7f) << s;
        if (!(b & 0x80)) break;
        s += 7;
      }
      if (blen < 0 || pos + blen > len) break;
      val = buf.subarray(pos, pos + blen);
      pos += blen;
    } else if (wire === 1) {
      if (pos + 8 > len) break;
      val = buf.readDoubleLE(pos);
      pos += 8;
    } else if (wire === 5) {
      if (pos + 4 > len) break;
      val = buf.readFloatLE(pos);
      pos += 4;
    } else {
      break;
    }
    (out[field] ||= []).push(val);
  }
  return out;
}

function protoTimestampSec(buf) {
  if (!Buffer.isBuffer(buf)) return null;
  const p = parseProtoSimple(buf);
  const sec = p[1]?.[0];
  if (typeof sec !== "number" || sec <= 0) return null;
  return sec + (p[2]?.[0] || 0) / 1e9;
}

let cachedAgyConvDirs = null;
let cachedAgyConvDirsAt = 0;
const CACHED_AGY_TTL_MS = 60 * 1000;
function findAntigravityConvDb(convId) {
  if (!convId || !fs.existsSync(AGY_PROVIDERS_ROOT)) return null;
  const now = Date.now();
  if (!cachedAgyConvDirs || now - cachedAgyConvDirsAt > CACHED_AGY_TTL_MS) {
    try {
      cachedAgyConvDirs = fs
        .readdirSync(AGY_PROVIDERS_ROOT)
        .map((d) => path.join(AGY_PROVIDERS_ROOT, d, "antigravity-acp", "conversations"))
        .filter((p) => fs.existsSync(p));
      cachedAgyConvDirsAt = now;
    } catch {
      cachedAgyConvDirs = [];
      cachedAgyConvDirsAt = now;
    }
  }
  for (const dir of cachedAgyConvDirs) {
    const candidate = path.join(dir, `${convId}.db`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function readAntigravityConvDb(dbFile, fallbackModel) {
  const sig = getFileSig(dbFile);
  if (!sig) return null;
  const cached = lruGet(fileParseCache, dbFile);
  if (cached && cached.sig === sig) return cached.data;

  let adb;
  try {
    adb = new DatabaseSync(dbFile, { open: true, readOnly: true });
    let rows;
    // Detect step_type column lazily: use it when present to filter inference steps.
    try {
      const cols = adb.prepare("PRAGMA table_info(steps)").all();
      const hasStepType = cols.some((c) => c.name === "step_type");
      if (hasStepType) {
        rows = adb
          .prepare("SELECT idx, step_type, metadata FROM steps WHERE metadata IS NOT NULL OR step_type = 15 ORDER BY idx ASC")
          .all();
      } else {
        rows = adb
          .prepare("SELECT idx, metadata FROM steps WHERE metadata IS NOT NULL ORDER BY idx ASC")
          .all();
      }
    } catch {
      rows = adb
        .prepare("SELECT idx, metadata FROM steps WHERE metadata IS NOT NULL ORDER BY idx ASC")
        .all();
    }

    let sumUncached = 0;
    let sumCached = 0;
    let sumCacheWrite = 0;
    let sumOutput = 0;
    let sumReasoning = 0;
    let sumUsd = 0;
    let sumSavedUsd = 0;

    let streamTokensSum = 0;
    let streamSecSum = 0;
    const byModelDecode = {};
    let e2eTokensSum = 0;
    let e2eSecSum = 0;

    let lastStreamTps = null;
    let lastStreamSec = null;
    let lastStepCacheRate = null;
    let lastContextPrompt = null;
    let lastEventMs = null;
    let lastUsageEventMs = null;
    let lastSpeedEventMs = null;
    let hasPendingUnfinishedCallAfterLastUsage = false;
    let latestModel = fallbackModel || null;
    let stepCount = 0;
    const usageSteps = [];

    const parseUsageField = (chunks) => {
      if (!Array.isArray(chunks) || chunks.length === 0) return null;
      const bufs = chunks.filter((c) => Buffer.isBuffer(c));
      if (!bufs.length) return null;
      return parseProtoSimple(bufs.length === 1 ? bufs[0] : Buffer.concat(bufs));
    };
    const lastNum = (arr) => (Array.isArray(arr) && arr.length > 0 ? Number(arr[arr.length - 1]) || 0 : 0);

    for (const r of rows) {
      if (!r.metadata) {
        if (Number(r.step_type) === 15) {
          lastStreamTps = null;
          lastStreamSec = null;
          lastStepCacheRate = null;
          lastSpeedEventMs = null;
          hasPendingUnfinishedCallAfterLastUsage = true;
        }
        continue;
      }
      const f = parseProtoSimple(Buffer.from(r.metadata));
      const t1 = f[1]?.[0] ? protoTimestampSec(f[1][0]) : null;
      const t6 = f[6]?.[0] ? protoTimestampSec(f[6][0]) : null;
      const t7 = f[7]?.[0] ? protoTimestampSec(f[7][0]) : f[8]?.[0] ? protoTimestampSec(f[8][0]) : null;
      const evSec = t7 ?? t6 ?? t1;
      const eventMs = Number.isFinite(evSec) && evSec * 1000 >= 946684800000 ? evSec * 1000 : null;
      if (eventMs != null) lastEventMs = eventMs;
      const u = parseUsageField(f[9]);
      // step_type === 15 marks inference/token-usage steps; when the column exists, prefer it.
      // We still accept any step with valid f[9] usage metadata (e.g. step_type 23) for backward compatibility.
      if (r.step_type != null && Number(r.step_type) !== 15) {
        if (!u) continue;
        const probeTotal =
          lastNum(u[2]) + lastNum(u[5]) + lastNum(u[4]) +
          Math.max(lastNum(u[3]), lastNum(u[9]) + lastNum(u[10]));
        if (probeTotal === 0) continue;
      }
      if (!u) {
        // With the typed schema, a new inference row is a new model call even
        // if its usage submessage is absent. Do not label the previous call's
        // cache rate as the latest one.
        if (r.step_type != null && Number(r.step_type) === 15) {
          lastStreamTps = null;
          lastStreamSec = null;
          lastStepCacheRate = null;
          lastSpeedEventMs = null;
          hasPendingUnfinishedCallAfterLastUsage = true;
        }
        continue;
      }

      // Do not carry the previous inference step's rate into this step when
      // the newest step has no valid visible-output/decode window.
      lastStreamTps = null;
      lastStreamSec = null;
      lastSpeedEventMs = null;
      lastStepCacheRate = null;
      const uncached = Math.max(0, lastNum(u[2]));
      const cacheRead = Math.max(0, lastNum(u[5]));
      const cacheWrite = Math.max(0, lastNum(u[4]));
      const reasoning = Math.max(0, lastNum(u[9]));
      const visOut = Math.max(0, lastNum(u[10]));
      const output = Math.max(lastNum(u[3]), reasoning + visOut);

      const promptTotal = uncached + cacheRead + cacheWrite;
      if (promptTotal + output === 0) {
        if (Number(r.step_type) === 15) hasPendingUnfinishedCallAfterLastUsage = true;
        continue;
      }
      stepCount++;
      lastUsageEventMs = eventMs;
      hasPendingUnfinishedCallAfterLastUsage = false;

      // Model extraction from step field 24
      if (f[24]?.[0]) {
        const mProto = parseProtoSimple(f[24][0]);
        const mStr = (mProto[12]?.[0] || mProto[8]?.[0])?.toString("utf8");
        if (mStr && !mStr.startsWith("MODEL_")) {
          latestModel = mStr.trim().toLowerCase().replace(/\s+/g, "-");
        }
      }

      sumUncached += uncached;
      sumCached += cacheRead;
      sumCacheWrite += cacheWrite;
      sumOutput += output;
      sumReasoning += Math.min(output, reasoning);

      const priced = priceStep(
        { uncached, cached: cacheRead, cacheWrite, output },
        latestModel,
        "gemini"
      );
      sumUsd += priced.usd;
      sumSavedUsd += priced.savedUsd;

      if (promptTotal > 0) {
        lastStepCacheRate = cacheRead / promptTotal;
        lastContextPrompt = promptTotal + output;
        usageSteps.push({ eventMs, prompt: promptTotal, cached: cacheRead });
      }

      // Pure API E2E duration (excludes all bash/tool execution wait time!)
      if (t1 && t7 && t7 > t1 + 0.05 && output > 0) {
        e2eTokensSum += output;
        e2eSecSum += t7 - t1;
      }

      // Streaming text decode window (t6 -> t7). Exclude buffered unary tool-call bursts (<0.18s or >900 tok/s).
      const streamTok = visOut > 0 ? visOut : output;
      if (t6 && t7 && t7 - t6 >= 0.18 && streamTok >= 25) {
        const sDur = t7 - t6;
        const sTps = streamTok / sDur;
        if (sTps <= 900) {
          streamTokensSum += streamTok;
          streamSecSum += sDur;
          if (latestModel) { const bm = (byModelDecode[latestModel] ||= { tok: 0, sec: 0 }); bm.tok += streamTok; bm.sec += sDur; }
          lastStreamTps = sTps;
          lastStreamSec = sDur;
          lastSpeedEventMs = eventMs;
        }
      }
    }

    const avgDecodeTps = streamSecSum > 0.2 ? streamTokensSum / streamSecSum : null;
    const avgE2eTps = e2eSecSum > 0.2 ? e2eTokensSum / e2eSecSum : null;

    const data = {
      stepCount,
      model: latestModel,
      uncached: sumUncached,
      cached: sumCached,
      cacheWrite: sumCacheWrite,
      output: sumOutput,
      reasoning: sumReasoning,
      usd: sumUsd,
      savedUsd: sumSavedUsd,
      lastStepCacheRate,
      lastContextPrompt,
      contextMax: null,
      tokPerSec: avgDecodeTps ?? lastStreamTps ?? avgE2eTps,
      lastDecodeTps: lastStreamTps,
      avgDecodeTps,
      decodeTokensSum: streamTokensSum,
      decodeSecSum: streamSecSum,
      byModelDecode,
      e2eTokPerSec: avgE2eTps,
      durationSec: lastStreamSec,
      lastEventMs,
      lastUsageEventMs,
      lastSpeedEventMs,
      hasPendingUnfinishedCallAfterLastUsage,
      usageSteps,
    };

    lruSet(fileParseCache, dbFile, { sig, data });
    return data;
  } catch {
    return null;
  } finally {
    try {
      adb?.close();
    } catch {}
  }
}

// --- C. Codex Native JSONL Reader (`~/.codex/sessions/YYYY/MM/DD/*-<nativeId>.jsonl`) ---
let codexIndexMap = null;
let codexIndexBuiltAt = 0;

function getCodexSessionIndex() {
  const now = Date.now();
  if (codexIndexMap && now - codexIndexBuiltAt < 15000) return codexIndexMap;
  const map = new Map();
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.name.endsWith(".jsonl")) {
        const m = ent.name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
        if (m) map.set(m[1], full);
      }
    }
  }
  if (fs.existsSync(CODEX_SESSIONS_ROOT)) walk(CODEX_SESSIONS_ROOT);
  codexIndexMap = map;
  codexIndexBuiltAt = now;
  return map;
}

function findCodexSessionJsonl(nativeId) {
  if (!nativeId || !fs.existsSync(CODEX_SESSIONS_ROOT)) return null;
  const basename = `${nativeId}.jsonl`;
  for (const dayDir of dateDirsFromUuidV7(nativeId, CODEX_SESSIONS_ROOT)) {
    if (!fs.existsSync(dayDir)) continue;
    try {
      const hit = fs.readdirSync(dayDir).find((f) => f === basename || f.endsWith(`-${basename}`));
      if (hit) return path.join(dayDir, hit);
    } catch {}
  }
  return getCodexSessionIndex().get(nativeId) || null;
}

function readCodexSessionFile(jsonlPath, fallbackModel) {
  const sig = getFileSig(jsonlPath);
  if (!sig) return null;
  const cached = lruGet(fileParseCache, jsonlPath);
  if (cached && cached.sig === sig) return cached.data;

  let sumUncached = 0;
  let sumCached = 0;
  let sumCacheWrite = 0;
  let sumOutput = 0;
  let sumReasoning = 0;
  let sumUsd = 0;
  let sumSavedUsd = 0;

  let decodeTokensSum = 0;
  let decodeSecSum = 0;
  const byModelDecode = {};
  let e2eTokensSum = 0;
  let e2eSecSum = 0;
  let lastDecodeTps = null;
  let lastDecodeSec = null;
  let lastE2eSec = null;
  let lastStepCacheRate = null;
  let lastContextPrompt = null;
  let lastContextPromptEventMs = null;
  let lastEventMs = null;
  let lastUsageEventMs = null;
  let lastSpeedEventMs = null;
  let hasPendingUnfinishedCallAfterLastUsage = false;
  let codexContextMax = null;
  let contextMaxEventMs = null;
  let latestModel = fallbackModel || null;
  let stepCount = 0;

  let stepInputReadyMs = null;
  let reasoningDoneMs = null;

  forEachJsonlLineSync(jsonlPath, (line) => {
    if (!line) return;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      return;
    }
    const tsMs = rec.timestamp ? Date.parse(rec.timestamp) : null;
    const eventMs = Number.isFinite(tsMs) && tsMs >= 946684800000 ? tsMs : null;
    if (eventMs != null) lastEventMs = eventMs;
    const p = rec.payload;
    if (rec.type === "model_response_created" ||
      (rec.type === "event_msg" && ["model_response_created", "task_started", "turn_started", "turn_start", "request_started"].includes(p?.type)) ||
      (rec.type === "response_item" && p?.type === "message" && p?.role === "user")) {
      hasPendingUnfinishedCallAfterLastUsage = true;
      stepInputReadyMs = tsMs;
      reasoningDoneMs = null;
    }

    if (p?.thread_settings?.model) {
      latestModel = p.thread_settings.model;
    } else if (typeof p?.model === "string") {
      latestModel = p.model;
    }
    if (rec.type === "event_msg" && p?.type === "token_count") {
      const reportedMax = Number(p?.info?.model_context_window);
      if (Number.isFinite(reportedMax) && reportedMax > 0) {
        codexContextMax = reportedMax;
        contextMaxEventMs = eventMs;
      }
    }

    if (
      (rec.type === "event_msg" && p?.item?.type === "UserMessage") ||
      (rec.type === "response_item" && p?.type === "custom_tool_call_output") ||
      (rec.type === "response_item" && p?.type === "function_call_output")
    ) {
      stepInputReadyMs = tsMs;
      reasoningDoneMs = null;
      hasPendingUnfinishedCallAfterLastUsage = true;
    } else if (rec.type === "response_item" && p?.type === "reasoning") {
      reasoningDoneMs = tsMs;
    } else if (rec.type === "token_usage_record") {
      // Each usage record closes a turn/step. Clear the prior sample first so
      // an empty, zero-duration, or too-small latest turn cannot inherit it.
      lastDecodeTps = null;
      lastDecodeSec = null;
      lastE2eSec = null;
      lastStepCacheRate = null;
      lastUsageEventMs = null;
      lastSpeedEventMs = null;
      hasPendingUnfinishedCallAfterLastUsage = false;
      if (!p?.usage) {
        stepCount++;
        stepInputReadyMs = tsMs;
        reasoningDoneMs = null;
        return;
      }
      const u = p.usage;
      const inp = Math.max(0, Number(u.input_tokens) || 0);
      const cr = Math.min(inp, Math.max(0, Number(u.cached_input_tokens) || 0));
      const cw = Math.min(inp - cr, Math.max(0, Number(u.cache_write_input_tokens) || 0));
      const uncached = Math.max(0, inp - cr - cw);
      const out = Math.max(0, Number(u.output_tokens) || 0);
      const reas = Math.min(out, Math.max(0, Number(u.reasoning_output_tokens) || 0));

      if (inp + out === 0) {
        stepCount++;
        stepInputReadyMs = tsMs;
        reasoningDoneMs = null;
        return;
      }
      stepCount++;

      lastUsageEventMs = eventMs;

      sumUncached += uncached;
      sumCached += cr;
      sumCacheWrite += cw;
      sumOutput += out;
      sumReasoning += reas;

      const priced = priceStep({ uncached, cached: cr, cacheWrite: cw, output: out }, latestModel, "openai");
      sumUsd += priced.usd;
      sumSavedUsd += priced.savedUsd;

      if (inp > 0) {
        lastStepCacheRate = cr / inp;
        lastContextPrompt = inp + out;
        lastContextPromptEventMs = eventMs;
      }

      if (tsMs && stepInputReadyMs && tsMs > stepInputReadyMs + 50 && out > 0) {
        e2eTokensSum += out;
        e2eSecSum += (tsMs - stepInputReadyMs) / 1000;
        lastE2eSec = (tsMs - stepInputReadyMs) / 1000;
      }
      const visOut = Math.max(0, out - reas);
      if (tsMs && reasoningDoneMs && tsMs > reasoningDoneMs + 80 && visOut >= 15) {
        const dSec = (tsMs - reasoningDoneMs) / 1000;
        if (visOut / dSec <= 1500) {
          decodeTokensSum += visOut;
          decodeSecSum += dSec;
          lastDecodeSec = dSec;
          if (latestModel) { const bm = (byModelDecode[latestModel] ||= { tok: 0, sec: 0 }); bm.tok += visOut; bm.sec += dSec; }
          lastDecodeTps = visOut / dSec;
          lastSpeedEventMs = eventMs;
        }
      }
      stepInputReadyMs = tsMs;
      reasoningDoneMs = null;
    }
  });

  const avgDecodeTps = decodeSecSum > 0.1 ? decodeTokensSum / decodeSecSum : null;
  const avgE2eTps = e2eSecSum > 0.1 ? e2eTokensSum / e2eSecSum : null;

  const data = {
    stepCount,
    model: latestModel,
    uncached: sumUncached,
    cached: sumCached,
    cacheWrite: sumCacheWrite,
    output: sumOutput,
    reasoning: sumReasoning,
    usd: sumUsd,
    savedUsd: sumSavedUsd,
    lastStepCacheRate,
    lastContextPrompt,
    lastContextPromptEventMs,
    contextMax: codexContextMax,
    contextMaxEventMs,
    contextMaxSource: codexContextMax != null ? "reported" : null,
    tokPerSec: avgDecodeTps ?? lastDecodeTps ?? avgE2eTps,
    lastDecodeTps,
    avgDecodeTps,
    decodeTokensSum,
    decodeSecSum,
    e2eTokPerSec: avgE2eTps,
    durationSec: lastDecodeSec ?? lastE2eSec,
    lastEventMs,
    lastUsageEventMs,
    lastSpeedEventMs,
    hasPendingUnfinishedCallAfterLastUsage,
  };

  lruSet(fileParseCache, jsonlPath, { sig, data });
  return data;
}

// --- D. Devin CLI Native SQLite Reader (`~/.local/share/devin/cli/sessions.db`) ---
function normalizeEffectiveDriver(driver, providerOrInstance) {
  if (driver === "acpRegistry" && providerOrInstance && String(providerOrInstance).startsWith("acpRegistry_")) {
    return String(providerOrInstance);
  }
  return driver || providerOrInstance || null;
}

function driversCompatible(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const sa = String(a);
  const sb = String(b);
  return (sa === "acpRegistry" && sb.startsWith("acpRegistry_")) || (sb === "acpRegistry" && sa.startsWith("acpRegistry_"));
}

function findDevinSessionsDb() {
  const home = process.env.HOME || os.homedir();
  const dataRoot = process.env.DEVIN_DATA_DIR
    ? path.resolve(process.env.DEVIN_DATA_DIR)
    : process.env.XDG_DATA_HOME
      ? path.join(path.resolve(process.env.XDG_DATA_HOME), "devin")
      : path.join(home, ".local", "share", "devin");
  const candidate = path.join(dataRoot, "cli", "sessions.db");
  try {
    return fs.existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function readDevinSessionDb(sessionId, fallbackModel, overrideDbPath = null) {
  if (!sessionId || typeof sessionId !== "string") return null;
  const dbPath = overrideDbPath || findDevinSessionsDb();
  if (!dbPath) return null;
  const sig = getFileSig(dbPath);
  if (!sig) return null;
  const cacheKey = `devin:${dbPath}:${sessionId}`;
  const cached = lruGet(fileParseCache, cacheKey);
  if (cached && cached.sig === sig) return cached.data;

  let ddb;
  try {
    ddb = new DatabaseSync(dbPath, { open: true, readOnly: true });
    const sessRow = ddb.prepare("SELECT model FROM sessions WHERE id = ?").get(sessionId);
    const rows = ddb
      .prepare("SELECT row_id, created_at, chat_message FROM message_nodes WHERE session_id = ? ORDER BY row_id ASC")
      .all(sessionId);

    let sumUncached = 0;
    let sumCached = 0;
    let sumCacheWrite = 0;
    let sumOutput = 0;
    let sumReasoning = 0;
    let sumUsd = 0;
    let sumSavedUsd = 0;
    let decodeTokensSum = 0;
    let decodeSecSum = 0;
    let e2eTokensSum = 0;
    let e2eSecSum = 0;
    const byModelDecode = {};
    let lastDecodeTps = null;
    let lastDecodeSec = null;
    let lastStepCacheRate = null;
    let lastContextPrompt = null;
    let lastEventMs = null;
    let lastUsageEventMs = null;
    let lastSpeedEventMs = null;
    let latestModel = (sessRow?.model && String(sessRow.model).trim()) || fallbackModel || null;
    let stepCount = 0;
    const seenRequests = new Set();
    const usageSteps = [];

    for (const r of rows) {
      const cm = safeJsonParse(r.chat_message);
      if (!cm || cm.role !== "assistant") continue;
      const meta = cm.metadata;
      const metrics = meta?.metrics;
      if (!metrics || typeof metrics !== "object") continue;

      const createdMsRaw = meta.created_at
        ? Date.parse(meta.created_at)
        : Number.isFinite(r.created_at)
          ? r.created_at * 1000
          : typeof r.created_at === "string"
            ? Date.parse(r.created_at)
            : NaN;
      const eventMs = Number.isFinite(createdMsRaw) && createdMsRaw >= 946684800000 ? createdMsRaw : null;
      const reqKey =
        (typeof meta.request_id === "string" && meta.request_id.trim()) ||
        `${meta.started_generation_at || ""}|${meta.created_at || r.created_at || ""}|${metrics.output_tokens ?? ""}`;
      if (seenRequests.has(reqKey)) continue;
      seenRequests.add(reqKey);

      // Clear prior step metrics first so an empty or zero-prompt latest call never leaks stale values.
      lastStepCacheRate = null;
      lastDecodeTps = null;
      lastDecodeSec = null;
      lastSpeedEventMs = null;

      if (eventMs != null) {
        lastEventMs = eventMs;
        lastUsageEventMs = eventMs;
      }
      const stepModel =
        (typeof meta.generation_model === "string" && meta.generation_model.trim()) ||
        latestModel;
      if (stepModel) latestModel = stepModel;

      const unc = Math.max(0, Number(metrics.input_tokens) || 0);
      const cr = Math.max(0, Number(metrics.cache_read_tokens ?? metrics.cached_input_tokens ?? metrics.cache_read_input_tokens) || 0);
      const cw = Math.max(0, Number(metrics.cache_creation_tokens) || 0);
      const out = Math.max(0, Number(metrics.output_tokens) || 0);
      const ctxIn = Number.isFinite(Number(metrics.context_input_tokens)) && Number(metrics.context_input_tokens) > 0
        ? Number(metrics.context_input_tokens)
        : unc + cr + cw;

      sumUncached += unc;
      sumCached += cr;
      sumCacheWrite += cw;
      sumOutput += out;
      stepCount++;

      const priced = priceStep({ uncached: unc, cached: cr, cacheWrite: cw, output: out }, stepModel, "acpRegistry_devin");
      sumUsd += priced.usd;
      sumSavedUsd += priced.savedUsd;

      const totalPrompt = unc + cr + cw;
      if (totalPrompt > 0) {
        lastStepCacheRate = Math.min(totalPrompt, cr) / totalPrompt;
        usageSteps.push({ eventMs, prompt: totalPrompt, cached: Math.min(totalPrompt, cr) });
      }
      if (ctxIn > 0 || out > 0) lastContextPrompt = ctxIn + out;

      const totalMs = Number(metrics.total_time_ms);
      const ttftMs = Number(metrics.ttft_ms);
      const decodeSec = Number.isFinite(totalMs) && Number.isFinite(ttftMs) && totalMs > ttftMs
        ? (totalMs - ttftMs) / 1000
        : null;
      const e2eSec = Number.isFinite(totalMs) && totalMs > 0 ? totalMs / 1000 : null;

      if (e2eSec != null && e2eSec >= 0.1 && out > 0) {
        e2eTokensSum += out;
        e2eSecSum += e2eSec;
      }
      if (out >= 15 && decodeSec != null && decodeSec >= 0.15 && out / decodeSec <= 1500) {
        const tps = out / decodeSec;
        decodeTokensSum += out;
        decodeSecSum += decodeSec;
        lastDecodeTps = tps;
        lastDecodeSec = decodeSec;
        if (eventMs != null) lastSpeedEventMs = eventMs;
        if (stepModel) {
          const cur = (byModelDecode[stepModel] ||= { tok: 0, sec: 0 });
          cur.tok += out;
          cur.sec += decodeSec;
        }
      } else if (out >= 15 && e2eSec != null && e2eSec >= 0.15 && out / e2eSec <= 1500) {
        const tps = out / e2eSec;
        decodeTokensSum += out;
        decodeSecSum += e2eSec;
        lastDecodeTps = tps;
        lastDecodeSec = e2eSec;
        if (eventMs != null) lastSpeedEventMs = eventMs;
        if (stepModel) {
          const cur = (byModelDecode[stepModel] ||= { tok: 0, sec: 0 });
          cur.tok += out;
          cur.sec += e2eSec;
        }
      }
    }

    if (stepCount === 0) return null;
    const avgDecodeTps = decodeSecSum > 0.1 ? decodeTokensSum / decodeSecSum : null;
    const avgE2eTps = e2eSecSum > 0.1 ? e2eTokensSum / e2eSecSum : null;
    const data = {
      stepCount,
      model: latestModel,
      uncached: sumUncached,
      cached: sumCached,
      cacheWrite: sumCacheWrite,
      output: sumOutput,
      reasoning: sumReasoning,
      usd: sumUsd,
      savedUsd: sumSavedUsd,
      lastStepCacheRate,
      lastContextPrompt,
      contextMax: null,
      tokPerSec: avgDecodeTps ?? lastDecodeTps ?? avgE2eTps,
      lastDecodeTps,
      avgDecodeTps,
      decodeTokensSum,
      decodeSecSum,
      byModelDecode,
      e2eTokPerSec: avgE2eTps,
      durationSec: lastDecodeSec,
      lastEventMs,
      lastUsageEventMs,
      lastSpeedEventMs,
      hasPendingUnfinishedCallAfterLastUsage: false,
      usageSteps,
    };
    lruSet(fileParseCache, cacheKey, { sig, data });
    return data;
  } catch {
    return null;
  } finally {
    if (ddb) {
      try { ddb.close(); } catch {}
    }
  }
}

function resolveCodexSessionContext(parts, report, activeProviderThreadId) {
  let part;
  if (activeProviderThreadId) {
    part = report?.isActive ? parts.find((candidate) => candidate.nativeId === report.nativeId) : null;
  } else {
    // Older projections omit the active ID. Prefer context events, then file
    // order for sessions that have no timestamps in their usage records.
    const eventTime = (candidate) => Math.max(candidate.lastContextPromptEventMs ?? 0, candidate.contextMaxEventMs ?? 0);
    for (const candidate of parts) {
      if (!part || eventTime(candidate) > eventTime(part) ||
          (eventTime(candidate) === eventTime(part) && candidate.mtimeMs >= part.mtimeMs)) {
        part = candidate;
      }
    }
  }

  const resolveField = (nativeValue, nativeEventMs, reportedValue) => {
    if (nativeValue == null) return reportedValue ?? null;
    if (reportedValue == null) return nativeValue;
    const nativeMs = nativeEventMs ?? (activeProviderThreadId ? null : part.mtimeMs);
    if (Number.isFinite(nativeMs) && nativeMs > report.updatedMs) return nativeValue;
    return reportedValue;
  };

  return {
    used: resolveField(part?.lastContextPrompt, part?.lastContextPromptEventMs, report?.used),
    max: resolveField(part?.contextMax, part?.contextMaxEventMs, report?.max),
    model: part?.model ?? null,
  };
}

// ============================================================================
// 3. Thread Telemetry Aggregator (Merges Native Telemetry + Subagent Tree)
// ============================================================================
function safeJsonParse(str) {
  if (!str || typeof str !== "string") return null;
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function cacheRateForTurnUsage(usage, driver) {
  if (!usage || usage.usageStatus === "unavailable" || !Number.isFinite(usage.inputTokens) || !Number.isFinite(usage.cachedInputTokens)) return null;
  let input = Math.max(0, usage.inputTokens || 0);
  const cached = Math.max(0, Number(usage.cachedInputTokens) || 0);
  if (driver === "antigravity" && input >= cached * 2) {
    // statev2's Antigravity prompt usage double-counts cachedInputTokens.
    // Native SQLite protobuf usage is handled separately and is never deduped.
    input -= cached;
  }
  return input > 0 ? Math.min(input, cached) / input : null;
}

function latestProviderTurnCacheRate(turnRows, fallbackDriver) {
  const latest = turnRows?.[turnRows.length - 1];
  if (!latest) return null;
  const payload = safeJsonParse(latest.payload_json);
  return cacheRateForTurnUsage(payload?.turnTokenUsage, payload?.nativeTurnRef?.driver || payload?.driver || fallbackDriver);
}

function estimateTextTokens(str) {
  if (!str) return 0;
  let cjk = 0;
  const len = str.length;
  for (let i = 0; i < len; i++) {
    if (str.charCodeAt(i) > 0x2e80) cjk++;
  }
  return cjk * 0.72 + (len - cjk) * 0.27;
}

function latestTurnIdentityIds(latestTurn) {
  const ids = new Set();
  const push = (v) => { if (v != null && String(v) !== "") ids.add(String(v)); };
  if (!latestTurn) return ids;
  try { push(latestTurn.row?.provider_turn_id); } catch {}
  try { push(latestTurn.row?.turn_id); } catch {}
  try { push(latestTurn.row?.id); } catch {}
  const p = latestTurn.payload || {};
  push(p.id);
  push(p.turnId);
  push(p.providerTurnId);
  push(p.providerTurn?.id);
  push(p.turn?.id);
  push(p.nativeTurnRef?.nativeId);
  return ids;
}

function itemTurnIdentityIds(p, row) {
  const ids = new Set();
  const push = (v) => { if (v != null && String(v) !== "") ids.add(String(v)); };
  if (p) {
    push(p.turnId);
    push(p.providerTurnId);
    push(p.providerTurn?.id);
    push(p.turn?.id);
    push(p.turn_id);
    push(p.nativeTurnRef?.nativeId);
  }
  if (row) {
    push(row.turn_id);
    push(row.provider_turn_id);
  }
  return ids;
}

function itemDriverOf(p, row) {
  const drivers = new Set();
  const add = (v) => {
    if (v != null && String(v).trim() !== "") drivers.add(String(v).trim());
  };
  if (p) {
    add(p.driver);
    add(p.provider);
    add(p.nativeTurnRef?.driver);
    add(p.nativeItemRef?.driver);
    add(p.payload?.driver);
    add(p.payload?.provider);
    add(p.payload?.nativeTurnRef?.driver);
    add(p.payload?.nativeItemRef?.driver);
  }
  if (row) {
    add(row.driver);
    add(row.provider);
  }
  if (drivers.size === 0) return null;
  if (drivers.size > 1) return "__conflicting_driver__";
  return [...drivers][0];
}

function itemBelongsToCurrentTurn(p, row, latestTurnIds, effDriver) {
  const itemIds = itemTurnIdentityIds(p, row);
  const itemDriver = itemDriverOf(p, row);
  if (itemDriver === "__conflicting_driver__") return false;
  if (itemDriver != null && effDriver != null && !driversCompatible(itemDriver, effDriver)) return false;
  if (itemIds.size === 0 || !latestTurnIds || latestTurnIds.size === 0) return false;
  for (const id of itemIds) {
    if (latestTurnIds.has(id)) return true;
  }
  return false;
}

function safeTurnItemRows(db, threadId) {
  try {
    const colsRows = db.prepare('PRAGMA table_info("orchestration_v2_projection_turn_items")').all();
    const cols = new Set((colsRows || []).map((r) => r.name));
    if (cols.size === 0) throw new Error("no cols");
    const sel = ["payload_json"];
    for (const c of ["turn_id", "provider_turn_id", "driver", "provider", "ordinal", "type", "updated_at"]) {
      if (cols.has(c)) sel.push(c);
    }
    const sql = `SELECT ${sel.map((s) => `"${s}"`).join(", ")} FROM orchestration_v2_projection_turn_items WHERE thread_id = ?`;
    return db.prepare(sql).all(threadId);
  } catch {
    return db.prepare("SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE thread_id = ?").all(threadId);
  }
}

function isDbTurnStaticallyActive(latestTurn, effDriver) {
  if (!latestTurn) return false;
  const row = latestTurn.row || {};
  const payload = latestTurn.payload || {};
  const st = String(row.status || payload.status || "").toLowerCase();
  if (st === "completed" || st === "interrupted" || st === "failed" || st === "error" || st === "cancelled" || st === "canceled") return false;
  if (st !== "running" && st !== "pending" && st !== "starting" && st !== "in_progress") return false;
  const completedAt = row.completed_at || payload.completedAt || payload.completed_at || null;
  if (completedAt != null && completedAt !== "") {
    const ms = typeof completedAt === "number" ? completedAt : Date.parse(completedAt);
    if (Number.isFinite(ms)) return false;
    if (typeof completedAt === "string" && completedAt.trim() !== "") return false;
  }
  const d = payload?.nativeTurnRef?.driver || payload?.driver || row?.driver || null;
  if (d != null && effDriver != null && !driversCompatible(d, effDriver)) return false;
  return true;
}

function isRemoteTurnActive(last, selectedProvider) {
  if (!last) return false;
  const st = String(last.status || "").toLowerCase();
  if (st === "completed" || st === "interrupted" || st === "failed" || st === "error" || st === "cancelled" || st === "canceled") return false;
  if (st === "running" || st === "pending" || st === "starting" || st === "in_progress") {
    const d = last.driver || null;
    if (d != null && selectedProvider != null && !driversCompatible(d, selectedProvider)) return false;
    return true;
  }
  const completedMs = last.completedMs ?? last.completedAt ?? null;
  const startedMs = last.startedMs ?? last.startedAt ?? null;
  if (completedMs != null && startedMs != null && Number(completedMs) > Number(startedMs)) return false;
  if (completedMs != null && startedMs == null) return false;
  return false;
}

// Strictly attributed estimate for the current running turn only.
// Returns null unless a sub-step sample is provably part of latestTurn (turn identity + driver + timestamp >= latestTurn.stamp, positive output, valid duration).
function computeCurrentTurnEstimateTps({ db, threadId, latestTurn, latestTurnDriver, effDriver, isRunning, nowMs = Date.now() }) {
  if (!isRunning) return null;
  if (!latestTurn || !Number.isFinite(latestTurn.stamp) || !isDbTurnStaticallyActive(latestTurn, effDriver)) return null;
  if (latestTurnDriver && !driversCompatible(latestTurnDriver, effDriver)) return null;
  const latestTurnIds = latestTurnIdentityIds(latestTurn);
  let toolIntervals = [];
  let items = [];
  try {
    const rows = safeTurnItemRows(db, threadId);
    for (const row of rows) {
      const p = safeJsonParse(row.payload_json);
      if (!p) continue;
      items.push({ p, row });
      if (!["root_turn", "assistant_message", "reasoning", "user_message", "checkpoint", "notification"].includes(p.type)) {
        if (!itemBelongsToCurrentTurn(p, row, latestTurnIds, effDriver)) continue;
        const s = Date.parse(p.startedAt);
        let e = Date.parse(p.completedAt);
        const status = String(p.status || "").toLowerCase();
        if (p.completedAt == null && (!status || ["running", "pending", "in_progress", "starting"].includes(status)) && s >= latestTurn.stamp) {
          const updatedMs = Date.parse(p.updatedAt || row.updated_at || "");
          e = Number.isFinite(updatedMs) && updatedMs > s ? Math.max(nowMs, updatedMs) : nowMs;
        }
        if (Number.isFinite(s) && Number.isFinite(e) && e > s && e - s < 600000) toolIntervals.push([s, e]);
      }
    }
  } catch {
    return null;
  }
  const candidates = [];
  for (const { p, row } of items) {
    if (p.type !== "assistant_message" && p.type !== "reasoning") continue;
    if (!itemBelongsToCurrentTurn(p, row, latestTurnIds, effDriver)) continue;
    const s = Date.parse(p.startedAt);
    const e = p.completedAt ? Date.parse(p.completedAt) : Date.parse(p.updatedAt || row.updated_at || "") || nowMs;
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s + 50) continue;
    if (s < latestTurn.stamp) continue;
    const explicitOut = p.outputTokens ?? p.output_tokens ?? p.output ?? p.usage?.outputTokens ?? p.usage?.output_tokens ?? p.tokenCount ?? p.estimatedTokens;
    let out = Number(explicitOut);
    if (!Number.isFinite(out) || out <= 0) {
      // No explicit token count: estimate from real text with CJK weighting.
      let text = "";
      for (const c of [p.text, p.delta, p.content]) {
        if (typeof c === "string" && c.length > 0) text += c;
        else if (Array.isArray(c)) {
          for (const part of c) {
            if (typeof part === "string") text += part;
            else if (part && typeof part.text === "string") text += part.text;
          }
        }
      }
      if (text.length > 0) {
        out = estimateTextTokens(text);
      } else if (Number.isFinite(Number(p.charCount)) && Number(p.charCount) > 0) {
        // Bare charCount without text is never a token count; use a conservative factor.
        out = Number(p.charCount) * 0.28;
      } else {
        continue;
      }
    }
    if (!Number.isFinite(out) || out <= 0) continue;
    const netSec = subtractToolWait(s, e, toolIntervals);
    if (!(netSec > 0.05)) continue;
    const tps = out / netSec;
    if (!Number.isFinite(tps) || tps <= 0 || tps > 1500) continue;
    candidates.push({ out, netSec });
  }
  if (candidates.length > 0) {
    const sumOut = candidates.reduce((a, c) => a + c.out, 0);
    const sumSec = candidates.reduce((a, c) => a + c.netSec, 0);
    if (!(sumSec > 0.05)) return null;
    const agg = sumOut / sumSec;
    return Number.isFinite(agg) && agg > 0 && agg <= 1500 ? Math.round(agg * 10) / 10 : null;
  }
  // Fallback: interim usage on the running turn itself (if upstream already reported partial usage while still running)
  try {
    const u = latestTurn.payload?.turnTokenUsage;
    const out = Number(u?.outputTokens);
    if (Number.isFinite(out) && out > 0) {
      const sMs = latestTurn.stamp;
      const completed = latestTurn.row.completed_at || latestTurn.payload?.completedAt;
      const itemStamps = items.filter(({ p, row }) => itemBelongsToCurrentTurn(p, row, latestTurnIds, effDriver))
        .flatMap(({ p, row }) => [p.completedAt, p.updatedAt, row.updated_at, p.startedAt].map(value => Date.parse(value || "")))
        .filter(value => Number.isFinite(value) && value >= sMs);
      const eMs = completed ? Date.parse(completed) : itemStamps.length ? Math.max(...itemStamps) : nowMs;
      if (Number.isFinite(eMs) && eMs > sMs + 50) {
        const netSec = subtractToolWait(sMs, eMs, toolIntervals);
        if (netSec > 0.05) {
          const tps = out / netSec;
          if (Number.isFinite(tps) && tps > 0 && tps <= 1500) return Math.round(tps * 10) / 10;
        }
      }
    }
  } catch {}
  return null;
}

function extractThreadId(hint) {
  if (!hint || typeof hint !== "string") return null;
  const trimmed = normalizeT3RouteHint(hint);
  if (trimmed.startsWith("__ROUTE_")) return trimmed;
  // Draft IDs (including UUID-looking ones) are never server thread IDs.
  // Handle the renderer sentinel too, before the latest-thread fallback.
  if (trimmed === "__NEW__") return "__NEW__";
  if (trimmed.startsWith("thread:")) return trimmed;

  const rawSegments = trimmed.replace(/^\/|\/$/g, "").split("/");
  const segments = rawSegments.filter(Boolean);
  // HUD routes preserve the thread identity even for legacy non-UUID IDs.
  // Invalid scoped routes must not fall through to the latest-thread query.
  if (segments[0] === "_t3_env_") {
    if (rawSegments.some((seg) => !seg) || segments.length < 3) return "__ROUTE_invalid__";
    try {
      const env = decodeURIComponent(segments[1]);
      const tid = decodeURIComponent(segments[2]);
      if ([env, tid].some((id) => !id || id === "." || id === "..")) return "__ROUTE_invalid__";
      // Scoped project/workspace drafts are the only project-shaped
      // exception to /_t3_env_/<environment>/<thread>.
      if (/^(projects?|workspaces?)$/i.test(env) && ["new", "draft"].includes((segments[3] || "").toLowerCase())) {
        if (segments.length > 5) return "__ROUTE_invalid__";
        if (segments[4]) decodeURIComponent(segments[4]);
        return "__NEW__";
      }
      if (["new", "draft"].includes(tid.toLowerCase())) {
        if (segments.length > 4) return "__ROUTE_invalid__";
        if (segments[3]) decodeURIComponent(segments[3]);
        return "__NEW__";
      }
      if (segments.length !== 3) return "__ROUTE_invalid__";
      if (["settings", "usage", "pair"].includes(tid.toLowerCase())) return `__ROUTE_${tid.toLowerCase()}__`;
      return tid;
    } catch { return "__ROUTE_invalid__"; }
  }
  if (/^\/?(?:_t3_env_\/[^/]+\/)?draft(?:\/|$)/i.test(trimmed)) return "__NEW__";
  if (trimmed === "/new" || trimmed.endsWith("/new")) return "__NEW__";
  // Native routes carry the exact thread identity in the second segment;
  // older/imported thread IDs are not necessarily UUIDs.
  if (rawSegments.length === 2 && rawSegments.every(Boolean) &&
      !["threads", "_chat", "projects", "project", "workspaces", "workspace", "draft", "new", "_t3_env_", "settings", "usage", "pair"].includes(segments[0].toLowerCase())) {
    try {
      const env = decodeURIComponent(segments[0]);
      const tid = decodeURIComponent(segments[1]);
      if ([env, tid].some((id) => !id || id === "." || id === "..")) return "__ROUTE_invalid__";
      if (["new", "draft"].includes(tid.toLowerCase())) return "__NEW__";
      return tid;
    } catch { return "__ROUTE_invalid__"; }
  }
  for (let i = segments.length - 1; i >= 0; i--) {
    let seg = segments[i];
    if (seg.startsWith("thread%3A") || seg.startsWith("thread%3a")) {
      try {
        seg = decodeURIComponent(seg);
      } catch {}
    }
    if (seg === "settings" || seg === "usage" || seg === "pair") return `__ROUTE_${seg}__`;
    if (seg.startsWith("thread:")) return seg;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) {
      return seg;
    }
  }
  return null;
}

function normalizeT3RouteHint(hint) {
  let route = String(hint || "").trim();
  if (/^[a-z][\w+.-]*:\/\//i.test(route)) {
    try { const url = new URL(route); route = url.hash.startsWith("#/") ? url.hash.slice(1) : url.pathname; } catch {}
  } else if (route.startsWith("#")) route = route.slice(1);
  return route.split(/[?#]/, 1)[0];
}

function aggregateSingleThreadTelemetry(db, threadId, fallbackModel, fallbackProvider, activeProviderThreadId) {
  const pThreadRows = db
    .prepare(
      "SELECT provider_thread_id, driver, updated_at, payload_json FROM orchestration_v2_projection_provider_threads WHERE thread_id = ? ORDER BY rowid ASC"
    )
    .all(threadId);

  let rawTurnRows;
  try {
    const colsRows = db.prepare('PRAGMA table_info("orchestration_v2_projection_provider_turns")').all();
    const cols = new Set((colsRows || []).map((r) => r.name));
    if (cols.size === 0) throw new Error("no cols");
    const sel = ["rowid AS row_order"];
    for (const c of ["provider_turn_id", "ordinal", "status", "started_at", "completed_at", "payload_json"]) {
      if (cols.has(c)) sel.push(c);
    }
    if (!cols.has("payload_json")) sel.push("payload_json");
    rawTurnRows = db.prepare(`SELECT ${sel.join(", ")} FROM orchestration_v2_projection_provider_turns WHERE thread_id = ? ORDER BY rowid ASC`).all(threadId);
  } catch {
    rawTurnRows = db.prepare("SELECT rowid AS row_order, ordinal, status, started_at, completed_at, payload_json FROM orchestration_v2_projection_provider_turns WHERE thread_id = ? ORDER BY rowid ASC").all(threadId);
  }
  // Provider ordinals reset across resumed sessions. Use event time, with the
  // stable insertion order for ties and for a newly inserted undated turn.
  const turnEvidence = rawTurnRows.map((row, index) => {
    const payload = safeJsonParse(row.payload_json);
    const stamp = Date.parse(row.started_at || payload?.startedAt || row.completed_at || payload?.completedAt || "");
    return { row, payload, stamp, order: Number.isFinite(row.row_order) ? row.row_order : index };
  });
  const dated = turnEvidence.filter((entry) => Number.isFinite(entry.stamp)).sort((a, b) => a.stamp - b.stamp || a.order - b.order);
  let latestTurn = dated[dated.length - 1] || null;
  for (const entry of turnEvidence) {
    if (!Number.isFinite(entry.stamp) && (!latestTurn || entry.order > latestTurn.order)) latestTurn = entry;
  }
  const turnRows = [...turnEvidence.filter((entry) => !Number.isFinite(entry.stamp)), ...dated]
    .filter((entry) => entry !== latestTurn).map((entry) => entry.row);
  if (latestTurn) turnRows.push(latestTurn.row);
  const providerThreadDriverById = new Map();
  let isRunning = false;
  let contextUsed = null;
  let contextMax = null;
  let contextMaxSource = null;
  let latestDriver = fallbackProvider || null;
  let latestModel = fallbackModel || null;
  const contextsByDriver = new Map();

  for (const pt of pThreadRows) {
    const p = safeJsonParse(pt.payload_json);
    const ptDriver = normalizeEffectiveDriver(pt.driver, p?.providerInstanceId || pt.provider);
    if (pt.provider_thread_id && ptDriver) providerThreadDriverById.set(pt.provider_thread_id, ptDriver);
    if (ptDriver) latestDriver = ptDriver;
    const updatedMs = Date.parse(pt.updated_at || "");
    const isActive = Boolean(activeProviderThreadId && pt.provider_thread_id === activeProviderThreadId);
    const previous = contextsByDriver.get(ptDriver);
    // An old sibling can have a higher rowid even after the active branch reports new usage.
    if (isActive || (!previous?.isActive && (!Number.isFinite(previous?.updatedMs) || updatedMs >= previous.updatedMs))) {
      contextsByDriver.set(ptDriver, {
        used: Number.isFinite(p?.contextUsage?.usedTokens) ? p.contextUsage.usedTokens : null,
        max: Number.isFinite(p?.contextUsage?.maxTokens) && p.contextUsage.maxTokens > 0 ? p.contextUsage.maxTokens : null,
        updatedMs,
        isActive,
        nativeId: p?.nativeThreadRef?.nativeId,
      });
    }
    const current = contextsByDriver.get(ptDriver);
    contextUsed = current?.used ?? null;
    contextMax = current?.max ?? null;
    contextMaxSource = contextMax != null ? "reported" : null;
  }
  const resolveTurnDriver = (payload) => {
    const raw = payload?.nativeTurnRef?.driver || payload?.driver || null;
    if (raw === "acpRegistry" && payload?.providerThreadId && providerThreadDriverById.has(payload.providerThreadId)) {
      return providerThreadDriverById.get(payload.providerThreadId);
    }
    if (raw === "acpRegistry" && fallbackProvider && String(fallbackProvider).startsWith("acpRegistry_")) {
      return fallbackProvider;
    }
    return raw;
  };
  const latestTurnDriver = resolveTurnDriver(latestTurn?.payload);
  const providerChanged = Boolean(fallbackProvider && (latestTurnDriver || latestDriver) && !driversCompatible(fallbackProvider, latestTurnDriver || latestDriver));
  isRunning = !providerChanged && isDbTurnStaticallyActive(latestTurn, fallbackProvider || latestTurnDriver);
  if (fallbackProvider || latestTurnDriver) {
    // Historical accumulation keeps its driver; only the returned current-provider fields are replaced below.
    latestDriver = latestTurnDriver || fallbackProvider;
    const current = contextsByDriver.get(fallbackProvider || latestDriver);
    contextUsed = current?.used ?? null;
    contextMax = current?.max ?? null;
    contextMaxSource = contextMax != null ? "reported" : null;
  }
  const currentProviderTelemetry = (telemetry) => {
    if (!providerChanged && (!fallbackProvider || driversCompatible(telemetry.provider, fallbackProvider))) return telemetry;
    return { ...telemetry, provider: fallbackProvider, model: fallbackModel || null,
      isRunning: false, turnCacheRate: null, lastTurnCacheRate: null, lastCallCacheRate: null,
      contextCacheRate: null, lastDecodeTps: null, currentTurnEstimateTps: null, durationSec: null,
      contextUsed: contextsByDriver.get(fallbackProvider)?.used ?? null,
      contextMax: contextsByDriver.get(fallbackProvider)?.max ?? null,
      contextMaxSource: contextsByDriver.get(fallbackProvider)?.max != null ? "reported" : null };
  };

  const agyConvIds = new Set();
  const museNativeIds = new Set();
  const codexNativeIds = new Set();
  const devinNativeIds = new Set();

  for (const pt of pThreadRows) {
    const p = safeJsonParse(pt.payload_json);
    const ptDriver = normalizeEffectiveDriver(pt.driver, p?.providerInstanceId || pt.provider);
    const nid = p?.nativeThreadRef?.nativeId;
    if (!nid) continue;
    if (ptDriver === "muse") museNativeIds.add(nid);
    else if (ptDriver === "codex") codexNativeIds.add(nid);
    else if (ptDriver === "acpRegistry_devin" && !String(nid).startsWith("pending:")) devinNativeIds.add(nid);
    else if (ptDriver === "antigravity" && !nid.startsWith("pending:")) {
      agyConvIds.add(nid.split(":")[0]);
    }
  }

  for (const tr of turnRows) {
    const p = safeJsonParse(tr.payload_json);
    const turnNid = p?.nativeTurnRef?.nativeId;
    if (p?.nativeTurnRef?.driver === "antigravity" && typeof turnNid === "string") {
      const cid = turnNid.split(":")[0];
      if (/^[0-9a-f-]{36}$/i.test(cid)) agyConvIds.add(cid);
    }
  }

  function getLatestMtimeMs(fp) {
    let mt = 0;
    try {
      mt = fs.statSync(fp).mtimeMs;
    } catch {}
    try {
      const wmt = fs.statSync(fp + "-wal").mtimeMs;
      if (wmt > mt) mt = wmt;
    } catch {}
    return mt;
  }

  // Collect native provider files for all sessions bound to this thread & sort chronologically!
  const nativeParts = [];
  const codexContextParts = [];
  for (const mid of museNativeIds) {
    const fp = findMuseSessionJsonl(mid);
    if (fp) {
      const d = readMuseSessionFile(fp, latestModel);
      if (d && d.stepCount > 0) {
        nativeParts.push({ ...d, driver: "muse", nativeId: mid, mtimeMs: getLatestMtimeMs(fp) });
      }
    }
  }
  for (const cid of agyConvIds) {
    const fp = findAntigravityConvDb(cid);
    if (fp) {
      const d = readAntigravityConvDb(fp, latestModel);
      if (d && d.stepCount > 0) {
        nativeParts.push({ ...d, driver: "antigravity", nativeId: cid, mtimeMs: getLatestMtimeMs(fp) });
      }
    }
  }
  for (const xid of codexNativeIds) {
    const fp = findCodexSessionJsonl(xid);
    if (fp) {
      const d = readCodexSessionFile(fp, latestModel);
      if (d) {
        const part = { ...d, driver: "codex", nativeId: xid, mtimeMs: getLatestMtimeMs(fp) };
        if (d.stepCount > 0) nativeParts.push(part);
        if (d.lastContextPrompt != null || d.contextMax != null) codexContextParts.push(part);
      }
    }
  }
  if (devinNativeIds.size > 0) {
    const devinDbPath = findDevinSessionsDb();
    if (devinDbPath) {
      const devinMtimeMs = getLatestMtimeMs(devinDbPath);
      for (const did of devinNativeIds) {
        const d = readDevinSessionDb(did, latestModel, devinDbPath);
        if (d && d.stepCount > 0) {
          nativeParts.push({ ...d, driver: "acpRegistry_devin", nativeId: did, mtimeMs: d.lastEventMs || devinMtimeMs });
        }
      }
    }
  }
  const codexContext = resolveCodexSessionContext(codexContextParts, contextsByDriver.get("codex"), activeProviderThreadId);

  // statev2 provider turns are the only reliable source for cache across all
  // model calls in one user turn. Native logs remain per-call/session sources.
  const turnCacheRate = latestProviderTurnCacheRate(turnRows, latestDriver);

  if (nativeParts.length > 0) {
    nativeParts.sort((a, b) => a.mtimeMs - b.mtimeMs);
    const coveredDrivers = new Set(nativeParts.map((p) => p.driver));
    // statev2 model selection, captured before native parts overwrite latestModel.
    const statev2Model = latestModel;
    let uncached = 0;
    let cached = 0;
    let cacheWrite = 0;
    let output = 0;
    let reasoning = 0;
    let usd = 0;
    let savedUsd = 0;
    let stepCount = 0;
    let totalDecodeTok = 0;
    let totalDecodeSec = 0;
    const mergedByModel = {};
    let uncoveredOut = 0;
    let uncoveredNetSec = 0;
    let latestUncoveredTurnMs = 0;
    let latestUncoveredDriver = null;
    let latestUncoveredModel = null;
    let latestUncoveredOutput = 0;
    let latestUncoveredStartMs = null;
    let latestUncoveredEndMs = null;
    let latestUncoveredTurnIds = null;
    let cachedTurnItemRows = null;
    const getParsedTurnItems = () => {
      if (cachedTurnItemRows) return cachedTurnItemRows;
      try {
        cachedTurnItemRows = safeTurnItemRows(db, threadId).map((row) => ({ row, item: safeJsonParse(row.payload_json) }));
      } catch {
        cachedTurnItemRows = [];
      }
      return cachedTurnItemRows;
    };
    const buildTurnToolIntervals = (turnIds, turnDriver) =>
      getParsedTurnItems()
        .filter(({ row, item }) => item && item.startedAt && item.completedAt && item.type !== "assistant_message" && item.type !== "reasoning" && itemBelongsToCurrentTurn(item, row, turnIds, turnDriver))
        .map(({ item }) => [Date.parse(item.startedAt), Date.parse(item.completedAt)])
        .filter(([startMs, endMs]) => Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs && endMs - startMs < 600000);

    for (const part of nativeParts) {
      uncached += part.uncached;
      cached += part.cached;
      cacheWrite += part.cacheWrite;
      output += part.output;
      reasoning += part.reasoning;
      usd += part.usd;
      savedUsd += part.savedUsd;
      stepCount += part.stepCount;
      totalDecodeTok += part.decodeTokensSum || 0;
      totalDecodeSec += part.decodeSecSum || 0;
      if (part.byModelDecode) {
        for (const [mk, mv] of Object.entries(part.byModelDecode)) {
          const cur = (mergedByModel[mk] ||= { tok: 0, sec: 0 });
          cur.tok += mv.tok;
          cur.sec += mv.sec;
        }
      }
      if (part.model) latestModel = part.model;
      if (part.driver) latestDriver = part.driver;
    }

    // Mixed-provider threads: scan turns whose driver is not covered by native parts
    // so zero turns are ever dropped (e.g., thread with both claudeAgent and muse turns).
    for (const tr of turnRows) {
      const p = safeJsonParse(tr.payload_json);
      const d = resolveTurnDriver(p);
      if (!d || coveredDrivers.has(d)) continue;
      const u = p?.turnTokenUsage;
      const completed = tr.status === "completed" || Boolean(tr.completed_at || p?.completedAt);
      const uS = Date.parse(tr.started_at || p?.startedAt || "");
      const uE = Date.parse(tr.completed_at || p?.completedAt || "");
      const trIds = latestTurnIdentityIds({ row: tr, payload: p });
      if (completed) stepCount++;
      const turnMs = Number.isFinite(uE) ? uE : Number.isFinite(uS) ? uS : NaN;
      // Each uncovered provider row supersedes the prior candidate, including
      // a completed turn whose usage payload is missing. Such a turn is a
      // known no-sample result and must clear the old rate.
      latestUncoveredDriver = d;
      latestUncoveredTurnMs = Number.isFinite(turnMs) ? turnMs : 0;
      latestUncoveredOutput = completed && typeof u?.outputTokens === "number" ? Math.max(0, u.outputTokens) : 0;
      latestUncoveredStartMs = completed && Number.isFinite(uS) ? uS : null;
      latestUncoveredEndMs = completed && Number.isFinite(uE) ? uE : null;
      latestUncoveredTurnIds = trIds;
      latestUncoveredModel =
        (Array.isArray(u?.models) && typeof u.models[0] === "string" && u.models[0]) ||
        (typeof p?.model === "string" && p.model) ||
        null;
      if (!u || typeof u.inputTokens !== "number") continue;
      let inp = Math.max(0, u.inputTokens || 0);
      const cr = Math.max(0, u.cachedInputTokens || 0);
      const cw = Math.max(0, u.cacheCreationTokens || 0);
      if (d === "antigravity" && inp >= cr * 2) inp = inp - cr;
      const unc = Math.max(0, inp - cr - cw);
      const out = Math.max(0, u.outputTokens || 0);
      const reas = Math.min(out, Math.max(0, u.reasoningTokens || 0));
      uncached += unc;
      cached += cr;
      cacheWrite += cw;
      output += out;
      reasoning += reas;
      const priced = priceStep({ uncached: unc, cached: cr, cacheWrite: cw, output: out }, latestModel, d);
      usd += priced.usd;
      savedUsd += priced.savedUsd;
      if (Number.isFinite(uE) && Number.isFinite(uS) && uE > uS + 50 && out > 0) {
        uncoveredOut += out;
        uncoveredNetSec += subtractToolWait(uS, uE, buildTurnToolIntervals(trIds, d));
      }
    }

    // Pure decode speed from native logs when available; only fall back to timed turn rate when no native decode sample exists
    const sessionAvgTps =
      totalDecodeSec > 0.1
        ? totalDecodeTok / totalDecodeSec
        : uncoveredNetSec > 0.2
          ? uncoveredOut / uncoveredNetSec
          : null;

    const matchingParts = latestTurnDriver ? nativeParts.filter((part) => driversCompatible(part.driver, latestTurnDriver)) : nativeParts;
    const expectedActiveNativeId = (() => {
      const targetDrv = latestTurnDriver || latestDriver;
      if (latestTurnDriver && typeof latestTurn?.payload?.nativeTurnRef?.nativeId === "string" && targetDrv === "antigravity") {
        return latestTurn.payload.nativeTurnRef.nativeId.split(":")[0];
      }
      const activePt = activeProviderThreadId
        ? pThreadRows.find((pt) => pt.provider_thread_id === activeProviderThreadId)
        : null;
      const activePtDrv = activePt ? normalizeEffectiveDriver(activePt.driver, safeJsonParse(activePt.payload_json)?.providerInstanceId || activePt.provider) : null;
      if (activePt && (!targetDrv || driversCompatible(activePtDrv, targetDrv))) {
        const nid = safeJsonParse(activePt.payload_json)?.nativeThreadRef?.nativeId;
        if (nid && !String(nid).startsWith("pending:")) {
          return targetDrv === "antigravity" ? String(nid).split(":")[0] : String(nid);
        }
      }
      return null;
    })();
    const lastPart = (expectedActiveNativeId && matchingParts.find((part) => part.nativeId === expectedActiveNativeId))
      || matchingParts[matchingParts.length - 1]
      || nativeParts[nativeParts.length - 1];
    const matchingStepsSum = matchingParts.reduce((sum, part) => sum + (part.stepCount || 0), 0);

    // Mixed-provider freshness: if an uncovered provider ran after the newest
    // native part, its statev2 metadata wins over stale native metadata.
    const lastPThread = pThreadRows[pThreadRows.length - 1];
    const lastPThreadPayload = safeJsonParse(lastPThread?.payload_json);
    const lastPThreadDriver = normalizeEffectiveDriver(lastPThread?.driver, lastPThreadPayload?.providerInstanceId || lastPThread?.provider);
    const lastPThreadMs = lastPThread?.updated_at ? Date.parse(lastPThread.updated_at) : NaN;
    let overrideDriver = null;
    let overrideModel = null;
    let overrideMs = 0;
    if (latestUncoveredDriver) {
      overrideDriver = latestUncoveredDriver;
      overrideModel = latestUncoveredModel || null;
      overrideMs = latestUncoveredTurnMs;
    }
    if (
      lastPThreadDriver &&
      !coveredDrivers.has(lastPThreadDriver) &&
      Number.isFinite(lastPThreadMs) &&
      lastPThreadMs > overrideMs
    ) {
      if (lastPThreadDriver !== latestUncoveredDriver) {
        overrideDriver = lastPThreadDriver;
        overrideModel = statev2Model;
      }
      overrideMs = lastPThreadMs;
    }
    if (latestTurnDriver && !coveredDrivers.has(latestTurnDriver)) {
      overrideDriver = latestTurnDriver;
      overrideModel = latestTurn?.payload?.turnTokenUsage?.models?.[0] || latestTurn?.payload?.model || statev2Model;
    }
    const useOverride = Boolean(overrideDriver) && ((overrideDriver === latestTurnDriver && !Number.isFinite(latestTurn?.stamp)) || overrideMs > (lastPart.mtimeMs || 0));
    const effDriver = useOverride ? overrideDriver : lastPart.driver || latestDriver;
    let effModel = useOverride ? overrideModel || statev2Model : lastPart.model || latestModel;
    if (!useOverride && effDriver === "codex" && activeProviderThreadId) {
      effModel = codexContext.model || statev2Model;
    }
    const completedDriverTurns = turnRows.reduce((cnt, tr) => {
      const p = safeJsonParse(tr.payload_json);
      if (!driversCompatible(resolveTurnDriver(p), effDriver)) return cnt;
      return (tr.status === "completed" || Boolean(tr.completed_at || p?.completedAt)) ? cnt + 1 : cnt;
    }, 0);
    const latestTurnCompleted = latestTurn && (String(latestTurn.row.status || latestTurn.payload?.status) === "completed" || Boolean(latestTurn.row.completed_at || latestTurn.payload?.completedAt));
    const latestTurnStartMs = latestTurn ? Date.parse(latestTurn.row.started_at || latestTurn.payload?.startedAt || "") : NaN;
    const latestTurnEndMs = latestTurn ? Date.parse(latestTurn.row.completed_at || latestTurn.payload?.completedAt || "") : NaN;
    const latestTurnOut = Math.max(0, Number(latestTurn?.payload?.turnTokenUsage?.outputTokens) || 0);
    const epochFloorMs = 946684800000;
    // A request/start event can make both mtime and lastEventMs fresh without
    // producing any new usage. Attribute samples by their own completion time.
    const hasLatestTurnStart = Number.isFinite(latestTurnStartMs) && latestTurnStartMs >= epochFloorMs;
    const staleByUsageTime = hasLatestTurnStart && Number.isFinite(lastPart.lastUsageEventMs) &&
      lastPart.lastUsageEventMs < latestTurnStartMs - 50;
    const staleBySpeedTime = hasLatestTurnStart && Number.isFinite(lastPart.lastSpeedEventMs) &&
      lastPart.lastSpeedEventMs < latestTurnStartMs - 50;
    const pendingNativeCall = !latestTurnCompleted && lastPart.hasPendingUnfinishedCallAfterLastUsage === true;
    const staleByEventTime =
      Number.isFinite(lastPart.lastEventMs) &&
      lastPart.lastEventMs >= epochFloorMs &&
      Number.isFinite(latestTurnStartMs) &&
      latestTurnStartMs >= epochFloorMs &&
      lastPart.lastEventMs < latestTurnStartMs - 1000;
    const staleByMtime =
      Number.isFinite(latestTurnStartMs) &&
      latestTurnStartMs >= epochFloorMs &&
      (lastPart.mtimeMs || 0) > 0 &&
      lastPart.mtimeMs < latestTurnStartMs - 1000;
    const latestSameDriverPThread = [...pThreadRows].reverse().find((pt) => {
      const p = safeJsonParse(pt.payload_json);
      return driversCompatible(normalizeEffectiveDriver(pt.driver, p?.providerInstanceId || pt.provider), effDriver);
    });
    const latestSameDriverNativeId = (() => {
      const turnNid = latestTurnDriver === effDriver && typeof latestTurn?.payload?.nativeTurnRef?.nativeId === "string"
        ? (effDriver === "antigravity" ? latestTurn.payload.nativeTurnRef.nativeId.split(":")[0] : null)
        : null;
      if (turnNid) return turnNid;
      const ptNid = safeJsonParse(latestSameDriverPThread?.payload_json)?.nativeThreadRef?.nativeId;
      if (!ptNid || String(ptNid).startsWith("pending:")) return null;
      return effDriver === "antigravity" ? String(ptNid).split(":")[0] : String(ptNid);
    })();
    const missingExpectedLatestNativePart = Boolean(
      latestSameDriverNativeId && lastPart.nativeId !== latestSameDriverNativeId
    );
    const lastPartCoversLatestTurn =
      !staleByUsageTime && !pendingNativeCall && !missingExpectedLatestNativePart && (
        !latestTurn ||
        !latestTurnCompleted ||
        (latestTurnDriver && !driversCompatible(latestTurnDriver, effDriver)) ||
        (driversCompatible(lastPart.driver, effDriver) &&
          matchingStepsSum >= Math.max(1, completedDriverTurns) &&
          !staleByEventTime &&
          !staleByMtime)
      );
    let latestSameDriverFallbackTps = null;
    let latestSameDriverFallbackDurationSec = null;
    if (
      !lastPartCoversLatestTurn &&
      latestTurnCompleted &&
      latestTurnDriver === effDriver &&
      latestTurnOut >= 15 &&
      Number.isFinite(latestTurnStartMs) &&
      Number.isFinite(latestTurnEndMs) &&
      latestTurnEndMs > latestTurnStartMs
    ) {
      const toolIntervals = buildTurnToolIntervals(latestTurnIdentityIds(latestTurn), effDriver);
      const netSec = subtractToolWait(latestTurnStartMs, latestTurnEndMs, toolIntervals);
      const tps = latestTurnOut / netSec;
      if (netSec > 0.05 && Number.isFinite(tps) && tps <= 1500) {
        latestSameDriverFallbackTps = tps;
        latestSameDriverFallbackDurationSec = netSec;
      }
    }
    const latestCallCacheRate = useOverride || !lastPartCoversLatestTurn
      ? null
      : lastPart.lastStepCacheRate ?? null;
    let latestUncoveredTps = null;
    let latestUncoveredDurationSec = null;
    if (
      useOverride &&
      !coveredDrivers.has(overrideDriver) &&
      latestUncoveredDriver === overrideDriver &&
      latestUncoveredOutput >= 15 &&
      Number.isFinite(latestUncoveredStartMs) &&
      Number.isFinite(latestUncoveredEndMs) &&
      latestUncoveredEndMs > latestUncoveredStartMs
    ) {
      const toolIntervals = buildTurnToolIntervals(latestUncoveredTurnIds, overrideDriver);
      const netSec = subtractToolWait(latestUncoveredStartMs, latestUncoveredEndMs, toolIntervals);
      const tps = latestUncoveredOutput / netSec;
      if (netSec > 0.05 && Number.isFinite(tps) && tps <= 1500) {
        latestUncoveredTps = tps;
        latestUncoveredDurationSec = netSec;
      }
    }
    const promptTotal = uncached + cached + cacheWrite;
    const sessionCacheRate = promptTotal > 0 ? cached / promptTotal : null;
    const currentTurnEstimateTpsNative = computeCurrentTurnEstimateTps({ db, threadId, latestTurn, latestTurnDriver, effDriver, isRunning });
    const latestTurnHasOutput = Number.isFinite(latestTurn?.payload?.turnTokenUsage?.outputTokens) && latestTurn.payload.turnTokenUsage.outputTokens > 0;
    const latestTurnUsageUnavailable = latestTurn?.payload?.turnTokenUsage?.usageStatus === "unavailable";
    const latestTurnHasNativeOutput = Boolean(
      latestTurnUsageUnavailable &&
      lastPartCoversLatestTurn &&
      !staleBySpeedTime &&
      lastPart.lastDecodeTps != null
    );
    const currentTurnSpeedKnown = !latestTurn || (latestTurnCompleted && (latestTurnHasOutput || latestTurnHasNativeOutput) && (!latestTurnDriver || driversCompatible(latestTurnDriver, effDriver)));
    const latestTurnActive = isDbTurnStaticallyActive(latestTurn, effDriver);
    const runningWithoutActiveTurn = Boolean(isRunning && !latestTurnActive);

    // Current active turn estimate is a separate channel; never pollute lastDecodeTps.
    const currentTurnEstimateTps = isRunning ? currentTurnEstimateTpsNative : null;

    const currentContext = contextsByDriver.get(effDriver);
    contextUsed = currentContext?.used ?? null;
    contextMax = currentContext?.max ?? null;
    const preferCurrentReport = contextMax != null && (useOverride || lastPart.contextMax == null || (Number.isFinite(currentContext?.updatedMs) && currentContext.updatedMs >= (lastPart.mtimeMs || 0)));
    let resolvedContextUsed = contextUsed;
    let resolvedContextMax = contextMax;
    let resolvedContextMaxSource = contextMax != null ? "reported" : null;
    if (effDriver === "codex") {
      resolvedContextUsed = codexContext.used;
      resolvedContextMax = codexContext.max;
      resolvedContextMaxSource = codexContext.max != null ? "reported" : null;
    } else if (!useOverride) {
      resolvedContextUsed = preferCurrentReport || !lastPartCoversLatestTurn
        ? contextUsed ?? lastPart.lastContextPrompt
        : lastPart.lastContextPrompt ?? contextUsed;
      if (!preferCurrentReport && lastPart.driver === effDriver && lastPart.contextMax != null) {
        resolvedContextMax = lastPart.contextMax;
        resolvedContextMaxSource = lastPart.contextMaxSource || "reported";
      }
    }
    // Capacity without a reported value can come from the local model
    // catalog or an explicit model-family estimate.
    if (resolvedContextMax == null) {
      const drv = effDriver || latestDriver;
      const mdl = effDriver === "codex" && activeProviderThreadId ? effModel : effModel || latestModel;
      const catalogMax = lookupCatalogContextMax(mdl, drv);
      if (catalogMax != null) {
        resolvedContextMax = catalogMax;
        resolvedContextMaxSource = "local-catalog";
      }
      if (drv === "antigravity") {
        const model = (mdl || "").toLowerCase();
        const isClaude = /opus|sonnet|haiku|claude/.test(model);
        if (resolvedContextMax == null) {
          resolvedContextMax = isClaude ? 1000000 : 1048576;
          resolvedContextMaxSource = "estimated";
        }
      } else if (drv === "muse") {
        if (resolvedContextMax == null) {
          resolvedContextMax = 1007997;
          resolvedContextMaxSource = "estimated";
        }
      } else if (drv === "acpRegistry_devin") {
        const model = (mdl || "").toLowerCase();
        if (resolvedContextMax == null && /swe-2/.test(model)) {
          resolvedContextMax = 262000;
          resolvedContextMaxSource = "estimated";
        }
      } else if (drv === "codex") {
        // Unknown if neither the host nor the local model catalog has a value.
      }
    }

    // Compute exact token-weighted whole-turn cache rate from attributed native steps when available.
    // Never substitute a single call's lastStepCacheRate for a whole-turn rate.
    const nativeTurnSteps = (lastPartCoversLatestTurn && Array.isArray(lastPart.usageSteps) && hasLatestTurnStart)
      ? lastPart.usageSteps.filter((st) =>
          Number.isFinite(st.eventMs) &&
          st.eventMs >= latestTurnStartMs - 50 &&
          (!Number.isFinite(latestTurnEndMs) || st.eventMs <= latestTurnEndMs + 2000)
        )
      : [];
    const nativeTurnPromptSum = nativeTurnSteps.reduce((acc, st) => acc + (st.prompt || 0), 0);
    const nativeTurnCachedSum = nativeTurnSteps.reduce((acc, st) => acc + (st.cached || 0), 0);
    const nativeWeightedTurnCacheRate = nativeTurnPromptSum > 0
      ? Math.min(nativeTurnPromptSum, nativeTurnCachedSum) / nativeTurnPromptSum
      : null;

    let effectiveNativeTurnCacheRate = turnCacheRate;
    // For Antigravity, when native DB calls match statev2's turnTokenUsage.inputTokens directly
    // (T3 v0.1.11+ no longer double-counts cachedInputTokens), avoid the legacy `input >= cached * 2` subtraction.
    if (effDriver === "antigravity" && nativeTurnPromptSum > 0 && latestTurn?.payload?.turnTokenUsage) {
      const u = latestTurn.payload.turnTokenUsage;
      if (u.usageStatus !== "unavailable" && Number.isFinite(u.inputTokens) && u.inputTokens > 0 && Number.isFinite(u.cachedInputTokens)) {
        const directMatch = Math.abs(u.inputTokens - nativeTurnPromptSum) <= Math.max(100, nativeTurnPromptSum * 0.02);
        const doubledMatch = Math.abs(u.inputTokens - (nativeTurnPromptSum + nativeTurnCachedSum)) <= Math.max(100, nativeTurnPromptSum * 0.02);
        if (directMatch && !doubledMatch) {
          effectiveNativeTurnCacheRate = Math.min(u.inputTokens, Math.max(0, u.cachedInputTokens)) / u.inputTokens;
        }
      }
    }
    if (effectiveNativeTurnCacheRate == null && latestTurnUsageUnavailable && nativeWeightedTurnCacheRate != null) {
      effectiveNativeTurnCacheRate = nativeWeightedTurnCacheRate;
    }
    return currentProviderTelemetry({
      source: "native",
      provider: effDriver,
      model: effModel,
      isRunning,
      turnCount: turnRows.length || stepCount,
      stepCount,
      uncached,
      cached,
      cacheWrite,
      input: promptTotal,
      output,
      reasoning,
      usd,
      savedUsd,
      sessionCacheRate,
      turnCacheRate: runningWithoutActiveTurn ? null : latestTurnDriver && !driversCompatible(latestTurnDriver, effDriver) ? null : effectiveNativeTurnCacheRate,
      lastTurnCacheRate: runningWithoutActiveTurn ? null : latestTurnDriver && !driversCompatible(latestTurnDriver, effDriver) ? null : effectiveNativeTurnCacheRate,
      lastCallCacheRate: latestCallCacheRate,
      contextCacheRate: effectiveNativeTurnCacheRate ?? latestCallCacheRate ?? sessionCacheRate,
      tokPerSec: sessionAvgTps ?? lastPart.tokPerSec,
      byModelSpeed: Object.fromEntries(Object.entries(mergedByModel).filter(([, v]) => v.sec > 0.1).map(([k, v]) => [k, Math.round((v.tok / v.sec) * 10) / 10])),
      // Use the latest uncovered turn's own effective duration when it wins the
      // mixed-provider freshness check; never reuse a prior turn's native rate.
      lastDecodeTps: runningWithoutActiveTurn ? null : !currentTurnSpeedKnown ? null : useOverride && !coveredDrivers.has(overrideDriver) ? latestUncoveredTps : !lastPartCoversLatestTurn || staleBySpeedTime ? latestSameDriverFallbackTps : lastPart.lastDecodeTps,
      currentTurnEstimateTps: runningWithoutActiveTurn ? null : currentTurnEstimateTps,
      e2eTokPerSec: lastPart.e2eTokPerSec,
      durationSec: runningWithoutActiveTurn ? null : !currentTurnSpeedKnown ? null : useOverride && !coveredDrivers.has(overrideDriver) ? latestUncoveredDurationSec : !lastPartCoversLatestTurn || staleBySpeedTime ? latestSameDriverFallbackDurationSec : lastPart.durationSec,
      contextUsed: resolvedContextUsed,
      contextMax: resolvedContextMax,
      contextMaxSource: resolvedContextMaxSource,
    });
  }

  // Fallback for other providers (e.g., Claude Code ACP) via statev2.sqlite turns - tool durations
  const rawToolRows = safeTurnItemRows(db, threadId).map((row) => ({
    row,
    payload: safeJsonParse(row.payload_json),
  }));

  let uncached = 0;
  let cached = 0;
  let cacheWrite = 0;
  let output = 0;
  let reasoning = 0;
  let usd = 0;
  let savedUsd = 0;
  let turnDurSum = 0;
  let netGenSecSum = 0;
  let lastTurnTps = null;
  let lastTurnNetSec = null;
  let lastTurnCacheRate = null;

  for (const tr of turnRows) {
    const p = safeJsonParse(tr.payload_json);
    const sMs = Date.parse(tr.started_at || p?.startedAt || "");
    const eMs = Date.parse(tr.completed_at || p?.completedAt || "");
    const completed = tr.status === "completed" || (Number.isFinite(eMs) && (!Number.isFinite(sMs) || eMs >= sMs));
    if (completed) {
      // Every completed turn replaces the prior turn sample, even when this
      // one has no usage or a zero-duration/zero-token result.
      lastTurnTps = null;
      lastTurnNetSec = null;
    }
    const u = p?.turnTokenUsage;
    if (!u || u.usageStatus === "unavailable" || typeof u.inputTokens !== "number") continue;

    const trDriver = resolveTurnDriver(p) || tr.driver || latestDriver || null;
    // Guard against legacy T3's geminiPromptUsage double-adding cachedInputTokens
    let inp = Math.max(0, u.inputTokens || 0);
    const cr = Math.max(0, u.cachedInputTokens || 0);
    const cw = Math.max(0, u.cacheCreationTokens || 0);
    if (trDriver === "antigravity" && inp >= cr * 2) {
      inp = inp - cr;
    }
    const unc = Math.max(0, inp - cr - cw);
    const out = Math.max(0, u.outputTokens || 0);
    const reas = Math.min(out, Math.max(0, u.reasoningTokens || 0));

    uncached += unc;
    cached += cr;
    cacheWrite += cw;
    output += out;
    reasoning += reas;

    const priced = priceStep({ uncached: unc, cached: cr, cacheWrite: cw, output: out }, latestModel, trDriver || latestDriver);
    usd += priced.usd;
    savedUsd += priced.savedUsd;
    if (inp > 0 && Number.isFinite(u.cachedInputTokens)) lastTurnCacheRate = Math.min(inp, cr) / inp;

    if (Number.isFinite(sMs) && Number.isFinite(eMs) && eMs > sMs) {
      turnDurSum += (eMs - sMs) / 1000;
      const trIds = latestTurnIdentityIds({ row: tr, payload: p });
      const trDriver = p?.nativeTurnRef?.driver || p?.driver || tr.driver || latestDriver || null;
      const trToolIntervals = rawToolRows
        .filter(({ row, payload }) => payload && payload.startedAt && payload.completedAt && payload.type !== "assistant_message" && payload.type !== "reasoning" && itemBelongsToCurrentTurn(payload, row, trIds, trDriver))
        .map(({ payload }) => [Date.parse(payload.startedAt), Date.parse(payload.completedAt)])
        .filter(([startMs, endMs]) => Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs && endMs - startMs < 600000);
      const netSec = subtractToolWait(sMs, eMs, trToolIntervals);
      netGenSecSum += netSec;
      if (completed && out >= 15 && netSec > 0.05 && out / netSec <= 1500) {
        lastTurnTps = out / netSec;
        lastTurnNetSec = netSec;
      }
    }
  }

  const netGenSec = Math.max(0.2, netGenSecSum);
  const promptTotal = uncached + cached + cacheWrite;
  const sessionCacheRate = promptTotal > 0 ? cached / promptTotal : null;
  const currentTurnEstimateTpsFallback = computeCurrentTurnEstimateTps({ db, threadId, latestTurn, latestTurnDriver, effDriver: latestDriver, isRunning });
  const fallbackLatestActive = isDbTurnStaticallyActive(latestTurn, latestDriver);
  const fallbackRunningWithoutActive = Boolean(isRunning && !fallbackLatestActive);
  if (latestDriver === "codex") {
    contextUsed = codexContext.used;
    contextMax = codexContext.max;
    contextMaxSource = contextMax != null ? "reported" : null;
  }
  let effectiveMax = contextMax ?? null;
  let effectiveMaxSource = effectiveMax != null ? contextMaxSource || "reported" : null;
  if (effectiveMax == null) {
    effectiveMax = lookupCatalogContextMax(latestModel, latestDriver) ?? null;
    if (effectiveMax != null) effectiveMaxSource = "local-catalog";
  }
  if (effectiveMax == null && latestDriver === "antigravity") {
    const model = (latestModel || "").toLowerCase();
    const isClaude = /opus|sonnet|haiku|claude/.test(model);
    effectiveMax = isClaude ? 1000000 : 1048576;
    effectiveMaxSource = "estimated";
  }
  if (effectiveMax == null && latestDriver === "muse") {
    effectiveMax = 1007997;
    effectiveMaxSource = "estimated";
  }

  return currentProviderTelemetry({
    source: "sqlite-fallback",
    provider: latestDriver,
    model: latestModel,
    isRunning,
    turnCount: turnRows.length,
    stepCount: turnRows.filter((tr) => tr.status === "completed" || tr.completed_at).length,
    uncached,
    cached,
    cacheWrite,
    input: promptTotal,
    output,
    reasoning,
    usd,
    savedUsd,
    sessionCacheRate,
    turnCacheRate: fallbackRunningWithoutActive ? null : turnCacheRate,
    lastTurnCacheRate: fallbackRunningWithoutActive ? null : turnCacheRate,
    lastCallCacheRate: null,
    contextCacheRate: turnCacheRate ?? lastTurnCacheRate ?? sessionCacheRate,
    tokPerSec: turnDurSum > 0.2 && output > 0 ? output / netGenSec : null,
    lastDecodeTps: fallbackRunningWithoutActive ? null : lastTurnTps,
    currentTurnEstimateTps: fallbackRunningWithoutActive ? null : currentTurnEstimateTpsFallback,
    e2eTokPerSec: turnDurSum > 0.2 && output > 0 ? output / netGenSec : null,
    durationSec: fallbackRunningWithoutActive ? null : lastTurnNetSec,
    contextUsed,
    contextMax: effectiveMax,
    contextMaxSource: effectiveMaxSource,
  });
}

// Memoize completed subagent telemetry keyed by childThreadId + updated_at so 400+ subagents run in < 2ms
// LRU-capped at 500 to avoid long-session monotonic memory growth
const childSubagentCache = new Map();

function getCachedChildTelemetry(db, childThreadId, fallbackModel, fallbackProvider) {
  const cRow = db
    .prepare(
      "SELECT default_provider, updated_at, payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ?"
    )
    .get(childThreadId);
  let turnSig = "";
  try {
    const tRow = db
      .prepare(
        "SELECT COUNT(*) AS cnt, MAX(ordinal) AS max_ord, MAX(completed_at) AS max_done FROM orchestration_v2_projection_provider_turns WHERE thread_id = ?"
      )
      .get(childThreadId);
    turnSig = tRow ? `|${tRow.cnt || 0}:${tRow.max_ord ?? ""}:${tRow.max_done || ""}` : "";
  } catch {
    turnSig = "";
  }
  const sig = cRow ? `${cRow.updated_at || ""}${turnSig}` : "";
  const hit = lruGet(childSubagentCache, childThreadId);
  if (hit && sig && hit.sig === sig && !hit.data.isRunning) {
    return hit.data;
  }
  const cPayload = safeJsonParse(cRow?.payload_json);
  const cTel = aggregateSingleThreadTelemetry(
    db,
    childThreadId,
    cPayload?.modelSelection?.model || fallbackModel,
    cPayload?.modelSelection?.provider || cRow?.default_provider || fallbackProvider,
    cPayload?.activeProviderThreadId
  );
  if (sig && !cTel.isRunning) {
    lruSet(childSubagentCache, childThreadId, { sig, data: cTel });
  }
  return cTel;
}

function getThreadStats(threadHint) {
  if (!fs.existsSync(DB_PATH)) {
    return { ok: false, error: "statev2.sqlite not found" };
  }

  const parsedHint = extractThreadId(threadHint);
  if (parsedHint && parsedHint.startsWith("__ROUTE_")) {
    return { ok: false, nonThreadRoute: parsedHint };
  }
  if (parsedHint === "__NEW__") {
    return { ok: false, nonThreadRoute: "new" };
  }

  let db;
  try {
    db = new DatabaseSync(DB_PATH, { open: true, readOnly: true });

    let threadRow = null;
    if (parsedHint) {
      threadRow = db
        .prepare(
          "SELECT thread_id, project_id, title, default_provider, updated_at, payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ?"
        )
        .get(parsedHint);
    }
    if (!threadRow && !parsedHint) {
      threadRow = db
        .prepare(
          "SELECT thread_id, project_id, title, default_provider, updated_at, payload_json FROM orchestration_v2_projection_threads WHERE archived_at IS NULL AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1"
        )
        .get();
    }
    if (!threadRow) {
      return { ok: false, error: "No active thread" };
    }

    const threadId = threadRow.thread_id;
    const threadPayload = safeJsonParse(threadRow.payload_json) || {};

    const projectRow = db
      .prepare("SELECT title, workspace_root FROM projection_projects WHERE project_id = ?")
      .get(threadRow.project_id);

    const psRow = db
      .prepare(
        "SELECT provider, driver, model, status, updated_at FROM orchestration_v2_projection_provider_sessions WHERE thread_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1"
      )
      .get(threadId);

    const selectedProvider = threadPayload?.modelSelection?.provider || threadPayload?.modelSelection?.instanceId || null;
    const selectedModel = threadPayload?.modelSelection?.model || null;
    const threadUpdatedMs = Date.parse(threadRow?.updated_at || "");
    const psProvider = normalizeEffectiveDriver(psRow?.driver, psRow?.provider);
    const psUpdatedMs = Date.parse(psRow?.updated_at || "");
    const turnEvidenceAfterSelection = (tr, tp) => {
      let startedMs = NaN;
      for (const raw of [tr?.started_at, tp?.startedAt]) {
        const ms = Date.parse(raw || "");
        if (Number.isFinite(ms) && (!Number.isFinite(startedMs) || ms > startedMs)) startedMs = ms;
      }
      if (Number.isFinite(startedMs)) return startedMs > threadUpdatedMs;
      let completedMs = NaN;
      for (const raw of [tr?.completed_at, tp?.completedAt]) {
        const ms = Date.parse(raw || "");
        if (Number.isFinite(ms) && (!Number.isFinite(completedMs) || ms > completedMs)) completedMs = ms;
      }
      return Number.isFinite(completedMs) && completedMs > threadUpdatedMs;
    };
    const hasTurnAfterSelection = (targetDriver) => {
      if (!Number.isFinite(threadUpdatedMs)) return false;
      try {
        const tRows = db
          .prepare("SELECT started_at, completed_at, payload_json FROM orchestration_v2_projection_provider_turns WHERE thread_id = ?")
          .all(threadId);
        return (tRows || []).some((tr) => {
          const tp = safeJsonParse(tr.payload_json);
          const drv = tp?.nativeTurnRef?.driver || tp?.driver || null;
          if (!drv) return false;
          if (targetDriver ? !driversCompatible(drv, targetDriver) : driversCompatible(drv, selectedProvider)) return false;
          return turnEvidenceAfterSelection(tr, tp);
        });
      } catch {
        return false;
      }
    };
    const hasSupersededDefaultWithoutSession = () => {
      if (psRow || !selectedProvider || selectedProvider !== threadRow.default_provider) return false;
      try {
        const ptRows = db
          .prepare("SELECT driver, updated_at, payload_json FROM orchestration_v2_projection_provider_threads WHERE thread_id = ?")
          .all(threadId);
        let selMax = NaN;
        let otherMax = NaN;
        for (const r of ptRows || []) {
          const ms = Date.parse(r?.updated_at || "");
          const rPayload = safeJsonParse(r?.payload_json);
          const rDriver = normalizeEffectiveDriver(r?.driver, rPayload?.providerInstanceId || r?.provider);
          if (!Number.isFinite(ms) || !rDriver) continue;
          if (driversCompatible(rDriver, selectedProvider)) {
            if (!Number.isFinite(selMax) || ms > selMax) selMax = ms;
          } else if (!Number.isFinite(otherMax) || ms > otherMax) {
            otherMax = ms;
          }
        }
        return Number.isFinite(selMax) && Number.isFinite(otherMax) && otherMax > selMax;
      } catch {
        return false;
      }
    };
    // A cross-driver session can supersede selection only when an actual turn on that driver ran after selection.
    const selectionWins = Boolean(
      selectedProvider &&
      !driversCompatible(psProvider, selectedProvider) &&
      !(psProvider ? hasTurnAfterSelection(psProvider) : (hasTurnAfterSelection(null) || hasSupersededDefaultWithoutSession()))
    );
    const modelSelectionWins = Boolean(
      selectedProvider &&
      selectedModel &&
      driversCompatible(psProvider, selectedProvider) &&
      Number.isFinite(threadUpdatedMs) &&
      (!Number.isFinite(psUpdatedMs) || threadUpdatedMs > psUpdatedMs) &&
      !hasTurnAfterSelection(selectedProvider)
    );
    const effectivePsRow = selectionWins ? null : psRow;
    const baseModel = selectionWins || modelSelectionWins ? selectedModel : effectivePsRow?.model || selectedModel;
    const baseProvider = selectionWins ? selectedProvider : psProvider || null;

    const mainTel = aggregateSingleThreadTelemetry(db, threadId, baseModel, baseProvider, threadPayload.activeProviderThreadId);

    // Recursively aggregate ALL child & grandchild subagents (both app_owned delegate_task & provider_native)
    const subStmt = db.prepare(
      "SELECT subagent_id, driver, child_thread_id FROM orchestration_v2_projection_subagents WHERE thread_id = ?"
    );
    const visitedThreads = new Set([threadId]);
    const visitedMuseNative = new Set();
    const queue = [threadId];

    let subagentUsd = 0;
    let subagentSavedUsd = 0;
    let subagentInput = 0;
    let subagentCached = 0;
    let subagentOutput = 0;
    let subagentReasoning = 0;
    let subagentCount = 0;

    while (queue.length > 0 && visitedThreads.size < 2000) {
      const curParent = queue.shift();
      const rows = subStmt.all(curParent);
      for (const sr of rows) {
        if (sr.child_thread_id) {
          if (visitedThreads.has(sr.child_thread_id)) continue;
          visitedThreads.add(sr.child_thread_id);
          queue.push(sr.child_thread_id);
          subagentCount++;
          const cTel = getCachedChildTelemetry(db, sr.child_thread_id, baseModel, baseProvider);
          subagentUsd += cTel.usd;
          subagentSavedUsd += cTel.savedUsd || 0;
          subagentInput += cTel.input || 0;
          subagentCached += cTel.cached || 0;
          subagentOutput += cTel.output || 0;
          subagentReasoning += cTel.reasoning || 0;
        } else if (sr.driver === "muse" && typeof sr.subagent_id === "string") {
          const decoded = decodeURIComponent(sr.subagent_id);
          const m = decoded.match(/:agent:([0-9a-f-]{36})$/i);
          if (m && !visitedMuseNative.has(m[1])) {
            visitedMuseNative.add(m[1]);
            const fp = findMuseSessionJsonl(m[1]);
            if (fp) {
              const md = readMuseSessionFile(fp, baseModel);
              if (md && md.stepCount > 0) {
                subagentCount++;
                subagentUsd += md.usd;
                subagentSavedUsd += md.savedUsd || 0;
                subagentInput += md.uncached + md.cached + md.cacheWrite;
                subagentCached += md.cached;
                subagentOutput += md.output;
                subagentReasoning += md.reasoning;
              }
            }
          }
        }
      }
    }

    const candidateWorktree = threadPayload?.worktreePath || null;
    const repoPath =
      (candidateWorktree && fs.existsSync(candidateWorktree) ? candidateWorktree : null) ||
      (projectRow?.workspace_root && fs.existsSync(projectRow.workspace_root)
        ? projectRow.workspace_root
        : null);
    const branchName = threadPayload?.branch || null;

    const mainTotal = mainTel.input + mainTel.output;
    const subagentTokens = subagentInput + subagentOutput;
    const combinedInput = mainTel.input + subagentInput;
    const combinedCached = mainTel.cached + subagentCached;
    const combinedSessionCacheRate =
      combinedInput > 0 ? combinedCached / combinedInput : mainTel.sessionCacheRate;

    const resolvedProvider = baseProvider || mainTel.provider || selectedProvider || threadRow.default_provider || null;
    const resolvedModel = (baseProvider && mainTel.provider !== baseProvider) || modelSelectionWins ? baseModel : mainTel.model || baseModel;
    let sessionRunning = Boolean(effectivePsRow?.status === "running" && psProvider === resolvedProvider);
    let effectiveIsRunning = Boolean(mainTel.isRunning || sessionRunning);
    let runningWithoutActiveTurn = false;
    let activeTurnIds = [];
    if (effectiveIsRunning) {
      try {
        let rows;
        try {
          const colsRows = db.prepare('PRAGMA table_info("orchestration_v2_projection_provider_turns")').all();
          const cols = new Set((colsRows || []).map((r) => r.name));
          if (cols.size === 0) throw new Error("no cols");
          const sel = ["rowid AS row_order"];
          for (const c of ["provider_turn_id", "ordinal", "status", "started_at", "completed_at", "payload_json"]) {
            if (cols.has(c)) sel.push(c);
          }
          if (!cols.has("payload_json")) sel.push("payload_json");
          rows = db.prepare(`SELECT ${sel.join(", ")} FROM orchestration_v2_projection_provider_turns WHERE thread_id = ? ORDER BY rowid ASC`).all(threadId);
        } catch {
          rows = db.prepare("SELECT rowid AS row_order, ordinal, status, started_at, completed_at, payload_json FROM orchestration_v2_projection_provider_turns WHERE thread_id = ? ORDER BY rowid ASC").all(threadId);
        }
        const evidence = (rows || []).map((row, index) => {
          const payload = safeJsonParse(row.payload_json);
          const stamp = Date.parse(row.started_at || payload?.startedAt || row.completed_at || payload?.completedAt || "");
          return { row, payload, stamp, order: Number.isFinite(row.row_order) ? row.row_order : index };
        });
        const dated = evidence.filter((e) => Number.isFinite(e.stamp)).sort((a, b) => a.stamp - b.stamp || a.order - b.order);
        let latest = dated[dated.length - 1] || null;
        for (const e of evidence) {
          if (!Number.isFinite(e.stamp) && (!latest || e.order > latest.order)) latest = e;
        }
        // A completed current-provider turn at/after the session observation wins
        // over a stale session 'running' flag, even when another driver is older.
        const sameProvider = evidence.filter(e => driversCompatible(e.payload?.nativeTurnRef?.driver || e.payload?.driver || null, resolvedProvider));
        const currentDated = sameProvider.filter(e => Number.isFinite(e.stamp)).sort((a, b) => a.stamp - b.stamp || a.order - b.order);
        let currentLatest = currentDated[currentDated.length - 1] || null;
        for (const e of sameProvider) {
          if (!Number.isFinite(e.stamp) && (!currentLatest || e.order > currentLatest.order)) currentLatest = e;
        }
        const completedMs = Date.parse(currentLatest?.row.completed_at || currentLatest?.payload?.completedAt || "");
        if (sessionRunning && Number.isFinite(completedMs) && (!Number.isFinite(psUpdatedMs) || completedMs >= psUpdatedMs)) sessionRunning = false;
        effectiveIsRunning = Boolean(mainTel.isRunning || sessionRunning);
        runningWithoutActiveTurn = effectiveIsRunning && !isDbTurnStaticallyActive(latest, resolvedProvider);
        if (effectiveIsRunning && !runningWithoutActiveTurn && latest) {
          activeTurnIds = Array.from(latestTurnIdentityIds(latest));
        }
      } catch {
        runningWithoutActiveTurn = !mainTel.isRunning;
      }
    }
    let resolvedContextMax = mainTel.contextMax ?? null;
    let resolvedContextMaxSource = mainTel.contextMaxSource ?? null;
    if (resolvedContextMax == null) {
      resolvedContextMax =
        lookupCatalogContextMax(resolvedModel, resolvedProvider) ?? null;
      if (resolvedContextMax != null) resolvedContextMaxSource = "local-catalog";
      if (resolvedContextMax == null && resolvedProvider === "antigravity") {
        const m = (resolvedModel || "").toLowerCase();
        resolvedContextMax = /opus|sonnet|haiku|claude/.test(m) ? 1000000 : 1048576;
        resolvedContextMaxSource = "estimated";
      }
      if (resolvedContextMax == null && resolvedProvider === "muse") {
        resolvedContextMax = 1007997;
        resolvedContextMaxSource = "estimated";
      }
      if (resolvedContextMax == null && resolvedProvider === "acpRegistry_devin" && /swe-2/i.test(resolvedModel || "")) {
        resolvedContextMax = 262000;
        resolvedContextMaxSource = "estimated";
      }
    }

    return {
      ok: true,
      threadId,
      title: threadRow.title || "Untitled",
      projectTitle: projectRow?.title || (repoPath ? path.basename(repoPath) : ""),
      repoPath,
      branch: branchName,
      provider: resolvedProvider,
      model: resolvedModel,
      telemetrySource: mainTel.source,
      isRunning: effectiveIsRunning,
      activeTurnIds,
      turnCount: mainTel.turnCount,
      stepCount: mainTel.stepCount,
      tokens: {
        input: combinedInput,
        uncached: mainTel.uncached + Math.max(0, subagentInput - subagentCached),
        output: mainTel.output + subagentOutput,
        reasoning: mainTel.reasoning + subagentReasoning,
        mainTotal,
        subagentTokens,
        total: mainTotal + subagentTokens,
        contextUsed: mainTel.contextUsed,
        contextMax: resolvedContextMax,
        contextMaxSource: resolvedContextMaxSource,
      },
      cache: {
        cachedTokens: combinedCached,
        mainCachedTokens: mainTel.cached,
        withSubagentsCachedTokens: combinedCached,
        cacheWriteTokens: mainTel.cacheWrite,
        // displayRate is retained for Antigravity context dedupe only; the HUD
        // cache metric uses turnRate and never falls back to a cumulative rate.
        displayRate: mainTel.contextCacheRate ?? mainTel.sessionCacheRate,
        turnRate: runningWithoutActiveTurn ? null : mainTel.turnCacheRate ?? null,
        sessionRate: combinedSessionCacheRate,
        mainSessionRate: mainTel.sessionCacheRate,
        withSubagentsSessionRate: combinedSessionCacheRate,
        lastTurnRate: runningWithoutActiveTurn ? null : mainTel.turnCacheRate ?? null,
        lastCallRate: runningWithoutActiveTurn ? null : mainTel.lastCallCacheRate ?? null,
        savedUsd: mainTel.savedUsd + subagentSavedUsd,
      },
      speed: {
        tokPerSec: mainTel.tokPerSec != null ? Math.round(mainTel.tokPerSec * 10) / 10 : null,
        byModel: mainTel.byModelSpeed || {},
        lastDecodeTps: runningWithoutActiveTurn
          ? null
          : mainTel.lastDecodeTps != null ? Math.round(mainTel.lastDecodeTps * 10) / 10 : null,
        currentTurnEstimateTps: runningWithoutActiveTurn
          ? null
          : mainTel.currentTurnEstimateTps != null ? Math.round(mainTel.currentTurnEstimateTps * 10) / 10 : null,
        e2eTokPerSec:
          mainTel.e2eTokPerSec != null ? Math.round(mainTel.e2eTokPerSec * 10) / 10 : null,
        durationSec: runningWithoutActiveTurn
          ? null
          : mainTel.durationSec != null ? Math.round(mainTel.durationSec * 10) / 10 : null,
      },
      cost: {
        sessionUsd: mainTel.usd,
        subagentUsd,
        subagentCount,
        withSubagentsUsd: mainTel.usd + subagentUsd,
        estimated: false,
      },
    };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  } finally {
    if (db) {
      try {
        db.close();
      } catch {}
    }
  }
}

// ============================================================================
// 3b. Remote Server Thread Pricing (React Fiber projection - no local DB rows)
// ============================================================================
function priceRemoteProjection(payload) {
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "Invalid remote payload" };
  }
  const turns = Array.isArray(payload.turns) ? payload.turns : [];
  const rawToolIntervals = Array.isArray(payload.toolIntervals) ? payload.toolIntervals : [];
  const isLegacySingleFixture = payload.sampledAtMs == null && turns.length === 1 && turns[0] && typeof turns[0] === "object"
    && !("id" in turns[0]) && !("providerTurnId" in turns[0]) && !("nativeTurnId" in turns[0]);
  const turnToolIntervals = (turnId, turnDriver) => {
    const hasTid = turnId != null && String(turnId) !== "";
    const allowLegacySingle = !hasTid && isLegacySingleFixture && turnDriver && turnDriver !== "unknown" && (!payload.provider || String(turnDriver) === String(payload.provider));
    if (!hasTid && !allowLegacySingle) return [];
    const filtered = [];
    for (const iv of rawToolIntervals) {
      if (!Array.isArray(iv) || !Number.isFinite(iv[0]) || !Number.isFinite(iv[1]) || iv[1] <= iv[0]) continue;
      if (hasTid) {
        if (iv.length < 3 || iv[2] == null || String(iv[2]) === "") continue;
        if (String(iv[2]) !== String(turnId)) continue;
        if (iv.length >= 4 && iv[3] != null && String(iv[3]) !== "") {
          if (turnDriver && turnDriver !== "unknown" && String(iv[3]) !== String(turnDriver)) continue;
        }
      } else if (iv.length !== 2) {
        continue;
      }
      filtered.push([iv[0], iv[1]]);
    }
    return mergeToolIntervals(filtered);
  };
  let sumUncached = 0;
  let sumCached = 0;
  let sumCacheWrite = 0;
  let sumOutput = 0;
  let sumReasoning = 0;
  let sumUsd = 0;
  let sumSavedUsd = 0;
  let pricedTurns = 0;
  let netOutSum = 0;
  let netSecSum = 0;
  let wallOutSum = 0;
  let wallSecSum = 0;
  let lastTurnTps = null;
  let lastTurnNetSec = null;
  // Pure streaming-decode sums (immune to tool wait + per-call TTFT/prefill gaps).
  let decodeTokSum = 0;
  let decodeSecSum = 0;
  let lastTurnDecodeTps = null;
  let lastStreamSec = null;
  const decodeByModel = {};
  let lastPromptTotal = null;
  let turnCacheRate = null;
  let lastTurnDriver = null;
  let lastTurnModel = null;
  const byModel = {};
  const resolveTurnDriverForPricing = (t) => {
    if (t && Object.prototype.hasOwnProperty.call(t, "driver")) {
      return t.driver ? String(t.driver) : "unknown";
    }
    return payload.provider || "unknown";
  };
  for (const t of turns) {
    const u = t?.usage;
    turnCacheRate = null;
    lastTurnTps = null;
    lastTurnNetSec = null;
    lastTurnDecodeTps = null;
    lastStreamSec = null;
    lastTurnDriver = resolveTurnDriverForPricing(t);
    lastTurnModel = u?.models?.[0] || t?.model || payload.model || null;
    if (!u || typeof u.inputTokens !== "number" || u.usageStatus === "unavailable") {
      continue;
    }
    // This row is the newest candidate turn. Clear the prior sample first so
    // an empty or invalid latest turn never inherits an older turn's speed.
    lastTurnTps = null;
    lastTurnNetSec = null;
    lastTurnDecodeTps = null;
    lastStreamSec = null;
    const driver = resolveTurnDriverForPricing(t);
    let inp = Math.max(0, u.inputTokens || 0);
    const cr = Math.max(0, u.cachedInputTokens || 0);
    const cw = Math.max(0, u.cacheCreationTokens || 0);
    if (driver === "antigravity" && inp >= cr * 2) inp = inp - cr;
    // Each projection turn carries its own aggregate usage. An empty/latest
    // turn stays unknown; do not substitute an older turn or session average.
    if (inp > 0 && Number.isFinite(u.cachedInputTokens)) turnCacheRate = Math.min(inp, cr) / inp;
    const unc = Math.max(0, inp - cr - cw);
    const out = Math.max(0, u.outputTokens || 0);
    const reas = Math.min(out, Math.max(0, u.reasoningTokens || 0));
    const turnModel = (Array.isArray(u.models) && u.models[0]) || payload.model || null;
    const priced = priceStep({ uncached: unc, cached: cr, cacheWrite: cw, output: out }, turnModel, driver);
    sumUncached += unc;
    sumCached += cr;
    sumCacheWrite += cw;
    sumOutput += out;
    sumReasoning += reas;
    sumUsd += priced.usd;
    sumSavedUsd += priced.savedUsd;
    pricedTurns++;
    lastPromptTotal = inp + out;
    lastTurnDriver = driver;
    lastTurnModel = turnModel;
    if (Number.isFinite(t.startedMs) && Number.isFinite(t.completedMs) && t.completedMs > t.startedMs && out > 0) {
      wallOutSum += out;
      wallSecSum += (t.completedMs - t.startedMs) / 1000;
    }
    // Primary speed path: pure streaming decode window (final assistant_message span),
    // pre-computed by the renderer Fiber walk. Skips tool wait AND per-call TTFT/prefill.
    const visOut = Math.max(0, out - reas);
    const sd = t?.streamDecode;
    if (sd && Number.isFinite(sd.streamSec) && sd.streamSec >= 0.18 && Number.isFinite(sd.visFraction) && sd.visFraction > 0) {
      const streamTok = Math.round(visOut * Math.min(1, sd.visFraction));
      if (streamTok >= 12 && streamTok / sd.streamSec < 900) {
        decodeTokSum += streamTok;
        decodeSecSum += sd.streamSec;
        lastTurnDecodeTps = streamTok / sd.streamSec;
        lastStreamSec = sd.streamSec;
        if (turnModel) {
          const cur = (decodeByModel[turnModel] ||= { tok: 0, sec: 0 });
          cur.tok += streamTok;
          cur.sec += sd.streamSec;
        }
      }
    }
    if (Number.isFinite(t.startedMs) && Number.isFinite(t.completedMs) && t.completedMs > t.startedMs + 50 && out >= 15) {
      const netSec = subtractToolWait(t.startedMs, t.completedMs, turnToolIntervals(t.id ?? t.providerTurnId ?? null, driver));
      if (netSec > 0.05) {
        netOutSum += out;
        netSecSum += netSec;
        lastTurnTps = out / netSec;
        lastTurnNetSec = netSec;
        if (turnModel) {
          const cur = (byModel[turnModel] ||= { tok: 0, sec: 0 });
          cur.tok += out;
          cur.sec += netSec;
        }
      }
    }
  }
  let promptTotal = sumUncached + sumCached + sumCacheWrite;
  let uncachedOut = sumUncached;
  let outputOut = sumOutput;
  let totalUsd = sumUsd;
  let totalSavedUsd = sumSavedUsd;
  let estimated = false;
  const sessionCacheRate = promptTotal > 0 ? sumCached / promptTotal : null;
  const providerSwitched = Boolean(payload.provider && lastTurnDriver && payload.provider !== lastTurnDriver);
  const effDriver = providerSwitched ? payload.provider : (lastTurnDriver || payload.provider || "unknown");
  const effModel = providerSwitched ? (payload.model || null) : (lastTurnModel || payload.model || null);
  const effectiveLastPrompt = providerSwitched ? null : lastPromptTotal;
  const effectiveTurnCacheRate = providerSwitched ? null : turnCacheRate;
  let contextUsed = payload.contextUsage?.usedTokens ?? effectiveLastPrompt;
  if (effDriver === "antigravity" && payload.contextUsage?.usedTokens > 0) {
    // T3's acpPerTurnPromptUsage counts promptTokenCount + cachedContentTokenCount,
    // but Gemini's promptTokenCount already includes cachedContentTokenCount.
    const agyCacheRatio = effectiveTurnCacheRate ?? sessionCacheRate ?? 0;
    const deduped =
      agyCacheRatio > 0.01
        ? Math.round(payload.contextUsage.usedTokens / (1 + Math.min(1, agyCacheRatio)))
        : payload.contextUsage.usedTokens;
    contextUsed = deduped;
    if (!payload.isRunning && effectiveLastPrompt != null && deduped > effectiveLastPrompt * 2.5) {
      contextUsed = effectiveLastPrompt;
    }
  }
  let contextMax = Number.isFinite(payload.contextUsage?.maxTokens) && payload.contextUsage.maxTokens > 0
    ? payload.contextUsage.maxTokens
    : null;
  let contextMaxSource = contextMax != null ? "reported" : null;
  if (contextMax == null) {
    contextMax = lookupCatalogContextMax(effModel, effDriver) || null;
    if (contextMax != null) contextMaxSource = "local-catalog";
  }
  if (contextMax == null && effDriver === "antigravity") {
    const model = (effModel || "").toLowerCase();
    contextMax = /opus|sonnet|haiku|claude/.test(model) ? 1000000 : 1048576;
    contextMaxSource = "estimated";
  }
  if (contextMax == null && effDriver === "muse") {
    contextMax = 1007997;
    contextMaxSource = "estimated";
  }
  if (contextMax == null && effDriver === "acpRegistry_devin" && /swe-2/i.test(effModel || "")) {
    contextMax = 262000;
    contextMaxSource = "estimated";
  }
  // Live in-progress Turn 1: contextUsage.usedTokens is already live before the
  // first turnTokenUsage lands, so surface it as current consumption + est. cost.
  if (pricedTurns === 0 && Number.isFinite(contextUsed) && contextUsed > 0) {
    promptTotal = contextUsed;
    uncachedOut = contextUsed;
    outputOut = 0;
    const liveEst = priceStep({ uncached: contextUsed, cached: 0, cacheWrite: 0, output: 0 }, effModel, effDriver);
    totalUsd = liveEst.usd;
    totalSavedUsd = liveEst.savedUsd;
    estimated = true;
  }
  const hasDecode = decodeSecSum > 0;
  const tokPerSec = hasDecode ? decodeTokSum / decodeSecSum : netSecSum > 0.2 ? netOutSum / netSecSum : null;
  const e2eTokPerSec = wallSecSum > 0.2 && wallOutSum > 0 ? wallOutSum / wallSecSum : tokPerSec;
  const byModelSpeed = Object.fromEntries(
    Object.entries(hasDecode ? decodeByModel : byModel)
      .filter(([, v]) => v.sec > 0.1)
      .map(([k, v]) => [k, Math.round((v.tok / v.sec) * 10) / 10])
  );
  const lastDecodeTps = providerSwitched ? null : (lastTurnDecodeTps ?? lastTurnTps);
  const lastDurationSec = providerSwitched ? null : (lastStreamSec ?? lastTurnNetSec);
  const remoteLatest = turns[turns.length - 1] || null;
  const remoteSelectedProvider = payload.provider || effDriver;
  const remoteActive = isRemoteTurnActive(remoteLatest, remoteSelectedProvider);
  const remoteRunningWithoutActive = Boolean(payload.isRunning && !remoteActive);
  const remoteActiveTurnIds = Boolean(payload.isRunning) && !remoteRunningWithoutActive && remoteActive && remoteLatest
    ? Array.from(new Set([remoteLatest.id, remoteLatest.providerTurnId, remoteLatest.nativeTurnId].filter((v) => v != null && String(v) !== "").map(String)))
    : [];
  let currentTurnEstimateTpsRemote = null;
  if (payload.isRunning && turns.length > 0 && !remoteRunningWithoutActive && !providerSwitched) {
    const last = turns[turns.length - 1];
    const drv = last?.driver || payload.provider || null;
    if (!drv || drv === effDriver) {
      const direct = [lastTurnDecodeTps, last?.itemEstimateTps].find(rate => Number.isFinite(rate) && rate > 0 && rate <= 1500);
      if (direct != null) currentTurnEstimateTpsRemote = Math.round(direct * 10) / 10;
      else {
        const out = Number(last?.usage?.outputTokens ?? last?.itemOutputTokens);
        const sMs = last?.startedMs;
        const eMs = last?.completedMs ?? last?.lastItemMs ?? payload.sampledAtMs ?? Date.now();
        if (out > 0 && Number.isFinite(out) && Number.isFinite(sMs) && Number.isFinite(eMs) && eMs > sMs + 50) {
          const net = subtractToolWait(sMs, eMs, turnToolIntervals(last?.id ?? last?.providerTurnId ?? null, drv || effDriver));
          const tps = out / net;
          if (net > 0.05 && Number.isFinite(tps) && tps > 0 && tps <= 1500) currentTurnEstimateTpsRemote = Math.round(tps * 10) / 10;
        }
      }
    }
  }
  const subagentCount = Math.max(0, Number(payload.subagentCount) || 0);
  return {
    ok: true,
    telemetrySource: "remote-projection",
    isRemote: true,
    threadId: String(payload.threadId || ""),
    title: String(payload.title || ""),
    provider: effDriver,
    model: effModel,
    projectTitle: payload.projectTitle || null,
    repoPath: payload.repoPath || null,
    branch: payload.branch || null,
    isRunning: Boolean(payload.isRunning),
    activeTurnIds: remoteActiveTurnIds,
    turnCount: turns.length,
    stepCount: pricedTurns,
    speed: {
      tokPerSec: tokPerSec != null ? Math.round(tokPerSec * 10) / 10 : null,
      byModel: byModelSpeed,
      lastDecodeTps: remoteRunningWithoutActive ? null : lastDecodeTps != null ? Math.round(lastDecodeTps * 10) / 10 : null,
      currentTurnEstimateTps: remoteRunningWithoutActive ? null : currentTurnEstimateTpsRemote != null ? Math.round(currentTurnEstimateTpsRemote * 10) / 10 : null,
      e2eTokPerSec: e2eTokPerSec != null ? Math.round(e2eTokPerSec * 10) / 10 : null,
      durationSec: remoteRunningWithoutActive ? null : lastDurationSec != null ? Math.round(lastDurationSec * 10) / 10 : null,
    },
    tokens: {
      input: promptTotal,
      uncached: uncachedOut,
      uncachedInput: uncachedOut,
      cached: sumCached,
      cachedInput: sumCached,
      cacheWrite: sumCacheWrite,
      cacheWriteInput: sumCacheWrite,
      output: outputOut,
      reasoning: sumReasoning,
      mainTotal: promptTotal + outputOut,
      subagentTokens: 0,
      total: promptTotal + outputOut,
      contextUsed: contextUsed ?? null,
      contextMax: contextMax ?? null,
        contextMaxSource,
    },
    cache: {
      cachedTokens: sumCached,
        mainCachedTokens: sumCached,
        withSubagentsCachedTokens: sumCached,
      cacheWriteTokens: sumCacheWrite,
      sessionRate: sessionCacheRate,
        mainSessionRate: sessionCacheRate,
        withSubagentsSessionRate: sessionCacheRate,
        turnRate: remoteRunningWithoutActive ? null : effectiveTurnCacheRate,
        lastTurnRate: remoteRunningWithoutActive ? null : effectiveTurnCacheRate,
        lastCallRate: null,
        displayRate: effectiveTurnCacheRate ?? sessionCacheRate,
      savedUsd: totalSavedUsd,
    },
    cost: {
      sessionUsd: totalUsd,
      subagentUsd: 0,
      withSubagentsUsd: totalUsd,
      subagentCount,
      estimated,
    },
  };
}

// ============================================================================
// 4. Git Graph & Commit Diff Engine (Filters T3 internal refs/t3/* snapshots)
// ============================================================================
function buildSwimlanes(commits) {
  let lanes = [];
  let maxLanes = 1;

  for (const commit of commits) {
    let lane = lanes.indexOf(commit.hash);
    const incomingLanes = [];
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === commit.hash) incomingLanes.push(i);
    }

    if (lane === -1) {
      lane = lanes.indexOf(null);
      if (lane === -1) {
        lane = lanes.length;
        lanes.push(commit.hash);
      } else {
        lanes[lane] = commit.hash;
      }
    }

    const passThroughLanes = [];
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] !== null && lanes[i] !== commit.hash) {
        passThroughLanes.push(i);
      }
    }

    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === commit.hash && i !== lane) {
        lanes[i] = null;
      }
    }

    const parents = commit.parents;
    const parentConnections = [];

    if (parents.length === 0) {
      lanes[lane] = null;
    } else {
      const firstParent = parents[0];
      const existingFirst = lanes.indexOf(firstParent);
      if (existingFirst !== -1 && existingFirst !== lane) {
        parentConnections.push({ fromLane: lane, toLane: existingFirst, type: "merge-into" });
        lanes[lane] = null;
      } else {
        lanes[lane] = firstParent;
        parentConnections.push({ fromLane: lane, toLane: lane, type: "primary" });
      }

      for (let p = 1; p < parents.length; p++) {
        const parentHash = parents[p];
        let pLane = lanes.indexOf(parentHash);
        if (pLane === -1) {
          pLane = lanes.indexOf(null);
          if (pLane === -1) {
            pLane = lanes.length;
            lanes.push(parentHash);
          } else {
            lanes[pLane] = parentHash;
          }
        }
        parentConnections.push({ fromLane: lane, toLane: pLane, type: "branch-parent" });
      }
    }

    while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
      lanes.pop();
    }
    if (lanes.length > maxLanes) maxLanes = lanes.length;
    if (lane + 1 > maxLanes) maxLanes = lane + 1;

    commit.lane = lane;
    commit.incomingLanes = incomingLanes;
    commit.passThroughLanes = passThroughLanes;
    commit.parentConnections = parentConnections;
  }

  return { commits, maxLanes };
}

function parseRefs(decorateStr) {
  if (!decorateStr || !decorateStr.trim()) return [];
  return decorateStr
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((raw) => {
      if (raw.startsWith("HEAD -> ")) {
        return { kind: "head", label: raw.slice(8).trim(), isHead: true };
      }
      if (raw === "HEAD") {
        return { kind: "head", label: "HEAD", isHead: true };
      }
      if (raw.startsWith("tag: ")) {
        return { kind: "tag", label: raw.slice(5).trim(), isHead: false };
      }
      if (raw.includes("/")) {
        return { kind: "remote", label: raw, isHead: false };
      }
      return { kind: "branch", label: raw, isHead: false };
    })
    .filter((r) => !r.label.startsWith("refs/t3/") && !r.label.includes("t3/checkpoint"));
}

// ============================================================================
// 3c. Hub Context & Unified RPC (zero-restart hot-reload via getGitGraph)
// ============================================================================
let didAutoSyncHosts = false;
function discoverAntigravityRulesPaths(extra = []) {
  const out = new Set(Array.isArray(extra) ? extra.filter(Boolean) : []);
  const homeDir = process.env.HOME || os.homedir();
  const t3Userdata = process.env.T3CODE_HOME
    ? path.resolve(process.env.T3CODE_HOME)
    : path.join(homeDir, ".t3", "userdata");
  const geminiAgyDir = path.join(homeDir, ".gemini", "antigravity");
  const agyRoot = path.join(t3Userdata, "providers", "antigravity");
  const isMacAlias = (linkPath, realPath) => {
    const link = path.resolve(String(linkPath)), real = path.resolve(String(realPath));
    return (link === "/tmp" && real === "/private/tmp") || (link === "/var" && real === "/private/var");
  };
  const lstatIfExists = (p) => {
    try { return fs.lstatSync(p); }
    catch (e) { if (e && e.code === "ENOENT") return null; throw e; }
  };
  const assertSafeAncestors = (targetPath) => {
    let cur = path.resolve(targetPath);
    while (true) {
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
      const pst = lstatIfExists(cur);
      if (pst && pst.isSymbolicLink()) {
        let real = null;
        try { real = fs.realpathSync(cur); } catch { real = null; }
        if (!real || !isMacAlias(cur, real)) throw new Error("unsafe symlink ancestor in AGY rules path: " + cur);
      }
    }
  };
  const validateExistingRuleFile = (rulesFile) => {
    const fileSt = lstatIfExists(rulesFile);
    if (!fileSt) return;
    if (fileSt.isSymbolicLink() || !fileSt.isFile()) throw new Error("AGY 规则文件不是普通文件: " + rulesFile);
    if (fileSt.nlink !== 1) throw new Error("AGY 规则文件存在多重硬链接: " + rulesFile);
    if (!(fileSt.mode & 0o444)) throw new Error("AGY 规则文件不可读取: " + rulesFile);
    let fd = null;
    try {
      fd = fs.openSync(rulesFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const fst = fs.fstatSync(fd);
      if (!fst.isFile() || fst.ino !== fileSt.ino || fst.nlink !== 1) {
        throw new Error("AGY 规则文件句柄校验失败: " + rulesFile);
      }
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch {} }
    }
  };
  assertSafeAncestors(geminiAgyDir);
  const gemSt = lstatIfExists(geminiAgyDir);
  if (gemSt) {
    if (gemSt.isSymbolicLink() || !gemSt.isDirectory()) throw new Error("AGY 全局目录不是普通目录: " + geminiAgyDir);
    fs.readdirSync(geminiAgyDir);
    const gemRulesDir = path.join(geminiAgyDir, "rules");
    const gemRulesSt = lstatIfExists(gemRulesDir);
    if (gemRulesSt) {
      if (gemRulesSt.isSymbolicLink() || !gemRulesSt.isDirectory()) throw new Error("AGY 全局规则目录不是普通目录: " + gemRulesDir);
      fs.readdirSync(gemRulesDir);
    }
    const gemRulesFile = path.join(gemRulesDir, "AGENTS.md");
    validateExistingRuleFile(gemRulesFile);
    out.add(gemRulesFile);
  }
  assertSafeAncestors(agyRoot);
  const rootSt = lstatIfExists(agyRoot);
  if (!rootSt) return [...out];
  if (rootSt.isSymbolicLink() || !rootSt.isDirectory()) {
    throw new Error("AGY 规则根目录不是普通目录: " + agyRoot);
  }
  for (const entry of fs.readdirSync(agyRoot, { withFileTypes: true })) {
    const instDir = path.join(agyRoot, entry.name);
    const instSt = lstatIfExists(instDir);
    if (!instSt) continue;
    if (entry.name === ".DS_Store" || entry.name === ".localized") {
      if (instSt.isSymbolicLink() || !instSt.isFile()) throw new Error("AGY 规则根目录存在非法元数据项: " + instDir);
      continue;
    }
    if (entry.name.startsWith("skills-archived")) {
      if (instSt.isSymbolicLink()) throw new Error("AGY 归档目录是符号链接: " + instDir);
      if (!instSt.isDirectory()) throw new Error("AGY 归档项不是普通目录: " + instDir);
      continue;
    }
    if (instSt.isSymbolicLink()) throw new Error("AGY 实例目录是符号链接: " + instDir);
    if (!instSt.isDirectory()) throw new Error("AGY 实例目录不是普通目录: " + instDir);
    fs.readdirSync(instDir);
    const configDir = path.join(instDir, "config");
    const cfgSt = lstatIfExists(configDir);
    if (!cfgSt) continue;
    if (cfgSt.isSymbolicLink() || !cfgSt.isDirectory()) throw new Error("AGY 配置目录不是普通目录: " + configDir);
    fs.readdirSync(configDir);
    const rulesDir = path.join(configDir, "rules");
    const rulesSt = lstatIfExists(rulesDir);
    if (!rulesSt) continue;
    if (rulesSt.isSymbolicLink() || !rulesSt.isDirectory()) throw new Error("AGY 规则子目录不是普通目录: " + rulesDir);
    fs.readdirSync(rulesDir);
    const rulesFile = path.join(rulesDir, "AGENTS.md");
    validateExistingRuleFile(rulesFile);
    out.add(rulesFile);
  }
  return [...out];
}

function parseDraftProjectRoute(hint) {
  const route = normalizeT3RouteHint(hint);
  const parts = route.split(/[?#]/, 1)[0].split("/").filter(Boolean);
  const lower = parts.map((part) => part.toLowerCase());
  const hasExplicitEnvPrefix = lower[0] === "_t3_env_";
  const effectiveParts = hasExplicitEnvPrefix ? parts.slice(1) : parts;
  const effectiveLower = effectiveParts.map((part) => part.toLowerCase());
  const isDraft = effectiveLower.includes("draft") || effectiveLower.includes("new");
  const isUuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value || "");
  const isProjectDraft = /^(projects?|workspaces?)$/.test(effectiveLower[0] || "") && ["new", "draft"].includes(effectiveLower[2]);
  let environmentId = effectiveParts[1] && !isProjectDraft && (hasExplicitEnvPrefix || !["threads", "_chat"].includes(effectiveLower[0])) ? effectiveParts[0] : null;
  try { if (environmentId) environmentId = decodeURIComponent(environmentId); }
  catch { return { isDraft: false, projectId: null, environmentId: "__INVALID_ENV__", invalidRoute: true }; }
  // T3's actual route is /$environmentId/$threadId, not /project/thread.
  if (!isDraft) {
    return { isDraft: false, projectId: null, environmentId };
  }
  let projectId = null;
  // /draft/$draftId is client-local draft identity and proves no project.
  if (/^(projects?|workspaces?)$/.test(effectiveLower[0] || "") && isUuid(effectiveParts[1]) && ["new", "draft"].includes(effectiveLower[2])) projectId = effectiveParts[1];
  return { isDraft: true, projectId };
}

function resolveHubContext(args = {}) {
  if (!didAutoSyncHosts) {
    didAutoSyncHosts = true;
    try { mcpRouter.autoSyncHosts(); } catch {}
  }
  const threadHint = args.threadHint || args.threadId || "";
  const routeHint = args.routeHint || args.threadHint || args.threadId || "";
  const hint = routeHint || threadHint;
  const draft = parseDraftProjectRoute(hint);
  let parsed = extractThreadId(hint);
  if (draft.invalidRoute || (parsed && parsed.startsWith("__ROUTE_"))) return { ok: false, error: "无效或非会话路由" };
  if (parsed === "__NEW__") { parsed = null; draft.isDraft = true; }
  try {
    let environmentId = null;
    if (draft.environmentId) {
      try { environmentId = fs.readFileSync(path.join(path.dirname(DB_PATH), "environment-id"), "utf8").trim(); } catch {}
      if (!environmentId || environmentId.toLowerCase() !== draft.environmentId.toLowerCase()) return { ok: false, error: "无法确认当前运行环境，请切回本机工作区" };
    }
    if (!fs.existsSync(DB_PATH)) {
      return { ok: false, error: "statev2.sqlite not found" };
    }
    let db;
    try {
      db = new DatabaseSync(DB_PATH, { open: true, readOnly: true });
      let threadRow = null;
      let draftProject = null;
      if (draft.isDraft) {
        if (draft.projectId) {
          try { draftProject = db.prepare("SELECT * FROM projection_projects WHERE project_id = ? COLLATE NOCASE").get(draft.projectId); } catch {}
        }
        if (!draftProject?.project_id || draftProject.deleted_at || !String(draftProject.workspace_root || "").trim()) return { ok: false, error: "无法确认新会话所属项目，请先选择项目" };
        threadRow = { thread_id: "__NEW__", project_id: draftProject.project_id, title: "", default_provider: null, payload_json: "{}" };
      } else if (parsed) {
        threadRow = db.prepare("SELECT thread_id, project_id, title, default_provider, updated_at, payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ?").get(parsed);
        if (!threadRow) return { ok: false, error: "无法确认会话所属项目，请检查连接" };
      }
      if (!threadRow) return { ok: false, error: "无法确认当前会话所属项目，请先选择项目" };
      const threadId = threadRow.thread_id;
      const projectId = threadRow.project_id;
      const payload = (() => { try { return JSON.parse(threadRow.payload_json || "{}"); } catch { return {}; } })();
      let projectRow = draftProject;
      if (!projectRow && projectId) {
        try { projectRow = db.prepare("SELECT * FROM projection_projects WHERE project_id = ?").get(projectId); } catch {}
      }
      if (!projectRow || projectRow.deleted_at || !String(projectRow.workspace_root || "").trim()) return { ok: false, error: "无法确认会话所属项目，请检查连接" };
      const worktreeRoot = typeof payload.worktreePath === "string" ? payload.worktreePath.trim() : "";
      const projectRoot = memoryVault.resolveSessionProjectRoot({ projectRoot: projectRow.workspace_root, worktreePath: worktreeRoot || undefined });
      const projectTitle = projectRow?.title || path.basename(projectRoot || "") || threadRow.title || "";
      const projectSlug = (() => {
        if (projectRoot) {
          try { return require("./memory-vault.cjs").slugFromProjectRoot(projectRoot); } catch { return path.basename(projectRoot); }
        }
        return null;
      })();
      let activeProvider = threadRow.default_provider || null;
      let activeModel = payload?.modelSelection?.model || null;
      try {
        const psRow = db.prepare("SELECT provider, driver, model FROM orchestration_v2_projection_provider_sessions WHERE thread_id = ? ORDER BY updated_at DESC LIMIT 1").get(threadId);
        if (psRow) {
          activeProvider = psRow.driver || psRow.provider || activeProvider;
          activeModel = psRow.model || activeModel;
        }
      } catch {}
      db.close();
      // Counts (best-effort, never throw)
      let activePlugins = 0;
      let activeSkills = 0;
      let activeMcps = 0;
      let activeHooks = 0;
      let projectMemories = 0;
      let subagents = 0;
      try {
        const pl = hubPlugins.listPlugins({ projectRoot });
        activePlugins = (pl.items || []).filter((i) => projectRoot ? (i.scope === "global" || i.scope === "project") : i.scope === "global").length;
      } catch {}
      try {
        const hk = hubHooks.listHooks({ projectRoot });
        activeHooks = (hk.items || []).filter((h) => h.enabled !== false && h.scope !== "off").length;
      } catch {}
      try {
        if (projectRoot) {
          const listed = hubSkills.listAssets({ projectRoot });
          activeSkills = (listed.items || []).filter((i) => i.scope === "global" || i.scope === "project").length;
        } else {
          const listed = hubSkills.listAssets({});
          activeSkills = (listed.items || []).filter((i) => i.scope === "global").length;
        }
      } catch {}
      try {
        const m = mcpRouter.listMcpServers({ projectRoot });
        activeMcps = (m.items || []).filter((x) => x.mode && x.mode !== "off").length;
      } catch {}
      try {
        if (projectRoot) {
          const ov = memoryVault.getOverview({ projectRoot });
          const entry = (ov.projects || []).find((p) => p.slug === projectSlug) || (ov.projects || []).find((p) => p.projectRoot === projectRoot);
          projectMemories = entry ? Number(entry.total) || 0 : 0;
        } else {
          const ov = memoryVault.getOverview({});
          projectMemories = Number(ov.totalMemories) || 0;
        }
      } catch {}
      try {
        const s = hubSubagents.listSubagents({ projectRoot });
        subagents = (s.effectiveItems || []).length;
      } catch {}
      return { ok: true, threadId, environmentId, projectId, projectRoot, projectSlug, projectTitle, activeProvider, activeModel, ...(draft.isDraft ? { draftProjectVerified: true } : {}), counts: { activePlugins, activeSkills, activeMcps, activeHooks, projectMemories, subagents } };
    } finally {
      try { db?.close(); } catch {}
    }
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// Bridge helpers for embed health/trim JSON (python service exposes both camelCase and snake_case)
async function fetchEmbedHealthJson() {
  const urls = ["http://127.0.0.1:8001/health"];
  for (const url of urls) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => { try { ctrl.abort(); } catch {} }, 3000);
      let res;
      if (typeof fetch === "function") {
        res = await fetch(url, { signal: ctrl.signal });
      } else {
        // fallback via http for older runtimes
        const http = require("node:http");
        res = await new Promise((resolve, reject) => {
          const req = http.get(url, (r) => {
            const chunks = [];
            r.on("data", (c) => chunks.push(c));
            r.on("end", () => resolve({ ok: r.statusCode >= 200 && r.statusCode < 300, json: async () => JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
          });
          req.on("error", reject);
          setTimeout(() => { try { req.destroy(new Error("timeout")); } catch {} }, 3000);
        });
      }
      clearTimeout(timer);
      if (!res.ok) continue;
      const json = await res.json();
      if (json && typeof json === "object") return json;
    } catch {}
  }
  // last fallback: curl spawnSync (sync, best-effort)
  try {
    const { spawnSync } = require("node:child_process");
    const r = spawnSync("curl", ["-s", "-m", "3", "--connect-timeout", "2", "http://127.0.0.1:8001/health"], { encoding: "utf8", timeout: 4000 });
    if (r.status === 0 && r.stdout) return JSON.parse(r.stdout);
  } catch {}
  return null;
}
function embedMetricsFromHealth(healthJson) {
  if (!healthJson || typeof healthJson !== "object") return {};
  const pick = (a, b) => (healthJson[a] != null ? healthJson[a] : healthJson[b]);
  const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 10) / 10 : 0);
  const int = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const baseActiveMb = num(pick("baseActiveMb", "base_active_mb"));
  const ceilingMb = num(pick("ceilingMb", "ceiling_mb"));
  const cacheMb = num(pick("cacheMb", "cache_mb"));
  const cacheLimitMb = num(pick("cacheLimitMb", "cache_limit_mb"));
  const autoTrimmedCount = int(pick("autoTrimmedCount", "auto_trimmed_count"));
  return { baseActiveMb, ceilingMb, cacheMb, cacheLimitMb, autoTrimmedCount,
    base_active_mb: baseActiveMb, ceiling_mb: ceilingMb, cache_mb: cacheMb, cache_limit_mb: cacheLimitMb, auto_trimmed_count: autoTrimmedCount };
}
async function enrichWithEmbedMetrics(target) {
  try {
    const h = await fetchEmbedHealthJson();
    if (!h) return target;
    const m = embedMetricsFromHealth(h);
    // ensure passthrough (camelCase primary)
    for (const k of ["baseActiveMb", "ceilingMb", "cacheMb", "cacheLimitMb", "autoTrimmedCount"]) {
      if (target[k] == null) target[k] = m[k];
      else if (Number(target[k]) === 0 && Number(m[k]) !== 0) target[k] = m[k];
    }
    // also snake_case for completeness
    for (const k of ["base_active_mb", "ceiling_mb", "cache_mb", "cache_limit_mb", "auto_trimmed_count"]) {
      if (target[k] == null) target[k] = m[k];
    }
    return target;
  } catch { return target; }
}
async function fetchEmbedTrimJson() {
  const url = "http://127.0.0.1:8001/trim";
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => { try { ctrl.abort(); } catch {} }, 3000);
    let res;
    if (typeof fetch === "function") {
      res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: ctrl.signal });
    } else {
      const http = require("node:http");
      res = await new Promise((resolve, reject) => {
        const req = http.request(url, { method: "POST", headers: { "Content-Type": "application/json" } }, (r) => {
          const chunks = [];
          r.on("data", (c) => chunks.push(c));
          r.on("end", () => resolve({ ok: r.statusCode >= 200 && r.statusCode < 300, json: async () => JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
        });
        req.on("error", reject);
        req.end("{}");
        setTimeout(() => { try { req.destroy(new Error("timeout")); } catch {} }, 3000);
      });
    }
    clearTimeout(timer);
    if (!res.ok) {
      let msg = "trim failed " + res.status;
      try { msg += " " + (await res.clone?.().text?.() || ""); } catch {}
      const txt = await res.text().catch(() => "");
      if (txt) msg = txt;
      throw new Error(msg);
    }
    return await res.json();
  } catch (e) {
    // last fallback via curl
    try {
      const { spawnSync } = require("node:child_process");
      const r = spawnSync("curl", ["-s", "-m", "3", "--connect-timeout", "2", "-X", "POST", "-H", "Content-Type: application/json", "-d", "{}", "http://127.0.0.1:8001/trim"], { encoding: "utf8", timeout: 4000 });
      if (r.status === 0 && r.stdout) return JSON.parse(r.stdout);
    } catch {}
    throw e;
  }
}

const PROJECT_MEMORY_ACTIONS = new Set([
  "memory:overview", "memory:list", "memory:search", "memory:write", "memory:save",
  "memory:worktreeInfo", "memory:promote", "memory:ensureLink", "memory:openFolder",
  "memory:consolidate", "memory:rollback", "memory:delete", "memory:pinToAgentsMd",
  "memory:migratePowerContext", "memory:importHostMemories", "memory:health",
  "memory:stats", "memory:vectorStats", "memory:hygiene",
]);
function projectMemoryPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("project_memory_context_required");
  for (const key of ["scope", "scopeFilter", "memory_scope", "memoryScope", "projectSlug"]) {
    if (["global", "_global"].includes(String(payload[key] || "").trim().toLowerCase())) throw new Error("global_memory_disabled");
  }
  const raw = payload.projectRoot;
  if (typeof raw !== "string" || !raw.trim() || !path.isAbsolute(raw)) throw new Error("project_memory_context_required");
  let root;
  try { root = fs.realpathSync(raw); if (!fs.statSync(root).isDirectory()) throw new Error(); }
  catch { throw new Error("project_memory_context_required"); }
  const home = process.env.HOME || os.homedir();
  const canonical = (value) => { try { return fs.realpathSync(value); } catch { return path.resolve(value); } };
  const homeRoot = canonical(home);
  const hubRoot = canonical(process.env.T3_HUB_DIR || path.join(home, ".t3", "hub"));
  const pluginRoot = canonical(path.join(home, ".t3", "hud-plugin"));
  if (root === path.parse(root).root || root === homeRoot || root === canonical(path.join(home, ".t3")) ||
      [hubRoot, pluginRoot].some((base) => root === base || root.startsWith(base + path.sep))) throw new Error("project_memory_context_required");
  return { ...payload, projectRoot: root, includeGlobal: false };
}

function readHudLocalEnvironmentId() {
  try {
    const paths = resolveActiveT3Paths();
    if (fs.existsSync(agyQuotaModule)) {
      const { readT3EnvironmentId } = require(agyQuotaModule);
      if (typeof readT3EnvironmentId === "function") return readT3EnvironmentId(paths);
    }
    // The four-file transition can run before the optional quota reader is installed.
    let file = path.join(paths.userDataDir, "environment-id");
    const alias = process.platform === "darwin" && file.match(/^\/(?:tmp|var|etc)(?=\/)/)?.[0];
    if (alias && fs.realpathSync(alias) === "/private" + alias) file = "/private" + file;
    if (fs.realpathSync(file) !== file) return "";
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW || 0));
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 128 || fs.realpathSync(file) !== file) return "";
      const buffer = Buffer.alloc(129);
      const size = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (size !== stat.size) return "";
      const id = buffer.toString("utf8", 0, size).trim();
      return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) ? id : "";
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function assertHudConfigNoSymlink(filePath) {
  const st = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (st && (st.isSymbolicLink() || !st.isFile())) {
    throw new Error("Refusing symlink or non-regular HUD config file");
  }
}

async function hubCall(action, payload = {}) {
  try {
    if (PROJECT_MEMORY_ACTIONS.has(action)) payload = projectMemoryPayload(payload);
    switch (action) {
      case "hub:update:check": return await hudUpdater.check({ background: payload?.background === true });
      case "hub:update:apply": return await hudUpdater.apply(payload?.expectedVersion, { auto: payload?.auto === true });
      case "hub:update:config:get": {
        try {
          assertHudConfigNoSymlink(HUD_CONFIG_PATH);
          let cfg = {};
          if (fs.existsSync(hudConfigModule)) {
            cfg = require(hudConfigModule).readHudConfig(HUD_CONFIG_PATH) || {};
          } else {
            let fd = null;
            try {
              fd = fs.openSync(HUD_CONFIG_PATH, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
              if (!fs.fstatSync(fd).isFile()) throw new Error("HUD config is not a regular file");
              const parsed = JSON.parse(fs.readFileSync(fd, "utf8"));
              if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                throw new Error("HUD config root must be a plain object");
              }
              cfg = parsed;
            } catch (err) {
              if (err?.code !== "ENOENT") throw err;
              cfg = {};
            } finally {
              if (fd !== null) try { fs.closeSync(fd); } catch {}
            }
          }
          if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
            throw new Error("HUD config root must be a plain object");
          }
          const hasAutoHotUpdate = Object.hasOwn(cfg, "autoHotUpdate") && cfg.autoHotUpdate !== undefined;
          if (hasAutoHotUpdate && typeof cfg.autoHotUpdate !== "boolean") {
            return {
              ok: false,
              autoHotUpdate: false,
              currentVersion: readInstalledVersion(HUD_PLUGIN_DIR),
              error: "autoHotUpdate must be boolean",
            };
          }
          return {
            ok: true,
            autoHotUpdate: hasAutoHotUpdate ? cfg.autoHotUpdate : true,
            currentVersion: readInstalledVersion(HUD_PLUGIN_DIR),
          };
        } catch (err) {
          return {
            ok: false,
            autoHotUpdate: false,
            currentVersion: readInstalledVersion(HUD_PLUGIN_DIR),
            error: err?.message || "HUD config is unreadable",
          };
        }
      }
      case "hub:update:config:set": {
        if (typeof payload?.autoHotUpdate !== "boolean") {
          return { ok: false, error: "autoHotUpdate must be boolean" };
        }
        const enabled = payload.autoHotUpdate;
        try {
          assertHudConfigNoSymlink(HUD_CONFIG_PATH);
          if (!fs.existsSync(hudConfigModule)) {
            return { ok: false, error: "Safe HUD config writer is unavailable" };
          }
          const mod = require(hudConfigModule);
          if (typeof mod.updateHudConfig === "function") {
            mod.updateHudConfig(HUD_CONFIG_PATH, (current) => {
              assertHudConfigNoSymlink(HUD_CONFIG_PATH);
              return { ...current, autoHotUpdate: enabled };
            });
          } else if (typeof mod.updateHudAutoHotUpdate === "function") {
            mod.updateHudAutoHotUpdate(enabled, { pluginDir: HUD_PLUGIN_DIR });
          } else {
            return { ok: false, error: "Safe HUD config writer is unavailable" };
          }
          const saved = mod.readHudConfig(HUD_CONFIG_PATH);
          return { ok: true, autoHotUpdate: Boolean(saved?.autoHotUpdate) };
        } catch (err) {
          return { ok: false, error: err?.message || "Failed to update HUD config" };
        }
      }
      case "hub:update:runtime": return { ok: true, backendHash: loadedBackendHash };
      case "hub:getDrawerScript": {
        const code = fs.readFileSync(path.join(__dirname, "hub-drawer-ui.js"), "utf8");
        return { ok: true, code };
      }
      case "hub:getContext": return resolveHubContext(payload);
      case "slash:list": {
        const projectRoot = payload.projectRoot || null;
        const listed = hubSkills.listAssets({ projectRoot });
        const skills = (listed.items || []).filter((i) => i.scope === "global" || i.scope === "project").map((i) => ({
          id: i.id, name: i.name, description: i.description, scope: i.scope, path: i.path, source: i.source,
        }));
        // Enforce per-project isolation: project-scoped skills only for this projectRoot.
        // listAssets already checks filesystem, but double-filter ensures no cross-project leak.
        let subagentsList = [];
        try {
          const s = hubSubagents.listSubagents({ projectRoot });
          subagentsList = (s.effectiveItems || []).filter((x) => x.enabled !== false);
        } catch {}
        return { ok: true, projectRoot: projectRoot || null, skills, subagents: subagentsList };
      }
      case "skills:list": return hubSkills.listAssets(payload);
      case "skills:setScope": return hubSkills.setSkillScope(payload);
      case "skills:importGitHub": return await hubSkills.importFromGitHub(payload);
      case "skills:update":
      case "skills:updatePackage": return await hubSkills.updatePackage(payload);
      case "skills:remove":
      case "skills:removePackage": return await hubSkills.removePackage(payload);
      case "agentsMd:get": return hubSkills.getAgentsMd(payload);
      case "agentsMd:save": return hubSkills.saveAgentsMd(payload);
      case "agentsMd:injectSoftRoute": return hubSkills.injectSoftRoute(payload);
      case "agentsMd:syncProjectReference": return hubSkills.syncProjectRuleReference(payload);
      case "mcp:list": return mcpRouter.listMcpServers(payload);
      case "mcp:setMode": return mcpRouter.setMcpMode(payload);
      case "mcp:upsert": return mcpRouter.upsertMcpServer(payload);
      case "mcp:remove": return mcpRouter.removeMcpServer(payload);
      case "plugins:list": return hubPlugins.listPlugins(payload);
      case "plugins:catalog": return hubPlugins.listCatalog(payload);
      case "plugins:install": return hubPlugins.installFromMarketplace(payload);
      case "plugins:toggleAgent": return hubPlugins.togglePluginForAgent({ ...(payload || {}), mcpRouter, skillsManager: hubSkills, hooksManager: hubHooks });
      case "plugins:setScope": {
        const res = hubPlugins.setPluginScope(payload);
        if (payload && payload.id === "t3-memory-vault" && payload.scope && payload.scope !== "off") {
          try { mcpRouter.autoSyncHosts(); } catch {}
        }
        return res;
      }
      case "plugins:installGitHub":
      case "plugins:importGitHub":
        return await hubPlugins.installPluginFromGitHub({
          ...(payload || {}),
          input: payload?.input || payload?.repoInput || payload?.url || "",
        });
      case "mcp:probe": return await mcpRouter.probeMcpServers(payload);
      case "mcp:autoSync": return mcpRouter.autoSyncHosts();
      case "mcp:syncClis": return mcpRouter.syncRouterToClis();
      case "mcp:toggleAgent": return mcpRouter.toggleServerForAgent(payload);
      case "mcp:setAgents": return mcpRouter.setServerAgents(payload);
      case "mcp:matrix": return mcpRouter.getAgentMatrix(payload);
      case "skills:toggleAgent": return hubSkills.toggleSkillForAgent(payload);
      case "hooks:list": return hubHooks.listHooks(payload);
      case "hooks:toggle":
      case "hooks:setScope": return hubHooks.toggleHook(payload);
      case "hooks:save":
      case "hooks:upsert": return hubHooks.saveCustomHook(payload);
      case "hooks:delete":
      case "hooks:remove": return hubHooks.deleteCustomHook(payload);
      case "hooks:setPlugin": return hubHooks.setPluginHooks(payload);
      case "memory:connections": return hubMemoryConnections.getMemoryConnections(payload || {});
      case "memory:agentAccess:get": return getMemoryAccessRuntime().getAgentAccess();
      case "memory:agentAccess:set": {
        const runtime = getMemoryAccessRuntime();
        const result = runtime.setAgentAccess(payload || {});
        if (!isTestEnv()) runtime.startWatching();
        return result;
      }
      case "memory:setup": {
        const runtime = getMemoryAccessRuntime();
        const result = runtime.setup();
        if (!isTestEnv()) runtime.startWatching();
        return result;
      }
      case "memory:runtimeHints:get": return getMemoryAccessRuntime().getT3RuntimeHints();
      case "memory:runtimeHints:set": return getMemoryAccessRuntime().setT3RuntimeHints(payload || {});
      case "memory:overview": return memoryVault.getOverview(payload);
      case "memory:list":
      case "memory:search": return await memoryVault.listMemories(payload);
      case "memory:write":
      case "memory:save": return await memoryVault.saveMemory(payload);
      case "memory:worktreeInfo": return memoryVault.resolveWorktreeContext(payload.projectRoot);
      case "memory:promote": return memoryVault.promoteWorktreeMemory(payload);
      case "memory:ensureLink": return memoryVault.ensureProjectMemoryLink(payload?.projectRoot);
      case "memory:openFolder": {
        const linkRes = memoryVault.ensureProjectMemoryLink(payload?.projectRoot);
        const vaultPath = linkRes?.vaultPath || null;
        const linkPath = linkRes?.linkPath || null;
        if (!vaultPath) return { ok: false, error: linkRes?.error || "vaultPath unavailable" };
        const shouldOpen = payload?.openInFinder !== false && !isTestEnv();
        if (shouldOpen) {
          try { execFile("open", [vaultPath], () => {}); } catch {}
        }
        return { ok: true, vaultPath, linkPath };
      }
      case "memory:consolidate": return await memoryVault.consolidateMemories(payload);
      case "memory:rollback": return await memoryVault.rollbackMemory(payload);
      case "memory:delete": return memoryVault.deleteMemory(payload);
      case "memory:pinToAgentsMd": return memoryVault.pinToAgentsMd(payload);
      case "memory:migratePowerContext": return await memoryVault.migrateFromPowerContext(payload);
      case "memory:importHostMemories": return await memoryVault.importHostMemories(payload || {});
      case "memory:health": return memoryVault.getMemoryHealth(payload || {});
      case "memory:stats": {
        const s = memoryVault.getStats(payload || {});
        try { await enrichWithEmbedMetrics(s); if (s.vectorStats) await enrichWithEmbedMetrics(s.vectorStats); } catch {}
        return s;
      }
      case "memory:vectorStats": {
        const vs = memoryVault.getStats(payload || {});
        try { await enrichWithEmbedMetrics(vs); if (vs.vectorStats) await enrichWithEmbedMetrics(vs.vectorStats); } catch {}
        return vs;
      }
      case "memory:hygiene": return memoryVault.runHygiene(payload || {});
      case "memory:dream:get": {
        // Legacy diagnostics may inspect the stopped service, never cross-project journals.
        return { ok: true, config: { enabled: false }, runtime: { scheduler: getDreamSchedulerStatus() } };
      }
      case "memory:dream:save":
      case "memory:dream:update":
      case "memory:dream:run": return { ok: false, error: "dream_disabled_project_memory_only" };
      case "embed:status": {
        const status = await embedManager.getStatus();
        delete status.vectorStats;
        delete status.vectorStatsError;
        if (payload?.projectRoot != null) try {
          const stats = memoryVault.getStats(projectMemoryPayload(payload));
          if (stats?.ok === false) { delete status.vectorStats; status.vectorStatsError = stats.error || "记忆库统计不可用"; }
          else if (stats?.vectorStats) { status.vectorStats = stats.vectorStats; delete status.vectorStatsError; }
        } catch { delete status.vectorStats; status.vectorStatsError = "记忆库统计不可用"; }
        try { await enrichWithEmbedMetrics(status); if (status.vectorStats) await enrichWithEmbedMetrics(status.vectorStats); } catch {}
        return status;
      }
      case "embed:test": return await embedManager.testEmbedding();
      case "embed:trim": {
        try {
          const beforeHealth = await fetchEmbedHealthJson().catch(() => null);
          const trimRes = await fetchEmbedTrimJson();
          const afterHealth = await fetchEmbedHealthJson().catch(() => null);
          const before = (trimRes && trimRes.before) ? trimRes.before : (beforeHealth ? embedMetricsFromHealth(beforeHealth) : {});
          const after = (trimRes && trimRes.after) ? trimRes.after : (afterHealth ? embedMetricsFromHealth(afterHealth) : {});
          // compute freed from trim before/after cache/active if present
          let freedCacheMb = null;
          let freedActiveMb = null;
          try {
            const bCache = before.cache_mb ?? before.cacheMb ?? beforeHealth?.cache_mb ?? beforeHealth?.cacheMb;
            const aCache = after.cache_mb ?? after.cacheMb ?? afterHealth?.cache_mb ?? afterHealth?.cacheMb;
            if (Number.isFinite(Number(bCache)) && Number.isFinite(Number(aCache))) freedCacheMb = Number(bCache) - Number(aCache);
            const bAct = before.active_mb ?? before.activeMb ?? beforeHealth?.active_mb ?? beforeHealth?.activeMb;
            const aAct = after.active_mb ?? after.activeMb ?? afterHealth?.active_mb ?? afterHealth?.activeMb;
            if (Number.isFinite(Number(bAct)) && Number.isFinite(Number(aAct))) freedActiveMb = Number(bAct) - Number(aAct);
          } catch {}
          const out = { ok: true, before, after, freedCacheMb, freedActiveMb, raw: trimRes };
          // ensure health metrics passthrough
          const afterMetrics = afterHealth ? embedMetricsFromHealth(afterHealth) : {};
          for (const k of ["baseActiveMb", "ceilingMb", "cacheMb", "cacheLimitMb", "autoTrimmedCount"]) {
            if (out[k] == null && afterMetrics[k] != null) out[k] = afterMetrics[k];
          }
          return out;
        } catch (e) {
          return { ok: false, error: e?.message || String(e) };
        }
      }
      case "embed:switch": {
        const project = payload?.projectRoot != null ? projectMemoryPayload(payload) : null;
        try { memoryVault.invalidateEmbedHealthCache?.(); } catch {}
        const switchResult = await embedManager.switchModel({
          ...(payload || {}),
          onReadyReindex: () => {
            try { memoryVault.invalidateEmbedHealthCache?.(); } catch {}
            return project ? memoryVault.reindexVectors({ ...project, forceModelSync: true }) : { ok: false, error: "project_memory_context_required" };
          },
        });
        try {
          if (project && switchResult && switchResult.ok && switchResult.mode === "mlx") {
            try { memoryVault.invalidateEmbedHealthCache?.(); } catch {}
            memoryVault.reindexVectors({ ...project, forceModelSync: true });
          }
        } catch {}
        return switchResult;
      }
      case "subagents:list": return hubSubagents.listSubagents(payload);
      case "subagents:resolveRoute":
      case "subagents:resolve": return hubSubagents.resolveSubagentRoute(payload);
      case "subagents:save": {
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid subagent payload");
        const p = payload;
        const hasScope = Object.prototype.hasOwnProperty.call(p, "scope") && p.scope !== undefined;
        if (hasScope && p.scope !== "global" && p.scope !== "project") throw new Error("invalid scope: " + String(p.scope));
        if (Object.prototype.hasOwnProperty.call(p, "item") && p.item !== undefined && (!p.item || typeof p.item !== "object" || Array.isArray(p.item))) throw new Error("invalid item payload");
        const hasItemScope = Boolean(p.item && Object.prototype.hasOwnProperty.call(p.item, "scope") && p.item.scope !== undefined);
        if (hasItemScope && p.item.scope !== "global" && p.item.scope !== "project") throw new Error("invalid scope: " + String(p.item.scope));
        if (hasScope && hasItemScope && p.scope !== p.item.scope) throw new Error("conflicting scope");
        const saveScope = hasScope ? p.scope : (hasItemScope ? p.item.scope : ((Object.prototype.hasOwnProperty.call(p, "projectRoot") && p.projectRoot !== undefined && p.projectRoot !== null) ? "project" : "global"));
        return hubSubagents.saveSubagent({
          ...p,
          scope: saveScope,
          extraSyncPaths: saveScope === "project" ? (Array.isArray(p.extraSyncPaths) ? p.extraSyncPaths : []) : discoverAntigravityRulesPaths(p.extraSyncPaths),
        });
      }
      case "subagents:update": {
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid subagent payload");
        const p = payload;
        const hasScope = Object.prototype.hasOwnProperty.call(p, "scope") && p.scope !== undefined;
        if (hasScope && p.scope !== "global" && p.scope !== "project") throw new Error("invalid scope: " + String(p.scope));
        if (Object.prototype.hasOwnProperty.call(p, "item") && p.item !== undefined && (!p.item || typeof p.item !== "object" || Array.isArray(p.item))) throw new Error("invalid item payload");
        const hasItemScope = Boolean(p.item && Object.prototype.hasOwnProperty.call(p.item, "scope") && p.item.scope !== undefined);
        if (hasItemScope && p.item.scope !== "global" && p.item.scope !== "project") throw new Error("invalid scope: " + String(p.item.scope));
        if (hasScope && hasItemScope && p.scope !== p.item.scope) throw new Error("conflicting scope");
        const hasProj = Object.prototype.hasOwnProperty.call(p, "projectRoot") && p.projectRoot !== undefined;
        const hasItemProj = Boolean(p.item && Object.prototype.hasOwnProperty.call(p.item, "projectRoot") && p.item.projectRoot !== undefined);
        if (hasProj && hasItemProj && p.projectRoot !== p.item.projectRoot) throw new Error("conflicting projectRoot");
        const targetScope = hasScope ? p.scope : (hasItemScope ? p.item.scope : ((hasProj && p.projectRoot !== null) || (hasItemProj && p.item.projectRoot !== null) ? "project" : "global"));
        if (p.item && typeof p.item === "object") {
          return hubSubagents.saveSubagent({
            ...p,
            scope: targetScope,
            extraSyncPaths: targetScope === "project" ? (Array.isArray(p.extraSyncPaths) ? p.extraSyncPaths : []) : discoverAntigravityRulesPaths(p.extraSyncPaths),
          });
        }
        if (p.id || p.name) {
          const { id, item: _item, scope: _scope, projectRoot, extraSyncPaths, ...patch } = p;
          const targetId = id || patch.name;
          let existing;
          try {
            const listed = hubSubagents.listSubagents({ projectRoot: targetScope === "project" ? (projectRoot || null) : null });
            const findIn = (arr) => (arr || []).find((x) => x.id === targetId)
              || (arr || []).find((x) => x.name === (patch.name || targetId));
            existing = targetScope === "project"
              ? (findIn(listed.projectItems) || findIn(listed.globalItems))
              : findIn(listed.globalItems);
          } catch {}
          const mergedItem = {
            ...existing, ...patch,
            id: existing ? existing.id : targetId,
            name: patch.name !== undefined ? patch.name : (existing ? existing.name : targetId),
          };
          return hubSubagents.saveSubagent({
            ...p,
            scope: targetScope,
            projectRoot: targetScope === "project" ? projectRoot : null,
            extraSyncPaths: targetScope === "project" ? (Array.isArray(extraSyncPaths) ? extraSyncPaths : []) : discoverAntigravityRulesPaths(extraSyncPaths),
            item: mergedItem,
          });
        }
        return hubSubagents.saveSubagent({
          ...p,
          scope: targetScope,
          extraSyncPaths: targetScope === "project" ? (Array.isArray(p.extraSyncPaths) ? p.extraSyncPaths : []) : discoverAntigravityRulesPaths(p.extraSyncPaths),
        });
      }
      case "subagents:delete": {
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid subagent payload");
        const dp = payload;
        const hasDelScope = Object.prototype.hasOwnProperty.call(dp, "scope") && dp.scope !== undefined;
        if (hasDelScope && dp.scope !== "global" && dp.scope !== "project") throw new Error("invalid scope: " + String(dp.scope));
        const delScope = hasDelScope ? dp.scope : ((Object.prototype.hasOwnProperty.call(dp, "projectRoot") && dp.projectRoot !== undefined && dp.projectRoot !== null) ? "project" : "global");
        return hubSubagents.deleteSubagent({
          ...dp,
          scope: delScope,
          extraSyncPaths: delScope === "project" ? (Array.isArray(dp.extraSyncPaths) ? dp.extraSyncPaths : []) : discoverAntigravityRulesPaths(dp.extraSyncPaths),
        });
      }
      case "subagents:orchestration:get": {
        const p = payload && typeof payload === "object" ? payload : {};
        if (Object.prototype.hasOwnProperty.call(p, "scope") && p.scope !== undefined && p.scope !== "global" && p.scope !== "project") {
          return { ok: false, error: "invalid orchestration scope" };
        }
        const effectiveProjectRoot = p.scope === "global" ? undefined : (p.projectRoot || p.project || undefined);
        if (p.scope === "project" && (!effectiveProjectRoot || typeof effectiveProjectRoot !== "string" || !effectiveProjectRoot.trim())) {
          return { ok: false, error: "projectRoot required for project scope" };
        }
        try {
          return hubSubagents.getOrchestrationState({
            ...p,
            projectRoot: effectiveProjectRoot,
            ...(Array.isArray(p.hosts) ? { hosts: p.hosts } : { additionalHosts: discoverAntigravityRulesPaths(p.additionalHosts) }),
          });
        } catch (e) {
          return { ok: false, error: e?.message || String(e) };
        }
      }
      case "subagents:orchestration:update": {
        const p = payload && typeof payload === "object" ? payload : {};
        if (Object.prototype.hasOwnProperty.call(p, "config") && p.config !== undefined && (!p.config || typeof p.config !== "object" || Array.isArray(p.config))) {
          return { ok: false, error: "invalid orchestration config payload" };
        }
        if (Object.prototype.hasOwnProperty.call(p, "patch") && p.patch !== undefined && (!p.patch || typeof p.patch !== "object" || Array.isArray(p.patch))) {
          return { ok: false, error: "invalid orchestration patch payload" };
        }
        const cfgObj = p.config && typeof p.config === "object" && !Array.isArray(p.config) ? p.config : null;
        const patchObj = p.patch && typeof p.patch === "object" && !Array.isArray(p.patch) ? p.patch : null;
        const seenScopes = [];
        for (const obj of [p, cfgObj, patchObj]) {
          if (!obj || !Object.prototype.hasOwnProperty.call(obj, "scope") || obj.scope === undefined) continue;
          if (obj.scope !== "global" && obj.scope !== "project") {
            return { ok: false, error: "invalid orchestration scope" };
          }
          seenScopes.push(obj.scope);
        }
        if (new Set(seenScopes).size > 1) {
          return { ok: false, error: "conflicting orchestration scope" };
        }
        for (const key of ["swarmMode", "orchestratorMode", "expectedRevision", "projectRoot"]) {
          const seenVals = [];
          for (const obj of [p, cfgObj, patchObj]) {
            if (!obj || !Object.prototype.hasOwnProperty.call(obj, key) || obj[key] === undefined) continue;
            seenVals.push(obj[key]);
          }
          if (new Set(seenVals).size > 1) {
            return { ok: false, error: `conflicting orchestration ${key}` };
          }
        }
        const hasNestedPatch = Boolean(cfgObj || patchObj);
        const patch = hasNestedPatch ? { ...(cfgObj || {}), ...(patchObj || {}) } : p;
        const explicitScope = seenScopes.length ? seenScopes[0] : undefined;
        const isProject = explicitScope === "project";
        // Extract host hints for sync
        const hostHints = p.hostRulePaths || p.hosts || p.host || p.extraSyncPaths;
        let res;
        // Prefer updateOrchestrationConfig which already syncs, passing host hints via opts
        try {
          if (typeof hubSubagents.updateOrchestrationConfig === "function") {
            if (isProject) {
              res = hubSubagents.updateOrchestrationConfig(patch, {
                scope: "project",
                projectRoot: p.projectRoot ?? patch?.projectRoot,
                expectedRevision: p.expectedRevision ?? patch?.expectedRevision,
              });
            } else {
              const discoveredAgyRules = discoverAntigravityRulesPaths(p.additionalHosts);
              const { projectRoot: _ambientProjectRoot, scope: _ambientScope, ...globalPatch } = (patch && typeof patch === "object") ? patch : {};
              res = hubSubagents.updateOrchestrationConfig(globalPatch, {
                scope: "global",
                ...(hostHints ? { hostRulePaths: hostHints, hosts: hostHints } : { additionalHosts: discoveredAgyRules }),
                ...(Array.isArray(p.extraSkillPaths || patch?.extraSkillPaths) ? { extraSkillPaths: p.extraSkillPaths || patch?.extraSkillPaths } : {}),
                ...((p.adoptUnmanagedSkillHashes || patch?.adoptUnmanagedSkillHashes) ? { adoptUnmanagedSkillHashes: p.adoptUnmanagedSkillHashes || patch?.adoptUnmanagedSkillHashes } : {}),
                ...(p.expectedRevision !== undefined ? { expectedRevision: p.expectedRevision } : {}),
              });
            }
          } else {
            throw new Error("updateOrchestrationConfig unavailable");
          }
        } catch (e) {
          return {
            ok: false,
            error: e?.message || String(e),
            ...(typeof e?.rolledBack === "boolean" ? { rolledBack: e.rolledBack } : {}),
            ...(Array.isArray(e?.rollbackFailures) ? { rollbackFailures: e.rollbackFailures } : {}),
            ...(typeof e?.preservedPath === "string" && e.preservedPath ? { preservedPath: e.preservedPath } : {}),
          };
        }
        // Return latest config per spec (prefer res.config)
        const latest = res?.config || hubSubagents.getOrchestrationConfig();
        return { ok: res?.ok !== false, config: latest, ...(res || {}) };
      }
      case "subagents:slashPrompt": return { prompt: hubSubagents.buildSlashCommandPrompt(payload?.mode) };
      case "board:get": return getTaskBoard().getBoardSnapshot(payload || {});
      case "board:update": return getTaskBoard().updatePlan(payload || {});
      case "board:clear": return getTaskBoard().clearPlan(payload || {});
      case "board:openArtifact": return await createArtifactAccess({ board: getTaskBoard(), homeDir: process.env.HOME || os.homedir() })(payload || {});
      case "board:readArtifact": {
        const rawPath = payload?.path || payload?.file || payload?.artifactPath || payload?.filePath || "";
        return await createArtifactAccess({ board: getTaskBoard(), homeDir: process.env.HOME || os.homedir() })({ ...payload, path: rawPath, operation: "preview" });
      }
      case "artifact:listApps":
        return await createArtifactAccess({ board: getTaskBoard(), homeDir: process.env.HOME || os.homedir() })({ ...(payload || {}), operation: "list-apps" });
      case "artifact:openDefault":
        return await createArtifactAccess({ board: getTaskBoard(), homeDir: process.env.HOME || os.homedir() })({ ...(payload || {}), operation: "open-default" });
      case "artifact:openWith":
        return await createArtifactAccess({ board: getTaskBoard(), homeDir: process.env.HOME || os.homedir() })({ ...(payload || {}), operation: "open-with" });
      case "providerResources:list":
        return createProviderResourcesManager({ homeDir: process.env.HOME || os.homedir() }).listProviderResources();
      case "providerResources:toggle":
        return createProviderResourcesManager({ homeDir: process.env.HOME || os.homedir() }).toggleProviderResource(payload || {});
      case "guardian:status": {
        const homeDir = process.env.HOME || os.homedir();
        const pluginDir = process.env.T3_HUD_DIR || path.join(homeDir, ".t3", "hud-plugin");
        return createGuardianManager({ homeDir, pluginDir }).getStatus();
      }
      case "guardian:set": {
        const homeDir = process.env.HOME || os.homedir();
        const pluginDir = process.env.T3_HUD_DIR || path.join(homeDir, ".t3", "hud-plugin");
        const mgr = createGuardianManager({ homeDir, pluginDir });
        return payload?.enabled === true ? mgr.enable() : mgr.disable();
      }
      case "quota:external": {
        const force = payload?.force === true;
        const localEnvId = readHudLocalEnvironmentId();
        const observed = payload?.observedEnvId ?? payload?.environmentId;
        const skipAgyForNative =
          payload?.hasNativeAgyQuota === true &&
          Boolean(localEnvId) &&
          typeof observed === "string" &&
          observed.trim() === localEnvId;
        const skipAgy = skipAgyForNative || isTestEnv();
        const agyReader = skipAgy ? null : getAgyQuotaReader();
        const [devinRes, agyRes] = await Promise.allSettled([
          getDevinQuotaReader().readDevinQuota({ force }),
          agyReader ? agyReader.readAgyQuotas({ force }) : Promise.resolve(null),
        ]);
        const devin = devinRes.status === "fulfilled" ? devinRes.value : null;
        const agy = agyRes.status === "fulfilled" ? agyRes.value : null;
        const providers = [];
        if (devin?.available && devin.provider) providers.push(devin.provider);
        if (agy?.available && Array.isArray(agy.providers)) {
          for (const p of agy.providers) {
            if (p) providers.push(p);
          }
        }
        return {
          ok: true,
          providers,
          t3EnvironmentId: localEnvId,
          ...(skipAgyForNative ? { agySkippedNative: true } : {}),
          ...(agy?.pending === true ? { pending: true } : {}),
        };
      }
      case "settings:get": return { ...getHostSettingsManager().getSettingsSnapshot(), t3EnvironmentId: readHudLocalEnvironmentId() };
      case "settings:update": return getHostSettingsManager().updateHostSetting(payload);
      case "settings:officialTelemetry:get":
      case "settings:officialTelemetry:update": {
        if (!fs.existsSync(telemetryGuardModule)) throw new Error("A full HUD install is needed for official telemetry settings");
        const { createTelemetryGuard } = require(telemetryGuardModule);
        const pid = process.type === "browser" ? process.pid : Number(process.env.T3_WATCH_PID) || null;
        const guard = createTelemetryGuard({ pid });
        return action.endsWith(":get") ? guard.status() : guard.update(payload);
      }
      case "settings:getRule": return getHostSettingsManager().getRuleContent(payload?.host);
      case "settings:saveRule": return getHostSettingsManager().saveRuleContent(payload?.host, payload?.content, payload?.expectedContent, payload?.expectedTarget);
      default: return { ok: false, error: "unknown action: " + action };
    }
  } catch (err) {
    return {
      ok: false,
      error: err?.message || String(err),
      ...(typeof err?.rolledBack === "boolean" ? { rolledBack: err.rolledBack } : {}),
      ...(Array.isArray(err?.rollbackFailures) ? { rollbackFailures: err.rollbackFailures } : {}),
      ...(typeof err?.preservedPath === "string" && err.preservedPath ? { preservedPath: err.preservedPath } : {}),
    };
  }
}

async function getGitGraph(threadHint, maxCommits = 90, fallbackCwd = null) {
  if (threadHint === "__HUB_RPC__") {
    return hubCall(maxCommits, fallbackCwd || {});
  }
  const selectedEnvironment = typeof fallbackCwd === "object" && typeof fallbackCwd?.environmentId === "string" ? fallbackCwd.environmentId.trim() : "";
  if (selectedEnvironment) {
    let localEnvironment = "";
    try { localEnvironment = fs.readFileSync(path.join(T3_USERDATA, "environment-id"), "utf8").trim(); } catch {}
    if (selectedEnvironment !== localEnvironment) return { ok: false, remoteOnly: true, remoteCwd: fallbackCwd.cwd || "(remote)", error: "Remote workspace" };
  }
  const stats = getThreadStats(threadHint);
  let repoPath = stats?.repoPath || null;

  if (!repoPath && fallbackCwd) {
    const fbCwd = typeof fallbackCwd === "string" ? fallbackCwd : typeof fallbackCwd?.cwd === "string" ? fallbackCwd.cwd : null;
    const fbEnvId = typeof fallbackCwd === "object" && typeof fallbackCwd?.environmentId === "string" ? fallbackCwd.environmentId.trim() : "";
    let localEnvId = "";
    try { localEnvId = fs.readFileSync(path.join(T3_USERDATA, "environment-id"), "utf8").trim(); } catch {}
    if (fbEnvId && (!localEnvId || fbEnvId !== localEnvId)) {
      return { ok: false, remoteOnly: true, remoteCwd: fbCwd || "(remote)", error: "Remote workspace" };
    }
    if (fbCwd) {
      if (fs.existsSync(fbCwd)) {
        repoPath = fbCwd;
      } else {
        return { ok: false, remoteOnly: true, remoteCwd: fbCwd, error: "Remote workspace" };
      }
    }
  }

  if (!repoPath) {
    try {
      const db = new DatabaseSync(DB_PATH, { open: true, readOnly: true });
      const row = db
        .prepare("SELECT workspace_root FROM projection_projects ORDER BY updated_at DESC LIMIT 1")
        .get();
      db.close();
      if (row?.workspace_root && fs.existsSync(row.workspace_root)) {
        repoPath = row.workspace_root;
      }
    } catch {}
  }

  if (!repoPath || !fs.existsSync(repoPath)) {
    return { ok: false, error: "当前会话未关联本地 Git 仓库目录" };
  }

  try {
    await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: repoPath,
      timeout: 3000,
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch {
    return { ok: false, repoPath, error: "当前项目目录尚未初始化 Git 仓库" };
  }

  try {
    const limit = Math.min(Math.max(Number(maxCommits) || 100, 20), 250);
    const sep = "\x1f";
    const recSep = "\x1e";
    const format = `%H${sep}%h${sep}%P${sep}%D${sep}%an${sep}%ar${sep}%ct${sep}%s${recSep}`;

    const [logRes, statusRes, branchRes] = await Promise.all([
      execFileAsync(
        "git",
        [
          "log",
          "--branches",
          "--remotes",
          "--tags",
          "HEAD",
          "--topo-order",
          `-n`,
          String(limit),
          `--pretty=format:${format}`,
        ],
        { cwd: repoPath, timeout: 6000, maxBuffer: 6 * 1024 * 1024 }
      ),
      execFileAsync("git", ["status", "--porcelain"], {
        cwd: repoPath,
        timeout: 4000,
        maxBuffer: 2 * 1024 * 1024,
      }),
      execFileAsync("git", ["branch", "--show-current"], {
        cwd: repoPath,
        timeout: 3000,
        maxBuffer: 2 * 1024 * 1024,
      }).catch(() => ({ stdout: "" })),
    ]);

    const statusLines = (statusRes.stdout || "").split("\n").filter(Boolean);
    let staged = 0;
    let modified = 0;
    let untracked = 0;
    for (const line of statusLines) {
      const xy = line.slice(0, 2);
      if (xy === "??") untracked++;
      else {
        if (xy[0] !== " " && xy[0] !== "?") staged++;
        if (xy[1] !== " " && xy[1] !== "?") modified++;
      }
    }

    const rawRecords = (logRes.stdout || "")
      .split(recSep)
      .map((s) => s.trim())
      .filter(Boolean);

    const parsedCommits = rawRecords.map((rec) => {
      const [hash, shortHash, parentsRaw, decorateRaw, author, relTime, unixTs, subject] =
        rec.split(sep);
      return {
        hash,
        shortHash,
        parents: (parentsRaw || "").split(" ").filter(Boolean),
        refs: parseRefs(decorateRaw),
        author: author || "",
        relTime: relTime || "",
        timestamp: Number(unixTs) || 0,
        subject: subject || "(no message)",
      };
    });

    const { commits, maxLanes } = buildSwimlanes(parsedCommits);
    const currentBranch = (branchRes.stdout || "").trim() || stats?.branch || "HEAD";

    return {
      ok: true,
      threadId: stats?.threadId || null,
      projectTitle: stats?.projectTitle || path.basename(repoPath),
      repoPath,
      currentBranch,
      workingTree: {
        clean: statusLines.length === 0,
        total: statusLines.length,
        staged,
        modified,
        untracked,
      },
      maxLanes,
      commits,
    };
  } catch (err) {
    return {
      ok: false,
      repoPath,
      error: err?.message || "读取 Git 历史失败",
    };
  }
}

async function getCommitDetail(threadHint, commitHash, fallbackCwd = null) {
  if (!commitHash || !/^[0-9a-f]{6,40}$/i.test(commitHash)) {
    return { ok: false, error: "非法 Commit SHA" };
  }
  const graphInfo = await getGitGraph(threadHint, 20, fallbackCwd);
  if (!graphInfo.ok || !graphInfo.repoPath) {
    return {
      ok: false,
      remoteOnly: Boolean(graphInfo.remoteOnly),
      remoteCwd: graphInfo.remoteCwd || (typeof fallbackCwd === "string" ? fallbackCwd : fallbackCwd?.cwd) || null,
      error: graphInfo.error || "找不到仓库路径",
    };
  }

  try {
    const [metaRes, statRes, diffRes] = await Promise.all([
      execFileAsync(
        "git",
        ["show", "-s", "--format=%H%x1f%an%x1f%ae%x1f%ai%x1f%B", commitHash],
        { cwd: graphInfo.repoPath, timeout: 4000, maxBuffer: 2 * 1024 * 1024 }
      ),
      execFileAsync("git", ["show", "--numstat", "--format=", commitHash], {
        cwd: graphInfo.repoPath,
        timeout: 4000,
        maxBuffer: 2 * 1024 * 1024,
      }),
      execFileAsync("git", ["show", "--unified=2", "--format=", commitHash], {
        cwd: graphInfo.repoPath,
        timeout: 5000,
        maxBuffer: 4 * 1024 * 1024,
      }).catch(() => ({ stdout: "" })),
    ]);

    const [fullHash, authorName, authorEmail, authorDate, fullMsg] = (metaRes.stdout || "").split(
      "\x1f"
    );

    const files = (statRes.stdout || "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 80)
      .map((line) => {
        const [add, del, ...rest] = line.split("\t");
        return {
          added: add === "-" ? null : Number(add) || 0,
          deleted: del === "-" ? null : Number(del) || 0,
          path: rest.join("\t"),
        };
      });

    const rawDiff = diffRes.stdout || "";
    const truncatedDiff =
      rawDiff.length > 36000 ? rawDiff.slice(0, 36000) + "\n\n... (Diff 已截断)" : rawDiff;

    return {
      ok: true,
      hash: (fullHash || commitHash).trim(),
      authorName: (authorName || "").trim(),
      authorEmail: (authorEmail || "").trim(),
      authorDate: (authorDate || "").trim(),
      message: (fullMsg || "").trim(),
      files,
      patch: truncatedDiff,
    };
  } catch (err) {
    return { ok: false, error: err?.message || "读取提交详情失败" };
  }
}

// ============================================================================
// 4.5 Remote Git Bundle (T3 Connect WebSocket + GitHub API fallback)
// ============================================================================
const ZERO_SHA = "0".repeat(40);

function formatRelTime(tsSec) {
  const ts = Number(tsSec);
  if (!Number.isFinite(ts) || ts <= 0) return "";
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (diff < 60) return "just now";
  if (diff < 3600) {
    const m = Math.floor(diff / 60);
    return `${m} minute${m === 1 ? "" : "s"} ago`;
  }
  if (diff < 86400) {
    const h = Math.floor(diff / 3600);
    return `${h} hour${h === 1 ? "" : "s"} ago`;
  }
  if (diff < 30 * 86400) {
    const d = Math.floor(diff / 86400);
    return `${d} day${d === 1 ? "" : "s"} ago`;
  }
  try {
    return new Date(ts * 1000).toISOString().slice(0, 10);
  } catch {
    return "";
  }
}

function parseRemoteGitConfig(configText) {
  const text = typeof configText === "string" ? configText : "";
  if (!text) return { githubRepo: null, remoteUrl: null };
  // Note: JS has no \Z anchor (it matches a literal Z/z), so stop at the next
  // section header or end of string instead.
  const originMatch = text.match(/\[remote\s+"origin"\]\s*\n([\s\S]*?)(?:\n\s*\[[^\]\n]+\]\s*\n|$)/i);
  let remoteUrl = null;
  if (originMatch) {
    const urlMatch = originMatch[1].match(/^\s*url\s*=\s*(.+?)\s*$/im);
    if (urlMatch) remoteUrl = urlMatch[1].trim();
  }
  if (!remoteUrl) return { githubRepo: null, remoteUrl: null };
  const m = remoteUrl.match(/github\.com[:/]([^/\s]+?)\/([^/\s]+?)(?:\.git)?$/);
  return { githubRepo: m ? `${m[1]}/${m[2]}` : null, remoteUrl };
}

function parseGitHead(headText) {
  const text = typeof headText === "string" ? headText.trim() : "";
  if (!text) return { branch: null, headSha: null };
  const refMatch = text.match(/^ref:\s*refs\/heads\/(.+)$/);
  if (refMatch) return { branch: refMatch[1].trim() || null, headSha: null };
  if (/^[0-9a-f]{40}$/i.test(text)) return { branch: null, headSha: text.toLowerCase() };
  return { branch: null, headSha: null };
}

function parsePackedRefs(packedRefsText) {
  const refs = [];
  if (typeof packedRefsText !== "string") return refs;
  for (const line of packedRefsText.split("\n")) {
    const m = line.trim().match(/^([0-9a-f]{40})\s+(\S+)$/i);
    if (m) refs.push({ sha: m[1].toLowerCase(), ref: m[2] });
  }
  return refs;
}

function resolveRemoteHeadSha(bundle, parsedHead) {
  // A detached HEAD is its own full SHA and remains authoritative. A symbolic
  // HEAD must be resolved by the Connect caller, which can check the loose ref
  // before packed-refs. A packed ref alone is not enough: a loose ref may
  // override it, and an unreadable loose ref must not make us display an older
  // packed commit as the current HEAD.
  if (parsedHead?.headSha) return parsedHead.headSha;
  if (!bundle || !Object.prototype.hasOwnProperty.call(bundle, "resolvedHeadSha")) return null;
  const explicit = typeof bundle.resolvedHeadSha === "string" ? bundle.resolvedHeadSha.trim().toLowerCase() : "";
  return /^[0-9a-f]{40}$/.test(explicit) ? explicit : null;
}

function refsWithoutUnverifiedCurrentBranch(refs, branch, headSha) {
  if (!branch) return refs;
  const currentRef = `refs/heads/${branch}`;
  // A stale packed copy can coexist with a newer loose current branch ref.
  // Drop it unless it agrees with the SHA verified by the Connect caller.
  return refs.filter((ref) => ref?.ref !== currentRef || (!!headSha && String(ref.sha || "").toLowerCase() === headSha));
}

function parseHeadLog(headLogText) {
  const entries = [];
  if (typeof headLogText !== "string") return entries;
  const seen = new Set();
  const re = /^([0-9a-f]{40})\s+([0-9a-f]{40})\s+(.+?)\s+<([^>]*)>\s+(\d+)\s+[+-]\d{4}\t(.*)$/i;
  for (const line of headLogText.split("\n")) {
    if (!line.trim()) continue;
    const m = line.match(re);
    if (!m) continue;
    const oldSha = m[1].toLowerCase();
    const newSha = m[2].toLowerCase();
    const author = (m[3] || "").trim();
    const email = (m[4] || "").trim();
    const ts = Number(m[5]) || 0;
    let subject = (m[6] || "").trim();
    const actionMatch = subject.match(/^commit(?:\s*\([^)]+\))?:\s*(.*)$/);
    const isCommit = /^commit/.test(subject) || /^merge\b/.test(subject);
    if (!isCommit) continue;
    if (actionMatch) subject = actionMatch[1].trim();
    if (!subject) continue;
    if (seen.has(newSha)) continue;
    seen.add(newSha);
    entries.push({
      oldSha,
      newSha,
      author,
      email,
      timestamp: ts,
      relTime: formatRelTime(ts),
      subject,
    });
  }
  // Reflog is chronological; newest first for display.
  return entries.reverse();
}

function normalizeBranchCommits(branchCommits) {
  if (!Array.isArray(branchCommits)) branchCommits = branchCommits?.commits;
  if (!Array.isArray(branchCommits)) return [];
  const out = [];
  for (const c of branchCommits) {
    if (!c || typeof c !== "object") continue;
    const hash = String(c.hash || c.sha || c.id || "").toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(hash)) continue;
    const ts = c.timestamp || c.time || ((c.date || c.committedAt) ? Math.floor(Date.parse(c.date || c.committedAt) / 1000) : 0) || 0;
    const parents = Array.isArray(c.parents)
      ? c.parents.map((p) => String(p?.sha || p?.hash || p || "").toLowerCase()).filter((p) => /^[0-9a-f]{40}$/.test(p))
      : [];
    out.push({
      hash,
      shortHash: hash.slice(0, 7),
      parents,
      author: String(c.author || c.authorName || c.committer || ""),
      relTime: String(c.relTime || (ts ? formatRelTime(ts) : "")),
      timestamp: Number(ts) || 0,
      subject: String(c.subject || c.message || c.title || "(no message)"),
    });
  }
  return out;
}

function normalizeVcsRefs(vcsRefs) {
  if (!Array.isArray(vcsRefs)) vcsRefs = vcsRefs?.refs;
  if (!Array.isArray(vcsRefs)) return [];
  const out = [];
  for (const r of vcsRefs) {
    if (!r) continue;
    if (typeof r === "string") {
      const m = r.trim().match(/^([0-9a-f]{40})\s+(\S+)$/i);
      if (m) out.push({ sha: m[1].toLowerCase(), ref: m[2] });
      continue;
    }
    if (typeof r === "object") {
      const sha = String(r.sha || r.hash || r.commit || r.target || "").toLowerCase();
      const ref = String(r.ref || r.name || r.label || r.branch || "");
      if (/^[0-9a-f]{40}$/.test(sha) || ref) {
        out.push({ sha: /^[0-9a-f]{40}$/.test(sha) ? sha : null, ref });
      }
    }
  }
  return out;
}

function buildBadgeMapFromRefs(refsList, headSha, headBranch) {
  const bySha = new Map();
  const push = (sha, badge) => {
    if (!sha || !/^[0-9a-f]{40}$/.test(sha)) return;
    const cur = bySha.get(sha) || [];
    if (!cur.some((b) => b.label === badge.label && b.kind === badge.kind)) cur.push(badge);
    bySha.set(sha, cur);
  };
  for (const { sha, ref } of refsList) {
    if (!sha || !ref) continue;
    if (ref.startsWith("refs/heads/")) push(sha, { kind: "branch", label: ref.slice(11), isHead: false });
    else if (ref.startsWith("refs/remotes/")) push(sha, { kind: "remote", label: ref.slice(13), isHead: false });
    else if (ref.startsWith("refs/tags/")) push(sha, { kind: "tag", label: ref.slice(10), isHead: false });
    else push(sha, { kind: "branch", label: ref, isHead: false });
  }
  if (headSha && /^[0-9a-f]{40}$/.test(headSha)) {
    const cur = bySha.get(headSha) || [];
    if (!cur.some((b) => b.isHead)) {
      cur.unshift({ kind: "head", label: "HEAD", isHead: true });
      if (headBranch && !cur.some((b) => b.label === headBranch)) {
        cur.splice(1, 0, { kind: "branch", label: headBranch, isHead: false });
      }
    }
    bySha.set(headSha, cur);
  }
  return bySha;
}

function parseDirtyCount(vcsStatus) {
  if (vcsStatus == null) return null;
  if (typeof vcsStatus === "number" && Number.isFinite(vcsStatus)) return Math.max(0, Math.floor(vcsStatus));
  if (typeof vcsStatus === "string") {
    return vcsStatus.split("\n").filter((l) => l.trim()).length;
  }
  if (typeof vcsStatus === "object") {
    if (typeof vcsStatus.total === "number") return Math.max(0, Math.floor(vcsStatus.total));
    if (typeof vcsStatus.count === "number") return Math.max(0, Math.floor(vcsStatus.count));
    if (typeof vcsStatus.changed === "number") return Math.max(0, Math.floor(vcsStatus.changed));
    if (Array.isArray(vcsStatus.files)) return vcsStatus.files.length;
    if (Array.isArray(vcsStatus.entries)) return vcsStatus.entries.length;
    if (Array.isArray(vcsStatus.workingTree?.files)) return vcsStatus.workingTree.files.length;
  }
  return 0;
}

async function fetchGitHubJson(endpoint) {
  try {
    const res = await execFileAsync("gh", ["api", endpoint], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
    const text = (res.stdout || "").trim();
    if (text) return JSON.parse(text);
  } catch {}
  const ctrl = new AbortController();
  const timer = setTimeout(() => {
    try {
      ctrl.abort();
    } catch {}
  }, 5000);
  try {
    const resp = await fetch(`https://api.github.com/${endpoint}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "t3-hud" },
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`GitHub API ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

function buildRemoteGraphResult({ cwd, branch, headSha, dirtyCount, commits, remoteSource, githubRepo }) {
  const { commits: fitted, maxLanes } = buildSwimlanes(commits);
  const repoName = path.basename(cwd || ".") || cwd || "repo";
  return {
    ok: true,
    isRemoteGit: true,
    remoteSource,
    githubRepo,
    repoPath: cwd || null,
    repoName,
    branch,
    currentBranch: branch || "HEAD",
    projectTitle: repoName,
    dirtyCount,
    workingTree: dirtyCount == null ? null : {
      clean: dirtyCount === 0,
      total: dirtyCount,
      staged: 0,
      modified: dirtyCount,
      untracked: 0,
    },
    maxLanes,
    commits: fitted,
  };
}

async function getRemoteGitGraph(bundle) {
  const b = bundle && typeof bundle === "object" ? bundle : null;
  const cwd = b && typeof b.cwd === "string" ? b.cwd.trim() : "";
  if (!cwd) return { ok: false, error: "Remote repo path missing" };
  const environmentId = b && typeof b.environmentId === "string" ? b.environmentId : "";
  void environmentId;

  const { githubRepo } = parseRemoteGitConfig(b.gitConfig);
  const head = parseGitHead(b.gitHead);
  // A detached HEAD is authoritative; stale UI/status branch hints must not
  // move a real branch badge onto it or remove that branch's actual ref.
  const branch = head.headSha ? null : head.branch || b.vcsStatus?.refName || b.vcsRefs?.refs?.find(ref => ref.current)?.name || (typeof b.branch === "string" && b.branch.trim()) || null;
  const headLogEntries = parseHeadLog(b.headLog);
  const packedRefs = parsePackedRefs(b.packedRefs);
  const headSha = resolveRemoteHeadSha(b, head);
  const vcsRefsList = normalizeVcsRefs(b.vcsRefs);
  const branchSafeRefs = refsWithoutUnverifiedCurrentBranch([...packedRefs, ...vcsRefsList], branch, headSha);
  const branchCommits = normalizeBranchCommits(b.branchCommits);
  const dirtyCount = parseDirtyCount(b.vcsStatus);

  const nativeCommits = normalizeBranchCommits(b.nativeCommits);
  if (nativeCommits.length) {
    const known = new Map([...branchCommits, ...headLogEntries.map(entry => ({ hash: entry.newSha, ...entry }))].map(commit => [commit.hash, commit]));
    const badges = buildBadgeMapFromRefs(branchSafeRefs, headSha, branch);
    for (const commit of nativeCommits) {
      const meta = known.get(commit.hash);
      if (meta) { commit.author = meta.author || commit.author; commit.timestamp = meta.timestamp || commit.timestamp; commit.relTime = meta.relTime || commit.relTime; }
      commit.refs = badges.get(commit.hash) || [];
    }
    return { ...buildRemoteGraphResult({ cwd, branch, headSha, dirtyCount, commits: nativeCommits, remoteSource: "t3-connect", githubRepo }), partialHistory: !!b.nativeHistoryTruncated, firstParentOnly: true, parentsUnavailable: false };
  }

  // Local tip commits from the remote reflog (never in GitHub's set while unpushed).
  const localCommits = headLogEntries.map((e) => ({
    hash: e.newSha,
    shortHash: e.newSha.slice(0, 7),
    parents: [], // Reflog records the previous HEAD, not necessarily a parent.
    author: e.author,
    relTime: e.relTime,
    timestamp: e.timestamp,
    subject: e.subject,
  }));

  if (githubRepo) {
    try {
      const [ghCommits, ghBranches] = await Promise.all([
        fetchGitHubJson(`repos/${githubRepo}/commits?sha=${encodeURIComponent(branch || "HEAD")}&per_page=80`),
        fetchGitHubJson(`repos/${githubRepo}/branches?per_page=30`).catch(() => []),
      ]);
      const ghList = Array.isArray(ghCommits) ? ghCommits : Array.isArray(ghCommits?.commits) ? ghCommits.commits : [];
      if (ghList.length) {
        const ghShaSet = new Set(ghList.map((c) => String(c.sha || c.hash || "").toLowerCase()).filter(Boolean));
        const badgeBySha = new Map();
        const pushBadge = (sha, badge) => {
          const k = String(sha || "").toLowerCase();
          if (!k) return;
          const cur = badgeBySha.get(k) || [];
          if (!cur.some((x) => x.label === badge.label)) cur.push(badge);
          badgeBySha.set(k, cur);
        };
        for (const br of Array.isArray(ghBranches) ? ghBranches : []) {
          const sha = br?.commit?.sha || br?.sha;
          if (br?.name && sha) pushBadge(sha, { kind: "branch", label: String(br.name), isHead: false });
        }
        const remoteCommits = ghList.map((c) => {
          const sha = String(c.sha || c.hash || "").toLowerCase();
          const msg = String(c.commit?.message || c.message || "(no message)");
          const ts = c.commit?.author?.date || c.commit?.committer?.date || c.date;
          const tsSec = ts ? Math.floor(Date.parse(ts) / 1000) : 0;
          return {
            hash: sha,
            shortHash: sha.slice(0, 7),
            parents: (Array.isArray(c.parents) ? c.parents : [])
              .map((p) => String(p.sha || p.hash || "").toLowerCase())
              .filter((p) => /^[0-9a-f]{40}$/.test(p)),
            author: String(c.commit?.author?.name || c.author?.login || c.author || ""),
            relTime: tsSec ? formatRelTime(tsSec) : String(c.relTime || ""),
            timestamp: Number.isFinite(tsSec) ? tsSec : 0,
            subject: msg.split("\n")[0] || "(no message)",
            refs: badgeBySha.get(sha) || [],
          };
        });
        // Merge unpushed local commits on top of the GitHub history.
        const unpushed = localCommits
          .filter((c) => !ghShaSet.has(c.hash))
          .map((c) => ({ ...c, refs: Array.isArray(c.refs) ? c.refs : [] }));
        const merged = [...unpushed, ...remoteCommits];
        // Mark only the verified current HEAD. The GitHub branch tip and the
        // newest reflog commit may both belong to a different checkout.
        if (headSha) {
          const tip = merged.find((commit) => commit.hash === headSha);
          if (tip) {
            const badges = buildBadgeMapFromRefs(branchSafeRefs, headSha, branch).get(headSha) || [];
            tip.refs = [...badges, ...(Array.isArray(tip.refs) ? tip.refs : []).filter((ref) => !badges.some((badge) => badge.kind === ref.kind && badge.label === ref.label))];
          }
        }
        return { ...buildRemoteGraphResult({
          cwd,
          branch,
          headSha,
          dirtyCount,
          commits: merged,
          remoteSource: "t3-connect+github",
          githubRepo,
        }), partialHistory: true, parentsUnavailable: unpushed.length > 0 };
      }
    } catch {}
  }

  // Pure local repo on the remote (no GitHub remote, or API unreachable): the
  // reflog + review range are complementary evidence. Reflog can contain a
  // recent local commit not present in the review range, while the range can
  // retain older commits that a short reflog does not include. Merge by SHA;
  // never infer parent edges from either source.
  const commitByHash = new Map();
  const commitOrder = [];
  for (const commit of [...localCommits, ...branchCommits]) {
    const prior = commitByHash.get(commit.hash);
    if (!prior) {
      commitByHash.set(commit.hash, { ...commit, parents: [...(commit.parents || [])] });
      commitOrder.push(commit.hash);
      continue;
    }
    const merged = {
      ...commit,
      ...prior,
      parents: prior.parents?.length ? [...prior.parents] : [...(commit.parents || [])],
      refs: [...(prior.refs || []), ...(commit.refs || []).filter((ref) => !(prior.refs || []).some((old) => old.kind === ref.kind && old.label === ref.label))],
    };
    commitByHash.set(commit.hash, merged);
  }
  const commits = commitOrder.map((hash) => commitByHash.get(hash));
  // When the exact HEAD is in the available partial set, keep it at the top
  // even if reflog ordering contains commits from a recently visited branch.
  if (headSha) {
    const headIndex = commits.findIndex((commit) => commit.hash === headSha);
    if (headIndex > 0) commits.unshift(commits.splice(headIndex, 1)[0]);
  }
  if (!commits.length) return { ok: false, error: "Remote Git history unavailable through the authorized connection" };
  const badgeBySha = buildBadgeMapFromRefs(branchSafeRefs, headSha, branch);
  for (const c of commits) {
    c.refs = badgeBySha.get(c.hash) || [];
  }
  return { ...buildRemoteGraphResult({
    cwd,
    branch,
    headSha,
    dirtyCount,
    commits,
    remoteSource: "t3-connect",
    githubRepo: githubRepo || null,
  }), partialHistory: true, parentsUnavailable: true };
}

async function getRemoteCommitDetail(req) {
  const r = req && typeof req === "object" ? req : {};
  const hash = typeof r.hash === "string" ? r.hash.trim() : "";
  if (!/^[0-9a-f]{6,40}$/i.test(hash)) {
    return { ok: false, error: "非法 Commit SHA" };
  }
  const meta = r.commitMeta && typeof r.commitMeta === "object" ? r.commitMeta : {};
  const githubRepo =
    typeof r.githubRepo === "string" && /^([^/\s]+)\/([^/\s]+)$/.test(r.githubRepo) ? r.githubRepo : null;
  if (githubRepo) {
    try {
      const data = await fetchGitHubJson(`repos/${githubRepo}/commits/${encodeURIComponent(hash)}`);
      if (data && data.sha) {
        const rawFiles = Array.isArray(data.files) ? data.files : [];
        const files = rawFiles.map((f) => ({ path: f.filename, added: f.additions, deleted: f.deletions }));
        const patch = rawFiles
          .map((f) => `--- a/${f.filename}\n+++ b/${f.filename}\n${f.patch || ""}`)
          .join("\n")
          .slice(0, 120000);
        return {
          ok: true,
          hash: data.sha,
          authorName: data.commit?.author?.name || data.author?.login || "",
          authorEmail: data.commit?.author?.email || "",
          date: data.commit?.author?.date || data.commit?.committer?.date || "",
          authorDate: data.commit?.author?.date || data.commit?.committer?.date || "",
          message: data.commit?.message || "",
          files,
          patch,
        };
      }
    } catch {}
  }
  // Pure unpushed local commit on the remote server: metadata-only summary.
  return {
    ok: true,
    diffUnavailable: true,
    hash,
    authorName: meta.author || "",
    authorEmail: "",
    date: meta.relTime || "",
    authorDate: meta.relTime || "",
    message: meta.subject || "",
    files: [],
    patch: "",
  };
}

// ============================================================================
// 5. Language Config Persistence (~/.t3/hud-plugin/config.json)
// ============================================================================
function getConfig() {
  try {
    const raw = fs.readFileSync(HUD_CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const defaultLang = parsed.defaultLang === "en" ? "en" : parsed.defaultLang === "zh" ? "zh" : "zh";
    const userLang =
      parsed.userLang === "en" || parsed.userLang === "zh" || parsed.userLang === "auto"
        ? parsed.userLang
        : undefined;
    const out = { defaultLang };
    if (userLang) out.userLang = userLang;
    else if (parsed && Object.prototype.hasOwnProperty.call(parsed, "userLang") && parsed.userLang === null) {
      out.userLang = null;
    }
    const langUpdatedAt = Number(parsed?.langUpdatedAt);
    if (Number.isFinite(langUpdatedAt) && langUpdatedAt > 0) out.langUpdatedAt = Math.round(langUpdatedAt);
    return { ok: true, ...out };
  } catch {
    return { ok: true, defaultLang: "zh" };
  }
}

function setConfig(patch) {
  const p = patch && typeof patch === "object" ? patch : {};
  try {
    if (fs.existsSync(hudConfigModule)) {
      require(hudConfigModule).updateHudLanguage(HUD_CONFIG_PATH, p);
    } else {
      let current = { defaultLang: "zh" };
      try { current = { ...current, ...JSON.parse(fs.readFileSync(HUD_CONFIG_PATH, "utf8")) }; } catch {}
      if (p.defaultLang === "zh" || p.defaultLang === "en") current.defaultLang = p.defaultLang;
      if (["zh", "en", "auto", null].includes(p.userLang)) current.userLang = p.userLang;
      const updatedAt = Number(p.langUpdatedAt);
      if (Number.isFinite(updatedAt) && updatedAt > 0) current.langUpdatedAt = Math.round(updatedAt);
      fs.mkdirSync(path.dirname(HUD_CONFIG_PATH), { recursive: true, mode: 0o700 });
      fs.writeFileSync(HUD_CONFIG_PATH, JSON.stringify(current, null, 2) + "\n", { mode: 0o600 });
    }
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
  return getConfig();
}

module.exports = {
  getThreadStats,
  priceRemoteProjection,
  mergeToolIntervals,
  subtractToolWait,
  getGitGraph,
  getCommitDetail,
  getRemoteGitGraph,
  getRemoteCommitDetail,
  getConfig,
  setConfig,
  lookupCatalogContextMax,
  resolveModelRate,
  resolveModelRateWithWonderFallback,
  getWonderFallbackRate,
  getMuseWonderRate,
  MUSE_WONDER_RATES: MUSE_WONDER_RATES_EXPORT,
  resolveHubContext,
  hubCall,
  ensureDreamScheduler,
  stopDreamScheduler,
  getDreamSchedulerStatus,
  getMemoryVault,
  // Test exposure for leak guards (TDD)
  _fileParseCache: fileParseCache,
  _childSubagentCache: childSubagentCache,
  _lruSet: lruSet,
  _lruGet: lruGet,
  lruSet,
  lruGet,
  readJsonlLines: readJsonlLinesSafe,
  readJsonlLinesSafe,
  forEachJsonlLineSync,
  readMuseSessionFile,
  readCodexSessionFile,
  readDevinSessionDb,
  normalizeEffectiveDriver,
  driversCompatible,
};
