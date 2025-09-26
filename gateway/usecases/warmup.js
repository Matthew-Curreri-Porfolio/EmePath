// gateway/usecases/warmup.js
import { warmup as llmWarmup } from '../lib/llm.js';
import { resolveModelPath } from '../routes/modelResolver.js';

export async function warmupUseCase(req, res, deps) {
  const model = req.body.model || req.query.model;
  if (!model) {
    return res
      .status(400)
      .json({ ok: false, error: 'Missing model parameter' });
  }

  try {
    // Resolve the model path from the model name
    const resolvedPath = resolveModelPath(model);

    // Pass the resolved model path to the warmup function
    const r = await llmWarmup({ model: resolvedPath.path });

    if (r.ok)
      return res.json({ ok: true, via: r.via, model: resolvedPath.path });
    return res
      .status(503)
      .json({ ok: false, error: r.error || 'warmup failed' });
  } catch (error) {
    return res
      .status(400)
      .json({ ok: false, error: error.message || 'Model resolution failed' });
  }
}
