"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync, spawn } = require("node:child_process");
const { createSubagentsManager, resolveSubagentRoute } = require("../src/hub-subagents.cjs");

const root = path.resolve(__dirname, "..");
const write = (p, value) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof value === "string" ? value : JSON.stringify(value)); };
const read = p => JSON.parse(fs.readFileSync(p, "utf8"));
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-hooks-v2-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const homeDir = path.join(dir, "home"), hubDir = path.join(homeDir, ".t3", "hub"), projectRoot = path.join(dir, "project");
  fs.mkdirSync(projectRoot, { recursive: true });
  spawnSync("git", ["init", "-q", projectRoot]);
  return { dir, homeDir, hubDir, projectRoot, binDir: path.join(root, "scripts") };
}
function projectRoutePath(f) {
  const canonical = fs.realpathSync(f.projectRoot);
  return path.join(f.hubDir, "project-subagents", `${path.basename(canonical)}-${crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 20)}.json`);
}
function run(f, script, payload, env = {}) {
  const result = spawnSync(process.execPath, [path.join(root, "scripts", script)], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload), encoding: "utf8", timeout: 4000,
    cwd: f.projectRoot, env: { ...process.env, HOME: f.homeDir, T3_HUB_DIR: f.hubDir, ...env },
  });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}
const hookManager = f => require("../src/hub-hooks.cjs").createHooksManager(f);
const managed = (doc, event) => (doc.hooks?.[event] || []).filter(x => x._t3HubHookId);
const setGlobalOrchestration = (f, swarmMode) => write(path.join(f.hubDir, "orchestration-config.json"), { policyVersion: 2, orchestratorMode: "off", swarmMode });

test("hooks: defaults synchronize losslessly, expose LCU read-only, back up once", t => {
  const f = fixture(t), claude = path.join(f.homeDir, ".claude/settings.json"), codex = path.join(f.homeDir, ".codex/hooks.json");
  const lcu = { matcher: "Bash", hooks: [{ type: "command", command: "lcu-check" }] };
  const original = { permissions: { allow: ["Read"] }, sandbox: { enabled: true }, hooks: { PreToolUse: [lcu], Stop: [{ hooks: [{ type: "command", command: "codegraph-index" }] }] } };
  write(claude, original); write(codex, { sandbox: "preserve", hooks: { PreToolUse: [lcu] } });
  const mgr = hookManager(f);
  mgr.toggleHook({ id: "memory-stop-guard", scope: "global" });
  mgr.toggleHook({ id: "subagent-route-guard", scope: "global" });
  const listed = mgr.listHooks({ projectRoot: f.projectRoot });
  assert.equal(listed.ok, true); assert.equal(listed.items.filter(x => x.builtin).length, 4);
  assert.ok(listed.items.some(x => x.readonly && x.source === "claude" && x.command === "lcu-check"));
  assert.deepEqual(read(claude).permissions, original.permissions); assert.deepEqual(read(claude).sandbox, original.sandbox);
  assert.deepEqual(read(claude).hooks.PreToolUse[0], lcu);
  assert.deepEqual(read(claude + ".bak-t3hub"), original);
  assert.equal(read(codex).sandbox, "preserve");
  assert.equal(managed(read(claude), "Stop").length, 1); assert.equal(managed(read(claude), "SubagentStop").length, 1);
  assert.equal(managed(read(claude), "PreToolUse")[0].matcher, ".*delegate_task.*");
  mgr.listHooks({}); mgr.toggleHook({ id: "memory-stop-guard", scope: "off" });
  assert.equal(managed(read(claude), "Stop").length, 0);
  assert.equal(read(claude).hooks.Stop[0].hooks[0].command, "codegraph-index");
  assert.deepEqual(read(claude + ".bak-t3hub"), original);
  assert.ok(fs.existsSync(path.join(f.hubDir, "hooks-state.json")));
});

