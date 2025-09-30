import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import registerRoutes from '../routes/index.js';

const app = (() => {
  const a = express();
  a.use(express.json());
  const deps = {
    log: () => {},
    getTimeoutMs: () => 1000,
    escapeRe: (s) => s,
    scanDirectory: () => [],
    makeSnippets: () => [],
    OLLAMA: undefined,
    MODEL: undefined,
    MOCK: true,
    getIndex: () => undefined,
    setIndex: () => {},
  };
  registerRoutes(a, deps);
  return a;
})();

describe('parseLLMResponse middleware (test route)', () => {
  it('extracts JSON from fenced block after @gateway_usage.json and cleans text', async () => {
    const raw = [
      'Hello world',
      '',
      '@gateway_usage.json',
      '```json',
      '{ "endpoints": ["chat.chat"], "inputs": {"a":1} }',
      '```',
      'Thanks!',
    ].join('\n');
    const res = await request(app)
      .post('/__test/parse')
      .send({ text: raw })
      .expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.usage).toEqual({ endpoints: ['chat.chat'], inputs: { a: 1 } });
    expect(res.body.text).toBe('Hello world\n\nThanks!');
  });

  it('extracts JSON from code fence with language gateway_usage.json', async () => {
    const raw = [
      'Please see:',
      '```gateway_usage.json',
      '{"x": 1}',
      '```',
      'End.',
    ].join('\n');
    const res = await request(app)
      .post('/__test/parse')
      .send({ text: raw })
      .expect(200);
    expect(res.body.usage).toEqual({ x: 1 });
    expect(res.body.text).toBe('Please see:\n\nEnd.');
  });

  it('extracts inline JSON after marker and removes trailing block', async () => {
    const raw = 'Answer first. @gateway_usage.json {"k":true} trailing.';
    const res = await request(app)
      .post('/__test/parse')
      .send({ text: raw })
      .expect(200);
    expect(res.body.usage).toEqual({ k: true });
    expect(res.body.text).toBe('Answer first.');
  });

  it('passes through when no usage block is present', async () => {
    const raw = 'Just a normal reply with no tools.';
    const res = await request(app)
      .post('/__test/parse')
      .send({ text: raw })
      .expect(200);
    expect(res.body.usage).toBeNull();
    expect(res.body.text).toBe(raw);
  });
});
