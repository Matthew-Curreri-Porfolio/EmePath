// gateway/tools/plan.js
// Generate a safe, verifiable runbook grounded in local/web context.

import { chat as llmChat } from '../lib/llm.js';
import { insightsEngine } from './insights.js';
import { composeSystem } from '../prompts/compose.js';
import { makeSnippets } from '../utils.js';

function pickLocalHits(index, query, k = 6) {
  if (!index || !Array.isArray(index.files) || !query) return [];
  const files = index.files;
  const terms = String(query)
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .filter(Boolean);
  if (!terms.length) return [];
  const scored = [];
  for (const f of files) {
    const text = (f && f.text) || '';
    if (!text) continue;
    let score = 0;
    const lower = text.toLowerCase();
    for (const t of terms) score += lower.split(t).length - 1;
    if (score > 0) scored.push({ f, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, k)).map(({ f, score }) => ({
    path: f.path,
    score,
    snippets: makeSnippets(f.text, terms),
  }));
}

function buildEvidence({
  mode,
  insights,
  localIndex,
  query,
  localK = 6,
  maxContextChars = 20000,
}) {
  const blocks = [];
  const sources = [];
  if (insights && insights.sources && Array.isArray(insights.sources)) {
    for (const s of insights.sources) {
      const head = s.title || s.path || s.url || 'source';
      const snip = s.snippet || '';
      blocks.push(`[${s.id}] ${head}\n${snip}`);
      sources.push(s);
    }
  }
  if (
    (mode === 'local' || mode === 'hybrid') &&
    (!insights || !insights.sources?.length)
  ) {
    const hits = pickLocalHits(localIndex, query, localK);
    let i = 0;
    for (const h of hits) {
      const id = `L${++i}`;
      const snip = (h.snippets || []).join('\n...');
      blocks.push(`[${id}] ${h.path}\n${snip}`);
      sources.push({
        id,
        title: h.path,
        path: h.path,
        snippet: snip.slice(0, 240),
      });
    }
  }
  let text = blocks.join('\n\n');
  if (text.length > maxContextChars) text = text.slice(0, maxContextChars);
  return { evidenceText: text, sources };
}

function planPrompt(
  {
    query,
    target = 'general',
    constraints,
    envOs = 'linux',
    risk = 'medium',
    maxSteps = 12,
  },
  evidenceText
) {
  const sys = composeSystem('plan.system', { envOs });
  const usr = `TASK: ${query}\nTARGET: ${target}\nRISK: ${risk}\nCONSTRAINTS: ${constraints || '(none)'}\n\nEVIDENCE:\n${evidenceText}`;
  return [
    { role: 'system', content: sys },
    { role: 'user', content: usr },
  ];
}

export async function planEngine(
  body,
  {
    mode = 'hybrid',
    base,
    num = 6,
    fetchNum = 4,
    concurrency = 3,
    site,
    lang = 'en',
    safe = false,
    fresh,
    localIndex,
    localK = 6,
    maxContextChars = 22000,
    maxAnswerTokens = 1000,
  } = {}
) {
  const query = body.query;
  const target = body.target || 'general';
  const constraints = body.constraints;
  const envOs = body.envOs || 'linux';
  const risk = body.risk || 'medium';
  const maxSteps = body.maxSteps || 12;

  // Pull insights to help ground the plan (best-effort)
  let insights;
  try {
    insights = await insightsEngine(query, {
      mode,
      base,
      num,
      fetchNum,
      concurrency,
      site,
      lang,
      safe,
      fresh,
      localIndex,
      localK,
      maxContextChars,
      maxAnswerTokens: 500,
    });
  } catch {}
  const { evidenceText, sources } = buildEvidence({
    mode,
    insights: insights && insights.ok ? insights : null,
    localIndex,
    query,
    localK,
    maxContextChars,
  });
  if (!evidenceText) return { ok: false, error: 'no_context' };

  const messages = planPrompt(
    { query, target, constraints, envOs, risk, maxSteps },
    evidenceText
  );
  try {
    const r = await llmChat({
      messages,
      temperature: 0.2,
      maxTokens: maxAnswerTokens,
      timeoutMs: 70000,
      json: true,
    });
    let plan;
    try {
      plan = JSON.parse(r?.content || '{}');
    } catch {
      plan = null;
    }
    // Validate minimal contract: require steps[] to avoid returning a misleading 200 with junk
    if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
      return {
        ok: false,
        error: 'invalid_plan',
        notes: r?.content ? String(r.content).slice(0, 200) : undefined,
      };
    }
    return { ok: true, query, mode, plan, sources };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

export { planEngine as default };
