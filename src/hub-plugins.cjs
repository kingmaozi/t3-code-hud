"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);
const MARKERS = [".zcode-plugin", ".codex-plugin", ".claude-plugin"];
const SCOPES = ["off", "project", "global"];
function readJson(file, fallback = {}) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
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
    const value = readJson(file, null);
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  }
  return {};
}
function pluginDetails(dir) {
  const skillDirs = dirs(path.join(dir, "skills")).filter(d => exists(path.join(d, "SKILL.md")));
  const servers = Object.create(null);
  const mcpFiles = [".mcp.json", "servers.mcp.json"].map(f => path.join(dir, f)).filter(exists);
  for (const file of mcpFiles) {
    const raw = readJson(file);
    for (const [name, config] of Object.entries(raw?.mcpServers || raw || {})) {
      if (config && typeof config === "object" && !Array.isArray(config) && (config.command || config.url)) servers[name] = config;
    }
  }
  const hookFile = path.join(dir, "hooks", "hooks.json");
  const hooks = readJson(hookFile);
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
  for (const market of dirs(path.join(homeDir, ".codex", "plugins", "cache"))) for (const plugin of dirs(market)) {
    const latest = path.join(plugin, "latest");
    const versions = dirs(plugin).filter(d => path.basename(d) !== "skills" && /^v?\d/.test(path.basename(d)));
    versions.sort((a, b) => path.basename(b).localeCompare(path.basename(a), undefined, { numeric: true }) || fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    result.push(exists(latest) ? latest : versions[0] || plugin);
  }
  const seen = new Set();
  return result.filter(dir => {
    try { const real = fs.realpathSync(dir); if (seen.has(real)) return false; seen.add(real); return fs.statSync(dir).isDirectory(); } catch { return false; }
  });
}
function pluginId(dir, meta = readPluginManifest(dir)) {
  return meta.id || meta.name || (path.basename(dir) === "latest" || /^v?\d/.test(path.basename(dir)) ? path.basename(path.dirname(dir)) : path.basename(dir));
}
function pluginIcon(dir, id, meta) {
  let icon = meta.icon || null;
  for (const root of [dir, path.dirname(dir), path.dirname(path.dirname(dir))]) {
    const sources = readJson(path.join(root, "icon-sources.json"));
    const entry = sources?.[id] || sources?.plugins?.[id] || sources?.icons?.[id];
    const candidate = typeof entry === "string" ? entry : entry?.icon || entry?.url || entry?.path;
    if (!icon && candidate) icon = /^(?:https?:|data:)/.test(candidate) ? candidate : path.resolve(root, candidate);
  }
  for (const file of [typeof icon === "string" && !/^(?:https?:|data:)/.test(icon) ? path.resolve(dir, icon) : null, path.join(dir, "icon.png")].filter(Boolean)) {
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
  function listPlugins({ projectRoot } = {}) {
    const state = readJson(statePath); const scopes = state.pluginScopes || {};
    const scopeOf = id => SCOPES.includes(scopes[id]) ? (scopes[id] === "project" && projectRoot && state.pluginProjectRoots?.[id] !== projectRoot ? "off" : scopes[id]) : id === "t3-memory-vault" ? "global" : "off";
    const items = [{ id: "t3-memory-vault", name: "t3-memory-vault", title: "T3 Memory Vault · 智能再记忆", description: "轻量明文记忆仓库 + 本地向量语义演进（再记忆）+ Stop 收尾防漏记守门员 + 全宿主自动同步。", version: "2.0.0", marketplace: "t3-builtin", builtin: true, installed: true, icon: "memory-vault", scope: scopeOf("t3-memory-vault"), capabilities: { skillsCount: 1, mcpCount: 1, hooksCount: 1, commandsCount: 1, agentsCount: 0, skillNames: ["powercontext-memory"], mcpNames: ["t3_hub"], hookEvents: ["Stop", "SubagentStop"] } }];
    const seen = new Set(items.map(i => i.id));
    for (const dir of discoverPluginDirectories({ homeDir, hubDir })) {
      const d = pluginDetails(dir); if (!d.composite) continue;
      const meta = readPluginManifest(dir); const id = pluginId(dir, meta);
      try { assertSafeId(id); } catch { continue; }
      if (seen.has(id)) continue; seen.add(id);
      items.push({ id, name: meta.name || id, title: meta.title || meta.displayName || meta.name || id, description: meta.description || "", version: meta.version || "", marketplace: meta.marketplace || (dir.includes(path.sep + "marketplaces" + path.sep) || dir.includes(path.sep + "cache" + path.sep) ? path.basename(path.dirname(path.dirname(dir))) : "local"), builtin: false, installed: true, icon: pluginIcon(dir, id, meta), scope: scopeOf(id), installPath: dir, capabilities: { skillsCount: d.skillDirs.length, mcpCount: Object.keys(d.servers).length, hooksCount: d.hookEvents.length, commandsCount: d.commands.length, agentsCount: d.agents.length, skillNames: d.skillDirs.map(p => path.basename(p)), mcpNames: Object.keys(d.servers), hookEvents: d.hookEvents } });
    }
    return { ok: true, items };
  }
  function validateScope(scope, projectRoot) {
    if (!SCOPES.includes(scope)) throw new Error("invalid scope");
    if (scope === "project" && !projectRoot) throw new Error("projectRoot required for project scope");
    if (projectRoot && (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot))) throw new Error("projectRoot must be absolute");
  }
  function setPluginScope({ id, scope, projectRoot } = {}) {
    assertSafeId(id); validateScope(scope, projectRoot);
    const plugin = listPlugins().items.find(i => i.id === id); if (!plugin) throw new Error("plugin not found");
    const previous = readJson(statePath);
    const oldProject = previous.pluginProjectRoots?.[id];
    const hooks = getHooksManager();
    let skippedMcps = [];
    if (id === "t3-memory-vault") {
      if (oldProject && oldProject !== projectRoot) hooks?.toggleHook?.({ id: "memory-stop-guard", scope: "off", projectRoot: oldProject });
      hooks?.toggleHook?.({ id: "memory-stop-guard", scope, projectRoot: projectRoot || oldProject });
    } else {
      const d = pluginDetails(plugin.installPath);
      // Validate the entire skill set before changing any host configuration.
      d.skillDirs.forEach(sd => assertSafeId(path.basename(sd)));
      if (oldProject && oldProject !== projectRoot) {
        for (const sd of d.skillDirs) skillsManager.setSkillScope({ id: path.basename(sd), scope: "off", projectRoot: oldProject, sourceDir: sd });
        hooks?.setPluginHooks?.({ id, pluginId: id, scope: "off", projectRoot: oldProject, installPath: plugin.installPath, hooks: expandPluginRoot(d.hooks, plugin.installPath) });
      }
      for (const sd of d.skillDirs) skillsManager.setSkillScope({ id: path.basename(sd), scope, projectRoot: projectRoot || oldProject, sourceDir: sd });
      ({ skippedMcps } = mcpRouter.setPluginMcpScope({
        pluginId: id, scope, projectRoot: projectRoot || oldProject,
        servers: Object.entries(d.servers).map(([name, config]) => ({
          ...expandPluginRoot(config, plugin.installPath), name, groupTitle: plugin.title, icon: plugin.icon, installed: true,
        })),
      }));
      if (exists(d.hookFile)) hooks?.setPluginHooks?.({ id, pluginId: id, scope, projectRoot: projectRoot || oldProject, installPath: plugin.installPath, hooks: expandPluginRoot(d.hooks, plugin.installPath) });
    }
    // Re-read after the child managers have written their own state sections.
    const state = readJson(statePath); state.pluginScopes ||= {}; state.pluginScopes[id] = scope;
    state.pluginProjectRoots ||= {};
    if (scope === "project") state.pluginProjectRoots[id] = projectRoot; else delete state.pluginProjectRoots[id];
    fs.mkdirSync(hubDir, { recursive: true });
    const tmp = statePath + ".plugins-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 }); fs.renameSync(tmp, statePath);
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
    const target = path.join(hubDir, "plugins", repo);
    if (exists(target) || (() => { try { fs.lstatSync(target); return true; } catch { return false; } })()) throw new Error("plugin already exists");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      await execFileAsync("git", ["clone", "--", source, target], { timeout: 120000 });
      const plugin = listPlugins().items.find(i => i.installPath === target);
      if (!plugin) throw new Error("cloned repository is not a composite plugin or duplicates an installed plugin");
      return { ...setPluginScope({ id: plugin.id, scope, projectRoot }), installPath: target };
    } catch (error) {
      // Leave successful clones available for recovery if applying host scope failed.
      if (!exists(path.join(target, ".git"))) fs.rmSync(target, { recursive: true, force: true });
      throw error;
    }
  }
  return { listPlugins, setPluginScope, installPluginFromGitHub };
}
let singleton; const get = () => singleton ||= createPluginsManager();
module.exports = { createPluginsManager, listPlugins: args => get().listPlugins(args), setPluginScope: args => get().setPluginScope(args), installPluginFromGitHub: args => get().installPluginFromGitHub(args), discoverPluginDirectories, readPluginManifest, pluginDetails, pluginId, expandPluginRoot };
