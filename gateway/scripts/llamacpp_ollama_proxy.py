"""
Ollama-compatible proxy for llama.cpp (OpenAI-style) server.
Now enumerates local GGUF models (e.g., ~/models/**) and returns Ollama-shaped metadata.

Run:
  pip install fastapi uvicorn requests
  LLAMACPP_SERVER=http://127.0.0.1:8080 OLLAMA_LOCAL_MODELS=~/models python llamacpp_ollama_proxy.py
"""

import os, re, io, json, hashlib, time
from datetime import datetime, timezone
from typing import Optional, Dict, Any, Iterable, List

import requests
from fastapi import FastAPI, Response, Request
from fastapi.responses import JSONResponse, StreamingResponse, PlainTextResponse

BASE = (os.environ.get("LLAMACPP_SERVER") or "http://127.0.0.1:8080").rstrip("/")
GATEWAY_BASE = (os.environ.get("GATEWAY_SERVER") or "http://127.0.0.1:3123").rstrip("/")
TIMEOUT = float(os.environ.get("UPSTREAM_TIMEOUT", "300"))
APP_VERSION = os.environ.get("OLLAMA_PROXY_VERSION", "0.0.1-proxy")
LOCAL_MODELS_ROOT = os.path.expanduser(os.environ.get("OLLAMA_LOCAL_MODELS", "~/models")).rstrip("/")
DIGEST_CACHE = os.path.expanduser(os.environ.get("OLLAMA_PROXY_DIGEST_CACHE", "~/.cache/ollama-proxy/digests.json"))


# ---- In-memory keep-alive cache for /api/ps and load/unload semantics ----
_LOADED: dict[str, dict] = {}  # model -> {"name": str, "model": str, "size": int, "digest": str, "details": {...}, "expires_at": str, "size_vram": int}
_DEF_KEEP = 300.0  # seconds

def _touch_loaded(model: str, meta: dict, keep_alive: float | str | int | None):
    if keep_alive == 0 or keep_alive == "0":
        _LOADED.pop(model, None)
        return
    seconds = _DEF_KEEP
    if isinstance(keep_alive, (int,float)):
        seconds = float(keep_alive)
    elif isinstance(keep_alive, str):
        m = re.match(r"^\s*(\d+)([smhd]?)\s*$", keep_alive)
        if m:
            val, unit = int(m.group(1)), m.group(2) or "s"
            mul = {"s":1, "m":60, "h":3600, "d":86400}[unit]
            seconds = val * mul
    expires = time.time() + seconds
    meta = dict(meta or {})
    meta.setdefault("name", model)
    meta.setdefault("model", model)
    meta.setdefault("size", 0)
    meta.setdefault("digest", "")
    meta.setdefault("details", {"format":"gguf"})
    meta.setdefault("size_vram", meta.get("size", 0))
    meta["expires_at"] = datetime.fromtimestamp(expires, tz=timezone.utc).isoformat()
    _LOADED[model] = meta

def _gc_loaded():
    now = time.time()
    dead = []
    for k,v in list(_LOADED.items()):
        try:
            exp = datetime.fromisoformat(v.get("expires_at")).timestamp()
        except Exception:
            exp = now - 1
        if exp <= now:
            dead.append(k)
    for k in dead:
        _LOADED.pop(k, None)
app = FastAPI(title="llamacpp-ollama-proxy")

@app.get("/", include_in_schema=False)
def root():
    return PlainTextResponse("Ollama is running")
def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

def oops(status: int, msg: str):
    return JSONResponse({"ok": False, "error": msg}, status_code=status)

def _first_choice_text(obj: Dict[str, Any]) -> str:
    ch = (obj.get("choices") or [{}])[0]
    return ch.get("text") or ch.get("message", {}).get("content") or ""

def _norm_model_name(x: Dict[str, Any]) -> str:
    return x.get("id") or x.get("name") or "default"

