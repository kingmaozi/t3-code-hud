(() => {
  "use strict";

  if (typeof window.__t3HudCleanup === "function") {
    try {
      window.__t3HudCleanup();
    } catch {}
  }
  if (!document.getElementById("root")) return;
  window.__t3HudInitialized = true;

  // --- Route hint (hash routing + TanStack in-memory + pathname fallback) ---
  let cachedRouter = null;
  let unsubscribeRouter = null;

  function getRouterPathname(router) {
    try {
      const p = router?.state?.location?.pathname;
      if (typeof p === "string" && p) return p;
    } catch {}
    return null;
  }

  function findTanStackRouter() {
    try {
      if (window.__TSR_ROUTER__) {
        cachedRouter = window.__TSR_ROUTER__;
        return cachedRouter;
      }
    } catch {}
    if (cachedRouter) return cachedRouter;
    try {
      const rootEl = document.getElementById("root");
      if (!rootEl) return null;
      const fk = Object.keys(rootEl).find(
        (k) => k.startsWith("__reactContainer") || k.startsWith("__reactFiber")
      );
      if (!fk) return null;
      const stack = [rootEl[fk]];
      const seen = new Set();
      let visited = 0;
      while (stack.length && visited < 400) {
        const f = stack.pop();
        if (!f || seen.has(f)) continue;
        seen.add(f);
        visited++;
        const p = f.memoizedProps;
        if (p && p.router && typeof p.router === "object") {
          cachedRouter = p.router;
          return cachedRouter;
        }
        if (f.child) stack.push(f.child);
        if (f.sibling) stack.push(f.sibling);
      }
    } catch {}
    return cachedRouter;
  }

  function ensureRouterSubscription() {
    if (unsubscribeRouter) return;
    try {
      const r = findTanStackRouter();
      if (!r || typeof r.subscribe !== "function") return;
      let unsub = null;
      try {
        unsub = r.subscribe("onResolved", onRouteMaybeChanged);
      } catch {
        try {
          unsub = r.subscribe(onRouteMaybeChanged);
        } catch {}
      }
      if (typeof unsub === "function") unsubscribeRouter = unsub;
      else if (unsub && typeof unsub.unsubscribe === "function") {
        unsubscribeRouter = () => unsub.unsubscribe();
      }
    } catch {}
  }

  function getRouteHint() {
    const hash = window.location.hash || "";
    if (hash.startsWith("#/") || hash.length > 1) {
      return hash.slice(1);
    }
    try {
      const rp = getRouterPathname(findTanStackRouter());
      if (rp && rp !== "/") return rp;
    } catch {}
    return window.location.pathname || "/";
  }

  function toEpochMs(v) {
    if (!v) return null;
    if (typeof v === "number") return v;
    if (typeof v === "object" && typeof v.epochMilliseconds === "number") return v.epochMilliseconds;
    if (typeof v === "string") {
      const m = v.match(/\(([^)]+)\)/);
      const t = Date.parse(m ? m[1] : v);
      return Number.isFinite(t) ? t : null;
    }
    return null;
  }

  function extractLastThreadIdFromHint(rawHint) {
    if (typeof rawHint !== "string" || !rawHint) return null;
    const parts = rawHint.split(/[/?#]/).filter(Boolean);
    for (let i = parts.length - 1; i >= 0; i--) {
      let seg = parts[i];
      try { seg = decodeURIComponent(seg); } catch {}
      if (seg.startsWith("thread:")) return seg;
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return seg;
    }
    return null;
  }

  function buildProjectionPayload(p, stEnvId, uhProps) {
    const ctxList = Array.isArray(p.providerThreads) ? p.providerThreads : [];
    const activeDriver = String(p.thread?.providerInstanceId || "");
    let lastUsage = null;
    let driverUsage = null;
    for (const pt of ctxList) {
      if (!pt || !pt.contextUsage) continue;
      lastUsage = pt.contextUsage;
      const drv = String(pt.driver || pt.providerThreadRef?.driver || pt.provider || "");
      if (activeDriver && drv === activeDriver) driverUsage = pt.contextUsage;
    }
    const contextUsage = driverUsage ?? lastUsage;
    const toolIntervals = [];
    for (const n of p.nodes || []) {
      if (!n) continue;
      if (n.kind === "tool_call" || n.kind === "subagent" || n.kind === "command_execution") {
        const s = toEpochMs(n.startedAt);
        const e = toEpochMs(n.completedAt);
        if (s != null && e != null && e > s) toolIntervals.push([s, e]);
      }
    }
    const turns = (p.providerTurns || []).map((pt) => ({
      status: pt?.status || null,
      driver: pt?.nativeTurnRef?.driver || null,
      startedMs: toEpochMs(pt?.startedAt),
      completedMs: toEpochMs(pt?.completedAt),
      usage: pt?.turnTokenUsage || null,
    }));
    const tid = String(p.thread?.id || "");
    const uhMatches = uhProps && (!tid || !uhProps.threadId || String(uhProps.threadId) === tid);
    return {
      environmentId: String(stEnvId || (uhMatches ? uhProps.environmentId : "") || ""),
      threadId: tid || (uhMatches ? String(uhProps.threadId || "") : ""),
      title: String(p.thread?.title || ""),
      provider: activeDriver,
      model: String(p.thread?.modelSelection?.model || ""),
      branch: p.thread?.branch || null,
      repoPath: (uhMatches && uhProps.gitCwd) || p.thread?.worktreePath || null,
      isServerThread: uhMatches ? Boolean(uhProps.isServerThread) : true,
      isRunning:
        (p.runs || []).some((run) => run && (run.status === "running" || run.status === "starting")) ||
        (p.providerSessions || []).some((s) => s && s.status === "running"),
      subagentCount: Array.isArray(p.subagents) ? p.subagents.length : 0,
      contextUsage,
      toolIntervals,
      turns,
      gitCwd: (uhMatches && uhProps.gitCwd) || p.thread?.worktreePath || null,
    };
  }

  function readFiberThreadProjection(expectedThreadId) {
    const expected = extractLastThreadIdFromHint(expectedThreadId);
    let uhProps = null;
    let matchedSt = null;
    let fallbackSt = null;
    try {
      const rootEl = document.getElementById("root");
      if (!rootEl) return null;
      const fk = Object.keys(rootEl).find(
        (k) => k.startsWith("__reactContainer") || k.startsWith("__reactFiber")
      );
      if (!fk) return null;
      const stack = [rootEl[fk]];
      const seen = new Set();
      let visited = 0;
      while (stack.length && visited < 20000) {
        const f = stack.pop();
        if (!f || seen.has(f)) continue;
        seen.add(f);
        visited++;
        try {
          const mp = f.memoizedProps;
          if (mp && typeof mp === "object" && "gitCwd" in mp && "isServerThread" in mp) {
            const candTid = String(mp.threadId || "");
            if (!uhProps || (expected && candTid === expected)) {
              uhProps = {
                environmentId: mp.environmentId,
                threadId: mp.threadId,
                isServerThread: Boolean(mp.isServerThread),
                gitCwd: mp.gitCwd || null,
                isGitRepo: Boolean(mp.isGitRepo),
                activeProjectName: mp.activeProjectName || null,
              };
            }
          }
        } catch {}
        try {
          let h = f.memoizedState;
          let d = 0;
          while (h && d < 10) {
            const st = h.memoizedState;
            if (st && typeof st === "object" && st.projection && Array.isArray(st.projection.providerTurns)) {
              const pid = String(st.projection.thread?.id || "");
              if (!fallbackSt) fallbackSt = st;
              if (expected && pid === expected && !matchedSt) {
                matchedSt = st;
              }
            }
            h = h.next;
            d++;
          }
        } catch {}
        if (matchedSt && uhProps && (!expected || String(uhProps.threadId || "") === expected)) break;
        if (f.child) stack.push(f.child);
        if (f.sibling) stack.push(f.sibling);
      }
    } catch {}

    if (matchedSt) {
      return buildProjectionPayload(matchedSt.projection, matchedSt.environmentId, uhProps);
    }
    if (!expected && fallbackSt) {
      return buildProjectionPayload(fallbackSt.projection, fallbackSt.environmentId, uhProps);
    }
    if (uhProps && (!expected || String(uhProps.threadId || "") === expected)) {
      return {
        environmentId: String(uhProps.environmentId || ""),
        threadId: String(uhProps.threadId || ""),
        title: "",
        provider: "",
        model: "",
        branch: null,
        repoPath: uhProps.gitCwd || null,
        isServerThread: Boolean(uhProps.isServerThread),
        isRunning: false,
        subagentCount: 0,
        contextUsage: null,
        toolIntervals: [],
        turns: [],
        gitCwd: uhProps.gitCwd || null,
      };
    }
    return null;
  }

  function fallbackModelRate(model) {
    const m = String(model || "").trim().toLowerCase();
    if (m.includes("muse-ember")) return { input: 0.1 / 1e6, output: 0.5 / 1e6, cacheRead: 0.004 / 1e6, cacheWrite: 0.1 / 1e6 };
    if (m.includes("muse-wonder")) return { input: 4.0 / 1e6, output: 20.0 / 1e6, cacheRead: 0.2 / 1e6, cacheWrite: 4.0 / 1e6 };
    if (m.includes("opus")) return { input: 5.0 / 1e6, output: 25.0 / 1e6, cacheRead: 0.5 / 1e6, cacheWrite: 6.25 / 1e6 };
    if (m.includes("sonnet")) return { input: 3.0 / 1e6, output: 15.0 / 1e6, cacheRead: 0.3 / 1e6, cacheWrite: 3.75 / 1e6 };
    if (m.includes("gpt-6.1-terra")) return { input: 1.0 / 1e6, output: 5.0 / 1e6, cacheRead: 0.05 / 1e6, cacheWrite: 1.0 / 1e6 };
    if (m.includes("gpt-6") || m.includes("carbon") || m.includes("argon")) return { input: 2.0 / 1e6, output: 10.0 / 1e6, cacheRead: 0.1 / 1e6, cacheWrite: 2.0 / 1e6 };
    if (m.includes("hydrogen")) return { input: 1.5 / 1e6, output: 7.5 / 1e6, cacheRead: 0.075 / 1e6, cacheWrite: 1.5 / 1e6 };
    return { input: 2.0 / 1e6, output: 10.0 / 1e6, cacheRead: 0.2 / 1e6, cacheWrite: 2.0 / 1e6 };
  }

  function buildLocalProjectionFallback(remotePayload) {
    const payload = remotePayload && typeof remotePayload === "object" ? remotePayload : null;
    if (!payload) return { ok: false, error: "Invalid remote payload" };
    const turns = Array.isArray(payload.turns) ? payload.turns : [];
    const intervals = (Array.isArray(payload.toolIntervals) ? payload.toolIntervals : [])
      .filter((iv) => Array.isArray(iv) && Number.isFinite(iv[0]) && Number.isFinite(iv[1]) && iv[1] > iv[0])
      .map(([s, e]) => [s, e])
      .sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [s, e] of intervals) {
      const last = merged[merged.length - 1];
      if (last && s <= last[1]) {
        if (e > last[1]) last[1] = e;
      } else {
        merged.push([s, e]);
      }
    }
    const subtractWait = (startMs, endMs) => {
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0;
      let waitMs = 0;
      for (const [s, e] of merged) {
        const os = Math.max(startMs, s);
        const oe = Math.min(endMs, e);
        if (oe > os) waitMs += oe - os;
      }
      return Math.max(0, endMs - startMs - waitMs) / 1000;
    };
    let sumUncached = 0;
    let sumCached = 0;
    let sumCacheWrite = 0;
    let sumOutput = 0;
    let sumReasoning = 0;
    let sumUsd = 0;
    let sumSavedUsd = 0;
    let pricedTurns = 0;
    let netOutSum = 0;
    let netSecSum = 0;
    let wallOutSum = 0;
    let wallSecSum = 0;
    let lastTurnTps = null;
    let lastTurnNetSec = null;
    let lastPromptTotal = null;
    let lastTurnCacheRate = null;
    let lastTurnDriver = null;
    let lastTurnModel = null;
    const byModel = {};
    for (const t of turns) {
      const u = t?.usage;
      if (!u || typeof u.inputTokens !== "number" || u.usageStatus === "unavailable") continue;
      const driver = t.driver || payload.provider || "unknown";
      let inp = Math.max(0, u.inputTokens || 0);
      const cr = Math.max(0, u.cachedInputTokens || 0);
      const cw = Math.max(0, u.cacheCreationTokens || 0);
      if (driver === "antigravity" && inp >= cr * 2) inp = inp - cr;
      const unc = Math.max(0, inp - cr - cw);
      const out = Math.max(0, u.outputTokens || 0);
      const reas = Math.min(out, Math.max(0, u.reasoningTokens || 0));
      const turnModel = (Array.isArray(u.models) && u.models[0]) || payload.model || null;
      const r = fallbackModelRate(turnModel || driver);
      sumUsd += unc * r.input + cr * r.cacheRead + cw * r.cacheWrite + out * r.output;
      sumSavedUsd += cr * Math.max(0, r.input - r.cacheRead);
      sumUncached += unc;
      sumCached += cr;
      sumCacheWrite += cw;
      sumOutput += out;
      sumReasoning += reas;
      pricedTurns++;
      lastPromptTotal = inp + out;
      lastTurnCacheRate = inp > 0 ? cr / inp : null;
      lastTurnDriver = driver;
      lastTurnModel = turnModel;
      if (Number.isFinite(t.startedMs) && Number.isFinite(t.completedMs) && t.completedMs > t.startedMs && out > 0) {
        wallOutSum += out;
        wallSecSum += (t.completedMs - t.startedMs) / 1000;
      }
      if (Number.isFinite(t.startedMs) && Number.isFinite(t.completedMs) && t.completedMs > t.startedMs + 50 && out >= 15) {
        const netSec = subtractWait(t.startedMs, t.completedMs);
        if (netSec > 0.05) {
          netOutSum += out;
          netSecSum += netSec;
          lastTurnTps = out / netSec;
          lastTurnNetSec = netSec;
          if (turnModel) {
            const cur = (byModel[turnModel] ||= { tok: 0, sec: 0 });
            cur.tok += out;
            cur.sec += netSec;
          }
        }
      }
    }
    const promptTotal = sumUncached + sumCached + sumCacheWrite;
    const sessionCacheRate = promptTotal > 0 ? sumCached / promptTotal : null;
    const effDriver = lastTurnDriver || payload.provider || "unknown";
    const effModel = lastTurnModel || payload.model || null;
    let contextUsed = payload.contextUsage?.usedTokens ?? lastPromptTotal;
    if (effDriver === "antigravity" && payload.contextUsage?.usedTokens != null && lastPromptTotal != null && payload.contextUsage.usedTokens > lastPromptTotal * 1.6) {
      contextUsed = lastPromptTotal;
    }
    let contextMax = payload.contextUsage?.maxTokens || (effDriver === "antigravity" ? (/opus|sonnet|haiku|claude/i.test(String(effModel || "")) ? 1000000 : 1048576) : effDriver === "muse" ? 1007997 : null);
    const tokPerSec = netSecSum > 0.2 ? netOutSum / netSecSum : null;
    const e2eTokPerSec = wallSecSum > 0.2 && wallOutSum > 0 ? wallOutSum / wallSecSum : tokPerSec;
    const byModelSpeed = Object.fromEntries(
      Object.entries(byModel)
        .filter(([, v]) => v.sec > 0.1)
        .map(([k, v]) => [k, Math.round((v.tok / v.sec) * 10) / 10])
    );
    return {
      ok: true,
      telemetrySource: "remote-projection",
      isRemote: true,
      threadId: String(payload.threadId || ""),
      title: String(payload.title || ""),
      provider: effDriver,
      model: effModel,
      projectTitle: payload.projectTitle || null,
      repoPath: payload.repoPath || null,
      branch: payload.branch || null,
      isRunning: Boolean(payload.isRunning),
      turnCount: turns.length,
      stepCount: pricedTurns,
      speed: {
        tokPerSec: tokPerSec != null ? Math.round(tokPerSec * 10) / 10 : null,
        byModel: byModelSpeed,
        lastDecodeTps: lastTurnTps != null ? Math.round(lastTurnTps * 10) / 10 : null,
        e2eTokPerSec: e2eTokPerSec != null ? Math.round(e2eTokPerSec * 10) / 10 : null,
        durationSec: lastTurnNetSec != null ? Math.round(lastTurnNetSec * 10) / 10 : null,
      },
      tokens: {
        input: promptTotal,
        uncached: sumUncached,
        uncachedInput: sumUncached,
        cached: sumCached,
        cachedInput: sumCached,
        cacheWrite: sumCacheWrite,
        cacheWriteInput: sumCacheWrite,
        output: sumOutput,
        reasoning: sumReasoning,
        mainTotal: promptTotal + sumOutput,
        subagentTokens: 0,
        total: promptTotal + sumOutput,
        contextUsed: contextUsed ?? null,
        contextMax: contextMax ?? null,
      },
      cache: {
        cachedTokens: sumCached,
        cacheWriteTokens: sumCacheWrite,
        sessionRate: sessionCacheRate,
        lastTurnRate: lastTurnCacheRate ?? sessionCacheRate,
        displayRate: lastTurnCacheRate ?? sessionCacheRate,
        savedUsd: sumSavedUsd,
      },
      cost: {
        sessionUsd: sumUsd,
        subagentUsd: 0,
        withSubagentsUsd: sumUsd,
        subagentCount: Math.max(0, Number(payload.subagentCount) || 0),
        estimated: false,
      },
    };
  }

  // Distinct, clean Git swimlane colors that work well on both stock Light (#fff) and stock Dark (#000/#141414)
  const LANE_COLORS = [
    "#ea580c", // warm orange, primary lane
    "#3b82f6", // blue
    "#10b981", // emerald
    "#8b5cf6", // violet
    "#ec4899", // pink
    "#eab308", // yellow
  ];

  function laneColor(lane) {
    return LANE_COLORS[Math.abs(lane) % LANE_COLORS.length];
  }

  const GIT_GRAPH_ICON = `<svg class="t3-git-symbol" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" aria-hidden="true"><circle cx="3.5" cy="4" r="1.7"/><circle cx="3.5" cy="12" r="1.7"/><path d="M3.5 5.7V10.3M8 2.2V13.8"/><circle cx="12.5" cy="4.5" r="1.7"/><path d="M12.5 6.2C12.5 9.2 11.3 10.6 9.8 11.5"/></svg>`;
  const GIT_BRANCH_ICON = `<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="4" cy="12" r="2"/><circle cx="12" cy="4" r="2"/><path d="M4 2V10M4 10C4 4 10 8 10 4"/></svg>`;
  const REFRESH_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 7V3M20 7H16M4 17V21M4 17H8M5.5 8A7.5 7.5 0 0 1 18 5.5L20 7M4 17L6 18.5A7.5 7.5 0 0 0 18.5 16"/></svg>`;
  const CLOSE_ICON = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M4 4L12 12M12 4L4 12"/></svg>`;

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

  // ============================================================================
  // Bilingual i18n (zh / en) with auto-detection
  // ============================================================================
  const I18N = {
    zh: {
      cache: "累计缓存",
      sub: "子",
      weekLeft: "周余",
      graph: "图谱",
      newSession: "新会话",
      streaming: "生成中...",
      contextCapacity: "上下文容量",
      avgCacheHitRate: "平均缓存命中率",
      agyNote: "AGY 约 26万 自动滑动压缩",
      newSessionTitle: "新会话 / 待发消息",
      newSessionDesc: "发送首条消息后将实时显示该会话的速度、累计缓存命中率、会话 Token 与等效费用。",
      currentEngineQuota: "当前引擎额度剩余",
      resetIn: "重置倒计时",
      otherEngineQuota: "其他引擎额度速览",
      remaining: "剩余",
      engineModel: "引擎 / 模型",
      streamSpeed: "流式输出速度",
      avgSpeed: "均速",
      avgDecodeSpeed: "会话均速",
      lastTurnSpeed: "末轮速度",
      e2eSpeed: "端到端速度 (含首字预填充)",
      cumCacheRound: "累计缓存 / 本轮缓存",
      cacheSaved: "缓存节省费用",
      contextRatio: "上下文容量占比",
      totalTokensWithSub: "本会话总 Token (含子代理)",
      mainSubPrefix: "↳ 主会话 / 子代理",
      inpCacheRead: "↳ 输入 / 缓存读取",
      outReasoning: "↳ 输出 / 思考推理",
      mainSessionCost: "主会话等效费用",
      subagents: "子代理",
      totalCost: "单会话总计",
      unknownModel: "未知模型",
      untitled: "未命名会话",
      currentSession: "当前会话",
      rounds: "轮",
      est: " (估)",
      gitGraph: "Git 图谱",
      workingClean: "工作区干净",
      noCommits: "仓库暂无提交记录",
      noMatch: "没有匹配的提交记录",
      loadingGraph: "正在加载 Git 图谱...",
      loadingDetail: "加载提交详情中...",
      noMessage: "(无提交说明)",
      filesCount: "个文件",
      readFail: "读取详情失败",
      overlay: "打开/关闭 Git 图谱悬浮窗 (Option+G)",
      refreshGraph: "刷新图谱",
      filterCommits: "筛选提交...",
      graphColumn: "图",
      descriptionColumn: "描述",
      dateColumn: "日期",
      authorColumn: "作者",
      commitColumn: "提交",
      cleanStatus: "干净",
      switchLanguage: "切换语言",
      close: "关闭 (Esc)",
      collapse: "收起详情",
      uncommitted: "未提交",
      modified: "改",
      newFiles: "新",
      remoteWorkspace: "当前会话运行在远程服务器，本地无法直接读取远端 Git 仓库",
    },
    en: {
      cache: "Cache",
      sub: "sub",
      weekLeft: "Wk",
      graph: "Graph",
      newSession: "New",
      streaming: "Streaming...",
      contextCapacity: "Context Capacity",
      avgCacheHitRate: "Avg Cache Hit Rate",
      agyNote: "AGY auto-slides around ~260k",
      newSessionTitle: "New session / awaiting message",
      newSessionDesc: "After the first message, speed, cache hit rate, session tokens and cost will show live.",
      currentEngineQuota: "Current engine quota",
      resetIn: "Resets in",
      otherEngineQuota: "Other engines at a glance",
      remaining: "Left",
      engineModel: "Engine / Model",
      streamSpeed: "Stream speed",
      avgSpeed: "Avg",
      avgDecodeSpeed: "Avg Decode Speed",
      lastTurnSpeed: "Last Turn Speed",
      e2eSpeed: "End-to-end (incl. prefill)",
      cumCacheRound: "Cache total / this turn",
      cacheSaved: "Saved via cache",
      contextRatio: "Context usage",
      totalTokensWithSub: "Total tokens (incl. subagents)",
      mainSubPrefix: "↳ Main / subagents",
      inpCacheRead: "↳ Input / cache read",
      outReasoning: "↳ Output / reasoning",
      mainSessionCost: "Main session cost",
      subagents: "Subagents",
      totalCost: "Session total",
      unknownModel: "Unknown model",
      untitled: "Untitled",
      currentSession: "Current session",
      rounds: "turns",
      est: " (est.)",
      gitGraph: "Git Graph",
      workingClean: "Working tree clean",
      noCommits: "No commits yet",
      noMatch: "No matching commits",
      loadingGraph: "Loading Git Graph...",
      loadingDetail: "Loading commit detail...",
      noMessage: "(no message)",
      filesCount: "files",
      readFail: "Failed to load detail",
      overlay: "Toggle Git Graph window (Option+G)",
      refreshGraph: "Refresh graph",
      filterCommits: "Filter commits...",
      graphColumn: "Graph",
      descriptionColumn: "Description",
      dateColumn: "Date",
      authorColumn: "Author",
      commitColumn: "Commit",
      cleanStatus: "Clean",
      switchLanguage: "Switch language",
      close: "Close (Esc)",
      collapse: "Collapse details",
      uncommitted: "Uncommitted",
      modified: "mod",
      newFiles: "new",
      remoteWorkspace: "This thread runs on a remote server; its Git repo is not mounted locally",
    },
  };

  let hudLang = null;
  let hudConfig = { defaultLang: "zh" };

  function t(key) {
    const dict = I18N[hudLang || "zh"] || I18N.zh;
    return dict[key] || key;
  }

  function detectLangFromDom() {
    try {
      const docLang = (document.documentElement.lang || "").toLowerCase();
      if (docLang.startsWith("zh")) return "zh";
      if (docLang.startsWith("en")) return "en";
      // Check composer placeholder
      const bodyText = document.body ? document.body.innerText || "" : "";
      const zhMarkers = ["想问什么", "本地工作副本", "新会话", "设置", "累计缓存", "图谱"];
      const enMarkers = ["Ask anything", "Local working copy", "New thread", "Settings"];
      let zhHits = 0;
      let enHits = 0;
      for (const m of zhMarkers) if (bodyText.includes(m)) zhHits++;
      for (const m of enMarkers) if (bodyText.includes(m)) enHits++;
      // Placeholder attribute check
      try {
        const ph = document.querySelector('[data-slot="composer-shell"] textarea')?.placeholder || "";
        if (zhMarkers.some((m) => ph.includes(m))) zhHits += 2;
        if (enMarkers.some((m) => ph.includes(m))) enHits += 2;
      } catch {}
      if (zhHits > 0 && zhHits > enHits) return "zh";
      if (enHits > 0 && enHits > zhHits) return "en";
    } catch {}
    return null;
  }

  function resolveLang() {
    // a) explicit localStorage or userLang
    try {
      const ls = localStorage.getItem("t3-hud-lang");
      if (ls === "zh" || ls === "en") return ls;
    } catch {}
    if (hudConfig && (hudConfig.userLang === "zh" || hudConfig.userLang === "en")) {
      return hudConfig.userLang;
    }
    // b) DOM detection
    const domLang = detectLangFromDom();
    if (domLang) return domLang;
    // c) config.defaultLang
    if (hudConfig && (hudConfig.defaultLang === "en" || hudConfig.defaultLang === "zh")) {
      return hudConfig.defaultLang;
    }
    return "zh";
  }

  async function switchLang(target) {
    // target: "zh" | "en" | "auto"
    try {
      const nowTs = Date.now();
      if (target === "auto") {
        localStorage.removeItem("t3-hud-lang");
        localStorage.setItem("t3-hud-lang-ts", String(nowTs));
        await callBackend("setConfig", { userLang: "auto", langUpdatedAt: nowTs });
        hudConfig.userLang = "auto";
      } else {
        localStorage.setItem("t3-hud-lang", target);
        localStorage.setItem("t3-hud-lang-ts", String(nowTs));
        await callBackend("setConfig", { userLang: target, langUpdatedAt: nowTs });
        hudConfig.userLang = target;
      }
    } catch {}
    hudLang = resolveLang();
    applyLangToDom();
    if (latestStats) renderTopbarStats(latestStats);
    if (drawerOpen) renderGitGraphList();
    if (selectedCommitDetail) renderCommitDetail(selectedCommitDetail);
    if (popover.classList.contains("visible")) {
      if (currentPopoverMode === "context") renderContextRingPopover();
      else renderStatsPopover();
      updateLangSwitchButtons();
    }
  }

  // Pull config.json language + timestamp (CLI `t3-hud lang` writes both);
  // when newer than our localStorage timestamp, adopt its language and re-render.
  async function syncConfigLang() {
    try {
      const cfg = await callBackend("getConfig");
      if (!cfg || !cfg.ok) return;
      hudConfig = { defaultLang: cfg.defaultLang === "en" ? "en" : "zh", userLang: cfg.userLang };
      const remoteTs = Number(cfg.langUpdatedAt);
      if (!Number.isFinite(remoteTs) || remoteTs <= 0) return;
      const localTs = Number(localStorage.getItem("t3-hud-lang-ts")) || 0;
      if (remoteTs <= localTs) return;
      localStorage.setItem("t3-hud-lang-ts", String(remoteTs));
      if (cfg.userLang === "zh" || cfg.userLang === "en") {
        localStorage.setItem("t3-hud-lang", cfg.userLang);
      } else if (cfg.userLang === null || cfg.userLang === "auto") {
        localStorage.removeItem("t3-hud-lang");
      }
      hudLang = resolveLang();
      applyLangToDom();
    } catch {}
  }

  function langSwitchLabel() {
    return hudLang === "zh" ? "EN" : "中文";
  }
  function langSwitchTarget() {
    return hudLang === "zh" ? "en" : "zh";
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
      --hud-emerald: #059669;
      --hud-emerald-fill: linear-gradient(90deg, #10b981, #34d399);
      --hud-blue: #2563eb;
      --hud-blue-fill: linear-gradient(90deg, #3b82f6, #06b6d4);
      --hud-cyan: #0284c7;
      --hud-amber: #d97706;
      --hud-amber-fill: linear-gradient(90deg, #f59e0b, #fbbf24);
      --hud-orange: #ea580c;
      --hud-orange-fill: linear-gradient(90deg, #f97316, #ef4444);
      --hud-red: #dc2626;
      --hud-red-fill: linear-gradient(90deg, #ef4444, #dc2626);
      --hud-violet: #7c3aed;
      font-family: -apple-system, BlinkMacSystemFont, "Inter Variable", "Segoe UI", system-ui, sans-serif;
      color: var(--hud-fg);
      pointer-events: none;
      position: fixed;
      inset: 0;
      z-index: 9990;
    }
    :is(.dark, [data-theme="dark"]) #t3-hud-root {
      --hud-bg: color-mix(in srgb, var(--popover, #141414) 94%, transparent);
      --hud-bg-solid: var(--popover, #141414);
      --hud-fg: var(--foreground, #f5f5f5);
      --hud-muted: var(--muted-foreground, #a3a3a3);
      --hud-surface: var(--muted, #222222);
      --hud-border: var(--border, rgba(255, 255, 255, 0.12));
      --hud-hover: color-mix(in srgb, var(--foreground, #f5f5f5) 9%, transparent);
      --hud-shadow: 0 14px 40px rgba(0, 0, 0, 0.55), 0 1px 3px rgba(0, 0, 0, 0.35);
      --hud-emerald: #34d399;
      --hud-blue: #60a5fa;
      --hud-cyan: #38bdf8;
      --hud-amber: #fbbf24;
      --hud-orange: #fb923c;
      --hud-red: #f87171;
      --hud-violet: #a78bfa;
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
      z-index: 30;
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
      height: 6px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--hud-fg) 10%, transparent);
      overflow: hidden;
      margin: 9px 0 10px 0;
    }
    .t3-ctx-bar-fill {
      height: 100%;
      border-radius: 999px;
      background: var(--hud-blue-fill);
      transition: width 0.25s ease, background 0.2s ease;
    }
    .t3-ctx-bar-fill.mid { background: var(--hud-amber-fill); }
    .t3-ctx-bar-fill.warn { background: var(--hud-orange-fill); }
    .t3-ctx-bar-fill.err { background: var(--hud-red-fill); }
    .t3-cache-bar-fill { background: var(--hud-emerald-fill); }
    .t3-cache-bar-fill.mid { background: var(--hud-cyan); }
    .t3-cache-bar-fill.low { background: var(--hud-amber-fill); }
    #t3-hud-ring-arc {
      transition: stroke-dashoffset 0.25s ease, stroke 0.2s ease;
    }
    .t3-ctx-heading, .t3-ctx-summary {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      font-variant-numeric: tabular-nums;
    }
    .t3-ctx-heading { font-size: 12px; }
    .t3-ctx-heading > span { color: var(--hud-muted); }
    .t3-ctx-summary { margin-top: 7px; font-size: 11.5px; }
    .t3-ctx-summary > span:first-child { color: var(--hud-muted); }
    .t3-ctx-summary > span:last-child { font-weight: 600; }
    .t3-cache-bar-track { margin-bottom: 0; }
    #t3-hud-cost {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .t3-hud-sub-badge {
      color: var(--hud-violet);
      background: color-mix(in srgb, var(--hud-violet) 11%, transparent);
      padding: 0 5px;
      border-radius: 999px;
      font-size: 11px;
      line-height: 17px;
    }
    .t3-hud-quota-track {
      width: 26px;
      height: 4.5px;
      flex: none;
      border-radius: 999px;
      background: color-mix(in srgb, var(--hud-fg) 11%, transparent);
      overflow: hidden;
    }
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
      background: var(--hud-blue);
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--hud-blue) 16%, transparent);
      animation: t3HudPulse 1.2s ease-in-out infinite;
    }
    .t3-hud-dot.ready {
      background: var(--hud-blue);
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
      background: color-mix(in srgb, var(--hud-blue) 11%, transparent);
      color: var(--hud-blue);
    }
    #t3-hud-git-btn:hover .t3-git-symbol,
    #t3-hud-git-btn.active .t3-git-symbol {
      color: var(--hud-blue);
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
      background: color-mix(in srgb, var(--hud-amber) 12%, transparent);
      color: var(--hud-amber);
      font-variant-numeric: tabular-nums;
    }

    /* Hover breakdown card above bottom HUD capsule */
    #t3-hud-popover {
      box-sizing: border-box;
      pointer-events: none;
      position: fixed;
      width: 324px;
      max-width: calc(100vw - 24px);
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
      z-index: 60;
    }
    #t3-hud-popover.visible {
      opacity: 1;
      transform: translateY(0);
      pointer-events: auto;
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
      height: 6px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--hud-fg) 12%, transparent);
      overflow: hidden;
    }
    .t3-quota-fill, #t3-hud-quota-bar {
      height: 100%;
      border-radius: 999px;
      background: var(--hud-emerald-fill);
      transition: width 0.25s ease, background 0.2s ease;
    }
    .t3-quota-fill.mid, #t3-hud-quota-bar.mid { background: var(--hud-amber-fill); }
    .t3-quota-fill.warn, #t3-hud-quota-bar.warn { background: var(--hud-orange-fill); }
    .t3-quota-fill.err, #t3-hud-quota-bar.err { background: var(--hud-red-fill); }
    .t3-quota-val {
      font-weight: 500;
      font-size: 11px;
      text-align: right;
      min-width: 32px;
    }
    .t3-quota-val, #t3-hud-quota { color: var(--hud-emerald); }
    .t3-quota-val.mid, #t3-hud-quota.mid { color: var(--hud-amber); }
    .t3-quota-val.warn, #t3-hud-quota.warn { color: var(--hud-orange); }
    .t3-quota-val.err, #t3-hud-quota.err { color: var(--hud-red); }
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
    .t3-lang-switch {
      border: 1px solid var(--hud-border);
      background: var(--hud-surface);
      color: var(--hud-fg);
      font: inherit;
      font-size: 10.5px;
      font-weight: 600;
      padding: 2px 7px;
      border-radius: 999px;
      cursor: pointer;
      flex: none;
      line-height: 1.2;
      transition: background 0.12s ease;
    }
    .t3-lang-switch:hover {
      background: var(--hud-hover);
    }

    /* Non-modal, draggable Git Graph window. Host dialogs always take priority. */
    #t3-hud-git-drawer {
      --git-graph-width: 52px;
      --git-columns: var(--git-graph-width) minmax(0, 1fr) 112px 112px 88px;
      --git-lane-bg: color-mix(in srgb, var(--hud-fg) 2%, var(--hud-bg-solid));
      box-sizing: border-box;
      pointer-events: auto;
      -webkit-app-region: no-drag;
      position: fixed;
      width: min(920px, calc(100vw - 48px));
      height: min(600px, calc(100vh - 96px));
      left: calc((100vw - min(920px, calc(100vw - 48px))) / 2);
      top: calc((100vh - min(600px, calc(100vh - 96px))) / 2);
      display: flex;
      flex-direction: column;
      border-radius: 14px;
      background: var(--hud-bg-solid);
      border: 1px solid var(--hud-border);
      box-shadow: var(--hud-shadow);
      overflow: hidden;
      z-index: 9995;
      transition: opacity 0.15s ease, visibility 0.15s ease;
    }
    #t3-hud-git-drawer * {
      box-sizing: border-box;
    }
    #t3-hud-git-drawer.closed,
    #t3-hud-git-drawer.occluded {
      visibility: hidden;
      opacity: 0;
      pointer-events: none;
    }

    .t3-git-hdr {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex: none;
      height: 44px;
      padding: 0 14px;
      border-bottom: 1px solid var(--hud-border);
      background: color-mix(in srgb, var(--hud-surface) 45%, var(--hud-bg-solid));
      cursor: grab;
      user-select: none;
      touch-action: none;
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
      font-size: 13px;
      flex: none;
      white-space: nowrap;
    }
    .t3-git-symbol {
      display: block;
      flex: none;
    }
    .t3-git-repo-state {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      max-width: 240px;
      padding: 3px 7px;
      border: 1px solid var(--hud-border);
      border-radius: 6px;
      background: var(--hud-bg-solid);
      color: var(--hud-muted);
      font-size: 10.5px;
    }
    .t3-git-branch-pill {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
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
      width: 26px;
      height: 26px;
      padding: 0;
      border-radius: 6px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: background 0.12s, color 0.12s;
    }
    .t3-git-icon-btn:hover {
      background: var(--hud-hover);
      color: var(--hud-fg);
    }

    .t3-git-search {
      flex: 1 1 150px;
      min-width: 0;
      max-width: 210px;
      height: 26px;
      margin-left: auto;
      padding: 0 8px;
      border-radius: 6px;
      border: 1px solid var(--hud-border);
      background: var(--hud-bg-solid);
      color: var(--hud-fg);
      font: inherit;
      font-size: 11.5px;
      outline: none;
    }
    .t3-git-search:focus {
      border-color: #3b82f6;
    }
    #t3-hud-git-drawer button:focus-visible,
    .t3-git-row:focus-visible {
      outline: 2px solid #3b82f6;
      outline-offset: -2px;
    }
    .t3-git-status-badge {
      flex: none;
      padding-left: 6px;
      border-left: 1px solid var(--hud-border);
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }

    .t3-git-list {
      flex: 1 1 0;
      min-height: 0;
      overflow-y: auto;
      overflow-x: hidden;
    }
    .t3-git-table-head,
    .t3-git-row {
      display: grid;
      grid-template-columns: var(--git-columns);
      align-items: stretch;
    }
    .t3-git-table-head {
      height: 34px;
      position: sticky;
      top: 0;
      z-index: 2;
      background: color-mix(in srgb, var(--hud-surface) 70%, var(--hud-bg-solid));
      box-shadow: 0 1px 0 var(--hud-border);
      color: var(--hud-muted);
      font-size: 12px;
      font-weight: 500;
    }
    .t3-git-table-head > div {
      display: flex;
      align-items: center;
      min-width: 0;
      padding: 0 12px;
      font-family: inherit;
      font-size: 12px;
    }
    .t3-git-table-head > div + div {
      border-left: 1px solid var(--hud-border);
    }
    .t3-git-table-head > div:nth-child(2) {
      border-left: 0;
    }
    .t3-git-table-head > div::before { display: none; }
    .t3-git-row {
      height: 38px;
      cursor: pointer;
      font-variant-numeric: tabular-nums;
      transition: background 0.1s ease;
    }
    .t3-git-row > div:not(.t3-git-graph-cell) {
      border-bottom: 1px solid color-mix(in srgb, var(--hud-border) 55%, transparent);
    }
    .t3-git-row:hover {
      background: var(--hud-hover);
    }
    .t3-git-row.selected {
      background: var(--hud-hover);
    }
    .t3-git-graph-cell,
    .t3-git-table-head > div:first-child {
      background: var(--git-lane-bg);
      border-right: 1px solid var(--hud-border);
    }
    .t3-git-graph-cell {
      display: flex;
      align-items: center;
      overflow: hidden;
    }
    .t3-git-main-cell {
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 0 12px;
      font-size: 13px;
    }
    .t3-git-refs {
      display: flex;
      align-items: center;
      gap: 4px;
      flex: 0 1 auto;
      min-width: 0;
      max-width: 78%;
    }
    .t3-git-ref {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
      max-width: 155px;
      height: 21px;
      padding: 0 5px;
      border-radius: 6px;
      border: 1px solid var(--hud-border);
      background: var(--hud-surface);
      color: var(--hud-muted);
      font-size: 11px;
      font-weight: 400;
      white-space: nowrap;
      flex: 0 1 auto;
      overflow: hidden;
    }
    .t3-git-ref svg {
      flex: none;
    }
    .t3-git-ref.short {
      flex-shrink: 0;
    }
    .t3-git-ref-label {
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .t3-git-ref.head {
      flex: none;
      background: rgba(245, 158, 11, 0.14);
      border-color: rgba(245, 158, 11, 0.55);
      color: #b45309;
      font-weight: 600;
    }
    html.dark .t3-git-ref.head {
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
    .t3-git-date,
    .t3-git-author,
    .t3-git-sha {
      position: relative;
      display: flex;
      align-items: center;
      min-width: 0;
      padding: 0 12px;
      color: var(--hud-muted);
      font-size: 12.5px;
    }
    .t3-git-date::before,
    .t3-git-author::before,
    .t3-git-sha::before {
      content: "";
      position: absolute;
      left: 0;
      top: 10px;
      bottom: 10px;
      width: 1px;
      background: var(--hud-border);
    }
    .t3-git-cell-text {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .t3-git-sha {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
    }

    /* Commit detail split pane inside drawer */
    #t3-hud-commit-pane {
      border-top: 1px solid var(--hud-border);
      background: var(--hud-surface);
      flex: 0 0 44%;
      min-height: 0;
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
      flex: none;
    }
    .t3-commit-msg {
      font-weight: 600;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 54px;
      overflow-y: auto;
    }
    #t3-commit-meta {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .t3-commit-body {
      flex: 1;
      min-height: 0;
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
    @media (max-width: 679px) {
      #t3-hud-git-drawer {
        --git-columns: var(--git-graph-width) minmax(0, 1fr) 96px 72px;
      }
      .t3-git-repo-state,
      .t3-git-row > .t3-git-author,
      .t3-git-table-head > .t3-git-author {
        display: none;
      }
      .t3-git-hdr { padding: 0 10px; }
      .t3-git-hdr-left { gap: 6px; }
      .t3-git-hdr-actions { gap: 2px; }
      .t3-git-main-cell { padding: 0 9px; gap: 5px; }
      .t3-git-date, .t3-git-sha { padding: 0 9px; font-size: 11px; }
      .t3-git-refs { max-width: 55%; }
      .t3-git-ref { max-width: 95px; font-size: 10px; }
      .t3-git-ref:nth-child(n+2) { display: none; }
      #t3-hud-topbar { max-width: calc(100vw - 24px); }
      #t3-hud-quota-item, #t3-hud-quota-sep { display: none !important; }
      #t3-hud-cache-lbl { display: none; }
    }
    @media (max-width: 559px) {
      .t3-hud-compact-hide { display: none; }
      #t3-hud-dirty { display: none !important; }
      #t3-hud-topbar { font-size: 10.5px; padding: 0 5px; gap: 0; }
      .t3-hud-metric { padding: 0 4px; }
      #t3-hud-git-btn { font-size: 10.5px; padding: 0 5px; }
    }
    @media (max-width: 399px) {
      #t3-hud-git-drawer {
        width: calc(100vw - 24px);
        left: 12px;
        --git-columns: var(--git-graph-width) minmax(0, 1fr) 80px 62px;
      }
      .t3-git-hdr-left .t3-git-symbol { display: none; }
      .t3-git-date, .t3-git-sha { padding: 0 5px; font-size: 10px; }
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
        <span class="lbl" id="t3-hud-cache-lbl">累计缓存</span>
        <span id="t3-hud-cache" class="val">--%</span>
      </div>
      <span class="t3-hud-sep t3-hud-compact-hide"></span>
      <div class="t3-hud-metric t3-hud-compact-hide" data-hud-hover="stats">
        <span id="t3-hud-tokens" class="val">0 tok</span>
      </div>
      <span class="t3-hud-sep"></span>
      <div class="t3-hud-metric" data-hud-hover="stats">
        <span id="t3-hud-cost" class="val">$0.00</span>
      </div>
      <span id="t3-hud-quota-sep" class="t3-hud-sep" style="display:none"></span>
      <div id="t3-hud-quota-item" class="t3-hud-metric" data-hud-hover="stats" style="display:none">
        <span class="lbl" id="t3-hud-week-lbl">周余</span>
        <span class="t3-hud-quota-track" aria-hidden="true"><span id="t3-hud-quota-bar" style="display:block;width:0%"></span></span>
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
      <button id="t3-hud-git-btn" type="button" title="打开/关闭 Git 图谱悬浮窗 (Option+G)" aria-controls="t3-hud-git-drawer" aria-expanded="false">
        ${GIT_GRAPH_ICON}
        <span id="t3-hud-branch" class="t3-hud-branch-text">Git 图谱</span>
        <span id="t3-hud-dirty" class="t3-hud-dirty-dot" style="display:none"></span>
      </button>
    </div>

    <div id="t3-hud-popover"></div>

    <aside id="t3-hud-git-drawer" class="closed" aria-label="Git 图谱" aria-hidden="true">
      <div class="t3-git-hdr" id="t3-git-drag-handle">
        <div class="t3-git-hdr-left">
          ${GIT_GRAPH_ICON}
          <span class="t3-git-repo" id="t3-git-repo-title">Git 图谱</span>
          <span class="t3-git-repo-state">
            <span class="t3-git-branch-pill" id="t3-git-branch-pill">HEAD</span>
            <span id="t3-git-worktree-status" class="t3-git-status-badge"></span>
          </span>
          <input id="t3-git-search-input" class="t3-git-search" type="search" placeholder="筛选提交..." aria-label="筛选提交..." />
        </div>
        <div class="t3-git-hdr-actions">
          <button class="t3-lang-switch" id="t3-git-lang" type="button" title="Switch language">EN</button>
          <button class="t3-git-icon-btn" id="t3-git-refresh" type="button" title="刷新图谱" aria-label="刷新图谱">${REFRESH_ICON}</button>
          <button class="t3-git-icon-btn" id="t3-git-close" type="button" title="关闭 (Esc)" aria-label="关闭 (Esc)">${CLOSE_ICON}</button>
        </div>
      </div>
      <div class="t3-git-list" id="t3-git-list" role="table" aria-label="Git 图谱">
        <div class="t3-empty-msg">正在加载 Git 图谱...</div>
      </div>
      <div id="t3-hud-commit-pane" class="hidden">
        <div class="t3-commit-hdr">
          <div style="min-width:0;flex:1">
            <div class="t3-commit-msg" id="t3-commit-msg"></div>
            <div style="color:var(--hud-muted);font-size:10.5px;margin-top:2px" id="t3-commit-meta"></div>
          </div>
          <button class="t3-git-icon-btn" id="t3-commit-close" type="button" title="收起详情" aria-label="收起详情">${CLOSE_ICON}</button>
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
  const cacheLblEl = document.getElementById("t3-hud-cache-lbl");
  const weekLblEl = document.getElementById("t3-hud-week-lbl");
  const tokensEl = document.getElementById("t3-hud-tokens");
  const costEl = document.getElementById("t3-hud-cost");
  const quotaSepEl = document.getElementById("t3-hud-quota-sep");
  const quotaItemEl = document.getElementById("t3-hud-quota-item");
  const quotaEl = document.getElementById("t3-hud-quota");
  const quotaBarEl = document.getElementById("t3-hud-quota-bar");
  const ringArcEl = document.getElementById("t3-hud-ring-arc");
  const ctxPctEl = document.getElementById("t3-hud-ctx-pct");
  const branchBtnText = document.getElementById("t3-hud-branch");
  const dirtyBadge = document.getElementById("t3-hud-dirty");
  const gitBtn = document.getElementById("t3-hud-git-btn");
  const popover = document.getElementById("t3-hud-popover");
  const gitLangBtn = document.getElementById("t3-git-lang");

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
  let lastRemotePayload = null;
  let liveStreamTps = null;
  let latestGraph = null;
  let drawerOpen = false;
  let selectedCommitHash = null;
  let selectedCommitDetail = null;
  let currentPathHint = getRouteHint();
  let lastLoadedGraphThreadId = null;
  let customDrawerPos = null;
  let spacedComposerStack = null;
  let currentPopoverMode = "stats";
  let popoverHideTimer = null;

  let lastLayoutState = { hidden: null, top: "", left: "", right: "" };
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

  // Audit: NEVER cover Settings, Non-Chat Routes, or Modals/Dialogs
  function isChatComposerVisibleAndUncovered() {
    // 1) Route check
    try {
      const hint = getRouteHint();
      const check = (s) => s === "/settings" || s.startsWith("/settings/") || s === "/usage" || s.startsWith("/usage/") || s === "/pair" || s.startsWith("/pair/");
      if (check(hint)) return null;
      const path = window.location.pathname || "";
      if (check(path)) return null;
    } catch {}
    // 2) Dialog/Modal check
    try {
      const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"], [data-slot="dialog-popup"], [data-slot="sheet-popup"], [data-slot="drawer-popup"]');
      for (const d of dialogs) {
        try {
          const r = d.getBoundingClientRect();
          if (r.width > 100 && r.height > 80) return null;
        } catch {}
      }
    } catch {}
    // 3) Composer check
    const shell = document.querySelector('[data-slot="composer-shell"]');
    if (!shell) return null;
    let surface = null;
    try {
      surface = shell.querySelector("textarea")?.closest("div") || shell.children[0] || shell;
    } catch {
      surface = shell;
    }
    let sRect = null;
    try {
      sRect = surface.getBoundingClientRect();
    } catch {}
    if (!sRect) return null;
    if (!(sRect.width >= 180 && sRect.height >= 28 && sRect.top > 40 && sRect.bottom <= window.innerHeight + 4)) {
      return null;
    }
    // 4) Occlusion check
    try {
      const hit = document.elementFromPoint(sRect.left + sRect.width / 2, Math.max(4, sRect.top + 10));
      if (hit && !shell.contains(hit) && !root.contains(hit)) {
        // Ignore hits that are our own topbar/popover
        if (hit !== popover && !popover.contains(hit) && hit !== topbar && !topbar.contains(hit)) {
          return null;
        }
      }
    } catch {}
    return { shell, surface, sRect };
  }

  function syncUiVisibility() {
    const vis = isChatComposerVisibleAndUncovered();
    drawer.classList.toggle("occluded", !vis);
    drawer.setAttribute("aria-hidden", String(!vis || !drawerOpen));
    if (!vis) {
      // Hide topbar, popover; close drawer if navigating to /settings
      if (lastLayoutState.hidden !== true) {
        topbar.classList.add("is-hidden");
        lastLayoutState.hidden = true;
      }
      if (popover.classList.contains("visible")) popover.classList.remove("visible");
      try {
        const hint = getRouteHint();
        if ((hint === "/settings" || hint.startsWith("/settings/")) && drawerOpen) {
          toggleDrawer(false);
        }
      } catch {}
      return false;
    }
    return true;
  }

  // Position HUD capsule centered directly ABOVE the chat composer box!
  function updateLayoutPosition() {
    if (document.hidden) return;
    const graphLabel = t(window.innerWidth < 640 ? "graph" : "gitGraph");
    if (branchBtnText.textContent !== graphLabel) branchBtnText.textContent = graphLabel;
    if (customDrawerPos) {
      const rect = drawer.getBoundingClientRect();
      customDrawerPos.left = Math.max(8, Math.min(window.innerWidth - rect.width - 8, customDrawerPos.left));
      customDrawerPos.top = Math.max(8, Math.min(window.innerHeight - rect.height - 8, customDrawerPos.top));
      drawer.style.left = `${customDrawerPos.left}px`;
      drawer.style.top = `${customDrawerPos.top}px`;
    }
    const header = document.querySelector("header[data-chat-header]");
    const chatCol = document.querySelector("[data-chat-column]");
    const composer = document.querySelector('[data-slot="composer-shell"]');
    ensureLayoutObservers(header, chatCol, composer);

    if (!syncUiVisibility()) return;

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

  }

  // Draggable floating drawer support
  let cleanupDragListeners = null;
  (() => {
    const handle = document.getElementById("t3-git-drag-handle");
    let startX = 0;
    let startY = 0;
    let origLeft = 0;
    let origTop = 0;

    function onPointerMove(e) {
      const rect = drawer.getBoundingClientRect();
      const nextLeft = Math.max(8, Math.min(window.innerWidth - rect.width - 8, origLeft + (e.clientX - startX)));
      const nextTop = Math.max(8, Math.min(window.innerHeight - rect.height - 8, origTop + (e.clientY - startY)));
      customDrawerPos = { left: nextLeft, top: nextTop };
      drawer.style.left = `${nextLeft}px`;
      drawer.style.top = `${nextTop}px`;
      drawer.style.right = "auto";
    }

    function stopDrag() {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stopDrag);
      window.removeEventListener("pointercancel", stopDrag);
      cleanupDragListeners = null;
    }

    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest("button, input")) return;
      const rect = drawer.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      origLeft = rect.left;
      origTop = rect.top;
      stopDrag();
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", stopDrag);
      window.addEventListener("pointercancel", stopDrag);
      cleanupDragListeners = stopDrag;
      e.preventDefault();
    });
  })();

  // Live reader of T3's in-memory usageLimits, contextWindow, AND active composer model picker!
  function readLiveT3State() {
    let usage = null;
    let contextWindow = null;
    let selectedModel = null;
    let selectedProvider = null;
    try {
      const rootEl = document.getElementById("root");
      if (!rootEl) return { usage, contextWindow, selectedModel, selectedProvider };
      const fk = Object.keys(rootEl).find(
        (k) => k.startsWith("__reactContainer") || k.startsWith("__reactFiber")
      );
      if (!fk) return { usage, contextWindow, selectedModel, selectedProvider };
      const stack = [rootEl[fk]];
      let visited = 0;
      while (stack.length && visited < 20000) {
        const f = stack.pop();
        if (!f) continue;
        visited++;
        const p = f.memoizedProps;
        if (p) {
          if (!usage && p.usage && Array.isArray(p.usage.providers)) {
            usage = p.usage;
          }
          if (!contextWindow && p.contextWindow && typeof p.contextWindow.usedTokens === "number") {
            contextWindow = p.contextWindow;
          }
          if (!selectedModel && typeof p.selectedModel === "string") {
            selectedModel = p.selectedModel;
            selectedProvider = p.selectedProvider || selectedProvider;
          } else if (!selectedModel && p.modelSelection && typeof p.modelSelection.model === "string") {
            selectedModel = p.modelSelection.model;
            selectedProvider = p.modelSelection.instanceId || p.modelSelection.provider || selectedProvider;
          }
        }
        if (usage && selectedModel && (contextWindow || usage.contextWindow)) break;
        if (f.child) stack.push(f.child);
        if (f.sibling) stack.push(f.sibling);
      }
    } catch {}
    return { usage, contextWindow, selectedModel, selectedProvider };
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

  function contextTone(pct) {
    return pct >= 90 ? "err" : pct >= 75 ? "warn" : pct >= 50 ? "mid" : "ok";
  }

  function contextColor(pct) {
    const tone = contextTone(pct);
    return tone === "err" ? "var(--hud-red)" : tone === "warn" ? "var(--hud-orange)" : tone === "mid" ? "var(--hud-amber)" : "var(--hud-blue)";
  }

  function cacheColor(rate) {
    if (rate == null || !Number.isFinite(rate)) return "var(--hud-fg)";
    return rate >= 0.75 ? "var(--hud-emerald)" : rate >= 0.45 ? "var(--hud-cyan)" : "var(--hud-amber)";
  }

  function computeQuotaAndContext(stats) {
    const { usage: live, contextWindow: liveCtx, selectedModel, selectedProvider } = readLiveT3State();
    const liveContext = live?.contextWindow ?? liveCtx ?? null;
    const activeProviderRaw = (
      selectedProvider ||
      live?.providerInstanceId ||
      stats?.provider ||
      ""
    ).toLowerCase();
    // Prefer live composer-selected model so switching Gemini <-> Opus/Sonnet updates 周余 immediately!
    const activeModelRaw = (selectedModel || stats?.model || "").toLowerCase();

    let ctxUsed;
    let ctxMax;
    let ctxPct;
    if (!stats || !stats.ok) {
      if (!stats?.nonThreadRoute && stats?.tokens?.contextUsed == null && liveContext && liveContext.usedTokens > 0) {
        ctxUsed = liveContext.usedTokens;
        ctxMax = stats?.tokens?.contextMax ?? liveContext.maxTokens ?? null;
        ctxPct =
          ctxUsed != null && ctxMax > 0 ? Math.max(0, Math.min(100, (ctxUsed / ctxMax) * 100)) : null;
      } else {
        ctxUsed = 0;
        ctxMax = stats?.tokens?.contextMax ?? null;
        ctxPct = 0;
      }
    } else {
      ctxUsed = stats?.tokens?.contextUsed ?? liveContext?.usedTokens ?? null;
      ctxMax = stats?.tokens?.contextMax ?? liveContext?.maxTokens ?? null;
      ctxPct =
        ctxUsed != null && ctxMax > 0 ? Math.max(0, Math.min(100, (ctxUsed / ctxMax) * 100)) : null;
    }

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
      const tone = rem > 50 ? "ok" : rem > 25 ? "mid" : rem > 10 ? "warn" : "err";
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

  function formatContextPair(used, max) {
    if (hudLang === "en") {
      const u = formatCompactTokens(used);
      const m = formatCompactTokens(max);
      return `${u} / ${m}`;
    }
    return `${formatWanTokens(used)} / ${formatWanTokens(max)}`;
  }

  function updateLangSwitchButtons() {
    const lbl = langSwitchLabel();
    const titleZh = t("switchLanguage");
    [gitLangBtn].forEach((b) => {
      if (b) {
        b.textContent = lbl;
        b.title = titleZh;
        b.setAttribute("aria-label", titleZh);
      }
    });
    popover.querySelectorAll(".t3-lang-switch").forEach((b) => {
      b.textContent = lbl;
    });
  }

  function applyLangToDom() {
    if (cacheLblEl) cacheLblEl.textContent = t("cache");
    if (weekLblEl) weekLblEl.textContent = t("weekLeft");
    if (gitBtn) gitBtn.title = t("overlay");
    gitBtn.setAttribute("aria-label", t("gitGraph"));
    repoTitleEl.textContent = t("gitGraph");
    drawer.setAttribute("aria-label", t("gitGraph"));
    gitListEl.setAttribute("aria-label", t("gitGraph"));
    if (searchInput) {
      searchInput.placeholder = t("filterCommits");
      searchInput.setAttribute("aria-label", t("filterCommits"));
    }
    const refresh = document.getElementById("t3-git-refresh");
    const close = document.getElementById("t3-git-close");
    const cclose = document.getElementById("t3-commit-close");
    for (const [button, key] of [[refresh, "refreshGraph"], [close, "close"], [cclose, "collapse"]]) {
      if (button) {
        button.title = t(key);
        button.setAttribute("aria-label", t(key));
      }
    }
    updateLangSwitchButtons();
  }

  function renderContextRingPopover() {
    const qInfo = computeQuotaAndContext(latestStats);
    const s = latestStats && latestStats.ok ? latestStats : null;
    const usedTxt = qInfo.ctxUsed != null ? formatContextPair(qInfo.ctxUsed, qInfo.ctxMax) : "0";
    const pctNum = qInfo.ctxPct != null ? qInfo.ctxPct : 0;
    const pctTxt = qInfo.ctxPct != null ? `${qInfo.ctxPct.toFixed(1)}%` : "0.0%";
    const barTone = contextTone(pctNum);
    const avgCacheRate = s?.cache.sessionRate;
    const cachePct = Number.isFinite(avgCacheRate) ? Math.min(100, Math.max(0, avgCacheRate * 100)) : 0;
    const cacheTone = avgCacheRate >= 0.75 ? "" : avgCacheRate >= 0.45 ? "mid" : "low";
    const avgCacheTxt =
      s && s.cache.sessionRate != null ? `${(s.cache.sessionRate * 100).toFixed(1)}%` : "--";
    const showAgyNote =
      (qInfo.activeProviderRaw === "antigravity" || s?.provider === "antigravity") &&
      qInfo.ctxUsed != null &&
      qInfo.ctxUsed > 180000;

    popover.style.width = "268px";
    popover.innerHTML = `
      <div class="t3-ctx-heading">
        <span style="font-weight:600;font-size:13px;color:var(--hud-fg)">${escapeHtml(t("contextCapacity"))}</span>
        <button class="t3-lang-switch" type="button">${escapeHtml(langSwitchLabel())}</button>
      </div>
      <div class="t3-ctx-summary">
        <span>${escapeHtml(usedTxt)}</span>
        <span style="color:${contextColor(pctNum)}">${escapeHtml(pctTxt)}</span>
      </div>
      <div class="t3-ctx-bar-track">
        <div class="t3-ctx-bar-fill ${barTone}" style="width:${Math.min(100, Math.max(0, pctNum)).toFixed(1)}%"></div>
      </div>
      <div class="t3-ctx-heading">
        <span>${escapeHtml(t("avgCacheHitRate"))}</span>
        <span style="font-weight:600;color:${cacheColor(avgCacheRate)}">${escapeHtml(avgCacheTxt)}</span>
      </div>
      <div class="t3-ctx-bar-track t3-cache-bar-track">
        <div class="t3-ctx-bar-fill t3-cache-bar-fill ${cacheTone}" style="width:${cachePct.toFixed(1)}%"></div>
      </div>
      ${showAgyNote ? `<div style="margin-top:6px;font-size:10.5px;color:var(--hud-muted)">${escapeHtml(t("agyNote"))}</div>` : ""}
    `;
    popover.querySelector(".t3-lang-switch")?.addEventListener("click", (e) => {
      e.stopPropagation();
      switchLang(langSwitchTarget());
    });
  }

  function resolveModelAvgSpeed(stats, activeModelRaw) {
    if (!stats || !stats.speed) return null;
    const bm = stats.speed.byModel;
    const m = (activeModelRaw || stats.model || "").toLowerCase().trim().replace(/\s+/g, "-");
    if (bm && m) {
      if (bm[m] != null) return bm[m];
      const hit = Object.keys(bm).find((k) => k === m || k.startsWith(m + "-") || m.startsWith(k + "-") || k.includes(m) || m.includes(k));
      if (hit) return bm[hit];
    }
    return stats.speed.tokPerSec ?? stats.speed.lastDecodeTps ?? null;
  }

  function renderStatsPopover() {
    popover.style.width = "324px";
    const qInfo = computeQuotaAndContext(latestStats);
    const allQuotasHtml =
      qInfo.currentWindows.length || qInfo.otherWindows.length
        ? `
          ${
            qInfo.currentWindows.length
              ? `<div class="t3-pop-sec-hdr"><span>${escapeHtml(t("currentEngineQuota"))}</span><span>${escapeHtml(t("resetIn"))}</span></div>
                 ${renderQuotaRowsHtml(qInfo.currentWindows)}`
              : ""
          }
          ${
            qInfo.otherWindows.length
              ? `<div class="t3-pop-sec-hdr"><span>${escapeHtml(t("otherEngineQuota"))}</span><span>${escapeHtml(t("remaining"))}</span></div>
                 ${renderQuotaRowsHtml(qInfo.otherWindows)}`
              : ""
          }
        `
        : "";

    if (!latestStats || !latestStats.ok) {
      popover.innerHTML = `<div class="t3-pop-title"><span>${escapeHtml(t("newSessionTitle"))}</span><button class="t3-lang-switch" type="button">${escapeHtml(langSwitchLabel())}</button></div>
        <div style="color:var(--hud-muted)">${escapeHtml(t("newSessionDesc"))}</div>
        ${allQuotasHtml}`;
      popover.querySelector(".t3-lang-switch")?.addEventListener("click", (e) => {
        e.stopPropagation();
        switchLang(langSwitchTarget());
      });
      return;
    }

    const s = latestStats;
    const shownModel = qInfo.activeModelRaw || s.model;
    const providerBadge = [qInfo.activeProviderRaw || s.provider, shownModel].filter(Boolean).join(" · ") || t("unknownModel");
    const ctxLine =
      qInfo.ctxUsed != null
        ? `${formatContextPair(qInfo.ctxUsed, qInfo.ctxMax)}${qInfo.ctxPct != null ? ` (${qInfo.ctxPct.toFixed(1)}%)` : ""}`
        : "--";

    const lastCache = s.cache.lastTurnRate != null ? (s.cache.lastTurnRate * 100).toFixed(1) + "%" : "--";
    const sessCache = s.cache.sessionRate != null ? (s.cache.sessionRate * 100).toFixed(1) + "%" : "--";
    const avgSpeed = resolveModelAvgSpeed(s, qInfo.activeModelRaw);
    const speedColor = (value) => value >= 150 ? "var(--hud-cyan)" : "var(--hud-fg)";
    const formatSpeed = (value) => value != null ? `${value.toFixed(1)} tok/s` : "--";
    const liveSpeedLine = liveStreamTps != null
      ? `<div class="t3-pop-row"><span>${escapeHtml(t("streamSpeed"))}</span><span style="color:var(--hud-blue)">${formatSpeed(liveStreamTps)}</span></div>`
      : "";
    const e2eLine =
      s.speed.e2eTokPerSec != null
        ? `<div class="t3-pop-row"><span>${escapeHtml(t("e2eSpeed"))}</span><span>${s.speed.e2eTokPerSec.toFixed(1)} tok/s</span></div>`
        : "";
    const subTokLine =
      s.cost.subagentCount > 0 && s.tokens.subagentTokens > 0
        ? `<div class="t3-pop-row"><span>${escapeHtml(t("mainSubPrefix"))} (${s.cost.subagentCount})</span><span>${formatCompactTokens(s.tokens.mainTotal)} / +${formatCompactTokens(s.tokens.subagentTokens)}</span></div>`
        : "";

    popover.innerHTML = `
      <div class="t3-pop-title">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(s.title || t("untitled"))}</span>
        <span style="display:flex;align-items:center;gap:6px">
          <span style="color:var(--hud-muted);font-weight:400;font-size:10.5px;flex:none">${s.turnCount} ${escapeHtml(t("rounds"))}</span>
          <button class="t3-lang-switch" type="button">${escapeHtml(langSwitchLabel())}</button>
        </span>
      </div>
      <div class="t3-pop-row"><span>${escapeHtml(t("engineModel"))}</span><span>${escapeHtml(providerBadge)}</span></div>
      <div class="t3-pop-row"><span>${escapeHtml(t("avgDecodeSpeed"))}</span><span style="color:${speedColor(avgSpeed)}">${formatSpeed(avgSpeed)}</span></div>
      <div class="t3-pop-row"><span>${escapeHtml(t("lastTurnSpeed"))}</span><span style="color:${speedColor(s.speed.lastDecodeTps)}">${formatSpeed(s.speed.lastDecodeTps)}</span></div>
      ${liveSpeedLine}
      ${e2eLine}
      <div class="t3-pop-row"><span>${escapeHtml(t("cumCacheRound"))}</span><span><span style="color:${cacheColor(s.cache.sessionRate)}">${sessCache}</span> / <span style="color:${cacheColor(s.cache.lastTurnRate)}">${lastCache}</span></span></div>
      <div class="t3-pop-row"><span>${escapeHtml(t("cacheSaved"))}</span><span style="color:var(--hud-emerald)">${formatUsd(s.cache.savedUsd)}</span></div>
      <div class="t3-pop-row"><span>${escapeHtml(t("contextRatio"))}</span><span style="color:${contextColor(qInfo.ctxPct)}">${ctxLine}</span></div>
      <div class="t3-pop-row"><span>${escapeHtml(t("totalTokensWithSub"))}</span><span style="font-weight:600">${formatCompactTokens(s.tokens.total)} tok</span></div>
      ${subTokLine}
      <div class="t3-pop-row"><span>${escapeHtml(t("inpCacheRead"))}</span><span>${formatCompactTokens(s.tokens.input)} / ${formatCompactTokens(s.cache.cachedTokens)}</span></div>
      <div class="t3-pop-row"><span>${escapeHtml(t("outReasoning"))}</span><span>${formatCompactTokens(s.tokens.output)} / ${formatCompactTokens(s.tokens.reasoning)}</span></div>
      <div class="t3-pop-row" style="border-top:1px solid var(--hud-border);margin-top:4px;padding-top:4px">
        <span>${escapeHtml(t("mainSessionCost"))}</span><span>${formatUsd(s.cost.sessionUsd)}${s.cost.estimated ? escapeHtml(t("est")) : ""}</span>
      </div>
      ${
        s.cost.subagentCount > 0
          ? `<div class="t3-pop-row"><span>${escapeHtml(t("subagents"))} (${s.cost.subagentCount})</span><span style="color:var(--hud-violet)">+${formatUsd(s.cost.subagentUsd)}</span></div>
             <div class="t3-pop-row"><span>${escapeHtml(t("totalCost"))}</span><span style="font-weight:700">${formatUsd(s.cost.withSubagentsUsd)}</span></div>`
          : ""
      }
      ${allQuotasHtml}
    `;
    popover.querySelector(".t3-lang-switch")?.addEventListener("click", (e) => {
      e.stopPropagation();
      switchLang(langSwitchTarget());
    });
  }

  function showPopoverAbove(anchorEl, mode) {
    currentPopoverMode = mode;
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

  function hidePopoverDelayed() {
    clearTimeout(popoverHideTimer);
    popoverHideTimer = setTimeout(() => {
      if (!popover.matches(":hover")) popover.classList.remove("visible");
    }, 140);
  }

  topbar.querySelectorAll("[data-hud-hover]").forEach((el) => {
    const mode = el.getAttribute("data-hud-hover");
    el.addEventListener("mouseenter", () => {
      clearTimeout(popoverHideTimer);
      showPopoverAbove(el, mode);
    });
    el.addEventListener("mouseleave", () => hidePopoverDelayed());
  });
  popover.addEventListener("mouseenter", () => clearTimeout(popoverHideTimer));
  popover.addEventListener("mouseleave", () => hidePopoverDelayed());

  gitLangBtn?.addEventListener("click", () => switchLang(langSwitchTarget()));

  let lastTopbarSig = "";
  function renderTopbarStats(stats) {
    latestStats = stats;
    const qInfo = computeQuotaAndContext(stats);
    const wk = qInfo.primaryWeekly;

    let nextDotClass;
    let nextSpeed;
    let nextCache;
    let nextCacheColor = "var(--hud-fg)";
    let nextTokens;
    let nextCost;
    let nextQuota = wk ? `${wk.remainingPct}%` : "";
    let nextQuotaTone = wk ? wk.tone : "";
    const ctxPctNum = qInfo.ctxPct != null ? Math.round(qInfo.ctxPct) : 0;
    const nextCtxTxt = qInfo.ctxPct != null ? `${ctxPctNum}%` : "0%";
    const nextRingOffset = (RING_CIRC * (1 - Math.max(0, Math.min(100, qInfo.ctxPct || 0)) / 100)).toFixed(2);
    const nextRingColor = contextColor(qInfo.ctxPct);
    let nextBranch = t(window.innerWidth < 640 ? "graph" : "gitGraph");
    let hideDirty = false;

    if (!stats || !stats.ok) {
      nextDotClass = "t3-hud-dot";
      nextSpeed = stats?.nonThreadRoute === "new" ? t("newSession") : "-- tok/s";
      nextCache = "--%";
      nextTokens = "0 tok";
      nextCost = "$0.00";
      hideDirty = true;
    } else {
      const activelyStreaming = liveStreamTps != null;
      nextDotClass = "t3-hud-dot " + (activelyStreaming ? "running" : "ready");
      const primarySpd = liveStreamTps ?? resolveModelAvgSpeed(stats, qInfo.activeModelRaw);
      if (primarySpd != null) {
        nextSpeed = `${activelyStreaming ? "" : t("avgSpeed") + " "}${primarySpd.toFixed(1)} tok/s`;
      } else if (stats.isRunning) {
        nextSpeed = t("streaming");
      } else {
        nextSpeed = "-- tok/s";
      }
      const rate = stats.cache.sessionRate ?? stats.cache.displayRate;
      nextCache = rate != null ? `${Math.round(rate * 100)}%` : "--%";
      nextCacheColor = cacheColor(rate);
      nextTokens = `${formatCompactTokens(stats.tokens.total)} tok`;
      const totalUsd = stats.cost.withSubagentsUsd;
      const subSuffix = stats.cost.subagentCount > 0 ? `<span class="t3-hud-sub-badge">(+${escapeHtml(stats.cost.subagentCount)}${escapeHtml(t("sub"))})</span>` : "";
      nextCost = `${formatUsd(totalUsd)}${subSuffix}`;
    }

    const sig = `${nextDotClass}|${nextSpeed}|${nextCache}|${nextCacheColor}|${nextTokens}|${nextCost}|${nextQuota}|${nextQuotaTone}|${nextCtxTxt}|${nextRingOffset}|${nextRingColor}|${nextBranch}|${hideDirty}|${hudLang}`;
    if (sig !== lastTopbarSig) {
      lastTopbarSig = sig;
      dotEl.className = nextDotClass;
      speedEl.textContent = nextSpeed;
      speedEl.style.color = liveStreamTps != null && stats?.ok ? "var(--hud-blue)" : "var(--hud-fg)";
      cacheEl.textContent = nextCache;
      cacheEl.style.color = nextCacheColor;
      tokensEl.textContent = nextTokens;
      costEl.innerHTML = nextCost;
      if (nextQuota) {
        quotaSepEl.style.display = "inline-block";
        quotaItemEl.style.display = "inline-flex";
        quotaEl.textContent = nextQuota;
        quotaEl.className = `val ${nextQuotaTone}`;
        quotaBarEl.className = nextQuotaTone;
        quotaBarEl.style.width = `${wk.remainingPct}%`;
      } else {
        quotaSepEl.style.display = "none";
        quotaItemEl.style.display = "none";
      }
      ctxPctEl.textContent = nextCtxTxt;
      ctxPctEl.style.color = nextRingColor;
      ringArcEl.setAttribute("stroke-dashoffset", nextRingOffset);
      ringArcEl.style.stroke = nextRingColor;
      branchBtnText.textContent = nextBranch;
      if (hideDirty) dirtyBadge.style.display = "none";
    }

    updateLayoutPosition();
  }

  function graphLaneCount(maxLanes) {
    return Math.max(1, Math.min(64, Math.floor(Number(maxLanes) || 1)));
  }

  function graphColumnWidth(maxLanes) {
    return Math.max(52, Math.min(130, graphLaneCount(maxLanes) * 16 + 28));
  }

  // One 38px SVG per row, flush with its neighbors so swimlanes stay continuous.
  function buildRowSvg(commit, maxLanes) {
    const lanesShown = graphLaneCount(maxLanes);
    const width = graphColumnWidth(maxLanes) - 1;
    const laneStep = Math.min(16, (width - 28) / Math.max(1, lanesShown - 1));
    const laneIndex = (value) => Math.max(0, Math.min(lanesShown - 1, Math.floor(Number(value) || 0)));
    const xFor = (value) => 14 + laneIndex(value) * laneStep;
    const rowH = 38;
    const midY = rowH / 2;
    const lane = laneIndex(commit.lane);
    const cx = xFor(lane);
    let paths = "";

    for (const l of commit.passThroughLanes || []) {
      const x = xFor(l);
      paths += `<line x1="${x}" y1="0" x2="${x}" y2="${rowH}" stroke="${laneColor(laneIndex(l))}" stroke-width="1.6" stroke-opacity="0.6" />`;
    }
    for (const inLane of commit.incomingLanes || []) {
      const ix = xFor(inLane);
      const col = laneColor(laneIndex(inLane));
      paths += ix === cx
        ? `<line x1="${cx}" y1="0" x2="${cx}" y2="${midY}" stroke="${col}" stroke-width="1.6" stroke-opacity="0.6" />`
        : `<path d="M ${ix} 0 C ${ix} 10, ${cx} 9, ${cx} ${midY}" fill="none" stroke="${col}" stroke-width="1.6" stroke-opacity="0.75" />`;
    }
    for (const conn of commit.parentConnections || []) {
      const tx = xFor(conn.toLane);
      const col = laneColor(conn.type === "branch-parent" ? laneIndex(conn.toLane) : lane);
      paths += tx === cx
        ? `<line x1="${cx}" y1="${midY}" x2="${cx}" y2="${rowH}" stroke="${col}" stroke-width="1.6" stroke-opacity="0.6" />`
        : `<path d="M ${cx} ${midY} C ${cx} 29, ${tx} 28, ${tx} ${rowH}" fill="none" stroke="${col}" stroke-width="1.6" stroke-opacity="0.75" />`;
    }

    const isHead = (commit.refs || []).some((r) => r.isHead || r.kind === "head");
    const nodeSvg = isHead
      ? `<circle cx="${cx}" cy="${midY}" r="5.5" fill="var(--git-lane-bg)" stroke="#ea580c" stroke-width="1.5" /><circle cx="${cx}" cy="${midY}" r="2.6" fill="#ea580c" />`
      : `<circle cx="${cx}" cy="${midY}" r="3.2" fill="${laneColor(lane)}" />`;
    return `<svg width="${width}" height="${rowH}" viewBox="0 0 ${width} ${rowH}" style="display:block" aria-hidden="true">${paths}${nodeSvg}</svg>`;
  }

  // Accept both existing backend HEAD-as-branch records and separately emitted HEAD refs.
  function displayCommitRefs(refs) {
    const expanded = [];
    for (const ref of refs || []) {
      const label = String(ref.label || "");
      if (ref.isHead || ref.kind === "head" || label.startsWith("HEAD -> ")) {
        expanded.push({ kind: "head", label: "HEAD", isHead: true });
        const branch = label.replace(/^HEAD\s*(?:->|→)\s*/, "");
        if (branch && branch !== "HEAD") expanded.push({ kind: "branch", label: branch, isHead: false });
      } else {
        expanded.push({ kind: ["branch", "remote", "tag"].includes(ref.kind) ? ref.kind : "branch", label, isHead: false });
      }
    }
    const seen = new Set();
    return expanded.filter((ref) => {
      if (!ref.label || seen.has(ref.label)) return false;
      seen.add(ref.label);
      return true;
    });
  }

  function formatCommitDate(commit) {
    if (Number(commit.timestamp) > 0) {
      const date = new Date(Number(commit.timestamp) * 1000);
      if (Number.isFinite(date.getTime())) {
        const two = (n) => String(n).padStart(2, "0");
        return `${two(date.getMonth() + 1)}/${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
      }
    }
    return commit.relTime || "--";
  }

  function gitTableHeader() {
    return `<div class="t3-git-table-head" role="row">
      <div role="columnheader">${escapeHtml(t("graphColumn"))}</div>
      <div role="columnheader">${escapeHtml(t("descriptionColumn"))}</div>
      <div class="t3-git-date" role="columnheader">${escapeHtml(t("dateColumn"))}</div>
      <div class="t3-git-author" role="columnheader">${escapeHtml(t("authorColumn"))}</div>
      <div class="t3-git-sha" role="columnheader">${escapeHtml(t("commitColumn"))}</div>
    </div>`;
  }

  function renderGitGraphList() {
    if (!latestGraph) return;
    repoTitleEl.textContent = t("gitGraph");
    const header = gitTableHeader();
    if (!latestGraph.ok) {
      branchPillEl.textContent = "--";
      branchPillEl.title = "";
      statusBadgeEl.textContent = "";
      statusBadgeEl.title = "";
      dirtyBadge.style.display = "none";
      if (latestGraph.remoteOnly) {
        const remoteCwd = latestGraph.remoteCwd || "";
        const msg =
          hudLang === "en"
            ? `This thread runs on a remote server (${remoteCwd}); its Git repo is not mounted locally`
            : `当前会话运行在远程服务器 (${remoteCwd})，本地无法直接读取远端 Git 仓库`;
        gitListEl.innerHTML = header + `<div class="t3-empty-msg">${escapeHtml(msg)}</div>`;
        return;
      }
      gitListEl.innerHTML = header + `<div class="t3-empty-msg">${escapeHtml(latestGraph.error || t("noCommits"))}</div>`;
      return;
    }

    drawer.style.setProperty("--git-graph-width", `${graphColumnWidth(latestGraph.maxLanes)}px`);
    branchPillEl.textContent = latestGraph.projectTitle || latestGraph.currentBranch || "HEAD";
    branchPillEl.title = [latestGraph.repoPath, latestGraph.currentBranch].filter(Boolean).join(" · ");
    branchBtnText.textContent = t(window.innerWidth < 640 ? "graph" : "gitGraph");

    const wt = latestGraph.workingTree;
    if (wt && !wt.clean) {
      statusBadgeEl.textContent = `${wt.total} ${t("uncommitted")}`;
      statusBadgeEl.title = `${t("uncommitted")}: ${wt.total} (${wt.modified} ${t("modified")} / ${wt.untracked} ${t("newFiles")})`;
      dirtyBadge.textContent = `*${wt.total}`;
      dirtyBadge.style.display = "inline-block";
    } else {
      statusBadgeEl.textContent = t("cleanStatus");
      statusBadgeEl.title = t("workingClean");
      dirtyBadge.style.display = "none";
    }
    scheduleLayoutSync();

    const q = (searchInput.value || "").trim().toLowerCase();
    const commits = (latestGraph.commits || []).filter((c) => {
      if (!q) return true;
      return [c.subject, c.shortHash, c.hash, c.author, ...displayCommitRefs(c.refs).map((r) => r.label)]
        .some((value) => String(value || "").toLowerCase().includes(q));
    });

    if (commits.length === 0) {
      gitListEl.innerHTML = header + `<div class="t3-empty-msg">${escapeHtml(t(q ? "noMatch" : "noCommits"))}</div>`;
      return;
    }

    gitListEl.innerHTML = header + commits.map((c) => {
      const refs = displayCommitRefs(c.refs);
      const refsHtml = refs.length ? `<span class="t3-git-refs">${refs.map((r) =>
        `<span class="t3-git-ref ${r.kind}${r.label.length <= 18 ? " short" : ""}" title="${escapeHtml(r.label)}">${GIT_BRANCH_ICON}<span class="t3-git-ref-label">${escapeHtml(r.label)}</span></span>`
      ).join("")}</span>` : "";
      const selected = c.hash === selectedCommitHash;
      const shortHash = String(c.shortHash || c.hash || "").slice(0, 7);
      return `<div class="t3-git-row${selected ? " selected" : ""}" role="row" tabindex="0" aria-selected="${selected}" data-hash="${escapeHtml(c.hash)}">
        <div class="t3-git-graph-cell" role="cell">${q ? "" : buildRowSvg(c, latestGraph.maxLanes)}</div>
        <div class="t3-git-main-cell" role="cell">${refsHtml}<span class="t3-git-subj" title="${escapeHtml(c.subject)}">${escapeHtml(c.subject)}</span></div>
        <div class="t3-git-date" role="cell"><span class="t3-git-cell-text" title="${escapeHtml(c.relTime)}">${escapeHtml(formatCommitDate(c))}</span></div>
        <div class="t3-git-author" role="cell"><span class="t3-git-cell-text" title="${escapeHtml(c.author)}">${escapeHtml(c.author)}</span></div>
        <div class="t3-git-sha" role="cell"><span class="t3-git-cell-text" title="${escapeHtml(c.hash)}">${escapeHtml(shortHash)}</span></div>
      </div>`;
    }).join("");
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
    selectedCommitDetail = null;
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

  function getFallbackCwd() {
    if (!lastRemotePayload) return null;
    const cwd = lastRemotePayload.gitCwd || lastRemotePayload.repoPath || null;
    const environmentId = lastRemotePayload.environmentId || "";
    if (!cwd && !environmentId) return null;
    return { cwd, environmentId };
  }

  async function openCommitDetail(hash) {
    if (selectedCommitHash === hash && !commitPane.classList.contains("hidden")) {
      clearCommitPaneDom();
      renderGitGraphList();
      return;
    }
    selectedCommitHash = hash;
    selectedCommitDetail = null;
    renderGitGraphList();
    commitPane.classList.remove("hidden");
    commitMsgEl.textContent = t("loadingDetail");
    commitMetaEl.textContent = hash.slice(0, 10);
    commitBodyEl.textContent = "";

    const res = await callBackend("getCommitDetail", getRouteHint(), hash, getFallbackCwd());
    if (selectedCommitHash !== hash || !drawerOpen) return;
    if (!res || !res.ok) {
      commitMsgEl.textContent = res?.error || t("readFail");
      return;
    }
    selectedCommitDetail = res;
    renderCommitDetail(res);
  }

  function renderCommitDetail(res) {
    commitMsgEl.textContent = res.message || t("noMessage");
    commitMetaEl.textContent = `${res.authorName || ""} <${res.authorEmail || ""}> · ${res.hash.slice(0, 10)} · ${res.files.length} ${t("filesCount")}`;

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

  gitListEl.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const row = e.target.closest(".t3-git-row");
    if (!row) return;
    e.preventDefault();
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
    const graph = await callBackend("getGitGraph", hint, 120, getFallbackCwd());
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
      let stats = await callBackend("getThreadStats", hint);
      if (!stats?.ok && !stats?.nonThreadRoute) {
        try {
          const proj = readFiberThreadProjection(hint);
          lastRemotePayload = proj;
          if (proj) {
            if (proj.isServerThread === false || (Array.isArray(proj.turns) && proj.turns.length === 0)) {
              stats = { ok: false, nonThreadRoute: "new", isDraftThread: true };
            } else {
              let priced = null;
              try { priced = await callBackend("priceRemoteProjection", proj); } catch { priced = null; }
              stats = priced && priced.ok ? priced : buildLocalProjectionFallback(proj);
            }
          }
        } catch {
          // Keep original stats on fiber read failure
        }
      } else {
        lastRemotePayload = null;
      }
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
    const nextOpen = typeof forceState === "boolean" ? forceState : !drawerOpen;
    if (nextOpen && !isChatComposerVisibleAndUncovered()) return;
    drawerOpen = nextOpen;
    drawer.classList.toggle("closed", !drawerOpen);
    drawer.setAttribute("aria-hidden", String(!drawerOpen));
    gitBtn.classList.toggle("active", drawerOpen);
    gitBtn.setAttribute("aria-expanded", String(drawerOpen));
    updateLayoutPosition();
    if (drawerOpen) {
      if (!latestGraph) gitListEl.innerHTML = gitTableHeader() + `<div class="t3-empty-msg">${escapeHtml(t("loadingGraph"))}</div>`;
      refreshGitGraph(true);
    } else {
      // Release 120 SVG rows + diff DOM nodes when drawer is closed
      clearGitDrawerDom();
    }
  }

  gitBtn.addEventListener("click", () => toggleDrawer());
  document.getElementById("t3-git-close").addEventListener("click", () => toggleDrawer(false));
  document.getElementById("t3-git-refresh").addEventListener("click", () => refreshGitGraph(true));

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
    if (!unsubscribeRouter) ensureRouterSubscription();
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
    try {
      if (typeof unsubscribeRouter === "function") unsubscribeRouter();
    } catch {}
    unsubscribeRouter = null;
    cachedRouter = null;
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

  // Boot: load language config, resolve language, then start polling
  (async () => {
    await syncConfigLang();
    hudLang = resolveLang();
    applyLangToDom();
    ensureRouterSubscription();
    refreshStats(true);
    pollTimer = setTimeout(pollLoop, 1200);
  })();
})();
