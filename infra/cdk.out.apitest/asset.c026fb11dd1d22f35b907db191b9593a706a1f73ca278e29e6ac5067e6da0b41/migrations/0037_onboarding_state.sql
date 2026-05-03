-- 0037_onboarding_state.sql
-- Round 9 — Onboarding UX Overhaul
-- [Engineer-Principal · Opus · run-round9-onboarding-overhaul]
--
-- Adds the `onboarding_sessions` table that powers the resumable wizard.
-- Refresh mid-flow returns to the same step because state lives on the server,
-- not in browser local storage.
--
-- Multi-tenant-migrations discipline (additive, phase 1):
--   - CREATE TABLE IF NOT EXISTS — idempotent (safe to re-run on every boot).
--   - No backfill UPDATE — first session is created by the wizard.
--   - No FK constraints; cross-aggregate references (project_id) are
--     nullable text/uuid columns per TRD-01 §4.5.
--   - No triggers, sequences, or extensions.
--
-- DSQL discipline:
--   - DDL only; no DML.
--   - statement-breakpoint per drizzle migrator convention.
--   - Composite index on (install_id, status) for the "active sessions for
--     this install" lookup the wizard does on every status query.

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS onboarding_sessions (
  session_id     uuid        PRIMARY KEY,
  tenant_id      uuid        NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  install_id     uuid        NOT NULL,
  flow           text        NOT NULL CHECK (flow IN ('new_project','existing_repo','join_hub','sample_data')),
  current_step   text        NOT NULL,
  status         text        NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','abandoned')),
  -- Free-form JSON state per flow. Each flow's reducer owns its own shape.
  -- Deliberately jsonb so the wizard can evolve without a schema migration.
  state_json     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- Project this session is creating / importing. Null until project row is
  -- written. Populated as soon as the new-project flow has a slug + name.
  project_id     uuid,
  -- Per-step time-on-task (ms) for telemetry on the OnboardingCompleted event.
  step_durations jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- Step the session is currently on, captured at last update.
  step_started_at timestamptz,
  started_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz,
  abandoned_at   timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  schema_version integer     NOT NULL DEFAULT 1
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS onboarding_sessions_install_status_idx
  ON onboarding_sessions (install_id, status);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS onboarding_sessions_tenant_idx
  ON onboarding_sessions (tenant_id, status);

--> statement-breakpoint
-- Active session lookup is "find the latest active session for this install
-- on this flow" — a partial index keeps it fast without scanning completed rows.
CREATE INDEX IF NOT EXISTS onboarding_sessions_active_idx
  ON onboarding_sessions (install_id, flow, started_at DESC)
  WHERE status = 'active';
