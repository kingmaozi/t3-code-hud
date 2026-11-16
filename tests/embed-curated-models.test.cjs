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
  "mlx-community/Octen-Embedding-4B-MLX-4bit",
  "mlx-community/Qwen3-Embedding-4B-4bit-DWQ",
  "chulcher/Octen-Embedding-8B-mlx",
  "mlx-community/Qwen3-Embedding-8B-4bit-DWQ",
  "Qwen/Qwen3-Embedding-0.6B",
  "mlx-community/bge-m3-mlx-fp16",
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
  it("contains 17 presets without 404 bge-small", () => {
    assert.equal(PRESETS.length, 17, "got " + PRESETS.length);
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
      assert.ok(["compact", "standard", "workstation", "flagship", "any"].includes(p.idealRamTier), "idealRamTier " + p.id);
      assert.ok(Array.isArray(p.tags) && p.tags.length, "tags " + p.id);
      assert.ok(p.desc, "desc " + p.id);
      assert.ok(p.description, "description compat " + p.id);
      assert.ok(p.mode, "mode compat " + p.id);
    }
    const byId = Object.fromEntries(PRESETS.map((p) => [p.id, p]));
    assert.equal(byId["mlx-community/Octen-Embedding-4B-MLX-4bit"].sizeMb, 2260);
    assert.equal(byId["mlx-community/Octen-Embedding-4B-MLX-4bit"].estRamMb, 2250);
    assert.equal(byId["mlx-community/Octen-Embedding-4B-MLX-4bit"].ceilingMb, 3060);
    assert.equal(byId["mlx-community/Octen-Embedding-4B-MLX-4bit"].dim, 2560);
    assert.equal(byId["mlx-community/Octen-Embedding-4B-MLX-4bit"].minRamGb, 32);
    assert.equal(byId["mlx-community/Octen-Embedding-4B-MLX-4bit"].idealRamTier, "flagship");
    assert.equal(byId["mlx-community/Octen-Embedding-4B-MLX-4bit"].tier, "flagship");
    assert.equal(byId["mlx-community/Octen-Embedding-4B-MLX-4bit"].arch, "octen");
    assert.equal(byId["mlx-community/Octen-Embedding-4B-MLX-4bit"].label, "Octen Embedding 4B · 4-bit（最高质价比冠军）");
    assert.ok(byId["mlx-community/Octen-Embedding-4B-MLX-4bit"].tags.some((t) => t.includes("RTEB 76.8")));
    assert.ok(byId["mlx-community/Octen-Embedding-4B-MLX-4bit"].desc.includes("RTEB 76.8"));
    assert.ok(byId["mlx-community/Octen-Embedding-4B-MLX-4bit"].desc.includes("代码81.2"));
    assert.ok(byId["mlx-community/Octen-Embedding-4B-MLX-4bit"].desc.includes("M3 Ultra ~10ms"));
    assert.equal(byId["mlx-community/Qwen3-Embedding-4B-4bit-DWQ"].sizeMb, 2080);
    assert.equal(byId["mlx-community/Qwen3-Embedding-4B-4bit-DWQ"].estRamMb, 2150);
    assert.equal(byId["mlx-community/Qwen3-Embedding-4B-4bit-DWQ"].dim, 2560);
    assert.equal(byId["mlx-community/Qwen3-Embedding-4B-4bit-DWQ"].minRamGb, 64);
    assert.equal(byId["mlx-community/Qwen3-Embedding-4B-4bit-DWQ"].idealRamTier, "flagship");
    assert.equal(byId["mlx-community/Qwen3-Embedding-4B-4bit-DWQ"].arch, "qwen3");
    assert.equal(byId["chulcher/Octen-Embedding-8B-mlx"].dim, 4096);
    assert.equal(byId["chulcher/Octen-Embedding-8B-mlx"].minRamGb, 64);
    assert.equal(byId["chulcher/Octen-Embedding-8B-mlx"].idealRamTier, "flagship");
    assert.ok(byId["chulcher/Octen-Embedding-8B-mlx"].tags.concat(byId["chulcher/Octen-Embedding-8B-mlx"].desc).join(" ").includes("RTEB 80.5"));
    assert.ok(byId["chulcher/Octen-Embedding-8B-mlx"].desc.includes("开源第1"));
    assert.equal(byId["mlx-community/Qwen3-Embedding-8B-4bit-DWQ"].dim, 4096);
    assert.equal(byId["mlx-community/Qwen3-Embedding-8B-4bit-DWQ"].minRamGb, 64);
    assert.ok(byId["mlx-community/Qwen3-Embedding-8B-4bit-DWQ"].sizeMb > 0);
    assert.equal(byId["Qwen/Qwen3-Embedding-0.6B"].sizeMb, 1150);
    assert.equal(byId["Qwen/Qwen3-Embedding-0.6B"].estRamMb, 1200);
    assert.equal(byId["Qwen/Qwen3-Embedding-0.6B"].dim, 1024);
    assert.equal(byId["Qwen/Qwen3-Embedding-0.6B"].minRamGb, 32);
    assert.equal(byId["Qwen/Qwen3-Embedding-0.6B"].idealRamTier, "flagship");
    assert.equal(byId["Qwen/Qwen3-Embedding-0.6B"].arch, "qwen3");
    assert.equal(byId["mlx-community/bge-m3-mlx-fp16"].sizeMb, 1100);
    assert.equal(byId["mlx-community/bge-m3-mlx-fp16"].dim, 1024);
    assert.equal(byId["mlx-community/bge-m3-mlx-fp16"].arch, "xlm-roberta");
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
    assert.equal(byId["mlx-community/embeddinggemma-2-8bit"].estRamMb, 1220);
    assert.equal(byId["mlx-community/embeddinggemma-2-8bit"].label, "EmbeddingGemma 2 · 8-bit (Google 2026最新)");
    assert.deepEqual(byId["mlx-community/embeddinggemma-2-8bit"].tags, ["Google 2026最新", "代码极强 78.7", "图文音多模态"]);
    assert.ok(byId["mlx-community/embeddinggemma-2-8bit"].desc.includes("代码检索 78.7"));
    assert.ok(byId["mlx-community/embeddinggemma-2-8bit"].desc.includes("FTS5"));
    assert.equal(byId["fts5-zero-ram"].dim, 0);
    assert.equal(byId["fts5-zero-ram"].sizeMb, 0);
  });
});

