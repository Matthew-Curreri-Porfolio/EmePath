// Ingest selected curated sources into a local JSONL cache.
// Examples:
//  node gateway/tools/curated/ingest/run_ingest.mjs --wikipedia-page "Python_(programming_language)" --out gateway/tools/curated/cache/docs.jsonl
//  node gateway/tools/curated/ingest/run_ingest.mjs --mdn --limit 20 --out gateway/tools/curated/cache/docs.jsonl

import { writeJsonl, hashId } from './util.mjs';
import { fetchByTitle as wikiFetchByTitle } from '../adapters/wikipedia.mjs';
import { fetchFromSitemap as mdnFetch } from '../adapters/mdn.mjs';
import { fetchArxiv } from '../adapters/arxiv.mjs';
import { fetchPubMed } from '../adapters/pubmed.mjs';

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    out: 'gateway/tools/curated/cache/docs.jsonl',
    limit: 20,
    pages: [],
    arxiv: null,
    pubmed: null,
    seeds: null,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--out') out.out = args[++i];
    else if (a === '--limit') out.limit = Number(args[++i] || '20');
    else if (a === '--wikipedia-page') out.pages.push(args[++i]);
    else if (a === '--mdn') out.mdn = true;
    else if (a === '--arxiv') out.arxiv = args[++i];
    else if (a === '--pubmed') out.pubmed = args[++i];
    else if (a === '--seeds')
      out.seeds = args[++i] || 'gateway/tools/curated/seeds.json';
  }
  return out;
}

async function main() {
  const opts = parseArgs();
  const docs = [];
  const seen = new Set();
  const add = (d) => {
    if (!d || !d.url) return;
    const key = `${d.source}|${d.url}`;
    if (seen.has(key)) return;
    seen.add(key);
    docs.push(d);
  };
  // Wikipedia pages by title
  for (const p of opts.pages) {
    try {
      const d = await wikiFetchByTitle(p, { lang: 'en' });
      // ensure stable id
      d.id = `wikipedia:${hashId(d.url)}`;
      add(d);
      console.log('wiki:', d.title);
    } catch (e) {
      console.error('wiki error', p, e?.message || e);
    }
  }
  // MDN subset
  if (opts.mdn) {
    try {
      const mdnDocs = await mdnFetch({ limit: opts.limit });
      for (const d of mdnDocs) {
        d.id = `mdn:${hashId(d.url)}`;
        add(d);
      }
      console.log('mdn:', mdnDocs.length, 'docs');
    } catch (e) {
      console.error('mdn error', e?.message || e);
    }
  }

  // arXiv abstracts
  if (opts.arxiv) {
    try {
      const av = await fetchArxiv({ query: opts.arxiv, max: opts.limit });
      for (const d of av) {
        d.id = `arxiv:${hashId(d.url)}`;
        add(d);
      }
      console.log('arxiv:', av.length, 'docs for', opts.arxiv);
    } catch (e) {
      console.error('arxiv error', e?.message || e);
    }
  }

  // PubMed abstracts
  if (opts.pubmed) {
    try {
      const pv = await fetchPubMed({ query: opts.pubmed, max: opts.limit });
      for (const d of pv) {
        d.id = `pubmed:${hashId(d.url)}`;
        add(d);
      }
      console.log('pubmed:', pv.length, 'docs for', opts.pubmed);
    } catch (e) {
      console.error('pubmed error', e?.message || e);
    }
  }

  // Seeds file (batch ingestion)
  if (opts.seeds) {
    try {
      const fs = await import('fs');
      const path = opts.seeds;
      const raw = fs.readFileSync(path, 'utf8');
      const seeds = JSON.parse(raw);
      if (seeds?.wikipedia?.pages) {
        for (const p of seeds.wikipedia.pages) {
          try {
            const d = await wikiFetchByTitle(p, {
              lang: seeds.wikipedia.lang || 'en',
            });
            d.id = `wikipedia:${hashId(d.url)}`;
            add(d);
          } catch (e) {
            console.error('seed wiki error', p, e?.message || e);
          }
        }
        console.log('wiki seeds:', seeds.wikipedia.pages.length);
      }
      if (seeds?.mdn?.limit) {
        try {
          const mdnDocs = await mdnFetch({ limit: seeds.mdn.limit });
          for (const d of mdnDocs) {
            d.id = `mdn:${hashId(d.url)}`;
            add(d);
          }
          console.log('mdn seeds:', mdnDocs.length);
        } catch (e) {
          console.error('seed mdn error', e?.message || e);
        }
      }
      if (Array.isArray(seeds?.arxiv)) {
        for (const a of seeds.arxiv) {
          try {
            const av = await fetchArxiv({ query: a.query, max: a.limit || 10 });
            for (const d of av) {
              d.id = `arxiv:${hashId(d.url)}`;
              add(d);
            }
            console.log('arxiv seeds:', av.length, a.query);
          } catch (e) {
            console.error('seed arxiv error', a?.query, e?.message || e);
          }
        }
      }
      if (Array.isArray(seeds?.pubmed)) {
        for (const p of seeds.pubmed) {
          try {
            const pv = await fetchPubMed({
              query: p.query,
              max: p.limit || 10,
            });
            for (const d of pv) {
              d.id = `pubmed:${hashId(d.url)}`;
              add(d);
            }
            console.log('pubmed seeds:', pv.length, p.query);
          } catch (e) {
            console.error('seed pubmed error', p?.query, e?.message || e);
          }
        }
      }
    } catch (e) {
      console.error('seeds error', e?.message || e);
    }
  }

  // Write JSONL
  if (!docs.length) {
    console.error('No documents ingested.');
    process.exit(1);
  }
  for (const d of docs) writeJsonl(opts.out, d);
  console.log('Wrote', docs.length, 'documents to', opts.out);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
