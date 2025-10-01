-- Migration 008: Add actionDir column to projects table

ALTER TABLE projects ADD COLUMN action_dir TEXT DEFAULT '.';
