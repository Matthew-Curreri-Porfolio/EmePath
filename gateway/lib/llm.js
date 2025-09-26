// gateway/lib/llm.js
import { spawn } from 'child_process';
import { getPrompt } from '../prompts/index.js';
import fs from 'fs';
import path from 'path';
import {
  modelRoots,
  manifestRoots,
  blobPathForDigest,
} from '../config/paths.js';

const CLI = process.env.LLAMACPP_CLI || 'llama-cli';
const DEFAULT_MAX_TOKENS = Number(process.env.DEFAULT_MAX_TOKENS || 1024);

const trimSlash = (s) => String(s || '').replace(/\/$/, '');
const toStr = (x) => String(x ?? '');
const okJson = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
};

function getServer() {
  return process.env.LLAMACPP_SERVER || '';
}

/* ---------- Local model discovery (mirrors resolver) ---------- */
// Model roots discovered dynamically (HOME + known system paths + env MODEL_SEARCH_ROOTS)

const uniq = (a) => Array.from(new Set(a));
const exists = (p) => {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
};
const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

function discoverRoots() {
  return modelRoots();
}

function readFirst4(p) {
  const fd = fs.openSync(p, 'r');
  try {
    const b = Buffer.alloc(4);
    fs.readSync(fd, b, 0, 4, 0);
    return b.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}
function isGGUF(p) {
  if (!isFile(p)) return false;
  try {
    return readFirst4(p) === 'GGUF';
  } catch {
    return false;
  }
}

function* walk(dir, depth = 2) {
  const q = [{ d: dir, k: 0 }];
  while (q.length) {
    const { d, k } = q.shift();
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
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

    for (const p of walk(manifests, /*depth*/ 1)) {
      if (!p.toLowerCase().endsWith('.json') || !isFile(p)) continue;

      // Try to infer name from filename first: <namespace>__<model>__<tag>.json or model__tag.json, etc.
      const base = path.basename(p, '.json');
      let inferred = base;

      // Then try JSON content (if any has name-ish fields)
      try {
        const txt = fs.readFileSync(p, 'utf8');
        const j = JSON.parse(txt);
        const cand =
          j?.model || j?.name || j?.fully_qualified_name || j?.tag || '';
        if (cand) inferred = String(cand);
      } catch {
        /* ignore bad json */
      }

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
    for (const p of walk(r, 3))
      if (p.toLowerCase().endsWith('.gguf')) out.push(p);
  }
  // de-dupe and newest first
  const uniqPaths = uniq(out.map((p) => path.resolve(p)));
  uniqPaths.sort((a, b) => {
    const ma = fs.statSync(a).mtimeMs,
      mb = fs.statSync(b).mtimeMs;
    return mb - ma;
  });
  // map to "names" = basename without extension
  return uniqPaths.map((p) => path.basename(p).replace(/\.gguf$/i, ''));
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
  const m =
    base.match(/-(IQ?[0-9]+(?:_[A-Z0-9]+)?)\.gguf$/i) ||
    base.match(/-(Q[0-9]+(?:_[A-Z0-9]+)?)\.gguf$/i);
  return m ? m[1].toUpperCase() : null;
}

function guessNameFromManifestPath(p) {
  // fallback if JSON does not provide a name
  const base = path.basename(p).replace(/\.json$/i, '');
  return base;
}

function tryJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function collectManifestFiles() {
  const out = [];
  for (const root of manifestRoots()) {
    for (const p of walk(root, /*depth*/ 8)) {
      // Ollama manifests are regular files without extension
      if (isFile(p)) out.push(p);
    }
  }
  return out;
}

function idFromManifestPath(p) {
  const parts = String(p).split(path.sep).filter(Boolean);
  // Try to anchor at registry marker for robustness
  let i = parts.lastIndexOf('registry.ollama.ai');
  if (i !== -1 && parts.length >= i + 4) {
    const owner = parts[i + 1];
    const name = parts[i + 2];
    const tag = parts[i + 3];
    const isLibrary = owner === 'library';
    return isLibrary ? `${name}:${tag}` : `${owner}/${name}:${tag}`;
  }
  // Fallback to last 3 segments heuristic
  if (parts.length >= 3) {
    const owner = parts[parts.length - 3];
    const name = parts[parts.length - 2];
    const tag = parts[parts.length - 1];
    const isLibrary = owner === 'library';
    return isLibrary ? `${name}:${tag}` : `${owner}/${name}:${tag}`;
  }
  return path.basename(p);
}

function digestFromManifestText(text) {
  const j = tryJSON(text);
  if (!j) return '';
  // Prefer the model layer digest
  const layers = Array.isArray(j.layers) ? j.layers : [];
  for (const layer of layers) {
    const mt = String(layer?.mediaType || '');
    if (/application\/vnd\.ollama\.image\.model/.test(mt) && layer?.digest) {
      return String(layer.digest)
        .replace(/^sha256-/, '')
        .replace(/^sha256:/, '');
    }
  }
  // Fallback to config digest (less accurate for model blob)
  const cfg = j.config?.digest || '';
  if (cfg)
    return String(cfg)
      .replace(/^sha256-/, '')
      .replace(/^sha256:/, '');
  return '';
}

function normalizeDigest(digest) {
  if (!digest) return '';
  return String(digest)
    .replace(/^sha256[-:]/i, '')
    .toLowerCase();
}

function quantFromTag(tag) {
  if (!tag) return null;
  const m = String(tag).match(
    /(IQ?[0-9]+(?:_[A-Z0-9]+)*|Q[0-9]+(?:_[A-Z0-9]+)*)/i
  );
  return m ? m[1].toUpperCase() : null;
}

function listAllLocalGGUFPaths() {
  const out = [];
  for (const r of modelRoots()) {
    const blobs = path.join(r, 'blobs');
    if (isDir(blobs)) {
      for (const p of walk(blobs, 2))
        if (p.toLowerCase().endsWith('.gguf')) out.push(p);
    }
    for (const p of walk(r, 3))
      if (p.toLowerCase().endsWith('.gguf')) out.push(p);
  }
  const uniqPaths = uniq(out.map((p) => path.resolve(p)));
  uniqPaths.sort((a, b) => {
    const ma = fs.statSync(a).mtimeMs,
      mb = fs.statSync(b).mtimeMs;
    return mb - ma;
  });
  return uniqPaths;
}

function digestFromString(val) {
  if (!val) return '';
  const m = String(val).match(/sha256[-:]([0-9a-f]{64})/i);
  return m ? m[1].toLowerCase() : '';
}

const MANIFEST_REGISTRY = 'registry.ollama.ai';

function parseManifestMeta(filePath, root) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    return null;
  }

  const rel = path.relative(root, filePath);
  const parts = rel.split(path.sep).filter(Boolean);
  if (!parts.length) return null;
  let idx = parts.indexOf(MANIFEST_REGISTRY);
  if (idx === -1) idx = 0;
  const owner = parts[idx + 1];
  const name = parts[idx + 2];
  const tagParts = parts.slice(idx + 3);
  if (!owner || !name || !tagParts.length) return null;
  const tag = tagParts.join('/');
  const id = owner === 'library' ? `${name}:${tag}` : `${owner}/${name}:${tag}`;

  const created = Number.isFinite(stat.mtimeMs)
    ? Math.floor(stat.mtimeMs / 1000)
    : Math.floor(stat.mtime.getTime() / 1000);

  const layers = Array.isArray(manifest.layers) ? manifest.layers : [];
  const modelLayer = layers.find((layer) =>
    /application\/vnd\.ollama\.image\.model/.test(
      String(layer?.mediaType || '')
    )
  );
  if (!modelLayer || !modelLayer.digest) return null;
  const templateLayer = layers.find((layer) =>
    /application\/vnd\.ollama\.image\.template/.test(
      String(layer?.mediaType || '')
    )
  );
  const licenseLayer = layers.find((layer) =>
    /application\/vnd\.ollama\.image\.license/.test(
      String(layer?.mediaType || '')
    )
  );
  const paramsLayer = layers.find((layer) =>
    /application\/vnd\.ollama\.image\.params/.test(
      String(layer?.mediaType || '')
    )
  );

  const digest = normalizeDigest(modelLayer.digest);
  let size = Number(modelLayer.size) || 0;
  let blobPath = '';
  if (digest) {
    blobPath = blobPathForDigest(digest) || '';
    if ((!size || !Number.isFinite(size)) && blobPath && isFile(blobPath)) {
      try {
        size = fs.statSync(blobPath).size;
      } catch {
        size = 0;
      }
    }
  }

  const config = typeof manifest.config === 'object' ? manifest.config : {};
  const quantization =
    quantFromTag(tag) || quantFromPath(blobPath || '') || null;
  const parameterSize =
    parameterSizeFrom(tag) || parameterSizeFrom(name) || null;
  const family =
    config.model_family || familyFromName(name) || familyFromName(id) || null;
  const families = Array.isArray(config.model_families)
    ? config.model_families
    : config.model_families
      ? [config.model_families]
      : null;
  const format = config.model_format || 'gguf';
  const parentModel = config.parent_model || null;
  const modelType = config.model_type || null;

  return {
    id,
    owner: owner === 'library' ? 'library' : owner,
    created,
    digest,
    size: Number.isFinite(size) ? size : 0,
    blobPath,
    quantization,
    parameterSize,
    family,
    families,
    format,
    parentModel,
    modelType,
    templateDigest: normalizeDigest(templateLayer?.digest),
    licenseDigest: normalizeDigest(licenseLayer?.digest),
    paramsDigest: normalizeDigest(paramsLayer?.digest),
  };
}