def _map_opts_to_openai(opts: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    if "temperature" in opts: out["temperature"] = opts["temperature"]
    if "top_p" in opts: out["top_p"] = opts["top_p"]
    if "top_k" in opts: out["top_k"] = opts["top_k"]
    if "repeat_penalty" in opts: out["frequency_penalty"] = opts["repeat_penalty"]
    if "presence_penalty" in opts: out["presence_penalty"] = opts["presence_penalty"]
    if "num_predict" in opts: out["max_tokens"] = opts["num_predict"]
    if "stop" in opts: out["stop"] = opts["stop"]
    return out

# ---------- Local model discovery & digest cache ----------

_GGUF_RE = re.compile(r"(?i)(?P<base>.+?)(?:-(?P<quant>Q[0-9]_(?:[0-9A-Z_]+)|Q[0-9](?:_[0-9A-Z]+)?|IQ[0-9]_[A-Z]+|Q[0-9]+_[A-Z]+))?\.gguf$")
_PARAM_RE = re.compile(r"(?i)(?:^|[^A-Za-z0-9])(?P<params>[0-9]+[bB])(?:[^A-Za-z0-9]|$)")

def _load_digest_cache() -> Dict[str, Dict[str, Any]]:
    path = os.path.expanduser(DIGEST_CACHE)
    try:
        with open(path, "r") as f:
            return json.load(f)
    except Exception:
        return {}

def _save_digest_cache(cache: Dict[str, Dict[str, Any]]) -> None:
    path = os.path.expanduser(DIGEST_CACHE)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(cache, f)
    os.replace(tmp, path)

def _sha256_file(path: str) -> str:
    cache = _load_digest_cache()
    st = os.stat(path)
    key = os.path.abspath(path)
    ent = cache.get(key)
    if ent and ent.get("size") == st.st_size and ent.get("mtime") == int(st.st_mtime):
        return ent["sha256"]
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(16 * 1024 * 1024), b""):
            h.update(chunk)
    digest = h.hexdigest()
    cache[key] = {"sha256": digest, "size": st.st_size, "mtime": int(st.st_mtime)}
    _save_digest_cache(cache)
    return digest

def _param_size_from_name(name: str) -> Optional[str]:
    m = _PARAM_RE.search(name)
    if m:
        val = m.group("params").upper()
        return val.replace("B", "B")
    return None

def _quant_from_filename(fname: str) -> Optional[str]:
    m = _GGUF_RE.match(os.path.basename(fname))
    if m and m.group("quant"):
        return m.group("quant").upper()
    return None

def _ollama_model_entry_from_file(path: str) -> Dict[str, Any]:
    st = os.stat(path)
    name = os.path.splitext(os.path.basename(path))[0]
    quant = _quant_from_filename(path) or ""
    param = _param_size_from_name(name) or ""
    details = {
        "format": "gguf",
        "family": None,
        "families": [],
        "parent_model": None,
        "parameter_size": param,       # e.g., "4B", "30B"
        "quantization": quant,         # e.g., "Q6_K", "Q5_K_M", "IQ4_NL"
        "adapter_map": None,
    }
    return {
        "name": name,
        "modified_at": datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat(),
        "size": st.st_size,
        "digest": _sha256_file(path),
        "details": details,
        "expires_at": None,
    }

def _scan_local_models() -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    root = LOCAL_MODELS_ROOT
    if not os.path.isdir(root):
        return out
    for base, dirs, files in os.walk(root):
        for fn in files:
            if fn.lower().endswith(".gguf"):
                full = os.path.join(base, fn)
                try:
                    out.append(_ollama_model_entry_from_file(full))
                except Exception:
                    continue
    # stable sort by name
    out.sort(key=lambda x: x["name"])
    return out

def _find_local_model(name: str) -> Optional[Dict[str, Any]]:
    # exact match by computed "name" (filename-minus-ext)
    for m in _scan_local_models():
        if m["name"] == name:
            return m
    return None

# ---------- API ----------

@app.get("/api/version")
def api_version():
    return {"version": APP_VERSION}


_BLOB_DIR = os.path.expanduser(os.environ.get("OLLAMA_PROXY_BLOB_DIR", "/home/sandbox/.cache/ollama-proxy/blobs"))
os.makedirs(_BLOB_DIR, exist_ok=True)

def _blob_path(digest: str) -> str:
    digest = digest.strip()
    if not digest.startswith("sha256:"):
        raise ValueError("digest must start with sha256:")
    return os.path.join(_BLOB_DIR, digest.replace("sha256:", "sha256-"))

@app.head("/api/blobs/{{digest}}")
def api_blob_head(digest: str, response: Response):
    try:
        p = _blob_path(digest)
    except Exception as e:
        return oops(400, str(e))
    if os.path.isfile(p):
        response.status_code = 200
        return Response()
    response.status_code = 404
    return Response()

@app.post("/api/blobs/{{digest}}")
def api_blob_post(digest: str, request: Request):
    try:
        p = _blob_path(digest)
    except Exception as e:
        return oops(400, str(e))
    h = hashlib.sha256()
    tmp = p + ".part"
    with open(tmp, "wb") as f:
        for chunk in request.stream():
            if isinstance(chunk, bytes):
                f.write(chunk); h.update(chunk)
            else:
                data = chunk if isinstance(chunk, (bytes, bytearray)) else bytes(chunk)
                f.write(data); h.update(data)
    got = "sha256:" + h.hexdigest()
    if got != digest:
        try: os.remove(tmp)
        except Exception: pass
        return oops(400, f"digest mismatch expected={{digest}} got={{got}}")
    os.replace(tmp, p)
    return JSONResponse(status_code=201, content={"status": "created"})

