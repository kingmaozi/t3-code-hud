"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const { createTaskBoard, normalizeStepStatus, parseTaskMd, planFileKey } = require("../src/hub-task-board.cjs");
const { createHostSettingsManager, parseTomlTopLevel, CODEX_EDITABLE_KEYS, MUSE_KEYS, PI_KEYS } = require("../src/hub-host-settings.cjs");

function makeTmp(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `t3-v3-${label}-`));
}
function writeFile(dir, name, content) {
  const full = path.join(dir, name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
  return full;
}
function dbStat(file) {
  const st = fs.statSync(file);
  return { size: st.size, mtimeMs: st.mtimeMs };
}

// 构造与真实 statev2.sqlite 子集一致的最小库
function buildT3Db(dir, setup) {
  const file = path.join(dir, "statev2.sqlite");
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE orchestration_v2_projection_threads (
      thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
      default_provider TEXT NOT NULL DEFAULT 'codex', runtime_mode TEXT NOT NULL DEFAULT 'full-access',
      interaction_mode TEXT NOT NULL DEFAULT 'default', active_provider_thread_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT, deleted_at TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE orchestration_v2_projection_plans (
      plan_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, run_id TEXT,
      node_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL
    );
    CREATE TABLE orchestration_v2_projection_subagents (
      subagent_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, run_id TEXT, parent_node_id TEXT NOT NULL,
      provider TEXT NOT NULL, provider_thread_id TEXT, child_thread_id TEXT, origin TEXT NOT NULL,
      status TEXT NOT NULL, started_at TEXT, completed_at TEXT, updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL, driver TEXT, provider_instance_id TEXT
    );
    CREATE TABLE projection_projects (
      project_id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace_root TEXT NOT NULL,
      scripts_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
    );
  `);
  setup(db);
  db.close();
  return file;
}

function insertThread(db, { threadId, title, updatedAt, payload = {} }) {
  db.prepare(
    "INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, created_at, updated_at, payload_json) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(threadId, "proj-1", title, "2026-11-15T00:00:00.000Z", updatedAt, JSON.stringify(payload));
}
function insertPlan(db, { planId, threadId, steps, explanation, updatedAt }) {
  const payload = { id: planId, threadId, steps, explanation, updatedAt };
  db.prepare(
    "INSERT INTO orchestration_v2_projection_plans (plan_id, thread_id, node_id, kind, status, payload_json) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(planId, threadId, "node:root", "todo_list", "active", JSON.stringify(payload));
}
function insertSubagent(db, { subId, parentThread, status, provider, child, title, model, startedAt, completedAt, updatedAt }) {
  const payload = { id: subId, threadId: parentThread, childThreadId: child, title, model, providerInstanceId: provider, startedAt, updatedAt };
  db.prepare(
    `INSERT INTO orchestration_v2_projection_subagents
      (subagent_id, thread_id, parent_node_id, provider, child_thread_id, origin, status, started_at, completed_at, updated_at, payload_json, driver, provider_instance_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(subId, parentThread, "node:parent", provider, child, "app_owned", status, startedAt, completedAt, updatedAt, JSON.stringify(payload), provider, provider);
}

const BOARD_FIVE = [
  { id: "step-1", text: "核实现役版本", status: "completed" },
  { id: "step-2", text: "补齐接入缺口", status: "completed" },
  { id: "step-3", text: "完成守护验收", status: "completed" },
  { id: "step-4", text: "双店真实商品学习", status: "completed" },
  { id: "step-5", text: "等待额度恢复续办", status: "running" },
];

describe("hub-task-board: T3 原生计划与子代理实况", () => {
  it("解析 5 步计划得到 4/5 进度，且只读不修改数据库", () => {
    const dir = makeTmp("board-t3");
    const dbPath = buildT3Db(dir, (db) => {
      db.exec("INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES ('proj-1','p1','/tmp/proj','{}','2026-11-15T00:00:00Z','2026-11-15T00:00:00Z')");
      insertThread(db, { threadId: "thread-main", title: "主线程", updatedAt: "2026-11-15T09:00:00.000Z" });
      insertPlan(db, { planId: "plan-1", threadId: "thread-main", steps: BOARD_FIVE, explanation: "背景", updatedAt: "2026-11-15T08:00:00.000Z" });
      insertSubagent(db, { subId: "sub-1", parentThread: "thread-main", status: "completed", provider: "muse", child: "child-1", title: "审查员", model: "muse-ember-1.0", startedAt: "2026-11-15T07:00:00.000Z", completedAt: "2026-11-15T07:10:00.000Z", updatedAt: "2026-11-15T07:10:00.000Z" });
      insertSubagent(db, { subId: "sub-2", parentThread: "thread-main", status: "running", provider: "codex", child: "child-2", title: "执行员", model: "gpt-6.1-sol", startedAt: "2026-11-15T07:30:00.000Z", completedAt: null, updatedAt: "2026-11-15T08:30:00.000Z" });
    });
    const before = dbStat(dbPath);
    const board = createTaskBoard({ t3DbPath: dbPath, agyBrainDirs: [], hubPlansDir: path.join(dir, "plans"), now: () => Date.parse("2026-11-15T09:00:00.000Z") });
    const snap = board.getBoardSnapshot({ threadId: "thread-main" });
    assert.equal(snap.source, "t3-native");
    assert.deepEqual(snap.progress, { completed: 4, inProgress: 1, pending: 0, total: 5, label: "4/5", percent: 80 });
    assert.equal(snap.background, "背景");
    assert.equal(snap.subagents.length, 2);
    const done = snap.subagents.find((s) => s.threadId === "child-1");
    const running = snap.subagents.find((s) => s.threadId === "child-2");
    assert.equal(done.status, "completed");
    assert.equal(done.elapsedSec, 600);
    assert.equal(running.status, "in_progress");
    assert.equal(running.elapsedSec, 3600);
    const after = dbStat(dbPath);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
  });

  it("未传 threadId 时自动选择最近活跃线程", () => {
    const dir = makeTmp("board-auto");
    const dbPath = buildT3Db(dir, (db) => {
      insertThread(db, { threadId: "thread-old", title: "旧", updatedAt: "2026-11-14T00:00:00.000Z" });
      insertThread(db, { threadId: "thread-new", title: "新", updatedAt: "2026-11-15T10:00:00.000Z" });
      insertPlan(db, { planId: "p1", threadId: "thread-new", steps: [{ id: "s1", text: "新任务", status: "pending" }], explanation: "新背景", updatedAt: "2026-11-15T10:00:00.000Z" });
    });
    const board = createTaskBoard({ t3DbPath: dbPath, agyBrainDirs: [], hubPlansDir: path.join(dir, "plans") });
    const snap = board.getBoardSnapshot({});
    assert.equal(snap.threadId, "thread-new");
    assert.equal(snap.steps[0].text, "新任务");
  });

  it("无计划时基于子代理状态自动推断 2/3 进度", () => {
    const dir = makeTmp("board-infer");
    const dbPath = buildT3Db(dir, (db) => {
      insertThread(db, { threadId: "thread-parent", title: "父线程", updatedAt: "2026-11-15T09:00:00.000Z" });
      insertSubagent(db, { subId: "sa", parentThread: "thread-parent", status: "completed", provider: "muse", child: "c1", title: "任务甲", model: "m", startedAt: "2026-11-15T07:00:00Z", completedAt: "2026-11-15T07:05:00Z", updatedAt: "2026-11-15T07:05:00Z" });
      insertSubagent(db, { subId: "sb", parentThread: "thread-parent", status: "completed", provider: "codex", child: "c2", title: "任务乙", model: "m", startedAt: "2026-11-15T07:00:00Z", completedAt: "2026-11-15T07:06:00Z", updatedAt: "2026-11-15T07:06:00Z" });
      insertSubagent(db, { subId: "sc", parentThread: "thread-parent", status: "running", provider: "muse", child: "c3", title: "任务丙", model: "m", startedAt: "2026-11-15T07:00:00Z", completedAt: null, updatedAt: "2026-11-15T07:30:00Z" });
    });
    const board = createTaskBoard({ t3DbPath: dbPath, agyBrainDirs: [], hubPlansDir: path.join(dir, "plans"), now: () => Date.parse("2026-11-15T09:00:00Z") });
    const snap = board.getBoardSnapshot({ threadId: "thread-parent" });
    assert.equal(snap.source, "subagents-inferred");
    assert.deepEqual(snap.progress, { completed: 2, inProgress: 1, pending: 0, total: 3, label: "2/3", percent: 67 });
    assert.equal(snap.steps.length, 3);
  });
});

describe("hub-task-board: AGY brain 解析与产物", () => {
  const TASK_MD = [
    "# Making 总控进度看板",
    "",
    "- [x] 基线独立审查已闭环",
    "- [/] Track B 进行中收尾审查",
    "- [~] 守护运行状态核验",
    "- [ ] 主仓合流升级 v0.5.0",
    "- [ ] 低峰受管切流上线",
    "- [ ] 标题含进行中应判为进行中",
  ].join("\n") + "\n";

  function brainDir() {
    const dir = makeTmp("brain");
    const root = path.join(dir, "brain");
    const session = path.join(root, "sess-1");
    fs.mkdirSync(session, { recursive: true });
    fs.writeFileSync(path.join(session, "task.md"), TASK_MD, "utf8");
    fs.writeFileSync(path.join(session, "implementation_plan.md"), "# 实施方案\n", "utf8");
    fs.writeFileSync(
      path.join(session, "implementation_plan.md.metadata.json"),
      JSON.stringify({ summary: "实施方案已同步", updatedAt: "2026-11-15T08:00:00.000Z", userFacing: true }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(session, "secret.md.metadata.json"),
      JSON.stringify({ summary: "内部", userFacing: false }),
      "utf8"
    );
    return { dir, root, session };
  }

  it("解析 completed / in_progress / pending 步骤", () => {
    const { root } = brainDir();
    const dir = makeTmp("board-agy");
    const dbPath = buildT3Db(dir, (db) => {
      db.prepare("INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (?,?,?,?,?,?)").run("proj-1", "p", dir, "{}", "2026-11-15T00:00:00Z", "2026-11-15T00:00:00Z");
      insertThread(db, { threadId: "sess-1", title: "session", updatedAt: "2026-11-15T09:00:00Z" });
    });
    const board = createTaskBoard({ t3DbPath: dbPath, agyBrainDirs: [root], hubPlansDir: path.join(dir, "plans") });
    const snap = board.getBoardSnapshot({ threadId: "sess-1", projectRoot: dir });
    assert.equal(snap.source, "agy-brain");
    assert.deepEqual(snap.progress, { completed: 1, inProgress: 3, pending: 2, total: 6, label: "1/6", percent: 17 });
    assert.equal(snap.background, "Making 总控进度看板");
  });

  it("收集 userFacing: true 产物并过滤内部产物", () => {
    const { root } = brainDir();
    const dir = makeTmp("board-agy2");
    const dbPath = buildT3Db(dir, (db) => {
      db.prepare("INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (?,?,?,?,?,?)").run("proj-1", "p", dir, "{}", "2026-11-15T00:00:00Z", "2026-11-15T00:00:00Z");
      insertThread(db, { threadId: "sess-1", title: "session", updatedAt: "2026-11-15T09:00:00Z" });
    });
    const board = createTaskBoard({ t3DbPath: dbPath, agyBrainDirs: [root], hubPlansDir: path.join(dir, "plans") });
    const snap = board.getBoardSnapshot({ threadId: "sess-1", projectRoot: dir });
    const names = snap.artifacts.map((a) => a.name);
    assert.ok(names.includes("implementation_plan.md"));
    assert.ok(names.includes("task.md"));
    assert.ok(!names.some((n) => n.includes("secret")));
    const plan = snap.artifacts.find((a) => a.name === "implementation_plan.md");
    assert.equal(plan.summary, "实施方案已同步");
    assert.equal(plan.updatedAt, "2026-11-15T08:00:00.000Z");
  });

  it("parseTaskMd 单元行为", () => {
    const steps = parseTaskMd(TASK_MD);
    assert.equal(steps.length, 6);
    assert.equal(steps[0].status, "completed");
    assert.equal(steps[1].status, "in_progress");
    assert.equal(steps[2].status, "in_progress");
    assert.equal(steps[3].status, "pending");
    assert.equal(steps[5].status, "in_progress");
    assert.equal(normalizeStepStatus("done"), "completed");
    assert.equal(normalizeStepStatus("✓"), "completed");
    assert.equal(normalizeStepStatus("running"), "in_progress");
    assert.equal(normalizeStepStatus("active"), "in_progress");
  });
});

describe("hub-task-board: Hub MCP 打卡（Pi 通用保底）", () => {
  it("updatePlan 归一化简写状态并可被快照读取", () => {
    const dir = makeTmp("plans");
    const hubPlansDir = path.join(dir, "task-plans");
    const board = createTaskBoard({ t3DbPath: path.join(dir, "missing.sqlite"), agyBrainDirs: [], hubPlansDir, now: () => Date.parse("2026-11-15T12:00:00.000Z") });
    const rec = board.updatePlan({
      threadId: "pi-thread",
      projectRoot: "/tmp/pi-proj",
      title: "Pi 计划",
      background: "Pi 背景",
      steps: [
        { text: "第一步", status: "done" },
        { text: "第二步", status: "✓" },
        { text: "第三步", status: "running" },
      ],
    });
    assert.equal(rec.steps[0].status, "completed");
    assert.equal(rec.steps[2].status, "in_progress");
    assert.equal(rec.updatedAt, "2026-11-15T12:00:00.000Z");
    const snap = board.getBoardSnapshot({ threadId: "pi-thread", projectRoot: "/tmp/pi-proj" });
    assert.equal(snap.source, "hub-mcp");
    assert.equal(snap.background, "Pi 背景");
    assert.deepEqual(snap.progress, { completed: 2, inProgress: 1, pending: 0, total: 3, label: "2/3", percent: 67 });
  });

  it("clearPlan 删除打卡且不影响其他线程", () => {
    const dir = makeTmp("plans-clear");
    const hubPlansDir = path.join(dir, "task-plans");
    const board = createTaskBoard({ t3DbPath: path.join(dir, "missing.sqlite"), agyBrainDirs: [], hubPlansDir });
    board.updatePlan({ threadId: "t-keep", steps: [{ text: "保留", status: "pending" }] });
    board.updatePlan({ threadId: "t-drop", steps: [{ text: "删除", status: "pending" }] });
    const res = board.clearPlan({ threadId: "t-drop" });
    assert.equal(res.deleted, 1);
    assert.equal(board.getBoardSnapshot({ threadId: "t-keep" }).steps.length, 1);
    assert.equal(board.getBoardSnapshot({ threadId: "t-drop" }).steps.length, 0);
    assert.throws(() => board.updatePlan({}), /threadId or projectRoot/);
  });

  it("按 updatedAt 取最新计划，同时保留 subagents 与 artifacts", () => {
    const dir = makeTmp("merge");
    const root = path.join(dir, "brain");
    const session = path.join(root, "sess-merge");
    fs.mkdirSync(session, { recursive: true });
    fs.writeFileSync(path.join(session, "task.md"), "# brain 标题\n\n- [ ] brain 旧步骤\n", "utf8");
    fs.writeFileSync(path.join(session, "implementation_plan.md.metadata.json"), JSON.stringify({ summary: "脑产物", userFacing: true, updatedAt: "2026-11-14T00:00:00.000Z" }), "utf8");
    const dbPath = buildT3Db(dir, (db) => {
      db.exec(`CREATE TABLE orchestration_v2_projection_provider_threads (thread_id TEXT, provider_session_id TEXT, payload_json TEXT)`);
      db.prepare("INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (?,?,?,?,?,?)").run("proj-1", "p", dir, "{}", "2026-11-15T00:00:00Z", "2026-11-15T00:00:00Z");
      insertThread(db, { threadId: "thread-m", title: "合并", updatedAt: "2026-11-15T00:00:00Z" });
      db.prepare("INSERT INTO orchestration_v2_projection_provider_threads (thread_id, provider_session_id, payload_json) VALUES (?,?,?)").run("thread-m", "sess-merge", JSON.stringify({ nativeThreadRef: { nativeId: "sess-merge" } }));
      insertSubagent(db, { subId: "s1", parentThread: "thread-m", status: "running", provider: "muse", child: "c1", title: "实况子代理", model: "m", startedAt: "2026-11-15T00:00:00Z", completedAt: null, updatedAt: "2026-11-15T00:30:00Z" });
    });
    const past = new Date("2020-01-01T00:00:00.000Z");
    fs.utimesSync(path.join(session, "task.md"), past, past);
    const board = createTaskBoard({
      t3DbPath: dbPath,
      agyBrainDirs: [root],
      hubPlansDir: path.join(dir, "plans"),
      now: () => Date.parse("2026-11-15T13:00:00.000Z"),
    });
    board.updatePlan({ threadId: "thread-m", projectRoot: dir, title: "Hub 新计划", background: "Hub 背景", steps: [{ text: "hub 新步骤", status: "pending" }] });
    const snap = board.getBoardSnapshot({ threadId: "thread-m", projectRoot: dir });
    assert.equal(snap.source, "hub-mcp");
    assert.equal(snap.steps[0].text, "hub 新步骤");
    assert.equal(snap.subagents.length, 1);
    assert.equal(snap.subagents[0].title, "实况子代理");
    assert.ok(snap.artifacts.some((a) => a.summary === "脑产物"));
  });
});

const CODEX_FIXTURE = [
  "# Codex 配置（注释必须保留）",
  'model = "gpt-6.1-sol"',
  'model_reasoning_effort = "medium"',
  'approval_policy = "on-request"',
  'sandbox_mode = "workspace-write"',
  "",
  "[mcp_servers.t3_hub]",
  'command = "/Users/longxiaking/.t3/bin/t3-mcp-router"',
  "args = []",
  "",
  '[projects."/Users/longxiaking/Documents/making"]',
  'trust_level = "trusted"',
  "",
].join("\n");

describe("hub-host-settings: Codex TOML 行级精准修改", () => {
  function codexMgr() {
    const home = makeTmp("home-settings");
    const codexDir = path.join(home, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    const codexPath = path.join(codexDir, "config.toml");
    fs.writeFileSync(codexPath, CODEX_FIXTURE, "utf8");
    fs.mkdirSync(path.join(home, ".config", "muse"), { recursive: true });
    fs.writeFileSync(path.join(home, ".config", "muse", "settings.json"), JSON.stringify({ model: "muse-ember-1.0", mcpServers: { t3_hub: { command: "x" } } }), "utf8");
    fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
    fs.writeFileSync(path.join(home, ".pi", "agent", "settings.json"), JSON.stringify({ defaultModel: "codex/gpt-6.1-sol", defaultProvider: "magpie" }), "utf8");
    const agy = path.join(home, ".gemini", "antigravity");
    fs.mkdirSync(path.join(agy, "rules"), { recursive: true });
    fs.writeFileSync(path.join(agy, "rules", "AGENTS.md"), "# AGY 全局规则\n\n- 保持中文回复\n", "utf8");
    const mgr = createHostSettingsManager({ homeDir: home });
    return { home, codexPath, mgr };
  }

  it("快照读取 Codex 顶层字段与 MCP 数", () => {
    const { mgr } = codexMgr();
    const snap = mgr.getSettingsSnapshot();
    assert.equal(snap.codex.model, "gpt-6.1-sol");
    assert.equal(snap.codex.model_reasoning_effort, "medium");
    assert.equal(snap.codex.approval_policy, "on-request");
    assert.equal(snap.codex.sandbox_mode, "workspace-write");
    assert.equal(snap.codex.mcpServerCount, 1);
    assert.equal(snap.muse.model, "muse-ember-1.0");
    assert.equal(snap.pi.defaultModel, "codex/gpt-6.1-sol");
    assert.equal(snap.antigravity.exists, true);
    assert.ok(snap.antigravity.chars > 0);
    assert.ok(snap.globalRules.codex.path.endsWith("AGENTS.md"));
  });

  it("所有可编辑宿主独立返回白名单原值，缺失键为 null 且保留概览兼容字段", () => {
    const { mgr, home } = codexMgr();
    fs.writeFileSync(path.join(home, ".config", "muse", "settings.json"), JSON.stringify({ defaultModel: " muse-default ", permissionMode: "ask", reasoningEffort: "max", effort: 0, defaultEffort: false, unrelated: "hidden" }));
    const snap = mgr.getSettingsSnapshot();
    assert.deepEqual(snap.codex.editableValues, { model: "gpt-6.1-sol", model_reasoning_effort: "medium", approval_policy: "on-request", sandbox_mode: "workspace-write" });
    assert.equal(snap.muse.model, " muse-default ");
    assert.deepEqual(snap.muse.editableValues, { model: null, defaultModel: " muse-default ", permissionMode: "ask", reasoningEffort: "max", effort: 0, defaultEffort: false });
    assert.deepEqual(snap.pi.editableValues, { defaultModel: "codex/gpt-6.1-sol", defaultProvider: "magpie", model: null, effort: null, reasoningEffort: null, thinkingLevel: null });
  });

  for (const [host, keys, relativePath] of [
    ["muse", MUSE_KEYS, ".config/muse/settings.json"],
    ["pi", PI_KEYS, ".pi/agent/settings.json"],
  ]) for (const value of ["", null]) it(`${host} 清空 ${JSON.stringify(value)} 会移除所有目标键并保留无关 JSON 与原始备份`, () => {
    const { mgr, home } = codexMgr();
    const file = path.join(home, relativePath);
    const original = { ...Object.fromEntries(keys.map((key) => [key, `old-${key}`])), preserved: { model: "nested" } };
    const before = JSON.stringify(original, null, 2) + "\n";
    fs.writeFileSync(file, before);
    for (const key of keys) mgr.updateHostSetting({ host, key, value });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { preserved: { model: "nested" } });
    assert.equal(fs.readFileSync(file + ".t3hub.bak", "utf8"), before);
    assert.deepEqual(mgr.getSettingsSnapshot()[host].editableValues, Object.fromEntries(keys.map((key) => [key, null])));
  });

  for (const value of ["", null]) it(`Codex 清空 ${JSON.stringify(value)} 仅移除顶层白名单值并保留注释、CRLF 与同名表内键`, () => {
    const { mgr, codexPath } = codexMgr();
    const before = [
      "# 保留注释",
      '"model" = """first',
      'second""" # 保留行尾注释',
      'model_reasoning_effort = "medium"',
      'approval_policy = "on-request"',
      'sandbox_mode = "workspace-write"',
      '[projects."/Users/longxiaking/Documents/making"]',
      'model = "project-model"',
      'approval_policy = "project-policy"',
      '[mcp_servers.keep]',
      'command = "keep"',
      "",
    ].join("\r\n");
    fs.writeFileSync(codexPath, before);
    for (const key of CODEX_EDITABLE_KEYS) mgr.updateHostSetting({ host: "codex", key, value });
    const disk = fs.readFileSync(codexPath, "utf8");
    assert.deepEqual(parseTomlTopLevel(disk), {});
    assert.equal(disk.slice(disk.indexOf('[projects.')), before.slice(before.indexOf('[projects.')));
    assert.match(disk, /^# 保留注释\r\n/);
    assert.match(disk, /# 保留行尾注释\r\n/);
    assert.doesNotMatch(disk, /(?<!\r)\n/);
    assert.equal(fs.readFileSync(codexPath + ".t3hub.bak", "utf8"), before);
    assert.equal(mgr.getSettingsSnapshot().codex.corrupted, false);
    assert.deepEqual(mgr.getSettingsSnapshot().codex.editableValues, Object.fromEntries(CODEX_EDITABLE_KEYS.map((key) => [key, null])));
  });

  it("修改顶层键后注释与表段 100% 原封不动且生成 .t3hub.bak", () => {
    const { mgr, codexPath } = codexMgr();
    mgr.updateHostSetting({ host: "codex", key: "model_reasoning_effort", value: "max" });
    mgr.updateHostSetting({ host: "codex", key: "approval_policy", value: "never" });
    const text = fs.readFileSync(codexPath, "utf8");
    const lines = text.split("\n");
    assert.ok(lines[0].includes("注释必须保留"));
    assert.ok(text.includes("[mcp_servers.t3_hub]"));
    assert.ok(text.includes("/Users/longxiaking/.t3/bin/t3-mcp-router"));
    assert.ok(text.includes('[projects."/Users/longxiaking/Documents/making"]'));
    assert.ok(text.includes('trust_level = "trusted"'));
    const parsed = parseTomlTopLevel(text);
    assert.equal(parsed.model_reasoning_effort, "max");
    assert.equal(parsed.approval_policy, "never");
    assert.equal(parsed.model, "gpt-6.1-sol");
    assert.equal(parsed.sandbox_mode, "workspace-write");
    const bak = fs.readFileSync(codexPath + ".t3hub.bak", "utf8");
    assert.equal(bak, CODEX_FIXTURE);
  });

  it("拒绝非白名单键与注入值", () => {
    const { mgr } = codexMgr();
    assert.throws(() => mgr.updateHostSetting({ host: "codex", key: "max_concurrent_threads", value: "8" }), /not editable/);
    assert.throws(() => mgr.updateHostSetting({ host: "codex", key: "model", value: "bad\ninjection" }), /unsafe/);
    assert.throws(() => mgr.updateHostSetting({ host: "codex", key: "model", value: 'a"b' }), /unsafe/);
    assert.throws(() => mgr.updateHostSetting({ host: "muse", key: "secretKey", value: "x" }), /not editable/);
    assert.throws(() => mgr.updateHostSetting({ host: "unknown", key: "model", value: "x" }), /unknown host/);
  });

  it("Muse / Pi JSON 仅更新白名单键并原子写回", () => {
    const { mgr, home } = codexMgr();
    mgr.updateHostSetting({ host: "muse", key: "model", value: "muse-spark-1.3" });
    mgr.updateHostSetting({ host: "pi", key: "defaultModel", value: "magpie/group/code" });
    const muse = JSON.parse(fs.readFileSync(path.join(home, ".config", "muse", "settings.json"), "utf8"));
    assert.equal(muse.model, "muse-spark-1.3");
    assert.ok(muse.mcpServers.t3_hub);
    const pi = JSON.parse(fs.readFileSync(path.join(home, ".pi", "agent", "settings.json"), "utf8"));
    assert.equal(pi.defaultModel, "magpie/group/code");
    assert.equal(pi.defaultProvider, "magpie");
    assert.ok(fs.existsSync(path.join(home, ".config", "muse", "settings.json.t3hub.bak")));
    assert.ok(fs.existsSync(path.join(home, ".pi", "agent", "settings.json.t3hub.bak")));
  });

  it("全局规则读写往返并自动备份", () => {
    const { mgr, home } = codexMgr();
    const before = mgr.getRuleContent("antigravity");
    assert.equal(before.exists, true);
    assert.ok(before.content.includes("保持中文回复"));
    const codexBefore = mgr.getRuleContent("codex");
    mgr.saveRuleContent("codex", "# new rules\n- 中文\n", codexBefore.content, codexBefore.targetPath);
    const after = mgr.getRuleContent("codex");
    assert.equal(after.content, "# new rules\n- 中文\n");
    assert.ok(fs.existsSync(path.join(home, ".codex", "AGENTS.md.t3hub.bak")) || after.exists);
    assert.throws(() => mgr.getRuleContent("bogus"), /unknown host/);
  });

  it("缺失键时插入到首个表段之前（顶层）", () => {
    const home = makeTmp("home-insert");
    const codexDir = path.join(home, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, "config.toml"), '# c\nmodel = "gpt-6.1-sol"\n\n[mcp_servers.t3_hub]\ncommand = "x"\n', "utf8");
    const mgr = createHostSettingsManager({ homeDir: home });
    mgr.updateHostSetting({ host: "codex", key: "approval_policy", value: "never" });
    const text = fs.readFileSync(path.join(codexDir, "config.toml"), "utf8");
    const parsed = parseTomlTopLevel(text);
    assert.equal(parsed.approval_policy, "never");
    const lines = text.split("\n");
    const keyIdx = lines.findIndex((l) => l.startsWith("approval_policy"));
    const secIdx = lines.findIndex((l) => l.startsWith("[mcp_servers"));
    assert.ok(keyIdx >= 0 && secIdx > keyIdx);
  });
});

describe("hub-host-settings: symlink preservation and unsafe path guards", () => {
  const cases = [
    ["codex", ".codex/config.toml", 'model = "before"\n', false],
    ["muse", ".config/muse/settings.json", '{"model":"before","keep":42}\n', false],
    ["pi", ".pi/agent/settings.json", '{"model":"before","keep":42}\n', false],
    ["codex", ".codex/AGENTS.md", "# before\n", true],
    ["muse", "AGENTS.md", "# before\n", true],
    ["pi", ".pi/AGENTS.md", "# before\n", true],
    ["antigravity", ".gemini/antigravity/rules/AGENTS.md", "# before\n", true],
  ];
  function setup(t, [host, relativePath, before, rule]) {
    const home = makeTmp("safe-settings");
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const file = path.join(home, relativePath), target = path.join(home, "dotfiles", relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const mgr = createHostSettingsManager({ homeDir: home });
    const save = () => { if (!rule) return mgr.updateHostSetting({ host, key: "model", value: "after" }); const before = mgr.getRuleContent(host); return mgr.saveRuleContent(host, "# after\n", before.content, before.targetPath); };
    return { home, file, target, mgr, save, before, rule, host };
  }
  function assertCorrupted(f, pattern) {
    const snapshot = f.mgr.getSettingsSnapshot();
    const entry = f.rule ? snapshot.globalRules[f.host] : snapshot[f.host];
    assert.equal(entry.corrupted, true);
    assert.match(entry.error, pattern);
    if (f.rule) assert.throws(() => f.mgr.getRuleContent(f.host), pattern);
  }

  for (const spec of cases) {
    const [host, relativePath] = spec;
    it(`${host} ${relativePath} updates the real file and preserves its symlink, mode and first backup`, (t) => {
      const f = setup(t, spec), mode = f.rule ? 0o604 : 0o640;
      fs.writeFileSync(f.target, f.before);
      fs.chmodSync(f.target, mode);
      const link = path.relative(path.dirname(f.file), f.target);
      fs.symlinkSync(link, f.file);
      f.save();
      f.save();
      assert.equal(fs.lstatSync(f.file).isSymbolicLink(), true);
      assert.equal(fs.readlinkSync(f.file), link);
      assert.equal(fs.realpathSync(f.file), fs.realpathSync(f.target));
      const after = fs.readFileSync(f.target, "utf8");
      assert.equal(f.rule ? after : host === "codex" ? parseTomlTopLevel(after).model : JSON.parse(after).model, f.rule ? "# after\n" : "after");
      if (!f.rule && host !== "codex") assert.equal(JSON.parse(after).keep, 42);
      assert.equal(fs.statSync(f.target).mode & 0o777, mode);
      const bak = f.file + ".t3hub.bak";
      assert.equal(fs.lstatSync(bak).isFile(), true);
      assert.equal(fs.readFileSync(bak, "utf8"), f.before);
      assert.equal(fs.statSync(bak).mode & 0o777, f.rule ? mode : 0o600);
      assert.equal(fs.readdirSync(path.dirname(f.target)).some((name) => name.includes(".tmp-")), false);
    });

    it(`${host} ${relativePath} rejects dangling symlinks before backup or write and reports a corrupt snapshot`, (t) => {
      const f = setup(t, spec), link = path.relative(path.dirname(f.file), f.target);
      fs.symlinkSync(link, f.file);
      const entries = fs.readdirSync(path.dirname(f.file));
      assert.throws(f.save, /dangling symlink/i);
      assertCorrupted(f, /dangling symlink/i);
      assert.equal(fs.lstatSync(f.file).isSymbolicLink(), true);
      assert.equal(fs.readlinkSync(f.file), link);
      assert.equal(fs.existsSync(f.target), false);
      assert.deepEqual(fs.readdirSync(path.dirname(f.file)), entries);
    });
  }

  for (const spec of cases.slice(0, 4)) for (const kind of ["symlink", "dangling symlink", "directory", "FIFO"]) {
    it(`${spec[1]} refuses an unsafe ${kind} backup path without changing either destination`, (t) => {
      const f = setup(t, spec), bak = f.file + ".t3hub.bak";
      fs.writeFileSync(f.file, f.before);
      fs.chmodSync(f.file, 0o640);
      if (kind === "directory") fs.mkdirSync(bak);
      else if (kind === "FIFO") require("node:child_process").execFileSync("mkfifo", [bak]);
      else {
        if (kind === "symlink") fs.writeFileSync(f.target, "backup target must stay unchanged");
        fs.symlinkSync(f.target, bak);
      }
      const entries = fs.readdirSync(path.dirname(f.file));
      assert.throws(f.save, /unsafe backup path/i);
      assert.equal(fs.readFileSync(f.file, "utf8"), f.before);
      assert.equal(fs.statSync(f.file).mode & 0o777, 0o640);
      assert.equal(fs.lstatSync(bak).isDirectory(), kind === "directory");
      if (kind === "symlink") assert.equal(fs.readFileSync(f.target, "utf8"), "backup target must stay unchanged");
      if (kind === "dangling symlink") assert.equal(fs.existsSync(f.target), false);
      assert.deepEqual(fs.readdirSync(path.dirname(f.file)), entries);
    });
  }

  for (const kind of ["regular file", "symlink"]) it(`an exclusive-backup collision accepts only a ${kind === "regular file" ? "regular file" : "regular file, not a symlink"}`, (t) => {
    const f = setup(t, cases[0]), bak = f.file + ".t3hub.bak", copy = fs.copyFileSync;
    fs.writeFileSync(f.file, f.before);
    fs.writeFileSync(f.target, "keep backup target");
    fs.copyFileSync = (source, destination, flags) => {
      if (destination === bak) {
        if (kind === "symlink") fs.symlinkSync(f.target, bak);
        else fs.writeFileSync(bak, "keep racing backup");
      }
      return copy(source, destination, flags);
    };
    try {
      if (kind === "symlink") assert.throws(f.save, /unsafe backup path/i);
      else f.save();
    } finally { fs.copyFileSync = copy; }
    assert.equal(fs.readFileSync(f.target, "utf8"), "keep backup target");
    assert.equal(fs.readFileSync(bak, "utf8"), kind === "symlink" ? "keep backup target" : "keep racing backup");
    assert.equal(parseTomlTopLevel(fs.readFileSync(f.file, "utf8")).model, kind === "symlink" ? "before" : "after");
  });

  for (const spec of cases.slice(0, 4)) for (const linked of [false, true]) {
    it(`${spec[1]} rejects a ${linked ? "symlink to a" : "direct"} directory on read and write`, (t) => {
      const f = setup(t, spec);
      if (linked) { fs.mkdirSync(f.target); fs.symlinkSync(f.target, f.file); }
      else fs.mkdirSync(f.file);
      assert.throws(f.save, /regular file/i);
      assertCorrupted(f, /regular file/i);
      assert.equal(fs.existsSync(f.file + ".t3hub.bak"), false);
      assert.deepEqual(fs.readdirSync(linked ? f.target : f.file), []);
    });
  }

  for (const spec of cases.slice(0, 4)) for (const linked of [false, true]) {
    it(`${spec[1]} refuses a ${linked ? "symlinked" : "direct"} FIFO without blocking reads or writes`, (t) => {
      const f = setup(t, spec);
      require("node:child_process").execFileSync("mkfifo", [linked ? f.target : f.file]);
      if (linked) fs.symlinkSync(f.target, f.file);
      // A broken implementation blocks on FIFO reads; isolate it with a deadline.
      const result = require("node:child_process").spawnSync(process.execPath, ["-e", `
        const assert = require("node:assert/strict");
        const { createHostSettingsManager } = require(process.argv[1]);
        const [homeDir, host, rule] = JSON.parse(process.argv[2]);
        const mgr = createHostSettingsManager({ homeDir });
        const snapshot = mgr.getSettingsSnapshot();
        const entry = rule ? snapshot.globalRules[host] : snapshot[host];
        assert.equal(entry.corrupted, true);
        assert.match(entry.error, /regular file/i);
        if (rule) {
          assert.throws(() => mgr.getRuleContent(host), /regular file/i);
          assert.throws(() => mgr.saveRuleContent(host, "after"), /regular file/i);
        } else assert.throws(() => mgr.updateHostSetting({ host, key: "model", value: "after" }), /regular file/i);
      `, path.resolve(__dirname, "../src/hub-host-settings.cjs"), JSON.stringify([f.home, f.host, f.rule])], { encoding: "utf8", timeout: 3000 });
      assert.equal(result.error, undefined, "FIFO validation must finish without waiting for a writer");
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.existsSync(f.file + ".t3hub.bak"), false);
      assert.equal(fs.lstatSync(linked ? f.target : f.file).isFIFO(), true);
    });
  }

  for (const kind of ["dangling symlink", "file"]) it(`missing settings reject a ${kind} ancestor without creating files`, (t) => {
    const home = makeTmp("unsafe-parent");
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const parent = path.join(home, ".config"), target = path.join(home, "missing");
    if (kind === "file") fs.writeFileSync(parent, "keep");
    else fs.symlinkSync(target, parent);
    const mgr = createHostSettingsManager({ homeDir: home });
    assert.throws(() => mgr.updateHostSetting({ host: "muse", key: "model", value: "after" }), /directory|dangling symlink/i);
    assert.equal(mgr.getSettingsSnapshot().muse.corrupted, true);
    assert.equal(fs.existsSync(target), false);
    assert.deepEqual(fs.readdirSync(home), [".config"]);
    if (kind === "file") assert.equal(fs.readFileSync(parent, "utf8"), "keep");
  });

  it("creates missing config/rules with private config modes and follows valid directory symlinks", (t) => {
    const home = makeTmp("missing-settings");
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    fs.mkdirSync(path.join(home, "dotfiles"));
    fs.symlinkSync("dotfiles", path.join(home, ".config"));
    const mgr = createHostSettingsManager({ homeDir: home });
    for (const host of ["codex", "muse", "pi"]) mgr.updateHostSetting({ host, key: "model", value: "after" });
    const before = mgr.getRuleContent("codex");
    mgr.saveRuleContent("codex", "# after\n", before.content, before.targetPath);
    const snapshot = mgr.getSettingsSnapshot();
    for (const host of ["codex", "muse", "pi"]) {
      assert.equal(snapshot[host].corrupted, false);
      assert.equal(snapshot[host].editableValues.model, "after");
      assert.equal(fs.statSync(snapshot[host].path).mode & 0o777, 0o600);
    }
    assert.equal(fs.lstatSync(path.join(home, ".config")).isSymbolicLink(), true);
    assert.equal(fs.statSync(path.join(home, ".codex/AGENTS.md")).mode & 0o777, 0o644);
  });
});

describe("hub-host-settings: TOML 1.0 多行字符串解码 100% 对齐 tomllib", () => {
  const { execFileSync } = require("node:child_process");
  function pythonDecode(toml) {
    const script = "import sys, tomllib, json; toml=sys.argv[1]; print(json.dumps(tomllib.loads(toml)['model'], ensure_ascii=False))";
    const out = execFileSync("python3", ["-c", script, toml], { encoding: "utf8" });
    return JSON.parse(out);
  }
  function jsDecode(toml) {
    return parseTomlTopLevel(toml).model;
  }
  const cases = [
    { name: "basic strip LF", toml: 'model = """\ngpt-6"""', expected: "gpt-6" },
    { name: "basic strip CRLF", toml: 'model = """\r\ngpt-6"""', expected: "gpt-6" },
    { name: "literal strip LF", toml: "model = '''\nliteral'''", expected: "literal" },
    { name: "literal strip CRLF", toml: "model = '''\r\nliteral'''", expected: "literal" },
    { name: "basic line-ending continuation LF", toml: 'model = """a\\\n   b"""', expected: "ab" },
    { name: "basic line-ending spaces before newline", toml: 'model = """a\\   \n   b"""', expected: "ab" },
    { name: "basic line-ending CRLF mixed whitespace", toml: 'model = """a\\  \r\n\t  \n  b"""', expected: "ab" },
    { name: "basic line-ending multiple newlines", toml: 'model = """a\\\n\n\n  b"""', expected: "ab" },
    { name: "basic 5 quotes", toml: 'model = """x"""""', expected: 'x""' },
    { name: "literal 5 quotes", toml: "model = '''x'''''", expected: "x''" },
    { name: "basic CRLF normalize", toml: 'model = """a\r\nb"""', expected: "a\nb" },
    { name: "literal CRLF normalize", toml: "model = '''a\r\nb'''", expected: "a\nb" },
    { name: "basic unicode \\u", toml: 'model = """\\u0041\\u0042"""', expected: "AB" },
    { name: "basic unicode \\U", toml: 'model = """\\U0001F600"""', expected: "😀" },
    { name: "basic multiline escapes", toml: 'model = """a\\n\\tb\\u00e9"""', expected: "a\n\tbé" },
    { name: "single basic unicode", toml: 'model = "\\u00e9"', expected: "é" },
    { name: "single basic escapes", toml: 'model = "a\\n\\t\\b\\f\\r\\"\\\\"', expected: "a\n\t\b\f\r\"\\" },
  ];
  for (const c of cases) {
    it(`${c.name} 与 tomllib 逐字符一致`, () => {
      const js = jsDecode(c.toml);
      const py = pythonDecode(c.toml);
      assert.equal(js, c.expected, `JS 期望 ${JSON.stringify(c.expected)} 但得到 ${JSON.stringify(js)}`);
      assert.equal(js, py, `JS 与 tomllib 不一致：JS=${JSON.stringify(js)} PY=${JSON.stringify(py)} toml=${JSON.stringify(c.toml)}`);
      assert.equal(js.length, py.length);
    });
  }
  it("多行基本与原样快照等价", () => {
    const home = makeTmp("home-multiline");
    const codexDir = path.join(home, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, "config.toml"), 'model = """\ngpt-6"""\n', "utf8");
    const mgr = createHostSettingsManager({ homeDir: home });
    assert.equal(mgr.getSettingsSnapshot().codex.model, "gpt-6");
    assert.equal(mgr.getSettingsSnapshot().codex.editableValues.model, "gpt-6");
  });

  it("unsafe .t3hub.bak (symlink or directory) is rejected immediately at read time in snapshot and getRuleContent", () => {
    const home = makeTmp("home-unsafe-bak-read");
    const codexDir = path.join(home, ".codex");
    const museDir = path.join(home, ".config", "muse");
    fs.mkdirSync(codexDir, { recursive: true });
    fs.mkdirSync(museDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, "config.toml"), "model = \"gpt-6\"\n", "utf8");
    fs.writeFileSync(path.join(museDir, "settings.json"), JSON.stringify({ model: "muse-ember-1.0" }), "utf8");
    fs.writeFileSync(path.join(codexDir, "AGENTS.md"), "# Rules\n", "utf8");
    const outside = path.join(home, "outside.txt");
    fs.writeFileSync(outside, "secret", "utf8");
    fs.symlinkSync(outside, path.join(codexDir, "config.toml.t3hub.bak"));
    fs.mkdirSync(path.join(museDir, "settings.json.t3hub.bak"));
    fs.symlinkSync(outside, path.join(codexDir, "AGENTS.md.t3hub.bak"));

    const mgr = createHostSettingsManager({ homeDir: home });
    const snap = mgr.getSettingsSnapshot();
    assert.equal(snap.codex.corrupted, true);
    assert.match(snap.codex.error, /Refusing unsafe backup path/);
    assert.equal(snap.muse.corrupted, true);
    assert.match(snap.muse.error, /Refusing unsafe backup path/);
    assert.equal(snap.globalRules.codex.corrupted, true);
    assert.match(snap.globalRules.codex.error, /Refusing unsafe backup path/);
    assert.throws(() => mgr.getRuleContent("codex"), /Refusing unsafe backup path/);
  });
});

describe("hub-task-board: per-thread native mapping + strict isolation", () => {
  it("会话 A agy-brain 3 步 / B hub-mcp 2 步 / C 空会话 exclude 时 0/0 且不串台", () => {
    const dir = makeTmp("per-thread-isolation");
    const brainRoot = path.join(dir, "brain");
    const agySession = path.join(brainRoot, "agy-conv-111");
    fs.mkdirSync(agySession, { recursive: true });
    const taskMd = ["# AGY 会话 111", "", "- [x] AGY 步骤一", "- [/] AGY 步骤二", "- [ ] AGY 步骤三"].join("\n") + "\n";
    fs.writeFileSync(path.join(agySession, "task.md"), taskMd, "utf8");
    // 让 agy 的 mtime 成为全局最新，若回退则 B/C 会串台拿到它
    const nowDate = new Date();
    fs.utimesSync(path.join(agySession, "task.md"), nowDate, nowDate);

    const threadA = "3972c780-1111-1111-1111-111111111111";
    const threadB = "codex-thread-B";
    const threadC = "empty-thread-C";

    const dbDir = path.join(dir, "db");
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = buildT3Db(dbDir, (db) => {
      db.exec(`CREATE TABLE orchestration_v2_projection_provider_threads (thread_id TEXT, provider_session_id TEXT, payload_json TEXT)`);
      db.prepare("INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (?,?,?,?,?,?)").run("proj-1", "p", dir, "{}", "2026-11-15T00:00:00Z", "2026-11-15T00:00:00Z");
      insertThread(db, { threadId: threadA, title: "Agy 会话", updatedAt: "2026-11-15T08:00:00.000Z" });
      insertThread(db, { threadId: threadB, title: "Codex 会话", updatedAt: "2026-11-15T09:00:00.000Z" });
      insertThread(db, { threadId: threadC, title: "空新会话", updatedAt: "2026-11-15T10:00:00.000Z" });
      // A 的 native 映射 -> brain 目录名
      const payloadA = JSON.stringify({ nativeThreadRef: { nativeId: "agy-conv-111", provider: "antigravity" }, providerSessionId: "agy-conv-111" });
      db.prepare("INSERT INTO orchestration_v2_projection_provider_threads (thread_id, provider_session_id, payload_json) VALUES (?,?,?)").run(threadA, "agy-conv-111", payloadA);
      // C 的 2 个子代理
      insertSubagent(db, { subId: "c-sub-1", parentThread: threadC, status: "completed", provider: "muse", child: "c1", title: "子代理 甲", model: "m", startedAt: "2026-11-15T07:00:00Z", completedAt: "2026-11-15T07:05:00Z", updatedAt: "2026-11-15T07:05:00Z" });
      insertSubagent(db, { subId: "c-sub-2", parentThread: threadC, status: "running", provider: "codex", child: "c2", title: "子代理 乙", model: "m", startedAt: "2026-11-15T07:00:00Z", completedAt: null, updatedAt: "2026-11-15T07:30:00Z" });
    });

    const hubPlansDir = path.join(dir, "plans");
    const board = createTaskBoard({ t3DbPath: dbPath, agyBrainDirs: [brainRoot], hubPlansDir, now: () => Date.parse("2026-11-15T11:00:00.000Z") });
    // B 的独立 Hub 计划 2 步
    board.updatePlan({ threadId: threadB, projectRoot: dir, title: "Codex 计划", background: "B 背景", steps: [{ text: "B 步骤一", status: "completed" }, { text: "B 步骤二", status: "pending" }] });

    const snapA = board.getBoardSnapshot({ threadId: threadA, projectRoot: dir });
    assert.equal(snapA.source, "agy-brain");
    assert.equal(snapA.steps.length, 3);
    assert.equal(snapA.progress.label, "1/3");

    const snapB = board.getBoardSnapshot({ threadId: threadB, projectRoot: dir });
    assert.equal(snapB.source, "hub-mcp");
    assert.equal(snapB.steps.length, 2);
    assert.equal(snapB.steps[0].text, "B 步骤一");
    // 绝不串台拿到 A 的 task.md
    assert.ok(!snapB.steps.some((s) => s.text && s.text.startsWith("AGY")), "B must not cross-talk to A agy-brain");

    const snapC = board.getBoardSnapshot({ threadId: threadC, projectRoot: dir, excludeSubagentInference: true });
    assert.equal(snapC.steps.length, 0);
    assert.equal(snapC.progress.label, "0/0");
    assert.equal(snapC.source, "t3-native");
    assert.ok(!snapC.steps.some((s) => s.text && s.text.startsWith("AGY")), "C must not cross-talk agy");
    // 子代理仍应透出，但不被当作计划步骤
    assert.equal(snapC.subagents.length, 2, "subagents should still be listed even when inference excluded");
    assert.equal(snapC.steps.length, 0, "inference excluded keeps 0 steps");

    // 缺少项目上下文时不应读取全局最新的 AGY brain。
    const snapNoArg = board.getBoardSnapshot({});
    assert.ok(["agy-brain", "hub-mcp", "t3-native", "subagents-inferred"].includes(snapNoArg.source));
    assert.notEqual(snapNoArg.source, "agy-brain");
    assert.ok(snapNoArg.steps.length >= 0);
  });

  it("含 % 的合法 T3 委托会话 ID 不抛错且拦截 .. / \\ 与控制字符", () => {
    const dir = makeTmp("percent-thread");
    const board = createTaskBoard({ t3DbPath: path.join(dir, "missing.sqlite"), agyBrainDirs: [], hubPlansDir: path.join(dir, "plans") });
    const delegated = "thread:delegated-task:command%3Amcp%3Atool-abc:def";
    assert.doesNotThrow(() => board.getBoardSnapshot({ threadId: delegated }));
    assert.doesNotThrow(() => board.getBoardSnapshot({ threadId: "__NEW__" }));
    assert.doesNotThrow(() => board.updatePlan({ threadId: delegated, steps: [{ text: "ok", status: "pending" }] }));
    // 严格拦截非法
    assert.throws(() => board.getBoardSnapshot({ threadId: "a/../b" }), /invalid thread id/);
    assert.throws(() => board.getBoardSnapshot({ threadId: "a\\b" }), /invalid thread id/);
    assert.throws(() => board.getBoardSnapshot({ threadId: "a\u0000b" }), /invalid thread id/);
    assert.throws(() => board.getBoardSnapshot({ threadId: "a..b" }), /invalid thread id/);
  });

  it("[P1] clearPlan with projectRoot+threadId never cross-deletes the sibling session plan", () => {
    const dir = makeTmp("clear-isolation");
    const hubPlansDir = path.join(dir, "task-plans");
    const projectRoot = "/tmp/shared-project";
    const board = createTaskBoard({ t3DbPath: path.join(dir, "missing.sqlite"), agyBrainDirs: [], hubPlansDir });
    board.updatePlan({ threadId: "thread-a", projectRoot, steps: [{ text: "A 步骤", status: "pending" }] });
    board.updatePlan({ threadId: "thread-b", projectRoot, steps: [{ text: "B 步骤", status: "pending" }] });
    board.updatePlan({ projectRoot, steps: [{ text: "项目级草稿", status: "pending" }] });
    const res = board.clearPlan({ projectRoot, threadId: "thread-a" });
    assert.equal(res.deleted, 1, "only thread-a plan is deleted");
    assert.equal(board.getBoardSnapshot({ threadId: "thread-a", projectRoot }).steps.length, 0, "thread-a cleared");
    const snapB = board.getBoardSnapshot({ threadId: "thread-b", projectRoot });
    assert.equal(snapB.steps.length, 1);
    assert.equal(snapB.steps[0].text, "B 步骤", "sibling thread plan untouched despite shared projectRoot");
    // Project-level clear must not touch any thread-bound plan.
    const clearProject = board.clearPlan({ projectRoot });
    assert.equal(clearProject.deleted, 1, "only the thread-less project plan is deleted");
    const snapB2 = board.getBoardSnapshot({ threadId: "thread-b", projectRoot });
    assert.equal(snapB2.steps[0].text, "B 步骤", "thread-b survives project-level clear");
    assert.equal(board.getBoardSnapshot({ projectRoot }).steps.length, 0, "project-level draft cleared");
  });

  it("[P1] __NEW__ / strict draft never falls back to recent T3 session or freshest brain task.md", () => {
    const dir = makeTmp("new-isolation");
    const dbPath = buildT3Db(dir, (db) => {
      db.exec("INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES ('proj-1','p1','/tmp/newproj','{}','2026-11-15T00:00:00Z','2026-11-15T00:00:00Z')");
      insertThread(db, { threadId: "thread-old", title: "旧线程", updatedAt: "2026-11-15T10:00:00.000Z" });
      insertPlan(db, { planId: "p-old", threadId: "thread-old", steps: [{ id: "s1", text: "旧会话步骤", status: "pending" }], explanation: "旧背景", updatedAt: "2026-11-15T10:00:00.000Z" });
    });
    const brainRoot = path.join(dir, "brain");
    const sess = path.join(brainRoot, "agy-sess-1");
    fs.mkdirSync(sess, { recursive: true });
    fs.writeFileSync(path.join(sess, "task.md"), "# 最新全局 Brain\n\n- [ ] brain 新步骤\n", "utf8");
    const hubPlansDir = path.join(dir, "plans");
    const board = createTaskBoard({ t3DbPath: dbPath, agyBrainDirs: [brainRoot], hubPlansDir });
    board.updatePlan({ threadId: "thread-old", projectRoot: "/tmp/newproj", steps: [{ text: "旧会话 hub 步骤", status: "pending" }] });
    // 1) explicit __NEW__ returns the empty 0/0 plan, never the old session.
    const snapNew = board.getBoardSnapshot({ threadId: "__NEW__", projectRoot: "/tmp/newproj", strictThreadMatch: true });
    assert.equal(snapNew.threadId, "__NEW__");
    assert.equal(snapNew.steps.length, 0);
    assert.equal(snapNew.progress.label, "0/0");
    assert.ok(!snapNew.steps.some((s) => String(s.text).includes("旧会话")), "no cross-talk to old session plan");
    assert.ok(!snapNew.steps.some((s) => String(s.text).includes("brain")), "no cross-talk to brain task.md");
    assert.deepEqual(snapNew.subagents, []);
    assert.deepEqual(snapNew.artifacts, []);
    // 2) strict without threadId also stays isolated.
    const snapStrict = board.getBoardSnapshot({ projectRoot: "/tmp/newproj", strictThreadMatch: true });
    assert.equal(snapStrict.steps.length, 0);
    assert.equal(snapStrict.progress.label, "0/0");
    // 3) __NEW__ alone (even without the flag) stays isolated.
    const snapNoFlag = board.getBoardSnapshot({ threadId: "__NEW__", projectRoot: "/tmp/newproj" });
    assert.equal(snapNoFlag.steps.length, 0);
    // 4) A project-only lookup never implicitly selects a session.
    const snapProject = board.getBoardSnapshot({ projectRoot: "/tmp/newproj" });
    assert.equal(snapProject.threadId, "");
    assert.equal(snapProject.progress.label, "0/0");
    // 5) __NEW__ manual draft is project-scoped: another project sees nothing.
    board.updatePlan({ threadId: "__NEW__", projectRoot: "/tmp/newproj", steps: [{ text: "草稿新步骤", status: "pending" }] });
    assert.equal(board.getBoardSnapshot({ threadId: "__NEW__", projectRoot: "/tmp/newproj" }).steps[0].text, "草稿新步骤");
    assert.equal(board.getBoardSnapshot({ threadId: "__NEW__", projectRoot: "/tmp/other" }).steps.length, 0, "draft of one project never leaks to another project");
    assert.equal(board.getBoardSnapshot({ threadId: "thread-old", projectRoot: "/tmp/newproj" }).steps[0].text, "旧会话 hub 步骤", "real session still sees its own hub plan");
  });
});

describe("hub-task-board: project and draft isolation regressions", () => {
  function fixture(t, label, setup) {
    const dir = makeTmp(label);
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const dbPath = setup ? buildT3Db(dir, setup) : path.join(dir, "missing.sqlite");
    const brainRoot = path.join(dir, "brain");
    const hubPlansDir = path.join(dir, "plans");
    const board = createTaskBoard({ t3DbPath: dbPath, agyBrainDirs: [brainRoot], hubPlansDir });
    return { dir, board, brainRoot, hubPlansDir };
  }
  function assertEmpty(snap) {
    assert.equal(snap.progress.label, "0/0");
    assert.deepEqual(snap.steps, []);
    assert.deepEqual(snap.subagents, []);
    assert.deepEqual(snap.artifacts, []);
    assert.equal(snap.title, "");
    assert.equal(snap.background, "");
  }

  it("[P1] __NEW__ writes, reads and clears are isolated across projects and the unscoped draft", (t) => {
    const { dir, board, hubPlansDir } = fixture(t, "draft-projects");
    // Same basename also guards against lossy project-name file keys.
    const projA = path.join(dir, "a", "repo"), projB = path.join(dir, "b", "repo");
    const queryA = { threadId: "__NEW__", projectRoot: projA };
    const queryB = { threadId: "__NEW__", projectRoot: projB };
    const unscoped = { threadId: "__NEW__" };
    for (const [query, text] of [[queryA, "A 草稿"], [queryB, "B 草稿"], [unscoped, "无项目草稿"]]) {
      board.updatePlan({ ...query, steps: [{ text, status: "pending" }] });
    }
    assert.equal(fs.readdirSync(hubPlansDir).length, 3, "each scope has its own disk file");
    assert.equal(board.getBoardSnapshot(queryA).steps[0].text, "A 草稿");
    assert.equal(board.getBoardSnapshot(queryB).steps[0].text, "B 草稿");
    assert.equal(board.getBoardSnapshot(unscoped).steps[0].text, "无项目草稿");
    assert.deepEqual(board.clearPlan(queryA), { deleted: 1 });
    assertEmpty(board.getBoardSnapshot(queryA));
    assert.equal(board.getBoardSnapshot(queryB).steps[0].text, "B 草稿");
    assert.equal(board.getBoardSnapshot(unscoped).steps[0].text, "无项目草稿");
    assert.deepEqual(board.clearPlan(unscoped), { deleted: 1 });
    assertEmpty(board.getBoardSnapshot(unscoped));
    assert.equal(board.getBoardSnapshot(queryB).steps[0].text, "B 草稿");
    assert.deepEqual(board.clearPlan(queryB), { deleted: 1 });
  });

  it("普通会话计划按项目隔离，无项目的旧记录只由无项目查询访问", (t) => {
    const { dir, board, hubPlansDir } = fixture(t, "thread-project-isolation");
    const a = path.join(dir, "a"), b = path.join(dir, "b");
    writeFile(hubPlansDir, "foreign.json", JSON.stringify({ threadId: "same", projectRoot: b, steps: [{ text: "B" }], updatedAt: "2026-11-16" }));
    assertEmpty(board.getBoardSnapshot({ threadId: "same", projectRoot: a }));
    assert.deepEqual(board.clearPlan({ threadId: "same", projectRoot: a }), { deleted: 0 });
    assert.equal(board.getBoardSnapshot({ threadId: "same", projectRoot: b + "/" }).steps[0].text, "B");
    assertEmpty(board.getBoardSnapshot({ threadId: "same" }));
    assert.deepEqual(board.clearPlan({ threadId: "same" }), { deleted: 0 }, "unscoped clear must not remove project B's plan");
    assert.equal(board.getBoardSnapshot({ threadId: "same", projectRoot: b }).steps[0].text, "B");
    writeFile(hubPlansDir, "same-legacy.json", JSON.stringify({ threadId: "same", steps: [{ text: "无项目旧记录" }] }));
    assert.equal(board.getBoardSnapshot({ threadId: "same" }).steps[0].text, "无项目旧记录");
    assert.equal(board.getBoardSnapshot({ threadId: "same", projectRoot: b }).steps[0].text, "B");
    assert.deepEqual(board.clearPlan({ threadId: "same" }), { deleted: 1 }, "unscoped clear must remove only the unscoped plan");
    assert.equal(board.getBoardSnapshot({ threadId: "same", projectRoot: b }).steps[0].text, "B");
    writeFile(hubPlansDir, "legacy.json", JSON.stringify({ threadId: "legacy", steps: [{ text: "旧记录" }] }));
    assertEmpty(board.getBoardSnapshot({ threadId: "legacy", projectRoot: a }));
    assertEmpty(board.getBoardSnapshot({ threadId: "legacy", projectRoot: b }));
    assert.deepEqual(board.clearPlan({ threadId: "legacy", projectRoot: a }), { deleted: 0 }, "project A must not delete an unscoped legacy plan");
    assert.deepEqual(board.clearPlan({ threadId: "legacy", projectRoot: b }), { deleted: 0 }, "project B must not delete an unscoped legacy plan");
    assert.equal(board.getBoardSnapshot({ threadId: "legacy" }).steps[0].text, "旧记录");
    assert.deepEqual(board.clearPlan({ threadId: "legacy" }), { deleted: 1 });
    assert.deepEqual(board.clearPlan({ threadId: "same", projectRoot: b }), { deleted: 1 });
  });

  it("[P1] normalized project roots identify the same draft for key, read, rewrite and clear", (t) => {
    const { dir, board, hubPlansDir } = fixture(t, "draft-normalize");
    const projectRoot = path.join(dir, "repo");
    const query = { threadId: "__NEW__", projectRoot };
    const alias = { ...query, projectRoot: projectRoot + "//" };
    assert.equal(planFileKey(query), planFileKey(alias));
    board.updatePlan({ ...query, steps: [{ text: "原草稿" }] });
    assert.equal(board.getBoardSnapshot(alias).steps[0].text, "原草稿");
    board.updatePlan({ ...alias, steps: [{ text: "更新草稿" }] });
    assert.equal(fs.readdirSync(hubPlansDir).length, 1);
    assert.equal(board.getBoardSnapshot(query).steps[0].text, "更新草稿");
    assert.deepEqual(board.clearPlan(query), { deleted: 1 });
    assertEmpty(board.getBoardSnapshot(alias));
  });

  it("[P1] legacy draft records are filtered by both sentinel and project when reading and clearing", (t) => {
    const { dir, board, hubPlansDir } = fixture(t, "draft-legacy");
    const projA = path.join(dir, "a"), projB = path.join(dir, "b");
    const records = [
      { threadId: "__NEW__", projectRoot: projA + "/", steps: [{ text: "A" }] },
      { threadId: "__NEW__", projectRoot: projB, steps: [{ text: "B" }] },
      { threadId: "__NEW__", steps: [{ text: "unscoped" }] },
      { threadId: "thread-a", projectRoot: projA, steps: [{ text: "session" }] },
      { projectRoot: projA, steps: [{ text: "project" }] },
    ];
    records.forEach((r, i) => writeFile(hubPlansDir, `legacy-${i}.json`, JSON.stringify({ ...r, updatedAt: new Date().toISOString() })));
    assert.equal(board.getBoardSnapshot({ threadId: "__NEW__", projectRoot: projA }).steps[0].text, "A");
    assert.deepEqual(board.clearPlan({ threadId: "__NEW__", projectRoot: projA }), { deleted: 1 });
    assert.equal(board.getBoardSnapshot({ threadId: "__NEW__", projectRoot: projB }).steps[0].text, "B");
    assert.equal(board.getBoardSnapshot({ threadId: "thread-a", projectRoot: projA }).steps[0].text, "session");
    assert.equal(board.getBoardSnapshot({ projectRoot: projA }).steps[0].text, "project");
    assert.deepEqual(board.clearPlan({ threadId: "__NEW__" }), { deleted: 1 });
    assert.equal(board.getBoardSnapshot({ threadId: "__NEW__", projectRoot: projB }).steps[0].text, "B");
  });

  it("[P1] project-only query with no matching thread never leaks a foreign T3/Hub/brain plan", (t) => {
    const { dir, board, brainRoot } = fixture(t, "project-missing-thread", (db) => {
      db.exec("INSERT INTO projection_projects VALUES ('proj-1','A','/tmp/project-a','{}','2026-11-15','2026-11-15',NULL)");
      insertThread(db, { threadId: "thread-a", title: "A 线程", updatedAt: "2026-11-15T10:00:00Z" });
      insertPlan(db, { planId: "plan-a", threadId: "thread-a", steps: [{ text: "A 原生计划" }], explanation: "A 背景", updatedAt: "2026-11-15T10:00:00Z" });
      insertSubagent(db, { subId: "a-sub", parentThread: "thread-a", child: "a-child", title: "A 子代理", status: "running", provider: "codex", model: "m", startedAt: "2026-11-15T09:00:00Z", completedAt: null, updatedAt: "2026-11-15T10:00:00Z" });
    });
    writeFile(brainRoot, "other/task.md", "# 全局背景\n- [ ] 全局 brain 计划\n");
    board.updatePlan({ threadId: "thread-a", projectRoot: "/tmp/project-a", steps: [{ text: "A Hub 计划" }] });
    for (const extra of [{}, { strictThreadMatch: false }]) {
      const snap = board.getBoardSnapshot({ projectRoot: path.join(dir, "project-b"), ...extra });
      assert.equal(snap.threadId, "");
      assertEmpty(snap);
    }
    assert.ok(board.getBoardSnapshot({}).steps.length > 0, "unscoped global lookup remains supported");
  });

  it("[P1] project-only query reads only a threadless plan even when the project has active sessions", (t) => {
    const projectRoot = "/tmp/own-project";
    const { board, brainRoot } = fixture(t, "project-no-implicit-session", (db) => {
      db.exec("INSERT INTO projection_projects VALUES ('proj-1','own','/tmp/own-project','{}','2026-11-15','2026-11-15',NULL)");
      db.exec("CREATE TABLE orchestration_v2_projection_provider_threads (thread_id TEXT, provider_session_id TEXT, payload_json TEXT)");
      insertThread(db, { threadId: "thread-1", title: "同项目会话", updatedAt: "2026-11-15T10:00:00Z" });
      insertPlan(db, { planId: "plan-1", threadId: "thread-1", steps: [{ text: "会话原生计划" }], updatedAt: "2026-11-15T10:00:00Z" });
      db.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?,?,?)").run("thread-1", "own-native", JSON.stringify({ nativeThreadRef: { nativeId: "own-native" } }));
      insertSubagent(db, { subId: "own-sub", parentThread: "thread-1", child: "own-child", title: "会话子代理", status: "running", provider: "codex", model: "m", startedAt: "2026-11-15T09:00:00Z", completedAt: null, updatedAt: "2026-11-15T10:00:00Z" });
    });
    const task = writeFile(brainRoot, "own-native/task.md", "# 同项目会话\n- [ ] 同项目 brain 计划\n");
    fs.utimesSync(task, new Date("2020-01-01"), new Date("2020-01-01"));
    board.updatePlan({ threadId: "thread-1", projectRoot, steps: [{ text: "会话 Hub 计划" }] });
    board.updatePlan({ threadId: "__NEW__", projectRoot, steps: [{ text: "新会话草稿" }] });
    assertEmpty(board.getBoardSnapshot({ projectRoot }));
    board.updatePlan({ projectRoot, steps: [{ text: "项目手动计划" }] });
    for (const root of [projectRoot, projectRoot + "/"]) {
      const snap = board.getBoardSnapshot({ projectRoot: root });
      assert.equal(snap.threadId, "");
      assert.equal(snap.steps[0].text, "项目手动计划");
      assert.deepEqual(snap.subagents, []);
      assert.deepEqual(snap.artifacts, []);
    }
    assert.deepEqual(board.clearPlan({ projectRoot: projectRoot + "/" }), { deleted: 1 });
    assertEmpty(board.getBoardSnapshot({ projectRoot }));
    const session = board.getBoardSnapshot({ projectRoot, threadId: "thread-1" });
    assert.equal(session.steps[0].text, "会话 Hub 计划");
    assert.equal(session.subagents.length, 1);
    assert.equal(session.artifacts.length, 1, "explicit session still uses its native brain mapping");
    assert.equal(board.getBoardSnapshot({ projectRoot, strictThreadMatch: true }).steps[0].text, "新会话草稿", "explicit strict draft lookup retains its sentinel semantics");
  });

  it("[P1] project-only query without a database cannot fall back to global Hub or brain data", (t) => {
    const { dir, board, brainRoot } = fixture(t, "project-no-db");
    writeFile(brainRoot, "other/task.md", "# 其他会话\n- [ ] 其他会话计划\n");
    board.updatePlan({ threadId: "foreign", steps: [{ text: "全局 Hub" }] });
    assertEmpty(board.getBoardSnapshot({ projectRoot: path.join(dir, "repo") }));
    assert.ok(board.getBoardSnapshot({}).steps.length > 0);
  });

  it("[P1] project plans with the same basename cannot overwrite each other", (t) => {
    const { dir, board } = fixture(t, "project-file-keys");
    const basename = "项目".repeat(40);
    const projA = path.join(dir, "a", basename), projB = path.join(dir, "b", basename);
    board.updatePlan({ projectRoot: projA, steps: [{ text: "A 项目计划" }] });
    board.updatePlan({ projectRoot: projB, steps: [{ text: "B 项目计划" }] });
    assert.equal(board.getBoardSnapshot({ projectRoot: projA }).steps[0].text, "A 项目计划");
    assert.equal(board.getBoardSnapshot({ projectRoot: projB }).steps[0].text, "B 项目计划");
    assert.deepEqual(board.clearPlan({ projectRoot: projA }), { deleted: 1 });
    assert.equal(board.getBoardSnapshot({ projectRoot: projB }).steps[0].text, "B 项目计划");
  });

  it("[P1] legal session IDs with the same slug cannot overwrite each other", (t) => {
    const { board } = fixture(t, "thread-file-keys");
    const ids = ["thread:a", "threada", "thread_a", "thread-a", "会".repeat(80) + ":"];
    ids.forEach((threadId) => board.updatePlan({ threadId, steps: [{ text: threadId }] }));
    ids.forEach((threadId) => assert.equal(board.getBoardSnapshot({ threadId }).steps[0].text, threadId));
    assert.deepEqual(board.clearPlan({ threadId: ids[0] }), { deleted: 1 });
    ids.slice(1).forEach((threadId) => assert.equal(board.getBoardSnapshot({ threadId }).steps[0].text, threadId));
  });
});

describe("hub-task-board: dual-scope thread+project isolation regressions", () => {
  it("[P1] same non-__NEW__ threadId across two projectRoots preserves both files with isolated read and clear", (t) => {
    const dir = makeTmp("dual-scope");
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const hubPlansDir = path.join(dir, "task-plans");
    const board = createTaskBoard({ t3DbPath: path.join(dir, "missing.sqlite"), agyBrainDirs: [], hubPlansDir });
    const projA = path.join(dir, "a", "proj-a");
    const projB = path.join(dir, "b", "proj-b");
    const tid = "dup-t";
    board.updatePlan({ threadId: tid, projectRoot: projA, steps: [{ text: "A step", status: "pending" }] });
    board.updatePlan({ threadId: tid, projectRoot: projB, steps: [{ text: "B step", status: "pending" }] });
    assert.equal(fs.readdirSync(hubPlansDir).length, 2, "each (threadId, projectRoot) must have its own disk file");
    // Isolated read
    const snapA = board.getBoardSnapshot({ threadId: tid, projectRoot: projA });
    assert.equal(snapA.steps.length, 1);
    assert.equal(snapA.steps[0].text, "A step");
    const snapB = board.getBoardSnapshot({ threadId: tid, projectRoot: projB });
    assert.equal(snapB.steps.length, 1);
    assert.equal(snapB.steps[0].text, "B step");
    // Isolated clear: only A
    const res = board.clearPlan({ threadId: tid, projectRoot: projA });
    assert.equal(res.deleted, 1);
    assert.equal(board.getBoardSnapshot({ threadId: tid, projectRoot: projA }).steps.length, 0);
    assert.equal(board.getBoardSnapshot({ threadId: tid, projectRoot: projB }).steps[0].text, "B step", "proj B plan must survive clear of A");
  });

  it("[P1] foreign SQLite thread in another workspace leaks nothing when queried with a different projectRoot", (t) => {
    const dir = makeTmp("foreign-leak");
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const dbPath = buildT3Db(dir, (db) => {
      db.exec("INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES ('proj-1','p1','/tmp/proj-a','{}','2026-11-15T00:00:00Z','2026-11-15T00:00:00Z')");
      insertThread(db, { threadId: "t-foreign", title: "Foreign Title", updatedAt: "2026-11-15T10:00:00.000Z" });
      insertPlan(db, { planId: "plan-f", threadId: "t-foreign", steps: [{ id: "s1", text: "foreign native step", status: "pending" }], explanation: "foreign bg", updatedAt: "2026-11-15T10:00:00.000Z" });
      insertSubagent(db, { subId: "sub-f", parentThread: "t-foreign", status: "running", provider: "codex", child: "child-f", title: "Foreign Sub", model: "m", startedAt: "2026-11-15T09:00:00Z", completedAt: null, updatedAt: "2026-11-15T10:00:00Z" });
    });
    const brainRoot = path.join(dir, "brain");
    const sess = path.join(brainRoot, "t-foreign");
    fs.mkdirSync(sess, { recursive: true });
    fs.writeFileSync(path.join(sess, "task.md"), "# foreign brain\n\n- [ ] brain step\n", "utf8");
    const hubPlansDir = path.join(dir, "plans");
    const board = createTaskBoard({ t3DbPath: dbPath, agyBrainDirs: [brainRoot], hubPlansDir });
    // Unscoped Hub plan for the same thread (legacy MCP plan_update without projectRoot)
    board.updatePlan({ threadId: "t-foreign", steps: [{ text: "unscoped hub step", status: "pending" }] });
    // Matching project returns full snapshot
    const snapMatch = board.getBoardSnapshot({ threadId: "t-foreign", projectRoot: "/tmp/proj-a" });
    assert.equal(snapMatch.threadId, "t-foreign");
    assert.equal(snapMatch.title, "Foreign Title");
    assert.ok(snapMatch.steps.length > 0, "matching project should expose steps");
    assert.ok(snapMatch.subagents.length > 0, "matching project should expose subagents");
    assert.ok(snapMatch.artifacts.length > 0, "matching project should expose brain artifacts");
    // Foreign project leaks NOTHING
    const snapForeign = board.getBoardSnapshot({ threadId: "t-foreign", projectRoot: "/tmp/proj-b" });
    assert.equal(snapForeign.progress.label, "0/0");
    assert.deepEqual(snapForeign.steps, []);
    assert.deepEqual(snapForeign.subagents, []);
    assert.deepEqual(snapForeign.artifacts, []);
    assert.equal(snapForeign.title, "");
    assert.equal(snapForeign.threadId, "");
    assert.equal(snapForeign.background, "");
    // Foreign clearPlan must NOT delete project A unscoped Hub plan
    const foreignClear = board.clearPlan({ threadId: "t-foreign", projectRoot: "/tmp/proj-b" });
    assert.equal(foreignClear.deleted, 0, "foreign projectRoot must not clear owner project unscoped plan");
    const ownerClear = board.clearPlan({ threadId: "t-foreign", projectRoot: "/tmp/proj-a" });
    assert.equal(ownerClear.deleted, 0, "a scoped clear must not delete an unscoped legacy plan");
    const unscopedClear = board.clearPlan({ threadId: "t-foreign" });
    assert.equal(unscopedClear.deleted, 1, "only an unscoped clear removes the legacy plan");
  });
});
