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
import { scanUseCase } from '../usecases/scan.js';
import { queryUseCase } from '../usecases/query.js';
import { chatStreamUseCase } from '../usecases/chatStream.js';
import { loginUseCase, requireAuth } from '../usecases/auth.js';
import { memoryShortUseCase, memoryLongUseCase } from '../usecases/memory.js';
import { getModels } from '../usecases/models.js';

export default function registerRoutes(app, deps) {
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
  app.get('/models', async (req, res) => {
    const models = await getModels();
    res.json({ models });
  });

  // Warmup
  app.post("/warmup", async (req, res) => {
    await warmupUseCase(req, res, deps);
  });

  // Scan
  app.post("/scan", async (req, res) => {
    await scanUseCase(req, res, deps);
  });

  // Query
  app.post("/query", async (req, res) => {
    await queryUseCase(req, res, deps);
  });

  // Chat stream
  app.post("/chat/stream", async (req, res) => {
    await chatStreamUseCase(req, res, deps);
  });

  // Auth and memory routes
  app.post("/auth/login", async (req, res) => {
    await loginUseCase(req, res, deps);
  });

  app.post('/memory/short', requireAuth, async (req, res) => {
    await memoryShortUseCase(req, res, deps);
  });
  app.get('/memory/short', requireAuth, async (req, res) => {
    const content = db.getShortTerm(req.session.userId, req.session.workspaceId);
    res.json({ content });
  });
  app.post('/memory/long', requireAuth, async (req, res) => {
    await memoryLongUseCase(req, res, deps);
  });
  app.get('/memory/long', requireAuth, async (req, res) => {
    const content = db.getLongTerm(req.session.userId, req.session.workspaceId);
    res.json({ content });
  });
};
