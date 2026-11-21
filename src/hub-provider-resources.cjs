"use strict";

/**
 * Standalone Provider Resource Inspector & Toggle (Read + Enable/Disable ONLY).
 * 100% independent — zero third-party manager dependencies, zero install/delete APIs.
 * Reads native configs for Codex, Antigravity, Claude Code, and Muse, and toggles
 * MCP servers, Skills, and Plugins safely in place while preserving secrets and unknown fields.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PROVIDERS = [
  { id: "codex", label: "Codex" },
  { id: "antigravity", label: "Antigravity" },
  { id: "claude", label: "Claude Code" },
  { id: "muse", label: "Muse" },
];

const DISABLED_SKILLS_DIRNAME = ".disabled-skills";

function safeStat(p) {
  try { return fs.statSync(p); } catch { return null; }
}
function safeLstat(p) {
  try { return fs.lstatSync(p); } catch { return null; }
}
function readTextIfFile(p, maxBytes = 1024 * 1024) {
  const st = safeLstat(p);
  if (!st || st.isSymbolicLink() || !st.isFile() || st.size > maxBytes) return null;
  try { return fs.readFileSync(p, "utf8"); } catch { return null; }
}
function readJsonSafe(p) {
  const text = readTextIfFile(p);
  if (text == null) return null;
  try {
    const obj = JSON.parse(text);
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}
function writeTextAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const existing = safeLstat(filePath);
  if (existing && existing.isSymbolicLink()) throw new Error("拒绝写入符号链接配置: " + filePath);
  const mode = existing ? (existing.mode & 0o777) : 0o600;
  const tmp = `${filePath}.t3hud.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, { encoding: "utf8", mode });
  try { fs.chmodSync(tmp, mode); } catch {}
  fs.renameSync(tmp, filePath);
}

function listSubdirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith(".") && (e.isDirectory() || e.isSymbolicLink()))
      .map((e) => ({ name: e.name, fullPath: path.join(dir, e.name), isSymlink: e.isSymbolicLink() }));
  } catch {
    return [];
  }
}

function parseSkillFrontmatter(skillDir) {
  const skillMd = path.join(skillDir, "SKILL.md");
  const st = safeStat(skillMd);
  if (!st || !st.isFile()) return { name: path.basename(skillDir), description: "" };
  let head = "";
  try {
    const fd = fs.openSync(skillMd, "r");
    try {
      const buf = Buffer.alloc(Math.min(st.size, 4096));
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      head = buf.subarray(0, n).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { name: path.basename(skillDir), description: "" };
  }
  const fm = head.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return { name: path.basename(skillDir), description: "" };
  const body = fm[1];
  const nameMatch = body.match(/^name:\s*(.+)$/m);
  const descMatch = body.match(/^description:\s*(.+)$/m);
  const clean = (v) => String(v || "").trim().replace(/^["']|["']$/g, "");
  return {
    name: clean(nameMatch?.[1]) || path.basename(skillDir),
    description: clean(descMatch?.[1]).slice(0, 140),
  };
}

/**
 * Parse top-level TOML tables of form `[prefix.key]` or `[prefix."key"]`.
 * Returns list of `{ key, headerLineIndex, endLineIndex, enabled, rawSection }`.
 */
