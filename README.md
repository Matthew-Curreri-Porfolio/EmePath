## OSS Codex — Monorepo Overview

This repo hosts the local inference gateway, prompt system, and supporting tools to run and test a self‑hosted LLM stack. The `gateway/` subproject can be used standalone.

### Quick Start

1. Install Node 20 and Docker (optional for SearXNG).

2. Install deps:

```
npm ci
```

3. Start the local stack (llama.cpp server, Ollama‑compatible proxy, gateway; reuses running services):

```
npm start
```

4. Health checks:

```
curl -s http://127.0.0.1:3123/health
curl -s http://127.0.0.1:8088/v1/models
```

Streaming feedback docs (chat and warmup): see `gateway/README.md` under “Streaming Feedback”.
You can also try the included SSE viewer script:

```
node scripts/sse_demo.js --url http://127.0.0.1:3123/chat/stream --data '{"messages":[{"role":"user","content":"hello"}]}'
node scripts/sse_demo.js --url http://127.0.0.1:3123/warmup/stream --data '{}'
```

### Configuration

Configuration is merged from:

- `gateway/config/defaults.json` (committed)
- `gateway/config/local.json` (git‑ignored) — your overrides
- Environment variables (highest precedence)

Key knobs:

- Ports: `LLAMACPP_PORT`, `OLLAMA_PROXY_PORT`, `GATEWAY_PORT`
- Search: `SEARXNG_BASE` (e.g., `http://127.0.0.1:8888`)
- Models: `MODEL_SEARCH_ROOTS`, `LLAMA_MODEL_REF`, `LLAMA_MODEL_PATH`
- Prompts: `PROMPT_INCLUDE_POLICY`, `PROMPT_INCLUDE_PERSONAL`, `PROMPT_PERSONAL_INDEX`, `PROMPT_PERSONAL_RANDOM`, `MATT`, `ROOT`, `SYSTEM`

Example local override (`gateway/config/local.json`):

```
{
  "ports": { "gateway": 4000 },
  "searxng": { "base": "http://127.0.0.1:8888" },
  "models": { "favorites": ["library/qwen3/8b"] },
  "prompts": { "includePolicy": true, "includePersonal": true, "personalIndex": 2 },
  "runtime": { "keepLlamaOnExit": true }
}
```

### Prompts

All system prompts are defined in `gateway/prompts/prompts.json` and composed via `gateway/prompts/compose.js`.

- Policy hierarchy: `policy.matt > policy.root > policy.system`
- Role‑based affirmation per tool (e.g., planner, forecaster)
- Preview any prompt:

```
curl "http://127.0.0.1:3123/prompts/preview?key=plan.system&envOs=linux"
```

### CI

GitHub Actions workflow runs `npm ci`, a lightweight stack check, and `vitest` tests. The check mode skips heavy llama checks on hosted runners.
