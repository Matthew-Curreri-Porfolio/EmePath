// Orchestrate local stack: llama.cpp server, Ollama-compatible proxy, and gateway
// Configuration via env (sensible defaults):
//   LLAMA_MODEL_PATH, LLAMACPP_PORT=8088, OLLAMA_PROXY_PORT=11434, GATEWAY_PORT=3123
//   WHOOGLE_BASE=http://127.0.0.1:5010
//   GATEWAY_PYTHON=$HOME/miniconda3/envs/gateway/bin/python (preferred) or via PATH/conda
//   MODEL_SEARCH_ROOTS=colon:separated:paths (to help find .gguf)

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { modelRoots, manifestRoots, blobPathForDigest, resolvePython } from '../gateway/config/paths.js';
import { getConfig } from '../gateway/config/index.js';

const ROOT = process.cwd();
const BIN_SERVER = process.env.LLAMACPP_BIN || path.join(ROOT, 'llama.cpp/build/bin/llama-server');
const BIN_GGUF = process.env.LLAMA_GGUF_BIN || path.join(ROOT, 'llama.cpp/build/bin/llama-gguf');
const CFG = getConfig();
const LLAMACPP_PORT = CFG.ports.llamacpp;
const OLLAMA_PROXY_PORT = CFG.ports.ollamaProxy;
const GATEWAY_PORT = CFG.ports.gateway;
const SEARXNG_BASE = CFG.searxng.base;
const SEARXNG_PORT = Number(process.env.SEARXNG_PORT || 8888);
const SEARXNG_HOST = process.env.SEARXNG_HOST || '127.0.0.1';

function log(obj) { console.log(JSON.stringify({ ts: new Date().toISOString(), ...obj })); }

function exists(p) { try { fs.statSync(p); return true; } catch { return false; } }
function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }


function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function httpOk(url, opts) {
  try {
    const r = await fetch(url, opts);
    return r.ok;
  } catch { return false; }
}

function readFirst4(p) {
  const fd = fs.openSync(p, 'r');
  try {
    const b = Buffer.alloc(4);
    fs.readSync(fd, b, 0, 4, 0); return b.toString('utf8');
  } finally { fs.closeSync(fd); }
}

function* walk(dir, depth = 3) {
  const q = [{ d: dir, k: 0 }];
  while (q.length) {
    const { d, k } = q.shift();
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && k < depth) q.push({ d: p, k: k + 1 });
      else if (e.isFile()) yield p;
    }
  }
}

function discoverModelCandidates() {
  const dirs = modelRoots();
  const found = [];
  for (const r of dirs) {
    const blobs = path.join(r, 'blobs');
    if (isDir(blobs)) {
      for (const p of walk(blobs, 2)) {
        try { if (readFirst4(p) === 'GGUF') found.push(p); } catch {}
      }
    }
    for (const p of walk(r, 3)) if (p.toLowerCase().endsWith('.gguf')) {
      try { if (readFirst4(p) === 'GGUF') found.push(p); } catch {}
    }
  }
  // unique
  return Array.from(new Set(found));
}

function sizeOf(p) { try { return fs.statSync(p).size; } catch { return Number.MAX_SAFE_INTEGER; } }

