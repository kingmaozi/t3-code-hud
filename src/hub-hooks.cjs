"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SubagentStop"];
const SCOPES = ["global", "project", "off"];
const MARK = "_t3HubHookId";
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const quote = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
const quotePath = s => '"' + String(s).replace(/[\\"$`]/g, "\\$&") + '"';
const mkdir = dir => fs.mkdirSync(dir, { recursive: true });
function readJson(file, fallback) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected object");
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw new Error(`Cannot safely merge ${file}: ${error.message}`);
  }
}
function atomic(file, text) {
  mkdir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  try { fs.writeFileSync(tmp, text, { mode: 0o600 }); fs.renameSync(tmp, file); }
  finally { try { fs.unlinkSync(tmp); } catch {} }
}
function backupOnce(file) {
  if (!fs.existsSync(file)) return;
  try { fs.copyFileSync(file, file + ".bak-t3hub", fs.constants.COPYFILE_EXCL); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
}
function validateScope(scope, projectRoot) {
  if (!SCOPES.includes(scope)) throw new Error("invalid hook scope");
  if (scope === "project" && (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot))) throw new Error("projectRoot required for project hook");
}
function validateHook(item) {
  if (typeof item.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,200}$/.test(item.id)) throw new Error("invalid hook id");
  if (!Array.isArray(item.events) || !item.events.length || item.events.some(e => !EVENTS.includes(e))) throw new Error("invalid hook event");
  if (item.matcher != null && typeof item.matcher !== "string") throw new Error("invalid hook matcher");
  if (item.matcher && item.matcher !== "*") { try { new RegExp(item.matcher); } catch { throw new Error("invalid hook matcher"); } }
  if (item.handlers) {
    if (!Array.isArray(item.handlers) || !item.handlers.length) throw new Error("hook handlers required");
    for (const h of item.handlers) {
      if (!h || !["command", "prompt", "agent", "http", "mcp_tool"].includes(h.type)) throw new Error("invalid plugin hook handler");
      if (h.type === "command" && (typeof h.command !== "string" || !h.command.trim())) throw new Error("hook command required");
    }
  } else if (typeof item.command !== "string" || !item.command.trim()) throw new Error("hook command required");
  validateScope(item.scope, item.projectRoot);
}

