-- Filesystem index for local crawling and summaries

CREATE TABLE IF NOT EXISTS files_index (
  path TEXT PRIMARY KEY,
  size INTEGER,
  mtime INTEGER,
  kind TEXT,             -- 'file' | 'dir' | 'link' | 'other'
  sha256 TEXT,           -- optional for files (may be NULL)
  added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_files_index_mtime ON files_index(mtime);
CREATE INDEX IF NOT EXISTS idx_files_index_kind ON files_index(kind);

CREATE TABLE IF NOT EXISTS file_summaries (
  path TEXT PRIMARY KEY,
  summary TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

