// gateway/usecases/warmup.js
// Warmup loader: Prefer llama stub in tests; otherwise ensure LoRA server is ready

export async function warmupUseCase(req, res, deps) {
  const body = req.body || {};
  const name = body.name || body.model || process.env.LORA_MODEL_NAME || 'default';
  const model_path = body.model_path || process.env.LORA_MODEL_PATH || '';
  const lora_paths = body.lora_paths || (() => {
    const raw = process.env.LORA_LORA_PATHS_JSON || process.env.LORA_ADAPTERS_JSON || '';
    try { return raw ? JSON.parse(raw) : undefined; } catch { return undefined; }
  })();
  try {
    const useStub = process.env.NODE_ENV === 'test' && Boolean(process.env.LLAMACPP_SERVER);
    if (useStub) {
      // Preserve legacy behavior for tests: resolve model path and warm up stub
      const { resolveModelPath } = await import('../routes/modelResolver.js');
      const { warmup: llmWarmup } = await import('../lib/llm.js');
      const resolvedPath = resolveModelPath(body.model || name);
      const r = await llmWarmup({ model: resolvedPath.path });
      if (r.ok) return res.json({ ok: true, via: r.via || 'stub', model: resolvedPath.path });
      return res.status(503).json({ ok: false, error: r.error || 'warmup failed' });
    }
    // Production: ensure LoRA server has the model loaded
    const { ensureLoaded } = await import('../lib/lora_client.js');
    if (!model_path) return res.status(400).json({ ok: false, error: 'missing model_path' });
    await ensureLoaded({ name, model_path, lora_paths }, Number(process.env.GATEWAY_TIMEOUT_MS || 60000));
    return res.json({ ok: true, via: 'lora_server', model: name });
  } catch (e) {
    return res.status(503).json({ ok: false, error: String(e?.message || e) });
  }
}