function createHooksManager({ homeDir = process.env.HOME || os.homedir(), hubDir = process.env.T3_HUB_DIR || path.join(homeDir, ".t3", "hub"), binDir = path.join(homeDir, ".t3", "bin") } = {}) {
  const statePath = path.join(hubDir, "hooks-state.json");
  const defaults = [
    { id: "memory-stop-guard", title: "收尾再记忆守门员 (热缓存防漏记)", events: ["Stop", "SubagentStop"], command: `node ${quotePath(path.join(binDir, "memory-stop-hook.mjs"))}`, scope: "global" },
    { id: "subagent-route-guard", title: "子智能体配置实时生效拦截器", events: ["PreToolUse"], matcher: ".*delegate_task.*", command: `node ${quotePath(path.join(binDir, "subagent-route-guard.mjs"))}`, scope: "global" },
    { id: "secret-commit-guard", title: "敏感文件提交守门员", events: ["PreToolUse"], matcher: "Bash", command: `node ${quotePath(__filename)} --builtin secret`, scope: "off" },
    { id: "js-syntax-postcheck", title: "JavaScript 编辑后语法检查", events: ["PostToolUse"], matcher: "Write|Edit", command: `node ${quotePath(__filename)} --builtin syntax`, scope: "off" },
  ].map(h => ({ ...h, builtin: true, readonly: false, source: "hub" }));

  function load() {
    const state = readJson(statePath, { version: 1, hooks: [], projectRoots: [] });
    if (!Array.isArray(state.hooks) || !Array.isArray(state.projectRoots)) throw new Error("invalid hooks state");
    const hooks = defaults.map(d => {
      const saved = state.hooks.find(h => h.id === d.id);
      return { ...d, scope: saved?.scope || d.scope, projectRoot: saved?.projectRoot || null };
    });
    hooks.push(...state.hooks.filter(h => !defaults.some(d => d.id === h.id)));
    return { ...state, hooks };
  }
  function files(projectRoot) {
    return projectRoot ? [path.join(projectRoot, ".claude", "settings.local.json"), path.join(projectRoot, ".codex", "hooks.json")]
      : [path.join(homeDir, ".claude", "settings.json"), path.join(homeDir, ".codex", "hooks.json")];
  }
  function ensureExclude(projectRoot) {
    const git = path.join(projectRoot, ".git");
    let gitDir = git;
    try {
      if (fs.statSync(git).isFile()) {
        const match = fs.readFileSync(git, "utf8").match(/^gitdir:\s*(.+)$/m);
        if (!match) return;
        gitDir = path.resolve(projectRoot, match[1].trim());
      }
      if (!fs.statSync(gitDir).isDirectory()) return;
    } catch { return; }
    const file = path.join(gitDir, "info", "exclude");
    let original = "";
    try { original = fs.readFileSync(file, "utf8"); } catch (e) { if (e.code !== "ENOENT") throw e; }
    const entries = ["/.claude/settings.local.json", "/.claude/settings.local.json.bak-t3hub", "/.codex/hooks.json", "/.codex/hooks.json.bak-t3hub"];
    const missing = entries.filter(e => !original.split(/\r?\n/).includes(e));
    if (missing.length) atomic(file, original + (original && !original.endsWith("\n") ? "\n" : "") + missing.join("\n") + "\n");
  }
  function cleanGroup(group) {
    if (!group || typeof group !== "object") return group;
    const tagged = own(group, MARK);
    if (!Array.isArray(group.hooks)) return tagged ? null : group;
    const hooks = group.hooks.filter(h => !h || typeof h !== "object" || !own(h, MARK));
    if (!hooks.length && (tagged || hooks.length !== group.hooks.length)) return null;
    if (!tagged && hooks.length === group.hooks.length) return group;
    const copy = { ...group, hooks }; delete copy[MARK]; return copy;
  }
  function merge(file, hooks) {
    const original = readJson(file, {}), next = { ...original };
    if (original.hooks != null && (typeof original.hooks !== "object" || Array.isArray(original.hooks))) throw new Error(`Cannot safely merge hooks in ${file}`);
    const events = { ...(original.hooks || {}) };
    // Strip only our markers, including orphaned entries from removed plugins.
    for (const [event, groups] of Object.entries(events)) {
      if (!Array.isArray(groups)) throw new Error(`Cannot safely merge ${event} hooks in ${file}`);
      if (!groups.some(g => g && typeof g === "object" && (own(g, MARK) || (Array.isArray(g.hooks) && g.hooks.some(h => h && own(h, MARK)))))) continue;
      events[event] = groups.map(cleanGroup).filter(g => g !== null);
      if (!events[event].length) delete events[event];
    }
    for (const h of hooks) for (const event of h.events) {
      const handlers = h.handlers || [{ type: "command", command: h.command, timeout: 10 }];
      const group = { ...(h.groupOptions || {}), [MARK]: h.id, ...(h.matcher != null ? { matcher: h.matcher } : {}), hooks: handlers.map(handler => {
        if (handler.type !== "command") return { ...handler, [MARK]: h.id };
        let command = handler.command;
        if (h.builtin && ["memory-stop-guard", "subagent-route-guard"].includes(h.id)) command = `T3_HUB_DIR=${quote(hubDir)} ${command}`;
        if (h.installPath) command = `CLAUDE_PLUGIN_ROOT=${quote(h.installPath)} PLUGIN_ROOT=${quote(h.installPath)} ${command}`;
        return { ...handler, command, [MARK]: h.id };
      }) };
      (events[event] ||= []).push(group);
    }
    next.hooks = events;
    const text = JSON.stringify(next, null, 2) + "\n";
    // Leave files with no Hub entries untouched, including whitespace and empty groups.
    if (!hooks.length && JSON.stringify(original.hooks || {}) === JSON.stringify(events)) return null;
    if (JSON.stringify(original) === JSON.stringify(next)) return null;
    return { file, text };
  }
  function synchronize(state) {
    const projects = new Set(state.projectRoots);
    for (const h of state.hooks) if (h.projectRoot) projects.add(path.resolve(h.projectRoot));
    const changes = [];
    for (const project of [null, ...projects]) {
      const hooks = state.hooks.filter(h => project ? h.scope === "project" && path.resolve(h.projectRoot) === project : h.scope === "global");
      for (const file of files(project)) { const change = merge(file, hooks); if (change) changes.push(change); }
    }
    // Validate every destination before making any changes.
    for (const { file } of changes) backupOnce(file);
    for (const { file, text } of changes) atomic(file, text);
    for (const project of projects) ensureExclude(project);
    state.projectRoots = [...projects];
    atomic(statePath, JSON.stringify(state, null, 2) + "\n");
  }
  function externalHooks(file, source, scope) {
    const config = readJson(file, {}), result = [];
    for (const [event, groups] of Object.entries(config.hooks || {})) {
      if (!Array.isArray(groups)) continue;
      groups.forEach((group, i) => (group.hooks || []).forEach((handler, j) => {
        if (own(handler, MARK)) return;
        result.push({ id: `external:${scope}:${source}:${event}:${i}:${j}`, title: handler.statusMessage || handler.command || event, event, events: [event], matcher: group.matcher, command: handler.command, scope, readonly: true, source, file });
      }));
    }
    return result;
  }
  function listHooks({ projectRoot = null } = {}) {
    const state = load(); synchronize(state);
    const externals = [];
    for (const project of [null, ...(projectRoot ? [path.resolve(projectRoot)] : [])]) files(project).forEach((file, i) => externals.push(...externalHooks(file, i ? "codex" : "claude", project ? "project" : "global")));
    const items = [...state.hooks.map(h => ({ ...h, enabled: h.scope !== "off", readonly: false })), ...externals];
    return { ok: true, projectRoot, events: [...EVENTS], items, hooks: items };
  }
  function toggleHook(args = {}) {
    const state = load(), item = state.hooks.find(h => h.id === args.id);
    if (!item) throw new Error("unknown or readonly hook");
    const scope = args.scope || (args.enabled === false || (args.enabled == null && item.scope !== "off") ? "off" : "global");
    const projectRoot = args.projectRoot || item.projectRoot;
    validateScope(scope, projectRoot);
    if (item.projectRoot && !state.projectRoots.includes(item.projectRoot)) state.projectRoots.push(item.projectRoot);
    item.scope = scope; item.projectRoot = scope === "project" ? path.resolve(projectRoot) : null;
    synchronize(state); return { ok: true, item, ...listHooks({ projectRoot: args.projectRoot }) };
  }
  function saveCustomHook(args = {}) {
    const state = load(), input = args.item || args;
    const id = input.id || args.id;
    const previous = state.hooks.find(h => h.id === id);
    if (previous && !previous.custom) throw new Error("cannot replace builtin or plugin hook");
    const item = { ...previous, ...input, id, title: input.title || previous?.title || id, scope: args.scope || input.scope || previous?.scope || "global", projectRoot: args.projectRoot || input.projectRoot || previous?.projectRoot || null, custom: true, builtin: false, source: "custom", readonly: false };
    if (input.event) item.events = [input.event];
    if (!item.events) item.events = ["Stop"];
    validateHook(item);
    if (previous?.projectRoot) state.projectRoots.push(previous.projectRoot);
    if (item.scope !== "project") item.projectRoot = null;
    state.hooks = state.hooks.filter(h => h.id !== id).concat(item);
    synchronize(state); return { ok: true, item };
  }
  function deleteCustomHook({ id } = {}) {
    const state = load(), item = state.hooks.find(h => h.id === id);
    if (item && !item.custom) throw new Error("cannot delete builtin or plugin hook");
    if (!item) return { ok: true, deleted: false };
    if (item.projectRoot) state.projectRoots.push(item.projectRoot);
    state.hooks = state.hooks.filter(h => h.id !== id);
    synchronize(state); return { ok: true, deleted: true };
  }
  function setPluginHooks({ pluginId, id, hooks = {}, scope = "global", projectRoot = null, installPath } = {}) {
    pluginId ||= id;
    if (!pluginId || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(pluginId)) throw new Error("invalid plugin id");
    validateScope(scope, projectRoot);
    const state = load();
    for (const old of state.hooks.filter(h => h.pluginId === pluginId)) if (old.projectRoot) state.projectRoots.push(old.projectRoot);
    state.hooks = state.hooks.filter(h => h.pluginId !== pluginId);
    if (scope !== "off") {
      const events = hooks.hooks || hooks;
      for (const [event, groups] of Object.entries(events)) {
        if (!EVENTS.includes(event) || !Array.isArray(groups)) throw new Error("invalid plugin hook event");
        groups.forEach((group, index) => {
          const { hooks: handlers, matcher, ...groupOptions } = group;
          const item = { id: `plugin:${pluginId}:${event}:${index}`, title: `${pluginId} · ${event}`, pluginId, events: [event], matcher, handlers, groupOptions, scope, projectRoot: scope === "project" ? path.resolve(projectRoot) : null, installPath, source: "plugin", builtin: false };
          validateHook(item); state.hooks.push(item);
        });
      }
    }
    synchronize(state); return { ok: true, pluginId, scope };
  }
  return { homeDir, hubDir, binDir, statePath, listHooks, toggleHook, saveCustomHook, deleteCustomHook, setPluginHooks };
}

