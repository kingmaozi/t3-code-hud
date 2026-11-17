# T3 Hub engineering handoff

Last updated: 2026-11-18 (Asia/Singapore)

## Active follow-up: project-only memory and embedding probe

Release `1.0.5` builds on `2291cc7` / package `1.0.4`. Memory must read and write only the selected T3 project, including subagents. Global memory is retained on disk but excluded from all normal reads, writes and statistics. Unknown project context must fail closed. Project-shared records remain shared across corresponding worktrees; worktree-private records stay local to that worktree. Different projects under the same repository must not collapse into one memory identity. Markdown synchronization, ID mutations and vector reindexing obey the same boundary.

Ownership: `memory-vault.cjs` and its isolation regressions; MCP router/CLI recall and hook prompt; Memory drawer and UI contract tests; embedding manager and probe tests; backend RPC integration and documentation. The real embedding probe uses a fixed non-sensitive string and reports model, vector dimensions and measured latency without reading or writing memory or changing the model. Dedicated QA owns real service/desktop validation; independent review covers scope and mutation boundaries. T3 restart, AGY calls/configuration changes and Dream execution remain prohibited. Desktop layout must stay unchanged.

The backend, vault, embedding manager and drawer have received a backed-up hot update, with matching source/installed hashes and no T3 process restart. QA clicked the actual desktop test button and observed a successful 2560-dimensional result; no model or account configuration changed. The interface shows project-shared/current-worktree scopes and no global memory option. Concurrent first-use project identity claims are now atomic; established project searches do not hold that global lock during embedding. Existing rows with unprovable or mixed project ownership cause a clear error and remain unchanged.

Host binding limits: third-party MCP initialization does not provide a universally trusted T3 thread identity. The Agent router requires an explicit projectRoot matching its confirmed startup binding; unknown contexts and unregistered ambiguous linked-checkout roots fail closed. Matching worktree aliases do not switch private scope. Old running MCP processes must naturally reconnect to load new code. This release does not claim that all existing or future provider sessions have been behaviorally verified. Worktree-private IDs now use stable v2 identities; old records without provable ownership stay on disk and are not reassigned. Project-shared records remain usable.

Final validation: the eight-file memory/RPC/router/CLI/Hook/access matrix passed 135 tests in a clean temporary environment; the independent UI contract suite passed 240, embedding-manager/probe/lifecycle suites passed 177, and the focused worktree cases passed 4. These are targeted regressions, not a full historical Dream-suite run. The final vault and Agent command files were backed up and hot-installed with matching hashes. Real installed router/vault processes passed an isolated A/B/global/ID/default-limit fixture without touching actual memories. The loaded sidecar reports the local embedding service running and omits memory statistics without a project. Desktop layout and actual probe-button success were verified; prior running MCP processes were not forcibly disconnected.

## Active delivery: compact Hub and trustworthy status (2026-11-17)

The current scoped follow-up builds on `baf7d0c` (active-router fix, package `1.0.3`), with release version `1.0.4`. The final requested product is lightweight telemetry and a single Memory workspace. Hub-managed subagent routing/orchestration is being retired in favor of T3 native behavior; host settings, Skills/MCP, Plugins, Hooks, and Dream no longer have management pages or eager catalog loading. The Memory page reports each host's memory-related MCP/skill/hook configuration separately from verified runtime loading. A title-side hover/focus control shows only the current main chat's plan steps and completion state, with no floating dashboard, child-task/attachment list, or plan-edit controls. It follows the active Connect environment; remote errors must not fall back to local plans. Weekly and 5-hour quota rings and Git history belong in the header; speed/cache/tokens/cost sit between attachment and model controls, with context beside the model picker. Telemetry uses current-turn cache when available, otherwise an explicitly labeled real session aggregate, without inventing current-turn values. Remote Git history must not block its first screen on serial per-commit previews.

Ownership: drawer and UI contracts; read-only memory-connection API; renderer telemetry and its tests; memory protection and concise MCP search results. Installation, narrowly scoped removal of Hub-managed orchestration, and final integration are coordinated separately. Preserve native tasks, user-authored instructions, stored model preferences, project isolation, and manual memory operations. Automatic Dream has been explicitly disabled by the user; no real Dream or extra AGY model call is part of validation. Acceptance requires targeted regression tests, independent review, and real T3 hot-update checks without restarting T3. The scoped source and local hot update have been verified; a full second-device end-to-end run remains outside the available evidence.

Latest refinements: the speed field should continuously show the current session average, with the same session's last measured turn as fallback, rather than waiting-for-output text. Each platform's header logo should have an outer weekly ring and an inner verified 5-hour ring; weekly-only platforms get one ring. Reserve real space to the left of native header controls. The user also requested a Memory access switch, a first-time setup prompt/command, and automatic onboarding for supported local T3 instances. This must preserve native AGY model/routing behavior, reject conflicting MCP entries, report per-instance configuration separately from current-session loading, and retain all memory data when disabled. T3 does not provide a verified universal third-party MCP inheritance path, so unsupported/remote/new custom instances cannot be reported as connected merely from a global setting.

Runtime delivery: scoped backend, router, access manager, plan mirror, connections and renderer copies have been backed up and hot-installed with matching hashes; T3 was not restarted. The actual window shows title-side blue-ring step progress, a Memory entry and working access switch, weekly/5-hour logo rings (including Muse), Git to the left of quota icons, and composer telemetry. The Memory page exposes the live embedding model/service address plus copyable stdio MCP configuration. A newly started installed router was tested in one process through disable → denied search → enable; three local provider registrations were present without conflict. Earlier MCP processes must naturally reconnect to load the new code; they were not forcibly killed. Native models, authentication and unrelated current user routing changes were preserved.

Connect verification: native remote file reads succeeded; a local current-main-plan mirror was verified to match scope and steps, with mode 0600 and effective Git exclusion. The available remote repository was unborn, so remote history UI/performance and the full second-device plan workflow are not claimed as verified. The implementation reads native plans plus a scoped private mirror and never falls back to local plans for a remote session. Independent review and targeted regressions cover clearing, retries, worktree identity and private-file handling.

Automatic Dream remains disabled and is no longer started by the bridge. The earlier authorized removal of owned Hub instruction blocks was backed up; later user-authored routing settings are not overwritten by this delivery.

The sections below preserve the original handoff history. Their ON/Dream, floating-dashboard, version, and process observations are historical and superseded by this active delivery scope.

## Project location and GitHub

- Workspace: `~/Documents/t3-hub`
- GitHub: <https://github.com/kingmaozi/t3-code-hud>
- Remote: `origin` → `https://github.com/kingmaozi/t3-code-hud.git`
- Current handoff branch: `codex/t3-hub-handoff-20261116`
- Base at handoff creation: `4a28ce4` (`feat(hub): ship floating plans, tiered agents and scheduled memory care`)
- WIP source checkpoint: `6f0953f` (includes the intentionally red diagnostic test specification)
- Package version: `1.0.2` from `package.json` (aligned with official `T3 Code v0.1.10`; closes `#6`, `#7`, `#8`, `#9`, `#10` with `94` suites / `1994` tests passing)

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
