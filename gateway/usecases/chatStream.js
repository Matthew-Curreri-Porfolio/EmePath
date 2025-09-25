import { Readable } from "stream";
import { MODEL, MOCK, VERBOSE, LOG_BODY, THINK } from "../config.js";

// Stream chat via llama.cpp's OpenAI-compatible API (/v1/chat/completions)
// Requires env `LLAMACPP_SERVER` to point at llama-server (e.g. http://127.0.0.1:8080)

export async function chatStreamUseCase(req, res, deps) {
  const { log, getTimeoutMs } = deps;
  const id = Math.random().toString(36).slice(2, 10);
  const body = req.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const temperature = typeof body.temperature === 'number' ? body.temperature : 0.2;
  const maxTokens = typeof body.maxTokens === 'number' ? body.maxTokens : undefined;
  const model = body.model || MODEL;
  const timeoutMs = Number(getTimeoutMs() || 300000);

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
  let upstreamStream;
  let upstreamRes;
  const onClientClose = () => {
    try { controller.abort(); } catch {}
    try { upstreamStream?.destroy?.(); } catch {}
  };
  res.on('close', onClientClose);
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
    upstreamRes = r;
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
    // Initial status event and heartbeat while waiting for first token
    let sawData = false;
    const status = (obj) => { try { res.write(`data: ${JSON.stringify({ id, event: 'status', ...obj })}\n\n`); res.flush?.(); } catch {} };
    status({ state: 'connected' });
    const hb = setInterval(() => { if (!sawData) status({ state: 'waiting' }); }, 1000);
    const body = r.body;
    // Handle both Web Streams (undici/WHATWG) and Node Readable streams robustly
    if (body && typeof body.getReader === 'function') {
      // WHATWG ReadableStream
      const reader = body.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            sawData = true;
            const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
            res.write(chunk);
            res.flush?.();
          }
        }
        res.end();
      } catch (err) {
        const latencyErr = Math.round(performance.now() - t0);
        const reason = err?.message || 'stream error';
        log({ id, event: "error", where: "stream_read", type: "chat_stream", reason, latencyMs: latencyErr });
        if (!res.headersSent) res.status(502).json({ error: "stream error" });
        else { try { status({ state: 'error', reason }); res.end(); } catch {} }
      } finally {
        try { await reader.cancel(); } catch {}
        clearInterval(hb);
      }
      return;
    }

    let stream = body;
    if (stream && typeof stream.on !== 'function' && typeof Readable?.fromWeb === 'function') {
      try { stream = Readable.fromWeb(stream); } catch {}
    }
    if (!stream || typeof stream.on !== 'function') {
      res.status(502).json({ error: "invalid upstream stream" });
      return;
    }
    upstreamStream = stream;
    stream.on("data", chunk => { sawData = true; res.write(chunk); res.flush?.(); });
    stream.on("error", err => {
      const latencyErr = Math.round(performance.now() - t0);
      const reason = err?.message || 'stream error';
      log({ id, event: "error", where: "stream", type: "chat_stream", reason, latencyMs: latencyErr });
      if (!res.headersSent) res.status(502).json({ error: "stream error" });
      else { try { status({ state: 'error', reason }); res.end(); } catch {} }
    });
    stream.on("end", () => { clearInterval(hb); res.end(); });
  } catch (e) {
    const latencyAll = Math.round(performance.now() - t0);
    const isAbort = e?.name === "AbortError" || /timeout/i.test(String(e?.message || e));
    const reason = isAbort ? "timeout" : (e?.message || "error");
    log({ id, event: "error", where: "fetch", type: "chat_stream", reason, latencyMs: latencyAll });
    // Treat upstream issues as Bad Gateway to align with tests
    res.status(502).json({ error: isAbort ? "timeout" : "upstream error" });
  } finally {
    clearTimeout(to);
    res.off?.('close', onClientClose);
    try { upstreamStream?.destroy?.(); } catch {}
  }
}
