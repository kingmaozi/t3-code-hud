"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const FUSE_SENTINEL = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX", "ascii");
const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const capabilityCache = new Map();

function isPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function ensurePrivateDir(dirPath) {
  const resolved = path.resolve(dirPath);
  let st = null;
  try {
    st = fs.lstatSync(resolved);
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
  if (st) {
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error(`Refusing unsafe run directory: ${resolved}`);
    }
    try { fs.chmodSync(resolved, 0o700); } catch {}
    return resolved;
  }
  // Check existing parent is not a symlink to a non-directory or dangling target
  const parent = path.dirname(resolved);
  if (parent !== resolved) {
    let pst = null;
    try { pst = fs.lstatSync(parent); } catch {}
    if (pst && pst.isSymbolicLink()) {
      const realParent = fs.realpathSync(parent);
      if (!fs.statSync(realParent).isDirectory()) {
        throw new Error(`Refusing non-directory parent: ${parent}`);
      }
    }
  }
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const created = fs.lstatSync(resolved);
  if (created.isSymbolicLink() || !created.isDirectory()) {
    throw new Error(`Refusing unsafe run directory: ${resolved}`);
  }
  try { fs.chmodSync(resolved, 0o700); } catch {}
  return resolved;
}

function readRegularFileNoFollow(filePath, { maxBytes = 4 * 1024 * 1024 } = {}) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | O_NOFOLLOW);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) {
      const err = new Error(`Refusing non-regular file: ${filePath}`);
      err.code = "ENOTFILE";
      throw err;
    }
    if (st.size > maxBytes) {
      const err = new Error(`File exceeds max size: ${filePath}`);
      err.code = "EFBIG";
      throw err;
    }
    return fs.readFileSync(fd, "utf8");
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function writeFileAtomicNoFollow(filePath, content, { mode = 0o600 } = {}) {
  const dir = path.dirname(filePath);
  ensurePrivateDir(dir);
  let existing = null;
  try {
    existing = fs.lstatSync(filePath);
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
    throw new Error(`Refusing to overwrite non-regular file or symlink: ${filePath}`);
  }
  const temp = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temp, content, { flag: "wx", mode });
    try { fs.chmodSync(temp, mode); } catch {}
    fs.renameSync(temp, filePath);
  } finally {
    try { fs.unlinkSync(temp); } catch {}
  }
}

function unlinkIfRegular(filePath) {
  try {
    const st = fs.lstatSync(filePath);
    if (st.isFile() && !st.isSymbolicLink()) {
      fs.unlinkSync(filePath);
      return true;
    }
  } catch {}
  return false;
}

function ensurePrivateLogFile(logPath) {
  ensurePrivateDir(path.dirname(logPath));
  let st = null;
  try {
    st = fs.lstatSync(logPath);
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
  if (st) {
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new Error(`Refusing unsafe log file: ${logPath}`);
    }
    fs.chmodSync(logPath, 0o600);
    return logPath;
  }
  let fd = null;
  try {
    fd = fs.openSync(logPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | O_NOFOLLOW, 0o600);
    fs.fchmodSync(fd, 0o600);
  } catch (err) {
    if (err?.code === "EEXIST") {
      const again = fs.lstatSync(logPath);
      if (again.isSymbolicLink() || !again.isFile()) {
        throw new Error(`Refusing unsafe log file: ${logPath}`);
      }
      fs.chmodSync(logPath, 0o600);
    } else {
      throw err;
    }
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
  return logPath;
}

function readLockOwner(lockPath) {
  const fd = fs.openSync(lockPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096) throw new Error("Invalid lock file");
    const owner = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0 ||
        !Number.isFinite(owner.startedAt) || typeof owner.lockId !== "string" || !owner.lockId) {
      throw new Error("Invalid lock owner");
    }
    return { stat, owner };
  } finally {
    fs.closeSync(fd);
  }
}

