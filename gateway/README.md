# OSS Codex Gateway

Local inference gateway for a Python LoRA server with an OpenAI‑style chat API, streaming, search grounding (SearXNG), and a unified prompt system.

## Features

- REST endpoints for chat (`/chat`), streaming (`/chat/stream`), completion (`/complete`), warmup, models, research/insights, plan/debate/forecast/graph, memory, and tool dispatch
- LoRA server integration (FastAPI endpoints)
- SearXNG search support via `/searxng` (JSON)
- Prompt registry (`gateway/prompts/prompts.builder.js`) + composer with policy + role‑based affirmations
- Brain orchestrator (see `documents/brain_architecture.md`) for intent→goals→plan→agents
- Model suggestions: Unsloth/HF defaults for local runs

## Run (standalone)

```
npm ci
npm start
```

The starter orchestrator (`scripts/start-stack.js`) will reuse running services when present.

Python dependencies (for the LoRA server):

```
pip install -r requirements.txt
```

## Configuration

Config is merged from defaults → local → env.

- Defaults: `gateway/config/defaults.json`
- Local overrides (git‑ignored): `gateway/config/local.json`
- Env vars: highest precedence

Knobs:

- Ports: `LORA_SERVER_PORT`, `GATEWAY_PORT`
- Search: `SEARXNG_BASE`
- Model: `LORA_MODEL_NAME`, `LORA_MODEL_PATH`
- Python: `GATEWAY_PYTHON` or `PYTHON`
- GGUF (Python runner): optional `LLAMACPP_CTX` (default 2048), `LLAMACPP_THREADS` (default CPU count)
- Prompts:
  - `PROMPT_INCLUDE_POLICY=true|false`
  - `PROMPT_INCLUDE_PERSONAL=true|false`
  - `PROMPT_PERSONAL_INDEX=N` or `PROMPT_PERSONAL_RANDOM=1`
  - `MATT`, `ROOT`, `SYSTEM` names for policy placeholders

Example local overrides (`gateway/config/local.json`):

```
{
  "ports": { "gateway": 4000 },
  "searxng": { "base": "http://127.0.0.1:8888" },
  "models": { "favorites": ["unsloth/Qwen2.5-7B"] },
  "prompts": { "includePolicy": true, "includePersonal": true, "personalIndex": 0 },
  "runtime": {}
}
```

## Prompts

All system prompts live in `gateway/prompts/prompts.builder.js` and are composed via `gateway/prompts/compose.js`:

- Policy: `policy.matt` > `policy.root` > `policy.system`
- Role identities under `personal.roles` (e.g., `planner`, `forecaster`)
- Freeform affirmations in `personal.affirmations`
- Base prompts use `{{affirmation}}` and other variables (e.g., `{{envOs}}`, `{{horizonDays}}`)

Preview a prompt:

```
curl "http://127.0.0.1:3123/prompts/preview?key=plan.system&envOs=linux"
```

## Endpoints (selection)

- `POST /chat` — non‑stream chat (OpenAI style messages)
- `POST /chat/stream` — server‑sent events stream
- `POST /complete` — completion API
- `GET /models` — model list
- `GET /searxng?q=...&n=5` — SearXNG JSON results
- `POST /plan` — safe, verifiable runbook planner
- `GET /prompts/preview?key=...` — renders composed prompt text

## Local GGUF Inference

This gateway no longer uses a standalone `llama-server` binary. GGUF models are loaded and served in‑process by the Python LoRA server (`gateway/lora_server.py`) under the backend name `gguf-python`.

To enable GGUF inference:

- Install Python deps:
  - `pip install -r requirements.txt` (installs FastAPI, Uvicorn, and both GGUF runners)
- Or install a single backend manually if you prefer:
  - `pip install llama-cpp-python` or `pip install ctransformers`
- Start the stack normally (`npm start`). The Node gateway calls the Python LoRA server via HTTP.
- Load a model through the gateway:

```
curl -X POST http://127.0.0.1:8000/load_model \
  -H 'content-type: application/json' \
  -d '{"name":"local","model_path":"/path/to/model.gguf"}'
```

Optional environment tuning for the Python GGUF runner:

- `LLAMACPP_CTX` — context window (default `2048`)
- `LLAMACPP_THREADS` — CPU threads (default: CPU count)

