-- 0050_story_test_artifacts.sql — AC-driven test generation artifacts.
--
-- [Engineer-Sr · Sonnet · run-ac-test-generation]
--
-- When a story moves to 'ready' the QA persona generates failing tests and
-- commits them to a branch before the engineer-sr agent starts. This table
-- tracks those generated test files and their review lifecycle.
--
-- ENUM-as-text pattern (matches project convention: no CREATE TYPE in DSQL).
-- status values: pending | approved | merged
--
-- Additive DDL only. No FKs, triggers, sequences, or extensions.
-- Rollback: DROP TABLE story_test_artifacts; DROP INDEX IF EXISTS ...

CREATE TABLE IF NOT EXISTS story_test_artifacts (
  id              UUID         NOT NULL DEFAULT gen_random_uuid(),
  tenant_id       UUID         NOT NULL,
  project_id      UUID         NOT NULL,
  story_id        UUID         NOT NULL,
  test_path       TEXT         NOT NULL,
  language        TEXT         NOT NULL,   -- 'typescript' | 'python' | 'go'
  framework       TEXT         NOT NULL,   -- 'vitest' | 'jest' | 'pytest' | 'go_test'
  branch          TEXT,                    -- 'orbital/tests-<storyId>'
  generated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  status          TEXT         NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'merged')),
  schema_version  INTEGER      NOT NULL DEFAULT 1,

  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS story_test_artifacts_tenant_idx
  ON story_test_artifacts (tenant_id);

CREATE INDEX IF NOT EXISTS story_test_artifacts_story_idx
  ON story_test_artifacts (story_id, tenant_id);

CREATE INDEX IF NOT EXISTS story_test_artifacts_status_idx
  ON story_test_artifacts (status, tenant_id);
