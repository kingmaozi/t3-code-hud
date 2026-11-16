"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);

const { createSkillsManager, parseGitHubInput } = require("../src/hub-skills.cjs");
const { createMcpRouter } = require("../src/mcp-router.cjs");

const ROUTER_BIN = path.resolve(__dirname, "..", "bin", "t3-mcp-router");

function makeTmp(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `t3-hub-${label}-`));
}
function writeSkill(dir, skillName, desc, body) {
  fs.mkdirSync(dir, { recursive: true });
  const md = `---\nname: ${skillName}\ndescription: ${desc}\n---\n# ${skillName}\n${body || ("Body for " + skillName)}\n`;
  fs.writeFileSync(path.join(dir, "SKILL.md"), md, "utf8");
}
function git(args, cwd) {
  return execFileAsync("git", args, { cwd });
}
async function main() {}
void main;

describe("hub-skills listAssets discovery", () => {
  it("discovers codex-market, zcode, claude, lockfile and project skills", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const mgr = createSkillsManager({ homeDir: home, hubDir: hub });
    fs.mkdirSync(path.join(home, ".codex", "plugins", "cache", "acme", "p1"), { recursive: true });
    writeSkill(path.join(home, ".codex", "plugins", "cache", "acme", "p1"), "p1", "Plugin one");
    writeSkill(path.join(home, ".codex", "plugins", "cache", "acme", "p1", "skills", "nested"), "nested", "Nested skill");
    writeSkill(path.join(home, ".zcode", "skills", "ztool"), "ztool", "Z tool");
    writeSkill(path.join(home, ".claude", "skills", "ctool"), "ctool", "C tool");
    writeSkill(path.join(home, ".agents", "skills", "gt"), "gt", "Global tool");
    const proj = makeTmp("proj");
    writeSkill(path.join(proj, ".agents", "skills", "ptool"), "ptool", "Project tool");
    fs.writeFileSync(path.join(home, ".agents", ".skill-lock.json"), JSON.stringify({ version: 3, skills: { gt: { repoUrl: "https://github.com/o/r.git" } } }), "utf8");
    const res = mgr.listAssets({ projectRoot: proj });
    assert.equal(res.ok, true);
    const byId = Object.fromEntries(res.items.map((i) => [i.id, i]));
    assert.equal(byId.p1.source, "codex-market");
    assert.equal(byId.nested.source, "codex-market");
    assert.equal(byId.ztool.source, "zcode");
    assert.equal(byId.ctool.source, "claude");
    assert.equal(byId.gt.scope, "global");
    assert.equal(byId.ptool.scope, "project");
    assert.equal(byId.gt.repoUrl, "https://github.com/o/r.git");
    assert.equal(byId.gt.updatable, true);
    for (const it of res.items) assert.ok(typeof it.updatable === "boolean" && it.path && it.name && it.description !== undefined);
  });

  it("marks disabled skills in codex config as off", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const mgr = createSkillsManager({ homeDir: home, hubDir: hub });
    writeSkill(path.join(home, ".agents", "skills", "offy"), "offy", "Off tool");
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(home, ".codex", "config.toml"), '[[skills.config]]\nname = "offy"\ndisabled = true\n', "utf8");
    const res = mgr.listAssets({});
    const offy = res.items.find((i) => i.id === "offy");
    assert.equal(offy.scope, "off");
  });

  it("discovers AGY skills read-only", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const mgr = createSkillsManager({ homeDir: home, hubDir: hub });
    const agySkill = path.join(home, ".t3", "userdata", "providers", "antigravity", "inst1", "config", "skills", "agys");
    const archSkill = path.join(home, ".t3", "userdata", "providers", "antigravity", "inst1", "skills-archived-20260101", "archs");
    writeSkill(agySkill, "agys", "AGY skill");
    writeSkill(archSkill, "archs", "Archived skill");
    const beforeAgy = fs.readFileSync(path.join(agySkill, "SKILL.md"), "utf8");
    const res = mgr.listAssets({});
    const byId = Object.fromEntries(res.items.map((i) => [i.id, i]));
    assert.equal(byId.agys.source, "agy");
    assert.equal(byId.archs.source, "agy");
    mgr.setSkillScope({ id: "agys", scope: "global" });
    assert.equal(fs.readFileSync(path.join(agySkill, "SKILL.md"), "utf8"), beforeAgy);
    assert.ok(fs.lstatSync(path.join(agySkill)).isDirectory());
    const canonical = path.join(hub, "skills", "agys");
    assert.ok(fs.existsSync(path.join(canonical, "SKILL.md")));
  });
});

