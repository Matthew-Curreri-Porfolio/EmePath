applyTo: '**'
---
Provide project context and coding guidelines that AI should follow when generating code, answering questions, or reviewing changes.

# Always Remember

You are being queried by **GitHub Copilot (Agent Mode)** inside VS Code. The agent may call **MCP servers** (Model Context Protocol) to access tools and data. MCP lets clients (Copilot) connect to servers that expose **tools**, **resources**, and **prompts**. Tools must be explicitly enabled; the agent should list and use only the tools configured for this workspace.  And always reply to user input in the chat.  Even if they are wrong.  If you have been working for a while check in with the user to ensure you are on the right track.

## Tool Invocation Grammar (Deterministic)

Prefer natural language, but when precision matters use this command syntax in chat:

/tool <server>:<tool> {json}

- <server> = the MCP server id (e.g., github, fetch, fs, pylance, langserver, search)
- <tool>   = the concrete action exposed by that server (e.g., readFile, writeFile, search, fetch, references, definition, rename)
- {json}   = parameters required by the tool, strictly valid JSON

### Examples
/tool fs:readFile {"path":"./src/app.ts"}
/tool fs:writeFile {"path":"./.env","content":"KEY=VALUE\n","overwrite":false}
/tool fetch:get {"url":"https://example.com/spec.json","headers":{"Accept":"application/json"}}
/tool search:code {"query":"createServer(", "paths":["./src"]}
/tool github:listIssues {"repo":"org/repo","state":"open","labels":["bug"]}
/tool langserver:references {"uri":"file:///workspace/src/app.ts","position":{"line":42,"character":5}}
/tool langserver:rename {"uri":"file:///workspace/src/app.ts","position":{"line":42,"character":5},"newName":"startServer"}

If a tool is not available, ask the user to enable the MCP server or add it to **mcp.json**, then retry. (Copilot Agent supports adding/using MCP servers and letting the user pick tools in the **Select tools** panel.)

---

# What Tools Are Expected (if enabled) — With Call Examples

## ✅ Built-In Tools

- **changes** — Get diffs of changed files  
  /tool changes:getDiff {"path":"./src/app.js"}

- **codebase** — Find relevant file chunks, symbols, and information  
  /tool codebase:find {"query":"connect.session"}

- **editFiles** — Edit files in your workspace  
  /tool editFiles:write {"path":"./src/app.js","content":"console.log('Hello')\n","overwrite":true}

- **extensions** — Search for VS Code extensions  
  /tool extensions:search {"query":"Python"}

- **fetch** — Fetch content from a web page  
  /tool fetch:get {"url":"https://example.com/api.json"}

- **findTestFiles** — Locate tests for a source file (and vice versa)  
  /tool findTestFiles:get {"path":"./src/app.js"}

- **githubRepo** — Search a GitHub repository for code snippets  
  /tool githubRepo:search {"repo":"octocat/Hello-World","query":"express()"}

- **new** — Scaffold a new workspace in VS Code  
  /tool new:workspace {"name":"myNewProject"}

- **openSimpleBrowser** — Preview a locally hosted website  
  /tool openSimpleBrowser:open {"url":"http://localhost:3000"}

- **problems** — Check errors for a particular file  
  /tool problems:get {"path":"./src/app.js"}

- **readNotebookCellOutput** — Read output of a previously executed cell  
  /tool readNotebookCellOutput:get {"cellId":"abc123"}

- **runCommands** — Run commands in the terminal  
  /tool runCommands:exec {"command":"ls -la"}

- **runNotebooks** — Run notebook cells  
  /tool runNotebooks:run {"path":"./analysis.ipynb"}

- **runTasks** — Run VS Code tasks  
  /tool runTasks:run {"task":"build"}

- **runTests** — Run unit tests  
  /tool runTests:run {"path":"./tests/test_app.py"}

- **search** — Search and read files in your workspace  
  /tool search:code {"query":"function startServer"}

- **searchResults** — The results from the search view  
  /tool searchResults:get {"limit":5}

- **terminalLastCommand** — The active terminal’s last command  
  /tool terminalLastCommand:get {}

