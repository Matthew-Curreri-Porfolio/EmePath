import { searchSearxng } from './searxng.js';
import { chat as llmChat } from '../lib/llm.js';
import { composeSystem } from '../prompts/compose.js';

function decodeEntities(str) {
  if (!str) return '';
  return str
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<\/?b>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTags(html) {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, ' '));
}

function cleanHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--([\s\S]*?)-->/g, '')
    .replace(/<head[\s\S]*?<\/head>/i, '');
}

function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function scoreText(text, queryTokens) {
  const tks = new Set(tokenize(text));
  let hits = 0;
  for (const q of queryTokens) if (tks.has(q)) hits++;
  return hits / Math.max(4, tks.size);
}

function pickParagraphs(html, query, maxChars = 20000) {
  const body = cleanHtml(html);
  const rawParas = body
    .split(/<\/(?:p|li|div)>/i)
    .map(stripTags)
    .map((s) => s.trim())
    .filter((s) => s.length > 60);
  const q = tokenize(query);
  const scored = rawParas
    .map((p) => ({ p, s: scoreText(p, q) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 30);
  const picked = [];
  let used = 0;
  for (const { p } of scored) {
    if (used + p.length > maxChars) break;
    picked.push(p);
    used += p.length + 2;
  }
  return picked.join('\n\n');
}

async function fetchPage(url, { timeoutMs = 8000, signal } = {}) {
  const controller = !signal ? AbortSignal.timeout(timeoutMs) : signal;
  const res = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    signal: controller,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      Accept: 'text/html,application/xhtml+xml',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ctype = res.headers.get('content-type') || '';
  if (!/text\/html|application\/xhtml\+xml/i.test(ctype))
    throw new Error(`unsupported_content ${ctype}`);
  return await res.text();
}

export async function answerWeb(
  query,
  {
    base,
    num = 6,
    fetchNum = 4,
    concurrency = 3,
    site,
    lang = 'en',
    safe = false,
    fresh,
    maxContextChars = 20000,
    maxAnswerTokens = 512,
    timeoutMs = 10000,
    signal,
  } = {}
) {
  const sr = await searchSearxng(query, {
    base,
    num,
    site,
    lang,
    safe,
    fresh,
    signal,
  });
  if (!sr || !sr.ok)
    return { ok: false, error: (sr && sr.error) || 'search_failed' };
  const results = Array.isArray(sr.results) ? sr.results : [];
  if (!results.length) return { ok: false, error: 'no_results' };

  const picks = results.slice(0, fetchNum);
  const pages = [];
  for (const r of picks) {
    try {
      const html = await fetchPage(r.url, { timeoutMs, signal });
      pages.push({ r, html });
    } catch {}
  }
  if (!pages.length) return { ok: false, error: 'fetch_failed' };

  const contexts = [];
  const sources = [];
  let idx = 0;
  for (const { r, html } of pages) {
    const content = pickParagraphs(
      html,
      query,
      Math.max(2000, Math.floor(maxContextChars / pages.length))
    );
    if (!content) continue;
    sources.push({ id: ++idx, title: r.title || '', url: r.url });
    contexts.push(`[${idx}] ${r.title || r.url}\n${content}`);
  }
  if (!contexts.length) return { ok: false, error: 'no_context' };

  const evidence = contexts.join('\n\n');
  const sys = composeSystem('answers.system');
  const usr = `USER QUESTION:\n${query}\n\nEVIDENCE:\n${evidence}`;
  const messages = [
    { role: 'system', content: sys },
    { role: 'user', content: usr },
  ];
  try {
    const r = await llmChat({
      messages,
      maxTokens: maxAnswerTokens,
      temperature: 0.1,
      timeoutMs: 60000,
    });
    const answer = r?.content || '';
    return { ok: true, answer, sources };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), sources };
  }
}
