// gateway/usecases/scan.js
import fs from 'fs';
import { performance } from 'perf_hooks';

export async function scanUseCase(req, res, deps) {
  const { log, scanDirectory, setIndex } = deps;

  const root = req.body?.root;
  const maxFileSize = Math.min(
    Number(req.body?.maxFileSize) || 262144,
    2 * 1024 * 1024
  );

  if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return res
      .status(400)
      .json({ ok: false, error: "valid 'root' directory required" });
  }

  const t0 = performance.now();
  const files = scanDirectory(root, maxFileSize);
  setIndex({ root, files });

  log({
    event: 'scan_done',
    root,
    count: files.length,
    ms: Math.round(performance.now() - t0),
  });
  return res.json({ ok: true, root, count: files.length });
}
