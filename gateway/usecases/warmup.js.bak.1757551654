import crypto from 'crypto';
import { performance } from 'perf_hooks';

export async function warmupUseCase(req, res, deps) {
  const {
    log,
    getTimeoutMs,
    OLLAMA,
    MODEL,
    MOCK,
  } = deps;
  const id = crypto.randomUUID();
  const t0 = performance.now();
  const model = req.body?.model || MODEL;
  const keepAlive = req.body?.keepAlive || "2h";
  const timeoutMs = getTimeoutMs(req.body?.timeoutMs);
  log({ id, event: "request_in", type: "warmup", model, keepAlive, timeoutMs });
  if (MOCK) return res.json({ ok: true, mock: true, model });
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(`${OLLAMA}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: " ",
        stream: false,
        keep_alive: keepAlive,
        options: { temperature: 0.0 },
      }),
      signal: controller.signal,
    });
    const raw = await r.text().catch(() => "");
    const json = (() => {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    })();
    const loadMs = Math.round(performance.now() - t0);
    log({ id, event: "warmup_done", status: r.status, load_duration: json?.load_duration, latencyMs: loadMs });
    if (!r.ok) return res.status(502).json({ ok: false, status: r.status, error: raw.slice(0, 200) });
    return res.json({ ok: true, model, loadMs, load_duration: json?.load_duration });
  } catch (e) {
    const loadMs = Math.round(performance.now() - t0);
    log({ id, event: "error", where: "warmup", reason: e?.message || String(e), latencyMs: loadMs });
    return res.status(504).json({ ok: false, error: "timeout/error", loadMs });
  } finally {
    clearTimeout(to);
  }
}
