// List Ollama manifest refs -> digests -> local blob paths, with a heuristic instruct score
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

function isDir(p){ try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function isFile(p){ try { return fs.statSync(p).isFile(); } catch { return false; } }

function* walk(dir, depth = 6) {
  const q = [{ d: dir, k: 0 }];
  while (q.length) {
    const { d, k } = q.shift();
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && k < depth) q.push({ d: p, k: k + 1 });
      else if (e.isFile()) yield p;
    }
  }
}

function discoverManifestRoots() {
  const roots = [
    path.join(process.env.HOME || '', '.ollama/models/manifests'),
    '/home/hmagent/.ollama/models/manifests',
    '/root/.ollama/models/manifests',
    '/var/snap/ollama/common/models/manifests',
    '/var/lib/ollama/models/manifests',
  ];
  return Array.from(new Set(roots.filter(isDir)));
}

function parseManifestFile(p) {
  try {
    const txt = fs.readFileSync(p, 'utf8');
    const j = JSON.parse(txt);
    const layer = Array.isArray(j.layers) ? j.layers.find(x => /application\/vnd\.ollama\.image\.model/.test(x.mediaType || '')) : null;
    if (!layer || !layer.digest || !/^sha256:/.test(layer.digest)) return null;
    const rel = p.split('/manifests/')[1] || p;
    const ref = rel.replace(/^registry\.ollama\.ai\//, '');
    return { ref, digest: layer.digest.replace(/^sha256:/, ''), size: layer.size || 0, file: p };
  } catch { return null; }
}

function listAllManifestEntries() {
  const out = [];
  for (const r of discoverManifestRoots()) {
    for (const p of walk(r, 6)) {
      if (!/\/[0-9]+:?[^/]*$/.test(p)) continue;
      const ent = parseManifestFile(p);
      if (ent) out.push(ent);
    }
  }
  return out;
}

function blobPathForDigest(d) {
  const cands = [
    path.join(process.env.HOME || '', `.ollama/models/blobs/sha256-${d}`),
    `/home/hmagent/.ollama/models/blobs/sha256-${d}`,
    `/root/.ollama/models/blobs/sha256-${d}`,
    `/var/snap/ollama/common/models/blobs/sha256-${d}`,
    `/var/lib/ollama/models/blobs/sha256-${d}`,
  ];
  for (const c of cands) if (isFile(c)) return c;
  return '';
}

function scoreRefForChat(ref) {
  const s = ref.toLowerCase();
  let score = 0;
  if (/instruct|chat|assistant|it\b/.test(s)) score += 50;
  if (/hermes|mistral|llama-?3|gemma|qwen|phi|command|deepseek/.test(s)) score += 20;
  if (/coder/.test(s)) score += 5;
  if (/base\b/.test(s)) score -= 10;
  if (/embed|bert|e5|bge/.test(s)) score -= 100;
  return score;
}

async function ggufMeta(p) {
  const bin = path.join(process.cwd(), 'llama.cpp/build/bin/llama-gguf');
  if (!isFile(bin)) return {};
  return await new Promise((resolve) => {
    const c = spawn(bin, ['-i', p], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    c.stdout.on('data', d => { out += String(d); });
    c.on('close', () => {
      const arch = (out.match(/arch\s*=\s*([\w\-]+)/i) || [])[1] || '';
      const name = (out.match(/general\.name\s+str\s*=\s*(.+)/i) || [])[1] || '';
      const causal = /causal\s*attn\s*=\s*1|true/i.test(out);
      resolve({ arch: arch.trim(), name: name.trim(), causal });
    });
  });
}

async function main() {
  const ents = listAllManifestEntries();
  if (!ents.length) { console.log('No manifests found'); return; }
  const rows = [];
  for (const e of ents) {
    const pathBlob = blobPathForDigest(e.digest);
    const score = scoreRefForChat(e.ref);
    let meta = {};
    if (pathBlob) meta = await ggufMeta(pathBlob);
    rows.push({ ref: e.ref, digest: e.digest, size: e.size, path: pathBlob, score, ...meta });
  }
  rows.sort((a, b) => b.score - a.score || a.size - b.size);
  for (const r of rows.slice(0, 30)) {
    console.log(`${r.score.toString().padStart(3)}  ${r.causal ? 'causal' : '     '}  ${r.arch || ''}  ${r.ref}\n      ${r.path || '(blob missing)'}\n`);
  }
}

main();

