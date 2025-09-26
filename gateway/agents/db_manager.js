// Database Manager Agent: encodes memory rows into working_tokens using the RAX1 encoder
// while preserving existing content columns.

import { all, run } from '../db/db.js';
import * as RAX1 from '../memory/encoders/rax1.js';

async function encodeRow(table, row) {
  const state = { content: row.content || '' };
  const { bytes } = await RAX1.encode(state);
  const buf = Buffer.from(bytes);
  run(
    `UPDATE ${table} SET working_tokens = ? , updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [buf, row.id]
  );
}

export async function encodeAllMemories({ reencode = false } = {}) {
  const tables = ['short_term_memory', 'long_term_memory'];
  let processed = 0;
  for (const t of tables) {
    const rows = all(`SELECT id, content, working_tokens FROM ${t}`);
    for (const row of rows) {
      if (!reencode && row.working_tokens) continue;
      await encodeRow(t, row);
      processed += 1;
    }
  }
  return { ok: true, processed };
}

export default { encodeAllMemories };
