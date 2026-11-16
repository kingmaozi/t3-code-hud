"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createSkillsManager, parseGitHubInput } = require("../src/hub-skills.cjs");
const { createPluginsManager, findIconDataUri, pluginIcon } = require("../src/hub-plugins.cjs");
const { createTaskBoard, gcTaskPlans } = require("../src/hub-task-board.cjs");

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof text === "string" ? text : JSON.stringify(text));
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hub-path-safety-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homeDir = path.join(root, "home"), hubDir = path.join(homeDir, ".t3", "hub");
  const victim = path.join(root, "victim");
  write(path.join(victim, "keep.txt"), "untouched");
  fs.mkdirSync(homeDir, { recursive: true });
  return { root, homeDir, hubDir, victim, skills: createSkillsManager({ homeDir, hubDir }) };
}
function intact(f) { assert.equal(fs.readFileSync(path.join(f.victim, "keep.txt"), "utf8"), "untouched"); }
function link(target, file) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.symlinkSync(target, file); }
function gitRepo(dir) {
  execFileSync("git", ["init", dir], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "add", "."], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"], { stdio: "pipe" });
}
function plugins(f, overrides = {}) { return createPluginsManager({ ...f, skillsManager: f.skills, mcpRouter: { setPluginMcpScope: () => ({ skippedMcps: [] }) }, hooksManager: {}, ...overrides }); }
function board(f, hubPlansDir = path.join(f.hubDir, "task-plans")) { return createTaskBoard({ homeDir: f.homeDir, hubPlansDir, t3DbPath: path.join(f.root, "absent.sqlite"), agyBrainDirs: [] }); }
const badIds = ["a/../../victim", "a/../../../victim", "a/../../../../../victim", "../victim", "a\\..\\victim", "owner/../victim", "owner//repo", "/victim", "owner/", ".", "..", "a\0b", "a b", {}, 12];

test("packages reject every malformed ID on remove and update without touching a victim", async t => {
  const f = fixture(t);
  // Three '..' components escape packages after the first slash is replaced.
  write(path.join(f.hubDir, "victim", "keep.txt"), "hub-victim");
  write(path.join(f.homeDir, "victim", "keep.txt"), "home-victim");
  for (const id of badIds) {
    await assert.rejects(f.skills.removePackage({ id }), /invalid|id required/);
    await assert.rejects(f.skills.updatePackage({ id }), /invalid|id required/);
    intact(f);
    assert.equal(fs.readFileSync(path.join(f.hubDir, "victim", "keep.txt"), "utf8"), "hub-victim");
    assert.equal(fs.readFileSync(path.join(f.homeDir, "victim", "keep.txt"), "utf8"), "home-victim");
  }
});

test("package root symlink is unlinked without reading or deleting its external target", async t => {
  const f = fixture(t), pkg = path.join(f.hubDir, "packages", "owner__repo");
  write(path.join(f.victim, "SKILL.md"), "# external skill");
  link(f.victim, pkg);
  await assert.rejects(f.skills.updatePackage({ id: "owner/repo" }), /symlink|symbolic|unsafe/);
  const res = await f.skills.removePackage({ id: "owner/repo" });
  assert.equal(res.ok, true); assert.deepEqual(res.removedSkills, []);
  assert.equal(fs.existsSync(pkg), false); intact(f);
  assert.equal(fs.existsSync(path.join(f.victim, "SKILL.md")), true);
});

test("dangling package symlink is removed, and nested links never remove their targets", async t => {
  const f = fixture(t), pkg = path.join(f.hubDir, "packages", "owner__repo");
  link(path.join(f.root, "missing"), pkg);
  await f.skills.removePackage({ id: "owner__repo" });
  assert.throws(() => fs.lstatSync(pkg), /ENOENT/);
  link(f.victim, path.join(pkg, "nested"));
  await f.skills.removePackage({ id: "owner__repo" });
  assert.equal(fs.existsSync(pkg), false); intact(f);
});

