"use strict";
// Hermetic TDD for memory-vault + embed-manager + pc-lite CLI.
// All state lives under os.tmpdir(); live files and
// ~/Library/Application Support/powercontext/powercontext.db are never touched.
// Run: node --test tests/memory-vault.test.cjs
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { execFileSync, spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const REPO = path.resolve(__dirname, "..");
const { createMemoryVault } = require(path.join(REPO, "src", "memory-vault.cjs"));
const embedMgrMod = require(path.join(REPO, "src", "embed-manager.cjs"));
const { createEmbedManager } = embedMgrMod;

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mem-vault-test-"));
const vaultDir = path.join(tmpRoot, "vault");
const homeTmp = path.join(tmpRoot, "home");
const projA = path.join(tmpRoot, "proj-a");
const projB = path.join(tmpRoot, "proj-b");
fs.mkdirSync(vaultDir, { recursive: true });
fs.mkdirSync(homeTmp, { recursive: true });
fs.mkdirSync(projA, { recursive: true });
fs.mkdirSync(projB, { recursive: true });

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
let mockChild = null;
let mockPort = 0;
let mockUrl = "";
function startMockServer() {
  return new Promise((resolve, reject) => {
    const serverFile = path.join(tmpRoot, "mock-embed.cjs");
    fs.writeFileSync(
      serverFile,
      [
        "const http = require('node:http');",
        "const crypto = require('node:crypto');",
        "const DIM = 16;",
        "function tokVec(tokens){const v=new Array(DIM).fill(0);for(const t of tokens){const h=crypto.createHash('sha256').update(String(t)).digest('hex');const idx=parseInt(h.slice(0,2),16)%DIM;v[idx]+=1;}const n=Math.sqrt(v.reduce((s,x)=>s+x*x,0))||1;return v.map(x=>x/n);}",
        "function tokenize(text){return (String(text).toLowerCase().match(/[\\p{L}\\p{N}_]+/gu)||[]).filter(t=>t.length>0);}",
        "const srv=http.createServer((req,res)=>{",
        " if(req.method==='GET'&&req.url==='/health'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,modelId:'mock-16',servedName:'mock',dim:DIM,rssMb:1,cacheLimitMb:256}));return;}",
        " if(req.method==='POST'&&req.url==='/v1/embeddings'){let b='';req.on('data',c=>b+=c);req.on('end',()=>{let texts=[];try{const j=JSON.parse(b);texts=Array.isArray(j.input)?j.input:[j.input];}catch{texts=[b];}const data=texts.map((t,i)=>({object:'embedding',index:i,embedding:tokVec(tokenize(t))}));res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({object:'list',data,model:'mock',usage:{prompt_tokens:1,total_tokens:1}}));});return;}",
        " res.writeHead(404,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'not found'}));});",
        "srv.listen(0,'127.0.0.1',()=>{console.log('MOCK_PORT='+srv.address().port);});",
      ].join("\n")
    );
    mockChild = spawn("node", [serverFile], { stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    mockChild.stdout.on("data", (c) => {
      buf += String(c);
      const m = buf.match(/MOCK_PORT=(\d+)/);
      if (m) {
        mockPort = Number(m[1]);
        mockUrl = "http://127.0.0.1:" + mockPort + "/v1/embeddings";
        resolve();
      }
    });
    mockChild.on("error", reject);
    mockChild.stderr.on("data", (d) => console.error("[mock-embed]", String(d).trim()));
    setTimeout(() => reject(new Error("mock server start timeout: " + buf)), 8000);
  });
}
async function waitForVectors(vaultDirPath, minCount, timeoutMs = 4000) {
  const dbPath = path.join(vaultDirPath, "index.sqlite");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const db = new DatabaseSync(dbPath);
      try {
        const r = db.prepare("SELECT COUNT(*) AS c FROM memory_vectors").get();
        if (r && Number(r.c) >= minCount) return true;
      } finally {
        db.close();
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}
function makeVault(extra = {}) {
  return createMemoryVault({ vaultDir, homeDir: homeTmp, embeddingUrl: extra.embeddingUrl || "http://127.0.0.1:59999/v1/embeddings", ...extra });
}

before(async () => {
  await startMockServer();
});
after(async () => {
  try {
    if (mockChild) mockChild.kill();
  } catch {}
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});
describe("CRUD across modules", () => {
  it("saves and lists one memory per module", () => {
    const v = makeVault();
    const cases = [
      { module: "constraints", kind: "constraint", title: "铁律-提交测试", content: "提交前必须跑单元测试失败不合并" },
      { module: "architecture", kind: "decision", title: "架构-uv管理", content: "项目决定用 uv 管理 Python 依赖虚拟环境放 .venv" },
      { module: "pitfalls", kind: "pitfall", title: "踩坑-OCR超时", content: "旺店通 OCR 超时需要重试并加退避" },
      { module: "topics", kind: "topic", title: "专题-缓存命中", content: "cache hit 缓存命中率监控面板" },
    ];
    for (const c of cases) {
      const r = v.saveMemory({ projectRoot: projA, ...c });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.item.module, c.module);
      assert.equal(r.item.kind, c.kind);
    }
    for (const c of cases) {
      const l = v.listMemories({ projectRoot: projA, module: c.module });
      assert.equal(l.ok, true);
      assert.ok(l.items.length >= 1, c.module + " should have items");
      assert.ok(l.items.some((i) => i.title === c.title));
    }
    // Markdown files exist for every module.
    const slug = path.basename(projA);
    for (const f of ["constraints.md", "architecture.md", "pitfalls.md", "topics.md"]) {
      assert.ok(fs.existsSync(path.join(vaultDir, "projects", slug, f)), f);
    }
    const meta = JSON.parse(fs.readFileSync(path.join(vaultDir, "projects", slug, "_meta.json"), "utf8"));
    assert.equal(meta.slug, slug);
    assert.equal(meta.projectRoot, projA);
    assert.match(meta.scopeHash, /^[0-9a-f]{64}$/);
  });
  it("dedups by normalized content_hash when id omitted", () => {
    const v = makeVault();
    const r1 = v.saveMemory({ projectRoot: projA, module: "constraints", kind: "constraint", title: "dup-a", content: "同一内容   多余   空格" });
    const r2 = v.saveMemory({ projectRoot: projA, module: "constraints", kind: "constraint", title: "dup-b", content: "同一内容 多余 空格" });
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.equal(r2.deduplicated, true);
    assert.equal(r2.item.id, r1.item.id);
  });
  it("derives module from kind when module omitted", () => {
    const v = makeVault();
    const r = v.saveMemory({ projectRoot: projA, kind: "decision", title: "kind-only", content: "由 kind 推导模块的内容唯一性标记" + Date.now() });
    assert.equal(r.ok, true);
    assert.equal(r.item.module, "architecture");
  });
  it("deletes from markdown and index", () => {
    const v = makeVault();
    const s = v.saveMemory({ projectRoot: projA, module: "topics", kind: "topic", title: "del-me", content: "待删除内容 " + Date.now() });
    assert.equal(s.ok, true);
    const d = v.deleteMemory({ projectRoot: projA, id: s.item.id });
    assert.equal(d.ok, true);
    assert.equal(d.deleted, true);
    const l = v.listMemories({ projectRoot: projA, module: "topics" });
    assert.ok(!l.items.some((i) => i.id === s.item.id));
    const d2 = v.deleteMemory({ projectRoot: projA, id: "mem_notfound" });
    assert.equal(d2.deleted, false);
  });
  it("pins idempotently into AGENTS.md", () => {
    const v = makeVault();
    const s = v.saveMemory({ projectRoot: projA, module: "constraints", kind: "constraint", title: "pin-rule", content: "钉住规则内容 " + Date.now() });
    const p1 = v.pinToAgentsMd({ projectRoot: projA, id: s.item.id });
    assert.equal(p1.ok, true);
    const c1 = fs.readFileSync(p1.agentsMdPath, "utf8");
    assert.ok(c1.includes("## 📌 Pinned Project Rules"));
    assert.ok(c1.includes("pin-rule"));
    const p2 = v.pinToAgentsMd({ projectRoot: projA, id: s.item.id });
    assert.equal(p2.ok, true);
    const c2 = fs.readFileSync(p1.agentsMdPath, "utf8");
    assert.equal((c2.match(/pin-rule/g) || []).length, (c1.match(/pin-rule/g) || []).length);
  });
  it("gets overview with global and current slug", () => {
    const v = makeVault();
    const o = v.getOverview({ projectRoot: projA });
    assert.equal(o.ok, true);
    assert.equal(o.currentProjectSlug, path.basename(projA));
    assert.ok(o.projects.some((p) => p.slug === "_global" && p.title === "全局通用记忆"));
    assert.ok(o.projects.some((p) => p.slug === path.basename(projA)));
    assert.ok(o.totalMemories >= 4);
    const ghost = v.getOverview({ projectRoot: path.join(tmpRoot, "ghost-proj") });
    assert.equal(ghost.currentProjectSlug, "ghost-proj");
  });
});
describe("two-way Markdown sync + secret guard", () => {
  it("reconciles manual markdown edits via mtime", () => {
    const v = makeVault();
    const s = v.saveMemory({ projectRoot: projA, module: "pitfalls", kind: "pitfall", title: "sync-title", content: "sync-original " + Date.now() });
    assert.equal(s.ok, true);
    const slug = path.basename(projA);
    const f = path.join(vaultDir, "projects", slug, "pitfalls.md");
    let txt = fs.readFileSync(f, "utf8");
    txt = txt.replace("sync-original", "sync-edited");
    fs.writeFileSync(f, txt);
    const future = new Date(Date.now() + 20000);
    fs.utimesSync(f, future, future);
    const sy = v.syncFromMarkdownIfChanged(slug);
    assert.equal(sy.ok, true);
    assert.ok(sy.upserted + sy.deleted > 0 || sy.changedFiles > 0);
    const l = v.listMemories({ projectRoot: projA, module: "pitfalls" });
    const got = l.items.find((i) => i.id === s.item.id);
    assert.ok(got, "edited entry still listed");
    assert.ok(got.content.includes("sync-edited"));
  });
  it("imports id-less manual entries with deterministic ids", () => {
    const v = makeVault();
    const slug = path.basename(projA);
    const f = path.join(vaultDir, "projects", slug, "topics.md");
    const uniq = "手动新增专题 " + Date.now();
    fs.writeFileSync(f, "# 📚 模块专题与交接\n\n## 手动标题\n" + uniq + "\n");
    const future = new Date(Date.now() + 30000);
    fs.utimesSync(f, future, future);
    v.syncFromMarkdownIfChanged(slug);
    const l = v.listMemories({ projectRoot: projA, module: "topics" });
    assert.ok(l.items.some((i) => i.content.includes(uniq)));
  });
  it("rejects secrets in title and content", () => {
    const v = makeVault();
    const sk = "sk" + "-" + "A".repeat(20);
    const gh = "gh" + "p_" + "A".repeat(24);
    const ak = "AK" + "IA" + "A".repeat(16);
    const cases = [
      { title: "t", content: "key " + sk },
      { title: "t", content: "token " + gh },
      { title: "t", content: "id " + ak },
      { title: "t", content: "api_key=supersecretvalue" },
      { title: "t", content: "access_token=abc123" },
      { title: "t", content: "Authorization: call " + "Bearer " + "B".repeat(16) },
      { title: "t", content: "call " + "cookie: " + "session=xyz" },
      { title: "t", content: "password=hunter2" },
      { title: "api_key=bad", content: "normal" },
    ];
    for (const c of cases) {
      const r = v.saveMemory({ projectRoot: projA, module: "constraints", kind: "constraint", ...c });
      assert.equal(r.ok, false, JSON.stringify(c));
      assert.equal(r.error, "检测到疑似密钥或凭据，已拦截写入");
    }
    // Clean content passes.
    const ok = v.saveMemory({ projectRoot: projA, module: "constraints", kind: "constraint", title: "clean", content: "ordinary note " + Date.now() });
    assert.equal(ok.ok, true);
  });
});
describe("hybrid search (mock :8001 + offline fallback)", () => {
  it("finds 旺店通 OCR 超时 offline via FTS+CJK", () => {
    const v = makeVault();
    const s = v.saveMemory({ projectRoot: projB, module: "pitfalls", kind: "pitfall", title: "offline-ocr", content: "旺店通 OCR 超时需要加重试退避策略 " + Date.now() });
    assert.equal(s.ok, true);
    const r = v.listMemories({ projectRoot: projB, query: "旺店通 OCR 超时" });
    assert.equal(r.ok, true);
    assert.ok(r.items.some((i) => i.id === s.item.id), "offline CJK hit");
    assert.ok(r.items[0].score > 0);
  });
  it("finds cache hit offline (English)", () => {
    const v = makeVault();
    const s = v.saveMemory({ projectRoot: projB, module: "topics", kind: "topic", title: "cache-topic", content: "cache hit rate high " + Date.now() });
    assert.equal(s.ok, true);
    const r = v.listMemories({ projectRoot: projB, query: "cache hit" });
    assert.ok(r.items.some((i) => i.id === s.item.id));
  });
  it("fuses semantic ranks with mock server (RRF)", async () => {
    const v = makeVault({ embeddingUrl: mockUrl });
    // Ranking needs two independent fixtures. The mock's coarse token hashes
    // can otherwise auto-merge sem-a with an earlier timestamped cache-topic.
    const a = v.saveMemory({ projectRoot: projB, module: "topics", kind: "topic", title: "sem-a", content: "cache hit cache hit cache hit", autoEvolve: false });
    const b = v.saveMemory({ projectRoot: projB, module: "topics", kind: "topic", title: "sem-b", content: "completely unrelated zebra content", autoEvolve: false });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    const ok = await waitForVectors(vaultDir, 2, 5000);
    assert.equal(ok, true, "background embeddings stored");
    const r = v.listMemories({ projectRoot: projB, query: "cache hit" });
    assert.ok(r.items.length >= 2);
    const idxA = r.items.findIndex((i) => i.id === a.item.id);
    const idxB = r.items.findIndex((i) => i.id === b.item.id);
    assert.ok(idxA !== -1 && idxB !== -1);
    assert.ok(idxA < idxB, "cache hit ranks first: " + r.items.map((i) => i.title + ":" + i.score).join(","));
  });
  it("degrades to lexical in 0ms when :8001 offline", () => {
    const v = makeVault({ embeddingUrl: "http://127.0.0.1:59998/v1/embeddings" });
    const s = v.saveMemory({ projectRoot: projB, module: "topics", kind: "topic", title: "degrade-" + Date.now(), content: "lexical only content " + Date.now() });
    assert.equal(s.ok, true);
    const t0 = Date.now();
    const r = v.listMemories({ projectRoot: projB, query: "lexical" });
    assert.ok(Date.now() - t0 < 800, "offline degrade is fast");
    assert.ok(r.items.some((i) => i.id === s.item.id));
  });
  it("respects module filter and includeGlobal", () => {
    const v = makeVault();
    const g = v.saveMemory({ projectSlug: "_global", module: "constraints", kind: "constraint", title: "global-rule-" + Date.now(), content: "全局共享规则内容 " + Date.now() });
    assert.equal(g.ok, true);
    const only = v.listMemories({ projectRoot: projB, module: "constraints" });
    assert.ok(!only.items.some((i) => i.id === g.item.id));
    const withG = v.listMemories({ projectRoot: projB, module: "constraints", includeGlobal: true });
    assert.ok(withG.items.some((i) => i.id === g.item.id));
  });
});
describe("migration from powercontext.db", () => {
  it("imports scopes/atomic/topics/artifacts and is idempotent", () => {
    const dbPath = path.join(tmpRoot, "powercontext.db");
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    const src = new DatabaseSync(dbPath);
    src.exec(
      "CREATE TABLE pc_scopes(scope_id VARCHAR(256) NOT NULL, title VARCHAR(256) NOT NULL, summary VARCHAR(2000) NOT NULL, scope_id_search TEXT NOT NULL, title_search TEXT NOT NULL, summary_search TEXT NOT NULL, parent_scope_id VARCHAR(256), version INTEGER NOT NULL, PRIMARY KEY(scope_id));" +
      "CREATE TABLE pc_scope_bindings(integration VARCHAR(128) NOT NULL, kind VARCHAR(64) NOT NULL, external_id VARCHAR(256) NOT NULL, external_id_search TEXT NOT NULL, scope_id VARCHAR(256) NOT NULL, PRIMARY KEY(integration, kind, external_id));" +
      "CREATE TABLE pc_atomic_memory_current(scope_id VARCHAR(256) NOT NULL, artifact_id VARCHAR(128) NOT NULL, revision BIGINT NOT NULL, state_version BIGINT NOT NULL, content_hash VARCHAR(64) NOT NULL, projection_format VARCHAR(64) NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, searchable_text TEXT NOT NULL, tag_keys TEXT NOT NULL, embedding BLOB, profile_fingerprint VARCHAR(64), embedding_input_hash VARCHAR(64), description VARCHAR(200), PRIMARY KEY(scope_id, artifact_id));" +
      "CREATE TABLE pc_topic_memory_active_topics(scope_id VARCHAR(256) NOT NULL, family VARCHAR(128) NOT NULL, artifact_id VARCHAR(128) NOT NULL, revision INTEGER NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL, searchable_text TEXT NOT NULL, source_count INTEGER NOT NULL, PRIMARY KEY(scope_id, artifact_id));" +
      "CREATE TABLE pc_topic_memory_active_chunks(scope_id VARCHAR(256) NOT NULL, family VARCHAR(128) NOT NULL, artifact_id VARCHAR(128) NOT NULL, revision INTEGER NOT NULL, chunk_ordinal INTEGER NOT NULL, start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL, chunk_text TEXT NOT NULL, searchable_text TEXT NOT NULL, policy_version VARCHAR(32) NOT NULL, PRIMARY KEY(scope_id, artifact_id, chunk_ordinal));" +
      "CREATE TABLE pc_artifact_heads(scope_id VARCHAR(256) NOT NULL, family VARCHAR(128) NOT NULL, artifact_id VARCHAR(128) NOT NULL, revision INTEGER NOT NULL, searchable_text TEXT, lifecycle_state VARCHAR(16) DEFAULT 'active' NOT NULL, replacement_artifact_id VARCHAR(128), merged_into_id VARCHAR(128), governance_generation BIGINT DEFAULT '0' NOT NULL, PRIMARY KEY(scope_id, family, artifact_id));" +
      "CREATE TABLE pc_artifacts(scope_id VARCHAR(256) NOT NULL, family VARCHAR(128) NOT NULL, artifact_id VARCHAR(128) NOT NULL, revision INTEGER NOT NULL, content BLOB NOT NULL, created_at DATETIME, created_by VARCHAR(2048), restored_from_revision INTEGER, rollback_reason VARCHAR(1024), PRIMARY KEY(scope_id, family, artifact_id, revision));"
    );
    const migProj = path.join(tmpRoot, "mig-proj");
    fs.mkdirSync(migProj, { recursive: true });
    const wsKey = crypto.createHash("sha256").update(path.resolve(migProj)).digest("hex");
    src.prepare("INSERT INTO pc_scopes VALUES (?,?,?,?,?,?,?,?)").run("scp_mig_a", "mig-proj", "Project memory for " + migProj, "", "", "", null, 1);
    src.prepare("INSERT INTO pc_scopes VALUES (?,?,?,?,?,?,?,?)").run("scp_mig_arch", "Archived-Test", "Archived overnight batch", "", "", "", null, 2);
    src.prepare("INSERT INTO pc_scopes VALUES (?,?,?,?,?,?,?,?)").run("scp_mig_default", "Default", "Default fallback scope for unbound non-project requests", "", "", "", null, 1);
    src.prepare("INSERT INTO pc_scope_bindings VALUES (?,?,?,?,?)").run("magpie", "workspace", wsKey, "", "scp_mig_a");
    src.prepare("INSERT INTO pc_atomic_memory_current VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("scp_mig_a", "art_c1", 1, 0, "h1", "powercontext.atomic-memory.current.v1", "constraint", "提交前必须跑测试失败不合并", "x", "[]", null, null, null, "提交前测试约束");
    src.prepare("INSERT INTO pc_atomic_memory_current VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("scp_mig_a", "art_d1", 1, 0, "h2", "powercontext.atomic-memory.current.v1", "decision", "用 uv 管理依赖", "x", "[]", null, null, null, "uv决策");
    src.prepare("INSERT INTO pc_atomic_memory_current VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("scp_mig_default", "art_g1", 1, 0, "h3", "powercontext.atomic-memory.current.v1", "fact", "全局事实内容", "x", "[]", null, null, null, "全局事实");
    src.prepare("INSERT INTO pc_topic_memory_active_topics VALUES (?,?,?,?,?,?,?,?)").run("scp_mig_a", "topic-memory", "top1", 1, "专题标题", "专题摘要", "x", 1);
    src.prepare("INSERT INTO pc_topic_memory_active_chunks VALUES (?,?,?,?,?,?,?,?,?,?)").run("scp_mig_a", "topic-memory", "top1", 1, 0, 0, 5, "专题详情正文", "x", "v1");
    const exp = JSON.stringify({ situation: "OCR超时场景", action: "加重试", outcome: "恢复", lesson: "必须重试退避", failure: null });
    src.prepare("INSERT INTO pc_artifact_heads VALUES (?,?,?,?,?,?,?,?,?)").run("scp_mig_a", "experience", "exp1", 1, "x", "active", null, null, 0);
    src.prepare("INSERT INTO pc_artifacts(scope_id, family, artifact_id, revision, content, created_at) VALUES (?,?,?,?,?,?)").run("scp_mig_a", "experience", "exp1", 1, Buffer.from(exp, "utf8"), "2026-11-11 12:00:00");
    src.close();
    const v = makeVault();
    const m1 = v.migrateFromPowerContext({ dbPath });
    assert.equal(m1.ok, true, JSON.stringify(m1));
    assert.equal(m1.alreadyMigrated, false);
    assert.equal(m1.stats.projects, 3);
    assert.ok(m1.stats.total >= 5, "total=" + JSON.stringify(m1.stats));
    assert.ok(m1.stats.constraints >= 1);
    assert.ok(m1.stats.architecture >= 1);
    assert.ok(m1.stats.topics >= 1);
    assert.ok(m1.stats.pitfalls >= 1);
    assert.ok(fs.existsSync(path.join(vaultDir, "migration-receipt.json")));
    const slug = "mig-proj";
    assert.ok(fs.existsSync(path.join(vaultDir, "projects", slug, "constraints.md")));
    assert.ok(fs.existsSync(path.join(vaultDir, "projects", "Archived-Test", "architecture.md")));
    assert.ok(fs.existsSync(path.join(vaultDir, "global", "architecture.md")));
    const l1 = v.listMemories({ projectRoot: migProj, query: "测试" });
    assert.ok(l1.items.some((i) => i.content.includes("提交前必须跑测试")));
    const l2 = v.listMemories({ projectSlug: "_global", query: "全局" });
    assert.ok(l2.items.some((i) => i.content.includes("全局事实")));
    const m2 = v.migrateFromPowerContext({ dbPath });
    assert.equal(m2.ok, true);
    assert.equal(m2.alreadyMigrated, true);
    assert.deepEqual(m2.stats, m1.stats);
    const m3 = v.migrateFromPowerContext({ dbPath, force: true });
    assert.equal(m3.ok, true);
    assert.equal(m3.alreadyMigrated, false);
  });
});
describe("pc-lite CLI end-to-end", () => {
  const cliProj = path.join(tmpRoot, "cli-proj");
  const cliVault = path.join(tmpRoot, "cli-vault");
  const cliHome = path.join(tmpRoot, "cli-home");
  function runCli(args) {
    return execFileSync("node", [path.join(REPO, "scripts", "pc-lite.mjs"), ...args], {
      encoding: "utf8",
      cwd: cliProj,
      env: { ...process.env, HOME: cliHome, T3_MEMORY_VAULT_DIR: cliVault, T3_EMBED_URL: "http://127.0.0.1:59999/v1/embeddings" },
    });
  }
  it("ensure/recall/rule/experience work", () => {
    fs.mkdirSync(cliProj, { recursive: true });
    fs.mkdirSync(cliHome, { recursive: true });
    const ens = runCli(["ensure"]);
    assert.ok(ens.includes("Vault slug="));
    assert.ok(ens.includes("created="));
    const rule = runCli(["rule", "--kind", "constraint", "--text", "CLI铁律旺店通OCR超时重试"]);
    assert.ok(rule.includes("Vault rule"));
    const rec = runCli(["recall", "--query", "旺店通"]);
    assert.ok(rec.includes("CLI铁律旺店通OCR超时重试"));
    const exp = runCli([
      "experience",
      "--cue", "OCR超时",
      "--symptom", "接口卡死",
      "--situation", "旺店通批量OCR时超时",
      "--action", "加重试退避",
      "--outcome", "超时消除",
      "--condition", "回归通过",
      "--lesson", "OCR必须重试归一",
    ]);
    assert.ok(exp.includes("Vault experience"));
    const rec2 = runCli(["recall", "--query", "OCR必须重试"]);
    assert.ok(rec2.includes("OCR必须重试归一"));
    const wr = runCli(["write", "--module", "topics", "--kind", "topic", "--title", "cli-write", "--content", "cli write 内容 unique" + Date.now()]);
    assert.ok(wr.includes("Vault write"));
    const sr = runCli(["search", "--query", "cli write"]);
    assert.ok(sr.includes("Vault slug="));
  });
  it("rule rejects secrets", () => {
    let failed = false;
    try {
      runCli(["rule", "--kind", "constraint", "--text", "api_key=supersecretvalue"]);
    } catch (e) {
      failed = true;
      const out = String(e.stdout || "") + String(e.stderr || "");
      assert.ok(out.includes("拦截"));
    }
    assert.equal(failed, true);
  });
});
describe("embed-manager", () => {
  it("detects preset caches, fts5 switch and custom validation", () => {
    const mgrHome = path.join(tmpRoot, "emb-home");
    const hub = path.join(mgrHome, ".t3", "hub");
    const cache = path.join(mgrHome, ".cache", "huggingface", "hub");
    const safe = "models--mlx-community--embeddinggemma-2-8bit";
    // 仅 blobs/ 视为下载未完成，不能误报已缓存（embed-manager 安全契约）。
    fs.mkdirSync(path.join(cache, safe, "blobs"), { recursive: true });
    fs.writeFileSync(path.join(cache, safe, "blobs", "x"), "1234");
    fs.mkdirSync(mgrHome, { recursive: true });
    const mgr = createEmbedManager({ homeDir: mgrHome, hubDir: hub, cacheDir: cache, port: 18099, launchAgentPlistPath: null });
    assert.equal(mgr._isModelCached("mlx-community/embeddinggemma-2-8bit"), false, "blobs-only cache must be incomplete");
    // 完整 HF snapshot：snapshots/<rev>/config.json（非空）+ model.safetensors（非空）+ refs/main。
    const rev = "rev1";
    const snap = path.join(cache, safe, "snapshots", rev);
    fs.mkdirSync(snap, { recursive: true });
    fs.writeFileSync(path.join(snap, "config.json"), JSON.stringify({ model_type: "embedding_gemma2" }), "utf8");
    fs.writeFileSync(path.join(snap, "model.safetensors"), "1234");
    fs.mkdirSync(path.join(cache, safe, "refs"), { recursive: true });
    fs.writeFileSync(path.join(cache, safe, "refs", "main"), rev);
    assert.equal(mgr._isModelCached("mlx-community/embeddinggemma-2-8bit"), true, "complete snapshots layout must be cached");
    const st = mgr.getStatus();
    assert.equal(st.ok, true);
    assert.equal(st.port, 18099);
    assert.equal(st.presets.length, 17);
    assert.ok(st.presets.find((x) => x.id === "mlx-community/Octen-Embedding-4B-MLX-4bit"), "should include Octen-Embedding-4B-MLX-4bit");
    const eg = st.presets.find((x) => x.id === "mlx-community/embeddinggemma-2-8bit");
    const qwen = st.presets.find((x) => x.id === "mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ");
    assert.equal(eg.downloaded, true);
    assert.equal(qwen.downloaded, false);
    assert.equal(st.presets.find((x) => x.id === "fts5-zero-ram").downloaded, true);
    const sw = mgr.switchModel({ mode: "fts5" });
    assert.equal(sw.ok, true);
    assert.equal(sw.running, false);
    assert.equal(sw.rssMb, 0);
    const cfg = JSON.parse(fs.readFileSync(path.join(hub, "embed-config.json"), "utf8"));
    assert.equal(cfg.mode, "fts5");
    assert.equal(cfg.modelId, "fts5-zero-ram");
    const st2 = mgr.getStatus();
    assert.equal(st2.mode, "fts5");
    assert.equal(st2.running, false);
    const bad = mgr.switchModel({ mode: "mlx", modelId: "bad id !!" });
    assert.equal(bad.ok, false);
    const goodLocal = path.join(tmpRoot, "local-embed-model");
    fs.mkdirSync(goodLocal, { recursive: true });
    assert.equal(embedMgrMod.validateModelId(goodLocal, mgrHome).ok, true);
    assert.equal(embedMgrMod.validateModelId("mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ", mgrHome).ok, true);
    assert.equal(embedMgrMod.validateModelId("", mgrHome).ok, false);
  });
});

describe("runHygiene 四重治理", () => {
  function hygieneVault(extra = {}) {
    return createMemoryVault({ vaultDir, homeDir: homeTmp, embeddingUrl: "http://127.0.0.1:59999/v1/embeddings", _embedFn: () => null, _healthFn: () => ({ modelId: null, dim: null }), ...extra });
  }
  function setUpdatedAt(vaultDirPath, id, iso) {
    const db = new DatabaseSync(path.join(vaultDirPath, "index.sqlite"));
    try {
      db.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run(iso, id);
    } finally { db.close(); }
  }
  it("免死金牌（constraints/architecture/hit_count/pinned/core）绝不归档", () => {
    const v = hygieneVault();
    const proj = path.join(tmpRoot, "hygiene-immortal-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6));
    fs.mkdirSync(proj, { recursive: true });
    const old = new Date(Date.now() - 100 * 86400000).toISOString();
    // 冷数据候选：pitfalls/topics + hit_count=0 + 无 pinned/core + 超 60 天
    const immortalIds = [];
    const i1 = v.saveMemory({ projectRoot: proj, module: "constraints", kind: "constraint", title: "imm-constraint", content: "imm constraint " + Date.now() + "-" + Math.random(), autoEvolve: false });
    const i2 = v.saveMemory({ projectRoot: proj, module: "architecture", kind: "decision", title: "imm-arch", content: "imm arch " + Date.now() + "-" + Math.random(), autoEvolve: false });
    const i3 = v.saveMemory({ projectRoot: proj, module: "pitfalls", kind: "pitfall", title: "imm-hit", content: "imm hit " + Date.now() + "-" + Math.random(), autoEvolve: false });
    const i4 = v.saveMemory({ projectRoot: proj, module: "pitfalls", kind: "pitfall", title: "imm-pinned", content: "imm pinned " + Date.now() + "-" + Math.random(), tags: ["pinned"], autoEvolve: false });
    const i5 = v.saveMemory({ projectRoot: proj, module: "topics", kind: "topic", title: "imm-core", content: "imm core " + Date.now() + "-" + Math.random(), tags: ["core"], autoEvolve: false });
    for (const r of [i1, i2, i3, i4, i5]) { assert.equal(r.ok, true, JSON.stringify(r)); immortalIds.push(r.item.id); setUpdatedAt(vaultDir, r.item.id, old); }
    // hit_count>=1 免死：直接置 hit_count=1
    {
      const db = new DatabaseSync(path.join(vaultDir, "index.sqlite"));
      try { db.prepare("UPDATE memories SET hit_count = 1 WHERE id = ?").run(i3.item.id); } finally { db.close(); }
    }
    // 再加几条冷数据 + 新鲜冷数据，逼超水位但只有旧冷数据可归档
    const coldIds = [];
    for (let k = 0; k < 4; k++) {
      const c = v.saveMemory({ projectRoot: proj, module: "pitfalls", kind: "pitfall", title: "cold-" + k + "-" + Math.random(), content: "cold流水账 " + k + " " + Date.now() + " " + Math.random(), autoEvolve: false });
      assert.equal(c.ok, true);
      setUpdatedAt(vaultDir, c.item.id, old);
      coldIds.push(c.item.id);
    }
    const fresh = v.saveMemory({ projectRoot: proj, module: "pitfalls", kind: "pitfall", title: "fresh-" + Math.random(), content: "fresh " + Date.now() + " " + Math.random(), autoEvolve: false });
    assert.equal(fresh.ok, true);
    const res = v.runHygiene({ maxActivePerProject: 3, staleDays: 60 });
    assert.equal(res.ok, true, JSON.stringify(res));
    const db = new DatabaseSync(path.join(vaultDir, "index.sqlite"));
    let rows;
    try { rows = db.prepare("SELECT id FROM memories").all(); } finally { db.close(); }
    const active = new Set(rows.map((r) => String(r.id)));
    // 免死金牌仍在
    for (const id of immortalIds) assert.ok(active.has(id), "immortal must remain: " + id);
    assert.ok(active.has(fresh.item.id), "fresh must remain");
    // 冷数据已归档移出
    for (const id of coldIds) assert.ok(!active.has(id), "cold must be archived: " + id);
    const slug = v.resolveProjectSlug(proj);
    const coldFile = path.join(vaultDir, "projects", slug, "_archive", "cold.md");
    assert.ok(fs.existsSync(coldFile), "cold.md should exist");
    const coldText = fs.readFileSync(coldFile, "utf8");
    assert.ok(coldText.includes("cold流水账"), "cold content preserved");
  });
  it("孤儿 worktree 归档到 _archive/worktrees.md 并清理空目录", () => {
    const v = hygieneVault();
    const proj = path.join(tmpRoot, "hygiene-wt-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6));
    fs.mkdirSync(proj, { recursive: true });
    const w = v.saveMemory({ projectRoot: proj, scope: "worktree", worktreeId: "wt-orphan-1", module: "topics", kind: "wip", title: "wt-orphan", content: "wt orphan content " + Math.random(), autoEvolve: false });
    const w2 = v.saveMemory({ projectRoot: proj, scope: "worktree", worktreeId: "wt-orphan-1", module: "pitfalls", kind: "wip", title: "wt-orphan-2", content: "wt orphan content2 " + Math.random(), autoEvolve: false });
    assert.equal(w.ok, true, JSON.stringify(w));
    assert.equal(w2.ok, true, JSON.stringify(w2));
    // 让 updated_at 超 orphanWorktreeDays（默认 7 天）
    const old = new Date(Date.now() - 20 * 86400000).toISOString();
    setUpdatedAt(vaultDir, w.item.id, old);
    setUpdatedAt(vaultDir, w2.item.id, old);
    // activeWorktreeIds 不包含该 worktree => 孤儿
    const res = v.runHygiene({ activeWorktreeIds: [] });
    assert.equal(res.ok, true, JSON.stringify(res));
    const slug = v.resolveProjectSlug(proj);
    const arc = path.join(vaultDir, "projects", slug, "_archive", "worktrees.md");
    assert.ok(fs.existsSync(arc), "worktrees.md should exist");
    const text = fs.readFileSync(arc, "utf8");
    assert.ok(text.includes("wt-orphan"), "archived text preserved");
    assert.ok(text.includes("wt orphan content"), "archived content preserved");
    const l = v.listMemories({ projectSlug: slug, scopeFilter: "all" });
    assert.ok(!l.items.some((i) => i.id === w.item.id || i.id === w2.item.id), "orphan worktree removed from active");
  });
  it("孤儿/旧模型向量清理 + getOverview 体积字段", () => {
    const isoVault = fs.mkdtempSync(path.join(os.tmpdir(), "hygiene-vec-vault-"));
    const v = hygieneVault({ vaultDir: isoVault, _healthFn: () => ({ modelId: "model-new", dim: 16 }) });
    const proj = path.join(tmpRoot, "hygiene-vec-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6));
    fs.mkdirSync(proj, { recursive: true });
    const a = v.saveMemory({ projectRoot: proj, module: "topics", kind: "topic", title: "vec-a-" + Math.random(), content: "vec content a " + Math.random(), autoEvolve: false });
    const b = v.saveMemory({ projectRoot: proj, module: "topics", kind: "topic", title: "vec-b-" + Math.random(), content: "vec content b " + Math.random(), autoEvolve: false });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    const dbPath = path.join(isoVault, "index.sqlite");
    const db = new DatabaseSync(dbPath);
    let orphanDeleted = 0;
    try {
      // 新模型全量覆盖
      const vec = Buffer.from(new Float32Array(16).fill(0.1).buffer);
      db.prepare("INSERT OR REPLACE INTO memory_vectors(id, model_id, dim, vec_f32, updated_at) VALUES (?,?,?,?,?)").run(a.item.id, "model-new", 16, vec, new Date().toISOString());
      db.prepare("INSERT OR REPLACE INTO memory_vectors(id, model_id, dim, vec_f32, updated_at) VALUES (?,?,?,?,?)").run(b.item.id, "model-new", 16, vec, new Date().toISOString());
      // 旧模型遗留（id 存在但模型旧）
      db.prepare("INSERT OR REPLACE INTO memory_vectors(id, model_id, dim, vec_f32, updated_at) VALUES (?,?,?,?,?)").run("mem_legacy_1", "model-old", 16, vec, new Date().toISOString());
      db.prepare("INSERT OR REPLACE INTO memory_vectors(id, model_id, dim, vec_f32, updated_at) VALUES (?,?,?,?,?)").run("mem_ghost", "model-old", 16, vec, new Date().toISOString());
      orphanDeleted = 2;
    } finally { db.close(); }
    const res = v.runHygiene({ vacuum: true });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.ok((res.orphanVectorsDeleted || 0) >= orphanDeleted, "orphan deleted");
    let after;
    {
      const db2 = new DatabaseSync(dbPath);
      try {
        after = db2.prepare("SELECT id, model_id FROM memory_vectors").all();
        const orphanStill = db2.prepare("SELECT COUNT(*) AS c FROM memory_vectors WHERE id NOT IN (SELECT id FROM memories)").get();
        assert.equal(Number(orphanStill.c), 0, "no orphan vectors remain");
      } finally { db2.close(); }
    }
    // 新模型向量保留
    assert.ok(after.some((r) => String(r.id) === a.item.id && r.model_id === "model-new"), "new vector kept");
    const o = v.getOverview({ projectRoot: proj });
    assert.equal(o.ok, true);
    assert.equal(typeof o.dbSizeBytes, "number");
    assert.equal(typeof o.dbSizeMb, "number");
    assert.ok(o.dbSizeBytes > 0);
    assert.ok(o.dbSizeMb > 0);
    assert.equal(typeof o.vectorCount, "number");
    assert.equal(typeof o.staleVectorCount, "number");
    assert.equal(typeof o.worktreeMemoryCount, "number");
    assert.equal(typeof o.archivedCount, "number");
  });
});

describe("Dream System (AutoDream)", () => {
  function makeDreamVault(extra = {}) {
    const isoBase = fs.mkdtempSync(path.join(os.tmpdir(), "dream-test-"));
    const isoVault = path.join(isoBase, "memory");
    const isoHub = isoBase;
    const isoHome = path.join(isoBase, "home");
    fs.mkdirSync(isoVault, { recursive: true });
    fs.mkdirSync(isoHome, { recursive: true });
    const v = createMemoryVault({
      vaultDir: isoVault,
      hubDir: isoHub,
      homeDir: isoHome,
      embeddingUrl: "http://127.0.0.1:59999/v1/embeddings",
      _embedFn: () => null,
      _healthFn: () => ({ modelId: null, dim: null }),
      ...extra,
    });
    return { v, isoBase, isoVault, isoHub };
  }
  function setHitCount(vaultDirPath, id, n) {
    const db = new DatabaseSync(path.join(vaultDirPath, "index.sqlite"));
    try {
      db.prepare("UPDATE memories SET hit_count = ? WHERE id = ?").run(Number(n), id);
    } finally { db.close(); }
  }
  function setUpdatedAtDream(vaultDirPath, id, iso) {
    const db = new DatabaseSync(path.join(vaultDirPath, "index.sqlite"));
    try {
      db.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run(iso, id);
    } finally { db.close(); }
  }

  it("updateDreamConfig 校验合法/非法 HH:MM 与开关持久化", () => {
    const { v, isoHub } = makeDreamVault();
    const state0 = v.getDreamState();
    assert.equal(state0.ok, true);
    assert.equal(state0.config.enabled, true);
    assert.equal(state0.config.dreamTime, "03:00");
    assert.equal(state0.config.catchUpOnWake, true);
    assert.equal(state0.config.lastDreamAt, null);
    assert.equal(state0.config.lastDreamDate, null);
    assert.equal(state0.config.dreamCount, 0);
    assert.equal(state0.config.lastReport, null);
    assert.ok(Array.isArray(state0.journal));
    // 合法更新
    const ok = v.updateDreamConfig({ dreamTime: "04:30", enabled: false, catchUpOnWake: false });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(ok.config.dreamTime, "04:30");
    assert.equal(ok.config.enabled, false);
    assert.equal(ok.config.catchUpOnWake, false);
    const state1 = v.getDreamState();
    assert.equal(state1.config.dreamTime, "04:30");
    assert.equal(state1.config.enabled, false);
    assert.equal(state1.config.catchUpOnWake, false);
    const persisted = JSON.parse(fs.readFileSync(path.join(isoHub, "dream-config.json"), "utf8"));
    assert.equal(persisted.dreamTime, "04:30");
    assert.equal(persisted.enabled, false);
    // 非法 HH:MM
    for (const bad of ["25:00", "3:00", "03-00", "ab:cd", "24:00", "03:60", "", "0300"]) {
      const badRes = v.updateDreamConfig({ dreamTime: bad });
      assert.equal(badRes.ok, false, JSON.stringify({ bad, badRes }));
      assert.equal(badRes.error, "invalid dreamTime (expected HH:MM)");
    }
    // 非法不应覆盖已存值
    assert.equal(v.getDreamState().config.dreamTime, "04:30");
    // 合法边界值
    const b1 = v.updateDreamConfig({ dreamTime: "00:00" });
    assert.equal(b1.ok, true);
    const b2 = v.updateDreamConfig({ dreamTime: "23:59" });
    assert.equal(b2.ok, true);
    assert.equal(v.getDreamState().config.dreamTime, "23:59");
    // 开关持久化回读
    const b3 = v.updateDreamConfig({ enabled: true, catchUpOnWake: true });
    assert.equal(b3.ok, true);
    assert.equal(v.getDreamState().config.enabled, true);
    assert.equal(v.getDreamState().config.catchUpOnWake, true);
  });

  it("runDreamCycle 四阶段联动：合并/晋升/归档/日志与 overview", async () => {
    const { v, isoVault, isoHub } = makeDreamVault();
    const proj = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dream-proj-")), "proj");
    fs.mkdirSync(proj, { recursive: true });
    // Phase1 合并：两条同义记忆（autoEvolve 关闭保证双行）
    const a = v.saveMemory({ projectRoot: proj, module: "topics", kind: "topic", title: "dream-cache-ttl-rule", content: "cache ttl must be 60 seconds for api responses to reduce load", autoEvolve: false });
    const b = v.saveMemory({ projectRoot: proj, module: "topics", kind: "topic", title: "dream-cache-ttl-rule", content: "cache ttl must be 60 seconds for api responses to reduce load retries", autoEvolve: false });
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.equal(b.ok, true, JSON.stringify(b));
    assert.notEqual(a.item.id, b.item.id);
    // Phase2 晋升：hit_count>=2 的 worktree
    const w = v.saveMemory({ projectRoot: proj, scope: "worktree", worktreeId: "dream-wt-promote", module: "topics", kind: "wip", title: "dream-wt-promote", content: "dream wt promote content " + Date.now(), autoEvolve: false });
    assert.equal(w.ok, true, JSON.stringify(w));
    setHitCount(isoVault, w.item.id, 2);
    // Phase3 归档目标：过期孤儿 worktree 碎片（hit 0、无免死标签）
    const orphan = v.saveMemory({ projectRoot: proj, scope: "worktree", worktreeId: "dream-wt-orphan", module: "topics", kind: "wip", title: "dream-wt-orphan", content: "dream wt orphan fragment " + Date.now(), autoEvolve: false });
    assert.equal(orphan.ok, true, JSON.stringify(orphan));
    const old = new Date(Date.now() - 20 * 86400000).toISOString();
    setUpdatedAtDream(isoVault, orphan.item.id, old);
    // 免死金牌：旧 constraints 绝不归档
    const immortal = v.saveMemory({ projectRoot: proj, module: "constraints", kind: "constraint", title: "dream-immortal", content: "dream immortal constraint " + Date.now(), autoEvolve: false });
    assert.equal(immortal.ok, true, JSON.stringify(immortal));
    setUpdatedAtDream(isoVault, immortal.item.id, old);
    const res = await v.runDreamCycle({ reason: "manual" });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.ok(res.report.mergedCount >= 1, "mergedCount " + res.report.mergedCount);
    assert.ok(res.report.promotedCount >= 1, "promotedCount " + res.report.promotedCount);
    assert.ok(res.report.archivedCount >= 1, "archivedCount " + res.report.archivedCount);
    assert.equal(typeof res.report.scannedProjects, "number");
    assert.ok(res.report.scannedProjects >= 1);
    assert.equal(res.report.reason, "manual");
    // 晋升验证：worktree 已变 shared
    const promotedList = v.listMemories({ projectRoot: proj, scopeFilter: "all", limit: 50 });
    const promotedItem = promotedList.items.find((i) => i.id === w.item.id);
    assert.ok(promotedItem, "promoted item still present");
    assert.equal(promotedItem.scope === "shared" || promotedItem.memory_scope === "shared" ? "shared" : String(promotedItem.scope || promotedItem.memory_scope), "shared");
    // 孤儿已归档移出活跃
    assert.ok(!promotedList.items.some((i) => i.id === orphan.item.id), "orphan archived");
    // 免死金牌仍在
    assert.ok(promotedList.items.some((i) => i.id === immortal.item.id), "immortal preserved");
    // dream-journal.json 写入且 getOverview().dream.lastReport 可读
    const journalFile = path.join(isoHub, "dream-journal.json");
    assert.ok(fs.existsSync(journalFile), "dream-journal.json should exist");
    const journalRaw = JSON.parse(fs.readFileSync(journalFile, "utf8"));
    const entries = Array.isArray(journalRaw) ? journalRaw : journalRaw.entries;
    assert.ok(Array.isArray(entries));
    assert.ok(entries.length >= 1);
    assert.equal(entries[entries.length - 1].at, res.report.at);
    const ov = v.getOverview({ projectRoot: proj });
    assert.equal(ov.ok, true);
    assert.ok(ov.dream, "overview.dream should exist");
    assert.ok(ov.dream.lastReport, "overview.dream.lastReport");
    assert.equal(ov.dream.lastReport.at, res.report.at);
    assert.equal(res.config.dreamCount, 1);
    assert.equal(res.config.lastDreamAt, res.report.at);
    assert.equal(res.config.lastDreamDate, res.report.date);
    const st = v.getDreamState();
    assert.equal(st.config.dreamCount, 1);
    assert.ok(st.journal.length >= 1);
  });

  it("checkAndRunDueDream 未到点/精准触发/同日不重复/唤醒补梦", async () => {
    // 未到点不触发
    {
      const { v, isoBase } = makeDreamVault();
      const proj = path.join(isoBase, "proj-notdue");
      fs.mkdirSync(proj, { recursive: true });
      const s = v.saveMemory({ projectRoot: proj, module: "topics", kind: "topic", title: "dream-notdue", content: "dream notdue content " + Date.now(), autoEvolve: false });
      assert.equal(s.ok, true);
      v.updateDreamConfig({ dreamTime: "03:00", enabled: true, catchUpOnWake: true });
      const now = new Date(2026, 10, 15, 2, 0, 0);
      const r = await v.checkAndRunDueDream({ now });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.triggered, false, JSON.stringify(r));
    }
    // 03:00 精准触发 + 同一天不重复
    {
      const { v, isoBase } = makeDreamVault();
      const proj = path.join(isoBase, "proj-sched");
      fs.mkdirSync(proj, { recursive: true });
      const s = v.saveMemory({ projectRoot: proj, module: "topics", kind: "topic", title: "dream-sched", content: "dream sched content " + Date.now(), autoEvolve: false });
      assert.equal(s.ok, true);
      v.updateDreamConfig({ dreamTime: "03:00", enabled: true, catchUpOnWake: true });
      const now = new Date(2026, 10, 15, 3, 0, 0);
      const r = await v.checkAndRunDueDream({ now });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.triggered, true, JSON.stringify(r));
      assert.equal(r.report.reason, "scheduled");
      assert.equal(r.config.lastDreamDate, "2026-11-15");
      const now2 = new Date(2026, 10, 15, 3, 2, 0);
      const r2 = await v.checkAndRunDueDream({ now: now2 });
      assert.equal(r2.ok, true, JSON.stringify(r2));
      assert.equal(r2.triggered, false, JSON.stringify(r2));
      assert.equal(r2.reason, "already-dreamed-today");
    }
    // 合盖睡过 03:00 在 09:00 唤醒触发 catchup
    {
      const { v, isoBase } = makeDreamVault();
      const proj = path.join(isoBase, "proj-catchup");
      fs.mkdirSync(proj, { recursive: true });
      const s = v.saveMemory({ projectRoot: proj, module: "topics", kind: "topic", title: "dream-catchup", content: "dream catchup content " + Date.now(), autoEvolve: false });
      assert.equal(s.ok, true);
      v.updateDreamConfig({ dreamTime: "03:00", enabled: true, catchUpOnWake: true });
      const now = new Date(2026, 10, 15, 9, 0, 0);
      const r = await v.checkAndRunDueDream({ now });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.triggered, true, JSON.stringify(r));
      assert.equal(r.report.reason, "catchup");
    }
  });
});

describe("memory-vault: slow 1100ms batch reindex does not truncate, sync keeps 800ms", () => {
  let slowChild = null;
  let slowUrl = "";
  let slowVaultDir = "";
  let slowVaultRoot = "";
  let slowHomeDir = "";
  let slowProj = "";

  function startSlowMockServer() {
    return new Promise((resolve, reject) => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), "slow-mock-"));
      const file = path.join(base, "slow.cjs");
      const code = [
        "const http = require('node:http');",
        "const crypto = require('node:crypto');",
        "const DIM = 16;",
        "function tokVec(t){const v=new Array(DIM).fill(0);for(const tok of t){const h=crypto.createHash('sha256').update(String(tok)).digest('hex');const idx=parseInt(h.slice(0,2),16)%DIM;v[idx]+=1;}const n=Math.sqrt(v.reduce((s,x)=>s+x*x,0))||1;return v.map(x=>x/n);}",
        "function tokenize(s){return (String(s).toLowerCase().match(/[\\p{L}\\p{N}_]+/gu)||[]).filter(x=>x.length>0);}",
        "const srv=http.createServer((req,res)=>{",
        " if(req.method==='GET'&&req.url==='/health'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,modelId:'mock-slow',dim:DIM}));return;}",
        " if(req.method==='POST'&&req.url==='/v1/embeddings'){let b='';req.on('data',c=>b+=c);req.on('end',()=>{setTimeout(()=>{let texts=[];try{const j=JSON.parse(b);texts=Array.isArray(j.input)?j.input:[j.input];}catch{texts=[b];}const data=texts.map((t,i)=>({object:'embedding',index:i,embedding:tokVec(tokenize(t))}));res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({object:'list',data,model:'mock-slow'}));},1100);});return;}",
        " res.writeHead(404);res.end('nf');});",
        "srv.listen(0,'127.0.0.1',()=>{console.log('SLOW_PORT='+srv.address().port);});",
      ].join("\n");
      fs.writeFileSync(file, code);
      const child = spawn("node", [file], { stdio: ["ignore", "pipe", "pipe"] });
      let buf = "";
      child.stdout.on("data", (c) => {
        buf += String(c);
        const m = buf.match(/SLOW_PORT=(\d+)/);
        if (m) {
          slowUrl = "http://127.0.0.1:" + Number(m[1]) + "/v1/embeddings";
          resolve(child);
        }
      });
      child.on("error", reject);
      child.stderr.on("data", (d) => console.error("[slow-mock]", String(d).trim()));
      setTimeout(() => reject(new Error("slow start timeout: " + buf)), 8000);
    });
  }

  before(async () => {
    slowChild = await startSlowMockServer();
    slowVaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "slow-vault-"));
    slowVaultDir = path.join(slowVaultRoot, "memory");
    slowHomeDir = path.join(slowVaultRoot, "home");
    slowProj = path.join(slowVaultRoot, "proj-slow");
    fs.mkdirSync(slowVaultDir, { recursive: true });
    fs.mkdirSync(slowHomeDir, { recursive: true });
    fs.mkdirSync(slowProj, { recursive: true });
  });

  after(() => {
    try { if (slowChild) slowChild.kill(); } catch {}
    try { if (slowVaultRoot) fs.rmSync(slowVaultRoot, { recursive: true, force: true }); } catch {}
  });

  it("reindexVectors 1100ms 批量完整写入，同步查询 800ms 快速降级 FTS5", async () => {
    // 未显式传 embeddingTimeoutMs，走批量 30000
    const v = createMemoryVault({ vaultDir: slowVaultDir, homeDir: slowHomeDir, embeddingUrl: slowUrl });
    v.invalidateEmbedHealthCache();
    const stamp = Date.now() + "-" + Math.random().toString(36).slice(2, 6);
    const r1 = v.saveMemory({ projectRoot: slowProj, module: "topics", kind: "topic", title: "slow-a-" + stamp, content: "slow batch content alpha " + stamp, autoEvolve: false });
    const r2 = v.saveMemory({ projectRoot: slowProj, module: "topics", kind: "topic", title: "slow-b-" + stamp, content: "slow batch content beta " + stamp, autoEvolve: false });
    const r3 = v.saveMemory({ projectRoot: slowProj, module: "topics", kind: "topic", title: "slow-c-" + stamp, content: "slow batch content gamma " + stamp, autoEvolve: false });
    assert.equal(r1.ok, true, JSON.stringify(r1));
    assert.equal(r2.ok, true);
    assert.equal(r3.ok, true);

    // 清掉后台异步可能已写的少量向量，强制走 reindex 批量
    {
      const db = new DatabaseSync(path.join(slowVaultDir, "index.sqlite"));
      try { db.prepare("DELETE FROM memory_vectors WHERE id IN (?,?,?)").run(r1.item.id, r2.item.id, r3.item.id); } finally { db.close(); }
    }
    const re = v.reindexVectors({});
    assert.equal(re.ok, true);
    assert.ok(re.promise);
    await re.promise;
    const ok = await waitForVectors(slowVaultDir, 3, 8000);
    assert.equal(ok, true, "reindex should write all vectors despite 1100ms");
    {
      const db = new DatabaseSync(path.join(slowVaultDir, "index.sqlite"));
      try {
        const row = db.prepare("SELECT COUNT(*) AS c FROM memory_vectors WHERE id IN (?,?,?)").get(r1.item.id, r2.item.id, r3.item.id);
        assert.equal(Number(row.c), 3);
      } finally { db.close(); }
    }
    // 同步路径仍 800ms：删向量后查询应快速降级 lexical 仍命中
    {
      const db = new DatabaseSync(path.join(slowVaultDir, "index.sqlite"));
      try { db.prepare("DELETE FROM memory_vectors WHERE id IN (?,?,?)").run(r1.item.id, r2.item.id, r3.item.id); } finally { db.close(); }
    }
    v.invalidateEmbedHealthCache();
    const t0 = Date.now();
    const r = v.listMemories({ projectRoot: slowProj, query: "slow batch" });
    const dt = Date.now() - t0;
    assert.equal(r.ok, true);
    assert.ok(r.items.some((i) => i.id === r1.item.id), "lexical fallback hit after sync timeout");
    // 同步 800ms 超时 + FTS 降级，绝不应等到批量 30000 或 1100 成功才返回慢查询太长；允许 < 2500ms
    assert.ok(dt < 2500, "sync degrade should be fast, got " + dt + "ms");
    // 显式传 embeddingTimeoutMs 时同步异步均尊重该值（此处显式 500ms 仍应快速失败但不抛）
    const vExplicit = createMemoryVault({ vaultDir: slowVaultDir, homeDir: slowHomeDir, embeddingUrl: slowUrl, embeddingTimeoutMs: 500 });
    vExplicit.invalidateEmbedHealthCache();
    const t1 = Date.now();
    const r2q = vExplicit.listMemories({ projectRoot: slowProj, query: "slow batch" });
    const dt2 = Date.now() - t1;
    assert.equal(r2q.ok, true);
    assert.ok(dt2 < 2000, "explicit timeout respected sync fast " + dt2);
  });
});
