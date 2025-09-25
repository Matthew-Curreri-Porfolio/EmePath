#!/usr/bin/env python3
"""Minimal llama.cpp OpenAI-compatible stub used in tests.

The gateway talks to an upstream server that exposes `/v1/models`,
`/v1/completions`, and `/v1/chat/completions`.  The real llama.cpp
server is hefty, so for integration tests we spin up this tiny Python
HTTP server instead.  It exercises the same HTTP paths and response
shapes that the gateway relies on, without introducing JS mocks.
"""

import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer


_FIXTURES = {}
_fixture_path = os.environ.get("LLAMA_STUB_FIXTURES")
if _fixture_path:
    try:
        with open(_fixture_path, "r", encoding="utf-8") as fh:
            loaded = json.load(fh)
            if isinstance(loaded, dict):
                _FIXTURES = loaded
    except Exception as exc:  # pragma: no cover - fixture loading issues reported to stdout
        print(json.dumps({"error": "fixture_load_failed", "path": _fixture_path, "reason": str(exc)}), flush=True)


def _fixture(key, default=None):
    env_key = f"LLAMA_STUB_{key.upper()}"
    if env_key in os.environ:
        return os.environ[env_key]
    return _FIXTURES.get(key, default)


def _models_payload():
    models = _fixture("models")
    if isinstance(models, str):
        models = [m.strip() for m in models.split(",") if m.strip()]
    if models:
        data = []
        for item in models:
            if isinstance(item, dict):
                data.append({"id": item.get("id", "stub-model"), **{k: v for k, v in item.items() if k != "id"}})
            else:
                data.append({"id": str(item)})
        return {"data": data}
    return {"data": [{"id": "stub-model"}]}


def _bool_fixture(key):
    flag = _fixture(key)
    if flag is None:
        return False
    if isinstance(flag, bool):
        return flag
    return str(flag).lower() in {"1", "true", "yes"}


def _completion_response(prompt):
    text_override = _fixture("completion_text")
    status_override = _fixture("completion_status")
    try:
        status = int(status_override) if status_override is not None else 200
    except ValueError:
        status = 200

    if text_override is None:
        text_override = f"stub:{prompt[:16]}"

    body_override = _fixture("completion_body")
    if isinstance(body_override, dict):
        payload = body_override
    else:
        payload = {
            "id": "cmpl-stub",
            "object": "text_completion",
            "choices": [{"text": text_override}],
        }
    if _bool_fixture("completion_timeout"):
        return "timeout", None
    delay = float(_fixture("completion_delay", 0) or 0)
    if delay > 0:
        import time
        time.sleep(delay)
    return status, payload


def _chat_response():
    content_override = _fixture("chat_content")
    if content_override is None:
        content_override = "stub response"

    status_override = _fixture("chat_status")
    try:
        status = int(status_override) if status_override is not None else 200
    except ValueError:
        status = 200

    body_override = _fixture("chat_body")
    if isinstance(body_override, dict):
        payload = body_override
    else:
        payload = {
            "id": "chatcmpl-stub",
            "object": "chat.completion",
            "choices": [{"message": {"role": "assistant", "content": content_override}}],
        }
    if _bool_fixture("chat_timeout"):
        return "timeout", None
    delay = float(_fixture("chat_delay", 0) or 0)
    if delay > 0:
        import time
        time.sleep(delay)
    return status, payload


class _Handler(BaseHTTPRequestHandler):
    server_version = "llama-stub/0.1"

    def _send_json(self, payload, status=200):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):  # noqa: N802 (BaseHTTPRequestHandler signature)
        if self.path == "/v1/models":
            self._send_json(_models_payload())
        else:
            self._send_json({"error": "not found"}, status=404)

    def do_POST(self):  # noqa: N802 (BaseHTTPRequestHandler signature)
        length = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(body.decode("utf-8"))
        except json.JSONDecodeError:
            payload = {}

        global _FIXTURES
        if self.path == "/__fixture":
            if isinstance(payload, dict):
                if payload.get("reset"):
                    _FIXTURES.clear()
                else:
                    _FIXTURES.update({k: v for k, v in payload.items() if k != "reset"})
            self._send_json({"ok": True, "fixtures": _FIXTURES})
            return

        if self.path == "/v1/completions":
            prompt = str(payload.get("prompt", ""))
            status, body = _completion_response(prompt)
            if status == "timeout":
                try:
                    self.connection.close()
                finally:
                    return
            self._send_json(body, status=status)
        elif self.path == "/v1/chat/completions":
            status, body = _chat_response()
            if status == "timeout":
                try:
                    self.connection.close()
                finally:
                    return
            if payload.get("stream"):
                if isinstance(status, int) and status != 200:
                    self._send_json({"error": "stream error", "status": status}, status=status)
                    return
                self.send_response(200 if isinstance(status, int) else 200)
                self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
                self.send_header('Cache-Control', 'no-cache, no-transform')
                self.send_header('Connection', 'keep-alive')
                self.end_headers()
                chunks = _fixture('chat_stream_chunks')
                if isinstance(chunks, str):
                    chunks = [chunks]
                if not chunks:
                    chunks = [body.get('choices', [{}])[0].get('message', {}).get('content', 'stub response')]
                import time
                delay = float(_fixture('chat_delay', 0) or 0)
                for chunk in chunks:
                    evt = {
                        "id": body.get('id', 'chatcmpl-stub'),
                        "object": "chat.completion.chunk",
                        "choices": [{"delta": {"content": str(chunk)}}]
                    }
                    data = json.dumps(evt).encode('utf-8')
                    self.wfile.write(b"data: " + data + b"\n\n")
                    self.wfile.flush()
                    if delay > 0:
                        time.sleep(delay)
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
                return
            self._send_json(body, status=status)
        else:
            self._send_json({"error": "not found"}, status=404)

    # Silence default noisy logging during tests
    def log_message(self, _fmt, *_args):
        return


def main():
    host = os.environ.get("LLAMA_STUB_HOST", "127.0.0.1")
    port = int(os.environ.get("LLAMA_STUB_PORT", "0"))
    httpd = HTTPServer((host, port), _Handler)

    # Communicate the selected port back to the parent process via stdout.
    actual_port = httpd.server_address[1]
    print(json.dumps({"port": actual_port}), flush=True)

    # Serve forever on the main thread to keep signal handling simple.
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
