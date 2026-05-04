-- 0045_story_pr_runs.sql — Story → PR run aggregate.
--
-- [Engineer-Principal · Opus · run-story-pr-pipeline]
--
-- Tracks each "click Run on story" execution: clone → branch → agent →
-- commit → push → open PR. One row per run; a story may have many runs
-- across redirects.
--
-- Aurora Serverless v2 / DSQL-compatible:
--   - No FKs, no triggers, no sequences. UUIDv7 from app.
--   - Composite PK (tenant_id, id) for partition alignment.
--   - DDL only — DML separation principle.
--   - Idempotent on re-run (IF NOT EXISTS).
--
-- stories.pr_url is a denormalized convenience for fast UI reads; the
-- canonical record stays in story_pr_runs.

CREATE TABLE IF NOT EXISTS story_pr_runs (
  id            UUID         NOT NULL,
  tenant_id     UUID         NOT NULL,
  project_id    UUID,
  story_id      UUID         NOT NULL,
  branch        TEXT         NOT NULL,
  pr_url        TEXT,
  status        TEXT         NOT NULL DEFAULT 'queued',
  started_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ,
  commit_sha    TEXT,
  diff_stats    JSONB,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS story_pr_runs_story_idx
  ON story_pr_runs (tenant_id, story_id, started_at DESC);

CREATE INDEX IF NOT EXISTS story_pr_runs_status_idx
  ON story_pr_runs (status);

ALTER TABLE stories
  ADD COLUMN IF NOT EXISTS pr_url TEXT;
