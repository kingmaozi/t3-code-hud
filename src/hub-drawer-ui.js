(() => {
  "use strict";

  window.__t3HubDrawerEmbedded = true;
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
    const inFlightNativeSaves = new Map();
    let disposed = false;
    let routeTimer = null;
    let embedTimer = null;
    let searchTimer = null;
    let toastTimer = null;
    let observer = null;
    let anchorCache = null, anchorRoute = "", anchorScanAt = 0, anchorResize = null, updateFrame = 0;
    let root, drawer, content, handle, style, palette, liveBoard;
    let boardTimer = null;
    let boardLoading = false;
    let boardVersion = 0;
    let resizeDrag = null;
    let lastComposer = null;
    let boardSignature = "";
    let focusReturn = null;
    let requestVersion = 0;
    let contextVersion = 0;
    let memoryVersion = 0;
    let embedVersion = 0;
    let settingsVersion = 0;
    let settingsSelectionVersion = 0;
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
    const tabKeys = ["memory", "skills", "subagents", "settings", "board"];
    const cache = { hooks: null, skills: null, subagents: null, orchestration: null, mcp: null, overview: null, memory: null, worktree: null, dream: null, health: null, embed: null, agents: null, board: null, settings: null, settingsRule: null };
    const errors = {};
    const drafts = initial?.drafts || {};
    const state = {
      open: initial?.open ?? false,
      tab: initial?.tab || storageGet("t3-hub-tab") || "memory",
      width: Number(initial?.width || storageGet("t3-hub-width")) || 880,
      resourceFilters: initial?.resourceFilters || {},
      memoryScope: initial?.memoryScope || "smart",
      boardExpanded: initial?.boardExpanded ?? storageGet("t3-hub-board-expanded") === "true",
      boardBackground: initial?.boardBackground || false, artifact: null, boardDraft: initial?.boardDraft || "",
      orchestrationDraft: initial?.orchestrationDraft || null,
      dreamSaving: false, dreamRunning: false, memoryImporting: false, embedTrimming: false,
      settingsHost: initial?.settingsHost || "codex", settingsRule: initial?.settingsRule || "", settingsRuleDirty: initial?.settingsRuleDirty || false,
      settingsDraft: initial?.settingsDraft && typeof initial.settingsDraft === "object" && !Array.isArray(initial.settingsDraft) ? initial.settingsDraft : {}, settingsDirty: initial?.settingsDirty || false,
      clearedHostFields: new Set(Array.isArray(initial?.clearedHostFields) ? initial.clearedHostFields : []),
      scope: initial?.scope || storageGet("t3-hub-scope") || "global",
      libraryView: "skills", hooksOpen: false, dreamOpen: false,
      mcpQuery: "", hookDraft: null, historyExpanded: initial?.historyExpanded || {},
      supersedeItems: [], supersedeLoading: false,
      lang: "zh", theme: storageGet("t3-hub-theme") || "white", dark: false, context: null, connected: false, threadId: null,
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
    if (!tabKeys.includes(state.tab)) state.tab = "memory";
    if (!["global", "project"].includes(state.scope)) state.scope = "global";

    async function hubRpc(action, payload = {}) {
      let result;
      if (typeof opts?.hubRpc === "function") result = await opts.hubRpc(action, payload);
      else if (typeof window.__t3HubRpc === "function") result = await window.__t3HubRpc(action, payload);
      else if (typeof window.__t3HudBridge?.getGitGraph === "function") result = await window.__t3HudBridge.getGitGraph("__HUB_RPC__", action, payload);
      else throw new Error(tr("Hub 连接暂不可用", "Hub connection is unavailable"));
      if (result?.ok !== false && result?.success !== false && ["skills:setScope", "skills:importGitHub", "skills:updatePackage", "skills:removePackage", "skills:toggleAgent", "subagents:update", "subagents:save", "subagents:delete"].includes(action)) invalidateSlashCache();
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
      moon: '<path d="M20.8 13.2A8.8 8.8 0 0 1 10.8 3a9 9 0 1 0 10 10.2Z"/>',
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
      const zh = ["想问什么", "本地工作副本", "新会话", "设置", "累计缓存", "本轮缓存", "图谱"];
      const en = ["Ask anything", "Local working copy", "New thread", "Settings"];
      const score = (markers) => markers.filter((m) => hostText.includes(m)).length + 2 * markers.filter((m) => placeholder.includes(m)).length;
      return score(en) > score(zh) ? "en" : "zh";
    }
    const hubThemes = {
      white: { label: "纯白", en: "White", bg: "#ffffff", subtle: "#f8fafc", border: "#e2e8f0", ink: "#0f172a", secondary: "#475569", accent: "#2563eb", swatch: "#ffffff" },
      dark: { label: "深黑", en: "Dark", bg: "#14161a", subtle: "#1e2128", border: "#2e333d", ink: "#f8fafc", secondary: "#94a3b8", accent: "#60a5fa", swatch: "#14161a" },
      sky: { label: "晴空蓝", en: "Sky", bg: "#f4f9ff", subtle: "#eaf3ff", border: "#bfdbfe", ink: "#0c4a6e", secondary: "#0369a1", accent: "#0284c7", swatch: "#38bdf8" },
      emerald: { label: "翡翠绿", en: "Emerald", bg: "#f2fdf7", subtle: "#e6faef", border: "#a7f3d0", ink: "#064e3b", secondary: "#047857", accent: "#059669", swatch: "#34d399" },
      violet: { label: "星云紫", en: "Violet", bg: "#faf7ff", subtle: "#f3e8ff", border: "#ddd6fe", ink: "#3b0764", secondary: "#6d28d9", accent: "#7c3aed", swatch: "#a78bfa" },
    };
    if (!Object.hasOwn(hubThemes, state.theme)) state.theme = "white";
    function isDark() { return state.theme === "dark"; }
    function themeSwitcher() {
      return `<div class="hub-theme-switcher" role="group" aria-label="${esc(tr("外观主题", "Appearance theme"))}">${Object.entries(hubThemes).map(([theme, value]) => `<button type="button" class="hub-theme-dot" data-action="set-theme" data-theme="${theme}" style="--hub-swatch:${value.swatch}" aria-label="${esc(tr(value.label, value.en))}" title="${esc(tr(value.label, value.en))}" aria-pressed="${state.theme === theme}"></button>`).join("")}</div>`;
    }
    function applyTheme(theme = state.theme) {
      state.theme = Object.hasOwn(hubThemes, theme) ? theme : "white";
      state.dark = isDark();
      const value = hubThemes[state.theme];
      for (const node of [root, liveBoard, handle, palette].filter(Boolean)) {
        node.dataset.theme = state.theme;
        node.classList.toggle("is-dark", state.dark);
        const variables = { "hub-bg": value.bg, "hub-bg-subtle": value.subtle, "hub-border": value.border, "hub-ink": value.ink, "hub-secondary": value.secondary, "hub-muted": value.secondary, "hub-active": value.accent, "hub-on-active": state.dark ? "#0f172a" : "#ffffff", "hub-accent": value.accent,
          "hud-bg": value.bg, "hud-bg-solid": value.bg, "hud-fg": value.ink, "hud-muted": value.secondary, "hud-surface": value.subtle, "hud-border": value.border, "hud-hover": state.dark ? "#ffffff0f" : "#0f172a08", "hud-shadow": state.dark ? "0 16px 64px #00000066" : "0 16px 64px #0f172a14,0 2px 8px #0f172a08" };
        for (const [key, color] of Object.entries(variables)) node.style.setProperty(`--${key}`, color);
        node.style.colorScheme = state.dark ? "dark" : "light";
      }
      for (const node of [root, liveBoard].filter(Boolean)) node.querySelectorAll('[data-action="set-theme"]').forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.theme === state.theme)));
    }
    function setTheme(theme) {
      applyTheme(theme);
      storageSet("t3-hub-theme", state.theme);
      window.dispatchEvent(new CustomEvent("t3-hub-theme-change", { detail: { theme: state.theme } }));
    }

    function build() {
      if (disposed) return;
      document.getElementById("t3-sidecar-hub")?.remove();
      document.getElementById("t3-sidecar-hub-root")?.remove();
      document.getElementById("t3-sidecar-hub-styles")?.remove();
      style = document.createElement("style");
      style.id = "t3-sidecar-hub-styles";
      style.textContent = `
        .hub-native-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:0 20px;margin-top:16px}.hub-native-key{display:block;font:10px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--hub-muted);overflow-wrap:anywhere}.hub-native-fields .hub-hint{margin-top:5px}.hub-native-settings .hub-settings-host-description{overflow-wrap:anywhere}
        .hub-native-field-heading{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:4px 8px;min-height:24px}.hub-native-field-heading label{font-weight:550}.hub-native-clear{border:0;border-radius:5px;background:var(--hub-bg-subtle);padding:3px 6px;font-size:9px!important;line-height:1.6;white-space:nowrap}.hub-native-clear:hover{background:var(--hud-hover)}.hub-native-field textarea{resize:vertical;min-height:36px}.hub-native-empty{display:inline-flex;margin-top:5px;padding:2px 6px;border:1px solid var(--hub-border);border-radius:5px;font-size:9px;line-height:1.6;color:var(--hub-secondary);background:var(--hub-bg-subtle)}
        #t3-sidecar-hub-root{--hub-bg:#fff;--hub-bg-subtle:#f7f7f8;--hub-border:#ececec;--hub-ink:#0d0d0d;--hub-secondary:#5d5d5d;--hub-muted:#8e8e93;--hub-active:#0d0d0d;--hub-on-active:#fff;--hud-bg:var(--hub-bg);--hud-bg-solid:var(--hub-bg);--hud-fg:var(--hub-ink);--hud-muted:var(--hub-secondary);--hud-surface:var(--hub-bg-subtle);--hud-border:var(--hub-border);--hud-hover:rgba(0,0,0,.045);--hud-shadow:0 16px 64px #00000014,0 2px 8px #00000008;--hud-emerald:var(--hub-ink);--hud-blue:var(--hub-ink);--hud-violet:var(--hub-ink);--hud-amber:var(--hub-secondary);--hud-red:var(--hub-ink);--hub-accent-bg:var(--hub-bg-subtle);position:fixed;inset:0;z-index:9993;pointer-events:none;color:var(--hub-ink);font:12px/1.6 -apple-system,BlinkMacSystemFont,"Inter Variable","Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased;color-scheme:light}
        #t3-sidecar-hub-root,#t3-sidecar-hub-root *{box-sizing:border-box}#t3-sidecar-hub-root :is(button,input,select,textarea){font:inherit;letter-spacing:inherit;color:inherit}#t3-sidecar-hub-root button{cursor:pointer;-webkit-app-region:no-drag}#t3-sidecar-hub-root button:disabled{opacity:.38;cursor:not-allowed}#t3-sidecar-hub-root :is(button,input,select,textarea):focus-visible{outline:2px solid var(--hub-ink);outline-offset:3px}#t3-sidecar-hub-root svg{flex:none;vertical-align:middle}#t3-sidecar-hub-root [hidden]{display:none!important}
        #t3-hub-handle{position:fixed;right:0;top:42%;transform:translateY(-50%);width:28px;min-height:92px;padding:10px 4px;display:flex;flex-direction:column;align-items:center;gap:8px;justify-content:center;border:1px solid var(--hub-border);border-right:0;border-radius:10px 0 0 10px;background:var(--hub-bg);color:var(--hub-secondary);pointer-events:auto;touch-action:none;user-select:none;box-shadow:-2px 3px 16px #00000008}.hub-handle-label{writing-mode:vertical-rl;font-size:9px;letter-spacing:2px}.hub-handle-count{font-size:9px}.is-open #t3-hub-handle{opacity:0;pointer-events:none}
        #t3-sidecar-hub-root #t3-hub-drawer{position:fixed;right:12px;top:12px;bottom:12px;width:min(var(--hub-width,880px),94vw);max-height:calc(100dvh - 24px);display:grid;grid-template-columns:196px minmax(0,1fr);grid-template-rows:auto minmax(0,1fr) auto;border:1px solid var(--hub-border);border-radius:16px;background:var(--hub-bg);box-shadow:var(--hud-shadow);overflow:hidden;pointer-events:none;visibility:hidden;opacity:0;transform:translateX(calc(100% + 28px));transition:transform .24s ease,opacity .2s,visibility .24s;-webkit-app-region:no-drag}#t3-sidecar-hub-root.is-open #t3-hub-drawer{pointer-events:auto;visibility:visible;opacity:1;transform:none}#t3-sidecar-hub-root.is-occluded{visibility:hidden!important}#t3-sidecar-hub-root.is-occluded :is(#t3-hub-drawer,#t3-hub-handle,#t3-hub-live-board){visibility:hidden!important;pointer-events:none!important}
        #t3-hub-drawer.is-compact{grid-template-columns:156px minmax(0,1fr)}.hub-header{grid-column:1/-1;padding:20px 24px 16px;border-bottom:1px solid var(--hub-border)}.hub-title-row,.hub-row{display:flex;align-items:center;gap:9px;min-width:0}.hub-title-row{gap:11px}.hub-brand{display:grid;place-items:center;width:32px;height:32px;border:1px solid var(--hub-border);border-radius:9px;background:var(--hub-bg-subtle)}.hub-grow{min-width:0;flex:1}.hub-title{font-size:17px;font-weight:650;letter-spacing:-.5px;line-height:1.4}.hub-version{font-size:10px;color:var(--hub-muted);font-weight:450;margin-left:5px}.hub-kicker{color:var(--hub-secondary);font-size:11px;margin-top:2px}.hub-icon-btn{display:inline-grid;place-items:center;flex:none;width:30px;height:30px;border:0;border-radius:7px;background:transparent;color:var(--hub-secondary)!important}.hub-icon-btn:hover{background:var(--hud-hover);color:var(--hub-ink)!important}.hub-scope-bar{display:flex;gap:8px;align-items:center;margin-top:15px}.hub-scope-select{max-width:280px}.hub-shortcut{font-size:10px;color:var(--hub-muted);margin-left:auto}.hub-context{display:flex;align-items:center;min-width:0;margin-top:10px;font-size:10px;color:var(--hub-secondary)}.hub-context-status{display:flex;gap:6px;align-items:center;overflow:hidden}.hub-context-status>span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.hub-dot{display:inline-block;width:5px;height:5px;border-radius:50%;background:currentColor;flex:none}.hub-widths{display:flex;gap:2px;padding:3px;border:1px solid var(--hub-border);border-radius:8px}.hub-widths button{font-size:10px!important;padding:4px 8px;border:0;border-radius:5px;background:transparent;color:var(--hub-secondary)}.hub-widths button.is-active{background:var(--hub-active);color:var(--hub-on-active)}
        .hub-tabs{grid-column:1;grid-row:2;display:flex;flex-direction:column;align-items:stretch;gap:4px;padding:18px 11px;overflow:auto;background:var(--hub-bg-subtle);border-right:1px solid var(--hub-border)}.hub-tab{display:flex;gap:10px;align-items:center;text-align:left;padding:10px 11px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--hub-secondary)!important;font-size:11px!important;line-height:1.5;white-space:nowrap}.hub-tab:hover{background:var(--hud-hover)}.hub-tab[aria-selected=true]{background:var(--hub-active);color:var(--hub-on-active)!important;font-weight:550}.hub-tab-count{margin-left:auto;font-size:9px;opacity:.65;font-variant-numeric:tabular-nums}.hub-content{grid-column:2;grid-row:2;min-width:0;min-height:0;padding:26px 28px 32px;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--hub-border) transparent}.hub-section-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 8px;font-size:15px;font-weight:620;letter-spacing:-.2px}.hub-count{font-size:10px;font-weight:450;color:var(--hub-secondary);font-variant-numeric:tabular-nums}.hub-description{font-size:11px;line-height:1.8;color:var(--hub-secondary);margin:0 0 20px}.hub-card{padding:16px;border:1px solid var(--hub-border);border-radius:12px;background:var(--hub-bg);margin-bottom:12px;min-width:0}.hub-card-top{display:flex;gap:11px;align-items:flex-start;min-width:0}.hub-card-name{font-size:12px;font-weight:600;line-height:1.65;overflow-wrap:anywhere}.hub-card-meta{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-top:4px}.hub-card-description{color:var(--hub-secondary);font-size:11px;line-height:1.75;margin:8px 0 12px;overflow-wrap:anywhere}.hub-badge,.hub-capability{display:inline-flex;gap:4px;align-items:center;border:1px solid var(--hub-border);border-radius:5px;padding:1px 6px;color:var(--hub-secondary);font-size:9px;line-height:1.7;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.hub-capabilities{display:flex;gap:5px;flex-wrap:wrap;margin:8px 0}.hub-badge>span{overflow:hidden;text-overflow:ellipsis}.hub-asset-icon,.hub-brand-icon{width:32px;height:32px;display:grid;place-items:center;flex:none;position:relative;border:1px solid var(--hub-border);border-radius:8px;background:var(--hub-bg-subtle);color:var(--hub-ink);overflow:hidden}.hub-brand-icon>img{position:absolute;inset:3px;width:calc(100% - 6px);height:calc(100% - 6px);object-fit:contain;filter:none!important}.hub-brand-icon.has-image>svg{opacity:0}.hub-brand-icon.is-small{width:24px;height:24px;border-radius:6px}.hub-brand-icon.is-small>img{inset:2px;width:calc(100% - 4px);height:calc(100% - 4px)}.hub-connection-dot{position:absolute;right:2px;bottom:2px;width:5px;height:5px;border-radius:50%;background:var(--hub-muted);box-shadow:0 0 0 2px var(--hub-bg)}.hub-connection-dot.is-connected{background:var(--hub-ink)}
        .hub-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:32px;padding:7px 11px;border:1px solid var(--hub-border);border-radius:8px;background:var(--hub-bg);font-size:11px!important;line-height:1.4;white-space:nowrap}.hub-btn:hover:not(:disabled){background:var(--hud-hover)}.hub-btn.hub-primary{background:var(--hub-active);border-color:var(--hub-active);color:var(--hub-on-active)!important;font-weight:550}.hub-btn.hub-primary:hover:not(:disabled){opacity:.85;background:var(--hub-active)}.hub-btn.hub-small{font-size:10px!important;min-height:27px;padding:5px 9px}.hub-btn.is-busy{pointer-events:none;opacity:.65}.hub-spinner{display:inline-block;flex:none;width:12px;height:12px;border:1.5px solid currentColor;border-right-color:transparent;border-radius:50%;animation:hub-spin .7s linear infinite}@keyframes hub-spin{to{transform:rotate(360deg)}}
        .hub-input,.hub-select,.hub-editor{display:block;width:100%;min-width:0;border:1px solid var(--hub-border);border-radius:8px;background:var(--hub-bg);color:var(--hub-ink);padding:9px 11px;font-size:11px!important;line-height:1.6}.hub-input::placeholder,.hub-editor::placeholder{color:var(--hub-muted)}.hub-select{padding-right:25px;text-overflow:ellipsis;cursor:pointer}.hub-field{display:block;font-size:10px;color:var(--hub-secondary);margin-bottom:13px;min-width:0}.hub-field>:is(input,textarea,select){margin-top:6px}.hub-editor{font:11px/1.9 ui-monospace,SFMono-Regular,Menlo,monospace!important;min-height:175px;resize:vertical;overflow-wrap:anywhere;tab-size:2}.hub-search{position:relative;margin:14px 0}.hub-search>svg{position:absolute;top:50%;left:11px;transform:translateY(-50%);color:var(--hub-muted)}.hub-search .hub-input{padding-left:34px;background:var(--hub-bg-subtle)}.hub-hint{display:flex;gap:6px;align-items:flex-start;font-size:10px;color:var(--hub-secondary);line-height:1.8;overflow-wrap:anywhere}.hub-filters{display:flex;gap:4px;flex-wrap:wrap;margin:10px 0 15px}.hub-pill{border:1px solid transparent;border-radius:6px;padding:5px 9px;font-size:10px!important;background:transparent;color:var(--hub-secondary)!important;white-space:nowrap}.hub-pill:hover{background:var(--hud-hover)}.hub-pill.is-active,.hub-segments>button.is-active{background:var(--hub-active);color:var(--hub-on-active)!important}.hub-pill-count{font-size:9px;opacity:.6;margin-left:4px}.hub-segments{display:flex;gap:3px;padding:3px;border:1px solid var(--hub-border);border-radius:8px;background:var(--hub-bg-subtle);min-width:0}.hub-segments>button{display:inline-flex;gap:5px;align-items:center;justify-content:center;flex:1;min-width:0;font-size:10px!important;line-height:1.5;white-space:nowrap;border:0;border-radius:5px;background:transparent;padding:6px 8px;color:var(--hub-secondary)}.hub-segments>button:hover:not(.is-active){background:var(--hud-hover)}.hub-resource-filters{padding:0 0 18px;border-bottom:1px solid var(--hub-border);margin-bottom:4px}.hub-agent-filters{display:flex;gap:4px;align-items:center;flex-wrap:wrap}.hub-agent-filters .hub-pill{display:inline-flex;gap:5px;align-items:center}.hub-filter-bottom{display:flex;gap:8px;margin-top:10px}.hub-filter-bottom .hub-search{flex:1;min-width:0;margin:0}.hub-filter-bottom .hub-select{width:94px;font-size:10px!important}.hub-resource-row{display:grid;grid-template-columns:32px minmax(0,1fr);column-gap:12px;padding:19px 0;border-bottom:1px solid var(--hub-border);min-width:0}.hub-resource-row .hub-card-description{margin:4px 0 0}.hub-resource-row .hub-resource-toggle{grid-column:2;margin-top:12px;justify-self:start}.hub-resource-toggle{display:flex;gap:7px;align-items:center;min-width:0;max-width:100%}.hub-resource-toggle>.hub-btn{font-size:9px!important;min-height:26px;padding:4px 8px}.hub-agent-toggle{display:flex;gap:2px;padding:3px;border:1px solid var(--hub-border);border-radius:8px;background:var(--hub-bg-subtle);min-width:0}.hub-agent-toggle button{display:inline-flex;align-items:center;justify-content:center;gap:4px;min-width:0;border:0;border-radius:5px;padding:5px 7px;background:transparent;color:var(--hub-secondary);font-size:9px!important;line-height:1.4;white-space:nowrap}.hub-agent-toggle button[aria-pressed=true]{background:var(--hub-active);color:var(--hub-on-active)}.hub-agent-mark{width:12px;height:12px;flex:none}.hub-library-tabs{display:flex;gap:6px;border-bottom:1px solid var(--hub-border);margin-bottom:18px;padding-bottom:12px}.hub-market-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,245px),1fr));gap:12px;margin-top:18px}.hub-market-card{margin:0;display:flex;flex-direction:column;align-items:stretch}.hub-market-card>.hub-btn{align-self:flex-start;margin-top:auto}.hub-market-card .hub-card-description{min-height:38px}.hub-market-card .hub-capabilities{margin-bottom:16px}.hub-resource-title{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.hub-mcp-name{font-weight:600;font-size:12px;overflow-wrap:anywhere}.hub-mcp-detail{color:var(--hub-secondary);font-size:10px;margin-top:5px;overflow-wrap:anywhere}.hub-mcp-row-options{display:flex;gap:7px;margin-top:9px}.hub-mode-pill{width:auto;max-width:200px;padding:4px 20px 4px 8px;font-size:9px!important}.hub-live{display:inline-flex;align-items:center;gap:4px;font-size:9px;color:var(--hub-secondary)}.hub-status-strip{border:1px solid var(--hub-border);border-radius:10px;background:var(--hub-bg-subtle);padding:12px;margin:12px 0}.hub-status-items{display:flex;gap:12px;flex-wrap:wrap}.hub-status-item{display:flex;align-items:center;gap:5px;font-size:10px;color:var(--hub-secondary)}
        .hub-form-panel,.hub-import,.hub-new-memory{padding:15px;background:var(--hub-bg-subtle);border:1px solid var(--hub-border);border-radius:10px;margin:14px 0}.hub-import-title{font-size:11px;font-weight:550;display:flex;gap:7px;margin-bottom:10px}.hub-import-grid{display:grid;grid-template-columns:minmax(0,1fr) 94px auto;gap:7px}.hub-import .hub-hint{margin-top:8px}.hub-form-grid,.hub-subagent-fields{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px}.hub-custom-toggle{margin:4px 0 14px}.hub-editor-actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-top:12px}.hub-confirm-delete{border:1px solid var(--hub-border);padding:10px;border-radius:8px;background:var(--hub-bg-subtle);font-size:10px;margin-top:10px}.hub-confirm-delete .hub-row{margin-top:8px}.hub-hook-card .hub-card-description{margin-bottom:13px}.hub-hook-command{display:block;white-space:pre-wrap;overflow-wrap:anywhere;font-size:10px;padding:10px;background:var(--hub-bg-subtle);margin:10px 0;border-radius:6px}.hub-group-heading{font-size:11px;margin:22px 0 10px}.hub-hook-group{margin-bottom:20px}.hub-switch{width:30px;height:18px;border:1px solid var(--hub-border);border-radius:20px;position:relative;flex:none;background:var(--hub-bg-subtle);padding:2px}.hub-switch>span{display:block;width:12px;height:12px;border-radius:50%;background:var(--hub-muted);transition:transform .15s}.hub-switch[aria-checked=true]{background:var(--hub-active);border-color:var(--hub-active)}.hub-switch[aria-checked=true]>span{background:var(--hub-on-active);transform:translateX(12px)}
        .hub-engine{background:var(--hub-bg-subtle);padding:18px;margin:0 0 26px}.hub-engine-label{font-size:9px;letter-spacing:1.2px;font-weight:650;color:var(--hub-secondary)}.hub-engine-status{display:flex;gap:6px;align-items:center;font-size:11px;font-weight:550;margin:12px 0 7px;flex-wrap:wrap}.hub-engine-model{font-size:10px;color:var(--hub-secondary);overflow-wrap:anywhere;margin-bottom:14px}.hub-engine-controls{display:flex;align-items:stretch;gap:7px}.hub-engine-controls>.hub-select{flex:1}.hub-engine-controls>.hub-btn{font-size:10px!important}.hub-checkbox{display:inline-flex;align-items:center;gap:6px;font-size:10px;color:var(--hub-secondary);margin-top:12px}.hub-checkbox input{accent-color:var(--hub-active);margin:0;width:13px;height:13px}.hub-progress-label{display:flex;justify-content:space-between;font-size:10px;color:var(--hub-secondary);margin:12px 0 6px}.hub-progress-track{height:4px;background:var(--hub-border);border-radius:5px;overflow:hidden}.hub-progress-fill{height:100%;background:var(--hub-ink);border-radius:5px;transition:width .3s}.indeterminate .hub-progress-fill{animation:hub-pulse 1.4s ease infinite}.hub-worktree-bar{margin:15px 0}.hub-worktree-bar .hub-segments{flex-wrap:wrap}.hub-worktree-bar .hub-segments>button{flex:1 1 42%;white-space:normal}.hub-worktree-caption{display:flex;gap:8px;align-items:center;justify-content:space-between;margin-top:8px;color:var(--hub-secondary);font-size:10px}.hub-project-picker{display:flex;gap:8px;align-items:center;margin:12px 0}.hub-project-picker .hub-select{flex:1}.hub-memory-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px}.hub-memory-card{padding:0}.hub-memory-open{display:block;width:100%;text-align:left;padding:14px;border:0;background:transparent;border-radius:11px}.hub-memory-open:hover{background:var(--hud-hover)}.hub-memory-detail{padding:14px;border-top:1px solid var(--hub-border)}.hub-memory-date{margin-left:auto;font-size:9px;color:var(--hub-muted)}.hub-memory-hits{font-size:9px;color:var(--hub-secondary)}.hub-detail-meta{display:flex;gap:7px;align-items:center;font-size:9px;color:var(--hub-secondary);margin-top:8px}.hub-memory-history{padding:0 14px 12px}.hub-history-toggle{border:0;background:transparent;font-size:10px!important;color:var(--hub-secondary)}.hub-history-entry{padding:9px 0;border-top:1px solid var(--hub-border);font-size:10px}.hub-history-agent{font-size:9px;color:var(--hub-secondary)}
        .hub-subagent-scopes{display:flex;gap:8px;margin:18px 0}.hub-subagent-scope{flex:1;min-width:0;text-align:left;border:1px solid var(--hub-border);border-radius:9px;background:transparent;padding:10px 12px;font-size:11px!important}.hub-subagent-scope[aria-pressed=true]{background:var(--hub-bg-subtle);border-color:var(--hub-ink)}.hub-subagent-scope small{display:block;color:var(--hub-secondary);font-size:9px;margin-top:3px}.hub-subagent-heading{display:flex;gap:10px;align-items:center;justify-content:space-between;margin:20px 0 10px}.hub-subagent-heading h3{font-size:13px;margin:0}.hub-subagent-heading h3>span{font-size:10px;color:var(--hub-secondary);margin-left:7px;font-weight:400}.hub-subagent-list{border:1px solid var(--hub-border);border-radius:11px;overflow:hidden}.hub-subagent-card{padding:16px;border-bottom:1px solid var(--hub-border);min-width:0}.hub-subagent-card:last-child{border-bottom:0}.hub-subagent-main{display:grid;grid-template-columns:28px minmax(0,1fr);gap:9px;align-items:center}.hub-subagent-summary{min-width:0;text-align:left;border:0;background:transparent;padding:0}.hub-subagent-name{display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:11px;font-weight:600}.hub-tool-badge{font-size:8px;line-height:1.5;font-weight:400;padding:2px 5px;border:1px solid var(--hub-border);border-radius:4px;color:var(--hub-secondary)}.hub-subagent-desc{display:block;font-size:10px;color:var(--hub-secondary);line-height:1.7;margin-top:3px;overflow-wrap:anywhere}.hub-subagent-controls{display:grid;grid-template-columns:minmax(0,.8fr) minmax(0,1.3fr) minmax(0,.8fr);gap:6px;grid-column:2}.hub-subagent-controls .hub-select{font-size:10px!important;padding:7px 20px 7px 8px}.hub-subagent-meta{display:flex;align-items:center;flex-wrap:wrap;gap:7px;margin:10px 0 0 37px}.hub-memory-policy{width:170px;padding:5px 18px 5px 7px;font-size:9px!important}.hub-subagent-edit{display:inline-flex;gap:4px;align-items:center;margin-left:auto;font-size:9px!important;border:0;background:transparent;padding:3px 0;color:var(--hub-secondary)!important}.hub-subagent-expand{display:none}.hub-subagent-expand.is-expanded{display:block}.hub-subagent-editor{border-top:1px solid var(--hub-border);margin-top:14px;padding-top:14px}.hub-subagent-custom{padding:12px;border:1px solid var(--hub-border);border-radius:8px;margin-top:10px}.hub-subagent-note{display:flex;align-items:flex-start;gap:6px;margin-top:14px;font-size:10px;color:var(--hub-secondary);line-height:1.8}.hub-commander{padding:18px;background:var(--hub-bg-subtle)}.hub-commander-title{font-size:14px;font-weight:600;margin-bottom:4px}.hub-commander .hub-description{margin-bottom:16px}.hub-commander-note{padding:10px 12px;border-left:2px solid var(--hub-ink);font-size:10px;line-height:1.9;color:var(--hub-secondary);margin:12px 0 16px}.hub-control-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0;border-top:1px solid var(--hub-border)}.hub-control-row strong{font-size:11px;font-weight:550;display:block}.hub-control-row small{display:block;font-size:10px;color:var(--hub-secondary);margin-top:3px}.hub-range{display:flex;align-items:center;gap:8px;max-width:170px}.hub-range input[type=range]{width:100px;accent-color:var(--hub-active)}.hub-range input[type=number]{width:49px;padding:5px;font-size:10px!important}
        .hub-footer{grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 24px;border-top:1px solid var(--hub-border);color:var(--hub-secondary);font-size:9px;min-height:40px;background:var(--hub-bg)}.hub-footer-status{display:flex;align-items:center;gap:6px}.hub-footer-key{color:var(--hub-muted)}.hub-toast{position:absolute;left:20px;right:20px;bottom:53px;display:flex;gap:8px;align-items:center;padding:11px 14px;border:1px solid var(--hub-border);border-radius:10px;background:var(--hub-active);color:var(--hub-on-active);font-size:11px;box-shadow:var(--hud-shadow);pointer-events:auto;z-index:4}.hub-empty{display:flex;flex-direction:column;align-items:center;gap:9px;padding:36px 18px;color:var(--hub-secondary);text-align:center;font-size:11px}.hub-empty strong{font-size:12px;color:var(--hub-ink);font-weight:550}.hub-empty>svg{opacity:.5}.hub-empty>span{font-size:10px;line-height:1.8;max-width:280px}.hub-error{display:flex;gap:9px;align-items:flex-start;border:1px solid var(--hub-border);border-radius:10px;background:var(--hub-bg-subtle);padding:13px;margin:12px 0;color:var(--hub-ink)}.hub-error>div{flex:1;min-width:0}.hub-error strong{font-size:11px;display:block}.hub-error span{display:block;font-size:10px;color:var(--hub-secondary);margin-top:4px;overflow-wrap:anywhere}.hub-skeleton>div{border-bottom:1px solid var(--hub-border);padding:18px 0}.hub-skeleton i{display:block;background:var(--hub-bg-subtle);height:9px;border-radius:3px;margin:9px 0;animation:hub-pulse 1.3s ease infinite}.hub-skeleton i:first-child{width:40%}.hub-skeleton i:last-child{width:70%}@keyframes hub-pulse{50%{opacity:.35}}
        #t3-hub-resize-handle{position:absolute;z-index:5;left:0;top:0;bottom:0;width:7px;background:transparent;cursor:ew-resize;touch-action:none;border:0;padding:0}#t3-hub-resize-handle:after{content:"";position:absolute;top:45%;left:2px;width:2px;height:32px;background:var(--hub-border);border-radius:3px}#t3-hub-resize-handle:hover:after{background:var(--hub-ink)}
        #t3-hub-slash-palette{position:fixed;pointer-events:auto;z-index:3;display:flex;flex-direction:column;overflow:hidden;width:360px;max-height:480px;background:var(--hub-bg);border:1px solid var(--hub-border);border-radius:13px;box-shadow:var(--hud-shadow);-webkit-app-region:no-drag}.hub-slash-header{display:flex;gap:8px;align-items:center;padding:14px 14px 9px;font-size:12px;font-weight:600}.hub-slash-project{margin-left:auto;font-size:9px;font-weight:400;color:var(--hub-secondary);max-width:42%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.hub-slash-search{padding:0 12px 10px}.hub-slash-search .hub-input{background:var(--hub-bg-subtle);padding:8px 10px;font-size:11px!important}.hub-slash-tabs{display:flex;gap:3px;padding:0 10px 10px;border-bottom:1px solid var(--hub-border)}.hub-slash-tabs button{padding:5px 8px;font-size:9px!important}.hub-slash-list{overflow:auto;min-height:0;overscroll-behavior:contain;padding:6px;scrollbar-width:thin}.hub-slash-row{display:flex;gap:6px;align-items:center;border-radius:8px;margin:2px 0}.hub-slash-row.is-active{background:var(--hub-bg-subtle)}.hub-slash-select{display:flex;align-items:center;gap:9px;flex:1;min-width:0;padding:9px 8px;border:0;background:transparent;border-radius:8px;text-align:left}.hub-slash-label{display:block;font-size:11px;font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.hub-slash-description{display:block;font-size:9px;color:var(--hub-secondary);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.hub-slash-type{display:grid;place-items:center;width:24px;height:24px;border:1px solid var(--hub-border);border-radius:6px;background:var(--hub-bg-subtle);flex:none}.hub-slash-badge{font-size:8px;max-width:27%;flex-shrink:1}.hub-slash-edit{border:0;background:transparent;font-size:9px!important;color:var(--hub-secondary);padding:5px}.hub-slash-empty{padding:22px 12px;font-size:10px;color:var(--hub-secondary);display:flex;gap:7px;align-items:center}.hub-slash-footer{display:flex;justify-content:space-between;gap:7px;padding:9px 14px;border-top:1px solid var(--hub-border);font-size:8px;color:var(--hub-muted)}
        #t3-hub-live-board{position:fixed;z-index:2147483000;pointer-events:auto;min-width:0;background:var(--hub-bg);color:var(--hub-ink);border:1px solid var(--hub-border);border-radius:0 0 12px 12px;padding:12px 14px;box-shadow:none;overflow:hidden;font:12px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}#t3-hub-live-board[hidden]{display:none!important}#t3-hub-live-board,#t3-hub-live-board *{box-sizing:border-box}#t3-hub-live-board :is(button,input){font:inherit;color:inherit}#t3-hub-live-board button{cursor:pointer}#t3-hub-live-board :focus-visible{outline:2px solid var(--hub-accent);outline-offset:2px}#t3-hub-live-board.is-collapsed{}.hub-board-toggle{flex:1;min-width:0;width:100%;display:flex;gap:8px;align-items:center;justify-content:space-between;border:0;background:transparent;text-align:left;padding:0;font-size:11px!important;font-weight:550}.is-collapsed .hub-board-toggle{padding:0;font-size:11px!important}.hub-board-content{padding:14px 0 0;max-height:420px;overflow:auto}.hub-board-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:2px 0 15px}.hub-board-heading strong{font-size:14px;font-weight:600}.hub-board-background{margin:0 0 16px;padding:10px 11px;background:var(--hub-bg-subtle);border-radius:7px;font-size:10px;color:var(--hub-secondary);white-space:pre-wrap;line-height:1.85}.hub-board-section{font-size:10px;color:var(--hub-secondary);display:flex;align-items:center;justify-content:space-between;margin:18px 0 10px;font-weight:550}.hub-board-section:first-child{margin-top:4px}.hub-board-section b{font-size:11px;font-weight:600;color:var(--hub-ink)}.hub-board-steps{display:flex;flex-direction:column;gap:12px;margin:0;padding:0;list-style:none}.hub-board-step{display:flex;gap:10px;align-items:flex-start;font-size:11px;line-height:1.7;min-width:0}.hub-step-icon{display:grid;place-items:center;flex:none;width:16px;height:19px;font-size:13px;font-weight:600}.hub-board-step.is-completed{color:var(--hub-muted)}.hub-board-step.is-completed .hub-step-text{text-decoration:line-through}.hub-board-step.is-in-progress{font-weight:600;color:var(--hub-ink)}.is-in-progress .hub-step-icon{animation:hub-pulse 1.5s ease infinite}.hub-step-check{padding:0;border:0;background:transparent;line-height:1;color:inherit}.hub-artifacts{display:flex;flex-wrap:wrap;gap:6px}.hub-artifact-chip{border:1px solid var(--hub-border);border-radius:6px;font-size:9px!important;padding:5px 7px;background:var(--hub-bg-subtle);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.hub-board-studio{border:1px solid var(--hub-border);border-radius:12px;padding:20px;margin:0 0 16px}.hub-board-studio .hub-board-step{font-size:12px}.hub-board-studio .hub-board-steps{gap:14px}.hub-board-add{display:flex;gap:7px;margin-top:20px}.hub-board-add .hub-input{flex:1}.hub-artifact-preview{padding:16px;background:var(--hub-bg-subtle);border:1px solid var(--hub-border);border-radius:10px;margin-top:16px}.hub-artifact-preview pre{white-space:pre-wrap;overflow-wrap:anywhere;font:10px/1.9 ui-monospace,SFMono-Regular,Menlo,monospace;max-height:340px;overflow:auto}.hub-native-hosts{margin-bottom:18px}.hub-settings-tabs{display:flex;gap:6px;flex-wrap:wrap;margin:18px 0}.hub-settings-host-description{margin:8px 0 18px;font-size:10px;color:var(--hub-secondary)}
        .hub-agents-targets{display:flex;gap:8px;margin:12px 0}.hub-agents-target{min-width:0;flex:1;border:1px solid var(--hub-border);border-radius:9px;background:transparent;padding:12px;text-align:left}.hub-agents-target.is-active{background:var(--hub-bg-subtle);border-color:var(--hub-ink)}.hub-agents-target strong{display:block;font-size:11px}.hub-agents-target small{display:block;font-size:9px;color:var(--hub-secondary)}.hub-token-bar{display:flex;justify-content:space-between;gap:8px;align-items:center;margin:16px 0 9px;font-size:11px}.hub-token{font-size:9px;color:var(--hub-secondary)}.hub-token-warning{font-size:10px;color:var(--hub-secondary)}.hub-agents-editor{min-height:300px}.hub-agents-save{display:flex;gap:8px;justify-content:space-between;margin-top:12px;align-items:center}.hub-saved-hint{font-size:10px;color:var(--hub-secondary)}.hub-sync-badges{display:flex;gap:5px;flex-wrap:wrap;margin-top:14px}.hub-soft-route{margin-top:16px}
        #t3-hub-drawer.is-wide .hub-resource-row{grid-template-columns:32px minmax(0,1fr) auto;align-items:center}#t3-hub-drawer.is-wide .hub-resource-row .hub-resource-toggle{grid-column:3;grid-row:1;margin:0}#t3-hub-drawer.is-wide .hub-subagent-main{grid-template-columns:28px minmax(0,1fr) minmax(280px,1fr)}#t3-hub-drawer.is-wide .hub-subagent-controls{grid-column:3}#t3-hub-drawer.is-compact .hub-content{padding:20px 16px}#t3-hub-drawer.is-compact .hub-header{padding:16px}#t3-hub-drawer.is-compact .hub-resource-row .hub-resource-toggle{grid-column:1/-1}#t3-hub-drawer.is-compact .hub-agent-toggle button{padding-inline:5px}#t3-hub-drawer.is-compact .hub-agent-toggle .hub-agent-mark{display:none}#t3-hub-drawer.is-compact .hub-import-grid{grid-template-columns:minmax(0,1fr) auto}#t3-hub-drawer.is-compact .hub-import-grid .hub-select{grid-column:1/-1}#t3-hub-drawer.is-compact .hub-engine-controls{flex-wrap:wrap}#t3-hub-drawer.is-compact .hub-engine-controls .hub-select{flex-basis:100%}#t3-hub-drawer.is-compact .hub-subagent-controls{grid-column:1/-1}#t3-hub-drawer.is-compact .hub-subagent-meta{margin-left:0}
        @media(max-width:639px){#t3-sidecar-hub-root #t3-hub-drawer{right:8px;top:8px;bottom:8px;width:calc(100vw - 16px);max-height:calc(100dvh - 16px);grid-template-columns:minmax(0,1fr);grid-template-rows:auto auto minmax(0,1fr) auto;border-radius:13px}.hub-header{padding:15px 16px 13px}.hub-brand{width:28px;height:28px}.hub-title{font-size:15px}.hub-kicker{font-size:10px}.hub-widths{display:none}.hub-title-row{gap:9px}.hub-scope-bar{margin-top:12px}.hub-scope-select{max-width:260px}.hub-context{margin-top:8px}.hub-tabs{grid-column:1;grid-row:2;flex-direction:row;overflow-x:auto;padding:8px;gap:3px;border-right:0;border-bottom:1px solid var(--hub-border);scrollbar-width:none}.hub-tab{padding:7px 9px;font-size:10px!important;gap:6px}.hub-tab-count{display:none}.hub-content{grid-column:1;grid-row:3;padding:21px 17px 26px}.hub-footer{grid-row:4;padding:10px 16px}.hub-resource-toggle{gap:5px;max-width:100%}.hub-agent-toggle button{padding-inline:6px;font-size:9px!important}.hub-agent-toggle button svg{width:10px;height:10px}.hub-resource-row .hub-resource-toggle{grid-column:1/-1}.hub-resource-row{padding:17px 0}.hub-subagent-main{grid-template-columns:28px minmax(0,1fr)}.hub-subagent-controls{grid-column:1/-1}.hub-subagent-meta{margin-left:0}.hub-memory-policy{width:163px}.hub-subagent-edit{margin-left:0}.hub-form-grid,.hub-subagent-fields{grid-template-columns:minmax(0,1fr)}.hub-board-studio{padding:16px}.hub-board-step{font-size:11px}.hub-board-studio .hub-board-step{font-size:11px}.hub-worktree-caption{flex-wrap:wrap}.hub-project-picker{flex-wrap:wrap}.hub-project-picker .hub-select{flex-basis:100%}.hub-import-grid{grid-template-columns:minmax(0,1fr) 86px auto}.hub-import-grid .hub-input{padding-inline:8px;font-size:10px!important}.hub-import-grid .hub-btn{padding-inline:8px}.hub-engine-controls{flex-wrap:wrap}.hub-engine-controls .hub-select{flex-basis:100%}.hub-board-content{max-height:340px}#t3-hub-resize-handle{display:none}}
        #t3-sidecar-hub-root .hub-engine{margin-bottom:12px}.hub-dream-card{padding:16px;margin:0 0 26px;background:var(--hub-bg)}.hub-dream-heading{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.hub-dream-title{display:inline-flex;align-items:center;gap:7px;font-size:13px;font-weight:600}.hub-dream-size{margin-left:auto;font-size:9px;color:var(--hub-secondary);white-space:nowrap}.hub-dream-description{font-size:10px;color:var(--hub-secondary);margin:7px 0 13px;line-height:1.8}.hub-dream-controls{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.hub-dream-enable{display:inline-flex;align-items:center;gap:7px;font-size:10px;color:var(--hub-secondary)}.hub-dream-time{display:inline-flex;align-items:center;gap:7px;font-size:10px;color:var(--hub-secondary)}.hub-dream-time .hub-input{width:99px;padding:5px 7px;min-height:30px;font-size:10px!important}.hub-dream-time input::-webkit-calendar-picker-indicator{opacity:.6}.hub-dream-controls .hub-checkbox{margin:0;white-space:nowrap}.hub-dream-controls>.hub-btn{margin-left:auto}.hub-dream-report{padding-top:12px;margin-top:13px;border-top:1px solid var(--hub-border);font-size:10px;line-height:1.85;color:var(--hub-secondary);overflow-wrap:anywhere}.hub-dream-report .hub-hint{font-size:9px;margin-top:5px}.hub-dream-error{font-size:10px;color:var(--hub-ink);border-left:2px solid var(--hub-ink);padding-left:9px;margin:11px 0 0;line-height:1.8}#t3-hub-drawer.is-compact .hub-dream-size{margin-left:0;flex-basis:100%}@media(max-width:639px){.hub-dream-card{padding:15px}.hub-dream-size{margin-left:0;flex-basis:100%}.hub-dream-controls{gap:12px 16px}.hub-dream-controls .hub-checkbox{flex:1}.hub-dream-controls>.hub-btn{font-size:10px!important}}
        #t3-sidecar-hub-root .hub-brand-icon,#t3-sidecar-hub-root .hub-brand-icon>img{filter:none!important}
        #t3-sidecar-hub-root .hub-agent-toggle button[aria-pressed=true],#t3-sidecar-hub-root .hub-widths button.is-active{color:var(--hub-on-active)}

        #t3-sidecar-hub-root .hub-library-tabs{flex-wrap:wrap;gap:3px}#t3-sidecar-hub-root .hub-native-badge{margin-top:2px}.hub-dream-engine-row{display:flex;align-items:flex-end;flex-wrap:wrap;gap:9px;margin:14px 0}.hub-dream-engine{flex:1 1 240px;margin:0!important;min-width:0}.hub-dream-budget{display:inline-flex;align-items:center;gap:5px;max-width:100%;padding:6px 8px;border:1px solid var(--hub-border);border-radius:7px;background:var(--hub-bg-subtle);font-size:9px;color:var(--hub-secondary);line-height:1.6;overflow-wrap:anywhere}.hub-dream-consumption{margin-top:6px;color:var(--hub-ink);font-variant-numeric:tabular-nums}.hub-engine-memory{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin:11px 0 7px;padding-top:10px;border-top:1px solid var(--hub-border)}.hub-engine-memory-values{min-width:0;flex:1 1 200px;font-size:11px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.hub-engine-memory-values>span{display:block;font-weight:550}.hub-engine-memory-values>small{display:block;margin-top:2px;font-size:9px;color:var(--hub-secondary)}.hub-memory-health{font-variant-numeric:tabular-nums}.hub-memory-governance{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:0 0 14px;padding:0 1px}.hub-memory-governance .hub-hint{font-size:9px}.hub-memory-governance>.hub-btn{flex:none}
        @media(prefers-reduced-motion:reduce){#t3-sidecar-hub-root *,#t3-sidecar-hub-root *:before,#t3-sidecar-hub-root *:after{animation:none!important;transition:none!important}}
      `;
      style.textContent += `
        .hub-theme-switcher{display:flex;align-items:center;gap:5px;flex:none;padding:3px}
        .hub-theme-dot{width:14px;height:14px;min-width:14px;padding:0;border:1px solid var(--hub-border);border-radius:50%;background:var(--hub-swatch)!important;cursor:pointer}
        .hub-theme-dot[aria-pressed=true]{outline:2px solid var(--hub-accent);outline-offset:2px}
        .hub-board-toolbar{display:flex;align-items:center;gap:8px;min-width:0}
        .hub-board-toolbar .hub-icon-btn{width:22px;height:22px}
        #t3-hub-live-board .hub-board-steps{gap:9px}#t3-hub-live-board .hub-step-text{overflow-wrap:anywhere}
        #t3-hub-live-board .hub-board-add{margin-top:14px;gap:5px}#t3-hub-live-board .hub-board-add .hub-input{padding:6px 8px;font-size:10px!important}
        #t3-hub-live-board .hub-board-add .hub-btn{padding:4px 7px;min-height:28px}
        .hub-memory-date{white-space:nowrap;font-variant-numeric:tabular-nums}.hub-detail-meta{flex-wrap:wrap}.hub-dream-times{display:flex;gap:6px 16px;flex-wrap:wrap;font-size:10px;color:var(--hub-secondary);margin-top:10px}
        @media(max-width:639px){.hub-title-row{flex-wrap:wrap}.hub-title-row .hub-grow{flex-basis:calc(100% - 48px)}.hub-header{padding:14px 16px}.hub-header .hub-theme-switcher{margin-right:auto}}
      `;
      document.head.appendChild(style);
      root = document.createElement("div");
      root.id = "t3-sidecar-hub-root";
      root.innerHTML = `<button type="button" id="t3-hub-handle" aria-controls="t3-hub-drawer" aria-expanded="false">${icon("hub", 15)}<span class="hub-handle-label">HUB</span><span class="hub-handle-count" hidden></span></button><aside id="t3-hub-drawer" role="complementary" aria-labelledby="t3-hub-title" aria-hidden="true" inert><div id="t3-hub-resize-handle" role="separator" aria-orientation="vertical" tabindex="0" aria-label="调整 Hub 宽度"></div><header class="hub-header"></header><nav class="hub-tabs" role="tablist" aria-label="Hub 设置"></nav><section id="t3-hub-panel" class="hub-content" role="tabpanel" tabindex="0"></section><footer class="hub-footer"></footer><div class="hub-toast" role="status" aria-live="polite" hidden></div></aside><section id="t3-hub-live-board" aria-label="实时任务进度" hidden></section>`;
      document.body.appendChild(root);
      drawer = root.querySelector("#t3-hub-drawer");
      handle = root.querySelector("#t3-hub-handle");
      content = root.querySelector(".hub-content");
      liveBoard = root.querySelector("#t3-hub-live-board");
      palette = document.createElement("section");
      palette.id = "t3-hub-slash-palette";
      palette.hidden = true;
      palette.setAttribute("aria-label", "Skills 与编排指令");
      root.appendChild(palette);
      state.lang = detectLang();
      state.dark = isDark();
      applyTheme();
      renderChrome();
      applyWidth();
      renderLiveBoard();
      positionHandle();
      listen(root, "click", onClick);
      listen(root, "input", onInput);
      listen(root, "change", onChange);
      listen(liveBoard, "click", onClick);
      listen(liveBoard, "input", onInput);
      listen(liveBoard, "keydown", onEditorKeydown);
      listen(root, "error", (event) => { if (event.target.matches?.(".hub-brand-icon>img")) { event.target.parentElement.classList.remove("has-image"); event.target.remove(); } }, true);
      const resizeHandle = root.querySelector("#t3-hub-resize-handle");
      listen(resizeHandle, "pointerdown", startResize);
      listen(resizeHandle, "pointermove", moveResize);
      listen(resizeHandle, "pointerup", endResize);
      listen(resizeHandle, "pointercancel", endResize);
      listen(resizeHandle, "keydown", (event) => { if (["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); setWidth(state.width + (event.key === "ArrowLeft" ? 40 : -40)); } });
      listen(root, "pointerover", (event) => { const card = event.target.closest("[data-subagent-card]"); if (card && !card.contains(event.relatedTarget)) greetBots(card.dataset.subagentCard); });
      listen(root, "keydown", onEditorKeydown);
      listen(root, "submit", (event) => {
        const form = event.target.dataset.form;
        if (["import", "hook"].includes(form)) { event.preventDefault(); if (form === "import") runImport(); if (form === "hook") saveHook(); }
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
      listen(window, "resize", () => { applyWidth(); positionConversationTools(); });
      listen(window, "t3-hud-popover-change", positionConversationTools);
      listen(window, "hashchange", checkRoute);
      listen(window, "popstate", checkRoute);
      listen(window, "storage", syncEnvironment);
      listen(window, "t3-hub-theme-change", (event) => applyTheme(event.detail?.theme || storageGet("t3-hub-theme") || "white"));
      listen(document, "visibilitychange", () => { if (!document.hidden) { checkRoute(); pollBoard(); if (state.open) pollEmbed(); } });
      const scheduleUpdate = () => {
        if (updateFrame || disposed) return;
        updateFrame = requestAnimationFrame(() => {
          updateFrame = 0;
          if (!disposed) { checkRoute(); syncEnvironment(); syncOcclusion(); positionConversationTools(); }
        });
      };
      listen(document, "scroll", scheduleUpdate, { capture: true, passive: true });
      if (typeof ResizeObserver === "function") anchorResize = new ResizeObserver(scheduleUpdate);
      observer = new MutationObserver((records) => {
        const stream = '[role="log"],[data-slot="message"],[data-message-id],[data-message-role],[data-testid="chat-message"]';
        if (records.every(({ target }) => {
          const node = target.nodeType === 1 ? target : target.parentElement;
          return !node || root.contains(node) || node.closest?.(stream);
        })) return;
        scheduleUpdate();
      });
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "lang", "style"] });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "data-theme", "style"] });
      ensureRouterSubscription();
      routeTimer = setInterval(() => { if (!disposed && !document.hidden) { ensureRouterSubscription(); checkRoute(); syncEnvironment(); syncOcclusion(); positionConversationTools(); } }, 3000);
      lastRoute = routeKey();
      state.threadId = currentThreadId();
      syncOcclusion();
      setOpen(state.open, false);
      refreshContext();
      scheduleBoardPoll();
    }

    function renderChrome() {
      if (!root || disposed) return;
      root.dataset.tab = state.tab;
      const context = state.context || {};
      const projectName = projectTitle();
      const rawCli = context.activeProvider || context.activeCli || context.cli || context.provider || context.providerInstanceId;
      const cli = typeof rawCli === "object" ? rawCli?.name || rawCli?.id : rawCli;
      const cliNames = { codex: "Codex", antigravity: "AGY", agy: "AGY", muse: "Muse", pi: "Pi", claude: "Claude", claudeAgent: "Claude" };
      const model = typeof context.activeModel === "object" ? context.activeModel?.name || context.activeModel?.id : context.activeModel;
      const cliName = [cliNames[String(cli)] || cli, model].filter(Boolean).join(" · ") || tr("本地工作区就绪", "Workspace ready");
      const count = context.activeProjectCount ?? context.projectCount ?? (Array.isArray(context.projects) ? context.projects.length : null);
      const badge = root.querySelector(".hub-handle-count");
      badge.hidden = count == null;
      badge.textContent = String(count ?? "");
      handle.title = tr("Hub 工作台 · ⌘⇧K / Alt+H", "Hub Studio · ⌘⇧K / Alt+H");
      handle.setAttribute("aria-label", tr("打开 Hub 工作台", "Open Hub Studio"));
      root.querySelector(".hub-header").innerHTML = `<div class="hub-title-row"><span class="hub-brand">${icon("hub", 18)}</span><div class="hub-grow"><div id="t3-hub-title" class="hub-title">Hub Studio <span class="hub-version">v3</span></div><div class="hub-kicker">${esc(tr("一个工作台，连接所有 AI 搭档。", "One workspace for all your agents."))}</div></div>${themeSwitcher()}<div class="hub-widths" aria-label="${esc(tr("工作台宽度", "Studio width"))}">${[[520, "紧凑", "Compact"], [880, "标准", "Standard"], [1140, "超宽", "Wide"]].map(([width, zh, en]) => `<button type="button" data-action="set-width" data-width="${width}" class="${Math.abs(state.width - width) < 8 ? "is-active" : ""}" aria-pressed="${Math.abs(state.width - width) < 8}">${esc(tr(zh, en))}</button>`).join("")}</div><button type="button" class="hub-icon-btn" data-action="refresh" title="${esc(tr("刷新当前页", "Refresh tab"))}" aria-label="${esc(tr("刷新当前页", "Refresh tab"))}">${state.refreshing ? spinner() : icon("refresh", 15)}</button><button type="button" class="hub-icon-btn" data-action="close" aria-label="${esc(tr("关闭", "Close"))}">${icon("close", 16)}</button></div><div class="hub-scope-bar"><select class="hub-select hub-scope-select" name="hub-scope" aria-label="${esc(tr("工作空间作用域", "Workspace scope"))}"><option value="global" ${state.scope === "global" ? "selected" : ""}>${esc(tr("本机 · 全局", "Local · Global"))}</option><option value="project" ${state.scope === "project" ? "selected" : ""} ${projectDisabled() ? "disabled" : ""}>${esc(tr("当前项目", "Project"))} · ${esc(projectName)}</option></select><span class="hub-shortcut">⌘ ⇧ K</span></div><div class="hub-context"><span class="hub-context-status"><i class="hub-dot"></i><span>${esc(state.contextError ? tr("工作区连接暂不可用", "Workspace unavailable") : cliName)}</span></span></div>`;
      const tabs = [["memory", "memory", tr("记忆库", "Memory")], ["skills", "bolt", tr("技能与 MCP", "Skills & MCP")], ["subagents", "hub", tr("编排路由", "Routing")], ["settings", "edit", tr("宿主设置", "Settings")]];
      root.querySelector(".hub-tabs").innerHTML = tabs.map(([key, glyph, label]) => {
        const count = tabCount(key);
        return `<button type="button" id="t3-hub-tab-${key}" class="hub-tab" role="tab" data-action="tab" data-tab="${key}" aria-controls="t3-hub-panel" aria-selected="${key === state.tab}" tabindex="${key === state.tab ? 0 : -1}">${icon(glyph, 14)}<span>${esc(label)}</span>${count == null ? "" : `<span class="hub-tab-count">${esc(count)}</span>`}</button>`;
      }).join("");
      content.setAttribute("aria-labelledby", `t3-hub-tab-${state.tab}`);
      root.querySelector(".hub-footer").innerHTML = `<span class="hub-footer-status"><i class="hub-dot"></i>${esc(state.connected ? tr("已连接 · 所有更改保存在本机", "Connected · Changes stay local") : tr("等待 Hub 连接", "Waiting for Hub"))}</span><span class="hub-footer-key">Esc ${esc(tr("收起", "Close"))}</span>`;
    }
    function tabCount(key) {
      const counts = state.context?.counts || {};
      if (key === "board") { const b = boardData(); return b.progress.total ? `${b.progress.completed}/${b.progress.total}` : null; }
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
    const agentHosts = [
      { id: "antigravity", label: "AGY", aliases: ["agy", "antigravity"] },
      { id: "muse", label: "Muse", aliases: ["muse"] },
      { id: "codex", label: "Codex", aliases: ["codex"] },
      { id: "pi", label: "Pi", aliases: ["pi", "magpie"] },
      { id: "claude", label: "Claude", aliases: ["claude", "claudeAgent", "claude-code"] },
    ];
    function agentMark(id) {
      const marks = {
        antigravity: '<path d="m3 20 9-17 9 17M7 14h10M12 9v11"/>',
        muse: '<path d="M3 19V5l9 10 9-10v14M7 19v-7m10 7v-7"/>',
        codex: '<path d="m8 5-6 7 6 7m8-14 6 7-6 7m-3-15-2 18"/>',
        pi: '<path d="M3 7h18M7 7v13m10-13v10q0 3 3 3M3 5l1-2"/>',
        claude: '<path d="M12 2v20M2 12h20M5 5l14 14M5 19 19 5M8 3l8 18M3 8l18 8M3 16l18-8M8 21 16 3"/>',
      };
      return `<svg class="hub-agent-mark" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${marks[id] || paths.hub}</svg>`;
    }
    function brandIcon(item, kind = "", small = false) {
      const candidate = state.dark && item.iconDarkDataUri ? item.iconDarkDataUri : item.iconDataUri || item.iconUrl || (typeof item.icon === "string" ? item.icon : item.icon?.url) || "";
      const url = String(candidate);
      const safe = /^(?:https?:\/\/[^\s/]+|data:image\/(?:png|jpeg|webp|gif|svg\+xml)[;,])/i.test(url) && !/[\u0000-\u001f\u007f]/.test(url);
      return `<span class="hub-brand-icon ${small ? "is-small" : ""} ${safe ? "has-image" : ""}">${icon(kind === "mcp" ? "plug" : "skill", small ? 14 : 18)}${safe ? `<img src="${esc(url)}" alt="${esc(item.displayName || item.title || item.name || item.id || "")}" referrerpolicy="no-referrer" data-dark-icon="${!!(state.dark && item.iconDarkDataUri)}" loading="lazy" decoding="async">` : ""}${kind === "mcp" ? `<i class="hub-connection-dot ${item.connected === true ? "is-connected" : ""}"></i>` : ""}</span>`;
    }
    function agentEnabled(item, host) {
      for (const source of [item.agents, item.agentStates, item.enabledAgents, item.hosts, item.agentStatus, item.perAgent]) {
        if (Array.isArray(source)) {
          const entry = source.find((value) => host.aliases.includes(typeof value === "string" ? value : value.id || value.agent || value.providerInstanceId));
          if (entry !== undefined) return typeof entry === "string" ? true : entry.enabled ?? entry.active ?? entry.installed ?? false;
          if (source.every((value) => typeof value === "string")) return false;
        } else if (source && typeof source === "object") {
          for (const alias of host.aliases) if (Object.prototype.hasOwnProperty.call(source, alias)) {
            const value = source[alias];
            return typeof value === "object" && value !== null ? value.enabled ?? value.active ?? value.installed ?? false : value === true || value === "enabled";
          }
        }
      }
      // Absence of per-host truth is unknown; never infer five enabled hosts.
      return false;
    }
    function resourceFilter(domain) { return state.resourceFilters[domain] ||= { agent: "all", status: "all" }; }
    function resourceMatches(item, domain) {
      const filter = resourceFilter(domain);
      const enabled = filter.agent === "all" ? agentHosts.some((host) => agentEnabled(item, host)) : agentEnabled(item, agentHosts.find((host) => host.id === filter.agent) || agentHosts[0]);
      return filter.status === "all" || (filter.status === "enabled" ? enabled : !enabled);
    }
    function resourceFilters(domain, queryName, query) {
      const filter = resourceFilter(domain);
      return `<div class="hub-resource-filters"><div class="hub-agent-filters" role="group" aria-label="Filter by Agent"><button type="button" class="hub-pill ${filter.agent === "all" ? "is-active" : ""}" data-action="resource-filter" data-domain="${domain}" data-agent="all" aria-pressed="${filter.agent === "all"}">${esc(tr("全部", "All"))}</button>${agentHosts.map((host) => `<button type="button" class="hub-pill ${filter.agent === host.id ? "is-active" : ""}" data-action="resource-filter" data-domain="${domain}" data-agent="${host.id}" aria-pressed="${filter.agent === host.id}">${agentMark(host.id)}${host.label}</button>`).join("")}</div><div class="hub-filter-bottom"><div class="hub-search">${icon("search", 13)}<input class="hub-input" name="${queryName}" value="${esc(query)}" placeholder="${esc(tr("搜索名称、描述…", "Search name, description…"))}" aria-label="${esc(tr("搜索资源", "Search resources"))}"></div><select class="hub-select" name="resource-status" data-domain="${domain}" aria-label="${esc(tr("启用状态", "Enabled status"))}">${[["all", "全部", "All"], ["enabled", "已启用", "Enabled"], ["disabled", "未启用", "Disabled"]].map(([value, zh, en]) => `<option value="${value}" ${filter.status === value ? "selected" : ""}>${esc(tr(zh, en))}</option>`).join("")}</select></div></div>`;
    }
    function agentToggleRow(item, domain) {
      const id = String(item.id || item.name), all = agentHosts.every((host) => agentEnabled(item, host));
      const attrs = `data-domain="${domain}" data-id="${esc(id)}" data-name="${esc(item.name || id)}"`;
      return `<div class="hub-resource-toggle" role="group" aria-label="${esc(item.displayName || item.name || id)} · ${esc(tr("五宿主启用", "Agent activation"))}"><button type="button" class="hub-btn hub-small" data-action="resource-toggle-all" ${attrs} data-enabled="${!all}" aria-pressed="${all}" ${item.unavailable ? "disabled" : ""}>${esc(tr("全部", "All"))}</button><div class="hub-agent-toggle">${agentHosts.map((host) => { const enabled = !!agentEnabled(item, host); return `<button type="button" data-action="resource-toggle" ${attrs} data-agent="${host.id}" data-enabled="${!enabled}" aria-pressed="${enabled}" title="${esc(`${host.label} · ${enabled ? tr("已启用", "Enabled") : tr("未启用", "Disabled")}`)}" ${item.unavailable ? "disabled" : ""}>${agentMark(host.id)}<span>${host.label}</span></button>`; }).join("")}</div></div>`;
    }
    async function toggleResource(element, all = false) {
      const { domain, id, name, agent } = element.dataset;
      const enabled = element.dataset.enabled === "true", projectRoot = state.projectRoot, version = contextVersion;
      const row = element.closest(".hub-resource-toggle");
      if (row?.dataset.busy === "true") return;
      if (row) { row.dataset.busy = "true"; row.querySelectorAll("button").forEach((button) => { button.disabled = true; }); }
      try {
        const targets = all ? agentHosts.map((host) => host.id) : [agent];
        const results = await Promise.allSettled(targets.map((host) => request(`${domain}:toggleAgent`, { id, name, agent: host, enabled, projectRoot })));
        if (disposed || version !== contextVersion) return;
        cache[domain] = await request(`${domain}:list`, { projectRoot });
        if (disposed || version !== contextVersion) return;
        invalidateSlashCache();
        if (state.tab === domain || domain === "mcp" && state.tab === "skills" && state.libraryView === "mcp") renderTab();
        const failed = results.filter((result) => result.status === "rejected");
        if (failed.length) throw new Error(`${tr("部分宿主未更新", "Some agents were not updated")} (${failed.length}/${targets.length}) · ${errorText(failed[0].reason)}`);
        toast(tr("宿主配置已更新", "Agent configuration updated"));
      } catch (error) { if (!disposed && version === contextVersion) toast(errorText(error), true); }
      finally { if (row?.isConnected) { delete row.dataset.busy; row.querySelectorAll("button").forEach((button) => { button.disabled = false; }); } }
    }
    const builtinHooks = [
      { id: "rememory-stop", title: " 收尾再记忆守门员", event: "Stop / SubagentStop", description: "任务收尾时整理第一现场经验，保留经过验证的项目记忆。", builtin: true, scope: "off", unavailable: true },
      { id: "secret-guard", title: " 敏感密钥提交守卫", event: "PreToolUse", description: "提交前检查敏感密钥，避免凭据进入版本历史。", builtin: true, scope: "off", unavailable: true },
      { id: "syntax-check", title: " JS/CJS 语法快检", event: "PostToolUse", description: "修改 JavaScript 后执行语法检查，及时发现错误。", builtin: true, scope: "off", unavailable: true },
    ];
    function hookItems() {
      const list = items(cache.hooks, ["items", "hooks"]);
      if (cache.hooks?.unavailable) return builtinHooks;
      const templates = { "memory-stop-guard": builtinHooks[0], "secret-commit-guard": builtinHooks[1], "js-syntax-postcheck": builtinHooks[2] };
      return list.map((item) => ({ ...item, title: templates[item.id]?.title || item.title || item.id, description: item.description || templates[item.id]?.description || "", event: item.event || items(item, ["events"]).join(" / ") }));
    }
    function renderHooks(target = content) {
      const list = hookItems();
      const draft = state.hookDraft;
      const group = (title, entries) => entries.length ? `<div class="hub-section-heading hub-group-heading"><span>${esc(title)}</span><span class="hub-count">${entries.length}</span></div><div class="hub-hook-group">${entries.map((item) => `<article class="hub-card hub-hook-card"><div class="hub-card-top"><div class="hub-grow"><div class="hub-card-name">${esc(item.title || item.id)}</div><div class="hub-card-meta"><span class="hub-badge hub-purple">${esc(item.event)}</span>${item.readonly ? `<span class="hub-badge">${esc(tr("外部 · 只读", "External · read-only"))}</span>` : ""}</div></div>${!item.builtin && !item.readonly ? button("delete-hook", tr("删除", "Delete"), { small: true, danger: true, attrs: `data-id="${esc(item.id)}"` }) : ""}</div><p class="hub-card-description">${esc(item.description || item.matcher || "")}</p>${item.command ? `<code class="hub-hook-command">${esc(redact(item.command))}</code>` : ""}${scopeControl("hook", item, !!(item.readonly || item.unavailable))}<div class="hub-confirm-delete" data-hook-confirm="${esc(item.id)}" hidden>${esc(tr("删除这个自定义 Hook？", "Delete this custom hook?"))}<div class="hub-row">${button("confirm-delete-hook", tr("确认删除", "Delete"), { small: true, danger: true, attrs: `data-id="${esc(item.id)}"` })}${button("cancel-delete-hook", tr("取消", "Cancel"), { small: true })}</div></div></article>`).join("")}</div>` : "";
      const external = new Map();
      list.filter((item) => !item.builtin).forEach((item) => { const key = item.source || tr("自定义", "Custom"); if (!external.has(key)) external.set(key, []); external.get(key).push(item); });
      target.innerHTML = `<div class="hub-section-heading"><span>${esc(tr("让工作流自动收尾", "A little automation, at the right moment"))}</span></div><p class="hub-description">${esc(tr("在关键生命周期运行检查与记忆整理。", "Run checks and memory routines at lifecycle events."))}</p>${button("new-hook", tr("新建自定义 Hook", "New custom hook"), { icon: "plus", primary: true, attrs: `aria-expanded="${!!draft}"` })}${draft ? `<form class="hub-form-panel" data-form="hook"><label class="hub-field">${esc(tr("名称", "Name"))}<input class="hub-input" name="hook-title" value="${esc(draft.title)}" placeholder="My workflow hook"></label><div class="hub-form-grid"><label class="hub-field">${esc(tr("生命周期事件", "Event"))}<select class="hub-select" name="hook-event">${["Stop", "SubagentStop", "PreToolUse", "PostToolUse", "SessionStart", "UserPromptSubmit", "PreCompact", "SessionEnd"].map((event) => `<option ${event === draft.event ? "selected" : ""}>${event}</option>`).join("")}</select></label><label class="hub-field">${esc(tr("范围", "Scope"))}<select class="hub-select" name="hook-scope">${["off", "project", "global"].map((scope) => `<option value="${scope}" ${scope === draft.scope ? "selected" : ""} ${scope === "project" && projectDisabled() ? "disabled" : ""}>${esc(scope === "off" ? tr("关闭", "Off") : scope === "project" ? tr("本项目", "Project") : tr("全局", "Global"))}</option>`).join("")}</select></label></div><label class="hub-field">Matcher<input class="hub-input" name="hook-matcher" value="${esc(draft.matcher)}" placeholder="Bash|Edit|Write"></label><label class="hub-field">${esc(tr("执行命令", "Command"))}<textarea class="hub-input" name="hook-command" rows="3" spellcheck="false">${esc(draft.command)}</textarea></label><div class="hub-row">${button("save-hook", tr("保存 Hook", "Save hook"), { primary: true, icon: "save" })}${button("cancel-hook", tr("取消", "Cancel"))}</div></form>` : ""}${errors.hooks ? inlineError(errors.hooks) : !cache.hooks ? loading() : `${cache.hooks.unavailable ? `<p class="hub-hint hub-domain-hint">${esc(tr("Hooks 服务尚未接入，以下为内置模板预览。", "Hooks service is not connected. Built-in templates are previewed below."))}</p>` : ""}${group(tr("内置 Hooks", "Built-in hooks"), list.filter((item) => item.builtin))}${[...external].map(([name, entries]) => group(name, entries)).join("")}${!list.length ? empty(tr("还没有 Hook", "No hooks yet")) : ""}`}`;
    }

    function sourceLabel(source, fallback) {
      const key = String(source || "").toLowerCase();
      return ({ "codex-market": tr("Codex 市场", "Codex market"), marketplace: tr("Codex 市场", "Codex market"), github: "GitHub", zcode: "ZCode", claude: "Claude", global: tr("全局", "Global"), archive: tr("归档", "Archived"), archived: tr("归档", "Archived"), magpie: "Magpie", custom: tr("自定义", "Custom"), hub: tr("自定义", "Custom"), cli: "CLI" })[key] || fallback || source || tr("本地", "Local");
    }
    function renderTab() {
      if (!content || disposed) return;
      if (state.tab === "skills") state.libraryView === "mcp" ? renderMcp() : renderSkills();
      if (state.tab === "subagents") renderSubagents();
      if (state.tab === "memory") renderMemory();
      if (state.tab === "board") renderBoardTab();
      if (state.tab === "settings") renderSettings();
    }
    function librarySegments() { return `<div class="hub-segments">${[["skills", "Skills 技能"], ["mcp", "MCP 服务"]].map(([key, label]) => `<button type="button" class="hub-pill ${state.libraryView === key ? "is-active" : ""}" data-action="library-view" data-view="${key}" aria-pressed="${state.libraryView === key}">${esc(label)}</button>`).join("")}</div>`; }
    function renderSkills() {
      content.innerHTML = `${librarySegments()}<div class="hub-section-heading"><span>${esc(tr("Skills 技能", "Skills"))}</span><span class="hub-count" id="t3-hub-skills-count"></span></div><p class="hub-description">${esc(tr("为五位 AI 搭档按需启用技能，读取各宿主的真实状态。", "Choose skills for each agent using live host configuration."))}</p>${resourceFilters("skills", "skillQuery", state.skillQuery)}<details class="hub-import"><summary class="hub-import-title">${icon("github", 14)}${esc(tr("从 GitHub 导入技能", "Import skills from GitHub"))}</summary><form data-form="import"><div class="hub-import-grid"><input class="hub-input" name="repoInput" aria-label="GitHub repository" placeholder="owner/repo" value="${esc(state.importRepo)}" autocomplete="off" spellcheck="false"><select class="hub-select" name="importScope" aria-label="${esc(tr("导入范围", "Import scope"))}"><option value="project" ${state.importScope === "project" ? "selected" : ""} ${projectDisabled() ? "disabled" : ""}>${esc(tr("仅本项目", "Project"))}</option><option value="global" ${state.importScope === "global" ? "selected" : ""}>${esc(tr("全局", "Global"))}</option></select>${button("import-skill", tr("导入", "Import"), { icon: "plus", primary: true })}</div></form></details><div class="hub-filters" id="t3-hub-skill-filters"></div><div id="t3-hub-skill-list"></div>`;
      renderSkillList();
    }
    function renderSkillList() {
      if (state.tab !== "skills" || disposed) return;
      const filters = [["all", tr("全部来源", "All sources")], ["project", tr("当前项目", "Project")], ["codex-market", tr("插件技能", "Plugin skills")], ["github", "GitHub"]];
      root.querySelector("#t3-hub-skill-filters").innerHTML = filters.map(([key, label]) => `<button type="button" class="hub-pill ${state.skillFilter === key ? "is-active" : ""}" data-action="skill-filter" data-filter="${key}" aria-pressed="${state.skillFilter === key}">${esc(label)}</button>`).join("");
      const all = items(cache.skills, ["items", "skills", "plugins"]), query = state.skillQuery.trim().toLowerCase();
      const filtered = all.filter((item) => {
        const filter = state.skillFilter;
        const matches = filter === "all" || filter === "enabled" && agentHosts.some((host) => agentEnabled(item, host)) || filter === "project" && item.scope === "project" || filter === "codex-market" && /codex|market|plugin/.test(item.source || "") || filter === "github" && item.source === "github";
        return matches && resourceMatches(item, "skills") && (!query || `${item.name} ${item.displayName} ${item.description} ${item.id}`.toLowerCase().includes(query));
      });
      root.querySelector("#t3-hub-skills-count").textContent = `${all.length} ${tr("项", "skills")}`;
      root.querySelector("#t3-hub-skill-list").innerHTML = errors.skills ? inlineError(errors.skills) : !cache.skills ? loading() : !filtered.length ? empty(tr("没有匹配的技能", "No matching skills"), tr("更换筛选条件，或导入一个技能。", "Change filters or import a skill."), "skill") : filtered.map((item) => `<article class="hub-resource-row">${brandIcon(item)}<div class="hub-grow"><div class="hub-card-name">${esc(item.displayName || item.name || item.id)}</div><div class="hub-hint">${esc(sourceLabel(item.source, item.sourceLabel))}</div><p class="hub-card-description">${esc(item.shortDescription || item.description || tr("暂无描述", "No description available"))}</p>${item.updatable ? `<div class="hub-editor-actions">${button("update-skill", tr("更新", "Update"), { small: true, icon: "refresh", attrs: `data-id="${esc(item.id)}"` })}${button("remove-skill", tr("移除技能包", "Remove package"), { small: true, attrs: `data-id="${esc(item.id)}"` })}</div><div data-skill-confirm class="hub-confirm-delete" hidden>${esc(tr("移除整个来源技能包及其启用链接？", "Remove this package and its activation links?"))}<div class="hub-row">${button("confirm-remove-skill", tr("确认移除", "Remove"), { small: true, attrs: `data-id="${esc(item.id)}"` })}${button("cancel-remove-skill", tr("取消", "Cancel"), { small: true })}</div></div>` : ""}</div>${agentToggleRow(item, "skills")}</article>`).join("");
    }

    const mcpModes = () => [["off", tr("关闭", "Off")], ["project-lazy", tr("本项目·懒加载 (省Token)", "Project · Lazy (saves tokens)")], ["project-direct", tr("本项目·直连", "Project · Direct")], ["global-lazy", tr("全局·懒加载", "Global · Lazy")], ["global-direct", tr("全局·直连", "Global · Direct")]];
    const providerDefaults = [
      { id: "muse", label: "Muse" }, { id: "codex", label: "Codex" }, { id: "pi", label: "Pi·Magpie" },
      { id: "antigravity", label: "Antigravity" }, { id: "claudeAgent", label: "Claude" },
    ];
    const effortNames = { max: "最高", xhigh: "超高", high: "高", medium: "中", low: "低", minimal: "极简" };
    const subagentRoles = { research: ["search", "var(--hud-emerald)", "只读调查"], implementation: ["bolt", "var(--hud-blue)", "全部工具"], general: ["hub", "var(--hud-blue)", "全部工具"], design: ["spark", "var(--hud-violet)", "界面+截图"], test: ["check", "var(--hud-amber)", "LCU+测试"], review: ["edit", "var(--hud-fg)", "只读审查"] };
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
      return `<select class="hub-select hub-memory-policy policy-${policy}" name="subagent-memoryPolicy" data-subagent-id="${esc(id)}" aria-label="${esc(tr("记忆权限", "Memory policy"))} · ${esc(id)}" ${disabled ? "disabled" : ""}>${[["readwrite", tr(" 第一现场读写记忆", " First-hand memory · read & write")], ["readonly", tr(" 只读项目记忆", " Project memory · read only")], ["off", tr(" 不挂载记忆", " No memory")]].map(([value, label]) => `<option value="${value}" ${value === policy ? "selected" : ""}>${esc(label)}</option>`).join("")}</select>`;
    }
    function renderBotAvatar(item) { return `<span class="hub-asset-icon" style="width:28px;height:28px">${icon((subagentRoles[item.role] || subagentRoles.general)[0], 15)}</span>`; }
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
      return `<div class="hub-subagent-controls"><select class="hub-select" name="subagent-provider" aria-label="${esc(tr("执行 Agent", "Execution agent"))} · ${esc(cardId)}" ${attrs}>${providers.map((provider) => `<option value="${esc(provider.id)}" ${provider.id === providerId ? "selected" : ""}>${esc(provider.label || provider.id)}</option>`).join("")}</select><select class="hub-select" name="subagent-model" aria-label="${esc(tr("模型", "Model"))} · ${esc(cardId)}" title="${esc(item.model || "")}" ${attrs}>${!item.model ? `<option value="" selected disabled>${esc(tr("选择模型", "Choose model"))}</option>` : ""}${models.map((model) => `<option value="${esc(model.id)}" ${model.id === item.model ? "selected" : ""}>${esc(model.label || model.id)}</option>`).join("")}<option value="__custom__">${esc(tr("自定义模型…", "Custom model…"))}</option></select><select class="hub-select" name="subagent-effort" title=" ${esc(tr(effortNames[effort] || effort, effort))} (${esc(effort)})" aria-label="${esc(tr("思考程度", "Reasoning effort"))} · ${esc(cardId)}" ${attrs}>${providerEfforts(providerId, effort).map((value) => `<option value="${esc(value)}" ${value === effort ? "selected" : ""} label=" ${esc(tr(effortNames[value] || value, value))}"> ${esc(tr(effortNames[value] || value, value))} (${esc(value)})</option>`).join("")}</select></div>`;
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
      content.innerHTML = `${renderCommander()}<div class="hub-subagent-scopes" aria-label="${esc(tr("子智能体作用域", "Agent scope"))}"><button type="button" class="hub-subagent-scope" data-action="subagent-scope" data-scope="global" aria-pressed="${scope === "global"}"> ${esc(tr("全局子智能体", "Global agents"))}<small>${esc(tr("全项目通用", "Across all projects"))}</small></button><button type="button" class="hub-subagent-scope" data-action="subagent-scope" data-scope="project" aria-pressed="${scope === "project"}" ${projectDisabled() ? "disabled" : ""} title="${esc(projectTitle())}"> ${esc(tr("项目子智能体", "Project agents"))}<small>${esc(tr("仅当前项目", "This project only"))}</small></button></div><div class="hub-subagent-heading"><h3>${esc(label)}<span>${esc(count)}</span></h3>${button("new-subagent", tr("新建子智能体", "New agent"), { small: true, primary: true, icon: "plus", disabled: scope === "project" && projectDisabled() })}</div><p class="hub-description">${esc(scope === "global" ? tr("为常用任务配好搭档。切换 Agent、模型或思考程度，即时保存。", "Choose your team. Agent, model, and effort changes save instantly.") : tr("为当前项目定制模型与提示词，同名配置优先于全局模板。", "Customize models and prompts here. Matching IDs override global templates."))}</p>${newDraft ? `<article class="hub-card">${subagentControls(newDraft, "__new__")}${state.subagentCustom[subagentKey("__new__")] ? `<div class="hub-subagent-custom"><label class="hub-field"><span>${esc(tr("自定义模型 ID", "Custom model ID"))}</span><div class="hub-row"><input class="hub-input" name="subagent-customModel" data-subagent-id="__new__" value="${esc(state.subagentCustom[subagentKey("__new__")].value || "")}" placeholder="group/1m-auto" spellcheck="false">${button("save-subagent-model", tr("使用模型", "Use model"), { small: true, primary: true, attrs: 'data-id="__new__"' })}${button("cancel-subagent-model", tr("取消", "Cancel"), { small: true, attrs: 'data-id="__new__"' })}</div></label></div>` : ""}${renderSubagentEditor(newDraft, "__new__", true)}</article>` : ""}${errors.subagents ? inlineError(errors.subagents) : !cache.subagents ? loading() : scope === "project" && projectDisabled() ? empty(tr("请先打开一个项目", "Open a project first"), "", "folder") : cards ? `<div class="hub-subagent-list">${cards}</div>` : `${empty(scope === "project" ? tr("这个项目，还没有专属搭档", "No project agents yet") : tr("还没有全局子智能体", "No global agents yet"), scope === "project" ? tr("当前仍使用全局子智能体。克隆一个模板，即可单独定制。", "Global agents remain available. Clone a template to customize it here.") : tr("新建子智能体，为常用任务配置专属助手。", "Create an agent for your recurring tasks."), "hub")}${scope === "project" ? `<div class="hub-subagent-clones"><strong>${esc(tr("从全局模板克隆定制…", "Customize a global template…"))}</strong><div class="hub-row">${subagentItems("global").filter((item) => ["worker", "explorer", "frontend"].includes(subagentId(item))).map((item) => button("clone-subagent", item.name || subagentId(item), { small: true, icon: "plus", attrs: `data-id="${esc(subagentId(item))}"` })).join("") || `<span class="hub-description">${esc(tr("先创建一个全局模板，或直接新建项目子智能体。", "Create a global template or a new project agent."))}</span>`}</div></div>` : ""}` }<div class="hub-subagent-note">${icon("check", 13)}<span>${esc(scope === "global" ? tr("保存后自动注入全局 AGENTS.md，并同步 5 个 CLI。", "Saving injects global AGENTS.md and synchronizes five CLIs.") : tr("保存后自动写入本项目 AGENTS.md，其他项目保持各自配置。", "Saving injects this project's AGENTS.md. Other projects keep their own settings."))}</span></div>`;
      content.innerHTML += `<details class="hub-import" ${state.hooksOpen ? "open" : ""}><summary data-action="hooks-fold">${esc(tr("高级生命周期 Hooks", "Advanced lifecycle hooks"))}</summary><div id="t3-hub-hooks-section"></div></details>`;
      const hooksSection = root.querySelector("#t3-hub-hooks-section"); if (hooksSection) renderHooks(hooksSection);
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
        const result = await request("subagents:update", { scope, projectRoot, item });
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
        const result = await request("subagents:update", { scope: "project", projectRoot, item: { ...item, memoryPolicy: memoryPolicy(item), id, scope: "project", projectRoot, builtin: false, builtIn: false, isBuiltin: false, overridesGlobal: true } });
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
      content.innerHTML = `${librarySegments()}<div class="hub-section-heading"><span>${esc(tr("MCP 服务", "MCP servers"))}</span>${button("probe-mcp", tr("检测连通性", "Probe connections"), { small: true, icon: "refresh" })}</div><p class="hub-description">${esc(tr("按宿主连接工具，按需加载。开关状态来自各宿主配置。", "Connect tools per agent, on demand, with live host configuration."))}</p>${resourceFilters("mcp", "mcpQuery", state.mcpQuery)}<div class="hub-editor-actions">${button("toggle-mcp-add", tr("添加 MCP", "Add MCP"), { small: true, icon: "plus", attrs: `aria-expanded="${state.mcpAddOpen}"` })}${button("sync-mcp", tr("同步五宿主", "Sync agents"), { small: true })}</div><div class="hub-form-panel" id="t3-hub-mcp-form" ${state.mcpAddOpen ? "" : "hidden"}></div><div id="t3-hub-mcp-list"></div>`;
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
      if ((state.tab !== "skills" || state.libraryView !== "mcp") || disposed || !node) return;
      if (errors.mcp || !cache.mcp) { node.innerHTML = errors.mcp ? inlineError(errors.mcp) : loading(); return; }
      const query = state.mcpQuery.trim().toLowerCase();
      const servers = mcpServers().filter((server) => resourceMatches(server, "mcp") && (!query || `${server.name} ${server.displayName} ${server.groupTitle} ${server.description || ""}`.toLowerCase().includes(query)));
      node.innerHTML = servers.map((server) => {
        const mode = mcpMode(server), summary = redact(server.summary || server.url || [server.command, ...items(server, ["args"])].filter(Boolean).join(" "));
        const removable = server.removable === true || !server.builtin && !server.readonly && ["custom", "hub"].includes(server.source);
        return `<article class="hub-resource-row hub-mcp-row" data-mcp-name="${esc(server.name)}">${brandIcon(server, "mcp")}<div class="hub-grow"><div class="hub-resource-title"><span class="hub-mcp-name">${esc(server.displayName || server.title || server.name)}</span><span class="hub-badge">${esc(server.connected === true ? tr("已连接", "Connected") : server.connected === false ? tr("未连接", "Disconnected") : tr("按需唤醒", "On demand"))}</span></div><p class="hub-card-description">${esc(server.shortDescription || server.description || summary || tr("工具服务", "Tool server"))}</p><div class="hub-mcp-row-options"><select class="hub-select hub-mode-pill" name="mcp-mode" data-name="${esc(server.name)}" aria-label="${esc(server.name)} ${esc(tr("连接模式", "Connection mode"))}">${mcpModes().map(([value, label]) => `<option value="${value}" ${mode === value ? "selected" : ""} ${value.startsWith("project-") && projectDisabled() ? "disabled" : ""}>${esc(label)}</option>`).join("")}</select>${removable ? `<button type="button" class="hub-icon-btn" data-action="remove-mcp" data-name="${esc(server.name)}" aria-label="${esc(tr("移除", "Remove"))} ${esc(server.name)}">${icon("trash", 12)}</button>` : ""}</div><div class="hub-confirm-delete" data-mcp-confirm hidden>${esc(tr("移除此自定义 MCP？", "Remove this custom MCP?"))}<div class="hub-row">${button("confirm-remove-mcp", tr("移除", "Remove"), { small: true, attrs: `data-name="${esc(server.name)}"` })}${button("cancel-remove-mcp", tr("取消", "Cancel"), { small: true })}</div></div></div>${agentToggleRow(server, "mcp")}</article>`;
      }).join("") || empty(tr("没有匹配的 MCP", "No matching MCP servers"));
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
      return { projectRoot: selectedMemoryRoot(), projectSlug: projectSlug || undefined, scope: state.memoryProject === "global" ? "global" : "project", scopeFilter: state.memoryScope === "smart" ? "default" : state.memoryScope === "project" ? "shared" : state.memoryScope, module: state.memoryModule === "all" ? undefined : state.memoryModule, query: state.memoryQuery.trim(), limit: 500 };
    }
    function moduleOptions() {
      return [["all", tr("全部", "All"), ""], ["constraints", tr("铁律", "Rules"), ""], ["pitfalls", tr("踩坑", "Pitfalls"), ""], ["architecture", tr("架构", "Architecture"), ""], ["topics", tr("专题", "Topics"), ""]];
    }
    function normalizeModule(module) {
      return ({ constraint: "constraints", rule: "constraints", rules: "constraints", pitfall: "pitfalls", experience: "pitfalls", topic: "topics", "topic-memory": "topics", memory: "constraints" })[module] || module || "topics";
    }
    function renderMemory() {
      content.innerHTML = `<div id="t3-hub-dream"></div><details class="hub-import"><summary>向量引擎与管理</summary><div id="t3-hub-memory-governance"></div><div id="t3-hub-engine"></div></details><div class="hub-section-heading"><span>${esc(tr("让经验留在项目里", "Keep what your projects learn"))}</span><span class="hub-count" id="t3-hub-memory-total"></span></div><div id="t3-hub-worktree"></div><div id="t3-hub-memory-nav"></div><div id="t3-hub-new-memory"></div><div class="hub-search">${icon("search", 14)}<input class="hub-input" name="memoryQuery" aria-label="${esc(tr("搜索记忆", "Search memories"))}" placeholder="${esc(tr("搜索记忆 · 关键词 + 语义", "Search memories · Keywords + meaning"))}" value="${esc(state.memoryQuery)}"></div><div id="t3-hub-memory-filters" class="hub-filters hub-memory-filters"></div><div id="t3-hub-memory-list"></div>`;
      renderEngine();
      renderDream();
      renderWorktreeScopes();
      renderMemoryNav();
      renderMemoryList();
      renderNewMemory();
    }
    function dreamConfig() {
      const data = cache.dream?.config || cache.dream?.dream || cache.dream || cache.overview?.dream || {};
      return { dreamMode: "agent", providerInstanceId: "muse", model: "muse-ember-1.0", maxInputTokens: 8000, ...data, enabled: data.enabled === true, dreamTime: /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(data.dreamTime || "") ? data.dreamTime : "03:00", catchUpOnWake: data.catchUpOnWake !== false };
    }
    function dreamPresets() {
      const presets = items(cache.dream, ["presets", "dreamAgentPresets", "DREAM_AGENT_PRESETS"]);
      if (presets.length) return presets;
      return [
        { id: "local-zero", dreamMode: "local", providerInstanceId: "local", model: "mlx-vector-only", label: tr("纯本地向量聚变 · 0 Token ($0/晚)", "Local vector fusion · 0 tokens ($0/night)"), estCostPerNightUsd: 0 },
        { id: "muse-ember", dreamMode: "agent", providerInstanceId: "muse", model: "muse-ember-1.0", label: "Muse · muse-ember-1.0", estCostPerNightUsd: 0.0018 },
        { id: "codex-terra", dreamMode: "agent", providerInstanceId: "codex", model: "gpt-6.1-terra", label: "Codex · gpt-6.1-terra", estCostPerNightUsd: 0.012 },
        { id: "codex-sol", dreamMode: "agent", providerInstanceId: "codex", model: "gpt-6.1-sol", label: "Codex · gpt-6.1-sol", estCostPerNightUsd: 0.018 },
        { id: "claude-sonnet", dreamMode: "agent", providerInstanceId: "claude", model: "claude-sonnet-4-6", label: "Claude · claude-sonnet-4-6", estCostPerNightUsd: 0.015 },
        { id: "pi-magpie", dreamMode: "agent", providerInstanceId: "pi", model: "magpie/group/code", label: "Pi · magpie/group/code", estCostPerNightUsd: 0.005 },
      ];
    }
    function renderDream() {
      const node = root.querySelector("#t3-hub-dream");
      if (!node) return;
      const data = dreamConfig(), overview = cache.overview || {}, busy = state.dreamSaving || state.dreamRunning;
      const loaded = !!(cache.dream || overview.dream);
      const report = data.lastReport || cache.dream?.lastReport || overview.dream?.lastReport;
      const presets = dreamPresets();
      const current = presets.find((preset) => preset.dreamMode === data.dreamMode && preset.providerInstanceId === data.providerInstanceId && preset.model === data.model);
      const metric = (value) => Math.max(0, Number(value) || 0).toLocaleString(state.lang === "en" ? "en-US" : "zh-CN", { maximumFractionDigits: 2 });
      const cost = (value, digits = 6) => `$${Number(value).toFixed(digits).replace(/\.?0+$/, "") || "0"}`;
      const tokenLimit = Number(data.maxInputTokens) || 8000;
      const tokenLabel = tokenLimit >= 1000 ? `${Math.round(tokenLimit / 100) / 10}K` : String(tokenLimit);
      const budget = data.dreamMode === "local" ? tr("0 Token 本地 · $0/晚", "0 tokens · Local · $0/night") : tr(`上限 <${tokenLabel} tok${current?.estCostPerNightUsd != null ? ` · 约 ${cost(current.estCostPerNightUsd, 3)}/晚` : ""}`, `Cap <${tokenLabel} tok${current?.estCostPerNightUsd != null ? ` · ~${cost(current.estCostPerNightUsd, 3)}/night` : ""}`);
      const summary = report ? tr(`上次梦境：合并 ${metric(report.mergedCount)} 条 · 提纯晋升 ${metric(report.promotedCount)} 条 · 归档 ${metric(report.archivedCount)} 条 · 耗时 ${metric(report.durationMs)}ms`, `Last dream: ${metric(report.mergedCount)} merged · ${metric(report.promotedCount)} promoted · ${metric(report.archivedCount)} archived · ${metric(report.durationMs)}ms`) : tr("尚未运行梦境周期 · 开启后将在每日设定时间自动聚变去重、提纯分支经验并归档冷数据", "No dream cycle yet. Enable daily merging, branch-knowledge promotion, and cold-memory archiving.");
      const agent = report?.agentUsed;
      const consumption = report ? [agent === false || report.dreamMode === "local" ? tr("本地整理", "Local processing") : typeof agent === "string" ? agent : agent && typeof agent === "object" ? [agent.providerInstanceId || agent.provider, agent.model].filter(Boolean).join(" · ") : agent === true ? tr("后台 Agent", "Background agent") : "", report.estimatedInputTokens != null ? `${metric(report.estimatedInputTokens)} input tok` : "", report.estimatedCostUsd != null ? tr(`预估 ${cost(report.estimatedCostUsd)}`, `Estimated ${cost(report.estimatedCostUsd)}`) : ""].filter(Boolean).join(" · ") : "";
      const status = state.dreamRunning ? tr("正在整理…", "Dreaming…") : state.dreamSaving ? tr("保存中…", "Saving…") : !loaded ? tr("正在读取", "Loading") : data.enabled ? tr(`已开启 · 每日 ${data.dreamTime}`, `Enabled · Daily ${data.dreamTime}`) : tr("未开启", "Disabled");
      node.innerHTML = `<details class="hub-dream-card" ${state.dreamOpen ? "open" : ""}><summary data-action="dream-fold">AutoDream · ${esc(status)} · ${esc(metric(cache.embed?.vectorStats?.syncedVectors))}/${esc(metric(cache.embed?.vectorStats?.totalMemories))} ${esc(tr("向量同步", "vectors synced"))} · ${esc(tr("配置 / 立即整理", "Configure / Dream now"))}</summary><section aria-label="${esc(tr("梦境整理 · AutoDream", "Memory Dream · AutoDream"))}" aria-busy="${busy}"><div class="hub-dream-heading"><span class="hub-dream-title">${icon("moon", 16)}${esc(tr("梦境整理", "Memory Dream"))} · AutoDream</span><span class="hub-badge">${esc(status)}</span><span class="hub-dream-size">${esc(tr(`索引体积 ${metric(overview.dbSizeMb ?? report?.dbSizeMb)} MB`, `Index size ${metric(overview.dbSizeMb ?? report?.dbSizeMb)} MB`))}</span></div><p class="hub-dream-description">${esc(tr("T3 开着，就会在设定时间整理记忆。", "Keep T3 open to organize memory at the chosen time."))}</p><div class="hub-dream-engine-row"><label class="hub-field hub-dream-engine">${esc(tr("执行引擎 · 后台 Agent / 模型", "Execution engine · Background agent / model"))}<select class="hub-select" name="dream-engine" aria-label="${esc(tr("AutoDream 执行引擎", "AutoDream execution engine"))}" ${busy || !loaded ? "disabled" : ""}>${!current ? `<option value="__current__" selected>${esc(`${data.providerInstanceId} · ${data.model}`)}</option>` : ""}${presets.map((preset) => `<option value="${esc(preset.id)}" ${current?.id === preset.id ? "selected" : ""}>${esc(preset.label || `${preset.providerInstanceId} · ${preset.model}`)}</option>`).join("")}</select></label><span class="hub-dream-budget" aria-label="${esc(tr("省流闸门", "Token budget"))}">${icon("bolt", 11)}${esc(budget)}</span></div><div class="hub-dream-controls"><span class="hub-dream-enable"><span>${esc(tr("启用", "Enable"))}</span><button type="button" role="switch" class="hub-switch" data-action="toggle-dream" aria-label="${esc(tr("启用每日梦境整理", "Enable daily Memory Dream"))}" aria-checked="${data.enabled}" ${busy || !loaded ? "disabled" : ""}><span></span></button></span><label class="hub-dream-time">${esc(tr("每日", "Daily"))}<input class="hub-input" name="dream-time" type="time" value="${esc(data.dreamTime)}" step="60" aria-label="${esc(tr("每日做梦时间", "Daily dream time"))}" ${busy || !loaded ? "disabled" : ""}></label><label class="hub-checkbox"><input type="checkbox" name="dream-catch-up" ${data.catchUpOnWake ? "checked" : ""} ${busy || !loaded ? "disabled" : ""}>${esc(tr("休眠唤醒补梦", "Catch up on wake"))}</label>${button("run-dream", state.dreamRunning ? tr("整理中…", "Dreaming…") : tr("立即做梦", "Dream now"), { primary: true, small: true, icon: state.dreamRunning ? undefined : "moon", disabled: busy || !loaded })}</div><div class="hub-dream-report">${state.dreamRunning ? `${spinner()} ` : ""}${esc(summary)}${consumption ? `<div class="hub-dream-consumption">${esc(consumption)}</div>` : ""}${overview.archivedCount != null || overview.staleVectorCount != null ? `<div class="hub-hint">${esc(tr(`已归档 ${metric(overview.archivedCount)} 条 · 待同步向量 ${metric(overview.staleVectorCount)} 条`, `${metric(overview.archivedCount)} archived · ${metric(overview.staleVectorCount)} stale vectors`))}</div>` : ""}</div><div class="hub-dream-times"><span>${esc(tr("最近浅睡", "Last light sleep"))} ${data.lastDreamAt ? exactTimeMarkup(data.lastDreamAt) : "—"}</span><span>${esc(tr("最近深睡", "Last deep sleep"))} ${data.lastAgentDreamAt ? exactTimeMarkup(data.lastAgentDreamAt) : "—"}</span></div>${errors.dream ? `<p class="hub-dream-error" role="alert">${esc(errorText(errors.dream))}</p>` : ""}</section></details>`;
    }
    async function saveDream(patch) {
      if (disposed || state.dreamSaving || state.dreamRunning) return;
      const data = { ...dreamConfig(), ...patch };
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(data.dreamTime || "")) { toast(tr("请选择有效时间（HH:MM）", "Choose a valid time (HH:MM)"), true); renderDream(); return; }
      const version = contextVersion;
      state.dreamSaving = true; delete errors.dream; renderDream();
      try {
        const payload = { enabled: data.enabled, dreamTime: data.dreamTime, catchUpOnWake: data.catchUpOnWake, dreamMode: data.dreamMode, providerInstanceId: data.providerInstanceId, model: data.model, maxInputTokens: data.maxInputTokens, ...(data.reasoningEffort ? { reasoningEffort: data.reasoningEffort } : {}) };
        let result;
        try { result = await request("memory:dream:save", payload); }
        catch (error) {
          if (!/unknown|unsupported|unrecognized|not found|未知|不支持/i.test(errorText(error))) throw error;
          result = await request("memory:dream:update", payload);
        }
        if (disposed || version !== contextVersion) return;
        cache.dream = { ...cache.dream, ...result, config: { ...data, ...(result.config || result.dream || {}) } };
        if (cache.overview) cache.overview.dream = cache.dream.config;
        toast(tr("梦境设置已保存", "Memory Dream settings saved"));
      } catch (error) { if (!disposed && version === contextVersion) { errors.dream = error; toast(errorText(error), true); } }
      finally { state.dreamSaving = false; if (!disposed) renderDream(); }
    }
    async function runDream() {
      if (disposed || state.dreamSaving || state.dreamRunning) return;
      const version = contextVersion, projectRoot = state.projectRoot;
      state.dreamRunning = true; delete errors.dream; renderDream();
      try {
        const result = await request("memory:dream:run", { projectRoot });
        if (disposed || version !== contextVersion) return;
        cache.dream = { ...cache.dream, ...result, config: { ...dreamConfig(), ...(result.config || {}), ...(result.report ? { lastReport: result.report } : {}) } };
        if (cache.overview) cache.overview.dream = cache.dream.config;
        await Promise.all([refreshMemoryOverview(), refreshEmbed(false, true), loadMemories(false)]);
        if (disposed || version !== contextVersion) return;
        if (state.tab === "memory") { renderEngine(); renderMemoryList(); }
        toast(tr("梦境整理已完成", "Memory Dream completed"));
      } catch (error) { if (!disposed && version === contextVersion) { errors.dream = error; toast(errorText(error), true); } }
      finally { state.dreamRunning = false; if (!disposed) renderDream(); }
    }
    function renderWorktreeScopes() {
      const node = root.querySelector("#t3-hub-worktree");
      if (!node) return;
      const info = cache.worktree || {};
      node.innerHTML = `<div class="hub-worktree-bar"><div class="hub-segments" role="group" aria-label="${esc(tr("记忆范围", "Memory scope"))}">${[["smart", tr("智能默认（共享 + 当前工作树）", "Smart · Shared + current tree")], ["project", tr("项目长期共享", "Shared project memory")], ["worktree", tr("当前工作树便签", "Current worktree notes")], ["global", tr("全局通用", "Global")]].map(([scope, label]) => `<button type="button" class="${state.memoryScope === scope ? "is-active" : ""}" data-action="memory-scope-filter" data-scope="${scope}" aria-pressed="${state.memoryScope === scope}">${esc(label)}</button>`).join("")}</div><div class="hub-worktree-caption"><span>${esc(info.branch || info.branchName || info.worktreeName || tr("共享经验，隔离工作树便签", "Shared knowledge, isolated worktree notes"))}</span>${button("open-memory-folder", tr("打开记忆文件夹", "Open memory folder"), { small: true, icon: "folder" })}</div></div>`;
      if (errors.worktree) node.insertAdjacentHTML("beforeend", `<p class="hub-hint">${esc(errorText(errors.worktree))}</p>`);
    }
    async function setMemoryScope(scope) {
      state.memoryScope = scope;
      if (scope === "global") state.memoryProject = "global";
      else if (state.memoryProject === "global" && state.projectRoot) state.memoryProject = "current";
      state.selectedMemory = null; cache.memory = null; memoryVersion++;
      renderWorktreeScopes(); renderMemoryNav(); renderMemoryList();
      await loadMemories();
    }
    async function promoteMemory(id, element) {
      const version = contextVersion, payload = memoryPayload();
      await busy(`memory-promote:${id}`, element, async () => {
        await request("memory:promote", { ...payload, id, scope: "project" });
        if (disposed || version !== contextVersion) return;
        await loadMemories(); toast(tr("已提炼为项目长期共享记忆", "Promoted to shared project memory"));
      });
    }
    function curatedModels() {
      const models = items(cache.embed, ["models", "presets", "availableModels"]);
      // The zero-RAM preset is added below alongside every backend-provided model.
      const defaults = [
        {"id": "mlx-community/Qwen3-Embedding-4B-4bit-DWQ", "name": "Qwen3 Embedding 4B · 4-bit DWQ (40亿参数旗舰)", "sizeMb": 2080, "estRamMb": 2150, "ceilingMb": 2932, "dim": 2560, "idealRamTier": "flagship", "description": "多语言高精度检索 · 96GB 旗舰首选"},
        {"id": "Qwen/Qwen3-Embedding-0.6B", "name": "Qwen3 Embedding 0.6B · BF16 (原生满血无损)", "sizeMb": 1150, "estRamMb": 1200, "ceilingMb": 1716, "dim": 1024, "idealRamTier": "flagship"},
        {"id": "mlx-community/bge-m3-mlx-fp16", "name": "BGE-M3 · FP16 (原生满血无损)", "sizeMb": 1100, "estRamMb": 1160, "ceilingMb": 1665, "dim": 1024, "idealRamTier": "workstation"},
        {"id": "mlx-community/Qwen3-Embedding-0.6B-8bit", "name": "Qwen3 Embedding 0.6B · 8-bit", "sizeMb": 604, "estRamMb": 680, "ceilingMb": 1050, "dim": 1024, "idealRamTier": "workstation"},
        {"id": "mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ", "name": "Qwen3 Embedding 0.6B · 4-bit DWQ", "sizeMb": 320, "estRamMb": 380, "ceilingMb": 666, "dim": 1024, "idealRamTier": "standard"},
        {"id": "mlx-community/bge-m3-mlx-8bit", "name": "BGE-M3 · 8-bit", "sizeMb": 576, "estRamMb": 650, "ceilingMb": 1012, "dim": 1024, "idealRamTier": "workstation"},
        {"id": "mlx-community/bge-m3-mlx-4bit", "name": "BGE-M3 · 4-bit", "sizeMb": 305, "estRamMb": 360, "ceilingMb": 641, "dim": 1024, "idealRamTier": "standard"},
        {"id": "mlx-community/embeddinggemma-300m-8bit", "name": "EmbeddingGemma 300M · 8-bit", "sizeMb": 312, "estRamMb": 370, "ceilingMb": 654, "dim": 768, "idealRamTier": "standard"},
        {"id": "mlx-community/embeddinggemma-300m-4bit", "name": "EmbeddingGemma 300M · 4-bit", "sizeMb": 165, "estRamMb": 220, "ceilingMb": 462, "dim": 768, "idealRamTier": "compact"},
        {"id": "mlx-community/snowflake-arctic-embed-l-v2.0-8bit", "name": "Arctic Embed L v2 · 8-bit", "sizeMb": 576, "estRamMb": 650, "ceilingMb": 1012, "dim": 1024, "idealRamTier": "workstation"},
        {"id": "mlx-community/LFM2.5-Embedding-350M-4bit", "name": "LFM2.5 Embedding 350M · 4-bit", "sizeMb": 190, "estRamMb": 250, "ceilingMb": 500, "dim": 1024, "idealRamTier": "compact"},
        {"id": "mlx-community/nomicai-modernbert-embed-base-bf16", "name": "Nomic ModernBERT · BF16", "sizeMb": 284, "estRamMb": 340, "ceilingMb": 615, "dim": 768, "idealRamTier": "standard"},
        {"id": "mlx-community/embeddinggemma-2-8bit", "name": "EmbeddingGemma 2 · 8-bit (Google 2026最新)", "sizeMb": 1177, "estRamMb": 1220, "ceilingMb": 1742, "dim": 768, "idealRamTier": "workstation"},
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
      const vs = data.vectorStats || null;
      const memoryValue = (key) => data[key] ?? vs?.[key] ?? data.engine?.[key] ?? data.health?.[key];
      const mb = memoryValue("activeMb") ?? data.rssMb ?? data.memoryMB ?? data.ramMB ?? data.engine?.memoryMB ?? (data.memoryBytes ? Math.round(data.memoryBytes / 1048576) : null);
      const runningPreset = known.find((model) => model.id === modelId);
      const ceiling = keyword ? 0 : memoryValue("ceilingMb") ?? (runningPreset?.ceilingMb || (runningPreset?.estRamMb != null ? Math.round(runningPreset.estRamMb * 1.28 + 180) : null));
      const memoryNumber = (value) => value != null && Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))).toLocaleString(state.lang === "en" ? "en-US" : "zh-CN") : "—";
      const memoryLabel = tr(`显存 ${memoryNumber(keyword ? 0 : mb)} MB / 上限 ${memoryNumber(ceiling)} MB`, `VRAM ${memoryNumber(keyword ? 0 : mb)} MB / cap ${memoryNumber(ceiling)} MB`);
      const memoryDetails = [memoryValue("baseActiveMb") != null ? tr(`基础 ${memoryNumber(memoryValue("baseActiveMb"))} MB`, `Base ${memoryNumber(memoryValue("baseActiveMb"))} MB`) : "", memoryValue("cacheMb") != null ? tr(`缓存 ${memoryNumber(memoryValue("cacheMb"))} MB`, `Cache ${memoryNumber(memoryValue("cacheMb"))} MB`) : ""].filter(Boolean).join(" · ");
      const active = data.downloadJob?.active === true;
      const ready = data.ready ?? data.running ?? data.engine?.ready ?? null;
      const status = keyword ? tr("纯关键词零内存模式 · 0 MB", "Keyword-only · 0 MB") : ready === true ? tr("本地向量运行中", "Local vectors running") : active ? tr("正在准备本地向量模型", "Preparing local vector model") : tr("本地向量引擎 · 待就绪", "Local vector engine · Not ready");
      const selected = known.find((model) => model.id === state.modelChoice);
      const switchOnly = state.modelChoice === "keyword" || selected?.downloaded || selected?.installed || selected?.cached;
      const hw = data.hardware || null;
      const syncText = vs && (vs.totalMemories > 0 || vs.syncedVectors > 0) ? (vs.reindexing ? `正在重算向量索引 ${vs.syncedVectors}/${vs.totalMemories}…` : `向量索引 ${vs.syncedVectors}/${vs.totalMemories} 已同步`) : "";
      const hwBanner = hw ? `<div class="hub-hint" id="t3-hub-engine-hardware" style="margin-bottom:12px">${icon("display", 13)}<span>${esc(hw.recommendReason || [hw.chipModel, hw.totalRamGb != null ? `${hw.totalRamGb} GB 内存` : ""].filter(Boolean).join(" · "))}</span></div>` : "";
      const tierLabel = (model) => ({ compact: "省内存档", standard: "标准档", workstation: "工作站档", flagship: "旗舰档", any: "任意档" }[model?.idealRamTier] || model?.idealRamTier || "");
      const detailText = state.modelChoice === "keyword" ? tr("0 MB 常驻 · SQLite FTS5 内置检索", "0 MB resident · SQLite FTS5 内置检索") : selected ? `${selected.desc || selected.description || ""}${selected.estRamMb != null ? ` · 常驻约 ${selected.estRamMb} MB` : ""}${tierLabel(selected) ? ` · ${tierLabel(selected)}` : ""}${selected.dim ? ` · ${selected.dim}d` : ""}` : "";
      const statusWithSync = syncText ? `${status} · ${syncText}` : status;
      node.innerHTML = `<div class="hub-card hub-engine">${hwBanner}<div class="hub-row"><span class="hub-engine-label">VECTOR ENGINE</span><span class="hub-grow"></span><span class="hub-badge hub-green">${icon("bolt", 10)}${esc(tr("轻量记忆", "Lightweight"))}</span></div><div id="t3-hub-engine-status" class="hub-engine-status">${icon(keyword ? "bolt" : "memory", 13)}<span>${esc(statusWithSync)}</span></div><div class="hub-engine-memory"><div class="hub-engine-memory-values"><span>${esc(memoryLabel)}</span><small>${esc(tr("（随模型封顶）", "(model-dependent cap)"))}${memoryDetails ? ` · ${esc(memoryDetails)}` : ""}</small></div>${button("trim-embed", state.embedTrimming ? tr("释放中…", "Releasing…") : tr("释放缓存", "Release cache"), { small: true, disabled: keyword || ready !== true || active || state.embedTrimming })}</div><div class="hub-engine-model">${esc(keyword ? tr("不加载模型，全文检索依然可用。", "No model loaded. Full-text search stays available.") : modelId || tr("选择一个适合你的本地模型", "Choose your local model"))}</div><div class="hub-engine-controls"><select class="hub-select" name="embed-model" aria-label="${esc(tr("向量模型", "Embedding model"))}" ${active ? "disabled" : ""}>${known.map((model) => { const badge = /Qwen3-Embedding-4B-4bit-DWQ$/.test(model.id) && Number(hw?.totalRamGb) >= 96 ? tr("★ 96GB 旗舰首选", "★ 96GB flagship choice") : model.recommendBadge || (model.recommended ? tr("★ 本机首选", "★ Recommended") : ""); const label = `${badge ? badge + " " : ""}${model.name}${model.sizeMb != null && model.dim ? ` (~${model.sizeMb} MB · ${model.dim}d)` : ""}${model.downloaded || model.installed || model.cached ? ` [${esc(tr("已下载", "Downloaded"))}]` : ""}`; return `<option value="${esc(model.id)}" ${state.modelChoice === model.id ? "selected" : ""}>${esc(label)}</option>`; }).join("")}<option value="keyword" ${state.modelChoice === "keyword" ? "selected" : ""}>${esc(tr("纯关键词零内存模式 0MB", "Keyword-only · 0 MB"))}</option><option value="custom" ${state.modelChoice === "custom" ? "selected" : ""}>${esc(tr("自定义模型…", "Custom model…"))}</option></select>${button("switch-embed", active ? tr("下载中", "Loading") : switchOnly ? tr("切换", "Switch") : tr("下载并启用", "Download & use"), { primary: true, icon: active ? undefined : switchOnly ? "bolt" : "download", disabled: active })}</div>${detailText ? `<div class="hub-hint" id="t3-hub-engine-detail" style="margin-top:8px">${esc(detailText)}</div>` : ""}${state.modelChoice === "custom" ? `<input class="hub-input" style="margin-top:8px" name="customModel" value="${esc(state.customModel)}" placeholder="HuggingFace ID / ${esc(tr("本地路径", "local path"))}" aria-label="${esc(tr("自定义模型地址", "Custom model ID or path"))}" spellcheck="false">` : ""}<label class="hub-checkbox"><input type="checkbox" name="useMirror" ${state.useMirror ? "checked" : ""} ${active ? "disabled" : ""}>${esc(tr("国内镜像加速 (hf-mirror)", "Use hf-mirror download accelerator"))}</label><div id="t3-hub-download-progress"></div>${data.downloadJob?.error ? `<div class="hub-hint" style="color:var(--hud-red);margin-top:9px">${esc(errorText(data.downloadJob.error))}</div>` : ""}</div>`;
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
    function memoryHealthHint() {
      const data = cache.health?.health || cache.health || cache.overview?.health || {};
      const count = (value) => Array.isArray(value) ? value.length : typeof value === "number" ? value : null;
      const links = count(data.totalLinks ?? data.wikiLinkCount ?? data.wikilinkCount ?? data.linkCount ?? data.links ?? data.wikiLinks);
      const broken = count(data.brokenCount ?? data.brokenLinkCount ?? data.brokenLinks ?? data.danglingLinks ?? data.broken);
      return `<span class="hub-hint hub-memory-health">${esc(tr(`[[链接]]${links == null ? "" : ` ${links}`} · 断链 ${broken ?? "待检测"}`, `[[Links]]${links == null ? "" : ` ${links}`} · Broken ${broken ?? "Not checked"}`))}</span>`;
    }
    async function importHostMemories(element) {
      if (state.memoryImporting) return;
      const version = contextVersion, projectRoot = state.projectRoot;
      state.memoryImporting = true;
      try {
        await busy("import-host-memories", element, async () => {
          const result = await request("memory:importHostMemories", { projectRoot });
          if (disposed || version !== contextVersion) return;
          const imported = result.importedCount ?? result.imported ?? result.stats?.importedCount ?? result.stats?.imported ?? result.totalImported;
          const count = Array.isArray(imported) ? imported.length : typeof imported === "number" ? imported : null;
          const health = await request("memory:health", { projectRoot }).catch(() => null);
          if (disposed || version !== contextVersion) return;
          if (health) cache.health = health;
          await Promise.all([refreshMemoryOverview(), loadMemories(false), refreshEmbed(false, true)]);
          if (disposed || version !== contextVersion) return;
          if (state.tab === "memory") { renderMemoryNav(); renderMemoryList(); renderEngine(); }
          toast(count == null ? result.message || tr("宿主记忆已汇聚到共享库", "Host memories gathered into the shared vault") : tr(`汇聚完成 · 导入 ${count} 条记忆`, `Import complete · ${count} memories imported`));
        });
      } finally { state.memoryImporting = false; if (!disposed && version === contextVersion && state.tab === "memory") renderMemoryNav(); }
    }
    async function trimEmbedCache(element) {
      if (state.embedTrimming) return;
      state.embedTrimming = true;
      try {
        await busy("trim-embed", element, async () => {
          await request("embed:trim", {});
          if (disposed) return;
          await refreshEmbed(false, true);
          if (!disposed && errors.embed) throw new Error(tr("缓存已释放，但读数刷新失败，请刷新状态重试", "Cache released, but readings could not refresh. Refresh the status to retry."));
          if (!disposed) toast(tr("向量缓存已释放，读数已刷新", "Vector cache released; readings refreshed"));
        });
      } finally { state.embedTrimming = false; if (!disposed && state.tab === "memory") renderEngine(); }
    }
    function renderMemoryGovernance() {
      const node = root.querySelector("#t3-hub-memory-governance");
      if (!node) return;
      node.innerHTML = `<div class="hub-memory-governance"><div class="hub-grow"><span class="hub-hint">${esc(tr("共享记忆治理", "Shared memory care"))}</span>${memoryHealthHint()}</div>${button("import-host-memories", state.memoryImporting ? tr("汇聚中…", "Importing…") : tr("汇聚宿主记忆", "Gather host memories"), { small: true, icon: "download", disabled: state.memoryImporting, attrs: `title="${esc(tr("无损导入本机 Claude、Codex、Gemini 的历史记忆", "Import local Claude, Codex, and Gemini memories without changing the originals"))}"` })}</div>`;
    }
    function renderMemoryNav() {
      renderMemoryGovernance();
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
        return `<option value="${esc(key)}" ${state.memoryProject === key ? "selected" : ""}> ${esc(name)}${count == null ? "" : ` · ${count}`}</option>`;
      }).join("");
      node.innerHTML = `<div class="hub-project-picker"><select class="hub-select" name="memoryProject" aria-label="${esc(tr("记忆所属项目", "Memory project"))}"><option value="current" ${state.memoryProject === "current" ? "selected" : ""} ${projectDisabled() ? "disabled" : ""}> ${esc(tr("当前项目", "Current project"))}</option><option value="global" ${state.memoryProject === "global" ? "selected" : ""}> ${esc(tr("全局通用记忆", "Global memories"))}</option>${projectOptions}</select>${button("new-memory", tr("新建 / 演进记忆", "New / evolve memory"), { icon: "plus", small: true })}</div><div class="hub-memory-toolbar">${button("consolidate-memory", tr(" 一键再记忆整理", " Consolidate memories"), { small: true, disabled: !selectedMemoryRoot(), attrs: `title="${esc(!selectedMemoryRoot() ? tr("请选择项目记忆库", "Select a project vault") : tr("合并重复经验，整理过时记忆", "Merge duplicates and outdated memories"))}"` })}<span class="hub-hint">${esc(tr("去重 · 演进 · 保留历史", "Deduplicate · Evolve · Keep history"))}</span></div>`;
      if (errors.overview) node.insertAdjacentHTML("beforeend", inlineError(errors.overview));
    }
    function memoryRecords() { return items(cache.memory, ["items", "memories", "results"]); }
    function memoryId(item) { return String(item.id ?? item.key ?? item.path ?? ""); }
    function memoryBody(item) { return item.content ?? item.body ?? item.markdown ?? item.text ?? ""; }
    function memoryDraftKey(id) { return `${state.memoryProject}\u0000${id}`; }
    function formatExactTime(value, seconds = false) {
      if (value == null || value === "") return "";
      const date = new Date(value);
      if (!Number.isFinite(date.getTime())) return tr("未知", "Unknown");
      const pad = (number) => String(number).padStart(2, "0");
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}${seconds ? `:${pad(date.getSeconds())}` : ""}`;
    }
    function exactTimeMarkup(value) {
      return `<time title="${esc(formatExactTime(value, true))}">${esc(formatExactTime(value))}</time>`;
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
        const source = item.sourceAgent || item.agent || item.source || "migrated";
        const draft = drafts[memoryDraftKey(id)];
        return `<article class="hub-card hub-memory-card ${selected ? "is-selected" : ""}" data-memory-id="${esc(id)}"><button type="button" class="hub-memory-open" data-action="open-memory" data-id="${esc(id)}" aria-expanded="${selected}"><div class="hub-card-top"><span class="hub-asset-icon ${module === "constraints" ? "accent" : ""}" style="width:27px;height:27px;font-size:13px">${icon(module === "constraints" ? "pin" : "memory", 14)}</span><div class="hub-grow"><div class="hub-card-name">${esc(item.title || item.name || memoryBody(item).split("\n")[0].replace(/^#+\s*/, "") || tr("未命名记忆", "Untitled memory"))}</div><div class="hub-card-meta"><span class="hub-badge">${esc(source)}</span>${Number(item.version) > 1 ? `<span class="hub-badge hub-purple"> v${esc(item.version)}</span>` : ""}${Number(item.hitCount) > 0 ? `<span class="hub-memory-hits"> ${esc(item.hitCount)}</span>` : ""}${item.lastRecalledAt ? `<span class="hub-memory-hits">${esc(tr("召回", "Recalled"))} ${exactTimeMarkup(item.lastRecalledAt)}</span>` : ""}<span class="hub-memory-date">${exactTimeMarkup(item.updatedAt || item.updated_at || item.createdAt)}</span></div></div><span style="color:var(--hud-muted);transform:rotate(${selected ? 90 : 0}deg)">${icon("chevron", 12)}</span></div>${selected ? "" : `<p class="hub-card-description">${esc(item.summary || memoryBody(item).replace(/[#*`>]/g, "").slice(0, 210))}</p>`}</button>${selected ? `<div class="hub-memory-detail"><label class="hub-field">${esc(tr("标题", "Title"))}<input class="hub-input" name="memory-title" data-id="${esc(id)}" value="${esc(draft?.title ?? item.title ?? item.name ?? "")}"></label><label class="hub-field">Markdown<textarea class="hub-editor" name="memory-content" data-id="${esc(id)}" spellcheck="false" aria-label="${esc(tr("记忆内容", "Memory content"))}">${esc(draft?.content ?? memoryBody(item))}</textarea></label><div class="hub-detail-meta"><span class="hub-badge">${esc(source)}</span><span>${esc(tr("更新于", "Updated"))} ${exactTimeMarkup(item.updatedAt || item.updated_at || item.createdAt)}</span></div>${item.lastRecalledAt ? `<div class="hub-detail-meta">${esc(tr("最近召回", "Last recalled"))} ${exactTimeMarkup(item.lastRecalledAt)}</div>` : ""}<div class="hub-editor-actions">${button("save-memory", tr("保存修改", "Save"), { primary: true, icon: "save", attrs: `data-id="${esc(id)}"` })}${button("pin-memory", tr("置顶到 AGENTS.md", "Pin to AGENTS.md"), { icon: "pin", disabled: !selectedMemoryRoot(), attrs: `data-id="${esc(id)}" title="${esc(!selectedMemoryRoot() ? tr("请选择要写入的项目", "Choose a project to pin into") : "")}"` })}${button("delete-memory", tr("删除", "Delete"), { icon: "trash", danger: true, attrs: `data-id="${esc(id)}"` })}</div><div data-delete-confirm hidden class="hub-confirm-delete">${esc(tr("确定删除这条记忆？此操作无法撤销。", "Delete this memory? This cannot be undone."))}<div class="hub-row">${button("confirm-delete-memory", tr("确认删除", "Delete memory"), { danger: true, small: true, attrs: `data-id="${esc(id)}"` })}${button("cancel-delete-memory", tr("取消", "Cancel"), { small: true })}</div></div></div>` : ""}${item.scope === "worktree" || item.memoryScope === "worktree" ? `<div style="padding:0 14px 12px">${button("promote-memory", tr("↑ 提炼为长期共享", "↑ Promote to shared memory"), { small: true, attrs: `data-id="${esc(id)}"` })}</div>` : ""}${renderMemoryHistory(item)}</article>`;
      }).join("");
    }
    function renderMemoryHistory(item) {
      const history = items(item, ["history"]);
      if (!history.length) return "";
      const id = memoryId(item), key = memoryDraftKey(id), open = !!state.historyExpanded[key];
      return `<div class="hub-memory-history"><button type="button" class="hub-history-toggle" data-action="memory-history" data-id="${esc(id)}" aria-expanded="${open}">${icon("chevron", 11)}${esc(tr(`查看演进历史 (${history.length} 次修订)`, `Evolution history (${history.length} revisions)`))}</button><div class="hub-history-list" ${open ? "" : "hidden"}>${history.map((entry, index) => {
        const version = entry.version ?? entry.targetVersion ?? index + 1;
        return `<div class="hub-history-entry"><div class="hub-row"><strong>v${esc(version)}</strong><span>${exactTimeMarkup(entry.timestamp || entry.updatedAt || entry.createdAt)}</span></div><div class="hub-history-agent">${esc(entry.agent || entry.sourceAgent || tr("未知来源", "Unknown agent"))}</div><p>${esc(entry.content || entry.text || entry.oldText || entry.body || "")}</p>${button("rollback-memory", tr("↩ 回滚到此版本", "↩ Restore this version"), { small: true, attrs: `data-id="${esc(id)}" data-version="${esc(version)}" data-revision-id="${esc(entry.revisionId || "")}"` })}</div>`;
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
      node.innerHTML = `<div class="hub-new-memory"><div class="hub-section-heading">${esc(tr("记录一条可复用的经验", "Write something worth remembering"))}</div><label class="hub-field">${esc(tr("标题", "Title"))}<input class="hub-input" name="new-memory-title" value="${esc(draft.title || "")}" placeholder="${esc(tr("一句话说清这条记忆", "A short, clear title"))}"></label><label class="hub-field">${esc(tr("保存范围", "Save scope"))}<select class="hub-select" name="new-memory-scope">${[["project", tr("项目长期共享", "Shared project memory")], ["worktree", tr("当前工作树便签", "Current worktree note")], ["global", tr("全局通用", "Global")]].map(([scope, label]) => `<option value="${scope}" ${(draft.scope || (state.memoryScope === "worktree" ? "worktree" : state.memoryProject === "global" ? "global" : "project")) === scope ? "selected" : ""} ${scope !== "global" && !selectedMemoryRoot() ? "disabled" : ""}>${esc(label)}</option>`).join("")}</select></label><label class="hub-field">${esc(tr("模块", "Module"))}<select class="hub-select" name="new-memory-module">${moduleOptions().filter(([key]) => key !== "all").map(([key, label, emoji]) => `<option value="${key}" ${draft.module === key ? "selected" : ""}>${emoji} ${esc(label)}</option>`).join("")}</select></label><label class="hub-field">${esc(tr("覆盖旧记忆 (Supersede) · 可选", "Supersede an existing memory · optional"))}<select class="hub-select" name="new-memory-supersedes" ${state.supersedeLoading ? "disabled" : ""}>${supersedeOptions()}</select></label><textarea class="hub-editor" name="new-memory-content" spellcheck="false" aria-label="${esc(tr("新记忆内容", "New memory content"))}" placeholder="${esc(tr("写下背景、结论与验证过的经验…", "Context, conclusions, and verified lessons…"))}">${esc(draft.content || "")}</textarea><div class="hub-editor-actions">${button("create-memory", tr("保存记忆", "Save memory"), { primary: true, icon: "save" })}${button("cancel-new-memory", tr("取消", "Cancel"))}</div></div>`;
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
    function applyWidth() {
      if (!drawer) return;
      const max = Math.min(1240, innerWidth * .94);
      const width = Math.min(max, Math.max(Math.min(440, max), Number(state.width) || 880));
      drawer.style.setProperty("--hub-width", `${width}px`);
      drawer.classList.toggle("is-compact", width < 720 && innerWidth >= 640);
      drawer.classList.toggle("is-wide", width >= 840);
      const separator = root.querySelector("#t3-hub-resize-handle");
      separator?.setAttribute("aria-valuenow", String(Math.round(width)));
      separator?.setAttribute("aria-valuemin", "440");
      separator?.setAttribute("aria-valuemax", String(Math.round(max)));
    }
    function setWidth(width) {
      state.width = Math.min(1240, Math.max(440, Number(width) || 880));
      storageSet("t3-hub-width", state.width);
      applyWidth(); renderChrome();
    }
    function startResize(event) {
      if (event.button !== 0 || innerWidth < 640) return;
      event.preventDefault();
      resizeDrag = { pointerId: event.pointerId, x: event.clientX, width: drawer.getBoundingClientRect().width };
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    function moveResize(event) {
      if (!resizeDrag || resizeDrag.pointerId !== event.pointerId) return;
      event.preventDefault();
      state.width = Math.max(440, Math.min(1240, innerWidth * .94, resizeDrag.width + resizeDrag.x - event.clientX));
      applyWidth();
    }
    function endResize(event) {
      if (!resizeDrag || resizeDrag.pointerId !== event.pointerId) return;
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      resizeDrag = null;
      storageSet("t3-hub-width", state.width); renderChrome();
    }
    function visibleComposer() {
      const active = composerFor(document.activeElement);
      const candidates = [active, lastComposer, ...document.querySelectorAll('[data-slot="composer-shell"] textarea,[data-slot="composer-shell"] [contenteditable="true"],[data-slot="composer-shell"] [contenteditable="plaintext-only"],[data-composer] textarea,[data-composer] [contenteditable="true"]')];
      return candidates.find((editor) => editor?.isConnected && !editor.disabled && !editor.readOnly && editor.getClientRects().length && getComputedStyle(editor).visibility !== "hidden") || null;
    }
    function composerSurface(editor) {
      const shell = editor.closest('[data-slot="composer-shell"],[data-composer]') || editor;
      // Walk out from the editor: a transparent textarea wrapper is not the card.
      for (let node = editor.parentElement; node && shell.contains(node); node = node.parentElement) {
        const css = getComputedStyle(node), rect = node.getBoundingClientRect();
        const background = css.backgroundColor && !/^(transparent|rgba\(0,\s*0,\s*0,\s*0\))$/.test(css.backgroundColor);
        const border = parseFloat(css.borderTopWidth) > 0 && css.borderTopStyle !== "none";
        if (parseFloat(css.borderRadius || css.borderTopLeftRadius) >= 6 && (border || background) && rect.width >= 180 && rect.height >= 28) return node;
        if (node === shell) break;
      }
      return shell;
    }
    function findSessionRelationsCard() {
      const excluded = '#t3-sidecar-hub-root,#t3-hub-live-board,#t3-hud-root,[role="log"],[data-message-id],[data-message-role],[data-testid="chat-message"],[data-slot="message"]';
      const scopes = [...document.querySelectorAll('aside,[role="complementary"],[data-testid*="inspector"],[data-slot*="sidebar"],[data-thread-details]')].filter((node) => !node.closest(excluded));
      // Older hosts do not mark the inspector. Exact leaf titles + right-side
      // geometry prevent a quoted title in the conversation from becoming an anchor.
      const title = /^(会话关系|Session relationships|之前的智能体|Previous agents)$/i;
      const seen = new Set();
      for (const scope of [...scopes, document.body].filter(Boolean)) {
        for (const label of scope.querySelectorAll('h2,h3,h4,[role="heading"],span,p,div,button')) {
          if (seen.has(label)) continue;
          seen.add(label);
          if (label.closest(excluded) || !title.test(label.textContent.trim()) || [...label.children].some((child) => title.test(child.textContent.trim()))) continue;
          const rect = label.getBoundingClientRect();
          if (!label.getClientRects().length || rect.width <= 0 || rect.left < innerWidth * .5 || getComputedStyle(label).visibility === "hidden") continue;
          let section = label;
          for (let card = label.parentElement, depth = 0; card && card !== document.body && depth < 12; card = card.parentElement, depth++) {
            if (card.closest(excluded)) break;
            const box = card.getBoundingClientRect(), css = getComputedStyle(card);
            const rounded = parseFloat(css.borderRadius || css.borderTopLeftRadius) >= 8;
            const bordered = (parseFloat(css.borderTopWidth) > 0 && css.borderTopStyle !== "none") || (css.boxShadow && css.boxShadow !== "none") || parseFloat(css.outlineWidth) > 0;
            if (rounded && bordered && box.width >= 160 && box.width < innerWidth * .55) return { card, section };
            section = card;
          }
        }
      }
      return null;
    }
    function positionConversationTools() {
      if (!root || !liveBoard || disposed) return;
      const route = routeKey();
      if (route !== anchorRoute || (anchorCache && !anchorCache.card.isConnected)) {
        anchorResize?.disconnect(); anchorCache = null; anchorRoute = route; anchorScanAt = 0;
      }
      if (!anchorCache && Date.now() - anchorScanAt >= 2000) {
        anchorScanAt = Date.now();
        anchorCache = findSessionRelationsCard();
        if (anchorCache) {
          anchorCache.viewport = anchorCache.card.closest('aside,[role="complementary"],[data-testid*="inspector"],[data-slot*="sidebar"],[data-thread-details]');
          anchorResize?.observe(anchorCache.card);
          if (anchorCache.viewport) anchorResize?.observe(anchorCache.viewport);
        }
      }
      const anchor = anchorCache;
      let hidden = !anchor || state.open || root.classList.contains("is-occluded") || /^\/(settings|usage|pair)(\/|$)/.test(routeHint());
      if (!hidden) {
        const rect = anchor.card.getBoundingClientRect();
        const clip = anchor.viewport?.getBoundingClientRect();
        hidden = !rect.width || !rect.height || rect.bottom <= 0 || rect.top >= innerHeight || rect.left >= innerWidth || rect.right <= 0 ||
          (clip && (rect.bottom <= clip.top || rect.bottom >= clip.bottom || rect.right <= clip.left || rect.left >= clip.right));
        if (!hidden) {
          Object.assign(liveBoard.style, { left: `${rect.left}px`, width: `${rect.width}px`, top: `${rect.bottom - 1}px`, maxHeight: `${Math.max(0, Math.min(innerHeight, clip?.bottom ?? innerHeight) - rect.bottom + 1)}px` });
        }
      }
      liveBoard.hidden = !!hidden;
      if (slashSession) positionSlash();
    }
    function boardData() {
      const raw = cache.board?.board || cache.board || {};
      const sourceSteps = items(raw, ["steps", "items", "plan"]);
      const steps = sourceSteps.map((step, index) => {
        if (typeof step === "string") step = { text: step };
        const status = String(step.status || step.state || (step.completed ? "completed" : "pending")).replace(/_/g, "-");
        return { ...step, id: step.id ?? String(index), text: step.text || step.title || step.content || step.step || "", status: /^(completed|done|success|succeeded)$/.test(status) ? "completed" : /^(in-progress|running|active|started)$/.test(status) ? "in-progress" : "pending" };
      });
      const completed = Number(raw.progress?.completed ?? steps.filter((step) => step.status === "completed").length) || 0;
      const total = Number(raw.progress?.total ?? steps.length) || 0;
      return { ...raw, steps, progress: { completed, total }, subagents: items(raw, ["subagents", "runs", "delegates"]), artifacts: items(raw, ["artifacts", "documents"]) };
    }
    function elapsedLabel(run) {
      const ms = Number(run.elapsedMs ?? run.durationMs ?? (run.startedAt ? (run.completedAt || run.endedAt ? new Date(run.completedAt || run.endedAt).getTime() : Date.now()) - new Date(run.startedAt).getTime() : (run.elapsedSeconds ?? run.elapsed ?? 0) * 1000));
      if (!Number.isFinite(ms) || ms <= 0) return "";
      const seconds = Math.floor(ms / 1000);
      return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    }
    function boardSourceLabel(source) {
      const name = typeof source === "object" ? source?.label || source?.kind || source?.type : source;
      return /native|t3/i.test(name || "") ? tr("T3 原生", "T3 native") : /agy|brain|antigravity/i.test(name || "") ? "AGY Brain" : tr("Hub 打卡", "Hub plan");
    }
    function boardMarkup(manual = false, compact = false) {
      const board = boardData();
      const artifactButtons = board.artifacts.map((artifact, index) => {
        const file = typeof artifact === "string" ? artifact : artifact.name || artifact.title || artifact.path || artifact.id;
        return `<button type="button" class="hub-artifact-chip" data-action="read-artifact" data-index="${index}" title="${esc(file)}">${icon("edit", 11)} ${esc(String(file || "document.md").split(/[\\/]/).pop())}</button>`;
      }).join("");
      return `${compact ? "" : `<div class="hub-board-heading"><strong>${esc(tr("计划", "Plan"))}</strong><span class="hub-badge">${esc(boardSourceLabel(board.source))}</span></div>`}${!compact && board.background ? `<button type="button" class="hub-pill" data-action="board-background" aria-expanded="${state.boardBackground}">≣ ${esc(tr("背景", "Background"))}</button><div class="hub-board-background" ${state.boardBackground ? "" : "hidden"}>${esc(typeof board.background === "string" ? board.background : board.background.text || board.background.content || "")}</div>` : ""}${compact ? "" : `<div class="hub-board-section"><span>${esc(tr("进程", "Progress"))}</span><b>${board.progress.completed}/${board.progress.total}</b></div>`}<ol class="hub-board-steps">${board.steps.map((step, index) => `<li class="hub-board-step is-${step.status}">${manual ? `<button type="button" class="hub-step-check" data-action="board-step" data-index="${index}" aria-label="${esc(`${step.status === "completed" ? tr("标为待完成", "Mark pending") : tr("标为已完成", "Mark completed")} · ${step.text}`)}" aria-pressed="${step.status === "completed"}"><span class="hub-step-icon">${step.status === "completed" ? "✓" : step.status === "in-progress" ? "◉" : "○"}</span></button>` : `<span class="hub-step-icon" aria-label="${esc(step.status)}">${step.status === "completed" ? "✓" : step.status === "in-progress" ? "◉" : "○"}</span>`}<span class="hub-step-text">${esc(step.text)}</span></li>`).join("") || `<li class="hub-hint">${esc(tr("当前没有计划步骤", "No plan steps yet"))}</li>`}</ol>${artifactButtons ? `<div class="hub-board-section"><span>${esc(tr("产物文档", "Artifacts"))}</span></div><div class="hub-artifacts">${artifactButtons}</div>` : ""}`;
    }
    function renderLiveBoard() {
      if (!liveBoard) return;
      const board = boardData();
      // A poll must not replace an input (or a checkbox) under the user's hands.
      if (document.activeElement?.matches('input[name="board-step-draft"]') && liveBoard.contains(document.activeElement) && liveBoard.dataset.threadId === (state.threadId || "")) { positionConversationTools(); return; }
      liveBoard.dataset.threadId = state.threadId || "";
      liveBoard.classList.toggle("is-collapsed", !state.boardExpanded);
      liveBoard.innerHTML = `<div class="hub-board-toolbar"><button type="button" class="hub-board-toggle" data-action="toggle-board" aria-expanded="${state.boardExpanded}"><span>${icon("check", 12)} ${esc(tr("计划进度", "Plan progress"))} ${board.progress.completed}/${board.progress.total}</span><span aria-hidden="true">${state.boardExpanded ? "−" : "+"}</span></button>${themeSwitcher()}<button type="button" class="hub-icon-btn" data-action="open-board-studio" aria-label="${esc(tr("在 Hub Studio 中打开", "Open in Hub Studio"))}" title="Hub Studio">${icon("hub", 13)}</button></div>${state.boardExpanded ? `<div class="hub-board-content">${boardMarkup(true, true)}<div class="hub-board-add"><input class="hub-input" name="board-step-draft" value="${esc(state.boardDraft)}" placeholder="${esc(tr("+ 添加本会话步骤", "+ Add a step to this thread"))}" aria-label="${esc(tr("添加本会话步骤", "Add a thread step"))}">${button("board-add", tr("添加", "Add"), { small: true, icon: "plus" })}</div></div>` : ""}`;
      applyTheme();
      positionConversationTools();
    }
    function artifactMarkup() {
      if (!state.artifact) return "";
      return `<section class="hub-artifact-preview"><div class="hub-row"><strong class="hub-grow">${esc(state.artifact.name)}</strong>${button("close-artifact", tr("收起", "Close"), { small: true })}</div><pre>${esc(state.artifact.content)}</pre></section>`;
    }
    function renderBoardTab() {
      if (!cache.board && errors.board) { content.innerHTML = inlineError(errors.board); return; }
      content.innerHTML = `<div class="hub-section-heading"><span>${esc(tr("任务进度", "Task progress"))}</span><span class="hub-count">${esc(projectTitle())}</span></div><p class="hub-description">${esc(tr("本会话的计划步骤与产物文档，随会话实时同步。", "Plan steps and artifacts, synced to this thread."))}</p>${!cache.board ? loading() : `<section class="hub-board-studio">${boardMarkup(true)}<div class="hub-board-add"><input class="hub-input" name="board-step-draft" value="${esc(state.boardDraft)}" placeholder="${esc(tr("添加一个步骤…", "Add a step…"))}" aria-label="${esc(tr("新计划步骤", "New plan step"))}">${button("board-add", tr("添加", "Add"), { small: true, primary: true, icon: "plus" })}</div><div class="hub-editor-actions">${button("board-clear", tr("清空手动计划", "Clear manual plan"), { small: true })}<span class="hub-hint">${esc(tr("约每 3.5 秒同步 · 五宿主通用", "Synced every 3.5s · All agents"))}</span></div></section>`}${artifactMarkup()}`;
    }
    async function pollBoard() {
      if (disposed || document.hidden || !state.connected || boardLoading) return;
      boardLoading = true;
      const version = ++boardVersion, projectRoot = state.projectRoot, threadId = state.threadId || "__NEW__", context = contextVersion;
      try {
        const data = await request("board:get", { projectRoot, threadId: threadId || undefined, strictThreadMatch: true, excludeSubagentInference: true });
        if (disposed || version !== boardVersion || context !== contextVersion || projectRoot !== state.projectRoot || threadId !== state.threadId) return;
        cache.board = data; delete errors.board;
        const signature = JSON.stringify(data);
        renderLiveBoard();
        if (signature !== boardSignature) {
          boardSignature = signature; renderChrome();
          if (state.open && state.tab === "board" && !content.contains(document.activeElement)) renderBoardTab();
        }
      } catch (error) {
        if (!disposed && version === boardVersion && context === contextVersion) { errors.board = error; if (!cache.board && state.open && state.tab === "board") renderBoardTab(); }
      } finally { if (version === boardVersion) boardLoading = false; }
    }
    function scheduleBoardPoll() {
      cancelTimer(boardTimer);
      boardTimer = later(async () => { await pollBoard(); if (!disposed) scheduleBoardPoll(); }, 3500);
    }
    async function updateBoard(element, action, index) {
      const projectRoot = state.projectRoot, threadId = state.threadId || "__NEW__", version = contextVersion;
      await busy(`board-update:${threadId || "project"}`, element, async () => {
        if (action === "clear") await request("board:clear", { projectRoot, threadId: threadId || undefined, strictThreadMatch: true });
        else {
          const board = boardData(), steps = board.steps.map((step) => ({ ...step }));
          if (action === "add") {
            if (!state.boardDraft.trim()) return;
            steps.push({ id: `hub-${Date.now()}`, text: state.boardDraft.trim(), status: "pending" });
          } else if (steps[index]) steps[index].status = steps[index].status === "completed" ? "pending" : "completed";
          await request("board:update", { projectRoot, threadId: threadId || undefined, strictThreadMatch: true, steps: steps.map((step) => ({ ...step, status: step.status === "in-progress" ? "in_progress" : step.status })), background: board.background || "" });
        }
        if (disposed || version !== contextVersion || threadId !== state.threadId) return;
        if (action === "add") { state.boardDraft = ""; liveBoard?.querySelector('[name="board-step-draft"]')?.blur(); }
        // A pre-write poll must not restore the old checkbox state after saving.
        boardVersion++; boardLoading = false;
        await pollBoard();
        renderLiveBoard();
        if (!disposed && version === contextVersion && threadId === state.threadId && state.tab === "board") renderBoardTab();
      });
    }
    async function readArtifact(index, element) {
      const artifact = boardData().artifacts[index];
      if (!artifact) return;
      const path = typeof artifact === "string" ? artifact : artifact.path || artifact.id || artifact.name;
      const projectRoot = state.projectRoot, threadId = state.threadId || "__NEW__", version = contextVersion;
      await busy(`artifact:${path}`, element, async () => {
        const data = await request("board:readArtifact", { projectRoot, threadId: threadId || undefined, strictThreadMatch: true, path, id: artifact.id });
        if (disposed || version !== contextVersion || threadId !== state.threadId) return;
        state.artifact = { name: data.name || String(path).split(/[\\/]/).pop(), content: data.content || data.markdown || data.text || "" };
        if (state.tab !== "board") switchTab("board");
        setOpen(true, false); renderBoardTab();
        content.querySelector(".hub-artifact-preview")?.scrollIntoView({ block: "nearest" });
      });
    }

    function orchestrationValues() {
      const data = state.orchestrationDraft || cache.orchestration?.orchestration || cache.orchestration?.config || cache.orchestration || {};
      const orchestrator = data.orchestratorMode || data.orchestrator?.mode || (typeof data.orchestrator === "string" ? data.orchestrator : "") || data.mode || "off";
      return {
        orchestratorMode: /argon/i.test(orchestrator) ? "argon" : /carbon/i.test(orchestrator) ? "carbon" : "off",
        swarmEnabled: (data.swarmEnabled ?? data.swarm?.enabled ?? (typeof data.swarm === "boolean" ? data.swarm : false)) === true,
        maxConcurrency: Math.max(1, Math.min(20, Number(data.maxConcurrency ?? data.swarm?.maxConcurrency ?? data.maxParallel ?? 5) || 5)),
        autoWorktreeIsolation: (data.autoWorktreeIsolation ?? data.worktreeIsolation ?? data.swarm?.worktreeIsolation ?? true) !== false,
      };
    }
    function renderCommander() {
      if (!cache.orchestration) return errors.orchestration ? inlineError(errors.orchestration) : loading();
      const data = orchestrationValues();
      const description = data.orchestratorMode === "carbon" ? tr("极速敏锐总控主帅。主会话负责排版、决策、派单与验收，执行交给子代理；全体无法解决时由主帅兜底。", "A fast commander for decisions, delegation, and acceptance. Agents execute; the commander handles the final fallback.") : data.orchestratorMode === "argon" ? tr("深谋推演总控主帅。面向复杂跨模块架构，持续核对依赖、不变量与需求覆盖。", "A deliberate commander for complex architecture, dependencies, invariants, and requirement coverage.") : tr("按当前宿主的常规协作方式工作。", "Use the current agent's regular collaboration mode.");
      return `<section class="hub-card hub-commander"><div class="hub-commander-title">${esc(tr("主帅总控模式", "Master commander"))}</div><p class="hub-description">Orchestrator · ${esc(tr("决策、派单与验收", "Decide, delegate, verify"))}</p><label class="hub-field">Orchestrator<select class="hub-select" name="orchestration-mode">${[["off", tr("关闭（常规模式）", "Off · Regular mode")], ["carbon", "Orchestrator (Carbon) [New]"], ["argon", "Orchestrator (Argon) [New]"]].map(([value, label]) => `<option value="${value}" ${data.orchestratorMode === value ? "selected" : ""}>${esc(label)}</option>`).join("")}</select></label><div class="hub-commander-note">${esc(description)}</div><div class="hub-control-row"><div class="hub-grow"><strong>/swarm ${esc(tr("蜂群并发模式", "Swarm mode"))}</strong><small>${esc(data.swarmEnabled ? tr("全火力蜂群开启", "Full swarm enabled") : tr("按需并发", "Parallelize as needed"))}</small></div><button type="button" role="switch" class="hub-switch" data-action="toggle-swarm" aria-label="/swarm 蜂群并发模式" aria-checked="${data.swarmEnabled}"><span></span></button></div><div class="hub-control-row"><div class="hub-grow"><strong>${esc(tr("最大并发路数", "Maximum concurrency"))}</strong><small>${esc(tr("1–20 路，按任务负载调整", "1–20 concurrent agents"))}</small></div><div class="hub-range"><input type="range" min="1" max="20" name="orchestration-concurrency-range" value="${data.maxConcurrency}" aria-label="${esc(tr("最大并发路数", "Maximum concurrency"))}"><input class="hub-input" type="number" min="1" max="20" name="orchestration-concurrency" value="${data.maxConcurrency}" aria-label="${esc(tr("并发数量", "Concurrency"))}"></div></div><div class="hub-control-row"><div class="hub-grow"><strong>${esc(tr("工作树自动隔离", "Automatic worktree isolation"))}</strong><small>${esc(tr("让并行任务拥有各自的工作副本", "Give parallel tasks their own working copy"))}</small></div><button type="button" role="switch" class="hub-switch" data-action="toggle-worktree-isolation" aria-label="${esc(tr("工作树自动隔离", "Automatic worktree isolation"))}" aria-checked="${data.autoWorktreeIsolation}"><span></span></button></div><div class="hub-editor-actions">${button("save-orchestration", tr("保存设置", "Save settings"), { primary: true, small: true })}${button("sync-orchestration", tr("同步军规到五宿主", "Sync rules to all agents"), { small: true, icon: "refresh" })}</div></section>`;
    }
    async function saveOrchestration(element, sync = false) {
      const version = contextVersion, projectRoot = state.projectRoot, patch = orchestrationValues();
      await busy("orchestration-save", element, async () => {
        await request("subagents:orchestration:update", { ...patch, projectRoot, syncToHosts: sync, sync });
        if (disposed || version !== contextVersion) return;
        cache.orchestration = await request("subagents:orchestration:get", { projectRoot });
        if (disposed || version !== contextVersion) return;
        state.orchestrationDraft = null;
        if (state.tab === "subagents") renderSubagents();
        invalidateSlashCache();
        toast(sync ? tr("总控军规已同步到五宿主", "Commander rules synchronized") : tr("总控设置已保存", "Commander settings saved"));
      });
    }
    // These keys mirror hub-host-settings.cjs; metadata and raw files are never written.
    const nativeSettingKeys = {
      codex: ["model", "model_reasoning_effort", "approval_policy", "sandbox_mode"],
      muse: ["model", "defaultModel", "permissionMode", "reasoningEffort", "effort", "defaultEffort"],
      pi: ["defaultModel", "defaultProvider", "model", "effort", "reasoningEffort", "thinkingLevel"],
    };
    function settingsValues() {
      const hostKey = state.settingsHost === "agy" ? "antigravity" : state.settingsHost;
      return cache.settings?.hosts?.[hostKey] ?? cache.settings?.[hostKey] ?? null;
    }
    function settingValue(entry, key) {
      // An explicit null is authoritative: never substitute an overview fallback for an unset key.
      for (const source of [entry?.editableValues, entry?.values, entry?.settings, entry?.config, entry]) {
        if (source && typeof source === "object" && Object.prototype.hasOwnProperty.call(source, key)) return source[key];
      }
      return undefined;
    }
    function settingText(value) { return value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value); }
    // Textarea values normalize CR/CRLF to LF. Compare their displayed form, but
    // keep the exact raw baseline/draft when that display has not changed.
    function settingInputText(value) { return settingText(value).replace(/\r\n?/g, "\n"); }
    function nativeSettingRows(value) { return Math.min(3, settingInputText(value).split("\n").length); }
    function nativeSettingHint(key, saved) {
      return state.clearedHostFields.has(key) ? tr("保存后恢复默认（移除配置键）。", "Save to use the default (remove this key).") : saved === undefined ? tr("快照未提供当前值；留空不修改。", "Current value is not in this snapshot; leave blank to keep it.") : tr("仅保存修改过的字段；清空后保存可恢复默认。", "Only changed fields are saved; clear and save to use the default.");
    }
    function nativeSettingPlaceholder(key, saved) {
      return saved === "" && !state.clearedHostFields.has(key) ? tr('显式空字符串 ""', 'Explicit empty string ""') : tr("未设置 · 使用宿主默认值", "Unset · use agent default");
    }
    function editNativeSetting(key, value, explicitClear = false) {
      const saved = settingValue(settingsValues(), key), savedText = settingText(saved);
      const saveKey = `${state.settingsHost}:${key}`;
      const effectiveSaved = inFlightNativeSaves.has(saveKey) ? inFlightNativeSaves.get(saveKey) : saved;
      const current = Object.prototype.hasOwnProperty.call(state.settingsDraft, key) ? state.settingsDraft[key] : savedText;
      const raw = value === settingInputText(savedText) ? savedText : value === settingInputText(current) ? current : value;
      const clearing = value === "" && effectiveSaved != null && (explicitClear || effectiveSaved !== "");
      if (clearing) state.clearedHostFields.add(key);
      else state.clearedHostFields.delete(key);
      if (!clearing && raw === savedText && !inFlightNativeSaves.has(saveKey)) delete state.settingsDraft[key];
      else state.settingsDraft[key] = clearing ? "" : raw;
      state.settingsDirty = Object.keys(state.settingsDraft).length > 0;
    }
    function syncNativeSettingField(input, key) {
      input.rows = nativeSettingRows(input.value);
      const field = input.closest?.(".hub-native-field");
      if (!field) return;
      const saved = settingValue(settingsValues(), key), cleared = state.clearedHostFields.has(key);
      input.placeholder = nativeSettingPlaceholder(key, saved);
      const clear = field.querySelector("[data-host-field-clear]");
      if (clear) { clear.hidden = saved == null && input.value === ""; clear.disabled = cleared; }
      const badge = field.querySelector(".hub-native-empty");
      if (badge) badge.hidden = saved !== "" || cleared;
      input.setAttribute("aria-describedby", `${input.id}-key ${saved === "" && !cleared ? `${input.id}-empty ` : ""}${input.id}-hint`);
      const hint = field.querySelector(".hub-hint");
      if (hint) hint.textContent = nativeSettingHint(key, saved);
    }
    function editableSettingKeys(entry = settingsValues()) {
      if (!entry || entry.error || entry.corrupted || entry.readonly || entry.readOnly) return [];
      const allowed = Object.prototype.hasOwnProperty.call(nativeSettingKeys, state.settingsHost) ? nativeSettingKeys[state.settingsHost] : [];
      return Array.isArray(entry.editableKeys) ? allowed.filter((key) => entry.editableKeys.includes(key)) : allowed;
    }
    function renderSettings() {
      const entry = settingsValues(), keys = editableSettingKeys(entry);
      const host = agentHosts.find((host) => host.id === state.settingsHost);
      const labels = { model: tr("模型", "Model"), defaultModel: tr("默认模型", "Default model"), defaultProvider: tr("默认提供商", "Default provider"), model_reasoning_effort: tr("思考强度", "Reasoning effort"), approval_policy: tr("审批策略", "Approval policy"), sandbox_mode: tr("沙箱模式", "Sandbox mode"), permissionMode: tr("权限模式", "Permission mode"), reasoningEffort: tr("思考强度", "Reasoning effort"), effort: tr("思考强度", "Effort"), defaultEffort: tr("默认思考强度", "Default effort"), thinkingLevel: tr("思考档位", "Thinking level") };
      const path = entry?.path || entry?.fileName || entry?.rulePath || "";
      const warning = entry?.error || (entry?.corrupted ? tr("配置文件已损坏，请先修复原生文件后重新读取。", "The configuration is corrupt. Repair the native file and reload.") : "");
      const fields = keys.map((key) => {
        const saved = settingValue(entry, key), changed = Object.prototype.hasOwnProperty.call(state.settingsDraft, key);
        const value = changed ? state.settingsDraft[key] : settingText(saved), cleared = state.clearedHostFields.has(key);
        const id = `t3-hub-native-setting-${key}`;
        // The first LF after <textarea> is stripped by the HTML parser. Supply
        // that LF ourselves so even values beginning with a newline survive.
        return `<div class="hub-field hub-native-field"><div class="hub-native-field-heading"><label for="${esc(id)}">${esc(labels[key] || key)}</label><button type="button" class="hub-native-clear" data-action="clear-native-setting" data-host-field-clear="${esc(key)}" aria-label="${esc(tr(`清空${labels[key] || key}并恢复默认`, `Clear ${labels[key] || key} and use the default`))}" ${saved == null && !settingText(value) ? "hidden" : ""} ${cleared ? "disabled" : ""}>${esc(tr("清空 / 恢复默认", "Clear / default"))}</button></div><code class="hub-native-key" id="${esc(id)}-key">${esc(key)}</code><textarea class="hub-input" id="${esc(id)}" name="native-setting" data-settings-key="${esc(key)}" rows="${nativeSettingRows(value)}" aria-describedby="${esc(id)}-key ${saved === "" && !cleared ? `${esc(id)}-empty ` : ""}${esc(id)}-hint" placeholder="${esc(nativeSettingPlaceholder(key, saved))}" spellcheck="false" autocomplete="off">\n${esc(settingInputText(value))}</textarea><span class="hub-native-empty" id="${esc(id)}-empty" ${saved !== "" || cleared ? "hidden" : ""}>${esc(tr('当前显式为空 ""', 'Explicitly set to ""'))}</span><small class="hub-hint" id="${esc(id)}-hint" aria-live="polite">${esc(nativeSettingHint(key, saved))}</small></div>`;
      }).join("");
      const native = !cache.settings ? loading() : `<section class="hub-native-settings"><div class="hub-row"><strong>${esc(host?.label || state.settingsHost)}</strong><span class="hub-badge">${esc(warning ? tr("只读 · 配置异常", "Read-only · configuration error") : !keys.length ? tr("未托管配置", "No managed configuration") : entry.exists === false ? tr("文件不存在 · 保存时创建", "Missing file · created on save") : tr("已读取", "Loaded"))}</span></div>${path ? `<div class="hub-settings-host-description" title="${esc(path)}">${esc(path)}</div>` : ""}${warning ? `<div class="hub-error" role="alert"><div><strong>${esc(tr("只读保护：配置暂不可写", "Read-only: configuration cannot be edited"))}</strong><span>${esc(warning)}</span></div></div>` : keys.length ? `<div class="hub-native-fields">${fields}</div>` : empty(tr("此宿主暂无可托管的原生配置", "No managed native configuration for this agent"), tr("当前接口不支持写入此宿主的原生设置。可用规则文件单独显示在下方。", "The current service cannot write this agent's settings. Available rules are shown separately below."), "info")}<div class="hub-editor-actions">${keys.length ? button("save-native-settings", tr("保存配置", "Save configuration"), { primary: true, small: true, icon: "save", disabled: pending.has("native-settings") }) : ""}${button("reload-native-settings", tr("重新读取", "Reload"), { small: true, icon: "refresh" })}</div></section>`;
      const ruleInfo = cache.settingsRule;
      content.innerHTML = `<div class="hub-agent-filters" aria-label="宿主状态">${agentHosts.map((h) => `<span class="hub-badge">${esc(h.label)} · ${esc(state.context?.activeProvider === h.id || state.context?.activeCli === h.id ? tr("当前", "Active") : tr("状态未知", "Unknown"))}</span>`).join("")}</div><div class="hub-section-heading"><span>${esc(tr("原生设置", "Native settings"))}</span></div><p class="hub-description">${esc(tr("分别管理每位搭档的原生配置，只保存你修改的字段。", "Manage each agent's native settings and save only the fields you change."))}</p><div class="hub-agent-filters hub-native-hosts" role="tablist" aria-label="${esc(tr("选择宿主", "Choose agent"))}">${agentHosts.map((host) => `<button type="button" class="hub-pill ${state.settingsHost === host.id ? "is-active" : ""}" role="tab" data-action="settings-host" data-agent="${esc(host.id)}" aria-selected="${state.settingsHost === host.id}">${agentMark(host.id)}${esc(host.label)}</button>`).join("")}</div>${errors.settings ? inlineError(errors.settings, "reload-native-settings") : native}<div class="hub-section-heading" style="margin-top:28px"><span>${esc(tr("宿主规则 · 全局", "Agent rules · Global"))}</span></div>${ruleInfo?.path ? `<p class="hub-hint">${esc(ruleInfo.path)}</p>` : ""}${errors.settingsRule ? inlineError(errors.settingsRule, "reload-native-settings") : !ruleInfo ? `<p class="hub-hint">${esc(tr("当前宿主暂无可用的托管规则文件。", "No managed rules file is available for this agent."))}</p>` : `<label class="hub-field">${esc(tr("对话与协作指令", "Conversation and collaboration instructions"))}<textarea class="hub-editor" name="native-rule" spellcheck="false" aria-label="${esc(tr("宿主规则", "Agent rules"))}">${esc(state.settingsRule)}</textarea></label>${button("save-native-rule", tr("保存规则", "Save rules"), { primary: true, small: true, icon: "save", disabled: pending.has("native-rule") })}`}`;
    }
    async function loadSettings(force = false, resetDrafts = force) {
      const host = state.settingsHost, version = contextVersion;
      if (cache.settings && !force) return;
      const generation = ++settingsVersion;
      const ruleSupported = ["codex", "antigravity", "muse", "pi"].includes(host);
      const results = await Promise.allSettled([request("settings:get"), ruleSupported ? request("settings:getRule", { host }) : Promise.resolve(null)]);
      if (disposed || host !== state.settingsHost || version !== contextVersion || generation !== settingsVersion) return;
      if (results[0].status === "fulfilled") {
        cache.settings = results[0].value; delete errors.settings;
        if (resetDrafts) { state.settingsDirty = false; state.settingsDraft = {}; state.clearedHostFields.clear(); }
      } else errors.settings = results[0].reason;
      if (results[1].status === "fulfilled") {
        const data = results[1].value;
        cache.settingsRule = data;
        if (!state.settingsRuleDirty || resetDrafts) state.settingsRule = typeof data === "string" ? data : data?.content ?? data?.rule ?? data?.text ?? "";
        if (resetDrafts) state.settingsRuleDirty = false;
        delete errors.settingsRule;
      } else { cache.settingsRule = null; errors.settingsRule = results[1].reason; }
      if (state.open && state.tab === "settings") renderSettings();
    }
    async function saveNativeSettings(element, rule = false) {
      const host = state.settingsHost, version = contextVersion, selection = settingsSelectionVersion;
      const isCurrent = () => !disposed && host === state.settingsHost && version === contextVersion && selection === settingsSelectionVersion;
      await busy(rule ? "native-rule" : "native-settings", element, async () => {
        try {
          if (rule) {
            if (!cache.settingsRule || errors.settingsRule) throw new Error(tr("当前宿主规则不可写，请重新读取。", "Reload an available rules file before saving."));
            const saved = state.settingsRule;
            await request("settings:saveRule", { host, content: saved });
            if (!isCurrent()) return;
            state.settingsRuleDirty = state.settingsRule !== saved;
          } else {
            const entry = settingsValues(), keys = editableSettingKeys(entry);
            if (!keys.length || errors.settings) throw new Error(entry?.error || tr("此宿主原生配置当前只读或未托管。", "This agent's native configuration is read-only or unmanaged."));
            const changes = keys.filter((key) => Object.prototype.hasOwnProperty.call(state.settingsDraft, key) && (state.clearedHostFields.has(key) || state.settingsDraft[key] !== settingText(settingValue(entry, key)))).map((key) => [key, state.clearedHostFields.has(key) ? null : state.settingsDraft[key]]);
            if (!changes.length) { toast(tr("没有需要保存的修改", "No changes to save")); return; }
            for (const [key, value] of changes) inFlightNativeSaves.set(`${host}:${key}`, value);
            let savedCount = 0;
            for (const [key, value] of changes) {
              // Stop stale queued writes after switching hosts or projects.
              if (!isCurrent()) return;
              try { await request("settings:update", { host, key, value }); }
              catch (error) {
                if (!isCurrent()) return;
                await loadSettings(true, false);
                if (!isCurrent()) return;
                state.settingsDirty = Object.keys(state.settingsDraft).length > 0;
                throw new Error(`${tr(`已保存 ${savedCount}/${changes.length} 项`, `Saved ${savedCount}/${changes.length} fields`)} · ${key}: ${errorText(error)}`);
              }
              if (!isCurrent()) return;
              savedCount++;
              if (value === null ? state.clearedHostFields.has(key) : !state.clearedHostFields.has(key) && state.settingsDraft[key] === value) {
                delete state.settingsDraft[key];
                state.clearedHostFields.delete(key);
              }
            }
            state.settingsDirty = Object.keys(state.settingsDraft).length > 0;
          }
          await loadSettings(true, false);
          if (!isCurrent()) return;
          const refreshError = rule ? errors.settingsRule : errors.settings;
          if (refreshError) throw new Error(`${tr("已写入，但刷新失败", "Saved, but refresh failed")}: ${errorText(refreshError)}`);
          toast(rule ? tr("宿主规则已保存", "Agent rules saved") : tr("原生配置已保存", "Native configuration saved"));
        } finally {
          if (!rule) for (const key of nativeSettingKeys[host] || []) inFlightNativeSaves.delete(`${host}:${key}`);
        }
      });
      if (isCurrent() && state.open && state.tab === "settings") renderSettings();
    }
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

    // The $ / ￥ palette works while the Hub is closed. Plain / stays native.
    function composerFor(target) {
      const element = target?.nodeType === 1 ? target : target?.parentElement;
      const editor = element?.closest('textarea,[contenteditable="true"],[contenteditable="plaintext-only"]');
      if (!editor || editor.closest('#t3-sidecar-hub-root,#t3-hub-live-board,[role="dialog"],[role="alertdialog"],dialog') || editor.disabled || editor.readOnly) return null;
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
      const match = text.value.slice(0, text.caret).match(/(?:^|\s)([$￥])([^\s$￥/]*)$/u);
      if (!match) return null;
      const start = text.caret - match[2].length - 1;
      const end = text.caret + (text.value.slice(text.caret).match(/^[^\s$￥/]*/u)?.[0].length || 0);
      return { ...text, start, end, query: match[2].toLowerCase(), raw: text.value.slice(start, end) };
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
      positionConversationTools();
    }
    function invalidateSlashCache() {
      slashCache.clear();
      closeSlash();
    }
    async function slashData(projectRoot) {
      const key = projectRoot || "__global__", existing = slashCache.get(key);
      if (existing && Date.now() - existing.at < 5000) return existing.promise;
      const entry = { at: Date.now(), promise: null };
      entry.promise = (async () => {
        const results = await Promise.allSettled([request("slash:list", { projectRoot }), request("skills:list", { projectRoot })]);
        const shortcuts = results[0].status === "fulfilled" ? results[0].value : {};
        const skills = items(shortcuts, ["skills"]).length ? items(shortcuts, ["skills"]) : results[1].status === "fulfilled" ? items(results[1].value, ["items", "skills"]) : [];
        if (results.every((result) => result.status === "rejected")) throw results[0].reason;
        return { ...shortcuts, projectRoot, skills };
      })().catch((error) => { if (slashCache.get(key) === entry) slashCache.delete(key); throw error; });
      slashCache.set(key, entry);
      return entry.promise;
    }
    function scopedSlashItems(data, projectRoot) {
      if (data.projectRoot != null && data.projectRoot !== projectRoot) return [];
      const rows = [...items(data, ["skills"]).map((item) => ({ ...item, type: "skill" })), ...items(data, ["subagents"]).map((item) => ({ ...item, type: "subagent" })),
        { id: "swarm", name: "/swarm 蜂群并发", description: "按任务拆分并发执行，汇总结果与验证证据。", type: "mode", trigger: "/swarm " },
        { id: "orchestrator-carbon", name: "Orchestrator (Carbon)", description: "极速敏锐总控主帅 · 决策、派单与验收", type: "mode", trigger: "使用 Orchestrator (Carbon) 总控模式：" },
        { id: "orchestrator-argon", name: "Orchestrator (Argon)", description: "深谋推演总控主帅 · 复杂架构与需求防漏", type: "mode", trigger: "使用 Orchestrator (Argon) 总控模式：" },
        { id: "plan", name: "/plan 规划模式", description: "先厘清目标、依赖与验收标准，再开始执行。", type: "mode", trigger: "/plan " }];
      const seen = new Set();
      return rows.filter((item) => {
        item.id = String(item.id || item.name || "");
        if (!item.id || item.enabled === false || item.disabled === true || item.scope === "off" || item.installed === false) return false;
        if ((item.scope === "project" || item.scope === "worktree") && (!projectRoot || item.projectRoot && item.projectRoot !== projectRoot)) return false;
        const key = `${item.type}:${item.id}`;
        if (seen.has(key)) return false;
        seen.add(key); return true;
      });
    }
    function nativeSlashMenu(editor = visibleComposer()) {
      if (!editor) return null;
      const shell = editor.closest('[data-slot="composer-shell"],[data-composer]') || editor;
      const rect = shell.getBoundingClientRect();
      return [...document.querySelectorAll('[role="listbox"],[cmdk-list],[data-slot="command-list"]')].find((node) => {
        if (root.contains(node) || !node.getClientRects().length || getComputedStyle(node).visibility === "hidden") return false;
        const box = node.getBoundingClientRect();
        return box.width > 50 && box.height > 20 && box.width < 700 && box.bottom >= rect.top - 500 && box.top <= rect.bottom && box.left < rect.right && box.right > rect.left;
      }) || null;
    }
    function pickerToken(editor) {
      if (editor.tagName === "TEXTAREA") {
        const caret = editor.selectionStart ?? editor.value.length;
        return composerToken(editor) || { value: editor.value, caret, start: caret, end: editor.selectionEnd ?? caret, raw: editor.value.slice(caret, editor.selectionEnd ?? caret), query: "" };
      }
      const text = editableText(editor);
      return composerToken(editor) || (text ? { ...text, start: text.caret, end: text.caret, raw: "", query: "" } : { value: editor.textContent || "", caret: 0, start: 0, end: 0, raw: "", query: "" });
    }
    async function openPicker(editor = visibleComposer(), manual = true) {
      if (!editor || disposed || contextLoading || !state.connected) return;
      if (!manual && nativeSlashMenu(editor)) { closeSlash(); return; }
      if (manual && nativeSlashMenu(editor)) {
        editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      }
      closeSlash();
      editor.focus({ preventScroll: true });
      const token = pickerToken(editor), projectRoot = state.projectRoot, route = routeKey(), version = ++slashVersion;
      const selection = window.getSelection();
      const range = editor.tagName !== "TEXTAREA" && selection?.rangeCount && editor.contains(selection.anchorNode) ? selection.getRangeAt(0).cloneRange() : null;
      const session = slashSession = { editor, token, range, projectRoot, route, manual, tab: "all", query: token.query || "", allRows: [], rows: [], active: 0, loading: true, aria: { "aria-controls": editor.getAttribute("aria-controls"), "aria-activedescendant": editor.getAttribute("aria-activedescendant") } };
      renderSlash();
      if (manual) palette.querySelector('[name="slash-query"]')?.focus({ preventScroll: true });
      try {
        const data = await slashData(projectRoot);
        if (disposed || version !== slashVersion || session !== slashSession || projectRoot !== state.projectRoot || route !== routeKey() || !editor.isConnected) return;
        if (!manual && nativeSlashMenu(editor)) { closeSlash(); return; }
        session.allRows = scopedSlashItems(data, projectRoot);
        filterSlashRows();
      } catch (error) { if (session === slashSession) session.error = errorText(error); }
      finally { if (!disposed && version === slashVersion && session === slashSession) { session.loading = false; renderSlash(); } }
    }
    function filterSlashRows() {
      const session = slashSession;
      if (!session) return;
      session.rows = session.allRows.filter((item) => (session.tab === "all" || session.tab === "modes" ? session.tab === "all" || ["mode", "subagent"].includes(item.type) : item.type === session.tab) && matchesSlash(item, session.query)).sort((a, b) => slashRank(a, session.query) - slashRank(b, session.query)).slice(0, 60);
      session.active = Math.min(session.active, Math.max(0, session.rows.length - 1));
    }
    function matchesSlash(item, query) {
      if (!query || [item.id, item.name, item.description, item.providerInstanceId, item.model].join(" ").toLowerCase().includes(query)) return true;
      // Familiar short forms such as $fe also match frontend, without widening
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
      lastComposer = editor; positionConversationTools();
      if (contextLoading || !state.connected || document.activeElement !== editor) { closeSlash(); return; }
      const token = composerToken(editor);
      if (!token || nativeSlashMenu(editor)) { if (!slashSession?.manual) closeSlash(); return; }
      if (slashSession?.editor === editor && slashSession.projectRoot === state.projectRoot && !slashSession.manual) {
        slashSession.token = token; slashSession.query = token.query; filterSlashRows(); renderSlash(); return;
      }
      await openPicker(editor, false);
    }
    function renderSlash() {
      const session = slashSession;
      if (!session || !palette) return;
      const focus = document.activeElement?.name === "slash-query", selection = focus ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
      const project = state.context?.projectName || state.projectRoot?.split(/[\\/]/).pop() || tr("全局", "Global");
      palette.innerHTML = `<div class="hub-slash-header"><span class="hub-slash-key">$ / ￥</span>${esc(tr("技能与编排", "Skills & modes"))}<span class="hub-slash-project">${esc(project)}</span></div><div class="hub-slash-search"><input class="hub-input" name="slash-query" value="${esc(session.query)}" placeholder="${esc(tr("搜索 Skills 或编排指令…", "Search skills or modes…"))}" aria-label="${esc(tr("搜索快捷指令", "Search shortcuts"))}"></div><div class="hub-slash-tabs" role="tablist">${[["all", tr("全部", "All")], ["skill", "Skills"], ["modes", tr("编排指令", "Modes")]].map(([tab, label]) => `<button type="button" role="tab" class="hub-pill ${session.tab === tab ? "is-active" : ""}" data-action="slash-tab" data-tab="${tab}" aria-selected="${session.tab === tab}">${esc(label)}</button>`).join("")}</div><div id="t3-hub-slash-list" class="hub-slash-list" role="listbox" aria-label="${esc(tr("可用快捷指令", "Available shortcuts"))}">${session.loading ? `<div class="hub-slash-empty">${spinner()} ${esc(tr("正在读取当前项目…", "Loading this project…"))}</div>` : session.error ? `<div class="hub-slash-empty" role="status">${esc(session.error)}</div>` : session.rows.length ? session.rows.map((item, index) => {
        const agent = item.type === "subagent", mode = item.type === "mode";
        const badge = agent ? tr("子代理", "Agent") : mode ? tr("模式", "Mode") : "Skill";
        const label = item.displayName || item.title || item.name || item.id;
        return `<div class="hub-slash-row ${index === session.active ? "is-active" : ""}" data-slash-index="${index}" data-slash-id="${esc(item.id)}"><button type="button" id="t3-hub-slash-option-${index}" class="hub-slash-select" role="option" aria-selected="${index === session.active}" data-action="slash-select" data-index="${index}"><span class="hub-slash-type">${icon(agent ? "hub" : mode ? "bolt" : "skill", 13)}</span><span class="hub-grow"><span class="hub-slash-label">${esc(label)}</span><span class="hub-slash-description">${esc(item.shortDescription || item.description || item.developerName || "")}</span></span><span class="hub-badge hub-slash-badge">${esc(badge)}</span></button>${agent ? `<button type="button" class="hub-slash-edit" data-action="slash-edit" data-index="${index}" aria-label="${esc(tr("编辑子代理", "Edit agent"))} ${esc(item.id)}">${icon("edit", 12)}</button>` : ""}</div>`;
      }).join("") : `<div class="hub-slash-empty" role="status">${esc(tr("没有匹配的快捷指令", "No matching shortcuts"))}</div>`}</div><div class="hub-slash-footer"><span>↑↓ · Enter ${esc(tr("插入", "insert"))}</span><span>⌘ / · Esc ${esc(tr("关闭", "close"))}</span></div>`;
      palette.hidden = false;
      if (innerWidth < 760) liveBoard.hidden = true;
      if (!session.aria["aria-controls"] || session.aria["aria-controls"] === "t3-hub-slash-list") {
        session.editor.setAttribute("aria-controls", "t3-hub-slash-list");
        if (session.rows.length) session.editor.setAttribute("aria-activedescendant", `t3-hub-slash-option-${session.active}`);
      }
      if (focus) { const input = palette.querySelector('[name="slash-query"]'); input.focus({ preventScroll: true }); input.setSelectionRange(...selection); }
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
      if (!editor.isConnected || !editor.getClientRects().length || root.classList.contains("is-occluded") || state.open) { closeSlash(); return; }
      if (!slashSession.manual && nativeSlashMenu(editor)) { closeSlash(); return; }
      const surfaceRect = composerSurface(editor).getBoundingClientRect();
      const left = Math.round(Math.max(12, surfaceRect.left));
      const bottom = Math.round(surfaceRect.top - 6);
      const available = bottom - 54;
      if (available < 100) { closeSlash(); return; }
      palette.style.width = `${Math.max(0, Math.min(370, innerWidth - left - 12, surfaceRect.width))}px`;
      palette.style.maxHeight = `${Math.min(460, available)}px`;
      palette.style.left = `${left}px`;
      palette.style.top = "auto";
      palette.style.bottom = `${Math.round(innerHeight - bottom)}px`;
    }
    function onComposerKeyup(event) { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) && !event.altKey) onComposerInput(event); }
    function onComposerKeydown(event) {
      if ((event.metaKey || event.ctrlKey) && event.key === "/" && !event.repeat) {
        event.preventDefault(); event.stopPropagation();
        if (slashSession) closeSlash(); else openPicker();
        return;
      }
      if (!slashSession || event.isComposing || composing) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); const editor = slashSession.editor; closeSlash(); editor.focus({ preventScroll: true }); return; }
      const fromSearch = palette.contains(event.target), session = slashSession;
      if (event.ctrlKey || event.metaKey || !fromSearch && !composerFor(event.target)) return;
      if (["ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        setSlashActive(session.active + (event.key === "ArrowDown" ? 1 : -1));
        palette.querySelector(`#t3-hub-slash-option-${session.active}`)?.scrollIntoView({ block: "nearest" });
      } else if (event.key === "Enter" && session.rows.length) { event.preventDefault(); event.stopPropagation(); selectSlash(session.active); }
    }
    function selectSlash(index) {
      const session = slashSession, item = session?.rows[index];
      if (!item || contextLoading || session.projectRoot !== state.projectRoot || session.route !== routeKey()) { closeSlash(); return; }
      const editor = session.editor;
      const token = session.manual ? session.token : composerToken(editor);
      if (!token || !session.manual && (token.raw !== session.token.raw || token.start !== session.token.start)) { closeSlash(); return; }
      if (editor.tagName === "TEXTAREA" && editor.value !== token.value) { closeSlash(); return; }
      const trigger = item.promptTrigger || item.trigger || (typeof item.prompt === "string" ? item.prompt : "") || `${item.type === "subagent" ? "@" : "$"}${item.skillName || item.name || item.id}`;
      const insertion = /\s$/.test(trigger) ? trigger : `${trigger} `;
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
          let range;
          const start = token.point?.(token.start), end = token.point?.(token.end);
          if (start && end) { range = document.createRange(); range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset); }
          else if (session.range && editor.contains(session.range.startContainer)) range = session.range;
          else { range = document.createRange(); range.selectNodeContents(editor); range.collapse(false); }
          const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
          let emitted = false;
          const observed = () => { emitted = true; };
          editor.addEventListener("input", observed);
          try {
            if (!document.execCommand("insertText", false, insertion)) {
              range.deleteContents(); const node = document.createTextNode(insertion); range.insertNode(node); range.setStartAfter(node); range.collapse(true); selection.removeAllRanges(); selection.addRange(range);
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
    function currentThreadId() {
      const paths = [location.hash?.slice(1), location.pathname, routeHint()].filter(Boolean);
      for (const path of paths) {
        const match = path.match(/(?:^|\/)(?:threads|_chat)\/([^/?#]+)/i);
        if (match) {
          try {
            const decoded = decodeURIComponent(match[1]);
            if (decoded.toLowerCase() === "new") return "__NEW__";
            return decoded;
          } catch {
            if (String(match[1]).toLowerCase() === "new") return "__NEW__";
            return match[1];
          }
        }
      }
      for (const path of paths) {
        const match = path.match(/(?:^|\/)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i);
        if (match) return match[1];
      }
      return state.context?.threadId || state.context?.thread?.id || "__NEW__";
    }
    function syncThread(force = false) {
      const threadId = currentThreadId();
      if (!force && threadId === state.threadId) return false;
      state.threadId = threadId;
      cache.board = null; state.artifact = null; state.boardDraft = "";
      delete errors.board;
      boardVersion++; boardLoading = false; boardSignature = "";
      renderLiveBoard();
      if (state.open && state.tab === "board") renderBoardTab();
      return true;
    }
    function checkRoute() {
      const route = routeKey(), changed = route !== lastRoute;
      if (changed) { lastRoute = route; state.context = null; }
      const threadChanged = syncThread(changed);
      if (changed) refreshContext();
      if (threadChanged) pollBoard();
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
      syncThread();
      if (before !== state.projectRoot) {
        requestVersion++;
        memoryVersion++;
        for (const key of ["hooks", "skills", "subagents", "orchestration", "mcp", "overview", "memory", "worktree", "dream", "health", "agents", "board", "settings"]) { cache[key] = null; delete errors[key]; }
        if (state.scope === "project" && !state.projectRoot) state.scope = "global";
        state.importScope = defaultScope();
        state.subagentScope = defaultScope();
        state.agentsTarget = defaultScope();
        state.memoryProject = state.projectRoot && state.memoryScope !== "global" ? "current" : "global";
        state.artifact = null; state.orchestrationDraft = null; state.settingsDirty = false; state.settingsDraft = {}; state.clearedHostFields.clear(); state.settingsRuleDirty = false; state.settingsRule = ""; settingsSelectionVersion++;
        boardVersion++; boardLoading = false; boardSignature = ""; renderLiveBoard();
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
      pollBoard(); positionConversationTools();
      if (document.activeElement) onComposerInput({ target: document.activeElement });
      if (state.open) {
        if (!state.connected) content.innerHTML = inlineError(state.contextError);
        else { renderTab(); await loadTab(force); primeCatalogs(); }
      }
    }
    async function readCatalog(key, action, payload) {
      try { return await request(action, payload); }
      catch (error) {
        if (key === "hooks" && /unknown action|not (?:yet )?(?:wired|implemented|supported)|unsupported|not found|尚未接入/i.test(errorText(error))) return { items: [], unavailable: true };
        throw error;
      }
    }
    const catalogInflight = new Set();
    async function primeCatalogs() {
      const projectRoot = state.projectRoot, version = contextVersion;
      const domains = [["mcp", "mcp:list"], ["skills", "skills:list"], ["hooks", "hooks:list"], ["subagents", "subagents:list"], ["overview", "memory:overview"]];
      await Promise.all(domains.map(async ([key, action]) => {
        const token = `${version}:${key}`;
        if (cache[key] || catalogInflight.has(token)) return;
        catalogInflight.add(token);
        try {
          const data = await readCatalog(key, action, { projectRoot });
          if (disposed || version !== contextVersion || projectRoot !== state.projectRoot) return;
          cache[key] = data; delete errors[key]; renderChrome();
          if (state.open && (state.tab === key || state.tab === "agents")) renderTab();
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
      if (tab === "board") await pollBoard();
      if (tab === "hooks") await load("hooks", "hooks:list", { projectRoot });
      if (tab === "skills") await Promise.all([load("skills", "skills:list", { projectRoot }), load("mcp", "mcp:list", { projectRoot })]);
      if (tab === "subagents") await Promise.all([load("subagents", "subagents:list", { projectRoot }), load("orchestration", "subagents:orchestration:get", { projectRoot }), load("hooks", "hooks:list", { projectRoot })]);
      if (tab === "mcp") await load("mcp", "mcp:list", { projectRoot });
      if (tab === "agents") await primeCatalogs();
      if (tab === "settings") await loadSettings(force);
      if (tab === "memory") {
        await Promise.all([load("overview", "memory:overview", { projectRoot }), load("worktree", "memory:worktreeInfo", { projectRoot }), load("dream", "memory:dream:get", {}), load("health", "memory:health", { projectRoot }), refreshEmbed(false, force)]);
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
        const data = await request(payload.query ? "memory:search" : "memory:list", payload);
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
      if (cache.embed && !force && !cache.embed.downloadJob?.active && !cache.embed.vectorStats?.reindexing) return;
      const version = ++embedVersion;
      try {
        const data = await request("embed:status", {});
        if (disposed || version !== embedVersion) return;
        const wasActive = cache.embed?.downloadJob?.active;
        const prevVs = cache.embed?.vectorStats;
        const prevMemory = [cache.embed?.activeMb, cache.embed?.ceilingMb, cache.embed?.cacheMb, cache.embed?.rssMb, prevVs?.activeMb, prevVs?.ceilingMb, prevVs?.cacheMb].join("/");
        const nextMemory = [data.activeMb, data.ceilingMb, data.cacheMb, data.rssMb, data.vectorStats?.activeMb, data.vectorStats?.ceilingMb, data.vectorStats?.cacheMb].join("/");
        const prevSig = prevVs ? `${prevVs.syncedVectors}/${prevVs.totalMemories}:${prevVs.reindexing}` : "";
        const nextSig = data.vectorStats ? `${data.vectorStats.syncedVectors}/${data.vectorStats.totalMemories}:${data.vectorStats.reindexing}` : "";
        const wasWaiting = state.embedReadyDeadline > 0;
        cache.embed = data;
        if (!state.embedInitialized) { state.useMirror = !!data.useMirror; state.embedInitialized = true; }
        if (data.downloadJob?.active) state.embedReadyDeadline = Date.now() + 60000;
        if (data.vectorStats?.reindexing) state.embedReadyDeadline = Date.now() + 300000;
        const ready = data.ready ?? data.running ?? data.engine?.ready;
        const keyword = /keyword|fts|none/.test(data.mode || data.engine?.mode || "");
        if ((ready === true || keyword) && !data.vectorStats?.reindexing) state.embedReadyDeadline = 0;
        delete errors.embed;
        if (render && state.tab === "memory") {
          if (!!wasActive !== !!data.downloadJob?.active || prevSig !== nextSig || prevMemory !== nextMemory || wasWaiting && ready === true) renderEngine();
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
      if (!disposed && state.open && state.tab === "memory" && (cache.embed?.downloadJob?.active || state.embedReadyDeadline || cache.embed?.vectorStats?.reindexing)) embedTimer = later(pollEmbed, 1000);
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
      if (state.open) closeSlash();
      if (!root || disposed) return;
      if (state.open && focus) focusReturn = document.activeElement;
      root.classList.toggle("is-open", state.open);
      handle.setAttribute("aria-expanded", String(state.open));
      drawer.setAttribute("aria-hidden", String(!state.open));
      drawer.inert = !state.open;
      positionConversationTools();
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
      const theme = storageGet("t3-hub-theme") || "white";
      if (theme !== state.theme) applyTheme(theme);
      const lang = detectLang();
      if (lang !== state.lang) {
        state.lang = lang;
        renderChrome(); renderLiveBoard();
        if (state.open) renderTab();
        if (slashSession) renderSlash();
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
      if (!target || (!root.contains(target) && !liveBoard?.contains(target)) || target.disabled) return;
      if (target === handle) { if (!suppressClick) setOpen(!state.open); return; }
      const action = target.dataset.action;
      const id = target.dataset.id;
      if (action === "set-theme") setTheme(target.dataset.theme);
      else if (action === "open-board-studio") { switchTab("board"); setOpen(true); }
      else if (action === "set-width") setWidth(target.dataset.width);
      else if (action === "open-picker") { if (slashSession) closeSlash(); else openPicker(); }
      else if (action === "slash-tab") { if (slashSession) { slashSession.tab = target.dataset.tab; slashSession.active = 0; filterSlashRows(); renderSlash(); } }
      else if (action === "library-view") { state.libraryView = target.dataset.view; renderTab(); loadTab(); }
      else if (action === "hooks-fold") { state.hooksOpen = !state.hooksOpen; }
      else if (action === "resource-filter") { resourceFilter(target.dataset.domain).agent = target.dataset.agent; renderTab(); }
      else if (action === "resource-toggle") toggleResource(target);
      else if (action === "resource-toggle-all") toggleResource(target, true);
      else if (action === "toggle-board") { state.boardExpanded = !state.boardExpanded; storageSet("t3-hub-board-expanded", state.boardExpanded); renderLiveBoard(); }
      else if (action === "board-background") { state.boardBackground = !state.boardBackground; renderLiveBoard(); if (state.tab === "board") renderBoardTab(); }
      else if (action === "board-add") updateBoard(target, "add");
      else if (action === "board-step") updateBoard(target, "toggle", Number(target.dataset.index));
      else if (action === "board-clear") updateBoard(target, "clear");
      else if (action === "read-artifact") readArtifact(Number(target.dataset.index), target);
      else if (action === "close-artifact") { state.artifact = null; renderBoardTab(); }
      else if (action === "memory-scope-filter") setMemoryScope(target.dataset.scope);
      else if (action === "open-memory-folder") busy("memory-folder", target, () => request("memory:openFolder", memoryPayload()));
      else if (action === "promote-memory") promoteMemory(id, target);
      else if (action === "dream-fold") { state.dreamOpen = !state.dreamOpen; }
      else if (action === "toggle-dream") saveDream({ enabled: !dreamConfig().enabled });
      else if (action === "run-dream") runDream();
      else if (action === "import-host-memories") importHostMemories(target);
      else if (action === "trim-embed") trimEmbedCache(target);
      else if (action === "toggle-swarm") { const values = orchestrationValues(); state.orchestrationDraft = { ...values, swarmEnabled: !values.swarmEnabled }; renderSubagents(); }
      else if (action === "toggle-worktree-isolation") { const values = orchestrationValues(); state.orchestrationDraft = { ...values, autoWorktreeIsolation: !values.autoWorktreeIsolation }; renderSubagents(); }
      else if (action === "save-orchestration" || action === "sync-orchestration") saveOrchestration(target, action === "sync-orchestration");
      else if (action === "settings-host" || action === "matrix-settings") {
        if (state.settingsHost !== target.dataset.agent) {
          state.settingsHost = target.dataset.agent; cache.settings = null; cache.settingsRule = null; settingsVersion++; settingsSelectionVersion++;
          state.settingsDraft = {}; state.clearedHostFields.clear(); state.settingsDirty = false; state.settingsRuleDirty = false; state.settingsRule = "";
          delete errors.settings; delete errors.settingsRule;
        }
        if (state.tab !== "settings") switchTab("settings");
        else { renderSettings(); loadSettings(); }
      }
      else if (action === "clear-native-setting") {
        const key = target.dataset.hostFieldClear;
        if (!editableSettingKeys().includes(key)) return;
        editNativeSetting(key, "", true);
        renderSettings();
        content.querySelector(`[data-settings-key="${key}"]`)?.focus();
      }
      else if (action === "save-native-settings") saveNativeSettings(target);
      else if (action === "save-native-rule") saveNativeSettings(target, true);
      else if (action === "reload-native-settings") loadSettings(true);
      else if (action === "matrix-resource") { resourceFilter(target.dataset.domain).agent = target.dataset.agent; resourceFilter(target.dataset.domain).status = "enabled"; switchTab(target.dataset.domain); }
      else if (action === "close") setOpen(false);
      else if (action === "tab") switchTab(target.dataset.tab);
      else if (action === "refresh") refresh();
      else if (action === "hook-scope") setDomainScope("hooks", id, target.dataset.scope, target);
      else if (action === "new-hook") { state.hookDraft ||= { title: "", event: "Stop", matcher: "", command: "", scope: defaultScope() }; renderSubagents(); content.querySelector('[name="hook-title"]')?.focus(); }
      else if (action === "cancel-hook") { state.hookDraft = null; renderSubagents(); }
      else if (action === "save-hook") saveHook(target);
      else if (action === "delete-hook") target.closest(".hub-hook-card").querySelector("[data-hook-confirm]").hidden = false;
      else if (action === "cancel-delete-hook") target.closest("[data-hook-confirm]").hidden = true;
      else if (action === "confirm-delete-hook") deleteHook(id, target);
      else if (action === "remove-skill") target.closest(".hub-card,.hub-resource-row").querySelector("[data-skill-confirm]").hidden = false;
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
      if (name === "slash-query" && slashSession) { slashSession.query = input.value.toLowerCase(); slashSession.active = 0; filterSlashRows(); renderSlash(); return; }
      if (name === "board-step-draft") { state.boardDraft = input.value; return; }
      if (name === "native-setting") {
        const key = input.dataset.settingsKey;
        if (!editableSettingKeys().includes(key)) return;
        editNativeSetting(key, input.value);
        syncNativeSettingField(input, key);
        return;
      }
      if (name === "native-rule") { state.settingsRule = input.value; state.settingsRuleDirty = true; return; }
      if (name === "orchestration-concurrency" || name === "orchestration-concurrency-range") {
        const maxConcurrency = Math.max(1, Math.min(20, Number(input.value) || 1));
        state.orchestrationDraft = { ...orchestrationValues(), maxConcurrency };
        content.querySelectorAll('[name="orchestration-concurrency"],[name="orchestration-concurrency-range"]').forEach((node) => { if (node !== input) node.value = String(maxConcurrency); });
        return;
      }
      if (name?.startsWith("subagent-")) {
        const id = input.dataset.subagentId, key = subagentKey(id), field = name.slice(9);
        if (field === "customModel") { if (state.subagentCustom[key]) state.subagentCustom[key].value = input.value; }
        else if (["id", "toolBadge", "description", "systemPrompt"].includes(field)) { const draft = subagentDraft(id); if (draft) { draft[field] = input.value; if (field === "id") draft.name = input.value; } }
        return;
      }
      if (false) {}
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
      if (name === "dream-engine") {
        const preset = dreamPresets().find((item) => item.id === input.value);
        if (preset) saveDream({ dreamMode: preset.dreamMode, providerInstanceId: preset.providerInstanceId, model: preset.model, ...(preset.reasoningEffort ? { reasoningEffort: preset.reasoningEffort } : {}) });
        return;
      }
      if (name === "dream-time") { saveDream({ dreamTime: input.value }); return; }
      if (name === "dream-catch-up") { saveDream({ catchUpOnWake: input.checked }); return; }
      if (name === "resource-status") { resourceFilter(input.dataset.domain).status = input.value; renderTab(); return; }
      if (name === "orchestration-mode") { state.orchestrationDraft = { ...orchestrationValues(), orchestratorMode: input.value }; renderSubagents(); return; }
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
      else if (name === "new-memory-scope") { drafts.__new ||= {}; drafts.__new.scope = input.value; }
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
      else if ((event.metaKey || event.ctrlKey) && key === "s" && state.open && state.tab === "settings" && root.contains(document.activeElement)) { event.preventDefault(); const rule = document.activeElement?.name === "native-rule"; saveNativeSettings(root.querySelector(`[data-action="${rule ? "save-native-rule" : "save-native-settings"}"]`), rule); }
    }
    function onEditorKeydown(event) {
      const input = event.target;
      if (input.name === "board-step-draft" && event.key === "Enter" && !event.isComposing) { event.preventDefault(); updateBoard(input, "add"); return; }
      if (input.getAttribute("role") === "tab" && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const tabs = tabKeys;
        const index = tabs.indexOf(state.tab);
        const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length;
        switchTab(tabs[next], true);
        return;
      }
      if (input.name === "native-setting" || input.tagName !== "TEXTAREA" || event.key !== "Tab" || event.metaKey || event.ctrlKey || event.altKey) return;
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

    async function setDomainScope(domain, id, scope, element) {
      const projectRoot = state.projectRoot;
      const item = hookItems().find((entry) => String(entry.id) === id);
      if (!item || item.readonly || item.unavailable || scope === "project" && !projectRoot) return;
      await busy(`${domain}-scope:${id}`, element, async () => {
        const result = await request("hooks:toggle", { id, scope, projectRoot });
        if (disposed || projectRoot !== state.projectRoot) return;
        const list = items(cache[domain], ["items", domain]);
        const original = list.find((entry) => String(entry.id) === id);
        if (original) Object.assign(original, result.item || {}, { scope });
        if (state.tab === "subagents") renderSubagents();
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
        if (state.tab === "subagents") await loadTab(true);
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
        if (state.tab === "subagents") await loadTab(true);
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
        if ((state.tab === "skills" && state.libraryView === "mcp")) renderMcpList();
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
        if ((state.tab === "skills" && state.libraryView === "mcp")) await loadTab(true);
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
        if (!disposed) { state.mcpAddOpen = false; state.mcpForm = { kind: "form", name: "", transport: "stdio", command: "", args: "", url: "", json: "" }; cache.mcp = null; toast(tr("自定义 MCP 已添加", "Custom MCP added")); if ((state.tab === "skills" && state.libraryView === "mcp")) await loadTab(true); }
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
        const saveScope = id == null ? draft.scope || (state.memoryScope === "worktree" ? "worktree" : payload.scope) : record?.scope || payload.scope;
        const result = await request("memory:save", { ...payload, ...(saveScope === "global" ? { projectRoot: null, projectSlug: "_global" } : {}), scope: saveScope, id: id || undefined, title: draft.title.trim(), content: draft.content, module: draft.module || record?.module || record?.category || "topics", ...(id == null && draft.supersedes ? { supersedesId: draft.supersedes } : {}) });
        if (disposed) return;
        if (id == null) delete drafts.__new;
        else if (drafts[key]?.content === draft.content) delete drafts[key];
        const now = memoryPayload();
        if (selection === JSON.stringify([state.memoryProject, now.projectRoot, now.projectSlug])) {
          state.selectedMemory = result.item?.id || result.memory?.id || result.id || id;
          if (id == null && saveScope === "global") { state.memoryScope = "global"; state.memoryProject = "global"; }
          else if (id == null && saveScope === "worktree") state.memoryScope = "worktree";
          else if (id == null && state.memoryScope === "worktree") state.memoryScope = "project";
          if (state.tab === "memory") { renderMemory(); await refreshMemoryOverview(); await loadMemories(); }
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
        if (!disposed && state.projectRoot === projectRoot) { cache.overview = data; delete errors.overview; if (state.tab === "memory") { renderMemoryNav(); renderDream(); } }
      } catch (error) { if (!disposed && state.projectRoot === projectRoot) { errors.overview = error; if (state.tab === "memory") { renderMemoryNav(); renderDream(); } } }
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
      selectTab: (tab) => switchTab(tab),
      snapshot: () => ({ boardBackground: state.boardBackground, boardDraft: state.boardDraft, orchestrationDraft: state.orchestrationDraft, settingsHost: state.settingsHost, settingsRule: state.settingsRule, settingsRuleDirty: state.settingsRuleDirty, settingsDraft: state.settingsDraft, settingsDirty: state.settingsDirty, clearedHostFields: [...state.clearedHostFields], width: state.width, resourceFilters: state.resourceFilters, memoryScope: state.memoryScope, boardExpanded: state.boardExpanded, scope: state.scope, historyExpanded: state.historyExpanded, open: state.open, tab: state.tab, skillQuery: state.skillQuery, skillFilter: state.skillFilter, importRepo: state.importRepo, memoryProject: state.memoryProject, memoryModule: state.memoryModule, memoryQuery: state.memoryQuery, selectedMemory: state.selectedMemory, agentsTarget: state.agentsTarget, agentDrafts: state.agentDrafts, subagentScope: state.subagentScope, subagentDrafts: state.subagentDrafts, subagentExpanded: state.subagentExpanded, subagentCustom: state.subagentCustom, drafts }),
      destroy: () => {
        if (disposed) return;
        closeSlash();
        slashCache.clear();
        disposed = true;
        contextVersion++; requestVersion++; memoryVersion++; embedVersion++; boardVersion++;
        clearInterval(routeTimer);
        timers.forEach(clearTimeout);
        timers.clear();
        observer?.disconnect();
        anchorResize?.disconnect();
        if (updateFrame) cancelAnimationFrame(updateFrame);
        try { unsubscribeRouter?.(); } catch {}
        unsubscribeRouter = null;
        cachedRouter = null;
        disposers.splice(0).forEach((dispose) => { try { dispose(); } catch {} });
        liveBoard?.remove(); root?.remove(); style?.remove();
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
