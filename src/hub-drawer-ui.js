(() => {
  "use strict";

  // Independent from renderer-ui.js: reinjection never replaces the resident HUD.
  const previous = window.__t3SidecarHub;
  let restored = previous?.snapshot?.() || null;
  const previousOptions = previous?.options || {};
  try { previous?.destroy?.(); } catch {}

  window.__t3MountSidecarHub = function mountSidecarHub(opts = {}) {
    const existing = window.__t3SidecarHub;
    if (existing) {
      restored = existing.snapshot?.() || restored;
      try { existing.destroy?.(); } catch {}
    }
    const initial = restored;
    restored = null;
    const disposers = [];
    const timers = new Set();
    const pending = new Set();
    let disposed = false;
    let routeTimer = null;
    let embedTimer = null;
    let searchTimer = null;
    let toastTimer = null;
    let observer = null;
    let root, drawer, content, handle, style, palette;
    let focusReturn = null;
    let requestVersion = 0;
    let contextVersion = 0;
    let memoryVersion = 0;
    let embedVersion = 0;
    let lastRoute = "";
    let cachedRouter = null;
    let unsubscribeRouter = null;
    let routerProbeAt = 0;
    let drag = null;
    let suppressClick = false;
    let contextLoading = true;
    let slashVersion = 0;
    let slashInserting = false;
    let composing = false;
    let slashSession = null;
    const slashCache = new Map();
    const subagentSaves = new Map();
    const tabKeys = ["plugins", "mcp", "skills", "hooks", "subagents", "memory", "agents"];
    const cache = { plugins: null, hooks: null, skills: null, subagents: null, mcp: null, overview: null, memory: null, embed: null, agents: null };
    const errors = {};
    const drafts = initial?.drafts || {};
    const state = {
      open: initial?.open ?? false,
      tab: initial?.tab || storageGet("t3-hub-tab") || "plugins",
      scope: initial?.scope || storageGet("t3-hub-scope") || "global",
      pluginQuery: initial?.pluginQuery || "", pluginInput: initial?.pluginInput || "", pluginInstallOpen: false,
      mcpQuery: "", hookDraft: null, historyExpanded: initial?.historyExpanded || {},
      supersedeItems: [], supersedeLoading: false,
      lang: "zh", dark: false, context: null, connected: false,
      contextError: "", projectRoot: null, refreshing: false,
      skillQuery: initial?.skillQuery || "", skillFilter: initial?.skillFilter || "all",
      importScope: "project", importRepo: initial?.importRepo || "",
      memoryProject: initial?.memoryProject || "current", memoryModule: initial?.memoryModule || "all",
      memoryQuery: initial?.memoryQuery || "", selectedMemory: initial?.selectedMemory || null,
      agentsTarget: initial?.agentsTarget || "global", agentDrafts: initial?.agentDrafts || {},
      subagentScope: initial?.subagentScope || "global",
      subagentDrafts: initial?.subagentDrafts || {}, subagentExpanded: initial?.subagentExpanded || {},
      subagentCustom: initial?.subagentCustom || {},
      modelChoice: "", customModel: "", useMirror: false,
      mcpAddOpen: false, mcpForm: { kind: "form", name: "", transport: "stdio", command: "", args: "", url: "", json: "" },
      freshModes: {}, syncedTargets: [], embedInitialized: false, embedReadyDeadline: 0,
    };
    if (!tabKeys.includes(state.tab)) state.tab = "plugins";
    if (!["global", "project"].includes(state.scope)) state.scope = "global";

    async function hubRpc(action, payload = {}) {
      let result;
      if (typeof opts?.hubRpc === "function") result = await opts.hubRpc(action, payload);
      else if (typeof window.__t3HubRpc === "function") result = await window.__t3HubRpc(action, payload);
      else if (typeof window.__t3HudBridge?.getGitGraph === "function") result = await window.__t3HudBridge.getGitGraph("__HUB_RPC__", action, payload);
      else throw new Error(tr("Hub 连接暂不可用", "Hub connection is unavailable"));
      if (result?.ok !== false && result?.success !== false && ["skills:setScope", "skills:importGitHub", "skills:updatePackage", "skills:removePackage", "plugins:setScope", "plugins:installGitHub", "subagents:save", "subagents:delete"].includes(action)) invalidateSlashCache();
      return result;
    }
    async function request(action, payload = {}) {
      const result = await hubRpc(action, payload);
      if (result?.ok === false || result?.success === false) {
        throw new Error(result.error?.message || result.error || result.message || tr("操作未完成", "The action could not be completed"));
      }
      return result?.data ?? result?.result ?? result ?? {};
    }
    function storageGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
    function storageSet(key, value) { try { localStorage.setItem(key, String(value)); } catch {} }
    function tr(zh, en) { return state.lang === "en" ? en : zh; }
    function esc(value) {
      return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    }
    function items(value, keys = ["items"]) {
      if (Array.isArray(value)) return value;
      for (const key of keys) if (Array.isArray(value?.[key])) return value[key];
      return [];
    }
    function listen(target, event, callback, options) {
      target.addEventListener(event, callback, options);
      disposers.push(() => target.removeEventListener(event, callback, options));
    }
    function later(callback, delay) {
      const id = setTimeout(() => { timers.delete(id); if (!disposed) callback(); }, delay);
      timers.add(id);
      return id;
    }
    function cancelTimer(id) { clearTimeout(id); timers.delete(id); }
    function errorText(error) { return redact(error?.message || error || tr("发生未知错误", "An unexpected error occurred")); }
    function redact(value) {
      return String(value ?? "")
        .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1•••@")
        .replace(/([?&](?:api[_-]?key|key|token|secret|password|authorization|access[_-]?token)=)[^&#\s]+/gi, "$1•••")
        .replace(/((?:--)?(?:api[_-]?key|token|secret|password|authorization)\s*[=: ]\s*)(["']?)[^\s,"'}]+/gi, "$1•••")
        .replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}/g, "•••")
        .replace(/(Bearer\s+)[^\s"']+/gi, "$1•••");
    }
    const paths = {
      graph: '<path d="M7 6h10M6 7v10m12-10v10M7 18h10M8 8l8 8"/><circle cx="5" cy="5" r="3"/><circle cx="19" cy="5" r="3"/><circle cx="5" cy="19" r="3"/><circle cx="19" cy="19" r="3"/>',
      crystal: '<path d="m12 2 9 6v8l-9 6-9-6V8l9-6Zm0 0v20M3 8l9 6 9-6M3 16l9-9 9 9"/>',
      display: '<rect x="2" y="3" width="20" height="14" rx="3"/><path d="M8 22h8m-4-5v5"/>',
      cloud: '<path d="M6 18h14a3 3 0 0 0 0-6h-1a6 6 0 0 0-12-2 4 4 0 0 0-1 8Z"/><path d="M3 21h18"/>',
      masks: '<path d="m3 4 9 2-2 9a5 5 0 0 1-7-3L3 4Zm9 4 9-3v9a6 6 0 0 1-9 6"/><path d="M5 8h2m2 1h1M5 12l3 1m7-1h1m2-1h1m-5 5q2 3 5-1"/>',
      bag: '<path d="M4 7h16l1 14H3L4 7Zm4 0V5a4 4 0 0 1 8 0v2"/>',
      terminal: '<rect x="2" y="3" width="20" height="18" rx="4"/><path d="m6 8 4 4-4 4m7 0h5"/>',
      hub: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><path d="M17.5 14v7m-3.5-3.5h7"/>',
      close: '<path d="m6 6 12 12M18 6 6 18"/>',
      refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 18 17"/>',
      search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
      plus: '<path d="M12 5v14M5 12h14"/>',
      skill: '<path d="M9 3H5a2 2 0 0 0-2 2v4a3 3 0 1 1 0 6v4a2 2 0 0 0 2 2h4a3 3 0 1 1 6 0h4a2 2 0 0 0 2-2v-4a3 3 0 1 1 0-6V5a2 2 0 0 0-2-2h-4a3 3 0 1 1-6 0Z"/>',
      plug: '<path d="M8 3v5m8-5v5M6 8h12v4a6 6 0 0 1-12 0V8Zm6 10v3"/>',
      memory: '<path d="M9 4a3 3 0 0 0-5 3 4 4 0 0 0-1 7 4 4 0 0 0 6 5V4Zm6 0a3 3 0 0 1 5 3 4 4 0 0 1 1 7 4 4 0 0 1-6 5V4Z"/><path d="M5 9h4m6 5h4M6 16h3m6-9h3"/>',
      edit: '<path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 14v6Z"/>',
      folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
      github: '<path d="M9 20c-4 1-4-2-6-2m12 4v-4a3 3 0 0 0-1-2c3 0 6-2 6-5a5 5 0 0 0-1-3 5 5 0 0 0 0-4s-2-1-4 1a13 13 0 0 0-6 0C7 3 5 4 5 4a5 5 0 0 0 0 4 5 5 0 0 0-1 3c0 3 3 5 6 5a3 3 0 0 0-1 2v4"/>',
      globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
      check: '<path d="m5 12 4 4L19 6"/>',
      chevron: '<path d="m9 5 7 7-7 7"/>',
      bolt: '<path d="m13 2-9 12h7l-1 8 10-12h-7l1-8Z"/>',
      download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4"/>',
      pin: '<path d="m16 3 5 5-5 3-2 5-3-3-5-2 5-2 5-6ZM3 21l7-7"/>',
      trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
      save: '<path d="M5 3h12l4 4v14H3V3h2Zm2 0v6h10V3M7 21v-8h10v8"/>',
      info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.1"/>',
      spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/>',
    };
    function icon(name, size = 16) {
      return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.hub}</svg>`;
    }
    function spinner() { return '<span class="hub-spinner" aria-hidden="true"></span>'; }
    function button(action, label, options = {}) {
      return `<button type="button" class="hub-btn ${options.primary ? "hub-primary" : ""} ${options.small ? "hub-small" : ""} ${options.danger ? "hub-danger" : ""}" data-action="${esc(action)}" ${options.disabled ? "disabled" : ""} ${options.attrs || ""}>${options.icon ? icon(options.icon, 14) : ""}<span>${esc(label)}</span></button>`;
    }
    function projectDisabled() { return !state.projectRoot; }
    function projectTitle() { return projectDisabled() ? tr("请先打开一个项目", "Open a project first") : state.context?.projectTitle || state.context?.projectName || state.context?.project?.name || state.projectRoot.split(/[\\/]/).filter(Boolean).pop(); }
    function empty(title, detail = "", name = "search") {
      return `<div class="hub-empty">${icon(name, 27)}<strong>${esc(title)}</strong>${detail ? `<span>${esc(detail)}</span>` : ""}</div>`;
    }
    function loading() { return `<div class="hub-skeleton" aria-label="${esc(tr("正在加载", "Loading"))}">${[1, 2, 3].map(() => '<div><i></i><i></i><i></i></div>').join("")}</div>`; }
    function inlineError(error, action = "refresh") {
      return `<div class="hub-error" role="alert">${icon("info")}<div><strong>${esc(tr("暂时无法加载", "Unable to load"))}</strong><span>${esc(errorText(error))}</span></div>${button(action, tr("重试", "Retry"), { small: true })}</div>`;
    }
    function detectLang() {
      const saved = storageGet("t3-hud-lang");
      if (saved === "zh" || saved === "en") return saved;
      if (opts.lang === "zh" || opts.lang === "en") return opts.lang;
      const docLang = document.documentElement.lang.toLowerCase();
      if (/^(zh|en)/.test(docLang)) return docLang.slice(0, 2);
      const hostText = document.getElementById("root")?.innerText || "";
      const placeholder = document.querySelector('[data-slot="composer-shell"] textarea')?.placeholder || "";
      const zh = ["想问什么", "本地工作副本", "新会话", "设置", "累计缓存", "图谱"];
      const en = ["Ask anything", "Local working copy", "New thread", "Settings"];
      const score = (markers) => markers.filter((m) => hostText.includes(m)).length + 2 * markers.filter((m) => placeholder.includes(m)).length;
      return score(en) > score(zh) ? "en" : "zh";
    }
    function isDark() {
      const html = document.documentElement;
      if (html.classList.contains("dark") || html.dataset.theme === "dark") return true;
      if (html.classList.contains("light") || html.dataset.theme === "light") return false;
      for (const node of [document.body, html]) {
        const color = getComputedStyle(node).backgroundColor;
        const numbers = color.match(/[\d.]+/g)?.map(Number);
        if (!numbers || numbers.length < 3 || (numbers.length > 3 && numbers[3] === 0)) continue;
        return (numbers[0] * 0.299 + numbers[1] * 0.587 + numbers[2] * 0.114) < 128;
      }
      return window.matchMedia?.("(prefers-color-scheme: dark)").matches || false;
    }

    function build() {
      if (disposed) return;
      document.getElementById("t3-sidecar-hub")?.remove();
      document.getElementById("t3-sidecar-hub-styles")?.remove();
      style = document.createElement("style");
      style.id = "t3-sidecar-hub-styles";
      style.textContent = `
        #t3-sidecar-hub{--hud-bg:color-mix(in srgb,var(--popover,#fff) 94%,transparent);--hud-bg-solid:var(--popover,#fff);--hud-fg:var(--foreground,#262626);--hud-muted:var(--muted-foreground,#737373);--hud-surface:var(--muted,#f4f4f5);--hud-border:var(--border,rgba(0,0,0,.1));--hud-hover:color-mix(in srgb,var(--foreground,#262626) 7%,transparent);--hud-shadow:0 8px 30px #0000001f,0 1px 3px #0000000f;--hud-emerald:#059669;--hud-blue:#2563eb;--hud-amber:#b86d08;--hud-red:#dc2626;--hud-violet:#7c3aed;--hub-accent-bg:color-mix(in srgb,var(--hud-emerald) 9%,var(--hud-bg-solid));position:fixed;inset:0;z-index:9993;pointer-events:none;color:var(--hud-fg);font:12px/1.55 -apple-system,BlinkMacSystemFont,"Inter Variable","Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased;letter-spacing:.005em;color-scheme:light}
        #t3-sidecar-hub.is-dark{--hud-bg:color-mix(in srgb,var(--popover,#141414) 94%,transparent);--hud-bg-solid:var(--popover,#141414);--hud-fg:var(--foreground,#f5f5f5);--hud-muted:var(--muted-foreground,#a3a3a3);--hud-surface:var(--muted,#222);--hud-border:var(--border,rgba(255,255,255,.12));--hud-hover:color-mix(in srgb,var(--foreground,#f5f5f5) 9%,transparent);--hud-shadow:0 14px 40px #00000060,0 1px 3px #00000059;--hud-emerald:#34d399;--hud-blue:#60a5fa;--hud-amber:#fbbf24;--hud-red:#f87171;--hud-violet:#a78bfa;color-scheme:dark}
        #t3-sidecar-hub,#t3-sidecar-hub *{box-sizing:border-box}#t3-sidecar-hub button,#t3-sidecar-hub input,#t3-sidecar-hub select,#t3-sidecar-hub textarea{font:inherit;letter-spacing:inherit}#t3-sidecar-hub button{cursor:pointer;-webkit-app-region:no-drag}#t3-sidecar-hub button:disabled{opacity:.38;cursor:not-allowed}#t3-sidecar-hub button:focus-visible,#t3-sidecar-hub input:focus-visible,#t3-sidecar-hub select:focus-visible,#t3-sidecar-hub textarea:focus-visible{outline:2px solid var(--hud-emerald);outline-offset:2px}#t3-sidecar-hub svg{flex:none;vertical-align:middle}#t3-sidecar-hub button{color:inherit}#t3-sidecar-hub [hidden]{display:none!important}
        #t3-hub-handle{position:fixed;right:0;top:42%;transform:translateY(-50%);width:28px;min-height:108px;padding:10px 4px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;background:var(--hud-bg);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);border:1px solid var(--hud-border);border-right:0;border-radius:14px 0 0 14px;box-shadow:-2px 3px 18px #0000000b;pointer-events:auto;touch-action:none;user-select:none;transition:width .2s,background .2s,opacity .2s,translate .25s;color:var(--hud-muted)}#t3-hub-handle:hover,#t3-hub-handle:focus-visible{width:34px;background:var(--hud-bg-solid);color:var(--hud-emerald)}#t3-hub-handle>svg{color:var(--hud-emerald)}.hub-handle-label{writing-mode:vertical-rl;font-size:10px;font-weight:600;letter-spacing:2px}.hub-handle-count{font-size:9px;font-weight:650;min-width:17px;height:17px;border-radius:5px;background:var(--hub-accent-bg);color:var(--hud-emerald);display:grid;place-items:center;letter-spacing:0}#t3-sidecar-hub.is-open #t3-hub-handle{translate:40px 0;opacity:0;pointer-events:none}
        #t3-hub-drawer{position:fixed;right:12px;top:12px;bottom:12px;width:min(430px,94vw);max-height:calc(100dvh - 24px);display:flex;flex-direction:column;pointer-events:none;visibility:hidden;opacity:0;transform:translateX(calc(100% + 28px));transition:transform .32s cubic-bezier(.22,.8,.25,1),opacity .24s,visibility .32s;border:1px solid var(--hud-border);border-radius:19px;background:var(--hud-bg-solid);box-shadow:var(--hud-shadow);overflow:hidden;-webkit-app-region:no-drag}#t3-sidecar-hub.is-open #t3-hub-drawer{pointer-events:auto;visibility:visible;opacity:1;transform:translateX(0)}#t3-sidecar-hub.is-occluded{visibility:hidden!important}#t3-sidecar-hub.is-occluded #t3-hub-drawer,#t3-sidecar-hub.is-occluded #t3-hub-handle{visibility:hidden!important;pointer-events:none!important}
        .hub-header{padding:19px 18px 15px;flex:none}.hub-title-row,.hub-row{display:flex;align-items:center;gap:8px;min-width:0}.hub-title-row{gap:11px}.hub-brand{display:grid;place-items:center;width:35px;height:35px;flex:none;border-radius:11px;background:var(--hub-accent-bg);color:var(--hud-emerald);border:1px solid color-mix(in srgb,var(--hud-emerald) 15%,transparent)}.hub-title{font-size:17px;font-weight:650;letter-spacing:-.5px;line-height:1.25}.hub-kicker{font-size:10px;color:var(--hud-muted);margin-top:3px;letter-spacing:.035em}.hub-grow{flex:1;min-width:0}.hub-icon-btn{display:inline-grid;place-items:center;width:28px;height:28px;flex:none;border:0;border-radius:7px;background:transparent;color:var(--hud-muted)!important}.hub-icon-btn:hover{background:var(--hud-hover);color:var(--hud-fg)!important}.hub-context{display:flex;align-items:center;gap:6px;margin-top:15px;min-width:0}.hub-context .hub-badge:first-child{max-width:235px}.hub-badge{display:inline-flex;align-items:center;gap:5px;max-width:100%;min-width:0;flex:none;font-size:10px;line-height:1.6;font-weight:500;border:1px solid var(--hud-border);padding:2px 7px;border-radius:6px;color:var(--hud-muted);white-space:nowrap}.hub-badge>span{overflow:hidden;text-overflow:ellipsis}.hub-badge.hub-green{color:var(--hud-emerald);border-color:color-mix(in srgb,var(--hud-emerald) 20%,transparent);background:var(--hub-accent-bg)}.hub-badge.hub-purple{color:var(--hud-violet);border-color:color-mix(in srgb,var(--hud-violet) 18%,transparent);background:color-mix(in srgb,var(--hud-violet) 7%,transparent)}.hub-shortcut{margin-left:auto;color:var(--hud-muted);font-size:10px;white-space:nowrap;opacity:.65}.hub-dot{width:5px;height:5px;border-radius:50%;background:currentColor;display:inline-block;flex:none}
        .hub-tabs{display:grid;grid-template-columns:1.25fr 1.05fr .7fr .9fr 1.15fr;gap:2px;padding:4px;margin:0 16px 13px;background:var(--hud-surface);border:1px solid var(--hud-border);border-radius:10px;flex:none}.hub-tab{display:flex;align-items:center;justify-content:center;gap:4px;min-width:0;padding:8px 2px;border:0;border-radius:6px;background:transparent;color:var(--hud-muted)!important;font-size:10px!important;white-space:nowrap;line-height:1.4}.hub-tab[aria-selected=true]{color:var(--hud-fg)!important;background:var(--hud-bg-solid);box-shadow:0 1px 3px #0000000c;font-weight:600}.hub-tab:hover:not([aria-selected=true]){color:var(--hud-fg)!important}.hub-tab svg{width:12px;height:12px}.hub-tab-emoji{font-size:12px}
        .hub-content{flex:1;min-height:0;padding:1px 17px 20px;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--hud-border) transparent}.hub-content::-webkit-scrollbar{width:5px}.hub-content::-webkit-scrollbar-thumb{background:var(--hud-border);border-radius:6px}.hub-section-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:5px 0 4px;font-size:13px;font-weight:620}.hub-count{font-size:10px;font-weight:450;color:var(--hud-muted);font-variant-numeric:tabular-nums}.hub-description{margin:0 0 15px;color:var(--hud-muted);font-size:11px;line-height:1.65}.hub-card{padding:13px;border:1px solid var(--hud-border);border-radius:11px;background:var(--hud-bg-solid);min-width:0;margin-bottom:9px}.hub-card-top{display:flex;align-items:flex-start;gap:9px;min-width:0}.hub-asset-icon{width:31px;height:31px;display:grid;place-items:center;border-radius:9px;flex:none;background:var(--hud-surface);color:var(--hud-muted)}.hub-asset-icon.accent{color:var(--hud-emerald);background:var(--hub-accent-bg)}.hub-card-name{font-size:12px;font-weight:600;overflow-wrap:anywhere;line-height:1.5}.hub-card-meta{display:flex;align-items:center;flex-wrap:wrap;gap:5px;margin-top:4px}.hub-card-meta .hub-badge{font-size:9px;padding:0 5px;border-radius:4px}.hub-card-description{font-size:11px;color:var(--hud-muted);margin:10px 0 12px;line-height:1.7;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}.hub-btn{border:1px solid var(--hud-border);border-radius:7px;min-height:31px;padding:6px 10px;display:inline-flex;align-items:center;justify-content:center;gap:6px;background:var(--hud-bg-solid);font-size:11px!important;line-height:1.4;white-space:nowrap;transition:background .15s,border-color .15s}.hub-btn:hover:not(:disabled){background:var(--hud-hover)}.hub-btn.hub-primary{background:var(--hud-emerald);color:#fff!important;border-color:transparent;font-weight:600}.is-dark .hub-btn.hub-primary{color:#10261e!important}.hub-btn.hub-primary:hover:not(:disabled){filter:brightness(.95);background:var(--hud-emerald)}.hub-btn.hub-small{min-height:26px;padding:4px 8px;font-size:10px!important}.hub-btn.hub-danger{color:var(--hud-red)!important}.hub-btn.is-busy{pointer-events:none;opacity:.65}.hub-spinner{width:13px;height:13px;border:1.5px solid currentColor;border-right-color:transparent;border-radius:50%;display:inline-block;animation:hub-spin .7s linear infinite;flex:none}@keyframes hub-spin{to{transform:rotate(360deg)}}
        .hub-input,.hub-select,.hub-editor{display:block;width:100%;min-width:0;border:1px solid var(--hud-border);border-radius:7px;background:var(--hud-bg-solid);color:var(--hud-fg);padding:8px 10px;line-height:1.5;font-size:11px!important}.hub-input::placeholder,.hub-editor::placeholder{color:var(--hud-muted);opacity:.65}.hub-select{padding:7px 25px 7px 9px;text-overflow:ellipsis;cursor:pointer}.hub-field{display:block;font-size:10px;color:var(--hud-muted);margin-bottom:10px}.hub-field>.hub-input,.hub-field>.hub-select,.hub-field>.hub-editor{margin-top:5px}.hub-import{background:color-mix(in srgb,var(--hud-surface) 65%,transparent);padding:12px;margin-top:14px;margin-bottom:14px}.hub-import-title{display:flex;align-items:center;gap:6px;font-weight:550;font-size:11px;margin-bottom:9px}.hub-import-grid{display:grid;grid-template-columns:minmax(0,1fr) 94px auto;gap:6px}.hub-import-grid .hub-input{font-size:10px!important;padding-inline:8px}.hub-import-grid .hub-select{font-size:10px!important;padding-left:7px;padding-right:13px}.hub-import-grid .hub-btn{padding-inline:8px}.hub-hint{display:flex;align-items:flex-start;gap:6px;font-size:10px;color:var(--hud-muted);line-height:1.65}.hub-import .hub-hint{margin-top:8px}.hub-search{position:relative;margin:10px 0}.hub-search>svg{position:absolute;top:50%;left:10px;transform:translateY(-50%);color:var(--hud-muted)}.hub-search .hub-input{padding-left:32px;background:color-mix(in srgb,var(--hud-surface) 45%,transparent)}.hub-filters{display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin:11px 0 14px}.hub-pill{font-size:10px!important;line-height:1.4;padding:5px 9px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--hud-muted)!important;white-space:nowrap}.hub-pill:hover{background:var(--hud-hover)}.hub-pill.is-active{background:var(--hub-accent-bg);border-color:color-mix(in srgb,var(--hud-emerald) 18%,transparent);color:var(--hud-emerald)!important;font-weight:550}.hub-pill-count{opacity:.6;margin-left:4px;font-size:9px}.hub-segments{display:flex;padding:3px;gap:3px;border:1px solid var(--hud-border);border-radius:7px;background:color-mix(in srgb,var(--hud-surface) 70%,transparent)}.hub-segments>button{min-width:0;flex:1;padding:5px 3px;font-size:10px!important;line-height:1.4;border:0;border-radius:4px;background:transparent;color:var(--hud-muted)!important;white-space:nowrap}.hub-segments>button.is-active{background:var(--hud-bg-solid);color:var(--hud-emerald)!important;box-shadow:0 1px 3px #0000000b;font-weight:600}.hub-segments>button:hover:not(.is-active):not(:disabled){background:var(--hud-hover)}
        .hub-status-strip{padding:11px 12px;background:color-mix(in srgb,var(--hud-surface) 65%,transparent);border:1px solid var(--hud-border);border-radius:10px;margin:9px 0 10px}.hub-status-items{display:flex;align-items:center;gap:14px;flex-wrap:wrap}.hub-status-item{display:flex;align-items:center;gap:5px;font-size:10px;color:var(--hud-muted)}.hub-status-item.online{color:var(--hud-emerald)}.hub-status-strip .hub-btn{width:100%;margin-top:10px}.hub-custom-toggle{width:100%;margin:0 0 14px;border-style:dashed}.hub-form-panel{padding:12px;background:color-mix(in srgb,var(--hud-surface) 55%,transparent);border:1px solid var(--hud-border);border-radius:10px;margin-bottom:14px}.hub-form-panel .hub-segments{margin-bottom:12px}.hub-form-panel .hub-editor{min-height:130px}.hub-form-grid{display:grid;grid-template-columns:minmax(0,1fr) 95px;gap:8px}.hub-mcp-summary{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;color:var(--hud-muted);padding:8px 9px;background:var(--hud-surface);border-radius:5px;margin:11px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.hub-mode-row{display:flex;align-items:center;gap:8px}.hub-mode-row .hub-select{flex:1;font-size:10px!important}.hub-live{display:inline-flex;align-items:center;gap:4px;font-size:9px;line-height:1.4;color:var(--hud-emerald);white-space:nowrap}.hub-mode-legend{font-size:10px;line-height:1.65;color:var(--hud-muted);padding:3px 1px 8px}.hub-mode-legend>svg{color:var(--hud-emerald);margin-right:3px}
        .hub-engine{border-color:color-mix(in srgb,var(--hud-emerald) 22%,var(--hud-border));background:linear-gradient(125deg,var(--hub-accent-bg),var(--hud-bg-solid) 80%);padding:13px;margin-top:7px;margin-bottom:18px}.hub-engine-label{font-size:9px;font-weight:650;letter-spacing:1.2px;color:var(--hud-muted);text-transform:uppercase}.hub-engine-status{font-size:11px;font-weight:550;display:flex;align-items:center;gap:6px;margin:9px 0;color:var(--hud-emerald);flex-wrap:wrap}.hub-engine-model{font-size:10px;color:var(--hud-muted);overflow-wrap:anywhere;margin-top:-3px;margin-bottom:12px}.hub-engine-controls{display:flex;align-items:stretch;gap:6px}.hub-engine-controls .hub-select{flex:1;font-size:10px!important}.hub-engine-controls .hub-btn{font-size:10px!important;padding-inline:8px}.hub-checkbox{display:inline-flex;align-items:center;gap:5px;font-size:10px;color:var(--hud-muted);margin-top:10px;cursor:pointer}.hub-checkbox input{accent-color:var(--hud-emerald);width:12px;height:12px;margin:0}.hub-progress-label{display:flex;justify-content:space-between;gap:6px;font-size:10px;color:var(--hud-muted);margin:12px 0 6px}.hub-progress-track{height:5px;border-radius:8px;background:color-mix(in srgb,var(--hud-emerald) 12%,var(--hud-surface));overflow:hidden}.hub-progress-fill{height:100%;border-radius:8px;background:linear-gradient(90deg,#10b981,#34d399);position:relative;transition:width .65s ease}.hub-progress-fill:after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,#ffffff55,transparent);animation:hub-sheen 1.4s linear infinite}@keyframes hub-sheen{from{translate:-100% 0}to{translate:100% 0}}.hub-progress-track.indeterminate .hub-progress-fill{width:40%!important;animation:hub-sheen 1.4s ease infinite}
        .hub-project-picker{display:flex;gap:7px;align-items:center;margin:11px 0}.hub-project-picker .hub-select{flex:1}.hub-memory-filters{gap:3px;margin-bottom:9px}.hub-memory-filters .hub-pill{padding:5px 6px;font-size:9px!important}.hub-memory-card{padding:0;transition:border-color .15s}.hub-memory-card.is-selected{border-color:color-mix(in srgb,var(--hud-emerald) 45%,var(--hud-border))}.hub-memory-open{display:block;text-align:left;width:100%;padding:12px;border:0;border-radius:10px;background:transparent}.hub-memory-open:hover{background:var(--hud-hover)}.hub-memory-open .hub-card-top{gap:8px}.hub-memory-open .hub-card-description{margin:7px 0 0;font-size:10px}.hub-memory-open .hub-card-name{font-size:11px}.hub-memory-date{font-size:9px;color:var(--hud-muted);margin-left:auto;white-space:nowrap}.hub-memory-detail{padding:0 12px 12px;border-top:1px solid var(--hud-border)}.hub-memory-detail .hub-field{margin-top:12px}.hub-editor{font:10.5px/1.85 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace!important;resize:vertical;tab-size:2;min-height:180px;white-space:pre-wrap;overflow-wrap:anywhere}.hub-editor-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}.hub-memory-detail .hub-editor-actions .hub-btn{font-size:10px!important;padding-inline:8px}.hub-detail-meta{display:flex;align-items:center;gap:6px;margin:10px 0;color:var(--hud-muted);font-size:9px}.hub-new-memory{margin-bottom:13px;padding:12px;background:var(--hud-surface);border:1px solid var(--hud-border);border-radius:10px}.hub-new-memory .hub-editor{min-height:140px}.hub-confirm-delete{border:1px solid color-mix(in srgb,var(--hud-red) 25%,var(--hud-border));background:color-mix(in srgb,var(--hud-red) 5%,transparent);border-radius:7px;padding:9px;margin-top:10px;font-size:10px;color:var(--hud-red)}.hub-confirm-delete .hub-row{margin-top:7px}
        .hub-agents-targets{display:flex;flex-direction:column;gap:6px;margin:9px 0 14px}.hub-agents-target{width:100%;display:flex;align-items:center;gap:9px;border:1px solid var(--hud-border);border-radius:9px;padding:10px 11px;text-align:left;background:var(--hud-bg-solid);color:var(--hud-muted)!important}.hub-agents-target.is-active{border-color:color-mix(in srgb,var(--hud-emerald) 35%,var(--hud-border));background:var(--hub-accent-bg);color:var(--hud-fg)!important}.hub-agents-target strong{font-size:11px;display:block;font-weight:550}.hub-agents-target small{display:block;font-size:9px;opacity:.7;margin-top:2px}.hub-radio{width:12px;height:12px;border:1px solid var(--hud-border);border-radius:50%;margin-left:auto;flex:none}.is-active>.hub-radio{border:4px solid var(--hud-emerald);background:var(--hud-bg-solid)}.hub-token-bar{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:14px 0 8px}.hub-token-bar strong{font-size:11px;font-weight:550}.hub-token{font-size:9px;color:var(--hud-emerald);background:var(--hub-accent-bg);padding:3px 6px;border-radius:5px;white-space:nowrap}.hub-token.is-warn{color:var(--hud-amber);background:color-mix(in srgb,var(--hud-amber) 10%,transparent)}.hub-token-warning{font-size:10px;color:var(--hud-amber);margin:0 0 9px}.hub-agents-editor{min-height:300px;resize:vertical;background:color-mix(in srgb,var(--hud-surface) 40%,var(--hud-bg-solid))}.hub-agents-save{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:11px}.hub-saved-hint{font-size:10px;color:var(--hud-muted)}.hub-sync-badges{display:flex;align-items:center;flex-wrap:wrap;gap:5px;margin-top:13px}.hub-sync-badges .hub-badge{font-size:9px}.hub-soft-route{width:100%;margin:0 0 7px;color:var(--hud-emerald)!important}
        .hub-footer{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:37px;padding:9px 17px;border-top:1px solid var(--hud-border);color:var(--hud-muted);font-size:9px;flex:none;background:var(--hud-bg-solid)}.hub-footer-status{display:flex;align-items:center;gap:5px}.hub-footer-status.is-connected{color:var(--hud-emerald)}.hub-footer-key{opacity:.65;font-size:9px}.hub-empty{display:flex;flex-direction:column;align-items:center;text-align:center;gap:8px;padding:35px 18px;color:var(--hud-muted);font-size:11px}.hub-empty>svg{opacity:.4}.hub-empty strong{font-weight:550;color:var(--hud-fg);font-size:12px}.hub-empty span{font-size:10px;max-width:260px;line-height:1.8}.hub-error{display:flex;align-items:flex-start;gap:8px;border:1px solid color-mix(in srgb,var(--hud-red) 22%,var(--hud-border));border-radius:9px;padding:12px;background:color-mix(in srgb,var(--hud-red) 4%,transparent);color:var(--hud-red);margin:10px 0}.hub-error>div{flex:1;min-width:0}.hub-error strong{display:block;font-size:11px;font-weight:550}.hub-error span{display:block;font-size:10px;margin-top:3px;overflow-wrap:anywhere}.hub-error .hub-btn{flex:none}.hub-skeleton>div{border:1px solid var(--hud-border);border-radius:11px;padding:16px;margin:10px 0}.hub-skeleton i{display:block;height:9px;margin:7px 0;background:var(--hud-surface);border-radius:4px;animation:hub-pulse 1.3s ease-in-out infinite}.hub-skeleton i:first-child{width:45%}.hub-skeleton i:last-child{width:65%}@keyframes hub-pulse{50%{opacity:.4}}.hub-toast{position:absolute;left:16px;right:16px;bottom:49px;display:flex;align-items:center;gap:8px;border:1px solid color-mix(in srgb,var(--hud-emerald) 25%,var(--hud-border));border-radius:9px;background:var(--hud-bg-solid);box-shadow:var(--hud-shadow);padding:11px 13px;font-size:11px;color:var(--hud-emerald);z-index:3;animation:hub-toast-in .18s ease;overflow-wrap:anywhere}.hub-toast.is-error{color:var(--hud-red);border-color:color-mix(in srgb,var(--hud-red) 28%,var(--hud-border))}@keyframes hub-toast-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
        @media(max-width:460px){#t3-hub-drawer{right:12px;width:min(430px,calc(100vw - 24px));border-radius:16px}.hub-header{padding:16px 14px 13px}.hub-tabs{margin-inline:12px;gap:2px}.hub-content{padding-inline:12px}.hub-tab{font-size:10px!important;gap:4px}.hub-title{font-size:16px}.hub-context .hub-badge:first-child{max-width:195px}.hub-shortcut{font-size:9px}.hub-import-grid{grid-template-columns:minmax(0,1fr) 86px auto;gap:4px}.hub-import-grid .hub-btn{padding-inline:6px}.hub-import-grid .hub-select{font-size:9px!important}.hub-memory-filters .hub-pill{padding-inline:5px}.hub-footer{padding-inline:13px}.hub-mode-row{gap:5px}.hub-live{font-size:8px}.hub-agents-editor{min-height:290px}}
        @media(prefers-reduced-motion:reduce){#t3-sidecar-hub *,#t3-sidecar-hub *:after{animation:none!important;transition:none!important}}
      `;
      style.textContent += `
        #t3-sidecar-hub .hub-subagent-scopes{display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:4px;background:var(--hud-surface);border:1px solid var(--hud-border);border-radius:10px;margin:3px 0 17px}
        #t3-sidecar-hub .hub-subagent-scope{padding:9px 6px;border:0;border-radius:7px;background:transparent;color:var(--hud-muted);font-size:11px;line-height:1.5;text-align:center}
        #t3-sidecar-hub .hub-subagent-scope small{display:block;font-size:9px;opacity:.75;margin-top:1px}
        #t3-sidecar-hub .hub-subagent-scope[aria-pressed=true]{background:var(--hud-bg-solid);color:var(--hud-fg);box-shadow:0 1px 3px #0000000c;font-weight:600}
        #t3-sidecar-hub .hub-subagent-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:5px}
        #t3-sidecar-hub .hub-subagent-heading h3{margin:0;font-size:12px;font-weight:600;line-height:1.6}
        #t3-sidecar-hub .hub-subagent-heading h3 span{font-size:10px;font-weight:400;color:var(--hud-muted);margin-left:7px;white-space:nowrap}
        #t3-sidecar-hub .hub-subagent-list{border:1px solid var(--hud-border);border-radius:13px;background:color-mix(in srgb,var(--hud-surface) 72%,var(--hud-bg-solid));overflow:hidden;margin-top:13px}
        #t3-sidecar-hub .hub-subagent-card{padding:16px 13px 11px;border-bottom:1px solid var(--hud-border)}
        #t3-sidecar-hub .hub-subagent-card:last-child{border-bottom:0}
        #t3-sidecar-hub .hub-subagent-main{display:grid;grid-template-columns:32px minmax(0,1fr) minmax(310px,1.12fr);align-items:center;gap:11px}
        #t3-sidecar-hub .hub-role-icon{display:grid;place-items:center;width:32px;height:32px;border-radius:10px;color:var(--role-color);background:color-mix(in srgb,var(--role-color) 13%,var(--hud-bg-solid));border:1px solid color-mix(in srgb,var(--role-color) 10%,transparent)}
        #t3-sidecar-hub .hub-subagent-summary{border:0;background:transparent;text-align:left;padding:0;min-width:0;width:100%}
        #t3-sidecar-hub .hub-subagent-name{display:flex;align-items:center;gap:6px;flex-wrap:wrap;line-height:1.5;font-size:12px;font-weight:600;overflow-wrap:anywhere}
        #t3-sidecar-hub .hub-tool-badge{font-size:9px;line-height:1.6;font-weight:400;padding:1px 5px;border:1px solid var(--hud-border);border-radius:5px;color:var(--hud-muted);white-space:nowrap}
        #t3-sidecar-hub .hub-subagent-desc{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:10px;line-height:1.65;color:var(--hud-muted);margin-top:4px;overflow-wrap:anywhere}
        #t3-sidecar-hub .hub-subagent-controls{display:grid;grid-template-columns:minmax(76px,.85fr) minmax(104px,1.3fr) minmax(100px,1fr);gap:5px;min-width:0}
        #t3-sidecar-hub .hub-subagent-controls .hub-select{width:100%;min-width:0;height:32px;padding-left:7px;padding-right:20px;font-size:10px!important;background-color:var(--hud-bg-solid);border-radius:8px;text-overflow:ellipsis}
        #t3-sidecar-hub .hub-subagent-meta{display:flex;align-items:center;justify-content:space-between;gap:7px;margin:9px 0 0 43px;min-width:0}
        #t3-sidecar-hub .hub-subagent-meta .hub-badge{font-size:8px;padding:1px 5px}
        #t3-sidecar-hub .hub-subagent-edit{display:inline-flex;align-items:center;gap:4px;flex:none;font-size:9px;color:var(--hud-muted);background:transparent;border:0;padding:3px 0}
        #t3-sidecar-hub .hub-subagent-edit:hover{color:var(--hud-fg)}
        #t3-sidecar-hub .hub-subagent-expand{display:grid;grid-template-rows:0fr;visibility:hidden;transition:grid-template-rows .2s,visibility .2s}
        #t3-sidecar-hub .hub-subagent-expand.is-expanded{grid-template-rows:1fr;visibility:visible}
        #t3-sidecar-hub .hub-subagent-expand>div{overflow:hidden;min-height:0}
        #t3-sidecar-hub .hub-subagent-editor{padding-top:14px;margin-top:11px;border-top:1px solid var(--hud-border)}
        #t3-sidecar-hub .hub-subagent-fields{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px;margin-bottom:10px}
        #t3-sidecar-hub .hub-subagent-fields .hub-field{margin:0;min-width:0}
        #t3-sidecar-hub .hub-subagent-editor .hub-editor{min-height:150px;margin-top:0;font-size:11px!important}
        #t3-sidecar-hub .hub-subagent-editor .hub-editor-actions{align-items:center}
        #t3-sidecar-hub .hub-subagent-editor .hub-checkbox{margin:0 auto 0 0;font-size:10px}
        #t3-sidecar-hub .hub-subagent-custom{margin:10px 0 0 43px;padding:9px;border:1px solid var(--hud-border);border-radius:8px;background:var(--hud-bg-solid)}
        #t3-sidecar-hub .hub-subagent-custom .hub-row{margin-top:5px}.hub-subagent-custom .hub-input{min-width:0;flex:1}
        #t3-sidecar-hub .hub-subagent-clones{padding:14px;border:1px dashed var(--hud-border);border-radius:10px;background:var(--hud-bg-solid);margin-top:12px}
        #t3-sidecar-hub .hub-subagent-clones strong{display:block;font-size:11px;margin-bottom:9px}
        #t3-sidecar-hub .hub-subagent-clones .hub-row{flex-wrap:wrap}
        #t3-sidecar-hub .hub-subagent-note{display:flex;align-items:flex-start;gap:6px;color:var(--hud-muted);font-size:10px;line-height:1.7;margin-top:14px}
        #t3-sidecar-hub .hub-subagent-note svg{margin-top:2px;color:var(--hud-emerald)}
        #t3-sidecar-hub .hub-cyan{color:#0891b2;border-color:#0891b233;background:#0891b210}#t3-sidecar-hub.is-dark .hub-cyan{color:#67e8f9;border-color:#67e8f933;background:#67e8f910}
        #t3-hub-slash-palette{position:fixed;pointer-events:auto;z-index:3;display:flex;flex-direction:column;overflow:hidden;width:380px;background:var(--hud-bg-solid);border:1px solid var(--hud-border);border-radius:13px;box-shadow:var(--hud-shadow);-webkit-app-region:no-drag}
        #t3-hub-slash-palette .hub-slash-header{display:flex;align-items:center;gap:7px;padding:11px 12px 8px;font-size:11px;font-weight:600;flex:none}
        #t3-hub-slash-palette .hub-slash-project{margin-left:auto;font-size:9px;font-weight:400;color:var(--hud-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:42%}
        #t3-hub-slash-palette .hub-slash-list{overflow:auto;overscroll-behavior:contain;padding:0 5px 5px;scrollbar-width:thin;min-height:0}
        #t3-hub-slash-palette .hub-slash-row{display:flex;align-items:center;gap:7px;border-radius:8px;position:relative;margin:2px 0}
        #t3-hub-slash-palette .hub-slash-row.is-active{background:var(--hud-hover)}
        #t3-hub-slash-palette .hub-slash-select{display:flex;align-items:center;gap:8px;min-width:0;flex:1;padding:9px 8px;background:transparent;border:0;text-align:left;border-radius:8px}
        #t3-hub-slash-palette .hub-slash-type{display:grid;place-items:center;width:26px;height:26px;flex:none;border-radius:7px;background:var(--hub-accent-bg);color:var(--hud-emerald)}
        #t3-hub-slash-palette .hub-slash-type.is-agent{background:color-mix(in srgb,var(--hud-violet) 12%,transparent);color:var(--hud-violet)}
        #t3-hub-slash-palette .hub-slash-label{font-size:11px;font-weight:550;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        #t3-hub-slash-palette .hub-slash-description{font-size:9px;color:var(--hud-muted);display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px}
        #t3-hub-slash-palette .hub-slash-badge{font-size:8px;max-width:44%;flex-shrink:1;padding:1px 5px;overflow:hidden;text-overflow:ellipsis}
        #t3-hub-slash-palette .hub-slash-edit{opacity:0;position:absolute;right:7px;background:var(--hud-bg-solid);border:1px solid var(--hud-border);border-radius:6px;font-size:9px;padding:4px 5px;pointer-events:none}
        #t3-hub-slash-palette .hub-slash-row:hover .hub-slash-edit,#t3-hub-slash-palette .hub-slash-row:focus-within .hub-slash-edit{opacity:1;pointer-events:auto}
        #t3-hub-slash-palette .hub-slash-edit:focus-visible{opacity:1;pointer-events:auto}
        #t3-hub-slash-palette .hub-slash-footer{padding:7px 12px;font-size:9px;color:var(--hud-muted);border-top:1px solid var(--hud-border);flex:none;display:flex;justify-content:space-between;gap:6px}
        #t3-hub-slash-palette .hub-slash-empty{padding:17px 12px;font-size:11px;color:var(--hud-muted)}
        @media(max-width:760px){#t3-sidecar-hub .hub-subagent-main{grid-template-columns:32px minmax(0,1fr)}#t3-sidecar-hub .hub-subagent-controls{grid-column:2;grid-template-columns:minmax(76px,.85fr) minmax(92px,1.2fr) minmax(92px,1fr);margin-top:0}#t3-sidecar-hub .hub-subagent-desc{-webkit-line-clamp:2}#t3-sidecar-hub .hub-subagent-card{padding:14px 11px 10px}}
        @media(max-width:460px){#t3-sidecar-hub .hub-tabs{grid-template-columns:1.3fr 1.05fr .65fr .88fr 1.12fr;gap:1px}#t3-sidecar-hub .hub-tab{font-size:9px!important;gap:3px}#t3-sidecar-hub .hub-tab svg{width:11px;height:11px}#t3-sidecar-hub .hub-subagent-controls{grid-column:1/-1;margin-left:0;gap:5px}#t3-sidecar-hub .hub-subagent-meta{margin-left:0}#t3-sidecar-hub .hub-subagent-custom{margin-left:0}#t3-sidecar-hub .hub-subagent-heading h3{font-size:11px}#t3-sidecar-hub .hub-subagent-heading .hub-btn{font-size:10px!important;padding-inline:7px}#t3-sidecar-hub .hub-subagent-fields{gap:8px}#t3-sidecar-hub .hub-subagent-editor .hub-editor-actions .hub-btn{font-size:10px!important}#t3-sidecar-hub .hub-subagent-scope{font-size:10px}.hub-subagent-name{font-size:12px}}
        @media(prefers-reduced-motion:reduce){#t3-sidecar-hub .hub-subagent-expand{transition:none}}
      `;
      style.textContent += `
        /* Sidecar Hub v2: ZCode's quiet grouped surfaces, sized for a 480px drawer. */
        #t3-sidecar-hub #t3-hub-drawer{width:min(480px,calc(100vw - 24px));border-radius:18px}
        #t3-sidecar-hub .hub-header{padding:20px 19px 13px}
        #t3-sidecar-hub .hub-title{font-size:19px;letter-spacing:-.55px;display:flex;align-items:center;gap:8px}
        #t3-sidecar-hub .hub-version{font-size:9px;letter-spacing:.03em;font-weight:550;color:var(--hud-muted);border:1px solid var(--hud-border);padding:1px 5px;border-radius:5px}
        #t3-sidecar-hub .hub-kicker{font-size:11px;letter-spacing:0;margin-top:4px}
        #t3-sidecar-hub .hub-brand{width:38px;height:38px;border-radius:12px}
        #t3-sidecar-hub .hub-scope-bar{display:flex;align-items:center;gap:10px;margin-top:19px;min-width:0}
        #t3-sidecar-hub .hub-scope-select{width:auto;max-width:calc(100% - 50px);border-radius:20px;padding:7px 27px 7px 11px;background:color-mix(in srgb,var(--hud-surface) 55%,var(--hud-bg-solid));font-size:11px!important;height:33px}
        #t3-sidecar-hub .hub-context{margin-top:9px}
        #t3-sidecar-hub .hub-context-status{display:flex;align-items:center;gap:6px;min-width:0;max-width:100%;font-size:10px;color:var(--hud-muted)}
        #t3-sidecar-hub .hub-context-status>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        #t3-sidecar-hub .hub-context-status.is-ready{color:var(--hud-emerald)}
        #t3-sidecar-hub .hub-tabs{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));padding:4px;gap:3px;margin:0 16px 15px;border-color:color-mix(in srgb,var(--hud-border) 75%,transparent);border-radius:12px;background:color-mix(in srgb,var(--hud-surface) 70%,var(--hud-bg-solid))}
        #t3-sidecar-hub .hub-tab{grid-column:span 3;font-size:11px!important;gap:5px;padding:7px 3px;min-height:31px;border-radius:8px}
        #t3-sidecar-hub .hub-tab:nth-child(n+5){grid-column:span 4}
        #t3-sidecar-hub .hub-tab-count{font-size:9px;line-height:16px;min-width:16px;padding:0 3px;border-radius:5px;background:var(--hud-hover);font-variant-numeric:tabular-nums;font-weight:450;color:var(--hud-muted)}
        #t3-sidecar-hub .hub-tab[aria-selected=true]{box-shadow:0 1px 4px #0000000c}
        #t3-sidecar-hub .hub-tab[aria-selected=true] .hub-tab-count{color:var(--hud-emerald);background:var(--hub-accent-bg)}
        #t3-sidecar-hub .hub-content{padding:0 18px 22px;overflow-x:hidden}
        #t3-sidecar-hub .hub-section-heading{font-size:13px;line-height:1.6;margin-top:3px;margin-bottom:5px}
        #t3-sidecar-hub .hub-description{font-size:11px;margin-bottom:14px}
        #t3-sidecar-hub .hub-search{margin:12px 0}
        #t3-sidecar-hub .hub-search .hub-input{height:35px;background:var(--hud-bg-solid);border-radius:10px}
        #t3-sidecar-hub .hub-btn{border-radius:8px}
        #t3-sidecar-hub .hub-btn.hub-primary{background:var(--hud-fg);color:var(--hud-bg-solid)!important}
        #t3-sidecar-hub .hub-btn.hub-primary:hover:not(:disabled){background:var(--hud-fg);filter:brightness(.9)}
        #t3-sidecar-hub .hub-form-panel{margin-top:12px}
        #t3-sidecar-hub .hub-card{border-radius:12px}
        #t3-sidecar-hub .hub-card-name{font-size:12px;line-height:1.55}
        #t3-sidecar-hub .hub-card-description{-webkit-line-clamp:3;line-height:1.65}
        #t3-sidecar-hub .hub-domain-hint{margin:14px 0}
        #t3-sidecar-hub #t3-hub-plugin-list{margin-top:16px}
        #t3-sidecar-hub .hub-plugin-card{padding:15px;background:color-mix(in srgb,var(--hud-surface) 52%,var(--hud-bg-solid));border-color:transparent;margin-bottom:12px}
        #t3-sidecar-hub .hub-plugin-card.is-core{background:linear-gradient(115deg,color-mix(in srgb,var(--hud-emerald) 8%,var(--hud-bg-solid)),color-mix(in srgb,var(--hud-violet) 4%,var(--hud-bg-solid)));border-color:color-mix(in srgb,var(--hud-emerald) 19%,var(--hud-border))}
        #t3-sidecar-hub .hub-plugin-card .hub-card-top{align-items:center;gap:11px}
        #t3-sidecar-hub .hub-capabilities{display:flex;gap:5px;flex-wrap:wrap;margin:10px 0 13px}
        #t3-sidecar-hub .hub-capability{border:1px solid var(--hud-border);border-radius:5px;padding:2px 6px;font-size:9px;color:var(--hud-muted);white-space:nowrap;background:color-mix(in srgb,var(--hud-bg-solid) 65%,transparent)}
        #t3-sidecar-hub .hub-scope-control{border-color:var(--hud-border);padding:3px;background:color-mix(in srgb,var(--hud-bg-solid) 35%,transparent)}
        #t3-sidecar-hub .hub-scope-control>button{padding-block:5px}
        #t3-sidecar-hub .hub-brand-icon{width:38px;height:38px;position:relative;display:grid;place-items:center;flex:none;border-radius:11px;background:var(--hud-bg-solid);color:var(--hud-muted)}
        #t3-sidecar-hub .hub-brand-icon>svg{width:25px;height:25px}
        #t3-sidecar-hub .hub-brand-icon>img{position:absolute;inset:5px;width:28px;height:28px;object-fit:contain;border-radius:5px;background:var(--hud-bg-solid)}
        #t3-sidecar-hub .hub-brand-crystal{color:var(--hud-violet);background:color-mix(in srgb,var(--hud-violet) 8%,var(--hud-bg-solid))}
        #t3-sidecar-hub .hub-brand-globe{color:#3489a7}.is-dark .hub-brand-globe{color:#68c6e4}
        #t3-sidecar-hub .hub-brand-bag{color:#b97b3c}.is-dark .hub-brand-bag{color:#e1b171}
        #t3-sidecar-hub .hub-brand-graph{color:#7c6ad5}.is-dark .hub-brand-graph{color:#b2a1ff}
        #t3-sidecar-hub .hub-brand-context{color:#1f8b66}.is-dark .hub-brand-context{color:#5dd1a8}
        #t3-sidecar-hub .hub-brand-playwright{color:#2aab68}.is-dark .hub-brand-playwright{color:#6dd897}
        #t3-sidecar-hub .hub-brand-cloud{color:#f49b35}.hub-brand-display{color:#5087c7}.hub-brand-sparkle{color:#b97ac9}
        #t3-sidecar-hub .hub-connection-dot{position:absolute;bottom:-1px;right:-1px;width:11px;height:11px;border:2px solid var(--hud-bg-solid);border-radius:50%;background:#a3a7ae}
        #t3-sidecar-hub .hub-connection-dot.is-connected{background:#10B981}
        #t3-sidecar-hub .hub-switch{width:31px;height:18px;padding:2px;border:0;border-radius:12px;flex:none;background:#aaadb2;align-self:center;transition:background .18s}
        #t3-sidecar-hub .hub-switch>span{display:block;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px #0002;transition:transform .18s}
        #t3-sidecar-hub .hub-switch[aria-checked=true]{background:#10B981}
        #t3-sidecar-hub .hub-switch[aria-checked=true]>span{transform:translateX(13px)}
        #t3-sidecar-hub .hub-mcp-actions{display:flex;gap:5px;flex-wrap:wrap;margin:0 0 18px}
        #t3-sidecar-hub .hub-mcp-actions .hub-btn{min-height:28px;padding-inline:7px;font-size:10px!important}
        #t3-sidecar-hub .hub-mcp-group{background:#f3f4f5;border:1px solid transparent;border-radius:13px;overflow:hidden}
        #t3-sidecar-hub.is-dark .hub-mcp-group{background:color-mix(in srgb,var(--hud-surface) 84%,var(--hud-bg-solid));border-color:color-mix(in srgb,var(--hud-border) 35%,transparent)}
        #t3-sidecar-hub .hub-mcp-row{display:flex;gap:10px;align-items:flex-start;padding:13px 12px;border-bottom:1px solid var(--hud-border);min-width:0}
        #t3-sidecar-hub .hub-mcp-row:last-child{border-bottom:0}
        #t3-sidecar-hub .hub-mcp-name{font-size:12px;font-weight:550;line-height:1.6;overflow-wrap:anywhere}
        #t3-sidecar-hub .hub-mcp-detail{font-size:10px;color:var(--hud-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;margin-top:2px}
        #t3-sidecar-hub .hub-mcp-row-options{display:flex;gap:7px;align-items:center;min-width:0;margin-top:7px}
        #t3-sidecar-hub .hub-mode-pill{width:113px;max-width:100%;padding:3px 21px 3px 6px;font-size:9px!important;line-height:1.5;border-color:color-mix(in srgb,var(--hud-border) 75%,transparent);border-radius:6px;background-color:color-mix(in srgb,var(--hud-bg-solid) 65%,transparent)}
        #t3-sidecar-hub .hub-upstream-status{font-size:10px;display:flex;align-items:flex-start;gap:5px;color:var(--hud-muted);margin-top:3px;line-height:1.65}
        #t3-sidecar-hub .hub-upstream-status>.hub-dot{margin-top:6px;background:#a3a7ae}
        #t3-sidecar-hub .hub-upstream-status.is-available>.hub-dot{background:#10B981}
        #t3-sidecar-hub .hub-mcp-remove{margin-left:auto;width:22px;height:22px}
        #t3-sidecar-hub .hub-group-heading{margin-top:18px;margin-bottom:11px}
        #t3-sidecar-hub .hub-catalog-heading{margin-top:26px;padding-top:17px;border-top:1px solid var(--hud-border);margin-bottom:15px}
        #t3-sidecar-hub .hub-upstream-heading{font-size:11px;font-weight:550;margin:0 0 8px}.hub-upstream-heading>.hub-count{margin-left:5px}
        #t3-sidecar-hub .hub-upstream-group{margin-top:17px}
        #t3-sidecar-hub .hub-quiet-empty{font-size:11px;padding:15px;color:var(--hud-muted);border-radius:10px;background:var(--hud-surface)}
        #t3-sidecar-hub .hub-hook-card{background:color-mix(in srgb,var(--hud-surface) 60%,var(--hud-bg-solid));border-color:transparent;padding:14px;margin-bottom:10px}
        #t3-sidecar-hub .hub-hook-card .hub-card-name{font-size:12px}.hub-hook-card .hub-card-description{margin:9px 0 12px}
        #t3-sidecar-hub .hub-hook-command{display:block;margin-bottom:11px;padding:7px 9px;font-size:10px;line-height:1.65;background:var(--hud-bg-solid);border-radius:6px;color:var(--hud-muted);overflow-wrap:anywhere;white-space:pre-wrap}
        #t3-sidecar-hub .hub-subagent-scopes{display:flex;padding:3px;margin:0 0 17px;border:0;background:var(--hud-surface)}
        #t3-sidecar-hub .hub-subagent-scope{flex:1;padding:6px;font-size:10px}.hub-subagent-scope small{display:none!important}
        #t3-sidecar-hub .hub-subagent-list{border-color:transparent;background:#f3f4f5;border-radius:13px}
        #t3-sidecar-hub.is-dark .hub-subagent-list{background:color-mix(in srgb,var(--hud-surface) 82%,var(--hud-bg-solid))}
        #t3-sidecar-hub .hub-subagent-card{padding:15px 13px 13px}
        #t3-sidecar-hub .hub-subagent-main{grid-template-columns:38px minmax(0,1fr);gap:9px 10px;align-items:center}
        #t3-sidecar-hub .hub-subagent-controls{grid-column:1/-1;grid-template-columns:minmax(0,.85fr) minmax(0,1.35fr) minmax(0,.8fr);gap:6px;margin-top:1px}
        #t3-sidecar-hub .hub-subagent-controls .hub-select{font-size:10px!important;padding-right:17px;height:31px}
        #t3-sidecar-hub .hub-subagent-meta{margin:9px 0 0;display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-start}
        #t3-sidecar-hub .hub-subagent-edit{margin-left:auto;font-size:9px}
        #t3-sidecar-hub .hub-subagent-custom{margin-left:0}
        #t3-sidecar-hub .hub-subagent-desc{font-size:10.5px;line-height:1.65}
        #t3-sidecar-hub .hub-subagent-name{font-size:12px;gap:6px}
        #t3-sidecar-hub .hub-memory-policy{font-size:9px!important;line-height:1.5;width:174px;max-width:100%;min-height:24px;padding:3px 18px 3px 6px;border-radius:6px;border-color:color-mix(in srgb,var(--hud-emerald) 18%,var(--hud-border));color:var(--hud-emerald);background:color-mix(in srgb,var(--hud-emerald) 5%,var(--hud-bg-solid))}
        #t3-sidecar-hub .hub-memory-policy.policy-readonly{color:var(--hud-blue);background:color-mix(in srgb,var(--hud-blue) 5%,var(--hud-bg-solid));border-color:color-mix(in srgb,var(--hud-blue) 16%,var(--hud-border))}
        #t3-sidecar-hub .hub-memory-policy.policy-off{color:var(--hud-muted);background:var(--hud-bg-solid);border-color:var(--hud-border)}
        #t3-sidecar-hub .hub-subagent-editor .hub-memory-policy{width:100%;font-size:11px!important;padding:7px}
        #t3-sidecar-hub .hub-bot-avatar{width:38px;height:38px;display:grid;place-items:center;border-radius:11px;background:#F4F5F7;flex:none}
        #t3-sidecar-hub.is-dark .hub-bot-avatar{background:rgba(255,255,255,.07)}
        #t3-sidecar-hub .hub-bot-head{width:24px;height:24px;border-radius:8.5px;display:grid;place-items:center;background:var(--bot-color);transform-origin:50% 70%}
        #t3-sidecar-hub .hub-bot-look{display:block;animation:t3BotLook 5.5s ease-in-out var(--bot-delay) infinite}
        #t3-sidecar-hub .hub-bot-eyes{display:flex;gap:4px;transform:translateX(1px);animation:t3BotDoubleBlink 5.5s ease-in-out var(--bot-delay) infinite;transform-origin:center}
        #t3-sidecar-hub .hub-bot-eyes>i{display:block;width:3.6px;height:6.4px;border-radius:1.8px;background:#fff}
        @keyframes t3BotDoubleBlink{0%,88%,92%,96%,100%{transform:translateX(1px) scaleY(1)}90%,94%{transform:translateX(1px) scaleY(.18)}}
        @keyframes t3BotLook{0%,66%,100%{transform:translate(0,0)}74%,80%{transform:translate(1.5px,-1px)}90%{transform:translate(0,1.5px)}}
        @keyframes t3BotHello{0%,28%,56%,100%{transform:translateX(1px) scaleY(1)}14%,42%{transform:translateX(1px) scaleY(.18)}}
        @keyframes t3BotTilt{0%,100%{transform:rotate(0) translateY(0)}25%,65%{transform:rotate(-2deg) translateY(-1.5px)}}
        #t3-sidecar-hub .hub-subagent-card.is-playful .hub-bot-eyes{animation:t3BotHello .7s ease-in-out both}
        #t3-sidecar-hub .hub-subagent-card.is-playful .hub-bot-head{animation:t3BotTilt .75s ease-in-out both}
        #t3-sidecar-hub .hub-memory-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:10px 0 15px}
        #t3-sidecar-hub .hub-memory-toolbar>.hub-btn{color:var(--hud-emerald);border-color:color-mix(in srgb,var(--hud-emerald) 25%,var(--hud-border));background:var(--hub-accent-bg)}
        #t3-sidecar-hub .hub-memory-hits{font-size:9px;color:var(--hud-muted)}
        #t3-sidecar-hub .hub-memory-history{padding:0 12px 11px}
        #t3-sidecar-hub .hub-history-toggle{display:flex;align-items:center;gap:5px;font-size:10px;border:0;padding:4px 0;background:transparent;color:var(--hud-muted)}
        #t3-sidecar-hub .hub-history-toggle[aria-expanded=true]>svg{transform:rotate(90deg)}
        #t3-sidecar-hub .hub-history-list{border-left:1px solid var(--hud-border);margin:7px 0 0 4px;padding-left:11px}
        #t3-sidecar-hub .hub-history-entry{padding:9px 10px;margin-bottom:7px;background:var(--hud-surface);border-radius:7px;min-width:0}
        #t3-sidecar-hub .hub-history-entry .hub-row{font-size:9px;color:var(--hud-muted);flex-wrap:wrap;gap:6px}.hub-history-entry strong{color:var(--hud-violet)}
        #t3-sidecar-hub .hub-history-entry p{font-size:10px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--hud-muted);margin:7px 0 9px}
        #t3-sidecar-hub .hub-history-agent{color:var(--hud-muted);font-size:9px;margin-top:3px}
        @media(max-width:460px){#t3-sidecar-hub #t3-hub-drawer{right:8px;top:8px;bottom:8px;width:calc(100vw - 16px);max-height:calc(100dvh - 16px);border-radius:16px}#t3-sidecar-hub .hub-header{padding:16px 15px 12px}#t3-sidecar-hub .hub-tabs{margin:0 11px 14px}#t3-sidecar-hub .hub-content{padding-inline:13px}#t3-sidecar-hub .hub-tab{font-size:10px!important;gap:4px}#t3-sidecar-hub .hub-mcp-actions .hub-btn{font-size:9px!important;padding-inline:6px}#t3-sidecar-hub .hub-mcp-actions{gap:4px}#t3-sidecar-hub .hub-subagent-card{padding:13px 11px}#t3-sidecar-hub .hub-subagent-controls{grid-template-columns:minmax(0,.8fr) minmax(0,1.25fr) minmax(0,.8fr)}#t3-sidecar-hub .hub-subagent-meta{gap:5px}#t3-sidecar-hub .hub-subagent-meta .hub-subagent-edit{font-size:8px}#t3-sidecar-hub .hub-memory-policy{width:169px}#t3-sidecar-hub .hub-project-picker{flex-wrap:wrap}#t3-sidecar-hub .hub-project-picker>.hub-select{flex-basis:100%}#t3-sidecar-hub .hub-subagent-heading h3{font-size:12px}#t3-sidecar-hub .hub-import-grid{grid-template-columns:minmax(0,1fr) 85px auto}}
        @media(prefers-reduced-motion:reduce){#t3-sidecar-hub .hub-bot-avatar *,#t3-sidecar-hub .hub-switch>span{animation:none!important;transition:none!important}}
      `;
      document.head.appendChild(style);
      root = document.createElement("div");
      root.id = "t3-sidecar-hub";
      root.innerHTML = `<button type="button" id="t3-hub-handle" aria-controls="t3-hub-drawer" aria-expanded="false">${icon("hub", 15)}<span class="hub-handle-label">HUB</span><span class="hub-handle-count" hidden></span></button><aside id="t3-hub-drawer" role="complementary" aria-labelledby="t3-hub-title" aria-hidden="true" inert><header class="hub-header"></header><nav class="hub-tabs" role="tablist"></nav><section id="t3-hub-panel" class="hub-content" role="tabpanel" tabindex="0"></section><footer class="hub-footer"></footer><div class="hub-toast" role="status" aria-live="polite" hidden></div></aside>`;
      document.body.appendChild(root);
      drawer = root.querySelector("#t3-hub-drawer");
      handle = root.querySelector("#t3-hub-handle");
      content = root.querySelector(".hub-content");
      palette = document.createElement("section");
      palette.id = "t3-hub-slash-palette";
      palette.hidden = true;
      palette.setAttribute("aria-label", "项目 Skills 与子智能体快捷指令");
      root.appendChild(palette);
      state.lang = detectLang();
      state.dark = isDark();
      root.classList.toggle("is-dark", state.dark);
      renderChrome();
      positionHandle();
      listen(root, "click", onClick);
      listen(root, "input", onInput);
      listen(root, "change", onChange);
      listen(root, "error", (event) => { if (event.target.matches?.(".hub-brand-icon>img")) event.target.remove(); }, true);
      listen(root, "pointerover", (event) => { const card = event.target.closest("[data-subagent-card]"); if (card && !card.contains(event.relatedTarget)) greetBots(card.dataset.subagentCard); });
      listen(root, "keydown", onEditorKeydown);
      listen(root, "submit", (event) => {
        const form = event.target.dataset.form;
        if (["import", "plugin", "hook"].includes(form)) { event.preventDefault(); if (form === "import") runImport(); if (form === "plugin") installPlugin(); if (form === "hook") saveHook(); }
      });
      listen(handle, "pointerdown", onDragStart);
      listen(handle, "pointermove", onDragMove);
      listen(handle, "pointerup", onDragEnd);
      listen(handle, "pointercancel", onDragCancel);
      listen(window, "keydown", onKeydown);
      listen(document, "input", onComposerInput, true);
      listen(document, "focusin", onComposerInput, true);
      listen(document, "click", onComposerInput, true);
      listen(document, "keyup", onComposerKeyup, true);
      listen(document, "keydown", onComposerKeydown, true);
      listen(document, "compositionstart", () => { composing = true; closeSlash(); }, true);
      listen(document, "compositionend", (event) => { composing = false; onComposerInput(event); }, true);
      listen(document, "focusout", () => later(() => { if (slashSession && document.activeElement !== slashSession.editor && !palette.contains(document.activeElement)) closeSlash(); }, 0), true);
      listen(document, "pointerdown", (event) => { if (slashSession && !slashSession.editor.contains(event.target) && !palette.contains(event.target)) closeSlash(); }, true);
      listen(palette, "pointerdown", (event) => { if (event.target.closest("button")) event.preventDefault(); });
      listen(palette, "pointermove", (event) => { const row = event.target.closest("[data-slash-index]"); if (row && slashSession) setSlashActive(Number(row.dataset.slashIndex)); });
      listen(window, "resize", positionSlash);
      listen(window, "blur", closeSlash);
      listen(document, "scroll", positionSlash, true);
      if (window.visualViewport) { listen(window.visualViewport, "resize", positionSlash); listen(window.visualViewport, "scroll", positionSlash); }
      listen(window, "resize", positionHandle);
      listen(window, "hashchange", checkRoute);
      listen(window, "popstate", checkRoute);
      listen(window, "storage", syncEnvironment);
      listen(document, "visibilitychange", () => { if (!document.hidden) { checkRoute(); if (state.open) pollEmbed(); } });
      const media = window.matchMedia?.("(prefers-color-scheme: dark)");
      if (media?.addEventListener) listen(media, "change", syncEnvironment);
      observer = new MutationObserver(() => { syncEnvironment(); syncOcclusion(); });
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "lang", "style"] });
      observer.observe(document.body, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
      ensureRouterSubscription();
      routeTimer = setInterval(() => { if (!disposed && !document.hidden) { ensureRouterSubscription(); checkRoute(); syncEnvironment(); syncOcclusion(); } }, 900);
      lastRoute = routeKey();
      syncOcclusion();
      setOpen(state.open, false);
      refreshContext();
    }

    function renderChrome() {
      if (!root || disposed) return;
      root.dataset.tab = state.tab;
      const context = state.context || {};
      const projectName = projectTitle();
      const rawCli = context.activeProvider || context.activeCli || context.cli || context.provider || context.providerInstanceId;
      const cli = typeof rawCli === "object" ? rawCli?.name || rawCli?.id : rawCli;
      const cliNames = { codex: "Codex", antigravity: "Antigravity", agy: "Antigravity", muse: "Muse", pi: "Pi", claude: "Claude" };
      const model = typeof context.activeModel === "object" ? context.activeModel?.name || context.activeModel?.id : context.activeModel;
      const cliName = [cliNames[String(cli).toLowerCase()] || cli, model].filter(Boolean).join(" · ") || tr("本地工作区就绪", "Workspace Ready");
      const count = context.activeProjectCount ?? context.projectCount ?? (Array.isArray(context.projects) ? context.projects.length : null);
      const badge = root.querySelector(".hub-handle-count");
      badge.hidden = count == null;
      badge.textContent = String(count ?? "");
      handle.title = tr("工作台 Hub · 拖动可调整位置 · ⌘⇧K / Alt+H", "Sidecar Hub · Drag to reposition · ⌘⇧K / Alt+H");
      handle.setAttribute("aria-label", `${tr("打开工作台 Hub", "Open Sidecar Hub")}${count == null ? "" : ` · ${count}`}`);
      root.querySelector(".hub-header").innerHTML = `<div class="hub-title-row"><span class="hub-brand">${icon("hub", 21)}</span><div class="hub-grow"><div id="t3-hub-title" class="hub-title">Sidecar Hub <span class="hub-version">v2</span></div><div class="hub-kicker">${esc(tr("你的 AI 工作空间，井然有序。", "A little order for your AI workspace."))}</div></div><button type="button" class="hub-icon-btn" data-action="refresh" title="${esc(tr("刷新当前页", "Refresh tab"))}" aria-label="${esc(tr("刷新当前页", "Refresh tab"))}">${state.refreshing ? spinner() : icon("refresh", 15)}</button><button type="button" class="hub-icon-btn" data-action="close" aria-label="${esc(tr("关闭", "Close"))}">${icon("close", 17)}</button></div><div class="hub-scope-bar"><select class="hub-select hub-scope-select" name="hub-scope" aria-label="${esc(tr("工作空间作用域", "Workspace scope"))}"><option value="global" ${state.scope === "global" ? "selected" : ""}>${esc(tr("🖥️ 本机 · 全局", "🖥️ Local · Global"))}</option><option value="project" ${state.scope === "project" ? "selected" : ""} ${projectDisabled() ? "disabled" : ""}>📁 ${esc(tr("当前项目", "Project"))} · ${esc(projectName)}</option></select><span class="hub-shortcut">⌘ ⇧ K</span></div><div class="hub-context"><span class="hub-context-status ${state.connected ? "is-ready" : ""}" title="${esc(cliName)}"><i class="hub-dot"></i><span>${esc(state.contextError ? tr("工作区连接暂不可用", "Workspace unavailable") : cliName)}</span></span></div>`;
      const tabs = [["plugins", tr("插件", "Plugins")], ["mcp", "MCP"], ["skills", tr("技能", "Skills")], ["hooks", "Hooks"], ["subagents", tr("子智能体", "Sub-Agents")], ["memory", tr("记忆库", "Memory")], ["agents", "AGENTS.md"]];
      root.querySelector(".hub-tabs").innerHTML = tabs.map(([key, label]) => {
        const count = tabCount(key);
        return `<button type="button" id="t3-hub-tab-${key}" class="hub-tab" role="tab" data-action="tab" data-tab="${key}" aria-controls="t3-hub-panel" aria-selected="${key === state.tab}" tabindex="${key === state.tab ? 0 : -1}"><span>${esc(label)}</span>${count == null ? "" : `<span class="hub-tab-count">${esc(count)}</span>`}</button>`;
      }).join("");
      content.setAttribute("aria-labelledby", `t3-hub-tab-${state.tab}`);
      root.querySelector(".hub-footer").innerHTML = `<span class="hub-footer-status ${state.connected ? "is-connected" : ""}"><i class="hub-dot"></i>${esc(state.connected ? tr("已连接 · 本地工作空间", "Connected · Local workspace") : tr("等待 Hub 连接", "Waiting for Hub"))}</span><span class="hub-footer-key">${esc(tr("按 Esc 收起", "Esc to close"))}</span>`;
    }
    function tabCount(key) {
      const counts = state.context?.counts || {};
      if (key === "plugins") return cache.plugins ? pluginItems().length : counts.plugins ?? null;
      if (key === "mcp") return cache.mcp ? mcpServers().length : counts.activeMcps ?? null;
      if (key === "skills") return cache.skills ? items(cache.skills, ["items", "skills"]).length : counts.activeSkills ?? null;
      if (key === "hooks") return cache.hooks ? hookItems().length : counts.hooks ?? null;
      if (key === "subagents") return cache.subagents ? subagentItems().length : counts.subagents ?? null;
      if (key === "memory") {
        const project = items(cache.overview, ["projects", "items"]).find((entry) => state.memoryProject === "global" ? ["global", "_global"].includes(entry.slug) : entry.projectRoot === selectedMemoryRoot());
        return project?.total ?? cache.overview?.total ?? counts.projectMemories ?? (cache.memory ? memoryRecords().length : null);
      }
      return null;
    }
    function defaultScope() { return state.scope === "project" && state.projectRoot ? "project" : "global"; }
    function setScope(scope) {
      if (scope === "project" && projectDisabled()) return;
      state.scope = scope;
      state.importScope = scope;
      state.subagentScope = scope;
      state.agentsTarget = scope;
      state.memoryProject = scope === "project" ? "current" : "global";
      state.selectedMemory = null;
      state.supersedeItems = [];
      state.supersedeLoading = false;
      memoryVersion++;
      cache.memory = null;
      if (drafts.__new) drafts.__new.supersedes = "";
      storageSet("t3-hub-scope", scope);
      renderChrome(); renderTab();
      loadTab().then(() => { if (!disposed && drafts.__new?.open && state.tab === "memory") openNewMemory(); });
    }
    function scopeControl(domain, item, disabled = false) {
      return `<div class="hub-segments hub-scope-control" role="group" aria-label="${esc(item.title || item.name || item.id)} ${esc(tr("启用范围", "Activation scope"))}">${[["off", tr("关闭", "Off")], ["project", tr("仅本项目", "This project")], ["global", tr("全局", "Global")]].map(([scope, label]) => `<button type="button" data-action="${domain}-scope" data-id="${esc(item.id)}" data-scope="${scope}" class="${(item.scope || "off") === scope ? "is-active" : ""}" aria-pressed="${(item.scope || "off") === scope}" ${disabled || scope === "project" && projectDisabled() ? "disabled" : ""}>${esc(label)}</button>`).join("")}</div>`;
    }
    // Local vector marks keep upstream identity crisp at drawer scale.
    function brandIcon(item, kind = "") {
      const key = `${kind} ${item.id || ""} ${item.name || ""} ${item.title || ""}`.toLowerCase();
      let mark, brand = "neutral";
      if (/chrome/.test(key)) { brand = "chrome"; mark = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#EA4335" d="M12 2a10 10 0 0 1 8.66 5H12a5 5 0 0 0-4.33 7.5L3.34 7A10 10 0 0 1 12 2Z"/><path fill="#FBBC05" d="M20.66 7a10 10 0 0 1-8.66 15l4.33-7.5A5 5 0 0 0 12 7Z"/><path fill="#34A853" d="M12 22A10 10 0 0 1 3.34 7l4.33 7.5a5 5 0 0 0 8.66 0Z"/><circle cx="12" cy="12" r="4.55" fill="#4285F4" stroke="#fff" stroke-width="1.2"/></svg>`; }
      else if (/codegraph/.test(key)) { brand = "graph"; mark = icon("graph", 25); }
      else if (/context7/.test(key)) { brand = "context"; mark = icon("bolt", 24); }
      else if (/playwright/.test(key)) { brand = "playwright"; mark = icon("masks", 25); }
      else if (/github/.test(key)) mark = icon("github", 25);
      else if (/cloudflare/.test(key)) { brand = "cloud"; mark = icon("cloud", 26); }
      else if (/lcu|computer.use/.test(key)) { brand = "display"; mark = icon("display", 25); }
      else if (/memory|vault|再记忆/.test(key)) { brand = "crystal"; mark = icon("crystal", 25); }
      else if (/reach|globe/.test(key)) { brand = "globe"; mark = icon("globe", 25); }
      else if (/product|library|产品/.test(key)) { brand = "bag"; mark = icon("bag", 25); }
      else if (/image|spark/.test(key)) { brand = "sparkle"; mark = icon("spark", 25); }
      else if (/terminal|ponytail/.test(key)) { brand = "terminal"; mark = icon("terminal", 25); }
      else mark = icon("hub", 23);
      const url = String(item.iconUrl || (typeof item.icon === "string" ? item.icon : item.icon?.url) || "");
      const image = /^(?:https?:\/\/|data:image\/(?:png|jpeg|webp|svg\+xml)[;,]|\/(?!\/))/.test(url) ? `<img src="${esc(url)}" alt="" referrerpolicy="no-referrer">` : "";
      return `<span class="hub-brand-icon hub-brand-${brand}">${mark}${image}${kind === "mcp" ? `<i class="hub-connection-dot ${item.connected === true ? "is-connected" : ""}" title="${esc(item.connected === true ? tr("已连接", "Connected") : item.connected === false ? tr("暂未连通", "Not connected") : tr("空闲 / 未检测", "Idle / untested"))}"></i>` : ""}</span>`;
    }
    function pluginItems() {
      const list = items(cache.plugins, ["items", "plugins"]);
      const core = list.find((item) => /(?:t3.*memory|memory.*vault)/i.test(`${item.id} ${item.name} ${item.title}`));
      const builtIn = core || { id: "t3-memory-vault", title: "T3 Memory Vault · 智能再记忆", description: tr("让每位搭档记住项目经验。记忆、向量检索与收尾整理，在本机协同工作。", "Project memory, vector recall, and consolidation in one local core plugin."), builtin: true, scope: "off", unavailable: true, components: { skills: 3, mcp: 1, hooks: 2, commands: 1 } };
      return [{ ...builtIn, title: "T3 Memory Vault · 智能再记忆", builtin: true }, ...list.filter((item) => item !== core)];
    }
    function capabilityPills(item) {
      const parts = item.components || item.capabilities || item;
      return [["skills", "⚡", tr("技能", "Skills")], ["mcp", "🔌", "MCP"], ["hooks", "🪝", "Hooks"], ["commands", "⌨️", tr("命令", "Commands")]].map(([key, glyph, label]) => {
        const value = parts[key] ?? parts[`${key}Count`] ?? parts[key === "mcp" ? "mcps" : key.slice(0, -1) + "Count"] ?? item[`${key}Count`];
        const count = Array.isArray(value) ? value.length : Number(value) || 0;
        return count ? `<span class="hub-capability">${glyph} ${key === "commands" ? "" : `${count} `}${esc(label)}</span>` : "";
      }).join("");
    }
    function renderPlugins() {
      content.innerHTML = `<div class="hub-section-heading"><span>${esc(tr("把能力装进工作流", "Capabilities, working together"))}</span><span class="hub-count">${cache.plugins ? pluginItems().length : ""}</span></div><p class="hub-description">${esc(tr("一个插件，连接技能、工具与自动化。", "Skills, tools, and automation in one bundle."))}</p><div class="hub-search">${icon("search", 14)}<input class="hub-input" name="pluginQuery" value="${esc(state.pluginQuery)}" placeholder="${esc(tr("搜索插件…", "Search plugins…"))}" aria-label="${esc(tr("搜索插件", "Search plugins"))}"></div>${button("install-plugin-form", tr("从 GitHub / 市场安装插件", "Install from GitHub / marketplace"), { icon: "plus", attrs: `aria-expanded="${state.pluginInstallOpen}"` })}<form class="hub-form-panel" data-form="plugin" ${state.pluginInstallOpen ? "" : "hidden"}><label class="hub-field">${esc(tr("仓库地址或市场标识", "Repository or marketplace ID"))}<input class="hub-input" name="pluginInput" value="${esc(state.pluginInput)}" placeholder="owner/repo" autocomplete="off"></label>${button("install-plugin", tr("安装到当前作用域", "Install for this scope"), { primary: true, icon: "plus" })}</form><div id="t3-hub-plugin-list"></div>`;
      renderPluginList();
    }
    function renderPluginList() {
      const node = root.querySelector("#t3-hub-plugin-list");
      if (!node) return;
      if (!cache.plugins) { node.innerHTML = errors.plugins ? inlineError(errors.plugins) : loading(); return; }
      const query = state.pluginQuery.trim().toLowerCase();
      const list = pluginItems().filter((item) => !query || `${item.title} ${item.name} ${item.description} ${item.id}`.toLowerCase().includes(query));
      node.innerHTML = `${cache.plugins.unavailable ? `<p class="hub-hint hub-domain-hint">${esc(tr("插件服务尚未接入。内置能力预览如下，安装与范围设置将在接入后可用。", "Plugin service is not connected yet. Core capabilities are shown as a preview."))}</p>` : ""}${list.map((item) => `<article class="hub-card hub-plugin-card ${item.builtin ? "is-core" : ""}"><div class="hub-card-top">${brandIcon(item)}<div class="hub-grow"><div class="hub-card-name">${esc(item.title || item.name || item.id)}</div><div class="hub-card-meta">${item.builtin ? `<span class="hub-badge hub-green">${esc(tr("官方内置", "Built-in"))}</span>` : `<span class="hub-badge">${esc(item.marketplace || sourceLabel(item.source))}</span>`}${item.version ? `<span class="hub-badge">v${esc(String(item.version).replace(/^v/, ""))}</span>` : ""}</div></div></div><p class="hub-card-description">${esc(item.description || tr("复合能力插件", "Composite capability bundle"))}</p><div class="hub-capabilities">${capabilityPills(item)}</div>${scopeControl("plugin", item, !!item.unavailable)}</article>`).join("") || empty(tr("没有匹配的插件", "No matching plugins"))}`;
    }
    const builtinHooks = [
      { id: "rememory-stop", title: "🧠 收尾再记忆守门员", event: "Stop / SubagentStop", description: "任务收尾时整理第一现场经验，保留经过验证的项目记忆。", builtin: true, scope: "off", unavailable: true },
      { id: "secret-guard", title: "🛡️ 敏感密钥提交守卫", event: "PreToolUse", description: "提交前检查敏感密钥，避免凭据进入版本历史。", builtin: true, scope: "off", unavailable: true },
      { id: "syntax-check", title: "✨ JS/CJS 语法快检", event: "PostToolUse", description: "修改 JavaScript 后执行语法检查，及时发现错误。", builtin: true, scope: "off", unavailable: true },
    ];
    function hookItems() {
      const list = items(cache.hooks, ["items", "hooks"]);
      if (cache.hooks?.unavailable) return builtinHooks;
      const templates = { "memory-stop-guard": builtinHooks[0], "secret-commit-guard": builtinHooks[1], "js-syntax-postcheck": builtinHooks[2] };
      return list.map((item) => ({ ...item, title: templates[item.id]?.title || item.title || item.id, description: item.description || templates[item.id]?.description || "", event: item.event || items(item, ["events"]).join(" / ") }));
    }
    function renderHooks() {
      const list = hookItems();
      const draft = state.hookDraft;
      const group = (title, entries) => entries.length ? `<div class="hub-section-heading hub-group-heading"><span>${esc(title)}</span><span class="hub-count">${entries.length}</span></div><div class="hub-hook-group">${entries.map((item) => `<article class="hub-card hub-hook-card"><div class="hub-card-top"><div class="hub-grow"><div class="hub-card-name">${esc(item.title || item.id)}</div><div class="hub-card-meta"><span class="hub-badge hub-purple">${esc(item.event)}</span>${item.readonly ? `<span class="hub-badge">${esc(tr("外部 · 只读", "External · read-only"))}</span>` : ""}</div></div>${!item.builtin && !item.readonly ? button("delete-hook", tr("删除", "Delete"), { small: true, danger: true, attrs: `data-id="${esc(item.id)}"` }) : ""}</div><p class="hub-card-description">${esc(item.description || item.matcher || "")}</p>${item.command ? `<code class="hub-hook-command">${esc(redact(item.command))}</code>` : ""}${scopeControl("hook", item, !!(item.readonly || item.unavailable))}<div class="hub-confirm-delete" data-hook-confirm="${esc(item.id)}" hidden>${esc(tr("删除这个自定义 Hook？", "Delete this custom hook?"))}<div class="hub-row">${button("confirm-delete-hook", tr("确认删除", "Delete"), { small: true, danger: true, attrs: `data-id="${esc(item.id)}"` })}${button("cancel-delete-hook", tr("取消", "Cancel"), { small: true })}</div></div></article>`).join("")}</div>` : "";
      const external = new Map();
      list.filter((item) => !item.builtin).forEach((item) => { const key = item.source || tr("自定义", "Custom"); if (!external.has(key)) external.set(key, []); external.get(key).push(item); });
      content.innerHTML = `<div class="hub-section-heading"><span>${esc(tr("让工作流自动收尾", "A little automation, at the right moment"))}</span></div><p class="hub-description">${esc(tr("在关键生命周期运行检查与记忆整理。", "Run checks and memory routines at lifecycle events."))}</p>${button("new-hook", tr("新建自定义 Hook", "New custom hook"), { icon: "plus", primary: true, attrs: `aria-expanded="${!!draft}"` })}${draft ? `<form class="hub-form-panel" data-form="hook"><label class="hub-field">${esc(tr("名称", "Name"))}<input class="hub-input" name="hook-title" value="${esc(draft.title)}" placeholder="My workflow hook"></label><div class="hub-form-grid"><label class="hub-field">${esc(tr("生命周期事件", "Event"))}<select class="hub-select" name="hook-event">${["Stop", "SubagentStop", "PreToolUse", "PostToolUse", "SessionStart", "UserPromptSubmit", "PreCompact", "SessionEnd"].map((event) => `<option ${event === draft.event ? "selected" : ""}>${event}</option>`).join("")}</select></label><label class="hub-field">${esc(tr("范围", "Scope"))}<select class="hub-select" name="hook-scope">${["off", "project", "global"].map((scope) => `<option value="${scope}" ${scope === draft.scope ? "selected" : ""} ${scope === "project" && projectDisabled() ? "disabled" : ""}>${esc(scope === "off" ? tr("关闭", "Off") : scope === "project" ? tr("本项目", "Project") : tr("全局", "Global"))}</option>`).join("")}</select></label></div><label class="hub-field">Matcher<input class="hub-input" name="hook-matcher" value="${esc(draft.matcher)}" placeholder="Bash|Edit|Write"></label><label class="hub-field">${esc(tr("执行命令", "Command"))}<textarea class="hub-input" name="hook-command" rows="3" spellcheck="false">${esc(draft.command)}</textarea></label><div class="hub-row">${button("save-hook", tr("保存 Hook", "Save hook"), { primary: true, icon: "save" })}${button("cancel-hook", tr("取消", "Cancel"))}</div></form>` : ""}${errors.hooks ? inlineError(errors.hooks) : !cache.hooks ? loading() : `${cache.hooks.unavailable ? `<p class="hub-hint hub-domain-hint">${esc(tr("Hooks 服务尚未接入，以下为内置模板预览。", "Hooks service is not connected. Built-in templates are previewed below."))}</p>` : ""}${group(tr("内置 Hooks", "Built-in hooks"), list.filter((item) => item.builtin))}${[...external].map(([name, entries]) => group(name, entries)).join("")}${!list.length ? empty(tr("还没有 Hook", "No hooks yet")) : ""}`}`;
    }

    function sourceLabel(source, fallback) {
      const key = String(source || "").toLowerCase();
      return ({ "codex-market": tr("Codex 市场", "Codex market"), marketplace: tr("Codex 市场", "Codex market"), github: "GitHub", zcode: "ZCode", claude: "Claude", global: tr("全局", "Global"), archive: tr("归档", "Archived"), archived: tr("归档", "Archived"), magpie: "Magpie", custom: tr("自定义", "Custom"), hub: tr("自定义", "Custom"), cli: "CLI" })[key] || fallback || source || tr("本地", "Local");
    }
    function renderTab() {
      if (!content || disposed) return;
      if (state.tab === "plugins") renderPlugins();
      if (state.tab === "hooks") renderHooks();
      if (state.tab === "skills") renderSkills();
      if (state.tab === "subagents") renderSubagents();
      if (state.tab === "mcp") renderMcp();
      if (state.tab === "memory") renderMemory();
      if (state.tab === "agents") renderAgents();
    }
    function renderSkills() {
      content.innerHTML = `<div class="hub-section-heading"><span>${esc(tr("为工作流添一份能力", "Make room for new abilities"))}</span><span class="hub-count" id="t3-hub-skills-count"></span></div><p class="hub-description">${esc(tr("独立 SKILL.md，按项目启用你需要的技能。", "Standalone SKILL.md skills, enabled where you need them."))}</p><form class="hub-card hub-import" data-form="import"><div class="hub-import-title">${icon("github", 14)}${esc(tr("从 GitHub 导入", "Import from GitHub"))}</div><div class="hub-import-grid"><input class="hub-input" name="repoInput" aria-label="${esc(tr("GitHub 仓库", "GitHub repository"))}" placeholder="owner/repo" value="${esc(state.importRepo)}" autocomplete="off" spellcheck="false"><select class="hub-select" name="importScope" aria-label="${esc(tr("导入范围", "Import scope"))}"><option value="project" ${state.importScope === "project" ? "selected" : ""} ${projectDisabled() ? "disabled" : ""}>${esc(tr("仅本项目", "Project"))}</option><option value="global" ${state.importScope === "global" ? "selected" : ""}>${esc(tr("全局", "Global"))}</option></select>${button("import-skill", tr("导入", "Import"), { icon: "plus", primary: true })}</div><div class="hub-hint">${esc(tr("支持 owner/repo 或 GitHub 链接，按范围启用。", "Paste owner/repo or a GitHub URL, then choose a scope."))}</div></form><div class="hub-search">${icon("search", 14)}<input class="hub-input" name="skillQuery" aria-label="${esc(tr("搜索独立技能", "Search standalone skills"))}" placeholder="${esc(tr("搜索技能…", "Search skills…"))}" value="${esc(state.skillQuery)}"></div><div class="hub-filters" id="t3-hub-skill-filters"></div><div id="t3-hub-skill-list"></div>`;
      renderSkillList();
    }
    function renderSkillList() {
      if (state.tab !== "skills" || disposed) return;
      const filters = [["all", tr("全部", "All")], ["enabled", tr("已启用", "Enabled")], ["project", tr("当前项目", "Project")], ["codex-market", tr("Codex市场", "Codex market")], ["github", "GitHub"]];
      root.querySelector("#t3-hub-skill-filters").innerHTML = filters.map(([key, label]) => `<button type="button" class="hub-pill ${state.skillFilter === key ? "is-active" : ""}" data-action="skill-filter" data-filter="${key}" aria-pressed="${state.skillFilter === key}">${esc(label)}</button>`).join("");
      const all = items(cache.skills, ["items", "skills", "plugins"]);
      const query = state.skillQuery.trim().toLowerCase();
      const filtered = all.filter((item) => {
        const filter = state.skillFilter;
        const matches = filter === "all" || (filter === "enabled" && item.scope !== "off" && !!item.scope) || (filter === "project" && item.scope === "project") || (filter === "codex-market" && /codex|market/.test(item.source || "")) || (filter === "github" && item.source === "github");
        return matches && (!query || `${item.name} ${item.description} ${item.id}`.toLowerCase().includes(query));
      });
      root.querySelector("#t3-hub-skills-count").textContent = tr(`${all.length} 项能力`, `${all.length} abilities`);
      root.querySelector("#t3-hub-skill-list").innerHTML = errors.skills ? inlineError(errors.skills) : !cache.skills ? loading() : !filtered.length ? empty(tr("没有找到匹配的能力", "No matching abilities"), tr("试试其他关键词，或从 GitHub 导入一个技能。", "Try another search, or import a skill from GitHub."), "skill") : filtered.map((item) => `<article class="hub-card"><div class="hub-card-top"><span class="hub-asset-icon ${item.scope && item.scope !== "off" ? "accent" : ""}">${icon(item.source === "github" ? "github" : "skill", 16)}</span><div class="hub-grow"><div class="hub-card-name">${esc(item.name || item.id)}</div><div class="hub-card-meta"><span class="hub-badge ${/codex|market/.test(item.source || "") ? "hub-purple" : ""}">${esc(sourceLabel(item.source, item.sourceLabel))}</span>${item.scope && item.scope !== "off" ? `<span class="hub-live"><i class="hub-dot"></i>${esc(tr("已启用", "Enabled"))}</span>` : ""}</div></div>${item.updatable ? `<button type="button" class="hub-icon-btn" data-action="update-skill" data-id="${esc(item.id)}" title="${esc(tr("检查并更新", "Check for updates"))}" aria-label="${esc(tr("更新", "Update"))} ${esc(item.name || item.id)}">${icon("refresh", 14)}</button>` : ""}</div><p class="hub-card-description">${esc(item.description || tr("暂无描述", "No description available"))}</p><div class="hub-segments" role="group" aria-label="${esc(tr("启用范围", "Activation scope"))}">${[["off", tr("关闭", "Off")], ["project", tr("仅本项目", "This project")], ["global", tr("全局", "Global")]].map(([scope, label]) => `<button type="button" class="${item.scope === scope || (!item.scope && scope === "off") ? "is-active" : ""}" data-action="skill-scope" data-id="${esc(item.id)}" data-scope="${scope}" aria-pressed="${item.scope === scope}" ${scope === "project" && projectDisabled() ? `disabled title="${esc(projectTitle())}"` : ""}>${esc(label)}</button>`).join("")}</div>${item.updatable ? `<div class="hub-editor-actions">${button("remove-skill", tr("移除技能包", "Remove package"), { small: true, danger: true, attrs: `data-id="${esc(item.id)}"` })}</div><div data-skill-confirm class="hub-confirm-delete" hidden>${esc(tr("移除整个来源技能包及其启用链接？", "Remove this source package and its activation links?"))}<div class="hub-row">${button("confirm-remove-skill", tr("确认移除", "Remove package"), { small: true, danger: true, attrs: `data-id="${esc(item.id)}"` })}${button("cancel-remove-skill", tr("取消", "Cancel"), { small: true })}</div></div>` : ""}</article>`).join("");
    }

    const mcpModes = () => [["off", tr("关闭", "Off")], ["project-lazy", tr("本项目·懒加载 (省Token)", "Project · Lazy (saves tokens)")], ["project-direct", tr("本项目·直连", "Project · Direct")], ["global-lazy", tr("全局·懒加载", "Global · Lazy")], ["global-direct", tr("全局·直连", "Global · Direct")]];
    const providerDefaults = [
      { id: "muse", label: "Muse" }, { id: "codex", label: "Codex" }, { id: "pi", label: "Pi·Magpie" },
      { id: "antigravity", label: "Antigravity" }, { id: "claudeAgent", label: "Claude" },
    ];
    const effortNames = { max: "最高", xhigh: "超高", high: "高", medium: "中", low: "低", minimal: "极简" };
    const subagentRoles = { research: ["search", "var(--hud-emerald)", "只读调查"], implementation: ["bolt", "var(--hud-blue)", "全部工具"], general: ["hub", "var(--hud-blue)", "全部工具"], design: ["spark", "var(--hud-violet)", "界面+截图"], test: ["check", "var(--hud-amber)", "LCU+测试"], review: ["edit", "#c779b7", "只读审查"] };
    const builtinSubagents = new Set(["explorer", "worker", "worker-pro", "frontend", "qa", "code-review", "general-purpose"]);
    function subagentId(item) { return String(item?.id || item?.name || ""); }
    function subagentKey(id, scope = state.subagentScope, projectRoot = state.projectRoot) { return `${scope}:${scope === "project" ? projectRoot || "" : ""}\u0000${id}`; }
    function subagentItems(scope = state.subagentScope) { return items(cache.subagents, [scope === "global" ? "globalItems" : "projectItems"]); }
    function subagentProviders() {
      const raw = cache.subagents?.catalog;
      const catalog = Array.isArray(raw?.providers) ? raw.providers : Object.entries(raw || {}).filter(([, value]) => value && typeof value === "object" && !Array.isArray(value)).map(([id, value]) => ({ id, ...value }));
      const merged = providerDefaults.map((provider) => ({ ...provider, ...catalog.find((entry) => entry.id === provider.id) }));
      return [...merged, ...catalog.filter((entry) => !merged.some((provider) => provider.id === entry.id))];
    }
    function providerModels(providerId) {
      const provider = subagentProviders().find((entry) => entry.id === providerId);
      return items(provider, ["models"]).map((model) => typeof model === "string" ? { id: model, label: model } : model).filter((model) => model?.id);
    }
    function providerEfforts(providerId, current = "") {
      const provider = subagentProviders().find((entry) => entry.id === providerId);
      const available = items(provider, ["efforts"]).map((effort) => typeof effort === "string" ? effort : effort?.id || effort?.value).filter(Boolean);
      const values = available.length ? available : Object.keys(effortNames);
      const order = Object.keys(effortNames);
      return [...new Set([...values, ...(current ? [current] : [])])].sort((a, b) => (order.includes(a) ? order.indexOf(a) : order.length) - (order.includes(b) ? order.indexOf(b) : order.length));
    }
    function subagentDraft(id, scope = state.subagentScope) {
      const key = subagentKey(id, scope);
      if (!state.subagentDrafts[key]) {
        const item = subagentItems(scope).find((entry) => subagentId(entry) === id);
        if (!item) return null;
        state.subagentDrafts[key] = { ...item };
      }
      return state.subagentDrafts[key];
    }
    function canDeleteSubagent(item) {
      return state.subagentScope === "project" || !(item.builtin ?? item.builtIn ?? item.isBuiltin ?? builtinSubagents.has(subagentId(item)));
    }
    function memoryPolicy(item) {
      if (["readwrite", "readonly", "off"].includes(item.memoryPolicy)) return item.memoryPolicy;
      return ["explorer", "code-review"].includes(subagentId(item)) || ["research", "review"].includes(item.role) ? "readonly" : "readwrite";
    }
    function memoryPolicyControl(item, id, disabled = false) {
      const policy = memoryPolicy(item);
      return `<select class="hub-select hub-memory-policy policy-${policy}" name="subagent-memoryPolicy" data-subagent-id="${esc(id)}" aria-label="${esc(tr("记忆权限", "Memory policy"))} · ${esc(id)}" ${disabled ? "disabled" : ""}>${[["readwrite", tr("🧠 第一现场读写记忆", "🧠 First-hand memory · read & write")], ["readonly", tr("👁️ 只读项目记忆", "👁️ Project memory · read only")], ["off", tr("🚫 不挂载记忆", "🚫 No memory")]].map(([value, label]) => `<option value="${value}" ${value === policy ? "selected" : ""}>${esc(label)}</option>`).join("")}</select>`;
    }
    function renderBotAvatar(item) {
      const id = subagentId(item);
      const colors = { worker: "#3B82F6", "general-purpose": "#3B82F6", default: "#3B82F6", explorer: "#55B399", "worker-pro": "#6366F1", frontend: "#EC4899", qa: "#F59E0B", "code-review": "#0EA5E9" };
      const roles = { research: "#55B399", implementation: "#3B82F6", design: "#EC4899", test: "#F59E0B", review: "#0EA5E9" };
      const color = /^#[0-9a-f]{6}$/i.test(item.avatarColor || "") ? item.avatarColor : colors[id] || roles[item.role] || "#3B82F6";
      const stagger = [...id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 40 / 10;
      return `<span class="hub-bot-avatar" aria-hidden="true" style="--bot-color:${color};--bot-delay:-${stagger}s"><span class="hub-bot-head"><span class="hub-bot-look"><span class="hub-bot-eyes"><i></i><i></i></span></span></span></span>`;
    }
    function greetBots(id = null) {
      if (!content || state.tab !== "subagents") return;
      content.querySelectorAll("[data-subagent-card]").forEach((card) => {
        if (id && card.dataset.subagentCard !== id) return;
        card.classList.remove("is-playful");
        void card.offsetWidth;
        card.classList.add("is-playful");
        later(() => card.classList.remove("is-playful"), 850);
      });
    }
    function subagentControls(item, cardId, disabled = false) {
      const providerId = item.providerInstanceId || "codex";
      const providers = subagentProviders();
      if (!providers.some((entry) => entry.id === providerId)) providers.push({ id: providerId, label: providerId });
      const models = providerModels(providerId);
      if (item.model && !models.some((entry) => entry.id === item.model)) models.unshift({ id: item.model, label: item.model });
      const effort = item.effort || "max";
      const attrs = `data-subagent-id="${esc(cardId)}" ${disabled ? "disabled" : ""}`;
      return `<div class="hub-subagent-controls"><select class="hub-select" name="subagent-provider" aria-label="${esc(tr("执行 Agent", "Execution agent"))} · ${esc(cardId)}" ${attrs}>${providers.map((provider) => `<option value="${esc(provider.id)}" ${provider.id === providerId ? "selected" : ""}>${esc(provider.label || provider.id)}</option>`).join("")}</select><select class="hub-select" name="subagent-model" aria-label="${esc(tr("模型", "Model"))} · ${esc(cardId)}" title="${esc(item.model || "")}" ${attrs}>${!item.model ? `<option value="" selected disabled>${esc(tr("选择模型", "Choose model"))}</option>` : ""}${models.map((model) => `<option value="${esc(model.id)}" ${model.id === item.model ? "selected" : ""}>${esc(model.label || model.id)}</option>`).join("")}<option value="__custom__">${esc(tr("自定义模型…", "Custom model…"))}</option></select><select class="hub-select" name="subagent-effort" title="🧠 ${esc(tr(effortNames[effort] || effort, effort))} (${esc(effort)})" aria-label="${esc(tr("思考程度", "Reasoning effort"))} · ${esc(cardId)}" ${attrs}>${providerEfforts(providerId, effort).map((value) => `<option value="${esc(value)}" ${value === effort ? "selected" : ""} label="🧠 ${esc(tr(effortNames[value] || value, value))}">🧠 ${esc(tr(effortNames[value] || value, value))} (${esc(value)})</option>`).join("")}</select></div>`;
    }
    function renderSubagentEditor(item, cardId, isNew = false) {
      const key = subagentKey(cardId);
      const saving = subagentSaves.has(key);
      const field = (name, label, value, extra = "") => `<label class="hub-field"><span>${esc(label)}</span><input class="hub-input" name="subagent-${name}" data-subagent-id="${esc(cardId)}" value="${esc(value)}" ${extra}></label>`;
      return `<div class="hub-subagent-editor" data-subagent-editor="${esc(cardId)}"><div class="hub-subagent-fields">${field("id", tr("名称 (id)", "Name (id)"), subagentId(item), `${isNew ? 'placeholder="my-worker" autocomplete="off"' : 'readonly aria-readonly="true"'}`)}<label class="hub-field"><span>${esc(tr("角色类型", "Role"))}</span><select class="hub-select" name="subagent-role" data-subagent-id="${esc(cardId)}">${Object.keys(subagentRoles).map((role) => `<option ${role === (item.role || "implementation") ? "selected" : ""}>${role}</option>`).join("")}</select></label>${field("toolBadge", tr("工具标签", "Tool badge"), item.toolBadge || "")}${field("description", tr("简介", "Description"), item.description || "")}</div><label class="hub-field"><span>${esc(tr("第一现场记忆权限 · 即时保存", "First-hand memory policy · saves instantly"))}</span>${memoryPolicyControl(item, cardId, saving)}</label><label class="hub-field"><span>${esc(tr("系统提示词", "System prompt"))}</span><textarea class="hub-input hub-editor" name="subagent-systemPrompt" data-subagent-id="${esc(cardId)}" spellcheck="false" placeholder="${esc(tr("说明任务边界、工具使用与交付要求…", "Define responsibilities, tools, and delivery requirements…"))}">${esc(item.systemPrompt || "")}</textarea></label><div class="hub-editor-actions"><label class="hub-checkbox"><input type="checkbox" name="subagent-enabled" data-subagent-id="${esc(cardId)}" ${item.enabled !== false ? "checked" : ""}>${esc(tr("启用", "Enabled"))}</label>${button("save-subagent", tr("保存并注入 AGENTS.md", "Save & inject AGENTS.md"), { primary: true, small: true, icon: "save", disabled: saving, attrs: `data-id="${esc(cardId)}"` })}${!isNew && state.subagentScope === "global" && state.projectRoot ? button("clone-subagent", tr("复制到当前项目定制", "Customize for this project"), { small: true, icon: "folder", attrs: `data-id="${esc(cardId)}"` }) : ""}${isNew ? button("cancel-new-subagent", tr("取消", "Cancel"), { small: true }) : canDeleteSubagent(item) ? button("delete-subagent", tr("删除", "Delete"), { small: true, danger: true, attrs: `data-id="${esc(cardId)}"` }) : ""}</div>${!isNew && canDeleteSubagent(item) ? `<div class="hub-confirm-delete" data-subagent-delete-confirm hidden>${esc(tr("删除这项配置？项目配置删除后将恢复使用全局模板。", "Delete this configuration? Project overrides fall back to the global template."))}<div class="hub-row">${button("confirm-delete-subagent", tr("确认删除", "Delete configuration"), { small: true, danger: true, attrs: `data-id="${esc(cardId)}"` })}${button("cancel-delete-subagent", tr("取消", "Cancel"), { small: true })}</div></div>` : ""}</div>`;
    }
    function renderSubagents() {
      const scope = state.subagentScope;
      const list = subagentItems();
      const newDraft = state.subagentDrafts[subagentKey("__new__")];
      const label = scope === "global" ? tr("内置子智能体", "Built-in sub-agents") : tr("本项目专属子智能体", "Project agents");
      const count = cache.subagents ? `${list.length} ${tr("项", "items")}` : "";
      const cards = list.map((item) => {
        const id = subagentId(item), key = subagentKey(id), expanded = !!state.subagentExpanded[key];
        const role = subagentRoles[item.role] || subagentRoles.general;
        const saved = item.injected === true || item.agentsMdInjected === true || item.injectedAt;
        const status = scope === "project" ? tr("仅本项目", "This project") : saved ? tr("已注入 AGENTS.md", "Injected into AGENTS.md") : tr("全局模板", "Global template");
        const busy = subagentSaves.has(key);
        const custom = state.subagentCustom[key];
        const draft = expanded ? subagentDraft(id) : null;
        return `<article class="hub-subagent-card" data-subagent-card="${esc(id)}"><div class="hub-subagent-main">${renderBotAvatar(item)}<button type="button" class="hub-subagent-summary" data-action="expand-subagent" data-id="${esc(id)}" aria-expanded="${expanded}" aria-controls="t3-subagent-editor-${esc(id)}"><span class="hub-subagent-name">${esc(item.name || id)}<span class="hub-tool-badge">${esc(item.toolBadge || role[2])}</span></span><span class="hub-subagent-desc">${esc(item.description || tr("为这位子智能体添加职责与交付说明。", "Add responsibilities and delivery guidelines."))}</span></button>${subagentControls(item, id, busy)}</div><div class="hub-subagent-meta"><span class="hub-badge ${scope === "project" ? "hub-cyan" : saved ? "hub-green" : ""}">${busy ? spinner() : icon(saved ? "check" : scope === "project" ? "folder" : "globe", 10)}${esc(busy ? tr("保存并注入中…", "Saving & injecting…") : status)}${item.enabled === false ? ` · ${esc(tr("已停用", "Disabled"))}` : ""}</span>${memoryPolicyControl(item, id, busy)}<button type="button" class="hub-subagent-edit" data-action="expand-subagent" data-id="${esc(id)}" aria-expanded="${expanded}">${icon("edit", 11)}${esc(expanded ? tr("收起设置", "Close settings") : tr("编辑提示词 / 设置", "Prompt / settings"))}</button></div>${custom ? `<div class="hub-subagent-custom"><label class="hub-field"><span>${esc(tr("自定义模型 ID", "Custom model ID"))}</span><div class="hub-row"><input class="hub-input" name="subagent-customModel" data-subagent-id="${esc(id)}" value="${esc(custom.value || "")}" placeholder="group/1m-auto" autocomplete="off" spellcheck="false">${button("save-subagent-model", tr("保存", "Save"), { small: true, primary: true, attrs: `data-id="${esc(id)}"` })}${button("cancel-subagent-model", tr("取消", "Cancel"), { small: true, attrs: `data-id="${esc(id)}"` })}</div></label></div>` : ""}<div id="t3-subagent-editor-${esc(id)}" class="hub-subagent-expand ${expanded ? "is-expanded" : ""}" ${expanded ? "" : "inert"}><div>${draft ? renderSubagentEditor(draft, id) : ""}</div></div></article>`;
      }).join("");
      content.innerHTML = `<div class="hub-subagent-scopes" aria-label="${esc(tr("子智能体作用域", "Agent scope"))}"><button type="button" class="hub-subagent-scope" data-action="subagent-scope" data-scope="global" aria-pressed="${scope === "global"}">🌐 ${esc(tr("全局子智能体", "Global agents"))}<small>${esc(tr("全项目通用", "Across all projects"))}</small></button><button type="button" class="hub-subagent-scope" data-action="subagent-scope" data-scope="project" aria-pressed="${scope === "project"}" ${projectDisabled() ? "disabled" : ""} title="${esc(projectTitle())}">📁 ${esc(tr("项目子智能体", "Project agents"))}<small>${esc(tr("仅当前项目", "This project only"))}</small></button></div><div class="hub-subagent-heading"><h3>${esc(label)}<span>${esc(count)}</span></h3>${button("new-subagent", tr("新建子智能体", "New agent"), { small: true, primary: true, icon: "plus", disabled: scope === "project" && projectDisabled() })}</div><p class="hub-description">${esc(scope === "global" ? tr("为常用任务配好搭档。切换 Agent、模型或思考程度，即时保存。", "Choose your team. Agent, model, and effort changes save instantly.") : tr("为当前项目定制模型与提示词，同名配置优先于全局模板。", "Customize models and prompts here. Matching IDs override global templates."))}</p>${newDraft ? `<article class="hub-card">${subagentControls(newDraft, "__new__")}${state.subagentCustom[subagentKey("__new__")] ? `<div class="hub-subagent-custom"><label class="hub-field"><span>${esc(tr("自定义模型 ID", "Custom model ID"))}</span><div class="hub-row"><input class="hub-input" name="subagent-customModel" data-subagent-id="__new__" value="${esc(state.subagentCustom[subagentKey("__new__")].value || "")}" placeholder="group/1m-auto" spellcheck="false">${button("save-subagent-model", tr("使用模型", "Use model"), { small: true, primary: true, attrs: 'data-id="__new__"' })}${button("cancel-subagent-model", tr("取消", "Cancel"), { small: true, attrs: 'data-id="__new__"' })}</div></label></div>` : ""}${renderSubagentEditor(newDraft, "__new__", true)}</article>` : ""}${errors.subagents ? inlineError(errors.subagents) : !cache.subagents ? loading() : scope === "project" && projectDisabled() ? empty(tr("请先打开一个项目", "Open a project first"), "", "folder") : cards ? `<div class="hub-subagent-list">${cards}</div>` : `${empty(scope === "project" ? tr("这个项目，还没有专属搭档", "No project agents yet") : tr("还没有全局子智能体", "No global agents yet"), scope === "project" ? tr("当前仍使用全局子智能体。克隆一个模板，即可单独定制。", "Global agents remain available. Clone a template to customize it here.") : tr("新建子智能体，为常用任务配置专属助手。", "Create an agent for your recurring tasks."), "hub")}${scope === "project" ? `<div class="hub-subagent-clones"><strong>${esc(tr("从全局模板克隆定制…", "Customize a global template…"))}</strong><div class="hub-row">${subagentItems("global").filter((item) => ["worker", "explorer", "frontend"].includes(subagentId(item))).map((item) => button("clone-subagent", item.name || subagentId(item), { small: true, icon: "plus", attrs: `data-id="${esc(subagentId(item))}"` })).join("") || `<span class="hub-description">${esc(tr("先创建一个全局模板，或直接新建项目子智能体。", "Create a global template or a new project agent."))}</span>`}</div></div>` : ""}` }<div class="hub-subagent-note">${icon("check", 13)}<span>${esc(scope === "global" ? tr("保存后自动注入全局 AGENTS.md，并同步 5 个 CLI。", "Saving injects global AGENTS.md and synchronizes five CLIs.") : tr("保存后自动写入本项目 AGENTS.md，其他项目保持各自配置。", "Saving injects this project's AGENTS.md. Other projects keep their own settings."))}</span></div>`;
      greetBots();
    }
    function newSubagent() {
      const provider = subagentProviders().find((entry) => entry.id === "codex") || subagentProviders()[0];
      const key = subagentKey("__new__");
      const efforts = providerEfforts(provider.id);
      state.subagentDrafts[key] ||= { id: "", name: "", role: "implementation", toolBadge: "全部工具", description: "", systemPrompt: "", enabled: true, memoryPolicy: "readwrite", providerInstanceId: provider.id, model: providerModels(provider.id)[0]?.id || "", effort: efforts.includes("max") ? "max" : efforts.includes("high") ? "high" : efforts[0] };
      renderSubagents();
      content.querySelector('[name="subagent-id"]')?.focus();
    }
    async function persistSubagent(id, patch = null) {
      const scope = state.subagentScope, projectRoot = state.projectRoot, key = subagentKey(id);
      if (scope === "project" && !projectRoot) return;
      if (subagentSaves.has(key)) return;
      const original = subagentItems().find((item) => subagentId(item) === id);
      const item = { ...(patch ? original || state.subagentDrafts[key] : state.subagentDrafts[key] || original), ...(patch || {}) };
      item.id = String(item.id || item.name || "").trim();
      item.name = item.name || item.id;
      item.scope = scope;
      item.memoryPolicy = memoryPolicy(item);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(item.id)) { toast(tr("名称请使用 1–80 位字母、数字、横线或下划线", "Use a 1–80 character ID with letters, numbers, dashes, or underscores"), true); return; }
      if (!item.model?.trim()) { toast(tr("请先选择或填写模型 ID", "Choose or enter a model ID first"), true); return; }
      if (id === "__new__" && subagentItems().some((entry) => subagentId(entry) === item.id)) { toast(tr("这个名称已经存在，请使用其他名称", "This ID already exists"), true); return; }
      if (scope === "project") { item.projectRoot = projectRoot; item.overridesGlobal = subagentItems("global").some((entry) => subagentId(entry) === item.id); }
      const snapshot = JSON.stringify(state.subagentDrafts[key] || null);
      subagentSaves.set(key, true);
      renderSubagents();
      try {
        const result = await request("subagents:save", { scope, projectRoot, item });
        if (disposed) return;
        cache.agents = null;
        const saved = { ...item, ...(result.item || {}), injected: true };
        // A late save must never replace another project's list or a newly typed prompt.
        if (projectRoot === state.projectRoot) {
          const listKey = scope === "global" ? "globalItems" : "projectItems";
          if (cache.subagents) {
            const list = subagentItems(scope), index = list.findIndex((entry) => subagentId(entry) === saved.id);
            cache.subagents[listKey] = index < 0 ? [...list, saved] : list.map((entry, i) => i === index ? saved : entry);
          }
          if (patch && state.subagentDrafts[key]) Object.assign(state.subagentDrafts[key], patch);
          else if (JSON.stringify(state.subagentDrafts[key] || null) === snapshot) {
            if (id === "__new__") { delete state.subagentDrafts[key]; state.subagentExpanded[subagentKey(saved.id, scope)] = true; }
            state.subagentDrafts[subagentKey(saved.id, scope)] = { ...saved };
          }
          delete state.subagentCustom[key];
        }
        toast(tr(`已保存并自动注入${scope === "global" ? "全局" : "项目"} AGENTS.md`, `Saved and injected into ${scope} AGENTS.md`));
      } catch (error) { if (!disposed) toast(errorText(error), true); }
      finally { subagentSaves.delete(key); if (!disposed && state.tab === "subagents" && projectRoot === state.projectRoot && scope === state.subagentScope) { renderSubagents(); renderChrome(); } }
    }
    async function cloneSubagent(id, element) {
      const item = subagentItems("global").find((entry) => subagentId(entry) === id);
      const projectRoot = state.projectRoot;
      if (!item || !projectRoot) return;
      const existing = subagentItems("project").find((entry) => subagentId(entry) === id);
      if (existing) { state.subagentScope = "project"; state.subagentExpanded[subagentKey(id)] = true; renderSubagents(); renderChrome(); toast(tr("已打开现有项目配置", "Opened the existing project override")); return; }
      await busy(`clone:${projectRoot}:${id}`, element, async () => {
        const result = await request("subagents:save", { scope: "project", projectRoot, item: { ...item, memoryPolicy: memoryPolicy(item), id, scope: "project", projectRoot, builtin: false, builtIn: false, isBuiltin: false, overridesGlobal: true } });
        cache.agents = null;
        if (disposed || projectRoot !== state.projectRoot) return;
        if (cache.subagents) cache.subagents.projectItems = [...subagentItems("project"), { ...item, ...(result.item || {}), id, scope: "project", projectRoot, builtin: false, overridesGlobal: true, injected: true }];
        state.subagentScope = "project";
        state.subagentExpanded[subagentKey(id)] = true;
        renderSubagents(); renderChrome();
        toast(tr("已克隆并自动注入项目 AGENTS.md，可直接定制", "Cloned and injected into project AGENTS.md"));
      });
    }
    async function deleteSubagent(id, element) {
      const scope = state.subagentScope, projectRoot = state.projectRoot, key = subagentKey(id);
      const item = subagentItems().find((entry) => subagentId(entry) === id);
      if (!item || !canDeleteSubagent(item) || subagentSaves.has(key)) return;
      await busy(`delete-subagent:${key}`, element, async () => {
        await request("subagents:delete", { scope, projectRoot, id });
        cache.agents = null;
        if (disposed || projectRoot !== state.projectRoot) return;
        if (cache.subagents) cache.subagents[scope === "global" ? "globalItems" : "projectItems"] = subagentItems(scope).filter((entry) => subagentId(entry) !== id);
        delete state.subagentDrafts[key]; delete state.subagentExpanded[key]; delete state.subagentCustom[key];
        if (state.tab === "subagents") { renderSubagents(); renderChrome(); }
        toast(tr("已删除配置并更新 AGENTS.md", "Configuration deleted and AGENTS.md updated"));
      });
    }

    function mcpServers() {
      const data = cache.mcp || {};
      const byName = new Map();
      const add = (entry, groupTitle = "") => {
        if (entry?.items || entry?.servers) { items(entry, ["items", "servers"]).forEach((server) => add(server, entry.groupTitle || entry.title || entry.name || groupTitle)); return; }
        if (!entry?.name && !entry?.id) return;
        const name = String(entry.name || entry.id), previous = byName.get(name) || {};
        byName.set(name, { ...entry, ...previous, groupTitle: previous.groupTitle || entry.groupTitle || groupTitle, name });
      };
      items(data, ["items", "servers"]).forEach((entry) => add(entry));
      for (const key of ["upstream", "upstreamCatalog", "catalog", "groups"]) items(data, [key]).forEach((entry) => add(entry));
      return [...byName.values()];
    }
    function mcpMode(server) { return server.mode || (server.enabled ? `${defaultScope()}-lazy` : "off"); }
    function renderMcp() {
      content.innerHTML = `<div class="hub-section-heading"><span>${esc(tr("工具互联，按需唤醒", "Tools, connected on demand"))}</span><span class="hub-count">${cache.mcp ? mcpServers().length : ""} ${esc(tr("个服务", "servers"))}</span></div><p class="hub-description">${esc(tr("直达内置与插件上游，按需启用。", "Enable tools straight from your upstream catalog."))}</p><div class="hub-search">${icon("search", 14)}<input class="hub-input" name="mcpQuery" value="${esc(state.mcpQuery)}" aria-label="${esc(tr("搜索 MCP 服务器", "Search MCP servers"))}" placeholder="${esc(tr("搜索 MCP 服务器…", "Search MCP servers…"))}"></div><div class="hub-mcp-actions">${button("sync-mcp", tr("同步路由至全部 CLI", "Sync all CLIs"), { icon: "refresh", small: true })}${button("probe-mcp", tr("检测连通性", "Probe connections"), { small: true, icon: "bolt" })}${button("toggle-mcp-add", tr("新建 MCP", "New MCP"), { icon: "plus", small: true, primary: true, attrs: `aria-expanded="${state.mcpAddOpen}"` })}</div><div id="t3-hub-mcp-form" class="hub-form-panel" ${state.mcpAddOpen ? "" : "hidden"}></div><div id="t3-hub-mcp-list"></div>`;
      renderMcpForm(); renderMcpList();
    }
    function renderMcpForm() {
      const node = root.querySelector("#t3-hub-mcp-form");
      if (!node) return;
      const form = state.mcpForm;
      node.hidden = !state.mcpAddOpen;
      node.innerHTML = `<div class="hub-segments" role="group" aria-label="${esc(tr("新增方式", "Configuration method"))}">${[["form", tr("命令 / URL", "Command / URL")], ["json", tr("粘贴 JSON", "Paste JSON")]].map(([kind, label]) => `<button type="button" data-action="mcp-form-kind" data-kind="${kind}" class="${form.kind === kind ? "is-active" : ""}" aria-pressed="${form.kind === kind}">${esc(label)}</button>`).join("")}</div>${form.kind === "json" ? `<label class="hub-field">mcpServers JSON<textarea class="hub-editor" name="mcp-json" spellcheck="false" placeholder='{"mcpServers":{"my-server":{"command":"npx","args":["-y","package"]}}}'>${esc(form.json)}</textarea></label>` : `<div class="hub-form-grid"><label class="hub-field">${esc(tr("服务名称", "Server name"))}<input class="hub-input" name="mcp-name" value="${esc(form.name)}" placeholder="my-server" autocomplete="off"></label><label class="hub-field">${esc(tr("传输", "Transport"))}<select class="hub-select" name="mcp-transport"><option value="stdio" ${form.transport === "stdio" ? "selected" : ""}>stdio</option><option value="http" ${form.transport === "http" ? "selected" : ""}>http</option></select></label></div>${form.transport === "http" ? `<label class="hub-field">URL<input class="hub-input" name="mcp-url" value="${esc(form.url)}" placeholder="https://example.com/mcp" spellcheck="false"></label>` : `<label class="hub-field">${esc(tr("启动命令", "Command"))}<input class="hub-input" name="mcp-command" value="${esc(form.command)}" placeholder="npx" spellcheck="false"></label><label class="hub-field">${esc(tr("参数（JSON 数组或每行一个）", "Arguments (JSON array or one per line)"))}<textarea class="hub-input" name="mcp-args" rows="2" placeholder='["-y", "@example/mcp"]' spellcheck="false">${esc(form.args)}</textarea></label>`}`}${button("save-mcp", tr("添加服务", "Add server"), { primary: true, icon: "plus" })}`;
    }
    function renderMcpList() {
      const node = root.querySelector("#t3-hub-mcp-list");
      if (state.tab !== "mcp" || disposed || !node) return;
      if (errors.mcp || !cache.mcp) { node.innerHTML = errors.mcp ? inlineError(errors.mcp) : loading(); return; }
      const query = state.mcpQuery.trim().toLowerCase();
      const servers = mcpServers().filter((server) => !query || `${server.name} ${server.groupTitle} ${server.description || ""}`.toLowerCase().includes(query));
      const active = servers.filter((server) => mcpMode(server) !== "off");
      const row = (server, upstream = false) => {
        const mode = mcpMode(server), enabled = mode !== "off";
        const summary = redact(server.summary || server.url || [server.command, ...items(server, ["args"])].filter(Boolean).join(" "));
        const status = server.connected === true ? tr("该 MCP 服务器已连接并可用。", "This MCP server is connected and available.") : server.statusText || (server.connected === false ? tr("暂未连接，点击检测连通性。", "Not connected. Probe to check availability.") : tr("按需唤醒 · 点击检测连通性验证", "Wake on demand · Probe to verify connectivity"));
        const removable = server.removable === true || !server.builtin && !server.readonly && ["custom", "hub"].includes(server.source);
        return `<article class="hub-mcp-row" data-mcp-name="${esc(server.name)}">${brandIcon(server, "mcp")}<div class="hub-grow"><div class="hub-mcp-name" title="${esc(server.name)}">${esc(server.displayName || server.title || server.name)}</div>${upstream ? `<div class="hub-upstream-status ${server.connected === true ? "is-available" : ""}"><i class="hub-dot"></i><span>${esc(status)}</span></div>` : `<div class="hub-mcp-detail" title="${esc(summary)}">${esc(server.transport || (server.url ? "http" : "stdio"))} · ${esc(summary || tr("连接详情已隐藏", "Connection details hidden"))}</div>`}<div class="hub-mcp-row-options"><select class="hub-select hub-mode-pill" name="mcp-mode" data-name="${esc(server.name)}" aria-label="${esc(server.name)} ${esc(tr("连接模式", "connection mode"))}"><option value="off" ${!enabled ? "selected" : ""}>${esc(tr("关闭", "Off"))}</option>${mcpModes().filter(([value]) => value !== "off").map(([value]) => `<option value="${value}" ${mode === value ? "selected" : ""} ${value.startsWith("project-") && projectDisabled() ? "disabled" : ""}>${esc(`${value.startsWith("project-") ? tr("项目", "Project") : tr("全局", "Global")} · ${value.endsWith("lazy") ? tr("懒加载", "Lazy") : tr("直连", "Direct")}`)}</option>`).join("")}</select>${state.freshModes[server.name] ? `<span class="hub-live">${icon("check", 10)}${esc(tr("已生效", "Applied"))}</span>` : ""}${removable ? `<button type="button" class="hub-icon-btn hub-mcp-remove" data-action="remove-mcp" data-name="${esc(server.name)}" aria-label="${esc(tr("移除", "Remove"))} ${esc(server.name)}">${icon("trash", 12)}</button>` : ""}</div><div class="hub-confirm-delete" data-mcp-confirm hidden>${esc(tr("移除此自定义 MCP？", "Remove this custom MCP?"))}<div class="hub-row">${button("confirm-remove-mcp", tr("移除", "Remove"), { small: true, danger: true, attrs: `data-name="${esc(server.name)}"` })}${button("cancel-remove-mcp", tr("取消", "Cancel"), { small: true })}</div></div></div><button type="button" role="switch" aria-checked="${enabled}" class="hub-switch" data-action="toggle-mcp" data-name="${esc(server.name)}" data-mode="${esc(mode)}" aria-label="${esc(server.name)} ${esc(tr("启用", "enabled"))}"><span></span></button></article>`;
      };
      const groups = new Map();
      servers.forEach((server) => { const name = server.groupTitle || server.pluginName || server.plugin?.name || mcpGroupTitle(server.name); if (!groups.has(name)) groups.set(name, []); groups.get(name).push(server); });
      node.innerHTML = `<div class="hub-section-heading hub-group-heading"><span>${esc(tr("已启用", "Enabled"))} <span class="hub-count">${active.length}</span></span><span class="hub-hint">${esc(tr("按需加载 · 轻量连接", "On demand · Lightweight"))}</span></div>${active.length ? `<div class="hub-mcp-group">${active.map((server) => row(server)).join("")}</div>` : `<div class="hub-quiet-empty">${esc(tr("从下方上游库开启你的第一个 MCP。", "Enable your first MCP from the catalog below."))}</div>`}<div class="hub-section-heading hub-catalog-heading"><span>${esc(tr("内置与插件上游库", "Built-in & plugin upstream catalog"))}</span><span class="hub-count">${servers.length}</span></div>${[...groups].map(([title, entries]) => `<section class="hub-upstream-group"><div class="hub-upstream-heading">${esc(title)} <span class="hub-count">${entries.length}</span></div><div class="hub-mcp-group">${entries.map((server) => row(server, true)).join("")}</div></section>`).join("") || empty(tr("没有匹配的 MCP", "No matching MCP servers"))}`;
    }
    function mcpGroupTitle(name) {
      const names = [[/chrome/i, "Chrome Devtools MCP"], [/codegraph/i, "Codegraph"], [/context7/i, "Context7 Docs"], [/playwright/i, "Playwright MCP"], [/lcu|computer.use/i, "LCU Computer Use"], [/reach/i, "Briking Agent Reach"], [/product|library/i, tr("产品库查询", "Product Library")], [/github/i, "GitHub"], [/cloudflare/i, "Cloudflare"]];
      return names.find(([test]) => test.test(name))?.[1] || tr("其他上游", "Other upstream servers");
    }

    function selectedMemoryProject() {
      const projects = items(cache.overview, ["projects", "items"]);
      return projects.find((project) => project.slug === state.memoryProject || project.projectRoot === state.memoryProject || project.root === state.memoryProject || project.path === state.memoryProject);
    }
    function selectedMemoryRoot() {
      if (state.memoryProject === "current") return state.projectRoot;
      if (state.memoryProject === "global") return null;
      const selected = selectedMemoryProject();
      return selected?.projectRoot || selected?.root || selected?.path || (state.memoryProject.startsWith("/") ? state.memoryProject : null);
    }
    function memoryPayload() {
      const selected = selectedMemoryProject();
      const projectSlug = state.memoryProject === "global" ? "_global" : state.memoryProject === "current" ? cache.overview?.currentProjectSlug : selected?.slug;
      return { projectRoot: selectedMemoryRoot(), projectSlug: projectSlug || undefined, scope: state.memoryProject === "global" ? "global" : "project", module: state.memoryModule === "all" ? undefined : state.memoryModule, query: state.memoryQuery.trim(), limit: 500 };
    }
    function moduleOptions() {
      return [["all", tr("全部", "All"), ""], ["constraints", tr("铁律", "Rules"), "📌"], ["pitfalls", tr("踩坑", "Pitfalls"), "🪤"], ["architecture", tr("架构", "Architecture"), "🏗️"], ["topics", tr("专题", "Topics"), "📚"]];
    }
    function normalizeModule(module) {
      return ({ constraint: "constraints", rule: "constraints", rules: "constraints", pitfall: "pitfalls", experience: "pitfalls", topic: "topics", "topic-memory": "topics", memory: "constraints" })[module] || module || "topics";
    }
    function renderMemory() {
      content.innerHTML = `<div id="t3-hub-engine"></div><div class="hub-section-heading"><span>${esc(tr("让经验留在项目里", "Keep what your projects learn"))}</span><span class="hub-count" id="t3-hub-memory-total"></span></div><div id="t3-hub-memory-nav"></div><div id="t3-hub-new-memory"></div><div class="hub-search">${icon("search", 14)}<input class="hub-input" name="memoryQuery" aria-label="${esc(tr("搜索记忆", "Search memories"))}" placeholder="${esc(tr("搜索记忆 · 关键词 + 语义", "Search memories · Keywords + meaning"))}" value="${esc(state.memoryQuery)}"></div><div id="t3-hub-memory-filters" class="hub-filters hub-memory-filters"></div><div id="t3-hub-memory-list"></div>`;
      renderEngine();
      renderMemoryNav();
      renderMemoryList();
      renderNewMemory();
    }
    function curatedModels() {
      const models = items(cache.embed, ["models", "presets", "availableModels"]);
      const defaults = [
        { id: "mlx-community/embeddinggemma-2-8bit", name: "EmbeddingGemma-2-8bit" },
        { id: "mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ", name: "Qwen3-Embedding-0.6B-4bit" },
        { id: "mlx-community/bge-small-zh-v1.5-4bit", name: "BGE-Small-ZH-4bit" },
      ];
      return (models.length ? models : defaults).map((model) => typeof model === "string" ? { id: model, name: model.split("/").pop() } : { ...model, id: model.id || model.modelId, name: model.name || model.label || (model.id || model.modelId || "").split("/").pop() }).filter((model) => model.id && !/^(keyword|fts5-zero-ram)$/.test(model.id) && !/keyword|fts/.test(model.mode || ""));
    }
    function engineMode() { return cache.embed?.mode || cache.embed?.engine?.mode || (cache.embed?.enabled === false ? "keyword" : "local"); }
    function engineModel() { return cache.embed?.activeModelId || cache.embed?.modelId || cache.embed?.currentModel?.id || cache.embed?.model?.id || cache.embed?.engine?.modelId || (typeof cache.embed?.model === "string" ? cache.embed.model : ""); }
    function renderEngine() {
      const node = root.querySelector("#t3-hub-engine");
      if (!node) return;
      if (!cache.embed) { node.innerHTML = errors.embed ? inlineError(errors.embed, "refresh-embed") : loading(); return; }
      const data = cache.embed;
      const keyword = /keyword|fts|none/.test(engineMode());
      const modelId = engineModel();
      if (!state.modelChoice) state.modelChoice = keyword ? "keyword" : modelId || curatedModels()[0]?.id || "keyword";
      const known = curatedModels();
      if (!known.some((model) => model.id === state.modelChoice) && !["keyword", "custom"].includes(state.modelChoice)) {
        state.customModel = state.modelChoice;
        state.modelChoice = "custom";
      }
      const mb = data.rssMb ?? data.memoryMB ?? data.ramMB ?? data.engine?.memoryMB ?? (data.memoryBytes ? Math.round(data.memoryBytes / 1048576) : null);
      const active = data.downloadJob?.active === true;
      const ready = data.ready ?? data.running ?? data.engine?.ready ?? null;
      const status = keyword ? tr("纯关键词零内存模式 · 0 MB", "Keyword-only · 0 MB") : ready === true ? tr(`本地向量运行中${mb == null ? "" : ` · ${Math.round(mb)} MB`}`, `Local vectors running${mb == null ? "" : ` · ${Math.round(mb)} MB`}`) : active ? tr("正在准备本地向量模型", "Preparing local vector model") : tr("本地向量引擎 · 待就绪", "Local vector engine · Not ready");
      const selected = known.find((model) => model.id === state.modelChoice);
      const switchOnly = state.modelChoice === "keyword" || selected?.downloaded || selected?.installed || selected?.cached;
      node.innerHTML = `<div class="hub-card hub-engine"><div class="hub-row"><span class="hub-engine-label">VECTOR ENGINE</span><span class="hub-grow"></span><span class="hub-badge hub-green">${icon("bolt", 10)}${esc(tr("轻量记忆", "Lightweight"))}</span></div><div id="t3-hub-engine-status" class="hub-engine-status">${icon(keyword ? "bolt" : "memory", 13)}<span>${esc(status)}</span></div><div class="hub-engine-model">${esc(keyword ? tr("不加载模型，全文检索依然可用。", "No model loaded. Full-text search stays available.") : modelId || tr("选择一个适合你的本地模型", "Choose your local model"))}</div><div class="hub-engine-controls"><select class="hub-select" name="embed-model" aria-label="${esc(tr("向量模型", "Embedding model"))}" ${active ? "disabled" : ""}>${known.map((model) => `<option value="${esc(model.id)}" ${state.modelChoice === model.id ? "selected" : ""}>${esc(model.name)}${model.downloaded || model.installed || model.cached ? ` [${esc(tr("已下载", "Downloaded"))}]` : ""}</option>`).join("")}<option value="keyword" ${state.modelChoice === "keyword" ? "selected" : ""}>${esc(tr("纯关键词零内存模式 0MB", "Keyword-only · 0 MB"))}</option><option value="custom" ${state.modelChoice === "custom" ? "selected" : ""}>${esc(tr("自定义模型…", "Custom model…"))}</option></select>${button("switch-embed", active ? tr("下载中", "Loading") : switchOnly ? tr("切换", "Switch") : tr("下载并启用", "Download & use"), { primary: true, icon: active ? undefined : switchOnly ? "bolt" : "download", disabled: active })}</div>${state.modelChoice === "custom" ? `<input class="hub-input" style="margin-top:8px" name="customModel" value="${esc(state.customModel)}" placeholder="HuggingFace ID / ${esc(tr("本地路径", "local path"))}" aria-label="${esc(tr("自定义模型地址", "Custom model ID or path"))}" spellcheck="false">` : ""}<label class="hub-checkbox"><input type="checkbox" name="useMirror" ${state.useMirror ? "checked" : ""} ${active ? "disabled" : ""}>${esc(tr("国内镜像加速 (hf-mirror)", "Use hf-mirror download accelerator"))}</label><div id="t3-hub-download-progress"></div>${data.downloadJob?.error ? `<div class="hub-hint" style="color:var(--hud-red);margin-top:9px">${esc(errorText(data.downloadJob.error))}</div>` : ""}</div>`;
      renderDownloadProgress();
    }
    function renderDownloadProgress() {
      const node = root.querySelector("#t3-hub-download-progress");
      if (!node) return;
      const job = cache.embed?.downloadJob;
      if (!job?.active) { node.innerHTML = ""; return; }
      const raw = job.percent ?? job.progress;
      const percent = raw == null ? null : Math.max(0, Math.min(100, Number(raw) * (job.percent == null && Number(raw) <= 1 ? 100 : 1)));
      const downloaded = job.downloadedMB ?? job.downloadedMb ?? job.receivedMB ?? ((job.downloadedBytes ?? job.bytesDownloaded) != null ? Math.round((job.downloadedBytes ?? job.bytesDownloaded) / 1048576) : null);
      const total = job.totalMB ?? (job.totalBytes != null ? Math.round(job.totalBytes / 1048576) : null);
      node.innerHTML = `<div class="hub-progress-label"><span>${esc(tr("下载中", "Downloading"))}${percent == null ? "…" : ` ${Math.round(percent)}%`}${downloaded == null ? "" : ` · ${Math.round(downloaded)} MB`}</span><span>${total == null ? "" : `${Math.round(total)} MB`}</span></div><div class="hub-progress-track ${percent == null ? "indeterminate" : ""}" role="progressbar" aria-label="${esc(tr("模型下载进度", "Model download progress"))}" aria-valuemin="0" aria-valuemax="100" ${percent == null ? "" : `aria-valuenow="${Math.round(percent)}"`}><div class="hub-progress-fill" style="width:${percent == null ? 40 : percent}%"></div></div>`;
    }
    function renderMemoryNav() {
      const node = root.querySelector("#t3-hub-memory-nav");
      if (!node) return;
      const projects = items(cache.overview, ["projects", "items"]);
      const seen = new Set([state.projectRoot]);
      const projectOptions = projects.map((project) => {
        const path = typeof project === "string" ? project : project.projectRoot ?? project.root ?? project.path;
        const key = typeof project === "string" ? project : project.slug || path || project.id;
        if (!key || seen.has(path || key) || ["global", "_global", "__global__"].includes(key)) return "";
        seen.add(path || key);
        const name = typeof project === "string" ? project.split(/[\\/]/).filter(Boolean).pop() : project.title || project.name || project.projectName || String(path || key).split(/[\\/]/).filter(Boolean).pop();
        const count = project.count ?? project.total ?? project.memoryCount;
        return `<option value="${esc(key)}" ${state.memoryProject === key ? "selected" : ""}>📁 ${esc(name)}${count == null ? "" : ` · ${count}`}</option>`;
      }).join("");
      node.innerHTML = `<div class="hub-project-picker"><select class="hub-select" name="memoryProject" aria-label="${esc(tr("记忆所属项目", "Memory project"))}"><option value="current" ${state.memoryProject === "current" ? "selected" : ""} ${projectDisabled() ? "disabled" : ""}>📁 ${esc(tr("当前项目", "Current project"))}</option><option value="global" ${state.memoryProject === "global" ? "selected" : ""}>🌐 ${esc(tr("全局通用记忆", "Global memories"))}</option>${projectOptions}</select>${button("new-memory", tr("新建 / 演进记忆", "New / evolve memory"), { icon: "plus", small: true })}</div><div class="hub-memory-toolbar">${button("consolidate-memory", tr("🧹 一键再记忆整理", "🧹 Consolidate memories"), { small: true, disabled: !selectedMemoryRoot(), attrs: `title="${esc(!selectedMemoryRoot() ? tr("请选择项目记忆库", "Select a project vault") : tr("合并重复经验，整理过时记忆", "Merge duplicates and outdated memories"))}"` })}<span class="hub-hint">${esc(tr("去重 · 演进 · 保留历史", "Deduplicate · Evolve · Keep history"))}</span></div>`;
      if (errors.overview) node.insertAdjacentHTML("beforeend", inlineError(errors.overview));
    }
    function memoryRecords() { return items(cache.memory, ["items", "memories", "results"]); }
    function memoryId(item) { return String(item.id ?? item.key ?? item.path ?? ""); }
    function memoryBody(item) { return item.content ?? item.body ?? item.markdown ?? item.text ?? ""; }
    function memoryDraftKey(id) { return `${state.memoryProject}\u0000${id}`; }
    function dateLabel(value) {
      if (!value) return "";
      const date = new Date(value);
      if (!Number.isFinite(date.getTime())) return String(value).slice(0, 16);
      return date.toLocaleDateString(state.lang === "en" ? "en-US" : "zh-CN", { month: "2-digit", day: "2-digit" });
    }
    function renderMemoryList() {
      if (state.tab !== "memory" || disposed) return;
      const records = memoryRecords();
      const project = state.memoryProject === "current" ? items(cache.overview, ["projects", "items"]).find((item) => item.slug === cache.overview?.currentProjectSlug || item.projectRoot === state.projectRoot) : state.memoryProject === "global" ? items(cache.overview, ["projects", "items"]).find((item) => ["global", "_global"].includes(item.slug)) : selectedMemoryProject();
      const moduleCounts = cache.memory?.moduleCounts || cache.memory?.counts || project?.byModule || {};
      const total = cache.memory?.total ?? project?.total ?? records.length;
      root.querySelector("#t3-hub-memory-total").textContent = tr(`${total} 条记忆`, `${total} memories`);
      root.querySelector("#t3-hub-memory-filters").innerHTML = moduleOptions().map(([key, label, emoji]) => {
        const count = key === "all" ? total : moduleCounts[key];
        return `<button type="button" class="hub-pill ${state.memoryModule === key ? "is-active" : ""}" data-action="memory-module" data-module="${key}" aria-pressed="${state.memoryModule === key}">${emoji ? `${emoji} ` : ""}${esc(label)}${count == null ? "" : `<span class="hub-pill-count">${count}</span>`}</button>`;
      }).join("");
      const node = root.querySelector("#t3-hub-memory-list");
      node.innerHTML = errors.memory ? inlineError(errors.memory, "refresh-memory") : !cache.memory ? loading() : !records.length ? empty(tr("这里还没有匹配的记忆", "No memories found here"), tr("换一个项目、模块或关键词，也可以新建一条。", "Try another project, module, or search. Or add a memory."), "memory") : records.map((item) => {
        const id = memoryId(item);
        const selected = state.selectedMemory === id;
        const module = normalizeModule(item.module || item.category || item.type);
        const moduleLabel = moduleOptions().find(([key]) => key === module);
        const source = item.sourceAgent || item.agent || item.source || "migrated";
        const draft = drafts[memoryDraftKey(id)];
        return `<article class="hub-card hub-memory-card ${selected ? "is-selected" : ""}" data-memory-id="${esc(id)}"><button type="button" class="hub-memory-open" data-action="open-memory" data-id="${esc(id)}" aria-expanded="${selected}"><div class="hub-card-top"><span class="hub-asset-icon ${module === "constraints" ? "accent" : ""}" style="width:27px;height:27px;font-size:13px">${esc(moduleLabel?.[2] || "📚")}</span><div class="hub-grow"><div class="hub-card-name">${esc(item.title || item.name || memoryBody(item).split("\n")[0].replace(/^#+\s*/, "") || tr("未命名记忆", "Untitled memory"))}</div><div class="hub-card-meta"><span class="hub-badge">${esc(source)}</span>${Number(item.version) > 1 ? `<span class="hub-badge hub-purple">🔄 v${esc(item.version)}</span>` : ""}${Number(item.hitCount) > 0 ? `<span class="hub-memory-hits">🔥 ${esc(item.hitCount)}</span>` : ""}<span class="hub-memory-date">${esc(dateLabel(item.updatedAt || item.updated_at || item.createdAt))}</span></div></div><span style="color:var(--hud-muted);transform:rotate(${selected ? 90 : 0}deg)">${icon("chevron", 12)}</span></div>${selected ? "" : `<p class="hub-card-description">${esc(item.summary || memoryBody(item).replace(/[#*`>]/g, "").slice(0, 210))}</p>`}</button>${selected ? `<div class="hub-memory-detail"><label class="hub-field">${esc(tr("标题", "Title"))}<input class="hub-input" name="memory-title" data-id="${esc(id)}" value="${esc(draft?.title ?? item.title ?? item.name ?? "")}"></label><label class="hub-field">Markdown<textarea class="hub-editor" name="memory-content" data-id="${esc(id)}" spellcheck="false" aria-label="${esc(tr("记忆内容", "Memory content"))}">${esc(draft?.content ?? memoryBody(item))}</textarea></label><div class="hub-detail-meta"><span class="hub-badge">${esc(source)}</span><span>${esc(tr("更新于", "Updated"))} ${esc(item.updatedAt || item.updated_at || tr("未知", "Unknown"))}</span></div><div class="hub-editor-actions">${button("save-memory", tr("保存修改", "Save"), { primary: true, icon: "save", attrs: `data-id="${esc(id)}"` })}${button("pin-memory", tr("置顶到 AGENTS.md", "Pin to AGENTS.md"), { icon: "pin", disabled: !selectedMemoryRoot(), attrs: `data-id="${esc(id)}" title="${esc(!selectedMemoryRoot() ? tr("请选择要写入的项目", "Choose a project to pin into") : "")}"` })}${button("delete-memory", tr("删除", "Delete"), { icon: "trash", danger: true, attrs: `data-id="${esc(id)}"` })}</div><div data-delete-confirm hidden class="hub-confirm-delete">${esc(tr("确定删除这条记忆？此操作无法撤销。", "Delete this memory? This cannot be undone."))}<div class="hub-row">${button("confirm-delete-memory", tr("确认删除", "Delete memory"), { danger: true, small: true, attrs: `data-id="${esc(id)}"` })}${button("cancel-delete-memory", tr("取消", "Cancel"), { small: true })}</div></div></div>` : ""}${renderMemoryHistory(item)}</article>`;
      }).join("");
    }
    function renderMemoryHistory(item) {
      const history = items(item, ["history"]);
      if (!history.length) return "";
      const id = memoryId(item), key = memoryDraftKey(id), open = !!state.historyExpanded[key];
      return `<div class="hub-memory-history"><button type="button" class="hub-history-toggle" data-action="memory-history" data-id="${esc(id)}" aria-expanded="${open}">${icon("chevron", 11)}${esc(tr(`查看演进历史 (${history.length} 次修订)`, `Evolution history (${history.length} revisions)`))}</button><div class="hub-history-list" ${open ? "" : "hidden"}>${history.map((entry, index) => {
        const version = entry.version ?? entry.targetVersion ?? index + 1;
        return `<div class="hub-history-entry"><div class="hub-row"><strong>v${esc(version)}</strong><span>${esc(entry.timestamp || entry.updatedAt || entry.createdAt || "")}</span></div><div class="hub-history-agent">${esc(entry.agent || entry.sourceAgent || tr("未知来源", "Unknown agent"))}</div><p>${esc(entry.content || entry.text || entry.oldText || entry.body || "")}</p>${button("rollback-memory", tr("↩ 回滚到此版本", "↩ Restore this version"), { small: true, attrs: `data-id="${esc(id)}" data-version="${esc(version)}" data-revision-id="${esc(entry.revisionId || "")}"` })}</div>`;
      }).join("")}</div></div>`;
    }
    async function openNewMemory() {
      const payload = memoryPayload(), selection = JSON.stringify([payload.projectRoot, payload.projectSlug]);
      drafts.__new = { ...(drafts.__new || { module: state.memoryModule === "all" ? "topics" : state.memoryModule }), open: true };
      state.supersedeLoading = true;
      state.supersedeItems = [];
      renderNewMemory();
      root.querySelector('[name="new-memory-title"]')?.focus();
      try {
        const data = await request("memory:list", { ...payload, module: undefined, query: "", limit: 500 });
        const current = memoryPayload();
        if (disposed || selection !== JSON.stringify([current.projectRoot, current.projectSlug])) return;
        state.supersedeItems = items(data, ["items", "memories", "results"]);
      } catch (error) { if (!disposed) toast(errorText(error), true); }
      finally {
        const current = memoryPayload();
        if (!disposed && selection === JSON.stringify([current.projectRoot, current.projectSlug])) {
          state.supersedeLoading = false;
          // Preserve text and focus while the optional choices load.
          const select = content.querySelector('[name="new-memory-supersedes"]');
          if (select) { select.innerHTML = supersedeOptions(); select.disabled = false; }
        }
      }
    }
    function supersedeOptions() {
      return `<option value="">${esc(tr("不覆盖 · 新建独立记忆", "New independent memory"))}</option>${state.supersedeItems.map((item) => `<option value="${esc(memoryId(item))}" ${drafts.__new?.supersedes === memoryId(item) ? "selected" : ""}>${esc(item.title || memoryBody(item).slice(0, 64))}${Number(item.version) > 1 ? ` · v${esc(item.version)}` : ""}</option>`).join("")}`;
    }
    function renderNewMemory() {
      const node = root.querySelector("#t3-hub-new-memory");
      if (!node) return;
      const draft = drafts.__new;
      if (!draft?.open) { node.innerHTML = ""; return; }
      node.innerHTML = `<div class="hub-new-memory"><div class="hub-section-heading">${esc(tr("记录一条可复用的经验", "Write something worth remembering"))}</div><label class="hub-field">${esc(tr("标题", "Title"))}<input class="hub-input" name="new-memory-title" value="${esc(draft.title || "")}" placeholder="${esc(tr("一句话说清这条记忆", "A short, clear title"))}"></label><label class="hub-field">${esc(tr("模块", "Module"))}<select class="hub-select" name="new-memory-module">${moduleOptions().filter(([key]) => key !== "all").map(([key, label, emoji]) => `<option value="${key}" ${draft.module === key ? "selected" : ""}>${emoji} ${esc(label)}</option>`).join("")}</select></label><label class="hub-field">${esc(tr("覆盖旧记忆 (Supersede) · 可选", "Supersede an existing memory · optional"))}<select class="hub-select" name="new-memory-supersedes" ${state.supersedeLoading ? "disabled" : ""}>${supersedeOptions()}</select></label><textarea class="hub-editor" name="new-memory-content" spellcheck="false" aria-label="${esc(tr("新记忆内容", "New memory content"))}" placeholder="${esc(tr("写下背景、结论与验证过的经验…", "Context, conclusions, and verified lessons…"))}">${esc(draft.content || "")}</textarea><div class="hub-editor-actions">${button("create-memory", tr("保存记忆", "Save memory"), { primary: true, icon: "save" })}${button("cancel-new-memory", tr("取消", "Cancel"))}</div></div>`;
    }

    function agentKey(target = state.agentsTarget) { return target === "global" ? "global" : `project:${state.projectRoot || ""}`; }
    function agentDraft() { return state.agentDrafts[agentKey()]; }
    function estimateTokens(value) {
      let cjk = 0;
      for (const char of value) if (/[^\u0000-\u2e7f]/.test(char)) cjk++;
      return Math.ceil(cjk * 0.72 + (value.length - cjk) * 0.27);
    }
    function renderAgents() {
      const draft = agentDraft();
      const blocked = state.agentsTarget === "project" && projectDisabled();
      content.innerHTML = `<div class="hub-section-heading"><span>${esc(tr("把协作方式写下来", "Make your preferences explicit"))}</span></div><p class="hub-description">${esc(tr("规则轻一点，记忆深一点。让每个助手都懂你的习惯。", "Keep rules lean and memory deep. Help every assistant work your way."))}</p><div class="hub-agents-targets">${[["global", "globe", tr("全局 AGENTS.md", "Global AGENTS.md"), tr("一处编辑 · 5 端同步", "Edit once · Sync across 5 CLIs")], ["project", "folder", tr("当前项目 AGENTS.md", "Project AGENTS.md"), state.projectRoot ? tr("仅应用于当前项目", "Applies to the current project") : projectTitle()]].map(([target, name, label, hint]) => `<button type="button" class="hub-agents-target ${state.agentsTarget === target ? "is-active" : ""}" data-action="agents-target" data-target="${target}" aria-pressed="${state.agentsTarget === target}" ${target === "project" && projectDisabled() ? `disabled title="${esc(projectTitle())}"` : ""}>${icon(name, 16)}<span><strong>${esc(label)}</strong><small>${esc(hint)}</small></span><span class="hub-radio"></span></button>`).join("")}</div>${blocked ? empty(projectTitle(), "", "folder") : errors.agents ? inlineError(errors.agents) : !draft ? loading() : `${state.agentsTarget === "project" ? button("inject-soft-route", tr("注入记忆库软路由模板", "Insert memory routing template"), { icon: "spark", attrs: 'title="AGENTS.md"' }) : ""}<div class="hub-token-bar"><strong>AGENTS.md</strong><span id="t3-hub-token-count" class="hub-token"></span></div><p id="t3-hub-token-warning" class="hub-token-warning" hidden>${esc(tr("建议把详细知识放进记忆库，AGENTS.md 保留简洁入口。", "Move detailed knowledge into memory; keep AGENTS.md a lean entry point."))}</p><textarea class="hub-editor hub-agents-editor" name="agents-content" spellcheck="false" aria-label="AGENTS.md Markdown" placeholder="${esc(tr("写下你希望所有助手遵守的协作规则…", "How would you like your assistants to work?"))}">${esc(draft.content)}</textarea><div class="hub-agents-save"><span id="t3-hub-agents-dirty" class="hub-saved-hint"></span>${button("save-agents", tr("保存并同步", "Save & sync"), { primary: true, icon: "save" })}</div><div id="t3-hub-sync-badges" class="hub-sync-badges"></div><div class="hub-hint" style="margin-top:11px">${icon("info", 12)}${esc(tr("Tab 缩进 · ⌘S / Ctrl+S 保存", "Tab to indent · ⌘S / Ctrl+S to save"))}</div>`}`;
      content.querySelector('[data-action="inject-soft-route"]')?.classList.add("hub-soft-route");
      updateAgentCounter();
      renderSyncBadges();
    }
    function updateAgentCounter() {
      const node = root.querySelector("#t3-hub-token-count");
      const draft = agentDraft();
      if (!node || !draft) return;
      const count = estimateTokens(draft.content);
      node.textContent = tr(`约 ${count.toLocaleString()} tokens · ${count > 2500 ? "建议精简" : "极轻量"}`, `~${count.toLocaleString()} tokens · ${count > 2500 ? "Keep it lean" : "Lightweight"}`);
      node.classList.toggle("is-warn", count > 2500);
      root.querySelector("#t3-hub-token-warning").hidden = count <= 2500;
      root.querySelector("#t3-hub-agents-dirty").textContent = draft.content === draft.saved ? tr("已保存", "Saved") : tr("有未保存的修改", "Unsaved changes");
    }
    function renderSyncBadges() {
      const node = root.querySelector("#t3-hub-sync-badges");
      if (!node) return;
      const targets = agentDraft()?.syncedTargets || [];
      node.innerHTML = targets.map((target) => {
        const name = typeof target === "string" ? target : target.name || target.cli || target.target;
        const label = /antigravity|agy/i.test(name) ? "Antigravity" : /codex/i.test(name) ? "Codex" : /muse/i.test(name) ? "Muse" : /(?:^|[/.])pi(?:[/.]|$)/i.test(name) ? "Pi" : /claude/i.test(name) ? "Claude" : state.agentsTarget === "project" ? tr("当前项目", "Project") : name;
        return `<span class="hub-badge hub-green">${esc(label)} ${icon("check", 10)}</span>`;
      }).join("");
    }

    // RPC lifecycle and user interactions are below; each response is guarded so a
    // previous thread or an unmounted instance can never overwrite a newer view.
    function toast(message, error = false) {
      if (disposed || !root) return;
      const node = root.querySelector(".hub-toast");
      node.classList.toggle("is-error", error);
      node.innerHTML = `${icon(error ? "info" : "check", 15)}<span>${esc(message)}</span>`;
      node.hidden = false;
      cancelTimer(toastTimer);
      toastTimer = later(() => { node.hidden = true; }, error ? 6500 : 3500);
    }
    async function busy(key, element, work) {
      if (pending.has(key) || disposed) return;
      pending.add(key);
      const html = element?.innerHTML;
      if (element) { element.disabled = true; element.classList.add("is-busy"); if (element.tagName === "BUTTON") element.innerHTML = `${spinner()}<span>${esc(tr("处理中", "Working"))}</span>`; }
      try { await work(); } catch (error) { toast(errorText(error), true); }
      finally {
        pending.delete(key);
        if (element?.isConnected && !disposed) { element.disabled = false; element.classList.remove("is-busy"); if (html != null && element.tagName === "BUTTON") element.innerHTML = html; }
      }
    }

    // The slash palette is a sibling of the drawer: it works while the Hub is closed.
    // Alt-modified keys keep the host's /plan menu and normal Enter submission intact.
    function composerFor(target) {
      const element = target?.nodeType === 1 ? target : target?.parentElement;
      const editor = element?.closest('textarea,[contenteditable="true"],[contenteditable="plaintext-only"]');
      if (!editor || editor.closest('#t3-sidecar-hub,#t3-sidecar-hub-root,[role="dialog"],[role="alertdialog"],dialog') || editor.disabled || editor.readOnly) return null;
      if (editor.closest('aside,nav,[role="navigation"],[role="search"],.monaco-editor,.cm-editor')) return null;
      if (!editor.closest('[data-slot="composer-shell"],[data-testid="chat-composer"],[data-testid="composer"],[data-composer],main,[role="main"]')) return null;
      return editor;
    }
    function editableText(editor) {
      // Map DOM positions as well as text. Lexical/ProseMirror paragraphs and <br>
      // must count as whitespace, including a slash at the start of a new line.
      let value = "";
      const segments = [], boundaries = new WeakMap();
      const block = /^(P|DIV|LI|PRE|BLOCKQUOTE|H[1-6])$/;
      const walk = (node) => {
        if (node.nodeType === 3) { const start = value.length; value += node.data; segments.push({ node, start, end: value.length }); return; }
        const offsets = [];
        boundaries.set(node, offsets);
        [...node.childNodes].forEach((child, index) => {
          if (child.nodeType === 1 && block.test(child.tagName) && value && !value.endsWith("\n")) value += "\n";
          offsets[index] = value.length;
          if (child.nodeName === "BR") value += "\n";
          else walk(child);
          if (child.nodeType === 1 && block.test(child.tagName) && child.nextSibling && !block.test(child.nextSibling.nodeName) && !value.endsWith("\n")) value += "\n";
          offsets[index + 1] = value.length;
        });
        if (!offsets.length) offsets[0] = value.length;
      };
      walk(editor);
      const selection = window.getSelection();
      if (!selection?.rangeCount || !selection.isCollapsed || !editor.contains(selection.anchorNode)) return null;
      const caret = selection.anchorNode.nodeType === 3 ? segments.find((entry) => entry.node === selection.anchorNode)?.start + selection.anchorOffset : boundaries.get(selection.anchorNode)?.[selection.anchorOffset];
      if (!Number.isFinite(caret)) return null;
      return { value, caret, point: (offset) => {
        const segment = segments.find((entry) => offset >= entry.start && offset <= entry.end);
        return segment ? { node: segment.node, offset: offset - segment.start } : null;
      } };
    }
    function composerToken(editor) {
      let text;
      if (editor.tagName === "TEXTAREA") {
        if (editor.selectionStart !== editor.selectionEnd) return null;
        text = { value: editor.value, caret: editor.selectionStart };
      } else text = editableText(editor);
      if (!text) return null;
      const match = text.value.slice(0, text.caret).match(/(?:^|\s)\/([^\s/]*)$/u);
      if (!match) return null;
      const start = text.caret - match[1].length - 1;
      const end = text.caret + (text.value.slice(text.caret).match(/^[^\s/]*/u)?.[0].length || 0);
      return { ...text, start, end, query: match[1].toLowerCase(), raw: text.value.slice(start, end) };
    }
    function closeSlash() {
      slashVersion++;
      const session = slashSession;
      slashSession = null;
      if (palette) palette.hidden = true;
      if (session?.editor) {
        for (const [name, value] of Object.entries(session.aria || {})) {
          const current = session.editor.getAttribute(name);
          if ((name === "aria-controls" && current !== "t3-hub-slash-list") || (name === "aria-activedescendant" && !current?.startsWith("t3-hub-slash-option-"))) continue;
          if (value === null) session.editor.removeAttribute(name); else session.editor.setAttribute(name, value);
        }
      }
    }
    function invalidateSlashCache() {
      slashCache.clear();
      closeSlash();
    }
    async function slashData(projectRoot) {
      const key = projectRoot || "__global__", existing = slashCache.get(key);
      if (existing && Date.now() - existing.at < 3000) return existing.promise;
      const entry = { at: Date.now(), promise: null };
      entry.promise = (async () => {
        const data = await request("slash:list", { projectRoot });
        const agents = items(data, ["subagents"]);
        // Older backends return effective agents without their scope. Reconcile
        // against the current project's overrides so the edit shortcut is exact.
        if (agents.some((item) => !item.scope && !item._from && !item.projectRoot)) {
          const listed = cache.subagents?.projectRoot === projectRoot ? cache.subagents : await request("subagents:list", { projectRoot });
          if (listed.projectRoot != null && listed.projectRoot !== projectRoot) return { ...data, subagents: [] };
          const globals = new Set(items(listed, ["globalItems"]).map(subagentId));
          const projects = new Set(items(listed, ["projectItems"]).filter((item) => item.enabled !== false && (item.overridesGlobal || !globals.has(subagentId(item)))).map(subagentId));
          return { ...data, subagents: agents.map((item) => ({ ...item, scope: item.scope || (projectRoot && projects.has(String(item.id)) ? "project" : "global") })) };
        }
        return data;
      })().catch((error) => { if (slashCache.get(key) === entry) slashCache.delete(key); throw error; });
      slashCache.set(key, entry);
      return entry.promise;
    }
    function scopedSlashItems(data, projectRoot) {
      if (data.projectRoot != null && data.projectRoot !== projectRoot) return [];
      const rows = [...items(data, ["skills"]).map((item) => ({ ...item, type: "skill" })), ...items(data, ["subagents"]).map((item) => ({ ...item, type: "subagent" }))];
      const seen = new Set();
      return rows.filter((item) => {
        if (!item.id || item.enabled === false || item.disabled === true) return false;
        const scope = item.scope || (item.global === true ? "global" : item.type === "subagent" ? (item.projectRoot || item._from?.startsWith("project") ? "project" : "global") : "");
        if (scope !== "global" && scope !== "project") return false;
        if (scope === "project" && (!projectRoot || (item.projectRoot && item.projectRoot !== projectRoot) || (Array.isArray(item.projects) && !item.projects.includes(projectRoot)))) return false;
        item.scope = scope;
        const key = `${item.type}:${item.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    function matchesSlash(item, query) {
      if (!query || [item.id, item.name, item.description, item.providerInstanceId, item.model].join(" ").toLowerCase().includes(query)) return true;
      // Familiar short forms such as /fe also match frontend, without widening
      // the project-scoped data set or fuzzy-matching long descriptions.
      if (query.length !== 2) return false;
      return [item.id, item.name || ""].some((value) => {
        let cursor = 0;
        const name = value.toLowerCase();
        return [...query].every((char) => { const found = name.indexOf(char, cursor); cursor = found + 1; return found !== -1; });
      });
    }
    function slashRank(item, query) {
      if (!query) return 0;
      const id = String(item.id).toLowerCase(), name = String(item.name || "").toLowerCase();
      if (id === query || name === query) return 0;
      if (id.startsWith(query)) return 1;
      if (name.startsWith(query)) return 2;
      if (id.includes(query)) return 3;
      if (name.includes(query)) return 4;
      return 5;
    }
    async function onComposerInput(event) {
      if (disposed || composing || event.isComposing || slashInserting || root?.contains(event.target)) return;
      const editor = composerFor(event.target);
      if (!editor) return;
      if (contextLoading || !state.connected || document.activeElement !== editor) { closeSlash(); return; }
      const token = composerToken(editor);
      if (!token) { closeSlash(); return; }
      if (slashSession?.editor === editor && slashSession.projectRoot === state.projectRoot && slashSession.token.raw === token.raw && slashSession.token.start === token.start && !palette.hidden) { slashSession.token = token; positionSlash(); return; }
      closeSlash();
      const version = ++slashVersion, projectRoot = state.projectRoot, route = routeKey();
      const session = slashSession = { editor, token, projectRoot, route, rows: [], active: 0, loading: true, aria: { "aria-controls": editor.getAttribute("aria-controls"), "aria-activedescendant": editor.getAttribute("aria-activedescendant") } };
      renderSlash();
      try {
        const data = await slashData(projectRoot);
        if (disposed || version !== slashVersion || session !== slashSession || contextLoading || projectRoot !== state.projectRoot || route !== routeKey() || document.activeElement !== editor || !editor.isConnected) return;
        const live = composerToken(editor);
        if (!live || live.raw !== token.raw || live.start !== token.start) { closeSlash(); return; }
        session.token = live;
        session.rows = scopedSlashItems(data, projectRoot).filter((item) => matchesSlash(item, token.query)).sort((a, b) => slashRank(a, token.query) - slashRank(b, token.query)).slice(0, 8);
      } catch (error) { if (session === slashSession) session.error = errorText(error); }
      finally { if (!disposed && version === slashVersion && session === slashSession) { session.loading = false; renderSlash(); } }
    }
    function renderSlash() {
      const session = slashSession;
      if (!session || !palette) return;
      const project = state.context?.projectName || state.projectRoot?.split(/[\\/]/).pop() || tr("全局", "Global");
      palette.innerHTML = `<div class="hub-slash-header">${icon("bolt", 13)}${esc(tr("项目快捷指令", "Project shortcuts"))}<span class="hub-slash-project">${esc(project)}</span></div><div id="t3-hub-slash-list" class="hub-slash-list" role="listbox" aria-label="${esc(tr("Skills 与子智能体", "Skills and agents"))}">${session.loading ? `<div class="hub-slash-empty">${spinner()} ${esc(tr("正在读取当前项目…", "Loading this project…"))}</div>` : session.error ? `<div class="hub-slash-empty" role="status">${esc(session.error)}</div>` : session.rows.length ? session.rows.map((item, index) => {
        const agent = item.type === "subagent";
        const badge = agent ? `${tr("子智能体", "Agent")} · ${item.providerInstanceId || "codex"}/${item.model || "default"}` : item.scope === "project" ? tr("仅本项目", "This project") : tr("全局", "Global");
        return `<div class="hub-slash-row ${index === session.active ? "is-active" : ""}" data-slash-index="${index}" data-slash-id="${esc(item.id)}"><button type="button" id="t3-hub-slash-option-${index}" class="hub-slash-select" role="option" aria-selected="${index === session.active}" data-action="slash-select" data-index="${index}"><span class="hub-slash-type ${agent ? "is-agent" : ""}">${icon(agent ? "hub" : "skill", 14)}</span><span class="hub-grow"><span class="hub-slash-label">/${esc(item.id)}</span><span class="hub-slash-description">${esc(item.description || item.name || (agent ? tr("派发子智能体", "Delegate to agent") : tr("启用技能", "Use skill")))}</span></span><span class="hub-badge hub-slash-badge ${agent ? "hub-purple" : item.scope === "project" ? "hub-cyan" : "hub-green"}" title="${esc(badge)}">${esc(badge)}</span></button>${agent ? `<button type="button" class="hub-slash-edit" data-action="slash-edit" data-index="${index}" title="${esc(tr("编辑此子智能体", "Edit this agent"))}" aria-label="${esc(tr("编辑子智能体", "Edit agent"))} ${esc(item.id)}">⚙️ ${esc(tr("编辑", "Edit"))}</button>` : ""}</div>`;
      }).join("") : `<div class="hub-slash-empty" role="status">${esc(tr("当前项目没有匹配的快捷指令", "No matching shortcuts for this project"))}</div>`}</div><div class="hub-slash-footer"><span>Alt + ↑↓ · Alt + Enter ${esc(tr("插入", "insert"))}</span><span>Esc ${esc(tr("关闭", "close"))}</span></div>`;
      palette.hidden = false;
      // Preserve any native /plan combobox's accessibility relationship.
      if (!session.aria["aria-controls"] || session.aria["aria-controls"] === "t3-hub-slash-list") {
        session.editor.setAttribute("aria-controls", "t3-hub-slash-list");
        if (session.rows.length) session.editor.setAttribute("aria-activedescendant", `t3-hub-slash-option-${session.active}`);
      }
      positionSlash();
    }
    function setSlashActive(index) {
      if (!slashSession?.rows.length) return;
      const next = (index + slashSession.rows.length) % slashSession.rows.length;
      slashSession.active = next;
      palette.querySelectorAll("[data-slash-index]").forEach((row, i) => { row.classList.toggle("is-active", i === next); row.querySelector('[role="option"]')?.setAttribute("aria-selected", String(i === next)); });
      if (slashSession.editor.getAttribute("aria-controls") === "t3-hub-slash-list") slashSession.editor.setAttribute("aria-activedescendant", `t3-hub-slash-option-${next}`);
    }
    function positionSlash() {
      if (!slashSession || !palette || palette.hidden || disposed) return;
      const editor = slashSession.editor;
      if (!editor.isConnected || !editor.getClientRects().length || root.classList.contains("is-occluded")) { closeSlash(); return; }
      const anchor = editor.closest('[data-slot="composer-shell"],[data-composer]') || editor;
      const rect = anchor.getBoundingClientRect();
      const viewport = window.visualViewport, leftEdge = viewport?.offsetLeft || 0, topEdge = viewport?.offsetTop || 0;
      const width = viewport?.width || innerWidth, height = viewport?.height || innerHeight;
      const paletteWidth = Math.min(400, width - 24);
      let left = Math.max(leftEdge + 12, Math.min(rect.right - paletteWidth, leftEdge + width - paletteWidth - 12));
      let ceiling = rect.top - 8;
      const menus = [...document.querySelectorAll('[role="listbox"],[role="menu"],[cmdk-list]')].filter((node) => !root.contains(node) && node.getClientRects().length && getComputedStyle(node).visibility !== "hidden");
      for (const menu of menus) {
        const box = menu.getBoundingClientRect();
        if (box.width > 650 || box.height > 600 || box.bottom < rect.top - 420 || box.top > rect.bottom) continue;
        if (left < box.right + 8 && left + paletteWidth > box.left - 8 && ceiling > box.top) {
          if (box.right + 8 + paletteWidth <= leftEdge + width - 12) left = box.right + 8;
          else ceiling = Math.min(ceiling, box.top - 8);
        }
      }
      palette.style.width = `${paletteWidth}px`;
      palette.style.maxHeight = `${Math.max(80, Math.min(352, ceiling - topEdge - 12, height - 24))}px`;
      const top = Math.max(topEdge + 12, Math.min(ceiling - palette.offsetHeight, topEdge + height - palette.offsetHeight - 12));
      palette.style.left = `${left}px`;
      palette.style.top = `${top}px`;
    }
    function onComposerKeyup(event) { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) && !event.altKey) onComposerInput(event); }
    function onComposerKeydown(event) {
      if (!slashSession || event.isComposing || composing) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeSlash(); return; }
      if (!event.altKey || event.ctrlKey || event.metaKey || !composerFor(event.target)) return;
      if (["ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        setSlashActive(slashSession.active + (event.key === "ArrowDown" ? 1 : -1));
        palette.querySelector(`#t3-hub-slash-option-${slashSession.active}`)?.scrollIntoView({ block: "nearest" });
      } else if (event.key === "Enter" && slashSession.rows.length) { event.preventDefault(); event.stopPropagation(); selectSlash(slashSession.active); }
    }
    function selectSlash(index) {
      const session = slashSession, item = session?.rows[index];
      if (!item || contextLoading || session.projectRoot !== state.projectRoot || session.route !== routeKey()) { closeSlash(); return; }
      const editor = session.editor, token = composerToken(editor);
      if (!token || token.raw !== session.token.raw || token.start !== session.token.start) { closeSlash(); return; }
      const insertion = `${item.type === "subagent" ? "@" : "$"}${item.id} `;
      slashInserting = true;
      closeSlash();
      try {
        editor.focus({ preventScroll: true });
        if (editor.tagName === "TEXTAREA") {
          const next = token.value.slice(0, token.start) + insertion + token.value.slice(token.end);
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(editor, next);
          editor.setSelectionRange(token.start + insertion.length, token.start + insertion.length);
          editor.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: insertion }));
        } else {
          const start = token.point(token.start), end = token.point(token.end);
          if (!start || !end) return;
          const range = document.createRange();
          range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset);
          const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
          let emitted = false;
          const observed = () => { emitted = true; };
          editor.addEventListener("input", observed);
          try {
            if (!document.execCommand("insertText", false, insertion)) {
              range.deleteContents();
              const node = document.createTextNode(insertion); range.insertNode(node); range.setStartAfter(node); range.collapse(true); selection.removeAllRanges(); selection.addRange(range);
            }
            if (!emitted) editor.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: insertion }));
          } finally { editor.removeEventListener("input", observed); }
        }
      } catch (error) { toast(errorText(error), true); }
      finally { slashInserting = false; }
    }
    async function editSlashSubagent(index) {
      const session = slashSession, item = session?.rows[index];
      if (!item || contextLoading || session.projectRoot !== state.projectRoot || session.route !== routeKey()) { closeSlash(); return; }
      closeSlash();
      const projectRoot = state.projectRoot;
      state.subagentScope = item.scope === "project" ? "project" : "global";
      state.subagentExpanded[subagentKey(item.id)] = true;
      switchTab("subagents");
      setOpen(true, false);
      await loadTab();
      if (disposed || state.tab !== "subagents" || state.projectRoot !== projectRoot) return;
      const card = [...content.querySelectorAll("[data-subagent-card]")].find((node) => node.dataset.subagentCard === item.id);
      card?.scrollIntoView({ block: "nearest" });
      card?.querySelector('[name="subagent-systemPrompt"]')?.focus({ preventScroll: true });
    }

    function findRouter() {
      if (window.__TSR_ROUTER__) return window.__TSR_ROUTER__;
      if (cachedRouter) return cachedRouter;
      if (Date.now() - routerProbeAt < 5000) return null;
      routerProbeAt = Date.now();
      // Same bounded TanStack lookup as the resident HUD; no history patching.
      try {
        const host = document.getElementById("root");
        const key = host && Object.keys(host).find((name) => name.startsWith("__reactContainer") || name.startsWith("__reactFiber"));
        const stack = key ? [host[key]] : [];
        const seen = new Set();
        while (stack.length && seen.size < 400) {
          const fiber = stack.pop();
          if (!fiber || seen.has(fiber)) continue;
          seen.add(fiber);
          if (fiber.memoizedProps?.router) { cachedRouter = fiber.memoizedProps.router; return cachedRouter; }
          if (fiber.child) stack.push(fiber.child);
          if (fiber.sibling) stack.push(fiber.sibling);
        }
      } catch {}
      return null;
    }
    function ensureRouterSubscription() {
      if (unsubscribeRouter) return;
      try {
        const router = findRouter();
        if (typeof router?.subscribe !== "function") return;
        let unsub;
        try { unsub = router.subscribe("onResolved", checkRoute); }
        catch { unsub = router.subscribe(checkRoute); }
        if (typeof unsub === "function") unsubscribeRouter = unsub;
        else if (typeof unsub?.unsubscribe === "function") unsubscribeRouter = () => unsub.unsubscribe();
      } catch {}
    }
    function routeHint() {
      return location.hash.slice(1) || findRouter()?.state?.location?.pathname || location.pathname || "/";
    }
    function routeKey() {
      return `${location.href}|${routeHint()}`;
    }
    function checkRoute() {
      const route = routeKey();
      if (route !== lastRoute) { lastRoute = route; refreshContext(); }
    }
    async function refreshContext(force = false) {
      const version = ++contextVersion;
      const before = state.projectRoot;
      contextLoading = true;
      closeSlash();
      try {
        const context = await request("hub:getContext", { threadHint: location.href, routeHint: routeHint() });
        if (disposed || version !== contextVersion) return;
        state.context = context;
        state.projectRoot = context.projectRoot || context.project?.root || context.project?.path || null;
        state.connected = true;
        state.contextError = "";
      } catch (error) {
        if (disposed || version !== contextVersion) return;
        state.contextError = errorText(error);
        state.context = null;
        state.projectRoot = null;
        state.connected = false;
      }
      contextLoading = false;
      if (before !== state.projectRoot) {
        requestVersion++;
        memoryVersion++;
        for (const key of ["plugins", "hooks", "skills", "subagents", "mcp", "overview", "memory", "agents"]) { cache[key] = null; delete errors[key]; }
        if (state.scope === "project" && !state.projectRoot) state.scope = "global";
        state.importScope = defaultScope();
        state.subagentScope = defaultScope();
        state.agentsTarget = defaultScope();
        state.memoryProject = defaultScope() === "project" ? "current" : "global";
        state.hookDraft = null;
        state.supersedeItems = [];
        state.selectedMemory = null;
        state.freshModes = {};
        if (state.memoryProject === "current" && !state.projectRoot) state.memoryProject = "global";
      } else if (!state.projectRoot) {
        state.scope = "global";
        state.subagentScope = "global";
        state.agentsTarget = "global";
        state.importScope = "global";
        if (state.memoryProject === "current") state.memoryProject = "global";
      }
      renderChrome();
      if (document.activeElement) onComposerInput({ target: document.activeElement });
      if (state.open) {
        if (!state.connected) content.innerHTML = inlineError(state.contextError);
        else { renderTab(); await loadTab(force); primeCatalogs(); }
      }
    }
    async function readCatalog(key, action, payload) {
      try { return await request(action, payload); }
      catch (error) {
        if (["plugins", "hooks"].includes(key) && /unknown action|not (?:yet )?(?:wired|implemented|supported)|unsupported|not found|尚未接入/i.test(errorText(error))) return { items: [], unavailable: true };
        throw error;
      }
    }
    const catalogInflight = new Set();
    async function primeCatalogs() {
      const projectRoot = state.projectRoot, version = contextVersion;
      const domains = [["plugins", "plugins:list"], ["mcp", "mcp:list"], ["skills", "skills:list"], ["hooks", "hooks:list"], ["subagents", "subagents:list"], ["overview", "memory:overview"]];
      await Promise.all(domains.map(async ([key, action]) => {
        const token = `${version}:${key}`;
        if (cache[key] || catalogInflight.has(token)) return;
        catalogInflight.add(token);
        try {
          const data = await readCatalog(key, action, { projectRoot });
          if (disposed || version !== contextVersion || projectRoot !== state.projectRoot) return;
          cache[key] = data; delete errors[key]; renderChrome();
          if (state.open && state.tab === key) renderTab();
        } catch {} finally { catalogInflight.delete(token); }
      }));
    }
    async function loadTab(force = false) {
      if (disposed || !state.open) return;
      const tab = state.tab;
      const version = ++requestVersion;
      const projectRoot = state.projectRoot;
      const load = async (key, action, payload) => {
        if (cache[key] && !force) return;
        delete errors[key];
        try {
          const data = await readCatalog(key, action, payload);
          if (disposed || version !== requestVersion || projectRoot !== state.projectRoot) return;
          cache[key] = data;
          if (key === "agents") seedAgentDrafts(data, projectRoot);
        } catch (error) {
          if (!disposed && version === requestVersion) errors[key] = error;
        }
      };
      if (tab === "plugins") await load("plugins", "plugins:list", { projectRoot });
      if (tab === "hooks") await load("hooks", "hooks:list", { projectRoot });
      if (tab === "skills") await load("skills", "skills:list", { projectRoot });
      if (tab === "subagents") await load("subagents", "subagents:list", { projectRoot });
      if (tab === "mcp") await load("mcp", "mcp:list", { projectRoot });
      if (tab === "agents") await load("agents", "agentsMd:get", { projectRoot });
      if (tab === "memory") {
        await Promise.all([load("overview", "memory:overview", { projectRoot }), refreshEmbed(false, force)]);
        if (!disposed && version === requestVersion) await loadMemories(false);
      }
      if (disposed || version !== requestVersion || state.tab !== tab) return;
      renderTab();
      renderChrome();
      if (tab === "memory") scheduleEmbedPoll();
    }
    async function loadMemories(render = true) {
      const version = ++memoryVersion;
      delete errors.memory;
      const payload = memoryPayload();
      try {
        if (!payload.projectRoot && !payload.projectSlug) throw new Error(tr("请重新选择记忆所属项目", "Choose a memory project again"));
        const data = await request("memory:list", payload);
        if (disposed || version !== memoryVersion) return;
        cache.memory = data;
      } catch (error) { if (!disposed && version === memoryVersion) errors.memory = error; }
      if (!disposed && render && state.tab === "memory") { renderMemoryList(); renderChrome(); }
    }
    function seedAgentDrafts(data, projectRoot) {
      for (const target of ["global", "project"]) {
        const key = target === "global" ? "global" : `project:${projectRoot || ""}`;
        const value = target === "global" ? data.globalContent ?? data.global?.content ?? (data.target === "global" ? data.content : "") : data.projectContent ?? data.project?.content ?? (data.target === "project" ? data.content : "");
        const old = state.agentDrafts[key];
        // Preserve edits during refresh or thread navigation, but refresh clean files.
        if (!old || old.content === old.saved) state.agentDrafts[key] = { content: value || "", saved: value || "", syncedTargets: target === "global" ? data.globalSyncedTargets || data.global?.syncedTargets || [] : data.projectExists ? ["project"] : [] };
      }
    }
    async function refreshEmbed(render = true, force = false) {
      if (cache.embed && !force && !cache.embed.downloadJob?.active) return;
      const version = ++embedVersion;
      try {
        const data = await request("embed:status", {});
        if (disposed || version !== embedVersion) return;
        const wasActive = cache.embed?.downloadJob?.active;
        const wasWaiting = state.embedReadyDeadline > 0;
        cache.embed = data;
        if (!state.embedInitialized) { state.useMirror = !!data.useMirror; state.embedInitialized = true; }
        if (data.downloadJob?.active) state.embedReadyDeadline = Date.now() + 60000;
        const ready = data.ready ?? data.running ?? data.engine?.ready;
        const keyword = /keyword|fts|none/.test(data.mode || data.engine?.mode || "");
        if (ready === true || keyword) state.embedReadyDeadline = 0;
        delete errors.embed;
        if (render && state.tab === "memory") {
          if (!!wasActive !== !!data.downloadJob?.active || wasWaiting && ready === true) renderEngine();
          else renderDownloadProgress();
        }
        if ((wasActive || wasWaiting) && ready === true && !data.downloadJob?.active && !data.downloadJob?.error) {
          state.modelChoice = "";
          if (state.tab === "memory") renderEngine();
          toast(tr("向量模型已就绪", "Vector model is ready"));
        }
        if (state.embedReadyDeadline && Date.now() > state.embedReadyDeadline) {
          state.embedReadyDeadline = 0;
          toast(tr("模型尚未就绪，请刷新状态后重试", "The model is not ready yet. Refresh its status to retry."), true);
        }
      } catch (error) {
        if (!disposed && version === embedVersion) { errors.embed = error; if (render && state.tab === "memory") toast(errorText(error), true); }
      }
    }
    function scheduleEmbedPoll() {
      cancelTimer(embedTimer);
      embedTimer = null;
      if (!disposed && state.open && state.tab === "memory" && (cache.embed?.downloadJob?.active || state.embedReadyDeadline)) embedTimer = later(pollEmbed, 1000);
    }
    async function pollEmbed() {
      if (disposed || !state.open || state.tab !== "memory" || document.hidden) return;
      await refreshEmbed(true, true);
      scheduleEmbedPoll();
    }
    async function refresh() {
      if (state.refreshing) return;
      state.refreshing = true;
      renderChrome();
      try { await refreshContext(true); }
      finally { if (!disposed) { state.refreshing = false; renderChrome(); } }
    }
    function setOpen(open, focus = true) {
      state.open = !!open;
      if (!root || disposed) return;
      if (state.open && focus) focusReturn = document.activeElement;
      root.classList.toggle("is-open", state.open);
      handle.setAttribute("aria-expanded", String(state.open));
      drawer.setAttribute("aria-hidden", String(!state.open));
      drawer.inert = !state.open;
      if (state.open) {
        renderTab();
        if (state.context) { loadTab(); primeCatalogs(); }
        else if (state.contextError) content.innerHTML = inlineError(state.contextError);
        if (focus) later(() => root.querySelector(`[data-tab="${state.tab}"]`)?.focus({ preventScroll: true }), 50);
      } else {
        cancelTimer(embedTimer);
        if (focus && focusReturn?.isConnected) focusReturn.focus({ preventScroll: true });
      }
    }
    function switchTab(tab, focus = false) {
      if (!tabKeys.includes(tab)) return;
      state.tab = tab;
      requestVersion++;
      cancelTimer(embedTimer);
      storageSet("t3-hub-tab", tab);
      renderChrome();
      renderTab();
      content.scrollTop = 0;
      loadTab();
      if (focus) root.querySelector(`[data-tab="${tab}"]`)?.focus();
    }
    function syncEnvironment() {
      if (!root || disposed) return;
      const dark = isDark();
      root.classList.toggle("is-dark", dark);
      state.dark = dark;
      const lang = detectLang();
      if (lang !== state.lang) {
        state.lang = lang;
        renderChrome();
        if (state.open) renderTab();
      }
    }
    function syncOcclusion() {
      if (!root || disposed) return;
      const nativeDialog = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog[open]')].some((element) => !root.contains(element) && element.getClientRects().length && getComputedStyle(element).visibility !== "hidden" && getComputedStyle(element).display !== "none");
      root.classList.toggle("is-occluded", nativeDialog);
    }
    function positionHandle() {
      if (!handle) return;
      const saved = Number(storageGet("t3-hub-handle-y"));
      const y = saved > 0 ? saved * innerHeight : innerHeight * .42;
      handle.style.top = `${Math.max(70, Math.min(innerHeight - 70, y))}px`;
    }
    function onDragStart(event) {
      if (event.button !== 0) return;
      drag = { pointerId: event.pointerId, startY: event.clientY, top: handle.getBoundingClientRect().top + handle.offsetHeight / 2, moved: false };
      handle.setPointerCapture?.(event.pointerId);
    }
    function onDragMove(event) {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const delta = event.clientY - drag.startY;
      if (Math.abs(delta) > 4) drag.moved = true;
      if (drag.moved) { event.preventDefault(); handle.style.top = `${Math.max(70, Math.min(innerHeight - 70, drag.top + delta))}px`; }
    }
    function onDragEnd(event) {
      if (!drag || drag.pointerId !== event.pointerId) return;
      suppressClick = drag.moved;
      if (drag.moved) storageSet("t3-hub-handle-y", parseFloat(handle.style.top) / innerHeight);
      handle.releasePointerCapture?.(event.pointerId);
      drag = null;
      if (suppressClick) later(() => { suppressClick = false; }, 80);
    }
    function onDragCancel() { drag = null; suppressClick = false; }

    function onClick(event) {
      const target = event.target.closest("[data-action],#t3-hub-handle");
      if (!target || !root.contains(target) || target.disabled) return;
      if (target === handle) { if (!suppressClick) setOpen(!state.open); return; }
      const action = target.dataset.action;
      const id = target.dataset.id;
      if (action === "close") setOpen(false);
      else if (action === "tab") switchTab(target.dataset.tab);
      else if (action === "refresh") refresh();
      else if (action === "install-plugin-form") { state.pluginInstallOpen = !state.pluginInstallOpen; renderPlugins(); content.querySelector('[name="pluginInput"]')?.focus(); }
      else if (action === "install-plugin") installPlugin(target);
      else if (action === "plugin-scope") setDomainScope("plugins", id, target.dataset.scope, target);
      else if (action === "hook-scope") setDomainScope("hooks", id, target.dataset.scope, target);
      else if (action === "new-hook") { state.hookDraft ||= { title: "", event: "Stop", matcher: "", command: "", scope: defaultScope() }; renderHooks(); content.querySelector('[name="hook-title"]')?.focus(); }
      else if (action === "cancel-hook") { state.hookDraft = null; renderHooks(); }
      else if (action === "save-hook") saveHook(target);
      else if (action === "delete-hook") target.closest(".hub-hook-card").querySelector("[data-hook-confirm]").hidden = false;
      else if (action === "cancel-delete-hook") target.closest("[data-hook-confirm]").hidden = true;
      else if (action === "confirm-delete-hook") deleteHook(id, target);
      else if (action === "remove-skill") target.closest(".hub-card").querySelector("[data-skill-confirm]").hidden = false;
      else if (action === "cancel-remove-skill") target.closest("[data-skill-confirm]").hidden = true;
      else if (action === "confirm-remove-skill") removeSkill(id, target);
      else if (action === "toggle-mcp") setMcpMode(target.dataset.name, target.dataset.mode === "off" ? `${defaultScope()}-lazy` : "off", target);
      else if (action === "probe-mcp") probeMcp(target);
      else if (action === "remove-mcp") target.closest(".hub-mcp-row").querySelector("[data-mcp-confirm]").hidden = false;
      else if (action === "cancel-remove-mcp") target.closest("[data-mcp-confirm]").hidden = true;
      else if (action === "confirm-remove-mcp") removeMcp(target.dataset.name, target);
      else if (action === "memory-history") { const key = memoryDraftKey(id); state.historyExpanded[key] = !state.historyExpanded[key]; renderMemoryList(); }
      else if (action === "rollback-memory") rollbackMemory(id, Number(target.dataset.version), target.dataset.revisionId, target);
      else if (action === "consolidate-memory") consolidateMemory(target);
      else if (action === "skill-filter") { state.skillFilter = target.dataset.filter; renderSkillList(); }
      else if (action === "import-skill") runImport(target);
      else if (action === "skill-scope") setSkillScope(id, target.dataset.scope, target);
      else if (action === "update-skill") updateSkill(id, target);
      else if (action === "subagent-scope") { state.subagentScope = target.dataset.scope; renderSubagents(); renderChrome(); }
      else if (action === "new-subagent") newSubagent();
      else if (action === "cancel-new-subagent") { delete state.subagentDrafts[subagentKey("__new__")]; renderSubagents(); }
      else if (action === "expand-subagent") {
        const key = subagentKey(id), expanded = !state.subagentExpanded[key];
        state.subagentExpanded[key] = expanded;
        const card = target.closest("[data-subagent-card]");
        const panel = card.querySelector(".hub-subagent-expand");
        if (expanded) panel.firstElementChild.innerHTML = renderSubagentEditor(subagentDraft(id), id);
        panel.inert = !expanded;
        panel.classList.toggle("is-expanded", expanded);
        card.querySelectorAll('[data-action="expand-subagent"]').forEach((node) => node.setAttribute("aria-expanded", String(expanded)));
        card.querySelector(".hub-subagent-edit").innerHTML = `${icon("edit", 11)}${esc(expanded ? tr("收起设置", "Close settings") : tr("编辑提示词 / 设置", "Prompt / settings"))}`;
      }
      else if (action === "save-subagent") persistSubagent(id);
      else if (action === "clone-subagent") cloneSubagent(id, target);
      else if (action === "delete-subagent") target.closest(".hub-subagent-editor").querySelector("[data-subagent-delete-confirm]").hidden = false;
      else if (action === "cancel-delete-subagent") target.closest("[data-subagent-delete-confirm]").hidden = true;
      else if (action === "confirm-delete-subagent") deleteSubagent(id, target);
      else if (action === "save-subagent-model") {
        const value = state.subagentCustom[subagentKey(id)]?.value?.trim();
        if (value) { if (id === "__new__") { state.subagentDrafts[subagentKey(id)].model = value; delete state.subagentCustom[subagentKey(id)]; renderSubagents(); } else persistSubagent(id, { model: value }); }
        else toast(tr("请填写模型 ID", "Enter a model ID"), true);
      }
      else if (action === "cancel-subagent-model") { delete state.subagentCustom[subagentKey(id)]; renderSubagents(); }
      else if (action === "slash-select") selectSlash(Number(target.dataset.index));
      else if (action === "slash-edit") editSlashSubagent(Number(target.dataset.index));
      else if (action === "toggle-mcp-add") { state.mcpAddOpen = !state.mcpAddOpen; target.setAttribute("aria-expanded", String(state.mcpAddOpen)); renderMcpForm(); }
      else if (action === "mcp-form-kind") { state.mcpForm.kind = target.dataset.kind; renderMcpForm(); }
      else if (action === "save-mcp") saveMcp(target);
      else if (action === "sync-mcp") busy("sync-mcp", target, async () => { const result = await request("mcp:syncClis", { projectRoot: state.projectRoot }); if (!disposed) toast(tr(`路由已同步${result.syncedTargets?.length ? ` · ${result.syncedTargets.length} 端` : ""}`, "CLI router synchronized")); });
      else if (action === "switch-embed") switchEmbed(target);
      else if (action === "refresh-embed") { refreshEmbed(true, true).then(() => { if (!disposed) renderEngine(); }); }
      else if (action === "memory-module") { state.memoryModule = target.dataset.module; state.selectedMemory = null; cache.memory = null; renderMemoryList(); loadMemories(); }
      else if (action === "refresh-memory") loadMemories();
      else if (action === "open-memory") { state.selectedMemory = state.selectedMemory === id ? null : id; renderMemoryList(); }
      else if (action === "new-memory") openNewMemory();
      else if (action === "cancel-new-memory") { if (drafts.__new) drafts.__new.open = false; renderNewMemory(); }
      else if (action === "create-memory") saveMemory(null, target);
      else if (action === "save-memory") saveMemory(id, target);
      else if (action === "pin-memory") busy(`pin:${id}`, target, async () => { const result = await request("memory:pinToAgentsMd", { id, projectRoot: selectedMemoryRoot() }); if (!disposed) { cache.agents = null; toast(result.message || tr("已置顶到项目 AGENTS.md", "Pinned to project AGENTS.md")); } });
      else if (action === "delete-memory") target.closest(".hub-memory-detail").querySelector("[data-delete-confirm]").hidden = false;
      else if (action === "cancel-delete-memory") target.closest("[data-delete-confirm]").hidden = true;
      else if (action === "confirm-delete-memory") deleteMemory(id, target);
      else if (action === "agents-target") { state.agentsTarget = target.dataset.target; renderAgents(); }
      else if (action === "save-agents") saveAgents(target);
      else if (action === "inject-soft-route") injectSoftRoute(target);
    }
    function onInput(event) {
      const input = event.target;
      const name = input.name;
      if (name?.startsWith("subagent-")) {
        const id = input.dataset.subagentId, key = subagentKey(id), field = name.slice(9);
        if (field === "customModel") { if (state.subagentCustom[key]) state.subagentCustom[key].value = input.value; }
        else if (["id", "toolBadge", "description", "systemPrompt"].includes(field)) { const draft = subagentDraft(id); if (draft) { draft[field] = input.value; if (field === "id") draft.name = input.value; } }
        return;
      }
      if (name === "pluginQuery") { state.pluginQuery = input.value; renderPluginList(); }
      else if (name === "pluginInput") state.pluginInput = input.value;
      else if (name === "mcpQuery") { state.mcpQuery = input.value; renderMcpList(); }
      else if (name?.startsWith("hook-") && state.hookDraft) state.hookDraft[name.slice(5)] = input.value;
      else if (name === "skillQuery") { state.skillQuery = input.value; renderSkillList(); }
      else if (name === "repoInput") state.importRepo = input.value;
      else if (name === "customModel") state.customModel = input.value;
      else if (name === "memoryQuery") {
        state.memoryQuery = input.value;
        cancelTimer(searchTimer);
        memoryVersion++;
        searchTimer = later(() => { cache.memory = null; renderMemoryList(); loadMemories(); }, 220);
      } else if (name === "memory-content" || name === "memory-title") {
        const id = input.dataset.id;
        const record = memoryRecords().find((item) => memoryId(item) === id);
        const key = memoryDraftKey(id);
        drafts[key] ||= { title: record?.title || record?.name || "", content: memoryBody(record || {}) };
        drafts[key][name === "memory-title" ? "title" : "content"] = input.value;
      } else if (name?.startsWith("new-memory-")) { drafts.__new ||= {}; drafts.__new[name.slice(11)] = input.value; }
      else if (name === "agents-content") { const draft = agentDraft(); if (draft) { draft.content = input.value; updateAgentCounter(); } }
      else if (name?.startsWith("mcp-")) state.mcpForm[name.slice(4)] = input.value;
    }
    function onChange(event) {
      const input = event.target;
      const name = input.name;
      if (name?.startsWith("subagent-")) {
        const id = input.dataset.subagentId, key = subagentKey(id), draft = subagentDraft(id), field = name.slice(9);
        if (!draft || subagentSaves.has(key)) return;
        if (["role", "enabled"].includes(field)) { draft[field] = field === "enabled" ? input.checked : input.value; return; }
        if (field === "model" && input.value === "__custom__") {
          state.subagentCustom[key] = { value: draft.model || "" };
          if (id === "__new__") state.subagentExpanded[key] = true;
          renderSubagents();
          const customInput = [...content.querySelectorAll('[name="subagent-customModel"]')].find((node) => node.dataset.subagentId === id);
          customInput?.focus(); customInput?.select();
          return;
        }
        greetBots(id);
        const patch = field === "memoryPolicy" ? { memoryPolicy: input.value } : field === "provider" ? { providerInstanceId: input.value } : field === "model" ? { model: input.value } : field === "effort" ? { effort: input.value } : null;
        if (!patch) return;
        if (field === "provider") {
          const models = providerModels(input.value), efforts = providerEfforts(input.value);
          if (models.length && !models.some((entry) => entry.id === draft.model)) patch.model = models[0].id;
          if (!efforts.includes(draft.effort)) patch.effort = efforts[0] || "max";
        }
        if (id === "__new__") { Object.assign(draft, patch); renderSubagents(); }
        else persistSubagent(id, patch);
        return;
      }
      if (name === "hub-scope") setScope(input.value);
      else if (name?.startsWith("hook-") && state.hookDraft) state.hookDraft[name.slice(5)] = input.value;
      else if (name === "new-memory-supersedes") { drafts.__new ||= {}; drafts.__new.supersedes = input.value; }
      else if (name === "importScope") state.importScope = input.value;
      else if (name === "mcp-mode") setMcpMode(input.dataset.name, input.value, input);
      else if (name === "mcp-transport") { state.mcpForm.transport = input.value; renderMcpForm(); }
      else if (name === "embed-model") { state.modelChoice = input.value; renderEngine(); }
      else if (name === "useMirror") state.useMirror = input.checked;
      else if (name === "memoryProject") {
        state.memoryProject = input.value;
        if (drafts.__new) drafts.__new.supersedes = "";
        state.supersedeItems = [];
        state.supersedeLoading = false;
        renderNewMemory();
        state.selectedMemory = null;
        cache.memory = null;
        memoryVersion++;
        renderMemoryList();
        loadMemories();
        if (drafts.__new?.open) openNewMemory();
      } else if (name === "new-memory-module") { drafts.__new ||= {}; drafts.__new.module = input.value; }
    }
    function onKeydown(event) {
      const key = event.key.toLowerCase();
      if (((event.metaKey || event.ctrlKey) && event.shiftKey && key === "k") || (event.altKey && !event.metaKey && !event.ctrlKey && key === "h")) {
        if (event.repeat) return;
        event.preventDefault();
        setOpen(!state.open);
      } else if (key === "escape" && state.open && !root.classList.contains("is-occluded")) { event.preventDefault(); setOpen(false); }
      else if ((event.metaKey || event.ctrlKey) && key === "s" && state.open && state.tab === "agents" && root.contains(document.activeElement)) { event.preventDefault(); saveAgents(root.querySelector('[data-action="save-agents"]')); }
    }
    function onEditorKeydown(event) {
      const input = event.target;
      if (input.getAttribute("role") === "tab" && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const tabs = tabKeys;
        const index = tabs.indexOf(state.tab);
        const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length;
        switchTab(tabs[next], true);
        return;
      }
      if (input.tagName !== "TEXTAREA" || event.key !== "Tab" || event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      const start = input.selectionStart;
      const end = input.selectionEnd;
      const value = input.value;
      if (!event.shiftKey && start === end) { input.setRangeText("  ", start, end, "end"); }
      else {
        const lineStart = value.lastIndexOf("\n", start - 1) + 1;
        const selected = value.slice(lineStart, end);
        const lines = selected.split("\n");
        const transformed = lines.map((line) => event.shiftKey ? line.replace(/^( {1,2}|\t)/, "") : `  ${line}`).join("\n");
        input.setRangeText(transformed, lineStart, end, "select");
        if (start === end) input.setSelectionRange(Math.max(lineStart, start + transformed.length - selected.length), Math.max(lineStart, start + transformed.length - selected.length));
      }
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }

    async function installPlugin(element = content.querySelector('[data-action="install-plugin"]')) {
      const input = state.pluginInput.trim(), scope = defaultScope(), projectRoot = state.projectRoot;
      if (!input) { toast(tr("请填写 GitHub 仓库或市场标识", "Enter a GitHub repository or marketplace ID"), true); return; }
      await busy("install-plugin", element, async () => {
        await request("plugins:installGitHub", { input, scope, projectRoot });
        if (disposed || projectRoot !== state.projectRoot) return;
        state.pluginInput = ""; state.pluginInstallOpen = false;
        for (const key of ["plugins", "skills", "mcp", "hooks"]) cache[key] = null;
        if (state.tab === "plugins") await loadTab(true);
        primeCatalogs();
        toast(tr("插件已安装，组件能力已同步", "Plugin installed and capabilities synchronized"));
      });
    }
    async function setDomainScope(domain, id, scope, element) {
      const projectRoot = state.projectRoot;
      const item = (domain === "plugins" ? pluginItems() : hookItems()).find((entry) => String(entry.id) === id);
      if (!item || item.readonly || item.unavailable || scope === "project" && !projectRoot) return;
      await busy(`${domain}-scope:${id}`, element, async () => {
        const result = await request(domain === "plugins" ? "plugins:setScope" : "hooks:toggle", { id, scope, projectRoot });
        if (disposed || projectRoot !== state.projectRoot) return;
        const list = items(cache[domain], ["items", domain]);
        const original = list.find((entry) => String(entry.id) === id);
        if (original) Object.assign(original, result.item || {}, { scope });
        if (state.tab === domain) renderTab();
        if (domain === "plugins") { for (const key of ["skills", "mcp", "hooks"]) cache[key] = null; primeCatalogs(); }
        renderChrome();
        toast(tr("启用范围已更新", "Activation scope updated"));
      });
    }
    async function saveHook(element = content.querySelector('[data-action="save-hook"]')) {
      if (state.hookDraft) state.hookDraft.id ||= `hook-${window.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`}`;
      const draft = { ...state.hookDraft }, projectRoot = state.projectRoot;
      if (!draft.command?.trim() || !draft.title?.trim()) { toast(tr("请填写名称和执行命令", "Enter a name and command"), true); return; }
      if (draft.scope === "project" && !projectRoot) return;
      await busy("save-hook", element, async () => {
        await request("hooks:save", { ...draft, projectRoot });
        if (disposed || projectRoot !== state.projectRoot) return;
        state.hookDraft = null; cache.hooks = null;
        if (state.tab === "hooks") await loadTab(true);
        toast(tr("自定义 Hook 已保存", "Custom hook saved"));
      });
    }
    async function deleteHook(id, element) {
      const projectRoot = state.projectRoot, item = hookItems().find((entry) => String(entry.id) === id);
      if (!item || item.builtin || item.readonly) return;
      await busy(`delete-hook:${id}`, element, async () => {
        await request("hooks:delete", { id, projectRoot });
        if (disposed || projectRoot !== state.projectRoot) return;
        cache.hooks = null;
        if (state.tab === "hooks") await loadTab(true);
        toast(tr("自定义 Hook 已删除", "Custom hook deleted"));
      });
    }
    function skillPackageId(id) {
      const item = items(cache.skills, ["items", "skills"]).find((entry) => String(entry.id) === id);
      const fromUrl = item?.repoUrl?.match(/github\.com[/:]([^/]+\/[^/#?]+)/i)?.[1]?.replace(/\.git$/, "");
      return item?.packageId || item?.package || fromUrl || id;
    }
    async function removeSkill(id, element) {
      const projectRoot = state.projectRoot;
      await busy(`remove-skill:${id}`, element, async () => {
        await request("skills:removePackage", { id: skillPackageId(id), projectRoot });
        if (disposed || projectRoot !== state.projectRoot) return;
        cache.skills = null;
        if (state.tab === "skills") await loadTab(true);
        toast(tr("技能包已移除", "Skill package removed"));
      });
    }
    async function probeMcp(element) {
      const projectRoot = state.projectRoot;
      await busy("probe-mcp", element, async () => {
        const result = await request("mcp:probe", { all: true, projectRoot });
        if (disposed || projectRoot !== state.projectRoot) return;
        const results = items(result, ["items", "servers", "results"]);
        if (!results.length && result.results && typeof result.results === "object" && !Array.isArray(result.results)) results.push(...Object.entries(result.results).map(([name, status]) => ({ name, ...status })));
        if (results.length) cache.mcp = { ...cache.mcp, items: mcpServers().map((server) => ({ ...server, ...results.find((entry) => entry.name === server.name) })) };
        else {
          const data = await request("mcp:list", { projectRoot });
          if (disposed || projectRoot !== state.projectRoot) return;
          cache.mcp = data;
        }
        if (state.tab === "mcp") renderMcpList();
        renderChrome();
        toast(result.message || tr("连通性检测完成", "Connection probe complete"));
      });
    }
    async function removeMcp(name, element) {
      const projectRoot = state.projectRoot;
      await busy(`remove-mcp:${name}`, element, async () => {
        await request("mcp:remove", { name, projectRoot });
        if (disposed || projectRoot !== state.projectRoot) return;
        cache.mcp = null;
        if (state.tab === "mcp") await loadTab(true);
        toast(tr("自定义 MCP 已移除", "Custom MCP removed"));
      });
    }
    function memorySelection() { const payload = memoryPayload(); return JSON.stringify([state.memoryProject, payload.projectRoot, payload.projectSlug]); }
    async function consolidateMemory(element) {
      const projectRoot = selectedMemoryRoot(), selection = memorySelection();
      if (!projectRoot) return;
      await busy(`consolidate:${projectRoot}`, element, async () => {
        const result = await request("memory:consolidate", { projectRoot, dryRun: false });
        if (disposed || selection !== memorySelection()) return;
        const stats = result.stats || result.summary || result;
        const merged = stats.mergedCount ?? stats.merged ?? stats.duplicatesMerged ?? stats.duplicates;
        const outdated = stats.outdatedCount ?? stats.outdated ?? stats.supersededCount;
        const count = (value) => Array.isArray(value) ? value.length : typeof value === "number" ? value : null;
        const detail = [count(merged) == null ? "" : tr(`合并重复 ${count(merged)} 条`, `${count(merged)} duplicates merged`), count(outdated) == null ? "" : tr(`整理过时 ${count(outdated)} 条`, `${count(outdated)} outdated memories updated`)].filter(Boolean).join(" · ");
        if (state.tab === "memory") { await refreshMemoryOverview(); await loadMemories(); }
        renderChrome();
        toast(detail || result.message || tr("再记忆整理完成，历史版本已保留", "Consolidation complete; version history preserved"));
      });
    }
    async function rollbackMemory(id, targetVersion, revisionId, element) {
      if (!Number.isInteger(targetVersion) || targetVersion < 1) return;
      const selection = memorySelection(), projectRoot = selectedMemoryRoot(), key = memoryDraftKey(id);
      if (drafts[key]) { toast(tr("请先保存这条记忆的修改，再回滚", "Save your memory edits before restoring a version"), true); return; }
      await busy(`rollback:${id}`, element, async () => {
        await request("memory:rollback", { projectRoot, id, targetVersion, revisionId: revisionId || undefined });
        if (disposed || selection !== memorySelection()) return;
        if (state.tab === "memory") { await refreshMemoryOverview(); await loadMemories(); }
        renderChrome();
        toast(tr(`已回滚到 v${targetVersion}，演进历史已保留`, `Restored v${targetVersion}; history preserved`));
      });
    }

    async function runImport(element = root?.querySelector('[data-action="import-skill"]')) {
      const repoInput = state.importRepo.trim();
      if (!repoInput) { toast(tr("请填写 GitHub 仓库地址", "Enter a GitHub repository"), true); return; }
      const scope = state.importScope;
      const projectRoot = state.projectRoot;
      if (scope === "project" && !projectRoot) { toast(projectTitle(), true); return; }
      await busy("import", element, async () => {
        const result = await request("skills:importGitHub", { repoInput, scope, projectRoot });
        if (disposed) return;
        state.importRepo = "";
        cache.skills = null;
        toast(result.message || tr("导入完成，技能已按范围启用", "Imported and enabled for the selected scope"));
        if (state.tab === "skills") { renderSkills(); await loadTab(true); }
      });
    }
    async function setSkillScope(id, scope, element) {
      const projectRoot = state.projectRoot;
      if (scope === "project" && !projectRoot) return;
      await busy(`scope:${id}`, element, async () => {
        const result = await request("skills:setScope", { id, scope, projectRoot });
        if (disposed || projectRoot !== state.projectRoot) return;
        const item = items(cache.skills, ["items", "skills", "plugins"]).find((entry) => String(entry.id) === id);
        if (item) Object.assign(item, result.item || {}, { scope });
        renderSkillList(); renderChrome();
        toast(tr("启用范围已更新", "Activation scope updated"));
      });
    }
    async function updateSkill(id, element) {
      await busy(`update:${id}`, element, async () => {
        await request("skills:updatePackage", { id: skillPackageId(id), projectRoot: state.projectRoot });
        if (!disposed) { toast(tr("已检查并更新技能", "Skill checked and updated")); cache.skills = null; if (state.tab === "skills") await loadTab(true); }
      });
    }
    async function setMcpMode(name, mode, element) {
      const projectRoot = state.projectRoot;
      if (mode.startsWith("project-") && !projectRoot) return;
      const old = mcpServers().find((server) => server.name === name)?.mode || "off";
      await busy(`mode:${name}`, element, async () => {
        try {
          await request("mcp:setMode", { name, mode, projectRoot });
          if (disposed || state.projectRoot !== projectRoot) return;
          const server = mcpServers().find((entry) => entry.name === name);
          if (server) {
            const all = mcpServers().map((entry) => entry.name === name ? { ...entry, mode } : entry);
            cache.mcp = { ...cache.mcp, items: all };
          }
          state.freshModes[name] = true;
          renderMcpList(); renderChrome();
          toast(tr("免重启已生效", "Applied without restarting"));
        } catch (error) { if (element?.isConnected) element.value = old; throw error; }
      });
    }
    async function saveMcp(element) {
      const form = { ...state.mcpForm };
      await busy("save-mcp", element, async () => {
        let payload;
        if (form.kind === "json") {
          const parsed = JSON.parse(form.json);
          const servers = parsed.mcpServers || parsed;
          if (!servers || Array.isArray(servers) || typeof servers !== "object" || !Object.keys(servers).length) throw new Error(tr("请粘贴有效的 mcpServers JSON", "Paste a valid mcpServers JSON object"));
          payload = { jsonRaw: JSON.stringify({ mcpServers: servers }) };
        } else {
          if (!form.name.trim()) throw new Error(tr("请填写服务名称", "Enter a server name"));
          if (form.transport === "http") {
            if (!/^https?:\/\//i.test(form.url.trim())) throw new Error(tr("URL 需要以 http:// 或 https:// 开头", "Use an http:// or https:// URL"));
            payload = { name: form.name.trim(), transport: "http", url: form.url.trim() };
          } else {
            if (!form.command.trim()) throw new Error(tr("请填写启动命令", "Enter a command"));
            const args = form.args.trim().startsWith("[") ? JSON.parse(form.args) : form.args.split("\n").map((arg) => arg.trim()).filter(Boolean);
            if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) throw new Error(tr("参数必须是字符串数组", "Arguments must be an array of strings"));
            payload = { name: form.name.trim(), transport: "stdio", command: form.command.trim(), args };
          }
        }
        await request("mcp:upsert", { ...payload, projectRoot: state.projectRoot });
        if (!disposed) { state.mcpAddOpen = false; state.mcpForm = { kind: "form", name: "", transport: "stdio", command: "", args: "", url: "", json: "" }; cache.mcp = null; toast(tr("自定义 MCP 已添加", "Custom MCP added")); if (state.tab === "mcp") await loadTab(true); }
      });
    }
    async function switchEmbed(element) {
      const modelId = state.modelChoice === "custom" ? state.customModel.trim() : state.modelChoice;
      if (!modelId) { toast(tr("请填写模型 ID 或本地路径", "Enter a model ID or local path"), true); return; }
      await busy("embed-switch", element, async () => {
        const result = await request("embed:switch", { mode: modelId === "keyword" ? "fts5" : "mlx", modelId: modelId === "keyword" ? "fts5-zero-ram" : modelId, useMirror: state.useMirror });
        if (disposed) return;
        state.embedReadyDeadline = modelId === "keyword" ? 0 : Date.now() + 60000;
        if (result.downloadJob || result.mode) cache.embed = { ...cache.embed, ...result };
        await refreshEmbed(false, true);
        if (disposed) return;
        if (state.tab === "memory") renderEngine();
        scheduleEmbedPoll();
        toast(cache.embed?.downloadJob?.active ? tr("已开始下载，可继续浏览记忆", "Download started. Keep browsing your memories.") : tr("记忆引擎已切换", "Memory engine switched"));
      });
    }
    async function saveMemory(id, element) {
      const payload = memoryPayload();
      const selection = JSON.stringify([state.memoryProject, payload.projectRoot, payload.projectSlug]);
      const record = memoryRecords().find((item) => memoryId(item) === id);
      const draft = id == null ? { ...drafts.__new } : { title: record?.title || record?.name || "", content: memoryBody(record || {}), ...drafts[memoryDraftKey(id)] };
      if (!draft.title?.trim() || !draft.content?.trim()) { toast(tr("请填写标题和记忆内容", "Enter a title and memory content"), true); return; }
      const key = id == null ? null : memoryDraftKey(id);
      await busy(`memory-save:${id || "new"}`, element, async () => {
        const result = await request("memory:save", { ...payload, id: id || undefined, title: draft.title.trim(), content: draft.content, module: draft.module || record?.module || record?.category || "topics", ...(id == null && draft.supersedes ? { supersedesId: draft.supersedes } : {}) });
        if (disposed) return;
        if (id == null) delete drafts.__new;
        else if (drafts[key]?.content === draft.content) delete drafts[key];
        const now = memoryPayload();
        if (selection === JSON.stringify([state.memoryProject, now.projectRoot, now.projectSlug])) {
          state.selectedMemory = result.item?.id || result.memory?.id || result.id || id;
          if (state.tab === "memory") { renderNewMemory(); await refreshMemoryOverview(); await loadMemories(); }
        }
        toast(tr("记忆已保存", "Memory saved"));
      });
    }
    async function deleteMemory(id, element) {
      const payload = memoryPayload();
      const key = memoryDraftKey(id);
      await busy(`memory-delete:${id}`, element, async () => {
        await request("memory:delete", { id, projectRoot: payload.projectRoot, scope: payload.scope });
        if (!disposed) { delete drafts[key]; if (state.selectedMemory === id) state.selectedMemory = null; if (state.tab === "memory") { await refreshMemoryOverview(); await loadMemories(); } toast(tr("记忆已删除", "Memory deleted")); }
      });
    }
    async function refreshMemoryOverview() {
      const projectRoot = state.projectRoot;
      try {
        const data = await request("memory:overview", { projectRoot });
        if (!disposed && state.projectRoot === projectRoot) { cache.overview = data; delete errors.overview; if (state.tab === "memory") renderMemoryNav(); }
      } catch (error) { if (!disposed && state.projectRoot === projectRoot) { errors.overview = error; if (state.tab === "memory") renderMemoryNav(); } }
    }
    async function saveAgents(element) {
      const draft = agentDraft();
      if (!draft || (state.agentsTarget === "project" && !state.projectRoot)) return;
      const key = agentKey();
      const target = state.agentsTarget;
      const projectRoot = state.projectRoot;
      const value = draft.content;
      await busy(`agents-save:${key}`, element, async () => {
        const result = await request("agentsMd:save", { target, content: value, projectRoot });
        if (disposed) return;
        draft.saved = value;
        draft.syncedTargets = result.syncedTargets || result.syncedClis || [];
        if (key === agentKey() && state.tab === "agents") { updateAgentCounter(); renderSyncBadges(); }
        toast(tr("已保存并同步", "Saved and synchronized"));
      });
    }
    async function injectSoftRoute(element) {
      const projectRoot = state.projectRoot;
      if (!projectRoot) return;
      const draft = agentDraft();
      if (draft && draft.content !== draft.saved) { toast(tr("请先保存当前修改，再注入模板", "Save your edits before inserting the template"), true); return; }
      await busy("inject-route", element, async () => {
        const result = await request("agentsMd:injectSoftRoute", { projectRoot });
        if (disposed) return;
        const key = `project:${projectRoot}`;
        if (typeof result.content === "string") {
          const latest = state.agentDrafts[key];
          state.agentDrafts[key] = { content: latest && latest.content !== latest.saved ? latest.content : result.content, saved: result.content, syncedTargets: ["project"] };
        }
        else { cache.agents = null; if (state.tab === "agents") await loadTab(true); }
        if (projectRoot === state.projectRoot && state.tab === "agents") renderAgents();
        toast(tr("记忆库软路由已写入", "Memory routing template inserted"));
      });
    }

    const api = {
      options: opts,
      open: () => setOpen(true),
      close: () => setOpen(false),
      toggle: () => setOpen(!state.open),
      refresh,
      snapshot: () => ({ scope: state.scope, pluginQuery: state.pluginQuery, pluginInput: state.pluginInput, historyExpanded: state.historyExpanded, open: state.open, tab: state.tab, skillQuery: state.skillQuery, skillFilter: state.skillFilter, importRepo: state.importRepo, memoryProject: state.memoryProject, memoryModule: state.memoryModule, memoryQuery: state.memoryQuery, selectedMemory: state.selectedMemory, agentsTarget: state.agentsTarget, agentDrafts: state.agentDrafts, subagentScope: state.subagentScope, subagentDrafts: state.subagentDrafts, subagentExpanded: state.subagentExpanded, subagentCustom: state.subagentCustom, drafts }),
      destroy: () => {
        if (disposed) return;
        closeSlash();
        slashCache.clear();
        disposed = true;
        contextVersion++; requestVersion++; memoryVersion++; embedVersion++;
        clearInterval(routeTimer);
        timers.forEach(clearTimeout);
        timers.clear();
        observer?.disconnect();
        try { unsubscribeRouter?.(); } catch {}
        unsubscribeRouter = null;
        cachedRouter = null;
        disposers.splice(0).forEach((dispose) => { try { dispose(); } catch {} });
        root?.remove(); style?.remove();
        if (window.__t3SidecarHub === api) delete window.__t3SidecarHub;
        if (window.__t3SidecarHubCleanup === api.destroy) delete window.__t3SidecarHubCleanup;
      },
    };
    window.__t3SidecarHub = api;
    window.__t3SidecarHubCleanup = api.destroy;
    if (document.body) build();
    else listen(document, "DOMContentLoaded", build, { once: true });
    return api;
  };

  if (!window.__t3HubDrawerLoading && (typeof window.__t3HubRpc === "function" || window.__t3HudBridge)) {
    window.__t3MountSidecarHub(previousOptions);
  }
})();
