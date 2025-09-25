# OSS Codex Gateway

Local inference gateway for llama.cpp with an OpenAI‑style chat API, streaming, search grounding (SearXNG), and a unified prompt system.

## Features

- REST endpoints for chat (`/chat`), streaming (`/chat/stream`), completion (`/complete`), warmup, models, research/insights, plan/debate/forecast/graph, memory, and tool dispatch
- llama.cpp integration (server on `/v1/*`)
- SearXNG search support via `/searxng` (JSON)
- Prompt registry (`gateway/prompts/prompts.json`) + composer with policy + role‑based affirmations
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

## Prompts

All system prompts live in `gateway/prompts/prompts.json` and are composed via `gateway/prompts/compose.js`:

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

## Model Selection

The gateway resolves models using Ollama manifests and prefers instruction/chat variants. You can override with:

- `LLAMA_MODEL_REF='namespace/name:tag'`
- `LLAMA_MODEL_PATH='/path/to/sha256-...'`

## Dev Notes

The stack orchestrator and helpers live in `/scripts`. The repo’s CI (`.github/workflows/ci.yml`) runs a preflight check and unit/integration tests.

