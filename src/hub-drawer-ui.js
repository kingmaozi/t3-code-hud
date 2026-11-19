(() => {
  "use strict";

  window.__t3HubDrawerEmbedded = true;
  const previous = window.__t3SidecarHub, previousOptions = previous?.options || {};
  let restored = previous?.snapshot?.() || null;
  try { previous?.destroy?.(); } catch {}

  window.__t3MountSidecarHub = function mountSidecarHub(opts = {}) {
    const existing = window.__t3SidecarHub;
    if (existing) { restored = existing.snapshot?.() || restored; try { existing.destroy?.(); } catch {} }
    const initial = restored; restored = null;
    const disposers = [], timers = new Set(), pending = new Set(), inFlightNativeSaves = new Map(), subagentSaves = new Map(), boardViewSnapshots = new WeakMap();
    let disposed = false, routeTimer = null, embedTimer = null, searchTimer = null, toastTimer = null, observer = null;
    let anchorCache = null, anchorRoute = "", anchorScanAt = 0, anchorResize = null, updateFrame = 0;
    let root, drawer, content, handle, planHandle, titleControls, memoryHandle, memoryToggle, style, liveBoard, occlusionBoardRect = null;
    let boardTimer = null, boardLoading = false, boardVersion = 0, boardScopeVersion = 0, artifactVersion = 0;
    let resizeDrag = null, lastComposer = null, boardSignature = "", boardRenderedSignature = "", boardRenderKey = "";
    let boardTabRenderPending = false, boardEditorNeedsSync = false, boardDraftEditSeq = 0, focusReturn = null;
    let requestVersion = 0, contextVersion = 0, memoryVersion = 0, memoryAccessVersion = 0, memoryAccessLoading = null, embedVersion = 0, embedProjectKey = "", settingsVersion = 0, settingsSelectionVersion = 0;
    let lastRoute = "", lastBoardRoute = "", cachedRouter = null, unsubscribeRouter = null, routerProbeAt = 0;
    let boardDrag = null, contextLoading = true;
    const tabKeys = ["memory"];
    const tabAliases = { skills: "memory", mcp: "memory", plugins: "memory", hooks: "memory", subagents: "memory", settings: "memory", agents: "memory", board: "memory" };
    const storedTab = initial?.tab || storageGet("t3-hub-tab") || "memory";
    const restoredSubView = initial?.settingsSubView || (storedTab === "agents" ? "agents" : "native");
    const normalizedTab = tabAliases[storedTab] || storedTab;
    const cache = { hooks: null, skills: null, plugins: null, subagents: null, orchestration: null, mcp: null, connections: null, agentAccess: null, overview: null, memory: null, worktree: null, embed: null, agents: null, board: null, settings: null, settingsRule: null };
    const errors = {}, drafts = initial?.drafts || {};
    const state = {
 open: initial?.open ?? false, tab: normalizedTab, settingsSubView: restoredSubView === "agents" ? "agents" : "native", width: Number(initial?.width || storageGet("t3-hub-width")) || 880,
 resourceFilters: initial?.resourceFilters || {}, memoryScope: ["smart", "project", "worktree"].includes(initial?.memoryScope) ? initial.memoryScope : "smart",
 boardExpanded: storageGet("t3-hub-dashboard-expanded-v1") === null ? true : (initial?.boardExpanded ?? storageGet("t3-hub-dashboard-expanded-v1") === "true"),
 boardBackground: initial?.boardBackground || false, artifact: null, boardDraft: initial?.boardDraft || "", orchestrationDraft: initial?.orchestrationDraft || null,
 planOpen: false, planPinned: false, planHovering: false, memoryAgentAccessUpdating: false, memorySetupPromptVisible: false, memoryMcpConfigVisible: false, memorySetupNotice: "",
 memoryImporting: false, embedTrimming: false, memoryVectorTestRunning: false, memoryVectorTest: null,
 settingsHost: initial?.settingsHost || "codex", settingsRule: initial?.settingsRule || "", settingsRuleDirty: initial?.settingsRuleDirty || false,
 settingsDraft: initial?.settingsDraft && typeof initial.settingsDraft === "object" && !Array.isArray(initial.settingsDraft) ? initial.settingsDraft : {}, settingsDirty: initial?.settingsDirty || false,
 clearedHostFields: new Set(Array.isArray(initial?.clearedHostFields) ? initial.clearedHostFields : []),
 scope: initial?.scope || storageGet("t3-hub-scope") || "global", libraryView: "skills", hooksOpen: false,
 mcpQuery: "", mcpFilter: initial?.mcpFilter || "all", hookDraft: null, historyExpanded: initial?.historyExpanded || {}, supersedeItems: [], supersedeLoading: false,
 lang: "zh", theme: storageGet("t3-hub-theme") || "white", dark: false, context: null, connected: false, threadId: null, contextError: "", projectRoot: null, refreshing: false,
 skillQuery: initial?.skillQuery || "", skillFilter: initial?.skillFilter || "all", importScope: "project", importRepo: initial?.importRepo || "",
 memoryProject: initial?.memoryProject || "current", memoryModule: initial?.memoryModule || "all", memoryQuery: initial?.memoryQuery || "", selectedMemory: initial?.selectedMemory || null,
 agentsTarget: initial?.agentsTarget || "global", agentDrafts: initial?.agentDrafts || {}, subagentScope: initial?.subagentScope || "global",
 subagentDrafts: initial?.subagentDrafts || {}, subagentExpanded: initial?.subagentExpanded || {}, subagentCustom: initial?.subagentCustom || {},
 modelChoice: "", customModel: "", useMirror: false, mcpAddOpen: false, mcpForm: { kind: "form", name: "", transport: "stdio", command: "", args: "", url: "", json: "" },
 syncedTargets: [], embedInitialized: false, embedReadyDeadline: 0,
    };
 if (!tabKeys.includes(state.tab)) state.tab = "memory";
 if (storedTab !== state.tab) storageSet("t3-hub-tab", state.tab);
    if (!["global", "project"].includes(state.scope)) state.scope = "global";
    // Memory is always bound to the current confirmed project. Migrate restored global or
    // previously selected-project state before rendering so it cannot silently widen scope.
    const migrateMemoryScope = state.scope !== "project" || state.memoryProject !== "current" || !["smart", "project", "worktree"].includes(state.memoryScope);
    state.scope = "project";
    state.memoryProject = "current";
    if (!["smart", "project", "worktree"].includes(state.memoryScope)) state.memoryScope = "smart";
    if (drafts.__new?.scope === "global") { drafts.__new.scope = "project"; drafts.__new.migratedFromGlobal = true; }
    if (migrateMemoryScope) storageSet("t3-hub-scope", "project");

    async function hubRpc(action, payload = {}) {
 let result;
 if (typeof opts?.hubRpc === "function") result = await opts.hubRpc(action, payload);
 else if (typeof window.__t3HubRpc === "function") result = await window.__t3HubRpc(action, payload);
 else if (typeof window.__t3HudBridge?.getGitGraph === "function") result = await window.__t3HudBridge.getGitGraph("__HUB_RPC__", action, payload);
 else throw new Error(tr("Hub 连接暂不可用", "Hub connection is unavailable"));
 return result;
    }
    async function request(action, payload = {}) {
 const result = await hubRpc(action, payload);
 if (result?.ok === false || result?.success === false) {
 const error = new Error(result.error?.message || result.error || result.message || tr("操作未完成", "The action could not be completed"));
 error.code = result.error?.code || result.code;
 throw error;
 }
 return result?.data ?? result?.result ?? result ?? {};
    }
    async function requestMemoryAccess(action, payload = {}) {
 const raw = await hubRpc(action, payload);
 const value = raw?.data ?? raw?.result ?? raw ?? {};
 const hasMemoryStatus = (result) => result && typeof result === "object" && (Object.hasOwn(result, "setupSummary") || Object.hasOwn(result, "access") || ["enabled", "disabled", "unknown"].includes(result.state));
 if ((raw?.ok === false && !hasMemoryStatus(raw)) || raw?.success === false || (value?.ok === false && !hasMemoryStatus(value))) {
 const error = new Error(raw?.error?.message || raw?.error || value?.error?.message || value?.error || raw?.message || value?.message || tr("本机记忆接入检查未完成", "Local memory access could not be completed"));
 error.code = raw?.error?.code || raw?.code || value?.error?.code || value?.code;
 throw error;
 }
 return value;
    }
    function storageGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
    function storageSet(key, value) { try { localStorage.setItem(key, String(value)); } catch {} }
    function tr(zh, en) { return state.lang === "en" ? en : zh; }
    function isAgentsView() { return state.tab === "settings" && state.settingsSubView === "agents"; }
    function esc(value) {
 return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    }
    function escIdentity(value) { return esc(value).replace(/\r/g, "&#13;"); }
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
 file: '<path d="M6 3h8l5 5v13H6zM14 3v5h5M9 13h7M9 17h7"/>',
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
 for (const node of [root, liveBoard, handle, planHandle, titleControls].filter(Boolean)) {
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
 document.getElementById("t3-hub-handle")?.remove();
 document.getElementById("t3-hub-title-controls")?.remove();
 document.getElementById("t3-hub-plan-handle")?.remove();
 document.getElementById("t3-sidecar-hub-root")?.remove();
 document.getElementById("t3-sidecar-hub-styles")?.remove();
 style = document.createElement("style");
      style.id = "t3-sidecar-hub-styles";
      style.textContent = `#t3-hub-plan-handle{position:relative;right:auto;top:auto;z-index:1;display:inline-flex;align-items:center;justify-content:center;min-width:25px;height:25px;padding:3px 7px;border:1px solid var(--hub-border);border-radius:7px;background:var(--hub-bg);color:var(--hub-ink);font-size:10px;line-height:1;vertical-align:middle;cursor:pointer}#t3-hub-plan-handle[hidden]{display:none!important}.hub-plan-indicator{display:inline-flex;align-items:center;gap:3px;font-variant-numeric:tabular-nums}.hub-plan-indicator i{font-style:normal;color:var(--hub-muted)}#t3-hub-live-board{z-index:2147483001;box-sizing:border-box;padding:0;max-width:calc(100vw - 16px);overflow:auto;border:1px solid var(--hub-border);border-radius:11px;background:var(--hub-bg);color:var(--hub-ink);box-shadow:0 12px 36px #0f172a24,0 2px 8px #0f172a12;font:11px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}#t3-hub-live-board[hidden]{display:none!important}.hub-plan-popover{padding:12px 14px}.hub-plan-summary{display:flex;align-items:baseline;gap:6px;margin-bottom:8px;color:var(--hub-secondary);font-size:10px}.hub-plan-summary strong{color:var(--hub-ink);font-size:12px;font-variant-numeric:tabular-nums}.hub-plan-steps{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}.hub-plan-steps .hub-board-step{display:flex;gap:8px;align-items:flex-start;min-width:0;font-size:11px;line-height:1.55}.hub-plan-steps .hub-step-icon{flex:none;margin-top:1px}.hub-plan-steps .hub-step-text{min-width:0;overflow-wrap:anywhere}.hub-plan-document{max-height:280px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--hub-secondary);font-size:10px}.hub-plan-steps .is-completed .hub-step-text{text-decoration:line-through;color:var(--hub-muted)}
.hub-board-studio .hub-step-text{min-width:0;overflow-wrap:anywhere}.hub-board-add .hub-input{min-width:0}
@media(max-width:600px){.hub-artifact-preview>.hub-row>.hub-grow{flex-basis:100%}}
.hub-native-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:0 20px;margin-top:16px}.hub-native-key{display:block;font:10px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--hub-muted);overflow-wrap:anywhere}.hub-native-fields .hub-hint{margin-top:5px}.hub-native-settings .hub-settings-host-description{overflow-wrap:anywhere}
.hub-native-field-heading{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:4px 8px;min-height:24px}.hub-native-field-heading label{font-weight:550}.hub-native-clear{border:0;border-radius:5px;background:var(--hub-bg-subtle);padding:3px 6px;font-size:9px!important;line-height:1.6;white-space:nowrap}.hub-native-clear:hover{background:var(--hud-hover)}.hub-native-field textarea{resize:vertical;min-height:36px}.hub-native-empty{display:inline-flex;margin-top:5px;padding:2px 6px;border:1px solid var(--hub-border);border-radius:5px;font-size:9px;line-height:1.6;color:var(--hub-secondary);background:var(--hub-bg-subtle)}
#t3-sidecar-hub-root{--hub-bg:#fff;--hub-bg-subtle:#f7f7f8;--hub-border:#ececec;--hub-ink:#0d0d0d;--hub-secondary:#5d5d5d;--hub-muted:#8e8e93;--hub-active:#0d0d0d;--hub-on-active:#fff;--hud-bg:var(--hub-bg);--hud-bg-solid:var(--hub-bg);--hud-fg:var(--hub-ink);--hud-muted:var(--hub-secondary);--hud-surface:var(--hub-bg-subtle);--hud-border:var(--hub-border);--hud-hover:rgba(0,0,0,.045);--hud-shadow:0 16px 64px #00000014,0 2px 8px #00000008;--hud-emerald:var(--hub-ink);--hud-blue:var(--hub-ink);--hud-violet:var(--hub-ink);--hud-amber:var(--hub-secondary);--hud-red:var(--hub-ink);--hub-accent-bg:var(--hub-bg-subtle);position:fixed;inset:0;z-index:9993;pointer-events:none;color:var(--hub-ink);font:12px/1.6 -apple-system,BlinkMacSystemFont,"Inter Variable","Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased;color-scheme:light}
#t3-sidecar-hub-root,#t3-sidecar-hub-root *{box-sizing:border-box}#t3-sidecar-hub-root :is(button,input,select,textarea){font:inherit;letter-spacing:inherit;color:inherit}#t3-sidecar-hub-root button{cursor:pointer;-webkit-app-region:no-drag}#t3-sidecar-hub-root button:disabled{opacity:.38;cursor:not-allowed}#t3-sidecar-hub-root :is(button,input,select,textarea):focus-visible{outline:2px solid var(--hub-ink);outline-offset:3px}#t3-sidecar-hub-root svg{flex:none;vertical-align:middle}#t3-sidecar-hub-root [hidden]{display:none!important}
#t3-hub-title-controls{display:inline-flex;align-items:center;gap:6px;margin-left:8px;vertical-align:middle;pointer-events:auto;white-space:nowrap;-webkit-app-region:no-drag}#t3-hub-title-controls[hidden]{display:none!important}#t3-hub-title-controls>button{display:inline-flex;align-items:center;justify-content:center;gap:5px;min-width:0;height:27px;padding:4px 9px;border:1px solid #dbe4f0;border-radius:999px;background:#f8fafc;color:#253247;font:10px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-weight:550;white-space:nowrap;cursor:pointer;pointer-events:auto;-webkit-app-region:no-drag}#t3-hub-title-controls>button:hover,#t3-hub-title-controls>button:focus-visible{background:#f1f6ff;border-color:#c8dcff}#t3-hub-memory-toggle[aria-checked="true"]{border-color:#bfdbfe;background:#eff6ff;color:#1d4ed8}#t3-hub-memory-toggle[aria-checked="mixed"]{border-style:dashed;color:#64748b}#t3-hub-memory-toggle:disabled{opacity:.55;cursor:wait}
#t3-hub-plan-handle{position:relative;padding:4px 9px;border:1px solid #dbe4f0;border-radius:999px;background:#f8fafc;color:#253247;font-size:10px;pointer-events:auto}.is-open #t3-hub-plan-handle{display:none}
#t3-sidecar-hub-root #t3-hub-drawer{position:fixed;right:12px;top:12px;bottom:12px;width:min(var(--hub-width,880px),94vw);max-height:calc(100dvh - 24px);display:grid;grid-template-columns:196px minmax(0,1fr);grid-template-rows:auto minmax(0,1fr) auto;border:1px solid var(--hub-border);border-radius:16px;background:var(--hub-bg);box-shadow:var(--hud-shadow);overflow:hidden;pointer-events:none;visibility:hidden;opacity:0;transform:translateX(calc(100% + 28px));transition:transform .24s ease,opacity .2s,visibility .24s;-webkit-app-region:no-drag}#t3-sidecar-hub-root.is-open #t3-hub-drawer{pointer-events:auto;visibility:visible;opacity:1;transform:none}#t3-sidecar-hub-root.is-occluded{visibility:hidden!important}#t3-sidecar-hub-root.is-occluded :is(#t3-hub-drawer,#t3-hub-live-board){visibility:hidden!important;pointer-events:none!important}
#t3-hub-drawer.is-compact{grid-template-columns:156px minmax(0,1fr)}.hub-header{grid-column:1/-1;padding:20px 24px 16px;border-bottom:1px solid var(--hub-border)}.hub-title-row,.hub-row{display:flex;align-items:center;gap:9px;min-width:0}.hub-title-row{gap:11px}.hub-brand{display:grid;place-items:center;width:32px;height:32px;border:1px solid var(--hub-border);border-radius:9px;background:var(--hub-bg-subtle)}.hub-grow{min-width:0;flex:1}.hub-title{font-size:17px;font-weight:650;letter-spacing:-.5px;line-height:1.4}.hub-version{font-size:10px;color:var(--hub-muted);font-weight:450;margin-left:5px}.hub-kicker{color:var(--hub-secondary);font-size:11px;margin-top:2px}.hub-icon-btn{display:inline-grid;place-items:center;flex:none;width:30px;height:30px;border:0;border-radius:7px;background:transparent;color:var(--hub-secondary)!important}.hub-icon-btn:hover{background:var(--hud-hover);color:var(--hub-ink)!important}.hub-scope-bar{display:flex;gap:8px;align-items:center;margin-top:15px}.hub-scope-select{max-width:280px}.hub-shortcut{font-size:10px;color:var(--hub-muted);margin-left:auto}.hub-context{display:flex;align-items:center;min-width:0;margin-top:10px;font-size:10px;color:var(--hub-secondary)}.hub-context-status{display:flex;gap:6px;align-items:center;overflow:hidden}.hub-context-status>span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.hub-dot{display:inline-block;width:5px;height:5px;border-radius:50%;background:currentColor;flex:none}.hub-widths{display:flex;gap:2px;padding:3px;border:1px solid var(--hub-border);border-radius:8px}.hub-widths button{font-size:10px!important;padding:4px 8px;border:0;border-radius:5px;background:transparent;color:var(--hub-secondary)}.hub-widths button.is-active{background:var(--hub-active);color:var(--hub-on-active)}
.hub-tabs{grid-column:1;grid-row:2;display:flex;flex-direction:column;align-items:stretch;gap:4px;padding:18px 11px;overflow:auto;background:var(--hub-bg-subtle);border-right:1px solid var(--hub-border)}.hub-tab{display:flex;gap:10px;align-items:center;text-align:left;padding:10px 11px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--hub-secondary)!important;font-size:11px!important;line-height:1.5;white-space:nowrap}.hub-tab:hover{background:var(--hud-hover)}.hub-tab[aria-selected=true]{background:var(--hub-active);color:var(--hub-on-active)!important;font-weight:550}.hub-tab-count{margin-left:auto;font-size:9px;opacity:.65;font-variant-numeric:tabular-nums}.hub-content{grid-column:2;grid-row:2;min-width:0;min-height:0;padding:26px 28px 32px;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--hub-border) transparent}.hub-section-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 8px;font-size:15px;font-weight:620;letter-spacing:-.2px}.hub-count{font-size:10px;font-weight:450;color:var(--hub-secondary);font-variant-numeric:tabular-nums}.hub-description{font-size:11px;line-height:1.8;color:var(--hub-secondary);margin:0 0 20px}.hub-card{padding:16px;border:1px solid var(--hub-border);border-radius:12px;background:var(--hub-bg);margin-bottom:12px;min-width:0}.hub-card-top{display:flex;gap:11px;align-items:flex-start;min-width:0}.hub-card-name{font-size:12px;font-weight:600;line-height:1.65;overflow-wrap:anywhere}.hub-card-meta{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-top:4px}.hub-card-description{color:var(--hub-secondary);font-size:11px;line-height:1.75;margin:8px 0 12px;overflow-wrap:anywhere}.hub-badge,.hub-capability{display:inline-flex;gap:4px;align-items:center;border:1px solid var(--hub-border);border-radius:5px;padding:1px 6px;color:var(--hub-secondary);font-size:9px;line-height:1.7;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.hub-capabilities{display:flex;gap:5px;flex-wrap:wrap;margin:8px 0}.hub-badge>span{overflow:hidden;text-overflow:ellipsis}.hub-asset-icon,.hub-brand-icon{width:32px;height:32px;display:grid;place-items:center;flex:none;position:relative;border:1px solid var(--hub-border);border-radius:8px;background:var(--hub-bg-subtle);color:var(--hub-ink);overflow:hidden}.hub-brand-icon>img{position:absolute;inset:3px;width:calc(100% - 6px);height:calc(100% - 6px);object-fit:contain;filter:none!important}.hub-brand-icon.has-image>svg{opacity:0}.hub-brand-icon.is-small{width:24px;height:24px;border-radius:6px}.hub-brand-icon.is-small>img{inset:2px;width:calc(100% - 4px);height:calc(100% - 4px)}.hub-connection-dot{position:absolute;right:2px;bottom:2px;width:5px;height:5px;border-radius:50%;background:var(--hub-muted);box-shadow:0 0 0 2px var(--hub-bg)}.hub-connection-dot.is-connected{background:var(--hub-ink)}
.hub-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:32px;padding:7px 11px;border:1px solid var(--hub-border);border-radius:8px;background:var(--hub-bg);font-size:11px!important;line-height:1.4;white-space:nowrap}.hub-btn:hover:not(:disabled){background:var(--hud-hover)}.hub-btn.hub-primary{background:var(--hub-active);border-color:var(--hub-active);color:var(--hub-on-active)!important;font-weight:550}.hub-btn.hub-primary:hover:not(:disabled){opacity:.85;background:var(--hub-active)}.hub-btn.hub-small{font-size:10px!important;min-height:27px;padding:5px 9px}.hub-btn.is-busy{pointer-events:none;opacity:.65}.hub-spinner{display:inline-block;flex:none;width:12px;height:12px;border:1.5px solid currentColor;border-right-color:transparent;border-radius:50%;animation:hub-spin .7s linear infinite}@keyframes hub-spin{to{transform:rotate(360deg)}}
.hub-input,.hub-select,.hub-editor{display:block;width:100%;min-width:0;border:1px solid var(--hub-border);border-radius:8px;background:var(--hub-bg);color:var(--hub-ink);padding:9px 11px;font-size:11px!important;line-height:1.6}.hub-input::placeholder,.hub-editor::placeholder{color:var(--hub-muted)}.hub-select{padding-right:25px;text-overflow:ellipsis;cursor:pointer}.hub-field{display:block;font-size:10px;color:var(--hub-secondary);margin-bottom:13px;min-width:0}.hub-field>:is(input,textarea,select){margin-top:6px}.hub-editor{font:11px/1.9 ui-monospace,SFMono-Regular,Menlo,monospace!important;min-height:175px;resize:vertical;overflow-wrap:anywhere;tab-size:2}.hub-search{position:relative;margin:14px 0}.hub-search>svg{position:absolute;top:50%;left:11px;transform:translateY(-50%);color:var(--hub-muted)}.hub-search .hub-input{padding-left:34px;background:var(--hub-bg-subtle)}.hub-hint{display:flex;gap:6px;align-items:flex-start;font-size:10px;color:var(--hub-secondary);line-height:1.8;overflow-wrap:anywhere}.hub-filters{display:flex;gap:4px;flex-wrap:wrap;margin:10px 0 15px}.hub-pill{border:1px solid transparent;border-radius:6px;padding:5px 9px;font-size:10px!important;background:transparent;color:var(--hub-secondary)!important;white-space:nowrap}.hub-pill:hover{background:var(--hud-hover)}.hub-pill.is-active,.hub-segments>button.is-active{background:var(--hub-active);color:var(--hub-on-active)!important}.hub-pill-count{font-size:9px;opacity:.6;margin-left:4px}.hub-segments{display:flex;gap:3px;padding:3px;border:1px solid var(--hub-border);border-radius:8px;background:var(--hub-bg-subtle);min-width:0}.hub-segments>button{display:inline-flex;gap:5px;align-items:center;justify-content:center;flex:1;min-width:0;font-size:10px!important;line-height:1.5;white-space:nowrap;border:0;border-radius:5px;background:transparent;padding:6px 8px;color:var(--hub-secondary)}.hub-segments>button:hover:not(.is-active){background:var(--hud-hover)}.hub-resource-filters{padding:0 0 18px;border-bottom:1px solid var(--hub-border);margin-bottom:4px}.hub-agent-filters{display:flex;gap:4px;align-items:center;flex-wrap:wrap}.hub-agent-filters .hub-pill{display:inline-flex;gap:5px;align-items:center}.hub-filter-bottom{display:flex;gap:8px;margin-top:10px}.hub-filter-bottom .hub-search{flex:1;min-width:0;margin:0}.hub-filter-bottom .hub-select{width:94px;font-size:10px!important}.hub-resource-row{display:grid;grid-template-columns:32px minmax(0,1fr);column-gap:12px;padding:19px 0;border-bottom:1px solid var(--hub-border);min-width:0}.hub-resource-row .hub-card-description{margin:4px 0 0}.hub-resource-row .hub-resource-toggle{grid-column:2;margin-top:12px;justify-self:start}.hub-resource-toggle{display:flex;flex-wrap:wrap;gap:7px;align-items:center;min-width:0;max-width:100%}.hub-resource-toggle-label{flex:0 0 100%}.hub-resource-toggle>.hub-btn{font-size:9px!important;min-height:26px;padding:4px 8px}.hub-agent-toggle{display:flex;flex-wrap:wrap;gap:2px;padding:3px;border:1px solid var(--hub-border);border-radius:8px;background:var(--hub-bg-subtle);min-width:0}.hub-agent-toggle button{display:inline-flex;flex:0 0 auto;align-items:center;justify-content:center;gap:4px;min-width:0;border:0;border-radius:5px;padding:5px 7px;background:transparent;color:var(--hub-secondary);font-size:9px!important;line-height:1.4;white-space:nowrap}.hub-agent-toggle button[aria-pressed=true]{background:var(--hub-active);color:var(--hub-on-active)}.hub-agent-mark{width:12px;height:12px;flex:none}.hub-library-tabs{display:flex;gap:6px;border-bottom:1px solid var(--hub-border);margin-bottom:18px;padding-bottom:12px}.hub-market-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,245px),1fr));gap:12px;margin-top:18px}.hub-market-card{margin:0;display:flex;flex-direction:column;align-items:stretch}.hub-market-card>.hub-btn{align-self:flex-start;margin-top:auto}.hub-market-card .hub-card-description{min-height:38px}.hub-market-card .hub-capabilities{margin-bottom:16px}.hub-resource-title{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.hub-mcp-name{font-weight:600;font-size:12px;overflow-wrap:anywhere}.hub-mcp-detail{color:var(--hub-secondary);font-size:10px;margin-top:5px;overflow-wrap:anywhere}.hub-mcp-row-options{display:flex;gap:7px;margin-top:9px}.hub-mode-pill{width:auto;max-width:200px;padding:4px 20px 4px 8px;font-size:9px!important}.hub-live{display:inline-flex;align-items:center;gap:4px;font-size:9px;color:var(--hub-secondary)}.hub-status-strip{border:1px solid var(--hub-border);border-radius:10px;background:var(--hub-bg-subtle);padding:12px;margin:12px 0}.hub-status-items{display:flex;gap:12px;flex-wrap:wrap}.hub-status-item{display:flex;align-items:center;gap:5px;font-size:10px;color:var(--hub-secondary)}
.hub-form-panel,.hub-import,.hub-new-memory{padding:15px;background:var(--hub-bg-subtle);border:1px solid var(--hub-border);border-radius:10px;margin:14px 0}.hub-import-title{font-size:11px;font-weight:550;display:flex;gap:7px;margin-bottom:10px}.hub-import-grid{display:grid;grid-template-columns:minmax(0,1fr) 94px auto;gap:7px}.hub-import .hub-hint{margin-top:8px}.hub-form-grid,.hub-subagent-fields{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px}.hub-custom-toggle{margin:4px 0 14px}.hub-editor-actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-top:12px}.hub-confirm-delete{border:1px solid var(--hub-border);padding:10px;border-radius:8px;background:var(--hub-bg-subtle);font-size:10px;margin-top:10px}.hub-confirm-delete .hub-row{margin-top:8px}.hub-hook-card .hub-card-description{margin-bottom:13px}.hub-hook-command{display:block;white-space:pre-wrap;overflow-wrap:anywhere;font-size:10px;padding:10px;background:var(--hub-bg-subtle);margin:10px 0;border-radius:6px}.hub-group-heading{font-size:11px;margin:22px 0 10px}.hub-hook-group{margin-bottom:20px}.hub-switch{width:30px;height:18px;border:1px solid var(--hub-border);border-radius:20px;position:relative;flex:none;background:var(--hub-bg-subtle);padding:2px}.hub-switch>span{display:block;width:12px;height:12px;border-radius:50%;background:var(--hub-muted);transition:transform .15s}.hub-switch[aria-checked=true]{background:var(--hub-active);border-color:var(--hub-active)}.hub-switch[aria-checked=true]>span{background:var(--hub-on-active);transform:translateX(12px)}
.hub-engine{background:var(--hub-bg-subtle);padding:18px;margin:0 0 26px}.hub-engine-label{font-size:9px;letter-spacing:1.2px;font-weight:650;color:var(--hub-secondary)}.hub-engine-status{display:flex;gap:6px;align-items:center;font-size:11px;font-weight:550;margin:12px 0 7px;flex-wrap:wrap}.hub-engine-model{font-size:10px;color:var(--hub-secondary);overflow-wrap:anywhere;margin-bottom:14px}.hub-engine-controls{display:flex;align-items:stretch;gap:7px}.hub-engine-controls>.hub-select{flex:1}.hub-engine-controls>.hub-btn{font-size:10px!important}.hub-checkbox{display:inline-flex;align-items:center;gap:6px;font-size:10px;color:var(--hub-secondary);margin-top:12px}.hub-checkbox input{accent-color:var(--hub-active);margin:0;width:13px;height:13px}.hub-progress-label{display:flex;justify-content:space-between;font-size:10px;color:var(--hub-secondary);margin:12px 0 6px}.hub-progress-track{height:4px;background:var(--hub-border);border-radius:5px;overflow:hidden}.hub-progress-fill{height:100%;background:var(--hub-ink);border-radius:5px;transition:width .3s}.indeterminate .hub-progress-fill{animation:hub-pulse 1.4s ease infinite}.hub-worktree-bar{margin:15px 0}.hub-worktree-bar .hub-segments{flex-wrap:wrap}.hub-worktree-bar .hub-segments>button{flex:1 1 42%;white-space:normal}.hub-worktree-caption{display:flex;gap:8px;align-items:center;justify-content:space-between;margin-top:8px;color:var(--hub-secondary);font-size:10px}.hub-project-picker{display:flex;gap:8px;align-items:center;margin:12px 0}.hub-project-picker .hub-select{flex:1}.hub-memory-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px}.hub-memory-card{padding:0}.hub-memory-open{display:block;width:100%;text-align:left;padding:14px;border:0;background:transparent;border-radius:11px}.hub-memory-open:hover{background:var(--hud-hover)}.hub-memory-detail{padding:14px;border-top:1px solid var(--hub-border)}.hub-memory-date{margin-left:auto;font-size:9px;color:var(--hub-muted)}.hub-memory-hits{font-size:9px;color:var(--hub-secondary)}.hub-detail-meta{display:flex;gap:7px;align-items:center;font-size:9px;color:var(--hub-secondary);margin-top:8px}.hub-memory-history{padding:0 14px 12px}.hub-history-toggle{border:0;background:transparent;font-size:10px!important;color:var(--hub-secondary)}.hub-history-entry{padding:9px 0;border-top:1px solid var(--hub-border);font-size:10px}.hub-history-agent{font-size:9px;color:var(--hub-secondary)}
.hub-subagent-scopes{display:flex;gap:8px;margin:18px 0}.hub-subagent-scope{flex:1;min-width:0;text-align:left;border:1px solid var(--hub-border);border-radius:9px;background:transparent;padding:10px 12px;font-size:11px!important}.hub-subagent-scope[aria-pressed=true]{background:var(--hub-bg-subtle);border-color:var(--hub-ink)}.hub-subagent-scope small{display:block;color:var(--hub-secondary);font-size:9px;margin-top:3px}.hub-subagent-heading{display:flex;gap:10px;align-items:center;justify-content:space-between;margin:20px 0 10px}.hub-subagent-heading h3{font-size:13px;margin:0}.hub-subagent-heading h3>span{font-size:10px;color:var(--hub-secondary);margin-left:7px;font-weight:400}.hub-subagent-list{border:1px solid var(--hub-border);border-radius:11px;overflow:hidden}.hub-subagent-card{padding:16px;border-bottom:1px solid var(--hub-border);min-width:0}.hub-subagent-card:last-child{border-bottom:0}.hub-subagent-main{display:grid;grid-template-columns:28px minmax(0,1fr);gap:9px;align-items:center}.hub-subagent-summary{min-width:0;text-align:left;border:0;background:transparent;padding:0}.hub-subagent-name{display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:11px;font-weight:600}.hub-tool-badge{font-size:8px;line-height:1.5;font-weight:400;padding:2px 5px;border:1px solid var(--hub-border);border-radius:4px;color:var(--hub-secondary)}.hub-subagent-desc{display:block;font-size:10px;color:var(--hub-secondary);line-height:1.7;margin-top:3px;overflow-wrap:anywhere}.hub-subagent-controls{display:grid;grid-template-columns:minmax(0,.8fr) minmax(0,1.3fr) minmax(0,.8fr);gap:6px;grid-column:2}.hub-subagent-controls .hub-select{font-size:10px!important;padding:7px 20px 7px 8px}.hub-subagent-meta{display:flex;align-items:center;flex-wrap:wrap;gap:7px;margin:10px 0 0 37px}.hub-memory-policy{width:170px;padding:5px 18px 5px 7px;font-size:9px!important}.hub-subagent-edit{display:inline-flex;gap:4px;align-items:center;margin-left:auto;font-size:9px!important;border:0;background:transparent;padding:3px 0;color:var(--hub-secondary)!important}.hub-subagent-expand{display:none}.hub-subagent-expand.is-expanded{display:block}.hub-subagent-editor{border-top:1px solid var(--hub-border);margin-top:14px;padding-top:14px}.hub-subagent-custom{padding:12px;border:1px solid var(--hub-border);border-radius:8px;margin-top:10px}.hub-subagent-note{display:flex;align-items:flex-start;gap:6px;margin-top:14px;font-size:10px;color:var(--hub-secondary);line-height:1.8}.hub-commander{padding:18px;background:var(--hub-bg-subtle)}.hub-commander-title{font-size:14px;font-weight:600;margin-bottom:4px}.hub-commander .hub-description{margin-bottom:16px}.hub-commander-note{padding:10px 12px;border-left:2px solid var(--hub-ink);font-size:10px;line-height:1.9;color:var(--hub-secondary);margin:12px 0 16px}.hub-control-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0;border-top:1px solid var(--hub-border)}.hub-control-row strong{font-size:11px;font-weight:550;display:block}.hub-control-row small{display:block;font-size:10px;color:var(--hub-secondary);margin-top:3px}.hub-range{display:flex;align-items:center;gap:8px;max-width:170px}.hub-range input[type=range]{width:100px;accent-color:var(--hub-active)}.hub-range input[type=number]{width:49px;padding:5px;font-size:10px!important}
.hub-footer{grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 24px;border-top:1px solid var(--hub-border);color:var(--hub-secondary);font-size:9px;min-height:40px;background:var(--hub-bg)}.hub-footer-status{display:flex;align-items:center;gap:6px}.hub-footer-key{color:var(--hub-muted)}.hub-toast{position:absolute;left:20px;right:20px;bottom:53px;display:flex;gap:8px;align-items:center;padding:11px 14px;border:1px solid var(--hub-border);border-radius:10px;background:var(--hub-active);color:var(--hub-on-active);font-size:11px;box-shadow:var(--hud-shadow);pointer-events:auto;z-index:4}.hub-empty{display:flex;flex-direction:column;align-items:center;gap:9px;padding:36px 18px;color:var(--hub-secondary);text-align:center;font-size:11px}.hub-empty strong{font-size:12px;color:var(--hub-ink);font-weight:550}.hub-empty>svg{opacity:.5}.hub-empty>span{font-size:10px;line-height:1.8;max-width:280px}.hub-error{display:flex;gap:9px;align-items:flex-start;border:1px solid var(--hub-border);border-radius:10px;background:var(--hub-bg-subtle);padding:13px;margin:12px 0;color:var(--hub-ink)}.hub-error>div{flex:1;min-width:0}.hub-error strong{font-size:11px;display:block}.hub-error span{display:block;font-size:10px;color:var(--hub-secondary);margin-top:4px;overflow-wrap:anywhere}.hub-skeleton>div{border-bottom:1px solid var(--hub-border);padding:18px 0}.hub-skeleton i{display:block;background:var(--hub-bg-subtle);height:9px;border-radius:3px;margin:9px 0;animation:hub-pulse 1.3s ease infinite}.hub-skeleton i:first-child{width:40%}.hub-skeleton i:last-child{width:70%}@keyframes hub-pulse{50%{opacity:.35}}
#t3-hub-resize-handle{position:absolute;z-index:5;left:0;top:0;bottom:0;width:7px;background:transparent;cursor:ew-resize;touch-action:none;border:0;padding:0}#t3-hub-resize-handle:after{content:"";position:absolute;top:45%;left:2px;width:2px;height:32px;background:var(--hub-border);border-radius:3px}#t3-hub-resize-handle:hover:after{background:var(--hub-ink)}
#t3-hub-live-board{position:fixed;z-index:2147483000;pointer-events:auto;min-width:0;background:var(--hub-bg);color:var(--hub-ink);border:1px solid var(--hub-border);border-radius:0 0 12px 12px;padding:12px 14px;box-shadow:none;overflow:hidden;font:12px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}#t3-hub-live-board[hidden]{display:none!important}#t3-hub-live-board,#t3-hub-live-board *{box-sizing:border-box}#t3-hub-live-board :is(button,input){font:inherit;color:inherit}#t3-hub-live-board button{cursor:pointer}#t3-hub-live-board :focus-visible{outline:2px solid var(--hub-accent);outline-offset:2px}#t3-hub-live-board.is-collapsed{}.hub-board-toggle{flex:1;min-width:0;width:100%;display:flex;gap:8px;align-items:center;justify-content:space-between;border:0;background:transparent;text-align:left;padding:0;font-size:11px!important;font-weight:550}.is-collapsed .hub-board-toggle{padding:0;font-size:11px!important}.hub-board-content{padding:14px 0 0;max-height:420px;overflow:auto}.hub-board-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:2px 0 15px}.hub-board-heading strong{font-size:14px;font-weight:600}.hub-board-background{margin:0 0 16px;padding:10px 11px;background:var(--hub-bg-subtle);border-radius:7px;font-size:10px;color:var(--hub-secondary);white-space:pre-wrap;line-height:1.85}.hub-board-section{font-size:10px;color:var(--hub-secondary);display:flex;align-items:center;justify-content:space-between;margin:18px 0 10px;font-weight:550}.hub-board-section:first-child{margin-top:4px}.hub-board-section b{font-size:11px;font-weight:600;color:var(--hub-ink)}.hub-board-steps{display:flex;flex-direction:column;gap:12px;margin:0;padding:0;list-style:none}.hub-board-step{display:flex;gap:10px;align-items:flex-start;font-size:11px;line-height:1.7;min-width:0}.hub-step-icon{display:grid;place-items:center;flex:none;width:16px;height:19px;font-size:13px;font-weight:600}.hub-board-step.is-completed{color:var(--hub-muted)}.hub-board-step.is-completed .hub-step-text{text-decoration:line-through}.hub-board-step.is-in-progress{font-weight:600;color:var(--hub-ink)}.is-in-progress .hub-step-icon{animation:hub-pulse 1.5s ease infinite}.hub-step-check{padding:0;border:0;background:transparent;line-height:1;color:inherit}.hub-artifacts{display:flex;flex-wrap:wrap;gap:6px}.hub-artifact-chip{border:1px solid var(--hub-border);border-radius:6px;font-size:9px!important;padding:5px 7px;background:var(--hub-bg-subtle);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.hub-board-studio{border:1px solid var(--hub-border);border-radius:12px;padding:20px;margin:0 0 16px}.hub-board-studio .hub-board-step{font-size:12px}.hub-board-studio .hub-board-steps{gap:14px}.hub-board-add{display:flex;gap:7px;margin-top:20px}.hub-board-add .hub-input{flex:1}.hub-artifact-preview{padding:16px;background:var(--hub-bg-subtle);border:1px solid var(--hub-border);border-radius:10px;margin-top:16px}.hub-artifact-preview pre{white-space:pre-wrap;overflow-wrap:anywhere;font:10px/1.9 ui-monospace,SFMono-Regular,Menlo,monospace;max-height:340px;overflow:auto}.hub-native-hosts{margin-bottom:18px}.hub-settings-tabs{display:flex;gap:6px;flex-wrap:wrap;margin:18px 0}.hub-settings-host-description{margin:8px 0 18px;font-size:10px;color:var(--hub-secondary)}
.hub-agents-targets{display:flex;gap:8px;margin:12px 0}.hub-agents-target{min-width:0;flex:1;border:1px solid var(--hub-border);border-radius:9px;background:transparent;padding:12px;text-align:left}.hub-agents-target.is-active{background:var(--hub-bg-subtle);border-color:var(--hub-ink)}.hub-agents-target strong{display:block;font-size:11px}.hub-agents-target small{display:block;font-size:9px;color:var(--hub-secondary)}.hub-token-bar{display:flex;justify-content:space-between;gap:8px;align-items:center;margin:16px 0 9px;font-size:11px}.hub-token{font-size:9px;color:var(--hub-secondary)}.hub-token-warning{font-size:10px;color:var(--hub-secondary)}.hub-agents-editor{min-height:300px}.hub-agents-save{display:flex;gap:8px;justify-content:space-between;margin-top:12px;align-items:center}.hub-saved-hint{font-size:10px;color:var(--hub-secondary)}.hub-sync-badges{display:flex;gap:5px;flex-wrap:wrap;margin-top:14px}.hub-soft-route{margin-top:16px}
#t3-hub-drawer.is-wide .hub-resource-row{grid-template-columns:32px minmax(0,1fr) auto;align-items:center}#t3-hub-drawer.is-wide .hub-resource-row .hub-resource-toggle{grid-column:3;grid-row:1;margin:0}#t3-hub-drawer.is-wide .hub-subagent-main{grid-template-columns:28px minmax(0,1fr) minmax(280px,1fr)}#t3-hub-drawer.is-wide .hub-subagent-controls{grid-column:3}#t3-hub-drawer.is-compact .hub-content{padding:20px 16px}#t3-hub-drawer.is-compact .hub-header{padding:16px}#t3-hub-drawer.is-compact .hub-resource-row .hub-resource-toggle{grid-column:1/-1}#t3-hub-drawer.is-compact .hub-agent-toggle button{padding-inline:5px}#t3-hub-drawer.is-compact .hub-agent-toggle .hub-agent-mark{display:none}#t3-hub-drawer.is-compact .hub-import-grid{grid-template-columns:minmax(0,1fr) auto}#t3-hub-drawer.is-compact .hub-import-grid .hub-select{grid-column:1/-1}#t3-hub-drawer.is-compact .hub-engine-controls{flex-wrap:wrap}#t3-hub-drawer.is-compact .hub-engine-controls .hub-select{flex-basis:100%}#t3-hub-drawer.is-compact .hub-subagent-controls{grid-column:1/-1}#t3-hub-drawer.is-compact .hub-subagent-meta{margin-left:0}
@media(max-width:639px){#t3-sidecar-hub-root #t3-hub-drawer{right:8px;top:8px;bottom:8px;width:calc(100vw - 16px);max-height:calc(100dvh - 16px);grid-template-columns:minmax(0,1fr);grid-template-rows:auto auto minmax(0,1fr) auto;border-radius:13px}.hub-header{padding:15px 16px 13px}.hub-brand{width:28px;height:28px}.hub-title{font-size:15px}.hub-kicker{font-size:10px}.hub-widths{display:none}.hub-title-row{gap:9px}.hub-scope-bar{margin-top:12px}.hub-scope-select{max-width:260px}.hub-context{margin-top:8px}.hub-tabs{grid-column:1;grid-row:2;flex-direction:row;overflow-x:auto;padding:8px;gap:3px;border-right:0;border-bottom:1px solid var(--hub-border);scrollbar-width:none}.hub-tab{padding:7px 9px;font-size:10px!important;gap:6px}.hub-tab-count{display:none}.hub-content{grid-column:1;grid-row:3;padding:21px 17px 26px}.hub-footer{grid-row:4;padding:10px 16px}.hub-resource-toggle{gap:5px;max-width:100%}.hub-agent-toggle button{padding-inline:6px;font-size:9px!important}.hub-agent-toggle button svg{width:10px;height:10px}.hub-resource-row .hub-resource-toggle{grid-column:1/-1}.hub-resource-row{padding:17px 0}.hub-subagent-main{grid-template-columns:28px minmax(0,1fr)}.hub-subagent-controls{grid-column:1/-1}.hub-subagent-meta{margin-left:0}.hub-memory-policy{width:163px}.hub-subagent-edit{margin-left:0}.hub-form-grid,.hub-subagent-fields{grid-template-columns:minmax(0,1fr)}.hub-board-studio{padding:16px}.hub-board-step{font-size:11px}.hub-board-studio .hub-board-step{font-size:11px}.hub-worktree-caption{flex-wrap:wrap}.hub-project-picker{flex-wrap:wrap}.hub-project-picker .hub-select{flex-basis:100%}.hub-import-grid{grid-template-columns:minmax(0,1fr) 86px auto}.hub-import-grid .hub-input{padding-inline:8px;font-size:10px!important}.hub-import-grid .hub-btn{padding-inline:8px}.hub-engine-controls{flex-wrap:wrap}.hub-engine-controls .hub-select{flex-basis:100%}.hub-board-content{max-height:340px}#t3-hub-resize-handle{display:none}}
#t3-sidecar-hub-root .hub-engine{margin-bottom:12px}.hub-dream-card{padding:16px;margin:0 0 26px;background:var(--hub-bg)}.hub-dream-heading{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.hub-dream-title{display:inline-flex;align-items:center;gap:7px;font-size:13px;font-weight:600}.hub-dream-size{margin-left:auto;font-size:9px;color:var(--hub-secondary);white-space:nowrap}.hub-dream-description{font-size:10px;color:var(--hub-secondary);margin:7px 0 13px;line-height:1.8}.hub-dream-controls{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.hub-dream-enable{display:inline-flex;align-items:center;gap:7px;font-size:10px;color:var(--hub-secondary)}.hub-dream-time{display:inline-flex;align-items:center;gap:7px;font-size:10px;color:var(--hub-secondary)}.hub-dream-time .hub-input{width:99px;padding:5px 7px;min-height:30px;font-size:10px!important}.hub-dream-time input::-webkit-calendar-picker-indicator{opacity:.6}.hub-dream-controls .hub-checkbox{margin:0;white-space:nowrap}.hub-dream-controls>.hub-btn{margin-left:auto}.hub-dream-report{padding-top:12px;margin-top:13px;border-top:1px solid var(--hub-border);font-size:10px;line-height:1.85;color:var(--hub-secondary);overflow-wrap:anywhere}.hub-dream-report .hub-hint{font-size:9px;margin-top:5px}.hub-dream-error{font-size:10px;color:var(--hub-ink);border-left:2px solid var(--hub-ink);padding-left:9px;margin:11px 0 0;line-height:1.8}#t3-hub-drawer.is-compact .hub-dream-size{margin-left:0;flex-basis:100%}@media(max-width:639px){.hub-dream-card{padding:15px}.hub-dream-size{margin-left:0;flex-basis:100%}.hub-dream-controls{gap:12px 16px}.hub-dream-controls .hub-checkbox{flex:1}.hub-dream-controls>.hub-btn{font-size:10px!important}}
#t3-sidecar-hub-root .hub-brand-icon,#t3-sidecar-hub-root .hub-brand-icon>img{filter:none!important}
#t3-sidecar-hub-root .hub-agent-toggle button[aria-pressed=true],#t3-sidecar-hub-root .hub-widths button.is-active{color:var(--hub-on-active)}
#t3-sidecar-hub-root .hub-library-tabs{flex-wrap:wrap;gap:3px}#t3-sidecar-hub-root .hub-native-badge{margin-top:2px}.hub-dream-engine-row{display:flex;align-items:flex-end;flex-wrap:wrap;gap:9px;margin:14px 0}.hub-dream-engine{flex:1 1 240px;margin:0!important;min-width:0}.hub-dream-budget{display:inline-flex;align-items:center;gap:5px;max-width:100%;padding:6px 8px;border:1px solid var(--hub-border);border-radius:7px;background:var(--hub-bg-subtle);font-size:9px;color:var(--hub-secondary);line-height:1.6;overflow-wrap:anywhere}.hub-dream-consumption{margin-top:6px;color:var(--hub-ink);font-variant-numeric:tabular-nums}.hub-engine-memory{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin:11px 0 7px;padding-top:10px;border-top:1px solid var(--hub-border)}.hub-engine-memory-values{min-width:0;flex:1 1 200px;font-size:11px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.hub-engine-memory-values>span{display:block;font-weight:550}.hub-engine-memory-values>small{display:block;margin-top:2px;font-size:9px;color:var(--hub-secondary)}.hub-memory-health{font-variant-numeric:tabular-nums}.hub-memory-governance{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:0 0 14px;padding:0 1px}.hub-memory-governance .hub-hint{font-size:9px}.hub-memory-governance>.hub-btn{flex:none}
@media(prefers-reduced-motion:reduce){#t3-sidecar-hub-root *,#t3-sidecar-hub-root *:before,#t3-sidecar-hub-root *:after{animation:none!important;transition:none!important}}
.hub-dream-summary-title{font-weight:600}.hub-dream-summary-meta{margin-left:8px;font-size:10px;font-weight:400;color:var(--hub-secondary)}@media(max-width:639px){.hub-dream-summary-meta{display:block;margin:5px 0 0;padding-left:15px}}
.hub-dream-card{min-width:0;border:1px solid var(--hub-border);border-radius:12px}.hub-dream-card>summary{cursor:pointer;font-size:11px;font-weight:550;line-height:1.8;overflow-wrap:anywhere}.hub-dream-card[open]>summary{margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--hub-border)}.hub-dream-card>section{min-width:0}.hub-dream-title{min-width:0;flex-wrap:wrap;overflow-wrap:anywhere}.hub-dream-form{margin-top:16px;gap:0 12px}.hub-dream-preset{grid-column:1/-1}.hub-dream-engine-actions{align-self:end}.hub-dream-engine-actions .hub-row{flex-wrap:wrap}.hub-dream-card .hub-dream-controls .hub-checkbox{flex:1 1 160px;white-space:normal;min-width:0;max-width:100%;overflow-wrap:anywhere}.hub-dream-times>span{min-width:0;overflow-wrap:anywhere}#t3-hub-drawer.is-compact .hub-dream-form{grid-template-columns:minmax(0,1fr)}
.hub-theme-switcher{display:flex;align-items:center;gap:5px;flex:none;padding:3px}.hub-theme-dot{width:14px;height:14px;min-width:14px;padding:0;border:1px solid var(--hub-border);border-radius:50%;background:var(--hub-swatch)!important;cursor:pointer}.hub-theme-dot[aria-pressed=true]{outline:2px solid var(--hub-accent);outline-offset:2px}#t3-hub-live-board{display:flex;flex-direction:column;min-height:0}#t3-hub-live-board .hub-board-content{flex:0 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain}.hub-board-toolbar{display:flex;align-items:center;flex-wrap:wrap;flex:none;gap:8px;min-width:0}.hub-board-toolbar .hub-icon-btn{width:22px;height:22px}.hub-board-open-label{display:none}.is-space-limited .hub-board-content{display:none}.is-space-limited .hub-board-toolbar{flex-wrap:nowrap}.is-space-limited :is(.hub-theme-switcher,.hub-board-toggle>span:last-child,.hub-icon-btn svg){display:none}.is-space-limited .hub-board-toggle{width:auto;min-width:0}.is-space-limited .hub-board-toggle>span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.is-space-limited .hub-icon-btn{display:inline-flex;width:auto;height:22px;padding:0 2px;white-space:nowrap}.is-space-limited .hub-board-open-label{display:inline;font-size:9px}#t3-hub-live-board .hub-board-steps{gap:9px}#t3-hub-live-board .hub-step-text{overflow-wrap:anywhere}#t3-hub-live-board .hub-board-add{margin-top:14px;gap:5px}#t3-hub-live-board .hub-board-add .hub-input{padding:6px 8px;font-size:10px!important}#t3-hub-live-board .hub-board-add .hub-btn{padding:4px 7px;min-height:28px}.hub-memory-date{white-space:nowrap;font-variant-numeric:tabular-nums}.hub-detail-meta{flex-wrap:wrap}.hub-dream-times{display:flex;gap:6px 16px;flex-wrap:wrap;font-size:10px;color:var(--hub-secondary);margin-top:10px}
@media(max-width:639px){.hub-title-row{flex-wrap:wrap}.hub-title-row .hub-grow{flex-basis:calc(100% - 48px)}.hub-header{padding:14px 16px}.hub-header .hub-theme-switcher{margin-right:auto}}
.hub-mcp-mode-controls{grid-column:1/-1;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto;gap:8px;align-items:end;margin-top:9px;padding:10px;border:1px solid var(--hub-border);border-radius:9px;background:var(--hub-bg-subtle)}.hub-mcp-mode-controls label{min-width:0;font-size:9px;color:var(--hub-secondary)}.hub-mcp-mode-controls label small{display:block;margin-bottom:4px}.hub-mcp-mode-controls .hub-select{font-size:10px!important;padding:6px 22px 6px 8px}.hub-mcp-mode-hint{grid-column:1/-1;margin:0;font-size:9px;line-height:1.65;color:var(--hub-secondary)}
.hub-resource-grid{align-items:stretch;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr))}.hub-resource-card{display:flex;flex-direction:column;align-items:stretch;gap:10px;padding:14px;margin:0;min-width:0}.hub-resource-card .hub-card-top{align-items:flex-start;min-width:0}.hub-resource-card .hub-grow{min-width:0}.hub-resource-card .hub-card-meta{display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-top:6px;min-width:0}.hub-resource-card .hub-card-description{margin:0;min-height:42px}.hub-resource-card .hub-resource-toggle{width:100%;max-width:none;align-items:flex-start;margin-top:auto;padding-top:10px;border-top:1px solid var(--hub-border)}.hub-resource-card .hub-agent-toggle{width:100%;justify-content:flex-start}.hub-resource-controls-label{font-size:9px;color:var(--hub-secondary);margin-top:2px}.hub-resource-card .hub-mcp-mode-controls{grid-column:auto;width:100%;grid-template-columns:minmax(0,1fr) minmax(0,1fr);margin-top:0;padding:9px}.hub-resource-card .hub-mcp-mode-controls>.hub-btn{grid-column:1/-1;justify-self:start}.hub-unavailable-hint{color:var(--hub-secondary);font-size:9px}.hub-unavailable{border-color:color-mix(in srgb,var(--hud-amber) 45%,var(--hub-border));color:var(--hub-secondary)}.hub-route-status{white-space:normal;text-overflow:clip}
@media(max-width:639px){.hub-mcp-mode-controls{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.hub-mcp-mode-controls>.hub-btn{grid-column:1/-1;justify-self:start}}
#t3-hub-live-board{border-radius:14px;padding:0;box-shadow:0 12px 36px #0f172a24,0 2px 8px #0f172a12;max-width:calc(100vw - 16px)}#t3-hub-live-board .hub-artifacts{display:grid;grid-template-columns:minmax(0,1fr);gap:7px}#t3-hub-live-board .hub-artifact-card{display:flex;align-items:center;gap:10px;min-width:0;width:100%;padding:8px 10px;border:1px solid var(--hub-border);border-radius:9px;background:var(--hub-bg-subtle);color:var(--hub-ink);text-align:left;font-size:11px;cursor:pointer}#t3-hub-live-board .hub-artifact-card:hover{border-color:var(--hub-accent)}#t3-hub-live-board .hub-artifact-icon{display:grid;place-items:center;flex:none;width:28px;height:28px;border-radius:7px;background:var(--hub-bg);color:var(--hub-accent)}#t3-hub-live-board .hub-artifact-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.hub-board-toolbar{gap:4px;flex-wrap:nowrap;padding:10px 10px 8px;border-bottom:1px solid var(--hub-border)}.hub-board-drag{display:flex;align-items:center;gap:7px;min-width:0;flex:1;cursor:grab;user-select:none;touch-action:none;-webkit-app-region:no-drag}.hub-board-drag:active{cursor:grabbing}.hub-board-grip{font-size:15px;letter-spacing:-3px;color:var(--hub-muted);padding-right:4px}.hub-board-drag strong{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px}.hub-board-drag .hub-board-status{font-size:10px;color:var(--hub-secondary);white-space:nowrap}.hub-board-toolbar .hub-icon-btn{width:25px;height:25px;flex:none}.hub-board-content{padding:10px 12px 12px}.hub-board-source{display:flex;justify-content:space-between;gap:6px;font-size:10px;color:var(--hub-secondary);margin-bottom:8px}.hub-board-meter{height:5px;border-radius:10px;background:var(--hub-border);overflow:hidden;margin:0 0 12px}.hub-board-meter>i{display:block;height:100%;border-radius:inherit;background:var(--hub-accent)}.hub-dashboard-links{display:flex;gap:6px;flex-wrap:wrap;border-top:1px solid var(--hub-border);margin-top:12px;padding-top:10px}.hub-dashboard-links button{border:0;border-radius:7px;background:var(--hub-bg-subtle);padding:4px 7px;color:var(--hub-secondary);font-size:10px!important}.hub-dashboard-links button:hover{color:var(--hub-ink)}.hub-progress-ring{flex:none;transform:rotate(-90deg)}.hub-step-icon{width:16px;height:16px;border:1.5px solid var(--hub-muted);border-radius:50%;font-size:10px;line-height:1}.hub-board-step.is-completed .hub-step-icon{background:var(--hub-accent);border-color:var(--hub-accent);color:var(--hub-on-active)}.hub-board-step.is-in-progress .hub-step-icon{border-color:var(--hub-accent)}.hub-commander .hub-segments>button[aria-pressed=true],.hub-commander .hub-segments>button[aria-pressed=true]:hover{background:var(--hub-active);color:var(--hub-on-active)!important;font-weight:600}.hub-subagent-main{grid-template-columns:36px minmax(0,1fr)}#t3-hub-drawer.is-wide .hub-subagent-main{grid-template-columns:36px minmax(0,1fr) minmax(280px,1fr)}.hub-robot{display:grid;place-items:center;width:34px;height:34px;border-radius:11px;background:var(--hub-bg-subtle);flex:none}.hub-robot-face{width:23px;height:23px;border-radius:8px;display:flex;align-items:center;justify-content:center;gap:4px;background:var(--robot-color,#3980f6);box-shadow:inset 0 -2px #00000012}.hub-robot-face i{display:block;width:4px;height:7px;background:#fff;border-radius:4px}.hub-subagent-meta{margin-left:45px}#t3-hub-drawer.is-compact .hub-subagent-meta{margin-left:0}`;
      style.textContent += `#t3-hub-plan-handle{position:relative!important;right:auto!important;top:auto!important;padding:3px 7px!important;border-radius:7px!important;border-right:1px solid var(--hub-border)!important;background:var(--hub-bg)!important}#t3-hub-live-board{display:block;flex:none;min-height:0;padding:0;border-radius:11px;overflow:auto}#t3-hub-live-board[hidden]{display:none!important}.hub-connection-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,360px),1fr));gap:8px;margin:12px 0}.hub-connection-agent{min-width:0;padding:10px 12px;border:1px solid var(--hub-border);border-radius:10px;background:var(--hub-bg)}.hub-connection-agent h3{margin:0 0 8px;font-size:11px}.hub-connection-fields{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}.hub-connection-cell{min-width:0;padding:7px;border-radius:7px;background:var(--hub-bg-subtle)}.hub-connection-cell>span,.hub-connection-cell>strong,.hub-connection-cell>small{display:block;min-width:0;overflow-wrap:anywhere}.hub-connection-cell>span{font-size:9px;color:var(--hub-secondary)}.hub-connection-cell>strong{margin-top:2px;font-size:9px}.hub-connection-cell>small{margin-top:3px;color:var(--hub-secondary);font-size:8px;line-height:1.45}.hub-connection-cell>strong[data-status="configured"]{color:#047857}.hub-connection-cell>strong[data-status="missing"]{color:var(--hub-secondary)}.hub-connection-cell>strong[data-status="unsupported"]{color:var(--hub-muted)}.hub-connection-cell>strong[data-status="unknown"]{color:#b45309}.hub-connection-note{align-items:center;flex-wrap:wrap}.hub-connection-error{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 11px;border:1px solid var(--hub-border);border-radius:8px;color:var(--hub-secondary);font-size:10px}@media(max-width:639px){.hub-connection-grid{grid-template-columns:minmax(0,1fr)}.hub-connection-fields{grid-template-columns:repeat(2,minmax(0,1fr))}}`;
      style.textContent += `#t3-hub-plan-handle{justify-content:flex-start!important;gap:7px!important;width:auto!important;min-width:0!important;height:27px!important;padding:4px 10px!important;border:1px solid #dbe4f0!important;border-radius:999px!important;background:#f8fafc!important;color:#253247!important;box-shadow:0 1px 4px #0f172a12!important;font-size:10px!important;font-weight:550!important;line-height:1!important;white-space:nowrap!important}#t3-hub-plan-handle:hover,#t3-hub-plan-handle:focus-visible{background:#f1f6ff!important;border-color:#c8dcff!important}.hub-plan-indicator{gap:7px!important;white-space:nowrap}.hub-plan-ring{display:block;flex:none;width:15px;height:15px;transform:rotate(-90deg)}.hub-plan-ring-track{fill:none;stroke:#dbeafe;stroke-width:2.4}.hub-plan-ring-progress{fill:none;stroke:#3980f6;stroke-width:2.4;stroke-linecap:round;transition:stroke-dashoffset .18s ease}.hub-plan-label{white-space:nowrap;font-variant-numeric:tabular-nums}.hub-memory-access-switch{display:flex;align-items:center;gap:8px;min-width:0;font-size:11px;font-weight:550;color:var(--hub-ink)}.hub-memory-access-switch input{flex:none;width:15px;height:15px;accent-color:#3980f6}.hub-memory-access-state{font-size:10px;color:var(--hub-secondary);white-space:normal;text-align:right}.hub-memory-access-actions{flex-wrap:wrap;margin-top:10px}.hub-memory-access-summary{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.hub-memory-access-summary>span{padding:2px 7px;border:1px solid var(--hub-border);border-radius:999px;background:var(--hub-bg-subtle);font-size:9px;color:var(--hub-secondary)}.hub-memory-access-providers{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));gap:6px;margin-top:9px}.hub-memory-access-provider{min-width:0;padding:7px 9px;border:1px solid var(--hub-border);border-radius:8px;font-size:9px}.hub-memory-access-provider strong,.hub-memory-access-provider small{display:block;overflow-wrap:anywhere}.hub-memory-access-provider small{margin-top:2px;color:var(--hub-secondary)}.hub-memory-access-prompt{margin-top:10px;font:10px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace!important;min-height:120px;resize:vertical;white-space:pre-wrap}@media(max-width:639px){.hub-memory-access-switch{align-items:flex-start}.hub-memory-access-state{text-align:left}}`;
      style.textContent += `.hub-memory-runtime-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,210px),1fr));gap:7px;margin-top:10px}.hub-memory-runtime-cell{min-width:0;padding:8px 9px;border-radius:8px;background:var(--hub-bg-subtle)}.hub-memory-runtime-cell>span,.hub-memory-runtime-cell>strong,.hub-memory-runtime-cell>small{display:block;min-width:0;overflow-wrap:anywhere}.hub-memory-runtime-cell>span{font-size:9px;color:var(--hub-secondary)}.hub-memory-runtime-cell>strong{margin-top:3px;font-size:10px;font-weight:550}.hub-memory-runtime-cell>small{margin-top:3px;color:var(--hub-secondary);font-size:9px}.hub-memory-mcp{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-top:12px;padding-top:10px;border-top:1px solid var(--hub-border)}.hub-memory-mcp>div{display:flex;flex-direction:column;gap:4px;min-width:0}.hub-memory-mcp strong{font-size:10px}.hub-memory-mcp code{font:9px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--hub-secondary);overflow-wrap:anywhere}.hub-memory-mcp-config{margin-top:10px;min-height:100px;font:10px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace!important;white-space:pre-wrap;resize:vertical}@media(max-width:639px){#t3-hub-title-controls{gap:4px;margin-left:5px}#t3-hub-title-controls>button{height:25px;padding:3px 7px;font-size:9px}.hub-memory-runtime-grid{grid-template-columns:minmax(0,1fr)}}`;
      document.head.appendChild(style);
      root = document.createElement("div");
 root.id = "t3-sidecar-hub-root";
 root.innerHTML = `<div id="t3-hub-title-controls" role="group" aria-label="本机记忆与当前计划" hidden><button type="button" id="t3-hub-plan-handle" aria-controls="t3-hub-live-board" aria-expanded="false" hidden></button><button type="button" id="t3-hub-memory-handle" data-action="open-memory" aria-controls="t3-hub-drawer">${icon("memory", 13)}<span>记忆</span></button><button type="button" id="t3-hub-memory-toggle" role="switch" aria-checked="mixed" aria-label="允许本机 T3 Agent 使用记忆"><span aria-hidden="true">◉</span><span>未知</span></button></div><aside id="t3-hub-drawer" role="complementary" aria-labelledby="t3-hub-title" aria-hidden="true" inert><div id="t3-hub-resize-handle" role="separator" aria-orientation="vertical" tabindex="0" aria-label="调整 Hub 宽度"></div><header class="hub-header"></header><nav class="hub-tabs" role="tablist" aria-label="Hub 设置"></nav><section id="t3-hub-panel" class="hub-content" role="tabpanel" tabindex="0"></section><footer class="hub-footer"></footer><div class="hub-toast" role="status" aria-live="polite" hidden></div></aside><section id="t3-hub-live-board" aria-label="当前会话计划进度" hidden></section>`;
 document.body.appendChild(root);
 drawer = root.querySelector("#t3-hub-drawer");
 handle = null;
 titleControls = root.querySelector("#t3-hub-title-controls");
 memoryHandle = root.querySelector("#t3-hub-memory-handle");
 memoryToggle = root.querySelector("#t3-hub-memory-toggle");
 planHandle = root.querySelector("#t3-hub-plan-handle");
 content = root.querySelector(".hub-content");
 liveBoard = root.querySelector("#t3-hub-live-board");
 state.lang = detectLang(); state.dark = isDark();
 applyTheme(); renderChrome(); applyWidth(); renderLiveBoard(); positionHandle();
 listen(root, "click", onClick); listen(root, "input", onInput); listen(root, "change", onChange);
 listen(planHandle, "pointerdown", handlePlanPointerDown);
 listen(planHandle, "click", handlePlanClick);
 listen(planHandle, "pointerenter", handlePlanPointerEnter);
 listen(planHandle, "pointerleave", handlePlanPointerLeave);
 listen(planHandle, "focus", () => { setPlanPopover(true); pollBoard().then(renderLiveBoard); });
 listen(planHandle, "blur", () => deferPlanPopoverClose());
 listen(liveBoard, "pointerenter", () => { state.planHovering = true; });
 listen(liveBoard, "pointerleave", (event) => { if (event.relatedTarget && (planHandle.contains(event.relatedTarget) || liveBoard.contains(event.relatedTarget))) return; state.planHovering = false; deferPlanPopoverClose(); });
 listen(document, "pointerdown", (event) => { if (!planHandle.contains(event.target) && !liveBoard.contains(event.target) && state.planPinned) setPlanPopover(false); });
 listen(root, "focusout", () => later(flushBoardRender, 0));
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
 listen(memoryHandle, "click", openMemoryFromTitle);
 listen(memoryToggle, "click", toggleMemoryAccessFromTitle);
 listen(window, "keydown", onKeydown);
 listen(window, "resize", positionHandle);
 listen(window, "resize", () => { applyWidth(); positionConversationTools(); });
 listen(window, "t3-hud-popover-change", positionConversationTools);
 listen(window, "hashchange", checkRoute);
 listen(window, "popstate", checkRoute);
 listen(window, "storage", checkRoute);
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
 observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "data-theme", "style", "hidden", "aria-hidden", "aria-modal", "data-closed", "open"] });
 ensureRouterSubscription();
 routeTimer = setInterval(() => { if (!disposed && !document.hidden) { ensureRouterSubscription(); checkRoute(); syncEnvironment(); syncOcclusion(); positionConversationTools(); } }, 3000);
 lastRoute = routeKey(); lastBoardRoute = boardScopeRoute();
 state.threadId = currentThreadId();
 syncOcclusion();
 setOpen(state.open, false);
 refreshMemoryAgentAccess(false);
 refreshContext();
 scheduleBoardPoll();
    }

    function renderChrome() {
 if (!root || disposed) return;
 const navTab = "memory";
 root.dataset.tab = navTab;
 const context = state.context || {};
 const projectName = projectTitle();
 const rawCli = context.activeProvider || context.activeCli || context.cli || context.provider || context.providerInstanceId;
 const cli = typeof rawCli === "object" ? rawCli?.name || rawCli?.id : rawCli;
 const cliNames = { codex: "Codex", antigravity: "AGY", agy: "AGY", muse: "Muse", pi: "Pi", claude: "Claude", claudeAgent: "Claude" };
 const model = typeof context.activeModel === "object" ? context.activeModel?.name || context.activeModel?.id : context.activeModel;
 const cliName = [cliNames[String(cli)] || cli, model].filter(Boolean).join(" · ") || tr("本地工作区就绪", "Workspace ready");
 renderMemoryTitleControls();
 root.querySelector(".hub-header").innerHTML = `<div class="hub-title-row"><span class="hub-brand">${icon("hub", 18)}</span><div class="hub-grow"><div id="t3-hub-title" class="hub-title">Hub Studio <span class="hub-version">v3</span></div><div class="hub-kicker">${esc(tr("一个工作台，连接所有 AI 搭档。", "One workspace for all your agents."))}</div></div>${themeSwitcher()}<div class="hub-widths" aria-label="${esc(tr("工作台宽度", "Studio width"))}">${[[520, "紧凑", "Compact"], [880, "标准", "Standard"], [1140, "超宽", "Wide"]].map(([width, zh, en]) => `<button type="button" data-action="set-width" data-width="${width}" class="${Math.abs(state.width - width) < 8 ? "is-active" : ""}" aria-pressed="${Math.abs(state.width - width) < 8}">${esc(tr(zh, en))}</button>`).join("")}</div><button type="button" class="hub-icon-btn" data-action="refresh" title="${esc(tr("刷新当前页", "Refresh tab"))}" aria-label="${esc(tr("刷新当前页", "Refresh tab"))}">${state.refreshing ? spinner() : icon("refresh", 15)}</button><button type="button" class="hub-icon-btn" data-action="close" aria-label="${esc(tr("关闭", "Close"))}">${icon("close", 16)}</button></div><div class="hub-scope-bar"><select class="hub-select hub-scope-select" name="hub-scope" aria-label="${esc(tr("当前项目", "Current project"))}" disabled><option value="project" selected>${esc(projectName)}</option></select><span class="hub-shortcut">⌘ ⇧ K</span></div><div class="hub-context"><span class="hub-context-status"><i class="hub-dot"></i><span>${esc(state.contextError ? tr("工作区连接暂不可用", "Workspace unavailable") : cliName)}</span></span></div>`;
 const tabs = [["memory", "memory", tr("记忆", "Memory")]];
 root.querySelector(".hub-tabs").innerHTML = tabs.map(([key, glyph, label]) => {
 const count = tabCount(key);
 return `<button type="button" id="t3-hub-tab-${key}" class="hub-tab" role="tab" data-action="tab" data-tab="${key}" aria-controls="t3-hub-panel" aria-selected="${key === navTab}" tabindex="${key === navTab ? 0 : -1}">${icon(glyph, 14)}<span>${esc(label)}</span>${count == null ? "" : `<span class="hub-tab-count">${esc(count)}</span>`}</button>`;
 }).join("");
 content.setAttribute("aria-labelledby", `t3-hub-tab-${navTab}`);
 root.querySelector(".hub-footer").innerHTML = `<span class="hub-footer-status"><i class="hub-dot"></i>${esc(state.connected ? tr("已连接 · 所有更改保存在本机", "Connected · Changes stay local") : tr("等待 Hub 连接", "Waiting for Hub"))}</span><span class="hub-footer-key">Esc ${esc(tr("收起", "Close"))}</span>`;
    }
    function memoryAccessHeaderState() {
 const access = cache.agentAccess || {}, summary = access.setupSummary || {};
 if (errors.agentAccess || access.enabled == null) return { checked: "mixed", label: tr("未知", "Unknown"), detail: tr("无法确认本机记忆接入开关状态", "Local memory access state is unknown") };
 if (access.enabled === false) return { checked: "false", label: tr("关", "Off"), detail: tr("本机 T3 Agent 记忆访问已关闭，记忆内容会保留", "Local T3 Agent memory access is off; stored memories are kept") };
 const pending = memoryAccessIssues(summary) || !Array.isArray(summary.providers) || summary.providers.length === 0;
 return { checked: "true", label: pending ? tr("待处理", "Pending") : tr("开", "On"), detail: pending ? tr("本机访问已开启，仍有配置待处理；当前会话未验证", "Local access is on; setup has pending items and current session is unverified") : tr("本机访问已开启；当前会话是否加载尚未验证", "Local access is on; current session loading is unverified") };
    }
    function renderMemoryTitleControls() {
 if (!memoryToggle) return;
 const status = memoryAccessHeaderState();
 memoryToggle.setAttribute("aria-checked", status.checked);
 memoryToggle.setAttribute("aria-label", `${tr("允许本机 T3 Agent 使用记忆", "Allow local T3 Agents to use memory")} · ${status.label}`);
 memoryToggle.title = status.detail;
 memoryToggle.disabled = state.memoryAgentAccessUpdating;
 memoryToggle.innerHTML = `<span aria-hidden="true">${status.checked === "true" ? "●" : status.checked === "false" ? "○" : "◌"}</span><span>${esc(status.label)}</span>`;
 if (memoryHandle) {
  memoryHandle.title = tr("打开本机记忆工作台", "Open local Memory workspace");
  memoryHandle.setAttribute("aria-label", tr("打开本机记忆工作台", "Open local Memory workspace"));
 }
    }
    function tabCount(key) {
 const counts = state.context?.counts || {};
 if (key === "board") { const b = boardData(); return b.progress.total ? `${b.progress.completed}/${b.progress.total}` : null; }
 if (key === "subagents") return cache.subagents ? subagentItems().length : counts.subagents ?? null;
 if (key === "memory") {
 if (!memoryProjectReady()) return null;
 const projects = items(cache.overview, ["projects", "items"]);
 const project = projects.find((entry) => entry.slug === cache.overview?.currentProjectSlug) || projects.find((entry) => entry.projectRoot === state.projectRoot || entry.root === state.projectRoot || entry.path === state.projectRoot);
 return cache.memory?.total ?? project?.total ?? (cache.memory ? memoryRecords().length : null);
 }
 return null;
    }
    function defaultScope() { return state.scope === "project" && state.projectRoot ? "project" : "global"; }
    function setScope(scope) {
 if (scope !== "project" || projectDisabled()) return;
 state.scope = scope;
 state.importScope = scope;
 state.subagentScope = scope;
 state.agentsTarget = scope;
 state.memoryProject = "current";
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
 return `<div class="hub-segments hub-scope-control" role="group" aria-label="${esc(item.title || item.name || item.id)} ${esc(tr("保存范围（实际配置状态见上方）", "Saved scope (actual status above)"))}">${[["off", tr("关闭", "Off")], ["project", tr("仅本项目", "This project")], ["global", tr("全局", "Global")]].map(([scope, label]) => `<button type="button" data-action="${domain}-scope" data-id="${esc(item.id)}" data-scope="${scope}" class="${(item.scope || "off") === scope ? "is-active" : ""}" aria-pressed="${(item.scope || "off") === scope}" ${disabled || scope === "project" ? "disabled" : ""}>${esc(label)}</button>`).join("")}</div>`;
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
    function agentActivationState(item, host) {
 const field = ["agentStates", "agentStatus", "perAgent", "enabledAgents"].find((key) => Object.prototype.hasOwnProperty.call(item, key));
 if (!field) return null;
 const source = item[field];
 if (Array.isArray(source)) {
 const entry = source.find((value) => host.aliases.includes(typeof value === "string" ? value : value?.id || value?.agent || value?.providerInstanceId));
 if (entry !== undefined) {
 if (typeof entry === "string") return true;
 if (!entry || typeof entry !== "object") return null;
 for (const key of ["enabled", "active", "installed"]) if (Object.prototype.hasOwnProperty.call(entry, key)) return typeof entry[key] === "boolean" ? entry[key] : null;
 return null;
 }
 if (source.length > 0 && source.every((value) => typeof value === "string")) return false;
 return null;
 }
 if (!source || typeof source !== "object") return null;
 for (const alias of host.aliases) if (Object.prototype.hasOwnProperty.call(source, alias)) {
 const value = source[alias];
 if (typeof value === "boolean") return value;
 if (typeof value === "string") return value === "enabled" ? true : value === "disabled" || value === "off" ? false : null;
 if (!value || typeof value !== "object") return null;
 for (const key of ["enabled", "active", "installed"]) if (Object.prototype.hasOwnProperty.call(value, key)) return typeof value[key] === "boolean" ? value[key] : null;
 return null;
 }
 return null;
    }
    function agentEnabled(item, host) {
 return agentActivationState(item, host) === true;
    }
    function resourceFilter(domain) { return state.resourceFilters[domain] ||= { agent: "all", status: "all" }; }
    function resourceMatches(item, domain) {
 const filter = resourceFilter(domain);
 const states = filter.agent === "all" ? agentHosts.map((host) => agentActivationState(item, host)) : [agentActivationState(item, agentHosts.find((host) => host.id === filter.agent) || agentHosts[0])];
 const enabled = states.includes(true) ? true : states.every((value) => value === false) ? false : null;
 return filter.status === "all" || (filter.status === "enabled" ? enabled === true : enabled === false);
    }
    function resourceFilters(domain, queryName, query) {
 const filter = resourceFilter(domain);
 const selected = agentHosts.find((host) => host.id === filter.agent);
 const statusScope = selected ? tr(`${selected.label} 的启用状态`, `${selected.label} status`) : tr("任一 Agent 的启用状态", "Enabled in any agent");
 return `<div class="hub-resource-filters"><div class="hub-hint">${esc(tr("查看谁的启用状态：", "View status for: "))}${esc(selected?.label || tr("所有 Agent", "All agents"))}${esc(tr("。选单个 Agent 后，“已启用/未启用”按它筛选；未启用项仍可直接点行内 Agent 添加。", ". With one agent selected, the enabled filter applies to it. Disabled entries stay visible so you can enable them below."))}</div><div class="hub-agent-filters" role="group" aria-label="${esc(tr("查看谁的启用状态", "View which agent's status"))}"><button type="button" class="hub-pill ${filter.agent === "all" ? "is-active" : ""}" data-action="resource-filter" data-domain="${domain}" data-agent="all" aria-pressed="${filter.agent === "all"}">${esc(tr("所有 Agent", "All agents"))}</button>${agentHosts.map((host) => `<button type="button" class="hub-pill ${filter.agent === host.id ? "is-active" : ""}" data-action="resource-filter" data-domain="${domain}" data-agent="${host.id}" aria-pressed="${filter.agent === host.id}">${agentMark(host.id)}${host.label}</button>`).join("")}</div><div class="hub-filter-bottom"><div class="hub-search">${icon("search", 13)}<input class="hub-input" name="${queryName}" value="${esc(query)}" placeholder="${esc(tr("搜索名称、描述…", "Search name, description…"))}" aria-label="${esc(tr("搜索资源", "Search resources"))}"></div><select class="hub-select" name="resource-status" data-domain="${domain}" aria-label="${esc(statusScope)}">${[["all", "全部状态", "All statuses"], ["enabled", "已启用", "Enabled"], ["disabled", "未启用", "Not enabled"]].map(([value, zh, en]) => `<option value="${value}" ${filter.status === value ? "selected" : ""}>${esc(tr(zh, en))}</option>`).join("")}</select></div></div>`;
    }
    function agentToggleRow(item, domain) {
 const id = String(item.id || item.name), all = agentHosts.every((host) => agentEnabled(item, host));
 const attrs = `data-domain="${domain}" data-id="${esc(id)}" data-name="${esc(item.name || id)}"`;
 const isMcp = domain === "mcp";
 const label = isMcp ? tr("启用到 Agent（该 Agent 的各项目共用）", "Enable for agents (shared across their projects)") : tr("启用到 Agent", "Enable for agents");
 const launchBlocked = isMcp && item.launchable === false;
 const conflict = isMcp && item.modeConflict === true;
 const reason = conflict
 ? tr("名称冲突已暂停；可移除单个原生配置或关闭 Hub，启用需先解决冲突。", "Name conflict paused; you can remove an exact native entry or turn Hub off. Resolve the conflict before enabling.")
 : launchBlocked ? tr("服务缺少可运行入口；可关闭已有配置或 Hub 方式。", "No runnable endpoint; existing config and Hub routes can still be turned off.") : item.unavailable ? tr("当前来源不支持启用", "This source cannot be enabled") : "";
 const blockEnable = conflict || launchBlocked;
 const allTargetEnabled = conflict ? false : !all;
 const allAction = conflict ? tr("从全部 Agent 配置移除此确切名称", "Remove this exact name from all agent configs") : all ? tr("从全部 Agent 配置移除", "Remove from all agent configs") : tr("写入全部 Agent 配置", "Add to all agent configs");
 const allBlocked = !!item.unavailable || (blockEnable && allTargetEnabled);
 return `<div class="hub-resource-toggle" role="group" aria-label="${esc(item.displayName || item.name || id)} · ${esc(label)}"><span class="hub-hint hub-resource-toggle-label">${esc(label)}${reason ? ` · ${esc(reason)}` : ""}</span><button type="button" class="hub-btn hub-small" data-action="resource-toggle-all" ${attrs} data-enabled="${allTargetEnabled}" aria-label="${esc(allAction)}" title="${esc(reason || allAction)}" aria-pressed="${all ? "true" : "mixed"}" ${allBlocked ? "disabled" : ""}>${esc(conflict ? tr("全部 Agent：移除", "Remove from all") : tr("全部 Agent", "All agents"))}</button><div class="hub-agent-toggle">${agentHosts.map((host) => { const activation = agentActivationState(item, host), enabled = activation === true, unknown = activation === null; const targetEnabled = conflict ? false : !enabled; const action = conflict ? tr(`从 ${host.label} 配置中移除此确切名称`, `Remove this exact name from ${host.label} config`) : launchBlocked && targetEnabled ? tr(`${host.label} 尚不能启用；可关闭已存在项`, `${host.label} cannot enable this endpoint; an existing entry can be removed`) : item.unavailable ? tr(`${host.label} 当前不可用`, `${host.label} is unavailable`) : unknown ? tr(`${host.label} 状态未知；点击可写入配置`, `${host.label} status unknown; click to add it to config`) : enabled ? tr(`从 ${host.label} 配置移除`, `Remove from ${host.label}`) : tr(`启用到 ${host.label}`, `Enable for ${host.label}`); const pressed = unknown ? "mixed" : String(enabled); const disabled = !!item.unavailable || (blockEnable && targetEnabled); return `<button type="button" data-action="resource-toggle" ${attrs} data-agent="${host.id}" data-enabled="${targetEnabled}" aria-label="${esc(action)}" aria-pressed="${pressed}" title="${esc(action)}" ${disabled ? "disabled" : ""}>${agentMark(host.id)}<span>${host.label}</span>${unknown ? `<span class="hub-agent-unknown">${esc(tr("未知", "Unknown"))}</span>` : ""}</button>`; }).join("")}</div></div>`;
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
 let refreshed;
 try { refreshed = await request(`${domain}:list`, { projectRoot }); }
 catch (error) {
 if (disposed || version !== contextVersion) return;
 const succeeded = results.filter((result) => result.status === "fulfilled").length;
 toast(tr(`已提交 ${succeeded}/${targets.length} 个 Agent 配置，但暂时无法读取确认状态：${errorText(error)}`, `${succeeded}/${targets.length} agent configs were submitted, but their status could not be confirmed: ${errorText(error)}`), true);
 return;
 }
 if (disposed || version !== contextVersion) return;
 cache[domain] = refreshed;
 if (state.tab === domain || domain === "mcp" && state.tab === "skills" && state.libraryView === "mcp") renderTab();
 const failed = results.filter((result) => result.status === "rejected");
 const confirmedItem = domain === "mcp"
 ? mcpServers().find((item) => item.name === name || item.name === id)
 : items(cache[domain], ["items", "skills"]).find((item) => String(item.id || item.name) === String(id || name));
 if (domain === "mcp" && enabled === false && confirmedItem?.modeConflict) {
 const failed = results.filter((result) => result.status === "rejected");
 const labels = targets.map((host) => agentHosts.find((entry) => entry.id === host)?.label || host).join("、");
 if (!failed.length) toast(tr(`已从 ${labels} 配置移除选中的确切名称；冲突仍存在，汇总状态暂时未知。`, `Removed the selected exact name from ${labels} config. The conflict remains, so aggregate status is still unknown.`));
 else toast(tr(`已提交精确移除 ${results.length - failed.length}/${targets.length} 个 Agent 配置；其余失败：${errorText(failed[0].reason)}`, `Exact-name removal submitted for ${results.length - failed.length}/${targets.length} agents; remaining failure: ${errorText(failed[0].reason)}`), true);
 return;
 }
 const confirmed = targets.filter((host) => !!confirmedItem && agentActivationState(confirmedItem, agentHosts.find((entry) => entry.id === host) || agentHosts[0]) === enabled);
 if (failed.length || confirmed.length !== targets.length) {
 const detail = failed[0]?.reason ? ` · ${errorText(failed[0].reason)}` : "";
 toast(tr(`配置已提交 ${confirmed.length}/${targets.length} 个 Agent，状态尚未全部确认${detail}`, `${confirmed.length}/${targets.length} agent configs submitted; some states could not be confirmed${detail}`), true);
 return;
 }
 const labels = targets.map((host) => agentHosts.find((entry) => entry.id === host)?.label || host).join("、");
 if (domain === "mcp") {
 toast(enabled
 ? tr(`已写入 ${labels} 的 MCP 配置；该 Agent 的各项目共用，新会话通常会读取。`, `Added to ${labels} MCP config; shared across that agent's projects and usually read by new sessions.`)
 : tr(`已从 ${labels} 的 MCP 配置移除。`, `Removed from ${labels} MCP config.`));
 } else toast(tr(`已更新 ${labels} 的技能配置。`, `Skill config updated for ${labels}.`));
 } catch (error) { if (!disposed && version === contextVersion) toast(errorText(error), true); }
 finally { if (row?.isConnected) { delete row.dataset.busy; row.querySelectorAll("button").forEach((button) => { button.disabled = false; }); } }
    }
    const builtinHooks = [
 { id: "rememory-stop", title: " 收尾再记忆守门员", event: "Stop / SubagentStop", description: "任务收尾时整理第一现场经验，保留经过验证的项目记忆。", builtin: true, scope: "off", unavailable: true },
 { id: "secret-guard", title: " 敏感密钥提交守卫", event: "PreToolUse", description: "提交前检查敏感密钥，避免凭据进入版本历史。", builtin: true, scope: "off", unavailable: true },
 { id: "syntax-check", title: " JS/CJS 语法快检", event: "PostToolUse", description: "修改 JavaScript 后执行语法检查，及时发现错误。", builtin: true, scope: "off", unavailable: true },
    ];
    function projectOwnedHook(item) { return item?.scope === "project" || !!item?.projectRoot; }
    function hookItems() {
 const list = items(cache.hooks, ["items", "hooks"]);
 if (cache.hooks?.unavailable) return builtinHooks;
 const templates = { "memory-stop-guard": builtinHooks[0], "secret-commit-guard": builtinHooks[1], "js-syntax-postcheck": builtinHooks[2] };
 return list.filter((item) => !projectOwnedHook(item) || projectContextReady() && (item.projectRoot === state.projectRoot || item.readonly && !item.projectRoot)).map((item) => ({ ...item, title: templates[item.id]?.title || item.title || item.id, description: item.description || templates[item.id]?.description || "", event: item.event || items(item, ["events"]).join(" / ") }));
    }
    function hookConfigurationMarkup(item) {
 if (item.unavailable) return `<span class="hub-badge">${esc(tr("实际配置不可用", "Configuration unavailable"))}</span>`;
 const configured = typeof item.configured === "boolean" ? item.configured : typeof item.enabled === "boolean" ? item.enabled : null;
 const full = Array.isArray(item.configuredIn) ? item.configuredIn : [], partial = Array.isArray(item.partialIn) ? item.partialIn : [];
 const hostNames = (values) => values.map((name) => ({ codex: "Codex", claude: "Claude" })[name] || String(name)).join(" / ");
 const label = item.configurationStatus === "partial" ? partial.length ? tr("配置不完整", "Configuration incomplete") : tr("部分宿主已配置", "Partially configured") : configured === null ? tr("配置状态未知", "Configuration unknown") : configured === false ? tr("未检测到配置", "Not configured") : tr("已检测到配置", "Configured");
 const hosts = partial.length ? [full.length ? `${tr("完整", "Complete")}: ${hostNames(full)}` : "", `${tr("未完整", "Incomplete")}: ${hostNames(partial)}`].filter(Boolean).join(" · ") : hostNames(full);
 return `<span class="hub-badge">${esc(label)}${hosts ? ` · ${esc(hosts)}` : ""}</span>`;
    }
    function renderHooks(target = content) {
 const list = hookItems();
 const draft = state.hookDraft;
 const group = (title, entries) => entries.length ? `<div class="hub-section-heading hub-group-heading"><span>${esc(title)}</span><span class="hub-count">${entries.length}</span></div><div class="hub-hook-group">${entries.map((item) => `<article class="hub-card hub-hook-card"><div class="hub-card-top"><div class="hub-grow"><div class="hub-card-name">${esc(item.title || item.id)}</div><div class="hub-card-meta"><span class="hub-badge hub-purple">${esc(item.event)}</span>${item.readonly ? `<span class="hub-badge">${esc(projectOwnedHook(item) ? tr("项目 · 只读", "Project · read-only") : tr("外部 · 只读", "External · read-only"))}</span>` : ""}${hookConfigurationMarkup(item)}</div></div>${!item.builtin && !item.readonly && !projectOwnedHook(item) ? button("delete-hook", tr("删除", "Delete"), { small: true, danger: true, attrs: `data-id="${esc(item.id)}"` }) : ""}</div><p class="hub-card-description">${esc(item.description || item.matcher || "")}</p>${item.command ? `<code class="hub-hook-command">${esc(redact(item.command))}</code>` : ""}${scopeControl("hook", item, !!(item.readonly || item.unavailable || projectOwnedHook(item)))}<div class="hub-confirm-delete" data-hook-confirm="${esc(item.id)}" hidden>${esc(tr("删除这个自定义 Hook？", "Delete this custom hook?"))}<div class="hub-row">${button("confirm-delete-hook", tr("确认删除", "Delete"), { small: true, danger: true, attrs: `data-id="${esc(item.id)}"` })}${button("cancel-delete-hook", tr("取消", "Cancel"), { small: true })}</div></div></article>`).join("")}</div>` : "";
 const external = new Map();
 list.filter((item) => !item.builtin).forEach((item) => { const key = item.source || tr("自定义", "Custom"); if (!external.has(key)) external.set(key, []); external.get(key).push(item); });
 target.innerHTML = `<div class="hub-section-heading"><span>${esc(tr("让工作流自动收尾", "A little automation, at the right moment"))}</span></div><p class="hub-description">${esc(tr("在关键生命周期运行检查与记忆整理。项目 Hook 只读，保留现有配置；全局 Hook 可在此管理。", "Run checks and memory routines at lifecycle events. Project hooks are read-only; existing settings remain intact. Global hooks can be managed here."))}</p>${button("new-hook", tr("新建自定义 Hook", "New custom hook"), { icon: "plus", primary: true, attrs: `aria-expanded="${!!draft}"` })}${draft ? `<form class="hub-form-panel" data-form="hook"><label class="hub-field">${esc(tr("名称", "Name"))}<input class="hub-input" name="hook-title" value="${esc(draft.title)}" placeholder="My workflow hook"></label><div class="hub-form-grid"><label class="hub-field">${esc(tr("生命周期事件", "Event"))}<select class="hub-select" name="hook-event">${["Stop", "SubagentStop", "PreToolUse", "PostToolUse", "SessionStart", "UserPromptSubmit", "PreCompact", "SessionEnd"].map((event) => `<option ${event === draft.event ? "selected" : ""}>${event}</option>`).join("")}</select></label><label class="hub-field">${esc(tr("范围", "Scope"))}<select class="hub-select" name="hook-scope">${["off", "project", "global"].map((scope) => `<option value="${scope}" ${scope === draft.scope ? "selected" : ""} ${scope === "project" ? "disabled" : ""}>${esc(scope === "off" ? tr("关闭", "Off") : scope === "project" ? tr("本项目", "Project") : tr("全局", "Global"))}</option>`).join("")}</select></label></div><label class="hub-field">Matcher<input class="hub-input" name="hook-matcher" value="${esc(draft.matcher)}" placeholder="Bash|Edit|Write"></label><label class="hub-field">${esc(tr("执行命令", "Command"))}<textarea class="hub-input" name="hook-command" rows="3" spellcheck="false">${esc(draft.command)}</textarea></label><div class="hub-row">${button("save-hook", tr("保存 Hook", "Save hook"), { primary: true, icon: "save" })}${button("cancel-hook", tr("取消", "Cancel"))}</div></form>` : ""}${errors.hooks ? inlineError(errors.hooks) : !cache.hooks ? loading() : `${cache.hooks.unavailable ? `<p class="hub-hint hub-domain-hint">${esc(tr("Hooks 服务尚未接入，以下为内置模板预览。", "Hooks service is not connected. Built-in templates are previewed below."))}</p>` : ""}${group(tr("内置 Hooks", "Built-in hooks"), list.filter((item) => item.builtin))}${[...external].map(([name, entries]) => group(name, entries)).join("")}${!list.length ? empty(tr("还没有 Hook", "No hooks yet")) : ""}`}`;
    }

    function sourceLabel(source, fallback) {
 const key = String(source || "").toLowerCase();
 return ({ "codex-market": tr("Codex 市场", "Codex market"), marketplace: tr("Codex 市场", "Codex market"), github: "GitHub", zcode: "ZCode", claude: "Claude", muse: "Muse", codex: "Codex", pi: "Pi", agy: "AGY", antigravity: "AGY", project: tr("当前项目", "This project"), global: tr("全局", "Global"), archive: tr("归档", "Archived"), archived: tr("归档", "Archived"), magpie: "Magpie", builtin: tr("内置", "Built in"), native: tr("本机 Agent", "Local agent"), both: tr("本机 + Hub", "Local + Hub"), custom: tr("自定义", "Custom"), hub: tr("自定义", "Custom"), cli: "CLI" })[key] || fallback || source || tr("本地", "Local");
    }
    function mcpSourceLabels(server) {
 const sources = new Set(Array.isArray(server.sources) ? server.sources.map((source) => String(source).toLowerCase()) : []);
 const primary = String(server.source || "").toLowerCase();
 if (primary) sources.add(primary);
 const labels = [mcpSourceLabel(server)];
 if (sources.has("magpie") && !labels.includes("Magpie")) labels.push("Magpie");
 const combined = labels.includes(tr("本机 + Hub", "Local + Hub"));
 const localSources = ["agy", "muse", "codex", "pi", "claude", "zcode", "native", "both"];
 if (!combined && localSources.some((source) => sources.has(source)) && !labels.includes(tr("本机 Agent", "Local agent"))) labels.push(tr("本机 Agent", "Local agent"));
 const hubSources = ["hub", "plugin", "both"];
 if (!combined && hubSources.some((source) => sources.has(source)) && !labels.includes("Hub")) labels.push("Hub");
 if ((server.builtin || sources.has("builtin")) && !labels.includes(tr("内置", "Built in"))) labels.push(tr("内置", "Built in"));
 return [...new Set(labels.filter(Boolean))];
    }
    function mcpSourceMatchesFilter(server, filter) {
 if (filter === "all") return true;
 const primary = String(server.source || "").toLowerCase();
 const sources = new Set(Array.isArray(server.sources) ? server.sources.map((source) => String(source).toLowerCase()) : []);
 if (server.builtin) sources.add("builtin");
 if (primary) sources.add(primary);
 if (filter === "magpie") return sources.has("magpie");
 if (filter === "builtin") return sources.has("builtin");
 const localSources = ["plugin", "pi", "muse", "claude", "zcode", "codex", "agy", "hub", "native", "both"];
 return localSources.some((source) => sources.has(source)) || (!sources.has("magpie") && !sources.has("builtin"));
    }
    function mcpSourceLabel(server) { return sourceLabel(server.source, server.sourceLabel); }
    function agentStatusLabel(item, domain = "mcp") {
 const states = agentHosts.map(host => agentActivationState(item, host));
 const prefix = domain === "skills" ? tr("技能", "Skill") : tr("Agent 原生", "Agent config");
 if (states.every(value => value === false)) return `${prefix}: ${tr("未启用", "off")}`;
 if (states.every(value => value === true)) return `${prefix}: ${tr("全部启用", "enabled in all agents")}`;
 if (states.some(value => value === true)) return `${prefix}: ${tr("部分启用", "enabled in some agents")}`;
 return `${prefix}: ${tr("状态未知", "status unknown")}`;
    }
    function hubModeLabel(server) {
 if (server.modeConflict) return tr("Hub 自动路由：冲突暂停", "Hub route: paused by conflict");
 const mode = server.mode === "project-lazy" || server.mode === "global-lazy" ? tr("用到时连接", "Connect on demand") : server.mode === "project-direct" || server.mode === "global-direct" ? tr("列出全部工具", "List all tools") : tr("不经 Hub", "Bypass Hub");
 return `${tr("Hub", "Hub")}: ${mode} · ${server.modeScope === "project" ? tr("项目覆盖", "Project override") : tr("全局默认", "Global default")}`;
    }
    function launchReasonLabel(reason) {
 return ({ "missing-endpoint": tr("没有命令或 URL", "No command or URL"), "invalid-url": tr("URL 无效", "Invalid URL"), "invalid-cwd": tr("工作目录不存在或不是文件夹", "Working directory is missing or not a folder"), "command-unavailable": tr("找不到可执行命令", "Executable command not found") })[reason] || tr("启动入口不可用", "Launch entry unavailable");
    }
    function renderTab() {
 if (!content || disposed) return;
 state.tab = "memory";
 renderMemory();
    }
    function pluginItems() {
 return items(cache.plugins, ["installed", "items", "plugins"]).filter((item) => item.installed !== false && item.catalogSection !== "marketplace");
    }
    function renderPlugins() {
 const list = pluginItems();
 content.innerHTML = `<div class="hub-section-heading"><span>${esc(tr("已安装插件", "Installed plugins"))}</span><span class="hub-count">${cache.plugins ? list.length : ""}</span></div><p class="hub-description">${esc(tr("查看本机发现的插件及其包含的能力；插件由各自宿主管理。", "Installed plugins and their capabilities as discovered on this device. Plugins are managed by their hosts."))}</p>${errors.plugins ? inlineError(errors.plugins) : !cache.plugins ? loading() : !list.length ? empty(tr("没有发现已安装插件", "No installed plugins found")) : `<div class="hub-market-grid hub-resource-grid">${list.map((item) => { const parts = item.capabilities || {}; const caps = [["skillsCount", "Skills"], ["mcpCount", "MCP"], ["hooksCount", "Hooks"], ["commandsCount", tr("命令", "Commands")]].filter(([key]) => Number(parts[key]) > 0).map(([key, label]) => `<span class="hub-badge">${esc(parts[key])} ${esc(label)}</span>`).join(""); return `<article class="hub-card hub-resource-card"><div class="hub-card-top">${brandIcon(item, "plugin")}<div class="hub-grow"><div class="hub-card-name">${esc(item.displayName || item.title || item.name || item.id)}</div><div class="hub-card-meta">${item.version ? `<span class="hub-badge">v${esc(String(item.version).replace(/^v/, ""))}</span>` : ""}<span class="hub-badge">${esc(item.marketplace || tr("本机", "Local"))}</span>${caps}</div></div></div><p class="hub-card-description">${esc(item.shortDescription || item.description || tr("暂无描述", "No description available"))}</p></article>`; }).join("")}</div>`}`;
    }
    function librarySegments() { return `<div class="hub-segments">${[["skills", "Skills 技能"], ["mcp", "MCP 服务"]].map(([key, label]) => `<button type="button" class="hub-pill ${state.libraryView === key ? "is-active" : ""}" data-action="library-view" data-view="${key}" aria-pressed="${state.libraryView === key}">${esc(label)}</button>`).join("")}</div>`; }
    function renderSkills() {
 content.innerHTML = `${librarySegments()}<div class="hub-section-heading"><span>${esc(tr("Skills 技能", "Skills"))}</span><span class="hub-count" id="t3-hub-skills-count"></span></div><p class="hub-description">${esc(tr("用卡片查看来源，并在卡片底部把技能写入对应 Agent 的配置。当前会话何时刷新由 Agent 决定。", "Review each skill's source, then use the card footer to add it to an agent's config. The agent decides when an active session refreshes."))}</p>${resourceFilters("skills", "skillQuery", state.skillQuery)}<details class="hub-import"><summary class="hub-import-title">${icon("github", 14)}${esc(tr("从 GitHub 导入技能", "Import skills from GitHub"))}</summary><form data-form="import"><div class="hub-import-grid"><input class="hub-input" name="repoInput" aria-label="GitHub repository" placeholder="owner/repo" value="${esc(state.importRepo)}" autocomplete="off" spellcheck="false"><select class="hub-select" name="importScope" aria-label="${esc(tr("导入范围", "Import scope"))}"><option value="project" ${state.importScope === "project" ? "selected" : ""} ${projectDisabled() ? "disabled" : ""}>${esc(tr("仅本项目", "Project"))}</option><option value="global" ${state.importScope === "global" ? "selected" : ""}>${esc(tr("全局", "Global"))}</option></select>${button("import-skill", tr("导入", "Import"), { icon: "plus", primary: true })}</div></form></details><div class="hub-filters" id="t3-hub-skill-filters"></div><div id="t3-hub-skill-list"></div>`;
 renderSkillList();
    }
    function skillSourceFilterKey(item) {
 if (item.scope === "project" || item.source === "project") return "project";
 if (item.source === "codex-market") return "codex-market";
 if (item.source === "github") return "github";
 return "local";
    }
    function renderSkillList() {
 if (state.tab !== "skills" || disposed) return;
 const filters = [["all", tr("全部来源", "All sources")], ["project", tr("当前项目", "Project")], ["local", tr("本机 Agent", "Local agents")], ["codex-market", tr("插件技能", "Plugin skills")], ["github", "GitHub"]];
 root.querySelector("#t3-hub-skill-filters").innerHTML = filters.map(([key, label]) => `<button type="button" class="hub-pill ${state.skillFilter === key ? "is-active" : ""}" data-action="skill-filter" data-filter="${key}" aria-pressed="${state.skillFilter === key}">${esc(label)}</button>`).join("");
 const all = items(cache.skills, ["items", "skills", "plugins"]), query = state.skillQuery.trim().toLowerCase();
 const filtered = all.filter((item) => {
 const filter = state.skillFilter;
 const matches = filter === "all" || filter === "enabled" && agentHosts.some((host) => agentEnabled(item, host)) || filter === skillSourceFilterKey(item);
 return matches && resourceMatches(item, "skills") && (!query || `${item.name} ${item.displayName} ${item.description} ${item.id}`.toLowerCase().includes(query));
 });
 root.querySelector("#t3-hub-skills-count").textContent = `${all.length} ${tr("项", "skills")}`;
 root.querySelector("#t3-hub-skill-list").innerHTML = errors.skills ? inlineError(errors.skills) : !cache.skills ? loading() : !filtered.length ? empty(tr("没有匹配的技能", "No matching skills"), tr("更换筛选条件，或导入一个技能。", "Change filters or import a skill."), "skill") : `<div class="hub-market-grid hub-resource-grid">${filtered.map((item) => `<article class="hub-card hub-market-card hub-resource-card" data-skill-id="${esc(item.id)}"><div class="hub-card-top">${brandIcon(item)}<div class="hub-grow"><div class="hub-card-name">${esc(item.displayName || item.name || item.id)}</div><div class="hub-card-meta"><span class="hub-badge">${esc(sourceLabel(item.source, item.sourceLabel))}</span><span class="hub-badge">${esc(agentStatusLabel(item, "skills"))}</span></div></div></div><p class="hub-card-description">${esc(item.shortDescription || item.description || tr("暂无描述", "No description available"))}</p>${item.updatable ? `<div class="hub-editor-actions">${button("update-skill", tr("更新", "Update"), { small: true, icon: "refresh", attrs: `data-id="${esc(item.id)}"` })}${button("remove-skill", tr("移除技能包", "Remove package"), { small: true, attrs: `data-id="${esc(item.id)}"` })}</div><div data-skill-confirm class="hub-confirm-delete" hidden>${esc(tr("移除整个来源技能包及其启用链接？", "Remove this package and its activation links?"))}<div class="hub-row">${button("confirm-remove-skill", tr("确认移除", "Remove"), { small: true, attrs: `data-id="${esc(item.id)}"` })}${button("cancel-remove-skill", tr("取消", "Cancel"), { small: true })}</div></div>` : ""}${agentToggleRow(item, "skills")}</article>`).join("")}</div>`;
    }

    const providerDefaults = [
 { id: "muse", label: "Muse" }, { id: "codex", label: "Codex" }, { id: "pi", label: "Pi·Magpie" },
 { id: "antigravity", label: "Antigravity" }, { id: "claudeAgent", label: "Claude" },
    ];
    const effortNames = { max: "最高", xhigh: "超高", high: "高", medium: "中", low: "低", minimal: "极简" };
    const subagentRoles = { research: ["search", "var(--hud-emerald)", "只读调查"], implementation: ["bolt", "var(--hud-blue)", "全部工具"], general: ["hub", "var(--hud-blue)", "全部工具"], design: ["spark", "var(--hud-violet)", "界面+截图"], test: ["check", "var(--hud-amber)", "LCU+测试"], review: ["edit", "var(--hud-fg)", "只读审查"] };
    const builtinSubagents = new Set(["explorer", "worker", "worker-pro", "frontend", "qa", "code-review", "general-purpose"]);
    function subagentId(item) { return String(item?.id || item?.name || ""); }
    function subagentKey(id, scope = state.subagentScope, projectRoot = state.projectRoot) { return `${scope}:${scope === "project" ? projectRoot || "" : ""}\u0000${id}`; }
    function tierLevel(id) {
 for (const group of items(cache.subagents, ["tierGroups"])) for (const level of items(group, ["levels"])) if (level.id === id) return { ...level, group: group.id };
 return null;
    }
    function subagentItems(scope = state.subagentScope) {
 const list = [...items(cache.subagents, [scope === "global" ? "globalItems" : "projectItems"])];
 for (const group of items(cache.subagents, ["tierGroups"])) for (const level of items(group, ["levels"])) {
 if (level.kind !== "agent") continue;
 const item = scope === "project" && level.source === "project" ? level.item : level.globalItem;
 if (!item) continue;
 const index = list.findIndex((entry) => subagentId(entry) === subagentId(item));
 if (index < 0) list.push(item); else list[index] = item;
 }
 return list;
    }
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
 const level = tierLevel(subagentId(item));
 if (level && (state.subagentScope === "project" ? level.source !== "project" : !!level.globalItem?.suggestedDefault)) return false;
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
    function renderBotAvatar(item) {
 const color = { research: "#4eb7a5", implementation: "#3f83f8", general: "#4b8df8", design: "#a775e9", test: "#f09b55", review: "#e17685" }[item.role] || "#7188ad";
 return `<span class="hub-robot" aria-hidden="true"><span class="hub-robot-face" style="--robot-color:${color}"><i></i><i></i></span></span>`;
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
 if (scope === "project" && !projectContextReady()) {
 content.innerHTML = `${renderCommander()}<p class="hub-hint">${esc(tr("正在确认当前项目，项目路由暂不可编辑。", "Confirming the current project; project routes cannot be edited yet."))}</p>${button("subagent-scope", tr("查看全局角色", "View global roles"), { attrs: 'data-scope="global"' })}`;
 return;
 }
 const list = subagentItems();
 const newDraft = state.subagentDrafts[subagentKey("__new__")];
 const label = scope === "global" ? tr("内置子智能体", "Built-in sub-agents") : tr("本项目专属子智能体", "Project agents");
 const count = cache.subagents ? `${list.length} ${tr("项", "items")}` : "";
 const cards = list.map((item) => {
 const id = subagentId(item), key = subagentKey(id), expanded = !!state.subagentExpanded[key];
 const role = subagentRoles[item.role] || subagentRoles.general;
 const saved = item.injected === true || item.agentsMdInjected === true || item.injectedAt;
 const tier = tierLevel(id);
 const inherited = scope === "project" && tier && tier.source !== "project";
 const status = inherited ? tr("继承全局 · 保存后仅覆盖本项目", "Inherited · save to override this project") : scope === "project" ? tr("仅本项目", "This project") : item.suggestedDefault ? tr("默认建议 · 尚未保存", "Suggested default · not saved") : saved ? tr("已注入 AGENTS.md", "Injected into AGENTS.md") : tr("全局模板", "Global template");
 const busy = subagentSaves.has(key);
 const custom = state.subagentCustom[key];
 const draft = expanded ? subagentDraft(id) : null;
 return `<article class="hub-subagent-card" data-subagent-card="${esc(id)}"><div class="hub-subagent-main">${renderBotAvatar(item)}<button type="button" class="hub-subagent-summary" data-action="expand-subagent" data-id="${esc(id)}" aria-expanded="${expanded}" aria-controls="t3-subagent-editor-${esc(id)}"><span class="hub-subagent-name">${tier ? `<span class="hub-tool-badge">${esc(tier.group === "work" ? "Work" : "Review")} · L${esc(tier.level)}</span>` : ""}${esc(item.name || id)}<span class="hub-tool-badge">${esc(item.toolBadge || role[2])}</span></span><span class="hub-subagent-desc">${esc(item.description || tr("为这位子智能体添加职责与交付说明。", "Add responsibilities and delivery guidelines."))}</span></button>${subagentControls(item, id, busy)}</div><div class="hub-subagent-meta"><span class="hub-badge ${scope === "project" ? "hub-cyan" : saved ? "hub-green" : ""}">${busy ? spinner() : icon(saved ? "check" : scope === "project" ? "folder" : "globe", 10)}${esc(busy ? tr("保存并注入中…", "Saving & injecting…") : status)}${item.enabled === false ? ` · ${esc(tr("已停用", "Disabled"))}` : ""}</span>${memoryPolicyControl(item, id, busy)}<button type="button" class="hub-subagent-edit" data-action="expand-subagent" data-id="${esc(id)}" aria-expanded="${expanded}">${icon("edit", 11)}${esc(expanded ? tr("收起设置", "Close settings") : tr("编辑提示词 / 设置", "Prompt / settings"))}</button></div>${custom ? `<div class="hub-subagent-custom"><label class="hub-field"><span>${esc(tr("自定义模型 ID", "Custom model ID"))}</span><div class="hub-row"><input class="hub-input" name="subagent-customModel" data-subagent-id="${esc(id)}" value="${esc(custom.value || "")}" placeholder="group/1m-auto" autocomplete="off" spellcheck="false">${button("save-subagent-model", tr("保存", "Save"), { small: true, primary: true, attrs: `data-id="${esc(id)}"` })}${button("cancel-subagent-model", tr("取消", "Cancel"), { small: true, attrs: `data-id="${esc(id)}"` })}</div></label></div>` : ""}<div id="t3-subagent-editor-${esc(id)}" class="hub-subagent-expand ${expanded ? "is-expanded" : ""}" ${expanded ? "" : "inert"}><div>${draft ? renderSubagentEditor(draft, id) : ""}</div></div></article>`;
 }).join("");
 const tierOverview = items(cache.subagents, ["tierGroups"]).length ? `<div class="hub-card"><strong>${esc(tr("Work / Review 三级", "Work / Review levels"))}</strong><p class="hub-hint">${esc(tr("Work：L1 常规实现 → L2 攻坚 → L3 主会话兜底；Review：L1 快审 → L2 深审 → L3 高风险终审。带等级的卡片可设置模型和提示词；主会话兜底不另建代理。升级是分工提示，实际调用由宿主决定。", "Work: L1 implementation → L2 advanced → L3 main-agent fallback. Review: L1 quick → L2 deep → L3 high-risk. Cards control each agent's model and prompt; escalation is guidance, not an automatic guarantee."))}</p></div>` : "";
 content.innerHTML = `${renderCommander()}${tierOverview}${cache.subagents?.legacyProjectConfig ? `<p class="hub-error" role="alert">${esc(tr("发现旧项目路由，无法确认归属，暂未应用；请核对后重新配置。", "An older project route has unknown ownership and was not applied."))}</p>` : ""}<div class="hub-subagent-scopes" aria-label="${esc(tr("子智能体作用域", "Agent scope"))}"><button type="button" class="hub-subagent-scope" data-action="subagent-scope" data-scope="global" aria-pressed="${scope === "global"}"> ${esc(tr("全局子智能体", "Global agents"))}<small>${esc(tr("全项目通用", "Across all projects"))}</small></button><button type="button" class="hub-subagent-scope" data-action="subagent-scope" data-scope="project" aria-pressed="${scope === "project"}" ${projectDisabled() ? "disabled" : ""} title="${esc(projectTitle())}"> ${esc(tr("项目子智能体", "Project agents"))}<small>${esc(tr("仅当前项目", "This project only"))}</small></button></div><div class="hub-subagent-heading"><h3>${esc(label)}<span>${esc(count)}</span></h3>${button("new-subagent", tr("新建子智能体", "New agent"), { small: true, primary: true, icon: "plus", disabled: scope === "project" && projectDisabled() })}</div><p class="hub-description">${esc(scope === "global" ? tr("为常用任务配好搭档。切换 Agent、模型或思考程度，即时保存。", "Choose your team. Agent, model, and effort changes save instantly.") : tr("为当前项目定制模型与提示词，同名配置优先于全局模板。", "Customize models and prompts here. Matching IDs override global templates."))}</p>${newDraft ? `<article class="hub-card">${subagentControls(newDraft, "__new__")}${state.subagentCustom[subagentKey("__new__")] ? `<div class="hub-subagent-custom"><label class="hub-field"><span>${esc(tr("自定义模型 ID", "Custom model ID"))}</span><div class="hub-row"><input class="hub-input" name="subagent-customModel" data-subagent-id="__new__" value="${esc(state.subagentCustom[subagentKey("__new__")].value || "")}" placeholder="group/1m-auto" spellcheck="false">${button("save-subagent-model", tr("使用模型", "Use model"), { small: true, primary: true, attrs: 'data-id="__new__"' })}${button("cancel-subagent-model", tr("取消", "Cancel"), { small: true, attrs: 'data-id="__new__"' })}</div></label></div>` : ""}${renderSubagentEditor(newDraft, "__new__", true)}</article>` : ""}${errors.subagents ? inlineError(errors.subagents) : !cache.subagents ? loading() : scope === "project" && projectDisabled() ? empty(tr("请先打开一个项目", "Open a project first"), "", "folder") : cards ? `<div class="hub-subagent-list">${cards}</div>` : `${empty(scope === "project" ? tr("这个项目，还没有专属搭档", "No project agents yet") : tr("还没有全局子智能体", "No global agents yet"), scope === "project" ? tr("当前仍使用全局子智能体。克隆一个模板，即可单独定制。", "Global agents remain available. Clone a template to customize it here.") : tr("新建子智能体，为常用任务配置专属助手。", "Create an agent for your recurring tasks."), "hub")}${scope === "project" ? `<div class="hub-subagent-clones"><strong>${esc(tr("从全局模板克隆定制…", "Customize a global template…"))}</strong><div class="hub-row">${subagentItems("global").filter((item) => ["worker", "explorer", "frontend"].includes(subagentId(item))).map((item) => button("clone-subagent", item.name || subagentId(item), { small: true, icon: "plus", attrs: `data-id="${esc(subagentId(item))}"` })).join("") || `<span class="hub-description">${esc(tr("先创建一个全局模板，或直接新建项目子智能体。", "Create a global template or a new project agent."))}</span>`}</div></div>` : ""}` }<div class="hub-subagent-note">${icon("check", 13)}<span>${esc(scope === "global" ? tr("保存后写入宿主规则文件；实际采用情况取决于宿主加载规则。", "Saving writes host rules; hosts decide when to load them.") : tr("保存后写入本项目 AGENTS.md，其他项目保持各自配置。", "Saving injects this project's AGENTS.md. Other projects keep their own settings."))}</span></div>`;
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
 const scope = state.subagentScope, projectRoot = state.projectRoot, key = subagentKey(id), version = contextVersion;
 if (!projectWriteReady(scope)) return;
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
 if (scope === "project" && (!projectContextReady() || version !== contextVersion || projectRoot !== state.projectRoot)) return;
 const result = await request("subagents:update", { scope, projectRoot, item });
 if (disposed || (scope === "project" && (version !== contextVersion || !projectContextReady() || projectRoot !== state.projectRoot))) return;
 cache.agents = null;
 const saved = { ...item, ...(result.item || {}), injected: true };
 if (projectRoot === state.projectRoot) {
 const listKey = scope === "global" ? "globalItems" : "projectItems";
 if (cache.subagents) {
 const list = items(cache.subagents, [listKey]), index = list.findIndex((entry) => subagentId(entry) === saved.id);
 cache.subagents[listKey] = index < 0 ? [...list, saved] : list.map((entry, i) => i === index ? saved : entry);
 for (const group of items(cache.subagents, ["tierGroups"])) for (const level of items(group, ["levels"])) if (level.id === saved.id) {
 delete saved.suggestedDefault;
 if (scope === "project") { level.projectItem = saved; level.item = saved; level.source = "project"; }
 else { level.globalItem = saved; if (level.source !== "project") { level.item = saved; level.source = "global"; } }
 level.configured = true;
 }
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
 finally { subagentSaves.delete(key); if (!disposed && state.tab === "subagents" && (scope !== "project" || version === contextVersion) && projectRoot === state.projectRoot && scope === state.subagentScope) { renderSubagents(); renderChrome(); } }
    }
    async function cloneSubagent(id, element) {
 const item = subagentItems("global").find((entry) => subagentId(entry) === id);
 const projectRoot = state.projectRoot, version = contextVersion;
 if (!item) return;
 if (!projectWriteReady()) return;
 const existing = items(cache.subagents, ["projectItems"]).find((entry) => subagentId(entry) === id);
 if (existing) { state.subagentScope = "project"; state.subagentExpanded[subagentKey(id)] = true; renderSubagents(); renderChrome(); toast(tr("已打开现有项目配置", "Opened the existing project override")); return; }
 await busy(`clone:${projectRoot}:${id}`, element, async () => {
 if (!projectContextReady() || version !== contextVersion || projectRoot !== state.projectRoot) return;
 const result = await request("subagents:update", { scope: "project", projectRoot, item: { ...item, memoryPolicy: memoryPolicy(item), id, scope: "project", projectRoot, builtin: false, builtIn: false, isBuiltin: false, overridesGlobal: true } });
 if (disposed || version !== contextVersion || !projectContextReady() || projectRoot !== state.projectRoot) return;
 cache.agents = null;
 if (cache.subagents) {
 const saved = { ...item, ...(result.item || {}), id, scope: "project", projectRoot, builtin: false, overridesGlobal: true, injected: true };
 cache.subagents.projectItems = [...items(cache.subagents, ["projectItems"]), saved];
 for (const group of items(cache.subagents, ["tierGroups"])) for (const level of items(group, ["levels"])) if (level.id === id) { level.projectItem = saved; level.item = saved; level.source = "project"; level.configured = true; }
 }
 state.subagentScope = "project";
 state.subagentExpanded[subagentKey(id)] = true;
 renderSubagents(); renderChrome();
 toast(tr("已克隆并自动注入项目 AGENTS.md，可直接定制", "Cloned and injected into project AGENTS.md"));
 });
    }
    async function deleteSubagent(id, element) {
 const scope = state.subagentScope, projectRoot = state.projectRoot, key = subagentKey(id), version = contextVersion;
 if (!projectWriteReady(scope)) return;
 const item = subagentItems().find((entry) => subagentId(entry) === id);
 if (!item || !canDeleteSubagent(item) || subagentSaves.has(key)) return;
 await busy(`delete-subagent:${key}`, element, async () => {
 if (scope === "project" && (!projectContextReady() || version !== contextVersion || projectRoot !== state.projectRoot)) return;
 await request("subagents:delete", { scope, projectRoot, id });
 if (disposed || (scope === "project" && (version !== contextVersion || !projectContextReady())) || projectRoot !== state.projectRoot) return;
 cache.agents = null;
 if (cache.subagents) {
 const listKey = scope === "global" ? "globalItems" : "projectItems";
 cache.subagents[listKey] = items(cache.subagents, [listKey]).filter((entry) => subagentId(entry) !== id);
 for (const group of items(cache.subagents, ["tierGroups"])) for (const level of items(group, ["levels"])) if (level.id === id) {
 if (scope === "project") { level.projectItem = null; level.source = level.globalItem ? "global" : "default"; }
 else { level.globalItem = null; level.source = level.projectItem ? "project" : "default"; }
 level.configured = !!(level.projectItem || level.globalItem);
 }
 }
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
    function renderMcpSourceFilters() {
 const filters = [["all", tr("全部来源", "All sources")], ["magpie", "Magpie"], ["local", tr("本机 Agent", "Local agents")], ["builtin", tr("内置", "Built in")]];
 const node = root.querySelector("#t3-hub-mcp-source-filters");
 if (node) node.innerHTML = `<div class="hub-hint">${esc(tr("目录来源：Magpie 本机服务、本机 Agent 配置和 Hub 内置项。", "Catalog sources: local Magpie services, native agent configs, and built-ins."))}</div><div class="hub-filters">${filters.map(([key, label]) => `<button type="button" class="hub-pill ${state.mcpFilter === key ? "is-active" : ""}" data-action="mcp-filter" data-filter="${key}" aria-pressed="${state.mcpFilter === key}">${esc(label)}</button>`).join("")}</div>`;
    }
    function renderMcp() {
 content.innerHTML = `${librarySegments()}<div class="hub-section-heading"><span>${esc(tr("MCP 服务目录", "MCP service catalog"))}</span><div class="hub-row">${button("probe-mcp", tr("检测连通性", "Probe connections"), { small: true, icon: "refresh" })}${button("sync-mcp", tr("同步 Hub 入口", "Sync Hub entry"), { small: true })}</div></div><p class="hub-description">${esc(tr("“启用到 Agent”会把上游服务写进该 Agent 的原生配置；“通过 Hub 使用”单独控制 Hub 路由。同一服务两边同时启用时可能出现重复工具。首次使用 Hub 路由时先同步 Hub 入口；新会话通常读取配置，当前会话是否刷新由 Agent 决定。", "“Enable for Agent” writes to that agent's native config; “Use through Hub” controls Hub routing separately. Enabling the same server both ways may duplicate tools. Sync the Hub entry before first use. New sessions usually read saved config; active-session refresh depends on the agent."))}</p><div id="t3-hub-mcp-source-filters"></div>${resourceFilters("mcp", "mcpQuery", state.mcpQuery)}<div class="hub-editor-actions">${button("toggle-mcp-add", tr("添加 MCP", "Add MCP"), { small: true, icon: "plus", attrs: `aria-expanded="${state.mcpAddOpen}"` })}</div><div class="hub-form-panel" id="t3-hub-mcp-form" ${state.mcpAddOpen ? "" : "hidden"}></div><div id="t3-hub-mcp-list"></div>`;
 renderMcpSourceFilters();
 renderMcpForm(); renderMcpList();
    }
    function renderMcpForm() {
 const node = root.querySelector("#t3-hub-mcp-form");
 if (!node) return;
 const form = state.mcpForm;
 node.hidden = !state.mcpAddOpen;
 node.innerHTML = `<div class="hub-segments" role="group" aria-label="${esc(tr("新增方式", "Configuration method"))}">${[["form", tr("命令 / URL", "Command / URL")], ["json", tr("粘贴 JSON", "Paste JSON")]].map(([kind, label]) => `<button type="button" data-action="mcp-form-kind" data-kind="${kind}" class="${form.kind === kind ? "is-active" : ""}" aria-pressed="${form.kind === kind}">${esc(label)}</button>`).join("")}</div>${form.kind === "json" ? `<label class="hub-field">mcpServers JSON<textarea class="hub-editor" name="mcp-json" spellcheck="false" placeholder='{"mcpServers":{"my-server":{"command":"npx","args":["-y","package"]}}}'>${esc(form.json)}</textarea></label>` : `<div class="hub-form-grid"><label class="hub-field">${esc(tr("服务名称", "Server name"))}<input class="hub-input" name="mcp-name" value="${esc(form.name)}" placeholder="my-server" autocomplete="off"></label><label class="hub-field">${esc(tr("传输", "Transport"))}<select class="hub-select" name="mcp-transport"><option value="stdio" ${form.transport === "stdio" ? "selected" : ""}>stdio</option><option value="http" ${form.transport === "http" ? "selected" : ""}>http</option></select></label></div>${form.transport === "http" ? `<label class="hub-field">URL<input class="hub-input" name="mcp-url" value="${esc(form.url)}" placeholder="https://example.com/mcp" spellcheck="false"></label>` : `<label class="hub-field">${esc(tr("启动命令", "Command"))}<input class="hub-input" name="mcp-command" value="${esc(form.command)}" placeholder="npx" spellcheck="false"></label><label class="hub-field">${esc(tr("参数（JSON 数组或每行一个）", "Arguments (JSON array or one per line)"))}<textarea class="hub-input" name="mcp-args" rows="2" placeholder='["-y", "@example/mcp"]' spellcheck="false">${esc(form.args)}</textarea></label>`}`}${button("save-mcp", tr("添加服务", "Add server"), { primary: true, icon: "plus" })}`;
    }
    function mcpModeChoice(server, scope) {
 if (server.modeConflict) return "off";
 const stored = scope === "project" ? server.modeProject : server.modeGlobal;
 if (scope === "project" && stored == null) return "inherit";
 if (stored === `${scope}-lazy`) return "lazy";
 if (stored === `${scope}-direct`) return "direct";
 return "off";
    }
    function mcpModeText(mode) {
 return mode === "global-lazy" || mode === "project-lazy" ? tr("用到时再连接", "Connect on demand")
 : mode === "global-direct" || mode === "project-direct" ? tr("列出全部工具", "List all tools") : tr("不经 Hub", "Bypass Hub");
    }
    function mcpModeScopeHint(server, scope, reason = "") {
 const hasProjectOverride = typeof server.modeProject === "string";
 const scopeHint = scope === "project"
 ? hasProjectOverride
 ? tr("项目单独设置优先于全局默认。当前项目已单独设置；选择“跟随全局”可清除本项目设置。", "Project settings override the global default. This project has an override; choose “Follow global” to clear it.")
 : tr(`项目单独设置优先于全局默认。当前项目未单独设置，正跟随全局默认“${mcpModeText(server.modeGlobal || "off")}”。`, `Project settings override the global default. This project has no override and follows “${mcpModeText(server.modeGlobal || "off") }”.`)
 : hasProjectOverride
 ? tr("正在编辑全局默认；项目单独设置优先于全局默认，当前项目的单独设置仍优先。", "Editing the global default; project overrides take precedence, including this project's setting.")
 : tr("正在编辑所有项目默认；项目单独设置优先于全局默认。", "Editing the default for all projects; individual project overrides take precedence.");
 return [reason, tr("这只控制 Hub 转发；不经 Hub 不会关闭 Agent 原生配置。", "This controls Hub forwarding only; bypassing Hub does not disable native agent config."), scopeHint, tr("当前 Agent 工具列表是否刷新由 Agent 决定。", "Whether the current agent refreshes its tool list depends on that agent.")].filter(Boolean).join(" ");
    }
    function renderMcpModeControls(server) {
 const scope = server.modeScope === "project" ? "project" : "global";
 const mode = mcpModeChoice(server, scope);
 const cannotEnable = server.modeConflict === true || server.launchable === false;
 const cannotInherit = server.modeConflict === true || (server.launchable === false && ["global-lazy", "global-direct"].includes(server.modeGlobal));
 const reason = server.modeConflict
 ? tr("名称冲突已暂停；可保存“不经 Hub”。启用前请先解决冲突。", "Name conflict paused; you can save “Bypass Hub”. Resolve the conflict before enabling.")
 : server.launchable === false ? tr("服务缺少可运行入口；可保存“不经 Hub”关闭转发。", "No runnable endpoint; save “Bypass Hub” to turn forwarding off.") : "";
 return `<div class="hub-mcp-mode-controls"><label>${esc(tr("范围", "Scope"))}<select class="hub-select" name="mcp-mode-scope" aria-label="${esc(tr("Hub 调用方式范围", "Hub usage scope"))}" data-name="${esc(server.name)}"><option value="project" ${scope === "project" ? "selected" : ""} ${projectDisabled() ? "disabled" : ""}>${esc(tr("当前项目", "This project"))}</option><option value="global" ${scope === "global" ? "selected" : ""}>${esc(tr("所有项目默认", "All projects default"))}</option></select></label><label>${esc(tr("通过 Hub 使用", "Use through Hub"))}<select class="hub-select" name="mcp-mode" aria-label="${esc(tr("Hub 调用方式", "Hub usage mode"))}" data-name="${esc(server.name)}"><option value="off" ${mode === "off" ? "selected" : ""}>${esc(tr("不经 Hub", "Bypass Hub"))}</option><option value="inherit" ${mode === "inherit" ? "selected" : ""} ${scope === "global" ? "hidden" : ""} ${cannotInherit ? "disabled" : ""}>${esc(tr("跟随全局", "Follow global"))}</option><option value="lazy" ${mode === "lazy" ? "selected" : ""} ${cannotEnable ? "disabled" : ""}>${esc(tr("用到时再连接", "Connect on demand"))}</option><option value="direct" ${mode === "direct" ? "selected" : ""} ${cannotEnable ? "disabled" : ""}>${esc(tr("列出全部工具", "List all tools"))}</option></select></label>${button("save-mcp-mode", tr("保存 Hub 方式", "Save Hub mode"), { small: true, attrs: `data-name="${esc(server.name)}"` })}<p class="hub-mcp-mode-hint">${esc(mcpModeScopeHint(server, scope, reason))}</p></div>`;
    }
    async function saveMcpMode(element) {
 const name = element.dataset.name, controls = element.closest(".hub-mcp-mode-controls");
 const scope = controls?.querySelector('[name="mcp-mode-scope"]')?.value;
 const choice = controls?.querySelector('[name="mcp-mode"]')?.value;
 const projectRoot = state.projectRoot, version = contextVersion;
 if (!name || !["project", "global"].includes(scope) || !["off", "inherit", "lazy", "direct"].includes(choice)) return;
 if (choice === "inherit" && scope !== "project") return;
 if (!projectWriteReady(scope)) return;
 const mode = choice === "inherit" ? "inherit" : choice === "off" ? "off" : `${scope}-${choice}`;
 const payload = { name, mode, ...(scope === "project" ? { projectRoot } : {}) };
 await busy(`mcp-mode:${name}`, element, async () => {
 await request("mcp:setMode", payload);
 if (disposed || version !== contextVersion) return;
 const verification = await request("mcp:list", scope === "global" ? {} : { projectRoot });
 const saved = items(verification, ["items", "servers"]).find((item) => item.name === name);
 const readbackMatches = choice === "inherit"
 ? saved?.modeProject == null && saved?.modeScope === "global" && saved?.mode === (saved.modeGlobal || "off")
 : saved?.mode === mode && saved?.modeScope === scope;
 if (!saved || !readbackMatches) throw new Error(tr("设置已提交，但回读结果不一致，请刷新后检查", "The mode was submitted, but readback did not match. Refresh and check it."));
 const current = scope === "global" && projectRoot ? await request("mcp:list", { projectRoot }) : verification;
 if (disposed || version !== contextVersion) return;
 cache.mcp = current;
 delete errors.mcp;
 renderMcpList();
 const effective = items(current, ["items", "servers"]).find((item) => item.name === name);
 const message = choice === "inherit"
 ? tr("已清除当前项目的单独设置，现跟随全局默认。", "This project's override was cleared; it now follows the global default.")
 : scope === "global" && effective?.modeScope === "project"
 ? tr("已保存全局 Hub 调用方式；当前项目的单独设置仍优先生效。", "Global Hub mode saved; this project's setting still takes precedence.")
 : tr("已保存 Hub 调用方式；当前 Agent 工具列表刷新取决于 Agent。", "Hub usage mode saved; the agent controls when its tool list refreshes.");
 toast(message);
 });
    }
    function renderMcpList() {
 const node = root.querySelector("#t3-hub-mcp-list");
 if ((state.tab !== "skills" || state.libraryView !== "mcp") || disposed || !node) return;
 if (errors.mcp || !cache.mcp) { node.innerHTML = errors.mcp ? inlineError(errors.mcp) : loading(); return; }
 const query = state.mcpQuery.trim().toLowerCase();
 const servers = mcpServers().filter((server) => mcpSourceMatchesFilter(server, state.mcpFilter) && resourceMatches(server, "mcp") && (!query || `${server.name} ${server.displayName} ${server.groupTitle} ${server.description || ""}`.toLowerCase().includes(query)));
 renderMcpSourceFilters();
 node.innerHTML = servers.length ? `<div class="hub-market-grid hub-resource-grid">${servers.map((server) => {
 const summary = redact(server.summary || server.url || [server.command, ...items(server, ["args"])].filter(Boolean).join(" "));
 const removable = server.removable === true || !server.builtin && !server.readonly && ["custom", "hub"].includes(server.source);
 const connectionLabel = !server.probed ? tr("连通性未检测", "Connection not checked") : server.connected === true ? tr("探测成功", "Probe succeeded") : tr("探测未通", "Probe failed");
 const availabilityBadge = server.launchable === false ? `<span class="hub-badge hub-unavailable" title="${esc(launchReasonLabel(server.launchReason))}">${esc(tr("入口不可用", "Entry unavailable"))}</span>` : `<span class="hub-badge">${esc(tr("入口已配置", "Entry configured"))}</span>`;
 const hubModeBadge = `<span class="hub-badge hub-route-status">${esc(hubModeLabel(server))}</span>`;
 const nativeBadge = `<span class="hub-badge">${esc(agentStatusLabel(server, "mcp"))}</span>`;
 const conflictBadge = server.modeConflict ? `<span class="hub-badge" title="${esc(tr("同名归一键对应多个定义，自动启用已暂停", "Multiple definitions share a normalized name; automatic activation is paused"))}">${esc(tr("名称冲突已暂停", "Name conflict · paused"))}</span>` : "";
 return `<article class="hub-card hub-market-card hub-resource-card hub-mcp-row" data-mcp-name="${esc(server.name)}"><div class="hub-card-top">${brandIcon(server, "mcp")}<div class="hub-grow"><div class="hub-card-name">${esc(server.displayName || server.title || server.name)}</div><div class="hub-card-meta">${mcpSourceLabels(server).map((label) => `<span class="hub-badge">${esc(label)}</span>`).join("")}${availabilityBadge}<span class="hub-badge" title="${esc(server.statusText || connectionLabel)}">${esc(connectionLabel)}</span>${nativeBadge}${hubModeBadge}${conflictBadge}</div></div></div><p class="hub-card-description">${esc(server.shortDescription || server.description || summary || tr("工具服务", "Tool server"))}</p>${!server.launchable && server.launchReason ? `<p class="hub-hint hub-unavailable-hint">${esc(launchReasonLabel(server.launchReason))}</p>` : ""}<div class="hub-mcp-row-options">${removable ? `<button type="button" class="hub-icon-btn" data-action="remove-mcp" data-name="${esc(server.name)}" aria-label="${esc(tr("移除", "Remove"))} ${esc(server.name)}">${icon("trash", 12)} ${esc(tr("移除", "Remove"))}</button>` : ""}</div><div class="hub-confirm-delete" data-mcp-confirm hidden>${esc(tr("移除此 MCP 配置？", "Remove this MCP definition?"))}<div class="hub-row">${button("confirm-remove-mcp", tr("确认移除", "Remove"), { small: true, attrs: `data-name="${esc(server.name)}"` })}${button("cancel-remove-mcp", tr("取消", "Cancel"), { small: true })}</div></div><div class="hub-resource-controls-label">${esc(tr("Agent 原生配置（与 Hub 路由分开）", "Native agent config (separate from Hub routing)"))}</div>${agentToggleRow(server, "mcp")}${renderMcpModeControls(server)}</article>`;
 }).join("")}</div>` : empty(tr("没有匹配的 MCP", "No matching MCP servers"), tr("换个来源筛选条件，或添加一个已核验配置的本机服务。", "Try another source filter or add a locally configured service."));
    }
    function mcpGroupTitle(name) {
 const names = [[/chrome/i, "Chrome Devtools MCP"], [/codegraph/i, "Codegraph"], [/context7/i, "Context7 Docs"], [/playwright/i, "Playwright MCP"], [/lcu|computer.use/i, "LCU Computer Use"], [/reach/i, "Briking Agent Reach"], [/product|library/i, tr("产品库查询", "Product Library")], [/github/i, "GitHub"], [/cloudflare/i, "Cloudflare"]];
 return names.find(([test]) => test.test(name))?.[1] || tr("其他上游", "Other upstream servers");
    }

    function selectedMemoryProject() {
 if (!memoryProjectReady()) return null;
 const projects = items(cache.overview, ["projects", "items"]);
 return projects.find((project) => project.slug === cache.overview?.currentProjectSlug) || projects.find((project) => project.projectRoot === state.projectRoot || project.root === state.projectRoot || project.path === state.projectRoot);
    }
    function memoryProjectReady() { return state.memoryProject === "current" && projectContextReady(); }
    function selectedMemoryRoot() {
 return memoryProjectReady() ? state.projectRoot : null;
    }
    function memoryPayload() {
 return { projectRoot: selectedMemoryRoot(), scope: "project", scopeFilter: state.memoryScope === "smart" ? "default" : state.memoryScope === "project" ? "shared" : state.memoryScope, module: state.memoryModule === "all" ? undefined : state.memoryModule, query: state.memoryQuery.trim(), limit: 500 };
    }
    function moduleOptions() {
 return [["all", tr("全部", "All"), ""], ["constraints", tr("铁律", "Rules"), ""], ["pitfalls", tr("踩坑", "Pitfalls"), ""], ["architecture", tr("架构", "Architecture"), ""], ["topics", tr("专题", "Topics"), ""]];
    }
    function normalizeModule(module) {
 return ({ constraint: "constraints", rule: "constraints", rules: "constraints", pitfall: "pitfalls", experience: "pitfalls", topic: "topics", "topic-memory": "topics", memory: "constraints" })[module] || module || "topics";
    }
 function renderMemory() {
 content.innerHTML = `<div class="hub-section-heading"><span>${esc(tr("记忆工作台", "Memory workspace"))}</span><span class="hub-count" id="t3-hub-memory-total"></span></div><p class="hub-description">${esc(tr("只读取和维护当前确认项目的共享经验与工作树便签。本机接入状态不代表当前会话已加载。", "Read and maintain shared knowledge and worktree notes for the currently confirmed project only. Local access status does not prove the current session loaded it."))}</p><div id="t3-hub-memory-access"></div><div id="t3-hub-memory-runtime"></div><div id="t3-hub-memory-connections"></div><div id="t3-hub-worktree"></div><div id="t3-hub-memory-nav"></div><div id="t3-hub-new-memory"></div><div class="hub-search">${icon("search", 14)}<input class="hub-input" name="memoryQuery" aria-label="${esc(tr("搜索记忆", "Search memories"))}" placeholder="${esc(tr("搜索记忆", "Search memories"))}" value="${esc(state.memoryQuery)}" ${memoryProjectReady() ? "" : "disabled"}></div><div id="t3-hub-memory-filters" class="hub-filters hub-memory-filters"></div><div id="t3-hub-memory-list"></div>`;
 renderMemoryAgentAccess();
 renderMemoryRuntime();
 renderMemoryConnections();
 renderWorktreeScopes();
 renderMemoryNav();
 renderMemoryList();
 renderNewMemory();
    }
    const memoryConnectionAgents = [
 { id: "t3", label: "T3" }, { id: "codex", label: "Codex" }, { id: "muse", label: "Muse" },
 { id: "agy", label: "AGY" }, { id: "claude", label: "Claude" }, { id: "pi", label: "Pi" },
    ];
    const memorySetupPrompt = [
 "请帮我完成本机 T3 Agent 的记忆首次接入：",
 "0. 先确认本会话当前选中的 T3 项目与工作树；如果无法确认，停止记忆读取和写入。主 Agent 与子 Agent 每次记忆调用都传当前 T3 项目的绝对 projectRoot；如提示项目未绑定，不改传别的路径绕过，请报告缺口。每次调用都只绑定此项目/工作树，不查找或使用全局通用记忆，也不自行改成其他项目。",
 "1. 运行固定命令 `~/.t3/bin/t3-memory-setup status` 检查当前状态。",
 "2. 运行固定命令 `~/.t3/bin/t3-memory-setup setup` 完成本机接入。",
 "3. 调用可用的 `memory_status` 工具核验记忆状态；如果当前会话没有这个工具，请说明可能需要新会话后再次验证，不要重启 T3。",
 "只改 Hub MCP 接入，保留已有正确的 Magpie 记忆条目和其他 MCP；不要修改认证、模型或原生路由。遇到检查失败、冲突、未知或待处理项时如实报告，不要声称接入成功。关闭 Agent 访问时保留所有记忆内容和手工维护的配置。",
    ].join("\n");
    function memoryAccessIssues(summary = {}) {
 return ["missing", "conflict", "unsupported", "unknown", "pending"].some((key) => Number(summary[key]) > 0);
    }
    function memoryAccessIssueText(reason) {
 return ({ managed_by_magpie: tr("由 Magpie 管理，保留原条目并等待同步", "Magpie-managed; preserved and pending sync"), agy_native_helper_compatibility: tr("保留 AGY 原生兼容设置，暂列待处理", "Preserved for AGY compatibility; pending"), entry_missing: tr("尚未发现 Hub MCP", "Hub MCP not found"), unknown: tr("状态无法确认", "Status could not be confirmed") })[String(reason || "")] || tr("需要进一步检查", "Needs review");
    }
    async function refreshMemoryAgentAccess(force = false) {
 if (disposed || cache.agentAccess && !force) return cache.agentAccess;
 if (memoryAccessLoading && !force) return memoryAccessLoading;
 const version = ++memoryAccessVersion;
 delete errors.agentAccess;
 renderChrome();
 const task = (async () => {
  try {
   const data = await requestMemoryAccess("memory:agentAccess:get");
   if (disposed || version !== memoryAccessVersion) return cache.agentAccess;
   cache.agentAccess = data;
   delete errors.agentAccess;
  } catch (error) {
   if (!disposed && version === memoryAccessVersion) errors.agentAccess = error;
  } finally {
   if (!disposed && version === memoryAccessVersion) {
    renderMemoryTitleControls();
    renderChrome();
    if (state.tab === "memory") renderMemoryAgentAccess();
   }
  }
  return cache.agentAccess;
 })();
 memoryAccessLoading = task;
 try { return await task; }
 finally { if (memoryAccessLoading === task) memoryAccessLoading = null; }
    }
    function openMemoryFromTitle() {
 if (disposed) return;
 state.tab = "memory";
 setOpen(true);
    }
    function toggleMemoryAccessFromTitle() {
 if (disposed || state.memoryAgentAccessUpdating) return;
 return setMemoryAgentAccess(cache.agentAccess?.enabled !== true);
    }
    function renderMemoryAgentAccess() {
 const node = root.querySelector("#t3-hub-memory-access");
 if (!node) return;
 const access = cache.agentAccess || {}, summary = access.setupSummary || {}, providers = Array.isArray(summary.providers) ? summary.providers : [];
 const enabled = access.enabled === true, updating = state.memoryAgentAccessUpdating;
 const status = errors.agentAccess ? tr("无法读取本机状态", "Local status unavailable")
  : state.memorySetupNotice === "incomplete" ? tr("检查未完成", "Check incomplete")
  : enabled ? !Array.isArray(summary.providers) ? tr("已允许 · 接入状态待检查", "Allowed · setup status not checked") : summary.providers.length === 0 ? tr("已允许 · 未发现可接入 Agent", "Allowed · no eligible agent found") : memoryAccessIssues(summary) ? tr("已允许 · 有待处理项", "Allowed · some agents are pending") : tr("已允许 · 配置就绪，会话加载未验证", "Allowed · configured, session loading unverified")
  : access.enabled === false ? tr("已关闭", "Disabled") : tr("无法确认", "Unknown");
 const counts = [["configured", tr("配置就绪", "Configured")], ["pending", tr("待处理", "Pending")], ["missing", tr("缺少接入", "Missing")], ["conflict", tr("冲突", "Conflict")], ["unknown", tr("无法确认", "Unknown")], ["unsupported", tr("不支持", "Unsupported")]]
  .filter(([key]) => Number(summary[key]) > 0).map(([key, label]) => `<span>${esc(label)} ${esc(Number(summary[key]))}</span>`).join("");
 const providerHtml = providers.map((provider) => {
  const stateName = ["configured", "missing", "conflict", "unsupported", "unknown", "pending"].includes(provider?.status) ? provider.status : "unknown";
  const label = provider?.displayName || provider?.instanceId || tr("Agent", "Agent");
  const detail = stateName === "configured" ? tr("已找到 Hub MCP 配置", "Hub MCP configuration found") : memoryAccessIssueText(provider?.reason);
  return `<div class="hub-memory-access-provider"><strong data-status="${stateName}">${esc(label)} · ${esc(connectionStatusLabel(stateName))}</strong><small>${esc(detail)}</small></div>`;
 }).join("");
 const errorHtml = errors.agentAccess ? `<p class="hub-hint" role="status">${esc(tr("暂时无法核验本机 T3 Agent 的记忆接入状态。", "Could not verify local T3 Agent memory access."))}</p>`
  : state.memorySetupNotice === "incomplete" ? `<p class="hub-hint" role="status">${esc(tr("接入检查未完成，仍有 Agent 待处理或无法确认；请勿将其视为已全部接入。", "Setup is incomplete. Some agents remain pending or unverified; access is not confirmed for all agents."))}</p>`
  : state.memorySetupNotice === "checked" ? `<p class="hub-hint" role="status">${esc(tr("本机配置检查完成；当前会话是否已加载仍未验证。", "Local configuration was checked; current session loading remains unverified."))}</p>` : "";
 node.innerHTML = `<section class="hub-card hub-memory-access"><div class="hub-row"><label class="hub-memory-access-switch"><input type="checkbox" name="memoryAgentAccess" aria-label="${esc(tr("允许本机 T3 Agent 使用记忆", "Allow local T3 Agents to use memory"))}" aria-checked="${access.enabled == null ? "mixed" : String(enabled)}" ${enabled ? "checked" : ""} ${updating ? "disabled" : ""}><span>${esc(tr("允许本机 T3 Agent 使用记忆", "Allow local T3 Agents to use memory"))}</span></label><span class="hub-grow"></span><span class="hub-memory-access-state" data-status="${errors.agentAccess || access.enabled == null ? "unknown" : state.memorySetupNotice === "incomplete" || enabled && memoryAccessIssues(summary) ? "pending" : enabled ? "configured" : "missing"}">${esc(status)}</span></div><p class="hub-card-description">${esc(tr("这是本机设置，不用于 Connect 远端会话。关闭访问会保留记忆内容和手工配置。开关会即时控制 Hub MCP 接入；已加载 MCP 的旧会话需自然重连后更新，不会由这里强制结束。当前会话可用 memory_status 验证。", "This is a local setting and does not apply to Connect remote chats. Disabling access keeps saved memories and manual configuration. The switch immediately controls Hub MCP access; an existing session that already loaded the MCP updates after it naturally reconnects. This does not force that session to close. Verify the current session with memory_status."))}</p><div class="hub-memory-access-actions">${button("memory-access-setup", tr("检查并接入", "Check and set up"), { primary: true, small: true, icon: "check", disabled: updating })}${button("memory-access-copy-prompt", tr("复制首次接入提示词", "Copy setup prompt"), { small: true, disabled: updating })}${button("memory-access-refresh", tr("刷新状态", "Refresh status"), { small: true, icon: "refresh", disabled: updating })}</div>${counts ? `<div class="hub-memory-access-summary">${counts}</div>` : ""}${providerHtml ? `<div class="hub-memory-access-providers">${providerHtml}</div>` : ""}${errorHtml}${state.memorySetupPromptVisible ? `<label class="hub-field" style="margin-top:10px">${esc(tr("首次接入提示词（可手动复制）", "First setup prompt (copy manually)"))}<textarea class="hub-input hub-memory-access-prompt" readonly spellcheck="false">${esc(memorySetupPrompt)}</textarea></label>` : ""}</section>`;
 renderMemoryTitleControls();
 renderMemoryRuntime();
    }
    async function setMemoryAgentAccess(enabled) {
 if (typeof enabled !== "boolean" || disposed || state.memoryAgentAccessUpdating) return;
 memoryAccessVersion++;
 state.memoryAgentAccessUpdating = true; state.memorySetupNotice = ""; delete errors.agentAccess; renderMemoryAgentAccess();
 renderMemoryTitleControls(); renderChrome();
 try {
  const result = await requestMemoryAccess("memory:agentAccess:set", { enabled });
  cache.agentAccess = result.access || result;
  if (result.setupSummary && !cache.agentAccess.setupSummary) cache.agentAccess = { ...cache.agentAccess, setupSummary: result.setupSummary };
  if (enabled && (result.ok === false || result.setupOk === false || memoryAccessIssues(cache.agentAccess.setupSummary || {}))) state.memorySetupNotice = "incomplete";
  else if (enabled) state.memorySetupNotice = "checked";
  delete errors.agentAccess;
 } catch (error) { errors.agentAccess = error; }
 finally { state.memoryAgentAccessUpdating = false; renderMemoryAgentAccess(); renderMemoryTitleControls(); renderChrome(); }
    }
    async function runMemorySetup() {
 if (disposed || state.memoryAgentAccessUpdating) return;
 memoryAccessVersion++;
 state.memoryAgentAccessUpdating = true; state.memorySetupNotice = ""; delete errors.agentAccess; renderMemoryAgentAccess();
 renderMemoryTitleControls(); renderChrome();
 try {
  const result = await requestMemoryAccess("memory:setup");
  cache.agentAccess = result.access || result;
  if (result.setupSummary && !cache.agentAccess.setupSummary) cache.agentAccess = { ...cache.agentAccess, setupSummary: result.setupSummary };
  if (result.ok === false || result.setupOk === false || memoryAccessIssues(cache.agentAccess.setupSummary || {})) {
   state.memorySetupNotice = "incomplete";
   toast(tr("检查未完成，请查看待处理或冲突项", "Setup is incomplete. Review pending or conflicting agents."), true);
  } else {
   state.memorySetupNotice = "checked";
   toast(tr("本机接入配置已检查；当前会话仍需单独验证", "Local access was checked; verify current session separately"));
  }
 } catch (error) { errors.agentAccess = error; toast(tr("接入检查失败，未确认完成", "Setup failed; completion was not confirmed"), true); }
 finally { state.memoryAgentAccessUpdating = false; renderMemoryAgentAccess(); renderMemoryTitleControls(); renderChrome(); }
    }
    async function copyMemorySetupPrompt() {
 try {
  const clipboard = window.navigator?.clipboard;
  if (typeof clipboard?.writeText !== "function") throw new Error("clipboard_unavailable");
  await clipboard.writeText(memorySetupPrompt);
  state.memorySetupPromptVisible = false; renderMemoryAgentAccess();
  toast(tr("首次接入提示词已复制", "Setup prompt copied"));
 } catch {
  state.memorySetupPromptVisible = true; renderMemoryAgentAccess();
  toast(tr("无法自动复制；已显示提示词供手动复制", "Clipboard unavailable; the prompt is shown for manual copy"), true);
 }
    }
    function connectionStatusLabel(status) {
 return ({ configured: tr("已配置", "Configured"), missing: tr("未配置", "Not configured"), conflict: tr("冲突", "Conflict"), pending: tr("待处理", "Pending"), unsupported: tr("不支持", "Unsupported"), unknown: tr("无法确认", "Unknown") })[status] || tr("无法确认", "Unknown");
    }
    function renderMemoryConnections() {
 const node = root.querySelector("#t3-hub-memory-connections");
 if (!node) return;
 const agents = Array.isArray(cache.connections?.agents) ? cache.connections.agents : [];
 const byId = new Map(agents.map((agent) => [String(agent.id || "").toLowerCase(), agent]));
 const domains = [["mcp", "MCP"], ["skill", tr("技能", "Skills")], ["hook", "Hook"]];
 const errorHint = errors.connections ? `<div class="hub-connection-error" role="status">${esc(tr("暂时无法读取接入状态。", "Connection status is temporarily unavailable."))} ${button("refresh-memory-connections", tr("重试", "Retry"), { small: true, icon: "refresh" })}</div>` : "";
 node.innerHTML = `${errorHint}<div class="hub-connection-grid" aria-label="${esc(tr("Agent 记忆接入状态", "Agent memory connection status"))}">${memoryConnectionAgents.map(({ id, label }) => {
 const agent = byId.get(id) || {};
 const cells = domains.map(([key, title]) => {
 const record = agent[key] || { status: "unknown", summary: tr("尚无配置证据", "No configuration evidence") };
 return `<div class="hub-connection-cell"><span>${esc(title)}</span><strong data-status="${["configured", "missing", "unsupported", "unknown"].includes(record.status) ? record.status : "unknown"}">${esc(connectionStatusLabel(record.status))}</strong><small>${esc(record.summary || "")}</small></div>`;
 }).join("");
 const runtime = agent.runtime || { status: "unverified", summary: tr("当前会话未验证", "Current session not verified") };
 return `<article class="hub-connection-agent"><h3>${esc(agent.label || label)}</h3><div class="hub-connection-fields">${cells}<div class="hub-connection-cell"><span>${esc(tr("当前会话", "Runtime"))}</span><strong data-status="unknown">${esc(runtime.status === "verified" ? tr("已验证", "Verified") : tr("未验证", "Unverified"))}</strong><small>${esc(runtime.summary || tr("当前会话未验证", "Current session not verified"))}</small></div></div></article>`;
 }).join("")}</div><p class="hub-hint hub-connection-note">${esc(tr("这些状态来自本机配置检查，不代表当前对话已加载。Hook 属于可选能力，不是记忆读写的前提。", "These statuses come from local configuration checks and do not prove the current chat loaded them. Hooks are optional and are not required for memory access."))} ${button("refresh-memory-connections", tr("刷新状态", "Refresh status"), { small: true, icon: "refresh" })}</p>`;
    }
    function memoryMcpConfigText() {
 return JSON.stringify({ mcpServers: { t3_hub: { command: "/bin/sh", args: ["-c", 'exec "$HOME/.t3/bin/t3-mcp-router" --memory-only'] } } }, null, 2);
    }
    async function runMemoryVectorTest() {
 if (disposed || state.memoryVectorTestRunning) return;
 state.memoryVectorTestRunning = true;
 state.memoryVectorTest = { status: "running" };
 renderMemoryRuntime();
 try {
  const result = await request("embed:test", {});
  if (disposed) return;
  if (result?.ok !== true) throw new Error(result?.message || result?.error || tr("向量模型测试失败", "Vector model test failed"));
  state.memoryVectorTest = { status: "success", modelId: result.modelId, dimensions: result.dimensions, latencyMs: result.latencyMs };
 } catch (error) {
  if (!disposed) state.memoryVectorTest = { status: "error", message: errorText(error) };
 } finally {
  state.memoryVectorTestRunning = false;
  if (!disposed && state.tab === "memory") renderMemoryRuntime();
 }
    }
    function renderMemoryRuntime() {
 const node = root.querySelector("#t3-hub-memory-runtime");
 if (!node) return;
 const data = cache.embed, port = Number(data?.port);
 const address = Number.isInteger(port) && port > 0 && port < 65536 ? `http://127.0.0.1:${port}` : "";
 const configuredModel = typeof data?.configuredModelId === "string" && data.configuredModelId.trim() ? data.configuredModelId.trim() : "";
 const activeModel = typeof data?.activeModelId === "string" && data.activeModelId.trim() ? data.activeModelId.trim() : "";
 const running = data?.running === true;
 const mode = String(data?.mode || "").toLowerCase();
 const modelStatus = !data ? tr("无法确认", "Unknown") : running ? tr("运行中", "Running") : /^(fts5|keyword|none)$/.test(mode) ? tr("关键词模式", "Keyword mode") : data.running === false ? tr("未运行", "Not running") : tr("无法确认", "Unknown");
 const access = cache.agentAccess || {}, summary = access.setupSummary || {}, providers = Array.isArray(summary.providers) ? summary.providers : [];
 const count = (key) => Number.isFinite(Number(summary[key])) ? Math.max(0, Math.trunc(Number(summary[key]))) : 0;
 const configuredCount = count("configured"), conflictCount = count("conflict"), pendingCount = count("pending") + count("unknown") + count("missing") + count("unsupported");
 const setupKnown = !errors.agentAccess && Object.keys(summary).length > 0;
 const mcpLabel = !setupKnown ? tr("无法确认", "Unknown")
  : conflictCount || pendingCount ? tr(`配置 ${configuredCount} · 待处理 ${conflictCount + pendingCount}`, `Configured ${configuredCount} · ${conflictCount + pendingCount} pending`)
  : configuredCount ? tr(`已配置 ${configuredCount} 个 Agent`, `${configuredCount} agents configured`)
  : tr("尚无配置项", "No configured providers");
 const providerSummary = [tr(`已配置 ${configuredCount}，冲突 ${conflictCount}，待处理 ${pendingCount}`, `Configured ${configuredCount}, conflicts ${conflictCount}, pending ${pendingCount}`), providers.map((provider) => `${provider.displayName || provider.instanceId || tr("Agent", "Agent")} · ${connectionStatusLabel(provider.status || "unknown")}`).join("；")].filter(Boolean).join("；");
 const runtimeState = String(summary.runtime || "").toLowerCase();
 const runtimeLabel = runtimeState === "verified" ? tr("已验证", "Verified") : runtimeState === "pending" ? tr("待处理", "Pending") : tr("未验证", "Unverified");
 const runtimeDetail = runtimeState === "verified" ? tr("本机 Agent 会话已验证", "Local Agent session verified") : tr("当前会话是否已加载尚未验证", "Current session loading has not been verified");
 const accessLabel = cache.agentAccess?.enabled === true ? tr("已开启", "Enabled") : cache.agentAccess?.enabled === false ? tr("已关闭", "Disabled") : tr("无法确认", "Unknown");
 const addressText = address || tr("无法确认", "Unknown");
 const modelText = running ? activeModel || tr("无法确认", "Unknown") : tr("未运行", "Not running");
 const configuredText = configuredModel || (/^(fts5|keyword|none)$/.test(mode) ? tr("不适用（关键词模式）", "Not applicable (keyword mode)") : tr("尚未配置", "Not configured"));
 const errorHtml = errors.embed ? `<p class="hub-hint" role="status">${esc(tr("暂时无法读取本机向量服务状态。", "Could not read local vector service status."))} ${button("refresh-memory-runtime", tr("重试", "Retry"), { small: true, icon: "refresh" })}</p>` : "";
 const copyArea = state.memoryMcpConfigVisible ? `<textarea class="hub-input hub-memory-mcp-config" readonly spellcheck="false" aria-label="${esc(tr("MCP 配置 JSON", "MCP config JSON"))}">${esc(memoryMcpConfigText())}</textarea>` : "";
 node.innerHTML = `<section class="hub-card hub-memory-runtime"><div class="hub-section-heading"><span>${esc(tr("本机记忆服务", "Local memory services"))}</span><span class="hub-badge">${esc(tr("仅本机", "Local only"))}</span></div><div class="hub-memory-runtime-grid"><div class="hub-memory-runtime-cell"><span>${esc(tr("向量状态", "Vector status"))}</span><strong>${esc(modelStatus)}</strong></div><div class="hub-memory-runtime-cell"><span>${esc(tr("运行中的向量模型", "Active vector model"))}</span><strong>${esc(modelText)}</strong></div><div class="hub-memory-runtime-cell"><span>${esc(tr("已配置模型", "Configured model"))}</span><strong>${esc(configuredText)}</strong></div><div class="hub-memory-runtime-cell"><span>${esc(tr("本机服务地址", "Local service address"))}</span><strong>${esc(addressText)}</strong></div><div class="hub-memory-runtime-cell"><span>${esc(tr("Agent 记忆开关", "Agent memory access"))}</span><strong>${esc(accessLabel)}</strong></div><div class="hub-memory-runtime-cell"><span>${esc(tr("Hub MCP 配置（Agent 汇总）", "Hub MCP config (agent summary)"))}</span><strong data-status="${setupKnown ? conflictCount || pendingCount ? "pending" : configuredCount ? "configured" : "unknown" : "unknown"}">${esc(mcpLabel)}</strong><small>${esc(redact(providerSummary || tr("本机配置状态未确认", "Local config status is unknown")))}</small></div><div class="hub-memory-runtime-cell"><span>${esc(tr("当前会话运行时", "Current session runtime"))}</span><strong>${esc(runtimeLabel)}</strong><small>${esc(runtimeDetail)}</small></div></div><div class="hub-memory-mcp"><div><strong>${esc(tr("连接方式：本机 stdio（由宿主启动）", "Connection: local stdio (started by the host)"))}</strong><code>${esc(tr("自动使用当前用户的 T3 路径", "Uses the current user's T3 path"))}</code></div>${button("copy-memory-mcp-config", tr("复制 MCP 配置", "Copy MCP config"), { small: true, icon: "terminal" })}</div><p class="hub-hint">${esc(tr("MCP 由宿主通过本机 stdio 启动，配置会自动使用当前宿主的 HOME 定位 T3 路由器；无需替换路径。它不是 HTTP 地址，也不包含真实 HOME 或令牌。", "The host starts the MCP over local stdio. The config uses the current host's HOME to locate the T3 router automatically, so no path replacement is needed. It is not an HTTP endpoint and contains no real HOME path or token."))}</p>${copyArea}${errorHtml}</section>`;
 const vectorTest = state.memoryVectorTest;
 const testOutput = !vectorTest ? "" : vectorTest.status === "running" ? `<p class="hub-hint" role="status">${esc(tr("正在测试向量模型…", "Testing the vector model…"))}</p>` : vectorTest.status === "success" ? `<p class="hub-hint" role="status" data-status="success">${esc(tr("测试成功", "Test passed"))} · ${esc(vectorTest.modelId || tr("模型未知", "Model unknown"))} · ${esc(vectorTest.dimensions ?? tr("维度未知", "dimensions unknown"))} ${esc(tr("维度", "dimensions"))} · ${esc(vectorTest.latencyMs ?? tr("耗时未知", "latency unknown"))} ms</p>` : `<p class="hub-hint" role="alert" data-status="error">${esc(tr("测试失败", "Test failed"))} · ${esc(vectorTest.message || tr("无法确认原因", "Reason unavailable"))}</p>`;
 const vectorTestMarkup = `<div class="hub-memory-vector-test">${button("test-memory-vector", state.memoryVectorTestRunning ? tr("测试中…", "Testing…") : tr("测试向量模型", "Test vector model"), { small: true, icon: "check", disabled: state.memoryVectorTestRunning })}${testOutput}<p class="hub-hint">${esc(tr("本机独立 MLX 服务，无需打开 oMLX；是否可用以测试结果为准。", "The local MLX service runs independently; oMLX does not need to be open. Use the test result to confirm availability."))}</p></div>`;
 node.innerHTML = node.innerHTML.replace("</section>", `${vectorTestMarkup}</section>`);
    }
    async function copyMemoryMcpConfig() {
 const config = memoryMcpConfigText();
 try {
  const clipboard = window.navigator?.clipboard;
  if (typeof clipboard?.writeText !== "function") throw new Error("clipboard_unavailable");
  await clipboard.writeText(config);
  state.memoryMcpConfigVisible = false; renderMemoryRuntime();
  toast(tr("MCP 配置已复制", "MCP config copied"));
 } catch {
  state.memoryMcpConfigVisible = true; renderMemoryRuntime();
  toast(tr("无法自动复制；已显示配置供手动复制", "Clipboard unavailable; the config is shown for manual copy"), true);
 }
    }
    function renderWorktreeScopes() {
 const node = root.querySelector("#t3-hub-worktree");
 if (!node) return;
 const info = cache.worktree || {};
 const ready = memoryProjectReady();
 const caption = ready ? info.branch || info.branchName || info.worktreeName || tr("本项目共享经验与工作树便签", "Shared project knowledge and worktree notes") : tr("请先在 T3 中打开并确认一个项目，再读取或维护项目记忆。", "Open and confirm a project in T3 before reading or maintaining project memories.");
 node.innerHTML = `<div class="hub-worktree-bar"><div class="hub-segments" role="group" aria-label="${esc(tr("项目记忆范围", "Project memory scope"))}">${[["smart", tr("智能默认（本项目共享 + 当前工作树）", "Smart · This project + current tree")], ["project", tr("本项目共享", "Shared in this project")], ["worktree", tr("当前工作树便签", "Current worktree notes")]].map(([scope, label]) => `<button type="button" class="${state.memoryScope === scope ? "is-active" : ""}" data-action="memory-scope-filter" data-scope="${scope}" aria-pressed="${state.memoryScope === scope}" ${ready ? "" : "disabled"}>${esc(label)}</button>`).join("")}</div><div class="hub-worktree-caption"><span>${esc(caption)}</span>${button("open-memory-folder", tr("打开记忆文件夹", "Open memory folder"), { small: true, icon: "folder", disabled: !ready })}</div></div>`;
 if (errors.worktree) node.insertAdjacentHTML("beforeend", `<p class="hub-hint">${esc(errorText(errors.worktree))}</p>`);
    }
    async function setMemoryScope(scope) {
 if (!["smart", "project", "worktree"].includes(scope)) return;
 state.memoryScope = scope;
 state.memoryProject = "current";
 state.selectedMemory = null; cache.memory = null; memoryVersion++;
 renderWorktreeScopes(); renderMemoryNav(); renderMemoryList();
 if (memoryProjectReady()) await loadMemories();
    }
    async function promoteMemory(id, element) {
 if (!memoryWriteReady()) return;
 const selection = memorySelection(), payload = memoryPayload();
 await busy(`memory-promote:${id}`, element, async () => {
 await request("memory:promote", { projectRoot: payload.projectRoot, id, scope: "project" });
 if (disposed || selection !== memorySelection()) return;
 await loadMemories(); toast(tr("已提炼为项目长期共享记忆", "Promoted to shared project memory"));
 });
    }
    function curatedModels() {
 const models = items(cache.embed, ["models", "presets", "availableModels"]);
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
    function renderMemoryNav() {
 const node = root.querySelector("#t3-hub-memory-nav");
 if (!node) return;
 const ready = memoryProjectReady();
 const current = ready ? projectTitle() : tr("尚未确认项目", "No confirmed project");
 const project = ready ? selectedMemoryProject() : null;
 const total = project?.total ?? cache.memory?.total;
 const prompt = ready ? "" : `<p class="hub-hint" role="status">${esc(tr("请先在 T3 中打开并确认当前项目；记忆只会读取和写入这个项目。", "Open and confirm the current project in T3 first. Memory reads and writes are limited to that project."))}</p>`;
 node.innerHTML = `<div class="hub-project-picker"><select class="hub-select" name="memoryProject" aria-label="${esc(tr("当前记忆项目", "Current memory project"))}" disabled><option value="current" selected>${esc(current)}${total == null ? "" : ` · ${esc(total)}`}</option></select>${button("new-memory", tr("新建 / 演进记忆", "New / evolve memory"), { icon: "plus", small: true, disabled: !ready })}</div><div class="hub-memory-toolbar">${button("consolidate-memory", tr(" 一键再记忆整理", " Consolidate memories"), { small: true, disabled: !ready, attrs: `title="${esc(!ready ? tr("请先确认当前项目", "Confirm the current project first") : tr("合并重复经验，整理过时记忆", "Merge duplicates and outdated memories"))}"` })}<span class="hub-hint">${esc(tr("去重 · 演进 · 保留历史", "Deduplicate · Evolve · Keep history"))}</span></div>${prompt}`;
 if (errors.overview) node.insertAdjacentHTML("beforeend", inlineError(errors.overview));
    }
    function memoryRecords() { return items(cache.memory, ["items", "memories", "results"]); }
    function memoryId(item) { return String(item.id ?? item.key ?? item.path ?? ""); }
    function memoryBody(item) { return item.content ?? item.body ?? item.markdown ?? item.text ?? ""; }
    function memoryDraftKey(id) { return `${selectedMemoryRoot() || "unconfirmed"}\u0000${id}`; }
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
 const node = root.querySelector("#t3-hub-memory-list");
 if (!memoryProjectReady()) {
 root.querySelector("#t3-hub-memory-total").textContent = "";
 root.querySelector("#t3-hub-memory-filters").innerHTML = "";
 node.innerHTML = empty(tr("请先确认当前项目", "Confirm the current project first"), tr("为了避免不同项目的记忆混在一起，请在 T3 中打开一个项目并等待连接确认。", "To keep project memories separate, open a project in T3 and wait for its context to be confirmed."), "folder");
 return;
 }
 const records = memoryRecords();
 const project = selectedMemoryProject();
 const moduleCounts = cache.memory?.moduleCounts || cache.memory?.counts || project?.byModule || {};
 const total = cache.memory?.total ?? project?.total ?? records.length;
 root.querySelector("#t3-hub-memory-total").textContent = tr(`${total} 条记忆`, `${total} memories`);
 root.querySelector("#t3-hub-memory-filters").innerHTML = moduleOptions().map(([key, label, emoji]) => {
 const count = key === "all" ? total : moduleCounts[key];
 return `<button type="button" class="hub-pill ${state.memoryModule === key ? "is-active" : ""}" data-action="memory-module" data-module="${key}" aria-pressed="${state.memoryModule === key}">${emoji ? `${emoji} ` : ""}${esc(label)}${count == null ? "" : `<span class="hub-pill-count">${count}</span>`}</button>`;
 }).join("");
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
 if (!memoryWriteReady()) return;
 const payload = memoryPayload(), selection = memorySelection();
 if (!payload.projectRoot) return;
 drafts.__new = { ...(drafts.__new || { module: state.memoryModule === "all" ? "topics" : state.memoryModule }), open: true };
 if (!drafts.__new.projectRoot && drafts.__new.migratedFromGlobal) { drafts.__new.projectRoot = payload.projectRoot; delete drafts.__new.migratedFromGlobal; }
 if (drafts.__new.projectRoot !== payload.projectRoot) drafts.__new = { open: true, projectRoot: payload.projectRoot, module: state.memoryModule === "all" ? "topics" : state.memoryModule };
 if (!["project", "worktree"].includes(drafts.__new.scope)) drafts.__new.scope = state.memoryScope === "worktree" ? "worktree" : "project";
 state.supersedeLoading = true;
 state.supersedeItems = [];
 renderNewMemory();
 root.querySelector('[name="new-memory-title"]')?.focus();
 try {
 const data = await request("memory:list", { ...payload, module: undefined, query: "", limit: 500 });
 const current = memoryPayload();
 if (disposed || selection !== memorySelection() || current.projectRoot !== payload.projectRoot) return;
 state.supersedeItems = items(data, ["items", "memories", "results"]);
 } catch (error) { if (!disposed) toast(errorText(error), true); }
 finally {
 const current = memoryPayload();
 if (!disposed && selection === memorySelection() && current.projectRoot === payload.projectRoot) {
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
 if (!draft?.open || !memoryProjectReady()) { node.innerHTML = ""; return; }
 const projectRoot = selectedMemoryRoot();
 if (draft.projectRoot !== projectRoot) {
  if (!draft.projectRoot && draft.migratedFromGlobal) { draft.projectRoot = projectRoot; delete draft.migratedFromGlobal; }
  else { node.innerHTML = ""; return; }
 }
 if (!["project", "worktree"].includes(draft.scope)) draft.scope = state.memoryScope === "worktree" ? "worktree" : "project";
 node.innerHTML = `<div class="hub-new-memory"><div class="hub-section-heading">${esc(tr("记录一条可复用的经验", "Write something worth remembering"))}</div><label class="hub-field">${esc(tr("标题", "Title"))}<input class="hub-input" name="new-memory-title" value="${esc(draft.title || "")}" placeholder="${esc(tr("一句话说清这条记忆", "A short, clear title"))}"></label><label class="hub-field">${esc(tr("保存范围", "Save scope"))}<select class="hub-select" name="new-memory-scope">${[["project", tr("本项目共享", "Shared in this project")], ["worktree", tr("当前工作树便签", "Current worktree note")]].map(([scope, label]) => `<option value="${scope}" ${draft.scope === scope ? "selected" : ""}>${esc(label)}</option>`).join("")}</select></label><label class="hub-field">${esc(tr("模块", "Module"))}<select class="hub-select" name="new-memory-module">${moduleOptions().filter(([key]) => key !== "all").map(([key, label, emoji]) => `<option value="${key}" ${draft.module === key ? "selected" : ""}>${emoji} ${esc(label)}</option>`).join("")}</select></label><label class="hub-field">${esc(tr("覆盖旧记忆 (Supersede) · 可选", "Supersede an existing memory · optional"))}<select class="hub-select" name="new-memory-supersedes" ${state.supersedeLoading ? "disabled" : ""}>${supersedeOptions()}</select></label><textarea class="hub-editor" name="new-memory-content" spellcheck="false" aria-label="${esc(tr("新记忆内容", "New memory content"))}" placeholder="${esc(tr("写下背景、结论与验证过的经验…", "Context, conclusions, and verified lessons…"))}">${esc(draft.content || "")}</textarea><div class="hub-editor-actions">${button("create-memory", tr("保存记忆", "Save memory"), { primary: true, icon: "save" })}${button("cancel-new-memory", tr("取消", "Cancel"))}</div></div>`;
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
 const blocked = state.agentsTarget === "project" && !projectContextReady();
 content.innerHTML = `${button("back-to-settings", tr("返回宿主设置", "Back to settings"), { small: true })}<div class="hub-section-heading"><span>${esc(tr("把协作方式写下来", "Make your preferences explicit"))}</span></div><p class="hub-description">${esc(tr("规则轻一点，记忆深一点。让每个助手都懂你的习惯。", "Keep rules lean and memory deep. Help every assistant work your way."))}</p><div class="hub-agents-targets">${[["global", "globe", tr("全局 AGENTS.md", "Global AGENTS.md"), tr("写入已发现宿主的托管区块", "Sync managed blocks to discovered hosts")], ["project", "folder", tr("当前项目 AGENTS.md", "Project AGENTS.md"), state.projectRoot ? tr("仅应用于当前项目", "Applies to the current project") : projectTitle()]].map(([target, name, label, hint]) => `<button type="button" class="hub-agents-target ${state.agentsTarget === target ? "is-active" : ""}" data-action="agents-target" data-target="${target}" aria-pressed="${state.agentsTarget === target}" ${target === "project" && projectDisabled() ? `disabled title="${esc(projectTitle())}"` : ""}>${icon(name, 16)}<span><strong>${esc(label)}</strong><small>${esc(hint)}</small></span><span class="hub-radio"></span></button>`).join("")}</div>${state.agentsTarget === "project" && !blocked && cache.agents ? `<p class="hub-hint">${esc(cache.agents.projectExists ? tr("项目 AGENTS.md 已存在；Codex / Pi 按各自规则发现文件，AGY / Muse 当前会话加载状态未知。", "Project AGENTS.md exists; loading depends on each host.") : tr("项目尚无 AGENTS.md，编辑后保存即可创建。", "No project AGENTS.md; save to create it."))} ${esc(cache.agents.projectClaudeReference ? tr("Claude 规则含引用，当前会话是否加载未知。", "Claude rules contain a reference; session loading is unknown.") : tr("Claude 尚未发现引用。", "No Claude reference found."))}</p>${!cache.agents.projectClaudeReference ? button("sync-project-rule-reference", tr("为 Claude 添加项目规则引用", "Add Claude project rule reference"), { small: true, disabled: !cache.agents.projectExists }) : ""}` : ""}${blocked ? empty(projectTitle(), "", "folder") : errors.agents ? inlineError(errors.agents) : !draft ? loading() : `${state.agentsTarget === "project" ? button("inject-soft-route", tr("注入记忆库软路由模板", "Insert memory routing template"), { icon: "spark", attrs: 'title="AGENTS.md"' }) : ""}<div class="hub-token-bar"><strong>AGENTS.md</strong><span id="t3-hub-token-count" class="hub-token"></span></div><p id="t3-hub-token-warning" class="hub-token-warning" hidden>${esc(tr("建议把详细知识放进记忆库，AGENTS.md 保留简洁入口。", "Move detailed knowledge into memory; keep AGENTS.md a lean entry point."))}</p><textarea class="hub-editor hub-agents-editor" name="agents-content" spellcheck="false" aria-label="AGENTS.md Markdown" placeholder="${esc(tr("写下你希望所有助手遵守的协作规则…", "How would you like your assistants to work?"))}">${esc(draft.content)}</textarea><div class="hub-agents-save"><span id="t3-hub-agents-dirty" class="hub-saved-hint"></span>${button("save-agents", tr("保存并同步", "Save & sync"), { primary: true, icon: "save" })}</div><div id="t3-hub-sync-badges" class="hub-sync-badges"></div><div class="hub-hint" style="margin-top:11px">${icon("info", 12)}${esc(tr("Tab 缩进 · ⌘S / Ctrl+S 保存", "Tab to indent · ⌘S / Ctrl+S to save"))}</div>`}`;
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
 const title = /^(会话关系|Session relationships|之前的智能体|Previous agents)$/i;
 const seen = new Set();
 for (const scope of [...scopes, document.body].filter(Boolean)) {
 const scopedInspector = scope !== document.body;
 for (const label of scope.querySelectorAll('h2,h3,h4,[role="heading"],span,p,div,button')) {
 if (seen.has(label)) continue;
 seen.add(label);
 if (label.closest(excluded) || !title.test(label.textContent.trim()) || [...label.children].some((child) => title.test(child.textContent.trim()))) continue;
 const rect = label.getBoundingClientRect();
 if (!label.getClientRects().length || rect.width <= 0 ||
 (scopedInspector ? rect.right <= innerWidth * .3 : rect.left < innerWidth * .5) ||
 getComputedStyle(label).visibility === "hidden") continue;
 let section = label;
 for (let card = label.parentElement, depth = 0; card && card !== document.body && depth < 12; card = card.parentElement, depth++) {
 if (card.closest(excluded)) break;
 const box = card.getBoundingClientRect(), css = getComputedStyle(card);
 const rounded = parseFloat(css.borderRadius || css.borderTopLeftRadius) >= 8;
 const bordered = (parseFloat(css.borderTopWidth) > 0 && css.borderTopStyle !== "none") || (css.boxShadow && css.boxShadow !== "none") || parseFloat(css.outlineWidth) > 0;
 const maxWidth = scopedInspector ? innerWidth : innerWidth * .55;
 if (rounded && bordered && box.width >= 160 && box.width < maxWidth && box.right > innerWidth * .75) return { card, section };
 section = card;
 }
 }
 }
 return null;
    }
    function findConversationTitleAnchor() {
 const expected = String(state.context?.threadTitle || state.context?.title || state.context?.thread?.title || "").trim();
 const selectors = '[data-testid*="thread-title" i],[data-testid*="conversation-title" i],[data-testid*="chat-title" i],[data-slot*="thread-title" i],[data-slot*="conversation-title" i],[aria-label*="Thread actions" i] :is(h1,h2,[role="heading"]),[data-testid*="thread-actions" i] :is(h1,h2,[role="heading"]),main header h1,main header h2,main header [role="heading"],main h1,main h2,main [role="heading"],header h1,header h2';
 const candidates = [...document.querySelectorAll(selectors)].filter((element) => {
 const text = String(element.textContent || "").trim(), rect = element.getBoundingClientRect();
 return text && text.length < 240 && rect.width > 0 && rect.top >= 0 && rect.top < 180 &&
 !element.closest('#t3-sidecar-hub-root,[role="log"],[data-message-id],[data-message-role],[data-testid="chat-message"],[data-slot="message"],aside') && getComputedStyle(element).visibility !== "hidden";
 });
 if (expected) {
 const exact = candidates.find((element) => String(element.textContent || "").trim() === expected);
 if (exact) return exact;
 }
 return candidates.sort((a, b) => {
 const aSpecific = /thread-title|conversation-title|chat-title/.test(`${a.getAttribute?.("data-testid") || ""} ${a.getAttribute?.("data-slot") || ""}`) ? 0 : 1;
 const bSpecific = /thread-title|conversation-title|chat-title/.test(`${b.getAttribute?.("data-testid") || ""} ${b.getAttribute?.("data-slot") || ""}`) ? 0 : 1;
 return aSpecific - bSpecific || a.getBoundingClientRect().top - b.getBoundingClientRect().top;
 })[0] || null;
    }
    function placePlanHandle() {
 if (!titleControls || !planHandle || disposed) return false;
 const title = findConversationTitleAnchor();
 if (!title) { titleControls.hidden = true; planHandle.hidden = true; liveBoard.hidden = true; return false; }
 const anchor = title.closest("button,[role=button]") || title;
 if (titleControls.parentElement !== anchor.parentElement || titleControls.previousElementSibling !== anchor) anchor.after(titleControls);
 titleControls.hidden = false;
 Object.assign(titleControls.style, { position: "relative", inset: "auto", display: "inline-flex", alignItems: "center", verticalAlign: "middle", margin: "0 0 0 8px", width: "auto", minWidth: "0", height: "27px", zIndex: "1", WebkitAppRegion: "no-drag" });
 Object.assign(planHandle.style, { position: "relative", inset: "auto", display: "inline-flex", alignItems: "center", justifyContent: "flex-start", verticalAlign: "middle", margin: "0", width: "auto", minWidth: "0", height: "27px", padding: "4px 10px", borderRadius: "999px", cursor: "pointer", zIndex: "1", WebkitAppRegion: "no-drag" });
 return true;
    }
    function positionConversationTools() {
 if (!root || !liveBoard || disposed) return;
 const anchored = placePlanHandle();
 const board = boardData(), available = (state.connected || remotePlanContextReady()) && !boardProblem() && hasActualPlan(board) && !boardMismatch();
 if (planHandle) {
 planHandle.hidden = !anchored || !available;
 planHandle.setAttribute("aria-haspopup", "true");
 planHandle.setAttribute("aria-controls", "t3-hub-live-board");
 planHandle.setAttribute("aria-expanded", String(!!state.planOpen));
 }
 const show = anchored && available && state.planOpen && !state.open && !root.classList.contains("is-occluded");
 liveBoard.hidden = !show;
 if (show) {
 const anchor = planHandle.getBoundingClientRect(), width = Math.min(360, Math.max(240, innerWidth - 24));
 const left = Math.max(8, Math.min(innerWidth - width - 8, anchor.right - width));
 const estimatedHeight = Math.min(360, Math.max(120, liveBoard.scrollHeight || 240));
 const top = anchor.bottom + estimatedHeight + 12 <= innerHeight ? anchor.bottom + 8 : Math.max(8, anchor.top - estimatedHeight - 8);
 Object.assign(liveBoard.style, { left: `${left}px`, width: `${width}px`, top: `${top}px`, maxHeight: `${Math.max(100, innerHeight - top - 8)}px` });
 }
    }
    function boardMismatch() {
 const remoteEnv = remotePlanEnvironmentId();
 if (cache.board?.remote === true) {
 const currentThread = currentThreadId();
 return !remoteEnv || String(cache.board.environmentId || "").toLowerCase() !== remoteEnv.toLowerCase() || String(cache.board.threadId || "") !== currentThread || String(state.threadId || "") !== currentThread;
 }
 const route = routeHint(), prefixed = /^\/?_t3_env_(?:\/|[?#]|$)/i.test(route);
 const explicitPair = route.match(/^\/?_t3_env_\/([^/?#]+)\/([^/?#]+)(?:[/?#]|$)/i);
 if (prefixed && (!explicitPair || /\/\//.test(route.replace(/[?#].*$/, "")))) return true;
 if (state.threadId === "__NEW__") {
 const match = route.match(new RegExp(`^/?(?:_t3_env_/)?(?:projects?|workspaces?)/(${UUID_RE})/(?:new|draft)(?:[/?#]|$)`, "i"));
 const projectId = match?.[1];
 return !projectId || state.context?.draftProjectVerified !== true || state.context?.threadId !== "__NEW__" ||
 String(state.context?.projectId || "").toLowerCase() !== projectId.toLowerCase() || !state.projectRoot || state.context?.projectRoot !== state.projectRoot;
 }
 const rawPair = !explicitPair && route.match(/^\/?([^/?#]+)\/([^/?#]+)(?:[/?#]|$)/);
 const candidate = explicitPair || rawPair;
 let routeEnvId = candidate?.[1], routeThreadId = candidate?.[2];
 try { if (candidate) { routeEnvId = decodeURIComponent(routeEnvId); routeThreadId = decodeURIComponent(routeThreadId); } } catch { return true; }
 const pair = candidate && !/^(?:projects?|workspaces?)$/i.test(routeEnvId) && (explicitPair || !/^(?:threads|_chat)$/i.test(routeEnvId)) ? candidate : null;
 if (pair && (String(state.context?.environmentId || "").toLowerCase() !== routeEnvId.toLowerCase() || String(state.threadId || "") !== routeThreadId || !state.projectRoot || state.context?.projectRoot !== state.projectRoot)) return true;
 const contextId = state.context?.threadId || state.context?.thread?.id;
 if (!pair && currentThreadId() !== (state.threadId || "__NEW__")) return true;
 return !!(contextId && state.threadId && String(contextId) !== String(state.threadId));
    }
    function projectContextReady() {
 return Boolean(state.connected && !contextLoading && state.projectRoot && state.context?.threadId && state.context?.projectRoot === state.projectRoot && routeKey() === lastRoute && !boardMismatch());
    }
    function projectWriteReady(scope = "project") {
 if (scope !== "project" || projectContextReady()) return true;
 toast(tr("请先确认当前项目，等待连接完成后重试", "Wait for the current project to connect and retry"), true);
 return false;
    }
    function memoryWriteReady(scope = "project") {
 if (!["project", "worktree"].includes(scope)) {
  toast(tr("记忆只支持当前项目范围", "Memory is limited to the current project"), true);
  return false;
 }
 return memoryProjectReady() || projectWriteReady("project");
    }
    function boardProblem() {
 if (cache.board?.remote === true) {
 if (boardMismatch()) return tr("会话未匹配", "Session mismatch");
 if (errors.board) return tr("远程计划暂不可用", "Remote plan unavailable");
 return "";
 }
 if (contextLoading) return tr("读取中", "Loading");
 if (!state.connected) return /无法确认(?:新)?会话所属项目/.test(state.contextError) ? tr("未确认所属项目", "Project not identified") : state.contextError ? tr("连接失败", "Connection failed") : tr("读取中", "Loading");
 if (boardMismatch()) return tr("会话未匹配", "Session mismatch");
 if (errors.board?.code === "board_thread_mismatch") return tr("会话未匹配", "Session mismatch");
 if (errors.board) return tr("读取失败，请刷新", "Read failed; refresh");
 if (cache.board?.planReadError === "too_large") return tr("计划文件过大，暂无法显示", "Plan file is too large to display");
 if (cache.board?.planReadError === "unsafe_path") return tr("计划路径无法安全确认", "Plan path cannot be verified safely");
 if (cache.board?.planReadError) return tr("计划读取失败", "Could not read the plan");
 return cache.board ? "" : tr("读取中", "Loading");
    }
    function boardStatus() {
 const problem = boardProblem();
 if (problem) return problem;
 const board = boardData(), progress = board.progress;
 if (progress.total) return `${progress.completed}/${progress.total} ${tr("完成", "complete")}`;
 if (board.planMarkdown) return tr("计划文档", "Plan document");
 return tr("暂无计划", "No plan");
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
    function planStepProgress(board = boardData()) {
 const steps = Array.isArray(board.steps) ? board.steps : [];
 const total = Math.max(0, Number(board.progress?.total) || steps.length || 0);
 if (!total) return { current: 0, total: 0, completed: 0, done: false, percent: 0, label: tr("查看计划", "View plan") };
 const completed = Math.max(0, Number(board.progress?.completed) || 0);
 const activeIndex = steps.findIndex((step) => step.status === "in-progress");
 const pendingIndex = steps.findIndex((step) => step.status !== "completed" && step.status !== "in-progress");
 const done = steps.length ? steps.length >= total && steps.slice(0, total).every((step) => step.status === "completed") : completed >= total;
 const candidate = activeIndex >= 0 ? activeIndex + 1 : pendingIndex >= 0 ? pendingIndex + 1 : done ? total : completed + 1;
 const current = Math.min(total, Math.max(1, candidate));
 return { current, total, completed, done, percent: done ? 100 : Math.round(current / total * 100), label: done ? tr(`第 ${total} / ${total} 步 · 已完成`, `Step ${total} of ${total} · complete`) : tr(`第 ${current} / ${total} 步`, `Step ${current} of ${total}`) };
    }
    function activePlanRouteIdentity() {
 const source = String(routeHint() || "");
 const path = (source.includes("#") ? source.slice(source.lastIndexOf("#") + 1) : source).split(/[?#]/, 1)[0];
 let environmentId = "", routeThreadId = "", explicitEnvironment = false;
 let match = path.match(/^\/?_t3_env_\/([^/?#]+)\/([^/?#]+)(?:[/?#]|$)/i);
 if (match) { environmentId = match[1]; routeThreadId = match[2]; explicitEnvironment = true; }
 else {
 match = path.match(/^\/?([^/?#]+)\/([^/?#]+)(?:[/?#]|$)/);
 if (match && new RegExp(`^${UUID_RE}$`, "i").test(match[1])) { environmentId = match[1]; routeThreadId = match[2]; }
 }
 try { if (environmentId) environmentId = decodeURIComponent(environmentId); if (routeThreadId) routeThreadId = decodeURIComponent(routeThreadId); } catch { return { environmentId: "", threadId: "" }; }
 const threadId = currentThreadId();
 if (!environmentId || !routeThreadId || routeThreadId !== threadId || !explicitEnvironment && !new RegExp(`^${UUID_RE}$`, "i").test(environmentId)) return { environmentId: "", threadId };
 return { environmentId, threadId, explicitEnvironment };
    }
    function remotePlanProject(environmentId, threadId) {
 if (!environmentId || !threadId || typeof window.__t3HudRemoteProject !== "function") return null;
 try {
  const project = window.__t3HudRemoteProject({ environmentId, threadId });
  const projectRoot = project?.projectRoot;
  const absolute = typeof projectRoot === "string" && (/^\//.test(projectRoot) || /^[A-Za-z]:[\\/]/.test(projectRoot));
  const safe = absolute && projectRoot.trim() === projectRoot && !/[\u0000-\u001f\u007f]/.test(projectRoot) && !projectRoot.split(/[\\/]+/).includes("..");
  if (project?.environmentId !== environmentId || project?.threadId !== threadId || !safe) return null;
  return { environmentId, threadId, projectRoot };
 } catch { return null; }
    }
    function isRemotePlanContext() {
 return state.context?.remote === true || state.context?.isRemote === true || state.context?.environment?.remote === true;
    }
    function verifiedLocalPlanContext({ environmentId, threadId } = activePlanRouteIdentity()) {
 const context = state.context, localEnvironmentId = context?.environmentId || context?.environment?.id;
 return !!(state.connected && !contextLoading && !isRemotePlanContext() && environmentId &&
 String(localEnvironmentId || "").toLowerCase() === environmentId.toLowerCase() &&
 threadId === state.threadId && threadId === (context?.threadId || context?.thread?.id) &&
 state.projectRoot && state.projectRoot === context?.projectRoot);
    }
    function remotePlanEnvironmentId() {
 if (!state.threadId || state.threadId === "__NEW__") return "";
 const routeIdentity = activePlanRouteIdentity(), environmentId = routeIdentity.environmentId;
 if (!environmentId || routeIdentity.threadId !== String(state.threadId)) return "";
 // The native renderer can resolve a project's path on both local and Connect routes.
 // The local Hub context verifies its environment against the local state store.
 if (verifiedLocalPlanContext(routeIdentity)) return "";
 const explicitRemote = isRemotePlanContext();
 if (contextLoading && !explicitRemote) return "";
 if (remotePlanProject(environmentId, routeIdentity.threadId)) return environmentId;
 if (explicitRemote || !state.context && !!state.contextError) return environmentId;
 return "";
    }
    function remotePlanContextReady() {
 const environmentId = remotePlanEnvironmentId(), board = cache.board;
 return !!environmentId && board?.remote === true && String(board.environmentId || "").toLowerCase() === environmentId.toLowerCase() && String(board.threadId || "") === currentThreadId();
    }
    function normalizeRemoteThreadPlan(projection, environmentId, threadId) {
 if (String(projection?.thread?.id || "") !== threadId) throw new Error("remote thread mismatch");
 const plans = Array.isArray(projection.plans) ? projection.plans : [];
 const turns = [...items(projection, ["turnItems"]), ...items(projection, ["visibleTurnItems"])].map((turn) => turn?.item && typeof turn.item === "object" ? turn.item : turn);
 const matches = [];
 for (const plan of plans) {
 const kind = String(plan?.kind || plan?.type || "");
 if (String(plan?.threadId || "") !== threadId || String(plan?.status || "").toLowerCase() === "superseded" || !["todo_list", "proposed_plan"].includes(kind)) continue;
 const planId = String(plan.id || plan.planId || "");
 if (!kind || !planId) continue;
 const update = turns.filter((turn) => {
 const turnThreadId = String(turn?.threadId || turn?.thread?.id || projection.thread.id || "");
 return turnThreadId === threadId && String(turn?.type || turn?.kind || "") === kind && String(turn?.planId || turn?.payload?.planId || "") === planId;
 }).sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))[0];
 if (update) matches.push({ plan, updatedAt: update.updatedAt || plan.updatedAt || "" });
 }
 matches.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
 const latest = matches[0]?.plan;
 const rawSteps = Array.isArray(latest?.steps) ? latest.steps : [];
 const steps = rawSteps.map((step, index) => {
 const rawStatus = String(typeof step === "object" ? step.status || step.state || "pending" : "pending").toLowerCase().replace(/_/g, "-");
 const status = ["completed", "done", "success", "succeeded"].includes(rawStatus) ? "completed" : ["running", "active", "started", "in-progress"].includes(rawStatus) ? "in-progress" : "pending";
 return { id: typeof step === "object" ? String(step.id ?? index) : String(index), text: String(typeof step === "string" ? step : step?.text || step?.title || step?.content || step?.step || ""), status };
 });
 return { remote: true, environmentId, threadId, source: "t3-connect", planStatus: latest?.status || "", planMarkdown: typeof latest?.markdown === "string" ? latest.markdown : "", steps, updatedAt: matches[0]?.updatedAt || "", subagents: [], artifacts: [] };
    }
    async function planMirrorRelativePath(threadId) {
 let key = String(threadId || "");
 if (new RegExp(`^${UUID_RE}$`, "i").test(key)) key = key.toLowerCase();
 else {
 const cryptoApi = window.crypto?.subtle ? window.crypto : globalThis.crypto;
 if (!cryptoApi?.subtle || typeof TextEncoder !== "function") throw new Error("remote plan unavailable");
 const bytes = new Uint8Array(await cryptoApi.subtle.digest("SHA-256", new TextEncoder().encode(`t3-hub-plan-mirror-v1\0${key}`)));
 const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("").slice(0, 32).split("");
 hex[12] = "5";
 hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
 const compact = hex.join("");
 key = `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
 }
 return `.t3-hub/plans/${key}.json`;
    }
    function normalizeRemotePlanMirror(contents, environmentId, threadId, projectRoot) {
 if (typeof contents !== "string" || !contents.trim()) return null;
 if (contents.length > 262144) throw new Error("remote plan unavailable");
 let mirror;
 try { mirror = JSON.parse(contents); } catch { throw new Error("remote plan unavailable"); }
 const isClear = mirror?.cleared === true, isUnavailable = mirror?.unavailable === true;
 if (mirror?.schemaVersion !== 1 || String(mirror.threadId || "") !== threadId || typeof projectRoot !== "string" || mirror.projectRoot !== projectRoot || !Array.isArray(mirror.steps) || !Number.isFinite(Date.parse(mirror.updatedAt || "")) ||
  isClear && (isUnavailable || mirror.source !== "hub-clear") || isUnavailable && mirror.source !== "hub-unavailable" || !isClear && !isUnavailable && mirror.source !== "hub-mcp") throw new Error("remote plan unavailable");
 const steps = isClear || isUnavailable ? [] : mirror.steps.slice(0, 300).map((step, index) => {
 const rawStatus = String(step?.status || "pending").toLowerCase().replace(/_/g, "-");
 const status = ["completed", "done", "success", "succeeded"].includes(rawStatus) ? "completed" : ["running", "active", "started", "in-progress"].includes(rawStatus) ? "in-progress" : "pending";
 return { id: String(step?.id ?? index).slice(0, 120), text: String(step?.text || "").slice(0, 2000), status };
 });
 return { remote: true, environmentId, threadId, source: isUnavailable ? "hub-mirror-unavailable" : "hub-mirror", planStatus: "active", planMarkdown: "", steps, updatedAt: mirror.updatedAt, cleared: isClear, unavailable: isUnavailable, subagents: [], artifacts: [] };
    }
    function newestRemotePlan(nativePlan, mirroredPlan) {
 if (!mirroredPlan) return nativePlan;
 if (!nativePlan) return mirroredPlan;
 const nativeUpdated = Date.parse(nativePlan.updatedAt || "") || 0, mirrorUpdated = Date.parse(mirroredPlan.updatedAt || "") || 0;
 return mirrorUpdated > nativeUpdated || mirrorUpdated === nativeUpdated && (mirroredPlan.cleared || mirroredPlan.unavailable) ? mirroredPlan : nativePlan;
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
    function planSourceSummary(board) {
 return `${tr("最近计划", "Most recent plan")}${board.planStatus === "completed" ? ` · ${tr("已完成", "Completed")}` : ""} · ${boardSourceLabel(board.source)}${isManualBoard(board) ? "" : ` · ${tr("只读", "Read only")}`}`;
    }
    function hasActualPlan(board = boardData()) { return board.steps.length > 0 || !!String(board.planMarkdown || "").trim(); }
    function isManualBoard(board = boardData()) { return /^(hub|hub-mcp)$/i.test(String(board.source || "")); }
    function artifactIdentity(artifact) {
 const value = typeof artifact === "string" ? artifact : artifact?.path || artifact?.id || artifact?.name;
 return typeof value === "string" ? value : "";
    }
    function boardStepIdentity(step) { return { id: String(step.id ?? ""), text: String(step.text ?? ""), status: String(step.status ?? "") }; }
    function rememberBoardView(surface) {
 const board = boardData(), scopeRoute = boardScopeRoute();
 // A rendered, verified project also anchors redundant projectRoot queries.
 if (scopeAnchor && !scopeAnchor.r && state.projectRoot && !boardMismatch()) scopeAnchor.r = String(state.projectRoot).replace(/\/+$/, "");
 lastBoardRoute = scopeRoute;
 boardViewSnapshots.set(surface, { projectRoot: state.projectRoot || "", threadId: state.threadId || "", route: scopeRoute, source: String(board.source || ""), planRevision: board.planRevision, updatedAt: board.updatedAt, steps: board.steps.map(boardStepIdentity), artifacts: board.artifacts.map(artifactIdentity) });
    }
    function sameBoardViewScope(view) {
 return view && view.projectRoot === (state.projectRoot || "") && view.threadId === (state.threadId || "") && view.route === boardScopeRoute();
    }
    function boardEditorActive() {
 return content.contains(document.activeElement) && !document.activeElement?.matches?.("button,[role=button]");
    }
    function preserveBoardEditorOnReadError() {
 if (!boardProblem() || boardMismatch() || errors.board?.code === "board_thread_mismatch" || !sameBoardViewScope(boardViewSnapshots.get(content))) return false;
 const input = content.querySelector('[name="board-step-draft"]');
 if (!boardEditorActive() && !(input && (input.value || state.boardDraft))) return false;
 boardRenderedSignature = "";
 boardTabRenderPending = true;
 toast(tr("读取失败，已保留草稿，等待自动同步或手动刷新重试", "Read failed; draft preserved. Waiting for automatic sync or a manual refresh."), true);
 return true;
    }
    function flushBoardRender() {
 if (!disposed && state.open && state.tab === "board" && boardTabRenderPending && !boardEditorActive()) renderBoardTab({ preserveDraftEditor: true });
    }
    function resolveBoardClick(target, type) {
 const surface = liveBoard?.contains(target) ? liveBoard : content?.contains(target) ? content : null;
 const view = surface && boardViewSnapshots.get(surface);
 const index = Number(target.dataset.index), board = boardData();
 if (!view || !Number.isInteger(index) || index < 0 || view.projectRoot !== (state.projectRoot || "") || view.threadId !== (state.threadId || "") || view.route !== boardScopeRoute() || boardProblem()) return null;
 if (type === "step") {
 const shown = view.steps[index], current = board.steps.map(boardStepIdentity);
 if (!shown || !shown.id || target.dataset.stepId !== shown.id || target.dataset.stepText !== shown.text || !isManualBoard(board) || view.source !== String(board.source || "")) return null;
 const oldMatches = view.steps.filter((step) => step.id === shown.id);
 const newMatches = current.map((step, position) => ({ step, position })).filter(({ step }) => step.id === shown.id);
 if (oldMatches.length !== 1 || newMatches.length !== 1) return null;
 const match = newMatches[0];
 if (match.step.text !== shown.text || match.step.status !== shown.status) return null;
 if (/^(?:step[-_])?\d+$/i.test(shown.id) && (JSON.stringify(view.steps) !== JSON.stringify(current) || view.steps.filter((step) => step.text === shown.text && step.status === shown.status).length !== 1)) return null;
 return match.position;
 }
 const shown = view.artifacts[index];
 if (!shown || target.dataset.artifactPath !== shown || view.artifacts.filter((path) => path === shown).length !== 1) return null;
 const matches = board.artifacts.map(artifactIdentity).map((path, position) => ({ path, position })).filter((item) => item.path === shown);
 return matches.length === 1 ? matches[0].position : null;
    }
    function rejectStaleBoardClick() {
 boardRenderedSignature = "";
 boardTabRenderPending = true;
 boardEditorNeedsSync = true;
 toast(tr("计划或产物已变化，请刷新后重试", "The plan or artifact changed; refresh and try again"), true);
 pollBoard();
    }
    function runCategory(run) {
 const raw = String(run.rawStatus || "").trim().toLowerCase().replace(/[- ]/g, "_");
 if (["completed", "succeeded", "success", "done"].includes(raw)) return "completed";
 if (["failed", "failure", "error"].includes(raw)) return "failed";
 if (["cancelled", "canceled", "aborted"].includes(raw)) return "cancelled";
 if (["running", "in_progress", "started", "working"].includes(raw)) return "running";
 if (["pending", "waiting", "queued", "requested"].includes(raw)) return "waiting";
 return "unknown";
    }
    function subagentSummary(board, full = false) {
 if (!board.subagents.length) return "";
 const labels = { completed: tr("已完成", "Completed"), failed: tr("失败", "Failed"), running: tr("进行中", "Running"), waiting: tr("等待", "Waiting"), cancelled: tr("已取消", "Cancelled"), unknown: tr("状态未知", "Unknown") };
 const counts = Object.fromEntries(Object.keys(labels).map((key) => [key, 0]));
 for (const run of board.subagents) counts[runCategory(run)]++;
 const summary = Object.entries(counts).filter(([, n]) => n).map(([key, n]) => `${labels[key]} ${n}`).join(" · ");
 const sorted = [...board.subagents].sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")));
 const shown = full ? sorted : sorted.slice(0, 3);
 return `<div class="hub-board-section"><span>${esc(tr("本会话子任务", "Subtasks in this conversation"))} · ${board.subagents.length}</span></div><p class="hub-hint">${esc(summary)}</p><ol class="hub-board-steps">${shown.map((run) => `<li class="hub-board-step"><span class="hub-step-text">${esc(String(run.title || run.name || run.model || tr("子任务", "Subtask")).slice(0, 180))}</span><span class="hub-badge">${esc(labels[runCategory(run)])}</span></li>`).join("")}</ol>${!full && board.subagents.length > shown.length ? `<p class="hub-hint">${esc(tr("在 Hub 查看全部子任务", "Open Hub to see all subtasks"))}</p>` : ""}`;
    }
    function boardMarkup(manual = false, compact = false) {
 const board = boardData();
 manual = manual && isManualBoard(board);
 const artifactButtons = board.artifacts.map((artifact, index) => {
 const file = typeof artifact === "string" ? artifact : artifact.name || artifact.title || artifact.path || artifact.id;
 const name = String(file || "document.md").split(/[\\/]/).pop();
 const label = compact ? `${tr("在 Finder 中显示", "Show in Finder")} · ${name}` : name;
 return `<button type="button" class="${compact ? "hub-artifact-card" : "hub-artifact-chip"}" data-action="read-artifact" data-index="${index}" data-artifact-path="${escIdentity(artifactIdentity(artifact))}" title="${esc(label)}" aria-label="${esc(label)}">${compact ? `<span class="hub-artifact-icon">${icon("file", 16)}</span><span class="hub-artifact-name">${esc(name)}</span>` : `${icon("edit", 11)} ${esc(name)}`}</button>`;
 }).join("");
 const markdown = String(board.planMarkdown || "").trim();
 const markdownLimit = compact ? 1800 : 40000;
 const markdownHtml = markdown && !board.steps.length ? `<p class="hub-hint">${esc(tr("计划原文 · 暂无可计算的步骤进度", "Plan text · no countable step progress"))}</p><div class="hub-board-background">${esc(markdown.slice(0, markdownLimit))}${markdown.length > markdownLimit ? esc(tr("\n…内容较长，打开完整计划查看更多", "\n…Open the full plan to see more")) : ""}</div>` : "";
 const hasPlan = hasActualPlan(board);
 return `${compact || !hasPlan ? "" : `<div class="hub-board-heading"><strong>${esc(tr("计划", "Plan"))}</strong><span class="hub-badge">${esc(boardSourceLabel(board.source))}${manual ? "" : ` · ${esc(tr("只读", "Read only"))}`}</span></div>`}${!compact && board.background ? `<button type="button" class="hub-pill" data-action="board-background" aria-expanded="${state.boardBackground}">≣ ${esc(tr("背景", "Background"))}</button><div class="hub-board-background" ${state.boardBackground ? "" : "hidden"}>${esc(typeof board.background === "string" ? board.background : board.background.text || board.background.content || "")}</div>` : ""}${compact || !board.steps.length ? "" : `<div class="hub-board-section"><span>${esc(tr("进度", "Progress"))}</span><b>${board.progress.completed}/${board.progress.total}</b></div>`}${markdownHtml}${board.steps.length ? `<ol class="hub-board-steps">${board.steps.map((step, index) => `<li class="hub-board-step is-${step.status}">${manual ? `<button type="button" class="hub-step-check" data-action="board-step" data-index="${index}" data-step-id="${escIdentity(step.id)}" data-step-text="${escIdentity(step.text)}" aria-label="${esc(`${step.status === "completed" ? tr("标为待完成", "Mark pending") : tr("标为已完成", "Mark completed")} · ${step.text}`)}" aria-pressed="${step.status === "completed"}"><span class="hub-step-icon">${step.status === "completed" ? "✓" : ""}</span></button>` : `<span class="hub-step-icon" aria-label="${esc(step.status)}">${step.status === "completed" ? "✓" : ""}</span>`}<span class="hub-step-text">${esc(step.text)}</span></li>`).join("")}</ol>` : !hasPlan ? `<p class="hub-hint">${esc(tr("本会话暂无主计划", "No main plan in this conversation"))}</p>` : ""}${!compact ? subagentSummary(board, true) : ""}${artifactButtons ? `<div class="hub-board-section"><span>${esc(tr("产物文档", "Artifacts"))}</span></div><div class="hub-artifacts">${artifactButtons}</div>` : ""}${board.artifactScopeError === "unknown" ? `<p class="hub-hint">${esc(tr("暂无法核实会话归属，产物暂不可用", "Artifact ownership could not be verified"))}</p>` : ""}`;
    }
    function renderLiveBoard() {
 if (!liveBoard || disposed) return;
 const board = boardData(), hasPlan = (state.connected || remotePlanContextReady()) && !boardProblem() && !boardMismatch() && hasActualPlan(board);
 const planProgress = planStepProgress(board), ringCircumference = 37.7, ringOffset = (ringCircumference * (100 - planProgress.percent) / 100).toFixed(2);
 liveBoard.dataset.threadId = state.threadId || "";
 planHandle.innerHTML = `<span class="hub-plan-indicator" aria-hidden="true">${planProgress.total ? `<svg class="hub-plan-ring" viewBox="0 0 16 16"><circle class="hub-plan-ring-track" cx="8" cy="8" r="6"></circle><circle class="hub-plan-ring-progress" cx="8" cy="8" r="6" stroke-dasharray="${ringCircumference}" stroke-dashoffset="${ringOffset}"></circle></svg><span class="hub-plan-label">${esc(planProgress.label)}</span>` : icon("list", 13)}</span>`;
 planHandle.setAttribute("aria-label", planProgress.total ? tr(`当前会话计划：${planProgress.label}`, `Current conversation plan: ${planProgress.label}`) : tr("查看当前会话计划", "View current conversation plan"));
 planHandle.title = planProgress.label;
 planHandle.setAttribute("aria-expanded", String(!!state.planOpen));
 liveBoard.innerHTML = `<div class="hub-plan-popover" role="region" aria-label="${esc(tr("当前会话计划进度", "Current conversation plan progress"))}">${planProgress.total ? `<div class="hub-plan-summary"><strong>${esc(planProgress.label)}</strong><span>${planProgress.done ? esc(tr("已完成", "Complete")) : esc(tr(`已完成 ${planProgress.completed} 项`, `${planProgress.completed} completed`))}</span></div>` : ""}${board.steps.length ? `<ol class="hub-plan-steps">${board.steps.map((step) => `<li class="hub-board-step is-${esc(step.status)}"><span class="hub-step-icon" aria-hidden="true">${step.status === "completed" ? "✓" : step.status === "in-progress" ? "•" : ""}</span><span class="hub-step-text">${esc(step.text)}</span></li>`).join("")}</ol>` : `<div class="hub-plan-document">${esc(String(board.planMarkdown || "").trim().slice(0, 1800))}</div>`}</div>`;
 positionConversationTools();
 applyTheme();
    }
    function setPlanPopover(open, pinned = false) {
 state.planOpen = !!open;
 state.planPinned = !!open && !!pinned;
 if (!state.planOpen) state.planHovering = false;
 renderLiveBoard();
    }
    function deferPlanPopoverClose() {
 later(() => {
 if (!state.planPinned && !state.planHovering && document.activeElement !== planHandle) setPlanPopover(false);
 }, 90);
    }
    function handlePlanPointerDown(event) {
 state.planActivationPointerType = String(event?.pointerType || "").toLowerCase();
    }
    function handlePlanPointerEnter(event) {
 if (String(event?.pointerType || "").toLowerCase() === "touch") return;
 state.planHovering = true;
 setPlanPopover(true);
 pollBoard().then(renderLiveBoard);
    }
    function handlePlanPointerLeave(event) {
 if (event?.relatedTarget && (planHandle?.contains(event.relatedTarget) || liveBoard?.contains(event.relatedTarget))) return;
 state.planHovering = false;
 deferPlanPopoverClose();
    }
    function handlePlanClick(event) {
 event?.preventDefault?.(); event?.stopPropagation?.();
 if (planHandle?.hidden) return;
 const activation = state.planActivationPointerType || (event?.detail === 0 ? "keyboard" : "");
 state.planActivationPointerType = "";
 const pin = activation === "touch" || activation === "keyboard" || !state.planHovering;
 setPlanPopover(state.planPinned ? false : true, pin);
 if (state.planOpen) pollBoard().then(renderLiveBoard);
    }
    function artifactMarkup() {
 if (!state.artifact) return "";
 return `<section class="hub-artifact-preview"><div class="hub-row" style="flex-wrap:wrap"><strong class="hub-grow" style="overflow-wrap:anywhere">${esc(state.artifact.name)}</strong>${button("artifact-folder", tr("打开所在文件夹", "Open containing folder"), { small: true })}${button("reveal-artifact", tr("在 Finder 中显示", "Show in Finder"), { small: true })}${button("close-artifact", tr("关闭", "Close"), { small: true })}</div><pre>${esc(state.artifact.content)}</pre></section>`;
    }
    function renderBoardTab() { renderMemory(); }
    async function pollRemotePlan(environmentId) {
 if (boardLoading || !environmentId) return false;
 const threadId = currentThreadId();
 if (!threadId || threadId === "__NEW__" || threadId.startsWith("__ROUTE_")) return false;
 const route = routeKey(), scopeVer = boardScopeVersion, version = ++boardVersion;
 const isCurrent = () => !disposed && version === boardVersion && scopeVer === boardScopeVersion &&
 route === routeKey() && environmentId === remotePlanEnvironmentId() && threadId === currentThreadId();
 boardLoading = true;
 if (cache.board && (cache.board.remote !== true || String(cache.board.environmentId || "").toLowerCase() !== environmentId.toLowerCase() || String(cache.board.threadId || "") !== threadId)) {
 cache.board = null; boardSignature = ""; boardRenderedSignature = ""; state.planOpen = false; state.planPinned = false; state.planHovering = false;
 planHandle.hidden = true; liveBoard.hidden = true;
 }
 try {
 if (typeof window.__t3HudRemoteRpc !== "function") throw new Error("remote plan unavailable");
 const response = await window.__t3HudRemoteRpc(environmentId, "orchestration.getThreadProjection", { threadId }, 4500);
 if (!isCurrent()) return false;
 let nativePlan = null;
 if (response?.ok && response.value) {
 try { nativePlan = normalizeRemoteThreadPlan(response.value, environmentId, threadId); } catch {}
 }
 let mirroredPlan = null;
 const project = remotePlanProject(environmentId, threadId), projectRoot = project?.projectRoot || "";
 if (projectRoot) {
 try {
 const relativePath = await planMirrorRelativePath(threadId);
 if (!isCurrent()) return false;
 const mirrorResponse = await window.__t3HudRemoteRpc(environmentId, "projects.readFile", { cwd: projectRoot, relativePath, allowMissing: true }, 4500);
 if (!mirrorResponse?.ok) throw new Error("remote plan unavailable");
 const mirrorValue = mirrorResponse.value ?? mirrorResponse.data ?? mirrorResponse;
 const contents = mirrorValue?.contents;
 mirroredPlan = normalizeRemotePlanMirror(typeof contents === "string" ? contents : "", environmentId, threadId, projectRoot);
 } catch {}
 }
 if (!isCurrent()) return false;
 if (!nativePlan && !mirroredPlan) throw new Error("remote plan unavailable");
 const data = newestRemotePlan(nativePlan, mirroredPlan);
 const recovered = !!errors.board;
 cache.board = data; delete errors.board;
 const signature = JSON.stringify(data);
 if (recovered || signature !== boardSignature) { boardSignature = signature; renderLiveBoard(); renderChrome(); }
 return true;
 } catch (error) {
 if (isCurrent()) {
 cache.board = { remote: true, environmentId, threadId, steps: [], artifacts: [], subagents: [] };
 errors.board = new Error("remote plan unavailable"); boardRenderedSignature = ""; renderLiveBoard();
 }
 return false;
 } finally { if (version === boardVersion) boardLoading = false; }
    }
    async function pollBoard({ fromUpdate = false } = {}) {
 if (disposed || document.hidden || boardLoading) return false;
 const remoteEnvironmentId = remotePlanEnvironmentId();
 if (remoteEnvironmentId) return pollRemotePlan(remoteEnvironmentId);
 if (contextLoading) return false;
 if (!state.connected) return false;
 if (cache.board?.remote === true && verifiedLocalPlanContext()) {
 cache.board = null; delete errors.board; boardSignature = ""; renderLiveBoard();
 }
 if (boardMismatch()) { renderLiveBoard(); if (state.open && state.tab === "board") renderBoardTab(); return false; }
 boardLoading = true;
 let synced = false;
 const version = ++boardVersion, projectRoot = state.projectRoot, threadId = state.threadId || "__NEW__", scopeVer = boardScopeVersion, route = routeKey();
 const isCurrent = () => !disposed && version === boardVersion && scopeVer === boardScopeVersion &&
 route === routeKey() && projectRoot === state.projectRoot && threadId === state.threadId && !remotePlanEnvironmentId();
 try {
 const environmentId = state.context?.environmentId || state.context?.environment?.id || undefined;
 const data = await request("board:get", { projectRoot, threadId: threadId || undefined, environmentId, strictThreadMatch: true, excludeSubagentInference: true });
 if (!isCurrent()) return false;
 if ((Object.hasOwn(data, "threadId") && String(data.threadId || "") !== threadId) ||
 (Object.hasOwn(data, "projectRoot") && data.projectRoot !== projectRoot)) {
 const error = new Error("board session mismatch"); error.code = "board_thread_mismatch"; throw error;
 }
 const recovered = !!errors.board;
 cache.board = data; delete errors.board;
 synced = true;
 const signature = JSON.stringify(data);
 if (recovered || signature !== boardSignature) {
 boardSignature = signature; renderLiveBoard(); renderChrome();
 }
 if (!fromUpdate && state.open && state.tab === "board" && (recovered || boardEditorNeedsSync || signature !== boardRenderedSignature || boardTabRenderPending)) {
 if (preserveBoardEditorOnReadError()) return false;
 // Ordinary polls defer focused edits; recovery must refresh the visible CAS
 // baseline while retaining the editor protected through the failed read.
 const syncEditor = (recovered || boardEditorNeedsSync) && sameBoardViewScope(boardViewSnapshots.get(content));
 if (boardEditorActive() && !syncEditor) boardTabRenderPending = true;
 else renderBoardTab({ preserveDraftEditor: true, inPlace: syncEditor });
 }
 return synced;
 } catch (error) {
 if (isCurrent()) {
 errors.board = error; boardRenderedSignature = ""; renderLiveBoard();
 if (state.open && state.tab === "board") {
 if (preserveBoardEditorOnReadError()) return false;
 if (boardEditorActive() && !boardMismatch() && errors.board?.code !== "board_thread_mismatch") boardTabRenderPending = true;
 else renderBoardTab();
 }
 }
 return false;
 } finally { if (version === boardVersion) boardLoading = false; }
    }
    function scheduleBoardPoll() {
 cancelTimer(boardTimer);
 boardTimer = later(async () => { await pollBoard(); if (!disposed) scheduleBoardPoll(); }, 3500);
    }
    async function updateBoard(element, action, index) {
 if (boardMismatch() || errors.board?.code === "board_thread_mismatch") { toast(tr("会话未匹配，请刷新连接", "Session mismatch; refresh the connection"), true); return; }
 if (cache.board?.remote === true || remotePlanEnvironmentId()) { toast(tr("Connect 当前计划为只读", "Connect plans are read-only"), true); return; }
 if (pending.has(`board-update:${state.threadId || "__NEW__"}`)) return;
 const current = boardData();
 const surface = element && (liveBoard?.contains(element) ? liveBoard : content.contains(element) ? content : null);
 const view = surface ? boardViewSnapshots.get(surface) : null;
 if (element && (!sameBoardViewScope(view) || boardProblem() || view.source !== String(current.source || "") || view.planRevision !== current.planRevision || view.planRevision === undefined && view.updatedAt !== current.updatedAt)) { rejectStaleBoardClick(); return; }
 if ((action === "toggle" || action === "clear") && !isManualBoard(current) || action === "add" && hasActualPlan(current) && !isManualBoard(current)) { toast(tr("原生计划为只读", "Native plans are read-only"), true); return; }
 const projectRoot = state.projectRoot, threadId = state.threadId || "__NEW__", scopeVer = boardScopeVersion, route = boardScopeRoute();
 const baseline = view || current;
 const expected = typeof baseline.planRevision === "string" ? { expectedRevision: baseline.planRevision } : typeof baseline.updatedAt === "string" ? { expectedUpdatedAt: baseline.updatedAt } : {};
 const submittedDraft = state.boardDraft;
 const submittedEditSeq = boardDraftEditSeq;
 const stillCurrent = () => !disposed && scopeVer === boardScopeVersion && projectRoot === state.projectRoot && threadId === state.threadId && route === boardScopeRoute();
 const busyElement = action === "add" && element?.name === "board-step-draft" ? element.closest(".hub-board-add")?.querySelector('[data-action="board-add"]') : element;
 await busy(`board-update:${threadId || "project"}`, busyElement, async () => {
 try {
 if (action === "clear") await request("board:clear", { projectRoot, threadId: threadId || undefined, strictThreadMatch: true, ...expected });
 else {
 const board = current, steps = board.steps.map((step) => ({ ...step }));
 if (action === "add") {
 if (!submittedDraft.trim()) return;
 steps.push({ id: `hub-${Date.now()}`, text: submittedDraft.trim(), status: "pending" });
 } else if (steps[index]) steps[index].status = steps[index].status === "completed" ? "pending" : "completed";
 await request("board:update", { projectRoot, threadId: threadId || undefined, strictThreadMatch: true, ...expected, steps: steps.map((step) => ({ ...step, status: step.status === "in-progress" ? "in_progress" : step.status })), background: board.background || "" });
 }
 } catch (error) {
 if (!stillCurrent()) return;
 if (error.code !== "PLAN_CONFLICT" && !/PLAN_CONFLICT/.test(errorText(error))) throw error;
 boardVersion++; boardLoading = false; boardRenderedSignature = ""; boardEditorNeedsSync = true;
 const synced = await pollBoard({ fromUpdate: true });
 if (synced && stillCurrent() && !boardProblem()) {
 renderLiveBoard();
 if (state.open && state.tab === "board") renderBoardTab({ preserveDraftEditor: true });
 toast(tr("计划已被其他窗口更新，请核对最新计划后重试", "The plan changed in another window. Review the latest plan and try again."), true);
 }
 return;
 }
 if (!stillCurrent()) return;
 if (action === "add" && boardDraftEditSeq === submittedEditSeq) {
 state.boardDraft = "";
 const input = content.querySelector('[name="board-step-draft"]');
 if (input && input.value === submittedDraft) input.value = "";
 }
 boardVersion++; boardLoading = false; boardRenderedSignature = ""; boardEditorNeedsSync = true;
 const synced = await pollBoard({ fromUpdate: true });
 if (synced && stillCurrent() && !boardProblem()) {
 renderLiveBoard();
 if (state.open && state.tab === "board") renderBoardTab({ preserveDraftEditor: true });
 }
 });
    }
    async function readArtifact(index, element, operation = "open") {
 const artifact = boardData().artifacts[index];
 if (!artifact) return;
 const path = typeof artifact === "string" ? artifact : artifact.path || artifact.id || artifact.name;
 const projectRoot = state.projectRoot, threadId = state.threadId || "__NEW__", version = contextVersion, selection = ++artifactVersion;
 await busy(`artifact:${selection}`, element, async () => {
 let data;
 try { data = await request("board:openArtifact", { projectRoot, threadId, path, ...(operation === "reveal" ? { operation } : {}) }); }
 catch (error) {
 if (!disposed && version === contextVersion && threadId === state.threadId && selection === artifactVersion) throw error;
 return;
 }
 if (disposed || version !== contextVersion || threadId !== state.threadId || selection !== artifactVersion) return;
 if (data.kind !== "markdown") { toast(tr("已在 Finder 中显示", "Shown in Finder")); return; }
 state.artifact = { path, name: data.name || String(path).split(/[\\/]/).pop(), content: data.content || "" };
 if (state.tab !== "board") switchTab("board");
 setOpen(true, false); renderBoardTab();
 content.querySelector(".hub-artifact-preview")?.scrollIntoView({ block: "nearest" });
 });
    }
    async function revealArtifact(element, operation = "reveal") {
 const path = state.artifact?.path;
 if (!path) return;
 await busy(`artifact:${path}`, element, async () => {
 await request("board:openArtifact", { projectRoot: state.projectRoot, threadId: state.threadId, path, operation });
 toast(tr("已在 Finder 中显示", "Shown in Finder"));
 });
    }

    function orchestrationValues() {
 const data = state.orchestrationDraft || cache.orchestration?.orchestration || cache.orchestration?.config || cache.orchestration || {};
 const orchestrator = data.orchestratorMode || data.orchestrator?.mode || (typeof data.orchestrator === "string" ? data.orchestrator : "") || data.mode || "off";
 return {
 orchestratorMode: /argon/i.test(orchestrator) ? "argon" : /carbon/i.test(orchestrator) ? "carbon" : "off",
 swarmMode: ["auto", "on", "off"].includes(data.swarmMode) ? data.swarmMode : data.swarmEnabled === true ? "on" : "auto",
 maxParallelAgents: Math.max(1, Math.min(20, Number(data.maxParallelAgents ?? data.maxConcurrency ?? 6) || 6)),
 strictCommanderOnly: typeof data.strictCommanderOnly === "boolean" ? data.strictCommanderOnly : /carbon|argon/i.test(orchestrator) || data.swarmMode === "on",
 autoWorktreeIsolation: (data.autoWorktreeIsolation ?? data.worktreeIsolation ?? data.swarm?.worktreeIsolation ?? true) !== false,
 };
    }
    function renderCommander() {
 if (!cache.orchestration) return errors.orchestration ? inlineError(errors.orchestration) : loading();
 const outer = cache.orchestration, data = outer.orchestration || outer.config || outer;
 const version = outer.policyVersion ?? data.policyVersion;
 const mode = data.swarmMode === "on" ? "on" : "off";
 const applied = (outer.modeApplied ?? data.modeApplied) === true;
 const status = version === 2 ? applied ? tr("已同步", "Synced") : tr("待同步 / 请检查宿主", "Not fully synced") : tr("未应用 / 待同步", "Not applied / not synced");
 return `<section class="hub-card hub-commander"><div class="hub-commander-title">${esc(tr("T3 分工方式", "T3 collaboration"))}</div><p class="hub-description">${esc(tr("只保留一种分工方式。常规：短小任务主会话处理，长任务按需派单；总指挥：主会话以协调为主，Work L1 / L2 均未解决时再接管。", "Choose one policy. Normal: main agent handles small tasks and delegates longer work as needed. Commander: coordinate first, then take over after Work L1 / L2 cannot resolve it."))}</p><div class="hub-segments" role="group" aria-label="${esc(tr("选择 T3 分工方式", "Select T3 collaboration policy"))}"><button type="button" data-action="set-cooperation-mode" data-mode="off" aria-pressed="${version === 2 && mode === "off"}">${esc(tr("常规分工", "Normal"))}</button><button type="button" data-action="set-cooperation-mode" data-mode="on" aria-pressed="${version === 2 && mode === "on"}">${esc(tr("总指挥", "Commander"))}</button></div><p class="hub-hint">${esc(status)}。${esc(tr("写入宿主规则文件；分工提示仅用于 T3，属于提示词约定，不是自动调度或权限隔离。现有会话可能需要重新加载规则。", "Host rule files receive guidance for T3 only. It is prompt guidance, not automatic dispatch or a permission boundary; existing sessions may need to reload rules."))}</p></section>`;
    }
    async function setCooperationMode(element, mode) {
 if (!["on", "off"].includes(mode) || !cache.orchestration) return;
 const version = contextVersion, projectRoot = state.projectRoot;
 const expectedRevision = cache.orchestration.modeRevision ?? cache.orchestration.config?.modeRevision ?? cache.orchestration.orchestration?.modeRevision;
 if (!expectedRevision) { toast(tr("无法确认配置版本，请刷新后重试", "Cannot verify config revision; refresh first"), true); return; }
 await busy("orchestration-save", element, async () => {
 let result, failure;
 try {
 result = await hubRpc("subagents:orchestration:update", { swarmMode: mode, expectedRevision });
 if (result?.ok === false || result?.success === false) {
 const reason = result.error?.message || result.error || tr("保存未完成", "Save incomplete");
 const warning = result.rolledBack === false ? tr(`；${Array.isArray(result.rollbackFailures) && result.rollbackFailures.length ? `${result.rollbackFailures.length} 个` : "部分"}规则文件未能自动恢复，请检查宿主规则。`, "; some rule files could not be restored automatically; inspect host rules.") : "";
 throw new Error(`${reason}${warning}`);
 }
 }
 catch (error) { failure = error; }
 try { const next = await request("subagents:orchestration:get", { projectRoot }); if (!disposed && version === contextVersion && projectRoot === state.projectRoot) { cache.orchestration = next; delete errors.orchestration; renderSubagents(); } }
 catch (error) { failure ||= error; }
 if (failure) throw failure;
 if (disposed || version !== contextVersion) return;
 const next = cache.orchestration, data = next?.orchestration || next?.config || next;
 const applied = next?.modeApplied ?? data?.modeApplied;
 if (data?.swarmMode !== mode) throw new Error(tr(`分工方式已被其他操作改为${data?.swarmMode === "on" ? "总指挥" : data?.swarmMode === "off" ? "常规分工" : "未知状态"}；已重新读取，请检查后重试。`, "Collaboration mode changed in another operation; the current state was reloaded."));
 if (applied !== true) throw new Error(tr("已提交设置，但宿主规则尚未全部同步；请检查状态。", "Setting submitted, but host rules are not fully synced."));
 toast(tr("分工提示已保存并同步到宿主规则", "Collaboration guidance saved to host rules"));
 });
    }
    async function disableLegacyOrchestration(element) {
 const version = contextVersion, projectRoot = state.projectRoot;
 const expectedRevision = cache.orchestration?.modeRevision ?? cache.orchestration?.config?.modeRevision ?? cache.orchestration?.orchestration?.modeRevision;
 await busy("orchestration-save", element, async () => {
 const result = await hubRpc("subagents:orchestration:update", { orchestratorMode: "off", swarmMode: "off", strictCommanderOnly: false, projectRoot, ...(expectedRevision ? { expectedRevision } : {}) });
 if (disposed || version !== contextVersion) return;
 cache.orchestration = await request("subagents:orchestration:get", { projectRoot });
 if (disposed || version !== contextVersion) return;
 renderSubagents();
 const failed = (result?.hostResults || []).filter(item => !item.ok);
 if (result?.ok === false || failed.length) throw new Error(tr(`已关闭旧配置，${failed.length || "部分"} 个规则文件清理失败。`, `Legacy setting disabled, but ${failed.length || "some"} rule files could not be cleaned.`));
 toast(tr("已关闭旧编排提示；角色路由保持不变。", "Legacy guidance disabled; role routes unchanged."));
 });
    }
    const nativeSettingKeys = { codex: ["model", "model_reasoning_effort", "approval_policy", "sandbox_mode"], muse: ["model", "defaultModel", "permissionMode", "reasoningEffort", "effort", "defaultEffort"], pi: ["defaultModel", "defaultProvider", "model", "effort", "reasoningEffort", "thinkingLevel"] };
    function settingsValues() { const hostKey = state.settingsHost === "agy" ? "antigravity" : state.settingsHost; return cache.settings?.hosts?.[hostKey] ?? cache.settings?.[hostKey] ?? null; }
    function settingValue(entry, key) {
 for (const source of [entry?.editableValues, entry?.values, entry?.settings, entry?.config, entry]) if (source && typeof source === "object" && Object.prototype.hasOwnProperty.call(source, key)) return source[key];
 return undefined;
    }
    function settingText(value) { return value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value); }
    function settingInputText(value) { return settingText(value).replace(/\r\n?/g, "\n"); }
    function nativeSettingRows(value) { return Math.min(3, settingInputText(value).split("\n").length); }
    function nativeSettingHint(key, saved) { return state.clearedHostFields.has(key) ? tr("保存后恢复默认（移除配置键）。", "Save to use the default (remove this key).") : saved === undefined ? tr("快照未提供当前值；留空不修改。", "Current value is not in this snapshot; leave blank to keep it.") : tr("仅保存修改过的字段；清空后保存可恢复默认。", "Only changed fields are saved; clear and save to use the default."); }
    function nativeSettingPlaceholder(key, saved) { return saved === "" && !state.clearedHostFields.has(key) ? tr('显式空字符串 ""', 'Explicit empty string ""') : tr("未设置 · 使用宿主默认值", "Unset · use agent default"); }
    function editNativeSetting(key, value, explicitClear = false) {
 const saved = settingValue(settingsValues(), key), savedText = settingText(saved), saveKey = `${state.settingsHost}:${key}`;
 const effectiveSaved = inFlightNativeSaves.has(saveKey) ? inFlightNativeSaves.get(saveKey) : saved;
 const current = Object.prototype.hasOwnProperty.call(state.settingsDraft, key) ? state.settingsDraft[key] : savedText;
 const raw = value === settingInputText(savedText) ? savedText : value === settingInputText(current) ? current : value;
 const clearing = value === "" && effectiveSaved != null && (explicitClear || effectiveSaved !== "");
 if (clearing) state.clearedHostFields.add(key); else state.clearedHostFields.delete(key);
 if (!clearing && raw === savedText && !inFlightNativeSaves.has(saveKey)) delete state.settingsDraft[key]; else state.settingsDraft[key] = clearing ? "" : raw;
 state.settingsDirty = Object.keys(state.settingsDraft).length > 0;
    }
    function syncNativeSettingField(input, key) {
 input.rows = nativeSettingRows(input.value);
 const field = input.closest?.(".hub-native-field"); if (!field) return;
 const saved = settingValue(settingsValues(), key), cleared = state.clearedHostFields.has(key);
 input.placeholder = nativeSettingPlaceholder(key, saved);
 const clear = field.querySelector("[data-host-field-clear]"); if (clear) { clear.hidden = saved == null && input.value === ""; clear.disabled = cleared; }
 const badge = field.querySelector(".hub-native-empty"); if (badge) badge.hidden = saved !== "" || cleared;
 input.setAttribute("aria-describedby", `${input.id}-key ${saved === "" && !cleared ? `${input.id}-empty ` : ""}${input.id}-hint`);
 const hint = field.querySelector(".hub-hint"); if (hint) hint.textContent = nativeSettingHint(key, saved);
    }
    function editableSettingKeys(entry = settingsValues()) {
 if (!entry || entry.error || entry.corrupted || entry.readonly || entry.readOnly) return [];
 const allowed = Object.prototype.hasOwnProperty.call(nativeSettingKeys, state.settingsHost) ? nativeSettingKeys[state.settingsHost] : [];
 return Array.isArray(entry.editableKeys) ? allowed.filter((key) => entry.editableKeys.includes(key)) : allowed;
    }
    let t3SettingsView = { loading: false, value: null, error: "", environmentId: null };
    async function loadT3Settings() {
 const generation = ++settingsVersion, version = contextVersion;
 const current = () => !disposed && state.settingsHost === "t3" && version === contextVersion && generation === settingsVersion;
 t3SettingsView = { loading: true, value: null, error: "", environmentId: null };
 if (state.open && state.tab === "settings") renderSettings();
 try {
 const env = (await request("settings:get"))?.t3EnvironmentId; if (!current()) return;
 if (!env || typeof window.__t3HudRemoteRpc !== "function") throw new Error(tr("无法确认本机 T3 环境连接", "Local T3 environment connection unavailable"));
 const response = await window.__t3HudRemoteRpc(env, "server.getConfig", {}); if (!current()) return;
 const value = response?.value?.settings?.promptSuggestionsEnabled;
 if (!response?.ok || typeof value !== "boolean") throw new Error(tr("未连接或当前版本不支持此设置", "Disconnected or setting unsupported"));
 t3SettingsView = { loading: false, value, error: "", environmentId: env };
 } catch (e) { if (current()) t3SettingsView = { loading: false, value: null, error: errorText(e), environmentId: null }; }
 if (current() && state.open && state.tab === "settings") renderSettings();
    }
    async function toggleT3PromptSuggestions(element) {
 const previous = t3SettingsView.value, env = t3SettingsView.environmentId, version = contextVersion;
 if (typeof previous !== "boolean" || !env || typeof window.__t3HudRemoteRpc !== "function") return;
 await busy("t3-prompt-suggestions", element, async () => {
 const response = await window.__t3HudRemoteRpc(env, "server.updateSettings", { patch: { promptSuggestionsEnabled: !previous } });
 if (disposed || state.settingsHost !== "t3" || version !== contextVersion) return;
 if (!response?.ok) throw new Error(tr("T3 设置未能保存", "T3 setting could not be saved"));
 const readback = await window.__t3HudRemoteRpc(env, "server.getConfig", {});
 if (disposed || state.settingsHost !== "t3" || version !== contextVersion) return;
 const actual = readback?.value?.settings?.promptSuggestionsEnabled;
 if (!readback?.ok || actual !== !previous) { t3SettingsView = { loading: false, value: null, environmentId: null, error: tr("保存后无法确认，请重新读取。", "Could not confirm after saving; reload.") }; renderSettings(); throw new Error(t3SettingsView.error); }
 t3SettingsView = { loading: false, value: actual, error: "", environmentId: env };
 renderSettings(); toast(tr("T3 设置已保存并读回确认", "T3 setting saved and verified"));
 });
    }
    function renderSettings() {
 if (state.settingsHost === "t3") {
 const tabs = [...agentHosts, { id: "t3", label: "T3" }].map(host => `<button type="button" class="hub-pill ${host.id === "t3" ? "is-active" : ""}" role="tab" data-action="settings-host" data-agent="${esc(host.id)}" aria-selected="${host.id === "t3"}">${esc(host.label)}</button>`).join("");
 const body = t3SettingsView.loading ? loading() : t3SettingsView.error ? `<p class="hub-error" role="alert">${esc(t3SettingsView.error)}</p>` : `<div class="hub-control-row"><div class="hub-grow"><strong>${esc(tr("下一条提示建议", "Next prompt suggestions"))}</strong><small>${esc(tr("显示后续提问建议；已打开的 Claude 会话可能需要新会话。", "Show follow-up suggestions; open Claude sessions may need a new session."))}</small></div><button type="button" role="switch" class="hub-switch" data-action="toggle-t3-prompt-suggestions" aria-label="${esc(tr("下一条提示建议", "Next prompt suggestions"))}" aria-checked="${t3SettingsView.value === true}" ${typeof t3SettingsView.value !== "boolean" ? "disabled" : ""}><span></span></button></div>`;
 content.innerHTML = `<div class="hub-section-heading"><span>${esc(tr("本机 T3 设置", "Local T3 settings"))}</span></div><p class="hub-description">${esc(tr("通过当前已连接的 T3 修改，并在保存后重新读取确认。", "Updated through the connected T3 and verified by reading it back."))}</p><div class="hub-agent-filters hub-native-hosts" role="tablist">${tabs}</div>${button("open-project-agents", tr("项目 / 全局 AGENTS 规则", "Project / global AGENTS rules"), { small: true })}<section class="hub-native-settings">${body}<div class="hub-editor-actions">${button("reload-native-settings", tr("重新读取", "Reload"), { small: true, icon: "refresh" })}</div></section>`;
 return;
 }
 const entry = settingsValues(), keys = editableSettingKeys(entry), host = agentHosts.find((host) => host.id === state.settingsHost);
 const labels = { model: tr("模型", "Model"), defaultModel: tr("默认模型", "Default model"), defaultProvider: tr("默认提供商", "Default provider"), model_reasoning_effort: tr("思考强度", "Reasoning effort"), approval_policy: tr("审批策略", "Approval policy"), sandbox_mode: tr("沙箱模式", "Sandbox mode"), permissionMode: tr("权限模式", "Permission mode"), reasoningEffort: tr("思考强度", "Reasoning effort"), effort: tr("思考强度", "Effort"), defaultEffort: tr("默认思考强度", "Default effort"), thinkingLevel: tr("思考档位", "Thinking level") };
 const path = entry?.path || entry?.fileName || entry?.rulePath || "";
 const warning = entry?.error || (entry?.corrupted ? tr("配置文件已损坏，请先修复原生文件后重新读取。", "The configuration is corrupt. Repair the native file and reload.") : "");
 const fields = keys.map((key) => {
 const saved = settingValue(entry, key), changed = Object.prototype.hasOwnProperty.call(state.settingsDraft, key);
 const value = changed ? state.settingsDraft[key] : settingText(saved), cleared = state.clearedHostFields.has(key), id = `t3-hub-native-setting-${key}`;
 return `<div class="hub-field hub-native-field"><div class="hub-native-field-heading"><label for="${esc(id)}">${esc(labels[key] || key)}</label><button type="button" class="hub-native-clear" data-action="clear-native-setting" data-host-field-clear="${esc(key)}" aria-label="${esc(tr(`清空${labels[key] || key}并恢复默认`, `Clear ${labels[key] || key} and use the default`))}" ${saved == null && !settingText(value) ? "hidden" : ""} ${cleared ? "disabled" : ""}>${esc(tr("清空 / 恢复默认", "Clear / default"))}</button></div><code class="hub-native-key" id="${esc(id)}-key">${esc(key)}</code><textarea class="hub-input" id="${esc(id)}" name="native-setting" data-settings-key="${esc(key)}" rows="${nativeSettingRows(value)}" aria-describedby="${esc(id)}-key ${saved === "" && !cleared ? `${esc(id)}-empty ` : ""}${esc(id)}-hint" placeholder="${esc(nativeSettingPlaceholder(key, saved))}" spellcheck="false" autocomplete="off">\n${esc(settingInputText(value))}</textarea><span class="hub-native-empty" id="${esc(id)}-empty" ${saved !== "" || cleared ? "hidden" : ""}>${esc(tr('当前显式为空 ""', 'Explicitly set to ""'))}</span><small class="hub-hint" id="${esc(id)}-hint" aria-live="polite">${esc(nativeSettingHint(key, saved))}</small></div>`;
 }).join("");
 const native = !cache.settings ? loading() : `<section class="hub-native-settings"><div class="hub-row"><strong>${esc(host?.label || state.settingsHost)}</strong><span class="hub-badge">${esc(warning ? tr("只读 · 配置异常", "Read-only · configuration error") : !keys.length ? tr("原生设置未接入", "Native settings unavailable") : entry.exists === false ? tr("文件不存在 · 保存时创建", "Missing file · created on save") : tr("已读取", "Loaded"))}</span></div>${path ? `<div class="hub-settings-host-description" title="${esc(path)}">${esc(path)}</div>` : ""}${warning ? `<div class="hub-error" role="alert"><div><strong>${esc(tr("只读保护：配置暂不可写", "Read-only: configuration cannot be edited"))}</strong><span>${esc(warning)}</span></div></div>` : keys.length ? `<div class="hub-native-fields">${fields}</div>` : empty(tr("原生设置暂不可编辑", "Native settings unavailable"), tr(state.settingsHost === "antigravity" ? "T3 可以启动 AGY ACP；其原生设置来源和当前会话加载状态尚未验证。下方规则文件存在不代表已加载。" : "当前接口不支持写入此宿主的原生设置。", "T3 can start AGY ACP; the native settings source and active rules are not verified."), "info")}${state.settingsHost === "antigravity" ? (entry?.ruleCandidates || []).map(item => `<p class="hub-hint">${esc(item.path)} · ${esc(item.exists ? tr("文件存在 · 是否加载未知", "File exists · loading unknown") : tr("不存在", "Missing"))}</p>`).join("") : ""}<div class="hub-editor-actions">${keys.length ? button("save-native-settings", tr("保存配置", "Save configuration"), { primary: true, small: true, icon: "save", disabled: pending.has("native-settings") }) : ""}${button("reload-native-settings", tr("重新读取", "Reload"), { small: true, icon: "refresh" })}</div></section>`;
 const ruleInfo = cache.settingsRule;
 content.innerHTML = `<div class="hub-agent-filters" aria-label="宿主状态">${agentHosts.map((h) => `<span class="hub-badge">${esc(h.label)} · ${esc(state.context?.activeProvider === h.id || state.context?.activeCli === h.id ? tr("当前", "Active") : tr("状态未知", "Unknown"))}</span>`).join("")}</div><div class="hub-section-heading"><span>${esc(tr("原生设置", "Native settings"))}</span></div><p class="hub-description">${esc(tr("分别管理每位搭档的原生配置，只保存你修改的字段。", "Manage each agent's native settings and save only the fields you change."))}</p><div class="hub-agent-filters hub-native-hosts" role="tablist" aria-label="${esc(tr("选择宿主", "Choose agent"))}">${[...agentHosts, { id: "t3", label: "T3" }].map((host) => `<button type="button" class="hub-pill ${state.settingsHost === host.id ? "is-active" : ""}" role="tab" data-action="settings-host" data-agent="${esc(host.id)}" aria-selected="${state.settingsHost === host.id}">${agentMark(host.id)}${esc(host.label)}</button>`).join("")}</div>${button("open-project-agents", tr("项目 / 全局 AGENTS 规则", "Project / global AGENTS rules"), { small: true })}${errors.settings ? inlineError(errors.settings, "reload-native-settings") : native}<div class="hub-section-heading" style="margin-top:28px"><span>${esc(tr("宿主规则 · 全局", "Agent rules · Global"))}</span></div>${ruleInfo?.path ? `<p class="hub-hint">${esc(ruleInfo.path)}</p>` : ""}${errors.settingsRule ? inlineError(errors.settingsRule, "reload-native-settings") : !ruleInfo ? `<p class="hub-hint">${esc(tr("当前宿主暂无可用的托管规则文件。", "No managed rules file is available for this agent."))}</p>` : `<label class="hub-field">${esc(tr("对话与协作指令", "Conversation and collaboration instructions"))}<textarea class="hub-editor" name="native-rule" spellcheck="false" aria-label="${esc(tr("宿主规则", "Agent rules"))}">${esc(state.settingsRule)}</textarea></label>${button("save-native-rule", tr("保存规则", "Save rules"), { primary: true, small: true, icon: "save", disabled: pending.has("native-rule") })}`}`;
    }
    async function loadSettings(force = false, resetDrafts = force) {
 const host = state.settingsHost, version = contextVersion;
 if (host === "t3") return loadT3Settings();
 if (cache.settings && !force) return;
 const generation = ++settingsVersion, ruleSupported = ["codex", "antigravity", "muse", "pi"].includes(host);
 const results = await Promise.allSettled([request("settings:get"), ruleSupported ? request("settings:getRule", { host }) : Promise.resolve(null)]);
 if (disposed || host !== state.settingsHost || version !== contextVersion || generation !== settingsVersion) return;
 if (results[0].status === "fulfilled") {
 cache.settings = results[0].value; delete errors.settings;
 if (resetDrafts) { state.settingsDirty = false; state.settingsDraft = {}; state.clearedHostFields.clear(); }
 } else errors.settings = results[0].reason;
 if (results[1].status === "fulfilled") {
 const data = results[1].value; cache.settingsRule = data;
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
 await request("settings:saveRule", { host, content: saved, expectedContent: cache.settingsRule.content, expectedTarget: cache.settingsRule.targetPath });
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
 if (!isCurrent()) return;
 try { await request("settings:update", { host, key, value }); }
 catch (error) {
 if (!isCurrent()) return;
 await loadSettings(true, false); if (!isCurrent()) return;
 state.settingsDirty = Object.keys(state.settingsDraft).length > 0;
 throw new Error(`${tr(`已保存 ${savedCount}/${changes.length} 项`, `Saved ${savedCount}/${changes.length} fields`)} · ${key}: ${errorText(error)}`);
 }
 if (!isCurrent()) return;
 savedCount++;
 if (value === null ? state.clearedHostFields.has(key) : !state.clearedHostFields.has(key) && state.settingsDraft[key] === value) { delete state.settingsDraft[key]; state.clearedHostFields.delete(key); }
 }
 state.settingsDirty = Object.keys(state.settingsDraft).length > 0;
 }
 await loadSettings(true, false); if (!isCurrent()) return;
 const refreshError = rule ? errors.settingsRule : errors.settings;
 if (refreshError) throw new Error(`${tr("已写入，但刷新失败", "Saved, but refresh failed")}: ${errorText(refreshError)}`);
 toast(rule ? tr("宿主规则已保存", "Agent rules saved") : tr("原生配置已保存", "Native configuration saved"));
 } finally { if (!rule) for (const key of nativeSettingKeys[host] || []) inFlightNativeSaves.delete(`${host}:${key}`); }
 });
 if (isCurrent() && state.open && state.tab === "settings") renderSettings();
    }
    function toast(message, error = false) {
 if (disposed || !root) return;
 const node = root.querySelector(".hub-toast");
 node.classList.toggle("is-error", error);
 node.innerHTML = `${icon(error ? "info" : "check", 15)}<span>${esc(message)}</span>`;
 node.hidden = false; cancelTimer(toastTimer);
 toastTimer = later(() => { node.hidden = true; }, error ? 6500 : 3500);
    }
    async function busy(key, element, work) {
 if (pending.has(key) || disposed) return;
 pending.add(key); const html = element?.innerHTML;
 if (element) { element.disabled = true; element.classList.add("is-busy"); if (element.tagName === "BUTTON") element.innerHTML = `${spinner()}<span>${esc(tr("处理中", "Working"))}</span>`; }
 try { await work(); } catch (error) { toast(errorText(error), true); }
 finally {
 pending.delete(key);
 if (element?.isConnected && !disposed) { element.disabled = false; element.classList.remove("is-busy"); if (html != null && element.tagName === "BUTTON") element.innerHTML = html; }
 }
    }
    function composerFor(target) {
 const element = target?.nodeType === 1 ? target : target?.parentElement;
 const editor = element?.closest('textarea,[contenteditable="true"],[contenteditable="plaintext-only"]');
 if (!editor || editor.closest('#t3-sidecar-hub-root,#t3-hub-live-board,[role="dialog"],[role="alertdialog"],dialog') || editor.disabled || editor.readOnly) return null;
 if (editor.closest('aside,nav,[role="navigation"],[role="search"],.monaco-editor,.cm-editor')) return null;
 if (!editor.closest('[data-slot="composer-shell"],[data-testid="chat-composer"],[data-testid="composer"],[data-composer],main,[role="main"]')) return null;
 return editor;
    }
    function findRouter() {
 if (window.__TSR_ROUTER__) return window.__TSR_ROUTER__;
 if (cachedRouter) return cachedRouter;
 if (Date.now() - routerProbeAt < 5000) return null;
 routerProbeAt = Date.now();
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
    function resolvePromotedDraftRoute(rawPath) {
 const match = String(rawPath || "").match(/^\/?(?:_t3_env_\/([^/?#]+)\/)?draft\/([^/?#]+)(?:[/?#]|$)/i);
 if (!match) return null;
 let envFromPath = "", draftId;
 try { envFromPath = match[1] ? decodeURIComponent(match[1]) : ""; draftId = decodeURIComponent(match[2]); } catch { return null; }
 const routeFor = (ref) => {
 const threadId = typeof ref?.threadId === "string" ? ref.threadId.trim() : "";
 if (!threadId) return null;
 const environmentId = (typeof ref.environmentId === "string" ? ref.environmentId.trim() : "") || envFromPath;
 return `${environmentId ? `/_t3_env_/${encodeURIComponent(environmentId)}` : ""}/${encodeURIComponent(threadId)}`;
 };
 try {
 const parsed = JSON.parse(storageGet("t3code:composer-drafts:v1") || "null"), store = parsed?.state || parsed;
 const promoted = routeFor(store?.promotedDraftRedirects?.[draftId]) || routeFor(store?.drafts?.[draftId]?.promotedTo) || routeFor(store?.draftThreadsByThreadKey?.[draftId]?.promotedTo);
 if (promoted) return promoted;
 } catch {}
 try {
 const host = document.getElementById("root");
 const key = host && Object.keys(host).find((name) => name.startsWith("__reactContainer") || name.startsWith("__reactFiber"));
 let entry = key ? host[key] : null;
 const ancestors = new Set();
 while (entry?.return && !entry.stateNode?.current && ancestors.size < 400 && !ancestors.has(entry)) {
 ancestors.add(entry); entry = entry.return;
 }
 if (entry?.return && !entry.stateNode?.current) return null;
 const committed = entry?.stateNode?.current || entry?.current || entry;
 const stack = committed ? [committed] : [], seen = new Set(), hooks = new Set();
 while (stack.length && seen.size < 400) {
 const fiber = stack.pop();
 if (!fiber || typeof fiber !== "object" || seen.has(fiber)) continue;
 seen.add(fiber);
 const candidates = [fiber.memoizedProps, fiber.pendingProps, fiber.memoizedState];
 for (let hook = fiber.memoizedState; hook && typeof hook === "object" && hooks.size < 400 && !hooks.has(hook); hook = hook.next) {
 hooks.add(hook); candidates.push(hook.memoizedState);
 }
 for (const props of candidates) {
 if (props?.draftId === draftId && props.isServerThread === true) {
 let promoted = routeFor(props) || routeFor(props.threadRef) || routeFor(props.activeThreadKey) || routeFor({ environmentId: props.environmentId || props.thread?.environmentId, threadId: props.thread?.id });
 if (!promoted && typeof props.activeThreadKey === "string") {
 const activeKey = props.activeThreadKey.trim(), explicitEnv = String(props.environmentId || props.thread?.environmentId || envFromPath || "").trim();
 const slash = activeKey.indexOf("/"), separator = activeKey.indexOf(":");
 let ref;
 if (activeKey.startsWith("thread:")) ref = { environmentId: explicitEnv, threadId: activeKey };
 else if (explicitEnv && (activeKey.startsWith(`${explicitEnv}:`) || activeKey.startsWith(`${explicitEnv}/`))) ref = { environmentId: explicitEnv, threadId: activeKey.slice(explicitEnv.length + 1) };
 else if (slash > 0) ref = { environmentId: activeKey.slice(0, slash), threadId: activeKey.slice(slash + 1) };
 else if (separator >= 0) ref = { environmentId: activeKey.slice(0, separator), threadId: activeKey.slice(separator + 1) };
 else ref = { environmentId: explicitEnv, threadId: activeKey };
 promoted = routeFor(ref);
 }
 if (promoted) return promoted;
 }
 }
 if (fiber.sibling) stack.push(fiber.sibling);
 if (fiber.child) stack.push(fiber.child);
 }
 } catch {}
 return null;
    }
    function rawRouteHint() {
 const path = findRouter()?.state?.location?.pathname;
 return path === "/" ? "__NEW__" : path || location.hash?.slice(1) || location.pathname || "/";
    }
    function routeHint() {
 const raw = rawRouteHint();
 return resolvePromotedDraftRoute(raw) || raw;
    }
    function routeKey() {
 return `${location.href || ""}|${location.search || ""}|${findRouter()?.state?.location?.searchStr || ""}|${routeHint()}`;
    }
    const UUID_RE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
    let scopeAnchor = null;
    function decQ(s) { try { return decodeURIComponent(String(s || "").replace(/\+/g, " ")); } catch { return String(s || ""); } }
    function parseScopeParts() {
 const stripQ = (s) => String(s || "").replace(/\?[^#]*/g, "");
 let pEnv = "", pProj = "", pWs = "";
 for (const raw of [location.hash?.slice(1), location.pathname, routeHint()]) {
 const p = stripQ(raw); if (!p) continue;
 let m = !pProj && p.match(/^\/?(?:_t3_env_\/)?projects?\/([^/?#]+)/i); if (m) pProj = decQ(m[1]);
 m = !pWs && p.match(/^\/?(?:_t3_env_\/)?workspaces?\/([^/?#]+)/i); if (m) pWs = decQ(m[1]);
 m = !pEnv && !/^\/?(?:_t3_env_\/)?(?:projects?|workspaces?)\//i.test(p) && p.match(new RegExp(`^\\/?(?:_t3_env_\\/)?(${UUID_RE})(?:\\/[^/?#]+)?\\/?$`, "i")); if (m) pEnv = m[1].toLowerCase();
 }
 const vals = { e: [], p: [], r: [], w: [] }, map = { env: "e", environment: "e", environmentId: "e", project: "p", projectId: "p", projectRoot: "r", workspaceRoot: "r", workspace: "w", workspaceId: "w" };
 for (const src of [location.search, ...[location.href, location.hash, location.pathname, routeHint()].map(s => (String(s || "").match(/\?([^#]*)/) || [])[1]), findRouter()?.state?.location?.searchStr]) {
 if (!src || typeof src !== "string") continue;
 for (const seg of (src.startsWith("?") ? src.slice(1) : src).split("&")) {
 if (!seg) continue;
 const eq = seg.indexOf("="), b = map[decQ(eq < 0 ? seg : seg.slice(0, eq))]; if (!b) continue;
 let v = decQ(eq < 0 ? "" : seg.slice(eq + 1));
 if (b === "r") v = v.replace(/\/+$/, "");
 if (b === "e" && new RegExp(`^${UUID_RE}$`, "i").test(v)) v = v.toLowerCase();
 if (!vals[b].includes(v)) vals[b].push(v);
 }
 }
 return { stripQ, pEnv, pProj, pWs, e: vals.e.join(","), p: vals.p.join(","), r: vals.r.join(","), w: vals.w.join(",") };
    }
    function contextIdentityToken() {
 const sp = parseScopeParts();
 return `${routeKey()}|${sp.e}|${sp.p}|${sp.r}|${sp.w}`;
    }
    function resetScopeAnchor(sp = parseScopeParts()) {
 scopeAnchor = { e: sp.e || sp.pEnv, eT: sp.e && sp.e !== sp.pEnv ? `e=${sp.e}` : "", p: sp.p || sp.pProj, pT: sp.p && sp.p !== sp.pProj ? `p=${sp.p}` : "", r: sp.r, rT: sp.r ? `r=${sp.r}` : "", w: sp.w || sp.pWs, wT: sp.w && sp.w !== sp.pWs ? `w=${sp.w}` : "" };
    }
    function boardScopeRoute() {
 const sp = parseScopeParts(); if (!scopeAnchor) resetScopeAnchor(sp);
 const noHashQ = (s) => String(s || "").replace(/[?#].*$/, ""), q = [];
 const cEnv = String(state.context?.environmentId || state.context?.environment?.id || ""), knownEnv = new RegExp(`^${UUID_RE}$`, "i").test(cEnv) ? cEnv.toLowerCase() : cEnv;
 const tok = (k, v, pV, aV, aT, known) => !v || known && v === known ? "" : pV && v === pV ? "" : aV && v === aV ? aT : `${k}=${v}`;
 for (const t of [tok("e", sp.e, sp.pEnv, scopeAnchor.e, scopeAnchor.eT, knownEnv), tok("p", sp.p, sp.pProj, scopeAnchor.p, scopeAnchor.pT), tok("r", sp.r, "", scopeAnchor.r, scopeAnchor.rT, String(state.projectRoot || "").replace(/\/+$/, "")), tok("w", sp.w, sp.pWs, scopeAnchor.w, scopeAnchor.wT)]) if (t) q.push(t);
 const base = `${noHashQ(location.href)}|${sp.stripQ(location.pathname)}|${sp.stripQ(location.hash?.slice(1))}|${sp.stripQ(routeHint())}|${q.join("&")}`, tid = currentThreadId();
 return tid && tid !== "__NEW__" ? `t:${tid}|${base}` : `d:${base}`;
    }
    function currentThreadId() {
 const paths = [rawRouteHint(), location.pathname].filter(Boolean);
 if (paths.includes("__NEW__")) return "__NEW__";
 for (const path of paths) {
 const promoted = resolvePromotedDraftRoute(path);
 if (promoted) { try { return decodeURIComponent(promoted.slice(promoted.lastIndexOf("/") + 1)); } catch { return "__ROUTE_invalid__"; } }
 if (/(?:^|\/)(?:draft|new)(?:\/|[?#]|$)/i.test(path) || new RegExp(`^\\/?(?:_t3_env_\\/)?(?:projects?|workspaces?)\\/${UUID_RE}\\/?(?:[?#]|$)`, "i").test(path) || new RegExp(`^\\/?${UUID_RE}\\/?(?:[?#]|$)`, "i").test(path)) return "__NEW__";
 if (/^\/?_t3_env_(?:\/|[?#]|$)/i.test(path)) {
 if (/\/\//.test(path.replace(/[?#].*$/, ""))) return "__ROUTE_invalid__";
 const pair = path.match(/^\/?_t3_env_\/([^/?#]+)\/([^/?#]+)(?:[/?#]|$)/i);
 if (!pair) return "__ROUTE_invalid__";
 try {
 const environmentId = decodeURIComponent(pair[1]), threadId = decodeURIComponent(pair[2]);
 if (!/^(?:projects?|workspaces?)$/i.test(environmentId)) return threadId;
 } catch { return "__ROUTE_invalid__"; }
 }
 const match = path.match(/(?:^|\/)(?:threads|_chat)\/([^/?#]+)/i);
 if (match) { const d = decQ(match[1]); return d.toLowerCase() === "new" ? "__NEW__" : d; }
 const native = path.match(new RegExp(`^\\/?${UUID_RE}\\/([^/?#]+)(?:[/?#]|$)`, "i"));
 if (native) { try { return decodeURIComponent(native[1]); } catch { return "__NEW__"; } }
 }
 for (const path of paths) { const m = path.match(new RegExp(`(?:^|\\/)(${UUID_RE})(?:[/?#]|$)`, "i")); if (m) return m[1]; }
 return state.context?.threadId || state.context?.thread?.id || "__NEW__";
    }
 function syncThread(force = false) {
 const threadId = currentThreadId(); if (!force && threadId === state.threadId) return false;
 state.planOpen = false; state.planPinned = false; state.planHovering = false; state.planActivationPointerType = "";
 if (planHandle) planHandle.hidden = true;
 if (liveBoard) liveBoard.hidden = true;
 state.threadId = threadId; boardScopeVersion++; artifactVersion++;
 occlusionBoardRect = null;
 cache.board = null; state.artifact = null; state.boardDraft = ""; delete errors.board;
 boardVersion++; boardLoading = false; boardSignature = ""; boardRenderedSignature = ""; boardRenderKey = "";
 renderLiveBoard();
 return true;
    }
    function resetProjectData() {
 boardScopeVersion++; requestVersion++; memoryVersion++;
 for (const k of ["hooks", "skills", "plugins", "subagents", "orchestration", "mcp", "connections", "overview", "memory", "worktree", "dream", "health", "agents", "board", "settings"]) { cache[k] = null; delete errors[k]; }
 state.scope = "project";
 state.importScope = defaultScope(); state.subagentScope = defaultScope(); state.agentsTarget = defaultScope();
 state.memoryProject = "current";
 embedVersion++; embedProjectKey = "";
 if (cache.embed) { const { vectorStats, vectorStatsError, ...serviceStatus } = cache.embed; cache.embed = serviceStatus; }
 state.artifact = null; state.boardDraft = ""; state.orchestrationDraft = null; state.settingsDirty = false; state.settingsDraft = {}; state.clearedHostFields.clear(); state.settingsRuleDirty = false; state.settingsRule = ""; settingsSelectionVersion++;
 boardVersion++; boardLoading = false; boardSignature = ""; boardRenderedSignature = ""; boardRenderKey = ""; renderLiveBoard();
 state.hookDraft = null; state.supersedeItems = []; state.selectedMemory = null;
 if (drafts.__new && !drafts.__new.migratedFromGlobal && drafts.__new.projectRoot !== state.projectRoot) delete drafts.__new;
 if (state.open && state.tab === "memory" && content) renderMemory();
    }
    function checkRoute() {
 const route = routeKey(), changed = route !== lastRoute, prevScope = lastBoardRoute, scopeChanged = boardScopeRoute() !== prevScope;
 if (scopeChanged) resetScopeAnchor();
 const scopeRoute = boardScopeRoute();
 if (changed) lastRoute = route; lastBoardRoute = scopeRoute;
 if (scopeChanged || changed && currentThreadId() === "__NEW__") {
 contextVersion++; contextLoading = true;
 state.connected = false; state.context = null; state.threadId = null; state.projectRoot = null; state.contextError = "";
 resetProjectData();
 }
 const threadChanged = syncThread(scopeChanged);
 if (changed && state.open && ["agents", "subagents"].includes(state.tab)) renderTab();
 if (changed) refreshContext(false, { sameScopeRoute: !scopeChanged && state.connected });
 if (threadChanged && !changed) pollBoard();
    }
    async function refreshContext(force = false, { sameScopeRoute = false } = {}) {
 const requestedRoute = routeHint();
 const requestedIdentity = contextIdentityToken();
 if (disposed) return;
 const unpromotedDraft = requestedRoute === "__NEW__" || /^\/?(?:_t3_env_\/[^/?#]+\/)?draft(?:\/|[?#]|$)/i.test(requestedRoute);
 if (lastBoardRoute && boardScopeRoute() !== lastBoardRoute) {
 resetScopeAnchor(); lastRoute = routeKey(); lastBoardRoute = boardScopeRoute();
 boardScopeVersion++; state.context = null; syncThread(true); sameScopeRoute = false;
 }
 const version = ++contextVersion, before = state.projectRoot, beforeThread = state.threadId, startRoute = boardScopeRoute();
 const isCurrent = () => {
 const routeChanged = routeHint() !== requestedRoute || contextIdentityToken() !== requestedIdentity;
 if (disposed || version !== contextVersion || routeChanged) {
 if (!disposed && routeChanged) checkRoute();
 return false;
 }
 return true;
 };
 const liveSameScopeDraft = () => {
 if (!state.open || state.tab !== "board" || boardScopeRoute() !== startRoute) return false;
 const v = boardViewSnapshots.get(content), inp = content.querySelector('[name="board-step-draft"]');
 return Boolean(v && v.route === startRoute && v.threadId === (beforeThread || "") && v.projectRoot === (before || "") && inp && (boardEditorActive() || boardEditorNeedsSync || inp.value || state.boardDraft));
 };
 const hadSameScopeBoardDraft = liveSameScopeDraft();
 try {
 if (unpromotedDraft) throw new Error(tr("草稿尚未创建会话，请先发送消息", "Send a message to create a conversation for this draft"));
 const rawRoute = rawRouteHint(), promotedRoute = resolvePromotedDraftRoute(rawRoute);
 const context = await request("hub:getContext", { threadHint: promotedRoute ? `t3code://app/#${promotedRoute}` : location.href, routeHint: requestedRoute });
 if (!isCurrent()) return;
 const sameScope = boardScopeRoute() === startRoute;
 state.context = context; state.projectRoot = context.projectRoot || context.project?.root || context.project?.path || null;
 if (scopeAnchor && sameScope) {
 const cEnv = String(context.environmentId || context.environment?.id || "");
 if (!scopeAnchor.e && cEnv) scopeAnchor.e = new RegExp(`^${UUID_RE}$`, "i").test(cEnv) ? cEnv.toLowerCase() : cEnv;
 if (!scopeAnchor.p && (context.projectId || context.project?.id)) scopeAnchor.p = String(context.projectId || context.project?.id);
 if (!scopeAnchor.r && state.projectRoot) scopeAnchor.r = String(state.projectRoot).replace(/\/+$/, "");
 if (!scopeAnchor.w && (context.workspaceId || context.workspace?.id)) scopeAnchor.w = String(context.workspaceId || context.workspace?.id);
 if (scopeAnchor.e === (new RegExp(`^${UUID_RE}$`, "i").test(cEnv) ? cEnv.toLowerCase() : cEnv)) scopeAnchor.eT = "";
 if (scopeAnchor.r === String(state.projectRoot || "").replace(/\/+$/, "")) scopeAnchor.rT = "";
 lastRoute = routeKey(); lastBoardRoute = boardScopeRoute();
 for (const surface of [content, liveBoard]) {
 const view = boardViewSnapshots.get(surface);
 if (view?.route === startRoute && view.projectRoot === (state.projectRoot || "") && view.threadId === (state.threadId || "")) view.route = lastBoardRoute;
 }
 }
 state.connected = true; state.contextError = "";
 } catch (error) {
 if (!isCurrent()) return;
 state.contextError = errorText(error); state.context = null;
 state.projectRoot = !unpromotedDraft && ((hadSameScopeBoardDraft && boardScopeRoute() === startRoute && content.querySelector('[name="board-step-draft"]')) || liveSameScopeDraft()) ? before : null;
 if (unpromotedDraft) state.threadId = null;
 state.connected = false;
 }
 if (!isCurrent()) return;
 contextLoading = false;
 const keepDisconnectedDraft = Boolean(!unpromotedDraft && !state.connected && ((hadSameScopeBoardDraft && boardScopeRoute() === startRoute && content.querySelector('[name="board-step-draft"]')) || liveSameScopeDraft()));
 if (!(keepDisconnectedDraft && currentThreadId() === "__NEW__" && beforeThread && beforeThread !== "__NEW__")) syncThread();
 if (before !== state.projectRoot) {
 resetProjectData();
 } else if (!state.projectRoot) {
 state.scope = "project"; state.subagentScope = state.agentsTarget = state.importScope = "global";
 state.memoryProject = "current";
 }
 renderChrome();
 if (force && before === state.projectRoot && state.tab === "board" && content.querySelector('[name="board-step-draft"]')) boardEditorNeedsSync = true;
 const hadDraft = Boolean(before === state.projectRoot && state.tab === "board" && (boardEditorNeedsSync || content.querySelector('[name="board-step-draft"]')));
 const boardPoll = pollBoard(); positionConversationTools();
 if (state.open) {
 if (!state.connected) {
 if (keepDisconnectedDraft) {
 boardRenderedSignature = ""; boardTabRenderPending = true; if (force) boardEditorNeedsSync = true;
 toast(state.contextError || tr("连接失败，已保留草稿，等待自动同步或手动刷新重试", "Connection failed; draft preserved. Waiting for automatic sync or a manual refresh."), true);
 } else content.innerHTML = inlineError(state.contextError);
 } else if (hadDraft) { await boardPoll; }
 else { renderTab(); await loadTab(force); }
 }
    }
    async function readCatalog(key, action, payload) {
 try { return await request(action, payload); }
 catch (error) {
 if (key === "hooks" && /unknown action|not (?:yet )?(?:wired|implemented|supported)|unsupported|not found|尚未接入/i.test(errorText(error))) return { items: [], unavailable: true };
 throw error;
 }
    }
    async function loadTab(force = false) {
 if (disposed || !state.open) return;
 const tab = state.tab;
 const version = ++requestVersion;
 const projectRoot = state.projectRoot;
 const identity = typeof contextIdentityToken === "function" ? contextIdentityToken() : "", ctxVer = typeof contextVersion === "number" ? contextVersion : 0;
 const isCurrent = () => !disposed && version === requestVersion && (typeof contextVersion !== "number" || ctxVer === contextVersion) && projectRoot === state.projectRoot && (typeof contextIdentityToken !== "function" || contextIdentityToken() === identity);
 const load = async (key, action, payload) => {
 if (cache[key] && !force) return;
 delete errors[key];
 try {
 const data = await readCatalog(key, action, payload);
 if (!isCurrent()) return;
 cache[key] = data;
 if (key === "agents") seedAgentDrafts(data, projectRoot);
 } catch (error) {
 if (isCurrent()) errors[key] = error;
 }
 };
 if (tab === "memory") {
 const confirmedRoot = memoryProjectReady() ? state.projectRoot : null;
 const localStatus = [load("connections", "memory:connections", {}), refreshMemoryAgentAccess(force), refreshEmbed(false, force, confirmedRoot)];
 if (confirmedRoot) {
  localStatus.push(load("overview", "memory:overview", { projectRoot: confirmedRoot }), load("worktree", "memory:worktreeInfo", { projectRoot: confirmedRoot }));
 } else {
  for (const key of ["overview", "memory", "worktree", "health"]) { cache[key] = null; delete errors[key]; }
 }
 await Promise.all(localStatus);
 if (isCurrent() && confirmedRoot && memoryProjectReady() && state.projectRoot === confirmedRoot) await loadMemories(false);
 }
 if (!isCurrent() || state.tab !== tab) return;
 if (tab === "board" && boardEditorActive()) boardTabRenderPending = true;
 else renderTab();
 renderChrome();
 if (tab === "memory") renderMemoryRuntime();
    }
    async function loadMemories(render = true) {
 const version = ++memoryVersion;
 delete errors.memory;
 if (!memoryProjectReady()) {
  cache.memory = null;
  if (!disposed && render && state.tab === "memory") renderMemoryList();
  return false;
 }
 const payload = memoryPayload();
 const projectRoot = payload.projectRoot, ctxVer = contextVersion, identity = contextIdentityToken();
 try {
 if (!projectRoot) return false;
 const data = await request(payload.query ? "memory:search" : "memory:list", payload);
 if (disposed || version !== memoryVersion || ctxVer !== contextVersion || projectRoot !== state.projectRoot || !memoryProjectReady() || identity !== contextIdentityToken()) return false;
 cache.memory = data;
 } catch (error) { if (!disposed && version === memoryVersion && ctxVer === contextVersion && projectRoot === state.projectRoot && memoryProjectReady()) errors.memory = error; }
 if (!disposed && render && state.tab === "memory") { renderMemoryList(); renderChrome(); }
 return true;
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
    async function refreshEmbed(render = true, force = false, projectRoot = memoryProjectReady() ? state.projectRoot : null) {
 const scopedRoot = memoryProjectReady() && projectRoot === state.projectRoot ? projectRoot : null;
 const projectKey = scopedRoot || "";
 if (cache.embed && embedProjectKey === projectKey && !force && !cache.embed.downloadJob?.active && !cache.embed.vectorStats?.reindexing) return;
 const version = ++embedVersion;
 const ctxVer = contextVersion, identity = contextIdentityToken();
 try {
 const response = await request("embed:status", scopedRoot ? { projectRoot: scopedRoot } : {});
 if (disposed || version !== embedVersion || ctxVer !== contextVersion || identity !== contextIdentityToken() || scopedRoot && (state.projectRoot !== scopedRoot || !memoryProjectReady())) return;
 const data = { ...response };
 if (!scopedRoot) { delete data.vectorStats; delete data.vectorStatsError; }
 embedProjectKey = projectKey;
 const wasActive = cache.embed?.downloadJob?.active;
 const prevVs = cache.embed?.vectorStats;
 const prevMemory = [cache.embed?.activeMb, cache.embed?.ceilingMb, cache.embed?.cacheMb, cache.embed?.rssMb, prevVs?.activeMb, prevVs?.ceilingMb, prevVs?.cacheMb].join("/");
 const nextMemory = [data.activeMb, data.ceilingMb, data.cacheMb, data.rssMb, data.vectorStats?.activeMb, data.vectorStats?.ceilingMb, data.vectorStats?.cacheMb].join("/");
 const prevSig = prevVs ? `${prevVs.syncedVectors}/${prevVs.totalMemories}:${prevVs.reindexing}` : cache.embed?.vectorStatsError || "";
 const nextSig = data.vectorStats ? `${data.vectorStats.syncedVectors}/${data.vectorStats.totalMemories}:${data.vectorStats.reindexing}` : data.vectorStatsError || "";
 const wasWaiting = state.embedReadyDeadline > 0;
 cache.embed = data;
 if (state.tab === "memory") renderMemoryRuntime();
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
 if (!disposed && version === embedVersion) { errors.embed = error; if (state.tab === "memory") renderMemoryRuntime(); if (render && state.tab === "memory") toast(errorText(error), true); }
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
 if (!root || disposed) return;
 if (state.open && focus) focusReturn = document.activeElement;
 root.classList.toggle("is-open", state.open);
 handle?.setAttribute("aria-expanded", String(state.open));
 drawer.setAttribute("aria-hidden", String(!state.open));
 drawer.inert = !state.open;
 positionConversationTools();
 if (state.open) {
 renderTab();
 if (state.context) loadTab();
 else if (state.contextError) content.innerHTML = inlineError(state.contextError);
 if (focus) later(() => (root.querySelector(`[data-tab="${state.tab}"]`) || content)?.focus({ preventScroll: true }), 50);
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
 }
    }
    function syncOcclusion() {
 if (!root || disposed) return;
 const visible = (element) => {
 if (!element || element.hidden || !element.getClientRects().length) return false;
 for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
 if (ancestor.hidden || ancestor.getAttribute?.("aria-hidden") === "true" || ancestor.getAttribute?.("data-closed") != null || ancestor.tagName === "DIALOG" && !ancestor.open) return false;
 const css = getComputedStyle(ancestor);
 if (css.display === "none" || css.visibility === "hidden" || css.visibility === "collapse" || css.opacity != null && css.opacity !== "" && Number(css.opacity) === 0) return false;
 }
 return true;
 };
 const editor = visibleComposer(), composer = editor && composerSurface(editor);

 const wasOccluded = root.classList.contains("is-occluded");
 const surfaces = [root, handle, planHandle, liveBoard].filter(visible);
 if (liveBoard && !liveBoard.hidden && liveBoard.getClientRects().length) occlusionBoardRect = liveBoard.getBoundingClientRect();
 else if (!wasOccluded || state.open) occlusionBoardRect = null;
 const surfaceRects = surfaces.map((surface) => surface.getBoundingClientRect());
 if (composer) surfaceRects.push(composer.getBoundingClientRect());
 if (wasOccluded && occlusionBoardRect) surfaceRects.push(occlusionBoardRect);
 const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
 const nativeDialog = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog[open]')].some((element) => {
 if (root.contains(element) || !visible(element)) return false;
 const rect = element.getBoundingClientRect();
 if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= innerWidth || rect.top >= innerHeight) return false;
 if (element.getAttribute("aria-modal") === "true" || element.getAttribute("role") === "alertdialog" || element.matches?.(":modal")) return true;
 return surfaceRects.some((surface) => overlaps(rect, surface));
 });
 root.classList.toggle("is-occluded", nativeDialog);
    }
    function positionHandle() {
 positionConversationTools();
    }
    function startBoardDrag(event) {
 if (event.button !== 0 || !event.target.closest?.("[data-board-drag]")) return;
 const rect = liveBoard.getBoundingClientRect();
 boardDrag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: rect.left, y: rect.top, before: boardPosition, moved: false };
 liveBoard.setPointerCapture?.(event.pointerId);
    }
    function moveBoardDrag(event) {
 if (!boardDrag || boardDrag.pointerId !== event.pointerId) return;
 const dx = event.clientX - boardDrag.startX, dy = event.clientY - boardDrag.startY;
 if (Math.abs(dx) + Math.abs(dy) < 4 && !boardDrag.moved) return;
 boardDrag.moved = true;
 event.preventDefault();
 boardPosition = { x: boardDrag.x + dx, y: boardDrag.y + dy };
 positionConversationTools();
    }
    function endBoardDrag(event) {
 if (!boardDrag || boardDrag.pointerId !== event.pointerId) return;
 const moved = boardDrag.moved;
 boardDrag = null;
 liveBoard.releasePointerCapture?.(event.pointerId);
 if (moved) {
 boardPosition = { x: parseFloat(liveBoard.style.left), y: parseFloat(liveBoard.style.top) };
 storageSet("t3-hub-dashboard-position-v1", JSON.stringify(boardPosition));
 }
    }
    function cancelBoardDrag(event) {
 if (!boardDrag || boardDrag.pointerId !== event.pointerId) return;
 boardPosition = boardDrag.before;
 boardDrag = null;
 positionConversationTools();
    }

    function onClick(event) {
 const target = event.target.closest("[data-action]");
 if (!target || (!root.contains(target) && !liveBoard?.contains(target)) || target.disabled) return;
 const action = target.dataset.action;
 const id = target.dataset.id;
 if (action === "open-memory") openMemoryFromTitle();
 else if (action === "set-theme") setTheme(target.dataset.theme);
 else if (action === "open-board-studio") { switchTab("board"); setOpen(true); }
 else if (action === "dashboard-tab") { switchTab(target.dataset.tab); setOpen(true); }
 else if (action === "reset-dashboard-position") { boardPosition = null; storageSet("t3-hub-dashboard-position-v1", "null"); positionConversationTools(); }
 else if (action === "set-width") setWidth(target.dataset.width);
 else if (action === "library-view") { state.libraryView = target.dataset.view; renderTab(); loadTab(); }
 else if (action === "mcp-filter") { state.mcpFilter = target.dataset.filter; renderMcpList(); }
 else if (action === "hooks-fold") { state.hooksOpen = !state.hooksOpen; }
 else if (action === "resource-filter") { resourceFilter(target.dataset.domain).agent = target.dataset.agent; renderTab(); }
 else if (action === "resource-toggle") toggleResource(target);
 else if (action === "resource-toggle-all") toggleResource(target, true);
 else if (action === "save-mcp-mode") saveMcpMode(target);
 else if (action === "set-cooperation-mode") setCooperationMode(target, target.dataset.mode);
 else if (action === "toggle-board") { state.boardExpanded = !state.boardExpanded; storageSet("t3-hub-dashboard-expanded-v1", state.boardExpanded); renderLiveBoard(); }
 else if (action === "board-background") { state.boardBackground = !state.boardBackground; renderLiveBoard(); if (state.tab === "board") renderBoardTab(); }
 else if (action === "board-add") updateBoard(target, "add");
 else if (action === "board-step") { const index = resolveBoardClick(target, "step"); if (index === null) rejectStaleBoardClick(); else updateBoard(target, "toggle", index); }
 else if (action === "board-clear") updateBoard(target, "clear");
 else if (action === "read-artifact") { const index = resolveBoardClick(target, "artifact"); if (index === null) rejectStaleBoardClick(); else readArtifact(index, target, liveBoard?.contains(target) ? "reveal" : "open"); }
 else if (action === "reveal-artifact") revealArtifact(target);
 else if (action === "artifact-folder") revealArtifact(target, "folder");
 else if (action === "close-artifact") { artifactVersion++; state.artifact = null; renderBoardTab(); }
 else if (action === "memory-scope-filter") setMemoryScope(target.dataset.scope);
 else if (action === "open-memory-folder" && memoryWriteReady()) busy("memory-folder", target, () => request("memory:openFolder", { projectRoot: selectedMemoryRoot() }));
 else if (action === "promote-memory") promoteMemory(id, target);
 else if (action === "trim-embed") trimEmbedCache(target);
 else if (action === "disable-legacy-orchestration") disableLegacyOrchestration(target);
 else if (action === "toggle-t3-prompt-suggestions") toggleT3PromptSuggestions(target);
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
 else if (action === "new-hook") { state.hookDraft ||= { title: "", event: "Stop", matcher: "", command: "", scope: "global" }; renderHooks(); content.querySelector('[name="hook-title"]')?.focus(); }
 else if (action === "cancel-hook") { state.hookDraft = null; renderHooks(); }
 else if (action === "save-hook") saveHook(target);
 else if (action === "delete-hook") target.closest(".hub-hook-card").querySelector("[data-hook-confirm]").hidden = false;
 else if (action === "cancel-delete-hook") target.closest("[data-hook-confirm]").hidden = true;
 else if (action === "confirm-delete-hook") deleteHook(id, target);
 else if (action === "remove-skill") target.closest(".hub-card,.hub-resource-row").querySelector("[data-skill-confirm]").hidden = false;
 else if (action === "cancel-remove-skill") target.closest("[data-skill-confirm]").hidden = true;
 else if (action === "confirm-remove-skill") removeSkill(id, target);
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
 else if (action === "toggle-mcp-add") { state.mcpAddOpen = !state.mcpAddOpen; target.setAttribute("aria-expanded", String(state.mcpAddOpen)); renderMcpForm(); }
 else if (action === "mcp-form-kind") { state.mcpForm.kind = target.dataset.kind; renderMcpForm(); }
 else if (action === "save-mcp") saveMcp(target);
 else if (action === "sync-mcp") busy("sync-mcp", target, async () => { const result = await request("mcp:syncClis", { projectRoot: state.projectRoot }); if (!disposed) toast(tr(`路由已同步${result.syncedTargets?.length ? ` · ${result.syncedTargets.length} 端` : ""}`, "CLI router synchronized")); });
 else if (action === "switch-embed") switchEmbed(target);
 else if (action === "refresh-embed") { refreshEmbed(true, true).then(() => { if (!disposed) renderEngine(); }); }
 else if (action === "memory-module") { state.memoryModule = target.dataset.module; state.selectedMemory = null; cache.memory = null; renderMemoryList(); loadMemories(); }
 else if (action === "refresh-memory") loadMemories();
 else if (action === "refresh-memory-connections") { cache.connections = null; loadTab(true); }
 else if (action === "memory-access-setup") runMemorySetup();
 else if (action === "memory-access-copy-prompt") copyMemorySetupPrompt();
 else if (action === "memory-access-refresh") refreshMemoryAgentAccess(true);
 else if (action === "copy-memory-mcp-config") copyMemoryMcpConfig();
 else if (action === "test-memory-vector") runMemoryVectorTest();
 else if (action === "refresh-memory-runtime") refreshEmbed(true, true);
 else if (action === "open-memory") { state.selectedMemory = state.selectedMemory === id ? null : id; renderMemoryList(); }
 else if (action === "new-memory") openNewMemory();
 else if (action === "cancel-new-memory") { if (drafts.__new) drafts.__new.open = false; renderNewMemory(); }
 else if (action === "create-memory") saveMemory(null, target);
 else if (action === "save-memory") saveMemory(id, target);
 else if (action === "pin-memory" && memoryWriteReady()) { const projectRoot = selectedMemoryRoot(), selection = memorySelection(); busy(`pin:${id}`, target, async () => { const result = await request("memory:pinToAgentsMd", { id, projectRoot }); if (!disposed && selection === memorySelection()) { cache.agents = null; toast(result.message || tr("已置顶到项目 AGENTS.md", "Pinned to project AGENTS.md")); } }); }
 else if (action === "delete-memory") target.closest(".hub-memory-detail").querySelector("[data-delete-confirm]").hidden = false;
 else if (action === "cancel-delete-memory") target.closest("[data-delete-confirm]").hidden = true;
 else if (action === "confirm-delete-memory") deleteMemory(id, target);
 else if (action === "agents-target") { state.agentsTarget = target.dataset.target; renderAgents(); }
 else if (action === "open-project-agents") { state.agentsTarget = projectDisabled() ? "global" : "project"; switchTab("agents"); }
 else if (action === "back-to-settings") switchTab("settings");
 else if (action === "save-agents") saveAgents(target);
 else if (action === "inject-soft-route") injectSoftRoute(target);
 else if (action === "sync-project-rule-reference") syncProjectRuleReference(target);
    }
    function onInput(event) {
 const input = event.target;
 const name = input.name;
 if (name === "board-step-draft") { state.boardDraft = input.value; boardDraftEditSeq++; return; }
 if (name === "native-setting") {
 const key = input.dataset.settingsKey;
 if (!editableSettingKeys().includes(key)) return;
 editNativeSetting(key, input.value);
 syncNativeSettingField(input, key);
 return;
 }
 if (name === "native-rule") { state.settingsRule = input.value; state.settingsRuleDirty = true; return; }
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
 if (name === "memoryAgentAccess") { setMemoryAgentAccess(!!input.checked); return; }
 if (name === "resource-status") { resourceFilter(input.dataset.domain).status = input.value; renderTab(); return; }
 if (name === "mcp-mode-scope") {
 if (!["project", "global"].includes(input.value)) return;
 const controls = input.closest(".hub-mcp-mode-controls");
 const modeSelect = controls?.querySelector('[name="mcp-mode"]');
 const server = mcpServers().find((item) => item.name === input.dataset.name);
 if (!server || !modeSelect) return;
 modeSelect.value = mcpModeChoice(server, input.value);
 const inheritOption = modeSelect.querySelector?.('option[value="inherit"]');
 if (inheritOption) inheritOption.hidden = input.value !== "project";
 const hint = controls.querySelector(".hub-mcp-mode-hint");
 const reason = server.modeConflict
 ? tr("名称冲突已暂停；可保存“不经 Hub”。启用前请先解决冲突。", "Name conflict paused; you can save “Bypass Hub”. Resolve the conflict before enabling.")
 : server.launchable === false ? tr("服务缺少可运行入口；可保存“不经 Hub”关闭转发。", "No runnable endpoint; save “Bypass Hub” to turn forwarding off.") : "";
 if (hint) hint.textContent = mcpModeScopeHint(server, input.value, reason);
 return;
 }
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
 else if (name === "new-memory-scope") { drafts.__new ||= {}; drafts.__new.scope = ["project", "worktree"].includes(input.value) ? input.value : "project"; }
 else if (name?.startsWith("hook-") && state.hookDraft) state.hookDraft[name.slice(5)] = input.value;
 else if (name === "new-memory-supersedes") { drafts.__new ||= {}; drafts.__new.supersedes = input.value; }
 else if (name === "importScope") state.importScope = input.value;
 else if (name === "mcp-transport") { state.mcpForm.transport = input.value; renderMcpForm(); }
 else if (name === "embed-model") { state.modelChoice = input.value; renderEngine(); }
 else if (name === "useMirror") state.useMirror = input.checked;
 else if (name === "memoryProject") {
 state.memoryProject = "current";
 if (drafts.__new) drafts.__new.supersedes = "";
 state.supersedeItems = [];
 state.supersedeLoading = false;
 renderNewMemory();
 state.selectedMemory = null;
 cache.memory = null;
 memoryVersion++;
 renderMemoryList();
 if (memoryProjectReady()) loadMemories();
 if (drafts.__new?.open && memoryProjectReady()) openNewMemory();
 } else if (name === "new-memory-module") { drafts.__new ||= {}; drafts.__new.module = input.value; }
    }
    function onKeydown(event) {
 const key = event.key.toLowerCase();
 if (key === "escape" && state.planOpen) { event.preventDefault(); setPlanPopover(false); return; }
 if (((event.metaKey || event.ctrlKey) && event.shiftKey && key === "k") || (event.altKey && !event.metaKey && !event.ctrlKey && key === "h")) {
 if (event.repeat) return;
 event.preventDefault();
 setOpen(!state.open);
 } else if (key === "escape" && state.open && !root.classList.contains("is-occluded")) { event.preventDefault(); setOpen(false); }
 else if ((event.metaKey || event.ctrlKey) && key === "s" && state.open && state.tab === "settings" && root.contains(document.activeElement)) { event.preventDefault(); const rule = document.activeElement?.name === "native-rule"; saveNativeSettings(root.querySelector(`[data-action="${rule ? "save-native-rule" : "save-native-settings"}"]`), rule); }
    }
    function onEditorKeydown(event) {
 const input = event.target;
 if (input.matches?.("[data-board-drag]") && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
 event.preventDefault();
 const step = event.shiftKey ? 40 : 10;
 const x = parseFloat(liveBoard.style.left) || 8, y = parseFloat(liveBoard.style.top) || 8;
 boardPosition = { x: x + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0), y: y + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0) };
 positionConversationTools();
 boardPosition = { x: parseFloat(liveBoard.style.left), y: parseFloat(liveBoard.style.top) };
 storageSet("t3-hub-dashboard-position-v1", JSON.stringify(boardPosition));
 return;
 }
 if (input.name === "board-step-draft" && event.key === "Enter" && !event.isComposing) { event.preventDefault(); updateBoard(input, "add"); return; }
 if (input.getAttribute("role") === "tab" && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
 event.preventDefault();
 const tabs = ["memory", "skills", "plugins", "subagents", "hooks", "settings"];
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
 const projectRoot = state.projectRoot, version = contextVersion, route = routeKey();
 const item = hookItems().find((entry) => String(entry.id) === id);
 const projectWrite = scope === "project" || projectOwnedHook(item);
 if (!item || item.readonly || item.unavailable) return;
 if (projectWrite) { toast(tr("项目 Hook 暂只读，现有配置保持不变", "Project hooks are read-only; existing settings remain unchanged"), true); return; }
 if (!["off", "global"].includes(scope)) return;
 await busy(`${domain}-scope:${id}`, element, async () => {
 await request("hooks:toggle", { id, scope, projectRoot: null });
 if (disposed || version !== contextVersion || projectRoot !== state.projectRoot || route !== routeKey()) return;
 const refreshed = await request("hooks:list", { projectRoot: projectContextReady() ? projectRoot : null });
 if (disposed || version !== contextVersion || projectRoot !== state.projectRoot || route !== routeKey()) return;
 cache.hooks = refreshed;
 if (state.tab === "hooks") renderHooks();
 renderChrome();
 const updated = hookItems().find((entry) => String(entry.id) === id);
 const confirmed = updated?.scope === scope && (scope === "off" ? updated?.configured === false && updated?.configurationStatus === "not-configured" : updated?.configured === true && updated?.configurationStatus === "configured");
 if (!confirmed) { toast(tr("设置已提交，实际配置尚未全部确认，请查看卡片状态。", "Setting submitted, but configuration is not fully confirmed; review the card."), true); return; }
 toast(tr("Hook 配置已保存并读取确认；当前会话是否加载取决于宿主。", "Hook configuration saved and read back; the host determines when the session loads it."));
 });
    }
    async function saveHook(element = content.querySelector('[data-action="save-hook"]')) {
 if (state.hookDraft) state.hookDraft.id ||= `hook-${window.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`}`;
 const draft = { ...state.hookDraft }, projectRoot = state.projectRoot, version = contextVersion, route = routeKey();
 if (!draft.command?.trim() || !draft.title?.trim()) { toast(tr("请填写名称和执行命令", "Enter a name and command"), true); return; }
 if (draft.scope === "project") { toast(tr("项目 Hook 暂只读，现有配置保持不变", "Project hooks are read-only; existing settings remain unchanged"), true); return; }
 if (!["off", "global"].includes(draft.scope)) return;
 await busy("save-hook", element, async () => {
 await request("hooks:save", { ...draft, projectRoot: null });
 if (disposed || version !== contextVersion || projectRoot !== state.projectRoot || route !== routeKey()) return;
 state.hookDraft = null; cache.hooks = null;
 if (state.tab === "hooks") await loadTab(true);
 toast(tr("自定义 Hook 已保存", "Custom hook saved"));
 });
    }
    async function deleteHook(id, element) {
 const projectRoot = state.projectRoot, version = contextVersion, route = routeKey(), item = hookItems().find((entry) => String(entry.id) === id);
 if (!item || item.builtin || item.readonly) return;
 if (projectOwnedHook(item)) { toast(tr("项目 Hook 暂只读，现有配置保持不变", "Project hooks are read-only; existing settings remain unchanged"), true); return; }
 await busy(`delete-hook:${id}`, element, async () => {
 await request("hooks:delete", { id, projectRoot: null });
 if (disposed || version !== contextVersion || projectRoot !== state.projectRoot || route !== routeKey()) return;
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
    function memorySelection() { return JSON.stringify([state.memoryProject, selectedMemoryRoot(), contextVersion, contextIdentityToken()]); }
    async function consolidateMemory(element) {
 if (!memoryWriteReady()) return;
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
 if (typeof memoryWriteReady === "function" && !memoryWriteReady()) return;
 const selection = memorySelection(), projectRoot = selectedMemoryRoot(), key = memoryDraftKey(id);
 if (!projectRoot) return;
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
 const projectRoot = scope === "project" || projectContextReady() ? state.projectRoot : undefined, version = contextVersion, identity = contextIdentityToken();
 if (!projectWriteReady(scope)) return;
 await busy("import", element, async () => {
 const result = await request("skills:importGitHub", { repoInput, scope, projectRoot });
 if (disposed || version !== contextVersion || (scope === "project" && projectRoot !== state.projectRoot) || contextIdentityToken() !== identity) return;
 state.importRepo = "";
 cache.skills = null;
 toast(result.message || tr("导入完成，技能已按范围启用", "Imported and enabled for the selected scope"));
 if (state.tab === "skills") { renderSkills(); await loadTab(true); }
 });
    }
    async function setSkillScope(id, scope, element) {
 const projectRoot = scope === "project" || projectContextReady() ? state.projectRoot : undefined, version = contextVersion, identity = contextIdentityToken();
 if (!projectWriteReady(scope)) return;
 await busy(`scope:${id}`, element, async () => {
 const result = await request("skills:setScope", { id, scope, projectRoot });
 if (disposed || version !== contextVersion || (scope === "project" && projectRoot !== state.projectRoot) || contextIdentityToken() !== identity) return;
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
 if (!memoryWriteReady()) return;
 const payload = memoryPayload();
 const selection = memorySelection();
 if (!payload.projectRoot) return;
 const record = memoryRecords().find((item) => memoryId(item) === id);
 const draft = id == null ? { ...drafts.__new } : { title: record?.title || record?.name || "", content: memoryBody(record || {}), ...drafts[memoryDraftKey(id)] };
 if (!draft.title?.trim() || !draft.content?.trim()) { toast(tr("请填写标题和记忆内容", "Enter a title and memory content"), true); return; }
 const key = id == null ? null : memoryDraftKey(id);
 await busy(`memory-save:${id || "new"}`, element, async () => {
 const requestedScope = id == null ? draft.scope || (state.memoryScope === "worktree" ? "worktree" : payload.scope) : record?.scope || payload.scope;
 const saveScope = requestedScope === "worktree" ? "worktree" : "project";
 if (!memoryWriteReady(saveScope)) return;
 const result = await request("memory:save", { ...payload, scope: saveScope, id: id || undefined, title: draft.title.trim(), content: draft.content, module: draft.module || record?.module || record?.category || "topics", ...(id == null && draft.supersedes ? { supersedesId: draft.supersedes } : {}) });
 if (disposed) return;
 if (id == null && drafts.__new?.projectRoot === payload.projectRoot) delete drafts.__new;
 else if (drafts[key]?.content === draft.content) delete drafts[key];
 if (selection === memorySelection()) {
 state.selectedMemory = result.item?.id || result.memory?.id || result.id || id;
 if (id == null && saveScope === "worktree") state.memoryScope = "worktree";
 else if (id == null && state.memoryScope === "worktree") state.memoryScope = "project";
 if (state.tab === "memory") { renderMemory(); await refreshMemoryOverview(); await loadMemories(); }
 }
 toast(tr("记忆已保存", "Memory saved"));
 });
    }
    async function deleteMemory(id, element) {
 if (!memoryWriteReady()) return;
 const payload = memoryPayload();
 const selection = memorySelection();
 if (!payload.projectRoot) return;
 const key = memoryDraftKey(id);
 await busy(`memory-delete:${id}`, element, async () => {
 await request("memory:delete", { id, projectRoot: payload.projectRoot, scope: payload.scope });
 if (!disposed && selection === memorySelection()) { delete drafts[key]; if (state.selectedMemory === id) state.selectedMemory = null; if (state.tab === "memory") { await refreshMemoryOverview(); await loadMemories(); } toast(tr("记忆已删除", "Memory deleted")); }
 });
    }
    async function refreshMemoryOverview() {
 if (!memoryProjectReady()) { cache.overview = null; return; }
 const projectRoot = state.projectRoot, ctxVer = contextVersion, identity = contextIdentityToken();
 try {
 const data = await request("memory:overview", { projectRoot });
 if (!disposed && ctxVer === contextVersion && identity === contextIdentityToken() && memoryProjectReady() && state.projectRoot === projectRoot) { cache.overview = data; delete errors.overview; if (state.tab === "memory") renderMemoryNav(); }
 } catch (error) { if (!disposed && ctxVer === contextVersion && identity === contextIdentityToken() && memoryProjectReady() && state.projectRoot === projectRoot) { errors.overview = error; if (state.tab === "memory") renderMemoryNav(); } }
    }
    async function saveAgents(element) {
 const draft = agentDraft();
 if (!draft) return;
 if (!projectWriteReady(state.agentsTarget)) return;
 const key = agentKey();
 const target = state.agentsTarget;
 const projectRoot = state.projectRoot, version = contextVersion;
 const value = draft.content;
 await busy(`agents-save:${key}`, element, async () => {
 if (target === "project" && (!projectContextReady() || version !== contextVersion || projectRoot !== state.projectRoot)) return;
 const result = await hubRpc("agentsMd:save", { target, content: value, expectedContent: draft.saved, projectRoot });
 if (disposed || (target === "project" && (!projectContextReady() || version !== contextVersion || projectRoot !== state.projectRoot))) return;
 if (result?.ok === false && !result?.sourceSaved) throw new Error(result.error || tr("规则保存失败", "Could not save rules"));
 const readback = await request("agentsMd:get", { projectRoot });
 if (disposed || (target === "project" && (!projectContextReady() || version !== contextVersion || projectRoot !== state.projectRoot))) return;
 const confirmed = target === "project" ? readback.projectContent : readback.globalContent;
 if (confirmed !== value) throw new Error(tr("保存后规则已变化，请重新读取并合并修改", "Rules changed after saving; reload and merge your edits"));
 draft.saved = value;
 if (version === contextVersion && projectRoot === state.projectRoot) cache.agents = readback;
 draft.syncedTargets = result.syncedTargets || result.syncedClis || [];
 if (key === agentKey() && state.tab === "agents") renderAgents();
 if (result?.ok === false) throw new Error(result.error || tr("规则已保存，但部分宿主同步失败", "Rules saved but some hosts could not be synced"));
 toast(tr("已保存并同步", "Saved and synchronized"));
 });
    }
    async function injectSoftRoute(element) {
 const projectRoot = state.projectRoot, version = contextVersion;
 if (!projectWriteReady()) return;
 const draft = agentDraft();
 if (draft && draft.content !== draft.saved) { toast(tr("请先保存当前修改，再注入模板", "Save your edits before inserting the template"), true); return; }
 await busy("inject-route", element, async () => {
 if (!projectContextReady() || version !== contextVersion || projectRoot !== state.projectRoot) return;
 const result = await request("agentsMd:injectSoftRoute", { projectRoot });
 if (disposed || !projectContextReady() || version !== contextVersion || projectRoot !== state.projectRoot) return;
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
    async function syncProjectRuleReference(element) {
 const projectRoot = state.projectRoot, version = contextVersion;
 if (!projectWriteReady()) return;
 await busy("project-rule-reference", element, async () => {
 if (!projectContextReady() || version !== contextVersion || projectRoot !== state.projectRoot) return;
 await request("agentsMd:syncProjectReference", { projectRoot });
 if (disposed || !projectContextReady() || version !== contextVersion || projectRoot !== state.projectRoot) return;
 if (cache.agents) cache.agents.projectClaudeReference = true;
 if (state.tab === "agents") renderAgents();
 toast(tr("已写入 Claude 项目规则引用；当前会话是否加载取决于宿主。", "Claude project reference saved; session loading depends on the host."));
 });
    }

    const api = {
 options: opts, open: () => setOpen(true), close: () => setOpen(false), toggle: () => setOpen(!state.open), refresh, selectTab: (tab) => switchTab(tab),
 snapshot: () => ({ boardBackground: state.boardBackground, boardDraft: state.boardDraft, orchestrationDraft: state.orchestrationDraft, settingsHost: state.settingsHost, settingsRule: state.settingsRule, settingsRuleDirty: state.settingsRuleDirty, settingsDraft: state.settingsDraft, settingsDirty: state.settingsDirty, clearedHostFields: [...state.clearedHostFields], width: state.width, resourceFilters: state.resourceFilters, memoryScope: state.memoryScope, boardExpanded: state.boardExpanded, scope: state.scope, historyExpanded: state.historyExpanded, open: state.open, tab: state.tab, skillQuery: state.skillQuery, skillFilter: state.skillFilter, mcpFilter: state.mcpFilter, importRepo: state.importRepo, memoryProject: state.memoryProject, memoryModule: state.memoryModule, memoryQuery: state.memoryQuery, selectedMemory: state.selectedMemory, agentsTarget: state.agentsTarget, agentDrafts: state.agentDrafts, subagentScope: state.subagentScope, subagentDrafts: state.subagentDrafts, subagentExpanded: state.subagentExpanded, subagentCustom: state.subagentCustom, drafts }),
 destroy: () => {
 if (disposed) return;
 disposed = true;
 contextVersion++; boardScopeVersion++; requestVersion++; memoryVersion++; memoryAccessVersion++; embedVersion++; boardVersion++;
 clearInterval(routeTimer); timers.forEach(clearTimeout); timers.clear();
 observer?.disconnect(); anchorResize?.disconnect();
 if (updateFrame) cancelAnimationFrame(updateFrame);
 try { unsubscribeRouter?.(); } catch {}
 unsubscribeRouter = null; cachedRouter = null;
 disposers.splice(0).forEach((dispose) => { try { dispose(); } catch {} });
 liveBoard?.remove(); titleControls?.remove(); planHandle?.remove(); root?.remove(); style?.remove();
 if (window.__t3SidecarHub === api) delete window.__t3SidecarHub;
 if (window.__t3SidecarHubCleanup === api.destroy) delete window.__t3SidecarHubCleanup;
 },
    };
    window.__t3SidecarHub = api; window.__t3SidecarHubCleanup = api.destroy;
    if (document.body) build(); else listen(document, "DOMContentLoaded", build, { once: true });
    return api;
  };

  if (!window.__t3HubDrawerLoading && (typeof window.__t3HubRpc === "function" || window.__t3HudBridge)) {
    window.__t3MountSidecarHub(previousOptions);
  }
})();
