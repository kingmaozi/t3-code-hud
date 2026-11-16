"use strict";
// Dedicated durable coverage for embed memory ceiling (install.sh template).
// Extracts generated embed-server.py from install.sh, py_compiles it, then
// runs a real MLX pressure test on a temp port: variable-length + 40-item
// batches must stay strictly under the dynamic ceiling and /trim clears cache.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const net = require("node:net");

const REPO = path.resolve(__dirname, "..");
const INSTALL_SH = path.join(REPO, "install.sh");
const DELIM = "T3_EMBED_SERVER_PY_EOF";

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function extractEmbedServerPy() {
  const sh = fs.readFileSync(INSTALL_SH, "utf8");
  const startMarker = "<<'" + DELIM + "'";
  const start = sh.indexOf(startMarker);
  assert.ok(start !== -1, "install.sh must heredoc generated embed-server.py (<<" + DELIM + ")");
  const bodyStart = sh.indexOf("\n", start) + 1;
  // End marker is a line containing only DELIM
  const endRe = new RegExp("^" + DELIM + "\\s*$", "m");
  const rest = sh.slice(bodyStart);
  const m = rest.match(endRe);
  assert.ok(m, "install.sh heredoc terminator " + DELIM + " not found");
  const body = rest.slice(0, m.index);
  assert.ok(body.includes("def embed_texts"), "extracted file must contain embed_texts");
  assert.ok(body.length > 5000, "extracted embed-server.py suspiciously small: " + body.length);
  return body;
}

