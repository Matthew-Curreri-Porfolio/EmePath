#!/usr/bin/env node
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const stubPath = path.resolve(__dirname, '..', 'tests', 'setup', 'llama_stub.py');

const args = process.argv.slice(2);
const env = {
  ...process.env,
  LLAMA_STUB_HOST: process.env.LLAMA_STUB_HOST || '127.0.0.1',
  LLAMA_STUB_PORT: process.env.LLAMA_STUB_PORT || '0',
};

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--fixture' && args[i + 1]) {
    env.LLAMA_STUB_FIXTURES = path.resolve(process.cwd(), args[i + 1]);
    i += 1;
  } else if (arg === '--completion-text' && args[i + 1]) {
    env.LLAMA_STUB_COMPLETION_TEXT = args[i + 1];
    i += 1;
  } else if (arg === '--chat-content' && args[i + 1]) {
    env.LLAMA_STUB_CHAT_CONTENT = args[i + 1];
    i += 1;
  } else if (arg === '--completion-status' && args[i + 1]) {
    env.LLAMA_STUB_COMPLETION_STATUS = args[i + 1];
    i += 1;
  } else if (arg === '--chat-status' && args[i + 1]) {
    env.LLAMA_STUB_CHAT_STATUS = args[i + 1];
    i += 1;
  } else if (arg === '--models' && args[i + 1]) {
    env.LLAMA_STUB_MODELS = args[i + 1];
    i += 1;
  } else if (arg === '--delay-completion' && args[i + 1]) {
    env.LLAMA_STUB_COMPLETION_DELAY = args[i + 1];
    i += 1;
  } else if (arg === '--delay-chat' && args[i + 1]) {
    env.LLAMA_STUB_CHAT_DELAY = args[i + 1];
    i += 1;
  } else if (arg === '--timeout-completion') {
    env.LLAMA_STUB_COMPLETION_TIMEOUT = '1';
  } else if (arg === '--timeout-chat') {
    env.LLAMA_STUB_CHAT_TIMEOUT = '1';
  } else if (arg === '--env' && args[i + 1]) {
    const kv = args[i + 1];
    const eqIdx = kv.indexOf('=');
    if (eqIdx > 0) {
      const key = kv.slice(0, eqIdx);
      const value = kv.slice(eqIdx + 1);
      env[key] = value;
    }
    i += 1;
  }
}

const child = spawn('python3', [stubPath], {
  stdio: ['ignore', 'pipe', 'inherit'],
  env,
});

const cleanup = () => {
  try { child.kill('SIGTERM'); } catch {}
};

process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });
process.on('exit', cleanup);

child.once('error', (err) => {
  console.error('[llama-stub] failed to start:', err);
  process.exit(1);
});

child.stdout.once('data', (data) => {
  try {
    const line = data.toString().split('\n')[0].trim();
    const info = JSON.parse(line);
    if (!info.port) throw new Error('missing port');
    const url = `http://127.0.0.1:${info.port}`;
    console.log(`[llama-stub] listening on ${url}`);
    console.log(`[llama-stub] export LLAMACPP_SERVER=${url}`);
  } catch (err) {
    console.error('[llama-stub] unable to parse startup message:', err);
    child.kill('SIGTERM');
    process.exit(1);
  }
});

// keep process alive while stub runs
setInterval(() => {
  if (child.killed) process.exit(0);
}, 1000);
