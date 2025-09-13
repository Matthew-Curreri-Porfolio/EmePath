// gateway/routes/public.js
import * as prom from "prom-client";
import { warmupUseCase } from "../usecases/warmup.js";
import { getModels } from "../usecases/models.js";

export function registerPublic(app, deps) {
  const { log, getTimeoutMs } = deps;

  // Liveness
  app.get("/health", (_req, res) =>
    res.json({ ok: true, mock: process.env.MOCK || false, model: process.env.MODEL || null, ollama: Boolean(process.env.LLAMACPP_SERVER), timeoutMs: getTimeoutMs(), pid: process.pid })
  );

  // Readiness (llama.cpp server if configured)
  app.get("/ready", async (_req, res) => {
    const base = String(process.env.LLAMACPP_SERVER || "").replace(/\/$/, "");
    if (!base) {
      return res.status(200).json({ ok: true, upstream: "llama.cpp-cli", status: 200 });
    }
    try {
      const r = await fetch(`${base}/v1/models`, {
        method: "GET",
        headers: {},
        signal: AbortSignal.timeout(3000),
      });
      return res.status(r.ok ? 200 : 503).json({ ok: r.ok, upstream: "llama.cpp-server", status: r.status });
    } catch (e) {
      return res.status(503).json({ ok: false, error: (e && e.message) || String(e) });
    }
  });

  // Metrics scrape
  app.get("/metrics", async (_req, res) => {
    res.set("Content-Type", prom.register.contentType);
    res.end(await prom.register.metrics());
  });

  // Warmup
  app.post("/warmup", async (req, res) => {
    await warmupUseCase(req, res, deps);
  });

  // Models
  app.get("/models", async (_req, res) => {
    const models = await getModels();
    res.json({ models });
  });
}

export default { registerPublic };
