// gateway/lib/lora_client.js
// Minimal client for the Python LoRA server, used for /chat and /complete.

const toStr = (x) => String(x ?? '');

function getBase() {
  return process.env.LORA_SERVER_BASE || 'http://127.0.0.1:8000';
}

async function httpJson(url, body, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: ctrl.signal,
    });
    const text = await r.text();
    try {
      const j = JSON.parse(text);
      if (!r.ok) throw new Error(j?.detail || text || `HTTP ${r.status}`);
      return j;
    } catch (e) {
      if (!r.ok) throw new Error(toStr(e?.message || e));
      throw new Error(`Invalid JSON from ${url}`);
    }
  } finally {
    clearTimeout(t);
  }
}

async function httpGetJson(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method: 'GET', signal: ctrl.signal });
    const text = await r.text();
    try {
      const j = JSON.parse(text);
      if (!r.ok) throw new Error(j?.detail || text || `HTTP ${r.status}`);
      return j;
    } catch (e) {
      if (!r.ok) throw new Error(toStr(e?.message || e));
      throw new Error(`Invalid JSON from ${url}`);
    }
  } finally {
    clearTimeout(t);
  }
}

function getDesignatedConfig() {
  // Primary source: env vars. Optionally override per request later.
  const cfg = {
    name: process.env.LORA_MODEL_NAME || 'default',
    model_path: process.env.LORA_MODEL_PATH || '',
    lora_paths: undefined,
    default_lora: process.env.LORA_DEFAULT_ADAPTER || '',
  };
  const lp = process.env.LORA_LORA_PATHS_JSON || process.env.LORA_ADAPTERS_JSON;
  if (lp) {
    try {
      cfg.lora_paths = JSON.parse(lp);
    } catch {}
  }
  // Simple KEY=PATH list support
  const llist = process.env.LORA_ADAPTERS || '';
  if (!cfg.lora_paths && llist) {
    const map = {};
    for (const part of llist.split(',').map((s) => s.trim()).filter(Boolean)) {
      const [k, v] = part.split('=');
      if (k && v) map[k.trim()] = v.trim();
    }
    if (Object.keys(map).length) cfg.lora_paths = map;
  }
  return cfg;
}

const loaded = new Set();

export async function ensureLoaded({ name, model_path, lora_paths }, timeoutMs) {
  if (loaded.has(name)) return;
  // Check remote state
  try {
    const j = await httpGetJson(`${getBase()}/models`, timeoutMs);
    const list = Array.isArray(j?.models) ? j.models : [];
    if (list.includes(name)) {
      loaded.add(name);
      return;
    }
  } catch {}
  // Load
  if (!model_path) throw new Error('LORA_MODEL_PATH is required to load model');
  const body = { name, model_path };
  if (lora_paths) body.lora_paths = lora_paths;
  await httpJson(`${getBase()}/load_model`, body, timeoutMs);
  loaded.add(name);
}

function messagesToPrompt(messages) {
  const baseMsgs = (messages || []).map((m) => ({
    role: m.role || 'user',
    content: toStr(m.content || ''),
  }));
  return (
    baseMsgs
      .map((m) => `### ${m.role === 'system' ? 'System' : m.role === 'assistant' ? 'Assistant' : 'User'}\n${m.content}\n`)
      .join('\n') + `\n### Assistant\n`
  );
}

export async function chat({ messages, temperature = 0.2, maxTokens = 1024, timeoutMs = 120000, model, loraName, loraModel }) {
  const cfg = getDesignatedConfig();
  const name = loraModel?.name || cfg.name;
  await ensureLoaded({
    name,
    model_path: loraModel?.model_path || cfg.model_path,
    lora_paths: loraModel?.lora_paths || cfg.lora_paths,
  }, timeoutMs);
  const lora = loraName || process.env.LORA_ADAPTER || cfg.default_lora || Object.keys(cfg.lora_paths || {})[0] || '';
  const prompt = messagesToPrompt(messages);
  const out = await httpJson(
    `${getBase()}/inference`,
    {
      model_name: name,
      lora_name: lora,
      prompt,
      // Send structured messages so HF backends can apply chat templates
      messages: (messages || []).map(m => ({ role: m.role || 'user', content: toStr(m.content || '') })),
      max_new_tokens: maxTokens,
      temperature,
    },
    timeoutMs
  );
  const content = toStr(out?.result || '');
  return { content, raw: out };
}

export async function complete({ prompt, temperature = 0.2, maxTokens = 1024, timeoutMs = 120000, model, loraName, loraModel }) {
  const cfg = getDesignatedConfig();
  const name = loraModel?.name || cfg.name;
  await ensureLoaded({
    name,
    model_path: loraModel?.model_path || cfg.model_path,
    lora_paths: loraModel?.lora_paths || cfg.lora_paths,
  }, timeoutMs);
  const lora = loraName || process.env.LORA_ADAPTER || cfg.default_lora || Object.keys(cfg.lora_paths || {})[0] || '';
  const out = await httpJson(
    `${getBase()}/inference`,
    {
      model_name: name,
      lora_name: lora,
      prompt: toStr(prompt),
      max_new_tokens: maxTokens,
      temperature,
    },
    timeoutMs
  );
  const text = toStr(out?.result || '');
  return { text, raw: out };
}

export default { chat, complete };
