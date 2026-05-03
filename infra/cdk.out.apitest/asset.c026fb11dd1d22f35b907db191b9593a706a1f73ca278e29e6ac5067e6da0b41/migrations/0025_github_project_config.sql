-- Migration 0025: GitHub PR loop — head_sha + pr_state columns on tasks.
--
-- Strategy: ADDITIVE ONLY per multi-tenant-migrations discipline.
--
-- Context:
--   Migration 0022 added github_pr_number / github_pr_url / github_pr_merged_at.
--   This migration adds:
--     tasks.github_head_sha   — the git SHA at PR open time; needed to re-run CI
--                               on the same commit when a verifier-driven retry
--                               occurs (Wave 3 #6 will consume this).
--     tasks.github_pr_state   — denormalized PR state ('open'|'merged'|'closed')
--                               so the UI can render badges without a live API call.
--
-- Projects table already has github_owner / github_repo / github_default_branch
-- (added in migration 0015). No columns to add there.
--
-- Per DSQL constraints: DDL in its own statement blocks, no mixing with DML.

--> statement-breakpoint
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS github_head_sha text;

--> statement-breakpoint
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS github_pr_state text
    CHECK (github_pr_state IN ('open', 'merged', 'closed'));
