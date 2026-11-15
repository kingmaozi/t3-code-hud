"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function safeMkdir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function dirExists(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function fileExists(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function lstatSafe(p) { try { return fs.lstatSync(p); } catch { return null; } }
function readJsonFile(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function writeJsonFileAtomic(file, obj) {
  safeMkdir(path.dirname(file));
  const tmp = file + ".tmp-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}
function writeTextAtomic(file, text) {
  safeMkdir(path.dirname(file));
  const tmp = file + ".tmp-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}
function slugify(raw) {
  let s = String(raw ?? "").trim();
  if (!s) return "project";
  s = s.replace(/[\/\\\0-\x1f\x7f]/g, "-");
  s = s.replace(/\s+/g, "-");
  s = s.replace(/[^\p{L}\p{N}_-]/gu, "");
  s = s.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  return s || "project";
}
function slugFromProjectRoot(projectRoot) {
  try {
    const resolved = path.resolve(String(projectRoot));
    const base = path.basename(resolved) || resolved;
    return slugify(base);
  } catch { return "project"; }
}
function assertSafeSubagentId(id) {
  if (typeof id !== "string") throw new Error("invalid skill id");
  if (id === "." || id === "..") throw new Error("invalid skill id");
  if (id.includes("\0") || id.includes("/") || id.includes("\\")) throw new Error("invalid skill id");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)) throw new Error("invalid skill id");
  if (id.includes("..")) throw new Error("invalid skill id");
}
function assertContained(parentDir, childPath) {
  const parent = path.resolve(String(parentDir));
  const child = path.resolve(String(childPath));
  if (!child.startsWith(parent + path.sep)) throw new Error("invalid skill id: path escapes parent");
}

// ---------------------------------------------------------------------------
// Model catalog
// ---------------------------------------------------------------------------
const COMMON_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"];
const ANTIGRAVITY_EFFORTS = ["low", "medium", "high", "xhigh"];
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultrathink"];

const MUSE_DEFAULT_MODELS = ["muse-ember-1.0", "muse-spark-1.3", "muse-wonder-1.0", "muse-wonder-full-1.0", "muse-spark-1.2"];
const CODEX_DEFAULT_MODELS = ["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-astra", "gpt-6-luna"];
const ANTIGRAVITY_MODELS = ["gemini-4-carbon", "gemini-4-hydrogen", "gemini-4-argon", "gemini-3.8-flash", "claude-opus-5-5", "claude-sonnet-5-5"];
const CLAUDE_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-2", "claude-haiku-5-5"];

function collectMuseModels(homeDir) {
  const baseDir = path.join(homeDir, "Library", "Application Support", "muse", "model-catalog");
  const found = new Set(MUSE_DEFAULT_MODELS);
  try {
    if (!dirExists(baseDir)) return [...found];
    // Try to discover JSON files that list models.
    let entries = [];
    try { entries = fs.readdirSync(baseDir, { withFileTypes: true }); } catch { entries = []; }
    for (const ent of entries) {
      const full = path.join(baseDir, ent.name);
      if (!ent.isFile()) continue;
      if (!ent.name.endsWith(".json")) continue;
      try {
        const raw = fs.readFileSync(full, "utf8");
        const data = JSON.parse(raw);
        const candidates = [];
        if (Array.isArray(data)) candidates.push(...data);
        else if (data && typeof data === "object") {
          if (Array.isArray(data.models)) candidates.push(...data.models);
          if (Array.isArray(data)) candidates.push(...data);
          for (const v of Object.values(data)) {
            if (typeof v === "string" && /^muse-/i.test(v)) candidates.push(v);
          }
        }
        for (const c of candidates) {
          if (typeof c === "string" && c.trim()) found.add(c.trim());
          else if (c && typeof c === "object") {
            const id = c.id || c.slug || c.model || c.name;
            if (typeof id === "string" && id.trim()) found.add(id.trim());
          }
        }
      } catch {}
    }
  } catch {}
  return [...found];
}

function collectCodexModels(homeDir) {
  const found = new Set(CODEX_DEFAULT_MODELS);
  const cachePath = path.join(homeDir, ".codex", "models_cache.json");
  try {
    if (fileExists(cachePath)) {
      const raw = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      const arr = raw && Array.isArray(raw.models) ? raw.models : [];
      for (const m of arr) {
        const slug = m && (m.slug || m.id || m.model);
        if (typeof slug === "string" && slug.trim()) found.add(slug.trim());
      }
    }
  } catch {}
  return [...found];
}

function collectPiModels(homeDir) {
  const found = new Set();
  const piPath = path.join(homeDir, ".pi", "agent", "models.json");
  try {
    if (fileExists(piPath)) {
      const raw = JSON.parse(fs.readFileSync(piPath, "utf8"));
      const mag = raw && raw.providers && raw.providers.magpie ? raw.providers.magpie : null;
      const models = mag && Array.isArray(mag.models) ? mag.models : [];
      for (const m of models) {
        const id = m && m.id;
        if (typeof id === "string" && id.trim()) {
          const clean = id.trim();
          found.add(clean.startsWith("magpie/") ? clean : "magpie/" + clean);
        }
      }
    }
  } catch {}
  // Expected prefixes from spec: magpie/group/1m, magpie/group/code, magpie/group/262k, magpie/auto/deepseek-v4.1-flash, magpie/auto/claude-haiku-5-5
  // Keep whatever we found; if file missing, provide those seeds so slash discovery still works.
  if (found.size === 0) {
    return [
      "magpie/group/1m",
      "magpie/group/code",
      "magpie/group/262k",
      "magpie/auto/deepseek-v4.1-flash",
      "magpie/auto/claude-haiku-5-5",
    ];
  }
  return [...found];
}

function listModelCatalog(homeDir) {
  const hd = homeDir || process.env.HOME || os.homedir();
  const museModels = collectMuseModels(hd);
  const codexModels = collectCodexModels(hd);
  const piModels = collectPiModels(hd);
  return {
    muse: { label: "Muse Code", models: museModels, efforts: [...COMMON_EFFORTS] },
    codex: { label: "Codex", models: codexModels, efforts: [...COMMON_EFFORTS] },
    pi: { label: "Pi · Magpie", models: piModels, efforts: [...COMMON_EFFORTS] },
    antigravity: { label: "Antigravity", models: [...ANTIGRAVITY_MODELS], efforts: [...ANTIGRAVITY_EFFORTS] },
    claudeAgent: { label: "Claude Code", models: [...CLAUDE_MODELS], efforts: [...CLAUDE_EFFORTS] },
  };
}

const DEFAULT_SUBAGENTS = [
  {
    id: "explorer",
    name: "explorer",
    role: "research",
    toolBadge: "只读调查",
    providerInstanceId: "muse",
    model: "muse-ember-1.0",
    effort: "max",
    description: "只读阅读、查找代码、梳理调用链与排查故障证据，不修改代码",
    systemPrompt: "你作为只读调查子代理（explorer），专注于阅读源码、检索调用链、核查日志与配置证据。严格只读，不修改业务代码；汇报时明确区分“已确认事实”与“待验证假设”。",
    enabled: true,
    builtin: true,
  },
  {
    id: "worker",
    name: "worker",
    role: "implementation",
    toolBadge: "全部工具",
    providerInstanceId: "muse",
    model: "muse-ember-1.0",
    effort: "max",
    description: "范围明确的功能开发、Bug 修复、配套测试与校验闭环",
    systemPrompt: "你作为研发执行子代理（worker），在划定的文件边界内完成功能实现或缺陷修复，必须编写并运行对应测试确认转绿后再回传精简结论与修改位置。",
    enabled: true,
    builtin: true,
  },
  {
    id: "default",
    name: "default",
    role: "general",
    toolBadge: "通用工具",
    providerInstanceId: "muse",
    model: "muse-ember-1.0",
    effort: "max",
    description: "资料整理、对照需求查漏、跨信息综合分析与通用独立任务",
    systemPrompt: "你作为通用协助子代理（default），负责资料归纳、需求核对与跨源信息整理，输出结构清晰、结论先行。",
    enabled: true,
    builtin: true,
  },
  {
    id: "worker-pro",
    name: "worker-pro",
    role: "implementation",
    toolBadge: "高难攻关",
    providerInstanceId: "codex",
    model: "gpt-6.1-sol",
    effort: "xhigh",
    description: "worker 两次未果升级接管，或跨 3+ 模块核心契约与复杂架构攻关",
    systemPrompt: "你作为高难攻关子代理（worker-pro），负责解决跨模块复杂契约、并发状态机或疑难根因，先定位根因不变量再做最小可靠修复并完成回归验证。",
    enabled: true,
    builtin: true,
  },
  {
    id: "frontend",
    name: "frontend",
    role: "design",
    toolBadge: "界面+截图",
    providerInstanceId: "codex",
    model: "gpt-6.1-sol",
    effort: "max",
    description: "前端界面、交互动效、主题适配与桌面+窄屏真实渲染核验",
    systemPrompt: "你作为前端设计子代理（frontend），负责高品味界面实现、深浅主题适配与响应式布局，交付前必须完成桌面端与窄屏真实渲染核验，确保零溢出。",
    enabled: true,
    builtin: true,
  },
  {
    id: "qa",
    name: "qa",
    role: "test",
    toolBadge: "LCU+测试",
    providerInstanceId: "codex",
    model: "gpt-6.1-terra",
    effort: "max",
    description: "边界/并发难测用例、LCU 桌面电脑操控测试与发布前核验（不改业务源码）",
    systemPrompt: "你作为测试与核验子代理（qa），负责编写边界/并发回归测试、执行桌面操控（LCU）真实交互验证与发布前检查，严禁直接修改业务源码。",
    enabled: true,
    builtin: true,
  },
  {
    id: "code-review",
    name: "code-review",
    role: "review",
    toolBadge: "只读审查",
    providerInstanceId: "codex",
    model: "gpt-6.1-terra",
    effort: "high",
    description: "独立只读代码审查与发布前终审，仅报告高置信度真实缺陷",
    systemPrompt: "你作为独立只读审查子代理（code-review），严格只读审查变更代码与关联上下文，仅报告 confidence >= 80 的逻辑缺陷、安全漏洞、并发风险或回归隐患。",
    enabled: true,
    builtin: true,
  },
].map((item, index) => ({ ...item,
  memoryPolicy: ["explorer", "code-review"].includes(item.id) ? "readonly" : "readwrite",
  avatarColor: ["teal", "blue", "indigo", "pink", "amber", "cyan", "violet"][index],
}));

const MEMORY_POLICIES = ["readwrite", "readonly", "off"];
const AVATAR_COLORS = ["teal", "blue", "indigo", "pink", "amber", "cyan", "violet"];
function normalizeMemory(item) {
  return { ...item,
    memoryPolicy: MEMORY_POLICIES.includes(item.memoryPolicy) ? item.memoryPolicy : (["explorer", "code-review"].includes(item.id) ? "readonly" : "readwrite"),
    avatarColor: AVATAR_COLORS.includes(item.avatarColor) ? item.avatarColor : (DEFAULT_SUBAGENTS.find(d => d.id === item.id)?.avatarColor || "teal"),
  };
}
function memoryInstruction(item) {
  const policy = normalizeMemory(item).memoryPolicy;
  if (policy === "readonly") return "第一现场记忆联动：开工先调用 memory_search，只读检索，不调用 memory_write、不写记忆库。";
  if (policy === "off") return "记忆策略 off：本子任务不调用 memory_search 或 memory_write。";
  return "第一现场记忆联动：开工先调用 memory_search 检索项目规则与踩坑；收尾交差前，对已验证的非平凡根因或持久约束，借当前 100% 热缓存调用 memory_write 落盘，不记录猜测、秘密或流水账。";
}
function configItems(raw, withMemory = true) {
  const items = Array.isArray(raw) ? raw : raw?.items || raw?.subagents || [];
  return Array.isArray(items) ? items.filter(i => i && typeof i === "object" && (i.id || i.name)).map(i => {
    const item = { ...i, id: String(i.id || i.name), name: String(i.name || i.id) };
    return withMemory ? normalizeMemory(item) : item;
  }) : [];
}

const VALID_PROVIDERS = ["muse", "codex", "pi", "antigravity", "claudeAgent"];
const VALID_ROLES = ["research", "implementation", "general", "design", "test", "review"];

function optionsForSubagent(item) {
  const prov = item.providerInstanceId;
  const eff = item.effort;
  if (prov === "pi") return { thinking: eff };
  if (prov === "antigravity") return { thinking_level: eff };
  if (prov === "claudeAgent") return { effort: eff };
  return { reasoningEffort: eff };
}

function createSubagentsManager(opts = {}) {
  const homeDir = opts.homeDir || process.env.HOME || os.homedir();
  const hubDir = opts.hubDir || process.env.T3_HUB_DIR || path.join(homeDir, ".t3", "hub");
  const globalPath = opts.globalPath || path.join(hubDir, "subagents.json");
  const projectDir = opts.projectSubagentsDir || path.join(hubDir, "project-subagents");
  const globalAgentsMdPath = opts.globalAgentsMdPath || path.join(hubDir, "global-AGENTS.md");
  const claudeAgentsRoot = opts.claudeAgentsRoot || path.join(homeDir, ".claude", "agents");

  function readGlobal() {
    if (!fileExists(globalPath)) {
      safeMkdir(path.dirname(globalPath));
      writeJsonFileAtomic(globalPath, DEFAULT_SUBAGENTS.map((d) => ({ ...d })));
      return DEFAULT_SUBAGENTS.map((d) => ({ ...d }));
    }
    const raw = readJsonFile(globalPath, null);
    if (Array.isArray(raw)) {
      // Normalize to ensure id/name alignment.
      const norm = raw.map((it) => {
        if (!it || typeof it !== "object") return null;
        const id = it.id || it.name;
        if (!id) return null;
        return { ...it, id: String(id), name: String(it.name || id), builtin: Boolean(it.builtin), enabled: it.enabled !== false };
      }).filter(Boolean);
      if (norm.length === 0) {
        writeJsonFileAtomic(globalPath, DEFAULT_SUBAGENTS.map((d) => ({ ...d })));
        return DEFAULT_SUBAGENTS.map((d) => ({ ...d }));
      }
      return norm.map(normalizeMemory);
    }
    if (raw && typeof raw === "object") {
      const arr = Array.isArray(raw.items) ? raw.items : Array.isArray(raw.subagents) ? raw.subagents : null;
      if (arr) {
        const norm = arr.map((it) => {
          if (!it || typeof it !== "object") return null;
          const id = it.id || it.name;
          if (!id) return null;
          return { ...it, id: String(id), name: String(it.name || id), builtin: Boolean(it.builtin), enabled: it.enabled !== false };
        }).filter(Boolean);
        if (norm.length) return norm.map(normalizeMemory);
      }
      if (Object.keys(raw).length === 0) {
        writeJsonFileAtomic(globalPath, DEFAULT_SUBAGENTS.map((d) => ({ ...d })));
        return DEFAULT_SUBAGENTS.map((d) => ({ ...d }));
      }
    }
    writeJsonFileAtomic(globalPath, DEFAULT_SUBAGENTS.map((d) => ({ ...d })));
    return DEFAULT_SUBAGENTS.map((d) => ({ ...d }));
  }
  function writeGlobal(items) {
    writeJsonFileAtomic(globalPath, items);
  }
  function projectPathFor(projectRoot) {
    const p = path.join(projectDir, slugFromProjectRoot(projectRoot) + ".json");
    assertContained(projectDir, p);
    return p;
  }
  function readProject(projectRoot) {
    if (!projectRoot) return [];
    const p = projectPathFor(projectRoot);
    if (!fileExists(p)) return [];
    const raw = readJsonFile(p, []);
    if (Array.isArray(raw)) {
      return raw.map((it) => {
        if (!it || typeof it !== "object") return null;
        const id = it.id || it.name;
        if (!id) return null;
        return { ...it, id: String(id), name: String(it.name || id), enabled: it.enabled !== false, overridesGlobal: it.overridesGlobal !== false };
      }).filter(Boolean).map(normalizeMemory);
    }
    if (raw && typeof raw === "object" && Array.isArray(raw.items)) {
      return configItems(raw).map(it => ({ ...it, enabled: it.enabled !== false, overridesGlobal: it.overridesGlobal !== false }));
    }
    return [];
  }
  function writeProject(projectRoot, items) {
    const p = projectPathFor(projectRoot);
    safeMkdir(path.dirname(p));
    writeJsonFileAtomic(p, items);
  }

  function validateItem(item, catalog) {
    if (!item || typeof item !== "object") throw new Error("item required");
    const id = String(item.id || item.name || "").trim();
    if (!id) throw new Error("item.id or item.name required");
    assertSafeSubagentId(id);
    const prov = String(item.providerInstanceId || "").trim();
    if (!VALID_PROVIDERS.includes(prov)) throw new Error("invalid providerInstanceId: " + prov);
    const model = String(item.model || "").trim();
    if (!model) throw new Error("model required");
    const effort = String(item.effort || "").trim();
    if (!effort) throw new Error("effort required");
    const allowed = catalog[prov]?.efforts || COMMON_EFFORTS;
    if (!allowed.includes(effort)) throw new Error(`invalid effort ${effort} for ${prov}, allowed: ${allowed.join(",")}`);
    const role = item.role ? String(item.role).trim() : "";
    if (role && !VALID_ROLES.includes(role)) {
      // Allow but warn? Strict: reject unknown role to catch typos.
      throw new Error("invalid role: " + role);
    }
    if (!MEMORY_POLICIES.includes(item.memoryPolicy)) throw new Error("invalid memoryPolicy");
    if (!AVATAR_COLORS.includes(item.avatarColor)) throw new Error("invalid avatarColor");
    if (item.systemPrompt != null && typeof item.systemPrompt !== "string") throw new Error("systemPrompt must be string");
    if (item.description != null && typeof item.description !== "string") throw new Error("description must be string");
  }

  function projectSlug(projectRoot) {
    return slugFromProjectRoot(projectRoot);
  }

  function buildEffective(globalItems, projectItems) {
    const globalEnabled = globalItems.filter((i) => i.enabled !== false);
    const projectEnabled = projectItems.filter((i) => i.enabled !== false);
    const map = new Map();
    for (const g of globalEnabled) {
      if (!map.has(g.id)) map.set(g.id, { ...g, _from: "global" });
    }
    for (const p of projectEnabled) {
      const existing = map.get(p.id);
      if (p.overridesGlobal && existing) {
        map.set(p.id, { ...existing, ...p, _from: "project-override" });
      } else if (!existing) {
        // Project-only new agent (no global with same id, or override of disabled global).
        // If global has same id but disabled, and p.overridesGlobal, still treat as override.
        const gAll = globalItems.find((g) => g.id === p.id);
        if (gAll && !p.overridesGlobal) {
          // Collision without override flag → treat as distinct project agent but keep global hidden?
          // For safety, allow project-only with same id only when overridesGlobal true; otherwise skip.
          continue;
        }
        map.set(p.id, { ...p, _from: p.overridesGlobal ? "project-override" : "project" });
      }
      // If existing and p.overridesGlobal false, keep global.
    }
    // Include disabled project overrides that hide a global? If project has disabled override for global id, hide it.
    for (const p of projectItems.filter((i) => i.enabled === false)) {
      if (p.overridesGlobal && map.has(p.id)) {
        map.delete(p.id);
      }
    }
    return [...map.values()].sort((a, b) => a.id.localeCompare(b.id)).map(({ _from, ...rest }) => rest);
  }

  // Injection helpers
  const GLOBAL_START = "<!-- t3-hub-subagents:start -->";
  const GLOBAL_END = "<!-- t3-hub-subagents:end -->";
  const PROJECT_START = "<!-- t3-hub-project-subagents:start -->";
  const PROJECT_END = "<!-- t3-hub-project-subagents:end -->";

  function renderBlock(items, isProject) {
    const enabled = items.filter((i) => i.enabled !== false).slice().sort((a, b) => a.id.localeCompare(b.id));
    const start = isProject ? PROJECT_START : GLOBAL_START;
    const end = isProject ? PROJECT_END : GLOBAL_END;
    const lines = [];
    lines.push(start);
    lines.push("## 子智能体路由与系统提示词 (T3 Hub Sub-Agents)" + (isProject ? " · 项目" : " · 全局"));
    lines.push("派发任何子智能体前，若会话较长或用户刚调整过配置，优先以 ~/.t3/hub/subagents.json（及项目覆盖配置）中的实时模型与思考强度为准；可调用 resolveSubagentRoute 查询，PreToolUse 路由守卫会在派单时重新读取磁盘。");
    lines.push("");
    lines.push("| id | role | providerInstanceId | model | options | description |");
    lines.push("|---|---|---|---|---|---|");
    for (const it of enabled) {
      const opts = JSON.stringify(optionsForSubagent(it));
      const desc = String(it.description || "").replace(/\|/g, "\\|").replace(/\n/g, " ");
      lines.push(`| ${it.id} | ${it.role || ""} | ${it.providerInstanceId} | ${it.model} | \`${opts}\` | ${desc} |`);
    }
    lines.push("");
    for (const it of enabled) {
      lines.push(`### ${it.id}`);
      lines.push(`- role: \`${it.role || ""}\``);
      lines.push(`- target: \`{ providerInstanceId: "${it.providerInstanceId}", model: "${it.model}", options: ${JSON.stringify(optionsForSubagent(it))} }\``);
      lines.push(`- toolBadge: ${it.toolBadge || ""}`);
      if (it.description) lines.push(`- description: ${String(it.description).replace(/\n/g, " ")}`);
      lines.push(`- memoryPolicy: ${normalizeMemory(it).memoryPolicy}`);
      lines.push(`- systemPrompt: >`);
      lines.push("  > " + memoryInstruction(it));
      if (it.systemPrompt) {
        for (const l of String(it.systemPrompt).split("\n")) lines.push("  > " + l);
      }
      lines.push("");
    }
    lines.push("When dispatching via `delegate_task`, always use the exact `target` (`providerInstanceId`, `model`, `options`) resolved from the current disk configuration (the table above is a snapshot) and prepend the configured `systemPrompt` to the task.");
    lines.push(end);
    return lines.join("\n") + "\n";
  }

  function backupOnce(file) {
    const bak = file + ".bak-t3hub";
    if (fileExists(file) && !fileExists(bak)) {
      try { fs.copyFileSync(file, bak); } catch {}
    }
  }

  function injectIntoFile(filePath, block, startMarker, endMarker) {
    safeMkdir(path.dirname(filePath));
    let existing = "";
    if (fileExists(filePath)) {
      try { existing = fs.readFileSync(filePath, "utf8"); } catch { existing = ""; }
    }
    backupOnce(filePath);
    const sIdx = existing.indexOf(startMarker);
    const eIdx = existing.indexOf(endMarker);
    let next = "";
    if (sIdx !== -1 && eIdx !== -1 && eIdx > sIdx) {
      const before = existing.slice(0, sIdx);
      let after = existing.slice(eIdx + endMarker.length);
      // The block already ends with a trailing "\n"; consume the one
      // newline it contributed so repeated saves stay byte-identical.
      if (after.startsWith("\r\n")) after = after.slice(2);
      else if (after.startsWith("\n")) after = after.slice(1);
      next = before + block + after;
    } else {
      next = (existing.trim() ? existing.replace(/\s+$/, "") + "\n\n" : "") + block;
    }
    // Avoid churn if already identical
    if (next === existing) return { changed: false };
    writeTextAtomic(filePath, next);
    return { changed: true };
  }

  function resolveExcludePath(projectRoot) {
    if (!projectRoot || !dirExists(projectRoot)) return null;
    const gitPath = path.join(projectRoot, ".git");
    const st = lstatSafe(gitPath);
    if (!st) return null;
    if (st.isDirectory()) return path.join(gitPath, "info", "exclude");
    if (st.isFile()) {
      try {
        const content = fs.readFileSync(gitPath, "utf8").trim();
        const m = content.match(/^gitdir:\s*(.+)$/m);
        if (m) {
          let gd = m[1].trim();
          if (!path.isAbsolute(gd)) gd = path.resolve(path.dirname(gitPath), gd);
          return path.join(gd, "info", "exclude");
        }
      } catch {}
    }
    return null;
  }
  function ensureExcludeEntry(projectRoot, entry) {
    const excl = resolveExcludePath(projectRoot);
    if (!excl) return;
    safeMkdir(path.dirname(excl));
    let existing = "";
    try { existing = fs.readFileSync(excl, "utf8"); } catch {}
    const lines = existing.split(/\r?\n/);
    if (!lines.includes(entry)) {
      lines.push(entry);
      const out = lines.join("\n").replace(/\n+$/, "") + "\n";
      writeTextAtomic(excl, out);
    }
  }
  function removeExcludeEntry(projectRoot, entry) {
    const excl = resolveExcludePath(projectRoot);
    if (!excl) return;
    let existing = "";
    try { existing = fs.readFileSync(excl, "utf8"); } catch { return; }
    if (!existing.includes(entry)) return;
    const lines = existing.split(/\r?\n/).filter((l) => l !== entry);
    const out = lines.join("\n").replace(/\n+$/, "") + (existing.endsWith("\n") ? "\n" : "");
    writeTextAtomic(excl, out);
  }

  function writeClaudeAgentFile(dir, item) {
    assertSafeSubagentId(String(item.id));
    const file = path.join(dir, item.id + ".md");
    assertContained(dir, file);
    safeMkdir(dir);
    const fm = `---\nname: ${item.id}\ndescription: ${String(item.description || item.id).replace(/^["']|["']$/g, "").replace(/\n/g, " ")}\n---\n\n${item.systemPrompt || ""}\n\n${memoryInstruction(item)}\n`;
    writeTextAtomic(file, fm);
    return file;
  }
  function removeClaudeAgentFile(dir, id) {
    assertSafeSubagentId(String(id));
    const file = path.join(dir, id + ".md");
    assertContained(dir, file);
    try { if (fileExists(file)) fs.unlinkSync(file); } catch {}
  }

  function injectGlobal(allGlobal, extraSyncPaths = opts.extraSyncPaths || []) {
    const block = renderBlock(allGlobal, false);
    injectIntoFile(globalAgentsMdPath, block, GLOBAL_START, GLOBAL_END);
    const targets = [
      path.join(homeDir, ".codex", "AGENTS.md"),
      path.join(homeDir, ".pi", "agent", "AGENTS.md"),
      path.join(homeDir, ".config", "muse", "AGENTS.md"),
      path.join(homeDir, ".claude", "CLAUDE.md"),
    ];
    if (!Array.isArray(extraSyncPaths) || extraSyncPaths.some(p => typeof p !== "string" || !path.isAbsolute(p))) throw new Error("extraSyncPaths must contain absolute file paths");
    const extras = extraSyncPaths.map(p => path.resolve(p));
    for (const t of new Set([...targets, ...extras])) {
      // Sync only when parent dir exists (like hub-skills), to avoid creating stray dirs on fresh systems.
      // But still sync if file already exists regardless.
      if (extras.includes(t) || fileExists(t) || dirExists(path.dirname(t))) {
        injectIntoFile(t, block, GLOBAL_START, GLOBAL_END);
      }
    }
    // Also sync to .claude/agents for enabled globals
    const enabled = allGlobal.filter((i) => i.enabled !== false);
    safeMkdir(claudeAgentsRoot);
    for (const it of enabled) writeClaudeAgentFile(claudeAgentsRoot, it);
    // Clean up disabled/removed agents that had files but now disabled.
    try {
      const existingFiles = fs.readdirSync(claudeAgentsRoot).filter((f) => f.endsWith(".md"));
      const enabledIds = new Set(enabled.map((i) => i.id));
      for (const f of existingFiles) {
        const id = f.slice(0, -3);
        // Only remove files that look Hub-managed (contain subagent frontmatter) and no longer enabled.
        // We remove if id was previously a builtin or if file is ours. Conservative: if id not in enabled and file contains "<!-- t3-hub" or "name:" we still track.
        // For correctness, remove files for ids that were previously written (we had them before).
        // Here we only remove when id matches a known builtin or previously tracked.
        // Simplest: if id not in enabledIds and file was created by Hub (check for "t3-hub" or known seed), remove.
        // To avoid deleting user agents, only remove if id is in DEFAULT set or file contains systemPrompt of that id.
        // We'll remove when id is not enabled and its file would be Hub-managed: check DEFAULT ids.
        const isDefault = DEFAULT_SUBAGENTS.some((d) => d.id === id);
        if (!enabledIds.has(id) && isDefault) {
          removeClaudeAgentFile(claudeAgentsRoot, id);
        }
      }
    } catch {}
    return block;
  }

  function injectProject(projectRoot, allProjectItems, globalItems) {
    // Effective project items for block: enabled project items + overrides applied? Spec says project block rendered from effective.
    // We render from project-scoped effective: use projectItems (enabled) as source for the project block, since global block already covers globals.
    // However spec says "Also write <projectRoot>/.claude/agents/<id>.md" for enabled global subagents when global, and for project we write for enabled project agents.
    // For project AGENTS.md block, use enabled project items (projectItems enabled) to keep it project-specific.
    const block = renderBlock(allProjectItems, true);
    const agentsMdPath = path.join(projectRoot, "AGENTS.md");
    injectIntoFile(agentsMdPath, block, PROJECT_START, PROJECT_END);
    const claudeAgentsDir = path.join(projectRoot, ".claude", "agents");
    const enabled = allProjectItems.filter((i) => i.enabled !== false);
    safeMkdir(claudeAgentsDir);
    for (const it of enabled) {
      writeClaudeAgentFile(claudeAgentsDir, it);
      ensureExcludeEntry(projectRoot, `.claude/agents/${it.id}.md`);
    }
    // Remove disabled/deleted project agents
    try {
      const enabledIds = new Set(enabled.map((i) => i.id));
      const existing = dirExists(claudeAgentsDir) ? fs.readdirSync(claudeAgentsDir).filter((f) => f.endsWith(".md")) : [];
      for (const f of existing) {
        const id = f.slice(0, -3);
        if (!enabledIds.has(id)) {
          // Remove file only if its id was in projectItems (disabled/deleted) - we have full list
          const known = allProjectItems.some((it) => it.id === id);
          // Also check if id was previously enabled but now deleted - we can just remove if file exists and not enabled and we are the owner.
          // Conservative: remove when known disabled or when we previously had it as enabled but now not.
          // Since we don't have previous list, remove if not enabled and file is in our project dir: we manage it.
          removeClaudeAgentFile(claudeAgentsDir, id);
          if (known) removeExcludeEntry(projectRoot, `.claude/agents/${id}.md`);
          else {
            // For deleted items, entry also needs removal - caller will have removed from allProjectItems, so known false.
            // Still remove exclude for that id because project no longer has it.
            // We call removeExclude for any id no longer enabled? Let's attempt.
            // But caller for delete will also remove exclude.
          }
        }
      }
      // Also ensure excludes for deleted ids are removed: if a project item was deleted, its id won't be in allProjectItems.
      // Handle in caller delete path.
    } catch {}
    return block;
  }

  function listSubagents(args = {}) {
    const projectRoot = args.projectRoot || null;
    const catalog = listModelCatalog(homeDir);
    const globalItems = readGlobal();
    const projectItems = projectRoot ? readProject(projectRoot) : [];
    const effectiveItems = buildEffective(globalItems, projectItems);
    return { ok: true, projectRoot, catalog, globalItems, projectItems, effectiveItems };
  }

  function saveSubagent(args = {}) {
    const scope = args.scope || "global";
    const projectRoot = args.projectRoot || null;
    const input = args.item || args;
    const previous = (scope === "project" && projectRoot ? readProject(projectRoot) : readGlobal()).find(i => i.id === (input.id || input.name));
    const item = { ...previous, ...input };
    const catalog = listModelCatalog(homeDir);
    // Support being called as saveSubagent({scope, projectRoot, item}) or flat.
    const normalized = {
      id: String(item.id || item.name || "").trim(),
      name: String(item.name || item.id || "").trim(),
      role: item.role ? String(item.role).trim() : "",
      toolBadge: item.toolBadge ? String(item.toolBadge).trim() : "",
      providerInstanceId: String(item.providerInstanceId || "").trim(),
      model: String(item.model || "").trim(),
      effort: String(item.effort || "").trim(),
      description: item.description ? String(item.description) : "",
      systemPrompt: item.systemPrompt ? String(item.systemPrompt) : "",
      enabled: item.enabled !== false,
      builtin: Boolean(item.builtin),
      overridesGlobal: scope === "project" ? item.overridesGlobal !== false : Boolean(item.overridesGlobal),
      memoryPolicy: item.memoryPolicy ?? normalizeMemory({ id: item.id || item.name }).memoryPolicy,
      avatarColor: item.avatarColor ?? normalizeMemory({ id: item.id || item.name }).avatarColor,
    };
    if (!normalized.id) throw new Error("item.id required");
    if (!normalized.name) normalized.name = normalized.id;
    validateItem(normalized, catalog);
    let saved;
    let renderedMarkdownBlock;
    if (scope === "global") {
      let items = readGlobal();
      const idx = items.findIndex((x) => x.id === normalized.id);
      // Preserve builtin flag correctly: if id is a default builtin and caller didn't set builtin, mark builtin true.
      const isDefaultId = DEFAULT_SUBAGENTS.some((d) => d.id === normalized.id);
      if (isDefaultId && !normalized.builtin) {
        // Keep builtin true if it was builtin before or is a default.
        const prev = items[idx];
        if (prev) normalized.builtin = Boolean(prev.builtin);
        else normalized.builtin = true;
      }
      if (idx >= 0) {
        // Merge, preserving builtin if was builtin.
        if (items[idx].builtin) normalized.builtin = true;
        items[idx] = { ...items[idx], ...normalized, id: normalized.id, name: normalized.name };
      } else {
        if (isDefaultId) normalized.builtin = true;
        items.push(normalized);
      }
      writeGlobal(items);
      renderedMarkdownBlock = injectGlobal(items, args.extraSyncPaths);
      saved = items.find((x) => x.id === normalized.id);
    } else if (scope === "project") {
      if (!projectRoot || !path.isAbsolute(String(projectRoot))) throw new Error("projectRoot required for project scope");
      let items = readProject(projectRoot);
      const idx = items.findIndex((x) => x.id === normalized.id);
      // If overridesGlobal, ensure global exists with that id? Allow anyway but mark override.
      if (idx >= 0) {
        items[idx] = { ...items[idx], ...normalized, id: normalized.id, name: normalized.name };
      } else {
        items.push(normalized);
      }
      writeProject(projectRoot, items);
      const globalItems = readGlobal();
      renderedMarkdownBlock = injectProject(projectRoot, items, globalItems);
      saved = items.find((x) => x.id === normalized.id);
    } else {
      throw new Error("invalid scope: " + scope);
    }
    // Also ensure global block is re-injected when project changes? No.
    return { ok: true, scope, projectRoot: scope === "project" ? projectRoot : null, item: saved, renderedMarkdownBlock };
  }

  function deleteSubagent(args = {}) {
    const scope = args.scope || "global";
    const projectRoot = args.projectRoot || null;
    const id = String(args.id || "").trim();
    if (!id) throw new Error("id required");
    assertSafeSubagentId(id);
    let renderedMarkdownBlock;
    if (scope === "global") {
      let items = readGlobal();
      const idx = items.findIndex((x) => x.id === id);
      if (idx === -1) return { ok: true, scope, id, deleted: false };
      const existing = items[idx];
      if (existing.builtin) {
        // Reset builtin to default seed instead of deleting.
        const def = DEFAULT_SUBAGENTS.find((d) => d.id === id);
        if (def) {
          items[idx] = { ...def };
          writeGlobal(items);
          renderedMarkdownBlock = injectGlobal(items, args.extraSyncPaths);
          return { ok: true, scope, id, deleted: false, reset: true, item: items[idx], renderedMarkdownBlock };
        }
      }
      items = items.filter((x) => x.id !== id);
      writeGlobal(items);
      renderedMarkdownBlock = injectGlobal(items, args.extraSyncPaths);
      return { ok: true, scope, id, deleted: true, renderedMarkdownBlock };
    } else if (scope === "project") {
      if (!projectRoot || !path.isAbsolute(String(projectRoot))) throw new Error("projectRoot required for project scope");
      let items = readProject(projectRoot);
      const idx = items.findIndex((x) => x.id === id);
      if (idx === -1) return { ok: true, scope, id, deleted: false, projectRoot };
      items = items.filter((x) => x.id !== id);
      writeProject(projectRoot, items);
      // Clean file and exclude
      const claudeAgentsDir = path.join(projectRoot, ".claude", "agents");
      removeClaudeAgentFile(claudeAgentsDir, id);
      removeExcludeEntry(projectRoot, `.claude/agents/${id}.md`);
      const globalItems = readGlobal();
      renderedMarkdownBlock = injectProject(projectRoot, items, globalItems);
      // injectProject already handles removal, but ensure the just-deleted id is cleaned (it removed via not-enabled check above using known? we need to manually ensure)
      removeClaudeAgentFile(claudeAgentsDir, id);
      removeExcludeEntry(projectRoot, `.claude/agents/${id}.md`);
      return { ok: true, scope, id, deleted: true, projectRoot, renderedMarkdownBlock };
    }
    throw new Error("invalid scope: " + scope);
  }

  // Read on every call and never seed/synchronize configuration from a hook invocation.
  function resolveSubagentRoute({ idOrTitle, role, projectRoot } = {}) {
    const globals = configItems(readJsonFile(globalPath, []));
    let projects = [];
    if (projectRoot) {
      let current = path.resolve(projectRoot);
      // A tool may run below the project root. The closest project config wins.
      while (true) {
        const file = projectPathFor(current);
        if (fileExists(file)) { projects = configItems(readJsonFile(file, []), false).map(i => ({ ...i, overridesGlobal: i.overridesGlobal !== false })); break; }
        if (fileExists(path.join(current, ".git")) || dirExists(path.join(current, ".git"))) break;
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }
    const items = buildEffective(globals, projects).map(normalizeMemory);
    const hints = (Array.isArray(idOrTitle) ? idOrTitle : [idOrTitle]).filter(x => typeof x === "string" && x.trim()).map(x => x.trim().toLowerCase());
    let item;
    // An exact id/name wins over title prefixes; never infer a route from task prose.
    for (const hint of hints) {
      item = items.find(i => [i.id, i.name].some(v => String(v).toLowerCase() === hint));
      if (item) break;
    }
    if (!item) for (const hint of hints) {
      const matches = items.filter(i => [i.id, i.name].some(v => {
        const id = String(v).toLowerCase();
        return hint.startsWith(id) && /^(?:\s*[·:：|/]|\s+-\s)/.test(hint.slice(id.length));
      }));
      if (matches.length === 1) { item = matches[0]; break; }
    }
    // A role fallback is safe only when it is unambiguous and no explicit identity was supplied.
    if (!item && !hints.length && role) {
      item = items.find(i => i.id === role || i.name === role);
      if (!item) { const matches = items.filter(i => i.role === role); if (matches.length === 1) item = matches[0]; }
    }
    if (!item || !item.providerInstanceId || !item.model || !item.effort) return { ok: true, matched: false, item: null, target: null };
    return { ok: true, matched: true, item, target: { providerInstanceId: item.providerInstanceId, model: item.model, options: optionsForSubagent(item) } };
  }

  return { homeDir, hubDir, globalPath, projectDir, resolveSubagentRoute, renderMarkdownBlock: renderBlock, listSubagents, saveSubagent, deleteSubagent, listModelCatalog: () => listModelCatalog(homeDir) };
}

let _singleton = null;
function getDefaultSubagentsManager() {
  if (!_singleton) _singleton = createSubagentsManager();
  return _singleton;
}
function listSubagents(a) { return getDefaultSubagentsManager().listSubagents(a || {}); }
function saveSubagent(a) { return getDefaultSubagentsManager().saveSubagent(a || {}); }
function deleteSubagent(a) { return getDefaultSubagentsManager().deleteSubagent(a || {}); }

module.exports = {
  createSubagentsManager,
  listModelCatalog,
  DEFAULT_SUBAGENTS,
  optionsForSubagent,
  resolveSubagentRoute: a => getDefaultSubagentsManager().resolveSubagentRoute(a),
  getDefaultSubagentsManager,
  listSubagents,
  saveSubagent,
  deleteSubagent,
};
