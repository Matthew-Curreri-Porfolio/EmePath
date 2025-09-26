// gateway/usecases/chatWithTools.js
// TODO: Add an end-to-end test hitting /chat/tools that verifies
//       prefix + tool output + suffix composition once tool routes stabilize.
import fs from 'fs';
import path from 'path';
import { chat as llmChat } from '../lib/lora_client.js';
import { extractGatewayUsage } from '../middleware/parse_llm_response.js';

function loadUsageConfig() {
  const p = path.join(process.cwd(), 'gateway', 'prompts', 'gateway_usage.json');
  const txt = fs.readFileSync(p, 'utf8');
  return JSON.parse(txt);
}

function resolveEndpoint(key, cfg) {
  const e = cfg?.endpoints?.[key];
  if (!e) return null;
  // Shallow clone to avoid mutation
  return { ...e };
}

function fillPathParams(p, inputs = {}) {
  return String(p || '').replace(/:([a-zA-Z0-9_]+)/g, (_, k) => {
    return inputs[k] != null ? encodeURIComponent(String(inputs[k])) : _;
  });
}

function buildUrl(base, ep, inputs = {}) {
  const u = new URL(String(base).replace(/\/$/, '') + fillPathParams(ep.path, inputs));
  const q = ep.query || {};
  for (const [k, v] of Object.entries(q)) {
    const val = inputs[k] != null ? inputs[k] : v;
    if (val != null) u.searchParams.append(k, String(val));
  }
  return u.toString();
}

async function callEndpoint(base, key, inputs, cfg) {
  const ep = resolveEndpoint(key, cfg);
  if (!ep) return { ok: false, error: `unknown_endpoint:${key}` };
  const url = buildUrl(base, ep, inputs);
  const method = (ep.method || 'GET').toUpperCase();
  const headers = {};
  if (ep.auth === 'bearer') {
    const token = cfg?.defaults?.token || process.env.GATEWAY_API_KEY || '';
    if (!token) return { ok: false, error: 'missing_token' };
    headers['authorization'] = `Bearer ${token}`;
  }
  if (method !== 'GET') headers['content-type'] = 'application/json';
  const bodyTemplate = ep.body || null;
  const bodyObj = bodyTemplate ? { ...bodyTemplate, ...inputs } : inputs?.body || null;
  const resp = await fetch(url, {
    method,
    headers,
    body: method === 'GET' ? undefined : JSON.stringify(bodyObj || {}),
  });
  const text = await resp.text();
  return { ok: resp.ok, status: resp.status, text, ctype: resp.headers.get('content-type') || '' };
}

export async function chatWithToolsUseCase(req, res, deps) {
  const { getTimeoutMs } = deps;
  const body = req.body || {};
  const messages = body.messages || [];
  const temperature = typeof body.temperature === 'number' ? body.temperature : 0.2;
  const maxTokens = typeof body.maxTokens === 'number' ? body.maxTokens : undefined;
  try {
    const r = await llmChat({
      messages,
      model: body.model,
      temperature,
      maxTokens,
      timeoutMs: getTimeoutMs(),
    });

    // Extract usage block and cleaned assistant text
    const { usage, cleaned, prefix, suffix } = extractGatewayUsage(r.content || '');
    if (!usage) {
      return res.json({ ok: true, message: { role: 'assistant', content: r.content }, raw: r.raw, tool: null });
    }

    // Determine endpoint key
    const key = Array.isArray(usage.endpoints)
      ? usage.endpoints[0]
      : usage.key || usage.endpoint || usage.tool || null;
    if (!key)
      return res.json({ ok: true, message: { role: 'assistant', content: cleaned }, raw: r.raw, tool: null });

    const cfg = loadUsageConfig();
    const base = (cfg?.defaults?.base || `http://127.0.0.1:${process.env.GATEWAY_PORT || 3123}`);
    const inputs = usage.inputs || usage.params || {};
    let toolRes;
    try {
      toolRes = await callEndpoint(base, key, inputs, cfg);
    } catch (e) {
      toolRes = { ok: false, error: String(e && e.message || e) };
    }

    const toolText = toolRes?.text ?? JSON.stringify(toolRes);
    const combined = [prefix, toolText, suffix].filter(Boolean).join('\n\n');
    return res.json({ ok: true, message: { role: 'assistant', content: combined }, raw: r.raw, tool: { key, ...toolRes } });
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e.message || e) });
  }
}

export default { chatWithToolsUseCase };
