## OSS Codex — Monorepo Overview

This repo hosts the local inference gateway, prompt system, and supporting tools to run and test a self‑hosted LLM stack. The `gateway/` subproject can be used standalone.

### Quick Start

1. Install Node 20 and Docker (optional for SearXNG).

2. Install deps:

```
npm ci
```

3. Start the local stack (Python LoRA server + gateway; reuses running services):

```
npm start
```

4. Health checks:

```
curl -s http://127.0.0.1:3123/health
curl -s http://127.0.0.1:3123/ready
curl -s http://127.0.0.1:8000/models
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

- Ports: `LORA_SERVER_PORT`, `GATEWAY_PORT`
- Search: `SEARXNG_BASE` (e.g., `http://127.0.0.1:8888`)
- Models: `LORA_MODEL_NAME`, `LORA_MODEL_PATH`
- Prompts: `PROMPT_INCLUDE_POLICY`, `PROMPT_INCLUDE_PERSONAL`, `PROMPT_PERSONAL_INDEX`, `PROMPT_PERSONAL_RANDOM`, `MATT`, `ROOT`, `SYSTEM`

Example local override (`gateway/config/local.json`):

```
{
  "ports": { "gateway": 4000 },
  "searxng": { "base": "http://127.0.0.1:8888" },
  "models": { "favorites": ["library/qwen3/8b"] },
  "prompts": { "includePolicy": true, "includePersonal": true, "personalIndex": 2 },
  "runtime": {}
}
```

### Prompts

All system prompts are defined programmatically in `gateway/prompts/prompts.builder.js` and composed via `gateway/prompts/compose.js`.

- Policy hierarchy: `policy.matt > policy.root > policy.system`
- Role‑based affirmation per tool (e.g., planner, forecaster)
- Preview any prompt:

```
curl "http://127.0.0.1:3123/prompts/preview?key=plan.system&envOs=linux"
```

### CI

GitHub Actions workflow runs `npm ci`, a lightweight stack check, and `vitest` tests.
# EmePath Service (LLM/Agent Orchestrator)

EmePath turns freeform text into actionable plans and kind‑aware agents (distill / scan / query) that operate on your local environment. It exposes a small HTTP API and uses a LoRA‑backed LLM if configured.

## Quick Start

1. Start the service:

   node EmePath.js --server --portStart 51100 --portEnd 51199

2. Plan and autorun distill (JSON in, text out):

   curl -s 'http://localhost:51100/process?format=text&autorun=true' -H 'content-type: application/json' -d '{"text":"Distill ./documents"}'

3. Interrupt at any time with a “double message” (two paragraphs). The service summarizes status, decides pause vs continue, and updates the plan:

   curl -s 'http://localhost:51100/interrupt?format=text' -H 'content-type: text/plain' --data-binary $'Change direction to prioritize security docs.\n\nUse only 2024 files.'

## No‑Model Mode and LoRA Bootstrap

If no LoRA model is configured (no `LORA_MODEL_PATH`), the service does not fail. Instead, it returns an offer to bootstrap a local, user‑curated dataset and provides a controller plan you can POST to `/control`.

Bootstrap flow produces:

- A local in‑memory index (scan)
- A distilled training dataset (JSONL + meta) under `data/training/`
- A training script at `runs/bootstrap/train.sh` that calls `tools/train_freeform_mode.py --mode lora`

To enable LoRA after training:

export LORA_MODEL_PATH=/path/to/base-model
export LORA_ADAPTERS="user=/path/to/runs/freeform-lora"

Then restart the service.

## Endpoints

- `POST /process` — plan + agent manifest. Accepts JSON or plain text. `?format=text` for text out. `?autorun=true` to auto‑execute kind‑aware agents. Optional `?background=true` for queued jobs.
- `POST /control` — LLM controller: updates, requirements, agent plans, actions (tools). Add `?loop=true&maxTurns=5` for multi‑turn control.
- `POST /interrupt` — Provide a “double message” mid‑flight. The system summarizes status, decides pause vs continue, updates plan, and can run actions.
- `POST /agent/checkin` — Agents post progress (supports EOT counters).
- `POST /pause` / `POST /resume` — Manual pause/resume.
- `GET /job/:id` — Poll background job status.
- `GET /health` — Basic info.

## Agents (Kinds)

- `distill` — Converts raw text/files into `{system,user,assistant}` JSONL (freeform CoT with failure+redemption captured in meta JSONL).
- `scan` — Indexes a directory (small files) into an in‑memory index.
- `query` — Queries the in‑memory index and writes hits to `data/query/`.

## Environment Survey and Replication

The planner and controller leverage the `work/standards` file to replicate a working area (e.g., directory duplication with dependency handling) and run tests before/after task execution. Use the `checklist` to require:

- `read_standards` — ensure standards are known
- `run_tests` — run vitest / npm test
- `file_exists` — assert required files exist

## Tools (Controller)

The controller can call tools by returning `actions[]` in its JSON output. Available tools:

- `survey_env {}` — Collect Node/npm/git and key project files and produce suggestions.
- `replicate_workspace { source?: '.', target?: 'work/replica', linkDependencies?: true }` — Create a replica workspace that copies key files and symlinks heavy deps like `node_modules`.
- `bootstrap_lora { allowTrain?: boolean, sources?: string[] }` — Scan and distill to produce a dataset and a ready-to-run training script (`runs/bootstrap/train.sh`).
- `suggest_fixes {}` — Analyze scripts/configs/CI to propose fixes, dependency updates, and feature ideas.
- `suggest_features { pattern? }` — Mine TODO/ROADMAP/issues from the indexed codebase and suggest potential features.
- `plan_agents { agents: [...] }` — Spawn agents on the orchestrator.
- `execute { kind: 'distill'|'scan'|'query', input, background? }` — Run a kind-aware executor.
- `read_standards {}` — Ensure `work/standards` is present.
- `run_tests {}` — Run tests via vitest or `npm run -s test`.

These tools can be combined in `actions` returned by `/control` or `/interrupt`.

## Privacy & Safety

EmePath only uses local files by default. When bootstrapping LoRA, review the `runs/bootstrap/train.sh` script before running. Do not expose sensitive data in datasets.

## Web UI and Chat + Memory Compression

- `GET /ui` — Minimal web UI showing projects, agent status, and a simple chat per project.
- `GET /projects` — Project list with status counts.
- `GET /status?project=ID` — Status snapshot for a project.
- `GET /chat?project=ID` — Last chat messages.
- `POST /chat` — `{ project, text }` simple chat endpoint with automatic memory summarization.

Each project has a single rolling conversation. The service periodically summarizes chat into short-term memory and then compresses into long-term memory using the LLM (or a naive fallback when no model is configured). When long-term memory grows beyond a threshold, it exports personalization JSONL under `data/training/personal.<project>.jsonl` suitable for training a personalization LoRA layer.
