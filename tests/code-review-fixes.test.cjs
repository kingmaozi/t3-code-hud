"use strict";
// Failing-first regression tests for code-review findings (branch feat/sidecar-hub).
// All state lives under os.tmpdir(); never touches ~/.t3/hub/memory live data.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const { createSkillsManager } = require("../src/hub-skills.cjs");
const { createMcpRouter } = require("../src/mcp-router.cjs");
const { createMemoryVault, scopeHashFor } = require("../src/memory-vault.cjs");
const { createSubagentsManager } = require("../src/hub-subagents.cjs");
const { createEmbedManager } = require("../src/embed-manager.cjs");

const ROUTER_BIN = path.resolve(__dirname, "..", "bin", "t3-mcp-router");

function makeTmp(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `t3-review-${label}-`));
}
function writeSkill(dir, skillName, desc, body) {
  fs.mkdirSync(dir, { recursive: true });
  const md = `---\nname: ${skillName}\ndescription: ${desc}\n---\n# ${skillName}\n${body || ("Body for " + skillName)}\n`;
  fs.writeFileSync(path.join(dir, "SKILL.md"), md, "utf8");
}
function normRoot(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(String(p)); }
}
function listBackups(parentDir, prefix) {
  try {
    return fs.readdirSync(parentDir).filter((f) => f.startsWith(prefix));
  } catch { return []; }
}

describe("review #1 safe symlink/command handling", () => {
  it("backs up unmanaged real dir when canonical exists (never rmSync silently)", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const mgr = createSkillsManager({ homeDir: home, hubDir: hub });
    // Canonical exists with canonical content
    writeSkill(path.join(hub, "skills", "conflict1"), "conflict1", "Canon", "CANON-BODY-111");
    // Unmanaged real dir at global target with different content
    writeSkill(path.join(home, ".agents", "skills", "conflict1"), "conflict1", "User", "USER-BODY-222");
    const r = mgr.setSkillScope({ id: "conflict1", scope: "global" });
    assert.equal(r.ok, true);
    const globalLink = path.join(home, ".agents", "skills", "conflict1");
    // should be symlink to canonical now
    assert.ok(fs.lstatSync(globalLink).isSymbolicLink());
    assert.readFileSync;
    // backup must exist preserving USER-BODY
    const backups = listBackups(path.join(home, ".agents", "skills"), "conflict1.bak-t3hub-");
    assert.ok(backups.length >= 1, "expected .bak-t3hub- backup, got none");
    const backed = fs.readFileSync(path.join(path.join(home, ".agents", "skills"), backups[0], "SKILL.md"), "utf8");
    assert.ok(backed.includes("USER-BODY-222"));
    // canonical unchanged
    assert.ok(fs.readFileSync(path.join(hub, "skills", "conflict1", "SKILL.md"), "utf8").includes("CANON-BODY-111"));
  });

  it("off never silently deletes unmanaged dir when canonical exists", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const mgr = createSkillsManager({ homeDir: home, hubDir: hub });
    writeSkill(path.join(hub, "skills", "offkeep"), "offkeep", "Canon", "CANON-KEEP");
    writeSkill(path.join(home, ".agents", "skills", "offkeep"), "offkeep", "User", "USER-KEEP-777");
    mgr.setSkillScope({ id: "offkeep", scope: "off" });
    const globalLink = path.join(home, ".agents", "skills", "offkeep");
    // either removed with backup preserved, or left in place (never silently rm without backup)
    const backups = listBackups(path.join(home, ".agents", "skills"), "offkeep.bak-t3hub-");
    const existsAfter = fs.existsSync(globalLink);
    if (!existsAfter) {
      assert.ok(backups.length >= 1, "off must backup unmanaged dir before removing");
      const backed = fs.readFileSync(path.join(path.join(home, ".agents", "skills"), backups[0], "SKILL.md"), "utf8");
      assert.ok(backed.includes("USER-KEEP-777"));
    } else {
      // left untouched is also safe (must not be deleted)
      assert.ok(fs.readFileSync(path.join(globalLink, "SKILL.md"), "utf8").includes("USER-KEEP-777"));
    }
    // canonical intact
    assert.ok(fs.readFileSync(path.join(hub, "skills", "offkeep", "SKILL.md"), "utf8").includes("CANON-KEEP"));
  });

  it("off adopts unmanaged dir into canonical on first disable when canonical missing", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const mgr = createSkillsManager({ homeDir: home, hubDir: hub });
    writeSkill(path.join(home, ".agents", "skills", "adoptme"), "adoptme", "User", "ADOPT-BODY-999");
    mgr.setSkillScope({ id: "adoptme", scope: "off" });
    const canonical = path.join(hub, "skills", "adoptme");
    assert.ok(fs.readFileSync(path.join(canonical, "SKILL.md"), "utf8").includes("ADOPT-BODY-999"), "canonical should adopt user content");
    assert.ok(!fs.existsSync(path.join(home, ".agents", "skills", "adoptme")), "old dir removed after adoption");
  });

  it("preserves user-authored .claude/commands file and stamps managed files", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const mgr = createSkillsManager({ homeDir: home, hubDir: hub });
    const proj = makeTmp("proj");
    fs.mkdirSync(path.join(proj, ".git", "info"), { recursive: true });
    fs.writeFileSync(path.join(proj, ".git", "info", "exclude"), "", "utf8");
    fs.mkdirSync(path.join(proj, ".claude"), { recursive: true });
    writeSkill(path.join(home, ".agents", "skills", "cmdone"), "cmdone", "Desc", "CMD-BODY");
    // user-authored command file (no marker)
    const cmdFile = path.join(proj, ".claude", "commands", "cmdone.md");
    fs.mkdirSync(path.dirname(cmdFile), { recursive: true });
    fs.writeFileSync(cmdFile, "# My custom command\nUSER-CUSTOM-123\n", "utf8");
    mgr.setSkillScope({ id: "cmdone", scope: "project", projectRoot: proj });
    // user file untouched
    assert.equal(fs.readFileSync(cmdFile, "utf8"), "# My custom command\nUSER-CUSTOM-123\n");
    // off must NOT delete user file
    mgr.setSkillScope({ id: "cmdone", scope: "off", projectRoot: proj });
    assert.ok(fs.existsSync(cmdFile), "off must preserve user command file");
    assert.equal(fs.readFileSync(cmdFile, "utf8"), "# My custom command\nUSER-CUSTOM-123\n");

    // hub-managed file IS overwritten and DELETED
    const home2 = makeTmp("home2");
    const hub2 = path.join(home2, ".t3", "hub");
    const mgr2 = createSkillsManager({ homeDir: home2, hubDir: hub2 });
    const proj2 = makeTmp("proj2");
    fs.mkdirSync(path.join(proj2, ".git", "info"), { recursive: true });
    fs.writeFileSync(path.join(proj2, ".git", "info", "exclude"), "", "utf8");
    fs.mkdirSync(path.join(proj2, ".claude"), { recursive: true });
    writeSkill(path.join(home2, ".agents", "skills", "cmdtwo"), "cmdtwo", "Desc", "CMD2-BODY");
    mgr2.setSkillScope({ id: "cmdtwo", scope: "project", projectRoot: proj2 });
    const cmd2 = path.join(proj2, ".claude", "commands", "cmdtwo.md");
    const generated = fs.readFileSync(cmd2, "utf8");
    assert.ok(generated.includes("<!-- t3-hub-managed-skill -->"), "generated command must be stamped");
    mgr2.setSkillScope({ id: "cmdtwo", scope: "off", projectRoot: proj2 });
    assert.ok(!fs.existsSync(cmd2), "off must delete hub-managed command file");
  });

  it("safely replaces symlinks", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const mgr = createSkillsManager({ homeDir: home, hubDir: hub });
    const proj = makeTmp("proj");
    fs.mkdirSync(path.join(proj, ".git", "info"), { recursive: true });
    fs.writeFileSync(path.join(proj, ".git", "info", "exclude"), "", "utf8");
    fs.mkdirSync(path.join(proj, ".claude"), { recursive: true });
    writeSkill(path.join(home, ".agents", "skills", "symone"), "symone", "D", "SYM-BODY");
    // pre-place stray symlink at project target pointing elsewhere
    const elsewhere = makeTmp("else");
    fs.mkdirSync(path.join(elsewhere, "dir"), { recursive: true });
    fs.mkdirSync(path.join(proj, ".agents", "skills"), { recursive: true });
    fs.symlinkSync(path.join(elsewhere, "dir"), path.join(proj, ".agents", "skills", "symone"), "dir");
    const r = mgr.setSkillScope({ id: "symone", scope: "project", projectRoot: proj });
    assert.equal(r.ok, true);
    const link = path.join(proj, ".agents", "skills", "symone");
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.equal(fs.readlinkSync(link), path.join(hub, "skills", "symone"));
  });
});

