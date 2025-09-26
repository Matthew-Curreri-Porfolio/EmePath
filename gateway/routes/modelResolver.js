// gateway/routes/modelResolver.js
// Single endpoint: GET /model/resolve?arg=<ref>[&debug=1][&hash=1]
// Legacy resolver for local model artifacts. Supported refs:
// - absolute .gguf files
// - directories containing *.gguf
// - Modelfile paths (FROM directives)
// - simple "namespace/name:tag" strings (local-only; uses manifests directory)
// No external deps or network calls.

import fs from 'fs';
import path from 'path';
import { modelRoots } from '../config/paths.js';

// Dynamic model roots

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
const uniq = (a) => Array.from(new Set(a));

function discoverRoots() {
  return modelRoots();
}

function readFirst4(p) {
  const fd = fs.openSync(p, 'r');
  try {
    const b = Buffer.alloc(4);
    fs.readSync(fd, b, 0, 4, 0);
    return b.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function isGGUF(p) {
  if (!isFile(p)) return false;
  try {
    return readFirst4(p) === 'GGUF';
  } catch {
    return false;
  }
}

function fileInfo(p) {
  const st = fs.statSync(p);
  return {
    resolvedPath: path.resolve(p),
    sizeBytes: st.size,
    mtime: st.mtime.toISOString(),
    ggufHeader: isGGUF(p),
  };
}

function newestGGUFIn(dir) {
  let best = null,
    ts = -1;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (p.toLowerCase().endsWith('.gguf') && isGGUF(p)) {
      const m = fs.statSync(p).mtimeMs;
      if (m > ts) {
        ts = m;
        best = p;
      }
    }
  }
  return best;
}

// ---------- blobs / manifests (local only) ----------
function tryBlobPaths(digest) {
  const roots = discoverRoots();
  const candidates = [];
  for (const r of roots) {
    const b = path.join(r, 'blobs');
    for (const nm of [digest, `sha256-${digest}`]) {
      candidates.push(path.join(b, nm));
      candidates.push(path.join(r, nm));
    }
  }
  for (const c of candidates) if (isGGUF(c)) return c;
  return null;
}

function extractSha256FromFile(p) {
  try {
    const txt = fs.readFileSync(p, 'utf8');
    const m = txt.match(/sha256-([0-9a-f]{64})/i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function* walk(dir, depth = 3) {
  const q = [{ d: dir, k: 0 }];
  while (q.length) {
    const { d, k } = q.shift();
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && k < depth) q.push({ d: p, k: k + 1 });
      else if (e.isFile()) yield p;
    }
  }
}

function resolveFromManifests(id) {
  const roots = discoverRoots();
  for (const r of roots) {
    const mdir = path.join(r, 'manifests');
    if (!isDir(mdir)) continue;
    // pass 1: look for tag match in filenames
    const tag = id.split(':')[1] || id;
    for (const p of walk(mdir, 6)) {
      const base = path.basename(p);
      if (base === tag || p.includes(id)) {
        const d = extractSha256FromFile(p);
        if (d) {
          const blob = tryBlobPaths(d);
          if (blob) return blob;
        }
      }
    }
    // pass 2: scan all manifests for sha256 tokens
    for (const p of walk(mdir, 4)) {
      const d = extractSha256FromFile(p);
      if (!d) continue;
      const blob = tryBlobPaths(d);
      if (blob) return blob;
    }
  }
  return null;
}

// ---------- Modelfile parsing ----------
function parseModelfileDirectives(txt) {
  // returns { FROM: ["...","..."], ADAPTER: ["..."], PARAM: [...], TEMPLATE: [...], ... }
  const out = {};
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '');
    const m = line.match(/^\s*([A-Z_]+)\s+(.*)$/i);
    if (!m) continue;
    const key = m[1].toUpperCase();
    const val = m[2].trim();
    if (!out[key]) out[key] = [];
    out[key].push(val);
  }
  return out;
}

