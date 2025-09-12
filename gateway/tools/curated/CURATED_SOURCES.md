# Curated Knowledge Sources

High-signal, licensing-aware corpus for a focused, trustworthy search index. Each entry lists domains, preferred access, and licensing notes. Use this list together with `curated_sources.json` for machine-readable config.

## Core Reference
- Wikipedia / Wikidata
  - Domains: `wikipedia.org`, `wikidata.org`
  - Access: REST API, search API, page/rev API; dumps optional
  - License: CC BY-SA 3.0/4.0
- Wikisource / Wikibooks / Wikiquote / Simple Wikipedia
  - Domains: `wikisource.org`, `wikibooks.org`, `wikiquote.org`, `simple.wikipedia.org`
  - Access: MediaWiki API, dumps optional
  - License: CC BY-SA
- CIA World Factbook
  - Domain: `cia.gov/the-world-factbook`
  - Access: HTML, community mirrors
  - License: Public domain (US Gov)

## Science & Medicine
- arXiv
  - Domain: `arxiv.org`
  - Access: Atom API, OAI-PMH
  - License: varies; abstracts OK, per-paper license governs full text
- PubMed / PubMed Central (PMC)
  - Domains: `ncbi.nlm.nih.gov/pubmed`, `ncbi.nlm.nih.gov/pmc`
  - Access: E-utilities API, PMC OA bulk
  - License: abstracts PD-like; PMC OA subset has per-article licenses
- PLOS
  - Domain: `plos.org`, `journals.plos.org`
  - Access: RSS/API
  - License: CC BY
- eLife
  - Domain: `elifesciences.org`
  - Access: RSS/API
  - License: CC BY
- Europe PMC
  - Domain: `europepmc.org`
  - Access: REST API
  - License: metadata open; full-text per license
- NASA ADS
  - Domain: `ui.adsabs.harvard.edu`
  - Access: API (metadata/links)
  - License: metadata open
- NIH/NCBI Bookshelf
  - Domain: `ncbi.nlm.nih.gov/books`
  - Access: HTML/XML
  - License: varies, many CC
- WHO / CDC / NHS (guidance)
  - Domains: `who.int`, `cdc.gov`, `nhs.uk`
  - Access: RSS/sitemaps
  - License: WHO CC BY-NC-SA IGO; CDC PD; NHS OGL

## Education & Transcripts
- Khan Academy
  - Domain: `khanacademy.org`
  - Access: APIs/exports
  - License: CC BY-NC-SA
- MIT OpenCourseWare
  - Domain: `ocw.mit.edu`
  - Access: sitemaps, HTML
  - License: CC BY-NC-SA
- OpenStax
  - Domain: `openstax.org`
  - Access: downloads/RSS
  - License: CC BY
- Project Gutenberg (PD books)
  - Domain: `gutenberg.org`
  - Access: catalogs/mirrors
  - License: Public domain (most works)
- Educational YouTube channels (transcripts via API)
  - Channels: Veritasium, 3Blue1Brown, Numberphile, Computerphile, SmarterEveryDay, CrashCourse, SciShow, Kurzgesagt, PBS Space Time, MinutePhysics
  - Access: YouTube Data API + transcript libraries
  - License: standard YouTube licenses; store transcripts with attribution and adhere to TOS

## Software & Web Docs
- MDN Web Docs
  - Domain: `developer.mozilla.org`
  - Access: sitemaps/HTTP, content APIs
  - License: CC BY-SA
- W3C / WHATWG (standards)
  - Domains: `www.w3.org/TR`, `html.spec.whatwg.org`
  - Access: sitemaps/HTML
  - License: open docs
- IETF RFCs
  - Domains: `ietf.org`, `rfc-editor.org`
  - Access: text/HTML indexes
  - License: IETF Trust; reproduction permitted with notices
- Official language docs
  - Python (`docs.python.org`), Node.js (`nodejs.org`), Go (`go.dev`), Rust (`doc.rust-lang.org`), Java (`docs.oracle.com`), .NET (`learn.microsoft.com`)
  - Access: sitemaps/HTML; some JSON indices
  - License: site-specific; generally permissive for documentation reuse