describe("review #2 strict ID & containment", () => {
  it("rejects traversal, separators, null bytes, and non-conforming ids", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const mgr = createSkillsManager({ homeDir: home, hubDir: hub });
    const bad = [".", "..", "../evil", "a/b", "a\\b", "a\0b", "", "a..b", "-bad", ".bad", "a".repeat(129), "a b", "a;b", null, undefined, 123];
    for (const id of bad) {
      assert.throws(() => mgr.setSkillScope({ id, scope: "off" }), /invalid/i, "should reject id " + JSON.stringify(String(id)));
    }
    // traversal must not create anything outside
    const evil = path.join(home, ".agents", "evil");
    assert.ok(!fs.existsSync(evil));
  });

  it("accepts conforming ids", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const mgr = createSkillsManager({ homeDir: home, hubDir: hub });
    for (const id of ["a", "A1", "my.skill_v2", "x-1", "a".repeat(128)]) {
      const r = mgr.setSkillScope({ id, scope: "off" });
      assert.equal(r.ok, true, id);
    }
  });

  it("rejects bad subagent ids and does not write outside", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const mgr = createSubagentsManager({ homeDir: home, hubDir: hub });
    for (const id of ["..", "../evil", "a/b", "a\\b", "a\0b", ".", ""]) {
      assert.throws(() => mgr.saveSubagent({ scope: "global", item: { id, role: "general", providerInstanceId: "muse", model: "muse-ember-1.0", effort: "max", description: "x", systemPrompt: "y", enabled: true } }), /invalid|required/i, String(id));
    }
    // no file escaped to parent of .claude/agents
    assert.ok(!fs.existsSync(path.join(home, ".claude", "evil.md")));
    assert.ok(!fs.existsSync(path.join(home, "evil.md")));
  });
});

describe("review #3 memory vault same-basename collision", () => {
  it("isolates /work/client-a/app and /work/client-b/app", () => {
    const vaultDir = path.join(makeTmp("vault"), "vault");
    const homeTmp = makeTmp("home");
    const base = makeTmp("ws");
    const projA = path.join(base, "client-a", "app");
    const projB = path.join(base, "client-b", "app");
    fs.mkdirSync(projA, { recursive: true });
    fs.mkdirSync(projB, { recursive: true });
    const v = createMemoryVault({ vaultDir, homeDir: homeTmp });
    const rA = v.saveMemory({ projectRoot: projA, module: "constraints", kind: "constraint", title: "rule-a", content: "CLIENT-A-SECRET-NOTE 111" });
    assert.equal(rA.ok, true, JSON.stringify(rA));
    const rB = v.saveMemory({ projectRoot: projB, module: "constraints", kind: "constraint", title: "rule-b", content: "CLIENT-B-NOTE 222" });
    assert.equal(rB.ok, true, JSON.stringify(rB));
    // slugs must differ
    assert.notEqual(rA.item.projectSlug, rB.item.projectSlug);
    // isolation: listing B must not see A content
    const lB = v.listMemories({ projectRoot: projB, module: "constraints" });
    assert.ok(!lB.items.some((i) => i.content.includes("CLIENT-A-SECRET-NOTE")), "B must not leak A");
    const lA = v.listMemories({ projectRoot: projA, module: "constraints" });
    assert.ok(lA.items.some((i) => i.content.includes("CLIENT-A-SECRET-NOTE")));
    assert.ok(!lA.items.some((i) => i.content.includes("CLIENT-B-NOTE")));
    // meta projectRoot must match correctly
    const metaA = JSON.parse(fs.readFileSync(path.join(vaultDir, "projects", rA.item.projectSlug, "_meta.json"), "utf8"));
    const metaB = JSON.parse(fs.readFileSync(path.join(vaultDir, "projects", rB.item.projectSlug, "_meta.json"), "utf8"));
    assert.equal(normRoot(metaA.projectRoot), normRoot(projA));
    assert.equal(normRoot(metaB.projectRoot), normRoot(projB));
    // one keeps baseSlug "app", the other is app-<hash6>
    const slugs = [rA.item.projectSlug, rB.item.projectSlug].sort();
    assert.ok(slugs.includes("app"), "first vault keeps human-readable baseSlug: " + slugs);
    assert.ok(slugs.some((s) => /^app-[0-9a-f]{6}$/.test(s)), "second uses hash suffix: " + slugs);
    // scopeHash consistent
    assert.equal(metaA.scopeHash, scopeHashFor(normRoot(projA)));
    assert.equal(metaB.scopeHash, scopeHashFor(normRoot(projB)));
  });

  it("preserves baseSlug for pre-existing matching migrated vault", () => {
    const vaultDir = path.join(makeTmp("vault"), "vault");
    const homeTmp = makeTmp("home");
    const base = makeTmp("ws");
    const projA = path.join(base, "app");
    fs.mkdirSync(projA, { recursive: true });
    // simulate migrated vault: projects/app/_meta.json already for projA
    const dir = path.join(vaultDir, "projects", "app");
    fs.mkdirSync(dir, { recursive: true });
    const nA = normRoot(projA);
    fs.writeFileSync(path.join(dir, "_meta.json"), JSON.stringify({ slug: "app", title: "app", projectRoot: nA, scopeHash: scopeHashFor(nA), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }) + "\n", "utf8");
    const v = createMemoryVault({ vaultDir, homeDir: homeTmp });
    const r = v.saveMemory({ projectRoot: projA, module: "constraints", kind: "constraint", title: "t", content: "PRESERVE-CHECK 999" });
    assert.equal(r.ok, true);
    assert.equal(r.item.projectSlug, "app");
  });

  it("uses baseSlug when vault does not exist yet and writes meta", () => {
    const vaultDir = path.join(makeTmp("vault"), "vault");
    const homeTmp = makeTmp("home");
    const base = makeTmp("ws");
    const proj = path.join(base, "myproj");
    fs.mkdirSync(proj, { recursive: true });
    const v = createMemoryVault({ vaultDir, homeDir: homeTmp });
    const r = v.saveMemory({ projectRoot: proj, module: "constraints", kind: "constraint", title: "t", content: "FRESH-VAULT 555" });
    assert.equal(r.item.projectSlug, "myproj");
    const meta = JSON.parse(fs.readFileSync(path.join(vaultDir, "projects", "myproj", "_meta.json"), "utf8"));
    assert.equal(normRoot(meta.projectRoot), normRoot(proj));
    assert.ok(meta.scopeHash);
  });
});

