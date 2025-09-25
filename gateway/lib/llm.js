// gateway/lib/llm.js
import { spawn } from 'child_process';
import { getPrompt } from '../prompts/index.js';
import fs from 'fs';
import path from 'path';
import { modelRoots, manifestRoots, blobPathForDigest } from '../config/paths.js';

const CLI = process.env.LLAMACPP_CLI || 'llama-cli';
const DEFAULT_MAX_TOKENS = Number(process.env.DEFAULT_MAX_TOKENS || 1024);

const trimSlash = (s) => String(s || '').replace(/\/$/, '');
const toStr = (x) => String(x ?? '');
const okJson = (t) => { try { return JSON.parse(t); } catch { return t; } };

function getServer() { return process.env.LLAMACPP_SERVER || ''; }

/* ---------- Local model discovery (mirrors resolver) ---------- */
// Model roots discovered dynamically (HOME + known system paths + env MODEL_SEARCH_ROOTS)

const uniq = (a) => Array.from(new Set(a));
const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir  = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

function discoverRoots() { return modelRoots(); }

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



function* walk(dir, depth = 2) {
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

// 1) Manifests-first: collect model names from manifests directory
function listFromManifests() {
  const names = [];
  for (const root of modelRoots()) {
    const manifests = path.join(root, 'manifests');
    if (!isDir(manifests)) continue;

    for (const p of walk(manifests, /*depth*/1)) {
      if (!p.toLowerCase().endsWith('.json') || !isFile(p)) continue;

      // Try to infer name from filename first: <namespace>__<model>__<tag>.json or model__tag.json, etc.
      const base = path.basename(p, '.json');
      let inferred = base;

      // Then try JSON content (if any has name-ish fields)
      try {
        const txt = fs.readFileSync(p, 'utf8');
        const j = JSON.parse(txt);
        const cand = j?.model || j?.name || j?.fully_qualified_name || j?.tag || '';
        if (cand) inferred = String(cand);
      } catch { /* ignore bad json */ }

      if (inferred) names.push(inferred);
    }
  }
  return uniq(names);
}

// 2) Fallback: scan blobs/gguf like you already do
function listAllLocalGGUF() {
  const out = [];
  for (const r of modelRoots()) {
    const blobs = path.join(r, 'blobs');
    if (isDir(blobs)) {
      for (const p of walk(blobs, 2)) out.push(p);
    }
    for (const p of walk(r, 3)) if (p.toLowerCase().endsWith('.gguf')) out.push(p);
  }
  // de-dupe and newest first
  const uniqPaths = uniq(out.map(p => path.resolve(p)));
  uniqPaths.sort((a, b) => {
    const ma = fs.statSync(a).mtimeMs, mb = fs.statSync(b).mtimeMs;
    return mb - ma;
  });
  // map to "names" = basename without extension
  return uniqPaths.map(p => path.basename(p).replace(/\.gguf$/i, ''));
}

// Exported/used by /models route
export async function getModels() {
  const names = listFromManifests();
  if (names.length) return names;

  // fallback: gguf-derived names
  return listAllLocalGGUF();
}
/* ------------------------------------------------------------- */

// ---------- Ollama-style model listing (detailed) ----------

function extractSha256(text) {
  if (!text) return '';
  const m = String(text).match(/sha256[-: ]?([0-9a-f]{64})/i);
  return m ? m[1].toLowerCase() : '';
}

function familyFromName(name) {
  const n = (name || '').toLowerCase();
  if (/mixtral/.test(n)) return 'mistral';
  if (/mistral/.test(n)) return 'mistral';
  if (/llava/.test(n)) return 'llava';
  if (/vicuna/.test(n)) return 'llama';
  if (/llama/.test(n)) return 'llama';
  if (/qwen/.test(n)) return 'qwen';
  if (/phi/.test(n)) return 'phi';
  if (/gemma/.test(n)) return 'gemma';
  if (/yi\b/.test(n)) return 'yi';
  if (/falcon/.test(n)) return 'falcon';
  return null;
}

function parameterSizeFrom(nameOrPath) {
  const s = String(nameOrPath || '');
  const m = s.match(/(^|[^a-z0-9])([0-9]{1,3})\s*[bB]([^a-z0-9]|$)/);
  return m ? `${m[2].toUpperCase()}B` : null;
}

function quantFromPath(p) {
  const base = path.basename(String(p || ''));
  // common quant patterns: Q4_0, Q5_K, Q6_K, IQ4_NL, Q8_0, etc.
  const m = base.match(/-(IQ?[0-9]+(?:_[A-Z0-9]+)?)\.gguf$/i) || base.match(/-(Q[0-9]+(?:_[A-Z0-9]+)?)\.gguf$/i);
  return m ? m[1].toUpperCase() : null;
}

function guessNameFromManifestPath(p) {
  // fallback if JSON does not provide a name
  const base = path.basename(p).replace(/\.json$/i, '');
  return base;
}

function tryJSON(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function collectManifestFiles() {
  const out = [];
  for (const root of manifestRoots()) {
    for (const p of walk(root, /*depth*/6)) if (p.toLowerCase().endsWith('.json')) out.push(p);
  }
  return out;
}

function buildEntry({ name, digest, blobPath, fallbackStat }) {
  let size = 0; let mtime = new Date();
  if (blobPath && isFile(blobPath)) {
    const st = fs.statSync(blobPath);
    size = st.size; mtime = st.mtime;
  } else if (fallbackStat) {
    size = fallbackStat.size; mtime = fallbackStat.mtime;
  }
  const quant = quantFromPath(blobPath) || quantFromPath(name) || null;
  const param = parameterSizeFrom(name) || parameterSizeFrom(blobPath) || null;
  const details = {
    format: 'gguf',
    family: familyFromName(name),
    families: null,
    parameter_size: param,
    quantization_level: quant,
  };
  return {
    name,
    modified_at: mtime.toISOString(),
    size,
    digest: digest || '',
    details,
  };
}

function listFromManifestsDetailed() {
  const models = new Map(); // name -> entry
  const files = collectManifestFiles();
  for (const p of files) {
    let text = '';
    try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
    const j = tryJSON(text) || {};
    const fallbackStat = (() => { try { return fs.statSync(p); } catch { return null; } })();
    let name = j.fully_qualified_name || j.name || j.model || j.tag || guessNameFromManifestPath(p);
    name = String(name || guessNameFromManifestPath(p));
    const d1 = j.digest || '';
    const d = extractSha256(text) || extractSha256(d1);
    const blob = d ? blobPathForDigest(d) : '';
    const entry = buildEntry({ name, digest: d, blobPath: blob, fallbackStat });
    // Prefer entries with real blob size over ones without
    const prev = models.get(name);
    if (!prev || (entry.size && !prev.size)) models.set(name, entry);
  }
  return Array.from(models.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function listAllLocalGGUFPaths() {
  const out = [];
  for (const r of modelRoots()) {
    const blobs = path.join(r, 'blobs');
    if (isDir(blobs)) {
      for (const p of walk(blobs, 2)) if (p.toLowerCase().endsWith('.gguf')) out.push(p);
    }
    for (const p of walk(r, 3)) if (p.toLowerCase().endsWith('.gguf')) out.push(p);
  }
  const uniqPaths = uniq(out.map(p => path.resolve(p)));
  uniqPaths.sort((a, b) => {
    const ma = fs.statSync(a).mtimeMs, mb = fs.statSync(b).mtimeMs;
    return mb - ma;
  });
  return uniqPaths;
}

export async function listModelsOllama() {
  // 1) Prefer manifest-derived names + metadata
  const entries = listFromManifestsDetailed();
  if (entries.length) return entries;

  // 2) Fallback to GGUF scan when no manifests present
  const paths = listAllLocalGGUFPaths();
  const models = [];
  for (const p of paths) {
    const st = (() => { try { return fs.statSync(p); } catch { return null; } })();
    const base = path.basename(p, '.gguf');
    // try digest from blobs path
    const dd = extractSha256(p);
    models.push(buildEntry({ name: base, digest: dd, blobPath: p, fallbackStat: st }));
  }
  return models;
}

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
