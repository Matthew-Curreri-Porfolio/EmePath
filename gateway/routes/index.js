import { registerToolCall } from "./toolcall.js";
// gateway/routes/index.js
// Registers all route handlers with the Express app.

import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import * as prom from "prom-client";
import { randomUUID } from "crypto";
import { registerPublic } from "./public.js";
import { registerPrivate } from "./private.js";
import { registerAgentic } from "./agentic.js";

import db from "../db/db.js";
import { completeUseCase } from "../usecases/complete.js";
import { chatUseCase } from "../usecases/chat.js";
import { chatStreamUseCase } from "../usecases/chatStream.js";
import { warmupUseCase } from "../usecases/warmup.js";
import { scanUseCase } from "../usecases/scan.js";
import { queryUseCase } from "../usecases/query.js";
import { loginUseCase, requireAuth } from "../usecases/auth.js";
import { memoryShortUseCase, memoryLongUseCase, memoryList, memoryGet, memoryDelete } from "../usecases/memory.js";
import { getModels } from "../usecases/models.js";

import { runHwOptimizeUseCase, getHwProfileUseCase } from "../usecases/optimize.js";
import { startLlamaServerUseCase, stopLlamaServerUseCase } from "../usecases/runtime.js";
import { trainingGet, trainingPut, trainingPatch, trainingDelete, trainingBuild } from "../usecases/training.js";
import { compressShortToLongUseCase, compressLongGlobalUseCase } from "../usecases/compress.js";
import { searchWhoogle } from "../tools/whoogle.js";
import { searchCurated as searchCuratedLocal } from "../tools/curated/search.mjs";
import { researchWeb } from "../tools/research.js";
import { answerWeb } from "../tools/answers.js";
import { registerModelResolver, resolveModelPath } from "./modelResolver.js";

import { validate } from "../middleware/validate.js";
import {
  ChatSchema,
  CompleteSchema,
  ScanSchema,
  QuerySchema,
  WarmupSchema,
  MemoryWriteSchema,
  TrainingPutSchema,
  TrainingPatchSchema,
  TrainingBuildSchema,
  CompressionSchema,
  WhoogleSearchSchema,
  ResearchSchema,
} from "../validation/schemas.js";

