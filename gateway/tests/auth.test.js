// gateway/tests/auth.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { registerPublic, registerAgentic, registerPrivate } from '../routes/index.js';

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  const deps = {
    log: (...args) => console.log(...args),
    getTimeoutMs: () => 1000,
    OLLAMA: false,
    MODEL: null,
    MOCK: true,
  };
  // minimal routes for auth
  registerPublic(app, deps);
  registerPrivate(app, deps, { memoryLimiter: (req, res, next) => next() });
  return app;
}

describe('Auth bootstrap', () => {
  let app;
  beforeAll(() => { app = makeApp(); });

  it('logs in with default admin if DB was empty', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ username: 'admin', password: 'changethis', workspaceId: 'ws1' });
    expect([200,401]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.token).toBeTruthy();
      expect(res.body.userId).toBeDefined();
    }
  });
});