describe("detectHardwareProfile tiers", () => {
  it("recommends flagship / workstation / standard / compact by RAM", () => {
    const h96 = detectHardwareProfile({ totalRamGb: 96, chipModel: "Apple M3 Ultra" });
    assert.equal(h96.totalRamGb, 96);
    assert.equal(h96.chipModel, "Apple M3 Ultra");
    assert.equal(h96.tier, "flagship");
    assert.equal(h96.primaryModelId, "mlx-community/Octen-Embedding-4B-MLX-4bit");
    assert.match(h96.recommendReason, /96 GB/);
    assert.match(h96.recommendReason, /旗舰/);
    assert.match(h96.recommendReason, /Octen-Embedding-4B-MLX-4bit/);
    assert.match(h96.recommendReason, /RTEB 76\.8 \(4B第1\)/);
    assert.ok(h96.recommendReason.includes("代码81.2") && h96.recommendReason.includes("M3 Ultra ~10ms"), "champion stats in reason");
    assert.match(h96.recommendReason, /Qwen3-Embedding-4B-4bit-DWQ/);
    assert.ok(Array.isArray(h96.secondaryModelIds));
    assert.ok(h96.secondaryModelIds.includes("mlx-community/Qwen3-Embedding-4B-4bit-DWQ"), "Qwen4B dual-flagship secondary");
    assert.ok(h96.secondaryModelIds.includes("Qwen/Qwen3-Embedding-0.6B"));
    assert.ok(h96.secondaryModelIds.includes("mlx-community/Qwen3-Embedding-0.6B-8bit"));
    assert.ok(h96.secondaryModelIds.includes("mlx-community/embeddinggemma-2-8bit"));

    const h64 = detectHardwareProfile({ totalRamGb: 64, chipModel: "Apple M3 Max" });
    assert.equal(h64.tier, "flagship");
    assert.equal(h64.primaryModelId, "mlx-community/Octen-Embedding-4B-MLX-4bit");
    const h64CachedQwen = detectHardwareProfile({ totalRamGb: 64, chipModel: "Apple M3 Max", cachedModelIds: ["mlx-community/Qwen3-Embedding-4B-4bit-DWQ"] });
    assert.equal(h64CachedQwen.primaryModelId, "mlx-community/Qwen3-Embedding-4B-4bit-DWQ", "cached flagship wins for zero-download switch");
    assert.ok(h64CachedQwen.secondaryModelIds.includes("mlx-community/Octen-Embedding-4B-MLX-4bit"));
    const h64CachedOcten = detectHardwareProfile({ totalRamGb: 64, chipModel: "Apple M3 Max", cachedModelIds: ["mlx-community/Octen-Embedding-4B-MLX-4bit"] });
    assert.equal(h64CachedOcten.primaryModelId, "mlx-community/Octen-Embedding-4B-MLX-4bit");

    const h32 = detectHardwareProfile({ totalRamGb: 32, chipModel: "Apple M2 Pro" });
    assert.equal(h32.tier, "workstation");
    assert.equal(h32.primaryModelId, "mlx-community/Qwen3-Embedding-0.6B-8bit");
    assert.ok(h32.secondaryModelIds.includes("Qwen/Qwen3-Embedding-0.6B"));
    assert.ok(h32.secondaryModelIds.includes("mlx-community/bge-m3-mlx-8bit"));

    const h16 = detectHardwareProfile({ totalRamGb: 16, chipModel: "Apple M1" });
    assert.equal(h16.tier, "standard");
    assert.equal(h16.primaryModelId, "mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ");
    assert.ok(h16.secondaryModelIds.includes("mlx-community/bge-m3-mlx-4bit"));

    const h8 = detectHardwareProfile({ totalRamGb: 8, chipModel: "Apple M1" });
    assert.equal(h8.tier, "compact");
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
    assert.equal(st.hardware.primaryModelId, "mlx-community/Octen-Embedding-4B-MLX-4bit");
    const primary = st.presets.find((p) => p.id === st.hardware.primaryModelId);
    assert.equal(primary.recommended, true);
    assert.match(primary.recommendBadge, /本机 96GB 首选/);
    const qwen4b = st.presets.find((p) => p.id === "mlx-community/Qwen3-Embedding-4B-4bit-DWQ");
    assert.equal(qwen4b.secondaryRecommended, true);
    assert.ok(qwen4b.recommendBadge.includes("旗舰顶配"), "dual flagship badge: " + qwen4b.recommendBadge);
    const octen8b = st.presets.find((p) => p.id === "chulcher/Octen-Embedding-8B-mlx");
    assert.ok(octen8b.recommendBadge.includes("8B极限档"));
    const heavy = st.presets.find((p) => p.id === "mlx-community/embeddinggemma-2-8bit");
    assert.equal(heavy.recommendBadge, "偏重·含多模态塔");
    const bge = st.presets.find((p) => p.id === "mlx-community/bge-m3-mlx-8bit");
    assert.equal(bge.recommendBadge, "稳健双语");
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  it("getStatus prefers cached Qwen4B over uncached Octen4B (zero-download switch)", () => {
    const tmp = mkTmp("emb-cached-flag-");
    const hubDir = path.join(tmp, "hub");
    const cacheDir = path.join(tmp, "cache");
    // Only Qwen4B cached on disk (complete HF snapshots layout); Octen4B not cached.
    // isModelCached requires non-empty config.json + non-empty model.safetensors
    // under snapshots/<rev>/ (refs/main authoritative when present).
    const safe = "models--mlx-community--Qwen3-Embedding-4B-4bit-DWQ";
    const snap = path.join(cacheDir, safe, "snapshots", "rev1");
    fs.mkdirSync(snap, { recursive: true });
    fs.writeFileSync(path.join(snap, "config.json"), JSON.stringify({ model_type: "qwen3" }), "utf8");
    fs.writeFileSync(path.join(snap, "model.safetensors"), "1234");
    fs.mkdirSync(path.join(cacheDir, safe, "refs"), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, safe, "refs", "main"), "rev1");
    const mgr = createEmbedManager({
      homeDir: tmp, hubDir, cacheDir,
      port: 18114, launchAgentPlistPath: null,
      totalRamGb: 96, chipModel: "Apple M3 Ultra",
    });
    const st = mgr.getStatus();
    assert.equal(st.hardware.primaryModelId, "mlx-community/Qwen3-Embedding-4B-4bit-DWQ", "cached Qwen must win");
    const qwen = st.presets.find((p) => p.id === "mlx-community/Qwen3-Embedding-4B-4bit-DWQ");
    assert.equal(qwen.downloaded, true);
    assert.equal(qwen.recommended, true);
    const octen = st.presets.find((p) => p.id === "mlx-community/Octen-Embedding-4B-MLX-4bit");
    assert.equal(octen.downloaded, false);
    assert.equal(octen.secondaryRecommended, true);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe("isModelCached hub layouts", () => {
  it("recognizes complete HF snapshots; blobs-only or configless caches are incomplete", () => {
    const tmp = mkTmp("emb-cache-");
    try {
      const cacheDir = path.join(tmp, "cache");
      const model = "mlx-community/Qwen3-Embedding-0.6B-8bit";
      const safe = "models--" + model.replace(/\//g, "--");
      const { isModelCached } = embedMgrMod;
      const writeCompleteSingle = (rev) => {
        const snap = path.join(cacheDir, safe, "snapshots", rev);
        fs.mkdirSync(snap, { recursive: true });
        fs.writeFileSync(path.join(snap, "config.json"), JSON.stringify({ model_type: "qwen3" }), "utf8");
        fs.writeFileSync(path.join(snap, "model.safetensors"), "1234");
        fs.mkdirSync(path.join(cacheDir, safe, "refs"), { recursive: true });
        fs.writeFileSync(path.join(cacheDir, safe, "refs", "main"), rev);
      };
      const reset = () => { fs.rmSync(cacheDir, { recursive: true, force: true }); };

      // complete: snapshots/<rev>/config.json + model.safetensors, refs/main -> rev
      writeCompleteSingle("rev123");
      assert.equal(isModelCached(model, cacheDir, tmp), true, "complete snapshots layout");
      reset();

      // complete sharded weights: config.json + index.json + all shards non-empty
      {
        const snap = path.join(cacheDir, safe, "snapshots", "revSharded");
        fs.mkdirSync(snap, { recursive: true });
        fs.writeFileSync(path.join(snap, "config.json"), JSON.stringify({ model_type: "qwen3" }), "utf8");
        fs.writeFileSync(path.join(snap, "model-00001-of-00002.safetensors"), "1234");
        fs.writeFileSync(path.join(snap, "model-00002-of-00002.safetensors"), "5678");
        fs.writeFileSync(path.join(snap, "model.safetensors.index.json"),
          JSON.stringify({ weight_map: { "w0": "model-00001-of-00002.safetensors", "w1": "model-00002-of-00002.safetensors" } }), "utf8");
        fs.mkdirSync(path.join(cacheDir, safe, "refs"), { recursive: true });
        fs.writeFileSync(path.join(cacheDir, safe, "refs", "main"), "revSharded");
        assert.equal(isModelCached(model, cacheDir, tmp), true, "sharded index layout");
      }
      reset();

      // safety contract: blobs/ alone never counts as cached
      fs.mkdirSync(path.join(cacheDir, safe, "blobs"), { recursive: true });
      fs.writeFileSync(path.join(cacheDir, safe, "blobs", "blob1"), "1234");
      assert.equal(isModelCached(model, cacheDir, tmp), false, "blobs-only must be false");
      reset();

      // weights without config.json are incomplete (prevent premature start)
      fs.mkdirSync(path.join(cacheDir, safe, "snapshots", "revNoCfg"), { recursive: true });
      fs.writeFileSync(path.join(cacheDir, safe, "snapshots", "revNoCfg", "model.safetensors"), "1234");
      assert.equal(isModelCached(model, cacheDir, tmp), false, "missing config.json must be false");
      reset();

      // empty config.json (0 bytes) is incomplete
      fs.mkdirSync(path.join(cacheDir, safe, "snapshots", "revEmptyCfg"), { recursive: true });
      fs.writeFileSync(path.join(cacheDir, safe, "snapshots", "revEmptyCfg", "config.json"), "");
      fs.writeFileSync(path.join(cacheDir, safe, "snapshots", "revEmptyCfg", "model.safetensors"), "1234");
      assert.equal(isModelCached(model, cacheDir, tmp), false, "empty config.json must be false");
      reset();

      // empty snapshots dirs -> false
      fs.mkdirSync(path.join(cacheDir, safe, "snapshots", "revEmpty"), { recursive: true });
      assert.equal(isModelCached(model, cacheDir, tmp), false, "empty snapshots must be false");
      reset();

      // refs/main authoritative: incomplete main must not fall back to a complete stale snapshot
      writeCompleteSingle("revGood");
      writeCompleteSingle("revBad");
      fs.writeFileSync(path.join(cacheDir, safe, "snapshots", "revBad", "model.safetensors"), "");
      fs.writeFileSync(path.join(cacheDir, safe, "refs", "main"), "revBad");
      assert.equal(isModelCached(model, cacheDir, tmp), false, "incomplete refs/main must be false");
      reset();

      // missing entirely -> false
      assert.equal(isModelCached(model, cacheDir, tmp), false, "missing cache must be false");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
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
    assert.ok(after.includes("HF_HUB_DISABLE_XET"), "plist must pin HF_HUB_DISABLE_XET for Xet 0B fix: " + after);
    assert.ok(after.includes("<string>1</string>"), "plist XET value 1: " + after);
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
  it("disables HF XET and pins HF_HUB_DISABLE_XET across manager + server + install.sh", () => {
    const py = readPy();
    assert.ok(py.includes('os.environ.setdefault("HF_HUB_DISABLE_XET", "1")'), "server must disable XET before HF import");
    const mgrSrc = fs.readFileSync(path.join(REPO, "src", "embed-manager.cjs"), "utf8");
    assert.ok(mgrSrc.includes('HF_HUB_DISABLE_XET'), "manager must reference HF_HUB_DISABLE_XET");
    assert.ok(mgrSrc.includes('HF_HUB_DISABLE_XET: "1"'), "manager subprocess env must pin XET=1");
    assert.ok(mgrSrc.includes("os.environ.setdefault('HF_HUB_DISABLE_XET','1')") || mgrSrc.includes('os.environ.setdefault("HF_HUB_DISABLE_XET","1")'), "download snippet must setdefault XET=1");
    const sh = fs.readFileSync(path.join(REPO, "install.sh"), "utf8");
    assert.ok(sh.includes('os.environ.setdefault("HF_HUB_DISABLE_XET", "1")'), "install.sh template must disable XET");
    assert.ok(sh.includes("HF_HUB_DISABLE_XET"), "install.sh plist patch must mention XET");
    // byte-identical template check
    const delim = "T3_EMBED_SERVER_PY_EOF";
    const start = sh.indexOf("<<'" + delim + "'");
    assert.ok(start !== -1, "heredoc start found");
    const bodyStart = sh.indexOf("\n", start) + 1;
    const rest = sh.slice(bodyStart);
    const m2 = rest.match(new RegExp("^" + delim + "\\s*$", "m"));
    assert.ok(m2, "heredoc end found");
    const tpl = rest.slice(0, m2.index);
    assert.equal(tpl, py, "src/embed-server.py must equal install.sh template byte-identical");
  });
  it("defaults to Qwen3 8bit with rss and prefix requirements", () => {
    const py = readPy();
    assert.ok(py.includes('os.environ.get("EMBED_MODEL", "mlx-community/Qwen3-Embedding-0.6B-8bit")'), "default model");
    assert.ok(py.includes('os.environ.get("EMBED_NAME", "Qwen3-Embedding-0.6B-8bit")'), "default name");
    assert.ok(py.includes("def _get_peak_rss_mb"), "peak rss fn");
    assert.ok(py.includes('ps", "-o", "rss="'), "ps rss priority");
    assert.ok(py.includes('"peakRssMb"') || py.includes("'peakRssMb'") || py.includes("peakRssMb"), "health peakRssMb");
    assert.ok(py.includes("mx.get_active_memory() / (1024 * 1024)"), "active memory formula");
    assert.ok(py.includes('"activeMb"') || py.includes("'activeMb'"), "health activeMb");
    assert.ok(py.includes('"processRssMb"') || py.includes("'processRssMb'") || py.includes("processRssMb"), "health processRssMb");
    assert.ok(py.includes("embed-config.json"), "startup config override path");
    assert.ok(py.includes("T3_EMBED_FORCE_ENV"), "force env guard");
    assert.ok(py.includes("T3_EMBED_IGNORE_CONFIG"), "ignore config guard");
    assert.ok(py.includes('cfg.get("mode") != "mlx"') || py.includes('cfg.get("mode")') || py.includes('"mlx"'), "mode mlx check");
    assert.ok(py.includes("input_type"), "input_type field");
    assert.ok(py.includes("def _format_inputs_for_model"), "format fn");
    assert.ok(py.includes("Instruct: Given a software engineering search query"), "qwen query prefix");
    assert.ok(py.includes("task: search result | query:"), "embeddinggemma query");
    assert.ok(py.includes("search_query:"), "modernbert query");
    assert.ok(py.includes("title: none | text:"), "embeddinggemma doc");
    assert.ok(py.includes("search_document:"), "modernbert doc");
  });
  it("switch-model releases old model before loading and recovers on failure", () => {
    const py = readPy();
    assert.ok(py.includes("old_model_id"), "old_model_id recovery");
    assert.ok(py.includes('state["model"] = None'), "release model");
    assert.ok(py.includes("gc.collect()"), "gc collect before load");
    assert.ok(py.includes("mx.clear_cache()"), "clear cache before load");
    const swapSlice = py.slice(py.indexOf("def _swap"));
    const releaseIdx = swapSlice.indexOf('state["model"] = None');
    const loadIdx = swapSlice.indexOf("_load_model_sync(model_id)");
    assert.ok(releaseIdx > 0 && loadIdx > 0 && releaseIdx < loadIdx, "release must precede load");
    assert.ok(py.includes("_load_model_sync(old_model_id)"), "reload old on failure");
  });
  it("hub-drawer-ui.js parses", () => {
    execFileSync("node", ["-c", path.join(REPO, "src", "hub-drawer-ui.js")], { encoding: "utf8" });
  });
});
