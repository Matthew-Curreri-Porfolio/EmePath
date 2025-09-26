# Brain Orchestrator (Overview)

The Brain is a lightweight coordinator that turns user input into intent → goals → plan → actionable agent steps. It talks to the gateway (LoRA server) for LLM reasoning and tracks agent check‑ins, all while cross‑referencing DB ids for users and projects.

## Responsibilities

- Session → Project mapping
  - Creates a session with `{ userId, projectId }` (project is the preferred term; legacy workspace maps to the same DB scope).
  - Ensures a project row exists in the DB (auto‑creates if needed).

- Prompt pipeline
  - Builds a compact, deterministic prompt chain to extract:
    - `intent`: concise label
    - `goals`: bullets
    - `plan`: short outline
    - `steps`: `[ { title, input, kind: 'agent', expected } ]`
  - Introduces an interaction artifact: `<INTERACT>...<\/INTERACT>` to signal “speak to the user now” instead of executing tasks.

- Agent spawning
  - Converts `steps[]` into agent records tied to `projectId` (status: pending → running → done).
  - Provides a `checkIn(agentId, status)` API to update liveness/health.

## Interact Artifact

Models may return `<INTERACT>...<\/INTERACT>` when they need to ask the user for more info or deliver a message that should not run against the active project. The Brain routes that text directly to the UI without spawning agents.

## Data Model (DB)

- Users table: existing
- Projects table: existing (previously “workspaces” in session). We adopt “projectId” going forward and map it to the same scope in DB APIs.
- Agent state: in‑memory for now (Map), persisted later if needed.

## API Sketch

```js
import Brain from '../brain.js';
const brain = new Brain();
const sid = brain.createSession({ userId: 1, projectId: 'alpha' });
const r = await brain.ingestInput({ sessionId: sid, text: 'Deploy hello world', env: { os: 'linux' } });
if (r.routed.mode === 'interact') showToUser(r.routed.text);
if (r.routed.mode === 'execute') startAgents(r.routed.agents);
```

## Projects vs Workspaces

- Terminology: “project” is preferred; legacy code uses `workspaceId` in sessions.
- Auth now accepts `projectId` and maps it to the legacy `workspaceId` field.

## Next Steps

- Persist agents table with `{ id, projectId, goal, input, expected, status, lastCheckIn }`.
- Add policies for when to INTERACT vs EXECUTE and guardrails (RBAC, limits).
- Extend prompt templates in `gateway/prompts/prompts.builder.js` for richer planning.

