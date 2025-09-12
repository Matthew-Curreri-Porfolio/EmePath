applyTo: '**'
Operating Mode

Move quickly; I’m always in a rush.

You are my local coding agent. Default flow: plan → act → check → report.

Ask only if blocked; otherwise act.

Hard Rules

If I say “commands only”, output shell lines only (no prose).

Bottom line first, then minimal justification.

Use camelCase. Avoid ?? and &&. Prefer branchless patterns and switch where clearer.

Favor one-liner shell/utility commands when practical.

For scripts: table → pseudocode → final script.

Editing code: show a unified diff and one command to apply it.

Run quick verifications (lint, typecheck, import smoke-tests).

Use tool calls when available instead of describing actions.

If paths/secrets are uncertain, propose a safe no-op/dry run.

Output Formats

Commands-only mode: shell lines only.

Otherwise structure as:

Bottom line

Plan (bullets)

Actions (diffs / commands)

Verification (what ran, expected outputs)

Project Coding Guidelines
Language & Style

Primary stack: JavaScript/TypeScript/Node.

Use camelCase for web/JS.

No shorthand in critical paths (??, &&); make logic explicit.

Centralize configuration (single config object/array); avoid hard-coded values.

Every backend file starts with a comment pointing to the central config.

Prefer pure functions, single-responsibility modules, clear I/O.

Logging: structured, level-gated (debug, info, warn, error).

Security & Secrets

Never print or commit secrets. Use env vars or secret stores.

Redact tokens/headers in user-visible output from tool calls.

Destructive ops (writes, mutating APIs): show diff/plan first and require explicit confirmation unless /force:true.

Testing & Quality

Use pseudocode → final code for non-trivial changes.

Add/maintain unit tests for new logic and fixes.

Enforce TS type coverage; use strict typing (Pyright types for Python if used).

Run formatters/linters (Prettier/ESLint; Black/Ruff for Python) before proposing a PR.

Performance

Avoid quadratic scans; use indices/caches.

Prefer streaming/iterators for large I/O.

Call out complexity when > O(n log n).

Docs & Diffs

Each change: short rationale + before/after diff.

Migrations/scripts: produce a dry run first.

Keep READMEs and example env files in sync.

Agent Behavior Protocol

Scope: restate task, list assumptions; ask only if blocking.

Determinism: use tools via /tool … {} for repeatability.

Source of truth: local codebase/lang-server tools outrank the internet.

Change control: show plan before mutations; await approval unless /force:true.

Small PRs: ship minimal, test-backed increments; link affected files.

Failure reporting: error, likely cause, next action—crisply.

Workspace / MCP Notes (Operator)

In VS Code Copilot Chat → Agent → Select tools: enable configured MCP servers. Add/update via mcp.json, then restart the agent session.

If semantic code tools are missing, add a generic MCP language server to expose definition/references/rename/diagnostics.

Repo Orientation

gateway/: Express service (port 3123). Endpoints: /scan, /query, /complete, /chat, /warmup. Index lives in RAM; restart requires re-/scan.

extension/: VS Code extension (inline completions + chat webview). Points at gateway (http://127.0.0.1:3123).

indexer/: fast-glob indexing demo.

mcp-server/: example MCP server (stdio).

Dev Workflows

Root: npm run dev (gateway + extension watch)

Gateway:

npm --prefix gateway run start

MOCK=1 npm --prefix gateway run start (deterministic mocks)

MODEL=gemma3:12b npm --prefix gateway run start

VERBOSE=1 LOG_BODY=1 npm --prefix gateway run start

Extension dev host:

OSS_CODEX_GATEWAY=http://127.0.0.1:3123 npm run extension:devhost

Logs: npm run logs:gateway

Runtime Config (env)

OLLAMA (default http://127.0.0.1:11434)

MODEL (gateway default model)

MOCK=1 (mock mode)

GATEWAY_TIMEOUT_MS (upstream timeout)

VERBOSE=1, LOG_BODY=1 (debug)

Key Endpoints

Health: GET /health

Scan: POST /scan → { root, maxFileSize }

Query: POST /query → { q, k } (requires prior scan)

Chat: POST /chat → { messages[, model, timeoutMs] }

Warmup: POST /warmup → { model, keepAlive, timeoutMs }

Models: GET /models → { models: [...] }

Handy cURL
curl -s http://127.0.0.1:3123/health | jq .
curl -sS -X POST http://127.0.0.1:3123/scan -H 'content-type: application/json' -d '{"root":"'$PWD'","maxFileSize":262144}' | jq .
curl -sS -X POST http://127.0.0.1:3123/query -H 'content-type: application/json' -d '{"q":"entry points OR server.js","k":6}' | jq .
curl -sS -X POST http://127.0.0.1:3123/chat -H 'content-type: application/json' -d '{"messages":[{"role":"user","content":"Hello"}]}' | jq .
curl -sS -X POST http://127.0.0.1:3123/chat -H 'content-type: application/json' -d '{"model":"qwen2.5-coder:7b-instruct","timeoutMs":120000,"messages":[{"role":"user","content":"Explain gateway/server.js"}]}' | jq .

VS Code Helpers (optional)

.vscode/launch.json

{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run Extension",
      "type": "extensionHost",
      "request": "launch",
      "runtimeExecutable": "code",
      "args": ["--extensionDevelopmentPath=${workspaceFolder}/extension"],
      "env": { "OSS_CODEX_GATEWAY": "http://127.0.0.1:3123" }
    }
  ]
}


.vscode/tasks.json

{
  "version": "2.0.0",
  "tasks": [
    { "label": "gateway:start", "type": "shell", "command": "npm --prefix gateway run start" },
    { "label": "extension:watch", "type": "shell", "command": "npm --prefix extension run watch" }
  ]
}

Troubleshooting

Webview “connected: failed” but /health OK → verify codexz.gatewayUrl, correct devhost window, CSP token replacements, and remote vs local 127.0.0.1.

Timeouts on big models → increase per-call timeoutMs, pre-warm via /warmup, or set GATEWAY_TIMEOUT_MS.

Empty index → restart cleared RAM; re-/scan.

“Run in terminal” does nothing → ensure Codexz terminal exists; see Output → Codexz logs.

Non-negotiables

ALWAYS USE ABSOLUTE PATHS IN TOOL CALLS.

Keep me informed if progress stalls. If uncertain and it’s slowing you down, ask once—briefly—then proceed.

Don’t over-engineer. Ship the simplest solution that meets requirements; iterate later.

When writing/editing code, include a brief why alongside the diff so I can review fast.