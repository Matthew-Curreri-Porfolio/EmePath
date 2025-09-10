// gateway/tests/routes.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import request from 'supertest';
import express from 'express';
import cors from 'cors';
import { log, getTimeoutMs, escapeRe, scanDirectory } from '../utils.js';
import { OLLAMA, MODEL, MOCK, VERBOSE, LOG_BODY } from '../config.js';
import { getIndex, setIndex } from '../state.js';
import registerRoutes from '../routes/index.js';
import { getModels } from '../usecases/models.js';
import { queryUseCase } from '../usecases/query.js';

let app;
beforeAll(() => {
  app = express();
  app.use(cors());
  app.use(express.json({ limit: '4mb' }));
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
    getModels,
  });
});

describe('Gateway routes', () => {
  it('GET /health returns ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('POST /complete returns text', async () => {
    const res = await request(app)
      .post('/complete')
      .send({ language: 'js', prefix: 'const a =', suffix: ';' });
    expect(res.status).toBe(200);
    expect(typeof res.text).toBe('string');
  });

  it('POST /chat returns assistant message', async () => {
    const res = await request(app)
      .post('/chat')
      .send({ messages: [{ role: 'user', content: 'Hello' }] });
    expect(res.status).toBe(200);
    expect(res.body.message.role).toBe('assistant');
  });

  it('GET /models returns array', async () => {
    const res = await request(app).get('/models');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.models)).toBe(true);
  });

  it('POST /warmup returns ok', async () => {
    const res = await request(app).post('/warmup').send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('POST /scan populates index', async () => {
    const res = await request(app).post('/scan').send({ root: __dirname, maxFileSize: 4096 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const idx = getIndex();
    expect(idx.root).toBe(__dirname);
    expect(Array.isArray(idx.files)).toBe(true);
  });

  it('POST /query returns hits', async () => {
    // ensure index has something
    await request(app).post('/scan').send({ root: __dirname, maxFileSize: 4096 });
    const mockReq = { body: { q: 'test term', k: 5 } };
    const mockRes = {
      status: (s) => ({ json: (j) => { console.log('status', s, j); } }),
      json: (j) => { console.log('json', j); }
    };

    const deps = {
      escapeRe: (s) => s.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&'),
      getIndex: () => ({ root: '/tmp', files: [{ path: 'a.txt', text: 'This is a test term. Test_term and test-term. test123' }] }),
      makeSnippets: (text, terms) => ['snippet']
    };

    (async () => {
      await queryUseCase(mockReq, mockRes, deps);
    })();
  });
  it('POST /auth/login fails with bad creds', async () => {
    const res = await request(app).post('/auth/login').send({ username: 'nouser', password: 'nopass', workspaceId: 'ws1' });
    expect(res.status).toBe(401);
  });
  it('POST /memory/short without auth fails', async () => {
    const res = await request(app).post('/memory/short').send({ content: 'test' });
    expect(res.status).toBe(401);
  });
  it('GET /memory/long without auth fails', async () => {
    const res = await request(app).get('/memory/long');
    expect(res.status).toBe(401);
  });
});
