# T3 Hub Project Rules

## Project Role

This repository is the local source project for T3 Code HUD and its Hub: a macOS/Electron extension for lightweight telemetry, memory, current-chat plans, and Git history. The GitHub repository is `https://github.com/kingmaozi/t3-code-hud`. The current checked-out handoff branch is `codex/t3-hub-handoff-20261116`; its base is `4a28ce4`. Read the release version from `package.json`; do not invent a `dts/manifest.json` version source where none exists.

## Current Priority

Continue from `docs/HANDOFF.md`, `docs/REQUIREMENTS-AND-EXPERIMENTS.zh-CN.md`, and `docs/EXPERIMENTS-TIMELINE.zh-CN.md`. The user authorized the lightweight follow-up on 2026-11-17: retain telemetry and Memory; retire Hub-managed orchestration in favor of native T3 routing; remove management pages for host settings, skills, MCP, plugins, hooks, and Dream. Automatic Dream is disabled. The title-side blue-ring control shows only the current main chat's plan, following the active Connect environment with no local fallback for a remote chat. Memory entry and access toggle also belong in the title header, without a floating side handle. The user explicitly requires desktop delivery only; do not introduce mobile layouts or leave the live T3 window in device emulation. Memory exposes the actual embedding model/service address and copyable stdio MCP configuration. Platform logos use an outer weekly ring and an inner verified 5-hour ring; preserve Muse's reported window duration. Quota rings and Git belong in the header; telemetry and context belong in the composer. Preserve the original `~/Documents/t3-code-hud` working tree. Historic ON/Dream and floating-dashboard requirements in older handoff sections are superseded; no real Dream model execution is authorized. Later user-authored routing changes must not be overwritten while retiring older Hub-owned content.

## Non-Negotiable Boundaries

- The current task explicitly forbids restarting T3; continue honoring that limit unless the user gives a new instruction. When a user-authorized reversible source change is ready for installation, use a narrowly scoped, backed-up hot reload where it fits the request and preserve live task state.
- Do not send extra requests through AGY, alter AGY authentication, endpoints, binary, or native app configuration, or initiate AGY model calls.
- Narrow exception authorized on 2026-11-17: remove only the backed-up Hub-managed blocks in the two identified AGY rule files and retire the managed routing Skill. Preserve all other AGY configuration and historical backups; this does not authorize model calls or broader configuration changes.
- Subsequent user-requested Memory onboarding authorizes narrowly scoped registration of the Hub memory MCP for supported local T3 instances. Preserve conflicting custom entries, authentication, models, effort, and native routing; unknown or incompatible instances must remain explicitly pending. This does not authorize extra model requests, remote configuration writes, or changes to other MCP entries.
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