@app.get("/api/tags")
def api_tags():
    try:
        local = _scan_local_models()
        return {"models": local}
    except Exception as e:
        return oops(500, f"scan error: {e}")

@app.get("/api/ps")
def api_ps():
    _gc_loaded()
    return {"models": list(_LOADED.values())}

@app.get("/v1/models")
def list_models():
    try:
        r = requests.get(f"{GATEWAY_BASE}/models", timeout=TIMEOUT)
        r.raise_for_status()
        payload = r.json()  # expect: { models: [...] }
        models = payload.get("models") or []
        # Normalize to OpenAI shape expected by your client: { data: [{id: ...}] }
        data = []
        for m in models:
            if isinstance(m, dict):
                mid = m.get("name") or m.get("id") or m.get("model") or "default"
            else:
                # m could be a path or a name; prefer basename without extension
                mid = os.path.splitext(os.path.basename(str(m)))[0] or str(m)
            data.append({"id": str(mid)})
        return {"object": "list", "data": data}
    except Exception as e:
        return oops(502, f"gateway fetch error: {e}")

@app.post("/api/show")
def api_show(payload: Dict[str, Any]):
    model = payload.get("name") or payload.get("model") or ""
    if not model:
        return oops(400, "missing model name")
    m = _find_local_model(model)
    if not m:
        return oops(404, f"model not found: {model}")
    return {
        "license": "",
        "modelfile": "",
        "parameters": "",
        "template": "",
        "system": "",
        "messages": [],
        "projector": None,
        "notes": {"general": ""},
        "model_info": {
            "model": m["name"],
            "digest": m["digest"],
            "size": m["size"],
            "modified_at": m["modified_at"],
            "details": m["details"],
        },
    }

def _o_ndjson(line: Dict[str, Any]) -> str:
    return json.dumps(line, ensure_ascii=False) + "\n"

def _sse_to_generate_ndjson(resp: requests.Response, model: str) -> Iterable[str]:
    acc = ""
    for raw in resp.iter_lines(decode_unicode=True):
        if not raw: continue
        s = raw.strip()
        if not s.startswith("data:"): continue
        chunk = s[5:].strip()
        if chunk == "[DONE]":
            yield _o_ndjson({"model": model, "created_at": now_iso(), "response": acc, "done": True})
            break
        try:
            d = json.loads(chunk)
        except Exception:
            continue
        txt = _first_choice_text(d)
        if txt:
            acc += txt
            yield _o_ndjson({"model": model, "created_at": now_iso(), "response": txt, "done": False})

def _sse_to_chat_ndjson(resp: requests.Response, model: str) -> Iterable[str]:
    buf = ""
    for raw in resp.iter_lines(decode_unicode=True):
        if not raw: continue
        s = raw.strip()
        if not s.startswith("data:"): continue
        chunk = s[5:].strip()
        if chunk == "[DONE]":
            if buf:
                yield _o_ndjson({
                    "model": model,
                    "created_at": now_iso(),
                    "message": {"role": "assistant", "content": buf},
                    "done": False,
                })
            yield _o_ndjson({"model": model, "created_at": now_iso(), "message": None, "done": True})
            break
        try:
            d = json.loads(chunk)
        except Exception:
            continue
        for choice in d.get("choices", []):
            delta = (choice.get("delta") or {})
            content = delta.get("content")
            if content:
                buf += content
                yield _o_ndjson({
                    "model": model,
                    "created_at": now_iso(),
                    "message": {"role": "assistant", "content": content},
                    "done": False,
                })

@app.post("/api/generate")
def api_generate(payload: Dict[str, Any]):
    # TODO: support "format":"json" and JSON-schema enforcement with validate+retry
    # TODO: support "suffix", "system", "template", "raw", "images[]" passthrough based on model capabilities
    prompt = str(payload.get("prompt", ""))
    model = payload.get("model") or "default"
    opts = payload.get("options") or {}
    stream = bool(payload.get("stream", False))
    oai = {"model": model, "prompt": prompt, "stream": stream}
    oai.update(_map_opts_to_openai(opts))
    try:
        if stream:
            r = requests.post(f"{BASE}/v1/completions", json=oai, stream=True, timeout=TIMEOUT)
            if r.status_code != 200:
                return oops(502, f"upstream status {r.status_code}: {r.text[:200]}")
            return StreamingResponse(_sse_to_generate_ndjson(r, model), media_type="application/x-ndjson")
        else:
            r = requests.post(f"{BASE}/v1/completions", json=oai, timeout=TIMEOUT)
            r.raise_for_status()
            d = r.json()
            text = _first_choice_text(d)
            return {"model": model, "created_at": now_iso(), "response": text, "done": True}
    except Exception as e:
        return oops(502, f"upstream error: {e}")

