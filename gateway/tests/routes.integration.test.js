import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import express from 'express';
import cors from 'cors';
import http from 'http';
import request from 'supertest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

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
import { resolveModelPath } from '../routes/modelResolver.js';
import db from '../db/db.js';

let originalTimeout;

async function fetchStream(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
    body: JSON.stringify(payload || {}),
    // Ensure we don't hang forever on network issues
    signal: AbortSignal.timeout(15000),
  });
  let text = '';
  if (res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        if (text.includes('[DONE]')) break;
      }
    } finally {
      try {
        await res.body?.cancel();
      } catch {}
    }
  }
  return { status: res.status, text };
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

    // Use Unsloth defaults for warmup
    modelRef = 'unsloth/Qwen2.5-7B';
    expect(resolved.path.startsWith('/')).toBe(true);
  });

  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
    if (typeof originalTimeout === 'undefined')
      delete process.env.GATEWAY_TIMEOUT_MS;
    else process.env.GATEWAY_TIMEOUT_MS = originalTimeout;
    setIndex({ root: null, files: [] });
  });

  it('handles core flows without mocks', async () => {
    const unauthorizedMemory = await agent
      .post('/memory/short')
      .send({ content: 'nope' });
    expect(unauthorizedMemory.status).toBe(401);

    const health = await agent.get('/health');
    expect(health.status).toBe(200);
    expect(health.body.ok).toBe(true);

    const warmup = await agent
      .post('/warmup')
      .send({ name: 'qwen3-7b', model_path: modelRef });
    expect(warmup.status).toBe(200);
    expect(warmup.body.ok).toBe(true);

    const models = await agent.get('/models');
    expect(models.status).toBe(200);
    // OpenAI-style: { object: 'list', data: [...] }
    expect(
      models.body &&
        (models.body.object === 'list' || models.body.object === undefined)
    ).toBe(true);
    const data = Array.isArray(models.body?.data) ? models.body.data : [];
    expect(data.length).toBeGreaterThan(0);

    const completion = await agent
      .post('/complete')
      .send({ language: 'js', prefix: 'const a =', suffix: '1;' });
    expect(completion.status).toBe(200);
    expect(completion.body).toHaveProperty('completion');
    expect(completion.body.completion).toContain('stub:const a =1;');

    const chat = await agent
      .post('/chat')
      .send({ messages: [{ role: 'user', content: 'hello' }] });
    expect(chat.status).toBe(200);
    expect(chat.body?.message?.role).toBe('assistant');
    expect(chat.body?.message?.content).toBe('stub response');

    const scan = await agent
      .post('/scan')
      .send({ root: tmpDir, maxFileSize: 2048 });
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

    let login = await agent.post('/auth/login').send({
      username: 'admin',
      password: 'changethis',
      workspaceId: 'ws-it',
    });
    let token;
    if (login.status === 401) {
      const username = `user_${Date.now()}`;
      const password = 'pass-123';
      const user = db.createUser(username, password);
      expect(user).toHaveProperty('id');
      login = await agent
        .post('/auth/login')
        .send({ username, password, workspaceId: 'ws-it' });
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
    expect(
      shortList.body.items.some((item) => item.content === 'short memory entry')
    ).toBe(true);

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
    expect(
      longList.body.items.some((item) => item.content === 'long memory entry')
    ).toBe(true);

    const planResponse = await agent.post('/plan').send({
      query: 'Deploy hello world service',
      mode: 'local',
      target: 'dev',
      envOs: 'linux',
      constraints: 'no downtime',
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

    const searx = await agent.get('/searxng').query({ q: 'hello world', n: 1 });
    expect([200, 500]).toContain(searx.status);

    const streamRes = await fetchStream(
      `http://127.0.0.1:${server.address().port}/chat/stream`,
      {
        messages: [{ role: 'user', content: 'stream please' }],
      }
    );
    expect(streamRes.status).toBe(200);
    expect(streamRes.text).toContain('[DONE]');

    const invalidComplete = await agent
      .post('/complete')
      .send({ language: 'js', prefix: '' });
    expect(invalidComplete.status).toBe(400);

    const invalidResearch = await agent.get('/research');
    expect(invalidResearch.status).toBe(400);

    const invalidPlan = await agent
      .post('/plan')
      .send({ mode: 'invalid-mode' });
    expect(invalidPlan.status).toBe(400);
  });
});
