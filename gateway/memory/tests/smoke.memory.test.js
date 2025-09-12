// Smoke test for memory adapter with better-sqlite3
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { createMemory } from '../index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadMigrations(db) {
  const migrationsDir = path.resolve(__dirname, '../../db/migrations');
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    db.exec(sql);
  }
}

async function main() {
  const db = new Database(':memory:');
  loadMigrations(db);

  const adapter = createMemory({
    dialect: 'sqlite',
    db: {
      run: async (sql, params = []) => db.prepare(sql).run(params),
      get: async (sql, params = []) => db.prepare(sql).get(params),
    },
  });

  const scope = { type: 'short', userId: 1, workspaceId: 'ws-1' };

  // Save JSON-only first
  await adapter.saveWorking(scope, { phase: 'init', count: 1 }, { encode: false });
  let r1 = await adapter.getWorking(scope, { decode: true });
  if (r1.state.phase !== 'init') throw new Error('state mismatch after JSON save');
  if (r1.snapshot !== null) throw new Error('snapshot should be null when encode=false');

  // Save with encoded snapshot
  await adapter.saveWorking(scope, { phase: 'encode', tokens: [1, 2, 3] }, { encode: true });
  const r2 = await adapter.getWorking(scope, { decode: true });
  if (!r2.snapshot || !r2.snapshot.bytes) throw new Error('expected encoded snapshot');

  // Handoff snapshot from short -> apply to long
  const snap = await adapter.handoffSnapshot(scope);
  if (!snap.bytes) throw new Error('handoff snapshot missing bytes');
  await adapter.applySnapshot({ type: 'long', userId: 1, workspaceId: 'ws-1' }, snap);
  const r3 = await adapter.getWorking({ type: 'long', userId: 1, workspaceId: 'ws-1' }, { decode: true });
  if (!r3.snapshot) throw new Error('long-term snapshot not applied');

  console.log('memory smoke ok:', {
    short: { state: r2.state, hasSnapshot: !!r2.snapshot },
    long: { hasSnapshot: !!r3.snapshot },
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error('memory smoke failed:', e);
    process.exit(1);
  });
}

export default main;