describe("hub-skills safe scope toggling", () => {
  it("backs up real skill dir when moving global -> project -> off", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const mgr = createSkillsManager({ homeDir: home, hubDir: hub });
    const proj = makeTmp("proj");
    fs.mkdirSync(path.join(proj, ".git", "info"), { recursive: true });
    fs.writeFileSync(path.join(proj, ".git", "info", "exclude"), "", "utf8");
    const globalDir = path.join(home, ".agents", "skills", "realone");
    writeSkill(globalDir, "realone", "Real skill", "ORIGINAL BODY");
    const r1 = mgr.setSkillScope({ id: "realone", scope: "project", projectRoot: proj });
    assert.equal(r1.ok, true);
    const canonical = path.join(hub, "skills", "realone");
    assert.ok(fs.readFileSync(path.join(canonical, "SKILL.md"), "utf8").includes("ORIGINAL BODY"));
    assert.ok(fs.lstatSync(path.join(proj, ".agents", "skills", "realone")).isSymbolicLink());
    assert.ok(!fs.existsSync(globalDir));
    const excl = fs.readFileSync(path.join(proj, ".git", "info", "exclude"), "utf8");
    assert.ok(excl.includes(".agents/skills/realone"));
    assert.ok(excl.includes(".claude/skills/realone"));
    const r2 = mgr.setSkillScope({ id: "realone", scope: "off", projectRoot: proj });
    assert.ok(!fs.existsSync(path.join(proj, ".agents", "skills", "realone")));
    assert.ok(fs.readFileSync(path.join(canonical, "SKILL.md"), "utf8").includes("ORIGINAL BODY"));
  });

  it("writes exclude idempotently for git worktree .git file", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const mgr = createSkillsManager({ homeDir: home, hubDir: hub });
    const proj = makeTmp("proj");
    const gitdir = path.join(proj, "gitdir");
    fs.mkdirSync(path.join(gitdir, "info"), { recursive: true });
    fs.writeFileSync(path.join(proj, ".git"), `gitdir: ${gitdir}\n`, "utf8");
    fs.writeFileSync(path.join(gitdir, "info", "exclude"), "", "utf8");
    writeSkill(path.join(home, ".agents", "skills", "wtone"), "wtone", "WT");
    mgr.setSkillScope({ id: "wtone", scope: "project", projectRoot: proj });
    mgr.setSkillScope({ id: "wtone", scope: "project", projectRoot: proj });
    const excl = fs.readFileSync(path.join(gitdir, "info", "exclude"), "utf8");
    assert.equal((excl.match(/\.agents\/skills\/wtone/g) || []).length, 1);
    assert.equal((excl.match(/\.claude\/skills\/wtone/g) || []).length, 1);
  });
});

describe("hub-skills importFromGitHub", () => {
  it("parses owner/repo and GitHub URLs and rejects shell metacharacters", () => {
    assert.equal(parseGitHubInput("owner/repo").owner, "owner");
    assert.equal(parseGitHubInput("owner/repo").cloneUrl, "https://github.com/owner/repo.git");
    assert.equal(parseGitHubInput("https://github.com/owner/repo").repo, "repo");
    const sub = parseGitHubInput("https://github.com/owner/repo/tree/main/sub/dir");
    assert.equal(sub.subpath, "sub/dir");
    assert.equal(parseGitHubInput("owner/repo; rm -rf /"), null);
    assert.equal(parseGitHubInput("-rf"), null);
    assert.equal(parseGitHubInput("owner/repo|cat"), null);
  });

  it("clones a local bare repo, updates and removes the package (offline)", async () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const mgr = createSkillsManager({ homeDir: home, hubDir: hub });
    const proj = makeTmp("proj");
    fs.mkdirSync(path.join(proj, ".git", "info"), { recursive: true });
    const src = makeTmp("src");
    await git(["init"], src);
    await git(["config", "user.email", "t@t"], src);
    await git(["config", "user.name", "t"], src);
    writeSkill(path.join(src, "myskill"), "myskill", "My skill", "v1-body");
    await git(["add", "-A"], src);
    await git(["commit", "-m", "init"], src);
    const bare = makeTmp("bare") + ".git";
    await execFileAsync("git", ["clone", "--bare", src, bare]);
    const res = await mgr.importFromGitHub({ repoInput: bare, scope: "project", projectRoot: proj });
    assert.equal(res.ok, true);
    assert.ok(res.imported.includes("myskill"));
    assert.ok(fs.readFileSync(path.join(hub, "skills", "myskill", "SKILL.md"), "utf8").includes("v1-body"));
    assert.equal((mgr.listAssets({ projectRoot: proj }).items.find((i) => i.id === "myskill") || {}).scope, "project");
    const pkgId = path.basename(bare);
    const pkgDir = path.join(hub, "packages", "local__" + pkgId);
    assert.ok(fs.existsSync(pkgDir));
    writeSkill(path.join(src, "myskill"), "myskill", "My skill", "v2-body");
    await git(["add", "-A"], src);
    await git(["commit", "-m", "v2"], src);
    await git(["push", bare, "HEAD:main"], src).catch(async () => {
      await git(["push", bare, "HEAD"], src);
    });
    const upd = await mgr.updatePackage({ id: "local__" + pkgId });
    assert.equal(upd.ok, true);
    assert.ok(fs.readFileSync(path.join(hub, "skills", "myskill", "SKILL.md"), "utf8").includes("v2-body"));
    await mgr.removePackage({ id: "local__" + pkgId, projectRoot: proj });
    assert.ok(!fs.existsSync(pkgDir));
    assert.equal((mgr.listAssets({ projectRoot: proj }).items.find((i) => i.id === "myskill") || {}).scope, "off");
  });
});

