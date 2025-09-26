# Architecture — Overview

- **Gateway**: HTTP/SSE, auth, rate limiters, observability hooks  
- **Model Runtimes**: CPU/GPU backends; one base loaded once; N adapters resident  
- **Routing**: per-adapter selection; policy-driven; A/B toggles  
- **Storage**: logs, traces, eval artifacts, run metadata

