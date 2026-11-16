"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const vm = require("node:vm");
const { createRequire } = require("node:module");

const REPO = path.resolve(__dirname, "..");

function makeTmp(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `t3-safety-${label}-`));
}

function modeOf(file) {
  return fs.statSync(file).mode & 0o777;
}

// ---------------------------------------------------------------------------
// 1. hub-subagents ownership
// ---------------------------------------------------------------------------
describe("safety: hub-subagents managed ownership", () => {
  // Inspect the real private predicate without adding a production test API.
  const source = path.join(REPO, "src/hub-subagents.cjs");
  const predicateModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(source, "utf8") + "\nmodule.exports.isHubManagedContent = isHubManagedContent;", {
    module: predicateModule, require: createRequire(source), process, __dirname: path.dirname(source),
  }, { filename: source });
  const { isHubManagedContent } = predicateModule.exports;

  for (const [label, content] of [
    ["body tutorial", "# User docs\nExample:\nt3_hub_managed: true\n<!-- managed-by: t3-hub -->\n"],
    ["code fence", "---\nname: doc\n---\n```yaml\nt3_hub_managed: true\n```\n"],
    ["trueish", "---\nname: doc\nt3_hub_managed: trueish\n---\nUser docs\n"],
    ["nested YAML key", "---\nname: doc\nexample:\n  t3_hub_managed: true\n---\nUser docs\n"],
    ["malformed frontmatter", "---\nt3_hub_managed: true\n---oops\n"],
    ...[
      'invalid: [\nt3_hub_managed: true',
      't3_hub_managed: true\nt3_hub_managed: false',
      't3_hub_managed: true\nname: first\nname: second',
      't3_hub_managed: true\ntools: []\n"tools": []',
      't3_hub_managed: true\ninvalid: "unclosed',
      "t3_hub_managed: true\ninvalid: 'unclosed",
      't3_hub_managed: true\ninvalid: {key: value',
      't3_hub_managed: true\ninvalid: [one, two}',
      't3_hub_managed: true\ninvalid top level line',
      't3_hub_managed: true\ninvalid: "closed" garbage',
      't3_hub_managed: true\ninvalid: [one two, {key value}]',
      't3_hub_managed: true\ninvalid: scalar\n  unexpected: child',
      't3_hub_managed: true\ninvalid:\n  child: a\n child2: b',
      't3_hub_managed: true\ninvalid: [one, :bad]',
      't3_hub_managed: true\ninvalid: [one, ?bad]',
      't3_hub_managed: true\ninvalid: "closed"#unseparated',
      't3_hub_managed: true\n1: first\n01: repeated-numeric-key',
      't3_hub_managed: true\ntrue: first\nTrue: repeated-boolean-key',
      't3_hub_managed: true\ninvalid: true\u2028broken line',
      't3_hub_managed: true\ninvalid: {a: 1, "a": 2}',
      't3_hub_managed: true\ninvalid: ,reserved-indicator',
    ].flatMap((body, i) => [
      [`damaged YAML ${i}`, `---\n${body}\n---\nUser docs\n`],
      [`HTML cannot override damaged YAML ${i}`, `---\n${body}\n---\n<!-- managed-by: t3-hub -->\n`],
    ]),
    ["HTML cannot override explicit false", "---\nt3_hub_managed: false\n---\n<!-- managed-by: t3-hub -->\n"],
    ["HTML cannot override ambiguous string", '---\nt3_hub_managed: "true"\n---\n<!-- managed-by: t3-hub -->\n'],
  ]) {
    it(`predicate rejects ${label}`, () => assert.equal(isHubManagedContent(content), false));
    for (const scope of ["global", "project"]) it(`${scope} preserves ${label} through sync, disable and delete`, () => {
      const { createSubagentsManager } = require(path.join(REPO, "src/hub-subagents.cjs"));
      const home = makeTmp("ownership");
      const projectRoot = path.join(home, "project");
      const dir = path.join(scope === "global" ? home : projectRoot, ".claude", "agents");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "doc.md");
      fs.writeFileSync(file, content);
      const mgr = createSubagentsManager({ homeDir: home });
      const item = { id: "doc", providerInstanceId: "muse", model: "muse-ember-1.0", effort: "max", enabled: true };
      const saved = mgr.saveSubagent({ scope, projectRoot, item });
      assert.ok(saved.conflicts.some(c => c.id === "doc"));
      assert.equal(fs.readFileSync(file, "utf8"), content);
      mgr.saveSubagent({ scope, projectRoot, item: { ...item, enabled: false } });
      assert.equal(fs.readFileSync(file, "utf8"), content);
      mgr.deleteSubagent({ scope, projectRoot, id: "doc" });
      assert.equal(fs.readFileSync(file, "utf8"), content);
    });
  }

  for (const body of [
    'name: doc\nt3_hub_managed: true',
    '"t3_hub_managed": true\nname: doc',
    'description: "quoted \\"value\\" [literal]"\nt3_hub_managed: true',
    "description: 'it''s a valid string'\nt3_hub_managed: true",
    'tools:\n  - Read\n  - Write\noptions:\n  nested: {values: [one, "two", {three: 3}]}\nt3_hub_managed: true',
    'tools:\n  - name: Read\n    enabled: true\n  - name: Write\nt3_hub_managed: true',
    'tools: [\n  Read,\n  Write\n]\nt3_hub_managed: true',
    'description: |\n  Opaque prose: [ and { and "\n  t3_hub_managed: false\nt3_hub_managed: true',
    'description: >-\n  Folded prose\n  with another line\nt3_hub_managed: true',
  ]) it(`accepts valid YAML ${JSON.stringify(body)}`, () => {
    assert.equal(isHubManagedContent(`---\n${body}\n---\nBody\n`), true);
  });

  for (const marker of [
    "---\r\nname: doc\r\nt3_hub_managed: true # owned\r\n---\r\n",
    "<!-- managed-by: t3-hub -->\n",
    "---\nname: doc\n---\n<!-- managed-by: t3-hub -->\n",
    "---\n---\n<!-- managed-by: t3-hub -->\n",
  ]) it(`accepts anchored ownership ${JSON.stringify(marker)}`, () => {
    const { createSubagentsManager } = require(path.join(REPO, "src/hub-subagents.cjs"));
    const home = makeTmp("marker");
    const dir = path.join(home, ".claude", "agents");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "doc.md");
    fs.writeFileSync(file, marker + "Old content");
    const mgr = createSubagentsManager({ homeDir: home });
    mgr.saveSubagent({ scope: "global", item: { id: "doc", providerInstanceId: "muse", model: "muse-ember-1.0", effort: "max", systemPrompt: "new content" } });
    assert.ok(fs.readFileSync(file, "utf8").includes("new content"));
  });

  for (const target of ["file", "dangling", "agents directory", "host parent", "backup", "config"]) it(`rejects ${target} symlinks without external changes`, () => {
    const { createSubagentsManager } = require(path.join(REPO, "src/hub-subagents.cjs"));
    const home = makeTmp("links");
    const victim = makeTmp("victim");
    const original = "---\nt3_hub_managed: true\n---\nExternal owned content\n";
    fs.writeFileSync(path.join(victim, "doc.md"), original);
    const agents = path.join(home, ".claude", "agents");
    fs.mkdirSync(agents, { recursive: true });
    fs.mkdirSync(path.join(home, ".t3", "hub"), { recursive: true });
    let linked;
    if (target === "file" || target === "dangling") {
      linked = path.join(agents, "doc.md");
      fs.symlinkSync(path.join(victim, target === "file" ? "doc.md" : "missing"), linked);
    } else if (target === "agents directory") {
      fs.rmdirSync(agents); linked = agents; fs.symlinkSync(victim, linked);
    } else if (target === "host parent") {
      linked = path.join(home, ".codex"); fs.symlinkSync(victim, linked);
    } else if (target === "backup") {
      const hostFile = path.join(home, ".claude", "CLAUDE.md");
      fs.writeFileSync(hostFile, "Host user rules\n");
      linked = hostFile + ".bak-t3hub"; fs.symlinkSync(path.join(victim, "new.md"), linked);
    } else {
      linked = path.join(home, ".t3", "hub", "subagents.json");
      fs.symlinkSync(path.join(victim, "missing.json"), linked);
    }
    const mgr = createSubagentsManager({ homeDir: home });
    assert.throws(() => mgr.saveSubagent({ scope: "global", item: { id: "doc", providerInstanceId: "muse", model: "muse-ember-1.0", effort: "max" } }), /symlink|symbolic|unsafe/i);
    assert.ok(fs.lstatSync(linked).isSymbolicLink());
    assert.equal(fs.readFileSync(path.join(victim, "doc.md"), "utf8"), original);
    assert.deepEqual(fs.readdirSync(victim), ["doc.md"]);
  });

  it("global sync preserves unmanaged explorer/custom-user (no overwrite, no delete)", () => {
    const { createSubagentsManager } = require(path.join(REPO, "src/hub-subagents.cjs"));
    const home = makeTmp("home-global");
    const hub = path.join(home, ".t3", "hub");
    const claudeAgentsRoot = path.join(home, ".claude", "agents");
    fs.mkdirSync(claudeAgentsRoot, { recursive: true });
    fs.mkdirSync(hub, { recursive: true });
    const unmanagedExplorer = "# my custom explorer\ncustom content do not touch\n";
    const unmanagedCustom = "---\nname: custom-user\ndescription: mine\n---\nuser owned\n";
    fs.writeFileSync(path.join(claudeAgentsRoot, "explorer.md"), unmanagedExplorer, "utf8");
    fs.writeFileSync(path.join(claudeAgentsRoot, "custom-user.md"), unmanagedCustom, "utf8");
    const mgr = createSubagentsManager({ homeDir: home, hubDir: hub, claudeAgentsRoot });
    // Trigger global sync via save of an unrelated enabled agent
    const saved = mgr.saveSubagent({
      scope: "global",
      item: { id: "worker", role: "implementation", providerInstanceId: "muse", model: "muse-ember-1.0", effort: "max", description: "worker desc", systemPrompt: "worker prompt", enabled: true },
    });
    assert.equal(saved.ok, true);
    // Unmanaged files must be untouched
    assert.equal(fs.readFileSync(path.join(claudeAgentsRoot, "explorer.md"), "utf8"), unmanagedExplorer);
    assert.equal(fs.readFileSync(path.join(claudeAgentsRoot, "custom-user.md"), "utf8"), unmanagedCustom);
    // Conflicts must be reported
    const conflicts = saved.conflicts || saved.skippedUnmanaged || [];
    assert.ok(Array.isArray(conflicts), "conflicts array present");
    const names = JSON.stringify(conflicts).toLowerCase();
    assert.ok(names.includes("explorer"), "conflict mentions explorer: " + JSON.stringify(conflicts));
  });

  it("managed files update + disabled cleanup still works", () => {
    const { createSubagentsManager } = require(path.join(REPO, "src/hub-subagents.cjs"));
    const home = makeTmp("home-managed");
    const hub = path.join(home, ".t3", "hub");
    const claudeAgentsRoot = path.join(home, ".claude", "agents");
    fs.mkdirSync(claudeAgentsRoot, { recursive: true });
    const mgr = createSubagentsManager({ homeDir: home, hubDir: hub, claudeAgentsRoot });
    // First sync creates managed worker.md
    mgr.saveSubagent({
      scope: "global",
      item: { id: "worker", role: "implementation", providerInstanceId: "muse", model: "muse-ember-1.0", effort: "max", description: "v1", systemPrompt: "prompt-v1", enabled: true },
    });
    const workerPath = path.join(claudeAgentsRoot, "worker.md");
    assert.ok(fs.existsSync(workerPath), "managed worker.md created");
    const v1 = fs.readFileSync(workerPath, "utf8");
    assert.ok(v1.includes("prompt-v1"), "v1 content present");
    assert.ok(v1.includes("t3_hub_managed") || v1.includes("managed-by: t3-hub"), "managed marker present in generated file: " + v1.slice(0, 400));
    // Update managed file
    mgr.saveSubagent({
      scope: "global",
      item: { id: "worker", role: "implementation", providerInstanceId: "muse", model: "muse-ember-1.0", effort: "max", description: "v2", systemPrompt: "prompt-v2", enabled: true },
    });
    const v2 = fs.readFileSync(workerPath, "utf8");
    assert.ok(v2.includes("prompt-v2"), "managed file updated");
    // Disable worker -> managed file should be removed
    mgr.saveSubagent({
      scope: "global",
      item: { id: "worker", role: "implementation", providerInstanceId: "muse", model: "muse-ember-1.0", effort: "max", description: "v2", systemPrompt: "prompt-v2", enabled: false },
    });
    assert.ok(!fs.existsSync(workerPath), "disabled managed file removed");
  });

  it("project sync preserves unmanaged files, managed cleanup works", () => {
    const { createSubagentsManager } = require(path.join(REPO, "src/hub-subagents.cjs"));
    const home = makeTmp("home-proj");
    const hub = path.join(home, ".t3", "hub");
    const proj = makeTmp("proj-safety");
    fs.mkdirSync(path.join(proj, ".git", "info"), { recursive: true });
    fs.writeFileSync(path.join(proj, ".git", "info", "exclude"), "", "utf8");
    const projAgents = path.join(proj, ".claude", "agents");
    fs.mkdirSync(projAgents, { recursive: true });
    const unmanagedExplorer = "---\nname: explorer\ndescription: user\n---\nUSER FILE\n";
    const unmanagedCustom = "user custom proj\n";
    fs.writeFileSync(path.join(projAgents, "explorer.md"), unmanagedExplorer, "utf8");
    fs.writeFileSync(path.join(projAgents, "custom-user.md"), unmanagedCustom, "utf8");
    const mgr = createSubagentsManager({ homeDir: home, hubDir: hub });
    // Save a project agent with same id as unmanaged explorer -> must skip overwrite
    const saved = mgr.saveSubagent({
      scope: "project",
      projectRoot: proj,
      item: { id: "explorer", role: "research", providerInstanceId: "muse", model: "muse-ember-1.0", effort: "max", description: "proj explorer", systemPrompt: "proj prompt", enabled: true },
    });
    assert.equal(saved.ok, true);
    assert.equal(fs.readFileSync(path.join(projAgents, "explorer.md"), "utf8"), unmanagedExplorer);
    assert.equal(fs.readFileSync(path.join(projAgents, "custom-user.md"), "utf8"), unmanagedCustom);
    const conflicts = saved.conflicts || saved.skippedUnmanaged || [];
    assert.ok(JSON.stringify(conflicts).toLowerCase().includes("explorer"), "project conflict reported: " + JSON.stringify(conflicts));
    // Managed project agent lifecycle
    const saved2 = mgr.saveSubagent({
      scope: "project",
      projectRoot: proj,
      item: { id: "proj-helper", role: "general", providerInstanceId: "muse", model: "muse-ember-1.0", effort: "max", description: "helper", systemPrompt: "helper prompt", enabled: true },
    });
    assert.equal(saved2.ok, true);
    const helperPath = path.join(projAgents, "proj-helper.md");
    assert.ok(fs.existsSync(helperPath));
    assert.ok(fs.readFileSync(helperPath, "utf8").includes("helper prompt"));
    // Disable -> managed removed, unmanaged still preserved
    mgr.saveSubagent({
      scope: "project",
      projectRoot: proj,
      item: { id: "proj-helper", role: "general", providerInstanceId: "muse", model: "muse-ember-1.0", effort: "max", description: "helper", systemPrompt: "helper prompt", enabled: false },
    });
    assert.ok(!fs.existsSync(helperPath), "disabled managed proj file removed");
    assert.equal(fs.readFileSync(path.join(projAgents, "custom-user.md"), "utf8"), unmanagedCustom);
    assert.equal(fs.readFileSync(path.join(projAgents, "explorer.md"), "utf8"), unmanagedExplorer);
  });

  it("deleteSubagent does not delete unmanaged file", () => {
    const { createSubagentsManager } = require(path.join(REPO, "src/hub-subagents.cjs"));
    const home = makeTmp("home-del");
    const hub = path.join(home, ".t3", "hub");
    const proj = makeTmp("proj-del");
    fs.mkdirSync(path.join(proj, ".git", "info"), { recursive: true });
    const projAgents = path.join(proj, ".claude", "agents");
    fs.mkdirSync(projAgents, { recursive: true });
    const unmanaged = "user content keep\n";
    fs.writeFileSync(path.join(projAgents, "myagent.md"), unmanaged, "utf8");
    const mgr = createSubagentsManager({ homeDir: home, hubDir: hub });
    // Register project agent myagent in config, but file on disk is unmanaged.
    // First save will skip overwrite, then delete must not delete unmanaged file.
    mgr.saveSubagent({
      scope: "project",
      projectRoot: proj,
      item: { id: "myagent", role: "general", providerInstanceId: "muse", model: "muse-ember-1.0", effort: "max", description: "x", systemPrompt: "y", enabled: true },
    });
    assert.equal(fs.readFileSync(path.join(projAgents, "myagent.md"), "utf8"), unmanaged);
    const del = mgr.deleteSubagent({ scope: "project", projectRoot: proj, id: "myagent" });
    assert.equal(del.ok, true);
    assert.equal(fs.readFileSync(path.join(projAgents, "myagent.md"), "utf8"), unmanaged, "unmanaged file must survive delete");
  });
});

