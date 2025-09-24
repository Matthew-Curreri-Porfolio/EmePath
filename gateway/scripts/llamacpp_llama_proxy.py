def _sse_to_ollama_ndjson_lines(resp: requests.Response, model: str):
    # Accumulate assistant content and emit a single NDJSON line at the end
    full_content = ""
    for raw in resp.iter_lines(decode_unicode=True):
        if not raw:
            continue
        line = raw.strip()
        if not line.startswith("data:"):
            continue
        chunk = line[5:].strip()
        if chunk == "[DONE]":
            # Emit final done line
            yield json.dumps({
                "model": model,
                "created_at": now_iso(),
                "message": None,
                "done": True,
            }) + "\n"
            break
        try:
            d = json.loads(chunk)
        except Exception:
            continue
        if "choices" in d:
            for choice in d["choices"]:
                delta = choice.get("delta", {})
                content = delta.get("content")
                if content:
                    full_content += content
    if full_content:
        yield json.dumps({
            "model": model,
            "created_at": now_iso(),
            "message": {"role": "assistant", "content": full_content},
            "done": False,
        }) + "\n"
