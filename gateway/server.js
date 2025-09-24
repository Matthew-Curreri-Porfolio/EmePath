import express from "express";
import cors from "cors";
import { log, getTimeoutMs, escapeRe, scanDirectory } from "./utils.js";
import { OLLAMA, MODEL, MOCK, VERBOSE, LOG_BODY } from "./config.js";
import { getIndex, setIndex } from "./state.js";
import registerRoutes from "./routes/index.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "4mb" }));

// Register all routes
registerRoutes(app, {
  log,
  getTimeoutMs,
  escapeRe,
  scanDirectory,
  OLLAMA,
  MODEL,
  MOCK,
  VERBOSE,
  LOG_BODY,
  getIndex,
  setIndex,
});

const PORT = Number(process.env.GATEWAY_PORT || process.env.PORT || 3123);
app.listen(PORT, () => log({ event: "boot", msg: "gateway listening", url: `http://127.0.0.1:${PORT}` }));
const REQUIRED_KEY = process.env.GATEWAY_API_KEY || "";
app.use((req, res, next) => {
  if (!REQUIRED_KEY) return next(); // auth off by default
  const h = req.get("authorization") || "";
  if (h === `Bearer ${REQUIRED_KEY}`) return next();
  return res.status(401).json({ error: "unauthorized" });
});

// Optional: background auto-resolver for due forecasts
// Enable with: FORECAST_AUTORESOLVE=true
// Tuning: FORECAST_AUTORESOLVE_MS (default 6h), FORECAST_LIMIT, WHOOGLE_BASE, etc.
if (String(process.env.FORECAST_AUTORESOLVE).toLowerCase() === 'true') {
  const intervalMs = (() => {
    const n = Number(process.env.FORECAST_AUTORESOLVE_MS);
    return Number.isFinite(n) && n >= 300000 ? n : 6 * 60 * 60 * 1000; // min 5m, default 6h
  })();

  const tick = async () => {
    try {
      const { resolveDueForecasts } = await import("./tools/forecast.js");
      const limit = Number(process.env.FORECAST_LIMIT) || 50;
      const result = await resolveDueForecasts({
        limit,
        base: process.env.WHOOGLE_BASE,
        num: Number(process.env.FORECAST_NUM) || 6,
        fetchNum: Number(process.env.FORECAST_FETCH_NUM) || 4,
        concurrency: Number(process.env.FORECAST_CONCURRENCY) || 3,
        site: process.env.FORECAST_SITE,
        lang: process.env.FORECAST_LANG || 'en',
        safe: String(process.env.FORECAST_SAFE || '').toLowerCase() === 'true',
        fresh: process.env.FORECAST_FRESH,
      });
      log({ event: 'forecast_autoresolve', resolved: result?.resolved, sample: Array.isArray(result?.details) ? result.details.slice(0, 5) : [] });
    } catch (e) {
      log({ event: 'forecast_autoresolve_error', error: String(e && e.message || e) });
    }
  };

  setInterval(tick, intervalMs);
  // Optional immediate kick on boot
  if (String(process.env.FORECAST_AUTORESOLVE_ON_BOOT).toLowerCase() === 'true') {
    tick();
  }
}