Deprecated: previous `llama-server` flow and related env vars (e.g., `LLAMACPP_BIN`, `LLAMACPP_SERVER`) are no longer used. Any old runtime endpoints have been removed from routing.

### Projects (authenticated)

All project endpoints require a Bearer token from `/auth/login` and are scoped to the authenticated `userId` and `projectId` (legacy field `workspaceId`).

- `POST /projects` — create a project in scope
  - Body: `{ name: string, description?: string, active?: boolean }`
  - 409 if `name` already exists (unique)
- `GET /projects` — list all projects in scope (active and inactive)
- `GET /projects/active` — list active projects in scope
- `GET /projects/inactive` — list inactive projects in scope
- `PATCH /projects/:id/active` — set active flag
  - Body: `{ active: boolean }`

Example:

```
curl -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"alpha","description":"first"}' \
  http://127.0.0.1:3123/projects

curl -H "authorization: Bearer $TOKEN" http://127.0.0.1:3123/projects/active
curl -H "authorization: Bearer $TOKEN" http://127.0.0.1:3123/projects
curl -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -X PATCH -d '{"active":false}' http://127.0.0.1:3123/projects/1/active
```

## Streaming Feedback

### Chat Streaming (`POST /chat/stream`)

In addition to the model’s streaming chunks (SSE lines with `data: { ... }`), the gateway emits lightweight status events to help clients provide responsive UI while waiting for first tokens or handling errors:

- `data: {"event":"status","state":"connected"}` — emitted once after the connection is established
- `data: {"event":"status","state":"waiting"}` — heartbeat every ~1s until the first token arrives
- If a stream error occurs after headers are sent:
  - `data: {"event":"status","state":"error","reason":"..."}` is emitted before closing

Clients should ignore unknown `event=status` payloads if not needed; they are additive and won’t break existing consumers.

### Warmup with Feedback (`POST /warmup/stream`)

For readiness checks that may take a few seconds, use the SSE endpoint which reports progress:

- `data: {"event":"status","state":"starting"}`
- `data: {"event":"status","state":"waiting","ms":<elapsed_ms>}` heartbeats every ~1s
- On success: `data: {"event":"status","state":"ok","via":"server|cli"}`
- On failure: `data: {"event":"status","state":"error","error":"..."}`

Example curl (note: curl doesn’t render SSE prettily, but shows the lines):

```
curl -N -H 'accept: text/event-stream' -H 'content-type: application/json' \
  -X POST http://127.0.0.1:3123/warmup/stream -d '{}'
```

## CLI Demo: Stream Viewer

A tiny Node script is included to view SSE status and chunks from either endpoint:

```
node scripts/sse_demo.js --url http://127.0.0.1:3123/chat/stream --data '{"messages":[{"role":"user","content":"hello"}]}'
node scripts/sse_demo.js --url http://127.0.0.1:3123/warmup/stream --data '{}'
```

It prints each SSE line as it arrives and exits when the stream ends.

## Model Selection

The gateway defaults to Unsloth/HF model references. You can override with:

- `LORA_MODEL_NAME='my-model'`
- `LORA_MODEL_PATH='unsloth/Qwen2.5-7B'`

## SearXNG: Optional API Engines

By default only DuckDuckGo and Wikipedia are enabled (no API keys required). To enable API‑backed engines (e.g., Google via SerpAPI, Bing via SerpAPI, or Google Custom), edit `scripts/searxng/settings.yml` and add entries like:

```yaml
engines:
  # Google via SerpAPI
  - name: google (SerpAPI)
    engine: serpapi
    shortcut: g
    categories: general
    api_key: '${SERPAPI_API_KEY}'
    disabled: true # set to false when key is configured
    timeout: 4.0

  # Bing via SerpAPI
  - name: bing (SerpAPI)
    engine: serpapi
    shortcut: b
    categories: general
    api_key: '${SERPAPI_API_KEY}'
    disabled: true
    timeout: 4.0

  # Google Custom Search
  - name: google_custom
    engine: google_custom
    shortcut: gc
    categories: general
    api_key: '${GOOGLE_API_KEY}'
    cse_id: '${GOOGLE_CSE_ID}'
    disabled: true
    timeout: 4.0
```

Restart SearXNG after changes:

```
npm run searx:compose:down
npm run searx:compose:up
```

## Dev Notes

The stack orchestrator and helpers live in `/scripts`. The repo’s CI (`.github/workflows/ci.yml`) runs a preflight check and unit/integration tests.
