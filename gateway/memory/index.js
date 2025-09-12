// Memory adapter with additive binary snapshot support (working_tokens column).
// Dialects: sqlite | postgres

import * as RAX1 from './encoders/rax1.js';

function ensureDialect(dialect) {
  const d = (dialect || 'sqlite').toLowerCase();
  if (!['sqlite', 'postgres'].includes(d)) throw new Error('Unsupported dialect');
  return d;
}

function serializeState(state) {
  return JSON.stringify(state ?? {});
}

function bufferFrom(bytes) {
  // Accept Uint8Array or Buffer; normalize to Buffer for common DB drivers
  if (!bytes) return null;
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
}

function tableName(type) {
  if (type === 'short') return 'short_term_memory';
  if (type === 'long') return 'long_term_memory';
  throw new Error('type must be "short" or "long"');
}

export function createMemory({ db, dialect = 'sqlite', encoder = RAX1 } = {}) {
  const d = ensureDialect(dialect);

  function upsertSQL(t) {
    if (d === 'sqlite') {
      return `INSERT INTO ${t} (user_id, workspace_id, content, working_tokens, updated_at)
              VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
              ON CONFLICT(user_id, workspace_id) DO UPDATE SET
                content=excluded.content,
                working_tokens=excluded.working_tokens,
                updated_at=CURRENT_TIMESTAMP`;
    }
    // postgres
    return `INSERT INTO ${t} (user_id, workspace_id, content, working_tokens, updated_at)
            VALUES ($1, $2, $3, $4, NOW())
            ON CONFLICT (user_id, workspace_id) DO UPDATE SET
              content=EXCLUDED.content,
              working_tokens=EXCLUDED.working_tokens,
              updated_at=NOW()`;
  }

  function selectSQL(t) {
    return `SELECT user_id, workspace_id, content, working_tokens, updated_at FROM ${t} WHERE user_id = ${d === 'sqlite' ? '?' : '$1'} AND workspace_id = ${d === 'sqlite' ? '?' : '$2'} LIMIT 1`;
  }

  async function saveWorking(scope, state, opts = {}) {
    const { type, userId, workspaceId } = scope;
    const t = tableName(type);
    const content = serializeState(state);
    let bytes = null;
    if (opts.encode) {
      const enc = await encoder.encode(state);
      bytes = bufferFrom(enc.bytes);
    }
    const sql = upsertSQL(t);
    const params = d === 'sqlite' ? [userId, workspaceId, content, bytes] : [userId, workspaceId, content, bytes];
    if (typeof db.run === 'function') {
      await db.run(sql, params);
    } else if (typeof db.query === 'function') {
      await db.query(sql, params);
    } else {
      throw new Error('db must provide run(sql, params) or query(sql, params)');
    }
    return { ok: true };
  }

  async function getWorking(scope, opts = {}) {
    const { type, userId, workspaceId } = scope;
    const t = tableName(type);
    const sql = selectSQL(t);
    const params = d === 'sqlite' ? [userId, workspaceId] : [userId, workspaceId];
    let row;
    if (typeof db.get === 'function') {
      row = await db.get(sql, params);
    } else if (typeof db.query === 'function') {
      const res = await db.query(sql, params);
      row = res?.rows ? res.rows[0] : res?.[0];
    } else {
      throw new Error('db must provide get(sql, params) or query(sql, params)');
    }
    if (!row) return { state: {}, snapshot: null };
    let state = {};
    try { state = JSON.parse(row.content || '{}'); } catch {}

    let decoded = null;
    const bytes = row.working_tokens && Buffer.from(row.working_tokens);
    if (opts.decode && bytes) {
      const out = await encoder.decode(new Uint8Array(bytes));
      decoded = out;
    }
    return { state, snapshot: bytes ? { bytes: new Uint8Array(bytes), meta: null } : null, decoded };
  }

  async function handoffSnapshot(scope) {
    const { type, userId, workspaceId } = scope;
    const t = tableName(type);
    const sql = selectSQL(t);
    const params = d === 'sqlite' ? [userId, workspaceId] : [userId, workspaceId];
    let row;
    if (typeof db.get === 'function') {
      row = await db.get(sql, params);
    } else if (typeof db.query === 'function') {
      const res = await db.query(sql, params);
      row = res?.rows ? res.rows[0] : res?.[0];
    } else {
      throw new Error('db must provide get(sql, params) or query(sql, params)');
    }
    if (!row || !row.working_tokens) return { bytes: null, meta: null };
    const bytes = new Uint8Array(Buffer.from(row.working_tokens));
    return { bytes, meta: null };
  }

  async function applySnapshot(scope, snapshot) {
    const { type, userId, workspaceId } = scope;
    const t = tableName(type);
    const sql = upsertSQL(t);
    const emptyContent = serializeState({});
    const bytes = bufferFrom(snapshot?.bytes);
    const params = d === 'sqlite' ? [userId, workspaceId, emptyContent, bytes] : [userId, workspaceId, emptyContent, bytes];
    if (typeof db.run === 'function') {
      await db.run(sql, params);
    } else if (typeof db.query === 'function') {
      await db.query(sql, params);
    } else {
      throw new Error('db must provide run(sql, params) or query(sql, params)');
    }
    return { ok: true };
  }

  return { saveWorking, getWorking, handoffSnapshot, applySnapshot };
}

export default { createMemory };
