-- 0042_projects_scm_columns.sql — Add SCM/ticket provider columns to projects.
--
-- [Engineer-Principal · Opus · run-scm-codecommit]
--
-- Additive, idempotent. Default `scm_provider='internal'` and
-- `ticket_provider='internal'` so existing rows continue to work without
-- relying on GitHub/Monday integrations once those become optional.
--
-- Aurora Serverless v2 — additive ALTER, no FK changes, no constraint flips.
-- Rollback: DROP the four columns (no data loss for legacy projects, which
-- still carry github_owner/github_repo and monday_board_id columns from
-- earlier migrations).

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS scm_provider TEXT NOT NULL DEFAULT 'internal',
  ADD COLUMN IF NOT EXISTS ticket_provider TEXT NOT NULL DEFAULT 'internal',
  ADD COLUMN IF NOT EXISTS repo_id TEXT,
  ADD COLUMN IF NOT EXISTS repo_url TEXT,
  ADD COLUMN IF NOT EXISTS repo_clone_url TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'projects_scm_provider_chk'
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_scm_provider_chk
      CHECK (scm_provider IN ('internal','codecommit','github'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'projects_ticket_provider_chk'
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_ticket_provider_chk
      CHECK (ticket_provider IN ('internal','monday'));
  END IF;
END $$;
