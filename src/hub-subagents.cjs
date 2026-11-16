"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

// Refuse links at both the leaf and any parent before reading, creating,
// replacing or deleting. The OS temp root itself may be a system alias.
function assertNoSymlinkPath(file) {
  let current = path.resolve(file);
  const tempRoot = path.resolve(os.tmpdir());
  while (true) {
    if (current === tempRoot) return;
    const st = lstatSafe(current);
    if (st && st.isSymbolicLink()) throw new Error("unsafe symlink path: " + current);
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
function safeMkdir(dir) { assertNoSymlinkPath(dir); fs.mkdirSync(dir, { recursive: true }); }
function dirExists(p) { assertNoSymlinkPath(p); try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function fileExists(p) { assertNoSymlinkPath(p); try { return fs.statSync(p).isFile(); } catch { return false; } }
function lstatSafe(p) { try { return fs.lstatSync(p); } catch { return null; } }
function readJsonFile(file, fallback) { assertNoSymlinkPath(file); try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function existingFileMode(file) {
  try {
    const st = fs.statSync(file);
    if (st.isFile()) return st.mode & 0o777;
  } catch {}
  return null;
}
function writeJsonFileAtomic(file, obj) {
  writeTextAtomic(file, JSON.stringify(obj, null, 2) + "\n", 0o600);
}
function writeTextAtomic(file, text, defaultMode) {
  assertNoSymlinkPath(file);
  safeMkdir(path.dirname(file));
  const current = lstatSafe(file);
  if (current && !current.isFile()) throw new Error("unsafe non-regular file: " + file);
  let mode = existingFileMode(file);
  if (mode === null) {
    if (typeof defaultMode === "number") mode = defaultMode;
    else if (/\.json$/i.test(file)) mode = 0o600;
    else mode = 0o644;
  }
  const tmp = file + ".tmp-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  let fd = null;
  let ownsTmp = false;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    ownsTmp = true;
    fs.writeSync(fd, text, 0, "utf8");
    try { fs.fsyncSync(fd); } catch {}
    try { fs.fchmodSync(fd, mode); } catch {}
    fs.closeSync(fd);
    fd = null;
    assertNoSymlinkPath(file);
    fs.renameSync(tmp, file);
    ownsTmp = false;
  } catch (e) {
    try { if (fd !== null) fs.closeSync(fd); } catch {}
    try { if (ownsTmp) fs.unlinkSync(tmp); } catch {}
    throw e;
  } finally {
    try { if (fd !== null) fs.closeSync(fd); } catch {}
    try { if (ownsTmp) fs.unlinkSync(tmp); } catch {}
  }
}
function yamlDoubleQuotedScalar(value) {
  // Emit single-line YAML 1.2 double-quoted escapes losslessly for every control,
  // line separator (CR/LF/NEL/LS/PS), format char, and noncharacter code point.
  let quoted = '"';
  for (const ch of String(value ?? "")) {
    const cp = ch.codePointAt(0);
    if (ch === '"' || ch === "\\") quoted += "\\" + ch;
    else if (ch === "\n") quoted += "\\n";
    else if (ch === "\r") quoted += "\\r";
    else if (ch === "\t") quoted += "\\t";
    // Lone UTF-16 surrogates are not Unicode scalars (nor valid YAML).
    else if (cp >= 0xd800 && cp <= 0xdfff) quoted += "\\ufffd";
    else if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(ch) || (cp >= 0xfdd0 && cp <= 0xfdef) || (cp & 0xffff) >= 0xfffe) {
      quoted += (cp <= 0xffff ? "\\u" : "\\U") + cp.toString(16).padStart(cp <= 0xffff ? 4 : 8, "0");
    } else quoted += ch;
  }
  return quoted + '"';
}
const HUB_LOCK_STALE_MS = 30000;
const HUB_LOCK_WAIT_MS = 5000;
function acquireT3HubLock(lockPath) {
  safeMkdir(path.dirname(lockPath));
  assertNoSymlinkPath(lockPath);
  const deadline = Date.now() + HUB_LOCK_WAIT_MS;
  while (true) {
    try {
      const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      try { fs.writeSync(fd, String(process.pid) + "\n"); } catch {}
      try { fs.fsyncSync(fd); } catch {}
      try { fs.closeSync(fd); } catch {}
      return lockPath;
    } catch (e) {
      if (!e || e.code !== "EEXIST") throw e;
      let st = null;
      try { st = fs.lstatSync(lockPath); } catch {}
      if (st && st.isSymbolicLink()) throw new Error("unsafe symlink path: " + lockPath);
      if (st && Date.now() - st.mtimeMs > HUB_LOCK_STALE_MS) {
        try { fs.unlinkSync(lockPath); continue; } catch {}
      } else if (!st) {
        continue;
      }
      if (Date.now() > deadline) throw new Error("timeout acquiring lock: " + lockPath);
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      } catch {
        const end = Date.now() + 10;
        while (Date.now() < end) {}
      }
    }
  }
}
function releaseT3HubLock(lockPath) {
  try { fs.unlinkSync(lockPath); } catch {}
}
function writeNewFileExclusive(file, text, mode) {
  assertNoSymlinkPath(file);
  safeMkdir(path.dirname(file));
  const current = lstatSafe(file);
  if (current && !current.isFile()) throw new Error("unsafe non-regular file: " + file);
  const safeMode = (mode & 0o555) || 0o444;
  const tmp = file + ".tmp-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  let fd = null;
  let ownsTmp = false;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    ownsTmp = true;
    fs.writeSync(fd, text, 0, "utf8");
    try { fs.fsyncSync(fd); } catch {}
    fs.fchmodSync(fd, safeMode);
    const newStat = fs.fstatSync(fd);
    if ((newStat.mode & 0o222) !== 0) {
      throw new Error("failed to strip write bits before publish: " + file);
    }
    const publishedIno = newStat.ino;
    fs.closeSync(fd);
    fd = null;
    assertNoSymlinkPath(file);
    fs.linkSync(tmp, file);
    try { fs.unlinkSync(tmp); ownsTmp = false; } catch {}
    const post = lstatSafe(file);
    if (!post || !post.isFile() || post.ino !== publishedIno) {
      return { replacedConcurrently: true };
    }
    return { replacedConcurrently: false };
  } catch (e) {
    try { if (fd !== null) fs.closeSync(fd); } catch {}
    try { if (ownsTmp) fs.unlinkSync(tmp); } catch {}
    throw e;
  } finally {
    try { if (fd !== null) fs.closeSync(fd); } catch {}
    try { if (ownsTmp) fs.unlinkSync(tmp); } catch {}
  }
}
// The staged inode is private: never delete it until ownership was checked or
// an exclusive hard link has secured it elsewhere. A second editor save wins
// the target name; the captured inode gets its own discoverable preserved name.
function restoreStagedFile(staged, file) {
  try {
    fs.linkSync(staged, file);
  } catch (e) {
    if (e && e.code === "EEXIST") {
      while (true) {
        const preservedPath = file + ".unmanaged-preserved-" + Date.now() + "-" + process.pid + "-" + Math.random().toString(16).slice(2);
        try { fs.linkSync(staged, preservedPath); }
        catch (preserveError) {
          if (preserveError && preserveError.code === "EEXIST") continue;
          return { preservedPath: staged };
        }
        fs.unlinkSync(staged);
        return { preservedPath };
      }
    }
    // Unsupported links, permission failures, directories, etc.: retain the
    // original staged inode rather than falling back to a lossy copy/delete.
    return { preservedPath: staged };
  }
  fs.unlinkSync(staged);
  return {};
}
function readUtf8FromFdAtZero(fd) {
  const st = fs.fstatSync(fd);
  if (!st.isFile() || st.nlink !== 1) return { st, text: null, raw: null };
  if (st.size === 0) return { st, text: "", raw: Buffer.alloc(0) };
  const chunks = [];
  let pos = 0;
  const buf = Buffer.allocUnsafe(Math.min(Math.max(st.size, 4096), 65536));
  while (true) {
    const n = fs.readSync(fd, buf, 0, buf.length, pos);
    if (n <= 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
    pos += n;
  }
  const raw = Buffer.concat(chunks);
  return { st: fs.fstatSync(fd), text: raw.toString("utf8"), raw };
}
function readRegularSnapshot(file) {
  const st = lstatSafe(file);
  if (!st) return { missing: true };
  if (!st.isFile() || st.nlink !== 1) return { missing: false, unsafe: true, st };
  let fd = null;
  try {
    const nofollow = fs.constants.O_NOFOLLOW || 0;
    fd = fs.openSync(file, fs.constants.O_RDONLY | nofollow);
    const snap = readUtf8FromFdAtZero(fd);
    if (!snap.st.isFile() || snap.st.nlink !== 1 || snap.st.ino !== st.ino || snap.raw === null) {
      return { missing: false, unsafe: true, st: snap.st };
    }
    return { missing: false, unsafe: false, ino: snap.st.ino, text: snap.text, raw: snap.raw };
  } catch (e) {
    if (e && e.code === "ENOENT") return { missing: true };
    return { missing: false, unsafe: true, error: e };
  } finally {
    try { if (fd !== null) fs.closeSync(fd); } catch {}
  }
}
function retireStagedFile(staged, file, retiredDir) {
  const candidates = [
    retiredDir,
    path.join(path.dirname(file), ".t3hub-retired"),
  ].filter(Boolean);
  const base = path.basename(file);
  for (const dir of candidates) {
    try {
      assertNoSymlinkPath(dir);
      safeMkdir(dir);
      try { fs.chmodSync(dir, 0o700); } catch {}
      assertNoSymlinkPath(dir);
    } catch {
      continue;
    }
    let crossDevice = false;
    for (let i = 0; i < 64; i += 1) {
      const retiredPath = path.join(dir, `${base}.${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`);
      try {
        fs.linkSync(staged, retiredPath);
      } catch (err) {
        if (err && err.code === "EEXIST") continue;
        if (err && err.code === "EXDEV") { crossDevice = true; break; }
        return { retiredPath: staged };
      }
      fs.unlinkSync(staged);
      return { retiredPath };
    }
    if (!crossDevice) break;
  }
  return { retiredPath: staged };
}
function stageManagedFile(file, text, mode, retiredDir, expectedSnap = null) {
  assertNoSymlinkPath(file);
  safeMkdir(path.dirname(file));
  const updating = text !== undefined;
  const entrySnap = readRegularSnapshot(file);
  if (entrySnap.missing) return { changed: false, skippedUnmanaged: updating };
  if (entrySnap.unsafe || !isHubManagedContent(entrySnap.text)) {
    return { changed: false, skippedUnmanaged: true };
  }
  if (expectedSnap && (expectedSnap.ino !== entrySnap.ino || Buffer.compare(expectedSnap.raw, entrySnap.raw) !== 0)) {
    return { changed: false, skippedUnmanaged: true };
  }
  const baselineIno = entrySnap.ino;
  const baselineRaw = entrySnap.raw;
  // mkdtemp reserves a same-filesystem, mode-0700 namespace. rename cannot
  // overwrite a pre-existing staging name, including a malicious symlink.
  const stageDir = fs.mkdtempSync(file + ".stage-");
  const tmp = path.join(stageDir, "new");
  const staged = path.join(stageDir, "old");
  let fd = null;
  let stagedFd = null;
  let stagedOrigMode = null;
  let publishedIno = null;
  let ownsTmp = false;
  let stageDirCleaned = false;
  const restoreWithMode = (sourcePath = staged) => {
    if (stagedFd !== null && stagedOrigMode !== null) {
      try { fs.fchmodSync(stagedFd, stagedOrigMode); } catch {}
    }
    if (stagedFd !== null) {
      try { fs.closeSync(stagedFd); } catch {}
      stagedFd = null;
    }
    return restoreStagedFile(sourcePath, file);
  };
  try {
    if (updating) {
      const safeMode = (mode & 0o555) || 0o444;
      fd = fs.openSync(tmp, "wx", 0o600);
      ownsTmp = true;
      fs.writeFileSync(fd, text, "utf8");
      fs.fsyncSync(fd);
      fs.fchmodSync(fd, safeMode);
      const newStat = fs.fstatSync(fd);
      if ((newStat.mode & 0o222) !== 0) {
        throw new Error("failed to strip write bits before stage link: " + file);
      }
      publishedIno = newStat.ino;
      fs.closeSync(fd);
      fd = null;
    }
    assertNoSymlinkPath(file);
    try { fs.renameSync(file, staged); }
    catch (e) {
      if (e && e.code === "ENOENT") return { changed: false, skippedUnmanaged: updating };
      throw e;
    }
    let managed = false;
    let stagedSnapRaw = null;
    try {
      const stagedLinkStat = fs.lstatSync(staged);
      if (stagedLinkStat.isFile() && stagedLinkStat.nlink === 1 && stagedLinkStat.ino === baselineIno) {
        const lockFlags = process.platform === "darwin" ? (0x20 | fs.constants.O_NONBLOCK) : 0;
        stagedFd = fs.openSync(staged, fs.constants.O_RDONLY | lockFlags);
        const openStat = fs.fstatSync(stagedFd);
        if (openStat.isFile() && openStat.ino === baselineIno && openStat.nlink === 1) {
          stagedOrigMode = openStat.mode & 0o777;
          if ((stagedOrigMode & 0o222) !== 0) {
            try { fs.fchmodSync(stagedFd, (stagedOrigMode & 0o555) || 0o400); } catch {}
          }
          const snap = readUtf8FromFdAtZero(stagedFd);
          if (
            snap.st.nlink === 1 &&
            snap.raw !== null &&
            Buffer.compare(snap.raw, baselineRaw) === 0 &&
            isHubManagedContent(snap.text)
          ) {
            managed = true;
            stagedSnapRaw = snap.raw;
          }
        }
      }
    } catch {} // Locked, multi-linked, mutated, or unreadable staged inode is restored intact.
    if (!managed) return { changed: false, skippedUnmanaged: true, ...restoreWithMode(staged) };
    // Never rename over `file` (which could clobber a concurrent save), and
    // never drop the staged inode nlink to 0 (retire it via hard link first,
    // then re-read stagedFd AFTER stageDir/old is unlinked so any write up
    // through unlink — even one preserving t3_hub_managed: true — is rescued).
    const rescueIfMutated = (sourcePath) => {
      let unchanged = false;
      try {
        const check = readUtf8FromFdAtZero(stagedFd);
        unchanged =
          check.st.nlink === 1 &&
          check.raw !== null &&
          Buffer.compare(check.raw, stagedSnapRaw) === 0 &&
          isHubManagedContent(check.text);
      } catch {}
      if (unchanged) return null;
      return { changed: false, skippedUnmanaged: true, ...restoreWithMode(sourcePath) };
    };
    // POSIX note: Hub-managed files are published 0444 read-only so normal editors
    // cannot acquire writable descriptors. If root/chmod+w pre-opened a writable fd
    // without advisory locks, mutations up through staging cleanup are rescued as
    // conflicts; mutations racing with or after function return survive intact in
    // retired-agents (nlink >= 1) because POSIX has no mandatory fd write lock.
    const finalizeRetired = () => {
      const pre = rescueIfMutated(staged);
      if (pre) return pre;
      const { retiredPath } = retireStagedFile(staged, file, retiredDir);
      if (ownsTmp) {
        try { fs.unlinkSync(tmp); ownsTmp = false; } catch {}
      }
      if (retiredPath !== staged) {
        try { fs.rmdirSync(stageDir); stageDirCleaned = true; } catch {}
      }
      const post = rescueIfMutated(retiredPath);
      if (post) return post;
      return null;
    };
    if (updating) {
      const preLinkRescue = rescueIfMutated(staged);
      if (preLinkRescue) return preLinkRescue;
      try { fs.linkSync(tmp, file); }
      catch (e) {
        if (e && e.code === "EEXIST") {
          const rescued = finalizeRetired();
          if (rescued) return rescued;
          return { changed: false, skippedUnmanaged: true };
        }
        const recovery = restoreWithMode(staged);
        if (recovery.preservedPath) e.preservedPath = recovery.preservedPath;
        throw e;
      }
      try { fs.unlinkSync(tmp); ownsTmp = false; } catch {}
    }
    const rescued = finalizeRetired();
    if (rescued) return rescued;
    const postTarget = lstatSafe(file);
    if (updating) {
      if (!postTarget || !postTarget.isFile() || postTarget.ino !== publishedIno) {
        return { changed: false, skippedUnmanaged: true };
      }
    } else if (postTarget !== null) {
      return { changed: false, skippedUnmanaged: true };
    }
    return { changed: true, skippedUnmanaged: false };
  } finally {
    try { if (fd !== null) fs.closeSync(fd); } catch {}
    try { if (stagedFd !== null) fs.closeSync(stagedFd); } catch {}
    try { if (ownsTmp) fs.unlinkSync(tmp); } catch {}
    // Never recursively clean: an un-restorable original must survive here.
    if (!stageDirCleaned) {
      try { fs.rmdirSync(stageDir); } catch {}
    }
  }
}
function replaceManagedFile(file, text, mode, retiredDir, expectedSnap = null) {
  const { changed, ...result } = stageManagedFile(file, text, mode, retiredDir, expectedSnap);
  return { file, written: changed, ...result };
}
function recordUnmanagedConflict(result, id, skippedUnmanaged, conflicts) {
  if (!result || !result.skippedUnmanaged) return;
  if (!skippedUnmanaged.includes(result.file)) skippedUnmanaged.push(result.file);
  if (!conflicts.some(c => c.id === id && c.path === result.file)) {
    conflicts.push({ id, path: result.file, reason: "unmanaged-user-file", ...(result.preservedPath ? { preservedPath: result.preservedPath } : {}) });
  }
}
const HUB_AGENT_MARKER = "t3_hub_managed: true";
const HUB_AGENT_HTML_MARKER = "<!-- managed-by: t3-hub -->";

// Ownership is destructive authority, so parse a conservative YAML subset
// rather than searching for a marker in otherwise unvalidated text. Support
// block mappings/sequences, quoted/plain scalars, flow collections and |/>;
// reject ambiguous YAML features (tags, aliases, complex/merge keys) outright.
function parseOwnershipFrontmatter(source) {
  const fail = () => { throw new Error("invalid ownership YAML"); };
  const incomplete = {};
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u2028\u2029\ufffe\uffff]/.test(source)) fail();
  const lines = source.split(/\r?\n/);
  const plainKey = key => /^[\p{L}_][\p{L}\p{N}_. -]*$/u.test(key) && !/^(?:true|false|null|yes|no|on|off)$/i.test(key);
  function scalar(text) {
    let p = 0;
    const ws = () => {
      while (p < text.length) {
        if (text[p] === "\t") fail();
        if (text[p] === " " || text[p] === "\n") p += 1;
        else if (text[p] === "#" && (p === 0 || /[ \n]/.test(text[p - 1]))) { while (p < text.length && text[p] !== "\n") p += 1; }
        else break;
      }
    };
    function quoted() {
      const quote = text[p++];
      let out = "";
      while (p < text.length) {
        const ch = text[p++];
        if (ch === quote) {
          if (quote === "'" && text[p] === "'") { out += "'"; p += 1; continue; }
          return out;
        }
        if (quote === '"' && ch === "\\") {
          if (p >= text.length) throw incomplete;
          const escape = text[p++];
          const escapes = { "0": "\0", a: "\x07", b: "\b", t: "\t", "\t": "\t", n: "\n", v: "\v", f: "\f", r: "\r", e: "\x1b", " ": " ", '"': '"', "/": "/", "\\": "\\", N: "\u0085", _: "\u00a0", L: "\u2028", P: "\u2029" };
          if (Object.hasOwn(escapes, escape)) out += escapes[escape];
          else if (/[xuU]/.test(escape)) {
            const size = escape === "x" ? 2 : escape === "u" ? 4 : 8;
            const hex = text.slice(p, p + size), cp = parseInt(hex, 16);
            if (hex.length !== size || !/^[0-9a-f]+$/i.test(hex) || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) fail();
            out += String.fromCodePoint(cp); p += size;
          } else if (escape === "\n") { while (text[p] === " " || text[p] === "\t") p += 1; }
          else fail();
        } else out += ch;
      }
      throw incomplete;
    }
    function value(flow, depth) {
      if (depth > 128) fail();
      ws();
      if (p >= text.length) throw incomplete;
      if (text[p] === '"' || text[p] === "'") return quoted();
      if (text[p] === "[" || text[p] === "{") {
        const mapping = text[p++] === "{", close = mapping ? "}" : "]";
        const result = mapping ? new Map() : [];
        ws();
        if (text[p] === close) { p += 1; return result; }
        while (p < text.length) {
          if (mapping) {
            let key;
            if (text[p] === '"' || text[p] === "'") key = quoted();
            else {
              const start = p;
              while (p < text.length && !/[:\s,\[\]{}]/.test(text[p])) p += 1;
              key = text.slice(start, p);
              if (!plainKey(key)) fail();
            }
            ws();
            if (text[p++] !== ":" || result.has(key)) fail();
            result.set(key, value(true, depth + 1));
          } else result.push(value(true, depth + 1));
          ws();
          if (text[p] === close) { p += 1; return result; }
          if (p >= text.length) throw incomplete;
          if (text[p++] !== ",") fail();
          ws();
          if (text[p] === close) { p += 1; return result; }
        }
        throw incomplete;
      }
      const start = p;
      while (p < text.length && text[p] !== "\n" && !(flow && /[,\]}]/.test(text[p]))) {
        if (text[p] === "#" && (p === start || /\s/.test(text[p - 1]))) break;
        if (/[\t\[\]{}]/.test(text[p]) || (flow && /[:?]/.test(text[p])) || (text[p] === ":" && /[\s,\]}]/.test(text[p + 1] || " "))) fail();
        p += 1;
      }
      const raw = text.slice(start, p).trim();
      if (!raw || /^[,!&*|>@`%]|^[-?:](?:\s|$)/.test(raw)) fail();
      return raw === "true" ? true : raw === "false" ? false : raw;
    }
    const result = value(false, 0);
    ws();
    if (p !== text.length) fail();
    return result;
  }
  const mapping = text => text.match(/^((?:"(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[\p{L}_][\p{L}\p{N}_. -]*)) *:(?: +|$)(.*)$/u);
  function entry(index) {
    while (index < lines.length && /^[ \t]*(?:#.*)?$/.test(lines[index])) index += 1;
    if (index === lines.length) return null;
    const indent = lines[index].match(/^ */)[0].length;
    if (lines[index][indent] === "\t") fail();
    return { index, indent, text: lines[index].slice(indent) };
  }
  function readValue(raw, index, indent, depth) {
    const plain = raw.replace(/[ \t]+#.*$/, "").trim();
    if (!plain || plain.startsWith("#")) {
      const child = entry(index + 1);
      if (child && child.indent > indent) return block(child.index, child.indent, depth + 1);
      return { value: null, next: index + 1 };
    }
    if (/^[|>]/.test(plain)) {
      if (raw.includes("\t")) fail();
      if (!/^[|>](?:[1-9][+-]?|[+-][1-9]?)?$/.test(plain)) fail();
      const explicit = plain.match(/[1-9]/);
      let next = index + 1, contentIndent = explicit ? indent + Number(explicit[0]) : null;
      for (; next < lines.length; next += 1) {
        if (!lines[next].trim()) continue;
        const spaces = lines[next].match(/^ */)[0].length;
        if (spaces <= indent) break;
        if (contentIndent === null) contentIndent = spaces;
        if (spaces < contentIndent) fail();
      }
      // Block prose is opaque; brackets/quotes inside it are not YAML tokens.
      return { value: "", next };
    }
    let text = raw;
    for (let next = index + 1; ; next += 1) {
      try { return { value: scalar(text), next }; }
      catch (e) {
        if (e !== incomplete || next >= lines.length) fail();
        text += "\n" + lines[next];
      }
    }
  }
  function block(index, indent, depth) {
    if (depth > 128) fail();
    const sequence = /^-(?:[ \t]|$)/.test(lines[index].slice(indent));
    const result = sequence ? [] : new Map();
    let next = index;
    while (true) {
      const item = entry(next);
      if (!item || item.indent < indent) return { value: result, next: item ? item.index : lines.length };
      if (item.indent !== indent) fail();
      const isList = /^-(?:[ \t]|$)/.test(item.text);
      if (isList !== sequence) fail();
      let parsed;
      if (sequence) {
        if (/^-[ \t]*\t/.test(item.text)) fail();
        const rest = item.text.slice(1).replace(/^[ \t]+/, "");
        if (mapping(rest) || /^-(?:[ \t]|$)/.test(rest)) {
          const original = lines[item.index];
          lines[item.index] = " ".repeat(indent + 2) + rest;
          try { parsed = block(item.index, indent + 2, depth + 1); }
          finally { lines[item.index] = original; }
        } else parsed = readValue(rest, item.index, indent, depth);
        result.push(parsed.value);
      } else {
        const pair = mapping(item.text);
        if (!pair) fail();
        const quotedKey = pair[1].startsWith('"') || pair[1].startsWith("'");
        const key = quotedKey ? scalar(pair[1]) : pair[1].trim();
        if (!quotedKey && !plainKey(key)) fail();
        if (key === "<<" || result.has(key)) fail();
        parsed = readValue(pair[2], item.index, indent, depth);
        result.set(key, parsed.value);
      }
      next = parsed.next;
    }
  }
  const first = entry(0);
  if (!first) return new Map();
  if (first.indent !== 0) fail();
  const parsed = block(first.index, 0, 0);
  if (!(parsed.value instanceof Map) || entry(parsed.next)) fail();
  return parsed.value;
}
function isHubManagedContent(content) {
  if (typeof content !== "string") return false;
  let frontmatter = null;
  if (/^---(?:\r?\n|$)/.test(content)) {
    frontmatter = content.match(/^---\r?\n([\s\S]*?)^---(?:\r?\n|$)/m);
    if (!frontmatter) return false;
    try {
      const fields = parseOwnershipFrontmatter(frontmatter[1]);
      if (fields.has("t3_hub_managed")) return fields.get("t3_hub_managed") === true;
    } catch { return false; }
  }
  // Legacy HTML ownership is valid only as a standalone first line, or
  // the first line immediately following the opening frontmatter block.
  const firstBody = frontmatter ? content.slice(frontmatter[0].length) : content;
  return firstBody.split(/\r?\n/, 1)[0] === HUB_AGENT_HTML_MARKER;
}
function isHubManagedAgentFile(filePath) {
  try { assertNoSymlinkPath(filePath); return isHubManagedContent(fs.readFileSync(filePath, "utf8")); } catch { return false; }
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

const ANTI_SWARM_IRON_LAW = "严禁进入蜂窝(Swarm)或指挥官(Orchestrator)模式，严禁递归派发通用研发子代理。";
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
    systemPrompt: "你作为只读调查子代理（explorer），专注于阅读源码、检索调用链、核查日志与配置证据。严格只读，不修改业务代码；汇报时明确区分“已确认事实”与“待验证假设”。" + ANTI_SWARM_IRON_LAW,
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
    systemPrompt: "你作为研发执行子代理（worker），在划定的文件边界内完成功能实现或缺陷修复，必须编写并运行对应测试确认转绿后再回传精简结论与修改位置。" + ANTI_SWARM_IRON_LAW,
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
    systemPrompt: "你作为通用协助子代理（default），负责资料归纳、需求核对与跨源信息整理，输出结构清晰、结论先行。" + ANTI_SWARM_IRON_LAW,
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
    systemPrompt: "你作为高难攻关子代理（worker-pro），负责解决跨模块复杂契约、并发状态机或疑难根因，先定位根因不变量再做最小可靠修复并完成回归验证。" + ANTI_SWARM_IRON_LAW,
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
    systemPrompt: "你作为前端设计子代理（frontend），负责高品味界面实现、深浅主题适配与响应式布局，交付前必须完成桌面端与窄屏真实渲染核验，确保零溢出。" + ANTI_SWARM_IRON_LAW,
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
    systemPrompt: "你作为测试与核验子代理（qa），负责编写边界/并发回归测试、执行桌面操控（LCU）真实交互验证与发布前检查，严禁直接修改业务源码。" + ANTI_SWARM_IRON_LAW,
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
    effort: "max",
    description: "独立只读代码审查与发布前终审，仅报告高置信度真实缺陷",
    systemPrompt: "你作为独立只读审查子代理（code-review），严格只读审查变更代码与关联上下文，仅报告 confidence >= 80 的逻辑缺陷、安全漏洞、并发风险或回归隐患。" + ANTI_SWARM_IRON_LAW,
    enabled: true,
    builtin: true,
  },
].map((item, index) => ({ ...item,
  memoryPolicy: ["explorer", "code-review"].includes(item.id) ? "readonly" : "readwrite",
  avatarColor: ["teal", "blue", "indigo", "pink", "amber", "cyan", "violet"][index],
}));

// New review tiers are virtual until individually saved. Existing user files
// are never rewritten merely because the software gained another preset.
const REVIEW_TIER_DEFAULTS = [
  { id: "review-fast", name: "review-fast", role: "review", toolBadge: "快速只读审查", providerInstanceId: "muse", model: "muse-ember-1.0", effort: "max", description: "小范围改动快速筛查高置信度问题", systemPrompt: "你负责快速只读审查，重点查找明确的错误、遗漏和异常路径；只报告有证据的真实缺陷。" + ANTI_SWARM_IRON_LAW, enabled: true, builtin: true, memoryPolicy: "readonly", avatarColor: "teal" },
  { id: "review-pro", name: "review-pro", role: "review", toolBadge: "高风险只读终审", providerInstanceId: "codex", model: "gpt-6.1-sol", effort: "max", description: "高风险变更的独立只读终审", systemPrompt: "你负责高风险变更的独立只读终审，重点核对真实风险、并发、权限、隔离与需求覆盖；只报告有证据的真实缺陷。" + ANTI_SWARM_IRON_LAW, enabled: true, builtin: true, memoryPolicy: "readonly", avatarColor: "violet" },
];
function withReviewTierDefaults(items) {
  if (!items.length) return items;
  const ids = new Set(items.map((item) => item.id));
  return [...items, ...REVIEW_TIER_DEFAULTS.filter(item => !ids.has(item.id)).map(item => ({ ...item, suggestedDefault: true }))];
}

const MEMORY_POLICIES = ["readwrite", "readonly", "off"];
const AVATAR_COLORS = ["teal", "blue", "indigo", "pink", "amber", "cyan", "violet"];
function normalizeMemory(item) {
  return { ...item,
    memoryPolicy: MEMORY_POLICIES.includes(item.memoryPolicy) ? item.memoryPolicy : (["explorer", "code-review", "review-fast", "review-pro"].includes(item.id) ? "readonly" : "readwrite"),
    avatarColor: AVATAR_COLORS.includes(item.avatarColor) ? item.avatarColor : ([...DEFAULT_SUBAGENTS, ...REVIEW_TIER_DEFAULTS].find(d => d.id === item.id)?.avatarColor || "teal"),
  };
}
function memoryInstruction(item) {
  const policy = normalizeMemory(item).memoryPolicy;
  if (policy === "readonly") return "第一现场记忆联动：开工先调用 memory_search，只读检索，不调用 memory_write、不写记忆库。";
  if (policy === "off") return "记忆策略 off：本子任务不调用 memory_search 或 memory_write。";
  return "第一现场记忆联动：开工先调用 memory_search 检索项目规则与踩坑；收尾前用 memory_write 记录已验证的非平凡根因或持久约束，不记录猜测、秘密或流水账。";
}
function subagentInstruction(item) {
  return [memoryInstruction(item), "被 delegate_task 派出的子代理不得递归调用 delegate_task、invoke_subagent 或启动原生蜂群；宿主内置生图和 browser 等专用能力除外。", String(item.systemPrompt || "").trim()].filter(Boolean).join("\n");
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

const ORCHESTRATOR_START = "<!-- T3_HUB_ORCHESTRATOR_START -->";
const ORCHESTRATOR_END = "<!-- T3_HUB_ORCHESTRATOR_END -->";
const AGY_MODELS = {
  carbon: { id: "gemini-4-carbon", label: "Orchestrator (Carbon)", badge: "New", desc: "极速敏锐总控主帅 · 低延迟拆单调度与全局把控" },
  argon: { id: "gemini-4-argon", label: "Orchestrator (Argon)", badge: "New", desc: "深谋远虑总控主帅 · 超复杂跨模块架构推演与防漏决策" },
};
function normalizeOrchestrationConfig(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  let orchestratorMode = String(src.orchestratorMode ?? "off").toLowerCase();
  if (!["off","carbon","argon"].includes(orchestratorMode)) orchestratorMode = "off";
  let swarmMode = String(src.swarmMode ?? "auto").toLowerCase();
  if (!["auto","on","off"].includes(swarmMode)) swarmMode = "auto";
  let maxParallelAgents = src.maxParallelAgents != null ? Number(src.maxParallelAgents) : 6;
  if (!Number.isInteger(maxParallelAgents) || maxParallelAgents < 1 || maxParallelAgents > 20) {
    if (Number.isFinite(maxParallelAgents)) maxParallelAgents = Math.max(1, Math.min(20, Math.floor(maxParallelAgents)));
    else maxParallelAgents = 6;
  }
  let autoWorktreeIsolation = typeof src.autoWorktreeIsolation === "boolean" ? src.autoWorktreeIsolation : true;
  let strictCommanderOnly = src.strictCommanderOnly;
  if (strictCommanderOnly == null) {
    strictCommanderOnly = (orchestratorMode !== "off" || swarmMode === "on");
  } else {
    strictCommanderOnly = Boolean(strictCommanderOnly);
  }
  // If active modes but strict not set, enforce true (spec default auto true)
  // If explicitly toggling off, keep as set.
  const agyModels = src.agyModels && typeof src.agyModels === "object" ? { ...AGY_MODELS, ...src.agyModels } : { ...AGY_MODELS };
  // Ensure cloned
  agyModels.carbon = { ...AGY_MODELS.carbon, ...(agyModels.carbon || {}) };
  agyModels.argon = { ...AGY_MODELS.argon, ...(agyModels.argon || {}) };
  return { policyVersion: src.policyVersion === 2 ? 2 : 0, orchestratorMode, swarmMode, strictCommanderOnly: Boolean(strictCommanderOnly), maxParallelAgents, autoWorktreeIsolation: Boolean(autoWorktreeIsolation), agyModels };
}
const SUBAGENT_STOP_HEADER = `<SUBAGENT-STOP>
[T3_TOP_LEVEL_MAIN_SESSION_ONLY]
本蜂窝（Swarm）/ 指挥官（Orchestrator）规则仅对 T3 Code 用户直接对话的顶层主会话（parentThreadId == null）生效！
一旦当前上下文是被 delegate_task 派发的子智能体（提示词含 Act as the ... sub-agent、relationshipToParent === "subagent"、环境变量含 T3_SUBAGENT_ROLE，或当前扮演 explorer/worker/default/worker-pro/frontend/qa/code-review 任一子角色），下方所有指挥官与蜂窝规则立即 100% 失效，严禁再次调用 delegate_task 裂变子代理或把自己变成蜂窝，必须亲自完成交办任务！严禁进入蜂窝(Swarm)或指挥官(Orchestrator)模式，严禁递归派发通用研发子代理。
</SUBAGENT-STOP>`;
function buildOrchestrationDirective(cfg) {
  const c = normalizeOrchestrationConfig(cfg);
  const lines = [];
  lines.push(ORCHESTRATOR_START);
  lines.push("适用范围：仅 T3 Code 用户直接对话的顶层会话。独立 Codex、Claude、AGY 等非 T3 宿主忽略本块，不改变其原有分工；T3 子代理不得递归派单。");
  lines.push(SUBAGENT_STOP_HEADER);
  lines.push("被 delegate_task 派出的子代理不得再调用 delegate_task、invoke_subagent 或启动宿主原生蜂群；宿主内置生图和 browser 等专用能力除外。");
  lines.push("## T3 Hub 统一协作分工");
  lines.push("");
  if (c.swarmMode === "on") {
    lines.push("当前模式：T3 蜂群总指挥。主会话默认负责决策、拆解、派单、协调与验收，调查、编码和测试交由合适的子代理完成；这不是调用宿主原生蜂群命令。");
    lines.push("对同一实现问题，worker（L1）连续两次仍未解决时升级 worker-pro（L2）；L2 连续两次仍未解决时，由主会话亲自兜底。不要求无关子代理重复尝试。");
    lines.push("用户明确要求主会话亲做时遵照用户要求；T3 中 delegate_task 不可用是能力缺口，应说明实际阻点，不得假称子代理已尝试失败；独立非 T3 宿主不因缺少该工具而报错。");
  } else {
    lines.push("当前模式：常规协作。小任务、短任务可由主会话直接完成；较长或复杂任务按需要分工，独立工作可并行。");
    lines.push("对同一实现问题，worker（L1）连续两次仍未解决时可升级 worker-pro（L2）；L2 连续两次仍未解决时由主会话兜底。");
    lines.push("在 T3 中需要派单而 delegate_task 不可用时说明工具缺口，不得假称已经派单；独立非 T3 宿主不因缺少该工具而报错。");
  }
  lines.push("需要分工的多步任务应使用宿主实际提供的 update_plan、plan_update 等计划工具维护本会话 Plan，完成步骤时更新状态并保留已完成项供查看；没有计划工具时使用宿主支持的原生 Plan 产物，不伪造工具调用。");
  lines.push("各角色的模型、思考强度与提示词从 Hub 路由配置读取；本块仅提供协作指引，不自动切换主会话模型，也不绕过宿主权限或更高优先级规则。");
  lines.push("选择等级时在 title 或 clientRequestId 中写明确角色 ID：执行用 worker / worker-pro，审查用 review-fast / code-review / review-pro；role 仍分别使用 implementation 或 review。未指定等级时 review 默认 code-review、implementation 默认 worker。");
  lines.push("");
  lines.push(ORCHESTRATOR_END);
  return lines.join("\n") + "\n";
}
function buildSlashCommandPrompt(mode) {
  const m = String(mode || "").toLowerCase();
  const header = SUBAGENT_STOP_HEADER + "\n";
  if (["swarm", "/swarm", "carbon", "orchestrator-carbon", "[orchestrator carbon 纯主帅模式]", "argon", "orchestrator-argon", "[orchestrator argon 纯主帅模式]", "plan", "/plan"].includes(m)) return header + "遵守当前宿主与项目的统一协作规则，按已配置角色分工；独立任务可按需并行。极小修改或子代理连续两次未解决时，主会话可直接处理。";
  return header + String(mode || "");
}

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
    let raw;
    try { raw = JSON.parse(fs.readFileSync(globalPath, "utf8")); }
    catch { throw new Error("全局子代理路由配置无法读取或解析，原文件未改动"); }
    if (Array.isArray(raw)) {
      // Normalize to ensure id/name alignment.
      const norm = raw.map((it) => {
        if (!it || typeof it !== "object") return null;
        const id = it.id || it.name;
        if (!id) return null;
        return { ...it, id: String(id), name: String(it.name || id), builtin: Boolean(it.builtin), enabled: it.enabled !== false };
      }).filter(Boolean);
      if (norm.length !== raw.length) throw new Error("全局子代理路由配置包含无效项目，原文件未改动");
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
        if (norm.length !== arr.length) throw new Error("全局子代理路由配置包含无效项目，原文件未改动");
        return norm.map(normalizeMemory);
      }
    }
    throw new Error("全局子代理路由配置格式无效，原文件未改动");
  }
  function writeGlobal(items) {
    writeJsonFileAtomic(globalPath, items);
  }
  function projectPathFor(projectRoot) {
    if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)) throw new Error("projectRoot must be an absolute path");
    let canonical = path.resolve(projectRoot);
    const suffix = [];
    while (true) {
      try { canonical = path.join(fs.realpathSync(canonical), ...suffix); break; }
      catch (e) {
        if (e.code !== "ENOENT") throw e;
        const parent = path.dirname(canonical);
        if (parent === canonical) throw e;
        suffix.unshift(path.basename(canonical)); canonical = parent;
      }
    }
    const hash = crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 20);
    const p = path.join(projectDir, slugFromProjectRoot(canonical) + "-" + hash + ".json");
    assertContained(projectDir, p);
    return p;
  }
  function readProject(projectRoot) {
    if (!projectRoot) return [];
    const p = projectPathFor(projectRoot);
    if (!fileExists(p)) return [];
    let raw;
    try { raw = JSON.parse(fs.readFileSync(p, "utf8")); }
    catch { throw new Error("项目子代理路由配置无法读取或解析，原文件未改动"); }
    if (Array.isArray(raw)) {
      const items = raw.map((it) => {
        if (!it || typeof it !== "object") return null;
        const id = it.id || it.name;
        if (!id) return null;
        return { ...it, id: String(id), name: String(it.name || id), enabled: it.enabled !== false, overridesGlobal: it.overridesGlobal !== false };
      }).filter(Boolean);
      if (items.length !== raw.length) throw new Error("项目子代理路由配置包含无效项目，原文件未改动");
      return items;
    }
    if (raw && typeof raw === "object" && Array.isArray(raw.items)) {
      const items = configItems(raw, false).map(it => ({ ...it, enabled: it.enabled !== false, overridesGlobal: it.overridesGlobal !== false }));
      if (items.length !== raw.items.length) throw new Error("项目子代理路由配置包含无效项目，原文件未改动");
      return items;
    }
    throw new Error("项目子代理路由配置格式无效，原文件未改动");
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
    if (["review-fast", "review-pro"].includes(id) && role !== "review") throw new Error("审查等级必须使用 review 通道");
    if (role && !VALID_ROLES.includes(role)) {
      // Allow but warn? Strict: reject unknown role to catch typos.
      throw new Error("invalid role: " + role);
    }
    if (!MEMORY_POLICIES.includes(item.memoryPolicy)) throw new Error("invalid memoryPolicy");
    if (!AVATAR_COLORS.includes(item.avatarColor)) throw new Error("invalid avatarColor");
    if (item.systemPrompt != null && typeof item.systemPrompt !== "string") throw new Error("systemPrompt must be string");
    if (subagentInstruction(item).length + "<!-- t3-hub-subagent-prompt:start -->".length + "<!-- t3-hub-subagent-prompt:end -->".length + 4 >= 120000) throw new Error("角色提示词过长，无法保留派单任务空间");
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

  const orchestrationConfigPath = () => path.join(hubDir, "orchestration-config.json");
  const activeOrchestrationPath = () => path.join(hubDir, "ACTIVE_ORCHESTRATION_MODE.md");
  const defaultOrchestrationHosts = () => [
    path.join(homeDir, ".codex", "AGENTS.md"), path.join(homeDir, ".pi", "agent", "AGENTS.md"),
    path.join(homeDir, ".config", "muse", "AGENTS.md"), path.join(homeDir, ".claude", "CLAUDE.md"),
    path.join(hubDir, "global-AGENTS.md"),
  ];
  function inspectOrchestrationTargets(args = {}) {
    const hosts = Array.isArray(args.hosts) ? args.hosts : [...defaultOrchestrationHosts(), ...(Array.isArray(args.additionalHosts) ? args.additionalHosts : [])];
    const items = [];
    for (const file of new Set(hosts)) {
      if (typeof file !== "string" || !path.isAbsolute(file)) continue;
      try {
        assertNoSymlinkPath(file);
        const st = lstatSafe(file);
        if (!st) continue;
        if (!st.isFile() || !(st.mode & 0o444) || st.size > 2 * 1024 * 1024) { items.push({ path: file, state: "unknown" }); continue; }
        const text = fs.readFileSync(file, "utf8"), s = text.indexOf(ORCHESTRATOR_START), e = text.indexOf(ORCHESTRATOR_END);
        if (s < 0 && e < 0 && !text.includes(SUBAGENT_STOP_HEADER)) continue;
        if (s < 0 || e < s || text.indexOf(ORCHESTRATOR_START, s + 1) >= 0 || text.indexOf(ORCHESTRATOR_END, e + 1) >= 0) items.push({ path: file, state: "unknown" });
        else items.push({ path: file, state: "present" });
      } catch { items.push({ path: file, state: "unknown" }); }
    }
    return { state: items.some(item => item.state === "present") ? "present" : items.length ? "unknown" : "clear", items };
  }
  function readOrchestrationSnapshot() {
    const pfile = orchestrationConfigPath();
    assertNoSymlinkPath(pfile);
    const st = lstatSafe(pfile);
    if (!st) {
      return { config: normalizeOrchestrationConfig(null), raw: "", revision: "missing" };
    }
    if (!st.isFile() || !(st.mode & 0o444)) throw new Error("编排配置不是可读文件，原文件未改动");
    let raw, parsed;
    try { raw = fs.readFileSync(pfile, "utf8"); parsed = JSON.parse(raw); } catch { throw new Error("编排配置无法读取，原文件未改动"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("编排配置损坏，原文件未改动");
    if (parsed.policyVersion === 2 && (!["on", "off"].includes(parsed.swarmMode) || parsed.orchestratorMode !== "off")) throw new Error("统一协作模式配置无效，原文件未改动");
    return { config: normalizeOrchestrationConfig(parsed), raw, revision: crypto.createHash("sha256").update(raw).digest("hex") };
  }
  function getOrchestrationConfig() { return readOrchestrationSnapshot().config; }
  function getOrchestrationState(args = {}) {
    const snapshot = readOrchestrationSnapshot(), cfg = snapshot.config;
    const hosts = Array.isArray(args.hosts) ? args.hosts : [...defaultOrchestrationHosts(), ...(Array.isArray(args.additionalHosts) ? args.additionalHosts : [])];
    const directive = cfg.policyVersion === 2 ? buildOrchestrationDirective(cfg).trimEnd() : null;
    const hostResults = [];
    for (const file of new Set(hosts)) {
      if (typeof file !== "string" || !path.isAbsolute(file)) continue;
      try {
        assertNoSymlinkPath(file);
        const st = lstatSafe(file);
        if (!st && !Array.isArray(args.hosts) && !dirExists(path.dirname(file))) continue;
        if (!st) { hostResults.push({ path: file, state: "missing" }); continue; }
        if (!st.isFile() || !(st.mode & 0o444) || st.size > 2 * 1024 * 1024) { hostResults.push({ path: file, state: "unknown" }); continue; }
        const text = fs.readFileSync(file, "utf8"), s = text.indexOf(ORCHESTRATOR_START), e = text.indexOf(ORCHESTRATOR_END);
        if (s < 0 && e < 0) { hostResults.push({ path: file, state: text.includes(SUBAGENT_STOP_HEADER) ? "unknown" : "missing" }); continue; }
        if (s < 0 || e < s || text.indexOf(ORCHESTRATOR_START, s + 1) >= 0 || text.indexOf(ORCHESTRATOR_END, e + 1) >= 0) { hostResults.push({ path: file, state: "unknown" }); continue; }
        const block = text.slice(s, e + ORCHESTRATOR_END.length);
        hostResults.push({ path: file, state: directive && block === directive ? "applied" : "different" });
      } catch { hostResults.push({ path: file, state: "unknown" }); }
    }
    return { ...cfg, modeRevision: snapshot.revision, hostResults, modeApplied: cfg.policyVersion === 2 && hostResults.length > 0 && hostResults.every(item => item.state === "applied"), legacyStatus: inspectOrchestrationTargets(args) };
  }
  function composeOrchestratorBlock(existing, directive) {
      const sIdx = existing.indexOf(ORCHESTRATOR_START);
      const eIdx = existing.indexOf(ORCHESTRATOR_END);
      if ((sIdx === -1) !== (eIdx === -1) || (sIdx !== -1 && (eIdx < sIdx || existing.indexOf(ORCHESTRATOR_START, sIdx + 1) !== -1 || existing.indexOf(ORCHESTRATOR_END, eIdx + 1) !== -1))) throw new Error("orchestration markers are incomplete or duplicated");
      if (sIdx === -1) {
        if (existing.includes(SUBAGENT_STOP_HEADER)) throw new Error("发现没有边界标记的旧提示，请先手动检查");
        return directive ? existing + (existing && !existing.endsWith("\n") ? "\n" : "") + (existing ? "\n" : "") + directive : null;
      }
      let before = existing.slice(0, sIdx);
      // Older releases put our exact STOP header outside the managed markers.
      // Remove only copies immediately adjacent to our own block.
      while (before.endsWith(SUBAGENT_STOP_HEADER + "\n")) before = before.slice(0, -(SUBAGENT_STOP_HEADER.length + 1));
      let after = existing.slice(eIdx + ORCHESTRATOR_END.length);
      if (after.startsWith("\r\n")) after = after.slice(2);
      else if (after.startsWith("\n")) after = after.slice(1);
      const next = before + (directive || "") + after;
      return next === existing ? null : next;
  }
  function writeOrchestratorBlock(filePath, directive, expected) {
    return transformTextFileAtomic(filePath, (existing) => {
      if (expected && (Boolean(lstatSafe(filePath)) === expected.missing || existing !== expected.text)) throw new Error("规则文件已变更，请重新读取");
      return composeOrchestratorBlock(existing, directive);
    }, { backup: Boolean(directive), createIfMissing: Boolean(directive) });
  }
  function isSubagentPolicyTarget(p) {
    const norm = p.replace(/\\/g, "/");
    return norm.includes("/.claude/agents/") || norm.endsWith("/.claude/agents") || /\/subagents(\/|$)/.test(norm);
  }
  function policySnapshot(file) {
    assertNoSymlinkPath(file);
    const snap = readRegularSnapshot(file);
    if (snap.missing) return { missing: true, text: "" };
    if (snap.unsafe || !snap.raw || !Buffer.from(snap.text, "utf8").equals(snap.raw)) throw new Error("规则文件不可安全读取: " + file);
    const st = lstatSafe(file);
    if (!st || !(st.mode & 0o444)) throw new Error("规则文件不可读取: " + file);
    return { missing: false, text: snap.text, ino: snap.ino };
  }
  function policyTargets(syncArgs) {
    const explicit = Array.isArray(syncArgs.hosts) ? syncArgs.hosts : [];
    const paths = [];
    if (explicit.length) {
      for (const item of explicit) if (typeof item === "string") paths.push(path.resolve(item));
    } else {
      for (const file of defaultOrchestrationHosts()) {
        try { if (fileExists(file) || dirExists(path.dirname(file))) paths.push(file); }
        catch { paths.push(file); }
      }
    }
    for (const file of Array.isArray(syncArgs.additionalHosts) ? syncArgs.additionalHosts : []) if (typeof file === "string" && path.isAbsolute(file)) paths.push(file);
    return [...new Set(paths)];
  }
  function recordPolicyWrite(args, file, result) {
    if (!args.journal || !result?.changed) return;
    let after;
    try { after = policySnapshot(file); }
    catch (e) {
      // Publication already succeeded, so a readback failure is an unknown
      // state, not evidence that there is nothing to restore.
      args.journalConflicts.push({ path: file, error: "写入后无法核实文件状态，需手动检查: " + String(e?.message || e) });
      throw e;
    }
    const before = args.expectedSnapshots.get(file);
    const intended = args.expectedContents?.get(file);
    if (after.missing || after.ino !== result.ino || typeof intended !== "string" || after.text !== intended) {
      args.journalConflicts.push({ path: file, error: "写入后文件被其他操作修改，已保留当前内容，请检查" });
      throw new Error("写入后文件被其他操作修改");
    }
    args.journal.push({ path: file, before, after: after.text, ino: after.ino });
  }
  function rollbackCreatedPolicyFile(entry) {
    const file = entry.path, lockPath = file + ".t3hub.lock";
    acquireT3HubLock(lockPath);
    let stageDir = null, staged = null, fd = null;
    try {
      const current = policySnapshot(file);
      if (current.missing || current.ino !== entry.ino || current.text !== entry.after) throw new Error("文件已被其他操作修改");
      stageDir = fs.mkdtempSync(file + ".rollback-"); staged = path.join(stageDir, "owned");
      fs.renameSync(file, staged);
      try {
        fd = fs.openSync(staged, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const snap = readUtf8FromFdAtZero(fd);
        if (snap.st.ino !== entry.ino || snap.raw === null || snap.text !== entry.after) throw new Error("文件在回滚中被修改");
      } catch (e) {
        const rescue = restoreStagedFile(staged, file);
        if (rescue.preservedPath) e.preservedPath = rescue.preservedPath;
        throw e;
      }
      const retired = retireStagedFile(staged, file, path.join(hubDir, "retired-agents"));
      const post = readUtf8FromFdAtZero(fd);
      if (post.raw === null || post.text !== entry.after) {
        const rescue = restoreStagedFile(retired.retiredPath, file);
        const e = new Error("文件在回滚中被修改"); if (rescue.preservedPath) e.preservedPath = rescue.preservedPath; throw e;
      }
    } finally {
      try { if (fd !== null) fs.closeSync(fd); } catch {}
      try { if (stageDir) fs.rmdirSync(stageDir); } catch {}
      releaseT3HubLock(lockPath);
    }
  }
  function rollbackPolicyWrites(journal) {
    const failures = [];
    for (const entry of [...journal].reverse()) {
      try {
        if (entry.before.missing) rollbackCreatedPolicyFile(entry);
        else {
          const now = policySnapshot(entry.path);
          if (now.missing || now.ino !== entry.ino || now.text !== entry.after) throw new Error("文件已被其他操作修改");
          const restored = transformTextFileAtomic(entry.path, (existing) => {
            const st = lstatSafe(entry.path);
            if (!st || st.ino !== entry.ino || existing !== entry.after) throw new Error("文件已被其他操作修改");
            return entry.before.text;
          }, { createIfMissing: false });
          if (!restored.changed && entry.before.text !== entry.after) throw new Error("文件已被其他操作删除");
        }
      } catch (e) { failures.push({ path: entry.path, error: String(e?.message || e), ...(e?.preservedPath ? { preservedPath: e.preservedPath } : {}) }); }
    }
    return failures;
  }
  function syncOrchestrationDirectiveToHostsRaw(args = {}) {
    const cfg = args.configOverride ? normalizeOrchestrationConfig(args.configOverride) : getOrchestrationConfig();
    if (cfg.policyVersion !== 2 || cfg.orchestratorMode !== "off" || !["on", "off"].includes(cfg.swarmMode)) throw new Error("旧编排指引已退役，请先明确选择统一协作模式");
    const active = cfg.swarmMode === "on";
    const directive = buildOrchestrationDirective(cfg);
    // Always update hub managed file ACTIVE_ORCHESTRATION_MODE.md
    const results = [];
    try {
      safeMkdir(path.dirname(activeOrchestrationPath()));
      const content = "# T3 Hub 协作分工\n\n" + directive;
      const activePath = activeOrchestrationPath(), expected = args.expectedSnapshots?.get(activePath);
      if (args.expectedSnapshots && !expected) throw new Error("缺少事务快照");
      const changed = transformTextFileAtomic(activePath, (existing) => {
        if (expected && (Boolean(lstatSafe(activePath)) === expected.missing || existing !== expected.text)) throw new Error("规则文件已变更，请重新读取");
        return content;
      }, { createIfMissing: true });
      recordPolicyWrite(args, activePath, changed);
    } catch (e) { results.push({ path: activeOrchestrationPath(), ok: false, error: String(e?.message || e) }); }
    // Hosts: allow args.hosts or args.hostRulePaths or args.extraSyncPaths
    let hosts = null;
    if (Array.isArray(args.hosts)) hosts = args.hosts;
    else if (Array.isArray(args.hostRulePaths)) hosts = args.hostRulePaths;
    else if (Array.isArray(args.extraSyncPaths)) hosts = args.extraSyncPaths;
    else if (Array.isArray(args.host)) hosts = args.host;
    else hosts = [];
    const seen = new Set();
    const isSubagentDir = (p) => {
      const norm = p.replace(/\\/g, "/");
      if (norm.includes("/.claude/agents/") || norm.endsWith("/.claude/agents")) return true;
      if (norm.includes("/hub/subagents") || norm.includes("/.t3/hub/subagents")) return true;
      // 通用：任何 agents/ 或 subagents/ 目录均拒绝
      if (/\/\.claude\/agents(\/|$)/.test(norm)) return true;
      if (/\/subagents(\/|$)/.test(norm)) return true;
      if (/\/agents\/[^\/]+\.md$/.test(norm) && norm.includes(".claude")) return true;
      return false;
    };
    const applyToHost = (fp) => {
      if (seen.has(fp)) return;
      seen.add(fp);
      if (isSubagentDir(fp)) { results.push({ path: fp, ok: false, error: "子代理规则目录不接受总控指引" }); return; }
      if (args.journal && results.some(item => !item.ok)) { results.push({ path: fp, ok: false, error: "前一文件失败，本文件未写入" }); return; }
      try {
        const expected = args.expectedSnapshots?.get(fp);
        if (args.expectedSnapshots && !expected) throw new Error("缺少事务快照");
        const changed = writeOrchestratorBlock(fp, directive, expected);
        recordPolicyWrite(args, fp, changed);
        results.push({ path: fp, ok: true, changed: Boolean(changed?.changed) });
      } catch (e) { results.push({ path: fp, ok: false, error: String(e?.message || e) }); }
    };
    for (const h of hosts) {
      if (typeof h !== "string") continue;
      const fp = path.isAbsolute(h) ? h : path.resolve(String(h));
      applyToHost(fp);
    }
    // If no explicit hosts provided, sync to default CLI global files inside homeDir/hubDir if they exist or hub dir already exists, but only when not isolating via test hostRulePaths.
    // To avoid polluting real HOME in unit tests, we only sync defaults when hosts length ===0 and no isolated flag? Tests that pass hostRulePaths will have hosts non-empty, so this branch not taken.
    // When hosts empty (production update via updateOrchestrationConfig without explicit hosts), sync to default CLI targets if they exist or are already present in tmp home/hub.
    if (hosts.length === 0) {
      const defaults = defaultOrchestrationHosts();
      for (const t of defaults) {
        // Only sync if file already exists or parent dir exists (avoid stray creation)
        try { if (fileExists(t) || dirExists(path.dirname(t))) applyToHost(t); }
        catch (e) { results.push({ path: t, ok: false, error: String(e?.message || e) }); }
      }
    }
    for (const fp of Array.isArray(args.additionalHosts) ? args.additionalHosts : []) {
      if (typeof fp === "string" && path.isAbsolute(fp)) applyToHost(fp);
    }
    return { ok: results.every((item) => item.ok), config: cfg, active, directive, hostResults: results };
  }
  function updateOrchestrationConfig(patch = {}, opts = {}) {
    const pfile = orchestrationConfigPath();
    const transactionLock = path.join(hubDir, ".orchestration-mode.lock");
    acquireT3HubLock(transactionLock);
    try {
    const snapshot = readOrchestrationSnapshot(), current = snapshot.config;
    if (typeof patch.expectedRevision !== "string" || patch.expectedRevision !== snapshot.revision) throw new Error("协作模式已变更，请重新读取后再保存");
    if (!["on", "off"].includes(patch.swarmMode) || patch.orchestratorMode && patch.orchestratorMode !== "off") throw new Error("请选择常规协作或总指挥模式");
    const merged = { ...current, ...(patch || {}) };
    // Remove hostRulePaths/hosts from merged before persisting
    const hostRulePaths = opts.hostRulePaths || opts.hosts || opts.extraSyncPaths || merged.hostRulePaths || merged.hosts || null;
    delete merged.hostRulePaths;
    delete merged.hosts;
    delete merged.host;
    delete merged.expectedRevision;
    merged.policyVersion = 2;
    merged.orchestratorMode = "off";
    merged.strictCommanderOnly = merged.swarmMode === "on";
    // Also remove nested hostRulePaths key if present
    const normalized = normalizeOrchestrationConfig(merged);
    // Sync respecting explicit hosts; do not pollute defaults if hostRulePaths were provided
    const syncArgs = {};
    syncArgs.configOverride = normalized;
    if (Array.isArray(opts.additionalHosts)) syncArgs.additionalHosts = opts.additionalHosts;
    if (Array.isArray(hostRulePaths)) syncArgs.hosts = hostRulePaths;
    else if (Array.isArray(patch?.hostRulePaths)) syncArgs.hosts = patch.hostRulePaths;
    else if (Array.isArray(opts.hosts)) syncArgs.hosts = opts.hosts;
    const directive = buildOrchestrationDirective(normalized), paths = policyTargets(syncArgs), snapshots = new Map(), expectedContents = new Map(), journal = [], journalConflicts = [];
    let preflightPath = null;
    try {
      for (const file of paths) {
        preflightPath = file;
        if (file === pfile || file === activeOrchestrationPath() || isSubagentPolicyTarget(file)) throw new Error("不允许将此文件作为宿主规则目标: " + file);
        const before = policySnapshot(file);
        const planned = composeOrchestratorBlock(before.text, directive); // validate all markers before the first write
        expectedContents.set(file, planned === null ? before.text : planned);
        snapshots.set(file, before);
      }
      preflightPath = activeOrchestrationPath();
      snapshots.set(activeOrchestrationPath(), policySnapshot(activeOrchestrationPath()));
      expectedContents.set(activeOrchestrationPath(), "# T3 Hub 协作分工\n\n" + directive);
      if (readOrchestrationSnapshot().revision !== snapshot.revision) throw new Error("协作模式已变更，请重新读取后再保存");
    } catch (e) {
      return { ok: false, error: String(e?.message || e), config: current, desiredConfig: normalized, hostResults: preflightPath ? [{ path: preflightPath, ok: false, error: String(e?.message || e) }] : [], rolledBack: true, rollbackFailures: [] };
    }
    syncArgs.expectedSnapshots = snapshots; syncArgs.expectedContents = expectedContents; syncArgs.journal = journal; syncArgs.journalConflicts = journalConflicts;
    let syncResult = null;
    try {
      syncResult = syncOrchestrationDirectiveToHostsRaw(syncArgs);
      if (!syncResult.ok) throw new Error("部分宿主规则同步失败");
      transformTextFileAtomic(pfile, (existing) => {
        const revision = lstatSafe(pfile) ? crypto.createHash("sha256").update(existing).digest("hex") : "missing";
        if (revision !== snapshot.revision) throw new Error("协作模式已变更，请重新读取后再保存");
        return JSON.stringify(normalized, null, 2) + "\n";
      }, { createIfMissing: true, defaultMode: 0o600 });
      return { ...syncResult, config: normalized };
    } catch (e) {
      const rollbackFailures = [...journalConflicts, ...rollbackPolicyWrites(journal)];
      return { ok: false, error: rollbackFailures.length ? "同步失败，部分文件未能自动恢复，请检查标出的文件" : String(e?.message || e), config: current, desiredConfig: normalized, hostResults: syncResult?.hostResults || [], rolledBack: rollbackFailures.length === 0, rollbackFailures };
    }
    } finally { releaseT3HubLock(transactionLock); }
  }
  function syncOrchestrationDirectiveToHosts(args = {}) {
    const state = getOrchestrationState();
    if (state.policyVersion !== 2) throw new Error("旧编排指引已退役，请先明确选择统一协作模式");
    const hosts = args.hosts || args.hostRulePaths || args.extraSyncPaths || args.host;
    return updateOrchestrationConfig({ swarmMode: state.swarmMode, expectedRevision: state.modeRevision }, { ...(Array.isArray(hosts) ? { hostRulePaths: hosts } : {}), ...(Array.isArray(args.additionalHosts) ? { additionalHosts: args.additionalHosts } : {}) });
  }

  function renderBlock(items, isProject) {
    const enabled = items.filter((i) => i.enabled !== false).slice().sort((a, b) => a.id.localeCompare(b.id));
    const start = isProject ? PROJECT_START : GLOBAL_START;
    const end = isProject ? PROJECT_END : GLOBAL_END;
    const lines = [];
    lines.push(start);
    lines.push("## 子智能体路由与系统提示词 (T3 Hub Sub-Agents)" + (isProject ? " · 项目" : " · 全局"));
    lines.push("派发任何子智能体前，若会话较长或用户刚调整过配置，优先以 ~/.t3/hub/subagents.json（及项目覆盖配置）中的实时模型与思考强度为准；可调用 resolveSubagentRoute 查询，PreToolUse 路由守卫会在派单时重新读取磁盘。");
    lines.push("选择等级时在 title 或 clientRequestId 中写明确 ID：执行用 worker / worker-pro，审查用 review-fast / code-review / review-pro；role 仍使用 T3 原生 implementation 或 review。未指定等级时分别默认 worker 与 code-review。");
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
    assertNoSymlinkPath(file);
    const bak = file + ".bak-t3hub";
    assertNoSymlinkPath(bak);
    const bakStat = lstatSafe(bak);
    if (bakStat) {
      if (!bakStat.isFile()) throw new Error("unsafe non-regular backup file: " + bak);
      return;
    }
    if (lstatSafe(file)) {
      try {
        fs.copyFileSync(file, bak, fs.constants.COPYFILE_EXCL);
      } catch (e) {
        if (e && e.code === "EEXIST") {
          const st2 = lstatSafe(bak);
          if (!st2 || !st2.isFile()) throw new Error("unsafe non-regular backup file: " + bak);
          return;
        }
        if (e && e.code === "ENOENT") return;
        throw e;
      }
    }
  }

  function transformTextFileAtomic(filePath, transformFn, tOpts = {}) {
    const createIfMissing = tOpts.createIfMissing !== false;
    const doBackup = Boolean(tOpts.backup);
    const retiredDir = path.join(hubDir, "retired-agents");
    assertNoSymlinkPath(filePath);
    if (createIfMissing) safeMkdir(path.dirname(filePath));
    else if (!dirExists(path.dirname(filePath))) return { changed: false };
    const lockPath = filePath + ".t3hub.lock";
    for (let attempt = 0; attempt < 8; attempt += 1) {
      acquireT3HubLock(lockPath);
      try {
        assertNoSymlinkPath(filePath);
        const st = lstatSafe(filePath);
        if (!st) {
          if (!createIfMissing) return { changed: false };
          const next = transformFn("");
          if (next === null || next === "") return { changed: false };
          const tmp = filePath + ".tmp-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(16).slice(2);
          let fd = null;
          let ownsTmp = false;
          let publishedIno = null;
          try {
            fd = fs.openSync(tmp, "wx", 0o600);
            ownsTmp = true;
            fs.writeSync(fd, next, 0, "utf8");
            try { fs.fsyncSync(fd); } catch {}
            try { fs.fchmodSync(fd, typeof tOpts.defaultMode === "number" ? tOpts.defaultMode : 0o644); } catch {}
            publishedIno = fs.fstatSync(fd).ino;
            fs.closeSync(fd);
            fd = null;
            assertNoSymlinkPath(filePath);
            fs.linkSync(tmp, filePath);
            try { fs.unlinkSync(tmp); ownsTmp = false; } catch {}
          } catch (e) {
            try { if (fd !== null) fs.closeSync(fd); } catch {}
            try { if (ownsTmp) fs.unlinkSync(tmp); } catch {}
            if (e && e.code === "EEXIST") continue;
            throw e;
          }
          const post = lstatSafe(filePath);
          if (!post || !post.isFile() || post.ino !== publishedIno) continue;
          return { changed: true, ino: publishedIno };
        }
        if (!st.isFile()) throw new Error("unsafe non-regular file: " + filePath);
        if (st.nlink !== 1) throw new Error("refusing to clobber multi-linked file: " + filePath);
        let rawPre = null;
        let origMode = st.mode & 0o777;
        let rfd = null;
        try {
          rfd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
          const snapPre = readUtf8FromFdAtZero(rfd);
          if (!snapPre.st.isFile() || snapPre.st.ino !== st.ino || snapPre.st.nlink !== 1 || snapPre.raw === null) {
            continue;
          }
          origMode = snapPre.st.mode & 0o777;
          rawPre = snapPre.raw;
        } catch (e) {
          if (e && e.code === "ENOENT") continue;
          throw e;
        } finally {
          try { if (rfd !== null) fs.closeSync(rfd); } catch {}
        }
        if (doBackup) backupOnce(filePath);
        const existing = rawPre.toString("utf8");
        const next = transformFn(existing);
        if (next === null || next === existing) return { changed: false };
        const stageDir = fs.mkdtempSync(filePath + ".stage-");
        const tmp = path.join(stageDir, "new");
        const staged = path.join(stageDir, "old");
        let fd = null;
        let stagedFd = null;
        let ownsTmp = false;
        let publishedIno = null;
        let retryCas = false;
        try {
          fd = fs.openSync(tmp, "wx", 0o600);
          ownsTmp = true;
          fs.writeSync(fd, next, 0, "utf8");
          try { fs.fsyncSync(fd); } catch {}
          try { fs.fchmodSync(fd, origMode); } catch {}
          publishedIno = fs.fstatSync(fd).ino;
          fs.closeSync(fd);
          fd = null;
          assertNoSymlinkPath(filePath);
          try { fs.renameSync(filePath, staged); }
          catch (e) {
            if (e && e.code === "ENOENT") { retryCas = true; }
            else throw e;
          }
          if (!retryCas) {
            let snapStaged = null;
            try {
              stagedFd = fs.openSync(staged, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
              snapStaged = readUtf8FromFdAtZero(stagedFd);
            } catch (e) {
              try { if (stagedFd !== null) fs.closeSync(stagedFd); } catch {}
              stagedFd = null;
              const recovery = restoreStagedFile(staged, filePath);
              if (recovery && recovery.preservedPath) e.preservedPath = recovery.preservedPath;
              throw e;
            }
            if (!snapStaged.st.isFile() || snapStaged.st.ino !== st.ino || snapStaged.st.nlink !== 1 || snapStaged.raw === null || Buffer.compare(snapStaged.raw, rawPre) !== 0) {
              fs.closeSync(stagedFd);
              stagedFd = null;
              const recovery = restoreStagedFile(staged, filePath);
              if (recovery && recovery.preservedPath) {
                const err = new Error("concurrent modification conflict updating: " + filePath + " (preserved at " + recovery.preservedPath + ")");
                err.preservedPath = recovery.preservedPath;
                throw err;
              }
              retryCas = true;
            } else {
              try {
                assertNoSymlinkPath(filePath);
                fs.linkSync(tmp, filePath);
                try { fs.unlinkSync(tmp); ownsTmp = false; } catch {}
              } catch (e) {
                if (e && e.code === "EEXIST") {
                  let eexistSnap = null;
                  let eexistErr = null;
                  try { eexistSnap = readUtf8FromFdAtZero(stagedFd); }
                  catch (re) { eexistErr = re; }
                  finally {
                    try { if (stagedFd !== null) fs.closeSync(stagedFd); } catch {}
                    stagedFd = null;
                  }
                  if (eexistErr || !eexistSnap || !eexistSnap.st.isFile() || eexistSnap.raw === null || Buffer.compare(eexistSnap.raw, rawPre) !== 0) {
                    const recovery = restoreStagedFile(staged, filePath);
                    const err = eexistErr || new Error("concurrent modification conflict updating: " + filePath + (recovery && recovery.preservedPath ? " (preserved at " + recovery.preservedPath + ")" : ""));
                    if (recovery && recovery.preservedPath) err.preservedPath = recovery.preservedPath;
                    throw err;
                  }
                  retireStagedFile(staged, filePath, retiredDir);
                  retryCas = true;
                } else {
                  fs.closeSync(stagedFd);
                  stagedFd = null;
                  const recovery = restoreStagedFile(staged, filePath);
                  if (recovery && recovery.preservedPath) e.preservedPath = recovery.preservedPath;
                  throw e;
                }
              }
              if (!retryCas) {
                const { retiredPath } = retireStagedFile(staged, filePath, retiredDir);
                let postSnap = null;
                let postReadErr = null;
                try {
                  postSnap = readUtf8FromFdAtZero(stagedFd);
                } catch (e) {
                  postReadErr = e;
                } finally {
                  try { if (stagedFd !== null) fs.closeSync(stagedFd); } catch {}
                  stagedFd = null;
                }
                if (postReadErr || !postSnap || !postSnap.st.isFile() || postSnap.raw === null || Buffer.compare(postSnap.raw, rawPre) !== 0) {
                  const cur = lstatSafe(filePath);
                  if (cur && cur.isFile() && cur.ino === publishedIno) {
                    const rb = path.join(stageDir, "rollback");
                    try {
                      assertNoSymlinkPath(filePath);
                      fs.renameSync(filePath, rb);
                      const rbStat = lstatSafe(rb);
                      if (rbStat && rbStat.ino !== publishedIno) {
                        restoreStagedFile(rb, filePath);
                      } else {
                        try { fs.unlinkSync(rb); } catch {}
                      }
                    } catch {}
                  }
                  const recovery = restoreStagedFile(retiredPath, filePath);
                  const err = postReadErr || new Error("concurrent in-place modification detected updating: " + filePath);
                  if (recovery && recovery.preservedPath) err.preservedPath = recovery.preservedPath;
                  throw err;
                }
                const postTarget = lstatSafe(filePath);
                if (!postTarget || !postTarget.isFile() || postTarget.ino !== publishedIno) {
                  retryCas = true;
                }
              }
            }
          }
        } finally {
          try { if (fd !== null) fs.closeSync(fd); } catch {}
          try { if (stagedFd !== null) fs.closeSync(stagedFd); } catch {}
          try { if (ownsTmp) fs.unlinkSync(tmp); } catch {}
          try { fs.rmdirSync(stageDir); } catch {}
        }
        if (retryCas) continue;
        return { changed: true, ino: publishedIno };
      } finally {
        releaseT3HubLock(lockPath);
      }
    }
    throw new Error("concurrent modification conflict updating: " + filePath);
  }

  function validateRoleMarkers(existing, startMarker, endMarker) {
    const s = existing.indexOf(startMarker), e = existing.indexOf(endMarker);
    if ((s < 0) !== (e < 0) || (s >= 0 && (e < s || existing.indexOf(startMarker, s + startMarker.length) >= 0 || existing.indexOf(endMarker, e + endMarker.length) >= 0))) {
      throw new Error("子代理托管区块标记不完整或重复，请先修复");
    }
  }

  function injectIntoFile(filePath, block, startMarker, endMarker) {
    return transformTextFileAtomic(filePath, (existing) => {
      validateRoleMarkers(existing, startMarker, endMarker);
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
      return next === existing ? null : next;
    }, { backup: true, createIfMissing: true });
  }

  // Shared global rules are a bounded block inside each host's own file. The
  // same CAS/backup path used by subagent updates protects unrelated content.
  function syncManagedRuleBlock(filePath, content, scope = "global") {
    if (!["global", "project"].includes(scope)) throw new Error("invalid rule sync scope");
    const start = `<!-- t3-hub-${scope}-rules:start -->`, end = `<!-- t3-hub-${scope}-rules:end -->`;
    if (typeof filePath !== "string" || !path.isAbsolute(filePath) || typeof content !== "string") throw new Error("invalid rule sync input");
    if (content.includes(start) || content.includes(end)) throw new Error("shared rules contain reserved markers");
    return transformTextFileAtomic(filePath, (existing) => {
      const s = existing.indexOf(start), e = existing.indexOf(end);
      if ((s < 0) !== (e < 0) || (s >= 0 && (e < s || existing.indexOf(start, s + start.length) >= 0 || existing.indexOf(end, e + end.length) >= 0))) throw new Error("shared rule markers are incomplete or duplicated");
      const block = content ? start + "\n" + content.replace(/\n?$/, "\n") + end + "\n" : "";
      if (s < 0) return block ? existing + (existing && !existing.endsWith("\n") ? "\n" : "") + (existing ? "\n" : "") + block : null;
      let after = existing.slice(e + end.length);
      if (after.startsWith("\r\n")) after = after.slice(2); else if (after.startsWith("\n")) after = after.slice(1);
      return existing.slice(0, s) + block + after;
    }, { backup: true, createIfMissing: Boolean(content) });
  }

  function replaceRuleDocument(filePath, content, expectedContent) {
    if (typeof filePath !== "string" || !path.isAbsolute(filePath) || typeof content !== "string" || typeof expectedContent !== "string") throw new Error("请先重新读取规则，再保存修改");
    for (const [start, end] of [["<!-- t3-hub-subagents:start -->", "<!-- t3-hub-subagents:end -->"], ["<!-- t3-hub-project-subagents:start -->", "<!-- t3-hub-project-subagents:end -->"], ["<!-- t3-hub-global-rules:start -->", "<!-- t3-hub-global-rules:end -->"], ["<!-- t3-hub-project-rules:start -->", "<!-- t3-hub-project-rules:end -->"], [ORCHESTRATOR_START, ORCHESTRATOR_END]]) {
      const section = (text) => {
        const s = text.indexOf(start), e = text.indexOf(end);
        if ((s < 0) !== (e < 0) || (s >= 0 && (e < s || text.indexOf(start, s + start.length) >= 0 || text.indexOf(end, e + end.length) >= 0))) throw new Error("托管区块不完整或重复，请先修复");
        return s < 0 ? "" : text.slice(s, e + end.length);
      };
      if (section(expectedContent) !== section(content)) throw new Error("托管区块请在对应页面修改");
    }
    return transformTextFileAtomic(filePath, (existing) => {
      if (existing !== expectedContent) throw new Error("规则文件已发生变更，请重新读取后合并修改");
      return content;
    }, { backup: true, createIfMissing: true });
  }
  function transformRuleDocument(filePath, transform) {
    if (typeof filePath !== "string" || !path.isAbsolute(filePath) || typeof transform !== "function") throw new Error("invalid rule transform");
    return transformTextFileAtomic(filePath, transform, { backup: true, createIfMissing: true });
  }

  function resolveExcludePath(projectRoot) {
    if (!projectRoot || !dirExists(projectRoot)) return null;
    const gitPath = path.join(projectRoot, ".git");
    assertNoSymlinkPath(gitPath);
    const st = lstatSafe(gitPath);
    if (!st) return null;
    if (st.isDirectory()) return path.join(gitPath, "info", "exclude");
    if (st.isFile()) {
      const content = fs.readFileSync(gitPath, "utf8").trim();
      const m = content.match(/^gitdir:\s*(.+)$/m);
      if (m) {
        let gd = m[1].trim();
        if (!path.isAbsolute(gd)) gd = path.resolve(path.dirname(gitPath), gd);
        return path.join(gd, "info", "exclude");
      }
    }
    return null;
  }
  function ensureExcludeEntry(projectRoot, entry) {
    const excl = resolveExcludePath(projectRoot);
    if (!excl) return;
    transformTextFileAtomic(excl, (existing) => {
      const lines = existing.split(/\r?\n/);
      if (lines.includes(entry)) return null;
      lines.push(entry);
      return lines.join("\n").replace(/\n+$/, "") + "\n";
    }, { createIfMissing: true });
  }
  function removeExcludeEntry(projectRoot, entry) {
    const excl = resolveExcludePath(projectRoot);
    if (!excl) return;
    transformTextFileAtomic(excl, (existing) => {
      if (!existing || !existing.includes(entry)) return null;
      const lines = existing.split(/\r?\n/).filter((l) => l !== entry);
      return lines.join("\n").replace(/\n+$/, "") + (existing.endsWith("\n") ? "\n" : "");
    }, { createIfMissing: false });
  }

  function writeClaudeAgentFile(dir, item) {
    assertSafeSubagentId(String(item.id));
    const file = path.join(dir, item.id + ".md");
    assertContained(dir, file);
    safeMkdir(dir);
    assertNoSymlinkPath(file);
    const st = lstatSafe(file);
    if (st && !st.isFile()) return { file, written: false, skippedUnmanaged: true };
    const modelLine = item.model ? `\nmodel: ${yamlDoubleQuotedScalar(item.model)}` : "";
    const fm = `---\nname: ${yamlDoubleQuotedScalar(item.id)}\ndescription: ${yamlDoubleQuotedScalar(item.description || item.id)}${modelLine}\n${HUB_AGENT_MARKER}\n---\n\n${item.systemPrompt || ""}\n\n${memoryInstruction(item)}\n`;
    if (!isHubManagedContent(fm)) throw new Error("generated frontmatter failed ownership check: " + file);
    const baseMode = existingFileMode(file) ?? 0o644;
    const mode = (baseMode & 0o555) || 0o444;
    const existsNow = fileExists(file);
    if (!existsNow) {
      try {
        const pub = writeNewFileExclusive(file, fm, mode);
        if (pub && pub.replacedConcurrently) return { file, written: false, skippedUnmanaged: true };
        return { file, written: true, skippedUnmanaged: false };
      } catch (e) {
        if (!e || e.code !== "EEXIST") throw e;
        return { file, written: false, skippedUnmanaged: true };
      }
    }
    const preSnap = readRegularSnapshot(file);
    if (!preSnap.missing && (preSnap.unsafe || !isHubManagedContent(preSnap.text))) {
      return { file, written: false, skippedUnmanaged: true };
    }
    const lockPath = file + ".t3hub.lock";
    acquireT3HubLock(lockPath);
    try {
      assertNoSymlinkPath(file);
      const lockSnap = readRegularSnapshot(file);
      if (lockSnap.missing) {
        try {
          const pub = writeNewFileExclusive(file, fm, mode);
          if (pub && pub.replacedConcurrently) return { file, written: false, skippedUnmanaged: true };
          return { file, written: true, skippedUnmanaged: false };
        }
        catch (e) {
          if (e && e.code === "EEXIST") return { file, written: false, skippedUnmanaged: true };
          throw e;
        }
      }
      if (preSnap.missing || lockSnap.unsafe || !isHubManagedContent(lockSnap.text)) {
        return { file, written: false, skippedUnmanaged: true };
      }
      if (lockSnap.ino !== preSnap.ino || Buffer.compare(lockSnap.raw, preSnap.raw) !== 0) {
        return { file, written: false, skippedUnmanaged: true };
      }
      return replaceManagedFile(file, fm, mode, path.join(hubDir, "retired-agents"), lockSnap);
    } finally {
      releaseT3HubLock(lockPath);
    }
  }
  function removeClaudeAgentFile(dir, id) {
    assertSafeSubagentId(String(id));
    const file = path.join(dir, id + ".md");
    assertContained(dir, file);
    assertNoSymlinkPath(file);
    const preSnap = readRegularSnapshot(file);
    if (preSnap.missing) return { file, removed: false, skippedUnmanaged: false };
    if (preSnap.unsafe || !isHubManagedContent(preSnap.text)) return { file, removed: false, skippedUnmanaged: true };
    const lockPath = file + ".t3hub.lock";
    acquireT3HubLock(lockPath);
    try {
      assertNoSymlinkPath(file);
      const lockSnap = readRegularSnapshot(file);
      if (lockSnap.missing) return { file, removed: false, skippedUnmanaged: false };
      if (lockSnap.unsafe || !isHubManagedContent(lockSnap.text)) return { file, removed: false, skippedUnmanaged: true };
      if (lockSnap.ino !== preSnap.ino || Buffer.compare(lockSnap.raw, preSnap.raw) !== 0) {
        return { file, removed: false, skippedUnmanaged: true };
      }
      const { changed, ...result } = stageManagedFile(file, undefined, undefined, path.join(hubDir, "retired-agents"), lockSnap);
      return { file, removed: changed, ...result };
    } finally {
      releaseT3HubLock(lockPath);
    }
  }

  function globalRoleTargets(extraSyncPaths = opts.extraSyncPaths || []) {
    const targets = [
      path.join(homeDir, ".codex", "AGENTS.md"),
      path.join(homeDir, ".pi", "agent", "AGENTS.md"),
      path.join(homeDir, ".config", "muse", "AGENTS.md"),
      path.join(homeDir, ".claude", "CLAUDE.md"),
    ];
    if (!Array.isArray(extraSyncPaths) || extraSyncPaths.some(p => typeof p !== "string" || !path.isAbsolute(p))) throw new Error("extraSyncPaths must contain absolute file paths");
    const extras = extraSyncPaths.map(p => path.resolve(p));
    return [...new Set([globalAgentsMdPath, ...targets.filter(t => fileExists(t) || dirExists(path.dirname(t))), ...extras])];
  }

  function preflightRoleTargets(scope, projectRoot, extraSyncPaths) {
    const targets = scope === "project" ? [path.join(projectRoot, "AGENTS.md")] : globalRoleTargets(extraSyncPaths);
    const start = scope === "project" ? PROJECT_START : GLOBAL_START, end = scope === "project" ? PROJECT_END : GLOBAL_END;
    for (const target of targets) validateRoleMarkers(policySnapshot(target).text, start, end);
  }

  function injectGlobal(allGlobal, extraSyncPaths = opts.extraSyncPaths || []) {
    const block = renderBlock(allGlobal, false);
    for (const t of globalRoleTargets(extraSyncPaths)) {
      // Sync only when parent dir exists (like hub-skills), to avoid creating stray dirs on fresh systems.
      // But still sync if file already exists regardless.
      injectIntoFile(t, block, GLOBAL_START, GLOBAL_END);
    }
    // Also sync to .claude/agents for enabled globals
    const enabled = allGlobal.filter((i) => i.enabled !== false);
    safeMkdir(claudeAgentsRoot);
    const skippedUnmanaged = [];
    const conflicts = [];
    for (const it of enabled) {
      const res = writeClaudeAgentFile(claudeAgentsRoot, it);
      recordUnmanagedConflict(res, it.id, skippedUnmanaged, conflicts);
    }
    // Clean up disabled/removed agents that had files but now disabled.
    // Hard guard: only Hub-managed files may be deleted; user files always preserved.
    let existingGlobalFiles = [];
    try { existingGlobalFiles = fs.readdirSync(claudeAgentsRoot).filter((f) => f.endsWith(".md")); }
    catch (e) { if (!e || e.code !== "ENOENT") throw e; }
    const enabledGlobalIds = new Set(enabled.map((i) => i.id));
    for (const f of existingGlobalFiles) {
      const id = f.slice(0, -3);
      if (!enabledGlobalIds.has(id)) {
        const full = path.join(claudeAgentsRoot, f);
        if (isHubManagedAgentFile(full)) {
          recordUnmanagedConflict(removeClaudeAgentFile(claudeAgentsRoot, id), id, skippedUnmanaged, conflicts);
        }
      }
    }
    return { block, skippedUnmanaged, conflicts };
  }

  function injectProject(projectRoot, allProjectItems, globalItems, injectOpts = {}) {
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
    const skippedUnmanaged = [];
    const conflicts = [];
    for (const it of enabled) {
      const res = writeClaudeAgentFile(claudeAgentsDir, it);
      recordUnmanagedConflict(res, it.id, skippedUnmanaged, conflicts);
      if (!res || !res.skippedUnmanaged) {
        ensureExcludeEntry(projectRoot, `.claude/agents/${it.id}.md`);
      }
    }
    // Remove disabled/deleted project agents. Hard guard: only managed files.
    let existingProjFiles = [];
    try { existingProjFiles = dirExists(claudeAgentsDir) ? fs.readdirSync(claudeAgentsDir).filter((f) => f.endsWith(".md")) : []; }
    catch (e) { if (!e || e.code !== "ENOENT") throw e; }
    const enabledIds = new Set(enabled.map((i) => i.id));
    const skipRemoveIds = injectOpts && injectOpts.skipRemoveIds ? injectOpts.skipRemoveIds : null;
    for (const f of existingProjFiles) {
      const id = f.slice(0, -3);
      if (!enabledIds.has(id) && !(skipRemoveIds && skipRemoveIds.has(id))) {
        const known = allProjectItems.some((it) => it.id === id);
        const full = path.join(claudeAgentsDir, f);
        const managed = isHubManagedAgentFile(full);
        if (managed) {
          const res = removeClaudeAgentFile(claudeAgentsDir, id);
          recordUnmanagedConflict(res, id, skippedUnmanaged, conflicts);
          if (known && !res.skippedUnmanaged) removeExcludeEntry(projectRoot, `.claude/agents/${id}.md`);
        }
      }
    }
    return { block, skippedUnmanaged, conflicts };
  }

  function listSubagents(args = {}) {
    const projectRoot = args.projectRoot || null;
    const catalog = listModelCatalog(homeDir);
    const globalItems = withReviewTierDefaults(readGlobal());
    const projectItems = projectRoot ? readProject(projectRoot) : [];
    const effectiveItems = buildEffective(globalItems, projectItems);
    const legacyPath = projectRoot ? path.join(projectDir, slugFromProjectRoot(projectRoot) + ".json") : null;
    const legacyProjectConfig = Boolean(legacyPath && fileExists(legacyPath));
    const sourceById = Object.fromEntries(effectiveItems.map(item => [item.id, projectItems.some(p => p.enabled !== false && p.id === item.id && (p.overridesGlobal || !globalItems.some(g => g.enabled !== false && g.id === item.id))) ? "project" : item.suggestedDefault ? "default" : "global"]));
    const group = (id, role, label, definitions) => ({ id, role, label, levels: definitions.map(([level, itemId, kind, levelLabel, description]) => {
      if (kind === "main") return { level, id: null, kind, label: levelLabel, description, item: null, globalItem: null, projectItem: null, source: "main", configured: false };
      const globalItem = globalItems.find(i => i.id === itemId) || null;
      const projectItem = projectItems.find(i => i.id === itemId) || null;
      const useProject = projectItem && (projectItem.overridesGlobal || !globalItem);
      const item = useProject ? { ...(globalItem || {}), ...projectItem } : globalItem;
      if (useProject) delete item.suggestedDefault;
      return { level, id: itemId, kind, label: levelLabel, description, item, globalItem, projectItem, source: useProject ? "project" : globalItem?.suggestedDefault ? "default" : "global", configured: Boolean(item && !item.suggestedDefault) };
    }) });
    const tierGroups = [
      group("work", "implementation", "执行", [[1, "worker", "agent", "L1 常规执行", "范围明确的开发与修复"], [2, "worker-pro", "agent", "L2 难题攻关", "L1 连续两次未解决时升级"], [3, null, "main", "L3 主会话兜底", "L2 连续两次未解决后主会话接管；用户明确要求时也可亲自处理。"]]),
      group("review", "review", "审查", [[1, "review-fast", "agent", "L1 快速审查", "小范围变更的独立快审"], [2, "code-review", "agent", "L2 深度审查", "模块级变更的独立审查"], [3, "review-pro", "agent", "L3 高风险终审", "高风险变更的独立终审，由子代理执行"]]),
    ];
    return { ok: true, projectRoot, catalog, globalItems, projectItems, effectiveItems, sourceById, legacyProjectConfig, tierGroups };
  }

  function saveSubagent(args = {}) {
    const scope = args.scope || "global";
    const projectRoot = args.projectRoot || null;
    if (!["global", "project"].includes(scope)) throw new Error("invalid scope: " + scope);
    if (scope === "project" && (!projectRoot || !path.isAbsolute(String(projectRoot)))) throw new Error("projectRoot required for project scope");
    preflightRoleTargets(scope, projectRoot, args.extraSyncPaths);
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
    let syncSkippedUnmanaged = [];
    let syncConflicts = [];
    if (scope === "global") {
      let items = readGlobal();
      const idx = items.findIndex((x) => x.id === normalized.id);
      // Preserve builtin flag correctly: if id is a default builtin and caller didn't set builtin, mark builtin true.
      const isDefaultId = [...DEFAULT_SUBAGENTS, ...REVIEW_TIER_DEFAULTS].some((d) => d.id === normalized.id);
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
      const syncRes = injectGlobal(items, args.extraSyncPaths);
      if (typeof syncRes === "string") { renderedMarkdownBlock = syncRes; } else { renderedMarkdownBlock = syncRes.block; syncSkippedUnmanaged = syncRes.skippedUnmanaged || []; syncConflicts = syncRes.conflicts || []; }
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
      const syncRes = injectProject(projectRoot, items, globalItems);
      if (typeof syncRes === "string") { renderedMarkdownBlock = syncRes; } else { renderedMarkdownBlock = syncRes.block; syncSkippedUnmanaged = syncRes.skippedUnmanaged || []; syncConflicts = syncRes.conflicts || []; }
      saved = items.find((x) => x.id === normalized.id);
    } else {
      throw new Error("invalid scope: " + scope);
    }
    // Also ensure global block is re-injected when project changes? No.
    return { ok: true, scope, projectRoot: scope === "project" ? projectRoot : null, item: saved, renderedMarkdownBlock, skippedUnmanaged: syncSkippedUnmanaged, conflicts: syncConflicts };
  }

  function deleteSubagent(args = {}) {
    const scope = args.scope || "global";
    const projectRoot = args.projectRoot || null;
    const id = String(args.id || "").trim();
    if (!id) throw new Error("id required");
    assertSafeSubagentId(id);
    if (!["global", "project"].includes(scope)) throw new Error("invalid scope: " + scope);
    if (scope === "project" && (!projectRoot || !path.isAbsolute(String(projectRoot)))) throw new Error("projectRoot required for project scope");
    preflightRoleTargets(scope, projectRoot, args.extraSyncPaths);
    let renderedMarkdownBlock;
    let syncSkippedUnmanaged = [];
    let syncConflicts = [];
    function unwrapSync(res) {
      if (typeof res === "string") { renderedMarkdownBlock = res; } else { renderedMarkdownBlock = res.block; syncSkippedUnmanaged = res.skippedUnmanaged || []; syncConflicts = res.conflicts || []; }
    }
    if (scope === "global") {
      let items = readGlobal();
      const idx = items.findIndex((x) => x.id === id);
      if (idx === -1) return { ok: true, scope, id, deleted: false };
      const existing = items[idx];
      if (existing.builtin) {
        // Reset builtin to default seed instead of deleting.
        const def = [...DEFAULT_SUBAGENTS, ...REVIEW_TIER_DEFAULTS].find((d) => d.id === id);
        if (def) {
          items[idx] = { ...def };
          writeGlobal(items);
          unwrapSync(injectGlobal(items, args.extraSyncPaths));
          return { ok: true, scope, id, deleted: false, reset: true, item: items[idx], renderedMarkdownBlock, skippedUnmanaged: syncSkippedUnmanaged, conflicts: syncConflicts };
        }
      }
      items = items.filter((x) => x.id !== id);
      writeGlobal(items);
      unwrapSync(injectGlobal(items, args.extraSyncPaths));
      return { ok: true, scope, id, deleted: true, renderedMarkdownBlock, skippedUnmanaged: syncSkippedUnmanaged, conflicts: syncConflicts };
    } else if (scope === "project") {
      if (!projectRoot || !path.isAbsolute(String(projectRoot))) throw new Error("projectRoot required for project scope");
      let items = readProject(projectRoot);
      const idx = items.findIndex((x) => x.id === id);
      if (idx === -1) return { ok: true, scope, id, deleted: false, projectRoot };
      items = items.filter((x) => x.id !== id);
      writeProject(projectRoot, items);
      // Clean file and exclude (guarded: only managed files removed)
      const claudeAgentsDir = path.join(projectRoot, ".claude", "agents");
      const rmRes1 = removeClaudeAgentFile(claudeAgentsDir, id);
      if (rmRes1 && !rmRes1.skippedUnmanaged) removeExcludeEntry(projectRoot, `.claude/agents/${id}.md`);
      const globalItems = readGlobal();
      unwrapSync(injectProject(projectRoot, items, globalItems, { skipRemoveIds: new Set([id]) }));
      recordUnmanagedConflict(rmRes1, id, syncSkippedUnmanaged, syncConflicts);
      return { ok: true, scope, id, deleted: true, projectRoot, renderedMarkdownBlock, skippedUnmanaged: syncSkippedUnmanaged, conflicts: syncConflicts };
    }
    throw new Error("invalid scope: " + scope);
  }

  // Read on every call and never seed/synchronize configuration from a hook invocation.
  function resolveSubagentRoute({ idOrTitle, role, projectRoot } = {}) {
    const globals = fileExists(globalPath) ? withReviewTierDefaults(readGlobal()) : [];
    let projects = [];
    if (projectRoot) {
      let current = path.resolve(projectRoot);
      try { current = fs.realpathSync(current); } catch (e) { if (e.code !== "ENOENT") throw e; }
      // A tool may run below the project root. The closest project config wins.
      while (true) {
        const file = projectPathFor(current);
        if (fileExists(file)) { projects = readProject(current); break; }
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
    if (!item && hints.length) {
      const known = [...globals, ...projects, ...DEFAULT_SUBAGENTS, ...REVIEW_TIER_DEFAULTS];
      const explicitUnavailable = hints.some(hint => known.some(entry => [entry.id, entry.name].some(value => {
        const id = String(value || "").toLowerCase();
        return id && (hint === id || hint.startsWith(id) && /^(?:\s*[·:：|/]|\s+-\s)/.test(hint.slice(id.length)));
      })));
      if (explicitUnavailable) return { ok: true, matched: false, explicitUnavailable: true, item: null, target: null };
    }
    const roleDefault = { research: "explorer", implementation: "worker", general: "default", design: "frontend", test: "qa", review: "code-review" };
    if (!item && roleDefault[role] && (!hints.length || hints.length === 1 && hints[0] === String(role).toLowerCase())) item = items.find(i => i.id === roleDefault[role]);
    // A role fallback is safe only when it is unambiguous and no explicit identity was supplied.
    if (!item && !hints.length && role) {
      item = items.find(i => i.id === role || i.name === role);
      if (!item) { const matches = items.filter(i => i.role === role); if (matches.length === 1) item = matches[0]; }
    }
    if (!item || !item.providerInstanceId || !item.model || !item.effort) return { ok: true, matched: false, item: null, target: null };
    return { ok: true, matched: true, item, instruction: subagentInstruction(item), target: { providerInstanceId: item.providerInstanceId, model: item.model, options: optionsForSubagent(item) } };
  }

  return { homeDir, hubDir, globalPath, projectDir, resolveSubagentRoute, renderMarkdownBlock: renderBlock, listSubagents, saveSubagent, deleteSubagent, getOrchestrationConfig, getOrchestrationState, inspectOrchestrationTargets, updateOrchestrationConfig, syncOrchestrationDirectiveToHosts, syncManagedRuleBlock, replaceRuleDocument, transformRuleDocument, buildOrchestrationDirective, buildSlashCommandPrompt: (mode) => buildSlashCommandPrompt(mode), listModelCatalog: () => listModelCatalog(homeDir) };
}

let _singleton = null;
function getDefaultSubagentsManager() {
  if (!_singleton) _singleton = createSubagentsManager();
  return _singleton;
}
function listSubagents(a) { return getDefaultSubagentsManager().listSubagents(a || {}); }
function saveSubagent(a) { return getDefaultSubagentsManager().saveSubagent(a || {}); }
function deleteSubagent(a) { return getDefaultSubagentsManager().deleteSubagent(a || {}); }

function getOrchestrationConfigExport() { return getDefaultSubagentsManager().getOrchestrationConfig(); }
function updateOrchestrationConfigExport(patch, opts) { return getDefaultSubagentsManager().updateOrchestrationConfig(patch || {}, opts || {}); }
function syncOrchestrationDirectiveToHostsExport(args) { return getDefaultSubagentsManager().syncOrchestrationDirectiveToHosts(args || {}); }
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
  getOrchestrationConfig: getOrchestrationConfigExport,
  getOrchestrationState: (args) => getDefaultSubagentsManager().getOrchestrationState(args || {}),
  inspectOrchestrationTargets: (args) => getDefaultSubagentsManager().inspectOrchestrationTargets(args || {}),
  updateOrchestrationConfig: updateOrchestrationConfigExport,
  syncOrchestrationDirectiveToHosts: syncOrchestrationDirectiveToHostsExport,
  buildSlashCommandPrompt: (mode) => buildSlashCommandPrompt(mode),
  buildOrchestrationDirective: (cfg) => buildOrchestrationDirective(cfg),
  AGY_MODELS,
  ORCHESTRATOR_START,
  ORCHESTRATOR_END,
};
