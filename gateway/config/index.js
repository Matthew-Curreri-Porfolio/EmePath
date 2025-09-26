import fs from 'fs';
import path from 'path';

function deepMerge(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) return b.length ? b : a;
  if (a && typeof a === 'object' && b && typeof b === 'object') {
    const out = { ...a };
    for (const k of Object.keys(b)) out[k] = deepMerge(a[k], b[k]);
    return out;
  }
  return typeof b === 'undefined' ? a : b;
}

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

const DEFAULTS_PATH = path.resolve(
  process.cwd(),
  'gateway/config/defaults.json'
);
const LOCAL_PATH =
  process.env.GATEWAY_CONFIG ||
  path.resolve(process.cwd(), 'gateway/config/local.json');

const defaults = readJsonSafe(DEFAULTS_PATH) || {};
const overrides = readJsonSafe(LOCAL_PATH) || {};
const merged = deepMerge(defaults, overrides);

function coerceBool(v, def) {
  if (typeof v === 'boolean') return v;
  if (v === undefined) return def;
  const s = String(v).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return def;
}

export function getConfig() {
  const ports = {
    gateway: process.env.GATEWAY_PORT
      ? Number(process.env.GATEWAY_PORT)
      : merged.ports?.gateway || 3123,
  };

  const searxng = {
    base:
      process.env.SEARXNG_BASE ||
      merged.searxng?.base ||
      'http://127.0.0.1:8888',
  };

  const prompts = {
    includePolicy: coerceBool(
      process.env.PROMPT_INCLUDE_POLICY,
      merged.prompts?.includePolicy ?? true
    ),
    includePersonal: coerceBool(
      process.env.PROMPT_INCLUDE_PERSONAL,
      merged.prompts?.includePersonal ?? true
    ),
    personalIndex: process.env.PROMPT_PERSONAL_INDEX
      ? Number(process.env.PROMPT_PERSONAL_INDEX)
      : (merged.prompts?.personalIndex ?? 0),
    personalRandom: coerceBool(
      process.env.PROMPT_PERSONAL_RANDOM,
      merged.prompts?.personalRandom ?? false
    ),
  };

  const models = {
    favorites: Array.isArray(merged.models?.favorites)
      ? merged.models.favorites
      : [],
  };

  return { ports, searxng, prompts, models };
}

export default { getConfig };
