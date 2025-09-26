// gateway/usecases/memory.js
import crypto from 'crypto';
import db from '../db/db.js';

const MAX_SHORT = 64 * 1024;
const MAX_LONG = 512 * 1024;

function ensureAuth(req, res) {
  const userId = req.session?.userId;
  const workspaceId = req.session?.workspaceId;
  if (!userId || !workspaceId) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return null;
  }
  return { userId, workspaceId };
}
const size = (s) => Buffer.byteLength(s || '', 'utf8');
const needId = (mode) => mode === 'append' || mode === 'clear';

export async function memoryShortUseCase(req, res, deps) {
  const auth = ensureAuth(req, res);
  if (!auth) return;
  const { log } = deps;
  let { memid, content = '', mode = 'set', separator } = req.body || {};
  if (needId(mode) && !memid)
    return res
      .status(400)
      .json({ ok: false, error: 'memid required for mode ' + mode });
  if (!memid) memid = crypto.randomUUID();

  const current = db.getMemory(auth.userId, auth.workspaceId, 'short', memid);
  const baseContent = current?.content || '';
  const nextContent =
    mode === 'clear'
      ? ''
      : mode === 'append'
        ? baseContent
          ? baseContent + (separator ?? '\n') + content
          : content
        : content;
  if (size(nextContent) > MAX_SHORT)
    return res.status(413).json({
      ok: false,
      error: 'short memory limit exceeded',
      bytes: size(nextContent),
      max: MAX_SHORT,
    });

  const rec = db.upsertMemory(
    auth.userId,
    auth.workspaceId,
    'short',
    memid,
    content,
    mode,
    separator
  );
  if (log)
    log('memory.short', {
      userId: auth.userId,
      ws: auth.workspaceId,
      memid: rec.memid,
      mode,
    });
  return res.json({
    ok: true,
    memid: rec.memid,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    bytes: size(rec.content),
    preview: rec.content.slice(-256),
  });
}

export async function memoryLongUseCase(req, res, deps) {
  const auth = ensureAuth(req, res);
  if (!auth) return;
  const { log } = deps;
  let { memid, content = '', mode = 'set', separator } = req.body || {};
  if (needId(mode) && !memid)
    return res
      .status(400)
      .json({ ok: false, error: 'memid required for mode ' + mode });
  if (!memid) memid = crypto.randomUUID();

  const current = db.getMemory(auth.userId, auth.workspaceId, 'long', memid);
  const baseContent = current?.content || '';
  const nextContent =
    mode === 'clear'
      ? ''
      : mode === 'append'
        ? baseContent
          ? baseContent + (separator ?? '\n') + content
          : content
        : content;
  if (size(nextContent) > MAX_LONG)
    return res.status(413).json({
      ok: false,
      error: 'long memory limit exceeded',
      bytes: size(nextContent),
      max: MAX_LONG,
    });

  const rec = db.upsertMemory(
    auth.userId,
    auth.workspaceId,
    'long',
    memid,
    content,
    mode,
    separator
  );
  if (log)
    log('memory.long', {
      userId: auth.userId,
      ws: auth.workspaceId,
      memid: rec.memid,
      mode,
    });
  return res.json({
    ok: true,
    memid: rec.memid,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    bytes: size(rec.content),
    preview: rec.content.slice(-256),
  });
}

// Convenience getters for routes
export async function memoryList(req, res, scope) {
  const auth =
    req.session && req.session.userId && req.session.workspaceId
      ? { userId: req.session.userId, workspaceId: req.session.workspaceId }
      : null;
  if (!auth) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const items = db.listMemory(auth.userId, auth.workspaceId, scope);
  const content = items.map((i) => i.content).join('\n');
  return res.json({
    items,
    content,
    bytes: Buffer.byteLength(content, 'utf8'),
  });
}
export async function memoryGet(req, res, scope) {
  const auth =
    req.session && req.session.userId && req.session.workspaceId
      ? { userId: req.session.userId, workspaceId: req.session.workspaceId }
      : null;
  if (!auth) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const { memid } = req.params;
  if (!memid)
    return res.status(400).json({ ok: false, error: 'memid required' });
  const rec = db.getMemory(auth.userId, auth.workspaceId, scope, memid);
  if (!rec) return res.status(404).json({ ok: false, error: 'not found' });
  return res.json(rec);
}
export async function memoryDelete(req, res, scope) {
  const auth =
    req.session && req.session.userId && req.session.workspaceId
      ? { userId: req.session.userId, workspaceId: req.session.workspaceId }
      : null;
  if (!auth) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const { memid } = req.params;
  if (!memid)
    return res.status(400).json({ ok: false, error: 'memid required' });
  const ok = db.deleteMemory(auth.userId, auth.workspaceId, scope, memid);
  if (!ok) return res.status(404).json({ ok: false, error: 'not found' });
  return res.json({ ok: true, memid });
}
