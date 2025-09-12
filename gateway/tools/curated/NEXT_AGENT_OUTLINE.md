# Curated Search: Next-Agent Outline

Purpose: Implement a curated corpus ingestion + search pipeline, integrate with `/research`, and keep Whoogle as a fallback for long tail.

## Goals (MVP)
- Ingest 8–10 high-signal sources via APIs/sitemaps (no broad crawling).
- Normalize documents (title/url/source/date/license/lang/body/tags).
- Index into OpenSearch/Elasticsearch with BM25 and field boosts.
- Expose `searchCurated` and wire into `/research` with optional Whoogle fallback.
- Add basic metrics and daily refresh jobs.

## Deliverables
- `curated_sources.json` (catalog + fetch params + license)
- Source adapters (fetch + parse + normalize)
- Ingestion runner (incremental; ETag/Last-Modified; backoff)
- Index mapping + indexing utility
- Gateway integration: curated-first, Whoogle fallback
- Docs: runbook + metrics dashboard link

## Directory Layout (to create)
```
gateway/tools/curated/
  curated_sources.json          # machine-readable catalog (create/update)
  adapters/                     # per-source adapters
    wikipedia.mjs
    wikidata.mjs
    mdn.mjs
    arxiv.mjs
    pubmed.mjs
    stackexchange.mjs
    plos.mjs
    worldbank.mjs
  ingest/
    run_ingest.mjs              # orchestrates ingestion for enabled sources
    util.mjs                    # HTTP, rate-limit, ETag
    normalize.mjs               # common text cleaning
  index/
    mapping.json                # index mapping/settings
    indexer.mjs                 # bulk index/upsert
  README.md
```

## Data Contracts
- Document (indexed):
  - `id` (stable), `url`, `source`, `title`, `body` (cleaned text), `summary` (optional), `published_at` (ISO), `lang`, `license`, `tags` (array), `meta` (object)
- Source config (from `curated_sources.json`):
  - `id`, `name`, `domains`, `category`, `license`, `access` { `method`: api|rss|sitemap|html, `endpoints`: [], `headers`: {}, `params`: {} }, `cadence`, `enabled`

## Adapter Interface (per-source)
```js
export async function discover(config, since) { /* yield URLs or items */ }
export async function fetchItem(item, helpers) { /* HTTP/API request */ }
export function parseToDoc(payload, config) { /* return normalized Document */ }
// Optional: rateLimit, canonicalizeUrl, extractLicense
```

## Index Mapping (OpenSearch/Elasticsearch)
- Analyzer: standard + language-specific where applicable
- Fields:
  - `title` (text, boosted), `body` (text), `source` (keyword), `url` (keyword), `license` (keyword), `lang` (keyword), `published_at` (date), `tags` (keyword)
- Settings: BM25, `index.max_result_window` tuned as needed

## Ranking Defaults
- Query-time boosts: `title^3 body^1.0`
- Source weight: priority boost (e.g., NIH > Wikipedia > wikiHow)
- Freshness decay: optional recency boost on `published_at`

## Integration Plan
1) Add `searchCurated(query, { num, lang, site, fresh })` in `gateway/tools/curated/search.mjs`.
2) Wire `/research` to call curated first; fallback to Whoogle when curated < N results.
3) ENV toggles:
   - `CURATED_MODE=1` (prefer curated first)
   - `WHOOGLE_FALLBACK=1` (allow fallback)
   - `CURATED_INDEX_URL` (OpenSearch endpoint)

## Ingestion Strategy
- Discovery preference: APIs > RSS/Atom > sitemaps > HTML
- Freshness: use `since` timestamps; ETag/Last-Modified
- Politeness: per-host rate limit + retries/backoff
- Dedupe: URL canonicalization + SimHash (optional MVP+)

## Monitoring & Ops
- Metrics: per-source success rate, ingest latency, items/day, failures
- Alerts: sustained failures per source, high 5xx, index errors
- Dashboards: Prometheus/Grafana (or lightweight logs metrics)

## Legal/Compliance
- Store `license` and required attribution fields
- Stack Exchange: keep author + URL for CC BY-SA attribution
- Respect robots/API TOS; prefer official APIs

## Milestones
- Week 1: adapters for Wikipedia, MDN, arXiv (abstracts), PubMed (abstracts), Stack Exchange; index mapping; `searchCurated` wired in
- Week 2: PLOS, eLife, World Bank, OpenStax, ProofWiki; ranking tuning, metrics, nightly ingest

## Quick Start (expected workflow)
1) Finalize `curated_sources.json`
2) Implement 3–4 adapters (see stubs)
3) Run `ingest/run_ingest.mjs` to produce Documents → `index/indexer.mjs`
4) Validate search quality with a small eval set
5) Flip `CURATED_MODE=1` in gateway and test `/research`

