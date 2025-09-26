// gateway/tools/insights.js
// Insight Engine: synthesizes structured insights from web pages (via Whoogle)
// and/or local indexed files. Produces JSON with key points, pros/cons, entities,
// topics, controversies, consensus, and source attributions.

import { researchWeb } from './research.js';
import { makeSnippets } from '../utils.js';
import { chat as llmChat } from '../lib/llm.js';
import { composeSystem } from '../prompts/compose.js';

function stripTags(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pickLocalHits(index, query, k = 5) {
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
    for (const t of terms) {
      // simple lexical frequency score
      const c = lower.split(t).length - 1;
      score += c;
    }
    if (score > 0) scored.push({ f, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const hits = scored.slice(0, Math.max(1, k)).map(({ f, score }) => ({
    path: f.path,
    score,
    snippets: makeSnippets(f.text, terms),
  }));
  return hits;
}

function buildEvidenceBlocks({ web, local }, { maxContextChars = 20000 } = {}) {
  const blocks = [];
  const sources = [];
  let w = 0;
  let l = 0;

  // Web pages
  if (web && Array.isArray(web)) {
    for (const item of web) {
      if (!item?.page?.ok) continue;
      const id = `W${++w}`;
      const title = item.page.title || item.title || item.url;
      const content = String(item.page.content || '').slice(
        0,
        Math.max(2000, Math.floor(maxContextChars / 4))
      );
      blocks.push(`[${id}] ${title}\n${content}`);
      sources.push({
        id,
        title,
        url: item.url,
        snippet: stripTags(item.page.description || item.snippet || ''),
      });
    }
  }

  // Local files
  if (local && Array.isArray(local)) {
    for (const hit of local) {
      const id = `L${++l}`;
      const title = hit.path;
      const content = (hit.snippets || []).join('\n...') || '';
      if (!content) continue;
      blocks.push(`[${id}] ${title}\n${content}`);
      sources.push({
        id,
        title,
        path: hit.path,
        snippet: content.slice(0, 240),
      });
    }
  }

  // Truncate global evidence softly by clipping each block if oversized
  let total = blocks.map((b) => b.length).reduce((a, b) => a + b, 0);
  if (total > maxContextChars && blocks.length) {
    const ratio = maxContextChars / total;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      const cap = Math.max(800, Math.floor(b.length * ratio));
      blocks[i] = b.slice(0, cap);
    }
  }

  return { text: blocks.join('\n\n'), sources };
}

function buildPrompt({ query, compare = [] }, evidenceText) {
  const compareNote =
    Array.isArray(compare) && compare.length
      ? `\n\nWhen relevant, include a comparison section across entities: ${compare.join(', ')}.`
      : '';

  const sys = composeSystem('insights.system');

  const usr = `USER QUESTION:\n${query}${compareNote}\n\nEVIDENCE:\n${evidenceText}`;
  const messages = [
    { role: 'system', content: sys },
    { role: 'user', content: usr },
  ];
  return messages;
}

export async function insightsEngine(
  query,
  {
    mode = 'web', // 'web' | 'local' | 'hybrid'
    base,
    num = 6,
    fetchNum = 4,
    concurrency = 3,
    site,
    lang = 'en',
    safe = false,
    fresh,
    localIndex, // { files: [{path,text}, ...] }
    localK = 5,
    compare = [],
    maxContextChars = 20000,
    maxAnswerTokens = 700,
    signal,
  } = {}
) {
  const useWeb = mode === 'web' || mode === 'hybrid';
  const useLocal = mode === 'local' || mode === 'hybrid';

  // Discover web results (enriched via researchWeb)
  let webEnriched = [];
  if (useWeb) {
    const rr = await researchWeb(query, {
      base,
      num,
      fetchNum,
      concurrency,
      site,
      lang,
      safe,
      fresh,
      signal,
    });
    if (rr && rr.ok) webEnriched = Array.isArray(rr.results) ? rr.results : [];
  }

  // Pick local hits
  let localHits = [];
  if (useLocal && localIndex && localIndex.files) {
    localHits = pickLocalHits(localIndex, query, localK);
  }

  if (!webEnriched.length && !localHits.length) {
    return { ok: false, error: 'no_context' };
  }

  const { text: evidence, sources } = buildEvidenceBlocks(
    { web: webEnriched, local: localHits },
    { maxContextChars }
  );
  const messages = buildPrompt({ query, compare }, evidence);

  try {
    const r = await llmChat({
      messages,
      temperature: 0.2,
      maxTokens: maxAnswerTokens,
      timeoutMs: 60000,
    });
    let insights;
    try {
      insights = JSON.parse(r?.content || '{}');
    } catch (_) {
      // If model returned non-JSON, wrap as text fallback
      insights = { summary: String(r?.content || '').trim() };
    }
    return { ok: true, query, mode, insights, sources };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

export { insightsEngine as default };
