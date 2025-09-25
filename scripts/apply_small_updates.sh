#!/usr/bin/env bash
set -euo pipefail

ROOT="${ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
RUNTIME_JS="$ROOT/gateway/usecases/runtime.js"
BACKUP_JS="$RUNTIME_JS.bak.$(date +%Y%m%d-%H%M%S)"

echo "[*] Backing up $RUNTIME_JS -> $BACKUP_JS"
cp -f "$RUNTIME_JS" "$BACKUP_JS"

cat > "$RUNTIME_JS" <<'JS'
// gateway/usecases/runtime.js
// Rewritten to resolve model refs (id:tag / Modelfile / sha256 / .gguf)
// to an absolute GGUF path before starting llama-server.
// Keeps hardware-profile behavior and logs.

import { spawn } from 'child_process';
import { getMachineProfile, getUserProfile } from '../db/hwStore.js';

// IMPORTANT: export the pure resolver from routes/modelResolver.js:
//   export function resolveModelPath(arg) { ... }
// This avoids HTTP self-calls and Ollama dependency.
import { resolveModelPath } from '../routes/modelResolver.js';

let serverProc = null;

function extractArg(args, flag) {
  const i = Array.isArray(args) ? args.indexOf(flag) : -1;
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
}
function upsertArg(args, flag, value) {
  const out = Array.isArray(args) ? [...args] : [];
  const i = out.indexOf(flag);
  if (i >= 0) {
    if (out[i + 1]) out[i + 1] = value;
    else out.splice(i + 1, 0, value);
  } else {
    out.push(flag, value);
  }
  return out;
}

export async function startLlamaServerUseCase(req, res) {
  if (serverProc && !serverProc.killed) {
    return res.status(409).json({ ok: false, error: 'server already running' });
  }

  // Choose profile scope (unchanged)
  const scope = (req.body && req.body.scope) === 'user' ? 'user' : 'machine';
  const prof =
    scope === 'user' && req.session?.userId
      ? getUserProfile(req.session.userId)
      : getMachineProfile();

  if (!prof?.recommend?.server) {
    return res.status(400).json({ ok: false, error: 'no hardware profile; run /optimize/hw/run first' });
  }

  const cmd = prof.recommend.server.cmd;
  let args = prof.recommend.server.args || [];
  const env = { ...process.env, ...(prof.recommend.server.env || {}) };

  // Resolve model ref -> absolute GGUF
  // Priority: body.arg|model|modelArg -> env.MODEL_ARG -> args["-m"] (from profile)
  const body = req.body || {};
  const reqRef =
    (typeof body.arg === 'string' && body.arg) ||
    (typeof body.model === 'string' && body.model) ||
    (typeof body.modelArg === 'string' && body.modelArg) ||
    (process.env.MODEL_ARG || '') ||
    extractArg(args, '-m');

  if (!reqRef) {
    return res.status(400).json({ ok: false, error: 'missing model arg (body.arg/model/modelArg or env.MODEL_ARG or profile -m)' });
  }

  let resolvedPath;
  try {
    const r = resolveModelPath(reqRef); // { path, source, ... }
    resolvedPath = r?.path;
    if (!resolvedPath) throw new Error('resolver returned no path');
  } catch (e) {
    return res.status(400).json({ ok: false, error: `model resolve failed: ${e && e.message || e}` });
  }

  // Ensure -m points to the resolved GGUF
  args = upsertArg(args, '-m', resolvedPath);

  // Host/port: prefer explicit envs, else keep profile args
  const host =
    body.host ||
    process.env.LHOST ||
    '127.0.0.1';
  const port =
    Number(body.port || process.env.LLAMACPP_PORT || process.env.LPORT || 11434);

  args = upsertArg(args, '--host', String(host));
  args = upsertArg(args, '--port', String(port));

  // Ensure LLAMACPP_SERVER for the gateway's /ready checks
  if (!env.LLAMACPP_SERVER) {
    env.LLAMACPP_SERVER = `http://${host}:${port}`;
  }

  serverProc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let started = false;

  serverProc.stdout.on('data', (d) => {
    const s = d.toString();
    if (!started && /listening|http server running|serving|ready/i.test(s)) {
      started = true;
    }
    process.stdout.write(`[llama-server] ${s}`);
  });
  serverProc.stderr.on('data', (d) => process.stderr.write(`[llama-server] ${d}`));
  serverProc.on('close', (code) => {
    serverProc = null;
    console.log(`[llama-server] exited ${code}`);
  });

  return res.json({
    ok: true,
    pid: serverProc.pid,
    cmd,
    args,
    scope,
    resolvedModelPath: resolvedPath,
    host,
    port
  });
}

export async function stopLlamaServerUseCase(_req, res) {
  if (!serverProc) return res.json({ ok: true, already: 'stopped' });
  try {
    serverProc.kill('SIGTERM');
  } catch {}
  return res.json({ ok: true, stopping: true });
}
JS

echo "[ok] Updated $RUNTIME_JS"
echo
echo "Smoke test:"
echo "  curl -s 'http://127.0.0.1:3123/model/resolve?arg=SimonPu/gpt-oss:20b_Q4' | jq ."
echo "  curl -s -X POST 'http://127.0.0.1:3123/runtime/llama/start' -H 'content-type: application/json' -d '{\"arg\":\"SimonPu/gpt-oss:20b_Q4\"}' | jq ."
