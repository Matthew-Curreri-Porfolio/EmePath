import crypto from 'crypto';
import { performance } from 'perf_hooks';

export async function chatUseCase(req, res, deps) {
  const {
    log,
    getTimeoutMs,
    OLLAMA,
    MODEL,
    MOCK,
    VERBOSE,
    LOG_BODY,
  } = deps;
  const id = crypto.randomUUID();
  const t0 = performance.now();
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const model = req.body?.model || MODEL;
  log({ id, event: "request_in", type: "chat", model, messagesCount: messages.length, mock: MOCK });
  if (VERBOSE && LOG_BODY) log({ id, event: "chat_preview", messages: messages.slice(-2) });
  if (MOCK) {
    const text = "Mock reply. (Enable Ollama to chat.)";
    log({ id, event: "response_out", type: "chat", mock: true, bytes: text.length });
    return res.json({ message: { role: "assistant", content: text } });
  }
  const timeoutMs = getTimeoutMs(req.body?.timeoutMs);
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), timeoutMs);
  const body = {
    model,
    messages,
    stream: false,
    keep_alive: req.body?.keepAlive || "30m",
    options: { temperature: 0.2 },
  };
  log({ id, event: "upstream_request", type: "chat", url: `${OLLAMA}/api/chat`, timeoutMs, bodySize: JSON.stringify(body).length });
  try {
    const t1 = performance.now();
    const r = await fetch(`${OLLAMA}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const t2 = performance.now();
    const status = r.status;
    const raw = await r.text().catch(() => "");
    const json = (() => {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    })();
    const assistant = json?.message?.content ?? "";
    const latencyUp = Math.round(t2 - t1);
    const latencyAll = Math.round(performance.now() - t0);
    log({ id, event: "upstream_response", type: "chat", status, latencyUpstreamMs: latencyUp, bytes: assistant.length, eval_count: json?.eval_count, eval_duration: json?.eval_duration, prompt_eval_count: json?.prompt_eval_count, prompt_eval_duration: json?.prompt_eval_duration, load_duration: json?.load_duration });
    if (!r.ok) {
      log({ id, event: "error", where: "upstream_not_ok", type: "chat", status, preview: raw.slice(0, 200) });
      return res.status(502).json({ error: "upstream error", status });
    }
    log({ id, event: "response_out", type: "chat", latencyMs: latencyAll, outBytes: assistant.length, preview: String(assistant).slice(0, 200) });
    return res.json({ message: { role: "assistant", content: assistant } });
  } catch (e) {
    const latencyAll = Math.round(performance.now() - t0);
    const reason = e?.name === "AbortError" ? "timeout" : (e?.message || "error");
    log({ id, event: "error", where: "fetch", type: "chat", reason, latencyMs: latencyAll });
    return res.status(504).json({ error: "timeout/error" });
  } finally {
    clearTimeout(to);
  }
}
