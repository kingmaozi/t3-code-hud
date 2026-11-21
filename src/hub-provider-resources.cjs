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
  { id: "opencode", label: "OpenCode" },
  { id: "devin", label: "Devin" },
];

const DISABLED_SKILLS_DIRNAME = ".disabled-skills";

function redactSummary(raw) {
  return String(raw || "")
    .replace(/(\/\/)[^@\s/:]+:[^@\s/]+@/g, "$1***:***@")
    .replace(/(--?(?:api[-_]?key|token|secret|password)[=\s]+)([^\s"']+)/gi, "$1***")
    .replace(/\b((?:sk|ctx7sk|ghp|gho|Bearer)[-_A-Za-z0-9]{10,})\b/g, "***")
    .slice(0, 90);
}

function stripJsonc(raw) {
  let out = "";
  let inStr = false;
  let esc = false;
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    const next = raw[i + 1];
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      i += 1;
      continue;
    }
    if (ch === '"') { inStr = true; out += ch; i += 1; continue; }
    if (ch === "/" && next === "/") {
      while (i < raw.length && raw[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out.replace(/,\s*([}\]])/g, "$1");
}

function readJsoncSafe(p) {
  const text = readTextIfFile(p);
  if (text == null) return null;
  try {
    const obj = JSON.parse(stripJsonc(text));
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

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
        summary = redactSummary(um[1]);
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

function discoverProviderPaths(homeDir, opts = {}) {
  const defaultHome = os.homedir();
  const xdgConfig = opts.xdgConfigHome
    || (path.resolve(homeDir) === path.resolve(defaultHome) && process.env.XDG_CONFIG_HOME
      ? path.resolve(process.env.XDG_CONFIG_HOME)
      : path.join(homeDir, ".config"));
  const xdgData = opts.xdgDataHome
    || (path.resolve(homeDir) === path.resolve(defaultHome) && process.env.XDG_DATA_HOME
      ? path.resolve(process.env.XDG_DATA_HOME)
      : path.join(homeDir, ".local", "share"));
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

  // Claude Code: ~/.claude/mcp.json + ~/.claude.json + ~/.claude/settings.json + ~/.claude/skills
  const claudeMcpFiles = [
    path.join(homeDir, ".claude", "mcp.json"),
    path.join(homeDir, ".claude.json"),
    path.join(homeDir, ".claude", "settings.json"),
  ];
  const claudeSettingsFiles = [path.join(homeDir, ".claude", "settings.json")];
  const claudeSkillDirs = [path.join(homeDir, ".claude", "skills")];
  for (const inst of t3Instances("claudeAgent")) {
    claudeMcpFiles.push(path.join(inst, "mcp.json"), path.join(inst, ".claude.json"), path.join(inst, "settings.json"));
    claudeSettingsFiles.push(path.join(inst, "settings.json"));
    claudeSkillDirs.push(path.join(inst, "skills"));
  }

  // Muse Code: XDG ~/.config/muse + ~/.local/share/muse/plugins + shared ~/.agents/skills + legacy ~/.muse + T3 muse instances
  const museMcpFiles = [
    path.join(xdgConfig, "muse", "settings.json"),
    path.join(xdgConfig, "muse", "mcp.json"),
    path.join(homeDir, ".muse", "mcp.json"),
    path.join(homeDir, ".muse", "settings.json"),
  ];
  const museSkillDirs = [
    path.join(xdgConfig, "muse", "skills"),
    path.join(homeDir, ".agents", "skills"),
    path.join(homeDir, ".muse", "skills"),
  ];
  const musePluginFiles = [
    path.join(xdgData, "muse", "plugins", "installed.json"),
    path.join(homeDir, ".muse", "plugins", "installed.json"),
  ];
  for (const inst of t3Instances("muse")) {
    museMcpFiles.push(path.join(inst, "settings.json"), path.join(inst, "mcp.json"));
    museSkillDirs.push(path.join(inst, "skills"));
    musePluginFiles.push(path.join(inst, "plugins", "installed.json"));
  }

  // OpenCode: XDG ~/.config/opencode + ~/.opencode
  const opencodeConfigFiles = [
    path.join(xdgConfig, "opencode", "opencode.json"),
    path.join(xdgConfig, "opencode", "opencode.jsonc"),
    path.join(homeDir, ".opencode", "opencode.json"),
  ];
  const opencodeSkillDirs = [
    path.join(xdgConfig, "opencode", "skills"),
    path.join(homeDir, ".opencode", "skills"),
  ];

  // Devin: XDG ~/.config/devin + ~/.local/share/devin + shared ~/.agents/skills
  const devinMcpFiles = [
    path.join(xdgConfig, "devin", "mcp_config.json"),
    path.join(homeDir, ".devin", "mcp_config.json"),
  ];
  const devinSkillDirs = [
    path.join(xdgConfig, "devin", "skills"),
    path.join(homeDir, ".devin", "skills"),
    path.join(xdgData, "devin", "skills"),
    path.join(homeDir, ".agents", "skills"),
  ];
  const devinReadonlySkillDirs = [];
  const devinPluginCacheRoot = path.join(xdgData, "devin", "cli", "plugins", "cache");
  for (const pkgDir of listSubdirs(devinPluginCacheRoot)) {
    for (const verDir of listSubdirs(pkgDir.fullPath)) {
      devinReadonlySkillDirs.push(path.join(verDir.fullPath, "skills"));
    }
  }
  const devinPluginFiles = [
    path.join(xdgData, "devin", "cli", "plugins", "lock.json"),
  ];

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
    muse: { mcpFiles: dedupeExisting(museMcpFiles, false), skillDirs: dedupeExisting(museSkillDirs, true), pluginFiles: dedupeExisting(musePluginFiles, false) },
    opencode: { configFiles: dedupeExisting(opencodeConfigFiles, false), skillDirs: dedupeExisting(opencodeSkillDirs, true) },
    devin: { mcpFiles: dedupeExisting(devinMcpFiles, false), skillDirs: dedupeExisting(devinSkillDirs, true), readonlySkillDirs: dedupeExisting(devinReadonlySkillDirs, true), pluginFiles: dedupeExisting(devinPluginFiles, false) },
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
        ? redactSummary(cfg.url)
        : redactSummary([cfg.command, ...(Array.isArray(cfg.args) ? cfg.args.slice(0, 2) : [])].filter(Boolean).join(" "));
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

function createProviderResourcesManager({ homeDir = os.homedir(), xdgConfigHome, xdgDataHome } = {}) {
  const pathOpts = { xdgConfigHome, xdgDataHome };
  function listProviderResources() {
    const paths = discoverProviderPaths(homeDir, pathOpts);
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
    const musePlugins = [];
    const seenMusePlugins = new Set();
    for (const file of paths.muse.pluginFiles || []) {
      const obj = readJsonSafe(file);
      const map = obj?.plugins && typeof obj.plugins === "object" && !Array.isArray(obj.plugins) ? obj.plugins : null;
      if (!map) continue;
      for (const [key, entry] of Object.entries(map)) {
        if (!entry || typeof entry !== "object") continue;
        const dedupeKey = `${file}::${key}`;
        if (seenMusePlugins.has(dedupeKey)) continue;
        seenMusePlugins.add(dedupeKey);
        const name = typeof entry.display_name === "string" && entry.display_name.trim() ? entry.display_name.trim() : key;
        const desc = typeof entry.description === "string" && entry.description.trim()
          ? entry.description.trim().slice(0, 140)
          : (entry.version ? `v${entry.version}` : "");
        musePlugins.push({
          id: key,
          name,
          description: desc,
          enabled: entry.enabled !== false,
          provider: "muse",
          kind: "plugins",
          sourceFile: file,
        });
      }
    }
    musePlugins.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
    result.muse = {
      id: "muse",
      label: "Muse",
      mcp: collectJsonMcpServers(paths.muse.mcpFiles, "muse"),
      skills: collectSkillsForDirs(paths.muse.skillDirs, "muse"),
      plugins: musePlugins,
    };

    // OpenCode
    const opencodeMcp = [];
    const opencodePlugins = [];
    const seenOcMcp = new Set();
    const seenOcPlug = new Set();
    for (const file of paths.opencode.configFiles || []) {
      const obj = file.endsWith(".jsonc") ? readJsoncSafe(file) : readJsonSafe(file);
      if (!obj) continue;
      const mcpMap = obj.mcp && typeof obj.mcp === "object" && !Array.isArray(obj.mcp) ? obj.mcp : null;
      if (mcpMap) {
        for (const [name, cfg] of Object.entries(mcpMap)) {
          if (!cfg || typeof cfg !== "object") continue;
          const k = `${file}::${name}`;
          if (seenOcMcp.has(k)) continue;
          seenOcMcp.add(k);
          const cmdStr = Array.isArray(cfg.command) ? cfg.command.join(" ") : (typeof cfg.command === "string" ? cfg.command : "");
          const summary = typeof cfg.url === "string" ? redactSummary(cfg.url) : redactSummary(cmdStr);
          opencodeMcp.push({
            id: name,
            name,
            description: summary,
            enabled: cfg.enabled !== false && cfg.disabled !== true,
            readonly: file.endsWith(".jsonc"),
            provider: "opencode",
            kind: "mcp",
            sourceFile: file,
          });
        }
      }
      const plugArr = Array.isArray(obj.plugin) ? obj.plugin : (Array.isArray(obj.plugins) ? obj.plugins : []);
      for (const rawEntry of plugArr) {
        const entryStr = typeof rawEntry === "string" ? rawEntry.trim() : "";
        if (!entryStr || seenOcPlug.has(entryStr)) continue;
        seenOcPlug.add(entryStr);
        const shortName = entryStr.split("@")[0] || entryStr;
        const sourceDesc = entryStr.includes("@") ? entryStr.slice(shortName.length + 1) : "";
        opencodePlugins.push({
          id: entryStr,
          name: shortName,
          description: redactSummary(sourceDesc),
          enabled: true,
          readonly: true,
          provider: "opencode",
          kind: "plugins",
          sourceFile: file,
        });
      }
    }
    opencodeMcp.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
    opencodePlugins.sort((a, b) => a.name.localeCompare(b.name));
    result.opencode = {
      id: "opencode",
      label: "OpenCode",
      mcp: opencodeMcp,
      skills: collectSkillsForDirs(paths.opencode.skillDirs, "opencode"),
      plugins: opencodePlugins,
    };

    // Devin
    const devinPlugins = [];
    const seenDevinPlug = new Set();
    for (const file of paths.devin.pluginFiles || []) {
      const obj = readJsonSafe(file);
      const resolved = Array.isArray(obj?.resolved) ? obj.resolved : [];
      for (const item of resolved) {
        const name = typeof item?.name === "string" ? item.name.trim() : "";
        if (!name || seenDevinPlug.has(name)) continue;
        seenDevinPlug.add(name);
        const desc = [item?.spec?.source, item?.version_dir ? `v${item.version_dir}` : ""].filter(Boolean).join(" · ");
        devinPlugins.push({
          id: name,
          name,
          description: desc,
          enabled: true,
          readonly: true,
          provider: "devin",
          kind: "plugins",
          sourceFile: file,
        });
      }
    }
    const devinSkills = [
      ...collectSkillsForDirs(paths.devin.skillDirs, "devin"),
      ...collectSkillsForDirs(paths.devin.readonlySkillDirs || [], "devin").map((s) => ({ ...s, readonly: true })),
    ];
    devinSkills.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
    result.devin = {
      id: "devin",
      label: "Devin",
      mcp: collectJsonMcpServers(paths.devin.mcpFiles, "devin"),
      skills: devinSkills,
      plugins: devinPlugins,
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

    const paths = discoverProviderPaths(homeDir, pathOpts);

    if (kind === "skills") {
      if (id.includes("/") || id.includes("\\")) throw new Error("无效的技能名称");
      const allowedDirs = paths[provider]?.skillDirs || [];
      const requestedDir = payload.sourceDir ? path.resolve(payload.sourceDir) : null;
      const targetDir = requestedDir ? allowedDirs.find((d) => d === requestedDir) : allowedDirs.find((d) => {
        return safeLstat(path.join(d, id)) || safeLstat(path.join(d, DISABLED_SKILLS_DIRNAME, id));
      });
      if (!targetDir) throw new Error("未找到该提供方的技能目录或条目");

      const toggleSkillInDir = (dir) => {
        const activePath = path.join(dir, id);
        const disabledRoot = path.join(dir, DISABLED_SKILLS_DIRNAME);
        const disabledPath = path.join(disabledRoot, id);
        if (enabled) {
          if (safeLstat(activePath)) return true;
          if (!safeLstat(disabledPath)) return false;
          fs.renameSync(disabledPath, activePath);
          return true;
        } else {
          if (safeLstat(disabledPath)) return true;
          if (!safeLstat(activePath)) return false;
          fs.mkdirSync(disabledRoot, { recursive: true, mode: 0o700 });
          fs.renameSync(activePath, disabledPath);
          return true;
        }
      };

      const toggledPrimary = toggleSkillInDir(targetDir);
      if (!toggledPrimary) {
        throw new Error(enabled ? "未找到已停用的技能目录" : "未找到该技能目录");
      }

      if (payload.syncAllProviders !== true) {
        return { ok: true, enabled };
      }

      const dirToProviders = new Map();
      for (const p of PROVIDERS) {
        for (const dir of paths[p.id]?.skillDirs || []) {
          const resolvedDir = path.resolve(dir);
          if (!dirToProviders.has(resolvedDir)) dirToProviders.set(resolvedDir, []);
          dirToProviders.get(resolvedDir).push(p.label);
        }
      }

      const syncedSet = new Set();
      const primaryMeta = PROVIDERS.find((p) => p.id === provider);
      if (primaryMeta) syncedSet.add(primaryMeta.label);
      for (const lbl of dirToProviders.get(path.resolve(targetDir)) || []) syncedSet.add(lbl);

      for (const [resolvedDir, labels] of dirToProviders.entries()) {
        if (resolvedDir === path.resolve(targetDir)) continue;
        const hasSkill = Boolean(
          safeLstat(path.join(resolvedDir, id)) ||
          safeLstat(path.join(resolvedDir, DISABLED_SKILLS_DIRNAME, id))
        );
        if (!hasSkill) continue;
        if (toggleSkillInDir(resolvedDir)) {
          for (const lbl of labels) syncedSet.add(lbl);
        }
      }

      return { ok: true, enabled, syncedProviders: [...syncedSet] };
    }

    if (provider === "codex") {
      const allowedFiles = paths.codex.tomls;
      const requestedFile = payload.sourceFile ? path.resolve(payload.sourceFile) : null;
      const targetFile = requestedFile ? allowedFiles.find((f) => f === requestedFile) : allowedFiles[0];
      if (!targetFile) throw new Error("未找到 Codex 配置文件");
      const prefix = kind === "mcp" ? "mcp_servers" : "plugins";
      return toggleTomlTableEnabled(targetFile, prefix, id, enabled);
    }

    if (kind === "mcp" && provider === "opencode") {
      const allowedFiles = (paths.opencode.configFiles || []).filter((f) => f.endsWith(".json"));
      const requestedFile = payload.sourceFile ? path.resolve(payload.sourceFile) : null;
      const targetFile = requestedFile ? allowedFiles.find((f) => f === requestedFile) : allowedFiles[0];
      if (!targetFile) throw new Error("OpenCode JSONC 暂仅支持只读查看，请直接编辑 opencode.json");
      const obj = readJsonSafe(targetFile);
      if (!obj || !obj.mcp || !obj.mcp[id] || typeof obj.mcp[id] !== "object") throw new Error(`未找到 MCP 条目: ${id}`);
      const next = { ...obj, mcp: { ...obj.mcp, [id]: { ...obj.mcp[id], enabled } } };
      if (enabled) delete next.mcp[id].disabled;
      writeTextAtomic(targetFile, JSON.stringify(next, null, 2) + "\n");
      return { ok: true, enabled };
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

    if (kind === "plugins" && provider === "muse") {
      const allowedFiles = paths.muse.pluginFiles || [];
      const requestedFile = payload.sourceFile ? path.resolve(payload.sourceFile) : null;
      const targetFile = requestedFile ? allowedFiles.find((f) => f === requestedFile) : allowedFiles[0];
      if (!targetFile) throw new Error("未找到 Muse 插件配置文件");
      const obj = readJsonSafe(targetFile);
      if (!obj || !obj.plugins || !obj.plugins[id] || typeof obj.plugins[id] !== "object") {
        throw new Error(`未找到插件条目: ${id}`);
      }
      const next = { ...obj, plugins: { ...obj.plugins, [id]: { ...obj.plugins[id], enabled } } };
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
