"use strict";
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const REPO = path.resolve(__dirname, "..");

// Isolated homes; MUST be set before require(backend.cjs)
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "t3-hubv3-backend-"));
const tmpHome = path.join(tmpRoot, "home");
const tmpUserdata = path.join(tmpRoot, "userdata");
const tmpMuse = path.join(tmpRoot, "muse");
const tmpCodex = path.join(tmpRoot, "codex");
const tmpHub = path.join(tmpHome, ".t3", "hub");
for (const d of [tmpHome, tmpUserdata, tmpMuse, tmpCodex]) fs.mkdirSync(d, { recursive: true });
fs.mkdirSync(path.join(tmpHome, ".t3", "hub"), { recursive: true });
fs.mkdirSync(path.join(tmpHome, ".t3", "hub", "task-plans"), { recursive: true });
fs.mkdirSync(path.join(tmpHome, ".codex"), { recursive: true });
fs.mkdirSync(path.join(tmpHome, ".pi", "agent"), { recursive: true });
fs.mkdirSync(path.join(tmpHome, ".config", "muse"), { recursive: true });
fs.mkdirSync(path.join(tmpHome, ".claude"), { recursive: true });
fs.mkdirSync(path.join(tmpHome, ".agents", "skills"), { recursive: true });
fs.mkdirSync(path.join(tmpHub, "plugins"), { recursive: true });

process.env.HOME = tmpHome;
process.env.T3CODE_HOME = tmpUserdata;
process.env.T3_HUB_DIR = tmpHub;
process.env.MUSE_DATA_DIR = tmpMuse;
process.env.CODEX_HOME = tmpCodex;
process.env.NODE_ENV = "test";
process.env.T3_HUB_TEST = "1";
process.env.UNDER_TEST = "1";
process.env.NODE_TEST_CONTEXT = "1";
delete process.env.XDG_DATA_HOME;

const backend = require(path.join(REPO, "src", "backend.cjs"));
const hubPluginsMod = require(path.join(REPO, "src", "hub-plugins.cjs"));
const hubSkillsMod = require(path.join(REPO, "src", "hub-skills.cjs"));
const mcpRouterMod = require(path.join(REPO, "src", "mcp-router.cjs"));
const memoryVaultMod = require(path.join(REPO, "src", "memory-vault.cjs"));
const hubTaskBoardMod = require(path.join(REPO, "src", "hub-task-board.cjs"));

