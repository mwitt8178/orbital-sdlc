-- Migration 0029: code_reviews table
-- Round 6 #2 — Code-Review Persona + Agent-to-Agent Review Loop
-- [Engineer-Sr · Sonnet · run-round6-02-reviewer-persona]
--
-- Additive-only. Creates the code_reviews table which stores one row per
-- review submission by the reviewer persona. Multiple rows per PR are expected
-- (one per review iteration).
--
-- Also adds code_review_state column to tasks for fast backlog filter queries
-- without a join.

-- ============================================================
-- code_reviews table
-- ============================================================

CREATE TABLE IF NOT EXISTS code_reviews (
  review_id           UUID        PRIMARY KEY,
  pr_task_id          UUID        NOT NULL,
  reviewer_task_id    UUID        NOT NULL,
  pr_number           INTEGER     NOT NULL,
  reviewer_persona_id TEXT        NOT NULL,
  state               TEXT        NOT NULL CHECK (state IN ('APPROVED', 'CHANGES_REQUESTED', 'COMMENTED')),
  comments_count      INTEGER     NOT NULL DEFAULT 0,
  body                TEXT,
  posted_at           TIMESTAMPTZ,
  submitted_by_event_id UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS code_reviews_pr_task_idx
  ON code_reviews (pr_task_id);

CREATE INDEX IF NOT EXISTS code_reviews_pr_number_idx
  ON code_reviews (pr_number);

CREATE INDEX IF NOT EXISTS code_reviews_state_idx
  ON code_reviews (state);

CREATE INDEX IF NOT EXISTS code_reviews_reviewer_task_idx
  ON code_reviews (reviewer_task_id);

-- ============================================================
-- Denormalized code_review_state on tasks
-- (allows backlog filter queries without joining code_reviews)
-- ============================================================

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS code_review_state TEXT
    CHECK (code_review_state IN ('awaiting_review', 'changes_requested', 'approved'));
