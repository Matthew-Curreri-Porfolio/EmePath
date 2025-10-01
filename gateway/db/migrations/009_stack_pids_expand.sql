-- Migration 009: Expand stack_pids to allow multiple entries and rich metadata
BEGIN TRANSACTION;
CREATE TABLE IF NOT EXISTS stack_pids_tmp (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  pid INTEGER NOT NULL,
  port INTEGER,
  role TEXT,
  tag TEXT,
  command TEXT,
  args TEXT,
  cwd TEXT,
  user TEXT,
  meta_json TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO stack_pids_tmp (id, name, pid, created_at)
SELECT 'legacy:' || name || ':' || pid, name, pid, COALESCE(created_at, CURRENT_TIMESTAMP)
FROM stack_pids;
DROP TABLE IF EXISTS stack_pids;
ALTER TABLE stack_pids_tmp RENAME TO stack_pids;
CREATE INDEX IF NOT EXISTS idx_stack_pids_name ON stack_pids(name);
CREATE INDEX IF NOT EXISTS idx_stack_pids_pid ON stack_pids(pid);
COMMIT;
