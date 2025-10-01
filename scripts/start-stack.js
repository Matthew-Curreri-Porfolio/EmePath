// Orchestrate local stack: Python LoRA server and the gateway
// Configuration via env (sensible defaults):
//   LORA_SERVER_PORT=8000, GATEWAY_PORT=3123
//   WHOOGLE_BASE=http://127.0.0.1:5010
//   GATEWAY_PYTHON=$HOME/miniconda3/envs/gateway/bin/python (preferred) or via PATH/conda

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { modelRoots, manifestRoots, blobPathForDigest, resolvePython } from '../gateway/config/paths.js';
import { getConfig } from '../gateway/config/index.js';
import {
  run,
  get,
  all,
  setStackPid,
  getAllStackPids,
  removeStackPidByPid,
} from '../gateway/db/db.js';

const ROOT = process.cwd();
// llama.cpp binaries (temporarily unused; kept for future fallback)
const BIN_SERVER = process.env.LLAMACPP_BIN || path.join(ROOT, 'llama.cpp/build/bin/llama-server');
const BIN_GGUF = process.env.LLAMA_GGUF_BIN || path.join(ROOT, 'llama.cpp/build/bin/llama-gguf');
const CFG = getConfig();
const LLAMACPP_PORT = CFG.ports.llamacpp;
const OLLAMA_PROXY_PORT = CFG.ports.ollamaProxy;
const LORA_SERVER_PORT = Number(process.env.LORA_SERVER_PORT || 8000);
const DEFAULT_UNSLOTH_BASE = process.env.DEFAULT_UNSLOTH_BASE || 'unsloth/Qwen2.5-7B';
const DEFAULT_UNSLOTH_4BIT = process.env.DEFAULT_UNSLOTH_4BIT || 'unsloth/Qwen2.5-7B-Instruct-bnb-4bit';
const GATEWAY_PORT = CFG.ports.gateway;
const SEARXNG_BASE = CFG.searxng.base;
const SEARXNG_PORT = Number(process.env.SEARXNG_PORT || 8888);
const SEARXNG_HOST = process.env.SEARXNG_HOST || '127.0.0.1';
// Opinionated generation defaults (can be overridden via shell env)
const GEN_DEFAULTS = {
  LORA_DETERMINISTIC: process.env.LORA_DETERMINISTIC || '1',
  LORA_DEFAULT_MAX_NEW_TOKENS: process.env.LORA_DEFAULT_MAX_NEW_TOKENS || '96',
  LORA_DEFAULT_TEMPERATURE: process.env.LORA_DEFAULT_TEMPERATURE || '0.2',
  LORA_DEFAULT_TOP_P: process.env.LORA_DEFAULT_TOP_P || '0.85',
  LORA_DEFAULT_TOP_K: process.env.LORA_DEFAULT_TOP_K || '',
  LORA_DEFAULT_REPETITION_PENALTY:
    process.env.LORA_DEFAULT_REPETITION_PENALTY || '1.15',
  LORA_TRIM_ROLE_MARKERS: process.env.LORA_TRIM_ROLE_MARKERS || '1',
  LORA_DEVICE_MAP: process.env.LORA_DEVICE_MAP || 'auto',
  LORA_TORCH_DTYPE: process.env.LORA_TORCH_DTYPE || 'bf16',
};
const LOCAL_HF_PATH = path.join(
  ROOT,
  'gateway',
  'models',
  'base',
  'gpt-oss-20b-bf16'
);
const LOCAL_GGUF_PATH = path.join(
  ROOT,
  'gateway',
  'models',
  'base',
  'gpt_unlocked',
  'OpenAI-20B-NEO-Uncensored2-IQ4_NL.gguf'
);
const LOG_FILE = path.join(ROOT, 'stack.log');

function log(obj) { console.log(JSON.stringify({ ts: new Date().toISOString(), ...obj })); }

function exists(p) { try { fs.statSync(p); return true; } catch { return false; } }
function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

function isStackRunning() {
  try {
    const row = get(`SELECT COUNT(*) as count FROM stack_pids`);
    return row.count > 0;
  } catch { return false; }
}


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

