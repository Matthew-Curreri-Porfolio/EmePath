import { URLSearchParams } from 'node:url';

function decodeEntities(str) {
  if (!str) return '';
  return str
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export async function searchSearxng(
  query,
  {
    base,
    num = 5,
    site,
    lang = 'en',
    safe = false,
    fresh,
    signal,
    timeoutMs = 8000,
  } = {}
) {
  const searxBase = (
    base ||
    process.env.SEARXNG_BASE ||
    'http://127.0.0.1:8888'
  ).replace(/\/$/, '');
  const q = site ? `${query} site:${site}` : query;
  const params = new URLSearchParams({ q, format: 'json' });
  // SearXNG: language -> "language" or "lang"; prefer "language"
  if (lang) params.set('language', lang);
  // Safe search levels: 0(off), 1(moderate), 2(strict)
  params.set('safesearch', safe ? '1' : '0');
  // Freshness mapping: h,d,w,m,y -> day/week/month/year
  if (fresh) {
    const map = { h: 'day', d: 'day', w: 'week', m: 'month', y: 'year' };
    const tr = map[String(fresh)] || '';
    if (tr) params.set('time_range', tr);
  }
  // Limit
  if (num) params.set('results', String(num));

  const url = `${searxBase}/search?${params.toString()}`;
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(),
    Math.max(1000, Number(timeoutMs) || 8000)
  );
  try {
    const res = await fetch(url, {
      signal: signal || ctrl.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json().catch(() => ({}));
    const arr = Array.isArray(data?.results) ? data.results : [];
    const results = arr
      .slice(0, num)
      .map((r, i) => ({
        rank: i + 1,
        title: decodeEntities(String(r.title || '')),
        url: r.url || r.href || '',
        snippet: decodeEntities(String(r.content || r.snippet || '')),
      }))
      .filter((r) => r.url);
    if (!results.length) return { ok: false, error: 'no_results' };
    return { ok: true, results };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

export default searchSearxng;