function scanManifestModels() {
  const entries = new Map();
  for (const root of manifestRoots()) {
    if (!isDir(root)) continue;
    for (const filePath of walk(root, 6)) {
      if (!isFile(filePath)) continue;
      const meta = parseManifestMeta(filePath, root);
      if (!meta) continue;
      const prev = entries.get(meta.id);
      if (!prev || (meta.created || 0) > (prev.created || 0)) {
        entries.set(meta.id, meta);
      }
    }
  }
  return Array.from(entries.values());
}

export async function listModelsOllama() {
  const manifests = scanManifestModels();
  if (manifests.length) {
    const sorted = manifests
      .slice()
      .sort(
        (a, b) =>
          (b.created || 0) - (a.created || 0) || a.id.localeCompare(b.id)
      );
    return sorted.map((meta) => ({
      name: meta.id,
      model: meta.id,
      modified_at: meta.created
        ? new Date(meta.created * 1000).toISOString()
        : '',
      size: meta.size || 0,
      digest: meta.digest ? `sha256:${meta.digest}` : '',
      details: {
        format: meta.format || 'gguf',
        family: meta.family,
        families: meta.families,
        parent_model: meta.parentModel || null,
        parameter_size: meta.parameterSize,
        quantization_level: meta.quantization,
      },
    }));
  }

  const server = getServer();
  if (server) {
    try {
      const upstream = await httpGet(`${trimSlash(server)}/v1/models`);
      if (Array.isArray(upstream?.models)) return upstream.models;
    } catch {
      /* ignore */
    }
  }

  const paths = listAllLocalGGUFPaths();
  return paths.map((p) => {
    const st = (() => {
      try {
        return fs.statSync(p);
      } catch {
        return null;
      }
    })();
    const base = path.basename(p, '.gguf');
    const modified = st
      ? new Date(st.mtimeMs || st.mtime.getTime()).toISOString()
      : '';
    const size = st ? st.size : 0;
    return {
      name: base,
      model: base,
      modified_at: modified,
      size,
      digest: '',
      details: {
        format: 'gguf',
        family: familyFromName(base),
        families: null,
        parent_model: null,
        parameter_size: parameterSizeFrom(base),
        quantization_level: quantFromPath(p),
      },
    };
  });
}

