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

async function searchWhoogle(
  query,
  { base, num = 5, site, lang = 'en', safe = false, fresh, signal } = {}
) {
  const whoogleBase = base || process.env.WHOOGLE_BASE || 'http://127.0.0.1:5010';
  const q = site ? `${query} site:${site}` : query;
  const params = new URLSearchParams({ q, num: String(num), hl: String(lang), gbv: '1' });
  // Safe search: 'active' | 'off'
  params.set('safe', safe ? 'active' : 'off');
  // Freshness window: h/d/w/m/y -> qdr param
  if (fresh && ['h','d','w','m','y'].includes(fresh)) params.set('tbs', `qdr:${fresh}`);
  const url = `${whoogleBase.replace(/\/$/, '')}/search?${params.toString()}`;
  let res;
  try {
    // Use a modern browser UA and Accept-Language to avoid Whoogle/Google serving
    // an unsupported/bot page that doesn't contain server-side results.
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

  // Try to focus parsing on the main results container if present (Whoogle uses
  // <div id="s"> for results), otherwise parse the full HTML.
  const results = [];
  const startIdx = html.indexOf('<div id="s"');
  const searchArea = startIdx >= 0 ? html.slice(startIdx, startIdx + 200000) : html;

  // Find external anchors in the search area. We avoid requiring specific
  // Google classnames because Whoogle/Google may change them or render results
  // client-side. This is a pragmatic fallback: capture anchors with http(s)
  // hrefs and filter out internal links.
  const aRe = /<a[^>]*href=\"(https?:\/\/[^\"]+)\"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  let idx = 0;
  while ((m = aRe.exec(searchArea)) && results.length < num) {
    const href = m[1];
    const title = stripTags(m[2]);
    if (!href || /^https?:\/\/(127|localhost|localhost:|127.0.0.1)/i.test(href)) continue;
    // Filter out obvious non-result links
    if (/google\.com\/maps|whoogle-search|github\.com/gi.test(href)) continue;
    if (/^https?:\/\/([^.]+\.)*google\./i.test(href)) continue;

    // Try to capture a short nearby snippet (within the next 300 chars)
    const tailHtml = searchArea.slice(Math.max(0, aRe.lastIndex - 300), aRe.lastIndex + 300);
    const snipMatch = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(tailHtml) || /<div[^>]*class=[\"']?IsZvec[\"']?[^>]*>([\s\S]*?)<\/div>/i.exec(tailHtml);
    const snippet = stripTags(snipMatch ? snipMatch[1] : '');
    results.push({ rank: ++idx, title, url: href, snippet });
  }

  // Fallback: When gbv=1 layout is used, some Whoogle builds render result
  // anchors with class "fuLhoc". Try to capture those if we still have none.
  if (!results.length) {
    const whoogleStyle = /<a[^>]*class=\"[^\"]*fuLhoc[^\"]*\"[^>]*href=\"(https?:\/\/[^\"]+)\"[^>]*>([\s\S]*?)<\/a>/gi;
    let wm;
    while ((wm = whoogleStyle.exec(searchArea)) && results.length < num) {
      const href = wm[1];
      const title = stripTags(wm[2]);
      results.push({ rank: results.length + 1, title, url: href, snippet: '' });
    }
  }

  if (!results.length) {
    // Fallback: look for Google redirect links commonly seen in server-side
    // rendered responses (e.g., /url?q=https://example.com&amp;sa=...). This
    // helps when Whoogle includes Google's link structure instead of direct
    // absolute anchors.
    const redirectRe = /(?:href=\"|\()\/url\?q=([^&\"']+)/gi;
    let rm;
    const seen = new Set();
    while ((rm = redirectRe.exec(html)) && results.length < num) {
      try {
        const u = decodeURIComponent(rm[1]);
        if (!u || seen.has(u)) continue;
        seen.add(u);
        // Skip internal or obvious non-result links
        if (/^(https?:\/\/)?(127|localhost)/i.test(u)) continue;
        if (/^https?:\/\/([^.]+\.)*google\./i.test(u)) continue;
        results.push({ rank: results.length + 1, title: '', url: u, snippet: '' });
      } catch (e) {
        continue;
      }
    }
  }

  // Additional fallbacks for Whoogle-specific link rewriting patterns.
  // Some deployments rewrite result links as relative /search?… with an
  // encoded target in either `uddg` or (less commonly) `q`.
  if (!results.length) {
    const addIfValid = (u) => {
      try {
        const dec = decodeURIComponent(u);
        if (!/^https?:\/\//i.test(dec)) return;
        if (/(^|\.)localhost(:\d+)?\//i.test(dec)) return;
        if (/127\.0\.0\.1(:\d+)?\//.test(dec)) return;
        results.push({ rank: results.length + 1, title: '', url: dec, snippet: '' });
      } catch (_) { /* ignore */ }
    };

    // /search?…&uddg=https%3A%2F%2Fexample.com%2F…
    const uddgRe = /href=\"\/search\?[^\"]*?uddg=([^&\"']+)/gi;
    let um;
    while ((um = uddgRe.exec(html)) && results.length < num) addIfValid(um[1]);

    // /search?…&q=https%3A%2F%2Fexample.com%2F…
    if (results.length < num) {
      const qRe = /href=\"\/search\?[^\"]*?q=([^&\"']+)/gi;
      let qm;
      while ((qm = qRe.exec(html)) && results.length < num) addIfValid(qm[1]);
    }
  }

  // As a last resort, scan for data-url/data-href style attributes that some
  // templates embed on result cards.
  if (!results.length) {
    const dataAttrRe = /(data-url|data-href)=\"(https?:\/\/[^\"]+)\"/gi;
    let dm;
    while ((dm = dataAttrRe.exec(html)) && results.length < num) {
      const href = dm[2];
      if (!href) continue;
      if (/localhost|127\.0\.0\.1/.test(href)) continue;
      results.push({ rank: results.length + 1, title: '', url: href, snippet: '' });
    }
  }

  if (!results.length) {
    return { ok: false, error: 'no_results' };
  }

  return { ok: true, results };
}

export { searchWhoogle };
