#!/usr/bin/env node
// gateway/scripts/chat-cli.js
// Simple CLI to send a chat request to the gateway and print the reply.

import fs from 'fs';
import path from 'path';
import { getPrompt } from '../prompts/index.js';

const GATEWAY_PORT = process.env.GATEWAY_PORT || '3123';
const BASE = (process.env.GATEWAY_BASE || `http://127.0.0.1:${GATEWAY_PORT}`).replace(/\/$/, '');

function parseArgs(argv) {
  const args = new Map();
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '1';
      args.set(k, v);
    }
  }
  return args;
}

function get(obj, pathStr) {
  const parts = String(pathStr || '').split('.').filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in cur) cur = cur[p];
    else return undefined;
  }
  return cur;
}

async function main() {
  const args = parseArgs(process.argv);
  const base = (args.get('base') || BASE).replace(/\/$/, '');
  const text = args.get('text');
  const key = args.get('key') || 'prompt';
  const file = args.get('file');

  let content = text;
  if (!content) {
    if (file) {
      try {
        const raw = fs.readFileSync(file, 'utf8');
        const j = JSON.parse(raw);
        const val = get(j, key);
        if (typeof val !== 'string' || !val.trim()) throw new Error(`Key '${key}' not found or empty in ${file}`);
        content = val;
      } catch (e) {
        console.error(`[chat-cli] failed to read prompt from ${file} key=${key}: ${e.message}`);
        process.exit(1);
      }
    } else {
      // Default to programmatic prompt registry
      content = getPrompt(key || 'prompt');
      if (!content) {
        console.error(`[chat-cli] prompt key '${key}' not found in registry`);
        process.exit(1);
      }
    }
  }

  const payload = { messages: [{ role: 'user', content }] };
  const r = await fetch(`${base}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const textResp = await r.text();
  if (!r.ok) {
    console.error(`[chat-cli] HTTP ${r.status}: ${textResp}`);
    process.exit(2);
  }
  let j;
  try { j = JSON.parse(textResp); } catch {
    console.log(textResp);
    process.exit(0);
  }
  const msg = j?.message?.content ?? j?.completion ?? '';
  process.stdout.write(String(msg || ''));
}

main().catch((e) => {
  console.error('[chat-cli] error:', e?.message || String(e));
  process.exit(1);
});
