-- 0034_known_installs.sql
-- Round 7-03 — Federation Auth (Identity & Pairing)
-- [Engineer-Principal · Opus · run-round7-03-federation-auth]
--
-- Hub-side install registry. Each row = one laptop paired with the hub.
-- Public key is used to Ed25519-verify every inbound request signed envelope.
-- `revoked_at IS NOT NULL` is the kill switch enforced by the auth middleware.
--
-- multi-tenant-migrations discipline (additive only):
--   - CREATE TABLE IF NOT EXISTS  (idempotent)
--   - Indexes in separate statements after the CREATE
--   - No DML
--   - No foreign keys
--
-- DSQL discipline:
--   - No triggers, sequences, or extensions
--   - DDL separated by --> statement-breakpoint per drizzle migrator convention
--   - All keys are application-generated UUIDv7 (no SERIAL)

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS known_installs (
  install_id    uuid        PRIMARY KEY,
  tenant_id     uuid        NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  public_key    text        NOT NULL,
  role          text        NOT NULL CHECK (role IN ('owner','member','viewer')),
  display_name  text,
  invite_jti    text        NOT NULL,
  joined_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz,
  revoked_at    timestamptz
);

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS known_installs_invite_jti_uniq
  ON known_installs (invite_jti);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS known_installs_tenant_idx
  ON known_installs (tenant_id, revoked_at);