function findLocalModelPath() {
  // Priority: a) explicit GGUF under gateway/models (prefer names with unlocked/uncensored)
  //           b) any GGUF under gateway/models
  //           c) HF directory containing config.json (prefer qwen*)
  try {
    const root = path.join(ROOT, 'gateway', 'models');
    const ggufHits = [];
    const stack = [{ d: root, k: 0 }];
    const maxDepth = 4;
    while (stack.length) {
      const { d, k } = stack.pop();
      let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (k < maxDepth) stack.push({ d: p, k: k + 1 }); }
        else if (e.isFile() && p.toLowerCase().endsWith('.gguf')) {
          ggufHits.push({ path: p, name: path.basename(p) });
        }
      }
    }
    if (ggufHits.length) {
      const scoreG = (nm) => {
        const s = nm.toLowerCase();
        let score = 0;
        if (/unlocked|uncensored|abliterated|gpt_unlocked/.test(s)) score += 1000;
        if (/qwen|llama|mistral|gemma|phi|deepseek/.test(s)) score += 100;
        return score;
      };
      ggufHits.sort((a, b) => scoreG(b.name) - scoreG(a.name));
      return ggufHits[0].path;
    }
    // HF fallback
    const hfHits = [];
    const stack2 = [{ d: root, k: 0 }];
    while (stack2.length) {
      const { d, k } = stack2.pop();
      let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (k < maxDepth) stack2.push({ d: p, k: k + 1 }); }
        else if (e.isFile() && e.name === 'config.json') {
          const dir = path.dirname(p);
          if (/(^|\/|\\)loras(\/|\\|$)/.test(dir)) continue;
          const name = path.basename(dir);
          hfHits.push({ name, path: dir });
        }
      }
    }
    if (hfHits.length) {
      const score = (n) => {
        const s = n.toLowerCase();
        if (/qwen/.test(s)) return 100;
        if (/mistral|gemma|phi/.test(s)) return 80;
        return 10;
      };
      hfHits.sort((a, b) => score(b.name) - score(a.name) || a.name.localeCompare(b.name));
      return hfHits[0].path;
    }
    return '';
  } catch { return ''; }
}

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
      if (!/\/[0-9]+:?[^\/]*$/.test(p)) continue; // likely tag files
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
  const { stackName = null, stackMeta = {}, ...spawnOpts } = opts || {};
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...spawnOpts });
  let last = '';
  child.stdout.on('data', d => { last = d.toString(); process.stdout.write(`[${path.basename(cmd)}] ${last}`); });
  child.stderr.on('data', d => { last = d.toString(); process.stderr.write(`[${path.basename(cmd)}] ${last}`); });
  child.on('error', (e) => log({ event: 'proc_error', cmd, error: String(e && e.message || e) }));
  let stackId = null;
  if (stackName) {
    try {
      const { meta: customMeta, ...restMeta } = stackMeta || {};
      stackId = setStackPid(stackName, child.pid, {
        command: cmd,
        args,
        cwd: spawnOpts.cwd || process.cwd(),
        user: process.env.USER || process.env.LOGNAME || null,
        meta: { hostname: os.hostname(), ...(customMeta || {}) },
        ...restMeta,
      });
    } catch (e) {
      log({ event: 'stack_pid_register_error', name: stackName, pid: child.pid, error: String(e && e.message || e) });
    }
  }
  const cleanup = () => {
    try {
      if (stackId) removeStackPidByPid(child.pid);
    } catch {}
  };
  child.once('exit', cleanup);
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
      const name = (meta.match(/general.name\s+str\s*=\s*(.+)/i) || [])[1] || '';
      const causal = /causal\s*attn\s*=\s*1|true/i.test(meta);
      log({ event: 'model_meta', arch, name: name.trim(), causal });
    } catch {}
  }
  const base = `http://127.0.0.1:${LLAMACPP_PORT}`;
  if (await httpOk(`${base}/v1/models`)) {
    log({ event: 'reuse_llama_server', base });
    try {
      const pids = await getProcessesOnPorts([LLAMACPP_PORT]);
      if (pids && pids[0]) {
        setStackPid('llama-server', pids[0], {
          role: 'service',
          tag: 'llama',
          port: LLAMACPP_PORT,
          command: BIN_SERVER,
          args,
          cwd: ROOT,
          meta: { reused: true, hostname: os.hostname() },
        });
      }
    } catch {}
    return { child: null, base };
  }
  if (!isFile(BIN_SERVER)) throw new Error(`llama-server not found at ${BIN_SERVER}`);
  const args = ['-m', modelPath, '--port', String(LLAMACPP_PORT), '-c', '2048'];
  log({ event: 'start_llama_server', modelPath, args });
  const child = startProcess(BIN_SERVER, args, {
    stackName: 'llama-server',
    stackMeta: { role: 'service', tag: 'llama', port: LLAMACPP_PORT },
  });
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

  const localModels =
    [path.join(process.env.HOME || '', '.ollama/models'), path.join(ROOT, 'models')].find(isDir) ||
    path.join(process.env.HOME || '', '.ollama/models');

  const base = `http://127.0.0.1:${OLLAMA_PROXY_PORT}`;
  if (await httpOk(`${base}/api/version`)) {
    log({ event: 'reuse_ollama_proxy', base });
    try {
      const pids = await getProcessesOnPorts([OLLAMA_PROXY_PORT]);
      if (pids && pids[0]) {
        setStackPid('ollama-proxy', pids[0], {
          role: 'service',
          tag: 'ollama-proxy',
          port: OLLAMA_PROXY_PORT,
          command: py,
          args,
          cwd: ROOT,
          meta: { reused: true, hostname: os.hostname() },
        });
      }
    } catch {}
    return { child: null, base };
  }

  log({ event: 'start_ollama_proxy', py, port: OLLAMA_PROXY_PORT, llamaBase, localModels });

  // use CLI flags instead of only env vars
  const args = [
    script,
    '--port', String(OLLAMA_PROXY_PORT),
    '--llama-base', llamaBase,
    '--local-models', localModels,
    '--blob-dir', path.join(process.env.HOME || '', '.ollama/blobs'),
  ];

  const child = startProcess(py, args, {
    env: { ...process.env },
    stackName: 'ollama-proxy',
    stackMeta: { role: 'service', tag: 'ollama-proxy', port: OLLAMA_PROXY_PORT },
  });

  for (let i = 0; i < 20; i++) {
    if (await httpOk(`${base}/api/version`)) break;
    await sleep(500);
  }
  return { child, base };
}


