"use strict";
// Focused durable coverage for embed-manager root causes A/B/C:
// health truth (B), MLX active-memory priority (C), launchagent bootout order (A).
// healthSync() uses spawnSync("curl"), which blocks the event loop, so the stub
// is a PATH curl shim rather than an in-process HTTP server.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..");
const { createEmbedManager, validateModelId } = require(path.join(REPO, "src", "embed-manager.cjs"));

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function writeConfig(hubDir, cfg) {
  fs.mkdirSync(hubDir, { recursive: true });
  fs.writeFileSync(path.join(hubDir, "embed-config.json"), JSON.stringify(cfg, null, 2) + "\n", "utf8");
}
function installFakeCurl(tmp, healthPayload, switchPayload) {
  const binDir = path.join(tmp, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const healthFile = path.join(tmp, "health.json");
  const switchFile = path.join(tmp, "switch.json");
  fs.writeFileSync(healthFile, JSON.stringify(healthPayload), "utf8");
  fs.writeFileSync(switchFile, JSON.stringify(switchPayload || { ok: true }), "utf8");
  const script = path.join(binDir, "curl");
  const content =
    "#!/bin/sh\n" +
    'for a in "$@"; do case "$a" in *admin/switch-model*) exec cat "' + switchFile + '";; esac; done\n' +
    'exec cat "' + healthFile + '"\n';
  fs.writeFileSync(script, content, "utf8");
  fs.chmodSync(script, 0o755);
  const origPath = process.env.PATH;
  process.env.PATH = binDir + path.delimiter + (origPath || "");
  let restored = false;
  return function restore() {
    if (!restored) {
      process.env.PATH = origPath;
      restored = true;
    }
  };
}

describe("validateModelId accepts Qwen org flagship preset", () => {
  it("allows Qwen/Qwen3-Embedding-0.6B", () => {
    const tmp = mkTmp("emb-validate-");
    try {
      const r = validateModelId("Qwen/Qwen3-Embedding-0.6B", tmp);
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.kind, "hf");
      assert.equal(r.value, "Qwen/Qwen3-Embedding-0.6B");
      const r2 = validateModelId("mlx-community/Qwen3-Embedding-4B-4bit-DWQ", tmp);
      assert.equal(r2.ok, true, JSON.stringify(r2));
      const r3 = validateModelId("mlx-community/bge-m3-mlx-fp16", tmp);
      assert.equal(r3.ok, true, JSON.stringify(r3));
      const rOcten = validateModelId("mlx-community/Octen-Embedding-4B-MLX-4bit", tmp);
      assert.equal(rOcten.ok, true, JSON.stringify(rOcten));
      assert.equal(rOcten.kind, "hf");
      const rOcten8 = validateModelId("chulcher/Octen-Embedding-8B-mlx", tmp);
      assert.equal(rOcten8.ok, true, JSON.stringify(rOcten8));
      const rQ8 = validateModelId("mlx-community/Qwen3-Embedding-8B-4bit-DWQ", tmp);
      assert.equal(rQ8.ok, true, JSON.stringify(rQ8));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("getStatus health truth and memory priority", () => {
  it("prefers real health modelId and activeMb over config and RSS", () => {
    const tmp = mkTmp("emb-status-");
    const hubDir = path.join(tmp, "hub");
    const cfgModel = "mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ";
    const healthModel = "mlx-community/Qwen3-Embedding-4B-4bit-DWQ";
    writeConfig(hubDir, { mode: "mlx", modelId: cfgModel });
    const restore = installFakeCurl(tmp, {
      ok: true,
      modelId: healthModel,
      model_id: healthModel,
      activeMb: 2080,
      active_mb: 2080,
      rssMb: 3000,
      rss_mb: 3000,
      processRssMb: 3000,
    });
    try {
      const mgr = createEmbedManager({
        homeDir: tmp, hubDir, cacheDir: path.join(tmp, "cache"),
        port: 18121, launchAgentPlistPath: null,
        totalRamGb: 96, chipModel: "Apple M3 Ultra",
      });
      const st = mgr.getStatus();
      assert.equal(st.running, true);
      assert.equal(st.activeModelId, healthModel, "must trust :8001 health truth");
      assert.equal(st.configuredModelId, cfgModel);
      assert.equal(st.switching, true, "health differs from cfg mlx must flag switching");
      assert.equal(st.mode, "mlx");
      assert.equal(st.rssMb, 2080, "MLX active memory wins over inflated RSS");
      assert.equal(st.processRssMb, 3000, "total process RSS preserved separately");
    } finally {
      restore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("falls back to config and rssMb when health has no modelId/activeMb", () => {
    const tmp = mkTmp("emb-status2-");
    const hubDir = path.join(tmp, "hub");
    const cfgModel = "mlx-community/Qwen3-Embedding-0.6B-8bit";
    writeConfig(hubDir, { mode: "mlx", modelId: cfgModel });
    const restore = installFakeCurl(tmp, { ok: true, rssMb: 275 });
    try {
      const mgr = createEmbedManager({
        homeDir: tmp, hubDir, cacheDir: path.join(tmp, "cache"),
        port: 18122, launchAgentPlistPath: null,
      });
      const st = mgr.getStatus();
      assert.equal(st.running, true);
      assert.equal(st.activeModelId, cfgModel, "mock without modelId must fall back to cfg");
      assert.equal(st.configuredModelId, cfgModel);
      assert.equal(st.switching, false);
      assert.equal(st.rssMb, 275, "fallback to rssMb when activeMb absent");
      assert.equal(st.processRssMb, 275);
    } finally {
      restore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("uses active_mb snake key and model_id snake key", () => {
    const tmp = mkTmp("emb-status3-");
    const hubDir = path.join(tmp, "hub");
    const cfgModel = "mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ";
    writeConfig(hubDir, { mode: "mlx", modelId: cfgModel });
    const restore = installFakeCurl(tmp, {
      ok: true,
      model_id: cfgModel,
      active_mb: 335,
      rssMb: 2112,
      rss_mb: 2112,
    });
    try {
      const mgr = createEmbedManager({
        homeDir: tmp, hubDir, cacheDir: path.join(tmp, "cache"),
        port: 18123, launchAgentPlistPath: null,
      });
      const st = mgr.getStatus();
      assert.equal(st.activeModelId, cfgModel);
      assert.equal(st.switching, false, "same model is not switching");
      assert.equal(st.rssMb, 335, "335MB MLX memory must not be inflated to 2112MB");
      assert.equal(st.processRssMb, 2112);
    } finally {
      restore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("switchModel launchagent bootout order", () => {
  it("boots out stale service before refreshing MLX plist", () => {
    const tmp = mkTmp("emb-boot-");
    const hubDir = path.join(tmp, "hub");
    const cacheDir = path.join(tmp, "cache");
    const plistPath = path.join(tmp, "com.t3tools.powercontext-embed.plist");
    const PLIST = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>com.t3tools.powercontext-embed</string><key>KeepAlive</key><true/><key>EnvironmentVariables</key><dict><key>EMBED_MODEL</key><string>mlx-community/embeddinggemma-2-8bit</string><key>EMBED_NAME</key><string>embeddinggemma-2-8bit</string></dict></dict></plist>`;
    fs.writeFileSync(plistPath, PLIST, "utf8");
    const target = "mlx-community/Qwen3-Embedding-0.6B-8bit";
    const safe = "models--" + target.replace(/\//g, "--");
    // Complete HF snapshot fixture: isModelCached requires non-empty config.json
    // + non-empty model.safetensors (refs/main authoritative when present).
    // Isolation: homeDir/hubDir/cacheDir/plist all under os.tmpdir(), port 18124
    // (never the real :8001), fake curl shim on PATH, mocked _launchctl — so any
    // switchModel service/download call stays in temp dirs and never touches
    // the real embed server or ~/.t3.
    const snap = path.join(cacheDir, safe, "snapshots", "rev1");
    fs.mkdirSync(snap, { recursive: true });
    fs.writeFileSync(path.join(snap, "config.json"), JSON.stringify({ model_type: "qwen3" }), "utf8");
    fs.writeFileSync(path.join(snap, "model.safetensors"), "1234", "utf8");
    fs.mkdirSync(path.join(cacheDir, safe, "refs"), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, safe, "refs", "main"), "rev1", "utf8");
    const restore = installFakeCurl(tmp, {
      ok: true, modelId: target, model_id: target,
      activeMb: 620, active_mb: 620, rssMb: 620,
    }, { ok: true });
    const bootContent = [];
    const bootstrapContent = [];
    try {
      const mgr = createEmbedManager({
        homeDir: tmp, hubDir, cacheDir,
        port: 18124, launchAgentPlistPath: plistPath,
        _launchctl: (args) => {
          if (args[0] === "bootout") bootContent.push(fs.readFileSync(plistPath, "utf8"));
          if (args[0] === "bootstrap") bootstrapContent.push(fs.readFileSync(plistPath, "utf8"));
          return { status: 0 };
        },
      });
      // Pin isolation: mock port (never real :8001) and all state under temp dirs.
      assert.equal(mgr.port, 18124, "must use mock port, never :8001");
      assert.ok(String(mgr.cacheDir).startsWith(os.tmpdir()), "cacheDir must stay under tmp: " + mgr.cacheDir);
      assert.ok(String(mgr.homeDir).startsWith(os.tmpdir()), "homeDir must stay under tmp: " + mgr.homeDir);
      assert.ok(String(mgr.launchAgentPlistPath).startsWith(os.tmpdir()), "plist must stay under tmp: " + mgr.launchAgentPlistPath);
      const sw = mgr.switchModel({ mode: "mlx", modelId: target });
      assert.equal(sw.ok, true, JSON.stringify(sw));
      assert.ok(bootContent.length === 1, "bootout must run for MLX switch");
      assert.ok(bootContent[0].includes("embeddinggemma-2-8bit"), "bootout must happen while plist still holds stale model");
      assert.ok(!bootContent[0].includes("Qwen3-Embedding-0.6B-8bit") || bootContent[0].includes("embeddinggemma-2-8bit"), "bootout precedes file refresh");
      const after = fs.readFileSync(plistPath, "utf8");
      assert.ok(after.includes("Qwen3-Embedding-0.6B-8bit"), "plist refreshed after bootout");
      assert.ok(after.includes("HF_HUB_DISABLE_XET"), "plist must pin HF_HUB_DISABLE_XET: " + after);
      assert.ok(bootstrapContent.length === 1, "bootstrap must run after refresh");
      assert.ok(bootstrapContent[0].includes("Qwen3-Embedding-0.6B-8bit"), "bootstrap sees refreshed plist");
    } finally {
      restore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
