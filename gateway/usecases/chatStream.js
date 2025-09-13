import { GATEWAY_TIMEOUT_MS, MODEL, MOCK, VERBOSE, LOG_BODY, THINK } from "../config.js";

// Stream chat via llama.cpp's OpenAI-compatible API (/v1/chat/completions)
// Requires env `LLAMACPP_SERVER` to point at llama-server (e.g. http://127.0.0.1:8080)

export async function chatStreamUseCase(req, res, deps) {
  const { log } = deps;
  const id = Math.random().toString(36).slice(2, 10);
  const body = req.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const temperature = typeof body.temperature === 'number' ? body.temperature : 0.2;
  const maxTokens = typeof body.maxTokens === 'number' ? body.maxTokens : undefined;
  const model = body.model || MODEL;
  const timeoutMs = Number(GATEWAY_TIMEOUT_MS || 300000);

  const t0 = performance.now();
  log({ id, event: "request_in", type: "chat_stream", model, messagesCount: messages.length, mock: MOCK });

  if (MOCK) {
    const mockText = (body.mockText || "Hello from mock stream.") + "\n\n";
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    for (const ch of mockText) {
      res.write(`data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", choices: [{ delta: { content: ch } }] })}\n\n`);
    }
    res.write(`data: [DONE]\n\n`);
    res.end();
    log({ id, event: "response_out", type: "chat_stream", mock: true, bytes: mockText.length });
    return;
  }

  const BASE = (process.env.LLAMACPP_SERVER || '').replace(/\/$/, '') || 'http://127.0.0.1:8080';
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const payload = {
      model: model || 'default',
      stream: true,
      messages: messages.map(m => ({ role: m.role || 'user', content: String(m.content ?? '') })),
      temperature,
    };
    if (typeof maxTokens === 'number') payload.max_tokens = maxTokens;
    if (LOG_BODY) log({ id, event: "upstream_body", type: "chat_stream", payload });
    const url = `${BASE}/v1/chat/completions`;
    log({ id, event: "upstream_request", type: "chat_stream", url, timeoutMs, bodySize: JSON.stringify(payload).length });
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
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
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    r.body.on("data", chunk => {
      res.write(chunk);
      res.flush?.();
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