function matchingLock(lockPath, snapshot) {
  try {
    const { stat, owner } = readLockOwner(lockPath);
    return stat.dev === snapshot.stat.dev && stat.ino === snapshot.stat.ino &&
      owner.lockId === snapshot.owner.lockId && owner.pid === snapshot.owner.pid
      ? { stat, owner } : null;
  } catch {
    return null;
  }
}

function reapStaleLock(lockPath, stale, lockId, checkAlive) {
  const reclaim = `${lockPath}.reap-${stale.stat.dev}-${stale.stat.ino}`;
  const staging = `${reclaim}.${lockId}`;
  const marker = `owner-${process.pid}-${lockId}`;
  fs.mkdirSync(staging, { mode: 0o700 });
  let published = false;
  try {
    fs.writeFileSync(path.join(staging, marker), "", { flag: "wx", mode: 0o600 });
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        // A nonempty destination is held. An empty one can be replaced
        // atomically, including after a reclaimer died during release.
        fs.renameSync(staging, reclaim);
        published = true;
        break;
      } catch (err) {
        if (err?.code !== "EEXIST" && err?.code !== "ENOTEMPTY") throw err;
      }
      if (!fs.lstatSync(reclaim, { throwIfNoEntry: false })?.isDirectory()) continue;
      let names;
      try { names = fs.readdirSync(reclaim); }
      catch (err) {
        if (err?.code === "ENOENT") continue;
        throw err;
      }
      if (names.length === 0) continue;
      const owner = names.length === 1 && /^owner-([1-9][0-9]*)-[a-f0-9]{24}$/.exec(names[0]);
      if (!owner || checkAlive(Number(owner[1]))) return false;
      // This owner-specific name never appears in the successor's directory.
      unlinkIfRegular(path.join(reclaim, owner[0]));
    }

    if (!published) return false;
    if (!matchingLock(lockPath, stale)) return true;
    return !checkAlive(stale.owner.pid) && unlinkIfRegular(lockPath);
  } finally {
    const dir = published ? reclaim : staging;
    unlinkIfRegular(path.join(dir, marker));
    try { fs.rmdirSync(dir); } catch {}
  }
}

function acquireExclusiveLock(
  lockPath,
  initialPayload = {},
  { isPidAlive: checkAlive = isPidAlive, now = () => Date.now() } = {}
) {
  ensurePrivateDir(path.dirname(lockPath));
  const lockId = crypto.randomBytes(12).toString("hex");
  const payload = {
    ...initialPayload,
    pid: process.pid,
    lockId,
    startedAt: Number.isFinite(initialPayload.startedAt) ? initialPayload.startedAt : now(),
  };
  const temp = `${lockPath}.${lockId}.tmp`;
  const encode = (owner) => JSON.stringify(owner) + "\n";

  try {
    fs.writeFileSync(temp, encode(payload), { flag: "wx", mode: 0o600 });
    fs.chmodSync(temp, 0o600);
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        fs.linkSync(temp, lockPath);
        let snapshot = { stat: fs.statSync(temp), owner: payload };
        let released = false;
        return {
          acquired: true,
          lockId,
          payload,
          update(patch) {
            if (released || !matchingLock(lockPath, snapshot)) return false;
            const next = { ...snapshot.owner, ...patch, pid: process.pid, lockId, startedAt: payload.startedAt };
            writeFileAtomicNoFollow(lockPath, encode(next));
            snapshot = { stat: fs.lstatSync(lockPath), owner: next };
            return true;
          },
          release() {
            if (released) return;
            released = true;
            if (matchingLock(lockPath, snapshot)) unlinkIfRegular(lockPath);
          },
        };
      } catch (err) {
        if (err?.code !== "EEXIST") throw err;
      }

      let stale;
      try {
        stale = readLockOwner(lockPath);
      } catch (err) {
        if (err?.code === "ENOENT") continue;
        // A legacy writer may still be publishing its ownership.
        return { acquired: false, reason: "invalid_lock" };
      }
      // A live owner can exceed its expected duration and still owns the lock.
      if (checkAlive(stale.owner.pid)) {
        return { acquired: false, reason: "held", owner: stale.owner };
      }

      // Two reclaimers must never unlink the same pathname from separate
      // snapshots of a dead owner.
      if (!reapStaleLock(lockPath, stale, lockId, checkAlive)) {
        return { acquired: false, reason: "busy" };
      }
    }
    return { acquired: false, reason: "busy" };
  } finally {
    unlinkIfRegular(temp);
  }
}

