import express from "express";
import cors from "cors";
import { log, getTimeoutMs, escapeRe, scanDirectory, makeSnippets } from "./utils.js";
import { OLLAMA, MODEL, MOCK, VERBOSE, LOG_BODY } from "./config.js";
import { getIndex, setIndex } from "./state.js";
import registerRoutes from "./routes/index.js";
import { getConfig } from "./config/index.js";
import { requestLogger } from "./middleware/logger.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "4mb" }));
// Import custom logger middleware
app.use(requestLogger);

// --- Begin custom logging middleware ---
app.use((req, res, next) => {
  const silent = process.env.LOG_SILENT === "1" || process.env.LOG_SILENT === "true";
  if (silent) return next();
  const start = Date.now();
  const { method, url, headers } = req;
  const body = process.env.LOG_BODY === "1" || process.env.LOG_BODY === "true" ? req.body : undefined;
  res.on("finish", () => {
    const duration = Date.now() - start;
    log({
      event: "http_request",
      method,
      url,
      status: res.statusCode,
      duration,
      headers,
      body,
      ts: new Date().toISOString()
    });
  });
  next();
});
// --- End custom logging middleware ---

// Register all routes
registerRoutes(app, {
  log,
  getTimeoutMs,
  escapeRe,
  scanDirectory,
  makeSnippets,
  OLLAMA,
  MODEL,
  MOCK,
  VERBOSE,
  LOG_BODY,
  getIndex,
  setIndex,
});

const CFG = getConfig();
// Backfill env vars for downstream code that reads from process.env
if (!process.env.SEARXNG_BASE) process.env.SEARXNG_BASE = CFG.searxng.base;
if (!process.env.GATEWAY_PORT) process.env.GATEWAY_PORT = String(CFG.ports.gateway);
const PORT = CFG.ports.gateway;
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
// Tuning: FORECAST_AUTORESOLVE_MS (default 6h), FORECAST_LIMIT, SEARXNG_BASE, etc.
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
        base: process.env.SEARXNG_BASE,
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
