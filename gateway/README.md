# OSS Codex Gateway

Local inference gateway for llama.cpp with an OpenAI‑style chat API, streaming, search grounding (SearXNG), and a unified prompt system.

## Features

- REST endpoints for chat (`/chat`), streaming (`/chat/stream`), completion (`/complete`), warmup, models, research/insights, plan/debate/forecast/graph, memory, and tool dispatch
- llama.cpp integration (server on `/v1/*`)
- SearXNG search support via `/searxng` (JSON)
- Prompt registry (`gateway/prompts/prompts.builder.js`) + composer with policy + role‑based affirmations
- Model resolver: uses Ollama manifests (refs → digests → blobs) to auto‑select instruction‑tuned models

## Run (standalone)

```
npm ci
npm start
```

The starter orchestrator (`scripts/start-stack.js`) will reuse running services when present.

## Configuration

Config is merged from defaults → local → env.

- Defaults: `gateway/config/defaults.json`
- Local overrides (git‑ignored): `gateway/config/local.json`
- Env vars: highest precedence

Knobs:

- Ports: `LLAMACPP_PORT`, `OLLAMA_PROXY_PORT`, `GATEWAY_PORT`
- Search: `SEARXNG_BASE`
- Model search: `MODEL_SEARCH_ROOTS` (colon‑separated); model selection overrides via `LLAMA_MODEL_REF` or `LLAMA_MODEL_PATH`
- Python resolver for proxy: `GATEWAY_PYTHON` or `PYTHON`
- Prompts:
  - `PROMPT_INCLUDE_POLICY=true|false`
  - `PROMPT_INCLUDE_PERSONAL=true|false`
  - `PROMPT_PERSONAL_INDEX=N` or `PROMPT_PERSONAL_RANDOM=1`
  - `MATT`, `ROOT`, `SYSTEM` names for policy placeholders
  - Runtime: `STACK_KEEP_LLAMA=true|false` (default true; leave llama.cpp running on exit)

Example local overrides (`gateway/config/local.json`):

```
{
  "ports": { "gateway": 4000 },
  "searxng": { "base": "http://127.0.0.1:8888" },
  "models": { "favorites": ["jaahas/qwen3-abliterated/8b", "library/qwen3/8b"] },
  "prompts": { "includePolicy": true, "includePersonal": true, "personalIndex": 0 },
  "runtime": { "keepLlamaOnExit": true }
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

### Projects (authenticated)

All project endpoints require a Bearer token from `/auth/login` and are scoped to the authenticated `userId` and `workspaceId`.

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

The gateway resolves models using Ollama manifests and prefers instruction/chat variants. You can override with:

- `LLAMA_MODEL_REF='namespace/name:tag'`
- `LLAMA_MODEL_PATH='/path/to/sha256-...'`

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
