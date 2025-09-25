// gateway/tools/debate.js
// Multi-agent debate over grounded evidence (web/local/hybrid), emitting structured JSON.

import { chat as llmChat } from "../lib/llm.js";
import { insightsEngine } from "./insights.js";
import { composeSystem } from "../prompts/compose.js";

function buildDebatePrompt(question, evidenceText, { rounds=2, trace=false } = {}) {
  const trace_schema = trace ? '\\"trace\\": [{\\"role\\":\\"Pro|Con|Critic|Judge\\",\\"content\\":string}]' : '\\"trace\\": []';
  const sys = composeSystem('debate.system', { rounds: String(rounds), trace_schema });
  const usr = `QUESTION: ${question}\n\nEVIDENCE:\n${evidenceText}`;
  return [ { role:'system', content: sys }, { role:'user', content: usr } ];
}

export async function debateEngine(
  query,
  {
    mode = 'hybrid',
    useInsights = true,
    rounds = 2,
    trace = false,
    base,
    num = 6,
    fetchNum = 4,
    concurrency = 3,
    site,
    lang='en',
    safe=false,
    fresh,
    localIndex,
    localK=6,
    maxContextChars=22000,
    maxAnswerTokens=900,
    signal,
  } = {}
) {
  // Gather evidence via insights (preferred) or skip to direct debate.
  let evidenceText = '';
  let sources = [];
  if (useInsights) {
    const ir = await insightsEngine(query, { mode, base, num, fetchNum, concurrency, site, lang, safe, fresh, localIndex, localK, maxContextChars, maxAnswerTokens: 500, signal });
    if (ir && ir.ok) {
      // Rebuild evidence text from insights sources to keep grounding lean
      const blocks = [];
      for (const s of ir.sources || []) {
        const head = s.title || s.path || s.url || 'source';
        const snip = s.snippet || '';
        blocks.push(`[${s.id}] ${head}\n${snip}`);
      }
      evidenceText = blocks.join('\n\n').slice(0, maxContextChars);
      sources = ir.sources || [];
    }
  }
  if (!evidenceText) return { ok:false, error:'no_context' };

  const messages = buildDebatePrompt(query, evidenceText, { rounds, trace });
  try {
    const r = await llmChat({ messages, temperature: 0.2, maxTokens: maxAnswerTokens, timeoutMs: 60000 });
    let debate;
    try { debate = JSON.parse(r?.content || '{}'); } catch { debate = { summary: String(r?.content||'').trim() } }
    return { ok:true, query, mode, debate, sources };
  } catch (e) {
    return { ok:false, error:String(e && e.message || e) };
  }
}

export { debateEngine as default };
