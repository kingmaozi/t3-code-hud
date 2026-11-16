"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHooksManager } = require("../src/hub-hooks.cjs");

const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
};
const snapshot = files => Object.fromEntries(files.map(file => [file, fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null]));

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "t3-hooks-readonly-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const homeDir = path.join(temp, "home"), hubDir = path.join(homeDir, ".t3", "hub");
  const projectA = path.join(temp, "projects", "alpha"), projectB = path.join(temp, "projects", "beta");
  for (const project of [projectA, projectB]) {
    fs.mkdirSync(path.join(project, ".git"), { recursive: true });
    write(path.join(project, ".claude", "settings.local.json"), { marker: path.basename(project), hooks: { Stop: [{ hooks: [{ type: "command", command: `user-${path.basename(project)}` }] }] } });
    write(path.join(project, ".codex", "hooks.json"), { marker: path.basename(project), hooks: { Stop: [] } });
  }
  const globalClaude = path.join(homeDir, ".claude", "settings.json");
  const globalCodex = path.join(homeDir, ".codex", "hooks.json");
  write(globalClaude, { marker: "global", hooks: { Stop: [{ hooks: [{ type: "command", command: "user-global" }] }] } });
  write(globalCodex, { marker: "global", hooks: { Stop: [] } });
  const statePath = path.join(hubDir, "hooks-state.json");
  const managed = (id, scope, projectRoot = null) => ({ id, title: id, events: ["Stop"], command: `echo ${id}`, scope, projectRoot, custom: true, builtin: false, source: "custom", readonly: false });
  write(statePath, {
    version: 1,
    projectRoots: [projectA, projectB],
    hooks: [managed("global-visible", "global"), managed("project-alpha", "project", projectA), managed("project-beta-private", "project", projectB)],
  });
  const projectFiles = [projectA, projectB].flatMap(project => [
    path.join(project, ".claude", "settings.local.json"),
    path.join(project, ".codex", "hooks.json"),
    path.join(project, ".git", "info", "exclude"),
  ]);
  return {
    temp, homeDir, hubDir, projectA, projectB, statePath, globalClaude, globalCodex, projectFiles,
    manager: createHooksManager({ homeDir, hubDir, binDir: path.join(temp, "bin") }),
  };
}

test("hooks:list is read-only and returns global plus only the requested project's hooks", t => {
  const f = fixture(t);
  const files = [f.statePath, f.globalClaude, f.globalCodex, ...f.projectFiles];
  const before = snapshot(files);

  const result = f.manager.listHooks({ projectRoot: f.projectA });

  assert.equal(result.ok, true);
  assert.ok(result.items.some(item => item.id === "global-visible" && item.scope === "global" && item.projectRoot == null));
  assert.ok(result.items.some(item => item.id === "project-alpha" && item.scope === "project" && path.resolve(item.projectRoot) === f.projectA && item.readonly));
  assert.ok(!result.items.some(item => item.id === "project-beta-private"));
  assert.ok(result.items.every(item => !item.projectRoot || path.resolve(item.projectRoot) === f.projectA));
  assert.deepEqual(snapshot(files), before, "listing must not synchronize global or historical project files/state");
});

test("writing a new project hook updates only its explicitly selected project", t => {
  const f = fixture(t);
  const beforeGlobal = snapshot([f.globalClaude, f.globalCodex]);
  const beforeBeta = snapshot(f.projectFiles.filter(file => file.startsWith(f.projectB + path.sep)));

  f.manager.saveCustomHook({
    scope: "project",
    projectRoot: f.projectA,
    item: { id: "project-alpha-new", title: "Alpha only", events: ["PostToolUse"], command: "echo alpha", scope: "project", projectRoot: f.projectA },
  });

  assert.deepEqual(snapshot([f.globalClaude, f.globalCodex]), beforeGlobal, "project-scoped write must not rewrite global hook files");
  assert.deepEqual(snapshot(f.projectFiles.filter(file => file.startsWith(f.projectB + path.sep))), beforeBeta, "project-scoped write must not touch another project's files or git excludes");
  const alpha = JSON.parse(fs.readFileSync(path.join(f.projectA, ".claude", "settings.local.json"), "utf8"));
  assert.ok(alpha.hooks.PostToolUse.some(group => group._t3HubHookId === "project-alpha-new"));
});