test("package store symlink blocks remove, update and import before external IO", async t => {
  const f = fixture(t); link(f.victim, path.join(f.hubDir, "packages"));
  write(path.join(f.victim, "owner__repo", "SKILL.md"), "# keep");
  for (const op of [() => f.skills.removePackage({ id: "owner/repo" }), () => f.skills.updatePackage({ id: "owner/repo" }), () => f.skills.importFromGitHub({ repoInput: "owner/repo", scope: "off" })]) await assert.rejects(op(), /symlink|symbolic|unsafe/);
  assert.equal(fs.existsSync(path.join(f.victim, "owner__repo", "SKILL.md")), true); intact(f);
});

test("package import and update reject a linked .git directory", async t => {
  const f = fixture(t), pkg = path.join(f.hubDir, "packages", "owner__repo");
  link(f.victim, path.join(pkg, ".git"));
  await assert.rejects(f.skills.importFromGitHub({ repoInput: "owner/repo", scope: "off" }), /symlink|symbolic|unsafe/);
  await assert.rejects(f.skills.updatePackage({ id: "owner/repo" }), /symlink|symbolic|unsafe/); intact(f);
});

test("package and plugin stores reject linked ancestors above the hub root", async t => {
  const f = fixture(t); link(f.victim, path.join(f.homeDir, ".t3"));
  write(path.join(f.victim, "hub", "packages", "owner__repo", "keep.txt"), "untouched");
  await assert.rejects(f.skills.removePackage({ id: "owner/repo" }), /symlink|symbolic|unsafe/);
  await assert.rejects(f.skills.importFromGitHub({ repoInput: "owner/repo", scope: "off" }), /symlink|symbolic|unsafe/);
  const source = path.join(f.root, "local-plugin"); write(path.join(source, ".codex-plugin", "plugin.json"), { name: "safe-plugin" });
  await assert.rejects(plugins(f).installPluginFromGitHub({ input: source, scope: "off" }), /symlink|symbolic|unsafe/);
  assert.equal(fs.readFileSync(path.join(f.victim, "hub", "packages", "owner__repo", "keep.txt"), "utf8"), "untouched"); intact(f);
});

test("GitHub parser rejects unsafe owner, repo and tree subpaths", () => {
  for (const input of ["owner/..", "https://github.com/../repo", "https://github.com/owner/repo/tree/main/../../victim", "https://github.com/owner/repo/tree/main/a\\..\\victim", "owner/rep\0o"]) assert.equal(parseGitHubInput(input), null, input);
  // Relative local repositories are a supported source, never a deletion ID.
  assert.equal(parseGitHubInput("../repo").pkgId, "local__repo");
  assert.equal(parseGitHubInput("owner/repo").pkgId, "owner__repo");
  assert.equal(parseGitHubInput("https://github.com/owner/repo/tree/main/skills/valid").subpath, "skills/valid");
});

test("skill mutations reject malformed IDs before writing", t => {
  const f = fixture(t);
  for (const id of badIds) {
    assert.throws(() => f.skills.setSkillScope({ id, scope: "global" }), /invalid/);
    assert.throws(() => f.skills.toggleSkillForAgent({ id, agent: "pi", enabled: false }), /invalid|required/);
    intact(f);
  }
});

test("canonical symlinks cannot stamp or copy into external directories", t => {
  const f = fixture(t); write(path.join(f.victim, "SKILL.md"), "# victim");
  link(f.victim, path.join(f.hubDir, "skills", "safe"));
  assert.throws(() => f.skills.toggleSkillForAgent({ id: "safe", agent: "pi", enabled: true }), /symlink|symbolic|unsafe/);
  assert.equal(fs.existsSync(path.join(f.victim, ".t3-hub-managed")), false); intact(f);
});

test("managed skill and package listings do not read external SKILL.md links", t => {
  const f = fixture(t); write(path.join(f.victim, "SKILL.md"), "---\nname: private\ndescription: confidential\n---\n");
  link(path.join(f.victim, "SKILL.md"), path.join(f.hubDir, "skills", "safe", "SKILL.md"));
  link(path.join(f.victim, "SKILL.md"), path.join(f.hubDir, "packages", "owner__repo", "SKILL.md"));
  const items = f.skills.listSkills().items;
  assert.equal(items.some(i => i.id === "safe" || i.id === "owner__repo" || i.description === "confidential"), false); intact(f);
});

