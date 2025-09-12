# OSS Codex

OSS Codex is an AI research orchestration platform built around a durable, encoded memory backbone and a generative reporting layer. Rather than treating reports and memory as end-user features, this project uses them as the foundational infrastructure that enables flexible AI systems: hot-swapping models, preserving long-running context, condensing and indexing large knowledge artifacts, and powering reproducible, automated research flows.

This README focuses on the core idea: memory + encoding + generative reports = an extensible substrate for agentic research and model experimentation.

## Why this design matters

- Memory is the system's state, not a simple cache. Encoded memory preserves context across model changes, restarts, and distributed runs. That means you can swap in different LLMs or analytic engines and continue a research run without losing prior reasoning, intermediate artifacts, or experiment metadata.
- Encoding is data condensation. By encoding working state (e.g., `working_tokens` blobs) with a compact codec (RAX1 by default, with JSON fallback), OSS Codex stores more semantic information per byte and supports fast snapshotting, replay, and cross-model transfer of context.
- The Report Writer is an infrastructure consumer. It synthesizes outputs into human-readable drafts, but conceptually it is a pluggable module that reads encoded memory and analytics outputs. This makes reports a first-class, reproducible artifact that documents how decisions were made and which experiments produced which evidence.

## Core innovations (concise)

- Persistent encoded memory
  - Binary snapshots (working_tokens BLOB) plus DB dialect handling for portability.
  - Encoder bridge (gateway/memory/encoders/rax1.js) that shells out to a Python codec (rax1_codec.py).

- Model-agnostic context preservation & hot-swap
  - Memory serializes state so models can be swapped mid-run (different LLMs, local open-source models, or remote APIs) while preserving continuity.
  - Mixing token-level and semantic encodings enables both precise replay and condensed state transfer.

- Experiment templates + orchestration
  - Experiment Manager selects templates (training, stat analysis, simulation), fills parameters, runs jobs, and persists artifacts.
  - Orchestration layer coordinates idea → experiment → analysis → report loops and stores structured progress in memory.

- Curated ingestion + deterministic cache
  - Adapters for arXiv, Wikipedia, MDN, PubMed, and more produce structured docs (id, url, source, title, body, published_at, lang, license, tags).
  - `CURATED_MODE` and `CURATED_CACHE` let you run reproducible research that depends on a fixed knowledge snapshot.

- Rooms / Agents / Dispatcher
  - Brainstorm → consensus planning flow for human-in-the-loop or fully automated dispatch.
  - Agentic HTTP routes for running tasks, DB maintenance, and backups.

## Architecture (high level)

1. Ingest adapters populate the curated corpus.
2. Idea Generator (LLM or bumpable module) proposes research directions.
3. Orchestration loop consults memory and chooses actions.
4. Experiment Manager runs templated experiments and writes results to storage.
5. Data Analyzer generates figures and structured analysis.
6. Memory encoder condenses state and checkpoints it into DB blobs.
7. Report Writer consumes analysis + memory to draft reproducible reports.

Memory is the single source of truth for the orchestration layer; encoders and the Report Writer are just consumers and producers of that state.

## Practical overview — files & entry points

- docs/whitepaper.md — design rationale and usage examples.
- docs/maintenance_tree.md — directory guide for gateway subsystems.
- gateway/tools/curated/ — adapters and ingest orchestration.
  - gateway/tools/curated/ingest/run_ingest.mjs — ingestion orchestrator.
  - gateway/tools/curated/CURATED_SOURCES.md — best practices & sources.
- gateway/memory/ — memory adapters, encoder bridge, migrations.
  - gateway/memory/encoders/rax1.js — encoder bridge to rax1_codec.py (with JSON fallback).
  - gateway/db/migrations/002_add_working_tokens.sql — adds `working_tokens` blob columns.
- gateway/agents/db_manager.js — agent that encodes memory rows and re-encodes on demand.
- gateway/rooms/index.js — public entry to rooms with runTask / protocols.
- gateway/routes/agentic.js — HTTP routes for agentic tasks and DB maintenance.

## Quickstart (developer)

Prereqs
- Node.js (modern)
- Python 3 (for RAX1 codec bridge; optional if using JSON)
- SQLite (default DB backend) or configured DB
- Optional: GPU + CUDA for heavy experiments

Example: run a curated ingest
1. export CURATED_MODE=1
2. export CURATED_CACHE=/absolute/path/docs.jsonl (optional)
3. node gateway/tools/curated/ingest/run_ingest.mjs --pages "List,Of,Wiki,Pages" --mdn --limit 50

Example: dispatch a rooms task (agentic flow)
- POST /rooms/dispatch
  body: { "goal": "Investigate optimizer variants on CIFAR-10" }
- The dispatcher will use brainstorm → plan → run experiments and record everything to memory.

Example: re-encode memory for a new codec
- Use the db_manager agent: call encodeAllMemories({ reencode: true }) or run the provided agentic route to update `working_tokens` after changing/adding encoders.

## Development recommendations

- Treat encoders as versioned artifacts. When altering encoding formats, provide a re-encode migration path so older memory remains usable.
- Keep experiment templates small, idempotent, and declarative — that simplifies automatic parameterization.
- Add unit tests around encode/decode with both codecs (rax1 and JSON fallback).
- Provide a small docker-compose that starts DB + Node service + optional Python encoder to simplify demos.
- Document example experiment templates and a minimal dataset so contributors can run a full ingest → experiment → report demo quickly.

## Security & reproducibility notes

- Do not store secrets in VCS. Use env vars or a secrets manager.
- Log structured JSON; avoid PII in logs.
- Make experiments reproducible by recording seeds, library versions, and container images. Use Docker to pin environments.

## Roadmap & next steps (recommended)

- Provide an official minimal demo: curated ingest → single small experiment → analysis → generated report.
- Add a lightweight web dashboard for mixed-initiative review and model hot-swap controls.
- Expand adapters (PubMed, Semantic Scholar) and add citation provenance to report outputs.
- Provide migration scripts and CI checks for encoder changes.

## Contributing & contact

- Follow the recommended engineering practices in gateway/tools/curated/CURATED_SOURCES.md (linting, tests, small commits).
- Create focused PRs with tests for new adapters, encoders, or experiment templates.
- If you want a short runnable demo or a Docker Compose for the demo flow, open an issue or PR and I can draft it.

---

OSS Codex centers memory and encoding as first-class infrastructure so researchers and engineers can focus on models, experiments, and scientific judgment rather than fragile state management.
