// gateway/lib/cache.js
// Simple TTL + LRU-ish in-memory cache for exact prompt/message reuse.

const DEFAULT_TTL_MS = Number(process.env.GATEWAY_CACHE_TTL_MS || 10 * 60_000); // 10 minutes
const DEFAULT_MAX = Number(process.env.GATEWAY_CACHE_MAX_ENTRIES || 1000);

class TTLCache {
  constructor({ ttlMs = DEFAULT_TTL_MS, max = DEFAULT_MAX } = {}) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.map = new Map(); // key -> { value, exp }
  }
  _now() { return Date.now(); }
  _purgeExpired() {
    const now = this._now();
    for (const [k, v] of this.map) {
      if (!v || (typeof v.exp === 'number' && v.exp <= now)) {
        this.map.delete(k);
      }
    }
  }
  _evictIfNeeded() {
    if (this.map.size <= this.max) return;
    const overflow = this.map.size - this.max;
    // Delete oldest insertions first (Map preserves insertion order)
    let i = 0;
    for (const k of this.map.keys()) {
      this.map.delete(k);
      if (++i >= overflow) break;
    }
  }
  get(key) {
    const ent = this.map.get(key);
    if (!ent) return undefined;
    if (ent.exp && ent.exp <= this._now()) {
      this.map.delete(key);
      return undefined;
    }
    // promote
    this.map.delete(key);
    this.map.set(key, ent);
    return ent.value;
  }
  set(key, value, ttlMs) {
    const exp = this._now() + (typeof ttlMs === 'number' && ttlMs > 0 ? ttlMs : this.ttlMs);
    this.map.set(key, { value, exp });
    this._evictIfNeeded();
  }
  has(key) { return typeof this.get(key) !== 'undefined'; }
  delete(key) { return this.map.delete(key); }
  clear() { this.map.clear(); }
  stats() {
    this._purgeExpired();
    return { size: this.map.size, max: this.max, ttlMs: this.ttlMs };
  }
}

// Stable stringify to ensure keys are sorted; avoid cache misses from key order.
export function stableStringify(obj) {
  const seen = new WeakSet();
  const fmt = (x) => {
    if (x === null || typeof x !== 'object') return x;
    if (seen.has(x)) return undefined;
    seen.add(x);
    if (Array.isArray(x)) return x.map(fmt);
    const out = {};
    for (const k of Object.keys(x).sort()) out[k] = fmt(x[k]);
    return out;
  };
  return JSON.stringify(fmt(obj));
}

let _cache;
export function getCache() {
  if (!_cache) _cache = new TTLCache();
  return _cache;
}

export default { getCache, stableStringify };