- **terminalSelection** — The active terminal’s selection text  
  /tool terminalSelection:get {}

- **testFailure** — Information about the last unit test failure  
  /tool testFailure:get {}

- **usages** — Find references, definitions, and other usages of a symbol  
  /tool usages:find {"symbol":"startServer","path":"./src/app.js"}

- **vscodeAPI** — Use VS Code API references to answer extension-dev questions  
  /tool vscodeAPI:search {"query":"StatusBarItem"}

## ✅ Extensions

- **Azure Resources**  
  /tool azure:listResources {"subscriptionId":"sub-123"}

- **Dart**  
  /tool dart:analyze {"path":"./lib/main.dart"}

- **Python**  
  /tool python:run {"path":"./script.py","args":["--help"]}

## ✅ MCP Server: pylance mcp server

- **pylanceDocuments** — Search Python documentation  
  /tool pylance:documents {"query":"dataclass"}

- **pylanceFileSyntaxErrors** — Check Python file syntax errors  
  /tool pylance:fileSyntaxErrors {"path":"./src/main.py"}

- **pylanceImports** — Analyze imports across workspace user files  
  /tool pylance:imports {}

- **pylanceInstalledTopLevelModules** — List available top-level modules  
  /tool pylance:installedTopLevelModules {}

- **pylanceInvokeRefactoring** — Apply automated refactorings  
  /tool pylance:invokeRefactoring {"path":"./src/utils.py","refactor":"rename","oldName":"foo","newName":"bar"}

- **pylancePythonEnvironments** — Get Python env info for workspace  
  /tool pylance:pythonEnvironments {}

- **pylanceSettings** — Get current Python analysis settings  
  /tool pylance:settings {}

- **pylanceSyntaxErrors** — Validate Python code snippets for syntax errors  
  /tool pylance:syntaxErrors {"code":"def foo(: pass"}

- **pylanceWorkspaceRoots** — Get workspace root directories  
  /tool pylance:workspaceRoots {}

- **pylanceWorkspaceUserFiles** — List all user Python files in workspace  
  /tool pylance:workspaceUserFiles {}

---

# Pylance / Language-Server Semantics via MCP

- **Pylance** is VS Code’s Python language server (powered by Pyright). It provides IntelliSense, diagnostics, definitions, and references. In Agent Mode, equivalent language-server capabilities can be exposed to the agent via an MCP server that offers semantic tools (e.g., `definition`, `references`, `rename`, `diagnostics`). If your environment exposes a Pylance MCP bridge or a generic MCP language server (e.g., `mcp-language-server`), use those tools for code navigation and refactors. If not available, request enabling an MCP language-server tool.
- Note: Some setups report the “Pylance MCP server” failing to start. If that happens, fall back to generic MCP language-server tools or normal file parsing.

---

# Project Coding Guidelines

## Language & Style
- JavaScript/TypeScript/Node and Python are primary.
- Use camelCase for web/JS.
- No shorthand operators like `??` or `&&` in critical paths; write explicit logic.
- Prefer branchless patterns and `switch` over nested `if` chains when clarity improves.
- One-liners for shell/utility commands when practical.
- Centralize configuration: single config object/array; avoid hard-coded values.
- Each backend file begins with a comment pointing to the central config.
- Favor pure functions, single-responsibility modules, and clear inputs/outputs.
- Logging: structured, level-gated (`debug`, `info`, `warn`, `error`).

## Security & Secrets
- Never print or commit secrets. Use environment variables or secret stores.
- On tool calls, redact tokens and headers in any user-visible output.
- Destructive ops (`writeFile`, mutating APIs) must show a diff/plan first and require explicit confirmation unless the user uses `/force:true`.

## Testing & Quality
- Follow **pseudocode → final code** flow for non-trivial changes.
- Require unit tests (Jest/PyTest) for new logic and bug fixes.
- Enforce type coverage (TS) and strict typing in Python (Pyright types).
- Run formatters/linters (Prettier/ESLint; Black/Ruff for Python) before proposing a PR.

## Performance
- Avoid quadratic scans; use indices/caches.
- Prefer streaming/iterators for large I/O.
- Annotate complexity in reviews when > O(n log n).

