gateway/rooms/index.js
- Description: Public entry to rooms; exports defaultDeps, runTask, protocols.
- Input: Task object { id, goal }; optional deps { llm, search }.
- Output: Outcome { status, artifacts, rationale }.
- Method: Calls dispatcher’s runRooms using brainstorm → consensus plan for non-trivial goals.

gateway/routes/agentic.js
- Description: Agentic routes: rooms dispatch, DB maintenance, ad-hoc backup.
- Input: POST /rooms/dispatch { goal, id? }; POST /db/maintain { reencode? }; POST /db/backup none.
- Output: /rooms/dispatch { ok, outcome }; /db/maintain { ok, processed }; /db/backup { ok }.
- Method: Invokes rooms entry for dispatch; DB manager for encoding; spawns backup script.

gateway/agents/db_manager.js
- Description: Encodes memory rows into working_tokens using RAX1; preserves content.
- Input: encodeAllMemories({ reencode? }).
- Output: { ok: true, processed }.
- Method: Reads rows via all; per-row RAX1.encode on { content }; updates working_tokens via run.

gateway/memory/index.js
- Description: Memory adapter with binary snapshot support and DB dialect handling.
- Input: saveWorking(scope, state, { encode? }); getWorking(scope, { decode? }); handoffSnapshot(scope); applySnapshot(scope, snapshot).
- Output: saveWorking { ok }; getWorking { state, snapshot?, decoded? }; handoffSnapshot { bytes, meta }; applySnapshot { ok }.
- Method: Upserts/selects on short_term_memory/long_term_memory; stores working_tokens BLOB.

gateway/memory/encoders/rax1.js
- Description: Encoder bridge to rax1_codec.py, with JSON fallback.
- Input: encode(state with content); decode(bytes, meta).
- Output: encode { bytes, meta }; decode object or { content }.
- Method: Spawns python3 rax1_codec.py --encode/--decode; falls back to JSON UTF‑8.

gateway/db/migrations/002_add_working_tokens.sql
- Description: Adds working_tokens BLOB to memory tables (SQLite).
- Input: n/a.
- Output: n/a.
- Method: ALTER TABLE statements (additive).

gateway/db/db.js
- Description: better-sqlite3 connection, migrations, helpers.
- Input: SQL strings and params.
- Output: Rows or write info; exported helpers run, get, all.
- Method: Prepares and executes statements; runs migrations on startup.

scripts/backup_db.sh
- Description: Compresses gateway/db/app.db into backups/ with timestamp.
- Input: none.
- Output: backups/gateway-db_YYYYmmdd_HHMMSS.db.gz.
- Method: cp, gzip; trims to last 14 backups.

scripts/daily_maint.js
- Description: Cron-friendly maintenance runner: encode snapshots then backup DB.
- Input: env REENCODE=true to force re-encode.
- Output: Logs DB manager result; prints backup output.
- Method: Calls encodeAllMemories, then spawns backup_db.sh.

gateway/memory/tests/smoke.memory.test.js
- Description: Smoke test for memory adapter using in-memory SQLite.
- Input: none.
- Output: Logs memory smoke ok …
- Method: Runs migrations, save → get → handoff → apply → get.

gateway/rooms/tests/smoke.rooms.test.js
- Description: Smoke test for rooms flow (brainstorm → consensus).
- Input: none.
- Output: Logs rooms smoke ok …
- Method: Builds a task and runs runTask with default deps.