describe("hub-skills AGENTS.md", () => {
  it("saves and syncs only shared global rules to CLIs with backup", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const mgr = createSkillsManager({ homeDir: home, hubDir: hub });
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(home, ".codex", "AGENTS.md"), "ORIGINAL-CODE\n", "utf8");
    fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
    fs.mkdirSync(path.join(home, ".config", "muse"), { recursive: true });
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    const seeded = mgr.getAgentsMd({});
    assert.equal(seeded.globalContent, "");
    assert.equal(seeded.globalTokens, 0);
    const saved = mgr.saveAgentsMd({ target: "global", content: "# New global\n", expectedContent: "" });
    assert.equal(saved.ok, true);
    assert.ok(saved.syncedTargets.length >= 4);
    assert.ok(saved.agyTargetHint.includes("antigravity"));
    for (const p of [path.join(home, ".codex", "AGENTS.md"), path.join(home, ".pi", "agent", "AGENTS.md"), path.join(home, ".config", "muse", "AGENTS.md"), path.join(home, ".claude", "CLAUDE.md")]) {
      const content = fs.readFileSync(p, "utf8");
      assert.match(content, /<!-- t3-hub-global-rules:start -->\n# New global\n<!-- t3-hub-global-rules:end -->/);
      if (p.includes(".codex")) assert.match(content, /^ORIGINAL-CODE\n/);
    }
    assert.equal(fs.readFileSync(path.join(home, ".codex", "AGENTS.md.bak-t3hub"), "utf8"), "ORIGINAL-CODE\n");
    mgr.saveAgentsMd({ target: "global", content: "# New global v2\n", expectedContent: "# New global\n" });
    assert.equal(fs.readFileSync(path.join(home, ".codex", "AGENTS.md.bak-t3hub"), "utf8"), "ORIGINAL-CODE\n");
    assert.match(fs.readFileSync(path.join(home, ".codex", "AGENTS.md"), "utf8"), /^ORIGINAL-CODE\n[\s\S]*# New global v2\n/);
  });

  it("writes project AGENTS.md and injects soft route idempotently", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const mgr = createSkillsManager({ homeDir: home, hubDir: hub });
    const proj = makeTmp("proj");
    fs.writeFileSync(path.join(proj, "CLAUDE.md"), "# Claude\n", "utf8");
    mgr.saveAgentsMd({ target: "project", content: "# Proj\n", expectedContent: "", projectRoot: proj });
    assert.equal(fs.readFileSync(path.join(proj, "AGENTS.md"), "utf8"), "# Proj\n");
    mgr.injectSoftRoute({ projectRoot: proj });
    mgr.injectSoftRoute({ projectRoot: proj });
    const content = fs.readFileSync(path.join(proj, "AGENTS.md"), "utf8");
    assert.equal((content.match(/t3-hub-memory-route/g) || []).length, 1);
    assert.ok(content.includes("memory_search") && content.includes("memory_write"));
    const lines = content.split("\n").filter((l) => l.trim());
    assert.ok(lines.length <= 12);
    mgr.syncProjectRuleReference({ projectRoot: proj });
    const claude = fs.readFileSync(path.join(proj, "CLAUDE.md"), "utf8");
    assert.equal((claude.match(/@AGENTS\.md/g) || []).length, 1);
    const got = mgr.getAgentsMd({ projectRoot: proj });
    assert.equal(got.projectExists, true);
    assert.ok(got.projectContent.includes("memory_search"));
  });
});

const MOCK_UPSTREAM = `"use strict";
let buf = "";
process.stdin.on("data", (c) => {
  buf += c.toString("utf8");
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mock", version: "1" } } }) + "\\n");
    } else if (msg.method === "tools/list") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [
        { name: "mock_echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
        { name: "mock_add", description: "Add numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } },
      ] } }) + "\\n");
    } else if (msg.method === "tools/call") {
      const n = msg.params && msg.params.name, a = (msg.params && msg.params.arguments) || {};
      let text = "";
      if (n === "mock_echo") text = "echo:" + (a.text || "");
      else if (n === "mock_add") text = String((a.a || 0) + (a.b || 0));
      else text = "unknown:" + n;
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }] } }) + "\\n");
    }
  }
});
`;

function spawnRouter({ cwd, hubDir }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ROUTER_BIN, [], { cwd, env: { ...process.env, HOME: hubDir.split("/.t3/")[0] || process.env.HOME, T3_HUB_DIR: hubDir }, stdio: ["pipe", "pipe", "inherit"] });
    let buffer = "";
    const waiters = new Map();
    proc.stdout.on("data", (c) => {
      buffer += c.toString("utf8");
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (!line) continue;
        if (waiters.size === 0) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const w = waiters.get(msg.id);
        if (w) { waiters.delete(msg.id); w(msg); }
      }
    });
    proc.on("error", reject);
    let nextId = 1;
    function request(method, params) {
      return new Promise((res, rej) => {
        const id = nextId++;
        waiters.set(id, (m) => { if (m.error) rej(new Error(m.error.message || JSON.stringify(m.error))); else res(m.result); });
        proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
        setTimeout(() => { if (waiters.has(id)) { waiters.delete(id); rej(new Error("router timeout " + method)); } }, 15000);
      });
    }
    function notify(method) { proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n"); }
    function kill() { try { proc.stdin.end(); } catch {} setTimeout(() => { try { proc.kill(); } catch {} }, 300); }
    resolve({ proc, request, notify, kill });
  });
}
function spawnRouterCont(cwd, hubDir) { return spawnRouter({ cwd, hubDir }); }

