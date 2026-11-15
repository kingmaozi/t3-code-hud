"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { DatabaseSync } = require("node:sqlite");
const hubSkills = require("./hub-skills.cjs");
const mcpRouter = require("./mcp-router.cjs");
const memoryVault = require("./memory-vault.cjs");
const embedManager = require("./embed-manager.cjs");
const hubSubagents = require("./hub-subagents.cjs");
const hubPlugins = require("./hub-plugins.cjs");
const hubHooks = require("./hub-hooks.cjs");

const execFileAsync = promisify(execFile);

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
const HUD_CONFIG_PATH = path.join(HOME_DIR, ".t3", "hud-plugin", "config.json");

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

  // Safe fallback rates (USD per token) if model is absent from catalog
  if (norm.includes("muse-ember")) {
    return { input: 0.1 / 1e6, output: 0.5 / 1e6, cacheRead: 0.004 / 1e6, cacheWrite: 0.1 / 1e6 };
  }
  if (norm.includes("muse-wonder")) {
    return { input: 4.0 / 1e6, output: 20.0 / 1e6, cacheRead: 0.2 / 1e6, cacheWrite: 4.0 / 1e6 };
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
  return { input: 2.0 / 1e6, output: 10.0 / 1e6, cacheRead: 0.2 / 1e6, cacheWrite: 2.0 / 1e6 };
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
const fileParseCache = new Map(); // key -> { sig, data }

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
  const cached = fileParseCache.get(jsonlPath);
  if (cached && cached.sig === sig) return cached.data;

  const content = fs.readFileSync(jsonlPath, "utf8");
  const lines = content.split("\n");

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
  let latestModel = fallbackModel || null;
  let stepCount = 0;

  let pendingResponseCreatedUs = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || (!line.includes("model_response_created") && !line.includes("model_completed"))) {
      continue;
    }
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const evt = rec?.payload?.event;
    if (!evt) continue;

    if (evt.kind === "model_response_created") {
      pendingResponseCreatedUs = typeof rec.recorded_at === "number" ? rec.recorded_at : null;
    } else if (evt.kind === "model_completed" && evt.usage) {
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

      if (inputTotal + output === 0) continue;
      stepCount++;

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
        }
      }
      if (evt.duration_ms > 50 && output > 0) {
        e2eTokensSum += output;
        e2eSecSum += evt.duration_ms / 1000;
      }
      pendingResponseCreatedUs = null;
    }
  }

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
    durationSec: lastDecodeSec ?? (decodeSecSum > 0 ? decodeSecSum : null),
  };

  fileParseCache.set(jsonlPath, { sig, data });
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
function findAntigravityConvDb(convId) {
  if (!convId || !fs.existsSync(AGY_PROVIDERS_ROOT)) return null;
  if (!cachedAgyConvDirs) {
    try {
      cachedAgyConvDirs = fs
        .readdirSync(AGY_PROVIDERS_ROOT)
        .map((d) => path.join(AGY_PROVIDERS_ROOT, d, "antigravity-acp", "conversations"))
        .filter((p) => fs.existsSync(p));
    } catch {
      cachedAgyConvDirs = [];
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
  const cached = fileParseCache.get(dbFile);
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
          .prepare("SELECT idx, step_type, metadata FROM steps WHERE metadata IS NOT NULL ORDER BY idx ASC")
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
    let latestModel = fallbackModel || null;
    let stepCount = 0;

    for (const r of rows) {
      if (!r.metadata) continue;
      // step_type === 15 marks inference/token-usage steps; when the column exists, prefer it.
      // We still accept any step with f[9] usage metadata for backward compatibility.
      if (r.step_type != null && Number(r.step_type) !== 15) {
        const probe = parseProtoSimple(Buffer.from(r.metadata));
        if (!probe[9]?.[0]) continue;
        const uProbe = parseProtoSimple(probe[9][0]);
        const probeTotal =
          (Number(uProbe[2]?.[0]) || 0) + (Number(uProbe[5]?.[0]) || 0) + (Number(uProbe[4]?.[0]) || 0) +
          Math.max(Number(uProbe[3]?.[0]) || 0, (Number(uProbe[9]?.[0]) || 0) + (Number(uProbe[10]?.[0]) || 0));
        if (probeTotal === 0) continue;
      }
      const f = parseProtoSimple(Buffer.from(r.metadata));
      if (!f[9]?.[0]) continue;

      const u = parseProtoSimple(f[9][0]);
      const uncached = Math.max(0, Number(u[2]?.[0]) || 0);
      const cacheRead = Math.max(0, Number(u[5]?.[0]) || 0);
      const cacheWrite = Math.max(0, Number(u[4]?.[0]) || 0);
      const reasoning = Math.max(0, Number(u[9]?.[0]) || 0);
      const visOut = Math.max(0, Number(u[10]?.[0]) || 0);
      const output = Math.max(Number(u[3]?.[0]) || 0, reasoning + visOut);

      const promptTotal = uncached + cacheRead + cacheWrite;
      if (promptTotal + output === 0) continue;
      stepCount++;

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
      }

      const t1 = f[1]?.[0] ? protoTimestampSec(f[1][0]) : null;
      const t6 = f[6]?.[0] ? protoTimestampSec(f[6][0]) : null;
      const t7 = f[7]?.[0] ? protoTimestampSec(f[7][0]) : f[8]?.[0] ? protoTimestampSec(f[8][0]) : null;

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
      durationSec: lastStreamSec ?? (e2eSecSum > 0 ? e2eSecSum : null),
    };

    fileParseCache.set(dbFile, { sig, data });
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
  for (const dayDir of dateDirsFromUuidV7(nativeId, CODEX_SESSIONS_ROOT)) {
    if (!fs.existsSync(dayDir)) continue;
    try {
      const hit = fs.readdirSync(dayDir).find((f) => f.includes(nativeId) && f.endsWith(".jsonl"));
      if (hit) return path.join(dayDir, hit);
    } catch {}
  }
  return getCodexSessionIndex().get(nativeId) || null;
}

function readCodexSessionFile(jsonlPath, fallbackModel) {
  const sig = getFileSig(jsonlPath);
  if (!sig) return null;
  const cached = fileParseCache.get(jsonlPath);
  if (cached && cached.sig === sig) return cached.data;

  const lines = fs.readFileSync(jsonlPath, "utf8").split("\n");
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
  let lastStepCacheRate = null;
  let lastContextPrompt = null;
  let codexContextMax = null;
  let latestModel = fallbackModel || null;
  let stepCount = 0;

  let stepInputReadyMs = null;
  let reasoningDoneMs = null;

  for (const line of lines) {
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const tsMs = rec.timestamp ? Date.parse(rec.timestamp) : null;
    const p = rec.payload;

    if (p?.thread_settings?.model) {
      latestModel = p.thread_settings.model;
    } else if (typeof p?.model === "string") {
      latestModel = p.model;
    }
    if (rec.type === "event_msg" && p?.type === "token_count" && Number(p?.info?.model_context_window) > 0) {
      codexContextMax = Number(p.info.model_context_window);
    }

    if (
      (rec.type === "event_msg" && p?.item?.type === "UserMessage") ||
      (rec.type === "response_item" && p?.type === "custom_tool_call_output") ||
      (rec.type === "response_item" && p?.type === "function_call_output")
    ) {
      stepInputReadyMs = tsMs;
      reasoningDoneMs = null;
    } else if (rec.type === "response_item" && p?.type === "reasoning") {
      reasoningDoneMs = tsMs;
    } else if (rec.type === "token_usage_record" && p?.usage) {
      const u = p.usage;
      const inp = Math.max(0, Number(u.input_tokens) || 0);
      const cr = Math.min(inp, Math.max(0, Number(u.cached_input_tokens) || 0));
      const cw = Math.min(inp - cr, Math.max(0, Number(u.cache_write_input_tokens) || 0));
      const uncached = Math.max(0, inp - cr - cw);
      const out = Math.max(0, Number(u.output_tokens) || 0);
      const reas = Math.min(out, Math.max(0, Number(u.reasoning_output_tokens) || 0));

      if (inp + out === 0) continue;
      stepCount++;

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
      }

      if (tsMs && stepInputReadyMs && tsMs > stepInputReadyMs + 50 && out > 0) {
        e2eTokensSum += out;
        e2eSecSum += (tsMs - stepInputReadyMs) / 1000;
      }
      const visOut = Math.max(0, out - reas);
      if (tsMs && reasoningDoneMs && tsMs > reasoningDoneMs + 80 && visOut >= 15) {
        const dSec = (tsMs - reasoningDoneMs) / 1000;
        if (visOut / dSec <= 1500) {
          decodeTokensSum += visOut;
          decodeSecSum += dSec;
          if (latestModel) { const bm = (byModelDecode[latestModel] ||= { tok: 0, sec: 0 }); bm.tok += visOut; bm.sec += dSec; }
          lastDecodeTps = visOut / dSec;
        }
      }
      stepInputReadyMs = tsMs;
      reasoningDoneMs = null;
    }
  }

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
    contextMax: codexContextMax,
    tokPerSec: avgDecodeTps ?? lastDecodeTps ?? avgE2eTps,
    lastDecodeTps,
    avgDecodeTps,
    decodeTokensSum,
    decodeSecSum,
    e2eTokPerSec: avgE2eTps,
    durationSec: decodeSecSum > 0 ? decodeSecSum : e2eSecSum > 0 ? e2eSecSum : null,
  };

  fileParseCache.set(jsonlPath, { sig, data });
  return data;
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

