// gateway/lib/llm.js
import { spawn } from 'child_process';
import { getPrompt } from '../prompts/index.js';
import fs from 'fs';
import path from 'path';

const CLI = process.env.LLAMACPP_CLI || 'llama-cli';
const DEFAULT_MAX_TOKENS = Number(process.env.DEFAULT_MAX_TOKENS || 1024);

const trimSlash = (s) => String(s || '').replace(/\/$/, '');
const toStr = (x) => String(x ?? '');
const okJson = (t) => { try { return JSON.parse(t); } catch { return t; } };

function getServer() { return process.env.LLAMACPP_SERVER || ''; }

/* ---------- Local model discovery (mirrors resolver) ---------- */
const DEFAULT_ROOTS = [
  '/home/hmagent/.ollama/models',
  path.join(process.env.HOME || '', '.ollama/models'),
  '/root/.ollama/models',
  '/var/snap/ollama/common/models',
  '/var/lib/ollama/models',
  '/usr/local/var/ollama/models',
  '/opt/homebrew/var/ollama/models',
  '/usr/share/ollama/.ollama/models',
];

const uniq = (a) => Array.from(new Set(a));
const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir  = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

function discoverRoots() {
  const env = (process.env.MODEL_SEARCH_ROOTS || '')
    .split(':').map(s => s.trim()).filter(Boolean);
  return uniq([...DEFAULT_ROOTS, ...env].filter(exists));
}

function readFirst4(p) {
  const fd = fs.openSync(p, 'r');
  try {
    const b = Buffer.alloc(4);
    fs.readSync(fd, b, 0, 4, 0);
    return b.toString('utf8');
  } finally { fs.closeSync(fd); }
}
function isGGUF(p) {
  if (!isFile(p)) return false;
  try { return readFirst4(p) === 'GGUF'; } catch { return false; }
}

function* walk(dir, depth = 4) {
  const q = [{ d: dir, k: 0 }];
  while (q.length) {
    const { d, k } = q.shift();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && k < depth) q.push({ d: p, k: k + 1 });
      else if (e.isFile()) yield p;
    }
  }
}

function listAllLocalGGUF() {
  const out = [];
  for (const r of discoverRoots()) {
    // scan blobs first (common Ollama storage)
    const blobs = path.join(r, 'blobs');
    if (isDir(blobs)) {
      for (const p of walk(blobs, 2)) if (p.toLowerCase().endsWith('.gguf') && isGGUF(p)) out.push(p);
      // Some installs store SHA-named files directly under blobs without .gguf extension — still GGUF.
      for (const p of walk(blobs, 1)) if (!p.toLowerCase().endsWith('.gguf') && isGGUF(p)) out.push(p);
    }
    // scan root tree for loose .gguf files
    for (const p of walk(r, 3)) if (p.toLowerCase().endsWith('.gguf') && isGGUF(p)) out.push(p);
  }
  // de-dupe and sort newest first
  const uniqPaths = uniq(out.map((p) => path.resolve(p)));
  uniqPaths.sort((a, b) => {
    const ma = fs.statSync(a).mtimeMs, mb = fs.statSync(b).mtimeMs;
    return mb - ma;
  });
  return uniqPaths;
}
/* ------------------------------------------------------------- */

async function getModelPath() {
  if (process.env.LLAMACPP_MODEL_PATH) return process.env.LLAMACPP_MODEL_PATH;
  try {
    const { resolveModelPath } = await import('../routes/modelResolver.js');
    if (resolveModelPath.length === 0) return (await resolveModelPath())?.path || '';
    return (await resolveModelPath({ interactive: false, fallback: false }))?.path || '';
  } catch {
    return '';
  }
}

async function httpPost(url, body, timeoutMs = 120000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
      signal: ctrl.signal
    });
    const txt = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status} ${txt.slice(0, 200)}`);
    return okJson(txt);
  } finally { clearTimeout(t); }
}

async function httpGet(url, timeoutMs = 120000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method: 'GET', signal: ctrl.signal });
    const txt = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status} ${txt.slice(0, 200)}`);
    return okJson(txt);
  } finally { clearTimeout(t); }
}

function normalizeMessages(messages = []) {
  return (messages || []).map(m => ({
    role: m.role || 'user',
    content: toStr(m.content)
  }));
}

