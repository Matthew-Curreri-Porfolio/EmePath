
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

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// Open database
if (isTest) {
  db = new Database(DB_PATH, { verbose: console.log });
} else {
  db = new Database(DB_PATH, { verbose: console.log });
}

// Run migrations
const migrationFiles = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();
for (const file of migrationFiles) {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
  db.exec(sql);
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

export function getUserByUsername(username) {
  const row = get('SELECT * FROM users WHERE username = ?', [username]);
  return row;
}
export function createUser(username, passwordHash) {
  const info = run('INSERT INTO users (username, password_hash) VALUES (?, ?)', [username, passwordHash]);
  return { id: info.lastInsertRowid, username };
}
export function setShortTerm(userId, workspaceId, content) {
  run(
    `INSERT INTO short_term_memory (user_id, workspace_id, content) VALUES (?, ?, ?)
ON CONFLICT(user_id, workspace_id) DO UPDATE SET content = excluded.content, updated_at = CURRENT_TIMESTAMP`,
    [userId, workspaceId, content]
  );
}
export function getShortTerm(userId, workspaceId) {
  const row = get('SELECT content FROM short_term_memory WHERE user_id = ? AND workspace_id = ?', [userId, workspaceId]);
  return row ? row.content : '';
}
export function setLongTerm(userId, workspaceId, content) {
  run(
    `INSERT INTO long_term_memory (user_id, workspace_id, content) VALUES (?, ?, ?)
ON CONFLICT(user_id, workspace_id) DO UPDATE SET content = excluded.content, updated_at = CURRENT_TIMESTAMP`,
    [userId, workspaceId, content]
  );
}
export function getLongTerm(userId, workspaceId) {
  const row = get('SELECT content FROM long_term_memory WHERE user_id = ? AND workspace_id = ?', [userId, workspaceId]);
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
  insertForecast,
  listForecasts,
  listDueForecasts,
  resolveForecast,
  run,
  get,
  all,
};
