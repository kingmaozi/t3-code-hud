"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

// Refuse links at both the leaf and any parent before reading, creating,
// replacing or deleting. No blind stop at os.tmpdir(): every existing
// ancestor is lstat-checked, with only the two macOS system aliases allowed.
function isMacSystemAlias(linkPath, realPath) {
  const link = path.resolve(String(linkPath));
  const real = path.resolve(String(realPath));
  if (link === "/tmp" && real === "/private/tmp") return true;
  if (link === "/var" && real === "/private/var") return true;
  return false;
}
function assertNoSymlinkPath(file) {
  let current = path.resolve(file);
  while (true) {
    const st = lstatSafe(current);
    if (st && st.isSymbolicLink()) {
      let real = null;
      try { real = fs.realpathSync(current); } catch { real = null; }
      if (real === null || !isMacSystemAlias(current, real)) throw new Error("unsafe symlink path: " + current);
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
function safeMkdir(dir) { assertNoSymlinkPath(dir); fs.mkdirSync(dir, { recursive: true }); }
function dirExists(p) { assertNoSymlinkPath(p); try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function fileExists(p) { assertNoSymlinkPath(p); try { return fs.statSync(p).isFile(); } catch { return false; } }
function lstatSafe(p) {
  try { return fs.lstatSync(p); }
  catch (e) { if (e?.code === "ENOENT") return null; throw e; }
}
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
function writeNewFileExclusive(file, text, mode, onPublish) {
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
    onPublish?.({ dev: newStat.dev, ino: publishedIno });
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
  if (!st.isFile() || st.nlink !== 1 || !(st.mode & 0o444)) return { missing: false, unsafe: true, st, dev: st.dev, ino: st.ino };
  let fd = null;
  try {
    const nofollow = fs.constants.O_NOFOLLOW || 0;
    fd = fs.openSync(file, fs.constants.O_RDONLY | nofollow);
    const snap = readUtf8FromFdAtZero(fd);
    if (!snap.st.isFile() || snap.st.nlink !== 1 || snap.st.ino !== st.ino || snap.st.dev !== st.dev || snap.raw === null) {
      return { missing: false, unsafe: true, st: snap.st, dev: snap.st.dev, ino: snap.st.ino };
    }
    return { missing: false, unsafe: false, dev: snap.st.dev, ino: snap.st.ino, mode: snap.st.mode & 0o777, text: snap.text, raw: snap.raw };
  } catch (e) {
    if (e && e.code === "ENOENT") return { missing: true };
    return { missing: false, unsafe: true, error: e, dev: st.dev, ino: st.ino };
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
function stageManagedFile(file, text, mode, retiredDir, expectedSnap = null, onPublish) {
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
  let publishedIno = null, publishedDev = null;
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
  const ensureRestoredOrThrow = (sourcePath = staged, causeErr = null) => {
    const recovery = restoreWithMode(sourcePath);
    if (!lstatSafe(file)) {
      const failErr = causeErr || new Error("代理文件恢复原路径失败: " + file);
      failErr.unrestoredPath = file;
      if (recovery && recovery.preservedPath) failErr.preservedPath = recovery.preservedPath;
      throw failErr;
    }
    return recovery;
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
      publishedIno = newStat.ino; publishedDev = newStat.dev;
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
    let inspectError = null;
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
    } catch (err) { inspectError = err; } // Locked, multi-linked, mutated, or unreadable staged inode is restored intact.
    if (!managed) return { changed: false, skippedUnmanaged: true, ...ensureRestoredOrThrow(staged, inspectError) };
    // Never rename over `file` (which could clobber a concurrent save), and
    // never drop the staged inode nlink to 0 (retire it via hard link first,
    // then re-read stagedFd AFTER stageDir/old is unlinked so any write up
    // through unlink — even one preserving t3_hub_managed: true — is rescued).
    const rescueIfMutated = (sourcePath) => {
      let unchanged = false;
      let checkError = null;
      try {
        const check = readUtf8FromFdAtZero(stagedFd);
        unchanged =
          check.st.nlink === 1 &&
          check.raw !== null &&
          Buffer.compare(check.raw, stagedSnapRaw) === 0 &&
          isHubManagedContent(check.text);
      } catch (err) { checkError = err; }
      if (unchanged) return null;
      return { changed: false, skippedUnmanaged: true, ...ensureRestoredOrThrow(sourcePath, checkError) };
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
      try { fs.linkSync(tmp, file); onPublish?.({ dev: publishedDev, ino: publishedIno }); }
      catch (e) {
        if (e && e.code === "EEXIST") {
          const rescued = finalizeRetired();
          if (rescued) return rescued;
          return { changed: false, skippedUnmanaged: true };
        }
        const recovery = restoreWithMode(staged);
        if (!lstatSafe(file)) e.unrestoredPath = file;
        if (recovery.preservedPath) e.preservedPath = recovery.preservedPath;
        throw e;
      }
      try { fs.unlinkSync(tmp); ownsTmp = false; } catch {}
    }
    // Deletion becomes visible during staging. Register it before retirement
    // or the first readback can fail; rollback recognizes a rescued original.
    if (!updating) onPublish?.({ deleted: true });
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
function replaceManagedFile(file, text, mode, retiredDir, expectedSnap = null, onPublish) {
  const { changed, ...result } = stageManagedFile(file, text, mode, retiredDir, expectedSnap, onPublish);
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

const MUSE_DEFAULT_MODELS = ["muse-wonder-full-1.0-contributor", "muse-ember-1.0", "muse-spark-1.3", "muse-wonder-1.0", "muse-wonder-full-1.0", "muse-spark-1.2"];
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
    toolBadge: "主力研发",
    providerInstanceId: "muse",
    model: "muse-wonder-full-1.0-contributor",
    effort: "max",
    description: "99% 研发实现主力：功能开发、复杂改动、Bug 修复、配套测试与校验闭环均首派 worker",
    systemPrompt: "你作为主力研发执行子代理（worker），承担 99% 的功能开发、架构落地与缺陷修复任务；在划定的文件边界内完成高质量实现，必须编写并运行对应测试确认转绿后再回传精简结论与修改位置。" + ANTI_SWARM_IRON_LAW,
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
    toolBadge: "二次攻坚",
    providerInstanceId: "codex",
    model: "gpt-6-astra",
    effort: "xhigh",
    description: "仅限同一问题 worker 连续出错 2 次未果后的二次升级攻坚（严禁跳过 worker 直接首派）",
    systemPrompt: "你作为二次升级高难攻坚子代理（worker-pro），仅在同一问题经 worker 连续两次尝试仍未解决时接管；先定位前两次失败的根因不变量，再做最小可靠修复并完成回归验证。" + ANTI_SWARM_IRON_LAW,
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
    lines.push("在存在 delegate_task 的 T3 顶层主会话（parentThreadId == null）中，本总指挥设置优先于通用默认提示 \"Ordinary coding tasks need no T3 tools\"：常规调查、编码修改、QA 与独立代码审查默认派发对应子代理执行；仅在触发 <SUBAGENT-STOP> 子代理禁递归、用户当轮明确要求主会话亲做、AGY 改自身规则配置、几行极微改动、或 worker（L1）连续两次 + worker-pro（L2）连续两次均未解决后主会话兜底时，由主会话直接处理。派单时优先调用 subagent_resolve（或读取 ~/.t3/hub/subagents.json 及项目覆盖配置）查询实时路由，并在 title 或 clientRequestId 中标明具体角色 ID。");
    lines.push("首次派单前先调用一次 orchestrator_capabilities 确认当前能力；若项目有覆盖（项目 AGENTS.md 或 resolveSubagentRoute 结论）以项目覆盖为准。");
    lines.push("研发执行铁律：99% 的实现与改码任务统一首派 worker（L1，muse-wonder-full-1.0-contributor），严禁跳过 worker 直接首派 worker-pro；仅对同一实现问题，worker（L1）连续两次出错仍未解决时才升级 worker-pro（L2，gpt-6-astra xhigh）；L2 连续两次仍未解决时，由主会话亲自兜底。不要求无关子代理重复尝试。");
    lines.push("用户明确要求主会话亲做时遵照用户要求；T3 中 delegate_task 不可用是能力缺口，应说明实际阻点，不得假称子代理已尝试失败；独立非 T3 宿主不因缺少该工具而报错。");
  } else {
    lines.push("当前模式：常规协作。小任务、短任务默认由主会话直接完成；较长或复杂任务按需要分工，独立工作可并行。");
    lines.push("需要派发实现子代理时，99% 实现任务统一首派 worker（L1），严禁跳过 worker 直接首派 worker-pro；仅在同一实现问题 worker（L1）连续两次仍未解决时可升级 worker-pro（L2）；L2 连续两次仍未解决时由主会话兜底。");
    lines.push("在 T3 中需要派单而 delegate_task 不可用时说明工具缺口，不得假称已经派单；独立非 T3 宿主不因缺少该工具而报错。");
  }
  lines.push("需要分工的多步任务应使用宿主实际提供的 update_plan、plan_update 等计划工具维护本会话 Plan，完成步骤时更新状态并保留已完成项供查看；没有计划工具时使用宿主支持的原生 Plan 产物，不伪造工具调用。");
  lines.push("各角色的模型、思考强度与提示词从 Hub 路由配置读取；本块仅提供协作指引，不自动切换主会话模型，也不绕过宿主权限或更高优先级规则。");
  lines.push("选择等级时在 title 或 clientRequestId 中写明确角色 ID：执行默认统一用 worker（仅连续两次失败后才可用 worker-pro），审查用 review-fast / code-review / review-pro；role 仍分别使用 implementation 或 review。未指定等级时 review 默认 code-review、implementation 默认 worker。");
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

const ROUTING_SKILL_NAME = "t3-subagent-routing";
const ROUTING_SKILL_MARKER = "<!-- t3-hub-managed-skill -->";

function parseFrontmatterMap(content) {
  if (typeof content !== "string" || !/^---(?:\r?\n|$)/.test(content)) return null;
  const m = content.match(/^---\r?\n([\s\S]*?)^---(?:\r?\n|$)/m);
  if (!m) return null;
  try { return { map: parseOwnershipFrontmatter(m[1]), raw: m[1] }; } catch { return { invalid: true }; }
}
function explicitManagedFlag(content) {
  const parsed = parseFrontmatterMap(content);
  if (parsed === null) return null;
  if (parsed.invalid) return "invalid";
  if (!parsed.map.has("t3_hub_managed")) return null;
  const v = parsed.map.get("t3_hub_managed");
  if (v === true) return true;
  if (v === false) return false;
  return "invalid";
}
// Skill ownership requires a legal, explicit boolean true in frontmatter.
// Body comments and historical prose confer no destructive authority.
function isHubManagedSkillContent(content) {
  return explicitManagedFlag(content) === true;
}

function buildHostCapabilities() {
  const summary = "AGY/Codex/Muse/Claude/Pi 均依赖新会话读取静态规则/Skill，当前运行中会话不会自动热注入新系统提示；PreToolUse subagent-route-guard 仅在 delegate_task 已触发后纠偏目标模型/档位，不会凭空触发派单；AGY ACP ExternalPreInvocationHook.injectSteps 被本机 SDK 忽略；Codex UserPromptSubmit 因 session_id 父子继承未证实安全顶层 lineage 暂不启用动态强推，绝不伪造已生效。";
  return {
    t3: {
      staticRules: "T3 顶层主会话依赖新会话读取静态规则/Skill，当前运行中会话不会自动热注入新系统提示。",
      hotInject: "当前运行中会话不会自动热注入新系统提示，仅新会话生效。",
      preToolUseGuard: "PreToolUse subagent-route-guard 仅在 delegate_task 已触发后纠偏目标模型/档位，不会凭空触发派单。",
    },
    antigravity: {
      staticRules: "AGY 依赖新会话读取静态规则/Skill，当前运行中会话不会自动热注入新系统提示。",
      acpInjectSteps: "AGY ACP ExternalPreInvocationHook.injectSteps 被本机 SDK 忽略，不可用于注入系统提示，绝不伪造已生效。",
    },
    codex: {
      staticRules: "Codex 依赖新会话读取静态规则/Skill，当前运行中会话不会自动热注入新系统提示。",
      userPromptSubmit: "Codex UserPromptSubmit 因 session_id 父子继承未证实安全顶层 lineage 暂不启用动态强推，绝不伪造已生效。",
    },
    muse: { staticRules: "Muse 依赖新会话读取静态规则/Skill，当前运行中会话不会自动热注入新系统提示。" },
    claude: { staticRules: "Claude 依赖新会话读取静态规则/Skill，当前运行中会话不会自动热注入新系统提示。" },
    pi: { staticRules: "Pi 依赖新会话读取静态规则/Skill，当前运行中会话不会自动热注入新系统提示。" },
    summary,
  };
}

function renderRoutingSkillMarkdown(effectiveAgents, orchestrationCfg) {
  const c = normalizeOrchestrationConfig(orchestrationCfg);
  const isOn = c.swarmMode === "on";
  const enabled = (Array.isArray(effectiveAgents) ? effectiveAgents : [])
    .filter((a) => a && typeof a === "object" && a.id && a.enabled !== false)
    .slice()
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const routeEntries = enabled.map((a) => `${a.id} -> ${a.providerInstanceId} ${a.model} (${a.effort})`);
  const modeLabel = isOn ? "T3 蜂群总指挥（ON）" : "常规协作（OFF）";
  const modeDecl = `当前全局默认模式：${modeLabel}`;
  const description = `T3 子代理路由：${modeDecl}。${enabled.length} 个已启用角色：${routeEntries.join("、")}；派单前以 Hub 路由配置与项目覆盖为准，详见正文。`;
  const lines = [];
  lines.push("---");
  lines.push(`name: ${ROUTING_SKILL_NAME}`);
  lines.push(`description: ${yamlDoubleQuotedScalar(description)}`);
  lines.push("t3_hub_managed: true");
  lines.push("---");
  lines.push("");
  lines.push(ROUTING_SKILL_MARKER);
  lines.push("");
  lines.push(`# T3 子代理路由（${ROUTING_SKILL_NAME}）`);
  lines.push("");
  lines.push(`${modeDecl}。`);
  lines.push("");
  lines.push(SUBAGENT_STOP_HEADER);
  lines.push("");
  lines.push("被 delegate_task 派出的子代理不得再调用 delegate_task、invoke_subagent 或启动宿主原生蜂群；宿主内置生图和 browser 等专用能力除外。");
  lines.push("");
  lines.push("## 已启用角色（实时路由快照）");
  lines.push("");
  lines.push("| id | provider | model | effort |");
  lines.push("|---|---|---|---|");
  for (const a of enabled) lines.push(`| ${a.id} | ${a.providerInstanceId} | ${a.model} | ${a.effort} |`);
  lines.push("");
  lines.push(routeEntries.join("；") + "。");
  lines.push("");
  if (isOn) {
    lines.push("## 协作模式（ON）");
    lines.push("");
    lines.push("当前全局默认模式：T3 蜂群总指挥（ON）。");
    lines.push("");
    lines.push("在存在 delegate_task 的 T3 顶层主会话（parentThreadId == null）中，本用户开启的总指挥设置优先于通用默认提示 \"Ordinary coding tasks need no T3 tools\"：常规调查、编码修改、QA 与独立代码审查默认派发对应子代理执行（除非触发 <SUBAGENT-STOP> 子代理禁递归、用户当轮明确要求主会话亲做、AGY 改自身规则配置或几行极微改动、或同一问题 worker（L1）连续两次未解决升 worker-pro（L2）、L2 连续两次未解决后由主会话兜底）。");
    lines.push("");
    lines.push("顶层主会话默认负责需求拆解、维护计划（plan_update / update_plan）、划清并发文件边界、通过 delegate_task 派单与验收，不亲自做常规调查/编码/测试/审查。研发执行铁律：99% 的改码与实现任务一律首派 worker（L1，muse-wonder-full-1.0-contributor），严禁跳过 worker 直接首派 worker-pro；仅在同一问题 worker（L1）连续两次出错仍未解决时，才升级 worker-pro（L2，gpt-6-astra xhigh）；L2 连续两次仍未解决时，由主会话亲自兜底。不要求无关子代理重复尝试。");
    lines.push("");
    lines.push("派单时优先调用 subagent_resolve（或读取 ~/.t3/hub/subagents.json 及项目覆盖配置）查询实时路由，并在 title 或 clientRequestId 中标明具体角色 ID。派单前若项目有覆盖（项目 AGENTS.md 或 subagent_resolve / resolveSubagentRoute）以项目覆盖为准。首次派单前先调用一次 orchestrator_capabilities 确认当前能力。");
    lines.push("");
  } else {
    lines.push("## 协作模式（OFF）");
    lines.push("");
    lines.push("当前全局默认模式：常规协作（OFF）。");
    lines.push("");
    lines.push("小任务、短任务默认由主会话直接完成；多模块长任务、前端视觉、难测 QA 或独立审查按需通过 delegate_task 分工，独立工作可并行。需要分工时用 update_plan、plan_update 维护计划，派单时在 title 或 clientRequestId 中标明角色 ID。");
    lines.push("");
  }
  lines.push("## AGY 顶层主会话防压缩减负（仅 AGY 顶层主会话；Muse/Codex/Pi 与子代理豁免）");
  lines.push("");
  lines.push("AGY 顶层主会话在 ~220K–256K 上下文窗口逼近上限时，仍须稳控 150K 以内，避免触发压缩丢失关键计划与路由上下文。重型技能下沉子代理自读：主会话仅保留路由索引，重型技能正文由子代理按需读取。预计 >8KB 的命令输出先落盘再按需读取，禁止把大输出直接灌入主会话上下文。压缩后重读源码硬锁：压缩后必须重读当前源码与计划状态再继续，不得凭压缩摘要继续修改。以上规则仅约束 AGY 顶层主会话；Muse/Codex/Pi 与全体子代理豁免，不因本节改变原有上下文策略。");
  lines.push("");
  lines.push("各宿主（AGY/Codex/Muse/Claude/Pi）均依赖新会话读取静态规则与本 Skill，当前运行中会话不会自动热注入；PreToolUse 路由守卫仅在 delegate_task 已触发后纠偏目标模型/档位，不会凭空触发派单。");
  lines.push("");
  return lines.join("\n") + "\n";
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

  function resolveT3UserdataDir() {
    if (typeof opts.t3UserdataDir === "string" && opts.t3UserdataDir.trim()) {
      return path.resolve(opts.t3UserdataDir);
    }
    const envHome = process.env.HOME || os.homedir();
    const sameHome = !opts.homeDir || path.resolve(homeDir) === path.resolve(envHome);
    if (sameHome && typeof process.env.T3CODE_HOME === "string" && process.env.T3CODE_HOME.trim()) {
      return path.resolve(process.env.T3CODE_HOME);
    }
    return path.join(homeDir, ".t3", "userdata");
  }

  function rawCanonicalPath(projectRoot) {
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
    return canonical;
  }

  function rawProjectRolePathFor(canonical) {
    const hash = crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 20);
    const p = path.join(projectDir, slugFromProjectRoot(canonical) + "-" + hash + ".json");
    assertContained(projectDir, p);
    return p;
  }

  function rawProjectOrchestrationFileFor(canonical) {
    const hash = crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 20);
    const dir = path.join(projectDir, slugFromProjectRoot(canonical) + "-" + hash);
    const file = path.join(dir, "orchestration.json");
    assertContained(projectDir, file);
    return { canonical, dir, file };
  }

  function resolveCanonicalProjectRoot(projectRoot) {
    const start = rawCanonicalPath(projectRoot);
    let realHome = null;
    try { realHome = rawCanonicalPath(path.resolve(homeDir)); } catch { realHome = path.resolve(homeDir); }
    let current = start;
    while (true) {
      const orchFile = rawProjectOrchestrationFileFor(current).file;
      assertNoSymlinkPath(orchFile);
      if (lstatSafe(orchFile)) return current;
      const roleFile = rawProjectRolePathFor(current);
      assertNoSymlinkPath(roleFile);
      if (lstatSafe(roleFile)) return current;
      const gitPath = path.join(current, ".git");
      assertNoSymlinkPath(gitPath);
      if (lstatSafe(gitPath)) return current;
      const parent = path.dirname(current);
      if (parent === current) break;
      if (start !== realHome && parent === realHome) break;
      current = parent;
    }
    return start;
  }

  function readGlobal(snapshot = policySnapshot(globalPath), seed = true) {
    if (snapshot.missing) {
      const defaults = DEFAULT_SUBAGENTS.map((d) => ({ ...d }));
      if (seed) transformTextFileAtomic(globalPath, () => JSON.stringify(defaults, null, 2) + "\n", {
        createIfMissing: true, defaultMode: 0o600, expectedSnapshot: snapshot,
      });
      return defaults;
    }
    let raw;
    try { raw = JSON.parse(snapshot.text); }
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
  function projectPathFor(projectRoot) {
    return rawProjectRolePathFor(resolveCanonicalProjectRoot(projectRoot));
  }
  function readProject(projectRoot, preloadedSnap) {
    if (!projectRoot) return [];
    const p = projectPathFor(projectRoot);
    const snap = preloadedSnap || policySnapshot(p);
    if (snap.missing) return [];
    let raw;
    try { raw = JSON.parse(snap.text); }
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
    let discoveredRules = [], treeFailed = false;
    if (!Array.isArray(args.hosts)) {
      try { discoveredRules = inspectAntigravityProviderTree([]).ruleTargets; }
      catch { treeFailed = true; }
    }
    const hosts = Array.isArray(args.hosts)
      ? args.hosts
      : [...defaultOrchestrationHosts(), ...discoveredRules, ...(Array.isArray(args.additionalHosts) ? args.additionalHosts : [])];
    const items = [];
    if (treeFailed) items.push({ path: "agy-provider-tree", state: "unknown" });
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
    if (Object.prototype.hasOwnProperty.call(args, "scope") && args.scope !== undefined && args.scope !== "global" && args.scope !== "project") {
      throw new Error("invalid orchestration scope: " + String(args.scope));
    }
    const snapshot = readOrchestrationSnapshot(), cfg = snapshot.config;
    const extraSkillPaths = args.extraSkillPaths || args.skillPaths || [];
    let discoveredRules = [], skillTargets = [], treeFailed = false;
    try {
      const tree = inspectAntigravityProviderTree(extraSkillPaths);
      discoveredRules = tree.ruleTargets;
      skillTargets = tree.skillTargets;
    } catch {
      treeFailed = true;
    }
    const hosts = Array.isArray(args.hosts)
      ? args.hosts
      : [...defaultOrchestrationHosts(), ...discoveredRules, ...(Array.isArray(args.additionalHosts) ? args.additionalHosts : [])];
    const discoveredSet = new Set(discoveredRules);
    const directive = cfg.policyVersion === 2 ? buildOrchestrationDirective(cfg).trimEnd() : null;
    const hostResults = [];
    if (treeFailed) hostResults.push({ path: "agy-provider-tree", state: "unknown" });
    for (const file of new Set(hosts)) {
      if (typeof file !== "string" || !path.isAbsolute(file)) continue;
      try {
        assertNoSymlinkPath(file);
        const st = lstatSafe(file);
        if (!st && !Array.isArray(args.hosts) && !discoveredSet.has(file) && !dirExists(path.dirname(file))) continue;
        if (!st) { hostResults.push({ path: file, state: "missing" }); continue; }
        if (!st.isFile() || !(st.mode & 0o444) || st.size > 2 * 1024 * 1024) { hostResults.push({ path: file, state: "unknown" }); continue; }
        const text = fs.readFileSync(file, "utf8"), s = text.indexOf(ORCHESTRATOR_START), e = text.indexOf(ORCHESTRATOR_END);
        if (s < 0 && e < 0) { hostResults.push({ path: file, state: text.includes(SUBAGENT_STOP_HEADER) ? "unknown" : "missing" }); continue; }
        if (s < 0 || e < s || text.indexOf(ORCHESTRATOR_START, s + 1) >= 0 || text.indexOf(ORCHESTRATOR_END, e + 1) >= 0) { hostResults.push({ path: file, state: "unknown" }); continue; }
        const block = text.slice(s, e + ORCHESTRATOR_END.length);
        hostResults.push({ path: file, state: directive && block === directive ? "applied" : "different" });
      } catch { hostResults.push({ path: file, state: "unknown" }); }
    }
    const skillResults = [];
    let skillsApplied = false;
    if (cfg.policyVersion === 2 && !treeFailed) {
      try {
        const desiredSkill = renderRoutingSkillMarkdown(effectiveAgentsForSkill(), cfg);
        for (const sf of skillTargets) {
          try {
            const snap = readRegularSnapshot(sf);
            if (snap.missing) skillResults.push({ path: sf, state: "missing" });
            else if (snap.unsafe) skillResults.push({ path: sf, state: "unknown" });
            else if (snap.text === desiredSkill) skillResults.push({ path: sf, state: "applied" });
            else skillResults.push({ path: sf, state: isHubManagedSkillContent(snap.text) ? "different" : "unmanaged" });
          } catch {
            skillResults.push({ path: sf, state: "unknown" });
          }
        }
        skillsApplied = skillResults.length > 0 && skillResults.every((item) => item.state === "applied");
      } catch {
        skillResults.push({ path: globalPath, state: "unknown" });
        skillsApplied = false;
      }
    }
    const globalEffective = cfg.swarmMode === "on" ? "on" : "off";
    const base = { ...cfg, effectiveSwarmMode: globalEffective, modeRevision: snapshot.revision, hostResults, skillResults, skillsApplied, modeApplied: cfg.policyVersion === 2 && !treeFailed && hostResults.length > 0 && hostResults.every(item => item.state === "applied") && skillsApplied, legacyStatus: inspectOrchestrationTargets(args), hostCapabilities: buildHostCapabilities() };
    const projectRoot = args.scope === "global" ? null : (args.projectRoot || args.project);
    if (args.scope === "project" && (typeof projectRoot !== "string" || !projectRoot.trim())) {
      throw new Error("projectRoot required for project scope");
    }
    if (typeof projectRoot === "string" && projectRoot.trim()) {
      const resolved = resolveProjectOrchestration(projectRoot, cfg);
      const checkRoot = resolved.canonicalProjectRoot || canonicalProjectRootForOrchestration(projectRoot);
      const projectRevision = resolved.projectModeRevision || "missing";
      const synced = isProjectRuleSynced(checkRoot, resolved.swarmMode, resolved.effectiveSwarmMode);
      return { ...base, effectiveSwarmMode: resolved.effectiveSwarmMode, projectModeRevision: projectRevision, projectOverride: { swarmMode: resolved.swarmMode, overridesGlobal: resolved.overridesGlobal, effectiveSwarmMode: resolved.effectiveSwarmMode, source: resolved.source || "global", projectRuleSynced: synced, revision: projectRevision, projectModeRevision: projectRevision } };
    }
    return base;
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
    if (snap.unsafe || !snap.raw || !Buffer.from(snap.text, "utf8").equals(snap.raw)) {
      const error = new Error("规则文件不可安全读取: " + file, { cause: snap.error });
      if (snap.error?.code) error.code = snap.error.code;
      throw error;
    }
    const st = lstatSafe(file);
    if (!st || !(st.mode & 0o444)) throw new Error("规则文件不可读取: " + file);
    return { missing: false, text: snap.text, dev: snap.dev, ino: snap.ino, mode: st.mode & 0o777 };
  }
  function policyTargets(syncArgs) {
    const explicit = Array.isArray(syncArgs.hosts) ? syncArgs.hosts : [];
    const paths = [];
    if (explicit.length) {
      for (const item of explicit) if (typeof item === "string") paths.push(path.resolve(item));
    } else if (!Array.isArray(syncArgs.hosts)) {
      for (const file of defaultOrchestrationHosts()) {
        try { if (fileExists(file) || dirExists(path.dirname(file))) paths.push(file); }
        catch { paths.push(file); }
      }
    }
    for (const file of Array.isArray(syncArgs.additionalHosts) ? syncArgs.additionalHosts : []) if (typeof file === "string" && path.isAbsolute(file)) paths.push(file);
    return [...new Set(paths)];
  }
  function writePolicySnapshot(file, before, intended, tx, writeOptions = {}) {
    let published = false;
    const result = transformTextFileAtomic(file, () => intended, {
      ...writeOptions, expectedSnapshot: before,
      onPublish(meta) {
        published = true;
        tx.journal.push({ path: file, before, after: intended, dev: meta.dev, ino: meta.ino });
      },
    });
    const after = policySnapshot(file);
    const identity = result.changed ? result : before;
    if (after.missing || after.text !== intended || after.dev !== identity.dev || after.ino !== identity.ino) {
      // An idempotent missing/empty target is valid only when no creation was requested.
      if (!result.changed && before.missing && after.missing && intended === "") {
        tx.validations?.push({ path: file, missing: true, after: "" });
        return result;
      }
      throw new Error("写入后文件被其他操作修改: " + file);
    }
    if (result.changed && !published) throw new Error("缺少发布记录: " + file);
    tx.validations?.push({ path: file, after: intended, dev: after.dev, ino: after.ino });
    return result;
  }
  function transactionError(cause, rollbackFailures) {
    const error = new Error(rollbackFailures.length
      ? "同步失败，部分文件回滚失败: " + rollbackFailures.map(x => x.path + ": " + x.error).join("; ") + "; 原因: " + String(cause?.message || cause)
      : String(cause?.message || cause), { cause });
    error.rolledBack = rollbackFailures.length === 0;
    error.rollbackFailures = rollbackFailures;
    if (cause?.preservedPath) error.preservedPath = cause.preservedPath;
    return error;
  }
  function validatePolicyTransaction(tx) {
    // Include idempotent targets: an external edit is still a transaction
    // conflict even though this transaction has no write to undo there.
    for (const entry of [...tx.journal, ...(tx.validations || [])]) {
      try {
        const current = policySnapshot(entry.path);
        if (entry.deleted || entry.missing ? !current.missing : current.missing || current.dev !== entry.dev || current.ino !== entry.ino || current.text !== entry.after) throw new Error("事务文件已被其他操作修改: " + entry.path);
      } catch (e) {
        if (!tx.journal.some(write => write.path === entry.path)) tx.journalConflicts.push({ path: entry.path, error: String(e?.message || e) });
        throw e;
      }
    }
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
    const afterSt = lstatSafe(file);
    if (after.missing || after.ino !== result.ino || after.dev !== result.dev || typeof intended !== "string" || after.text !== intended) {
      args.journalConflicts.push({ path: file, error: "写入后文件被其他操作修改，已保留当前内容，请检查" });
      throw new Error("写入后文件被其他操作修改");
    }
    args.journal.push({ path: file, before, after: after.text, dev: after.dev, ino: after.ino });
  }
  function rollbackCreatedPolicyFile(entry) {
    const file = entry.path, lockPath = file + ".t3hub.lock";
    acquireT3HubLock(lockPath);
    let stageDir = null, staged = null, fd = null;
    try {
      const current = policySnapshot(file);
      if (current.missing || current.ino !== entry.ino || (entry.dev !== undefined && current.dev !== entry.dev) || current.text !== entry.after) throw new Error("文件已被其他操作修改");
      stageDir = fs.mkdtempSync(file + ".rollback-"); staged = path.join(stageDir, "owned");
      fs.renameSync(file, staged);
      try {
        fd = fs.openSync(staged, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const snap = readUtf8FromFdAtZero(fd);
        if (snap.st.ino !== entry.ino || (entry.dev !== undefined && snap.st.dev !== entry.dev) || snap.raw === null || snap.text !== entry.after) throw new Error("文件在回滚中被修改");
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
        if (entry.rollbackBlockedError) throw new Error(entry.rollbackBlockedError);
        if (entry.deleted) {
          const now = policySnapshot(entry.path);
          if (!now.missing && now.dev === entry.before.dev && now.ino === entry.before.ino && now.text === entry.before.text) continue;
          restoreClaudeDeletion(entry.path, entry.before);
        }
        else if (entry.before.missing) rollbackCreatedPolicyFile(entry);
        else {
          const now = policySnapshot(entry.path);
          const wantMode = typeof entry.before.mode === "number" ? (entry.before.mode & 0o777) : null;
          if (!now.missing && now.dev === entry.before.dev && now.ino === entry.before.ino && now.text === entry.before.text && (wantMode === null || now.mode === wantMode)) continue;
          if (now.missing || now.ino !== entry.ino || (entry.dev !== undefined && now.dev !== entry.dev) || now.text !== entry.after) throw new Error("文件已被其他操作修改");
          const restored = transformTextFileAtomic(entry.path, (existing) => {
            const st = lstatSafe(entry.path);
            if (!st || st.ino !== entry.ino || (entry.dev !== undefined && st.dev !== entry.dev) || existing !== entry.after) throw new Error("文件已被其他操作修改");
            return entry.before.text;
          }, { createIfMissing: false, ...(wantMode !== null ? { forceMode: wantMode } : {}) });
          if (!restored.changed && entry.before.text !== entry.after) throw new Error("文件已被其他操作删除");
          if (!restored.changed && wantMode !== null) {
            const st = lstatSafe(entry.path);
            if (st && st.isFile() && st.ino === entry.ino && (st.mode & 0o777) !== wantMode) fs.chmodSync(entry.path, wantMode);
          }
        }
      } catch (e) { failures.push({ path: entry.path, error: String(e?.message || e), ...(e?.preservedPath ? { preservedPath: e.preservedPath } : {}) }); }
    }
    return failures;
  }

  function safeDirExists(p) {
    assertNoSymlinkPath(p);
    try {
      const st = fs.statSync(p);
      return st.isDirectory();
    } catch (e) {
      if (e && e.code === "ENOENT") return false;
      throw e;
    }
  }
  function inspectAntigravityProviderTree(extraSkillPaths) {
    const extras = Array.isArray(extraSkillPaths) ? extraSkillPaths : [];
    const targets = [
      path.join(hubDir, "skills", "t3-subagent-routing", "SKILL.md"),
      path.join(homeDir, ".agents", "skills", "t3-subagent-routing", "SKILL.md"),
    ];
    const ruleTargets = [];
    const instanceNames = [];
    const dirIds = [];
    const pkgDirs = {};
    const fileDigests = {};
    const recordRuleDigest = (rf, rfSt) => {
      if (rfSt) {
        if (rfSt.isSymbolicLink() || !rfSt.isFile()) throw new Error("AGY 规则文件不是普通文件: " + rf);
        const snap = policySnapshot(rf);
        composeOrchestratorBlock(snap.text, null);
        fileDigests[rf] = `${snap.dev}:${snap.ino}:${crypto.createHash("sha256").update(snap.text, "utf8").digest("hex")}`;
      } else {
        fileDigests[rf] = "missing";
      }
    };
    const geminiAgyDir = path.join(homeDir, ".gemini", "antigravity");
    assertNoSymlinkPath(geminiAgyDir);
    let gemSt = null;
    try { gemSt = fs.lstatSync(geminiAgyDir); }
    catch (e) {
      if (!e || e.code !== "ENOENT") throw new Error("AGY 全局目录不可读取: " + String((e && e.message) || e));
    }
    if (gemSt) {
      if (gemSt.isSymbolicLink() || !gemSt.isDirectory()) throw new Error("AGY 全局目录不是普通目录: " + geminiAgyDir);
      try { fs.readdirSync(geminiAgyDir); }
      catch (e) { throw new Error("AGY 全局目录不可枚举: " + geminiAgyDir + ": " + String((e && e.message) || e)); }
      dirIds.push(`gem:${gemSt.dev}:${gemSt.ino}`);
      const gemRulesDir = path.join(geminiAgyDir, "rules");
      let grSt = null;
      try { grSt = fs.lstatSync(gemRulesDir); }
      catch (e) {
        if (!e || e.code !== "ENOENT") throw new Error("AGY 全局规则目录不可读取: " + String((e && e.message) || e));
      }
      const gemRulesFile = path.join(gemRulesDir, "AGENTS.md");
      if (grSt) {
        if (grSt.isSymbolicLink() || !grSt.isDirectory()) throw new Error("AGY 全局规则目录不是普通目录: " + gemRulesDir);
        pkgDirs[gemRulesDir] = `${grSt.dev}:${grSt.ino}`;
        try { fs.readdirSync(gemRulesDir); }
        catch (e) { throw new Error("AGY 全局规则目录不可枚举: " + gemRulesDir + ": " + String((e && e.message) || e)); }
        let gfSt = null;
        try { gfSt = fs.lstatSync(gemRulesFile); }
        catch (e) {
          if (!e || e.code !== "ENOENT") throw new Error("AGY 全局规则文件不可读取: " + String((e && e.message) || e));
        }
        recordRuleDigest(gemRulesFile, gfSt);
      } else {
        pkgDirs[gemRulesDir] = null;
        recordRuleDigest(gemRulesFile, null);
      }
      ruleTargets.push(gemRulesFile);
    }
    const agyRoot = path.join(resolveT3UserdataDir(), "providers", "antigravity");
    // AGY enumeration errors must abort the transaction, not silently truncate.
    // Missing root is a legitimate first-install state; anything else (symlinks,
    // regular files, EACCES/EIO) is fatal.
    assertNoSymlinkPath(agyRoot);
    let rootSt = null;
    try { rootSt = fs.lstatSync(agyRoot); }
    catch (e) {
      if (!e || e.code !== "ENOENT") throw new Error("AGY 技能目录不可读取: " + String((e && e.message) || e));
    }
    if (rootSt) {
      if (rootSt.isSymbolicLink()) throw new Error("AGY 技能目录是符号链接: " + agyRoot);
      if (!rootSt.isDirectory()) throw new Error("AGY 技能目录不是目录: " + agyRoot);
      dirIds.push(`agyRoot:${rootSt.dev}:${rootSt.ino}`);
      let entries;
      try { entries = fs.readdirSync(agyRoot, { withFileTypes: true }); }
      catch (e) { throw new Error("AGY 技能目录枚举失败: " + String((e && e.message) || e)); }
      for (const ent of entries) {
        const instDir = path.join(agyRoot, ent.name);
        let instSt = null;
        try { instSt = fs.lstatSync(instDir); }
        catch (e) {
          if (e && e.code === "ENOENT") continue;
          throw new Error("AGY 实例目录不可读取: " + instDir + ": " + String((e && e.message) || e));
        }
        if (ent.name === ".DS_Store" || ent.name === ".localized") {
          if (instSt.isSymbolicLink() || !instSt.isFile()) throw new Error("AGY 根目录存在非法元数据项: " + instDir);
          continue;
        }
        if (ent.name.startsWith("skills-archived")) {
          if (instSt.isSymbolicLink()) throw new Error("AGY 归档目录是符号链接: " + instDir);
          if (!instSt.isDirectory()) throw new Error("AGY 归档项不是普通目录: " + instDir);
          continue;
        }
        if (instSt.isSymbolicLink()) throw new Error("AGY 实例目录是符号链接: " + instDir);
        if (!instSt.isDirectory()) throw new Error("AGY 实例目录不是普通目录: " + instDir);
        try { fs.readdirSync(instDir); }
        catch (e) { throw new Error("AGY 实例目录不可枚举: " + instDir + ": " + String((e && e.message) || e)); }
        instanceNames.push(ent.name);
        dirIds.push(`inst:${ent.name}:${instSt.dev}:${instSt.ino}`);
        const cfgDir = path.join(instDir, "config");
        let cfgSt = null;
        try { cfgSt = fs.lstatSync(cfgDir); }
        catch (e) {
          if (e && e.code === "ENOENT") continue;
          throw new Error("AGY 配置目录不可读取: " + cfgDir + ": " + String((e && e.message) || e));
        }
        if (cfgSt.isSymbolicLink() || !cfgSt.isDirectory()) throw new Error("AGY 配置目录不是普通目录: " + cfgDir);
        try { fs.readdirSync(cfgDir); }
        catch (e) { throw new Error("AGY 配置目录不可枚举: " + cfgDir + ": " + String((e && e.message) || e)); }
        dirIds.push(`cfg:${ent.name}:${cfgSt.dev}:${cfgSt.ino}`);
        const rulesDir = path.join(cfgDir, "rules");
        let rulesSt = null;
        try { rulesSt = fs.lstatSync(rulesDir); }
        catch (e) {
          if (!e || e.code !== "ENOENT") throw new Error("AGY 规则子目录不可读取: " + rulesDir + ": " + String((e && e.message) || e));
        }
        if (rulesSt) {
          if (rulesSt.isSymbolicLink() || !rulesSt.isDirectory()) throw new Error("AGY 规则子目录不是普通目录: " + rulesDir);
          try { fs.readdirSync(rulesDir); }
          catch (e) { throw new Error("AGY 规则子目录不可枚举: " + rulesDir + ": " + String((e && e.message) || e)); }
          dirIds.push(`rules:${ent.name}:${rulesSt.dev}:${rulesSt.ino}`);
          const rulesFile = path.join(rulesDir, "AGENTS.md");
          let rfSt = null;
          try { rfSt = fs.lstatSync(rulesFile); }
          catch (e) {
            if (!e || e.code !== "ENOENT") throw new Error("AGY 规则文件不可读取: " + rulesFile + ": " + String((e && e.message) || e));
          }
          recordRuleDigest(rulesFile, rfSt);
          ruleTargets.push(rulesFile);
        }
        const skillsDir = path.join(cfgDir, "skills");
        let skillsSt = null;
        try { skillsSt = fs.lstatSync(skillsDir); }
        catch (e) {
          if (e && e.code === "ENOENT") continue;
          throw new Error("AGY 技能子目录不可读取: " + skillsDir + ": " + String((e && e.message) || e));
        }
        if (skillsSt.isSymbolicLink() || !skillsSt.isDirectory()) throw new Error("AGY 技能子目录不是普通目录: " + skillsDir);
        try { fs.readdirSync(skillsDir); }
        catch (e) { throw new Error("AGY 技能子目录不可枚举: " + skillsDir + ": " + String((e && e.message) || e)); }
        dirIds.push(`skills:${ent.name}:${skillsSt.dev}:${skillsSt.ino}`);
        const pkgDir = path.join(skillsDir, "t3-subagent-routing");
        let pkgSt = null;
        try { pkgSt = fs.lstatSync(pkgDir); }
        catch (e) {
          if (!e || e.code !== "ENOENT") throw new Error("AGY 路由技能包目录不可读取: " + pkgDir + ": " + String((e && e.message) || e));
        }
        if (pkgSt) {
          if (pkgSt.isSymbolicLink() || !pkgSt.isDirectory()) throw new Error("AGY 路由技能包目录不是普通目录: " + pkgDir);
          try { fs.readdirSync(pkgDir); }
          catch (e) { throw new Error("AGY 路由技能包目录不可枚举: " + pkgDir + ": " + String((e && e.message) || e)); }
          pkgDirs[pkgDir] = `${pkgSt.dev}:${pkgSt.ino}`;
        } else {
          pkgDirs[pkgDir] = null;
        }
        targets.push(path.join(skillsDir, "t3-subagent-routing", "SKILL.md"));
      }
    }
    for (const p of extras) {
      if (typeof p !== "string" || !p.trim()) continue;
      targets.push(path.isAbsolute(p) ? path.resolve(p) : path.resolve(p));
    }
    const skillTargets = [...new Set(targets)].sort();
    const sortedRuleTargets = [...new Set(ruleTargets)].sort();
    for (const sk of skillTargets) {
      const skSnap = readRegularSnapshot(sk);
      if (skSnap.missing) fileDigests[sk] = "missing";
      else if (skSnap.unsafe || !skSnap.raw) fileDigests[sk] = "unsafe";
      else fileDigests[sk] = `${skSnap.dev}:${skSnap.ino}:${crypto.createHash("sha256").update(skSnap.raw).digest("hex")}`;
    }
    return {
      skillTargets,
      ruleTargets: sortedRuleTargets,
      pkgDirs,
      fileDigests,
      instanceSignature: JSON.stringify({
        instances: instanceNames.slice().sort(),
        rules: sortedRuleTargets,
        skills: skillTargets,
        dirs: dirIds.slice().sort(),
      }),
    };
  }
  function assertPostAntigravityTreeUnchanged(preflightTree, postTree, tx) {
    if (!preflightTree || !postTree || postTree.instanceSignature !== preflightTree.instanceSignature) {
      throw new Error("事务期间宿主实例发生变化，请重新读取后再保存");
    }
    const txWrites = [...(tx?.journal || []), ...(tx?.validations || [])];
    for (const [pkgDir, preId] of Object.entries(preflightTree.pkgDirs || {})) {
      if (preId !== null && postTree.pkgDirs?.[pkgDir] !== preId) {
        throw new Error("事务期间宿主路由技能目录被替换，请重新读取后再保存");
      }
      if (preId === null && postTree.pkgDirs?.[pkgDir] != null && !txWrites.some((w) => path.dirname(w.path) === pkgDir)) {
        throw new Error("事务期间宿主实例发生变化，请重新读取后再保存");
      }
    }
    for (const target of [...postTree.ruleTargets, ...postTree.skillTargets]) {
      let txEntry = null;
      for (let i = txWrites.length - 1; i >= 0; i--) {
        if (txWrites[i].path === target) { txEntry = txWrites[i]; break; }
      }
      if (txEntry) {
        const cur = policySnapshot(target);
        const matches = (txEntry.deleted || txEntry.missing)
          ? cur.missing
          : (!cur.missing && cur.dev === txEntry.dev && cur.ino === txEntry.ino && cur.text === txEntry.after);
        if (!matches) throw new Error("事务期间宿主实例文件被替换: " + target);
      } else if (Object.hasOwn(preflightTree.fileDigests || {}, target)) {
        if (postTree.fileDigests?.[target] !== preflightTree.fileDigests[target]) {
          throw new Error("事务期间未纳入写入的宿主实例文件发生变化: " + target);
        }
      }
    }
  }
  function defaultRoutingSkillTargets(extraSkillPaths) {
    return inspectAntigravityProviderTree(extraSkillPaths).skillTargets;
  }
  function classifyRoutingSkillFile(file, adoptUnmanagedSkillHashes = {}) {
    // Only a readable regular file confirmed as the user's custom unmanaged
    // skill may be skipped. I/O errors, symlinks, special files and unsafe
    // snapshots abort the whole transaction.
    assertNoSymlinkPath(file);
    const st = lstatSafe(file);
    if (!st) return { file, action: "create", snap: { missing: true, text: "" } };
    if (st.isSymbolicLink()) throw new Error("unsafe symlink skill: " + file);
    if (!st.isFile()) throw new Error("non-regular skill file: " + file);
    const snap = readRegularSnapshot(file);
    if (snap.missing) return { file, action: "create", snap: { missing: true, text: "" } };
    if (snap.unsafe) throw new Error("unsafe skill snapshot: " + file + (snap.error ? " (" + String(snap.error.message || snap.error) + ")" : ""));
    if ((isHubManagedSkillContent(snap.text) || Object.hasOwn(adoptUnmanagedSkillHashes, file)) && !Buffer.from(snap.text, "utf8").equals(snap.raw)) throw new Error("Skill 不是可安全回滚的 UTF-8 文件: " + file);
    if (isHubManagedSkillContent(snap.text)) return { file, action: "update", snap: { missing: false, text: snap.text, dev: snap.dev, ino: snap.ino } };
    const expectedHash = Object.hasOwn(adoptUnmanagedSkillHashes, file) ? adoptUnmanagedSkillHashes[file] : null;
    if (typeof expectedHash === "string" && /^[a-f0-9]{64}$/.test(expectedHash) && crypto.createHash("sha256").update(snap.raw).digest("hex") === expectedHash) {
      return { file, action: "adopt", snap: { missing: false, text: snap.text, dev: snap.dev, ino: snap.ino } };
    }
    return { file, action: "skip", reason: "unmanaged-user-file", skippedUnmanaged: true };
  }
  function planRoutingSkillSync(effectiveAgents, orchestrationCfg, extraSkillPaths, adoptUnmanagedSkillHashes) {
    const desired = renderRoutingSkillMarkdown(effectiveAgents, orchestrationCfg);
    const paths = defaultRoutingSkillTargets(extraSkillPaths);
    const plans = paths.map((p) => classifyRoutingSkillFile(p, adoptUnmanagedSkillHashes));
    return { desired, paths, plans };
  }
  function applyRoutingSkillSync(planned, syncArgs = {}) {
    const { desired, plans } = planned;
    const updated = [], skippedUnmanaged = [], errors = [], results = [];
    for (const plan of plans) {
      const file = plan.file;
      if (plan.action === "skip") {
        skippedUnmanaged.push(file);
        results.push({ path: file, ok: false, skippedUnmanaged: true, error: plan.reason || "unmanaged-user-file" });
        continue;
      }
      try {
        const expected = syncArgs.expectedSnapshots ? syncArgs.expectedSnapshots.get(file) : plan.snap;
        if (syncArgs.expectedSnapshots && !expected) throw new Error("缺少事务快照");
        // Strict CAS: bind to the preflight snapshot {dev, ino, content}.
        const cur = readRegularSnapshot(file);
        if (expected.missing !== cur.missing) throw new Error("规则文件已变更，请重新读取: " + file);
        if (!expected.missing) {
          if (cur.unsafe) throw new Error("规则文件不可安全读取: " + file);
          if ((expected.dev !== undefined && cur.dev !== expected.dev) || (expected.ino !== undefined && cur.ino !== expected.ino) || cur.text !== expected.text) {
            throw new Error("规则文件已变更，请重新读取: " + file);
          }
        }
        if (plan.action === "adopt") {
          backupOnceWithJournal(file, expected, syncArgs.backupJournal);
          // After backup, re-verify the skill itself did not change under us.
          const cur2 = readRegularSnapshot(file);
          if (cur2.missing !== expected.missing || (!expected.missing && (cur2.unsafe || cur2.dev !== expected.dev || cur2.ino !== expected.ino || cur2.text !== expected.text))) throw new Error("规则文件已变更，请重新读取: " + file);
        }
        const changed = writePolicySnapshot(file, expected, desired, syncArgs, { createIfMissing: true, backup: false });
        if (changed && changed.changed) updated.push(file);
        results.push({ path: file, ok: true, changed: Boolean(changed && changed.changed) });
      } catch (e) {
        errors.push({ path: file, error: String((e && e.message) || e) });
        results.push({ path: file, ok: false, error: String((e && e.message) || e) });
      }
    }
    return { ok: errors.length === 0, updated, skippedUnmanaged, errors, results };
  }
  function backupOnceWithJournal(file, expected, backupJournal) {
    const bak = file + ".bak-t3hub";
    const before = policySnapshot(bak);
    if (!before.missing && before.text === expected.text) return;
    // Record published inodes before readback. If a prior unmanaged backup already
    // exists with different content, rotate it into a timestamped archive so neither
    // the original nor the newly adopted unmanaged skill is ever lost.
    const tx = { journal: [] };
    try {
      if (!before.missing) {
        let archivePath = null, archiveBefore = null;
        for (let attempt = 0; attempt < 8; attempt++) {
          const candidate = `${bak}.${Date.now()}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
          const snap = policySnapshot(candidate);
          if (snap.missing) { archivePath = candidate; archiveBefore = snap; break; }
        }
        if (!archivePath) throw new Error("无法分配旧备份归档路径: " + bak);
        writePolicySnapshot(archivePath, archiveBefore, before.text, tx, { createIfMissing: true, defaultMode: 0o600 });
      }
      writePolicySnapshot(bak, before, expected.text, tx, { createIfMissing: true, defaultMode: 0o600 });
    } finally {
      if (Array.isArray(backupJournal)) {
        for (const entry of tx.journal) backupJournal.push(entry);
      }
    }
  }
  function cleanupCreatedBackups(backupJournal) {
    return rollbackPolicyWrites(backupJournal || []);
  }
  function effectiveAgentsForSkill(projectRoot) {
    const globals = withReviewTierDefaults(readGlobal(policySnapshot(globalPath), false));
    return buildEffective(globals, projectRoot ? readProject(projectRoot) : []);
  }
  function orchestrationCfgForSkill() {
    return readOrchestrationSnapshot().config;
  }
  function syncRoutingSkillTargets(args = {}) {
    const planned = args._skillPlanned || planRoutingSkillSync(
      args.effectiveAgents || effectiveAgentsForSkill(args.projectRoot),
      args.orchestrationCfg ? normalizeOrchestrationConfig(args.orchestrationCfg) : orchestrationCfgForSkill(),
      args.extraSkillPaths || args.extraSyncPaths || args.skillPaths || opts.extraSkillPaths || [],
      args.adoptUnmanagedSkillHashes,
    );
    // A parent transaction owns its journal; direct synchronization gets the
    // same rollback guarantees instead of leaving partial files/backups behind.
    const ownTransaction = !args.journal;
    const tx = { ...args, journal: args.journal || [], backupJournal: args.backupJournal || [], journalConflicts: args.journalConflicts || [], validations: args.validations || [] };
    const result = applyRoutingSkillSync(planned, tx);
    if (result.ok && ownTransaction) {
      try {
        for (const entry of tx.validations) {
          const current = policySnapshot(entry.path);
          if (current.missing || current.dev !== entry.dev || current.ino !== entry.ino || current.text !== entry.after) throw new Error("Skill 同步后被并发修改: " + entry.path);
        }
      } catch (e) { result.ok = false; result.errors.push({ path: null, error: String(e?.message || e) }); }
    }
    if (!result.ok && ownTransaction) {
      const rollbackFailures = [...tx.journalConflicts, ...rollbackPolicyWrites(tx.journal), ...cleanupCreatedBackups(tx.backupJournal)];
      return { ...result, rolledBack: rollbackFailures.length === 0, rollbackFailures };
    }
    return result;
  }
  function canonicalProjectRootForOrchestration(projectRoot) {
    return resolveCanonicalProjectRoot(projectRoot);
  }
  function projectOrchestrationFileFor(projectRoot) {
    return rawProjectOrchestrationFileFor(resolveCanonicalProjectRoot(projectRoot));
  }
  function readProjectOrchestration(projectRoot) {
    const snap = readProjectOrchestrationSnapshot(projectRoot);
    return { swarmMode: snap.swarmMode, raw: snap.raw, revision: snap.revision };
  }
  function readProjectOrchestrationSnapshot(projectRoot) {
    const { canonical, file } = projectOrchestrationFileFor(projectRoot);
    const snap = policySnapshot(file);
    if (snap.missing) return { canonical, file, swarmMode: "inherit", raw: "", revision: "missing" };
    let raw, parsed;
    try { raw = snap.text; parsed = JSON.parse(raw); }
    catch { throw new Error("项目编排配置无法读取，原文件未改动"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("项目编排配置损坏，原文件未改动");
    const m = String(parsed.swarmMode ?? "inherit").toLowerCase();
    if (!["inherit", "on", "off"].includes(m)) throw new Error("项目总指挥覆盖配置无效，原文件未改动");
    return { canonical, file, swarmMode: m, raw, revision: crypto.createHash("sha256").update(raw).digest("hex") };
  }
  function resolveProjectOrchestration(projectRoot, globalCfg) {
    const g = normalizeOrchestrationConfig(globalCfg);
    const globalEffective = g.swarmMode === "on" ? "on" : "off";
    if (!projectRoot || typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)) {
      return { swarmMode: "inherit", overridesGlobal: false, effectiveSwarmMode: globalEffective, source: "global" };
    }
    const current = resolveCanonicalProjectRoot(projectRoot);
    const { file } = rawProjectOrchestrationFileFor(current);
    assertNoSymlinkPath(file);
    if (lstatSafe(file)) {
      const p = readProjectOrchestration(current);
      if (p.swarmMode !== "inherit") return { swarmMode: p.swarmMode, overridesGlobal: true, effectiveSwarmMode: p.swarmMode, source: "project", canonicalProjectRoot: current, projectModeRevision: p.revision || "missing" };
      return { swarmMode: "inherit", overridesGlobal: false, effectiveSwarmMode: globalEffective, source: "global", canonicalProjectRoot: current, projectModeRevision: p.revision || "missing" };
    }
    const projectModeRevision = readProjectOrchestrationSnapshot(current).revision;
    return { swarmMode: "inherit", overridesGlobal: false, effectiveSwarmMode: globalEffective, source: "global", canonicalProjectRoot: current, projectModeRevision };
  }
  function buildProjectOrchestrationDirective(effectiveSwarmMode) {
    const base = buildOrchestrationDirective({ policyVersion: 2, orchestratorMode: "off", swarmMode: effectiveSwarmMode, strictCommanderOnly: effectiveSwarmMode === "on" });
    const note = "项目级覆盖：本项目总指挥模式为 " + effectiveSwarmMode + "（项目 AGENTS.md 托管块）。\n";
    return base.replace(ORCHESTRATOR_END, note + ORCHESTRATOR_END);
  }
  function isProjectRuleSynced(projectRoot, swarmMode, effectiveSwarmMode) {
    try {
      const canonical = canonicalProjectRootForOrchestration(projectRoot);
      const agentsMd = path.join(canonical, "AGENTS.md");
      const st = lstatSafe(agentsMd);
      if (!st) return swarmMode === "inherit";
      if (!st.isFile()) return false;
      const text = fs.readFileSync(agentsMd, "utf8");
      const s = text.indexOf(ORCHESTRATOR_START), e = text.indexOf(ORCHESTRATOR_END);
      if (swarmMode === "inherit") return s < 0 && e < 0;
      if (s < 0 || e < s || text.indexOf(ORCHESTRATOR_START, s + 1) >= 0 || text.indexOf(ORCHESTRATOR_END, e + 1) >= 0) return false;
      const block = text.slice(s, e + ORCHESTRATOR_END.length);
      return block === buildProjectOrchestrationDirective(effectiveSwarmMode).trimEnd();
    } catch { return false; }
  }
  function syncOrchestrationDirectiveToHostsRaw(args = {}) {
    const cfg = args.configOverride ? normalizeOrchestrationConfig(args.configOverride) : getOrchestrationConfig();
    if (cfg.policyVersion !== 2 || cfg.orchestratorMode !== "off" || !["on", "off"].includes(cfg.swarmMode)) throw new Error("旧编排指引已退役，请先明确选择统一协作模式");
    const active = cfg.swarmMode === "on";
    const directive = buildOrchestrationDirective(cfg);
    if (!args.journal) {
      const hasExplicitHosts = Array.isArray(args.hosts) || Array.isArray(args.hostRulePaths) || Array.isArray(args.extraSyncPaths) || Array.isArray(args.host);
      const rawHosts = Array.isArray(args.hosts) ? args.hosts
        : Array.isArray(args.hostRulePaths) ? args.hostRulePaths
        : Array.isArray(args.extraSyncPaths) ? args.extraSyncPaths
        : Array.isArray(args.host) ? args.host : undefined;
      const extraSkills = args.extraSkillPaths || args.skillPaths || [];
      const pfile = orchestrationConfigPath();
      const activePath = activeOrchestrationPath();
      const snapshots = new Map(), expectedContents = new Map();
      const journal = [], journalConflicts = [], backupJournal = [], validations = [];
      let preflightPath = null, preflightTree = null, effAgents = null, skillPlanned = null;
      let effectiveAdditionalHosts = Array.isArray(args.additionalHosts) ? [...args.additionalHosts] : [];
      try {
        effAgents = args.effectiveAgents || effectiveAgentsForSkill();
        preflightPath = "agy-provider-tree";
        preflightTree = inspectAntigravityProviderTree(extraSkills);
        if (!hasExplicitHosts) {
          effectiveAdditionalHosts = [...new Set([...effectiveAdditionalHosts, ...preflightTree.ruleTargets])];
        }
        const targets = policyTargets({
          ...(hasExplicitHosts ? { hosts: rawHosts } : {}),
          additionalHosts: effectiveAdditionalHosts,
        });
        for (const file of targets) {
          preflightPath = file;
          if (file === pfile || file === activePath || isSubagentPolicyTarget(file)) throw new Error("不允许将此文件作为宿主规则目标: " + file);
          const before = policySnapshot(file);
          const planned = composeOrchestratorBlock(before.text, directive);
          expectedContents.set(file, planned === null ? before.text : planned);
          snapshots.set(file, before);
        }
        preflightPath = activePath;
        snapshots.set(activePath, policySnapshot(activePath));
        expectedContents.set(activePath, "# T3 Hub 协作分工\n\n" + directive);
        preflightPath = "routing-skill";
        skillPlanned = args._skillPlanned || planRoutingSkillSync(effAgents, cfg, extraSkills, args.adoptUnmanagedSkillHashes);
        for (const p of skillPlanned.plans) {
          if (p.action === "skip") continue;
          snapshots.set(p.file, p.snap);
          expectedContents.set(p.file, skillPlanned.desired);
        }
      } catch (e) {
        const msg = String(e?.message || e);
        return {
          ok: false,
          error: msg,
          config: cfg,
          active,
          directive,
          hostResults: preflightPath ? [{ path: preflightPath, ok: false, error: msg }] : [],
          skillSync: { ok: false, updated: [], skippedUnmanaged: [], errors: [{ path: preflightPath || "routing-skill", error: msg }], results: [] },
          rolledBack: true,
          rollbackFailures: [],
        };
      }
      const txArgs = {
        ...args,
        configOverride: cfg,
        additionalHosts: effectiveAdditionalHosts,
        effectiveAgents: effAgents,
        _skillPlanned: skillPlanned,
        expectedSnapshots: snapshots,
        expectedContents,
        journal,
        journalConflicts,
        backupJournal,
        validations,
      };
      if (hasExplicitHosts) txArgs.hosts = rawHosts;
      else {
        delete txArgs.hosts;
        delete txArgs.hostRulePaths;
        delete txArgs.extraSyncPaths;
        delete txArgs.host;
      }
      let innerRes = null;
      try {
        innerRes = syncOrchestrationDirectiveToHostsRaw(txArgs);
        if (!innerRes.ok) throw new Error("部分宿主规则同步失败");
        validatePolicyTransaction(txArgs);
        const postTree = inspectAntigravityProviderTree(extraSkills);
        assertPostAntigravityTreeUnchanged(preflightTree, postTree, txArgs);
        return innerRes;
      } catch (e) {
        const rollbackFailures = [...journalConflicts, ...rollbackPolicyWrites(journal), ...cleanupCreatedBackups(backupJournal)];
        return {
          ok: false,
          error: rollbackFailures.length ? "同步失败，部分文件未能自动恢复，请检查标出的文件" : String(e?.message || e),
          config: cfg,
          active,
          directive,
          hostResults: innerRes?.hostResults || [],
          skillSync: innerRes?.skillSync || { ok: false, updated: [], skippedUnmanaged: [], errors: [], results: [] },
          rolledBack: rollbackFailures.length === 0,
          rollbackFailures,
        };
      }
    }
    // Always update hub managed file ACTIVE_ORCHESTRATION_MODE.md
    const results = [];
    try {
      safeMkdir(path.dirname(activeOrchestrationPath()));
      const content = "# T3 Hub 协作分工\n\n" + directive;
      const activePath = activeOrchestrationPath(), expected = args.expectedSnapshots?.get(activePath);
      if (args.expectedSnapshots && !expected) throw new Error("缺少事务快照");
      if (args.journal) writePolicySnapshot(activePath, expected, content, args, { createIfMissing: true });
      else transformTextFileAtomic(activePath, (existing) => {
        if (expected && (Boolean(lstatSafe(activePath)) === expected.missing || existing !== expected.text)) throw new Error("规则文件已变更，请重新读取");
        return content;
      }, { createIfMissing: true });
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
        const changed = args.journal
          ? writePolicySnapshot(fp, expected, args.expectedContents.get(fp), args, { createIfMissing: true, backup: true })
          : writeOrchestratorBlock(fp, directive, expected);
        results.push({ path: fp, ok: true, changed: Boolean(changed?.changed) });
      } catch (e) {
        // Preserve the existing host permission boundary: once a host denies
        // readback, do not try another write to that protected host in this
        // operation. Its publication remains journaled and explicitly failed.
        if (["EACCES", "EPERM"].includes(e?.code)) {
          const entry = args.journal?.find(write => write.path === fp);
          if (entry) entry.rollbackBlockedError = "宿主规则写入后拒绝读取，需手动检查: " + String(e.message || e);
        }
        results.push({ path: fp, ok: false, error: String(e?.message || e) });
      }
    };
    for (const h of hosts) {
      if (typeof h !== "string") continue;
      const fp = path.isAbsolute(h) ? h : path.resolve(String(h));
      applyToHost(fp);
    }
    if (hosts.length === 0 && !Array.isArray(args.hosts) && !Array.isArray(args.hostRulePaths) && !Array.isArray(args.extraSyncPaths) && !Array.isArray(args.host)) {
      const defaults = defaultOrchestrationHosts();
      for (const t of defaults) {
        try { if (fileExists(t) || dirExists(path.dirname(t))) applyToHost(t); }
        catch (e) { results.push({ path: t, ok: false, error: String(e?.message || e) }); }
      }
    }
    for (const fp of Array.isArray(args.additionalHosts) ? args.additionalHosts : []) {
      if (typeof fp === "string" && path.isAbsolute(fp)) applyToHost(fp);
    }
    let skillSync = { ok: true, updated: [], skippedUnmanaged: [], errors: [], results: [] };
    try {
      const effAgents = args.effectiveAgents || effectiveAgentsForSkill();
      const extraSkills = args.extraSkillPaths || args.skillPaths || [];
      // Strictly bind to the preflight plan when present; never re-plan over it.
      let planned = args._skillPlanned || null;
      if (!planned) {
        planned = planRoutingSkillSync(effAgents, cfg, extraSkills, args.adoptUnmanagedSkillHashes);
        if (args.expectedSnapshots) {
          for (const p of planned.plans) {
            if (p.action !== "skip" && !args.expectedSnapshots.has(p.file)) {
              args.expectedSnapshots.set(p.file, p.snap);
              if (args.expectedContents) args.expectedContents.set(p.file, planned.desired);
            }
          }
        }
      } else {
        // Verify re-read skills still match the preflight snapshots (CAS).
        if (args.expectedSnapshots) {
          for (const p of planned.plans) {
            if (p.action === "skip") continue;
            const exp = args.expectedSnapshots.get(p.file);
            if (!exp) throw new Error("缺少事务快照: " + p.file);
            const cur = readRegularSnapshot(p.file);
            if (exp.missing !== cur.missing) throw new Error("规则文件已变更，请重新读取: " + p.file);
            if (!exp.missing) {
              if (cur.unsafe) throw new Error("规则文件不可安全读取: " + p.file);
              if ((exp.dev !== undefined && cur.dev !== exp.dev) || (exp.ino !== undefined && cur.ino !== exp.ino) || cur.text !== exp.text) {
                throw new Error("规则文件已变更，请重新读取: " + p.file);
              }
            }
          }
        }
      }
      skillSync = syncRoutingSkillTargets({ ...args, _skillPlanned: planned });
      if (!skillSync.ok) {
        for (const r of skillSync.results) {
          if (!r.ok && !r.skippedUnmanaged) results.push({ path: r.path, ok: false, error: r.error });
        }
      }
    } catch (e) {
      skillSync = { ok: false, updated: [], skippedUnmanaged: [], errors: [{ path: null, error: String((e && e.message) || e) }], results: [{ path: null, ok: false, error: String((e && e.message) || e) }] };
      results.push({ path: "routing-skill", ok: false, error: String((e && e.message) || e) });
    }
    return { ok: results.every((item) => item.ok), config: cfg, active, directive, hostResults: results, skillSync };
  }
  function updateOrchestrationConfig(patch = {}, opts = {}) {
    const pfile = orchestrationConfigPath();
    const transactionLock = path.join(hubDir, ".orchestration-mode.lock");
    acquireT3HubLock(transactionLock);
    try {
    // Project orchestration override branch (does not touch global config).
    const hasPatchScope = Boolean(patch && Object.prototype.hasOwnProperty.call(patch, "scope") && patch.scope !== undefined);
    const hasOptsScope = Boolean(opts && Object.prototype.hasOwnProperty.call(opts, "scope") && opts.scope !== undefined);
    const patchScope = hasPatchScope ? patch.scope : undefined;
    const optsScope = hasOptsScope ? opts.scope : undefined;
    if (hasPatchScope && patchScope !== "global" && patchScope !== "project") {
      throw new Error("invalid orchestration scope: " + String(patchScope));
    }
    if (hasOptsScope && optsScope !== "global" && optsScope !== "project") {
      throw new Error("invalid orchestration scope: " + String(optsScope));
    }
    if (hasPatchScope && hasOptsScope && patchScope !== optsScope) {
      throw new Error("conflicting orchestration scope");
    }
    const hasPatchProjectRoot = Boolean(patch && Object.prototype.hasOwnProperty.call(patch, "projectRoot") && patch.projectRoot !== undefined);
    const hasOptsProjectRoot = Boolean(opts && Object.prototype.hasOwnProperty.call(opts, "projectRoot") && opts.projectRoot !== undefined);
    if (hasPatchProjectRoot && hasOptsProjectRoot && patch.projectRoot !== opts.projectRoot) {
      throw new Error("conflicting orchestration projectRoot");
    }
    const hasPatchRev = Boolean(patch && Object.prototype.hasOwnProperty.call(patch, "expectedRevision") && patch.expectedRevision !== undefined);
    const hasOptsRev = Boolean(opts && Object.prototype.hasOwnProperty.call(opts, "expectedRevision") && opts.expectedRevision !== undefined);
    if (hasPatchRev && hasOptsRev && patch.expectedRevision !== opts.expectedRevision) {
      throw new Error("conflicting orchestration expectedRevision");
    }
    let isProjectIntent = false;
    if (patchScope === "project" || optsScope === "project") isProjectIntent = true;
    else if (hasPatchProjectRoot || hasOptsProjectRoot) {
      if (patchScope === "global" || optsScope === "global") isProjectIntent = false;
      else isProjectIntent = true;
    }
    let projectRoot = null;
    if (isProjectIntent) {
      const candidate = hasOptsProjectRoot ? opts.projectRoot : patch.projectRoot;
      if (typeof candidate !== "string" || !candidate.trim()) throw new Error("projectRoot required for project scope and must be a non-empty absolute path");
      if (!path.isAbsolute(candidate)) throw new Error("projectRoot must be an absolute path and an existing directory");
      const abs = candidate.trim();
      assertNoSymlinkPath(abs);
      let st = null;
      try { st = fs.statSync(abs); }
      catch (e) { throw new Error("projectRoot must be an existing directory: " + String((e && e.message) || e)); }
      if (!st.isDirectory()) throw new Error("projectRoot must be an existing directory: " + abs);
      // lstat chain already enforced by assertNoSymlinkPath; symlink itself is rejected above.
      projectRoot = abs;
    }
    if (isProjectIntent) {
      const snapshot0 = readOrchestrationSnapshot(), globalCfg0 = snapshot0.config;
      const targetMode = String(patch.swarmMode || "").toLowerCase();
      if (!["inherit", "on", "off"].includes(targetMode)) throw new Error("项目总指挥覆盖请选择 inherit、常规协作或总指挥模式");
      const { canonical, dir, file: projFile } = projectOrchestrationFileFor(projectRoot);
      // Independent project revision CAS (symmetric with global expectedRevision).
      const projBefore = readProjectOrchestrationSnapshot(canonical);
      const expectedRev = hasPatchRev ? patch.expectedRevision : opts?.expectedRevision;
      if (typeof expectedRev !== "string" || !expectedRev || expectedRev !== projBefore.revision) {
        return { ok: false, error: "项目协作模式已变更，请重新读取后再保存", config: globalCfg0, projectRoot: canonical, rolledBack: true, rollbackFailures: [] };
      }
      const agentsMd = path.join(canonical, "AGENTS.md");
      const beforeSnap = policySnapshot(agentsMd);
      const directive = targetMode === "inherit" ? null : buildProjectOrchestrationDirective(targetMode);
      const plannedComposed = composeOrchestratorBlock(beforeSnap.text, directive);
      const plannedText = plannedComposed === null ? beforeSnap.text : plannedComposed;
      const tx = { journal: [], journalConflicts: [], backupJournal: [], validations: [] };
      const projBeforeSnap = policySnapshot(projFile);
      if ((projBeforeSnap.missing ? "missing" : crypto.createHash("sha256").update(projBeforeSnap.text).digest("hex")) !== projBefore.revision) throw new Error("项目协作模式已变更，请重新读取后再保存");
      const newProjText = JSON.stringify({ swarmMode: targetMode }, null, 2) + "\n";
      const expectedAfterRev = crypto.createHash("sha256").update(newProjText).digest("hex");
      try {
        if (plannedText !== beforeSnap.text) writePolicySnapshot(agentsMd, beforeSnap, plannedText, tx, { backup: true, createIfMissing: Boolean(directive) });
        writePolicySnapshot(projFile, projBeforeSnap, newProjText, tx, { createIfMissing: true, defaultMode: 0o600 });
        // Verify after publication AND lock release. Never discard afterRev or
        // report success for a configuration whose mode disagrees with rules.
        const after = readProjectOrchestrationSnapshot(canonical);
        if (after.revision !== expectedAfterRev || after.raw !== newProjText || after.swarmMode !== targetMode) throw new Error("项目编排配置写入后已变更，请重新读取");
        const effectiveMode = targetMode === "inherit" ? (globalCfg0.swarmMode === "on" ? "on" : "off") : targetMode;
        const synced = isProjectRuleSynced(canonical, targetMode, effectiveMode);
        if (!synced) throw new Error("项目规则与编排配置不一致，请重新读取");
        for (const entry of [...tx.journal, ...tx.validations]) {
          const current = policySnapshot(entry.path);
          if (current.missing || current.dev !== entry.dev || current.ino !== entry.ino || current.text !== entry.after) throw new Error("项目事务文件写入后已变更: " + entry.path);
        }
        const projectOverride = { swarmMode: targetMode, overridesGlobal: targetMode !== "inherit", effectiveSwarmMode: effectiveMode, source: targetMode === "inherit" ? "global" : "project", projectRuleSynced: true, revision: after.revision, projectModeRevision: after.revision };
        return { ok: true, config: globalCfg0, projectRoot: canonical, projectModeRevision: after.revision, projectOverride, projectRuleSynced: true, skillSync: { ok: true, updated: [], skippedUnmanaged: [], errors: [], results: [] } };
      } catch (e) {
        const error = transactionError(e, [...tx.journalConflicts, ...rollbackPolicyWrites(tx.journal)]);
        return { ok: false, error: error.message, config: globalCfg0, projectRoot: canonical, rolledBack: error.rolledBack, rollbackFailures: error.rollbackFailures };
      }
    }
    const snapshot = readOrchestrationSnapshot(), current = snapshot.config;
    const globalExpectedRev = hasPatchRev ? patch.expectedRevision : opts?.expectedRevision;
    if (typeof globalExpectedRev !== "string" || globalExpectedRev !== snapshot.revision) throw new Error("协作模式已变更，请重新读取后再保存");
    if (!["on", "off"].includes(patch.swarmMode) || patch.orchestratorMode && patch.orchestratorMode !== "off") throw new Error("请选择常规协作或总指挥模式");
    const merged = { ...current, ...(patch || {}) };
    // Remove hostRulePaths/hosts from merged before persisting
    const hostRulePaths = opts.hostRulePaths || opts.hosts || opts.extraSyncPaths || merged.hostRulePaths || merged.hosts || null;
    delete merged.hostRulePaths;
    delete merged.hosts;
    delete merged.host;
    delete merged.expectedRevision;
    delete merged.scope;
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
    const skillExtraPaths = opts.extraSkillPaths || opts.skillPaths || patch.extraSkillPaths || patch.skillPaths || [];
    if (Array.isArray(skillExtraPaths)) syncArgs.extraSkillPaths = skillExtraPaths;
    // Corrupted subagents.json must abort preflight, never fall back to defaults.
    try { syncArgs.effectiveAgents = effectiveAgentsForSkill(); }
    catch (e) {
      return { ok: false, error: String((e && e.message) || e), config: current, desiredConfig: normalized, hostResults: [{ path: globalPath, ok: false, error: String((e && e.message) || e) }], rolledBack: true, rollbackFailures: [], skillSync: { ok: false, updated: [], skippedUnmanaged: [], errors: [{ path: globalPath, error: String((e && e.message) || e) }], results: [] } };
    }
    syncArgs._skillPlanned = null;
    const directive = buildOrchestrationDirective(normalized), snapshots = new Map(), expectedContents = new Map(), journal = [], journalConflicts = [], backupJournal = [], validations = [];
    syncArgs.backupJournal = backupJournal;
    syncArgs.validations = validations;
    let preflightPath = null;
    let pfileSnap;
    let preflightTree = null;
    try {
      preflightPath = "agy-provider-tree";
      preflightTree = inspectAntigravityProviderTree(skillExtraPaths);
      if (!Array.isArray(syncArgs.hosts)) {
        syncArgs.additionalHosts = [
          ...new Set([
            ...(Array.isArray(syncArgs.additionalHosts) ? syncArgs.additionalHosts : []),
            ...preflightTree.ruleTargets,
          ]),
        ];
      }
      const paths = policyTargets(syncArgs);
      preflightPath = pfile;
      pfileSnap = policySnapshot(pfile);
      if ((pfileSnap.missing ? "missing" : crypto.createHash("sha256").update(pfileSnap.text).digest("hex")) !== snapshot.revision) throw new Error("协作模式已变更，请重新读取后再保存");
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
      preflightPath = "routing-skill";
      const skillPlanned = planRoutingSkillSync(syncArgs.effectiveAgents, normalized, skillExtraPaths, opts.adoptUnmanagedSkillHashes || patch.adoptUnmanagedSkillHashes);
      syncArgs._skillPlanned = skillPlanned;
      for (const p of skillPlanned.plans) {
        if (p.action === "skip") continue;
        snapshots.set(p.file, p.snap);
        expectedContents.set(p.file, skillPlanned.desired);
      }
      if (readOrchestrationSnapshot().revision !== snapshot.revision) throw new Error("协作模式已变更，请重新读取后再保存");
    } catch (e) {
      return { ok: false, error: String(e?.message || e), config: current, desiredConfig: normalized, hostResults: preflightPath ? [{ path: preflightPath, ok: false, error: String(e?.message || e) }] : [], rolledBack: true, rollbackFailures: [], skillSync: { ok: false, updated: [], skippedUnmanaged: [], errors: [{ path: preflightPath || "routing-skill", error: String(e?.message || e) }], results: [] } };
    }
    syncArgs.expectedSnapshots = snapshots; syncArgs.expectedContents = expectedContents; syncArgs.journal = journal; syncArgs.journalConflicts = journalConflicts;
    let syncResult = null;
    try {
      syncResult = syncOrchestrationDirectiveToHostsRaw(syncArgs);
      if (!syncResult.ok) throw new Error("部分宿主规则同步失败");
      writePolicySnapshot(pfile, pfileSnap, JSON.stringify(normalized, null, 2) + "\n", syncArgs, { createIfMissing: true, defaultMode: 0o600 });
      validatePolicyTransaction(syncArgs);
      const postTree = inspectAntigravityProviderTree(skillExtraPaths);
      assertPostAntigravityTreeUnchanged(preflightTree, postTree, syncArgs);
      // A successful transaction may deliberately preserve an unmanaged Skill.
      // Only targets written and verified by this transaction count as applied.
      const skillResults = postTree.skillTargets.map((file) => {
        const result = syncResult.skillSync.results.find((item) => item.path === file);
        return { path: file, state: result?.ok ? "applied" : result?.skippedUnmanaged ? "unmanaged" : "unknown" };
      });
      const skillsApplied = skillResults.length > 0 && skillResults.every((item) => item.state === "applied");
      const modeApplied = skillsApplied && syncResult.hostResults.length > 0 && syncResult.hostResults.every((item) => item.ok);
      return { ...syncResult, config: normalized, skillResults, skillsApplied, modeApplied };
    } catch (e) {
      const rollbackFailures = [...journalConflicts, ...rollbackPolicyWrites(journal)];
      rollbackFailures.push(...cleanupCreatedBackups(backupJournal));
      return { ok: false, error: rollbackFailures.length ? "同步失败，部分文件未能自动恢复，请检查标出的文件" : String(e?.message || e), config: current, desiredConfig: normalized, hostResults: syncResult?.hostResults || [], rolledBack: rollbackFailures.length === 0, rollbackFailures, skillSync: syncResult?.skillSync || { ok: false, updated: [], skippedUnmanaged: [], errors: [], results: [] } };
    }
    } finally { releaseT3HubLock(transactionLock); }
  }
  function syncOrchestrationDirectiveToHosts(args = {}) {
    const state = getOrchestrationState();
    if (state.policyVersion !== 2) throw new Error("旧编排指引已退役，请先明确选择统一协作模式");
    const hosts = args.hosts || args.hostRulePaths || args.extraSyncPaths || args.host;
    const extraSkills = args.extraSkillPaths || args.skillPaths || [];
    return updateOrchestrationConfig({ swarmMode: state.swarmMode, expectedRevision: state.modeRevision }, { adoptUnmanagedSkillHashes: args.adoptUnmanagedSkillHashes, ...(Array.isArray(hosts) ? { hostRulePaths: hosts } : {}), ...(Array.isArray(args.additionalHosts) ? { additionalHosts: args.additionalHosts } : {}), ...(Array.isArray(extraSkills) ? { extraSkillPaths: extraSkills } : {}) });
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
        const expected = tOpts.expectedSnapshot;
        if (expected && (Boolean(st) === expected.missing || (st && (st.dev !== expected.dev || st.ino !== expected.ino)))) throw new Error("文件已变更，请重新读取: " + filePath);
        if (!st) {
          if (!createIfMissing) return { changed: false };
          const next = transformFn("");
          if (next === null || next === "") return { changed: false };
          const tmp = filePath + ".tmp-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(16).slice(2);
          let fd = null;
          let ownsTmp = false;
          let publishedIno = null, publishedDev = null;
          try {
            fd = fs.openSync(tmp, "wx", 0o600);
            ownsTmp = true;
            fs.writeSync(fd, next, 0, "utf8");
            try { fs.fsyncSync(fd); } catch {}
            const targetMode = typeof tOpts.defaultMode === "number" ? (tOpts.defaultMode & 0o777) : 0o644;
            fs.fchmodSync(fd, targetMode);
            const published = fs.fstatSync(fd);
            if ((published.mode & 0o777) !== targetMode) throw new Error("failed to apply file mode on: " + filePath);
            publishedIno = published.ino; publishedDev = published.dev;
            fs.closeSync(fd);
            fd = null;
            assertNoSymlinkPath(filePath);
            fs.linkSync(tmp, filePath);
            tOpts.onPublish?.({ changed: true, dev: publishedDev, ino: publishedIno });
            try { fs.unlinkSync(tmp); ownsTmp = false; } catch {}
          } catch (e) {
            try { if (fd !== null) fs.closeSync(fd); } catch {}
            try { if (ownsTmp) fs.unlinkSync(tmp); } catch {}
            if (e && e.code === "EEXIST") continue;
            throw e;
          }
          const post = lstatSafe(filePath);
          if (!post || !post.isFile() || post.ino !== publishedIno) continue;
          return { changed: true, dev: post.dev, ino: publishedIno };
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
        const existing = rawPre.toString("utf8");
        if (expected && (!Buffer.from(expected.text, "utf8").equals(rawPre))) throw new Error("文件已变更，请重新读取: " + filePath);
        if (doBackup) backupOnce(filePath);
        const next = transformFn(existing);
        if (next === null || next === existing) return { changed: false };
        const stageDir = fs.mkdtempSync(filePath + ".stage-");
        const tmp = path.join(stageDir, "new");
        const staged = path.join(stageDir, "old");
        let fd = null;
        let stagedFd = null;
        let ownsTmp = false;
        let publishedIno = null, publishedDev = null;
        let retryCas = false;
        try {
          fd = fs.openSync(tmp, "wx", 0o600);
          ownsTmp = true;
          fs.writeSync(fd, next, 0, "utf8");
          try { fs.fsyncSync(fd); } catch {}
          const targetMode = typeof tOpts.forceMode === "number" ? (tOpts.forceMode & 0o777) : origMode;
          try { fs.fchmodSync(fd, targetMode); } catch {}
          const published = fs.fstatSync(fd); publishedIno = published.ino; publishedDev = published.dev;
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
                tOpts.onPublish?.({ changed: true, dev: publishedDev, ino: publishedIno });
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
                } else {
                  var postTargetDev = postTarget.dev;
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
        return { changed: true, dev: (typeof postTargetDev !== "undefined" ? postTargetDev : lstatSafe(filePath)?.dev), ino: publishedIno };
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

  function composeRoleBlockText(existing, block, startMarker, endMarker) {
    validateRoleMarkers(existing, startMarker, endMarker);
    const sIdx = existing.indexOf(startMarker);
    const eIdx = existing.indexOf(endMarker);
    let next = "";
    if (sIdx !== -1 && eIdx !== -1 && eIdx > sIdx) {
      const before = existing.slice(0, sIdx);
      let after = existing.slice(eIdx + endMarker.length);
      if (after.startsWith("\r\n")) after = after.slice(2);
      else if (after.startsWith("\n")) after = after.slice(1);
      next = before + block + after;
    } else {
      next = (existing.trim() ? existing.replace(/\s+$/, "") + "\n\n" : "") + block;
    }
    return next === existing ? null : next;
  }
  function injectIntoFile(filePath, block, startMarker, endMarker) {
    return transformTextFileAtomic(filePath, (existing) => composeRoleBlockText(existing, block, startMarker, endMarker), { backup: true, createIfMissing: true });
  }
  function generateClaudeAgentContent(item) {
    const modelLine = item.model ? `\nmodel: ${yamlDoubleQuotedScalar(item.model)}` : "";
    return `---\nname: ${yamlDoubleQuotedScalar(item.id)}\ndescription: ${yamlDoubleQuotedScalar(item.description || item.id)}${modelLine}\n${HUB_AGENT_MARKER}\n---\n\n${item.systemPrompt || ""}\n\n${memoryInstruction(item)}\n`;
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

  function writeClaudeAgentFile(dir, item, txOptions = {}) {
    assertSafeSubagentId(String(item.id));
    const file = path.join(dir, item.id + ".md");
    assertContained(dir, file);
    safeMkdir(dir);
    assertNoSymlinkPath(file);
    const st = lstatSafe(file);
    if (txOptions.before) {
      const current = lenientClaudeSnapshot(file), expected = txOptions.before;
      if (current.missing !== expected.missing || (!current.missing && (current.unsafe || current.dev !== expected.dev || current.ino !== expected.ino || current.text !== expected.text))) {
        if (txOptions.strictExpected) throw new Error("项目代理文件已变更: " + file);
        return { file, written: false, skippedUnmanaged: true };
      }
    }
    if (st && !st.isFile()) return { file, written: false, skippedUnmanaged: true };
    const fm = generateClaudeAgentContent(item);
    if (!isHubManagedContent(fm)) throw new Error("generated frontmatter failed ownership check: " + file);
    const baseMode = existingFileMode(file) ?? 0o644;
    const mode = (baseMode & 0o555) || 0o444;
    const existsNow = fileExists(file);
    if (!existsNow) {
      try {
        const pub = writeNewFileExclusive(file, fm, mode, txOptions.onPublish);
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
      if (txOptions.strictExpected) {
        const expected = txOptions.before;
        if (lockSnap.missing !== expected.missing || (!lockSnap.missing && (lockSnap.unsafe || lockSnap.dev !== expected.dev || lockSnap.ino !== expected.ino || lockSnap.text !== expected.text))) throw new Error("项目代理文件已变更: " + file);
      }
      if (lockSnap.missing) {
        try {
          const pub = writeNewFileExclusive(file, fm, mode, txOptions.onPublish);
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
      return replaceManagedFile(file, fm, mode, path.join(hubDir, "retired-agents"), lockSnap, txOptions.onPublish);
    } finally {
      releaseT3HubLock(lockPath);
    }
  }
  function removeClaudeAgentFile(dir, id, txOptions = {}) {
    assertSafeSubagentId(String(id));
    const file = path.join(dir, id + ".md");
    assertContained(dir, file);
    assertNoSymlinkPath(file);
    const preSnap = readRegularSnapshot(file);
    const expected = txOptions.before;
    if (expected && (preSnap.missing !== expected.missing || (!preSnap.missing && (preSnap.unsafe || preSnap.dev !== expected.dev || preSnap.ino !== expected.ino || preSnap.text !== expected.text)))) throw new Error("项目代理文件已变更: " + file);
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
      const { changed, ...result } = stageManagedFile(file, undefined, undefined, path.join(hubDir, "retired-agents"), lockSnap, txOptions.onPublish);
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
  function lenientClaudeSnapshot(file) {
    try {
      const snap = readRegularSnapshot(file);
      if (snap.missing) return { missing: true, text: "" };
      if (snap.unsafe) return { missing: false, unsafe: true, text: null, dev: snap.dev, ino: snap.ino, mode: snap.mode };
      return { missing: false, text: snap.text, dev: snap.dev, ino: snap.ino, mode: snap.mode };
    } catch (e) {
      return { missing: false, unsafe: true, text: null, error: e };
    }
  }
  function restoreClaudeDeletion(file, beforeSnap) {
    // before exists, after missing: recreate with CAS (still missing) and original file mode.
    const cur = lenientClaudeSnapshot(file);
    if (!cur.missing) throw new Error("文件已被其他操作修改");
    safeMkdir(path.dirname(file));
    const restoreMode = typeof beforeSnap?.mode === "number" ? ((beforeSnap.mode & 0o777) || 0o444) : 0o444;
    const res = transformTextFileAtomic(file, () => {
      if (lstatSafe(file)) throw new Error("文件已被其他操作修改");
      return beforeSnap.text;
    }, { createIfMissing: true, defaultMode: restoreMode });
    if (!res.changed) throw new Error("文件已被其他操作删除");
    const restoredSt = lstatSafe(file);
    if (!restoredSt || !restoredSt.isFile() || (restoredSt.mode & 0o777) !== restoreMode) {
      throw new Error("恢复文件权限核验失败: " + file);
    }
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
    const rawProjectRoot = args.projectRoot || null;
    const projectRoot = rawProjectRoot ? resolveCanonicalProjectRoot(rawProjectRoot) : null;
    const catalog = listModelCatalog(homeDir);
    const globalItems = withReviewTierDefaults(readGlobal());
    const projectItems = projectRoot ? readProject(projectRoot) : [];
    const effectiveItems = buildEffective(globalItems, projectItems);
    const legacyPath = projectRoot ? path.join(projectDir, slugFromProjectRoot(projectRoot) + ".json") : null;
    const legacyProjectConfig = Boolean(legacyPath && !policySnapshot(legacyPath).missing);
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

  function commitProjectRoleTransaction(projectRoot, items, beforeProjSnap, args = {}) {
    const json = projectPathFor(projectRoot), lock = json + ".transaction.lock";
    acquireT3HubLock(lock);
    try {
      const block = renderBlock(items, true), host = path.join(projectRoot, "AGENTS.md");
      const beforeHost = policySnapshot(host);
      const hostText = composeRoleBlockText(beforeHost.text, block, PROJECT_START, PROJECT_END) ?? beforeHost.text;
      const dir = path.join(projectRoot, ".claude", "agents");
      const enabled = items.filter(i => i.enabled !== false), enabledIds = new Set(enabled.map(i => i.id));
      const names = safeDirExists(dir) ? fs.readdirSync(dir).filter(f => f.endsWith(".md")) : [];
      const plans = [...new Set([...enabled.map(i => i.id), ...names.map(f => f.slice(0, -3))])].map(id => {
        assertSafeSubagentId(id);
        const file = path.join(dir, id + ".md"), before = lenientClaudeSnapshot(file);
        if (before.error) throw before.error;
        return { id, file, before, item: enabled.find(i => i.id === id) };
      });
      const exclude = resolveExcludePath(projectRoot), beforeExclude = exclude ? policySnapshot(exclude) : null;
      let excludeText = beforeExclude?.text || "";
      const skippedUnmanaged = [], conflicts = [];
      const tx = { journal: [], journalConflicts: [], validations: [] };
      const recordUnrestored = (err) => {
        if (err?.unrestoredPath && !tx.journal.some(entry => entry.path === err.unrestoredPath) && !tx.journalConflicts.some(entry => entry.path === err.unrestoredPath)) {
          tx.journalConflicts.push({
            path: err.unrestoredPath,
            error: String(err.message || err),
            ...(err.preservedPath ? { preservedPath: err.preservedPath } : {}),
          });
        }
      };
      try {
        writePolicySnapshot(json, beforeProjSnap, JSON.stringify(items, null, 2) + "\n", tx, { createIfMissing: true, defaultMode: 0o600 });
        writePolicySnapshot(host, beforeHost, hostText, tx, { createIfMissing: true, backup: true });
        for (const p of plans) {
          if (!p.before.missing && (p.before.unsafe || !isHubManagedContent(p.before.text))) {
            if (p.item || args.deletedId === p.id || items.some(i => i.id === p.id)) recordUnmanagedConflict({ file: p.file, skippedUnmanaged: true }, p.id, skippedUnmanaged, conflicts);
            continue;
          }
          if (p.item) {
            const text = generateClaudeAgentContent(p.item);
            let res;
            try {
              res = writeClaudeAgentFile(dir, p.item, { before: p.before, strictExpected: true, onPublish(meta) {
                tx.journal.push({ path: p.file, before: p.before, after: text, ...meta });
              } });
            } catch (stepErr) {
              recordUnrestored(stepErr);
              throw stepErr;
            }
            if (res.skippedUnmanaged) {
              // Match global-role conflict semantics: the writer rescued the
              // user's inode and released ownership of this optional file.
              tx.journal = tx.journal.filter(entry => entry.path !== p.file);
              recordUnmanagedConflict(res, p.id, skippedUnmanaged, conflicts);
              continue;
            }
            if (!res.written) throw new Error("项目代理文件写入失败: " + p.file);
            const after = policySnapshot(p.file);
            if (after.missing || after.text !== text) throw new Error("项目代理文件写入后已变更: " + p.file);
            tx.validations.push({ path: p.file, after: text, dev: after.dev, ino: after.ino });
            const entry = `.claude/agents/${p.id}.md`;
            const lines = excludeText.split(/\r?\n/);
            if (!lines.includes(entry)) { lines.push(entry); excludeText = lines.join("\n").replace(/\n+$/, "") + "\n"; }
          } else if (!p.before.missing && !enabledIds.has(p.id)) {
            let res;
            try {
              res = removeClaudeAgentFile(dir, p.id, { before: p.before, onPublish() {
                tx.journal.push({ path: p.file, before: p.before, deleted: true });
              } });
            } catch (stepErr) {
              recordUnrestored(stepErr);
              throw stepErr;
            }
            if (res.skippedUnmanaged) {
              tx.journal = tx.journal.filter(entry => entry.path !== p.file);
              recordUnmanagedConflict(res, p.id, skippedUnmanaged, conflicts);
              continue;
            }
            if (!res.removed) throw new Error("项目代理文件删除时已变更: " + p.file);
            if (args.deletedId === p.id || items.some(i => i.id === p.id)) {
              const entry = `.claude/agents/${p.id}.md`;
              if (excludeText.includes(entry)) excludeText = excludeText.split(/\r?\n/).filter(l => l !== entry).join("\n").replace(/\n+$/, "") + (excludeText.endsWith("\n") ? "\n" : "");
            }
          }
        }
        if (exclude) writePolicySnapshot(exclude, beforeExclude, excludeText, tx, { createIfMissing: true });
        validatePolicyTransaction(tx);
        return { block, skippedUnmanaged, conflicts };
      } catch (e) {
        throw transactionError(e, [...tx.journalConflicts, ...rollbackPolicyWrites(tx.journal)]);
      }
    } finally { releaseT3HubLock(lock); }
  }

  function commitGlobalRoleTransaction(items, beforeSub, args) {
    // Role and mode transactions touch the same Skills/rules. Serialize their
    // publication windows; per-file CAS still protects non-Hub editors.
    const transactionLock = path.join(hubDir, ".orchestration-mode.lock");
    acquireT3HubLock(transactionLock);
    try {
    const block = renderBlock(items, false);
    const hostPlans = globalRoleTargets(args.extraSyncPaths).map(file => {
      const before = policySnapshot(file);
      return { file, before, text: composeRoleBlockText(before.text, block, GLOBAL_START, GLOBAL_END) ?? before.text };
    });
    const extraSkillsForTx = args.extraSkillPaths || args.skillPaths || opts.extraSkillPaths || [];
    const preflightRoleTree = inspectAntigravityProviderTree(extraSkillsForTx);
    const plannedForTx = planRoutingSkillSync(buildEffective(withReviewTierDefaults(items), []), orchestrationCfgForSkill(),
      extraSkillsForTx, args.adoptUnmanagedSkillHashes);
    const enabled = items.filter(i => i.enabled !== false), enabledIds = new Set(enabled.map(i => i.id));
    const claudePlans = enabled.map(item => {
      const file = path.join(claudeAgentsRoot, item.id + ".md");
      return { file, item, before: lenientClaudeSnapshot(file), text: generateClaudeAgentContent(item) };
    });
    let files = [];
    if (safeDirExists(claudeAgentsRoot)) files = fs.readdirSync(claudeAgentsRoot).filter(f => f.endsWith(".md"));
    const deletionPlans = files.filter(f => !enabledIds.has(f.slice(0, -3))).map(f => {
      const file = path.join(claudeAgentsRoot, f);
      return { file, id: f.slice(0, -3), before: lenientClaudeSnapshot(file) };
    });
    const tx = { journal: [], journalConflicts: [], backupJournal: [], validations: [] };
    const skippedUnmanaged = [], conflicts = [];
    const recordUnrestored = (err) => {
      if (err?.unrestoredPath && !tx.journal.some(entry => entry.path === err.unrestoredPath) && !tx.journalConflicts.some(entry => entry.path === err.unrestoredPath)) {
        tx.journalConflicts.push({
          path: err.unrestoredPath,
          error: String(err.message || err),
          ...(err.preservedPath ? { preservedPath: err.preservedPath } : {}),
        });
      }
    };
    try {
      writePolicySnapshot(globalPath, beforeSub, JSON.stringify(items, null, 2) + "\n", tx, { createIfMissing: true, defaultMode: 0o600 });
      for (const p of hostPlans) {
        // Host documents are bounded blocks: merge concurrent changes to user
        // prose under the primitive's CAS, without rebasing JSON or Skills.
        let baseline = p.before, intended = p.text;
        const hostRes = transformTextFileAtomic(p.file, existing => {
          const st = lstatSafe(p.file);
          baseline = { missing: !st, text: existing, ...(st ? { dev: st.dev, ino: st.ino } : {}) };
          intended = composeRoleBlockText(existing, block, GLOBAL_START, GLOBAL_END) ?? existing;
          return intended;
        }, { createIfMissing: true, backup: true, onPublish(meta) {
          tx.journal.push({ path: p.file, before: baseline, after: intended, ...meta });
        } });
        if (!hostRes.changed && !baseline.missing) {
          tx.validations.push({ path: p.file, after: intended, dev: baseline.dev, ino: baseline.ino });
        }
      }
      for (const p of claudePlans) {
        let res;
        try {
          res = writeClaudeAgentFile(claudeAgentsRoot, p.item, { before: p.before, onPublish(meta) {
            tx.journal.push({ path: p.file, before: p.before, after: p.text, ...meta });
          } });
        } catch (stepErr) {
          recordUnrestored(stepErr);
          throw stepErr;
        }
        if (res.skippedUnmanaged) {
          // Claude files retain their established conflict/skip contract. The
          // writer has already rescued an edited inode; it is no longer owned
          // by this transaction and must never be rolled back over user edits.
          tx.journal = tx.journal.filter(entry => entry.path !== p.file);
        }
        recordUnmanagedConflict(res, p.item.id, skippedUnmanaged, conflicts);
      }
      for (const p of deletionPlans) {
        if (p.before.missing) continue;
        if (p.before.unsafe) {
          if (isHubManagedAgentFile(p.file)) recordUnmanagedConflict({ file: p.file, skippedUnmanaged: true }, p.id, skippedUnmanaged, conflicts);
          continue;
        }
        if (!isHubManagedContent(p.before.text)) continue;
        const current = lenientClaudeSnapshot(p.file);
        if (current.unsafe || current.dev !== p.before.dev || current.ino !== p.before.ino || current.text !== p.before.text) {
          recordUnmanagedConflict({ file: p.file, skippedUnmanaged: true }, p.id, skippedUnmanaged, conflicts);
          continue;
        }
        let res;
        try {
          res = removeClaudeAgentFile(claudeAgentsRoot, p.id, {
            onPublish() {
              tx.journal.push({ path: p.file, before: p.before, deleted: true });
            },
          });
        } catch (stepErr) {
          recordUnrestored(stepErr);
          throw stepErr;
        }
        if (res.skippedUnmanaged) {
          tx.journal = tx.journal.filter(entry => entry.path !== p.file);
        }
        recordUnmanagedConflict(res, p.id, skippedUnmanaged, conflicts);
      }
      const skillSync = syncRoutingSkillTargets({ ...tx, _skillPlanned: plannedForTx });
      if (!skillSync.ok) throw new Error("路由 Skill 同步失败: " + skillSync.errors.map(x => x.path + ": " + x.error).join("; "));
      // Validate the candidate as a whole, including changes made during later
      // file writes. A saved JSON alone is never proof of a committed route.
      for (const entry of [...tx.journal, ...tx.validations]) {
        const current = policySnapshot(entry.path);
        if (entry.deleted ? !current.missing : current.missing || current.dev !== entry.dev || current.ino !== entry.ino || current.text !== entry.after) throw new Error("事务文件已被其他操作修改: " + entry.path);
      }
      const postRoleTree = inspectAntigravityProviderTree(extraSkillsForTx);
      assertPostAntigravityTreeUnchanged(preflightRoleTree, postRoleTree, tx);
      return { block, skippedUnmanaged, conflicts, skillSync };
    } catch (e) {
      const failures = [...tx.journalConflicts, ...rollbackPolicyWrites(tx.journal), ...cleanupCreatedBackups(tx.backupJournal)];
      throw transactionError(e, failures);
    }
    } finally { releaseT3HubLock(transactionLock); }
  }

  function saveSubagent(args = {}) {
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("invalid arguments");
    const hasArgsScope = Object.prototype.hasOwnProperty.call(args, "scope") && args.scope !== undefined;
    if (hasArgsScope && args.scope !== "global" && args.scope !== "project") throw new Error("invalid scope: " + String(args.scope));
    if (Object.prototype.hasOwnProperty.call(args, "item") && args.item !== undefined && (!args.item || typeof args.item !== "object" || Array.isArray(args.item))) {
      throw new Error("invalid item");
    }
    const hasItemScope = Boolean(args.item && Object.prototype.hasOwnProperty.call(args.item, "scope") && args.item.scope !== undefined);
    if (hasItemScope && args.item.scope !== "global" && args.item.scope !== "project") throw new Error("invalid scope: " + String(args.item.scope));
    if (hasArgsScope && hasItemScope && args.scope !== args.item.scope) throw new Error("conflicting scope");
    const hasArgsProj = Object.prototype.hasOwnProperty.call(args, "projectRoot") && args.projectRoot !== undefined;
    const hasItemProj = Boolean(args.item && Object.prototype.hasOwnProperty.call(args.item, "projectRoot") && args.item.projectRoot !== undefined);
    if (hasArgsProj && hasItemProj && args.projectRoot !== args.item.projectRoot) throw new Error("conflicting projectRoot");
    const rawProjectRoot = hasArgsProj ? args.projectRoot : (hasItemProj ? args.item.projectRoot : null);
    const scope = hasArgsScope ? args.scope : (hasItemScope ? args.item.scope : (rawProjectRoot !== null ? "project" : "global"));
    if (!["global", "project"].includes(scope)) throw new Error("invalid scope: " + scope);
    if (scope === "project" && (!rawProjectRoot || typeof rawProjectRoot !== "string" || !path.isAbsolute(rawProjectRoot))) throw new Error("projectRoot required for project scope");
    const projectRoot = scope === "project" ? resolveCanonicalProjectRoot(rawProjectRoot) : null;
    preflightRoleTargets(scope, projectRoot, args.extraSyncPaths);
    const beforeGlobal = scope === "global" ? policySnapshot(globalPath) : null;
    const beforeProjSnap = scope === "project" ? policySnapshot(projectPathFor(projectRoot)) : null;
    const projectItemsForSave = beforeProjSnap ? readProject(projectRoot, beforeProjSnap) : null;
    const globalItemsForSave = beforeGlobal ? readGlobal(beforeGlobal, false) : null;
    const input = args.item || args;
    const previous = (scope === "project" ? projectItemsForSave : globalItemsForSave).find(i => i.id === (input.id || input.name));
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
    let skillSync = null;
    if (scope === "global") {
      let items = globalItemsForSave;
      const idx = items.findIndex((x) => x.id === normalized.id);
      const isDefaultId = [...DEFAULT_SUBAGENTS, ...REVIEW_TIER_DEFAULTS].some((d) => d.id === normalized.id);
      if (isDefaultId && !normalized.builtin) {
        const prev = items[idx];
        if (prev) normalized.builtin = Boolean(prev.builtin);
        else normalized.builtin = true;
      }
      if (idx >= 0) {
        if (items[idx].builtin) normalized.builtin = true;
        items[idx] = { ...items[idx], ...normalized, id: normalized.id, name: normalized.name };
      } else {
        if (isDefaultId) normalized.builtin = true;
        items.push(normalized);
      }
      const syncRes = commitGlobalRoleTransaction(items, beforeGlobal, args);
      renderedMarkdownBlock = syncRes.block;
      syncSkippedUnmanaged = syncRes.skippedUnmanaged;
      syncConflicts = syncRes.conflicts;
      skillSync = syncRes.skillSync;
      saved = items.find((x) => x.id === normalized.id);
    } else if (scope === "project") {
      if (!projectRoot || !path.isAbsolute(String(projectRoot))) throw new Error("projectRoot required for project scope");
      let items = projectItemsForSave;
      const idx = items.findIndex((x) => x.id === normalized.id);
      // If overridesGlobal, ensure global exists with that id? Allow anyway but mark override.
      if (idx >= 0) {
        items[idx] = { ...items[idx], ...normalized, id: normalized.id, name: normalized.name };
      } else {
        items.push(normalized);
      }
      const syncRes = commitProjectRoleTransaction(projectRoot, items, beforeProjSnap);
      if (typeof syncRes === "string") { renderedMarkdownBlock = syncRes; } else { renderedMarkdownBlock = syncRes.block; syncSkippedUnmanaged = syncRes.skippedUnmanaged || []; syncConflicts = syncRes.conflicts || []; }
      saved = items.find((x) => x.id === normalized.id);
    } else {
      throw new Error("invalid scope: " + scope);
    }
    // Also ensure global block is re-injected when project changes? No.
    return { ok: true, scope, projectRoot: scope === "project" ? projectRoot : null, item: saved, renderedMarkdownBlock, skippedUnmanaged: syncSkippedUnmanaged, conflicts: syncConflicts, skillSync };
  }

  function deleteSubagent(args = {}) {
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("invalid arguments");
    const hasArgsScope = Object.prototype.hasOwnProperty.call(args, "scope") && args.scope !== undefined;
    if (hasArgsScope && args.scope !== "global" && args.scope !== "project") throw new Error("invalid scope: " + String(args.scope));
    const hasArgsProj = Object.prototype.hasOwnProperty.call(args, "projectRoot") && args.projectRoot !== undefined;
    const rawProjectRoot = hasArgsProj ? args.projectRoot : null;
    const scope = hasArgsScope ? args.scope : (rawProjectRoot !== null ? "project" : "global");
    const id = String(args.id || "").trim();
    if (!id) throw new Error("id required");
    assertSafeSubagentId(id);
    if (!["global", "project"].includes(scope)) throw new Error("invalid scope: " + scope);
    if (scope === "project" && (!rawProjectRoot || typeof rawProjectRoot !== "string" || !path.isAbsolute(rawProjectRoot))) throw new Error("projectRoot required for project scope");
    const projectRoot = scope === "project" ? resolveCanonicalProjectRoot(rawProjectRoot) : null;
    preflightRoleTargets(scope, projectRoot, args.extraSyncPaths);
    let renderedMarkdownBlock;
    let syncSkippedUnmanaged = [];
    let syncConflicts = [];
    let skillSync = null;
    function unwrapSync(res) {
      if (typeof res === "string") { renderedMarkdownBlock = res; } else { renderedMarkdownBlock = res.block; syncSkippedUnmanaged = res.skippedUnmanaged || []; syncConflicts = res.conflicts || []; skillSync = res.skillSync || null; }
    }
    if (scope === "global") {
      const beforeGlobal = policySnapshot(globalPath);
      let items = readGlobal(beforeGlobal, false);
      const idx = items.findIndex((x) => x.id === id);
      if (idx === -1) return { ok: true, scope, id, deleted: false };
      const existing = items[idx];
      let newItems = null;
      let isReset = false;
      if (existing.builtin) {
        const def = [...DEFAULT_SUBAGENTS, ...REVIEW_TIER_DEFAULTS].find((d) => d.id === id);
        if (def) {
          newItems = items.map((x) => (x.id === id ? { ...def } : x));
          isReset = true;
        }
      }
      if (!newItems) newItems = items.filter((x) => x.id !== id);
      unwrapSync(commitGlobalRoleTransaction(newItems, beforeGlobal, args));
      if (isReset) return { ok: true, scope, id, deleted: false, reset: true, item: newItems.find((x) => x.id === id), renderedMarkdownBlock, skippedUnmanaged: syncSkippedUnmanaged, conflicts: syncConflicts, skillSync };
      return { ok: true, scope, id, deleted: true, renderedMarkdownBlock, skippedUnmanaged: syncSkippedUnmanaged, conflicts: syncConflicts, skillSync };
    } else if (scope === "project") {
      if (!projectRoot || !path.isAbsolute(String(projectRoot))) throw new Error("projectRoot required for project scope");
      const beforeProjSnap = policySnapshot(projectPathFor(projectRoot));
      let items = readProject(projectRoot, beforeProjSnap);
      const idx = items.findIndex((x) => x.id === id);
      if (idx === -1) return { ok: true, scope, id, deleted: false, projectRoot };
      items = items.filter((x) => x.id !== id);
      unwrapSync(commitProjectRoleTransaction(projectRoot, items, beforeProjSnap, { deletedId: id }));
      return { ok: true, scope, id, deleted: true, projectRoot, renderedMarkdownBlock, skippedUnmanaged: syncSkippedUnmanaged, conflicts: syncConflicts };
    }
    throw new Error("invalid scope: " + scope);
  }

  // Read on every call and never seed/synchronize configuration from a hook invocation.
  function resolveSubagentRoute({ idOrTitle, role, projectRoot } = {}) {
    const globalCfg = readOrchestrationSnapshot().config;
    const resolvedOrch = resolveProjectOrchestration(projectRoot || null, globalCfg);
    const orchestration = { swarmMode: resolvedOrch.effectiveSwarmMode, source: resolvedOrch.source || "global" };
    const globalSnap = policySnapshot(globalPath);
    const globals = globalSnap.missing ? [] : withReviewTierDefaults(readGlobal(globalSnap, false));
    let projects = [];
    if (projectRoot) {
      const canonical = resolveCanonicalProjectRoot(projectRoot);
      const file = rawProjectRolePathFor(canonical);
      const snap = policySnapshot(file);
      if (!snap.missing) projects = readProject(canonical, snap);
    }
    const items = buildEffective(globals, projects).map(normalizeMemory);
    const normalizeHintAlias = (raw) => raw
      .replace(/^(?:wrok[-_ ]pro|work[-_ ]pro|woerk[-_ ]pro)(?=$|\s*[·:：|/]|(?:\s+-\s))/i, "worker-pro")
      .replace(/^(?:wrok|work|woerk)(?=$|\s*[·:：|/]|(?:\s+-\s))/i, "worker");
    const hints = (Array.isArray(idOrTitle) ? idOrTitle : [idOrTitle]).filter(x => typeof x === "string" && x.trim()).map(x => normalizeHintAlias(x.trim().toLowerCase()));
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
      if (explicitUnavailable) return { ok: true, matched: false, explicitUnavailable: true, item: null, target: null, orchestration };
    }
    const roleDefault = { research: "explorer", implementation: "worker", general: "default", design: "frontend", test: "qa", review: "code-review" };
    if (!item && roleDefault[role] && (!hints.length || hints.length === 1 && hints[0] === String(role).toLowerCase())) item = items.find(i => i.id === roleDefault[role]);
    // A role fallback is safe only when it is unambiguous and no explicit identity was supplied.
    if (!item && !hints.length && role) {
      item = items.find(i => i.id === role || i.name === role);
      if (!item) { const matches = items.filter(i => i.role === role); if (matches.length === 1) item = matches[0]; }
    }
    if (!item || !item.providerInstanceId || !item.model || !item.effort) return { ok: true, matched: false, item: null, target: null, orchestration };
    return { ok: true, matched: true, item, instruction: subagentInstruction(item), target: { providerInstanceId: item.providerInstanceId, model: item.model, options: optionsForSubagent(item) }, orchestration };
  }

  return { homeDir, hubDir, globalPath, projectDir, resolveSubagentRoute, renderMarkdownBlock: renderBlock, renderRoutingSkillMarkdown, syncRoutingSkillTargets, buildHostCapabilities, listSubagents, saveSubagent, deleteSubagent, getOrchestrationConfig, getOrchestrationState, inspectOrchestrationTargets, updateOrchestrationConfig, syncOrchestrationDirectiveToHosts, syncOrchestrationDirectiveToHostsRaw: (args = {}) => syncOrchestrationDirectiveToHostsRaw(args), syncManagedRuleBlock, replaceRuleDocument, transformRuleDocument, buildOrchestrationDirective, buildSlashCommandPrompt: (mode) => buildSlashCommandPrompt(mode), listModelCatalog: () => listModelCatalog(homeDir) };
}

let _singleton = null;
let _singletonKey = null;
function getDefaultSubagentsManager() {
  const key = (process.env.HOME || os.homedir()) + "\0" + (process.env.T3_HUB_DIR || "") + "\0" + (process.env.T3CODE_HOME || "");
  if (!_singleton || _singletonKey !== key) {
    _singleton = createSubagentsManager();
    _singletonKey = key;
  }
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
  renderRoutingSkillMarkdown,
  isHubManagedSkillContent,
  buildHostCapabilities,
  SUBAGENT_STOP_HEADER,
  AGY_MODELS,
  ORCHESTRATOR_START,
  ORCHESTRATOR_END,
};
