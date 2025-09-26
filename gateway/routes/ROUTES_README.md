Public, Private, and Agentic Routes

Overview

- Public: unauthenticated health/ready/metrics/models and warmup.
- Private: authenticated user endpoints (auth login entry, memory CRUD).
- Agentic: LLM/insights/research/curated/planning/training/forecast/runtime/optimize.

Modules

- routes/public.js
  - GET `/health`, `/ready`, `/metrics`, `/models`
  - POST `/warmup`
- routes/private.js
  - POST `/auth/login`
  - GET/POST/DELETE `/memory/short`, `/memory/short/:memid`
  - GET/POST/DELETE `/memory/long`, `/memory/long/:memid`
- routes/agentic.js
  - POST `/complete`, `/chat`, `/chat/stream`
  - POST `/scan`, `/query`
  - POST `/optimize/hw/run`, GET `/optimize/hw`
  - GET `/curated`, `/research`, `/insights/graph`
  - POST `/plan`, `/train/loop`, `/forecast/seed`

Conventions

- Keep rate limiters defined in `routes/index.js` and pass them to modules as needed.
- All validation schemas live in `validation/schemas.js` and are applied in modules.
- Prefer env-based configuration for upstreams like `SEARXNG_BASE`, `CURATED_MODE`, `CURATED_CACHE`.

Wiring

- `routes/index.js` handles common middleware, request metrics, limiters, then calls:
  - `registerPublic(app, deps)`
  - `registerPrivate(app, deps, { memoryLimiter })`
  - `registerAgentic(app, deps, { ...limiters })`

Notes

- If adding new endpoints, place them in the appropriate module and keep this file in sync.
- Avoid adding route handlers directly in `routes/index.js` beyond module registration.
