-- Migration: add binary/tokenized working memory snapshots for direct model consumption.
-- Target: SQLite (current file). For Postgres, see commented variant below.

-- short_term_memory: add working_tokens BLOB column (nullable, additive)
ALTER TABLE short_term_memory ADD COLUMN working_tokens BLOB;

-- long_term_memory: add working_tokens BLOB column (nullable, additive)
ALTER TABLE long_term_memory ADD COLUMN working_tokens BLOB;

-- Optional: an index to query rows that have snapshots
-- CREATE INDEX IF NOT EXISTS idx_short_term_working_tokens ON short_term_memory(working_tokens);
-- CREATE INDEX IF NOT EXISTS idx_long_term_working_tokens ON long_term_memory(working_tokens);

-- Postgres variant (reference only):
-- ALTER TABLE short_term_memory ADD COLUMN working_tokens BYTEA;
-- ALTER TABLE long_term_memory ADD COLUMN working_tokens BYTEA;
