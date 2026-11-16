"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const MAX_PREVIEW_BYTES = 256 * 1024;
function isInside(root, file) {
  const relative = path.relative(root, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function openOnDesktop(mode, target) {
  if (process.platform !== "darwin") throw new Error("当前系统暂不支持在 Finder 中显示");
  // Finder's open verb can execute application bundles even when stat says
  // "directory". Reveal is safe for ordinary folders and package directories.
  const args = ["-R", target];
  await new Promise((resolve, reject) => execFile("/usr/bin/open", args, (error) => error ? reject(error) : resolve()));
}

// Artifacts are accepted only when the current, strictly scoped board listed them.
// A second realpath check confines symlinks to the same local AGY session folder.
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
    const snapshot = board.getBoardSnapshot({ projectRoot, threadId, strictThreadMatch: true, excludeSubagentInference: true });
    const entries = Array.isArray(snapshot?.artifacts) ? snapshot.artifacts : [];
    const listed = entries.find((item) => {
      const candidate = typeof item === "string" ? item : item?.path;
      return typeof candidate === "string" && path.isAbsolute(candidate) && path.resolve(candidate) === absolute;
    });
    if (!listed) throw new Error("产物不属于当前会话或项目，请刷新后重试");
    const roots = [path.join(homeDir, ".t3", "userdata", "providers", "antigravity"), path.join(homeDir, ".gemini", "antigravity", "brain")];
    const trustedRoot = roots.find((root) => isInside(path.resolve(root), absolute));
    if (!trustedRoot) throw new Error("暂不支持打开此位置的产物");
    let actual, sessionDir, realRoot;
    try {
      realRoot = fs.realpathSync(trustedRoot);
      sessionDir = fs.realpathSync(path.dirname(absolute));
      actual = fs.realpathSync(absolute);
    } catch { throw new Error("文件或文件夹不存在，请刷新产物列表"); }
    if (!isInside(realRoot, sessionDir) || !isInside(sessionDir, actual)) throw new Error("产物路径超出会话目录，无法打开");
    const stat = fs.statSync(actual);
    if (operation === "preview" && (!stat.isFile() || path.extname(actual).toLowerCase() !== ".md")) throw new Error("只可预览 Markdown 文件");
    if (stat.isDirectory()) {
      await open("reveal", actual);
      return { ok: true, kind: "revealed", path: absolute };
    }
    if (!stat.isFile()) throw new Error("不支持此产物类型");
    if (operation === "folder") {
      await open("reveal", actual);
      return { ok: true, kind: "revealed", path: absolute };
    }
    if (operation === "reveal" || path.extname(actual).toLowerCase() !== ".md") {
      await open("reveal", actual);
      return { ok: true, kind: "revealed", path: absolute };
    }
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    const fd = fs.openSync(actual, flags);
    try {
      const file = fs.fstatSync(fd);
      if (!file.isFile() || file.size > MAX_PREVIEW_BYTES) throw new Error("Markdown 文件过大，无法预览；请在 Finder 中查看");
      const data = Buffer.alloc(MAX_PREVIEW_BYTES + 1);
      let read = 0, count;
      while (read < data.length && (count = fs.readSync(fd, data, read, data.length - read, null)) > 0) read += count;
      if (read > MAX_PREVIEW_BYTES) throw new Error("Markdown 文件过大，无法预览；请在 Finder 中查看");
      const content = data.subarray(0, read).toString("utf8");
      return { ok: true, kind: "markdown", path: absolute, name: path.basename(absolute), content };
    } finally { fs.closeSync(fd); }
  };
}

module.exports = { createArtifactAccess };
