# API — Chat & Completion

**Endpoints**
- `POST /chat` — non-streaming
- `POST /chat/stream` — SSE streaming
- `POST /complete` — code/text completion

**Headers**: `content-type: application/json`, optional `authorization`  
**Error model**: `{ "error": "message", "code": "..." }`