test("writing a global hook does not synchronize historical project roots", t => {
  const f = fixture(t);
  const global = JSON.parse(fs.readFileSync(f.globalClaude, "utf8"));
  global.hooks.Stop.push({ _t3HubHookId: "global-visible", hooks: [{ type: "command", command: "echo global", _t3HubHookId: "global-visible" }] });
  write(f.globalClaude, global);
  const beforeGlobal = snapshot([f.globalClaude, f.globalCodex]);
  const beforeProjects = snapshot(f.projectFiles);

  f.manager.toggleHook({ id: "global-visible", scope: "off" });

  assert.notDeepEqual(snapshot([f.globalClaude, f.globalCodex]), beforeGlobal, "the explicitly selected global files should be synchronized");
  assert.deepEqual(snapshot(f.projectFiles), beforeProjects, "historical project roots are not implicit write targets");
});

test("project-owned hook records cannot be moved by a global or other-project mutation", t => {
  const f = fixture(t);
  const files = [f.statePath, f.globalClaude, f.globalCodex, ...f.projectFiles];
  const before = snapshot(files);

  assert.throws(() => f.manager.toggleHook({ id: "project-alpha", scope: "global" }), /project-scoped hook/);
  assert.throws(() => f.manager.toggleHook({ id: "project-alpha", scope: "project", projectRoot: f.projectB }), /owning project/);
  assert.throws(() => f.manager.saveCustomHook({
    scope: "global",
    item: { id: "project-alpha", title: "Moved", events: ["Stop"], command: "echo moved", scope: "global" },
  }), /project-scoped hook/);
  assert.throws(() => f.manager.saveCustomHook({
    scope: "project",
    projectRoot: f.projectB,
    item: { id: "project-alpha", title: "Moved", events: ["Stop"], command: "echo moved", scope: "project", projectRoot: f.projectB },
  }), /owning project/);
  assert.deepEqual(snapshot(files), before, "rejected scope changes must not mutate config or registration files");
});

test("custom-hook removal requires its exact owning project and leaves other project records untouched", t => {
  const f = fixture(t);
  const state = JSON.parse(fs.readFileSync(f.statePath, "utf8"));
  state.hooks.push({ id: "same-custom-id", title: "Scoped custom", events: ["Stop"], command: "echo scoped", scope: "project", projectRoot: f.projectA, custom: true, builtin: false, source: "custom", readonly: false });
  write(f.statePath, state);
  const before = snapshot([f.statePath, ...f.projectFiles]);

  assert.throws(() => f.manager.deleteCustomHook({ id: "same-custom-id", projectRoot: f.projectB }), /owning project/);
  assert.throws(() => f.manager.deleteCustomHook({ id: "same-custom-id", scope: "global" }), /owning project/);
  assert.deepEqual(snapshot([f.statePath, ...f.projectFiles]), before, "a wrong-scope delete must be byte-preserving");

  f.manager.deleteCustomHook({ id: "same-custom-id", scope: "project", projectRoot: f.projectA });
  const after = JSON.parse(fs.readFileSync(f.statePath, "utf8"));
  assert.ok(!after.hooks.some(h => h.id === "same-custom-id" && path.resolve(h.projectRoot) === f.projectA));
});

test("turning off project plugin hooks only removes the selected project copy", t => {
  const f = fixture(t);
  const state = JSON.parse(fs.readFileSync(f.statePath, "utf8"));
  const pluginHook = (scope, projectRoot = null) => ({ id: "plugin:shared:Stop:0", title: "shared · Stop", pluginId: "shared", events: ["Stop"], handlers: [{ type: "command", command: "echo plugin" }], scope, projectRoot, source: "plugin", builtin: false });
  state.hooks.push(pluginHook("global"), pluginHook("project", f.projectA), pluginHook("project", f.projectB));
  write(f.statePath, state);
  const globalBefore = snapshot([f.globalClaude, f.globalCodex]);
  const alphaBefore = snapshot(f.projectFiles.filter(file => file.startsWith(f.projectA + path.sep)));

  f.manager.setPluginHooks({ pluginId: "shared", scope: "off", projectRoot: f.projectB });

  const after = JSON.parse(fs.readFileSync(f.statePath, "utf8"));
  assert.ok(after.hooks.some(h => h.pluginId === "shared" && h.scope === "global"));
  assert.ok(after.hooks.some(h => h.pluginId === "shared" && h.scope === "project" && path.resolve(h.projectRoot) === f.projectA));
  assert.ok(!after.hooks.some(h => h.pluginId === "shared" && h.scope === "project" && path.resolve(h.projectRoot) === f.projectB));
  assert.deepEqual(snapshot([f.globalClaude, f.globalCodex]), globalBefore, "project off must not touch global files");
  assert.deepEqual(snapshot(f.projectFiles.filter(file => file.startsWith(f.projectA + path.sep))), alphaBefore, "project off must not touch another project's files");
});