- Linux/Unix resources
  - Domains: `man7.org`, `gnu.org/doc`, `wiki.archlinux.org`, `debian.org/doc`
  - Access: sitemaps/HTML
  - License: varies; ArchWiki CC BY-SA

## How‑To & Practical
- wikiHow
  - Domain: `wikihow.com`
  - Access: sitemaps/HTML
  - License: CC BY-NC-SA (non-commercial)
- Stack Exchange network
  - Domains: `stackexchange.com` (e.g., `stackoverflow.com`, `math.stackexchange.com`)
  - Access: Stack Exchange API
  - License: CC BY-SA 4.0 (attribution required)

## Government, Law & Policy
- govinfo.gov / Federal Register / CFR
  - Domains: `govinfo.gov`, `federalregister.gov`, `ecfr.gov`
  - Access: APIs
  - License: Public domain
- Congress.gov
  - Domain: `congress.gov`
  - Access: APIs/HTML
  - License: Public domain (government works)
- Cornell LII
  - Domain: `law.cornell.edu`
  - Access: HTML
  - License: permissive for excerpts with attribution
- Data portals
  - Domains: `data.gov`, `census.gov`
  - Access: APIs/bulk
  - License: PD/Open

## Data & Statistics
- World Bank Open Data
  - Domain: `data.worldbank.org`, `api.worldbank.org`
  - Access: REST API
  - License: CC BY 4.0
- OECD Data
  - Domain: `stats.oecd.org`
  - Access: APIs
  - License: varies; many CC BY
- Our World in Data
  - Domain: `ourworldindata.org`
  - Access: GitHub/CSV + site
  - License: CC BY 4.0
- UN/UNESCO data
  - Domains: `data.un.org`, `uis.unesco.org`
  - Access: APIs
  - License: varies

## Math & Logic
- ProofWiki
  - Domain: `proofwiki.org`
  - Access: HTML
  - License: CC BY-SA
- PlanetMath (archive)
  - Domain: `planetmath.org`
  - Access: HTML
  - License: CC BY-SA

---

Notes
- Favor APIs and sitemaps over raw crawling for stability and politeness.
- Track per-document license and attribution metadata for downstream display/compliance.
- For Stack Exchange, store author, post id, and link to satisfy CC BY-SA attribution.

## Engineering Repos (Python/JS heavy)

The following open-source repositories are strong examples for patterns, docs, tests, CI, and contributor health. Use them as reference implementations and, where useful, as curated content for software topics.

### Python-forward
- `python/cpython` — Python interpreter + stdlib
- `pypa/pip` — Python package installer (packaging best practices)
- `tiangolo/fastapi` — modern web APIs (type hints, validation)
- `pallets/flask` — microframework design and extensions ecosystem
- `django/django` — batteries-included web framework, ORM, migrations
- `encode/httpx` — async HTTP client with solid API design
- `encode/starlette` — ASGI toolkit (middleware, lifespan)
- `psf/black` — opinionated formatting + stable CLI ergonomics
- `pytest-dev/pytest` — testing patterns, fixtures, plugins
- `pydantic/pydantic` — schema/validation, types and performance
- `uvicorn/uvicorn` — ASGI server; lifecycle, signals, perf basics
- `apache/airflow` — orchestration, DAG models, plugins
- `PrefectHQ/prefect` — modern workflow orchestration patterns
- `scrapy/scrapy` — robust crawling architecture
- `pandas-dev/pandas` — dataframes, IO, enhancement process

### JavaScript-forward
- `nodejs/node` — runtime, release lines, governance
- `facebook/react` — component model, RFCs, concurrent features
- `vercel/next.js` — full-stack app framework + DX
- `vuejs/core` — reactivity system and design docs
- `angular/angular` — structured monorepo, tooling integration
- `sveltejs/svelte` — compiler-driven UI patterns
- `expressjs/express` — minimal HTTP framework patterns
- `fastify/fastify` — performance-focused HTTP framework
- `nestjs/nest` — opinionated server framework with DI
- `vitejs/vite` — dev server/build tool ergonomics
- `webpack/webpack` — plugin architecture and loader ecosystem
- `babel/babel` — compiler pipeline, presets/plugins design
- `eslint/eslint` — pluggable linting architecture
- `prettier/prettier` — formatting and stability guarantees
- `jestjs/jest` — testing framework and watch mode UX

