'use strict';
/* Issue #6 P0 隔离回归：总指挥开关、动态 Skill 同步、项目覆盖、宿主能力矩阵 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const { createSubagentsManager, DEFAULT_SUBAGENTS } = require('../src/hub-subagents.cjs');
const { createHostSettingsManager } = require('../src/hub-host-settings.cjs');
const repo = path.resolve(__dirname, '..');

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-skill-'));
  const hub = path.join(home, '.t3/hub');
  const projectA = path.join(home, 'p/project-a');
  const projectB = path.join(home, 'p/project-b');
  fs.mkdirSync(hub, { recursive: true });
  fs.mkdirSync(projectA, { recursive: true });
  fs.mkdirSync(projectB, { recursive: true });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const seed = DEFAULT_SUBAGENTS.map(x => ({ ...x }));
  // code-review 已为 max（新默认）；技能描述必须白跟随实际文件而非硬编码 high
  fs.writeFileSync(path.join(hub, 'subagents.json'), JSON.stringify(seed, null, 2) + '\n');
  const mgr = createSubagentsManager({ homeDir: home, hubDir: hub });
  // AGY 多实例 + 一个被忽略的归档实例 + 一个无 skills 目录的实例
  const agyBase = path.join(home, '.t3/userdata/providers/antigravity');
  for (const inst of ['inst1', 'inst2']) {
    fs.mkdirSync(path.join(agyBase, inst, 'config/skills'), { recursive: true });
  }
  fs.mkdirSync(path.join(agyBase, 'skills-archived-old', 'config/skills'), { recursive: true });
  fs.mkdirSync(path.join(agyBase, 'inst-noskills', 'config'), { recursive: true });
  const host = path.join(home, 'AGENTS.md');
  fs.writeFileSync(host, '# user private rules\n');
  return { home, hub, projectA, projectB, mgr, agyBase, host };
}

function hook(f, tool_input) {
  const bin = path.join(f.home, '.t3/bin');
  const installed = path.join(f.home, '.t3/hud-plugin');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(installed, { recursive: true });
  fs.copyFileSync(path.join(repo, 'scripts/subagent-route-guard.mjs'), path.join(bin, 'subagent-route-guard.mjs'));
  fs.copyFileSync(path.join(repo, 'src/hub-subagents.cjs'), path.join(installed, 'hub-subagents.cjs'));
  const run = spawnSync(process.execPath, [path.join(bin, 'subagent-route-guard.mjs')],
    { input: JSON.stringify({ tool_name: 'mcp__t3_code__delegate_task', cwd: f.projectA, tool_input }), encoding: 'utf8', env: { ...process.env, HOME: f.home, T3_HUB_DIR: f.hub } });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim() ? JSON.parse(run.stdout).hookSpecificOutput : null;
}

function skillPaths(f) {
  return [
    path.join(f.hub, 'skills/t3-subagent-routing/SKILL.md'),
    path.join(f.home, '.agents/skills/t3-subagent-routing/SKILL.md'),
    path.join(f.agyBase, 'inst1/config/skills/t3-subagent-routing/SKILL.md'),
    path.join(f.agyBase, 'inst2/config/skills/t3-subagent-routing/SKILL.md'),
  ];
}

const LEGACY_SKILL = `---
name: t3-subagent-routing
description: "全局子代理编排规则（旧版）"
---
# 全局子代理编排规则（T3 Code · 历史内置版本）
### ① \`explorer\`
3 基石 + 专项分身
<SUBAGENT-STOP>
legacy stop
</SUBAGENT-STOP>
全局子代理编排规则 code-review high 4 专项分身（旧）
`;

test('ON→OFF→ON 同步 6处规则+ACTIVE+4处SKILL，SHA一致、9角色max、ON/OFF互斥、SUBAGENT-STOP在位', t => {
  const f = fixture(t);
  const hosts = [f.host];
  // 首个已有 host 文件内容保留断言：写私有头
  let st = f.mgr.getOrchestrationState({ hosts });
  assert.equal(typeof f.mgr.renderRoutingSkillMarkdown, 'function', 'renderRoutingSkillMarkdown 必须导出');
  for (const mode of ['on', 'off', 'on']) {
    st = f.mgr.getOrchestrationState({ hosts });
    const res = f.mgr.updateOrchestrationConfig({ swarmMode: mode, expectedRevision: st.modeRevision }, { hostRulePaths: hosts });
    assert.equal(res.ok, true, JSON.stringify(res));
    st = f.mgr.getOrchestrationState({ hosts });
    assert.equal(st.swarmMode, mode);
    assert.equal(st.modeApplied, true);
    // hostCapabilities 诚实矩阵
    assert.ok(st.hostCapabilities, 'getOrchestrationState 必须暴露 hostCapabilities');
    const capsJson = JSON.stringify(st.hostCapabilities);
    assert.match(capsJson, /新会话/);
    assert.match(capsJson, /热注入|不会自动/);
    assert.match(capsJson, /PreToolUse/);
    assert.match(capsJson, /不会凭空触发|仅.*纠偏|纠偏/);
    assert.match(capsJson, /injectSteps/);
    assert.match(capsJson, /忽略/);
    assert.match(capsJson, /UserPromptSubmit/);
    assert.match(capsJson, /lineage|顶层/);
    // 规则块互斥
    const hostContent = fs.readFileSync(f.host, 'utf8');
    assert.match(hostContent, /# user private rules/);
    if (mode === 'on') {
      assert.match(hostContent, /Ordinary coding tasks need no T3 tools/);
      assert.match(hostContent, /决策、拆解、派单/);
    } else {
      assert.doesNotMatch(hostContent, /默认负责决策、拆解、派单/);
    }
    // ACTIVE + 全部 SKILL
    const active = fs.readFileSync(path.join(f.hub, 'ACTIVE_ORCHESTRATION_MODE.md'), 'utf8');
    assert.match(active, /T3_HUB_ORCHESTRATOR_START/);
    assert.match(active, mode === 'on' ? /T3 蜂群总指挥/ : /常规协作/);
    const contents = skillPaths(f).map(p => fs.readFileSync(p, 'utf8'));
    const hashes = contents.map(sha256);
    for (let i = 1; i < hashes.length; i++) assert.equal(hashes[i], hashes[0], 'SKILL.md SHA-256 必须一致');
    const skill = contents[0];
    assert.match(skill, /name: t3-subagent-routing/);
    assert.match(skill, /t3_hub_managed: true/);
    assert.match(skill, /<!-- t3-hub-managed-skill -->/);
    assert.match(skill, /<SUBAGENT-STOP>/);
    assert.match(skill, /220K/);
    assert.match(skill, /256K/);
    assert.match(skill, /150K/);
    assert.match(skill, /重型技能/);
    assert.match(skill, /8KB/);
    assert.match(skill, /落盘过滤|落盘/);
    assert.match(skill, /压缩后/);
    assert.match(skill, /豁免/);
    assert.match(skill, /Muse/);
    assert.match(skill, /Codex/);
    assert.match(skill, /Pi/);
    // 9 角色动态：描述中逐个出现 id -> provider model (effort)
    for (const id of ['explorer', 'worker', 'default', 'worker-pro', 'frontend', 'qa', 'code-review', 'review-fast', 'review-pro']) {
      assert.ok(skill.includes(id), 'SKILL 应含角色 ' + id);
    }
    assert.match(skill, /code-review -> codex gpt-6\.1-terra \(max\)/);
    assert.match(skill, /review-fast/);
    assert.match(skill, /review-pro/);
    // frontmatter description 动态：含当前模式与 9 角色
    const fm = skill.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(fm, 'frontmatter 必须存在');
    assert.match(fm[1], /t3_hub_managed: true/);
    if (mode === 'on') {
      assert.match(skill, /当前全局默认模式：T3 蜂群总指挥（ON）/);
      assert.doesNotMatch(skill, /当前全局默认模式：常规协作（OFF）/);
    } else {
      assert.match(skill, /当前全局默认模式：常规协作（OFF）/);
      assert.doesNotMatch(skill, /当前全局默认模式：T3 蜂群总指挥（ON）/);
      assert.doesNotMatch(skill, /默认负责决策、拆解、派单/);
      assert.match(skill, /小任务、短任务默认由主会话直接完成/);
    }
    // skills-archived 实例必须没有被同步
    assert.equal(fs.existsSync(path.join(f.agyBase, 'skills-archived-old/config/skills/t3-subagent-routing/SKILL.md')), false);
  }
});

test('旧版无标记模板默认跳过，精确哈希授权才接管，7个自定义 agents 原封不动', t => {
  const f = fixture(t);
  const agentsSkill = skillPaths(f)[1];
  fs.mkdirSync(path.dirname(agentsSkill), { recursive: true });
  fs.writeFileSync(agentsSkill, LEGACY_SKILL);
  const before = fs.readFileSync(agentsSkill, 'utf8');
  // 未知自定义 skill（非旧模板）
  const hubSkill = skillPaths(f)[0];
  fs.mkdirSync(path.dirname(hubSkill), { recursive: true });
  fs.writeFileSync(hubSkill, '---\nname: my-custom\ndescription: "user custom"\n---\n用户自定义未知文件\n');
  const customBefore = fs.readFileSync(hubSkill, 'utf8');
  // 7 个无标记 .claude/agents
  const claudeDir = path.join(f.home, '.claude/agents');
  fs.mkdirSync(claudeDir, { recursive: true });
  const customIds = ['explorer', 'worker', 'default', 'worker-pro', 'frontend', 'qa', 'code-review'];
  for (const id of customIds) {
    fs.writeFileSync(path.join(claudeDir, id + '.md'), `---\nname: ${id}\ndescription: "user custom ${id}"\n---\n用户自定义 ${id}\n`);
  }
  const agentsBefore = customIds.map(id => fs.readFileSync(path.join(claudeDir, id + '.md'), 'utf8'));
  let st = f.mgr.getOrchestrationState({ hosts: [f.host] });
  const res = f.mgr.updateOrchestrationConfig({ swarmMode: 'on', expectedRevision: st.modeRevision }, { hostRulePaths: [f.host] });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(fs.readFileSync(agentsSkill, 'utf8'), before);
  assert.ok(res.skillSync.skippedUnmanaged.includes(agentsSkill));
  assert.equal(fs.existsSync(agentsSkill + '.bak-t3hub'), false);
  const adopted = f.mgr.syncRoutingSkillTargets({ adoptUnmanagedSkillHashes: { [agentsSkill]: sha256(before) } });
  assert.equal(adopted.ok, true, JSON.stringify(adopted));
  // 只有精确哈希授权后才备份接管
  const bak = agentsSkill + '.bak-t3hub';
  assert.equal(fs.existsSync(bak), true, '旧模板应生成 .bak-t3hub');
  assert.equal(fs.readFileSync(bak, 'utf8'), before, '备份必须保留原始字节');
  assert.match(fs.readFileSync(agentsSkill, 'utf8'), /t3_hub_managed: true/);
  // 未知自定义保持原样并上报 skippedUnmanaged
  assert.equal(fs.readFileSync(hubSkill, 'utf8'), customBefore, '未知自定义不得覆盖');
  assert.ok(res.skillSync, 'update 结果必须含 skillSync');
  assert.ok(res.skillSync.skippedUnmanaged.some(p => p === hubSkill), 'skillSync.skippedUnmanaged 应报告未知文件');
  // 7 个 agents 原封不动
  customIds.forEach((id, i) => {
    assert.equal(fs.readFileSync(path.join(claudeDir, id + '.md'), 'utf8'), agentsBefore[i]);
  });
});

test('部分目标写入失败时规则块与 SKILL 全事务回滚', t => {
  const f = fixture(t);
  let st = f.mgr.getOrchestrationState({ hosts: [f.host] });
  assert.equal(f.mgr.updateOrchestrationConfig({ swarmMode: 'off', expectedRevision: st.modeRevision }, { hostRulePaths: [f.host] }).ok, true);
  st = f.mgr.getOrchestrationState({ hosts: [f.host] });
  const beforeHost = fs.readFileSync(f.host);
  const beforeActive = fs.readFileSync(path.join(f.hub, 'ACTIVE_ORCHESTRATION_MODE.md'));
  const beforeConfig = fs.readFileSync(path.join(f.hub, 'orchestration-config.json'));
  const beforeSkills = skillPaths(f).map(p => fs.readFileSync(p));
  const rename = fs.renameSync; let fired = false;
  const targetHubSkill = skillPaths(f)[0];
  fs.renameSync = function (source, dest) {
    if (!fired && source === targetHubSkill && String(dest).includes('.stage-')) {
      fired = true;
      const e = new Error('injected skill write failure'); e.code = 'EACCES'; throw e;
    }
    return rename.apply(this, arguments);
  };
  let res;
  try { res = f.mgr.updateOrchestrationConfig({ swarmMode: 'on', expectedRevision: st.modeRevision }, { hostRulePaths: [f.host] }); }
  finally { fs.renameSync = rename; }
  assert.equal(fired, true);
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.rolledBack, true);
  assert.deepEqual(fs.readFileSync(f.host), beforeHost);
  assert.deepEqual(fs.readFileSync(path.join(f.hub, 'ACTIVE_ORCHESTRATION_MODE.md')), beforeActive);
  assert.deepEqual(fs.readFileSync(path.join(f.hub, 'orchestration-config.json')), beforeConfig);
  skillPaths(f).forEach((p, i) => assert.deepEqual(fs.readFileSync(p), beforeSkills[i], p));
});

test('项目级覆盖：全局 ON + 项目A OFF + 项目B inherit，AGENTS/state/resolve/guard 分层准确', t => {
  const f = fixture(t);
  // 先全局 ON
  let st = f.mgr.getOrchestrationState({ hosts: [f.host] });
  assert.equal(f.mgr.updateOrchestrationConfig({ swarmMode: 'on', expectedRevision: st.modeRevision }, { hostRulePaths: [f.host] }).ok, true);
  // 项目A 写 OFF 覆盖
  const agentsA = path.join(f.projectA, 'AGENTS.md');
  fs.writeFileSync(agentsA, '# 项目A 私有规则\n');
  const rA = f.mgr.updateOrchestrationConfig({ swarmMode: 'off', expectedRevision: 'missing' }, { projectRoot: f.projectA });
  assert.equal(rA.ok, true, JSON.stringify(rA));
  const stateA = f.mgr.getOrchestrationState({ projectRoot: f.projectA });
  assert.equal(stateA.projectOverride.swarmMode, 'off');
  assert.equal(stateA.projectOverride.overridesGlobal, true);
  assert.equal(stateA.projectOverride.effectiveSwarmMode, 'off');
  assert.equal(stateA.projectOverride.projectRuleSynced, true);
  const contentA = fs.readFileSync(agentsA, 'utf8');
  assert.match(contentA, /# 项目A 私有规则/);
  assert.match(contentA, /项目级覆盖/);
  assert.match(contentA, /常规协作/);
  assert.doesNotMatch(contentA, /默认负责决策、拆解、派单/);
  // 项目B inherit
  const agentsB = path.join(f.projectB, 'AGENTS.md');
  fs.writeFileSync(agentsB, '# 项目B 私有\n');
  const stateB = f.mgr.getOrchestrationState({ projectRoot: f.projectB });
  assert.equal(stateB.projectOverride.swarmMode, 'inherit');
  assert.equal(stateB.projectOverride.overridesGlobal, false);
  assert.equal(stateB.projectOverride.effectiveSwarmMode, 'on');
  // resolve 分层
  const routeA = f.mgr.resolveSubagentRoute({ idOrTitle: 'worker', role: 'implementation', projectRoot: f.projectA });
  assert.equal(routeA.orchestration.swarmMode, 'off');
  assert.equal(routeA.orchestration.source, 'project');
  const routeB = f.mgr.resolveSubagentRoute({ idOrTitle: 'worker', role: 'implementation', projectRoot: f.projectB });
  assert.equal(routeB.orchestration.swarmMode, 'on');
  assert.equal(routeB.orchestration.source, 'global');
  // A project-level off override is a true no-op for delegation routing.
  const offInput = { title: 'worker', role: 'implementation', target: {}, task: 'do A' };
  const outA = hook(f, offInput);
  assert.equal(outA, null, 'effective off mode must preserve host-native delegation unchanged');
  assert.deepEqual(offInput, { title: 'worker', role: 'implementation', target: {}, task: 'do A' });
  // 清除为 inherit 后私有正文完好
  const rInherit = f.mgr.updateOrchestrationConfig({ swarmMode: 'inherit', expectedRevision: stateA.projectModeRevision }, { projectRoot: f.projectA });
  assert.equal(rInherit.ok, true, JSON.stringify(rInherit));
  const afterInherit = fs.readFileSync(agentsA, 'utf8');
  assert.match(afterInherit, /# 项目A 私有规则/);
  assert.doesNotMatch(afterInherit, /T3_HUB_ORCHESTRATOR_START/);
  const stateAfter = f.mgr.getOrchestrationState({ projectRoot: f.projectA });
  assert.equal(stateAfter.projectOverride.swarmMode, 'inherit');
  assert.equal(stateAfter.projectOverride.projectRuleSynced, true);
  // 全局仍 ON 不受影响
  assert.equal(f.mgr.getOrchestrationState({ hosts: [f.host] }).swarmMode, 'on');
});

test('hub-host-settings 检测 AGY Skill 哈希一致性与托管块外旧路由只读告警且不擦除正文', t => {
  const f = fixture(t);
  let st = f.mgr.getOrchestrationState({ hosts: [f.host] });
  assert.equal(f.mgr.updateOrchestrationConfig({ swarmMode: 'on', expectedRevision: st.modeRevision }, { hostRulePaths: [f.host] }).ok, true);
  const hsm = createHostSettingsManager({ homeDir: f.home, hubDir: f.hub });
  // getAntigravitySnapshot 需通过管理器暴露（若通过 getSettingsSnapshot 间接也行）
  let snap = null;
  if (typeof hsm.getAntigravitySnapshot === 'function') snap = hsm.getAntigravitySnapshot();
  else {
    const full = hsm.getSettingsSnapshot ? hsm.getSettingsSnapshot() : {};
    snap = full.antigravity;
  }
  assert.ok(snap, '应能取得 antigravity snapshot');
  assert.ok(Array.isArray(snap.routingSkills), 'snapshot 应含 routingSkills');
  const agentsSkill = path.join(f.home, '.agents/skills/t3-subagent-routing/SKILL.md');
  const entry = snap.routingSkills.find(x => x.path === agentsSkill);
  assert.ok(entry, 'routingSkills 应含 .agents SKILL');
  assert.equal(entry.exists, true);
  assert.equal(entry.sha256, sha256(fs.readFileSync(agentsSkill, 'utf8')));
  assert.equal(entry.managed, true);
  // 构造 AGY 托管块外冲突正文
  const agyRules = path.join(f.agyBase, 'inst1/config/rules/AGENTS.md');
  fs.mkdirSync(path.dirname(agyRules), { recursive: true });
  const block = f.mgr.buildOrchestrationDirective({ policyVersion: 2, orchestratorMode: 'off', swarmMode: 'on' });
  const conflictContent = '# 用户正文\n旧路由 code-review high 4 专项分身 残留\n' + block + '\n尾部正文\n';
  fs.writeFileSync(agyRules, conflictContent);
  // 需要 agyConfigDir 指向 inst1 才能命中该路径；用 opts 注入
  const hsm2 = createHostSettingsManager({ homeDir: f.home, hubDir: f.hub, agyConfigDir: path.join(f.agyBase, 'inst1/config') });
  let snap2 = typeof hsm2.getAntigravitySnapshot === 'function' ? hsm2.getAntigravitySnapshot() : hsm2.getSettingsSnapshot().antigravity;
  assert.ok(snap2.unmanagedConflictWarning, '托管块外旧路由应报 unmanagedConflictWarning');
  // 只读：文件未被改动
  assert.equal(fs.readFileSync(agyRules, 'utf8'), conflictContent);
});

test('saveSubagent/deleteSubagent 保持 SKILL 动态同步（effort 变化即跟随）', t => {
  const f = fixture(t);
  let st = f.mgr.getOrchestrationState({ hosts: [f.host] });
  assert.equal(f.mgr.updateOrchestrationConfig({ swarmMode: 'on', expectedRevision: st.modeRevision }, { hostRulePaths: [f.host], extraSkillPaths: [] }).ok, true);
  const skill = skillPaths(f)[0];
  assert.match(fs.readFileSync(skill, 'utf8'), /code-review -> codex gpt-6\.1-terra \(max\)/);
  // 改 effort 后 SKILL 必须跟随（证明非硬编码）
  const saved = f.mgr.saveSubagent({ scope: 'global', item: { id: 'code-review', effort: 'high' } });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.match(fs.readFileSync(skill, 'utf8'), /code-review -> codex gpt-6\.1-terra \(high\)/);
  // 改回 max
  f.mgr.saveSubagent({ scope: 'global', item: { id: 'code-review', effort: 'max' } });
  assert.match(fs.readFileSync(skill, 'utf8'), /code-review -> codex gpt-6\.1-terra \(max\)/);
});

// ---- Issue #6 code-review 11 项回归（先红后绿） ----

function projFileFor(f, projectRoot) {
  const canonical = fs.realpathSync(projectRoot);
  const hash = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 20);
  const slug = canonical.split(path.sep).filter(Boolean).pop();
  // 复用 manager 内部寻址：直接扫描 project-subagents 目录找唯一 orchestration.json
  const dir = path.join(f.hub, 'project-subagents');
  const entries = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const found = entries.map(e => path.join(dir, e, 'orchestration.json')).filter(p => fs.existsSync(p));
  if (found.length) return found[0];
  // 首写前按项目配置寻址（slug-hash）
  return null;
}
function findProjFile(f) {
  const dir = path.join(f.hub, 'project-subagents');
  if (!fs.existsSync(dir)) return null;
  for (const e of fs.readdirSync(dir)) {
    const p = path.join(dir, e, 'orchestration.json');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

test('R1 项目回滚：新建文件清理 + 并发追加 CAS + rolledBack 诚实（dev,ino,content 双重校验）', t => {
  // 1a: 原文件不存在 + projFile 写入失败，无并发 => 回滚删除且 rolledBack:true
  {
    const f = fixture(t);
    let st = f.mgr.getOrchestrationState({ hosts: [f.host] });
    assert.equal(f.mgr.updateOrchestrationConfig({ swarmMode: 'on', expectedRevision: st.modeRevision }, { hostRulePaths: [f.host] }).ok, true);
    const agentsMd = path.join(f.projectA, 'AGENTS.md');
    assert.equal(fs.existsSync(agentsMd), false);
    const rename = fs.renameSync, link = fs.linkSync; let fired = false;
    // projFile 写入经 transformTextFileAtomic：缺失走 linkSync，存在走 renameSync；两者在 dest 含 orchestration.json 时注入失败
    fs.renameSync = function (source, dest) {
      if (!fired && String(dest).includes('orchestration.json')) {
        fired = true;
        const e = new Error('injected proj write failure'); e.code = 'EACCES'; throw e;
      }
      return rename.apply(this, arguments);
    };
    fs.linkSync = function (source, dest) {
      if (!fired && String(dest).includes('orchestration.json')) {
        fired = true;
        const e = new Error('injected proj write failure'); e.code = 'EACCES'; throw e;
      }
      return link.apply(this, arguments);
    };
    let res;
    try { res = f.mgr.updateOrchestrationConfig({ swarmMode: 'off', expectedRevision: 'missing' }, { projectRoot: f.projectA }); }
    finally { fs.renameSync = rename; fs.linkSync = link; }
    assert.equal(fired, true);
    assert.equal(res.ok, false, JSON.stringify(res));
    // 无并发编辑时回滚应真正删除新建文件并诚实 true
    assert.equal(fs.existsSync(agentsMd), false, '新建 AGENTS.md 必须被回滚删除');
    assert.equal(res.rolledBack, true, '无并发时 rolledBack 应为 true: ' + JSON.stringify(res));
  }
  // 1b: 原文件不存在 + 回滚前并发追加 => 保留冲突文件且 rolledBack:false
  {
    const f = fixture(t);
    let st = f.mgr.getOrchestrationState({ hosts: [f.host] });
    assert.equal(f.mgr.updateOrchestrationConfig({ swarmMode: 'on', expectedRevision: st.modeRevision }, { hostRulePaths: [f.host] }).ok, true);
    const agentsMd = path.join(f.projectA, 'AGENTS.md');
    const rename = fs.renameSync, link = fs.linkSync; let fired = false;
    const inject = (dest) => {
      if (!fired && String(dest).includes('orchestration.json')) {
        fired = true;
        // 模拟并发用户在回滚前追加（同一 inode 追加）
        fs.appendFileSync(agentsMd, '\n# concurrent user edit\n');
        const e = new Error('injected proj write failure'); e.code = 'EACCES'; throw e;
      }
    };
    fs.renameSync = function (source, dest) { inject(dest); return rename.apply(this, arguments); };
    fs.linkSync = function (source, dest) { inject(dest); return link.apply(this, arguments); };
    let res;
    try { res = f.mgr.updateOrchestrationConfig({ swarmMode: 'off', expectedRevision: 'missing' }, { projectRoot: f.projectA }); }
    finally { fs.renameSync = rename; fs.linkSync = link; }
    assert.equal(fired, true);
    assert.equal(res.ok, false);
    assert.equal(fs.existsSync(agentsMd), true, '并发修改时必须保留冲突文件');
    assert.match(fs.readFileSync(agentsMd, 'utf8'), /concurrent user edit/);
    assert.equal(res.rolledBack, false, '并发修改时 rolledBack 必须诚实 false: ' + JSON.stringify(res));
  }
  // 1c: 原文件存在 + 回滚时同 inode 并发追加不得被旧正文覆盖
  {
    const f = fixture(t);
    let st = f.mgr.getOrchestrationState({ hosts: [f.host] });
    assert.equal(f.mgr.updateOrchestrationConfig({ swarmMode: 'on', expectedRevision: st.modeRevision }, { hostRulePaths: [f.host] }).ok, true);
    const agentsMd = path.join(f.projectA, 'AGENTS.md');
    fs.writeFileSync(agentsMd, '# 项目A 私有规则\n');
    const rename = fs.renameSync, link = fs.linkSync; let fired = false;
    const inject2 = (dest) => {
      if (!fired && String(dest).includes('orchestration.json')) {
        fired = true;
        fs.appendFileSync(agentsMd, '\n# parallel human edit\n');
        const e = new Error('injected proj write failure'); e.code = 'EACCES'; throw e;
      }
    };
    fs.renameSync = function (source, dest) { inject2(dest); return rename.apply(this, arguments); };
    fs.linkSync = function (source, dest) { inject2(dest); return link.apply(this, arguments); };
    let res;
    try { res = f.mgr.updateOrchestrationConfig({ swarmMode: 'off', expectedRevision: 'missing' }, { projectRoot: f.projectA }); }
    finally { fs.renameSync = rename; fs.linkSync = link; }
    assert.equal(res.ok, false);
    assert.match(fs.readFileSync(agentsMd, 'utf8'), /parallel human edit/, '并发追加不得被覆盖');
    assert.match(fs.readFileSync(agentsMd, 'utf8'), /# 项目A 私有规则/);
    assert.equal(res.rolledBack, false, '并发覆盖回滚必须 false: ' + JSON.stringify(res));
  }
});

test('R2 未托管 Skill：显式 false 优先 + 仅精确哈希授权接管', t => {
  // 2a: frontmatter t3_hub_managed:false + 正文 marker => 必须 skippedUnmanaged ไม่覆盖
  {
    const f = fixture(t);
    const hubSkill = skillPaths(f)[0];
    fs.mkdirSync(path.dirname(hubSkill), { recursive: true });
    const evil = '---\nname: t3-subagent-routing\ndescription: "user custom"\nt3_hub_managed: false\n---\n<!-- t3-hub-managed-skill -->\n用户自定义\n';
    fs.writeFileSync(hubSkill, evil);
    let st = f.mgr.getOrchestrationState({ hosts: [f.host] });
    const res = f.mgr.updateOrchestrationConfig({ swarmMode: 'on', expectedRevision: st.modeRevision }, { hostRulePaths: [f.host] });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(fs.readFileSync(hubSkill, 'utf8'), evil, '显式 false 文件不得覆盖');
    assert.ok(res.skillSync.skippedUnmanaged.includes(hubSkill), '应上报 skippedUnmanaged');
  }
  // 2b: 同名 + <SUBAGENT-STOP> 但无精确历史签名 => 不得接管
  {
    const f = fixture(t);
    const agentsSkill = skillPaths(f)[1];
    fs.mkdirSync(path.dirname(agentsSkill), { recursive: true });
    const userSameName = '---\nname: t3-subagent-routing\ndescription: "user same name"\n---\n<SUBAGENT-STOP>\nuser stop\n</SUBAGENT-STOP>\n我写的自定义路由\n';
    fs.writeFileSync(agentsSkill, userSameName);
    let st = f.mgr.getOrchestrationState({ hosts: [f.host] });
    const res = f.mgr.updateOrchestrationConfig({ swarmMode: 'on', expectedRevision: st.modeRevision }, { hostRulePaths: [f.host] });
    assert.equal(res.ok, true);
    assert.equal(fs.readFileSync(agentsSkill, 'utf8'), userSameName, '同名但无精确历史签名不得接管');
    assert.equal(fs.existsSync(agentsSkill + '.bak-t3hub'), false, '未接管文件不得生成备份');
    assert.ok(res.skillSync.skippedUnmanaged.includes(agentsSkill));
  }
  // 2c: 精确哈希授权 => 接管并备份
  {
    const f = fixture(t);
    const agentsSkill = skillPaths(f)[1];
    fs.mkdirSync(path.dirname(agentsSkill), { recursive: true });
    fs.writeFileSync(agentsSkill, LEGACY_SKILL);
    let st = f.mgr.getOrchestrationState({ hosts: [f.host] });
    const res = f.mgr.updateOrchestrationConfig({ swarmMode: 'on', expectedRevision: st.modeRevision }, { hostRulePaths: [f.host], adoptUnmanagedSkillHashes: { [agentsSkill]: sha256(LEGACY_SKILL) } });
    assert.equal(res.ok, true);
    assert.equal(fs.existsSync(agentsSkill + '.bak-t3hub'), true);
    assert.match(fs.readFileSync(agentsSkill, 'utf8'), /t3_hub_managed: true/);
  }
});

test('R3 saveSubagent/deleteSubagent 与 SKILL 同事务：SKILL 失败必须全回滚', t => {
  const f = fixture(t);
  let st = f.mgr.getOrchestrationState({ hosts: [f.host] });
  assert.equal(f.mgr.updateOrchestrationConfig({ swarmMode: 'on', expectedRevision: st.modeRevision }, { hostRulePaths: [f.host] }).ok, true);
  const beforeConfig = fs.readFileSync(path.join(f.hub, 'subagents.json'));
  const beforeHost = fs.readFileSync(f.host);
  const beforeSkills = skillPaths(f).map(p => fs.readFileSync(p));
  const beforeActive = fs.readFileSync(path.join(f.hub, 'ACTIVE_ORCHESTRATION_MODE.md'));
  const rename = fs.renameSync; let fired = false;
  const targetHubSkill = skillPaths(f)[0];
  fs.renameSync = function (source, dest) {
    if (!fired && source === targetHubSkill && String(dest).includes('.stage-')) {
      fired = true;
      const e = new Error('injected skill failure'); e.code = 'EACCES'; throw e;
    }
    return rename.apply(this, arguments);
  };
  let threw = null, res = null;
  try { res = f.mgr.saveSubagent({ scope: 'global', item: { id: 'code-review', effort: 'high' } }); }
  catch (e) { threw = e; }
  finally { fs.renameSync = rename; }
  assert.equal(fired, true, '必须触发 SKILL 注入');
  const failed = threw !== null || (res && res.ok === false);
  assert.equal(failed, true, 'SKILL 失败时 saveSubagent 必须失败而非 ok:true: threw=' + String(threw && threw.message) + ' res=' + JSON.stringify(res));
  assert.deepEqual(fs.readFileSync(path.join(f.hub, 'subagents.json')), beforeConfig, 'subagents.json 必须回滚');
  assert.deepEqual(fs.readFileSync(f.host), beforeHost, '全局规则块必须回滚');
  assert.deepEqual(fs.readFileSync(path.join(f.hub, 'ACTIVE_ORCHESTRATION_MODE.md')), beforeActive);
  skillPaths(f).forEach((p, i) => assert.deepEqual(fs.readFileSync(p), beforeSkills[i], p + ' 必须回滚'));
});

test('R4 scope:project 缺失/无效 projectRoot 禁止降级误改全局 + 显式 global 不误走项目', t => {
  // 4a: patch scope project 无 projectRoot
  {
    const f = fixture(t);
    let st0 = f.mgr.getOrchestrationState({ hosts: [f.host] });
    assert.equal(f.mgr.updateOrchestrationConfig({ swarmMode: 'off', expectedRevision: st0.modeRevision }, { hostRulePaths: [f.host] }).ok, true);
    const beforeConfig = fs.readFileSync(path.join(f.hub, 'orchestration-config.json'));
    assert.throws(() => f.mgr.updateOrchestrationConfig({ scope: 'project', swarmMode: 'on' }), /projectRoot|project/);
    assert.deepEqual(fs.readFileSync(path.join(f.hub, 'orchestration-config.json')), beforeConfig, '全局配置不得被误改');
  }
  // 4b: opts projectRoot 空白
  {
    const f = fixture(t);
    assert.throws(() => f.mgr.updateOrchestrationConfig({ swarmMode: 'on' }, { projectRoot: '   ' }), /projectRoot/);
  }
  // 4c: opts scope project 不存在目录
  {
    const f = fixture(t);
    const ghost = path.join(f.home, 'no-such-dir-xyz');
    assert.throws(() => f.mgr.updateOrchestrationConfig({ swarmMode: 'on' }, { scope: 'project', projectRoot: ghost }), /projectRoot|不存在|已存在/);
    assert.equal(fs.existsSync(ghost), false, '不存在的 projectRoot 不得凭空创建');
  }
  // 4d: 显式 global 即使带 projectRoot 也不误走项目分支
  {
    const f = fixture(t);
    let st = f.mgr.getOrchestrationState({ hosts: [f.host] });
    assert.equal(f.mgr.updateOrchestrationConfig({ swarmMode: 'on', expectedRevision: 'missing' }, { projectRoot: f.projectA }).ok, true, '无 scope 的 projectRoot 视为项目意图');
    // projectA 已写项目覆盖；再用显式 global 更新不得触碰项目文件
    const projFile = findProjFile(f);
    assert.ok(projFile);
    const projBefore = fs.readFileSync(projFile);
    st = f.mgr.getOrchestrationState({ hosts: [f.host] });
    const res = f.mgr.updateOrchestrationConfig({ scope: 'global', swarmMode: 'off', expectedRevision: st.modeRevision }, { scope: 'global', projectRoot: f.projectA, hostRulePaths: [f.host] });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.deepEqual(fs.readFileSync(projFile), projBefore, '显式 global 不得误写项目覆盖');
    assert.equal(f.mgr.getOrchestrationState({ hosts: [f.host] }).swarmMode, 'off');
  }
});

test('R5 符号链接祖先：TMPDIR 本身为链接时必须拒绝（仅 /tmp->/private/tmp 与 /var->/private/var 例外）', t => {
  const origTmp = os.tmpdir();
  const real = fs.mkdtempSync(path.join(origTmp, 'hub-real-tmp-'));
  const link = path.join(origTmp, 'hub-link-tmp-' + process.pid + '-' + Date.now());
  fs.symlinkSync(real, link);
  const prevTmp = process.env.TMPDIR;
  process.env.TMPDIR = link;
  try {
    assert.equal(os.tmpdir(), link, 'os.tmpdir 应返回链接路径');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-skill-link-'));
    const hub = path.join(home, '.t3/hub');
    fs.mkdirSync(hub, { recursive: true });
    fs.writeFileSync(path.join(hub, 'subagents.json'), JSON.stringify(DEFAULT_SUBAGENTS.map(x => ({ ...x })), null, 2) + '\n');
    fs.writeFileSync(path.join(home, 'AGENTS.md'), '# user\n');
    const mgr = createSubagentsManager({ homeDir: home, hubDir: hub });
    let threw = false;
    try {
      const st = mgr.getOrchestrationState({ hosts: [path.join(home, 'AGENTS.md')] });
      mgr.updateOrchestrationConfig({ swarmMode: 'on', expectedRevision: st.modeRevision }, { hostRulePaths: [path.join(home, 'AGENTS.md')] });
    } catch (e) {
      threw = /symlink|unsafe/.test(String(e && e.message));
    }
    assert.equal(threw, true, '经由链接 TMPDIR 的文件操作必须被拒绝');
    fs.rmSync(home, { recursive: true, force: true });
  } finally {
    if (prevTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prevTmp;
    try { fs.unlinkSync(link); } catch {}
    try { fs.rmSync(real, { recursive: true, force: true }); } catch {}
  }
});

test('R6 Skill 异常与预检后 CAS：不可读/特殊文件/枚举错/并发篡改必须失败回滚', t => {
  // 6a/6b: 不可读与目录型 Skill 必须使事务失败
  for (const kind of ['unreadable', 'directory']) {
    const f = fixture(t);
    let st = f.mgr.getOrchestrationState({ hosts: [f.host] });
    assert.equal(f.mgr.updateOrchestrationConfig({ swarmMode: 'off', expectedRevision: st.modeRevision }, { hostRulePaths: [f.host] }).ok, true);
    const hubSkill = skillPaths(f)[0];
    fs.mkdirSync(path.dirname(hubSkill), { recursive: true });
    if (kind === 'unreadable') {
      fs.writeFileSync(hubSkill, '---\nname: user\n---\ncustom\n');
      fs.chmodSync(hubSkill, 0o000);
    } else {
      fs.rmSync(hubSkill, { force: true });
      fs.mkdirSync(hubSkill, { recursive: true });
    }
    const beforeHost = fs.readFileSync(f.host);
    const beforeConfig = fs.readFileSync(path.join(f.hub, 'orchestration-config.json'));
    st = f.mgr.getOrchestrationState({ hosts: [f.host] });
    let res = null, threw = null;
    try { res = f.mgr.updateOrchestrationConfig({ swarmMode: 'on', expectedRevision: st.modeRevision }, { hostRulePaths: [f.host] }); }
    catch (e) { threw = e; }
    if (kind === 'unreadable') { try { fs.chmodSync(hubSkill, 0o644); } catch {} }
    const failed = threw !== null || (res && res.ok === false);
    assert.equal(failed, true, kind + ' 必须使事务失败而非 skippedUnmanaged 成功: threw=' + String(threw && threw.message) + ' res=' + JSON.stringify(res));
    assert.deepEqual(fs.readFileSync(f.host), beforeHost, kind + ' 失败时宿主必须回滚');
    assert.deepEqual(fs.readFileSync(path.join(f.hub, 'orchestration-config.json')), beforeConfig);
    if (kind === 'directory') { try { fs.rmSync(hubSkill, { recursive: true, force: true }); } catch {} }
  }
  // 6c: AGY 枚举错误不得静默截断
  {
    const f = fixture(t);
    let st = f.mgr.getOrchestrationState({ hosts: [f.host] });
    assert.equal(f.mgr.updateOrchestrationConfig({ swarmMode: 'off', expectedRevision: st.modeRevision }, { hostRulePaths: [f.host] }).ok, true);
    // 状态查询本来就会枚举 AGY；先读 revision，再分别注入查询和更新异常。
    const s2 = f.mgr.getOrchestrationState({ hosts: [f.host] });
    const before = new Map([f.host, path.join(f.hub, 'orchestration-config.json'),
      path.join(f.hub, 'ACTIVE_ORCHESTRATION_MODE.md'), ...skillPaths(f)].map(p => [p, fs.readFileSync(p)]));
    const readdir = fs.readdirSync; let fired = false;
    fs.readdirSync = function (p, ...rest) {
      if (!fired && String(p).includes(path.join('providers', 'antigravity'))) {
        fired = true;
        const e = new Error('injected readdir failure'); e.code = 'EACCES'; throw e;
      }
      return readdir.apply(this, arguments);
    };
    let res = null, threw = null;
    try {
      const unreadable = f.mgr.getOrchestrationState({ hosts: [f.host] });
      assert.equal(fired, true, '状态查询应命中独立的一次枚举异常');
      assert.equal(unreadable.modeApplied, false);
      assert.equal(unreadable.skillsApplied, false);
      assert.ok(unreadable.hostResults.some(r => r.path === 'agy-provider-tree' && r.state === 'unknown'));
      fired = false; // 重新武装，确保下面的失败确实来自更新预检。
      try { res = f.mgr.updateOrchestrationConfig({ swarmMode: 'on', expectedRevision: s2.modeRevision }, { hostRulePaths: [f.host] }); }
      catch (e) { threw = e; }
    } finally { fs.readdirSync = readdir; }
    assert.equal(fired, true, '更新预检必须独立命中枚举异常');
    const failed = threw !== null || (res && res.ok === false);
    assert.equal(failed, true, 'AGY 枚举错误不得静默截断: threw=' + String(threw && threw.message) + ' res=' + JSON.stringify(res));
    assert.match(threw?.message || res.error, /AGY.*枚举失败.*injected readdir failure/);
    if (res) {
      assert.equal(res.rolledBack, true);
      assert.deepEqual(res.rollbackFailures, []);
    }
    for (const [p, content] of before) assert.deepEqual(fs.readFileSync(p), content, p + ' 枚举失败不得发布任何改动');
    // 恢复后目录应可读
    fs.readdirSync(path.join(f.home, '.t3/userdata/providers/antigravity'));
  }
  // 6d: 预检后并发替换为未托管文件 => CAS 冲突回滚
  {
    const f = fixture(t);
    let st = f.mgr.getOrchestrationState({ hosts: [f.host] });
    assert.equal(f.mgr.updateOrchestrationConfig({ swarmMode: 'off', expectedRevision: st.modeRevision }, { hostRulePaths: [f.host] }).ok, true);
    st = f.mgr.getOrchestrationState({ hosts: [f.host] });
    const beforeHost = fs.readFileSync(f.host);
    const beforeConfig = fs.readFileSync(path.join(f.hub, 'orchestration-config.json'));
    const hubSkill = skillPaths(f)[0];
    const rename = fs.renameSync; let fired = false;
    fs.renameSync = function (source, dest) {
      // 在首次宿主写入（active stage）时并发篡改 hub SKILL 为未托管
      if (!fired && String(dest).includes('ACTIVE_ORCHESTRATION_MODE') && String(dest).includes('.stage-')) {
        fired = true;
        fs.writeFileSync(hubSkill, '---\nname: user\n---\nconcurrent unmanaged\n');
      }
      return rename.apply(this, arguments);
    };
    let res = null, threw = null;
    try { res = f.mgr.updateOrchestrationConfig({ swarmMode: 'on', expectedRevision: st.modeRevision }, { hostRulePaths: [f.host] }); }
    catch (e) { threw = e; }
    finally { fs.renameSync = rename; }
    // 注入点可能在 active 或 host stage；若未触发则视为测试未命中，重试逻辑：断言 fired 必须 true
    assert.equal(fired, true, '并发篡改注入必须触发');
    const failed = threw !== null || (res && res.ok === false);
    assert.equal(failed, true, '预检后并发替换必须 CAS 冲突回滚: threw=' + String(threw && threw.message) + ' res=' + JSON.stringify(res));
    assert.deepEqual(fs.readFileSync(f.host), beforeHost, '并发篡改时宿主必须回滚');
    assert.deepEqual(fs.readFileSync(path.join(f.hub, 'orchestration-config.json')), beforeConfig);
    // hub SKILL 保持并发未托管内容（不得被静默覆盖）
    assert.match(fs.readFileSync(hubSkill, 'utf8'), /concurrent unmanaged/);
  }
});

test('R7 项目级 expectedRevision CAS：revision 暴露与错版拒绝', t => {
  const f = fixture(t);
  let st = f.mgr.getOrchestrationState({ hosts: [f.host] });
  assert.equal(f.mgr.updateOrchestrationConfig({ swarmMode: 'on', expectedRevision: st.modeRevision }, { hostRulePaths: [f.host] }).ok, true);
  // 首次项目写入并读取 revision
  const r1 = f.mgr.updateOrchestrationConfig({ swarmMode: 'off', expectedRevision: 'missing' }, { projectRoot: f.projectA });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  const stateA = f.mgr.getOrchestrationState({ projectRoot: f.projectA });
  const rev = stateA.projectOverride.revision || stateA.projectOverride.projectModeRevision || stateA.projectModeRevision || r1.projectModeRevision;
  assert.ok(rev && rev !== 'missing', '项目状态必须暴露确定性 revision: ' + JSON.stringify(stateA.projectOverride));
  const projFile = findProjFile(f);
  assert.ok(projFile);
  const before = fs.readFileSync(projFile);
  // 错版必须拒绝
  let threw = null, res2 = null;
  try { res2 = f.mgr.updateOrchestrationConfig({ swarmMode: 'on', expectedRevision: 'deadbeef-stale' }, { projectRoot: f.projectA }); }
  catch (e) { threw = e; }
  const rejected = threw !== null || (res2 && res2.ok === false);
  assert.equal(rejected, true, '错版 expectedRevision 必须拒绝: threw=' + String(threw && threw.message) + ' res=' + JSON.stringify(res2));
  assert.deepEqual(fs.readFileSync(projFile), before, '错版不得覆盖');
  // 对版应成功
  const rOk = f.mgr.updateOrchestrationConfig({ swarmMode: 'on', expectedRevision: rev }, { projectRoot: f.projectA });
  assert.equal(rOk.ok, true, JSON.stringify(rOk));
  assert.notEqual(fs.readFileSync(projFile, 'utf8'), before.toString('utf8'));
});

test('R8 接管 .bak-t3hub：事务回滚后清理新建备份', t => {
  const f = fixture(t);
  let st0 = f.mgr.getOrchestrationState({ hosts: [f.host] });
  assert.equal(f.mgr.updateOrchestrationConfig({ swarmMode: 'off', expectedRevision: st0.modeRevision }, { hostRulePaths: [f.host] }).ok, true);
  const agentsSkill = skillPaths(f)[1];
  fs.mkdirSync(path.dirname(agentsSkill), { recursive: true });
  fs.writeFileSync(agentsSkill, LEGACY_SKILL);
  const beforeLegacy = fs.readFileSync(agentsSkill);
  try { fs.unlinkSync(agentsSkill + '.bak-t3hub'); } catch {}
  let st = f.mgr.getOrchestrationState({ hosts: [f.host] });
  // 让 hub SKILL（排序后在某些系统可能先处理）失败，触发整事务回滚
  const hubSkill = skillPaths(f)[0];
  const rename = fs.renameSync; let fired = false;
  fs.renameSync = function (source, dest) {
    if (!fired && source === hubSkill && String(dest).includes('.stage-')) {
      // 确保 agentsSkill 已先备份接管（若排序 hub 先行，则等待 agents 处理完再失败也需失败一次即可断言回滚后 bak 清理）
      // 仅失败 hub 目标即可触发回滚；agents 的 bak 若已创建应在回滚后清理
      fired = true;
      const e = new Error('injected failure after legacy backup'); e.code = 'EACCES'; throw e;
    }
    return rename.apply(this, arguments);
  };
  let res;
  try { res = f.mgr.updateOrchestrationConfig({ swarmMode: 'on', expectedRevision: st.modeRevision }, { hostRulePaths: [f.host], adoptUnmanagedSkillHashes: { [agentsSkill]: sha256(LEGACY_SKILL) } }); }
  finally { fs.renameSync = rename; }
  assert.equal(fired, true);
  assert.equal(res.ok, false, JSON.stringify(res));
  // 若 agentsSkill 曾被接管，其 SKILL 已恢复为 legacy，备份必须清理
  const bak = agentsSkill + '.bak-t3hub';
  const skillNow = fs.readFileSync(agentsSkill);
  if (skillNow.equals(beforeLegacy)) {
    assert.equal(fs.existsSync(bak), false, '回滚后新建 .bak-t3hub 必须清理');
  } else {
    // 若排序导致 agents 未处理（hub 先失败），则 bak 本就不应存在
    assert.equal(fs.existsSync(bak), false, '未产生接管时 bak 不得残留: ' + JSON.stringify(res));
  }
});

test('R9 子目录 projectRuleSynced 查项目根而非子目录', t => {
  const f = fixture(t);
  let st = f.mgr.getOrchestrationState({ hosts: [f.host] });
  assert.equal(f.mgr.updateOrchestrationConfig({ swarmMode: 'on', expectedRevision: st.modeRevision }, { hostRulePaths: [f.host] }).ok, true);
  // 给项目A建 .git 并写入 OFF 覆盖
  fs.mkdirSync(path.join(f.projectA, '.git'), { recursive: true });
  const agentsA = path.join(f.projectA, 'AGENTS.md');
  fs.writeFileSync(agentsA, '# 项目A 私有规则\n');
  const rA = f.mgr.updateOrchestrationConfig({ swarmMode: 'off', expectedRevision: 'missing' }, { projectRoot: f.projectA });
  assert.equal(rA.ok, true, JSON.stringify(rA));
  const sub = path.join(f.projectA, 'src', 'deep');
  fs.mkdirSync(sub, { recursive: true });
  const stateSub = f.mgr.getOrchestrationState({ projectRoot: sub });
  assert.equal(stateSub.projectOverride.swarmMode, 'off', '子目录应向上定位到项目覆盖: ' + JSON.stringify(stateSub.projectOverride));
  assert.equal(stateSub.projectOverride.projectRuleSynced, true, '子目录查询 projectRuleSynced 应查项目根 AGENTS.md: ' + JSON.stringify(stateSub.projectOverride));
});

test('R10 宿主 Skill 不可读/特殊文件不得伪造空哈希', t => {
  const f = fixture(t);
  let st = f.mgr.getOrchestrationState({ hosts: [f.host] });
  assert.equal(f.mgr.updateOrchestrationConfig({ swarmMode: 'on', expectedRevision: st.modeRevision }, { hostRulePaths: [f.host] }).ok, true);
  const agentsSkill = path.join(f.home, '.agents/skills/t3-subagent-routing/SKILL.md');
  const emptyHash = crypto.createHash('sha256').update('', 'utf8').digest('hex');
  // 场景一：不可读
  fs.chmodSync(agentsSkill, 0o000);
  let hsm = createHostSettingsManager({ homeDir: f.home, hubDir: f.hub });
  let snap = typeof hsm.getAntigravitySnapshot === 'function' ? hsm.getAntigravitySnapshot() : hsm.getSettingsSnapshot().antigravity;
  let entry = snap.routingSkills.find(x => x.path === agentsSkill);
  assert.ok(entry, '应含 .agents SKILL 条目');
  assert.notEqual(entry.sha256, emptyHash, '不可读文件不得伪造空哈希');
  assert.equal(entry.sha256, null);
  assert.equal(entry.managed, false);
  assert.ok(entry.error, '应暴露脱敏错误码');
  assert.match(entry.error, /unreadable|non_regular|symlink/);
  fs.chmodSync(agentsSkill, 0o444);
  // 场景二：目录型特殊文件
  fs.rmSync(agentsSkill);
  fs.mkdirSync(agentsSkill, { recursive: true });
  hsm = createHostSettingsManager({ homeDir: f.home, hubDir: f.hub });
  snap = typeof hsm.getAntigravitySnapshot === 'function' ? hsm.getAntigravitySnapshot() : hsm.getSettingsSnapshot().antigravity;
  entry = snap.routingSkills.find(x => x.path === agentsSkill);
  assert.equal(entry.sha256, null);
  assert.equal(entry.managed, false);
  assert.match(entry.error, /unreadable|non_regular|symlink/);
  fs.rmSync(agentsSkill, { recursive: true, force: true });
});

test('R11 全局 subagents.json 损坏不得静默默认覆盖 Skill', t => {
  const f = fixture(t);
  let st = f.mgr.getOrchestrationState({ hosts: [f.host] });
  assert.equal(f.mgr.updateOrchestrationConfig({ swarmMode: 'off', expectedRevision: st.modeRevision }, { hostRulePaths: [f.host] }).ok, true);
  const beforeSkills = skillPaths(f).map(p => fs.readFileSync(p));
  const beforeHost = fs.readFileSync(f.host);
  const beforeConfig = fs.readFileSync(path.join(f.hub, 'orchestration-config.json'));
  fs.writeFileSync(path.join(f.hub, 'subagents.json'), '{invalid json!!!');
  st = f.mgr.getOrchestrationState({ hosts: [f.host] });
  let res = null, threw = null;
  try { res = f.mgr.updateOrchestrationConfig({ swarmMode: 'on', expectedRevision: st.modeRevision }, { hostRulePaths: [f.host] }); }
  catch (e) { threw = e; }
  const failed = threw !== null || (res && res.ok === false);
  assert.equal(failed, true, 'subagents.json 损坏必须中止事务而非默认覆盖: threw=' + String(threw && threw.message) + ' res=' + JSON.stringify(res));
  assert.deepEqual(fs.readFileSync(f.host), beforeHost, '损坏时宿主不得被改写');
  assert.deepEqual(fs.readFileSync(path.join(f.hub, 'orchestration-config.json')), beforeConfig);
  skillPaths(f).forEach((p, i) => assert.deepEqual(fs.readFileSync(p), beforeSkills[i], p + ' 损坏时不得被默认覆盖'));
});

// ---- worker-pro: 九项审查缺陷的故障注入回归（不连接真实宿主） ----
function setGlobalMode(f, mode) {
  const state = f.mgr.getOrchestrationState({ hosts: [f.host] });
  return f.mgr.updateOrchestrationConfig({ swarmMode: mode, expectedRevision: state.modeRevision }, { hostRulePaths: [f.host] });
}
function prepareRoleMutation(f, operation) {
  if (operation !== 'delete') return;
  const file = path.join(f.hub, 'subagents.json'), raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Resetting a built-in must actually change a route so publication faults fire.
  raw.find(x => x.id === 'code-review').effort = 'low';
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n');
}
function roleMutation(f, operation, extra = {}) {
  return operation === 'save'
    ? f.mgr.saveSubagent({ scope: 'global', item: { id: 'code-review', effort: 'high' }, ...extra })
    : f.mgr.deleteSubagent({ scope: 'global', id: 'code-review', ...extra });
}
function captureError(fn) { try { fn(); } catch (e) { return e; } return null; }
function injectedError() { return Object.assign(new Error('injected EACCES'), { code: 'EACCES' }); }

test('N1 无 true frontmatter 的旧标题、正文 marker 与自定义 Skill 均逐字节跳过；错误哈希不授权', t => {
  for (const content of [LEGACY_SKILL + '\n# custom route\n', '<!-- managed-by: t3-hub -->\nuser\n',
    '---\nname: t3-subagent-routing\n---\n<!-- t3-hub-managed-skill -->\nuser\n']) {
    const f = fixture(t), file = skillPaths(f)[1];
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
    const result = f.mgr.syncRoutingSkillTargets({ adoptUnmanagedSkillHashes: { [file]: '0'.repeat(64) } });
    assert.equal(result.ok, true);
    assert.equal(fs.readFileSync(file, 'utf8'), content);
    assert.ok(result.skippedUnmanaged.includes(file));
    assert.equal(fs.existsSync(file + '.bak-t3hub'), false);
  }
});

test('N2 save/delete 在 subagents.json 发布前使用同一预检快照 CAS，保留并发 worker 提示词', t => {
  for (const operation of ['save', 'delete']) {
    const f = fixture(t); prepareRoleMutation(f, operation); assert.equal(setGlobalMode(f, 'off').ok, true);
    const file = path.join(f.hub, 'subagents.json'), skills = skillPaths(f).map(p => fs.readFileSync(p));
    const open = fs.openSync; let fired = false;
    fs.openSync = function(p) {
      if (!fired && (p === file + '.t3hub.lock' || String(p).startsWith(file + '.tmp-'))) {
        fired = true; const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        raw.find(x => x.id === 'worker').systemPrompt = 'CONCURRENT-WORKER-PROMPT';
        fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n');
      }
      return open.apply(this, arguments);
    };
    let error;
    try { error = captureError(() => roleMutation(f, operation)); } finally { fs.openSync = open; }
    assert.equal(fired, true); assert.ok(error, operation + ' must reject stale preflight');
    assert.match(fs.readFileSync(file, 'utf8'), /CONCURRENT-WORKER-PROMPT/);
    skillPaths(f).forEach((p, i) => assert.deepEqual(fs.readFileSync(p), skills[i]));
  }
});

test('N3 save/delete 将 Skill 预检计划原样交给写入阶段，保护并发追加正文', t => {
  for (const operation of ['save', 'delete']) {
    const f = fixture(t); prepareRoleMutation(f, operation); assert.equal(setGlobalMode(f, 'off').ok, true);
    const file = path.join(f.hub, 'subagents.json'), before = fs.readFileSync(file), skill = skillPaths(f)[0];
    const rename = fs.renameSync, link = fs.linkSync; let fired = false;
    const mutate = dest => { if (!fired && dest === file) { fired = true; fs.appendFileSync(skill, '\nCONCURRENT-SKILL-APPEND\n'); } };
    fs.renameSync = function(src, dest) { const r = rename.apply(this, arguments); mutate(dest); return r; };
    fs.linkSync = function(src, dest) { const r = link.apply(this, arguments); mutate(dest); return r; };
    let error;
    try { error = captureError(() => roleMutation(f, operation)); } finally { fs.renameSync = rename; fs.linkSync = link; }
    assert.equal(fired, true); assert.ok(error, operation + ' must reject changed Skill');
    assert.match(fs.readFileSync(skill, 'utf8'), /CONCURRENT-SKILL-APPEND/);
    assert.deepEqual(fs.readFileSync(file), before);
  }
});

test('N4 项目发布后回读持续 EACCES 必须报告具体回滚失败，不能静默 rolledBack:true', t => {
  const f = fixture(t);
  const initRes = f.mgr.updateOrchestrationConfig({ swarmMode: 'off', expectedRevision: 'missing' }, { projectRoot: f.projectA });
  assert.equal(initRes.ok, true);
  const file = findProjFile(f), link = fs.linkSync, open = fs.openSync, read = fs.readFileSync;
  let published = false, fired = false;
  fs.linkSync = function(src, dest) { const r = link.apply(this, arguments); if (dest === file) published = true; return r; };
  fs.openSync = function(p) { if (published && p === file) { fired = true; throw injectedError(); } return open.apply(this, arguments); };
  fs.readFileSync = function(p) { if (published && p === file) { fired = true; throw injectedError(); } return read.apply(this, arguments); };
  let result;
  try { result = f.mgr.updateOrchestrationConfig({ swarmMode: 'on', expectedRevision: initRes.projectModeRevision }, { projectRoot: f.projectA }); }
  finally { fs.linkSync = link; fs.openSync = open; fs.readFileSync = read; }
  assert.equal(fired, true); assert.equal(result.ok, false); assert.equal(result.rolledBack, false, JSON.stringify(result));
  assert.ok(result.rollbackFailures.some(x => x.path === file));
});

test('N5 save/delete 在发布时登记 journal，回读暂时失败可回滚；并发冲突失败必须附 rollbackFailures', t => {
  for (const operation of ['save', 'delete']) {
    const f = fixture(t); prepareRoleMutation(f, operation); assert.equal(setGlobalMode(f, 'off').ok, true);
    const file = path.join(f.hub, 'subagents.json'), before = fs.readFileSync(file);
    const rename = fs.renameSync, link = fs.linkSync, open = fs.openSync; let published = false, fired = false;
    fs.renameSync = function(src, dest) { const r = rename.apply(this, arguments); if (dest === file) published = true; return r; };
    fs.linkSync = function(src, dest) { const r = link.apply(this, arguments); if (dest === file) published = true; return r; };
    fs.openSync = function(p) { if (p === file && published && !fired) { fired = true; throw injectedError(); } return open.apply(this, arguments); };
    let error;
    try { error = captureError(() => roleMutation(f, operation)); } finally { fs.renameSync = rename; fs.linkSync = link; fs.openSync = open; }
    assert.equal(fired, true); assert.ok(error); assert.deepEqual(fs.readFileSync(file), before, 'published config must roll back');
    assert.equal(error.rolledBack, true);
  }
  for (const operation of ['save', 'delete']) {
    const f = fixture(t); prepareRoleMutation(f, operation); assert.equal(setGlobalMode(f, 'off').ok, true);
    const host = path.join(f.hub, 'global-AGENTS.md'), skill = skillPaths(f)[0], rename = fs.renameSync;
    let fired = false;
    fs.renameSync = function(src, dest) {
      if (!fired && src === skill && String(dest).includes('.stage-')) {
        fired = true; fs.appendFileSync(host, '\nCONCURRENT-HOST-EDIT\n'); throw injectedError();
      }
      return rename.apply(this, arguments);
    };
    let error;
    try { error = captureError(() => roleMutation(f, operation)); } finally { fs.renameSync = rename; }
    assert.equal(fired, true); assert.ok(error); assert.equal(error.rolledBack, false);
    assert.ok(error.rollbackFailures.some(x => x.path === host));
    assert.match(error.message, /部分.*回滚|部分.*恢复/); assert.ok(error.message.includes(host));
    assert.match(fs.readFileSync(host, 'utf8'), /CONCURRENT-HOST-EDIT/);
  }
});

test('N6 subagents.json 目录、symlink 或 lstat EACCES/EPERM/EIO 一律中止，绝不使用默认路由覆盖 Skill', t => {
  for (const kind of ['directory', 'symlink', 'EACCES', 'EPERM', 'EIO']) {
    const f = fixture(t); assert.equal(setGlobalMode(f, 'off').ok, true);
    const file = path.join(f.hub, 'subagents.json'), before = skillPaths(f).map(p => fs.readFileSync(p)), host = fs.readFileSync(f.host);
    if (kind === 'directory') { fs.unlinkSync(file); fs.mkdirSync(file); }
    if (kind === 'symlink') { fs.renameSync(file, file + '.original'); fs.symlinkSync(file + '.original', file); }
    const lstat = fs.lstatSync;
    fs.lstatSync = function(p) { if (p === file && !['directory', 'symlink'].includes(kind)) throw Object.assign(new Error('injected ' + kind), { code: kind }); return lstat.apply(this, arguments); };
    let result, error;
    try {
      error = captureError(() => { result = setGlobalMode(f, 'on'); });
      assert.ok(error || result.ok === false, kind);
      assert.ok(captureError(() => f.mgr.listSubagents({})), kind + ' readGlobal');
      assert.ok(captureError(() => f.mgr.resolveSubagentRoute({ idOrTitle: 'worker' })), kind + ' resolve');
    } finally { fs.lstatSync = lstat; }
    skillPaths(f).forEach((p, i) => assert.deepEqual(fs.readFileSync(p), before[i]));
    assert.deepEqual(fs.readFileSync(f.host), host);
  }
});

test('N7 项目文件释放锁后并发改成 off 必须被 afterRev 检出，保留外部改动并报告冲突', t => {
  const f = fixture(t);
  const initRes = f.mgr.updateOrchestrationConfig({ swarmMode: 'off', expectedRevision: 'missing' }, { projectRoot: f.projectA });
  assert.equal(initRes.ok, true);
  const file = findProjFile(f), unlink = fs.unlinkSync; let fired = false;
  fs.unlinkSync = function(p) {
    const r = unlink.apply(this, arguments);
    if (!fired && p === file + '.t3hub.lock') { fired = true; fs.writeFileSync(file, '{"swarmMode":"off","external":true}\n'); }
    return r;
  };
  let result;
  try { result = f.mgr.updateOrchestrationConfig({ swarmMode: 'on', expectedRevision: initRes.projectModeRevision }, { projectRoot: f.projectA }); } finally { fs.unlinkSync = unlink; }
  assert.equal(fired, true); assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.rolledBack, false); assert.ok(result.rollbackFailures.some(x => x.path === file));
  assert.match(fs.readFileSync(file, 'utf8'), /external/);
});

test('N8 精确哈希接管写入前失败，save/delete/模式切换/直接同步均清理本次备份；外部修改备份保留', t => {
  for (const operation of ['save', 'delete', 'mode', 'direct', 'changed-backup']) {
    const f = fixture(t); prepareRoleMutation(f, operation); assert.equal(setGlobalMode(f, 'off').ok, true);
    const skill = skillPaths(f)[1], bak = skill + '.bak-t3hub'; fs.writeFileSync(skill, LEGACY_SKILL);
    const rename = fs.renameSync; let fired = false;
    fs.renameSync = function(src, dest) {
      if (!fired && src === skill && String(dest).includes('.stage-')) {
        fired = true; assert.equal(fs.existsSync(bak), true, 'adoption requires backup');
        if (operation === 'changed-backup') fs.appendFileSync(bak, '\nEXTERNAL-BACKUP-EDIT\n');
        throw injectedError();
      }
      return rename.apply(this, arguments);
    };
    const extra = { adoptUnmanagedSkillHashes: { [skill]: sha256(LEGACY_SKILL) } }; let result, error;
    try {
      error = captureError(() => {
        if (operation === 'mode') {
          const st = f.mgr.getOrchestrationState({ hosts: [f.host] });
          result = f.mgr.updateOrchestrationConfig({ swarmMode: 'on', expectedRevision: st.modeRevision }, { hostRulePaths: [f.host], ...extra });
        } else if (['direct', 'changed-backup'].includes(operation)) result = f.mgr.syncRoutingSkillTargets(extra);
        else result = roleMutation(f, operation, extra);
      });
    } finally { fs.renameSync = rename; }
    assert.equal(fired, true, operation); assert.ok(error || result.ok === false, operation);
    assert.equal(fs.readFileSync(skill, 'utf8'), LEGACY_SKILL);
    if (operation === 'changed-backup') assert.match(fs.readFileSync(bak, 'utf8'), /EXTERNAL-BACKUP-EDIT/);
    else assert.equal(fs.existsSync(bak), false, operation + ': no new backup residue');
  }
});

test('N9 宿主快照与同步共用严格 YAML 托管规则，false/缺失/重复/引号 true/正文标记不能伪报 managed', t => {
  const f = fixture(t), skill = skillPaths(f)[1]; fs.mkdirSync(path.dirname(skill), { recursive: true });
  const hsm = createHostSettingsManager({ homeDir: f.home, hubDir: f.hub });
  for (const [header, managed] of [
    ['t3_hub_managed: false', false], ['', false], ['t3_hub_managed: "true"', false],
    ['t3_hub_managed: true\nt3_hub_managed: false', false], ['description: |\n  t3_hub_managed: true', false],
    ['t3_hub_managed: true # owned', true], ['"t3_hub_managed": true', true],
  ]) {
    const text = '---\nname: t3-subagent-routing\n' + header + '\n---\n<!-- t3-hub-managed-skill -->\nt3_hub_managed: true\n';
    fs.writeFileSync(skill, text);
    const entry = hsm.getAntigravitySnapshot().routingSkills.find(x => x.path === skill);
    assert.equal(entry.managed, managed, header); assert.equal(entry.sha256, sha256(text));
    const res = f.mgr.syncRoutingSkillTargets(); assert.equal(res.ok, true);
    if (!managed) { assert.ok(res.skippedUnmanaged.includes(skill)); assert.equal(fs.readFileSync(skill, 'utf8'), text); }
    else assert.ok(!res.skippedUnmanaged.includes(skill));
  }
});

test('N8b 接管备份已发布但回读失败，也必须登记并清理备份', t => {
  const f = fixture(t), skill = skillPaths(f)[1], bak = skill + '.bak-t3hub';
  fs.mkdirSync(path.dirname(skill), { recursive: true }); fs.writeFileSync(skill, LEGACY_SKILL);
  const open = fs.openSync; let fired = false;
  fs.openSync = function(p, flags) {
    if (!fired && p === bak && fs.existsSync(bak) && !(flags & fs.constants.O_CREAT)) { fired = true; throw injectedError(); }
    return open.apply(this, arguments);
  };
  let result, error;
  try { error = captureError(() => { result = f.mgr.syncRoutingSkillTargets({ adoptUnmanagedSkillHashes: { [skill]: sha256(LEGACY_SKILL) } }); }); }
  finally { fs.openSync = open; }
  assert.equal(fired, true); assert.ok(error || result.ok === false);
  assert.equal(fs.readFileSync(skill, 'utf8'), LEGACY_SKILL); assert.equal(fs.existsSync(bak), false);
});

test('N5b 全局角色配置回读持续失败时保留发布记录并暴露 config rollbackFailures', t => {
  for (const operation of ['save', 'delete']) {
    const f = fixture(t); prepareRoleMutation(f, operation); assert.equal(setGlobalMode(f, 'off').ok, true);
    const file = path.join(f.hub, 'subagents.json'), link = fs.linkSync, open = fs.openSync; let published = false;
    fs.linkSync = function(src, dest) { const r = link.apply(this, arguments); if (dest === file) published = true; return r; };
    fs.openSync = function(p) { if (published && p === file) throw injectedError(); return open.apply(this, arguments); };
    let error;
    try { error = captureError(() => roleMutation(f, operation)); } finally { fs.linkSync = link; fs.openSync = open; }
    assert.equal(published, true); assert.ok(error); assert.equal(error.rolledBack, false);
    assert.ok(error.rollbackFailures.some(x => x.path === file)); assert.ok(error.message.includes(file));
  }
});

test('N1b 缺失配置仅 ENOENT 可用默认九角色；显式哈希可接管 false 文件，非精确路径不授权', t => {
  const f = fixture(t), file = path.join(f.hub, 'subagents.json'), skill = skillPaths(f)[1];
  fs.unlinkSync(file);
  const first = f.mgr.syncRoutingSkillTargets(); assert.equal(first.ok, true);
  assert.equal(fs.existsSync(file), false, 'direct Skill sync must not seed configuration');
  const generated = fs.readFileSync(skill, 'utf8'); assert.match(generated, /9 个已启用角色/);
  const custom = '---\nname: t3-subagent-routing\nt3_hub_managed: false\n---\nCUSTOM\n';
  fs.writeFileSync(skill, custom);
  const wrongPath = f.mgr.syncRoutingSkillTargets({ adoptUnmanagedSkillHashes: { [path.dirname(skill) + '/./SKILL.md']: sha256(custom) } });
  assert.ok(wrongPath.skippedUnmanaged.includes(skill)); assert.equal(fs.readFileSync(skill, 'utf8'), custom);
  const exact = f.mgr.syncRoutingSkillTargets({ adoptUnmanagedSkillHashes: { [skill]: sha256(custom) } });
  assert.equal(exact.ok, true); assert.equal(fs.readFileSync(skill + '.bak-t3hub', 'utf8'), custom);
  assert.match(fs.readFileSync(skill, 'utf8'), /t3_hub_managed: true/);
});

test('直接 raw 编排同步也能安全调用同一 Skill 事务入口', t => {
  const f = fixture(t);
  const res = f.mgr.syncOrchestrationDirectiveToHostsRaw({ configOverride: { policyVersion: 2, orchestratorMode: 'off', swarmMode: 'on' }, hosts: [f.host] });
  assert.equal(res.ok, true, JSON.stringify(res)); assert.equal(res.skillSync.ok, true);
  skillPaths(f).forEach(file => assert.match(fs.readFileSync(file, 'utf8'), /t3_hub_managed: true/));
});

// S1–S5: all filesystem fault injection is limited to disposable fixture homes.
function projectRole(f, operation = 'save') {
  return operation === 'delete'
    ? f.mgr.deleteSubagent({ scope: 'project', projectRoot: f.projectA, id: 'worker' })
    : f.mgr.saveSubagent({ scope: 'project', projectRoot: f.projectA,
      item: { ...DEFAULT_SUBAGENTS.find(x => x.id === 'worker'), systemPrompt: 'PROJECT-NEW-PROMPT' } });
}
function seedProjectRole(f) {
  fs.mkdirSync(path.join(f.projectA, '.git/info'), { recursive: true });
  f.mgr.saveSubagent({ scope: 'project', projectRoot: f.projectA,
    item: { ...DEFAULT_SUBAGENTS.find(x => x.id === 'worker'), systemPrompt: 'PROJECT-OLD-PROMPT' } });
  return fs.readdirSync(f.mgr.projectDir).map(x => path.join(f.mgr.projectDir, x)).find(x => x.endsWith('.json'));
}
function ioError(code = 'EIO') { return Object.assign(new Error('injected ' + code), { code }); }

test('S1 全局所有发布目标在首次回读前记账；暂时错误恢复，持续错误诚实报告失败', async t => {
  for (const target of ['active', 'host', 'skill', 'config']) for (const persistent of [false, true]) {
    await t.test(target + (persistent ? ' persistent' : ' transient'), st => {
      const f = fixture(st); assert.equal(setGlobalMode(f, 'off').ok, true);
      const file = { active: path.join(f.hub, 'ACTIVE_ORCHESTRATION_MODE.md'), host: f.host,
        skill: skillPaths(f)[0], config: path.join(f.hub, 'orchestration-config.json') }[target];
      const before = fs.readFileSync(file), link = fs.linkSync, lstat = fs.lstatSync;
      let published = false, fired = false;
      fs.linkSync = function(src, dest) { const r = link.apply(this, arguments); if (dest === file) published = true; return r; };
      fs.lstatSync = function(p) {
        if (p === file && published && (persistent || !fired)) { fired = true; throw ioError(); }
        return lstat.apply(this, arguments);
      };
      let result;
      try { result = setGlobalMode(f, 'on'); } finally { fs.linkSync = link; fs.lstatSync = lstat; }
      assert.equal(fired, true); assert.equal(result.ok, false, JSON.stringify(result));
      assert.equal(result.rolledBack, !persistent, JSON.stringify(result));
      if (persistent) assert.ok(result.rollbackFailures.some(x => x.path === file), JSON.stringify(result));
      else assert.deepEqual(fs.readFileSync(file), before, target + ' must restore bytes');
    });
  }
});

test('S2 全局成功前复验全部目标，含幂等宿主/活动规则/Skill/config', async t => {
  for (const sameMode of [false, true]) for (const target of ['active', 'host', 'skill', 'config']) {
    await t.test(target + (sameMode ? ' idempotent' : ' changed'), st => {
      const f = fixture(st); assert.equal(setGlobalMode(f, 'off').ok, true);
      const config = path.join(f.hub, 'orchestration-config.json');
      const file = { active: path.join(f.hub, 'ACTIVE_ORCHESTRATION_MODE.md'), host: f.host, skill: skillPaths(f)[0], config }[target];
      // Force a final JSON publication while all other targets stay idempotent.
      if (sameMode) fs.writeFileSync(config, JSON.stringify(JSON.parse(fs.readFileSync(config, 'utf8'))));
      const link = fs.linkSync; let fired = false;
      fs.linkSync = function(src, dest) {
        const r = link.apply(this, arguments);
        if (!fired && dest === config) {
          fired = true;
          if (target === 'host') fs.writeFileSync(file, '# EXTERNAL-HOST-REMOVED-BLOCK\n');
          else fs.appendFileSync(file, '\nEXTERNAL-TRANSACTION-EDIT\n');
        }
        return r;
      };
      let result;
      try { result = setGlobalMode(f, sameMode ? 'off' : 'on'); } finally { fs.linkSync = link; }
      assert.equal(fired, true); assert.equal(result.ok, false, JSON.stringify(result));
      assert.equal(result.rolledBack, false, JSON.stringify(result));
      assert.ok(result.rollbackFailures.some(x => x.path === file), JSON.stringify(result));
      assert.match(fs.readFileSync(file, 'utf8'), /EXTERNAL-/);
    });
  }
});

test('S3 项目角色严格读取、固定快照 CAS、全事务回滚与提交后复验', async t => {
  for (const kind of ['directory', 'symlink', 'EACCES', 'EPERM', 'EIO', 'json']) {
    await t.test('strict ' + kind, st => {
      const f = fixture(st), file = seedProjectRole(f), beforeHost = fs.readFileSync(path.join(f.projectA, 'AGENTS.md'));
      if (kind === 'directory') { fs.unlinkSync(file); fs.mkdirSync(file); }
      if (kind === 'symlink') { fs.renameSync(file, file + '.original'); fs.symlinkSync(file + '.original', file); }
      if (kind === 'json') fs.writeFileSync(file, '{bad');
      const stat = fs.statSync, lstat = fs.lstatSync;
      const fault = p => { if (p === file && ['EACCES', 'EPERM', 'EIO'].includes(kind)) throw ioError(kind); };
      fs.statSync = function(p) { fault(p); return stat.apply(this, arguments); };
      fs.lstatSync = function(p) { fault(p); return lstat.apply(this, arguments); };
      try {
        for (const run of [() => projectRole(f), () => projectRole(f, 'delete'),
          () => f.mgr.listSubagents({ projectRoot: f.projectA }),
          () => f.mgr.resolveSubagentRoute({ projectRoot: f.projectA, idOrTitle: 'worker' })]) assert.ok(captureError(run), kind);
      } finally { fs.statSync = stat; fs.lstatSync = lstat; }
      assert.deepEqual(fs.readFileSync(path.join(f.projectA, 'AGENTS.md')), beforeHost);
    });
  }
  for (const operation of ['save', 'delete']) {
    for (const target of ['host', 'claude', 'exclude']) await t.test(operation + ' preflight CAS ' + target, st => {
      const f = fixture(st), json = seedProjectRole(f);
      const file = { host: path.join(f.projectA, 'AGENTS.md'), claude: path.join(f.projectA, '.claude/agents/worker.md'), exclude: path.join(f.projectA, '.git/info/exclude') }[target];
      const before = fs.readFileSync(json), link = fs.linkSync; let fired = false;
      fs.linkSync = function(src, dest) {
        const r = link.apply(this, arguments);
        if (!fired && dest === json) {
          fired = true;
          if (target === 'claude') fs.chmodSync(file, 0o644);
          fs.appendFileSync(file, '\nEXTERNAL-PREFLIGHT-EDIT\n');
        }
        return r;
      };
      let error;
      try { error = captureError(() => projectRole(f, operation)); } finally { fs.linkSync = link; }
      assert.equal(fired, true); assert.ok(error); assert.deepEqual(fs.readFileSync(json), before);
      assert.match(fs.readFileSync(file, 'utf8'), /EXTERNAL-PREFLIGHT-EDIT/);
    });
    await t.test(operation + ' CAS protects JSON', st => {
      const f = fixture(st), file = seedProjectRole(f), open = fs.openSync; let fired = false;
      fs.openSync = function(p) {
        if (!fired && (p === file + '.t3hub.lock' || String(p).startsWith(file + '.tmp-'))) {
          fired = true; const items = JSON.parse(fs.readFileSync(file, 'utf8'));
          items[0].systemPrompt = 'EXTERNAL-PROJECT-PROMPT'; fs.writeFileSync(file, JSON.stringify(items));
        }
        return open.apply(this, arguments);
      };
      let error;
      try { error = captureError(() => projectRole(f, operation)); } finally { fs.openSync = open; }
      assert.equal(fired, true); assert.ok(error); assert.match(fs.readFileSync(file, 'utf8'), /EXTERNAL-PROJECT-PROMPT/);
    });
    for (const target of ['json', 'host', 'claude', 'exclude']) await t.test(operation + ' rollback ' + target, st => {
      const f = fixture(st), json = seedProjectRole(f), host = path.join(f.projectA, 'AGENTS.md');
      // Ensure save changes Claude, host and JSON; delete changes exclude too.
      if (operation === 'save') {
        const old = JSON.parse(fs.readFileSync(json, 'utf8')); old[0].systemPrompt = 'PROJECT-OLD-PROMPT';
        fs.writeFileSync(json, JSON.stringify(old));
      }
      const files = [json, host, path.join(f.projectA, '.claude/agents/worker.md'), path.join(f.projectA, '.git/info/exclude')];
      const before = files.map(p => fs.readFileSync(p));
      const file = { json, host, claude: files[2], exclude: files[3] }[target];
      // An exclude fault must be exercised even when the old line already exists.
      if (operation === 'save' && target === 'exclude') fs.writeFileSync(file, '# custom exclude\n');
      if (operation === 'save' && target === 'exclude') before[3] = fs.readFileSync(file);
      const link = fs.linkSync, rename = fs.renameSync, open = fs.openSync; let published = false, fired = false;
      fs.linkSync = function(src, dest) { const r = link.apply(this, arguments); if (dest === file) published = true; return r; };
      fs.renameSync = function(src, dest) {
        if (operation === 'delete' && target === 'claude' && src === file && String(dest).includes('.stage-')) { fired = true; throw ioError(); }
        return rename.apply(this, arguments);
      };
      fs.openSync = function(p) { if (published && p === file && !fired) { fired = true; throw ioError(); } return open.apply(this, arguments); };
      let error;
      try { error = captureError(() => projectRole(f, operation)); } finally { fs.linkSync = link; fs.renameSync = rename; fs.openSync = open; }
      assert.equal(fired, true, target); assert.ok(error); assert.equal(error.rolledBack, true, error.message);
      files.forEach((p, i) => assert.deepEqual(fs.readFileSync(p), before[i], p));
    });
    await t.test(operation + ' late conflict', st => {
      const f = fixture(st), json = seedProjectRole(f), host = path.join(f.projectA, 'AGENTS.md');
      const exclude = path.join(f.projectA, '.git/info/exclude');
      if (operation === 'save') fs.writeFileSync(exclude, '# custom\n');
      const link = fs.linkSync; let fired = false;
      fs.linkSync = function(src, dest) { const r = link.apply(this, arguments); if (!fired && dest === exclude) { fired = true; fs.appendFileSync(host, '\nEXTERNAL-LATE-HOST\n'); } return r; };
      let error;
      try { error = captureError(() => projectRole(f, operation)); } finally { fs.linkSync = link; }
      assert.equal(fired, true); assert.ok(error); assert.equal(error.rolledBack, false);
      assert.ok(error.rollbackFailures.some(x => x.path === host)); assert.match(fs.readFileSync(host, 'utf8'), /EXTERNAL-LATE-HOST/);
      assert.ok(JSON.parse(fs.readFileSync(json, 'utf8')).some(x => x.id === 'worker'));
    });
  }
});

test('S4 项目模式读取失败绝不伪报 inherit 或有效全局 ON（含向上查找与 git 探测）', async t => {
  for (const kind of ['EACCES', 'EPERM', 'EIO', 'directory', 'symlink', 'json', 'git-EIO']) await t.test(kind, st => {
    const f = fixture(st); assert.equal(setGlobalMode(f, 'on').ok, true);
    assert.equal(f.mgr.updateOrchestrationConfig({ swarmMode: 'off', expectedRevision: 'missing' }, { projectRoot: f.projectA }).ok, true);
    const file = findProjFile(f), sub = path.join(f.projectA, 'child'); fs.mkdirSync(sub);
    if (kind === 'directory') { fs.unlinkSync(file); fs.mkdirSync(file); }
    if (kind === 'symlink') { fs.renameSync(file, file + '.original'); fs.symlinkSync(file + '.original', file); }
    if (kind === 'json') fs.writeFileSync(file, '{bad');
    const lstat = fs.lstatSync;
    fs.lstatSync = function(p) {
      if (p === file && ['EACCES', 'EPERM', 'EIO'].includes(kind)) throw ioError(kind);
      if (kind === 'git-EIO' && p === path.join(sub, '.git')) throw ioError();
      return lstat.apply(this, arguments);
    };
    try {
      assert.ok(captureError(() => f.mgr.getOrchestrationState({ projectRoot: sub })), kind + ' state');
      assert.ok(captureError(() => f.mgr.resolveSubagentRoute({ projectRoot: sub, idOrTitle: 'worker' })), kind + ' route');
    } finally { fs.lstatSync = lstat; }
  });
});

test('S5 AGY Skill 目录枚举失败必须可见，只有 ENOENT 可视为完整空列表', async t => {
  for (const target of ['root', 'instance', 'config', 'skills']) for (const kind of ['EIO', 'EACCES', 'symlink', 'file', 'ENOENT']) await t.test(target + ' ' + kind, st => {
    const f = fixture(st), dir = { root: f.agyBase, instance: path.join(f.agyBase, 'inst1'),
      config: path.join(f.agyBase, 'inst1/config'), skills: path.join(f.agyBase, 'inst1/config/skills') }[target];
    if (kind === 'symlink') { fs.renameSync(dir, dir + '.original'); fs.symlinkSync(dir + '.original', dir); }
    if (kind === 'file') { fs.rmSync(dir, { recursive: true }); fs.writeFileSync(dir, 'not a directory'); }
    if (kind === 'ENOENT') fs.rmSync(dir, { recursive: true });
    const lstat = fs.lstatSync, stat = fs.statSync, readdir = fs.readdirSync;
    const fault = p => { if (p === dir && ['EIO', 'EACCES'].includes(kind)) throw ioError(kind); };
    fs.lstatSync = function(p) { fault(p); return lstat.apply(this, arguments); };
    fs.statSync = function(p) { fault(p); return stat.apply(this, arguments); };
    fs.readdirSync = function(p) { fault(p); return readdir.apply(this, arguments); };
    let snap;
    try { snap = createHostSettingsManager({ homeDir: f.home, hubDir: f.hub }).getAntigravitySnapshot(); }
    finally { fs.lstatSync = lstat; fs.statSync = stat; fs.readdirSync = readdir; }
    if (kind === 'ENOENT') { assert.equal(snap.error, null); assert.notEqual(snap.routingSkillsComplete, false); }
    else {
      assert.equal(snap.routingSkillsComplete, false); assert.ok(snap.error); assert.ok(snap.routingSkillsEnumerationError);
      const entry = snap.routingSkills.find(x => x.path === dir && x.error === 'enumeration_failed');
      assert.ok(entry, JSON.stringify(snap.routingSkills)); assert.equal(entry.exists, null); assert.equal(entry.sha256, null); assert.equal(entry.managed, false); assert.ok(entry.detail);
    }
  });
});

test('S6 backend hubCall subagents:orchestration:get/update 显式区分全局与项目作用域并透传 Skill 接管参数', async t => {
  const f = fixture(t);
  const proj = path.join(f.home, 'rpc-proj');
  fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
  const prevHome = process.env.HOME, prevHub = process.env.T3_HUB_DIR, prevT3 = process.env.T3CODE_HOME;
  process.env.HOME = f.home;
  process.env.T3_HUB_DIR = f.hub;
  process.env.T3CODE_HOME = path.join(f.home, '.t3', 'userdata');
  t.after(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevHub === undefined) delete process.env.T3_HUB_DIR; else process.env.T3_HUB_DIR = prevHub;
    if (prevT3 === undefined) delete process.env.T3CODE_HOME; else process.env.T3CODE_HOME = prevT3;
  });
  const { hubCall } = require('../src/backend.cjs');

  // 1) get passes projectRoot and returns projectOverride metadata
  const s0 = await hubCall('subagents:orchestration:get', { projectRoot: proj });
  assert.ok(s0 && s0.projectOverride, 'get with projectRoot must include projectOverride');
  assert.equal(s0.projectOverride.swarmMode, 'inherit');

  // 2) global update with ambient projectRoot (no scope:"project") updates GLOBAL, never hijacks project override
  const legacySkill = path.join(f.home, 'legacy-skill', 'SKILL.md');
  fs.mkdirSync(path.dirname(legacySkill), { recursive: true });
  const legacyBody = '---\nname: t3-subagent-routing\n---\nlegacy unmanaged body\n';
  fs.writeFileSync(legacySkill, legacyBody);
  const legacyHash = crypto.createHash('sha256').update(legacyBody).digest('hex');

  const upGlobal = await hubCall('subagents:orchestration:update', {
    swarmMode: 'on',
    expectedRevision: s0.modeRevision,
    projectRoot: proj,
    extraSkillPaths: [legacySkill],
    adoptUnmanagedSkillHashes: { [legacySkill]: legacyHash },
  });
  assert.equal(upGlobal.ok, true, JSON.stringify(upGlobal));
  const s1 = await hubCall('subagents:orchestration:get', { projectRoot: proj });
  assert.equal(s1.swarmMode, 'on');
  assert.equal(s1.projectOverride.swarmMode, 'inherit', 'ambient projectRoot without scope:project must not create project override');
  assert.equal(s1.effectiveSwarmMode, 'on');
  assert.match(fs.readFileSync(legacySkill, 'utf8'), /t3_hub_managed:\s*true/);

  // 3) explicit scope:"project" updates project override only, keeping global swarmMode === "on"
  const upProj = await hubCall('subagents:orchestration:update', {
    scope: 'project',
    projectRoot: proj,
    swarmMode: 'off',
    expectedRevision: s1.projectModeRevision,
  });
  assert.equal(upProj.ok, true, JSON.stringify(upProj));
  const s2 = await hubCall('subagents:orchestration:get', { projectRoot: proj });
  assert.equal(s2.swarmMode, 'on', 'global mode must stay on');
  assert.equal(s2.projectOverride.swarmMode, 'off');
  assert.equal(s2.effectiveSwarmMode, 'off');
});

test('L3-1 AGY 实例目录为符号链接时全局更新 fail-closed 中止，且宿主快照标记不完整', t => {
  const f = fixture(t);
  const actual = path.join(f.home, 'real-provider');
  const staleSkill = path.join(actual, 'config/skills/t3-subagent-routing/SKILL.md');
  fs.mkdirSync(path.dirname(staleSkill), { recursive: true });
  const staleContent = '---\nname: t3-subagent-routing\nt3_hub_managed: true\n---\nold routing\n';
  fs.writeFileSync(staleSkill, staleContent);
  fs.symlinkSync(actual, path.join(f.agyBase, 'instance-link'));

  const res = setGlobalMode(f, 'on');
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(fs.readFileSync(staleSkill, 'utf8'), staleContent);
  const snap = createHostSettingsManager({ homeDir: f.home, hubDir: f.hub }).getAntigravitySnapshot();
  assert.equal(snap.routingSkillsComplete, false);
  assert.ok(snap.routingSkillsEnumerationError);
});

test('L3-2 子目录调用项目编排与项目角色 CRUD 全程归一到 .git 项目根，绝不写嵌套 AGENTS.md', t => {
  const f = fixture(t);
  const project = path.join(f.home, 'git-repo');
  const child = path.join(project, 'src/deep');
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  fs.mkdirSync(child, { recursive: true });
  assert.equal(setGlobalMode(f, 'on').ok, true);

  const pre = f.mgr.getOrchestrationState({ projectRoot: child, hosts: [] });
  const childWrite = f.mgr.updateOrchestrationConfig(
    { swarmMode: 'off', expectedRevision: pre.projectModeRevision },
    { scope: 'project', projectRoot: child },
  );
  assert.equal(childWrite.ok, true, JSON.stringify(childWrite));
  assert.notEqual(childWrite.projectRoot, child);
  assert.equal(childWrite.projectRoot, fs.realpathSync(project));
  assert.equal(fs.existsSync(path.join(child, 'AGENTS.md')), false);

  const rootState = f.mgr.getOrchestrationState({ projectRoot: project, hosts: [] });
  const childState = f.mgr.getOrchestrationState({ projectRoot: child, hosts: [] });
  assert.equal(rootState.effectiveSwarmMode, 'off');
  assert.equal(childState.effectiveSwarmMode, 'off');

  const worker = { ...DEFAULT_SUBAGENTS.find(x => x.id === 'worker'), systemPrompt: 'child-only-prompt', overridesGlobal: true };
  const saved = f.mgr.saveSubagent({ scope: 'project', projectRoot: child, item: worker });
  assert.equal(saved.ok, true);
  assert.equal(fs.existsSync(path.join(child, 'AGENTS.md')), false);
  assert.equal(f.mgr.resolveSubagentRoute({ projectRoot: project, idOrTitle: 'worker' }).item.systemPrompt, 'child-only-prompt');
  assert.equal(f.mgr.resolveSubagentRoute({ projectRoot: child, idOrTitle: 'worker' }).item.systemPrompt, 'child-only-prompt');
  assert.equal(f.mgr.listSubagents({ projectRoot: child }).projectItems.length, 1);
  assert.equal(f.mgr.listSubagents({ projectRoot: project }).projectItems.length, 1);

  const delFromRoot = f.mgr.deleteSubagent({ scope: 'project', projectRoot: project, id: 'worker' });
  assert.equal(delFromRoot.deleted, true);
});

test('L3-3 项目编排更新强制要求 expectedRevision 对称 CAS，拒绝盲写覆盖', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.projectA, '.git'), { recursive: true });
  const r1 = f.mgr.updateOrchestrationConfig({ swarmMode: 'on', expectedRevision: 'missing' }, { scope: 'project', projectRoot: f.projectA });
  assert.equal(r1.ok, true);
  const r2 = f.mgr.updateOrchestrationConfig({ swarmMode: 'off', expectedRevision: r1.projectModeRevision }, { scope: 'project', projectRoot: f.projectA });
  assert.equal(r2.ok, true);
  const blind = f.mgr.updateOrchestrationConfig({ swarmMode: 'on' }, { scope: 'project', projectRoot: f.projectA });
  assert.equal(blind.ok, false, JSON.stringify(blind));
  assert.equal(f.mgr.getOrchestrationState({ projectRoot: f.projectA, hosts: [] }).projectOverride.swarmMode, 'off');
});

test('L3-4 自定义 T3CODE_HOME 同步 AGY 规则/Skill/快照，且 orchestration:get 校验 scope 与枚举 EIO 回滚', async t => {
  const f = fixture(t);
  const customUserdata = path.join(f.home, 'alternate-userdata');
  const customAgy = path.join(customUserdata, 'providers/antigravity');
  const rule = path.join(customAgy, 'instance/config/rules/AGENTS.md');
  const customSkill = path.join(customAgy, 'instance/config/skills/t3-subagent-routing/SKILL.md');
  fs.mkdirSync(path.dirname(rule), { recursive: true });
  fs.mkdirSync(path.dirname(customSkill), { recursive: true });
  const oldSkill = '---\nname: t3-subagent-routing\nt3_hub_managed: true\n---\nold routing\n';
  fs.writeFileSync(rule, '# Existing rule\n');
  fs.writeFileSync(customSkill, oldSkill);

  const prevHome = process.env.HOME, prevHub = process.env.T3_HUB_DIR, prevT3 = process.env.T3CODE_HOME;
  process.env.HOME = f.home;
  process.env.T3_HUB_DIR = f.hub;
  process.env.T3CODE_HOME = customUserdata;
  t.after(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevHub === undefined) delete process.env.T3_HUB_DIR; else process.env.T3_HUB_DIR = prevHub;
    if (prevT3 === undefined) delete process.env.T3CODE_HOME; else process.env.T3CODE_HOME = prevT3;
  });
  const { hubCall } = require('../src/backend.cjs');

  const start = await hubCall('subagents:orchestration:get', { hosts: [] });
  const global = await hubCall('subagents:orchestration:update', { swarmMode: 'on', expectedRevision: start.modeRevision });
  assert.equal(global.ok, true, JSON.stringify(global));
  assert.ok(fs.readFileSync(rule, 'utf8').includes('T3_HUB_ORCHESTRATOR_START'));
  assert.notEqual(fs.readFileSync(customSkill, 'utf8'), oldSkill);

  const snap = createHostSettingsManager({ homeDir: f.home, hubDir: f.hub }).getAntigravitySnapshot();
  assert.ok(snap.routingSkills.some(x => x.path === customSkill));
  assert.equal(snap.routingSkillsComplete, true);

  const proj = path.join(f.home, 'rpc-scoped-proj');
  fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
  const pu = await hubCall('subagents:orchestration:update', { scope: 'project', projectRoot: proj, swarmMode: 'off', expectedRevision: 'missing' });
  assert.equal(pu.ok, true);
  const scopedGet = await hubCall('subagents:orchestration:get', { scope: 'global', projectRoot: proj, hosts: [] });
  assert.equal(scopedGet.effectiveSwarmMode, 'on');
  assert.equal(scopedGet.swarmMode, 'on');
  assert.equal(scopedGet.projectOverride, undefined);
  const invalidGet = await hubCall('subagents:orchestration:get', { scope: 'invalid', projectRoot: proj, hosts: [] });
  assert.equal(invalidGet.ok, false);

  const beforeRule = fs.readFileSync(rule, 'utf8');
  const stateNow = await hubCall('subagents:orchestration:get', { hosts: [] });
  const readdir = fs.readdirSync;
  let fired = false;
  fs.readdirSync = function(p) {
    if (p === customAgy) {
      fired = true;
      const e = new Error('injected EIO'); e.code = 'EIO'; throw e;
    }
    return readdir.apply(this, arguments);
  };
  let errorResult;
  try { errorResult = await hubCall('subagents:orchestration:update', { swarmMode: 'off', expectedRevision: stateNow.modeRevision }); }
  finally { fs.readdirSync = readdir; }
  assert.equal(fired, true);
  assert.equal(errorResult.ok, false);
  assert.equal(fs.readFileSync(rule, 'utf8'), beforeRule);
  assert.equal((await hubCall('subagents:orchestration:get', { hosts: [] })).swarmMode, 'on');
});

test('L3-5 二次授权接管新未托管 Skill 时轮转归档旧 .bak-t3hub，失败时原子恢复旧备份并清理归档', t => {
  const f = fixture(t);
  const skill = skillPaths(f)[1];
  const bak = skill + '.bak-t3hub';
  const dir = path.dirname(skill);
  fs.mkdirSync(dir, { recursive: true });

  const v1 = '---\nname: t3-subagent-routing\n---\nunmanaged version 1\n';
  fs.writeFileSync(skill, v1);
  assert.equal(f.mgr.syncRoutingSkillTargets({ adoptUnmanagedSkillHashes: { [skill]: sha256(v1) } }).ok, true);
  assert.equal(fs.readFileSync(bak, 'utf8'), v1);

  const v2 = '---\nname: t3-subagent-routing\n---\nunmanaged version 2\n';
  fs.writeFileSync(skill, v2);
  // 先注入写入中途失败：旧 bak 必须恢复为 v1，且无孤儿归档残留
  const rename = fs.renameSync;
  let fired = false;
  fs.renameSync = function(src, dest) {
    if (!fired && src === skill && String(dest).includes('.stage-')) {
      fired = true;
      throw injectedError();
    }
    return rename.apply(this, arguments);
  };
  let failedRes;
  try { failedRes = f.mgr.syncRoutingSkillTargets({ adoptUnmanagedSkillHashes: { [skill]: sha256(v2) } }); }
  finally { fs.renameSync = rename; }
  assert.equal(fired, true);
  assert.equal(failedRes.ok, false);
  assert.equal(fs.readFileSync(skill, 'utf8'), v2);
  assert.equal(fs.readFileSync(bak, 'utf8'), v1);
  assert.deepEqual(fs.readdirSync(dir).filter(n => n.startsWith('SKILL.md.bak-t3hub.')), []);

  // 正常二次接管：v1 轮转进 .bak-t3hub.* 归档，新 .bak-t3hub 保存 v2
  const okRes = f.mgr.syncRoutingSkillTargets({ adoptUnmanagedSkillHashes: { [skill]: sha256(v2) } });
  assert.equal(okRes.ok, true, JSON.stringify(okRes));
  assert.equal(fs.readFileSync(bak, 'utf8'), v2);
  const archives = fs.readdirSync(dir).filter(n => n.startsWith('SKILL.md.bak-t3hub.'));
  assert.equal(archives.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, archives[0]), 'utf8'), v1);
});

function injectedError(msg = 'injected EIO') {
  const err = new Error(msg);
  err.code = 'EIO';
  return err;
}

function loadBackendWithEnv(t, home, hub, customUserdata) {
  const prevHome = process.env.HOME;
  const prevHub = process.env.T3_HUB_DIR;
  const prevT3 = process.env.T3CODE_HOME;
  process.env.HOME = home;
  process.env.T3_HUB_DIR = hub;
  process.env.T3CODE_HOME = customUserdata || path.join(home, '.t3', 'userdata');
  const backendPath = require.resolve('../src/backend.cjs');
  delete require.cache[backendPath];
  t.after(() => {
    delete require.cache[backendPath];
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevHub === undefined) delete process.env.T3_HUB_DIR; else process.env.T3_HUB_DIR = prevHub;
    if (prevT3 === undefined) delete process.env.T3CODE_HOME; else process.env.T3CODE_HOME = prevT3;
  });
  return require('../src/backend.cjs');
}

test('L3-6 同时传入 config 与 patch 时严格校验内外层与兄弟作用域冲突', async t => {
  const f = fixture(t);
  const { hubCall } = loadBackendWithEnv(t, f.home, f.hub);
  const st0 = await hubCall('subagents:orchestration:get', { hosts: [f.host] });
  const conflict1 = await hubCall('subagents:orchestration:update', {
    scope: 'global',
    hosts: [f.host],
    config: { swarmMode: 'on', expectedRevision: st0.modeRevision },
    patch: { scope: 'project' },
  });
  assert.equal(conflict1.ok, false);
  assert.match(conflict1.error, /conflicting orchestration scope/i);
  const conflict2 = await hubCall('subagents:orchestration:update', {
    hosts: [f.host],
    config: { scope: 'global', swarmMode: 'on', expectedRevision: st0.modeRevision },
    patch: { scope: 'project' },
  });
  assert.equal(conflict2.ok, false);
  assert.match(conflict2.error, /conflicting orchestration scope/i);
  const invalidInner = await hubCall('subagents:orchestration:update', {
    scope: 'global',
    hosts: [f.host],
    config: { swarmMode: 'on', expectedRevision: st0.modeRevision },
    patch: { scope: 'workspace' },
  });
  assert.equal(invalidInner.ok, false);
  assert.match(invalidInner.error, /invalid orchestration scope/i);
  const after6 = await hubCall('subagents:orchestration:get', { hosts: [f.host] });
  assert.equal(after6.swarmMode, st0.swarmMode);
  assert.equal(after6.effectiveSwarmMode, 'off');
});

test('L3-7 常规全局切换与状态检测同步覆盖 ~/.gemini/antigravity/rules/AGENTS.md 及 AGY 实例规则', async t => {
  const f = fixture(t);
  const gemRule = path.join(f.home, '.gemini', 'antigravity', 'rules', 'AGENTS.md');
  const agyRule = path.join(f.agyBase, 'inst1', 'config', 'rules', 'AGENTS.md');
  const codexRule = path.join(f.home, '.codex', 'AGENTS.md');
  fs.mkdirSync(path.dirname(gemRule), { recursive: true });
  fs.mkdirSync(path.dirname(agyRule), { recursive: true });
  fs.mkdirSync(path.dirname(codexRule), { recursive: true });
  fs.writeFileSync(gemRule, '# gem global rule\n');
  fs.writeFileSync(agyRule, '# agy instance rule\n');
  fs.writeFileSync(codexRule, '# codex global rule\n');
  const { hubCall } = loadBackendWithEnv(t, f.home, f.hub);
  const st0 = await hubCall('subagents:orchestration:get', {});
  const up = await hubCall('subagents:orchestration:update', { swarmMode: 'on', expectedRevision: st0.modeRevision });
  assert.equal(up.ok, true, JSON.stringify(up));
  assert.match(fs.readFileSync(gemRule, 'utf8'), /T3_HUB_ORCHESTRATOR_START/);
  assert.match(fs.readFileSync(agyRule, 'utf8'), /T3_HUB_ORCHESTRATOR_START/);
  assert.equal((await hubCall('subagents:orchestration:get', {})).modeApplied, true);
  // 若外部抹除 AGY 全局规则托管块，modeApplied 必须诚实变为 false
  fs.writeFileSync(gemRule, '# gem global rule\n');
  assert.equal((await hubCall('subagents:orchestration:get', {})).modeApplied, false);
  // 直接调用 updateOrchestrationConfig 不传 hosts 时同样覆盖 AGY 全局与实例规则
  const st1 = f.mgr.getOrchestrationState();
  assert.equal(st1.modeApplied, false);
  const direct = f.mgr.updateOrchestrationConfig({ swarmMode: 'on', expectedRevision: st1.modeRevision });
  assert.equal(direct.ok, true, JSON.stringify(direct));
  assert.match(fs.readFileSync(gemRule, 'utf8'), /T3_HUB_ORCHESTRATOR_START/);
  assert.equal(f.mgr.getOrchestrationState().modeApplied, true);
});

test('L3-8 显式指定 hosts 时不可读 (0000) 的 AGY 全局或实例 AGENTS.md 仍在预检阶段失败关闭', async t => {
  const f = fixture(t);
  const gemRule = path.join(f.home, '.gemini', 'antigravity', 'rules', 'AGENTS.md');
  const agyRule = path.join(f.agyBase, 'inst1', 'config', 'rules', 'AGENTS.md');
  fs.mkdirSync(path.dirname(gemRule), { recursive: true });
  fs.mkdirSync(path.dirname(agyRule), { recursive: true });
  fs.writeFileSync(gemRule, '# gem rule\n');
  fs.writeFileSync(agyRule, '# agy rule\n');
  const { hubCall } = loadBackendWithEnv(t, f.home, f.hub);
  const initialMode = f.mgr.getOrchestrationState({ hosts: [f.host] }).swarmMode;
  for (const target of [agyRule, gemRule]) {
    fs.chmodSync(target, 0o000);
    try {
      const rev = f.mgr.getOrchestrationState({ hosts: [f.host] }).modeRevision;
      const directRes = f.mgr.updateOrchestrationConfig({ swarmMode: 'on', expectedRevision: rev }, { hosts: [f.host] });
      assert.equal(directRes.ok, false, `direct update must fail closed when ${target} is 0000`);
      const rpcRes = await hubCall('subagents:orchestration:update', { swarmMode: 'on', expectedRevision: rev, hosts: [f.host] });
      assert.equal(rpcRes.ok, false, `RPC update must fail closed when ${target} is 0000`);
      assert.equal(f.mgr.getOrchestrationState({ hosts: [f.host] }).swarmMode, initialMode);
    } finally {
      try { fs.chmodSync(target, 0o644); } catch {}
    }
  }
});

test('L3-9 提交前同名替换 AGY 实例目录会被并发身份签名捕获并原子回滚', t => {
  const f = fixture(t);
  const agyRoot = f.agyBase;
  const instDir = path.join(agyRoot, 'inst1');
  const instSkill = path.join(instDir, 'config', 'skills', 't3-subagent-routing', 'SKILL.md');
  fs.mkdirSync(path.dirname(instSkill), { recursive: true });
  fs.writeFileSync(instSkill, '---\nname: t3-subagent-routing\nt3_hub_managed: true\n---\ninitial\n');
  const backupCopy = path.join(f.home, 'inst1-stale-copy');
  fs.cpSync(instDir, backupCopy, { recursive: true });
  fs.writeFileSync(path.join(backupCopy, 'config', 'skills', 't3-subagent-routing', 'SKILL.md'), '---\nname: t3-subagent-routing\nt3_hub_managed: true\n---\nstale copy\n');

  const stBefore = f.mgr.getOrchestrationState({ hosts: [f.host] });
  const rev = stBefore.modeRevision;
  const origReaddir = fs.readdirSync;
  let rootEnumCount = 0;
  fs.readdirSync = function(target, ...rest) {
    if (target === agyRoot) {
      rootEnumCount++;
      if (rootEnumCount === 2) {
        const movedOld = path.join(f.home, 'inst1-displaced');
        fs.renameSync(instDir, movedOld);
        fs.renameSync(backupCopy, instDir);
      }
    }
    return origReaddir.call(this, target, ...rest);
  };
  let res;
  try {
    res = f.mgr.updateOrchestrationConfig({ swarmMode: 'on', expectedRevision: rev }, { hosts: [f.host] });
  } finally {
    fs.readdirSync = origReaddir;
  }
  assert.equal(rootEnumCount >= 2, true);
  assert.equal(res.ok, false, 'same-name AGY instance directory swap before commit must fail closed');
  assert.equal(f.mgr.getOrchestrationState({ hosts: [f.host] }).swarmMode, stBefore.swarmMode);
  assert.equal(f.mgr.getOrchestrationState({ hosts: [f.host] }).effectiveSwarmMode, 'off');
  assert.doesNotMatch(fs.readFileSync(f.host, 'utf8'), /T3_HUB_ORCHESTRATOR_START/);
});

test('L3-10 删除代理在登记发布前检查与恢复均失败时必须报错并返回结构化回滚失败详情', async t => {
  const f = fixture(t);
  const { hubCall } = loadBackendWithEnv(t, f.home, f.hub);
  const saveRes = await hubCall('subagents:save', {
    scope: 'global',
    extraSyncPaths: [f.host],
    item: {
      id: 'temp-del-role',
      name: 'temp-del-role',
      providerInstanceId: 'codex',
      model: 'gpt-5',
      effort: 'high',
      description: 'del test',
      systemPrompt: 'prompt',
      enabled: true,
    },
  });
  assert.equal(saveRes.ok, true, JSON.stringify(saveRes));
  const agentMd = path.join(f.home, '.claude', 'agents', 'temp-del-role.md');
  assert.equal(fs.existsSync(agentMd), true);

  const origOpen = fs.openSync;
  const origLink = fs.linkSync;
  fs.openSync = function(p, ...rest) {
    if (String(p).includes('temp-del-role.md.stage-') && String(p).endsWith('/old')) {
      throw injectedError('EIO staged inspect');
    }
    return origOpen.call(this, p, ...rest);
  };
  fs.linkSync = function(src, dst) {
    if (String(src).includes('temp-del-role.md.stage-') && dst === agentMd) {
      throw injectedError('EIO restore link');
    }
    return origLink.call(this, src, dst);
  };
  let delRes;
  try {
    delRes = await hubCall('subagents:delete', { scope: 'global', id: 'temp-del-role', extraSyncPaths: [f.host] });
  } finally {
    fs.openSync = origOpen;
    fs.linkSync = origLink;
  }
  assert.equal(delRes.ok, false, 'unrestored staged agent deletion must NOT report ok:true');
  assert.equal(delRes.rolledBack, false, 'RPC must surface rolledBack:false');
  assert.equal(Array.isArray(delRes.rollbackFailures) && delRes.rollbackFailures.some(x => x.path === agentMd), true, JSON.stringify(delRes));
  // subagents.json 必须回滚保留 temp-del-role
  const listed = f.mgr.listSubagents({});
  assert.equal(listed.globalItems.some(i => i.id === 'temp-del-role'), true);
});

test('L3-11 getAntigravitySnapshot 绝不跟随符号链接读取外部规则或继续枚举下层 Skill 目录', t => {
  const f = fixture(t);
  const extDir = path.join(f.home, 'external-secret');
  fs.mkdirSync(path.join(extDir, 'inst-ext', 'config', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(extDir, 'inst-ext', 'config', 'rules', 'AGENTS.md'), 'SECRET_EXTERNAL_RULE_PREVIEW');
  fs.mkdirSync(path.join(extDir, 't3-subagent-routing'), { recursive: true });
  fs.writeFileSync(path.join(extDir, 't3-subagent-routing', 'SKILL.md'), 'SECRET_SKILL');

  const agyRoot = path.join(f.home, '.t3', 'userdata', 'providers', 'antigravity');
  fs.rmSync(agyRoot, { recursive: true, force: true });
  fs.symlinkSync(extDir, agyRoot);

  const agentsSkills = path.join(f.home, '.agents', 'skills');
  fs.rmSync(agentsSkills, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(agentsSkills), { recursive: true });
  fs.symlinkSync(extDir, agentsSkills);

  const visited = [];
  const origReaddir = fs.readdirSync;
  fs.readdirSync = function(target, ...rest) {
    visited.push(String(target));
    return origReaddir.call(this, target, ...rest);
  };
  let snap;
  try {
    const hsm = createHostSettingsManager({ homeDir: f.home, hubDir: f.hub });
    snap = hsm.getAntigravitySnapshot();
  } finally {
    fs.readdirSync = origReaddir;
  }
  assert.equal(snap.routingSkillsComplete, false);
  assert.doesNotMatch(String(snap.preview || ''), /SECRET_EXTERNAL_RULE_PREVIEW/, 'must never read rule content through symlinked agyRoot');
  assert.equal(visited.some(p => p.includes('t3-subagent-routing') && p.includes('.agents/skills')), false, 'must not enumerate child package under symlinked .agents/skills');
  assert.equal(visited.includes(agyRoot), false, 'must not readdir symlinked agyRoot');
});

test('L3-12 删除 Claude 代理文件后回滚恢复时严格保持原 0444 只读权限', t => {
  const f = fixture(t);
  const saved = f.mgr.saveSubagent({
    scope: 'global',
    extraSyncPaths: [f.host],
    item: {
      id: 'ro-role',
      name: 'ro-role',
      providerInstanceId: 'codex',
      model: 'gpt-5',
      effort: 'high',
      description: 'readonly test',
      systemPrompt: 'prompt',
      enabled: true,
    },
  });
  assert.equal(saved.ok, true);
  const agentMd = path.join(f.home, '.claude', 'agents', 'ro-role.md');
  assert.equal(fs.lstatSync(agentMd).mode & 0o777, 0o444);

  const hubSkill = skillPaths(f)[0];
  const origLink = fs.linkSync;
  let injected = false;
  fs.linkSync = function(src, dst) {
    if (!injected && dst === hubSkill) {
      injected = true;
      throw injectedError('EIO skill link fail after deletion');
    }
    return origLink.call(this, src, dst);
  };
  let caught = null;
  try {
    f.mgr.deleteSubagent({ scope: 'global', id: 'ro-role', extraSyncPaths: [f.host] });
  } catch (e) {
    caught = e;
  } finally {
    fs.linkSync = origLink;
  }
  assert.ok(caught, 'deleteSubagent must throw on injected skill write failure');
  assert.equal(caught.rolledBack, true, JSON.stringify(caught.rollbackFailures));
  assert.deepEqual(caught.rollbackFailures, []);
  assert.equal(fs.lstatSync(agentMd).mode & 0o777, 0o444, 'restored Claude agent file must retain 0444 mode');
});

test('L3-13 独立调用 syncOrchestrationDirectiveToHostsRaw 不传 hosts 时同步所有已存在默认宿主与 AGY 规则', t => {
  const f = fixture(t);
  const codexMd = path.join(f.home, '.codex', 'AGENTS.md');
  const gemRule = path.join(f.home, '.gemini', 'antigravity', 'rules', 'AGENTS.md');
  const agyRule = path.join(f.agyBase, 'inst1', 'config', 'rules', 'AGENTS.md');
  fs.mkdirSync(path.dirname(codexMd), { recursive: true });
  fs.mkdirSync(path.dirname(gemRule), { recursive: true });
  fs.mkdirSync(path.dirname(agyRule), { recursive: true });
  fs.writeFileSync(codexMd, '# codex\n');
  fs.writeFileSync(gemRule, '# gem\n');
  fs.writeFileSync(agyRule, '# agy\n');

  const res = f.mgr.syncOrchestrationDirectiveToHostsRaw({
    configOverride: { policyVersion: 2, orchestratorMode: 'off', swarmMode: 'on' },
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.match(fs.readFileSync(codexMd, 'utf8'), /T3_HUB_ORCHESTRATOR_START/);
  assert.match(fs.readFileSync(gemRule, 'utf8'), /T3_HUB_ORCHESTRATOR_START/);
  assert.match(fs.readFileSync(agyRule, 'utf8'), /T3_HUB_ORCHESTRATOR_START/);
});

test('L3-14 skills-archived* 前缀的普通文件在三处模块均被严格拒绝', async t => {
  const f = fixture(t);
  const agyRoot = path.join(f.home, '.t3', 'userdata', 'providers', 'antigravity');
  const strayArchiveFile = path.join(agyRoot, 'skills-archived-stray');
  fs.writeFileSync(strayArchiveFile, 'not a directory');

  const rev = f.mgr.getOrchestrationState({ hosts: [f.host] }).modeRevision;
  assert.equal(f.mgr.updateOrchestrationConfig({ swarmMode: 'on', expectedRevision: rev }, { hosts: [f.host] }).ok, false);

  const hsm = createHostSettingsManager({ homeDir: f.home, hubDir: f.hub });
  assert.equal(hsm.getAntigravitySnapshot().routingSkillsComplete, false);

  const { hubCall } = loadBackendWithEnv(t, f.home, f.hub);
  const rpcRes = await hubCall('subagents:orchestration:update', { swarmMode: 'on', expectedRevision: rev });
  assert.equal(rpcRes.ok, false);
});

test('L3-15 (#6-1) 未托管旧路由 Skill 被跳过时 modeApplied 必须为 false', t => {
  const f = fixture(t);
  const st0 = f.mgr.getOrchestrationState({ hosts: [f.host] });
  assert.equal(f.mgr.updateOrchestrationConfig({ swarmMode: 'off', expectedRevision: st0.modeRevision }, { hostRulePaths: [f.host] }).ok, true);
  const agentsSkill = skillPaths(f)[1];
  fs.mkdirSync(path.dirname(agentsSkill), { recursive: true });
  fs.writeFileSync(agentsSkill, '# legacy unmanaged OFF routing skill\n');
  const st1 = f.mgr.getOrchestrationState({ hosts: [f.host] });
  const up = f.mgr.updateOrchestrationConfig({ swarmMode: 'on', expectedRevision: st1.modeRevision }, { hostRulePaths: [f.host] });
  assert.equal(up.ok, true);
  assert.ok(up.skillSync.skippedUnmanaged.includes(agentsSkill));
  assert.equal(up.skillsApplied, false);
  assert.equal(up.skillResults.find(r => r.path === agentsSkill).state, 'unmanaged');
  assert.equal(up.modeApplied, false, 'updateOrchestrationConfig must report modeApplied:false when a skill was skippedUnmanaged');
  const stAfter = f.mgr.getOrchestrationState({ hosts: [f.host] });
  assert.equal(stAfter.skillsApplied, false);
  assert.equal(stAfter.modeApplied, false, 'getOrchestrationState must keep modeApplied:false while unmanaged skill diverges');
  const desired = fs.readFileSync(skillPaths(f)[0], 'utf8');
  fs.writeFileSync(agentsSkill, desired);
  const applied = f.mgr.getOrchestrationState({ hosts: [f.host] });
  assert.equal(applied.skillsApplied, true);
  assert.equal(applied.modeApplied, true);
  assert.equal(applied.skillResults.length, skillPaths(f).length);
  for (const sf of skillPaths(f)) {
    for (const state of ['missing', 'unmanaged', 'different']) {
      if (state === 'missing') fs.unlinkSync(sf);
      else fs.writeFileSync(sf, state === 'unmanaged' ? '# user skill\n' : desired + '\nchanged outside Hub\n');
      try {
        const changed = f.mgr.getOrchestrationState({ hosts: [f.host] });
        assert.equal(changed.skillResults.find(r => r.path === sf).state, state, sf);
        assert.equal(changed.skillsApplied, false, sf + ': ' + state);
        assert.equal(changed.modeApplied, false, sf + ': ' + state);
      } finally { fs.writeFileSync(sf, desired); }
    }
  }
  const synced = f.mgr.updateOrchestrationConfig({ swarmMode: 'on', expectedRevision: applied.modeRevision }, { hostRulePaths: [f.host] });
  assert.equal(synced.skillsApplied, true);
  assert.equal(synced.modeApplied, true);
});

test('L3-16 (#6-2) saveSubagent/deleteSubagent 与 RPC 严格拒绝 null/空串/非法 scope，绝不误改全局配置', async t => {
  const f = fixture(t);
  f.mgr.saveSubagent({ scope: 'global', item: { id: 'keep-custom', name: 'Keep', role: 'general', providerInstanceId: 'muse', model: 'muse-ember-1.0', effort: 'max' } });
  const globalBefore = fs.readFileSync(path.join(f.hub, 'subagents.json'), 'utf8');
  const { hubCall } = loadBackendWithEnv(t, f.home, f.hub);

  for (const badScope of [null, '', 'invalid', 123]) {
    assert.throws(() => f.mgr.saveSubagent({ scope: badScope, projectRoot: f.projectA, item: { id: 'explorer', effort: 'high' } }), /invalid scope/i);
    assert.throws(() => f.mgr.deleteSubagent({ scope: badScope, projectRoot: f.projectA, id: 'keep-custom' }), /invalid scope/i);
    assert.throws(() => f.mgr.saveSubagent({ item: { id: 'explorer', scope: badScope, effort: 'high' } }), /invalid scope/i);
    const rSave = await hubCall('subagents:update', { scope: badScope, projectRoot: f.projectA, item: { id: 'explorer', effort: 'high' } });
    assert.equal(rSave.ok, false);
    const rDel = await hubCall('subagents:delete', { scope: badScope, projectRoot: f.projectA, id: 'keep-custom' });
    assert.equal(rDel.ok, false);
  }
  assert.equal(fs.readFileSync(path.join(f.hub, 'subagents.json'), 'utf8'), globalBefore);
});

test('L3-17 (#6-3) 内外层 projectRoot 与 expectedRevision 冲突必须被拒绝，防止写错项目或绕过 CAS', async t => {
  const f = fixture(t);
  const { hubCall } = loadBackendWithEnv(t, f.home, f.hub);
  const st = f.mgr.getOrchestrationState({ hosts: [f.host] });

  assert.throws(() => f.mgr.updateOrchestrationConfig(
    { swarmMode: 'on', projectRoot: f.projectA, expectedRevision: 'missing' },
    { projectRoot: f.projectB, expectedRevision: 'missing' }), /conflicting orchestration projectRoot/);
  assert.throws(() => f.mgr.updateOrchestrationConfig(
    { swarmMode: 'on', expectedRevision: st.modeRevision },
    { expectedRevision: 'stale-outer-rev' }), /conflicting orchestration expectedRevision/);

  const conflictProj = await hubCall('subagents:orchestration:update', {
    projectRoot: f.projectA,
    expectedRevision: 'missing',
    patch: { swarmMode: 'on', projectRoot: f.projectB, expectedRevision: 'missing' },
  });
  assert.equal(conflictProj.ok, false);
  assert.equal(findProjFile(f), null, 'conflicting projectRoot must not create override in projectA or projectB');

  const conflictRev = await hubCall('subagents:orchestration:update', {
    expectedRevision: 'stale-outer-rev',
    patch: { swarmMode: 'on', expectedRevision: st.modeRevision },
  });
  assert.equal(conflictRev.ok, false, 'stale outer expectedRevision must not be bypassed by inner patch.expectedRevision');
  assert.equal(f.mgr.getOrchestrationState({ hosts: [f.host] }).modeRevision, st.modeRevision);
});

test('L3-18 (#6-4 & #6-5) AGY 000 不可读规则文件必须暴露 corrupted 与候选错误；软链规则在读写通路均拒绝', t => {
  const f = fixture(t);
  const agyRule = path.join(f.agyBase, 'inst-perm', 'config', 'rules', 'AGENTS.md');
  fs.mkdirSync(path.dirname(agyRule), { recursive: true });
  fs.writeFileSync(agyRule, '# secret rule\n', { mode: 0o600 });
  fs.chmodSync(agyRule, 0o000);
  t.after(() => { try { fs.chmodSync(agyRule, 0o600); } catch {} });

  const hsm = createHostSettingsManager({ homeDir: f.home, hubDir: f.hub });
  const snap = hsm.getAntigravitySnapshot();
  assert.equal(snap.corrupted, true, '000 AGY AGENTS.md must mark snapshot corrupted');
  assert.ok(snap.error, '000 AGY AGENTS.md must surface snapshot error');
  assert.ok(snap.ruleCandidates.some(c => c.path === agyRule && c.exists && c.error && c.corrupted), 'ruleCandidates must retain unreadable instance rule with error');
  const otherRule = path.join(f.agyBase, 'inst-other', 'config/rules/AGENTS.md');
  fs.mkdirSync(path.dirname(otherRule), { recursive: true });
  fs.writeFileSync(otherRule, '# another candidate\n');
  const ambiguous = hsm.getAntigravitySnapshot();
  assert.equal(ambiguous.ruleSelectionAmbiguous, true);
  assert.equal(ambiguous.corrupted, true, 'unselected unreadable candidate must still corrupt the snapshot');
  assert.ok(ambiguous.error);
  assert.ok(ambiguous.ruleCandidates.some(c => c.path === agyRule && c.exists && c.error && c.corrupted));
  fs.unlinkSync(otherRule);
  fs.chmodSync(agyRule, 0o600);
  for (const code of ['EACCES', 'EIO']) {
    const lstat = fs.lstatSync;
    fs.lstatSync = function (p, ...rest) {
      if (p === agyRule) { const err = new Error('injected rule lstat ' + code); err.code = code; throw err; }
      return lstat.call(this, p, ...rest);
    };
    try {
      const failed = hsm.getAntigravitySnapshot();
      assert.equal(failed.corrupted, true, code);
      assert.ok(failed.ruleCandidates.some(c => c.path === agyRule && c.exists && c.error.includes(code) && c.corrupted), code);
    } finally { fs.lstatSync = lstat; }
  }
  fs.rmSync(agyRule, { force: true });

  const targetFile = path.join(f.home, 'outside-target.md');
  fs.writeFileSync(targetFile, '# untouched target\n');
  fs.symlinkSync(targetFile, agyRule);
  const snapSym = hsm.getAntigravitySnapshot();
  assert.equal(snapSym.corrupted, true);
  assert.throws(() => hsm.getRuleContent('antigravity'), /unsafe symlink path/);
  assert.throws(() => hsm.saveRuleContent('antigravity', '# overwrite attempt\n'), /unsafe symlink path/);
  assert.equal(fs.readFileSync(targetFile, 'utf8'), '# untouched target\n');
});

test('L3-19 (#6-6) 删除 Claude 角色后回滚必须精确恢复 0640 权限而非降为 0440', t => {
  const f = fixture(t);
  f.mgr.saveSubagent({ scope: 'global', item: { id: 'rw-role', name: 'RW Role', role: 'general', providerInstanceId: 'muse', model: 'muse-ember-1.0', effort: 'max' }, extraSyncPaths: [f.host] });
  const agentMd = path.join(f.home, '.claude', 'agents', 'rw-role.md');
  fs.chmodSync(agentMd, 0o640);
  const skillTarget = skillPaths(f)[0];
  const origLink = fs.linkSync;
  let injected = false;
  fs.linkSync = function (src, dst) {
    if (!injected && dst === skillTarget) {
      injected = true;
      throw injectedError();
    }
    return origLink.call(this, src, dst);
  };
  let caught = null;
  try {
    f.mgr.deleteSubagent({ scope: 'global', id: 'rw-role', extraSyncPaths: [f.host] });
  } catch (e) {
    caught = e;
  } finally {
    fs.linkSync = origLink;
  }
  assert.ok(caught);
  assert.equal(caught.rolledBack, true);
  assert.deepEqual(caught.rollbackFailures, []);
  assert.equal(fs.lstatSync(agentMd).mode & 0o777, 0o640, 'restored Claude agent file must keep exact 0640 mode');
});

test('L3-20 ~/.gemini/antigravity 存在但 rules/ 尚未创建时首次保存编排模式成功创建并达成 modeApplied', t => {
  const f = fixture(t);
  const gemDir = path.join(f.home, '.gemini', 'antigravity');
  const gemRulesFile = path.join(gemDir, 'rules', 'AGENTS.md');
  fs.mkdirSync(gemDir, { recursive: true });
  assert.equal(fs.existsSync(path.join(gemDir, 'rules')), false);

  const before = f.mgr.getOrchestrationState();
  const res = f.mgr.updateOrchestrationConfig({ swarmMode: 'on', expectedRevision: before.modeRevision });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.modeApplied, true);
  assert.equal(res.skillsApplied, true);
  assert.equal(fs.existsSync(gemRulesFile), true);
  assert.ok(fs.readFileSync(gemRulesFile, 'utf8').includes('T3_HUB_ORCHESTRATOR_START'));
});