describe("review #4 discovered MCP setMode persistence + bin fallback", () => {
  it("setMode persists discovered Magpie server into registry", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    fs.mkdirSync(path.join(home, ".config", "magpie"), { recursive: true });
    fs.writeFileSync(path.join(home, ".config", "magpie", "library.json"), JSON.stringify({ mcp: [{ name: "disc1", transport: "stdio", command: "node", args: ["/tmp/disc1.js"], env: {} }], icons: {} }), "utf8");
    const r = createMcpRouter({ homeDir: home, hubDir: hub });
    // registry empty initially
    assert.ok(!fs.existsSync(path.join(hub, "mcp-registry.json")) || !JSON.parse(fs.readFileSync(path.join(hub, "mcp-registry.json"), "utf8")).some((s) => s.name === "disc1"));
    const set = r.setMcpMode({ name: "disc1", mode: "global-lazy", projectRoot: null });
    assert.equal(set.ok, true);
    const reg = JSON.parse(fs.readFileSync(path.join(hub, "mcp-registry.json"), "utf8"));
    const found = Array.isArray(reg) ? reg.find((s) => s.name === "disc1") : reg.servers?.find((s) => s.name === "disc1");
    assert.ok(found, "discovered server must be persisted to registry on enable");
    assert.equal(found.command, "node");
    assert.deepEqual(found.args, ["/tmp/disc1.js"]);
    // listing still shows it
    const listed = r.listMcpServers({});
    assert.ok(listed.items.find((i) => i.name === "disc1"));
  });

  it("runtime router discovers enabled server even when registry entry missing (bin fallback)", async () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    fs.mkdirSync(hub, { recursive: true });
    const proj = makeTmp("proj");
    fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
    // mock upstream
    const mockFile = path.join(home, "mock.cjs");
    fs.writeFileSync(mockFile, `"use strict";\nlet buf="";\nprocess.stdin.on("data",(c)=>{buf+=c.toString("utf8");let i;while((i=buf.indexOf("\\n"))>=0){const line=buf.slice(0,i).trim();buf=buf.slice(i+1);if(!line)continue;let msg;try{msg=JSON.parse(line);}catch{continue;}if(msg.method==="initialize"){process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:msg.id,result:{protocolVersion:"2024-11-05",capabilities:{tools:{}},serverInfo:{name:"mock",version:"1"}}})+"\\n");}else if(msg.method==="tools/list"){process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:msg.id,result:{tools:[{name:"mtool",description:"d",inputSchema:{type:"object",properties:{}}}]}})+"\\n");}}});\n`, "utf8");
    // discovered via Magpie library
    fs.mkdirSync(path.join(home, ".config", "magpie"), { recursive: true });
    fs.writeFileSync(path.join(home, ".config", "magpie", "library.json"), JSON.stringify({ mcp: [{ name: "onlydisc", transport: "stdio", command: process.execPath, args: [mockFile] }], icons: {} }), "utf8");
    // state enables it, registry intentionally empty
    fs.writeFileSync(path.join(hub, "state.json"), JSON.stringify({ mcpModes: { global: { onlydisc: "global-lazy" }, projects: {} } }) + "\n", "utf8");
    fs.writeFileSync(path.join(hub, "mcp-registry.json"), JSON.stringify([]) + "\n", "utf8");
    const proc = spawn(ROUTER_BIN, [], { cwd: proj, env: { ...process.env, HOME: home, T3_HUB_DIR: hub }, stdio: ["pipe", "pipe", "inherit"] });
    try {
      const result = await new Promise((resolve, reject) => {
        let buf = "";
        let nextId = 1;
        const waiters = new Map();
        proc.stdout.on("data", (c) => {
          buf += c.toString("utf8");
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line) continue;
            try {
              const msg = JSON.parse(line);
              const w = waiters.get(msg.id);
              if (w) { waiters.delete(msg.id); w(msg); }
            } catch {}
          }
        });
        function req(method, params) {
          return new Promise((res, rej) => {
            const id = nextId++;
            waiters.set(id, (m) => { if (m.error) rej(new Error(m.error.message || JSON.stringify(m.error))); else res(m.result); });
            proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
            setTimeout(() => { if (waiters.has(id)) { waiters.delete(id); rej(new Error("timeout " + method)); } }, 10000);
          });
        }
        (async () => {
          await req("initialize", { protocolVersion: "2024-11-05" });
          proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
          const list = await req("tools/list", {});
          resolve(list);
        })().catch(reject);
      });
      const names = (result.tools || []).map((t) => t.name);
      assert.ok(names.includes("hub_list_mcp_tools"), "lazy discovered server must surface hub tools, got " + JSON.stringify(names));
    } finally {
      try { proc.stdin.end(); } catch {}
      setTimeout(() => { try { proc.kill(); } catch {} }, 300);
    }
  });
});

