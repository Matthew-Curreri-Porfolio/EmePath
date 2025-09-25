
import fs from 'fs';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.resolve(__dirname, 'migrations');


const isTest = process.env.NODE_ENV === 'test';

let db;
const DB_PATH = isTest ? ':memory:' : path.resolve(process.cwd(), 'gateway', 'db', 'app.db');

// Determine if a persistent DB already exists (before opening)
const existedBefore = !isTest && fs.existsSync(DB_PATH);
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// Open database with verbose logging only in tests or when creating a brand new DB
const wantVerbose = isTest || (!existedBefore && process.env.DB_VERBOSE !== '0') || process.env.DB_VERBOSE === '1';
db = new Database(DB_PATH, wantVerbose ? { verbose: console.log } : {});

// Run migrations
const migrationFiles = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();
// Idempotent helper to add columns only if missing
function hasColumn(dbInst, table, column) {
  try {
    const rows = dbInst.prepare(`PRAGMA table_info(${table})`).all();
    return rows.some((r) => r.name === column);
  } catch {
    return false;
  }
}
function ensureColumn(dbInst, table, column, type) {
  if (!hasColumn(dbInst, table, column)) {
    dbInst.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type};`);
  }
}

// Only perform migrations/bootstrap when using test DB or when the persistent DB did not exist
let needInit = isTest || !existedBefore;
// If DB file exists but tables are missing (corrupted/partial), force init
if (!needInit && !isTest) {
  try {
    const u = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
    const s = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='short_term_memory'").get();
    const l = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='long_term_memory'").get();
    if (!u || !u.name || !s || !s.name || !l || !l.name) needInit = true;
  } catch { needInit = true; }
}

if (needInit) {
  for (const file of migrationFiles) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    try {
      db.exec(sql);
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/duplicate column name:\s*working_tokens/i.test(msg)) {
        console.warn('[migrate] working_tokens already present, skipping');
      } else {
        throw e;
      }
    }
  }

  // Ensure columns exist even if migration was commented/ran before
  try {
    ensureColumn(db, 'short_term_memory', 'working_tokens', 'BLOB');
    ensureColumn(db, 'long_term_memory', 'working_tokens', 'BLOB');
    ensureColumn(db, 'short_term_memory', 'memid', 'TEXT');
    ensureColumn(db, 'long_term_memory', 'memid', 'TEXT');
    ensureColumn(db, 'short_term_memory', 'created_at', 'DATETIME DEFAULT CURRENT_TIMESTAMP');
    ensureColumn(db, 'long_term_memory', 'created_at', 'DATETIME DEFAULT CURRENT_TIMESTAMP');
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/duplicate column name:/i.test(msg)) {
      console.warn('[ensure] column already present, skipping');
    } else {
      throw e;
    }
  }

  // Backfill newly added columns so UNIQUE indexes can be applied safely
  try {
    db.exec(`UPDATE short_term_memory SET memid = COALESCE(NULLIF(memid, ''), 'default')`);
    db.exec(`UPDATE long_term_memory SET memid = COALESCE(NULLIF(memid, ''), 'default')`);
    db.exec(`UPDATE short_term_memory SET created_at = COALESCE(created_at, updated_at, CURRENT_TIMESTAMP)`);
    db.exec(`UPDATE long_term_memory SET created_at = COALESCE(created_at, updated_at, CURRENT_TIMESTAMP)`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_short_term_memid ON short_term_memory(user_id, workspace_id, memid)`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_long_term_memid ON long_term_memory(user_id, workspace_id, memid)`);
  } catch (e) {
    console.warn('[ensure] memory index backfill warning:', String(e && e.message || e));
  }

  // Bootstrap a default admin user for development/testing if no users exist
  try {
    const row = db.prepare('SELECT COUNT(1) AS c FROM users').get();
    if (!row || Number(row.c) === 0) {
      db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(['admin', 'changethis']);
      console.log('[bootstrap] created default admin user with password "changethis"');
    }
  } catch (e) {
    // ignore if table not ready or any race in tests
    console.warn('[bootstrap] default admin check failed:', String(e && e.message || e));
  }
}

export function run(sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    const info = stmt.run(params);
    return info;
  } catch (err) {
    throw err;
  }
}
export function get(sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    const row = stmt.get(params);
    return row;
  } catch (err) {
    throw err;
  }
}

export function all(sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    return stmt.all(params);
  } catch (err) {
    throw err;
  }
}

const DEFAULT_MEMID = 'default';

function tableForScope(scope) {
  if (scope === 'short') return 'short_term_memory';
  if (scope === 'long') return 'long_term_memory';
  throw new Error(`invalid memory scope: ${scope}`);
}

function normalizeMemid(memid) {
  return memid && String(memid).trim() ? String(memid).trim() : DEFAULT_MEMID;
}

function mapMemoryRow(row) {
  if (!row) return null;
  return {
    memid: row.memid || DEFAULT_MEMID,
    content: row.content || '',
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    workingTokens: row.working_tokens || null,
  };
}

export function getMemory(userId, workspaceId, scope, memid) {
  const table = tableForScope(scope);
  const row = get(
    `SELECT memid, content, created_at, updated_at, working_tokens FROM ${table} WHERE user_id = ? AND workspace_id = ? AND memid = ? LIMIT 1`,
    [userId, workspaceId, normalizeMemid(memid)]
  );
  return mapMemoryRow(row);
}

export function listMemory(userId, workspaceId, scope) {
  const table = tableForScope(scope);
  const rows = all(
    `SELECT memid, content, created_at, updated_at, working_tokens FROM ${table} WHERE user_id = ? AND workspace_id = ? ORDER BY updated_at DESC`,
    [userId, workspaceId]
  );
  return rows.map(mapMemoryRow);
}

export function deleteMemory(userId, workspaceId, scope, memid) {
  const table = tableForScope(scope);
  const info = run(
    `DELETE FROM ${table} WHERE user_id = ? AND workspace_id = ? AND memid = ?`,
    [userId, workspaceId, normalizeMemid(memid)]
  );
  return info.changes > 0;
}

export function upsertMemory(userId, workspaceId, scope, memid, content, mode = 'set', separator = '\n') {
  const table = tableForScope(scope);
  const id = normalizeMemid(memid);
  const sep = typeof separator === 'string' ? separator : '\n';
  const existing = getMemory(userId, workspaceId, scope, id);

  let nextContent;
  if (mode === 'clear') {
    nextContent = '';
  } else if (mode === 'append' && existing) {
    const base = existing.content || '';
    nextContent = base ? `${base}${sep}${content}` : String(content || '');
  } else {
    nextContent = String(content || '');
  }

  if (existing) {
    run(
      `UPDATE ${table} SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND workspace_id = ? AND memid = ?`,
      [nextContent, userId, workspaceId, id]
    );
  } else {
    run(
      `INSERT INTO ${table} (user_id, workspace_id, memid, content, created_at, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [userId, workspaceId, id, nextContent]
    );
  }

  return getMemory(userId, workspaceId, scope, id);
}

