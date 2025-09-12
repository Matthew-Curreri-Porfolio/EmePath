#!/usr/bin/env node
// Usage:
//   echo "some text" | node gateway/scripts/annotate_text.mjs
//   node gateway/scripts/annotate_text.mjs /abs/path/to/file.txt > out.json

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { extractDimensionalMarkup } from '../tools/annotations/extract.mjs';
import { extractDimensionalMarkupLLM } from '../tools/annotations/extract_llm.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function readAllStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const args = process.argv.slice(2);
const flags = new Map();
const files = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith('--')) {
    const k = a.replace(/^--/, '');
    const v = (i + 1 < args.length && !args[i + 1].startsWith('--')) ? args[++i] : '1';
    flags.set(k, v);
  } else {
    files.push(a);
  }
}

const useLLM = flags.has('llm');
const base = flags.get('base') || process.env.GATEWAY_BASE;
const model = flags.get('model') || process.env.MODEL;
const temperature = flags.get('temperature') ? Number(flags.get('temperature')) : undefined;

const arg = files[0];
let text = '';
if (arg) {
  text = fs.readFileSync(arg, 'utf8');
} else {
  if (process.stdin.isTTY) {
    console.error('Provide text via stdin or path to a file.');
    process.exit(2);
  }
  text = await readAllStdin();
}

const out = useLLM
  ? await extractDimensionalMarkupLLM(text, { base, model, temperature })
  : extractDimensionalMarkup(text, { source: 'local', title: null, lang: 'en' });
process.stdout.write(JSON.stringify(out, null, 2));