describe("review #5 registry perms & redaction", () => {
  it("writes registry with 0600", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    fs.mkdirSync(hub, { recursive: true });
    const r = createMcpRouter({ homeDir: home, hubDir: hub });
    r.upsertMcpServer({ name: "perm1", command: "node", args: ["/x"] });
    const rp = path.join(hub, "mcp-registry.json");
    const mode = (fs.statSync(rp).mode & 0o777).toString(8).padStart(4, "0");
    assert.equal(mode, "0600", "registry mode must be 0600, got " + mode);
    // setMode that persists discovered also secure
    fs.mkdirSync(path.join(home, ".config", "magpie"), { recursive: true });
    fs.writeFileSync(path.join(home, ".config", "magpie", "library.json"), JSON.stringify({ mcp: [{ name: "perm2", transport: "stdio", command: "node", args: ["/y"] }], icons: {} }), "utf8");
    r.setMcpMode({ name: "perm2", mode: "global-lazy" });
    const mode2 = (fs.statSync(rp).mode & 0o777).toString(8).padStart(4, "0");
    assert.equal(mode2, "0600");
  });

  it("redacts secrets from args and url in UI while keeping raw on disk", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const secret = "sk-" + "A".repeat(20);
    const gh = "gh" + "p_" + "B".repeat(24);
    const r = createMcpRouter({ homeDir: home, hubDir: hub });
    r.upsertMcpServer({
      name: "sec1",
      command: "node",
      args: ["--api-key=" + secret, "--token", gh, "normal", "--url", "https://user:pass123@host.example/mcp?api_key=key-123&token=tok-456&keep=1", "-H", "Authorization: Bearer supersecrettoken99"],
      url: "https://user:pass123@host.example/mcp?api_key=key-123&token=tok-456&keep=1",
    });
    const listed = r.listMcpServers({});
    const item = listed.items.find((i) => i.name === "sec1");
    assert.ok(item);
    const argsStr = JSON.stringify(item.args);
    const urlStr = String(item.url || "");
    // raw secrets must NOT appear in UI response
    assert.ok(!argsStr.includes(secret), "args must redact sk-");
    assert.ok(!argsStr.includes(gh), "args must redact ghp_ after --token");
    assert.ok(!argsStr.includes("pass123"), "url userinfo must be redacted");
    assert.ok(!argsStr.includes("key-123"), "args url query api_key must be redacted");
    assert.ok(!argsStr.includes("tok-456"));
    assert.ok(!argsStr.includes("supersecrettoken99"), "-H Authorization header must be redacted");
    assert.ok(!urlStr.includes("pass123"), "url userinfo must be redacted");
    assert.ok(!urlStr.includes("key-123") && !urlStr.includes("tok-456"));
    assert.ok(urlStr.includes("keep=1"), "non-secret query param preserved");
    assert.ok(argsStr.includes("***"), "redaction marker present");
    assert.ok(urlStr.includes("***"), "url redaction marker present");
    // raw on disk intact
    const raw = fs.readFileSync(path.join(hub, "mcp-registry.json"), "utf8");
    assert.ok(raw.includes(secret), "disk must keep raw secret");
    assert.ok(raw.includes(gh));
    assert.ok(raw.includes("pass123"));
  });
});

describe("review #6 AGENTS.md backup", () => {
  it("backs up project AGENTS.md once on save and excludes it", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const mgr = createSkillsManager({ homeDir: home, hubDir: hub });
    const proj = makeTmp("proj");
    fs.mkdirSync(path.join(proj, ".git", "info"), { recursive: true });
    fs.writeFileSync(path.join(proj, ".git", "info", "exclude"), "", "utf8");
    fs.writeFileSync(path.join(proj, "AGENTS.md"), "ORIGINAL-PROJ\n", "utf8");
    mgr.saveAgentsMd({ target: "project", content: "# New\n", expectedContent: "ORIGINAL-PROJ\n", projectRoot: proj });
    assert.equal(fs.readFileSync(path.join(proj, "AGENTS.md"), "utf8"), "# New\n");
    assert.equal(fs.readFileSync(path.join(proj, "AGENTS.md.bak-t3hub"), "utf8"), "ORIGINAL-PROJ\n");
    const excl = fs.readFileSync(path.join(proj, ".git", "info", "exclude"), "utf8");
    assert.ok(excl.includes("AGENTS.md.bak-t3hub"), "exclude must contain backup name");
    mgr.saveAgentsMd({ target: "project", content: "# New2\n", expectedContent: "# New\n", projectRoot: proj });
    assert.equal(fs.readFileSync(path.join(proj, "AGENTS.md.bak-t3hub"), "utf8"), "ORIGINAL-PROJ\n", "backup must remain one-time original");
  });

  it("backs up before injectSoftRoute", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const mgr = createSkillsManager({ homeDir: home, hubDir: hub });
    const proj = makeTmp("proj");
    fs.mkdirSync(path.join(proj, ".git", "info"), { recursive: true });
    fs.writeFileSync(path.join(proj, ".git", "info", "exclude"), "", "utf8");
    fs.writeFileSync(path.join(proj, "AGENTS.md"), "BEFORE-ROUTE\n", "utf8");
    mgr.injectSoftRoute({ projectRoot: proj });
    assert.equal(fs.readFileSync(path.join(proj, "AGENTS.md.bak-t3hub"), "utf8"), "BEFORE-ROUTE\n");
    assert.ok(fs.readFileSync(path.join(proj, "AGENTS.md"), "utf8").includes("t3-hub-memory-route"));
  });
});

describe("review #7 updatePackage strict match", () => {
  it("returns Package not found for unknown id without touching other packages", async () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const mgr = createSkillsManager({ homeDir: home, hubDir: hub });
    fs.mkdirSync(path.join(hub, "packages", "owner__real"), { recursive: true });
    fs.writeFileSync(path.join(hub, "packages", "owner__real", "keep.txt"), "KEEP", "utf8");
    const res = await mgr.updatePackage({ id: "owner__missing" });
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.ok(String(res.error || "").includes("Package not found"), JSON.stringify(res));
    // other package untouched
    assert.equal(fs.readFileSync(path.join(hub, "packages", "owner__real", "keep.txt"), "utf8"), "KEEP");
    // also via owner/repo form
    const res2 = await mgr.updatePackage({ id: "owner/missing" });
    assert.equal(res2.ok, false);
    assert.ok(String(res2.error || "").includes("Package not found"));
  });

  it("still updates exact package", async () => {
    // covered by existing offline import/update test; here just check exact dir is found (not git required to prove matching, use a fake git package with .git dir so it attempts pull only for exact)
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const mgr = createSkillsManager({ homeDir: home, hubDir: hub });
    fs.mkdirSync(path.join(hub, "packages", "o__r", ".git"), { recursive: true });
    // exact match should NOT return Package not found (it will attempt git pull; may fail due to no remote, but must not say Package not found)
    await assert.rejects(() => mgr.updatePackage({ id: "o__r" }), /not a git package|Command failed|git/i);
  });
});

