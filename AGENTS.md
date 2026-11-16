# T3 Hub Project Rules

## Project Role

This repository is the local source project for T3 Code HUD and its Hub: a macOS/Electron extension that displays telemetry and provides shared project tools, memory, task plans, routing settings, and host integration. The GitHub repository is `https://github.com/kingmaozi/t3-code-hud`. The current checked-out handoff branch is `codex/t3-hub-handoff-20261116`; its base is `4a28ce4`. The package version is `1.0.1` in `package.json`; do not invent a `dts/manifest.json` version source where none exists.

## Current Priority

Continue from `docs/HANDOFF.md` and `docs/REQUIREMENTS-AND-EXPERIMENTS.zh-CN.md`, and `docs/EXPERIMENTS-TIMELINE.zh-CN.md`. In the current handoff state, coding is paused by the user's latest request; if the user later pastes the takeover prompt in `docs/T3-HUB-TAKEOVER-PROMPT.zh-CN.md`, treat that as authorization to resume the scoped work. The isolated handoff worktree is the continuation source; the original `~/Documents/t3-code-hud` working tree remains intact. Current corrections include: Swarm/Orchestrator is **ON**; a newly opened T3 chat has been observed coding directly and using the older seven-role configuration, including `code-review` at high; the floating panel should show only the main current-chat plan. Dream automation is configured for Muse Ember, medium effort, 03:30 Asia/Singapore, enabled with wake catch-up; **two** manual Muse runs failed with `cli-exit-1`, so real model execution is not verified.

## Non-Negotiable Boundaries

- The current task explicitly forbids restarting T3; continue honoring that limit unless the user gives a new instruction. When a user-authorized reversible source change is ready for installation, use a narrowly scoped, backed-up hot reload where it fits the request and preserve live task state.
- Do not send extra requests through AGY, alter AGY authentication, endpoints, binary, or native app configuration, or initiate AGY model calls.
- Do not initiate another real Muse dream run unless the user explicitly authorizes it. Automated tests must not invoke dream execution.
- Never assume a saved settings file means the active host or chat loaded it. Report the evidence layer: UI selection, persisted config, managed host file, live runtime, and behavior in a fresh chat.
- Preserve user tasks, existing data, unmanaged prompts/configuration, custom agents, and unknown work. Never use broad cleanup, blanket overwrite, or destructive Git reset.
- Keep memory text, chat content, local telemetry databases, tokens, credentials, and account data out of Git and public documentation. Keep raw evidence local and private.
- The remote is public. Do not push private material, local evidence, or unreviewed user state.
- Do not create nested general-purpose agents, switch to an unrequested host-native swarm, or change models and reasoning levels outside the saved Hub routes.

## Local Services And Config

- Package: `package.json`; installed HUD files: `~/.t3/hud-plugin`; executable: `~/.t3/bin/t3-hud`.
- Global Hub state/configuration lives under `~/.t3/hub/`. Project settings and `AGENTS.md` belong to the selected project. Verify paths and current values at runtime; never copy private personal rules into a shared or project file by assumption.
- The source `src/renderer-ui.js` is installed as `~/.t3/hud-plugin/renderer-base.js`; other renderer modules are assembled during reload. Hub modules have separate installed copies. Back up each destination, copy only the owned file, compare hashes, then validate actual status.
- Avoid running `install.sh` as a development shortcut: it performs a broader install and has its own runtime effects. Use the specific change/release procedure documented by the task owner.
- The observed development runtime was Node `v26.0.0`; `package.json` does not declare an `engines` range. Check the actual runtime before assuming a compatibility contract.

## Memory / Knowledge Workflow

Read the relevant project memories before changing memory, routing, ACP, installation, or lifecycle code. Do not store private user/business memory in this repository. Dream reports distinguish local cleanup from an Agent review; a healthy timer does not prove a model call succeeded.

## Verification

Use targeted tests with the repository's built-in Node runner, for example `node --test tests/hub-v3-frontend-contract-xss.test.cjs` or `node --test tests/hub-autodream-runtime.test.cjs`. Select the suite that covers the change; do not claim `npm test` exists because `package.json` defines no test script. For real host changes, verify saved files, runtime status, and observed host behavior separately. Simulation or a file hash alone is not end-to-end proof.

## Release / Backup Notes

Never use `git reset --hard` or discard unknown work. Stage explicit paths and inspect the resulting diff. Complete ordinary reversible coding, verification, and Git steps that the user has authorized without asking for the same authorization again. Before a push, inspect the destination (`git remote -v`); the configured GitHub project is public and private local evidence must never be included. T3 hot reload and T3 restart are separate operations; restart is forbidden for the current task.
