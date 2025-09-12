// gateway/usecases/complete.js
import { complete as llmComplete } from '../lib/llm.js';

export async function completeUseCase(req, res, deps) {
  const { getTimeoutMs } = deps;
  const body = req.body || {};
  const prompt = String(body.prefix || '') + String(body.suffix || '');
  const temperature = typeof body.temperature === 'number' ? body.temperature : 0.2;
  const maxTokens = typeof body.maxTokens === 'number' ? body.maxTokens : undefined;
  try {
    const r = await llmComplete({ prompt, model: body.model, temperature, maxTokens, timeoutMs: getTimeoutMs() });
    res.json({ ok:true, completion: r.text, raw: r.raw });
  } catch (e) {
    res.status(502).json({ ok:false, error: String(e.message||e) });
  }
}
