// Install in the main world on every UI injection, including hot reloads of
// windows whose preload was created by an older HUD version.
(function installT3HudWsRpc() {
  "use strict";
  if (window.__t3HudWsRpcState?.version === 4) return;
  let NativeWS = window.WebSocket;
  while (typeof NativeWS === "function" && Object.prototype.hasOwnProperty.call(NativeWS, "__t3HudTracked")) {
    NativeWS = NativeWS.__t3HudOriginal || Object.getPrototypeOf(NativeWS);
  }
  if (typeof NativeWS !== "function" || typeof NativeWS.prototype?.send !== "function") return;
  const sockets = new Set();
  const tracked = new WeakSet();
  const byEnvironment = new Map();
  const pending = new Map();
  const socketWaiters = new Set();
  const frameParts = new WeakMap();
  const originalSend = NativeWS.prototype.send;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let sequence = 0;
  let discovery = null;

  function unwrap(exit) {
    const value = exit?.value;
    return value?._tag === "Success" && "value" in value ? value.value : value;
  }
  function failureMessage(node, depth = 0) {
    if (!node || depth > 5) return "RPC failure";
    if (typeof node === "string") return node.slice(0, 400);
    if (typeof node.message === "string") return node.message.slice(0, 400);
    for (const key of ["error", "cause", "failure", "reasons", "errors"]) {
      const child = node[key];
      if (child) return failureMessage(Array.isArray(child) ? child[0] : child, depth + 1);
    }
    return "RPC failure";
  }
  function receive(socket, text) {
    // T3 splitSocketFrame prefixes every non-final part with ASCII RS.
    // Buffer per socket: server.getConfig and patches often exceed 48 KiB.
    const previous = frameParts.get(socket) || "";
    if (text.charCodeAt(0) === 30) {
      const combined = previous + text.slice(1);
      if (combined.length <= 16 * 1024 * 1024) frameParts.set(socket, combined);
      else frameParts.delete(socket);
      return;
    }
    if (previous) { text = previous + text; frameParts.delete(socket); }
    let frames;
    try { const parsed = JSON.parse(text); frames = Array.isArray(parsed) ? parsed : [parsed]; }
    catch { return; }
    for (const frame of frames) {
      if (frame?._tag !== "Exit") continue;
      const id = String(frame.requestId);
      const entry = pending.get(id);
      if (!entry || entry.socket !== socket) continue;
      pending.delete(id);
      clearTimeout(entry.timer);
      if (frame.exit?._tag === "Success") {
        const value = unwrap(frame.exit);
        const environmentId = value?.environment?.environmentId;
        if (entry.tag === "server.getConfig" && uuid.test(environmentId || "")) byEnvironment.set(environmentId, socket);
        entry.resolve({ ok: true, value });
      } else entry.resolve({ ok: false, error: failureMessage(frame.exit) });
    }
  }
  function track(socket) {
    if (!socket || tracked.has(socket)) return;
    tracked.add(socket);
    sockets.add(socket);
    const notify = () => { if (socket.readyState === 1) for (const fn of socketWaiters) fn(); };
    socket.addEventListener("open", notify, { once: true });
    socket.addEventListener("close", () => {
      sockets.delete(socket);
      frameParts.delete(socket);
      for (const [id, value] of byEnvironment) if (value === socket) byEnvironment.delete(id);
      for (const [id, entry] of pending) if (entry.socket === socket) {
        pending.delete(id); clearTimeout(entry.timer); entry.resolve({ ok: false, error: "socket closed" });
      }
    }, { once: true });
    let incoming = Promise.resolve();
    socket.addEventListener("message", event => {
      const data = event?.data;
      incoming = incoming.then(async () => {
        if (typeof data === "string") receive(socket, data);
        else if (typeof ArrayBuffer !== "undefined" && data instanceof ArrayBuffer) receive(socket, new TextDecoder().decode(data));
        else if (typeof data?.arrayBuffer === "function") receive(socket, new TextDecoder().decode(await data.arrayBuffer()));
      }).catch(() => {});
    });
    notify();
  }
  NativeWS.prototype.send = function () {
    track(this);
    return originalSend.apply(this, arguments);
  };
  class T3HudTrackedWebSocket extends NativeWS {
    constructor(url, protocols) { super(url, protocols); track(this); }
  }
  T3HudTrackedWebSocket.__t3HudTracked = true;
  T3HudTrackedWebSocket.__t3HudOriginal = NativeWS;
  window.WebSocket = T3HudTrackedWebSocket;

  function request(socket, tag, payload, timeoutMs) {
    return new Promise(resolve => {
      const id = String(1000000000000 + Math.floor(Math.random() * 8000000000000) + (++sequence));
      const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, error: "RPC timeout" }); }, timeoutMs);
      pending.set(id, { socket, tag, resolve, timer });
      try { socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] })); }
      catch (error) { pending.delete(id); clearTimeout(timer); resolve({ ok: false, error: error?.message || String(error) }); }
    });
  }
  window.__t3HudRemoteRpc = async (environmentId, tag, payload, timeoutMs = 4500) => {
    const env = String(environmentId || "");
    if (!uuid.test(env)) return { ok: false, error: "environment id missing or invalid" };
    let socket = byEnvironment.get(env);
    if (socket?.readyState === 1) return request(socket, tag, payload, timeoutMs);
    if (![...sockets].some(value => value.readyState === 1)) await new Promise(resolve => {
      const finish = () => { clearTimeout(timer); socketWaiters.delete(finish); resolve(); };
      const timer = setTimeout(finish, Math.min(timeoutMs, 1800));
      socketWaiters.add(finish);
    });
    const open = [...sockets].filter(value => value.readyState === 1);
    if (!open.length) return { ok: false, error: "waiting for an active T3 Connect WebSocket" };
    if (!discovery) discovery = Promise.all(open.map(value => request(value, "server.getConfig", {}, timeoutMs))).finally(() => { discovery = null; });
    await discovery;
    socket = byEnvironment.get(env);
    if (socket?.readyState === 1) return request(socket, tag, payload, timeoutMs);
    return { ok: false, error: "requested environment is not connected" };
  };
  window.__t3HudWsRpcInstalled = true;
  window.__t3HudWsRpcState = {
    version: 4,
    snapshot: () => ({ version: 4, openSockets: [...sockets].filter(value => value.readyState === 1).length, environments: [...byEnvironment.keys()] }),
  };
})();

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

  function resolvePromotedDraftRoute(rawRoute) {
    if (rawRoute === "__NEW__" || rawRoute === "__ROUTE_invalid__") return rawRoute;
    const norm = String(rawRoute || "").startsWith("/") ? String(rawRoute) : "/" + String(rawRoute || "");
    const match = norm.match(/^\/(?:_t3_env_\/([^/?#]+)\/)?draft(?:\/([^/?#]*))?(?:[/?#]|$)/i);
    if (!match) return rawRoute;
    let envFromPath = match[1];
    let draftId = match[2] || "";
    try {
      if (envFromPath) envFromPath = decodeURIComponent(envFromPath);
      draftId = decodeURIComponent(draftId);
    } catch { return "__ROUTE_invalid__"; }
    if (!draftId) return "__NEW__";
    const routeFor = (ref) => {
      const tid = ref?.threadId;
      const env = ref?.environmentId == null || ref.environmentId === "" ? envFromPath : ref.environmentId;
      const validId = (id) => typeof id === "string" && id.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(id) && id !== "." && id !== "..";
      if (!validId(tid) || (env != null && env !== "" && !validId(env))) return null;
      return env ? `/_t3_env_/${encodeURIComponent(env)}/${encodeURIComponent(tid)}` : `/${encodeURIComponent(tid)}`;
    };
    const routeFromState = (p) => {
      // All promotion fields must belong to this exact draft on one state
      // object; unrelated/stale chat state is not evidence of promotion.
      if (p?.draftId !== draftId || p.isServerThread !== true) return null;
      let active = p.activeThreadKey;
      if (typeof active === "string") {
        const explicitEnv = p.environmentId || p.thread?.environmentId || envFromPath || "";
        let env = explicitEnv;
        let tid = active;
        const colon = active.indexOf(":");
        const slash = active.indexOf("/");
        // Match known environments before splitting: environment IDs can
        // contain ':', and raw thread IDs can contain '/'.
        if (explicitEnv && (active.startsWith(`${explicitEnv}:`) || active.startsWith(`${explicitEnv}/`))) {
          tid = active.slice(explicitEnv.length + 1);
        } else if (active.startsWith("thread:")) {
          tid = active;
        } else if (slash >= 0) {
          env = active.slice(0, slash);
          tid = active.slice(slash + 1);
        } else if (colon >= 0) {
          env = active.slice(0, colon) || env;
          tid = active.slice(colon + 1);
        }
        active = { environmentId: env, threadId: tid };
      }
      return routeFor(p) || routeFor(p.threadRef) || routeFor(active) || routeFor({ environmentId: p.environmentId, threadId: p.thread?.id });
    };
    try {
      const parsed = JSON.parse(localStorage.getItem("t3code:composer-drafts:v1") || "null");
      const state = parsed?.state || parsed;
      // A draft entry's own threadId is not proof of promotion.
      const route = routeFor(state?.promotedDraftRedirects?.[draftId]) || routeFor(state?.drafts?.[draftId]?.promotedTo) || routeFor(state?.draftThreadsByThreadKey?.[draftId]?.promotedTo);
      if (route) return route;
    } catch {}
    try {
      const rootEl = document.getElementById("root");
      const key = rootEl && Object.keys(rootEl).find((k) => k.startsWith("__reactContainer") || k.startsWith("__reactFiber"));
      let entry = key ? rootEl[key] : null;
      const ancestors = new Set();
      while (entry?.return && !entry.stateNode?.current && ancestors.size < 400 && !ancestors.has(entry)) {
        ancestors.add(entry);
        entry = entry.return;
      }
      if (entry?.return && !entry.stateNode?.current) return "__NEW__";
      // HostRoot's expando may point at the alternate; only inspect the
      // committed tree, never stale/unmounted alternate chat props.
      const committed = entry?.stateNode?.current || entry?.current || entry;
      const stack = committed ? [committed] : [];
      const seen = new Set();
      while (stack.length && seen.size < 400) {
        const f = stack.pop();
        if (!f || seen.has(f)) continue;
        seen.add(f);
        const route = routeFromState(f.memoizedProps) || routeFromState(f.pendingProps);
        if (route) return route;
        // v0.1.10 can keep the same fields in hook state instead of props.
        let hook = f.memoizedState;
        const hooks = new Set();
        while (hook && typeof hook === "object" && !hooks.has(hook) && hooks.size < 100) {
          hooks.add(hook);
          const hookRoute = routeFromState(hook) || routeFromState(hook.memoizedState);
          if (hookRoute) return hookRoute;
          hook = hook.next;
        }
        if (f.sibling) stack.push(f.sibling);
        if (f.child) stack.push(f.child);
      }
    } catch {}
    return "__NEW__";
  }

  function getRouteHint() {
    // The app may keep its hash on /draft/<id> after promoting a draft. In
    // that case the router's resolved pathname is the current conversation;
    // use it before falling back to the unchanged hash.
    try {
      const rp = getRouterPathname(findTanStackRouter());
      if (typeof rp === "string" && rp) return rp === "/" ? "__NEW__" : resolvePromotedDraftRoute(rp);
    } catch {}
    const hash = window.location.hash || "";
    if (hash.startsWith("#/") || hash.length > 1) {
      return resolvePromotedDraftRoute(hash.slice(1));
    }
    return resolvePromotedDraftRoute(window.location.pathname || "/");
  }

  function toEpochMs(v) {
    if (v == null || v === "") return null;
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
    const clean = String(rawHint || "").split(/[?#]/, 1)[0];
    if (clean === "__NEW__" || clean === "__ROUTE_invalid__" || /^\/?(?:_t3_env_\/[^/]+\/)?draft(?:\/|$)/i.test(clean) || /^\/?new\/?$/i.test(clean)) return "__NEW__";
    if (!clean) return null;
    const parts = clean.split("/").filter(Boolean);
    if ((parts[0] === "_t3_env_" && parts.length === 3) ||
        (parts.length === 2 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parts[0]))) {
      try { return decodeURIComponent(parts.at(-1)); } catch { return "__ROUTE_invalid__"; }
    }
    for (let i = parts.length - 1; i >= 0; i--) {
      let seg = parts[i];
      // Delegated subagent ids are literally `thread:delegated-task:command%3A...`:
      // decoding them would turn the inner `%3A` into `:` and break every match.
      if (seg.startsWith("thread:")) return seg;
      if (seg.toLowerCase().startsWith("thread%3a")) {
        try { return decodeURIComponent(seg); } catch { return seg; }
      }
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return seg;
    }
    return null;
  }

  function buildProjectionPayload(p, stEnvId, uhProps) {
    const ctxList = Array.isArray(p.providerThreads) ? p.providerThreads : [];
    const activeDriver = String(
      p.thread?.modelSelection?.provider ||
      p.thread?.modelSelection?.instanceId ||
      p.thread?.providerInstanceId ||
      ""
    );
    const normalizeProjDriver = (driver, providerOrInstance) => {
      const d = String(driver || "").trim();
      const pId = String(providerOrInstance || "").trim();
      if (d === "acpRegistry" && pId.startsWith("acpRegistry_")) return pId;
      return d || pId;
    };
    const driversMatch = (a, b) => {
      const la = String(a || "").trim().toLowerCase();
      const lb = String(b || "").trim().toLowerCase();
      if (!la || !lb) return false;
      if (la === lb) return true;
      return (la === "acpregistry" && lb.startsWith("acpregistry_")) || (lb === "acpregistry" && la.startsWith("acpregistry_"));
    };
    let lastUsage = null;
    let driverUsage = null;
    for (const pt of ctxList) {
      if (!pt || !pt.contextUsage) continue;
      const drv = normalizeProjDriver(pt.driver || pt.providerThreadRef?.driver, pt.providerInstanceId || pt.provider);
      if (!drv) lastUsage = pt.contextUsage;
      if (activeDriver) {
        if (driversMatch(drv, activeDriver)) driverUsage = pt.contextUsage;
      } else {
        lastUsage = pt.contextUsage;
      }
    }
    const contextUsage = activeDriver ? driverUsage : lastUsage;
    const isRunningStatus = (st) => st === "running" || st === "starting" || st === "in_progress";
    const isActiveTurnStatus = (st) => st === "running" || st === "pending" || st === "starting" || st === "in_progress";
    const sessionDriverOf = (s) => normalizeProjDriver(s?.driver, s?.providerInstanceId || s?.provider);
    const linkedSessionDriverOf = (pt) => {
      const sid = pt?.providerSessionId ?? pt?.sessionId ?? null;
      if (sid == null || String(sid) === "") return "";
      const sess = (p.providerSessions || []).find((s) => String(s?.id ?? s?.providerSessionId ?? "") === String(sid));
      return sess ? sessionDriverOf(sess) : "";
    };
    const turnDriverOf = (pt) => normalizeProjDriver(pt?.nativeTurnRef?.driver || pt?.driver, pt?.providerInstanceId || pt?.provider || linkedSessionDriverOf(pt));
    const itemDriverOf = (it) => {
      const drivers = new Set();
      const add = (v) => { if (v != null && String(v).trim() !== "") drivers.add(String(v).trim()); };
      add(it?.nativeTurnRef?.driver);
      add(it?.nativeItemRef?.driver);
      add(it?.payload?.nativeTurnRef?.driver);
      add(it?.payload?.nativeItemRef?.driver);
      add(it?.driver);
      add(it?.provider);
      add(it?.payload?.driver);
      add(it?.payload?.provider);
      if (drivers.size === 0) return "";
      if (drivers.size > 1) return "__conflicting_driver__";
      return [...drivers][0];
    };
    const recordStampMs = (rec) => {
      for (const v of [rec?.updatedAt, rec?.completedAt, rec?.completedMs, rec?.startedAt, rec?.startedMs, rec?.createdAt]) {
        const ms = toEpochMs(v);
        if (ms != null) return ms;
      }
      return null;
    };
    const pickLatestRecord = (list, filterFn) => {
      let best = null;
      let bestMs = null;
      for (const item of list || []) {
        if (!item || (filterFn && !filterFn(item))) continue;
        const ms = recordStampMs(item);
        if (!best || (ms != null && (bestMs == null || ms >= bestMs)) || (ms == null && bestMs == null)) {
          best = item;
          if (ms != null) bestMs = ms;
        }
      }
      return best;
    };
    const latestDriverSession = activeDriver
      ? pickLatestRecord(p.providerSessions, (s) => driversMatch(sessionDriverOf(s), activeDriver))
      : pickLatestRecord(p.providerSessions, Boolean);
    const latestDriverTurn = activeDriver
      ? pickLatestRecord(p.providerTurns, (pt) => driversMatch(turnDriverOf(pt), activeDriver))
      : pickLatestRecord(p.providerTurns, Boolean);
    const latestSessionRunning = (() => {
      if (!latestDriverSession || !isRunningStatus(String(latestDriverSession.status || ""))) return false;
      if (latestDriverTurn && !isActiveTurnStatus(String(latestDriverTurn.status || ""))) {
        const sMs = recordStampMs(latestDriverSession);
        const tDoneMs = toEpochMs(latestDriverTurn.completedAt ?? latestDriverTurn.completedMs) ?? recordStampMs(latestDriverTurn);
        if (sMs != null && tDoneMs != null && tDoneMs >= sMs) return false;
      }
      return true;
    })();
    const hasActiveDriverTurn = Boolean(activeDriver) && Boolean(
      latestDriverTurn && isActiveTurnStatus(String(latestDriverTurn.status || ""))
    );
    const hasActiveDriverWork = Boolean(activeDriver) && (latestSessionRunning || hasActiveDriverTurn);
    const resolveRunDriver = (run) => {
      let rDrv = String(run?.driver || run?.provider || run?.providerInstanceId || run?.nativeTurnRef?.driver || "").trim();
      if (!rDrv) {
        const rTurnId = run?.providerTurnId ?? run?.turnId ?? run?.id ?? null;
        if (rTurnId != null && String(rTurnId) !== "") {
          const linked = (p.providerTurns || []).find((pt) => String(pt?.id ?? pt?.providerTurnId ?? "") === String(rTurnId));
          if (linked) rDrv = turnDriverOf(linked);
        }
      }
      return rDrv;
    };
    const latestRelevantRun = activeDriver
      ? pickLatestRecord(p.runs, (r) => {
          const d = resolveRunDriver(r);
          return d ? driversMatch(d, activeDriver) : hasActiveDriverWork;
        })
      : pickLatestRecord(p.runs, Boolean);
    const latestRunRunning = Boolean(latestRelevantRun && isRunningStatus(String(latestRelevantRun.status || "")));
    // Everything that is not conversational content counts as tool wait
    // (file_search / web_search / mcp / dynamic tools included).
    const CONTENT_EXCLUDE = new Set(["root_turn", "assistant_message", "reasoning", "user_message", "checkpoint", "notification"]);
    const matchTid = (a, b) => {
      if (!a || !b) return false;
      if (a === b) return true;
      const full = (v) => {
        let cur = String(v || "");
        for (let k = 0; k < 4; k++) {
          try {
            const nxt = decodeURIComponent(cur);
            if (nxt === cur) break;
            cur = nxt;
          } catch { break; }
        }
        return cur;
      };
      return full(a) === full(b);
    };
    const itemKind = (it) => String(it?.kind ?? it?.type ?? "");
    const itemTurnId = (it) => it?.providerTurnId ?? it?.turnId ?? it?.providerTurn?.id ?? null;
    const itemStartedMs = (it) => toEpochMs(it?.startedAt ?? it?.startedMs);
    const itemCompletedMs = (it) => toEpochMs(it?.completedAt ?? it?.completedMs);
    const weightTextTokens = (raw) => {
      if (!raw) return 0;
      const str = typeof raw === "string" ? raw : JSON.stringify(raw);
      let cjk = 0;
      let ascii = 0;
      let other = 0;
      for (let i = 0; i < str.length; i++) {
        const cp = str.charCodeAt(i);
        if (cp >= 0x4e00 && cp <= 0x9fff) cjk++;
        else if (cp <= 0x7f) ascii++;
        else other++;
      }
      return Math.round(cjk * 0.88 + ascii * 0.33 + other * 0.75);
    };
    const sampledAtMs = Number.isFinite(p?.sampledAtMs) ? p.sampledAtMs : Date.now();
    const threadRunning = latestRunRunning || latestSessionRunning || hasActiveDriverTurn;
    const toolObservedEnd = (it, turn) => {
      const completedMs = itemCompletedMs(it);
      if (completedMs != null) return completedMs;
      const status = String(it.status || "").toLowerCase();
      if (status && !["running", "pending", "in_progress", "starting"].includes(status)) return null;
      if (turn && (toEpochMs(turn.completedAt ?? turn.completedMs) != null ||
        ["completed", "cancelled", "canceled", "failed", "error", "interrupted"].includes(turn.status))) return null;
      const running = turn ? ["running", "pending", "starting", "in_progress"].includes(turn.status) || threadRunning : threadRunning;
      const s = itemStartedMs(it);
      if (!running || s == null) return null;
      const updated = toEpochMs(it.updatedAt);
      const obsMs = updated != null && updated > s ? Math.max(sampledAtMs, updated) : sampledAtMs;
      return obsMs > s && obsMs - s < 600000 ? obsMs : null;
    };
    const rawItems = (Array.isArray(p.turnItems) && p.turnItems) || (Array.isArray(p.items) && p.items) || null;
    const toolIntervals = [];
    for (const n of rawItems || p.nodes || []) {
      if (!n) continue;
      if (n.threadId != null && !matchTid(String(n.threadId), String(p.thread?.id || ""))) continue;
      const nTurnId = itemTurnId(n);
      if (nTurnId == null || String(nTurnId) === "") continue;
      const itemDriver = itemDriverOf(n);
      if (itemDriver === "__conflicting_driver__") continue;
      if (itemDriver && activeDriver && itemDriver !== activeDriver) continue;
      if (!CONTENT_EXCLUDE.has(itemKind(n))) {
        const owner = (p.providerTurns || []).find(pt => String(pt?.id ?? pt?.providerTurnId ?? "") === String(nTurnId));
        if (!owner) continue;
        const ownerDriver = turnDriverOf(owner);
        if (ownerDriver && activeDriver && ownerDriver !== activeDriver) continue;
        if (!ownerDriver && activeDriver && p.thread?.modelSelection?.provider) continue;
        if (itemDriver && ownerDriver && itemDriver !== ownerDriver) continue;
        const s = itemStartedMs(n);
        const e = toolObservedEnd(n, owner);
        const ownerId = String(owner?.id ?? owner?.providerTurnId ?? nTurnId);
        if (s != null && e != null && e > s) toolIntervals.push([s, e, ownerId, ownerDriver || itemDriver || null]);
      }
    }
    const turns = (p.providerTurns || []).map((pt) => {
      const ptId = pt?.id ?? pt?.providerTurnId ?? null;
      const turnId = ptId == null ? null : String(ptId);
      const startedMs = toEpochMs(pt?.startedAt ?? pt?.startedMs);
      const resolvedTurnDriver = turnDriverOf(pt);
      const driver = resolvedTurnDriver || (!p.thread?.modelSelection?.provider && !p.thread?.modelSelection?.instanceId ? (activeDriver || null) : null);
      const effectiveItemGuardDriver = driver || activeDriver || null;
      // Pure streaming decode window: final assistant_message span after last tool end.
      let streamDecode = null;
      if (turnId) {
        const items = rawItems || p.nodes || [];
        let lastToolEndMs = -Infinity;
        let toolsInTurn = 0;
        let asstCount = 0;
        const assts = [];
        const pTid = String(p.thread?.id || "");
        for (const it of items) {
          if (!it) continue;
          if (pTid && it.threadId != null && !matchTid(String(it.threadId), pTid)) continue;
          const itTurnId = itemTurnId(it);
          if (itTurnId == null || String(itTurnId) !== turnId) continue;
          const itDriver = itemDriverOf(it);
          if (itDriver === "__conflicting_driver__") continue;
          if (itDriver && effectiveItemGuardDriver && itDriver !== effectiveItemGuardDriver) continue;
          const k = itemKind(it);
          if (k === "assistant_message") {
            asstCount++;
            const s = itemStartedMs(it);
            const e = itemCompletedMs(it);
            if (s != null && e != null) assts.push({ s, e, it });
          } else if (!CONTENT_EXCLUDE.has(k)) {
            toolsInTurn++;
            const e = toolObservedEnd(it, pt);
            if (e != null && e > lastToolEndMs) lastToolEndMs = e;
          }
        }
        if (assts.length) {
          const floor = lastToolEndMs === -Infinity ? -Infinity : lastToolEndMs - 50;
          const cands = assts.filter((a) => a.s >= floor && a.e > a.s + 180);
          if (cands.length) {
            cands.sort((a, b) => a.e - b.e || a.s - b.s);
            const last = cands[cands.length - 1];
            const streamSec = (last.e - last.s) / 1000;
            if (streamSec >= 0.18) {
              let visFraction = null;
              const turnHasText = assts.some((a) => a.it?.text != null);
              if (turnHasText) {
                const lastWeight = weightTextTokens(last.it?.text);
                let allWeight = 0;
                for (const a of assts) allWeight += weightTextTokens(a.it?.text);
                let toolArgWeight = 0;
                for (const it of items) {
                  if (!it) continue;
                  if (pTid && it.threadId != null && !matchTid(String(it.threadId), pTid)) continue;
                  const itTurnId = itemTurnId(it);
                  if (itTurnId == null || String(itTurnId) !== turnId) continue;
                  const itDriver = itemDriverOf(it);
                  if (itDriver === "__conflicting_driver__") continue;
                  if (itDriver && effectiveItemGuardDriver && itDriver !== effectiveItemGuardDriver) continue;
                  if (!CONTENT_EXCLUDE.has(itemKind(it)) && itemKind(it) !== "assistant_message") {
                    toolArgWeight += weightTextTokens(it.input || it.pattern || it.arguments || "") + 18;
                  }
                }
                if (toolsInTurn === 0) visFraction = 1;
                else if (allWeight + toolArgWeight > 0) visFraction = lastWeight / (allWeight + toolArgWeight);
              } else if (toolsInTurn === 0 && asstCount === 1) {
                visFraction = 1;
              }
              streamDecode = { streamSec, visFraction };
            }
          }
        }
      }
      let lastItemMs = null;
      let itemOutput = 0;
      const waits = [];
      for (const it of rawItems || p.nodes || []) {
        if (!it || !turnId || String(itemTurnId(it) ?? "") !== turnId) continue;
        if (it.threadId != null && !matchTid(String(it.threadId), String(p.thread?.id || ""))) continue;
        const itemDriver = itemDriverOf(it);
        if (itemDriver === "__conflicting_driver__") continue;
        if (itemDriver && effectiveItemGuardDriver && itemDriver !== effectiveItemGuardDriver) continue;
        const itemStart = itemStartedMs(it);
        if (startedMs != null && itemStart != null && itemStart < startedMs) continue;
        const stamps = [itemCompletedMs(it), toEpochMs(it.updatedAt), itemStart].filter(Number.isFinite);
        const explicit = Number(it.outputTokens ?? it.usage?.outputTokens ?? it.tokenCount);
        const contentOutput = explicit > 0 ? explicit : weightTextTokens(it.text || it.content || it.delta || "") || Math.max(0, Number(it.charCount) || 0) * 0.28;
        if (toEpochMs(pt?.completedAt ?? pt?.completedMs) == null && itemCompletedMs(it) == null &&
          (contentOutput > 0 || ["running", "in_progress", "starting"].includes(it.status) || itemStart != null)) {
          const observed = toEpochMs(it.updatedAt) ?? sampledAtMs;
          if (itemStart == null || observed >= itemStart) stamps.push(observed);
        }
        if (stamps.length) lastItemMs = Math.max(lastItemMs ?? -Infinity, ...stamps);
        if (itemKind(it) === "assistant_message" || itemKind(it) === "reasoning") {
          itemOutput += contentOutput;
        } else if (!CONTENT_EXCLUDE.has(itemKind(it))) {
          const end = toolObservedEnd(it, pt);
          if (itemStart != null && end != null && end > itemStart) waits.push([itemStart, end]);
        }
      }
      let itemEstimateTps = null;
      const output = Number(pt?.turnTokenUsage?.outputTokens) > 0 ? Number(pt.turnTokenUsage.outputTokens) : itemOutput;
      if (Number.isFinite(startedMs) && lastItemMs > startedMs + 50 && output > 0) {
        let cursor = startedMs;
        let waitMs = 0;
        for (const [start, end] of waits.sort((a, b) => a[0] - b[0])) {
          const left = Math.max(startedMs, cursor, start);
          const right = Math.min(lastItemMs, end);
          if (right > left) waitMs += right - left;
          cursor = Math.max(cursor, right);
        }
        const netSec = (lastItemMs - startedMs - waitMs) / 1000;
        const rate = output / netSec;
        if (netSec > 0.05 && Number.isFinite(rate) && rate > 0 && rate <= 1500) itemEstimateTps = Math.round(rate * 10) / 10;
      }
      return {
        id: turnId,
        providerTurnId: pt?.providerTurnId != null && String(pt.providerTurnId) !== "" ? String(pt.providerTurnId) : null,
        nativeTurnId: pt?.nativeTurnRef?.nativeId != null && String(pt.nativeTurnRef.nativeId) !== "" ? String(pt.nativeTurnRef.nativeId) : null,
        status: pt?.status || null,
        driver,
        startedMs,
        lastItemMs,
        itemEstimateTps,
        itemOutputTokens: itemOutput,
        completedMs: toEpochMs(pt?.completedAt),
        usage: pt?.turnTokenUsage || null,
        streamDecode,
      };
    });
    const tid = String(p.thread?.id || "");
    const uhMatches = uhProps && (!tid || !uhProps.threadId || String(uhProps.threadId) === tid);
    return {
      sampledAtMs,
      environmentId: String(stEnvId || (uhMatches ? uhProps.environmentId : "") || ""),
      threadId: tid || (uhMatches ? String(uhProps.threadId || "") : ""),
      title: String(p.thread?.title || ""),
      provider: activeDriver,
      model: String(p.thread?.modelSelection?.model || ""),
      branch: p.thread?.branch || null,
      repoPath: (uhMatches && uhProps.gitCwd) || p.thread?.worktreePath || null,
      isServerThread: uhMatches ? Boolean(uhProps.isServerThread) : true,
      isRunning: threadRunning,
      subagentCount: Array.isArray(p.subagents) ? p.subagents.length : 0,
      contextUsage,
      toolIntervals,
      turns,
      gitCwd: (uhMatches && uhProps.gitCwd) || p.thread?.worktreePath || null,
    };
  }

  function readFiberThreadProjection(expectedThreadId) {
    const expected = extractLastThreadIdFromHint(expectedThreadId);
    if (expected === "__NEW__" || expected === "__ROUTE_invalid__") return null;
    if (expectedThreadId && !expected) return null;
    const fullyDecode = (v) => {
      let cur = String(v || "");
      for (let k = 0; k < 4; k++) {
        try {
          const next = decodeURIComponent(cur);
          if (next === cur) break;
          cur = next;
        } catch {
          break;
        }
      }
      return cur;
    };
    const safeDecodeOnce = (v) => {
      try {
        return decodeURIComponent(String(v || ""));
      } catch {
        return String(v || "");
      }
    };
    // Delegated ids mix raw `%3A`, single- and double-encoded forms; all must match.
    const sameThreadId = (a, b) => {
      const x = String(a || "");
      const y = String(b || "");
      if (x === y) return true;
      if (safeDecodeOnce(x) === safeDecodeOnce(y)) return true;
      return fullyDecode(x) === fullyDecode(y);
    };
    const fiberItemsOf = (st) => {
      if (Array.isArray(st?.turnItems) && st.turnItems.length) return st.turnItems;
      if (Array.isArray(st?.projection?.turnItems) && st.projection.turnItems.length) return st.projection.turnItems;
      if (Array.isArray(st?.items) && st.items.length) return st.items;
      return null;
    };
    const withFiberItems = (proj, items) => {
      if (!items) return proj;
      if (proj && (proj.turnItems || proj.items)) return proj;
      const shallow = {};
      for (const k of Object.keys(proj || {})) shallow[k] = proj[k];
      shallow.turnItems = items;
      return shallow;
    };
    let uhProps = null;
    let matchedSt = null;
    let matchedItems = null;
    let fallbackSt = null;
    let fallbackItems = null;
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
            if (!uhProps || (expected && sameThreadId(candTid, expected))) {
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
              if (!fallbackSt) {
                fallbackSt = st;
                fallbackItems = fiberItemsOf(st);
              }
              if (expected && sameThreadId(pid, expected) && !matchedSt) {
                matchedSt = st;
                matchedItems = fiberItemsOf(st);
              }
            }
            h = h.next;
            d++;
          }
        } catch {}
        if (matchedSt && uhProps && (!expected || sameThreadId(String(uhProps.threadId || ""), expected))) break;
        if (f.child) stack.push(f.child);
        if (f.sibling) stack.push(f.sibling);
      }
    } catch {}

    if (matchedSt) {
      return buildProjectionPayload(withFiberItems(matchedSt.projection, matchedItems), matchedSt.environmentId, uhProps);
    }
    if (!expectedThreadId && fallbackSt) {
      return buildProjectionPayload(withFiberItems(fallbackSt.projection, fallbackItems), fallbackSt.environmentId, uhProps);
    }
    if (uhProps && (!expected || sameThreadId(String(uhProps.threadId || ""), expected))) {
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

  function getHudRemoteProject(request = {}) {
    const wantedEnv = typeof request.environmentId === "string" ? request.environmentId : "";
    const wantedThread = typeof request.threadId === "string" ? request.threadId : "";
    if (!wantedEnv || !wantedThread) return null;
    const routeHint = getRouteHint();
    const route = String(routeHint || "").split(/[?#]/, 1)[0];
    const parts = route.split("/").filter(Boolean);
    let envPart = null;
    if (parts[0] === "_t3_env_" && parts.length === 3) envPart = parts[1];
    else if (parts.length === 2 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parts[0])) envPart = parts[0];
    if (!envPart) return null;
    let routeEnv;
    try { routeEnv = decodeURIComponent(envPart); } catch { return null; }
    if (routeEnv !== wantedEnv || extractLastThreadIdFromHint(route) !== wantedThread) return null;
    try {
      const rootEl = document.getElementById("root");
      const key = rootEl && Object.keys(rootEl).find((name) => name.startsWith("__reactContainer") || name.startsWith("__reactFiber"));
      let entry = key ? rootEl[key] : null;
      const ancestors = new Set();
      while (entry?.return && !entry.stateNode?.current && ancestors.size < 400 && !ancestors.has(entry)) {
        ancestors.add(entry); entry = entry.return;
      }
      if (entry?.return && !entry.stateNode?.current) return null;
      const committed = entry?.stateNode?.current || entry?.current || entry;
      const stack = committed ? [committed] : [], seen = new Set();
      while (stack.length && seen.size < 20000) {
        const fiber = stack.pop();
        if (!fiber || seen.has(fiber)) continue;
        seen.add(fiber);
        const props = fiber.memoizedProps;
        const cwd = props?.gitCwd;
        const absolute = typeof cwd === "string" && (/^\//.test(cwd) || /^[A-Za-z]:[\\\\/]/.test(cwd));
        const safe = absolute && !/[\u0000-\u001f\u007f]/.test(cwd) && !cwd.split(/[\\\\/]+/).includes("..");
        if (props?.isServerThread === true && props.environmentId === wantedEnv && props.threadId === wantedThread && safe) {
          if (getRouteHint() !== routeHint) return null;
          return { environmentId: wantedEnv, threadId: wantedThread, projectRoot: cwd };
        }
        if (fiber.sibling) stack.push(fiber.sibling);
        if (fiber.child) stack.push(fiber.child);
      }
    } catch {}
    return null;
  }

  if (typeof window !== "undefined") window.__t3HudRemoteProject = getHudRemoteProject;

  function fallbackModelRate(model) {
    const m = String(model || "").trim().toLowerCase();
    if (m.includes("muse-ember")) return { input: 0.1 / 1e6, output: 0.5 / 1e6, cacheRead: 0.004 / 1e6, cacheWrite: 0.1 / 1e6 };
    if (m.includes("muse-wonder")) return { input: 5.4 / 1e6, output: 27 / 1e6, cacheRead: 0.54 / 1e6, cacheWrite: 5.4 / 1e6 };
    if (m.includes("opus")) return { input: 5.0 / 1e6, output: 25.0 / 1e6, cacheRead: 0.5 / 1e6, cacheWrite: 6.25 / 1e6 };
    if (m.includes("sonnet")) return { input: 3.0 / 1e6, output: 15.0 / 1e6, cacheRead: 0.3 / 1e6, cacheWrite: 3.75 / 1e6 };
    if (m.includes("gpt-6.1-terra")) return { input: 1.0 / 1e6, output: 5.0 / 1e6, cacheRead: 0.05 / 1e6, cacheWrite: 1.0 / 1e6 };
    if (m.includes("gpt-6") || m.includes("carbon") || m.includes("argon")) return { input: 2.0 / 1e6, output: 10.0 / 1e6, cacheRead: 0.1 / 1e6, cacheWrite: 2.0 / 1e6 };
    if (m.includes("hydrogen")) return { input: 1.5 / 1e6, output: 7.5 / 1e6, cacheRead: 0.075 / 1e6, cacheWrite: 1.5 / 1e6 };
    return { input: 5.4 / 1e6, output: 27 / 1e6, cacheRead: 0.54 / 1e6, cacheWrite: 5.4 / 1e6 };
  }

  function buildLocalProjectionFallback(remotePayload) {
    const payload = remotePayload && typeof remotePayload === "object" ? remotePayload : null;
    if (!payload) return { ok: false, error: "Invalid remote payload" };
    const turns = Array.isArray(payload.turns) ? payload.turns : [];
    const rawToolIntervals = Array.isArray(payload.toolIntervals) ? payload.toolIntervals : [];
    const isLegacySingleFixture = payload.sampledAtMs == null && turns.length === 1 && turns[0] && typeof turns[0] === "object"
      && !("id" in turns[0]) && !("providerTurnId" in turns[0]) && !("nativeTurnId" in turns[0]);
    const subtractWait = (startMs, endMs, turnId, turnDriver) => {
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0;
      const hasTid = turnId != null && String(turnId) !== "";
      const allowLegacySingle = !hasTid && isLegacySingleFixture && turnDriver && turnDriver !== "unknown" && (!payload.provider || String(turnDriver) === String(payload.provider));
      if (!hasTid && !allowLegacySingle) return Math.max(0, endMs - startMs) / 1000;
      const intervals = [];
      for (const iv of rawToolIntervals) {
        if (!Array.isArray(iv) || !Number.isFinite(iv[0]) || !Number.isFinite(iv[1]) || iv[1] <= iv[0]) continue;
        if (hasTid) {
          if (iv.length < 3 || iv[2] == null || String(iv[2]) === "") continue;
          if (String(iv[2]) !== String(turnId)) continue;
          if (iv.length >= 4 && iv[3] != null && String(iv[3]) !== "") {
            if (turnDriver && turnDriver !== "unknown" && String(iv[3]) !== String(turnDriver)) continue;
          }
        } else if (iv.length !== 2) {
          continue;
        }
        intervals.push([iv[0], iv[1]]);
      }
      intervals.sort((a, b) => a[0] - b[0]);
      const merged = [];
      for (const [s, e] of intervals) {
        const last = merged[merged.length - 1];
        if (last && s <= last[1]) {
          if (e > last[1]) last[1] = e;
        } else {
          merged.push([s, e]);
        }
      }
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
    let decodeTokSum = 0;
    let decodeSecSum = 0;
    let lastTurnDecodeTps = null;
    let lastStreamSec = null;
    let lastPromptTotal = null;
    let turnCacheRate = null;
    let lastTurnDriver = null;
    let lastTurnModel = null;
    const byModel = {};
    const decodeByModel = {};
    const resolveLocalTurnDriver = (t) => {
      if (t && Object.prototype.hasOwnProperty.call(t, "driver")) {
        return t.driver ? String(t.driver) : "unknown";
      }
      return payload.provider || "unknown";
    };
    for (const t of turns) {
      const u = t?.usage;
      turnCacheRate = null;
      lastTurnTps = null;
      lastTurnNetSec = null;
      lastTurnDecodeTps = null;
      lastStreamSec = null;
      lastTurnDriver = resolveLocalTurnDriver(t);
      lastTurnModel = u?.models?.[0] || t?.model || payload.model || null;
      if (!u || typeof u.inputTokens !== "number" || u.usageStatus === "unavailable") {
        continue;
      }
      lastTurnTps = null;
      lastTurnNetSec = null;
      lastTurnDecodeTps = null;
      lastStreamSec = null;
      const driver = resolveLocalTurnDriver(t);
      let inp = Math.max(0, u.inputTokens || 0);
      const cr = Math.max(0, u.cachedInputTokens || 0);
      const cw = Math.max(0, u.cacheCreationTokens || 0);
      if (driver === "antigravity" && inp >= cr * 2) inp = inp - cr;
      if (inp > 0 && Number.isFinite(u.cachedInputTokens)) turnCacheRate = Math.min(inp, cr) / inp;
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
      lastTurnDriver = driver;
      lastTurnModel = turnModel;
      if (Number.isFinite(t.startedMs) && Number.isFinite(t.completedMs) && t.completedMs > t.startedMs && out > 0) {
        wallOutSum += out;
        wallSecSum += (t.completedMs - t.startedMs) / 1000;
      }
      const visOut = Math.max(0, out - reas);
      const sd = t?.streamDecode;
      if (sd && Number.isFinite(sd.streamSec) && sd.streamSec >= 0.18 && Number.isFinite(sd.visFraction) && sd.visFraction > 0) {
        const streamTok = Math.round(visOut * Math.min(1, sd.visFraction));
        if (streamTok >= 12 && streamTok / sd.streamSec < 900) {
          decodeTokSum += streamTok;
          decodeSecSum += sd.streamSec;
          lastTurnDecodeTps = streamTok / sd.streamSec;
          lastStreamSec = sd.streamSec;
          if (turnModel) {
            const cur = (decodeByModel[turnModel] ||= { tok: 0, sec: 0 });
            cur.tok += streamTok;
            cur.sec += sd.streamSec;
          }
        }
      }
      if (Number.isFinite(t.startedMs) && Number.isFinite(t.completedMs) && t.completedMs > t.startedMs + 50 && out >= 15) {
        const netSec = subtractWait(t.startedMs, t.completedMs, t.id ?? t.providerTurnId ?? null, driver);
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
    let promptTotal = sumUncached + sumCached + sumCacheWrite;
    let uncachedOut = sumUncached;
    let outputOut = sumOutput;
    let totalUsd = sumUsd;
    let totalSavedUsd = sumSavedUsd;
    let estimated = false;
    const sessionCacheRate = promptTotal > 0 ? sumCached / promptTotal : null;
    const providerSwitched = Boolean(payload.provider && lastTurnDriver && payload.provider !== lastTurnDriver);
    const effDriver = providerSwitched ? payload.provider : (lastTurnDriver || payload.provider || "unknown");
    const effModel = providerSwitched ? (payload.model || null) : (lastTurnModel || payload.model || null);
    const effectiveLastPrompt = providerSwitched ? null : lastPromptTotal;
    const effectiveTurnCacheRate = providerSwitched ? null : turnCacheRate;
    let contextUsed = payload.contextUsage?.usedTokens ?? effectiveLastPrompt;
    if (effDriver === "antigravity" && payload.contextUsage?.usedTokens > 0) {
      const agyCacheRatio = effectiveTurnCacheRate ?? sessionCacheRate ?? 0;
      const deduped =
        agyCacheRatio > 0.01
          ? Math.round(payload.contextUsage.usedTokens / (1 + Math.min(1, agyCacheRatio)))
          : payload.contextUsage.usedTokens;
      contextUsed = deduped;
      if (!payload.isRunning && effectiveLastPrompt != null && deduped > effectiveLastPrompt * 2.5) {
        contextUsed = effectiveLastPrompt;
      }
    }
    let contextMax = Number.isFinite(payload.contextUsage?.maxTokens) && payload.contextUsage.maxTokens > 0
      ? payload.contextUsage.maxTokens
      : null;
    let contextMaxSource = contextMax != null ? "reported" : null;
    if (contextMax == null && effDriver === "antigravity") {
      contextMax = /opus|sonnet|haiku|claude/i.test(String(effModel || "")) ? 1000000 : 1048576;
      contextMaxSource = "estimated";
    }
    if (contextMax == null && effDriver === "muse") {
      contextMax = 1007997;
      contextMaxSource = "estimated";
    }
    if (contextMax == null && effDriver === "acpRegistry_devin" && /swe-2/i.test(String(effModel || ""))) {
      contextMax = 262000;
      contextMaxSource = "estimated";
    }
    if (pricedTurns === 0 && Number.isFinite(contextUsed) && contextUsed > 0) {
      promptTotal = contextUsed;
      uncachedOut = contextUsed;
      outputOut = 0;
      const lr = fallbackModelRate(effModel || effDriver);
      totalUsd = contextUsed * lr.input;
      totalSavedUsd = 0;
      estimated = true;
    }
    const hasDecode = decodeSecSum > 0;
    const tokPerSec = hasDecode ? decodeTokSum / decodeSecSum : netSecSum > 0.2 ? netOutSum / netSecSum : null;
    const e2eTokPerSec = wallSecSum > 0.2 && wallOutSum > 0 ? wallOutSum / wallSecSum : tokPerSec;
    const byModelSpeed = Object.fromEntries(
      Object.entries(hasDecode ? decodeByModel : byModel)
        .filter(([, v]) => v.sec > 0.1)
        .map(([k, v]) => [k, Math.round((v.tok / v.sec) * 10) / 10])
    );
    const lastDecodeTps = providerSwitched ? null : (lastTurnDecodeTps ?? lastTurnTps);
    const lastDurationSec = providerSwitched ? null : (lastStreamSec ?? lastTurnNetSec);
    const isLocalTurnActive = (last, selectedProvider) => {
      if (!last) return false;
      const s = String(last.status || "").toLowerCase();
      if (s === "completed" || s === "interrupted" || s === "failed" || s === "error" || s === "cancelled" || s === "canceled") return false;
      if (s === "running" || s === "pending" || s === "starting" || s === "in_progress") {
        const d = last.driver || null;
        if (d != null && selectedProvider != null && String(d) !== String(selectedProvider)) return false;
        return true;
      }
      const completedMs = last.completedMs ?? last.completedAt ?? null;
      const startedMs = last.startedMs ?? last.startedAt ?? null;
      if (completedMs != null && startedMs != null && Number(completedMs) > Number(startedMs)) return false;
      if (completedMs != null && startedMs == null) return false;
      return false;
    };
    const localLatest = turns[turns.length - 1] || null;
    const localSelectedProvider = payload.provider || effDriver;
    const localActive = isLocalTurnActive(localLatest, localSelectedProvider);
    const localRunningWithoutActive = Boolean(payload.isRunning && !localActive);
    const localActiveTurnIds = Boolean(payload.isRunning) && !localRunningWithoutActive && localActive && localLatest
      ? Array.from(new Set([localLatest.id, localLatest.providerTurnId, localLatest.nativeTurnId].filter((v) => v != null && String(v) !== "").map(String)))
      : [];
    const localEstimateTps = (() => {
      // Only expose an estimate for the strictly current running turn when its own sub-step sample exists.
      if (!payload.isRunning || turns.length === 0) return null;
      if (localRunningWithoutActive || providerSwitched) return null;
      const last = turns[turns.length - 1];
      const drv = last?.driver || payload.provider || null;
      if (drv && drv !== effDriver) return null;
      const direct = [lastTurnDecodeTps, last?.itemEstimateTps].find(rate => Number.isFinite(rate) && rate > 0 && rate <= 1500);
      if (direct != null) return Math.round(direct * 10) / 10;
      const out = Number(last?.usage?.outputTokens ?? last?.itemOutputTokens);
      if (!Number.isFinite(out) || out <= 0) return null;
      const sMs = last?.startedMs;
      const eMs = last?.completedMs ?? last?.lastItemMs ?? payload.sampledAtMs ?? Date.now();
      if (!Number.isFinite(sMs) || !Number.isFinite(eMs) || eMs <= sMs + 50) return null;
      const net = subtractWait(sMs, eMs, last?.id ?? last?.providerTurnId ?? null, drv || effDriver);
      if (!(net > 0.05)) return null;
      const raw = out / net;
      return Number.isFinite(raw) && raw > 0 && raw <= 1500 ? Math.round(raw * 10) / 10 : null;
    })();
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
      activeTurnIds: localActiveTurnIds,
      turnCount: turns.length,
      stepCount: pricedTurns,
      speed: {
        tokPerSec: tokPerSec != null ? Math.round(tokPerSec * 10) / 10 : null,
        byModel: byModelSpeed,
        lastDecodeTps: localRunningWithoutActive ? null : lastDecodeTps != null ? Math.round(lastDecodeTps * 10) / 10 : null,
        currentTurnEstimateTps: localEstimateTps,
        e2eTokPerSec: e2eTokPerSec != null ? Math.round(e2eTokPerSec * 10) / 10 : null,
        durationSec: localRunningWithoutActive ? null : lastDurationSec != null ? Math.round(lastDurationSec * 10) / 10 : null,
      },
      tokens: {
        input: promptTotal,
        uncached: uncachedOut,
        uncachedInput: uncachedOut,
        cached: sumCached,
        cachedInput: sumCached,
        cacheWrite: sumCacheWrite,
        cacheWriteInput: sumCacheWrite,
        output: outputOut,
        reasoning: sumReasoning,
        mainTotal: promptTotal + outputOut,
        subagentTokens: 0,
        total: promptTotal + outputOut,
        contextUsed: contextUsed ?? null,
        contextMax: contextMax ?? null,
        contextMaxSource,
      },
      cache: {
        cachedTokens: sumCached,
        mainCachedTokens: sumCached,
        withSubagentsCachedTokens: sumCached,
        cacheWriteTokens: sumCacheWrite,
        sessionRate: sessionCacheRate,
        mainSessionRate: sessionCacheRate,
        withSubagentsSessionRate: sessionCacheRate,
        turnRate: localRunningWithoutActive ? null : effectiveTurnCacheRate,
        lastTurnRate: localRunningWithoutActive ? null : effectiveTurnCacheRate,
        lastCallRate: null,
        displayRate: effectiveTurnCacheRate ?? sessionCacheRate,
        savedUsd: totalSavedUsd,
      },
      cost: {
        sessionUsd: totalUsd,
        subagentUsd: 0,
        withSubagentsUsd: totalUsd,
        subagentCount: Math.max(0, Number(payload.subagentCount) || 0),
        estimated,
      },
    };
  }

  // Distinct, clean Git swimlane colors that work well on both stock Light (#fff) and stock Dark (#000/#141414)
  const LANE_COLORS = ["var(--hud-fg)", "var(--hud-muted)", "#8e8e8e", "#b5b5b5", "#999999", "#666666"];

  function laneColor(lane) {
    return LANE_COLORS[Math.abs(lane) % LANE_COLORS.length];
  }

  const GIT_GRAPH_ICON = `<svg class="t3-git-symbol" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" aria-hidden="true"><circle cx="3.5" cy="4" r="1.7"/><circle cx="3.5" cy="12" r="1.7"/><path d="M3.5 5.7V10.3M8 2.2V13.8"/><circle cx="12.5" cy="4.5" r="1.7"/><path d="M12.5 6.2C12.5 9.2 11.3 10.6 9.8 11.5"/></svg>`;
  const GIT_BRANCH_ICON = `<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="4" cy="12" r="2"/><circle cx="12" cy="4" r="2"/><path d="M4 2V10M4 10C4 4 10 8 10 4"/></svg>`;
  const REFRESH_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 7V3M20 7H16M4 17V21M4 17H8M5.5 8A7.5 7.5 0 0 1 18 5.5L20 7M4 17L6 18.5A7.5 7.5 0 0 0 18.5 16"/></svg>`;
  const CLOSE_ICON = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M4 4L12 12M12 4L4 12"/></svg>`;

  // Unified RPC caller: supports live hot-swap override RPC, Electron IPC preload bridge, and loopback HTTP
  async function callBackend(method, ...args) {
    const RPC_TIMEOUT_MS = 8000;
    const READ_ONLY_HUB_ACTIONS = new Set([
      "hub:getContext", "slash:list", "skills:list",
      "agentsMd:get", "mcp:list", "mcp:matrix", "plugins:list", "plugins:catalog",
      "hooks:list", "memory:overview", "memory:list", "memory:search",
      "memory:worktreeInfo", "memory:health", "memory:stats", "memory:vectorStats",
      "memory:dream:get", "memory:runtimeHints:get", "embed:status", "subagents:list", "subagents:resolveRoute",
      "subagents:resolve", "subagents:orchestration:get", "subagents:slashPrompt",
      "board:get", "board:readArtifact", "settings:get", "settings:getRule", "quota:external",
    ]);
    const isHubTunnel = method === "getGitGraph" && args[0] === "__HUB_RPC__";
    const hubAction = isHubTunnel ? String(args[1] || "") : "";
    const isMutatingBackendMethod = /^(?:set|save|update|delete|clear|write|reset|toggle)[A-Z]/.test(String(method || ""));
    const useReadDeadline = isHubTunnel
      ? (
        READ_ONLY_HUB_ACTIONS.has(hubAction) ||
        /^(?:[^:]+:)+(?:get|read|list|search|status|context|resolve|check|overview|health|stats|vectorStats|worktreeInfo|catalog|matrix|slashPrompt)(?:[A-Z:]|$)/.test(hubAction)
      )
      : !isMutatingBackendMethod;
    const scheduleBackendTimer = typeof setTimeout === "function" ? setTimeout : null;
    const cancelBackendTimer = typeof clearTimeout === "function" ? clearTimeout : null;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    let timer;
    const transport = async () => {
      const post = async (cfg) => {
        const res = await fetch(`${cfg.url}/rpc`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-T3-Hud-Token": cfg.token },
          body: JSON.stringify({ method, args }),
          ...(controller ? { signal: controller.signal } : {}),
        });
        return res.json();
      };
      const overrideCfg = window.__t3HudOverrideRpc;
      if (overrideCfg?.url && overrideCfg.token) {
        try { return await post(overrideCfg); }
        catch (error) { if (controller?.signal?.aborted) throw error; }
      }
      if (typeof window.__t3HudBridge?.[method] === "function") return window.__t3HudBridge[method](...args);
      const httpCfg = window.__t3HudHttpConfig;
      if (httpCfg?.url && httpCfg.token) return post(httpCfg);
      return { ok: false, error: "HUD bridge unavailable" };
    };
    if (!useReadDeadline || !scheduleBackendTimer) return transport();
    try {
      return await Promise.race([
        transport(),
        new Promise((_, reject) => {
          timer = scheduleBackendTimer(() => {
            reject(new Error(`HUD RPC timed out: ${method}`));
            controller?.abort();
          }, RPC_TIMEOUT_MS);
        }),
      ]);
    } finally { if (timer !== undefined && cancelBackendTimer) cancelBackendTimer(timer); }
  }

  // Keep Sidecar Hub on the same authenticated transport as the resident HUD.
  const callRpc = (method, ...args) => callBackend(method, ...args);
  window.__t3HubRpc = async (action, payload) => {
    // Keep this dispatcher self-contained for standalone sidecar/VM extraction.
    const HUB_RPC_TIMEOUT_MS = 8000;
    const HUB_READ_ONLY_ACTIONS = new Set([
      "hub:getContext", "slash:list", "skills:list",
      "agentsMd:get", "mcp:list", "mcp:matrix", "plugins:list", "plugins:catalog",
      "hooks:list", "memory:overview", "memory:list", "memory:search",
      "memory:worktreeInfo", "memory:health", "memory:stats", "memory:vectorStats",
      "memory:dream:get", "memory:runtimeHints:get", "embed:status", "subagents:list", "subagents:resolveRoute",
      "subagents:resolve", "subagents:orchestration:get", "subagents:slashPrompt",
      "board:get", "board:readArtifact", "settings:get", "settings:getRule", "quota:external",
    ]);
    const bridge = window.__t3HubSidecarBridge;
    const normalizedPayload = payload || {};
    if (action === "hub:update:apply") {
      // A lost response can follow a successful update. Never resend through another transport.
      const config = window.__t3HudHttpConfig;
      if (typeof config?.url !== "string" || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(config.url) ||
          typeof config.token !== "string" || !config.token) {
        return { ok: false, code: "HUD_UNAVAILABLE" };
      }
      const response = await fetch(config.url + "/rpc", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-T3-Hud-Token": config.token },
        body: JSON.stringify({ method: "hubCall", args: [action, normalizedPayload] }),
        redirect: "error",
      });
      if (!response.ok) throw new Error("HUD update response unavailable");
      return response.json();
    }
    const scheduleTimer = typeof setTimeout === "function" ? setTimeout : null;
    const cancelTimer = typeof clearTimeout === "function" ? clearTimeout : null;
    if (typeof action === "string" && action.startsWith("memory:dream:")) {
      const english = typeof hudLang !== "undefined" && hudLang === "en";
      const unknownRun = (detail) => ({
        ok: false,
        status: "unknown",
        error: english
          ? `Dream run result is not yet known. Check the latest record before deciding whether to retry. (${detail})`
          : `整理结果暂无法确认，请先查看最近记录，再决定是否重试。(${detail})`,
      });
      const safeErrorKind = (error) => {
        const value = String(error?.code || error?.name || "NetworkError");
        return /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(value) ? value : "NetworkError";
      };
      if (!bridge || !bridge.url || !bridge.token) {
        return {
          ok: false,
          status: "unavailable",
          error: english ? "Dream service is not connected. Try again later." : "梦境服务未连接，请稍后重试。",
        };
      }
      let response;
      let sidecarResult;
      let jsonReadFailed = false;
      const isDreamRead = action === "memory:dream:get" && Boolean(scheduleTimer);
      const dreamController = isDreamRead && typeof AbortController === "function" ? new AbortController() : null;
      let dreamTimer;
      let dreamTimedOut = false;
      try {
        const doDreamFetchAndParse = async () => {
          response = await fetch(bridge.url + "/hub-rpc", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-T3-Hud-Token": bridge.token },
            body: JSON.stringify({ action, payload: normalizedPayload }),
            ...(dreamController ? { signal: dreamController.signal } : {}),
          });
          try {
            sidecarResult = await response.json();
          } catch (parseErr) {
            if (dreamTimedOut || dreamController?.signal?.aborted) throw parseErr;
            jsonReadFailed = true;
          }
        };
        if (isDreamRead) {
          await Promise.race([
            doDreamFetchAndParse(),
            new Promise((_, reject) => {
              dreamTimer = scheduleTimer(() => {
                dreamTimedOut = true;
                const timeoutErr = new Error("HUD RPC timed out: memory:dream:get");
                timeoutErr.code = "TimeoutError";
                reject(timeoutErr);
                dreamController?.abort();
              }, HUB_RPC_TIMEOUT_MS);
            }),
          ]);
        } else {
          await doDreamFetchAndParse();
        }
      } catch (error) {
        const detail = safeErrorKind(error);
        return action === "memory:dream:run"
          ? unknownRun(detail)
          : {
              ok: false,
              status: "unavailable",
              error: english ? `Dream service connection failed (${detail}).` : `梦境服务连接失败（${detail}）。`,
            };
      } finally {
        if (dreamTimer !== undefined && cancelTimer) cancelTimer(dreamTimer);
      }
      if (jsonReadFailed) {
        const detail = `HTTP ${Number(response?.status) || 0}, invalid JSON`;
        return action === "memory:dream:run"
          ? unknownRun(detail)
          : {
              ok: false,
              status: "invalid_response",
              error: english ? `Dream service returned an unreadable response (${detail}).` : `梦境服务返回了无法读取的响应（${detail}）。`,
            };
      }
      if (!sidecarResult || typeof sidecarResult !== "object" || Array.isArray(sidecarResult)) {
        const detail = `HTTP ${Number(response?.status) || 0}, invalid response`;
        return action === "memory:dream:run"
          ? unknownRun(detail)
          : {
              ok: false,
              status: "invalid_response",
              error: english ? `Dream service returned an unreadable response (${detail}).` : `梦境服务返回了无法读取的响应（${detail}）。`,
            };
      }
      if (!response.ok) {
        const detail = `HTTP ${Number(response?.status) || 0}`;
        return action === "memory:dream:run"
          ? unknownRun(detail)
          : {
              ok: false,
              status: "sidecar_error",
              error: english ? `Dream service request failed (${detail}).` : `梦境服务请求失败（${detail}）。`,
            };
      }
      return sidecarResult;
    }
    const actionStr = String(action || "");
    const isReadOnlyHub = Boolean(scheduleTimer) && (
      HUB_READ_ONLY_ACTIONS.has(actionStr) ||
      /^(?:[^:]+:)+(?:get|read|list|search|status|context|resolve|check|overview|health|stats|vectorStats|worktreeInfo|catalog|matrix|slashPrompt)(?:[A-Z:]|$)/.test(actionStr)
    );
    const monoNow = () => {
      const ms = typeof performance === "object" && performance !== null && typeof performance.now === "function"
        ? performance.now() : NaN;
      return Number.isFinite(ms) ? ms : Date.now();
    };
    const hubRpcStartedAt = monoNow();
    const hubRpcWallStartedAt = Date.now();
    const res = await callRpc("getGitGraph", "__HUB_RPC__", action, payload || {});
    if (res && (res.ok || !/Git|Unknown method|unknown action:/i.test(String(res.error || "")))) return res;
    if (bridge && bridge.url && bridge.token) {
      const monoElapsed = monoNow() - hubRpcStartedAt;
      const wallElapsed = Date.now() - hubRpcWallStartedAt;
      const remainingMs = HUB_RPC_TIMEOUT_MS - Math.max(0,
        Number.isFinite(monoElapsed) ? monoElapsed : 0,
        Number.isFinite(wallElapsed) ? wallElapsed : 0);
      if (isReadOnlyHub && remainingMs <= 0) {
        throw new Error(`HUD RPC timed out: ${actionStr}`);
      }
      const fbController = isReadOnlyHub && typeof AbortController === "function" ? new AbortController() : null;
      let fbTimer;
      let fbTimedOut = false;
      try {
        const doFallback = async () => {
          const r = await fetch(bridge.url + "/hub-rpc", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-T3-Hud-Token": bridge.token },
            body: JSON.stringify({ action, payload: normalizedPayload }),
            ...(fbController ? { signal: fbController.signal } : {}),
          });
          return r.ok ? await r.json() : null;
        };
        const parsed = isReadOnlyHub
          ? await Promise.race([
              doFallback(),
              new Promise((_, reject) => {
                fbTimer = scheduleTimer(() => {
                  fbTimedOut = true;
                  reject(new Error(`HUD RPC timed out: ${actionStr}`));
                  fbController?.abort();
                }, remainingMs);
              }),
            ])
          : await doFallback();
        if (parsed) return parsed;
      } catch (fbErr) {
        if (fbTimedOut) throw fbErr;
      } finally {
        if (fbTimer !== undefined && cancelTimer) cancelTimer(fbTimer);
      }
    }
    return res;
  };

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
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // ============================================================================
  // Bilingual i18n (zh / en) with auto-detection
  // ============================================================================
  const I18N = {
    zh: {
      cache: "本轮缓存",
      sub: "子",
      weekLeft: "周余",
      graph: "图谱",
      newSession: "新会话",
      waitingForOutput: "等待输出...",
      contextCapacity: "上下文容量",
      contextMaxLabel: "模型/上报容量",
      contextMaxSourceLabel: "容量来源",
      contextSourceReported: "T3 / ACP 上报",
      contextSourceLocalCatalog: "本地模型目录",
      contextSourceEstimated: "模型族估算",
      contextSourceUnknown: "未知",
      avgCacheHitRate: "含子代理累计缓存命中率",
      agyNote: "自动压缩阈值：未知（HUD 未取得可靠上报）",
      newSessionTitle: "新会话 / 待发消息",
      newSessionDesc: "发送首条消息后将实时显示该会话的速度、累计缓存命中率、会话 Token 与等效费用。",
      currentEngineQuota: "当前引擎额度剩余",
      resetIn: "重置倒计时",
      otherEngineQuota: "其他引擎额度速览",
      hudStatsDetails: "HUD 统计详情",
      hudVersion: "HUD 版本",
      hudUpdateCheck: "检查更新",
      hudUpdateChecking: "正在检查更新…",
      hudUpdateCurrent: "已是最新版本",
      hudUpdateAvailable: "有可用更新",
      hudUpdateApply: "更新至 {version}",
      hudUpdateApplying: "正在安装更新…",
      hudUpdateDone: "已更新至 {version}",
      hudUpdateInterrupted: "上次更新中断。",
      hudUpdateRecover: "恢复上次更新",
      hudUpdateRecovering: "正在恢复更新…",
      hudUpdateRecovered: "已恢复上次更新。",
      hudUpdateUnsupported: "此版本暂无可用热更新包。",
      hudUpdateReleases: "查看发布页",
      hudUpdateCheckFailed: "无法检查更新，请稍后再试。",
      hudUpdateConnectionFailed: "无法连接更新服务，请稍后再试。",
      hudUpdateFailed: "更新失败，请重新检查后再试。",
      hudUpdateUnconfirmed: "更新结果暂未确认，请重新检查已安装版本。",
      hudUpdateBusy: "另一个更新正在进行，请稍后检查。",
      hudUpdateChanged: "可用版本已变更，请重新检查更新。",
      hudUpdateInvalid: "更新包未通过验证，请重新检查更新。",
      hudUpdateUnavailable: "暂时无法更新 HUD，请稍后重试。",
      remaining: "剩余",
      engineModel: "引擎 / 模型",
      streamSpeed: "流式估算速度",
      approxSpeedPrefix: "≈",
      turnSpeedPrefix: "本轮",
      avgSpeed: "均速",
      avgDecodeSpeed: "会话均速",
      lastTurnSpeed: "末轮速度",
      e2eSpeed: "端到端速度 (含首字预填充)",
      turnCacheRate: "本轮缓存命中率",
      cacheSessionShort: "累计缓存",
      cacheSessionTitle: "本轮缓存用量暂缺；当前显示本会话累计命中率",
      cacheUnknownTitle: "暂无缓存数据",
      turnCacheUnavailableNote: "本轮缓存数据暂不可用；顶部显示会话累计命中率（如有）",
      lastCallCacheRate: "最近模型调用（原生记录）",
      mainSessionCacheRate: "主会话累计",
      inclusiveSessionCacheRate: "含子代理累计",
      cacheSaved: "缓存节省费用",
      contextRatio: "模型/上报容量占比",
      totalTokensWithSub: "本会话总 Token (含子智能体)",
      mainSubPrefix: "↳ 主会话 / 子智能体",
      inpCacheRead: "↳ 输入 / 缓存读取",
      outReasoning: "↳ 输出 / 思考推理",
      mainSessionCost: "主会话等效费用",
      subagents: "子智能体",
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
      cache: "Turn Cache",
      sub: "sub",
      weekLeft: "Wk",
      graph: "Graph",
      newSession: "New",
      waitingForOutput: "Waiting for output...",
      contextCapacity: "Context Capacity",
      contextMaxLabel: "Model / reported capacity",
      contextMaxSourceLabel: "Source",
      contextSourceReported: "T3 / ACP reported",
      contextSourceLocalCatalog: "Local model catalog",
      contextSourceEstimated: "Model-family estimate",
      contextSourceUnknown: "Unknown",
      avgCacheHitRate: "Cumulative cache hit rate (incl. subagents)",
      agyNote: "Auto-compaction threshold: unknown (no reliable HUD report)",
      newSessionTitle: "New session / awaiting message",
      newSessionDesc: "After the first message, speed, cache hit rate, session tokens and cost will show live.",
      currentEngineQuota: "Current engine quota",
      resetIn: "Resets in",
      otherEngineQuota: "Other engines at a glance",
      hudStatsDetails: "HUD statistics details",
      hudVersion: "HUD version",
      hudUpdateCheck: "Check for updates",
      hudUpdateChecking: "Checking for updates…",
      hudUpdateCurrent: "Up to date",
      hudUpdateAvailable: "Update available",
      hudUpdateApply: "Update to {version}",
      hudUpdateApplying: "Installing update…",
      hudUpdateDone: "Updated to {version}",
      hudUpdateInterrupted: "The previous update was interrupted.",
      hudUpdateRecover: "Recover interrupted update",
      hudUpdateRecovering: "Recovering update…",
      hudUpdateRecovered: "The interrupted update was recovered.",
      hudUpdateUnsupported: "This release has no compatible update package.",
      hudUpdateReleases: "View releases",
      hudUpdateCheckFailed: "Could not check for updates. Try again later.",
      hudUpdateConnectionFailed: "Could not reach the update service. Try again later.",
      hudUpdateFailed: "Update failed. Check for updates again before retrying.",
      hudUpdateUnconfirmed: "Update result unconfirmed. Check the installed version again.",
      hudUpdateBusy: "Another update is in progress. Check again shortly.",
      hudUpdateChanged: "The available version changed. Check for updates again.",
      hudUpdateInvalid: "The update package could not be verified. Check for updates again.",
      hudUpdateUnavailable: "HUD updates are currently unavailable. Try again later.",
      remaining: "Left",
      engineModel: "Engine / Model",
      streamSpeed: "Estimated live speed",
      approxSpeedPrefix: "≈",
      turnSpeedPrefix: "Turn",
      avgSpeed: "Avg",
      avgDecodeSpeed: "Avg Decode Speed",
      lastTurnSpeed: "Last Turn Speed",
      e2eSpeed: "End-to-end (incl. prefill)",
      turnCacheRate: "This-turn cache hit rate",
      cacheSessionShort: "Session cache",
      cacheSessionTitle: "Current-turn cache usage is unavailable; showing this chat's cumulative rate",
      cacheUnknownTitle: "No cache data",
      turnCacheUnavailableNote: "Current-turn cache data is unavailable; the top bar shows the cumulative rate when available",
      lastCallCacheRate: "Latest model call (native record)",
      mainSessionCacheRate: "Main session total",
      inclusiveSessionCacheRate: "Total incl. subagents",
      cacheSaved: "Saved via cache",
      contextRatio: "Model / reported capacity usage",
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
      padding-top: var(--t3-hud-composer-space, 29px) !important;
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
      --hud-surface: var(--muted, #5d5d5d);
      --hud-border: var(--border, rgba(0, 0, 0, 0.1));
      --hud-hover: color-mix(in srgb, var(--foreground, #262626) 7%, transparent);
      --hud-shadow: 0 8px 30px rgba(0, 0, 0, 0.12), 0 1px 3px rgba(0, 0, 0, 0.06);
      --hud-emerald: #5d5d5d;
      --hud-emerald-fill: var(--hud-fg);
      --hud-blue: #5d5d5d;
      --hud-blue-fill: var(--hud-fg);
      --hud-cyan: #5d5d5d;
      --hud-amber: #5d5d5d;
      --hud-amber-fill: var(--hud-fg);
      --hud-orange: #5d5d5d;
      --hud-orange-fill: var(--hud-fg);
      --hud-red: #5d5d5d;
      --hud-red-fill: var(--hud-fg);
      --hud-violet: #5d5d5d;
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
      --hud-emerald: #5d5d5d;
      --hud-blue: #5d5d5d;
      --hud-cyan: #5d5d5d;
      --hud-amber: #5d5d5d;
      --hud-orange: #5d5d5d;
      --hud-red: #5d5d5d;
      --hud-violet: #5d5d5d;
    }

    #t3-hud-topbar {
      box-sizing: border-box;
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
    #t3-hud-header-tools, #t3-hud-context-control {
      pointer-events: auto;
      -webkit-app-region: no-drag;
      position: fixed;
      z-index: 30;
      align-items: center;
    }
    #t3-hud-header-tools { display: flex; gap: 4px; height: 32px; }
    #t3-hud-header-tools.is-compact #t3-hud-branch { display: none; }
    #t3-hud-header-tools.is-quota-only #t3-hud-git-btn { display: none; }
    #t3-hud-header-tools.has-no-rings #t3-hud-quota-rings { display: none; }
    #t3-hud-context-control { display: inline-flex; justify-content: center; width: 22px; height: 28px; border: 0; padding: 0; background: transparent; color: var(--hud-fg); cursor: pointer; }
    #t3-hud-header-tools.is-hidden, #t3-hud-context-control.is-hidden { display: none !important; }
    #t3-hud-quota-rings { display: inline-flex; align-items: center; gap: 4px; }
    #t3-hud-quota-rings:empty { display: none; }
    .t3-hud-quota-ring { position: relative; display: inline-flex; flex: 0 0 32px; align-items: center; justify-content: center; width: 32px; height: 32px; border: 0; padding: 0; color: var(--hud-fg); background: transparent; cursor: pointer; border-radius: 50%; }
    .t3-hud-quota-ring:hover, .t3-hud-quota-ring:focus-visible, #t3-hud-context-control:hover, #t3-hud-context-control:focus-visible { background: var(--hud-hover); outline: 2px solid transparent; }
    .t3-hud-quota-ring > svg { width: 32px; height: 32px; transform: rotate(-90deg); }
    .t3-hud-provider-logo { position: absolute; display: inline-flex; align-items: center; justify-content: center; width: 12px; height: 12px; font-size: 9px; font-weight: 700; line-height: 1; }
    .t3-hud-provider-logo.is-dual { width: 15px; height: 15px; }
    .t3-hud-provider-logo svg { width: 100%; height: 100%; }
    .t3-hud-quota-ring .quota-arc { transition: stroke-dashoffset .25s ease; }
    .t3-qcard-hdr { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 12px; }
    .t3-qcard-title { font-size: 13px; font-weight: 650; color: var(--hud-fg); letter-spacing: -0.01em; }
    .t3-qcard-badge { flex: none; padding: 2px 8px; border-radius: 999px; background: color-mix(in srgb, var(--hud-fg) 7%, transparent); color: var(--hud-muted); font-size: 10.5px; font-weight: 500; }
    .t3-qcard-win { margin-bottom: 12px; }
    .t3-qcard-win:last-child { margin-bottom: 0; }
    .t3-qcard-row { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 6px; font-size: 12px; }
    .t3-qcard-lbl { color: var(--hud-fg); font-weight: 500; }
    .t3-qcard-pct { font-variant-numeric: tabular-nums; font-weight: 700; font-size: 12.5px; }
    .t3-qcard-pct.ok { color: #10a37f; }
    .t3-qcard-pct.mid { color: #d97706; }
    .t3-qcard-pct.err { color: #dc2626; }
    .t3-qcard-track { height: 5px; border-radius: 999px; background: color-mix(in srgb, var(--hud-fg) 10%, transparent); overflow: hidden; }
    .t3-qcard-fill { height: 100%; border-radius: 999px; transition: width .22s ease; }
    .t3-qcard-fill.ok { background: #10a37f; }
    .t3-qcard-fill.mid { background: #d97706; }
    .t3-qcard-fill.err { background: #dc2626; }
    .t3-qcard-meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 6px; font-size: 11px; color: var(--hud-muted); font-variant-numeric: tabular-nums; }
    #t3-hud-topbar.is-hidden {
      display: none !important;
    }

    .t3-hud-metric {
      display: inline-flex;
      flex: none;
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
    .t3-hud-metric[data-hud-stats-trigger] {
      border: 0;
      background: transparent;
      font: inherit;
      cursor: pointer;
    }
    .t3-hud-metric[data-hud-stats-trigger]:focus-visible,
    .t3-hud-update-button:focus-visible,
    .t3-hud-update-release:focus-visible {
      outline: 2px solid var(--hud-fg);
      outline-offset: 1px;
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
      background: var(--hud-fg);
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--hud-fg) 16%, transparent);
      animation: t3HudPulse 1.2s ease-in-out infinite;
    }
    .t3-hud-dot.ready {
      background: var(--hud-fg);
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
      visibility: hidden;
      overflow-y: auto;
      transform: translateY(3px);
      transition: opacity 0.12s ease, transform 0.12s ease;
      z-index: 60;
    }
    #t3-hud-popover.visible {
      opacity: 1;
      visibility: visible;
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
    .t3-hud-version-actions, .t3-hud-update-info {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .t3-hud-version-actions { font-variant-numeric: tabular-nums; }
    .t3-hud-update-info {
      justify-content: space-between;
      color: var(--hud-muted);
      font-size: 10.5px;
    }
    .t3-hud-update-info > :not(:empty):not([hidden]) { margin-top: 3px; }
    .t3-hud-update-release {
      color: var(--hud-fg);
      text-decoration: underline;
      text-underline-offset: 2px;
      white-space: nowrap;
    }
    .t3-hud-update-button[aria-disabled="true"] { cursor: default; opacity: 0.6; }
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
    .t3-lang-switch, .t3-hud-update-button {
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
    .t3-lang-switch:hover, .t3-hud-update-button:not([aria-disabled="true"]):hover {
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
      border-color: #5d5d5d;
    }
    #t3-hud-git-drawer button:focus-visible,
    .t3-git-row:focus-visible {
      outline: 2px solid #5d5d5d;
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
      background: rgba(0, 0, 0, 0.04);
      border-color: rgba(0, 0, 0, 0.12);
      color: #5d5d5d;
      font-weight: 600;
    }
    html.dark .t3-git-ref.head {
      color: #5d5d5d;
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
    .t3-diff-add { color: #5d5d5d; }
    .t3-diff-del { color: #5d5d5d; }
    html.dark .t3-diff-add { color: #5d5d5d; }
    html.dark .t3-diff-del { color: #5d5d5d; }
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
    .t3-patch-hunk { color: #5d5d5d; }
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
    /* OpenAI monochrome chrome. Quota is the sole semantic-color exception. */
    #t3-hud-root{--hud-bg:#fff;--hud-bg-solid:#fff;--hud-fg:#0d0d0d;--hud-muted:#5d5d5d;--hud-surface:#f7f7f8;--hud-border:#ececec;--hud-hover:rgba(0,0,0,.04);--hud-emerald:var(--hud-fg);--hud-blue:var(--hud-fg);--hud-cyan:var(--hud-fg);--hud-amber:var(--hud-muted);--hud-orange:var(--hud-fg);--hud-red:var(--hud-fg);--hud-violet:var(--hud-fg);--hud-emerald-fill:var(--hud-fg);--hud-blue-fill:var(--hud-fg);--hud-amber-fill:var(--hud-fg);--hud-orange-fill:var(--hud-fg);--hud-red-fill:var(--hud-fg)}
    .t3-hud-composer-spaced{padding-top:var(--t3-hud-composer-space,29px)!important}
    #t3-hud-topbar{height:27px;padding:0 7px;border-radius:8px;background:var(--hud-bg-solid);backdrop-filter:none;-webkit-backdrop-filter:none;box-shadow:0 1px 3px #00000005;font-size:10px}
    #t3-hud-git-btn{font-size:10px}.t3-hud-sub-badge{background:var(--hud-surface);color:var(--hud-muted)}#t3-hud-git-btn.active{background:var(--hud-fg);color:var(--hud-bg-solid)}#t3-hud-git-btn.active .t3-git-symbol{color:inherit}
    #t3-hud-root .t3-quota-fill,#t3-hud-root #t3-hud-quota-bar{background:#10a37f}#t3-hud-root .t3-quota-val,#t3-hud-root #t3-hud-quota{color:#10a37f}
    #t3-hud-root .t3-quota-fill.mid,#t3-hud-root .t3-quota-fill.warn,#t3-hud-root #t3-hud-quota-bar.mid,#t3-hud-root #t3-hud-quota-bar.warn{background:#d97706}#t3-hud-root .t3-quota-val.mid,#t3-hud-root .t3-quota-val.warn,#t3-hud-root #t3-hud-quota.mid,#t3-hud-root #t3-hud-quota.warn{color:#d97706}
    #t3-hud-root .t3-quota-fill.err,#t3-hud-root #t3-hud-quota-bar.err{background:#dc2626}#t3-hud-root .t3-quota-val.err,#t3-hud-root #t3-hud-quota.err{color:#dc2626}
    #t3-hud-root :is(.t3-diff-add,.t3-diff-del,.t3-patch-hunk){color:var(--hud-fg)}#t3-hud-root .t3-diff-add{font-weight:600}#t3-hud-root .t3-diff-del{opacity:.65}
    #t3-hud-topbar { width: max-content; max-width: none; }
    #t3-hud-topbar.is-tight .t3-hud-metric { padding: 0 3px; }
    #t3-hud-topbar.is-tight .t3-hud-sub-badge,
    #t3-hud-topbar.is-mini :is(.lbl, #t3-hud-speed-label) { display: none; }
    #t3-hud-topbar.is-mini { gap: 1px; padding: 0 4px; }
    #t3-hud-topbar.is-mini .t3-hud-metric { gap: 2px; padding: 0 2px; }
    #t3-hud-topbar.is-mini .t3-hud-sep { margin: 0; }
    #t3-hud-topbar .is-overflow-hidden, #t3-hud-quota-rings .is-overflow-hidden { display: none; }
    @media(max-width:639px){#t3-hud-popover{max-height:calc(100dvh - 120px);overflow:auto}}
    @media(prefers-reduced-motion:reduce){#t3-hud-root *,#t3-hud-root *:before,#t3-hud-root *:after{animation:none!important;transition:none!important}}

  `;
  document.head.appendChild(styleEl);

  const root = document.createElement("div");
  root.id = "t3-hud-root";
  // Circumference for r=5.2 circle: 2 * pi * 5.2 = 32.67
  const RING_CIRC = 32.67;

  root.innerHTML = `
    <div id="t3-hud-topbar" class="is-hidden">
      <button class="t3-hud-metric" data-hud-hover="stats" data-hud-stats-trigger type="button" aria-controls="t3-hud-popover" title="${escapeHtml(t("hudStatsDetails"))}">
        <span id="t3-hud-dot" class="t3-hud-dot"></span>
        <span class="val"><span id="t3-hud-speed-label"></span><span id="t3-hud-speed">-- tok/s</span></span>
      </button>
      <span class="t3-hud-sep"></span>
      <div id="t3-hud-cache-item" class="t3-hud-metric" data-hud-metric="cache" data-hud-hover="stats">
        <span class="lbl" id="t3-hud-cache-lbl">本轮缓存</span>
        <span id="t3-hud-cache" class="val">--%</span>
      </div>
      <span class="t3-hud-sep"></span>
      <div class="t3-hud-metric" data-hud-metric="tokens" data-hud-hover="stats">
        <span id="t3-hud-tokens" class="val">0 tok</span>
      </div>
      <span class="t3-hud-sep"></span>
      <div class="t3-hud-metric" data-hud-metric="cost" data-hud-hover="stats">
        <span id="t3-hud-cost" class="val">$0.00</span>
      </div>
    </div>
    <div id="t3-hud-header-tools" class="is-hidden" data-t3-hud-header-tools>
      <button id="t3-hud-git-btn" type="button" title="打开/关闭 Git 图谱悬浮窗 (Option+G)" aria-controls="t3-hud-git-drawer" aria-expanded="false">
        ${GIT_GRAPH_ICON}
        <span id="t3-hud-branch" class="t3-hud-branch-text">Git 图谱</span>
        <span id="t3-hud-dirty" class="t3-hud-dirty-dot" style="display:none"></span>
      </button>
      <span id="t3-hud-quota-rings"></span>
    </div>
    <button id="t3-hud-context-control" class="is-hidden" type="button" data-hud-hover="context" aria-label="上下文容量：未知">
      <svg class="t3-hud-ring-svg" viewBox="0 0 14 14" aria-hidden="true">
        <circle cx="7" cy="7" r="5.2" fill="none" stroke="color-mix(in srgb, var(--hud-fg) 16%, transparent)" stroke-width="2.1" />
        <circle id="t3-hud-ring-arc" cx="7" cy="7" r="5.2" fill="none" stroke="var(--hud-fg)" stroke-width="2.1" stroke-linecap="round" stroke-dasharray="${RING_CIRC}" stroke-dashoffset="${RING_CIRC}" />
      </svg>
    </button>

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

  const hudThemes = {
    white: ["#ffffff", "#f8fafc", "#e2e8f0", "#0f172a", "#475569", "#2563eb"],
    dark: ["#14161a", "#1e2128", "#2e333d", "#f8fafc", "#94a3b8", "#60a5fa"],
    sky: ["#f4f9ff", "#eaf3ff", "#bfdbfe", "#0c4a6e", "#0369a1", "#0284c7"],
    emerald: ["#f2fdf7", "#e6faef", "#a7f3d0", "#064e3b", "#047857", "#059669"],
    violet: ["#faf7ff", "#f3e8ff", "#ddd6fe", "#3b0764", "#6d28d9", "#7c3aed"],
  };
  function syncHudTheme(event) {
    let theme = event?.detail?.theme;
    if (!theme) { try { theme = localStorage.getItem("t3-hub-theme"); } catch {} }
    if (!Object.hasOwn(hudThemes, theme)) theme = "white";
    const [bg, surface, border, ink, muted, accent] = hudThemes[theme];
    const variables = { "hud-bg": bg, "hud-bg-solid": bg, "hud-surface": surface, "hud-border": border, "hud-fg": ink, "hud-muted": muted, "hud-accent": accent,
      "hud-hover": theme === "dark" ? "#ffffff0f" : "#0f172a08", "hud-shadow": theme === "dark" ? "0 14px 40px #00000066" : "0 8px 30px #0f172a14,0 1px 3px #0f172a08" };
    for (const [key, value] of Object.entries(variables)) root.style.setProperty(`--${key}`, value);
    for (const color of ["emerald", "blue", "cyan", "violet"]) root.style.setProperty(`--hud-${color}`, accent);
    root.dataset.theme = theme;
    root.style.colorScheme = theme === "dark" ? "dark" : "light";
  }
  syncHudTheme();
  window.addEventListener("t3-hub-theme-change", syncHudTheme);
  window.addEventListener("t3-hud-update-state", onExternalHudUpdateState);
  window.addEventListener("storage", syncHudTheme);
  document.querySelectorAll(".t3-hud-details-section").forEach((el) => el.remove());

  const topbar = document.getElementById("t3-hud-topbar");
  const dotEl = document.getElementById("t3-hud-dot");
  const speedEl = document.getElementById("t3-hud-speed");
  const speedLabelEl = document.getElementById("t3-hud-speed-label");
  const cacheEl = document.getElementById("t3-hud-cache");
  const cacheLblEl = document.getElementById("t3-hud-cache-lbl");
  const tokensEl = document.getElementById("t3-hud-tokens");
  const costEl = document.getElementById("t3-hud-cost");
  const headerTools = document.getElementById("t3-hud-header-tools");
  const quotaRings = document.getElementById("t3-hud-quota-rings");
  const contextControl = document.getElementById("t3-hud-context-control");
  const ringArcEl = document.getElementById("t3-hud-ring-arc");
  const branchBtnText = document.getElementById("t3-hud-branch");
  const dirtyBadge = document.getElementById("t3-hud-dirty");
  const gitBtn = document.getElementById("t3-hud-git-btn");
  const popover = document.getElementById("t3-hud-popover");
  const statsTrigger = root.querySelector("[data-hud-stats-trigger]");
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

  let currentPathHint = getRouteHint();
  let latestStats = null;
  let lastRemotePayload = null;
  let liveStreamTps = null;
  let turnSpeedState = createHudTurnSpeedState(currentPathHint);
  let sessionSpeedState = createHudSessionSpeedState();
  let latestGraph = null;
  let drawerOpen = false;
  let selectedCommitHash = null;
  let selectedCommitDetail = null;
  let lastLoadedGraphThreadId = null;
  let customDrawerPos = null;
  let spacedComposerStack = null;
  let currentPopoverMode = "stats";
  let currentPopoverProvider = null;
  let popoverHideTimer = null;
  let hudUpdateState = {};
  let externalQuotaProviders = [];
  let hudLocalQuotaEnvironmentId = "";
  let externalQuotaFetchedAt = 0;
  let externalQuotaInFlight = null;
  let externalQuotaNeedsRecheck = false;
  let externalQuotaPendingTimer = null;
  let externalQuotaPendingRetries = 0;
  let lastExternalQuotaEnvId = "";
  let lastLocalHasNativeAgy = false;
  let externalQuotaSkippedLocalAgy = false;
  const remoteExternalQuotaByEnv = new Map();
  const remoteExternalQuotaInFlight = new Set();
  const remoteExternalQuotaLastFetchAt = new Map();
  const REMOTE_EXTERNAL_QUOTA_POLL_MS = 60_000;
  const EXTERNAL_QUOTA_PENDING_MAX_RETRIES = 3;
  const EXTERNAL_QUOTA_PENDING_DELAY_MS = 6_000;
  function clearExternalQuotaPendingTimer() {
    if (externalQuotaPendingTimer) {
      if (typeof clearTimeout === "function") clearTimeout(externalQuotaPendingTimer);
      externalQuotaPendingTimer = null;
    }
  }
  function isConfirmedLocalQuotaEnv(envId) {
    return (
      typeof envId === "string" &&
      envId.length > 0 &&
      typeof hudLocalQuotaEnvironmentId === "string" &&
      hudLocalQuotaEnvironmentId.length > 0 &&
      envId.toLowerCase() === hudLocalQuotaEnvironmentId.toLowerCase()
    );
  }
  function parseRemoteQuotaMirror(contents, expectedEnvironmentId, now = Date.now()) {
    if (typeof contents !== "string" || !contents.trim() || contents.length > 65536) return [];
    if (typeof expectedEnvironmentId !== "string" || !expectedEnvironmentId.trim()) return [];
    let data;
    try { data = JSON.parse(contents); } catch { return []; }
    if (!data || typeof data !== "object" || Array.isArray(data)) return [];
    if (data.schemaVersion !== 1 || data.source !== "hub-quota-mirror") return [];
    if (typeof data.environmentId !== "string" || !data.environmentId.trim()) return [];
    if (data.environmentId.toLowerCase() !== expectedEnvironmentId.toLowerCase()) return [];
    const ttlMs = typeof HUD_QUOTA_SNAPSHOT_TTL_MS === "number" ? HUD_QUOTA_SNAPSHOT_TTL_MS : 30 * 60_000;
    const maxFutureSkewMs = 5 * 60_000;
    const parseTs = (value) => {
      if (typeof value === "number") return Number.isFinite(value) ? value : null;
      if (typeof value === "string" && value.trim()) {
        const ms = Date.parse(value);
        return Number.isFinite(ms) ? ms : null;
      }
      return null;
    };
    const updatedMs = parseTs(data.updatedAt);
    if (updatedMs == null || updatedMs > now + maxFutureSkewMs || now - updatedMs >= ttlMs) return [];
    if (!Array.isArray(data.providers) || !data.providers.length) return [];
    const providers = [];
    for (const rawProvider of data.providers.slice(0, 8)) {
      if (!rawProvider || typeof rawProvider !== "object" || Array.isArray(rawProvider)) continue;
      const driver = typeof rawProvider.driver === "string" ? rawProvider.driver.trim().toLowerCase() : "";
      if (driver !== "antigravity") continue;
      const rawLimits = rawProvider.usageLimits;
      if (!rawLimits || typeof rawLimits !== "object" || Array.isArray(rawLimits) || !Array.isArray(rawLimits.windows) || !rawLimits.windows.length) continue;
      const rawCheckedAt = rawLimits.checkedAt !== undefined ? rawLimits.checkedAt : rawProvider.checkedAt;
      let checkedMs = null;
      if (rawCheckedAt != null) {
        checkedMs = parseTs(rawCheckedAt);
        if (checkedMs == null || checkedMs > now + maxFutureSkewMs || now - checkedMs >= ttlMs) continue;
      }
      const sanitizeText = (value, maxLen) => (
        typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maxLen) : ""
      );
      const windows = [];
      for (const rawWin of rawLimits.windows.slice(0, 16)) {
        if (!rawWin || typeof rawWin !== "object" || Array.isArray(rawWin)) continue;
        if (typeof rawWin.usedPercent !== "number" || !Number.isFinite(rawWin.usedPercent) || rawWin.usedPercent < 0 || rawWin.usedPercent > 100) continue;
        let resetsAt = null;
        if (typeof rawWin.resetsAt === "string" && rawWin.resetsAt.trim()) {
          const parsedReset = Date.parse(rawWin.resetsAt);
          if (Number.isFinite(parsedReset)) resetsAt = rawWin.resetsAt.trim().slice(0, 64);
        } else if (typeof rawWin.resetsAt === "number" && Number.isFinite(rawWin.resetsAt)) {
          resetsAt = new Date(rawWin.resetsAt).toISOString();
        }
        const windowDurationMins = (typeof rawWin.windowDurationMins === "number" && Number.isFinite(rawWin.windowDurationMins) && rawWin.windowDurationMins > 0 && rawWin.windowDurationMins <= 525600)
          ? rawWin.windowDurationMins
          : null;
        windows.push({
          id: sanitizeText(rawWin.id, 120),
          kind: sanitizeText(rawWin.kind, 64),
          label: sanitizeText(rawWin.label, 160),
          usedPercent: rawWin.usedPercent,
          resetsAt,
          windowDurationMins,
        });
      }
      if (!windows.length) continue;
      const instanceId = sanitizeText(rawProvider.instanceId, 120) ||
        sanitizeText(rawProvider.providerInstanceId, 120) ||
        "antigravity";
      const displayName = sanitizeText(rawProvider.displayName, 120) || "AGY";
      providers.push({
        instanceId,
        driver: "antigravity",
        displayName,
        usageLimits: {
          checkedAt: checkedMs ?? updatedMs,
          windows,
        },
      });
    }
    return providers;
  }
  function getValidRemoteExternalQuotas(environmentId, now = Date.now()) {
    const ttlMs = typeof HUD_QUOTA_SNAPSHOT_TTL_MS === "number" ? HUD_QUOTA_SNAPSHOT_TTL_MS : 30 * 60_000;
    for (const [envKey, entry] of remoteExternalQuotaByEnv) {
      if (!entry || !Number.isFinite(entry.observedAt) || now - entry.observedAt >= ttlMs) {
        remoteExternalQuotaByEnv.delete(envKey);
      }
    }
    const envId = typeof environmentId === "string" ? environmentId.trim() : "";
    const localEnvId = typeof hudLocalQuotaEnvironmentId === "string" ? hudLocalQuotaEnvironmentId.trim() : "";
    if (!envId || !localEnvId || envId.toLowerCase() === localEnvId.toLowerCase()) return [];
    const cached = remoteExternalQuotaByEnv.get(envId.toLowerCase());
    return Array.isArray(cached?.providers) ? cached.providers : [];
  }
  function refreshRemoteExternalQuotas(force = false) {
    if (disposed || document.hidden) return;
    const observation = readExternalQuotaObservation();
    const currentEnvId = typeof observation.environmentId === "string" ? observation.environmentId.trim() : "";
    const localEnvId = typeof hudLocalQuotaEnvironmentId === "string" ? hudLocalQuotaEnvironmentId.trim() : "";
    if (!currentEnvId || !localEnvId || currentEnvId.toLowerCase() === localEnvId.toLowerCase()) return;
    if (typeof window === "undefined" || typeof window.__t3HudRemoteRpc !== "function") return;
    const routeHint = typeof getRouteHint === "function" ? getRouteHint() : "";
    const threadId = typeof extractLastThreadIdFromHint === "function" ? extractLastThreadIdFromHint(routeHint) : "";
    if (!threadId || threadId === "__NEW__" || threadId.startsWith("__ROUTE_")) return;
    const remoteProject = typeof getHudRemoteProject === "function"
      ? getHudRemoteProject({ environmentId: currentEnvId, threadId })
      : null;
    const cwd = typeof remoteProject?.projectRoot === "string" ? remoteProject.projectRoot : "";
    if (!cwd) return;
    const envKey = currentEnvId.toLowerCase();
    if (remoteExternalQuotaInFlight.has(envKey)) return;
    const now = Date.now();
    const lastFetchAt = remoteExternalQuotaLastFetchAt.get(envKey) || 0;
    if (!force && now - lastFetchAt < REMOTE_EXTERNAL_QUOTA_POLL_MS) return;
    remoteExternalQuotaInFlight.add(envKey);
    remoteExternalQuotaLastFetchAt.set(envKey, now);
    window.__t3HudRemoteRpc(
      currentEnvId,
      "projects.readFile",
      { cwd, relativePath: ".t3-hub/quota/snapshot.json", allowMissing: true },
      4500
    )
      .then((res) => {
        if (disposed) return;
        const fetchedAt = Date.now();
        remoteExternalQuotaLastFetchAt.set(envKey, fetchedAt);
        if (!res?.ok) return;
        const fileValue = res.value ?? res.data ?? res;
        const contents = typeof fileValue?.contents === "string" ? fileValue.contents : "";
        const parsed = parseRemoteQuotaMirror(contents, currentEnvId, fetchedAt);
        if (parsed.length > 0) {
          const checkedTimes = parsed
            .map((p) => p?.usageLimits?.checkedAt)
            .filter((t) => typeof t === "number" && Number.isFinite(t));
          const observedAt = checkedTimes.length ? Math.min(fetchedAt, ...checkedTimes) : fetchedAt;
          remoteExternalQuotaByEnv.set(envKey, { providers: parsed, fetchedAt, observedAt });
        } else {
          remoteExternalQuotaByEnv.delete(envKey);
        }
        const currentObs = readExternalQuotaObservation();
        if (String(currentObs.environmentId || "").trim().toLowerCase() === envKey) {
          const quota = computeQuotaAndContext(latestStats);
          renderQuotaRing(quota.providerQuotas, quota.activeQuotaRingId);
          scheduleLayoutSync();
        }
      })
      .catch(() => {
        remoteExternalQuotaLastFetchAt.set(envKey, Date.now());
      })
      .finally(() => {
        remoteExternalQuotaInFlight.delete(envKey);
      });
  }
  function hasNativeAgyQuotaWindows(liveState = null) {
    try {
      const state = liveState || readLiveT3State();
      const envId = typeof state?.environmentId === "string" ? state.environmentId : "";
      if (!envId || (hudLocalQuotaEnvironmentId && !isConfirmedLocalQuotaEnv(envId))) return false;
      const live = state?.usage;
      const providers = Array.isArray(live?.providers) ? live.providers : [];
      const sources = hudUsageSources(live);
      const merged = mergeUsageLimitProviders(providers, sources);
      return merged.some(
        (p) => String(p?.driver || "").toLowerCase() === "antigravity" && Array.isArray(p?.usageLimits?.windows) && p.usageLimits.windows.length > 0
      );
    } catch {
      return false;
    }
  }
  function readExternalQuotaObservation() {
    const state = (() => { try { return readLiveT3State(); } catch { return null; } })();
    return {
      environmentId: typeof state?.environmentId === "string" ? state.environmentId : "",
      hasNativeAgy: Boolean(state) && hasNativeAgyQuotaWindows(state),
    };
  }
  function quotaObservationChanged(before, after) {
    return before.environmentId !== after.environmentId || before.hasNativeAgy !== after.hasNativeAgy;
  }
  function refreshExternalQuotas(force = false, fromPendingFollowUp = false, fromEnvironmentRecheck = false) {
    if (disposed || document.hidden) return;
    const observation = readExternalQuotaObservation();
    const { environmentId: currentEnvId, hasNativeAgy } = observation;
    const hasKnownLocalEnv = typeof hudLocalQuotaEnvironmentId === "string" && hudLocalQuotaEnvironmentId.length > 0;
    const isRemote = Boolean(currentEnvId && hasKnownLocalEnv && currentEnvId.toLowerCase() !== hudLocalQuotaEnvironmentId.toLowerCase());
    if (isRemote) {
      if (currentEnvId) lastExternalQuotaEnvId = currentEnvId;
      clearExternalQuotaPendingTimer();
      externalQuotaPendingRetries = 0;
      refreshRemoteExternalQuotas(force);
      return;
    }
    if (externalQuotaInFlight) {
      if (quotaObservationChanged(externalQuotaInFlight, observation)) externalQuotaNeedsRecheck = true;
      return;
    }
    const isLocal = isConfirmedLocalQuotaEnv(currentEnvId);
    const switchedBackToLocal = Boolean(isLocal && lastExternalQuotaEnvId && lastExternalQuotaEnvId.toLowerCase() !== currentEnvId.toLowerCase());
    const localNativeAgyChanged = isLocal && lastLocalHasNativeAgy !== hasNativeAgy;
    const needsInitialLocalAgy = isLocal && externalQuotaSkippedLocalAgy;
    if (currentEnvId) lastExternalQuotaEnvId = currentEnvId;

    const now = Date.now();
    const bypassThrottle = force || fromPendingFollowUp || fromEnvironmentRecheck || switchedBackToLocal || localNativeAgyChanged || needsInitialLocalAgy;
    if (!bypassThrottle && now - externalQuotaFetchedAt < 115_000) return;
    if (typeof window.__t3HubRpc !== "function") return;
    if (!fromPendingFollowUp) {
      externalQuotaPendingRetries = 0;
      clearExternalQuotaPendingTimer();
    }
    if (isLocal) lastLocalHasNativeAgy = hasNativeAgy;
    externalQuotaInFlight = observation;
    const rpcPayload = {};
    if (force) rpcPayload.force = true;
    if (currentEnvId) rpcPayload.environmentId = currentEnvId;
    if (!hasKnownLocalEnv && !currentEnvId) {
      rpcPayload.skipLocalAgy = true;
    }
    if (hasNativeAgy) {
      rpcPayload.observedEnvId = currentEnvId;
      rpcPayload.hasNativeAgyQuota = true;
    }
    const sentSkipLocalAgy = rpcPayload.skipLocalAgy === true;
    window.__t3HubRpc("quota:external", rpcPayload)
      .then((res) => {
        if (disposed) return;
        externalQuotaFetchedAt = Date.now();
        let activeIsRemote = false;
        if (res && res.ok && Array.isArray(res.providers)) {
          if (typeof res.t3EnvironmentId === "string") {
            if (hudLocalQuotaEnvironmentId && res.t3EnvironmentId.toLowerCase() !== hudLocalQuotaEnvironmentId.toLowerCase()) {
              externalQuotaProviders = externalQuotaProviders.filter(p => String(p?.driver || "").toLowerCase() !== "antigravity");
            }
            hudLocalQuotaEnvironmentId = res.t3EnvironmentId;
          }
          if (isConfirmedLocalQuotaEnv(currentEnvId)) lastLocalHasNativeAgy = hasNativeAgy;
          const isRemoteNow = Boolean(currentEnvId && hudLocalQuotaEnvironmentId && currentEnvId.toLowerCase() !== hudLocalQuotaEnvironmentId.toLowerCase());
          const latestEnvId = readExternalQuotaObservation().environmentId || currentEnvId;
          activeIsRemote = Boolean(latestEnvId && hudLocalQuotaEnvironmentId && latestEnvId.toLowerCase() !== hudLocalQuotaEnvironmentId.toLowerCase());
          const isAgy = p => String(p?.driver || "").toLowerCase() === "antigravity";
          if (sentSkipLocalAgy) {
            externalQuotaSkippedLocalAgy = true;
            if (isConfirmedLocalQuotaEnv(latestEnvId)) {
              externalQuotaNeedsRecheck = true;
            }
          } else if (isConfirmedLocalQuotaEnv(currentEnvId)) {
            externalQuotaSkippedLocalAgy = false;
          }
          if (!(isRemoteNow && res.providers.length === 0)) {
            const preserveAgy = res.agySkippedNative === true || res.agySkippedRemote === true || sentSkipLocalAgy || (isRemoteNow && !res.providers.some(isAgy));
            externalQuotaProviders = preserveAgy
              ? [...res.providers, ...externalQuotaProviders.filter(isAgy)]
              : res.providers;
          }
          if (activeIsRemote) {
            refreshRemoteExternalQuotas(true);
          }
          if (latestStats) renderTopbarStats(latestStats);
          else {
            const quota = computeQuotaAndContext(null);
            renderQuotaRing(quota.providerQuotas, quota.activeQuotaRingId);
            scheduleLayoutSync();
          }
        }
        if (!activeIsRemote && res?.pending === true && !disposed && externalQuotaPendingRetries < EXTERNAL_QUOTA_PENDING_MAX_RETRIES) {
          externalQuotaPendingRetries += 1;
          clearExternalQuotaPendingTimer();
          externalQuotaPendingTimer = setTimeout(() => {
            externalQuotaPendingTimer = null;
            refreshExternalQuotas(false, true);
          }, EXTERNAL_QUOTA_PENDING_DELAY_MS);
        } else {
          clearExternalQuotaPendingTimer();
          externalQuotaPendingRetries = 0;
        }
      })
      .catch(() => {
        externalQuotaFetchedAt = Date.now();
        clearExternalQuotaPendingTimer();
        externalQuotaPendingRetries = 0;
      })
      .finally(() => {
        externalQuotaInFlight = null;
        const current = readExternalQuotaObservation();
        const recheck = externalQuotaNeedsRecheck || quotaObservationChanged(observation, current);
        externalQuotaNeedsRecheck = false;
        if (!disposed && recheck && isConfirmedLocalQuotaEnv(current.environmentId)) {
          refreshExternalQuotas(false, false, true);
        }
      });
  }

  function createHudTurnSpeedState(routeKey) {
    return {
      route: String(routeKey || ""),
      active: false,
      awaitingFreshSample: false,
      baselineStepCount: null,
      lastIdleStepCount: null,
      baselineMessageId: "",
      baselineCaptured: false,
      baselineProvider: "",
    };
  }

  function resolveHudTurnSpeed(state, stats, liveTps, routeKey, liveSample) {
    const route = String(routeKey ?? stats?.threadId ?? stats?.nonThreadRoute ?? "");
    const routeChanged = state.route !== route;
    if (routeChanged) {
      state.route = route;
      state.active = false;
      state.awaitingFreshSample = false;
      state.baselineStepCount = null;
      state.lastIdleStepCount = null;
      state.baselineMessageId = "";
      state.baselineCaptured = false;
      state.baselineProvider = "";
    }
    // Unwrap live sample provenance: messageId + confirmation flag.
    // liveSample may be { messageId, liveSampleConfirmedNewTurn } /
    // { messageId, confirmedNewTurn } / { messageId, confirmed } / boolean.
    let liveMessageId = "";
    let liveSampleConfirmedNewTurn = null;
    if (typeof liveSample === "boolean") {
      liveSampleConfirmedNewTurn = liveSample;
    } else if (liveSample && typeof liveSample === "object") {
      liveMessageId = String(liveSample.messageId || "");
      if (typeof liveSample.liveSampleConfirmedNewTurn === "boolean") liveSampleConfirmedNewTurn = liveSample.liveSampleConfirmedNewTurn;
      else if (typeof liveSample.confirmedNewTurn === "boolean") liveSampleConfirmedNewTurn = liveSample.confirmedNewTurn;
      else if (typeof liveSample.confirmed === "boolean") liveSampleConfirmedNewTurn = liveSample.confirmed;
    }
    const currentProvider = String(stats?.provider || stats?.driver || "");

    const stepCount = Number.isFinite(stats?.stepCount) ? stats.stepCount : null;
    const running = Boolean(stats?.ok && stats.isRunning);
    const providerMatches = !state.baselineProvider || !currentProvider || state.baselineProvider === currentProvider;
    const liveRate = !routeChanged && providerMatches && Number.isFinite(liveTps) && liveTps > 0 ? liveTps : null;
    let started = false;

    if (running && !state.active) {
      state.active = true;
      state.awaitingFreshSample = false;
      state.baselineStepCount = state.lastIdleStepCount ?? stepCount;
      started = true;
    }
    if (!running && state.active) {
      state.active = false;
      state.awaitingFreshSample = true;
    }

    if (running) {
      if (liveRate != null) {
        const baselineMessageId = state.baselineMessageId ? String(state.baselineMessageId) : "";
        const baselineProvider = state.baselineProvider ? String(state.baselineProvider) : "";
        if (started) {
          // First frame of a new turn: only keep liveRate when it is provably
          // from a new assistant message of this turn.
          const confirmed = state.baselineCaptured === true &&
            liveSampleConfirmedNewTurn === true && liveMessageId !== "" &&
            liveMessageId !== baselineMessageId &&
            (!baselineProvider || !currentProvider || baselineProvider === currentProvider);
          if (confirmed) return { kind: "estimated", value: liveRate, routeChanged, started };
        } else if (!(state.baselineCaptured === true && baselineMessageId !== "" && liveMessageId !== "" && liveMessageId === baselineMessageId)) {
          return { kind: "estimated", value: liveRate, routeChanged, started };
        }
      }
      const currentEstimate = Number(stats?.speed?.currentTurnEstimateTps);
      if (Number.isFinite(currentEstimate) && currentEstimate > 0) return { kind: "estimated", value: currentEstimate, routeChanged, started };
      return { kind: "waiting", value: null, routeChanged, started };
    }

    if (liveRate != null) {
      if (!state.active && !state.awaitingFreshSample) {
        state.active = true;
        state.baselineStepCount = state.lastIdleStepCount ?? stepCount;
        started = true;
      }
      return { kind: "estimated", value: liveRate, routeChanged, started };
    }

    if (state.awaitingFreshSample) {
      const freshTurn = stepCount != null && state.baselineStepCount != null && stepCount > state.baselineStepCount;
      if (!freshTurn) return { kind: "none", value: null, routeChanged, started };
      state.awaitingFreshSample = false;
    }

    const lastTurnTps = Number(stats?.speed?.lastDecodeTps);
    const view = Number.isFinite(lastTurnTps) && lastTurnTps > 0
      ? { kind: "turn", value: lastTurnTps, routeChanged, started }
      : { kind: "none", value: null, routeChanged, started };
    if (!state.active && !state.awaitingFreshSample && stepCount != null) state.lastIdleStepCount = stepCount;
    return view;
  }

  function formatHudTurnSpeed(view, labels) {
    if (view?.kind === "estimated") return `${labels.approx}${view.value.toFixed(1)} tok/s`;
    if (view?.kind === "turn") return `${labels.turn} ${view.value.toFixed(1)} tok/s`;
    if (view?.kind === "waiting") return labels.waiting;
    return "-- tok/s";
  }

  function createHudSessionSpeedState() {
    return { route: "", threadId: "", provider: "", kind: "unknown", value: null };
  }

  function resolveHudSessionSpeed(state, stats, routeKey) {
    const route = String(routeKey || "");
    const clear = () => { state.threadId = ""; state.provider = ""; state.kind = "unknown"; state.value = null; };
    if (state.route !== route) { state.route = route; clear(); }
    if (stats?.nonThreadRoute === "new") {
      clear(); state.kind = "new"; state.value = 0;
    } else if (stats?.ok) {
      const threadId = String(stats.threadId || ""), provider = String(stats.provider || "");
      if (state.threadId && threadId && state.threadId !== threadId) clear();
      if (state.kind === "new") { state.kind = "unknown"; state.value = null; }
      if (state.kind === "last" && state.provider && provider && state.provider !== provider) { state.kind = "unknown"; state.value = null; }
      if (threadId) state.threadId = threadId;
      if (provider) state.provider = provider;
      const valid = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;
      if (valid(stats.speed?.tokPerSec)) { state.kind = "average"; state.value = stats.speed.tokPerSec; }
      else if (state.kind !== "average" && valid(stats.speed?.lastDecodeTps)) { state.kind = "last"; state.value = stats.speed.lastDecodeTps; }
      else if (state.kind === "unknown" && stats.turnCount === 0 && stats.tokens?.output === 0) { state.kind = "new"; state.value = 0; }
    }
    return { kind: state.kind, value: state.value };
  }

  function isCurrentStatsSnapshot(requestId, latestRequestId, requestedRoute, currentRoute) {
    return requestId === latestRequestId && String(requestedRoute ?? "") === String(currentRoute ?? "");
  }

  function isHiddenStreamNode(el, root) {
    let cur = el;
    for (let guard = 0; cur && guard < 128; guard++) {
      try {
        if (cur.hidden === true || cur.getAttribute?.("hidden") != null || cur.getAttribute?.("aria-hidden") === "true") return true;
        const tag = String(cur.tagName || cur.localName || cur.nodeName || "").toLowerCase();
        if (tag === "details" && cur.open !== true && cur.getAttribute?.("open") == null) return true;
        const style = cur.style;
        if (style?.display === "none" || style?.visibility === "hidden" || style?.visibility === "collapse") return true;
        if (typeof style === "string" && /display\s*:\s*none|visibility\s*:\s*(hidden|collapse)/i.test(style)) return true;
        const view = cur.ownerDocument?.defaultView;
        const computed = typeof view?.getComputedStyle === "function" ? view.getComputedStyle(cur)
          : typeof getComputedStyle === "function" ? getComputedStyle(cur) : null;
        if (computed?.display === "none" || computed?.visibility === "hidden" || computed?.visibility === "collapse") return true;
      } catch {}
      if (cur === root) break;
      cur = cur.parentElement || cur.parentNode || cur.parent || null;
    }
    return false;
  }

  function visibleStreamText(el, root) {
    const collect = (node) => {
      if (!node || isHiddenStreamNode(node, root)) return "";
      if (node.nodeType === 3) return String(node.textContent || node.nodeValue || "");
      const kids = node.childNodes?.length ? node.childNodes : node.children;
      // DOM NodeLists are array-like, not Arrays. Never fall back to container text after filtering.
      if (kids?.length) return Array.from(kids, collect).join("");
      try {
        const lacksInnerText = typeof node.innerText !== "string";
        return lacksInnerText ? String(node.textContent || "") : node.innerText;
      } catch { return ""; }
    };
    return collect(el);
  }

  function getAssistantStreamSnapshot(chatCol) {
    function isHiddenStreamNode(el, root) {
      let cur = el;
      for (let guard = 0; cur && guard < 128; guard++) {
        try {
          if (cur.hidden === true || cur.getAttribute?.("hidden") != null || cur.getAttribute?.("aria-hidden") === "true") return true;
          const tag = String(cur.tagName || cur.localName || cur.nodeName || "").toLowerCase();
          if (tag === "details" && cur.open !== true && cur.getAttribute?.("open") == null) return true;
          const style = cur.style;
          if (style?.display === "none" || style?.visibility === "hidden" || style?.visibility === "collapse") return true;
          if (typeof style === "string" && /display\s*:\s*none|visibility\s*:\s*(hidden|collapse)/i.test(style)) return true;
          const view = cur.ownerDocument?.defaultView;
          const computed = typeof view?.getComputedStyle === "function" ? view.getComputedStyle(cur)
            : typeof getComputedStyle === "function" ? getComputedStyle(cur) : null;
          if (computed?.display === "none" || computed?.visibility === "hidden" || computed?.visibility === "collapse") return true;
        } catch {}
        if (cur === root) break;
        cur = cur.parentElement || cur.parentNode || cur.parent || null;
      }
      return false;
    }
    function visibleStreamText(el, root) {
      const collect = (node) => {
        if (!node || isHiddenStreamNode(node, root)) return "";
        if (node.nodeType === 3) return String(node.textContent || node.nodeValue || "");
        const kids = node.childNodes?.length ? node.childNodes : node.children;
        // DOM NodeLists are array-like, not Arrays. Never fall back to container text after filtering.
        if (kids?.length) return Array.from(kids, collect).join("");
        try {
          const lacksInnerText = typeof node.innerText !== "string";
          return lacksInnerText ? String(node.textContent || "") : node.innerText;
        } catch { return ""; }
      };
      return collect(el);
    }

    if (!chatCol || typeof chatCol.querySelectorAll !== "function") return null;
    let nodes;
    try { nodes = Array.from(chatCol.querySelectorAll('[data-message-role], [data-timeline-row-kind="thinking"]')); }
    catch { return null; }
    const attr = (node, name, key) => node?.getAttribute?.(name) || node?.dataset?.[key] || "";
    const role = (node) => attr(node, "data-message-role", "messageRole");
    const fiberTurnId = (node) => {
      try {
        for (const k of Object.keys(node || {})) {
          if (!k.startsWith("__reactFiber$") && !k.startsWith("__reactProps$")) continue;
          let cur = node[k];
          for (let depth = 0; cur && depth < 5; depth++) {
            const props = cur.memoizedProps || cur;
            const tid = props?.turnId || props?.providerTurnId || props?.row?.turnId || props?.row?.providerTurnId || props?.message?.turnId || props?.item?.providerTurnId;
            if (typeof tid === "string" && tid.trim()) return tid.trim();
            cur = cur.return || null;
          }
        }
      } catch {}
      return "";
    };
    const nodeTurnId = (node) => attr(node, "data-turn-id", "turnId") || attr(node, "data-provider-turn-id", "providerTurnId") || fiberTurnId(node);
    let lastUserIdx = -1;
    for (let i = 0; i < nodes.length; i++) if (role(nodes[i]) === "user") lastUserIdx = i;
    let turnNodes = nodes.slice(lastUserIdx + 1).filter(node => role(node) === "assistant" ||
      attr(node, "data-timeline-row-kind", "timelineRowKind") === "thinking");
    let visible = turnNodes.filter(node => !isHiddenStreamNode(node, chatCol));
    if (!visible.length) return null;
    let unboundedNoUser = false;
    const tail = visible[visible.length - 1];
    const tailTurnId = nodeTurnId(tail);
    let lockedTurnId = tailTurnId || null;
    let start = nodes.indexOf(tail);
    // Unidentified tail blocks can accompany the current answer. Once an ID
    // is found, every earlier row must prove the same identity, even hidden rows.
    while (start > lastUserIdx + 1) {
      const prev = nodes[start - 1];
      const rowTurnId = nodeTurnId(prev);
      if (lockedTurnId && rowTurnId !== lockedTurnId) break;
      if (!lockedTurnId && rowTurnId) lockedTurnId = rowTurnId;
      start--;
    }
    if (lastUserIdx === -1 && !lockedTurnId) {
      if (nodes.length !== 1 || visible.length !== 1) return null;
      unboundedNoUser = true;
    }
    turnNodes = turnNodes.filter(node => nodes.indexOf(node) >= start && nodes.indexOf(node) <= nodes.indexOf(tail));
    visible = turnNodes.filter(node => !isHiddenStreamNode(node, chatCol));
    // Keep the first turn row as anchor even if its thinking text is later collapsed.
    const rowId = (node) => attr(node, "data-message-id", "messageId") || attr(node, "data-timeline-row-id", "timelineRowId");
    const messageId = String(rowId(turnNodes.find(node => rowId(node)) || visible[0]));
    const snapshotTurnId = lockedTurnId;
    const texts = [];
    for (const node of visible) {
      let text = visibleStreamText(node, chatCol);
      // Some virtual stream surfaces expose extra children only via selectors.
      for (const extra of node.querySelectorAll?.('[data-streaming="true"], [data-thinking="true"], [class*="streaming"], [class*="thinking"]') || []) {
        const extraText = visibleStreamText(extra, chatCol);
        if (extraText && !text.includes(extraText)) text += extraText;
      }
      texts.push(text);
    }
    return { messageId, turnId: snapshotTurnId, text: texts.join("\n"), unboundedNoUser, hasUserAnchor: lastUserIdx >= 0 };
  }

  function canSampleHudStream(stats, snapshot) {
    if (!(stats?.ok === true && stats.isRunning === true && Boolean(snapshot))) return false;
    const hasExplicitList = Array.isArray(stats.activeTurnIds);
    const activeIds = hasExplicitList
      ? stats.activeTurnIds.filter(Boolean).map(String)
      : stats.activeTurnId != null && String(stats.activeTurnId) !== ""
        ? [String(stats.activeTurnId)]
        : null;
    const snapTurnId = String(snapshot.turnId || "");
    if (hasExplicitList) {
      if (activeIds.length === 0 || !snapTurnId || !activeIds.includes(snapTurnId)) return false;
    } else if (activeIds) {
      if (!snapTurnId || !activeIds.includes(snapTurnId)) return false;
    } else if (snapTurnId) {
      return false;
    }
    return true;
  }

  function createHudStreamSampler() {
    return { samples: [], messageId: "", provider: "", lastGrowthAt: 0, liveTps: null };
  }

  function advanceHudStreamSampler(sampler, snapshot, now, enabled, estimateTokens) {
    const previousRate = sampler.liveTps;
    const clear = (stalled = false) => {
      const changed = sampler.liveTps != null || sampler.samples.length > 0;
      sampler.samples = [];
      sampler.messageId = "";
      sampler.provider = "";
      sampler.lastGrowthAt = 0;
      sampler.liveTps = null;
      return { liveTps: null, changed, stalled };
    };
    if (!enabled || !snapshot) return clear();

    const messageId = String(snapshot.messageId || "");
    if (sampler.messageId && messageId && sampler.messageId !== messageId) {
      sampler.samples = [];
      sampler.lastGrowthAt = 0;
      sampler.liveTps = null;
    }
    if (messageId) sampler.messageId = messageId;

    const estTok = estimateTokens(snapshot.text);
    if (sampler.samples.length > 0) {
      const prev = sampler.samples[sampler.samples.length - 1];
      if (estTok > prev.tok + 1.2) {
        sampler.lastGrowthAt = now;
      } else if (estTok < prev.tok - 20) {
        sampler.samples = [{ t: now, tok: estTok }];
        sampler.lastGrowthAt = 0;
        sampler.liveTps = null;
        return { liveTps: null, changed: previousRate != null, stalled: false };
      }
    }
    sampler.samples.push({ t: now, tok: estTok });
    while (sampler.samples.length > 1 && now - sampler.samples[0].t > 1600) sampler.samples.shift();

    if (sampler.lastGrowthAt > 0 && now - sampler.lastGrowthAt <= 1300 && sampler.samples.length >= 2) {
      const first = sampler.samples[0];
      const last = sampler.samples[sampler.samples.length - 1];
      const dt = (last.t - first.t) / 1000;
      const dTok = last.tok - first.tok;
      if (dt >= 0.22 && dTok >= 1.8) {
        const inst = Math.min(950, dTok / dt);
        sampler.liveTps = sampler.liveTps != null ? sampler.liveTps * 0.55 + inst * 0.45 : inst;
      }
    } else if (sampler.liveTps != null && now - sampler.lastGrowthAt > 1400) {
      return clear(true);
    }

    return { liveTps: sampler.liveTps, changed: sampler.liveTps !== previousRate, stalled: false };
  }

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
      spacedComposerStack.style.removeProperty("--t3-hud-composer-space");
      spacedComposerStack = null;
    }
    if (stackEl && !stackEl.classList.contains("t3-hud-composer-spaced")) {
      stackEl.classList.add("t3-hud-composer-spaced");
    }
    if (stackEl) {
      const spacing = `${(topbar.offsetHeight || 26) + 2}px`;
      if (stackEl.style.getPropertyValue("--t3-hud-composer-space") !== spacing) stackEl.style.setProperty("--t3-hud-composer-space", spacing);
    }
    spacedComposerStack = stackEl || null;
  }

  function findComposerSurface(shell) {
    const editor = shell.querySelector('textarea,[contenteditable="true"],[contenteditable="plaintext-only"]');
    for (let node = editor?.parentElement; node && shell.contains(node); node = node.parentElement) {
      const css = getComputedStyle(node), rect = node.getBoundingClientRect();
      const background = css.backgroundColor && !/^(transparent|rgba\(0,\s*0,\s*0,\s*0\))$/.test(css.backgroundColor);
      const border = parseFloat(css.borderTopWidth) > 0 && css.borderTopStyle !== "none";
      if (parseFloat(css.borderRadius || css.borderTopLeftRadius) >= 6 && (background || border) && rect.width >= 180 && rect.height >= 28) return node;
      if (node === shell) break;
    }
    return shell;
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
    // 2) Composer check: bounds are needed to distinguish inline popovers.
    const shell = document.querySelector('[data-slot="composer-shell"]');
    if (!shell) return null;
    const surface = findComposerSurface(shell);
    let sRect = null;
    try {
      sRect = surface.getBoundingClientRect();
    } catch {}
    if (!sRect) return null;
    if (!(sRect.width >= 180 && sRect.height >= 28 && sRect.top > 40 && sRect.bottom <= window.innerHeight + 4)) {
      return null;
    }
    // 3) Visible modals always cover the chat; inline popovers only block
    // the HUD when they overlap its composer surface.
    try {
      const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"], [data-slot="dialog-popup"], [data-slot="sheet-popup"], [data-slot="drawer-popup"]');
      for (const d of dialogs) {
        try {
          if (d.hasAttribute("data-closed")) continue;
          let invisible = false;
          for (let el = d; el; el = el.parentElement) {
            const css = getComputedStyle(el);
            if (el.hidden || el.inert || el.hasAttribute("inert") || el.getAttribute("aria-hidden") === "true" || css.display === "none" || css.visibility === "hidden" || Number(css.opacity) === 0) {
              invisible = true;
              break;
            }
            if (el === document.body) break;
          }
          if (invisible) continue;
          const r = d.getBoundingClientRect();
          if (!(r.width > 100 && r.height > 80)) continue;
          const modal = d.getAttribute("aria-modal") === "true" || d.getAttribute("role") === "alertdialog" || ["dialog-popup", "sheet-popup"].includes(d.getAttribute("data-slot"));
          const overlaps = r.left < sRect.right && r.right > sRect.left && r.top < sRect.bottom && r.bottom > sRect.top;
          if (modal || overlaps) return null;
        } catch {}
      }
    } catch {}
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
      headerTools.classList.add("is-hidden");
      contextControl.classList.add("is-hidden");
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

  // Select an actually free horizontal interval instead of covering native
  // controls. The injected surfaces stay in our root and never mutate React.
  function hudFreeIntervals(left, right, obstacles) {
    let intervals = [{ left, right }];
    for (const item of obstacles || []) {
      if (!item || item.right <= item.left) continue;
      intervals = intervals.flatMap((gap) => {
        if (item.right <= gap.left || item.left >= gap.right) return [gap];
        return [
          { left: gap.left, right: Math.min(gap.right, item.left - 3) },
          { left: Math.max(gap.left, item.right + 3), right: gap.right },
        ].filter((part) => part.right > part.left);
      });
    }
    return intervals;
  }

  function calculateHudLayout({
    header, title, headerObstacles, attach, model, footerObstacles, viewportWidth,
    headerFullWidth = 152, headerCompactWidth = 96, headerCompactGitWidth = headerCompactWidth, ringCount = 0,
  }) {
    const result = { header: null, context: null, stats: null };
    if (header && header.width >= 120) {
      const left = Math.max(header.left + 8, title ? title.right + 8 : header.left + 8);
      const gaps = hudFreeIntervals(left, Math.min(header.right - 8, viewportWidth - 8), headerObstacles);
      let bestPriority = -1;
      for (const gap of gaps) {
        const available = gap.right - gap.left;
        const gitFits = available >= headerCompactGitWidth;
        const ringsWithGit = !gitFits ? 0 : available >= headerCompactWidth ? ringCount :
          Math.min(ringCount, Math.floor((available - headerCompactGitWidth) / 36));
        const quotaOnly = ringCount > 0 && ringsWithGit === 0 && available >= 32;
        if (!gitFits && !quotaOnly) continue;
        const compact = quotaOnly || available < headerFullWidth;
        const maxVisibleRings = quotaOnly ? 1 : ringsWithGit;
        const width = quotaOnly ? 32 : !compact ? headerFullWidth : headerCompactGitWidth + maxVisibleRings * 36;
        // Prefer more rings, then keep Git if it fits, then show its full label.
        const priority = maxVisibleRings * 3 + (quotaOnly ? 0 : compact ? 1 : 2);
        if (priority > bestPriority || (priority === bestPriority && gap.right > result.header.left + result.header.width)) {
          bestPriority = priority;
          result.header = { left: gap.right - width, top: header.top + (header.height - 32) / 2, width, compact, quotaOnly, maxVisibleRings };
        }
      }
    }
    if (attach && model && model.left > attach.right && model.width > 0 && attach.width > 0) {
      const contextRight = model.left - 3, contextLeft = contextRight - 22;
      const occupied = (footerObstacles || []).some((rect) => rect.right > contextLeft && rect.left < contextRight);
      if (!occupied && contextLeft > attach.right + 3) {
        result.context = { left: contextLeft, top: model.top + (model.height - 28) / 2, width: 22 };
        const gaps = hudFreeIntervals(attach.right + 5, contextLeft - 4, footerObstacles)
          .filter((gap) => gap.right - gap.left >= 42).sort((a, b) => (b.right - b.left) - (a.right - a.left));
        if (gaps.length) {
          const gap = gaps[0];
          result.stats = { left: gap.left, top: model.top + (model.height - 27) / 2, width: gap.right - gap.left };
        }
      }
    }
    return result;
  }

  function visibleHudRect(node, includeAriaHiddenSpacer = false) {
    if (!node || node.hidden || node.closest?.('[hidden], [inert]') ||
        (includeAriaHiddenSpacer ? node.parentElement : node)?.closest?.('[aria-hidden="true"]')) return null;
    const rect = node.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return null;
    if (!includeAriaHiddenSpacer && typeof getComputedStyle === "function" && /^(hidden|collapse)$/.test(getComputedStyle(node).visibility)) return null;
    return rect;
  }

  function measureHudTitleRect(title) {
    const rect = visibleHudRect(title);
    if (!rect || title.closest?.('button, [role="button"]') || title.tagName === "INPUT") return rect;
    const textRects = [];
    try {
      const range = document.createRange();
      const walker = document.createTreeWalker(title, 4); // NodeFilter.SHOW_TEXT
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        if (!text.data.trim() || text.parentElement?.closest('[hidden], [aria-hidden="true"]')) continue;
        range.selectNodeContents(text);
        textRects.push(...range.getClientRects());
      }
    } catch {}
    let content = textRects.filter((part) => part.width > 0 && part.height > 0);
    if (!content.length) {
      content = [...(title.querySelectorAll?.("span, b, em, i, strong") || [])]
        .map((node) => visibleHudRect(node)).filter(Boolean);
    }
    if (!content.length) return rect;
    const left = Math.max(rect.left, Math.min(...content.map((part) => part.left)));
    const right = Math.min(rect.right, Math.max(...content.map((part) => part.right)));
    return right > left ? { top: rect.top, bottom: rect.bottom, height: rect.height, left, right, width: right - left } : rect;
  }

  function placeHudElement(element, layout) {
    element.classList.toggle("is-hidden", !layout);
    if (!layout) return;
    element.style.left = `${Math.round(layout.left)}px`;
    element.style.top = `${Math.round(layout.top)}px`;
    element.style.right = "auto";
  }

  function measureHudHeaderWidths() {
    // Measure a hidden clone outside the possibly hidden/compact header, including
    // the current dirty badge. Never guess a width when measurement is unavailable.
    const clone = gitBtn.cloneNode(true);
    clone.style.position = "fixed";
    clone.style.left = "-10000px";
    clone.style.visibility = "hidden";
    clone.style.pointerEvents = "none";
    clone.setAttribute("aria-hidden", "true");
    clone.tabIndex = -1;
    root.appendChild(clone);
    const full = clone.getBoundingClientRect().width;
    const label = clone.querySelector("#t3-hud-branch");
    if (label) label.style.display = "none";
    const compact = clone.getBoundingClientRect().width;
    clone.remove();
    const count = quotaRings.children.length;
    const ringSpace = count * 36; // 32px each plus 4px gaps, including the gap to Git.
    return {
      headerFullWidth: full > 0 ? Math.ceil(full + ringSpace) + 2 : Infinity,
      headerCompactWidth: compact > 0 ? Math.ceil(compact + ringSpace) + 2 : Infinity,
      headerCompactGitWidth: compact > 0 ? Math.ceil(compact) + 2 : Infinity,
      ringCount: count,
    };
  }

  function findHudLayoutAnchors(header, composer, footer) {
    // T3 v0.1.11 translates the control labels. The icon and chevron survive a language change.
    const title = header?.querySelector('input[aria-label="Thread title"]') ||
      header?.querySelector("input.min-w-0.flex-1") ||
      header?.querySelector("[data-thread-title-chevron]")?.closest('button[aria-haspopup="menu"]') ||
      header?.querySelector('[aria-label^="Thread actions for"], h1, h2');
    const attach = (footer || composer)?.querySelector("svg.lucide-paperclip")?.closest("button") ||
      composer?.querySelector('button[aria-label="Attach files"]');
    return { title, attach };
  }

  function collectHudLayoutObstacles(container, selector, row, excluded, spacerSelector) {
    if (!row) return [];
    return [...(container?.querySelectorAll(selector) || [])]
      .filter((node) => !excluded.some((anchor) => anchor && (node.contains(anchor) || anchor.contains(node))))
      .map((node) => visibleHudRect(node, spacerSelector && node.matches(spacerSelector)))
      .filter((rect) => rect && rect.top < row.bottom && rect.bottom > row.top);
  }

  function fitHudStatsBar(element, layout) {
    if (!layout) return null;
    const available = layout.left + layout.width - Math.round(layout.left);
    const metrics = ["cache", "tokens", "cost"].map((key) => element.querySelector(`[data-hud-metric="${key}"]`));
    const hide = (metric, hidden) => {
      metric.classList.toggle("is-overflow-hidden", hidden);
      metric.previousElementSibling?.classList.toggle("is-overflow-hidden", hidden);
    };
    element.classList.remove("is-hidden", "is-tight", "is-mini");
    for (const metric of metrics) hide(metric, false);
    const fits = () => element.getBoundingClientRect().width <= available;
    if (fits()) return layout;
    element.classList.add("is-tight");
    if (fits()) return layout;
    element.classList.add("is-mini");
    if (fits()) return layout;
    for (const metric of metrics) {
      hide(metric, true);
      if (fits()) return layout;
    }
    return null;
  }

  function fitHudQuotaRings(rings, maxVisibleRings) {
    const ordered = [...rings.children];
    const active = ordered.filter((button) => button.hasAttribute("data-hud-quota-active"))
      .sort((a, b) => Number(b.hasAttribute("data-hud-quota-primary")) - Number(a.hasAttribute("data-hud-quota-primary")));
    const visible = new Set([...active, ...ordered.filter((button) => !active.includes(button))].slice(0, maxVisibleRings));
    for (const button of ordered) button.classList.toggle("is-overflow-hidden", !visible.has(button));
  }

  // Anchor to the native title/composer controls without altering them.
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

    setComposerTopSpacing(null);
    const model = composer?.querySelector('[data-chat-provider-model-picker]');
    const footer = composer?.querySelector('[data-chat-composer-footer="true"]');
    const { title, attach } = findHudLayoutAnchors(header, composer, footer);
    const hRect = visibleHudRect(header), titleRect = measureHudTitleRect(title);
    const modelRect = visibleHudRect(model), attachRect = visibleHudRect(attach);
    const headerSpacer = ':scope > span[aria-hidden="true"]';
    const headerObstacles = collectHudLayoutObstacles(header, `button, [role="button"], ${headerSpacer}`, hRect, [title], 'span[aria-hidden="true"]');
    const footerObstacles = collectHudLayoutObstacles(footer,
      'button, [role="button"], [data-resting-block], [data-resting-controls-separator], [data-resting-controls-overflow]',
      modelRect, [attach, model]);
    const layout = calculateHudLayout({ header: hRect, title: titleRect, headerObstacles, attach: attachRect, model: modelRect, footerObstacles, viewportWidth: window.innerWidth, ...measureHudHeaderWidths() });
    headerTools.classList.toggle("is-compact", !!layout.header?.compact);
    headerTools.classList.toggle("is-quota-only", !!layout.header?.quotaOnly);
    const visibleRings = layout.header?.maxVisibleRings || 0;
    headerTools.classList.toggle("has-no-rings", visibleRings === 0);
    fitHudQuotaRings(quotaRings, visibleRings);
    const statsLayout = fitHudStatsBar(topbar, layout.stats);
    placeHudElement(headerTools, layout.header);
    placeHudElement(contextControl, layout.context);
    placeHudElement(topbar, statsLayout);
    lastLayoutState.hidden = !statsLayout;
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
    let environmentId = null;
    try {
      // Keep the raw draft ID even though the telemetry route collapses
      // unpromoted drafts to __NEW__. Only this draft can supply its environment.
      const location = typeof window !== "undefined" ? window.location : null;
      const raw = (typeof getRouterPathname === "function" ? getRouterPathname(findTanStackRouter()) : "") ||
        location?.hash?.replace(/^#/, "") || location?.pathname || "";
      const parts = raw.split(/[?#]/, 1)[0].split("/").filter(Boolean);
      const scoped = parts[0] === "_t3_env_" && (parts.length === 3 || (parts.length === 4 && parts[2] === "draft"));
      if (parts[0] === "_t3_env_" && !scoped) return { usage, contextWindow, selectedModel, selectedProvider, environmentId };
      const native = parts.length === 2 && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(parts[0]);
      const routeEnv = scoped || native ? decodeURIComponent(parts[scoped ? 1 : 0]) : "";
      const routeParts = scoped ? parts.slice(2) : parts;
      const isDraft = routeParts[0]?.toLowerCase() === "draft";
      const draftId = isDraft && routeParts[1] ? decodeURIComponent(routeParts[1]) : "";
      const isLauncher = Boolean(raw) && (!parts.length || (/^new$/i.test(parts[0]) && parts.length === 1));
      const threadId = isDraft || isLauncher ? "" : scoped || native ? decodeURIComponent(parts.at(-1)) :
        parts.length === 1 && typeof extractLastThreadIdFromHint === "function" ? extractLastThreadIdFromHint(raw) : "";
      const explicitDraft = scoped && isDraft;
      let needsOwner = Boolean(routeEnv || isDraft || isLauncher || threadId);
      environmentId = routeEnv || (isDraft || isLauncher ? null : "");
      const header = document.querySelector?.("header[data-chat-header]");
      const rootEl = document.getElementById("root");
      if (!rootEl) return { usage, contextWindow, selectedModel, selectedProvider, environmentId };
      const fk = Object.keys(rootEl).find(
        (k) => k.startsWith("__reactContainer") || k.startsWith("__reactFiber")
      );
      if (!fk) return { usage, contextWindow, selectedModel, selectedProvider, environmentId };
      let entry = rootEl[fk];
      const ancestors = new Set();
      while (entry?.return && !entry.stateNode?.current && ancestors.size < 400 && !ancestors.has(entry)) {
        ancestors.add(entry);
        entry = entry.return;
      }
      if (entry?.return && !entry.stateNode?.current) return { usage, contextWindow, selectedModel, selectedProvider, environmentId };
      const stack = [entry?.stateNode?.current || entry?.current || entry];
      const seen = new Set();
      while (stack.length && seen.size < 20000) {
        const f = stack.pop();
        if (!f || seen.has(f)) continue;
        seen.add(f);
        const p = f.memoizedProps;
        if (p) {
          const scopeMatches = threadId ? p.isServerThread === true && p.threadId === threadId :
            draftId ? p.draftId === draftId :
            explicitDraft || isLauncher ? p.isServerThread === false : !isDraft;
          const ownerMatches = (!routeEnv || p.environmentId === routeEnv) &&
            scopeMatches && (!header || !p.anchor || p.anchor.current === header);
          if (!usage && ownerMatches && typeof p.isServerThread === "boolean") {
            environmentId = routeEnv || (typeof p.environmentId === "string" ? p.environmentId : "");
            needsOwner = false;
          }
          if (!usage && ownerMatches && p.usage && !needsOwner &&
              (Array.isArray(p.usage.providers) || Array.isArray(p.usage.sources) || Array.isArray(p.usage.usageLimitSources))) {
            usage = p.usage;
          }
          const matchesSelection = p.isServerThread === undefined || ownerMatches;
          if (!contextWindow && matchesSelection && typeof p.contextWindow?.usedTokens === "number") {
            contextWindow = p.contextWindow;
          }
          if (!selectedModel && matchesSelection && typeof p.selectedModel === "string") {
            selectedModel = p.selectedModel;
            selectedProvider = p.selectedProvider || selectedProvider;
          } else if (!selectedModel && matchesSelection && typeof p.modelSelection?.model === "string") {
            selectedModel = p.modelSelection.model;
            selectedProvider = p.modelSelection.instanceId || p.modelSelection.provider || selectedProvider;
          }
        }
        if (usage && selectedModel && (contextWindow || usage.contextWindow)) break;
        if (f.child) stack.push(f.child);
        if (f.sibling) stack.push(f.sibling);
      }
      if (needsOwner) {
        selectedModel = null;
        selectedProvider = null;
        contextWindow = null;
      }
      // A promoted draft can keep its raw URL after its draft Fiber unmounts.
      // Recover only the environment proven by that draft's promotion.
      if (environmentId === null && draftId && typeof getRouteHint === "function") {
        const promotedEnv = /^\/_t3_env_\/([^/]+)\/[^/]+$/.exec(getRouteHint())?.[1];
        if (promotedEnv) environmentId = decodeURIComponent(promotedEnv);
      }
      selectedModel ||= typeof usage?.model === "string" ? usage.model : null;
      selectedProvider ||= typeof usage?.providerInstanceId === "string" ? usage.providerInstanceId : null;
    } catch {}
    finally {
      if (typeof refreshStats === "function") refreshStats._observeSelection?.({ selectedProvider, selectedModel });
    }
    return { usage, contextWindow, selectedModel, selectedProvider, environmentId };
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

  // Context, cache, running state and Git stay monochrome. Only quota carries semantic color.
  function contextColor() { return "var(--hud-fg)"; }
  function isValidHudCacheRate(rate) {
    return typeof rate === "number" && Number.isFinite(rate) && rate >= 0 && rate <= 1;
  }

  function resolveHudCacheDisplay(stats) {
    if (!stats?.ok || stats.nonThreadRoute === "new") return { kind: "unknown", rate: null };
    const turnRate = stats.cache?.turnRate;
    if (turnRate != null) return isValidHudCacheRate(turnRate) ? { kind: "turn", rate: turnRate } : { kind: "unknown", rate: null };
    const sessionRate = stats.cache?.withSubagentsSessionRate ?? stats.cache?.sessionRate ?? stats.cache?.mainSessionRate;
    if (sessionRate != null) return isValidHudCacheRate(sessionRate) ? { kind: "session", rate: sessionRate } : { kind: "unknown", rate: null };
    return { kind: "unknown", rate: null };
  }

  function refreshHudStatsPopover(popoverElement, mode, activeElement, renderStats) {
    if (mode !== "stats" || !popoverElement?.classList?.contains("visible")) return false;
    if (typeof renderStats !== "function") return false;
    const selector = activeElement?.tagName === "A" ? "a" : "button";
    const controls = popoverElement.contains?.(activeElement)
      ? Array.from(popoverElement.querySelectorAll?.(selector) || [])
      : [];
    const focusIndex = controls.indexOf(activeElement);
    const scrollTop = popoverElement.scrollTop;
    renderStats();
    popoverElement.scrollTop = scrollTop;
    if (focusIndex >= 0) {
      const nextControl = popoverElement.querySelectorAll?.(selector)?.[focusIndex];
      try { nextControl?.focus?.({ preventScroll: true }); }
      catch { try { nextControl?.focus?.(); } catch {} }
    }
    return true;
  }

  function cacheColor() { return "var(--hud-fg)"; }

  const quotaBurnSamples = new Map();
  const QUOTA_BURN_WINDOW_MS = 60 * 60 * 1000;
  const QUOTA_BURN_MIN_SPAN_MS = 5 * 60 * 1000;

  function recordQuotaBurnEstimate(sampleKey, usedPercent, nowMs = Date.now()) {
    if (!sampleKey || typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return { burnShort: null, justReset: false };
    const clamped = Math.max(0, Math.min(100, usedPercent));
    let list = quotaBurnSamples.get(sampleKey);
    if (!Array.isArray(list)) {
      list = [];
      quotaBurnSamples.set(sampleKey, list);
    }
    const prev = list.length ? list[list.length - 1] : null;
    let justReset = false;
    if (prev && prev.usedPercent - clamped >= 40) {
      justReset = true;
      list.length = 0;
    }
    if (!prev || nowMs - prev.ts >= 30_000 || Math.abs(clamped - prev.usedPercent) >= 0.5) {
      list.push({ ts: nowMs, usedPercent: clamped });
    }
    const cutoff = nowMs - QUOTA_BURN_WINDOW_MS;
    while (list.length > 1 && list[0].ts < cutoff) list.shift();
    if (list.length > 24) list.splice(0, list.length - 24);
    if (list.length < 2) return { burnShort: null, justReset };
    const first = list[0];
    const last = list[list.length - 1];
    const spanMs = last.ts - first.ts;
    const deltaUsed = last.usedPercent - first.usedPercent;
    if (spanMs < QUOTA_BURN_MIN_SPAN_MS || deltaUsed < 0.5) return { burnShort: null, justReset };
    const remaining = Math.max(0, 100 - clamped);
    if (remaining <= 0) return { burnShort: "0m", justReset };
    const ratePerHour = deltaUsed / (spanMs / 3_600_000);
    if (!Number.isFinite(ratePerHour) || ratePerHour <= 0) return { burnShort: null, justReset };
    const hoursLeft = remaining / ratePerHour;
    let burnShort = null;
    if (hoursLeft < 0.25) burnShort = "<15m";
    else if (hoursLeft < 1) burnShort = `~${Math.max(15, Math.round(hoursLeft * 60))}m`;
    else if (hoursLeft < 48) burnShort = `~${hoursLeft.toFixed(1)}h`;
    else if (hoursLeft < 24 * 14) burnShort = `~${(hoursLeft / 24).toFixed(1)}d`;
    return { burnShort, justReset };
  }

  function selectHudFiveHourWindow(windows) {
    return windows.find((w) => {
      // T3's native usage contract reports the authoritative duration in minutes.
      // A generic Session label alone does not establish a five-hour window.
      if (w.windowDurationMins != null) return w.windowDurationMins === 300;
      return /(?:^|[^\d])(?:5\s*[-_ ]?\s*(?:h|hours?|小时)|five\s*[-_ ]?\s*hours?)(?:$|[^a-z])/i.test(`${w.kind || ""} ${w.id || ""} ${w.label || ""}`);
    }) || null;
  }

  function mergeUsageLimitProviders(providers, sources, externalProviders = []) {
    const providerKey = (provider) => String(provider?.instanceId || provider?.providerInstanceId || provider?.driver || "").toLowerCase();
    const driverKey = (provider) => String(provider?.driver || "").toLowerCase();
    const timestamp = (value) => value == null ? null : toEpochMs(value);
    const agyPool = (text) => /claude|gpt|3p/i.test(text) ? "Claude" : /gemini/i.test(text) ? "Gemini" : "";
    const windowKey = (window, pool) => {
      const duration = window.windowDurationMins;
      let id = String(window.id || window.label || window.kind || "").trim().toLowerCase();
      if (pool) id = id.replace(/^(?:gemini|gem|claude|gpt|3p)[\s_-]+/, "");
      id = id.replace(/[\s_-]+/g, "");
      if (/^(?:wk|week|weekly)$/.test(id)) id = "weekly";
      if (/^(?:5h|5hour|fivehour)$/.test(id) || (id === "session" && duration === 300)) id = "5h";
      const standardDuration = id === "5h" ? 300 : id === "weekly" || window.kind === "weekly" ? 10080 : null;
      return JSON.stringify([pool, id, duration === standardDuration ? null : duration ?? null]);
    };
    const byInstance = new Map();
    const add = (provider, accountPool = "") => {
      const key = providerKey(provider);
      if (!key) return;
      const windows = Array.isArray(provider.usageLimits?.windows) ? provider.usageLimits.windows.filter((window) =>
        Number.isFinite(window?.usedPercent) && window.usedPercent >= 0 && window.usedPercent <= 100) : [];
      const checkedAt = timestamp(provider.usageLimits?.checkedAt ?? provider.checkedAt) ?? 0;
      const entry = byInstance.get(key) || { windows: new Map() };
      if (!entry.provider || (windows.length && (!entry.windows.size || checkedAt > entry.checkedAt))) {
        const instanceId = provider.instanceId || provider.providerInstanceId || entry.provider?.instanceId || provider.driver;
        entry.provider = { ...entry.provider, ...provider, instanceId };
        entry.checkedAt = checkedAt;
      }
      byInstance.set(key, entry);

      const isAgy = driverKey(entry.provider) === "antigravity";
      for (const window of windows) {
        const windowPool = isAgy ? agyPool(`${window.id || ""} ${window.label || ""}`) : "";
        const pool = windowPool || accountPool;
        const id = windowKey(window, pool || (isAgy ? "Gemini" : ""));
        const previous = entry.windows.get(id);
        const sampleTime = timestamp(window.checkedAt) ?? checkedAt;
        if (previous && sampleTime <= previous.checkedAt) continue;

        let sample = window;
        if (!windowPool && accountPool) {
          sample = { ...sample, label: `${accountPool} · ${window.label || window.id || window.kind || "Quota"}` };
        }
        const priorDuration = previous?.window.windowDurationMins;
        if (sample.windowDurationMins == null && priorDuration != null) {
          sample = { ...sample, windowDurationMins: priorDuration };
        }
        entry.windows.set(id, { window: sample, checkedAt: sampleTime });
      }
    };
    for (const provider of providers) add(provider);
    const addAccount = (account, usageLimits, source) => {
      if (!Array.isArray(usageLimits?.windows) || !usageLimits.windows.length) return;
      const instanceId = account.providerInstanceId || account.instanceId;
      const driver = driverKey(account);
      const existing = byInstance.get(String(instanceId || account.id || "").toLowerCase())?.provider ||
        (!instanceId && driver ? [...byInstance.values()].find((entry) => driverKey(entry.provider) === driver)?.provider : null);
      const resolvedDriver = existing?.driver || account.driver || instanceId;
      const accountPool = String(resolvedDriver || "").toLowerCase() === "antigravity" ?
        agyPool(account.label || "") || agyPool(account.id || "") : "";
      add({
        instanceId: instanceId || existing?.instanceId || driver || account.id,
        driver: resolvedDriver,
        displayName: existing?.displayName || account.displayName || (accountPool ? undefined : account.label),
        usageLimits: { ...usageLimits, checkedAt: usageLimits.checkedAt ?? account.checkedAt ?? source.checkedAt },
      }, accountPool);
    };
    for (const source of sources) {
      if (!source) continue;
      if (source.kind === "http" && Array.isArray(source.quotaAccounts)) {
        for (const account of source.quotaAccounts) {
          if (account) addAccount(account, { windows: account.windows }, source);
        }
      }
      if (Array.isArray(source.accounts)) {
        for (const account of source.accounts) {
          if (account) addAccount(account, account.usageLimits, source);
        }
      }
    }
    for (const provider of externalProviders) {
      const key = providerKey(provider);
      if (!key || [...byInstance].some(([id, entry]) => entry.windows.size &&
          (id === key || (key.includes("devin") && id.includes("devin"))))) continue;
      add(provider);
    }
    return [...byInstance.values()].filter((entry) => entry.windows.size).map(({ provider, windows }) => ({
      ...provider,
      usageLimits: { ...provider.usageLimits, windows: [...windows.values()].map((sample) => sample.window) },
    }));
  }

  const hudQuotaSnapshots = new Map();
  const HUD_QUOTA_SNAPSHOT_TTL_MS = 30 * 60_000;

  function hudUsageSources(usage) {
    if (Array.isArray(usage?.sources) && usage.sources.length) return usage.sources;
    return Array.isArray(usage?.usageLimitSources) ? usage.usageLimitSources : [];
  }

  function readHudQuotaProviders(usage, environmentId, localEnvironmentId, externalProviders, now = Date.now(), remoteExternalProviders = []) {
    if (environmentId === null) return [];
    const providers = Array.isArray(usage?.providers) ? usage.providers : [];
    const sources = hudUsageSources(usage);
    // Legacy usage without a reported environment can render its current
    // observations; only an explicit environment key can use the cache.
    if (environmentId === undefined) return mergeUsageLimitProviders(providers, sources, externalProviders);
    const local = !environmentId || (typeof localEnvironmentId === "string" && localEnvironmentId.length > 0 && environmentId.toLowerCase() === localEnvironmentId.toLowerCase());
    const key = environmentId || localEnvironmentId || "";
    for (const [id, snapshot] of hudQuotaSnapshots) {
      if (now - snapshot.observedAt >= HUD_QUOTA_SNAPSHOT_TTL_MS) hudQuotaSnapshots.delete(id);
    }
    // A verified local UUID and a legacy unscoped local route use one bucket.
    const unscoped = hudQuotaSnapshots.get("");
    if (localEnvironmentId && unscoped) {
      const scoped = hudQuotaSnapshots.get(localEnvironmentId);
      if (!scoped || unscoped.observedAt > scoped.observedAt) hudQuotaSnapshots.set(localEnvironmentId, unscoped);
      hudQuotaSnapshots.delete("");
    }
    // Only remember native data here. External quota belongs to the local host
    // and follows its existing refresh policy independently of the chat.
    const merged = mergeUsageLimitProviders(providers, sources);
    if (merged.length) hudQuotaSnapshots.set(key, { observedAt: now, providers: merged });
    const current = merged.length ? merged : hudQuotaSnapshots.get(key)?.providers || [];
    if (!local) {
      if (!Array.isArray(remoteExternalProviders) || !remoteExternalProviders.length) return current;
      const nativeHasAgy = current.some(
        (p) => String(p?.driver || "").toLowerCase() === "antigravity" && Array.isArray(p?.usageLimits?.windows) && p.usageLimits.windows.length > 0
      );
      const eligibleRemote = nativeHasAgy
        ? remoteExternalProviders.filter((p) => String(p?.driver || "").toLowerCase() !== "antigravity")
        : remoteExternalProviders;
      return eligibleRemote.length ? mergeUsageLimitProviders(current, [], eligibleRemote) : current;
    }
    if (!Array.isArray(externalProviders) || !externalProviders.length) return current;
    const eligible = environmentId ? externalProviders :
      externalProviders.filter(provider => String(provider?.driver || "").toLowerCase() !== "antigravity");
    return mergeUsageLimitProviders(current, [], eligible);
  }

  function computeQuotaAndContext(stats) {
    const { usage: live, contextWindow: liveCtx, selectedModel, selectedProvider, environmentId } = readLiveT3State();
    const rawLiveContext = live?.contextWindow ?? liveCtx ?? null;
    const activeProviderRaw = (
      selectedProvider ||
      live?.providerInstanceId ||
      stats?.provider ||
      ""
    ).toLowerCase();
    const rawLiveCtxDrv = String(rawLiveContext?.driver || "").toLowerCase();
    const rawLiveCtxInst = String(rawLiveContext?.providerInstanceId || rawLiveContext?.provider || "").toLowerCase();
    const liveCtxProvider = (
      (rawLiveCtxDrv === "acpregistry" && rawLiveCtxInst.startsWith("acpregistry_") ? rawLiveCtxInst : "") ||
      rawLiveCtxDrv ||
      rawLiveCtxInst ||
      (live?.contextWindow ? String(live?.providerInstanceId || live?.provider || "").toLowerCase() : "") ||
      ""
    );
    const liveCtxMatches = !activeProviderRaw || rawLiveCtxInst === activeProviderRaw || (liveCtxProvider
      ? (liveCtxProvider === activeProviderRaw ||
         (liveCtxProvider === "acpregistry" && activeProviderRaw.startsWith("acpregistry_")) ||
         (activeProviderRaw === "acpregistry" && liveCtxProvider.startsWith("acpregistry_")))
      : !selectedProvider);
    const liveContext = rawLiveContext && liveCtxMatches
      ? rawLiveContext
      : null;
    // Prefer live composer-selected model so switching Gemini <-> Opus/Sonnet updates 周余 immediately!
    const activeModelRaw = (selectedModel || stats?.model || "").toLowerCase();

    // Antigravity live contextWindow carries the same 1+cache double-count.
    const dedupeLiveAgy = (usedTokens, displayRate) => {
      const rate = Number(displayRate);
      if (activeProviderRaw === "antigravity" && Number.isFinite(rate)) {
        if (rate > 0.01) return Math.round(usedTokens / (1 + Math.min(1, rate)));
      }
      return usedTokens;
    };
    let ctxUsed;
    let ctxMax;
    let ctxMaxSource = null;
    let ctxPct;
    if (!stats || !stats.ok) {
      if (!stats?.nonThreadRoute && stats?.tokens?.contextUsed == null && liveContext && liveContext.usedTokens > 0) {
        ctxUsed = dedupeLiveAgy(liveContext.usedTokens, stats?.cache?.displayRate);
        ctxMax = stats?.tokens?.contextMax ?? liveContext.maxTokens ?? null;
        ctxMaxSource = stats?.tokens?.contextMaxSource || (liveContext.maxTokens > 0 ? "reported" : null);
        ctxPct =
          ctxUsed != null && ctxMax > 0 ? Math.max(0, Math.min(100, (ctxUsed / ctxMax) * 100)) : null;
      } else {
        ctxUsed = 0;
        ctxMax = stats?.tokens?.contextMax ?? null;
        ctxMaxSource = stats?.tokens?.contextMaxSource || null;
        ctxPct = 0;
      }
    } else {
      const rawUsed = stats?.tokens?.contextUsed ?? liveContext?.usedTokens ?? null;
      ctxUsed = rawUsed != null && stats?.tokens?.contextUsed == null
        ? dedupeLiveAgy(rawUsed, stats?.cache?.displayRate)
        : rawUsed;
      ctxMax = stats?.tokens?.contextMax ?? liveContext?.maxTokens ?? null;
      ctxMaxSource = stats?.tokens?.contextMaxSource || (liveContext?.maxTokens > 0 ? "reported" : null);
      ctxPct =
        ctxUsed != null && ctxMax > 0 ? Math.max(0, Math.min(100, (ctxUsed / ctxMax) * 100)) : null;
    }

    const extProviders = typeof externalQuotaProviders !== "undefined" && Array.isArray(externalQuotaProviders) ? externalQuotaProviders : [];
    const localEnvironmentId = typeof hudLocalQuotaEnvironmentId === "string" ? hudLocalQuotaEnvironmentId : "";
    const remoteExtProviders = typeof getValidRemoteExternalQuotas === "function" ? getValidRemoteExternalQuotas(environmentId) : [];
    const mergedProviders = typeof readHudQuotaProviders === "function" ?
      readHudQuotaProviders(live, environmentId, localEnvironmentId, extProviders, Date.now(), remoteExtProviders) : [];

    if (!mergedProviders.length) {
      return {
        primaryWeekly: null,
        primaryFiveHour: null,
        providerQuotas: [],
        currentWindows: [],
        otherWindows: [],
        ctxUsed,
        ctxMax,
        ctxMaxSource: ctxMaxSource || "unknown",
        ctxPct,
        activeModelRaw,
        activeProviderRaw,
      };
    }

    const activeProv =
      mergedProviders.find(
        (p) => p.instanceId?.toLowerCase() === activeProviderRaw && p.usageLimits?.windows?.length
      ) ||
      mergedProviders.find(
        (p) => p.driver?.toLowerCase() === activeProviderRaw && p.usageLimits?.windows?.length
      ) ||
      null;

    const toWinItem = (w, prefix = "", burnScope = "") => {
      if (!w || typeof w.usedPercent !== "number" || !Number.isFinite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100) return null;
      const rem = Math.round(100 - w.usedPercent);
      const tone = rem >= 50 ? "ok" : rem >= 20 ? "mid" : "err";
      const reset = formatResetShort(w.resetsAt);
      const rawLbl = String(w.label || w.id || "Quota").replace(" (shared)", "");
      const burnInfo = typeof recordQuotaBurnEstimate === "function" && burnScope
        ? recordQuotaBurnEstimate(`${burnScope}:${w.id || ""}:${rawLbl}`, w.usedPercent)
        : { burnShort: null, justReset: false };
      return {
        id: String(w.id || ""),
        kind: w.kind,
        windowDurationMins: w.windowDurationMins,
        label: prefix ? `${prefix} · ${rawLbl}` : rawLbl,
        remainingPct: rem,
        tone,
        reset,
        burnShort: burnInfo.burnShort,
        justReset: burnInfo.justReset,
      };
    };

    const quotaEnvironment = environmentId || localEnvironmentId;
    const activeScopeKey = activeProv ? `${quotaEnvironment}:${String(activeProv.instanceId || activeProv.driver || "active").toLowerCase()}` : "";
    const currentWindows = (activeProv?.usageLimits?.windows || []).map((w) => toWinItem(w, "", activeScopeKey)).filter(Boolean);

    const isWeeklyWindow = (w) => w.kind === "weekly" || /weekly|周/i.test(String(w.label || ""));
    const isAgyClaudeWindow = (w) => /claude|gpt|3p/i.test(String(w.label || "")) || /claude|gpt|3p/i.test(String(w.id || ""));
    const isAgyGeminiWindow = (w) => /gemini/i.test(String(w.label || "")) || /gemini/i.test(String(w.id || ""));

    const isThirdPartyModel = /opus|sonnet|haiku|claude|gpt|o1\b|o3\b|o4\b/i.test(activeModelRaw);
    let primaryWeekly = null;
    const weeklyCandidates = currentWindows.filter(isWeeklyWindow);
    if (weeklyCandidates.length === 1) {
      primaryWeekly = weeklyCandidates[0];
    } else if (weeklyCandidates.length > 1) {
      if (isThirdPartyModel) {
        primaryWeekly = weeklyCandidates.find(isAgyClaudeWindow) || weeklyCandidates[0];
      } else {
        primaryWeekly = weeklyCandidates.find(isAgyGeminiWindow) || weeklyCandidates[0];
      }
    }

    const otherWindows = [];
    const providerQuotas = [];
    let activeQuotaRingId = "";
    const provDisplayName = {
      muse: "Muse",
      codex: "Codex",
      openai: "Codex",
      antigravity: "AGY",
      claudeagent: "Claude",
      claude: "Claude",
      opencode: "OpenCode",
      "opencode-go": "OpenCode Go",
      devin: "Devin",
      acpregistry_devin: "Devin",
    };
    const resolveLogoKey = (instanceId, driver) => {
      const idLow = String(instanceId || "").toLowerCase();
      const drvLow = String(driver || "").toLowerCase();
      if (idLow.includes("opencode") || drvLow.includes("opencode")) return "opencode";
      if (idLow.includes("devin") || drvLow.includes("devin")) return "devin";
      return drvLow || idLow;
    };
    const resolveDisplayName = (instanceId, driver) => {
      const idLow = String(instanceId || "").toLowerCase();
      const drvLow = String(driver || "").toLowerCase();
      if (provDisplayName[idLow]) return provDisplayName[idLow];
      if (idLow.includes("opencode-go") || idLow.includes("opencode_go")) return "OpenCode Go";
      if (idLow.includes("opencode") || drvLow === "opencode") return "OpenCode";
      if (idLow.includes("devin") || drvLow.includes("devin")) return "Devin";
      return provDisplayName[drvLow] || instanceId || "Provider";
    };
    for (const p of mergedProviders) {
      if (!p.usageLimits?.windows?.length) continue;
      const instanceId = String(p.instanceId || p.driver || "");
      const driver = String(p.driver || p.instanceId || "").toLowerCase();
      const pName = typeof p.displayName === "string" && p.displayName.trim() ? p.displayName.trim() : resolveDisplayName(instanceId, driver);
      const logoKey = resolveLogoKey(instanceId, driver);
      const scopeKey = `${quotaEnvironment}:${instanceId.toLowerCase() || driver}`;
      const windows = p === activeProv ? currentWindows : p.usageLimits.windows.map((w) => toWinItem(w, "", scopeKey)).filter(Boolean);
      if (driver === "antigravity") {
        const claudePool = windows.filter(isAgyClaudeWindow);
        const geminiPool = windows.filter((w) => isAgyGeminiWindow(w) || !isAgyClaudeWindow(w));
        const gemWeekly = geminiPool.find(isWeeklyWindow) || null;
        const gemFive = selectHudFiveHourWindow(geminiPool);
        const claudeWeekly = claudePool.find(isWeeklyWindow) || null;
        const claudeFive = selectHudFiveHourWindow(claudePool);
        if (gemWeekly || gemFive) {
          providerQuotas.push({
            instanceId: claudePool.length ? `${instanceId}:gemini` : instanceId,
            providerInstanceId: instanceId,
            driver: "antigravity",
            logoKey: "antigravity",
            name: claudePool.length ? `${pName} · Gemini` : pName,
            weekly: gemWeekly,
            fiveHour: gemFive,
          });
        }
        if (claudeWeekly || claudeFive) {
          providerQuotas.push({
            instanceId: `${instanceId}:claude`,
            providerInstanceId: instanceId,
            driver: "antigravity-claude",
            logoKey: "antigravity-claude",
            name: `${pName} · Claude`,
            weekly: claudeWeekly,
            fiveHour: claudeFive,
          });
        }
        if (p === activeProv) {
          const activeRings = providerQuotas.filter((quota) => quota.providerInstanceId === instanceId);
          activeQuotaRingId = (isThirdPartyModel ? activeRings.at(-1) : activeRings[0])?.instanceId || "";
        }
      } else {
        let weekly = p === activeProv ? primaryWeekly : windows.find(isWeeklyWindow) || null;
        let fiveHour = selectHudFiveHourWindow(windows);
        if (!fiveHour && logoKey === "devin") {
          fiveHour = windows.find((w) => String(w.kind || "").toLowerCase() === "daily" || w.windowDurationMins === 1440) || null;
        }
        if (!weekly && !fiveHour && windows.length) {
          const isExplicitBudgetWindow = (w) =>
            ["monthly", "daily", "credits", "acu"].includes(String(w.kind || "").toLowerCase()) ||
            /monthly|month|daily|acu|credit|月/i.test(`${w.id || ""} ${w.label || ""}`);
          const budgetWindows = windows
            .filter(isExplicitBudgetWindow)
            .sort((a, b) => (Number(b.windowDurationMins) || 0) - (Number(a.windowDurationMins) || 0));
          weekly = budgetWindows[0] || null;
          fiveHour = budgetWindows[1] || null;
        }
        if (weekly || fiveHour) {
          providerQuotas.push({ instanceId, driver, logoKey, name: pName, weekly, fiveHour });
          if (p === activeProv) activeQuotaRingId = instanceId;
        }
      }
      if (p !== activeProv) {
        for (const w of p.usageLimits.windows) {
          const item = toWinItem(w, pName, scopeKey);
          if (item) otherWindows.push(item);
        }
      }
    }

    return {
      primaryWeekly,
      primaryFiveHour: selectHudFiveHourWindow(currentWindows),
      providerQuotas,
      activeQuotaRingId,
      currentWindows,
      otherWindows,
      ctxUsed,
      ctxMax,
      ctxMaxSource: ctxMaxSource || "unknown",
      ctxPct,
      activeModelRaw,
      activeProviderRaw,
    };
  }

  function renderQuotaRowsHtml(items) {
    return items
      .map((q) => {
        const metaParts = [];
        if (q.justReset) metaParts.push(hudLang === "zh" ? "已重置" : "reset");
        else if (q.burnShort) metaParts.push(`${hudLang === "zh" ? "约" : ""}${q.burnShort}`);
        if (q.reset) metaParts.push(q.reset);
        const rstTxt = metaParts.length
          ? ` <span style="color:var(--hud-muted);font-weight:400;font-size:10px">(${escapeHtml(metaParts.join(" · "))})</span>`
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
    statsTrigger.title = t("hudStatsDetails");
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
    const contextSourceKey = {
      reported: "contextSourceReported",
      "local-catalog": "contextSourceLocalCatalog",
      estimated: "contextSourceEstimated",
      unknown: "contextSourceUnknown",
    }[qInfo.ctxMaxSource] || "contextSourceUnknown";
    const contextCapacityText = qInfo.ctxMax != null
      ? `${formatCompactTokens(qInfo.ctxMax)} · ${t(contextSourceKey)}`
      : `-- · ${t("contextSourceUnknown")}`;
    const avgCacheRate = s?.cache.withSubagentsSessionRate ?? s?.cache.sessionRate;
    const avgCacheValid = isValidHudCacheRate(avgCacheRate);
    const cachePct = avgCacheValid ? Math.min(100, Math.max(0, avgCacheRate * 100)) : 0;
    const cacheTone = !avgCacheValid ? "low" : avgCacheRate >= 0.75 ? "" : avgCacheRate >= 0.45 ? "mid" : "low";
    const avgCacheTxt =
      s && avgCacheValid ? `${(avgCacheRate * 100).toFixed(1)}%` : "--";
    const showAgyNote = qInfo.activeProviderRaw === "antigravity" || s?.provider === "antigravity";

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
      <div class="t3-ctx-heading">
        <span>${escapeHtml(t("contextMaxLabel"))}</span>
        <span style="font-weight:600;color:var(--hud-fg)">${escapeHtml(contextCapacityText)}</span>
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

  function syncHudUpdateFooter() {
    const check = popover.querySelector('[data-t3-hud-update="check"]');
    if (!check) return;
    const apply = popover.querySelector('[data-t3-hud-update="apply"]');
    const status = popover.querySelector("[data-t3-hud-update-status]");
    const releases = popover.querySelector("[data-t3-hud-update-release]");
    const { busy, availableVersion, installedVersion, recoverable, message } = hudUpdateState;
    check.setAttribute("aria-disabled", String(Boolean(busy)));
    apply.setAttribute("aria-disabled", String(Boolean(busy)));
    if (!availableVersion && document.activeElement === apply && popover.classList.contains("visible")) {
      check.focus({ preventScroll: true });
    }
    apply.hidden = !availableVersion;
    const applyLabel = recoverable ? "hudUpdateRecover" : "hudUpdateApply";
    apply.textContent = availableVersion ? t(applyLabel).replace("{version}", `v${availableVersion}`) : "";
    status.textContent = message ? t(message).replace("{version}", `v${installedVersion || ""}`) : "";
    releases.hidden = message !== "hudUpdateUnsupported";
  }

  function hudUpdateResult(result, expectedVersion, recovering) {
    if (result?.ok === true) {
      if (expectedVersion && result.currentVersion === expectedVersion) {
        if (result.status === "updated") return { message: "hudUpdateDone", installedVersion: expectedVersion };
        if (result.status === "current") return { message: recovering ? "hudUpdateRecovered" : "hudUpdateCurrent" };
      }
      if (!expectedVersion) {
        if (result.status === "current") return { message: "hudUpdateCurrent" };
        if (result.status === "unsupported") return { message: "hudUpdateUnsupported" };
        const recoverable = result.status === "recoverable";
        if ((recoverable || result.status === "available") && typeof result.availableVersion === "string" &&
            /^(0|[1-9]\d{0,6})\.(0|[1-9]\d{0,6})\.(0|[1-9]\d{0,6})$/.test(result.availableVersion)) {
          return {
            message: recoverable ? "hudUpdateInterrupted" : "hudUpdateAvailable",
            availableVersion: result.availableVersion,
            recoverable,
          };
        }
      }
    }
    if (result?.ok === false) {
      switch (result.code) {
        case "UPDATE_BUSY": return { message: "hudUpdateBusy" };
        case "UPDATE_CHANGED": return { message: "hudUpdateChanged" };
        case "UPDATE_INVALID": return { message: "hudUpdateInvalid" };
        case "HUD_UNAVAILABLE":
        case "UPDATE_UNAVAILABLE": return { message: "hudUpdateUnavailable" };
        default: return { message: expectedVersion ? "hudUpdateFailed" : "hudUpdateCheckFailed" };
      }
    }
    return { message: expectedVersion ? "hudUpdateUnconfirmed" : "hudUpdateCheckFailed" };
  }

  function emitHudUpdateState(detail) {
    if (typeof window.dispatchEvent !== "function" || typeof CustomEvent !== "function") return;
    try {
      window.dispatchEvent(new CustomEvent("t3-hud-update-state", { detail: { source: "renderer", ...detail } }));
    } catch {}
  }

  function onExternalHudUpdateState(event) {
    if (disposed) return;
    const detail = event?.detail;
    if (!detail || typeof detail !== "object" || detail.source === "renderer") return;
    if (detail.busy) {
      const recovering = detail.busyKind === "recover";
      const applying = detail.busyKind === "apply" || recovering;
      hudUpdateState = {
        busy: true,
        availableVersion: detail.availableVersion || undefined,
        recoverable: recovering,
        message: applying ? (recovering ? "hudUpdateRecovering" : "hudUpdateApplying") : "hudUpdateChecking",
      };
      syncHudUpdateFooter();
      return;
    }
    const status = detail.status;
    const semverOk = typeof detail.availableVersion === "string" &&
      /^(0|[1-9]\d{0,6})\.(0|[1-9]\d{0,6})\.(0|[1-9]\d{0,6})$/.test(detail.availableVersion);
    if (status === "current") hudUpdateState = { message: "hudUpdateCurrent" };
    else if (status === "unsupported") hudUpdateState = { message: "hudUpdateUnsupported" };
    else if (status === "available" && semverOk) {
      hudUpdateState = { message: "hudUpdateAvailable", availableVersion: detail.availableVersion, recoverable: false };
    } else if (status === "recoverable" && semverOk) {
      hudUpdateState = { message: "hudUpdateInterrupted", availableVersion: detail.availableVersion, recoverable: true };
    } else if (status === "updated") {
      hudUpdateState = { message: "hudUpdateDone", installedVersion: detail.currentVersion || "" };
    } else if (status === "recovered") {
      hudUpdateState = { message: "hudUpdateRecovered" };
    } else if (status === "error") {
      switch (detail.errorCode) {
        case "UPDATE_BUSY": hudUpdateState = { message: "hudUpdateBusy" }; break;
        case "UPDATE_CHANGED": hudUpdateState = { message: "hudUpdateChanged" }; break;
        case "UPDATE_INVALID": hudUpdateState = { message: "hudUpdateInvalid" }; break;
        case "HUD_UNAVAILABLE":
        case "UPDATE_UNAVAILABLE": hudUpdateState = { message: "hudUpdateUnavailable" }; break;
        default: hudUpdateState = { message: detail.failedAction === "apply" ? "hudUpdateFailed" : "hudUpdateCheckFailed" }; break;
      }
    } else {
      return;
    }
    syncHudUpdateFooter();
  }

  async function onHudUpdateClick(event) {
    const button = event.target.closest?.("[data-t3-hud-update]");
    if (!button || currentPopoverMode !== "stats" || !popover.classList.contains("visible")) return;
    event.stopPropagation();
    if (hudUpdateState.busy) return;
    const apply = button.getAttribute("data-t3-hud-update") === "apply";
    const expectedVersion = apply ? hudUpdateState.availableVersion : null;
    if (apply && !expectedVersion) return;
    const recovering = apply && hudUpdateState.recoverable;
    const applyMessage = recovering ? "hudUpdateRecovering" : "hudUpdateApplying";
    hudUpdateState = {
      busy: true,
      availableVersion: expectedVersion,
      recoverable: recovering,
      message: apply ? applyMessage : "hudUpdateChecking",
    };
    syncHudUpdateFooter();
    emitHudUpdateState({
      busy: true,
      busyKind: apply ? (recovering ? "recover" : "apply") : "check",
      availableVersion: expectedVersion || "",
      currentVersion: window.__t3HudReleaseVersion || "",
    });
    const action = apply ? "hub:update:apply" : "hub:update:check";
    let next;
    let rawResult = null;
    try {
      rawResult = await window.__t3HubRpc(action, apply ? { expectedVersion } : {});
      next = hudUpdateResult(rawResult, expectedVersion, recovering);
    } catch {
      next = { message: apply ? "hudUpdateUnconfirmed" : "hudUpdateConnectionFailed" };
    }
    let broadcastStatus = "error";
    if (next.message === "hudUpdateCurrent") broadcastStatus = "current";
    else if (next.message === "hudUpdateUnsupported") broadcastStatus = "unsupported";
    else if (next.message === "hudUpdateAvailable") broadcastStatus = "available";
    else if (next.message === "hudUpdateInterrupted") broadcastStatus = "recoverable";
    else if (next.message === "hudUpdateDone") broadcastStatus = "updated";
    else if (next.message === "hudUpdateRecovered") broadcastStatus = "recovered";
    const confirmedCompletion = apply && (broadcastStatus === "updated" || broadcastStatus === "recovered");
    if (disposed && !confirmedCompletion) return;
    if (!disposed) {
      hudUpdateState = next;
      syncHudUpdateFooter();
    }
    emitHudUpdateState({
      busy: false,
      busyKind: "",
      status: broadcastStatus,
      currentVersion: rawResult?.currentVersion || next.installedVersion || window.__t3HudReleaseVersion || "",
      availableVersion: next.availableVersion || (broadcastStatus === "unsupported" && typeof rawResult?.availableVersion === "string" ? rawResult.availableVersion : ""),
      releaseUrl: typeof rawResult?.releaseUrl === "string" ? rawResult.releaseUrl : "",
      errorCode: rawResult?.ok === false && typeof rawResult.code === "string" ? rawResult.code : "",
      failedAction: apply ? "apply" : "check",
    });
  }

  function renderStatsPopover() {
    popover.style.width = "324px";
    const version = window.__t3HudReleaseVersion;
    const versionHtml = typeof version === "string" && version
      ? `<div data-t3-hud-version>
          <div class="t3-pop-sec-hdr">
            <span>${escapeHtml(t("hudVersion"))}</span>
            <span class="t3-hud-version-actions">
              <span>v${escapeHtml(version)}</span>
              <button class="t3-hud-update-button" type="button" data-t3-hud-update="check">${escapeHtml(t("hudUpdateCheck"))}</button>
            </span>
          </div>
          <div class="t3-hud-update-info">
            <button class="t3-hud-update-button" type="button" data-t3-hud-update="apply" hidden></button>
            <span data-t3-hud-update-status role="status"></span>
            <a class="t3-hud-update-release" data-t3-hud-update-release href="https://github.com/kingmaozi/t3-code-hud/releases" target="_blank" rel="noopener noreferrer" hidden>${escapeHtml(t("hudUpdateReleases"))}</a>
          </div>
        </div>`
      : "";
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
        ${allQuotasHtml}
        ${versionHtml}`;
      syncHudUpdateFooter();
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

    const cacheText = (rate) => isValidHudCacheRate(rate) ? `${(rate * 100).toFixed(1)}%` : "--";
    const cacheView = resolveHudCacheDisplay(s);
    const turnCacheRateValid = isValidHudCacheRate(s.cache?.turnRate);
    const turnCache = turnCacheRateValid ? cacheText(s.cache.turnRate) : "--";
    const turnCacheNote = turnCacheRateValid ? "" : `<div style="margin-top:2px;font-size:10px;color:var(--hud-muted)">${escapeHtml(t(cacheView.kind === "session" ? "turnCacheUnavailableNote" : "cacheUnknownTitle"))}</div>`;
    const lastCallCache = cacheText(s.cache.lastCallRate);
    const mainSessionCache = cacheText(s.cache.mainSessionRate);
    const inclusiveSessionCache = cacheText(s.cache.withSubagentsSessionRate ?? s.cache.sessionRate);
    const avgSpeed = resolveModelAvgSpeed(s, qInfo.activeModelRaw);
    const speedColor = (value) => value >= 150 ? "var(--hud-cyan)" : "var(--hud-fg)";
    const formatSpeed = (value) => value != null ? `${value.toFixed(1)} tok/s` : "--";
    const liveSpeedValue = liveStreamTps != null ? liveStreamTps : (Number.isFinite(Number(s.speed.currentTurnEstimateTps)) && Number(s.speed.currentTurnEstimateTps) > 0 ? Number(s.speed.currentTurnEstimateTps) : null);
    const liveSpeedLine = liveSpeedValue != null
      ? `<div class="t3-pop-row"><span>${escapeHtml(t("streamSpeed"))}</span><span style="color:var(--hud-blue)">≈${formatSpeed(liveSpeedValue)}</span></div>`
      : "";
    const e2eLine =
      s.speed.e2eTokPerSec != null
        ? `<div class="t3-pop-row"><span>${escapeHtml(t("e2eSpeed"))}</span><span>${s.speed.e2eTokPerSec.toFixed(1)} tok/s</span></div>`
        : "";
    const subTokLine =
      s.cost.subagentCount > 0 && s.tokens.subagentTokens > 0
        ? `<div class="t3-pop-row"><span>${escapeHtml(t("mainSubPrefix"))} (${escapeHtml(s.cost.subagentCount)})</span><span>${formatCompactTokens(s.tokens.mainTotal)} / +${formatCompactTokens(s.tokens.subagentTokens)}</span></div>`
        : "";

    popover.innerHTML = `
      <div class="t3-pop-title">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(s.title || t("untitled"))}</span>
        <span style="display:flex;align-items:center;gap:6px">
          <span style="color:var(--hud-muted);font-weight:400;font-size:10.5px;flex:none">${escapeHtml(s.turnCount)} ${escapeHtml(t("rounds"))}</span>
          <button class="t3-lang-switch" type="button">${escapeHtml(langSwitchLabel())}</button>
        </span>
      </div>
      <div class="t3-pop-row"><span>${escapeHtml(t("engineModel"))}</span><span>${escapeHtml(providerBadge)}</span></div>
      <div class="t3-pop-row"><span>${escapeHtml(t("avgDecodeSpeed"))}</span><span style="color:${speedColor(avgSpeed)}">${formatSpeed(avgSpeed)}</span></div>
      <div class="t3-pop-row"><span>${escapeHtml(t("lastTurnSpeed"))}</span><span style="color:${speedColor(s.speed.lastDecodeTps)}">${formatSpeed(s.speed.lastDecodeTps)}</span></div>
      ${liveSpeedLine}
      ${e2eLine}
      <div class="t3-pop-row"><span>${escapeHtml(t("turnCacheRate"))}</span><span style="color:${cacheColor(s.cache.turnRate)}">${turnCache}</span></div>
      ${turnCacheNote}
      <div class="t3-pop-row"><span>${escapeHtml(t("lastCallCacheRate"))}</span><span style="color:${cacheColor(s.cache.lastCallRate)}">${lastCallCache}</span></div>
      <div class="t3-pop-row"><span>${escapeHtml(t("mainSessionCacheRate"))}</span><span style="color:${cacheColor(s.cache.mainSessionRate)}">${mainSessionCache}</span></div>
      <div class="t3-pop-row"><span>${escapeHtml(t("inclusiveSessionCacheRate"))}</span><span style="color:${cacheColor(s.cache.withSubagentsSessionRate ?? s.cache.sessionRate)}">${inclusiveSessionCache}</span></div>
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
          ? `<div class="t3-pop-row"><span>${escapeHtml(t("subagents"))} (${escapeHtml(s.cost.subagentCount)})</span><span style="color:var(--hud-violet)">+${formatUsd(s.cost.subagentUsd)}</span></div>
             <div class="t3-pop-row"><span>${escapeHtml(t("totalCost"))}</span><span style="font-weight:700">${formatUsd(s.cost.withSubagentsUsd)}</span></div>`
          : ""
      }
      ${allQuotasHtml}
      ${versionHtml}
    `;
    syncHudUpdateFooter();
    popover.querySelector(".t3-lang-switch")?.addEventListener("click", (e) => {
      e.stopPropagation();
      switchLang(langSwitchTarget());
    });
  }

  function renderQuotaRingCardHtml(provider) {
    if (!provider) {
      return `<div class="t3-qcard-hdr"><span class="t3-qcard-title">${escapeHtml(hudLang === "zh" ? "引擎额度" : "Provider Quota")}</span></div><div style="color:var(--hud-muted);font-size:11px">${escapeHtml(hudLang === "zh" ? "暂无额度数据" : "No quota data yet")}</div>`;
    }
    const isDualClaude = provider.logoKey === "antigravity-claude" || provider.driver === "antigravity-claude";
    const isAgyGemini = provider.instanceId === `${provider.providerInstanceId || "antigravity"}:gemini`;
    const title = isDualClaude
      ? "Antigravity · Claude / 3P"
      : isAgyGemini
        ? "Antigravity · Gemini"
        : (provider.name || provider.instanceId || "Quota");
    const badge = isDualClaude
      ? (hudLang === "zh" ? "双标独立池" : "Dual Pool")
      : isAgyGemini
        ? (hudLang === "zh" ? "Gemini 独立池" : "Gemini Pool")
        : (provider.weekly && provider.fiveHour
            ? (hudLang === "zh" ? "双环额度" : "Dual Ring")
            : (hudLang === "zh" ? "额度" : "Quota"));

    const outerLabelFor = (q) => {
      const raw = String(q.label || "").trim();
      if (!raw || q.kind === "weekly" || /weekly|周/i.test(raw)) {
        return hudLang === "zh" ? "周额度（外圈）" : "Weekly (outer)";
      }
      return hudLang === "zh" ? `${raw}（外圈）` : `${raw} (outer)`;
    };

    const innerLabelFor = (q) => {
      if (String(q.kind || "").toLowerCase() === "daily" || Number(q.windowDurationMins) === 1440) {
        return hudLang === "zh" ? "日额度（内圈）" : "Daily (inner)";
      }
      if (provider.driver === "muse" || (q.kind !== "fiveHour" && !/5\s*[-_ ]?\s*h|five\s*[-_ ]?\s*hour/i.test(String(q.label || "")))) {
        const mins = Number(q.windowDurationMins);
        if (Number.isFinite(mins) && mins > 0) {
          const hrs = mins % 60 === 0 ? `${mins / 60}` : (mins / 60).toFixed(1);
          return hudLang === "zh" ? `${hrs} 小时（内圈）` : `${hrs}h (inner)`;
        }
        const raw = String(q.label || "").trim();
        if (raw) return hudLang === "zh" ? `${raw}（内圈）` : `${raw} (inner)`;
      }
      return hudLang === "zh" ? "5 小时（内圈）" : "5-hour (inner)";
    };

    const renderWin = (q, label) => {
      const pct = Math.max(0, Math.min(100, Math.round(Number(q.remainingPct) || 0)));
      const tone = q.tone === "err" ? "err" : q.tone === "mid" ? "mid" : "ok";
      let leftMeta = "";
      if (q.justReset) {
        leftMeta = hudLang === "zh" ? "已重置" : "Just reset";
      } else if (q.burnShort) {
        const dur = String(q.burnShort).replace(/^~/, "");
        leftMeta = hudLang === "zh"
          ? (tone === "err" ? `偏快 · 约 ${dur} 触顶` : `约 ${dur} 用完`)
          : (tone === "err" ? `Fast · ~${dur} to cap` : `~${dur} left`);
      }
      const rightMeta = q.reset
        ? (hudLang === "zh" ? `${q.reset} 重置` : `Resets in ${q.reset}`)
        : "";
      const metaRow = (leftMeta || rightMeta)
        ? `<div class="t3-qcard-meta"><span>${escapeHtml(leftMeta)}</span><span>${escapeHtml(rightMeta)}</span></div>`
        : "";
      return `
        <div class="t3-qcard-win">
          <div class="t3-qcard-row">
            <span class="t3-qcard-lbl">${escapeHtml(label)}</span>
            <span class="t3-qcard-pct ${tone}">${pct}%</span>
          </div>
          <div class="t3-qcard-track"><div class="t3-qcard-fill ${tone}" style="width:${pct}%"></div></div>
          ${metaRow}
        </div>
      `;
    };

    const sections = [];
    if (provider.weekly) {
      sections.push(renderWin(provider.weekly, outerLabelFor(provider.weekly)));
    }
    if (provider.fiveHour) {
      sections.push(renderWin(provider.fiveHour, innerLabelFor(provider.fiveHour)));
    }
    return `
      <div class="t3-qcard-hdr">
        <span class="t3-qcard-title">${escapeHtml(title)}</span>
        <span class="t3-qcard-badge">${escapeHtml(badge)}</span>
      </div>
      ${sections.length ? sections.join("") : `<div style="color:var(--hud-muted);font-size:11px">${escapeHtml(hudLang === "zh" ? "暂无额度数据" : "No quota data yet")}</div>`}
    `;
  }

  function renderQuotaRingPopover(providerId) {
    popover.style.width = "276px";
    const qInfo = computeQuotaAndContext(latestStats);
    const list = Array.isArray(qInfo.providerQuotas) ? qInfo.providerQuotas : [];
    const target = list.find((p) => p.instanceId === providerId)
      || list.find((p) => p.providerInstanceId === providerId)
      || null;
    popover.innerHTML = renderQuotaRingCardHtml(target);
  }

  function showPopoverAbove(anchorEl, mode, providerId = null) {
    currentPopoverMode = mode;
    currentPopoverProvider = mode === "quota" ? providerId : null;
    if (mode === "context") renderContextRingPopover();
    else if (mode === "quota") renderQuotaRingPopover(providerId);
    else renderStatsPopover();
    const popW = mode === "context" ? 268 : mode === "quota" ? 276 : 324;
    const anchorRect = anchorEl.getBoundingClientRect();
    const centerX = anchorRect.left + anchorRect.width / 2;
    const leftPos = Math.max(12, Math.min(window.innerWidth - popW - 14, Math.round(centerX - popW / 2)));
    popover.style.left = `${leftPos}px`;
    if (anchorRect.top > 260) {
      popover.style.top = "auto";
      popover.style.bottom = `${Math.round(window.innerHeight - anchorRect.top + 8)}px`;
      popover.style.maxHeight = `${Math.floor(anchorRect.top - 20)}px`;
    } else {
      popover.style.bottom = "auto";
      popover.style.top = `${Math.round(anchorRect.bottom + 6)}px`;
      popover.style.maxHeight = `${Math.max(0, Math.floor(window.innerHeight - anchorRect.bottom - 18))}px`;
    }
    popover.classList.add("visible");
    window.dispatchEvent(new CustomEvent("t3-hud-popover-change", { detail: { visible: true } }));
  }

  function hidePopoverDelayed() {
    clearTimeout(popoverHideTimer);
    popoverHideTimer = setTimeout(() => {
      if (!popover.matches(":hover") && !popover.contains(document.activeElement)) {
        popover.classList.remove("visible");
        window.dispatchEvent(new CustomEvent("t3-hud-popover-change", { detail: { visible: false } }));
      }
    }, 140);
  }

  root.querySelectorAll("[data-hud-hover]").forEach((el) => {
    const mode = el.getAttribute("data-hud-hover");
    el.addEventListener("mouseenter", () => {
      clearTimeout(popoverHideTimer);
      showPopoverAbove(el, mode);
    });
    el.addEventListener("mouseleave", () => hidePopoverDelayed());
    el.addEventListener("focus", () => { clearTimeout(popoverHideTimer); showPopoverAbove(el, mode); });
    el.addEventListener("blur", () => hidePopoverDelayed());
  });
  // Provider buttons are updated dynamically; keep hover and keyboard focus
  // behavior attached to the stable parent rather than to replaced children.
  quotaRings.addEventListener("mouseover", (event) => {
    const button = event.target.closest?.(".t3-hud-quota-ring");
    if (!button || button.contains(event.relatedTarget)) return;
    clearTimeout(popoverHideTimer);
    showPopoverAbove(button, "quota", button.getAttribute("data-hud-provider"));
  });
  quotaRings.addEventListener("mouseout", (event) => {
    const button = event.target.closest?.(".t3-hud-quota-ring");
    if (button && !button.contains(event.relatedTarget)) hidePopoverDelayed();
  });
  quotaRings.addEventListener("focusin", (event) => {
    const button = event.target.closest?.(".t3-hud-quota-ring");
    if (!button) return;
    clearTimeout(popoverHideTimer);
    showPopoverAbove(button, "quota", button.getAttribute("data-hud-provider"));
  });
  quotaRings.addEventListener("focusout", (event) => {
    const button = event.target.closest?.(".t3-hud-quota-ring");
    if (button && !button.contains(event.relatedTarget)) hidePopoverDelayed();
  });
  quotaRings.addEventListener("click", (event) => {
    const button = event.target.closest?.(".t3-hud-quota-ring");
    if (!button) return;
    clearTimeout(popoverHideTimer);
    showPopoverAbove(button, "quota", button.getAttribute("data-hud-provider"));
  });
  popover.addEventListener("mouseenter", () => clearTimeout(popoverHideTimer));
  popover.addEventListener("mouseleave", () => hidePopoverDelayed());
  popover.addEventListener("focusin", () => clearTimeout(popoverHideTimer));
  popover.addEventListener("focusout", () => hidePopoverDelayed());
  popover.addEventListener("click", onHudUpdateClick);
  statsTrigger.addEventListener("click", () => {
    showPopoverAbove(statsTrigger, "stats");
    const control = popover.querySelector('[data-t3-hud-update="check"]') || popover.querySelector(".t3-lang-switch");
    control?.focus();
  });

  gitLangBtn?.addEventListener("click", () => switchLang(langSwitchTarget()));

  // Provider artwork follows the icons shipped with T3 Code.
  const HUD_PROVIDER_LOGOS = {"codex":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"100 100 411 411\" fill=\"currentColor\"><path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M252.794 108.802C289.191 99.0484 326.265 110.305 351.148 135.135C385.113 126.072 422.85 134.862 449.492 161.505C476.136 188.149 484.925 225.888 475.862 259.85V259.854C500.696 284.735 511.95 321.81 502.198 358.207C492.447 394.602 464.161 421.084 430.215 430.217C421.083 464.162 394.603 492.448 358.206 502.199C321.812 511.951 284.734 500.693 259.852 475.864C225.887 484.927 188.15 476.137 161.507 449.495C134.864 422.851 126.073 385.111 135.136 351.149C110.304 326.266 99.0496 289.192 108.801 252.795C118.552 216.4 146.84 189.918 180.784 180.785C189.917 146.841 216.396 118.553 252.794 108.802ZM374.292 407.145C374.292 411.271 372.092 415.086 368.517 417.148L283.723 466.102C302.487 480.585 327.555 486.459 352.217 479.852C386.997 470.532 410.068 439.312 410.555 405.006V317.717C410.555 315.08 409.125 312.621 406.843 311.303L374.292 292.509V407.145ZM251.868 415.897C248.296 417.959 243.893 417.959 240.317 415.897L155.526 366.942C152.366 390.436 159.811 415.08 177.866 433.136H177.863C203.325 458.594 241.896 462.962 271.85 446.232L347.449 402.586C349.735 401.268 351.148 398.8 351.148 396.163V358.579L251.868 415.897ZM368.602 220.628C366.319 219.309 363.474 219.318 361.191 220.637L328.641 239.431L427.921 296.749C431.496 298.811 433.697 302.627 433.697 306.752V404.661C455.622 395.654 473.244 376.881 479.851 352.218C489.169 317.442 473.668 281.85 444.201 264.274L368.602 220.628ZM177.303 206.34C155.377 215.348 137.756 234.122 131.148 258.783C121.832 293.561 137.331 329.153 166.799 346.727L242.398 390.373C244.68 391.692 247.525 391.684 249.807 390.366L282.357 371.572L183.078 314.253C179.504 312.189 177.303 308.375 177.303 304.251V206.34ZM259.849 279.145V331.858L305.5 358.213L351.15 331.858V279.145L305.5 252.789L259.849 279.145ZM327.276 144.9C308.512 130.418 283.445 124.543 258.782 131.15C224.002 140.471 200.931 171.691 200.445 205.995V293.286C200.445 295.923 201.875 298.381 204.158 299.7L236.707 318.493V203.856C236.707 199.731 238.909 195.916 242.483 193.853L327.276 144.9ZM433.137 177.867C407.675 152.407 369.103 148.038 339.149 164.769L263.55 208.415C261.265 209.734 259.852 212.202 259.852 214.838V252.423L359.132 195.105C362.703 193.041 367.108 193.041 370.682 195.105L455.473 244.06C458.635 220.567 451.189 195.922 433.135 177.867H433.137Z\"/></svg>","openai":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"100 100 411 411\" fill=\"currentColor\"><path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M252.794 108.802C289.191 99.0484 326.265 110.305 351.148 135.135C385.113 126.072 422.85 134.862 449.492 161.505C476.136 188.149 484.925 225.888 475.862 259.85V259.854C500.696 284.735 511.95 321.81 502.198 358.207C492.447 394.602 464.161 421.084 430.215 430.217C421.083 464.162 394.603 492.448 358.206 502.199C321.812 511.951 284.734 500.693 259.852 475.864C225.887 484.927 188.15 476.137 161.507 449.495C134.864 422.851 126.073 385.111 135.136 351.149C110.304 326.266 99.0496 289.192 108.801 252.795C118.552 216.4 146.84 189.918 180.784 180.785C189.917 146.841 216.396 118.553 252.794 108.802ZM374.292 407.145C374.292 411.271 372.092 415.086 368.517 417.148L283.723 466.102C302.487 480.585 327.555 486.459 352.217 479.852C386.997 470.532 410.068 439.312 410.555 405.006V317.717C410.555 315.08 409.125 312.621 406.843 311.303L374.292 292.509V407.145ZM251.868 415.897C248.296 417.959 243.893 417.959 240.317 415.897L155.526 366.942C152.366 390.436 159.811 415.08 177.866 433.136H177.863C203.325 458.594 241.896 462.962 271.85 446.232L347.449 402.586C349.735 401.268 351.148 398.8 351.148 396.163V358.579L251.868 415.897ZM368.602 220.628C366.319 219.309 363.474 219.318 361.191 220.637L328.641 239.431L427.921 296.749C431.496 298.811 433.697 302.627 433.697 306.752V404.661C455.622 395.654 473.244 376.881 479.851 352.218C489.169 317.442 473.668 281.85 444.201 264.274L368.602 220.628ZM177.303 206.34C155.377 215.348 137.756 234.122 131.148 258.783C121.832 293.561 137.331 329.153 166.799 346.727L242.398 390.373C244.68 391.692 247.525 391.684 249.807 390.366L282.357 371.572L183.078 314.253C179.504 312.189 177.303 308.375 177.303 304.251V206.34ZM259.849 279.145V331.858L305.5 358.213L351.15 331.858V279.145L305.5 252.789L259.849 279.145ZM327.276 144.9C308.512 130.418 283.445 124.543 258.782 131.15C224.002 140.471 200.931 171.691 200.445 205.995V293.286C200.445 295.923 201.875 298.381 204.158 299.7L236.707 318.493V203.856C236.707 199.731 238.909 195.916 242.483 193.853L327.276 144.9ZM433.137 177.867C407.675 152.407 369.103 148.038 339.149 164.769L263.55 208.415C261.265 209.734 259.852 212.202 259.852 214.838V252.423L359.132 195.105C362.703 193.041 367.108 193.041 370.682 195.105L455.473 244.06C458.635 220.567 451.189 195.922 433.135 177.867H433.137Z\"/></svg>","muse":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 287.56 191\" fill=\"none\"><defs><linearGradient id=\"muse-a\" x1=\"61\" y1=\"117\" x2=\"259\" y2=\"127\" gradientUnits=\"userSpaceOnUse\"><stop offset=\"0\" stop-color=\"#0064e1\"/><stop offset=\".4\" stop-color=\"#0064e1\"/><stop offset=\".83\" stop-color=\"#0073ee\"/><stop offset=\"1\" stop-color=\"#0082fb\"/></linearGradient><linearGradient id=\"muse-b\" x1=\"45\" y1=\"139\" x2=\"45\" y2=\"66\" gradientUnits=\"userSpaceOnUse\"><stop offset=\"0\" stop-color=\"#0082fb\"/><stop offset=\"1\" stop-color=\"#0064e0\"/></linearGradient></defs><path fill=\"#0081fb\" d=\"m31.06,125.96c0,10.98 2.41,19.41 5.56,24.51 4.13,6.68 10.29,9.51 16.57,9.51 8.1,0 15.51-2.01 29.79-21.76 11.44-15.83 24.92-38.05 33.99-51.98l15.36-23.6c10.67-16.39 23.02-34.61 37.18-46.96 11.56-10.08 24.03-15.68 36.58-15.68 21.07,0 41.14,12.21 56.5,35.11 16.81,25.08 24.97,56.67 24.97,89.27 0,19.38-3.82,33.62-10.32,44.87-6.28,10.88-18.52,21.75-39.11,21.75l0-31.02c17.63,0 22.03-16.2 22.03-34.74 0-26.42-6.16-55.74-19.73-76.69-9.63-14.86-22.11-23.94-35.84-23.94-14.85,0-26.8,11.2-40.23,31.17-7.14,10.61-14.47,23.54-22.7,38.13l-9.06,16.05c-18.2,32.27-22.81,39.62-31.91,51.75-15.95,21.24-29.57,29.29-47.5,29.29-21.27,0-34.72-9.21-43.05-23.09-6.8-11.31-10.14-26.15-10.14-43.06z\"/><path fill=\"url(#muse-a)\" d=\"m24.49,37.3c14.24-21.95 34.79-37.3 58.36-37.3 13.65,0 27.22,4.04 41.39,15.61 15.5,12.65 32.02,33.48 52.63,67.81l7.39,12.32c17.84,29.72 27.99,45.01 33.93,52.22 7.64,9.26 12.99,12.02 19.94,12.02 17.63,0 22.03-16.2 22.03-34.74l27.4-.86c0,19.38-3.82,33.62-10.32,44.87-6.28,10.88-18.52,21.75-39.11,21.75-12.8,0-24.14-2.78-36.68-14.61-9.64-9.08-20.91-25.21-29.58-39.71l-25.79-43.08c-12.94-21.62-24.81-37.74-31.68-45.04-7.39-7.85-16.89-17.33-32.05-17.33-12.27,0-22.69,8.61-31.41,21.78z\"/><path fill=\"url(#muse-b)\" d=\"m82.35,31.23c-12.27,0-22.69,8.61-31.41,21.78-12.33,18.61-19.88,46.33-19.88,72.95 0,10.98 2.41,19.41 5.56,24.51l-26.48,17.44c-6.8-11.31-10.14-26.15-10.14-43.06 0-30.75 8.44-62.8 24.49-87.55 14.24-21.95 34.79-37.3 58.36-37.3z\"/></svg>","antigravity":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><image href=\"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAIKADAAQAAAABAAAAIAAAAACshmLzAAAGPElEQVRYCcVXbYidxRU+Z2be73u3G9JUsQ0EtXGNaZtWGyKtdRuJWEVRaegfK6Kl4g8Ff9TEWOhCo2lLE/pDWrXW/GgsrYJCCc2Psn4QE02IKKn4hWLElDTIxmT37r3vOzPnHM+Vpppd1/2I0IGX+84wM88z5zznmfcC/J8bLhT/xMMXnItjsAKOGwMT8PrA/f96fSF7zZvAO08OLbPRbknH5crkGA7YY1bMuJuw4+YpW2cb88f3vDEfIvMicGD0wnOSIDvLngzhmDTJB0jZCUvpCYNuHCvbM4dcwGuyJ/e+MlcScyawd+/FRe3NTlfD2qQjE8kJ4WwcuTwOkh1HzDuIySS0rIcXq164HHftG58LCTeXSf05R6T9ExRYiwzjiUBMEahE4WAFqgSQnNg8kU4aeHUndbfrknvnsvecIvDo7qsW1Zi+wI1ZCj2s3STGbBKpmpD+A60JwlaHbNklW3QpSz2PZURrWn8fPTobiTlFYMx+4WoK+NUmJhNAjlEsZ2CoMsCVIWgsQXRByHqhxENB8SwGvk7BHzhtAiMyYiaeO3yDgrOnFIiyfrxBIw6FoLSQpLEBvAsQkhoCNcjcNNH79TI8/DA+80z8LBKzRqDZfWSoptaans98TaVEJQCcgqMEckCoDYO3UYJtmNJGCXSZuFdX0v3Gq4uLryn4S6dFoBcHrwict7sh79ZNhSGUIDFDqyRSNqZBoWCipkBPH3vg065E6XKUyVZu/LrTJtCJ1eV1qKTxldS+ghgqFCWBMbGJWAqAJmLoRwAprYFhUqj/4GQoQ3dYYOS3CCM8UxQ+MwU3jm7+8mS3+mbt26H2LQVvQ/BKIBZGCxEStkBgkFUDpCJkqbVKK4zQxYidMGA7K/9xCy+FP8G7CyLQmVh0cZRyifet2vfBYxtIwSXkqoNcxWYNiQgjixh9NA2MJRL2QAtSYiwXF2m9RsEXRqAXB9ZS1Lz7lgQlQEE1HwvQ02sBpqiICg+gBiWAAcRmIpiBYA5sco1KYSpuLlUCf5spAjMa0fD27Tlkgy+wb63U0DekGuBYAXMuegOoFxo0WopGK8EpgRRYMiCp2EMlnlvcwAD1korrN5e4o5fcOnJ199NIzKiBxpxxvkr6XPFt3wcWavXBPzq9SKq1aNR+sNFjS0TFVgII0jPGalCcAZuy2JQi52f3uFih4AfmRcDH8vuG80pC1VVwAcq14DILkjgF/aee/nESfA1AJSB2ORlzvQe5ClGNAZxyCipOx2JclUreT8M8CGgm40P715lYRqAW40lwSknB73ypzh6EERX8x22fvv75u7+WH6sh3w+IhVZnALA67CiHcJmKZRuiqmVK+1QNrHzwwDkmpnuRWqXeeWq9qUXOUhF7x8sb8t9P2eOU7iW/am6wmGxPUE1bmDIkdczYQaq/s+PuL711ymTtmKkD/b4uW8dUDjIVDOr/qvgCyPxlNvD+2t0bsx1amn+M6LIGranB6QWaLA5p1XfFaW06gZGnnYTses25ukvSB9ecu3fJyKZpq2caYPOLwPJ2FEw9WlQS3Ejyw+ERmSb6aQRWfHHZhSD5Kj25B+4TMFrcZuvBDeXhmfCmju/ehO9rhWyJxhjPoJe0iY3g6nYbLpo6dxoB9uZmo98UwJmqO01VdPvFHntk6sLZ+oMF7IgMewhNGgTVpmzhmX86dd0pBM773XtfV9B1+tRaZgaUubC55+DPzpycunC2/q47sGGJG1UPdQS0GongBa4d/o2s+uTajwk8JtaKu9NwUiA7NRVXqtf94eA9yegnF8znfd/G5Dmt6G1sIFHPANVEW33j5+vXq4X+t/2PwPmHj96kwN9DSRojSQFsn+3B8V+enLjQ31DDvUQwSgh5FPBK4sr/XMS3ndzvIx8Y2nbkUstuq+GsheIGjbj31PHWv3w3Hjo58XR+v71ZlqKDXbrHBWrUHTR6XwPftmeDewKHtr6/XL+st6mdf0XDv0hzf8iy3PripmxBf7VmIrr6PlmuWfirpmCVQRw3ImN6wdxsLNvbjeRnGrZWw74zmORHnzd4n9T+Tfim3hI/UEt+hPTTgQCWMNq7cNWWD5axLbX28d8H70r2qY9P8+uZTrXQ8W9tljXOwdl6VTy/0D0+t3UfAoMJQboJ7md2AAAAAElFTkSuQmCC\" width=\"32\" height=\"32\"/></svg>"};

  const HUD_CLAUDE_LOGO = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\"><g transform=\"translate(12 12)\" stroke=\"#d97757\" stroke-width=\"2.1\" stroke-linecap=\"round\"><line x1=\"0\" y1=\"-7.5\" x2=\"0\" y2=\"7.5\"/><line x1=\"-7.5\" y1=\"0\" x2=\"7.5\" y2=\"0\"/><line x1=\"-5.3\" y1=\"-5.3\" x2=\"5.3\" y2=\"5.3\"/><line x1=\"-5.3\" y1=\"5.3\" x2=\"5.3\" y2=\"-5.3\"/></g></svg>";
  const HUD_AGY_CLAUDE_DUAL_LOGO = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\"><defs><linearGradient id=\"t3-agy-dual\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"1\"><stop offset=\"0%\" stop-color=\"#ea4335\"/><stop offset=\"48%\" stop-color=\"#fbbc05\"/><stop offset=\"100%\" stop-color=\"#4285f4\"/></linearGradient></defs><path d=\"M2.4 14.8C5.1 13.8 6.9 4.8 8.9 4.8s3.3 9 5.6 10\" stroke=\"url(#t3-agy-dual)\" stroke-width=\"2.5\" stroke-linecap=\"round\"/><circle cx=\"15.8\" cy=\"14.8\" r=\"5.8\" fill=\"var(--hud-bg, #ffffff)\"/><g transform=\"translate(15.8 14.8)\" stroke=\"#d97757\" stroke-width=\"1.7\" stroke-linecap=\"round\"><line x1=\"0\" y1=\"-4.4\" x2=\"0\" y2=\"4.4\"/><line x1=\"-4.4\" y1=\"0\" x2=\"4.4\" y2=\"0\"/><line x1=\"-3.1\" y1=\"-3.1\" x2=\"3.1\" y2=\"3.1\"/><line x1=\"-3.1\" y1=\"3.1\" x2=\"3.1\" y2=\"-3.1\"/></g></svg>";
  const HUD_OPENCODE_LOGO = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\"><path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M4.5 2h15v20h-15V2zm3.8 3.8v12.4h7.4V5.8H8.3z\" fill=\"currentColor\"/><rect x=\"8.3\" y=\"11.4\" width=\"7.4\" height=\"6.8\" fill=\"currentColor\" fill-opacity=\"0.3\"/></svg>";
  const HUD_DEVIN_LOGO = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"currentColor\"><polygon points=\"7.8,1.4 12.1,3.9 12.1,8.8 7.8,11.3 3.5,8.8 3.5,3.9\"/><polygon points=\"7.8,12.7 12.1,15.2 12.1,20.1 7.8,22.6 3.5,20.1 3.5,15.2\"/><polygon points=\"15.8,7.1 20.1,9.6 20.1,14.5 15.8,17.0 11.5,14.5 11.5,9.6\"/></svg>";
  HUD_PROVIDER_LOGOS.claude = HUD_CLAUDE_LOGO;
  HUD_PROVIDER_LOGOS.claudeagent = HUD_CLAUDE_LOGO;
  HUD_PROVIDER_LOGOS["antigravity-claude"] = HUD_AGY_CLAUDE_DUAL_LOGO;
  HUD_PROVIDER_LOGOS.opencode = HUD_OPENCODE_LOGO;
  HUD_PROVIDER_LOGOS["opencode-go"] = HUD_OPENCODE_LOGO;
  HUD_PROVIDER_LOGOS.opencodego = HUD_OPENCODE_LOGO;
  HUD_PROVIDER_LOGOS.devin = HUD_DEVIN_LOGO;
  HUD_PROVIDER_LOGOS.acpregistry_devin = HUD_DEVIN_LOGO;

  function hudQuotaRingMarkup(provider) {
    const description = (quota, label) => quota && `${label}: ${quota.remainingPct}% ${hudLang === "zh" ? "剩余" : "remaining"}${quota.reset ? ` · ${quota.reset}` : ""}`;
    const parts = [provider.name, description(provider.weekly, hudLang === "zh" ? "周额度（外圈）" : "Weekly quota (outer)"), description(provider.fiveHour, hudLang === "zh" ? "5 小时额度（内圈）" : "5-hour quota (inner)")].filter(Boolean);
    const arc = (quota, kind, radius) => {
      if (!quota || !Number.isFinite(quota.remainingPct)) return "";
      const circumference = 2 * Math.PI * radius;
      const offset = circumference * (1 - Math.max(0, Math.min(100, quota.remainingPct)) / 100);
      const color = quota.tone === "err" ? "#dc2626" : quota.tone === "mid" ? "#d97706" : "#10a37f";
      return `<circle cx="16" cy="16" r="${radius}" fill="none" stroke="color-mix(in srgb, var(--hud-fg) 14%, transparent)" stroke-width="2"/><circle class="quota-arc quota-${kind}-arc" cx="16" cy="16" r="${radius}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-dasharray="${circumference.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"/>`;
    };
    const key = String(provider.logoKey || provider.driver || provider.instanceId || "").toLowerCase();
    const logo = HUD_PROVIDER_LOGOS[key] || escapeHtml(String(provider.name || "?").slice(0, 1).toUpperCase());
    const dualClass = key === "antigravity-claude" ? " is-dual" : "";
    const text = escapeHtml(parts.join(" · "));
    return `<button class="t3-hud-quota-ring" type="button" data-hud-provider="${escapeHtml(provider.instanceId)}" title="${text}" aria-label="${text}"><svg viewBox="0 0 32 32" aria-hidden="true">${arc(provider.weekly, "week", 13.5)}${arc(provider.fiveHour, "five", 9.5)}</svg><span class="t3-hud-provider-logo${dualClass}" aria-hidden="true">${logo}</span></button>`;
  }

  let lastQuotaRingsSig = "";
  function renderQuotaRing(providers, activeQuotaRingId) {
    const signature = JSON.stringify([hudLang, providers]);
    if (signature !== lastQuotaRingsSig) {
      lastQuotaRingsSig = signature;
      const activeButton = document.activeElement?.closest?.(".t3-hud-quota-ring");
      const activeProvider = activeButton && quotaRings.contains(activeButton) ? activeButton.getAttribute("data-hud-provider") : null;
      quotaRings.innerHTML = providers.map(hudQuotaRingMarkup).join("");
      if (activeProvider != null) {
        const replacement = [...quotaRings.children].find((button) => button.getAttribute("data-hud-provider") === activeProvider);
        try { replacement?.focus({ preventScroll: true }); } catch { replacement?.focus(); }
      }
    }
    const primary = providers.find((provider) => provider.instanceId === activeQuotaRingId);
    const activeProvider = primary?.providerInstanceId || primary?.instanceId;
    [...quotaRings.children].forEach((button, index) => {
      const provider = providers[index];
      button.toggleAttribute("data-hud-quota-active", (provider.providerInstanceId || provider.instanceId) === activeProvider);
      button.toggleAttribute("data-hud-quota-primary", provider === primary);
    });
  }

  let lastTopbarSig = "";
  function renderTopbarStats(stats) {
    latestStats = stats;
    // Reset route state before taking an idle snapshot, so resolve does not erase the new baseline.
    if (turnSpeedState.route !== String(currentPathHint || "")) {
      resolveHudTurnSpeed(turnSpeedState, { ok: false }, null, currentPathHint);
      resetLiveStreamSampler(currentPathHint);
    }
    const nextProvider = String(stats?.provider || "");
    const samplerProvider = String(streamSampler?.provider || "");
    const providerChanged = Boolean(
      nextProvider && (
        (turnSpeedState.baselineProvider && turnSpeedState.baselineProvider !== nextProvider) ||
        (samplerProvider && samplerProvider !== nextProvider)
      )
    );
    if (!(stats?.ok && stats.isRunning) || providerChanged) {
      // Capture the final DOM synchronously: a new turn can start before the next sampler tick.
      if (providerChanged || turnSpeedState.active || liveStreamTps != null || streamSampler.samples.length > 0) clearActiveStreamSamples();
      const idleSnapshot = getAssistantStreamSnapshot(document.querySelector("[data-chat-column]"));
      turnSpeedState.baselineMessageId = String(idleSnapshot?.messageId || "");
      turnSpeedState.baselineCaptured = true;
      turnSpeedState.baselineProvider = nextProvider;
      lastIdleMessageId = String(idleSnapshot?.messageId || "");
      lastIdleTextLen = idleSnapshot?.text.length || 0;
    } else if (!turnSpeedState.baselineProvider && nextProvider) {
      turnSpeedState.baselineProvider = nextProvider;
    }
    const samplerMessageId = streamSampler?.messageId ? String(streamSampler.messageId) : "";
    const baselineMessageId = turnSpeedState.baselineMessageId ? String(turnSpeedState.baselineMessageId) : "";
    const baselineProvider = turnSpeedState.baselineProvider ? String(turnSpeedState.baselineProvider) : "";
    const statsProvider = nextProvider;
    const activeSamplerProvider = streamSampler?.provider ? String(streamSampler.provider) : "";
    const liveSampleConfirmedNewTurn = Boolean(
      turnSpeedState.baselineCaptured === true && samplerMessageId !== "" &&
        samplerMessageId !== baselineMessageId &&
        streamSampler.liveTps != null && streamSampler.messageId === samplerMessageId &&
        (!baselineProvider || !statsProvider || baselineProvider === statsProvider) &&
        (!activeSamplerProvider || !statsProvider || activeSamplerProvider === statsProvider)
    );
    const speedView = resolveHudTurnSpeed(turnSpeedState, stats, liveStreamTps, currentPathHint, {
      messageId: samplerMessageId,
      liveSampleConfirmedNewTurn,
    });
    if (speedView.routeChanged) {
      resetLiveStreamSampler(currentPathHint);
    } else if (speedView.started && stats?.isRunning) {
      // First frame of a new turn: keep only a sampler proven to be from a new
      // assistant message of this turn; otherwise drop any stale live rate.
      if (liveStreamTps != null && !liveSampleConfirmedNewTurn) {
        clearActiveStreamSamples();
      } else if (liveStreamTps == null) {
        clearActiveStreamSamples();
      }
    }
    const qInfo = computeQuotaAndContext(stats);
    const sessionSpeed = resolveHudSessionSpeed(sessionSpeedState, stats, currentPathHint);
    renderQuotaRing(qInfo.providerQuotas, qInfo.activeQuotaRingId);
    refreshExternalQuotas();
    refreshRemoteExternalQuotas();

    let nextDotClass;
    let nextSpeed;
    let nextCache;
    let nextCacheLabel = t("cache");
    let nextCacheTitle = "";
    let nextCacheColor = "var(--hud-fg)";
    let nextTokens;
    let nextCost;
    const ctxPctNum = qInfo.ctxPct != null ? Math.round(qInfo.ctxPct) : null;
    const nextCtxTxt = ctxPctNum != null ? `${ctxPctNum}%` : "--";
    const nextRingOffset = (RING_CIRC * (1 - Math.max(0, Math.min(100, qInfo.ctxPct || 0)) / 100)).toFixed(2);
    const nextRingColor = contextColor(qInfo.ctxPct);
    let nextBranch = t(window.innerWidth < 640 ? "graph" : "gitGraph");
    let hideDirty = false;
    const speedLabel = sessionSpeed.kind === "average" ? (hudLang === "zh" ? "均速 " : "Avg ") :
      sessionSpeed.kind === "last" ? (hudLang === "zh" ? "末轮 " : "Last ") : "";
    nextSpeed = sessionSpeed.value == null ? "-- tok/s" : `${sessionSpeed.value.toFixed(1)} tok/s`;

    if (!stats || !stats.ok) {
      nextDotClass = "t3-hud-dot";
      nextCache = "--%";
      nextTokens = "0 tok";
      nextCost = "$0.00";
      hideDirty = true;
    } else {
      const activelyStreaming = Boolean(stats.isRunning) || speedView.kind === "estimated";
      nextDotClass = "t3-hud-dot " + (activelyStreaming ? "running" : "ready");
      const cacheView = resolveHudCacheDisplay(stats);
      nextCache = cacheView.rate != null ? `${Math.round(cacheView.rate * 100)}%` : "--%";
      if (cacheView.kind === "session") {
        nextCacheLabel = t("cacheSessionShort");
        nextCacheTitle = t("cacheSessionTitle");
      } else if (cacheView.kind === "unknown") {
        nextCacheTitle = t("cacheUnknownTitle");
      }
      nextCacheColor = cacheColor(cacheView.rate);
      nextTokens = `${formatCompactTokens(stats.tokens.total)} tok`;
      const totalUsd = stats.cost.withSubagentsUsd;
      const subSuffix = stats.cost.subagentCount > 0 ? `<span class="t3-hud-sub-badge">(+${escapeHtml(stats.cost.subagentCount)}${escapeHtml(t("sub"))})</span>` : "";
      nextCost = `${formatUsd(totalUsd)}${subSuffix}`;
    }

    const sig = `${nextDotClass}|${speedLabel}${nextSpeed}|${nextCacheLabel}|${nextCache}|${nextCacheTitle}|${nextCacheColor}|${nextTokens}|${nextCost}|${nextCtxTxt}|${nextRingOffset}|${nextRingColor}|${nextBranch}|${hideDirty}|${hudLang}`;
    if (sig !== lastTopbarSig) {
      lastTopbarSig = sig;
      dotEl.className = nextDotClass;
      speedEl.textContent = nextSpeed;
      speedLabelEl.textContent = sessionSpeed.value == null ? "" : speedLabel;
      speedEl.style.color = "var(--hud-fg)";
      cacheLblEl.textContent = nextCacheLabel;
      cacheEl.textContent = nextCache;
      cacheEl.style.color = nextCacheColor;
      cacheEl.title = nextCacheTitle;
      cacheEl.setAttribute("aria-label", nextCacheTitle || nextCache);
      tokensEl.textContent = nextTokens;
      costEl.innerHTML = nextCost;
      contextControl.setAttribute("aria-label", `${t("contextCapacity")}: ${nextCtxTxt}`);
      contextControl.title = `${t("contextCapacity")}: ${nextCtxTxt}`;
      ringArcEl.setAttribute("stroke-dashoffset", nextRingOffset);
      ringArcEl.style.stroke = nextRingColor;
      branchBtnText.textContent = nextBranch;
      if (hideDirty) dirtyBadge.style.display = "none";
    }

    updateLayoutPosition();
    if (popover.classList.contains("visible") && currentPopoverMode === "quota" && currentPopoverProvider) {
      renderQuotaRingPopover(currentPopoverProvider);
    } else {
      refreshHudStatsPopover(popover, currentPopoverMode, document.activeElement, renderStatsPopover);
    }
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
      ? `<circle cx="${cx}" cy="${midY}" r="5.5" fill="var(--git-lane-bg)" stroke="#5d5d5d" stroke-width="1.5" /><circle cx="${cx}" cy="${midY}" r="2.6" fill="#5d5d5d" />`
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
    } else if (wt) {
      statusBadgeEl.textContent = t("cleanStatus");
      statusBadgeEl.title = t("workingClean");
      dirtyBadge.style.display = "none";
    } else {
      statusBadgeEl.textContent = "--";
      statusBadgeEl.title = "";
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

    const historyText = latestGraph.partialHistory
      ? latestGraph.historyScope === "repo-activity"
        ? (hudLang === "en" ? "Recent repository activity may include other branches; relationships are unknown." : "最近仓库活动可能包含其他分支；提交关系未知。")
        : (hudLang === "en" ? "Showing available history; commit relationships may be unknown." : "显示当前可用历史；提交之间的关系可能未知。")
      : latestGraph.firstParentOnly ? (hudLang === "en" ? "Remote history follows first parents; merge connections may be incomplete." : "远端提交历史；合并分支的连线可能不完整。") : "";
    const historyNotice = historyText ? `<div class="t3-empty-msg">${escapeHtml(historyText)}</div>` : "";
    gitListEl.innerHTML = header + historyNotice + commits.map((c) => {
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

  // Remote Git bundle over the T3 Connect WebSocket relay: pulls the raw git
  // metadata files out of the remote repo and lets the backend assemble them.
  async function fetchRemoteGitBundle(envId, cwd, branch, options = {}) {
    if (typeof window.__t3HudRemoteRpc !== "function" || !envId || !cwd) return null;
    const identity = JSON.stringify([envId, cwd, branch || "", options.threadId || ""]);
    const inFlight = fetchRemoteGitBundle.inFlight ||= new Map();
    if (inFlight.has(identity)) return inFlight.get(identity);
    const work = (async () => {
      const rpc = (tag, payload) => window.__t3HudRemoteRpc(envId, tag, payload, 4500)
        .then((result) => result?.ok ? result.value : null).catch(() => null);
      const readFile = (relativePath) => rpc("projects.readFile", { cwd, relativePath, allowMissing: true });
      const toText = (value) => {
        if (typeof value === "string") return value;
        if (value && typeof value === "object" && !value.truncated && value.exists !== false) return value.contents ?? value.content ?? value.text ?? value.fileContent ?? null;
        return null;
      };
      const [headRaw, packedRaw, logRaw, configRaw, refs, status, branchResult] = await Promise.all([
        readFile(".git/HEAD"), readFile(".git/packed-refs"), readFile(".git/logs/HEAD"), readFile(".git/config"),
        rpc("vcs.listRefs", { cwd, limit: 50 }), rpc("vcs.refreshStatus", { cwd }),
        rpc("review.getBranchCommits", { cwd }),
      ]);
      let branchCommits = branchResult;
      if (!toText(logRaw) && (!Array.isArray(branchResult?.commits) || !branchResult.commits.length)) {
        const range = await rpc("review.getBranchCommits", { cwd, baseRef: "HEAD~1" });
        if (Array.isArray(range?.commits) && range.commits.length) branchCommits = range;
      }
      // Existing reflog/branch rows are displayed as partial history. Reflog
      // entries are never treated as parent edges; no per-commit requests run
      // until a user opens a commit's detail.
      const bundle = {
        environmentId: envId, cwd, branch: branch || null,
        gitConfig: null, gitHead: toText(headRaw), packedRefs: toText(packedRaw), headLog: toText(logRaw),
        vcsRefs: refs ?? null, vcsStatus: status ?? null, branchCommits: branchCommits ?? null,
        nativeCommits: [], nativeHistoryTruncated: true,
      };
      // Reflogs can outlive or be edited independently of the actual ref.
      // Only a detached HEAD or a verified loose/packed ref proves the tip.
      const headText = (bundle.gitHead || "").trim();
      const refMatch = headText.match(/^ref:\s*(refs\/heads\/[A-Za-z0-9_./-]+)$/);
      const headRef = refMatch && !refMatch[1].split("/").some((part) => part === "." || part === "..") ? refMatch[1] : null;
      const headBranch = headRef ? headRef.slice("refs/heads/".length) : null;
      const looseRaw = headRef ? await readFile(`.git/${headRef}`) : null;
      const loose = toText(looseRaw)?.trim() || "";
      const packed = headRef && looseRaw?.exists === false ? bundle.packedRefs?.split("\n").find((line) => line.endsWith(` ${headRef}`))?.split(/\s+/)[0] : null;
      const headSha = (/^[a-f0-9]{40}$/i.test(headText) ? headText : /^[a-f0-9]{40}$/i.test(loose) ? loose : packed || "").toLowerCase();
      const verifiedHead = /^[a-f0-9]{40}$/.test(headSha) && !/^0{40}$/.test(headSha) ? headSha : null;
      bundle.resolvedHeadSha = verifiedHead;
      const origin = toText(configRaw)?.match(/\[remote\s+"origin"\]\s*\n([\s\S]*?)(?:\n\s*\[[^\]\n]+\]\s*\n|$)/i)?.[1]?.match(/^\s*url\s*=\s*(.+?)\s*$/im)?.[1]?.trim();
      const github = origin?.match(/^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i);
      const githubRepo = github ? `${github[1]}/${github[2]}` : null;
      // Revalidate HEAD, refs, status and available commit rows before reuse;
      // cache is in-memory, bounded and scoped to this exact chat/repository.
      const cache = fetchRemoteGitBundle.cache ||= new Map();
      const now = Date.now();
      for (const [key, value] of cache) if (now - value.at > 120000) cache.delete(key);
      const key = JSON.stringify([identity, bundle.gitHead, bundle.packedRefs, bundle.headLog, verifiedHead, githubRepo, refs, status, branchCommits]);
      const safeToCache = key.length <= 65536 && headRaw != null && (!headRef || looseRaw != null) && packedRaw != null && logRaw != null && configRaw != null && refs != null && status != null && branchCommits != null;
      const hit = safeToCache && cache.get(key);
      if (hit) return JSON.parse(hit.value);
      let result = await callBackend("getRemoteGitGraph", bundle) || null;
      if (result?.ok && Array.isArray(result.commits)) {
        const historyScope = bundle.headLog?.split("\n").some((line) => /\t(?:commit|merge\b)/i.test(line)) ? "repo-activity" : "branch-range";
        result = { ...result, githubRepo, historyScope, commits: result.commits.map((commit) => {
          const refs = Array.isArray(commit.refs) ? commit.refs : [];
          const falselyMarked = refs.some((ref) => ref?.isHead === true || ref?.kind === "head");
          const cleanRefs = refs.filter((ref) => ref?.isHead !== true && ref?.kind !== "head" &&
            !(headBranch && ref?.kind === "branch" && ref?.label === headBranch) &&
            !(falselyMarked && ref?.kind === "branch" && ref?.label === result.branch));
          if (verifiedHead && String(commit.hash || "").toLowerCase() === verifiedHead) {
            cleanRefs.unshift({ kind: "head", label: "HEAD", isHead: true });
            if (headBranch && !cleanRefs.some((ref) => ref?.kind === "branch" && ref.label === headBranch)) cleanRefs.splice(1, 0, { kind: "branch", label: headBranch, isHead: false });
          }
          return { ...commit, refs: cleanRefs };
        }) };
      }
      if (safeToCache && result?.ok) {
        const value = JSON.stringify(result);
        if (value.length <= 512 * 1024) {
          cache.set(key, { at: Date.now(), value });
          while (cache.size > 8) cache.delete(cache.keys().next().value);
        }
      }
      return result;
    })();
    if (inFlight.size < 8) inFlight.set(identity, work);
    try { return await work; }
    finally { if (inFlight.get(identity) === work) inFlight.delete(identity); }
  }

  async function fetchRemoteCommitPreview(envId, cwd, branch, threadId, hash) {
    if (!envId || !cwd || !/^[a-f0-9]{6,40}$/i.test(hash || "") || typeof window.__t3HudRemoteRpc !== "function") return null;
    const identity = JSON.stringify([envId, cwd, branch || "", threadId || "", hash.toLowerCase()]);
    const cache = fetchRemoteCommitPreview.cache ||= new Map();
    const inFlight = fetchRemoteCommitPreview.inFlight ||= new Map();
    const now = Date.now();
    for (const [key, value] of cache) if (now - value.at > 30000) cache.delete(key);
    const hit = cache.get(identity);
    if (hit) return JSON.parse(hit.value);
    if (inFlight.has(identity)) return inFlight.get(identity);
    const work = (async () => {
      const result = await window.__t3HudRemoteRpc(envId, "review.getDiffPreview", { cwd, commitSha: hash }, 4500).catch(() => null);
      const sources = Array.isArray(result?.value?.sources) ? result.value.sources : [];
      const source = sources.find((item) => item?.kind === "commit" && typeof item.headRef === "string" && item.headRef.toLowerCase() === hash.toLowerCase());
      if (result?.ok && source) {
        const value = JSON.stringify(result);
        if (value.length <= 512 * 1024) {
          cache.set(identity, { at: Date.now(), value });
          while (cache.size > 8) cache.delete(cache.keys().next().value);
        }
      }
      return result;
    })();
    if (inFlight.size < 8) inFlight.set(identity, work);
    try { return await work; }
    finally { if (inFlight.get(identity) === work) inFlight.delete(identity); }
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

    let res;
    const hintSnap = getRouteHint();
    const graphSnap = latestGraph;
    const threadSnap = lastRemotePayload?.threadId || null;
    const branchSnap = lastRemotePayload?.branch || null;
    if (graphSnap?.isRemoteGit) {
      const fb = getFallbackCwd();
      const cwd = fb?.cwd || graphSnap.repoPath || "";
      const envId = fb?.environmentId || lastRemotePayload?.environmentId || "";
      const entry = (graphSnap.commits || []).find((c) => c.hash === hash) || {};
      const previewResult = await fetchRemoteCommitPreview(envId, cwd, branchSnap, threadSnap, hash);
      if (selectedCommitHash !== hash || !drawerOpen || getRouteHint() !== hintSnap ||
          getFallbackCwd()?.environmentId !== envId || getFallbackCwd()?.cwd !== cwd ||
          (lastRemotePayload?.threadId || null) !== threadSnap || (lastRemotePayload?.branch || null) !== branchSnap) return;
      const sources = Array.isArray(previewResult?.value?.sources) ? previewResult.value.sources : [];
      const source = previewResult?.ok && sources.find((item) => item?.kind === "commit" && typeof item.headRef === "string" && item.headRef.toLowerCase() === hash.toLowerCase());
      if (source) {
        res = { ok: true, hash, authorName: entry.author || "", authorEmail: "", message: source.commitSubject || entry.subject || "", files: (source.files || []).map((f) => ({ path: f.path, added: f.additions, deleted: f.deletions })), patch: source.diff || "", diffUnavailable: !!(source.truncated || source.patchesDeferred || previewResult.value.incomplete) };
      } else res = await callBackend("getRemoteCommitDetail", {
        githubRepo: graphSnap.githubRepo || null,
        hash,
        cwd,
        environmentId: envId,
        commitMeta: { author: entry.author || "", subject: entry.subject || "", relTime: entry.relTime || "" },
      });
    } else {
      res = await callBackend("getCommitDetail", getRouteHint(), hash, getFallbackCwd());
    }
    if (selectedCommitHash !== hash || !drawerOpen || getRouteHint() !== hintSnap || (lastRemotePayload?.threadId || null) !== threadSnap) return;
    if (!res || !res.ok) {
      commitMsgEl.textContent = res?.error || t("readFail");
      return;
    }
    selectedCommitDetail = res;
    renderCommitDetail(res);
  }

  function renderCommitDetail(res) {
    commitMsgEl.textContent = res.message || t("noMessage");
    const countSuffix = res.diffUnavailable ? "" : ` · ${(res.files || []).length} ${t("filesCount")}`;
    const emailPart = res.authorEmail ? ` <${res.authorEmail}>` : "";
    commitMetaEl.textContent = `${res.authorName || ""}${emailPart} · ${String(res.hash || "").slice(0, 10)}${countSuffix}`;

    const filesHtml = (res.files || [])
      .map(
        (f) => `
        <div class="t3-commit-file">
          <span class="t3-commit-file-path" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</span>
          <span style="flex:none">
            ${f.added != null ? `<span class="t3-diff-add">+${escapeHtml(f.added)}</span>` : ""}
            ${f.deleted != null ? ` <span class="t3-diff-del">-${escapeHtml(f.deleted)}</span>` : ""}
          </span>
        </div>`
      )
      .join("");

    const patchHtml = res.patch
      ? `<div class="t3-patch-box">${formatColoredPatch(res.patch)}</div>`
      : "";

    const notice = res.diffUnavailable ? `<div class="t3-empty-msg">${escapeHtml(hudLang === "en" ? "Diff unavailable or incomplete." : "变更详情不可用或不完整。")}</div>` : "";
    commitBodyEl.innerHTML = notice + filesHtml + patchHtml;
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

  let gitGraphReqSeq = 0;
  async function refreshGitGraph(force = false) {
    if (!drawerOpen && !force) return;
    const reqSeq = ++gitGraphReqSeq;
    const hint = getRouteHint();
    const fbSnap = getFallbackCwd();
    const branchSnap = lastRemotePayload?.branch || null;
    const threadSnap = lastRemotePayload?.threadId || null;
    let graph = await callBackend("getGitGraph", hint, 120, fbSnap);
    if (reqSeq !== gitGraphReqSeq || !drawerOpen || getRouteHint() !== hint) return;
    if (graph && !graph.ok && graph.remoteOnly) {
      const envId = fbSnap?.environmentId || "";
      const cwd = fbSnap?.cwd || "";
      if (envId && cwd) {
        try {
          const remote = await fetchRemoteGitBundle(envId, cwd, branchSnap, { threadId: threadSnap });
          if (reqSeq !== gitGraphReqSeq || !drawerOpen || getRouteHint() !== hint ||
              getFallbackCwd()?.environmentId !== envId || getFallbackCwd()?.cwd !== cwd ||
              (lastRemotePayload?.threadId || null) !== threadSnap || (lastRemotePayload?.branch || null) !== branchSnap) return;
          if (remote) {
            if (!remote.threadId && threadSnap) remote.threadId = threadSnap;
            graph = remote;
          }
        } catch {
          // Keep the remoteOnly message when the relay bundle fails.
        }
        if (reqSeq !== gitGraphReqSeq || !drawerOpen || getRouteHint() !== hint) return;
      }
    }
    latestGraph = graph;
    lastLoadedGraphThreadId = graph?.threadId || threadSnap || null;
    renderGitGraphList();
  }

  let statsInFlight = false;
  let statsRequestSeq = 0;
  async function refreshStats(routeChanged = false) {
    // Promotion can update Zustand/storage while #/draft/<id> stays put.
    // Re-enter once with routeChanged=true before the in-flight guard.
    if (onRouteMaybeChanged()) return;
    const readLive = () => (typeof readLiveT3State === "function" ? readLiveT3State() : null);
    const observeSelection = (live) => {
      const p = String(live?.selectedProvider || "");
      const m = String(live?.selectedModel || "");
      const sig = p || m ? `${p}:${m}` : "";
      if (refreshStats._selectionSeq == null) refreshStats._selectionSeq = 0;
      if (refreshStats._lastSelectionSig == null) refreshStats._lastSelectionSig = sig;
      else if (sig !== refreshStats._lastSelectionSig) {
        refreshStats._selectionSeq++;
        refreshStats._lastSelectionSig = sig;
      }
      return sig;
    };
    refreshStats._observeSelection = observeSelection;
    const entrySelectionSig = observeSelection(readLive());
    if (statsInFlight && !routeChanged) {
      if (refreshStats._activeSelectionSeq !== refreshStats._selectionSeq || refreshStats._activeSelectionSig !== entrySelectionSig) {
        pendingFastRefresh = true;
      }
      return;
    }
    statsInFlight = true;
    const requestId = ++statsRequestSeq;
    const hint = getRouteHint();
    const requestedProvider = String(readLive()?.selectedProvider || "");
    const requestedSelectionSig = observeSelection(readLive());
    const requestedSelectionSeq = refreshStats._selectionSeq;
    refreshStats._activeSelectionSig = requestedSelectionSig;
    refreshStats._activeSelectionSeq = requestedSelectionSeq;
    if (routeChanged) {
      resetLiveStreamSampler(hint);
      resolveHudTurnSpeed(turnSpeedState, { ok: false }, null, hint);
      latestStats = null;
      lastRemotePayload = null;
      lastTopbarSig = "";
      renderTopbarStats({ ok: false });
    }
    try {
      let stats = null;
      try { stats = await callBackend("getThreadStats", hint); }
      catch (err) { stats = { ok: false, error: String(err?.message || err || "rpc_failed") }; }
      if (!isCurrentStatsSnapshot(requestId, statsRequestSeq, hint, getRouteHint())) return;
      let remotePayloadCandidate = null;
      if (!stats?.ok && !stats?.nonThreadRoute) {
        try {
          const proj = readFiberThreadProjection(hint);
          remotePayloadCandidate = proj;
          if (proj) {
            if (proj.isServerThread === false || (!proj.isRunning && !(proj.contextUsage?.usedTokens > 0) && Array.isArray(proj.turns) && proj.turns.length === 0)) {
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
      }
      if (!isCurrentStatsSnapshot(requestId, statsRequestSeq, hint, getRouteHint())) return;
      const liveAfter = readLive();
      const afterSelectionSig = observeSelection(liveAfter);
      const currentSelectedProvider = String(liveAfter?.selectedProvider || "");
      if (
        refreshStats._selectionSeq !== requestedSelectionSeq ||
        (afterSelectionSig && requestedSelectionSig !== afterSelectionSig) ||
        (currentSelectedProvider && requestedProvider !== currentSelectedProvider)
      ) {
        pendingFastRefresh = true;
        return;
      }
      const hudProvidersCompat = (a, b) => {
        const la = String(a || "").trim().toLowerCase();
        const lb = String(b || "").trim().toLowerCase();
        if (!la || !lb) return false;
        if (la === lb) return true;
        return (la === "acpregistry" && lb.startsWith("acpregistry_")) || (lb === "acpregistry" && la.startsWith("acpregistry_"));
      };
      if (currentSelectedProvider && stats?.ok && stats?.provider && !hudProvidersCompat(stats.provider, currentSelectedProvider)) {
        const mismatchKey = `${hint}:${currentSelectedProvider}`;
        if (refreshStats._mismatchKey !== mismatchKey) {
          refreshStats._mismatchKey = mismatchKey;
          pendingFastRefresh = true;
          return;
        }
        const selModel = liveAfter?.selectedModel || null;
        const estMax = currentSelectedProvider === "antigravity"
          ? (/opus|sonnet|haiku|claude/i.test(String(selModel || "")) ? 1000000 : 1048576)
          : currentSelectedProvider === "muse"
            ? 1007997
            : null;
        stats = {
          ...stats,
          provider: currentSelectedProvider,
          model: selModel,
          isRunning: false,
          activeTurnIds: [],
          speed: { ...(stats.speed || {}), lastDecodeTps: null, currentTurnEstimateTps: null, durationSec: null },
          cache: { ...(stats.cache || {}), turnRate: null, lastTurnRate: null, lastCallRate: null, displayRate: stats.cache?.sessionRate ?? null },
          tokens: { ...(stats.tokens || {}), contextUsed: null, contextMax: estMax, contextMaxSource: estMax != null ? "estimated" : null },
        };
      } else {
        refreshStats._mismatchKey = "";
      }
      lastRemotePayload = remotePayloadCandidate;
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
      if (requestId === statsRequestSeq) {
        statsInFlight = false;
        if (pendingFastRefresh && !disposed && !document.hidden && typeof scheduleTrailingFastRefresh === "function") scheduleTrailingFastRefresh();
      }
    }
  }

  function installHudSelectionObservers() {
    const events = ["click", "keydown", "input", "change"];
    const observe = () => {
      if (disposed) return;
      refreshStats._observeSelection?.(readLiveT3State());
    };
    const onSelectionEvent = () => {
      observe();
      // Capture runs before React's handlers; observe again after their commit.
      if (typeof queueMicrotask === "function") queueMicrotask(observe);
    };
    for (const event of events) document.addEventListener(event, onSelectionEvent, true);
    return () => {
      for (const event of events) document.removeEventListener(event, onSelectionEvent, true);
    };
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
      scheduleLayoutSync();
      return true;
    }
    scheduleLayoutSync();
    return false;
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
  window.addEventListener("storage", onRouteMaybeChanged);
  window.addEventListener("resize", scheduleLayoutSync);

  let lastPickerSig = "";
  let lastPickerModelSig = "";
  let lastQuotaInput = null;
  const stopSelectionObservers = installHudSelectionObservers();
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
    refreshStats._observeSelection?.(live);
    const mSig = `${live.selectedProvider || ""}:${live.selectedModel || ""}`;
    const pSig = `${mSig}:${live.usage?.contextWindow?.usedTokens ?? ""}`;
    const quotaInput = [live.environmentId, live.usage?.providers, live.usage?.sources, live.usage?.usageLimitSources];
    const quotaChanged = !lastQuotaInput || quotaInput.some((value, index) => value !== lastQuotaInput[index]);
    lastQuotaInput = quotaInput;
    if (pSig !== lastPickerSig || quotaChanged) {
      const pickerChanged = mSig !== lastPickerModelSig;
      lastPickerSig = pSig;
      lastPickerModelSig = mSig;
      if (latestStats) {
        const pickerCompat = (a, b) => {
          const la = String(a || "").trim().toLowerCase();
          const lb = String(b || "").trim().toLowerCase();
          if (!la || !lb) return false;
          if (la === lb) return true;
          return (la === "acpregistry" && lb.startsWith("acpregistry_")) || (lb === "acpregistry" && la.startsWith("acpregistry_"));
        };
        if (pickerChanged && live.selectedProvider && latestStats.provider && !pickerCompat(latestStats.provider, live.selectedProvider)) {
          latestStats = {
            ...latestStats,
            provider: String(live.selectedProvider),
            model: live.selectedModel || null,
            isRunning: false,
            speed: { ...(latestStats.speed || {}), lastDecodeTps: null, currentTurnEstimateTps: null, durationSec: null },
            cache: { ...(latestStats.cache || {}), turnRate: null, lastTurnRate: null, lastCallRate: null, displayRate: latestStats.cache?.sessionRate ?? null },
            tokens: { ...(latestStats.tokens || {}), contextUsed: null, contextMax: null, contextMaxSource: null },
          };
        } else if (pickerChanged && live.selectedModel && (!live.selectedProvider || String(latestStats.provider || "") === String(live.selectedProvider))) {
          latestStats = { ...latestStats, model: live.selectedModel };
        }
        renderTopbarStats(latestStats);
      }
      if (pickerChanged) refreshStats(false);
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
    refreshStats._observeSelection?.(readLiveT3State());
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
  let streamSampler = createHudStreamSampler();
  let streamRouteSnap = currentPathHint;
  let lastIdleMessageId = "";
  let lastIdleTextLen = 0;
  let lastFastRefreshAt = 0;
  let pendingFastRefresh = false;
  let trailingFastRefreshTimer = null;

  function clearActiveStreamSamples() {
    streamSampler = createHudStreamSampler();
    liveStreamTps = null;
  }

  function resetLiveStreamSampler(route = currentPathHint) {
    if (route === streamRouteSnap) return;
    clearActiveStreamSamples();
    streamRouteSnap = route;
    lastIdleMessageId = "";
    lastIdleTextLen = 0;
    lastFastRefreshAt = 0;
    // Full identity/throttle reset is reserved for actual route changes.
  }

  function scheduleTrailingFastRefresh() {
    if (typeof setTimeout !== "function") {
      pendingFastRefresh = true;
      return;
    }
    if (statsInFlight) {
      pendingFastRefresh = true;
      return;
    }
    if (trailingFastRefreshTimer) return;
    const now = () => typeof performance === "object" && performance !== null && typeof performance.now === "function" ? performance.now() : Date.now();
    const elapsed = now() - lastFastRefreshAt;
    const remaining = Math.max(0, 900 - elapsed);
    trailingFastRefreshTimer = setTimeout(() => {
      trailingFastRefreshTimer = null;
      if (disposed || document.hidden) {
        pendingFastRefresh = false;
        return;
      }
      if (!pendingFastRefresh) return;
      if (statsInFlight) {
        pendingFastRefresh = true;
        return;
      }
      pendingFastRefresh = false;
      lastFastRefreshAt = now();
      refreshStats(false);
    }, remaining + 10);
  }

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
      currentPathHint = routeNow;
      resetLiveStreamSampler(routeNow);
      latestStats = null;
      lastTopbarSig = "";
      renderTopbarStats({ ok: false });
      refreshStats(true);
      return;
    }

    const chatCol = document.querySelector("[data-chat-column]");
    const assistantSnapshot = getAssistantStreamSnapshot(chatCol);
    const now = performance.now();
    // Capture an idle snapshot even when empty; never confuse "not captured" with an empty turn.
    if (!(latestStats?.ok && latestStats.isRunning)) {
      const isNewMessage = String(assistantSnapshot?.messageId || "") !== lastIdleMessageId;
      const isGrowing = (assistantSnapshot?.text.length || 0) > lastIdleTextLen;
      if (turnSpeedState.active || liveStreamTps != null || streamSampler.samples.length) clearActiveStreamSamples();
      turnSpeedState.baselineMessageId = String(assistantSnapshot?.messageId || "");
      turnSpeedState.baselineCaptured = true;
      turnSpeedState.baselineProvider = String(latestStats?.provider || "");
      lastIdleMessageId = String(assistantSnapshot?.messageId || "");
      lastIdleTextLen = assistantSnapshot?.text.length || 0;
      if (latestStats && assistantSnapshot && (isNewMessage || isGrowing)) {
        pendingFastRefresh = true;
        scheduleTrailingFastRefresh(); // completion of an in-flight request resumes the pending refresh
      }
    }
    // When running, keep idle baseline in sync so a future idle does not mis-detect the same message.
    if (latestStats?.isRunning === true && assistantSnapshot) {
      lastIdleMessageId = assistantSnapshot.messageId;
      lastIdleTextLen = Math.max(lastIdleTextLen, assistantSnapshot.text.length);
    }
    const isUnboundedUntrusted = Boolean(assistantSnapshot?.unboundedNoUser);
    const isBaselineMessage = Boolean(
      turnSpeedState.baselineCaptured &&
        turnSpeedState.baselineMessageId &&
        assistantSnapshot?.messageId === turnSpeedState.baselineMessageId
    );
    const sample = advanceHudStreamSampler(
      streamSampler,
      assistantSnapshot,
      now,
      canSampleHudStream(latestStats, assistantSnapshot) && !isUnboundedUntrusted && !isBaselineMessage,
      estimateRenderedTokens
    );
    if (streamSampler.samples.length > 0 && latestStats?.provider) {
      streamSampler.provider = String(latestStats.provider);
    }
    liveStreamTps = sample.liveTps;
    if (sample.changed && latestStats) renderTopbarStats(latestStats);
    if (sample.stalled) refreshStats(false);
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
    // Hub owns its lifecycle: the next drawer script snapshots drafts/open state.
    // Leave window.__t3SidecarHub intact across /admin/reload-ui.
    try {
      if (typeof unsubscribeRouter === "function") unsubscribeRouter();
    } catch {}
    unsubscribeRouter = null;
    cachedRouter = null;
    clearInterval(routeWatchTimer);
    clearInterval(streamWatchTimer);
    clearExternalQuotaPendingTimer();
    externalQuotaPendingRetries = 0;
    if (pollTimer && typeof clearTimeout === "function") clearTimeout(pollTimer);
    if (trailingFastRefreshTimer) {
      if (typeof clearTimeout === "function") clearTimeout(trailingFastRefreshTimer);
      trailingFastRefreshTimer = null;
    }
    pendingFastRefresh = false;
    if (layoutSyncTimer && typeof clearTimeout === "function") clearTimeout(layoutSyncTimer);
    if (layoutRafId) cancelAnimationFrame(layoutRafId);
    if (cleanupDragListeners) cleanupDragListeners();
    if (layoutResizeObserver) layoutResizeObserver.disconnect();
    domObserver.disconnect();
    stopSelectionObservers();
    setComposerTopSpacing(null);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("hashchange", onRouteMaybeChanged);
    window.removeEventListener("popstate", onRouteMaybeChanged);
    window.removeEventListener("storage", onRouteMaybeChanged);
    window.removeEventListener("resize", scheduleLayoutSync);
    window.removeEventListener("t3-hub-theme-change", syncHudTheme);
    window.removeEventListener("t3-hud-update-state", onExternalHudUpdateState);
    window.removeEventListener("storage", syncHudTheme);
    history.pushState = origPushState;
    history.replaceState = origReplaceState;
    document.querySelectorAll(".t3-hud-details-section").forEach((el) => el.remove());
    document.querySelectorAll(".t3-hud-composer-spaced").forEach((el) => el.classList.remove("t3-hud-composer-spaced"));
    if (window.__t3HudRemoteProject === getHudRemoteProject) delete window.__t3HudRemoteProject;
    root.remove();
    styleEl.remove();
    window.__t3HudInitialized = false;
  };

  // Boot: load language config, resolve language, then start polling
  (async () => {
    // Fetch on every injection, so reload-ui never reuses an embedded stale drawer.
    // Keep telemetry boot independent if an older Hub backend is slow or missing.
    void (async () => {
      try {
        // Embedded drawer (same executeJavaScript payload) mounts directly
        // without eval, which is blocked by script-src CSP in t3code://app.
        if (!window.__t3HubDrawerEmbedded) {
          const res = await window.__t3HubRpc("hub:getDrawerScript", {});
          if (disposed) return;
          if (res?.ok && res.code) {
            window.__t3HubDrawerLoading = true;
            try { (0, eval)(res.code); }
            finally { delete window.__t3HubDrawerLoading; }
          }
        }
        window.__t3MountSidecarHub?.({ hubRpc: window.__t3HubRpc });
      } catch (error) {
        if (!disposed) console.warn("[T3 HUD] Sidecar Hub could not be refreshed:", error?.message || error);
      }
    })();
    if (disposed) return;
    await syncConfigLang();
    if (disposed) return;
    hudLang = resolveLang();
    applyLangToDom();
    ensureRouterSubscription();
    refreshStats(true);
    pollTimer = setTimeout(pollLoop, 1200);
  })();
})();
