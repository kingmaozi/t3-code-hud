"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

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
const HUB_NAMES = new Set(["t3_hub", "t3-hub"]);

function createMcpRouter(opts = {}) {
  const homeDir = opts.homeDir || process.env.HOME || os.homedir();
  const hubDir = opts.hubDir || process.env.T3_HUB_DIR || path.join(homeDir, ".t3", "hub");
  const statePath = path.join(hubDir, "state.json");
  const registryPath = path.join(hubDir, "mcp-registry.json");
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
        if (HUB_NAMES.has(name)) continue;
        out.push({ name, ...(v || {}), __source: sourceKey, __sourceLabel: sourceLabel });
      }
    }
    return out;
  }

  function discoverDefinitions() {
    const byName = new Map();
    function add(s) { if (!s || !s.name || HUB_NAMES.has(s.name)) return; if (!byName.has(s.name)) byName.set(s.name, s); }
    const magpiePath = path.join(homeDir, ".config", "magpie", "library.json");
    const magpie = readJsonFile(magpiePath, null);
    if (magpie && Array.isArray(magpie.mcp)) {
      for (const e of magpie.mcp) if (e && e.name) add({ name: e.name, transport: e.transport || (e.url ? "http" : "stdio"), command: e.command, args: e.args, env: e.env, url: e.url, agents: e.agents, __source: "magpie", __sourceLabel: "magpie" });
    }
    for (const s of collectFromFile(path.join(homeDir, ".pi", "agent", "mcp.json"), "pi", "pi")) add(s);
    for (const s of collectFromFile(path.join(homeDir, ".config", "muse", "settings.json"), "muse", "muse")) add(s);
    for (const s of collectFromFile(path.join(homeDir, ".claude", "mcp.json"), "claude", "claude")) add(s);
    const agyRoot = path.join(homeDir, ".t3", "userdata", "providers", "antigravity");
    if (dirExists(agyRoot)) for (const inst of listDirs(agyRoot)) for (const s of collectFromFile(path.join(inst, "config", "mcp_config.json"), "agy", "agy")) add(s);
    return byName;
  }
  function discoverServerDefinitions(opts = {}) {
    if (opts.homeDir && opts.hubDir && (opts.homeDir !== homeDir || opts.hubDir !== hubDir)) {
      return createMcpRouter({ homeDir: opts.homeDir, hubDir: opts.hubDir }).discoverServerDefinitions();
    }
    const m = discoverDefinitions();
    // Overlay registry (registry wins) for a complete raw map.
    for (const s of readRegistry()) {
      if (!s || !s.name || HUB_NAMES.has(s.name)) continue;
      m.set(s.name, { ...s, __source: s.__source || "hub", __sourceLabel: s.__sourceLabel || "hub" });
    }
    return m;
  }

  function listMcpServers(args = {}) {
    const projectRoot = args.projectRoot || null;
    const byName = discoverDefinitions();
    function add(s) { if (!s || !s.name || HUB_NAMES.has(s.name)) return; if (!byName.has(s.name)) byName.set(s.name, s); }
    for (const s of readRegistry()) add({ ...s, __source: s.__source || "hub", __sourceLabel: s.__sourceLabel || "hub" });
    const state = readState();
    const globalModes = state.mcpModes?.global || {};
    const projModes = projectRoot ? (state.mcpModes?.projects?.[projectRoot] || {}) : {};
    const items = [...byName.values()].map((s) => {
      const mode = projModes[s.name] || globalModes[s.name] || "off";
      const env = s.env && typeof s.env === "object" ? Object.keys(s.env) : [];
      const hasSecrets = env.some((k) => isSecretKey(k));
      return {
        name: s.name,
        transport: s.transport || (s.url ? "http" : "stdio"),
        command: s.command || null,
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

  function setMcpMode(args = {}) {
    const { name, mode } = args;
    const projectRoot = args.projectRoot || null;
    if (!name || !ALLOWED_MODES.includes(mode)) throw new Error("invalid name or mode");
    const state = readState();
    state.mcpModes = state.mcpModes || { global: {}, projects: {} };
    state.mcpModes.global = state.mcpModes.global || {};
    state.mcpModes.projects = state.mcpModes.projects || {};
    if (mode.startsWith("project-")) {
      if (!projectRoot) throw new Error("projectRoot required for project mode");
      state.mcpModes.projects[projectRoot] = state.mcpModes.projects[projectRoot] || {};
      state.mcpModes.projects[projectRoot][name] = mode;
    } else if (mode.startsWith("global-")) {
      state.mcpModes.global[name] = mode;
      if (projectRoot && state.mcpModes.projects?.[projectRoot]?.[name] === "off") {
        delete state.mcpModes.projects[projectRoot][name];
      }
    } else {
      if (projectRoot && state.mcpModes.projects[projectRoot]) state.mcpModes.projects[projectRoot][name] = "off";
      else if (projectRoot) { state.mcpModes.projects[projectRoot] = { ...(state.mcpModes.projects[projectRoot] || {}), [name]: "off" }; }
      else state.mcpModes.global[name] = "off";
    }
    writeState(state);
    if (mode !== "off" && !HUB_NAMES.has(name)) {
      const reg = readRegistry();
      if (!reg.some((e) => e.name === name)) {
        const discovered = discoverDefinitions().get(name);
        if (discovered) {
          reg.push({
            name: discovered.name,
            transport: discovered.transport || (discovered.url ? "http" : "stdio"),
            command: discovered.command || null,
            args: Array.isArray(discovered.args) ? discovered.args : [],
            env: discovered.env && typeof discovered.env === "object" ? discovered.env : {},
            url: discovered.url || null,
            agents: discovered.agents || null,
            __source: discovered.__source || "magpie",
            __sourceLabel: discovered.__sourceLabel || discovered.__source || "magpie",
          });
          writeRegistry(reg);
        }
      }
    }
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
          if (HUB_NAMES.has(name)) continue;
          list.push({ name, ...(v || {}) });
        }
      } else if (parsed && typeof parsed === "object" && (parsed.transport || parsed.command || parsed.url)) {
        if (!parsed.name && !payload.name) throw new Error("name required");
        list.push({ name: payload.name || parsed.name, ...parsed });
      } else if (parsed && typeof parsed === "object") {
        for (const [name, v] of Object.entries(parsed)) if (!HUB_NAMES.has(name) && v && typeof v === "object") list.push({ name, ...v });
      }
    } else {
      if (!payload.name) throw new Error("name required");
      if (HUB_NAMES.has(payload.name)) throw new Error("cannot override t3_hub");
      list.push({
        name: payload.name,
        transport: payload.transport || (payload.url ? "http" : "stdio"),
        command: payload.command || null,
        args: Array.isArray(payload.args) ? payload.args : (payload.args ? [payload.args] : []),
        env: payload.env || {},
        url: payload.url || null,
        agents: payload.agents || null,
      });
    }
    const reg = readRegistry();
    for (const s of list) {
      const i = reg.findIndex((e) => e.name === s.name);
      if (i >= 0) reg[i] = { ...reg[i], ...s };
      else reg.push(s);
    }
    writeRegistry(reg);
    const items = reg.map((s) => {
      const env = s.env && typeof s.env === "object" ? Object.keys(s.env) : [];
      return { name: s.name, transport: s.transport || "stdio", command: s.command || null, args: redactArgs(Array.isArray(s.args) ? s.args : []), url: s.url ? redactUrl(s.url) : null, agents: s.agents || null, source: "hub", sourceLabel: "hub", mode: "off", hasSecrets: env.some((k) => isSecretKey(k)), summary: redactSummary(s) };
    }).sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, items };
  }

  function removeMcpServer(args = {}) {
    const { name } = args;
    if (!name) throw new Error("name required");
    const reg = readRegistry().filter((e) => e.name !== name);
    writeRegistry(reg);
    const state = readState();
    if (state.mcpModes?.global) delete state.mcpModes.global[name];
    if (state.mcpModes?.projects) for (const k of Object.keys(state.mcpModes.projects)) delete state.mcpModes.projects[k][name];
    writeState(state);
    return { ok: true, name };
  }

  function backupOnce(file) {
    const bak = file + ".bak-t3hub";
    if (fileExists(file) && !fileExists(bak)) { try { fs.copyFileSync(file, bak); } catch {} }
  }
  function syncRouterToClis() {
    const synced = [], skipped = [];
    const cfgPath = path.join(homeDir, ".codex", "config.toml");
    if (!dirExists(path.dirname(cfgPath))) skipped.push(cfgPath);
    else {
      backupOnce(cfgPath);
      let raw = "";
      try { raw = fs.readFileSync(cfgPath, "utf8"); } catch {}
      const section = `[mcp_servers.t3_hub]\ncommand = ${JSON.stringify(routerBin)}\nargs = []\n`;
      if (raw.includes("[mcp_servers.t3_hub]")) {
        if (!raw.includes(routerBin)) {
          const lines = raw.split(/\r?\n/);
          let inSec = false;
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].trim().startsWith("[mcp_servers")) inSec = lines[i].trim() === "[mcp_servers.t3_hub]";
            else if (lines[i].trim().startsWith("[") && inSec) break;
            if (inSec && /^\s*command\s*=/.test(lines[i])) lines[i] = `command = ${JSON.stringify(routerBin)}`;
          }
          fs.writeFileSync(cfgPath, lines.join("\n"), "utf8");
        }
      } else {
        const out = (raw.trim() ? raw.replace(/\s+$/, "") + "\n\n" : "") + section;
        fs.writeFileSync(cfgPath, out, "utf8");
      }
      synced.push(cfgPath);
    }
    function syncJson(file) {
      if (!dirExists(path.dirname(file))) { skipped.push(file); return; }
      backupOnce(file);
      const cur = readJsonFile(file, {});
      const obj = cur && typeof cur === "object" && !Array.isArray(cur) ? cur : {};
      obj.mcpServers = obj.mcpServers && typeof obj.mcpServers === "object" ? obj.mcpServers : {};
      obj.mcpServers.t3_hub = { command: routerBin, args: [] };
      writeJsonFile(file, obj);
      synced.push(file);
    }
    syncJson(path.join(homeDir, ".pi", "agent", "mcp.json"));
    syncJson(path.join(homeDir, ".config", "muse", "settings.json"));
    syncJson(path.join(homeDir, ".claude", "mcp.json"));
    return { ok: true, syncedTargets: synced, skippedTargets: skipped };
  }

  return { homeDir, hubDir, statePath, registryPath, listMcpServers, setMcpMode, setServerMode, upsertMcpServer, removeMcpServer, syncRouterToClis, discoverServerDefinitions, discoverDefinitions };
}

let _router = null;
function getDefaultMcpRouter() { if (!_router) _router = createMcpRouter(); return _router; }
function listMcpServers(a) { return getDefaultMcpRouter().listMcpServers(a || {}); }
function setMcpMode(a) { return getDefaultMcpRouter().setMcpMode(a || {}); }
function setServerMode(a) { return getDefaultMcpRouter().setServerMode(a || {}); }
function upsertMcpServer(a) { return getDefaultMcpRouter().upsertMcpServer(a || {}); }
function removeMcpServer(a) { return getDefaultMcpRouter().removeMcpServer(a || {}); }
function syncRouterToClis() { return getDefaultMcpRouter().syncRouterToClis(); }
function discoverServerDefinitions(opts) { return getDefaultMcpRouter().discoverServerDefinitions(opts || {}); }

module.exports = {
  createMcpRouter, redactSummary, redactArgs, redactUrl, ALLOWED_MODES,
  listMcpServers, setMcpMode, setServerMode, upsertMcpServer, removeMcpServer, syncRouterToClis,
  discoverServerDefinitions, getDefaultMcpRouter,
};
