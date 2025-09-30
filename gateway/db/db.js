import fs from 'fs';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.resolve(__dirname, 'migrations');

const isTest = process.env.NODE_ENV === 'test';

let db;
const DB_PATH = isTest
  ? ':memory:'
  : path.resolve(process.cwd(), 'gateway', 'db', 'app.db');

// Determine if a persistent DB already exists (before opening)
const existedBefore = !isTest && fs.existsSync(DB_PATH);
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// Open database with verbose logging only in tests or when creating a brand new DB
const wantVerbose =
  isTest ||
  (!existedBefore && process.env.DB_VERBOSE !== '0') ||
  process.env.DB_VERBOSE === '1';
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
    const u = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='users'"
      )
      .get();
    const s = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='short_term_memory'"
      )
      .get();
    const l = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='long_term_memory'"
      )
      .get();
    if (!u || !u.name || !s || !s.name || !l || !l.name) needInit = true;
  } catch {
    needInit = true;
  }
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
    ensureColumn(
      db,
      'short_term_memory',
      'created_at',
      'DATETIME DEFAULT CURRENT_TIMESTAMP'
    );
    ensureColumn(
      db,
      'long_term_memory',
      'created_at',
      'DATETIME DEFAULT CURRENT_TIMESTAMP'
    );
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
    db.exec(
      `UPDATE short_term_memory SET memid = COALESCE(NULLIF(memid, ''), 'default')`
    );
    db.exec(
      `UPDATE long_term_memory SET memid = COALESCE(NULLIF(memid, ''), 'default')`
    );
    db.exec(
      `UPDATE short_term_memory SET created_at = COALESCE(created_at, updated_at, CURRENT_TIMESTAMP)`
    );
    db.exec(
      `UPDATE long_term_memory SET created_at = COALESCE(created_at, updated_at, CURRENT_TIMESTAMP)`
    );
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_short_term_memid ON short_term_memory(user_id, workspace_id, memid)`
    );
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_long_term_memid ON long_term_memory(user_id, workspace_id, memid)`
    );
  } catch (e) {
    console.warn(
      '[ensure] memory index backfill warning:',
      String((e && e.message) || e)
    );
  }

  // Bootstrap a default admin user for development/testing if no users exist
  try {
    const row = db.prepare('SELECT COUNT(1) AS c FROM users').get();
    if (!row || Number(row.c) === 0) {
      db.prepare(
        'INSERT INTO users (username, password_hash) VALUES (?, ?)'
      ).run(['admin', 'changethis']);
      console.log(
        '[bootstrap] created default admin user with password "changethis"'
      );
    }
  } catch (e) {
    // ignore if table not ready or any race in tests
    console.warn(
      '[bootstrap] default admin check failed:',
      String((e && e.message) || e)
    );
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

// -------------- LLM cache + logging --------------

function tryParseJSON(x) {
  try {
    return JSON.parse(String(x || ''));
  } catch {
    return null;
  }
}

export function cacheGet(kind, key) {
  const row = get(
    `SELECT key, kind, model, request, response, raw, created_at, expires_at FROM llm_cache WHERE key = ? LIMIT 1`,
    [key]
  );
  if (!row) return null;
  if (row.expires_at) {
    const expTs = Date.parse(row.expires_at);
    if (Number.isFinite(expTs) && expTs < Date.now()) {
      // expired; best-effort cleanup
      try {
        run(`DELETE FROM llm_cache WHERE key = ?`, [key]);
      } catch {}
      return null;
    }
  }
  return {
    key: row.key,
    kind: row.kind,
    model: row.model,
    request: tryParseJSON(row.request),
    response: row.response,
    raw: tryParseJSON(row.raw),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export function cachePut(
  kind,
  key,
  { model, requestObj, responseText, rawObj, ttlMs }
) {
  const now = new Date();
  const exp = ttlMs && ttlMs > 0 ? new Date(now.getTime() + ttlMs) : null;
  const expires = exp ? exp.toISOString() : null;
  run(
    `INSERT OR REPLACE INTO llm_cache (key, kind, model, request, response, raw, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, COALESCE(
       (SELECT created_at FROM llm_cache WHERE key = ?),
       CURRENT_TIMESTAMP
     ), ?)`,
    [
      key,
      kind,
      model || null,
      requestObj ? JSON.stringify(requestObj) : null,
      responseText ?? null,
      rawObj ? JSON.stringify(rawObj) : null,
      key,
      expires,
    ]
  );
}

export function logLLM(
  kind,
  {
    model,
    requestObj,
    responseText,
    rawObj,
    promptTokens,
    completionTokens,
    totalTokens,
    costUsd,
  }
) {
  const id = randomUUID();
  run(
    `INSERT INTO llm_requests (id, kind, model, request, response, raw, created_at, prompt_tokens, completion_tokens, total_tokens, cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?)`,
    [
      id,
      kind,
      model || null,
      requestObj ? JSON.stringify(requestObj) : null,
      responseText ?? null,
      rawObj ? JSON.stringify(rawObj) : null,
      typeof promptTokens === 'number' ? promptTokens : null,
      typeof completionTokens === 'number' ? completionTokens : null,
      typeof totalTokens === 'number' ? totalTokens : null,
      typeof costUsd === 'number' ? costUsd : null,
    ]
  );
  return id;
}

export function purgeExpiredCache() {
  try {
    const info = run(
      `DELETE FROM llm_cache WHERE expires_at IS NOT NULL AND expires_at < CURRENT_TIMESTAMP`
    );
    return info?.changes || 0;
  } catch (e) {
    return 0;
  }
}

export function cacheStats() {
  const summary = get(
    `SELECT COUNT(1) as count, MIN(created_at) as oldest, MAX(created_at) as newest FROM llm_cache`,
    []
  );
  const expiring = get(
    `SELECT COUNT(1) as expiring FROM llm_cache WHERE expires_at IS NOT NULL AND expires_at < datetime('now', '+5 minutes')`,
    []
  );
  return {
    count: Number(summary?.count || 0),
    oldest: summary?.oldest || null,
    newest: summary?.newest || null,
    expiringSoon: Number(expiring?.expiring || 0),
  };
}

// ------- LLM request audit queries -------
function mapLLMRow(row) {
  if (!row) return null;
  const tryJSON = (v) => {
    try {
      return JSON.parse(String(v || ''));
    } catch {
      return null;
    }
  };
  return {
    id: row.id,
    kind: row.kind,
    model: row.model,
    createdAt: row.created_at,
    request: row.request ? tryJSON(row.request) : null,
    response: row.response ?? null,
    raw: row.raw ? tryJSON(row.raw) : null,
    promptTokens: row.prompt_tokens ?? null,
    completionTokens: row.completion_tokens ?? null,
    totalTokens: row.total_tokens ?? null,
    costUsd: row.cost_usd ?? null,
  };
}

export function listLLMRequests({
  model,
  kind,
  since,
  until,
  limit = 50,
  offset = 0,
  includeRequest = false,
  includeRaw = false,
} = {}) {
  const where = [];
  const args = [];
  if (model) {
    where.push('model = ?');
    args.push(model);
  }
  if (kind) {
    where.push('kind = ?');
    args.push(kind);
  }
  if (since) {
    where.push('created_at >= ?');
    args.push(since);
  }
  if (until) {
    where.push('created_at <= ?');
    args.push(until);
  }
  const selReq = includeRequest ? ', request' : '';
  const selRaw = includeRaw ? ', raw' : '';
  const sql = `SELECT id, kind, model, created_at, response, prompt_tokens, completion_tokens, total_tokens, cost_usd${selReq}${selRaw}
              FROM llm_requests ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
              ORDER BY datetime(created_at) DESC
              LIMIT ? OFFSET ?`;
  args.push(Math.min(Math.max(1, Number(limit) || 50), 500));
  args.push(Math.max(0, Number(offset) || 0));
  const rows = all(sql, args);
  return rows.map(mapLLMRow);
}

export function getLLMRequestById(id) {
  const row = get(
    `SELECT id, kind, model, created_at, request, response, raw, prompt_tokens, completion_tokens, total_tokens, cost_usd FROM llm_requests WHERE id = ? LIMIT 1`,
    [id]
  );
  return mapLLMRow(row);
}

export function summarizeLLMRequests({
  since,
  until,
  kind,
  group = 'model',
  limit = 100,
  offset = 0,
} = {}) {
  const where = [];
  const args = [];
  if (kind) {
    where.push('kind = ?');
    args.push(kind);
  }
  if (since) {
    where.push('created_at >= ?');
    args.push(since);
  }
  if (until) {
    where.push('created_at <= ?');
    args.push(until);
  }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const lim = Math.min(Math.max(1, Number(limit) || 100), 1000);
  const off = Math.max(0, Number(offset) || 0);

  if (group === 'date') {
    const sql = `SELECT date(created_at) as day, COUNT(1) as count, MIN(created_at) as first, MAX(created_at) as last
                 FROM llm_requests ${clause}
                 GROUP BY day
                 ORDER BY day DESC
                 LIMIT ? OFFSET ?`;
    const rows = all(sql, [...args, lim, off]);
    return rows.map((r) => ({
      day: r.day,
      count: Number(r.count || 0),
      first: r.first,
      last: r.last,
    }));
  }
  if (group === 'model_date') {
    const sql = `SELECT COALESCE(model,'') as model, date(created_at) as day, COUNT(1) as count
                 FROM llm_requests ${clause}
                 GROUP BY model, day
                 ORDER BY model ASC, day DESC
                 LIMIT ? OFFSET ?`;
    const rows = all(sql, [...args, lim, off]);
    return rows.map((r) => ({
      model: r.model,
      day: r.day,
      count: Number(r.count || 0),
    }));
  }
  // default: group by model
  const sql = `SELECT COALESCE(model,'') as model, COUNT(1) as count, MIN(created_at) as first, MAX(created_at) as last
               FROM llm_requests ${clause}
               GROUP BY model
               ORDER BY count DESC, model ASC
               LIMIT ? OFFSET ?`;
  const rows = all(sql, [...args, lim, off]);
  return rows.map((r) => ({
    model: r.model,
    count: Number(r.count || 0),
    first: r.first,
    last: r.last,
  }));
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

export function upsertMemory(
  userId,
  workspaceId,
  scope,
  memid,
  content,
  mode = 'set',
  separator = '\n'
) {
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
  const info = run(
    'INSERT INTO users (username, password_hash) VALUES (?, ?)',
    [username, passwordHash]
  );
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

export function listForecasts({ status, topic, limit = 100 } = {}) {
  let sql = 'SELECT * FROM forecasts';
  const where = [];
  const params = [];
  if (status) {
    where.push('status = ?');
    params.push(String(status));
  }
  if (topic) {
    where.push('topic LIKE ?');
    params.push(`%${topic}%`);
  }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY horizon_ts ASC LIMIT ?';
  params.push(Math.min(500, Math.max(1, Number(limit) || 100)));
  const stmt = db.prepare(sql);
  return stmt.all(params);
}

export function listDueForecasts({
  nowTs = new Date().toISOString(),
  limit = 50,
} = {}) {
  const sql = `SELECT * FROM forecasts WHERE status = 'open' AND horizon_ts <= ? ORDER BY horizon_ts ASC LIMIT ?`;
  const stmt = db.prepare(sql);
  return stmt.all([nowTs, Math.min(200, Math.max(1, Number(limit) || 50))]);
}

export function resolveForecast(
  id,
  {
    outcome,
    judge,
    resolved_at = new Date().toISOString(),
    brier_score = null,
    notes = null,
  } = {}
) {
  const sql = `UPDATE forecasts SET status='resolved', outcome=?, judge=?, resolved_at=?, brier_score=?, notes=? WHERE id=?`;
  run(sql, [
    String(outcome || 'unknown'),
    JSON.stringify(judge || {}),
    resolved_at,
    brier_score == null ? null : Number(brier_score),
    notes,
    id,
  ]);
}

// ------- Projects CRUD -------
function mapProjectRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    name: row.name,
    description: row.description ?? null,
    active: Boolean(row.active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createProject(
  userId,
  workspaceId,
  { name, description = null, active = true }
) {
  const act = active ? 1 : 0;
  const info = run(
    `INSERT INTO projects (user_id, workspace_id, name, description, active) VALUES (?, ?, ?, ?, ?)`,
    [userId, String(workspaceId || 'default'), String(name), description, act]
  );
  const row = get(
    `SELECT id, user_id, workspace_id, name, description, active, created_at, updated_at FROM projects WHERE id = ?`,
    [info.lastInsertRowid]
  );
  return mapProjectRow(row);
}

export function listProjects(userId, workspaceId, { active } = {}) {
  const args = [userId, String(workspaceId || 'default')];
  let sql = `SELECT id, user_id, workspace_id, name, description, active, created_at, updated_at FROM projects WHERE user_id = ? AND workspace_id = ?`;
  if (typeof active === 'boolean') {
    sql += ' AND active = ?';
    args.push(active ? 1 : 0);
  }
  sql += ' ORDER BY datetime(created_at) DESC, id DESC';
  const rows = all(sql, args);
  return rows.map(mapProjectRow);
}

export function setProjectActive(userId, workspaceId, id, active) {
  const act = active ? 1 : 0;
  const info = run(
    `UPDATE projects SET active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND workspace_id = ?`,
    [act, id, userId, String(workspaceId || 'default')]
  );
  if (!info || !info.changes) return null;
  const row = get(
    `SELECT id, user_id, workspace_id, name, description, active, created_at, updated_at FROM projects WHERE id = ?`,
    [id]
  );
  return mapProjectRow(row);
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
  createProject,
  listProjects,
  setProjectActive,
  run,
  get,
  all,
};
