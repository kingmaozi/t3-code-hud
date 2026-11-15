"use strict";
// T3 Hub local embedding manager: presets, cache detection, :8001 lifecycle.
// Config lives at ~/.t3/hub/embed-config.json. The actual :8001 process is
// src/embed-server.py run with the eg2 venv python.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync, execFileSync } = require("node:child_process");

const FTS_ID = "fts5-zero-ram";
const DEFAULT_PORT = 8001;
const DEFAULT_PYTHON = "/Users/longxiaking/powercontext-embed-eg2/.venv/bin/python";

const PRESETS = [
  {
    id: "mlx-community/Qwen3-Embedding-0.6B-8bit",
    modelId: "mlx-community/Qwen3-Embedding-0.6B-8bit",
    label: "Qwen3 Embedding 0.6B · 8-bit",
    shortLabel: "Qwen3 0.6B 8-bit",
    sizeMb: 604,
    estRamMb: 680,
    dim: 1024,
    minRamGb: 32,
    idealRamTier: "workstation",
    tags: ["中文最强", "代码检索", "8-bit无损"],
    desc: "中文 C-MTEB 84.5 小模型第 1，8-bit 无损，单实例支撑 10+ 项目并发",
    description: "中文 C-MTEB 84.5 小模型第 1，8-bit 无损，单实例支撑 10+ 项目并发",
    arch: "qwen3",
    mode: "mlx",
  },
  {
    id: "mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ",
    modelId: "mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ",
    label: "Qwen3 Embedding 0.6B · 4-bit DWQ",
    shortLabel: "Qwen3 0.6B 4-bit",
    sizeMb: 320,
    estRamMb: 380,
    dim: 1024,
    minRamGb: 16,
    idealRamTier: "standard",
    tags: ["中文最强", "代码检索", "DWQ蒸馏"],
    desc: "DWQ 蒸馏量化甜点款，中文与代码双料领先",
    description: "DWQ 蒸馏量化甜点款，中文与代码双料领先",
    arch: "qwen3",
    mode: "mlx",
  },
  {
    id: "mlx-community/bge-m3-mlx-8bit",
    modelId: "mlx-community/bge-m3-mlx-8bit",
    label: "BGE-M3 · 8-bit",
    shortLabel: "BGE-M3 8-bit",
    sizeMb: 576,
    estRamMb: 650,
    dim: 1024,
    minRamGb: 32,
    idealRamTier: "workstation",
    tags: ["多语种", "稳健双语", "稠密检索"],
    desc: "智源多语种稠密检索工业界常青树，稳健双语",
    description: "智源多语种稠密检索工业界常青树，稳健双语",
    arch: "xlm-roberta",
    mode: "mlx",
  },
  {
    id: "mlx-community/bge-m3-mlx-4bit",
    modelId: "mlx-community/bge-m3-mlx-4bit",
    label: "BGE-M3 · 4-bit",
    shortLabel: "BGE-M3 4-bit",
    sizeMb: 305,
    estRamMb: 360,
    dim: 1024,
    minRamGb: 16,
    idealRamTier: "standard",
    tags: ["多语种", "轻量", "稠密检索"],
    desc: "智源 BGE-M3 轻量 4-bit 版，体积更小的双语常青树",
    description: "智源 BGE-M3 轻量 4-bit 版，体积更小的双语常青树",
    arch: "xlm-roberta",
    mode: "mlx",
  },
  {
    id: "mlx-community/embeddinggemma-300m-8bit",
    modelId: "mlx-community/embeddinggemma-300m-8bit",
    label: "EmbeddingGemma 300M · 8-bit",
    shortLabel: "Gemma 300M 8-bit",
    sizeMb: 312,
    estRamMb: 370,
    dim: 768,
    minRamGb: 16,
    idealRamTier: "standard",
    tags: ["纯文本", "代码均衡", "轻量"],
    desc: "无多模态塔的纯文本轻量版，代码与多语言均衡",
    description: "无多模态塔的纯文本轻量版，代码与多语言均衡",
    arch: "gemma3_text",
    mode: "mlx",
  },
  {
    id: "mlx-community/embeddinggemma-300m-4bit",
    modelId: "mlx-community/embeddinggemma-300m-4bit",
    label: "EmbeddingGemma 300M · 4-bit",
    shortLabel: "Gemma 300M 4-bit",
    sizeMb: 165,
    estRamMb: 220,
    dim: 768,
    minRamGb: 8,
    idealRamTier: "compact",
    tags: ["省内存", "极速", "纯文本"],
    desc: "165 MB 极速省内存版，8–12GB 小内存机器首选",
    description: "165 MB 极速省内存版，8–12GB 小内存机器首选",
    arch: "gemma3_text",
    mode: "mlx",
  },
  {
    id: "mlx-community/snowflake-arctic-embed-l-v2.0-8bit",
    modelId: "mlx-community/snowflake-arctic-embed-l-v2.0-8bit",
    label: "Arctic Embed L v2 · 8-bit",
    shortLabel: "Arctic L 8-bit",
    sizeMb: 576,
    estRamMb: 650,
    dim: 1024,
    minRamGb: 32,
    idealRamTier: "workstation",
    tags: ["企业级", "代码检索", "跨语种"],
    desc: "Snowflake 企业级代码与跨语种检索",
    description: "Snowflake 企业级代码与跨语种检索",
    arch: "xlm-roberta",
    mode: "mlx",
  },
  {
    id: "mlx-community/LFM2.5-Embedding-350M-4bit",
    modelId: "mlx-community/LFM2.5-Embedding-350M-4bit",
    label: "LFM2.5 Embedding 350M · 4-bit",
    shortLabel: "LFM2.5 350M 4-bit",
    sizeMb: 190,
    estRamMb: 250,
    dim: 1024,
    minRamGb: 8,
    idealRamTier: "compact",
    tags: ["极速", "状态空间", "轻量"],
    desc: "Liquid AI 状态空间极速轻量架构",
    description: "Liquid AI 状态空间极速轻量架构",
    arch: "lfm2",
    mode: "mlx",
  },
  {
    id: "mlx-community/nomicai-modernbert-embed-base-bf16",
    modelId: "mlx-community/nomicai-modernbert-embed-base-bf16",
    label: "Nomic ModernBERT · BF16",
    shortLabel: "ModernBERT BF16",
    sizeMb: 284,
    estRamMb: 340,
    dim: 768,
    minRamGb: 16,
    idealRamTier: "standard",
    tags: ["长上下文", "高速检索", "代码"],
    desc: "8K 长上下文英文与代码高速检索",
    description: "8K 长上下文英文与代码高速检索",
    arch: "modernbert",
    mode: "mlx",
  },
  {
    id: "mlx-community/embeddinggemma-2-8bit",
    modelId: "mlx-community/embeddinggemma-2-8bit",
    label: "EmbeddingGemma 2 · 8-bit",
    shortLabel: "Gemma 2 8-bit",
    sizeMb: 1177,
    estRamMb: 1635,
    dim: 768,
    minRamGb: 32,
    idealRamTier: "workstation",
    tags: ["多模态", "偏重"],
    desc: "Google 多模态重型版，含多模态塔偏重",
    description: "Google 多模态重型版，含多模态塔偏重",
    arch: "embedding_gemma2",
    mode: "mlx",
  },
  {
    id: FTS_ID,
    modelId: FTS_ID,
    label: "纯关键词零内存模式 (SQLite FTS5)",
    shortLabel: "FTS5 零内存",
    sizeMb: 0,
    estRamMb: 0,
    dim: 0,
    minRamGb: 0,
    idealRamTier: "any",
    tags: ["零内存", "全文检索"],
    desc: "纯关键词零内存模式，SQLite FTS5 内置",
    description: "关闭后台向量进程，仅用毫秒级全文与中文分词检索",
    arch: "fts5",
    mode: "fts5",
  },
];

