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

describe('DB auth and memory', () => {
  const username = 'testuser';
  const password = 'secret';
  let token;
  it('creates user and logs in', async () => {
    const { createUser, getUserByUsername } = await import('../db/db.js');
    const user = createUser(username, password);
    expect(user).toHaveProperty('id');
    const fetched = getUserByUsername(username);
    expect(fetched).toBeTruthy();
    expect(fetched.username).toBe(username);
    const res = await request(app)
      .post('/auth/login')
      .send({ username, password, workspaceId: 'ws1' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
    token = res.body.token;
  });
  it('short term memory CRUD', async () => {
    const content = 'short memory content';
    const resSet = await request(app)
      .post('/memory/short')
      .set('Authorization', `Bearer ${token}`)
      .send({ content });
    expect(resSet.status).toBe(200);
    const resGet = await request(app)
      .get('/memory/short')
      .set('Authorization', `Bearer ${token}`);
    expect(resGet.status).toBe(200);
    expect(resGet.body.content).toBe(content);
  });
  it('long term memory CRUD', async () => {
    const content = 'long memory content';
    const resSet = await request(app)
      .post('/memory/long')
      .set('Authorization', `Bearer ${token}`)
      .send({ content });
    expect(resSet.status).toBe(200);
    const resGet = await request(app)
      .get('/memory/long')
      .set('Authorization', `Bearer ${token}`);
    expect(resGet.status).toBe(200);
    expect(resGet.body.content).toBe(content);
  });
});
