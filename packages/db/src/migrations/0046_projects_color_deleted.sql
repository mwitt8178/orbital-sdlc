-- 0045_projects_color_deleted.sql — /settings/general general-tab columns.
--
-- [Engineer-Principal · Opus · run-settings-general]
--
-- Additive only. Adds:
--   - color           : text  — display theme color for the project (oklch or hex; 32 chars max enforced in app)
--   - deleted_at      : timestamptz — hard-delete tombstone (distinct from archived_at soft delete)
--   - deleted_by_event_id : uuid — logical FK into audit.events for delete provenance
--
-- Aurora Serverless v2 + DSQL compatible: no FK, no triggers, no constraint flips.
--
-- Rollback:
--   ALTER TABLE projects
--     DROP COLUMN color,
--     DROP COLUMN deleted_at,
--     DROP COLUMN deleted_by_event_id;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS color TEXT,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by_event_id UUID;

-- Partial index for active-project lookups that should exclude deleted rows.
-- The existing projects_archived_idx covers archived_at; this complements it.
CREATE INDEX IF NOT EXISTS projects_deleted_idx ON projects (deleted_at);