function resolveFromModelfile(mfPath, maxDepth = 4) {
  let cur = path.resolve(mfPath);
  let dir = path.dirname(cur);
  const chain = [];
  for (let i = 0; i < maxDepth; i++) {
    const txt = fs.readFileSync(cur, 'utf8');
    const directives = parseModelfileDirectives(txt);
    const from = directives.FROM && directives.FROM[0];
    chain.push({ modelfile: cur, from: from || null, directives });

    if (!from) break;

    // absolute gguf
    if (from.startsWith('/') && isGGUF(from)) {
      return {
        path: from,
        source: 'modelfile',
        chain,
        adapters: directives.ADAPTER || [],
      };
    }
    // relative gguf
    const rel = path.join(dir, from);
    if (isGGUF(rel)) {
      return {
        path: rel,
        source: 'modelfile',
        chain,
        adapters: directives.ADAPTER || [],
      };
    }
    // sha256
    if (/^(sha256-)?[0-9a-f]{64}$/i.test(from)) {
      const digest = from.replace(/^sha256-/, '');
      const p = tryBlobPaths(digest);
      if (p)
        return {
          path: p,
          source: 'modelfile->blob',
          chain,
          adapters: directives.ADAPTER || [],
        };
    }
    // id:tag
    if (from.includes(':')) {
      const p = resolveFromManifests(from);
      if (p)
        return {
          path: p,
          source: 'modelfile->manifest',
          chain,
          adapters: directives.ADAPTER || [],
        };
    }
    // follow nested Modelfile if 'FROM' points to another file
    const asPath = from.startsWith('/') ? from : path.join(dir, from);
    const looksLikeModelfile =
      /modelfile$/i.test(asPath) ||
      path.basename(asPath).toLowerCase() === 'modelfile';
    if (looksLikeModelfile && isFile(asPath)) {
      cur = asPath;
      dir = path.dirname(cur);
      continue;
    }
    // final fallback: nearest gguf in same dir
    const guess = newestGGUFIn(dir);
    if (guess)
      return {
        path: guess,
        source: 'modelfile->dir',
        chain,
        adapters: directives.ADAPTER || [],
      };
    break;
  }
  return null;
}

// ---------- main ----------
export function resolveModelPath(arg) {
  if (!arg) throw new Error('arg required');

  // 1) absolute GGUF
  if (arg.startsWith('/') && isGGUF(arg))
    return { path: arg, source: 'direct' };

  // 2) directory
  if (isDir(arg)) {
    const mf = path.join(arg, 'Modelfile');
    if (isFile(mf)) {
      const r = resolveFromModelfile(mf);
      if (r) return r;
    }
    const gg = newestGGUFIn(arg);
    if (gg) return { path: gg, source: 'dir' };
  }

  // 3) explicit Modelfile path
  if (
    isFile(arg) &&
    (/modelfile$/i.test(arg) ||
      path.basename(arg).toLowerCase() === 'modelfile')
  ) {
    const r = resolveFromModelfile(arg);
    if (r) return r;
  }

  // 4) sha256
  if (/^(sha256-)?[0-9a-f]{64}$/i.test(arg)) {
    const digest = arg.replace(/^sha256-/, '');
    const p = tryBlobPaths(digest);
    if (p) return { path: p, source: 'blob' };
  }

  // 5) id:tag via manifests
  if (arg.includes(':')) {
    const p = resolveFromManifests(arg);
    if (p) return { path: p, source: 'manifest' };
  }

  // 6) newest blob anywhere
  const fb = (() => {
    for (const r of discoverRoots()) {
      const b = path.join(r, 'blobs');
      if (isDir(b)) {
        const gg = newestGGUFIn(b);
        if (gg) return gg;
      }
    }
    return null;
  })();
  if (fb) return { path: fb, source: 'fallback' };

  throw new Error(`could not resolve '${arg}'`);
}

async function sha256Of(file) {
  // only if &hash=1 (avoid hashing giant files by default)
  const crypto = await import('crypto');
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (d) => h.update(d));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

export function registerModelResolver(app /*, deps */) {
  app.get('/model/resolve', async (req, res) => {
    const debug = String(req.query.debug || '0') === '1';
    const wantHash = String(req.query.hash || '0') === '1';
    try {
      const arg = String(req.query.arg || req.query.id || req.query.ref || '');
      if (!arg)
        return res.status(400).json({ ok: false, error: 'missing arg' });

      const out = resolveModelPath(arg);
      const info = fileInfo(out.path);

      const payload = {
        ok: true,
        arg,
        source: out.source,
        resolvedPath: info.resolvedPath,
        sizeBytes: info.sizeBytes,
        mtime: info.mtime,
        ggufHeader: info.ggufHeader,
      };

      // surface Modelfile details when available
      if (out.chain) {
        payload.modelfile = {
          used: true,
          chain: out.chain.map((x) => ({
            modelfile: x.modelfile,
            from: x.from,
            // keep only a few common directives to keep payload small
            directives: {
              FROM: x.directives.FROM || [],
              ADAPTER: x.directives.ADAPTER || [],
              TEMPLATE: x.directives.TEMPLATE || [],
              PARAM: x.directives.PARAM || [],
            },
          })),
          adapters: out.adapters || [],
        };
      } else {
        payload.modelfile = { used: false };
      }

      if (debug) {
        payload.roots = discoverRoots();
      }
      if (wantHash) {
        payload.sha256 = await sha256Of(out.path);
      }

      res.setHeader('X-Resolver-Trace', out.source);
      return res.json(payload);
    } catch (e) {
      return res
        .status(404)
        .json({ ok: false, error: (e && e.message) || String(e) });
    }
  });
}

// Support both default and named imports
export default { registerModelResolver, resolveModelPath };