describe("sidecar-code-review-2 #1 redact summary in MCP server list", () => {
  it("summary built only from redactArgs/redactUrl never leaks secrets", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const r = createMcpRouter({ homeDir: home, hubDir: hub });
    r.upsertMcpServer({
      name: "leaksum",
      command: "node",
      args: ["--token", "example-secret", "serve"],
      url: "https://user:pass@host/mcp?api_key=xyz&keep=1",
      env: { NORMAL: "visibleval", MY_TOKEN: "env-secret-999" },
    });
    const listed = r.listMcpServers({});
    const item = listed.items.find((i) => i.name === "leaksum");
    assert.ok(item, "expected leaksum listed");
    const summary = String(item.summary || "");
    assert.ok(!summary.includes("example-secret"), "summary must not leak --token value, got: " + summary);
    assert.ok(!summary.includes("user:pass"), "summary must not leak url user:pass, got: " + summary);
    assert.ok(!summary.includes("api_key=xyz"), "summary must not leak api_key query, got: " + summary);
    assert.ok(!summary.includes("env-secret-999"), "summary must not leak secret env value, got: " + summary);
    assert.ok(summary.includes("***"), "summary must contain redaction marker");
    // command variant: secret embedded in command string must also be redacted
    r.upsertMcpServer({ name: "cmdleak", command: "node --token example-secret serve", args: [], url: null });
    const listed2 = r.listMcpServers({});
    const cmdItem = listed2.items.find((i) => i.name === "cmdleak");
    assert.ok(cmdItem);
    assert.ok(!String(cmdItem.summary || "").includes("example-secret"), "summary must not leak command secret, got: " + cmdItem.summary);
    // args: redactArgs itself must not leak
    assert.ok(!JSON.stringify(item.args).includes("example-secret"));
    assert.ok(!String(item.url || "").includes("xyz"));
  });
});

describe("sidecar-code-review-2 #2 verify process identity before SIGTERM", () => {
  function isAlive(pid) {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }
  async function waitForDead(pid, ms = 3000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (!isAlive(pid)) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return !isAlive(pid);
  }
  function makeEmbedOpts(home, hub, port, extra = {}) {
    return {
      homeDir: home,
      hubDir: hub,
      configPath: path.join(hub, "embed-config.json"),
      cacheDir: path.join(home, "cache"),
      port,
      pidPath: path.join(hub, "embed-server.pid"),
      logPath: path.join(hub, "logs", "embed-server.log"),
      ...extra,
    };
  }

  it("pidfile: does NOT kill unrelated process (no embed-server.py in cmdline)", async () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    fs.mkdirSync(hub, { recursive: true });
    const port = 21000 + Math.floor(Math.random() * 5000);
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 150));
      assert.ok(isAlive(child.pid), "sleep should be alive");
      fs.writeFileSync(path.join(hub, "embed-server.pid"), String(child.pid) + "\n", "utf8");
      const mgr = createEmbedManager(makeEmbedOpts(home, hub, port));
      const stop = mgr.stopServer || mgr._stopServer;
      assert.ok(typeof stop === "function", "manager must expose stopServer/_stopServer for identity check");
      stop.call(mgr);
      await new Promise((r) => setTimeout(r, 150));
      assert.ok(isAlive(child.pid), "unrelated sleep process must NOT be SIGTERM'd (PID reuse guard)");
    } finally {
      try { child.kill("SIGKILL"); } catch {}
    }
  });

  it("pidfile: DOES kill fake embed-server.py process", async () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    fs.mkdirSync(hub, { recursive: true });
    const port = 21000 + Math.floor(Math.random() * 5000);
    const fakeScript = path.join(home, "embed-server.py");
    fs.writeFileSync(fakeScript, "setTimeout(() => {}, 30000);\n", "utf8");
    const child = spawn(process.execPath, [fakeScript], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 200));
      assert.ok(isAlive(child.pid));
      fs.writeFileSync(path.join(hub, "embed-server.pid"), String(child.pid) + "\n", "utf8");
      const mgr = createEmbedManager(makeEmbedOpts(home, hub, port));
      const stop = mgr.stopServer || mgr._stopServer;
      assert.ok(typeof stop === "function");
      stop.call(mgr);
      assert.ok(await waitForDead(child.pid, 4000), "fake embed-server.py must be SIGTERM'd via pidfile");
    } finally {
      try { child.kill("SIGKILL"); } catch {}
    }
  });

  it("lsof port fallback: does NOT kill unrelated listener", async () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    fs.mkdirSync(hub, { recursive: true });
    const port = 21000 + Math.floor(Math.random() * 5000);
    const listener = path.join(home, "plain-listener.cjs");
    fs.writeFileSync(listener, `const http = require("http");\nhttp.createServer((q, s) => { s.end("{}"); }).listen(${port}, "127.0.0.1");\nsetTimeout(() => {}, 30000);\n`, "utf8");
    const child = spawn(process.execPath, [listener], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 300));
      assert.ok(isAlive(child.pid), "listener should be up");
      const mgr = createEmbedManager(makeEmbedOpts(home, hub, port));
      const stop = mgr.stopServer || mgr._stopServer;
      assert.ok(typeof stop === "function");
      stop.call(mgr);
      await new Promise((r) => setTimeout(r, 200));
      assert.ok(isAlive(child.pid), "unrelated port listener must NOT be killed via lsof");
    } finally {
      try { child.kill("SIGKILL"); } catch {}
    }
  });

  it("lsof port fallback: DOES kill embed-server.py listener", async () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    fs.mkdirSync(hub, { recursive: true });
    const port = 21000 + Math.floor(Math.random() * 5000);
    const fakeScript = path.join(home, "embed-server.py");
    fs.writeFileSync(fakeScript, `const http = require("http");\nhttp.createServer((q, s) => { s.end("{}"); }).listen(${port}, "127.0.0.1");\nsetTimeout(() => {}, 30000);\n`, "utf8");
    const child = spawn(process.execPath, [fakeScript], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 350));
      assert.ok(isAlive(child.pid));
      const mgr = createEmbedManager(makeEmbedOpts(home, hub, port));
      const stop = mgr.stopServer || mgr._stopServer;
      assert.ok(typeof stop === "function");
      stop.call(mgr);
      assert.ok(await waitForDead(child.pid, 4000), "embed listener must be killed via lsof");
    } finally {
      try { child.kill("SIGKILL"); } catch {}
    }
  });

  it("allowedKillPattern / serverScriptPath opts allow custom test script", async () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    fs.mkdirSync(hub, { recursive: true });
    const portA = 21000 + Math.floor(Math.random() * 4000);
    const custom = path.join(home, "my-vector-script.cjs");
    fs.writeFileSync(custom, "setTimeout(() => {}, 30000);\n", "utf8");
    // without opts: custom script must NOT be killed
    const c1 = spawn(process.execPath, [custom], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 200));
      assert.ok(isAlive(c1.pid));
      fs.writeFileSync(path.join(hub, "embed-server.pid"), String(c1.pid) + "\n", "utf8");
      const mgrPlain = createEmbedManager(makeEmbedOpts(home, hub, portA));
      const stopPlain = mgrPlain.stopServer || mgrPlain._stopServer;
      assert.ok(typeof stopPlain === "function");
      stopPlain.call(mgrPlain);
      await new Promise((r) => setTimeout(r, 150));
      assert.ok(isAlive(c1.pid), "custom script without allowedKillPattern must NOT be killed");
    } finally {
      try { c1.kill("SIGKILL"); } catch {}
    }
    // with allowedKillPattern: custom script must be killed
    const c2 = spawn(process.execPath, [custom], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 200));
      assert.ok(isAlive(c2.pid));
      fs.writeFileSync(path.join(hub, "embed-server.pid"), String(c2.pid) + "\n", "utf8");
      const mgrAllow = createEmbedManager(makeEmbedOpts(home, hub, portA, { allowedKillPattern: custom }));
      const stopAllow = mgrAllow.stopServer || mgrAllow._stopServer;
      assert.ok(typeof stopAllow === "function");
      stopAllow.call(mgrAllow);
      assert.ok(await waitForDead(c2.pid, 4000), "custom script with allowedKillPattern must be killed");
    } finally {
      try { c2.kill("SIGKILL"); } catch {}
    }
    // with serverScriptPath: same expectation
    const c3 = spawn(process.execPath, [custom], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 200));
      assert.ok(isAlive(c3.pid));
      fs.writeFileSync(path.join(hub, "embed-server.pid"), String(c3.pid) + "\n", "utf8");
      const mgrPath = createEmbedManager(makeEmbedOpts(home, hub, portA, { serverScriptPath: custom }));
      const stopPath = mgrPath.stopServer || mgrPath._stopServer;
      assert.ok(typeof stopPath === "function");
      stopPath.call(mgrPath);
      assert.ok(await waitForDead(c3.pid, 4000), "custom script with serverScriptPath must be killed");
    } finally {
      try { c3.kill("SIGKILL"); } catch {}
    }
  });
});

