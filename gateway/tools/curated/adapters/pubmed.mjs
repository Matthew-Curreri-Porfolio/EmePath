// PubMed adapter: fetch PMIDs via esearch, fetch abstracts via efetch XML.

import { httpGet, stripTags } from '../ingest/util.mjs';
import { toDoc } from '../ingest/normalize.mjs';

export async function fetchPubMed({
  query = 'cancer',
  max = 20,
  apiKey = process.env.PUBMED_API_KEY,
} = {}) {
  const retmax = Math.min(Math.max(1, Number(max) || 10), 50);
  const base = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
  const k = apiKey ? `&api_key=${encodeURIComponent(apiKey)}` : '';
  const esearch = `${base}/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmax=${retmax}&retmode=json${k}`;
  const er = await httpGet(esearch, {
    headers: { Accept: 'application/json' },
    timeoutMs: 20000,
  });
  if (!er.ok) return [];
  let ids = [];
  try {
    ids = JSON.parse(er.text)?.esearchresult?.idlist || [];
  } catch {}
  if (!ids.length) return [];
  const idstr = ids.join(',');
  const efetch = `${base}/efetch.fcgi?db=pubmed&id=${idstr}&retmode=xml${k}`;
  const xr = await httpGet(efetch, {
    headers: { Accept: 'application/xml' },
    timeoutMs: 30000,
  });
  if (!xr.ok) return [];
  const xml = xr.text;
  const articles = xml
    .split(/<PubmedArticle>/)
    .slice(1)
    .map((b) => '<PubmedArticle>' + b);
  const docs = [];
  for (const a of articles) {
    const pmid = (a.match(/<PMID[^>]*>(\d+)<\/PMID>/) || [, ''])[1];
    const articleTitle = (a.match(
      /<ArticleTitle>([\s\S]*?)<\/ArticleTitle>/
    ) || [, ''])[1]
      .replace(/\s+/g, ' ')
      .trim();
    const abstract = (a.match(
      /<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/
    ) || [, ''])[1]
      .replace(/\s+/g, ' ')
      .trim();
    const journal = (a.match(/<Title>([\s\S]*?)<\/Title>/) || [, ''])[1]
      .replace(/\s+/g, ' ')
      .trim();
    const year = (a.match(
      /<PubDate>[\s\S]*?<Year>(\d{4})<\/Year>[\s\S]*?<\/PubDate>/
    ) || [, ''])[1];
    const url = pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : '';
    const text = [
      abstract,
      journal ? `Journal: ${journal}` : '',
      year ? `Year: ${year}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    docs.push(
      toDoc({
        url,
        source: 'pubmed',
        title: articleTitle || (pmid ? `PMID ${pmid}` : 'PubMed Article'),
        text,
        summary: abstract,
        published_at: year ? `${year}-01-01` : null,
        lang: 'en',
        license: 'varies',
        tags: ['medicine', 'pubmed'],
      })
    );
  }
  return docs;
}

export default { fetchPubMed };