test("first list in an empty home is read-only and does not report default guards as enabled", t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "t3-hooks-empty-home-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const homeDir = path.join(temp, "home"), hubDir = path.join(homeDir, ".t3", "hub");
  const manager = createHooksManager({ homeDir, hubDir, binDir: path.join(temp, "bin") });
  const statePath = path.join(hubDir, "hooks-state.json");

  const result = manager.listHooks();

  for (const id of ["memory-stop-guard", "subagent-route-guard"]) {
    const item = result.items.find(entry => entry.id === id);
    assert.equal(item.scope, "off");
    assert.equal(item.enabled, false);
    assert.equal(item.configured, false);
    assert.equal(item.configurationStatus, "not-configured");
  }
  assert.ok(!fs.existsSync(statePath));
  assert.ok(!fs.existsSync(path.join(homeDir, ".claude", "settings.json")));
  assert.ok(!fs.existsSync(path.join(homeDir, ".codex", "hooks.json")));

  write(statePath, { version: 1, projectRoots: [], hooks: [{ id: "memory-stop-guard", scope: "global" }] });
  const savedButMissing = manager.listHooks().items.find(entry => entry.id === "memory-stop-guard");
  assert.equal(savedButMissing.scope, "global", "saved preference remains visible");
  assert.equal(savedButMissing.enabled, false, "a saved preference without host markers is not reported active");
  assert.equal(savedButMissing.configurationStatus, "not-configured");
  assert.ok(!fs.existsSync(path.join(homeDir, ".claude", "settings.json")));
  assert.ok(!fs.existsSync(path.join(homeDir, ".codex", "hooks.json")));

  manager.toggleHook({ id: "memory-stop-guard", scope: "global" });
  const enabled = manager.listHooks().items.find(entry => entry.id === "memory-stop-guard");
  assert.equal(enabled.scope, "global");
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.configurationStatus, "configured");
  assert.deepEqual(enabled.configuredIn.sort(), ["claude", "codex"]);
});

test("a missing required event or handler makes a multi-event hook partial", t => {
  const f = fixture(t);
  f.manager.toggleHook({ id: "memory-stop-guard", scope: "global" });
  for (const file of [f.globalClaude, f.globalCodex]) {
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    config.hooks.SubagentStop = config.hooks.SubagentStop.filter(group => group._t3HubHookId !== "memory-stop-guard");
    write(file, config);
  }

  const item = f.manager.listHooks().items.find(entry => entry.id === "memory-stop-guard");

  assert.equal(item.scope, "global");
  assert.equal(item.enabled, false, "neither host has every required hook event");
  assert.equal(item.configured, false);
  assert.equal(item.configurationStatus, "partial");
  assert.deepEqual(item.partialIn.sort(), ["claude", "codex"]);
  assert.deepEqual(item.configuredIn, []);

  f.manager.toggleHook({ id: "memory-stop-guard", scope: "global" });
  for (const file of [f.globalClaude, f.globalCodex]) {
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    config.hooks.Stop = config.hooks.Stop.map(group => group._t3HubHookId === "memory-stop-guard"
      ? { ...group, hooks: group.hooks.filter(handler => handler._t3HubHookId !== "memory-stop-guard") }
      : group);
    write(file, config);
  }
  const missingHandler = f.manager.listHooks().items.find(entry => entry.id === "memory-stop-guard");
  assert.equal(missingHandler.enabled, false, "a marker group without its required handler is incomplete");
  assert.equal(missingHandler.configurationStatus, "partial");
  assert.deepEqual(missingHandler.partialIn.sort(), ["claude", "codex"]);
});