test("skill enable and disable reject host and project parent symlink escapes", t => {
  const f = fixture(t); write(path.join(f.hubDir, "skills", "safe", "SKILL.md"), "# safe");
  link(f.victim, path.join(f.homeDir, ".pi", "agent", "skills"));
  for (const enabled of [true, false]) assert.throws(() => f.skills.toggleSkillForAgent({ id: "safe", agent: "pi", enabled }), /symlink|symbolic|unsafe/);
  const projectRoot = path.join(f.root, "project");
  link(f.victim, path.join(projectRoot, ".agents"));
  assert.throws(() => f.skills.setSkillScope({ id: "safe", scope: "project", projectRoot }), /symlink|symbolic|unsafe/);
  assert.equal(fs.existsSync(path.join(f.victim, "safe")), false); intact(f);
});

test("skill canonical files and predictable temporary files reject symlink writes", t => {
  const f = fixture(t), canonical = path.join(f.hubDir, "skills", "safe");
  link(path.join(f.victim, "keep.txt"), path.join(canonical, "SKILL.md"));
  assert.throws(() => f.skills.setSkillScope({ id: "safe", scope: "off" }), /symlink|symbolic|unsafe/);
  fs.unlinkSync(path.join(canonical, "SKILL.md")); write(path.join(canonical, "SKILL.md"), "# safe");
  link(path.join(f.victim, "keep.txt"), path.join(f.hubDir, "state.json.tmp-" + process.pid));
  assert.throws(() => f.skills.setSkillScope({ id: "safe", scope: "off" }), /EEXIST/); intact(f);
});

test("plugin install rejects symlinked install store before cloning", async t => {
  const f = fixture(t); link(f.victim, path.join(f.hubDir, "plugins"));
  const source = path.join(f.root, "local-plugin"); write(path.join(source, ".codex-plugin", "plugin.json"), { name: "safe-plugin" }); gitRepo(source);
  await assert.rejects(plugins(f).installPluginFromGitHub({ input: source, scope: "off" }), /symlink|symbolic|unsafe/);
  assert.equal(fs.existsSync(path.join(f.victim, "local-plugin")), false); intact(f);
});

test("plugin disable rejects tainted injected skill IDs before fallback deletion", t => {
  const f = fixture(t), plugin = path.join(f.hubDir, "plugins", "safe-plugin");
  write(path.join(plugin, ".codex-plugin", "plugin.json"), { name: "safe-plugin" });
  const localVictim = path.join(f.homeDir, ".pi", "victim"); write(path.join(localVictim, "keep.txt"), "local");
  write(path.join(f.hubDir, "plugin-agent-bindings.json"), { bindings: { "safe-plugin": { pi: { enabled: true, injectedSkills: ["../../victim"] } } } });
  assert.throws(() => plugins(f, { skillsManager: {} }).togglePluginForAgent({ id: "safe-plugin", agent: "pi", enabled: false }), /invalid/);
  assert.equal(fs.readFileSync(path.join(localVictim, "keep.txt"), "utf8"), "local"); intact(f);
});

test("plugin fallback cannot write or remove through host or canonical symlinks", t => {
  const f = fixture(t), plugin = path.join(f.hubDir, "plugins", "safe-plugin");
  write(path.join(plugin, ".codex-plugin", "plugin.json"), { name: "safe-plugin" });
  write(path.join(plugin, "skills", "safe", "SKILL.md"), "# safe");
  link(f.victim, path.join(f.homeDir, ".pi", "agent", "skills"));
  for (const enabled of [true, false]) assert.throws(() => plugins(f, { skillsManager: {} }).togglePluginForAgent({ id: "safe-plugin", agent: "pi", enabled }), /symlink|symbolic|unsafe/);
  assert.equal(fs.existsSync(path.join(f.victim, "safe")), false); intact(f);
});

test("plugin fallback rejects a linked canonical target before copying", t => {
  const f = fixture(t), plugin = path.join(f.hubDir, "plugins", "safe-plugin");
  write(path.join(plugin, ".codex-plugin", "plugin.json"), { name: "safe-plugin" });
  write(path.join(plugin, "skills", "safe", "SKILL.md"), "# safe");
  link(f.victim, path.join(f.hubDir, "skills", "safe"));
  assert.throws(() => plugins(f, { skillsManager: {} }).togglePluginForAgent({ id: "safe-plugin", agent: "pi", enabled: true }), /symlink|symbolic|unsafe/);
  assert.equal(fs.existsSync(path.join(f.victim, "SKILL.md")), false); intact(f);
});

