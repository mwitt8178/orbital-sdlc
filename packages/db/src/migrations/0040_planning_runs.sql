-- 0040_planning_runs.sql
-- Vision → LLM decomposition audit trail.
-- [Engineer-Principal · Opus · run-vision-llm-decompose]
--
-- Records every LLM-backed planning run (regenerate + commit) so operators
-- can audit model output, token spend, and which proposal landed in the
-- backlog vs. which were discarded.
--
-- Multi-tenant-migrations discipline (additive, phase 1):
--   - CREATE TABLE / INDEX IF NOT EXISTS — idempotent.
--   - tenant_id present with sentinel default (single-install deployments).
--   - No FK constraints; cross-aggregate references (vision_id) are loose
--     uuid columns per TRD-01 §4.5 — no cross-context coupling.
--   - No triggers, sequences, or extensions.
--
-- DSQL discipline:
--   - DDL only; no DML.
--   - clock_timestamp() not needed — timestamps are written by app code.
--   - Columns nullable where the value is only known after the run completes.

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS planning_runs (
  run_id          UUID        PRIMARY KEY,
  tenant_id       UUID        NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  vision_id       UUID        NOT NULL,
  vision_version  INT         NOT NULL,
  started_at      TIMESTAMPTZ NOT NULL,
  ended_at        TIMESTAMPTZ,
  input_tokens    INT,
  output_tokens   INT,
  usd_cents       INT,
  exit_status     TEXT        NOT NULL DEFAULT 'pending',
  committed_at    TIMESTAMPTZ,
  raw_response    JSONB
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS planning_runs_tenant_vision_idx
  ON planning_runs (tenant_id, vision_id, started_at DESC);
