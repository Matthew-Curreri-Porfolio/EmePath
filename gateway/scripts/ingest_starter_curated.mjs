#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const out = process.argv[2] || path.join(__dirname, '..', 'tools', 'curated', 'cache', 'docs.jsonl');
const seeds = process.argv[3] || path.join(__dirname, '..', 'tools', 'curated', 'seeds.json');

fs.mkdirSync(path.dirname(out), { recursive: true });

const runner = path.join(__dirname, '..', 'tools', 'curated', 'ingest', 'run_ingest.mjs');
console.error(`Seeding curated cache -> ${out} (seeds: ${seeds})`);
const child = spawn(process.execPath, [runner, '--seeds', seeds, '--out', out], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code || 0));

