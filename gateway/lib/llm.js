// gateway/lib/llm.js
// LLM adapter for llama.cpp. Prefers llama-server (OpenAI-ish), falls back to llama-cli.
//
// ENV:
//   LLAMACPP_SERVER=http://127.0.0.1:8080   # llama-server base URL (preferred)
//   LLAMACPP_MODEL_PATH=/abs/path/model.gguf # required if no server; for llama-cli
//   LLAMACPP_CLI=/abs/path/llama-cli         # optional; default "llama-cli" on PATH
//   DEFAULT_MAX_TOKENS=1024                   # optional

import { spawn } from 'child_process';

const SERVER = process.env.LLAMACPP_SERVER || '';
const MODEL_PATH = process.env.LLAMACPP_MODEL_PATH || '';
function getSERVER() { return process.env.LLAMACPP_SERVER || ''; }
function getMODEL_PATH() { return process.env.LLAMACPP_MODEL_PATH || ''; }
const CLI = process.env.LLAMACPP_CLI || 'llama-cli';
const DEFAULT_MAX_TOKENS = Number(process.env.DEFAULT_MAX_TOKENS || 1024);

function j(obj){ return JSON.stringify(obj); }

async function httpPost(url, body, timeoutMs=120000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method:'POST',
      headers:{'content-type':'application/json'},
      body: typeof body === 'string' ? body : JSON.stringify(body),
      signal: ctrl.signal
    });
    const txt = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status} ${txt.slice(0,200)}`);
    try { return JSON.parse(txt); } catch { return txt; }
  } finally { clearTimeout(t); }
}

function normalizeMessages(messages=[]) {
  // minimal hygiene: ensure strings and roles exist
  return (messages || []).map(m => ({
    role: m.role || 'user',
    content: String(m.content ?? '')
  }));
}

export async function chat({ messages, model, temperature=0.2, maxTokens=DEFAULT_MAX_TOKENS, timeoutMs=120000, outputContract, json=false }) {
  const baseMsgs = normalizeMessages(messages);
  const msgs = outputContract ? [
    { role: 'system', content: 'Output Contract: Respond ONLY with content that strictly matches the contract. Do not include explanations, prefaces, or trailing commentary. If you cannot comply, output a JSON error {"error":"contract_violation"}.' },
    { role: 'system', content: String(outputContract) },
    ...baseMsgs,
  ] : baseMsgs;
  const SERVER = getSERVER();
  if (SERVER) {
    // llama-server OpenAI-ish endpoint
    const url = `${SERVER.replace(/\/$/,'')}/v1/chat/completions`;
    const body = {
      model: model || 'default',
      messages: msgs,
      temperature,
      max_tokens: maxTokens,
      stream: false
    };
    if (json) body.response_format = { type: 'json_object' };
    const data = await httpPost(url, body, timeoutMs);
    const content = data?.choices?.[0]?.message?.content ?? '';
    return { content, raw: data };
  } else {
    // CLI fallback – stitch messages into a prompt
    const MODEL_PATH = getMODEL_PATH();
    if (!MODEL_PATH) throw new Error('LLAMACPP_MODEL_PATH is required when no LLAMACPP_SERVER is set');
    const prompt =
      msgs.map(m => {
        const h = m.role === 'system' ? 'System' : (m.role === 'assistant' ? 'Assistant' : 'User');
        return `### ${h}\n${m.content}\n`;
      }).join('\n') + `\n### Assistant\n`;
    const args = ['-m', MODEL_PATH, '--prompt', prompt, '--n-predict', String(maxTokens)];
    const out = await runCli(CLI, args, timeoutMs);
    return { content: out, raw: { cli: true } };
  }
}

export async function complete({ prompt, model, temperature=0.2, maxTokens=DEFAULT_MAX_TOKENS, timeoutMs=120000 }) {
  // simple text completion; if you want FIM, extend here with --in-prefix/--in-suffix flags (supported by llama.cpp)
  const p = String(prompt || '');
  const SERVER = getSERVER();
  if (SERVER) {
    const url = `${SERVER.replace(/\/$/,'')}/v1/completions`;
    const body = { model: model || 'default', prompt: p, temperature, max_tokens: maxTokens, stream:false };
    const data = await httpPost(url, body, timeoutMs);
    const text = data?.choices?.[0]?.text ?? '';
    return { text, raw: data };
  } else {
    const MODEL_PATH = getMODEL_PATH();
    if (!MODEL_PATH) throw new Error('LLAMACPP_MODEL_PATH is required when no LLAMACPP_SERVER is set');
    const args = ['-m', MODEL_PATH, '--prompt', p, '--n-predict', String(maxTokens)];
    const out = await runCli(CLI, args, timeoutMs);
    return { text: out, raw: { cli: true } };
  }
}

export async function warmup({ model, timeoutMs=60000 }) {
  // Cheap ping to ensure model is hot
  const SERVER = getSERVER();
  if (SERVER) {
    try {
      const models = await httpPost(`${SERVER.replace(/\/$/,'')}/v1/models`, {}, timeoutMs);
      return { ok: true, via: 'server', models };
    } catch (e) {
      return { ok: false, error: String(e.message||e) };
    }
  } else {
    const MODEL_PATH = getMODEL_PATH();
    if (!MODEL_PATH) return { ok:false, error:'MODEL_PATH missing' };
    try {
      const args = ['-m', MODEL_PATH, '--prompt', 'ping', '--n-predict', '1'];
      await runCli(CLI, args, timeoutMs);
      return { ok:true, via:'cli' };
    } catch (e) {
      return { ok:false, error:String(e.message||e) };
    }
  }
}

export async function listModels() {
  const SERVER = getSERVER();
  if (SERVER) {
    try {
      const d = await httpPost(`${SERVER.replace(/\/$/,'')}/v1/models`, {});
      const names = Array.isArray(d?.data) ? d.data.map(x => x.id || x.name || 'default') : [];
      return names.length ? names : ['default'];
    } catch {
      return ['default'];
    }
  }
  // CLI mode: just expose the configured path as a single "model"
  const MODEL_PATH = getMODEL_PATH();
  return MODEL_PATH ? [MODEL_PATH] : [];
}

function runCli(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('llama-cli timeout'));
    }, timeoutMs);
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(`llama-cli exit ${code}: ${err.slice(0,200)}`));
    });
  });
}
