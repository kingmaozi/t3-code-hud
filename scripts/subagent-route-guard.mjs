#!/usr/bin/env node
// This process intentionally has no cached route state: a running session sees the
// next saved configuration on its very next delegate_task call.
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';

async function readInput() {
  if (process.stdin.isTTY) return null;
  let text = '';
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 250);
    const done = () => { clearTimeout(timer); resolve(); };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      text += chunk;
      if (text.length > 4 * 1024 * 1024) { text = ''; done(); }
      else { try { JSON.parse(text); done(); } catch {} }
    });
    process.stdin.once('end', done);
    process.stdin.once('error', done);
  });
  process.stdin.pause();
  try { return JSON.parse(text); } catch { return null; }
}

try {
  const payload = await readInput();
  if (!payload || typeof payload !== 'object') process.exit(0);
  const outer = payload.tool_input || (payload.ToolName ? payload : null);
  if (!outer || typeof outer !== 'object' || Array.isArray(outer)) process.exit(0);
  const wrapped = typeof outer.ToolName === 'string' && outer.ToolName.includes('delegate_task');
  // Only these T3 MCP identities are verified. An unrelated MCP can expose a tool
  // with the same short name; a generic wrapper provides no trusted identity.
  if (wrapped || !['mcp__t3_code__delegate_task', 'mcp__t3-code__delegate_task'].includes(payload.tool_name)) process.exit(0);
  const input = wrapped ? outer.Arguments : outer;
  if (!input || typeof input !== 'object' || Array.isArray(input)) process.exit(0);
  // A scoped target may address a remote environment/project whose routes and
  // rule files are not the ones on this machine. Never rewrite it here.
  if (input.target && typeof input.target === 'object' && (input.target.environmentId || input.target.projectId)) process.exit(0);
  const require = createRequire(import.meta.url);
  const homeDir = process.env.HOME || os.homedir();
  // Support repository scripts/, a flat install, and the standard bin/ -> hud-plugin/ layout.
  let mod;
  for (const location of ['../src/hub-subagents.cjs', './hub-subagents.cjs', '../hud-plugin/hub-subagents.cjs', path.join(homeDir, '.t3', 'hud-plugin', 'hub-subagents.cjs')]) {
    try { mod = require(location); break; } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  }
  if (!mod) process.exit(0);
  const hubDir = process.env.T3_HUB_DIR || path.join(homeDir, '.t3', 'hub');
  const manager = mod.createSubagentsManager({ homeDir, hubDir });
  // The global saved switch is authoritative: project overrides may narrow an
  // enabled global route, but cannot reactivate Hub routing after global off.
  const globalConfig = typeof manager.getOrchestrationConfig === 'function' ? manager.getOrchestrationConfig() : null;
  if (globalConfig?.swarmMode !== 'on') process.exit(0);
  const hints = [input.clientRequestId, input.title].filter(x => typeof x === 'string' && x.trim());
  // Role can itself be an agent id; a generic role may select only a single route.
  let resolved = manager.resolveSubagentRoute({ idOrTitle: hints, role: input.role, projectRoot: payload.cwd || process.cwd() });
  if (!resolved.matched && !resolved.explicitUnavailable && input.role) resolved = manager.resolveSubagentRoute({ idOrTitle: input.role, role: input.role, projectRoot: payload.cwd || process.cwd() });
  if (!resolved.matched || (input.role && resolved.item?.role && input.role !== resolved.item.role)) process.exit(0);
  const orch = resolved.orchestration && typeof resolved.orchestration === 'object' ? resolved.orchestration : { swarmMode: 'off', source: 'global' };
  // Hub route rewriting is opt-in. An effective off/auto mode must leave the
  // host's original delegate_task input and permission path entirely alone.
  if (orch.swarmMode !== 'on') process.exit(0);
  const orchNote = ` 生效模式：${orch.swarmMode}（来源：${orch.source}）。`;
  const updated = { ...input };
  const oldTarget = input.target && typeof input.target === 'object' && !Array.isArray(input.target) ? input.target : {};
  const rawOptions = oldTarget.options;
  const optionsArray = Array.isArray(rawOptions);
  const validArray = optionsArray && rawOptions.every(entry => entry && typeof entry === 'object' && !Array.isArray(entry) && typeof entry.id === 'string' && Object.keys(entry).every(key => key === 'id' || key === 'value')) && new Set(rawOptions.map(entry => entry.id)).size === rawOptions.length;
  const validObject = rawOptions === undefined || (rawOptions && typeof rawOptions === 'object' && !optionsArray);
  if (!validArray && !validObject) {
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: '目标选项格式无法安全合并，已保留原派单；请确认后手动选择角色。' + orchNote, updatedInput: input } }));
    process.exit(0);
  }
  const oldOptions = optionsArray ? Object.fromEntries(rawOptions.map(entry => [entry.id, entry.value])) : { ...(rawOptions || {}) };
  const changedProvider = Boolean(oldTarget.providerInstanceId && oldTarget.providerInstanceId !== resolved.target.providerInstanceId);
  const changedModel = Boolean(oldTarget.model && oldTarget.model !== resolved.target.model);
  const unknownOptions = Object.keys(oldOptions).filter(key => !['reasoningEffort', 'thinking', 'thinking_level', 'effort'].includes(key));
  if ((oldTarget.driverKind && oldTarget.providerInstanceId !== resolved.target.providerInstanceId) || ((changedProvider || changedModel) && unknownOptions.length)) {
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: '目标含无法确认兼容性的 driver 或选项，已保留原派单；请确认后手动选择角色。' + orchNote, updatedInput: input } }));
    process.exit(0);
  }
  for (const key of ['reasoningEffort', 'thinking', 'thinking_level', 'effort']) delete oldOptions[key];
  const mergedOptions = { ...oldOptions, ...resolved.target.options };
  const options = optionsArray ? Object.entries(mergedOptions).map(([id, value]) => ({ id, value })) : mergedOptions;
  const nextTarget = { ...oldTarget, ...resolved.target, options };
  if (!isDeepStrictEqual(input.target, nextTarget)) updated.target = nextTarget;
  // T3's delegate_task schema calls the task text `task`. Do not guess another
  // field when it is absent. Replace only our complete, leading block so a
  // second hook pass is idempotent and a changed prompt takes effect.
  const start = '<!-- t3-hub-subagent-prompt:start -->';
  const end = '<!-- t3-hub-subagent-prompt:end -->';
  const instruction = String(resolved.instruction || '').trim();
  let warning = '';
  if (typeof input.task !== 'string' || !input.task.trim()) warning = '未识别到非空 task 字符串，未注入角色提示词。';
  else if (!instruction || instruction.includes(start) || instruction.includes(end)) warning = '角色提示词包含无效标记或为空，未注入任务。';
  if (typeof input.task === 'string' && input.task.trim() && instruction && !instruction.includes(start) && !instruction.includes(end)) {
    let original = input.task;
    if (original.startsWith(start + '\n')) {
      const endIndex = original.indexOf('\n' + end + '\n\n', start.length);
      if (endIndex >= 0) original = original.slice(endIndex + end.length + 3);
      else original = null; // An incomplete foreign/user block is not ours to rewrite.
    }
    if (original !== null) {
      const candidate = start + '\n' + instruction + '\n' + end + '\n\n' + original;
      if (candidate.length <= 120000) updated.task = candidate;
      else warning = '任务加上该角色提示词会超过 120000 字符，未添加提示词；请缩短提示词或任务。';
    } else warning = '任务开头的角色提示标记不完整，未更改任务文字。';
  }
  if (isDeepStrictEqual(updated, input) && !warning) process.exit(0);
  console.log(JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    additionalContext: (warning || 'T3 已按可识别的角色配置更新派单内容；权限判断仍由宿主执行。') + orchNote,
    updatedInput: wrapped ? { ...outer, Arguments: updated } : updated,
  } }));
} catch {
  // Invalid/missing configuration must not damage an unrelated tool invocation.
  process.exitCode = 0;
}
