# Llama Stub Harness

The integration suite spins up `tests/setup/llama_stub.py`, a tiny HTTP server that
emulates the OpenAI-compatible llama.cpp API (`/v1/models`, `/v1/completions`,
`/v1/chat/completions`).

## Running it manually

```
npm run stub:llama
```

The script prints the chosen port and the `LLAMACPP_SERVER` export you can source to
point the gateway at the stub.

### Custom fixtures

You can override responses via JSON fixtures or CLI flags:

```
npm run stub:llama -- --fixture tests/fixtures/llama_stub.sample.json
```

Available flags (repeat as needed):

- `--fixture <path>` – load a JSON file with keys like `models`, `completion_text`,
  `chat_content`, `completion_status`, `chat_status`.
- `--completion-text <text>` – inline override for completion output.
- `--chat-content <text>` – inline override for chat output.
- `--completion-status <code>` / `--chat-status <code>` – force HTTP status codes.
- `--delay-completion <seconds>` / `--delay-chat <seconds>` – sleep before sending a response.
- `--timeout-completion` / `--timeout-chat` – close the connection without responding (simulates upstream timeouts).
- `--models <id1,id2>` – comma-separated list returned from `/v1/models`.
- `--env KEY=VALUE` – pass through arbitrary environment variables to the stub.

Environment variables take precedence over fixtures, allowing ad-hoc tweaks when
debugging. Sample presets live in `tests/fixtures/llama_stub.*.json` and have
corresponding npm scripts (`stub:llama:error`, `stub:llama:delay`, `stub:llama:stream`).