## Engineering Best Practices (Top 50)

1. Version control: small, atomic commits with clear messages.
2. Conventional commits or a consistent schema to automate changelogs.
3. Code reviews focused on correctness, clarity, and risk; avoid nitpicks via linters.
4. Enforce formatting (Black/Prettier) and linting (Flake8/Ruff/ESLint) in CI.
5. Maintain a fast test suite; split unit, integration, and e2e tiers.
6. Require tests for bug fixes and new features; aim for meaningful coverage.
7. Favor typed interfaces: Python type hints + MyPy; TypeScript or JSDoc types.
8. Validate inputs with schemas (Pydantic/Zod/JSON Schema) at boundaries.
9. Design for dependency injection; keep side effects at the edges.
10. Keep functions small, pure where possible; prefer explicit over implicit.
11. Separate domain, application, and infrastructure concerns (layered/hexagonal).
12. Use clear error handling: typed errors, context, and remediation hints.
13. Log with structure (JSON) and levels; avoid logging secrets or PII.
14. Add request IDs/correlation IDs; propagate through async hops.
15. Measure with metrics (RED/USE) and traces; budget SLOs and error budgets.
16. Feature flags for safe rollout; decouple deploy from release.
17. Idempotent handlers for retries; safe to rerun on failure.
18. Backoff + jitter for external calls; circuit breakers where appropriate.
19. Timeouts everywhere: network, DB, queues, and background jobs.
20. Validate and sanitize all untrusted inputs; encode on output (XSS/SQLi).
21. Least privilege for tokens/roles; short-lived creds; rotate automatically.
22. Store secrets outside code (env/secret manager); never in VCS.
23. Keep dependencies minimal; watch for known vulns (Dependabot/Snyk).
24. Pin versions and use lockfiles (pip-tools/poetry lock/pnpm-lock.yaml).
25. Build reproducibly (containers), immutable artifacts, SBOMs if feasible.
26. Enforce supply-chain checks: signed commits/tags; verify provenance.
27. Migrations: forward-only, reversible scripts; test on prod-like data.
28. Data modeling: stable IDs, explicit nullability, documented constraints.
29. API design: versioned, documented, consistent error shapes.
30. Pagination/limits for list APIs; avoid unbounded responses.
31. Caching with explicit TTLs and invalidation strategies; cache keys documented.
32. Rate limiting and abuse protection at edges; per-user/app keys.
33. Concurrency: avoid shared mutable state; use queues for cross-service work.
34. Graceful shutdown: handle signals, drain requests, close resources.
35. Health checks: liveness vs readiness; fail fast if dependencies down.
36. Configuration via env; 12‑factor alignment; no env-dependent logic in code paths.
37. Keep dev/prod parity; docker-compose or Tilt for local stacks.
38. Observability baked-in: RED dashboards per service before launch.
39. Document runbooks for common incidents; practice game days.
40. Security reviews for threat models; track findings to closure.
41. Privacy by design: data minimization, retention/TTL, deletion tooling.
42. Internationalization readiness: UTF‑8 everywhere; locale-aware formatting.
43. Frontend performance: code-splitting, prefetch hints, image optimization.
44. Backend performance: profile hot paths; prefer O(n) over premature micro‑opts.
45. Queues and jobs: retries with DLQs; visibility timeouts configured.
46. Testing pyramid in JS: unit (Jest/Vitest) > component (RTL) > e2e (Cypress/Playwright).
47. Python testing: pytest fixtures/factories; avoid global state; freeze time in tests.
48. Documentation: README, architecture decision records (ADRs), API refs, examples.
49. CI/CD: fast feedback (<10 min), parallelization, flaky test quarantine.
50. Governance: CODEOWNERS, CONTRIBUTING, issue templates, CoC; automate triage.