// OpenAI-style list response for /models route
export async function listModelsOpenAI() {
  const manifests = scanManifestModels();
  if (manifests.length) {
    const sorted = manifests
      .slice()
      .sort(
        (a, b) =>
          (b.created || 0) - (a.created || 0) || a.id.localeCompare(b.id)
      );
    const data = sorted.map((meta) => {
      const entry = {
        id: meta.id,
        object: 'model',
        created: meta.created || 0,
        owned_by: meta.owner || 'library',
      };
      const metaExtra = {};
      if (meta.digest) metaExtra.digest = `sha256:${meta.digest}`;
      if (meta.size) metaExtra.size = meta.size;
      if (meta.blobPath) metaExtra.blob_path = meta.blobPath;
      if (meta.parameterSize) metaExtra.parameter_size = meta.parameterSize;
      if (meta.quantization) metaExtra.quantization_level = meta.quantization;
      if (meta.family) metaExtra.family = meta.family;
      if (meta.families) metaExtra.families = meta.families;
      if (meta.format) metaExtra.format = meta.format;
      if (meta.modelType) metaExtra.model_type = meta.modelType;
      if (meta.parentModel) metaExtra.parent_model = meta.parentModel;
      if (meta.templateDigest)
        metaExtra.template_digest = `sha256:${meta.templateDigest}`;
      if (meta.licenseDigest)
        metaExtra.license_digest = `sha256:${meta.licenseDigest}`;
      if (meta.paramsDigest)
        metaExtra.params_digest = `sha256:${meta.paramsDigest}`;
      if (Object.keys(metaExtra).length) entry.meta = metaExtra;
      return entry;
    });
    return { object: 'list', data };
  }

  const server = getServer();
  if (server) {
    try {
      const upstream = await httpGet(`${trimSlash(server)}/v1/models`);
      if (upstream) return upstream;
    } catch {
      /* ignore */
    }
  }

  const ggufs = listAllLocalGGUFPaths();
  if (ggufs.length) {
    const data = ggufs.map((p) => {
      const id = path.basename(p).replace(/\.gguf$/i, '');
      const owned_by = id.includes('/') ? id.split('/', 1)[0] : 'library';
      let created = 0;
      let size = 0;
      try {
        const st = fs.statSync(p);
        created = Math.floor((st.mtimeMs || st.mtime.getTime()) / 1000);
        size = st.size;
      } catch {}
      const entry = { id, object: 'model', created, owned_by };
      const metaExtra = {};
      if (size) metaExtra.size = size;
      const quant = quantFromPath(p) || quantFromTag(id);
      if (quant) metaExtra.quantization_level = quant;
      const param = parameterSizeFrom(id);
      if (param) metaExtra.parameter_size = param;
      if (Object.keys(metaExtra).length) entry.meta = metaExtra;
      return entry;
    });
    return { object: 'list', data };
  }

  return { object: 'list', data: [] };
}

