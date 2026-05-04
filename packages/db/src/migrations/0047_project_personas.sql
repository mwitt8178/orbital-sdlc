-- 0047_project_personas.sql — project-scoped persona configuration.
--
-- [Engineer-Principal · Opus · run-settings-agents]
--
-- Stores per-project overrides for the persona roster: enabled flag, preferred
-- model, per-task budget cap, optional system-prompt override, and ordering
-- for the routing-claim queue. The baseline persona catalog continues to live
-- in code (packages/orchestrator/src/personas/library/); this table only
-- captures the deltas a project wants to apply on top.
--
-- Aurora Serverless v2 / DSQL — additive CREATE TABLE IF NOT EXISTS, no FKs,
-- no triggers, no sequences. Composite PK on (tenant_id, project_id,
-- persona_slug) lets us upsert with ON CONFLICT DO UPDATE.
--
-- Rollback: DROP TABLE project_personas. No downstream readers in this PR.

CREATE TABLE IF NOT EXISTS project_personas (
  tenant_id              UUID         NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  project_id             UUID         NOT NULL,
  persona_slug           TEXT         NOT NULL,
  enabled                BOOLEAN      NOT NULL DEFAULT TRUE,
  model                  TEXT         NOT NULL DEFAULT 'claude-sonnet-4-6',
  budget_usd_cents       INTEGER      NOT NULL DEFAULT 500,
  system_prompt_override TEXT,
  ordering               INTEGER      NOT NULL DEFAULT 0,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id, persona_slug)
);

CREATE INDEX IF NOT EXISTS project_personas_project_idx
  ON project_personas (project_id);

CREATE INDEX IF NOT EXISTS project_personas_tenant_project_idx
  ON project_personas (tenant_id, project_id);
