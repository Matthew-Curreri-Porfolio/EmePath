import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import express from 'express';
import cors from 'cors';
import http from 'http';
import request from 'supertest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

import registerRoutes from '../routes/index.js';
import { log, getTimeoutMs, escapeRe, scanDirectory, makeSnippets } from '../utils.js';
import { OLLAMA, MODEL, MOCK, VERBOSE, LOG_BODY } from '../config.js';
import { getIndex, setIndex } from '../state.js';
import { getModels } from '../usecases/models.js';
import { resolveModelPath } from '../routes/modelResolver.js';

const llamaStub = globalThis.__LLAMA_STUB__;
if (!llamaStub || !llamaStub.port) {
  throw new Error('LLAMA stub server must be initialised via tests/setup/start-llama-server.js');
}

describe('Gateway routes integration', () => {
  let app;
  let server;
  let agent;
  let tmpDir;
  let modelRef;

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
    process.env.PORT = String(port);
    agent = request(`http://127.0.0.1:${port}`);

    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-routes-'));
    await fs.writeFile(path.join(tmpDir, 'sample.txt'), 'This file proves llama gateways scan directories.');

    // Pick a known Ollama-style identifier and assert the resolver succeeds.
    modelRef = 'SimonPu/gpt-oss:20b_Q4_K_M';
    const resolved = resolveModelPath(modelRef);
    expect(resolved?.path).toBeTruthy();
    expect(resolved.path.startsWith('/')).toBe(true);
  });

  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
    setIndex({ root: null, files: [] });
  });

  it('handles core flows without mocks', async () => {
    const health = await agent.get('/health');
    expect(health.status).toBe(200);
    expect(health.body.ok).toBe(true);

    const warmup = await agent.post('/warmup').send({ model: modelRef });
    expect(warmup.status).toBe(200);
    expect(warmup.body.ok).toBe(true);

    const models = await agent.get('/models');
    expect(models.status).toBe(200);
    expect(Array.isArray(models.body.models)).toBe(true);
    expect(models.body.models.length).toBeGreaterThan(0);

    const completion = await agent.post('/complete').send({ language: 'js', prefix: 'const a =', suffix: '1;' });
    expect(completion.status).toBe(200);
    expect(completion.body).toHaveProperty('completion');
    expect(typeof completion.body.completion).toBe('string');

    const chat = await agent.post('/chat').send({ messages: [{ role: 'user', content: 'hello' }] });
    expect(chat.status).toBe(200);
    expect(chat.body?.message?.role).toBe('assistant');

    const scan = await agent.post('/scan').send({ root: tmpDir, maxFileSize: 2048 });
    expect(scan.status).toBe(200);
    expect(scan.body.ok).toBe(true);
    expect(scan.body.count).toBeGreaterThan(0);

    const query = await agent.post('/query').send({ q: 'llama', k: 5 });
    expect(query.status).toBe(200);
    expect(query.body.ok).toBe(true);
    expect(Array.isArray(query.body.hits)).toBe(true);
    expect(query.body.hits.length).toBeGreaterThan(0);

    const toolcall = await agent.post('/toolcall').send({
      tool: 'health-check',
      method: 'GET',
      endpoint: '/health',
    });
    expect(toolcall.status).toBe(200);
    expect(toolcall.body.ok).toBe(true);
    expect(toolcall.body.result?.ok).toBe(true);

    const login = await agent.post('/auth/login').send({ username: 'admin', password: 'changethis', workspaceId: 'ws-it' });
    expect([200, 401]).toContain(login.status);
    if (login.status === 200) {
      expect(login.body.token).toBeDefined();
    }
  });
});
