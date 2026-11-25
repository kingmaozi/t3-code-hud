"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const PLAN_UPDATE_TOOL = {
  name: "plan_update",
  description: "Update or clear the live T3 Hub checklist. Pass the current threadId explicitly when available so the changes appear immediately in that thread's header.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string" },
      background: { type: "string" },
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: { id: { type: "string" }, text: { type: "string" }, status: { type: "string" } },
          required: ["text", "status"],
        },
      },
      clear: { type: "boolean" },
      projectRoot: { type: "string" },
      threadId: { type: "string", description: "The current thread ID. Defaults to T3_THREAD_ID if the host supplies it." },
    },
  },
};

function handlePlanUpdate(args, board, resolveProjectRoot) {
  const scope = {
    threadId: args.threadId || process.env.T3_THREAD_ID || undefined,
    projectRoot: args.projectRoot || resolveProjectRoot(),
  };
  if (args.clear === true) return board.clearPlan(scope);
  if (!Array.isArray(args.steps)) throw new Error("steps array required");
  return board.updatePlan({ ...scope, title: args.title || "", background: args.background || "", steps: args.steps });
}

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
const CANONICAL_HOSTS = ["antigravity", "muse", "codex", "pi", "claude"];
function normalizeAgentHost(input) {
  if (typeof input !== "string") return null;
  const s = input.trim().toLowerCase();
  if (s === "agy" || s === "antigravity") return "antigravity";
  if (CANONICAL_HOSTS.includes(s)) return s;
  if (s === "all") return "all";
  return null;
}
function agyRootFor(homeDir) { return path.join(homeDir, ".t3", "userdata", "providers", "antigravity"); }
function agyConfigFilesFor(homeDir) {
  const out = [];
  try { for (const inst of listDirs(agyRootFor(homeDir))) { const f = path.join(inst, "config", "mcp_config.json"); if (fileExists(f)) out.push(f); } } catch {}
  const gem = path.join(homeDir, ".gemini", "antigravity", "mcp_config.json");
  if (fileExists(gem) && !out.includes(gem)) out.push(gem);
  out.sort((a, b) => { try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; } });
  return out;
}
function primaryAgyConfigFileFor(homeDir) {
  const files = agyConfigFilesFor(homeDir);
  if (files.length) return files[0];
  const insts = listDirs(agyRootFor(homeDir));
  if (insts.length) {
    insts.sort((a, b) => { try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; } });
    return path.join(insts[0], "config", "mcp_config.json");
  }
  return path.join(agyRootFor(homeDir), "default", "config", "mcp_config.json");
}
function primaryAgySkillsDirFor(homeDir) {
  const f = primaryAgyConfigFileFor(homeDir);
  return path.join(path.dirname(f), "skills");
}

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

function isUnsupportedMcpDefinition(currentPath, kv, matches = isHubMcpPath) {
  if (!kv || !Array.isArray(kv.path)) return false;
  if (currentPath.length === 0) {
    // A root value (including [] or an inline table) cannot be extended by a
    // generated [mcp_servers.t3_hub] table, even though the input TOML is legal.
    if (kv.path.length === 1 && kv.path[0] === "mcp_servers") return true;
    if (matches(kv.path)) return true;
  } else if (currentPath.length === 1 && currentPath[0] === "mcp_servers") {
    if (matches(["mcp_servers", ...kv.path])) return true;
  }
  return false;
}

