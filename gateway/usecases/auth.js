// gateway/usecases/auth.js
import { createSession, getSession } from '../db/session.js';
import db from '../db/db.js';

export async function loginUseCase(req, res, deps) {
  const { log } = deps;
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }
  const user = db.getUserByUsername(username);
  if (!user) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  if (user.password_hash !== password) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  const token = createSession(user.id, req.body?.workspaceId || 'default');
  res.json({ token, userId: user.id });
}

export function requireAuth(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'missing token' });
  }
  const token = auth.slice(7);
  const session = getSession(token);
  if (!session) {
    return res.status(401).json({ error: 'invalid token' });
  }
  req.session = session;
  next();
}
