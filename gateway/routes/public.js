// gateway/routes/public.js
import * as prom from 'prom-client';
import { warmupUseCase } from '../usecases/warmup.js';
import { getModels } from '../usecases/models.js';

export function registerPublic(app, deps) {
  const { log, getTimeoutMs } = deps;
  // In-memory projects list for the public UI (no DB, no demo)
  const projects = new Map();
  function ensureProjectShape(projectId, actionDir = '.') {
    const base = {
      projectId,
      status: { counts: { pending: 0, running: 0, done: 0 }, queue: { paused: false } },
      config: { actionDir },
      active: true,
      project: null,
    };
    return base;
  }
  function listProjects() {
    return Array.from(projects.values());
  }

  // Liveness
  app.get('/health', (_req, res) =>
    res.json({
      ok: true,
      mock: process.env.MOCK || false,
      model: process.env.MODEL || null,
      timeoutMs: getTimeoutMs(),
      pid: process.pid,
    })
  );

  // Readiness (LoRA server if configured)
  app.get('/ready', async (_req, res) => {
    const base = String(process.env.LORA_SERVER_BASE || '').replace(/\/$/, '');
    try {
      if (!base) return res.status(200).json({ ok: true, upstream: 'gateway' });
      const r = await fetch(`${base}/models`, {
        method: 'GET',
        headers: {},
        signal: AbortSignal.timeout(3000),
      });
      return res
        .status(r.ok ? 200 : 503)
        .json({ ok: r.ok, upstream: 'lora-server', status: r.status });
    } catch (e) {
      return res
        .status(503)
        .json({ ok: false, error: (e && e.message) || String(e) });
    }
  });

  // Metrics scrape
  app.get('/metrics', async (_req, res) => {
    res.set('Content-Type', prom.register.contentType);
    res.end(await prom.register.metrics());
  });

  // Warmup
  app.post('/warmup', async (req, res) => {
    await warmupUseCase(req, res, deps);
  });

  // Models
  app.get('/models', async (_req, res) => {
    const payload = await getModels();
    res.json(payload);
  });

  // Projects (public UI, in-memory)
  app.get('/projects', (_req, res) => {
    res.json({ ok: true, projects: listProjects() });
  });

  app.post('/projects', (req, res) => {
    const body = req.body || {};
    const projectId = body.projectId || body.name;
    if (!projectId || !/^[a-zA-Z0-9_-]+$/.test(projectId)) {
      return res.status(400).json({ ok: false, error: 'invalid projectId' });
    }
    const actionDir = typeof body.actionDir === 'string' && body.actionDir.trim() !== '' ? body.actionDir.trim() : '.';
    if (!projects.has(projectId)) {
      projects.set(projectId, ensureProjectShape(projectId, actionDir));
    } else {
      const p = projects.get(projectId);
      p.config.actionDir = actionDir || p.config.actionDir;
    }
    res.json({ ok: true, projectId, projects: listProjects() });
  });

  app.delete('/projects/:id', (req, res) => {
    const projectId = req.params.id;
    projects.delete(projectId);
    res.json({ ok: true, removed: projectId, projects: listProjects() });
  });

  app.get('/projects/:id/config', (req, res) => {
    const projectId = req.params.id;
    const p = projects.get(projectId);
    const actionDir = (p && p.config && p.config.actionDir) || '.';
    res.json({ ok: true, config: { actionDir }, project: { id: 1, name: projectId, active: true } });
  });

  app.put('/projects/:id/config', (req, res) => {
    const projectId = req.params.id;
    const body = req.body || {};
    const actionDir = typeof body.actionDir === 'string' && body.actionDir.trim() !== '' ? body.actionDir.trim() : '.';
    if (!projects.has(projectId)) projects.set(projectId, ensureProjectShape(projectId, actionDir));
    else projects.get(projectId).config.actionDir = actionDir;
    res.json({ ok: true, config: { actionDir }, project: { id: 1, name: projectId, active: true } });
  });

  app.post('/pause', (_req, res) => {
    projects.forEach(p => { p.status.queue.paused = true; });
    res.json({ ok: true, paused: true });
  });

  app.post('/resume', (_req, res) => {
    projects.forEach(p => { p.status.queue.paused = false; });
    res.json({ ok: true, paused: false });
  });
}

export default { registerPublic };
