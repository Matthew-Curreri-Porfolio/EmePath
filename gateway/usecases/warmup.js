// gateway/usecases/warmup.js
import { warmup as llmWarmup } from '../lib/llm.js';

export async function warmupUseCase(_req, res, _deps) {
  const r = await llmWarmup({});
  if (r.ok) return res.json({ ok:true, via:r.via });
  return res.status(503).json({ ok:false, error:r.error || 'warmup failed' });
}