test("hooks: custom create/update/scope migration/delete preserves unrelated groups", t => {
  const f = fixture(t), mgr = hookManager(f);
  mgr.saveCustomHook({ item: { id: "custom", title: "Check", events: ["UserPromptSubmit", "SessionStart"], command: "echo one", scope: "global" } });
  const global = path.join(f.homeDir, ".claude/settings.json"), local = path.join(f.projectRoot, ".claude/settings.local.json");
  mgr.saveCustomHook({ id: "custom", command: "echo two", scope: "project", projectRoot: f.projectRoot });
  assert.equal(managed(read(global), "UserPromptSubmit").length, 0);
  assert.equal(managed(read(local), "UserPromptSubmit")[0].hooks[0].command, "echo two");
  const exclude = fs.readFileSync(path.join(f.projectRoot, ".git/info/exclude"), "utf8");
  assert.ok(exclude.includes(".claude/settings.local.json")); assert.ok(exclude.includes(".codex/hooks.json"));
  const doc = read(local); doc.hooks.UserPromptSubmit[0].hooks.push({ type: "command", command: "user-added" }); write(local, doc);
  mgr.deleteCustomHook({ id: "custom", scope: "project", projectRoot: f.projectRoot });
  assert.equal(read(local).hooks.UserPromptSubmit[0].hooks[0].command, "user-added");
  assert.ok(!mgr.listHooks({}).items.some(x => x.id === "custom"));
  assert.throws(() => mgr.deleteCustomHook({ id: "memory-stop-guard" }));
  assert.throws(() => mgr.saveCustomHook({ id: "invalid", event: "InvalidEvent", command: "x" }));
});

test("hooks: malformed CLI settings are never overwritten", t => {
  const f = fixture(t), file = path.join(f.homeDir, ".claude/settings.json"); write(file, "{broken");
  assert.throws(() => hookManager(f).listHooks({})); assert.equal(fs.readFileSync(file, "utf8"), "{broken");
});