async function isGenerativeModel(p) {
  // Use llama-gguf -i to read metadata and filter out embedding-only models like nomic-bert
  if (!isFile(BIN_GGUF)) return true; // best-effort
  try {
    const proc = spawn(BIN_GGUF, ['-i', p], { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    await new Promise((resolve, reject) => {
      proc.stdout.on('data', d => chunks.push(d));
      proc.on('error', reject);
      proc.on('close', () => resolve());
    });
    const out = Buffer.concat(chunks).toString('utf8');
    const archLine = (out.match(/arch\s*=\s*([\w\-]+)/i) || [])[1] || '';
    if (/nomic-bert|embed|e5|bge/i.test(archLine)) return false;
    // prefer models with causal attention
    const causal = /causal\s*attn\s*=\s*1|true/i.test(out);
    if (causal || /llama|qwen|mistral|gemma|phi|deepseek|command/i.test(archLine)) return true;
    // Heuristic fallback when -i output is empty or unknown
    const base = path.basename(p).toLowerCase();
    if (/nomic|embed|bge|e5/.test(base)) return false;
    // If file is reasonably large, assume generative
    if (sizeOf(p) > 500 * 1024 * 1024) return true;
    return false;
  } catch {
    return true;
  }
}

function discoverManifestRoots() { return manifestRoots(); }

function parseManifestFile(p) {
  try {
    const txt = fs.readFileSync(p, 'utf8');
    const j = JSON.parse(txt);
    const layer = Array.isArray(j.layers) ? j.layers.find(x => /application\/vnd\.ollama\.image\.model/.test(x.mediaType || '')) : null;
    if (!layer || !layer.digest || !/^sha256:/.test(layer.digest)) return null;
    const rel = p.split('/manifests/')[1] || p;
    // rel like: registry.ollama.ai/library/qwen3/8b:1
    const ref = rel.replace(/^registry\.ollama\.ai\//, '');
    return { ref, digest: layer.digest.replace(/^sha256:/, ''), size: layer.size || 0, file: p };
  } catch { return null; }
}

function listAllManifestEntries() {
  const roots = discoverManifestRoots();
  const out = [];
  for (const r of roots) {
    for (const p of walk(r, 6)) {
      if (!/\/[0-9]+:?[^/]*$/.test(p)) continue; // likely tag files
      const ent = parseManifestFile(p);
      if (ent) out.push(ent);
    }
  }
  return out;
}

function scoreRefForChat(ref) {
  const s = ref.toLowerCase();
  let score = 0;
  if (/instruct|chat|assistant|it\b/.test(s)) score += 50;
  if (/hermes|mistral|llama-?3|gemma|qwen|phi|command|deepseek/.test(s)) score += 20;
  if (/coder/.test(s)) score += 5; // acceptable
  if (/base\b/.test(s)) score -= 10;
  if (/embed|bert|e5|bge/.test(s)) score -= 100; // reject
  return score;
}

// use imported blobPathForDigest

function pickModelFromManifests() {
  const entries = listAllManifestEntries();
  if (!entries.length) return '';
  // Env override by ref
  const ref = process.env.LLAMA_MODEL_REF || process.env.OLLAMA_MODEL_REF || process.env.MODEL;
  if (ref) {
    const hit = entries.find(e => e.ref.includes(ref));
    if (hit) {
      const p = blobPathForDigest(hit.digest);
      if (p) return p;
    }
  }
  // Favorites first (user preference): abliterated qwen 8b, then unsloth variants if present
  const favorites = Array.isArray(CFG.models.favorites) && CFG.models.favorites.length ? CFG.models.favorites : [
    'jaahas/qwen3-abliterated/8b',
    'library/qwen3/8b'
  ];
  for (const fav of favorites) {
    const hit = entries.find(e => e.ref.includes(fav));
    if (hit) {
      const p = blobPathForDigest(hit.digest);
      if (p) {
        log({ event: 'favorite_model_hit', ref: hit.ref, digest: hit.digest, path: p });
        return p;
      }
    }
  }
  // Score instruct/chat candidates
  const scored = entries.map(e => ({ e, score: scoreRefForChat(e.ref) }))
    .filter(x => x.score > -50) // exclude known non-generative
    .sort((a, b) => b.score - a.score || a.e.size - b.e.size);
  for (const { e } of scored) {
    const p = blobPathForDigest(e.digest);
    if (p) return p;
  }
  return '';
}

async function pickModel() {
  // Explicit path has highest priority
  const envPath = process.env.LLAMA_MODEL_PATH;
  if (envPath && isFile(envPath)) return envPath;
  // Try resolving via Ollama manifests to prefer instruct/chat variants
  const viaManifest = pickModelFromManifests();
  if (viaManifest) return viaManifest;
  const cands = discoverModelCandidates();
  const scored = [];
  for (const p of cands) {
    if (!(await isGenerativeModel(p))) continue;
    scored.push({ p, sz: sizeOf(p) });
  }
  if (!scored.length) throw new Error('No suitable GGUF models found');
  scored.sort((a, b) => a.sz - b.sz);
  return scored[0].p;
}

async function startProcess(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  let last = '';
  child.stdout.on('data', d => { last = d.toString(); process.stdout.write(`[${path.basename(cmd)}] ${last}`); });
  child.stderr.on('data', d => { last = d.toString(); process.stderr.write(`[${path.basename(cmd)}] ${last}`); });
  child.on('error', (e) => log({ event: 'proc_error', cmd, error: String(e && e.message || e) }));
  return child;
}

async function startLlamaServer(modelPath) {
  // Log model metadata (helps diagnose gibberish/base models)
  if (isFile(BIN_GGUF)) {
    try {
      const meta = await new Promise((resolve) => {
        const c = spawn(BIN_GGUF, ['-i', modelPath], { stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        c.stdout.on('data', d => { out += String(d); });
        c.on('close', () => resolve(out));
      });
      const arch = (meta.match(/arch\s*=\s*([\w\-]+)/i) || [])[1] || '';
      const name = (meta.match(/general\.name\s+str\s*=\s*(.+)/i) || [])[1] || '';
      const causal = /causal\s*attn\s*=\s*1|true/i.test(meta);
      log({ event: 'model_meta', arch, name: name.trim(), causal });
    } catch {}
  }
  const base = `http://127.0.0.1:${LLAMACPP_PORT}`;
  if (await httpOk(`${base}/v1/models`)) {
    log({ event: 'reuse_llama_server', base });
    return { child: null, base };
  }
  if (!isFile(BIN_SERVER)) throw new Error(`llama-server not found at ${BIN_SERVER}`);
  const args = ['-m', modelPath, '--port', String(LLAMACPP_PORT), '-c', '2048'];
  log({ event: 'start_llama_server', modelPath, args });
  const child = startProcess(BIN_SERVER, args);
  // wait for /v1/models
  for (let i = 0; i < 120; i++) {
    if (await httpOk(`${base}/v1/models`)) break;
    await sleep(1000);
  }
  // wait until a tiny completion is accepted (no 503)
  for (let i = 0; i < 180; i++) {
    try {
      const r = await fetch(`${base}/v1/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'default', prompt: 'hi', max_tokens: 1 }),
      });
      if (r.status === 200) break;
    } catch {}
    await sleep(1000);
  }
  return { child, base };
}

async function startOllamaProxy(llamaBase) {
  const py = resolvePython();
  const script = path.join(ROOT, 'gateway/scripts/llamacpp_ollama_proxy.py');
  if (!isFile(script)) throw new Error('llamacpp_ollama_proxy.py missing');
  const localModels = [path.join(process.env.HOME || '', '.ollama/models'), path.join(ROOT, 'models')].find(isDir) || path.join(process.env.HOME || '', '.ollama/models');
  const env = { ...process.env, LLAMACPP_SERVER: llamaBase, OLLAMA_LOCAL_MODELS: localModels, PORT: String(OLLAMA_PROXY_PORT) };
  const base = `http://127.0.0.1:${OLLAMA_PROXY_PORT}`;
  if (await httpOk(`${base}/api/version`)) {
    log({ event: 'reuse_ollama_proxy', base });
    return { child: null, base };
  }
  log({ event: 'start_ollama_proxy', py, port: OLLAMA_PROXY_PORT, llamaBase, localModels });
  const child = startProcess(py, [script], { env });
  for (let i = 0; i < 20; i++) { if (await httpOk(`${base}/api/version`)) break; await sleep(500); }
  return { child, base };
}

async function ensureSearxng() {
  const base = SEARXNG_BASE.replace(/\/$/, '');
  if (await httpOk(`${base}/search?q=test&format=json`)) { log({ event: 'searxng_ok', base }); return { child: null, base }; }
  // Try Docker
  const hasDocker = await new Promise((resolve) => {
    const c = spawn('bash', ['-lc', 'command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && echo ok || true']);
    let ok = false; c.stdout.on('data', d => { if (String(d).includes('ok')) ok = true; }); c.on('close', () => resolve(ok));
  });
  if (hasDocker) {
    // Prefer docker compose with our file
    const composeFile = path.join(ROOT, 'scripts/docker-compose.searxng.yml');
    const hasCompose = await new Promise((resolve) => {
      const c = spawn('bash', ['-lc', 'docker compose version >/dev/null 2>&1 && echo ok || true']);
      let ok = false; c.stdout.on('data', d => { if (String(d).includes('ok')) ok = true; }); c.on('close', () => resolve(ok));
    });
    if (hasCompose && isFile(composeFile)) {
      const cmd = ['docker', 'compose', '-f', composeFile, 'up', '-d'];
      log({ event: 'start_searxng_compose', cmd: cmd.join(' ') });
      try { await startProcess(cmd[0], cmd.slice(1)); } catch {}
    } else {
      const run = ['docker', 'run', '-d', '--name', 'searxng', '-p', `${SEARXNG_HOST}:${SEARXNG_PORT}:8080`, '--restart', 'unless-stopped', 'searxng/searxng:latest'];
      log({ event: 'start_searxng_docker', cmd: run.join(' ') });
      try { await startProcess(run[0], run.slice(1)); } catch {}
    }
    for (let i = 0; i < 60; i++) { if (await httpOk(`${base}/search?q=test&format=json`)) break; await sleep(1000); }
    if (await httpOk(`${base}/search?q=test&format=json`)) return { child: null, base };
  }
  // Try Podman rootless
  const hasPodman = await new Promise((resolve) => {
    const c = spawn('bash', ['-lc', 'command -v podman >/dev/null 2>&1 && podman info >/dev/null 2>&1 && echo ok || true']);
    let ok = false; c.stdout.on('data', d => { if (String(d).includes('ok')) ok = true; }); c.on('close', () => resolve(ok));
  });
  if (hasPodman) {
    const run = ['podman', 'run', '-d', '--name', 'searxng', '-p', `${SEARXNG_HOST}:${SEARXNG_PORT}:8080`, '--restart', 'unless-stopped', 'docker.io/searxng/searxng:latest'];
    log({ event: 'start_searxng_podman', cmd: run.join(' ') });
    try { await startProcess(run[0], run.slice(1)); } catch {}
    for (let i = 0; i < 60; i++) { if (await httpOk(`${base}/search?q=test&format=json`)) break; await sleep(1000); }
    if (await httpOk(`${base}/search?q=test&format=json`)) return { child: null, base };
  }
  log({ event: 'searxng_unavailable', base });
  return { child: null, base, failed: true };
}

async function startGateway(llamaBase) {
  const env = { ...process.env, LLAMACPP_SERVER: llamaBase, SEARXNG_BASE, GATEWAY_PORT: String(GATEWAY_PORT) };
  const entry = path.join(ROOT, 'gateway/server.js');
  const base = `http://127.0.0.1:${GATEWAY_PORT}`;
  if (await httpOk(`${base}/health`)) {
    log({ event: 'reuse_gateway', base });
    return { child: null, base };
  }
  log({ event: 'start_gateway', port: GATEWAY_PORT });
  const child = startProcess('node', [entry], { env });
  for (let i = 0; i < 20; i++) { if (await httpOk(`${base}/health`)) break; await sleep(500); }
  return { child, base };
}

async function streamWarmupWithFeedback(gwBase, { timeoutMs = 10000 } = {}) {
  const url = `${gwBase.replace(/\/$/, '')}/warmup/stream`;
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept': 'text/event-stream' },
      body: '{}',
      signal: controller.signal,
    });
    if (!res.body) { log({ event: 'warmup_stream_no_body' }); return; }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let remaining = 30; // cap lines to avoid noisy logs
    while (remaining-- > 0) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      const text = dec.decode(value);
      for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        try {
          const msg = JSON.parse(raw);
          if (msg && msg.event === 'status') {
            log({ event: 'warmup_status', state: msg.state, via: msg.via, ms: msg.ms, error: msg.error });
            if (msg.state === 'ok' || msg.state === 'error') {
              try { await reader.cancel(); } catch {}
              return;
            }
          }
        } catch {
          // ignore parse errors
        }
      }
    }
  } catch (e) {
    log({ event: 'warmup_stream_error', error: String(e && e.message || e) });
  } finally { clearTimeout(to); }
}

async function main() {
  try {
    // Optional preflight-only mode: --check
    const argv = new Set(process.argv.slice(2));
    const searxOnly = argv.has('--searxng-only');
    const checkOnly = argv.has('--check') || process.env.STACK_MODE === 'check';

    const searxRes = await ensureSearxng();
    if (searxRes.failed) log({ event: 'searxng_unavailable', base: SEARXNG_BASE });
    if (searxOnly) return;
    // CI-friendly fast path: when running in check mode on CI, skip heavy llama checks
    if (checkOnly && (process.env.CI === 'true' || process.env.STACK_NO_LLAMA === '1')) {
      log({ event: 'check_complete', ok: true, skipped: 'llama_gateway' });
      return process.exit(0);
    }
    const modelPath = await pickModel();
    log({ event: 'model_selected', modelPath, size: sizeOf(modelPath) });
    const { child: llamaProc, base: llamaBase } = await startLlamaServer(modelPath);
    const { child: ollamaProc, base: ollamaBase } = await startOllamaProxy(llamaBase);
    const { child: gwProc, base: gwBase } = await startGateway(llamaBase);

    if (checkOnly) {
      const ok = await httpOk(`${gwBase}/health`);
      log({ event: 'check_complete', ok });
      // In check mode, leave llama-server running by default (configurable)
      if (!CFG.runtime.keepLlamaOnExit) { try { llamaProc?.kill('SIGTERM'); } catch {} }
      try { ollamaProc?.kill('SIGTERM'); } catch {}
      try { gwProc?.kill('SIGTERM'); } catch {}
      return process.exit(ok ? 0 : 1);
    }

    // Quick smoke checks
    const chatR = await fetch(`${llamaBase}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'default', messages: [{ role: 'user', content: 'Say hi' }], max_tokens: 8 }) });
    log({ event: 'llama_chat_status', status: chatR.status });
    const tagsR = await fetch(`${ollamaBase}/api/tags`).then(r => r.json()).catch(() => ({}));
    log({ event: 'ollama_tags_count', count: Array.isArray(tagsR?.models) ? tagsR.models.length : 0 });
    const healthR = await fetch(`${gwBase}/health`).then(r => r.json()).catch(() => ({}));
    log({ event: 'gateway_health', ok: healthR?.ok === true });

    log({ event: 'stack_ready', llamaBase, ollamaBase, gwBase, searxng: SEARXNG_BASE });
    // Kick a warmup with streaming feedback in the background (best-effort)
    streamWarmupWithFeedback(gwBase, { timeoutMs: 15000 }).catch(() => {});

    // Keep alive until SIGINT/SIGTERM
    const shutdown = () => {
      log({ event: 'shutdown' });
      // Leave llama-server running unless explicitly disabled via config
      if (!CFG.runtime.keepLlamaOnExit) { try { llamaProc?.kill('SIGTERM'); } catch {} }
      try { ollamaProc.kill('SIGTERM'); } catch {}
      try { gwProc.kill('SIGTERM'); } catch {}
    };
    process.once('SIGINT', () => { shutdown(); process.exit(130); });
    process.once('SIGTERM', () => { shutdown(); process.exit(143); });
  } catch (e) {
    log({ event: 'fatal', error: String(e && e.message || e) });
    process.exit(1);
  }
}

main();
