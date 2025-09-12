-- Migration 002: Forecast tables

CREATE TABLE IF NOT EXISTS forecasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL,
  question TEXT NOT NULL,
  resolution_criteria TEXT NOT NULL,
  horizon_ts DATETIME NOT NULL,
  probability REAL NOT NULL,
  rationale TEXT,
  methodology_tags TEXT, -- JSON array of strings
  sources TEXT,          -- JSON array
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  status TEXT DEFAULT 'open', -- open | resolved | invalid
  resolved_at DATETIME,
  outcome TEXT,          -- yes | no | unknown | value
  judge TEXT,            -- JSON of judgment details
  brier_score REAL,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_forecasts_status_horizon ON forecasts(status, horizon_ts);

