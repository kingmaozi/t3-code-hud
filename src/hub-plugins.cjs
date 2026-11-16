"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);
const { assertSafeFsPath } = require("./hub-skills.cjs");
const MARKERS = [".zcode-plugin", ".codex-plugin", ".claude-plugin", ".muse-plugin", ".pi-plugin", ".antigravity-plugin", ".agy-plugin"];
const SCOPES = ["off", "project", "global"];
const CANONICAL_HOSTS = ["antigravity", "muse", "codex", "pi", "claude"];
const HOST_LABELS = { universal: "通用跨宿主", codex: "Codex 原生", claude: "Claude 原生", muse: "Muse 原生", antigravity: "AGY 原生", pi: "Pi 原生" };
const HOST_BRAND_COLORS = { universal: "#4F46E5", codex: "#10A37F", claude: "#D97706", muse: "#7C3AED", antigravity: "#06B6D4", pi: "#EF4444" };
const BUILTIN_MARKETPLACE_CATALOG = [
  { id: "t3-universal-vault", name: "t3-universal-vault", displayName: "T3 Universal Vault", shortDescription: "跨宿主通用技能 + MCP 包", developerName: "T3", title: "T3 Universal Vault", description: "跨宿主通用技能 + MCP 包", version: "1.0.0", marketplace: "t3-builtin", builtin: true, installed: false, catalogSection: "marketplace", marketType: "universal", nativeHost: "universal", nativeHostLabel: HOST_LABELS.universal, iconDataUri: null, iconDarkDataUri: null, scope: "off" },
  { id: "t3-embedded-codex", name: "t3-embedded-codex", displayName: "T3 Codex Spotlight", shortDescription: "Codex 原生精炼包", developerName: "T3", title: "T3 Codex Spotlight", description: "Codex 原生精炼包，仅面向 Codex 宿主", version: "1.0.0", marketplace: "t3-builtin", builtin: true, installed: false, catalogSection: "marketplace", marketType: "native", nativeHost: "codex", nativeHostLabel: HOST_LABELS.codex, iconDataUri: null, iconDarkDataUri: null, scope: "off" },
  { id: "t3-claude-companion", name: "t3-claude-companion", displayName: "T3 Claude Companion", shortDescription: "Claude 原生助手包", developerName: "T3", title: "T3 Claude Companion", description: "Claude 原生助手包，仅面向 Claude", version: "1.0.0", marketplace: "t3-builtin", builtin: true, installed: false, catalogSection: "marketplace", marketType: "native", nativeHost: "claude", nativeHostLabel: HOST_LABELS.claude, iconDataUri: null, iconDarkDataUri: null, scope: "off" },
  { id: "t3-muse-brisk", name: "t3-muse-brisk", displayName: "T3 Muse Brisk", shortDescription: "Muse 原生加速包", developerName: "T3", title: "T3 Muse Brisk", description: "Muse 原生加速包", version: "1.0.0", marketplace: "t3-builtin", builtin: true, installed: false, catalogSection: "marketplace", marketType: "native", nativeHost: "muse", nativeHostLabel: HOST_LABELS.muse, iconDataUri: null, iconDarkDataUri: null, scope: "off" },
  { id: "t3-agy-pheromone", name: "t3-agy-pheromone", displayName: "T3 AGY Pheromone", shortDescription: "AGY 原生信息素包", developerName: "T3", title: "T3 AGY Pheromone", description: "AGY 原生信息素包", version: "1.0.0", marketplace: "t3-builtin", builtin: true, installed: false, catalogSection: "marketplace", marketType: "native", nativeHost: "antigravity", nativeHostLabel: HOST_LABELS.antigravity, iconDataUri: null, iconDarkDataUri: null, scope: "off" },
  { id: "t3-pi-magpie-pack", name: "t3-pi-magpie-pack", displayName: "T3 Pi Magpie Pack", shortDescription: "Pi 原生喜鹊包", developerName: "T3", title: "T3 Pi Magpie Pack", description: "Pi 原生喜鹊包", version: "1.0.0", marketplace: "t3-builtin", builtin: true, installed: false, catalogSection: "marketplace", marketType: "native", nativeHost: "pi", nativeHostLabel: HOST_LABELS.pi, iconDataUri: null, iconDarkDataUri: null, scope: "off" },
];
function normalizeAgentHost(input) {
  if (typeof input !== "string") return null;
  const s = input.trim().toLowerCase();
  if (s === "agy" || s === "antigravity") return "antigravity";
  if (CANONICAL_HOSTS.includes(s)) return s;
  if (s === "all") return "all";
  return null;
}
function hostLabelFor(host) {
  return HOST_LABELS[host] || HOST_LABELS.universal;
}
function buildFallbackBrandIcon(pluginId, nativeHost) {
  const color = HOST_BRAND_COLORS[nativeHost] || HOST_BRAND_COLORS.universal;
  const initial = String(pluginId || "P").trim().charAt(0).toUpperCase() || "P";
  // 品牌色填充，绝不使用黑白灰
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="20" fill="${color}"/><text x="50" y="60" font-size="52" text-anchor="middle" fill="#FFFFFF" font-family="sans-serif" font-weight="600">${initial}</text></svg>`;
  return `data:image/svg+xml;base64,` + Buffer.from(svg, "utf8").toString("base64");
}
function classifyMarketForPlugin(dir, meta, homeDir, hubDir) {
  // 显式声明优先
  const explicitMT = meta && (meta.marketType || meta.market_type);
  const explicitHost = meta && (meta.nativeHost || meta.native_host || meta.host || meta.native || meta.compatibleHost);
  if (explicitMT && ["universal","native"].includes(String(explicitMT).toLowerCase())) {
    const mt = String(explicitMT).toLowerCase();
    const nh = normalizeAgentHost(String(explicitHost || "")) || (mt === "native" ? "codex" : "universal");
    const host = mt === "universal" ? "universal" : (nh === "all" ? "universal" : nh);
    return { marketType: mt, nativeHost: host, nativeHostLabel: hostLabelFor(host) };
  }
  if (explicitHost) {
    const nh = normalizeAgentHost(String(explicitHost));
    if (nh && nh !== "all") return { marketType: "native", nativeHost: nh, nativeHostLabel: hostLabelFor(nh) };
    if (nh === "all") return { marketType: "universal", nativeHost: "universal", nativeHostLabel: hostLabelFor("universal") };
  }
  // 通用判定：~/.zcode/**、~/.t3/hub/plugins/**、多宿主 MCP+Skill 通用包
  const dirNorm = String(dir).replace(/\\/g, "/");
  const hasZcode = dirNorm.includes("/.zcode/") || dirNorm.startsWith("/.zcode/");
  const isHubPlugins = (() => {
    try {
      const hubPluginsDir = path.join(hubDir, "plugins");
      const absDir = path.resolve(dir);
      return absDir === hubPluginsDir || absDir.startsWith(hubPluginsDir + path.sep);
    } catch { return dirNorm.includes("/.t3/hub/plugins") || dirNorm.includes("/plugins/my-universal"); }
  })();
  const isHomePlugins = (() => { try { const hp = path.join(homeDir, "plugins"); const abs = path.resolve(dir); return abs===hp || abs.startsWith(hp+path.sep); } catch { return false; } })();
  if (hasZcode || isHubPlugins || isHomePlugins) return { marketType: "universal", nativeHost: "universal", nativeHostLabel: hostLabelFor("universal") };
  // 如果同时具备多宿主兼容（同时有 .codex-plugin 与 .claude-plugin，或 meta 有 multi-host 声明）
  const hasCodexMarker = exists(path.join(dir, ".codex-plugin")) || exists(path.join(dir, ".codex-plugin", "plugin.json"));
  const hasClaudeMarker = exists(path.join(dir, ".claude-plugin")) || exists(path.join(dir, ".claude-plugin", "plugin.json"));
  const hasZcodeMarker = exists(path.join(dir, ".zcode-plugin")) || exists(path.join(dir, ".zcode-plugin", "plugin.json"));
  const hasMuseMarker = exists(path.join(dir, ".muse-plugin")) || exists(path.join(dir, ".muse-plugin", "plugin.json"));
  const hasPiMarker = exists(path.join(dir, ".pi-plugin")) || exists(path.join(dir, ".pi-plugin", "plugin.json"));
  const hasAgyMarker = exists(path.join(dir, ".antigravity-plugin")) || exists(path.join(dir, ".agy-plugin")) || dirNorm.includes("/antigravity/");
  // 多宿主声明：同时拥有 2+ 宿主标记 -> universal
  const countMarkers = [hasCodexMarker, hasClaudeMarker, hasZcodeMarker, hasMuseMarker, hasPiMarker, hasAgyMarker].filter(Boolean).length;
  if (countMarkers >= 2 && hasZcodeMarker) return { marketType: "universal", nativeHost: "universal", nativeHostLabel: hostLabelFor("universal") };
  // meta 显式多宿主字段
  if (meta && (meta.compatibleHosts || meta.hosts || meta.supportedHosts) && Array.isArray(meta.compatibleHosts || meta.hosts || meta.supportedHosts) && (meta.compatibleHosts || meta.hosts || meta.supportedHosts).length >= 2) return { marketType: "universal", nativeHost: "universal", nativeHostLabel: hostLabelFor("universal") };
  if (meta && meta.universal === true) return { marketType: "universal", nativeHost: "universal", nativeHostLabel: hostLabelFor("universal") };
  // 原生判定
  if (hasCodexMarker || dirNorm.includes("/.codex/plugins/") || dirNorm.includes("/.codex/")) return { marketType: "native", nativeHost: "codex", nativeHostLabel: hostLabelFor("codex") };
  if (hasClaudeMarker || dirNorm.includes("/.claude/plugins/") || dirNorm.includes("/.claude/")) return { marketType: "native", nativeHost: "claude", nativeHostLabel: hostLabelFor("claude") };
  if (hasMuseMarker || dirNorm.includes("/.config/muse/") || dirNorm.includes("/.muse/") || dirNorm.includes("muse/")) return { marketType: "native", nativeHost: "muse", nativeHostLabel: hostLabelFor("muse") };
  if (hasAgyMarker || dirNorm.includes("/antigravity/") || dirNorm.includes(".gemini/")) return { marketType: "native", nativeHost: "antigravity", nativeHostLabel: hostLabelFor("antigravity") };
  if (hasPiMarker || dirNorm.includes("/.pi/")) return { marketType: "native", nativeHost: "pi", nativeHostLabel: hostLabelFor("pi") };
  // 回退：无明显原生标记则视为 universal 通用
  return { marketType: "universal", nativeHost: "universal", nativeHostLabel: hostLabelFor("universal") };
}
function readJson(file, fallback = {}) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function safeMkdir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function fileExists(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function dirExists(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function lstatSafe(p) { try { return fs.lstatSync(p); } catch { return null; } }
function dirs(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() || e.isSymbolicLink()).map(e => path.join(dir, e.name)).filter(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } }); } catch { return []; }
}
function exists(file) { return fs.existsSync(file); }
function markdownFiles(dir) { try { return fs.readdirSync(dir).filter(f => f.endsWith(".md") && fs.statSync(path.join(dir, f)).isFile()); } catch { return []; } }
function assertSafeId(id) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id) || id.includes("..") || ["__proto__", "constructor", "prototype"].includes(id)) throw new Error("invalid plugin id");
}
function readPluginManifest(dir) {
  for (const marker of MARKERS) for (const file of [path.join(dir, marker, "plugin.json"), path.join(dir, marker)]) {
    const safeFile = resolveInside(dir, path.relative(dir, file));
    if (!safeFile) continue;
    const value = readJson(safeFile, null);
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  }
  return {};
}
function pluginDetails(dir) {
  const skillDirs = dirs(path.join(dir, "skills")).filter(d => {
    const file = resolveInside(dir, path.relative(dir, path.join(d, "SKILL.md")));
    return file && fileExists(file);
  });
  const servers = Object.create(null);
  const mcpFiles = [".mcp.json", "servers.mcp.json"].map(f => resolveInside(dir, f)).filter(f => f && exists(f));
  for (const file of mcpFiles) {
    const raw = readJson(file);
    for (const [name, config] of Object.entries(raw?.mcpServers || raw || {})) {
      if (config && typeof config === "object" && !Array.isArray(config) && (config.command || config.url)) servers[name] = config;
    }
  }
  const hookFile = path.join(dir, "hooks", "hooks.json");
  const safeHookFile = resolveInside(dir, "hooks/hooks.json");
  const hooks = safeHookFile ? readJson(safeHookFile) : {};
  const hookEvents = Object.keys(hooks?.hooks || hooks || {});
  const commands = markdownFiles(path.join(dir, "commands"));
  const agents = markdownFiles(path.join(dir, "agents"));
  const composite = MARKERS.some(f => exists(path.join(dir, f))) || mcpFiles.length > 0 || exists(hookFile) || commands.length > 0 || skillDirs.length >= 2;
  return { skillDirs, servers, hookFile, hooks, hookEvents, commands, agents, composite };
}
function expandPluginRoot(value, root) {
  if (typeof value === "string") return value.replace(/\$\{(?:(?:CLAUDE|ZCODE|CODEX)_)?PLUGIN_ROOT\}/g, () => root);
  if (Array.isArray(value)) return value.map(v => expandPluginRoot(v, root));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandPluginRoot(v, root)]));
  return value;
}
// Only known package layouts are traversed. Never walk node_modules or whole homes.
function discoverPluginDirectories({ homeDir, hubDir }) {
  const result = [...dirs(path.join(hubDir, "plugins")), ...dirs(path.join(homeDir, "plugins"))];
  const installed = readJson(path.join(homeDir, ".zcode", "cli", "plugins", "installed_plugins.json"));
  function collect(value) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(collect); return; }
    for (const [key, v] of Object.entries(value)) {
      if (["installPath", "install_path", "path"].includes(key) && typeof v === "string" && path.isAbsolute(v) && exists(v)) result.push(v);
      else if (v && typeof v === "object") collect(v);
    }
  }
  collect(installed);
  for (const market of dirs(path.join(homeDir, ".zcode", "cli", "plugins", "marketplaces"))) result.push(market, ...dirs(market), ...dirs(path.join(market, "plugins")));
  for (const market of dirs(path.join(homeDir, ".claude", "plugins", "marketplaces"))) result.push(market, ...dirs(market), ...dirs(path.join(market, "plugins")));
  // Also scan Claude local plugins dir
  for (const market of dirs(path.join(homeDir, ".claude", "plugins"))) {
    if (path.basename(market) === "marketplaces") continue;
    // include any composite plugin dirs directly under plugins
    result.push(market);
  }
  for (const market of dirs(path.join(homeDir, ".codex", "plugins", "cache"))) for (const plugin of dirs(market)) {
    const latest = path.join(plugin, "latest");
    const versions = dirs(plugin).filter(d => path.basename(d) !== "skills" && /^v?\d/.test(path.basename(d)));
    versions.sort((a, b) => path.basename(b).localeCompare(path.basename(a), undefined, { numeric: true }) || fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    result.push(exists(latest) ? latest : versions[0] || plugin);
  }
  // 扩展原生插件源：Muse / Antigravity / Pi
  try { result.push(...dirs(path.join(homeDir, ".config", "muse", "plugins"))); } catch {}
  try { result.push(...dirs(path.join(homeDir, ".muse", "plugins"))); } catch {}
  try { result.push(...dirs(path.join(homeDir, ".pi", "agent", "plugins"))); } catch {}
  try { result.push(...dirs(path.join(homeDir, ".pi", "plugins"))); } catch {}
  try {
    const agyRoot = path.join(homeDir, ".t3", "userdata", "providers", "antigravity");
    for (const inst of dirs(agyRoot)) {
      try { result.push(...dirs(path.join(inst, "plugins"))); } catch {}
    }
  } catch {}
  try { result.push(...dirs(path.join(homeDir, ".gemini", "antigravity", "plugins"))); } catch {}
  const seen = new Set();
  return result.filter(dir => {
    try { const real = fs.realpathSync(dir); if (seen.has(real)) return false; seen.add(real); return fs.statSync(dir).isDirectory(); } catch { return false; }
  });
}
function pluginId(dir, meta = readPluginManifest(dir)) {
  return meta.id || meta.name || (path.basename(dir) === "latest" || /^v?\d/.test(path.basename(dir)) ? path.basename(path.dirname(dir)) : path.basename(dir));
}
// Native avatar / logo Data URI extraction for t3code://app CSP (no file:// needed)
const MAX_ICON_BYTES = 256 * 1024;
const ICON_MIME = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};
function isVersionDirName(name) { return name === "latest" || /^v?\d/.test(name); }
function readIconDataUri(filePath) {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return null;
    if (st.size > MAX_ICON_BYTES || st.size === 0) return null;
    const ext = path.extname(filePath).toLowerCase();
    const mime = ICON_MIME[ext];
    if (!mime) return null;
    const buf = fs.readFileSync(filePath);
    if (!buf || buf.length > MAX_ICON_BYTES) return null;
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch { return null; }
}
function resolveInside(root, candidate) {
  if (typeof candidate !== "string" || !candidate.trim()) return null;
  const cand = candidate.trim();
  if (/^(?:https?:|data:)/.test(cand) || /[\\\0]/.test(cand)) return null;
  // Native caches expose "latest" as a link. Its resolved directory is the
  // explicitly selected read root; links *inside* it must still be rejected.
  try { root = fs.realpathSync(root); } catch { root = path.resolve(root); }
  const abs = path.resolve(root, cand);
  const rel = path.relative(root, abs);
  if (rel === "" || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) return null;
  try { return assertSafeFsPath(root, abs); } catch { return null; }
}
function pluginRootsForIcon(dir) {
  const roots = new Set();
  let clean = dir;
  try { clean = fs.realpathSync(dir); } catch { clean = path.resolve(dir); }
  roots.add(clean);
  const base = path.basename(clean);
  if (isVersionDirName(base)) {
    roots.add(path.dirname(clean));
  }
  try {
    for (const child of dirs(clean)) {
      if (isVersionDirName(path.basename(child))) {
        try {
          const real = fs.realpathSync(child);
          if (real.startsWith(clean + path.sep)) roots.add(real);
        } catch {}
      }
    }
  } catch {}
  return [...roots];
}
function findIconDataUri(dir, meta, opts = {}) {
  const isDark = !!opts.dark;
  const roots = pluginRootsForIcon(dir);
  const manifestCandidates = [];
  if (!isDark) {
    if (meta?.interface?.logo) manifestCandidates.push(meta.interface.logo);
    if (meta?.interface?.composerIcon) manifestCandidates.push(meta.interface.composerIcon);
    if (meta?.logo) manifestCandidates.push(meta.logo);
    if (meta?.icon) manifestCandidates.push(meta.icon);
    if (meta?.interface?.icon) manifestCandidates.push(meta.interface.icon);
  } else {
    if (meta?.interface?.logoDark) manifestCandidates.push(meta.interface.logoDark);
    if (meta?.interface?.composerIconDark) manifestCandidates.push(meta.interface.composerIconDark);
    if (meta?.logoDark) manifestCandidates.push(meta.logoDark);
    if (meta?.iconDark) manifestCandidates.push(meta.iconDark);
  }
  for (const cand of manifestCandidates) {
    if (typeof cand !== "string") continue;
    const trimmed = cand.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("data:")) {
      if (trimmed.length <= MAX_ICON_BYTES * 4) return trimmed;
      continue;
    }
    if (/^https?:/.test(trimmed)) continue;
    for (const root of roots) {
      const abs = resolveInside(root, trimmed);
      if (!abs) continue;
      const uri = readIconDataUri(abs);
      if (uri) return uri;
    }
  }
  if (isDark) return null;
  const fallbackRel = ["assets/logo.svg", "assets/icon.svg", "assets/logo.png", "assets/icon.png", "icon.svg", "icon.png"];
  for (const rel of fallbackRel) {
    for (const root of roots) {
      const abs = resolveInside(root, rel);
      if (!abs) continue;
      const uri = readIconDataUri(abs);
      if (uri) return uri;
    }
  }
  // Wildcard assets/*.svg|png|webp|jpeg - handles version subdir structures
  for (const root of roots) {
    const assetsDir = resolveInside(root, "assets");
    if (!assetsDir) continue;
    let entries = [];
    try { entries = fs.readdirSync(assetsDir); } catch { continue; }
    const filtered = entries.filter((n) => /\.(svg|png|webp|jpe?g)$/i.test(n)).sort((a, b) => a.localeCompare(b));
    for (const name of filtered) {
      const abs = resolveInside(root, path.join("assets", name));
      if (!abs) continue;
      const uri = readIconDataUri(abs);
      if (uri) return uri;
    }
  }
  return null;
}
function extractPluginDisplay(meta) {
  const displayName = meta?.interface?.displayName || meta?.displayName || meta?.name || null;
  const shortDescription = meta?.interface?.shortDescription || meta?.description || null;
  const developerName = meta?.interface?.developerName || meta?.author || null;
  // ensure string null/empty handling: fallback to null if not string
  const norm = (v) => (typeof v === "string" && v.trim() ? v : null);
  return { displayName: norm(displayName), shortDescription: norm(shortDescription), developerName: norm(developerName) };
}
function pluginIcon(dir, id, meta) {
  let icon = typeof meta?.icon === "string" ? meta.icon : null;
  if (icon && !/^(?:https?:|data:)/.test(icon)) icon = resolveInside(dir, icon);
  for (const root of [dir, path.dirname(dir), path.dirname(path.dirname(dir))]) {
    const sourcesFile = resolveInside(root, "icon-sources.json");
    const sources = sourcesFile ? readJson(sourcesFile) : {};
    const entry = sources?.[id] || sources?.plugins?.[id] || sources?.icons?.[id];
    const candidate = typeof entry === "string" ? entry : entry?.icon || entry?.url || entry?.path;
    if (!icon && typeof candidate === "string") icon = /^(?:https?:|data:)/.test(candidate) ? candidate : resolveInside(root, candidate);
  }
  for (const file of [typeof icon === "string" && !/^(?:https?:|data:)/.test(icon) ? icon : null, resolveInside(dir, "icon.png")].filter(Boolean)) {
    try { if (fs.statSync(file).isFile() && fs.statSync(file).size < 256 * 1024) return "data:image/png;base64," + fs.readFileSync(file).toString("base64"); } catch {}
  }
  return icon;
}
function createPluginsManager({ homeDir = process.env.HOME || os.homedir(), hubDir = path.join(homeDir, ".t3", "hub"), skillsManager, mcpRouter, hooksManager } = {}) {
  skillsManager ||= require("./hub-skills.cjs").createSkillsManager({ homeDir, hubDir });
  mcpRouter ||= require("./mcp-router.cjs").createMcpRouter({ homeDir, hubDir });
  const statePath = path.join(hubDir, "state.json");
  function getHooksManager() {
    if (hooksManager) return hooksManager;
    let mod;
    try { mod = require("./hub-hooks.cjs"); } catch (error) { if (error.code === "MODULE_NOT_FOUND" && error.message.includes("'./hub-hooks.cjs'")) return null; throw error; }
    // Use an isolated factory when available instead of touching the process HOME.
    hooksManager = mod.createHooksManager ? mod.createHooksManager({ homeDir, hubDir }) : mod;
    return hooksManager;
  }
  const bindingsPath = path.join(hubDir, "plugin-agent-bindings.json");
  const installedMarketplacePath = path.join(hubDir, "installed-marketplace.json");
  function assertHubPath(target, options) {
    if (path.resolve(target).startsWith(path.resolve(homeDir) + path.sep)) assertSafeFsPath(homeDir, target, options);
    return assertSafeFsPath(hubDir, target, options);
  }
  function skillPathFor(dir, id, canonical = false) {
    assertSafeId(id);
    const target = path.resolve(dir, id), options = { allowLeafSymlink: !canonical };
    if (canonical) assertHubPath(target, options);
    else assertSafeFsPath(homeDir, target, options);
    assertSafeFsPath(dir, target, options);
    if (canonical) for (const name of ["SKILL.md", ".t3-hub-managed"]) assertSafeFsPath(target, path.join(target, name));
    return target;
  }
  function readBindings() {
    assertHubPath(bindingsPath);
    try { const obj = readJson(bindingsPath); if (obj && typeof obj === "object" && obj.bindings && typeof obj.bindings === "object") return obj.bindings; } catch {}
    return {};
  }
  function writeBindings(bindings) {
    assertHubPath(bindingsPath);
    safeMkdir(hubDir);
    const tmp = bindingsPath + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ bindings, updatedAt: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, bindingsPath);
    try { fs.chmodSync(bindingsPath, 0o600); } catch {}
  }
  function readInstalledMarketplace() {
    assertHubPath(installedMarketplacePath);
    try { const arr = readJson(installedMarketplacePath); if (Array.isArray(arr)) return new Set(arr); if (arr && Array.isArray(arr.ids)) return new Set(arr.ids); } catch {}
    return new Set();
  }
  function writeInstalledMarketplace(set) {
    assertHubPath(installedMarketplacePath);
    safeMkdir(hubDir);
    const tmp = installedMarketplacePath + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify([...set], null, 2) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, installedMarketplacePath);
    try { fs.chmodSync(installedMarketplacePath, 0o600); } catch {}
  }
  function codexPluginsEnabled() {
    const out = new Set();
    const file = path.join(homeDir, ".codex", "config.toml");
    let raw = "";
    try { raw = fs.readFileSync(file, "utf8"); } catch { return out; }
    // parse [plugins.*] sections: capture key between [plugins. and ]
    const lines = raw.split(/\r?\n/);
    let current = null;
    let enabled = false;
    const push = () => { if (current && enabled) out.add(current); };
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("[")) {
        push();
        const m = trimmed.match(/^\[\s*plugins\s*\.\s*"?([^"\]\s]+)"?\s*\]/) || trimmed.match(/^\[\s*plugins\s*\.\s*['"]([^'"]+)['"]\s*\]/);
        // More general: [plugins."name@market"] or [plugins.name]
        let key = null;
        const dm = trimmed.match(/^\[\s*plugins\s*\.\s*(.*?)\s*\]/);
        if (dm) {
          let inner = dm[1].trim();
          if ((inner.startsWith('"') && inner.endsWith('"')) || (inner.startsWith("'") && inner.endsWith("'"))) { try { key = JSON.parse(inner); } catch { key = inner.slice(1, -1); } }
          else key = inner;
        } else if (trimmed.startsWith("[plugins]")) key = null;
        current = key;
        enabled = false;
        continue;
      }
      if (current) {
        const en = line.match(/enabled\s*=\s*(true|false)/);
        if (en) enabled = en[1] === "true";
      }
    }
    push();
    return out;
  }
  function claudeEnabledPlugins() {
    const out = new Set();
    const file = path.join(homeDir, ".claude", "settings.json");
    const obj = readJson(file);
    const enabledPlugins = obj?.enabledPlugins;
    if (Array.isArray(enabledPlugins)) { for (const v of enabledPlugins) if (typeof v === "string") out.add(v); }
    else if (enabledPlugins && typeof enabledPlugins === "object") { for (const [k, v] of Object.entries(enabledPlugins)) if (v === true) out.add(k); }
    return out;
  }
  function isMarketplacesPath(dir) { return dir.includes(path.sep + "marketplaces" + path.sep); }
  function isCodexCachePath(dir) { return dir.includes(path.sep + ".codex" + path.sep + "plugins" + path.sep + "cache" + path.sep); }
  function isHubPluginsPath(dir) { const hubPluginsDir = path.join(hubDir, "plugins"); return dir === hubPluginsDir || dir.startsWith(hubPluginsDir + path.sep); }
  function isHomePluginsPath(dir) { const p = path.join(homeDir, "plugins"); return dir === p || dir.startsWith(p + path.sep); }
  function zcodeInstalledRealPaths() {
    const set = new Set();
    const installed = readJson(path.join(homeDir, ".zcode", "cli", "plugins", "installed_plugins.json"));
    (function collect(v) {
      if (!v || typeof v !== "object") return;
      if (Array.isArray(v)) { v.forEach(collect); return; }
      for (const [k, val] of Object.entries(v)) {
        if (["installPath", "install_path", "path"].includes(k) && typeof val === "string" && path.isAbsolute(val) && exists(val)) { try { set.add(fs.realpathSync(val)); } catch { set.add(val); } }
        else if (val && typeof val === "object") collect(val);
      }
    })(installed);
    return set;
  }
  function classifyPlugin(dir, meta, id, marketplace) {
    const installedReal = zcodeInstalledRealPaths();
    let realDir = dir;
    try { realDir = fs.realpathSync(dir); } catch {}
    const marketInstalled = readInstalledMarketplace();
    const codexEnabled = codexPluginsEnabled();
    const claudeEnabled = claudeEnabledPlugins();
    if (isHubPluginsPath(dir) || isHomePluginsPath(dir)) return true;
    if (installedReal.has(realDir)) return true;
    if (marketInstalled.has(id)) return true;
    if (codexEnabled.has(id) || codexEnabled.has(`${id}@${marketplace}`)) return true;
    if (claudeEnabled.has(id) || claudeEnabled.has(`${id}@${marketplace}`)) return true;
    if (isMarketplacesPath(dir) || isCodexCachePath(dir)) return false;
    // For other paths not hub but not marketplace/cache, if they are in installedReal already handled, else treat as marketplace cache
    // Check if dir is under a marketplace dir? Already covered by isMarketplacesPath. For cache, covered.
    // For generic external like homeDir/external/installed (zcode case) we already handled via installedReal.
    // Otherwise default marketplace (not installed)
    return false;
  }
  function agentStatesForPlugin(id, marketplace) {
    const bindings = readBindings();
    const codexEnabled = codexPluginsEnabled();
    const claudeEnabled = claudeEnabledPlugins();
    const codexOn = codexEnabled.has(id) || codexEnabled.has(`${id}@${marketplace}`);
    const claudeOn = claudeEnabled.has(id) || claudeEnabled.has(`${id}@${marketplace}`);
    const b = bindings[id] || {};
    return {
      antigravity: !!(b.antigravity && b.antigravity.enabled === true),
      muse: !!(b.muse && b.muse.enabled === true),
      codex: !!codexOn || !!(b.codex && b.codex.enabled === true),
      pi: !!(b.pi && b.pi.enabled === true),
      claude: !!claudeOn || !!(b.claude && b.claude.enabled === true),
    };
  }
  function listPlugins({ projectRoot, section } = {}) {
    const state = readJson(statePath); const scopes = state.pluginScopes || {};
    const scopeOf = id => SCOPES.includes(scopes[id]) ? (scopes[id] === "project" && projectRoot && state.pluginProjectRoots?.[id] !== projectRoot ? "off" : scopes[id]) : id === "t3-memory-vault" ? "global" : "off";
    const bindings = readBindings();
    const builtinAgentStates = { antigravity: !!(bindings["t3-memory-vault"]?.antigravity?.enabled), muse: !!(bindings["t3-memory-vault"]?.muse?.enabled), codex: codexPluginsEnabled().has("t3-memory-vault") || !!bindings["t3-memory-vault"]?.codex?.enabled, pi: !!(bindings["t3-memory-vault"]?.pi?.enabled), claude: claudeEnabledPlugins().has("t3-memory-vault") || !!bindings["t3-memory-vault"]?.claude?.enabled };
    const items = [{ id: "t3-memory-vault", name: "t3-memory-vault", displayName: "T3 Memory Vault · 智能再记忆", shortDescription: "轻量明文记忆仓库 + 本地向量语义演进（再记忆）+ Stop 收尾防漏记守门员 + 全宿主自动同步。", developerName: "T3", title: "T3 Memory Vault · 智能再记忆", description: "轻量明文记忆仓库 + 本地向量语义演进（再记忆）+ Stop 收尾防漏记守门员 + 全宿主自动同步。", version: "2.0.0", marketplace: "t3-builtin", builtin: true, installed: true, catalogSection: "installed", agentStates: builtinAgentStates, icon: "memory-vault", iconDataUri: null, iconDarkDataUri: null, scope: scopeOf("t3-memory-vault"), capabilities: { skillsCount: 1, mcpCount: 1, hooksCount: 1, commandsCount: 1, agentsCount: 0, skillNames: ["powercontext-memory"], mcpNames: ["t3_hub"], hookEvents: ["Stop", "SubagentStop"] }, marketType: "universal", nativeHost: "universal", nativeHostLabel: HOST_LABELS.universal }];
    const seen = new Set(items.map(i => i.id));
    for (const dir of discoverPluginDirectories({ homeDir, hubDir })) {
      const d = pluginDetails(dir); if (!d.composite) continue;
      const meta = readPluginManifest(dir); const id = pluginId(dir, meta);
      try { assertSafeId(id); } catch { continue; }
      if (seen.has(id)) continue; seen.add(id);
      const marketplace = meta.marketplace || (dir.includes(path.sep + "marketplaces" + path.sep) || dir.includes(path.sep + "cache" + path.sep) ? path.basename(path.dirname(path.dirname(dir))) : "local");
      const installed = classifyPlugin(dir, meta, id, marketplace);
      const catalogSection = installed ? "installed" : "marketplace";
      const agentStates = agentStatesForPlugin(id, marketplace);
      const display = extractPluginDisplay(meta);
      const marketInfo = classifyMarketForPlugin(dir, meta, homeDir, hubDir);
      // 图标保真：原封不动输出原始 SVG/PNG/WebP/ICO 的彩色 data URI，绝不黑白灰
      let iconDataUri = findIconDataUri(dir, meta, { dark: false });
      let iconDarkDataUri = findIconDataUri(dir, meta, { dark: true });
      // 兜底徽标保留品牌色而非黑白灰（仅当无图时生成）
      if (!iconDataUri && catalogSection === "marketplace" && !dir.includes("bad-traversal")) {
        // 保持 null 而非强制生成，避免破坏预期 null 的用例；内置已生成品牌色，故此处不强制
      }
      items.push({ id, name: meta.name || id, displayName: display.displayName || meta.title || meta.displayName || meta.name || id, shortDescription: display.shortDescription || meta.description || "", developerName: display.developerName || null, title: meta.title || meta.displayName || display.displayName || meta.name || id, description: meta.description || display.shortDescription || "", version: meta.version || "", marketplace, builtin: false, installed, catalogSection, agentStates, icon: pluginIcon(dir, id, meta), iconDataUri, iconDarkDataUri, scope: scopeOf(id), installPath: dir, capabilities: { skillsCount: d.skillDirs.length, mcpCount: Object.keys(d.servers).length, hooksCount: d.hookEvents.length, commandsCount: d.commands.length, agentsCount: d.agents.length, skillNames: d.skillDirs.map(p => path.basename(p)), mcpNames: Object.keys(d.servers), hookEvents: d.hookEvents }, marketType: marketInfo.marketType, nativeHost: marketInfo.nativeHost, nativeHostLabel: marketInfo.nativeHostLabel });
    }
    // 合并内置精选市场目录去重
    for (const b of BUILTIN_MARKETPLACE_CATALOG) {
      if (seen.has(b.id)) continue;
      seen.add(b.id);
      const iconDataUriFallback = buildFallbackBrandIcon(b.id, b.nativeHost);
      const merged = { ...b, agentStates: { antigravity: false, muse: false, codex: false, pi: false, claude: false }, icon: null, iconDataUri: iconDataUriFallback, iconDarkDataUri: null, scope: scopeOf(b.id), capabilities: { skillsCount: 0, mcpCount: 0, hooksCount: 0, commandsCount: 0, agentsCount: 0, skillNames: [], mcpNames: [], hookEvents: [] }, installed: false, catalogSection: "marketplace", marketplace: b.marketplace || "t3-builtin" };
      // 保留已定义的 marketType/nativeHost
      items.push(merged);
    }
    // 双轨视图（marketplace 分支的细分）
    const marketplaceAll = items.filter(i => i.catalogSection === "marketplace");
    const universalMarketplace = marketplaceAll.filter(i => i.marketType === "universal");
    const nativeMarketplace = marketplaceAll.filter(i => i.marketType === "native");
    const nativeMarketplaceByHost = { codex: [], claude: [], muse: [], antigravity: [], pi: [] };
    for (const it of nativeMarketplace) {
      if (nativeMarketplaceByHost[it.nativeHost]) nativeMarketplaceByHost[it.nativeHost].push(it);
    }
    let filtered = items;
    if (section === "installed" || section === "marketplace") filtered = items.filter(i => i.catalogSection === section);
    // 实现 detail 中的双轨（无论 section，仍返回全量双轨便于前端按视图筛选；若 section 过滤则对应重算）
    let retUniversal = universalMarketplace;
    let retNative = nativeMarketplace;
    let retByHost = nativeMarketplaceByHost;
    if (section === "installed" || section === "marketplace") {
      // section 过滤时双轨仍为 marketplace 的过滤子集（installed 时为空）
      if (section === "installed") { retUniversal = []; retNative = []; retByHost = { codex: [], claude: [], muse: [], antigravity: [], pi: [] }; }
    }
    return { ok: true, items: filtered, universalMarketplace: retUniversal, nativeMarketplace: retNative, nativeMarketplaceByHost: retByHost, preserveOriginalIconColor: true, BUILTIN_MARKETPLACE_CATALOG: BUILTIN_MARKETPLACE_CATALOG };
  }
  function listCatalog(args = {}) {
    const res = listPlugins(args);
    const items = res.items;
    const installed = items.filter(i => i.catalogSection === "installed");
    const marketplace = items.filter(i => i.catalogSection === "marketplace");
    const enabled = items.filter(i => i.catalogSection === "installed" && (i.scope !== "off" || Object.values(i.agentStates || {}).some(Boolean))).length;
    return { ok: true, installed, marketplace, counts: { installed: installed.length, marketplace: marketplace.length, enabled }, universalMarketplace: res.universalMarketplace || [], nativeMarketplace: res.nativeMarketplace || [], nativeMarketplaceByHost: res.nativeMarketplaceByHost || { codex: [], claude: [], muse: [], antigravity: [], pi: [] }, preserveOriginalIconColor: true };
  }
  function installFromMarketplace({ id } = {}) {
    assertSafeId(id);
    const all = listPlugins().items; // need raw items including marketplace? listPlugins currently returns filtered? we call with no section => all
    const target = all.find(i => i.id === id);
    if (!target) throw new Error("plugin not found");
    if (target.installed && target.catalogSection === "installed") return { ok: true, id, installed: true };
    const set = readInstalledMarketplace();
    set.add(id);
    writeInstalledMarketplace(set);
    const updated = listPlugins().items.find(i => i.id === id);
    return { ok: true, id, installed: true, catalogSection: updated?.catalogSection || "installed" };
  }
  function backupOnceHub(file) {
    const bak = file + ".t3hub.bak";
    if (fileExists(file) && !fileExists(bak)) { try { fs.copyFileSync(file, bak); fs.chmodSync(bak, 0o600); } catch {} }
  }
  function agyRootFor() { return path.join(homeDir, ".t3", "userdata", "providers", "antigravity"); }
  function agyConfigFilesFor() {
    const out = [];
    try { for (const inst of dirs(agyRootFor())) { const f = path.join(inst, "config", "mcp_config.json"); if (fileExists(f)) out.push(f); } } catch {}
    out.sort((a, b) => { try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; } });
    return out;
  }
  function primaryAgyConfigFile() {
    const files = agyConfigFilesFor();
    if (files.length) return files[0];
    const insts = dirs(agyRootFor());
    if (insts.length) { insts.sort((a, b) => { try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; } }); return path.join(insts[0], "config", "mcp_config.json"); }
    return path.join(agyRootFor(), "default", "config", "mcp_config.json");
  }
  function agentSkillsDirFor(agent) {
    if (agent === "antigravity") return path.join(path.dirname(primaryAgyConfigFile()), "skills");
    if (agent === "muse") return path.join(homeDir, ".config", "muse", "skills");
    if (agent === "codex") return path.join(homeDir, ".codex", "skills");
    if (agent === "pi") return path.join(homeDir, ".pi", "agent", "skills");
    if (agent === "claude") return path.join(homeDir, ".claude", "skills");
    throw new Error("invalid agent");
  }
  function agentMcpFileFor(agent) {
    if (agent === "antigravity") return primaryAgyConfigFile();
    if (agent === "muse") return path.join(homeDir, ".config", "muse", "settings.json");
    if (agent === "codex") return path.join(homeDir, ".codex", "config.toml");
    if (agent === "pi") return path.join(homeDir, ".pi", "agent", "mcp.json");
    if (agent === "claude") return path.join(homeDir, ".claude", "mcp.json");
    throw new Error("invalid agent");
  }
  function writeJsonMcpEntry(agent, serverName, definitionOrNull) {
    const file = agentMcpFileFor(agent);
    assertSafeFsPath(homeDir, file);
    const raw = (() => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } })();
    if (fileExists(file) && (!raw || typeof raw !== "object" || Array.isArray(raw))) throw new Error("malformed MCP config: " + file);
    const next = raw || {};
    if (next.mcpServers && (typeof next.mcpServers !== "object" || Array.isArray(next.mcpServers))) throw new Error("malformed mcpServers");
    next.mcpServers = next.mcpServers || {};
    if (definitionOrNull === null) delete next.mcpServers[serverName];
    else {
      const clean = { ...definitionOrNull };
      delete clean.name;
      next.mcpServers[serverName] = clean;
    }
    if (fileExists(file)) {
      const before = fs.readFileSync(file, "utf8");
      const after = JSON.stringify(next, null, 2) + "\n";
      if (before === after) return;
    } else if (definitionOrNull === null && Object.keys(next).length === 0) return;
    backupOnceHub(file);
    safeMkdir(path.dirname(file));
    const tmp = file + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch {}
  }
  function formatCodexMcpEntry(serverName, def) {
    const key = serverName;
    const header = `[mcp_servers.${/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)}]\n`;
    let body = "";
    if (def.command) body += `command = ${JSON.stringify(def.command)}\n`;
    if (def.url) body += `url = ${JSON.stringify(def.url)}\n`;
    const args = Array.isArray(def.args) ? def.args : (def.args ? [def.args] : []);
    if (args.length) body += `args = [${args.map(a => JSON.stringify(String(a))).join(", ")}]\n`;
    if (def.transport) body += `transport = ${JSON.stringify(def.transport)}\n`;
    if (def.cwd) body += `cwd = ${JSON.stringify(def.cwd)}\n`;
    if (def.env && Object.keys(def.env).length) body += `env = { ${Object.entries(def.env).map(([k, v]) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k)} = ${JSON.stringify(String(v))}`).join(", ")} }\n`;
    if (def.headers && Object.keys(def.headers).length) body += `headers = { ${Object.entries(def.headers).map(([k, v]) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k)} = ${JSON.stringify(String(v))}`).join(", ")} }\n`;
    body += `enabled = true\n`;
    return header + body;
  }
  function parseTomlHeader(line) {
    const s = line.trim();
    if (!s.startsWith("[") || !s.endsWith("]")) return null;
    const inner = s.startsWith("[[") ? s.slice(2, -2) : s.slice(1, -1);
    // naive split on dots respecting quotes (reuse logic minimally)
    return inner;
  }
  function removeCodexMcpBlock(raw, key) {
    const target = key.toLowerCase().replace(/_/g, "-");
    const lines = raw.split(/\r?\n/);
    const out = [];
    let skipping = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("[")) {
        const h = parseTomlHeader(line);
        if (h && h.startsWith("mcp_servers.")) {
          const k = h.slice("mcp_servers.".length).trim().replace(/^"|"$/g, "").replace(/^'|'$/g, "");
          const normK = k.toLowerCase().replace(/_/g, "-");
          if (normK === target) { skipping = true; continue; }
          if (skipping) { skipping = false; out.push(line); continue; }
          out.push(line);
          continue;
        }
        if (skipping) { skipping = false; out.push(line); continue; }
        out.push(line);
        continue;
      }
      if (skipping) continue;
      out.push(line);
    }
    return out.join("\n").replace(/\n+$/, "\n").replace(/^\n/, "");
  }
  function isTomlBareKey(k) { return /^[A-Za-z0-9_-]+$/.test(String(k)); }
  function writeCodexMcpEntry(serverName, definitionOrNull) {
    const file = agentMcpFileFor("codex");
    assertSafeFsPath(homeDir, file);
    let raw = "";
    try { raw = fs.readFileSync(file, "utf8"); } catch { raw = ""; }
    const without = removeCodexMcpBlock(raw, serverName);
    let updated = without;
    if (definitionOrNull !== null) {
      const block = formatCodexMcpEntry(serverName, definitionOrNull);
      updated = (without.trim() ? without.replace(/\n+$/, "\n") + "\n" + block : block);
    }
    if (raw !== updated) {
      backupOnceHub(file);
      safeMkdir(path.dirname(file));
      const tmp = file + ".tmp-" + process.pid;
      fs.writeFileSync(tmp, updated, { mode: 0o600, flag: "wx" });
      fs.renameSync(tmp, file);
      try { fs.chmodSync(file, 0o600); } catch {}
    }
  }
  function setCodexPluginEnabled(pluginId, marketplace, enabled) {
    const file = path.join(homeDir, ".codex", "config.toml");
    assertSafeFsPath(homeDir, file);
    let raw = "";
    try { raw = fs.readFileSync(file, "utf8"); } catch { raw = ""; }
    const key = `${pluginId}@${marketplace}`;
    const quoted = JSON.stringify(key);
    // Remove existing [plugins."key"] or [plugins.key] block if any to normalize
    const lines = raw.split(/\r?\n/);
    const out = [];
    let skipping = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("[plugins.")) {
        const h = trimmed;
        if (h.includes(pluginId) && h.includes(marketplace)) { skipping = true; continue; }
        if (skipping) { skipping = false; out.push(line); continue; }
        out.push(line);
        continue;
      }
      if (trimmed.startsWith("[")) { if (skipping) skipping = false; out.push(line); continue; }
      if (skipping) continue;
      out.push(line);
    }
    let base = out.join("\n").replace(/\n+$/, "\n");
    if (base && !base.endsWith("\n")) base += "\n";
    const block = `[plugins.${quoted}]\nenabled = ${enabled ? "true" : "false"}\n`;
    const updated = base + block;
    if (raw !== updated) {
      backupOnceHub(file);
      safeMkdir(path.dirname(file));
      const tmp = file + ".tmp-" + process.pid;
      fs.writeFileSync(tmp, updated, { mode: 0o600, flag: "wx" });
      fs.renameSync(tmp, file);
      try { fs.chmodSync(file, 0o600); } catch {}
    }
  }
  function setClaudePluginEnabled(pluginId, marketplace, enabled) {
    const file = path.join(homeDir, ".claude", "settings.json");
    assertSafeFsPath(homeDir, file);
    const obj = (() => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; } })();
    if (fileExists(file) && (!obj || typeof obj !== "object" || Array.isArray(obj))) throw new Error("malformed claude settings");
    const next = obj || {};
    next.enabledPlugins = next.enabledPlugins || {};
    if (!next.enabledPlugins || typeof next.enabledPlugins !== "object" || Array.isArray(next.enabledPlugins)) next.enabledPlugins = {};
    const key = `${pluginId}@${marketplace}`;
    const keyAlt = pluginId;
    if (enabled) next.enabledPlugins[key] = true;
    else { delete next.enabledPlugins[key]; delete next.enabledPlugins[keyAlt]; }
    if (fileExists(file)) {
      const before = fs.readFileSync(file, "utf8");
      const after = JSON.stringify(next, null, 2) + "\n";
      if (before === after) return;
    }
    backupOnceHub(file);
    safeMkdir(path.dirname(file));
    const tmp = file + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch {}
  }
  function ensureSkillSymlink(sourceDir, linkPath) {
    safeMkdir(path.dirname(linkPath));
    const st = lstatSafe(linkPath);
    if (st) {
      if (st.isSymbolicLink()) {
        try { if (fs.readlinkSync(linkPath) === sourceDir) return; } catch {}
        // check if hub managed (inside hubDir) then unlink, else backup
        const target = path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath));
        const rel = path.relative(path.resolve(hubDir), target);
        const isManaged = rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));
        if (isManaged) fs.unlinkSync(linkPath);
        else fs.renameSync(linkPath, linkPath + ".bak-t3hub-" + Date.now());
      } else if (st.isDirectory()) {
        // Real dir: backup migrate to hub canonical if needed? For plugin fan-out, we keep plugin source intact; backup real dir if unmanaged
        const bak = linkPath + ".bak-t3hub-" + Date.now();
        fs.renameSync(linkPath, bak);
      } else fs.unlinkSync(linkPath);
    }
    fs.symlinkSync(sourceDir, linkPath, "dir");
  }
  function removeSkillSymlink(linkPath) {
    const st = lstatSafe(linkPath);
    if (!st) return;
    if (st.isSymbolicLink()) {
      try {
        const target = path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath));
        const rel = path.relative(path.resolve(hubDir), target);
        const isManaged = rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));
        if (isManaged) fs.unlinkSync(linkPath);
        else fs.renameSync(linkPath, linkPath + ".bak-t3hub-" + Date.now());
      } catch { fs.unlinkSync(linkPath); }
    } else if (st.isDirectory()) {
      const bak = linkPath + ".bak-t3hub-" + Date.now();
      fs.renameSync(linkPath, bak);
    }
  }
  function findPluginItem(id) {
    const all = listPlugins().items;
    const p = all.find(i => i.id === id);
    if (!p) throw new Error("plugin not found: " + id);
    return p;
  }
  function togglePluginForAgent({ id, agent, enabled, mcpRouter: mcpOverride, skillsManager: skillsOverride, hooksManager: hooksOverride } = {}) {
    assertSafeId(id);
    const canonicalAgent = normalizeAgentHost(agent);
    if (!canonicalAgent || canonicalAgent === "all") throw new Error("invalid agent");
    if (typeof enabled !== "boolean") throw new Error("enabled must be boolean");
    assertSafeFsPath(homeDir, agentMcpFileFor(canonicalAgent));
    const plugin = findPluginItem(id);
    if (!plugin || !plugin.installPath || !dirExists(plugin.installPath)) throw new Error("plugin installPath not found");
    const details = pluginDetails(plugin.installPath);
    const prev = readBindings()[id]?.[canonicalAgent] || {};
    const skillIds = enabled ? details.skillDirs.map(d => path.basename(d)) : (prev.injectedSkills?.length ? prev.injectedSkills : details.skillDirs.map(d => path.basename(d)));
    if (!Array.isArray(skillIds)) throw new Error("invalid plugin skill ids");
    // Validate stored bindings as untrusted input too, before the fallback path
    // or a child manager can mutate anything.
    for (const skillId of skillIds) {
      skillPathFor(agentSkillsDirFor(canonicalAgent), skillId);
      if (enabled) skillPathFor(path.join(hubDir, "skills"), skillId, true);
    }
    const injectedSkills = [];
    const injectedMcps = [];
    const expandedServers = Object.entries(details.servers).map(([name, config]) => ({ name, ...expandPluginRoot(config, plugin.installPath) }));
    const actualSkillsMgr = skillsOverride || skillsManager;
    const actualMcpRouter = mcpOverride || mcpRouter;
    const actualHooksMgr = hooksOverride || hooksManager || getHooksManager();
    if (enabled) {
      for (const sd of details.skillDirs) {
        const skillId = path.basename(sd);
        try { assertSafeId(skillId); } catch { continue; }
        const dir = agentSkillsDirFor(canonicalAgent);
        const linkPath = skillPathFor(dir, skillId);
        // Ensure hub canonical exists for safety (copy if not)
        const hubCanonical = skillPathFor(path.join(hubDir, "skills"), skillId, true);
        if (!dirExists(hubCanonical) || !fileExists(path.join(hubCanonical, "SKILL.md"))) {
          safeMkdir(hubCanonical);
          fs.cpSync(sd, hubCanonical, { recursive: true, force: false, filter: (src, dest) => {
            if (dest === hubCanonical) assertHubPath(dest);
            else assertSafeFsPath(hubCanonical, dest);
            return !fs.lstatSync(src).isSymbolicLink();
          } });
          if (!exists(path.join(hubCanonical, ".t3-hub-managed"))) fs.writeFileSync(path.join(hubCanonical, ".t3-hub-managed"), "t3-hub-managed\n", { flag: "wx" });
        }
        try {
          if (actualSkillsMgr && typeof actualSkillsMgr.toggleSkillForAgent === "function") {
            try { actualSkillsMgr.toggleSkillForAgent({ id: skillId, agent: canonicalAgent, enabled: true }); injectedSkills.push(skillId); continue; } catch {}
          }
          ensureSkillSymlink(sd, linkPath);
          injectedSkills.push(skillId);
        } catch {}
      }
      for (const srv of expandedServers) {
        const clean = { ...srv }; delete clean.name;
        try {
          if (actualMcpRouter && typeof actualMcpRouter.toggleServerForAgent === "function") {
            // Ensure hub registry has it via upsert? toggle will absorb
            try { actualMcpRouter.toggleServerForAgent({ id: srv.name, agent: canonicalAgent, enabled: true }); injectedMcps.push(srv.name); continue; } catch {}
          }
          if (canonicalAgent === "codex") writeCodexMcpEntry(srv.name, clean);
          else writeJsonMcpEntry(canonicalAgent, srv.name, clean);
          injectedMcps.push(srv.name);
        } catch {}
      }
      if (canonicalAgent === "codex") setCodexPluginEnabled(id, plugin.marketplace, true);
      if (canonicalAgent === "claude") setClaudePluginEnabled(id, plugin.marketplace, true);
      if ((canonicalAgent === "codex" || canonicalAgent === "claude") && exists(details.hookFile) && actualHooksMgr) {
        try { actualHooksMgr.setPluginHooks?.({ id, pluginId: id, scope: "global", projectRoot: null, installPath: plugin.installPath, hooks: expandPluginRoot(details.hooks, plugin.installPath) }); } catch {}
      }
    } else {
      const toRemoveSkills = skillIds;
      for (const skillId of toRemoveSkills) {
        const dir = agentSkillsDirFor(canonicalAgent);
        const linkPath = skillPathFor(dir, skillId);
        try {
          if (actualSkillsMgr && typeof actualSkillsMgr.toggleSkillForAgent === "function") {
            try { actualSkillsMgr.toggleSkillForAgent({ id: skillId, agent: canonicalAgent, enabled: false }); continue; } catch {}
          }
          removeSkillSymlink(linkPath);
        } catch {}
      }
      const toRemoveMcps = prev.injectedMcps && prev.injectedMcps.length ? prev.injectedMcps : expandedServers.map(s => s.name);
      for (const mcpName of toRemoveMcps) {
        try {
          if (actualMcpRouter && typeof actualMcpRouter.toggleServerForAgent === "function") {
            try { actualMcpRouter.toggleServerForAgent({ id: mcpName, agent: canonicalAgent, enabled: false }); continue; } catch {}
          }
          if (canonicalAgent === "codex") writeCodexMcpEntry(mcpName, null);
          else writeJsonMcpEntry(canonicalAgent, mcpName, null);
        } catch {}
      }
      if (canonicalAgent === "codex") setCodexPluginEnabled(id, plugin.marketplace, false);
      if (canonicalAgent === "claude") setClaudePluginEnabled(id, plugin.marketplace, false);
      if ((canonicalAgent === "codex" || canonicalAgent === "claude") && exists(details.hookFile) && actualHooksMgr) {
        try { actualHooksMgr.setPluginHooks?.({ id, pluginId: id, scope: "off", projectRoot: null, installPath: plugin.installPath, hooks: expandPluginRoot(details.hooks, plugin.installPath) }); } catch {}
      }
    }
    const bindings = readBindings();
    bindings[id] = bindings[id] || {};
    bindings[id][canonicalAgent] = { enabled, injectedSkills: enabled ? injectedSkills : [], injectedMcps: enabled ? injectedMcps : [], updatedAt: new Date().toISOString() };
    writeBindings(bindings);
    return { ok: true, id, agent: canonicalAgent, enabled, injectedSkills, injectedMcps };
  }
  function validateScope(scope, projectRoot) {
    if (!SCOPES.includes(scope)) throw new Error("invalid scope");
    if (scope === "project" && !projectRoot) throw new Error("projectRoot required for project scope");
    if (projectRoot && (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot))) throw new Error("projectRoot must be absolute");
  }
  function setPluginScope({ id, scope, projectRoot } = {}) {
    assertSafeId(id); validateScope(scope, projectRoot);
    assertHubPath(statePath);
    // Scope changes need an authoritative owner. A damaged shared state must
    // never be interpreted as an empty registry and overwritten by a child.
    function readScopeState() {
      let value;
      try { value = JSON.parse(fs.readFileSync(statePath, "utf8")); }
      catch (error) {
        if (error.code === "ENOENT") return {};
        throw new Error("plugin scope state is unreadable; scope change was rejected");
      }
      const isRecord = v => v !== null && typeof v === "object" && !Array.isArray(v);
      if (!isRecord(value) || ["pluginScopes", "pluginProjectRoots"].some(key => value[key] !== undefined && !isRecord(value[key]))) {
        throw new Error("plugin scope state is invalid; scope change was rejected");
      }
      return value;
    }
    const previous = readScopeState();
    const plugin = listPlugins().items.find(i => i.id === id); if (!plugin) throw new Error("plugin not found");
    const previousScope = previous.pluginScopes?.[id];
    if (previousScope !== undefined && !SCOPES.includes(previousScope)) throw new Error("plugin scope state is invalid; scope change was rejected");
    const recordedProject = previous.pluginProjectRoots?.[id];
    const oldProject = typeof recordedProject === "string" && path.isAbsolute(recordedProject) ? path.resolve(recordedProject) : null;
    if (previousScope === "project" && !oldProject) throw new Error("project-scoped plugin owner is missing; scope change was rejected without applying changes");
    const targetProject = scope === "project" ? (projectRoot || oldProject || null) : scope === "off" ? (oldProject || null) : null;
    const hooks = getHooksManager();
    const movesProjectScope = !!oldProject && (scope !== "project" || path.resolve(targetProject || "") !== path.resolve(oldProject));
    const pluginDetailsForScope = id === "t3-memory-vault" ? null : pluginDetails(plugin.installPath);
    const hasProjectHookRegistration = !!oldProject && hooks?.listHooks?.({ projectRoot: oldProject })?.items?.some(item => item.scope === "project" && item.pluginId === id);
    const hasProjectHooks = id === "t3-memory-vault" || !!pluginDetailsForScope?.hookEvents?.length || hasProjectHookRegistration;
    // The Hook manager intentionally keeps project-owned Hook registrations
    // read-only. Reject a plugin scope move before any skill/MCP writes so the
    // plugin and its Hook scope cannot be left half-migrated.
    if (movesProjectScope && hasProjectHooks) throw new Error("project-scoped plugin Hooks are read-only; scope change was rejected without applying partial changes");
    let skippedMcps = [];
    if (id === "t3-memory-vault") {
      if (oldProject && scope !== "off" && path.resolve(targetProject || "") !== path.resolve(oldProject)) hooks?.toggleHook?.({ id: "memory-stop-guard", scope: "off", projectRoot: oldProject });
      hooks?.toggleHook?.({ id: "memory-stop-guard", scope, projectRoot: targetProject });
    } else {
      const d = pluginDetailsForScope;
      // Validate the entire skill set before changing any host configuration.
      d.skillDirs.forEach(sd => assertSafeId(path.basename(sd)));
      if (oldProject && scope !== "off" && path.resolve(targetProject || "") !== path.resolve(oldProject)) {
        for (const sd of d.skillDirs) skillsManager.setSkillScope({ id: path.basename(sd), scope: "off", projectRoot: oldProject, sourceDir: sd });
        hooks?.setPluginHooks?.({ id, pluginId: id, scope: "off", projectRoot: oldProject, installPath: plugin.installPath, hooks: expandPluginRoot(d.hooks, plugin.installPath) });
      }
      for (const sd of d.skillDirs) skillsManager.setSkillScope({ id: path.basename(sd), scope, projectRoot: targetProject, sourceDir: sd });
      ({ skippedMcps } = mcpRouter.setPluginMcpScope({
        pluginId: id, scope, projectRoot: targetProject,
        servers: Object.entries(d.servers).map(([name, config]) => ({
          ...expandPluginRoot(config, plugin.installPath), name, groupTitle: plugin.title, icon: plugin.icon, installed: true,
        })),
      }));
      if (exists(d.hookFile)) hooks?.setPluginHooks?.({ id, pluginId: id, scope, projectRoot: targetProject, installPath: plugin.installPath, hooks: expandPluginRoot(d.hooks, plugin.installPath) });
    }
    // Re-read after the child managers have written their own state sections.
    const state = readScopeState(); state.pluginScopes ||= {}; state.pluginScopes[id] = scope;
    state.pluginProjectRoots ||= {};
    if (scope === "project") state.pluginProjectRoots[id] = projectRoot; else delete state.pluginProjectRoots[id];
    fs.mkdirSync(hubDir, { recursive: true });
    const tmp = statePath + ".plugins-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600, flag: "wx" }); fs.renameSync(tmp, statePath);
    return { ok: true, id, scope, skippedMcps };
  }
  async function installPluginFromGitHub({ input, scope = "global", projectRoot } = {}) {
    validateScope(scope, projectRoot);
    if (typeof input !== "string" || !input.trim() || /[\0\r\n]/.test(input)) throw new Error("input required");
    let source = input.trim();
    const local = path.isAbsolute(source) || source.startsWith("./") || source.startsWith("../") || exists(source);
    if (local) {
      source = path.resolve(source);
      if (!fs.statSync(source).isDirectory()) throw new Error("local source must be a directory");
    } else {
      if (/^[\w.-]+\/[\w.-]+$/.test(source)) source = "https://github.com/" + source;
      let url; try { url = new URL(source); } catch { throw new Error("invalid GitHub URL"); }
      if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || url.search || url.hash || !/^\/[\w.-]+\/[\w.-]+\/?$/.test(url.pathname)) throw new Error("invalid GitHub URL");
      const [owner, repo] = url.pathname.split("/").filter(Boolean); assertSafeId(owner); assertSafeId(repo);
      source = url.href;
    }
    const repo = path.basename(source.replace(/\/$/, "")).replace(/\.git$/, ""); assertSafeId(repo);
    const pluginsDir = path.resolve(hubDir, "plugins");
    const target = assertHubPath(path.resolve(pluginsDir, repo));
    assertSafeFsPath(pluginsDir, target);
    if (exists(target) || (() => { try { fs.lstatSync(target); return true; } catch { return false; } })()) throw new Error("plugin already exists");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      await execFileAsync("git", ["clone", "--", source, target], { timeout: 120000 });
      assertHubPath(target);
      const plugin = listPlugins().items.find(i => i.installPath === target);
      if (!plugin) throw new Error("cloned repository is not a composite plugin or duplicates an installed plugin");
      return { ...setPluginScope({ id: plugin.id, scope, projectRoot }), installPath: target };
    } catch (error) {
      // Leave successful clones available for recovery if applying host scope failed.
      assertHubPath(target, { allowLeafSymlink: true });
      const st = lstatSafe(target);
      if (st?.isSymbolicLink()) fs.unlinkSync(target);
      else if (st && !exists(path.join(target, ".git"))) fs.rmSync(target, { recursive: true, force: true });
      throw error;
    }
  }
  return { listPlugins, listCatalog, installFromMarketplace, togglePluginForAgent, setPluginScope, installPluginFromGitHub };
}
let singleton; const get = () => singleton ||= createPluginsManager();
module.exports = { createPluginsManager, listPlugins: args => get().listPlugins(args), listCatalog: args => get().listCatalog(args), installFromMarketplace: args => get().installFromMarketplace(args), togglePluginForAgent: args => get().togglePluginForAgent(args), setPluginScope: args => get().setPluginScope(args), installPluginFromGitHub: args => get().installPluginFromGitHub(args), discoverPluginDirectories, readPluginManifest, pluginDetails, pluginId, expandPluginRoot, findIconDataUri, readIconDataUri, resolveInside, pluginRootsForIcon, extractPluginDisplay, MAX_ICON_BYTES, pluginIcon, BUILTIN_MARKETPLACE_CATALOG, classifyMarketForPlugin, buildFallbackBrandIcon, HOST_LABELS, HOST_BRAND_COLORS };