// TTY rolling renderer: keeps last N lines visible, colorized; holds latest error
function makeRollingRenderer(name = 'status', maxLines = 4) {
  const isTTY = process.stdout && process.stdout.isTTY;
  const RESET = '\x1b[0m';
  const DIM = '\x1b[90m';
  const YELLOW = '\x1b[33m';
  const GREEN = '\x1b[32m';
  const RED = '\x1b[31m';
  const CYAN = '\x1b[36m';
  const prefix = `${CYAN}[${name}]${RESET}`;
  /** @type {{text:string,isError?:boolean}[]} */
  const lines = [];
  let rendered = 0;
  /** @type {null|{text:string,isError?:boolean}} */
  let heldError = null;

  const push = (text, { level = 'info', isError = false } = {}) => {
    let colored = text;
    if (level === 'info') colored = `${DIM}${text}${RESET}`;
    else if (level === 'warn') colored = `${YELLOW}${text}${RESET}`;
    else if (level === 'ok') colored = `${GREEN}${text}${RESET}`;
    else if (level === 'error') colored = `${RED}${text}${RESET}`;
    const entry = { text: `${prefix} ${colored}`, isError };
    if (isError) heldError = entry;
    lines.push(entry);
    // Trim to maxLines, but keep the held error if present
    while (lines.length > maxLines) {
      if (heldError && lines[0] === heldError) {
        // Keep error by removing next non-error line
        const idx = lines.findIndex((e) => e !== heldError);
        if (idx >= 0) lines.splice(idx, 1); else break;
      } else {
        lines.shift();
      }
    }
    render();
  };

  const render = () => {
    if (!isTTY) return;
    for (let i = 0; i < rendered; i++) {
      process.stdout.write('\x1b[2K\r');
      if (i < rendered - 1) process.stdout.write('\x1b[1A');
    }
    for (const l of lines) process.stdout.write(l.text + '\n');
    rendered = lines.length;
  };

  const finalize = () => { /* keep last block visible */ };

  return { push, finalize, colors: { RESET, DIM, YELLOW, GREEN, RED, CYAN }, prefix };
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

async function startGateway(loraBase) {
  const env = {
    ...process.env,
    ...GEN_DEFAULTS,
    LORA_SERVER_BASE: loraBase,
    SEARXNG_BASE,
    GATEWAY_PORT: String(GATEWAY_PORT),
    // Provide sensible defaults for Unsloth HF models if not set
    LORA_MODEL_NAME: process.env.LORA_MODEL_NAME || 'qwen3-7b',
    LORA_MODEL_PATH: (() => {
      if (process.env.LORA_MODEL_PATH) return process.env.LORA_MODEL_PATH;
      if (isDir(LOCAL_HF_PATH)) return LOCAL_HF_PATH;
      if (isFile(LOCAL_GGUF_PATH)) return LOCAL_GGUF_PATH;
      const local = findLocalModelPath();
      return local || DEFAULT_UNSLOTH_BASE;
    })(),
  };
  const entry = path.join(ROOT, 'gateway/server.js');
  const base = `http://127.0.0.1:${GATEWAY_PORT}`;
  if (await httpOk(`${base}/health`)) {
    log({ event: 'reuse_gateway', base });
    // best effort: discover PID and record
    try {
      const pids = await getProcessesOnPorts([GATEWAY_PORT]);
      if (pids && pids[0]) {
        setStackPid('gateway', pids[0], {
          role: 'service',
          tag: 'gateway',
          port: GATEWAY_PORT,
          command: 'node',
          args: [entry],
          cwd: ROOT,
          meta: { reused: true, hostname: os.hostname() },
        });
      }
    } catch {}
    return { child: null, base };
  }
  log({ event: 'start_gateway', port: GATEWAY_PORT, loraModelPath: env.LORA_MODEL_PATH });
  const child = startProcess('node', [entry], {
    env,
    stackName: 'gateway',
    stackMeta: { role: 'service', tag: 'gateway', port: GATEWAY_PORT },
  });
  for (let i = 0; i < 20; i++) { if (await httpOk(`${base}/health`)) break; await sleep(500); }
  return { child, base };
}

// Start the Python LoRA server (FastAPI) on LORA_SERVER_PORT
async function startLoraServer() {
  const py = resolvePython();
  const script = path.join(ROOT, 'gateway/lora_server.py');
  const base = `http://127.0.0.1:${LORA_SERVER_PORT}`;
  if (await httpOk(`${base}/models`)) {
    log({ event: 'reuse_lora_server', base });
    // best effort: discover PID and record
    try {
      const pids = await getProcessesOnPorts([LORA_SERVER_PORT]);
      if (pids && pids[0]) {
        setStackPid('lora', pids[0], {
          role: 'service',
          tag: 'lora-server',
          port: LORA_SERVER_PORT,
          command: py,
          args: [script],
          cwd: ROOT,
          meta: { reused: true, hostname: os.hostname() },
        });
      }
    } catch {}
    return { child: null, base };
  }
  log({ event: 'start_lora_server', py, port: LORA_SERVER_PORT });
  const child = startProcess(py, [script], {
    env: { ...process.env, ...GEN_DEFAULTS, PORT: String(LORA_SERVER_PORT) },
    stackName: 'lora',
    stackMeta: { role: 'service', tag: 'lora-server', port: LORA_SERVER_PORT },
  });
  for (let i = 0; i < 60; i++) { if (await httpOk(`${base}/models`)) break; await sleep(1000); }
  return { child, base };
}

async function streamWarmupWithFeedback(gwBase, { timeoutMs = 10000 } = {}) {
  const url = `${gwBase.replace(/\/$/, '')}/warmup/stream`;
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), timeoutMs);
  // Pretty console rendering (TTY-only): keep last 4 lines, colorized
  const isTTY = process.stdout && process.stdout.isTTY;
  const RESET = '\x1b[0m';
  const DIM = '\x1b[90m';
  const YELLOW = '\x1b[33m';
  const GREEN = '\x1b[32m';
  const RED = '\x1b[31m';
  const CYAN = '\x1b[36m';
  const last = [];
  let rendered = 0;
  let lockedError = false;
  const pushLine = (s) => {
    last.push(s);
    while (last.length > 4) last.shift();
  };
  const render = () => {
    if (!isTTY) return;
    // move cursor up and clear previous block
    for (let i = 0; i < rendered; i++) {
      process.stdout.write('\x1b[2K\r'); // clear line
      if (i < rendered - 1) process.stdout.write('\x1b[1A'); // move up
    }
    // print current block
    for (let i = 0; i < last.length; i++) {
      process.stdout.write(last[i] + '\n');
    }
    rendered = last.length;
  };
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
            if (isTTY && !lockedError) {
              const prefix = `${CYAN}[warmup]${RESET}`;
              if (msg.state === 'starting') pushLine(`${prefix} ${YELLOW}starting...${RESET}`);
              else if (msg.state === 'waiting') pushLine(`${prefix} ${DIM}waiting ${String(msg.ms || 0)}ms...${RESET}`);
              else if (msg.state === 'ok') pushLine(`${prefix} ${GREEN}ready (${msg.via || 'server'})${RESET}`);
              else if (msg.state === 'error') {
                lockedError = true;
                pushLine(`${prefix} ${RED}error: ${String(msg.error || 'unknown')}${RESET}`);
              } else pushLine(`${prefix} ${DIM}${msg.state}${RESET}`);
              render();
            }
            if (msg.state === 'ok' || msg.state === 'error') { try { await reader.cancel(); } catch {} return; }
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