let _cachedChipModel = null;
function readChipModel() {
  if (_cachedChipModel) return _cachedChipModel;
  try {
    const out = execFileSync("sysctl", ["-n", "machdep.cpu.brand_string"], { encoding: "utf8", timeout: 1500 }).trim();
    if (out) _cachedChipModel = out;
  } catch {}
  if (!_cachedChipModel) {
    try {
      const c = os.cpus()[0];
      _cachedChipModel = (c && c.model) ? String(c.model) : "Unknown";
    } catch {
      _cachedChipModel = "Unknown";
    }
  }
  return _cachedChipModel;
}
function detectHardwareProfile(overrides = {}) {
  const o = overrides && typeof overrides === "object" ? overrides : {};
  let totalRamGb;
  if (o.totalRamGb != null && Number.isFinite(Number(o.totalRamGb))) totalRamGb = Number(o.totalRamGb);
  else if (o.totalmem != null && Number.isFinite(Number(o.totalmem))) totalRamGb = Math.round(Number(o.totalmem) / (1024 ** 3));
  else totalRamGb = Math.round(os.totalmem() / (1024 ** 3));
  const chipModel = o.chipModel ? String(o.chipModel) : readChipModel();
  let tier;
  let primaryModelId;
  let secondaryModelIds;
  let recommendReason;
  if (totalRamGb >= 32) {
    tier = "workstation";
    primaryModelId = "mlx-community/Qwen3-Embedding-0.6B-8bit";
    secondaryModelIds = ["mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ", "mlx-community/bge-m3-mlx-8bit"];
    recommendReason = `检测到 ${chipModel} · ${totalRamGb} GB 内存：推荐 604 MB 的 Qwen3-0.6B 8-bit 无损版（比 1.6GB 多模态版省 60%+ 内存，中文+代码双料领先，单进程共享轻松支撑 10+ 项目同开）`;
  } else if (totalRamGb >= 16) {
    tier = "standard";
    primaryModelId = "mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ";
    secondaryModelIds = ["mlx-community/bge-m3-mlx-4bit"];
    recommendReason = `检测到 ${chipModel} · ${totalRamGb} GB 内存：推荐 320 MB 的 Qwen3-0.6B 4-bit DWQ 甜点款（中文+代码双料领先，内存占用低，单进程共享支撑多项目同开）`;
  } else {
    tier = "compact";
    primaryModelId = "mlx-community/embeddinggemma-300m-4bit";
    secondaryModelIds = ["fts5-zero-ram"];
    recommendReason = `检测到 ${chipModel} · ${totalRamGb} GB 内存：推荐 165 MB 的 EmbeddingGemma 300M 4-bit 极速省内存版（8–12GB 小内存机器首选，零压力运行）`;
  }
  return { chipModel, totalRamGb, tier, primaryModelId, secondaryModelIds, recommendReason };
}
function recommendBadgeFor(preset, hw) {
  if (preset.id === "mlx-community/Qwen3-Embedding-0.6B-8bit" && preset.id === hw.primaryModelId) return `★ 本机 ${hw.totalRamGb}GB 首选`;
  if (preset.id === "mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ" && preset.id === hw.primaryModelId) return "★ 16-24GB 甜点";
  if (preset.id === "mlx-community/embeddinggemma-300m-4bit" && preset.id === hw.primaryModelId) return "★ 8GB 省内存首选";
  if (preset.id === "mlx-community/bge-m3-mlx-8bit") return "稳健双语";
  if (preset.id === "mlx-community/embeddinggemma-2-8bit") return "偏重·含多模态塔";
  if (preset.id === hw.primaryModelId) return `★ 本机 ${hw.totalRamGb}GB 首选`;
  return "";
}