// Validate the entire document before any native write, including sections that
// will be removed. A delimiter scan alone cannot detect bad scalars, missing
// commas, duplicate keys, or table/value collisions. No values are evaluated.
function validateTomlDocument(raw) {
  const text = raw.replace(/\r\n/g, "\n");
  let i = 0;
  const fail = () => { throw new Error("malformed native MCP config: invalid TOML at character " + i); };
  const table = (origin) => ({ kind: "table", origin, entries: new Map() });
  const root = table("explicit");
  let current = root;
  const ws = () => { while (text[i] === " " || text[i] === "\t") i++; };
  function comment() {
    if (text[i] !== "#") return;
    while (i < text.length && text[i] !== "\n") {
      const cp = text.codePointAt(i);
      if ((cp < 32 && cp !== 9) || cp === 127 || (cp >= 0xD800 && cp <= 0xDFFF)) fail();
      i += cp > 0xFFFF ? 2 : 1;
    }
  }
  function arrayWs() {
    while (i < text.length) {
      ws(); comment();
      if (text[i] !== "\n") break;
      i++;
    }
  }
  function string(key = false) {
    const quote = text[i];
    const multi = !key && text.startsWith(quote.repeat(3), i);
    i += multi ? 3 : 1;
    let decoded = "";
    while (i < text.length) {
      if (text[i] === quote) {
        let count = 1;
        if (multi) while (text[i + count] === quote) count++;
        if (!multi || count >= 3) {
          if (count > 5) fail();
          i += count;
          return decoded;
        }
        i += count;
        continue;
      }
      if (quote === '"' && text[i] === "\\") {
        i++;
        if (multi) {
          const start = i;
          ws();
          if (text[i] === "\n") {
            while (/[ \t\n]/.test(text[i] || "\0")) i++;
            continue;
          }
          i = start;
        }
        const escapes = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
        const escape = text[i++];
        if (Object.hasOwn(escapes, escape)) { if (key) decoded += escapes[escape]; }
        else if (escape === "u" || escape === "U") {
          const width = escape === "u" ? 4 : 8;
          const hex = text.slice(i, i + width);
          if (hex.length !== width || !/^[0-9a-fA-F]+$/.test(hex)) fail();
          const cp = parseInt(hex, 16);
          if (cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) fail();
          if (key) decoded += String.fromCodePoint(cp);
          i += width;
        } else fail();
        continue;
      }
      const cp = text.codePointAt(i);
      if ((cp < 32 && cp !== 9 && !(multi && cp === 10)) || cp === 127 || (cp >= 0xD800 && cp <= 0xDFFF)) fail();
      const width = cp > 0xFFFF ? 2 : 1;
      if (key) decoded += text.slice(i, i + width);
      i += width;
    }
    fail();
  }
  function keyPath() {
    const parts = [];
    while (i < text.length) {
      ws();
      if (text[i] === '"' || text[i] === "'") parts.push(string(true));
      else {
        const start = i;
        while (/[A-Za-z0-9_-]/.test(text[i] || "")) i++;
        if (i === start) fail();
        parts.push(text.slice(start, i));
      }
      ws();
      if (text[i] !== ".") return parts;
      i++;
    }
    fail();
  }
  function assign(target, keys) {
    for (const key of keys.slice(0, -1)) {
      if (!target.entries.has(key)) target.entries.set(key, table("dotted"));
      target = target.entries.get(key);
      // Dotted assignments may only traverse tables introduced implicitly or
      // by earlier dotted keys, never reopen an explicitly declared child.
      if (target.kind !== "table" || target.origin === "explicit") fail();
      if (target.origin === "implicit") target.origin = "dotted";
    }
    const key = keys[keys.length - 1];
    if (target.entries.has(key)) fail();
    // Inline tables/arrays are sealed values: later dotted keys cannot extend them.
    target.entries.set(key, { kind: "value" });
  }
  function header(keys, isArray) {
    let target = root;
    for (let k = 0; k < keys.length; k++) {
      const key = keys[k], last = k === keys.length - 1;
      let node = target.entries.get(key);
      if (last) {
        if (isArray) {
          if (node && node.kind !== "array-table") fail();
          if (!node) { node = { kind: "array-table" }; target.entries.set(key, node); }
          node.latest = table("explicit");
          current = node.latest;
        } else {
          if (node && (node.kind !== "table" || node.origin !== "implicit")) fail();
          if (!node) { node = table("explicit"); target.entries.set(key, node); }
          node.origin = "explicit";
          current = node;
        }
      } else {
        if (!node) { node = table("implicit"); target.entries.set(key, node); }
        if (node.kind === "array-table") node = node.latest;
        if (node.kind !== "table") fail();
        target = node;
      }
    }
  }
  function validScalar(token) {
    if (/^(?:true|false|[+-]?(?:inf|nan))$/.test(token)) return true;
    if (/^[+-]?(?:0|[1-9](?:_?[0-9])*)$/.test(token) ||
        /^0(?:x[0-9a-fA-F](?:_?[0-9a-fA-F])*|o[0-7](?:_?[0-7])*|b[01](?:_?[01])*)$/.test(token)) return true;
    const integer = "(?:0|[1-9](?:_?[0-9])*)", digits = "[0-9](?:_?[0-9])*";
    if (new RegExp("^[+-]?" + integer + "(?:\\." + digits + "(?:[eE][+-]?" + digits + ")?|[eE][+-]?" + digits + ")$").test(token)) return true;
    const date = "(\\d{4})-(\\d{2})-(\\d{2})", time = "(\\d{2}):(\\d{2}):(\\d{2})(?:\\.\\d+)?";
    const validDate = (y, m, d) => {
      const year = +y, month = +m, day = +d;
      const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
    };
    const validTime = (h, m, s) => +h <= 23 && +m <= 59 && +s <= 59;
    let match = token.match(new RegExp("^" + date + "$"));
    if (match) return validDate(...match.slice(1));
    match = token.match(new RegExp("^" + time + "$"));
    if (match) return validTime(...match.slice(1));
    match = token.match(new RegExp("^" + date + "[Tt ]" + time + "(?:[Zz]|([+-])(\\d{2}):(\\d{2}))?$"));
    return !!match && validDate(...match.slice(1, 4)) && validTime(...match.slice(4, 7)) &&
      (!match[7] || (+match[8] <= 23 && +match[9] <= 59));
  }
  function value(depth = 0) {
    if (depth > 128) fail(); // Bound recursion on adversarial nesting.
    ws();
    if (text[i] === '"' || text[i] === "'") { string(); return; }
    if (text[i] === "[") {
      i++; arrayWs();
      if (text[i] === "]") { i++; return; }
      while (i < text.length) {
        value(depth + 1); arrayWs();
        if (text[i] === "]") { i++; return; }
        if (text[i++] !== ",") fail();
        arrayWs();
        if (text[i] === "]") { i++; return; }
      }
      fail();
    }
    if (text[i] === "{") {
      const target = table("inline");
      i++; ws();
      if (text[i] === "}") { i++; return; }
      while (i < text.length) {
        const keys = keyPath();
        if (text[i++] !== "=") fail();
        value(depth + 1); assign(target, keys); ws();
        if (text[i] === "}") { i++; return; }
        if (text[i++] !== ",") fail();
        ws(); // Inline tables do not permit a trailing comma or free newlines.
      }
      fail();
    }
    const start = i;
    while (i < text.length && !/[\n#,\]}]/.test(text[i])) i++;
    if (!validScalar(text.slice(start, i).replace(/[ \t]+$/, ""))) fail();
  }
  while (i < text.length) {
    arrayWs();
    if (i === text.length) break;
    if (text[i] === "[") {
      const isArray = text[i + 1] === "[";
      i += isArray ? 2 : 1;
      const keys = keyPath();
      if (text[i++] !== "]" || (isArray && text[i++] !== "]")) fail();
      header(keys, isArray);
    } else {
      const keys = keyPath();
      if (text[i++] !== "=") fail();
      value(); assign(current, keys);
    }
    ws(); comment();
    if (i < text.length && text[i++] !== "\n") fail();
  }
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
    return registryEntries(readJsonFile(registryPath, []));
  }
  function registryEntries(r) {
    if (Array.isArray(r)) return r;
    if (r && typeof r === "object" && Array.isArray(r.servers)) return r.servers;
    if (r && typeof r === "object" && r.mcpServers && typeof r.mcpServers === "object") return Object.entries(r.mcpServers).map(([name, v]) => ({ name, ...(v || {}) }));
    if (r && typeof r === "object") return Object.entries(r).map(([name, v]) => ({ name, ...(v || {}) }));
    return [];
  }
  function writeRegistry(list) { writeJsonFileSecure(registryPath, list); }
  // Native host files are user-owned: only ENOENT permits initialization.
  // Discovery may tolerate bad files; every mutation must use these strict reads.
  function readNativeText(file) {
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (readError) {
      if (readError.code === "ENOENT") return { exists: false, raw: "", mode: 0o600, corrupted: false, readError: null };
      return { exists: true, raw: null, corrupted: true, readError };
    }
    // A failure after a successful read is never evidence of a missing file.
    try {
      const st = fs.statSync(file);
      return { exists: true, raw, mode: st.mode & 0o777, corrupted: false, readError: null };
    } catch (readError) { return { exists: true, raw, corrupted: true, readError }; }
  }
  function assertNativeReadable(file, state) {
    if (state.corrupted) {
      const reason = state.readError;
      throw new Error("malformed or unreadable native MCP config: " + file + " (" +
        (reason?.code || reason?.name || "invalid data") + ": " + (reason?.message || "expected a plain object") + ")", { cause: reason });
    }
    return state;
  }
  function backupNativeOnce(file, backup) {
    try { fs.statSync(file); } catch (err) { if (err.code === "ENOENT") return; throw err; }
    let st;
    try { st = fs.lstatSync(backup); } catch (err) { if (err.code !== "ENOENT") throw err; }
    if (st) {
      if (!st.isFile()) throw new Error("unsafe native MCP backup: " + backup);
      fs.chmodSync(backup, 0o600);
      return;
    }
    // Propagate copy/chmod failures; never overwrite without a successful backup.
    fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
    try { fs.chmodSync(backup, 0o600); }
    catch (err) {
      // A failed backup must not be mistaken for a successful one on retry.
      fs.unlinkSync(backup);
      throw err;
    }
  }
  function backupOnceHub(file) {
    backupNativeOnce(file, file + ".t3hub.bak");
  }
  function museMcpPath() { return path.join(homeDir, ".config", "muse", "settings.json"); }
  function piMcpPath() { return path.join(homeDir, ".pi", "agent", "mcp.json"); }
  function claudeMcpPath() { return path.join(homeDir, ".claude", "mcp.json"); }
  function claudeJsonFallback() { return path.join(homeDir, ".claude.json"); }
  function codexConfigPath() { return path.join(homeDir, ".codex", "config.toml"); }
  function writableAgyMcpFile() { return primaryAgyConfigFileFor(homeDir); }
  function writableMcpFileForAgent(agent) {
    if (agent === "antigravity") return writableAgyMcpFile();
    if (agent === "muse") return museMcpPath();
    if (agent === "codex") return codexConfigPath();
    if (agent === "pi") return piMcpPath();
    if (agent === "claude") return claudeMcpPath();
    throw new Error("invalid agent");
  }
  function parseCodexMcpEntries() {
    const file = codexConfigPath();
    let raw = "";
    try { raw = fs.readFileSync(file, "utf8"); } catch { return new Map(); }
    const map = new Map();
    let current = null;
    let currentIsEnv = false;
    const lines = raw.split(/\r?\n/);
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const header = parseTomlTableHeader(line);
      if (header && !header.isArrayTable) {
        const p = header.path;
        if (p.length >= 2 && p[0] === "mcp_servers") {
          current = p[1];
          currentIsEnv = p.length >= 3 && p[2] === "env";
          if (!currentIsEnv) {
            const k = normKey(current);
            if (!map.has(k)) map.set(k, { name: current, command: null, args: [], env: {}, url: null, cwd: null, headers: undefined, transport: null, enabled: true, rawName: current });
            else { map.get(k).name = map.get(k).name || current; }
          }
        } else { current = null; currentIsEnv = false; }
        continue;
      }
      if (header && header.isArrayTable) { current = null; continue; }
      const kv = parseTomlKeyValue(line);
      if (!kv || current === null) continue;
      const k = normKey(current);
      let entry = map.get(k);
      if (!entry) { entry = { name: current, command: null, args: [], env: {}, url: null, cwd: null, headers: undefined, transport: null, enabled: true, rawName: current }; map.set(k, entry); }
      if (currentIsEnv) {
        // env table: single key = value
        const key = kv.path[0];
        const rhs = line.slice(kv.valueStart);
        const val = parseTomlStringValue(rhs);
        if (val !== undefined) entry.env[key] = val;
        continue;
      }
      const key = kv.path[0];
      const rhs = line.slice(kv.valueStart);
      if (key === "command") { const v = parseTomlStringValue(rhs); if (v !== undefined) entry.command = v; }
      else if (key === "args") { const arr = parseTomlStringArray(rhs); if (arr) entry.args = arr; }
      else if (key === "url") { const v = parseTomlStringValue(rhs); if (v !== undefined) entry.url = v; }
      else if (key === "enabled") { const t = rhs.trim().split(/\s|#/)[0]; if (t === "false") entry.enabled = false; else if (t === "true") entry.enabled = true; }
      else if (key === "disabled") { const t = rhs.trim().split(/\s|#/)[0]; if (t === "true") entry.enabled = false; else if (t === "false") entry.enabled = true; }
      else if (key === "transport") { const v = parseTomlStringValue(rhs); if (v !== undefined) entry.transport = v; }
      else if (key === "cwd") { const v = parseTomlStringValue(rhs); if (v !== undefined) entry.cwd = v; }
      else if (key === "env") {
        const envObj = parseTomlInlineTable(rhs);
        if (envObj) Object.assign(entry.env, envObj);
      } else if (key === "headers") {
        const h = parseTomlInlineTable(rhs);
        if (h) entry.headers = h;
      }
    }
    return map;
  }
  function parseTomlStringValue(rhs) {
    const s = String(rhs).trim();
    if (!s) return undefined;
    const noComment = stripTomlCommentOutsideQuotes(s);
    const t = noComment.trim();
    if (t.startsWith('"')) {
      try { return JSON.parse(t); } catch { return t.replace(/^"|"$/g, ""); }
    }
    if (t.startsWith("'")) return t.replace(/^'|'$/g, "");
    return t.split(/\s|#/)[0];
  }
  function parseTomlStringArray(rhs) {
    const s = String(rhs).trim();
    const noComment = stripTomlCommentOutsideQuotes(s).trim();
    if (!noComment.startsWith("[") || !noComment.endsWith("]")) return null;
    const inner = noComment.slice(1, -1).trim();
    if (!inner) return [];
    const out = [];
    const re = /"((?:\\.|[^"\\])*)"|'([^']*)'/g;
    let m;
    while ((m = re.exec(inner)) !== null) {
      if (m[1] !== undefined) { try { out.push(JSON.parse('"' + m[1] + '"')); } catch { out.push(m[1]); } }
      else out.push(m[2]);
    }
    return out;
  }
  function parseTomlInlineTable(rhs) {
    const s = stripTomlCommentOutsideQuotes(String(rhs)).trim();
    if (!s.startsWith("{") || !s.endsWith("}")) return null;
    const inner = s.slice(1, -1).trim();
    if (!inner) return {};
    const out = {};
    // split top-level commas
    let depth = 0, inS = false, inD = false, start = 0;
    const parts = [];
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i];
      if (inD) { if (c === "\\") i++; else if (c === '"') inD = false; continue; }
      if (inS) { if (c === "'") inS = false; continue; }
      if (c === '"') inD = true;
      else if (c === "'") inS = true;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === "," && depth === 0) { parts.push(inner.slice(start, i)); start = i + 1; }
    }
    parts.push(inner.slice(start));
    for (const partRaw of parts) {
      const part = partRaw.trim();
      if (!part) continue;
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      const kRaw = part.slice(0, eq).trim();
      const vRaw = part.slice(eq + 1).trim();
      const k = kRaw.startsWith('"') ? (() => { try { return JSON.parse(kRaw); } catch { return kRaw.replace(/^"|"$/g, ""); } })() : kRaw.replace(/^'|'$/g, "");
      const v = parseTomlStringValue(vRaw);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  function collectNativeMcpStates() {
    const states = new Map();
    function ensure(norm) { if (!states.has(norm)) states.set(norm, { name: norm, def: null, agents: { antigravity: false, muse: false, codex: false, pi: false, claude: false }, defs: {} }); return states.get(norm); }
    // JSON hosts: antigravity (all instances + fallback), muse, pi, claude (mcp.json + .claude.json)
    const jsonHosts = [
      { agent: "muse", files: [museMcpPath()] },
      { agent: "pi", files: [piMcpPath()] },
      { agent: "claude", files: [claudeMcpPath(), claudeJsonFallback()] },
      { agent: "antigravity", files: agyConfigFilesFor(homeDir) },
    ];
    for (const { agent, files } of jsonHosts) {
      for (const file of files) {
        const raw = readJsonFile(file, null);
        if (!raw || typeof raw !== "object") continue;
        const servers = raw.mcpServers;
        if (!servers || typeof servers !== "object" || Array.isArray(servers)) continue;
        for (const [name, v] of Object.entries(servers)) {
          if (isHubName(name)) continue;
          const cfg = v && typeof v === "object" ? v : {};
          const disabled = cfg.disabled === true;
          const k = normKey(name);
          const e = ensure(k);
          if (!e.name || e.name === k) e.name = name;
          e.agents[agent] = !disabled;
          if (!e.def || !cfg.disabled) e.def = { name, ...cfg };
          e.defs[agent] = { name, ...cfg };
        }
      }
    }
    const codexMap = parseCodexMcpEntries();
    for (const [k, ent] of codexMap) {
      if (isHubName(ent.name)) continue;
      const e = ensure(k);
      e.agents.codex = ent.enabled !== false;
      e.defs.codex = { name: ent.name, command: ent.command, args: ent.args, env: ent.env, url: ent.url, cwd: ent.cwd, headers: ent.headers, transport: ent.transport };
      if (!e.def) e.def = e.defs.codex;
    }
    return states;
  }
  function readJsonFileForToggle(file) {
    const state = readNativeText(file);
    if (state.corrupted || !state.exists) return { ...state, obj: null };
    try {
      const obj = JSON.parse(state.raw);
      const plain = value => value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
      if (!plain(obj) || (Object.hasOwn(obj, "mcpServers") && !plain(obj.mcpServers))) {
        throw new TypeError("expected a plain object with an optional plain-object mcpServers");
      }
      return { ...state, obj };
    } catch (readError) { return { ...state, obj: null, corrupted: true, readError }; }
  }
  function atomicWriteNative(file, text, mode = 0o600) {
    safeMkdir(path.dirname(file));
    const tmp = file + ".tmp-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(16).slice(2, 8);
    const fd = fs.openSync(tmp, "wx", mode);
    try {
      try { fs.writeFileSync(fd, text, "utf8"); fs.fchmodSync(fd, mode); }
      finally { fs.closeSync(fd); }
      fs.renameSync(tmp, file);
    } finally {
      try { fs.unlinkSync(tmp); } catch (err) { if (err.code !== "ENOENT") throw err; }
    }
  }
  function ensureNativeBackups(file) {
    backupOnceHub(file);
    backupOnce(file);
  }
  // Strict three-phase batch committer shared by syncRouterToClis, toggle-all and setServerAgents.
  // Phase 1 (Prepare) is done by the caller: every target's original bytes/mode is
  // read, fully parsed/validated, and its new text is computed and re-validated
  // in memory before this function is called.
  // Phase 2 (Backup All): complete every required backup before any write.
  // Phase 3 (Commit All with Rollback): atomically write each target; on any
  // write error restore already-committed targets from Phase 1 bytes/mode.
  function batchCommitHostWrites(prepared) {
    if (!prepared || prepared.length === 0) return;
    // Phase 2 — Backup All. Snapshot pre-existing backup files so a failure
    // can clean up only backups created by this batch; no host file is modified yet.
    const preBackupExists = new Map();
    for (const entry of prepared) {
      if (!entry.state.exists) continue;
      const hubBak = entry.file + ".t3hub.bak";
      const normalBak = entry.file + ".bak-t3hub";
      if (!preBackupExists.has(hubBak)) {
        try { fs.lstatSync(hubBak); preBackupExists.set(hubBak, true); }
        catch (err) { if (err.code === "ENOENT") preBackupExists.set(hubBak, false); else throw err; }
      }
      if (!preBackupExists.has(normalBak)) {
        try { fs.lstatSync(normalBak); preBackupExists.set(normalBak, true); }
        catch (err) { if (err.code === "ENOENT") preBackupExists.set(normalBak, false); else throw err; }
      }
    }
    try {
      for (const entry of prepared) {
        if (!entry.state.exists) continue;
        ensureNativeBackups(entry.file);
      }
    } catch (err) {
      // No host file has been written yet — remove backups created by this batch.
      const backupCleanupFailures = [];
      for (const [bak, existed] of preBackupExists) {
        if (existed) continue;
        try { fs.unlinkSync(bak); }
        catch (cleanupErr) {
          if (!cleanupErr || cleanupErr.code !== "ENOENT") {
            backupCleanupFailures.push({ file: bak, error: cleanupErr?.message || String(cleanupErr), code: cleanupErr?.code });
          }
        }
      }
      if (backupCleanupFailures.length) {
        const details = backupCleanupFailures.map(f => `${f.file}: ${f.error}`).join("; ");
        const failure = new Error(`${err.message || String(err)}; backup cleanup failed: ${details}`, { cause: err });
        failure.code = err.code;
        failure.backupCleanupFailures = backupCleanupFailures;
        throw failure;
      }
      throw err;
    }
    // Phase 3 — Commit All with Rollback.
    const committed = [];
    try {
      for (const entry of prepared) {
        atomicWriteNative(entry.file, entry.text, entry.writeMode ?? entry.state.mode);
        committed.push(entry);
      }
    } catch (err) {
      // Restore already-committed targets from Phase 1 bytes/mode (reverse order).
      const rollbackFailures = [];
      for (let i = committed.length - 1; i >= 0; i--) {
        const entry = committed[i];
        try {
          if (entry.state.exists) {
            atomicWriteNative(entry.file, entry.state.raw, entry.state.mode);
          } else {
            try { fs.unlinkSync(entry.file); } catch (e) { if (e.code !== "ENOENT") throw e; }
          }
        } catch (rollbackError) {
          rollbackFailures.push({ file: entry.file, error: rollbackError.message || String(rollbackError), code: rollbackError.code });
        }
      }
      const unrolledSet = new Set(rollbackFailures.map(failure => failure.file));
      const backupCleanupFailures = [];
      for (const [bak, existed] of preBackupExists) {
        if (existed) continue;
        const ownerFile = bak.endsWith(".t3hub.bak") || bak.endsWith(".bak-t3hub") ? bak.slice(0, -10) : "";
        if (ownerFile && unrolledSet.has(ownerFile)) continue;
        try { fs.unlinkSync(bak); }
        catch (cleanupErr) {
          if (!cleanupErr || cleanupErr.code !== "ENOENT") {
            backupCleanupFailures.push({ file: bak, error: cleanupErr?.message || String(cleanupErr), code: cleanupErr?.code });
          }
        }
      }
      if (rollbackFailures.length || backupCleanupFailures.length) {
        const parts = [err.message || String(err)];
        if (rollbackFailures.length) {
          parts.push("rollback failed: " + rollbackFailures.map(failure => `${failure.file}: ${failure.error}`).join("; "));
        }
        if (backupCleanupFailures.length) {
          parts.push("backup cleanup failed: " + backupCleanupFailures.map(failure => `${failure.file}: ${failure.error}`).join("; "));
        }
        const failure = new Error(parts.join("; "), { cause: err });
        failure.code = err.code;
        failure.rollbackFailures = rollbackFailures;
        failure.unrolledTargets = rollbackFailures.map(entry => entry.file);
        failure.backupCleanupFailures = backupCleanupFailures;
        throw failure;
      }
      throw err;
    }
  }
  function prepareJsonHostWrite(agent, serverName, definitionOrNull) {
    const file = writableMcpFileForAgent(agent);
    const state = assertNativeReadable(file, readJsonFileForToggle(file));
    const next = state.obj ? JSON.parse(JSON.stringify(state.obj)) : {};
    next.mcpServers = next.mcpServers || {};
    if (definitionOrNull === null) {
      delete next.mcpServers[serverName];
    } else {
      const clean = { ...definitionOrNull };
      delete clean.name;
      delete clean.__source;
      delete clean.__sourceLabel;
      delete clean.sources;
      delete clean.pluginId;
      delete clean.installed;
      delete clean.title;
      delete clean.groupTitle;
      delete clean.icon;
      delete clean.builtin;
      if (agent === "antigravity") clean.disabled = false;
      next.mcpServers[serverName] = clean;
    }
    if (!state.exists && definitionOrNull === null) return null;
    const after = JSON.stringify(next, null, 2) + "\n";
    // Validate the freshly generated JSON text.
    const parsed = JSON.parse(after);
    const plain = v => v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
    if (!plain(parsed) || (Object.hasOwn(parsed, "mcpServers") && !plain(parsed.mcpServers))) {
      throw new TypeError("expected a plain object with an optional plain-object mcpServers");
    }
    if (state.raw === after) return null;
    return { file, text: after, state };
  }
  function prepareCodexHostWrite(serverName, definitionOrNull, exactNameOnly = false) {
    const file = codexConfigPath();
    const state = assertNativeReadable(file, readNativeText(file));
    const matches = p => p.length >= 2 && p[0] === "mcp_servers" && (exactNameOnly ? p[1] === serverName : normKey(p[1]) === normKey(serverName));
    const updated = rewriteCodexToml(state.raw, matches, definitionOrNull === null ? "" : formatCodexMcpEntry(serverName, definitionOrNull));
    if (updated === null) throw new Error("malformed or unsupported native MCP config: " + file);
    validateTomlDocument(updated);
    if (state.raw === updated) return null;
    return { file, text: updated, state };
  }
  function writeJsonHostEntry(agent, serverName, definitionOrNull) {
    const file = writableMcpFileForAgent(agent);
    const state = assertNativeReadable(file, readJsonFileForToggle(file));
    const next = state.obj || {};
    next.mcpServers = next.mcpServers || {};
    if (definitionOrNull === null) {
      delete next.mcpServers[serverName];
    } else {
      // For enabling, ensure entry written preserving shape; for antigravity ensure disabled false
      const clean = { ...definitionOrNull };
      delete clean.name;
      delete clean.__source; delete clean.__sourceLabel; delete clean.sources; delete clean.pluginId; delete clean.installed; delete clean.title; delete clean.groupTitle; delete clean.icon; delete clean.builtin;
      // Remove null/undefined transient fields for cleaner file? keep as-is except strip runtime
      if (agent === "antigravity") clean.disabled = false;
      next.mcpServers[serverName] = clean;
    }
    if (!state.exists && definitionOrNull === null) return;
    const after = JSON.stringify(next, null, 2) + "\n";
    if (state.raw === after) return;
    if (state.exists) ensureNativeBackups(file);
    atomicWriteNative(file, after, state.mode);
  }
  function formatCodexMcpEntry(serverName, def) {
    const key = serverName;
    const header = `[mcp_servers.${isTomlBareKey(key) ? key : JSON.stringify(key)}]\n`;
    let body = "";
    if (def.command) body += `command = ${JSON.stringify(def.command)}\n`;
    if (def.url) body += `url = ${JSON.stringify(def.url)}\n`;
    const args = Array.isArray(def.args) ? def.args : (def.args ? [def.args] : []);
    if (args.length) body += `args = [${args.map(a => JSON.stringify(String(a))).join(", ")}]\n`;
    if (def.transport) body += `transport = ${JSON.stringify(def.transport)}\n`;
    if (def.cwd) body += `cwd = ${JSON.stringify(def.cwd)}\n`;
    if (def.env && typeof def.env === "object" && Object.keys(def.env).length) {
      const parts = Object.entries(def.env).map(([k, v]) => `${isTomlBareKey(k) ? k : JSON.stringify(k)} = ${JSON.stringify(String(v))}`);
      body += `env = { ${parts.join(", ")} }\n`;
    }
    if (def.headers && typeof def.headers === "object" && Object.keys(def.headers).length) {
      const parts = Object.entries(def.headers).map(([k, v]) => `${isTomlBareKey(k) ? k : JSON.stringify(k)} = ${JSON.stringify(String(v))}`);
      body += `headers = { ${parts.join(", ")} }\n`;
    }
    body += `enabled = true\n`;
    return header + body;
  }
  function isTomlBareKey(k) { return /^[A-Za-z0-9_-]+$/.test(String(k)); }
  function writeCodexMcpEntry(serverName, definitionOrNull) {
    const file = codexConfigPath();
    const state = assertNativeReadable(file, readNativeText(file));
    const matches = p => p.length >= 2 && p[0] === "mcp_servers" && normKey(p[1]) === normKey(serverName);
    const updated = rewriteCodexToml(state.raw, matches, definitionOrNull === null ? "" : formatCodexMcpEntry(serverName, definitionOrNull));
    if (updated === null) throw new Error("malformed or unsupported native MCP config: " + file);
    if (state.raw !== updated) {
      backupOnceHub(file);
      backupOnce(file);
      atomicWriteNative(file, updated, state.mode);
    }
  }
  function readValidatedRegistry() {
    const state = assertNativeReadable(registryPath, readNativeText(registryPath));
    let registry;
    try {
      const raw = state.exists ? JSON.parse(state.raw) : [];
      const plain = value => value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
      if (!Array.isArray(raw) && !plain(raw)) throw new TypeError("expected a registry array or object");
      if (Array.isArray(raw) && raw.some(entry => !plain(entry))) throw new TypeError("expected plain registry entry objects");
      if (!Array.isArray(raw)) {
        const allowedKeys = new Set(["servers", "mcpServers", "version", "updatedAt"]);
        for (const k of Object.keys(raw)) {
          if (!allowedKeys.has(k)) throw new TypeError("unexpected registry top-level key: " + k);
        }
        if (Object.hasOwn(raw, "servers")) {
          if (!Array.isArray(raw.servers) || raw.servers.some(entry => !plain(entry))) throw new TypeError("expected a registry servers array of objects");
        }
        if (Object.hasOwn(raw, "mcpServers")) {
          if (!plain(raw.mcpServers)) throw new TypeError("expected a registry mcpServers object");
          for (const [k, v] of Object.entries(raw.mcpServers)) {
            if (!k.trim() || !plain(v)) throw new TypeError("expected plain-object mcpServers entries");
          }
        }
      }
      registry = registryEntries(raw);
      if (registry.some(entry => !plain(entry) || typeof entry.name !== "string" || !entry.name.trim())) {
        throw new TypeError("expected named registry entries");
      }
    } catch (readError) {
      assertNativeReadable(registryPath, { ...state, corrupted: true, readError });
    }
    return { state, registry };
  }
  function readValidatedPluginState() {
    const state = assertNativeReadable(statePath, readNativeText(statePath));
    if (!state.exists) return {};
    const record = value => value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
    let value;
    try {
      value = JSON.parse(state.raw);
      if (!record(value)) throw new TypeError("expected a state object");
      for (const key of ["mcpModes", "pluginMcpOwned", "pluginScopes", "pluginProjectRoots"]) {
        if (value[key] !== undefined && !record(value[key])) throw new TypeError("expected " + key + " object");
      }
      const stringValues = object => Object.values(object).every(item => typeof item === "string");
      const modes = value.mcpModes;
      if (modes) {
        if (modes.global !== undefined && (!record(modes.global) || !stringValues(modes.global))) throw new TypeError("expected global modes object");
        if (modes.projects !== undefined && (!record(modes.projects) || Object.values(modes.projects).some(project => !record(project) || !stringValues(project)))) throw new TypeError("expected project modes objects");
      }
      if (value.pluginMcpOwned && Object.values(value.pluginMcpOwned).some(entries => !Array.isArray(entries) || entries.some(entry => !record(entry) || typeof entry.name !== "string" || !entry.name || (entry.global !== undefined && typeof entry.global !== "string") || (entry.projects !== undefined && (!record(entry.projects) || !stringValues(entry.projects)))))) throw new TypeError("invalid plugin MCP ownership records");
    } catch (readError) {
      assertNativeReadable(statePath, { ...state, corrupted: true, readError });
    }
    return value;
  }
  function prepareRegistryAbsorb(def, canonicalName) {
    // Registry absorption participates in the same Prepare/Backup/Commit as hosts.
    // Discovery's tolerant reads must never turn a damaged registry into [].
    const { state, registry } = readValidatedRegistry();
    const norm = normKey(canonicalName);
    if (registry.some(e => normKey(e.name) === norm)) return null;
    const plain = {
      name: canonicalName,
      transport: def.transport || (def.url ? "http" : "stdio"),
      command: def.command || null,
      args: Array.isArray(def.args) ? def.args : (def.args ? [def.args] : []),
      env: def.env && typeof def.env === "object" ? def.env : {},
      url: def.url || null,
      cwd: def.cwd || undefined,
      headers: def.headers || undefined,
      title: def.title,
      groupTitle: def.groupTitle,
      icon: def.icon,
      pluginId: def.pluginId || null,
      installed: true,
    };
    registry.push(plain);
    return { file: registryPath, state, text: JSON.stringify(registry, null, 2) + "\n", writeMode: 0o600 };
  }

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

  function mergeDefinition(map, server, replace = false, additionalSources = []) {
    if (!server || typeof server.name !== "string" || !server.name || isHubName(server.name)) return;
    const key = server.name;
    const previous = map.has(key) ? { ...map.get(key) } : null;
    if (previous) { delete previous.modeConflict; delete previous.conflictNames; }
    const sources = [...new Set([...(previous?.sources || []), server.__source || "hub", ...additionalSources])];
    if (previous && !replace) {
      map.set(key, { ...previous, builtin: !!(previous.builtin || server.builtin), sources });
    } else {
      const merged = { ...previous, ...server, sources };
      // A replacement endpoint must not inherit the old endpoint's transport.
      if (replace && server.command && !server.url) { merged.url = null; merged.transport = server.transport || "stdio"; }
      else if (replace && server.url && !server.command) { merged.command = null; merged.transport = server.transport || "http"; }
      delete merged.modeConflict; delete merged.conflictNames;
      map.set(key, merged);
    }
    const colliding = [...map.entries()].filter(([, def]) => normKey(def.name) === normKey(server.name));
    if (colliding.length > 1) {
      const names = colliding.map(([, def]) => def.name).sort((a, b) => a.localeCompare(b));
      for (const [name, def] of colliding) map.set(name, { ...def, modeConflict: true, conflictNames: names });
    }
  }
  function suppressShadowedPluginAliases(map, registry) {
    // Plugin discovery is a catalog suggestion, not ownership of a separately
    // configured endpoint with the same normalized name. Never suppress two
    // independent definitions: those remain an explicit fail-closed conflict.
    const independent = new Set();
    for (const def of map.values()) {
      if (!def.pluginId && def.__source !== "plugin" && def.__source !== "builtin") independent.add(normKey(def.name));
    }
    for (const def of registry) if (def && !def.pluginId && typeof def.name === "string") independent.add(normKey(def.name));
    for (const [name, def] of map) {
      if (def.pluginId && def.__source === "plugin" && independent.has(normKey(def.name))) map.delete(name);
    }
    // Deleting a shadowed catalog alias must clear stale conflict flags, while
    // preserving conflicts between genuinely independent surviving entries.
    const groups = new Map();
    for (const [name, def] of map) {
      delete def.modeConflict; delete def.conflictNames;
      const key = normKey(def.name), group = groups.get(key) || [];
      group.push([name, def]); groups.set(key, group);
    }
    for (const group of groups.values()) if (group.length > 1) {
      const names = group.map(([, def]) => def.name).sort((a, b) => a.localeCompare(b));
      for (const [, def] of group) { def.modeConflict = true; def.conflictNames = names; }
    }
    return map;
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
    // Claude read-only fallback ~/.claude.json
    { const fb = path.join(homeDir, ".claude.json"); if (fileExists(fb)) for (const server of collectFromFile(fb, "claude", "claude")) mergeDefinition(byName, { ...server, pluginId: null, installed: true }, true); }
    // Codex TOML: [mcp_servers.<name>] (enabled=false => off)
    try {
      const codexMap = parseCodexMcpEntries();
      for (const [_, ent] of codexMap) {
        if (isHubName(ent.name)) continue;
        const def = { name: ent.name, command: ent.command, args: ent.args, env: ent.env, url: ent.url, cwd: ent.cwd, headers: ent.headers, transport: ent.transport || (ent.url ? "http" : "stdio"), __source: "codex", __sourceLabel: "codex" };
        mergeDefinition(byName, { ...def, pluginId: null, installed: true }, true);
      }
    } catch {}
    const agyRoot = path.join(homeDir, ".t3", "userdata", "providers", "antigravity");
    for (const inst of listDirs(agyRoot)) for (const server of collectFromFile(path.join(inst, "config", "mcp_config.json"), "agy", "agy")) mergeDefinition(byName, { ...server, pluginId: null, installed: true }, true);
    // AGY gemini fallback (read-only)
    { const gem = path.join(homeDir, ".gemini", "antigravity", "mcp_config.json"); if (fileExists(gem) && !agyConfigFilesFor(homeDir).includes(gem)) for (const server of collectFromFile(gem, "agy", "agy")) mergeDefinition(byName, { ...server, pluginId: null, installed: true }, true); }
    // Keep old imports readable, but upstream templates and plugin discovery never depend on Magpie.
    const magpie = readJsonFile(path.join(homeDir, ".config", "magpie", "library.json"), null);
    if (Array.isArray(magpie?.mcp)) for (const server of magpie.mcp) add({ ...server, installed: true, __source: "magpie", __sourceLabel: "magpie" });
    for (const server of BUILTIN_UPSTREAM_MCPS) {
      add({ ...server, command: server.command?.replace(/^~(?=\/)/, () => homeDir), title: server.title || server.name, groupTitle: "官方上游 MCP", builtin: true, __source: "builtin", __sourceLabel: "builtin" });
    }
    return suppressShadowedPluginAliases(byName, readRegistry());
  }
  function discoverServerDefinitions(overrides = {}) {
    if ((overrides.homeDir && overrides.homeDir !== homeDir) || (overrides.hubDir && overrides.hubDir !== hubDir)) {
      return createMcpRouter({ homeDir, ...overrides }).discoverServerDefinitions();
    }
    const definitions = discoverDefinitions();
    const registry = readRegistry();
    for (const server of registry) mergeDefinition(definitions, { ...server, pluginId: server.pluginId || null, __source: server.__source || "hub", __sourceLabel: server.__sourceLabel || "hub" }, true, ["hub"]);
    return suppressShadowedPluginAliases(definitions, registry);
  }
  function modeFor(modes, name) {
    if (!modes || typeof modes !== "object") return undefined;
    if (Object.prototype.hasOwnProperty.call(modes, name)) return modes[name];
    const matches = Object.keys(modes).filter(key => normKey(key) === normKey(name));
    return matches.length === 1 ? modes[matches[0]] : undefined;
  }
  function canonicalProjectRoot(root) {
    if (typeof root !== "string" || !root || !path.isAbsolute(root)) return null;
    const absolute = path.resolve(root);
    try { return fs.realpathSync(absolute); } catch { return absolute; }
  }
  function hasSymlinkComponent(root) {
    if (typeof root !== "string" || !path.isAbsolute(root)) return true;
    const absolute = path.resolve(root), parsed = path.parse(absolute);
    let current = parsed.root;
    for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try { if (fs.lstatSync(current).isSymbolicLink()) return true; }
      catch (error) { if (error?.code !== "ENOENT") return true; break; }
    }
    return false;
  }
  function projectModeKeys(projects, root, originalRoot = root) {
    const canonical = canonicalProjectRoot(root);
    if (!canonical) return [];
    const raw = !hasSymlinkComponent(originalRoot) ? path.resolve(originalRoot) : null;
    const aliases = Object.keys(projects || {}).filter((key) => !hasSymlinkComponent(key) && canonicalProjectRoot(key) === canonical).sort();
    return [...new Set([canonical, raw, ...aliases].filter(Boolean))];
  }
  function projectModeFor(projects, root, originalRoot, name) {
    for (const key of projectModeKeys(projects, root, originalRoot)) {
      const mode = modeFor(projects?.[key] || {}, name);
      if (mode !== undefined) return mode;
    }
    return undefined;
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
  function launchAvailability(s, projectRoot) {
    if (s.url) {
      try {
        const url = new URL(s.url);
        if (["http:", "https:"].includes(url.protocol)) return { launchable: true, launchReason: null };
        return { launchable: false, launchReason: "invalid-url" };
      } catch { return { launchable: false, launchReason: "invalid-url" }; }
    }
    if (typeof s.command !== "string" || !s.command.trim()) return { launchable: false, launchReason: "missing-endpoint" };
    const expandHome = value => String(value).replace(/^~(?=\/)/, () => homeDir);
    const cwd = path.resolve(projectRoot || homeDir, expandHome(s.cwd || "."));
    try { if (!fs.statSync(cwd).isDirectory()) return { launchable: false, launchReason: "invalid-cwd" }; }
    catch { return { launchable: false, launchReason: "invalid-cwd" }; }
    return commandAvailable(s, projectRoot)
      ? { launchable: true, launchReason: null }
      : { launchable: false, launchReason: "command-unavailable" };
  }
  function probeKey(s, projectRoot) {
    // Bind cache entries to the endpoint and execution context, without storing
    // credentials. Resolve the project exactly as listing does so symlinked
    // paths (including macOS /var) and their real path share one result.
    const executionRoot = projectRoot ? (canonicalProjectRoot(projectRoot) || projectRoot) : homeDir;
    return normKey(s.name) + ":" + crypto.createHash("sha256")
      .update(JSON.stringify([s.command, s.args, s.url, s.cwd, s.env, s.headers, s.url ? null : executionRoot])).digest("hex");
  }
  function connectionStatus(s, projectRoot, cache) {
    const cached = cache[probeKey(s, projectRoot)];
    if (typeof cached?.connected === "boolean") return { ...cached, probed: true };
    if (!s.url && !commandAvailable(s, projectRoot)) return { connected: false, probed: false, statusText: "未检测到可执行命令，请检查安装或探测连通性。" };
    return { connected: null, probed: false, statusText: "尚未探测连通性，按需唤醒或点击检测连通性。" };
  }

  function listMcpServers(args = {}) {
    const originalProjectRoot = args.projectRoot || null;
    const projectRoot = canonicalProjectRoot(originalProjectRoot) || null;
    const cache = readJsonFile(probeCachePath, {}) || {};
    const byName = discoverServerDefinitions();
    const registryNames = new Set(readRegistry().map(s => normKey(s.name)));
    const nativeStates = collectNativeMcpStates();
    const state = readState();
    const globalModes = state.mcpModes?.global || {};
    const projects = state.mcpModes?.projects || {};
    const items = [...byName.values()].map((s) => {
      const modeConflict = s.modeConflict === true;
      const projectMode = projectRoot ? projectModeFor(projects, projectRoot, originalProjectRoot, s.name) : undefined;
      const globalMode = modeFor(globalModes, s.name);
      const mode = modeConflict ? "off" : projectMode !== undefined ? projectMode : globalMode !== undefined ? globalMode : "off";
      const env = s.env && typeof s.env === "object" ? Object.keys(s.env) : [];
      const hasSecrets = env.some((k) => isSecretKey(k));
      const norm = normKey(s.name);
      const nativeEntry = modeConflict ? null : nativeStates.get(norm);
      const inRegistry = registryNames.has(norm);
      const inNative = !!nativeEntry;
      const agentStates = modeConflict
        ? { antigravity: null, muse: null, codex: null, pi: null, claude: null }
        : nativeEntry ? { ...nativeEntry.agents } : { antigravity: false, muse: false, codex: false, pi: false, claude: false };
      const enabledCount = Object.values(agentStates).filter(Boolean).length;
      const enabled = !modeConflict && (enabledCount > 0 || mode !== "off");
      const legacySource = s.__source || "hub";
      let mappedSource;
      if (legacySource === "magpie") mappedSource = "magpie";
      else if (inNative && inRegistry) mappedSource = "both";
      else if (inNative && !inRegistry) mappedSource = "native";
      else if (!inNative && inRegistry) mappedSource = "hub";
      else if (s.builtin && !inRegistry && !inNative) mappedSource = "builtin";
      else if (legacySource === "plugin") mappedSource = "hub";
      else if (["pi", "muse", "claude", "codex", "agy", "zcode"].includes(legacySource)) mappedSource = "native";
      else if (legacySource === "builtin") mappedSource = "builtin";
      else mappedSource = legacySource;
      return {
        name: s.name,
        title: s.title || s.name, groupTitle: s.groupTitle || s.__sourceLabel || "MCP",
        icon: s.icon || null, builtin: !!s.builtin, pluginId: s.pluginId || null,
        installed: !!s.installed || registryNames.has(normKey(s.name)) || mode !== "off",
        ...launchAvailability(s, projectRoot),
        ...(modeConflict ? { connected: null, probed: false, statusText: "MCP 名称归一化冲突；已暂停自动启用。" } : connectionStatus(s, projectRoot, cache)),
        transport: s.transport || (s.url ? "http" : "stdio"),
        command: s.command ? redactCommand(s.command) : null,
        args: redactArgs(Array.isArray(s.args) ? s.args : []),
        url: s.url ? redactUrl(s.url) : null,
        agents: s.agents || null,
        source: mappedSource,
        sourceLabel: s.__sourceLabel || "hub",
        sources: Array.isArray(s.sources) ? [...new Set(s.sources.filter(source => ["plugin", "pi", "muse", "claude", "zcode", "codex", "agy", "magpie", "builtin", "hub"].includes(source)))] : [],
        agentStates,
        enabledCount,
        enabled,
        modeConflict,
        conflictNames: modeConflict ? [...(s.conflictNames || [])] : [],
        mode: ALLOWED_MODES.includes(mode) ? mode : "off",
        modeScope: projectMode !== undefined ? "project" : "global",
        modeProject: projectMode ?? null,
        modeGlobal: globalMode ?? null,
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

  function getAgentMatrix(args = {}) {
    const result = listMcpServers(args);
    const matrix = result.items.map((it) => ({ name: it.name, source: it.source, enabled: it.enabled, enabledCount: it.enabledCount, agentStates: it.agentStates }));
    return { ok: true, matrix, items: result.items, routerRegistered: result.routerRegistered };
  }
  const listServers = listMcpServers;

  function matchingServerDefinitions(identifier) {
    if (typeof identifier !== "string" || !identifier) return null;
    const byName = discoverServerDefinitions();
    const norm = normKey(identifier);
    const matches = [...byName.values()].filter((server) => normKey(server.name) === norm);
    if (matches.length > 1) {
      const error = new Error("normalized MCP name conflict: " + matches.map((server) => server.name).sort().join(", "));
      error.code = "ERR_MCP_NORMALIZED_NAME_CONFLICT";
      throw error;
    }
    return matches;
  }
  function resolveServerDefinition(identifier) {
    const matches = matchingServerDefinitions(identifier);
    if (!matches?.length) return null;
    return matches.find((server) => server.name === identifier) || matches[0];
  }
  function resolveDefinitionForToggle({ id, name } = {}) {
    const ident = name || id;
    if (!ident || typeof ident !== "string") throw new Error("id or name required");
    if (isHubName(ident)) throw new Error("cannot toggle t3_hub");
    readValidatedRegistry();
    const def = resolveServerDefinition(ident);
    // Fallback to native state definition for native-only entries already covered (discover includes native), but also check collectNativeMcpStates for completeness
    if (def) return def;
    const nativeStates = collectNativeMcpStates();
    const nat = nativeStates.get(normKey(ident));
    if (nat && nat.def) return { name: nat.def.name || ident, ...nat.def, __source: "native", __sourceLabel: "native" };
    throw new Error("server not found: " + ident);
  }
  function definitionForWrite(def) {
    const clean = { ...def };
    delete clean.__source; delete clean.__sourceLabel; delete clean.sources; delete clean.builtin; delete clean.pluginId; delete clean.installed; delete clean.groupTitle; delete clean.icon; delete clean.title;
    return clean;
  }
  function preflightAgentWrites(def, agents) {
    // Batch toggles must reject every read/parse/layout error before an earlier
    // host can be backed up or changed by the single-host writers below.
    for (const agent of CANONICAL_HOSTS) {
      const file = writableMcpFileForAgent(agent);
      if (agent === "codex") {
        const state = assertNativeReadable(file, readNativeText(file));
        const matches = p => p.length >= 2 && p[0] === "mcp_servers" && normKey(p[1]) === normKey(def.name);
        const section = agents[agent] ? formatCodexMcpEntry(def.name, definitionForWrite(def)) : "";
        if (rewriteCodexToml(state.raw, matches, section) === null) {
          throw new Error("unsupported native MCP config: " + file);
        }
      } else assertNativeReadable(file, readJsonFileForToggle(file));
    }
  }
  function toggleServerForAgent({ id, name, agent, enabled } = {}) {
    const canonicalAgent = normalizeAgentHost(agent);
    if (!canonicalAgent) throw new Error("invalid agent");
    if (typeof enabled !== "boolean") throw new Error("enabled must be boolean");
    // Corrupt or unreadable registry errors must never be mistaken for the
    // special name-conflict case that permits an exact-name disable.
    readValidatedRegistry();
    let def;
    try { def = resolveDefinitionForToggle({ id, name }); }
    catch (error) {
      if (enabled !== false || error?.code !== "ERR_MCP_NORMALIZED_NAME_CONFLICT") throw error;
      const ident = name || id;
      let exact = null;
      try { exact = typeof ident === "string" ? discoverServerDefinitions().get(ident) : null; }
      catch { throw error; }
      if (!exact?.modeConflict) throw error;
      def = exact;
    }
    const canonicalName = def.name;
    const exactConflictDisable = def.modeConflict === true && enabled === false;
    {
      // Single-host and all-host toggles share the registry transaction boundary.
      const prepared = [];
      const toWrite = definitionForWrite(def);
      const jsonEntry = {};
      if (toWrite.command !== undefined && toWrite.command !== null) jsonEntry.command = toWrite.command;
      if (Array.isArray(toWrite.args)) jsonEntry.args = toWrite.args;
      if (toWrite.url) jsonEntry.url = toWrite.url;
      if (toWrite.env && typeof toWrite.env === "object") jsonEntry.env = toWrite.env;
      if (toWrite.cwd) jsonEntry.cwd = toWrite.cwd;
      if (toWrite.headers) jsonEntry.headers = toWrite.headers;
      if (toWrite.transport) jsonEntry.transport = toWrite.transport;
      for (const a of canonicalAgent === "all" ? CANONICAL_HOSTS : [canonicalAgent]) {
        if (a === "codex") {
          prepared.push(enabled ? prepareCodexHostWrite(canonicalName, toWrite) : prepareCodexHostWrite(canonicalName, null, exactConflictDisable));
        } else {
          prepared.push(enabled ? prepareJsonHostWrite(a, canonicalName, jsonEntry) : prepareJsonHostWrite(a, canonicalName, null));
        }
      }
      if (enabled) prepared.push(prepareRegistryAbsorb({ ...def, ...toWrite }, canonicalName));
      // Phase 2/3 — Backup All then Commit All with Rollback.
      batchCommitHostWrites(prepared.filter(Boolean));
    }
    return { ok: true, name: canonicalName, agent: canonicalAgent, enabled };
  }
  function setServerAgents({ id, name, agents } = {}) {
    const ident = name || id;
    if (!ident || typeof ident !== "string") throw new Error("id required");
    if (agents === null || agents === undefined) throw new Error("agents required");
    const def = resolveDefinitionForToggle({ id: ident, name: ident });
    const canonicalName = def.name;
    let map = {};
    if (Array.isArray(agents)) {
      for (const a of agents) {
        const c = normalizeAgentHost(a);
        if (!c || c === "all") throw new Error("invalid agent");
        map[c] = true;
      }
      for (const c of CANONICAL_HOSTS) if (!(c in map)) map[c] = false;
    } else if (agents && typeof agents === "object") {
      for (const [k, v] of Object.entries(agents)) {
        const c = normalizeAgentHost(k);
        if (!c || c === "all") throw new Error("invalid agent");
        map[c] = !!v;
      }
      for (const c of CANONICAL_HOSTS) if (!(c in map)) map[c] = false;
    } else throw new Error("agents must be array or object");
    // Phase 1 — Prepare all hosts before any backup/write.
    const prepared = [];
    const toWrite = definitionForWrite(def);
    const jsonEntry = {};
    if (toWrite.command !== undefined && toWrite.command !== null) jsonEntry.command = toWrite.command;
    if (Array.isArray(toWrite.args)) jsonEntry.args = toWrite.args;
    if (toWrite.url) jsonEntry.url = toWrite.url;
    if (toWrite.env && typeof toWrite.env === "object") jsonEntry.env = toWrite.env;
    if (toWrite.cwd) jsonEntry.cwd = toWrite.cwd;
    if (toWrite.headers) jsonEntry.headers = toWrite.headers;
    if (toWrite.transport) jsonEntry.transport = toWrite.transport;
    for (const c of CANONICAL_HOSTS) {
      if (c === "codex") {
        prepared.push(map[c] ? prepareCodexHostWrite(canonicalName, toWrite) : prepareCodexHostWrite(canonicalName, null));
      } else {
        prepared.push(map[c] ? prepareJsonHostWrite(c, canonicalName, jsonEntry) : prepareJsonHostWrite(c, canonicalName, null));
      }
    }
    if (Object.values(map).some(Boolean)) {
      prepared.push(prepareRegistryAbsorb({ ...def, ...toWrite }, canonicalName));
    }
    // Phase 2/3 — Backup All then Commit All with Rollback, including the registry.
    batchCommitHostWrites(prepared.filter(Boolean));
    return { ok: true, name: canonicalName, agents: map };
  }

  function activeModes(state, name) {
    return [modeFor(state.mcpModes?.global || {}, name),
      ...Object.values(state.mcpModes?.projects || {}).map(modes => modeFor(modes, name))]
      .some(mode => mode && mode !== "off");
  }
  function pluginConflict(name, id, state, registry) {
    const existing = registry.filter(s => normKey(s.name) === normKey(name));
    if (existing.some(s => s.pluginId !== id)) return true;
    const definitions = [...discoverDefinitions().values()].filter(s => normKey(s.name) === normKey(name));
    if (definitions.some(s => s.pluginId !== id && s.__source !== "builtin")) return true;
    // Enabling a discovered server independently does not grant a plugin
    // permission to change its modes, even if the definition came from it.
    return activeModes(state, name);
  }
  function setPluginMcpScope({ pluginId, servers = [], scope, projectRoot } = {}) {
    if (!pluginId || !["off", "global", "project"].includes(scope)) throw new Error("invalid plugin scope");
    if (scope === "project" && (!projectRoot || !path.isAbsolute(projectRoot))) throw new Error("projectRoot required for project scope");
    projectRoot = scope === "project" ? canonicalProjectRoot(projectRoot) : projectRoot;
    // These two files jointly own the plugin's endpoints and modes. A damaged
    // one must not be interpreted as empty and overwritten by this write path.
    const state = readValidatedPluginState(), { registry } = readValidatedRegistry();
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
    const rawProjectRoot = args.projectRoot || null;
    const projectRoot = rawProjectRoot ? canonicalProjectRoot(rawProjectRoot) : null;
    if (typeof name !== "string" || !name || (!ALLOWED_MODES.includes(mode) && mode !== "inherit")) throw new Error("invalid name or mode");
    if (mode.startsWith("project-") && !projectRoot) throw new Error("projectRoot required for project mode");
    if (mode === "inherit" && !projectRoot) throw new Error("projectRoot required for inherit mode");
    if (rawProjectRoot && !projectRoot) throw new Error("projectRoot must be absolute");
    const candidates = [...discoverServerDefinitions().values()].filter(server => normKey(server.name) === normKey(name));
    const modeConflict = candidates.length > 1;
    if (modeConflict && mode !== "off") throw new Error("normalized MCP name conflict: " + candidates.map(server => server.name).sort().join(", "));
    if (modeConflict && !candidates.some(server => server.name === name)) throw new Error("normalized MCP name conflict requires an exact server name");
    const discovered = modeConflict ? candidates.find(server => server.name === name) : resolveServerDefinition(name);
    name = discovered?.name || name;
    const state = readState();
    state.mcpModes ||= {}; state.mcpModes.global ||= {}; state.mcpModes.projects ||= {};
    if (modeConflict) {
      const modes = mode.startsWith("project-") || (mode === "off" && projectRoot)
        ? (state.mcpModes.projects[projectRoot] ||= {})
        : state.mcpModes.global;
      modes[name] = mode;
      writeState(state);
      return { ok: true, name, mode };
    }
    if (mode === "inherit") {
      const keys = projectModeKeys(state.mcpModes.projects, projectRoot, rawProjectRoot);
      for (const root of keys) {
        const modes = state.mcpModes.projects[root];
        if (!modes) continue;
        clearAliases(modes, name);
        if (!Object.keys(modes).length) delete state.mcpModes.projects[root];
      }
      for (const records of Object.values(state.pluginMcpOwned || {})) for (const record of records) {
        if (normKey(record.name) !== normKey(name)) continue;
        for (const root of keys) delete record.projects?.[root];
      }
      writeState(state);
      return { ok: true, name, mode };
    }
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
    const stateBefore = readValidatedPluginState(), { registry: registryBefore } = readValidatedRegistry();
    const regMap = new Map();
    for (const server of registryBefore) mergeDefinition(regMap, server, true);
    const skippedMcps = [];
    for (const server of list) {
      if (server.pluginId && pluginConflict(server.name, server.pluginId, stateBefore, registryBefore)) { skippedMcps.push(server.name); continue; }
      mergeDefinition(regMap, server, true);
    }
    if (skippedMcps.length === list.length) return { ok: true, items: [], skippedMcps };
    const reg = [...regMap.values()];
    writeRegistry(reg);
    // Keep persisted modes usable by runtime consumers that index exact names.
    const state = stateBefore;
    const normalizedCounts = new Map();
    for (const server of reg) normalizedCounts.set(normKey(server.name), (normalizedCounts.get(normKey(server.name)) || 0) + 1);
    const ambiguousNames = new Set([...normalizedCounts].filter(([, count]) => count > 1).map(([key]) => key));
    for (const modes of [state.mcpModes?.global, ...Object.values(state.mcpModes?.projects || {})].filter(Boolean)) {
      for (const server of reg) {
        if (ambiguousNames.has(normKey(server.name))) continue;
        const mode = modeFor(modes, server.name); clearAliases(modes, server.name); if (mode) modes[server.name] = mode;
      }
    }
    if (state.mcpModes) writeState(state);
    const names = new Set(reg.map(s => normKey(s.name)));
    return { ok: true, skippedMcps, items: listMcpServers().items.filter(s => names.has(normKey(s.name))) };
  }

  function removeMcpServer({ name } = {}) {
    if (!name) throw new Error("name required");
    let conflicted = false;
    try { matchingServerDefinitions(name); }
    catch (error) {
      const exactRegistryEntry = readRegistry().some(entry => entry.name === name);
      if (!exactRegistryEntry) throw error;
      conflicted = true;
    }
    writeRegistry(readRegistry().filter(e => conflicted ? e.name !== name : normKey(e.name) !== normKey(name)));
    const state = readState();
    const removeMode = modes => {
      if (conflicted) delete modes[name];
      else clearAliases(modes, name);
    };
    if (state.mcpModes?.global) removeMode(state.mcpModes.global);
    for (const modes of Object.values(state.mcpModes?.projects || {})) removeMode(modes);
    writeState(state);
    return { ok: true, name };
  }

  function backupOnce(file) {
    backupNativeOnce(file, file + ".bak-t3hub");
  }
  function rewriteCodexToml(raw, matches = isHubMcpPath, section = `[mcp_servers.t3_hub]\ncommand = ${JSON.stringify(routerBin)}\nargs = []\n`) {
    // Validate before any layout-based early return: null means valid but
    // unsupported TOML, never a malformed document that sync may silently skip.
    validateTomlDocument(raw);
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
          if (header.isArrayTable && ((header.path.length === 1 && header.path[0] === "mcp_servers") || matches(header.path))) return null;
          currentPath = header.path;
          inHub = matches(currentPath);
          if (!inHub) kept.push(line);
          continue; // Header brackets are never value delimiters.
        }
        const kv = parseTomlKeyValue(line);
        if (!kv || !line.slice(kv.valueStart).trim() || /^\s*#/.test(line.slice(kv.valueStart))) return null;
        if (!inHub && isUnsupportedMcpDefinition(currentPath, kv, matches)) return null;
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
    const prefix = kept.join("\n").trimEnd();
    const updated = section ? (prefix ? prefix + "\n\n" : "") + section : (prefix ? prefix + "\n" : "");
    validateTomlDocument(updated);
    return updated;
  }

  function syncRouterToClis() {
    const synced = [], skipped = [], writes = [];
    // Preflight every target before touching any native file. Read/parse failures
    // must be visible to callers rather than a successful sync of an empty object.
    const cfgPath = codexConfigPath();
    const codexState = assertNativeReadable(cfgPath, readNativeText(cfgPath));
    const updated = rewriteCodexToml(codexState.raw);
    if (!dirExists(path.dirname(cfgPath))) skipped.push(cfgPath);
    else {
      if (updated === null) skipped.push(cfgPath); // Unsupported TOML stays untouched.
      else {
        if (codexState.raw !== updated) writes.push({ file: cfgPath, text: updated, state: codexState });
        synced.push(cfgPath);
      }
    }
    function prepareJson(file) {
      const state = assertNativeReadable(file, readJsonFileForToggle(file));
      if (!dirExists(path.dirname(file))) { skipped.push(file); return; }
      const next = state.obj || {};
      const before = JSON.stringify(next);
      next.mcpServers ||= {};
      for (const name of Object.keys(next.mcpServers)) if (isHubName(name)) delete next.mcpServers[name];
      next.mcpServers.t3_hub = { command: routerBin, args: [] };
      if (!state.exists || JSON.stringify(next) !== before) writes.push({ file, text: JSON.stringify(next, null, 2) + "\n", state });
      synced.push(file);
    }
    prepareJson(piMcpPath());
    prepareJson(museMcpPath());
    prepareJson(claudeMcpPath());
    prepareJson(path.join(homeDir, ".zcode", "cli", "mcp.json"));
    for (const inst of listDirs(path.join(homeDir, ".t3", "userdata", "providers", "antigravity"))) prepareJson(path.join(inst, "config", "mcp_config.json"));
    // Shared strict three-phase batch committer: Backup All -> Commit All with Rollback.
    batchCommitHostWrites(writes);
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
    // Resolve before execution as well as cache-key generation: a relative
    // server cwd containing '..' must not depend on the spelling of an alias.
    const executionRoot = projectRoot ? (canonicalProjectRoot(projectRoot) || projectRoot) : projectRoot;
    const servers = [...discoverServerDefinitions().values()].filter(s => !name || normKey(s.name) === normKey(name));
    const results = {};
    await Promise.all(servers.map(async s => {
      const start = Date.now(); let connected = false;
      try {
        if (s.url) connected = await probeHttpMcp(s, timeoutMs);
        else if (s.command) connected = await probeStdioMcp(s, executionRoot, timeoutMs);
      } catch {}
      results[s.name] = { connected, latencyMs: Date.now() - start, statusText: connected ? "已完成 MCP 握手，服务可用。" : "MCP 握手未通过或服务不可达。" };
    }));
    // Merge after awaiting probes so concurrent single-server probes do not
    // overwrite results saved by another call while this one was in flight.
    const cache = readJsonFile(probeCachePath, {}) || {};
    for (const server of servers) cache[probeKey(server, executionRoot)] = { ...results[server.name], checkedAt: new Date().toISOString() };
    if (servers.length) writeJsonFileSecure(probeCachePath, cache);
    return { ok: true, results };
  }
  const autoSyncHosts = syncRouterToClis;

  return { homeDir, hubDir, statePath, registryPath, listMcpServers, listServers, getAgentMatrix, toggleServerForAgent, setServerAgents, setPluginMcpScope, setMcpMode, setServerMode, upsertMcpServer, removeMcpServer, syncRouterToClis, autoSyncHosts, probeMcpServers, discoverServerDefinitions, discoverDefinitions };
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

function getAgentMatrix(args) { return getDefaultMcpRouter().getAgentMatrix(args || {}); }
function listServers(args) { return getDefaultMcpRouter().listServers(args || {}); }
function toggleServerForAgent(args) { return getDefaultMcpRouter().toggleServerForAgent(args || {}); }
function setServerAgents(args) { return getDefaultMcpRouter().setServerAgents(args || {}); }
module.exports = {
  PLAN_UPDATE_TOOL, handlePlanUpdate,
  createMcpRouter, redactSummary, redactArgs, redactUrl, ALLOWED_MODES, BUILTIN_UPSTREAM_MCPS, probeMcpServers, autoSyncHosts,
  listMcpServers, listServers, getAgentMatrix, toggleServerForAgent, setServerAgents, setMcpMode, setServerMode, upsertMcpServer, removeMcpServer, syncRouterToClis,
  discoverServerDefinitions, getDefaultMcpRouter, parseTomlTableHeader, CANONICAL_HOSTS, normalizeAgentHost,
};
