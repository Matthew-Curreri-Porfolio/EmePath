import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let CACHE = null;
function load() {
  if (CACHE) return CACHE;
  const p = path.resolve(__dirname, './prompts.json');
  const txt = fs.readFileSync(p, 'utf8');
  CACHE = JSON.parse(txt);
  return CACHE;
}

function interpolate(s, vars = {}) {
  return String(s || '').replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, k) => {
    const v = vars[k];
    return typeof v === 'undefined' || v === null ? '' : String(v);
  });
}

export function getPrompt(key, vars) {
  const obj = load();
  const parts = String(key || '').split('.');
  let cur = obj;
  for (const p of parts) { if (!cur || typeof cur !== 'object') return ''; cur = cur[p]; }
  if (typeof cur !== 'string') return '';
  return interpolate(cur, vars);
}

export default { getPrompt };

