-- 0030_defect_iteration.sql
-- Round 6 #3 — Iterate-on-Defect Loop in UAT
-- [Engineer-Sr · Sonnet · run-round6-03-defect-iteration]
--
-- Additive migration: adds iteration_count and last_defect_id columns to tasks.
-- No triggers, no FKs, no sequences. OCC-safe additive columns with DEFAULT.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS iteration_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_defect_id  uuid;

-- Index for the "Iterating" backlog filter: tasks with state='ready' AND iteration_count > 0
CREATE INDEX IF NOT EXISTS tasks_iteration_idx ON tasks (state, iteration_count)
  WHERE iteration_count > 0;
