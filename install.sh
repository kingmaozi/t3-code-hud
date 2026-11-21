#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/kingmaozi/t3-code-hud.git"
SCRIPT_DIR=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

TMP_CLONE=""
TMP_RENDERER=""
TMP_LAUNCHER=""
INSTALL_LOCK="$HOME/.t3/hud-install.lock"
INSTALL_LOCK_ACQUIRED=0
INSTALL_OWNER=""
cleanup() {
  local temp_dir
  for temp_dir in "$TMP_LAUNCHER" "$TMP_RENDERER" "$TMP_CLONE"; do
    if [[ -n "$temp_dir" ]]; then rm -rf -- "$temp_dir" || true; fi
  done
  if [[ "$INSTALL_LOCK_ACQUIRED" == 1 ]] &&
     { [[ -z "$INSTALL_OWNER" ]] || rm -- "$INSTALL_OWNER" 2>/dev/null; }; then
    rmdir "$INSTALL_LOCK" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

is_live_pid() {
  kill -0 "$1" 2>/dev/null || ps -p "$1" -o pid= >/dev/null 2>&1
}

acquire_install_lock() {
  local owner deadline=$((SECONDS + 20))
  mkdir -p "$HOME/.t3"
  until mkdir -m 700 "$INSTALL_LOCK" 2>/dev/null; do
    if [[ -d "$INSTALL_LOCK" && ! -L "$INSTALL_LOCK" ]]; then
      for owner in "$INSTALL_LOCK"/owner-*; do
        # A failed unlink means another waiter already claimed that stale marker.
        if [[ -f "$owner" && ! -L "$owner" && "${owner##*/}" =~ ^owner-([1-9][0-9]*)\.[A-Za-z0-9]{6}$ ]] &&
           ! is_live_pid "${BASH_REMATCH[1]}" && rm -- "$owner" 2>/dev/null; then
          rmdir "$INSTALL_LOCK" 2>/dev/null || true
          break
        fi
      done
    fi
    if (( SECONDS >= deadline )); then
      echo "[t3-hud] Timed out waiting for the HUD install lock at $INSTALL_LOCK." >&2
      return 1
    fi
    sleep 0.25
  done
  INSTALL_LOCK_ACQUIRED=1
  INSTALL_OWNER="$(mktemp "$INSTALL_LOCK/owner-$$.XXXXXX")"
}

check_update_lock() {
  local owner
  if [[ -e "$RUN_DIR/hud-update-pending.json" || -L "$RUN_DIR/hud-update-pending.json" ]]; then
    echo "[t3-hud] An interrupted HUD update needs recovery. Run the update from the HUD before reinstalling." >&2
    return 1
  fi
  for owner in "$RUN_DIR/hud-update.lock"/owner-*; do
    if [[ -f "$owner" && "${owner##*/}" =~ ^owner-([1-9][0-9]*)-[a-f0-9-]{36}$ ]] &&
       is_live_pid "${BASH_REMATCH[1]}"; then
      echo "[t3-hud] A HUD update is running. Try installing again after it finishes." >&2
      return 1
    fi
  done
}

if [[ -z "$SCRIPT_DIR" || ! -d "$SCRIPT_DIR/src" ]]; then
  echo "[t3-hud] 正在拉取最新 t3-code-hud 仓库..."
  TMP_CLONE="$(mktemp -d)"
  git clone --depth 1 "$REPO_URL" "$TMP_CLONE"
  SCRIPT_DIR="$TMP_CLONE"
fi

hud_release_version="$(/usr/bin/plutil -extract version raw -o - "$SCRIPT_DIR/package.json")"
if [[ ! "$hud_release_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.+-]+)?$ ]]; then
  echo "[t3-hud] package.json 中的 HUD 版本无效。" >&2
  exit 1
fi

DEST_DIR="$HOME/.t3/hud-plugin"
BIN_DIR="$HOME/.t3/bin"
RUN_DIR="$DEST_DIR/run"
CONFIG_FILE="$DEST_DIR/config.json"
acquire_install_lock
check_update_lock
mkdir -p "$BIN_DIR"

if [[ -L "$DEST_DIR" ]]; then
  rm -f "$DEST_DIR"
fi
mkdir -p "$DEST_DIR"

cp "$SCRIPT_DIR/src/"*.cjs "$SCRIPT_DIR/src/"*.py "$SCRIPT_DIR/src/hub-drawer-ui.js" "$DEST_DIR/" 2>/dev/null || \
cp "$SCRIPT_DIR/src/backend.cjs" \
   "$SCRIPT_DIR/src/main-hook.cjs" \
   "$SCRIPT_DIR/src/preload-bridge.cjs" \
   "$SCRIPT_DIR/src/bootstrap.cjs" \
   "$SCRIPT_DIR/src/hud-health.cjs" \
   "$SCRIPT_DIR/src/hud-release.cjs" \
   "$SCRIPT_DIR/src/hub-update.cjs" \
   "$SCRIPT_DIR/src/hub-drawer-ui.js" \
   "$DEST_DIR/"

# Ensure sidecar modules present (explicit list for older clones)
for f in hub-plugins.cjs hub-hooks.cjs hub-bridge.cjs hub-subagents.cjs hub-skills.cjs hub-memory-access.cjs hub-memory-connections.cjs hub-provider-resources.cjs update-guardian.cjs mcp-router.cjs memory-vault.cjs embed-manager.cjs hub-drawer-ui.js hub-task-board.cjs hub-artifact-access.cjs hub-host-settings.cjs hub-dream-scheduler.cjs; do
  if [[ -f "$SCRIPT_DIR/src/$f" && ! -f "$DEST_DIR/$f" ]]; then cp "$SCRIPT_DIR/src/$f" "$DEST_DIR/"; fi
done

# ---------------------------------------------------------------------------
# Upgraded embed-server.py with five dynamic memory-ceiling guards.
# The heredoc below is the deployment source of truth for $DEST_DIR/embed-server.py
# (overrides the src/ copy). Guarded by tests/embed-memory-ceiling.test.cjs:
# extraction -> py_compile -> live MLX pressure on a temp port.
# ---------------------------------------------------------------------------
cat > "$DEST_DIR/embed-server.py" <<'T3_EMBED_SERVER_PY_EOF'
#!/usr/bin/env python3
"""T3 Hub local MLX embedding server (FastAPI) with dynamic memory ceiling.

Self-contained server for a Python environment with the local MLX dependencies.
Listens on 127.0.0.1:8001. Supports hot model switching without dropping the port.

Five guards keep Metal VRAM strictly tracking the selected model weights:
  1. dynamic ceiling_mb derived from measured base_active_mb (+ config override)
  2. Metal hard limits via set_cache_limit / set_memory_limit + MemoryError fallback
  3. per-text truncation (2048 chars) + fixed micro-batches of 8
  4. _enforce_memory_ceiling() auto-trim + POST /trim + observable /health
  5. OS RSS fuse self-restart via os._exit(0) under launchd KeepAlive
"""
import asyncio
import gc
import json
import os
import re
import resource
import subprocess
import threading
import time
import traceback
from contextlib import asynccontextmanager

os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

import mlx.core as mx
import numpy as np
import uvicorn
from fastapi import FastAPI
from pydantic import BaseModel

MAX_CHARS_PER_TEXT = 2048
MICRO_BATCH_SIZE = 8

# Estha asymmetric prefixes for Octen/Qwen3 family (RTEB full-blood).
DEFAULT_QUERY_PREFIX = "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:"
DEFAULT_DOCUMENT_PREFIX = " "
LEGACY_QWEN_QUERY_PREFIX = "Instruct: Given a software engineering search query, retrieve relevant project memories, architecture rules, and debugging pitfalls\nQuery:"
ESTHA_QUERY_PREFIX = None
ESTHA_DOCUMENT_PREFIX = None
ESTHA_CONFIG = {}
ESTHA_SOURCE = "none"


def _valid_config_model_id(value):
    if not value or " " in value or ".." in value:
        return False
    if value.endswith("/"):
        return False
    if value.startswith("/") or value.startswith("~/") or value.startswith("./"):
        return True
    return bool(re.match(r"^[A-Za-z0-9._-]+\/[A-Za-z0-9._~\/-]+$", value))


def _load_config_model_id():
    if os.environ.get("T3_EMBED_FORCE_ENV") == "1":
        return None
    if os.environ.get("T3_EMBED_IGNORE_CONFIG") == "1":
        return None
    try:
        cfg_path = os.path.expanduser("~/.t3/hub/embed-config.json")
        if not os.path.exists(cfg_path):
            return None
        with open(cfg_path, "r", encoding="utf-8") as fh:
            cfg = json.load(fh)
        if not isinstance(cfg, dict):
            return None
        if cfg.get("mode") != "mlx":
            return None
        mid = cfg.get("modelId")
        if not isinstance(mid, str) or not mid.strip():
            return None
        mid = mid.strip()
        if _valid_config_model_id(mid):
            return mid
    except Exception:
        return None
    return None


def _load_memory_override_mb():
    """Optional explicit ceiling override from embed-config.json.

    Checks maxMemoryMb (preferred) then ceilingMb; 0 / missing means "follow weights".
    """
    if os.environ.get("T3_EMBED_FORCE_ENV") == "1":
        return 0.0
    try:
        cfg_path = os.path.expanduser("~/.t3/hub/embed-config.json")
        if not os.path.exists(cfg_path):
            return 0.0
        with open(cfg_path, "r", encoding="utf-8") as fh:
            cfg = json.load(fh)
        if not isinstance(cfg, dict):
            return 0.0
        raw = cfg.get("maxMemoryMb")
        if raw is None:
            raw = cfg.get("ceilingMb")
        if raw is None:
            raw = cfg.get("max_memory_mb")
        if raw is None:
            raw = cfg.get("ceiling_mb")
        if raw is None:
            return 0.0
        v = float(raw)
        if v > 0:
            return v
    except Exception:
        return 0.0
    return 0.0


def _try_read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return None


def _load_estha_config_for_model(model_id, model_path=None):
    """Load estha_embedding_config.json for full-blood RTEB asymmetric prefixes.

    Priority: (1) local snapshot dir via model_path, (2) hf_hub_download
    with local_files_only=True, (3) standard defaults for octen/qwen3-embedding.
    """
    global ESTHA_QUERY_PREFIX, ESTHA_DOCUMENT_PREFIX, ESTHA_CONFIG, ESTHA_SOURCE
    cfg = {}
    qp = None
    dp = None
    source = "none"
    candidates = []
    try:
        if model_path and os.path.isdir(model_path):
            candidates.append(os.path.join(model_path, "estha_embedding_config.json"))
    except Exception:
        pass
    try:
        if model_id and "/" in str(model_id) and not str(model_id).startswith("/") and not str(model_id).startswith("~/") and not str(model_id).startswith("./"):
            try:
                from huggingface_hub import hf_hub_download  # type: ignore
                try:
                    fp = hf_hub_download(repo_id=str(model_id), filename="estha_embedding_config.json", local_files_only=True)
                    if fp:
                        candidates.append(fp)
                except Exception:
                    pass
            except Exception:
                pass
    except Exception:
        pass
    for p in candidates:
        try:
            if p and os.path.isfile(p):
                data = _try_read_json(p)
                if isinstance(data, dict):
                    qp = data.get("query_prefix")
                    dp = data.get("document_prefix")
                    cfg = data
                    source = "file"
                    break
        except Exception:
            continue
    if qp is None:
        mid = (str(model_id) or "").lower()
        if "octen" in mid:
            qp = DEFAULT_QUERY_PREFIX
            if dp is None:
                dp = DEFAULT_DOCUMENT_PREFIX
            source = "default-octen"
        elif "qwen3-embedding" in mid or "qwen3" in mid:
            qp = DEFAULT_QUERY_PREFIX
            if dp is None:
                dp = ""
            source = "default-qwen"
    ESTHA_QUERY_PREFIX = qp
    ESTHA_DOCUMENT_PREFIX = dp
    ESTHA_CONFIG = cfg if isinstance(cfg, dict) else {}
    ESTHA_SOURCE = source
    try:
        state["estha_query_prefix"] = qp
        state["estha_document_prefix"] = dp
        state["estha_source"] = source
        state["estha_config"] = ESTHA_CONFIG
    except Exception:
        pass
    return cfg


def _estha_prefixes_for(model_id):
    mid = (model_id or "").lower()
    if ESTHA_QUERY_PREFIX is not None or ESTHA_DOCUMENT_PREFIX is not None:
        return ESTHA_QUERY_PREFIX, ESTHA_DOCUMENT_PREFIX
    if "octen" in mid:
        return DEFAULT_QUERY_PREFIX, DEFAULT_DOCUMENT_PREFIX
    if "qwen3-embedding" in mid or "qwen3" in mid:
        return DEFAULT_QUERY_PREFIX, ""
    return None, None


_config_model_id = _load_config_model_id()
if _config_model_id:
    MODEL_ID = _config_model_id
    SERVED_NAME = _config_model_id.split("/")[-1]
else:
    MODEL_ID = os.environ.get("EMBED_MODEL", "mlx-community/Qwen3-Embedding-0.6B-8bit")
    SERVED_NAME = os.environ.get("EMBED_NAME", "Qwen3-Embedding-0.6B-8bit")
MAX_LEN = int(os.environ.get("EMBED_MAX_LEN", "8192"))
PREFIX = os.environ.get("EMBED_PREFIX", "")
CACHE_LIMIT_MB = int(os.environ.get("EMBED_CACHE_LIMIT_MB", "256"))
CACHE_LIMIT_BYTES = max(0, CACHE_LIMIT_MB) * 1024 * 1024
BATCH_SIZE = max(1, int(os.environ.get("EMBED_BATCH_SIZE", "32")))

# Dynamic ceiling state, recomputed from measured weights after every model
# load + warmup (see _load_model_sync). Defaults are overwritten at startup.
BASE_ACTIVE_BYTES = 0
BASE_ACTIVE_MB = 0.0
CEILING_MB = 0.0
RSS_FUSE_MB = 0.0
AUTO_TRIMMED_COUNT = 0
_RSS_FUSE_SCHEDULED = False

state = {"model": None, "tokenizer": None, "native_dim": None, "model_id": MODEL_ID, "served_name": SERVED_NAME, "estha_query_prefix": None, "estha_document_prefix": None, "estha_source": "none", "estha_config": {}}
lock = asyncio.Lock()


def _get_active_mb():
    try:
        return round(mx.get_active_memory() / (1024 * 1024), 1)
    except Exception:
        return 0.0


def _get_cache_mb():
    try:
        return round(mx.get_cache_memory() / 1024**2, 1)
    except Exception:
        return 0.0


def _set_cache_limit_safe(limit_bytes):
    try:
        if hasattr(mx, "set_cache_limit"):
            mx.set_cache_limit(limit_bytes)
        elif hasattr(mx, "metal") and hasattr(mx.metal, "set_cache_limit"):
            mx.metal.set_cache_limit(limit_bytes)
    except Exception:
        pass


def _reclaim_cache():
    try:
        if mx.get_cache_memory() > CACHE_LIMIT_BYTES:
            mx.clear_cache()
    except Exception:
        pass


def _enforce_memory_ceiling():
    """Post-inference guard: clear cache when near limits, count trims.

    Trims when cache exceeds 80% of its limit or active+cache exceeds 88%
    of the dynamic ceiling. After a trim, checks the OS RSS fuse line and
    schedules a graceful self-restart if the process still exceeds it.
    """
    global AUTO_TRIMMED_COUNT
    try:
        active_mb = _get_active_mb()
        cache_mb = _get_cache_mb()
        cache_limit_mb = CACHE_LIMIT_BYTES / (1024 * 1024) if CACHE_LIMIT_BYTES else 0.0
        ceiling_mb = CEILING_MB
        need_trim = False
        if cache_limit_mb > 0 and cache_mb > cache_limit_mb * 0.8:
            need_trim = True
        if ceiling_mb > 0 and (active_mb + cache_mb) > ceiling_mb * 0.88:
            need_trim = True
        if not need_trim:
            return False
        try:
            mx.clear_cache()
        except Exception:
            pass
        gc.collect()
        AUTO_TRIMMED_COUNT += 1
        _maybe_schedule_rss_fuse()
        return True
    except Exception:
        return False


def _schedule_rss_fuse_restart():
    global _RSS_FUSE_SCHEDULED
    if _RSS_FUSE_SCHEDULED:
        return
    _RSS_FUSE_SCHEDULED = True

    def _exit():
        try:
            os._exit(0)
        except Exception:
            pass

    t = threading.Timer(0.15, _exit)
    t.daemon = True
    t.start()


def _maybe_schedule_rss_fuse():
    """If OS RSS still exceeds the fuse line after a trim, self-restart.

    RSS fuse is recomputed from the active ceiling (see _load_model_sync):
    rss_fuse_mb derived as max(ceiling*1.45, ceiling+512). The process
    exits 150ms later so the in-flight HTTP response can flush; launchd
    (KeepAlive true) relaunches a clean process back at base_active_mb.
    """
    try:
        if CEILING_MB <= 0 or RSS_FUSE_MB <= 0:
            return False
        rss_mb = _get_rss_mb()
        if rss_mb > RSS_FUSE_MB:
            _schedule_rss_fuse_restart()
            return True
    except Exception:
        pass
    return False


def _get_peak_rss_mb():
    # Historical peak RSS (ru_maxrss never decreases).
    try:
        ru = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        import sys

        if sys.platform == "darwin":
            return round(float(ru) / (1024 * 1024), 1)
        return round(float(ru) / 1024, 1)
    except Exception:
        return 0.0


def _get_rss_mb():
    # Prefer current live RSS via ps (ru_maxrss only reports the peak).
    try:
        out = subprocess.check_output(["ps", "-o", "rss=", "-p", str(os.getpid())], text=True, timeout=1).strip()
        if out:
            return round(float(out) / 1024, 1)
    except Exception:
        pass
    return _get_peak_rss_mb()


def _get_peak_mb():
    try:
        if hasattr(mx, "get_peak_memory"):
            return round(mx.get_peak_memory() / (1024 * 1024), 1)
    except Exception:
        pass
    return _get_peak_rss_mb()


def _format_inputs_for_model(texts: list[str], model_id: str, input_type: str | None) -> list[str]:
    if PREFIX:
        return [PREFIX + t for t in texts]
    if input_type is None:
        return list(texts)
    mid = (model_id or "").lower()
    ity = (input_type or "").strip().lower() or None
    # Estha asymmetric retrieval prefixes (Octen/Qwen3) — server-side idempotent
    # full-blood RTEB injection. Caller must NOT double-prefix; server is idempotent.
    estha_qp, estha_dp = _estha_prefixes_for(model_id)
    if estha_qp is not None or estha_dp is not None:
        if ity == "query":
            qp = estha_qp if estha_qp is not None else DEFAULT_QUERY_PREFIX
            out: list[str] = []
            for t in texts:
                if t.startswith(qp) or t.startswith(DEFAULT_QUERY_PREFIX) or t.startswith(LEGACY_QWEN_QUERY_PREFIX) or t.startswith("Instruct:"):
                    out.append(t)
                else:
                    out.append(qp + t)
            return out
        if ity in ("document", "passage"):
            dp = estha_dp
            if dp is None:
                dp = ""
            if not dp:
                return list(texts)
            out2: list[str] = []
            for t in texts:
                if t.startswith(dp):
                    out2.append(t)
                else:
                    out2.append(dp + t)
            return out2
    out: list[str] = []
    if ity == "query":
        for t in texts:
            if "qwen3-embedding" in mid or (mid.endswith("qwen3") or "qwen3" in mid):
                if t.startswith("Instruct:"):
                    out.append(t)
                else:
                    out.append(
                        f"Instruct: Given a software engineering search query, retrieve relevant project memories, architecture rules, and debugging pitfalls\nQuery:{t}"
                    )
            elif "embeddinggemma" in mid:
                if t.startswith("task: search result"):
                    out.append(t)
                else:
                    out.append(f"task: search result | query: {t}")
            elif "modernbert-embed" in mid:
                if t.startswith("search_query:"):
                    out.append(t)
                else:
                    out.append(f"search_query: {t}")
            elif "snowflake-arctic-embed" in mid:
                if t.startswith("query:"):
                    out.append(t)
                else:
                    out.append(f"query: {t}")
            elif "multilingual-e5" in mid:
                if t.startswith("query:"):
                    out.append(t)
                else:
                    out.append(f"query: {t}")
            else:
                out.append(t)
        return out
    if ity in ("document", "passage"):
        for t in texts:
            if "embeddinggemma" in mid:
                if t.startswith("title: none"):
                    out.append(t)
                else:
                    out.append(f"title: none | text: {t}")
            elif "modernbert-embed" in mid:
                if t.startswith("search_document:"):
                    out.append(t)
                else:
                    out.append(f"search_document: {t}")
            elif "multilingual-e5" in mid:
                if t.startswith("passage:"):
                    out.append(t)
                else:
                    out.append(f"passage: {t}")
            else:
                out.append(t)
        return out
    return list(texts)


_MEMORY_LIMIT_FIELDS = ("BASE_ACTIVE_BYTES", "BASE_ACTIVE_MB", "CEILING_MB", "CACHE_LIMIT_BYTES", "CACHE_LIMIT_MB", "RSS_FUSE_MB")


def _snapshot_memory_limits():
    return {name: globals()[name] for name in _MEMORY_LIMIT_FIELDS}


def _set_memory_limit_safe(limit_bytes):
    try:
        return mx.set_memory_limit(int(limit_bytes))
    except AttributeError:
        return mx.metal.set_memory_limit(int(limit_bytes))


def _restore_memory_limits(snapshot):
    globals().update({name: snapshot[name] for name in _MEMORY_LIMIT_FIELDS})
    _set_cache_limit_safe(CACHE_LIMIT_BYTES)
    try:
        limit = snapshot.get("metal_limit_bytes", int(CEILING_MB * 1024**2))
        if limit > 0:
            _set_memory_limit_safe(limit)
    except Exception:
        pass
    state.update(base_active_mb=BASE_ACTIVE_MB, ceiling_mb=CEILING_MB,
                 cache_limit_mb=CACHE_LIMIT_MB, rss_fuse_mb=RSS_FUSE_MB)


def _load_model_sync(model_id):
    # Loading/warmup must not inherit the previous (possibly much smaller)
    # model's inference ceiling. Snapshot first so failure restores that ceiling.
    snapshot = _snapshot_memory_limits()
    loading_limit = 64 * 1024**3
    try:
        loading_limit = max(loading_limit, int(mx.metal.device_info().get("max_recommended_working_set_size", 0)))
    except Exception:
        pass
    previous_limit = _set_memory_limit_safe(loading_limit)
    if isinstance(previous_limit, int) and previous_limit > 0:
        snapshot["metal_limit_bytes"] = previous_limit
    try:
        mx.clear_cache()
        return _load_model_unbounded_sync(model_id)
    except Exception as exc:
        # Failed load/warmup frames can retain the new model's tensors. Drop
        # those references before rollback allocates the previous model again.
        traceback.clear_frames(exc.__traceback__)
        gc.collect()
        try:
            mx.clear_cache()
        except Exception:
            pass
        _restore_memory_limits(snapshot)
        raise


def _load_model_unbounded_sync(model_id):
    global BASE_ACTIVE_BYTES, BASE_ACTIVE_MB, CEILING_MB, CACHE_LIMIT_BYTES, CACHE_LIMIT_MB, RSS_FUSE_MB
    from mlx_vlm.embedding_loader import load_embedding_model
    from mlx_vlm.utils import get_model_path
    from transformers import AutoTokenizer

    _set_cache_limit_safe(CACHE_LIMIT_BYTES)
    path = get_model_path(model_id)
    try:
        _load_estha_config_for_model(model_id, path)
    except Exception:
        pass
    model = load_embedding_model(path)
    tokenizer = AutoTokenizer.from_pretrained(path)
    enc = tokenizer(["warmup"], padding=True, truncation=True, max_length=32, return_tensors="np")
    out = model(**{k: mx.array(v) for k, v in enc.items()})
    mx.eval(out.text_embeds)
    dim = int(out.text_embeds.shape[1])
    del out
    try:
        mx.clear_cache()
    except Exception:
        pass
    try:
        base_active_bytes = mx.get_active_memory()
    except Exception:
        base_active_bytes = 0
    base_active_mb = base_active_bytes / (1024 * 1024)
    override_mb = _load_memory_override_mb()
    if override_mb and override_mb > 0:
        ceiling_mb = round(float(override_mb), 1)
    else:
        ceiling_mb = round(max(base_active_mb * 1.28 + 180.0, base_active_mb + 220.0), 1)
    cache_limit_bytes = min(256 * 1024 * 1024, max(48 * 1024 * 1024, int(base_active_bytes * 0.12)))
    cache_limit_mb = round(cache_limit_bytes / (1024 * 1024), 1)
    rss_fuse_mb = round(max(ceiling_mb * 1.45, ceiling_mb + 512.0), 1)
    BASE_ACTIVE_BYTES = base_active_bytes
    BASE_ACTIVE_MB = round(base_active_mb, 1)
    CEILING_MB = ceiling_mb
    CACHE_LIMIT_BYTES = cache_limit_bytes
    CACHE_LIMIT_MB = cache_limit_mb
    RSS_FUSE_MB = rss_fuse_mb
    _set_cache_limit_safe(cache_limit_bytes)
    try:
        _set_memory_limit_safe(int(ceiling_mb * 1024 * 1024))
    except Exception:
        pass
    try:
        mx.clear_cache()
    except Exception:
        pass
    state["base_active_mb"] = BASE_ACTIVE_MB
    state["ceiling_mb"] = CEILING_MB
    state["cache_limit_mb"] = CACHE_LIMIT_MB
    state["rss_fuse_mb"] = RSS_FUSE_MB
    return model, tokenizer, dim


def load_model():
    model, tokenizer, dim = _load_model_sync(state["model_id"])
    state.update(model=model, tokenizer=tokenizer, native_dim=dim)
    return dim


@asynccontextmanager
async def lifespan(app):
    dim = await asyncio.to_thread(load_model)
    print(
        f"loaded {state['model_id']} dim={dim} prefix={PREFIX!r} cache_limit_mb={CACHE_LIMIT_MB} batch_size={MICRO_BATCH_SIZE} ceiling_mb={CEILING_MB} base_active_mb={BASE_ACTIVE_MB}",
        flush=True,
    )
    yield


app = FastAPI(lifespan=lifespan)


class EmbeddingRequest(BaseModel):
    input: str | list[str]
    model: str | None = None
    dimensions: int | None = None
    encoding_format: str | None = None
    input_type: str | None = None


def embed_texts(texts, dimensions=None, input_type=None):
    tokenizer = state["tokenizer"]
    model = state["model"]
    if tokenizer is None or model is None:
        raise RuntimeError("embedding model is not loaded")
    truncated = [t[:MAX_CHARS_PER_TEXT] if isinstance(t, str) else t for t in texts]
    prepared = _format_inputs_for_model(list(truncated), state.get("model_id", ""), input_type)
    chunks = []
    tokens = 0
    elapsed = 0.0
    for i in range(0, len(prepared), MICRO_BATCH_SIZE):
        batch = prepared[i : i + MICRO_BATCH_SIZE]
        enc = tokenizer(batch, padding=True, truncation=True, max_length=MAX_LEN, return_tensors="np")
        started = time.perf_counter()
        try:
            out = model(**{k: mx.array(v) for k, v in enc.items()})
            mx.eval(out.text_embeds)
            elapsed += time.perf_counter() - started
            chunks.append(np.array(out.text_embeds.astype(mx.float32), dtype=np.float32))
            tokens += int(np.asarray(enc["attention_mask"]).sum())
            del out
        except MemoryError:
            try:
                mx.clear_cache()
            except Exception:
                pass
            gc.collect()
            if len(batch) > 1:
                for single in batch:
                    enc1 = tokenizer([single], padding=True, truncation=True, max_length=MAX_LEN, return_tensors="np")
                    started1 = time.perf_counter()
                    out1 = model(**{k: mx.array(v) for k, v in enc1.items()})
                    mx.eval(out1.text_embeds)
                    elapsed += time.perf_counter() - started1
                    chunks.append(np.array(out1.text_embeds.astype(mx.float32), dtype=np.float32))
                    tokens += int(np.asarray(enc1["attention_mask"]).sum())
                    del out1
                    _reclaim_cache()
                    _enforce_memory_ceiling()
            else:
                raise
            _reclaim_cache()
            _enforce_memory_ceiling()
            continue
        _reclaim_cache()
        _enforce_memory_ceiling()
    arr = chunks[0] if len(chunks) == 1 else np.concatenate(chunks, axis=0)
    if dimensions and 0 < dimensions < arr.shape[1]:
        arr = arr[:, :dimensions].copy()
    arr = arr / np.maximum(np.linalg.norm(arr, axis=1, keepdims=True), 1e-12)
    _enforce_memory_ceiling()
    _maybe_schedule_rss_fuse()
    return arr, tokens, elapsed


@app.get("/health")
async def health():
    try:
        active_mb = round(mx.get_active_memory() / (1024 * 1024), 1)
    except Exception:
        active_mb = 0.0
    try:
        cache_mb = round(mx.get_cache_memory() / 1024**2, 1)
    except Exception:
        cache_mb = 0.0
    peak_mb = _get_peak_mb()
    rss_mb = _get_rss_mb()
    peak_rss_mb = _get_peak_rss_mb()
    return {
        "ok": True,
        "status": "ok",
        "modelId": state["model_id"],
        "servedName": state["served_name"],
        "model": state["served_name"],
        "model_id": state["model_id"],
        "dim": state["native_dim"],
        "rssMb": rss_mb,
        "processRssMb": rss_mb,
        "peakRssMb": peak_rss_mb,
        "peak_rss_mb": peak_rss_mb,
        "rss_mb": rss_mb,
        "activeMb": active_mb,
        "active_mb": active_mb,
        "cache_mb": cache_mb,
        "cacheLimitMb": CACHE_LIMIT_MB,
        "cache_limit_mb": CACHE_LIMIT_MB,
        "baseActiveMb": BASE_ACTIVE_MB,
        "base_active_mb": BASE_ACTIVE_MB,
        "ceilingMb": CEILING_MB,
        "ceiling_mb": CEILING_MB,
        "peakMb": peak_mb,
        "peak_mb": peak_mb,
        "autoTrimmedCount": AUTO_TRIMMED_COUNT,
        "auto_trimmed_count": AUTO_TRIMMED_COUNT,
        "rssFuseMb": RSS_FUSE_MB,
        "rss_fuse_mb": RSS_FUSE_MB,
        "maxCharsPerText": MAX_CHARS_PER_TEXT,
        "microBatchSize": MICRO_BATCH_SIZE,
        "esthaQueryPrefix": state.get("estha_query_prefix"),
        "esthaDocumentPrefix": state.get("estha_document_prefix"),
        "estha_source": state.get("estha_source", ESTHA_SOURCE),
        "esthaSource": state.get("estha_source", ESTHA_SOURCE),
    }


@app.get("/v1/models")
async def models():
    return {"object": "list", "data": [{"id": state["served_name"], "object": "model", "owned_by": "local"}]}


@app.post("/trim")
async def trim():
    before_active_mb = _get_active_mb()
    before_cache_mb = _get_cache_mb()
    before = {"active_mb": before_active_mb, "cache_mb": before_cache_mb, "rss_mb": _get_rss_mb()}
    try:
        mx.clear_cache()
    except Exception:
        pass
    gc.collect()
    after_active_mb = _get_active_mb()
    after_cache_mb = _get_cache_mb()
    after = {"active_mb": after_active_mb, "cache_mb": after_cache_mb, "rss_mb": _get_rss_mb()}
    _maybe_schedule_rss_fuse()
    return {
        "ok": True,
        "status": "ok",
        "before": before,
        "after": after,
        "before_cache_mb": before_cache_mb,
        "after_cache_mb": after_cache_mb,
        "cache_mb": after_cache_mb,
        "active_mb": after_active_mb,
        "ceiling_mb": CEILING_MB,
        "base_active_mb": BASE_ACTIVE_MB,
        "cache_limit_mb": CACHE_LIMIT_MB,
        "auto_trimmed_count": AUTO_TRIMMED_COUNT,
    }


@app.post("/v1/embeddings")
@app.post("/embed")
async def embeddings(req: EmbeddingRequest):
    texts = [req.input] if isinstance(req.input, str) else list(req.input)
    if not texts or any(not isinstance(t, str) for t in texts):
        return {"error": {"message": "input must be a string or a list of strings", "type": "invalid_request_error"}}
    texts = [t if t else " " for t in texts]
    async with lock:
        arr, tokens, elapsed = await asyncio.to_thread(embed_texts, texts, req.dimensions, req.input_type)
    data = [{"object": "embedding", "index": i, "embedding": vec.tolist()} for i, vec in enumerate(arr)]
    return {
        "object": "list",
        "data": data,
        "model": state["served_name"],
        "usage": {"prompt_tokens": tokens, "total_tokens": tokens},
        "took_ms": round(elapsed * 1000, 1),
    }


@app.post("/admin/switch-model")
async def switch_model(payload: dict):
    model_id = (
        payload.get("modelId")
        or payload.get("model_id")
        or payload.get("model")
        or payload.get("repo_id")
        or payload.get("repoId")
        or payload.get("customModelId")
    )
    if not model_id or not isinstance(model_id, str) or not model_id.strip():
        return {"ok": False, "error": "modelId required"}
    model_id = model_id.strip()
    use_mirror = bool(payload.get("useMirror", payload.get("use_mirror", False)))
    if use_mirror:
        os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"
    served_name = payload.get("servedName") or payload.get("served_name") or payload.get("name") or model_id.split("/")[-1]

    def _swap():
        old_model_id = state.get("model_id")
        old_served_name = state.get("served_name")
        old_limits = _snapshot_memory_limits()
        old_model = state.get("model")
        old_tok = state.get("tokenizer")
        try:
            if old_model is not None:
                del old_model
        except Exception:
            pass
        try:
            if old_tok is not None:
                del old_tok
        except Exception:
            pass
        state["model"] = None
        state["tokenizer"] = None
        gc.collect()
        try:
            mx.clear_cache()
        except Exception:
            pass
        try:
            model, tokenizer, dim = _load_model_sync(model_id)
        except Exception:
            if old_model_id:
                try:
                    _rmodel, _rtokenizer, _rdim = _load_model_sync(old_model_id)
                    state.update(model=_rmodel, tokenizer=_rtokenizer, native_dim=_rdim, model_id=old_model_id, served_name=old_served_name)
                except Exception:
                    state.update(model=None, tokenizer=None, native_dim=None, model_id=old_model_id, served_name=old_served_name)
            _restore_memory_limits(old_limits)
            raise
        state.update(model=model, tokenizer=tokenizer, native_dim=dim, model_id=model_id, served_name=served_name)
        return dim

    async with lock:
        dim = await asyncio.to_thread(_swap)
    rss_mb = _get_rss_mb()
    return {"ok": True, "modelId": model_id, "servedName": served_name, "dim": dim, "rssMb": rss_mb, "cacheLimitMb": CACHE_LIMIT_MB, "ceiling_mb": CEILING_MB, "base_active_mb": BASE_ACTIVE_MB, "cache_limit_mb": CACHE_LIMIT_MB}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("PORT", "8001")))
T3_EMBED_SERVER_PY_EOF
chmod +x "$DEST_DIR/embed-server.py" 2>/dev/null || true
if command -v python3 >/dev/null 2>&1; then
  python3 -m py_compile "$DEST_DIR/embed-server.py" || { echo "[t3-hud] generated embed-server.py failed py_compile" >&2; exit 1; }
fi
# T3_EMBED_LAUNCHD_UPGRADE_START
LAUNCHD_PLIST="$HOME/Library/LaunchAgents/com.t3tools.powercontext-embed.plist"
# Preserve an explicit zero-memory choice across upgrades. This block does not
# bootstrap/kickstart launchd: installation alone must not start a stopped job.
if command -v python3 >/dev/null 2>&1; then
  if ! python3 - "$LAUNCHD_PLIST" "$HOME/.t3/hub/embed-config.json" "$DEST_DIR/embed-server.py" <<'T3_EMBED_PLIST_PY_EOF'
import json
import os
import pathlib
import plistlib
import sys
import tempfile

plist_path, config_path, server_path = map(pathlib.Path, sys.argv[1:])
# The launchd label predates HUD and can belong to a standalone PowerContext.
# Only upgrade an existing regular plist that already runs HUD's own server.
if plist_path.is_symlink() or not plist_path.is_file():
    sys.exit(0)
try:
    previous = plist_path.read_bytes()
    plist = plistlib.loads(previous)
except (OSError, ValueError, plistlib.InvalidFileException):
    sys.exit(0)
if not isinstance(plist, dict) or plist.get("Label") != "com.t3tools.powercontext-embed":
    sys.exit(0)
args = plist.get("ProgramArguments", [])
if not isinstance(args, list) or len(args) < 2 or args[1] != str(server_path):
    sys.exit(0)
try:
    config = json.loads(config_path.read_text())
except FileNotFoundError:
    config = {}
except (OSError, ValueError):
    sys.exit(0)
if not isinstance(config, dict):
    sys.exit(0)
fts_ids = ("fts5", "fts5-only", "fts5-zero-ram")
zero_memory = config.get("mode") in fts_ids or config.get("modelId") in fts_ids
keep_alive = not zero_memory and plist.get("KeepAlive") is not False
plist["KeepAlive"] = keep_alive
# RunAtLoad would also wake an explicitly stopped zero-memory job on login.
if not keep_alive:
    plist["RunAtLoad"] = False
env = plist.setdefault("EnvironmentVariables", {})
if not isinstance(env, dict):
    sys.exit(0)
env["HF_HUB_DISABLE_XET"] = "1"
if config.get("mode") == "mlx" and isinstance(config.get("modelId"), str) and config["modelId"]:
    env["EMBED_MODEL"] = config["modelId"]
    env["EMBED_NAME"] = config["modelId"].rsplit("/", 1)[-1]
data = plistlib.dumps(plist)
if data != previous:
    fd, name = tempfile.mkstemp(dir=plist_path.parent, prefix=".t3-hud-embed-")
    temporary = pathlib.Path(name)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
        if not plist_path.is_symlink() and plist_path.read_bytes() == previous:
            temporary.replace(plist_path)
    finally:
        temporary.unlink(missing_ok=True)
T3_EMBED_PLIST_PY_EOF
  then
    echo "[t3-hud] Existing Hub embedding job setup skipped. HUD installation will continue." >&2
  fi
fi
# T3_EMBED_LAUNCHD_UPGRADE_END

# Remove symlink hijack at BIN_DIR before copy: previous installs may have
# left ~/.t3/bin/t3-hud as a symlink to ~/.t3/userdata/attachments/... .
# cp to a symlink would follow it and update the stale userdata copy, leaving
# BIN_DIR as an indirection instead of the canonical regular file.
if [[ -L "$BIN_DIR/t3-hud" ]]; then
  rm -f "$BIN_DIR/t3-hud"
fi
cp "$SCRIPT_DIR/bin/t3-hud" "$BIN_DIR/t3-hud"
chmod +x "$BIN_DIR/t3-hud"
if [[ -f "$SCRIPT_DIR/bin/t3-mcp-router" ]]; then cp "$SCRIPT_DIR/bin/t3-mcp-router" "$BIN_DIR/t3-mcp-router"; chmod +x "$BIN_DIR/t3-mcp-router"; fi
if [[ -f "$SCRIPT_DIR/bin/t3-memory-setup" ]]; then
  if [[ -L "$BIN_DIR/t3-memory-setup" ]]; then
    echo "[t3-hud] 保留已有的 t3-memory-setup 链接，请在 Hub 中完成记忆接入。" >&2
  else
    cp "$SCRIPT_DIR/bin/t3-memory-setup" "$BIN_DIR/t3-memory-setup"
    chmod +x "$BIN_DIR/t3-memory-setup"
  fi
fi
for hs in pc-lite.mjs memory-setup.mjs memory-stop-hook.mjs subagent-route-guard.mjs; do
  if [[ -f "$SCRIPT_DIR/scripts/$hs" ]]; then
    mkdir -p "$BIN_DIR" "$HOME/.t3/hub/bin" "$DEST_DIR/scripts" 2>/dev/null || true
    # A standalone PowerContext may own the shared pc-lite command.
    if [[ "$hs" != pc-lite.mjs ]] || { [[ ! -L "$BIN_DIR/$hs" ]] &&
       { [[ ! -e "$BIN_DIR/$hs" ]] || cmp -s "$BIN_DIR/$hs" "$DEST_DIR/scripts/$hs"; }; }; then
      cp "$SCRIPT_DIR/scripts/$hs" "$BIN_DIR/$hs"
      chmod +x "$BIN_DIR/$hs"
    fi
    for hud_script_dir in "$HOME/.t3/hub/bin" "$DEST_DIR/scripts"; do
      if [[ ! -L "$hud_script_dir" && ! -L "$hud_script_dir/$hs" ]]; then
        cp "$SCRIPT_DIR/scripts/$hs" "$hud_script_dir/$hs"
        chmod +x "$hud_script_dir/$hs"
      fi
    done
  fi
done

JS_RUNNER=""
for cand in "${T3_APP_PATH:-}" "/Applications/T3 Code (Beta).app" "/Applications/T3 Code.app" "/Applications/T3 Code (Nightly).app" "$HOME/Applications/T3 Code (Beta).app" "$HOME/Applications/T3 Code.app" "$HOME/Applications/T3 Code (Nightly).app"; do
  if [[ -n "$cand" && -d "$cand/Contents/MacOS" ]]; then
    T3_CAND_BIN="$(find "$cand/Contents/MacOS" -maxdepth 1 -type f -perm +111 | head -n 1)"
    if [[ -n "$T3_CAND_BIN" && -x "$T3_CAND_BIN" ]]; then
      JS_RUNNER="$T3_CAND_BIN"
      break
    fi
  fi
done
if [[ -z "$JS_RUNNER" ]] && command -v node >/dev/null 2>&1; then
  JS_RUNNER="$(command -v node)"
fi

# Keep the release stamp in independent metadata so a later raw base copy
# cannot erase it. Stage the complete bundle before exposing it to a live T3.
# Embedding the drawer keeps it in the same CSP-safe executeJavaScript payload.
TMP_RENDERER="$(mktemp -d "$DEST_DIR/.t3-hud-renderer.XXXXXX")"
cp "$SCRIPT_DIR/src/renderer-ui.js" "$TMP_RENDERER/renderer-base.js"
printf '{"version":"%s"}\n' "$hud_release_version" > "$TMP_RENDERER/hud-release.json"
if [[ -n "$JS_RUNNER" ]]; then
  env -u NODE_OPTIONS ELECTRON_RUN_AS_NODE=1 "$JS_RUNNER" -e '
    const fs = require("node:fs"), path = require("node:path");
    const [pluginDir, stageDir, version] = process.argv.slice(1);
    const { assembleRenderer } = require(path.resolve(pluginDir, "hud-release.cjs"));
    const base = fs.readFileSync(path.join(stageDir, "renderer-base.js"), "utf8");
    const drawer = fs.readFileSync(path.join(pluginDir, "hub-drawer-ui.js"), "utf8");
    process.stdout.write(assembleRenderer(base, drawer, { version }));
  ' "$DEST_DIR" "$TMP_RENDERER" "$hud_release_version" > "$TMP_RENDERER/renderer-ui.js"
else
  # Allow installation before either T3 Code or Node is available. Both files
  # come straight from the source tree, so there are no old headers to remove.
  {
    printf 'window.__t3HubDrawerEmbedded = true;\nwindow.__t3HudReleaseVersion = "%s";\n' "$hud_release_version"
    cat "$TMP_RENDERER/renderer-base.js"
    printf '\n;/* __T3_HUB_DRAWER_EMBED_START__ */\n'
    cat "$DEST_DIR/hub-drawer-ui.js"
    printf '\n/* __T3_HUB_DRAWER_EMBED_END__ */\n'
  } > "$TMP_RENDERER/renderer-ui.js"
fi
chmod 0600 "$TMP_RENDERER/renderer-ui.js" "$TMP_RENDERER/renderer-base.js" "$TMP_RENDERER/hud-release.json"
for renderer_file in renderer-base.js hud-release.json renderer-ui.js; do
  mv -f "$TMP_RENDERER/$renderer_file" "$DEST_DIR/$renderer_file"
done

# Install only a new skill or the exact known legacy template; preserve custom
# instructions and symlinks. This does not start a host, model, or MCP process.
if [[ -n "$JS_RUNNER" && -f "$SCRIPT_DIR/scripts/install-memory-skill.cjs" ]]; then
  if ! env -u NODE_OPTIONS ELECTRON_RUN_AS_NODE=1 "$JS_RUNNER" "$SCRIPT_DIR/scripts/install-memory-skill.cjs"; then
    echo "[t3-hud] Memory skill setup skipped. HUD installation will continue." >&2
  fi
fi

if [[ -d "/opt/homebrew/bin" && -w "/opt/homebrew/bin" ]]; then
  ln -sf "$BIN_DIR/t3-hud" "/opt/homebrew/bin/t3-hud"
elif [[ -d "/usr/local/bin" && -w "/usr/local/bin" ]]; then
  ln -sf "$BIN_DIR/t3-hud" "/usr/local/bin/t3-hud"
else
  mkdir -p "$HOME/.local/bin"
  ln -sf "$BIN_DIR/t3-hud" "$HOME/.local/bin/t3-hud"
fi

# Create macOS Spotlight / Dock Launcher App ("~/Applications/T3 Code HUD.app")
APP_WRAPPER="$HOME/Applications/T3 Code HUD.app"
mkdir -p "$APP_WRAPPER/Contents/MacOS" "$APP_WRAPPER/Contents/Resources"

LAUNCHER_BIN="$APP_WRAPPER/Contents/MacOS/T3 Code HUD"
if command -v clang >/dev/null 2>&1; then
  TMP_LAUNCHER="$(mktemp -d "${TMPDIR:-/tmp}/t3-hud-launcher.XXXXXX")"
  LAUNCHER_SRC="$TMP_LAUNCHER/launcher.c"
  cat > "$LAUNCHER_SRC" <<'EOF'
#include <unistd.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
int main(void) {
  const char *home = getenv("HOME");
  if (!home || !home[0]) home = "/Users";
  char bin[4096];
  snprintf(bin, sizeof(bin), "%s/.t3/bin/t3-hud", home);
  char *args[] = { "t3-hud", "start", (char *)0 };
  execv(bin, args);
  return 1;
}
EOF
  if TMPDIR="$TMP_LAUNCHER" clang -arch arm64 -arch x86_64 -O2 -o "$LAUNCHER_BIN" "$LAUNCHER_SRC" >/dev/null 2>&1; then
    : # universal Mach-O launcher ready
  elif TMPDIR="$TMP_LAUNCHER" clang -O2 -o "$LAUNCHER_BIN" "$LAUNCHER_SRC" >/dev/null 2>&1; then
    : # single-arch fallback ready
  else
    cat > "$LAUNCHER_BIN" <<'EOF2'
#!/usr/bin/env bash
exec "$HOME/.t3/bin/t3-hud" start
EOF2
  fi
else
  cat > "$LAUNCHER_BIN" <<'EOF'
#!/usr/bin/env bash
exec "$HOME/.t3/bin/t3-hud" start
EOF
fi
chmod +x "$LAUNCHER_BIN"
cat > "$APP_WRAPPER/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>T3 Code HUD</string>
  <key>CFBundleIdentifier</key>
  <string>com.kingmaozi.t3code.hud</string>
  <key>CFBundleName</key>
  <string>T3 Code HUD</string>
  <key>CFBundleDisplayName</key>
  <string>T3 Code HUD</string>
  <key>CFBundleIconFile</key>
  <string>icon.icns</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
EOF

for candidate in "/Applications/T3 Code (Beta).app" "/Applications/T3 Code.app" "$HOME/Applications/T3 Code (Beta).app" "$HOME/Applications/T3 Code.app"; do
  if [[ -f "$candidate/Contents/Resources/icon.icns" ]]; then
    cp "$candidate/Contents/Resources/icon.icns" "$APP_WRAPPER/Contents/Resources/icon.icns" 2>/dev/null || true
    break
  fi
done

if command -v codesign >/dev/null 2>&1; then
  codesign --force --deep --sign - "$APP_WRAPPER" >/dev/null 2>&1 || true
fi

# ---------------------------------------------------------------------------
# Language detection: --lang en|zh | T3_HUD_LANG | auto-detect system locale
# ---------------------------------------------------------------------------
INSTALL_LANG=""
LANG_ARG=""
for arg in "$@"; do
  case "$arg" in
    --lang)
      # next arg is the value (handled below)
      ;;
    --lang=*) LANG_ARG="${arg#--lang=}" ;;
  esac