function parseTomlTables(text, prefix) {
  const lines = String(text || "").split(/\r?\n/);
  const headerRe = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/;
  const sections = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headerRe);
    if (!m) continue;
    const rawHeader = m[1].trim();
    sections.push({ rawHeader, start: i, end: lines.length });
    if (sections.length > 1) sections[sections.length - 2].end = i;
  }
  const out = [];
  const pfx = `${prefix}.`;
  for (const sec of sections) {
    if (!sec.rawHeader.startsWith(pfx)) continue;
    let rest = sec.rawHeader.slice(pfx.length).trim();
    let key;
    if (rest.startsWith('"')) {
      const endQuote = rest.indexOf('"', 1);
      if (endQuote <= 1) continue;
      // Skip nested sub-tables like [mcp_servers."foo".env]
      if (rest.slice(endQuote + 1).trim() !== "") continue;
      key = rest.slice(1, endQuote);
    } else {
      if (rest.includes(".")) continue;
      key = rest;
    }
    let enabled = true;
    for (let j = sec.start + 1; j < sec.end; j++) {
      const em = lines[j].match(/^\s*enabled\s*=\s*(true|false)\b/);
      if (em) {
        enabled = em[1] === "true";
        break;
      }
    }
    let summary = "";
    for (let j = sec.start + 1; j < sec.end; j++) {
      const um = lines[j].match(/^\s*(?:url|command)\s*=\s*"([^"]+)"/);
      if (um) {
        summary = um[1].replace(/(\/\/)[^@\s/:]+:[^@\s/]+@/g, "$1***:***@").slice(0, 90);
        break;
      }
    }
    out.push({ key, start: sec.start, end: sec.end, enabled, summary });
  }
  return out;
}

function toggleTomlTableEnabled(filePath, prefix, key, nextEnabled) {
  const text = readTextIfFile(filePath);
  if (text == null) throw new Error("配置文件不存在或不可读");
  const lines = text.split(/\r?\n/);
  const tables = parseTomlTables(text, prefix);
  const target = tables.find((t) => t.key === key);
  if (!target) throw new Error(`未找到配置项: ${prefix}.${key}`);
  let updated = false;
  for (let j = target.start + 1; j < target.end; j++) {
    if (/^\s*enabled\s*=\s*(true|false)\b/.test(lines[j])) {
      lines[j] = lines[j].replace(/(^\s*enabled\s*=\s*)(true|false)\b/, `$1${nextEnabled ? "true" : "false"}`);
      updated = true;
      break;
    }
  }
  if (!updated) {
    lines.splice(target.start + 1, 0, `enabled = ${nextEnabled ? "true" : "false"}`);
  }
  writeTextAtomic(filePath, lines.join("\n"));
  return { ok: true, enabled: Boolean(nextEnabled) };
}

function discoverProviderPaths(homeDir) {
  const t3Providers = path.join(homeDir, ".t3", "userdata", "providers");
  const t3Instances = (driver) => listSubdirs(path.join(t3Providers, driver)).map((d) => d.fullPath);

  // Codex: ~/.codex + any T3 codex instance dirs
  const codexTomls = [path.join(homeDir, ".codex", "config.toml")];
  const codexSkillDirs = [path.join(homeDir, ".codex", "skills"), path.join(homeDir, ".agents", "skills")];
  for (const inst of t3Instances("codex")) {
    codexTomls.push(path.join(inst, "config.toml"));
    codexSkillDirs.push(path.join(inst, "skills"));
  }

  // Antigravity: T3 AGY instances + ~/.gemini/antigravity (never touching auth/endpoints)
  const agyMcpFiles = [];
  const agySkillDirs = [];
  for (const inst of t3Instances("antigravity")) {
    agyMcpFiles.push(path.join(inst, "config", "mcp_config.json"));
    agySkillDirs.push(path.join(inst, "config", "skills"));
  }
  agyMcpFiles.push(path.join(homeDir, ".gemini", "antigravity", "mcp_config.json"));
  agySkillDirs.push(path.join(homeDir, ".gemini", "antigravity", "skills"));

  // Claude Code: ~/.claude.json + ~/.claude/settings.json + ~/.claude/skills
  const claudeMcpFiles = [path.join(homeDir, ".claude.json"), path.join(homeDir, ".claude", "settings.json")];
  const claudeSettingsFiles = [path.join(homeDir, ".claude", "settings.json")];
  const claudeSkillDirs = [path.join(homeDir, ".claude", "skills")];
  for (const inst of t3Instances("claudeAgent")) {
    claudeMcpFiles.push(path.join(inst, ".claude.json"), path.join(inst, "settings.json"));
    claudeSettingsFiles.push(path.join(inst, "settings.json"));
    claudeSkillDirs.push(path.join(inst, "skills"));
  }

  // Muse: ~/.muse + T3 muse instances
  const museMcpFiles = [path.join(homeDir, ".muse", "mcp.json"), path.join(homeDir, ".muse", "settings.json")];
  const museSkillDirs = [path.join(homeDir, ".muse", "skills")];
  for (const inst of t3Instances("muse")) {
    museMcpFiles.push(path.join(inst, "mcp.json"), path.join(inst, "settings.json"));
    museSkillDirs.push(path.join(inst, "skills"));
  }

  const dedupeExisting = (arr, isDir = false) => {
    const seen = new Set();
    const out = [];
    for (const raw of arr) {
      const p = path.resolve(raw);
      if (seen.has(p)) continue;
      const st = safeStat(p);
      if (!st || (isDir ? !st.isDirectory() : !st.isFile())) continue;
      seen.add(p);
      out.push(p);
    }
    return out;
  };

  return {
    codex: { tomls: dedupeExisting(codexTomls, false), skillDirs: dedupeExisting(codexSkillDirs, true) },
    antigravity: { mcpFiles: dedupeExisting(agyMcpFiles, false), skillDirs: dedupeExisting(agySkillDirs, true) },
    claude: { mcpFiles: dedupeExisting(claudeMcpFiles, false), settingsFiles: dedupeExisting(claudeSettingsFiles, false), skillDirs: dedupeExisting(claudeSkillDirs, true) },
    muse: { mcpFiles: dedupeExisting(museMcpFiles, false), skillDirs: dedupeExisting(museSkillDirs, true) },
  };
}