test("hooks: executable optional guards block secrets and report syntax errors", t => {
  const f = fixture(t), mgr = hookManager(f);
  mgr.toggleHook({ id: "secret-commit-guard", scope: "project", projectRoot: f.projectRoot });
  mgr.toggleHook({ id: "js-syntax-postcheck", scope: "project", projectRoot: f.projectRoot });
  const doc = read(path.join(f.projectRoot, ".claude/settings.local.json"));
  const invoke = (event, input) => {
    const command = managed(doc, event)[0].hooks[0].command;
    const result = spawnSync("/bin/sh", ["-c", command], { input: JSON.stringify({ tool_input: input, cwd: f.projectRoot }), encoding: "utf8", timeout: 4000 });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim() ? JSON.parse(result.stdout) : null;
  };
  write(path.join(f.projectRoot, ".env"), "DUMMY=isolated");
  write(path.join(f.projectRoot, "ok.js"), "const x = 1;");
  assert.equal(invoke("PreToolUse", { command: "git add ." }).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(invoke("PreToolUse", { command: "git add ok.js" }), null);
  assert.equal(invoke("PreToolUse", { command: "git status" }), null);
  spawnSync("git", ["-C", f.projectRoot, "add", ".env"]);
  assert.equal(invoke("PreToolUse", { command: "git commit -m test" }).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(invoke("PostToolUse", { file_path: "ok.js" }), null);
  write(path.join(f.projectRoot, "broken.mjs"), "const = ;");
  assert.equal(invoke("PostToolUse", { file_path: "broken.mjs" }).decision, "block");
  assert.equal(invoke("PostToolUse", { command: "*** Begin Patch\n*** Update File: broken.mjs\n*** End Patch" }).decision, "block");
});

test("hooks: project worktree excludes and prompt plugin handlers preserve user data", t => {
  const f = fixture(t), mgr = hookManager(f), gitDir = path.join(f.dir, "worktree-git");
  fs.rmSync(path.join(f.projectRoot, ".git"), { recursive: true }); fs.mkdirSync(gitDir);
  write(path.join(f.projectRoot, ".git"), "gitdir: ../worktree-git\n");
  const file = path.join(f.projectRoot, ".claude/settings.local.json");
  write(file, { permissions: { deny: ["secret"] }, hooks: { SessionStart: [] } });
  mgr.setPluginHooks({ pluginId: "prompt", scope: "project", projectRoot: f.projectRoot, hooks: { Stop: [{ hooks: [{ type: "prompt", prompt: "Review $ARGUMENTS", timeout: 20 }] }] } });
  assert.equal(read(file).hooks.Stop[0].hooks[0].prompt, "Review $ARGUMENTS");
  assert.deepEqual(read(file).hooks.SessionStart, []);
  mgr.setPluginHooks({ pluginId: "prompt", scope: "off", projectRoot: f.projectRoot });
  assert.deepEqual(read(file).permissions, { deny: ["secret"] });
  assert.ok(fs.readFileSync(path.join(gitDir, "info/exclude"), "utf8").includes(".codex/hooks.json"));
});

test("hooks: composite plugin hooks substitute install roots, update idempotently and turn off", t => {
  const f = fixture(t), mgr = hookManager(f), installPath = path.join(f.dir, "plugin space");
  const hooks = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/check.mjs"', timeout: 8 }] }] } };
  mgr.setPluginHooks({ pluginId: "demo", scope: "global", installPath, hooks });
  mgr.setPluginHooks({ pluginId: "demo", scope: "project", projectRoot: f.projectRoot, installPath, hooks });
  const local = read(path.join(f.projectRoot, ".codex/hooks.json"));
  const plugin = managed(local, "PreToolUse").find(x => x._t3HubHookId.startsWith("plugin:"));
  assert.ok(plugin.hooks[0].command.includes(installPath)); assert.equal(plugin.hooks[0].timeout, 8);
  mgr.setPluginHooks({ pluginId: "demo", scope: "off" });
  assert.equal(managed(read(path.join(f.projectRoot, ".codex/hooks.json")), "PreToolUse").length, 1, "global off must preserve the project-owned copy");
  mgr.setPluginHooks({ pluginId: "demo", scope: "off", projectRoot: f.projectRoot });
  assert.equal(managed(read(path.join(f.projectRoot, ".codex/hooks.json")), "PreToolUse").length, 0);
});

test("hooks: generated commands execute with the configured Hub and flattened bin install", t => {
  const f = fixture(t), binDir = path.join(f.dir, "installed bin"); fs.mkdirSync(binDir);
  setGlobalOrchestration(f, "on");
  for (const script of ["subagent-route-guard.mjs", "memory-stop-hook.mjs"]) fs.copyFileSync(path.join(root, "scripts", script), path.join(binDir, script));
  for (const module of ["hub-subagents.cjs", "memory-vault.cjs", "hub-memory-access.cjs", "hub-host-settings.cjs", "mcp-router.cjs"]) {
    fs.copyFileSync(path.join(root, "src", module), path.join(binDir, module));
  }
  const mgr = hookManager({ ...f, binDir }); mgr.toggleHook({ id: "memory-stop-guard", scope: "global" });
  mgr.toggleHook({ id: "subagent-route-guard", scope: "global" });
  const doc = read(path.join(f.homeDir, ".codex/hooks.json"));
  write(path.join(f.hubDir, "subagents.json"), [agent("worker")]);
  const command = managed(doc, "PreToolUse")[0].hooks[0].command;
  const env = { ...process.env, HOME: f.homeDir }; delete env.T3_HUB_DIR;
  const call = () => {
    const result = spawnSync("/bin/sh", ["-c", command], { input: JSON.stringify({ cwd: f.projectRoot, tool_name: "mcp__t3_code__delegate_task", tool_input: { title: "worker · task", target: { options: { reasoningEffort: "medium" } } } }), env, encoding: "utf8", timeout: 3000 });
    assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout).hookSpecificOutput.updatedInput.target;
  };
  assert.equal(call().options.reasoningEffort, "high");
  write(path.join(f.hubDir, "subagents.json"), [agent("worker", { effort: "max" })]);
  assert.equal(call().options.reasoningEffort, "max");
  // Reproduce install.sh's real split layout as well as the flat fixture above.
  for (const module of ["hub-subagents.cjs", "memory-vault.cjs", "hub-memory-access.cjs", "hub-host-settings.cjs", "mcp-router.cjs"]) fs.unlinkSync(path.join(binDir, module));
  fs.mkdirSync(path.join(f.homeDir, ".t3/hud-plugin"), { recursive: true });
  for (const module of ["hub-subagents.cjs", "memory-vault.cjs", "hub-memory-access.cjs", "hub-host-settings.cjs", "mcp-router.cjs"]) {
    fs.copyFileSync(path.join(root, "src", module), path.join(f.homeDir, ".t3/hud-plugin", module));
  }
  assert.equal(call().options.reasoningEffort, "max");
  write(path.join(f.projectRoot, "file with spaces.js"), "let a = 1;");
  const stopped = spawnSync("/bin/sh", ["-c", managed(doc, "Stop")[0].hooks[0].command], { input: JSON.stringify({ cwd: f.projectRoot, session_id: "injected-command" }), env, encoding: "utf8", timeout: 3000 });
  assert.equal(stopped.status, 0, stopped.stderr); assert.equal(JSON.parse(stopped.stdout).decision, "block");
});

test("stop: dirty code blocks once; active hook and clean repo pass", t => {
  const f = fixture(t), p = { cwd: f.projectRoot, session_id: "session-a" };
  assert.equal(run(f, "memory-stop-hook.mjs", p), null);
  write(path.join(f.projectRoot, "change.js"), "const x = 1;");
  assert.equal(run(f, "memory-stop-hook.mjs", { ...p, stop_hook_active: true }), null);
  const first = run(f, "memory-stop-hook.mjs", p); assert.equal(first.decision, "block"); assert.match(first.reason, /T3 自动化记忆提醒/); assert.match(first.reason, /不是用户新请求或授权/); assert.match(first.reason, /当前项目.*不读取或写入全局及其他项目/); assert.match(first.reason, /shared 仅表示本项目 worktree 共享/); assert.match(first.reason, /当前任务允许.*memory_write/); assert.match(first.reason, /只读.*off.*禁止写入/); assert.match(first.reason, /没有已核实的非平凡结论.*直接结束/); assert.match(first.reason, /不得覆盖.*派单限制/);
  assert.equal(run(f, "memory-stop-hook.mjs", p), null);
  const stamp = path.join(f.hubDir, "run", fs.readdirSync(path.join(f.hubDir, "run"))[0]);
  fs.utimesSync(stamp, new Date(0), new Date(0));
  assert.equal(run(f, "memory-stop-hook.mjs", p).decision, "block");
});

test("stop: recent nested memory writes suppress nudges; non-code changes do not nudge", t => {
  const f = fixture(t), p = { cwd: f.projectRoot, session_id: "nested" };
  write(path.join(f.projectRoot, "README.md"), "notes"); assert.equal(run(f, "memory-stop-hook.mjs", p), null);
  write(path.join(f.projectRoot, "change.ts"), "const x = 1;");
  write(path.join(f.hubDir, "memory/projects/project/_meta.json"), { projectRoot: f.projectRoot });
  write(path.join(f.hubDir, "memory/projects/project/rules.md"), "verified");
  assert.equal(run(f, "memory-stop-hook.mjs", p), null);
  fs.utimesSync(path.join(f.hubDir, "memory/projects/project/rules.md"), new Date(0), new Date(0));
  assert.equal(run(f, "memory-stop-hook.mjs", p).decision, "block");
});

test("stop: concurrently invoked guard nudges only once", async t => {
  const f = fixture(t); write(path.join(f.projectRoot, "change.py"), "x = 1");
  const payload = JSON.stringify({ cwd: f.projectRoot, session_id: "race" });
  const results = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "scripts/memory-stop-hook.mjs")], { env: { ...process.env, HOME: f.homeDir, T3_HUB_DIR: f.hubDir } });
    let output = ""; child.stdout.on("data", chunk => output += chunk); child.on("error", reject); child.on("close", code => code === 0 ? resolve(output) : reject(new Error(String(code)))); child.stdin.end(payload);
  })));
  assert.equal(results.filter(Boolean).length, 1);
});

