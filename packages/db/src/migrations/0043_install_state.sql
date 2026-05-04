-- 0043_install_state.sql
-- Move onboarding overlay (mode / setup_completed_at / demo_replay_id) from
-- ~/.orbital/config/onboarding.json (which is /tmp/.orbital/... in Lambda — per
-- instance ephemeral) into Aurora, so SetupGate sees a consistent view across
-- Lambda instances.
--
-- [Engineer-Principal · Opus · run-install-state-aurora]
--
-- Multi-tenant-migrations discipline (additive, phase 1):
--   - CREATE TABLE IF NOT EXISTS — idempotent
--   - No backfill UPDATE — first row written by app on first read of an
--     install_id with no row (ON CONFLICT DO UPDATE in mutators).
--   - No FK constraints
--   - No triggers, sequences, or extensions
--
-- DSQL discipline:
--   - DDL only; no DML.
--   - statement-breakpoint per drizzle migrator convention.

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS install_state (
  install_id         uuid         PRIMARY KEY,
  tenant_id          uuid         NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  schema_version     integer      NOT NULL DEFAULT 1,
  mode               text         CHECK (mode IS NULL OR mode IN ('demo','live','readonly')),
  setup_completed_at timestamptz,
  demo_replay_id     text,
  created_at         timestamptz  NOT NULL DEFAULT now(),
  updated_at         timestamptz  NOT NULL DEFAULT now()
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS install_state_tenant_idx ON install_state (tenant_id);
