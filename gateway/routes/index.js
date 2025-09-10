// gateway/routes/index.js
// This file registers all route handlers with the Express app.
// It receives the app instance and a deps object containing shared utilities.

import fs from "fs";
import { makeSnippets } from '../utils.js';
import crypto from "crypto";
import { performance } from "perf_hooks";
import db from '../db/db.js';
import { createSession, getSession } from '../db/session.js';
import { completeUseCase } from '../usecases/complete.js';
import { chatUseCase } from '../usecases/chat.js';
import { warmupUseCase } from '../usecases/warmup.js';

module.exports = function registerRoutes(app, deps) {
  const {
    log,
    getTimeoutMs,
    escapeRe,
    loadGitignore,
    scanDirectory,
    OLLAMA,
    MODEL,
    MOCK,
    VERBOSE,
    LOG_BODY,
    getIndex,
    setIndex,
  } = deps;

  // Health
  app.get("/health", (_req, res) =>
    res.json({
      ok: true,
      mock: MOCK,
      model: MODEL,
      ollama: OLLAMA,
      timeoutMs: getTimeoutMs(),
      pid: process.pid,
    })
  );

  // Complete
  app.post("/complete", async (req, res) => {
    await completeUseCase(req, res, deps);
  });

  // Chat
  app.post("/chat", async (req, res) => {
    await chatUseCase(req, res, deps);
  });

  // Models list
  app.get("/models", async (_req, res) => {
    try {
      const r = await fetch(`${OLLAMA}/api/tags`, { headers: { "Content-Type": "application/json" } });
      if (!r.ok) throw new Error(await r.text().catch(() => r.statusText));
      const data = await r.json();
      const names = (data.models ?? data ?? []).map((m) => m.name || m.model).filter(Boolean).sort((a, b) => a.localeCompare(b));
      res.json({ models: names });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // Warmup
  app.post("/warmup", async (req, res) => {
    await warmupUseCase(req, res, deps);
  });

  // Scan
  app.post("/scan", async (req, res) => {
    const root = req.body?.root;
    const maxFileSize = Math.min(Number(req.body?.maxFileSize) || 262144, 2 * 1024 * 1024);
    if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      return res.status(400).json({ ok: false, error: "valid 'root' directory required" });
    }
    const t0 = performance.now();
    const files = scanDirectory(root, maxFileSize);
    setIndex({ root, files });
    log({ event: "scan_done", root, count: files.length, ms: Math.round(performance.now() - t0) });
    return res.json({ ok: true, root, count: files.length });
  });

  // Query
  app.post("/query", async (req, res) => {
    const q = String(req.body?.q || "").trim();
    const k = Math.min(Number(req.body?.k) || 8, 20);
    const index = getIndex();
    if (!index.root || index.files.length === 0) {
      return res.status(400).json({ ok: false, error: "index is empty; call /scan first" });
    }
    if (!q) return res.status(400).json({ ok: false, error: "query 'q' required" });
    const terms = q.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);
    const scored = [];
    for (const f of index.files) {
      let score = 0;
      for (const t of terms) {
        const rx = new RegExp("\\b" + escapeRe(t) + "\\b", "gi");
        const matches = f.text.match(rx);
        if (matches) score += matches.length;
      }
      if (score > 0) scored.push({ f, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const hits = scored.slice(0, k).map(({ f, score }) => ({
      path: f.path,
      score,
      snippets: makeSnippets(f.text, terms),
    }));
    return res.json({ ok: true, root: index.root, hits });
  });

  // Chat stream
  app.post("/chat/stream", async (req, res) => {
    const id = crypto.randomUUID();
    const t0 = performance.now();
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const model = req.body?.model || MODEL;
    const timeoutMs = getTimeoutMs(req.body?.timeoutMs);
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), timeoutMs);
    log({ id, event: "request_in", type: "chat_stream", model, messagesCount: messages.length, mock: MOCK });
    if (MOCK) {
      res.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.flushHeaders();
      const mockText = "Mock reply. (Enable Ollama to chat.)";
      res.write(`data: ${mockText}\n\n`);
      res.end();
      log({ id, event: "response_out", type: "chat_stream", mock: true, bytes: mockText.length });
      return;
    }
    const body = {
      model,
      messages,
      stream: true,
      keep_alive: req.body?.keepAlive || "30m",
      options: { temperature: 0.2 },
    };
    log({ id, event: "upstream_request", type: "chat_stream", url: `${OLLAMA}/api/chat`, timeoutMs, bodySize: JSON.stringify(body).length });
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.flushHeaders();
    try {
      const r = await fetch(`${OLLAMA}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!r.ok) {
        const raw = await r.text();
        log({ id, event: "error", where: "upstream_not_ok", type: "chat_stream", status: r.status, preview: raw.slice(0, 200) });
        res.status(502).json({ error: "upstream error", status: r.status });
        return;
      }
      const latencyAll = Math.round(performance.now() - t0);
      log({ id, event: "response_out", type: "chat_stream", latencyMs: latencyAll });
      r.body.on("data", (chunk) => {
        res.write(chunk);
        res.flush();
      });
      r.body.on("end", () => {
        res.end();
      });
    } catch (e) {
      const latencyAll = Math.round(performance.now() - t0);
      const reason = e?.name === "AbortError" ? "timeout" : (e?.message || "error");
      log({ id, event: "error", where: "fetch", type: "chat_stream", reason, latencyMs: latencyAll });
      res.status(504).json({ error: "timeout/error" });
    } finally {
      clearTimeout(to);
    }
  });

  // Auth and memory routes
  app.post("/auth/login", async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'username and password required' });
    }
    const user = db.getUserByUsername(username);
    if (!user) {
      return res.status(401).json({ error: 'invalid credentials' });
    }
    if (user.password_hash !== password) {
      return res.status(401).json({ error: 'invalid credentials' });
    }
    const token = createSession(user.id, req.body?.workspaceId || 'default');
    res.json({ token, userId: user.id });
});

  function requireAuth(req, res, next) {
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'missing token' });
    }
    const token = auth.slice(7);
    const session = getSession(token);
    if (!session) {
      return res.status(401).json({ error: 'invalid token' });
    }
    req.session = session;
    next();
  }

  app.post('/memory/short', requireAuth, (req, res) => {
    const { content } = req.body || {};
    if (typeof content !== 'string') {
      return res.status(400).json({ error: 'content must be string' });
    }
    db.setShortTerm(req.session.userId, req.session.workspaceId, content);
    res.json({ ok: true });
});
  app.get('/memory/short', requireAuth, (req, res) => {
    const content = db.getShortTerm(req.session.userId, req.session.workspaceId);
    res.json({ content });
  });
  app.post('/memory/long', requireAuth, (req, res) => {
    const { content } = req.body || {};
    if (typeof content !== 'string') {
      return res.status(400).json({ error: 'content must be string' });
    }
    db.setLongTerm(req.session.userId, req.session.workspaceId, content);
    res.json({ ok: true });
});
  app.get('/memory/long', requireAuth, (req, res) => {
    const content = db.getLongTerm(req.session.userId, req.session.workspaceId);
    res.json({ content });
  });
};