test("plugin canonical copy cannot overwrite files through an existing nested symlink", t => {
  const f = fixture(t), plugin = path.join(f.hubDir, "plugins", "safe-plugin");
  write(path.join(plugin, ".codex-plugin", "plugin.json"), { name: "safe-plugin" });
  write(path.join(plugin, "skills", "safe", "SKILL.md"), "# safe");
  write(path.join(plugin, "skills", "safe", "assets", "keep.txt"), "overwrite");
  link(f.victim, path.join(f.hubDir, "skills", "safe", "assets"));
  assert.throws(() => plugins(f, { skillsManager: {} }).togglePluginForAgent({ id: "safe-plugin", agent: "pi", enabled: true }), /symlink|symbolic|unsafe/);
  intact(f);
});

test("plugin icon resolution blocks lexical traversal and external symlink reads", t => {
  const f = fixture(t), plugin = path.join(f.root, "plugin"); fs.mkdirSync(plugin);
  write(path.join(f.victim, "secret.svg"), "<svg>private</svg>");
  link(path.join(f.victim, "secret.svg"), path.join(plugin, "icon.svg"));
  assert.equal(findIconDataUri(plugin, { icon: "icon.svg" }), null);
  assert.equal(pluginIcon(plugin, "p", { icon: "../victim/secret.svg" }), null);
  fs.unlinkSync(path.join(plugin, "icon.svg"));
  link(f.victim, path.join(plugin, "assets"));
  write(path.join(f.victim, "logo.svg"), "<svg>private</svg>");
  assert.equal(findIconDataUri(plugin, {}), null); intact(f);
});

test("plan operations reject unsafe thread IDs instead of sanitizing into other plan filenames", t => {
  const f = fixture(t), b = board(f);
  for (const threadId of badIds) {
    assert.throws(() => b.updatePlan({ threadId, steps: [] }), /invalid/);
    assert.throws(() => b.clearPlan({ threadId }), /invalid/);
  }
  intact(f);
});

test("plan store symlink blocks write/read/clear and garbage collection", t => {
  const f = fixture(t), plans = path.join(f.hubDir, "task-plans"), externalPlan = path.join(f.victim, "t-safe.json");
  write(externalPlan, { threadId: "safe", steps: [{ text: "private", status: "completed" }] });
  const old = new Date("2000-01-01"); fs.utimesSync(externalPlan, old, old);
  link(f.victim, plans); const b = board(f, plans);
  assert.throws(() => b.updatePlan({ threadId: "safe", steps: [] }), /symlink|symbolic|unsafe/);
  assert.throws(() => b.getBoardSnapshot({ threadId: "safe" }), /symlink|symbolic|unsafe/);
  assert.throws(() => b.clearPlan({ threadId: "safe" }), /symlink|symbolic|unsafe/);
  assert.equal(gcTaskPlans(plans).deleted, 0);
  assert.equal(fs.existsSync(externalPlan), true); intact(f);
});

test("plan leaf symlinks are not read or overwritten, including dangling links", t => {
  const f = fixture(t), plans = path.join(f.hubDir, "task-plans"), externalPlan = path.join(f.victim, "keep.json");
  const record = { threadId: "safe", steps: [{ text: "private", status: "pending" }] }; write(externalPlan, record);
  link(externalPlan, path.join(plans, "t-safe.json")); const b = board(f, plans);
  assert.throws(() => b.updatePlan({ threadId: "safe", steps: [] }), /symlink|symbolic|unsafe/);
  assert.equal(b.getBoardSnapshot({ threadId: "safe" }).steps.length, 0);
  assert.equal(b.clearPlan({ threadId: "safe" }).deleted, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(externalPlan)), record);
  link(path.join(f.victim, "missing.json"), path.join(plans, "t-dangling.json"));
  assert.throws(() => b.updatePlan({ threadId: "dangling", steps: [] }), /symlink|symbolic|unsafe/); intact(f);
});