## Docs & Diffs
- Every change: short rationale + before/after diff.
- For migrations/scripts: produce **dry-run** output first.
- Keep READMEs and example envs in sync with changes.

---

# Agent Behavior Protocol

1. Scope first. Restate the task, list assumptions, and ask for missing constraints only if blocking.
2. Use tools deterministically. Prefer `/tool … {}` for repeatability.
3. Prefer local truth. Codebase files and langserver tools outrank internet sources.
4. Show the plan before mutating files; await approval unless `/force:true` is present.
5. Small PRs. Ship minimal, test-backed increments. Link to affected files.
6. Report failures crisply. Include error, probable cause, next action.

---

# Workspace MCP Setup (Operator Notes)

- In VS Code Copilot Chat → choose **Agent**, open **Select tools**, and enable the configured MCP servers. To add new ones, configure `mcp.json` (VS Code/Visual Studio) and restart the agent session.
- If you need semantic code tools and don’t see “Pylance” as a server, add a **generic MCP language server** (e.g., `mcp-language-server`) to expose `definition`/`references`/`rename`/`diagnostics` to the agent.


## Quick orientation (what this repo is)

This workspace implements a small local LLM gateway + VS Code extension + indexer and an MCP demo server.
Key runtime pieces you should know about:
- `gateway/` — Express service (default port 3123) that indexes the workspace (`/scan`), answers `POST /query`, and proxies to an LLM (`/complete`, `/chat`, `/warmup`). See `gateway/server.js`.
- `extension/` — VS Code extension that provides inline completions and a chat webview. It calls the gateway (default `http://127.0.0.1:3123`). See `extension/src/extension.ts` and `extension/media/chat.html`.
- `indexer/` — a tiny fast-glob based script used for quick ad-hoc indexing; `indexer/index.js` demonstrates file collection.
- `mcp-server/` — example Model Context Protocol server (stdio transport). See `mcp-server/src/index.ts`.

## Big picture architecture & data flows

- Dev workflow often runs two processes: the HTTP gateway and the VS Code extension in dev host. The extension calls gateway endpoints to drive completions, scans, and chat.
- Typical flow: extension -> POST /scan (gateway builds in-memory REPO_INDEX) -> POST /query (gateway searches snippets) -> /complete or /chat (gateway forwards to upstream LLM service).
- Gateway keeps the repo index in RAM (`REPO_INDEX` in `gateway/server.js`). This means a restart clears the index; callers must re-run `/scan` after gateway restart.
- Gateway does client-side filtering/ignore rules before indexing: `DEFAULT_IGNORE_DIRS`, `DEFAULT_IGNORE_PATH_FRAGMENTS`, file-size limits (default 256KB). See `scanDirectory` in `gateway/server.js`.

## Developer workflows & commands

- Start both gateway and extension watcher (dev):
  - From repo root: `npm run dev` (this runs `gateway:start` and `extension:watch`).
- Start gateway only (examples):
  - Normal: `npm --prefix gateway run start`
  - Mock mode (no upstream LLM): `MOCK=1 npm --prefix gateway run start` (gateway responds with short mock completions)
  - With a different model: `MODEL=gemma3:12b npm --prefix gateway run start`
- Extension dev host (open VS Code dev window with the extension loaded):
  - `npm run extension:devhost` (uses `OSS_CODEX_GATEWAY` env to point extension at a gateway)
- Indexer quick run: `npm --prefix indexer run start`
- Tail gateway logs: `npm run logs:gateway` — logs are written to `gateway/logs/gateway.log` by default.

## Runtime config & important env vars

- Gateway defaults:
  - `OLLAMA` — upstream model host (default `http://127.0.0.1:11434`)
  - `MODEL` — LLM model id used by gateway (see server.js default)
  - `MOCK=1` — bypass real LLM calls and return deterministic mocks (useful for offline dev)
  - `GATEWAY_TIMEOUT_MS` — default upstream timeout
  - `VERBOSE=1` and `LOG_BODY=1` — increase log verbosity and optionally log request bodies (useful for debugging)

## Project-specific conventions & patterns

