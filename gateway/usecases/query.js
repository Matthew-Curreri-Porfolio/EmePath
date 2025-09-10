// gateway/usecases/query.js
// Simple per-process cache to avoid repeated lowercasing of large files.
const LOWER_CACHE = new Map();

function isWordCharCode(code) {
  return (code >= 97 && code <= 122) || // a-z
    (code >= 48 && code <= 57) || // 0-9
    code === 95; // _
}

export async function queryUseCase(req, res, deps) {
  const { log, escapeRe, getIndex, makeSnippets } = deps;

  const q = String(req.body?.q || "").trim();
  const k = Math.min(Number(req.body?.k) || 8, 20);
  const index = getIndex();
  if (!index.root || index.files.length === 0) {
    return res.status(400).json({ ok: false, error: "index is empty; call /scan first" });
  }
  if (!q) return res.status(400).json({ ok: false, error: "query 'q' required" });

  const terms = q.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);
  const scored = [];

  if (terms.length === 0) {
    return res.json({ ok: true, root: index.root, hits: [] });
  }

  // For each file, use a cached lowercase snapshot (keyed by path+length+prefix)
  // then count whole-word occurrences per term using indexOf + boundary checks.
  for (const f of index.files) {
    const key = `${f.path}|${f.text.length}|${f.text.slice(0, 40)}`;
    let lower = LOWER_CACHE.get(key);
    if (lower === undefined) {
      lower = f.text.toLowerCase();
      LOWER_CACHE.set(key, lower);
    }

    let score = 0;
    const L = lower.length;

    for (const t of terms) {
      if (!t) continue;
      let from = 0;
      const tlen = t.length;
      while (true) {
        const idx = lower.indexOf(t, from);
        if (idx === -1) break;

        // check left boundary
        const leftOk = idx === 0 || !isWordCharCode(lower.charCodeAt(idx - 1));
        // check right boundary
        const afterIdx = idx + tlen;
        const rightOk = afterIdx >= L || !isWordCharCode(lower.charCodeAt(afterIdx));

        if (leftOk && rightOk) score++;
        from = idx + tlen;
      }
    }

    if (score > 0) scored.push({ f, score });
  }

  scored.sort((a, b) => b.score - a.score);

  const hits = scored.slice(0, k).map(({ f, score }) => ({
    path: f.path,
    score,
    snippets: makeSnippets(f.text, terms),
  }));

  return res.json({ ok: true, root: index.root, hits });
}