describe("mcp-router.cjs", () => {
  it("reports launch configuration separately from probe connectivity", () => {
    const home = makeTmp("home"), hub = path.join(home, ".t3", "hub");
    fs.mkdirSync(path.join(home, ".config", "magpie"), { recursive: true });
    fs.writeFileSync(path.join(home, ".config", "magpie", "library.json"), JSON.stringify({ mcp: [
      { name: "missing-entry" },
      { name: "bad-cwd", command: process.execPath, cwd: "missing-directory" },
      { name: "http-configured", url: "https://example.invalid/mcp", transport: "http" },
    ] }), "utf8");
    const r = createMcpRouter({ homeDir: home, hubDir: hub });
    const byName = Object.fromEntries(r.listMcpServers({ projectRoot: home }).items.map(item => [item.name, item]));
    assert.equal(byName["missing-entry"].launchable, false);
    assert.equal(byName["missing-entry"].launchReason, "missing-endpoint");
    assert.equal(byName["bad-cwd"].launchable, false);
    assert.equal(byName["bad-cwd"].launchReason, "invalid-cwd");
    assert.equal(byName["http-configured"].launchable, true, "a configured endpoint is distinct from a successful network probe");
    assert.equal(byName["http-configured"].probed, false);
    assert.equal(byName["http-configured"].connected, null);
  });

  it("imports magpie library.json and redacts secrets", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    fs.mkdirSync(path.join(home, ".config", "magpie"), { recursive: true });
    fs.writeFileSync(path.join(home, ".config", "magpie", "library.json"), JSON.stringify({ mcp: [{ name: "demo", transport: "stdio", command: "node", args: ["/tmp/x"], env: { API_KEY: "supersecret", PLAIN: "visible" } }], icons: {} }), "utf8");
    const r = createMcpRouter({ homeDir: home, hubDir: hub });
    const listed = r.listMcpServers({ projectRoot: null });
    const demo = listed.items.find((i) => i.name === "demo");
    assert.ok(demo);
    assert.equal(demo.source, "magpie");
    assert.equal(demo.hasSecrets, true);
    assert.ok(!demo.summary.includes("supersecret"));
  });

  it("upserts from jsonRaw paste and from form fields", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const r = createMcpRouter({ homeDir: home, hubDir: hub });
    const a = r.upsertMcpServer({ jsonRaw: JSON.stringify({ mcpServers: { pasted: { command: "node", args: ["/a"] } } }) });
    assert.ok(a.items.find((i) => i.name === "pasted"));
    const b = r.upsertMcpServer({ name: "formed", command: "node", args: ["/b"], env: { TOKEN: "hidden-token" } });
    const formed = b.items.find((i) => i.name === "formed");
    assert.ok(formed);
    assert.ok(!formed.summary.includes("hidden-token"));
    r.removeMcpServer({ name: "formed" });
    assert.ok(!r.listMcpServers({}).items.find((i) => i.name === "formed"));
  });

  it("syncs t3_hub to Codex/Pi/Muse/Claude idempotently with backup", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const r = createMcpRouter({ homeDir: home, hubDir: hub });
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
    fs.mkdirSync(path.join(home, ".config", "muse"), { recursive: true });
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(home, ".codex", "config.toml"), "# keep\n", "utf8");
    const s1 = r.syncRouterToClis();
    assert.ok(s1.syncedTargets.length >= 4);
    const cfg1 = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
    assert.ok(cfg1.includes("[mcp_servers.t3_hub]") && cfg1.includes("t3-mcp-router"));
    assert.equal(fs.readFileSync(path.join(home, ".codex", "config.toml.bak-t3hub"), "utf8"), "# keep\n");
    r.syncRouterToClis();
    const cfg2 = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
    assert.equal((cfg2.match(/\[mcp_servers\.t3_hub\]/g) || []).length, 1);
    assert.equal(fs.readFileSync(path.join(home, ".codex", "config.toml.bak-t3hub"), "utf8"), "# keep\n");
    assert.equal(r.listMcpServers({}).routerRegistered, true);
  });

  it("excludes t3_hub itself from discovery", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
    fs.writeFileSync(path.join(home, ".pi", "agent", "mcp.json"), JSON.stringify({ mcpServers: { t3_hub: { command: "x" }, other: { command: "y" } } }), "utf8");
    const r = createMcpRouter({ homeDir: home, hubDir: hub });
    const listed = r.listMcpServers({});
    assert.ok(!listed.items.find((i) => i.name === "t3_hub"));
    assert.ok(listed.items.find((i) => i.name === "other"));
  });

  it("keeps project mode ownership stable when a historical symlink key is retargeted", () => {
    const home = makeTmp("home"), hub = path.join(home, ".t3", "hub");
    const projA = makeTmp("proj-a"), projB = makeTmp("proj-b"), alias = projA + "-alias", other = makeTmp("other");
    for (const proj of [projA, projB, other]) fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
    fs.symlinkSync(projA, alias, "dir");
    const r = createMcpRouter({ homeDir: home, hubDir: hub });
    r.upsertMcpServer({ name: "canonical", command: process.execPath, args: ["/tmp/mock.cjs"] });
    r.upsertMcpServer({ name: "legacy", command: process.execPath, args: ["/tmp/mock.cjs"] });
    r.setMcpMode({ name: "canonical", mode: "project-lazy", projectRoot: alias });
    const statePath = path.join(hub, "state.json");
    let state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const realA = fs.realpathSync(projA), realB = fs.realpathSync(projB);
    assert.equal(state.mcpModes.projects[realA].canonical, "project-lazy");
    assert.equal(Object.hasOwn(state.mcpModes.projects, alias), false, "new writes use the canonical key");

    state.mcpModes.projects[alias] = { legacy: "project-direct", unknown: "keep-me" };
    fs.writeFileSync(statePath, JSON.stringify(state), "utf8");
    const list = (projectRoot) => r.listMcpServers({ projectRoot }).items;
    assert.equal(list(projA).find((item) => item.name === "canonical").mode, "project-lazy");
    assert.equal(list(projA).find((item) => item.name === "legacy").mode, "off", "unbound legacy symlink records are kept but do not auto-activate");
    assert.equal(list(projB).find((item) => item.name === "canonical").mode, "off");
    assert.equal(list(projB).find((item) => item.name === "legacy").mode, "off");

    fs.unlinkSync(alias);
    fs.symlinkSync(projB, alias, "dir");
    assert.equal(list(projA).find((item) => item.name === "canonical").mode, "project-lazy", "new canonical record stays bound to A");
    assert.equal(list(projB).find((item) => item.name === "canonical").mode, "off", "retargeting alias A→B cannot redirect A's mode");
    assert.equal(list(projB).find((item) => item.name === "legacy").mode, "off", "the old symlink key cannot grant A's mode to B");

    r.setMcpMode({ name: "legacy", mode: "project-lazy", projectRoot: projB });
    state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(state.mcpModes.projects[alias].unknown, "keep-me", "legacy and unknown records are not deleted");
    assert.equal(state.mcpModes.projects[realB].legacy, "project-lazy", "explicit action creates a canonical binding for B");
    assert.equal(list(projA).find((item) => item.name === "legacy").mode, "off");
    assert.equal(list(other).find((item) => item.name === "legacy").mode, "off", "project modes do not leak to other roots");
  });

  it("router ignores a retargeted legacy symlink mode until the project is explicitly bound", async () => {
    const home = makeTmp("home"), hub = path.join(home, ".t3", "hub");
    fs.mkdirSync(hub, { recursive: true });
    const projA = makeTmp("proj-a"), projB = makeTmp("proj-b"), alias = projA + "-alias";
    for (const proj of [projA, projB]) fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
    fs.symlinkSync(projA, alias, "dir");
    const r = createMcpRouter({ homeDir: home, hubDir: hub });
    r.upsertMcpServer({ name: "probe", command: process.execPath, args: ["/tmp/mock.cjs"] });
    const statePath = path.join(hub, "state.json");
    fs.writeFileSync(statePath, JSON.stringify({ mcpModes: { global: {}, projects: { [alias]: { probe: "project-lazy" } } } }), "utf8");
    fs.unlinkSync(alias);
    fs.symlinkSync(projB, alias, "dir");

    const rt = await spawnRouter({ cwd: projB, hubDir: hub });
    try {
      await rt.request("initialize", { protocolVersion: "2024-11-05" });
      let names = (await rt.request("tools/list", {})).tools.map((tool) => tool.name);
      assert.ok(!names.includes("hub_list_mcp_tools") && !names.includes("hub_call_mcp_tool"));
      assert.ok(!names.some((name) => name.startsWith("probe__")));
      r.setMcpMode({ name: "probe", mode: "project-lazy", projectRoot: projB });
      names = (await rt.request("tools/list", {})).tools.map((tool) => tool.name);
      assert.ok(names.includes("hub_list_mcp_tools") && names.includes("hub_call_mcp_tool"), "explicit canonical binding enables B");
    } finally { rt.kill(); }
  });

  it("does not let an unbound symlink project key truncate nested project-root discovery", async () => {
    const home = makeTmp("home"), hub = path.join(home, ".t3", "hub"), project = makeTmp("nested-project");
    const nested = path.join(project, "nested"), work = path.join(nested, "work"), alias = project + "-legacy-link";
    fs.mkdirSync(path.join(project, ".git"), { recursive: true });
    fs.mkdirSync(work, { recursive: true });
    fs.symlinkSync(nested, alias, "dir");
    const mockFile = path.join(home, "nested-root-upstream.cjs");
    fs.writeFileSync(mockFile, MOCK_UPSTREAM, "utf8");
    const r = createMcpRouter({ homeDir: home, hubDir: hub });
    r.upsertMcpServer({ name: "probe", command: process.execPath, args: [mockFile] });
    r.setMcpMode({ name: "probe", mode: "project-lazy", projectRoot: project });
    const statePath = path.join(hub, "state.json"), state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    state.mcpModes.projects[alias] = { unrelated: "project-direct" };
    fs.writeFileSync(statePath, JSON.stringify(state), "utf8");

    const rt = await spawnRouter({ cwd: work, hubDir: hub });
    try {
      await rt.request("initialize", { protocolVersion: "2024-11-05" });
      const names = (await rt.request("tools/list", {})).tools.map((tool) => tool.name);
      assert.ok(names.includes("hub_list_mcp_tools") && names.includes("hub_call_mcp_tool"), JSON.stringify(names));
    } finally { rt.kill(); }
  });

  it("reads a unique legacy normalized MCP mode key consistently in manager and runtime", async () => {
    const home = makeTmp("home"), hub = path.join(home, ".t3", "hub"), proj = makeTmp("legacy-mode-project");
    fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
    const mockFile = path.join(home, "legacy-mode-upstream.cjs");
    fs.writeFileSync(mockFile, MOCK_UPSTREAM, "utf8");
    const r = createMcpRouter({ homeDir: home, hubDir: hub });
    r.upsertMcpServer({ name: "legacy-name", command: process.execPath, args: [mockFile] });
    const statePath = path.join(hub, "state.json");
    fs.writeFileSync(statePath, JSON.stringify({ mcpModes: { global: { legacy_name: "global-direct" }, projects: {} } }), "utf8");
    assert.equal(r.listMcpServers({ projectRoot: proj }).items.find((item) => item.name === "legacy-name").mode, "global-direct");
    const rt = await spawnRouter({ cwd: proj, hubDir: hub });
    try {
      await rt.request("initialize", { protocolVersion: "2024-11-05" });
      const names = (await rt.request("tools/list", {})).tools.map((tool) => tool.name);
      assert.ok(names.includes("legacy-name__mock_echo"), JSON.stringify(names));
    } finally { rt.kill(); }
  });

  it("pauses every definition in a normalized-name collision in manager and runtime", async () => {
    const home = makeTmp("home"), hub = path.join(home, ".t3", "hub"), proj = makeTmp("collision-project");
    fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
    const codexPath = path.join(home, ".codex", "config.toml");
    fs.mkdirSync(path.dirname(codexPath), { recursive: true });
    fs.writeFileSync(codexPath, '[mcp_servers.echo_server]\ncommand = "node"\nargs = ["/tmp/one.cjs"]\n\n[mcp_servers.echo-server]\ncommand = "node"\nargs = ["/tmp/two.cjs"]\n', "utf8");
    const mockFile = path.join(home, "collision-upstream.cjs");
    fs.writeFileSync(mockFile, MOCK_UPSTREAM, "utf8");
    const r = createMcpRouter({ homeDir: home, hubDir: hub });
    r.upsertMcpServer({ name: "echo_server", command: process.execPath, args: [mockFile] });
    r.setMcpMode({ name: "echo_server", mode: "global-direct" });
    r.upsertMcpServer({ name: "echo-server", command: process.execPath, args: [mockFile] });

    const items = r.listMcpServers({ projectRoot: proj }).items.filter((item) => ["echo_server", "echo-server"].includes(item.name));
    assert.equal(items.length, 2, "both original definitions stay visible");
    assert.ok(items.every((item) => item.modeConflict && item.mode === "off" && !item.enabled));
    assert.throws(() => r.setMcpMode({ name: "echo_server", mode: "global-direct" }), /normalized MCP name conflict/);
    assert.throws(() => r.toggleServerForAgent({ name: "echo_server", agent: "codex", enabled: true }), /normalized MCP name conflict/);
    assert.doesNotThrow(() => r.setMcpMode({ name: "echo_server", mode: "off" }), "an exact conflict row can save Hub off");
    let state = JSON.parse(fs.readFileSync(path.join(hub, "state.json"), "utf8"));
    assert.equal(state.mcpModes.global.echo_server, "off");
    r.toggleServerForAgent({ name: "echo_server", agent: "codex", enabled: false });
    let codex = fs.readFileSync(codexPath, "utf8");
    assert.doesNotMatch(codex, /mcp_servers\.echo_server\]/, "conflict disable removes only the exact selected entry");
    assert.match(codex, /mcp_servers\.echo-server\]/, "the other colliding native config stays untouched");

    const rt = await spawnRouter({ cwd: proj, hubDir: hub });
    try {
      await rt.request("initialize", { protocolVersion: "2024-11-05" });
      const names = (await rt.request("tools/list", {})).tools.map((tool) => tool.name);
      assert.ok(!names.some((name) => name.startsWith("echo_server__") || name.startsWith("echo-server__")), JSON.stringify(names));
      assert.ok(!names.includes("hub_list_mcp_tools") && !names.includes("hub_call_mcp_tool"));
    } finally { rt.kill(); }
    r.removeMcpServer({ name: "echo_server" });
    const remaining = r.listMcpServers({ projectRoot: proj }).items.filter((item) => ["echo_server", "echo-server"].includes(item.name));
    assert.deepEqual(remaining.map((item) => item.name), ["echo-server"], "explicit removal deletes only the selected registry definition");
  });

  it("refreshes schema and stdio child when env and cwd change without exposing env in cache", async () => {
    const home = makeTmp("home"), hub = path.join(home, ".t3", "hub"), proj = makeTmp("exec-project");
    fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
    const cwdB = path.join(proj, "server-b");
    fs.mkdirSync(cwdB);
    const pidFile = path.join(home, "upstream-pid.txt"), mockFile = path.join(home, "dynamic-upstream.cjs");
    fs.writeFileSync(mockFile, `
      const fs = require("node:fs");
      fs.writeFileSync(process.env.QA_PID_FILE, String(process.pid));
      let buf = "";
      process.stdin.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        let index;
        while ((index = buf.indexOf("\\n")) >= 0) {
          const line = buf.slice(0, index).trim(); buf = buf.slice(index + 1);
          if (!line) continue;
          const msg = JSON.parse(line);
          let result;
          if (msg.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "dynamic", version: "1" } };
          else if (msg.method === "tools/list") result = { tools: [{ name: process.env.QA_TOOL_NAME, inputSchema: { type: "object", properties: {} } }] };
          else if (msg.method === "tools/call") result = { content: [{ type: "text", text: JSON.stringify({ value: process.env.QA_VALUE, cwd: process.cwd() }) }] };
          else continue;
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
        }
      });
    `, "utf8");
    const r = createMcpRouter({ homeDir: home, hubDir: hub });
    r.upsertMcpServer({ name: "mutable", command: process.execPath, args: [mockFile], env: { QA_PID_FILE: pidFile, QA_VALUE: "SECRET_VALUE_A", QA_TOOL_NAME: "alpha" } });
    r.setMcpMode({ name: "mutable", mode: "global-direct" });
    const rt = await spawnRouter({ cwd: proj, hubDir: hub });
    try {
      await rt.request("initialize", { protocolVersion: "2024-11-05" });
      let names = (await rt.request("tools/list", {})).tools.map((tool) => tool.name);
      assert.ok(names.includes("mutable__alpha"), JSON.stringify(names));
      const defaultCwdCall = await rt.request("tools/call", { name: "mutable__alpha", arguments: {} });
      assert.equal(JSON.parse(defaultCwdCall.content[0].text).cwd, fs.realpathSync(proj), "missing cwd defaults to the active project root");
      const oldPid = Number(fs.readFileSync(pidFile, "utf8"));

      r.upsertMcpServer({ name: "mutable", command: process.execPath, args: [mockFile], cwd: path.relative(proj, cwdB), env: { QA_PID_FILE: pidFile, QA_VALUE: "SECRET_VALUE_B", QA_TOOL_NAME: "beta" } });
      names = (await rt.request("tools/list", {})).tools.map((tool) => tool.name);
      assert.ok(names.includes("mutable__beta"), JSON.stringify(names));
      assert.ok(!names.includes("mutable__alpha"), JSON.stringify(names));
      const currentPid = Number(fs.readFileSync(pidFile, "utf8"));
      assert.notEqual(currentPid, oldPid, "the changed execution definition starts a fresh child");
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.throws(() => process.kill(oldPid, 0), { code: "ESRCH" }, "the previous child is closed after definition change");

      const called = await rt.request("tools/call", { name: "mutable__beta", arguments: {} });
      const observed = JSON.parse(called.content[0].text);
      assert.equal(observed.value, "SECRET_VALUE_B");
      assert.equal(observed.cwd, fs.realpathSync(cwdB), "configured relative cwd resolves against the project root");
      const cache = fs.readFileSync(path.join(hub, "mcp-schema-cache.json"), "utf8");
      assert.ok(!cache.includes("SECRET_VALUE_A") && !cache.includes("SECRET_VALUE_B"), "schema cache stores only a definition hash, never env values");

      const invalidCwd = path.join(proj, "not-a-directory.txt");
      fs.writeFileSync(invalidCwd, "fixture");
      const pidBeforeInvalid = Number(fs.readFileSync(pidFile, "utf8"));
      r.upsertMcpServer({ name: "mutable", command: process.execPath, args: [mockFile], cwd: path.basename(invalidCwd), env: { QA_PID_FILE: pidFile, QA_VALUE: "SECRET_VALUE_C", QA_TOOL_NAME: "gamma" } });
      r.setMcpMode({ name: "mutable", mode: "global-lazy" });
      const badCwdList = await rt.request("tools/call", { name: "hub_list_mcp_tools", arguments: { server: "mutable" } });
      const badCwdPayload = JSON.parse(badCwdList.content[0].text);
      assert.match(badCwdPayload.error, /cwd is not a directory/);
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.throws(() => process.kill(pidBeforeInvalid, 0), { code: "ESRCH" }, "invalid replacement config closes the previous same-name child");

      r.upsertMcpServer({ name: "mutable", command: process.execPath, args: [mockFile], cwd: proj, env: { QA_PID_FILE: pidFile, QA_TOOL_NAME: "delta" } });
      r.setMcpMode({ name: "mutable", mode: "global-direct" });
      await rt.request("tools/list", {});
      const pidBeforeCacheHit = Number(fs.readFileSync(pidFile, "utf8"));
      r.upsertMcpServer({ name: "mutable", command: process.execPath, args: [mockFile], cwd: proj, env: { QA_PID_FILE: pidFile, QA_TOOL_NAME: "epsilon" } });
      const peer = await spawnRouter({ cwd: proj, hubDir: hub });
      try {
        await peer.request("initialize", { protocolVersion: "2024-11-05" });
        await peer.request("tools/list", {}); // Another router fills the shared new-definition cache.
        names = (await rt.request("tools/list", {})).tools.map((tool) => tool.name);
        assert.ok(names.includes("mutable__epsilon"));
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.throws(() => process.kill(pidBeforeCacheHit, 0), { code: "ESRCH" }, "a schema cache hit must still retire this router's old child");
      } finally { peer.kill(); }

      await rt.request("tools/call", { name: "mutable__epsilon", arguments: {} });
      const pidBeforeHttp = Number(fs.readFileSync(pidFile, "utf8"));
      const httpServer = require("node:http").createServer((req, res) => {
        req.resume();
        req.on("end", () => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "http_tool", inputSchema: { type: "object" } }] } })); });
      });
      await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
      try {
        r.upsertMcpServer({ name: "mutable", transport: "http", url: "http://127.0.0.1:" + httpServer.address().port });
        names = (await rt.request("tools/list", {})).tools.map((tool) => tool.name);
        assert.ok(names.includes("mutable__http_tool"));
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.throws(() => process.kill(pidBeforeHttp, 0), { code: "ESRCH" }, "switching to HTTP must retire the previous stdio child");
      } finally { await new Promise((resolve) => httpServer.close(resolve)); }
    } finally { rt.kill(); }
  }, { timeout: 60000 });

  it("routes lazy then direct modes live without restart", async () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    fs.mkdirSync(hub, { recursive: true });
    const proj = makeTmp("proj");
    const projAlias = proj + "-alias";
    fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
    fs.symlinkSync(proj, projAlias, "dir");
    const mockFile = path.join(home, "mock-upstream.cjs");
    fs.writeFileSync(mockFile, MOCK_UPSTREAM, "utf8");
    const r = createMcpRouter({ homeDir: home, hubDir: hub });
    r.upsertMcpServer({ name: "mock", command: process.execPath, args: [mockFile] });
    r.setMcpMode({ name: "mock", mode: "project-lazy", projectRoot: projAlias });
    const rt = await spawnRouter({ cwd: projAlias, hubDir: hub });
    try {
      await rt.request("initialize", { protocolVersion: "2024-11-05" });
      rt.notify("notifications/initialized");
      const list1 = await rt.request("tools/list", {});
      const names1 = (list1.tools || []).map((t) => t.name);
      assert.ok(names1.includes("hub_list_mcp_tools"));
      assert.ok(names1.includes("hub_call_mcp_tool"));
      const listed = await rt.request("tools/call", { name: "hub_list_mcp_tools", arguments: { server: "mock" } });
      const listedText = listed.content[0].text;
      assert.ok(listedText.includes("mock_echo") && listedText.includes("mock_add"));
      const called = await rt.request("tools/call", { name: "hub_call_mcp_tool", arguments: { server: "mock", tool: "mock_echo", arguments: { text: "hi" } } });
      assert.ok(String(called.content[0].text).includes("echo:hi"));
      assert.ok(fs.existsSync(path.join(hub, "mcp-schema-cache.json")));
      r.setMcpMode({ name: "mock", mode: "project-direct", projectRoot: projAlias });
      const list2 = await rt.request("tools/list", {});
      const names2 = (list2.tools || []).map((t) => t.name);
      assert.ok(names2.includes("mock__mock_echo"), JSON.stringify(names2));
      const directCall = await rt.request("tools/call", { name: "mock__mock_add", arguments: { a: 2, b: 3 } });
      assert.ok(String(directCall.content[0].text).includes("5"));
    } finally { rt.kill(); }
  }, { timeout: 60000 });

  it("speaks Content-Length framed JSON-RPC", async () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    fs.mkdirSync(hub, { recursive: true });
    const proj = makeTmp("proj");
    fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
    const proc = spawn(ROUTER_BIN, [], { cwd: proj, env: { ...process.env, HOME: home, T3_HUB_DIR: hub }, stdio: ["pipe", "pipe", "inherit"] });
    try {
      const sendFramed = (msg) => { const body = JSON.stringify(msg); proc.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`); };
      const chunks = [];
      const res = await new Promise((resolve, reject) => {
        let buf = "";
        proc.stdout.on("data", (c) => {
          buf += c.toString("utf8");
          const hm = buf.match(/Content-Length:\s*(\d+)/i);
          if (!hm) return;
          const len = parseInt(hm[1], 10);
          const headEnd = buf.search(/\r?\n\r?\n/);
          if (headEnd === -1) return;
          const hm2 = buf.slice(headEnd).match(/^(\r?\n){2}/);
          const bodyStart = headEnd + (hm2 ? hm2[0].length : 0);
          const body = buf.slice(bodyStart, bodyStart + len);
          if (body.length < len) return;
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
        sendFramed({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
        setTimeout(() => reject(new Error("framed timeout")), 10000);
        void chunks;
      });
      assert.equal(res.result.serverInfo.name, "t3-mcp-router");
    } finally { try { proc.stdin.end(); } catch {}; setTimeout(() => { try { proc.kill(); } catch {} }, 300); }
  }, { timeout: 30000 });
});