function extractThreadId(hint) {
  if (!hint || typeof hint !== "string") return null;
  const trimmed = hint.trim();
  if (trimmed === "/new" || trimmed.endsWith("/new")) return "__NEW__";
  if (trimmed.startsWith("thread:")) return trimmed;

  const segments = trimmed.split("/").filter(Boolean);
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

function aggregateSingleThreadTelemetry(db, threadId, fallbackModel, fallbackProvider) {
  const pThreadRows = db
    .prepare(
      "SELECT driver, updated_at, payload_json FROM orchestration_v2_projection_provider_threads WHERE thread_id = ? ORDER BY rowid ASC"
    )
    .all(threadId);

  const turnRows = db
    .prepare(
      "SELECT ordinal, status, started_at, completed_at, payload_json FROM orchestration_v2_projection_provider_turns WHERE thread_id = ? ORDER BY ordinal ASC"
    )
    .all(threadId);

  let isRunning = false;
  let contextUsed = null;
  let contextMax = null;
  let latestDriver = fallbackProvider || null;
  let latestModel = fallbackModel || null;

  for (const pt of pThreadRows) {
    const p = safeJsonParse(pt.payload_json);
    if (pt.driver) latestDriver = pt.driver;
    if (p?.contextUsage?.usedTokens != null) {
      contextUsed = p.contextUsage.usedTokens;
      contextMax = p.contextUsage.maxTokens || contextMax;
    }
  }

  const agyConvIds = new Set();
  const museNativeIds = new Set();
  const codexNativeIds = new Set();

  for (const pt of pThreadRows) {
    const p = safeJsonParse(pt.payload_json);
    const nid = p?.nativeThreadRef?.nativeId;
    if (!nid) continue;
    if (pt.driver === "muse") museNativeIds.add(nid);
    else if (pt.driver === "codex") codexNativeIds.add(nid);
    else if (pt.driver === "antigravity" && !nid.startsWith("pending:")) {
      agyConvIds.add(nid.split(":")[0]);
    }
  }

  for (const tr of turnRows) {
    if (tr.status === "running" || tr.status === "pending") isRunning = true;
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
  for (const mid of museNativeIds) {
    const fp = findMuseSessionJsonl(mid);
    if (fp) {
      const d = readMuseSessionFile(fp, latestModel);
      if (d && d.stepCount > 0) {
        nativeParts.push({ ...d, driver: "muse", mtimeMs: getLatestMtimeMs(fp) });
      }
    }
  }
  for (const cid of agyConvIds) {
    const fp = findAntigravityConvDb(cid);
    if (fp) {
      const d = readAntigravityConvDb(fp, latestModel);
      if (d && d.stepCount > 0) {
        nativeParts.push({ ...d, driver: "antigravity", mtimeMs: getLatestMtimeMs(fp) });
      }
    }
  }
  for (const xid of codexNativeIds) {
    const fp = findCodexSessionJsonl(xid);
    if (fp) {
      const d = readCodexSessionFile(fp, latestModel);
      if (d && d.stepCount > 0) {
        nativeParts.push({ ...d, driver: "codex", mtimeMs: getLatestMtimeMs(fp) });
      }
    }
  }

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
      const d = p?.nativeTurnRef?.driver;
      if (!d || coveredDrivers.has(d)) continue;
      const u = p?.turnTokenUsage;
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
      const uS = Date.parse(tr.started_at || p?.startedAt || "");
      const uE = Date.parse(tr.completed_at || p?.completedAt || "");
      if (Number.isFinite(uE) && Number.isFinite(uS) && uE > uS + 50 && out > 0) {
        uncoveredOut += out;
        uncoveredNetSec += (uE - uS) / 1000;
      }
      const turnMs = Number.isFinite(uE) ? uE : Number.isFinite(uS) ? uS : NaN;
      if (Number.isFinite(turnMs) && turnMs >= latestUncoveredTurnMs) {
        latestUncoveredTurnMs = turnMs;
        latestUncoveredDriver = d;
        latestUncoveredModel =
          Array.isArray(u.models) && typeof u.models[0] === "string" && u.models[0]
            ? u.models[0]
            : typeof p?.model === "string" && p.model
              ? p.model
              : null;
      }
    }

    // Pure decode speed from native logs when available; only fall back to timed turn rate when no native decode sample exists
    const sessionAvgTps =
      totalDecodeSec > 0.1
        ? totalDecodeTok / totalDecodeSec
        : uncoveredNetSec > 0.2
          ? uncoveredOut / uncoveredNetSec
          : null;

    const lastPart = nativeParts[nativeParts.length - 1];

    // Mixed-provider freshness: if an uncovered provider ran after the newest
    // native part, its statev2 metadata wins over stale native metadata.
    const lastPThread = pThreadRows[pThreadRows.length - 1];
    const lastPThreadDriver = lastPThread?.driver || null;
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
    const useOverride = Boolean(overrideDriver) && overrideMs > (lastPart.mtimeMs || 0);
    const effDriver = useOverride ? overrideDriver : lastPart.driver || latestDriver;
    const effModel = useOverride ? overrideModel || statev2Model : lastPart.model || latestModel;
    const promptTotal = uncached + cached + cacheWrite;
    const sessionCacheRate = promptTotal > 0 ? cached / promptTotal : null;

    // True contextMax: prefer native part max, then statev2 maxTokens,
    // then Antigravity fallback (Gemini 1048576 / Claude 1000000), then catalog, then null.
    let resolvedContextMax = useOverride ? contextMax ?? null : lastPart.contextMax ?? contextMax ?? null;
    if (resolvedContextMax == null) {
      const drv = effDriver || latestDriver;
      const mdl = effModel || latestModel;
      if (drv === "antigravity") {
        const model = (mdl || "").toLowerCase();
        const isClaude = /opus|sonnet|haiku|claude/.test(model);
        const catalog = lookupCatalogContextMax(mdl, drv);
        resolvedContextMax = catalog ?? (isClaude ? 1000000 : 1048576);
      } else if (drv === "muse") {
        resolvedContextMax = lookupCatalogContextMax(mdl, drv) ?? 1007997;
      } else if (drv === "codex") {
        resolvedContextMax = lookupCatalogContextMax(mdl, drv) ?? contextMax ?? null;
      }
    }

    return {
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
      lastTurnCacheRate: lastPart.lastStepCacheRate ?? sessionCacheRate,
      tokPerSec: sessionAvgTps ?? lastPart.tokPerSec,
      byModelSpeed: Object.fromEntries(Object.entries(mergedByModel).filter(([, v]) => v.sec > 0.1).map(([k, v]) => [k, Math.round((v.tok / v.sec) * 10) / 10])),
      lastDecodeTps: lastPart.lastDecodeTps,
      e2eTokPerSec: lastPart.e2eTokPerSec,
      durationSec: lastPart.durationSec,
      contextUsed: useOverride ? contextUsed : lastPart.lastContextPrompt ?? contextUsed,
      contextMax: resolvedContextMax,
    };
  }

  // Fallback for other providers (e.g., Claude Code ACP) via statev2.sqlite turns - tool durations
  const toolRows = db
    .prepare(
      "SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE thread_id = ?"
    )
    .all(threadId);
  let totalToolWaitSec = 0;
  for (const it of toolRows) {
    const p = safeJsonParse(it.payload_json);
    if (p && p.startedAt && p.completedAt && p.type !== "assistant_message" && p.type !== "reasoning") {
      const dt = (Date.parse(p.completedAt) - Date.parse(p.startedAt)) / 1000;
      if (dt > 0 && dt < 600) totalToolWaitSec += dt;
    }
  }

  let uncached = 0;
  let cached = 0;
  let cacheWrite = 0;
  let output = 0;
  let reasoning = 0;
  let usd = 0;
  let savedUsd = 0;
  let turnDurSum = 0;
  let lastTurnCacheRate = null;

  for (const tr of turnRows) {
    const p = safeJsonParse(tr.payload_json);
    const u = p?.turnTokenUsage;
    if (!u || typeof u.inputTokens !== "number") continue;

    // Guard against T3's geminiPromptUsage double-adding cachedInputTokens
    let inp = Math.max(0, u.inputTokens || 0);
    const cr = Math.max(0, u.cachedInputTokens || 0);
    const cw = Math.max(0, u.cacheCreationTokens || 0);
    if (latestDriver === "antigravity" && inp >= cr * 2) {
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

    const priced = priceStep({ uncached: unc, cached: cr, cacheWrite: cw, output: out }, latestModel, latestDriver);
    usd += priced.usd;
    savedUsd += priced.savedUsd;
    if (inp > 0) lastTurnCacheRate = cr / inp;

    const sMs = Date.parse(tr.started_at || p?.startedAt || "");
    const eMs = Date.parse(tr.completed_at || p?.completedAt || "");
    if (Number.isFinite(sMs) && Number.isFinite(eMs) && eMs > sMs) {
      turnDurSum += (eMs - sMs) / 1000;
    }
  }

  const netGenSec = Math.max(0.2, turnDurSum - totalToolWaitSec);
  const promptTotal = uncached + cached + cacheWrite;
  const sessionCacheRate = promptTotal > 0 ? cached / promptTotal : null;
  let effectiveMax = contextMax ?? lookupCatalogContextMax(latestModel, latestDriver) ?? null;
  if (effectiveMax == null && latestDriver === "antigravity") {
    const model = (latestModel || "").toLowerCase();
    const isClaude = /opus|sonnet|haiku|claude/.test(model);
    effectiveMax = isClaude ? 1000000 : 1048576;
  }
  if (effectiveMax == null && latestDriver === "muse") {
    effectiveMax = 1007997;
  }

  return {
    source: "sqlite-fallback",
    provider: latestDriver,
    model: latestModel,
    isRunning,
    turnCount: turnRows.length,
    stepCount: turnRows.length,
    uncached,
    cached,
    cacheWrite,
    input: promptTotal,
    output,
    reasoning,
    usd,
    savedUsd,
    sessionCacheRate,
    lastTurnCacheRate: lastTurnCacheRate ?? sessionCacheRate,
    tokPerSec: turnDurSum > 0.2 && output > 0 ? output / netGenSec : null,
    lastDecodeTps: null,
    e2eTokPerSec: turnDurSum > 0.2 && output > 0 ? output / netGenSec : null,
    durationSec: turnDurSum > 0 ? netGenSec : null,
    contextUsed,
    contextMax: effectiveMax,
  };
}

// Memoize completed subagent telemetry keyed by childThreadId + updated_at so 400+ subagents run in < 2ms
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
  const hit = childSubagentCache.get(childThreadId);
  if (hit && sig && hit.sig === sig && !hit.data.isRunning) {
    return hit.data;
  }
  const cPayload = safeJsonParse(cRow?.payload_json);
  const cTel = aggregateSingleThreadTelemetry(
    db,
    childThreadId,
    cPayload?.modelSelection?.model || fallbackModel,
    cPayload?.modelSelection?.provider || cRow?.default_provider || fallbackProvider
  );
  if (sig && !cTel.isRunning) {
    childSubagentCache.set(childThreadId, { sig, data: cTel });
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
        "SELECT provider, driver, model, status FROM orchestration_v2_projection_provider_sessions WHERE thread_id = ? ORDER BY updated_at DESC LIMIT 1"
      )
      .get(threadId);

    const baseModel =
      psRow?.model ||
      threadPayload?.modelSelection?.model ||
      null;
    const baseProvider =
      psRow?.driver ||
      psRow?.provider ||
      threadPayload?.modelSelection?.provider ||
      threadRow.default_provider ||
      null;

    const mainTel = aggregateSingleThreadTelemetry(db, threadId, baseModel, baseProvider);

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

    const resolvedProvider = mainTel.provider || baseProvider;
    const resolvedModel = mainTel.model || baseModel;
    let resolvedContextMax = mainTel.contextMax ?? null;
    if (resolvedContextMax == null) {
      resolvedContextMax =
        lookupCatalogContextMax(resolvedModel, resolvedProvider) ?? null;
      if (resolvedContextMax == null && resolvedProvider === "antigravity") {
        const m = (resolvedModel || "").toLowerCase();
        resolvedContextMax = /opus|sonnet|haiku|claude/.test(m) ? 1000000 : 1048576;
      }
      if (resolvedContextMax == null && resolvedProvider === "muse") {
        resolvedContextMax = 1007997;
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
      isRunning: mainTel.isRunning || psRow?.status === "running",
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
      },
      cache: {
        cachedTokens: combinedCached,
        cacheWriteTokens: mainTel.cacheWrite,
        displayRate: mainTel.lastTurnCacheRate ?? combinedSessionCacheRate,
        sessionRate: combinedSessionCacheRate,
        lastTurnRate: mainTel.lastTurnCacheRate,
        savedUsd: mainTel.savedUsd + subagentSavedUsd,
      },
      speed: {
        tokPerSec: mainTel.tokPerSec != null ? Math.round(mainTel.tokPerSec * 10) / 10 : null,
        byModel: mainTel.byModelSpeed || {},
        lastDecodeTps:
          mainTel.lastDecodeTps != null ? Math.round(mainTel.lastDecodeTps * 10) / 10 : null,
        e2eTokPerSec:
          mainTel.e2eTokPerSec != null ? Math.round(mainTel.e2eTokPerSec * 10) / 10 : null,
        durationSec: mainTel.durationSec != null ? Math.round(mainTel.durationSec * 10) / 10 : null,
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
  const mergedToolIntervals = mergeToolIntervals(payload.toolIntervals);
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
  let lastTurnCacheRate = null;
  let lastTurnDriver = null;
  let lastTurnModel = null;
  const byModel = {};
  for (const t of turns) {
    const u = t?.usage;
    if (!u || typeof u.inputTokens !== "number" || u.usageStatus === "unavailable") continue;
    const driver = t.driver || payload.provider || "unknown";
    let inp = Math.max(0, u.inputTokens || 0);
    const cr = Math.max(0, u.cachedInputTokens || 0);
    const cw = Math.max(0, u.cacheCreationTokens || 0);
    if (driver === "antigravity" && inp >= cr * 2) inp = inp - cr;
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
    lastTurnCacheRate = inp > 0 ? cr / inp : null;
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
      const netSec = subtractToolWait(t.startedMs, t.completedMs, mergedToolIntervals);
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
  const effDriver = lastTurnDriver || payload.provider || "unknown";
  const effModel = lastTurnModel || payload.model || null;
  let contextUsed = payload.contextUsage?.usedTokens ?? lastPromptTotal;
  if (effDriver === "antigravity" && payload.contextUsage?.usedTokens > 0) {
    // T3's acpPerTurnPromptUsage counts promptTokenCount + cachedContentTokenCount,
    // but Gemini's promptTokenCount already includes cachedContentTokenCount.
    const agyCacheRatio = lastTurnCacheRate ?? sessionCacheRate ?? 0;
    const deduped =
      agyCacheRatio > 0.01
        ? Math.round(payload.contextUsage.usedTokens / (1 + Math.min(1, agyCacheRatio)))
        : payload.contextUsage.usedTokens;
    contextUsed = deduped;
    if (!payload.isRunning && lastPromptTotal != null && deduped > lastPromptTotal * 2.5) {
      contextUsed = lastPromptTotal;
    }
  }
  let contextMax = payload.contextUsage?.maxTokens || lookupCatalogContextMax(effModel, effDriver) || null;
  if (contextMax == null && effDriver === "antigravity") {
    const model = (effModel || "").toLowerCase();
    contextMax = /opus|sonnet|haiku|claude/.test(model) ? 1000000 : 1048576;
  }
  if (contextMax == null && effDriver === "muse") {
    contextMax = 1007997;
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
  const lastDecodeTps = hasDecode ? lastTurnDecodeTps : lastTurnTps;
  const lastDurationSec = hasDecode ? lastStreamSec : lastTurnNetSec;
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
    turnCount: turns.length,
    stepCount: pricedTurns,
    speed: {
      tokPerSec: tokPerSec != null ? Math.round(tokPerSec * 10) / 10 : null,
      byModel: byModelSpeed,
      lastDecodeTps: lastDecodeTps != null ? Math.round(lastDecodeTps * 10) / 10 : null,
      e2eTokPerSec: e2eTokPerSec != null ? Math.round(e2eTokPerSec * 10) / 10 : null,
      durationSec: lastDurationSec != null ? Math.round(lastDurationSec * 10) / 10 : null,
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
    },
    cache: {
      cachedTokens: sumCached,
      cacheWriteTokens: sumCacheWrite,
      sessionRate: sessionCacheRate,
      lastTurnRate: lastTurnCacheRate ?? sessionCacheRate,
      displayRate: lastTurnCacheRate ?? sessionCacheRate,
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
  try {
    if (fs.existsSync(AGY_PROVIDERS_ROOT)) {
      for (const entry of fs.readdirSync(AGY_PROVIDERS_ROOT, { withFileTypes: true })) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const rulesDir = path.join(AGY_PROVIDERS_ROOT, entry.name, "config", "rules");
        const rulesFile = path.join(rulesDir, "AGENTS.md");
        if (fs.existsSync(rulesFile) || fs.existsSync(rulesDir)) out.add(rulesFile);
      }
    }
  } catch {}
  return [...out];
}

function resolveHubContext(args = {}) {
  if (!didAutoSyncHosts) {
    didAutoSyncHosts = true;
    try { mcpRouter.autoSyncHosts(); } catch {}
  }
  const threadHint = args.threadHint || args.threadId || "";
  const routeHint = args.routeHint || args.threadHint || args.threadId || "";
  const hint = routeHint || threadHint;
  let parsed = extractThreadId(hint);
  if (parsed && parsed.startsWith("__ROUTE_")) parsed = null;
  if (parsed === "__NEW__") parsed = null;
  try {
    if (!fs.existsSync(DB_PATH)) {
      return { ok: false, error: "statev2.sqlite not found" };
    }
    let db;
    try {
      db = new DatabaseSync(DB_PATH, { open: true, readOnly: true });
      let threadRow = null;
      if (parsed) {
        threadRow = db.prepare("SELECT thread_id, project_id, title, default_provider, updated_at, payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ?").get(parsed);
      }
      if (!threadRow) {
        // Fall back to most recently updated non-delegated thread.
        const rows = db.prepare("SELECT thread_id, project_id, title, default_provider, updated_at, payload_json FROM orchestration_v2_projection_threads WHERE archived_at IS NULL AND deleted_at IS NULL ORDER BY updated_at DESC").all();
        threadRow = rows.find((r) => r.thread_id && !String(r.thread_id).startsWith("delegated:") && !String(r.thread_id).startsWith("thread:delegated")) || rows[0] || null;
      }
      if (!threadRow) return { ok: false, error: "No active thread" };
      const threadId = threadRow.thread_id;
      const projectId = threadRow.project_id;
      const payload = (() => { try { return JSON.parse(threadRow.payload_json || "{}"); } catch { return {}; } })();
      let projectRow = null;
      if (projectId) {
        try { projectRow = db.prepare("SELECT title, workspace_root FROM projection_projects WHERE project_id = ?").get(projectId); } catch {}
      }
      if (!projectRow) {
        try { projectRow = db.prepare("SELECT title, workspace_root FROM projection_projects ORDER BY updated_at DESC LIMIT 1").get(); } catch {}
      }
      const projectRoot = projectRow?.workspace_root || payload.worktreePath || null;
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
      return { ok: true, threadId, projectId, projectRoot, projectSlug, projectTitle, activeProvider, activeModel, counts: { activePlugins, activeSkills, activeMcps, activeHooks, projectMemories, subagents } };
    } finally {
      try { db?.close(); } catch {}
    }
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

async function hubCall(action, payload = {}) {
  try {
    switch (action) {
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
      case "mcp:list": return mcpRouter.listMcpServers(payload);
      case "mcp:setMode": return mcpRouter.setMcpMode(payload);
      case "mcp:upsert": return mcpRouter.upsertMcpServer(payload);
      case "mcp:remove": return mcpRouter.removeMcpServer(payload);
      case "plugins:list": return hubPlugins.listPlugins(payload);
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
      case "hooks:list": return hubHooks.listHooks(payload);
      case "hooks:toggle":
      case "hooks:setScope": return hubHooks.toggleHook(payload);
      case "hooks:save":
      case "hooks:upsert": return hubHooks.saveCustomHook(payload);
      case "hooks:delete":
      case "hooks:remove": return hubHooks.deleteCustomHook(payload);
      case "hooks:setPlugin": return hubHooks.setPluginHooks(payload);
      case "memory:overview": return memoryVault.getOverview(payload);
      case "memory:list":
      case "memory:search": return await memoryVault.listMemories(payload);
      case "memory:save": return await memoryVault.saveMemory(payload);
      case "memory:consolidate": return await memoryVault.consolidateMemories(payload);
      case "memory:rollback": return await memoryVault.rollbackMemory(payload);
      case "memory:delete": return memoryVault.deleteMemory(payload);
      case "memory:pinToAgentsMd": return memoryVault.pinToAgentsMd(payload);
      case "memory:migratePowerContext": return await memoryVault.migrateFromPowerContext(payload);
      case "memory:stats": return memoryVault.getStats(payload || {});
      case "embed:status": {
        const status = await embedManager.getStatus();
        try {
          const stats = memoryVault.getStats({});
          if (stats && stats.vectorStats) status.vectorStats = stats.vectorStats;
        } catch {}
        return status;
      }
      case "embed:switch": {
        try { memoryVault.invalidateEmbedHealthCache?.(); } catch {}
        const switchResult = await embedManager.switchModel({
          ...(payload || {}),
          onReadyReindex: () => {
            try { memoryVault.invalidateEmbedHealthCache?.(); } catch {}
            return memoryVault.reindexVectors({ forceModelSync: true });
          },
        });
        try {
          if (switchResult && switchResult.ok && switchResult.mode === "mlx") {
            try { memoryVault.invalidateEmbedHealthCache?.(); } catch {}
            memoryVault.reindexVectors({ forceModelSync: true });
          }
        } catch {}
        return switchResult;
      }
      case "subagents:list": return hubSubagents.listSubagents(payload);
      case "subagents:resolveRoute":
      case "subagents:resolve": return hubSubagents.resolveSubagentRoute(payload);
      case "subagents:save": return hubSubagents.saveSubagent({ ...(payload || {}), extraSyncPaths: discoverAntigravityRulesPaths(payload?.extraSyncPaths) });
      case "subagents:update": {
        const p = payload || {};
        if (p.item && typeof p.item === "object") {
          return hubSubagents.saveSubagent({ ...p, extraSyncPaths: discoverAntigravityRulesPaths(p.extraSyncPaths) });
        }
        if (p.id || p.name) {
          const { id, item: _item, scope, projectRoot, extraSyncPaths, ...patch } = p;
          const targetId = id || patch.name;
          const targetScope = scope || (projectRoot ? "project" : "global");
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
            extraSyncPaths: discoverAntigravityRulesPaths(extraSyncPaths),
            item: mergedItem,
          });
        }
        return hubSubagents.saveSubagent({ ...p, extraSyncPaths: discoverAntigravityRulesPaths(p.extraSyncPaths) });
      }
      case "subagents:delete": return hubSubagents.deleteSubagent({ ...(payload || {}), extraSyncPaths: discoverAntigravityRulesPaths(payload?.extraSyncPaths) });
      default: return { ok: false, error: "unknown action: " + action };
    }
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
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
        { cwd: graphInfo.repoPath, timeout: 4000 }
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
  const branch = head.branch || b.vcsStatus?.refName || b.vcsRefs?.refs?.find(ref => ref.current)?.name || (typeof b.branch === "string" && b.branch.trim()) || null;
  const headSha = head.headSha || null;
  const headLogEntries = parseHeadLog(b.headLog);
  const packedRefs = parsePackedRefs(b.packedRefs);
  const vcsRefsList = normalizeVcsRefs(b.vcsRefs);
  const branchCommits = normalizeBranchCommits(b.branchCommits);
  const dirtyCount = parseDirtyCount(b.vcsStatus);

  const nativeCommits = normalizeBranchCommits(b.nativeCommits);
  if (nativeCommits.length) {
    const known = new Map([...branchCommits, ...headLogEntries.map(entry => ({ hash: entry.newSha, ...entry }))].map(commit => [commit.hash, commit]));
    const badges = buildBadgeMapFromRefs([...packedRefs, ...vcsRefsList], nativeCommits[0].hash, branch);
    for (const commit of nativeCommits) {
      const meta = known.get(commit.hash);
      if (meta) { commit.author = meta.author || commit.author; commit.timestamp = meta.timestamp || commit.timestamp; commit.relTime = meta.relTime || commit.relTime; }
      commit.refs = badges.get(commit.hash) || [];
    }
    return { ...buildRemoteGraphResult({ cwd, branch, headSha: nativeCommits[0].hash, dirtyCount, commits: nativeCommits, remoteSource: "t3-connect", githubRepo }), partialHistory: !!b.nativeHistoryTruncated, firstParentOnly: true, parentsUnavailable: false };
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
        // Attach HEAD/badge refs for the tip.
        if (merged.length) {
          const tip = merged[0];
          if (!Array.isArray(tip.refs)) tip.refs = [];
          if (!tip.refs.some((r) => r.isHead)) {
            tip.refs = [{ kind: "head", label: "HEAD", isHead: true }, ...(tip.refs || [])];
            if (branch && !tip.refs.some((r) => r.label === branch)) {
              tip.refs.splice(1, 0, { kind: "branch", label: branch, isHead: false });
            }
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
  // reflog + refs are the history.
  const commits = localCommits.length ? localCommits : branchCommits;
  if (!commits.length) return { ok: false, error: "Remote Git history unavailable through the authorized connection" };
  const badgeBySha = buildBadgeMapFromRefs([...packedRefs, ...vcsRefsList], commits[0]?.hash || headSha, branch);
  for (const c of commits) {
    c.refs = badgeBySha.get(c.hash) || (c.hash === (commits[0]?.hash || "") ? [{ kind: "head", label: "HEAD", isHead: true }] : []);
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
  let current = { defaultLang: "zh" };
  try {
    const raw = fs.readFileSync(HUD_CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") current = { ...current, ...parsed };
  } catch {}
  if (p.defaultLang === "zh" || p.defaultLang === "en") current.defaultLang = p.defaultLang;
  if (p.userLang === "zh" || p.userLang === "en" || p.userLang === "auto" || p.userLang === null) current.userLang = p.userLang;
  if (Number.isFinite(Number(p.langUpdatedAt)) && Number(p.langUpdatedAt) > 0) {
    current.langUpdatedAt = Math.round(Number(p.langUpdatedAt));
  }
  try {
    const dir = path.dirname(HUD_CONFIG_PATH);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {}
    try {
      const st = fs.statSync(dir);
      if (st.isSymbolicLink()) {
        fs.unlinkSync(dir);
      }
    } catch {}
    fs.writeFileSync(HUD_CONFIG_PATH, JSON.stringify(current, null, 2) + "\n", { mode: 0o600 });
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
  resolveHubContext,
  hubCall,
};