export default function registerRoutes(app, deps) {
  const { log, getTimeoutMs, OLLAMA, MODEL, MOCK } = deps;

  // Security & perf
  app.use(helmet());
  app.use(compression());

  // Metrics
  prom.collectDefaultMetrics();
  const httpMs = new prom.Histogram({
    name: "http_request_duration_ms",
    help: "HTTP request duration (ms)",
    labelNames: ["route", "method", "status"],
    buckets: [50, 100, 200, 500, 1000, 2000, 5000, 10000],
  });

  // Request ID + latency logging
  app.use((req, res, next) => {
    req.id = randomUUID();
    res.setHeader("X-Request-Id", req.id);
    const t0 = Date.now();
    res.on("finish", () => {
      const routeLabel = req.route && req.route.path ? req.route.path : req.path;
      const dur = Date.now() - t0;
      httpMs.labels(routeLabel, req.method, String(res.statusCode)).observe(dur);
      if (typeof log === "function") log("req", { id: req.id, m: req.method, p: req.path, s: res.statusCode, ms: dur });
    });
    next();
  });

  // Rate limiters
  const chatLimiter = rateLimit({ windowMs: 60_000, max: 30 });
  const memoryLimiter = rateLimit({ windowMs: 60_000, max: 120 });
  const trainingLimiter = rateLimit({ windowMs: 60_000, max: 30 });
  const compressLimiter = rateLimit({ windowMs: 60_000, max: 10 });
  const searchLimiter = rateLimit({ windowMs: 60_000, max: 60 });
  const researchLimiter = rateLimit({ windowMs: 60_000, max: 30 });
  const answerLimiter = rateLimit({ windowMs: 60_000, max: 20 });
  const insightsLimiter = rateLimit({ windowMs: 60_000, max: 15 });
  const graphLimiter = rateLimit({ windowMs: 60_000, max: 15 });
  const debateLimiter = rateLimit({ windowMs: 60_000, max: 12 });
  const planLimiter = rateLimit({ windowMs: 60_000, max: 10 });
  const trainLimiter = rateLimit({ windowMs: 60_000, max: 4 });
  const forecastLimiter = rateLimit({ windowMs: 60_000, max: 20 });

  // Public routes
  registerPublic(app, deps);

  // Agentic routes
  registerAgentic(app, deps, { chatLimiter, searchLimiter, researchLimiter, answerLimiter, insightsLimiter, graphLimiter, debateLimiter, planLimiter, trainLimiter, forecastLimiter, compressLimiter });

  // Tool Call dispatcher
  registerToolCall(app, deps);

  // Private routes
  registerPrivate(app, deps, { memoryLimiter });

  app.post("/chat", chatLimiter, validate(ChatSchema), async (req, res) => {
    await chatUseCase(req, res, deps);
  });

  app.post("/warmup", validate(WarmupSchema), async (req, res) => {
    await warmupUseCase(req, res, deps);
  });
  // Model resolver (mount once at startup)
  registerModelResolver(app, deps);
  // Training
  app.get("/user/training", requireAuth, trainingLimiter, async (req, res) => {
    await trainingGet(req, res);
  });
  app.put("/user/training", requireAuth, trainingLimiter, validate(TrainingPutSchema), async (req, res) => {
    await trainingPut(req, res);
  });
  app.patch("/user/training", requireAuth, trainingLimiter, validate(TrainingPatchSchema), async (req, res) => {
    await trainingPatch(req, res);
  });
  app.delete("/user/training", requireAuth, trainingLimiter, async (req, res) => {
    await trainingDelete(req, res);
  });
  app.post("/user/training/build", requireAuth, trainingLimiter, validate(TrainingBuildSchema), async (req, res) => {
    await trainingBuild(req, res);
  });

  // Hardware optimization profile
  app.post("/optimize/hw/run", async (req, res) => {
    await runHwOptimizeUseCase(req, res, deps);
  });
  app.get("/optimize/hw", async (req, res) => {
    await getHwProfileUseCase(req, res);
  });

  // Runtime control for llama-server
  app.post("/runtime/llama/start", async (req, res) => {
    await startLlamaServerUseCase(req, res);
  });
  app.post("/runtime/llama/stop", async (req, res) => {
    await stopLlamaServerUseCase(req, res);
  });

  // Compression endpoints
  app.post("/memory/compact/short-to-long", requireAuth, compressLimiter, validate(CompressionSchema), async (req, res) => {
    await (await import("../usecases/compress.js")).compressShortToLongUseCase(req, res, deps);
  });
  app.post("/memory/compact/long", requireAuth, compressLimiter, validate(CompressionSchema), async (req, res) => {
    await (await import("../usecases/compress.js")).compressLongGlobalUseCase(req, res, deps);
  });

  // Whoogle search endpoint
  app.get("/whoogle", searchLimiter, validate(WhoogleSearchSchema), async (req, res) => {
    const query = req.query.q || req.query.query;
    const num = (() => {
      const raw = req.query.n ?? req.query.num;
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? Math.min(n, 20) : undefined;
    })();
    const site = req.query.site;
    const lang = req.query.lang;
    const safe = typeof req.query.safe !== 'undefined' ? (String(req.query.safe).toLowerCase() === 'true' || req.query.safe === true) : undefined;
    const fresh = req.query.fresh;
    if (!query) {
      return res.status(400).json({ ok: false, error: "missing query" });
    }
    try {
      const result = await searchWhoogle(query, { base: process.env.WHOOGLE_BASE, num, site, lang, safe, fresh });
      if (!result.ok) {
        return res.status(500).json(result);
      }
      res.json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e) });
    }
  });

  // Curated search endpoint (local cache)
  app.get("/curated", searchLimiter, validate(WhoogleSearchSchema), async (req, res) => {
    try {
      const query = req.query.q || req.query.query;
      const num = (() => {
        const raw = req.query.n ?? req.query.num;
        const n = Number(raw);
        return Number.isFinite(n) && n > 0 ? Math.min(n, 20) : 5;
      })();
      const site = req.query.site;
      const lang = req.query.lang;
      const cache = process.env.CURATED_CACHE;
      const out = await searchCuratedLocal(query, { num, site, lang, cache });
      if (!out.ok) return res.status(200).json(out);
      res.json(out);
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e && e.message || e) });
    }
  });

  // Web research endpoint
  app.get("/research", researchLimiter, validate(ResearchSchema), async (req, res) => {
    const query = req.query.q || req.query.query;
    const num = (() => {
      const raw = req.query.n ?? req.query.num;
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? Math.min(n, 20) : undefined;
    })();
    const fetchNum = (() => {
      const raw = req.query.f ?? req.query.fetchNum;
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? Math.min(n, 10) : undefined;
    })();
    const concurrency = (() => {
      const raw = req.query.c ?? req.query.concurrency;
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? Math.min(n, 6) : undefined;
    })();
    const opts = {
      base: process.env.WHOOGLE_BASE,
      num,
      fetchNum,
      concurrency,
      site: req.query.site,
      lang: req.query.lang,
      safe: typeof req.query.safe !== 'undefined' ? (String(req.query.safe).toLowerCase() === 'true' || req.query.safe === true) : undefined,
      fresh: req.query.fresh,
      timeoutMs: req.query.timeoutMs ? Number(req.query.timeoutMs) : undefined,
      maxChars: req.query.maxChars ? Number(req.query.maxChars) : undefined,
    };
    try {
      // Curated-first mode (optional): try local curated cache before web
      if ((process.env.CURATED_MODE || '').toLowerCase() === '1' || (process.env.CURATED_MODE || '').toLowerCase() === 'true') {
        const cache = process.env.CURATED_CACHE;
        const cnum = num || 5;
        const c = await searchCuratedLocal(query, { num: cnum, site: req.query.site, lang: req.query.lang, cache });
        if (c && c.ok && Array.isArray(c.results) && c.results.length) {
          const mapped = c.results.map(r => ({
            title: r.title || '',
            url: r.url,
            snippet: r.snippet || '',
            page: {
              ok: true,
              title: r.title || '',
              description: '',
              headings: [],
              wordCount: (r.snippet || '').split(/\s+/).filter(Boolean).length,
              content: r.snippet || '',
            }
          }));
          return res.json({ ok: true, query, results: mapped, fetched: mapped.length, source: 'curated' });
        }
      }
      const result = await researchWeb(query, opts);
      if (!result.ok) return res.status(500).json(result);
      res.json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e) });
    }
  });

  // Insight Graph — nodes/edges from web/local/hybrid evidence
  app.get("/insights/graph", graphLimiter, async (req, res) => {
    try {
      const { InsightsGraphSchema } = await import("../validation/schemas.js");
      const parsed = InsightsGraphSchema.safeParse(req.query || {});
      if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

      const query = req.query.q || req.query.query;
      const mode = req.query.mode && ["web", "local", "hybrid"].includes(String(req.query.mode))
        ? String(req.query.mode) : "web";
      const num = (() => {
        const raw = req.query.n ?? req.query.num;
        const n = Number(raw);
        return Number.isFinite(n) && n > 0 ? Math.min(n, 20) : undefined;
      })();
      const fetchNum = (() => {
        const raw = req.query.f ?? req.query.fetchNum;
        const n = Number(raw);
        return Number.isFinite(n) && n > 0 ? Math.min(n, 10) : undefined;
      })();
      const concurrency = (() => {
        const raw = req.query.c ?? req.query.concurrency;
        const n = Number(raw);
        return Number.isFinite(n) && n > 0 ? Math.min(n, 6) : undefined;
      })();
      const localK = req.query.localK ? Math.min(Math.max(1, Number(req.query.localK)), 20) : undefined;
      const opts = {
        mode,
        base: process.env.WHOOGLE_BASE,
        num,
        fetchNum,
        concurrency,
        site: req.query.site,
        lang: req.query.lang,
        safe: typeof req.query.safe !== 'undefined' ? (String(req.query.safe).toLowerCase() === 'true' || req.query.safe === true) : undefined,
        fresh: req.query.fresh,
        localIndex: typeof getIndex === 'function' ? getIndex() : undefined,
        localK,
        maxContextChars: req.query.maxContextChars ? Number(req.query.maxContextChars) : undefined,
        maxAnswerTokens: req.query.maxAnswerTokens ? Number(req.query.maxAnswerTokens) : undefined,
      };
      const { graphInsights } = await import("../tools/graph.js");
      const result = await graphInsights(query, opts);
      if (!result.ok) return res.status(500).json(result);
      res.json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e && e.message || e) });
    }
  });

  // Debate endpoint (GET)
  app.get("/debate", debateLimiter, async (req, res) => {
    try {
      const { DebateSchema } = await import("../validation/schemas.js");
      const data = req.query || {};
      const parsed = DebateSchema.safeParse(data);
      if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

      const query = data.q || data.query;
      const mode = data.mode && ["web", "local", "hybrid"].includes(String(data.mode)) ? String(data.mode) : 'hybrid';
      const num = (() => { const n = Number(data.n ?? data.num); return Number.isFinite(n) && n > 0 ? Math.min(n, 20) : undefined; })();
      const fetchNum = (() => { const n = Number(data.f ?? data.fetchNum); return Number.isFinite(n) && n > 0 ? Math.min(n, 10) : undefined; })();
      const concurrency = (() => { const n = Number(data.c ?? data.concurrency); return Number.isFinite(n) && n > 0 ? Math.min(n, 6) : undefined; })();
      const localK = data.localK ? Math.min(Math.max(1, Number(data.localK)), 20) : undefined;

      const opts = {
        mode,
        useInsights: typeof data.useInsights !== 'undefined' ? (String(data.useInsights).toLowerCase() === 'true' || data.useInsights === true) : true,
        rounds: data.rounds ? Math.min(Math.max(1, Number(data.rounds)), 4) : 2,
        trace: typeof data.trace !== 'undefined' ? (String(data.trace).toLowerCase() === 'true' || data.trace === true) : false,
        base: process.env.WHOOGLE_BASE,
        num,
        fetchNum,
        concurrency,
        site: data.site,
        lang: data.lang,
        safe: typeof data.safe !== 'undefined' ? (String(data.safe).toLowerCase() === 'true' || data.safe === true) : undefined,
        fresh: data.fresh,
        localIndex: typeof getIndex === 'function' ? getIndex() : undefined,
        localK,
        maxContextChars: data.maxContextChars ? Number(data.maxContextChars) : undefined,
        maxAnswerTokens: data.maxAnswerTokens ? Number(data.maxAnswerTokens) : undefined,
      };

      const { debateEngine } = await import("../tools/debate.js");
      const result = await debateEngine(query, opts);
      if (!result.ok) return res.status(500).json(result);
      res.json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e && e.message || e) });
    }
  });

  // Plan endpoint (POST)
  app.post("/plan", planLimiter, async (req, res) => {
    try {
      const { PlanSchema } = await import("../validation/schemas.js");
      const data = req.body || {};
      const parsed = PlanSchema.safeParse(data);
      if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

      const mode = data.mode && ["web", "local", "hybrid"].includes(String(data.mode)) ? String(data.mode) : 'hybrid';
      const num = data.num ? Math.min(Math.max(1, Number(data.num)), 20) : undefined;
      const fetchNum = data.fetchNum ? Math.min(Math.max(1, Number(data.fetchNum)), 10) : undefined;
      const concurrency = data.concurrency ? Math.min(Math.max(1, Number(data.concurrency)), 6) : undefined;
      const localK = data.localK ? Math.min(Math.max(1, Number(data.localK)), 20) : undefined;

      const opts = {
        mode,
        base: process.env.WHOOGLE_BASE,
        num,
        fetchNum,
        concurrency,
        site: data.site,
        lang: data.lang,
        safe: typeof data.safe !== 'undefined' ? (String(data.safe).toLowerCase() === 'true' || data.safe === true) : undefined,
        fresh: data.fresh,
        localIndex: typeof getIndex === 'function' ? getIndex() : undefined,
        localK,
        maxContextChars: data.maxContextChars ? Number(data.maxContextChars) : undefined,
        maxAnswerTokens: data.maxAnswerTokens ? Number(data.maxAnswerTokens) : undefined,
      };
      const { planEngine } = await import("../tools/plan.js");
      const result = await planEngine(data, opts);
      if (!result.ok) return res.status(500).json(result);
      res.json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e && e.message || e) });
    }
  });

  // Training loop (POST)
  app.post("/train/loop", trainLimiter, async (req, res) => {
    try {
      const { TrainLoopSchema } = await import("../validation/schemas.js");
      const data = req.body || {};
      const parsed = TrainLoopSchema.safeParse(data);
      if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

      const mode = data.mode && ["web", "local", "hybrid"].includes(String(data.mode)) ? String(data.mode) : 'hybrid';
      const num = data.num ? Math.min(Math.max(1, Number(data.num)), 20) : undefined;
      const fetchNum = data.fetchNum ? Math.min(Math.max(1, Number(data.fetchNum)), 10) : undefined;
      const concurrency = data.concurrency ? Math.min(Math.max(1, Number(data.concurrency)), 6) : undefined;
      const localK = data.localK ? Math.min(Math.max(1, Number(data.localK)), 20) : undefined;

      const opts = {
        mode,
        iterations: data.iterations ? Math.min(Math.max(1, Number(data.iterations)), 10) : 2,
        perIter: data.perIter ? Math.min(Math.max(1, Number(data.perIter)), 10) : 2,
        difficulty: data.difficulty || 'hard',
        base: process.env.WHOOGLE_BASE,
        num,
        fetchNum,
        concurrency,
        site: data.site,
        lang: data.lang,
        safe: typeof data.safe !== 'undefined' ? (String(data.safe).toLowerCase() === 'true' || data.safe === true) : undefined,
        fresh: data.fresh,
        localIndex: typeof getIndex === 'function' ? getIndex() : undefined,
        localK,
        maxContextChars: data.maxContextChars ? Number(data.maxContextChars) : undefined,
        maxAnswerTokens: data.maxAnswerTokens ? Number(data.maxAnswerTokens) : undefined,
        persist: typeof data.persist !== 'undefined' ? (String(data.persist).toLowerCase() === 'true' || data.persist === true) : false,
        setLongTerm: undefined,
        userId: undefined,
        workspaceId: undefined,
        datasetPath: data.datasetPath,
      };
      if (opts.persist) {
        try {
          const { setLongTerm } = await import("../db/db.js");
          opts.setLongTerm = setLongTerm;
          if (data.userId) opts.userId = Number(data.userId);
          if (data.workspaceId) opts.workspaceId = String(data.workspaceId);
        } catch { }
      }

      const { trainLoop } = await import("../tools/training.js");
      const result = await trainLoop(data.topic, opts);
      if (!result.ok) return res.status(500).json(result);
      res.json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e && e.message || e) });
    }
  });

  // Forecasting endpoints
  app.post("/forecast/seed", forecastLimiter, async (req, res) => {
    try {
      const { ForecastSeedSchema } = await import("../validation/schemas.js");
      const body = req.body || {};
      const parsed = ForecastSeedSchema.safeParse(body);
      if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
      const { seedForecasts } = await import("../tools/forecast.js");
      const opts = {
        mode: body.mode || 'hybrid',
        count: body.count || 5,
        horizonDays: body.horizonDays || 30,
        base: process.env.WHOOGLE_BASE,
        num: body.num,
        fetchNum: body.fetchNum,
        concurrency: body.concurrency,
        site: body.site,
        lang: body.lang,
        safe: typeof body.safe !== 'undefined' ? (String(body.safe).toLowerCase() === 'true' || body.safe === true) : undefined,
        fresh: body.fresh,
        localIndex: typeof getIndex === 'function' ? getIndex() : undefined,
        localK: body.localK,
        maxContextChars: body.maxContextChars,
      };
      const result = await seedForecasts(body.topic, opts);
      res.json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e && e.message || e) });
    }
  });

  app.post("/forecast/resolve", forecastLimiter, async (req, res) => {
    try {
      const { ForecastResolveSchema } = await import("../validation/schemas.js");
      const body = req.body || {};
      const parsed = ForecastResolveSchema.safeParse(body);
      if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
      const { resolveDueForecasts } = await import("../tools/forecast.js");
      const opts = {
        limit: body.limit || 20,
        base: process.env.WHOOGLE_BASE,
        num: body.num,
        fetchNum: body.fetchNum,
        concurrency: body.concurrency,
        site: body.site,
        lang: body.lang,
        safe: typeof body.safe !== 'undefined' ? (String(body.safe).toLowerCase() === 'true' || body.safe === true) : undefined,
        fresh: body.fresh,
      };
      const result = await resolveDueForecasts(opts);
      res.json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e && e.message || e) });
    }
  });

  app.get("/forecast", forecastLimiter, async (req, res) => {
    try {
      const { ForecastListSchema } = await import("../validation/schemas.js");
      const q = req.query || {};
      const parsed = ForecastListSchema.safeParse(q);
      if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
      const { listAllForecasts } = await import("../tools/forecast.js");
      const result = listAllForecasts({ status: q.status, topic: q.topic, limit: q.limit ? Number(q.limit) : undefined });
      res.json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e && e.message || e) });
    }
  });

  app.get("/forecast/stats", forecastLimiter, async (_req, res) => {
    try {
      const { tagStats } = await import("../tools/forecast.js");
      res.json(tagStats());
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e && e.message || e) });
    }
  });

  // Forecast dashboard metrics: calibration + tag reliability
  app.get("/forecast/metrics", forecastLimiter, async (req, res) => {
    try {
      const { ForecastMetricsSchema } = await import("../validation/schemas.js");
      const parsed = ForecastMetricsSchema.safeParse(req.query || {});
      if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
      const { forecastMetrics, metricsToCsv, metricsForUi } = await import("../tools/forecast.js");
      const result = forecastMetrics(parsed.data);
      const format = String(req.query.format || '').toLowerCase();
      if (format === 'csv') {
        const csv = metricsToCsv(result);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        return res.status(200).send(csv);
      }
      if (format === 'ui') {
        const ui = metricsForUi(result);
        return res.json(ui);
      }
      res.json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e && e.message || e) });
    }
  });

  // Backtest seeder from ICS/events
  app.post("/forecast/backtest/seed", forecastLimiter, async (req, res) => {
    try {
      const { ForecastBacktestSeedSchema } = await import("../validation/schemas.js");
      const body = req.body || {};
      const parsed = ForecastBacktestSeedSchema.safeParse(body);
      if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
      const { seedBacktestForecasts } = await import("../tools/forecast.js");
      const result = await seedBacktestForecasts(parsed.data);
      res.json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e && e.message || e) });
    }
  });

  // Insight Engine — structured insights from web/local/hybrid
  app.get("/insights", insightsLimiter, async (req, res) => {
    try {
      const { InsightsSchema } = await import("../validation/schemas.js");
      const parsed = InsightsSchema.safeParse(req.query || {});
      if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

      const query = req.query.q || req.query.query;
      const mode = req.query.mode && ["web", "local", "hybrid"].includes(String(req.query.mode))
        ? String(req.query.mode) : "web";

      const num = (() => {
        const raw = req.query.n ?? req.query.num;
        const n = Number(raw);
        return Number.isFinite(n) && n > 0 ? Math.min(n, 20) : undefined;
      })();
      const fetchNum = (() => {
        const raw = req.query.f ?? req.query.fetchNum;
        const n = Number(raw);
        return Number.isFinite(n) && n > 0 ? Math.min(n, 10) : undefined;
      })();
      const concurrency = (() => {
        const raw = req.query.c ?? req.query.concurrency;
        const n = Number(raw);
        return Number.isFinite(n) && n > 0 ? Math.min(n, 6) : undefined;
      })();
      const localK = req.query.localK ? Math.min(Math.max(1, Number(req.query.localK)), 20) : undefined;
      const compare = (() => {
        const v = req.query.compare;
        if (!v) return [];
        if (Array.isArray(v)) return v.flatMap(x => String(x).split(',')).map(s => s.trim()).filter(Boolean);
        return String(v).split(',').map(s => s.trim()).filter(Boolean);
      })();

      const opts = {
        mode,
        base: process.env.WHOOGLE_BASE,
        num,
        fetchNum,
        concurrency,
        site: req.query.site,
        lang: req.query.lang,
        safe: typeof req.query.safe !== 'undefined' ? (String(req.query.safe).toLowerCase() === 'true' || req.query.safe === true) : undefined,
        fresh: req.query.fresh,
        localIndex: typeof getIndex === 'function' ? getIndex() : undefined,
        localK,
        compare,
        maxContextChars: req.query.maxContextChars ? Number(req.query.maxContextChars) : undefined,
        maxAnswerTokens: req.query.maxAnswerTokens ? Number(req.query.maxAnswerTokens) : undefined,
      };

      const { insightsEngine } = await import("../tools/insights.js");
      const result = await insightsEngine(query, opts);
      if (!result.ok) return res.status(500).json(result);
      res.json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e && e.message || e) });
    }
  });

  // legacy agentic routes removed — see routes/agentic.js
}
