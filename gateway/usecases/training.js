// gateway/usecases/training.js
import db from '../db/db.js';

function ensureAuth(req, res) {
  const userId = req.session && req.session.userId ? req.session.userId : null;
  if (!userId) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return null;
  }
  return { userId };
}

export async function trainingGet(req, res) {
  const auth = ensureAuth(req, res);
  if (!auth) return;
  const rec = db.getTraining(auth.userId);
  return res.json(rec);
}

export async function trainingPut(req, res) {
  const auth = ensureAuth(req, res);
  if (!auth) return;
  const body = req.body || {};
  const data = body.data && typeof body.data === 'object' ? body.data : {};
  const trainid =
    body.trainid && body.trainid.length > 0 ? body.trainid : undefined;
  const rec = db.setTraining(auth.userId, data, trainid);
  return res.json(rec);
}

export async function trainingPatch(req, res) {
  const auth = ensureAuth(req, res);
  if (!auth) return;
  const body = req.body || {};
  const data = body.data && typeof body.data === 'object' ? body.data : {};
  const rec = db.patchTraining(auth.userId, data);
  return res.json(rec);
}

export async function trainingDelete(req, res) {
  const auth = ensureAuth(req, res);
  if (!auth) return;
  const rec = db.deleteTraining(auth.userId);
  return res.json(rec);
}

// Build training from memory items (optional helper)
export async function trainingBuild(req, res) {
  const auth = ensureAuth(req, res);
  if (!auth) return;
  const includeShort =
    req.body && typeof req.body.includeShort === 'boolean'
      ? req.body.includeShort
      : true;
  const includeLong =
    req.body && typeof req.body.includeLong === 'boolean'
      ? req.body.includeLong
      : true;
  const ws =
    req.session && req.session.workspaceId
      ? req.session.workspaceId
      : 'default';
  const corpus = [];

  if (includeShort) {
    const items = db.listMemory(auth.userId, ws, 'short');
    for (const it of items)
      corpus.push({
        id: it.memid,
        scope: 'short',
        text: it.content,
        createdAt: it.createdAt,
        updatedAt: it.updatedAt,
      });
  }
  if (includeLong) {
    const items = db.listMemory(auth.userId, ws, 'long');
    for (const it of items)
      corpus.push({
        id: it.memid,
        scope: 'long',
        text: it.content,
        createdAt: it.createdAt,
        updatedAt: it.updatedAt,
      });
  }

  // Merge into training.data under a stable key
  const existing = db.getTraining(auth.userId);
  const base =
    existing && existing.data && typeof existing.data === 'object'
      ? existing.data
      : {};
  const next = { ...base, corpus: corpus };
  const rec = db.setTraining(
    auth.userId,
    next,
    existing && existing.trainid ? existing.trainid : undefined
  );
  return res.json(rec);
}
