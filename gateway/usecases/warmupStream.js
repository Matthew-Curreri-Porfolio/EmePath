// gateway/usecases/warmupStream.js
import { ensureLoaded } from '../lib/lora_client.js';

export async function warmupStreamUseCase(req, res, deps) {
  const { log, getTimeoutMs } = deps || {};
  const id = Math.random().toString(36).slice(2, 10);
  const body = req.body || {};
  const timeoutMs = Number(getTimeoutMs?.() || 300000);

  const send = (obj) => {
    try {
      res.write(`data: ${JSON.stringify({ id, ...obj })}\n\n`);
      res.flush?.();
    } catch {}
  };

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  const t0 = Date.now();
  let done = false;
  send({ event: 'status', state: 'starting' });

  const hb = setInterval(() => {
    if (done) return;
    send({ event: 'status', state: 'waiting', ms: Date.now() - t0 });
  }, 1000);

  const onClose = () => {
    done = true;
    try {
      clearInterval(hb);
    } catch {}
  };
  res.on('close', onClose);

  try {
    const name = body.name || body.model || process.env.LORA_MODEL_NAME || 'default';
    const model_path = body.model_path || process.env.LORA_MODEL_PATH || '';
    const lora_paths = body.lora_paths || (() => {
      const raw = process.env.LORA_LORA_PATHS_JSON || process.env.LORA_ADAPTERS_JSON || '';
      try { return raw ? JSON.parse(raw) : undefined; } catch { return undefined; }
    })();
    await ensureLoaded({ name, model_path, lora_paths }, timeoutMs);
    done = true;
    clearInterval(hb);
    send({ event: 'status', state: 'ok', via: 'lora_server' });
    res.end();
  } catch (e) {
    const reason =
      e?.name === 'AbortError' ? 'timeout' : e?.message || String(e);
    if (typeof log === 'function')
      log({ id, event: 'error', where: 'warmup', reason });
    done = true;
    clearInterval(hb);
    send({ event: 'status', state: 'error', error: reason });
    res.end();
  } finally {
    res.off?.('close', onClose);
  }
}

export default { warmupStreamUseCase };
