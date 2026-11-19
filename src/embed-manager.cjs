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
const LOG_ROTATION_MAX_BYTES = 20 * 1024 * 1024;

function ceilingMbFor(estRamMb) {
  const base = Number(estRamMb) || 0;
  return Math.round(Math.max(base * 1.28 + 180, base + 220));
}

function rotateLogIfNeeded(logPath, maxBytes = LOG_ROTATION_MAX_BYTES) {
  try {
    const st = fs.statSync(logPath);
    if (st.size > maxBytes) {
      try {
        fs.renameSync(logPath, logPath + ".1");
      } catch (renameErr) {
        try {
          fs.copyFileSync(logPath, logPath + ".1");
          fs.truncateSync(logPath, 0);
        } catch {}
      }
    }
  } catch {}
}

const PRESETS = [
  {
    id: "mlx-community/Octen-Embedding-4B-MLX-4bit",
    modelId: "mlx-community/Octen-Embedding-4B-MLX-4bit",
    label: "Octen Embedding 4B · 4-bit（最高质价比冠军）",
    shortLabel: "Octen 4B 4-bit",
    sizeMb: 2260,
    estRamMb: 2250,
    ceilingMb: 3060,
    dim: 2560,
    minRamGb: 32,
    idealRamTier: "flagship",
    tier: "flagship",
    tags: ["最高质价比冠军", "RTEB 76.8 (4B第1)", "代码81.2", "M3 Ultra ~10ms", "64G+旗舰首选"],
    desc: "最高质价比冠军 Octen Embedding 4B 4-bit：RTEB 76.8 (4B第1) · 代码81.2 · M3 Ultra ~10ms，约 2.26GB，64–128GB 机器 10+ 项目共享天花板",
    description: "最高质价比冠军 Octen Embedding 4B 4-bit：RTEB 76.8 (4B第1) · 代码81.2 · M3 Ultra ~10ms，约 2.26GB，64–128GB 机器 10+ 项目共享天花板",
    arch: "octen",
    mode: "mlx",
  },
  {
    id: "mlx-community/Qwen3-Embedding-4B-4bit-DWQ",
    modelId: "mlx-community/Qwen3-Embedding-4B-4bit-DWQ",
    label: "Qwen3 Embedding 4B · 4-bit DWQ (40亿参数旗舰)",
    shortLabel: "Qwen3 4B 4-bit",
    sizeMb: 2080,
    estRamMb: 2150,
    ceilingMb: 2932,
    dim: 2560,
    minRamGb: 64,
    idealRamTier: "flagship",
    tier: "flagship",
    tags: ["64G+旗舰首选", "40亿参数", "代码C-MTEB双冠"],
    desc: "40 亿参数跨代碾压小模型（Code 80.1 / 中文 72.3），约 2GB 显存，64–128GB 机器 10+ 项目共享天花板",
    description: "40 亿参数跨代碾压小模型（Code 80.1 / 中文 72.3），约 2GB 显存，64–128GB 机器 10+ 项目共享天花板",
    arch: "qwen3",
    mode: "mlx",
  },
  {
    id: "chulcher/Octen-Embedding-8B-mlx",
    modelId: "chulcher/Octen-Embedding-8B-mlx",
    label: "Octen Embedding 8B · MLX（8B极限档）",
    shortLabel: "Octen 8B MLX",
    sizeMb: 4430,
    estRamMb: 4480,
    ceilingMb: 5914,
    dim: 4096,
    minRamGb: 64,
    idealRamTier: "flagship",
    tier: "flagship",
    tags: ["8B极限档", "RTEB 80.5 开源第1", "64G+旗舰"],
    desc: "8B 极限档 Octen Embedding 8B MLX：RTEB 80.5 开源第1，4096 维，64GB+ 旗舰机专属",
    description: "8B 极限档 Octen Embedding 8B MLX：RTEB 80.5 开源第1，4096 维，64GB+ 旗舰机专属",
    arch: "octen",
    mode: "mlx",
  },
  {
    id: "mlx-community/Qwen3-Embedding-8B-4bit-DWQ",
    modelId: "mlx-community/Qwen3-Embedding-8B-4bit-DWQ",
    label: "Qwen3 Embedding 8B · 4-bit DWQ（8B极限档）",
    shortLabel: "Qwen3 8B 4-bit",
    sizeMb: 4150,
    estRamMb: 4300,
    ceilingMb: 5684,
    dim: 4096,
    minRamGb: 64,
    idealRamTier: "flagship",
    tier: "flagship",
    tags: ["8B极限档", "80亿参数", "64G+旗舰"],
    desc: "80 亿参数 Qwen3 8B 4-bit DWQ 极限档，4096 维，64GB+ 旗舰机专属",
    description: "80 亿参数 Qwen3 8B 4-bit DWQ 极限档，4096 维，64GB+ 旗舰机专属",
    arch: "qwen3",
    mode: "mlx",
  },
  {
    id: "Qwen/Qwen3-Embedding-0.6B",
    modelId: "Qwen/Qwen3-Embedding-0.6B",
    label: "Qwen3 Embedding 0.6B · BF16 (原生满血无损)",
    shortLabel: "Qwen3 0.6B BF16",
    sizeMb: 1150,
    estRamMb: 1200,
    ceilingMb: 1716,
    dim: 1024,
    minRamGb: 32,
    idealRamTier: "flagship",
    tags: ["严格<2GB最强", "BF16零量化损", "中文代码双优"],
    desc: "1.15 GB 原生 BF16 满血零量化损失，严格 2GB 以内精度最高的小钢炮",
    description: "1.15 GB 原生 BF16 满血零量化损失，严格 2GB 以内精度最高的小钢炮",
    arch: "qwen3",
    mode: "mlx",
  },
  {
    id: "mlx-community/bge-m3-mlx-fp16",
    modelId: "mlx-community/bge-m3-mlx-fp16",
    label: "BGE-M3 · FP16 (原生满血无损)",
    shortLabel: "BGE-M3 FP16",
    sizeMb: 1100,
    estRamMb: 1160,
    ceilingMb: 1665,
    dim: 1024,
    minRamGb: 32,
    idealRamTier: "workstation",
    tags: ["FP16无损", "双语标杆", "1.1GB"],
    desc: "1.1 GB 智源 BGE-M3 原生 FP16 满血无损版，稳健中英双语检索",
    description: "1.1 GB 智源 BGE-M3 原生 FP16 满血无损版，稳健中英双语检索",
    arch: "xlm-roberta",
    mode: "mlx",
  },
  {
    id: "mlx-community/Qwen3-Embedding-0.6B-8bit",
    modelId: "mlx-community/Qwen3-Embedding-0.6B-8bit",
    label: "Qwen3 Embedding 0.6B · 8-bit",
    shortLabel: "Qwen3 0.6B 8-bit",
    sizeMb: 604,
    estRamMb: 680,
    ceilingMb: 1050,
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
    ceilingMb: 666,
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
    ceilingMb: 1012,
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
    ceilingMb: 641,
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
    ceilingMb: 654,
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
    ceilingMb: 462,
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
    ceilingMb: 1012,
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
    ceilingMb: 500,
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
    ceilingMb: 615,
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
    label: "EmbeddingGemma 2 · 8-bit (Google 2026最新)",
    shortLabel: "Gemma 2 8-bit",
    sizeMb: 1177,
    estRamMb: 1220,
    ceilingMb: 1742,
    dim: 768,
    minRamGb: 32,
    idealRamTier: "workstation",
    tags: ["Google 2026最新", "代码极强 78.7", "图文音多模态"],
    desc: "Google 2026.10 力作：代码检索 78.7 超 Qwen-0.6B，原生多模态；中文纯向量偏弱（配合 FTS5 混合检索补齐）",
    description: "Google 2026.10 力作：代码检索 78.7 超 Qwen-0.6B，原生多模态；中文纯向量偏弱（配合 FTS5 混合检索补齐）",
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
    ceilingMb: 220,
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
const FLAGSHIP_4B_PREFERENCE = ["mlx-community/Octen-Embedding-4B-MLX-4bit", "mlx-community/Qwen3-Embedding-4B-4bit-DWQ"];
function recommendForRam(ramGb, cachedModelIds) {
  const overrides = {};
  if (ramGb != null && Number.isFinite(Number(ramGb))) overrides.totalRamGb = Number(ramGb);
  if (cachedModelIds != null) overrides.cachedModelIds = cachedModelIds;
  return detectHardwareProfile(overrides);
}
function detectHardwareProfile(overrides = {}) {
  const o = overrides && typeof overrides === "object" ? overrides : {};
  let totalRamGb;
  if (o.totalRamGb != null && Number.isFinite(Number(o.totalRamGb))) totalRamGb = Number(o.totalRamGb);
  else if (o.totalmem != null && Number.isFinite(Number(o.totalmem))) totalRamGb = Math.round(Number(o.totalmem) / (1024 ** 3));
  else totalRamGb = Math.round(os.totalmem() / (1024 ** 3));
  const chipModel = o.chipModel ? String(o.chipModel) : readChipModel();
  const cachedSet = o.cachedModelIds ? new Set(Array.from(o.cachedModelIds).map((v) => String(v))) : null;
  let tier;
  let primaryModelId;
  let secondaryModelIds;
  let recommendReason;
  if (totalRamGb >= 64) {
    tier = "flagship";
    // If a flagship 4B model is already cached, prefer the cached one for zero-download switch.
    let preferred = FLAGSHIP_4B_PREFERENCE[0];
    if (cachedSet && cachedSet.size > 0) {
      for (const cand of FLAGSHIP_4B_PREFERENCE) {
        if (cachedSet.has(cand)) { preferred = cand; break; }
      }
    }
    primaryModelId = preferred;
    const otherFlagship = FLAGSHIP_4B_PREFERENCE.find((id) => id !== preferred);
    secondaryModelIds = [otherFlagship, "Qwen/Qwen3-Embedding-0.6B", "mlx-community/Qwen3-Embedding-0.6B-8bit", "mlx-community/embeddinggemma-2-8bit"];
    recommendReason = `检测到 ${chipModel} · ${totalRamGb} GB 大内存旗舰机：首选最高质价比冠军 Octen-Embedding-4B-MLX-4bit（RTEB 76.8 (4B第1) · 代码81.2 · M3 Ultra ~10ms）或 Qwen3-Embedding-4B-4bit-DWQ（~2GB 显存）或严格 2GB 以内无损满血 Qwen3-0.6B-BF16（1.15GB），单进程共享支撑 10+ 项目并发`;
  } else if (totalRamGb >= 32) {
    tier = "workstation";
    primaryModelId = "mlx-community/Qwen3-Embedding-0.6B-8bit";
    secondaryModelIds = ["Qwen/Qwen3-Embedding-0.6B", "mlx-community/bge-m3-mlx-8bit"];
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
  if (preset.id === "mlx-community/Octen-Embedding-4B-MLX-4bit" && hw.tier === "flagship") return "旗舰顶配 · RTEB 76.8 (4B第1)";
  if (preset.id === "mlx-community/Qwen3-Embedding-4B-4bit-DWQ" && hw.tier === "flagship") return "旗舰顶配 · 40亿参数";
  if (preset.id === "chulcher/Octen-Embedding-8B-mlx") return "8B极限档 · RTEB 80.5";
  if (preset.id === "mlx-community/Qwen3-Embedding-8B-4bit-DWQ") return "8B极限档";
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
function resolveLocalModelPath(modelId, homeDir) {
  const expanded = modelId.startsWith("~/") ? path.join(homeDir, modelId.slice(2)) : modelId;
  if (path.isAbsolute(expanded) || modelId.startsWith("~/") || modelId.startsWith("./") || modelId.startsWith("../")) return expanded;
  try {
    if (fs.existsSync(expanded)) return expanded;
  } catch {}
  return null;
}
function validateModelId(modelId, homeDir) {
  if (typeof modelId !== "string" || !modelId.trim()) return { ok: false, error: "modelId required" };
  const v = modelId.trim();
  if (v === FTS_ID) return { ok: true, kind: "fts5", value: v };
  // Validation and cache lookup must agree even for existing org/repo-shaped paths.
  const localPath = resolveLocalModelPath(v, homeDir);
  if (localPath !== null) {
    try {
      if (fs.statSync(localPath).isDirectory()) return { ok: true, kind: "local", value: path.resolve(localPath) };
    } catch {}
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
  const localPath = resolveLocalModelPath(v, homeDir);
  function completeFileLocal(snapshot, name) {
    if (typeof name !== "string" || !name || path.isAbsolute(name) || name.split(/[\\/]/).includes("..")) return false;
    try {
      const file = path.join(snapshot, name);
      const real = fs.realpathSync(file);
      if (name.endsWith(".incomplete") || real.endsWith(".incomplete")) return false;
      const st = fs.statSync(real);
      return st.isFile() && st.size > 0;
    } catch { return false; }
  }
  function completeSnapshotLocal(snapshot) {
    if (!completeFileLocal(snapshot, "config.json")) return false;
    const index = path.join(snapshot, "model.safetensors.index.json");
    try {
      fs.lstatSync(index);
      if (!completeFileLocal(snapshot, "model.safetensors.index.json")) return false;
      const map = JSON.parse(fs.readFileSync(index, "utf8")).weight_map;
      if (!map || typeof map !== "object" || Array.isArray(map)) return false;
      const shards = [...new Set(Object.values(map))];
      return shards.length > 0 && shards.every((name) => completeFileLocal(snapshot, name));
    } catch (e) {
      if (e.code !== "ENOENT") return false;
    }
    return completeFileLocal(snapshot, "model.safetensors") || completeFileLocal(snapshot, "weights.npz");
  }
  if (localPath !== null) {
    try {
      if (!fs.statSync(localPath).isDirectory()) return false;
    } catch {
      return false;
    }
    return completeSnapshotLocal(localPath);
  }
  const dir = path.join(cacheDir, "models--" + v.replace(/\//g, "--"));
  function completeFile(snapshot, name) {
    if (typeof name !== "string" || !name || path.isAbsolute(name) || name.split(/[\\/]/).includes("..")) return false;
    try {
      const file = path.join(snapshot, name);
      const real = fs.realpathSync(file);
      if (name.endsWith(".incomplete") || real.endsWith(".incomplete")) return false;
      const st = fs.statSync(real);
      return st.isFile() && st.size > 0;
    } catch { return false; }
  }
  function completeSnapshot(snapshot) {
    if (!completeFile(snapshot, "config.json")) return false;
    const index = path.join(snapshot, "model.safetensors.index.json");
    // A broken index must not fall back to a single (possibly stale) weight file.
    try {
      fs.lstatSync(index);
      if (!completeFile(snapshot, "model.safetensors.index.json")) return false;
      const map = JSON.parse(fs.readFileSync(index, "utf8")).weight_map;
      if (!map || typeof map !== "object" || Array.isArray(map)) return false;
      const shards = [...new Set(Object.values(map))];
      return shards.length > 0 && shards.every((name) => completeFile(snapshot, name));
    } catch (e) {
      if (e.code !== "ENOENT") return false;
    }
    return completeFile(snapshot, "model.safetensors") || completeFile(snapshot, "weights.npz");
  }
  const snapshots = path.join(dir, "snapshots");
  try {
    const main = fs.readFileSync(path.join(dir, "refs", "main"), "utf8").trim();
    if (!main || !/^[A-Za-z0-9._-]+$/.test(main) || main === "..") return false;
    // A known main revision is authoritative; never start a stale snapshot while
    // that revision's required shards are still being downloaded.
    return completeSnapshot(path.join(snapshots, main));
  } catch (e) {
    if (e.code !== "ENOENT") return false;
  }
  try {
    return fs.readdirSync(snapshots).some((rev) => completeSnapshot(path.join(snapshots, rev)));
  } catch { return false; }
}

function escapePlistXml(str) {
  const s = String(str == null ? "" : str);
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(s)) {
    throw new Error("escapePlistXml: XML 1.0 illegal control character");
  }
  return s
    .replace(/&/g, () => "&amp;")
    .replace(/</g, () => "&lt;")
    .replace(/>/g, () => "&gt;")
    .replace(/"/g, () => "&quot;")
    .replace(/'/g, () => "&apos;");
}
function unescapePlistXml(str) {
  let s = String(str == null ? "" : str);
  s = s.replace(/&apos;/g, () => "'");
  s = s.replace(/&quot;/g, () => '"');
  s = s.replace(/&gt;/g, () => ">");
  s = s.replace(/&lt;/g, () => "<");
  s = s.replace(/&amp;/g, () => "&");
  return s;
}
// A small, non-resolving plist XML reader. Offsets let us patch only the intended
// dictionary values, preserving unrelated launchd fields and comments verbatim.
function parsePlistXml(xml) {
  const s = String(xml);
  try {
    const validChar = (n) => n === 9 || n === 10 || n === 13 ||
      (n >= 0x20 && n <= 0xd7ff) || (n >= 0xe000 && n <= 0xfffd) || (n >= 0x10000 && n <= 0x10ffff);
    if ([...s].some((c) => !validChar(c.codePointAt(0)))) return null;
    function decode(text) {
      if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/.test(text) || text.includes("]]>")) throw new Error("invalid XML text");
      return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, entity) => {
        if (entity[0] !== "#") return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[entity];
        const n = entity[1] === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
        if (!validChar(n)) throw new Error("invalid XML character reference");
        return String.fromCodePoint(n);
      });
    }
    const tokens = /<!--[\s\S]*?-->|<\?xml\s+[\s\S]*?\?>|<!DOCTYPE[^>]*>|<[^>]*>|[^<]+/gy;
    const stack = [];
    let root = null, pos = 0, declaration = false, doctype = false;
    for (let match; (match = tokens.exec(s));) {
      if (match.index !== pos) return null;
      const token = match[0], start = pos;
      pos += token.length;
      if (token.startsWith("<!--")) {
        if (token.slice(4, -3).includes("--") || token.slice(4, -3).endsWith("-")) return null;
        continue;
      }
      if (token.startsWith("<?xml")) {
        if ((start !== 0 && !(start === 1 && s[0] === "\uFEFF")) || declaration || root || !/^<\?xml\s+version\s*=\s*(?:"1\.0"|'1\.0')(?:\s+encoding\s*=\s*(?:"[A-Za-z][A-Za-z0-9._-]*"|'[A-Za-z][A-Za-z0-9._-]*'))?(?:\s+standalone\s*=\s*(?:"(?:yes|no)"|'(?:yes|no)'))?\s*\?>$/.test(token)) return null;
        declaration = true;
        continue;
      }
      if (token.startsWith("<!DOCTYPE")) {
        // No internal subsets/custom entities or external resource resolution.
        if (doctype || root || !/^<!DOCTYPE\s+plist(?:\s+PUBLIC\s+(?:"[^"<>]*"|'[^'<>]*')\s+(?:"[^"<>]*"|'[^'<>]*')|\s+SYSTEM\s+(?:"[^"<>]*"|'[^'<>]*'))?\s*>$/.test(token)) return null;
        doctype = true;
        continue;
      }
      if (!token.startsWith("<")) {
        if (!stack.length) { if (token.trim()) return null; }
        else stack[stack.length - 1].text += decode(token);
        continue;
      }
      const tag = token.match(/^<(\/?)([A-Za-z]+)([^<>]*?)(\/?)>$/);
      if (!tag) return null;
      const [, closing, name, attrs, selfClosing] = tag;
      if (closing) {
        const node = stack.pop();
        if (!node || node.tag !== name || attrs.trim() || selfClosing) return null;
        node.closeStart = start;
        node.end = pos;
      } else {
        if (name === "plist" ? !/^\s+version\s*=\s*(?:"1\.0"|'1\.0')\s*$|^\s*$/.test(attrs) : attrs.trim()) return null;
        const node = { tag: name, start, openEnd: pos, closeStart: pos, end: pos, children: [], text: "", selfClosing: !!selfClosing };
        if (stack.length) stack[stack.length - 1].children.push(node);
        else { if (root) return null; root = node; }
        if (!selfClosing) stack.push(node);
      }
    }
    if (pos !== s.length || stack.length || !root || root.tag !== "plist" || root.children.length !== 1) return null;
    function validate(node) {
      const { tag, children, text } = node;
      if (["plist", "dict", "array"].includes(tag)) {
        if (text.trim()) return false;
        if (tag === "dict") {
          if (children.length % 2) return false;
          const keys = new Set();
          for (let i = 0; i < children.length; i += 2) {
            const key = children[i];
            if (key.tag !== "key" || keys.has(key.text) || children[i + 1].tag === "key") return false;
            keys.add(key.text);
          }
        } else if (children.some((n) => n.tag === "key" || n.tag === "plist")) return false;
        return children.every((n) => n.tag !== "plist" && validate(n));
      }
      if (children.length) return false;
      if (["string", "key"].includes(tag)) return true;
      if (["true", "false"].includes(tag)) return !text.trim();
      if (tag === "integer") return /^[+-]?\d+$/.test(text.trim());
      if (tag === "real") return /^(?:[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[+-]?inf|nan)$/i.test(text.trim());
      if (tag === "data") return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text.replace(/\s/g, ""));
      if (tag === "date") return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(text.trim());
      return false;
    }
    return validate(root) ? root : null;
  } catch { return null; }
}
function isPlistXmlWellFormed(xml) {
  return parsePlistXml(xml) !== null;
}
function plistDictValue(dict, key) {
  for (let i = 0; i < dict.children.length; i += 2) {
    if (dict.children[i].text === key) return dict.children[i + 1];
  }
  return null;
}
function patchPlistDict(xml, dict, updates) {
  const edits = [];
  let added = "";
  for (const [key, value] of Object.entries(updates)) {
    const existing = plistDictValue(dict, key);
    if (existing) edits.push({ start: existing.start, end: existing.end, value });
    else added += "<key>" + key + "</key>" + value;
  }
  if (dict.selfClosing) return "<dict>" + added + "</dict>";
  edits.push({ start: dict.closeStart, end: dict.closeStart, value: added });
  let result = xml.slice(dict.start, dict.end);
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    const start = edit.start - dict.start, end = edit.end - dict.start;
    result = result.slice(0, start) + edit.value + result.slice(end);
  }
  return result;
}
function validatePlistXmlFile(tmpPath) {
  let content;
  try { content = fs.readFileSync(tmpPath, "utf8"); } catch { return false; }
  if (!isPlistXmlWellFormed(content)) return false;
  try {
    const r = spawnSync("/usr/bin/plutil", ["-lint", "-s", tmpPath], { encoding: "utf8", timeout: 3000 });
    if (r && r.error && r.error.code === "ENOENT" && process.platform !== "darwin") return true;
    return !!r && r.error == null && r.status === 0 && !r.signal;
  } catch { return false; }
}
function defaultLaunchAgentPlistPath(homeDir) {
  return path.join(homeDir, "Library", "LaunchAgents", "com.t3tools.powercontext-embed.plist");
}
function prepareLaunchAgentPlistFile(plistPath, { modelId, servedName, keepAlive } = {}) {
  let xml;
  try {
    xml = fs.readFileSync(plistPath, "utf8");
  } catch {
    return { ok: false, plistPath, tmpPath: null };
  }
  let next;
  try {
    const root = parsePlistXml(xml);
    const dict = root && root.children[0];
    if (!dict || dict.tag !== "dict") throw new Error("missing top-level dictionary");
    const updates = {}, envUpdates = { HF_HUB_DISABLE_XET: "<string>1</string>" };
    if (modelId != null && modelId !== "") envUpdates.EMBED_MODEL = "<string>" + escapePlistXml(modelId) + "</string>";
    if (servedName != null && servedName !== "") envUpdates.EMBED_NAME = "<string>" + escapePlistXml(servedName) + "</string>";
    const env = plistDictValue(dict, "EnvironmentVariables");
    if (env && env.tag !== "dict") throw new Error("invalid EnvironmentVariables dictionary");
    updates.EnvironmentVariables = env ? patchPlistDict(xml, env, envUpdates) :
      "<dict>" + Object.entries(envUpdates).map(([key, value]) => "<key>" + key + "</key>" + value).join("") + "</dict>";
    if (keepAlive != null) updates.KeepAlive = keepAlive ? "<true/>" : "<false/>";
    next = xml.slice(0, dict.start) + patchPlistDict(xml, dict, updates) + xml.slice(dict.end);
    // Assert actual scoped values, not a regex match in a comment/nested dict.
    const checked = parsePlistXml(next);
    const nextDict = checked && checked.children[0];
    const nextEnv = nextDict && plistDictValue(nextDict, "EnvironmentVariables");
    if (!nextEnv || nextEnv.tag !== "dict") throw new Error("missing environment");
    for (const [key, value] of Object.entries(envUpdates)) {
      const field = plistDictValue(nextEnv, key);
      if (!field || next.slice(field.start, field.end) !== value) throw new Error("missing " + key);
    }
    if (keepAlive != null && plistDictValue(nextDict, "KeepAlive")?.tag !== (keepAlive ? "true" : "false")) throw new Error("missing KeepAlive");
  } catch {
    return { ok: false, plistPath, tmpPath: null };
  }
  const tmpPath = plistPath + ".tmp-" + process.pid;
  try {
    fs.writeFileSync(tmpPath, next, "utf8");
  } catch {
    try { fs.unlinkSync(tmpPath); } catch {}
    return { ok: false, plistPath, tmpPath: null };
  }
  if (!validatePlistXmlFile(tmpPath)) {
    try { fs.unlinkSync(tmpPath); } catch {}
    return { ok: false, plistPath, tmpPath: null };
  }
  return { ok: true, plistPath, tmpPath };
}
function commitLaunchAgentPlistFile(prepared) {
  if (!prepared || !prepared.ok || !prepared.tmpPath || !prepared.plistPath) return false;
  const { plistPath, tmpPath } = prepared;
  try {
    fs.renameSync(tmpPath, plistPath);
    return true;
  } catch {
    return false;
  } finally {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
  }
}
function discardLaunchAgentPlistFile(prepared) {
  if (!prepared || !prepared.tmpPath) return;
  try { fs.unlinkSync(prepared.tmpPath); } catch {}
}
function updateLaunchAgentPlistFile(plistPath, patch = {}) {
  const prepared = prepareLaunchAgentPlistFile(plistPath, patch);
  if (!prepared.ok) return false;
  return commitLaunchAgentPlistFile(prepared);
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
  let activeDownload = null;
  let switchGeneration = 0;
  let service = null;
  let restartTimer = null;
  let restartAttempts = [];
  let lastError = null;
  let closed = false;
  let embeddingTestInFlight = null;
  const readyTimers = new Set();
  const killTimers = new Map();

  function isCurrent(gen, modelId) {
    if (closed || gen !== switchGeneration || modelId === FTS_ID || modelId === "fts5-only") return false;
    const cfg = readConfig();
    return cfg.mode === "mlx" && cfg.modelId === modelId;
  }
  function clearReadyTimers() {
    for (const timer of readyTimers) clearInterval(timer);
    readyTimers.clear();
  }
  function terminateChild(child) {
    if (!child || child.exitCode != null || child.signalCode != null || killTimers.has(child)) return;
    try { child.kill("SIGTERM"); } catch {}
    if (child.exitCode != null || child.signalCode != null) return;
    const timer = setTimeout(() => {
      killTimers.delete(child);
      if (child.exitCode == null && child.signalCode == null) {
        try { child.kill("SIGKILL"); } catch {}
      }
    }, 2000);
    timer.unref();
    killTimers.set(child, timer);
    const clear = () => {
      clearTimeout(timer);
      killTimers.delete(child);
    };
    child.once("exit", clear);
    child.once("close", clear);
  }
  function cancelActiveDownload() {
    const record = activeDownload;
    if (!record) return;
    activeDownload = null;
    clearInterval(record.poll);
    record.job.cancelled = true;
    record.job.active = false;
    record.job.status = "cancelled";
    record.job.statusText = "下载已取消";
    terminateChild(record.child);
  }
  function invalidateWork() {
    switchGeneration += 1;
    cancelActiveDownload();
    clearReadyTimers();
    clearTimeout(restartTimer);
    restartTimer = null;
    return switchGeneration;
  }
  function removePid(child) {
    try {
      if (String(fs.readFileSync(pidPath, "utf8")).trim() === String(child.pid)) fs.unlinkSync(pidPath);
    } catch {}
  }
  function scheduleRestart(gen, modelId, useMirror) {
    if (!isCurrent(gen, modelId) || restartTimer) return;
    restartAttempts = restartAttempts.filter((at) => Date.now() - at < 60000);
    if (restartAttempts.length >= 3) {
      lastError = "向量服务自愈重启超过 60 秒内 3 次，已停止自动重启";
      return;
    }
    const delay = Math.min(15000, 1000 * 2 ** restartAttempts.length);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (!isCurrent(gen, modelId)) return;
      // launchd may already have replaced the exited process. Do not compete.
      if (healthSync()) return;
      try {
        const listener = spawnSync("lsof", ["-ti", "TCP:" + port, "-sTCP:LISTEN"], { encoding: "utf8", timeout: 1500 });
        if (String(listener.stdout || "").trim()) return;
      } catch {}
      restartAttempts.push(Date.now());
      try { startServer(modelId, useMirror, gen); }
      catch (e) {
        if (isCurrent(gen, modelId)) lastError = "向量服务重启失败：" + e.message;
      }
    }, delay);
    restartTimer.unref();
  }

  function runLaunchctl(args) {
    if (_launchctl) {
      try { return _launchctl(args); } catch (error) { return { status: 1, error }; }
    }
    try {
      const r = spawnSync("launchctl", args, { encoding: "utf8", timeout: 4000 });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr, error: r.error, signal: r.signal };
    } catch (error) {
      return { status: 1, error };
    }
  }
  function hasLaunchAgentPlist() {
    if (!launchAgentPlistPath) return false;
    try {
      return fs.statSync(launchAgentPlistPath).isFile();
    } catch { return false; }
  }
  function syncLaunchAgentPlist(patch = {}) {
    if (!hasLaunchAgentPlist()) return false;
    return updateLaunchAgentPlistFile(launchAgentPlistPath, patch);
  }
  function prepareLaunchAgentPlist(patch = {}) {
    if (!hasLaunchAgentPlist()) return { ok: false, plistPath: launchAgentPlistPath, tmpPath: null };
    return prepareLaunchAgentPlistFile(launchAgentPlistPath, patch);
  }
  function commitLaunchAgentPlist(prepared) {
    return commitLaunchAgentPlistFile(prepared);
  }
  function launchctlUid() {
    try { if (typeof process.getuid === "function") return process.getuid(); } catch {}
    try { return os.userInfo().uid; } catch { return 501; }
  }
  function launchdServiceTarget() {
    let label = path.basename(launchAgentPlistPath, ".plist");
    try {
      const match = fs.readFileSync(launchAgentPlistPath, "utf8").match(/<key>Label<\/key>\s*<string>([^<]+)<\/string>/);
      if (match) label = unescapePlistXml(match[1]);
    } catch {}
    return "gui/" + launchctlUid() + "/" + label;
  }
  function launchdStartError(reason) {
    lastError = "launchd 启动失败：" + reason;
    return new Error(lastError);
  }
  function restoreOriginalLaunchAgent() {
    try {
      const boot = runLaunchctl(["bootstrap", "gui/" + launchctlUid(), launchAgentPlistPath]);
      const bCode = boot && (boot.status ?? boot.code);
      if (boot && !boot.error && !boot.signal && (boot.ok === true || bCode === 0)) return { restored: true };
      const kick = runLaunchctl(["kickstart", "-k", launchdServiceTarget()]);
      const kCode = kick && (kick.status ?? kick.code);
      if (kick && !kick.error && !kick.signal && (kick.ok === true || kCode === 0)) return { restored: true };
      return { restored: false, detail: String(bCode ?? kCode ?? "unknown") };
    } catch (err) {
      return { restored: false, detail: err && err.message ? err.message : String(err) };
    }
  }
  function replaceLaunchAgentPlist(patch) {
    const prepared = prepareLaunchAgentPlist(patch);
    if (!prepared.ok) throw launchdStartError("无法准备 LaunchAgent plist");
    try {
      // bootout must still see the original plist AND original config. Only a
      // success or an explicit already-unloaded result permits the atomic rename.
      const result = runLaunchctl(["bootout", "gui/" + launchctlUid(), launchAgentPlistPath]);
      const code = result && (result.status ?? result.code);
      const output = result ? String(result.stdout || "") + "\n" + String(result.stderr || "") : "";
      const absent = code === 3 || code === 113 || /\b(?:ESRCH|No such process|Could not find specified service|service is disabled)\b/i.test(output);
      const permissionError = /\b(?:EACCES|EPERM|permission denied|operation not permitted)\b/i.test(output);
      if (!result || result.error || result.signal || permissionError || !(result.ok === true || code === 0 || absent)) {
        throw launchdStartError("bootout 失败，保留原配置与 plist（" + (code ?? "unknown") + "）");
      }
      let committed = false;
      try { committed = Boolean(commitLaunchAgentPlist(prepared)); } catch {}
      if (!committed) {
        if (!absent) {
          const recovery = restoreOriginalLaunchAgent();
          if (!recovery.restored) {
            throw launchdStartError("无法提交 LaunchAgent plist，且恢复原服务失败（" + recovery.detail + "）");
          }
          throw launchdStartError("无法提交 LaunchAgent plist（已恢复原 launchd 服务）");
        }
        throw launchdStartError("无法提交 LaunchAgent plist");
      }
    } finally {
      discardLaunchAgentPlistFile(prepared);
    }
  }
  function kickstartLaunchd(modelId) {
    const kick = runLaunchctl(["kickstart", "-k", launchdServiceTarget()]);
    if (kick && kick.status === 0) return;
    const health = healthSync();
    if (!health || (health.modelId || health.model_id) !== modelId) {
      throw launchdStartError("kickstart 未成功，目标模型未就绪");
    }
  }
  function bootstrapLaunchd(modelId) {
    const boot = runLaunchctl(["bootstrap", "gui/" + launchctlUid(), launchAgentPlistPath]);
    if (boot && boot.status === 0) return false;
    // bootstrap can fail because bootout left the job loaded. launchd remains
    // authoritative regardless of either command's exit status.
    runLaunchctl(["print", launchdServiceTarget()]);
    kickstartLaunchd(modelId);
    return true;
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
  async function runEmbeddingTest() {
    const started = Date.now();
    const config = readConfig();
    const ftsMode = config.mode === "fts5" || config.mode === "fts5-only" || config.modelId === FTS_ID || config.modelId === "fts5-only";
    let modelId = null;
    let stage = "health";
    const controller = new AbortController();
    const timeoutMs = Number.isFinite(opts._probeTimeoutMs) ? Math.max(1, Math.min(30000, opts._probeTimeoutMs)) : 12000;
    const probeFetch = typeof opts._fetch === "function" ? opts._fetch : (...args) => globalThis.fetch(...args);
    const failure = (error) => {
      const messages = {
        fts_unavailable: "当前为全文搜索模式，且本机没有运行中的向量服务。",
        service_unavailable: "本机向量服务不可用或尚未就绪。",
        invalid_response: "向量服务返回了无效结果。",
        model_changed: "测试期间向量模型发生变化，请重试。",
        timeout: "向量连通性测试超时。",
        manager_closed: "向量管理器已关闭。",
      };
      return { ok: false, modelId, dimensions: null, latencyMs: Math.max(0, Date.now() - started), error, message: messages[error] };
    };
    const fail = (code) => { const err = new Error(code); err.probeCode = code; throw err; };
    const readProbeJson = async (response) => {
      const maxBytes = 2 * 1024 * 1024;
      const declared = Number(response.headers?.get?.("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) fail("invalid_response");
      if (!response.body || typeof response.body[Symbol.asyncIterator] !== "function") return response.json();
      const chunks = [];
      let length = 0;
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > maxBytes) fail("invalid_response");
        chunks.push(Buffer.from(chunk));
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    };
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        const error = new Error("timeout");
        error.probeCode = "timeout";
        reject(error);
      }, timeoutMs);
    });
    try {
      if (closed) return failure("manager_closed");
      return await Promise.race([deadline, (async () => {
        const base = `http://127.0.0.1:${port}`;
        const healthResponse = await probeFetch(`${base}/health`, { signal: controller.signal });
        if (controller.signal.aborted) fail("timeout");
        if (!healthResponse?.ok) fail(ftsMode ? "fts_unavailable" : "service_unavailable");
        const health = await readProbeJson(healthResponse);
        if (controller.signal.aborted) fail("timeout");
        if (!health || (health.ok !== true && health.status !== "ok")) fail(ftsMode ? "fts_unavailable" : "service_unavailable");
        const liveId = health.modelId || health.model_id;
        if (typeof liveId !== "string" || !liveId.trim() || liveId === FTS_ID) fail("invalid_response");
        modelId = liveId.trim();
        if (closed) fail("manager_closed");
        stage = "embedding";
        const response = await probeFetch(`${base}/v1/embeddings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input: ["T3 Hub embedding connectivity test."], input_type: "query" }),
          signal: controller.signal,
        });
        if (controller.signal.aborted) fail("timeout");
        if (!response?.ok) fail("service_unavailable");
        const data = await readProbeJson(response);
        if (controller.signal.aborted) fail("timeout");
        if (!data || typeof data.model !== "string" || !data.model.trim() || !Array.isArray(data.data) || data.data.length !== 1) fail("invalid_response");
        const servedName = health.servedName || health.served_name || health.model;
        if (typeof servedName === "string" && servedName && data.model !== servedName) fail("model_changed");
        const item = data.data[0];
        const vec = item?.embedding;
        if ((item?.index != null && item.index !== 0) || !Array.isArray(vec) || vec.length === 0 || vec.length > 65536 || !vec.every((x) => typeof x === "number" && Number.isFinite(x)) || !vec.some((x) => x !== 0)) fail("invalid_response");
        if (Number.isInteger(health.dim) && health.dim > 0 && vec.length !== health.dim) fail("invalid_response");
        return { ok: true, modelId, dimensions: vec.length, latencyMs: Math.max(0, Date.now() - started) };
      })()]);
    } catch (err) {
      if (controller.signal.aborted || err?.probeCode === "timeout") return failure("timeout");
      if (err?.probeCode) return failure(err.probeCode);
      return failure(stage === "health" ? (ftsMode ? "fts_unavailable" : "service_unavailable") : (err instanceof SyntaxError ? "invalid_response" : "service_unavailable"));
    } finally {
      clearTimeout(timer);
    }
  }
  function testEmbedding() {
    if (embeddingTestInFlight) return embeddingTestInFlight;
    const current = runEmbeddingTest();
    embeddingTestInFlight = current;
    current.finally(() => { if (embeddingTestInFlight === current) embeddingTestInFlight = null; });
    return current;
  }
  function stopServer() {
    invalidateWork();
    if (service) {
      service.stoppedIntentionally = true;
      terminateChild(service.child);
      service = null;
    }
    try {
      if (fs.existsSync(pidPath)) {
        const pid = Number(String(fs.readFileSync(pidPath, "utf8")).trim());
        if (Number.isFinite(pid) && pid > 0) safeKillPid(pid);
        try { fs.unlinkSync(pidPath); } catch {}
      }
    } catch {}
    try {
      const r = spawnSync("lsof", ["-ti", "TCP:" + port, "-sTCP:LISTEN"], { encoding: "utf8", timeout: 1500 });
      for (const line of String(r.stdout || "").split("\n")) {
        const pid = Number(line.trim());
        if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) safeKillPid(pid);
      }
    } catch {}
  }
  function startServer(modelId, useMirror, gen = switchGeneration) {
    if (!isCurrent(gen, modelId)) return null;
    if (hasLaunchAgentPlist()) throw launchdStartError("服务由 launchd 托管，禁止独立启动");
    safeMkdir(path.dirname(logPath));
    safeMkdir(path.dirname(pidPath));
    rotateLogIfNeeded(logPath);
    const served = String(modelId).split("/").pop();
    const env = { ...process.env, EMBED_MODEL: String(modelId), EMBED_NAME: served, PORT: String(port), EMBED_CACHE_LIMIT_MB: "256", HF_HUB_DISABLE_XET: "1", HF_HUB_CACHE: cacheDir };
    if (useMirror) env.HF_ENDPOINT = "https://hf-mirror.com";
    const py = fs.existsSync(pythonPath) ? pythonPath : "python3";
    const out = fs.openSync(logPath, "a");
    let child;
    try {
      child = spawn(py, [embedServerPath], { env, detached: true, stdio: ["ignore", out, out] });
    } catch (e) {
      if (isCurrent(gen, modelId)) lastError = "向量服务启动失败：" + e.message;
      throw e;
    } finally {
      fs.closeSync(out);
    }
    const record = { child, gen, modelId, useMirror, stoppedIntentionally: false, ended: false };
    service = record;
    // Bind immediately: spawn failures such as ENOENT are asynchronous.
    child.on("error", (e) => {
      record.ended = true;
      if (!isCurrent(record.gen, record.modelId) || record.stoppedIntentionally) return;
      if (service === record) service = null;
      removePid(child);
      clearReadyTimers();
      lastError = "向量服务启动失败：" + (e.message || String(e));
    });
    const exited = (code, signal) => {
      if (record.ended) return;
      record.ended = true;
      if (!isCurrent(record.gen, record.modelId) || record.stoppedIntentionally) return;
      if (service === record) service = null;
      removePid(child);
      clearReadyTimers();
      lastError = "向量服务意外退出（" + (signal || code) + "），等待自愈重启";
      scheduleRestart(record.gen, record.modelId, record.useMirror);
    };
    child.on("exit", exited);
    child.on("close", exited);
    child.unref();
    if (child.pid) fs.writeFileSync(pidPath, String(child.pid) + "\n", "utf8");
    return child.pid;
  }
  function waitReady(onReady, tries = 60, gen = switchGeneration, modelId = readConfig().modelId, onTimeout = null) {
    let n = 0;
    const timer = setInterval(() => {
      const current = isCurrent(gen, modelId);
      const health = current ? healthSync() : null;
      n += 1;
      const ready = health && (health.modelId || health.model_id) === modelId;
      if (!current || ready || n >= tries) {
        clearInterval(timer);
        readyTimers.delete(timer);
        if (current && ready && typeof onReady === "function") {
          try { onReady(); } catch {}
        } else if (current && !ready && n >= tries && typeof onTimeout === "function") {
          try { onTimeout(); } catch {}
        }
      }
    }, 500);
    readyTimers.add(timer);
    timer.unref();
    return timer;
  }
  function startTarget(modelId, useMirror, gen) {
    if (!isCurrent(gen, modelId)) return;
    if (hasLaunchAgentPlist()) {
      if (!syncLaunchAgentPlist({ modelId, servedName: String(modelId).split("/").pop(), keepAlive: true })) {
        throw launchdStartError("无法更新 LaunchAgent plist");
      }
      bootstrapLaunchd(modelId);
      return true;
    }
    startServer(modelId, useMirror, gen);
    return false;
  }
  function startDownload(modelId, useMirror, onReadyReindex, gen = switchGeneration) {
    const preset = PRESETS.find((p) => p.modelId === modelId);
    const expectedMb = preset && preset.sizeMb > 0 ? preset.sizeMb : 300;
    const job = { active: true, cancelled: false, status: "downloading", modelId, downloadedMb: 0, percent: 0, statusText: "准备下载 " + modelId };
    downloadJob = job;
    const record = { job, child: null, poll: null, settled: false };
    activeDownload = record;
    const current = () => !job.cancelled && activeDownload === record && isCurrent(gen, modelId);
    const fail = (e) => {
      if (!current() || record.settled) return;
      record.settled = true;
      clearInterval(record.poll);
      activeDownload = null;
      lastError = "模型下载失败：" + (e.message || String(e));
      Object.assign(job, { active: false, status: "failed", lastError, statusText: lastError });
    };
    const py = fs.existsSync(pythonPath) ? pythonPath : "python3";
    const env = { ...process.env, HF_HUB_DISABLE_XET: "1", HF_HUB_CACHE: cacheDir };
    if (useMirror) env.HF_ENDPOINT = "https://hf-mirror.com";
    const code = "import os,sys\nos.environ.setdefault('HF_HUB_DISABLE_XET','1')\nfrom huggingface_hub import snapshot_download\nprint(snapshot_download(repo_id=sys.argv[1]), flush=True)\n";
    let child;
    try {
      child = spawn(py, ["-c", code, String(modelId)], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      record.child = child;
      child.on("error", fail);
    } catch (e) {
      fail(e);
      return job;
    }
    let stderr = "";
    if (child.stdout) child.stdout.resume();
    if (child.stderr) child.stderr.on("data", (data) => {
      if (current()) stderr = (stderr + String(data)).slice(-2000);
    });
    record.poll = setInterval(() => {
      if (!current()) { clearInterval(record.poll); return; }
      const mb = Math.round(blobBytes(modelId, cacheDir) / 1024 / 1024 * 10) / 10;
      Object.assign(job, { downloadedMb: mb, percent: Math.min(99, Math.round(mb / expectedMb * 100)), statusText: "下载中 " + mb + "/" + expectedMb + " MB" });
    }, 1000);
    record.poll.unref();
    // exit catches nonzero failures immediately; close means pipes are drained.
    child.on("exit", (code, signal) => {
      if (code !== 0) fail(new Error("snapshot_download exit=" + code + (signal ? " signal=" + signal : "") + ": " + stderr));
    });
    child.on("close", (code, signal) => {
      if (!current() || record.settled) return;
      if (code !== 0) { fail(new Error("snapshot_download exit=" + code + " signal=" + signal + ": " + stderr)); return; }
      if (!isModelCached(modelId, cacheDir, homeDir)) { fail(new Error("snapshot_download exited 0 but snapshot/config/weights are incomplete")); return; }
      record.settled = true;
      clearInterval(record.poll);
      activeDownload = null;
      Object.assign(job, { active: false, status: "completed", percent: 100, statusText: "下载完成，正在启动向量服务" });
      try {
        const launchdManaged = startTarget(modelId, useMirror, gen);
        waitReady(onReadyReindex, 60, gen, modelId, launchdManaged ? () => {
          launchdStartError("等待目标模型就绪超时");
          Object.assign(job, { status: "failed", lastError, statusText: lastError });
        } : null);
      } catch (e) {
        if (isCurrent(gen, modelId)) {
          lastError = "向量服务启动失败：" + e.message;
          Object.assign(job, { status: "failed", lastError, statusText: lastError });
        }
      }
    });
    child.unref();
    return job;
  }
  function close() {
    if (closed) return;
    invalidateWork();
    closed = true;
    if (service) {
      service.stoppedIntentionally = true;
      terminateChild(service.child);
      removePid(service.child);
      service = null;
    }
    // Final disposal must not leave supervision/pipe handles behind. Only kill
    // children owned by this manager, never an unrelated port or daemon.
    for (const [child, timer] of killTimers) {
      clearTimeout(timer);
      if (child.exitCode == null && child.signalCode == null) {
        try { child.kill("SIGKILL"); } catch {}
      }
      if (child.stdout) child.stdout.destroy();
      if (child.stderr) child.stderr.destroy();
    }
    killTimers.clear();
  }
  function getStatus() {
    const cfg = readConfig();
    const health = healthSync();
    const running = Boolean(health);
    let rssMb = 0;
    let processRssMb = 0;
    let baseActiveMb = 0;
    let ceilingMb = 0;
    let cacheMb = 0;
    let cacheLimitMb = 0;
    let autoTrimmedCount = 0;
    if (running) {
      const activeRaw = health.activeMb != null ? health.activeMb : health.active_mb;
      const activeNum = Number(activeRaw);
      let rawRss;
      if (Number.isFinite(activeNum) && activeNum > 0) rawRss = activeNum;
      else rawRss = health.rssMb ?? health.rss_mb;
      rssMb = Number.isFinite(Number(rawRss)) ? Math.round(Number(rawRss) * 10) / 10 : 0;
      const procRaw = health.processRssMb ?? health.rssMb ?? health.rss_mb;
      processRssMb = Number.isFinite(Number(procRaw)) ? Math.round(Number(procRaw) * 10) / 10 : rssMb;
      const numOrZero = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 10) / 10 : 0);
      const intOrZero = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
      baseActiveMb = numOrZero(health.baseActiveMb != null ? health.baseActiveMb : health.base_active_mb);
      ceilingMb = numOrZero(health.ceilingMb != null ? health.ceilingMb : health.ceiling_mb);
      cacheMb = numOrZero(health.cacheMb != null ? health.cacheMb : health.cache_mb);
      cacheLimitMb = numOrZero(health.cacheLimitMb != null ? health.cacheLimitMb : health.cache_limit_mb);
      autoTrimmedCount = intOrZero(health.autoTrimmedCount != null ? health.autoTrimmedCount : health.auto_trimmed_count);
    }
    let mode = cfg.mode || "fts5";
    const hmRaw = running ? (health.modelId || health.model_id) : null;
    const hm = hmRaw ? String(hmRaw).trim() || null : null;
    let activeModelId;
    if (running && hm) {
      activeModelId = hm;
      mode = "mlx";
    } else {
      activeModelId = cfg.modelId || cfg.customModelId || (mode === "fts5" ? FTS_ID : PRESETS[0].modelId);
    }
    const configuredModelId = cfg.modelId || null;
    const switching = Boolean(running && hm && cfg.modelId && cfg.mode === "mlx" && hm !== cfg.modelId);
    let hwOverrides = hardwareOverrides;
    if (hwOverrides && hwOverrides.cachedModelIds == null) {
      try {
        const cachedFlagships = FLAGSHIP_4B_PREFERENCE.filter((id) => isModelCached(id, cacheDir, homeDir));
        hwOverrides = { ...hwOverrides, cachedModelIds: cachedFlagships };
      } catch {
        hwOverrides = { ...hwOverrides, cachedModelIds: [] };
      }
    }
    const hw = detectHardwareProfile(hwOverrides);
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
      configuredModelId,
      switching,
      running,
      rssMb,
      processRssMb,
      baseActiveMb,
      ceilingMb,
      cacheMb,
      cacheLimitMb,
      autoTrimmedCount,
      port,
      hardware,
      presets,
      customModelId: cfg.customModelId || null,
      useMirror: Boolean(cfg.useMirror),
      downloadJob,
      lastError,
    };
  }
  function switchModel(args = {}) {
    try {
      if (closed) return { ok: false, error: "embed manager is closed" };
      // Pre-validation: 0 side effects on illegal requests. Must stay before invalidateWork.
      const rawMode = args.mode ? String(args.mode) : null;
      const modelIdRaw = args.modelId ? String(args.modelId) : args.customModelId ? String(args.customModelId) : null;
      const customModelId = args.customModelId ? String(args.customModelId) : null;
      const useMirror = Boolean(args.useMirror);
      const onReadyReindex = typeof args.onReadyReindex === "function" ? args.onReadyReindex : null;
      const isFtsRequest = rawMode === "fts5" || rawMode === "fts5-only" || modelIdRaw === FTS_ID || modelIdRaw === "fts5-only";
      let effective = null;
      if (!isFtsRequest) {
        if (!modelIdRaw || !String(modelIdRaw).trim()) return { ok: false, error: "modelId required" };
        const v = validateModelId(modelIdRaw, homeDir);
        if (!v.ok) return { ok: false, error: v.error };
        effective = v.value;
        if (v.kind === "local" && !isModelCached(effective, cacheDir, homeDir)) {
          return { ok: false, error: "local model directory is incomplete (requires config.json and complete weights): " + effective };
        }
        // Already-ready fast path: avoid invalidating a healthy service.
        try {
          const health = healthSync();
          const cfgForCheck = readConfig();
          const hm = health ? String(health.modelId || health.model_id || "").trim() || null : null;
          if (health && hm === effective && cfgForCheck.mode === "mlx" && cfgForCheck.modelId === effective) {
            return { ok: true, mode: "mlx", activeModelId: effective, switched: false, alreadyReady: true, port };
          }
        } catch {}
      }
      const cached = !isFtsRequest && isModelCached(effective, cacheDir, homeDir);
      const launchdManaged = hasLaunchAgentPlist();
      if (launchdManaged) {
        // Prepare -> checked bootout -> rename is the precondition for changing
        // config or cancelling work. Any failure leaves those original states intact.
        replaceLaunchAgentPlist(isFtsRequest ? { keepAlive: false } : {
          modelId: effective, servedName: String(effective).split("/").pop(), keepAlive: cached,
        });
      }
      invalidateWork();
      restartAttempts = [];
      lastError = null;
      if (isFtsRequest) {
        writeConfig({ mode: "fts5", modelId: FTS_ID, customModelId: customModelId || null, useMirror });
        stopServer();
        downloadJob = null;
        return { ok: true, mode: "fts5", activeModelId: FTS_ID, running: false, rssMb: 0, port };
      }
      const isPreset = PRESETS.some((p) => p.modelId === effective);
      writeConfig({ mode: "mlx", modelId: effective, customModelId: customModelId || (isPreset ? null : effective), useMirror });
      // bootstrap must observe the committed plist and the newly persisted config.
      let launchdKicked = false;
      if (launchdManaged && cached) launchdKicked = bootstrapLaunchd(effective);
      if (!cached) {
        stopServer();
        const job = startDownload(effective, useMirror, onReadyReindex);
        return { ok: true, mode: "mlx", activeModelId: effective, downloading: true, downloadJob: job, port };
      }
      // launchd-managed cached switch: strict mutual exclusion, never spawn.
      if (launchdManaged) {
        const tryHotSwitch = () => {
          try {
            const url = "http://127.0.0.1:" + port + "/admin/switch-model";
            const res = spawnSync(
              "curl",
              ["-s", "-m", "60", "--connect-timeout", "2", "-X", "POST", url, "-H", "Content-Type: application/json", "-d", JSON.stringify({ modelId: effective, useMirror })],
              { encoding: "utf8", timeout: 65000 }
            );
            if (!res.error && res.status === 0 && res.stdout) {
              const j = JSON.parse(res.stdout);
              if (j && j.ok === true) return true;
            }
          } catch {}
          return false;
        };
        if (tryHotSwitch()) {
          if (service && !service.ended) {
            service.gen = switchGeneration;
            service.modelId = effective;
            service.useMirror = useMirror;
          }
          waitReady(() => {
            try {
              if (onReadyReindex) onReadyReindex();
            } catch {}
          }, 10, switchGeneration, effective, () => { launchdStartError("等待目标模型就绪超时"); });
          return { ok: true, mode: "mlx", activeModelId: effective, switched: true, port, launchdManaged: true };
        }
        // Slow start / not listening: kickstart the launchd instance and wait for health, never spawn.
        if (!launchdKicked) kickstartLaunchd(effective);
        waitReady(() => {
          try {
            if (onReadyReindex) onReadyReindex();
          } catch {}
        }, 60, switchGeneration, effective, () => { launchdStartError("等待目标模型就绪超时"); });
        return { ok: true, mode: "mlx", activeModelId: effective, switched: false, port, launchdManaged: true };
      }
      // Cached (or local folder): try in-process hot switch first, else restart independent process.
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
        if (service && !service.ended) {
          service.gen = switchGeneration;
          service.modelId = effective;
          service.useMirror = useMirror;
        }
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
    testEmbedding,
    stopServer,
    close,
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
function testEmbedding() {
  return getDefaultEmbedManager().testEmbedding();
}
function switchModel(a) {
  return getDefaultEmbedManager().switchModel(a || {});
}
module.exports = {
  createEmbedManager,
  getDefaultEmbedManager,
  getStatus,
  testEmbedding,
  switchModel,
  validateModelId,
  detectHardwareProfile,
  recommendForRam,
  updateLaunchAgentPlistFile,
  prepareLaunchAgentPlistFile,
  commitLaunchAgentPlistFile,
  discardLaunchAgentPlistFile,
  defaultLaunchAgentPlistPath,
  escapePlistXml,
  unescapePlistXml,
  isPlistXmlWellFormed,
  isModelCached: (id, cacheDir, homeDir) => isModelCached(id, cacheDir || path.join(homeDir || process.env.HOME || os.homedir(), ".cache", "huggingface", "hub"), homeDir || process.env.HOME || os.homedir()),
  rotateLogIfNeeded,
  ceilingMbFor,
  PRESETS,
  FLAGSHIP_4B_PREFERENCE,
  FTS_ID,
  DEFAULT_PORT,
  LOG_ROTATION_MAX_BYTES,
  default: getDefaultEmbedManager(),
};
