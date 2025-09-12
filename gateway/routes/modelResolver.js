// Stand-alone, single-endpoint model resolver (no external deps).
// Endpoint: GET /model/resolve?arg=<ref>
// Ref can be: absolute .gguf path | dir (with Modelfile or *.gguf) | Modelfile path
//             | sha256[-digest] | Ollama-style "namespace/name:tag" (resolved locally)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const DEFAULT_ROOTS = [
  path.join(process.env.HOME || "", ".ollama/models"),
  "/root/.ollama/models",
  "/var/snap/ollama/common/models",
  "/var/lib/ollama/models",
  "/usr/local/var/ollama/models",
  "/opt/homebrew/var/ollama/models",
  "/usr/share/ollama/.ollama/models",
];

function uniq(arr) { return Array.from(new Set(arr)); }
function safeExists(p) { try { return !!fs.statSync(p); } catch { return false; } }
function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function isDir(p)  { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

function discoverRoots() {
  const env = (process.env.MODEL_SEARCH_ROOTS || "")
    .split(":").map(s => s.trim()).filter(Boolean);
  return uniq([...DEFAULT_ROOTS, ...env].filter(safeExists));
}

function readFirst4(p) {
  const fd = fs.openSync(p, "r");
  try {
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    return buf.toString("utf8");
  } finally { fs.closeSync(fd); }
}

function isGGUFFile(p) {
  if (!isFile(p)) return false;
  try { return readFirst4(p) === "GGUF"; } catch { return false; }
}

function fileInfo(p) {
  const st = fs.statSync(p);
  return {
    resolvedPath: path.resolve(p),
    sizeBytes: st.size,
    mtime: st.mtime.toISOString(),
    ggufHeader: isGGUFFile(p),
  };
}

// --- blob helpers (scan local stores only) ---
function tryBlobPaths(digest) {
  const roots = discoverRoots();
  const candidates = [];
  for (const r of roots) {
    const b = path.join(r, "blobs");
    candidates.push(path.join(b, digest));
    candidates.push(path.join(b, `sha256-${digest}`));
    // some installs have the digest directly under models/
    candidates.push(path.join(r, digest));
    candidates.push(path.join(r, `sha256-${digest}`));
  }
  for (const c of candidates) {
    if (isGGUFFile(c)) return c;
  }
  return null;
}

function newestGGUFIn(dir) {
  let newest = null;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (isFile(p) && p.toLowerCase().endsWith(".gguf") && isGGUFFile(p)) {
      if (!newest || fs.statSync(p).mtimeMs > fs.statSync(newest).mtimeMs) newest = p;
    }
  }
  return newest;
}

function scanNewestGGUFBlob() {
  const roots = discoverRoots();
  let newest = null, newestTs = -1;
  for (const r of roots) {
    const b = path.join(r, "blobs");
    if (!isDir(b)) continue;
    for (const f of fs.readdirSync(b)) {
      const p = path.join(b, f);
      if (!isFile(p)) continue;
      if (!isGGUFFile(p)) continue;
      const ts = fs.statSync(p).mtimeMs;
      if (ts > newestTs) { newestTs = ts; newest = p; }
    }
  }
  return newest;
}

// --- Modelfile parsing & chaining ---
function parseFromToken(modelfilePath) {
  const txt = fs.readFileSync(modelfilePath, "utf8");
  const lines = txt.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, ""); // strip comments
    const m = line.match(/^\s*FROM\s+(\S+)/i);
    if (m) return m[1].trim();
  }
  return null;
}

function resolveFromModelfile(mfPath, maxDepth = 4) {
  let cur = path.resolve(mfPath);
  let dir = path.dirname(cur);
  for (let i = 0; i < maxDepth; i++) {
    const tok = parseFromToken(cur);
    if (!tok) break;

    // absolute gguf
    if (tok.startsWith("/") && isGGUFFile(tok)) return { path: tok, source: "modelfile" };
    // relative gguf
    const rel = path.join(dir, tok);
    if (isGGUFFile(rel)) return { path: rel, source: "modelfile" };
    // sha256
    if (/^(sha256-)?[0-9a-f]{64}$/i.test(tok)) {
      const digest = tok.replace(/^sha256-/, "");
      const p = tryBlobPaths(digest);
      if (p) return { path: p, source: "modelfile->blob" };
    }
    // looks like id with tag
    if (tok.includes(":")) {
      const p = resolveFromManifests(tok);
      if (p) return { path: p, source: "modelfile->manifest" };
    }
    // chain Modelfiles if token points to one
    const asPath = tok.startsWith("/") ? tok : path.join(dir, tok);
    if (isFile(asPath) && /modelfile$/i.test(asPath) || path.basename(asPath).toLowerCase() === "modelfile") {
      cur = asPath; dir = path.dirname(cur); continue;
    }
    // last resort: nearest gguf containing token substring
    const local = fs.readdirSync(dir)
      .filter(f => f.toLowerCase().endsWith(".gguf") && f.toLowerCase().includes(tok.toLowerCase()))
      .map(f => path.join(dir, f))[0];
    if (local && isGGUFFile(local)) return { path: local, source: "modelfile->dirmatch" };
    break;
  }
  return null;
}

