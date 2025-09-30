-- Migration 003: LLM cache + request logs

CREATE TABLE IF NOT EXISTS llm_cache (
  key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                 -- 'chat' | 'complete' | other
  model TEXT,
  request TEXT,                       -- JSON string of normalized request
  response TEXT,                      -- primary textual response (assistant content or completion text)
  raw TEXT,                           -- JSON string of raw upstream object, if available
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_llm_cache_expires ON llm_cache(expires_at);

CREATE TABLE IF NOT EXISTS llm_requests (
  id TEXT PRIMARY KEY,                -- uuid
  kind TEXT NOT NULL,                 -- 'chat' | 'complete' | other
  model TEXT,
  request TEXT,                       -- JSON string of normalized request
  response TEXT,                      -- textual response
  raw TEXT,                           -- JSON string of raw upstream object, if available
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

