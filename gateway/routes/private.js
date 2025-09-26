// gateway/routes/private.js
import { loginUseCase, requireAuth } from "../usecases/auth.js";
import { cacheStats, purgeExpiredCache, run, listLLMRequests, getLLMRequestById, summarizeLLMRequests } from "../db/db.js";
import { memoryShortUseCase, memoryLongUseCase, memoryList, memoryGet, memoryDelete } from "../usecases/memory.js";
import { validate } from "../middleware/validate.js";
import { MemoryWriteSchema } from "../validation/schemas.js";

export function registerPrivate(app, deps, { memoryLimiter } = {}) {
  // Auth
  app.post("/auth/login", async (req, res) => {
    await loginUseCase(req, res, deps);
  });

  // Memory short/long CRUD
  app.get("/memory/short", requireAuth, async (req, res) => {
    await memoryList(req, res, "short");
  });
  app.get("/memory/short/:memid", requireAuth, async (req, res) => {
    await memoryGet(req, res, "short");
  });
  app.post("/memory/short", requireAuth, memoryLimiter, validate(MemoryWriteSchema), async (req, res) => {
    await memoryShortUseCase(req, res, deps);
  });
  app.delete("/memory/short/:memid", requireAuth, memoryLimiter, async (req, res) => {
    await memoryDelete(req, res, "short");
  });

  app.get("/memory/long", requireAuth, async (req, res) => {
    await memoryList(req, res, "long");
  });
  app.get("/memory/long/:memid", requireAuth, async (req, res) => {
    await memoryGet(req, res, "long");
  });
  app.post("/memory/long", requireAuth, memoryLimiter, validate(MemoryWriteSchema), async (req, res) => {
    await memoryLongUseCase(req, res, deps);
  });
  app.delete("/memory/long/:memid", requireAuth, memoryLimiter, async (req, res) => {
    await memoryDelete(req, res, "long");
  });

  // Admin cache routes (authenticated)
  app.get('/admin/cache/stats', requireAuth, async (_req, res) => {
    try {
      const stats = cacheStats();
      res.json({ ok: true, stats });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e && e.message || e) });
    }
  });

  app.post('/admin/cache/clear', requireAuth, async (req, res) => {
    try {
      const body = req.body || {};
      const expiredOnly = String(body.expiredOnly || body.expired || 'false').toLowerCase() === 'true';
      let changes = 0;
      if (expiredOnly) {
        changes = purgeExpiredCache();
      } else {
        const info = run(`DELETE FROM llm_cache`, []);
        changes = info?.changes || 0;
      }
      res.json({ ok: true, cleared: changes, expiredOnly });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e && e.message || e) });
    }
  });

  // Admin: LLM logs (auditing)
  app.get('/admin/logs', requireAuth, async (req, res) => {
    try {
      const { model, kind, since, until, limit, offset, detail } = req.query || {};
      const includeRequest = String(detail || '0') === '1' || String(detail || '').toLowerCase() === 'true';
      const includeRaw = includeRequest; // tie together for simplicity
      const rows = listLLMRequests({ model, kind, since, until, limit, offset, includeRequest, includeRaw });
      res.json({ ok: true, items: rows });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e && e.message || e) });
    }
  });

  // Summary endpoint (define before :id route to avoid capture)
  app.get('/admin/logs/summary', requireAuth, async (req, res) => {
    try {
      const { since, until, kind, group, limit, offset } = req.query || {};
      const items = summarizeLLMRequests({ since, until, kind, group, limit, offset });
      res.json({ ok: true, group: group || 'model', items });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e && e.message || e) });
    }
  });

  app.get('/admin/logs/:id', requireAuth, async (req, res) => {
    try {
      const row = getLLMRequestById(String(req.params.id || ''));
      if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
      res.json({ ok: true, item: row });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e && e.message || e) });
    }
  });
}

export default { registerPrivate };
