#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configurable via env or args
const OUT =
  process.env.CURATED_CACHE ||
  path.join(__dirname, '..', 'tools', 'curated', 'cache', 'docs.jsonl');
const SEEDS =
  process.env.CURATED_SEEDS ||
  path.join(__dirname, '..', 'tools', 'curated', 'seeds.json');
const REPLACE =
  String(process.env.CURATED_REPLACE || '1').toLowerCase() === '1';

fs.mkdirSync(path.dirname(OUT), { recursive: true });
if (REPLACE && fs.existsSync(OUT)) {
  // atomically replace
  try {
    fs.unlinkSync(OUT);
  } catch {}
}

const runner = path.join(
  __dirname,
  '..',
  'tools',
  'curated',
  'ingest',
  'run_ingest.mjs'
);
console.error(`[nightly] Ingesting curated cache -> ${OUT} (seeds: ${SEEDS})`);
const child = spawn(
  process.execPath,
  [runner, '--seeds', SEEDS, '--out', OUT],
  { stdio: 'inherit' }
);
child.on('exit', (code) => {
  if (code) {
    console.error(`[nightly] Ingest failed with code ${code}`);
    process.exit(code);
  }
  console.error(`[nightly] Ingest complete at ${new Date().toISOString()}`);
  process.exit(0);
});
