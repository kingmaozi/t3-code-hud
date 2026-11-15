"use strict";
// Curated embed engine v3: presets, hardware recommend, cache, plist, vault reindex.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const REPO = path.resolve(__dirname, "..");
const embedMgrMod = require(path.join(REPO, "src", "embed-manager.cjs"));
const { createEmbedManager, PRESETS, detectHardwareProfile } = embedMgrMod;
const { createMemoryVault } = require(path.join(REPO, "src", "memory-vault.cjs"));

const EXPECTED_IDS = [
  "mlx-community/Qwen3-Embedding-0.6B-8bit",
  "mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ",
  "mlx-community/bge-m3-mlx-8bit",
  "mlx-community/bge-m3-mlx-4bit",
  "mlx-community/embeddinggemma-300m-8bit",
  "mlx-community/embeddinggemma-300m-4bit",
  "mlx-community/snowflake-arctic-embed-l-v2.0-8bit",
  "mlx-community/LFM2.5-Embedding-350M-4bit",
  "mlx-community/nomicai-modernbert-embed-base-bf16",
  "mlx-community/embeddinggemma-2-8bit",
  "fts5-zero-ram",
];

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function readPy() {
  return fs.readFileSync(path.join(REPO, "src", "embed-server.py"), "utf8");
}

describe("curated presets integrity", () => {
  it("contains 11 presets without 404 bge-small", () => {
    assert.equal(PRESETS.length, 11, "got " + PRESETS.length);
    const ids = PRESETS.map((p) => p.id);
    assert.deepEqual(ids, EXPECTED_IDS);
    assert.ok(!ids.some((id) => id.includes("bge-small-zh-v1.5-4bit")), "must not contain 404 model");
    for (const p of PRESETS) {
      assert.ok(p.id, "id");
      assert.ok(p.modelId, "modelId " + p.id);
      assert.equal(p.modelId, p.id, "modelId equals id for " + p.id);
      assert.ok(p.label, "label " + p.id);
      assert.ok(p.shortLabel, "shortLabel " + p.id);
      assert.equal(typeof p.sizeMb, "number", "sizeMb " + p.id);
      assert.equal(typeof p.estRamMb, "number", "estRamMb " + p.id);
      assert.equal(typeof p.dim, "number", "dim " + p.id);
      assert.equal(typeof p.minRamGb, "number", "minRamGb " + p.id);
      assert.ok(["compact", "standard", "workstation", "any"].includes(p.idealRamTier), "idealRamTier " + p.id);
      assert.ok(Array.isArray(p.tags) && p.tags.length, "tags " + p.id);
      assert.ok(p.desc, "desc " + p.id);
      assert.ok(p.description, "description compat " + p.id);
      assert.ok(p.mode, "mode compat " + p.id);
    }
    const byId = Object.fromEntries(PRESETS.map((p) => [p.id, p]));
    assert.equal(byId["mlx-community/Qwen3-Embedding-0.6B-8bit"].sizeMb, 604);
    assert.equal(byId["mlx-community/Qwen3-Embedding-0.6B-8bit"].dim, 1024);
    assert.equal(byId["mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ"].sizeMb, 320);
    assert.equal(byId["mlx-community/bge-m3-mlx-8bit"].sizeMb, 576);
    assert.equal(byId["mlx-community/bge-m3-mlx-8bit"].dim, 1024);
    assert.equal(byId["mlx-community/bge-m3-mlx-4bit"].sizeMb, 305);
    assert.equal(byId["mlx-community/embeddinggemma-300m-8bit"].sizeMb, 312);
    assert.equal(byId["mlx-community/embeddinggemma-300m-8bit"].dim, 768);
    assert.equal(byId["mlx-community/embeddinggemma-300m-4bit"].sizeMb, 165);
    assert.equal(byId["mlx-community/snowflake-arctic-embed-l-v2.0-8bit"].sizeMb, 576);
    assert.equal(byId["mlx-community/LFM2.5-Embedding-350M-4bit"].sizeMb, 190);
    assert.equal(byId["mlx-community/nomicai-modernbert-embed-base-bf16"].sizeMb, 284);
    assert.equal(byId["mlx-community/nomicai-modernbert-embed-base-bf16"].dim, 768);
    assert.equal(byId["mlx-community/embeddinggemma-2-8bit"].sizeMb, 1177);
    assert.equal(byId["fts5-zero-ram"].dim, 0);
    assert.equal(byId["fts5-zero-ram"].sizeMb, 0);
  });
});

