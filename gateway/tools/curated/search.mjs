// Curated search over a local JSONL cache of documents.
// Exports: searchCurated(query, { num=5, site, lang })

import fs from 'fs';
import path from 'path';

const DEFAULT_CACHE = path.join(process.cwd(), 'gateway/tools/curated/cache/docs.jsonl');

function normalizeText(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

const STOP = new Set('the a an and or not to for of in on at by with from as is are was were be been being this that these those you your we they it its our their can could should would will may might have has had do does did if then else when where how what which who'.split(/\s+/));

function tokenize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(w => w && !STOP.has(w));
}

function scoreDoc(doc, qTokens) {
  const title = (doc.title || '').toLowerCase();
  const body = (doc.body || '').toLowerCase();
  let score = 0;
  for (const t of qTokens) {
    const tRe = new RegExp(`\\b${t.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`, 'g');
    const inTitle = (title.match(tRe) || []).length;
    const inBody = (body.match(tRe) || []).length;
    score += inTitle * 3 + inBody * 1;
  }
  // Short phrase bonus
  const phrase = qTokens.join(' ');
  if (phrase && title.includes(phrase)) score += 2;
  return score;
}

function makeSnippet(text, qTokens, size = 180) {
  const t = normalizeText(text);
  if (!t) return '';
  let idx = -1;
  for (const qt of qTokens) {
    const i = t.toLowerCase().indexOf(qt.toLowerCase());
    if (i >= 0) { idx = i; break; }
  }
  if (idx < 0) idx = 0;
  const start = Math.max(0, idx - Math.floor(size / 3));
  const end = Math.min(t.length, start + size);
  return (start > 0 ? '…' : '') + t.slice(start, end) + (end < t.length ? '…' : '');
}

function readCache(cachePath = DEFAULT_CACHE) {
  if (!fs.existsSync(cachePath)) return [];
  const lines = fs.readFileSync(cachePath, 'utf8').split(/\r?\n/);
  const out = [];
  for (const ln of lines) {
    if (!ln.trim()) continue;
    try { out.push(JSON.parse(ln)); } catch { /* ignore */ }
  }
  return out;
}

function filterDocs(docs, { site, lang }) {
  let out = docs;
  if (site) {
    const hostRe = new RegExp(site.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&'), 'i');
    out = out.filter(d => hostRe.test(d.url || ''));
  }
  if (lang) {
    out = out.filter(d => !d.lang || String(d.lang).toLowerCase().startsWith(String(lang).toLowerCase()));
  }
  return out;
}

export async function searchCurated(query, { num = 5, site, lang, cache = DEFAULT_CACHE } = {}) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: 'empty_query' };
  const qTokens = tokenize(q);
  if (!qTokens.length) return { ok: false, error: 'no_tokens' };
  const docs = filterDocs(readCache(cache), { site, lang });
  if (!docs.length) return { ok: false, error: 'empty_index' };
  const scored = docs.map(d => ({ d, s: scoreDoc(d, qTokens) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, num);
  if (!scored.length) return { ok: false, error: 'no_results' };
  const results = scored.map((x, i) => ({
    rank: i + 1,
    title: x.d.title || '',
    url: x.d.url,
    snippet: makeSnippet(x.d.body || x.d.summary || '', qTokens),
    source: x.d.source || '',
    meta: { score: x.s, published_at: x.d.published_at || null },
  }));
  return { ok: true, results };
}

export default { searchCurated };

