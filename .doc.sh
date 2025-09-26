#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   bash scripts/scaffold_emepath_docs.sh
#
# Assumptions:
# - Run from the repo root (e.g., /EmePath or /EmePath after rename).
# - Creates/updates ./docs with a Diátaxis-friendly structure.

REPO_ROOT="$(pwd)"
DOCS_DIR="${REPO_ROOT}/docs"

echo "[EmePath] Scaffolding docs in: ${DOCS_DIR}"
mkdir -p "${DOCS_DIR}"/{tutorials,how-to,reference,explanation,runbooks,architecture,api,models,security,operations,decisions,brand}

# --- Root docs ---------------------------------------------------------------

cat > "${DOCS_DIR}/README.md" <<'MD'
# EmePath Docs

EmePath is a local-first knowledge orchestration stack: retrieval, reasoning, adapters (LoRA/QLoRA), and serving—unified behind a simple gateway.

## Documentation map (Diátaxis)
- **Tutorials**: Learn by doing from a clean slate (`/docs/tutorials/`)
- **How-to guides**: Stepwise recipes for specific outcomes (`/docs/how-to/`)
- **Reference**: APIs, configs, CLI flags, schema (`/docs/reference/`, `/docs/api/`)
- **Explanation**: Concepts, vision, architecture rationale (`/docs/explanation/`, `/docs/architecture/`)

MD

cat > "${DOCS_DIR}/VISION.md" <<'MD'
# EmePath — Vision

EmePath charts a **path through language** to accelerate knowledge work on your own hardware. It favors:
- Local control and reproducibility
- Adapter-centric customization (LoRA/QLoRA)
- Clear contracts, observable behaviors, and rollback-first ops

Success = shorter time-to-answer, trustworthy outputs, and low operational friction.

MD

# --- Name origin -------------------------------------------------------------

cat > "${DOCS_DIR}/NAME_ORIGIN.md" <<'MD'
# Name Origin — EmePath

**Eme** (Sumerian 𒅴) means “language” or “tongue.” The compound **eme-gir** (𒅴𒂠; also *eme-gi*) denotes the **Sumerian native language/dialect**.  
**Path** emphasizes the journey—from raw text to actionable understanding.

Together, **EmePath** signals a route through language toward knowledge.

> Notes for maintainers:
> - See external references for **eme / eme-gir** in Sumerian studies and lexical sources.
> - Keep this page concise for branding and onboarding decks.

MD

# --- Tutorials (learn by doing) ---------------------------------------------

cat > "${DOCS_DIR}/tutorials/GETTING_STARTED.md" <<'MD'
# Tutorial — Getting Started with EmePath

Goal: run the gateway, load a base model, attach a LoRA, and query.

1) **Install deps** (GPU optional).  
2) **Start gateway** and verify `/health`.  
3) **Load base + adapters** via CLI or API.  
4) **Send first query** and inspect logs/latency.  
5) **Cleanup**: stop processes; persist configs.

> When unsure, prefer defaults. Record deviations in `/docs/decisions/`.

MD

# --- How-to guides (recipes) -------------------------------------------------

cat > "${DOCS_DIR}/how-to/LOAD_MODELS_AND_LORAS.md" <<'MD'
# How-to — Load Base Models and LoRA Adapters

**Outcome:** Base weights resident once; N adapters hot-selectable.

- Place models under `models/base/` and adapters under `models/loras/`
- Use the gateway `/load_model` endpoint or CLI
- Verify memory and adapter routing via `/models` and `/models/{name}/loras`
- Add health checks and per-adapter smoke tests

MD

cat > "${DOCS_DIR}/how-to/FINETUNE_WITH_LORA.md" <<'MD'
# How-to — Fine-tune with LoRA/QLoRA

**Outcome:** Produce a LoRA adapter without altering base weights.

- Prepare dataset (license, PII scrub, splits)  
- Configure LoRA (r, alpha, dropout, target modules)  
- Train, checkpoint, evaluate; export adapter  
- Register adapter metadata in `/docs/models/MODEL_CARD_*.md`

MD

# --- Reference ---------------------------------------------------------------

cat > "${DOCS_DIR}/reference/CONFIG.md" <<'MD'
# Reference — Configuration