done
# Capture --lang <val> form
prev=""
for arg in "$@"; do
  if [[ "$prev" == "--lang" ]]; then
    LANG_ARG="$arg"
  fi
  prev="$arg"
done
if [[ -n "${T3_HUD_LANG:-}" && -z "$LANG_ARG" ]]; then
  LANG_ARG="$T3_HUD_LANG"
fi

detect_locale_lang() {
  local lc=""
  for v in "${LC_ALL:-}" "${LC_MESSAGES:-}" "${LANG:-}"; do
    if [[ -n "$v" ]]; then lc="$v"; break; fi
  done
  # macOS primary language: AppleLanguages prints multiline plist, e.g.
  #   (
  #       "zh-Hans-CN",
  #       "en-CN"
  #   )
  # Strip punctuation to extract the first language token.
  local apple_lang=""
  if command -v defaults >/dev/null 2>&1; then
    apple_lang="$(defaults read -g AppleLanguages 2>/dev/null | tr -d '()", \t' | grep -v '^$' | head -n 1 || true)"
  fi
  # Explicit locale wins, but a Chinese Mac reports LANG=en_US.UTF-8 in
  # Terminal, so AppleLanguages is checked before generic en LANG.
  if [[ "$lc" == zh* ]]; then
    echo "zh"
    return 0
  fi
  if [[ "$lc" == en* && "$apple_lang" != zh* ]]; then
    echo "en"
    return 0
  fi
  if [[ "$apple_lang" == zh* ]]; then
    echo "zh"
    return 0
  fi
  if [[ "$apple_lang" == en* ]]; then
    echo "en"
    return 0
  fi
  # If nothing conclusive, default zh
  echo "zh"
}

