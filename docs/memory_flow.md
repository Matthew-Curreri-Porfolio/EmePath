# Encoded Memory Lifecycle & Model Handoff — One-Page Flow

Purpose
- Visualize how OSS Codex encodes, stores, and reuses context so models can be hot-swapped without losing continuity.
- Show the lifecycle of data: ingest → encode → checkpoint → decode/use by models → update → re-encode → export/report.
- Highlight where versioning, re-encode migrations, and fallbacks (JSON) live.

Mermaid diagram (renderable in GitHub or Mermaid-enabled viewers)
```mermaid
flowchart LR
  subgraph Ingest
    A1[Curated Sources\n(arXiv, Wikipedia, MDN, ...)]
    A2[Ingest Adapters\n(gateway/tools/curated/)]
  end

  subgraph MemoryLayer
    B1[Encoder Bridge\n(gateway/memory/encoders/rax1.js)]
    B2[Encoded Memory\nDB working_tokens BLOB\n(gateway/db/migrations/...)]
    B3[DB Manager / Re-encode Agent\n(gateway/agents/db_manager.js)]
  end

  subgraph Orchestration
    C1[Orchestrator / Rooms\n(gateway/rooms/index.js)]
    C2[Experiment Manager\n(template execution)]
    C3[Data Analyzer]
    C4[Report Writer]
  end

  subgraph Models
    M1[Model A\n(API or local LLM)]
    M2[Model B\n(Open-source / alternative)]
  end

  A1 --> A2 --> B1
  B1 --> B2
  B2 --> C1
  C1 --> C2
  C2 --> C3 --> C4
  C1 -->|checkpoint / context snapshot| B2
  B2 -->|decode (semantic / token-level)| M1
  B2 -->|decode (semantic / token-level)| M2
  M1 -->|writes artifacts / notes| B2
  M2 -->|writes artifacts / notes| B2
  C1 -->|trigger re-encode| B3 --> B1
  B1 -->|JSON fallback| B2

  classDef enc fill:#f9f,stroke:#333,stroke-width:1px;
  class B1,B2,B3 enc;
  classDef orches fill:#efe,stroke:#333,stroke-width:1px;
  class C1,C2,C3,C4 orches;
  classDef models fill:#eef,stroke:#333,stroke-width:1px;
  class M1,M2 models;

  %% Legend (not rendered by all Mermaid renderers; keep as comment if unsupported)
  %% Legend: Encoders/DB = persistent, Orchestration = runtime controllers, Models = pluggable handlers
```

ASCII fallback (plain-text one-page flow)

Ingest & Curated Corpus
  ┌────────────────────────────┐
  │ Curated Sources (arXiv,    │
  │ Wikipedia, MDN, PubMed, ...)│
  └────────────┬───────────────┘
               │
               ▼
  ┌────────────────────────────┐
  │ Ingest Adapters & Normalizer│
  │ (dedupe, stable-id, tags)  │
  └────────────┬───────────────┘
               │
               ▼
  ┌────────────────────────────┐
  │ Encoder Bridge (RAX1 / JSON)│  <-- gateway/memory/encoders/rax1.js
  └────────────┬───────────────┘
               │ encode → checkpoint (working_tokens BLOB)
               ▼
  ┌────────────────────────────┐
  │ Encoded Memory (DB row +)  │  <-- working_tokens column (migrations)
  │ - codec version             │
  │ - snapshot metadata         │
  └────────────┬───────────────┘
               │ read / decode on demand
               ▼
  ┌────────────┐   ┌────────────┐
  │ Model A    │   │ Model B    │  <-- hot-swapable LLMs / analytics modules
  │ (current)  │   │ (new)      │
  └────┬───────┘   └────┬───────┘
       │ artifacts/logs    │ artifacts/logs
       └────────┬──────────┘
                ▼ append to memory
  ┌────────────────────────────┐
  │ Orchestrator & Experiment  │
  │ Manager (writes results)   │
  └────────────┬───────────────┘
               │ triggers Analyzer + Report Writer
               ▼
  ┌────────────────────────────┐
  │ Report Writer / Export     │
  │ (consumes encoded memory)  │
  └────────────────────────────┘

Key Lifecycle Actions (numbered)
1) Ingest: adapters normalize and produce deterministic docs (id, url, body, metadata).
2) Encode & Snapshot: Encoder bridge turns working state into compact blobs; store with codec version and metadata.
3) Checkpoint: Orchestrator checkpoints state to DB frequently to enable pause/resume and failure recovery.
4) Decode for Use: Any model can decode (or the orchestrator can present decoded context) to continue reasoning.
5) Hot-swap: Swap models (Model A → Model B) without losing context; both read the same encoded memory.
6) Append Artifacts: Models and experiments append outputs back into memory (notes, metrics, figures).
7) Re-encode / Migrate: When codec changes, DB Manager triggers re-encode migrations to update existing rows.
8) Export / Report: Report Writer consumes memory + artifacts to create reproducible drafts and provenance.

Practical annotations & pointers
- Encoder bridge: gateway/memory/encoders/rax1.js — shells out to rax1_codec.py; falls back to JSON for compatibility.
- DB migration: gateway/db/migrations/002_add_working_tokens.sql — persist working_tokens BLOB.
- Re-encode agent: gateway/agents/db_manager.js — run encodeAllMemories({ reencode: true }) for codec migrations.
- Deterministic ingest: gateway/tools/curated/ingest/run_ingest.mjs — stable IDs (hash URL), dedupe, local cache via CURATED_CACHE.
- Orchestration entry: gateway/rooms/index.js and gateway/routes/agentic.js — dispatch, maintenance, backups.

Design considerations & best practices
- Version your encoder outputs (store codec version and metadata per snapshot). Never overwrite without recording previous version.
- Provide a re-encode path and include a DB migration script when introducing incompatible codec changes.
- Keep encoded blobs small and semantic: combine token-level embeddings with condensed semantic summaries to enable compact replay and partial decode.
- Prefer append-only memory rows with references to artifacts (images, model checkpoints) rather than embedding large binary artifacts directly in the BLOB.
- Ensure logs and artifacts include provenance: which model/version produced them, seed / env, and experiment template id.

Security & reproducibility
- Do not include secrets in memory snapshots.
- Record RNG seeds, dependency versions (pip/poetry lock), and container images in the snapshot metadata to enable exact reruns.
- Use signed snapshots or checksums for critical runs to detect tampering.

How to use this diagram (quick cheat-sheet)
- To hot-swap models mid-run:
  1. Ensure current state checkpointed to DB (working_tokens) and codec version recorded.
  2. Start/attach new model process; decode state (semantic summary or token-level) to feed into new model.
  3. Run a smoke-test prompt that verifies continuity (e.g., "Summarize the last decision recorded in memory").
  4. Continue experiments; ensure artifacts get appended and re-checkpointed.

References (in-repo)
- gateway/memory/encoders/rax1.js
- gateway/agents/db_manager.js
- gateway/db/migrations/002_add_working_tokens.sql
- gateway/tools/curated/ingest/run_ingest.mjs
- gateway/rooms/index.js
```