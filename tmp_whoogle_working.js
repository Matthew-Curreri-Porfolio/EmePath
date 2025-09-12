const { URLSearchParams } = require('node:url');

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
  const params = new URLSearchParams({ q: query, gbv: '1', safe: 'off' });
  const url = `${whoogleBase.replace(/\/$/, '')}/search?${params.toString()}`;
  let res;
  try {
    res = await fetch(url, { signal, redirect: 'follow' });
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  const html = await res.text();

  // Parse a few top results by looking for anchors with class "fuLhoc" (Whoogle result links)
  const results = [];
  const aRe = /<a[^>]*class=\"[^\"]*fuLhoc[^\"]*\"[^>]*href=\"([^\"]+)\"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  let idx = 0;
  while ((m = aRe.exec(html)) && results.length < num) {
    const href = m[1];
    const title = stripTags(m[2]);
    // Find a nearby snippet span following the anchor
    const tailHtml = html.slice(aRe.lastIndex, aRe.lastIndex + 2000);
    const snipMatch = /<span[^>]*class=\"[^\"]*fYyStc[^\"]*\"[^>]*>([\s\S]*?)<\/span>/i.exec(tailHtml);
    const snippet = stripTags(snipMatch ? snipMatch[1] : '');
    // Filter out internal navigation links (like search?...)
    if (/^search\?/.test(href)) continue;
    results.push({ rank: ++idx, title, url: href, snippet });
  }

  if (!results.length) {
    return { ok: false, error: 'no_results' };
  }

  return { ok: true, results };
}

module.exports = { searchWhoogle };

