// gateway/usecases/chat.js
// Primary inference via Python LoRA server; fallback to llama.cpp stub in tests.
import { stableStringify } from '../lib/cache.js';
import { cacheGet, cachePut, logLLM } from '../db/db.js';

export async function chatUseCase(req, res, deps) {
  const { getTimeoutMs, log } = deps;
  const body = req.body || {};
  const messages = body.messages || [];
  const temperature =
    typeof body.temperature === 'number' ? body.temperature : 0.2;
  const maxTokens =
    typeof body.maxTokens === 'number' ? body.maxTokens : undefined;
  try {
    // DB-backed cache
    // Normalize messages: role + content only, in order
    const normMsgs = (messages || []).map((m) => ({
      role: m.role || 'user',
      content: String(m.content ?? ''),
    }));
    const key = stableStringify({
      t: 'chat',
      model: body.model || '',
      messages: normMsgs,
      temperature,
      maxTokens,
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
    // Select backend: prefer llama.cpp stub during tests, otherwise LoRA server
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
