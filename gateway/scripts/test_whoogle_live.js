// Live Whoogle smoke test. Hits WHOOGLE_BASE with a query, saves HTML optionally,
// then runs the parser and prints parsed results. Requires network access.

import fs from 'fs/promises';
import { searchWhoogle } from '../tools/whoogle.js';

const base = (process.env.WHOOGLE_BASE || 'http://127.0.0.1:5010').replace(/\/$/, '');
const query = process.env.QUERY || 'whoogle smoke test';
const num = Number(process.env.NUM || 3);
const outFile = process.env.OUT;
const timeoutMs = Number(process.env.TIMEOUT_MS || 6000);

const params = new URLSearchParams({ q: query, num: String(num), hl: 'en' });
const url = `${base}/search?${params.toString()}`;

try {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      Accept: 'text/html,application/xhtml+xml',
    },
  });
  const html = await res.text();
  console.log(JSON.stringify({ ok: res.ok, status: res.status, bytes: html.length }, null, 2));
  if (outFile) await fs.writeFile(outFile, html);
} catch (e) {
  console.error(JSON.stringify({ ok:false, error: String(e && e.message || e) }));
}

const parsed = await searchWhoogle(query, { base, num, lang: 'en' });
console.log(JSON.stringify({ parsed }, null, 2));