function collectSkillsForDirs(dirs, providerId) {
  const items = [];
  const seen = new Set();
  for (const dir of dirs) {
    for (const entry of listSubdirs(dir)) {
      if (entry.name === DISABLED_SKILLS_DIRNAME) continue;
      const id = `${dir}::${entry.name}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const fm = parseSkillFrontmatter(entry.fullPath);
      items.push({
        id: entry.name,
        name: fm.name || entry.name,
        description: fm.description || "",
        enabled: true,
        provider: providerId,
        kind: "skills",
        sourceDir: dir,
      });
    }
    const disabledDir = path.join(dir, DISABLED_SKILLS_DIRNAME);
    if (safeStat(disabledDir)?.isDirectory()) {
      for (const entry of listSubdirs(disabledDir)) {
        const id = `${dir}::${entry.name}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const fm = parseSkillFrontmatter(entry.fullPath);
        items.push({
          id: entry.name,
          name: fm.name || entry.name,
          description: fm.description || "",
          enabled: false,
          provider: providerId,
          kind: "skills",
          sourceDir: dir,
        });
      }
    }
  }
  items.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
  return items;
}

function collectJsonMcpServers(files, providerId) {
  const items = [];
  const seen = new Set();
  for (const file of files) {
    const obj = readJsonSafe(file);
    if (!obj) continue;
    const map = obj.mcpServers && typeof obj.mcpServers === "object" && !Array.isArray(obj.mcpServers)
      ? obj.mcpServers
      : null;
    if (!map) continue;
    const disabledSet = new Set(Array.isArray(obj.disabledMcpjsonServers) ? obj.disabledMcpjsonServers.map(String) : []);
    for (const [name, cfg] of Object.entries(map)) {
      if (!cfg || typeof cfg !== "object") continue;
      const dedupeKey = `${file}::${name}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const enabled = cfg.disabled === true || cfg.enabled === false || disabledSet.has(name) ? false : true;
      const summary = typeof cfg.url === "string"
        ? cfg.url.replace(/(\/\/)[^@\s/:]+:[^@\s/]+@/g, "$1***:***@").slice(0, 90)
        : [cfg.command, ...(Array.isArray(cfg.args) ? cfg.args.slice(0, 2) : [])].filter(Boolean).join(" ").slice(0, 90);
      items.push({
        id: name,
        name,
        description: summary,
        enabled,
        provider: providerId,
        kind: "mcp",
        sourceFile: file,
      });
    }
  }
  items.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
  return items;
}

function createProviderResourcesManager({ homeDir = os.homedir() } = {}) {
  function listProviderResources() {
    const paths = discoverProviderPaths(homeDir);
    const result = {};

    // Codex
    const codexMcp = [];
    const codexPlugins = [];
    for (const file of paths.codex.tomls) {
      const txt = readTextIfFile(file);
      if (txt == null) continue;
      for (const t of parseTomlTables(txt, "mcp_servers")) {
        codexMcp.push({ id: t.key, name: t.key, description: t.summary, enabled: t.enabled, provider: "codex", kind: "mcp", sourceFile: file });
      }
      for (const t of parseTomlTables(txt, "plugins")) {
        const shortName = t.key.split("@")[0] || t.key;
        const catalog = t.key.includes("@") ? t.key.split("@").slice(1).join("@") : "";
        codexPlugins.push({ id: t.key, name: shortName, description: catalog, enabled: t.enabled, provider: "codex", kind: "plugins", sourceFile: file });
      }
    }
    codexMcp.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
    codexPlugins.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
    result.codex = {
      id: "codex",
      label: "Codex",
      mcp: codexMcp,
      skills: collectSkillsForDirs(paths.codex.skillDirs, "codex"),
      plugins: codexPlugins,
    };

    // Antigravity
    result.antigravity = {
      id: "antigravity",
      label: "Antigravity",
      mcp: collectJsonMcpServers(paths.antigravity.mcpFiles, "antigravity"),
      skills: collectSkillsForDirs(paths.antigravity.skillDirs, "antigravity"),
      plugins: [],
    };

    // Claude Code
    const claudePlugins = [];
    for (const file of paths.claude.settingsFiles) {
      const obj = readJsonSafe(file);
      const ep = obj?.enabledPlugins && typeof obj.enabledPlugins === "object" ? obj.enabledPlugins : null;
      if (!ep) continue;
      for (const [key, val] of Object.entries(ep)) {
        const shortName = key.split("@")[0] || key;
        const catalog = key.includes("@") ? key.split("@").slice(1).join("@") : "";
        claudePlugins.push({ id: key, name: shortName, description: catalog, enabled: val !== false, provider: "claude", kind: "plugins", sourceFile: file });
      }
    }
    claudePlugins.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
    result.claude = {
      id: "claude",
      label: "Claude Code",
      mcp: collectJsonMcpServers(paths.claude.mcpFiles, "claude"),
      skills: collectSkillsForDirs(paths.claude.skillDirs, "claude"),
      plugins: claudePlugins,
    };

    // Muse
    result.muse = {
      id: "muse",
      label: "Muse",
      mcp: collectJsonMcpServers(paths.muse.mcpFiles, "muse"),
      skills: collectSkillsForDirs(paths.muse.skillDirs, "muse"),
      plugins: [],
    };

    return {
      ok: true,
      providers: PROVIDERS.map((p) => {
        const d = result[p.id];
        return {
          ...d,
          counts: { mcp: d.mcp.length, skills: d.skills.length, plugins: d.plugins.length },
        };
      }),
    };
  }

  function toggleProviderResource(payload = {}) {
    const provider = String(payload.provider || "").trim().toLowerCase();
    const kind = String(payload.kind || "").trim().toLowerCase();
    const id = String(payload.id || "").trim();
    const enabled = Boolean(payload.enabled);
    if (!PROVIDERS.some((p) => p.id === provider)) throw new Error("不支持的提供方: " + provider);
    if (!["mcp", "skills", "plugins"].includes(kind)) throw new Error("不支持的资源类型: " + kind);
    if (!id || id.includes("\0") || id.includes("..")) throw new Error("无效的资源标识");

    const paths = discoverProviderPaths(homeDir);

    if (kind === "skills") {
      if (id.includes("/") || id.includes("\\")) throw new Error("无效的技能名称");
      const allowedDirs = paths[provider]?.skillDirs || [];
      const requestedDir = payload.sourceDir ? path.resolve(payload.sourceDir) : null;
      const targetDir = requestedDir ? allowedDirs.find((d) => d === requestedDir) : allowedDirs.find((d) => {
        return safeLstat(path.join(d, id)) || safeLstat(path.join(d, DISABLED_SKILLS_DIRNAME, id));
      });
      if (!targetDir) throw new Error("未找到该提供方的技能目录或条目");
      const activePath = path.join(targetDir, id);
      const disabledRoot = path.join(targetDir, DISABLED_SKILLS_DIRNAME);
      const disabledPath = path.join(disabledRoot, id);
      if (enabled) {
        if (safeLstat(activePath)) return { ok: true, enabled: true };
        if (!safeLstat(disabledPath)) throw new Error("未找到已停用的技能目录");
        fs.renameSync(disabledPath, activePath);
        return { ok: true, enabled: true };
      } else {
        if (safeLstat(disabledPath)) return { ok: true, enabled: false };
        if (!safeLstat(activePath)) throw new Error("未找到该技能目录");
        fs.mkdirSync(disabledRoot, { recursive: true, mode: 0o700 });
        fs.renameSync(activePath, disabledPath);
        return { ok: true, enabled: false };
      }
    }

    if (provider === "codex") {
      const allowedFiles = paths.codex.tomls;
      const requestedFile = payload.sourceFile ? path.resolve(payload.sourceFile) : null;
      const targetFile = requestedFile ? allowedFiles.find((f) => f === requestedFile) : allowedFiles[0];
      if (!targetFile) throw new Error("未找到 Codex 配置文件");
      const prefix = kind === "mcp" ? "mcp_servers" : "plugins";
      return toggleTomlTableEnabled(targetFile, prefix, id, enabled);
    }

    if (kind === "mcp") {
      const allowedFiles = paths[provider]?.mcpFiles || [];
      const requestedFile = payload.sourceFile ? path.resolve(payload.sourceFile) : null;
      const targetFile = requestedFile ? allowedFiles.find((f) => f === requestedFile) : allowedFiles[0];
      if (!targetFile) throw new Error("未找到该提供方的 MCP 配置文件");
      const obj = readJsonSafe(targetFile);
      if (!obj || !obj.mcpServers || !obj.mcpServers[id]) throw new Error(`未找到 MCP 条目: ${id}`);
      const next = { ...obj, mcpServers: { ...obj.mcpServers, [id]: { ...obj.mcpServers[id] } } };
      if (enabled) {
        delete next.mcpServers[id].disabled;
        if (next.mcpServers[id].enabled === false) next.mcpServers[id].enabled = true;
        if (Array.isArray(next.disabledMcpjsonServers)) {
          next.disabledMcpjsonServers = next.disabledMcpjsonServers.filter((x) => x !== id);
        }
      } else {
        next.mcpServers[id].disabled = true;
      }
      writeTextAtomic(targetFile, JSON.stringify(next, null, 2) + "\n");
      return { ok: true, enabled };
    }

    if (kind === "plugins" && provider === "claude") {
      const allowedFiles = paths.claude.settingsFiles;
      const requestedFile = payload.sourceFile ? path.resolve(payload.sourceFile) : null;
      const targetFile = requestedFile ? allowedFiles.find((f) => f === requestedFile) : allowedFiles[0];
      if (!targetFile) throw new Error("未找到 Claude Code 配置文件");
      const obj = readJsonSafe(targetFile);
      if (!obj || !obj.enabledPlugins || !(id in obj.enabledPlugins)) throw new Error(`未找到插件条目: ${id}`);
      const next = { ...obj, enabledPlugins: { ...obj.enabledPlugins, [id]: enabled } };
      writeTextAtomic(targetFile, JSON.stringify(next, null, 2) + "\n");
      return { ok: true, enabled };
    }

    throw new Error("当前提供方暂不支持切换该资源类型");
  }

  return { listProviderResources, toggleProviderResource };
}

module.exports = {
  createProviderResourcesManager,
  parseTomlTables,
  toggleTomlTableEnabled,
  DISABLED_SKILLS_DIRNAME,
};
