-- 0045_project_sprint_policy.sql — Per-project sprint policy.
--
-- [Engineer-Principal · Opus · run-settings-sprints]
--
-- Stores cadence, capacity, budget, and ceremony rules per project.
-- DSQL-safe: additive only, no FKs, no triggers, no sequences.
-- Single row per project; project_id is the PK so upserts are trivial.

CREATE TABLE IF NOT EXISTS project_sprint_policy (
  project_id                  uuid          PRIMARY KEY,
  tenant_id                   uuid          NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  length_weeks                integer       NOT NULL DEFAULT 2  CHECK (length_weeks IN (1,2,3,4)),
  start_dow                   integer       NOT NULL DEFAULT 1  CHECK (start_dow BETWEEN 0 AND 6),
  auto_advance                boolean       NOT NULL DEFAULT false,
  points_per_sprint           integer       NOT NULL DEFAULT 20 CHECK (points_per_sprint BETWEEN 0 AND 1000),
  budget_usd_cents_per_sprint bigint        NOT NULL DEFAULT 0  CHECK (budget_usd_cents_per_sprint >= 0),
  budget_usd_cents_per_week   bigint        NOT NULL DEFAULT 0  CHECK (budget_usd_cents_per_week  >= 0),
  ceremony_rules              jsonb         NOT NULL DEFAULT '{}'::jsonb,
  created_at                  timestamptz   NOT NULL DEFAULT now(),
  updated_at                  timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS psp_tenant_idx ON project_sprint_policy (tenant_id);
