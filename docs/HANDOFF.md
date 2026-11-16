# T3 Hub engineering handoff

Last updated: 2026-11-16 (Asia/Singapore)

## Project location and GitHub

- Workspace: `~/Documents/t3-hub`
- GitHub: <https://github.com/kingmaozi/t3-code-hud>
- Remote: `origin` → `https://github.com/kingmaozi/t3-code-hud.git`
- Current handoff branch: `codex/t3-hub-handoff-20261116`
- Base at handoff creation: `4a28ce4` (`feat(hub): ship floating plans, tiered agents and scheduled memory care`)
- WIP source checkpoint: `6f0953f` (includes the intentionally red diagnostic test specification)
- Package version: `1.0.1` from `package.json`

This is an existing Git repository in a separate worktree. Do not run `git init`, replace `origin`, or treat the original `~/Documents/t3-code-hud` checkout as disposable. Keep unrelated WIP files. The GitHub target is public; never include private prompts, memory, local reports, account settings, or raw chat records.

## What is established

The project already contains the T3 HUD and Hub, telemetry, MCP/plugin/skill cards, memory vault, host settings, subagent routing, Hooks, artifact access, task-board integration, and floating task UI. Read [the requirements ledger](REQUIREMENTS-AND-EXPERIMENTS.zh-CN.md) and [the implementation attempts and rejected conclusions](EXPERIMENTS-TIMELINE.zh-CN.md) before proposing changes. Read [the Chinese Hub guide](HUB-GUIDE.zh-CN.md), [AutoDream guide](AUTODREAM.zh-CN.md), and [three-tier collaboration guide](SUBAGENTS.zh-CN.md) for user-facing behavior.

Recent work saved a Swarm/Orchestrator mode, nine role routes, and a Muse-based daily memory dream. Configuration state, managed instruction files, and actual behavior in a new chat are different evidence levels. The active mode is **ON**. The user reports that a newly opened chat still works directly and displays an older seven-role configuration; treat this as an unresolved host-injection issue, not as proof the UI toggle works end to end. A PreToolUse route guard may adjust a `delegate_task` after one has been requested; that alone does not cause the main session to dispatch work.

The floating plan panel requirement has since been narrowed: show the main current-chat plan only; keep child-agent entries on the full task page. The frozen UI candidate is copied into this handoff worktree. Continue here; retain the original working tree as a source/evidence copy and do not resume development there.

The latest UI candidate is `e50a26d66b9465d3ae5a950cd32106dd560c2d546a03d19ff17c7445b5025f5e` with test prefix `186f5481` and guide prefix `99990891`; this candidate is copied into the handoff worktree. It renames the progress view to a unified task panel, removes the entire bottom shortcut bar from the floating panel, keeps subagent progress on the full task page, visually improves artifact cards, opens Finder with the selected item, and retains Markdown preview on the full page. Its isolated targeted run was 15/15 with desktop and narrow-screen render evidence, CRLF path coverage, Finder reveal, and full task-page Markdown preview. It has **not** received independent review or real T3 installation. Earlier review `25a645e4` / 103 tests applies to an older candidate only.

## Dream run evidence and limits

AutoDream is configured as enabled, Muse / `muse-ember-1.0`, `medium`, daily 03:30 Asia/Singapore, with wake catch-up. The timer can be running even though model execution fails.

One user-authorized manual run at 21:58:33 SGT on 2026-11-16 ended in local cleanup success and Agent failure `cli-exit-1`; it made zero memory changes. After the input fix, the coordinator performed a second real verification at 22:17:10 SGT also ended with `cli-exit-1` and zero changes after the temporary-prompt-file fix was installed. The memory total differed by two between snapshots; these were intervening records, not dream-run edits. Muse CLI parameter help accepted the production option names. An isolated offline run with a normal prompt file passed argument parsing and entered model streaming, but its deliberately denied network caused transport failure; that does not prove the production cause. Muse 1.4.20's real error details were removed from the persistent report, so the underlying exit cause is unknown. Do not claim model cleanup succeeded, infer auth/network/model as the cause, or report zero cost solely from zero estimated tokens. Do not make another live model request without the user's explicit authorization.

The safe prompt-file fix is installed: a `0700` temporary directory, a regular `0600` file, and `finally` cleanup guarded by inode/ownership with no recursive deletion. Its independent focused results were 52/52, incremental 54/54, and dedicated prompt-file 8/8. A new `hub-autodream-diagnostic` test file currently records 18 intended failing cases; the code that writes a sanitized diagnostic category and HTTP status is not implemented yet. Keep this red test visible in status summaries; it is not evidence that the whole test suite was run.

## Host lifecycle and sensitive integrations

- T3 main process had remained PID `96619` at last observation. PIDs are observations, never constants for future actions.
- Hub bridge PID `17385` was observed after reload. Discover and verify current process ownership before any lifecycle operation. No restart is authorized.
- Python wrapper improvements were installed earlier, but old ACP processes do not acquire new bytes until their own process naturally restarts. The original HTTP 502 was not traced to a confirmed upstream root cause. Do not claim the 502 is fixed.
- T3's Antigravity ACP is distinct from the standalone AGY desktop app and AGY CLI. Do not change auth, endpoint, binary, native app installation, or send extra AGY requests.

## Development and acceptance

Use [the development setup](DEVELOPMENT.zh-CN.md). Work from this handoff worktree and maintain explicit file ownership. Use targeted tests, then actual UI/runtime acceptance when the user authorizes it. Report separately:

1. Source changes and Git state.
2. Tests and their exact scope.
3. Files copied into the installed HUD, with verified hashes.
4. Per-PID RPC/mounted/window status.
5. What the current host actually displayed or executed.

Do not equate “config saved,” “file exists,” “test passed,” or “RPC answers” with an active session having loaded the rule or actually routing work.

## GitHub issues to continue from

- [#6 Main chat does not dispatch under Orchestrator mode](https://github.com/kingmaozi/t3-code-hud/issues/6)
- [#7 Safe diagnostics for real Muse execution failure](https://github.com/kingmaozi/t3-code-hud/issues/7)
- [#8 Latest task-panel candidate is not installed](https://github.com/kingmaozi/t3-code-hud/issues/8)
- [#9 Current-turn telemetry sampling and reporting](https://github.com/kingmaozi/t3-code-hud/issues/9)
- [#10 T3 Hub engineering handoff](https://github.com/kingmaozi/t3-code-hud/issues/10) is the project entry point.

Original private evidence (test logs and local screenshots) is kept by the coordinator in the handoff worktree's ignored `.handoff-local/` directory; read only its evidence index when present. Do not copy this directory to GitHub.