- The extension uses a single configuration namespace: `codexz`. To change gateway URL from inside VS Code set `codexz.gatewayUrl` (or set env `OSS_CODEX_GATEWAY` when launching devhost).
- Inline completions: `extension/src/extension.ts` registers an InlineCompletionItemProvider (pattern `**/*`) and sends a limited context window (50 lines before/after) to the gateway via `/complete` with `budgetMs`.
- Webview HTML is loaded from `extension/media/chat.html` and expects simple tokens `{{GATEWAY}}`, `{{NONCE}}`, `{{CSP}}` — the extension replaces those at runtime.
- Gateway index is in-memory and intentionally limited: per-file max size default 262144 bytes (256 KB) and an enforced upper bound of 2 MB when client requests a larger size.
- Query and snippet generation: gateway returns snippets with line ranges (see `makeSnippets`), which is what the extension/web UI expects.

## Integration points & example calls AI agents may need to make

- Scan the workspace (extension triggers this):
  - POST http://127.0.0.1:3123/scan with JSON { root: <workspaceRoot>, maxFileSize: <bytes> }
  - Response: { ok: true, root, count }
- Query for relevant snippets before calling the LLM:
  - POST http://127.0.0.1:3123/query with { q: "search terms", k: <limit> }
  - Gateway requires an index (scan) to be present or returns 400.
- Request completion (gateway forwards to upstream model):
  - POST http://127.0.0.1:3123/complete with { language, prefix, suffix, path, cursor, budgetMs, timeoutMs }
  - If gateway is run with `MOCK=1` the returned body is a short mock completion.

## Debugging tips and logs

- Gateway logs to `gateway/logs/gateway.log`. Use `npm run logs:gateway` to tail during dev.
- To reproduce issues deterministically run gateway in `MOCK=1` mode to rule out upstream model/network issues.
- Increase observability with `VERBOSE=1` and `LOG_BODY=1` when launching the gateway.

## Files to inspect for concrete examples

- `gateway/server.js` — full gateway implementation (indexing, query, LLM proxy, ignore rules, snippet extractor).
- `extension/src/extension.ts` — how the extension calls `/complete`, `/scan`, and handles inline completions and webview messages.
- `indexer/index.js` — example fast-glob indexing utility.
- `mcp-server/src/index.ts` — example MCP server using stdio transport; useful if you need MCP tooling.

If anything here is unclear or you'd like additional examples (sample HTTP payloads, a short integration test, or added docs for env matrix), tell me which section to expand and I will iterate.
Prereqs

Node 18+ (or 20+ recommended)

VS Code 1.90+

Ollama (or another upstream model host) if not using MOCK=1

# sanity checks
node -v
code --version
curl -s http://127.0.0.1:11434/api/tags | jq .

Ports & env matrix (at a glance)
Component	Default	Override env
Gateway	:3123	PORT, GATEWAY_TIMEOUT_MS, VERBOSE
Upstream	:11434	OLLAMA (e.g., http://127.0.0.1:11434)
Model	qwen2.5-coder:7b-instruct	MODEL

In the VS Code devhost, the extension points to the gateway via setting codexz.gatewayUrl or process env OSS_CODEX_GATEWAY used by your extension:devhost script.

Scripts you can copy/paste
# root
npm run dev                 # gateway + extension watch (if you wired it)
npm run logs:gateway        # tail gateway log

# gateway only
npm --prefix gateway run start
MOCK=1 npm --prefix gateway run start
MODEL=gemma3:12b npm --prefix gateway run start
VERBOSE=1 LOG_BODY=1 npm --prefix gateway run start

# extension devhost (new window)
OSS_CODEX_GATEWAY=http://127.0.0.1:3123 npm run extension:devhost

Endpoints (add these two that folks often look for)

List models
GET /models → { "models": ["qwen2.5-coder:7b-instruct", ...] }

Warm a model into RAM
POST /warmup
Body: {"model":"qwen2.5-coder:7b-instruct","keepAlive":"2h","timeoutMs":300000}
→ { "ok": true, "load_duration": 123456789 }

Curl flows (cut-and-paste)
# 1) Health
curl -s http://127.0.0.1:3123/health | jq .

# 2) Scan repo
curl -sS -X POST http://127.0.0.1:3123/scan \
  -H 'content-type: application/json' \
  -d '{"root":"'$PWD'","maxFileSize":262144}' | jq .

# 3) Query snippets
curl -sS -X POST http://127.0.0.1:3123/query \
  -H 'content-type: application/json' \
  -d '{"q":"entry points OR server.js","k":6}' | jq .

# 4) Chat (plain)
curl -sS -X POST http://127.0.0.1:3123/chat \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"Hello"}]}' | jq .

# 5) Chat (pick model + longer timeout)
curl -sS -X POST http://127.0.0.1:3123/chat \
  -H 'content-type: application/json' \
  -d '{"model":"qwen2.5-coder:7b-instruct","timeoutMs":120000,
       "messages":[{"role":"user","content":"Explain gateway/server.js"}]}' | jq .

