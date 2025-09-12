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
    .replace(/<\/?b>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTags(html) {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, ' '));
}

async function searchWhoogle(query, { base, num = 5, signal } = {}) {
  const whoogleBase = base || process.env.WHOOGLE_BASE || 'http://127.0.0.1:5010';
  const params = new URLSearchParams({ q: query, num: String(num), safe: 'off', hl: 'en' });
  const url = `${whoogleBase.replace(/\/$/, '')}/search?${params.toString()}`;
  let res;
  try {
    res = await fetch(url, {
      signal,
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  const html = await res.text();

  // Prefer the main results container if present
  const results = [];
  const startIdx = html.indexOf('<div id="s"');
  const searchArea = startIdx >= 0 ? html.slice(startIdx, startIdx + 200000) : html;

  const aRe = /<a[^>]*href=\"(https?:\/\/[^\"]+)\"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  let idx = 0;
  while ((m = aRe.exec(searchArea)) && results.length < num) {
    const href = m[1];
    const title = stripTags(m[2]);
    if (!href || /^https?:\/\/(127|localhost)/i.test(href)) continue;
    if (/google\.com\/maps|whoogle-search|github\.com/gi.test(href)) continue;
    const tailHtml = searchArea.slice(Math.max(0, aRe.lastIndex - 300), aRe.lastIndex + 300);
    const snipMatch = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(tailHtml) || /<div[^>]*class=[\"']?IsZvec[\"']?[^>]*>([\s\S]*?)<\/div>/i.exec(tailHtml);
    const snippet = stripTags(snipMatch ? snipMatch[1] : '');
    results.push({ rank: ++idx, title, url: href, snippet });
  }

  if (!results.length) {
    const redirectRe = /(?:href=\"|\()\/url\?q=([^&\"']+)/gi;
    let rm;
    const seen = new Set();
    while ((rm = redirectRe.exec(html)) && results.length < num) {
      try {
        const u = decodeURIComponent(rm[1]);
        if (!u || seen.has(u)) continue;
        seen.add(u);
        if (/^(https?:\/\/)?(127|localhost)/i.test(u)) continue;
        results.push({ rank: results.length + 1, title: '', url: u, snippet: '' });
      } catch (e) {
        continue;
      }
    }
  }

  if (!results.length) {
    return { ok: false, error: 'no_results' };
  }

  return { ok: true, results };
}

export { searchWhoogle };
export default searchWhoogle;