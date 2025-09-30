-- 005_agents_jobs.sql

CREATE TABLE IF NOT EXISTS agents_state (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  goal TEXT,
  input TEXT,
  expected TEXT,
  status TEXT,
  last_check_in DATETIME,
  eots INTEGER,
  note TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agents_state_user_ws ON agents_state(user_id, workspace_id);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  user_id INTEGER,
  workspace_id TEXT,
  status TEXT,
  meta TEXT,
  error TEXT,
  started_at DATETIME,
  finished_at DATETIME
);