test("scripts: malformed and absent input exit quietly without waiting for EOF", async t => {
  const f = fixture(t);
  for (const script of ["memory-stop-hook.mjs", "subagent-route-guard.mjs"]) {
    assert.equal(run(f, script, "{bad"), null);
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(root, "scripts", script)], { env: { ...process.env, HOME: f.homeDir, T3_HUB_DIR: f.hubDir } });
      const timer = setTimeout(() => { child.kill(); reject(new Error("stdin blocked")); }, 2000);
      child.on("error", reject); child.on("close", code => { clearTimeout(timer); assert.equal(code, 0); resolve(); });
    });
  }
});

function agent(id, patch = {}) { return { id, name: id, role: "implementation", providerInstanceId: "codex", model: "gpt-6.1-sol", effort: "high", enabled: true, ...patch }; }
test("route: old sessions get current provider/model/effort and reread disk next call", t => {
  const f = fixture(t), config = path.join(f.hubDir, "subagents.json"); setGlobalOrchestration(f, "on"); write(config, [agent("worker"), agent("worker-pro", { model: "pro" })]);
  const input = { title: "worker · 修复问题", task: "keep task", target: { providerInstanceId: "muse", model: "old", options: { reasoningEffort: "medium" } } };
  const payload = { tool_name: "mcp__t3_code__delegate_task", tool_input: input, cwd: f.projectRoot };
  const first = run(f, "subagent-route-guard.mjs", payload).hookSpecificOutput;
  assert.equal(first.hookEventName, "PreToolUse"); assert.equal(first.permissionDecision, undefined);
  assert.deepEqual(first.updatedInput.target, { providerInstanceId: "codex", model: "gpt-6.1-sol", options: { reasoningEffort: "high" } });
  assert.match(first.updatedInput.task, /t3-hub-subagent-prompt:start/);
  assert.match(first.updatedInput.task, /keep task$/);
  assert.equal(run(f, "subagent-route-guard.mjs", { ...payload, tool_input: first.updatedInput }), null);
  write(config, [agent("worker", { providerInstanceId: "antigravity", model: "gemini-4-carbon", effort: "xhigh" })]);
  assert.deepEqual(run(f, "subagent-route-guard.mjs", payload).hookSpecificOutput.updatedInput.target.options, { thinking_level: "xhigh" });
});

