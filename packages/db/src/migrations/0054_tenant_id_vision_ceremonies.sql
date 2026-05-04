-- Migration 0044: Add tenant_id to vision_documents, vision_versions, ceremonies.
--
-- Per fix/multi-project-isolation. The audit found these three tables were
-- never given tenant_id by migration 0033 (hub_tenant_scope), so they fall
-- outside the tenant boundary entirely. This is a CRITICAL gap — a hub-mode
-- deployment cannot enforce tenant scoping on vision or ceremony reads.
--
-- Strategy: ADDITIVE only.
--   1. ADD COLUMN tenant_id (uuid, not null, default = local-install sentinel).
--   2. Create index for high-cardinality scoping.
--
-- Default '00000000-0000-0000-0000-000000000000' is the local-install sentinel
-- consistent with migration 0033's pattern. Existing rows are scoped to that
-- sentinel until a follow-up backfill (0045) and NOT NULL DEFAULT removal
-- (deferred) reassigns them to per-tenant ownership.
--
-- DSQL guardrails:
--   - DDL only; separate transaction from any DML.
--   - IF NOT EXISTS keeps the migration idempotent.
--   - No FKs introduced.
--
-- [Engineer-Principal · Opus · run-multi-project-isolation]

--> statement-breakpoint
ALTER TABLE vision_documents
  ADD COLUMN IF NOT EXISTS tenant_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';

--> statement-breakpoint
ALTER TABLE vision_versions
  ADD COLUMN IF NOT EXISTS tenant_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';

--> statement-breakpoint
ALTER TABLE ceremonies
  ADD COLUMN IF NOT EXISTS tenant_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS vision_documents_tenant_idx
  ON vision_documents (tenant_id);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS vision_versions_tenant_idx
  ON vision_versions (tenant_id);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ceremonies_tenant_idx
  ON ceremonies (tenant_id);

-- ---------------------------------------------------------------------------
-- project_id columns for vision_documents, vision_versions, ceremonies were
-- already added by migration 0015. This migration only fills the tenant_id
-- gap.
-- ---------------------------------------------------------------------------