export async function chat({ messages, model, temperature = 0.2, maxTokens = DEFAULT_MAX_TOKENS, timeoutMs = 120000, outputContract, json = false }) {
  const baseMsgs = normalizeMessages(messages);
  const msgs = outputContract ? [
    { role: 'system', content: getPrompt('llm.output_contract') },
    { role: 'system', content: toStr(outputContract) },
    ...baseMsgs,
  ] : baseMsgs;

  const server = getServer();
  if (server) {
    const url = `${trimSlash(server)}/v1/chat/completions`;
    const body = { model: model || 'default', messages: msgs, temperature, max_tokens: maxTokens, stream: false };
    if (json) body.response_format = { type: 'json_object' };
    const data = await httpPost(url, body, timeoutMs);
    const content = data?.choices?.[0]?.message?.content ?? '';
    return { content, raw: data };
  } else {
    const modelPath = await getModelPath();
    if (!modelPath) throw new Error('LLAMACPP_MODEL_PATH is required when no LLAMACPP_SERVER is set');
    const prompt = baseMsgs.map(m => `### ${m.role === 'system' ? 'System' : (m.role === 'assistant' ? 'Assistant' : 'User')}\n${m.content}\n`).join('\n') + `\n### Assistant\n`;
    const args = ['-m', modelPath, '--prompt', prompt, '--n-predict', String(maxTokens), '--temp', String(temperature)];
    const out = await runCli(CLI, args, timeoutMs);
    return { content: out, raw: { cli: true } };
  }
}

export async function complete({ prompt, model, temperature = 0.2, maxTokens = DEFAULT_MAX_TOKENS, timeoutMs = 120000 }) {
  const p = toStr(prompt);
  const server = getServer();
  if (server) {
    const url = `${trimSlash(server)}/v1/completions`;
    const body = { model: model || 'default', prompt: p, temperature, max_tokens: maxTokens, stream: false };
    const data = await httpPost(url, body, timeoutMs);
    const text = data?.choices?.[0]?.text ?? '';
    return { text, raw: data };
  } else {
    const modelPath = await getModelPath();
    if (!modelPath) throw new Error('LLAMACPP_MODEL_PATH is required when no LLAMACPP_SERVER is set');
    const args = ['-m', modelPath, '--prompt', p, '--n-predict', String(maxTokens), '--temp', String(temperature)];
    const out = await runCli(CLI, args, timeoutMs);
    return { text: out, raw: { cli: true } };
  }
}

export async function warmup({ model, timeoutMs = 60000 } = {}) {
  const server = getServer();
  if (server) {
    try {
      const models = await httpGet(`${trimSlash(server)}/v1/models`, timeoutMs);
      return { ok: true, via: 'server', models };
    } catch (e) {
      return { ok: false, error: toStr(e?.message || e) };
    }
  } else {
    const modelPath = await getModelPath();
    if (!modelPath) return { ok: false, error: 'MODEL_PATH missing' };
    try {
      const args = ['-m', modelPath, '--prompt', 'ping', '--n-predict', '1'];
      await runCli(CLI, args, timeoutMs);
      return { ok: true, via: 'cli' };
    } catch (e) {
      return { ok: false, error: toStr(e?.message || e) };
    }
  }
}

export async function listModels() {
  const server = getServer();
  if (server) {
    try {
      const d = await httpGet(`${trimSlash(server)}/v1/models`);
      const names = Array.isArray(d?.data) ? d.data.map(x => x.id || x.name || 'default') : [];
      if (names.length) return names;
    } catch { /* fall through to local */ }
  }

  // Try explicit env / resolver first
  try {
    const modelPath = await getModelPath();
    if (modelPath) return [modelPath];
  } catch { /* ignore and hard fallback */ }

  // Hard fallback: scan all known roots for GGUF (same method family as resolver)
  const paths = listAllLocalGGUF();
  if (paths.length) return paths;

  // Last resort: empty list (keeps /models endpoint JSON-valid)
  return [];
}

function runCli(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error('llama-cli timeout'));
    }, timeoutMs);
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(`llama-cli exit ${code}: ${err.slice(0, 200)}`));
    });
  });
}