function isElectronRunAsNodeEnabled(appBundle) {
  if (!appBundle || typeof appBundle !== "string") return true;
  const candidates = [
    path.join(appBundle, "Contents", "Frameworks", "Electron Framework.framework", "Versions", "A", "Electron Framework"),
    path.join(appBundle, "Contents", "Frameworks", "Electron Framework.framework", "Electron Framework"),
  ];
  const fwPath = candidates.find((p) => {
    try { return fs.statSync(p).isFile(); } catch { return false; }
  });
  if (!fwPath) return true;

  let fd = null;
  try {
    fd = fs.openSync(fwPath, "r");
    const chunkSize = 4 * 1024 * 1024;
    const buf = Buffer.allocUnsafe(chunkSize);
    let tail = Buffer.alloc(0);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, chunkSize, null);
      if (n <= 0) break;
      const view = tail.length ? Buffer.concat([tail, buf.subarray(0, n)]) : buf.subarray(0, n);
      const idx = view.indexOf(FUSE_SENTINEL);
      if (idx >= 0) {
        const afterStart = idx + FUSE_SENTINEL.length;
        if (afterStart + 3 <= view.length) {
          const b0 = view[afterStart];
          if (b0 === 0x30 || b0 === 0x31) return b0 !== 0x30;
          if (b0 === 1 && view[afterStart + 1] >= 1) return view[afterStart + 2] !== 0x30;
          return true;
        }
        const extra = Buffer.alloc(16);
        const m = fs.readSync(fd, extra, 0, extra.length, null);
        const combined = Buffer.concat([view.subarray(afterStart), extra.subarray(0, Math.max(0, m))]);
        if (combined.length >= 1) {
          const b0 = combined[0];
          if (b0 === 0x30 || b0 === 0x31) return b0 !== 0x30;
          if (b0 === 1 && combined.length >= 3 && combined[1] >= 1) return combined[2] !== 0x30;
        }
        return true;
      }
      const keep = Math.min(view.length, FUSE_SENTINEL.length + 16);
      tail = Buffer.from(view.subarray(view.length - keep));
    }
  } catch {
    return true;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
  return true;
}

function checkNodeCapabilities(nodeBin, { useRunAsNode = false, execImpl = spawnSync, bypassCache = false } = {}) {
  if (!nodeBin || typeof nodeBin !== "string") return false;
  const key = `${nodeBin}|${useRunAsNode ? "1" : "0"}`;
  if (!bypassCache && execImpl === spawnSync && capabilityCache.has(key)) {
    return capabilityCache.get(key);
  }
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  if (useRunAsNode) env.ELECTRON_RUN_AS_NODE = "1";
  else delete env.ELECTRON_RUN_AS_NODE;
  let ok = false;
  try {
    const r = execImpl(
      nodeBin,
      ["-e", 'require("node:sqlite"); if (typeof WebSocket !== "function") process.exit(2);'],
      { env, timeout: 4000, stdio: "ignore" }
    );
    ok = Boolean(r && r.status === 0);
  } catch {
    ok = false;
  }
  if (!bypassCache && execImpl === spawnSync) {
    capabilityCache.set(key, ok);
  }
  return ok;
}