// ---------------------------------------------------------------------------
// 2. Codex TOML multiline safety
// ---------------------------------------------------------------------------
describe("safety: Codex TOML multiline lexical safety", () => {
  function codexMgrWithToml(tomlText) {
    const home = makeTmp("home-toml");
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.mkdirSync(path.join(home, ".config", "muse"), { recursive: true });
    fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
    const codexPath = path.join(home, ".codex", "config.toml");
    fs.writeFileSync(codexPath, tomlText, "utf8");
    const { createHostSettingsManager } = require(path.join(REPO, "src/hub-host-settings.cjs"));
    const mgr = createHostSettingsManager({ homeDir: home });
    return { home, codexPath, mgr };
  }

  it("update top key does not touch fake model inside triple-quoted string", () => {
    const toml = [
      'model = "gpt-6.1-sol"',
      'model_reasoning_effort = "medium"',
      'approval_policy = "on-request"',
      'sandbox_mode = "workspace-write"',
      '',
      'note = """',
      'model = "fake"',
      '[fake_section]',
      'fake_key = "inside"',
      '"""',
      '',
      '[mcp_servers.t3_hub]',
      'command = "/tmp/router"',
    ].join("\n") + "\n";
    const { mgr, codexPath } = codexMgrWithToml(toml);
    const before = fs.readFileSync(codexPath, "utf8");
    mgr.updateHostSetting({ host: "codex", key: "model_reasoning_effort", value: "max" });
    const after = fs.readFileSync(codexPath, "utf8");
    // Real key updated
    const { parseTomlTopLevel } = require(path.join(REPO, "src/hub-host-settings.cjs"));
    const parsed = parseTomlTopLevel(after);
    assert.equal(parsed.model_reasoning_effort, "max");
    assert.equal(parsed.model, "gpt-6.1-sol");
    // Multiline body byte-identical
    assert.ok(after.includes('model = "fake"'), "fake model preserved inside triple-quoted string");
    assert.ok(after.includes("[fake_section]"), "fake section preserved inside string");
    // Only the real top key line changed: fake line must still be fake, not max
    const lines = after.split("\n");
    const fakeLines = lines.filter((l) => l.includes('"fake"'));
    assert.equal(fakeLines.length, 1, "exactly one fake line, got " + JSON.stringify(fakeLines));
    // Top real mcp table still present
    assert.ok(after.includes("[mcp_servers.t3_hub]"));
    // Real table mcp count should still be 1 (fake inside string must not inflate)
    const snap = mgr.getSettingsSnapshot();
    assert.equal(snap.codex.mcpServerCount, 1, "mcp count not fooled by fake inside multiline, got " + snap.codex.mcpServerCount);
  });

  it("update replaces whole multiline old value (no dangling quotes)", () => {
    const toml = [
      'model = """',
      'gpt-old-multiline',
      '"""',
      'approval_policy = "on-request"',
      '',
      '[mcp_servers.t3_hub]',
      'command = "/tmp/router"',
    ].join("\n") + "\n";
    const { mgr, codexPath, home } = codexMgrWithToml(toml);
    mgr.updateHostSetting({ host: "codex", key: "model", value: "gpt-new" });
    const after = fs.readFileSync(codexPath, "utf8");
    const { parseTomlTopLevel } = require(path.join(REPO, "src/hub-host-settings.cjs"));
    const parsed = parseTomlTopLevel(after);
    assert.equal(parsed.model, "gpt-new");
    assert.ok(!after.includes("gpt-old-multiline"), "old multiline body removed");
    // No dangling triple quotes left for model line
    const modelLines = after.split("\n").filter((l) => /^\s*model\s*=/.test(l));
    assert.equal(modelLines.length, 1, "single model assignment, got " + JSON.stringify(modelLines));
    assert.ok(modelLines[0].includes('"gpt-new"'));
    assert.ok(!modelLines[0].includes('"""'), "no dangling triple quote on updated line");
  });

  it("multiline array + literal '' string do not fool insertion", () => {
    const toml = [
      'model = "gpt-6.1-sol"',
      'tags = [',
      '  "model = fake-array",',
      '  "[fake_array_header]",',
      ']',
      "note = '''",
      'model = "fake-literal"',
      "[fake_literal_section]",
      "'''",
      '',
      '[mcp_servers.t3_hub]',
      'command = "/tmp/router"',
    ].join("\n") + "\n";
    const { mgr, codexPath } = codexMgrWithToml(toml);
    // Insert missing key approval_policy -> must land before real table, not inside array/string
    mgr.updateHostSetting({ host: "codex", key: "approval_policy", value: "never" });
    const after = fs.readFileSync(codexPath, "utf8");
    const { parseTomlTopLevel } = require(path.join(REPO, "src/hub-host-settings.cjs"));
    const parsed = parseTomlTopLevel(after);
    assert.equal(parsed.approval_policy, "never");
    assert.equal(parsed.model, "gpt-6.1-sol");
    // Array/literal bodies preserved
    assert.ok(after.includes('"model = fake-array"'), "array fake preserved");
    assert.ok(after.includes('model = "fake-literal"'), "literal fake preserved");
    // New key is at top level before real table, not inside multiline constructs.
    // Find positions: new key line index < real table index, and multiline delimiters count unchanged
    const count = (s, sub) => s.split(sub).length - 1;
    assert.equal(count(after, '"""'), count(toml, '"""') + 0, "triple-double count stable when using ''' fixture");
    const lines = after.split("\n");
    const keyIdx = lines.findIndex((l) => l.startsWith('approval_policy = "never"'));
    const realIdx = lines.findIndex((l) => l.startsWith("[mcp_servers.t3_hub]"));
    assert.ok(keyIdx !== -1 && realIdx !== -1 && keyIdx < realIdx, "inserted before real table");
    // Fake headers inside array/string must not be at line start as real table parsing would think.
    // mcp count still 1
    const snap = mgr.getSettingsSnapshot();
    assert.equal(snap.codex.mcpServerCount, 1);
  });

  for (const bad of [
    'model = "first"\nmodel = "second"',
    '[sec]\na = 1\na = 2',
    'model = "x"\nmodel.foo = 1', 'model.foo = 1\nmodel = "x"',
    'model = "x"\n[model]', 'model.foo = 1\n[model]',
    '[model]\n[model.foo]\n[model]',
    '[section]\n[section]', '[broken..header]', '[.bad]', '[bad.]', '[]', '[[]]',
    '[[broken..header]]', '[[.bad]]', '[[bad.]]',
    '[bad name]', '[a] garbage', '[[a]] garbage', '[a]]', '[[a]]]',
    'a = { b = 1 }\na.c = 2', 'a = { b = 1 }\n[a.c]',
    'a = []\n[[a]]', 'a.b = 1\n[[a]]', '[[a]]\n[a]', '[a]\n[[a]]',
    '[a.b]\n[a]\nb.c = 1', '[a.b]\n[a]\nb = 1',
    '"a" = 1\n"\\u0061" = 2',
    '["a.b"]\nx = 1\n[\'a.b\']\nx = 2',
    '[[a]]\n[a.b]\nx = 1\n[a.b]\nx = 2',
    'other = 123 [', 'model = "gpt" garbage', 'bad = unquoted_word', 'bad = foo bar',
    'bad = trueish', 'bad = 01', 'bad = +0xFF', 'bad = 1__2', 'bad = 1_',
    'bad = 1.', 'bad = .1', 'bad = 1e', 'bad = 1e_2', 'bad = 0xFG',
    'bad = 2024-02-30', 'bad = 2023-02-29', 'bad = 12:60:00', 'bad = 2024-01-01T00:00:00+25:00',
    'bad = "abc" trailing', "bad = 'abc' trailing", 'bad = """abc""" trailing', "bad = \"\"\"abc\"\"\" trailing".replaceAll('"', "'"),
    'bad = [1] trailing', 'bad = { a = 1 } trailing', 'bad = [1 2]', 'bad = [1,,2]',
    'bad = ["a" trailing]', 'bad = ["a" "b"]', 'bad = [123 []]', 'bad = [foo]',
    'bad = [{a=1} garbage]', 'bad = [{a=[1 2]}]', 'bad = { a = }', 'bad = { a 1 }',
    'bad = { = 1 }', 'bad = { a = 1 b = 2 }', 'bad = { a = "x" trailing }',
    'bad = { a = 1,, b = 2 }', 'bad = { a = 1, }', 'bad = { a = foo }',
    'bad = { a..b = 1 }', 'bad = { a = 1, a = 2 }', 'bad = { a = 1, a.b = 2 }',
    'bad = { a.b = 1, a = 2 }', 'bad = { a = [1, 2}', 'bad = [{a=1]',
    'bad = "invalid\\q"', 'bad = "\\uD800"', 'bad = """six quotes""""""',
  ]) it(`rejects damaged TOML ${JSON.stringify(bad)} before backup/write`, () => {
    const { mgr, codexPath } = codexMgrWithToml(bad + "\n");
    const before = fs.readFileSync(codexPath);
    assert.throws(() => mgr.updateHostSetting({ host: "codex", key: "model", value: "gpt-new" }), /TOML/i);
    assert.deepEqual(fs.readFileSync(codexPath), before);
    assert.equal(fs.existsSync(codexPath + ".t3hub.bak"), false);
  });

  for (const body of [
    'a.b = 1\na.c = 2',
    '[a.b]\nx = 1\n[a]\ny = 2',
    '[a.b]\nx = 1\n[a.c]\nx = 2',
    '[a.b]\nx = 1\n[a]\nc.d = 2\nc.e = 3',
    '[[a]]\nx = 1\n[[a]]\nx = 2',
    '[[a]]\n[a.b]\nx = 1\n[[a]]\n[a.b]\nx = 2',
    '[[a]]\n[[a.b]]\nx = 1\n[[a.b]]\nx = 2\n[[a]]\n[[a.b]]\nx = 3',
    '["a.b" . \'c.d\'] # quoted segments\nx = 1\n[a.b]\nx = 2',
    '[["a.b"]]\nx = 1\n[["a.b"]]\nx = 2',
    '["" . "brackets]#"]\nx = 1',
  ]) it(`preserves valid TOML namespaces ${JSON.stringify(body)}`, () => {
    const { mgr, codexPath } = codexMgrWithToml('model = "old"\n' + body + '\n');
    mgr.updateHostSetting({ host: "codex", key: "model", value: "new" });
    assert.equal(fs.readFileSync(codexPath, "utf8"), 'model = "new"\n' + body + '\n');
  });

  for (const body of ['model.foo = 1\n', '[model]\nfoo = 1\n', 'model = { foo = 1 }\nmodel.bar = 2\n']) {
    it(`refuses insertion/extension conflicts before backup ${JSON.stringify(body)}`, () => {
      const { mgr, codexPath } = codexMgrWithToml(body);
      const before = fs.readFileSync(codexPath);
      assert.throws(() => mgr.updateHostSetting({ host: "codex", key: "model", value: "new" }), /TOML/i);
      assert.deepEqual(fs.readFileSync(codexPath), before);
      assert.equal(fs.existsSync(codexPath + ".t3hub.bak"), false);
    });
  }

  it("preserves all valid scalar kinds and nested values byte for byte", () => {
    const values = [
      "true", "false", "0", "+0", "-0", "123_456", "-123_456", "0xDEAD_beef", "0o7_55", "0b10_01",
      "1.0", "-0.0", "+1e+2", "1_234.5_6e-7_8", "inf", "+inf", "-inf", "nan", "+nan", "-nan",
      "2024-02-29", "1979-05-27T07:32:00Z", "1979-05-27t07:32:00z", "1979-05-27 07:32:00.123-07:30",
      "1979-05-27T07:32:00", "07:32:00.999", "23:59:60.123",
      '[]', '{}', '[1, "two", true, {a=[1, 2,], b={c=3}},]',
      '{ a.b = 1, a.c = [false], "" = 0, quoted = {"a.b" = 2} }',
      '[\n# Comment with fake [ and }\n 1,\n {a = 2},\n]',
      '"""a\\\n  b"""', '"""a"""""', "\"\"\"a\"\"\"\"\"".replaceAll('"', "'"),
    ];
    const body = values.map((v, i) => `v${i} = ${v} # preserved`).join("\n") + "\n";
    const { mgr, codexPath } = codexMgrWithToml('model = "old"\n' + body);
    mgr.updateHostSetting({ host: "codex", key: "model", value: "new" });
    assert.equal(fs.readFileSync(codexPath, "utf8"), 'model = "new"\n' + body);
  });

  it("corrupt unclosed TOML throws and leaves bytes unchanged", () => {
    const bad = 'model = """unclosed\nmodel_reasoning_effort = "medium"\n[fake]\n';
    const { mgr, codexPath } = codexMgrWithToml(bad);
    const before = fs.readFileSync(codexPath);
    assert.throws(() => mgr.updateHostSetting({ host: "codex", key: "model", value: "gpt-x" }), Error);
    const after = fs.readFileSync(codexPath);
    assert.ok(before.equals(after), "bytes unchanged on corrupt TOML");
  });

  it("corrupt unclosed array throws and leaves bytes unchanged", () => {
    const bad = 'model = "gpt-6.1-sol"\ntags = [\n  "a",\n';
    const { mgr, codexPath } = codexMgrWithToml(bad);
    const before = fs.readFileSync(codexPath);
    assert.throws(() => mgr.updateHostSetting({ host: "codex", key: "model", value: "gpt-y" }), Error);
    assert.ok(before.equals(fs.readFileSync(codexPath)), "bytes unchanged on unclosed array");
  });
});

