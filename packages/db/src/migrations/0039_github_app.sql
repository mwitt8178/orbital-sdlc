-- 0039_github_app.sql
-- GitHub App integration — installations, repo bindings, webhook delivery dedupe.
-- [Engineer-Principal · Opus · run-orbital-github-integration]
--
-- Multi-tenant-migrations discipline (additive, idempotent):
--   - CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS — safe to re-run.
--   - All columns have defaults so no data migration on insert.
--   - tenant_id present on every row (sentinel default for local install).
--
-- DSQL discipline:
--   - No FOREIGN KEY (constraint banned).
--   - No SERIAL — IDs come from the App (installation_id, repo_id) or are
--     generated UUIDv7 in app code (binding_id).
--   - No TRIGGER, no SEQUENCE, no MATERIALIZED VIEW.
--   - clock_timestamp() for wall-clock defaults (CURRENT_TIMESTAMP returns
--     transaction-start time on DSQL).
--   - Pure DDL; no DML in this file.

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS github_installations (
  installation_id BIGINT PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  github_account_login TEXT NOT NULL,
  github_account_type TEXT NOT NULL,
  github_account_id BIGINT NOT NULL,
  permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
  events JSONB NOT NULL DEFAULT '[]'::jsonb,
  installed_by_user_id UUID,
  installed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  suspended_at TIMESTAMPTZ,
  uninstalled_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS github_installations_tenant_idx
  ON github_installations(tenant_id);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS github_repo_bindings (
  binding_id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  project_id UUID NOT NULL,
  installation_id BIGINT NOT NULL,
  github_repo_id BIGINT NOT NULL,
  full_name TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  removed_at TIMESTAMPTZ
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS github_repo_bindings_project_idx
  ON github_repo_bindings(project_id);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS github_repo_bindings_tenant_idx
  ON github_repo_bindings(tenant_id);

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS github_repo_bindings_unique_active
  ON github_repo_bindings(project_id, github_repo_id)
  WHERE removed_at IS NULL;

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS github_webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  installation_id BIGINT,
  event_type TEXT NOT NULL,
  action TEXT,
  payload_sha256 TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  processed_at TIMESTAMPTZ,
  result TEXT
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS github_webhook_deliveries_received_idx
  ON github_webhook_deliveries(received_at);