test("plan operations reject a symlink ancestor above the plan store", t => {
  const f = fixture(t); link(f.victim, path.join(f.homeDir, ".t3"));
  const b = board(f);
  assert.throws(() => b.updatePlan({ threadId: "safe", steps: [] }), /symlink|symbolic|unsafe/);
  assert.throws(() => b.getBoardSnapshot({ threadId: "safe" }), /symlink|symbolic|unsafe/);
  assert.throws(() => b.clearPlan({ threadId: "safe" }), /symlink|symbolic|unsafe/);
  assert.equal(fs.existsSync(path.join(f.victim, "hub", "task-plans")), false); intact(f);
});

test("project plan keys reject traversal and NUL while keeping Unicode project names", t => {
  const f = fixture(t), b = board(f);
  for (const projectRoot of ["../victim", path.join(f.root, "project") + "/../../victim", "a\\..\\victim", f.root + "/bad\0path", {}]) {
    assert.throws(() => b.updatePlan({ projectRoot, steps: [] }), /invalid/);
    assert.throws(() => b.clearPlan({ projectRoot }), /invalid/);
  }
  intact(f);
});

test("legal local package install, list, update, enable, disable and remove still work", async t => {
  const f = fixture(t), source = path.join(f.root, "local-repo"); write(path.join(source, "safe", "SKILL.md"), "---\nname: safe\n---\n# Safe\n"); gitRepo(source);
  const imported = await f.skills.importFromGitHub({ repoInput: source, scope: "off" }); assert.deepEqual(imported.imported, ["safe"]);
  assert.equal(f.skills.listSkills().items.some(i => i.id === "safe"), true);
  for (const enabled of [true, false]) assert.equal(f.skills.toggleSkillForAgent({ id: "safe", agent: "pi", enabled }).ok, true);
  assert.equal((await f.skills.updatePackage({ id: "local__local-repo" })).ok, true);
  assert.equal((await f.skills.removePackage({ id: "local/local-repo" })).ok, true);
  assert.equal(fs.existsSync(path.join(f.hubDir, "packages", "local__local-repo")), false); intact(f);
});

test("legal local plugin install, scope, enable and disable still work", async t => {
  const f = fixture(t), source = path.join(f.root, "local-plugin");
  write(path.join(source, ".codex-plugin", "plugin.json"), { name: "safe-plugin" }); write(path.join(source, "skills", "safe", "SKILL.md"), "# safe"); gitRepo(source);
  const manager = plugins(f);
  assert.equal((await manager.installPluginFromGitHub({ input: source, scope: "global" })).ok, true);
  assert.equal(manager.listPlugins().items.some(i => i.id === "safe-plugin"), true);
  for (const enabled of [true, false]) assert.equal(manager.togglePluginForAgent({ id: "safe-plugin", agent: "pi", enabled }).ok, true);
  assert.equal(manager.setPluginScope({ id: "safe-plugin", scope: "off" }).ok, true); intact(f);
});

test("legal plans retain isolated read/write/clear and stale-file GC", t => {
  const f = fixture(t), b = board(f), plans = path.join(f.hubDir, "task-plans");
  b.updatePlan({ threadId: "keep", steps: [{ id: "task-1", text: "keep", status: "pending" }] });
  b.updatePlan({ threadId: "drop", steps: [{ text: "drop", status: "done" }] });
  assert.equal(b.getBoardSnapshot({ threadId: "keep" }).steps[0].text, "keep");
  assert.equal(b.clearPlan({ threadId: "drop" }).deleted, 1);
  b.updatePlan({ projectRoot: path.join(f.root, "中文项目"), steps: [{ text: "project", status: "pending" }] });
  assert.equal(b.getBoardSnapshot({ projectRoot: path.join(f.root, "中文项目") }).steps[0].text, "project");
  const stale = path.join(plans, "t-keep.json"), old = new Date("2000-01-01"); fs.utimesSync(stale, old, old);
  assert.equal(gcTaskPlans(plans).deleted, 1); intact(f);
});

