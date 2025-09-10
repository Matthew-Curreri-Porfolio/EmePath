// gateway/db/db.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_FILE = path.join(__dirname, 'memory.store.json');

function isoSeconds(d=new Date()) {
  const t = Math.floor(d.getTime() / 1000) * 1000;
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

let store = { users: {} };
try {
  if (fs.existsSync(DATA_FILE)) {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    store = JSON.parse(raw);
  }
} catch {
  store = { users: {} };
}

function save() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

function ensureUser(userId) {
  if (!store.users[userId]) {
    store.users[userId] = {};
  }
  // Ensure training object exists
  if (!store.users[userId].training) {
    store.users[userId].training = { trainid: null, data: {}, createdAt: null, updatedAt: null };
  }
  return store.users[userId];
}

function scopeRef(userId, workspaceId, scope) {
  const u = ensureUser(userId);
  if (!u[workspaceId]) {
    u[workspaceId] = { short: {}, long: {} };
  } else {
    if (!u[workspaceId].short) u[workspaceId].short = {};
    if (!u[workspaceId].long) u[workspaceId].long = {};
  }
  return u[workspaceId][scope];
}

// ------- Memory API (memid-addressable records) -------
export function listMemory(userId, workspaceId, scope) {
  const b = scopeRef(userId, workspaceId, scope);
  return Object.values(b).sort((a, b) => {
    const au = a.updatedAt || a.createdAt || '';
    const bu = b.updatedAt || b.createdAt || '';
    return bu.localeCompare(au);
  });
}

export function getMemory(userId, workspaceId, scope, memid) {
  const b = scopeRef(userId, workspaceId, scope);
  if (!b[memid]) return null;
  return b[memid];
}

export function upsertMemory(userId, workspaceId, scope, memid, nextContent, mode, separator) {
  const b = scopeRef(userId, workspaceId, scope);
  const now = isoSeconds();
  const cur = b[memid] ? b[memid] : { memid: memid, content: '', createdAt: now, updatedAt: now };
  let content = cur.content ? cur.content : '';
  if (mode === 'clear') {
    content = '';
  } else if (mode === 'append') {
    const sep = typeof separator === 'string' ? separator : '\n';
    content = content ? content + sep + nextContent : nextContent;
  } else {
    content = nextContent;
  }
  const updated = { memid: memid, content: content, createdAt: cur.createdAt ? cur.createdAt : now, updatedAt: now };
  b[memid] = updated;
  save();
  return updated;
}

export function deleteMemory(userId, workspaceId, scope, memid) {
  const b = scopeRef(userId, workspaceId, scope);
  if (!b[memid]) return false;
  delete b[memid];
  save();
  return true;
}

// Legacy single-slot helpers (map to memid="default")
export function getShortTerm(userId, workspaceId) {
  const it = getMemory(userId, workspaceId, 'short', 'default');
  return it ? it.content : '';
}
export function setShortTerm(userId, workspaceId, content) {
  return upsertMemory(userId, workspaceId, 'short', 'default', content, 'set');
}
export function getLongTerm(userId, workspaceId) {
  const it = getMemory(userId, workspaceId, 'long', 'default');
  return it ? it.content : '';
}
export function setLongTerm(userId, workspaceId, content) {
  return upsertMemory(userId, workspaceId, 'long', 'default', content, 'set');
}

// ------- Training API (per-user JSON column) -------
export function getTraining(userId) {
  const u = ensureUser(userId);
  return u.training;
}

export function setTraining(userId, data, trainidOpt) {
  const u = ensureUser(userId);
  const now = isoSeconds();
  const trainid = trainidOpt && trainidOpt.length > 0 ? trainidOpt : (u.training.trainid ? u.training.trainid : cryptoRandom());
  u.training = {
    trainid: trainid,
    data: data && typeof data === 'object' ? data : {},
    createdAt: u.training.createdAt ? u.training.createdAt : now,
    updatedAt: now
  };
  save();
  return u.training;
}

export function patchTraining(userId, partial) {
  const u = ensureUser(userId);
  const now = isoSeconds();
  const base = u.training && u.training.data && typeof u.training.data === 'object' ? u.training.data : {};
  const merged = shallowMerge(base, partial);
  u.training = {
    trainid: u.training.trainid ? u.training.trainid : cryptoRandom(),
    data: merged,
    createdAt: u.training.createdAt ? u.training.createdAt : now,
    updatedAt: now
  };
  save();
  return u.training;
}

export function deleteTraining(userId) {
  const u = ensureUser(userId);
  const now = isoSeconds();
  u.training = { trainid: null, data: {}, createdAt: now, updatedAt: now };
  save();
  return u.training;
}

// ------- Utilities -------
function cryptoRandom() {
  // local simple UUID v4
  const rnd = () => Math.floor(Math.random() * 0xffffffff);
  const a = rnd().toString(16).padStart(8, '0');
  const b = rnd().toString(16).padStart(8, '0');
  const c = rnd().toString(16).padStart(8, '0');
  const d = rnd().toString(16).padStart(8, '0');
  return a + '-' + b.substring(0,4) + '-' + b.substring(4,8) + '-' + c.substring(0,4) + '-' + c.substring(4,8) + d.substring(0,8);
}

function shallowMerge(base, partial) {
  const out = {};
  const keysBase = Object.keys(base || {});
  for (const k of keysBase) out[k] = base[k];
  const keysPart = Object.keys(partial || {});
  for (const k of keysPart) out[k] = partial[k];
  return out;
}

export default {
  // memory
  listMemory, getMemory, upsertMemory, deleteMemory,
  getShortTerm, setShortTerm, getLongTerm, setLongTerm,
  // training
  getTraining, setTraining, patchTraining, deleteTraining
};
