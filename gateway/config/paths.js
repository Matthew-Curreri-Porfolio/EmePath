import fs from 'fs';
import os from 'os';
import path from 'path';

const uniq = (a) => Array.from(new Set(a));
const exists = (p) => {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
};
const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

export function homeDir() {
  return process.env.HOME || os.homedir() || '';
}

export function modelRoots() {
  const h = homeDir();
  const envRoots = (process.env.MODEL_SEARCH_ROOTS || '')
    .split(':')
    .map((s) => s.trim())
    .filter(Boolean);
  const common = [
    path.join(h, '.ollama/models'),
    '/root/.ollama/models',
    '/var/snap/ollama/common/models',
    '/var/lib/ollama/models',
    '/usr/local/var/ollama/models',
    '/opt/homebrew/var/ollama/models',
    '/usr/share/ollama/.ollama/models',
  ];
  return uniq([...envRoots, ...common]).filter(isDir);
}

export function manifestRoots() {
  return modelRoots()
    .map((r) => path.join(r, 'manifests'))
    .filter(isDir);
}

export function blobPathForDigest(digest) {
  const d = String(digest || '').replace(/^sha256-/, '');
  const roots = modelRoots();
  const candidates = [];
  for (const r of roots) {
    candidates.push(path.join(r, 'blobs', `sha256-${d}`));
    candidates.push(path.join(r, `sha256-${d}`));
  }
  for (const c of candidates) if (isFile(c)) return c;
  return '';
}

export function resolvePython() {
  const explicit = process.env.GATEWAY_PYTHON || process.env.PYTHON;
  if (explicit && exists(explicit)) return explicit;
  const h = homeDir();
  const candidates = [
    path.join(h, 'miniconda3', 'envs', 'gateway', 'bin', 'python'),
    path.join(h, 'anaconda3', 'envs', 'gateway', 'bin', 'python'),
  ];
  for (const c of candidates) if (exists(c)) return c;
  return 'python3';
}

export default {
  modelRoots,
  manifestRoots,
  blobPathForDigest,
  resolvePython,
  homeDir,
};