async function getModelPath() {
  if (process.env.LLAMACPP_MODEL_PATH) return process.env.LLAMACPP_MODEL_PATH;
  try {
    const { resolveModelPath } = await import('../routes/modelResolver.js');
    if (resolveModelPath.length === 0)
      return (await resolveModelPath())?.path || '';
    return (
      (await resolveModelPath({ interactive: false, fallback: false }))?.path ||
      ''
    );
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
      signal: ctrl.signal,
    });
    const txt = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status} ${txt.slice(0, 200)}`);
    return okJson(txt);
  } finally {
    clearTimeout(t);
  }
}

async function httpGet(url, timeoutMs = 120000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method: 'GET', signal: ctrl.signal });
    const txt = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status} ${txt.slice(0, 200)}`);
    return okJson(txt);
  } finally {
    clearTimeout(t);
  }
}

function normalizeMessages(messages = []) {
  return (messages || []).map((m) => ({
    role: m.role || 'user',
    content: toStr(m.content),
  }));
}

export async function chat({
  messages,
  model,
  temperature = 0.2,
  maxTokens = DEFAULT_MAX_TOKENS,
  timeoutMs = 120000,
  outputContract,
  json = false,
}) {
  const baseMsgs = normalizeMessages(messages);
  const msgs = outputContract
    ? [
        { role: 'system', content: getPrompt('llm.output_contract') },
        { role: 'system', content: toStr(outputContract) },
        ...baseMsgs,
      ]
    : baseMsgs;

  const server = getServer();
  if (server) {
    const url = `${trimSlash(server)}/v1/chat/completions`;
    const body = {
      model: model || 'default',
      messages: msgs,
      temperature,
      max_tokens: maxTokens,
      stream: false,
    };
    if (json) body.response_format = { type: 'json_object' };
    const data = await httpPost(url, body, timeoutMs);
    const content = data?.choices?.[0]?.message?.content ?? '';
    return { content, raw: data };
  } else {
    const modelPath = await getModelPath();
    if (!modelPath)
      throw new Error(
        'LLAMACPP_MODEL_PATH is required when no LLAMACPP_SERVER is set'
      );
    const prompt =
      baseMsgs
        .map(
          (m) =>
            `### ${m.role === 'system' ? 'System' : m.role === 'assistant' ? 'Assistant' : 'User'}\n${m.content}\n`
        )
        .join('\n') + `\n### Assistant\n`;
    const args = [
      '-m',
      modelPath,
      '--prompt',
      prompt,
      '--n-predict',
      String(maxTokens),
      '--temp',
      String(temperature),
    ];
    const out = await runCli(CLI, args, timeoutMs);
    return { content: out, raw: { cli: true } };
  }
}