describe("sidecar-code-review-2 #3 never delete original if backup fails", () => {
  it("file: backup failure must throw and preserve original (no unlink)", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    writeSkill(path.join(hub, "skills", "filekeep"), "filekeep", "Canon", "CANON-FILE");
    const globalLink = path.join(home, ".agents", "skills", "filekeep");
    fs.mkdirSync(path.dirname(globalLink), { recursive: true });
    fs.writeFileSync(globalLink, "USER-FILE-CONTENT-abc123\n", "utf8");
    const mgr = createSkillsManager({ homeDir: home, hubDir: hub });
    const origRename = fs.renameSync;
    const origCopy = fs.copyFileSync;
    const fail = (src, dst) => {
      const s = String(src), d = String(dst);
      if (s.startsWith(globalLink) || d.startsWith(globalLink)) {
        const e = new Error("EACCES: mocked backup failure");
        e.code = "EACCES";
        throw e;
      }
      return origRename(src, dst);
    };
    const failCopy = (src, dst) => {
      const s = String(src), d = String(dst);
      if (s.startsWith(globalLink) || d.startsWith(globalLink)) {
        const e = new Error("EACCES: mocked backup failure");
        e.code = "EACCES";
        throw e;
      }
      return origCopy(src, dst);
    };
    fs.renameSync = fail;
    fs.copyFileSync = failCopy;
    try {
      assert.throws(() => mgr.setSkillScope({ id: "filekeep", scope: "global" }), /EACCES|mocked/i, "backup failure must propagate");
    } finally {
      fs.renameSync = origRename;
      fs.copyFileSync = origCopy;
    }
    assert.ok(fs.existsSync(globalLink), "original file must be preserved when backup fails");
    assert.equal(fs.readFileSync(globalLink, "utf8"), "USER-FILE-CONTENT-abc123\n");
    assert.ok(!fs.lstatSync(globalLink).isSymbolicLink(), "failed backup must not replace file with symlink");
    assert.ok(fs.readFileSync(path.join(hub, "skills", "filekeep", "SKILL.md"), "utf8").includes("CANON-FILE"));
  });

  it("dir: backup failure must throw backup error and preserve original (no rm)", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    writeSkill(path.join(hub, "skills", "dirkeep"), "dirkeep", "Canon", "CANON-DIR");
    writeSkill(path.join(home, ".agents", "skills", "dirkeep"), "dirkeep", "User", "USER-DIR-CONTENT-xyz");
    const globalLink = path.join(home, ".agents", "skills", "dirkeep");
    const mgr = createSkillsManager({ homeDir: home, hubDir: hub });
    const origRename = fs.renameSync;
    const origCopy = fs.copyFileSync;
    fs.renameSync = function (src, dst) {
      if (String(src) === globalLink || String(src).startsWith(globalLink)) {
        const e = new Error("EACCES: mocked backup failure");
        e.code = "EACCES";
        throw e;
      }
      return origRename(src, dst);
    };
    fs.copyFileSync = function (src, dst) {
      if (String(src).startsWith(globalLink) || String(dst).startsWith(globalLink)) {
        const e = new Error("EACCES: mocked backup failure");
        e.code = "EACCES";
        throw e;
      }
      return origCopy(src, dst);
    };
    try {
      assert.throws(() => mgr.setSkillScope({ id: "dirkeep", scope: "global" }), /EACCES|mocked/i, "backup failure must propagate (not a symlink EEXIST from swallowed backup)");
    } finally {
      fs.renameSync = origRename;
      fs.copyFileSync = origCopy;
    }
    assert.ok(fs.existsSync(path.join(globalLink, "SKILL.md")), "original dir must be preserved");
    assert.ok(fs.readFileSync(path.join(globalLink, "SKILL.md"), "utf8").includes("USER-DIR-CONTENT-xyz"));
    assert.ok(fs.readFileSync(path.join(hub, "skills", "dirkeep", "SKILL.md"), "utf8").includes("CANON-DIR"));
  });
});

