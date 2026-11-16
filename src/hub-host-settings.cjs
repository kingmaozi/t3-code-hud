"use strict";
/**
 * hub-host-settings.cjs —— 五宿主原生设置可视化中心
 *
 * 让非程序员不用手改 .toml / .json 就能安全点选调整各家 AI 设置：
 * - 每次首次修改前自动生成 `.t3hub.bak` 备份（保留原始文件）；
 * - 只改目标键值，100% 保留文件其余内容与注释；
 * - Codex TOML 仅允许顶层白名单标量键，绝不触碰 [mcp_servers.*]/[projects.*] 表段；
 * - Muse / Pi JSON 仅更新白名单键，原子写回。
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CODEX_TOP_KEYS = ["model", "model_reasoning_effort", "approval_policy", "sandbox_mode", "max_concurrent_threads"];
const CODEX_EDITABLE_KEYS = ["model", "model_reasoning_effort", "approval_policy", "sandbox_mode"];
const MUSE_KEYS = ["model", "defaultModel", "permissionMode", "reasoningEffort", "effort", "defaultEffort"];
const PI_KEYS = ["defaultModel", "defaultProvider", "model", "effort", "reasoningEffort", "thinkingLevel"];

function expandTilde(p) {
  if (typeof p !== "string") return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}
function dirExists(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function safeReadJson(file, fallback) {
  try { return JSON.parse(readTextFileStrict(file).content); } catch { return fallback; }
}
function safeMkdir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function lstatIfPresent(file) {
  try { return fs.lstatSync(file); } catch (e) {
    if (e && e.code === "ENOENT") return null;
    throw e;
  }
}
function resolveSymlink(file) {
  try { return fs.realpathSync(file); } catch (e) {
    if (e && e.code === "ENOENT") throw new Error(`Refusing dangling symlink: ${file}`);
    throw e;
  }
}
function assertDirectoryAncestors(file) {
  const ancestors = [];
  for (let dir = path.dirname(path.resolve(file));; dir = path.dirname(dir)) {
    ancestors.push(dir);
    if (path.dirname(dir) === dir) break;
  }
  for (const dir of ancestors.reverse()) {
    const st = lstatIfPresent(dir);
    if (!st) continue;
    const target = st.isSymbolicLink() ? fs.lstatSync(resolveSymlink(dir)) : st;
    if (!target.isDirectory()) throw new Error(`Refusing non-directory ancestor: ${dir}`);
  }
}
function resolveRegularFile(file) {
  // ENOENT below a dangling directory link must never be treated as a new file.
  assertDirectoryAncestors(file);
  const st = lstatIfPresent(file);
  if (!st) return { target: file, missing: true, mode: null };
  const target = st.isSymbolicLink() ? resolveSymlink(file) : file;
  const targetStat = st.isSymbolicLink() ? fs.lstatSync(target) : st;
  if (!targetStat.isFile()) throw new Error(`Refusing non-regular file: ${file}`);
  return { target, missing: false, mode: targetStat.mode & 0o7777 };
}
function inspectBackupPath(file) {
  const bak = file + ".t3hub.bak";
  const st = lstatIfPresent(bak);
  if (st && !st.isFile()) throw new Error(`Refusing unsafe backup path (expected a regular file): ${bak}`);
  return { bak, st };
}
function readTextFileStrict(file) {
  const resolved = resolveRegularFile(file);
  inspectBackupPath(file);
  return { missing: resolved.missing, content: resolved.missing ? "" : fs.readFileSync(resolved.target, "utf8") };
}
function probeTextSnapshot(file) {
  try { return { ...readTextFileStrict(file), error: null, corrupted: false }; }
  catch (e) { return { content: "", missing: false, error: String((e && e.message) || e), corrupted: true }; }
}
function writeTextAtomic(file, text) {
  const resolved = resolveRegularFile(file), target = resolved.target;
  safeMkdir(path.dirname(target));
  let mode = resolved.mode;
  if (mode === null) {
    if (/\.(json|toml)$/i.test(file)) mode = 0o600;
    else mode = 0o644;
  }
  const tmp = target + ".tmp-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  let fd = null, created = false;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    created = true;
    fs.writeFileSync(fd, text, "utf8");
    fs.fsyncSync(fd);
    fs.fchmodSync(fd, mode);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, target);
  } finally {
    try { if (fd !== null) fs.closeSync(fd); } catch {}
    try { if (created) fs.unlinkSync(tmp); } catch {}
  }
}
function isPlainObject(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
function readJsonFileStrict(file) {
  const { content: raw, missing } = readTextFileStrict(file);
  if (missing) return { missing: true, data: {} };
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { throw new Error(`invalid JSON in ${file}: ${e.message}`); }
  if (!isPlainObject(parsed)) throw new Error(`invalid JSON in ${file}: root must be a plain object`);
  return { missing: false, data: parsed };
}
function probeJsonSnapshot(file) {
  try {
    const r = readJsonFileStrict(file);
    return { data: r.data || {}, error: null, corrupted: false, missing: Boolean(r.missing) };
  } catch (e) {
    return { data: {}, error: String((e && e.message) || e), corrupted: true, missing: false };
  }
}
// Form values must retain each native key independently of overview fallbacks.
function editableValues(data, keys) {
  return Object.fromEntries(keys.map((key) => [key, Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null]));
}
function readTextForUpdate(file) {
  return readTextFileStrict(file).content;
}
function backupOnce(file) {
  const source = resolveRegularFile(file);
  const { bak, st } = inspectBackupPath(file);
  if (!st && !source.missing) {
    try { fs.copyFileSync(source.target, bak, fs.constants.COPYFILE_EXCL); }
    catch (e) {
      if (!e || e.code !== "EEXIST" || !inspectBackupPath(file).st) throw e;
      return bak;
    }
    if (/\.(json|toml)$/i.test(file)) fs.chmodSync(bak, 0o600);
  }
  return bak;
}
function isUnsafeScalar(value) {
  const s = String(value);
  return s.includes("\n") || s.includes("\r") || s.includes('"') || s.includes("\\") || s.length > 200;
}
function tomlEscape(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
function tomlUnescape(s) {
  const inner = String(s);
  let out = "";
  for (let i = 0; i < inner.length; i += 1) {
    if (inner[i] !== "\\") { out += inner[i]; continue; }
    if (i + 1 >= inner.length) { out += "\\"; break; }
    const nx = inner[i + 1];
    if (nx === "n") { out += "\n"; i += 1; }
    else if (nx === "t") { out += "\t"; i += 1; }
    else if (nx === "r") { out += "\r"; i += 1; }
    else if (nx === "b") { out += "\b"; i += 1; }
    else if (nx === "f") { out += "\f"; i += 1; }
    else if (nx === '"') { out += '"'; i += 1; }
    else if (nx === "\\") { out += "\\"; i += 1; }
    else if (nx === "u") {
      const hex = inner.slice(i + 2, i + 6);
      if (/^[0-9A-Fa-f]{4}$/.test(hex)) { out += String.fromCodePoint(parseInt(hex, 16)); i += 5; } else { out += nx; i += 1; }
    } else if (nx === "U") {
      const hex = inner.slice(i + 2, i + 10);
      if (/^[0-9A-Fa-f]{8}$/.test(hex)) { try { out += String.fromCodePoint(parseInt(hex, 16)); } catch {} i += 9; } else { out += nx; i += 1; }
    } else if (nx === "\n") {
      i += 1;
      let j = i + 1;
      while (j < inner.length && (inner[j] === " " || inner[j] === "\t")) j += 1;
      i = j - 1;
    } else { out += nx; i += 1; }
  }
  return out;
}
function stripInitialMultilineNewline(inner) {
  if (inner.startsWith("\r\n")) return inner.slice(2);
  if (inner.startsWith("\n")) return inner.slice(1);
  return inner;
}
function decodeMultilineBasic(inner) {
  inner = stripInitialMultilineNewline(inner);
  let out = "";
  for (let i = 0; i < inner.length; ) {
    if (inner[i] === "\r" && inner[i + 1] === "\n") { out += "\n"; i += 2; continue; }
    if (inner[i] !== "\\") { out += inner[i]; i += 1; continue; }
    if (i + 1 >= inner.length) { out += "\\"; i += 1; continue; }
    const nx = inner[i + 1];
    if (nx === "b") { out += "\b"; i += 2; continue; }
    if (nx === "t") { out += "\t"; i += 2; continue; }
    if (nx === "n") { out += "\n"; i += 2; continue; }
    if (nx === "f") { out += "\f"; i += 2; continue; }
    if (nx === "r") { out += "\r"; i += 2; continue; }
    if (nx === '"') { out += '"'; i += 2; continue; }
    if (nx === "\\") { out += "\\"; i += 2; continue; }
    if (nx === "u") {
      const hex = inner.slice(i + 2, i + 6);
      if (/^[0-9A-Fa-f]{4}$/.test(hex)) { out += String.fromCodePoint(parseInt(hex, 16)); i += 6; continue; }
      out += nx; i += 2; continue;
    }
    if (nx === "U") {
      const hex = inner.slice(i + 2, i + 10);
      if (/^[0-9A-Fa-f]{8}$/.test(hex)) { try { out += String.fromCodePoint(parseInt(hex, 16)); } catch {} i += 10; continue; }
      out += nx; i += 2; continue;
    }
    let j = i + 1;
    while (j < inner.length && (inner[j] === " " || inner[j] === "\t")) j += 1;
    if (j < inner.length && (inner[j] === "\n" || (inner[j] === "\r" && inner[j + 1] === "\n"))) {
      if (inner[j] === "\r") j += 2; else j += 1;
      while (j < inner.length) {
        if (inner[j] === " " || inner[j] === "\t" || inner[j] === "\n") j += 1;
        else if (inner[j] === "\r" && inner[j + 1] === "\n") j += 2;
        else break;
      }
      i = j;
      continue;
    }
    out += nx;
    i += 2;
  }
  return out;
}
function decodeMultilineLiteral(inner) {
  inner = stripInitialMultilineNewline(inner);
  return inner.replace(/\r\n/g, "\n");
}
// --- TOML lexical scanner: preserve blanks/comments, handle multiline strings/arrays ---
function isBareKeyChar(ch) { return /[A-Za-z0-9_-]/.test(ch); }
function skipSpacesTabs(text, pos) {
  let p = pos;
  while (p < text.length && (text[p] === " " || text[p] === "\t")) p += 1;
  return p;
}
function scanTomlString(text, pos, multiline, basic) {
  const quote = text[pos];
  let i = pos + (multiline ? 3 : 1);
  while (i < text.length) {
    const ch = text[i];
    if (ch === quote) {
      if (!multiline) return i + 1;
      let end = i;
      while (text[end] === quote) end += 1;
      const run = end - i;
      if (run > 5) throw new Error("corrupt TOML: too many closing quotes");
      if (run >= 3) return end;
      i = end;
      continue;
    }
    if (basic && ch === "\\") {
      const escaped = text[i + 1];
      if (escaped && 'btnfr"\\'.includes(escaped)) { i += 2; continue; }
      if (escaped === "u" || escaped === "U") {
        const size = escaped === "u" ? 4 : 8;
        const hex = text.slice(i + 2, i + 2 + size);
        const code = parseInt(hex, 16);
        if (hex.length !== size || !/^[0-9a-f]+$/i.test(hex) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new Error("corrupt TOML: invalid Unicode escape");
        i += 2 + size;
        continue;
      }
      if (multiline) {
        let next = skipSpacesTabs(text, i + 1);
        if (text[next] === "\n" || (text[next] === "\r" && text[next + 1] === "\n")) {
          while (next < text.length) {
            if (text[next] === " " || text[next] === "\t" || text[next] === "\n") next += 1;
            else if (text[next] === "\r" && text[next + 1] === "\n") next += 2;
            else break;
          }
          i = next;
          continue;
        }
      }
      throw new Error("corrupt TOML: invalid string escape");
    }
    const code = text.charCodeAt(i);
    if (ch === "\r" && multiline && text[i + 1] === "\n") { i += 2; continue; }
    if ((code < 0x20 && ch !== "\t" && !(multiline && ch === "\n")) || code === 0x7f) throw new Error("corrupt TOML: control character in string");
    i += 1;
  }
  throw new Error("corrupt TOML: unterminated string");
}
function scanBasicSingle(text, pos) { return scanTomlString(text, pos, false, true); }
function scanLiteralSingle(text, pos) { return scanTomlString(text, pos, false, false); }
function scanBasicMulti(text, pos) { return scanTomlString(text, pos, true, true); }
function scanLiteralMulti(text, pos) { return scanTomlString(text, pos, true, false); }

function isTomlDateTime(value) {
  const timeValid = (h, m, s) => Number(h) <= 23 && Number(m) <= 59 && Number(String(s).split(".")[0]) <= 60;
  if (/^\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)) return timeValid(...value.split(":"));
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))?)?$/);
  if (!match) return false;
  const [, y, m, d, h, minute, sec, sign, offsetH, offsetM] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] &&
    (h === undefined || timeValid(h, minute, sec)) &&
    (!sign || (Number(offsetH) <= 23 && Number(offsetM) <= 59));
}
function assertTomlBareValue(value) {
  const digits = "[0-9](?:_?[0-9])*";
  const integer = "(?:0|[1-9](?:_?[0-9])*)";
  const decimal = new RegExp("^[+-]?" + integer + "$");
  const float = new RegExp("^[+-]?" + integer + "(?:\\." + digits + "(?:[eE][+-]?" + digits + ")?|[eE][+-]?" + digits + ")$");
  if (/^(?:true|false|[+-]?(?:inf|nan))$/.test(value) || decimal.test(value) ||
      /^0x[0-9a-fA-F](?:_?[0-9a-fA-F])*$/.test(value) ||
      /^0o[0-7](?:_?[0-7])*$/.test(value) || /^0b[01](?:_?[01])*$/.test(value) ||
      float.test(value) || isTomlDateTime(value)) return;
  throw new Error("corrupt TOML: invalid bare value");
}
function skipArrayTrivia(text, pos) {
  let i = pos;
  while (i < text.length) {
    if (text[i] === " " || text[i] === "\t" || text[i] === "\n") i += 1;
    else if (text[i] === "\r" && text[i + 1] === "\n") i += 2;
    else if (text[i] === "#") { while (i < text.length && text[i] !== "\n") i += 1; }
    else break;
  }
  return i;
}
function scanBalancedValue(text, pos, depth) {
  const array = text[pos] === "[";
  const close = array ? "]" : "}";
  const skip = array ? skipArrayTrivia : skipSpacesTabs;
  let i = skip(text, pos + 1);
  const keys = [];
  if (text[i] === close) return i + 1;
  while (i < text.length) {
    if (!array) {
      const key = parseKeyChain(text, i);
      if (!key || text[key.keyEnd] !== "=") throw new Error("corrupt TOML: invalid inline table key/value");
      // A key cannot be assigned twice, nor used both as a value and a parent.
      if (keys.some(parts => parts.slice(0, Math.min(parts.length, key.parts.length)).every((p, n) => p === key.parts[n]))) throw new Error("corrupt TOML: duplicate/conflicting inline table key");
      keys.push(key.parts);
      i = skipSpacesTabs(text, key.keyEnd + 1);
    }
    i = scanValueEnd(text, i, depth + 1);
    // Only a separator/closing delimiter (or array trivia) may follow a value.
    i = skip(text, i);
    if (text[i] === close) return i + 1;
    if (text[i] !== ",") throw new Error("corrupt TOML: expected comma or closing bracket");
    i = skip(text, i + 1);
    if (array && text[i] === close) return i + 1;
  }
  throw new Error("corrupt TOML: unclosed array/table");
}
function scanValueEnd(text, valueStart, depth = 0) {
  if (depth > 128) throw new Error("corrupt TOML: nesting limit exceeded");
  const i = skipSpacesTabs(text, valueStart);
  if (i >= text.length || text[i] === "\n" || text[i] === "\r") throw new Error("corrupt TOML: missing value");
  const ch = text[i];
  if (ch === '"') return text.startsWith('"""', i) ? scanBasicMulti(text, i) : scanBasicSingle(text, i);
  if (ch === "'") return text.startsWith("'".repeat(3), i) ? scanLiteralMulti(text, i) : scanLiteralSingle(text, i);
  if (ch === "[" || ch === "{") return scanBalancedValue(text, i, depth);
  let end = i;
  while (end < text.length && !"\n\r#,]}".includes(text[end])) end += 1;
  while (end > i && (text[end - 1] === " " || text[end - 1] === "\t")) end -= 1;
  assertTomlBareValue(text.slice(i, end));
  return end;
}
function parseQuotedStringForKey(text, pos) {
  if (text[pos] === '"') {
    if (text.startsWith('"""', pos)) throw new Error("corrupt TOML: multiline string cannot be a key");
    const end = scanBasicSingle(text, pos);
    return { value: tomlUnescape(text.slice(pos + 1, end - 1)), end };
  }
  if (text.startsWith("'''", pos)) throw new Error("corrupt TOML: multiline string cannot be a key");
  const end = scanLiteralSingle(text, pos);
  return { value: text.slice(pos + 1, end - 1), end };
}
function parseKeyChain(text, pos) {
  let p = pos;
  const parts = [];
  while (true) {
    p = skipSpacesTabs(text, p);
    if (p >= text.length) return null;
    const ch = text[p];
    if (ch === '"' || ch === "'") {
      const r = parseQuotedStringForKey(text, p);
      parts.push(r.value);
      p = r.end;
    } else if (isBareKeyChar(ch)) {
      const start = p;
      while (p < text.length && isBareKeyChar(text[p])) p += 1;
      parts.push(text.slice(start, p));
    } else {
      return null;
    }
    p = skipSpacesTabs(text, p);
    if (p < text.length && text[p] === ".") { p += 1; continue; }
    break;
  }
  return { parts, keyEnd: p };
}
function parseTableHeader(text, pos) {
  const isArray = text[pos + 1] === "[";
  const key = parseKeyChain(text, pos + (isArray ? 2 : 1));
  if (!key || text[key.keyEnd] !== "]" || (isArray && text[key.keyEnd + 1] !== "]")) {
    throw new Error("corrupt TOML: invalid table header");
  }
  const end = key.keyEnd + (isArray ? 2 : 1);
  return { end, isArray, parts: key.parts, headerText: text.slice(pos, end) };
}

// Per-document namespace, matching TOML's explicit/implicit/dotted table rules.
// Values (including arrays and inline tables) are sealed; each array-table
// element gets its own namespace, with headers traversing the latest element.
function createTomlNamespace() {
  const table = origin => ({ kind: "table", origin, entries: new Map() });
  const root = table("explicit");
  let current = root;
  const fail = () => { throw new Error("corrupt TOML: duplicate/conflicting key or table"); };
  return {
    assign(parts) {
      let target = current;
      for (const key of parts.slice(0, -1)) {
        if (!target.entries.has(key)) target.entries.set(key, table("dotted"));
        target = target.entries.get(key);
        if (target.kind !== "table" || target.origin === "explicit") fail();
        if (target.origin === "implicit") target.origin = "dotted";
      }
      const key = parts[parts.length - 1];
      if (target.entries.has(key)) fail();
      target.entries.set(key, { kind: "value" });
    },
    header(parts, isArray) {
      let target = root;
      for (let i = 0; i < parts.length; i += 1) {
        const key = parts[i], last = i === parts.length - 1;
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
    },
  };
}
function scanToml(text) {
  if (typeof text !== "string") throw new Error("corrupt TOML: not a string");
  const len = text.length;
  let pos = 0;
  if (pos < len && text.charCodeAt(pos) === 0xFEFF) pos += 1;
  const tableStarts = [];
  const assignments = [];
  const namespace = createTomlNamespace();
  let inTable = false;
  while (pos < len) {
    const lineStart = pos;
    let p = lineStart;
    while (p < len && (text[p] === " " || text[p] === "\t")) p += 1;
    if (p >= len) break;
    const chAt = text[p];
    if (chAt === "\n") { pos = p + 1; continue; }
    if (chAt === "\r") {
      if (p + 1 < len && text[p + 1] === "\n") pos = p + 2;
      else pos = p + 1;
      continue;
    }
    if (chAt === "#") {
      while (p < len && text[p] !== "\n") p += 1;
      pos = p < len ? p + 1 : p;
      continue;
    }
    if (chAt === "[") {
      const hdr = parseTableHeader(text, p);
      let q = hdr.end;
      q = skipSpacesTabs(text, q);
      if (q < len && text[q] === "#") { while (q < len && text[q] !== "\n") q += 1; }
      if (q < len && text[q] !== "\n" && text[q] !== "\r") throw new Error("corrupt TOML: trailing content after table header");
      namespace.header(hdr.parts, hdr.isArray);
      tableStarts.push({ lineStart, headerEnd: hdr.end, headerText: hdr.headerText });
      inTable = true;
      if (q < len && text[q] === "\r" && q + 1 < len && text[q + 1] === "\n") pos = q + 2;
      else if (q < len && (text[q] === "\n" || text[q] === "\r")) pos = q + 1;
      else pos = q;
      continue;
    }
    const keyRes = parseKeyChain(text, p);
    if (!keyRes) throw new Error(`corrupt TOML: invalid line at offset ${p}: ${JSON.stringify(text.slice(p, Math.min(p + 40, len)))}`);
    let q = skipSpacesTabs(text, keyRes.keyEnd);
    if (q >= len || text[q] !== "=") throw new Error(`corrupt TOML: expected '=' after key at offset ${q}`);
    q += 1;
    const valueStart = skipSpacesTabs(text, q);
    if (valueStart >= len) throw new Error("corrupt TOML: missing value");
    const valueEnd = scanValueEnd(text, valueStart);
    let r = valueEnd;
    r = skipSpacesTabs(text, r);
    if (r < len && text[r] === "#") { while (r < len && text[r] !== "\n") r += 1; }
    if (r < len && text[r] !== "\n" && text[r] !== "\r") throw new Error(`corrupt TOML: trailing content after value at offset ${r}`);
    namespace.assign(keyRes.parts);
    assignments.push({ key: keyRes.parts.join("."), parts: keyRes.parts, keyStart: p, keyEnd: keyRes.keyEnd, valueStart, valueEnd, inTopLevel: !inTable });
    if (r < len && text[r] === "\r" && r + 1 < len && text[r + 1] === "\n") pos = r + 2;
    else if (r < len && (text[r] === "\n" || text[r] === "\r")) pos = r + 1;
    else pos = r;
  }
  return { tableStarts, assignments };
}
function parseTomlValue(raw) {
  const s = String(raw).trim();
  if (s.startsWith('"""') && s.endsWith('"""') && s.length >= 6) return decodeMultilineBasic(s.slice(3, -3));
  if (s.startsWith("'''") && s.endsWith("'''") && s.length >= 6) return decodeMultilineLiteral(s.slice(3, -3));
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) return tomlUnescape(s.slice(1, -1));
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1);
  if (/^-?\d+$/.test(s)) return Number(s);
  return s;
}

// 顶层键值解析：基于词法扫描器，只取真正顶层（首个真表段之前）赋值
function parseTomlTopLevel(text) {
  const src = String(text || "");
  const { assignments } = scanToml(src);
  const out = {};
  for (const a of assignments) {
    if (!a.inTopLevel) continue;
    if (a.parts.length !== 1) continue;
    const key = a.parts[0];
    if (!CODEX_TOP_KEYS.includes(key)) continue;
    out[key] = parseTomlValue(src.slice(a.valueStart, a.valueEnd));
  }
  return out;
}

function countMcpServersInToml(text) {
  try {
    const src = String(text || "");
    const { tableStarts } = scanToml(src);
    let count = 0;
    for (const h of tableStarts) {
      if (/^\[\[?mcp_servers\./.test(h.headerText.trim())) count += 1;
    }
    return count;
  } catch {
    try {
      const matches = String(text || "").match(/^\s*\[mcp_servers\.[^\]]+\]/gm);
      return matches ? matches.length : 0;
    } catch { return 0; }
  }
}

function updateTomlTopKey(text, key, value) {
  if (!CODEX_EDITABLE_KEYS.includes(key)) throw new Error(`codex key not editable: ${key}`);
  if (isUnsafeScalar(value)) throw new Error(`unsafe value for ${key}`);
  const full = String(text || "");
  const scan = scanToml(full);
  const matches = scan.assignments.filter((a) => a.inTopLevel && a.parts.length === 1 && a.parts[0] === key);
  if (value === "" || value === null) {
    let next = full;
    for (const m of [...matches].sort((a, b) => b.keyStart - a.keyStart)) {
      // Remove the whole assignment, including multiline values, while keeping comments and line endings.
      next = next.slice(0, m.keyStart) + next.slice(m.valueEnd);
    }
    scanToml(next);
    return next;
  }
  const esc = tomlEscape(String(value));
  const newValText = `"${esc}"`;
  if (matches.length === 0) {
    const insertion = `${key} = ${newValText}`;
    let next;
    if (scan.tableStarts.length > 0) {
      const insertPos = scan.tableStarts[0].lineStart;
      const prefix = full.slice(0, insertPos);
      const suffix = full.slice(insertPos);
      let sep = "";
      if (prefix.length > 0 && !prefix.endsWith("\n")) sep = "\n";
      next = prefix + sep + insertion + "\n" + suffix;
    } else {
      if (full.length === 0) next = insertion + "\n";
      else {
        let sep = "";
        if (!full.endsWith("\n")) sep = "\n";
        next = full + sep + insertion + "\n";
      }
    }
    scanToml(next);
    return next;
  }
  let next = full;
  const sorted = [...matches].sort((a, b) => b.valueStart - a.valueStart);
  for (const m of sorted) {
    const repl = `${key} = ${newValText}`;
    next = next.slice(0, m.keyStart) + repl + next.slice(m.valueEnd);
  }
  scanToml(next);
  return next;
}

function countSkillsDirs(dirs) {
  let count = 0;
  for (const d of dirs) {
    if (!dirExists(d)) continue;
    try {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        if (ent.isDirectory()) count += 1;
      }
    } catch {}
  }
  return count;
}

function createHostSettingsManager(opts = {}) {
  const homeDir = opts.homeDir || os.homedir();
  const codexConfigPath = expandTilde(opts.codexConfigPath || path.join(homeDir, ".codex", "config.toml"));
  const museSettingsPath = expandTilde(opts.museSettingsPath || path.join(homeDir, ".config", "muse", "settings.json"));
  const piSettingsPath = expandTilde(opts.piSettingsPath || path.join(homeDir, ".pi", "agent", "settings.json"));
  const agyConfigDir = expandTilde(opts.agyConfigDir || path.join(homeDir, ".gemini", "antigravity"));
  const rulesPaths = {
    codex: opts.codexAgentsPath ? expandTilde(opts.codexAgentsPath) : path.join(homeDir, ".codex", "AGENTS.md"),
    antigravity: opts.agyAgentsPath ? expandTilde(opts.agyAgentsPath) : path.join(agyConfigDir, "rules", "AGENTS.md"),
    muse: opts.museAgentsPath ? expandTilde(opts.museAgentsPath) : path.join(homeDir, "AGENTS.md"),
    pi: opts.piAgentsPath ? expandTilde(opts.piAgentsPath) : path.join(homeDir, ".pi", "AGENTS.md"),
  };

  function getCodexSnapshot() {
    const probe = probeTextSnapshot(codexConfigPath), exists = !probe.missing, text = probe.content;
    try {
      if (probe.error) throw new Error(probe.error);
      const top = parseTomlTopLevel(text);
      return { path: codexConfigPath, exists, model: top.model ?? "", model_reasoning_effort: top.model_reasoning_effort ?? "", approval_policy: top.approval_policy ?? "", sandbox_mode: top.sandbox_mode ?? "", max_concurrent_threads: top.max_concurrent_threads ?? null, editableValues: editableValues(top, CODEX_EDITABLE_KEYS), mcpServerCount: countMcpServersInToml(text), error: null, corrupted: false };
    } catch (e) {
      return { path: codexConfigPath, exists, model: "", model_reasoning_effort: "", approval_policy: "", sandbox_mode: "", max_concurrent_threads: null, editableValues: editableValues({}, CODEX_EDITABLE_KEYS), mcpServerCount: 0, error: String((e && e.message) || e), corrupted: true };
    }
  }

  function getMuseSnapshot() {
    const probe = probeJsonSnapshot(museSettingsPath);
    const data = probe.data || {};
    const mcpCount = data && typeof data === "object" && data.mcpServers && typeof data.mcpServers === "object"
      ? Object.keys(data.mcpServers).length
      : 0;
    return {
      path: museSettingsPath,
      exists: !probe.missing,
      model: String((data && (data.model || data.defaultModel)) || ""),
      editableValues: editableValues(data, MUSE_KEYS),
      mcpCount,
      agentsMdPath: rulesPaths.muse,
      error: probe.error,
      corrupted: Boolean(probe.corrupted),
    };
  }

  function getPiSnapshot() {
    const probe = probeJsonSnapshot(piSettingsPath);
    const data = probe.data || {};
    return {
      path: piSettingsPath,
      exists: !probe.missing,
      defaultModel: String((data && data.defaultModel) || ""),
      defaultProvider: String((data && data.defaultProvider) || ""),
      model: String((data && data.model) || ""),
      editableValues: editableValues(data, PI_KEYS),
      settings: isPlainObject(data) ? data : {},
      error: probe.error,
      corrupted: Boolean(probe.corrupted),
    };
  }

  function getAntigravitySnapshot() {
    const rulesDir = path.join(agyConfigDir, "rules");
    const agentsPath = rulesPaths.antigravity;
    const geminiPath = path.join(agyConfigDir, "GEMINI.md");
    let rulePath = agentsPath, probe = probeTextSnapshot(agentsPath);
    if (probe.missing) {
      const fallback = probeTextSnapshot(geminiPath);
      if (!fallback.missing) { rulePath = geminiPath; probe = fallback; }
    }
    const content = probe.content;
    const mcpJsonPaths = [path.join(agyConfigDir, "mcp.json"), path.join(homeDir, ".gemini", "mcp.json")];
    let mcpCount = 0;
    for (const mp of mcpJsonPaths) {
      const d = safeReadJson(mp, null);
      if (d && typeof d === "object") {
        const servers = d.mcpServers || d.servers || null;
        if (servers && typeof servers === "object") { mcpCount = Object.keys(servers).length; break; }
        if (Array.isArray(d)) { mcpCount = d.length; break; }
      }
    }
    const skillsCount = countSkillsDirs([
      path.join(agyConfigDir, "skills"),
      path.join(homeDir, ".agents", "skills"),
    ]);
    return {
      rulesDir,
      rulePath,
      exists: !probe.missing,
      chars: content.length,
      preview: content.slice(0, 600),
      mcpCount,
      skillsCount,
      error: probe.error,
      corrupted: probe.corrupted,
    };
  }

  function getSettingsSnapshot() {
    const codex = getCodexSnapshot();
    const antigravity = getAntigravitySnapshot();
    const muse = getMuseSnapshot();
    const pi = getPiSnapshot();
    const globalRules = {};
    for (const host of Object.keys(rulesPaths)) {
      const p = rulesPaths[host];
      const probe = probeTextSnapshot(p);
      globalRules[host] = { path: p, exists: !probe.missing, chars: probe.content.length, error: probe.error, corrupted: probe.corrupted };
    }
    return { codex, antigravity, muse, pi, globalRules };
  }

  function getRuleContent(host) {
    const p = rulesPaths[host];
    if (!p) throw new Error(`unknown host: ${host}`);
    const { content, missing } = readTextFileStrict(p);
    return { path: p, exists: !missing, content };
  }

  function saveRuleContent(host, content) {
    const p = rulesPaths[host];
    if (!p) throw new Error(`unknown host: ${host}`);
    if (typeof content !== "string") throw new Error("content must be string");
    backupOnce(p);
    writeTextAtomic(p, content);
    return { path: p, chars: content.length };
  }

  function updateHostSetting(input) {
    const { host, key, value } = input || {};
    if (!host || !key) throw new Error("updateHostSetting requires host and key");
    if (host === "codex") {
      if (!CODEX_EDITABLE_KEYS.includes(key)) throw new Error(`codex key not editable: ${key}`);
      if (isUnsafeScalar(value)) throw new Error(`unsafe value for ${key}`);
      const text = readTextForUpdate(codexConfigPath);
      const next = updateTomlTopKey(text, key, value);
      backupOnce(codexConfigPath);
      writeTextAtomic(codexConfigPath, next);
      return { host, key, value: value === null ? null : String(value), path: codexConfigPath };
    }
    if (host === "muse" || host === "pi") {
      const allow = host === "muse" ? MUSE_KEYS : PI_KEYS;
      if (!allow.includes(key)) throw new Error(`${host} key not editable: ${key}`);
      if (typeof value === "string" && value.length > 500) throw new Error(`value too long for ${key}`);
      const file = host === "muse" ? museSettingsPath : piSettingsPath;
      const { data } = readJsonFileStrict(file);
      backupOnce(file);
      if (value === "" || value === null) delete data[key];
      else data[key] = value;
      writeTextAtomic(file, JSON.stringify(data, null, 2) + "\n");
      return { host, key, value, path: file };
    }
    throw new Error(`unknown host: ${host}`);
  }

  return { getSettingsSnapshot, getRuleContent, saveRuleContent, updateHostSetting };
}

module.exports = {
  createHostSettingsManager,
  parseTomlTopLevel,
  countMcpServersInToml,
  CODEX_EDITABLE_KEYS,
  MUSE_KEYS,
  PI_KEYS,
};