// The optional builtins live in this module to keep installation self-contained.
async function runBuiltin(kind) {
  let text = "";
  if (process.stdin.isTTY) return;
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 250);
    const done = () => { clearTimeout(timer); resolve(); };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => { text += chunk; try { JSON.parse(text); done(); } catch {} });
    process.stdin.once("end", done); process.stdin.once("error", done);
  });
  process.stdin.pause();
  let payload; try { payload = JSON.parse(text); } catch { return; }
  const input = payload.tool_input || {}, cwd = payload.cwd || process.cwd();
  if (kind === "secret") {
    const command = input.command || "";
    if (!/\bgit\b[\s\S]*\b(?:add|commit)\b/.test(command)) return;
    const secret = p => /(?:^|[\/\\])(?:\.env(?:\.[^\/\\]+)?|keys\.env|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.[^\/\\]+)?|[^\/\\]*\.(?:pem|key|p12|pfx))$/i.test(p);
    const privateKey = text => /-----BEGIN (?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----/.test(text);
    const tokens = (command.match(/"[^"]*"|'[^']*'|&&|\|\||[;&|]|[^\s;&|]+/g) || []).map(s => s.replace(/^["']|["']$/g, ""));
    let workingDir = cwd, blocked = false;
    const segments = [[]];
    for (const token of tokens) {
      if (["&&", "||", ";", "&", "|"].includes(token)) segments.push([]);
      else segments[segments.length - 1].push(token);
    }
    for (const words of segments) {
      if (words[0] === "cd" && words[1]) { workingDir = path.resolve(workingDir, words[1]); continue; }
      const gi = words.findIndex(w => w === "git" || w.endsWith("/git"));
      if (gi < 0) continue;
      let gitCwd = workingDir, op = gi + 1;
      while (op < words.length && !["add", "commit"].includes(words[op])) {
        if (words[op] === "-C" && words[op + 1]) { gitCwd = path.resolve(gitCwd, words[++op]); }
        op++;
      }
      if (op === words.length) continue;
      const operation = words[op], args = words.slice(op + 1);
      const gitNames = gitArgs => {
        try { return execFileSync("git", ["-C", gitCwd, ...gitArgs], { encoding: "utf8", timeout: 1000, maxBuffer: 2 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).split("\0").filter(Boolean); } catch { return []; }
      };
      const staged = gitNames(["diff", "--cached", "--name-only", "-z"]);
      let candidates = staged;
      if (operation === "add") {
        let afterDash = false;
        const specs = args.filter(a => { if (a === "--") { afterDash = true; return false; } return afterDash || !a.startsWith("-"); });
        candidates = gitNames(["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...specs]);
        if (specs.some(secret)) blocked = true;
      } else if (args.some(a => a === "--all" || /^-[^-]*a/.test(a))) {
        candidates = [...staged, ...gitNames(["diff", "--name-only", "-z"])];
      }
      for (const name of candidates) {
        if (secret(name)) { blocked = true; break; }
        // Also recognize a PEM private key disguised under an ordinary filename.
        if (operation === "commit" && staged.includes(name)) {
          try {
            const content = execFileSync("git", ["-C", gitCwd, "show", ":" + name], { encoding: "utf8", timeout: 1000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
            if (privateKey(content)) { blocked = true; break; }
          } catch {}
        } else {
          let fd;
          try {
            const file = path.resolve(gitCwd, name);
            if (!fs.statSync(file).isFile()) continue;
            fd = fs.openSync(file, "r"); const buffer = Buffer.alloc(65536);
            if (privateKey(buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0)).toString())) { blocked = true; break; }
          } catch {} finally { if (fd != null) fs.closeSync(fd); }
        }
      }
      if (blocked) break;
    }
    if (blocked) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "[T3 敏感文件守门员] 此提交/暂存可能包含 .env、keys.env 或私钥，请移除敏感文件后重试。" } }));
  } else if (kind === "syntax") {
    const names = new Set([input.file_path, input.path]);
    if (typeof input.command === "string") for (const match of input.command.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$/gm)) names.add(match[1].trim());
    const failures = [];
    for (const name of names) {
      if (typeof name !== "string" || !/\.(?:js|cjs|mjs)$/.test(name)) continue;
      try { execFileSync(process.execPath, ["--check", path.resolve(cwd, name)], { timeout: 3000, stdio: ["ignore", "pipe", "pipe"] }); }
      catch (error) { failures.push(`${name}: ${String(error.stderr || error.message).slice(0, 2000)}`); }
    }
    if (failures.length) console.log(JSON.stringify({ decision: "block", reason: "[T3 JS 语法检查] " + failures.join("\n") }));
  }
}
let singleton;
const get = () => singleton ||= createHooksManager();
module.exports = { createHooksManager, EVENTS, listHooks: a => get().listHooks(a), toggleHook: a => get().toggleHook(a), saveCustomHook: a => get().saveCustomHook(a), deleteCustomHook: a => get().deleteCustomHook(a), setPluginHooks: a => get().setPluginHooks(a) };
if (require.main === module && process.argv[2] === "--builtin") runBuiltin(process.argv[3]).catch(() => { process.exitCode = 0; });