function findVenvPython() {
  const cands = [
    process.env.T3_EMBED_TEST_PYTHON,
    path.join(os.homedir(), ".t3", "powercontext-venv", "bin", "python"),
    "/Users/longxiaking/powercontext-embed-eg2/.venv/bin/python",
    path.join(os.homedir(), "powercontext-embed-eg2", ".venv", "bin", "python"),
  ].filter(Boolean);
  for (const c of cands) {
    try {
      const st = fs.statSync(c);
      if (st.isFile() || st.isSymbolicLink()) {
        // Resolve symlink target check
        try {
          fs.accessSync(c, fs.constants.X_OK);
          return c;
        } catch {}
      }
    } catch {}
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function httpJson(method, url, payload, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = payload == null ? null : Buffer.from(JSON.stringify(payload), "utf8");
    const req = require("node:http").request(
      {
        hostname: u.hostname,
        port: Number(u.port),
        path: u.pathname + (u.search || ""),
        method,
        timeout: timeoutMs,
        headers: body ? { "content-type": "application/json", "content-length": body.length } : {},
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try { json = JSON.parse(text); } catch {}
          resolve({ status: res.statusCode, json, text });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout " + method + " " + url)));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitForHealth(base, timeoutMs = 150000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const r = await httpJson("GET", base + "/health", null, 5000);
      if (r.status === 200 && r.json && (r.json.status === "ok" || r.json.ok === true)) {
        // Must be fully loaded (dim present) and ceiling computed
        if (r.json.dim != null && typeof r.json.ceiling_mb === "number" && r.json.ceiling_mb > 0) {
          return r.json;
        }
      }
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  throw new Error("health never became ready: " + (lastErr && lastErr.message));
}

function expectedCeiling(baseActiveMb) {
  return Math.round(Math.max(baseActiveMb * 1.28 + 180.0, baseActiveMb + 220.0) * 10) / 10;
}
function expectedCacheLimitBytes(baseActiveBytes) {
  return Math.min(256 * 1024 * 1024, Math.max(48 * 1024 * 1024, Math.trunc(baseActiveBytes * 0.12)));
}

describe("install.sh generated embed-server.py (static contract)", () => {
  it("extracts and py_compiles with zero errors", () => {
    const py = extractEmbedServerPy();
    const tmp = mkTmp("emb-ceiling-static-");
    try {
      const out = path.join(tmp, "embed-server.py");
      fs.writeFileSync(out, py, "utf8");
      // Use venv python if present (it has mlx deps for import check via py_compile only needs stdlib)
      const r = spawnSync("python3", ["-m", "py_compile", out], { encoding: "utf8", timeout: 30000 });
      assert.equal(r.status, 0, "py_compile failed: " + (r.stderr || r.stdout || ""));
      // Also verify bash syntax of installer still valid
      const b = spawnSync("bash", ["-n", INSTALL_SH], { encoding: "utf8", timeout: 30000 });
      assert.equal(b.status, 0, "bash -n failed: " + (b.stderr || ""));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("implements all five dynamic-ceiling guards", () => {
    const py = extractEmbedServerPy();
    // 1. dynamic ceiling from measured weights + config override
    assert.ok(py.includes("base_active_bytes") && py.includes("mx.get_active_memory()"), "warmup base_active_bytes");
    assert.ok(py.includes("base_active_mb"), "base_active_mb");
    assert.ok(py.includes("ceiling_mb = round(max(base_active_mb * 1.28 + 180.0, base_active_mb + 220.0), 1)"), "ceiling formula exact");
    assert.ok(py.includes("maxMemoryMb") && py.includes("ceilingMb"), "config override maxMemoryMb/ceilingMb");
    // 2. metal hard limits
    assert.ok(py.includes("cache_limit_bytes = min(256 * 1024 * 1024, max(48 * 1024 * 1024, int(base_active_bytes * 0.12)))"), "cache limit formula exact");
    assert.ok(py.includes("set_cache_limit"), "set_cache_limit");
    assert.ok(py.includes("set_memory_limit"), "set_memory_limit");
    assert.ok(py.includes("mx.metal.set_cache_limit") || py.includes("metal.set_cache_limit"), "metal fallback");
    assert.ok(py.includes("MemoryError"), "MemoryError fallback");
    // 3. truncation + micro-batch
    assert.ok(py.includes("MAX_CHARS_PER_TEXT = 2048"), "MAX_CHARS_PER_TEXT");
    assert.ok(py.includes("MICRO_BATCH_SIZE = 8"), "MICRO_BATCH_SIZE");
    // 4. enforce + trim + health observability
    assert.ok(py.includes("def _enforce_memory_ceiling"), "_enforce_memory_ceiling");
    assert.ok(py.includes("auto_trimmed_count"), "auto_trimmed_count");
    assert.ok(py.includes("/trim") || py.includes('"/trim"') || py.includes("'/trim'"), "POST /trim");
    assert.ok(py.includes("base_active_mb") && py.includes("ceiling_mb") && py.includes("cache_limit_mb") && py.includes("peak_mb"), "health new fields");
    // backward compat old health fields
    for (const f of ['"status"', '"model"', '"dim"', '"active_mb"', '"rss_mb"']) {
      assert.ok(py.includes(f), "health legacy field " + f);
    }
    // 5. RSS fuse
    assert.ok(py.includes("rss_fuse_mb"), "rss_fuse_mb");
    assert.ok(py.includes("rss_fuse_mb = round(max(ceiling_mb * 1.45, ceiling_mb + 512.0), 1)"), "fuse formula exact");
    assert.ok(py.includes("os._exit(0)"), "self-restart os._exit(0)");
  });

  it("keeps launchd KeepAlive true for fuse relaunch", () => {
    const sh = fs.readFileSync(INSTALL_SH, "utf8");
    assert.ok(sh.includes("com.t3tools.powercontext-embed.plist"), "launchd plist reference");
    assert.ok(sh.includes("KeepAlive"), "KeepAlive in installer");
  });
});

// Live MLX pressure test — real server on temp port with smallest cached model.
describe("live MLX memory-ceiling pressure test", () => {
  let tmp = null;
  let pyFile = null;
  let proc = null;
  let base = null;
  let port = 0;
  const TEST_MODEL = "mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ";

  before(async () => {
    const python = findVenvPython();
    assert.ok(python, "venv python not found (expected ~/.t3/powercontext-venv/bin/python or powercontext-embed-eg2 .venv)");
    tmp = mkTmp("emb-ceiling-live-");
    pyFile = path.join(tmp, "embed-server.py");
    fs.writeFileSync(pyFile, extractEmbedServerPy(), "utf8");
    // Quick py_compile on extracted file with venv python
    const c = spawnSync(python, ["-m", "py_compile", pyFile], { encoding: "utf8", timeout: 30000 });
    assert.equal(c.status, 0, "venv py_compile failed: " + (c.stderr || ""));
    port = await freePort();
    base = "http://127.0.0.1:" + port;
    const env = {
      ...process.env,
      PORT: String(port),
      EMBED_MODEL: TEST_MODEL,
      EMBED_NAME: TEST_MODEL.split("/").pop(),
      T3_EMBED_FORCE_ENV: "1",
      T3_EMBED_IGNORE_CONFIG: "1",
      HF_HUB_OFFLINE: process.env.HF_HUB_OFFLINE || "1",
    };
    proc = spawn(python, [pyFile], { env, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    proc.stdout.on("data", (d) => { log += d.toString(); if (log.length > 20000) log = log.slice(-20000); });
    proc.stderr.on("data", (d) => { log += d.toString(); if (log.length > 20000) log = log.slice(-20000); });
    proc.__log = () => log;
    // Give server a head start; waitForHealth in first test will poll
  });

  after(async () => {
    if (proc && !proc.killed) {
      try { proc.kill("SIGTERM"); } catch {}
      await new Promise((r) => setTimeout(r, 800));
      if (!proc.killed) {
        try { proc.kill("SIGKILL"); } catch {}
      }
    }
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("health reports dynamic ceiling and strict bound holds under variable-length pressure", async () => {
    const health0 = await waitForHealth(base, 150000);
    // New observability fields present and finite
    for (const k of ["base_active_mb", "ceiling_mb", "cache_mb", "cache_limit_mb", "auto_trimmed_count"]) {
      assert.ok(typeof health0[k] === "number", "health." + k + " must be number, got " + typeof health0[k]);
    }
    // Legacy backward compat
    for (const k of ["status", "model", "dim", "active_mb", "rss_mb"]) {
      assert.ok(health0[k] != null, "legacy health." + k + " missing");
    }
    assert.ok(health0.base_active_mb > 0, "base_active_mb must be >0 after warmup");
    // Ceiling follows measured weights (no config override in this run)
    const expected = expectedCeiling(health0.base_active_mb);
    assert.ok(Math.abs(health0.ceiling_mb - expected) < 5, `ceiling ${health0.ceiling_mb} should track base ${health0.base_active_mb} -> expected ~${expected}`);
    const expectedCacheMb = expectedCacheLimitBytes(health0.base_active_mb * 1024 * 1024) / (1024 * 1024);
    assert.ok(Math.abs(health0.cache_limit_mb - expectedCacheMb) < 6, `cache_limit ${health0.cache_limit_mb} ~ ${expectedCacheMb}`);
    assert.ok(health0.cache_limit_mb <= 256.01 && health0.cache_limit_mb >= 47.9, "cache limit clamped [48,256]MB");

    // Variable-length texts: short, medium, long (>2048 to hit truncation), random
    const mk = (n) => {
      const parts = [];
      const words = ["memory", "cache", "retrieve", "query", "test", "embed", "vector", "search"];
      for (let i = 0; i < n; i++) parts.push(words[i % words.length] + "-" + (i % 7));
      return parts.join(" ");
    };
    const variants = ["hi", mk(30), mk(120), mk(400), "x".repeat(2500), mk(200) + "\n" + mk(200)];
    const rounds = 6;
    for (let r = 0; r < rounds; r++) {
      // Single embed with rotating length
      const single = variants[r % variants.length];
      const r1 = await httpJson("POST", base + "/v1/embeddings", { input: single, model: "x" }, 60000);
      assert.equal(r1.status, 200, "single embed round " + r + " status: " + r1.text.slice(0, 400));
      assert.ok(r1.json && Array.isArray(r1.json.data) && r1.json.data.length === 1, "single data");
      const h1 = await httpJson("GET", base + "/health", null, 10000);
      assert.equal(h1.status, 200);
      const sum1 = Number(h1.json.active_mb) + Number(h1.json.cache_mb);
      assert.ok(sum1 <= Number(h1.json.ceiling_mb) + 1e-9, `round ${r} single: active+cache ${sum1} > ceiling ${h1.json.ceiling_mb}`);
      // Large batch: 40 variable-length long texts (micro-batch 8 -> 5 micro-batches)
      const batch = [];
      for (let i = 0; i < 40; i++) {
        const len = 20 + ((i * 37 + r * 13) % 900);
        batch.push(mk(len) + " doc-" + i);
      }
      const r2 = await httpJson("POST", base + "/v1/embeddings", { input: batch, model: "x" }, 120000);
      assert.equal(r2.status, 200, "batch40 round " + r + " status: " + r2.text.slice(0, 400));
      assert.ok(r2.json && Array.isArray(r2.json.data) && r2.json.data.length === 40, "batch40 data len");
      const h2 = await httpJson("GET", base + "/health", null, 10000);
      const sum2 = Number(h2.json.active_mb) + Number(h2.json.cache_mb);
      assert.ok(sum2 <= Number(h2.json.ceiling_mb) + 1e-9, `round ${r} batch40: active+cache ${sum2} > ceiling ${h2.json.ceiling_mb}`);
      // Cache must also respect its own limit
      assert.ok(Number(h2.json.cache_mb) <= Number(h2.json.cache_limit_mb) + 1.0, `round ${r} cache ${h2.json.cache_mb} > limit ${h2.json.cache_limit_mb}`);
    }

    // Non-linear growth: ceiling must not have drifted upward across rounds
    const healthEnd = await httpJson("GET", base + "/health", null, 10000);
    assert.ok(Math.abs(Number(healthEnd.json.ceiling_mb) - expected) < 5, "ceiling stable after pressure");
  });

  it("/embed alias works and /trim clears cache", async () => {
    // /embed alias (shorthand used by spec)
    const rAlias = await httpJson("POST", base + "/embed", { input: "hello alias test" }, 60000);
    // If alias unsupported, fallback check is /v1/embeddings already proven; alias is required by spec
    assert.equal(rAlias.status, 200, "/embed alias status: " + rAlias.text.slice(0, 400));
    assert.ok(rAlias.json && Array.isArray(rAlias.json.data), "/embed data");

    const before = (await httpJson("GET", base + "/health", null, 10000)).json;
    const trim = await httpJson("POST", base + "/trim", {}, 30000);
    assert.equal(trim.status, 200, "/trim status: " + trim.text.slice(0, 500));
    assert.ok(trim.json && (trim.json.ok === true || trim.json.status === "ok"), "/trim ok: " + trim.text.slice(0, 500));
    // Trim reports before/after metrics
    assert.ok(trim.json.before != null || trim.json.before_cache_mb != null || typeof trim.json.cache_mb === "number", "trim metrics present");
    const afterH = (await httpJson("GET", base + "/health", null, 10000)).json;
    const afterCache = Number(afterH.cache_mb);
    const beforeCache = Number(before.cache_mb);
    assert.ok(afterCache <= Math.max(10, beforeCache * 0.5) || afterCache <= 10, `trim should clear cache: before ${beforeCache} after ${afterCache}`);
    // Strict bound still holds after trim
    const sum = Number(afterH.active_mb) + afterCache;
    assert.ok(sum <= Number(afterH.ceiling_mb) + 1e-9, `post-trim ${sum} > ceiling ${afterH.ceiling_mb}`);
  });
});

// Octen-Embedding-4B asymmetric prefixes: full-blood RTEB 76.8 contract.
// Server is the single prefix injector; caller must not double-prefix.
function findOctenEsthaPath() {
  const hub = path.join(os.homedir(), ".cache", "huggingface", "hub", "models--mlx-community--Octen-Embedding-4B-MLX-4bit", "snapshots");
  try {
    if (!fs.existsSync(hub)) return null;
    for (const rev of fs.readdirSync(hub)) {
      const p = path.join(hub, rev, "estha_embedding_config.json");
      if (fs.existsSync(p)) return p;
    }
  } catch {}
  return null;
}

describe("Octen estha asymmetric prefixes (full-blood RTEB)", () => {
  it("src and install.sh template expose estha loader + std defaults for octen/qwen", () => {
    const py = (() => {
      // Prefer install.sh template (deployment truth) but both must match src
      const sh = fs.readFileSync(INSTALL_SH, "utf8");
      const startMarker = "<<'" + DELIM + "'";
      const start = sh.indexOf(startMarker);
      assert.ok(start !== -1, "install.sh heredoc present");
      const bodyStart = sh.indexOf("\n", start) + 1;
      const rest = sh.slice(bodyStart);
      const m = rest.match(new RegExp("^" + DELIM + "\\s*$", "m"));
      assert.ok(m, "heredoc terminator found");
      return rest.slice(0, m.index);
    })();
    const srcPy = fs.readFileSync(path.join(REPO, "src", "embed-server.py"), "utf8");
    assert.equal(py, srcPy, "src vs install.sh template byte-identical");
    assert.ok(py.includes('DEFAULT_QUERY_PREFIX = "Instruct: Given a web search query, retrieve relevant passages that answer the query\\nQuery:"'), "std query prefix");
    assert.ok(py.includes('DEFAULT_DOCUMENT_PREFIX = " "'), "std doc prefix");
    assert.ok(py.includes("estha_embedding_config.json"), "estha filename");
    assert.ok(py.includes("hf_hub_download"), "hf_hub_download");
    assert.ok(py.includes("local_files_only=True"), "local_files_only");
    assert.ok(py.includes("def _load_estha_config_for_model"), "loader fn");
    assert.ok(py.includes("def _estha_prefixes_for"), "selector fn");
    // Fallback for octen/qwen family by model-name substring
    assert.ok(py.includes('"octen" in mid') || py.includes("'octen' in mid"), "octen fallback");
    assert.ok(py.includes('"qwen3-embedding" in mid') || py.includes("'qwen3-embedding'"), "qwen fallback");
    // Passage alias + idempotent startswith guards
    assert.ok(py.includes('ity in ("document", "passage")'), "passage/document alias");
    assert.ok(py.includes('t.startswith("Instruct:")'), "idempotent Instruct check");
    assert.ok(py.includes("t.startswith(qp)"), "idempotent qp check");
    assert.ok(py.includes("t.startswith(dp)"), "idempotent dp check");
    // Keep legacy domain prefix present for curated contract (also used for idempotent check)
    assert.ok(py.includes("LEGACY_QWEN_QUERY_PREFIX") || py.includes("Instruct: Given a software engineering search query"), "legacy retained");
    // health exposes estha fields for observability
    assert.ok(py.includes("esthaQueryPrefix") || py.includes("estha_query_prefix"), "health estha fields");
  });

  it("reads real Octen HF snapshot estha_embedding_config.json (RTEB contract)", () => {
    const esthaPath = findOctenEsthaPath();
    assert.ok(esthaPath && fs.existsSync(esthaPath), "Octen estha must exist in local HF cache (mlx-community/Octen-Embedding-4B-MLX-4bit)");
    const j = JSON.parse(fs.readFileSync(esthaPath, "utf8"));
    assert.equal(j.query_prefix, "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:");
    assert.equal(j.document_prefix, " ");
    assert.ok(j.version === 1 && j.pooling === "last_token" && j.normalize === true, "estha contract fields");
  });

  it("_format_inputs_for_model is idempotent for Octen query/document/passage (pure Python)", () => {
    // Use venv python that has mlx for import; fallback to system python with mocks.
    const python = findVenvPython() || "python3";
    const tmp = mkTmp("emb-octen-prefix-");
    const helper = path.join(tmp, "check_prefix.py");
    const script = [
      "import importlib.util, sys, os",
      "spec = importlib.util.spec_from_file_location('emb', r'" + path.join(REPO, "src", "embed-server.py").replace(/\\/g, "\\\\") + "')",
      "mod = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(mod)",
      "# Simulate Octen loaded state (as _load_estha_config_for_model does for real snapshot)",
      "mod.ESTHA_QUERY_PREFIX = mod.DEFAULT_QUERY_PREFIX",
      "mod.ESTHA_DOCUMENT_PREFIX = mod.DEFAULT_DOCUMENT_PREFIX",
      "mod.ESTHA_SOURCE = 'file'",
      "mod.state.update({'estha_query_prefix': mod.DEFAULT_QUERY_PREFIX, 'estha_document_prefix': mod.DEFAULT_DOCUMENT_PREFIX})",
      "Q = 'mlx-community/Octen-Embedding-4B-MLX-4bit'",
      "qp = mod.DEFAULT_QUERY_PREFIX",
      "dp = mod.DEFAULT_DOCUMENT_PREFIX",
      "# query injection",
      "out = mod._format_inputs_for_model(['hello'], Q, 'query')",
      "assert out == [qp + 'hello'], out",
      "# idempotent: already with qp",
      "out2 = mod._format_inputs_for_model([qp + 'hello'], Q, 'query')",
      "assert out2 == [qp + 'hello'], out2",
      "# idempotent: any Instruct: is left alone (covers legacy + std)",
      "out_instruct = 'Instruct: custom hello'",
      "assert mod._format_inputs_for_model([out_instruct], Q, 'query') == [out_instruct]",
      "# document injection",
      "doc_out = mod._format_inputs_for_model(['world'], Q, 'document')",
      "assert doc_out == [' world'], doc_out",
      "# document idempotent",
      "assert mod._format_inputs_for_model([' world'], Q, 'document') == [' world']",
      "# passage alias behaves as document",
      "pass_out = mod._format_inputs_for_model(['world'], Q, 'passage')",
      "assert pass_out == doc_out, pass_out",
      "assert mod._format_inputs_for_model([' world'], Q, 'passage') == [' world']",
      "# PREFIX env still wins (global PREFIX)",
      "orig_prefix = mod.PREFIX",
      "mod.PREFIX = 'PRE:'",
      "assert mod._format_inputs_for_model(['x'], Q, 'query') == ['PRE:x']",
      "mod.PREFIX = orig_prefix",
      "# Qwen fallback also uses std query but doc is empty (official ''), via default-qwen source",
      "mod.ESTHA_QUERY_PREFIX = mod.DEFAULT_QUERY_PREFIX",
      "mod.ESTHA_DOCUMENT_PREFIX = ''",
      "mod.ESTHA_SOURCE = 'default-qwen'",
      "q_out = mod._format_inputs_for_model(['hi'], 'mlx-community/Qwen3-Embedding-0.6B-8bit', 'query')",
      "assert q_out == [qp + 'hi'], q_out",
      "assert mod._format_inputs_for_model([qp+'hi'], 'mlx-community/Qwen3-Embedding-0.6B-8bit', 'query') == [qp+'hi']",
      "# document for Qwen with empty dp is passthrough",
      "assert mod._format_inputs_for_model(['doc'], 'mlx-community/Qwen3-Embedding-0.6B-8bit', 'document') == ['doc']",
      "# Non-estha model (embeddinggemma) still uses legacy prefixes and is not caught by estha branch",
      "mod.ESTHA_QUERY_PREFIX = None; mod.ESTHA_DOCUMENT_PREFIX = None; mod.ESTHA_SOURCE='none'",
      "ema = mod._format_inputs_for_model(['q'], 'mlx-community/embeddinggemma-2-8bit', 'query')",
      "assert ema == ['task: search result | query: q'], ema",
      "print('octen prefix checks passed')",
    ].join("\n");
    fs.writeFileSync(helper, script, "utf8");
    try {
      const r = spawnSync(python, [helper], { encoding: "utf8", timeout: 30000 });
      assert.equal(r.status, 0, "prefix python check failed: " + (r.stderr || r.stdout || "").slice(0, 2000));
      assert.ok((r.stdout || "").includes("octen prefix checks passed"), "helper must print pass: " + (r.stdout || ""));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("_load_estha_config_for_model reads snapshot + hf_hub fallback (real Octen cache)", () => {
    const python = findVenvPython() || "python3";
    const tmp = mkTmp("emb-octen-load-");
    const helper = path.join(tmp, "check_load.py");
    const script = [
      "import importlib.util, os, json, pathlib",
      "spec = importlib.util.spec_from_file_location('emb', r'" + path.join(REPO, "src", "embed-server.py").replace(/\\/g, "\\\\") + "')",
      "mod = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(mod)",
      "# 1. snapshot dir path",
      "hub = pathlib.Path.home() / '.cache' / 'huggingface' / 'hub' / 'models--mlx-community--Octen-Embedding-4B-MLX-4bit' / 'snapshots'",
      "snap = None",
      "import glob",
      "for p in hub.glob('*/estha_embedding_config.json'): snap = str(p.parent) ; break",
      "assert snap and pathlib.Path(snap, 'estha_embedding_config.json').exists(), 'estha snapshot missing'",
      "cfg = mod._load_estha_config_for_model('mlx-community/Octen-Embedding-4B-MLX-4bit', snap)",
      "assert cfg.get('query_prefix') == mod.DEFAULT_QUERY_PREFIX, cfg",
      "assert cfg.get('document_prefix') == ' ', cfg",
      "assert mod.ESTHA_QUERY_PREFIX == mod.DEFAULT_QUERY_PREFIX",
      "assert mod.ESTHA_DOCUMENT_PREFIX == ' '",
      "assert mod.ESTHA_SOURCE == 'file', mod.ESTHA_SOURCE",
      "# 2. hf_hub_download local_files_only fallback (no model_path)",
      "cfg2 = mod._load_estha_config_for_model('mlx-community/Octen-Embedding-4B-MLX-4bit', None)",
      "assert cfg2.get('query_prefix') == mod.DEFAULT_QUERY_PREFIX, cfg2",
      "assert cfg2.get('document_prefix') == ' '",
      "print('load checks passed')",
    ].join("\n");
    fs.writeFileSync(helper, script, "utf8");
    try {
      const r = spawnSync(python, [helper], { encoding: "utf8", timeout: 30000 });
      assert.equal(r.status, 0, "estha load python check failed: " + (r.stderr || r.stdout || "").slice(0, 2000));
      assert.ok((r.stdout || "").includes("load checks passed"), "load pass: " + (r.stdout || ""));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
