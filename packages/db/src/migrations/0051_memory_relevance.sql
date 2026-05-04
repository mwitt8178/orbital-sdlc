-- Migration 0051: Project memory — relevance_score, pinned, and persona_scope columns.
--
-- [Engineer-Sr · Sonnet · run-memory-prompt-assembly]
--
-- Additive-only DDL. No DROPs, no ALTER COLUMN type changes.
-- Per multi-tenant-migrations discipline: DDL only, no DML.
--
-- Adds:
--   project_memory_entries.relevance_score  float8 nullable
--     Pre-computed at retrieval time; stored for UI display.
--
--   project_memory_entries.pinned  boolean NOT NULL DEFAULT false
--     When true, entry is always included in the prompt regardless of
--     retrieval ranking (up to MAX_PINNED_ENTRIES=5).
--
--   project_memory_entries.persona_scope  text nullable
--     When non-NULL, entry is only injected for the named persona slug.
--     When NULL, entry is injected for all personas (default behaviour).
--
--   project_memory_entries.tenant_id index improvement
--     The multi-tenant scoping index now includes tenant_id.

--> statement-breakpoint
ALTER TABLE project_memory_entries
  ADD COLUMN IF NOT EXISTS relevance_score float8;

--> statement-breakpoint
ALTER TABLE project_memory_entries
  ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false;

--> statement-breakpoint
ALTER TABLE project_memory_entries
  ADD COLUMN IF NOT EXISTS persona_scope text;

--> statement-breakpoint
-- Index on pinned to fast-scan always-included entries per project.
CREATE INDEX IF NOT EXISTS pm_entries_pinned_idx
  ON project_memory_entries (project_id, pinned)
  WHERE pinned = true;

--> statement-breakpoint
-- Index on persona_scope to fast-filter persona-scoped entries.
CREATE INDEX IF NOT EXISTS pm_entries_persona_scope_idx
  ON project_memory_entries (project_id, persona_scope)
  WHERE persona_scope IS NOT NULL;

--> statement-breakpoint
-- Composite tenant+project index (improves multi-tenant scoping queries).
CREATE INDEX IF NOT EXISTS pm_entries_tenant_project_idx
  ON project_memory_entries (tenant_id, project_id, status);