// ---------------------------------------------------------------------------
// 3 + 4. JSON corruption + atomic permission
// ---------------------------------------------------------------------------
describe("safety: JSON corrupt + atomic perms", () => {
  it("muse corrupt JSON throws, bytes unchanged, snapshot marks corrupted", () => {
    const { createHostSettingsManager } = require(path.join(REPO, "src/hub-host-settings.cjs"));
    const home = makeTmp("home-muse-corrupt");
    const musePath = path.join(home, ".config", "muse", "settings.json");
    fs.mkdirSync(path.dirname(musePath), { recursive: true });
    fs.writeFileSync(musePath, "{ bad json", "utf8");
    fs.chmodSync(musePath, 0o600);
    const before = fs.readFileSync(musePath);
    const mgr = createHostSettingsManager({ homeDir: home });
    assert.throws(() => mgr.updateHostSetting({ host: "muse", key: "model", value: "x" }), Error);
    assert.ok(before.equals(fs.readFileSync(musePath)), "muse bytes unchanged");
    assert.equal(modeOf(musePath), 0o600);
    const snap = mgr.getSettingsSnapshot();
    assert.equal(snap.muse.corrupted, true, "muse snapshot must mark corrupted");
    assert.ok(snap.muse.error && String(snap.muse.error).length > 0, "muse error present");
  });

  it("pi corrupt JSON + array root throws, bytes unchanged", () => {
    const { createHostSettingsManager } = require(path.join(REPO, "src/hub-host-settings.cjs"));
    const home = makeTmp("home-pi-corrupt");
    const piPath = path.join(home, ".pi", "agent", "settings.json");
    fs.mkdirSync(path.dirname(piPath), { recursive: true });
    fs.writeFileSync(piPath, "{ bad json", "utf8");
    const before = fs.readFileSync(piPath);
    let mgr = createHostSettingsManager({ homeDir: home });
    assert.throws(() => mgr.updateHostSetting({ host: "pi", key: "model", value: "x" }), Error);
    assert.ok(before.equals(fs.readFileSync(piPath)));
    // Array root is valid JSON but not plain object -> must also throw
    fs.writeFileSync(piPath, JSON.stringify([1, 2, 3]), "utf8");
    const before2 = fs.readFileSync(piPath);
    mgr = createHostSettingsManager({ homeDir: home });
    assert.throws(() => mgr.updateHostSetting({ host: "pi", key: "model", value: "x" }), Error);
    assert.ok(before2.equals(fs.readFileSync(piPath)), "array root bytes unchanged");
    // null root
    fs.writeFileSync(piPath, "null", "utf8");
    const before3 = fs.readFileSync(piPath);
    mgr = createHostSettingsManager({ homeDir: home });
    assert.throws(() => mgr.updateHostSetting({ host: "pi", key: "model", value: "x" }), Error);
    assert.ok(before3.equals(fs.readFileSync(piPath)));
  });

  it("ENOENT new muse/pi files are created with 0600", () => {
    const { createHostSettingsManager } = require(path.join(REPO, "src/hub-host-settings.cjs"));
    const home = makeTmp("home-enoent");
    // No muse/pi files yet; ensure parent dirs missing to test mkdir+0600
    const mgr = createHostSettingsManager({ homeDir: home });
    mgr.updateHostSetting({ host: "muse", key: "model", value: "muse-ember-1.0" });
    const musePath = path.join(home, ".config", "muse", "settings.json");
    assert.ok(fs.existsSync(musePath));
    assert.equal(modeOf(musePath), 0o600, "new muse settings 0600");
    mgr.updateHostSetting({ host: "pi", key: "model", value: "magpie/group/code" });
    const piPath = path.join(home, ".pi", "agent", "settings.json");
    assert.ok(fs.existsSync(piPath));
    assert.equal(modeOf(piPath), 0o600, "new pi settings 0600");
    // Codex new toml also 0600
    const home2 = makeTmp("home-enoent-codex");
    fs.mkdirSync(path.join(home2, ".codex"), { recursive: true });
    const mgr2 = createHostSettingsManager({ homeDir: home2 });
    mgr2.updateHostSetting({ host: "codex", key: "model", value: "gpt-6.1-sol" });
    const codexPath = path.join(home2, ".codex", "config.toml");
    assert.equal(modeOf(codexPath), 0o600, "new codex toml 0600");
  });

  it("existing 0600 muse/pi/codex preserved after update (not widened to 0644)", () => {
    const { createHostSettingsManager } = require(path.join(REPO, "src/hub-host-settings.cjs"));
    const home = makeTmp("home-perm-preserve");
    const musePath = path.join(home, ".config", "muse", "settings.json");
    const piPath = path.join(home, ".pi", "agent", "settings.json");
    const codexPath = path.join(home, ".codex", "config.toml");
    fs.mkdirSync(path.dirname(musePath), { recursive: true });
    fs.mkdirSync(path.dirname(piPath), { recursive: true });
    fs.mkdirSync(path.dirname(codexPath), { recursive: true });
    fs.writeFileSync(musePath, JSON.stringify({ model: "a" }, null, 2), "utf8");
    fs.chmodSync(musePath, 0o600);
    fs.writeFileSync(piPath, JSON.stringify({ model: "a" }, null, 2), "utf8");
    fs.chmodSync(piPath, 0o600);
    fs.writeFileSync(codexPath, 'model = "a"\n', "utf8");
    fs.chmodSync(codexPath, 0o600);
    const mgr = createHostSettingsManager({ homeDir: home });
    mgr.updateHostSetting({ host: "muse", key: "model", value: "b" });
    mgr.updateHostSetting({ host: "pi", key: "model", value: "b" });
    mgr.updateHostSetting({ host: "codex", key: "model", value: "b" });
    assert.equal(modeOf(musePath), 0o600, "muse perms preserved");
    assert.equal(modeOf(piPath), 0o600, "pi perms preserved");
    assert.equal(modeOf(codexPath), 0o600, "codex perms preserved");
  });

  it("existing 0644 preserved (inheritance, not forced 0600)", () => {
    const { createHostSettingsManager } = require(path.join(REPO, "src/hub-host-settings.cjs"));
    const home = makeTmp("home-perm-644");
    const musePath = path.join(home, ".config", "muse", "settings.json");
    fs.mkdirSync(path.dirname(musePath), { recursive: true });
    fs.writeFileSync(musePath, JSON.stringify({ model: "a" }, null, 2), "utf8");
    fs.chmodSync(musePath, 0o644);
    const mgr = createHostSettingsManager({ homeDir: home });
    mgr.updateHostSetting({ host: "muse", key: "model", value: "b" });
    assert.equal(modeOf(musePath), 0o644, "existing 0644 inherited");
  });
});

