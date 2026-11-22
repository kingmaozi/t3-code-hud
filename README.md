# T3 Code HUD (`t3-code-hud`)

![License](https://img.shields.io/badge/license-MIT-green.svg) ![Platform](https://img.shields.io/badge/platform-macOS-informational.svg) ![Electron](https://img.shields.io/badge/electron-injected-blue.svg) ![Non-invasive](https://img.shields.io/badge/non--invasive-✅-brightgreen.svg)

**English** | [简体中文](docs/README.zh-CN.md) | [日本語](docs/README.ja.md) | [한국어](docs/README.ko.md)

Project handoff: [engineering notes](docs/HANDOFF.md) · [development setup](docs/DEVELOPMENT.zh-CN.md) · [requirements and experiments (Chinese)](docs/REQUIREMENTS-AND-EXPERIMENTS.zh-CN.md) · [T3 takeover prompt (Chinese)](docs/T3-HUB-TAKEOVER-PROMPT.zh-CN.md) · [T3 self-test prompt (Chinese)](docs/T3-HUB-SELFTEST-PROMPT.zh-CN.md)

Desktop telemetry, project Memory, current-chat plans, and an interactive Git Graph for **T3 Code / T3 Code (Beta)**.

> Zero modification to `app.asar`, no signature breakage, survives T3 auto-updates. Precise fixes for stock T3 telemetry bugs across **Antigravity / Muse / Codex / Claude** engines: speed misreporting, cache double-counting, context-capacity inflation, and billion-token subagent undercounting.

---

## Why this exists (root-cause fixes)

Stock T3 misreports telemetry in four ways. `t3-code-hud` corrects each at the source:

| Bug | Stock T3 | HUD fix |
|-----|----------|---------|
| **Cache hit rate capped at 50%** | `geminiPromptUsage` adds `cachedInputTokens` twice (both to numerator and denominator) on Antigravity SQLite fallback. | Read native protobuf / JSONL directly (`conversations/*.db`, `session.jsonl`, `sessions/*.jsonl`); dedupe to `uncached + cacheRead + cacheWrite`. |
| **Context ring shows 100% red on `0 tok`** | On `/new` / non-thread routes the UI reuses the previous thread's `live.contextWindow.usedTokens`. | When `!stats.ok`, force `ctxUsed = 0`, `ctxPct = 0`. Never read stale live state. |
| **Artificial `300k` floor** | Antigravity context max was clamped to `Math.max(300000, …)`, inflating usage % and hiding the true `1M / 1,048,576` window. | Removed all `300000` floors. `readAntigravityConvDb` sets `contextMax: null` and inherits the true `statev2 contextUsage.maxTokens` (`1048576` Gemini / `1000000` Claude) with catalog fallback via `lookupCatalogContextMax`. |
| **Billion-token subagent loss** | Recursive `delegate_task` children were undercounted; stale cache keyed only by `updated_at` dropped late WAL turns. | Recursive BFS over `orchestration_v2_projection_subagents` + turn-count/invalidation guard (`SELECT COUNT(*), MAX(updated_at)` per child) + file-parse cache. Mixed-provider threads merge uncovered drivers so zero turns are dropped. |

Additional telemetry correctness:

- **True context window** — `contextUsed` is the last per-call prompt (`promptTotal + output`, deduplicated). Muse inherits `1007997` from `statev2`; Codex reads `model_context_window` from `token_count` events; Antigravity falls back to `1048576` (Gemini) / `1000000` (Claude).
- **Turn speed** — uses the latest completed turn's decode sample, or that turn's effective output duration where available. During streaming, visible-text increments provide an approximate live rate marked `≈`; this is not an exact tokenizer count.
- **OAuth pricing** — reuses T3's official `usage-model-rates.json` (5,900+ models + tiered rates) via `resolveModelRate`.

---

## Features

- **Composer telemetry** (Light/Dark aware):
  - ⚡ Session-average decode speed with the same chat's last measured turn as a fallback. Live estimates are marked `≈`.
  - ♻️ Measured current-turn cache hit rate, with the session aggregate labeled when used.
  - 🧮 Full-tree token total including recursive subagents (supports `B` billions, e.g. `2.34B tok`, warm query `< 8 ms`).
  - 💰 Official-rate equivalent cost with subagent breakdown (`$XX.XX (+N sub)`).
  - ◔ Context ring — true usage % with hover card (`Context Capacity`, progress bar, `Avg Cache Hit Rate`).
- **Header quotas and current-chat plan** — the outer quota ring shows the weekly window and the inner ring shows a verified five-hour window when available. Open the plan next to the title to see the current chat's steps.
- **Project Memory** — open the workspace from the chat title to search and manage memories, test the configured local embedding service, and control local agent access. The Memory MCP can bind automatically to a confirmed T3 project or worktree. See the [Hub guide (Chinese)](docs/HUB-GUIDE.zh-CN.md).
- **Zero-overlap layout** — `isChatComposerVisibleAndUncovered()` hides the HUD on Settings, `/usage`, `/pair`, dialogs/modals, and occluded composers; topbar `z-index: 30` stays below native modals (`50`).
- **Draggable Git Graph floating window** (`Option+G` / `Esc`) — centered 920 × 600 maximum, monochrome vector icon, compact search and repo/status pill. A sticky five-column table shows **Graph / Description / Date / Author / Commit** with orange HEAD rings, separate HEAD/branch pills and `MM/DD HH:mm` timestamps. Click a commit for a bottom split pane with file `+added / -deleted` stats and highlighted unified diff. Below 680px the author column is hidden and date/hash columns compact; narrow capsules keep token/quota details in the hover card. Settings closes the window; native dialogs temporarily hide it. Automatically filters T3-internal `refs/t3/*` snapshot noise.
- **Bilingual auto-detected UI** (`中文` / `English`) with one-click switch — see [i18n guide](#i18n-guide).
- **Remote Server (T3 Connect) support + official `T3 Code v0.1.9` in-memory routing** — threads running on a remote server (`environmentId`) have no local `statev2.sqlite` rows, so telemetry is projected from T3's in-memory React Fiber `projection` and priced by `priceRemoteProjection` (backend) with a client-side `buildLocalProjectionFallback` when the main process is stale. Draft/unsent threads show `New` / `新会话` instead of `-- tok/s`. Remote Git Graph uses the existing authenticated T3 Connect connection to read unpublished commits and native commit diffs, including repositories without a GitHub remote. `t3-hud reload` also upgrades the WebSocket bridge in existing windows without restarting T3. Native history follows first parents; merge connections can be incomplete and the drawer labels this limitation. TanStack Router in-memory routes (`window.__TSR_ROUTER__.state.location.pathname`) hide the HUD on `/settings` / `/usage` / `/pair` even when `location.hash` is empty.
- **Hardened local RPC** — private `~/.t3/hud-plugin/run/rpc.json` (`0700` dir, `0600` file, `wx` + symlink guard), split `rpcToken` (read-only) and `adminToken` (CLI), no `/admin/eval`, strict `t3code://` origin allowlist.

---

## Install

### One-line install (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/kingmaozi/t3-code-hud/main/install.sh | bash
```

> Installs to `~/.t3/hud-plugin`, symlinks `t3-hud` into your `PATH`, and creates `~/Applications/T3 Code HUD.app` (drag to Dock or launch via Spotlight).

Hub Memory is optional. Turn off agent access next to the chat title to keep using an independently configured PowerContext MCP or CLI. Hub Memory's own MCP and CLI require a Node.js installation with `node:sqlite`.

Or clone and install:

```bash
git clone https://github.com/kingmaozi/t3-code-hud.git
cd t3-code-hud
./install.sh
```

When running tasks have finished, enable with one restart:

```bash
t3-hud restart
```

> The script never modifies `/Applications/T3 Code.app` internals. Uninstall = remove `~/.t3/hud-plugin` and restart.

---

## CLI commands

```bash
t3-hud start     # Launch T3 with HUD; preserves an already-running unmounted T3
t3-hud restart   # Graceful restart + remount HUD
t3-hud reload    # Zero-restart hot-reload UI + backend logic (after editing sources)
t3-hud status    # Show PID + mount state + language config
t3-hud lang zh   # Set HUD language to Chinese (persists userLang)
t3-hud lang en   # Set HUD language to English
t3-hud lang auto # Clear explicit choice (auto-detect from T3 UI language)
```

### Shortcuts

- `Option + G`: toggle Git Graph floating window
- `Esc`: close Git Graph floating window

---

## i18n guide

HUD language resolves in this order:

1. **Explicit toggle** — `localStorage["t3-hud-lang"]` or `config.userLang` (`zh` / `en` / `auto`) from the `EN` / `中文` switch in the stats popover header or the Git Graph floating window toolbar, or `t3-hud lang`.
2. **DOM auto-detection** — inspects `document.documentElement.lang` and UI strings (`想问什么` / `本地工作副本` / `新会话` / `设置` → `zh`; `Ask anything` / `Local working copy` / `New thread` / `Settings` → `en`).
3. **Install-time default** — `config.defaultLang` written by `install.sh` from `--lang` / `T3_HUD_LANG` / system locale (`LC_ALL` / `LC_MESSAGES` / `LANG` / AppleLanguages) → fallback `zh`.

Language switch is instant and persists across restarts:

```bash
# Install-time
./install.sh --lang en
T3_HUD_LANG=zh ./install.sh

# Runtime
t3-hud lang en
t3-hud lang zh
t3-hud lang auto
# Or click EN / 中文 in the HUD popover header or Git window toolbar
```

Config: `~/.t3/hud-plugin/config.json` (`{ "defaultLang": "zh"|"en", "userLang": "zh"|"en"|"auto" }`).

---

## Architecture

```
T3 Code.app (Electron, main "browser")
  └─ bootstrap.cjs     spawn --inspect=127.0.0.1:0 → CDP Runtime.evaluate → require(main-hook.cjs) → verify "OK"
       └─ main-hook.cjs
            ├─ Loopback HTTP server (127.0.0.1:0) — rpcToken (GET /rpc) + adminToken (CLI only)
            │    writes ~/.t3/hud-plugin/run/rpc.json (0600, wx, symlink-guarded)
            ├─ IPC: t3hud:get-thread-stats / get-git-graph / get-commit-detail / get-config / set-config
            │    (senderFrame-allowlisted to captured T3 origin)
            └─ injectHudIntoWindow() → window.__t3HudHttpConfig = { url, token: rpcToken } + renderer-ui.js
                 └─ preload-bridge.cjs → window.__t3HudBridge (contextBridge)
                      └─ renderer-ui.js → topbar + popover + Git window (bilingual, zero-overlap)
                           └─ backend.cjs → statev2.sqlite + provider-native files + usage-model-rates.json
```

---

## Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/kingmaozi/t3-code-hud/main/uninstall.sh | bash
# or
./uninstall.sh
```

Uninstall removes `~/.t3/hud-plugin`, the `t3-hud` symlink, `~/Applications/T3 Code HUD.app`, and legacy `/tmp/t3-hud-*.pid/json`. Restart T3 to return to 100% stock.

---

## Security

See [`src/main-hook.cjs`](src/main-hook.cjs), [`src/bootstrap.cjs`](src/bootstrap.cjs), and [`src/backend.cjs`](src/backend.cjs) `getConfig`/`setConfig`. Runtime state lives under `~/.t3/hud-plugin/run/` with `0o700` / `0o600` and `wx` create-or-fail semantics. `/admin/eval` has been removed entirely.

---

## License

[MIT](LICENSE)

### Startup readiness and optional AGY wrapper repair

`start` never restarts an existing unmounted T3. Use `restart` only when active tasks can be interrupted. `status` checks the recorded PID against the authenticated loopback RPC; installing files alone does not activate the current window. Launch from **T3 Code HUD.app** for future sessions. Opening the original app directly does not load the HUD.

T3 Code v0.1.11 translates native controls. HUD v1.0.10 locates the attachment and title buttons through their UI structure, so the statistics strip remains available in localized desktops. If the T3 updater opens a new unmounted process, reopen through **T3 Code HUD.app** once your tasks can be interrupted.

HUD v1.1.1 adds dual Antigravity quota rings (Gemini + Claude/GPT pools), Devin Pro weekly/daily quota rings & native context/speed telemetry, single-provider quota popover cards, a draggable right-edge session artifacts dock, standalone zero-Magpie settings with OpenCode/Devin provider resources and memory access support, full-width single-tab Memory Studio, and a T3 upgrade guardian.

HUD v1.1.2 refines whole-turn token-weighted cache-hit aggregation for Devin and Antigravity (verifying native step totals before legacy double-count deduplication), tightens multi-session native attribution and in-flight pending-step detection, fails closed on invalid custom Devin API server URLs, and adds `XDG_CONFIG_HOME` / `opencode.jsonc` safeguards for Memory access onboarding.

For the macOS ARM64 Antigravity wrapper shutdown issue, the optional `scripts/agy-acp-wrapper-install.py` installs the canonical sibling wrapper, with backups. Run with `--check` first. It requires an executable Homebrew Python at `/opt/homebrew/bin/python3`. It does not change provider settings or restart existing processes. Newly spawned wrappers use the repaired code; already-running wrappers keep their previous code. Keep any existing custom wrapper backup for rollback.

Runtime RPC records are now stored per process (`run/rpc-<pid>.json`). Legacy `rpc.json` is accepted for explicit hot reload only; its older status response cannot prove window readiness, so `status` remains unconfirmed until a restart loads the new hook.
