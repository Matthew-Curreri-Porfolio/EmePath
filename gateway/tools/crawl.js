// gateway/tools/crawl.js
// Lightweight filesystem crawler: indexes the directory tree into DB and optionally summarizes files.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { run } from '../db/db.js';
import { chat as llmChat } from '../lib/lora_client.js';

const DEFAULT_EXCLUDES = [
  '/proc', '/sys', '/dev', '/run', '/tmp', '/var/run', '/var/lib/docker',
  '/.git', '/.cache', '/node_modules', '/.venv', '/venv'
];

function isExcluded(p, excludes) {
  const u = p.replace(/\\/g, '/');
  return excludes.some((ex) => u === ex || u.startsWith(ex + '/'));
}

function sha256File(p, { maxBytes = 8 * 1024 * 1024 } = {}) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > maxBytes) return null;
    const h = crypto.createHash('sha256');
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.alloc(1024 * 256);
      let off = 0;
      while (off < st.size) {
        const n = fs.readSync(fd, buf, 0, buf.length, off);
        if (!n) break;
        h.update(buf.subarray(0, n));
        off += n;
      }
    } finally { fs.closeSync(fd); }
    return h.digest('hex');
  } catch { return null; }
}

export async function crawl({
  root = '.',
  maxDepth = 6,
  maxFiles = 20000,
  summarize = false,
  excludes = [],
  system = false,
} = {}) {
  const allowSystem = String(process.env.EMEPATH_ALLOW_SYSTEM_SCAN || '').toLowerCase();
  if (system && !(allowSystem === '1' || allowSystem === 'true')) {
    throw new Error('system scan disabled: set EMEPATH_ALLOW_SYSTEM_SCAN=1 to allow');
  }
  const absRoot = path.resolve(root);
  const ex = Array.from(new Set([...(system ? DEFAULT_EXCLUDES : []), ...excludes.map((e) => path.resolve(e))]));
  let count = 0;
  const q = [{ d: absRoot, k: 0 }];
  while (q.length && count < maxFiles) {
    const { d, k } = q.shift();
    if (isExcluded(d, ex)) continue;
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (isExcluded(p, ex)) continue;
      try {
        const st = fs.lstatSync(p);
        const kind = st.isDirectory() ? 'dir' : st.isFile() ? 'file' : st.isSymbolicLink() ? 'link' : 'other';
        const sha = kind === 'file' ? sha256File(p) : null;
        run(
          `INSERT OR REPLACE INTO files_index (path, size, mtime, kind, sha256, added_at, updated_at)
           VALUES (?, ?, ?, ?, ?, COALESCE((SELECT added_at FROM files_index WHERE path = ?), CURRENT_TIMESTAMP), CURRENT_TIMESTAMP)`,
          [p, st.size, Math.floor(st.mtimeMs || 0), kind, sha, p]
        );
        count++;
        if (count >= maxFiles) break;
        if (st.isDirectory() && k < maxDepth) q.push({ d: p, k: k + 1 });
        if (summarize && kind === 'file' && st.size > 0 && st.size <= 512 * 1024) {
          try {
            const text = fs.readFileSync(p, 'utf8');
            const messages = [
              { role: 'system', content: 'Summarize this file in one paragraph. Mention purpose and key contents. Be concise.' },
              { role: 'user', content: text.slice(0, 130_000) },
            ];
            const r = await llmChat({ messages, maxTokens: 160, temperature: 0.2, timeoutMs: 90_000 });
            const summary = String(r?.content || '').trim();
            run(
              `INSERT OR REPLACE INTO file_summaries (path, summary, updated_at)
               VALUES (?, ?, CURRENT_TIMESTAMP)`,
              [p, summary]
            );
          } catch {}
        }
      } catch {}
    }
  }
  return { ok: true, root: absRoot, indexed: count, maxFiles, maxDepth, summarize, excludes: ex };
}

export default { crawl };