// ---------------------------------------------------------------------------
// 5. MCP router concurrency
// ---------------------------------------------------------------------------
describe("safety: MCP router init concurrency", () => {
  const ROUTER_BIN = path.join(REPO, "bin", "t3-mcp-router");

  function writeStrictMock(file) {
    const code = `
"use strict";
let initialized = false;
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const id = msg.id;
    const method = msg.method || "";
    if (method === "initialize") {
      const ver = (msg.params && msg.params.protocolVersion) || "2024-11-05";
      // Delay initialize response to expose race: buggy second request will send tools/list before this returns.
      setTimeout(() => {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: { protocolVersion: ver, capabilities: {}, serverInfo: { name: "strict-mock", version: "1.0.0" } } }) + "\\n");
      }, 250);
    } else if (method === "notifications/initialized") {
      initialized = true;
    } else if (method === "tools/list" || method === "tools/call") {
      if (!initialized) {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32002, message: "server not initialized" } }) + "\\n");
      } else if (method === "tools/list") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: { tools: [{ name: "mock_tool", description: "mock", inputSchema: { type: "object", properties: {} } }] } }) + "\\n");
      } else {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "ok" }] } }) + "\\n");
      }
    } else if (method === "ping") {
      if (id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: {} }) + "\\n");
    }
  }
});
process.stdin.on("end", () => {});
`;
    fs.writeFileSync(file, code, "utf8");
  }

  function startRouter(homeDir, hubDir, projDir) {
    const env = { ...process.env, HOME: homeDir, T3_HUB_DIR: hubDir };
    const proc = spawn(process.execPath, [ROUTER_BIN], { env, stdio: ["pipe", "pipe", "pipe"], cwd: projDir });
    let buffer = "";
    let nextId = 1;
    const pending = new Map();
    proc.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg && msg.id !== undefined && pending.has(msg.id)) {
          const p = pending.get(msg.id);
          pending.delete(msg.id);
          p(msg);
        }
      }
    });
    proc.stderr.on("data", () => {});
    proc.on("error", () => {});
    function rpc(method, params, timeoutMs = 15000) {
      const id = nextId++;
      const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params: params || {} }) + "\n";
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error("rpc timeout " + method)); }, timeoutMs);
        pending.set(id, (v) => { clearTimeout(timer); resolve(v); });
        proc.stdin.write(payload);
      });
    }
    function callTool(name, args) {
      return rpc("tools/call", { name, arguments: args || {} }, 15000);
    }
    function kill() {
      try { proc.stdin.end(); } catch {}
      try { proc.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 500).unref?.();
    }
    return { proc, rpc, callTool, kill };
  }

  it("concurrent hub_list/hub_call all succeed against strict mock", async () => {
    const tmp = makeTmp("router-concurrent");
    const homeDir = path.join(tmp, "home");
    const hubDir = path.join(tmp, "hub");
    const projDir = path.join(tmp, "proj");
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(hubDir, { recursive: true });
    fs.mkdirSync(path.join(projDir, ".git"), { recursive: true });
    const mockPath = path.join(tmp, "strict-mock.cjs");
    writeStrictMock(mockPath);
    fs.writeFileSync(path.join(hubDir, "state.json"), JSON.stringify({ mcpModes: { global: { "strict-mock": "global-lazy" }, projects: {} } }), "utf8");
    fs.writeFileSync(path.join(hubDir, "mcp-registry.json"), JSON.stringify([{ name: "strict-mock", command: process.execPath, args: [mockPath] }]), "utf8");
    const router = startRouter(homeDir, hubDir, projDir);
    try {
      const init = await router.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } });
      assert.ok(init.result && init.result.serverInfo && init.result.serverInfo.name === "t3-mcp-router");
      router.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      // 5 concurrent requests against same lazy server: mix of list and call
      const calls = [
        router.callTool("hub_list_mcp_tools", { server: "strict-mock" }),
        router.callTool("hub_list_mcp_tools", { server: "strict-mock" }),
        router.callTool("hub_call_mcp_tool", { server: "strict-mock", tool: "mock_tool", arguments: {} }),
        router.callTool("hub_list_mcp_tools", { server: "strict-mock" }),
        router.callTool("hub_call_mcp_tool", { server: "strict-mock", tool: "mock_tool", arguments: {} }),
      ];
      const results = await Promise.all(calls);
      const expectList = [true, true, false, true, false];
      for (const [i, res] of results.entries()) {
        assert.ok(res.result, "call " + i + " must succeed, got " + JSON.stringify(res).slice(0, 600));
        const innerText = res.result.content && res.result.content[0] && res.result.content[0].text;
        assert.ok(typeof innerText === "string", "content text call " + i);
        if (expectList[i]) {
          const payload = JSON.parse(innerText);
          assert.ok(Array.isArray(payload.tools) && payload.tools.length >= 1, "tools present call " + i + ": " + innerText.slice(0, 400));
          assert.ok(!payload.error, "no error field call " + i);
          assert.ok(payload.tools.some((t) => t.name === "mock_tool"), "mock_tool listed call " + i);
        } else {
          // hub_call returns upstream tools/call result directly: content[0].text === "ok"
          assert.equal(innerText, "ok", "call tool ok call " + i + ": " + innerText);
        }
      }
    } finally {
      router.kill();
      setTimeout(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }, 300);
    }
  });

  it("real upstream closes stdin immediately after initialize without crashing the router", async () => {
    const tmp = makeTmp("router-epipe");
    const home = path.join(tmp, "home"), hub = path.join(tmp, "hub"), project = path.join(tmp, "project");
    for (const dir of [home, hub, project]) fs.mkdirSync(dir, { recursive: true });
    const mock = path.join(tmp, "crash.cjs");
    fs.writeFileSync(mock, `
      const readline = require("node:readline");
      readline.createInterface({input: process.stdin}).on("line", line => {
        const msg = JSON.parse(line);
        if (msg.method !== "initialize") return;
        process.stdin.destroy();
        process.stdout.write(JSON.stringify({jsonrpc: "2.0", id: msg.id, result: {}}) + "\\n", () => process.exit(0));
      });
    `);
    fs.writeFileSync(path.join(hub, "state.json"), JSON.stringify({ mcpModes: { global: { crash: "global-lazy" }, projects: {} } }));
    fs.writeFileSync(path.join(hub, "mcp-registry.json"), JSON.stringify([{ name: "crash", command: process.execPath, args: [mock] }]));
    const router = startRouter(home, hub, project);
    try {
      await router.rpc("initialize", {});
      for (let i = 0; i < 3; i++) {
        const result = await router.callTool("hub_list_mcp_tools", { server: "crash" });
        assert.ok(result.result || result.error, "failed upstream still returns a JSON-RPC response");
        const ping = await router.rpc("ping", {}, 3000);
        assert.ok(ping.result, "router remains responsive after broken pipe");
        assert.equal(router.proc.exitCode, null);
      }
    } finally {
      router.kill();
      setTimeout(() => fs.rmSync(tmp, { recursive: true, force: true }), 300).unref();
    }
  });

  it("router source uses initPromise serialization and sets initialized only after notifications", () => {
    const src = fs.readFileSync(ROUTER_BIN, "utf8");
    assert.ok(src.includes("initPromise"), "initPromise present");
    // Must await initPromise
    assert.ok(/await\s+entry\.initPromise/.test(src) || /await entry\.initPromise/.test(src), "awaits shared initPromise");
    // initialized only after notifications/initialized write; buggy pattern 'entry.initialized = true' before await must be gone
    // Check that ensureInitialized does not set initialized before initialize await.
    const fnIdx = src.indexOf("async function ensureInitialized");
    assert.ok(fnIdx !== -1, "ensureInitialized exists");
    const snippet = src.slice(fnIdx, fnIdx + 1500);
    const initTrueIdx = snippet.indexOf("initialized = true");
    const awaitInitIdx = snippet.indexOf("await");
    assert.ok(initTrueIdx > awaitInitIdx, "initialized set after await, snippet: " + snippet.slice(0, 500));
    // On error must reset both
    assert.ok(snippet.includes("initPromise = null"), "initPromise reset on error");
    assert.ok(snippet.includes("initialized = false"), "initialized reset on error");
  });
});

