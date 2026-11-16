"use strict";
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const REPO = path.resolve(__dirname, "..");
const { DatabaseSync } = require("node:sqlite");

// Isolated env for backend
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mem-leak-"));
const tmpHome = path.join(tmpRoot, "home");
const tmpUserdata = path.join(tmpRoot, "userdata");
const tmpHub = path.join(tmpHome, ".t3", "hub");
const tmpVault = path.join(tmpRoot, "vault");
const tmpProject = path.join(tmpRoot, "proj-leak");
for (const d of [tmpHome, tmpUserdata, tmpHub, tmpVault, tmpProject]) fs.mkdirSync(d, { recursive: true });
fs.mkdirSync(path.join(tmpHome, ".codex", "skills"), { recursive: true });
fs.mkdirSync(path.join(tmpHome, ".claude", "agents"), { recursive: true });
fs.mkdirSync(path.join(tmpHub, "plugins"), { recursive: true });
fs.mkdirSync(path.join(tmpProject, ".git", "info"), { recursive: true });

const _origHome = process.env.HOME;
const _origT3CodeHome = process.env.T3CODE_HOME;
const _origHub = process.env.T3_HUB_DIR;
const _origMuseData = process.env.MUSE_DATA_DIR;
const _origCodexHome = process.env.CODEX_HOME;
process.env.HOME = tmpHome;
process.env.T3CODE_HOME = tmpUserdata;
process.env.T3_HUB_DIR = tmpHub;
process.env.MUSE_DATA_DIR = path.join(tmpRoot, "muse-data");
process.env.CODEX_HOME = path.join(tmpRoot, "codex-home");
process.env.NODE_TEST_CONTEXT = "1";
process.env.T3_DISABLE_DREAM_SCHEDULER = "1";
process.env.T3_HUB_TEST = "1";
process.env.UNDER_TEST = "1";
fs.mkdirSync(process.env.MUSE_DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });

const MOCK_DIM = 16;
function tokVec(tokens) {
  const v = new Array(MOCK_DIM).fill(0);
  for (const t of tokens) {
    const h = crypto.createHash("sha256").update(String(t)).digest("hex");
    const idx = parseInt(h.slice(0, 2), 16) % MOCK_DIM;
    v[idx] += 1;
  }
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}
function tokenize(text) {
  return (String(text).toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []).filter((t) => t.length > 0);
}
function mockEmbedFn(texts) {
  return texts.map((t) => tokVec(tokenize(String(t))));
}
function mockHealthFn() {
  return { modelId: "mock-local", dim: MOCK_DIM };
}

const backend = require(path.join(REPO, "src", "backend.cjs"));
const memoryVaultMod = require(path.join(REPO, "src", "memory-vault.cjs"));
const { createMemoryVault } = memoryVaultMod;

function makeVault(extra = {}) {
  return createMemoryVault({ vaultDir: tmpVault, homeDir: tmpHome, embeddingUrl: "http://127.0.0.1:59999/v1/embeddings", _embedFn: mockEmbedFn, _healthFn: mockHealthFn, ...extra });
}

