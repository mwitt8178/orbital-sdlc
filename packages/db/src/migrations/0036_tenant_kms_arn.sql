-- 0036_tenant_kms_arn.sql
-- Round 8-07 — Secrets Manager + KMS
-- [Engineer-Principal · Opus · run-round8-07-secrets-kms]
--
-- Adds `kms_cmk_arn` column to the tenants table (or its current logical
-- equivalent — see note below). The orchestrator's onboarding flow writes
-- the per-tenant CMK ARN to this column once the KMS API call returns; the
-- replay store + sensitive-field encrypter read it on every encrypt/decrypt
-- to ensure the correct key is used for the request's tenant.
--
-- Multi-tenant-migrations discipline (additive, phase 1):
--   - ADD COLUMN IF NOT EXISTS — idempotent (safe to re-run).
--   - No backfill UPDATE — existing tenants get NULL; the onboarding flow
--     (or a one-shot back-fill job in 8-09 cutover) populates them.
--   - No FK constraints. Indexes added in a separate statement.
--   - No DML on the column. NULL is the documented "not yet provisioned" state.
--
-- DSQL discipline:
--   - DDL only; no triggers, sequences, or extensions.
--   - statement-breakpoint per drizzle migrator convention.
--
-- Tenants table location:
--   The current schema has `tenant_id` ON every shared table (see 0033) but
--   does NOT have a separate `tenants` table — tenant identity lives entirely
--   in the auth layer. We therefore store `kms_cmk_arn` on the
--   `known_installs` table where it is keyed by tenant_id (the column already
--   exists on that table). This is a deliberate design choice:
--     - Keeps the schema minimal (no new table just to hold an ARN)
--     - The onboarding flow writes once per tenant on first install
--     - Multiple installs for the same tenant share the same CMK (same ARN)
--   When a `tenants` table is added in a future round (e.g. for billing /
--   plan), this column will be migrated there and the column on
--   known_installs marked deprecated.

--> statement-breakpoint
ALTER TABLE known_installs
  ADD COLUMN IF NOT EXISTS kms_cmk_arn text;

--> statement-breakpoint
-- Partial index — only rows that have an ARN are interesting for
-- "find a tenant's CMK" lookups. NULLs are skipped.
CREATE INDEX IF NOT EXISTS known_installs_tenant_kms_idx
  ON known_installs (tenant_id, kms_cmk_arn)
  WHERE kms_cmk_arn IS NOT NULL;
