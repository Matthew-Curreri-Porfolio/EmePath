// gateway/usecases/chatStream.js
import crypto from 'crypto';
import { performance } from 'perf_hooks';

export async function chatStreamUseCase(req, res, deps) {
  const {
    log,
    getTimeoutMs,
    OLLAMA,
    MODEL,
    MOCK,
  } = deps;

  const id = crypto.randomUUID();
  const t0 = performance.now();
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const model = req.body?.model || MODEL;
  const timeoutMs = getTimeoutMs(req.body?.timeoutMs);
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), timeoutMs);

  log({ id, event: "request_in", type: "chat_stream", model, messagesCount: messages.length, mock: MOCK });

  if (MOCK) {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.flushHeaders();
    const mockText = "Mock reply. (Enable Ollama to chat.)";
    res.write(`data: ${mockText}\n\n`);
    res.end();
    log({ id, event: "response_out", type: "chat_stream", mock: true, bytes: mockText.length });
    return;
  }

  const body = {
    model,
    messages,
    stream: true,
    keep_alive: req.body?.keepAlive || "30m",
    options: { temperature: 0.2 },
  };

  log({ id, event: "upstream_request", type: "chat_stream", url: `${OLLAMA}/api/chat`, timeoutMs, bodySize: JSON.stringify(body).length });

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();

  try {
    const r = await fetch(`${OLLAMA}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!r.ok) {
      const raw = await r.text();
      log({ id, event: "error", where: "upstream_not_ok", type: "chat_stream", status: r.status, preview: raw.slice(0, 200) });
      res.status(502).json({ error: "upstream error", status: r.status });
      return;
    }
    const latencyAll = Math.round(performance.now() - t0);
    log({ id, event: "response_out", type: "chat_stream", latencyMs: latencyAll });
    r.body.on("data", chunk => {
      res.write(chunk);
      res.flush();
    });
    r.body.on("end", () => {
      res.end();
    });
  } catch (e) {
    const latencyAll = Math.round(performance.now() - t0);
    const reason = e?.name === "AbortError" ? "timeout" : (e?.message || "error");
    log({ id, event: "error", where: "fetch", type: "chat_stream", reason, latencyMs: latencyAll });
    res.status(504).json({ error: "timeout/error" });
  } finally {
    clearTimeout(to);
  }
}