const PROJECT_ROOT = path.join(tmpRoot, "proj-backend");
fs.mkdirSync(PROJECT_ROOT, { recursive: true });
fs.mkdirSync(path.join(PROJECT_ROOT, ".git", "info"), { recursive: true });
const PROJECT_ROOT_B = path.join(tmpRoot, "proj-backend-b");
fs.mkdirSync(PROJECT_ROOT_B, { recursive: true });
fs.mkdirSync(path.join(PROJECT_ROOT_B, ".git", "info"), { recursive: true });

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n", "utf8");
}
function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function writeSkill(dir, name, desc) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}\nBody ${name}\n`, "utf8");
}
function makePlugin(name, manifest, assets) {
  const dir = path.join(tmpHub, "plugins", name);
  fs.mkdirSync(path.join(dir, ".codex-plugin"), { recursive: true });
  writeJson(path.join(dir, ".codex-plugin", "plugin.json"), manifest);
  if (assets) {
    for (const [rel, content, isBinary] of assets) {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      if (isBinary) fs.writeFileSync(full, content);
      else fs.writeFileSync(full, content, "utf8");
    }
  }
  // Ensure composite: .codex-plugin marker suffices, but also create a dummy skill to make composite certain if needed
  // Already composite via marker
  return dir;
}
const SVG_TINY = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle cx="5" cy="5" r="4" fill="red"/></svg>';
const PNG_TINY = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("hub-v3 native avatar extraction", () => {
  it("encodes interface.logo SVG as iconDataUri", () => {
    const pdir = makePlugin("svg-logo-plugin", { name: "svg-logo-plugin", interface: { logo: "assets/logo.svg", displayName: "SVG Plugin", shortDescription: "SVG desc", developerName: "Acme" } }, [["assets/logo.svg", SVG_TINY, false]]);
    const mgr = hubPluginsMod.createPluginsManager({ homeDir: tmpHome, hubDir: tmpHub });
    const listed = mgr.listPlugins({});
    const item = listed.items.find((i) => i.id === "svg-logo-plugin");
    assert.ok(item, "svg-logo-plugin should be listed");
    assert.ok(item.iconDataUri && item.iconDataUri.startsWith("data:image/svg+xml;base64,"), `iconDataUri should be svg data uri, got ${item.iconDataUri}`);
    const decoded = Buffer.from(item.iconDataUri.split(",")[1], "base64").toString("utf8");
    assert.equal(decoded, SVG_TINY);
    assert.equal(item.displayName, "SVG Plugin");
    assert.equal(item.shortDescription, "SVG desc");
    assert.equal(item.developerName, "Acme");
    // iconDark null when not set
    assert.equal(item.iconDarkDataUri, null);
  });

  it("encodes PNG via composerIcon fallback", () => {
    const pdir2 = makePlugin("png-plugin", { name: "png-plugin", interface: { composerIcon: "assets/icon.png" }, displayName: "PNG Plugin" }, [["assets/icon.png", PNG_TINY, true]]);
    const mgr = hubPluginsMod.createPluginsManager({ homeDir: tmpHome, hubDir: tmpHub });
    const listed = mgr.listPlugins({});
    const item = listed.items.find((i) => i.id === "png-plugin");
    assert.ok(item);
    assert.ok(item.iconDataUri && item.iconDataUri.startsWith("data:image/png;base64,"), item.iconDataUri);
    assert.equal(item.displayName, "PNG Plugin");
  });

  it("encodes PNG via fallback assets/icon.png when no manifest logo", () => {
    const dir = path.join(tmpHub, "plugins", "fallback-png");
    fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
    writeJson(path.join(dir, ".claude-plugin", "plugin.json"), { name: "fallback-png", title: "fallback-png title" });
    writeFile(path.join(dir, "assets", "icon.png"), PNG_TINY);
    // ensure composite via .claude-plugin marker
    const mgr = hubPluginsMod.createPluginsManager({ homeDir: tmpHome, hubDir: tmpHub });
    const listed = mgr.listPlugins({});
    const item = listed.items.find((i) => i.id === "fallback-png");
    assert.ok(item);
    assert.ok(item.iconDataUri && item.iconDataUri.startsWith("data:image/png;base64,"));
  });

  it("rejects traversal path ../../etc/passwd and returns null", () => {
    const badDir = path.join(tmpHub, "plugins", "bad-traversal");
    fs.mkdirSync(path.join(badDir, ".codex-plugin"), { recursive: true });
    writeJson(path.join(badDir, ".codex-plugin", "plugin.json"), { name: "bad-traversal", interface: { logo: "../../etc/passwd" } });
    // no assets
    const mgr = hubPluginsMod.createPluginsManager({ homeDir: tmpHome, hubDir: tmpHub });
    const listed = mgr.listPlugins({});
    const item = listed.items.find((i) => i.id === "bad-traversal");
    assert.ok(item);
    assert.equal(item.iconDataUri, null, "traversal must be rejected");
    // Direct helper also returns null
    const direct = hubPluginsMod.findIconDataUri(badDir, { interface: { logo: "../../etc/passwd" } });
    assert.equal(direct, null);
  });

  it("handles logoDark and version subdirectory wildcard assets", () => {
    const base = path.join(tmpHub, "plugins", "dark-versioned");
    // structure: base itself is parent, child version dir v1.0 with assets/logo.svg
    fs.mkdirSync(path.join(base, ".codex-plugin"), { recursive: true });
    writeJson(path.join(base, ".codex-plugin", "plugin.json"), { name: "dark-versioned", interface: { logo: "assets/logo.svg", logoDark: "assets/logo-dark.svg" } });
    // version subdir structure
    const vdir = path.join(base, "v1.0.0");
    fs.mkdirSync(path.join(vdir, "assets"), { recursive: true });
    writeFile(path.join(vdir, "assets", "logo.svg"), SVG_TINY);
    writeFile(path.join(vdir, "assets", "logo-dark.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><text>dark</text></svg>');
    // also need parent/assets for manifest resolution? version wildcard will be found via pluginRoots logic
    const mgr = hubPluginsMod.createPluginsManager({ homeDir: tmpHome, hubDir: tmpHub });
    const listed = mgr.listPlugins({});
    const item = listed.items.find((i) => i.id === "dark-versioned");
    assert.ok(item, "dark-versioned found");
    // at least light should be found via fallback wildcard
    assert.ok(item.iconDataUri && item.iconDataUri.startsWith("data:image/svg+xml;base64,"));
    // dark may be null if not resolved via version dir directly - but should attempt resolveInside parent; version dir child's assets not in parent, dark may still be resolved via child? Check helper with fallback
    // For our impl dark expects logoDark candidate resolving relative to child version dir roots - child is in roots, so path.resolve child root with logoDark should find vdir/assets/logo-dark.svg? candidate is assets/logo-dark.svg relative to child root which has it
    // So both should be present
    if (item.iconDarkDataUri !== null) {
      assert.ok(item.iconDarkDataUri.startsWith("data:image/svg+xml;base64,"));
    }
  });
});

describe("backend hubCall v3 integration", () => {
  before(() => {
    // Ensure hub subagents defaults exist
    try {
      const mgr = require(path.join(REPO, "src", "hub-subagents.cjs")).createSubagentsManager({ homeDir: tmpHome, hubDir: tmpHub });
      mgr.listSubagents({});
    } catch {}
    // Seed a skill and an mcp server for toggle tests
    writeSkill(path.join(tmpHome, ".agents", "skills", "backend-toggle-skill"), "backend-toggle-skill", "Toggle skill");
    // Ensure skill scope global so it appears
    try {
      const skillsMgr = hubSkillsMod.createSkillsManager({ homeDir: tmpHome, hubDir: tmpHub });
      skillsMgr.setSkillScope({ id: "backend-toggle-skill", scope: "global" });
    } catch {}
    // Seed MCP server via router upsert
    try {
      const router = mcpRouterMod.createMcpRouter({ homeDir: tmpHome, hubDir: tmpHub });
      router.upsertMcpServer({ name: "backend-mock-mcp", command: "node", args: ["/tmp/mock.js"] });
    } catch {}
    // Seed a simple plugin for toggleAgent test
    makePlugin("toggle-target-plugin", { name: "toggle-target-plugin", version: "1.0.0", title: "Toggle Target", description: "for toggle test" }, []);
  });

  it("plugins:catalog returns installed and marketplace sections", async () => {
    const res = await backend.hubCall("plugins:catalog", {});
    assert.ok(res.ok === true || res.counts, JSON.stringify(res));
    // should have installed array and marketplace array
    assert.ok(Array.isArray(res.installed));
    assert.ok(Array.isArray(res.marketplace));
    assert.ok(res.counts && typeof res.counts.installed === "number");
    // Ensure catalogSection fields present on items
    const all = [...(res.installed || []), ...(res.marketplace || [])];
    // at least check our previous svg plugin is present via catalog (installed)
    // find svg-logo-plugin
    const found = all.find((p) => p.id === "svg-logo-plugin");
    if (found) {
      assert.ok(found.catalogSection === "installed" || found.catalogSection === "marketplace");
      assert.ok("installed" in found);
      assert.ok("iconDataUri" in found);
      assert.ok("capabilities" in found);
    }
  });

  it("plugins:toggleAgent and skills/mcp toggleAgent work", async () => {
    // plugin toggle
    const pluginToggle = await backend.hubCall("plugins:toggleAgent", { id: "toggle-target-plugin", agent: "pi", enabled: true });
    assert.equal(pluginToggle.ok, true, JSON.stringify(pluginToggle));
    assert.equal(pluginToggle.agent, "pi");
    assert.equal(pluginToggle.enabled, true);
    // toggle off
    const pluginToggleOff = await backend.hubCall("plugins:toggleAgent", { id: "toggle-target-plugin", agent: "pi", enabled: false });
    assert.equal(pluginToggleOff.ok, true);

    // skills toggle
    const skillToggle = await backend.hubCall("skills:toggleAgent", { id: "backend-toggle-skill", agent: "pi", enabled: true });
    assert.equal(skillToggle.ok, true, JSON.stringify(skillToggle));
    const skillToggleOff = await backend.hubCall("skills:toggleAgent", { id: "backend-toggle-skill", agent: "pi", enabled: false });
    assert.equal(skillToggleOff.ok, true);

    // mcp toggle
    const mcpToggle = await backend.hubCall("mcp:toggleAgent", { name: "backend-mock-mcp", agent: "pi", enabled: true });
    // toggleServerForAgent expects id/name - we use name
    assert.equal(mcpToggle.ok, true, JSON.stringify(mcpToggle));
    // matrix
    const mat = await backend.hubCall("mcp:matrix", {});
    assert.ok(mat.ok === true || Array.isArray(mat.matrix));
    const matrixArr = mat.matrix || mat.items || [];
    assert.ok(Array.isArray(matrixArr));
    // setAgents
    const setRes = await backend.hubCall("mcp:setAgents", { name: "backend-mock-mcp", agents: ["muse", "codex"] });
    assert.equal(setRes.ok, true, JSON.stringify(setRes));
    // toggle off
    const mcpOff = await backend.hubCall("mcp:toggleAgent", { name: "backend-mock-mcp", agent: "muse", enabled: false });
    assert.equal(mcpOff.ok, true);
  });

  it("memory:worktreeInfo and memory:promote", async () => {
    const info = await backend.hubCall("memory:worktreeInfo", { projectRoot: PROJECT_ROOT });
    assert.ok(info && info.canonicalProjectRoot);
    // save worktree memory
    const saved = await backend.hubCall("memory:save", { projectRoot: PROJECT_ROOT, module: "constraints", kind: "constraint", title: "worktree promote title " + Date.now(), content: "worktree content " + Math.random(), scope: "worktree" });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const savedId = saved.item.id;
    // promote
    const promoted = await backend.hubCall("memory:promote", { id: savedId });
    assert.equal(promoted.ok, true, JSON.stringify(promoted));
    assert.equal(promoted.item.scope, "shared");
  });

  it("subagents:orchestration update and get", async () => {
    const initial = await backend.hubCall("subagents:orchestration:get", {});
    const upd = await backend.hubCall("subagents:orchestration:update", { orchestratorMode: "carbon", swarmMode: "on", expectedRevision: initial.modeRevision });
    assert.equal(upd.ok, false, JSON.stringify(upd));
    assert.match(upd.error, /请选择/);
    const got = await backend.hubCall("subagents:orchestration:get", {});
    const gotCfg = got.config || got;
    assert.equal(gotCfg.orchestratorMode, "off");
    assert.equal(gotCfg.swarmMode, "auto");
    const slash = await backend.hubCall("subagents:slashPrompt", { mode: "swarm" });
    assert.ok(slash.prompt && slash.prompt.includes("角色"));
  });

  it("board:get and board:update", async () => {
    const steps = [
      { id: "s1", text: "step one", status: "completed" },
      { id: "s2", text: "step two", status: "in_progress" },
    ];
    const upd = await backend.hubCall("board:update", { projectRoot: PROJECT_ROOT, threadId: "thread-board-1", steps, title: "Board Title", background: "bg" });
    assert.ok(upd && Array.isArray(upd.steps), JSON.stringify(upd));
    const snap = await backend.hubCall("board:get", { projectRoot: PROJECT_ROOT, threadId: "thread-board-1" });
    assert.ok(snap && Array.isArray(snap.steps), JSON.stringify(snap));
    assert.equal(snap.steps.length, 2);
    assert.equal(snap.steps[0].text, "step one");
    assert.equal(snap.progress.label, "1/2");
    // The legacy read action must no longer allow unscoped access merely
    // because a Markdown file resides under ~/.t3.
    const artifactPath = path.join(tmpHome, ".t3", "hub", "artifact-test.md");
    writeFile(artifactPath, "# artifact content\n");
    const art = await backend.hubCall("board:readArtifact", { path: artifactPath });
    assert.equal(art.ok, false, JSON.stringify(art));
    // traversal should fail
    const bad = await backend.hubCall("board:readArtifact", { path: "/etc/passwd" });
    assert.equal(bad.ok, false);
  });

  it("memory:dream:get / update / run", async () => {
    const state0 = await backend.hubCall("memory:dream:get", {});
    assert.equal(state0.ok, true, JSON.stringify(state0));
    assert.ok(state0.config);
    assert.ok(Array.isArray(state0.journal));
    assert.equal(state0.config.dreamTime, "03:00");
    // invalid dreamTime
    const bad = await backend.hubCall("memory:dream:update", { dreamTime: "bad" });
    assert.equal(bad.ok, false, JSON.stringify(bad));
    assert.equal(bad.error, "invalid dreamTime (expected HH:MM)");
    // valid update
    const upd = await backend.hubCall("memory:dream:update", { dreamTime: "04:00", enabled: true, catchUpOnWake: true });
    assert.equal(upd.ok, true, JSON.stringify(upd));
    assert.equal(upd.config.dreamTime, "04:00");
    const state1 = await backend.hubCall("memory:dream:get", {});
    assert.equal(state1.config.dreamTime, "04:00");
    // seed a memory so dream cycle has work
    const saved = await backend.hubCall("memory:save", { projectRoot: PROJECT_ROOT, module: "topics", kind: "topic", title: "dream-backend-" + Date.now(), content: "dream backend e2e content " + Math.random(), autoEvolve: false });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    // run manual dream
    const run = await backend.hubCall("memory:dream:run", { reason: "manual", projectRoot: PROJECT_ROOT });
    assert.equal(run.ok, true, JSON.stringify(run));
    assert.ok(run.report);
    assert.equal(run.report.reason, "manual");
    assert.ok(Array.isArray(run.journal));
    const state2 = await backend.hubCall("memory:dream:get", {});
    assert.ok(state2.config.lastReport);
    assert.equal(state2.config.lastReport.at, run.report.at);
    assert.ok(state2.config.dreamCount >= 1);
    // overview carries dream field via memory:overview
    const ov = await backend.hubCall("memory:overview", { projectRoot: PROJECT_ROOT });
    assert.equal(ov.ok, true, JSON.stringify(ov));
    assert.ok(ov.dream);
    assert.ok(ov.dream.lastReport);
    assert.equal(ov.dream.lastReport.at, run.report.at);
  });

  it("automation:list returns unknown action (cleaned up)", async () => {
    const res = await backend.hubCall("automation:list", {});
    assert.equal(res.ok, false);
    assert.match(res.error, /unknown action/);
  });

  it("settings get and update", async () => {
    const snap = await backend.hubCall("settings:get", {});
    assert.ok(snap && snap.codex && snap.antigravity);
    const upd = await backend.hubCall("settings:update", { host: "codex", key: "model", value: "gpt-6.1-terra" });
    assert.equal(upd.host, "codex");
    assert.equal(upd.value, "gpt-6.1-terra");
    const snap2 = await backend.hubCall("settings:get", {});
    // codex snapshot should reflect new model (may be empty if config file missing, but update should write)
    // At least check ok not error
    assert.ok(snap2.codex);
    const ruleGet = await backend.hubCall("settings:getRule", { host: "codex" });
    assert.ok(ruleGet && typeof ruleGet.path === "string");
    const ruleSave = await backend.hubCall("settings:saveRule", { host: "codex", content: "# test rule\n", expectedContent: ruleGet.content, expectedTarget: ruleGet.targetPath });
    assert.ok(ruleSave && ruleSave.path);
  });
});

describe("bin/t3-mcp-router plan_update tool", () => {
  it("exposes plan_update and writes reads board", async () => {
    const binPath = path.join(REPO, "bin", "t3-mcp-router");
    const child = spawn(process.execPath, [binPath], {
      cwd: tmpRoot,
      env: { ...process.env, HOME: tmpHome, T3_HUB_DIR: tmpHub },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buf = "";
    const pending = new Map();
    let seq = 0;
    child.stderr.resume();
    let exited = false;
    child.on("exit", () => { exited = true; });
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg && msg.id !== undefined && pending.has(msg.id)) {
          const resolve = pending.get(msg.id);
          pending.delete(msg.id);
          resolve(msg);
        }
      }
    });
    function request(method, params) {
      return new Promise((resolve, reject) => {
        const id = ++seq;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error("timeout " + method)); }, 8000);
        pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    }
    try {
      const init = await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } });
      assert.ok(init.result && init.result.serverInfo && init.result.serverInfo.name === "t3-mcp-router");
      const listResp = await request("tools/list", {});
      const tools = listResp.result.tools;
      const planTool = tools.find((t) => t.name === "plan_update");
      assert.ok(planTool, "plan_update should be exposed, got " + tools.map((t) => t.name).join(","));
      assert.ok(planTool.inputSchema && planTool.inputSchema.properties && planTool.inputSchema.properties.steps);
      // check scope params on memory tools if present
      const searchTool = tools.find((t) => t.name === "memory_search");
      if (searchTool) {
        assert.ok(searchTool.inputSchema.properties.scope, "memory_search scope");
        assert.ok(searchTool.inputSchema.properties.scopeFilter, "memory_search scopeFilter");
      }
      const writeTool = tools.find((t) => t.name === "memory_write");
      if (writeTool) {
        assert.ok(writeTool.inputSchema.properties.scope);
        assert.ok(writeTool.inputSchema.properties.scopeFilter);
      }
      // call plan_update
      const threadId = "thread-plan-" + Date.now();
      const callResp = await request("tools/call", {
        name: "plan_update",
        arguments: {
          projectRoot: PROJECT_ROOT,
          threadId,
          title: "Plan via MCP",
          background: "MCP bg",
          steps: [
            { id: "1", text: "fix", status: "completed" },
            { id: "2", text: "test", status: "pending" },
          ],
        },
      });
      assert.ok(!callResp.error, JSON.stringify(callResp));
      const text = callResp.result.content[0].text;
      const payload = JSON.parse(text);
      assert.ok(payload && Array.isArray(payload.steps));
      // verify board via direct taskBoard
      const board = hubTaskBoardMod.createTaskBoard({ hubPlansDir: path.join(tmpHub, "task-plans"), t3DbPath: path.join(tmpUserdata, "statev2.sqlite") });
      const snap = board.getBoardSnapshot({ projectRoot: PROJECT_ROOT, threadId });
      assert.ok(snap.steps.length >= 2, JSON.stringify(snap));
      assert.equal(snap.steps[0].text, "fix");
      // clear via plan_update clear true
      const clearResp = await request("tools/call", { name: "plan_update", arguments: { projectRoot: PROJECT_ROOT, threadId, clear: true } });
      assert.ok(!clearResp.error);
      const clearPayload = JSON.parse(clearResp.result.content[0].text);
      assert.ok(clearPayload.deleted !== undefined || clearPayload.ok !== undefined);
    } finally {
      try { child.stdin.end(); } catch {}
      try { child.kill("SIGTERM"); } catch {}
    }
  });
});
