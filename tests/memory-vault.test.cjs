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
    const a = v.saveMemory({ projectRoot: projB, module: "topics", kind: "topic", title: "sem-a", content: "cache hit cache hit cache hit" });
    const b = v.saveMemory({ projectRoot: projB, module: "topics", kind: "topic", title: "sem-b", content: "completely unrelated zebra content" });
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
    fs.mkdirSync(path.join(cache, "models--mlx-community--embeddinggemma-2-8bit", "blobs"), { recursive: true });
    fs.writeFileSync(path.join(cache, "models--mlx-community--embeddinggemma-2-8bit", "blobs", "x"), "1234");
    fs.mkdirSync(mgrHome, { recursive: true });
    const mgr = createEmbedManager({ homeDir: mgrHome, hubDir: hub, cacheDir: cache, port: 18099 });
    const st = mgr.getStatus();
    assert.equal(st.ok, true);
    assert.equal(st.port, 18099);
    assert.equal(st.presets.length, 4);
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