describe("sidecar-code-review-2 #4 external symlinks are not Hub-managed", () => {
  it("ensureSymlink backs up external symlink via rename (project scope)", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const mgr = createSkillsManager({ homeDir: home, hubDir: hub });
    const proj = makeTmp("proj");
    fs.mkdirSync(path.join(proj, ".git", "info"), { recursive: true });
    fs.writeFileSync(path.join(proj, ".git", "info", "exclude"), "", "utf8");
    fs.mkdirSync(path.join(proj, ".claude"), { recursive: true });
    writeSkill(path.join(home, ".agents", "skills", "ext1"), "ext1", "D", "EXT1-BODY");
    const elsewhere = makeTmp("else");
    const extTarget = path.join(elsewhere, "dir");
    writeSkill(extTarget, "other", "Other", "EXTERNAL-TARGET-BODY");
    fs.mkdirSync(path.join(proj, ".agents", "skills"), { recursive: true });
    const projLink = path.join(proj, ".agents", "skills", "ext1");
    fs.symlinkSync(extTarget, projLink, "dir");
    const r = mgr.setSkillScope({ id: "ext1", scope: "project", projectRoot: proj });
    assert.equal(r.ok, true);
    assert.ok(fs.lstatSync(projLink).isSymbolicLink());
    assert.equal(fs.readlinkSync(projLink), path.join(hub, "skills", "ext1"));
    const parent = path.join(proj, ".agents", "skills");
    const backups = listBackups(parent, "ext1.bak-t3hub-");
    assert.ok(backups.length >= 1, "external symlink must be backed up via rename, got none. dir: " + fs.readdirSync(parent).join(","));
    const bakLink = path.join(parent, backups[0]);
    assert.ok(fs.lstatSync(bakLink).isSymbolicLink(), "backup must preserve symlink");
    assert.equal(fs.readlinkSync(bakLink), extTarget, "backup must preserve original external target");
    assert.ok(fs.readFileSync(path.join(extTarget, "SKILL.md"), "utf8").includes("EXTERNAL-TARGET-BODY"), "external target must stay intact");
  });

  it("off does NOT unlink external non-Hub symlink at global target", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    writeSkill(path.join(hub, "skills", "extoff"), "extoff", "Canon", "CANON-OFF");
    const elsewhere = makeTmp("else");
    const extTarget = path.join(elsewhere, "dir");
    writeSkill(extTarget, "extoff", "User", "EXTERNAL-OFF-BODY");
    const globalLink = path.join(home, ".agents", "skills", "extoff");
    fs.mkdirSync(path.dirname(globalLink), { recursive: true });
    fs.symlinkSync(extTarget, globalLink, "dir");
    const mgr = createSkillsManager({ homeDir: home, hubDir: hub });
    mgr.setSkillScope({ id: "extoff", scope: "off" });
    assert.ok(fs.lstatSync(globalLink).isSymbolicLink(), "external symlink must NOT be unlinked on off");
    assert.equal(fs.readlinkSync(globalLink), extTarget);
    assert.ok(fs.readFileSync(path.join(extTarget, "SKILL.md"), "utf8").includes("EXTERNAL-OFF-BODY"));
    assert.ok(fs.readFileSync(path.join(hub, "skills", "extoff", "SKILL.md"), "utf8").includes("CANON-OFF"));
  });

  it("off removes Hub-managed symlink but preserves external", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    writeSkill(path.join(home, ".agents", "skills", "managed1"), "managed1", "D", "MANAGED-BODY");
    const mgr = createSkillsManager({ homeDir: home, hubDir: hub });
    mgr.setSkillScope({ id: "managed1", scope: "global" });
    const globalLink = path.join(home, ".agents", "skills", "managed1");
    assert.ok(fs.lstatSync(globalLink).isSymbolicLink());
    assert.equal(fs.readlinkSync(globalLink), path.join(hub, "skills", "managed1"));
    mgr.setSkillScope({ id: "managed1", scope: "off" });
    assert.ok(!fs.existsSync(globalLink), "hub-managed symlink must be removed on off");
    // external still preserved in same home after off
    const elsewhere = makeTmp("else");
    const extTarget = path.join(elsewhere, "dir2");
    writeSkill(extTarget, "ext2", "U", "EXTERNAL-KEEP-2");
    const extLink = path.join(home, ".agents", "skills", "ext2");
    writeSkill(path.join(hub, "skills", "ext2"), "ext2", "C", "CANON-EXT2");
    fs.symlinkSync(extTarget, extLink, "dir");
    mgr.setSkillScope({ id: "ext2", scope: "off" });
    assert.ok(fs.lstatSync(extLink).isSymbolicLink(), "external ext2 must survive off");
    assert.equal(fs.readlinkSync(extLink), extTarget);
  });

  it("off adoption: external symlink preserved, canonical adopts target content", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const elsewhere = makeTmp("else");
    const extTarget = path.join(elsewhere, "dir");
    writeSkill(extTarget, "adoptlo", "User", "ADOPT-LINK-BODY");
    const globalLink = path.join(home, ".agents", "skills", "adoptlo");
    fs.mkdirSync(path.dirname(globalLink), { recursive: true });
    fs.symlinkSync(extTarget, globalLink, "dir");
    const mgr = createSkillsManager({ homeDir: home, hubDir: hub });
    // canonical initially missing; off should adopt external target into canonical without losing the link
    mgr.setSkillScope({ id: "adoptlo", scope: "off" });
    const canonical = path.join(hub, "skills", "adoptlo");
    assert.ok(fs.readFileSync(path.join(canonical, "SKILL.md"), "utf8").includes("ADOPT-LINK-BODY"), "canonical must adopt external target content");
    assert.ok(fs.readFileSync(path.join(extTarget, "SKILL.md"), "utf8").includes("ADOPT-LINK-BODY"), "external target must never be lost");
    const stillLink = fs.existsSync(globalLink) && fs.lstatSync(globalLink).isSymbolicLink();
    const backups = listBackups(path.dirname(globalLink), "adoptlo.bak-t3hub-");
    assert.ok(stillLink || backups.length >= 1, "external symlink must be left or backed up (never silently unlinked)");
    if (stillLink) assert.equal(fs.readlinkSync(globalLink), extTarget);
  });

  it("command file external symlink: project write backs up, off preserves", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const mgr = createSkillsManager({ homeDir: home, hubDir: hub });
    const proj = makeTmp("proj");
    fs.mkdirSync(path.join(proj, ".git", "info"), { recursive: true });
    fs.writeFileSync(path.join(proj, ".git", "info", "exclude"), "", "utf8");
    fs.mkdirSync(path.join(proj, ".claude"), { recursive: true });
    writeSkill(path.join(home, ".agents", "skills", "cmdlink"), "cmdlink", "D", "CMDLINK-BODY");
    const elsewhere = makeTmp("else");
    const extFile = path.join(elsewhere, "external-cmd.md");
    fs.writeFileSync(extFile, "# External custom\nEXTERNAL-CMD-777\n", "utf8");
    const cmdFile = path.join(proj, ".claude", "commands", "cmdlink.md");
    fs.mkdirSync(path.dirname(cmdFile), { recursive: true });
    fs.symlinkSync(extFile, cmdFile);
    mgr.setSkillScope({ id: "cmdlink", scope: "project", projectRoot: proj });
    // after project scope, cmd file must be a managed regular file (external backed up), external target intact
    assert.ok(!fs.lstatSync(cmdFile).isSymbolicLink(), "cmd file should be managed regular file after project scope");
    assert.ok(fs.readFileSync(cmdFile, "utf8").includes("<!-- t3-hub-managed-skill -->"));
    assert.equal(fs.readFileSync(extFile, "utf8"), "# External custom\nEXTERNAL-CMD-777\n", "external cmd target must stay intact");
    const backups = listBackups(path.dirname(cmdFile), "cmdlink.md.bak-t3hub-");
    assert.ok(backups.length >= 1, "external cmd symlink must be backed up via rename, got: " + fs.readdirSync(path.dirname(cmdFile)).join(","));
    assert.ok(fs.lstatSync(path.join(path.dirname(cmdFile), backups[0])).isSymbolicLink());
    assert.equal(fs.readlinkSync(path.join(path.dirname(cmdFile), backups[0])), extFile);
    // off on managed file deletes it (existing behavior) — but external backup must remain
    mgr.setSkillScope({ id: "cmdlink", scope: "off", projectRoot: proj });
    assert.ok(!fs.existsSync(cmdFile), "managed cmd file removed on off");
    assert.ok(fs.existsSync(path.join(path.dirname(cmdFile), backups[0])), "external backup must survive off");
  });

  it("off preserves external command symlink (does not delete user link)", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    writeSkill(path.join(hub, "skills", "cmdkeep"), "cmdkeep", "Canon", "CANON-CMD");
    const proj = makeTmp("proj");
    fs.mkdirSync(path.join(proj, ".git", "info"), { recursive: true });
    fs.writeFileSync(path.join(proj, ".git", "info", "exclude"), "", "utf8");
    fs.mkdirSync(path.join(proj, ".claude"), { recursive: true });
    const elsewhere = makeTmp("else");
    const extFile = path.join(elsewhere, "ext-keep.md");
    fs.writeFileSync(extFile, "# External keep\nEXTERNAL-KEEP-CMD\n", "utf8");
    const cmdFile = path.join(proj, ".claude", "commands", "cmdkeep.md");
    fs.mkdirSync(path.dirname(cmdFile), { recursive: true });
    fs.symlinkSync(extFile, cmdFile);
    const mgr = createSkillsManager({ homeDir: home, hubDir: hub });
    mgr.setSkillScope({ id: "cmdkeep", scope: "off", projectRoot: proj });
    assert.ok(fs.lstatSync(cmdFile).isSymbolicLink(), "external cmd symlink must survive off");
    assert.equal(fs.readlinkSync(cmdFile), extFile);
    assert.equal(fs.readFileSync(extFile, "utf8"), "# External keep\nEXTERNAL-KEEP-CMD\n");
  });
});

