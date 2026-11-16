#!/usr/bin/env python3
"""T3 Hub local MLX embedding server (FastAPI) with dynamic memory ceiling.

Self-contained server compatible with /Users/longxiaking/powercontext-embed-eg2/.venv/bin/python.
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
