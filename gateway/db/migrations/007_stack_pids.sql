-- Migration 007: Create stack_pids table for storing process IDs

CREATE TABLE IF NOT EXISTS stack_pids (
  name TEXT PRIMARY KEY,
  pid INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
