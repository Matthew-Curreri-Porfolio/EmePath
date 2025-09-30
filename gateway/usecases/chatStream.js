import { Readable } from 'stream';
import { MODEL, MOCK, VERBOSE, LOG_BODY, THINK } from '../config.js';

// Stream chat by synthesizing SSE from LoRA server completion
import { chat as loraChat } from '../lib/lora_client.js';

export async function chatStreamUseCase(req, res, deps) {
  const { log, getTimeoutMs } = deps;
  const id = Math.random().toString(36).slice(2, 10);
  const body = req.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const temperature =
    typeof body.temperature === 'number' ? body.temperature : 0.2;
  const maxTokens =
    typeof body.maxTokens === 'number' ? body.maxTokens : undefined;
  const model = body.model || MODEL;
  const timeoutMs = Number(getTimeoutMs() || 300000);

  const t0 = performance.now();
  log({
    id,
    event: 'request_in',
    type: 'chat_stream',
    model,
    messagesCount: messages.length,
    mock: MOCK,
  });

  if (MOCK) {
    const mockText = (body.mockText || 'Hello from mock stream.') + '\n\n';
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    for (const ch of mockText) {
      res.write(
        `data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ delta: { content: ch } }] })}\n\n`
      );
    }
    res.write(`data: [DONE]\n\n`);
    res.end();
    log({
      id,
      event: 'response_out',
      type: 'chat_stream',
      mock: true,
      bytes: mockText.length,
    });
    return;
  }

  if (process.env.NODE_ENV === 'test' && !process.env.LORA_SERVER_BASE) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    const msg = 'test-stream';
    for (const ch of msg) {
      res.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', choices: [{ delta: { content: ch } }] })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  try {
    const { content } = await loraChat({ messages, temperature, maxTokens, timeoutMs });
    // Emit chunks as if streaming
    for (const ch of String(content || '')) {
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', choices: [{ delta: { content: ch } }] })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (e) {
    res.status(502).json({ error: 'stream error' });
  }
}
