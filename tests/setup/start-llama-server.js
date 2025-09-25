import { spawn } from 'child_process';
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const scriptPath = path.resolve(__dirname, 'llama_stub.py');

function resolvePython() {
  // Priority: explicit override -> conda gateway env -> PYTHON -> python3
  const explicit = process.env.GATEWAY_PYTHON || process.env.PYTHON;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const condaPy = '/home/hmagent/miniconda3/envs/gateway/bin/python';
  try { if (fs.existsSync(condaPy)) return condaPy; } catch {}
  return 'python3';
}
const PY_BIN = resolvePython();

const child = spawn(PY_BIN, [scriptPath], {
  env: {
    ...process.env,
    LLAMA_STUB_HOST: '127.0.0.1',
    LLAMA_STUB_PORT: '0',
  },
  stdio: ['ignore', 'pipe', 'inherit'],
});

const port = await new Promise((resolve, reject) => {
  let buf = '';
  const cleanup = () => {
    child.stdout.off('data', onData);
    child.off('error', onError);
    child.off('exit', onExit);
  };
  const onData = (data) => {
    buf += data.toString();
    const nl = buf.indexOf('\n');
    if (nl === -1) return;
    const line = buf.slice(0, nl);
    try {
      const parsed = JSON.parse(line.trim() || '{}');
      if (!parsed.port) throw new Error('missing port');
      cleanup();
      resolve(parsed.port);
    } catch (err) {
      cleanup();
      reject(err);
    }
  };
  const onError = (err) => {
    cleanup();
    reject(err instanceof Error ? err : new Error(String(err)));
  };
  const onExit = (code) => {
    cleanup();
    reject(new Error(`llama_stub.py exited before reporting port (code ${code})`));
  };
  child.stdout.on('data', onData);
  child.once('error', onError);
  child.once('exit', onExit);
});

process.env.LLAMACPP_SERVER = `http://127.0.0.1:${port}`;

globalThis.__LLAMA_STUB__ = { port, child };

const shutdown = () => {
  try { child.kill('SIGTERM'); } catch {}
};

process.once('exit', shutdown);
process.once('SIGINT', () => { shutdown(); process.exit(130); });
process.once('SIGTERM', () => { shutdown(); process.exit(143); });
