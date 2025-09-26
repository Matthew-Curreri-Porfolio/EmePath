import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import cors from 'cors';
import http from 'http';
import request from 'supertest';

import registerRoutes from '../routes/index.js';
import { log, getTimeoutMs, escapeRe, scanDirectory, makeSnippets } from '../utils.js';
import { OLLAMA, MODEL, MOCK, VERBOSE, LOG_BODY } from '../config.js';
import { getIndex, setIndex } from '../state.js';
import { getModels } from '../usecases/models.js';
import db from '../db/db.js';

describe('Projects routes', () => {
  let app;
  let server;
  let agent;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.MOCK = '0';
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
    const { port } = server.address();
    agent = request(`http://127.0.0.1:${port}`);
  });

  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  it('creates, lists, and toggles project active flag', async () => {
    // Login (use default admin or create a temp user)
    let login = await agent.post('/auth/login').send({ username: 'admin', password: 'changethis', workspaceId: 'ws-proj' });
    if (login.status === 401) {
      const username = `user_${Date.now()}`;
      const password = 'pass-123';
      db.createUser(username, password);
      login = await agent.post('/auth/login').send({ username, password, workspaceId: 'ws-proj' });
    }
    expect(login.status).toBe(200);
    const token = login.body.token;
    expect(typeof token).toBe('string');

    // Create
    const createRes = await agent
      .post('/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'alpha', description: 'first project' });
    expect(createRes.status).toBe(200);
    expect(createRes.body.ok).toBe(true);
    expect(createRes.body.project?.name).toBe('alpha');
    const id = createRes.body.project?.id;
    expect(typeof id).toBe('number');

    // Active list contains it
    const listActive = await agent
      .get('/projects/active')
      .set('Authorization', `Bearer ${token}`);
    expect(listActive.status).toBe(200);
    expect(listActive.body.ok).toBe(true);
    expect(Array.isArray(listActive.body.items)).toBe(true);
    expect(listActive.body.items.some(p => p.name === 'alpha' && p.active === true)).toBe(true);

    // Toggle inactive
    const toggle = await agent
      .patch(`/projects/${id}/active`)
      .set('Authorization', `Bearer ${token}`)
      .send({ active: false });
    expect(toggle.status).toBe(200);
    expect(toggle.body.ok).toBe(true);
    expect(toggle.body.project.active).toBe(false);

    // Inactive list contains it
    const listInactive = await agent
      .get('/projects/inactive')
      .set('Authorization', `Bearer ${token}`);
    expect(listInactive.status).toBe(200);
    expect(listInactive.body.ok).toBe(true);
    expect(listInactive.body.items.some(p => p.name === 'alpha' && p.active === false)).toBe(true);

    // All-in-scope list contains it regardless of active flag
    const listAll = await agent
      .get('/projects')
      .set('Authorization', `Bearer ${token}`);
    expect(listAll.status).toBe(200);
    expect(listAll.body.ok).toBe(true);
    expect(listAll.body.items.some(p => p.name === 'alpha')).toBe(true);

    // Creating duplicate name should 409
    const dup = await agent
      .post('/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'alpha' });
    expect(dup.status).toBe(409);
  });
});
