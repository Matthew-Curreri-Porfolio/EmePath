"""
Ollama-compatible proxy for llama.cpp (OpenAI-style) server.

Exposes a minimal subset of the Ollama API and forwards to llama.cpp:
- GET /api/tags           -> GET  {LLAMACPP_SERVER}/v1/models
- POST /api/chat          -> POST {LLAMACPP_SERVER}/v1/chat/completions (stream or non-stream)
- POST /api/generate      -> POST {LLAMACPP_SERVER}/v1/completions (non-stream)

Run:
  pip install fastapi uvicorn requests
  LLAMACPP_SERVER=http://127.0.0.1:8080 python gateway/scripts/llamacpp_ollama_proxy.py

Notes:
- Streaming translation: OpenAI SSE -> Ollama NDJSON lines
- This is a lightweight bridge for local use; extend as needed
"""

import os
import json
import time
from datetime import datetime, timezone
from typing import Optional, Dict, Any

import requests
from fastapi import FastAPI, Response, Request
from fastapi.responses import JSONResponse, StreamingResponse

BASE = (os.environ.get("LLAMACPP_SERVER") or "http://127.0.0.1:8080").rstrip("/")

app = FastAPI(title="llamacpp-ollama-proxy")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def oops(status: int, msg: str):
    return JSONResponse({"ok": False, "error": msg}, status_code=status)


@app.get("/api/tags")
def api_tags():
    try:
        r = requests.get(f"{BASE}/v1/models", timeout=15)
        r.raise_for_status()
        data = r.json() if r.text else {}
        models = []
        for x in (data.get("data") or []):
            name = x.get("id") or x.get("name") or "default"
            models.append({"name": name})
        return {"models": models}
    except Exception as e:
        return oops(502, f"upstream error: {e}")


@app.post("/api/generate")
def api_generate(payload: Dict[str, Any]):
    prompt = str(payload.get("prompt", ""))
    model = payload.get("model") or "default"
    temperature = payload.get("options", {}).get("temperature", 0.2)
    max_tokens = payload.get("options", {}).get("num_predict")
    body = {"model": model, "prompt": prompt, "temperature": temperature, "stream": False}
    if isinstance(max_tokens, int):
        body["max_tokens"] = max_tokens
    try:
        r = requests.post(f"{BASE}/v1/completions", json=body, timeout=120)
        r.raise_for_status()
        d = r.json()
        text = (d.get("choices") or [{}])[0].get("text") or ""
        return {
            "model": model,
            "created_at": now_iso(),
            "response": text,
            "done": True,
        }
    except Exception as e:
        return oops(502, f"upstream error: {e}")


def _sse_to_ollama_ndjson_lines(resp: requests.Response, model: str):
    # Convert OpenAI SSE stream to Ollama-like NDJSON message stream
    # Upstream provides lines like: "data: {json}\n" and ends with "data: [DONE]"
    for raw in resp.iter_lines(decode_unicode=False):
        if not raw:
            continue
        try:
            line = raw.decode("utf-8", errors="ignore").strip()
        except Exception:
            continue
        if not line.startswith("data:"):
            continue
        chunk = line[5:].strip()
        if chunk == "[DONE]":
            yield json.dumps({"model": model, "created_at": now_iso(), "message": None, "done": True}) + "\n"
            break
        try:
            d = json.loads(chunk)
        except Exception:
            continue
        # OpenAI-style delta chunk
        content = ""
        choices = d.get("choices") or []
        if choices:
            delta = choices[0].get("delta") or {}
            content = delta.get("content") or ""
        if content:
            out = {
                "model": model,
                "created_at": now_iso(),
                "message": {"role": "assistant", "content": content},
                "done": False,
            }
            yield json.dumps(out) + "\n"


@app.post("/api/chat")
def api_chat(req: Request, payload: Dict[str, Any]):
    model = payload.get("model") or "default"
    temperature = payload.get("options", {}).get("temperature", 0.2)
    max_tokens = payload.get("options", {}).get("num_predict")
    stream = bool(payload.get("stream", True))
    messages = payload.get("messages") or []
    msgs = []
    for m in messages:
        role = m.get("role") or "user"
        content = str(m.get("content") or "")
        msgs.append({"role": role, "content": content})

    body = {"model": model, "messages": msgs, "temperature": temperature}
    if isinstance(max_tokens, int):
        body["max_tokens"] = max_tokens

    if stream:
        # request SSE and translate to NDJSON
        body["stream"] = True
        try:
            r = requests.post(f"{BASE}/v1/chat/completions", json=body, stream=True, timeout=120)
            if r.status_code != 200:
                return oops(502, f"upstream status {r.status_code}: {r.text[:200]}")
            return StreamingResponse(
                _sse_to_ollama_ndjson_lines(r, model),
                media_type="application/x-ndjson",
            )
        except Exception as e:
            return oops(502, f"upstream error: {e}")
    else:
        body["stream"] = False
        try:
            r = requests.post(f"{BASE}/v1/chat/completions", json=body, timeout=120)
            r.raise_for_status()
            d = r.json()
            content = (d.get("choices") or [{}])[0].get("message", {}).get("content") or ""
            return {
                "model": model,
                "created_at": now_iso(),
                "message": {"role": "assistant", "content": content},
                "done": True,
            }
        except Exception as e:
            return oops(502, f"upstream error: {e}")


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT") or 11434)
    uvicorn.run(app, host="0.0.0.0", port=port)

