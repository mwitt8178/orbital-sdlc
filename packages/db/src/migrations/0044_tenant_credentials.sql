-- 0043_tenant_credentials.sql — Tenant-scoped encrypted credentials store.
--
-- [Engineer-Principal · Opus · run-keychain-aurora]
--
-- Replaces the per-Lambda /tmp/orbital-keychain.json shim with a durable,
-- shared, tenant-scoped table. Ciphertext only; the AES-256-GCM master key
-- lives in Secrets Manager (orbital-mwitt/keychain-master-key).
--
-- Aurora Serverless v2 — additive CREATE TABLE IF NOT EXISTS, no FKs, no
-- triggers, no sequences. Composite PK on (tenant_id, account) lets us upsert
-- with ON CONFLICT DO UPDATE.
--
-- Rollback: DROP TABLE tenant_credentials. No other readers.

CREATE TABLE IF NOT EXISTS tenant_credentials (
  tenant_id   UUID         NOT NULL,
  account     TEXT         NOT NULL,
  ciphertext  BYTEA        NOT NULL,
  iv          BYTEA        NOT NULL,
  auth_tag    BYTEA        NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, account)
);

CREATE INDEX IF NOT EXISTS tenant_credentials_tenant_idx
  ON tenant_credentials (tenant_id);
