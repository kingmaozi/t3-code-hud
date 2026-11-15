#!/usr/bin/env python3
"""T3 Hub local MLX embedding server (FastAPI).

Self-contained server compatible with /Users/longxiaking/powercontext-embed-eg2/.venv/bin/python.
Listens on 127.0.0.1:8001. Supports hot model switching without dropping the port.
"""
import asyncio
import gc
import os
import resource
import subprocess
import time
from contextlib import asynccontextmanager

import mlx.core as mx
import numpy as np
import uvicorn
from fastapi import FastAPI
from pydantic import BaseModel

MODEL_ID = os.environ.get("EMBED_MODEL", "mlx-community/Qwen3-Embedding-0.6B-8bit")
SERVED_NAME = os.environ.get("EMBED_NAME", "Qwen3-Embedding-0.6B-8bit")
MAX_LEN = int(os.environ.get("EMBED_MAX_LEN", "8192"))
PREFIX = os.environ.get("EMBED_PREFIX", "")
CACHE_LIMIT_MB = int(os.environ.get("EMBED_CACHE_LIMIT_MB", "256"))
CACHE_LIMIT_BYTES = max(0, CACHE_LIMIT_MB) * 1024 * 1024
BATCH_SIZE = max(1, int(os.environ.get("EMBED_BATCH_SIZE", "32")))

state = {"model": None, "tokenizer": None, "native_dim": None, "model_id": MODEL_ID, "served_name": SERVED_NAME}
lock = asyncio.Lock()


def _reclaim_cache():
    try:
        if mx.get_cache_memory() > CACHE_LIMIT_BYTES:
            mx.clear_cache()
    except Exception:
        pass


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


def _format_inputs_for_model(texts: list[str], model_id: str, input_type: str | None) -> list[str]:
    if PREFIX:
        return [PREFIX + t for t in texts]
    if input_type is None:
        return list(texts)
    mid = (model_id or "").lower()
    out: list[str] = []
    if input_type == "query":
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
    if input_type == "document":
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


def _load_model_sync(model_id):
    from mlx_vlm.embedding_loader import load_embedding_model
    from mlx_vlm.utils import get_model_path
    from transformers import AutoTokenizer

    mx.set_cache_limit(CACHE_LIMIT_BYTES)
    path = get_model_path(model_id)
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
    return model, tokenizer, dim


def load_model():
    model, tokenizer, dim = _load_model_sync(state["model_id"])
    state.update(model=model, tokenizer=tokenizer, native_dim=dim)
    return dim


@asynccontextmanager
async def lifespan(app):
    dim = await asyncio.to_thread(load_model)
    print(
        f"loaded {state['model_id']} dim={dim} prefix={PREFIX!r} cache_limit_mb={CACHE_LIMIT_MB} batch_size={BATCH_SIZE}",
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
    prepared = _format_inputs_for_model(list(texts), state.get("model_id", ""), input_type)
    chunks = []
    tokens = 0
    elapsed = 0.0
    for i in range(0, len(prepared), BATCH_SIZE):
        batch = prepared[i : i + BATCH_SIZE]
        enc = tokenizer(batch, padding=True, truncation=True, max_length=MAX_LEN, return_tensors="np")
        started = time.perf_counter()
        out = model(**{k: mx.array(v) for k, v in enc.items()})
        mx.eval(out.text_embeds)
        elapsed += time.perf_counter() - started
        chunks.append(np.array(out.text_embeds.astype(mx.float32), dtype=np.float32))
        tokens += int(np.asarray(enc["attention_mask"]).sum())
        del out
        _reclaim_cache()
    arr = chunks[0] if len(chunks) == 1 else np.concatenate(chunks, axis=0)
    if dimensions and 0 < dimensions < arr.shape[1]:
        arr = arr[:, :dimensions].copy()
    arr = arr / np.maximum(np.linalg.norm(arr, axis=1, keepdims=True), 1e-12)
    return arr, tokens, elapsed


@app.get("/health")
async def health():
    try:
        active_mb = round(mx.get_active_memory() / 1024**2, 1)
    except Exception:
        active_mb = 0.0
    try:
        cache_mb = round(mx.get_cache_memory() / 1024**2, 1)
    except Exception:
        cache_mb = 0.0
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
        "peakRssMb": peak_rss_mb,
        "peak_rss_mb": peak_rss_mb,
        "rss_mb": rss_mb,
        "active_mb": active_mb,
        "cache_mb": cache_mb,
        "cacheLimitMb": CACHE_LIMIT_MB,
        "cache_limit_mb": CACHE_LIMIT_MB,
    }


@app.get("/v1/models")
async def models():
    return {"object": "list", "data": [{"id": state["served_name"], "object": "model", "owned_by": "local"}]}


@app.post("/v1/embeddings")
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
        model, tokenizer, dim = _load_model_sync(model_id)
        state.update(model=model, tokenizer=tokenizer, native_dim=dim, model_id=model_id, served_name=served_name)
        return dim

    async with lock:
        dim = await asyncio.to_thread(_swap)
    rss_mb = _get_rss_mb()
    return {"ok": True, "modelId": model_id, "servedName": served_name, "dim": dim, "rssMb": rss_mb, "cacheLimitMb": CACHE_LIMIT_MB}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("PORT", "8001")))
