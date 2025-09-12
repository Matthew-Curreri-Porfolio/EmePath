# Curated Search (Local Cache)

This directory contains a minimal curated search pipeline that fetches content from trusted sources, caches documents locally, and serves simple full‑text search via a small ranking function. It’s designed to be expanded incrementally.

Key pieces
- `ingest/` adapters: Pull content from sources (APIs/sitemaps), normalize, and write to a local JSONL cache.
- `search.mjs`: Loads the cache and performs ranked search (title/body weighting).
- `curated_sources.json`: Machine‑readable catalog for source config (expand as you go).

Quick start
- Seed a small cache:
  - Single Wikipedia page: `node gateway/tools/curated/ingest/run_ingest.mjs --wikipedia-page "Python_(programming_language)" --out gateway/tools/curated/cache/docs.jsonl`
  - MDN subset (first 20 pages from sitemap): `node gateway/tools/curated/ingest/run_ingest.mjs --mdn --limit 20 --out gateway/tools/curated/cache/docs.jsonl`
  - arXiv abstracts: `node gateway/tools/curated/ingest/run_ingest.mjs --arxiv "all:transformers" --limit 10 --out gateway/tools/curated/cache/docs.jsonl`
  - PubMed abstracts: `node gateway/tools/curated/ingest/run_ingest.mjs --pubmed "diabetes+type+2" --limit 10 --out gateway/tools/curated/cache/docs.jsonl`
  - Starter corpus (seeds file): `bash gateway/scripts/ingest_starter_curated.sh`
    - Uses `gateway/tools/curated/seeds.json`; override out path: `bash gateway/scripts/ingest_starter_curated.sh /abs/path/docs.jsonl`
- Search the cache:
  - `node gateway/scripts/test_curated_search.js "python list comprehension"`

Notes
- This is a minimal MVP. Add more adapters and integrate with `/research` once you’re happy with the dataset. See `NEXT_AGENT_OUTLINE.md` for a fuller plan.
- Each Document written has: id, url, source, title, body, published_at, lang, license, tags.
  - arXiv and PubMed adapters ingest abstracts plus lightweight metadata.
  - To use curated-first on the API: `export CURATED_MODE=1` and optionally `export CURATED_CACHE=/abs/path/docs.jsonl` then GET `/research`.