export function getUserByUsername(username) {
  const row = get('SELECT * FROM users WHERE username = ?', [username]);
  return row;
}
export function createUser(username, passwordHash) {
  const info = run('INSERT INTO users (username, password_hash) VALUES (?, ?)', [username, passwordHash]);
  return { id: info.lastInsertRowid, username };
}
export function setShortTerm(userId, workspaceId, content) {
  upsertMemory(userId, workspaceId, 'short', DEFAULT_MEMID, content, 'set');
}
export function getShortTerm(userId, workspaceId) {
  const row = getMemory(userId, workspaceId, 'short', DEFAULT_MEMID);
  return row ? row.content : '';
}
export function setLongTerm(userId, workspaceId, content) {
  upsertMemory(userId, workspaceId, 'long', DEFAULT_MEMID, content, 'set');
}
export function getLongTerm(userId, workspaceId) {
  const row = getMemory(userId, workspaceId, 'long', DEFAULT_MEMID);
  return row ? row.content : '';
}

// Forecasts CRUD
export function insertForecast(f) {
  const sql = `INSERT INTO forecasts (topic, question, resolution_criteria, horizon_ts, probability, rationale, methodology_tags, sources, status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')`;
  const params = [
    f.topic,
    f.question,
    f.resolution_criteria,
    f.horizon_ts,
    Math.max(0, Math.min(1, Number(f.probability) || 0)),
    f.rationale || '',
    JSON.stringify(f.methodology_tags || []),
    JSON.stringify(f.sources || []),
  ];
  const info = run(sql, params);
  return info.lastInsertRowid;
}

export function listForecasts({ status, topic, limit=100 } = {}) {
  let sql = 'SELECT * FROM forecasts';
  const where = [];
  const params = [];
  if (status) { where.push('status = ?'); params.push(String(status)); }
  if (topic) { where.push('topic LIKE ?'); params.push(`%${topic}%`); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY horizon_ts ASC LIMIT ?';
  params.push(Math.min(500, Math.max(1, Number(limit)||100)));
  const stmt = db.prepare(sql);
  return stmt.all(params);
}

export function listDueForecasts({ nowTs = new Date().toISOString(), limit = 50 } = {}) {
  const sql = `SELECT * FROM forecasts WHERE status = 'open' AND horizon_ts <= ? ORDER BY horizon_ts ASC LIMIT ?`;
  const stmt = db.prepare(sql);
  return stmt.all([ nowTs, Math.min(200, Math.max(1, Number(limit)||50)) ]);
}

export function resolveForecast(id, { outcome, judge, resolved_at = new Date().toISOString(), brier_score = null, notes = null } = {}) {
  const sql = `UPDATE forecasts SET status='resolved', outcome=?, judge=?, resolved_at=?, brier_score=?, notes=? WHERE id=?`;
  run(sql, [ String(outcome||'unknown'), JSON.stringify(judge||{}), resolved_at, (brier_score==null? null : Number(brier_score)), notes, id ]);
}

export default {
  getUserByUsername,
  createUser,
  setShortTerm,
  getShortTerm,
  setLongTerm,
  getLongTerm,
  getMemory,
  listMemory,
  upsertMemory,
  deleteMemory,
  insertForecast,
  listForecasts,
  listDueForecasts,
  resolveForecast,
  run,
  get,
  all,
};