test("plugin skills SKILL.md symlink to external secret is not listed", t => {
  const f = fixture(t), plugin = path.join(f.hubDir, "plugins", "evil-plugin");
  write(path.join(plugin, ".codex-plugin", "plugin.json"), { name: "evil-plugin" });
  write(path.join(f.victim, "SKILL.md"), "---\nname: EVIL_SECRET_TITLE\ndescription: EVIL_SECRET_DESC\n---\n# evil\n");
  link(path.join(f.victim, "SKILL.md"), path.join(plugin, "skills", "evil", "SKILL.md"));
  const items = f.skills.listSkills({ includePluginBundled: true }).items;
  assert.equal(items.some(i => i.id === "evil"), false);
  assert.equal(items.some(i => i.name === "EVIL_SECRET_TITLE" || i.description === "EVIL_SECRET_DESC"), false);
  intact(f);
});

test("plugin skills evil directory symlink to external is not listed", t => {
  const f = fixture(t), plugin = path.join(f.hubDir, "plugins", "evil-plugin");
  write(path.join(plugin, ".codex-plugin", "plugin.json"), { name: "evil-plugin" });
  write(path.join(f.victim, "SKILL.md"), "---\nname: EVIL_DIR_SECRET_TITLE\ndescription: EVIL_DIR_SECRET_DESC\n---\n# evil\n");
  link(f.victim, path.join(plugin, "skills", "evil"));
  const items = f.skills.listSkills({ includePluginBundled: true }).items;
  assert.equal(items.some(i => i.id === "evil"), false);
  assert.equal(items.some(i => i.name === "EVIL_DIR_SECRET_TITLE" || i.description === "EVIL_DIR_SECRET_DESC"), false);
  intact(f);
});

test("hub symlink ancestor blocks direct gcTaskPlans for state/task-plans", t => {
  const f = fixture(t);
  const externalHub = path.join(f.root, "external-hub");
  const externalPlans = path.join(externalHub, "state", "task-plans");
  write(path.join(externalPlans, "t-old.json"), { threadId: "old", steps: [{ text: "old", status: "completed" }], updatedAt: "2000-01-01T00:00:00.000Z" });
  write(path.join(externalPlans, "t-keep.json"), { threadId: "keep", steps: [{ text: "keep", status: "pending" }], updatedAt: new Date().toISOString() });
  const old = new Date("2000-01-01"); fs.utimesSync(path.join(externalPlans, "t-old.json"), old, old);
  link(externalHub, f.hubDir);
  const plans = path.join(f.hubDir, "state", "task-plans");
  const res = gcTaskPlans(plans);
  assert.equal(res.deleted, 0);
  assert.equal(fs.existsSync(path.join(externalPlans, "t-old.json")), true);
  assert.equal(fs.existsSync(path.join(externalPlans, "t-keep.json")), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(externalPlans, "t-old.json"), "utf8")).threadId, "old");
  intact(f);
});

