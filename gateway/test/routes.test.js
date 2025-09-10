// gateway/test/routes.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import request from 'supertest';
import express from 'express';
import cors from 'cors';
import { log, getTimeoutMs, escapeRe, scanDirectory } from '../utils.js';
import { OLLAMA, MODEL, MOCK, VERBOSE, LOG_BODY } from '../config.js';
import { getIndex, setIndex } from '../state.js';
import registerRoutes from '../routes/index.js';

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
    const res = await request(app).post('/query').send({ q: 'test', k: 5 });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.hits)).toBe(true);
  });
});
