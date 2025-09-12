// Minimal Wikipedia adapter: fetch a page by title via REST API summary + HTML.

import { httpGet, stripTags } from '../ingest/util.mjs';
import { toDoc } from '../ingest/normalize.mjs';

export async function fetchByTitle(title, { lang = 'en', license = 'CC BY-SA' } = {}) {
  const enc = encodeURIComponent(title);
  const base = `https://${lang}.wikipedia.org`;
  const summaryUrl = `${base}/api/rest_v1/page/summary/${enc}`;
  const htmlUrl = `${base}/api/rest_v1/page/html/${enc}`;

  const [sRes, hRes] = await Promise.all([
    httpGet(summaryUrl, { headers: { Accept: 'application/json' } }),
    httpGet(htmlUrl, { headers: { Accept: 'text/html' } }),
  ]);

  const summary = (() => { try { return JSON.parse(sRes.text); } catch { return null; } })();
  const url = summary?.content_urls?.desktop?.page || `${base}/wiki/${enc}`;
  const titleOut = summary?.title || title;
  const extract = summary?.extract || '';
  const html = hRes?.text || '';
  const text = stripTags(html);

  return toDoc({
    url,
    source: 'wikipedia',
    title: titleOut,
    html,
    text,
    summary: extract,
    published_at: summary?.timestamp || null,
    lang,
    license,
    tags: ['encyclopedia'],
  });
}

export default { fetchByTitle };

