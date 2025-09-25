// RAX1 encoder with Python bridge, falling back to stub JSON if Python is unavailable.
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function toUint8Array(str) { return new TextEncoder().encode(str); }
function fromUint8Array(bytes) { return new TextDecoder().decode(bytes); }

function resolvePythonBin() {
  const explicit = process.env.GATEWAY_PYTHON || process.env.PYTHON;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const condaPy = '/home/hmagent/miniconda3/envs/gateway/bin/python';
  try { if (fs.existsSync(condaPy)) return condaPy; } catch {}
  return 'python3';
}

function runPython(args, stdinStr) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.resolve(__dirname, '../../tools/rax1_codec.py');
    const pyCmd = resolvePythonBin();
    const child = spawn(pyCmd, [scriptPath, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve(out);
      const e = new Error(`rax1 python exited ${code}: ${err || out}`);
      e.stdout = out; e.stderr = err; e.code = code; reject(e);
    });
    if (stdinStr) child.stdin.write(stdinStr);
    child.stdin.end();
  });
}

async function encodePython(state) {
  const text = typeof state === 'string' ? state : String(state?.content || '');
  const out = await runPython(['--encode'], text);
  const payload = out.trim();
  const meta = { version: 1, format: 'rax1-json', codec: 'rax1' };
  return { bytes: toUint8Array(payload), meta };
}

async function decodePython(bytes) {
  const jsonStr = fromUint8Array(bytes);
  const out = await runPython(['--decode'], jsonStr);
  return { content: out };
}

export async function encode(state) {
  try {
    return await encodePython(state);
  } catch {
    // Fallback: JSON UTF-8 of state
    const json = JSON.stringify(state ?? {});
    return { bytes: toUint8Array(json), meta: { version: 1, format: 'json-utf8-stub' } };
  }
}

export async function decode(bytes, meta) {
  try {
    if (meta && meta.format === 'rax1-json') {
      return await decodePython(bytes);
    }
  } catch {
    // noop; fallback to JSON below
  }
  if (!bytes) return {};
  try { return JSON.parse(fromUint8Array(bytes)); } catch { return {}; }
}

export default { encode, decode };