// --- Manifest crawling (no ollama CLI) ---
function* walk(dir, maxDepth = 4) {
  const q = [{ d: dir, depth: 0 }];
  let seen = 0;
  while (q.length && seen < 10000) {
    const { d, depth } = q.shift();
    seen++;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth) q.push({ d: p, depth: depth + 1 });
      } else if (e.isFile()) {
        yield p;
      }
    }
  }
}

function resolveFromManifests(id) {
  const roots = discoverRoots();
  const idSafe = id.trim();
  for (const r of roots) {
    const mdir = path.join(r, "manifests");
    if (!isDir(mdir)) continue;

    // pass 1: files whose path matches tag or id parts
    const tag = idSafe.split(":")[1] || idSafe;
    for (const p of walk(mdir, 6)) {
      const base = path.basename(p);
      if (base === tag || p.includes(idSafe)) {
        const dig = extractDigestFromFile(p);
        if (dig) {
          const blob = tryBlobPaths(dig);
          if (blob) return blob;
        }
      }
    }

    // pass 2: scan all manifest files for sha256-* and try them
    for (const p of walk(mdir, 3)) {
      const dig = extractDigestFromFile(p);
      if (!dig) continue;
      const blob = tryBlobPaths(dig);
      if (blob) return blob;
    }
  }
  return null;
}

function extractDigestFromFile(p) {
  try {
    const buf = fs.readFileSync(p, { encoding: "utf8" });
    const m = buf.match(/sha256-([0-9a-f]{64})/i);
    return m ? m[1] : null;
  } catch { return null; }
}

// --- main resolver ---
function resolveModelPath(arg) {
  if (!arg || typeof arg !== "string") throw new Error("arg required");

  // 1) absolute GGUF
  if (arg.startsWith("/") && isGGUFFile(arg)) return { path: arg, source: "direct" };

  // 2) directory with Modelfile or *.gguf
  if (isDir(arg)) {
    const mf = path.join(arg, "Modelfile");
    if (isFile(mf)) {
      const r = resolveFromModelfile(mf);
      if (r) return r;
    }
    const p = newestGGUFIn(arg);
    if (p) return { path: p, source: "dir" };
  }

  // 3) explicit Modelfile path
  if (isFile(arg) && (/modelfile$/i.test(arg) || path.basename(arg).toLowerCase() === "modelfile")) {
    const r = resolveFromModelfile(arg);
    if (r) return r;
  }

  // 4) sha256 token
  if (/^(sha256-)?[0-9a-f]{64}$/i.test(arg)) {
    const digest = arg.replace(/^sha256-/, "");
    const p = tryBlobPaths(digest);
    if (p) return { path: p, source: "blob" };
  }

  // 5) ollama-style id
  if (arg.includes(":")) {
    const p = resolveFromManifests(arg);
    if (p) return { path: p, source: "manifest" };
  }

  // 6) fallback
  const fb = scanNewestGGUFBlob();
  if (fb) return { path: fb, source: "fallback" };

  throw new Error(`could not resolve '${arg}' to a local GGUF`);
}

// -----------------------------------------------------------
// Single endpoint registration
// -----------------------------------------------------------
export function registerModelResolver(app /*, deps */) {
  app.get("/model/resolve", (req, res) => {
    try {
      const arg = String(req.query.arg || req.query.id || req.query.ref || "");
      if (!arg) return res.status(400).json({ ok: false, error: "missing arg" });

      const out = resolveModelPath(arg);
      const info = fileInfo(out.path);
      return res.json({
        ok: true,
        arg,
        source: out.source,
        roots: discoverRoots(),
        ...info,
      });
    } catch (e) {
      return res.status(404).json({ ok: false, error: (e && e.message) || String(e) });
    }
  });
}

export default { registerModelResolver };