function safeMkdir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}
function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJsonFileAtomic(file, obj) {
  safeMkdir(path.dirname(file));
  const tmp = file + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}
function validateModelId(modelId, homeDir) {
  if (typeof modelId !== "string" || !modelId.trim()) return { ok: false, error: "modelId required" };
  const v = modelId.trim();
  if (v === FTS_ID) return { ok: true, kind: "fts5", value: v };
  // Local folder wins when it exists on disk (absolute or ~-expanded).
  const expanded = v.startsWith("~/") ? path.join(homeDir, v.slice(2)) : v;
  try {
    if (fs.statSync(expanded).isDirectory()) return { ok: true, kind: "local", value: expanded };
  } catch {}
  if (path.isAbsolute(expanded) || expanded.startsWith("./") || expanded.startsWith("../")) {
    return { ok: false, error: "local model path does not exist: " + v };
  }
  // HuggingFace repo id: org/repo (first slash separates org/repo, allow
  // nested groups via the last-slash convention huggingface uses).
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._~\/-]+$/.test(v)) {
    return { ok: false, error: "invalid modelId (expected HF repo id like org/repo or local folder): " + v };
  }
  if (v.includes("..") || v.includes(" ") || v.startsWith("/") || v.endsWith("/")) {
    return { ok: false, error: "invalid modelId: " + v };
  }
  return { ok: true, kind: "hf", value: v };
}
function isModelCached(modelId, cacheDir, homeDir) {
  if (!modelId) return false;
  if (modelId === FTS_ID) return true;
  const v = String(modelId).trim();
  const expanded = v.startsWith("~/") ? path.join(homeDir, v.slice(2)) : v;
  // Absolute or ~-expanded paths are local folders; bare org/repo ids are HF.
  if (path.isAbsolute(expanded)) {
    try {
      return fs.statSync(expanded).isDirectory();
    } catch {
      return false;
    }
  }
  // A relative path that exists as a directory is still a local folder.
  try {
    if (fs.statSync(expanded).isDirectory() && !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._~\/-]+$/.test(v)) return true;
  } catch {}
  const safe = "models--" + v.replace(/\//g, "--");
  const dir = path.join(cacheDir, safe);
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
    // HF Hub 2.x xet layout: blobs/ holds content-addressed files, snapshots/<rev>/ holds symlinked snapshot files.
    try {
      const blobs = path.join(dir, "blobs");
      const files = fs.readdirSync(blobs);
      for (const f of files) {
        try {
          const st = fs.statSync(path.join(blobs, f));
          if (st.isFile() && st.size > 0) return true;
        } catch {}
      }
      if (files.length > 0) return true;
    } catch {}
    try {
      const snaps = path.join(dir, "snapshots");
      const revs = fs.readdirSync(snaps);
      for (const rev of revs) {
        try {
          const revDir = path.join(snaps, rev);
          if (!fs.statSync(revDir).isDirectory()) continue;
          const names = fs.readdirSync(revDir);
          for (const name of names) {
            if (!name.endsWith(".safetensors")) continue;
            try {
              const st = fs.statSync(path.join(revDir, name));
              if (st.isFile() && st.size > 0) return true;
            } catch {}
          }
        } catch {}
      }
      return false;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}
function defaultLaunchAgentPlistPath(homeDir) {
  return path.join(homeDir, "Library", "LaunchAgents", "com.t3tools.powercontext-embed.plist");
}
function updateLaunchAgentPlistFile(plistPath, { modelId, servedName, keepAlive } = {}) {
  let xml;
  try {
    xml = fs.readFileSync(plistPath, "utf8");
  } catch {
    return false;
  }
  let next = xml;
  if (modelId != null && modelId !== "") {
    next = next.replace(/(<key>EMBED_MODEL<\/key>\s*<string>)([^<]*)(<\/string>)/, "$1" + String(modelId) + "$3");
  }
  if (servedName != null && servedName !== "") {
    next = next.replace(/(<key>EMBED_NAME<\/key>\s*<string>)([^<]*)(<\/string>)/, "$1" + String(servedName) + "$3");
  }
  if (keepAlive != null) {
    const tag = keepAlive ? "<true/>" : "<false/>";
    next = next.replace(/(<key>KeepAlive<\/key>\s*)(<true\/>|<false\/>)/, "$1" + tag);
  }
  const tmp = plistPath + ".tmp-" + process.pid;
  try {
    fs.writeFileSync(tmp, next, "utf8");
    fs.renameSync(tmp, plistPath);
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
    return false;
  }
  return true;
}
function blobBytes(modelId, cacheDir) {
  const safe = "models--" + String(modelId).replace(/\//g, "--");
  const blobs = path.join(cacheDir, safe, "blobs");
  let total = 0;
  try {
    for (const f of fs.readdirSync(blobs)) {
      try {
        total += fs.statSync(path.join(blobs, f)).size;
      } catch {}
    }
  } catch {}
  return total;
}
function createEmbedManager(opts = {}) {
  const homeDir = opts.homeDir || process.env.HOME || os.homedir();
  const hubDir = opts.hubDir || process.env.T3_HUB_DIR || path.join(homeDir, ".t3", "hub");
  const configPath = opts.configPath || path.join(hubDir, "embed-config.json");
  const cacheDir = opts.cacheDir || opts.hfCacheDir || path.join(homeDir, ".cache", "huggingface", "hub");
  const port = Number(opts.port) || DEFAULT_PORT;
  const embedServerPath = opts.embedServerPath || path.join(__dirname, "embed-server.py");
  const pythonPath = opts.pythonPath || DEFAULT_PYTHON;
  const pidPath = opts.pidPath || path.join(hubDir, "embed-server.pid");
  const logPath = opts.logPath || path.join(hubDir, "logs", "embed-server.log");
  const extraKillPattern = opts.allowedKillPattern != null ? opts.allowedKillPattern : null;
  const extraScriptPath = opts.serverScriptPath != null ? String(opts.serverScriptPath) : null;
  const launchAgentPlistPath = opts.launchAgentPlistPath === null ? null : (opts.launchAgentPlistPath != null ? String(opts.launchAgentPlistPath) : defaultLaunchAgentPlistPath(homeDir));
  const _launchctl = typeof opts._launchctl === "function" ? opts._launchctl : null;
  const hardwareOverrides = opts.hardwareOverrides && typeof opts.hardwareOverrides === "object"
    ? { ...opts.hardwareOverrides }
    : {};
  if (opts.totalRamGb != null) hardwareOverrides.totalRamGb = opts.totalRamGb;
  if (opts.chipModel != null) hardwareOverrides.chipModel = opts.chipModel;
  let downloadJob = null;

  function runLaunchctl(args) {
    if (_launchctl) {
      try { return _launchctl(args); } catch { return { status: 1 }; }
    }
    try {
      const r = spawnSync("launchctl", args, { encoding: "utf8", timeout: 4000 });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    } catch {
      return { status: 1 };
    }
  }
  function syncLaunchAgentPlist(patch = {}) {
    if (!launchAgentPlistPath) return false;
    try {
      if (!fs.existsSync(launchAgentPlistPath)) return false;
    } catch {
      return false;
    }
    return updateLaunchAgentPlistFile(launchAgentPlistPath, patch);
  }
  function launchctlUid() {
    try { if (typeof process.getuid === "function") return process.getuid(); } catch {}
    try { return os.userInfo().uid; } catch { return 501; }
  }

  function isEmbedProcess(pid) {
    try {
      if (!Number.isFinite(pid) || pid <= 0) return false;
      const out = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 1500 });
      const cmd = String(out || "");
      if (!cmd.trim()) return false;
      if (cmd.includes("embed-server.py")) return true;
      if (cmd.includes("powercontext-embed-eg2/server.py")) return true;
      if (extraScriptPath && cmd.includes(extraScriptPath)) return true;
      if (embedServerPath && cmd.includes(String(embedServerPath))) return true;
      if (extraKillPattern != null) {
        if (extraKillPattern instanceof RegExp) {
          if (extraKillPattern.test(cmd)) return true;
        } else if (String(extraKillPattern) && cmd.includes(String(extraKillPattern))) return true;
      }
      return false;
    } catch {
      return false;
    }
  }
  function safeKillPid(pid) {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    if (pid === process.pid) return false;
    if (!isEmbedProcess(pid)) return false;
    try {
      process.kill(pid, "SIGTERM");
      return true;
    } catch {
      return false;
    }
  }

  function readConfig() {
    const c = readJsonFile(configPath, null);
    if (c && typeof c === "object") return c;
    return { mode: "fts5", modelId: FTS_ID, customModelId: null, useMirror: false };
  }
  function writeConfig(patch) {
    const cur = readConfig();
    const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
    writeJsonFileAtomic(configPath, next);
    return next;
  }
  function healthSync() {
    try {
      const url = "http://127.0.0.1:" + port + "/health";
      const res = spawnSync("curl", ["-s", "-m", "0.8", "--connect-timeout", "0.8", url], { encoding: "utf8", timeout: 1200 });
      if (res.error || res.status !== 0 || !res.stdout) return null;
      const j = JSON.parse(res.stdout);
      return j && (j.ok === true || j.status === "ok") ? j : null;
    } catch {
      return null;
    }
  }
  function stopServer() {
    // 1) pidfile kill.
    try {
      if (fs.existsSync(pidPath)) {
        const pid = Number(String(fs.readFileSync(pidPath, "utf8")).trim());
        if (Number.isFinite(pid) && pid > 0) {
          safeKillPid(pid);
        }
        try {
          fs.unlinkSync(pidPath);
        } catch {}
      }
    } catch {}
    // 3) lsof fallback: kill whatever listens on the embed port.
    try {
      const r = spawnSync("lsof", ["-ti", "TCP:" + port, "-sTCP:LISTEN"], { encoding: "utf8", timeout: 1500 });
      if (r.stdout) {
        for (const line of String(r.stdout).split("\n")) {
          const pid = Number(line.trim());
          if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) {
            safeKillPid(pid);
          }
        }
      }
    } catch {}
    // Brief settle so getStatus observes the stop.
    try {
      const end = Date.now() + 250;
      while (Date.now() < end) {
        if (!healthSync()) break;
        const t = Date.now() + 50;
        while (Date.now() < t) {}
      }
    } catch {}
  }
  function startServer(modelId, useMirror) {
    safeMkdir(path.dirname(logPath));
    const served = String(modelId).split("/").pop();
    const env = { ...process.env, EMBED_MODEL: String(modelId), EMBED_NAME: served, PORT: String(port), EMBED_CACHE_LIMIT_MB: "256" };
    if (useMirror) env.HF_ENDPOINT = "https://hf-mirror.com";
    const py = fs.existsSync(pythonPath) ? pythonPath : "python3";
    const out = fs.existsSync(logPath) ? fs.openSync(logPath, "a") : fs.openSync(logPath, "w");
    const child = spawn(py, [embedServerPath], {
      env,
      detached: true,
      stdio: ["ignore", out, out],
    });
    try {
      child.unref();
    } catch {}
    try {
      fs.writeFileSync(pidPath, String(child.pid) + "\n", "utf8");
    } catch {}
    return child.pid;
  }
  function waitReady(onReady, tries = 60) {
    let n = 0;
    const timer = setInterval(() => {
      n += 1;
      if (healthSync()) {
        clearInterval(timer);
        try {
          if (typeof onReady === "function") onReady();
        } catch {}
      } else if (n >= tries) {
        clearInterval(timer);
      }
    }, 500);
    try {
      timer.unref();
    } catch {}
    return timer;
  }
  function startDownload(modelId, useMirror, onReadyReindex) {
    const preset = PRESETS.find((p) => p.modelId === modelId);
    const expectedMb = preset && preset.sizeMb > 0 ? preset.sizeMb : 300;
    downloadJob = { active: true, modelId, downloadedMb: 0, percent: 0, statusText: "准备下载 " + modelId };
    const py = fs.existsSync(pythonPath) ? pythonPath : "python3";
    const env = { ...process.env };
    if (useMirror) env.HF_ENDPOINT = "https://hf-mirror.com";
    const code =
      "import os,sys\n" +
      "from huggingface_hub import snapshot_download\n" +
      "print(snapshot_download(repo_id=sys.argv[1]), flush=True)\n";
    let child = null;
    try {
      child = spawn(py, ["-c", code, String(modelId)], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      try {
        child.unref();
      } catch {}
    } catch (e) {
      downloadJob = { active: false, modelId, downloadedMb: 0, percent: 0, statusText: "下载启动失败：" + (e.message || String(e)) };
      return downloadJob;
    }
    const poll = setInterval(() => {
      try {
        const bytes = blobBytes(String(modelId), cacheDir);
        const mb = Math.round((bytes / 1024 / 1024) * 10) / 10;
        const pct = Math.min(99, Math.round((mb / expectedMb) * 100));
        downloadJob = { active: true, modelId, downloadedMb: mb, percent: pct, statusText: "下载中 " + mb + "/" + expectedMb + " MB" };
        if (isModelCached(String(modelId), cacheDir, homeDir)) {
          clearInterval(poll);
          downloadJob = { active: false, modelId, downloadedMb: mb, percent: 100, statusText: "下载完成，正在启动向量服务" };
          try {
            startServer(String(modelId), useMirror);
          } catch {}
          waitReady(() => {
            try {
              if (typeof onReadyReindex === "function") onReadyReindex();
            } catch {}
          });
          setTimeout(() => {
            if (downloadJob && downloadJob.active === false) downloadJob = null;
          }, 5000).unref();
        }
      } catch {}
    }, 1000);
    try {
      poll.unref();
    } catch {}
    child.on("close", () => {
      if (downloadJob && downloadJob.active && isModelCached(String(modelId), cacheDir, homeDir)) {
        // close event raced the poll; completion is handled by poll.
      }
    });
    return downloadJob;
  }
  function getStatus() {
    const cfg = readConfig();
    const health = healthSync();
    const running = Boolean(health);
    let rssMb = 0;
    if (running) {
      const v = health.rssMb != null ? health.rssMb : health.active_mb != null ? health.active_mb : health.rss_mb;
      rssMb = Number.isFinite(Number(v)) ? Math.round(Number(v) * 10) / 10 : 0;
    }
    let mode = cfg.mode || "fts5";
    let activeModelId = cfg.modelId || cfg.customModelId || (mode === "fts5" ? FTS_ID : PRESETS[0].modelId);
    if (!fs.existsSync(configPath) && running) {
      const hm = health.model_id || health.modelId;
      if (hm) {
        activeModelId = String(hm);
        mode = "mlx";
      }
    }
    const hw = detectHardwareProfile(hardwareOverrides);
    const presets = PRESETS.map((p) => ({
      ...p,
      downloaded: isModelCached(p.modelId, cacheDir, homeDir),
      recommended: p.id === hw.primaryModelId,
      secondaryRecommended: (hw.secondaryModelIds || []).includes(p.id),
      recommendBadge: recommendBadgeFor(p, hw),
    }));
    const hardware = { chipModel: hw.chipModel, totalRamGb: hw.totalRamGb, tier: hw.tier, primaryModelId: hw.primaryModelId, recommendReason: hw.recommendReason, secondaryModelIds: hw.secondaryModelIds };
    return {
      ok: true,
      mode,
      activeModelId,
      running,
      rssMb,
      port,
      hardware,
      presets,
      customModelId: cfg.customModelId || null,
      useMirror: Boolean(cfg.useMirror),
      downloadJob: downloadJob && downloadJob.active ? downloadJob : null,
    };
  }
  function switchModel(args = {}) {
    try {
      const rawMode = args.mode ? String(args.mode) : null;
      const modelId = args.modelId ? String(args.modelId) : args.customModelId ? String(args.customModelId) : null;
      const customModelId = args.customModelId ? String(args.customModelId) : null;
      const useMirror = Boolean(args.useMirror);
      const onReadyReindex = typeof args.onReadyReindex === "function" ? args.onReadyReindex : null;
      // FTS5 zero-RAM mode.
      if (rawMode === "fts5" || modelId === FTS_ID) {
        writeConfig({ mode: "fts5", modelId: FTS_ID, customModelId: customModelId || null, useMirror });
        if (launchAgentPlistPath) {
          try {
            if (fs.existsSync(launchAgentPlistPath)) {
              syncLaunchAgentPlist({ keepAlive: false });
              runLaunchctl(["bootout", "gui/" + launchctlUid(), launchAgentPlistPath]);
            }
          } catch {}
        }
        stopServer();
        downloadJob = null;
        return { ok: true, mode: "fts5", activeModelId: FTS_ID, running: false, rssMb: 0, port };
      }
      // MLX mode (default when no fts5 signal).
      if (!modelId) return { ok: false, error: "modelId required" };
      const v = validateModelId(modelId, homeDir);
      if (!v.ok) return { ok: false, error: v.error };
      const effective = v.kind === "local" ? v.value : v.value;
      const cached = isModelCached(effective, cacheDir, homeDir);
      const isPreset = PRESETS.some((p) => p.modelId === effective);
      writeConfig({ mode: "mlx", modelId: effective, customModelId: customModelId || (isPreset ? null : effective), useMirror });
      if (launchAgentPlistPath) {
        try {
          if (fs.existsSync(launchAgentPlistPath)) {
            const servedName = String(effective).split("/").pop();
            syncLaunchAgentPlist({ modelId: effective, servedName, keepAlive: true });
            runLaunchctl(["bootstrap", "gui/" + launchctlUid(), launchAgentPlistPath]);
          }
        } catch {}
      }
      if (!cached) {
        const job = startDownload(effective, useMirror, onReadyReindex);
        return { ok: true, mode: "mlx", activeModelId: effective, downloading: true, downloadJob: job, port };
      }
      // Cached (or local folder): try in-process hot switch first, else restart.
      let switched = false;
      try {
        const url = "http://127.0.0.1:" + port + "/admin/switch-model";
        const res = spawnSync(
          "curl",
          ["-s", "-m", "60", "--connect-timeout", "2", "-X", "POST", url, "-H", "Content-Type: application/json", "-d", JSON.stringify({ modelId: effective, useMirror })],
          { encoding: "utf8", timeout: 65000 }
        );
        if (!res.error && res.status === 0 && res.stdout) {
          const j = JSON.parse(res.stdout);
          if (j && j.ok === true) switched = true;
        }
      } catch {}
      if (!switched) {
        try {
          stopServer();
        } catch {}
        try {
          startServer(effective, useMirror);
        } catch (e) {
          return { ok: false, error: "start embed-server failed: " + (e.message || String(e)) };
        }
        waitReady(() => {
          try {
            if (onReadyReindex) onReadyReindex();
          } catch {}
        });
      } else {
        waitReady(() => {
          try {
            if (onReadyReindex) onReadyReindex();
          } catch {}
        }, 10);
      }
      return { ok: true, mode: "mlx", activeModelId: effective, switched, port };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  }
  return {
    hubDir,
    homeDir,
    configPath,
    cacheDir,
    port,
    launchAgentPlistPath,
    getStatus,
    stopServer,
    switchModel,
    _isModelCached: (id) => isModelCached(id, cacheDir, homeDir),
    _blobBytes: (id) => blobBytes(id, cacheDir),
    _syncLaunchAgentPlist: syncLaunchAgentPlist,
  };
}
let _singleton = null;
function getDefaultEmbedManager() {
  if (!_singleton) _singleton = createEmbedManager();
  return _singleton;
}
function getStatus() {
  return getDefaultEmbedManager().getStatus();
}
function switchModel(a) {
  return getDefaultEmbedManager().switchModel(a || {});
}
module.exports = {
  createEmbedManager,
  getDefaultEmbedManager,
  getStatus,
  switchModel,
  validateModelId,
  detectHardwareProfile,
  updateLaunchAgentPlistFile,
  defaultLaunchAgentPlistPath,
  isModelCached: (id, cacheDir, homeDir) => isModelCached(id, cacheDir || path.join(homeDir || process.env.HOME || os.homedir(), ".cache", "huggingface", "hub"), homeDir || process.env.HOME || os.homedir()),
  PRESETS,
  FTS_ID,
  DEFAULT_PORT,
  default: getDefaultEmbedManager(),
};
