-- Migration 0047: Set project_id NOT NULL on aggregate tables.
--
-- Per fix/multi-project-isolation. Runs AFTER migration 0046 backfill and
-- AFTER the router sweep (Phase 2) is deployed and verified, so every writer
-- supplies project_id.
--
-- DEPLOY-GATE: Do NOT apply this migration until:
--   1. Migration 0046 has run and the migration-runner verification step
--      reports zero NULL project_id rows across all ten tables.
--   2. The router sweep PRs (one per bounded context) have been deployed and
--      the bleed-test integration suite passes against staging.
--   3. Hub-mode telemetry shows >= 24h of zero "project_id required" 5xx
--      from agent traffic.
--
-- DSQL guardrails:
--   - DDL only; separate from DML per hard-no rules.
--   - SET NOT NULL acquires a strong lock briefly; tables are small enough
--     that this completes within the 5-minute transaction window.
--   - Rollback: `ALTER TABLE <t> ALTER COLUMN project_id DROP NOT NULL`.
--
-- [Engineer-Principal · Opus · run-multi-project-isolation]

--> statement-breakpoint
ALTER TABLE epics
  ALTER COLUMN project_id SET NOT NULL;

--> statement-breakpoint
ALTER TABLE stories
  ALTER COLUMN project_id SET NOT NULL;

--> statement-breakpoint
ALTER TABLE sprints
  ALTER COLUMN project_id SET NOT NULL;

--> statement-breakpoint
ALTER TABLE vision_documents
  ALTER COLUMN project_id SET NOT NULL;

--> statement-breakpoint
ALTER TABLE vision_versions
  ALTER COLUMN project_id SET NOT NULL;

--> statement-breakpoint
ALTER TABLE channels
  ALTER COLUMN project_id SET NOT NULL;

--> statement-breakpoint
ALTER TABLE ceremonies
  ALTER COLUMN project_id SET NOT NULL;

--> statement-breakpoint
ALTER TABLE retro_reports
  ALTER COLUMN project_id SET NOT NULL;

--> statement-breakpoint
ALTER TABLE uat_sessions
  ALTER COLUMN project_id SET NOT NULL;

--> statement-breakpoint
ALTER TABLE tasks
  ALTER COLUMN project_id SET NOT NULL;
