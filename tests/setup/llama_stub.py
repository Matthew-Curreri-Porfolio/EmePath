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
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer


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
            self._send_json({"data": [{"id": "stub-model"}]})
        else:
            self._send_json({"error": "not found"}, status=404)

    def do_POST(self):  # noqa: N802 (BaseHTTPRequestHandler signature)
        length = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(body.decode("utf-8"))
        except json.JSONDecodeError:
            payload = {}

        if self.path == "/v1/completions":
            prompt = str(payload.get("prompt", ""))
            text = f"stub:{prompt[:16]}"
            self._send_json({
                "id": "cmpl-stub",
                "object": "text_completion",
                "choices": [{"text": text}],
            })
        elif self.path == "/v1/chat/completions":
            self._send_json({
                "id": "chatcmpl-stub",
                "object": "chat.completion",
                "choices": [{"message": {"role": "assistant", "content": "stub response"}}],
            })
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