// Get processes listening on specific ports using various methods
async function getProcessesOnPorts(ports) {
  const pids = new Set();

  // Try lsof first
  try {
    for (const port of ports) {
      const { spawn } = await import('child_process');
      const proc = spawn('lsof', ['-ti', `:${port}`], { stdio: ['ignore', 'pipe', 'ignore'] });
      const chunks = [];
      proc.stdout.on('data', d => chunks.push(d));
      await new Promise((resolve, reject) => {
        proc.on('close', resolve);
        proc.on('error', reject);
      });
      const output = Buffer.concat(chunks).toString('utf8').trim();
      if (output) {
        output.split('\n').forEach(line => {
          const pid = parseInt(line.trim());
          if (!isNaN(pid)) pids.add(pid);
        });
      }
    }
  } catch {}

  // Try netstat as fallback
  if (pids.size === 0) {
    try {
      for (const port of ports) {
        const { spawn } = await import('child_process');
        const proc = spawn('netstat', ['-tulpn'], { stdio: ['ignore', 'pipe', 'ignore'] });
        const chunks = [];
        proc.stdout.on('data', d => chunks.push(d));
        await new Promise((resolve, reject) => {
          proc.on('close', resolve);
          proc.on('error', reject);
        });
        const output = Buffer.concat(chunks).toString('utf8');
        const lines = output.split('\n');
        for (const line of lines) {
          if (line.includes(`:${port} `) && line.includes('LISTEN')) {
            const match = line.match(/(\d+)\//);
            if (match) {
              const pid = parseInt(match[1]);
              if (!isNaN(pid)) pids.add(pid);
            }
          }
        }
      }
    } catch {}
  }

  return Array.from(pids);
}

// Get processes by name/command using pgrep
async function getProcessesByName(patterns) {
  const pids = new Set();

  try {
    for (const pattern of patterns) {
      const { spawn } = await import('child_process');
      const proc = spawn('pgrep', ['-f', pattern], { stdio: ['ignore', 'pipe', 'ignore'] });
      const chunks = [];
      proc.stdout.on('data', d => chunks.push(d));
      await new Promise((resolve, reject) => {
        proc.on('close', resolve);
        proc.on('error', reject);
      });
      const output = Buffer.concat(chunks).toString('utf8').trim();
      if (output) {
        output.split('\n').forEach(line => {
          const pid = parseInt(line.trim());
          if (!isNaN(pid)) pids.add(pid);
        });
      }
    }
  } catch {}

  return Array.from(pids);
}

// Stop Docker/Podman containers
async function stopContainers() {
  const containers = ['searxng'];

  // Try docker first
  try {
    for (const container of containers) {
      const { spawn } = await import('child_process');
      const proc = spawn('docker', ['stop', container], { stdio: ['ignore', 'pipe', 'ignore'] });
      await new Promise((resolve, reject) => {
        proc.on('close', resolve);
        proc.on('error', reject);
      });
      console.log(`  - Stopped Docker container: ${container}`);
    }
  } catch {}

  // Try podman as fallback
  try {
    for (const container of containers) {
      const { spawn } = await import('child_process');
      const proc = spawn('podman', ['stop', container], { stdio: ['ignore', 'pipe', 'ignore'] });
      await new Promise((resolve, reject) => {
        proc.on('close', resolve);
        proc.on('error', reject);
      });
      console.log(`  - Stopped Podman container: ${container}`);
    }
  } catch {}
}

async function stopStack(force = false) {
  const hasPidFile = isStackRunning();

  if (force) {
    console.log('Force stopping stack processes (PID DB only)...');

    // Prefer strict DB PID shutdown to avoid terminating unrelated apps (e.g., VS Code)
    let killed = 0;
    if (hasPidFile) {
      try {
        const entries = getAllStackPids();
        const seenNames = new Set();
        for (const entry of entries) {
          seenNames.add(entry.name);
          if (!entry?.pid) continue;
          try {
            process.kill(entry.pid, 'SIGTERM');
            console.log(`    - ${entry.name}${entry.port ? ` (:${entry.port})` : ''} (pid: ${entry.pid}) stopped.`);
            killed++;
            removeStackPidByPid(entry.pid);
          } catch (e) {
            console.log(`    - ${entry.name} (pid: ${entry.pid}) not running: ${e.message}`);
            removeStackPidByPid(entry.pid);
          }
        }
        // If any expected pid is missing, attempt to discover and stop by port
        if (!seenNames.has('gateway')) {
          const gp = await getProcessesOnPorts([GATEWAY_PORT]);
          if (gp && gp[0]) {
            try { process.kill(gp[0], 'SIGTERM'); killed++; } catch {}
          }
        }
        if (!seenNames.has('lora')) {
          const lp = await getProcessesOnPorts([LORA_SERVER_PORT]);
          if (lp && lp[0]) {
            try { process.kill(lp[0], 'SIGTERM'); killed++; } catch {}
          }
        }
      } catch (e) {
        console.log(`  - Error reading PID DB: ${e.message}`);
      }
    }

    // Optional broad kill only when explicitly enabled
    if (killed === 0 && process.env.STACK_WIDE_KILL === '1') {
      console.log('  - PID file empty; performing wide kill (STACK_WIDE_KILL=1)');
      // Define ports to check (gateway, lora, searxng, emepath range)
      const ports = [
        GATEWAY_PORT,
        LORA_SERVER_PORT,
        SEARXNG_PORT,
        ...Array.from({ length: 100 }, (_, i) => 51100 + i),
      ];
      const portPids = await getProcessesOnPorts(ports);
      for (const pid of portPids) {
        try { process.kill(pid, 'SIGTERM'); killed++; } catch {}
      }
      const nodePids = await getProcessesByName(['EmePath.js', 'gateway/server.js']);
      for (const pid of nodePids) { try { process.kill(pid, 'SIGTERM'); killed++; } catch {} }
      const pyPids = await getProcessesByName(['lora_server.py', 'uvicorn']);
      for (const pid of pyPids) { try { process.kill(pid, 'SIGTERM'); killed++; } catch {} }
    }

    // Stop containers only if requested
    if (process.env.STACK_STOP_CONTAINERS === '1') {
      await stopContainers();
    }

    // Clear PID records from DB
    if (hasPidFile) {
      try {
        run(`DELETE FROM stack_pids`, []);
      } catch (e) {
        console.log(`  - Failed to clear PID records: ${e.message}`);
      }
    }

    console.log('Force stop completed.');

  } else {
    // Original graceful stop logic
    if (!hasPidFile) {
      console.log('Stack not running (no PID records in DB).');
      return;
    }
    console.log('Stopping stack gracefully...');
    const entries = getAllStackPids();
    const managerEntry = entries.find((e) => e.name === 'manager');
    const managerPid = managerEntry?.pid;

    if (managerPid) {
      try {
        process.kill(-managerPid, 'SIGTERM');
        console.log(`  - Sent SIGTERM to manager process group (pgid: ${managerPid}).`);
      } catch (e) {
        console.log(`  - Failed to kill process group ${managerPid}: ${e.message}.`);
        console.log('  - Falling back to killing processes individually.');
        for (const entry of entries) {
          if (!entry?.pid) continue;
          try {
            process.kill(entry.pid, 'SIGTERM');
            console.log(`    - ${entry.name} (pid: ${entry.pid}) stopped.`);
          } catch (err) {
            console.log(`    - ${entry.name} (pid: ${entry.pid}) already stopped or failed to stop: ${err.message}`);
          } finally {
            removeStackPidByPid(entry.pid);
          }
        }
      }
    } else {
      console.log('  - No manager PID found, killing processes individually.');
      for (const entry of entries) {
        if (!entry?.pid) continue;
        try {
          process.kill(entry.pid, 'SIGTERM');
          console.log(`    - ${entry.name} (pid: ${entry.pid}) stopped.`);
        } catch (e) {
          console.log(`    - ${entry.name} (pid: ${entry.pid}) already stopped or failed to stop: ${e.message}`);
        } finally {
          removeStackPidByPid(entry.pid);
        }
      }
    }

    // Clear PID records from DB
    run(`DELETE FROM stack_pids`, []);
    console.log('Stack stopped.');
  }
}

async function main() {
  const argv = new Set(process.argv.slice(2));

  if (argv.has('--stop') || argv.has('--shutdown')) {
    const force = argv.has('--force');
    await stopStack(force);
    return;
  }

  if (argv.has('--start')) {
    // If a previous stack is running, stop it first to avoid orphaned processes
    if (isStackRunning()) {
      console.log('Existing stack detected. Stopping before start...');
      await stopStack();
    }

    const args = process.argv.slice(1).filter(a => a !== '--start');
    const log = fs.openSync(LOG_FILE, 'a');
    const child = spawn(process.argv[0], args, {
      detached: true,
      stdio: ['ignore', log, log],
    });
    child.unref();

    console.log(`Stack starting in background. PID: ${child.pid}. Log file: ${LOG_FILE}`);
    process.exit(0);
  }

  setStackPid('manager', process.pid, {
    role: 'manager',
    tag: 'stack-manager',
    command: process.argv[1] || process.execPath,
    args: process.argv.slice(2),
    cwd: process.cwd(),
    user: process.env.USER || process.env.LOGNAME || null,
    meta: { hostname: os.hostname() },
  });

  try {
    // Optional preflight-only mode: --check
    const searxOnly = argv.has('--searxng-only');
    const checkOnly = argv.has('--check') || process.env.STACK_MODE === 'check';

    const startup = makeRollingRenderer('startup', 4);
    startup.push('checking searxng...', { level: 'info' });
    const searxRes = await ensureSearxng();
    if (searxRes.failed) startup.push('searxng unavailable', { level: 'warn' });
    else startup.push('searxng OK', { level: 'ok' });
    if (searxRes.failed) log({ event: 'searxng_unavailable', base: SEARXNG_BASE });
    if (searxOnly) return;
    // CI-friendly fast path: when running in check mode on CI, skip heavy llama checks
    if (checkOnly && (process.env.CI === 'true' || process.env.STACK_NO_LLAMA === '1')) {
      log({ event: 'check_complete', ok: true, skipped: 'llama_gateway' });
      return process.exit(0);
    }
    // Start LoRA server (Python) instead of llama.cpp/ollama
    const { child: loraProc, base: loraBase } = await startLoraServer();

    startup.push('lora server ready', { level: 'ok' });
    const { child: gwProc, base: gwBase } = await startGateway(loraBase);

    startup.push('gateway listening', { level: 'ok' });

    if (checkOnly) {
      const ok = await httpOk(`${gwBase}/health`);
      log({ event: 'check_complete', ok });
      // In check mode, shut down processes
      try { loraProc?.kill('SIGTERM'); } catch {}
      try { gwProc?.kill('SIGTERM'); } catch {}
      return process.exit(ok ? 0 : 1);
    }

    // Quick smoke checks
    // Optional LoRA quick check
    startup.push('lora models...', { level: 'info' });
    try {
      const ms = await fetch(`${loraBase}/models`).then(r => r.json());
      const mcount = Array.isArray(ms?.models) ? ms.models.length : 0;
      startup.push(`lora models ${mcount}`, { level: 'ok' });
    } catch { startup.push('lora models error', { level: 'warn' }); }

    // Proactively warmup base model (downloads from HF if needed)
    startup.push('warming up lora base model...', { level: 'info' });
    try {
      const body = {
        name: process.env.LORA_MODEL_NAME || 'qwen3-7b',
        model_path: process.env.LORA_MODEL_PATH || DEFAULT_UNSLOTH_BASE,
      };
      const wr = await fetch(`${gwBase}/warmup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      startup.push(`warmup base ${wr.status}`, { level: wr.ok ? 'ok' : 'warn' });
    } catch { startup.push('warmup base error', { level: 'warn' }); }

    // Optionally warmup 4-bit variant if requested
    if (String(process.env.LORA_LOAD_4BIT || '0') === '1') {
      startup.push('warming up lora 4bit model...', { level: 'info' });
      try {
        const wr2 = await fetch(`${gwBase}/warmup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'qwen3-7b-4bit', model_path: DEFAULT_UNSLOTH_4BIT }) });
        startup.push(`warmup 4bit ${wr2.status}`, { level: wr2.ok ? 'ok' : 'warn' });
      } catch { startup.push('warmup 4bit error', { level: 'warn' }); }
    }
    startup.push('gateway models...', { level: 'info' });
    try {
      const modelsJ = await fetch(`${gwBase}/models`).then(r => r.json());
      const mcount = Array.isArray(modelsJ?.models) ? modelsJ.models.length : 0;
      startup.push(`gateway models ${mcount}`, { level: 'ok' });
    } catch { startup.push('gateway models error', { level: 'warn' }); }

    startup.push('gateway chat...', { level: 'info' });
    try {
      const gwChat = await fetch(`${gwBase}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 8 }) });
      startup.push(`gateway chat ${gwChat.status}`, { level: gwChat.ok ? 'ok' : 'warn' });
    } catch { startup.push('gateway chat error', { level: 'warn' }); }

    startup.push('gateway health...', { level: 'info' });
    const healthR = await fetch(`${gwBase}/health`).then(r => r.json()).catch(() => ({}));
    log({ event: 'gateway_health', ok: healthR?.ok === true });
    if (healthR?.ok) startup.push('gateway OK', { level: 'ok' }); else startup.push('gateway not ready', { level: 'error', isError: true });

    log({ event: 'stack_ready', loraBase, gwBase, searxng: SEARXNG_BASE });
    // Kick a warmup with streaming feedback in the background (best-effort)
    streamWarmupWithFeedback(gwBase, { timeoutMs: 15000 }).catch(() => {});

    // Keep alive until SIGINT/SIGTERM
    const shutdown = () => {
      log({ event: 'shutdown' });
      // Leave llama-server running unless explicitly disabled via config
      try { loraProc?.kill('SIGTERM'); } catch {}
      try { gwProc.kill('SIGTERM'); } catch {}
      try { run(`DELETE FROM stack_pids`, []); } catch {}
    };
    process.once('SIGINT', () => { shutdown(); process.exit(130); });
    process.once('SIGTERM', () => { shutdown(); process.exit(143); });

    // Keep the manager process alive
    await new Promise(resolve => {});
  } catch (e) {
    log({ event: 'fatal', error: String(e && e.message || e) });
    try { run(`DELETE FROM stack_pids`, []); } catch {} // cleanup pid records on startup error
    process.exit(1);
  }
}

main();