- **Models**: paths, quant, context length, draft/speculative decode flags  
- **Adapters**: names, priority/routing, warm cache  
- **Gateway**: ports, SSE, auth, rate limiting, CORS  
- **Storage**: logs, traces, metrics, artifacts  
- **Schemas**: request/response contracts

MD

# --- API ---------------------------------------------------------------------

cat > "${DOCS_DIR}/api/CHAT.md" <<'MD'
# API — Chat & Completion

**Endpoints**
- `POST /chat` — non-streaming
- `POST /chat/stream` — SSE streaming
- `POST /complete` — code/text completion

**Headers**: `content-type: application/json`, optional `authorization`  
**Error model**: `{ "error": "message", "code": "..." }`

MD

cat > "${DOCS_DIR}/api/MODEL_ADMIN.md" <<'MD'
# API — Model & Adapter Admin

- `POST /load_model` — load base + adapters
- `GET /models` — list loaded bases
- `GET /models/{name}/loras` — list adapters for a base
- `POST /inference` — select base+adapter and generate

Include idempotency keys for admin ops. Log adapter routing decisions.

MD

# --- Explanation / Architecture ---------------------------------------------

cat > "${DOCS_DIR}/explanation/ADAPTERS.md" <<'MD'
# Explanation — Why Adapters (LoRA/QLoRA)

Adapters add low-rank updates **ΔW** to frozen base weights, yielding specialization without duplicating parameters.  
Benefits: small artifacts, fast iteration, safer rollbacks.

MD

cat > "${DOCS_DIR}/architecture/OVERVIEW.md" <<'MD'
# Architecture — Overview

- **Gateway**: HTTP/SSE, auth, rate limiters, observability hooks  
- **Model Runtimes**: CPU/GPU backends; one base loaded once; N adapters resident  
- **Routing**: per-adapter selection; policy-driven; A/B toggles  
- **Storage**: logs, traces, eval artifacts, run metadata

MD

# --- Operations / Runbooks ---------------------------------------------------

cat > "${DOCS_DIR}/runbooks/ROLLBACK.md" <<'MD'
# Runbook — Safe Rollback

1) Drain traffic; freeze writes  
2) Disable adapter/rule; revert to base  
3) Verify health & golden prompts  
4) Re-enable gradually; watch error budget

MD

cat > "${DOCS_DIR}/operations/OBSERVABILITY.md" <<'MD'
# Operations — Observability

- Metrics: tokens/s, latency p95, cache hit rate, OOMs  
- Traces: per-request spans (routing, decode, I/O)  
- Logs: structured JSON; correlate with request IDs

MD

# --- Security & Privacy ------------------------------------------------------

cat > "${DOCS_DIR}/security/SECURITY_PRIVACY.md" <<'MD'
# Security & Privacy

- Data handling: redact PII, minimize retention  
- Access: authN/Z, least privilege  
- Supply chain: pin hashes, verify model provenance  
- Secrets: never commit; rotate regularly

MD

# --- Decisions & Model Cards -------------------------------------------------

cat > "${DOCS_DIR}/decisions/ADR_TEMPLATE.md" <<'MD'
# ADR — Title

- **Status**: Proposed/Accepted/Rejected/Superseded  
- **Context**: What problem are we solving?  
- **Decision**: What was chosen and why?  
- **Consequences**: Tradeoffs, risks, mitigations  
- **References**: Links, issues, experiments

MD

cat > "${DOCS_DIR}/models/MODEL_CARD_EMEPATH_BASE.md" <<'MD'
# Model Card — EmePath (Base)

- **Purpose**: Generalist base, adapter-friendly  
- **Training data**: (document at high level)  
- **Limitations**: Known failure modes  
- **Safety**: Guardrails, evals, opt-outs  
- **License**: (TBD)

MD

# --- Brand -------------------------------------------------------------------

cat > "${DOCS_DIR}/brand/TAGLINES.md" <<'MD'
# EmePath — Taglines (WIP)

- “A path through language.”
- “Adapters on, answers fast.”
- “Own the stack. Own the insight.”

MD

echo "[EmePath] Docs scaffold complete."

