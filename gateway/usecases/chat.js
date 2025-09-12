// gateway/usecases/chat.js
import { chat as llmChat } from '../lib/llm.js';

export async function chatUseCase(req, res, deps) {
  const { getTimeoutMs } = deps;
  const body = req.body || {};
  const messages = body.messages || [];
  const temperature = typeof body.temperature === 'number' ? body.temperature : 0.2;
  const maxTokens = typeof body.maxTokens === 'number' ? body.maxTokens : undefined;
  try {
    const r = await llmChat({
      messages,
      model: body.model,
      temperature,
      maxTokens,
      timeoutMs: getTimeoutMs(),
      outputContract: body.outputContract, // optional strict contract text/JSON schema/example
      json: body.responseFormat === 'json' || Boolean(body.outputContract),
    });
    res.json({ ok:true, content: r.content, raw: r.raw });
  } catch (e) {
    res.status(502).json({ ok:false, error: String(e.message||e) });
  }
}
