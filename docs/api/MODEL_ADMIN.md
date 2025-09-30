# API — Model & Adapter Admin

- `POST /load_model` — load base + adapters
- `GET /models` — list loaded bases
- `GET /models/{name}/loras` — list adapters for a base
- `POST /inference` — select base+adapter and generate

Include idempotency keys for admin ops. Log adapter routing decisions.