const pluginStores = {
  hub: f => path.join(f.hubDir, "plugins"),
  codex: f => path.join(f.homeDir, ".codex", "plugins", "cache"),
  claude: f => path.join(f.homeDir, ".claude", "plugins"),
  "claude-cache": f => path.join(f.homeDir, ".claude", "plugins", "cache"),
  zcode: f => path.join(f.homeDir, ".zcode", "cli", "plugins", "marketplaces"),
};
function pluginEntry(store, kind, id) {
  return ["codex", "claude-cache", "zcode"].includes(kind) ? path.join(store, "market", id) : path.join(store, id);
}
function registerCachePlugin(f, kind, plugin) {
  // Claude cache entries can also be referenced by the installed-plugin registry.
  if (kind === "claude-cache") write(path.join(f.homeDir, ".zcode", "cli", "plugins", "installed_plugins.json"), [{ installPath: plugin }]);
}
function watchExternalSkillReads(t, external) {
  const reads = [], read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", function(file, ...args) {
    try {
      const real = fs.realpathSync(file);
      if (real.startsWith(fs.realpathSync(external) + path.sep) && path.basename(String(file)) === "SKILL.md") reads.push(real);
    } catch {}
    return read.call(this, file, ...args);
  });
  return reads;
}
for (const [kind, storePath] of Object.entries(pluginStores)) {
  for (const layout of ["nested", "root"]) {
    test(`${kind} plugin directory symlink cannot read external ${layout} SKILL.md`, t => {
      const f = fixture(t), store = storePath(f), plugin = pluginEntry(store, kind, "evil-plugin");
      write(path.join(f.victim, ".codex-plugin", "plugin.json"), { name: "evil-plugin" });
      const skill = layout === "root" ? path.join(f.victim, "SKILL.md") : path.join(f.victim, "skills", "evil", "SKILL.md");
      write(skill, "---\nname: EXTERNAL_PLUGIN_TITLE\ndescription: EXTERNAL_PLUGIN_DESCRIPTION\n---\n");
      link(f.victim, plugin);
      registerCachePlugin(f, kind, plugin);
      const reads = watchExternalSkillReads(t, f.victim);
      const items = f.skills.listSkills({ includePluginBundled: true }).items;
      assert.deepEqual(reads, [], "external SKILL.md must never be opened");
      assert.equal(items.some(i => i.id === "evil" || i.id === "evil-plugin"), false);
      assert.equal(JSON.stringify(items).includes("EXTERNAL_PLUGIN_"), false);
      intact(f);
    });
  }
  test(`${kind} plugin store symlink cannot establish a trusted root outside home`, t => {
    const f = fixture(t), store = storePath(f), entry = pluginEntry(f.victim, kind, "evil-plugin");
    write(path.join(entry, ".codex-plugin", "plugin.json"), { name: "evil-plugin" });
    write(path.join(entry, "SKILL.md"), "---\nname: EXTERNAL_STORE_TITLE\n---\n");
    write(path.join(entry, "skills", "evil", "SKILL.md"), "---\nname: EXTERNAL_STORE_TITLE\n---\n");
    link(f.victim, store);
    registerCachePlugin(f, kind, pluginEntry(store, kind, "evil-plugin"));
    const reads = watchExternalSkillReads(t, f.victim);
    const items = f.skills.listSkills({ includePluginBundled: true }).items;
    assert.deepEqual(reads, []);
    assert.equal(JSON.stringify(items).includes("EXTERNAL_STORE_TITLE"), false);
    intact(f);
  });
  test(`${kind} plugin store allows internal 1.0.0 and latest symlink`, t => {
    const f = fixture(t), store = storePath(f);
    const parent = ["codex", "claude-cache"].includes(kind) ? pluginEntry(store, kind, "safe-plugin") : path.dirname(pluginEntry(store, kind, "latest"));
    const version = kind === "codex" ? path.join(parent, "1.0.0") : path.join(parent, ".versions", "1.0.0");
    write(path.join(version, ".codex-plugin", "plugin.json"), { name: "safe-plugin" });
    write(path.join(version, "skills", "safe-internal", "SKILL.md"), "---\nname: INTERNAL_TITLE\ndescription: INTERNAL_DESCRIPTION\n---\n");
    link(version, path.join(parent, "latest"));
    registerCachePlugin(f, kind, path.join(parent, "latest"));
    const latestSkill = path.join(parent, "latest", "skills", "safe-internal", "SKILL.md"), read = fs.readFileSync;
    let readViaLatest = false;
    t.mock.method(fs, "readFileSync", function(file, ...args) {
      if (String(file) === latestSkill) readViaLatest = true;
      return read.call(this, file, ...args);
    });
    const items = f.skills.listSkills({ includePluginBundled: true }).items;
    assert.equal(items.some(i => i.id === "safe-internal" && i.name === "INTERNAL_TITLE" && i.description === "INTERNAL_DESCRIPTION"), true);
    assert.equal(readViaLatest, true, "the internal latest alias must actually be read");
    intact(f);
  });
}

for (const kind of ["codex", "claude-cache"]) for (const layout of ["nested", "root"]) {
  test(`${kind} external latest version cannot read ${layout} SKILL.md`, t => {
    const f = fixture(t), store = pluginStores[kind](f), plugin = pluginEntry(store, kind, "evil-plugin");
    write(path.join(f.victim, ".codex-plugin", "plugin.json"), { name: "evil-plugin" });
    write(layout === "root" ? path.join(f.victim, "SKILL.md") : path.join(f.victim, "skills", "evil", "SKILL.md"), "---\nname: EXTERNAL_VERSION_TITLE\ndescription: EXTERNAL_VERSION_DESCRIPTION\n---\n");
    link(f.victim, path.join(plugin, "latest"));
    registerCachePlugin(f, kind, path.join(plugin, "latest"));
    const reads = watchExternalSkillReads(t, f.victim);
    const items = f.skills.listSkills({ includePluginBundled: true }).items;
    assert.deepEqual(reads, []);
    assert.equal(JSON.stringify(items).includes("EXTERNAL_VERSION_"), false);
    intact(f);
  });
}

