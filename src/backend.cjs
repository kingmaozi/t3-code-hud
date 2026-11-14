"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { DatabaseSync } = require("node:sqlite");

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
    tokPerSec: avgDecodeTps ?? lastDecodeTps ?? avgE2eTps,
    lastDecodeTps,
    avgDecodeTps,
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
    const rows = adb
      .prepare("SELECT idx, metadata FROM steps WHERE metadata IS NOT NULL ORDER BY idx ASC")
      .all();

    let sumUncached = 0;
    let sumCached = 0;
    let sumCacheWrite = 0;
    let sumOutput = 0;
    let sumReasoning = 0;
    let sumUsd = 0;
    let sumSavedUsd = 0;

    let streamTokensSum = 0;
    let streamSecSum = 0;
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
      contextMax: Math.max(300000, lastContextPrompt || 0),
      tokPerSec: avgDecodeTps ?? lastStreamTps ?? avgE2eTps,
      lastDecodeTps: lastStreamTps,
      avgDecodeTps,
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
      "SELECT driver, payload_json FROM orchestration_v2_projection_provider_threads WHERE thread_id = ? ORDER BY rowid ASC"
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
    let uncached = 0;
    let cached = 0;
    let cacheWrite = 0;
    let output = 0;
    let reasoning = 0;
    let usd = 0;
    let savedUsd = 0;
    let stepCount = 0;

    for (const part of nativeParts) {
      uncached += part.uncached;
      cached += part.cached;
      cacheWrite += part.cacheWrite;
      output += part.output;
      reasoning += part.reasoning;
      usd += part.usd;
      savedUsd += part.savedUsd;
      stepCount += part.stepCount;
      if (part.model) latestModel = part.model;
      if (part.driver) latestDriver = part.driver;
    }

    const lastPart = nativeParts[nativeParts.length - 1];
    const promptTotal = uncached + cached + cacheWrite;
    const sessionCacheRate = promptTotal > 0 ? cached / promptTotal : null;

    return {
      source: "native",
      provider: lastPart.driver || latestDriver,
      model: lastPart.model || latestModel,
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
      tokPerSec: lastPart.tokPerSec,
      lastDecodeTps: lastPart.lastDecodeTps,
      e2eTokPerSec: lastPart.e2eTokPerSec,
      durationSec: lastPart.durationSec,
      contextUsed: lastPart.lastContextPrompt ?? contextUsed,
      contextMax: lastPart.contextMax ?? contextMax,
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
  const effectiveMax =
    latestDriver === "antigravity" ? Math.max(300000, contextUsed || 0) : contextMax;

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
  const sig = cRow ? `${cRow.updated_at || ""}` : "";
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
    const fallbackMax = resolvedProvider === "antigravity" ? 300000 : 1000000;

    return {
      ok: true,
      threadId,
      title: threadRow.title || "未命名会话",
      projectTitle: projectRow?.title || (repoPath ? path.basename(repoPath) : ""),
      repoPath,
      branch: branchName,
      provider: resolvedProvider,
      model: mainTel.model || baseModel,
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
        contextMax: mainTel.contextMax || fallbackMax,
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

async function getGitGraph(threadHint, maxCommits = 100) {
  const stats = getThreadStats(threadHint);
  let repoPath = stats?.repoPath || null;

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

async function getCommitDetail(threadHint, commitHash) {
  if (!commitHash || !/^[0-9a-f]{6,40}$/i.test(commitHash)) {
    return { ok: false, error: "非法 Commit SHA" };
  }
  const graphInfo = await getGitGraph(threadHint, 20);
  if (!graphInfo.ok || !graphInfo.repoPath) {
    return { ok: false, error: graphInfo.error || "找不到仓库路径" };
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

module.exports = {
  getThreadStats,
  getGitGraph,
  getCommitDetail,
};
