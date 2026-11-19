---
name: powercontext-memory
description: Use at the start of project coding, debugging, or architecture tasks to recall the current project's T3 Memory Vault rules and verified pitfalls. Record a durable finding after verification. Keep each project's memory isolated; never use global memory or infer a different project from search results.
---

# T3 Project Memory

T3 Memory stores project records in a local Markdown and SQLite vault. The same project's agents and worktrees can share project records; worktree-private records remain separate. Vector search helps retrieval, but does not guarantee latency, cache savings, or a limit on memory growth.

## Resolve the project automatically

At the start of a project task, including a subagent task, call `memory_status({})`. Check that access is enabled and `projectBound` is true. Compare the returned `projectRoot` with the current T3 project's actual workspace or corresponding worktree. A parent agent's project is context to check, not permission to switch an unrelated MCP process to it.

The router resolves T3's registered project and worktree ownership from local host state. Use the confirmed `projectRoot` in every memory call; obtain this path yourself rather than asking the user to configure it:

```javascript
memory_search({ projectRoot: confirmedProjectRoot, query: "本轮任务或排障关键词", limit: 6 })
```

If the status is disabled, unbound, ambiguous, or belongs to another project, do not search or write through that connection. Never fall back to global memory, another project, the most recent chat, or an arbitrary path. Continue the task without memory and report the missing binding briefly. An already running MCP process may need its host to reconnect naturally to load an update; do not restart T3 or interrupt live tasks for this.

When MCP is unavailable, the installed CLI can resolve the same T3 project from its actual workspace or worktree directory:

```bash
node ~/.t3/bin/pc-lite.mjs recall --query "本轮任务或排障关键词"
```

## Save verified findings

After verifying a non-obvious root cause or durable project constraint, write a concise, reusable finding to that same confirmed project. Avoid duplicating existing records. Read-only roles must not write. Do not save routine chatter, guesses, private credentials, or account data.

```javascript
memory_write({
  projectRoot: confirmedProjectRoot,
  module: "pitfalls", // or "constraints", "architecture"
  title: "简短可检索标题",
  content: "触发条件、已验证原因、修复方法与验证结论",
  scope: "shared"
})
```

Use `scope: "worktree"` only for a finding specific to the current worktree. `shared` means this project across its worktrees, never all projects. Recheck context when the host changes projects. The router deliberately rejects a different project rather than rebinding an existing connection silently.

CLI alternatives from that project's directory:

```bash
node ~/.t3/bin/pc-lite.mjs experience \
  --cue "触发关键词" --symptom "表面现象" --situation "触发条件" \
  --action "已验证修复" --outcome "实际结果" \
  --condition "验证方法" --lesson "可复用结论"
node ~/.t3/bin/pc-lite.mjs rule --kind constraint --text "已确认的项目约束"
```