function collectSystemNodeCandidates(extraCandidates = null) {
  const candidates = [];
  if (Array.isArray(extraCandidates)) {
    candidates.push(...extraCandidates);
  } else {
    candidates.push("/opt/homebrew/bin/node", "/usr/local/bin/node");
    const pathEnv = String(process.env.PATH || "");
    for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
      candidates.push(path.join(dir, "node"));
    }
    if (process.execPath && !process.versions?.electron) {
      candidates.push(process.execPath);
    }
  }
  const unique = [];
  const seen = new Set();
  for (const cand of candidates) {
    if (!cand || seen.has(cand)) continue;
    seen.add(cand);
    try {
      const st = fs.statSync(cand);
      if (st.isFile()) {
        fs.accessSync(cand, fs.constants.X_OK);
        unique.push(cand);
      }
    } catch {}
  }
  return unique;
}

function resolveNodeRuntime({
  appBundle = null,
  apps = null,
  systemNodeCandidates = null,
  checkCapabilities = true,
  probeCapability = checkNodeCapabilities,
} = {}) {
  const targetApps = appBundle
    ? [path.resolve(appBundle)]
    : (Array.isArray(apps) ? apps.map((a) => path.resolve(a)) : []);

  for (const app of targetApps) {
    if (!isElectronRunAsNodeEnabled(app)) continue;
    const macosDir = path.join(app, "Contents", "MacOS");
    try {
      const bins = fs.readdirSync(macosDir).filter((n) => !n.startsWith("."));
      const mainBin = bins.find((n) => /t3\s*code/i.test(n)) || bins[0];
      if (!mainBin) continue;
      const binPath = path.join(macosDir, mainBin);
      if (!checkCapabilities || probeCapability(binPath, { useRunAsNode: true })) {
        return { bin: binPath, useRunAsNode: true };
      }
    } catch {}
  }

  for (const cand of collectSystemNodeCandidates(systemNodeCandidates)) {
    if (!checkCapabilities || probeCapability(cand, { useRunAsNode: false })) {
      return { bin: cand, useRunAsNode: false };
    }
  }

  return null;
}

function bridgeFileForWatchPid(runDir, watchPid) {
  return Number.isSafeInteger(watchPid) && watchPid > 0
    ? path.join(runDir, `hub-bridge-${watchPid}.json`)
    : path.join(runDir, "hub-bridge.json");
}

function isValidBridgeRecord(b, expectedWatchPid, { checkAlive = isPidAlive } = {}) {
  if (!b || typeof b !== "object") return false;
  if (!Number.isSafeInteger(b.pid) || b.pid <= 0) return false;
  if (typeof b.url !== "string" || !/^http:\/\/127\.0\.0\.1:\d+$/.test(b.url)) return false;
  if (typeof b.token !== "string" || !/^[a-f0-9]{64}$/.test(b.token)) return false;
  if (expectedWatchPid != null && expectedWatchPid > 0) {
    if (Number(b.watchPid) !== expectedWatchPid || b.pid === expectedWatchPid) return false;
  }
  return checkAlive(b.pid);
}

function readLiveBridgeRecord(runDir, expectedWatchPid, { checkAlive = isPidAlive } = {}) {
  const candidates = [];
  if (Number.isSafeInteger(expectedWatchPid) && expectedWatchPid > 0) {
    candidates.push(bridgeFileForWatchPid(runDir, expectedWatchPid));
  }
  candidates.push(path.join(runDir, "hub-bridge.json"));

  for (const filePath of candidates) {
    try {
      const b = JSON.parse(readRegularFileNoFollow(filePath));
      if (isValidBridgeRecord(b, expectedWatchPid, { checkAlive })) {
        return { record: b, filePath };
      }
    } catch {}
  }
  return null;
}

module.exports = {
  FUSE_SENTINEL,
  isPidAlive,
  ensurePrivateDir,
  readRegularFileNoFollow,
  writeFileAtomicNoFollow,
  unlinkIfRegular,
  ensurePrivateLogFile,
  acquireExclusiveLock,
  isElectronRunAsNodeEnabled,
  checkNodeCapabilities,
  collectSystemNodeCandidates,
  resolveNodeRuntime,
  bridgeFileForWatchPid,
  isValidBridgeRecord,
  readLiveBridgeRecord,
};
