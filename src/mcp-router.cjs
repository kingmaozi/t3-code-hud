"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

function safeMkdir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function readJsonFile(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function writeJsonFile(file, obj) {
  safeMkdir(path.dirname(file));
  const tmp = file + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}
function writeJsonFileSecure(file, obj) {
  safeMkdir(path.dirname(file));
  const tmp = file + ".tmp-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(16).slice(2, 8);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch {}
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}
function listDirs(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => path.join(dir, e.name)); } catch { return []; }
}
function dirExists(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function fileExists(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function isSecretKey(k) { return /KEY|TOKEN|SECRET|PASSWORD/i.test(String(k)); }
function redactArgValue(str) {
  let s = String(str);
  s = s.replace(/(\/\/)[^@\s/:]+:[^@\s/]+@/g, "$1***:***@");
  s = s.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer ***");
  s = s.replace(/(Authorization\s*[:=]\s*)Bearer\s+\S+/gi, "$1Bearer ***");
  s = s.replace(/(Authorization\s*[:=]\s*)\S+/gi, "$1***");
  s = s.replace(/(--[^=\s]*(?:api[_-]?key|access[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|client[_-]?secret|password|passwd|pwd|authorization)[^=\s]*=)([^\s"']+)/gi, "$1***");
  s = s.replace(/([?&](?:api[_-]?key|access[_-]?key|token|key|secret|password|passwd|pwd|authorization|client[_-]?secret|refresh[_-]?token)[^=]*=)[^&#\s]+/gi, "$1***");
  s = s.replace(/(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)\b["']?\s*[:=]\s*)\S+/gi, "$1***");
  s = s.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "***");
  s = s.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "***");
  s = s.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "***");
  s = s.replace(/\bAKIA[0-9A-Z]{16}\b/g, "***");
  s = s.replace(/\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g, "***");
  return s;
}
function redactArgs(args) {
  if (!Array.isArray(args)) return [];
  const SEP = new Set(["--token", "--api-key", "--apikey", "--api_key", "--secret", "--password", "--passwd", "--pwd", "--authorization", "--header", "-H"]);
  const SECRET_FLAG_RE = /^--(?:api[_-]?key|access[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|authorization|secret|client[_-]?secret|password|passwd|pwd|key)$/i;
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = String(args[i]);
    const prev = i > 0 ? String(args[i - 1]) : null;
    if (prev != null) {
      if (prev === "-H" || SEP.has(prev.toLowerCase()) || SECRET_FLAG_RE.test(prev)) {
        out.push("***");
        continue;
      }
    }
    out.push(redactArgValue(a));
  }
  return out;
}
function redactUrl(urlStr) {
  if (urlStr == null || urlStr === "") return null;
  const raw = String(urlStr);
  try {
    const u = new URL(raw);
    if (u.username) u.username = "***";
    if (u.password) u.password = "***";
    for (const [k, v] of [...u.searchParams.entries()]) {
      if (/^(?:api[_-]?key|access[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|authorization|secret|client[_-]?secret|password|passwd|pwd|key|apikey)$/i.test(k)) {
        u.searchParams.set(k, "***");
      } else if (/\b(?:sk-|gh[pousr]_|github_pat_|Bearer\s|AIza|AKIA)/.test(v)) {
        u.searchParams.set(k, "***");
      }
    }
    return u.toString();
  } catch {
    let s = raw;
    s = s.replace(/([?&](?:api[_-]?key|access[_-]?key|token|key|secret|password|passwd|pwd|authorization|client[_-]?secret|refresh[_-]?token)[^=]*=)[^&#\s]+/gi, "$1***");
    s = s.replace(/(\/\/)[^@\s/:]+:[^@\s/]+@/g, "$1***:***@");
    s = s.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "***").replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "***");
    return s;
  }
}

function redactCommand(cmd) {
  const raw = String(cmd);
  if (/\s/.test(raw)) {
    try {
      return redactArgs(raw.split(/\s+/).filter(Boolean)).join(" ");
    } catch {
      return redactArgValue(raw);
    }
  }
  return redactArgValue(raw);
}
function redactSummary(server) {
  const name = server.name || "";
  const transport = server.transport || (server.url ? "http" : "stdio");
  const parts = [];
  if (server.command) parts.push(redactCommand(server.command));
  if (Array.isArray(server.args)) parts.push(redactArgs(server.args).join(" "));
  if (server.url) parts.push(redactUrl(server.url) || "");
  const env = server.env && typeof server.env === "object" ? server.env : null;
  let envNote = "";
  if (env) {
    const keys = Object.keys(env);
    if (keys.length) envNote = " env=[" + keys.map((k) => (isSecretKey(k) ? k + "=***" : k + "=" + redactArgValue(String(env[k])))).join(",") + "]";
  }
  const s = `${name} (${transport})${parts.length ? ": " + parts.join(" ") : ""}${envNote}`.replace(/(KEY|TOKEN|SECRET|PASSWORD)=([^\s,}\]]+)/gi, "$1=***");
  return s.slice(0, 300);
}

const ALLOWED_MODES = ["off", "project-lazy", "project-direct", "global-lazy", "global-direct"];
const isHubName = name => normKey(name) === "t3-hub";
const normKey = name => String(name).toLowerCase().replace(/_/g, "-");
const BUILTIN_UPSTREAM_MCPS = [
  { name: "chrome-devtools", command: "npx", args: ["-y", "chrome-devtools-mcp@latest"] },
  { name: "codegraph", command: "codegraph", args: ["serve", "--mcp"] },
  { name: "context7", url: "https://mcp.context7.com/mcp" },
  { name: "playwright", command: "npx", args: ["-y", "@playwright/mcp@latest"] },
  { name: "lcu", command: "~/.local/share/lcu", args: [] },
  { name: "fetch", command: "uvx", args: ["mcp-server-fetch"] },
  { name: "github", url: "https://api.githubcopilot.com/mcp/" },
];

function stripTomlCommentOutsideQuotes(line) {
  let inDouble = false;
  let inSingle = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inDouble) {
      if (c === "\\") { i++; continue; }
      if (c === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (c === "'") inSingle = false;
      continue;
    }
    if (c === '"') { inDouble = true; continue; }
    if (c === "'") { inSingle = true; continue; }
    if (c === "#") return line.slice(0, i);
  }
  return line;
}

function parseTomlDottedPath(text) {
  if (typeof text !== "string") return null;
  let i = 0;
  const n = text.length;
  const parts = [];
  const skipWs = () => { while (i < n && (text[i] === " " || text[i] === "\t")) i++; };
  skipWs();
  if (i >= n) return null;
  while (true) {
    skipWs();
    if (i >= n) return null;
    const c = text[i];
    let seg = null;
    if (c === '"') {
      i++;
      let out = "";
      let closed = false;
      while (i < n) {
        const ch = text[i];
        if (ch === '"') { i++; closed = true; break; }
        if (ch === "\\") {
          if (i + 1 >= n) return null;
          const esc = text[i + 1];
          if (esc === "b") out += "\b", i += 2;
          else if (esc === "t") out += "\t", i += 2;
          else if (esc === "n") out += "\n", i += 2;
          else if (esc === "f") out += "\f", i += 2;
          else if (esc === "r") out += "\r", i += 2;
          else if (esc === '"') out += '"', i += 2;
          else if (esc === "\\") out += "\\", i += 2;
          else if (esc === "u") {
            if (i + 5 >= n) return null;
            const hex = text.slice(i + 2, i + 6);
            if (!/^[0-9A-Fa-f]{4}$/.test(hex)) return null;
            out += String.fromCodePoint(parseInt(hex, 16));
            i += 6;
          } else if (esc === "U") {
            if (i + 9 >= n) return null;
            const hex = text.slice(i + 2, i + 10);
            if (!/^[0-9A-Fa-f]{8}$/.test(hex)) return null;
            const cp = parseInt(hex, 16);
            if (!Number.isFinite(cp) || cp < 0 || cp > 0x10FFFF) return null;
            out += String.fromCodePoint(cp);
            i += 10;
          } else {
            return null;
          }
          continue;
        }
        out += ch;
        i++;
      }
      if (!closed) return null;
      seg = out;
    } else if (c === "'") {
      const start = i + 1;
      let j = start;
      while (j < n && text[j] !== "'") j++;
      if (j >= n) return null;
      seg = text.slice(start, j);
      i = j + 1;
    } else if (/[A-Za-z0-9_-]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_-]/.test(text[j])) j++;
      seg = text.slice(i, j);
      i = j;
    } else {
      return null;
    }
    parts.push(seg);
    skipWs();
    if (i >= n) break;
    if (text[i] === ".") {
      i++;
      skipWs();
      if (i >= n) return null;
      continue;
    }
    return null;
  }
  return parts;
}

function parseTomlTableHeader(line) {
  if (typeof line !== "string") return null;
  let start = 0;
  while (start < line.length && (line[start] === " " || line[start] === "\t")) start++;
  if (start >= line.length || line[start] !== "[") return null;
  const noComment = stripTomlCommentOutsideQuotes(line);
  const trimmed = noComment.trim();
  let isArrayTable = false;
  let inner = null;
  if (trimmed.startsWith("[[")) {
    if (!trimmed.endsWith("]]")) return null;
    isArrayTable = true;
    inner = trimmed.slice(2, trimmed.length - 2);
  } else {
    if (!trimmed.endsWith("]")) return null;
    inner = trimmed.slice(1, trimmed.length - 1);
  }
  const parsed = parseTomlDottedPath(inner);
  if (!parsed || parsed.length === 0) return null;
  return { isArrayTable, path: parsed };
}

function parseTomlKeyValue(line) {
  if (typeof line !== "string") return null;
  let inDouble = false;
  let inSingle = false;
  let eqIdx = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inDouble) {
      if (c === "\\") { i++; continue; }
      if (c === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (c === "'") inSingle = false;
      continue;
    }
    if (c === "#") break;
    if (c === "=") { eqIdx = i; break; }
    if (c === '"') { inDouble = true; continue; }
    if (c === "'") { inSingle = true; continue; }
  }
  if (eqIdx < 0 || inDouble || inSingle) return null;
  const lhs = line.slice(0, eqIdx);
  const rhs = line.slice(eqIdx + 1);
  if (!lhs.trim()) return null;
  const parsed = parseTomlDottedPath(lhs);
  if (!parsed || parsed.length === 0) return null;
  const rhsTrimmed = rhs.replace(/^\s+/, "");
  return { isInlineTable: rhsTrimmed.startsWith("{"), path: parsed, valueStart: eqIdx + 1 };
}

const isTomlHubKey = (k) => k === "t3_hub" || k === "t3-hub";

function isHubMcpPath(p) {
  return Array.isArray(p) && p.length >= 2 && p[0] === "mcp_servers" && isTomlHubKey(p[1]);
}

function isUnsupportedMcpDefinition(currentPath, kv) {
  if (!kv || !Array.isArray(kv.path)) return false;
  if (currentPath.length === 0) {
    if (kv.path.length === 1 && kv.path[0] === "mcp_servers" && kv.isInlineTable) return true;
    if (kv.path.length >= 2 && kv.path[0] === "mcp_servers" && isTomlHubKey(kv.path[1])) return true;
  } else if (currentPath.length === 1 && currentPath[0] === "mcp_servers") {
    if (kv.path.length >= 1 && isTomlHubKey(kv.path[0])) return true;
  }
  return false;
}

function createMcpRouter(opts = {}) {
  const homeDir = opts.homeDir || process.env.HOME || os.homedir();
  const hubDir = opts.hubDir || process.env.T3_HUB_DIR || path.join(homeDir, ".t3", "hub");
  const statePath = path.join(hubDir, "state.json");
  const registryPath = path.join(hubDir, "mcp-registry.json");
  const probeCachePath = path.join(hubDir, "mcp-probe-cache.json");
  const routerBin = opts.routerBin || path.resolve(__dirname, "..", "bin", "t3-mcp-router");

  function readState() {
    const s = readJsonFile(statePath, {});
    return s && typeof s === "object" ? s : {};
  }
  function writeState(s) { writeJsonFile(statePath, s); }
  function readRegistry() {
    const r = readJsonFile(registryPath, []);
    if (Array.isArray(r)) return r;
    if (r && typeof r === "object" && Array.isArray(r.servers)) return r.servers;
    if (r && typeof r === "object" && r.mcpServers && typeof r.mcpServers === "object") return Object.entries(r.mcpServers).map(([name, v]) => ({ name, ...(v || {}) }));
    if (r && typeof r === "object") return Object.entries(r).map(([name, v]) => ({ name, ...(v || {}) }));
    return [];
  }
  function writeRegistry(list) { writeJsonFileSecure(registryPath, list); }

  function collectFromFile(file, sourceKey, sourceLabel) {
    const out = [];
    const raw = readJsonFile(file, null);
    if (!raw) return out;
    const servers = raw.mcpServers;
    if (servers && typeof servers === "object" && !Array.isArray(servers)) {
      for (const [name, v] of Object.entries(servers)) {
        if (isHubName(name)) continue;
        out.push({ name, ...(v || {}), __source: sourceKey, __sourceLabel: sourceLabel });
      }
    }
    return out;
  }

  function mergeDefinition(map, server, replace = false) {
    if (!server || typeof server.name !== "string" || !server.name || isHubName(server.name)) return;
    const key = [...map.keys()].find(k => normKey(k) === normKey(server.name));
    const previous = key ? map.get(key) : null;
    const sources = [...new Set([...(previous?.sources || []), server.__source || "hub"])];
    if (previous && !replace) {
      map.set(key, { ...previous, builtin: !!(previous.builtin || server.builtin), sources }); return;
    }
    if (key) map.delete(key);
    const merged = { ...previous, ...server, sources };
    // A replacement endpoint must not inherit the old endpoint's transport.
    if (replace && server.command && !server.url) { merged.url = null; merged.transport = server.transport || "stdio"; }
    else if (replace && server.url && !server.command) { merged.command = null; merged.transport = server.transport || "http"; }
    map.set(server.name, merged);
  }
  function discoverDefinitions() {
    const byName = new Map();
    const add = s => mergeDefinition(byName, s);
    const { discoverPluginDirectories, pluginDetails, readPluginManifest, pluginId, expandPluginRoot } = require("./hub-plugins.cjs");
    for (const dir of discoverPluginDirectories({ homeDir, hubDir })) {
      const meta = readPluginManifest(dir);
      for (const [name, config] of Object.entries(pluginDetails(dir).servers)) {
        add({ ...expandPluginRoot(config, dir), name, pluginId: pluginId(dir, meta), groupTitle: meta.title || meta.name || path.basename(dir), icon: meta.icon || null, installed: true, __source: "plugin", __sourceLabel: meta.name || path.basename(dir) });
      }
    }
    for (const [file, source] of [
      [path.join(homeDir, ".pi", "agent", "mcp.json"), "pi"],
      [path.join(homeDir, ".config", "muse", "settings.json"), "muse"],
      [path.join(homeDir, ".claude", "mcp.json"), "claude"],
      [path.join(homeDir, ".zcode", "cli", "mcp.json"), "zcode"],
    ]) for (const server of collectFromFile(file, source, source)) mergeDefinition(byName, { ...server, pluginId: null, installed: true }, true);
    const agyRoot = path.join(homeDir, ".t3", "userdata", "providers", "antigravity");
    for (const inst of listDirs(agyRoot)) for (const server of collectFromFile(path.join(inst, "config", "mcp_config.json"), "agy", "agy")) mergeDefinition(byName, { ...server, pluginId: null, installed: true }, true);
    // Keep old imports readable, but upstream templates and plugin discovery never depend on Magpie.
    const magpie = readJsonFile(path.join(homeDir, ".config", "magpie", "library.json"), null);
    if (Array.isArray(magpie?.mcp)) for (const server of magpie.mcp) add({ ...server, installed: true, __source: "magpie", __sourceLabel: "magpie" });
    for (const server of BUILTIN_UPSTREAM_MCPS) {
      add({ ...server, command: server.command?.replace(/^~(?=\/)/, () => homeDir), title: server.title || server.name, groupTitle: "官方上游 MCP", builtin: true, __source: "builtin", __sourceLabel: "builtin" });
    }
    return byName;
  }
  function discoverServerDefinitions(overrides = {}) {
    if ((overrides.homeDir && overrides.homeDir !== homeDir) || (overrides.hubDir && overrides.hubDir !== hubDir)) {
      return createMcpRouter({ homeDir, ...overrides }).discoverServerDefinitions();
    }
    const definitions = discoverDefinitions();
    for (const server of readRegistry()) mergeDefinition(definitions, { ...server, pluginId: server.pluginId || null, __source: server.__source || "hub", __sourceLabel: server.__sourceLabel || "hub" }, true);
    return definitions;
  }
  function modeFor(modes, name) {
    return modes[name] || Object.entries(modes).find(([key]) => normKey(key) === normKey(name))?.[1];
  }
  function clearAliases(modes, name) {
    for (const key of Object.keys(modes)) if (normKey(key) === normKey(name)) delete modes[key];
  }

  function commandAvailable(s, projectRoot) {
    if (!s.command) return false;
    const expandHome = value => String(value).replace(/^~(?=\/)/, () => homeDir);
    const cwd = path.resolve(projectRoot || homeDir, expandHome(s.cwd || "."));
    const cmd = expandHome(s.command);
    const paths = cmd.includes("/") ? [path.resolve(cwd, cmd)] : String(s.env?.PATH || process.env.PATH || "").split(path.delimiter).map(p => path.resolve(cwd, expandHome(p), cmd));
    return paths.some(p => { try { fs.accessSync(p, fs.constants.X_OK); return fileExists(p); } catch { return false; } });
  }
  function probeKey(s, projectRoot) {
    // Bind cache entries to the endpoint and execution context, without storing
    // credentials. A changed definition must be probed again.
    return normKey(s.name) + ":" + crypto.createHash("sha256")
      .update(JSON.stringify([s.command, s.args, s.url, s.cwd, s.env, s.headers, s.url ? null : projectRoot || homeDir])).digest("hex");
  }
  function connectionStatus(s, projectRoot, cache) {
    const cached = cache[probeKey(s, projectRoot)];
    if (typeof cached?.connected === "boolean") return { ...cached, probed: true };
    if (!s.url && !commandAvailable(s, projectRoot)) return { connected: false, probed: false, statusText: "未检测到可执行命令，请检查安装或探测连通性。" };
    return { connected: null, probed: false, statusText: "尚未探测连通性，按需唤醒或点击检测连通性。" };
  }

  function listMcpServers(args = {}) {
    const projectRoot = args.projectRoot || null;
    const cache = readJsonFile(probeCachePath, {}) || {};
    const byName = discoverServerDefinitions();
    const registryNames = new Set(readRegistry().map(s => normKey(s.name)));
    const state = readState();
    const globalModes = state.mcpModes?.global || {};
    const projModes = projectRoot ? (state.mcpModes?.projects?.[projectRoot] || {}) : {};
    const items = [...byName.values()].map((s) => {
      const mode = modeFor(projModes, s.name) || modeFor(globalModes, s.name) || "off";
      const env = s.env && typeof s.env === "object" ? Object.keys(s.env) : [];
      const hasSecrets = env.some((k) => isSecretKey(k));
      return {
        name: s.name,
        title: s.title || s.name, groupTitle: s.groupTitle || s.__sourceLabel || "MCP",
        icon: s.icon || null, builtin: !!s.builtin, pluginId: s.pluginId || null,
        installed: !!s.installed || registryNames.has(normKey(s.name)) || mode !== "off",
        ...connectionStatus(s, projectRoot, cache),
        transport: s.transport || (s.url ? "http" : "stdio"),
        command: s.command ? redactCommand(s.command) : null,
        args: redactArgs(Array.isArray(s.args) ? s.args : []),
        url: s.url ? redactUrl(s.url) : null,
        agents: s.agents || null,
        source: s.__source || "hub",
        sourceLabel: s.__sourceLabel || "hub",
        mode: ALLOWED_MODES.includes(mode) ? mode : "off",
        hasSecrets,
        summary: redactSummary(s),
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
    const routerRegistered =
      (() => {
        const cfg = (() => { try { return fs.readFileSync(path.join(homeDir, ".codex", "config.toml"), "utf8"); } catch { return ""; } })();
        if (cfg.includes("[mcp_servers.t3_hub]") || cfg.includes("[mcp_servers.t3-hub]")) return true;
        for (const f of [path.join(homeDir, ".pi", "agent", "mcp.json"), path.join(homeDir, ".config", "muse", "settings.json"), path.join(homeDir, ".claude", "mcp.json")]) {
          const j = readJsonFile(f, null);
          if (j && j.mcpServers && (j.mcpServers.t3_hub || j.mcpServers["t3-hub"])) return true;
        }
        return false;
      })();
    return { ok: true, routerRegistered, items };
  }

  function activeModes(state, name) {
    return [modeFor(state.mcpModes?.global || {}, name),
      ...Object.values(state.mcpModes?.projects || {}).map(modes => modeFor(modes, name))]
      .some(mode => mode && mode !== "off");
  }
  function pluginConflict(name, id, state, registry) {
    const existing = registry.find(s => normKey(s.name) === normKey(name));
    if (existing && existing.pluginId !== id) return true;
    const definition = [...discoverDefinitions().values()].find(s => normKey(s.name) === normKey(name));
    if (!existing && definition && definition.pluginId !== id) return true;
    // Enabling a discovered server independently does not grant a plugin
    // permission to change its modes, even if the definition came from it.
    return activeModes(state, name);
  }
  function setPluginMcpScope({ pluginId, servers = [], scope, projectRoot } = {}) {
    if (!pluginId || !["off", "global", "project"].includes(scope)) throw new Error("invalid plugin scope");
    if (scope === "project" && (!projectRoot || !path.isAbsolute(projectRoot))) throw new Error("projectRoot required for project scope");
    const state = readState(), registry = readRegistry();
    state.pluginMcpOwned ||= {};
    const owned = state.pluginMcpOwned[pluginId] || [];
    let registryChanged = false;
    for (const record of owned) {
      const index = registry.findIndex(s => normKey(s.name) === normKey(record.name) && s.pluginId === pluginId);
      if (index < 0) continue; // Definition has since been taken over by a user.
      const clearOwned = (modes, expected) => {
        if (modes && expected && modeFor(modes, record.name) === expected) clearAliases(modes, record.name);
      };
      clearOwned(state.mcpModes?.global, record.global);
      for (const [root, mode] of Object.entries(record.projects || {})) clearOwned(state.mcpModes?.projects?.[root], mode);
      if (!activeModes(state, record.name)) { registry.splice(index, 1); registryChanged = true; }
    }
    const claimed = [], skippedMcps = [];
    if (scope !== "off") for (const server of servers) {
      if (isHubName(server.name) || pluginConflict(server.name, pluginId, state, registry)) { skippedMcps.push(server.name); continue; }
      const index = registry.findIndex(s => normKey(s.name) === normKey(server.name));
      const definition = { ...server, pluginId, __source: "hub" };
      if (index < 0) registry.push(definition); else registry[index] = definition;
      registryChanged = true;
      state.mcpModes ||= {}; state.mcpModes.global ||= {}; state.mcpModes.projects ||= {};
      const mode = scope + "-lazy", modes = scope === "global" ? state.mcpModes.global : state.mcpModes.projects[projectRoot] ||= {};
      clearAliases(modes, server.name); modes[server.name] = mode;
      claimed.push({ name: server.name, ...(scope === "global" ? { global: mode } : { projects: { [projectRoot]: mode } }) });
    }
    state.pluginMcpOwned[pluginId] = claimed;
    if (registryChanged) writeRegistry(registry);
    writeState(state);
    return { ok: true, skippedMcps };
  }

  function setMcpMode(args = {}) {
    const { mode } = args;
    let { name } = args;
    const projectRoot = args.projectRoot || null;
    if (typeof name !== "string" || !name || !ALLOWED_MODES.includes(mode)) throw new Error("invalid name or mode");
    if (mode.startsWith("project-") && !projectRoot) throw new Error("projectRoot required for project mode");
    if (projectRoot && !path.isAbsolute(projectRoot)) throw new Error("projectRoot must be absolute");
    const discovered = [...discoverServerDefinitions().values()].find(s => normKey(s.name) === normKey(name));
    name = discovered?.name || name;
    const state = readState();
    state.mcpModes ||= {}; state.mcpModes.global ||= {}; state.mcpModes.projects ||= {};
    if (mode.startsWith("project-") || (mode === "off" && projectRoot)) {
      const modes = state.mcpModes.projects[projectRoot] ||= {};
      clearAliases(modes, name); modes[name] = mode;
    } else {
      clearAliases(state.mcpModes.global, name); state.mcpModes.global[name] = mode;
      if (projectRoot && mode.startsWith("global-")) clearAliases(state.mcpModes.projects[projectRoot] || {}, name);
    }
    for (const records of Object.values(state.pluginMcpOwned || {})) for (const record of records) {
      if (normKey(record.name) !== normKey(name)) continue;
      if (mode.startsWith("project-") || (mode === "off" && projectRoot)) delete record.projects?.[projectRoot];
      else { delete record.global; if (projectRoot) delete record.projects?.[projectRoot]; }
    }
    writeState(state);
    if (mode !== "off" && !isHubName(name) && discovered && !readRegistry().some(e => normKey(e.name) === normKey(name))) writeRegistry([...readRegistry(), discovered]);
    return { ok: true, name, mode };
  }
  const setServerMode = setMcpMode;

  function upsertMcpServer(payload = {}) {
    let list = [];
    if (payload.jsonRaw) {
      let parsed = null;
      try { parsed = JSON.parse(payload.jsonRaw); } catch { throw new Error("invalid jsonRaw"); }
      if (parsed && typeof parsed === "object" && parsed.mcpServers && typeof parsed.mcpServers === "object") {
        for (const [name, v] of Object.entries(parsed.mcpServers)) {
          if (isHubName(name)) continue;
          list.push({ name, ...(v || {}) });
        }
      } else if (parsed && typeof parsed === "object" && (parsed.transport || parsed.command || parsed.url)) {
        if (!parsed.name && !payload.name) throw new Error("name required");
        list.push({ name: payload.name || parsed.name, ...parsed });
      } else if (parsed && typeof parsed === "object") {
        for (const [name, v] of Object.entries(parsed)) if (!isHubName(name) && v && typeof v === "object") list.push({ name, ...v });
      }
    } else {
      if (!payload.name) throw new Error("name required");
      if (isHubName(payload.name)) throw new Error("cannot override t3_hub");
      list.push({
        name: payload.name,
        transport: payload.transport || (payload.url ? "http" : "stdio"),
        command: payload.command || null,
        args: Array.isArray(payload.args) ? payload.args : (payload.args ? [payload.args] : []),
        env: payload.env || {},
        url: payload.url || null,
        agents: payload.agents || null,
        headers: payload.headers || undefined,
        cwd: payload.cwd || undefined,
        title: payload.title, groupTitle: payload.groupTitle, icon: payload.icon,
        pluginId: payload.pluginId, installed: payload.installed,
      });
    }
    const regMap = new Map();
    for (const server of readRegistry()) mergeDefinition(regMap, server, true);
    const stateBefore = readState(), skippedMcps = [];
    for (const server of list) {
      if (server.pluginId && pluginConflict(server.name, server.pluginId, stateBefore, readRegistry())) { skippedMcps.push(server.name); continue; }
      mergeDefinition(regMap, server, true);
    }
    if (skippedMcps.length === list.length) return { ok: true, items: [], skippedMcps };
    const reg = [...regMap.values()];
    writeRegistry(reg);
    // Keep persisted modes usable by runtime consumers that index exact names.
    const state = readState();
    for (const modes of [state.mcpModes?.global, ...Object.values(state.mcpModes?.projects || {})].filter(Boolean)) {
      for (const server of reg) { const mode = modeFor(modes, server.name); clearAliases(modes, server.name); if (mode) modes[server.name] = mode; }
    }
    if (state.mcpModes) writeState(state);
    const names = new Set(reg.map(s => normKey(s.name)));
    return { ok: true, skippedMcps, items: listMcpServers().items.filter(s => names.has(normKey(s.name))) };
  }

  function removeMcpServer({ name } = {}) {
    if (!name) throw new Error("name required");
    writeRegistry(readRegistry().filter(e => normKey(e.name) !== normKey(name)));
    const state = readState();
    if (state.mcpModes?.global) clearAliases(state.mcpModes.global, name);
    for (const modes of Object.values(state.mcpModes?.projects || {})) clearAliases(modes, name);
    writeState(state);
    return { ok: true, name };
  }

  function backupOnce(file) {
    const backup = file + ".bak-t3hub";
    if (fileExists(file) && !fileExists(backup)) { fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL); fs.chmodSync(backup, 0o600); }
  }
  function syncRouterToClis() {
    const synced = [], skipped = [];
    function rewriteCodexToml(raw) {
      const lines = raw.split(/\r?\n/);
      const kept = [];
      let inHub = false;
      let stringMode = null; // Single-line or multiline basic/literal strings.
      let arrayDepth = 0, braceDepth = 0;
      const valueDelimiters = [];
      let currentPath = [];
      for (const line of lines) {
        // A header/key can only begin between complete statements. In particular,
        // ["x"] inside an array is a value, even when it occupies a whole line.
        const atStatementStart = stringMode === null && arrayDepth === 0 && braceDepth === 0;
        let i = 0;
        if (atStatementStart) {
          if (/^\s*(?:#|$)/.test(line)) {
            if (!inHub) kept.push(line);
            continue;
          }
          if (/^\s*\[/.test(line)) {
            const header = parseTomlTableHeader(line);
            if (!header) return null;
            if (header.isArrayTable && ((header.path.length === 1 && header.path[0] === "mcp_servers") || isHubMcpPath(header.path))) return null;
            currentPath = header.path;
            inHub = isHubMcpPath(currentPath);
            if (!inHub) kept.push(line);
            continue; // Header brackets are never value delimiters.
          }
          const kv = parseTomlKeyValue(line);
          if (!kv || !line.slice(kv.valueStart).trim() || /^\s*#/.test(line.slice(kv.valueStart))) return null;
          if (!inHub && isUnsupportedMcpDefinition(currentPath, kv)) return null;
          i = kv.valueStart;
        }
        while (i < line.length) {
          const c = line[i];
          if (stringMode) {
            const basic = stringMode[0] === '"';
            if (basic && c === "\\") { i += 2; continue; }
            if (stringMode.length === 3 && c === stringMode[0]) {
              let end = i;
              while (line[end] === c) end++;
              const count = end - i;
              if (count >= 3) {
                // TOML permits one or two content quotes beside the terminator.
                if (count > 5) return null;
                stringMode = null;
              }
              i = end;
              continue;
            }
            if (stringMode.length === 1 && c === stringMode) stringMode = null;
            i++;
            continue;
          }
          if (c === "#") break;
          if (c === '"' || c === "'") {
            stringMode = line.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
            i += stringMode.length;
            continue;
          }
          if (c === "[" || c === "{") {
            valueDelimiters.push(c);
            if (c === "[") arrayDepth++; else braceDepth++;
          } else if (c === "]" || c === "}") {
            const opening = c === "]" ? "[" : "{";
            if (valueDelimiters.pop() !== opening) return null;
            if (c === "]") arrayDepth--; else braceDepth--;
          }
          i++;
        }
        // Only multiline strings may span physical lines.
        if (stringMode && stringMode.length === 1) return null;
        if (!inHub) kept.push(line);
      }
      if (stringMode !== null || arrayDepth !== 0 || braceDepth !== 0) return null;
      const section = `[mcp_servers.t3_hub]\ncommand = ${JSON.stringify(routerBin)}\nargs = []\n`;
      const prefix = kept.join("\n").trimEnd();
      return (prefix ? prefix + "\n\n" : "") + section;
    }

    const cfgPath = path.join(homeDir, ".codex", "config.toml");
    if (!dirExists(path.dirname(cfgPath))) skipped.push(cfgPath);
    else {
      const raw = fileExists(cfgPath) ? fs.readFileSync(cfgPath, "utf8") : "";
      const updated = rewriteCodexToml(raw);
      if (updated === null) {
        skipped.push(cfgPath);
      } else {
        if (raw !== updated) {
          backupOnce(cfgPath);
          safeMkdir(path.dirname(cfgPath));
          const tmp = cfgPath + ".tmp-" + process.pid;
          fs.writeFileSync(tmp, updated, { mode: 0o600 }); fs.chmodSync(tmp, 0o600); fs.renameSync(tmp, cfgPath);
        }
        fs.chmodSync(cfgPath, 0o600); synced.push(cfgPath);
      }
    }
    function syncJson(file) {
      if (!dirExists(path.dirname(file))) { skipped.push(file); return; }
      const obj = readJsonFile(file, null);
      if (fileExists(file) && (!obj || typeof obj !== "object" || Array.isArray(obj))) { skipped.push(file); return; }
      const next = obj || {};
      if (next.mcpServers && (typeof next.mcpServers !== "object" || Array.isArray(next.mcpServers))) { skipped.push(file); return; }
      const before = JSON.stringify(next);
      next.mcpServers ||= {};
      for (const name of Object.keys(next.mcpServers)) if (isHubName(name)) delete next.mcpServers[name];
      next.mcpServers.t3_hub = { command: routerBin, args: [] };
      if (!fileExists(file) || JSON.stringify(next) !== before) { backupOnce(file); writeJsonFileSecure(file, next); }
      else fs.chmodSync(file, 0o600);
      synced.push(file);
    }
    syncJson(path.join(homeDir, ".pi", "agent", "mcp.json"));
    syncJson(path.join(homeDir, ".config", "muse", "settings.json"));
    syncJson(path.join(homeDir, ".claude", "mcp.json"));
    syncJson(path.join(homeDir, ".zcode", "cli", "mcp.json"));
    for (const inst of listDirs(path.join(homeDir, ".t3", "userdata", "providers", "antigravity"))) syncJson(path.join(inst, "config", "mcp_config.json"));
    return { ok: true, syncedTargets: synced, skippedTargets: skipped };
  }

  function isValidMcpInitResponse(msg) {
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || msg.id !== 1 || msg.error) return false;
    const r = msg.result;
    if (!r || typeof r !== "object" || Array.isArray(r)) return false;
    return typeof r.protocolVersion === "string" && r.protocolVersion.trim().length > 0 &&
      Boolean(r.capabilities && typeof r.capabilities === "object" && !Array.isArray(r.capabilities)) &&
      Boolean(r.serverInfo && typeof r.serverInfo === "object" && !Array.isArray(r.serverInfo) &&
        typeof r.serverInfo.name === "string" && r.serverInfo.name.trim().length > 0);
  }

  function extractSseInitResult(text) {
    for (const line of String(text || "").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const raw = trimmed.slice(5).trim();
      if (!raw || raw === "[DONE]") continue;
      try { if (isValidMcpInitResponse(JSON.parse(raw))) return true; } catch {}
    }
    return false;
  }

  async function fetchSameOrigin(targetUrl, baseOrigin, init = {}, maxRedirects = 3) {
    let currentUrl = new URL(targetUrl).href;
    let currentInit = { ...init, redirect: "manual" };
    for (let hop = 0; hop <= maxRedirects; hop++) {
      if (new URL(currentUrl).origin !== baseOrigin) throw new Error("cross-origin blocked");
      const res = await fetch(currentUrl, currentInit);
      if (![301, 302, 303, 307, 308].includes(res.status)) return res;
      const loc = res.headers.get("location");
      if (res.body) void res.body.cancel().catch(() => {});
      if (!loc || hop === maxRedirects) throw new Error("redirect limit or missing location");
      const nextUrl = new URL(loc, currentUrl);
      if (nextUrl.origin !== baseOrigin) throw new Error("cross-origin redirect blocked");
      currentUrl = nextUrl.href;
      if ([301, 302, 303].includes(res.status) && currentInit.method && currentInit.method !== "GET" && currentInit.method !== "HEAD") {
        const nextHeaders = { ...(currentInit.headers || {}) };
        delete nextHeaders["Content-Type"];
        delete nextHeaders["content-type"];
        currentInit = { ...currentInit, method: "GET", body: undefined, headers: nextHeaders };
      }
    }
    throw new Error("redirect limit");
  }

  async function probeHttpMcp(s, timeoutMs) {
    const initPayload = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t3-hub-probe", version: "2.0.0" } },
    });
    const baseOrigin = new URL(s.url).origin;
    const deadline = Date.now() + timeoutMs;
    const remainingMs = () => Math.max(1, deadline - Date.now());
    const baseHeaders = s.headers && typeof s.headers === "object" ? s.headers : {};
    let postStatus = 0;

    if (s.transport !== "sse") {
      try {
        const res = await fetchSameOrigin(s.url, baseOrigin, {
          method: "POST",
          headers: { ...baseHeaders, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
          body: initPayload,
          signal: AbortSignal.timeout(remainingMs()),
        });
        postStatus = res.status;
        if (res.ok) {
          const ct = String(res.headers.get("content-type") || "").toLowerCase();
          if (ct.includes("text/event-stream") && res.body) {
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buf = "";
            try {
              while (Date.now() < deadline && buf.length < 65536) {
                const { value, done } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                if (extractSseInitResult(buf)) return true;
              }
            } finally {
              void reader.cancel().catch(() => {});
            }
            return extractSseInitResult(buf);
          }
          const text = await res.text();
          try { return isValidMcpInitResponse(JSON.parse(text)); } catch { return false; }
        }
        if (res.body) void res.body.cancel().catch(() => {});
      } catch {
        if (Date.now() >= deadline) return false;
      }
    }

    if (Date.now() >= deadline || (s.transport !== "sse" && postStatus !== 404 && postStatus !== 405)) return false;

    // Legacy MCP SSE transport: GET stream -> event: endpoint -> same-origin POST initialize -> init result
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), remainingMs());
    if (timer.unref) timer.unref();
    try {
      const sseRes = await fetchSameOrigin(s.url, baseOrigin, {
        method: "GET",
        headers: { ...baseHeaders, Accept: "text/event-stream" },
        signal: ac.signal,
      });
      if (!sseRes.ok || !String(sseRes.headers.get("content-type") || "").toLowerCase().includes("text/event-stream") || !sseRes.body) {
        if (sseRes.body) void sseRes.body.cancel().catch(() => {});
        return false;
      }
      const reader = sseRes.body.getReader();
      const decoder = new TextDecoder();
      let buf = "", posted = false;
      try {
        while (Date.now() < deadline && buf.length < 65536) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          if (extractSseInitResult(buf)) return true;
          if (!posted) {
            const blocks = buf.split(/\r?\n\r?\n/);
            for (let i = 0; i < blocks.length - 1; i++) {
              const lines = blocks[i].split(/\r?\n/);
              const evt = lines.find((l) => l.startsWith("event:"))?.slice(6).trim();
              const data = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
              if (evt === "endpoint" && data) {
                posted = true;
                const endpointUrl = new URL(data, s.url);
                if (endpointUrl.origin !== baseOrigin) return false;
                const postRes = await fetchSameOrigin(endpointUrl.href, baseOrigin, {
                  method: "POST",
                  headers: { ...baseHeaders, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
                  body: initPayload,
                  signal: AbortSignal.timeout(remainingMs()),
                });
                if (!postRes.ok) {
                  if (postRes.body) void postRes.body.cancel().catch(() => {});
                  return false;
                }
                const postText = await postRes.text();
                if (extractSseInitResult(postText)) return true;
                try { if (isValidMcpInitResponse(JSON.parse(postText))) return true; } catch {}
                break;
              }
            }
          }
        }
      } finally {
        void reader.cancel().catch(() => {});
      }
      return false;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
      ac.abort();
    }
  }

  function probeStdioMcp(s, projectRoot, timeoutMs) {
    const expandHome = (value) => String(value).replace(/^~(?=\/)/, () => homeDir);
    const cwd = path.resolve(projectRoot || homeDir, expandHome(s.cwd || "."));
    if (!dirExists(cwd) || !commandAvailable(s, projectRoot)) return Promise.resolve(false);
    const scripts = (s.args || []).filter((a) => typeof a === "string" && !a.startsWith("-") && !/^[a-z]+:\/\//i.test(a) && /\.(?:[cm]?js|py|sh|rb|pl|ts)$/.test(a));
    if (scripts.some((script) => !fileExists(path.resolve(cwd, expandHome(script))))) return Promise.resolve(false);

    return new Promise((resolve) => {
      let settled = false, killTimer = null, timeoutTimer = null;
      let child;
      const isChildAlive = () => Boolean(child && child.exitCode === null && child.signalCode === null);
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        if (isChildAlive()) {
          try { child.kill("SIGTERM"); } catch {}
          killTimer = setTimeout(() => { try { if (isChildAlive()) child.kill("SIGKILL"); } catch {} }, 80);
          if (killTimer.unref) killTimer.unref();
        }
        resolve(ok);
      };
      try {
        const cmd = expandHome(s.command);
        const args = (Array.isArray(s.args) ? s.args : []).map((a) => (typeof a === "string" ? expandHome(a) : String(a)));
        const env = { ...process.env, ...(s.env && typeof s.env === "object" ? s.env : {}) };
        child = spawn(cmd, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
      } catch {
        finish(false);
        return;
      }
      timeoutTimer = setTimeout(() => finish(false), timeoutMs);
      if (timeoutTimer.unref) timeoutTimer.unref();
      child.stderr.resume();
      child.on("error", () => finish(false));
      child.on("exit", () => { clearTimeout(killTimer); if (!settled) finish(false); });

      let rawBuf = Buffer.alloc(0);
      child.stdout.on("data", (chunk) => {
        if (settled) return;
        rawBuf = Buffer.concat([rawBuf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
        if (rawBuf.length > 262144) { finish(false); return; }
        // Parse Content-Length framed messages safely across chunk boundaries
        while (rawBuf.length > 0) {
          const headSample = rawBuf.subarray(0, Math.min(rawBuf.length, 64)).toString("utf8");
          const trimmedHead = headSample.trimStart();
          if (!/^content-length\s*:/i.test(trimmedHead)) {
            if (trimmedHead.length > 0 && "content-length:".startsWith(trimmedHead.toLowerCase()) && !trimmedHead.includes("\n")) return;
            break;
          }
          const crlfEnd = rawBuf.indexOf("\r\n\r\n");
          const lfEnd = rawBuf.indexOf("\n\n");
          const useCrlf = crlfEnd >= 0 && (lfEnd < 0 || crlfEnd <= lfEnd);
          const headerEnd = useCrlf ? crlfEnd : lfEnd;
          const sepLen = useCrlf ? 4 : 2;
          if (headerEnd < 0) return;
          const match = rawBuf.subarray(0, headerEnd).toString("utf8").match(/Content-Length:\s*(\d+)/i);
          if (!match) { finish(false); return; }
          const bodyLen = Number(match[1]);
          if (!Number.isFinite(bodyLen) || bodyLen < 0 || bodyLen > 262144) { finish(false); return; }
          if (rawBuf.length < headerEnd + sepLen + bodyLen) return;
          const body = rawBuf.subarray(headerEnd + sepLen, headerEnd + sepLen + bodyLen).toString("utf8");
          rawBuf = rawBuf.subarray(headerEnd + sepLen + bodyLen);
          try { if (isValidMcpInitResponse(JSON.parse(body))) { finish(true); return; } } catch {}
        }
        // Parse newline-delimited JSON-RPC messages
        let nl;
        while ((nl = rawBuf.indexOf(10)) >= 0) {
          const line = rawBuf.subarray(0, nl).toString("utf8").trim();
          rawBuf = rawBuf.subarray(nl + 1);
          if (!line) continue;
          try { if (isValidMcpInitResponse(JSON.parse(line))) { finish(true); return; } } catch {}
        }
      });

      const initReq = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t3-hub-probe", version: "2.0.0" } },
      }) + "\n";
      child.stdin.on("error", () => {});
      try { child.stdin.write(initReq); } catch { finish(false); }
    });
  }

  async function probeMcpServers({ name, projectRoot, timeoutMs = 1800 } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error("invalid timeoutMs");
    const servers = [...discoverServerDefinitions().values()].filter(s => !name || normKey(s.name) === normKey(name));
    const results = {};
    await Promise.all(servers.map(async s => {
      const start = Date.now(); let connected = false;
      try {
        if (s.url) connected = await probeHttpMcp(s, timeoutMs);
        else if (s.command) connected = await probeStdioMcp(s, projectRoot, timeoutMs);
      } catch {}
      results[s.name] = { connected, latencyMs: Date.now() - start, statusText: connected ? "已完成 MCP 握手，服务可用。" : "MCP 握手未通过或服务不可达。" };
    }));
    // Merge after awaiting probes so concurrent single-server probes do not
    // overwrite results saved by another call while this one was in flight.
    const cache = readJsonFile(probeCachePath, {}) || {};
    for (const server of servers) cache[probeKey(server, projectRoot)] = { ...results[server.name], checkedAt: new Date().toISOString() };
    if (servers.length) writeJsonFileSecure(probeCachePath, cache);
    return { ok: true, results };
  }
  const autoSyncHosts = syncRouterToClis;

  return { homeDir, hubDir, statePath, registryPath, listMcpServers, setPluginMcpScope, setMcpMode, setServerMode, upsertMcpServer, removeMcpServer, syncRouterToClis, autoSyncHosts, probeMcpServers, discoverServerDefinitions, discoverDefinitions };
}

let _router = null;
function getDefaultMcpRouter() { if (!_router) _router = createMcpRouter(); return _router; }
function listMcpServers(a) { return getDefaultMcpRouter().listMcpServers(a || {}); }
function setMcpMode(a) { return getDefaultMcpRouter().setMcpMode(a || {}); }
function setServerMode(a) { return getDefaultMcpRouter().setServerMode(a || {}); }
function upsertMcpServer(a) { return getDefaultMcpRouter().upsertMcpServer(a || {}); }
function removeMcpServer(a) { return getDefaultMcpRouter().removeMcpServer(a || {}); }
function syncRouterToClis() { return getDefaultMcpRouter().syncRouterToClis(); }
function autoSyncHosts() { return getDefaultMcpRouter().autoSyncHosts(); }
function probeMcpServers(args) { return getDefaultMcpRouter().probeMcpServers(args || {}); }
function discoverServerDefinitions(opts) { return getDefaultMcpRouter().discoverServerDefinitions(opts || {}); }

module.exports = {
  createMcpRouter, redactSummary, redactArgs, redactUrl, ALLOWED_MODES, BUILTIN_UPSTREAM_MCPS, probeMcpServers, autoSyncHosts,
  listMcpServers, setMcpMode, setServerMode, upsertMcpServer, removeMcpServer, syncRouterToClis,
  discoverServerDefinitions, getDefaultMcpRouter, parseTomlTableHeader,
};
