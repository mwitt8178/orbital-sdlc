-- 0049_pr_reviews.sql — PR review results table.
--
-- [Engineer-Sr · Sonnet · run-pr-review-agent-001]
--
-- Stores one row per automated PR review run by the Orbital review persona.
-- A verdict of BLOCK prevents the story from transitioning to Done until
-- the findings are resolved and a PASS verdict is recorded.
--
-- DSQL constraints:
--   - No foreign keys
--   - No triggers
--   - No sequences/SERIAL — UUIDs generated in application layer
--   - Additive-only: CREATE TABLE IF NOT EXISTS, ALTER TABLE ADD COLUMN IF NOT EXISTS
--
-- Rollback: DROP TABLE pr_reviews; ALTER TABLE stories DROP COLUMN review_status.

-- ============================================================
-- pr_reviews table
-- ============================================================

CREATE TABLE IF NOT EXISTS pr_reviews (
  id                  UUID         PRIMARY KEY,
  tenant_id           UUID         NOT NULL,
  project_id          UUID,
  story_id            UUID,
  pr_url              TEXT         NOT NULL,
  verdict             TEXT         NOT NULL CHECK (verdict IN ('PASS', 'BLOCK')),
  findings            JSONB        NOT NULL DEFAULT '[]',
  reviewer_persona    TEXT         NOT NULL DEFAULT 'review-agent',
  cost_usd            NUMERIC(10,6) NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pr_reviews_tenant_idx
  ON pr_reviews (tenant_id);

CREATE INDEX IF NOT EXISTS pr_reviews_story_idx
  ON pr_reviews (story_id);

CREATE INDEX IF NOT EXISTS pr_reviews_verdict_idx
  ON pr_reviews (verdict);

CREATE INDEX IF NOT EXISTS pr_reviews_tenant_story_idx
  ON pr_reviews (tenant_id, story_id);

-- ============================================================
-- review_status column on stories
-- Allows backlog filter queries without joining pr_reviews
-- ============================================================

ALTER TABLE stories
  ADD COLUMN IF NOT EXISTS review_status TEXT
    CHECK (review_status IN ('pending', 'pass', 'block'));
