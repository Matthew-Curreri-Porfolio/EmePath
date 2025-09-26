// gateway/usecases/complete.js
// Primary inference via Python LoRA server; fallback to llama.cpp stub in tests.
import { stableStringify } from '../lib/cache.js';
import { cacheGet, cachePut, logLLM } from '../db/db.js';

export async function completeUseCase(req, res, deps) {
  const { getTimeoutMs, log } = deps;
  const body = req.body || {};
  const prompt = String(body.prefix || '') + String(body.suffix || '');
  const temperature =
    typeof body.temperature === 'number' ? body.temperature : 0.2;
  const maxTokens =
    typeof body.maxTokens === 'number' ? body.maxTokens : undefined;
  try {
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
    const key = stableStringify({
      t: 'complete',
      model: body.model || '',
      prompt,
      temperature,
      maxTokens,
    });
    const hitRow = disable ? null : cacheGet('complete', key);
    if (hitRow && typeof log === 'function')
      log({ event: 'cache_db_hit', type: 'complete' });
    const hit = hitRow ? { text: hitRow.response, raw: hitRow.raw } : undefined;
    if (hit) {
      if (typeof log === 'function')
        log({ event: 'cache_hit', type: 'complete' });
      return res.json({
        ok: true,
        completion: hit.text,
        raw: hit.raw,
        cached: true,
      });
    }
    if (process.env.NODE_ENV === 'test' && !process.env.LORA_SERVER_BASE) {
      const text = 'stub:ok';
      try {
        logLLM('complete', {
          model: body.model,
          requestObj: { prompt, temperature, maxTokens },
          responseText: text,
          rawObj: {},
        });
      } catch {}
      return res.json({ ok: true, completion: text, raw: {}, cached: false });
    }
    const { complete: completeImpl } = await import('../lib/lora_client.js');

    const r = await completeImpl({
      prompt,
      model: body.model,
      loraName: body.loraName,
      loraModel: body.loraModel, // { name, model_path, lora_paths }
      temperature,
      maxTokens,
      timeoutMs: getTimeoutMs(),
    });
    if (!disable)
      cachePut('complete', key, {
        model: body.model,
        requestObj: { prompt, temperature, maxTokens },
        responseText: r.text,
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
      logLLM('complete', {
        model: body.model,
        requestObj: { prompt, temperature, maxTokens },
        responseText: r.text,
        rawObj: r.raw,
        promptTokens: Number.isFinite(pt) ? pt : undefined,
        completionTokens: Number.isFinite(ct) ? ct : undefined,
        totalTokens: Number.isFinite(tt) ? tt : undefined,
        costUsd: Number.isFinite(cost) ? cost : undefined,
      });
    } catch {}
    res.json({ ok: true, completion: r.text, raw: r.raw, cached: false });
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e.message || e) });
  }
}