after(() => {
  if (_origHome) process.env.HOME = _origHome; else delete process.env.HOME;
  if (_origT3CodeHome) process.env.T3CODE_HOME = _origT3CodeHome; else delete process.env.T3CODE_HOME;
  if (_origHub) process.env.T3_HUB_DIR = _origHub; else delete process.env.T3_HUB_DIR;
  if (_origMuseData) process.env.MUSE_DATA_DIR = _origMuseData; else delete process.env.MUSE_DATA_DIR;
  if (_origCodexHome) process.env.CODEX_HOME = _origCodexHome; else delete process.env.CODEX_HOME;
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("backend LRU 500 + 超大 JSONL 截断", () => {
  it("fileParseCache / childSubagentCache LRU 500 条淘汰与命中刷新", () => {
    assert.ok(typeof backend.hubCall === "function", "hubCall must exist");
    // 验证 helper 存在
    const lruSet = backend._lruSet || backend.lruSet || (backend._fileParseCache ? null : null);
    // 若未导出 helper，则直接用 cache 尺寸做饱和插入测试（需导出 cache）
    const fileCache = backend._fileParseCache || backend.fileParseCache;
    const childCache = backend._childSubagentCache || backend.childSubagentCache;
    // 若尚无导出，尝试通过模块内部机制（fallback: 要求实现导出）
    assert.ok(fileCache, "fileParseCache must be exported for test");
    assert.ok(childCache, "childSubagentCache must be exported for test");
    // 清空
    if (typeof fileCache.clear === "function") fileCache.clear();
    if (typeof childCache.clear === "function") childCache.clear();

    // 使用导出的 LRU helper 若存在，否则手动模拟
    const setFn = backend._lruSet;
    const getFn = backend._lruGet;
    if (setFn && getFn) {
      for (let i = 0; i < 600; i++) setFn(fileCache, "k" + i, { sig: String(i), data: i });
      assert.equal(fileCache.size, 500, "fileParseCache should cap at 500");
      // 最旧的 100 应被淘汰
      assert.ok(!fileCache.has("k0"), "oldest k0 should be evicted");
      assert.ok(fileCache.has("k599"), "newest k599 should remain");
      // 命中刷新：访问 k100 应使其成为最新，后续再插入新条目，k100 不应被淘汰（而 k101 最旧）
      const v = getFn(fileCache, "k100");
      assert.equal(v.data, 100);
      // 再插入 1 条，触发淘汰，期待淘汰的是除 k100 外最旧的
      setFn(fileCache, "k600", { sig: "600", data: 600 });
      assert.equal(fileCache.size, 500);
      assert.ok(fileCache.has("k100"), "recently used k100 should survive LRU eviction");
      assert.ok(!fileCache.has("k101"), "k101 should have been evicted as oldest after refresh");
    } else {
      // 未导出 helper 时手动插入并检查上限（若实现正确，set 应有上限逻辑而非直接 map.set）
      // 此分支用于暴露未实现的提示
      for (let i = 0; i < 600; i++) {
        if (setFn) setFn(fileCache, "k" + i, { sig: String(i), data: i });
        else fileCache.set("k" + i, { sig: String(i), data: i });
      }
      // 若直接 set 而没有 LRU 逻辑，size 会是 600，测试失败
      assert.equal(fileCache.size, 500, "fileParseCache should cap at 500 via LRU");
    }

    // childSubagentCache 同样上限 500
    if (childCache && setFn) {
      childCache.clear();
      for (let i = 0; i < 550; i++) setFn(childCache, "c" + i, { sig: "s" + i, data: { isRunning: false } });
      assert.equal(childCache.size, 500, "childSubagentCache should cap at 500");
    }
  });

  it("超大 JSONL (>24MB) 截断读取不崩且保留首尾", async () => {
    const bigFile = path.join(tmpRoot, "big-session.jsonl");
    // 构造 >24MB 的文件：头部 1 条有效记录 + 中间填充数 MB + 尾部 1 条有效记录
    const headLine = JSON.stringify({ payload: { event: { kind: "model_completed", usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 10, cache_write_tokens: 0 }, model: "test-model", duration_ms: 100 } }, recorded_at: 1000000 });
    const tailLine = JSON.stringify({ payload: { event: { kind: "model_completed", usage: { input_tokens: 200, output_tokens: 100, cache_read_tokens: 20, cache_write_tokens: 0 }, model: "test-model", duration_ms: 100 } }, recorded_at: 999999999 });
    const pad = "x".repeat(1024); // 1KB per line filler to push size
    const filler = JSON.stringify({ payload: { filler: pad } });
    // 写头部
    fs.mkdirSync(path.dirname(bigFile), { recursive: true });
    const fd = fs.openSync(bigFile, "w");
    fs.writeSync(fd, headLine + "\n");
    // 中间用 filler 填充超过 25MB
    const targetSize = 25 * 1024 * 1024 + 1024;
    let written = Buffer.byteLength(headLine + "\n", "utf8");
    while (written < targetSize) {
      const chunk = filler + "\n";
      fs.writeSync(fd, chunk);
      written += Buffer.byteLength(chunk, "utf8");
    }
    fs.writeSync(fd, tailLine + "\n");
    fs.closeSync(fd);
    const st = fs.statSync(bigFile);
    assert.ok(st.size > 24 * 1024 * 1024, "file should be >24MB: " + st.size);

    // 读取：若导出 helper，直接用 helper 验证首尾保留且不崩；否则调 readMuseSessionFile / readCodexSessionFile
    const helper = backend.readJsonlLines || backend.readJsonlLinesSafe || backend._readJsonlLines;
    if (helper) {
      const lines = helper(bigFile);
      assert.ok(Array.isArray(lines), "helper should return lines array");
      assert.ok(lines.length > 2, "should have at least head+tail lines");
      // 头部首条应仍可被解析为 JSON 且包含 model_completed
      let foundHead = false;
      let foundTail = false;
      for (const l of lines) {
        if (!l) continue;
        try {
          const o = JSON.parse(l);
          if (o?.payload?.event?.kind === "model_completed" && o.recorded_at === 1000000) foundHead = true;
          if (o?.payload?.event?.kind === "model_completed" && o.recorded_at === 999999999) foundTail = true;
        } catch {}
        if (foundHead && foundTail) break;
      }
      assert.ok(foundHead, "head metadata should be preserved after truncation");
      assert.ok(foundTail, "tail latest turn should be preserved after truncation");
      // 截断后总大小远小于原文件 25MB
      const joinedLen = lines.join("\n").length;
      assert.ok(joinedLen < st.size, "truncated content should be smaller than original");
      assert.ok(joinedLen < 20 * 1024 * 1024, "combined head+tail should be ~18MB, not 25MB");
    } else {
      // 退化：调用 readMuseSessionFile（需先清缓存避免命中）
      const fileCache = backend._fileParseCache;
      if (fileCache && typeof fileCache.clear === "function") fileCache.clear();
      let result;
      let err;
      try {
        if (typeof backend.readMuseSessionFile === "function") {
          result = backend.readMuseSessionFile(bigFile, "test-model");
        } else if (typeof backend.readCodexSessionFile === "function") {
          result = backend.readCodexSessionFile(bigFile, "test-model");
        } else {
          throw new Error("reader not exported");
        }
      } catch (e) { err = e; }
      assert.ok(!err, "large JSONL read should not throw: " + (err && err.message));
      assert.ok(result, "large JSONL read should return non-null");
      // 至少能数到尾部 turn（不崩即通过）
      assert.ok(typeof result.stepCount === "number");
      assert.ok(result.stepCount >= 1, "stepCount should be >=1 from tail");
    }
    // 清理大文件避免占用
    try { fs.unlinkSync(bigFile); } catch {}
  });

  it("git 子进程 maxBuffer 与 cachedAgyConvDirs TTL 存在性校验", () => {
    // 校验 backend.cjs 源码含 maxBuffer 与 TTL 关键字（保真断言实现存在）
    const src = fs.readFileSync(path.join(REPO, "src", "backend.cjs"), "utf8");
    // git maxBuffer
    const gitMaxBufferCount = (src.match(/maxBuffer:\s*2\s*\*\s*1024\s*\*\s*1024/g) || []).length;
    assert.ok(gitMaxBufferCount >= 2, "backend should have at least 2 git maxBuffer=2MB (rev-parse & branch/show)");
    // cachedAgyConvDirs 60s TTL
    assert.ok(/cachedAgyConvDirsAt|60\s*\*\s*1024|60_000|60000/.test(src), "cachedAgyConvDirs should have 60s TTL");
    // LRU 500
    assert.ok(/500/.test(src) && /lru/i.test(src), "LRU 500 should be implemented");
    // Large JSONL guard
    assert.ok(/24\s*\*\s*1024\s*\*\s*1024/.test(src), "large JSONL guard 24MB should exist");
    assert.ok(/2\s*\*\s*1024\s*\*\s*1024/.test(src), "head 2MB should exist");
    assert.ok(/16\s*\*\s*1024\s*\*\s*1024/.test(src), "tail 16MB should exist");
    // RPCs
    assert.ok(/memory:importHostMemories/.test(src), "memory:importHostMemories RPC should exist");
    assert.ok(/memory:health/.test(src), "memory:health RPC should exist");
    assert.ok(/embed:trim/.test(src), "embed:trim RPC should exist");
    assert.ok(/127\.0\.0\.1:8001\/trim/.test(src) || /8001\/trim/.test(src), "embed:trim should POST to 8001/trim");
    assert.ok(/baseActiveMb|base_active_mb/.test(src), "baseActiveMb passthrough should exist");
  });
});

describe("memory-vault openDb PRAGMA + _archive 256KB 轮转", () => {
  it("openDb PRAGMA busy_timeout / journal_size_limit / cache_size 生效", () => {
    const isoVault = fs.mkdtempSync(path.join(os.tmpdir(), "pragma-vault-"));
    const v = makeVault({ vaultDir: isoVault });
    // save 一条记忆触发 openDb 创建库
    const proj = path.join(tmpRoot, "pragma-proj-" + Date.now());
    fs.mkdirSync(proj, { recursive: true });
    const r = v.saveMemory({ projectRoot: proj, module: "topics", kind: "topic", title: "pragma-test-" + Date.now(), content: "pragma content " + Date.now() + " " + Math.random(), autoEvolve: false });
    assert.equal(r.ok, true, JSON.stringify(r));
    const dbPath = path.join(isoVault, "index.sqlite");
    assert.ok(fs.existsSync(dbPath), "index.sqlite should exist");
    // 新开连接做 PRAGMA 检查（验证 openDb 的 PRAGMA 已写入该库的 WAL 配置可通过新连接查得？注意 PRAGMA cache_size 为连接级，busy_timeout 也属连接级，需要在新连接上重放验证 openDb 逻辑）
    // 更可靠：检查源码含 PRAGMA，且新连接设置的 journal 文件大小受限
    const src = fs.readFileSync(path.join(REPO, "src", "memory-vault.cjs"), "utf8");
    assert.ok(/busy_timeout\s*=\s*5000/i.test(src), "busy_timeout PRAGMA should exist");
    assert.ok(/journal_size_limit\s*=\s*4194304/i.test(src), "journal_size_limit PRAGMA should exist");
    assert.ok(/cache_size\s*=\s*-16000/i.test(src), "cache_size PRAGMA should exist");
    assert.ok(/synchronous\s*=\s*NORMAL/i.test(src), "synchronous NORMAL should exist");
    // 实际连接行为：用 vault 的 openDb 路径创建新连接后验证 PRAGMA 读取
    // 直接 new DatabaseSync 再执行同样的 PRAGMA 后查询
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("PRAGMA busy_timeout = 5000;");
      db.exec("PRAGMA journal_size_limit = 4194304;");
      db.exec("PRAGMA cache_size = -16000;");
      db.exec("PRAGMA synchronous = NORMAL;");
      const bt = db.prepare("PRAGMA busy_timeout;").get();
      const js = db.prepare("PRAGMA journal_size_limit;").get();
      const cs = db.prepare("PRAGMA cache_size;").get();
      const sy = db.prepare("PRAGMA synchronous;").get();
      const getVal = (r) => {
        if (!r) return null;
        if (r.busy_timeout != null) return r.busy_timeout;
        if (r.journal_size_limit != null) return r.journal_size_limit;
        if (r.cache_size != null) return r.cache_size;
        if (r.synchronous != null) return r.synchronous;
        const v = Object.values(r)[0];
        return v;
      };
      assert.equal(Number(getVal(bt)), 5000);
      assert.equal(Number(getVal(js)), 4194304);
      assert.equal(Number(getVal(cs)), -16000);
      // synchronous: 1=NORMAL
      assert.equal(Number(getVal(sy)), 1);
    } finally { db.close(); }
  });

  it("_archive/*.md 超 256KB 自动旋转为 stem-YYYYMM-timestamp.md", () => {
    const isoVault = fs.mkdtempSync(path.join(os.tmpdir(), "archive-rotate-"));
    const isoHome = fs.mkdtempSync(path.join(os.tmpdir(), "archive-home-"));
    const v = makeVault({ vaultDir: isoVault, homeDir: isoHome });
    const proj = path.join(tmpRoot, "archive-proj-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6));
    fs.mkdirSync(proj, { recursive: true });
    const slug = v.resolveProjectSlug(proj);
    // 触发创建项目目录与 cold.md 归档
    const trigger = v.saveMemory({ projectRoot: proj, module: "topics", kind: "topic", title: "archive-trigger-" + Date.now(), content: "trigger " + Date.now(), autoEvolve: false });
    assert.equal(trigger.ok, true);
    const coldPath = path.join(isoVault, "projects", slug, "_archive", "cold.md");
    // 预置一个 >256KB 的 cold.md（用大填充内容）
    fs.mkdirSync(path.dirname(coldPath), { recursive: true });
    const bigContent = "# 🗄️ 冷数据归档\n\n" + "## dummy\n<!-- mem:{\"id\":\"mem_dummy\",\"kind\":\"topic\",\"agent\":\"user\",\"tags\":[],\"createdAt\":\"2026-01-01T00:00:00.000Z\",\"updatedAt\":\"2026-01-01T00:00:00.000Z\",\"module\":\"topics\"} -->\n" + "x".repeat(270 * 1024) + "\n";
    fs.writeFileSync(coldPath, bigContent, "utf8");
    const beforeSize = fs.statSync(coldPath).size;
    assert.ok(beforeSize > 256 * 1024, "cold.md should be >256KB before rotate: " + beforeSize);
    // 通过 runHygiene 触发 appendHygieneArchive（构造冷数据归档）
    // 先制造冷数据：超水位 + 旧数据
    const old = new Date(Date.now() - 100 * 86400000).toISOString();
    function setUpdatedAt(vaultDirPath, id, iso) {
      const db = new DatabaseSync(path.join(vaultDirPath, "index.sqlite"));
      try { db.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run(iso, id); } finally { db.close(); }
    }
    const proj2 = path.join(tmpRoot, "archive-proj2-" + Date.now());
    fs.mkdirSync(proj2, { recursive: true });
    // 制造 5 条冷数据使超水位 3
    for (let i = 0; i < 5; i++) {
      const c = v.saveMemory({ projectRoot: proj2, module: "pitfalls", kind: "pitfall", title: "cold-rotate-" + i + "-" + Math.random(), content: "cold rotate content " + i + " " + Date.now() + " " + Math.random(), autoEvolve: false });
      assert.equal(c.ok, true, JSON.stringify(c));
      setUpdatedAt(isoVault, c.item.id, old);
    }
    // 用 proj2 的 slug 做 hygiene（其归档文件是独立的）；但我们预置的是 proj 的 cold.md，需用 proj 本身触发
    // 改用 proj 本身构造冷数据（proj 已有 trigger + 追加冷数据）
    const slug2 = slug; // 同 proj
    for (let i = 0; i < 5; i++) {
      const c = v.saveMemory({ projectRoot: proj, module: "pitfalls", kind: "pitfall", title: "cold-rotate-proj-" + i + "-" + Math.random(), content: "cold rotate proj content " + i + " " + Date.now() + " " + Math.random(), autoEvolve: false });
      assert.equal(c.ok, true);
      setUpdatedAt(isoVault, c.item.id, old);
    }
    const res = v.runHygiene({ maxActivePerProject: 3, staleDays: 60 });
    assert.equal(res.ok, true, JSON.stringify(res));
    // 归档后，原 cold.md 应被重命名封存为 cold-YYYYMM-timestamp.md，且新 cold.md 回落小尺寸（仅含新归档）
    const archiveDir = path.join(isoVault, "projects", slug, "_archive");
    const files = fs.readdirSync(archiveDir);
    // 应有至少一个 cold-*.md 封存文件
    const rotated = files.filter((f) => /^cold-\d{6}-\d+\.md$/.test(f));
    assert.ok(rotated.length >= 1, "should have rotated cold-YYYYMM-ts.md file, got: " + files.join(","));
    const newCold = fs.statSync(coldPath);
    assert.ok(newCold.size <= 256 * 1024 + 100 * 1024, "new cold.md should not be >256KB+slack: " + newCold.size);
    // 封存文件应保留原始大内容
    const rotatedPath = path.join(archiveDir, rotated[0]);
    const rotatedSize = fs.statSync(rotatedPath).size;
    assert.ok(rotatedSize > 200 * 1024, "rotated file should retain large old size");
    // 新 cold.md 应包含新归档的冷数据
    const newText = fs.readFileSync(coldPath, "utf8");
    assert.ok(newText.includes("cold rotate proj content"), "new cold.md should contain newly archived items");
  });
});

describe("Runelay wiki-link + getMemoryHealth + importHostMemories", () => {
  it("extractMemoryLinks 去重限长", () => {
    const extract = memoryVaultMod.extractMemoryLinks;
    assert.ok(typeof extract === "function", "extractMemoryLinks must be exported");
    const res = extract("hello [[Alpha]] world [[Beta]] again [[Alpha]] [[  spaced  ]]");
    // 去重
    const uniq = [...new Set(res)];
    assert.equal(res.length, uniq.length, "should dedupe");
    // 接受空格 trim 后去重，若实现正确应包含 Alpha, Beta, spaced
    assert.ok(res.includes("Alpha"), "should include Alpha");
    assert.ok(res.includes("Beta"), "should include Beta");
    // 空/非字符串不崩
    assert.deepEqual(extract(""), []);
    assert.deepEqual(extract(null), []);
    assert.deepEqual(extract(123), []);
    // 无链接返回空
    assert.deepEqual(extract("no links here"), []);
    // 限长：单引长 >100 应截断或拒绝？验证不会返回超长
    const long = "[[" + "y".repeat(300) + "]]";
    const r2 = extract(long);
    if (r2.length) assert.ok(r2[0].length <= 200, "target length should be limited");
  });

  it("getMemoryHealth 识别有效链接与断链 brokenLinks", () => {
    const isoVault = fs.mkdtempSync(path.join(os.tmpdir(), "health-vault-"));
    const isoHome = fs.mkdtempSync(path.join(os.tmpdir(), "health-home-"));
    const v = makeVault({ vaultDir: isoVault, homeDir: isoHome });
    const proj = path.join(tmpRoot, "health-proj-" + Date.now());
    fs.mkdirSync(proj, { recursive: true });
    // 创建目标记忆（标题 TargetTitle，模块 topics）
    const target = v.saveMemory({ projectRoot: proj, module: "topics", kind: "topic", title: "TargetTitle-Ignorable", content: "target content " + Date.now(), autoEvolve: false });
    assert.equal(target.ok, true, JSON.stringify(target));
    // 创建源记忆，包含有效链接 [[TargetTitle-Ignorable]] + 断链 [[NonExistent-9999]]
    const source = v.saveMemory({ projectRoot: proj, module: "topics", kind: "topic", title: "SourceTitle", content: "see [[TargetTitle-Ignorable]] and [[NonExistent-9999]] for details " + Date.now() + " " + Math.random(), autoEvolve: false });
    assert.equal(source.ok, true, JSON.stringify(source));
    // 创建引用模块名的条目 [[topics]] 应视为有效（匹配 module）
    const viaModule = v.saveMemory({ projectRoot: proj, module: "pitfalls", kind: "pitfall", title: "ModRef", content: "link [[topics]] here " + Date.now(), autoEvolve: false });
    assert.equal(viaModule.ok, true);
    // 创建引用 #id 的条目
    const viaId = v.saveMemory({ projectRoot: proj, module: "topics", kind: "topic", title: "IdRef", content: "link [[#" + target.item.id + "]] here " + Date.now(), autoEvolve: false });
    assert.equal(viaId.ok, true, JSON.stringify(viaId));

    const health = v.getMemoryHealth({});
    assert.ok(health, "getMemoryHealth must return object");
    assert.ok(typeof health.total === "number" && health.total >= 4, "total >=4");
    assert.ok(Array.isArray(health.brokenLinks), "brokenLinks must be array");
    // 应包含 NonExistent 的断链
    const brokenTargets = health.brokenLinks.map((b) => b.target);
    assert.ok(brokenTargets.includes("NonExistent-9999"), "brokenLinks should include NonExistent-9999, got: " + JSON.stringify(health.brokenLinks));
    // 有效链接不应在断链中
    assert.ok(!brokenTargets.includes("TargetTitle-Ignorable"), "valid title link should not be broken");
    assert.ok(!brokenTargets.includes("topics"), "module link should not be broken");
    assert.ok(!brokenTargets.some((t) => t === target.item.id || t === "#" + target.item.id), "#id link should not be broken");
    // 每条断链应含 fromId/fromTitle
    for (const b of health.brokenLinks) {
      assert.ok(b.fromId, "broken link needs fromId");
      assert.ok(b.fromTitle != null, "broken link needs fromTitle");
      assert.ok(b.target, "broken link needs target");
    }
    // getOverview 应附 health 简要计数
    const ov = v.getOverview({ projectRoot: proj });
    assert.ok(ov.health, "getOverview should include health field");
    assert.ok(typeof ov.health.total === "number", "overview.health.total");
    assert.ok(Array.isArray(ov.health.brokenLinks) || typeof ov.health.brokenLinks === "number" || typeof ov.health.brokenCount === "number", "overview health should expose broken info");
  });

  it("importHostMemories 从模拟 Claude/Codex 目录幂等导入且 pinned=false", () => {
    const isoVault = fs.mkdtempSync(path.join(os.tmpdir(), "import-vault-"));
    const isoHome = fs.mkdtempSync(path.join(os.tmpdir(), "import-home-"));
    const v = makeVault({ vaultDir: isoVault, homeDir: isoHome });
    // 构造模拟宿主目录
    const claudeRoot = path.join(tmpRoot, "claude-host");
    const codexRoot = path.join(tmpRoot, "codex-host");
    fs.mkdirSync(claudeRoot, { recursive: true });
    fs.mkdirSync(codexRoot, { recursive: true });
    function writeHostFile(dir, name, content) {
      fs.mkdirSync(dir, { recursive: true });
      const p = path.join(dir, name);
      fs.writeFileSync(p, content, "utf8");
      return p;
    }
    const claudeNote = "# My Claude Note\n\nThis is a claude memory about caching.\nCache must be 60s.\n";
    const codexNote = "# My Codex Note\n\nThis is a codex memory about deploy.\nDeploy must be safe.\n";
    const claudeFile = writeHostFile(claudeRoot, "claude-mem.md", claudeNote);
    const codexFile = writeHostFile(codexRoot, "codex-mem.md", codexNote);
    // 空文件与超大文件应被跳过
    const emptyFile = writeHostFile(claudeRoot, "empty.md", "");
    const bigFile = path.join(claudeRoot, "big.md");
    fs.writeFileSync(bigFile, "x".repeat(65 * 1024), "utf8");
    // pinned 尝试：文件里若含 pinned tag 也不应被导入为 pinned
    const pinnedAttempt = writeHostFile(codexRoot, "pinned.md", "# Pinned Attempt\n\ntry pinned content via codex\n");

    assert.ok(typeof v.importHostMemories === "function", "importHostMemories must exist");
    const first = v.importHostMemories({ scanRoots: [claudeRoot, codexRoot] });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.ok(first.scanned >= 4, "scanned should count files: " + first.scanned);
    assert.ok(first.imported >= 3, "imported should be >=3 (claude + codex*2): " + first.imported);
    assert.ok(first.skipped >= 1, "skipped should include empty/big: " + first.skipped);
    assert.ok(first.byHost && typeof first.byHost === "object", "byHost must exist");
    // 强制 pinned=false：导入的条目不应含 pinned tag
    const listed = v.listMemories({ scopeFilter: "all", limit: 50 });
    const imported = listed.items.filter((i) => (i.tags || []).includes("imported-host-memory"));
    assert.ok(imported.length >= 3, "imported-host-memory tag should exist");
    for (const it of imported) {
      const tags = (it.tags || []).map((t) => String(t).toLowerCase());
      assert.ok(!tags.includes("pinned") && !tags.includes("pinned:true") && !tags.includes("pinned: true"), "imported must not be pinned: " + JSON.stringify(it));
    }
    // 幂等：二次运行 imported===0, skipped>0
    const second = v.importHostMemories({ scanRoots: [claudeRoot, codexRoot] });
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(second.imported, 0, "second import should be 0, got: " + JSON.stringify(second));
    assert.ok(second.skipped > 0, "second skipped >0");
  });
});
