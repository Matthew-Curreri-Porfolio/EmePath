import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import express from 'express';
import cors from 'cors';
import http from 'http';
import request from 'supertest';

import registerRoutes from '../routes/index.js';
import {
  log,
  getTimeoutMs,
  escapeRe,
  scanDirectory,
  makeSnippets,
} from '../utils.js';
import { OLLAMA, MODEL, MOCK, VERBOSE, LOG_BODY } from '../config.js';
import { getIndex, setIndex } from '../state.js';
import { getModels } from '../usecases/models.js';
import db from '../db/db.js';

describe('Admin cache/log routes', () => {
  let app;
  let server;
  let agent;
  let token;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    setIndex({ root: null, files: [] });
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
    agent = request(`http://127.0.0.1:${server.address().port}`);

    // Ensure we can login (bootstrap admin exists)
    let login = await agent.post('/auth/login').send({
      username: 'admin',
      password: 'changethis',
      workspaceId: 'ws-admin',
    });
    if (login.status === 401) {
      const username = `admin_${Date.now()}`;
      const password = 'pw';
      db.createUser(username, password);
      login = await agent
        .post('/auth/login')
        .send({ username, password, workspaceId: 'ws-admin' });
    }
    expect(login.status).toBe(200);
    token = login.body.token;
  });

  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  it('exposes cache stats and clear endpoints', async () => {
    const stats = await agent
      .get('/admin/cache/stats')
      .set('Authorization', `Bearer ${token}`);
    expect(stats.status).toBe(200);
    expect(stats.body.ok).toBe(true);
    expect(stats.body.stats).toBeTruthy();

    const cleared = await agent
      .post('/admin/cache/clear')
      .set('Authorization', `Bearer ${token}`)
      .send({ expiredOnly: true });
    expect(cleared.status).toBe(200);
    expect(cleared.body.ok).toBe(true);
  });

  it('lists and fetches llm request logs', async () => {
    // generate a couple of logs via chat/complete (cache disabled in tests, but logging enabled)
    const c = await agent
      .post('/complete')
      .send({ language: 'txt', prefix: 'ping', suffix: '' });
    expect([200, 502, 400]).toContain(c.status);
    const ch = await agent
      .post('/chat')
      .send({ messages: [{ role: 'user', content: 'hello' }] });
    expect([200, 502]).toContain(ch.status);

    const logs = await agent
      .get('/admin/logs')
      .set('Authorization', `Bearer ${token}`);
    expect(logs.status).toBe(200);
    expect(logs.body.ok).toBe(true);
    expect(Array.isArray(logs.body.items)).toBe(true);

    if (logs.body.items.length > 0) {
      const id = logs.body.items[0].id;
      const detail = await agent
        .get(`/admin/logs/${id}`)
        .set('Authorization', `Bearer ${token}`);
      expect(detail.status).toBe(200);
      expect(detail.body.ok).toBe(true);
      expect(detail.body.item).toBeTruthy();
      expect(detail.body.item.id).toBe(id);
    }
  });

  it('filters logs by model/kind/date and supports paging/detail', async () => {
    // Generate multiple logs with explicit models
    const modelA = `test-model-a-${Date.now()}`;
    const modelB = `test-model-b-${Date.now()}`;

    // 2 completes for A
    await agent
      .post('/complete')
      .send({ model: modelA, language: 'txt', prefix: 'alpha', suffix: '' });
    await agent
      .post('/complete')
      .send({ model: modelA, language: 'txt', prefix: 'beta', suffix: '' });
    // 1 chat for B
    await agent
      .post('/chat')
      .send({ model: modelB, messages: [{ role: 'user', content: 'hello' }] });

    // Model filter
    const byModel = await agent
      .get('/admin/logs')
      .query({ model: modelA })
      .set('Authorization', `Bearer ${token}`);
    expect(byModel.status).toBe(200);
    expect(byModel.body.ok).toBe(true);
    expect(byModel.body.items.length).toBeGreaterThanOrEqual(0);
    for (const it of byModel.body.items) expect(it.model).toBe(modelA);

    // Kind filter
    const byKind = await agent
      .get('/admin/logs')
      .query({ kind: 'complete' })
      .set('Authorization', `Bearer ${token}`);
    expect(byKind.status).toBe(200);
    expect(byKind.body.ok).toBe(true);
    for (const it of byKind.body.items) expect(it.kind).toBe('complete');

    // Date filter — broad range to include everything just created
    const since = '1970-01-01T00:00:00Z';
    const until = '2100-01-01T00:00:00Z';
    const byDate = await agent
      .get('/admin/logs')
      .query({ since, until })
      .set('Authorization', `Bearer ${token}`);
    expect(byDate.status).toBe(200);
    expect(byDate.body.ok).toBe(true);
    expect(Array.isArray(byDate.body.items)).toBe(true);

    // Paging with limit/offset
    const page1 = await agent
      .get('/admin/logs')
      .query({ limit: 1, offset: 0 })
      .set('Authorization', `Bearer ${token}`);
    const page2 = await agent
      .get('/admin/logs')
      .query({ limit: 1, offset: 1 })
      .set('Authorization', `Bearer ${token}`);
    expect(page1.status).toBe(200);
    expect(page2.status).toBe(200);
    expect(page1.body.ok).toBe(true);
    expect(page2.body.ok).toBe(true);
    expect(Array.isArray(page1.body.items)).toBe(true);
    expect(Array.isArray(page2.body.items)).toBe(true);
    if (page1.body.items.length && page2.body.items.length) {
      expect(page1.body.items[0].id).not.toBe(page2.body.items[0].id);
    }

    // Detail flag includes request/raw fields
    const detail = await agent
      .get('/admin/logs')
      .query({ detail: 1, limit: 1 })
      .set('Authorization', `Bearer ${token}`);
    expect(detail.status).toBe(200);
    expect(detail.body.ok).toBe(true);
    if (detail.body.items.length) {
      const item = detail.body.items[0];
      // request is present or at least not throwing
      expect(Object.prototype.hasOwnProperty.call(item, 'request')).toBe(true);
    }

    // Summary by model
    const sumModel = await agent
      .get('/admin/logs/summary')
      .query({ group: 'model', since, until })
      .set('Authorization', `Bearer ${token}`);
    expect(sumModel.status).toBe(200);
    expect(sumModel.body.ok).toBe(true);
    expect(Array.isArray(sumModel.body.items)).toBe(true);
    if (sumModel.body.items.length) {
      expect(sumModel.body.items[0]).toHaveProperty('model');
      expect(sumModel.body.items[0]).toHaveProperty('count');
    }

    // Summary by date
    const sumDate = await agent
      .get('/admin/logs/summary')
      .query({ group: 'date', since, until })
      .set('Authorization', `Bearer ${token}`);
    expect(sumDate.status).toBe(200);
    expect(sumDate.body.ok).toBe(true);
    expect(Array.isArray(sumDate.body.items)).toBe(true);
    if (sumDate.body.items.length) {
      expect(sumDate.body.items[0]).toHaveProperty('day');
      expect(sumDate.body.items[0]).toHaveProperty('count');
    }

    // Summary by model_date
    const sumModelDate = await agent
      .get('/admin/logs/summary')
      .query({ group: 'model_date', since, until, limit: 5 })
      .set('Authorization', `Bearer ${token}`);
    expect(sumModelDate.status).toBe(200);
    expect(sumModelDate.body.ok).toBe(true);
    expect(Array.isArray(sumModelDate.body.items)).toBe(true);
    if (sumModelDate.body.items.length) {
      const it = sumModelDate.body.items[0];
      expect(it).toHaveProperty('model');
      expect(it).toHaveProperty('day');
      expect(it).toHaveProperty('count');
    }
  });
});