@app.post("/api/chat")
def api_chat(req: Request, payload: Dict[str, Any]):
    # TODO: tools/function calling: surface tool_calls; forward tool schema to upstream if supported
    # TODO: per-message images[]; JSON-schema outputs via "format"
    model = payload.get("model") or "default"
    opts = payload.get("options") or {}
    stream = bool(payload.get("stream", True))
    messages = payload.get("messages") or []
    msgs = [{"role": (m.get("role") or "user"), "content": str(m.get("content") or "")} for m in messages]
    body = {"model": model, "messages": msgs, "stream": stream}
    body.update(_map_opts_to_openai(opts))
    try:
        if stream:
            r = requests.post(f"{BASE}/v1/chat/completions", json=body, stream=True, timeout=TIMEOUT)
            if r.status_code != 200:
                return oops(502, f"upstream status {r.status_code}: {r.text[:200]}")
            return StreamingResponse(_sse_to_chat_ndjson(r, model), media_type="application/x-ndjson")
        else:
            r = requests.post(f"{BASE}/v1/chat/completions", json=body, timeout=TIMEOUT)
            r.raise_for_status()
            d = r.json()
            content = _first_choice_text(d)
            return {"model": model, "created_at": now_iso(), "message": {"role": "assistant", "content": content}, "done": True}
    except Exception as e:
        return oops(502, f"upstream error: {e}")

@app.post("/api/pull")
def api_pull(payload: Dict[str, Any]):
    name = payload.get("name") or payload.get("model") or "default"
    def gen():
        yield json.dumps({"status": f"pulling {name}", "digest": "", "total": 1, "completed": 1}) + "\n"
        yield json.dumps({"status": "success"}) + "\n"
    return StreamingResponse(gen(), media_type="application/x-ndjson")

@app.post("/api/create")
def api_create(payload: Dict[str, Any]):
    def gen():
        yield json.dumps({"status": "creating model"}) + "\n"
        yield json.dumps({"status": "success"}) + "\n"
    return StreamingResponse(gen(), media_type="application/x-ndjson")

@app.post("/api/copy")
def api_copy(payload: Dict[str, Any]):
    return {"status": "success"}


@app.post("/api/embed")
def api_embed(payload: Dict[str, Any]):
    model = payload.get("model") or payload.get("name")
    if not model:
        return oops(400, "missing model name")
    inputs = payload.get("input")
    if inputs is None:
        return oops(400, "missing 'input'")
    keep_alive = payload.get("keep_alive", None)
    oai = {"model": model, "input": inputs}
    try:
        r = requests.post(f"{BASE}/v1/embeddings", json=oai, timeout=TIMEOUT, stream=False)
        r.raise_for_status()
        obj = r.json()
        vecs = [d["embedding"] for d in (obj.get("data") or [])] if isinstance(inputs, list) else [obj["data"][0]["embedding"]]
        _touch_loaded(model, {"details":{"format":"gguf"}}, keep_alive)
        return {"model": model, "embeddings": vecs, "total_duration": 0, "load_duration": 0, "prompt_eval_count": 0}
    except Exception as e:
        return oops(502, f"upstream embeddings error: {e}")

@app.post("/api/embeddings")
def api_embeddings(payload: Dict[str, Any]):
    model = payload.get("model")
    prompt = payload.get("prompt")
    if not model or prompt is None:
        return oops(400, "missing 'model' or 'prompt'")
    try:
        r = requests.post(f"{BASE}/v1/embeddings", json={"model": model, "input": prompt}, timeout=TIMEOUT)
        r.raise_for_status()
        obj = r.json()
        emb = obj["data"][0]["embedding"]
        return {"embedding": emb}
    except Exception as e:
        return oops(502, f"upstream embeddings error: {e}")

@app.delete("/api/delete")
def api_delete(payload: Dict[str, Any]):
    name = payload.get("name") or payload.get("model")
    if not name:
        return oops(400, "missing model name")
    m = _find_local_model(name)
    if not m:
        return oops(404, "model not found")
    # best-effort file removal by recomputing path from name
    # search again and remove the first match
    removed = False
    for base, _, files in os.walk(LOCAL_MODELS_ROOT):
        for fn in files:
            if fn.lower().endswith(".gguf") and os.path.splitext(fn)[0] == name:
                try:
                    os.remove(os.path.join(base, fn))
                    removed = True
                    break
                except Exception:
                    pass
        if removed: break
    return {"status": "success" if removed else "not_found"}

@app.post("/api/refresh")
def api_refresh():
    return {"status": "success"}

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT") or 11435)
    uvicorn.run(app, host="0.0.0.0", port=port)