export async function complete({
  prompt,
  model,
  temperature = 0.2,
  maxTokens = DEFAULT_MAX_TOKENS,
  timeoutMs = 120000,
}) {
  const p = toStr(prompt);
  const server = getServer();
  if (server) {
    const url = `${trimSlash(server)}/v1/completions`;
    const body = {
      model: model || 'default',
      prompt: p,
      temperature,
      max_tokens: maxTokens,
      stream: false,
    };
    const data = await httpPost(url, body, timeoutMs);
    const text = data?.choices?.[0]?.text ?? '';
    return { text, raw: data };
  } else {
    const modelPath = await getModelPath();
    if (!modelPath)
      throw new Error(
        'LLAMACPP_MODEL_PATH is required when no LLAMACPP_SERVER is set'
      );
    const args = [
      '-m',
      modelPath,
      '--prompt',
      p,
      '--n-predict',
      String(maxTokens),
      '--temp',
      String(temperature),
    ];
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
      const names = Array.isArray(d?.data)
        ? d.data.map((x) => x.id || x.name || 'default')
        : [];
      if (names.length) return names;
    } catch {
      /* fall through to local */
    }
  }

  // Try explicit env / resolver first
  try {
    const modelPath = await getModelPath();
    if (modelPath) return [modelPath];
  } catch {
    /* ignore and hard fallback */
  }

  // Hard fallback: scan all known roots for GGUF (same method family as resolver)
  const paths = listAllLocalGGUF();
  if (paths.length) return paths;

  // Last resort: empty list (keeps /models endpoint JSON-valid)
  return [];
}

function runCli(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      reject(new Error('llama-cli timeout'));
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    child.stderr.on('data', (d) => {
      err += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(`llama-cli exit ${code}: ${err.slice(0, 200)}`));
    });
  });
}
