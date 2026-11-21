"use strict";

/**
 * Standalone Read-Only Devin Quota Reader (Zero Magpie dependency).
 * Reads ~/.local/share/devin/credentials.toml strictly in memory (never logs,
 * writes, or exposes API keys/PII to the renderer) and queries the official
 * read-only GetUserStatus RPC with a 120s TTL cache and 300s error backoff.
 */

const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_CACHE_TTL_MS = 120_000;
const DEFAULT_ERROR_BACKOFF_MS = 300_000;
const DEFAULT_TIMEOUT_MS = 4_000;

function readTextSafe(filePath, maxBytes = 256 * 1024) {
  try {
    const st = fs.lstatSync(filePath);
    if (st.isSymbolicLink() || !st.isFile() || st.size > maxBytes) return null;
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function parseCredentialsToml(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const pick = (key) => {
    const m = text.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"\\r\\n]+)"`, "m"));
    return m ? m[1].trim() : "";
  };
  const apiKey = pick("windsurf_api_key");
  if (!apiKey) return null;
  const hasExplicitServer = /^\s*api_server_url\s*=/m.test(text);
  const rawServer = pick("api_server_url");
  if (!hasExplicitServer) {
    return { apiKey, serverUrl: "https://server.codeium.com" };
  }
  if (!rawServer) return null;
  try {
    const u = new URL(rawServer);
    if (u.protocol !== "https:" || u.username || u.password) return null;
    return { apiKey, serverUrl: u.origin };
  } catch {
    return null;
  }
}

function isDevinEnabledInT3(homeDir) {
  const settingsPath = path.join(homeDir, ".t3", "userdata", "settings.json");
  const text = readTextSafe(settingsPath, 2 * 1024 * 1024);
  if (!text) return true; // If T3 settings missing (e.g. standalone), allow credential presence to govern.
  try {
    const parsed = JSON.parse(text);
    const providers = parsed?.providers || parsed?.providerInstances;
    if (!providers || typeof providers !== "object") return true;
    const entry = providers.acpRegistry_devin || providers.devin;
    if (!entry || typeof entry !== "object") return false;
    return entry.enabled !== false;
  } catch {
    return true;
  }
}

function unixToIso(val) {
  const n = Number(val);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n > 1e12 ? n : n * 1000;
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function parsePercentToUsed(remainingVal) {
  if (remainingVal == null || remainingVal === "") return null;
  const rem = Number(remainingVal);
  if (!Number.isFinite(rem) || rem < 0 || rem > 100) return null;
  return Math.max(0, Math.min(100, Math.round((100 - rem) * 10) / 10));
}

function normalizeDevinStatusResponse(data) {
  const userStatus = data?.userStatus || data?.user_status || data;
  const planStatus = userStatus?.planStatus || userStatus?.plan_status;
  if (!planStatus || typeof planStatus !== "object") return null;

  const planInfo = planStatus.planInfo || planStatus.plan_info || {};
  const planName = typeof planInfo.planName === "string" && planInfo.planName.trim()
    ? planInfo.planName.trim().slice(0, 40)
    : (typeof planInfo.plan_name === "string" ? planInfo.plan_name.trim().slice(0, 40) : "");

  const windows = [];

  const weeklyUsed = parsePercentToUsed(planStatus.weeklyQuotaRemainingPercent ?? planStatus.weekly_quota_remaining_percent);
  if (weeklyUsed != null) {
    windows.push({
      id: "devin-weekly",
      kind: "weekly",
      label: "Weekly",
      windowDurationMins: 10080,
      usedPercent: weeklyUsed,
      resetsAt: unixToIso(planStatus.weeklyQuotaResetAtUnix ?? planStatus.weekly_quota_reset_at_unix),
    });
  }

  const hideDaily = planStatus.hideDailyQuota === true || planStatus.hide_daily_quota === true;
  const dailyUsed = hideDaily ? null : parsePercentToUsed(planStatus.dailyQuotaRemainingPercent ?? planStatus.daily_quota_remaining_percent);
  if (dailyUsed != null) {
    windows.push({
      id: "devin-daily",
      kind: "daily",
      label: "Daily",
      windowDurationMins: 1440,
      usedPercent: dailyUsed,
      resetsAt: unixToIso(planStatus.dailyQuotaResetAtUnix ?? planStatus.daily_quota_reset_at_unix),
    });
  }

  // Enterprise / credit-based fallback when quota percentages are absent
  if (!windows.length) {
    const monthly = Number(planInfo.monthlyPromptCredits ?? planInfo.monthly_prompt_credits);
    const available = Number(planStatus.availablePromptCredits ?? planStatus.available_prompt_credits);
    if (Number.isFinite(monthly) && monthly > 0 && Number.isFinite(available) && available >= 0) {
      const usedPct = Math.max(0, Math.min(100, Math.round(((monthly - available) / monthly) * 1000) / 10));
      windows.push({
        id: "devin-monthly",
        kind: "monthly",
        label: "Monthly Credits",
        windowDurationMins: 43200,
        usedPercent: usedPct,
        resetsAt: typeof planStatus.planEnd === "string" ? planStatus.planEnd : null,
      });
    }
  }

  if (!windows.length) return null;

  return {
    instanceId: "acpRegistry_devin",
    driver: "devin",
    displayName: planName ? `Devin · ${planName}` : "Devin",
    planName: planName || null,
    usageLimits: { windows },
  };
}

function defaultPostJson(urlStr, bodyObj, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const body = JSON.stringify(bodyObj);
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: timeoutMs,
    }, (res) => {
      let raw = "";
      res.on("data", (chunk) => {
        raw += chunk;
        if (raw.length > 512 * 1024) req.destroy(new Error("response_too_large"));
      });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`http_${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error("invalid_json"));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.write(body);
    req.end();
  });
}

function createDevinQuotaReader({
  homeDir = os.homedir(),
  xdgDataHome,
  postJson = defaultPostJson,
  now = () => Date.now(),
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  errorBackoffMs = DEFAULT_ERROR_BACKOFF_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  checkT3Enabled = true,
} = {}) {
  let cachedProvider = null;
  let cacheExpiresAt = 0;
  let inFlight = null;

  function credentialsPath() {
    const dataHome = xdgDataHome
      || (path.resolve(homeDir) === path.resolve(os.homedir()) && process.env.XDG_DATA_HOME
        ? path.resolve(process.env.XDG_DATA_HOME)
        : path.join(homeDir, ".local", "share"));
    return path.join(dataHome, "devin", "credentials.toml");
  }

  async function readDevinQuota({ force = false } = {}) {
    const ts = now();
    if (!force && ts < cacheExpiresAt) {
      return { ok: true, available: Boolean(cachedProvider), cached: true, provider: cachedProvider };
    }
    if (checkT3Enabled && !isDevinEnabledInT3(homeDir)) {
      cachedProvider = null;
      cacheExpiresAt = ts + cacheTtlMs;
      return { ok: true, available: false, reason: "disabled", provider: null };
    }
    const credsText = readTextSafe(credentialsPath(), 64 * 1024);
    const creds = parseCredentialsToml(credsText);
    if (!creds) {
      cachedProvider = null;
      cacheExpiresAt = ts + cacheTtlMs;
      return { ok: true, available: false, reason: "no_credentials", provider: null };
    }
    if (inFlight) return inFlight;

    inFlight = (async () => {
      try {
        const endpoint = `${creds.serverUrl}/exa.seat_management_pb.SeatManagementService/GetUserStatus`;
        const payload = {
          metadata: {
            api_key: creds.apiKey,
            ide_name: "devin",
            ide_version: "1.0.0",
            extension_name: "devin-cli",
            extension_version: "1.0.0",
          },
        };
        const resp = await postJson(endpoint, payload, timeoutMs);
        const normalized = normalizeDevinStatusResponse(resp);
        cachedProvider = normalized;
        cacheExpiresAt = now() + cacheTtlMs;
        return { ok: true, available: Boolean(normalized), cached: false, provider: normalized };
      } catch {
        cacheExpiresAt = now() + errorBackoffMs;
        return { ok: true, available: Boolean(cachedProvider), cached: true, stale: true, provider: cachedProvider };
      } finally {
        inFlight = null;
      }
    })();

    return inFlight;
  }

  return { readDevinQuota };
}

module.exports = {
  createDevinQuotaReader,
  parseCredentialsToml,
  normalizeDevinStatusResponse,
};
