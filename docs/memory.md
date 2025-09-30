Memory adapter providing additive binary snapshots for direct model consumption.

Tables (SQLite):

- short_term_memory: (existing) + working_tokens BLOB
- long_term_memory: (existing) + working_tokens BLOB

API (createMemory):

- saveWorking({ type, userId, workspaceId }, state, { encode })
- getWorking({ type, userId, workspaceId }, { decode }) → { state, snapshot }
- handoffSnapshot({ type, userId, workspaceId }) → { bytes, meta }
- applySnapshot({ type, userId, workspaceId }, { bytes, meta })

Encoder interface:

- encode(state: object) → { bytes: Uint8Array, meta?: object }
- decode(bytes: Uint8Array, meta?: object) → object

Dialects supported:

- sqlite | postgres (SQL generated accordingly)
