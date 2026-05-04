-- 0047_vision_decomposition_runs.sql
-- Lighter status-tracking table for the vision → backlog decomposition flow.
-- [Engineer-Sr · Sonnet · run-vision-decompose]
--
-- Design notes:
--   - Separate from planning_runs (0040) which records full LLM audit trail
--     (tokens, cost, raw response). This table tracks the user-facing lifecycle:
--     pending → approved | discarded, with project_id for cross-project scoping.
--   - tenant_id + project_id present for multi-tenant isolation.
--   - No FK constraints (DSQL discipline — no cross-context coupling).
--   - No triggers, sequences, or extensions.
--   - DDL only; no DML.
--   - IDs: UUID (written by app as ULIDs / uuidv7).
--   - All nullable columns represent values only known after the run completes.
--
-- Multi-tenant-migrations discipline (additive, phase 1):
--   - CREATE TABLE / INDEX IF NOT EXISTS — idempotent.
--   - tenant_id sentinel default for single-install deployments.

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS vision_decomposition_runs (
  id            UUID        PRIMARY KEY,
  tenant_id     UUID        NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  project_id    UUID,
  vision_id     UUID        NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'pending',
  epic_count    INTEGER,
  story_count   INTEGER,
  started_at    TIMESTAMPTZ NOT NULL,
  finished_at   TIMESTAMPTZ,
  error         TEXT
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS vdr_tenant_vision_idx
  ON vision_decomposition_runs (tenant_id, vision_id, started_at DESC);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS vdr_tenant_project_idx
  ON vision_decomposition_runs (tenant_id, project_id, started_at DESC);
