---
name: project-github-benchmark
description: Use when the user asks to audit the current project against GitHub open-source peers/competitors, find improvement opportunities, visualize a prioritized upgrade roadmap or native-aligned UI prototype, and produce an executable implementation plan.
---

# Project GitHub Benchmark & Visual Roadmap

A structured workflow to benchmark any local repository against real GitHub open-source peers, surface concrete engineering and product improvements, present interactive visualizations aligned with the host app's native UI, and turn approved ideas into an executable implementation plan.

## Workflow

### 1. Ground Truth Local Audit (Read-Only)
Inspect the current workspace and remote repository before searching externally:
- Read `package.json`, `README.md`, recent commits (`git log -n 10 --oneline`), branch alignment against `origin/main`, and open issues/releases via `gh repo view`, `gh release list`, and `gh issue list`.
- Measure source file distribution (`wc -l`) to spot monolithic files, retired/dead modules, and documentation drift.
- Check whether the local working tree lags behind the remote default branch so recommendations never repeat already-shipped features.

### 2. Real GitHub Ecosystem Search (No Guesswork)
Use `gh search repos`, `gh search issues`, `gh search prs`, and `gh release view` (supplemented by web search when needed) across three concentric rings:
1. **Direct ecosystem peers & upstream**: Companion tools, plugins, forks, and upstream release notes / `NOT_PLANNED` issues (which reveal durable differentiators) or active plugin/API PRs (which signal long-term architecture direction).
2. **Adjacent category leaders**: Top starred projects solving overlapping UX pain points (e.g., telemetry HUDs, quota pacing / burn rate, notifications, packaging via Homebrew).
3. **Core subsystem leaders**: Specialized tools for key subsystems (e.g., local memory MCPs, retrieval graphs, update mechanisms).

### 3. Distill Actionable Improvements by Priority
Group findings into concrete, grounded buckets rather than generic advice:
- **P0 Quick Wins**: Repo discovery (GitHub Topics, README screenshots/GIFs), branch alignment, high-signal UX upgrades borrowed from peers.
- **P1 Core & Engineering**: Open issues, modularizing oversized files, archiving retired code, decoupling core data layers from host injection anchors.
- **P2 Ecosystem & Distribution**: Secondary install channels (e.g., Homebrew tap), cross-machine workflows, optional advanced modes.

### 4. Interactive Visual Deliverables (When Requested)
When the user asks for a visual roadmap or UI prototype:
- Build self-contained HTML using host theme CSS variables (`--background`, `--foreground`, `--card`, `--secondary`, `--border`, `--primary`, `--success`, `--warning`, `--info`, `--radius`, `--font-sans`, `--font-mono`) with zero fixed page background and zero `vh`/`height:100%` loops.
- Match the host application's **actual native visual DNA** (hairline borders, spacing, icon style, light/dark parity) rather than generic dashboards.
- Always preview (`html_preview`) and visually inspect the rendered PNG for overlap/clipping before presenting (`html_render`).

### 5. Executable Implementation Plan (`/plan`)
Once priorities and UI direction are aligned:
- Produce a file-level plan grouping changes by component, preserving existing backward-compatibility contracts and test suites, explicitly noting safety boundaries, and verifying with targeted automated tests plus real runtime checks.
- Keep open-source deliverables self-contained: never assume third-party personal managers or private local tools exist on other users' machines.