VS Code devhost helpers (optional but very handy)

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
      "env": {
        "OSS_CODEX_GATEWAY": "http://127.0.0.1:3123"
      }
    }
  ]
}


.vscode/tasks.json

{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "gateway:start",
      "type": "shell",
      "command": "npm --prefix gateway run start",
      "problemMatcher": []
    },
    {
      "label": "extension:watch",
      "type": "shell",
      "command": "npm --prefix extension run watch",
      "problemMatcher": []
    }
  ]
}


With these, you can “Run Task…” → start gateway & watch, then “Run Extension”.

Extension commands (document for discoverability)

Codexz: Open Chat (codexz.openChat)

Codexz: Ping Gateway (codexz.ping)

Codexz: Test Completion (codexz.test)

Codexz: Toggle Inline Completions (codexz.toggleInline)

Settings:

codexz.gatewayUrl (string, default http://127.0.0.1:3123)

codexz.inlineEnabled (boolean, default true)

Troubleshooting (add this—saves time)

Webview says “connected: failed” but curl /health is OK

In VS Code, open Settings → search codexz.gatewayUrl. Ensure it matches your curl base URL.

Verify the extension devhost is the window you’re looking at (title shows [Extension Development Host]).

Use Help → Toggle Developer Tools in that window → Console should show [codexz] & [codexz-webview] logs.

Check CSP replacement: ensure {{CSP}}, {{NONCE}}, {{GATEWAY}} are being replaced (you should see logs like webview/html_loaded_fs in the Output → Codexz channel).

If you are in a Remote - SSH session, make sure the gateway is reachable from the remote environment, not your local machine (127.0.0.1 refers to the remote host there).

504 / timeouts with bigger models

Increase request timeout per call: include timeoutMs in /chat body (UI already uses 120s).

Pre-load models via /warmup or the webview Load button.

Increase server’s default: GATEWAY_TIMEOUT_MS=120000.

Index is empty / “requires scan”

The index lives in RAM; restart clears it. Run Scan in the chat header (or POST /scan).

“Run in terminal” button does nothing

Ensure the “Codexz” terminal is open (webview sends runShell; host logs it as runShell/dispatch).

Check VS Code Output → Codexz channel for webview/msg_in and terminal/new logs.

Known limitations / footguns

The gateway index is in-memory and single-tenant by design (runs on dev workstations).

No auth on endpoints — don’t bind to a public interface.

Large repos: scan respects ignore lists and size caps; tune maxFileSize in the /scan body.

Packaging & release
# Build extension
npm --prefix extension run build

# Package .vsix
npm --prefix extension run package
# Then: Install via VS Code: Extensions panel → ... → Install from VSIX...

Security & privacy quick note

Snippets returned by /query include file content; keep the gateway local.

Webview CSP is strict: only inline styles and the single nonce’d script, and only connect-src to http(s).

ALWAYS USE ABSOLUTE PATHS WHEN CALLING TOOLS.
Never use relative paths like `./file.js` or `../file.js` in tool calls; always use absolute paths from the workspace root like `/src/file.js`. This avoids ambiguity and ensures the agent accesses the correct files regardless of its current working directory.

Keep the user informed on what you are doing especially if you haven't prompted them in a while.  Never be affraid to ask the user for clarification if you are unsure about something or your current path is taking too long.