// gateway/routes/agentic.js
import { completeUseCase } from "../usecases/complete.js";
import { chatUseCase } from "../usecases/chat.js";
import { chatStreamUseCase } from "../usecases/chatStream.js";
import { scanUseCase } from "../usecases/scan.js";
import { queryUseCase } from "../usecases/query.js";
import { getModels } from "../usecases/models.js";
import { runHwOptimizeUseCase, getHwProfileUseCase } from "../usecases/optimize.js";
import { startLlamaServerUseCase, stopLlamaServerUseCase } from "../usecases/runtime.js";
import { compressShortToLongUseCase, compressLongGlobalUseCase } from "../usecases/compress.js";
import { searchWhoogle } from "../tools/whoogle.js";
import { searchCurated as searchCuratedLocal } from "../tools/curated/search.mjs";
import { researchWeb } from "../tools/research.js";
import { answerWeb } from "../tools/answers.js";
import { validate } from "../middleware/validate.js";
import { WhoogleSearchSchema, ResearchSchema, CompleteSchema, ChatSchema, ScanSchema, QuerySchema, ForecastSeedSchema } from "../validation/schemas.js";

export function registerAgentic(app, deps, limiters = {}) {
  const { log, getIndex, getTimeoutMs } = deps;
  const { chatLimiter, searchLimiter, researchLimiter, answerLimiter, insightsLimiter, graphLimiter, debateLimiter, planLimiter, trainLimiter, forecastLimiter, compressLimiter } = limiters;

  // Core LLM routes
  app.post("/complete", validate(CompleteSchema), async (req, res) => { await completeUseCase(req, res, deps); });
  app.post("/chat", chatLimiter, validate(ChatSchema), async (req, res) => { await chatUseCase(req, res, deps); });
  app.post("/chat/stream", chatLimiter, validate(ChatSchema), async (req, res) => { await chatStreamUseCase(req, res, deps); });
  app.get("/models", async (_req, res) => { const models = await getModels(); res.json({ models }); });

  // Indexing / Query
  app.post("/scan", validate(ScanSchema), async (req, res) => { await scanUseCase(req, res, deps); });
  app.post("/query", validate(QuerySchema), async (req, res) => { await queryUseCase(req, res, deps); });

  // Optimize + Runtime
  app.post("/optimize/hw/run", async (req, res) => { await runHwOptimizeUseCase(req, res); });
  app.get("/optimize/hw", async (req, res) => { await getHwProfileUseCase(req, res); });
  app.post("/runtime/llama/start", async (req, res) => { await startLlamaServerUseCase(req, res); });
  app.post("/runtime/llama/stop", async (req, res) => { await stopLlamaServerUseCase(req, res); });

  // Curated + Research
  app.get("/curated", searchLimiter, validate(WhoogleSearchSchema), async (req, res) => {
    try {
      const q = String(req.query.q || req.query.query || '').trim();
      if (!q) return res.status(400).json({ ok:false, error:'missing_query' });
      const num = req.query.num ? Math.min(Math.max(1, Number(req.query.num)), 20) : 5;
      const cache = process.env.CURATED_CACHE;
      const out = await searchCuratedLocal(q, { num, site: req.query.site, lang: req.query.lang, cache });
      res.json(out);
    } catch (e) { res.status(500).json({ ok:false, error:String(e && e.message || e) }); }
  });

  app.get("/research", researchLimiter, validate(ResearchSchema), async (req, res) => {
    const query = String(req.query.q || req.query.query || '').trim();
    if (!query) return res.status(400).json({ ok:false, error:'missing_query' });
    const num = req.query.num ? Math.min(Math.max(1, Number(req.query.num)), 10) : 5;
    const fetchNum = req.query.fetchNum ? Math.min(Math.max(1, Number(req.query.fetchNum)), 6) : 3;
    const concurrency = req.query.concurrency ? Math.min(Math.max(1, Number(req.query.concurrency)), 6) : 3;
    const localK = req.query.localK ? Math.min(Math.max(1, Number(req.query.localK)), 20) : undefined;
    const opts = {
      mode: req.query.mode && ["web","local","hybrid"].includes(String(req.query.mode)) ? String(req.query.mode) : 'hybrid',
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
      timeoutMs: req.query.timeoutMs ? Number(req.query.timeoutMs) : undefined,
      maxChars: req.query.maxChars ? Number(req.query.maxChars) : undefined,
    };
    try {
      if ((process.env.CURATED_MODE || '').toLowerCase() === '1' || (process.env.CURATED_MODE || '').toLowerCase() === 'true') {
        const cache = process.env.CURATED_CACHE; const cnum = num || 5;
        const c = await searchCuratedLocal(query, { num: cnum, site: req.query.site, lang: req.query.lang, cache });
        if (c && c.ok && Array.isArray(c.results) && c.results.length) {
          const mapped = c.results.map(r => ({ title: r.title || '', url: r.url, snippet: r.snippet || '', page: { ok: true, title: r.title || '', description: '', headings: [], wordCount: (r.snippet || '').split(/\s+/).filter(Boolean).length, content: r.snippet || '' } }));
          return res.json({ ok: true, query, results: mapped, fetched: mapped.length, source: 'curated' });
        }
      }
      const result = await researchWeb(query, opts);
      if (!result.ok) return res.status(500).json(result);
      res.json(result);
    } catch (e) { res.status(500).json({ ok:false, error:String(e && e.message || e) }); }
  });

  // Insights graph
  app.get("/insights/graph", graphLimiter, async (req, res) => {
    try {
      const { InsightsGraphSchema } = await import("../validation/schemas.js");
      const parsed = InsightsGraphSchema.safeParse(req.query || {});
      if (!parsed.success) return res.status(400).json({ ok:false, error: parsed.error.flatten() });
      const query = req.query.q || req.query.query;
      const mode = req.query.mode && ["web","local","hybrid"].includes(String(req.query.mode)) ? String(req.query.mode) : 'hybrid';
      const num = req.query.num ? Math.min(Math.max(1, Number(req.query.num)), 10) : undefined;
      const fetchNum = req.query.fetchNum ? Math.min(Math.max(1, Number(req.query.fetchNum)), 6) : undefined;
      const concurrency = req.query.concurrency ? Math.min(Math.max(1, Number(req.query.concurrency)), 6) : undefined;
      const localK = req.query.localK ? Math.min(Math.max(1, Number(req.query.localK)), 20) : undefined;
      const opts = { mode, base: process.env.WHOOGLE_BASE, num, fetchNum, concurrency, site: req.query.site, lang: req.query.lang, safe: typeof req.query.safe !== 'undefined' ? (String(req.query.safe).toLowerCase()==='true'||req.query.safe===true) : undefined, fresh: req.query.fresh, localIndex: typeof getIndex === 'function' ? getIndex() : undefined, localK, maxContextChars: req.query.maxContextChars ? Number(req.query.maxContextChars) : undefined, maxAnswerTokens: req.query.maxAnswerTokens ? Number(req.query.maxAnswerTokens) : undefined };
      const { insightsGraph } = await import("../tools/insights.js");
      const result = await insightsGraph(query, opts);
      if (!result.ok) return res.status(500).json(result);
      res.json(result);
    } catch (e) { res.status(500).json({ ok:false, error: String(e && e.message || e) }); }
  });

  // Plan
  app.post("/plan", planLimiter, async (req, res) => {
    try {
      const { PlanSchema } = await import("../validation/schemas.js");
      const data = req.body || {}; const parsed = PlanSchema.safeParse(data);
      if (!parsed.success) return res.status(400).json({ ok:false, error: parsed.error.flatten() });
      const mode = data.mode && ["web","local","hybrid"].includes(String(data.mode)) ? String(data.mode) : 'hybrid';
      const num = data.num ? Math.min(Math.max(1, Number(data.num)), 20) : undefined;
      const fetchNum = data.fetchNum ? Math.min(Math.max(1, Number(data.fetchNum)), 10) : undefined;
      const concurrency = data.concurrency ? Math.min(Math.max(1, Number(data.concurrency)), 6) : undefined;
      const localK = data.localK ? Math.min(Math.max(1, Number(data.localK)), 20) : undefined;
      const opts = { mode, base: process.env.WHOOGLE_BASE, num, fetchNum, concurrency, site: data.site, lang: data.lang, safe: typeof data.safe !== 'undefined' ? (String(data.safe).toLowerCase()==='true'||data.safe===true) : undefined, fresh: data.fresh, localIndex: typeof getIndex === 'function' ? getIndex() : undefined, localK, maxContextChars: data.maxContextChars ? Number(data.maxContextChars) : undefined, maxAnswerTokens: data.maxAnswerTokens ? Number(data.maxAnswerTokens) : undefined };
      const { planEngine } = await import("../tools/plan.js");
      const result = await planEngine(data, opts);
      if (!result.ok) return res.status(500).json(result);
      res.json(result);
    } catch (e) { res.status(500).json({ ok:false, error: String(e && e.message || e) }); }
  });

  // Train loop
  app.post("/train/loop", trainLimiter, async (req, res) => {
    try {
      const { TrainLoopSchema } = await import("../validation/schemas.js");
      const data = req.body || {}; const parsed = TrainLoopSchema.safeParse(data);
      if (!parsed.success) return res.status(400).json({ ok:false, error: parsed.error.flatten() });
      const mode = data.mode && ["web","local","hybrid"].includes(String(data.mode)) ? String(data.mode) : 'hybrid';
      const num = data.num ? Math.min(Math.max(1, Number(data.num)), 20) : undefined;
      const fetchNum = data.fetchNum ? Math.min(Math.max(1, Number(data.fetchNum)), 10) : undefined;
      const concurrency = data.concurrency ? Math.min(Math.max(1, Number(data.concurrency)), 6) : undefined;
      const localK = data.localK ? Math.min(Math.max(1, Number(data.localK)), 20) : undefined;
      const opts = { mode, iterations: data.iterations ? Math.min(Math.max(1, Number(data.iterations)), 10) : 2, perIter: data.perIter ? Math.min(Math.max(1, Number(data.perIter)), 10) : 2, difficulty: data.difficulty || 'hard', base: process.env.WHOOGLE_BASE, num, fetchNum, concurrency, site: data.site, lang: data.lang, safe: typeof data.safe !== 'undefined' ? (String(data.safe).toLowerCase()==='true'||data.safe===true) : undefined, fresh: data.fresh, localIndex: typeof getIndex === 'function' ? getIndex() : undefined, localK, maxContextChars: data.maxContextChars ? Number(data.maxContextChars) : undefined, maxAnswerTokens: data.maxAnswerTokens ? Number(data.maxAnswerTokens) : undefined, persist: typeof data.persist !== 'undefined' ? (String(data.persist).toLowerCase()==='true'||data.persist===true) : false, setLongTerm: undefined, userId: undefined, workspaceId: undefined, datasetPath: data.datasetPath };
      if (opts.persist) {
        try { const { setLongTerm } = await import("../db/db.js"); opts.setLongTerm = setLongTerm; if (data.userId) opts.userId = Number(data.userId); if (data.workspaceId) opts.workspaceId = String(data.workspaceId); } catch {}
      }
      const { trainLoop } = await import("../tools/training.js");
      const result = await trainLoop(data.topic, opts);
      if (!result.ok) return res.status(500).json(result);
      res.json(result);
    } catch (e) { res.status(500).json({ ok:false, error: String(e && e.message || e) }); }
  });

  // Forecast
  app.post("/forecast/seed", forecastLimiter, async (req, res) => {
    try {
      const { ForecastSeedSchema } = await import("../validation/schemas.js");
      const body = req.body || {}; const parsed = ForecastSeedSchema.safeParse(body);
      if (!parsed.success) return res.status(400).json({ ok:false, error: parsed.error.flatten() });
      const { forecastSeed } = await import("../tools/forecast.js");
      const result = await forecastSeed(body);
      if (!result.ok) return res.status(500).json(result);
      res.json(result);
    } catch (e) { res.status(500).json({ ok:false, error: String(e && e.message || e) }); }
  });

  // Rooms dispatcher: run a task through rooms flow
  app.post('/rooms/dispatch', async (req, res) => {
    try {
      const body = req.body || {};
      const { defaultDeps, runTask, Protocols } = await import('../rooms/index.js');
      const goal = String(body.goal || '').trim();
      if (!goal) return res.status(400).json({ ok: false, error: 'goal is required' });
      const task = Protocols.makeTask({ id: body.id || String(Date.now()), goal });
      const rdeps = defaultDeps({ llm: deps.llm, search: deps.search });
      const outcome = await runTask(task, rdeps);
      res.json({ ok: true, outcome });
    } catch (e) { res.status(500).json({ ok:false, error: String(e && e.message || e) }); }
  });

  // DB Manager agent: encode working memory snapshots across the DB
  app.post('/db/maintain', async (req, res) => {
    try {
      const { encodeAllMemories } = await import('../agents/db_manager.js');
      const reencode = String((req.body && req.body.reencode) || '').toLowerCase() === 'true' || (req.body && req.body.reencode === true);
      const result = await encodeAllMemories({ reencode });
      res.json(result);
    } catch (e) { res.status(500).json({ ok:false, error: String(e && e.message || e) }); }
  });

  // Ad-hoc DB backup
  app.post('/db/backup', async (_req, res) => {
    try {
      const { spawn } = await import('child_process');
      await new Promise((resolve, reject) => {
        const child = spawn('bash', ['-lc', 'scripts/backup_db.sh'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
        let last = '';
        child.stdout.on('data', (d) => { last = d.toString(); });
        child.stderr.on('data', (d) => { last = d.toString(); });
        child.on('error', reject);
        child.on('close', (code) => code === 0 ? resolve(last) : reject(new Error(last||('exit '+code))));
      });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok:false, error: String(e && e.message || e) }); }
  });
}

export default { registerAgentic };
