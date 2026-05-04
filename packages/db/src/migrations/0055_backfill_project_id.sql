-- Migration 0046: Backfill project_id on aggregate tables.
--
-- Per fix/multi-project-isolation. Migration 0015 added nullable project_id to
-- ten aggregate tables but never backfilled existing rows. Without backfill,
-- a future NOT NULL migration (0047) would fail, and routers that filter on
-- project_id would silently drop rows for tenants that pre-date the projects
-- feature.
--
-- Strategy:
--   For each aggregate row with NULL project_id, set project_id to the oldest
--   project owned by the same tenant. Tenants that did not yet own a project
--   are skipped — runtime ensureDefaultProject() creates a default on first
--   boot, after which a re-run of this migration completes the backfill.
--
-- DSQL guardrails:
--   - DML only; no DDL in this transaction.
--   - Idempotent — `WHERE project_id IS NULL` makes re-runs safe.
--   - Per-tenant correlated subquery keeps each row's update self-contained;
--     if a tenant has >10k aggregate rows, replay this migration in chunks via
--     migration-runner's batch mode.
--   - No transactions exceeding 5 minutes (the migration runner wraps each
--     statement in its own transaction with OCC retry).
--
-- [Engineer-Principal · Opus · run-multi-project-isolation]

--> statement-breakpoint
UPDATE epics
SET project_id = (
  SELECT project_id FROM projects
  WHERE projects.tenant_id = epics.tenant_id
  ORDER BY created_at ASC
  LIMIT 1
)
WHERE project_id IS NULL;

--> statement-breakpoint
UPDATE stories
SET project_id = (
  SELECT project_id FROM projects
  WHERE projects.tenant_id = stories.tenant_id
  ORDER BY created_at ASC
  LIMIT 1
)
WHERE project_id IS NULL;

--> statement-breakpoint
UPDATE sprints
SET project_id = (
  SELECT project_id FROM projects
  WHERE projects.tenant_id = sprints.tenant_id
  ORDER BY created_at ASC
  LIMIT 1
)
WHERE project_id IS NULL;

--> statement-breakpoint
-- vision_documents acquired tenant_id in the same migration that runs this
-- backfill; tenant_id default = local-install sentinel for back-compat.
UPDATE vision_documents
SET project_id = (
  SELECT project_id FROM projects
  WHERE projects.tenant_id = vision_documents.tenant_id
  ORDER BY created_at ASC
  LIMIT 1
)
WHERE project_id IS NULL;

--> statement-breakpoint
UPDATE vision_versions
SET project_id = (
  SELECT project_id FROM projects
  WHERE projects.tenant_id = vision_versions.tenant_id
  ORDER BY created_at ASC
  LIMIT 1
)
WHERE project_id IS NULL;

--> statement-breakpoint
UPDATE channels
SET project_id = (
  SELECT project_id FROM projects
  WHERE projects.tenant_id = channels.tenant_id
  ORDER BY created_at ASC
  LIMIT 1
)
WHERE project_id IS NULL;

--> statement-breakpoint
UPDATE ceremonies
SET project_id = (
  SELECT project_id FROM projects
  WHERE projects.tenant_id = ceremonies.tenant_id
  ORDER BY created_at ASC
  LIMIT 1
)
WHERE project_id IS NULL;

--> statement-breakpoint
UPDATE retro_reports
SET project_id = (
  SELECT project_id FROM projects
  WHERE projects.tenant_id = retro_reports.tenant_id
  ORDER BY created_at ASC
  LIMIT 1
)
WHERE project_id IS NULL;

--> statement-breakpoint
UPDATE uat_sessions
SET project_id = (
  SELECT project_id FROM projects
  WHERE projects.tenant_id = uat_sessions.tenant_id
  ORDER BY created_at ASC
  LIMIT 1
)
WHERE project_id IS NULL;

--> statement-breakpoint
UPDATE tasks
SET project_id = (
  SELECT project_id FROM projects
  WHERE projects.tenant_id = tasks.tenant_id
  ORDER BY created_at ASC
  LIMIT 1
)
WHERE project_id IS NULL;
