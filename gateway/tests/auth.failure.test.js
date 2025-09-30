import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import cors from 'cors';
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

describe('Auth failures', () => {
  let app;

  beforeAll(() => {
    app = express();
    app.use(cors());
    app.use(express.json({ limit: '2mb' }));

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
  });

  it('rejects missing credentials', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ username: 'user-only' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/username and password required/i);
  });

  it('rejects bad password', async () => {
    const username = `auth_fail_${Date.now()}`;
    db.createUser(username, 'correct-pass');
    const res = await request(app)
      .post('/auth/login')
      .send({ username, password: 'wrong-pass', workspaceId: 'ws1' });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid credentials/i);
  });
});
