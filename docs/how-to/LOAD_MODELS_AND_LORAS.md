# How-to — Load Base Models and LoRA Adapters

**Outcome:** Base weights resident once; N adapters hot-selectable.

- Place models under `models/base/` and adapters under `models/loras/`
- Use the gateway `/load_model` endpoint or CLI
- Verify memory and adapter routing via `/models` and `/models/{name}/loras`
- Add health checks and per-adapter smoke tests

