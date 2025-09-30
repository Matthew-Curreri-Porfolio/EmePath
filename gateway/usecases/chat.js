// gateway/usecases/chat.js
// Primary inference via Python LoRA server; fallback to a lightweight test stub.
import { stableStringify } from '../lib/cache.js';
import { cacheGet, cachePut, logLLM } from '../db/db.js';

export async function chatUseCase(req, res, deps) {
  const { getTimeoutMs, log } = deps;
  const body = req.body || {};
  let messages = Array.isArray(body.messages) ? body.messages.slice() : [];
  const temperature =
    typeof body.temperature === 'number' ? body.temperature : 0.2;
  const maxTokens =
    typeof body.maxTokens === 'number' ? body.maxTokens : undefined;
  // Optionally inject a system prompt describing EmePath identity and behavior
  try {
    const wantSystem = String(process.env.EMEPATH_SYSTEM_PROMPT || '1').toLowerCase();
    const includeSystem = wantSystem === '1' || wantSystem === 'true';
    const firstIsSystem = messages.length && String(messages[0]?.role) === 'system';
    if (includeSystem && !firstIsSystem) {
      const fs = await import('fs');
      const path = await import('path');
      const sysPath = path.resolve(process.cwd(), 'gateway', 'prompts', 'system.txt');
      let sysText = '';
      try { sysText = fs.readFileSync(sysPath, 'utf8'); } catch {}
      const name = process.env.EMEPATH_NAME || 'EmePath';
      const preface = `${name} system prompt`;
      const system = [sysText || '', ''].join('\n').trim();
      if (system) messages.unshift({ role: 'system', content: system });
    }
  } catch {}
  const topP = typeof body.topP === 'number' ? body.topP : undefined;
  const topK = typeof body.topK === 'number' ? body.topK : undefined;
  const repetitionPenalty =
    typeof body.repetitionPenalty === 'number' ? body.repetitionPenalty : undefined;
  const deterministic =
    typeof body.deterministic === 'boolean' ? body.deterministic : undefined;
  try {
    // DB-backed cache
    // Normalize messages: role + content only, in order
    const normMsgs = (messages || []).map((m) => ({
      role: m.role || 'user',
      content: String(m.content ?? ''),
    }));
    const key = stableStringify({
      cacheV: 2,
      t: 'chat',
      model: body.model || '',
      messages: normMsgs,
      temperature,
      maxTokens,
      topP,
      topK,
      repetitionPenalty,
      deterministic,
      fmt: 'hf_chat_template',
      outputContract: body.outputContract || null,
      json: body.responseFormat === 'json' || Boolean(body.outputContract),
    });
    const boolish = (v) =>
      typeof v === 'string'
        ? ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())
        : v === true;
    const disable =
      boolish(process.env.GATEWAY_CACHE_DISABLE) ||
      boolish(req.headers['x-cache-disable']) ||
      boolish(body.disableCache) ||
      (typeof body.cache !== 'undefined' && body.cache === false) ||
      process.env.NODE_ENV === 'test';
    const hitRow = disable ? null : cacheGet('chat', key);
    const hit = hitRow
      ? { content: hitRow.response, raw: hitRow.raw }
      : undefined;
    if (hit) {
      if (typeof log === 'function') log({ event: 'cache_hit', type: 'chat' });
      return res.json({
        ok: true,
        message: { role: 'assistant', content: hit.content },
        raw: hit.raw,
        cached: true,
      });
    }
    // Select backend: in tests without a LoRA server, return a stubbed response
    if (process.env.NODE_ENV === 'test' && !process.env.LORA_SERVER_BASE) {
      const content = 'stub:ok';
      try {
        logLLM('chat', {
          model: body.model,
          requestObj: { messages: normMsgs, temperature, maxTokens },
          responseText: content,
          rawObj: {},
        });
      } catch {}
      return res.json({ ok: true, message: { role: 'assistant', content }, raw: {}, cached: false });
    }
    const { chat: chatImpl } = await import('../lib/lora_client.js');

    const r = await chatImpl({
      messages,
      model: body.model,
      loraName: body.loraName,
      loraModel: body.loraModel, // { name, model_path, lora_paths } — LoRA only
      temperature,
      maxTokens,
      topP,
      topK,
      repetitionPenalty,
      deterministic,
      timeoutMs: getTimeoutMs(),
      outputContract: body.outputContract, // optional strict contract text/JSON schema/example
      json: body.responseFormat === 'json' || Boolean(body.outputContract),
    });
    if (!disable)
      cachePut('chat', key, {
        model: body.model,
        requestObj: {
          messages: normMsgs,
          temperature,
          maxTokens,
          outputContract: body.outputContract || null,
          json: body.responseFormat === 'json' || Boolean(body.outputContract),
        },
        responseText: r.content,
        rawObj: r.raw,
        ttlMs: Number(process.env.GATEWAY_CACHE_TTL_MS || 10 * 60_000),
      });
    try {
      const usage = r?.raw?.usage || r?.raw?.metadata?.usage || null;
      const pt = Number(usage?.prompt_tokens);
      const ct = Number(usage?.completion_tokens);
      const tt = Number(
        usage?.total_tokens ||
          (Number.isFinite(pt) && Number.isFinite(ct) ? pt + ct : undefined)
      );
      const cost = Number(r?.raw?.cost_usd || r?.raw?.usage?.cost_usd);
      logLLM('chat', {
        model: body.model,
        requestObj: {
          messages: normMsgs,
          temperature,
          maxTokens,
          outputContract: body.outputContract || null,
        },
        responseText: r.content,
        rawObj: r.raw,
        promptTokens: Number.isFinite(pt) ? pt : undefined,
        completionTokens: Number.isFinite(ct) ? ct : undefined,
        totalTokens: Number.isFinite(tt) ? tt : undefined,
        costUsd: Number.isFinite(cost) ? cost : undefined,
      });
    } catch {}
    res.json({
      ok: true,
      message: { role: 'assistant', content: r.content },
      raw: r.raw,
      cached: false,
    });
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e.message || e) });
  }
}
