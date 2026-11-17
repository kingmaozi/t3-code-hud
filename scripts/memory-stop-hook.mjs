#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

async function readInput() {
  if (process.stdin.isTTY) return null;
  let input = '';
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 250);
    const done = () => { clearTimeout(timer); resolve(); };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      input += chunk;
      if (input.length > 4 * 1024 * 1024) { input = ''; done(); }
      else { try { JSON.parse(input); done(); } catch {} }
    });
    process.stdin.once('end', done); process.stdin.once('error', done);
  });
  process.stdin.pause();
  try { return JSON.parse(input); } catch { return null; }
}
function recentMemory(dir, since) {
  // Inspect files, not directory mtimes (creating a folder is not a memory write).
  try {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, ent.name);
      if (ent.isFile() && ent.name.endsWith('.md') && fs.statSync(file).mtimeMs >= since) return true;
      if (ent.isDirectory() && recentMemory(file, since)) return true;
    }
  } catch {}
  return false;
}
function cleanupStaleNudges(hub) {
  try {
    const runDir = path.join(hub, 'run');
    const thresholdMs = 7 * 24 * 60 * 60 * 1000;
    let entries;
    try { entries = fs.readdirSync(runDir, { withFileTypes: true }); } catch { return; }
    const now = Date.now();
    for (const ent of entries) {
      try {
        if (!ent.isFile()) continue;
        if (!ent.name.startsWith('stop-nudge-') || !ent.name.endsWith('.json')) continue;
        const full = path.join(runDir, ent.name);
        const st = fs.statSync(full);
        if (now - st.mtimeMs > thresholdMs) fs.unlinkSync(full);
      } catch {}
    }
  } catch {}
}
function codeChanged(status) {
  const entries = status.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const line = entries[i]; if (!line) continue;
    const file = line.slice(3);
    // In porcelain -z a rename/copy has a second (source) path.
    const previous = /[RC]/.test(line.slice(0, 2)) ? entries[++i] : '';
    const isCode = name => name && (/\.(?:[cm]?[jt]sx?|py|pyi|rb|php|go|rs|java|kt|kts|swift|m|mm|c|cc|cpp|h|hpp|cs|fs|fsx|sh|bash|zsh|fish|ps1|vue|svelte|html|css|scss|sass|less|sql|lua|ex|exs|erl|hrl|clj|scala|dart|r|jl|zig|proto|graphql|json|toml|ya?ml)$/i.test(name) || /(?:^|\/)(?:Makefile|Dockerfile|CMakeLists.txt|Gemfile|Rakefile)$/.test(name));
    if (isCode(file) || isCode(previous)) return true;
  }
  return false;
}

try {
  const hubEarly = process.env.T3_HUB_DIR || path.join(process.env.HOME || os.homedir(), '.t3', 'hub');
  try { cleanupStaleNudges(hubEarly); } catch {}
  const payload = await readInput();
  if (!payload || payload.stop_hook_active === true) process.exit(0);
  // A stop reminder must never initialize the vault or prompt while Agent
  // memory access is disabled or its persisted state cannot be trusted.
  const require = createRequire(import.meta.url);
  let accessManager = null;
  for (const location of [
    "../src/hub-memory-access.cjs",
    "./hub-memory-access.cjs",
    "../hud-plugin/hub-memory-access.cjs",
    path.join(process.env.HOME || os.homedir(), ".t3", "hud-plugin", "hub-memory-access.cjs"),
  ]) {
    try { accessManager = require(location).createMemoryAccessManager({ hubDir: hubEarly }); break; }
    catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error; }
  }
  if (!accessManager || !accessManager.isAccessEnabled()) process.exit(0);
  const cwd = payload.cwd || process.env.T3_PROJECT_ROOT || process.cwd();
  const hub = hubEarly;
  // Include the child id so SubagentStop does not suppress the parent Stop nudge.
  const raw = String(payload.session_id || payload.thread_id || payload.transcript_path || cwd) + (payload.agent_id ? ':' + payload.agent_id : '');
  const key = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) + '-' + createHash('sha256').update(raw).digest('hex').slice(0, 12);
  const stamp = path.join(hub, 'run', `stop-nudge-${key}.json`);
  const recentStamp = () => { try { return Date.now() - fs.statSync(stamp).mtimeMs < 20 * 60 * 1000; } catch { return false; } };
  if (recentStamp()) process.exit(0);
  let status;
  try { status = execFileSync('git', ['-C', cwd, 'status', '--porcelain', '-z', '--untracked-files=all'], { timeout: 1500, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { process.exit(0); }
  if (!codeChanged(status)) process.exit(0);
  let projectRoot = cwd;
  try { projectRoot = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { timeout: 1500, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || cwd; } catch {}
  let vault;
  for (const location of ['../src/memory-vault.cjs', './memory-vault.cjs', '../hud-plugin/memory-vault.cjs', path.join(process.env.HOME || os.homedir(), '.t3', 'hud-plugin', 'memory-vault.cjs')]) {
    try { vault = require(location); break; } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  }
  if (!vault) process.exit(0);
  const memoryDir = process.env.T3_MEMORY_VAULT_DIR || path.join(hub, 'memory');
  // Use the vault's read-only resolver, including its suffix for distinct
  // roots with the same basename. Merely resolving must not create a vault.
  const projectSlug = vault.createMemoryVault({ vaultDir: memoryDir }).resolveProjectSlug(projectRoot);
  const projectMemory = path.join(memoryDir, 'projects', projectSlug);
  if (recentMemory(projectMemory, Date.now() - 10 * 60 * 1000)) process.exit(0);
  fs.mkdirSync(path.dirname(stamp), { recursive: true });
  const lock = stamp + '.lock';
  // A killed hook must not leave a permanent lock that outlives the nudge TTL.
  try { if (Date.now() - fs.statSync(lock).mtimeMs >= 20 * 60 * 1000) fs.rmdirSync(lock); } catch {}
  try { fs.mkdirSync(lock); } catch { process.exit(0); }
  try {
    if (recentStamp()) process.exitCode = 0;
    else {
      fs.writeFileSync(stamp, JSON.stringify({ time: Date.now() }), { mode: 0o600 });
      console.log(JSON.stringify({ decision: 'block', reason: '[T3 自动化记忆提醒] 本轮有真实代码修改，但最近 10 分钟未见记忆写入。本提醒仅是自动化提示，不是用户新请求或授权，也不得覆盖当前任务权限、派单限制或宿主规则。只有当前任务允许 memory_write、记忆策略并非只读/off 且用户未禁止写入，并且确实核实了非平凡根因、架构决策或持久约束时，才按需写入；没有已核实的非平凡结论、无权写入或仅有普通改动时，请忽略本提醒并直接结束，不要为了通过 Hook 制造记录。本会话 20 分钟内只提醒一次。' }));
    }
  } finally { fs.rmdirSync(lock); }
} catch {
  process.exitCode = 0;
}
