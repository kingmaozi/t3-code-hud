"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile, spawnSync } = require("node:child_process");

const MAX_PREVIEW_BYTES = 256 * 1024;
const DARWIN_FILEREF_PY = [
  "import ctypes, os, sys",
  "p, is_dir = os.fsencode(sys.argv[1]), int(sys.argv[2])",
  "cf = ctypes.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')",
  "cf.CFURLCreateFromFileSystemRepresentation.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_long, ctypes.c_ubyte]",
  "cf.CFURLCreateFromFileSystemRepresentation.restype = ctypes.c_void_p",
  "cf.CFURLCreateFileReferenceURL.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]",
  "cf.CFURLCreateFileReferenceURL.restype = ctypes.c_void_p",
  "cf.CFURLGetString.argtypes = [ctypes.c_void_p]",
  "cf.CFURLGetString.restype = ctypes.c_void_p",
  "cf.CFStringGetCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_long, ctypes.c_uint32]",
  "cf.CFStringGetCString.restype = ctypes.c_ubyte",
  "cf.CFRelease.argtypes = [ctypes.c_void_p]",
  "u = cf.CFURLCreateFromFileSystemRepresentation(None, p, len(p), is_dir)",
  "if not u: sys.exit(2)",
  "r = cf.CFURLCreateFileReferenceURL(None, u, None)",
  "cf.CFRelease(u)",
  "if not r: sys.exit(2)",
  "buf = ctypes.create_string_buffer(4096)",
  "ok = cf.CFStringGetCString(cf.CFURLGetString(r), buf, 4096, 0x08000100)",
  "cf.CFRelease(r)",
  "if not ok: sys.exit(2)",
  "sys.stdout.write(buf.value.decode('utf-8'))",
].join("\n");
const DARWIN_PYTHON_CANDIDATES = [
  "/usr/bin/python3",
  "/bin/python3",
  "/opt/homebrew/bin/python3",
  "/usr/local/bin/python3",
  "/Library/Frameworks/Python.framework/Versions/Current/bin/python3",
];
function resolveDarwinFileReferenceUrl(leafEntry) {
  if (process.platform !== "darwin") return null;
  if (typeof spawnSync !== "function") throw new Error("无法安全解析 Finder 文件引用");
  const volPath = `/.vol/${String(leafEntry.dev)}/${String(leafEntry.ino)}`;
  const suffix = `.${String(leafEntry.ino)}${leafEntry.directory ? "/" : ""}`;
  let sawCandidate = false;
  for (const py of DARWIN_PYTHON_CANDIDATES) {
    let executable = false;
    try {
      const st = fs.statSync(py);
      executable = st.isFile() && (st.mode & 0o111) !== 0;
    } catch {
      executable = false;
    }
    if (!executable) continue;
    sawCandidate = true;
    const r = spawnSync(py, ["-I", "-c", DARWIN_FILEREF_PY, volPath, leafEntry.directory ? "1" : "0"], {
      encoding: "utf8",
      timeout: 2000,
      env: { PYTHONDONTWRITEBYTECODE: "1" },
    });
    const url = !r?.error && r?.status === 0 && typeof r.stdout === "string" ? r.stdout.trim() : "";
    if (/^file:\/\/\/\.file\/id=\d+\.\d+\/?$/.test(url) && url.endsWith(suffix)) {
      return url;
    }
  }
  if (!sawCandidate) throw new Error("无法安全解析 Finder 文件引用");
  throw new Error("产物文件引用校验失败，请刷新后重试");
}
function isInside(root, file) {
  const relative = path.relative(root, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
// Capture every directory and the leaf as entities, not just a newly resolved
// realpath boundary. Callers keep this identity across listing and fd access.
function captureArtifactIdentity(root, file, anchorDir = null) {
  root = path.resolve(root); file = path.resolve(file);
  if (!isInside(root, file)) throw new Error("产物路径超出会话目录，无法打开");
  const anchor = anchorDir ? path.resolve(anchorDir) : root;
  if (anchor !== root && !isInside(anchor, root)) throw new Error("产物路径超出可信目录，无法打开");
  const paths = [anchor];
  for (const part of path.relative(anchor, file).split(path.sep)) paths.push(path.join(paths[paths.length - 1], part));
  const realAnchor = fs.realpathSync(anchor);
  const realRoot = anchor === root ? realAnchor : path.join(realAnchor, path.relative(anchor, root));
  const entries = paths.map((entry, index) => {
    const stat = fs.lstatSync(entry);
    if (stat.isSymbolicLink() || (index < paths.length - 1 ? !stat.isDirectory() : !stat.isFile() && !stat.isDirectory())) throw new Error("产物会话路径无法安全确认，请刷新后重试");
    if (fs.realpathSync(entry) !== path.join(realAnchor, path.relative(anchor, entry))) throw new Error("产物会话路径已变化，请刷新后重试");
    return { path: entry, dev: stat.dev, ino: stat.ino, directory: stat.isDirectory() };
  });
  for (const entry of entries) {
    const stat = fs.lstatSync(entry.path);
    if (stat.isSymbolicLink() || stat.dev !== entry.dev || stat.ino !== entry.ino || stat.isDirectory() !== entry.directory) throw new Error("产物会话实体已变化，请刷新后重试");
  }
  if (fs.realpathSync(anchor) !== realAnchor || fs.realpathSync(root) !== realRoot) throw new Error("产物会话路径已变化，请刷新后重试");
  return { anchor, root, realRoot, entries };
}
function assertArtifactIdentity(identity, file) {
  try {
    if (!identity || JSON.stringify(captureArtifactIdentity(identity.root, file, identity.anchor || null)) !== JSON.stringify(identity)) throw new Error("changed");
  } catch { throw new Error("产物会话或文件实体已变化，请刷新产物列表后重试"); }
}
async function revealWithIdentity(identity, target, validate, open, homeDir) {
  // Bind the whole chain from the trusted home anchor through provider/root
  // parents, every session directory and the leaf, then pin Finder's reveal
  // target to an APFS/CoreFoundation inode fileReferenceURL (file:///.file/id=...)
  // verified against the held leaf fd so ancestor swaps cannot redirect Finder.
  const paths = [path.resolve(homeDir)];
  const leaf = identity.entries[identity.entries.length - 1].path;
  if (!isInside(paths[0], leaf)) throw new Error("产物路径超出可信目录，无法打开");
  for (const part of path.relative(paths[0], leaf).split(path.sep)) paths.push(path.join(paths[paths.length - 1], part));
  const held = [];
  const changed = () => new Error("产物会话或文件实体已变化，请刷新产物列表后重试");
  const same = (entry, stat) => !stat.isSymbolicLink() && stat.isDirectory() === entry.directory &&
    (entry.directory || stat.isFile()) && stat.dev === entry.dev && stat.ino === entry.ino && stat.ctimeNs === entry.ctimeNs;
  try {
    const entries = paths.map((file, index) => {
      const stat = fs.lstatSync(file, { bigint: true });
      if (stat.isSymbolicLink() || (index < paths.length - 1 ? !stat.isDirectory() : !stat.isFile() && !stat.isDirectory())) throw changed();
      return { path: file, dev: stat.dev, ino: stat.ino, ctimeNs: stat.ctimeNs, mtimeNs: stat.mtimeNs, directory: stat.isDirectory() };
    });
    for (const entry of entries) {
      const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK || 0) | (entry.directory ? fs.constants.O_DIRECTORY || 0 : 0);
      const fd = fs.openSync(entry.path, flags);
      held.push({ entry, fd });
      if (!same(entry, fs.fstatSync(fd, { bigint: true }))) throw changed();
    }
    const recheck = () => {
      validate();
      for (const { entry, fd } of held) {
        if (!same(entry, fs.lstatSync(entry.path, { bigint: true })) || !same(entry, fs.fstatSync(fd, { bigint: true }))) throw changed();
      }
    };
    recheck();
    const leafHeld = held[held.length - 1];
    const fileReferenceUrl = open === openOnDesktop || (process.platform === "darwin" && typeof spawnSync === "function")
      ? resolveDarwinFileReferenceUrl(leafHeld.entry)
      : null;
    recheck();
    await open("reveal", target, {
      fd: leafHeld.fd,
      dev: leafHeld.entry.dev,
      ino: leafHeld.entry.ino,
      directory: leafHeld.entry.directory,
      fileReferenceUrl,
    });
    recheck();
  } finally {
    for (const { fd } of held.reverse()) { try { fs.closeSync(fd); } catch {} }
  }
}
async function openOnDesktop(mode, target, pinned) {
  if (process.platform !== "darwin") throw new Error("当前系统暂不支持在 Finder 中显示");
  const refUrl = pinned?.fileReferenceUrl;
  if (typeof refUrl !== "string" || !/^file:\/\/\/\.file\/id=\d+\.\d+\/?$/.test(refUrl)) {
    throw new Error("无法安全绑定产物实体，请刷新后重试");
  }
  // Pass only the inode-pinned fileReferenceURL (-u) with -R so Finder neither
  // executes bundles nor traverses mutable ancestor directory paths.
  const args = ["-R", "-u", refUrl];
  await new Promise((resolve, reject) => execFile("/usr/bin/open", args, (error) => error ? reject(error) : resolve()));
}

// Artifacts are accepted only when the current, strictly scoped board listed them.
// Bind both enumeration and subsequent access to the original directory chain.
function createArtifactAccess({ board, homeDir = os.homedir(), open = openOnDesktop } = {}) {
  if (!board || typeof board.getBoardSnapshot !== "function") throw new Error("board is required");
  return async function accessArtifact(payload = {}) {
    const { projectRoot, threadId, operation = "open" } = payload;
    const requested = payload.path;
    if (typeof requested !== "string" || !requested || !path.isAbsolute(requested) || requested.includes("\0") || requested.split(/[\\/]/).includes("..")) throw new Error("无效的产物路径");
    if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot) || typeof threadId !== "string" || !threadId || threadId === "__NEW__") throw new Error("请先打开产物所属的会话");
    if (!["open", "reveal", "folder", "preview"].includes(operation)) throw new Error("不支持的操作");
    const ownership = typeof board.verifyArtifactScope === "function" ? board.verifyArtifactScope({ projectRoot, threadId }) : null;
    if (!ownership?.ok) throw new Error(ownership?.reason === "mismatch" ? "产物不属于当前会话或项目，请刷新后重试" : "暂无法核实当前会话与项目的归属，请稍后刷新重试");
    const absolute = path.resolve(requested);
    const roots = [path.join(homeDir, ".t3", "userdata", "providers", "antigravity"), path.join(homeDir, ".gemini", "antigravity", "brain")];
    const trustedRoot = roots.find((root) => isInside(path.resolve(root), absolute));
    if (!trustedRoot) throw new Error("暂不支持打开此位置的产物");
    let identity;
    try { identity = captureArtifactIdentity(trustedRoot, absolute, homeDir); }
    catch { throw new Error("产物会话路径无法安全确认或文件不存在，请刷新产物列表"); }
    const snapshot = board.getBoardSnapshot({ projectRoot, threadId, strictThreadMatch: true, excludeSubagentInference: true });
    const entries = Array.isArray(snapshot?.artifacts) ? snapshot.artifacts : [];
    const listed = entries.find((item) => {
      const candidate = typeof item === "string" ? item : item?.path;
      return typeof candidate === "string" && path.isAbsolute(candidate) && path.resolve(candidate) === absolute;
    });
    if (!listed) throw new Error("产物不属于当前会话或项目，请刷新后重试");
    const validate = () => {
      assertArtifactIdentity(identity, absolute);
      if (listed.accessIdentity) assertArtifactIdentity(listed.accessIdentity, absolute);
    };
    validate();
    const actual = path.join(identity.realRoot, path.relative(identity.root, absolute));
    const stat = fs.lstatSync(absolute), leaf = identity.entries[identity.entries.length - 1];
    if (stat.isSymbolicLink() || stat.dev !== leaf.dev || stat.ino !== leaf.ino) throw new Error("产物文件实体已变化，请刷新后重试");
    if (operation === "preview" && (!stat.isFile() || path.extname(actual).toLowerCase() !== ".md")) throw new Error("只可预览 Markdown 文件");
    if (!stat.isDirectory() && !stat.isFile()) throw new Error("不支持此产物类型");
    if (stat.isDirectory() || operation === "folder" || operation === "reveal" || path.extname(actual).toLowerCase() !== ".md") {
      await revealWithIdentity(identity, actual, validate, open, homeDir);
      return { ok: true, kind: "revealed", path: absolute };
    }
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
    let fd;
    try {
      fd = fs.openSync(actual, flags);
      const file = fs.fstatSync(fd);
      if (!file.isFile() || file.dev !== leaf.dev || file.ino !== leaf.ino) throw new Error("产物文件实体已变化，请刷新后重试");
      validate();
      if (file.size > MAX_PREVIEW_BYTES) throw new Error("Markdown 文件过大，无法预览；请在 Finder 中查看");
      const data = Buffer.alloc(MAX_PREVIEW_BYTES + 1);
      let read = 0, count;
      while (read < data.length && (count = fs.readSync(fd, data, read, data.length - read, null)) > 0) read += count;
      if (read > MAX_PREVIEW_BYTES) throw new Error("Markdown 文件过大，无法预览；请在 Finder 中查看");
      validate();
      const content = data.subarray(0, read).toString("utf8");
      return { ok: true, kind: "markdown", path: absolute, name: path.basename(absolute), content };
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  };
}

module.exports = { createArtifactAccess, captureArtifactIdentity };
