import crypto from 'crypto';
// Simple in‑memory session store
// Maps session token -> { userId, workspaceId }
const sessions = new Map();

export function createSession(userId, workspaceId) {
  const token = crypto.randomUUID();
  sessions.set(token, { userId, workspaceId });
  return token;
}
export function getSession(token) {
  return sessions.get(token);
}
export function deleteSession(token) {
  sessions.delete(token);
}
