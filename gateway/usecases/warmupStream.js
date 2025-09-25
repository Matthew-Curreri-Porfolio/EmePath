// gateway/usecases/warmupStream.js
import { warmup as llmWarmup } from '../lib/llm.js';

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
    try { clearInterval(hb); } catch {}
  };
  res.on('close', onClose);

  try {
    const result = await llmWarmup({ model: body.model, timeoutMs });
    done = true;
    clearInterval(hb);
    if (result && result.ok) {
      send({ event: 'status', state: 'ok', via: result.via || 'unknown' });
    } else {
      send({ event: 'status', state: 'error', error: String(result && result.error || 'unknown') });
    }
    res.end();
  } catch (e) {
    const reason = e?.name === 'AbortError' ? 'timeout' : (e?.message || String(e));
    if (typeof log === 'function') log({ id, event: 'error', where: 'warmup', reason });
    done = true;
    clearInterval(hb);
    send({ event: 'status', state: 'error', error: reason });
    res.end();
  } finally {
    res.off?.('close', onClose);
  }
}

export default { warmupStreamUseCase };