test("route: project overrides, nested cwd, wrapper, custom id, disabled and ambiguous routes", t => {
  const f = fixture(t); setGlobalOrchestration(f, "on"); write(path.join(f.hubDir, "subagents.json"), [agent("worker"), agent("worker-pro"), agent("custom"), agent("disabled", { enabled: false })]);
  write(projectRoutePath(f), [agent("worker-pro", { model: "project-model", overridesGlobal: true })]);
  const subdir = path.join(f.projectRoot, "src"); fs.mkdirSync(subdir);
  const wrapper = { ToolName: "delegate_task", Arguments: { title: "worker-pro · task", target: {}, task: "preserve" } };
  assert.equal(run(f, "subagent-route-guard.mjs", { tool_name: "mcp_dispatch", tool_input: wrapper, cwd: subdir }), null);
  const result = run(f, "subagent-route-guard.mjs", { tool_name: "mcp__t3-code__delegate_task", tool_input: wrapper.Arguments, cwd: subdir }).hookSpecificOutput.updatedInput;
  assert.equal(result.target.model, "project-model"); assert.match(result.task, /preserve$/);
  const payload = { tool_name: "mcp__t3_code__delegate_task", tool_input: { clientRequestId: "custom", target: {} }, cwd: f.projectRoot };
  assert.equal(run(f, "subagent-route-guard.mjs", payload).hookSpecificOutput.updatedInput.target.model, "gpt-6.1-sol");
  for (const tool_input of [{ title: "disabled", target: {} }, { title: "unknown", target: {} }]) assert.equal(run(f, "subagent-route-guard.mjs", { ...payload, tool_input }), null);
  assert.equal(run(f, "subagent-route-guard.mjs", { ...payload, tool_input: { role: "implementation", target: {} } }).hookSpecificOutput.updatedInput.target.model, "gpt-6.1-sol");
  assert.equal(run(f, "subagent-route-guard.mjs", { ...payload, tool_name: "other" }), null);
});

