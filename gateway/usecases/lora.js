// gateway/usecases/lora.js
import { LORA_SERVER_BASE } from '../config.js';

const base = String(LORA_SERVER_BASE || 'http://127.0.0.1:8000').replace(/\/$/, '');

async function httpGetJson(url, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); } catch { j = null; }
    if (!r.ok) throw new Error((j && (j.detail || j.error)) || text || `HTTP ${r.status}`);
    if (j == null) throw new Error('invalid_json');
    return j;
  } finally {
    clearTimeout(t);
  }
}

async function httpPostJson(url, body, timeoutMs = 30000) {
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
    let j;
    try { j = JSON.parse(text); } catch { j = null; }
    if (!r.ok) throw new Error((j && (j.detail || j.error)) || text || `HTTP ${r.status}`);
    if (j == null) throw new Error('invalid_json');
    return j;
  } finally {
    clearTimeout(t);
  }
}

export async function listLoraModels(req, res) {
  try {
    const j = await httpGetJson(`${base}/models`, Number(process.env.GATEWAY_TIMEOUT_MS || 15000));
    const models = Array.isArray(j?.models) ? j.models : [];
    res.json({ ok: true, models });
  } catch (e) {
    res.status(503).json({ ok: false, error: String(e?.message || e) });
  }
}

export async function listLoraAdapters(req, res) {
  const name = String(req.params.name || '').trim();
  if (!name) return res.status(400).json({ ok: false, error: 'missing name' });
  try {
    const j = await httpGetJson(`${base}/models/${encodeURIComponent(name)}/loras`, Number(process.env.GATEWAY_TIMEOUT_MS || 15000));
    const loras = Array.isArray(j?.loras) ? j.loras : [];
    res.json({ ok: true, model: name, loras });
  } catch (e) {
    res.status(503).json({ ok: false, error: String(e?.message || e) });
  }
}

export async function loadLoraModel(req, res) {
  const body = req.body || {};
  const name = String(body.name || body.model || '').trim();
  const model_path = String(body.model_path || '').trim();
  const lora_paths = body.lora_paths && typeof body.lora_paths === 'object' ? body.lora_paths : undefined;
  if (!name || !model_path)
    return res.status(400).json({ ok: false, error: 'missing name or model_path' });
  try {
    const j = await httpPostJson(`${base}/load_model`, { name, model_path, lora_paths }, Number(process.env.GATEWAY_TIMEOUT_MS || 60000));
    res.json({ ok: true, loaded: j });
  } catch (e) {
    res.status(503).json({ ok: false, error: String(e?.message || e) });
  }
}

export default { listLoraModels, listLoraAdapters, loadLoraModel };
