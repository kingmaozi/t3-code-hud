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
  if (!wrapped && !String(payload.tool_name || '').includes('delegate_task')) process.exit(0);
  const input = wrapped ? outer.Arguments : outer;
  if (!input || typeof input !== 'object' || Array.isArray(input)) process.exit(0);
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
  const hints = [input.clientRequestId, input.title].filter(x => typeof x === 'string' && x.trim());
  // Role can itself be an agent id; a generic role may select only a single route.
  let resolved = manager.resolveSubagentRoute({ idOrTitle: hints, role: input.role, projectRoot: payload.cwd || process.cwd() });
  if (!resolved.matched && input.role) resolved = manager.resolveSubagentRoute({ idOrTitle: input.role, projectRoot: payload.cwd || process.cwd() });
  if (!resolved.matched || isDeepStrictEqual(input.target, resolved.target)) process.exit(0);
  const updated = { ...input, target: resolved.target };
  console.log(JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    additionalContext: 'T3 路由已按当前子代理配置更新；权限判断仍由宿主执行。',
    updatedInput: wrapped ? { ...outer, Arguments: updated } : updated,
  } }));
} catch {
  // Invalid/missing configuration must not damage an unrelated tool invocation.
  process.exitCode = 0;
}
