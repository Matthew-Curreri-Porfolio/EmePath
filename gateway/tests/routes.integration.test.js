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
import db from '../db/db.js';

const llamaStub = globalThis.__LLAMA_STUB__;
if (!llamaStub || !llamaStub.port) {
  throw new Error('LLAMA stub server must be initialised via tests/setup/start-llama-server.js');
}

const stubBase = `http://127.0.0.1:${llamaStub.port}`;
let originalTimeout;

async function setStubFixture(patch) {
  await fetch(`${stubBase}/__fixture`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch || {}),
  });
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
    originalTimeout = process.env.GATEWAY_TIMEOUT_MS;
    process.env.GATEWAY_TIMEOUT_MS = '2000';

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
    await fs.writeFile(
      path.join(tmpDir, 'runbook.txt'),
      'hello world deployment plan using llama tools\nstep 1: build artifact\nstep 2: deploy service\nstep 3: verify success'
    );

    await setStubFixture({ reset: true });

    // Pick a known Ollama-style identifier and assert the resolver succeeds.
    modelRef = 'SimonPu/gpt-oss:20b_Q4_K_M';
    const resolved = resolveModelPath(modelRef);
    expect(resolved?.path).toBeTruthy();
    expect(resolved.path.startsWith('/')).toBe(true);
  });

  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
    if (typeof originalTimeout === 'undefined') delete process.env.GATEWAY_TIMEOUT_MS;
    else process.env.GATEWAY_TIMEOUT_MS = originalTimeout;
    setIndex({ root: null, files: [] });
  });

  it('handles core flows without mocks', async () => {
    const unauthorizedMemory = await agent.post('/memory/short').send({ content: 'nope' });
    expect(unauthorizedMemory.status).toBe(401);

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
    expect(completion.body.completion).toContain('stub:const a =1;');

    const chat = await agent.post('/chat').send({ messages: [{ role: 'user', content: 'hello' }] });
    expect(chat.status).toBe(200);
    expect(chat.body?.message?.role).toBe('assistant');
    expect(chat.body?.message?.content).toBe('stub response');

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

    const metrics = await agent.get('/metrics');
    expect(metrics.status).toBe(200);
    expect(metrics.text).toContain('http_request_duration_ms');

    const ready = await agent.get('/ready');
    expect([200, 503]).toContain(ready.status);

    let login = await agent.post('/auth/login').send({ username: 'admin', password: 'changethis', workspaceId: 'ws-it' });
    let token;
    if (login.status === 401) {
      const username = `user_${Date.now()}`;
      const password = 'pass-123';
      const user = db.createUser(username, password);
      expect(user).toHaveProperty('id');
      login = await agent.post('/auth/login').send({ username, password, workspaceId: 'ws-it' });
    }
    expect(login.status).toBe(200);
    token = login.body.token;
    expect(typeof token).toBe('string');

    const shortWrite = await agent
      .post('/memory/short')
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'short memory entry' });
    expect(shortWrite.status).toBe(200);
    expect(shortWrite.body.ok).toBe(true);

    const shortList = await agent
      .get('/memory/short')
      .set('Authorization', `Bearer ${token}`);
    expect(shortList.status).toBe(200);
    expect(shortList.body.items.some((item) => item.content === 'short memory entry')).toBe(true);

    const longWrite = await agent
      .post('/memory/long')
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'long memory entry' });
    expect(longWrite.status).toBe(200);
    expect(longWrite.body.ok).toBe(true);

    const longList = await agent
      .get('/memory/long')
      .set('Authorization', `Bearer ${token}`);
    expect(longList.status).toBe(200);
    expect(longList.body.items.some((item) => item.content === 'long memory entry')).toBe(true);

    const planResponse = await agent.post('/plan').send({
      query: 'Deploy hello world service',
      mode: 'local',
      target: 'dev',
      envOs: 'linux',
      constraints: 'no downtime'
    });
    if (planResponse.status === 200) {
      expect(planResponse.body.ok).toBe(true);
      expect(Array.isArray(planResponse.body.plan?.steps)).toBe(true);
    } else {
      expect([400, 500]).toContain(planResponse.status);
    }

    const researchResponse = await agent
      .get('/research')
      .query({ query: 'hello world deployment', mode: 'local' });
    if (researchResponse.status === 200) {
      expect(researchResponse.body.ok).toBe(true);
    } else {
      expect([400, 500]).toContain(researchResponse.status);
    }

    const insightsResponse = await agent
      .get('/insights')
      .query({ query: 'hello world deployment', mode: 'local' });
    if (insightsResponse.status === 200) {
      expect(insightsResponse.body.ok).toBe(true);
    } else {
      expect([400, 500]).toContain(insightsResponse.status);
    }

    const whoogle = await agent
      .get('/whoogle')
      .query({ q: 'hello world', n: 1 });
    expect([200, 500]).toContain(whoogle.status);

    await setStubFixture({ chat_stream_chunks: ['chunk-one', ' chunk-two'] });
    const streamRes = await agent
      .post('/chat/stream')
      .set('Accept', 'text/event-stream')
      .send({ messages: [{ role: 'user', content: 'stream please' }] });
    expect(streamRes.status).toBe(200);
    expect(streamRes.text).toContain('chunk-one');
    expect(streamRes.text).toContain('[DONE]');

    await setStubFixture({ chat_status: 500 });
    const streamFail = await agent
      .post('/chat/stream')
      .set('Accept', 'text/event-stream')
      .send({ messages: [{ role: 'user', content: 'stream fail' }] });
    expect(streamFail.status).toBe(502);

    await setStubFixture({ chat_timeout: true });
    const streamTimeout = await agent
      .post('/chat/stream')
      .set('Accept', 'text/event-stream')
      .send({ messages: [{ role: 'user', content: 'stream timeout' }] });
    expect([502, 504]).toContain(streamTimeout.status);

    await setStubFixture({ reset: true });

    await setStubFixture({ completion_status: 500 });
    const failingComplete = await agent.post('/complete').send({ language: 'js', prefix: 'const a =', suffix: '1;' });
    expect(failingComplete.status).toBe(502);

    await setStubFixture({ completion_timeout: true });
    const timeoutComplete = await agent.post('/complete').send({ language: 'js', prefix: 'const a =', suffix: '1;' });
    expect([502, 504]).toContain(timeoutComplete.status);

    await setStubFixture({ reset: true });

    const invalidComplete = await agent.post('/complete').send({ language: 'js', prefix: '' });
    expect(invalidComplete.status).toBe(400);

    const invalidResearch = await agent.get('/research');
    expect(invalidResearch.status).toBe(400);

    const invalidPlan = await agent.post('/plan').send({ mode: 'invalid-mode' });
    expect(invalidPlan.status).toBe(400);
  });
});
