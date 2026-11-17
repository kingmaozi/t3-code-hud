"use strict";
// Durable coverage for runelay-inspired meta-tools + long-run leak guards.
// Covers: embed-server 5 guards + embed-manager ceiling/rotation, pinned shield,
// context_search/skill_read/skill_read_file (+ traversal), waiters cleanup,
// stop-nudge 7d, task-plans 30d/200 GC, buffer caps, hooks 1MB.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const REPO = path.resolve(__dirname, "..");
const EMBED_SERVER = path.join(REPO, "src", "embed-server.py");
const EMBED_MANAGER_PATH = path.join(REPO, "src", "embed-manager.cjs");
const ROUTER_PATH = path.join(REPO, "bin", "t3-mcp-router");
const STOP_HOOK = path.join(REPO, "scripts", "memory-stop-hook.mjs");
const TASK_BOARD_PATH = path.join(REPO, "src", "hub-task-board.cjs");
const HOOKS_PATH = path.join(REPO, "src", "hub-hooks.cjs");
const INSTALL_SH = path.join(REPO, "install.sh");

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function expectedCeiling(est) {
  return Math.round(Math.max(est * 1.28 + 180, est + 220));
}

// ---------------------------------------------------------------------------
// Router integration harness (spawns bin/t3-mcp-router as stdio MCP server)
// ---------------------------------------------------------------------------
function startRouter({ homeDir, hubDir, vaultPath, recordPath, cwd, userDataDir, threadId }) {
  const env = {
    ...process.env,
    HOME: homeDir,
    T3_HUB_DIR: hubDir,
    T3_MEMORY_VAULT: vaultPath,
    T3CODE_HOME: userDataDir || path.join(homeDir, ".t3", "userdata"),
    T3_MCP_ROUTER: "",
    STUB_RECORD_PATH: recordPath || "",
  };
  delete env.T3_PROJECT_ROOT;
  delete env.T3_MCP_ROUTER;
  if (threadId == null) delete env.T3CODE_THREAD_ID;
  else env.T3CODE_THREAD_ID = String(threadId);
  const proc = spawn(process.execPath, [ROUTER_PATH], { env, stdio: ["pipe", "pipe", "pipe"], cwd: cwd || homeDir });
  let buffer = "";
  let nextId = 1;
  const pending = new Map();
  const stderrChunks = [];
  proc.stderr.on("data", (d) => { stderrChunks.push(d); if (stderrChunks.length > 50) stderrChunks.splice(0, 20); });
  proc.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg && msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        p.resolve(msg);
      }
    }
  });
  proc.on("error", () => {});
  function rpc(method, params, timeoutMs = 8000) {
    const id = nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("rpc timeout " + method + " stderr=" + stderrChunks.map((c) => c.toString()).join("").slice(0, 500)));
      }, timeoutMs);
      pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); } });
      proc.stdin.write(payload);
    });
  }
  async function callTool(name, args, timeoutMs = 8000) {
    return rpc("tools/call", { name, arguments: args || {} }, timeoutMs);
  }
  async function listTools(timeoutMs = 8000) {
    return rpc("tools/list", {}, timeoutMs);
  }
  function kill() {
    try { proc.stdin.end(); } catch {}
    try { proc.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 500).unref?.();
  }
  return { proc, rpc, callTool, listTools, kill };
}
function makeStubVault(vaultPath) {
  const code = `"use strict";
const fs = require("node:fs");
function record(kind, obj) {
  const rec = process.env.STUB_RECORD_PATH;
  if (!rec) return;
  try { fs.appendFileSync(rec, JSON.stringify({ kind, obj }) + "\\n"); } catch {}
}
module.exports = {
  search: async (args) => {
    record("search", args);
    return { ok: true, items: [{ id: "mem-1", projectSlug: "proj", title: "deploy pitfall embed collision", content: args.query === "long-memory" ? "x".repeat(1200) : "embed port colliding on 8001", module: "pitfalls", scope: "shared", memory_scope: "shared", memoryScope: "shared", updatedAt: "2026-01-01T00:00:00.000Z", version: 3, score: 0.9, history: [{ version: 2, content: "older copy" }] }] };
  },
  read: async (args) => {
    record("read", args);
    return { ok: true, item: { id: "mem-1", title: "deploy pitfall embed collision", content: "embed port colliding on 8001", module: "pitfalls", version: 3, history: [{ version: 2, content: "older copy" }] } };
  },
  write: async (args) => {
    record("write", args);
    return { ok: true, item: { id: "mem-new", ...(args || {}) } };
  },
  consolidateMemories: async (args) => { record("consolidate", args); return { ok: true }; },
  rollbackMemory: async (args) => { record("rollback", args); return { ok: true }; },
};
`;
  fs.writeFileSync(vaultPath, code, "utf8");
}
function makeLegacyReadStubVault(vaultPath) {
  const code = `"use strict";
const fs = require("node:fs");
function record(obj) { try { fs.appendFileSync(process.env.STUB_RECORD_PATH, JSON.stringify(obj) + "\\n"); } catch {} }
const items = [
  { id: "recent-id", title: "Recent", content: "recent body", module: "constraints", history: [] },
  { id: "legacy-id", title: "Older", content: "older body", module: "constraints", history: [{ version: 1, content: "older revision" }] },
];
module.exports = {
  // This older adapter silently ignores an unknown id parameter.
  listMemories: (args) => { record(args); return { ok: true, projectSlug: "proj", items: items.slice(0, Number(args.limit) || 50) }; },
};
`;
  fs.writeFileSync(vaultPath, code, "utf8");
}
function setupRouterFixture() {
  const tmp = mkTmp("runelay-router-");
  const homeDir = path.join(tmp, "home");
  const hubDir = path.join(tmp, "hub");
  const projDir = path.join(tmp, "proj");
  const userDataDir = path.join(homeDir, ".t3", "userdata");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(hubDir, { recursive: true });
  fs.mkdirSync(path.join(projDir, ".git"), { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });
  const stateDbPath = path.join(userDataDir, "statev2.sqlite");
  const db = new DatabaseSync(stateDbPath);
  db.exec("CREATE TABLE projection_projects(project_id TEXT, workspace_root TEXT, deleted_at TEXT); CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT, project_id TEXT, payload_json TEXT, deleted_at TEXT)");
  db.prepare("INSERT INTO projection_projects VALUES(?,?,NULL)").run("project-default", fs.realpathSync(projDir));
  db.close();
  const updateStateDb = (sql, values) => {
    const stateDb = new DatabaseSync(stateDbPath);
    try { stateDb.prepare(sql).run(...values); } finally { stateDb.close(); }
  };
  const addProject = (id, root, deletedAt = null) => updateStateDb("INSERT INTO projection_projects VALUES(?,?,?)", [id, fs.realpathSync(root), deletedAt]);
  const addThread = (id, projectId, worktreePath = null, deletedAt = null) => updateStateDb("INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?,?)", [id, projectId, JSON.stringify({ worktreePath }), deletedAt]);
  fs.writeFileSync(path.join(hubDir, "state.json"), JSON.stringify({ mcpModes: { global: {}, projects: {} } }), "utf8");
  // demo skill under HOME/.agents/skills
  const skillDir = path.join(homeDir, ".agents", "skills", "demo-skill");
  fs.mkdirSync(path.join(skillDir, "references"), { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: demo-skill\ndescription: deploy embed tool for search\n---\n# Demo Skill\ndeploy embed tool body.\n", "utf8");
  fs.writeFileSync(path.join(skillDir, "references", "guide.md"), "# Guide\ndeploy guide content.\n", "utf8");
  const otherDir = path.join(homeDir, ".agents", "skills", "other-skill");
  fs.mkdirSync(otherDir, { recursive: true });
  fs.writeFileSync(path.join(otherDir, "SKILL.md"), "---\nname: other-skill\ndescription: unrelated cooking helper\n---\n# Other\ncooking.\n", "utf8");
  const vaultPath = path.join(tmp, "stub-vault.cjs");
  makeStubVault(vaultPath);
  const recordPath = path.join(tmp, "records.jsonl");
  fs.writeFileSync(recordPath, "", "utf8");
  return { tmp, homeDir, hubDir, projDir, userDataDir, stateDbPath, updateStateDb, addProject, addThread, skillDir, vaultPath, recordPath };
}

// ---------------------------------------------------------------------------
// embed-server.py five guards
// ---------------------------------------------------------------------------
describe("embed-server.py five dynamic-ceiling guards", () => {
  it("py_compiles cleanly", () => {
    const r = spawnSync("python3", ["-m", "py_compile", EMBED_SERVER], { encoding: "utf8", timeout: 30000 });
    assert.equal(r.status, 0, "py_compile failed: " + (r.stderr || r.stdout || ""));
  });
  it("contains all five guard contracts", () => {
    const py = fs.readFileSync(EMBED_SERVER, "utf8");
    assert.ok(py.includes("base_active_bytes") && py.includes("mx.get_active_memory()"), "base_active from measured weights");
    assert.ok(py.includes("ceiling_mb = round(max(base_active_mb * 1.28 + 180.0, base_active_mb + 220.0), 1)"), "ceiling formula exact");
    assert.ok(py.includes("maxMemoryMb") && py.includes("ceilingMb"), "config override keys");
    assert.ok(py.includes("cache_limit_bytes = min(256 * 1024 * 1024, max(48 * 1024 * 1024, int(base_active_bytes * 0.12)))"), "cache formula exact");
    assert.ok(py.includes("set_cache_limit"), "set_cache_limit");
    assert.ok(py.includes("set_memory_limit"), "set_memory_limit");
    assert.ok(py.includes("MemoryError"), "MemoryError fallback");
    assert.ok(py.includes("MAX_CHARS_PER_TEXT = 2048"), "MAX_CHARS_PER_TEXT");
    assert.ok(py.includes("MICRO_BATCH_SIZE = 8"), "MICRO_BATCH_SIZE");
    assert.ok(py.includes("def _enforce_memory_ceiling"), "_enforce_memory_ceiling");
    assert.ok(py.includes("auto_trimmed_count"), "auto_trimmed_count");
    assert.ok(py.includes("/trim"), "POST /trim");
    assert.ok(py.includes("rss_fuse_mb = round(max(ceiling_mb * 1.45, ceiling_mb + 512.0), 1)"), "fuse formula exact");
    assert.ok(py.includes("os._exit(0)"), "fuse self-restart");
    for (const f of ["baseActiveMb", "ceilingMb", "cacheLimitMb", "autoTrimmedCount"]) {
      assert.ok(py.includes(f), "health field " + f);
    }
    // legacy compat
    for (const f of ['"status"', '"model"', '"dim"', '"active_mb"', '"rss_mb"']) {
      assert.ok(py.includes(f), "legacy health " + f);
    }
  });
  it("matches install.sh heredoc template (synced, not drifted)", () => {
    const sh = fs.readFileSync(INSTALL_SH, "utf8");
    const delim = "T3_EMBED_SERVER_PY_EOF";
    const start = sh.indexOf("<<'" + delim + "'");
    assert.ok(start !== -1, "heredoc start found");
    const bodyStart = sh.indexOf("\n", start) + 1;
    const rest = sh.slice(bodyStart);
    const m = rest.match(new RegExp("^" + delim + "\\s*$", "m"));
    assert.ok(m, "heredoc end found");
    const templateBody = rest.slice(0, m.index);
    const srcBody = fs.readFileSync(EMBED_SERVER, "utf8");
    assert.equal(srcBody, templateBody, "src/embed-server.py must equal install.sh template body");
  });
});

// ---------------------------------------------------------------------------
// embed-manager ceiling + passthrough + rotation
// ---------------------------------------------------------------------------
describe("embed-manager ceilingMb + health passthrough + log rotation", () => {
  it("every PRESETS entry has ceilingMb matching round(max(est*1.28+180, est+220))", () => {
    delete require.cache[EMBED_MANAGER_PATH];
    const mod = require(EMBED_MANAGER_PATH);
    assert.ok(Array.isArray(mod.PRESETS) && mod.PRESETS.length >= 10, "presets present");
    for (const p of mod.PRESETS) {
      assert.ok(Number.isFinite(p.ceilingMb), p.id + " ceilingMb finite");
      assert.equal(p.ceilingMb, expectedCeiling(p.estRamMb), p.id + " ceilingMb formula");
    }
    assert.equal(mod.LOG_ROTATION_MAX_BYTES, 20 * 1024 * 1024, "rotation threshold 20MB");
  });
  it("getStatus passes through health baseActiveMb/ceilingMb/cacheMb/cacheLimitMb/autoTrimmedCount", () => {
    // PATH curl shim (healthSync uses spawnSync curl which blocks loop)
    const tmp = mkTmp("emb-passthrough-");
    const hubDir = path.join(tmp, "hub");
    const binDir = path.join(tmp, "bin");
    fs.mkdirSync(hubDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(hubDir, "embed-config.json"), JSON.stringify({ mode: "mlx", modelId: "mlx-community/Qwen3-Embedding-0.6B-8bit" }), "utf8");
    const healthPayload = {
      ok: true,
      modelId: "mlx-community/Qwen3-Embedding-0.6B-8bit",
      model_id: "mlx-community/Qwen3-Embedding-0.6B-8bit",
      activeMb: 680,
      rssMb: 900,
      baseActiveMb: 680.5,
      base_active_mb: 680.5,
      ceilingMb: 1050.2,
      ceiling_mb: 1050.2,
      cacheMb: 12.3,
      cache_mb: 12.3,
      cacheLimitMb: 82,
      cache_limit_mb: 82,
      autoTrimmedCount: 7,
      auto_trimmed_count: 7,
    };
    const healthFile = path.join(tmp, "health.json");
    fs.writeFileSync(healthFile, JSON.stringify(healthPayload), "utf8");
    const script = path.join(binDir, "curl");
    fs.writeFileSync(script, "#!/bin/sh\nexec cat \"" + healthFile + "\"\n", { mode: 0o755 });
    const origPath = process.env.PATH;
    process.env.PATH = binDir + path.delimiter + (origPath || "");
    try {
      delete require.cache[EMBED_MANAGER_PATH];
      const mod = require(EMBED_MANAGER_PATH);
      const mgr = mod.createEmbedManager({ homeDir: tmp, hubDir, cacheDir: path.join(tmp, "cache"), port: 18221, launchAgentPlistPath: null });
      const st = mgr.getStatus();
      assert.equal(st.baseActiveMb, 680.5, JSON.stringify(st));
      assert.equal(st.ceilingMb, 1050.2);
      assert.equal(st.cacheMb, 12.3);
      assert.equal(st.cacheLimitMb, 82);
      assert.equal(st.autoTrimmedCount, 7);
      // presets also carry ceilingMb
      for (const p of st.presets) assert.ok(Number.isFinite(p.ceilingMb), "preset ceiling in status");
    } finally {
      process.env.PATH = origPath;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  it("rotateLogIfNeeded rotates >20MB to .1 and overwrites old .1", () => {
    delete require.cache[EMBED_MANAGER_PATH];
    const mod = require(EMBED_MANAGER_PATH);
    const tmp = mkTmp("emb-rotate-");
    try {
      const log = path.join(tmp, "embed-server.log");
      const bak = log + ".1";
      // sparse 20MB+1 file (fast)
      const fd = fs.openSync(log, "w");
      fs.ftruncateSync(fd, 20 * 1024 * 1024 + 1);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fs.writeFileSync(bak, "old-backup", "utf8");
      mod.rotateLogIfNeeded(log);
      assert.ok(fs.existsSync(bak), ".1 exists after rotation");
      assert.equal(fs.statSync(bak).size, 20 * 1024 * 1024 + 1, ".1 overwritten with rotated size");
      assert.ok(!fs.existsSync(log), "original moved (new log will be created by startServer)");
      // small log must NOT rotate
      fs.writeFileSync(log, "small", "utf8");
      fs.writeFileSync(bak, "marker", "utf8");
      mod.rotateLogIfNeeded(log);
      assert.equal(fs.readFileSync(bak, "utf8"), "marker", "small log keeps .1 untouched");
      assert.equal(fs.readFileSync(log, "utf8"), "small", "small log untouched");
      // startServer wiring: source must call rotation before opening log
      const src = fs.readFileSync(EMBED_MANAGER_PATH, "utf8");
      assert.ok(src.includes("rotateLogIfNeeded(logPath)"), "startServer rotates before open");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// pinned shield + runelay meta tools (subprocess router)
// ---------------------------------------------------------------------------
describe("t3-mcp-router pinned shield + context/skill meta tools", () => {
  it("exposes context_search/skill_read/skill_read_file and memory_write pinned field", async () => {
    const fx = setupRouterFixture();
    const r = startRouter({ homeDir: fx.homeDir, hubDir: fx.hubDir, vaultPath: fx.vaultPath, recordPath: fx.recordPath, cwd: fx.projDir });
    try {
      const list = await r.listTools(8000);
      assert.ok(list.result && Array.isArray(list.result.tools), "tools/list result");
      const names = list.result.tools.map((t) => t.name);
      for (const n of ["context_search", "skill_read", "skill_read_file", "memory_write"]) {
        assert.ok(names.includes(n), "missing tool " + n + " got " + names.join(","));
      }
      const mw = list.result.tools.find((t) => t.name === "memory_write");
      assert.ok(mw.inputSchema && mw.inputSchema.properties && mw.inputSchema.properties.pinned, "memory_write schema has pinned");
      // schemas stay tiny (runelay token budget): each new tool < 6 props
      for (const n of ["context_search", "skill_read", "skill_read_file"]) {
        const t = list.result.tools.find((x) => x.name === n);
        const props = Object.keys(t.inputSchema.properties || {});
        assert.ok(props.length <= 5, n + " schema props " + props.length + " must stay minimal");
      }
    } finally {
      r.kill();
      setTimeout(() => { try { fs.rmSync(fx.tmp, { recursive: true, force: true }); } catch {} }, 300);
    }
  });
  it("keeps search results compact while memory_read retains full revision history", async () => {
    const fx = setupRouterFixture();
    const r = startRouter({ homeDir: fx.homeDir, hubDir: fx.hubDir, vaultPath: fx.vaultPath, recordPath: fx.recordPath, cwd: fx.projDir });
    try {
      const searched = await r.callTool("memory_search", { query: "deploy", projectRoot: fx.projDir });
      const searchPayload = JSON.parse(searched.result.content[0].text);
      const item = searchPayload.items[0];
      assert.ok(item.id && item.title && item.content && item.module && item.scope && item.updatedAt && item.version);
      assert.equal(Object.hasOwn(item, "history"), false, "search omits old revisions from prompt context");
      assert.equal(item.memory_scope, "shared", "legacy scope aliases remain compatible");

      const read = await r.callTool("memory_read", { id: "mem-1", projectRoot: fx.projDir });
      const readPayload = JSON.parse(read.result.content[0].text);
      assert.equal(readPayload.item.history[0].version, 2, "full history remains available on explicit read");
    } finally {
      r.kill();
      setTimeout(() => { try { fs.rmSync(fx.tmp, { recursive: true, force: true }); } catch {} }, 300);
    }
  });
  it("falls back to scoped legacy listing when an adapter ignores the id filter", async () => {
    const fx = setupRouterFixture();
    makeLegacyReadStubVault(fx.vaultPath);
    const r = startRouter({ homeDir: fx.homeDir, hubDir: fx.hubDir, vaultPath: fx.vaultPath, recordPath: fx.recordPath, cwd: fx.projDir });
    try {
      const response = await r.callTool("memory_read", { id: "legacy-id", projectRoot: fx.projDir }, 8000);
      const result = JSON.parse(response.result.content[0].text);
      assert.equal(result.ok, true);
      assert.equal(result.item.id, "legacy-id");
      assert.equal(result.item.history[0].content, "older revision");
      const calls = fs.readFileSync(fx.recordPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      assert.equal(calls.length, 2, "one exact-ID probe followed by the bounded compatibility lookup");
      assert.equal(calls[0].id, "legacy-id");
      assert.equal(calls[0].limit, 1);
      assert.equal(calls[1].id, undefined, "legacy fallback omits the unsupported filter");
      assert.equal(calls[1].limit, 200);
      assert.equal(calls[1].projectRoot, fs.realpathSync(fx.projDir), "fallback keeps the selected project scope");
      assert.equal(calls[1].includeGlobal, false, "legacy ID fallback never includes global memory");
    } finally {
      r.kill();
      setTimeout(() => { try { fs.rmSync(fx.tmp, { recursive: true, force: true }); } catch {} }, 300);
    }
  });
  it("memory_read rejects missing or invalid IDs before any vault or legacy list call", async () => {
    const fx = setupRouterFixture();
    makeLegacyReadStubVault(fx.vaultPath);
    const r = startRouter({ homeDir: fx.homeDir, hubDir: fx.hubDir, vaultPath: fx.vaultPath, recordPath: fx.recordPath, cwd: fx.projDir });
    try {
      for (const id of [undefined, null, "", "  ", 0, {}]) {
        const invalid = await r.callTool("memory_read", { id, projectRoot: fx.projDir }, 8000);
        assert.ok(invalid.error, `memory_read rejects invalid ID ${JSON.stringify(id)}`);
        assert.match(invalid.error.message, /memory id required/);
      }
      assert.equal(fs.readFileSync(fx.recordPath, "utf8"), "", "invalid IDs never invoke the 200-item legacy list fallback");
    } finally {
      r.kill();
      setTimeout(() => { try { fs.rmSync(fx.tmp, { recursive: true, force: true }); } catch {} }, 300);
    }
  });
  it("memory_write strips agent pinned:true to pinned:false", async () => {
    const fx = setupRouterFixture();
    const r = startRouter({ homeDir: fx.homeDir, hubDir: fx.hubDir, vaultPath: fx.vaultPath, recordPath: fx.recordPath, cwd: fx.projDir });
    try {
      const res = await r.callTool("memory_write", { module: "constraints", title: "t", content: "c", pinned: true, projectRoot: fx.projDir }, 8000);
      assert.ok(res.result, "result present " + JSON.stringify(res).slice(0, 400));
      const records = fs.readFileSync(fx.recordPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const w = records.find((x) => x.kind === "write");
      assert.ok(w, "stub write recorded");
      assert.equal(w.obj.pinned, false, "pinned must be forced false, got " + JSON.stringify(w.obj));
      assert.equal(w.obj.tags, undefined);
      const core = await r.callTool("memory_write", { module: "constraints", title: "agent core", content: "do not promote", tags: ["  CoRe  "], projectRoot: fx.projDir }, 8000);
      const corePayload = JSON.parse(core.result.content[0].text);
      assert.equal(corePayload.ok, false);
      assert.match(corePayload.error, /human-only/);
      await r.callTool("memory_consolidate", { projectRoot: fx.projDir }, 8000);
      await r.callTool("memory_rollback", { id: "mem-1", projectRoot: fx.projDir }, 8000);
      const after = fs.readFileSync(fx.recordPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      assert.equal(after.filter((x) => x.kind === "write").length, 1, "reserved core tag is refused before vault write");
      assert.equal(after.find((x) => x.kind === "consolidate").obj.excludeProtected, true);
      assert.equal(after.find((x) => x.kind === "rollback").obj.rejectProtectedRollback, true);
    } finally {
      r.kill();
      setTimeout(() => { try { fs.rmSync(fx.tmp, { recursive: true, force: true }); } catch {} }, 300);
    }
  });
  it("context_search merges memory + skills in one call", async () => {
    const fx = setupRouterFixture();
    const r = startRouter({ homeDir: fx.homeDir, hubDir: fx.hubDir, vaultPath: fx.vaultPath, recordPath: fx.recordPath, cwd: fx.projDir });
    try {
      const res = await r.callTool("context_search", { query: "deploy", projectRoot: fx.projDir, limit: 5 }, 8000);
      assert.ok(res.result, JSON.stringify(res).slice(0, 500));
      const text = res.result.content && res.result.content[0] && res.result.content[0].text;
      assert.ok(typeof text === "string", "content text");
      const payload = JSON.parse(text);
      assert.ok(Array.isArray(payload.memories), "memories array");
      assert.ok(Array.isArray(payload.skills), "skills array");
      assert.ok(payload.memories.length >= 1, "stub memory returned: " + text.slice(0, 400));
      assert.equal(payload.memories[0].title, "deploy pitfall embed collision");
      assert.ok(payload.skills.some((s) => s.slug === "demo-skill"), "demo-skill matched: " + text.slice(0, 600));
      assert.ok(!payload.skills.some((s) => s.slug === "other-skill"), "unrelated skill filtered");
    } finally {
      r.kill();
      setTimeout(() => { try { fs.rmSync(fx.tmp, { recursive: true, force: true }); } catch {} }, 300);
    }
  });
  it("skill_read returns SKILL.md on demand", async () => {
    const fx = setupRouterFixture();
    const r = startRouter({ homeDir: fx.homeDir, hubDir: fx.hubDir, vaultPath: fx.vaultPath, recordPath: fx.recordPath, cwd: fx.projDir });
    try {
      const res = await r.callTool("skill_read", { slug: "demo-skill", projectRoot: fx.projDir }, 8000);
      assert.ok(res.result, JSON.stringify(res).slice(0, 400));
      const payload = JSON.parse(res.result.content[0].text);
      assert.equal(payload.slug, "demo-skill");
      assert.ok(payload.content.includes("deploy embed tool body"), "SKILL.md body: " + payload.content.slice(0, 300));
    } finally {
      r.kill();
      setTimeout(() => { try { fs.rmSync(fx.tmp, { recursive: true, force: true }); } catch {} }, 300);
    }
  });
  it("skill_read_file reads reference doc inside skill dir", async () => {
    const fx = setupRouterFixture();
    const r = startRouter({ homeDir: fx.homeDir, hubDir: fx.hubDir, vaultPath: fx.vaultPath, recordPath: fx.recordPath, cwd: fx.projDir });
    try {
      const res = await r.callTool("skill_read_file", { slug: "demo-skill", relativePath: "references/guide.md", projectRoot: fx.projDir }, 8000);
      assert.ok(res.result, JSON.stringify(res).slice(0, 400));
      const payload = JSON.parse(res.result.content[0].text);
      assert.ok(payload.content.includes("deploy guide content"), "guide: " + payload.content.slice(0, 200));
    } finally {
      r.kill();
      setTimeout(() => { try { fs.rmSync(fx.tmp, { recursive: true, force: true }); } catch {} }, 300);
    }
  });
  it("skill_read_file blocks ../ path traversal", async () => {
    const fx = setupRouterFixture();
    const r = startRouter({ homeDir: fx.homeDir, hubDir: fx.hubDir, vaultPath: fx.vaultPath, recordPath: fx.recordPath, cwd: fx.projDir });
    try {
      for (const evil of ["../SKILL.md", "../../etc/passwd", "references/../../secret.txt", "/etc/passwd"]) {
        const res = await r.callTool("skill_read_file", { slug: "demo-skill", relativePath: evil, projectRoot: fx.projDir }, 8000);
        assert.ok(res.error, "traversal must error for " + evil + " got " + JSON.stringify(res).slice(0, 400));
        assert.ok(/traversal|invalid|relative/i.test(res.error.message || ""), "traversal message for " + evil + ": " + (res.error.message || ""));
      }
      // invalid slug with slash also blocked
      const bad = await r.callTool("skill_read", { slug: "../secret", projectRoot: fx.projDir }, 8000);
      assert.ok(bad.error, "invalid slug must error");
    } finally {
      r.kill();
      setTimeout(() => { try { fs.rmSync(fx.tmp, { recursive: true, force: true }); } catch {} }, 300);
    }
  });
});

// ---------------------------------------------------------------------------
// leak guards: waiters, buffers, kill
// ---------------------------------------------------------------------------
describe("leak guards: waiters timeout + buffers + kill escalation", () => {
  it("withTimeout deletes waiter from entry.waiters on timeout", async () => {
    delete require.cache[ROUTER_PATH];
    const mod = require(ROUTER_PATH);
    const entry = { waiters: new Map(), nextId: (() => { let i = 100; return () => i++; })() };
    const p = new Promise(() => {});
    p._waiterId = 999;
    p._waiterEntry = entry;
    entry.waiters.set(999, { resolve: () => {}, reject: () => {} });
    assert.equal(entry.waiters.size, 1);
    await assert.rejects(() => mod.withTimeout(p, 50, "test"), /timeout: test/);
    assert.equal(entry.waiters.size, 0, "waiter cleaned after timeout");
    assert.ok(!entry.waiters.has(999));
    // source must contain cleanup inside timeout path
    const src = fs.readFileSync(ROUTER_PATH, "utf8");
    assert.ok(src.includes("waiters.delete"), "source waiters.delete present");
  });
  it("router caps stdout/HTTP/stdin buffers at 2MB", () => {
    const src = fs.readFileSync(ROUTER_PATH, "utf8");
    assert.ok(src.includes("MAX_BUFFER_BYTES = 2 * 1024 * 1024") || src.includes("2 * 1024 * 1024"), "2MB constant");
    assert.ok(src.includes("upstream output exceeds 2MB limit"), "stdout cap message");
    assert.ok(src.includes("HTTP response exceeds 2MB limit"), "HTTP cap message");
    assert.ok(src.includes("inBuffer") && src.includes("MAX_BUFFER_BYTES"), "stdin cap wired");
  });
  it("router survives oversized stdin without wedging", async () => {
    const fx = setupRouterFixture();
    const r = startRouter({ homeDir: fx.homeDir, hubDir: fx.hubDir, vaultPath: fx.vaultPath, recordPath: fx.recordPath, cwd: fx.projDir });
    try {
      // 2.5MB without newline is one oversized line: router must drop it, not OOM/wedge.
      // Terminate the garbage line with a newline so the next valid request is a fresh line.
      const big = "x".repeat(Math.floor(2.5 * 1024 * 1024));
      r.proc.stdin.write(big + "\n");
      await new Promise((res) => setTimeout(res, 300));
      const list = await r.listTools(8000);
      assert.ok(list.result && Array.isArray(list.result.tools), "router still answers after oversized stdin");
    } finally {
      r.kill();
      setTimeout(() => { try { fs.rmSync(fx.tmp, { recursive: true, force: true }); } catch {} }, 300);
    }
  });
  it("killPoolEntry escalates SIGTERM -> SIGKILL after 100ms", async () => {
    delete require.cache[ROUTER_PATH];
    const mod = require(ROUTER_PATH);
    const src = fs.readFileSync(ROUTER_PATH, "utf8");
    assert.ok(src.includes("SIGTERM"), "SIGTERM present");
    assert.ok(src.includes("SIGKILL"), "SIGKILL present");
    // functional: stubborn child ignoring SIGTERM must still die
    const def = { name: "stubborn", command: process.execPath, args: ["-e", "process.on('SIGTERM',()=>{}); setTimeout(()=>{},15000);"] };
    const entry = mod.spawnStdioUpstream(def);
    assert.ok(entry && entry.proc, "spawned");
    const exited = new Promise((resolve) => { entry.proc.on("exit", (code, sig) => resolve({ code, sig })); });
    mod.killPoolEntry(entry.key);
    assert.ok(!mod.stdioPool.has(entry.key), "removed from pool immediately");
    const result = await Promise.race([exited, new Promise((res) => setTimeout(() => res(null), 800))]);
    assert.ok(result !== null, "stubborn child must exit via SIGKILL, no zombie");
  });
  it("hub-hooks caps builtin stdin at 1MB", () => {
    const src = fs.readFileSync(HOOKS_PATH, "utf8");
    assert.ok(src.includes("HOOK_STDIN_MAX_BYTES") || (src.includes("1 * 1024 * 1024") && src.includes("stdinOverflow")), "1MB hooks guard present");
  });
});

// ---------------------------------------------------------------------------
// stop-nudge 7d + task-plans GC
// ---------------------------------------------------------------------------
describe("stop-nudge 7-day + task-plans 30-day/200 GC", () => {
  it("stop-hook deletes stale stop-nudge files >7 days, keeps fresh", async () => {
    const tmp = mkTmp("stopnudge-");
    const hubDir = path.join(tmp, "hub");
    const runDir = path.join(hubDir, "run");
    fs.mkdirSync(runDir, { recursive: true });
    const stale = path.join(runDir, "stop-nudge-old.json");
    const fresh = path.join(runDir, "stop-nudge-fresh.json");
    const unrelated = path.join(runDir, "other.json");
    fs.writeFileSync(stale, JSON.stringify({ time: 1 }), "utf8");
    fs.writeFileSync(fresh, JSON.stringify({ time: Date.now() }), "utf8");
    fs.writeFileSync(unrelated, "{}", "utf8");
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const veryOld = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    fs.utimesSync(stale, old, old);
    fs.utimesSync(unrelated, veryOld, veryOld);
    try {
      const code = await new Promise((resolve, reject) => {
        const proc = spawn(process.execPath, [STOP_HOOK], {
          env: { ...process.env, HOME: tmp, T3_HUB_DIR: hubDir },
          stdio: ["pipe", "pipe", "pipe"],
          cwd: tmp,
        });
        const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} reject(new Error("stop-hook timeout")); }, 8000);
        proc.on("exit", (c) => { clearTimeout(timer); resolve(c); });
        proc.on("error", (e) => { clearTimeout(timer); reject(e); });
        proc.stdin.write(JSON.stringify({ cwd: tmp, stop_hook_active: true }) + "\n");
        proc.stdin.end();
      });
      assert.equal(code, 0, "hook exit 0");
      assert.ok(!fs.existsSync(stale), "stale >7d deleted");
      assert.ok(fs.existsSync(fresh), "fresh kept");
      assert.ok(fs.existsSync(unrelated), "non stop-nudge kept even if old");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  it("task-plans 30-day stale GC + 200 cap via gcTaskPlans and via updatePlan/list", () => {
    delete require.cache[TASK_BOARD_PATH];
    const mod = require(TASK_BOARD_PATH);
    const tmp = mkTmp("taskgc-");
    const plansDir = path.join(tmp, "plans");
    fs.mkdirSync(plansDir, { recursive: true });
    // stale completed plan >30d
    const stale = path.join(plansDir, "p-old.json");
    fs.writeFileSync(stale, JSON.stringify({ threadId: "t-old", projectRoot: "/p", steps: [{ id: "s1", text: "done", status: "completed" }], updatedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString() }), "utf8");
    const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    fs.utimesSync(stale, oldDate, oldDate);
    // fresh plan
    const fresh = path.join(plansDir, "p-fresh.json");
    fs.writeFileSync(fresh, JSON.stringify({ threadId: "t-fresh", projectRoot: "/p", steps: [{ id: "s1", text: "wip", status: "in_progress" }], updatedAt: new Date().toISOString() }), "utf8");
    const r1 = mod.gcTaskPlans(plansDir);
    assert.ok(r1.deleted >= 1, "stale deleted counted");
    assert.ok(!fs.existsSync(stale), "stale gone");
    assert.ok(fs.existsSync(fresh), "fresh kept");
    // 200 cap: create 205 fresh files, gc keeps newest 200
    for (let i = 0; i < 205; i++) {
      const f = path.join(plansDir, "cap-" + String(i).padStart(3, "0") + ".json");
      fs.writeFileSync(f, JSON.stringify({ threadId: "t" + i, projectRoot: "/p", steps: [{ id: "s", text: "x", status: "pending" }], updatedAt: new Date().toISOString() }), "utf8");
      const t = new Date(Date.now() - (205 - i) * 1000);
      fs.utimesSync(f, t, t);
    }
    // total now 1 fresh + 205 = 206 -> gc trims to 200
    mod.gcTaskPlans(plansDir);
    const remaining = fs.readdirSync(plansDir).filter((x) => x.endsWith(".json"));
    assert.ok(remaining.length <= 200, "capped at 200, got " + remaining.length);
    // updatePlan path also triggers GC (stale re-created then update)
    const stale2 = path.join(plansDir, "p-old2.json");
    fs.writeFileSync(stale2, JSON.stringify({ threadId: "t-old2", projectRoot: "/p", steps: [{ id: "s1", text: "done", status: "completed" }], updatedAt: oldDate.toISOString() }), "utf8");
    fs.utimesSync(stale2, oldDate, oldDate);
    const board = mod.createTaskBoard({ homeDir: tmp, t3DbPath: path.join(tmp, "missing.sqlite"), hubPlansDir: plansDir, agyBrainDirs: [] });
    board.updatePlan({ threadId: "t-new", projectRoot: "/p", steps: [{ id: "s1", text: "new", status: "pending" }] });
    assert.ok(!fs.existsSync(stale2), "updatePlan GC removed stale");
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe("project-only Agent memory", () => {
  it("removes global scopes from schemas and forces scoped, bounded searches", async () => {
    const fx = setupRouterFixture();
    const r = startRouter({ homeDir: fx.homeDir, hubDir: fx.hubDir, vaultPath: fx.vaultPath, recordPath: fx.recordPath, cwd: fx.projDir });
    try {
      const listed = await r.listTools();
      const tools = listed.result.tools;
      const search = tools.find((tool) => tool.name === "memory_search");
      const read = tools.find((tool) => tool.name === "memory_read");
      const write = tools.find((tool) => tool.name === "memory_write");
      assert.match(tools.find((tool) => tool.name === "memory_status").description, /projectBound.*projectRoot/s);
      for (const name of ["memory_search", "memory_read", "memory_write", "memory_consolidate", "memory_rollback", "context_search"]) {
        assert.match(tools.find((tool) => tool.name === name).description, /memory_status first.*exact path automatically/i, `${name} guides the Agent to read the bound path`);
      }
      assert.equal(search.inputSchema.properties.includeGlobal, undefined);
      assert.deepEqual(search.inputSchema.properties.scope.enum, ["shared", "worktree"]);
      assert.deepEqual(search.inputSchema.properties.scopeFilter.enum, ["auto", "shared", "worktree", "all"]);
      assert.ok(read.inputSchema.properties.scopeFilter, "ID reads can use the originating search scope");
      assert.deepEqual(write.inputSchema.properties.scope.enum, ["shared", "worktree"]);
      for (const name of ["memory_search", "memory_read", "memory_write", "memory_consolidate", "memory_rollback", "context_search"]) {
        assert.ok(tools.find((tool) => tool.name === name).inputSchema.required.includes("projectRoot"), `${name} requires projectRoot`);
      }
      const missingRoot = await r.callTool("memory_search", { query: "deploy" });
      assert.ok(missingRoot.error, "even a bound process requires projectRoot per call");

      const res = await r.callTool("memory_search", { query: "deploy", projectRoot: fx.projDir, includeGlobal: true, limit: 50, scopeFilter: "all" });
      assert.ok(res.result, JSON.stringify(res));
      let calls = fs.readFileSync(fx.recordPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
      assert.equal(calls[0].kind, "search");
      assert.equal(calls[0].obj.projectRoot, fs.realpathSync(fx.projDir));
      assert.equal(calls[0].obj.includeGlobal, false, "legacy includeGlobal:true is ignored");
      assert.equal(calls[0].obj.limit, 20, "search caps at twenty");
      assert.equal(calls[0].obj.scopeFilter, "all", "all remains within the selected project");

      const defaultSearch = await r.callTool("memory_search", { query: "deploy", projectRoot: fx.projDir });
      assert.ok(defaultSearch.result, JSON.stringify(defaultSearch));
      calls = fs.readFileSync(fx.recordPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
      assert.equal(calls[1].obj.limit, 6, "Agent search defaults to six memories");

      const longSearch = await r.callTool("memory_search", { query: "long-memory", projectRoot: fx.projDir });
      const longPayload = JSON.parse(longSearch.result.content[0].text);
      assert.equal(longPayload.items[0].id, "mem-1", "truncated results keep their ID");
      assert.equal(longPayload.items[0].content.length, 1000);
      assert.equal(longPayload.items[0].contentTruncated, true);
      assert.equal(Object.hasOwn(longPayload.items[0], "history"), false);

      const ctx = await r.callTool("context_search", { query: "deploy", projectRoot: fx.projDir, limit: 50 });
      assert.ok(ctx.result, JSON.stringify(ctx));
      calls = fs.readFileSync(fx.recordPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
      const contextCall = calls.filter((call) => call.kind === "search" && call.obj.query === "deploy" && call.obj.limit === 20).at(-1);
      assert.equal(contextCall.obj.includeGlobal, false);
      assert.equal(contextCall.obj.limit, 20);
      const compactContext = await r.callTool("context_search", { query: "long-memory", projectRoot: fx.projDir });
      const compactContextPayload = JSON.parse(compactContext.result.content[0].text);
      assert.equal(compactContextPayload.memories[0].id, "mem-1");
      assert.equal(compactContextPayload.memories[0].snippet.length, 240);
      assert.equal(compactContextPayload.memories[0].snippetTruncated, true);

      await r.callTool("memory_read", { id: "mem-1", projectRoot: fx.projDir, scopeFilter: "all" });
      calls = fs.readFileSync(fx.recordPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
      const readCall = calls.at(-1);
      assert.equal(readCall.kind, "read");
      assert.equal(readCall.obj.projectRoot, fs.realpathSync(fx.projDir));
      assert.equal(readCall.obj.includeGlobal, false);
      assert.equal(readCall.obj.scopeFilter, "all");

      const status = await r.callTool("memory_status", {});
      const statusPayload = JSON.parse(status.result.content[0].text);
      assert.equal(statusPayload.projectBound, true);
      assert.equal(statusPayload.projectRoot, fs.realpathSync(fx.projDir));
    } finally {
      r.kill();
      setTimeout(() => { try { fs.rmSync(fx.tmp, { recursive: true, force: true }); } catch {} }, 300);
    }
  });

  it("rejects global and mismatched project scopes before vault calls", async () => {
    const fx = setupRouterFixture();
    const projectB = path.join(fx.projDir, "service-b");
    fs.mkdirSync(projectB, { recursive: true });
    fs.writeFileSync(path.join(projectB, "package.json"), "{}\n");
    const unrelatedRepo = path.join(fx.tmp, "unrelated-project");
    fs.mkdirSync(path.join(unrelatedRepo, ".git"), { recursive: true });
    const r = startRouter({ homeDir: fx.homeDir, hubDir: fx.hubDir, vaultPath: fx.vaultPath, recordPath: fx.recordPath, cwd: fx.projDir });
    try {
      for (const args of [
        { query: "x", projectRoot: fx.projDir, scope: "global" },
        { query: "x", projectRoot: fx.projDir, scopeFilter: "global" },
        { query: "x", projectRoot: projectB },
        { query: "x", projectRoot: unrelatedRepo },
      ]) {
        const response = await r.callTool("memory_search", args);
        assert.ok(response.error, "invalid project scope rejected: " + JSON.stringify(args));
      }
      for (const [name, args] of [
        ["memory_consolidate", { projectRoot: fx.projDir, projectSlug: "_global" }],
        ["memory_rollback", { id: "mem-1", projectRoot: fx.projDir, projectSlug: "_global" }],
      ]) {
        const response = await r.callTool(name, args);
        assert.ok(response.error, name + " rejects global project slug");
      }
      assert.equal(fs.readFileSync(fx.recordPath, "utf8").trim(), "", "rejected calls never reach the vault");
    } finally {
      r.kill();
      setTimeout(() => { try { fs.rmSync(fx.tmp, { recursive: true, force: true }); } catch {} }, 300);
    }
  });

  it("binds a linked-worktree T3 project and rejects ambiguous or mismatched roots", async () => {
    const fx = setupRouterFixture();
    const repo = path.join(fx.tmp, "git-repo");
    const linkedRoot = path.join(fx.tmp, "linked-worktree");
    fs.mkdirSync(path.join(repo, "service-a"), { recursive: true });
    fs.mkdirSync(path.join(repo, "service-b"), { recursive: true });
    fs.writeFileSync(path.join(repo, "service-a", "tracked.txt"), "a\n");
    fs.writeFileSync(path.join(repo, "service-b", "tracked.txt"), "b\n");
    const git = (...args) => {
      const result = spawnSync("git", args, { encoding: "utf8", timeout: 15000, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
      assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
    };
    git("-C", repo, "init", "-b", "main");
    git("-C", repo, "add", ".");
    git("-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture");
    git("-C", repo, "worktree", "add", "-b", "linked", linkedRoot);
    const projectA = path.join(repo, "service-a"), projectB = path.join(repo, "service-b");
    const linkedProjectA = path.join(linkedRoot, "service-a"), linkedProjectB = path.join(linkedRoot, "service-b");
    fx.addProject("service-a", projectA);
    fx.addProject("service-b", projectB);
    fx.addThread("thread-a", "service-a", linkedRoot);
    fx.addThread("thread-b", "service-b", linkedRoot);
    const r = startRouter({ homeDir: fx.homeDir, hubDir: fx.hubDir, vaultPath: fx.vaultPath, recordPath: fx.recordPath, cwd: linkedRoot, threadId: "thread-a" });
    try {
      const status = await r.callTool("memory_status", {});
      const binding = JSON.parse(status.result.content[0].text);
      assert.equal(binding.projectBound, true);
      assert.equal(binding.projectRoot, fs.realpathSync(linkedProjectA));
      assert.equal(binding.projectBindingSource, "t3-thread");
      const allowed = await r.callTool("memory_search", { query: "deploy", projectRoot: linkedProjectA });
      assert.ok(allowed.result, JSON.stringify(allowed));
      const call = JSON.parse(fs.readFileSync(fx.recordPath, "utf8").trim());
      assert.equal(call.obj.projectRoot, fs.realpathSync(linkedProjectA));
      const wrongSubproject = await r.callTool("memory_search", { query: "deploy", projectRoot: linkedProjectB });
      assert.ok(wrongSubproject.error, "same Git repository but a different T3 project subdirectory is rejected");
      const wrongWorktreeAlias = await r.callTool("memory_search", { query: "deploy", projectRoot: projectA });
      assert.ok(wrongWorktreeAlias.error, "explicit projectRoot must exactly match the current worktree binding");
      const ambiguousWorktreeRoot = startRouter({ homeDir: fx.homeDir, hubDir: fx.hubDir, vaultPath: fx.vaultPath, recordPath: path.join(fx.tmp, "linked-records.jsonl"), cwd: linkedRoot });
      try {
        const ambiguousStatus = await ambiguousWorktreeRoot.callTool("memory_status", {});
        const payload = JSON.parse(ambiguousStatus.result.content[0].text);
        assert.equal(payload.projectBound, false, "worktree root mapping to two project subdirectories is ambiguous");
        assert.equal(payload.projectBindingReason, "ambiguous");
        const response = await ambiguousWorktreeRoot.callTool("memory_search", { query: "deploy", projectRoot: linkedProjectA });
        assert.ok(response.error, "a caller root cannot resolve an ambiguous worktree context");
      } finally { ambiguousWorktreeRoot.kill(); }
    } finally {
      r.kill();
      setTimeout(() => { try { fs.rmSync(fx.tmp, { recursive: true, force: true }); } catch {} }, 300);
    }
  });

  it("fails closed when host cwd is home, including an explicit projectRoot", async () => {
    const fx = setupRouterFixture();
    const r = startRouter({ homeDir: fx.homeDir, hubDir: fx.hubDir, vaultPath: fx.vaultPath, recordPath: fx.recordPath, cwd: fx.homeDir });
    try {
      const implicit = await r.callTool("memory_search", { query: "deploy" });
      assert.ok(implicit.error, "home is not a project context");
      const explicit = await r.callTool("memory_search", { query: "deploy", projectRoot: fx.projDir });
      assert.ok(explicit.error, "caller-supplied projectRoot cannot bootstrap an unknown MCP context");
      const status = await r.callTool("memory_status", {});
      const statusPayload = JSON.parse(status.result.content[0].text);
      assert.equal(statusPayload.projectBound, false);
      assert.equal(statusPayload.projectRoot, null);
      assert.equal(statusPayload.projectBindingReason, "invalid_context");
      assert.equal(fs.readFileSync(fx.recordPath, "utf8").trim(), "", "unbound calls never reach the vault");
    } finally {
      r.kill();
      setTimeout(() => { try { fs.rmSync(fx.tmp, { recursive: true, force: true }); } catch {} }, 300);
    }
  });

  it("allows a real Documents project beneath HOME without treating HOME itself as the project", async () => {
    const fx = setupRouterFixture();
    const project = path.join(fx.homeDir, "Documents", "project");
    fs.mkdirSync(project, { recursive: true });
    fx.addProject("documents-project", project);
    const r = startRouter({ homeDir: fx.homeDir, hubDir: fx.hubDir, vaultPath: fx.vaultPath, recordPath: fx.recordPath, cwd: project });
    try {
      const response = await r.callTool("memory_search", { query: "deploy", projectRoot: project });
      assert.ok(response.result, JSON.stringify(response));
      const call = JSON.parse(fs.readFileSync(fx.recordPath, "utf8").trim());
      assert.equal(call.obj.projectRoot, fs.realpathSync(project));
    } finally {
      r.kill();
      setTimeout(() => { try { fs.rmSync(fx.tmp, { recursive: true, force: true }); } catch {} }, 300);
    }
  });

  it("resolves a non-Git T3 workspace from the read-only project projection", async () => {
    const fx = setupRouterFixture();
    const project = path.join(fx.tmp, "registered-without-git");
    fs.mkdirSync(project, { recursive: true });
    fx.addProject("non-git-project", project);
    fx.addThread("non-git-thread", "non-git-project");
    const r = startRouter({ homeDir: fx.homeDir, hubDir: fx.hubDir, vaultPath: fx.vaultPath, recordPath: fx.recordPath, cwd: project, threadId: "non-git-thread" });
    try {
      const status = await r.callTool("memory_status", {});
      const binding = JSON.parse(status.result.content[0].text);
      assert.equal(binding.projectBound, true);
      assert.equal(binding.projectRoot, fs.realpathSync(project));
      assert.equal(binding.projectBindingSource, "t3-thread");
      const response = await r.callTool("memory_search", { query: "deploy", projectRoot: project });
      assert.ok(response.result, JSON.stringify(response));
      const call = JSON.parse(fs.readFileSync(fx.recordPath, "utf8").trim());
      assert.equal(call.obj.projectRoot, fs.realpathSync(project));
    } finally {
      r.kill();
      setTimeout(() => { try { fs.rmSync(fx.tmp, { recursive: true, force: true }); } catch {} }, 300);
    }
  });

  it("retries an unbound status until projection appears, then pins the first verified project", async () => {
    const fx = setupRouterFixture();
    const projectB = path.join(fx.tmp, "other-registered-project");
    fs.mkdirSync(projectB, { recursive: true });
    fx.addProject("project-b", projectB);
    const r = startRouter({ homeDir: fx.homeDir, hubDir: fx.hubDir, vaultPath: fx.vaultPath, recordPath: fx.recordPath, cwd: fx.projDir, threadId: "late-thread" });
    try {
      const early = await r.callTool("memory_status", {});
      assert.equal(JSON.parse(early.result.content[0].text).projectBindingReason, "thread_not_found");
      fx.addThread("late-thread", "project-default");
      const bound = await r.callTool("memory_status", {});
      assert.equal(JSON.parse(bound.result.content[0].text).projectRoot, fs.realpathSync(fx.projDir));
      fx.updateStateDb("UPDATE orchestration_v2_projection_threads SET project_id=? WHERE thread_id=?", ["project-b", "late-thread"]);
      const correct = await r.callTool("memory_search", { query: "deploy", projectRoot: fx.projDir });
      assert.ok(correct.result, JSON.stringify(correct));
      const wrong = await r.callTool("memory_search", { query: "deploy", projectRoot: projectB });
      assert.ok(wrong.error, "a successfully bound router process cannot switch to another project");
      const finalStatus = await r.callTool("memory_status", {});
      assert.equal(JSON.parse(finalStatus.result.content[0].text).projectRoot, fs.realpathSync(fx.projDir));
    } finally {
      r.kill();
      setTimeout(() => { try { fs.rmSync(fx.tmp, { recursive: true, force: true }); } catch {} }, 300);
    }
  });

  it("pc-lite recall is project-bound, defaults to six and truncates long content; smart writes stay project-scoped", async () => {
    const { main } = await import("../scripts/pc-lite.mjs");
    const tmp = mkTmp("pc-lite-project-scope-");
    const project = path.join(tmp, "project");
    fs.mkdirSync(project, { recursive: true });
    const userDataDir = path.join(tmp, "t3-userdata");
    fs.mkdirSync(userDataDir, { recursive: true });
    const stateDb = new DatabaseSync(path.join(userDataDir, "statev2.sqlite"));
    stateDb.exec("CREATE TABLE projection_projects(project_id TEXT, workspace_root TEXT, deleted_at TEXT); CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT, project_id TEXT, payload_json TEXT, deleted_at TEXT)");
    stateDb.prepare("INSERT INTO projection_projects VALUES(?,?,NULL)").run("cli-project", fs.realpathSync(project));
    stateDb.close();
    const calls = [];
    const vault = {
      listMemories(args) {
        calls.push({ kind: "list", args });
        return { ok: true, projectSlug: "project", items: [{ id: "mem-long", title: "Long", module: "topics", kind: "topic", content: "x".repeat(1200) }] };
      },
      saveMemory(args) {
        calls.push({ kind: "save", args });
        return { ok: true, item: { id: "mem-new", projectSlug: "project" }, deduplicated: false };
      },
    };
    const output = [];
    const common = { cwd: project, vault, accessManager: { isAccessEnabled: () => true }, stdout: (s) => output.push(s), stderr: (s) => output.push(s) };
    const previousEnv = { HOME: process.env.HOME, T3CODE_HOME: process.env.T3CODE_HOME, T3CODE_THREAD_ID: process.env.T3CODE_THREAD_ID };
    process.env.T3CODE_HOME = userDataDir;
    delete process.env.T3CODE_THREAD_ID;
    try {
      const defaultRecallCode = await main({ ...common, argv: ["recall"] });
      assert.equal(defaultRecallCode, 0);
      assert.equal(calls[0].args.limit, 6);
      assert.equal(calls[0].args.includeGlobal, false);
      output.length = 0;
      const recallCode = await main({ ...common, argv: ["recall", "--limit", "99"] });
      assert.equal(recallCode, 0);
      assert.equal(calls[1].args.projectRoot, fs.realpathSync(project));
      assert.equal(calls[1].args.includeGlobal, false);
      assert.equal(calls[1].args.limit, 20);
      const printed = output.join("");
      assert.match(printed, /id=mem-long/);
      assert.match(printed, /truncated/);
      assert.ok(printed.length < 1500, "long recall content is bounded");

      output.length = 0;
      const writeCode = await main({ ...common, argv: ["write", "--module", "topics", "--kind", "global", "--title", "T", "--content", "C"] });
      assert.equal(writeCode, 0);
      const writeCall = calls.find((call) => call.kind === "save");
      assert.equal(writeCall.args.scope, "shared", "a smart kind cannot create global-scope memory");

      const other = path.join(tmp, "other-project");
      fs.mkdirSync(path.join(other, ".git"), { recursive: true });
      const beforeRejectedCalls = calls.length;
      const wrongRootCode = await main({ ...common, argv: ["recall", "--root", other] });
      assert.equal(wrongRootCode, 1, "Agent cannot redirect CLI memory to another project");
      const globalScopeCode = await main({ ...common, argv: ["recall", "--scope-filter", "global"] });
      assert.equal(globalScopeCode, 1);
      assert.equal(calls.length, beforeRejectedCalls, "rejected CLI calls do not touch the vault");

      const unboundCode = await main({ ...common, cwd: tmp, argv: ["recall", "--root", project] });
      assert.equal(unboundCode, 1, "an explicit --root cannot bootstrap unknown Agent context");
      assert.equal(calls.length, beforeRejectedCalls);
    } finally {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