describe("sidecar-code-review-2 #5 global mode clears stale project off", () => {
  it("global-lazy after project off takes effect in projectRoot (off override deleted)", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const r = createMcpRouter({ homeDir: home, hubDir: hub });
    r.upsertMcpServer({ name: "srvlazy", command: "node", args: ["/x"] });
    const proj = makeTmp("proj");
    // stale project off
    r.setMcpMode({ name: "srvlazy", mode: "off", projectRoot: proj });
    let listed = r.listMcpServers({ projectRoot: proj });
    assert.equal(listed.items.find((i) => i.name === "srvlazy").mode, "off");
    // switch to global-lazy with projectRoot present
    r.setMcpMode({ name: "srvlazy", mode: "global-lazy", projectRoot: proj });
    listed = r.listMcpServers({ projectRoot: proj });
    assert.equal(listed.items.find((i) => i.name === "srvlazy").mode, "global-lazy", "global-lazy must take effect immediately, not masked by stale project off");
    const state = JSON.parse(fs.readFileSync(path.join(hub, "state.json"), "utf8"));
    assert.ok(!state.mcpModes?.projects?.[normRoot(proj)]?.srvlazy, "stale project off entry must be deleted");
    assert.equal(state.mcpModes?.global?.srvlazy, "global-lazy");
    assert.equal(r.listMcpServers({}).items.find((i) => i.name === "srvlazy").mode, "global-lazy");
  });

  it("global-direct also clears stale project off", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const r = createMcpRouter({ homeDir: home, hubDir: hub });
    r.upsertMcpServer({ name: "srvdir", command: "node", args: ["/y"] });
    const proj = makeTmp("proj");
    r.setMcpMode({ name: "srvdir", mode: "off", projectRoot: proj });
    assert.equal(r.listMcpServers({ projectRoot: proj }).items.find((i) => i.name === "srvdir").mode, "off");
    r.setMcpMode({ name: "srvdir", mode: "global-direct", projectRoot: proj });
    assert.equal(r.listMcpServers({ projectRoot: proj }).items.find((i) => i.name === "srvdir").mode, "global-direct");
    const state = JSON.parse(fs.readFileSync(path.join(hub, "state.json"), "utf8"));
    assert.ok(!state.mcpModes?.projects?.[normRoot(proj)]?.srvdir);
  });

  it("global switch without projectRoot does not clear other project off entries", () => {
    const home = makeTmp("home");
    const hub = path.join(home, ".t3", "hub");
    const r = createMcpRouter({ homeDir: home, hubDir: hub });
    r.upsertMcpServer({ name: "srvkeep", command: "node", args: ["/z"] });
    const proj = makeTmp("proj");
    r.setMcpMode({ name: "srvkeep", mode: "off", projectRoot: proj });
    r.setMcpMode({ name: "srvkeep", mode: "global-lazy" });
    const state = JSON.parse(fs.readFileSync(path.join(hub, "state.json"), "utf8"));
    assert.equal(state.mcpModes?.projects?.[normRoot(proj)]?.srvkeep, "off", "no projectRoot => keep canonical project override");
    assert.equal(r.listMcpServers({ projectRoot: proj }).items.find((i) => i.name === "srvkeep").mode, "off");
    assert.equal(r.listMcpServers({}).items.find((i) => i.name === "srvkeep").mode, "global-lazy");
  });
});

describe('remaining review regressions', () => {
  it('preserves an external symlink when disabling an existing canonical skill', () => {
    const home = makeTmp('external'); const hub = path.join(home, 'hub');
    const external = path.join(home, 'external'); writeSkill(external, 'keep', 'external');
    writeSkill(path.join(hub, 'skills', 'keep'), 'keep', 'canonical');
    const link = path.join(home, '.agents', 'skills', 'keep'); fs.mkdirSync(path.dirname(link), {recursive:true}); fs.symlinkSync(external, link);
    createSkillsManager({homeDir:home, hubDir:hub}).setSkillScope({id:'keep', scope:'off'});
    assert.equal(fs.readlinkSync(link), external);
  });
  it('backs up an external symlink on replacement', () => {
    const home = makeTmp('replace'); const hub = path.join(home, 'hub');
    const external = path.join(home, 'external'); writeSkill(external, 'keep', 'external');
    writeSkill(path.join(hub, 'skills', 'keep'), 'keep', 'canonical');
    const link = path.join(home, '.agents', 'skills', 'keep'); fs.mkdirSync(path.dirname(link), {recursive:true}); fs.symlinkSync(external, link);
    createSkillsManager({homeDir:home, hubDir:hub}).setSkillScope({id:'keep', scope:'global'});
    const backup = listBackups(path.dirname(link), 'keep.bak-t3hub-'); assert.equal(backup.length, 1); assert.equal(fs.readlinkSync(path.join(path.dirname(link),backup[0])), external);
  });
});
