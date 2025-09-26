// gateway/lib/hw.js
// Detect hardware, resolve GGUF paths, and compute optimized llama.cpp args.

import os from 'os';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

const exf = promisify(execFile);

function isoSeconds(d = new Date()) {
  const t = Math.floor(d.getTime() / 1000) * 1000;
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

async function run(cmd, args = [], opts = {}) {
  try {
    const { stdout, stderr } = await exf(cmd, args, {
      timeout: opts.timeoutMs || 90_000,
    });
    return {
      ok: true,
      stdout: String(stdout || ''),
      stderr: String(stderr || ''),
      code: 0,
    };
  } catch (e) {
    return {
      ok: false,
      stdout: String(e.stdout || ''),
      stderr: String(e.stderr || ''),
      code: e.code ?? -1,
      err: e,
    };
  }
}

async function cmdExists(cmd) {
  const r = await run(cmd, ['--version']);
  return r.ok || /version|help|usage/i.test(r.stdout + r.stderr);
}

function bytes(n) {
  return Math.max(0, Number(n) || 0);
}
function cpuThreads() {
  const n = os.cpus().length;
  return n >= 8 ? n - 1 : n;
}
function guessLayersFromName(p) {
  const s = String(p).toLowerCase();
  if (/(7b|8b)/.test(s)) return 32;
  if (/13b/.test(s)) return 40;
  if (/32b/.test(s)) return 60;
  if (/70b/.test(s)) return 80;
  return 40;
}

async function gpuInfo() {
  // NVIDIA
  if (await cmdExists('nvidia-smi')) {
    const q = [
      '--query-gpu=name,memory.total,compute_cap',
      '--format=csv,noheader',
    ];
    const r = await run('nvidia-smi', q);
    if (r.ok) {
      const lines = r.stdout.trim().split('\n').filter(Boolean);
      const gpus = lines.map((ln, idx) => {
        const m = ln.split(',').map((s) => s.trim());
        const [name, memGiB, cc] = m;
        return {
          vendor: 'nvidia',
          index: idx,
          name,
          memGiB: Number(memGiB.replace(/[^0-9.]/g, '')),
          compute: cc,
        };
      });
      return { type: 'nvidia', gpus };
    }
  }
  // AMD ROCm
  if (await cmdExists('rocminfo')) {
    const r = await run('rocminfo', []);
    const cards = (r.stdout.match(/Name:\s*(gfx[0-9a-z]+)/gi) || []).map(
      (x, i) => ({ vendor: 'amd', index: i, name: x.split(':')[1].trim() })
    );
    return { type: 'amd', gpus: cards };
  }
  // Apple (placeholder)
  if (process.platform === 'darwin') {
    return {
      type: 'apple',
      gpus: [{ vendor: 'apple', index: 0, name: 'Apple GPU', memGiB: 0 }],
    };
  }
  return { type: 'cpu', gpus: [] };
}

function candidateRoots() {
  return [
    process.env.HOME ? `${process.env.HOME}/.ollama/models` : '',
    '/var/snap/ollama/common/models',
    '/usr/share/ollama/.ollama/models',
  ].filter(Boolean);
}

function sanitizeName(s) {
  return String(s)
    .replace(/[/ :]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function resolveFromToken(tok) {
  // absolute?
  if (tok.startsWith('/') && fs.existsSync(tok)) return tok;
  // blob lookup
  for (const root of candidateRoots()) {
    for (const name of [
      tok,
      tok.startsWith('sha256-') ? tok : `sha256-${tok}`,
    ]) {
      const p = `${root}/blobs/${name}`;
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

export async function resolveBaseGGUF(id) {
  // direct path?
  if (id.startsWith('/') && fs.existsSync(id)) return id;
  // peel FROM via ollama
  let cur = id;
  for (let i = 0; i < 4; i++) {
    const r = await run('ollama', ['show', '--modelfile', cur]);
    const mf = r.ok ? r.stdout : '';
    const line = String(mf)
      .split('\n')
      .find((l) => /^FROM\s+/.test(l));
    const tok = line ? line.split(/\s+/)[1] : '';
    if (!tok) {
      await run('ollama', ['pull', cur]);
      continue;
    }
    const maybe = await resolveFromToken(tok);
    if (maybe) return maybe;
    cur = tok; // try another hop
  }
  return null;
}

async function llamaListDevices(cliBin) {
  const r = await run(cliBin, ['--list-devices']);
  if (!r.ok) return null;
  const devs = [];
  const re = /Device\s+(\d+):\s+(.+?),\s+compute capability\s+([0-9.]+)/gi;
  for (;;) {
    const m = re.exec(r.stdout);
    if (!m) break;
    devs.push({ index: +m[1], name: m[2].trim(), compute: m[3] });
  }
  return devs;
}

async function tryNgl(cli, model, ngl) {
  const args = [
    '-m',
    model,
    '--prompt',
    'ping',
    '--n-predict',
    '8',
    '-ngl',
    String(ngl),
    '--no-perf',
  ];
  const r = await run(cli, args, { timeoutMs: 60_000 });
  if (!r.ok) {
    const s = (r.stderr + r.stdout).toLowerCase();
    if (/out of memory|oom|cuda error|failed to malloc|cublas/i.test(s))
      return { ok: false, reason: 'oom' };
    return { ok: false, reason: 'other' };
  }
  return { ok: true };
}

async function findMaxNgl(cli, model, hintLayers = 80) {
  let lo = 0,
    hi = 1,
    lastOK = 0;
  for (;;) {
    if (hi > hintLayers * 2) break;
    const r = await tryNgl(cli, model, hi);
    if (r.ok) {
      lastOK = hi;
      hi *= 2;
    } else {
      break;
    }
  }
  let L = lastOK,
    R = Math.max(lastOK, hi - 1);
  while (L < R) {
    const mid = Math.floor((L + R + 1) / 2);
    const r = await tryNgl(cli, model, mid);
    if (r.ok) L = mid;
    else R = mid - 1;
  }
  return L;
}

export async function optimize({ model, deep = false, quick = false }) {
  if (!model) throw new Error('optimize: model path required');
  const cli = process.env.LLAMACPP_CLI || './llama.cpp/build/bin/llama-cli';
  const hasCli = fs.existsSync(cli);

  const gi = await gpuInfo();
  const gpu = gi.gpus && gi.gpus[0] ? gi.gpus[0] : null;

  const stats = fs.statSync(model);
  const fileMB = Math.round(stats.size / 1024 / 1024);
  const layersGuess = guessLayersFromName(model);
  const memGiB = gpu?.memGiB || 0;

  let ngl = 0;
  if (quick) {
    if (memGiB > 0) {
      const usable = Math.max(0, memGiB - 2) * 1024;
      ngl = Math.max(
        0,
        Math.min(layersGuess, Math.floor((usable / fileMB) * layersGuess))
      );
      if (!Number.isFinite(ngl)) ngl = 0;
    }
  } else if (deep && hasCli) {
    ngl = await findMaxNgl(cli, model, layersGuess);
  } else {
    ngl =
      memGiB >= 24
        ? Math.min(layersGuess, 70)
        : memGiB >= 12
          ? Math.min(layersGuess, 40)
          : 0;
  }

  const threads = cpuThreads();
  const batch =
    gi.type === 'nvidia' && memGiB >= 24
      ? 2048
      : gi.type === 'nvidia' && memGiB >= 12
        ? 1536
        : 1024;
  const ubatch = batch / 2;
  const ctx = memGiB >= 24 ? 8192 : memGiB >= 16 ? 6144 : 4096;
  const env = {};
  if (gi.type === 'nvidia') {
    env.GGML_CUDA_FORCE_MMQ = process.env.GGML_CUDA_FORCE_MMQ || '0';
    env.GGML_CUDA_FORCE_CUBLAS = process.env.GGML_CUDA_FORCE_CUBLAS || '0';
  }

  const now = isoSeconds();
  return {
    id: `hw_${now}`,
    createdAt: now,
    updatedAt: now,
    hardware: gi,
    model,
    fileMB,
    layersGuess,
    threads,
    ctx,
    batch,
    ubatch,
    ngl,
    env,
    recommend: {
      server: {
        cmd:
          process.env.LLAMACPP_SERVER || './llama.cpp/build/bin/llama-server',
        args: [
          '-m',
          model,
          '--host',
          '127.0.0.1',
          '--port',
          '8080',
          '--ctx-size',
          String(ctx),
          '--batch-size',
          String(batch),
          '--ubatch-size',
          String(ubatch),
          '-ngl',
          String(ngl),
          '--threads',
          String(threads),
          '--flash-attn',
          'auto',
        ],
        env,
      },
      cli: {
        cmd: process.env.LLAMACPP_CLI || './llama.cpp/build/bin/llama-cli',
        args: [
          '-m',
          model,
          '--n-predict',
          '64',
          '-ngl',
          String(ngl),
          '--threads',
          String(threads),
          '--flash-attn',
          'auto',
        ],
        env,
      },
      finetune: {
        cmd:
          process.env.LLAMA_FINETUNE || './llama.cpp/build/bin/llama-finetune',
        args: [
          '-m',
          model,
          '--lora-out',
          '/tmp/adapter.gguf',
          '--lora-r',
          '16',
          '--lora-alpha',
          '16',
          '--epochs',
          '1',
          '--seq-len',
          '2048',
          '--lr',
          '1e-4',
        ],
        env,
      },
      m2m: {
        serverHints: {
          temperature: 0.2,
          top_p: 0.8,
          repeat_penalty: 1.05,
          ctx_size: ctx,
          batch,
          ubatch,
        },
        clientDefaults: {
          temperature: 0.2,
          max_tokens: 256,
          presence_penalty: 0.0,
          frequency_penalty: 0.0,
        },
      },
    },
  };
}