for (const location of ["internal", "external"]) {
  test(`codex root SKILL.md must be a regular file even for an ${location} link`, t => {
    const f = fixture(t), plugin = pluginEntry(pluginStores.codex(f), "codex", "root-leaf");
    const target = path.join(location === "internal" ? plugin : f.victim, "secret.md");
    write(target, "---\nname: LINKED_ROOT_TITLE\ndescription: LINKED_ROOT_DESCRIPTION\n---\n");
    link(target, path.join(plugin, "SKILL.md"));
    const reads = watchExternalSkillReads(t, location === "internal" ? plugin : f.victim);
    const items = f.skills.listSkills({ includePluginBundled: true }).items;
    assert.deepEqual(reads, []);
    assert.equal(items.some(i => i.id === "root-leaf"), false);
    assert.equal(JSON.stringify(items).includes("LINKED_ROOT_"), false);
    intact(f);
  });
}

test("codex plugin real root must be strictly below its cache root", t => {
  const f = fixture(t), store = pluginStores.codex(f);
  write(path.join(store, "SKILL.md"), "---\nname: STORE_ROOT_TITLE\n---\n");
  link(store, pluginEntry(store, "codex", "cache-alias"));
  const items = f.skills.listSkills({ includePluginBundled: true }).items;
  assert.equal(JSON.stringify(items).includes("STORE_ROOT_TITLE"), false);
  intact(f);
});

for (const mode of ["anchor", "implicit", "custom-home"]) {
  test(`GC rejects an ancestor symlink with ${mode} anchoring and preserves expired external JSON`, t => {
    const f = fixture(t), externalHome = path.join(f.victim, "fake-home");
    const externalPlan = path.join(externalHome, ".t3", "hub", "state", "task-plans", "t-old.json");
    const content = '{"threadId":"old","steps":[{"text":"preserve","status":"completed"}]}\n';
    write(externalPlan, content);
    const old = new Date("2000-01-01"); fs.utimesSync(externalPlan, old, old);
    const above = path.join(f.root, "link-above-anchor"); link(f.victim, above);
    const anchor = path.join(above, "fake-home"), plans = path.join(anchor, ".t3", "hub", "state", "task-plans");
    if (mode === "custom-home") {
      const previousHome = process.env.HOME;
      t.after(() => { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; });
      process.env.HOME = anchor;
    }
    assert.deepEqual(gcTaskPlans(plans, Date.now(), mode === "anchor" ? anchor : undefined), { deleted: 0 });
    assert.equal(fs.readFileSync(externalPlan, "utf8"), content);
    assert.equal(fs.statSync(externalPlan).mtimeMs, old.getTime());
    intact(f);
  });
}

test("GC accepts the fixed macOS /tmp alias and rejects user links below it", { skip: process.platform !== "darwin" }, t => {
  const root = fs.mkdtempSync("/tmp/hub-plan-alias-"), anchor = path.join(root, "home"), plans = path.join(anchor, "task-plans");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(fs.realpathSync("/tmp"), "/private/tmp");
  const stale = path.join(plans, "t-old.json"), content = '{"steps":[{"status":"completed"}]}\n', old = new Date("2000-01-01");
  write(stale, content); fs.utimesSync(stale, old, old);
  assert.deepEqual(gcTaskPlans(plans, Date.now(), anchor), { deleted: 1 });
  write(stale, content); fs.utimesSync(stale, old, old);
  const linked = path.join(root, "user-link"); link(anchor, linked);
  assert.deepEqual(gcTaskPlans(path.join(linked, "task-plans"), Date.now(), linked), { deleted: 0 });
  assert.deepEqual(gcTaskPlans(path.join(linked, "task-plans")), { deleted: 0 });
  assert.equal(fs.readFileSync(stale, "utf8"), content);
});