describe("detectHardwareProfile tiers", () => {
  it("recommends workstation / standard / compact by RAM", () => {
    const h96 = detectHardwareProfile({ totalRamGb: 96, chipModel: "Apple M3 Ultra" });
    assert.equal(h96.totalRamGb, 96);
    assert.equal(h96.chipModel, "Apple M3 Ultra");
    assert.equal(h96.primaryModelId, "mlx-community/Qwen3-Embedding-0.6B-8bit");
    assert.match(h96.recommendReason, /96 GB/);
    assert.ok(Array.isArray(h96.secondaryModelIds));
    assert.ok(h96.secondaryModelIds.includes("mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ"));
    assert.ok(h96.secondaryModelIds.includes("mlx-community/bge-m3-mlx-8bit"));

    const h16 = detectHardwareProfile({ totalRamGb: 16, chipModel: "Apple M1" });
    assert.equal(h16.primaryModelId, "mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ");
    assert.ok(h16.secondaryModelIds.includes("mlx-community/bge-m3-mlx-4bit"));

    const h8 = detectHardwareProfile({ totalRamGb: 8, chipModel: "Apple M1" });
    assert.equal(h8.primaryModelId, "mlx-community/embeddinggemma-300m-4bit");
    assert.ok(h8.secondaryModelIds.includes("fts5-zero-ram"));
  });
  it("getStatus exposes hardware and recommended badges", () => {
    const tmp = mkTmp("emb-hw-");
    const mgr = createEmbedManager({
      homeDir: tmp, hubDir: path.join(tmp, "hub"), cacheDir: path.join(tmp, "cache"),
      port: 18111, launchAgentPlistPath: null,
      totalRamGb: 96, chipModel: "Apple M3 Ultra",
    });
    const st = mgr.getStatus();
    assert.ok(st.hardware, "hardware");
    assert.equal(st.hardware.totalRamGb, 96);
    assert.equal(st.hardware.chipModel, "Apple M3 Ultra");
    assert.equal(st.hardware.primaryModelId, "mlx-community/Qwen3-Embedding-0.6B-8bit");
    const primary = st.presets.find((p) => p.id === st.hardware.primaryModelId);
    assert.equal(primary.recommended, true);
    assert.match(primary.recommendBadge, /本机 96GB 首选/);
    const heavy = st.presets.find((p) => p.id === "mlx-community/embeddinggemma-2-8bit");
    assert.equal(heavy.recommendBadge, "偏重·含多模态塔");
    const bge = st.presets.find((p) => p.id === "mlx-community/bge-m3-mlx-8bit");
    assert.equal(bge.recommendBadge, "稳健双语");
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe("isModelCached hub layouts", () => {
  it("recognizes snapshots safetensors and blobs", () => {
    const tmp = mkTmp("emb-cache-");
    const cacheDir = path.join(tmp, "cache");
    const model = "mlx-community/Qwen3-Embedding-0.6B-8bit";
    const safe = "models--" + model.replace(/\//g, "--");
    const { isModelCached } = embedMgrMod;
    // snapshots/<rev>/model.safetensors
    const snap = path.join(cacheDir, safe, "snapshots", "rev123");
    fs.mkdirSync(snap, { recursive: true });
    fs.writeFileSync(path.join(snap, "model.safetensors"), "1234");
    assert.equal(isModelCached(model, cacheDir, tmp), true, "snapshots layout");
    fs.rmSync(cacheDir, { recursive: true, force: true });
    // blobs/
    fs.mkdirSync(path.join(cacheDir, safe, "blobs"), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, safe, "blobs", "blob1"), "1234");
    assert.equal(isModelCached(model, cacheDir, tmp), true, "blobs layout");
    fs.rmSync(cacheDir, { recursive: true, force: true });
    // empty snapshots dirs -> false
    fs.mkdirSync(path.join(cacheDir, safe, "snapshots", "revEmpty"), { recursive: true });
    assert.equal(isModelCached(model, cacheDir, tmp), false, "empty snapshots must be false");
    fs.rmSync(cacheDir, { recursive: true, force: true });
    // missing entirely -> false
    assert.equal(isModelCached(model, cacheDir, tmp), false);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe("launch agent plist sync", () => {
  const PLIST_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.t3tools.powercontext-embed</string>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>EMBED_MODEL</key>
    <string>mlx-community/embeddinggemma-2-8bit</string>
    <key>EMBED_NAME</key>
    <string>EmbeddingGemma-2-8bit</string>
  </dict>
</dict>
</plist>
`;
  it("updates EMBED_MODEL and EMBED_NAME atomically", () => {
    const tmp = mkTmp("emb-plist-");
    const plistPath = path.join(tmp, "com.t3tools.powercontext-embed.plist");
    fs.writeFileSync(plistPath, PLIST_SAMPLE, "utf8");
    const calls = [];
    const mgr = createEmbedManager({
      homeDir: tmp, hubDir: path.join(tmp, "hub"), cacheDir: path.join(tmp, "cache"),
      port: 18112, launchAgentPlistPath: plistPath,
      _launchctl: (args) => { calls.push(args); return { status: 0 }; },
    });
    assert.equal(typeof mgr._syncLaunchAgentPlist, "function");
    mgr._syncLaunchAgentPlist({ modelId: "mlx-community/Qwen3-Embedding-0.6B-8bit", servedName: "Qwen3-Embedding-0.6B-8bit", keepAlive: true });
    const after = fs.readFileSync(plistPath, "utf8");
    assert.ok(after.includes("mlx-community/Qwen3-Embedding-0.6B-8bit"), after);
    assert.ok(after.includes("Qwen3-Embedding-0.6B-8bit"), after);
    assert.ok(after.includes("<true/>"), after);
    assert.ok(after.includes("com.t3tools.powercontext-embed"), "Label preserved");
    // fts5 keepAlive false
    mgr._syncLaunchAgentPlist({ modelId: "mlx-community/Qwen3-Embedding-0.6B-8bit", keepAlive: false });
    const after2 = fs.readFileSync(plistPath, "utf8");
    assert.ok(after2.includes("<false/>"), after2);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  it("fts5 switch disables KeepAlive without touching default plist", () => {
    const tmp = mkTmp("emb-plist2-");
    const plistPath = path.join(tmp, "plist.plist");
    fs.writeFileSync(plistPath, PLIST_SAMPLE, "utf8");
    const mgr = createEmbedManager({
      homeDir: tmp, hubDir: path.join(tmp, "hub"), cacheDir: path.join(tmp, "cache"),
      port: 18113, launchAgentPlistPath: plistPath,
      _launchctl: () => ({ status: 0 }),
    });
    const sw = mgr.switchModel({ mode: "fts5" });
    assert.equal(sw.ok, true);
    const after = fs.readFileSync(plistPath, "utf8");
    assert.ok(after.includes("<false/>"), after);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe("memory-vault asymmetric input_type and reindex", () => {
  it("reindexes across model switch without mixing vector spaces", async () => {
    const tmp = mkTmp("vault-cur-");
    const vaultDir = path.join(tmp, "vault");
    const proj = path.join(tmp, "proj");
    fs.mkdirSync(proj, { recursive: true });
    let phase = "A";
    const calls = [];
    function vecFor(text, dim) {
      const v = new Array(dim).fill(0);
      const toks = (String(text).toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []).filter((t) => t.length > 0);
      for (const t of toks) {
        const h = crypto.createHash("sha256").update(phase + ":" + t).digest("hex");
        v[parseInt(h.slice(0, 2), 16) % dim] += 1;
      }
      const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return v.map((x) => x / n);
    }
    function embedFn(texts, opts) {
      calls.push({ texts: texts.slice(), inputType: opts ? (opts.inputType ?? opts.input_type) : undefined });
      const dim = opts && opts.dim ? opts.dim : (phase === "B" ? 1024 : 768);
      return texts.map((t) => vecFor(t, dim));
    }
    function healthFn() {
      if (phase === "A") return { modelId: "model-A", dim: 768 };
      if (phase === "B") return { modelId: "model-B", dim: 1024 };
      return { modelId: "model-C", dim: 768 };
    }
    const v = createMemoryVault({
      vaultDir, homeDir: tmp, _embedFn: embedFn, _healthFn: healthFn,
      embeddingUrl: "http://127.0.0.1:59999/v1/embeddings",
    });
    v.saveMemory({ projectRoot: proj, module: "topics", kind: "topic", title: "alpha topic", content: "alpha cache hit content", autoEvolve: false });
    v.saveMemory({ projectRoot: proj, module: "topics", kind: "topic", title: "beta topic", content: "beta zebra unrelated", autoEvolve: false });
    // wait for background embeds (document)
    const dbPath = path.join(vaultDir, "index.sqlite");
    const deadline = Date.now() + 5000;
    let db;
    function countGroups() {
      db = new DatabaseSync(dbPath);
      try {
        return db.prepare("SELECT model_id, dim, COUNT(*) AS c FROM memory_vectors GROUP BY model_id, dim").all();
      } finally { db.close(); }
    }
    while (Date.now() < deadline) {
      const g = countGroups();
      if (g.some((r) => r.model_id === "model-A")) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    let groups = countGroups();
    assert.ok(groups.some((r) => r.model_id === "model-A" && Number(r.dim) === 768), JSON.stringify(groups));
    assert.ok(calls.some((c) => c.inputType === "document"), "document input_type used for storage: " + JSON.stringify(calls.map((c) => c.inputType)));
    // avoid cache staleness: invalidate after phase change
    if (v.invalidateEmbedHealthCache) v.invalidateEmbedHealthCache();
    phase = "B";
    if (v.invalidateEmbedHealthCache) v.invalidateEmbedHealthCache();
    const r = v.reindexVectors({ forceModelSync: true });
    if (r && r.promise) await r.promise;
    await new Promise((rr) => setTimeout(rr, 200));
    groups = countGroups();
    assert.ok(groups.every((g) => g.model_id === "model-B"), JSON.stringify(groups));
    assert.ok(groups.some((g) => Number(g.dim) === 1024), JSON.stringify(groups));
    // switch to same-dim different model C must also reindex (no prefix reuse)
    if (v.invalidateEmbedHealthCache) v.invalidateEmbedHealthCache();
    phase = "C";
    if (v.invalidateEmbedHealthCache) v.invalidateEmbedHealthCache();
    const r2 = v.reindexVectors({ forceModelSync: true });
    if (r2 && r2.promise) await r2.promise;
    await new Promise((rr) => setTimeout(rr, 200));
    groups = countGroups();
    assert.ok(groups.every((g) => g.model_id === "model-C"), JSON.stringify(groups));
    assert.ok(groups.some((g) => Number(g.dim) === 768), JSON.stringify(groups));
    // query path uses input_type query
    calls.length = 0;
    v.listMemories({ projectRoot: proj, query: "cache hit" });
    assert.ok(calls.some((c) => c.inputType === "query"), "query input_type used: " + JSON.stringify(calls));
    // getStats shape
    assert.equal(typeof v.getStats, "function");
    const stats = v.getStats();
    assert.ok(stats.vectorStats, JSON.stringify(stats));
    assert.equal(stats.vectorStats.activeModelId, "model-C");
    assert.equal(typeof stats.vectorStats.totalMemories, "number");
    assert.equal(typeof stats.vectorStats.syncedVectors, "number");
    assert.equal(typeof stats.vectorStats.reindexing, "boolean");
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe("embed-server.py static contract", () => {
  it("defaults to Qwen3 8bit with rss and prefix requirements", () => {
    const py = readPy();
    assert.ok(py.includes('os.environ.get("EMBED_MODEL", "mlx-community/Qwen3-Embedding-0.6B-8bit")'), "default model");
    assert.ok(py.includes('os.environ.get("EMBED_NAME", "Qwen3-Embedding-0.6B-8bit")'), "default name");
    assert.ok(py.includes("def _get_peak_rss_mb"), "peak rss fn");
    assert.ok(py.includes('ps", "-o", "rss="'), "ps rss priority");
    assert.ok(py.includes('"peakRssMb"') || py.includes("'peakRssMb'") || py.includes("peakRssMb"), "health peakRssMb");
    assert.ok(py.includes("input_type"), "input_type field");
    assert.ok(py.includes("def _format_inputs_for_model"), "format fn");
    assert.ok(py.includes("Instruct: Given a software engineering search query"), "qwen query prefix");
    assert.ok(py.includes("task: search result | query:"), "embeddinggemma query");
    assert.ok(py.includes("search_query:"), "modernbert query");
    assert.ok(py.includes("title: none | text:"), "embeddinggemma doc");
    assert.ok(py.includes("search_document:"), "modernbert doc");
  });
  it("hub-drawer-ui.js parses", () => {
    execFileSync("node", ["-c", path.join(REPO, "src", "hub-drawer-ui.js")], { encoding: "utf8" });
  });
});