test("route: provider effort mappings, role lookup, partial project overrides and no hook writes", t => {
  const f = fixture(t), file = path.join(f.hubDir, "subagents.json"), projectFile = projectRoutePath(f); setGlobalOrchestration(f, "on");
  for (const [providerInstanceId, effort, options] of [["muse", "high", { reasoningEffort: "high" }], ["pi", "max", { thinking: "max" }], ["claudeAgent", "ultrathink", { effort: "ultrathink" }]]) {
    write(file, { items: [agent("helper", { providerInstanceId, effort })] });
    const out = run(f, "subagent-route-guard.mjs", { tool_name: "mcp__t3_code__delegate_task", tool_input: { role: "implementation", target: {} }, cwd: f.projectRoot });
    assert.deepEqual(out.hookSpecificOutput.updatedInput.target.options, options);
  }
  write(file, [agent("helper", { memoryPolicy: "off" })]);
  write(projectFile, { items: [{ id: "helper", model: "project-latest", effort: "max" }] });
  const mgr = createSubagentsManager(f), resolved = mgr.resolveSubagentRoute({ idOrTitle: "helper", projectRoot: f.projectRoot });
  assert.equal(resolved.target.model, "project-latest"); assert.equal(resolved.target.providerInstanceId, "codex"); assert.equal(resolved.item.memoryPolicy, "off");
  write(projectFile, [{ id: "helper", enabled: false }]);
  assert.equal(mgr.resolveSubagentRoute({ idOrTitle: "helper", projectRoot: f.projectRoot }).matched, false);
  assert.ok(!fs.existsSync(path.join(f.hubDir, "global-AGENTS.md")));
  assert.ok(!fs.existsSync(path.join(f.homeDir, ".claude")));
});

test("subagents: memory policy defaults, validation, partial updates and real-time resolution", t => {
  const f = fixture(t), mgr = createSubagentsManager(f), initial = mgr.listSubagents({});
  assert.equal(initial.globalItems.find(x => x.id === "explorer").memoryPolicy, "readonly");
  assert.equal(initial.globalItems.find(x => x.id === "code-review").memoryPolicy, "readonly");
  assert.equal(initial.globalItems.find(x => x.id === "worker").memoryPolicy, "readwrite");
  const saved = mgr.saveSubagent({ item: agent("custom", { memoryPolicy: "off", avatarColor: "pink" }) });
  assert.equal(saved.item.memoryPolicy, "off"); assert.equal(saved.item.avatarColor, "pink");
  mgr.saveSubagent({ item: agent("custom", { model: "updated" }) });
  assert.equal(mgr.listSubagents({}).globalItems.find(x => x.id === "custom").memoryPolicy, "off");
  assert.throws(() => mgr.saveSubagent({ item: agent("bad", { memoryPolicy: "write" }) }));
  assert.throws(() => mgr.saveSubagent({ item: agent("bad", { avatarColor: "red" }) }));
  const res = mgr.resolveSubagentRoute({ idOrTitle: "custom · Task" }); assert.equal(res.ok, true); assert.equal(res.matched, true); assert.equal(res.target.model, "updated");
  write(mgr.globalPath, [agent("custom", { effort: "max" })]);
  assert.equal(mgr.resolveSubagentRoute({ idOrTitle: "custom" }).target.options.reasoningEffort, "max");
  assert.equal(mgr.resolveSubagentRoute({ idOrTitle: "missing" }).matched, false);
  assert.equal(typeof resolveSubagentRoute, "function");
});

