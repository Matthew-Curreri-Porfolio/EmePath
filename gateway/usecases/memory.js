// gateway/usecases/memory.js
import db from '../db/db.js';

export async function memoryShortUseCase(req, res, deps) {
  const { log } = deps;
  const { content } = req.body || {};
  console.log('memoryShortUseCase start', { userId: req.session?.userId, workspaceId: req.session?.workspaceId, content });
  if (typeof content !== 'string') {
    console.log('memoryShortUseCase bad content', { content });
    return res.status(400).json({ error: 'content must be string' });
  }
  console.log('memoryShortUseCase writing to DB');
  db.setShortTerm(req.session.userId, req.session.workspaceId, content);
  console.log('memoryShortUseCase wrote to DB, responding');
  res.json({ ok: true });
}

export async function memoryLongUseCase(req, res, deps) {
  const { log } = deps;
  const { content } = req.body || {};
  if (typeof content !== 'string') {
    return res.status(400).json({ error: 'content must be string' });
  }
  db.setLongTerm(req.session.userId, req.session.workspaceId, content);
  res.json({ ok: true });
}

export async function memoryRetrieveShortTerm(userId, workspaceId) {
  return db.getShortTerm(userId, workspaceId);
}

export async function memoryRetrieveLongTerm(userId, workspaceId) {
  return db.getLongTerm(userId, workspaceId);
}

export async function memoryClearShortTerm(userId, workspaceId) {
  db.setShortTerm(userId, workspaceId, '');
}

export async function memoryClearLongTerm(userId, workspaceId) {
  db.setLongTerm(userId, workspaceId, '');
}