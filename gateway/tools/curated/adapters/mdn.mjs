// Minimal MDN adapter: scan sitemap and fetch a small subset of pages.

import { httpGet, stripTags } from '../ingest/util.mjs';
import { toDoc } from '../ingest/normalize.mjs';

export async function fetchFromSitemap({ limit = 20 } = {}) {
  const sm = await httpGet('https://developer.mozilla.org/sitemaps.xml', {
    headers: { Accept: 'application/xml' },
  });
  if (!sm.ok) return [];
  const urls = Array.from(sm.text.matchAll(/<loc>([^<]+)<\/loc>/g))
    .map((m) => m[1])
    .filter((u) => /developer\.mozilla\.org\//.test(u));
  const pick = urls.slice(0, limit);
  const docs = [];
  for (const url of pick) {
    const res = await httpGet(url, { headers: { Accept: 'text/html' } });
    if (!res.ok) continue;
    const html = res.text;
    const title = (html.match(/<title>([^<]*)<\/title>/i) || [, ''])[1]
      .replace(/\s+\|\s*MDN Web Docs.*/i, '')
      .trim();
    const text = stripTags(html);
    docs.push(
      toDoc({
        url,
        source: 'mdn',
        title,
        html,
        text,
        lang: 'en',
        license: 'CC BY-SA',
        tags: ['docs', 'web'],
      })
    );
  }
  return docs;
}

export default { fetchFromSitemap };
