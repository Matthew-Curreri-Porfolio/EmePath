import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import express from 'express';
import cors from 'cors';
import http from 'http';
import request from 'supertest';

import registerRoutes from '../routes/index.js';
import { log, getTimeoutMs, escapeRe, scanDirectory, makeSnippets } from '../utils.js';
import { OLLAMA, MODEL, MOCK, VERBOSE, LOG_BODY } from '../config.js';
import { getIndex, setIndex } from '../state.js';
import { getModels } from '../usecases/models.js';

describe('Models proxy parity', () => {
  let app;
  let server;
  let agent;
  let llamaBase;

  beforeAll(async () => {
    if (!globalThis.__LLAMA_STUB__ || !globalThis.__LLAMA_STUB__.port) {
      throw new Error('LLAMA stub must be started via setup');
    }
    llamaBase = `http://127.0.0.1:${globalThis.__LLAMA_STUB__.port}`;
    process.env.LLAMACPP_SERVER = llamaBase;

    app = express();
    app.use(cors());
    app.use(express.json({ limit: '4mb' }));
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
      getModels,
    });
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    agent = request(`http://127.0.0.1:${port}`);
  });

  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  it('returns OpenAI-style list with manifest-derived ids', async () => {
    const proxied = await agent.get('/models');
    expect(proxied.status).toBe(200);
    expect(proxied.body?.object).toBe('list');
    expect(Array.isArray(proxied.body?.data)).toBe(true);
    expect(proxied.body.data.length).toBeGreaterThan(0);
    for (const entry of proxied.body.data) {
      expect(entry?.object).toBe('model');
      expect(typeof entry?.id).toBe('string');
      expect(entry.id.length).toBeGreaterThan(0);
      expect(entry.id.startsWith('/home')).toBe(false);
      expect(entry.id.includes(':')).toBe(true);
      expect(typeof entry.owned_by).toBe('string');
    }
  });
});
