(() => {
  "use strict";

  if (typeof window.__t3HudCleanup === "function") {
    try {
      window.__t3HudCleanup();
    } catch {}
  }
  if (!document.getElementById("root")) return;
  window.__t3HudInitialized = true;

  // T3 Code Desktop uses hash routing (t3code://app/#/envId/threadId), while web uses pathname
  function getRouteHint() {
    const hash = window.location.hash || "";
    if (hash.startsWith("#/") || hash.length > 1) {
      return hash.slice(1);
    }
    return window.location.pathname || "/";
  }

  // Distinct, clean Git swimlane colors that work well on both stock Light (#fff) and stock Dark (#000/#141414)
  const LANE_COLORS = [
    "#3b82f6", // blue
    "#10b981", // emerald
    "#8b5cf6", // violet
    "#f59e0b", // amber
    "#ec4899", // pink
    "#06b6d4", // cyan
    "#f97316", // orange
    "#6366f1", // indigo
  ];

  function laneColor(lane) {
    return LANE_COLORS[Math.abs(lane) % LANE_COLORS.length];
  }

  // Unified RPC caller: supports live hot-swap override RPC, Electron IPC preload bridge, and loopback HTTP
  async function callBackend(method, ...args) {
    const overrideCfg = window.__t3HudOverrideRpc;
    if (overrideCfg && overrideCfg.url && overrideCfg.token) {
      try {
        const res = await fetch(`${overrideCfg.url}/rpc`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-T3-Hud-Token": overrideCfg.token,
          },
          body: JSON.stringify({ method, args }),
        });
        return await res.json();
      } catch {
        // Fall through to native IPC bridge if override server exited
      }
    }
    if (window.__t3HudBridge && typeof window.__t3HudBridge[method] === "function") {
      return window.__t3HudBridge[method](...args);
    }
    const httpCfg = window.__t3HudHttpConfig;
    if (httpCfg && httpCfg.url && httpCfg.token) {
      const res = await fetch(`${httpCfg.url}/rpc`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-T3-Hud-Token": httpCfg.token,
        },
        body: JSON.stringify({ method, args }),
      });
      return res.json();
    }
    return { ok: false, error: "HUD bridge unavailable" };
  }

  function formatCompactTokens(n) {
    if (n == null || !Number.isFinite(n)) return "--";
    if (n >= 1e9) return (n / 1e9).toFixed(n >= 10e9 ? 1 : 2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 100e6 ? 0 : n >= 10e6 ? 1 : 2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 100e3 ? 0 : 1) + "k";
    return String(Math.round(n));
  }

  function formatWanTokens(n) {
    if (n == null || !Number.isFinite(n)) return "--";
    if (n >= 1e8) return (n / 1e8).toFixed(2).replace(/\.?0+$/, "") + "亿";
    if (n >= 10000) {
      const wan = n / 10000;
      return (wan >= 100 ? Math.round(wan) : wan.toFixed(1).replace(/\.0$/, "")) + "万";
    }
    return Math.round(n).toLocaleString("en-US");
  }

  function formatUsd(v) {
    if (v == null || !Number.isFinite(v)) return "$0.00";
    if (v === 0) return "$0.00";
    if (v < 0.01) return "$" + v.toFixed(4);
    if (v < 1) return "$" + v.toFixed(3);
    return "$" + v.toFixed(2);
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Inject stock-themed styles matching T3 Code's original light & dark CSS variables
  const styleEl = document.createElement("style");
  styleEl.id = "t3-hud-styles";
  styleEl.textContent = `
    .t3-hud-composer-spaced {
      padding-top: 32px !important;
    }

    /* Hide T3's redundant right-sidebar quota & context sections while keeping React Fiber live */
    section:has(#thread-details-usage-heading),
    section:has(#thread-details-context-heading) {
      display: none !important;
    }

    #t3-hud-root {
      --hud-bg: color-mix(in srgb, var(--popover, #ffffff) 94%, transparent);
      --hud-bg-solid: var(--popover, #ffffff);
      --hud-fg: var(--foreground, #262626);
      --hud-muted: var(--muted-foreground, #737373);
      --hud-surface: var(--muted, #f4f4f5);
      --hud-border: var(--border, rgba(0, 0, 0, 0.1));
      --hud-hover: color-mix(in srgb, var(--foreground, #262626) 7%, transparent);
      --hud-shadow: 0 8px 30px rgba(0, 0, 0, 0.12), 0 1px 3px rgba(0, 0, 0, 0.06);
      font-family: -apple-system, BlinkMacSystemFont, "Inter Variable", "Segoe UI", system-ui, sans-serif;
      color: var(--hud-fg);
      pointer-events: none;
      position: fixed;
      inset: 0;
      z-index: 9990;
    }
    html.dark #t3-hud-root {
      --hud-bg: color-mix(in srgb, var(--popover, #141414) 94%, transparent);
      --hud-bg-solid: var(--popover, #141414);
      --hud-fg: var(--foreground, #f5f5f5);
      --hud-muted: var(--muted-foreground, #a3a3a3);
      --hud-surface: var(--muted, #222222);
      --hud-border: var(--border, rgba(255, 255, 255, 0.12));
      --hud-hover: color-mix(in srgb, var(--foreground, #f5f5f5) 9%, transparent);
      --hud-shadow: 0 14px 40px rgba(0, 0, 0, 0.55), 0 1px 3px rgba(0, 0, 0, 0.35);
    }

    #t3-hud-topbar {
      pointer-events: auto;
      -webkit-app-region: no-drag;
      position: fixed;
      display: inline-flex;
      align-items: center;
      gap: 2px;
      height: 25px;
      padding: 0 7px;
      border-radius: 999px;
      background: var(--hud-bg);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid var(--hud-border);
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.04);
      font-size: 11.5px;
      line-height: 1;
      user-select: none;
      transition: opacity 0.15s ease;
      max-width: calc(100vw - 80px);
    }
    #t3-hud-topbar.is-hidden {
      display: none !important;
    }

    .t3-hud-metric {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      height: 20px;
      padding: 0 5.5px;
      border-radius: 999px;
      color: var(--hud-fg);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
      cursor: default;
      transition: background 0.12s ease;
    }
    .t3-hud-ring-svg {
      width: 14px;
      height: 14px;
      display: block;
      flex: none;
      transform: rotate(-90deg);
    }
    .t3-ctx-bar-track {
      height: 7px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--hud-fg) 10%, transparent);
      overflow: hidden;
      margin: 9px 0 10px 0;
    }
    .t3-ctx-bar-fill {
      height: 100%;
      border-radius: 999px;
      background: var(--hud-fg);
      transition: width 0.2s ease;
    }
    .t3-ctx-bar-fill.warn { background: #f59e0b; }
    .t3-ctx-bar-fill.err { background: #ef4444; }
    .t3-hud-metric:hover {
      background: var(--hud-hover);
    }
    .t3-hud-metric .lbl {
      color: var(--hud-muted);
      font-size: 10.5px;
    }
    .t3-hud-metric .val {
      font-weight: 500;
    }
    .t3-hud-sep {
      width: 1px;
      height: 12px;
      background: var(--hud-border);
      margin: 0 1px;
      flex: none;
    }

    .t3-hud-dot {
      width: 6px;
      height: 6px;
      border-radius: 999px;
      background: var(--hud-muted);
      flex: none;
    }
    .t3-hud-dot.running {
      background: #10b981;
      box-shadow: 0 0 0 2px rgba(16, 185, 129, 0.25);
      animation: t3HudPulse 1.2s ease-in-out infinite;
    }
    .t3-hud-dot.ready {
      background: #3b82f6;
    }
    @keyframes t3HudPulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.45; transform: scale(0.85); }
    }

    #t3-hud-git-btn {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      height: 21px;
      padding: 0 7px;
      border-radius: 5px;
      border: 0;
      background: transparent;
      color: var(--hud-fg);
      font: inherit;
      font-size: 11.5px;
      font-weight: 500;
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.12s ease, color 0.12s ease;
    }
    #t3-hud-git-btn:hover {
      background: var(--hud-hover);
    }
    #t3-hud-git-btn.active {
      background: color-mix(in srgb, #3b82f6 15%, transparent);
      color: #3b82f6;
    }
    html.dark #t3-hud-git-btn.active {
      background: color-mix(in srgb, #60a5fa 18%, transparent);
      color: #60a5fa;
    }
    .t3-hud-branch-text {
      max-width: 110px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .t3-hud-dirty-dot {
      font-size: 10px;
      padding: 1px 4px;
      border-radius: 4px;
      background: color-mix(in srgb, #f59e0b 18%, transparent);
      color: #d97706;
      font-variant-numeric: tabular-nums;
    }
    html.dark .t3-hud-dirty-dot {
      color: #fbbf24;
    }

    /* Hover breakdown card above bottom HUD capsule */
    #t3-hud-popover {
      pointer-events: none;
      position: fixed;
      width: 324px;
      padding: 10px 12px;
      border-radius: 10px;
      background: var(--hud-bg-solid);
      border: 1px solid var(--hud-border);
      box-shadow: var(--hud-shadow);
      font-size: 11.5px;
      line-height: 1.5;
      opacity: 0;
      transform: translateY(3px);
      transition: opacity 0.12s ease, transform 0.12s ease;
      z-index: 9999;
    }
    #t3-hud-popover.visible {
      opacity: 1;
      transform: translateY(0);
    }
    .t3-pop-sec-hdr {
      font-size: 10.5px;
      font-weight: 600;
      color: var(--hud-muted);
      margin-top: 7px;
      margin-bottom: 3px;
      padding-top: 6px;
      border-top: 1px solid var(--hud-border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .t3-quota-row {
      display: grid;
      grid-template-columns: minmax(0, 1.35fr) minmax(48px, 0.8fr) auto;
      align-items: center;
      gap: 8px;
      padding: 2px 0;
      font-variant-numeric: tabular-nums;
    }
    .t3-quota-lbl {
      color: var(--hud-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 11px;
    }
    .t3-quota-track {
      height: 4px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--hud-fg) 12%, transparent);
      overflow: hidden;
    }
    .t3-quota-fill {
      height: 100%;
      border-radius: 999px;
      background: var(--hud-fg);
    }
    .t3-quota-fill.warn { background: #f59e0b; }
    .t3-quota-fill.err { background: #ef4444; }
    .t3-quota-val {
      font-weight: 500;
      font-size: 11px;
      text-align: right;
      min-width: 32px;
    }
    .t3-quota-val.warn { color: #d97706; }
    html.dark .t3-quota-val.warn { color: #fbbf24; }
    .t3-quota-val.err { color: #ef4444; }
    .t3-pop-title {
      font-weight: 600;
      font-size: 12px;
      margin-bottom: 6px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      border-bottom: 1px solid var(--hud-border);
      padding-bottom: 5px;
    }
    .t3-pop-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      padding: 1.5px 0;
      font-variant-numeric: tabular-nums;
    }
    .t3-pop-row span:first-child {
      color: var(--hud-muted);
    }
    .t3-pop-row span:last-child {
      font-weight: 500;
    }

    /* Right-side Floating Git Graph Drawer */
    #t3-hud-git-drawer {
      pointer-events: auto;
      -webkit-app-region: no-drag;
      position: fixed;
      top: 48px;
      right: 12px;
      bottom: 14px;
      width: 460px;
      max-width: calc(100vw - 24px);
      display: flex;
      flex-direction: column;
      border-radius: 11px;
      background: var(--hud-bg-solid);
      border: 1px solid var(--hud-border);
      box-shadow: var(--hud-shadow);
      overflow: hidden;
      z-index: 9995;
      transition: width 0.18s ease, opacity 0.15s ease, transform 0.15s ease;
    }
    #t3-hud-git-drawer.wide {
      width: 680px;
    }
    #t3-hud-git-drawer.closed {
      opacity: 0;
      pointer-events: none;
      transform: translateX(14px);
    }

    .t3-git-hdr {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 9px 12px;
      border-bottom: 1px solid var(--hud-border);
      background: var(--hud-surface);
      cursor: grab;
      user-select: none;
    }
    .t3-git-hdr:active {
      cursor: grabbing;
    }
    .t3-git-hdr-left {
      display: flex;
      align-items: center;
      gap: 7px;
      min-width: 0;
      flex: 1;
    }
    .t3-git-repo {
      font-weight: 600;
      font-size: 12.5px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .t3-git-branch-pill {
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 5px;
      background: color-mix(in srgb, #3b82f6 14%, transparent);
      color: #2563eb;
      font-weight: 500;
      white-space: nowrap;
      max-width: 150px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    html.dark .t3-git-branch-pill {
      color: #60a5fa;
    }
    .t3-git-hdr-actions {
      display: flex;
      align-items: center;
      gap: 4px;
      flex: none;
    }
    .t3-git-icon-btn {
      border: 1px solid transparent;
      background: transparent;
      color: var(--hud-muted);
      width: 25px;
      height: 25px;
      border-radius: 5px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-size: 12px;
      transition: background 0.12s, color 0.12s;
    }
    .t3-git-icon-btn:hover {
      background: var(--hud-hover);
      color: var(--hud-fg);
    }

    .t3-git-subbar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border-bottom: 1px solid var(--hud-border);
      font-size: 11px;
    }
    .t3-git-search {
      flex: 1;
      min-width: 0;
      height: 24px;
      padding: 0 8px;
      border-radius: 5px;
      border: 1px solid var(--hud-border);
      background: transparent;
      color: var(--hud-fg);
      font: inherit;
      font-size: 11.5px;
      outline: none;
    }
    .t3-git-search:focus {
      border-color: #3b82f6;
    }
    .t3-git-status-badge {
      font-size: 10.5px;
      color: var(--hud-muted);
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }

    .t3-git-list {
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
    }
    .t3-git-row {
      display: flex;
      align-items: stretch;
      min-height: 30px;
      padding-right: 10px;
      cursor: pointer;
      border-bottom: 1px solid color-mix(in srgb, var(--hud-border) 45%, transparent);
      transition: background 0.1s ease;
    }
    .t3-git-row:hover {
      background: var(--hud-hover);
    }
    .t3-git-row.selected {
      background: color-mix(in srgb, #3b82f6 11%, transparent);
    }
    .t3-git-graph-cell {
      flex: none;
      display: flex;
      align-items: center;
      padding-left: 6px;
    }
    .t3-git-main-cell {
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 4px 0 4px 4px;
      font-size: 12px;
    }
    .t3-git-ref {
      font-size: 10px;
      font-weight: 600;
      padding: 1px 5px;
      border-radius: 4px;
      white-space: nowrap;
      flex: none;
      max-width: 135px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .t3-git-ref.head {
      background: color-mix(in srgb, #10b981 18%, transparent);
      color: #059669;
      border: 1px solid color-mix(in srgb, #10b981 35%, transparent);
    }
    html.dark .t3-git-ref.head {
      color: #34d399;
    }
    .t3-git-ref.branch {
      background: color-mix(in srgb, #3b82f6 16%, transparent);
      color: #2563eb;
    }
    html.dark .t3-git-ref.branch {
      color: #60a5fa;
    }
    .t3-git-ref.remote {
      background: var(--hud-surface);
      color: var(--hud-muted);
      border: 1px solid var(--hud-border);
    }
    .t3-git-ref.tag {
      background: color-mix(in srgb, #f59e0b 18%, transparent);
      color: #d97706;
    }
    html.dark .t3-git-ref.tag {
      color: #fbbf24;
    }

    .t3-git-subj {
      flex: 1;
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--hud-fg);
    }
    .t3-git-meta {
      flex: none;
      display: flex;
      align-items: center;
      gap: 6px;
      color: var(--hud-muted);
      font-size: 10.5px;
      font-variant-numeric: tabular-nums;
    }
    .t3-git-sha {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 10.5px;
      opacity: 0.85;
    }

    /* Commit detail split pane inside drawer */
    #t3-hud-commit-pane {
      border-top: 1px solid var(--hud-border);
      background: var(--hud-surface);
      max-height: 44%;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    #t3-hud-commit-pane.hidden {
      display: none;
    }
    .t3-commit-hdr {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 8px;
      padding: 8px 10px 6px;
      border-bottom: 1px solid var(--hud-border);
      font-size: 11.5px;
    }
    .t3-commit-msg {
      font-weight: 600;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 54px;
      overflow-y: auto;
    }
    .t3-commit-body {
      flex: 1;
      overflow: auto;
      padding: 6px 10px 10px;
      font-size: 11px;
    }
    .t3-commit-file {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      padding: 2px 0;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px;
    }
    .t3-commit-file-path {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .t3-diff-add { color: #16a34a; }
    .t3-diff-del { color: #dc2626; }
    html.dark .t3-diff-add { color: #4ade80; }
    html.dark .t3-diff-del { color: #f87171; }
    .t3-patch-box {
      margin-top: 8px;
      padding: 6px 8px;
      border-radius: 6px;
      border: 1px solid var(--hud-border);
      background: var(--hud-bg-solid);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 10.5px;
      line-height: 1.45;
      overflow-x: auto;
      white-space: pre;
    }
    .t3-patch-hunk { color: #3b82f6; }
    .t3-empty-msg {
      padding: 28px 16px;
      text-align: center;
      color: var(--hud-muted);
      font-size: 12px;
    }
  `;
  document.head.appendChild(styleEl);

  const root = document.createElement("div");
  root.id = "t3-hud-root";
  // Circumference for r=5.2 circle: 2 * pi * 5.2 = 32.67
  const RING_CIRC = 32.67;

  root.innerHTML = `
    <div id="t3-hud-topbar" class="is-hidden">
      <div class="t3-hud-metric" data-hud-hover="stats">
        <span id="t3-hud-dot" class="t3-hud-dot"></span>
        <span id="t3-hud-speed" class="val">-- tok/s</span>
      </div>
      <span class="t3-hud-sep"></span>
      <div class="t3-hud-metric" data-hud-hover="stats">
        <span class="lbl">累计缓存</span>
        <span id="t3-hud-cache" class="val">--%</span>
      </div>
      <span class="t3-hud-sep"></span>
      <div class="t3-hud-metric" data-hud-hover="stats">
        <span id="t3-hud-tokens" class="val">0 tok</span>
      </div>
      <span class="t3-hud-sep"></span>
      <div class="t3-hud-metric" data-hud-hover="stats">
        <span id="t3-hud-cost" class="val">$0.00</span>
      </div>
      <span id="t3-hud-quota-sep" class="t3-hud-sep" style="display:none"></span>
      <div id="t3-hud-quota-item" class="t3-hud-metric" data-hud-hover="stats" style="display:none">
        <span class="lbl">周余</span>
        <span id="t3-hud-quota" class="val">--%</span>
      </div>
      <span class="t3-hud-sep"></span>
      <div id="t3-hud-ctx-item" class="t3-hud-metric" data-hud-hover="context" style="gap:4.5px">
        <svg class="t3-hud-ring-svg" viewBox="0 0 14 14" aria-hidden="true">
          <circle cx="7" cy="7" r="5.2" fill="none" stroke="color-mix(in srgb, var(--hud-fg) 16%, transparent)" stroke-width="2.1" />
          <circle id="t3-hud-ring-arc" cx="7" cy="7" r="5.2" fill="none" stroke="var(--hud-fg)" stroke-width="2.1" stroke-linecap="round" stroke-dasharray="${RING_CIRC}" stroke-dashoffset="${RING_CIRC}" />
        </svg>
        <span id="t3-hud-ctx-pct" class="val">--%</span>
      </div>
      <span class="t3-hud-sep"></span>
      <button id="t3-hud-git-btn" type="button" title="打开/关闭右侧 Git 图谱悬浮窗 (Option+G)">
        <span>🌿</span>
        <span id="t3-hud-branch" class="t3-hud-branch-text">图谱</span>
        <span id="t3-hud-dirty" class="t3-hud-dirty-dot" style="display:none"></span>
      </button>
    </div>

    <div id="t3-hud-popover"></div>

    <aside id="t3-hud-git-drawer" class="closed" aria-label="Git 图谱悬浮窗">
      <div class="t3-git-hdr" id="t3-git-drag-handle">
        <div class="t3-git-hdr-left">
          <span>🌿</span>
          <span class="t3-git-repo" id="t3-git-repo-title">Git 图谱</span>
          <span class="t3-git-branch-pill" id="t3-git-branch-pill">HEAD</span>
        </div>
        <div class="t3-git-hdr-actions">
          <button class="t3-git-icon-btn" id="t3-git-refresh" type="button" title="刷新图谱">↻</button>
          <button class="t3-git-icon-btn" id="t3-git-wide" type="button" title="切换宽/窄视图">⇔</button>
          <button class="t3-git-icon-btn" id="t3-git-close" type="button" title="关闭 (Esc)">✕</button>
        </div>
      </div>
      <div class="t3-git-subbar">
        <input id="t3-git-search-input" class="t3-git-search" type="text" placeholder="过滤提交说明 / 分支 / 作者 / SHA..." />
        <span id="t3-git-worktree-status" class="t3-git-status-badge"></span>
      </div>
      <div class="t3-git-list" id="t3-git-list">
        <div class="t3-empty-msg">正在加载 Git 图谱...</div>
      </div>
      <div id="t3-hud-commit-pane" class="hidden">
        <div class="t3-commit-hdr">
          <div style="min-width:0;flex:1">
            <div class="t3-commit-msg" id="t3-commit-msg"></div>
            <div style="color:var(--hud-muted);font-size:10.5px;margin-top:2px" id="t3-commit-meta"></div>
          </div>
          <button class="t3-git-icon-btn" id="t3-commit-close" type="button" title="收起详情">✕</button>
        </div>
        <div class="t3-commit-body" id="t3-commit-body"></div>
      </div>
    </aside>
  `;
  document.body.appendChild(root);
  document.querySelectorAll(".t3-hud-details-section").forEach((el) => el.remove());

  const topbar = document.getElementById("t3-hud-topbar");
  const dotEl = document.getElementById("t3-hud-dot");
  const speedEl = document.getElementById("t3-hud-speed");
  const cacheEl = document.getElementById("t3-hud-cache");
  const tokensEl = document.getElementById("t3-hud-tokens");
  const costEl = document.getElementById("t3-hud-cost");
  const quotaSepEl = document.getElementById("t3-hud-quota-sep");
  const quotaItemEl = document.getElementById("t3-hud-quota-item");
  const quotaEl = document.getElementById("t3-hud-quota");
  const ringArcEl = document.getElementById("t3-hud-ring-arc");
  const ctxPctEl = document.getElementById("t3-hud-ctx-pct");
  const branchBtnText = document.getElementById("t3-hud-branch");
  const dirtyBadge = document.getElementById("t3-hud-dirty");
  const gitBtn = document.getElementById("t3-hud-git-btn");
  const popover = document.getElementById("t3-hud-popover");

  const drawer = document.getElementById("t3-hud-git-drawer");
  const repoTitleEl = document.getElementById("t3-git-repo-title");
  const branchPillEl = document.getElementById("t3-git-branch-pill");
  const statusBadgeEl = document.getElementById("t3-git-worktree-status");
  const gitListEl = document.getElementById("t3-git-list");
  const searchInput = document.getElementById("t3-git-search-input");
  const commitPane = document.getElementById("t3-hud-commit-pane");
  const commitMsgEl = document.getElementById("t3-commit-msg");
  const commitMetaEl = document.getElementById("t3-commit-meta");
  const commitBodyEl = document.getElementById("t3-commit-body");

  let latestStats = null;
  let liveStreamTps = null;
  let latestGraph = null;
  let drawerOpen = false;
  let selectedCommitHash = null;
  let currentPathHint = getRouteHint();
  let lastLoadedGraphThreadId = null;
  let customDrawerPos = null;
  let spacedComposerStack = null;

  let lastLayoutState = { hidden: null, top: "", left: "", right: "", drawerTop: "" };
  let observedHeader = null;
  let observedChatCol = null;
  let observedComposer = null;
  const layoutResizeObserver =
    typeof ResizeObserver === "function"
      ? new ResizeObserver(() => {
          scheduleLayoutSync();
        })
      : null;

  function ensureLayoutObservers(header, chatCol, composer) {
    if (!layoutResizeObserver) return;
    if (header !== observedHeader || chatCol !== observedChatCol || composer !== observedComposer) {
      layoutResizeObserver.disconnect();
      observedHeader = header || null;
      observedChatCol = chatCol || null;
      observedComposer = composer || null;
      if (observedHeader) layoutResizeObserver.observe(observedHeader);
      if (observedChatCol) layoutResizeObserver.observe(observedChatCol);
      if (observedComposer) layoutResizeObserver.observe(observedComposer);
    }
  }

  function setComposerTopSpacing(stackEl) {
    if (spacedComposerStack && spacedComposerStack !== stackEl) {
      spacedComposerStack.classList.remove("t3-hud-composer-spaced");
      spacedComposerStack = null;
    }
    if (stackEl && !stackEl.classList.contains("t3-hud-composer-spaced")) {
      stackEl.classList.add("t3-hud-composer-spaced");
    }
    spacedComposerStack = stackEl || null;
  }

  // Position HUD capsule centered directly ABOVE the chat composer box!
  function updateLayoutPosition() {
    if (document.hidden) return;
    const header = document.querySelector("header[data-chat-header]");
    const chatCol = document.querySelector("[data-chat-column]");
    const composer = document.querySelector('[data-slot="composer-shell"]');
    ensureLayoutObservers(header, chatCol, composer);

    if (!chatCol && !header) {
      setComposerTopSpacing(null);
      if (lastLayoutState.hidden !== true) {
        topbar.classList.add("is-hidden");
        lastLayoutState.hidden = true;
      }
      return;
    }

    const hRect = header ? header.getBoundingClientRect() : null;
    const cRect = chatCol ? chatCol.getBoundingClientRect() : null;
    if ((cRect && cRect.width < 120) || (hRect && hRect.width < 120)) {
      setComposerTopSpacing(null);
      if (lastLayoutState.hidden !== true) {
        topbar.classList.add("is-hidden");
        lastLayoutState.hidden = true;
      }
      return;
    }

    if (lastLayoutState.hidden !== false) {
      topbar.classList.remove("is-hidden");
      lastLayoutState.hidden = false;
    }

    const tbWidth = topbar.offsetWidth || 440;
    let nextTop = "";
    let nextLeft = "";
    let nextRight = "auto";

    if (composer) {
      const stackEl = composer.closest('[class*="group/composer-stack"]');
      setComposerTopSpacing(stackEl);
      const inputSurface = composer.children[0] || composer;
      const sRect = inputSurface.getBoundingClientRect();
      if (sRect.width > 120) {
        const centerLeft = (sRect.left + sRect.right - tbWidth) / 2;
        const minLeft = cRect ? cRect.left + 8 : 12;
        const maxLeft = cRect ? cRect.right - tbWidth - 8 : window.innerWidth - tbWidth - 12;
        nextTop = `${Math.max(46, Math.round(sRect.top - 30))}px`;
        nextLeft = `${Math.round(Math.max(minLeft, Math.min(maxLeft, centerLeft)))}px`;
      }
    }

    if (!nextTop && hRect) {
      setComposerTopSpacing(null);
      nextTop = `${Math.round(hRect.top + (hRect.height - 25) / 2)}px`;
      nextLeft = "auto";
      nextRight = "112px";
    }

    if (lastLayoutState.top !== nextTop) {
      topbar.style.top = nextTop;
      lastLayoutState.top = nextTop;
    }
    if (lastLayoutState.left !== nextLeft) {
      topbar.style.left = nextLeft;
      lastLayoutState.left = nextLeft;
    }
    if (lastLayoutState.right !== nextRight) {
      topbar.style.right = nextRight;
      lastLayoutState.right = nextRight;
    }

    if (!customDrawerPos && drawerOpen) {
      const nextDrawerTop = hRect ? `${Math.max(44, Math.round(hRect.bottom + 6))}px` : "52px";
      if (lastLayoutState.drawerTop !== nextDrawerTop) {
        drawer.style.top = nextDrawerTop;
        drawer.style.right = "14px";
        drawer.style.left = "auto";
        lastLayoutState.drawerTop = nextDrawerTop;
      }
    }
  }

  // Draggable floating drawer support
  let cleanupDragListeners = null;
  (() => {
    const handle = document.getElementById("t3-git-drag-handle");
    let startX = 0;
    let startY = 0;
    let origLeft = 0;
    let origTop = 0;

    function onMouseMove(e) {
      const nextLeft = Math.max(8, Math.min(window.innerWidth - 120, origLeft + (e.clientX - startX)));
      const nextTop = Math.max(8, Math.min(window.innerHeight - 80, origTop + (e.clientY - startY)));
      customDrawerPos = { left: nextLeft, top: nextTop };
      drawer.style.left = `${nextLeft}px`;
      drawer.style.top = `${nextTop}px`;
      drawer.style.right = "auto";
    }

    function stopDrag() {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", stopDrag);
      cleanupDragListeners = null;
    }

    handle.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      const rect = drawer.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      origLeft = rect.left;
      origTop = rect.top;
      stopDrag();
      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", stopDrag);
      cleanupDragListeners = stopDrag;
      e.preventDefault();
    });
  })();

  // Live reader of T3's in-memory usageLimits, contextWindow, AND active composer model picker!
  function readLiveT3State() {
    let usage = null;
    let selectedModel = null;
    let selectedProvider = null;
    try {
      const rootEl = document.getElementById("root");
      if (!rootEl) return { usage, selectedModel, selectedProvider };
      const fk = Object.keys(rootEl).find(
        (k) => k.startsWith("__reactContainer") || k.startsWith("__reactFiber")
      );
      if (!fk) return { usage, selectedModel, selectedProvider };
      const stack = [rootEl[fk]];
      let visited = 0;
      while (stack.length && visited < 2600) {
        const f = stack.pop();
        if (!f) continue;
        visited++;
        const p = f.memoizedProps;
        if (p) {
          if (!usage && p.usage && Array.isArray(p.usage.providers)) {
            usage = p.usage;
          }
          if (!selectedModel && typeof p.selectedModel === "string") {
            selectedModel = p.selectedModel;
            selectedProvider = p.selectedProvider || selectedProvider;
          } else if (!selectedModel && p.modelSelection && typeof p.modelSelection.model === "string") {
            selectedModel = p.modelSelection.model;
            selectedProvider = p.modelSelection.instanceId || p.modelSelection.provider || selectedProvider;
          }
        }
        if (usage && selectedModel) break;
        if (f.child) stack.push(f.child);
        if (f.sibling) stack.push(f.sibling);
      }
    } catch {}
    return { usage, selectedModel, selectedProvider };
  }

  function formatResetShort(isoStr) {
    if (!isoStr) return "";
    const ms = Date.parse(isoStr) - Date.now();
    if (!Number.isFinite(ms) || ms <= 0) return "";
    const mins = Math.round(ms / 60000);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 48) {
      const remM = mins % 60;
      return remM > 0 && hrs < 12 ? `${hrs}h${remM}m` : `${hrs}h`;
    }
    return `${(ms / 86400000).toFixed(1)}d`;
  }

  function computeQuotaAndContext(stats) {
    const { usage: live, selectedModel, selectedProvider } = readLiveT3State();
    const activeProviderRaw = (
      selectedProvider ||
      live?.providerInstanceId ||
      stats?.provider ||
      ""
    ).toLowerCase();
    // Prefer live composer-selected model so switching Gemini <-> Opus/Sonnet updates 周余 immediately!
    const activeModelRaw = (selectedModel || stats?.model || "").toLowerCase();

    // Prefer backend's deduplicated native contextUsed & empirical contextMax (e.g., AGY 300k ceiling)
    // so we NEVER display T3's 2x geminiPromptUsage double-counted bug!
    const ctxUsed = stats?.tokens?.contextUsed ?? live?.contextWindow?.usedTokens ?? null;
    const ctxMax =
      activeProviderRaw === "antigravity"
        ? Math.max(300000, ctxUsed || 0)
        : stats?.tokens?.contextMax ?? live?.contextWindow?.maxTokens ?? null;
    const ctxPct =
      ctxUsed != null && ctxMax > 0 ? Math.max(0, Math.min(100, (ctxUsed / ctxMax) * 100)) : null;

    if (!live || !Array.isArray(live.providers)) {
      return {
        primaryWeekly: null,
        currentWindows: [],
        otherWindows: [],
        ctxUsed,
        ctxMax,
        ctxPct,
        activeModelRaw,
        activeProviderRaw,
      };
    }

    const activeProv =
      live.providers.find(
        (p) => p.instanceId?.toLowerCase() === activeProviderRaw && p.usageLimits?.windows?.length
      ) ||
      live.providers.find(
        (p) => p.driver?.toLowerCase() === activeProviderRaw && p.usageLimits?.windows?.length
      ) ||
      null;

    const toWinItem = (w, prefix = "") => {
      const rem = Math.max(0, Math.min(100, Math.round(100 - (Number(w.usedPercent) || 0))));
      const tone = rem <= 10 ? "err" : rem <= 25 ? "warn" : "";
      const reset = formatResetShort(w.resetsAt);
      const rawLbl = String(w.label || w.id || "Quota").replace(" (shared)", "");
      return {
        id: String(w.id || ""),
        kind: w.kind,
        label: prefix ? `${prefix} · ${rawLbl}` : rawLbl,
        remainingPct: rem,
        tone,
        reset,
      };
    };

    const currentWindows = (activeProv?.usageLimits?.windows || []).map((w) => toWinItem(w));

    let primaryWeekly = null;
    const weeklyCandidates = currentWindows.filter(
      (w) => w.kind === "weekly" || /weekly/i.test(w.label)
    );
    if (weeklyCandidates.length === 1) {
      primaryWeekly = weeklyCandidates[0];
    } else if (weeklyCandidates.length > 1) {
      const isThirdPartyModel = /opus|sonnet|haiku|claude|gpt|o1\b|o3\b|o4\b/i.test(activeModelRaw);
      if (isThirdPartyModel) {
        primaryWeekly =
          weeklyCandidates.find((w) => /claude|gpt|3p/i.test(w.label) || /3p/i.test(w.id)) ||
          weeklyCandidates[0];
      } else {
        primaryWeekly =
          weeklyCandidates.find((w) => /gemini/i.test(w.label) || /gemini/i.test(w.id)) ||
          weeklyCandidates[0];
      }
    }

    const otherWindows = [];
    const provDisplayName = { muse: "Muse", codex: "Codex", antigravity: "AGY", claudeAgent: "Claude" };
    for (const p of live.providers) {
      if (p === activeProv || !p.usageLimits?.windows?.length) continue;
      const pName = provDisplayName[p.driver] || provDisplayName[p.instanceId] || p.instanceId;
      for (const w of p.usageLimits.windows) {
        otherWindows.push(toWinItem(w, pName));
      }
    }

    return {
      primaryWeekly,
      currentWindows,
      otherWindows,
      ctxUsed,
      ctxMax,
      ctxPct,
      activeModelRaw,
      activeProviderRaw,
    };
  }

  function renderQuotaRowsHtml(items) {
    return items
      .map((q) => {
        const rstTxt = q.reset
          ? ` <span style="color:var(--hud-muted);font-weight:400;font-size:10px">(${escapeHtml(q.reset)})</span>`
          : "";
        return `
          <div class="t3-quota-row">
            <span class="t3-quota-lbl" title="${escapeHtml(q.label)}">${escapeHtml(q.label)}</span>
            <div class="t3-quota-track"><div class="t3-quota-fill ${q.tone}" style="width:${q.remainingPct}%"></div></div>
            <span class="t3-quota-val ${q.tone}">${q.remainingPct}%${rstTxt}</span>
          </div>
        `;
      })
      .join("");
  }

  function renderContextRingPopover() {
    const qInfo = computeQuotaAndContext(latestStats);
    const s = latestStats && latestStats.ok ? latestStats : null;
    const usedTxt = qInfo.ctxUsed != null ? formatWanTokens(qInfo.ctxUsed) : "0";
    const maxTxt = qInfo.ctxMax != null ? formatWanTokens(qInfo.ctxMax) : "30万";
    const pctNum = qInfo.ctxPct != null ? qInfo.ctxPct : 0;
    const pctTxt = qInfo.ctxPct != null ? `${qInfo.ctxPct.toFixed(1)}%` : "0.0%";
    const barTone = pctNum >= 90 ? "err" : pctNum >= 75 ? "warn" : "";
    const avgCacheTxt =
      s && s.cache.sessionRate != null ? `${(s.cache.sessionRate * 100).toFixed(1)}%` : "--";

    popover.style.width = "268px";
    popover.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;font-variant-numeric:tabular-nums">
        <span style="font-weight:600;font-size:13px;color:var(--hud-fg)">上下文容量</span>
        <span style="font-size:12px;color:var(--hud-muted)">${escapeHtml(usedTxt)}/${escapeHtml(maxTxt)} (${escapeHtml(pctTxt)})</span>
      </div>
      <div class="t3-ctx-bar-track">
        <div class="t3-ctx-bar-fill ${barTone}" style="width:${Math.min(100, Math.max(0, pctNum)).toFixed(1)}%"></div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;font-variant-numeric:tabular-nums;font-size:12px">
        <span style="color:var(--hud-muted)">平均缓存命中率</span>
        <span style="font-weight:600;color:var(--hud-fg)">${escapeHtml(avgCacheTxt)}</span>
      </div>
    `;
  }

  function renderStatsPopover() {
    popover.style.width = "324px";
    const qInfo = computeQuotaAndContext(latestStats);
    const allQuotasHtml =
      qInfo.currentWindows.length || qInfo.otherWindows.length
        ? `
          ${
            qInfo.currentWindows.length
              ? `<div class="t3-pop-sec-hdr"><span>当前引擎额度剩余</span><span>重置倒计时</span></div>
                 ${renderQuotaRowsHtml(qInfo.currentWindows)}`
              : ""
          }
          ${
            qInfo.otherWindows.length
              ? `<div class="t3-pop-sec-hdr"><span>其他引擎额度速览</span><span>剩余</span></div>
                 ${renderQuotaRowsHtml(qInfo.otherWindows)}`
              : ""
          }
        `
        : "";

    if (!latestStats || !latestStats.ok) {
      popover.innerHTML = `<div class="t3-pop-title"><span>新会话 / 待发消息</span></div>
        <div style="color:var(--hud-muted)">发送首条消息后将实时显示该会话的速度、累计缓存命中率、会话 Token 与等效费用。</div>
        ${allQuotasHtml}`;
      return;
    }

    const s = latestStats;
    const shownModel = qInfo.activeModelRaw || s.model;
    const providerBadge = [qInfo.activeProviderRaw || s.provider, shownModel].filter(Boolean).join(" · ") || "未知模型";
    const ctxLine =
      qInfo.ctxUsed != null
        ? `${formatWanTokens(qInfo.ctxUsed)} / ${formatWanTokens(qInfo.ctxMax)}${qInfo.ctxPct != null ? ` (${qInfo.ctxPct.toFixed(1)}%)` : ""}`
        : "--";

    const lastCache = s.cache.lastTurnRate != null ? (s.cache.lastTurnRate * 100).toFixed(1) + "%" : "--";
    const sessCache = s.cache.sessionRate != null ? (s.cache.sessionRate * 100).toFixed(1) + "%" : "--";
    const primarySpd = liveStreamTps ?? s.speed.lastDecodeTps ?? s.speed.tokPerSec;
    const speedDetail =
      primarySpd != null
        ? `${primarySpd.toFixed(1)} tok/s${s.speed.tokPerSec != null ? ` (均 ${s.speed.tokPerSec.toFixed(1)})` : ""}`
        : "--";
    const e2eLine =
      s.speed.e2eTokPerSec != null
        ? `<div class="t3-pop-row"><span>端到端速度 (含首字预填充)</span><span>${s.speed.e2eTokPerSec.toFixed(1)} tok/s</span></div>`
        : "";
    const subTokLine =
      s.cost.subagentCount > 0 && s.tokens.subagentTokens > 0
        ? `<div class="t3-pop-row"><span>↳ 主会话 / 子代理 (${s.cost.subagentCount}个)</span><span>${formatCompactTokens(s.tokens.mainTotal)} / +${formatCompactTokens(s.tokens.subagentTokens)}</span></div>`
        : "";

    popover.innerHTML = `
      <div class="t3-pop-title">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(s.title || "当前会话")}</span>
        <span style="color:var(--hud-muted);font-weight:400;font-size:10.5px;flex:none">${s.turnCount} 轮</span>
      </div>
      <div class="t3-pop-row"><span>引擎 / 模型</span><span>${escapeHtml(providerBadge)}</span></div>
      <div class="t3-pop-row"><span>流式输出速度</span><span>${speedDetail}</span></div>
      ${e2eLine}
      <div class="t3-pop-row"><span>累计缓存 / 本轮缓存</span><span>${sessCache} / ${lastCache}</span></div>
      <div class="t3-pop-row"><span>缓存节省费用</span><span style="color:#10b981">${formatUsd(s.cache.savedUsd)}</span></div>
      <div class="t3-pop-row"><span>上下文容量占比</span><span>${ctxLine}</span></div>
      <div class="t3-pop-row"><span>本会话总 Token (含子代理)</span><span style="font-weight:600">${formatCompactTokens(s.tokens.total)} tok</span></div>
      ${subTokLine}
      <div class="t3-pop-row"><span>↳ 输入 / 缓存读取</span><span>${formatCompactTokens(s.tokens.input)} / ${formatCompactTokens(s.cache.cachedTokens)}</span></div>
      <div class="t3-pop-row"><span>↳ 输出 / 思考推理</span><span>${formatCompactTokens(s.tokens.output)} / ${formatCompactTokens(s.tokens.reasoning)}</span></div>
      <div class="t3-pop-row" style="border-top:1px solid var(--hud-border);margin-top:4px;padding-top:4px">
        <span>主会话等效费用</span><span>${formatUsd(s.cost.sessionUsd)}${s.cost.estimated ? " (估)" : ""}</span>
      </div>
      ${
        s.cost.subagentCount > 0
          ? `<div class="t3-pop-row"><span>子代理 (${s.cost.subagentCount} 个)</span><span>+${formatUsd(s.cost.subagentUsd)}</span></div>
             <div class="t3-pop-row"><span>单会话总计</span><span style="font-weight:700">${formatUsd(s.cost.withSubagentsUsd)}</span></div>`
          : ""
      }
      ${allQuotasHtml}
    `;
  }

  function showPopoverAbove(anchorEl, mode) {
    if (mode === "context") renderContextRingPopover();
    else renderStatsPopover();
    const popW = mode === "context" ? 268 : 324;
    const anchorRect = anchorEl.getBoundingClientRect();
    const barRect = topbar.getBoundingClientRect();
    const centerX = mode === "context" ? anchorRect.left + anchorRect.width / 2 : barRect.left + barRect.width / 2;
    const leftPos = Math.max(12, Math.min(window.innerWidth - popW - 14, Math.round(centerX - popW / 2)));
    popover.style.left = `${leftPos}px`;
    if (barRect.top > 260) {
      popover.style.top = "auto";
      popover.style.bottom = `${Math.round(window.innerHeight - barRect.top + 8)}px`;
    } else {
      popover.style.bottom = "auto";
      popover.style.top = `${Math.round(barRect.bottom + 6)}px`;
    }
    popover.classList.add("visible");
  }

  topbar.querySelectorAll("[data-hud-hover]").forEach((el) => {
    const mode = el.getAttribute("data-hud-hover");
    el.addEventListener("mouseenter", () => showPopoverAbove(el, mode));
    el.addEventListener("mouseleave", () => popover.classList.remove("visible"));
  });

  let lastTopbarSig = "";
  function renderTopbarStats(stats) {
    latestStats = stats;
    const qInfo = computeQuotaAndContext(stats);
    const wk = qInfo.primaryWeekly;

    let nextDotClass;
    let nextSpeed;
    let nextCache;
    let nextTokens;
    let nextCost;
    let nextQuota = wk ? `${wk.remainingPct}%` : "";
    let nextQuotaTone = wk ? wk.tone : "";
    const ctxPctNum = qInfo.ctxPct != null ? Math.round(qInfo.ctxPct) : 0;
    const nextCtxTxt = qInfo.ctxPct != null ? `${ctxPctNum}%` : "0%";
    const nextRingOffset = (RING_CIRC * (1 - Math.max(0, Math.min(100, qInfo.ctxPct || 0)) / 100)).toFixed(2);
    const nextRingColor =
      ctxPctNum >= 90 ? "#ef4444" : ctxPctNum >= 75 ? "#f59e0b" : "var(--hud-fg)";
    let nextBranch = "图谱";
    let hideDirty = false;

    if (!stats || !stats.ok) {
      nextDotClass = "t3-hud-dot";
      nextSpeed = stats?.nonThreadRoute === "new" ? "新会话" : "-- tok/s";
      nextCache = "--%";
      nextTokens = "0 tok";
      nextCost = "$0.00";
      hideDirty = true;
    } else {
      const activelyStreaming = Boolean(stats.isRunning || liveStreamTps != null);
      nextDotClass = "t3-hud-dot " + (activelyStreaming ? "running" : "ready");
      const primarySpd = liveStreamTps ?? stats.speed.lastDecodeTps ?? stats.speed.tokPerSec;
      if (primarySpd != null) {
        nextSpeed = `${primarySpd.toFixed(1)} tok/s`;
      } else if (activelyStreaming) {
        nextSpeed = "生成中...";
      } else {
        nextSpeed = "-- tok/s";
      }
      const rate = stats.cache.sessionRate ?? stats.cache.displayRate;
      nextCache = rate != null ? `${Math.round(rate * 100)}%` : "--%";
      nextTokens = `${formatCompactTokens(stats.tokens.total)} tok`;
      const totalUsd = stats.cost.withSubagentsUsd;
      const subSuffix = stats.cost.subagentCount > 0 ? ` (+${stats.cost.subagentCount}子)` : "";
      nextCost = `${formatUsd(totalUsd)}${subSuffix}`;
    }

    const sig = `${nextDotClass}|${nextSpeed}|${nextCache}|${nextTokens}|${nextCost}|${nextQuota}|${nextQuotaTone}|${nextCtxTxt}|${nextRingOffset}|${nextBranch}|${hideDirty}`;
    if (sig !== lastTopbarSig) {
      lastTopbarSig = sig;
      dotEl.className = nextDotClass;
      speedEl.textContent = nextSpeed;
      cacheEl.textContent = nextCache;
      tokensEl.textContent = nextTokens;
      costEl.textContent = nextCost;
      if (nextQuota) {
        quotaSepEl.style.display = "inline-block";
        quotaItemEl.style.display = "inline-flex";
        quotaEl.textContent = nextQuota;
        quotaEl.style.color =
          nextQuotaTone === "err" ? "#ef4444" : nextQuotaTone === "warn" ? "#f59e0b" : "";
      } else {
        quotaSepEl.style.display = "none";
        quotaItemEl.style.display = "none";
      }
      ctxPctEl.textContent = nextCtxTxt;
      ringArcEl.setAttribute("stroke-dashoffset", nextRingOffset);
      ringArcEl.style.stroke = nextRingColor;
      branchBtnText.textContent = nextBranch;
      if (hideDirty) dirtyBadge.style.display = "none";
    }

    updateLayoutPosition();
  }

  // Render SVG cell for a commit row
  function buildRowSvg(commit, maxLanes) {
    const laneStep = 14;
    const padX = 10;
    const rowH = 30;
    const midY = rowH / 2;
    const lanesShown = Math.max(1, Math.min(maxLanes || 1, 10));
    const width = padX * 2 + (lanesShown - 1) * laneStep;
    const cx = padX + Math.min(commit.lane, 9) * laneStep;

    let paths = "";

    // Pass-through vertical lines
    for (const l of commit.passThroughLanes || []) {
      if (l > 9) continue;
      const x = padX + l * laneStep;
      paths += `<line x1="${x}" y1="0" x2="${x}" y2="${rowH}" stroke="${laneColor(l)}" stroke-width="1.75" stroke-opacity="0.8" />`;
    }

    // Incoming lines from top half into commit node
    for (const inLane of commit.incomingLanes || []) {
      if (inLane > 9) continue;
      const ix = padX + inLane * laneStep;
      if (ix === cx) {
        paths += `<line x1="${cx}" y1="0" x2="${cx}" y2="${midY}" stroke="${laneColor(inLane)}" stroke-width="1.75" />`;
      } else {
        paths += `<path d="M ${ix} 0 C ${ix} ${midY * 0.75}, ${cx} ${midY * 0.35}, ${cx} ${midY}" fill="none" stroke="${laneColor(inLane)}" stroke-width="1.75" />`;
      }
    }

    // Outgoing lines from commit node to bottom half (parents)
    for (const conn of commit.parentConnections || []) {
      const toL = Math.min(conn.toLane, 9);
      const tx = padX + toL * laneStep;
      const col = conn.type === "branch-parent" ? laneColor(toL) : laneColor(commit.lane);
      if (tx === cx) {
        paths += `<line x1="${cx}" y1="${midY}" x2="${cx}" y2="${rowH}" stroke="${col}" stroke-width="1.75" />`;
      } else {
        paths += `<path d="M ${cx} ${midY} C ${cx} ${midY + (rowH - midY) * 0.65}, ${tx} ${midY + (rowH - midY) * 0.25}, ${tx} ${rowH}" fill="none" stroke="${col}" stroke-width="1.75" />`;
      }
    }

    const isMerge = (commit.parents || []).length > 1;
    const isHead = (commit.refs || []).some((r) => r.isHead);
    const nodeCol = laneColor(commit.lane);

    let nodeSvg = "";
    if (isHead) {
      nodeSvg = `
        <circle cx="${cx}" cy="${midY}" r="5.5" fill="var(--hud-bg-solid)" stroke="${nodeCol}" stroke-width="2.2" />
        <circle cx="${cx}" cy="${midY}" r="2.5" fill="${nodeCol}" />
      `;
    } else if (isMerge) {
      nodeSvg = `<circle cx="${cx}" cy="${midY}" r="4.2" fill="var(--hud-bg-solid)" stroke="${nodeCol}" stroke-width="2" />`;
    } else {
      nodeSvg = `<circle cx="${cx}" cy="${midY}" r="3.6" fill="${nodeCol}" />`;
    }

    return `<svg width="${width}" height="${rowH}" viewBox="0 0 ${width} ${rowH}" style="display:block;overflow:visible">${paths}${nodeSvg}</svg>`;
  }

  function renderGitGraphList() {
    if (!latestGraph) return;
    if (!latestGraph.ok) {
      repoTitleEl.textContent = "Git 图谱";
      branchPillEl.textContent = "--";
      statusBadgeEl.textContent = "";
      dirtyBadge.style.display = "none";
      gitListEl.innerHTML = `<div class="t3-empty-msg">${escapeHtml(latestGraph.error || "暂无 Git 仓库信息")}</div>`;
      return;
    }

    repoTitleEl.textContent = latestGraph.projectTitle || "Git 仓库";
    branchPillEl.textContent = latestGraph.currentBranch || "HEAD";
    branchBtnText.textContent = "图谱";

    const wt = latestGraph.workingTree;
    if (wt && !wt.clean) {
      statusBadgeEl.textContent = `未提交: ${wt.total} (${wt.modified}改/${wt.untracked}新)`;
      dirtyBadge.textContent = `*${wt.total}`;
      dirtyBadge.style.display = "inline-block";
    } else {
      statusBadgeEl.textContent = "工作区干净";
      dirtyBadge.style.display = "none";
    }

    const q = (searchInput.value || "").trim().toLowerCase();
    const commits = (latestGraph.commits || []).filter((c) => {
      if (!q) return true;
      if (c.subject.toLowerCase().includes(q)) return true;
      if (c.shortHash.toLowerCase().includes(q) || c.hash.toLowerCase().includes(q)) return true;
      if (c.author.toLowerCase().includes(q)) return true;
      return (c.refs || []).some((r) => r.label.toLowerCase().includes(q));
    });

    if (commits.length === 0) {
      gitListEl.innerHTML = `<div class="t3-empty-msg">${q ? "没有匹配的提交记录" : "仓库暂无提交记录"}</div>`;
      return;
    }

    gitListEl.innerHTML = commits
      .map((c) => {
        const refsHtml = (c.refs || [])
          .slice(0, 3)
          .map((r) => `<span class="t3-git-ref ${escapeHtml(r.kind)}" title="${escapeHtml(r.label)}">${escapeHtml(r.isHead && r.label !== "HEAD" ? "HEAD → " + r.label : r.label)}</span>`)
          .join("");
        const selClass = c.hash === selectedCommitHash ? " selected" : "";
        return `
          <div class="t3-git-row${selClass}" data-hash="${escapeHtml(c.hash)}">
            <div class="t3-git-graph-cell">${q ? "" : buildRowSvg(c, latestGraph.maxLanes)}</div>
            <div class="t3-git-main-cell">
              ${refsHtml}
              <span class="t3-git-subj" title="${escapeHtml(c.subject)}">${escapeHtml(c.subject)}</span>
              <span class="t3-git-meta">
                <span>${escapeHtml(c.author.slice(0, 12))}</span>
                <span>${escapeHtml(c.relTime.replace(" ago", ""))}</span>
                <span class="t3-git-sha">${escapeHtml(c.shortHash)}</span>
              </span>
            </div>
          </div>
        `;
      })
      .join("");
  }

  function formatColoredPatch(patch) {
    if (!patch) return "";
    return patch
      .split("\n")
      .map((line) => {
        const esc = escapeHtml(line);
        if (line.startsWith("+++") || line.startsWith("---")) {
          return `<span style="color:var(--hud-muted)">${esc}</span>`;
        }
        if (line.startsWith("+")) return `<span class="t3-diff-add">${esc}</span>`;
        if (line.startsWith("-")) return `<span class="t3-diff-del">${esc}</span>`;
        if (line.startsWith("@@")) return `<span class="t3-patch-hunk">${esc}</span>`;
        return esc;
      })
      .join("\n");
  }

  function clearCommitPaneDom() {
    selectedCommitHash = null;
    commitPane.classList.add("hidden");
    commitMsgEl.textContent = "";
    commitMetaEl.textContent = "";
    commitBodyEl.textContent = "";
  }

  function clearGitDrawerDom() {
    clearCommitPaneDom();
    latestGraph = null;
    lastLoadedGraphThreadId = null;
    gitListEl.textContent = "";
  }

  async function openCommitDetail(hash) {
    if (selectedCommitHash === hash && !commitPane.classList.contains("hidden")) {
      clearCommitPaneDom();
      renderGitGraphList();
      return;
    }
    selectedCommitHash = hash;
    renderGitGraphList();
    commitPane.classList.remove("hidden");
    commitMsgEl.textContent = "加载提交详情中...";
    commitMetaEl.textContent = hash.slice(0, 10);
    commitBodyEl.textContent = "";

    const res = await callBackend("getCommitDetail", getRouteHint(), hash);
    if (selectedCommitHash !== hash || !drawerOpen) return;
    if (!res || !res.ok) {
      commitMsgEl.textContent = res?.error || "读取详情失败";
      return;
    }
    commitMsgEl.textContent = res.message || "(无提交说明)";
    commitMetaEl.textContent = `${res.authorName || ""} <${res.authorEmail || ""}> · ${res.hash.slice(0, 10)} · ${res.files.length} 个文件`;

    const filesHtml = (res.files || [])
      .map(
        (f) => `
        <div class="t3-commit-file">
          <span class="t3-commit-file-path" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</span>
          <span style="flex:none">
            ${f.added != null ? `<span class="t3-diff-add">+${f.added}</span>` : ""}
            ${f.deleted != null ? ` <span class="t3-diff-del">-${f.deleted}</span>` : ""}
          </span>
        </div>`
      )
      .join("");

    const patchHtml = res.patch
      ? `<div class="t3-patch-box">${formatColoredPatch(res.patch)}</div>`
      : "";

    commitBodyEl.innerHTML = filesHtml + patchHtml;
  }

  gitListEl.addEventListener("click", (e) => {
    const row = e.target.closest(".t3-git-row");
    if (!row) return;
    const hash = row.getAttribute("data-hash");
    if (hash) openCommitDetail(hash);
  });

  document.getElementById("t3-commit-close").addEventListener("click", () => {
    clearCommitPaneDom();
    renderGitGraphList();
  });

  searchInput.addEventListener("input", () => {
    if (drawerOpen) renderGitGraphList();
  });

  async function refreshGitGraph(force = false) {
    const hint = getRouteHint();
    if (!drawerOpen && !force) return;
    const graph = await callBackend("getGitGraph", hint, 120);
    if (!drawerOpen) return;
    latestGraph = graph;
    lastLoadedGraphThreadId = graph?.threadId || null;
    renderGitGraphList();
  }

  let statsInFlight = false;
  async function refreshStats(routeChanged = false) {
    if (statsInFlight && !routeChanged) return;
    statsInFlight = true;
    try {
      const hint = getRouteHint();
      const stats = await callBackend("getThreadStats", hint);
      renderTopbarStats(stats);

      // Sync Git Graph only if drawer is open; clear stale hidden graph when switching threads while closed
      if (routeChanged || (stats?.ok && lastLoadedGraphThreadId && stats.threadId !== lastLoadedGraphThreadId)) {
        if (drawerOpen) {
          clearCommitPaneDom();
          refreshGitGraph(true);
        } else if (latestGraph || gitListEl.childElementCount > 0) {
          clearGitDrawerDom();
        }
      }
    } catch {
      // Ignore transient query errors
    } finally {
      statsInFlight = false;
    }
  }

  function toggleDrawer(forceState) {
    drawerOpen = typeof forceState === "boolean" ? forceState : !drawerOpen;
    drawer.classList.toggle("closed", !drawerOpen);
    gitBtn.classList.toggle("active", drawerOpen);
    updateLayoutPosition();
    if (drawerOpen) {
      refreshGitGraph(true);
    } else {
      // Release 120 SVG rows + diff DOM nodes when drawer is closed
      clearGitDrawerDom();
    }
  }

  gitBtn.addEventListener("click", () => toggleDrawer());
  document.getElementById("t3-git-close").addEventListener("click", () => toggleDrawer(false));
  document.getElementById("t3-git-refresh").addEventListener("click", () => refreshGitGraph(true));
  document.getElementById("t3-git-wide").addEventListener("click", () => {
    drawer.classList.toggle("wide");
  });

  function onKeyDown(e) {
    if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === "KeyG") {
      e.preventDefault();
      toggleDrawer();
    } else if (e.key === "Escape" && drawerOpen) {
      toggleDrawer(false);
    }
  }
  window.addEventListener("keydown", onKeyDown);

  let layoutSyncTimer = null;
  let layoutRafId = 0;
  function runLayoutSync() {
    layoutRafId = 0;
    if (disposed || document.hidden) return;
    updateLayoutPosition();
  }

  function scheduleLayoutSync() {
    if (disposed || document.hidden || layoutSyncTimer || layoutRafId) return;
    layoutSyncTimer = setTimeout(() => {
      layoutSyncTimer = null;
      if (!disposed && !document.hidden && !layoutRafId) {
        layoutRafId = requestAnimationFrame(runLayoutSync);
      }
    }, 160);
  }

  // Hook SPA navigation (both hash routing in Electron and pathname in Web)
  function onRouteMaybeChanged() {
    const next = getRouteHint();
    if (next !== currentPathHint) {
      currentPathHint = next;
      refreshStats(true);
    }
    scheduleLayoutSync();
  }

  const origPushState = history.pushState;
  history.pushState = function (...args) {
    const ret = origPushState.apply(this, args);
    onRouteMaybeChanged();
    return ret;
  };
  const origReplaceState = history.replaceState;
  history.replaceState = function (...args) {
    const ret = origReplaceState.apply(this, args);
    onRouteMaybeChanged();
    return ret;
  };
  window.addEventListener("hashchange", onRouteMaybeChanged);
  window.addEventListener("popstate", onRouteMaybeChanged);
  window.addEventListener("resize", scheduleLayoutSync);

  let lastPickerSig = "";
  const routeWatchTimer = setInterval(() => {
    if (document.hidden) return;
    const next = getRouteHint();
    if (next !== currentPathHint) {
      currentPathHint = next;
      refreshStats(true);
      return;
    }
    // Instant sync when user switches model in composer dropdown (e.g., Gemini <-> Opus/Sonnet)
    const live = readLiveT3State();
    const pSig = `${live.selectedProvider || ""}:${live.selectedModel || ""}:${live.usage?.contextWindow?.usedTokens ?? ""}`;
    if (pSig !== lastPickerSig) {
      lastPickerSig = pSig;
      if (latestStats) renderTopbarStats(latestStats);
    }
  }, 600);

  function isHudOwnNode(node) {
    if (!node) return false;
    const el = node.nodeType === 1 ? node : node.parentElement;
    if (!el) return false;
    return root.contains(el);
  }

  // Observe structural mounts without attribute storms on every streaming token
  const domObserver = new MutationObserver((records) => {
    if (disposed || document.hidden) return;
    let relevant = false;
    for (let i = 0; i < records.length; i++) {
      if (!isHudOwnNode(records[i].target)) {
        relevant = true;
        break;
      }
    }
    if (!relevant) return;
    const next = getRouteHint();
    if (next !== currentPathHint) {
      currentPathHint = next;
      refreshStats(true);
    }
    scheduleLayoutSync();
  });
  domObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });

  // Real-time streaming speed sampler (ticks live every 260ms while text/thinking streams into chat!)
  let streamSamples = [];
  let streamRouteSnap = currentPathHint;
  let lastGrowthAt = 0;

  function estimateRenderedTokens(str) {
    if (!str) return 0;
    let cjk = 0;
    const len = str.length;
    for (let i = 0; i < len; i++) {
      if (str.charCodeAt(i) > 0x2e80) cjk++;
    }
    return cjk * 0.72 + (len - cjk) * 0.27;
  }

  const streamWatchTimer = setInterval(() => {
    if (disposed || document.hidden) return;
    const routeNow = getRouteHint();
    if (routeNow !== streamRouteSnap) {
      streamRouteSnap = routeNow;
      streamSamples = [];
      if (liveStreamTps != null) {
        liveStreamTps = null;
        if (latestStats) renderTopbarStats(latestStats);
      }
      return;
    }

    const chatCol = document.querySelector("[data-chat-column]");
    if (!chatCol) return;
    const listRoot =
      chatCol.querySelector('[data-slot="scroll-area-viewport"]') ||
      chatCol.querySelector('[class*="overflow-y-auto"]') ||
      chatCol;
    const contentWrap = listRoot.firstElementChild || listRoot;
    const kids = contentWrap.children;
    let tailText = "";
    for (let i = Math.max(0, kids.length - 2); i < kids.length; i++) {
      tailText += kids[i].textContent || "";
    }

    const now = performance.now();
    const estTok = estimateRenderedTokens(tailText);

    if (streamSamples.length > 0) {
      const prev = streamSamples[streamSamples.length - 1];
      if (estTok > prev.tok + 1.2) {
        lastGrowthAt = now;
      } else if (estTok < prev.tok - 20) {
        // Turn switched or collapsed
        streamSamples = [{ t: now, tok: estTok }];
        return;
      }
    }
    streamSamples.push({ t: now, tok: estTok });
    while (streamSamples.length > 1 && now - streamSamples[0].t > 1600) {
      streamSamples.shift();
    }

    if (lastGrowthAt > 0 && now - lastGrowthAt <= 1300 && streamSamples.length >= 2) {
      const first = streamSamples[0];
      const last = streamSamples[streamSamples.length - 1];
      const dt = (last.t - first.t) / 1000;
      const dTok = last.tok - first.tok;
      if (dt >= 0.22 && dTok >= 3) {
        const inst = Math.min(950, dTok / dt);
        liveStreamTps = liveStreamTps != null ? liveStreamTps * 0.55 + inst * 0.45 : inst;
        if (latestStats) renderTopbarStats(latestStats);
      }
    } else if (liveStreamTps != null && now - lastGrowthAt > 1400) {
      liveStreamTps = null;
      streamSamples = [];
      refreshStats(false);
    }
  }, 260);

  let disposed = false;
  let pollTimer = null;
  async function pollLoop() {
    if (disposed) return;
    if (!document.hidden) {
      await refreshStats(false);
    }
    if (disposed) return;
    const delay = latestStats?.isRunning || liveStreamTps != null ? 850 : 3500;
    pollTimer = setTimeout(pollLoop, delay);
  }

  window.__t3HudCleanup = () => {
    disposed = true;
    clearInterval(routeWatchTimer);
    clearInterval(streamWatchTimer);
    if (pollTimer) clearTimeout(pollTimer);
    if (layoutSyncTimer) clearTimeout(layoutSyncTimer);
    if (layoutRafId) cancelAnimationFrame(layoutRafId);
    if (cleanupDragListeners) cleanupDragListeners();
    if (layoutResizeObserver) layoutResizeObserver.disconnect();
    domObserver.disconnect();
    setComposerTopSpacing(null);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("hashchange", onRouteMaybeChanged);
    window.removeEventListener("popstate", onRouteMaybeChanged);
    window.removeEventListener("resize", scheduleLayoutSync);
    history.pushState = origPushState;
    history.replaceState = origReplaceState;
    document.querySelectorAll(".t3-hud-details-section").forEach((el) => el.remove());
    document.querySelectorAll(".t3-hud-composer-spaced").forEach((el) => el.classList.remove("t3-hud-composer-spaced"));
    root.remove();
    styleEl.remove();
    window.__t3HudInitialized = false;
  };

  refreshStats(true);
  pollTimer = setTimeout(pollLoop, 1200);
})();
