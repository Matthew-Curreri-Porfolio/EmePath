#!/usr/bin/env bash
set -euo pipefail

ROOT="$(pwd)"
ROUTES_DIR="$ROOT/gateway/routes"
IDX="$ROUTES_DIR/index.js"
BACK="$IDX.bak.$(date +%Y%m%d-%H%M%S)"

echo "[*] creating gateway/routes/toolcall.js"
cat > "$ROUTES_DIR/toolcall.js" <<'JS'
// gateway/routes/toolcall.js
// Minimal Tool Call Block dispatcher for the copilot.
// Single endpoint: POST /toolcall
// Body shape:
// Example:
// { "tool":"warmup","method":"POST","endpoint":"/warmup","body":{ "name":"qwen3-7b","model_path":"unsloth/Qwen2.5-7B" } }

export function registerToolCall(app /*, deps */) {
  app.post("/toolcall", async (req, res) => {
    try {
      const data = req.body || {};
      const method = String(data.method || "GET").toUpperCase();
      const endpoint = String(data.endpoint || "");

      if (!endpoint || !endpoint.startsWith("/")) {
        return res.status(400).json({ ok:false, error:"endpoint must start with '/'" });
      }
      if (!["GET","POST","DELETE"].includes(method)) {
        return res.status(400).json({ ok:false, error:"method must be GET|POST|DELETE" });
      }

      // Build URL against THIS gateway (no external calls)
      const port = Number(process.env.PORT || process.env.GATEWAY_PORT || 3123);
      const base = `http://127.0.0.1:${port}`;
      const url = new URL(endpoint, base);

      const params = data.params && typeof data.params === 'object' ? data.params : undefined;
      if (params && method === "GET") {
        for (const [k,v] of Object.entries(params)) url.searchParams.append(k, String(v));
      }

      const init = {
        method,
        headers: { "content-type":"application/json" },
        signal: AbortSignal.timeout(20000)
      };
      if (method !== "GET") init.body = JSON.stringify(data.body || {});

      const r = await fetch(url, init);
      const text = await r.text();
      let payload;
      try { payload = JSON.parse(text); } catch { payload = { raw:text }; }

      return res.status(r.ok ? 200 : 502).json({
        ok: r.ok,
        status: r.status,
        tool: data.tool || null,
        method,
        endpoint,
        forwarded: true,
        result: payload
      });
    } catch (e) {
      return res.status(500).json({ ok:false, error: String(e && e.message || e) });
    }
  });
}

export default { registerToolCall };
JS

echo "[*] backing up $IDX -> $BACK"
cp -f "$IDX" "$BACK"

echo "[*] wiring registerToolCall into routes/index.js"
# Add import if missing
grep -q "registerToolCall" "$IDX" || \
sed -i '1i import { registerToolCall } from "./toolcall.js";' "$IDX"

# Add registration call (once) inside exported function
grep -q "registerToolCall(app, deps);" "$IDX" || \
sed -i 's/registerAgentic(app, deps[^)]*);/registerAgentic(app, deps, { chatLimiter, searchLimiter, researchLimiter, answerLimiter, insightsLimiter, graphLimiter, debateLimiter, planLimiter, trainLimiter, forecastLimiter, compressLimiter });\n\n  \/\/ Tool Call dispatcher\n  registerToolCall(app, deps);/' "$IDX"

echo "[ok] toolcall endpoint added. restart the gateway."