if [[ -n "$LANG_ARG" ]]; then
  if [[ "$LANG_ARG" == "zh" || "$LANG_ARG" == "en" ]]; then
    INSTALL_LANG="$LANG_ARG"
  else
    INSTALL_LANG="zh"
  fi
else
  INSTALL_LANG="$(detect_locale_lang)"
fi

mkdir -p "$DEST_DIR"
if [[ -n "$JS_RUNNER" && -x "$JS_RUNNER" ]]; then
  ELECTRON_RUN_AS_NODE=1 "$JS_RUNNER" -e '
    const fs = require("node:fs");
    const [cfgFile, defLang, explicitLang] = process.argv.slice(1);
    let d = {};
    try { d = JSON.parse(fs.readFileSync(cfgFile, "utf8")) || {}; } catch {}
    d.defaultLang = defLang;
    if (explicitLang === "zh" || explicitLang === "en") {
      d.userLang = explicitLang;
      d.langUpdatedAt = Date.now();
    }
    fs.writeFileSync(cfgFile, JSON.stringify(d, null, 2) + "\n", { mode: 0o600 });
  ' "$CONFIG_FILE" "$INSTALL_LANG" "$LANG_ARG"
elif [[ ! -f "$CONFIG_FILE" ]]; then
  if [[ "$LANG_ARG" == "zh" || "$LANG_ARG" == "en" ]]; then
    printf '{"defaultLang":"%s","userLang":"%s","langUpdatedAt":%s000}\n' "$INSTALL_LANG" "$LANG_ARG" "$(date +%s)" > "$CONFIG_FILE"
  else
    printf '{"defaultLang":"%s"}\n' "$INSTALL_LANG" > "$CONFIG_FILE"
  fi
  chmod 0600 "$CONFIG_FILE" 2>/dev/null || true