test("subagents: explicit extra sync targets, default no AGY writes, memory instructions", t => {
  const f = fixture(t), extra = path.join(f.dir, "extra/GEMINI.md"), agy = path.join(f.homeDir, ".t3/userdata/providers/antigravity");
  const mgr = createSubagentsManager({ ...f, extraSyncPaths: [extra] });
  const res = mgr.saveSubagent({ item: agent("custom") });
  assert.ok(fs.existsSync(extra)); assert.ok(!fs.existsSync(agy));
  assert.match(res.renderedMarkdownBlock, /子智能体路由与系统提示词 \(T3 Hub Sub-Agents\)/);
  assert.match(res.renderedMarkdownBlock, /派发任何子智能体前，若会话较长或用户刚调整过配置/);
  assert.match(res.renderedMarkdownBlock, /memory_search/); assert.match(res.renderedMarkdownBlock, /已验证/); assert.match(res.renderedMarkdownBlock, /memory_write/);
  assert.match(fs.readFileSync(path.join(f.homeDir, ".claude/agents/explorer.md"), "utf8"), /只读检索.*不.*写/);
  assert.ok(res.renderedMarkdownBlock.includes("<!-- t3-hub-subagents:start -->"));
  const perCallExtra = path.join(f.dir, "per-call/AGENTS.md");
  mgr.saveSubagent({ item: agent("another"), extraSyncPaths: [perCallExtra] });
  assert.ok(fs.existsSync(perCallExtra));
});


test("stop: other project writes cannot suppress current Git root reminder", t => {
  const f = fixture(t);
  const { createMemoryVault } = require("../src/memory-vault.cjs");
  const nested = path.join(f.projectRoot, "src");
  fs.mkdirSync(nested);
  write(path.join(nested, "change.js"), "const changed = true;");
  const otherRoot = path.join(f.dir, "other-project");
  fs.mkdirSync(otherRoot, { recursive: true });
  spawnSync("git", ["init", "-q", otherRoot]);
  const vault = createMemoryVault({ vaultDir: path.join(f.hubDir, "memory"), homeDir: f.homeDir, hubDir: f.hubDir, _embedFn: () => null });
  assert.equal(vault.saveMemory({ projectRoot: otherRoot, title: "Other project", content: "recent memory elsewhere", autoEvolve: false }).ok, true);
  assert.equal(run(f, "memory-stop-hook.mjs", { cwd: nested, session_id: "project-b" }).decision, "block");
  assert.equal(vault.saveMemory({ projectRoot: nested, title: "Current project", content: "recent current memory", autoEvolve: false }).ok, true);
  assert.equal(run(f, "memory-stop-hook.mjs", { cwd: nested, session_id: "project-b-with-memory" }), null);
});

test("stop: a corrupt isolated memory index fails closed without a nudge", t => {
  const f = fixture(t);
  write(path.join(f.projectRoot, "change.js"), "const changed = true;");
  write(path.join(f.hubDir, "memory", "index.sqlite"), "not a sqlite database");
  assert.equal(run(f, "memory-stop-hook.mjs", { cwd: f.projectRoot, session_id: "corrupt-memory-index" }), null);
});


test("stop: same-named Git roots use the vault's collision-safe project directory", t => {
  const f = fixture(t), other = path.join(f.dir, "other", path.basename(f.projectRoot));
  fs.mkdirSync(other, { recursive: true });
  spawnSync("git", ["init", "-q", other]);
  const { createMemoryVault } = require("../src/memory-vault.cjs");
  const vault = createMemoryVault({ homeDir: f.homeDir, hubDir: f.hubDir, _embedFn: () => null });
  assert.equal(vault.saveMemory({ projectRoot: other, title: "other", content: "other project", autoEvolve: false }).ok, true);
  write(path.join(f.projectRoot, "dirty.js"), "const dirty = true;");
  assert.notEqual(vault.resolveProjectSlug(other), vault.resolveProjectSlug(f.projectRoot));
  assert.equal(run(f, "memory-stop-hook.mjs", { cwd: f.projectRoot, session_id: "same-basename" }).decision, "block");
  assert.equal(vault.saveMemory({ projectRoot: f.projectRoot, title: "current", content: "current project", autoEvolve: false }).ok, true);
  assert.equal(run(f, "memory-stop-hook.mjs", { cwd: f.projectRoot, session_id: "same-basename-written" }), null);
});
