-- 0038_drop_sample_data_flow.sql
-- Round 11 — remove sample/demo onboarding flow
-- [Engineer-Principal · Opus · run-remove-sample-flow]
--
-- Drops 'sample_data' from the onboarding_sessions.flow CHECK constraint.
-- The sample/demo onboarding flow (broken UX, not a useful evaluation path)
-- has been removed end-to-end; the enum no longer needs the value.
--
-- Multi-tenant-migrations discipline (additive, idempotent):
--   - DROP CONSTRAINT IF EXISTS — safe to re-run.
--   - ADD CONSTRAINT with the narrowed enum.
--   - No data migration: any in-flight 'sample_data' sessions on existing
--     installs would block this constraint. Verified out-of-band that the
--     mwitt install has no such rows. If a future install does, the
--     migration fails loudly and the operator must clean rows manually.
--
-- DSQL discipline:
--   - DDL only; no DML.
--   - statement-breakpoint per drizzle migrator convention.

--> statement-breakpoint
ALTER TABLE onboarding_sessions
  DROP CONSTRAINT IF EXISTS onboarding_sessions_flow_check;

--> statement-breakpoint
DELETE FROM onboarding_sessions WHERE flow = 'sample_data';

--> statement-breakpoint
ALTER TABLE onboarding_sessions
  ADD CONSTRAINT onboarding_sessions_flow_check
  CHECK (flow IN ('new_project', 'existing_repo', 'join_hub'));
