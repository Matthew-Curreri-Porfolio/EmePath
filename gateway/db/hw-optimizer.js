#!/usr/bin/env node
// gateway/db/hw-optimizer.js
// Hardware & runtime optimizer for llama.cpp (server/cli/finetune) and model-to-model profiles.
// Usage examples:
//   node gateway/db/hw-optimizer.js --model /abs/path/model.gguf --mode server --quick
//   node gateway/db/hw-optimizer.js --model /abs/path/model.gguf --mode server --deep --port 8080 --host 127.0.0.1
//   node gateway/db/hw-optimizer.js --model /abs/path/model.gguf --mode finetune --epochs 1
//   LLAMACPP_MODEL_PATH=/abs/path/model.gguf node gateway/db/hw-optimizer.js --mode m2m --quick --print-cmd

import os from 'os';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
const exf = promisify(execFile);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isLinux = process.platform === 'linux';
const isMac = process.platform === 'darwin';
const toInt = (x, d = 0) => (Number.isFinite(+x) ? +x | 0 : d);

function argParse() {
  const a = process.argv.slice(2);
  const out = {
    mode: 'server',
    quick: false,
    deep: false,
    host: '127.0.0.1',
    port: 8080,
  };
  for (let i = 0; i < a.length; i++) {
    const k = a[i];
    if (k === '--model') {
      out.model = a[++i];
    } else if (k === '--mode') {
      out.mode = a[++i];
    } // server|cli|finetune|m2m
    else if (k === '--quick') {
      out.quick = true;
    } else if (k === '--deep') {
      out.deep = true;
    } else if (k === '--host') {
      out.host = a[++i];
    } else if (k === '--port') {
      out.port = toInt(a[++i], 8080);
    } else if (k === '--epochs') {
      out.epochs = toInt(a[++i], 1);
    } else if (k === '--rank') {
      out.rank = toInt(a[++i], 16);
    } else if (k === '--alpha') {
      out.alpha = toInt(a[++i], 16);
    } else if (k === '--seq-len') {
      out.seqLen = toInt(a[++i], 2048);
    } else if (k === '--write') {
      out.write = a[++i];
    } else if (k === '--print-cmd') {
      out.printCmd = true;
    }
  }
  if (!out.model) out.model = process.env.LLAMACPP_MODEL_PATH;
  return out;
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

function guessLayersFromName(p) {
  const s = String(p).toLowerCase();
  if (/(7b|8b)/.test(s)) return 32;
  if (/13b/.test(s)) return 40;
  if (/32b/.test(s)) return 60;
  if (/70b/.test(s)) return 80;
  return 40; // safe-ish default
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
    return { type: 'amd', gpus: cards, raw: r.stdout.slice(0, 5000) };
  }
  // Apple
  if (isMac) {
    return {
      type: 'apple',
      gpus: [{ vendor: 'apple', index: 0, name: 'Apple GPU' }],
    };
  }
  return { type: 'cpu', gpus: [] };
}