fi

# Private runtime directory
if [[ -L "$RUN_DIR" ]]; then
  rm -f "$RUN_DIR"
fi
mkdir -p "$RUN_DIR"
chmod 0700 "$RUN_DIR" 2>/dev/null || true

# Hot-reload a live T3 Code window automatically when re-running install.sh.
RPC_INFO_FILE="$RUN_DIR/rpc.json"
if [[ -f "$RUN_DIR/active.pid" ]]; then
  ACTIVE_PID="$(cat "$RUN_DIR/active.pid" 2>/dev/null || true)"
  if [[ "$ACTIVE_PID" =~ ^[0-9]+$ && -f "$RUN_DIR/rpc-$ACTIVE_PID.json" ]]; then
    RPC_INFO_FILE="$RUN_DIR/rpc-$ACTIVE_PID.json"
  fi
fi
if [[ -f "$RPC_INFO_FILE" ]]; then
  RPC_PID="$(grep -o '"pid"[[:space:]]*:[[:space:]]*[0-9]\+' "$RPC_INFO_FILE" 2>/dev/null | grep -o '[0-9]\+' | head -n 1 || true)"
  if [[ -n "${RPC_PID:-}" ]] && kill -0 "$RPC_PID" 2>/dev/null; then
    "$BIN_DIR/t3-hud" reload >/dev/null 2>&1 || true
  fi
fi

echo ""
if [[ "$INSTALL_LANG" == "zh" ]]; then
  echo "✅ T3 Code HUD 安装完成！(简体中文)"
  echo "   • 插件目录: $DEST_DIR"
  echo "   • 命令行工具: $BIN_DIR/t3-hud"
  echo "   • 桌面启动器: $APP_WRAPPER (可拖入 Dock 栏或用 Spotlight 启动)"
  echo "   • 语言配置: $CONFIG_FILE ({\"defaultLang\":\"zh\"})"
  echo ""
  echo "🚀 启用提示: 运行 't3-hud restart' (或 '~/.t3/bin/t3-hud restart') 即可生效！"
else
  echo "✅ T3 Code HUD installed! (English)"
  echo "   • Plugin dir: $DEST_DIR"
  echo "   • CLI tool: $BIN_DIR/t3-hud"
  echo "   • Launcher: $APP_WRAPPER (drag to Dock or launch via Spotlight)"
  echo "   • Language config: $CONFIG_FILE ({\"defaultLang\":\"en\"})"
  echo ""
  echo "🚀 Next step: run 't3-hud restart' (or '~/.t3/bin/t3-hud restart') to enable!"
fi
