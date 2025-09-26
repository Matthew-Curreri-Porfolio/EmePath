// gateway/usecases/warmup.js
// Warmup loader: in tests without a LoRA server, short‑circuit OK; otherwise ensure LoRA server is ready

export async function warmupUseCase(req, res, deps) {
  const body = req.body || {};
  const name = body.name || body.model || process.env.LORA_MODEL_NAME || 'default';
  const model_path = body.model_path || process.env.LORA_MODEL_PATH || '';
  const lora_paths = body.lora_paths || (() => {
    const raw = process.env.LORA_LORA_PATHS_JSON || process.env.LORA_ADAPTERS_JSON || '';
    try { return raw ? JSON.parse(raw) : undefined; } catch { return undefined; }
  })();
  try {
    if (process.env.NODE_ENV === 'test' && !process.env.LORA_SERVER_BASE) {
      return res.json({ ok: true, via: 'test', model: name });
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
