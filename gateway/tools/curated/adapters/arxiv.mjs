// arXiv adapter: fetch abstracts via Atom API

import { httpGet, stripTags } from '../ingest/util.mjs';
import { toDoc } from '../ingest/normalize.mjs';

function pickAll(re, s) { return Array.from(s.matchAll(re)).map(m => m[1]); }

export async function fetchArxiv({ query = 'all:machine+learning', max = 20 } = {}) {
  const maxResults = Math.min(Math.max(1, Number(max)||10), 50);
  const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(query)}&start=0&max_results=${maxResults}`;
  const res = await httpGet(url, { headers: { Accept: 'application/atom+xml' }, timeoutMs: 20000 });
  if (!res.ok) return [];
  const xml = res.text;
  const entries = xml.split(/<entry>/).slice(1).map(v => v.replace(/<\/entry>[\s\S]*$/, m=>''+v));
  const docs = [];
  for (const e of entries) {
    const id = (e.match(/<id>([^<]+)<\/id>/) || [,''])[1];
    const title = (e.match(/<title>([\s\S]*?)<\/title>/) || [,''])[1].replace(/\s+/g,' ').trim();
    const summary = (e.match(/<summary>([\s\S]*?)<\/summary>/) || [,''])[1].replace(/\s+/g,' ').trim();
    let link = (e.match(/<link[^>]*href="([^"]+)"[^>]*rel="alternate"[^>]*\/>/) || [,''])[1];
    if (!link) link = id;
    const published = (e.match(/<published>([^<]+)<\/published>/) || [,''])[1];
    const authors = pickAll(/<name>([^<]+)<\/name>/g, e);
    const body = [summary, authors.length?`Authors: ${authors.join(', ')}`:''].filter(Boolean).join('\n');
    docs.push(toDoc({ url: link, source: 'arxiv', title, text: body, summary, published_at: published, lang: 'en', license: 'varies', tags: ['science','arxiv'] }));
  }
  return docs;
}

export default { fetchArxiv };

