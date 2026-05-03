-- 0035_local_outbox.sql
-- Round 7-06 — Offline Cache + Reconciliation
-- [Engineer-Sr · Sonnet · run-round7-06-offline-reconcile]
--
-- Persistent local outbox for hub-bound mutations and events when the hub is
-- unreachable. Rows are flushed in seq order on reconnect with idempotency.
--
-- multi-tenant-migrations discipline (additive only):
--   - CREATE TABLE IF NOT EXISTS  (idempotent)
--   - Indexes in separate statements after the CREATE
--   - No DML
--   - No foreign keys
--   - bigserial for ordered flush (DSQL exception: bigserial is a local-only
--     table pattern; DSQL sequences are forbidden on shared/hub tables only;
--     this table never leaves the local Postgres instance)
--
-- DSQL discipline:
--   - No triggers, no extensions
--   - DDL separated by --> statement-breakpoint per drizzle migrator convention
--   - idempotency_key is application-generated UUID
--   - bigserial is acceptable here because local_outbox is local-only (never
--     replicated to hub or Aurora DSQL); seq ordering is required for flush order

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS local_outbox (
  seq             bigserial        PRIMARY KEY,
  kind            text             NOT NULL CHECK (kind IN ('event','mutation')),
  endpoint        text             NOT NULL,
  payload         jsonb            NOT NULL,
  idempotency_key uuid             NOT NULL,
  created_at      timestamptz      NOT NULL DEFAULT now(),
  attempts        integer          NOT NULL DEFAULT 0,
  last_error      text,
  flushed_at      timestamptz
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS lo_pending_idx
  ON local_outbox (created_at)
  WHERE flushed_at IS NULL;