// Deterministic child/pipe fault injection: exercise the actual router functions,
// replacing only spawn so event ordering never depends on the OS scheduler.
describe("safety: MCP pool lifecycle and stdin failures", () => {
  function harness(t) {
    const file = path.join(REPO, "bin/t3-mcp-router");
    const localRequire = createRequire(file);
    const children = [];
    const module = { exports: {} };
    const sandbox = { module, __dirname: path.dirname(file), process, Buffer, setTimeout, clearTimeout, console,
      require(id) {
        if (id.includes("memory-vault")) return null;
        if (id !== "node:child_process") return localRequire(id);
        return { spawn() {
          const child = new EventEmitter();
          child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
          child.killed = false; child.exitCode = null;
          child.stdin.destroyed = false; child.stdin.writable = true;
          child.kill = () => { child.killed = true; return true; };
          child.stdin.write = (line, callback) => {
            const msg = JSON.parse(line);
            if (child.onWrite) return child.onWrite(msg, callback);
            queueMicrotask(() => {
              if (callback) callback(null);
              if (msg.id !== undefined) child.stdout.emit("data", Buffer.from(JSON.stringify({ id: msg.id, result: {} }) + "\n"));
            });
            return true;
          };
          children.push(child); return child;
        } };
      },
    };
    vm.runInNewContext(fs.readFileSync(file, "utf8") + "\nmodule.exports.testEnsureInitialized = ensureInitialized;", sandbox, { filename: file });
    const api = module.exports;
    t.after(() => { for (const key of [...api.stdioPool.keys()]) api.killPoolEntry(key); });
    return { api, children, def: { name: "mock", command: "mock", args: [] } };
  }
  const tick = () => new Promise(resolve => setImmediate(resolve));

  for (const event of ["exit", "close", "error", "stdin error", "overflow"]) it(`old ${event} cannot evict its replacement`, async t => {
    const { api, def, children } = harness(t);
    const old = api.spawnStdioUpstream(def);
    api.killPoolEntry(old.key);
    const current = api.spawnStdioUpstream(def);
    if (event === "overflow") old.proc.stdout.emit("data", Buffer.alloc(api.MAX_BUFFER_BYTES + 1, 65));
    else if (event === "stdin error") old.proc.stdin.emit("error", new Error("EPIPE"));
    else old.proc.emit(event, event === "error" ? new Error("late spawn error") : 0);
    assert.equal(api.stdioPool.get(current.key), current);
    assert.equal(api.spawnStdioUpstream(def), current);
    assert.equal(children.length, 2);
  });

  it("waits for notification write callback before marking initialized", async t => {
    const { api, def } = harness(t);
    const entry = api.spawnStdioUpstream(def);
    let notifyCallback;
    entry.proc.onWrite = (msg, cb) => {
      if (msg.method === "initialize") queueMicrotask(() => { cb?.(null); entry.proc.stdout.emit("data", Buffer.from(JSON.stringify({id: msg.id, result: {}}) + "\n")); });
      else notifyCallback = cb;
      return true;
    };
    let settled = false;
    const p = api.testEnsureInitialized(entry).finally(() => { settled = true; });
    await tick();
    try {
      assert.equal(settled, false);
      assert.equal(entry.initialized, false);
    } finally { notifyCallback?.(null); await p; }
    assert.equal(entry.initialized, true);
  });

  for (const fault of ["EPIPE", "ERR_STREAM_DESTROYED", "exit before callback", "close without callback", "callback after exit", "destroyed stdin"]) it(`initialization fails safely on ${fault}`, async t => {
    const { api, def } = harness(t);
    const entry = api.spawnStdioUpstream(def);
    entry.proc.onWrite = (msg, cb) => {
      if (msg.method === "initialize") queueMicrotask(() => {
        cb?.(null);
        if (fault === "destroyed stdin") entry.proc.stdin.destroyed = true;
        entry.proc.stdout.emit("data", Buffer.from(JSON.stringify({ id: msg.id, result: {} }) + "\n"));
      });
      else queueMicrotask(() => {
        if (fault.includes("exit") || fault.includes("close")) {
          entry.proc.exitCode = 0;
          entry.proc.emit(fault.includes("close") ? "close" : "exit", 0);
          if (fault === "callback after exit") cb?.(null);
        } else {
          const err = Object.assign(new Error(fault), { code: fault });
          entry.proc.stdin.emit("error", err);
          cb?.(err);
        }
      });
      return true;
    };
    await assert.rejects(api.testEnsureInitialized(entry), /upstream|EPIPE|ERR_STREAM_DESTROYED/i);
    assert.equal(entry.initialized, false);
    assert.equal(entry.initPromise, null);
    assert.equal(entry.waiters.size, 0);
  });

  it("rejects request writes and drains waiters on stdin failure", { timeout: 3000 }, async t => {
    const { api, def } = harness(t);
    const entry = api.spawnStdioUpstream(def);
    entry.proc.onWrite = (_msg, cb) => queueMicrotask(() => {
      const err = new Error("EPIPE"); entry.proc.stdin.emit("error", err); cb?.(err);
    });
    await assert.rejects(api.sendToStdio(entry, "tools/list", {}), /EPIPE/i);
    assert.equal(entry.waiters.size, 0);
    assert.equal(api.stdioPool.has(entry.key), false);
  });
});
