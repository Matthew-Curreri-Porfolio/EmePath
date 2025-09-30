-- Migration 004: Add token/cost columns to llm_requests

ALTER TABLE llm_requests ADD COLUMN prompt_tokens INTEGER;
ALTER TABLE llm_requests ADD COLUMN completion_tokens INTEGER;
ALTER TABLE llm_requests ADD COLUMN total_tokens INTEGER;
ALTER TABLE llm_requests ADD COLUMN cost_usd REAL;