async function llamaListDevices(cli) {
  if (!(await cmdExists(cli))) return null;
  const r = await run(cli, ['--list-devices']);
  if (!r.ok) return null;
  // Parse lines like: "Device 0: NVIDIA GeForce RTX 4090, compute capability 8.9"
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
  // Expand up until fail, then binary-search back
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
  // Binary search between lastOK..(hi-1)
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

function cpuThreads() {
  const n = os.cpus().length;
  // Leave one core free for OS if many cores
  return n >= 8 ? n - 1 : n;
}

function recommendBatchUbatch(memGiB, vendor) {
  if (vendor === 'nvidia' && memGiB >= 24) return { batch: 2048, ubatch: 1024 };
  if (vendor === 'nvidia' && memGiB >= 12) return { batch: 1536, ubatch: 768 };
  if (vendor === 'amd' && memGiB >= 24) return { batch: 1536, ubatch: 768 };
  return { batch: 1024, ubatch: 512 };
}

function recommendCtx(memGiB) {
  if (memGiB >= 24) return 8192;
  if (memGiB >= 16) return 6144;
  return 4096;
}

function sanitizeName(s) {
  return String(s)
    .replace(/[/ :]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function main() {
  const args = argParse();
  if (!args.model || !fs.existsSync(args.model)) {
    console.error(
      'ERROR: --model /abs/path/model.gguf is required (or env LLAMACPP_MODEL_PATH).'
    );
    process.exit(2);
  }

  const llamaCli =
    process.env.LLAMACPP_CLI || './llama.cpp/build/bin/llama-cli';
  const hasCli = await cmdExists(llamaCli);

  const gi = await gpuInfo();
  const devs = hasCli ? await llamaListDevices(llamaCli) : null;
  const gpu = gi.gpus && gi.gpus[0] ? gi.gpus[0] : null;

  // Quick heuristics
  const fileStat = fs.statSync(args.model);
  const fileMB = Math.round(fileStat.size / 1024 / 1024);
  const layersGuess = guessLayersFromName(args.model);
  const memGiB = gpu?.memGiB || 0;

  let ngl = 0;
  if (args.quick) {
    // Guess ngl by file-size fraction that fits VRAM (very rough)
    if (memGiB > 0) {
      // leave ~2 GiB headroom; assume model file approximates VRAM load @ ngl=layers
      const usable = Math.max(0, memGiB - 2) * 1024;
      ngl = Math.max(
        0,
        Math.min(layersGuess, Math.floor((usable / fileMB) * layersGuess))
      );
      if (!Number.isFinite(ngl)) ngl = 0;
    }
  } else if (args.deep && hasCli) {
    ngl = await findMaxNgl(llamaCli, args.model, layersGuess);
  } else {
    // default safe baseline
    ngl =
      memGiB >= 24
        ? Math.min(layersGuess, 70)
        : memGiB >= 12
          ? Math.min(layersGuess, 40)
          : 0;
  }

  const threads = cpuThreads();
  const { batch, ubatch } = recommendBatchUbatch(memGiB, gi.type);
  const ctx = recommendCtx(memGiB);
  const flash = 'auto';

  // env tuning hints
  const env = {};
  if (gi.type === 'nvidia') {
    // Ada (sm_89) often benefits from MMQ in newer builds; leave as hint off-by-default:
    env.GGML_CUDA_FORCE_MMQ = process.env.GGML_CUDA_FORCE_MMQ || '0'; // set '1' to force MMQ kernels
    env.GGML_CUDA_FORCE_CUBLAS = process.env.GGML_CUDA_FORCE_CUBLAS || '0'; // fallback if MMQ unstable
  }

  // server recommendation
  const server = {
    cmd: process.env.LLAMACPP_SERVER || './llama.cpp/build/bin/llama-server',
    args: [
      '-m',
      args.model,
      '--host',
      args.host,
      '--port',
      String(args.port),
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
      flash,
    ],
    env,
  };

  // cli recommendation
  const cli = {
    cmd: llamaCli,
    args: [
      '-m',
      args.model,
      '--n-predict',
      '64',
      '-ngl',
      String(ngl),
      '--threads',
      String(threads),
      '--flash-attn',
      flash,
    ],
    env,
  };

  // finetune recommendation
  const rank = args.rank ?? (memGiB >= 24 ? 16 : 8);
  const alpha = args.alpha ?? rank;
  const seqLen = args.seqLen ?? 2048;
  const epochs = args.epochs ?? 1;
  const finetune = {
    cmd: process.env.LLAMA_FINETUNE || './llama.cpp/build/bin/llama-finetune',
    args: [
      '-m',
      args.model,
      '--lora-out',
      '/tmp/adapter.gguf',
      '--lora-r',
      String(rank),
      '--lora-alpha',
      String(alpha),
      '--epochs',
      String(epochs),
      '--seq-len',
      String(seqLen),
      '--lr',
      '1e-4',
    ],
    env,
  };

  // model-to-model profile (deterministic, low-temp, generous ctx)
  const m2m = {
    serverHints: {
      temperature: 0.2,
      top_p: 0.8,
      repeat_penalty: 1.05,
      ctx_size: ctx,
      batch,
      ubatch,
      // run two servers on different ports for duplex m2m; pin --main-gpu 0 both sides; use streaming
    },
    openaiClientDefaults: {
      temperature: 0.2,
      max_tokens: 256,
      presence_penalty: 0.0,
      frequency_penalty: 0.0,
    },
  };

  const out = {
    host: args.host,
    port: args.port,
    model: args.model,
    fileMB,
    layersGuess,
    hardware: gi,
    llamaDevices: devs,
    threads,
    ctx,
    batch,
    ubatch,
    ngl,
    env,
    recommend: { server, cli, finetune, m2m },
  };

  // Output
  if (args.write) {
    fs.writeFileSync(args.write, JSON.stringify(out, null, 2), 'utf8');
    console.log(`wrote ${args.write}`);
  } else {
    console.log(JSON.stringify(out, null, 2));
  }

  if (args.printCmd) {
    const envStr = Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    const sCmd =
      `${envStr} ${server.cmd} ${server.args.map((x) => (/[^A-Za-z0-9._:-]/.test(x) ? JSON.stringify(x) : x)).join(' ')}`.trim();
    console.error('\n# llama-server (recommended):\n' + sCmd + '\n');
  }
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});
