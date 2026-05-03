-- Migration 0015: Multi-project support
-- Per Round 4 Projects Feature spec.
--
-- Strategy: ADDITIVE only.
--   1. CREATE TABLE projects (with indexes).
--   2. ADD COLUMN project_id (nullable uuid) to existing aggregate tables.
--   3. CREATE INDEX <table>_project_idx for high-cardinality scoping.
--
-- Backfill is performed at runtime by ensureDefaultProject() during boot
-- because the SQL migration has no access to install_id (which lives in
-- ~/.orbital/config/install.json). All ADD COLUMN statements use IF NOT
-- EXISTS so the migration is idempotent.
--
-- Note: NOT NULL on existing tables is deferred to a future migration once
-- all callers wire ctx.activeProjectId.

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS projects (
  project_id              uuid          PRIMARY KEY,
  install_id              uuid          NOT NULL,
  name                    text          NOT NULL,
  slug                    text          NOT NULL,
  description             text,
  monday_board_id         text,
  github_owner            text,
  github_repo             text,
  github_default_branch   text          NOT NULL DEFAULT 'main',
  archived_at             timestamptz,
  created_by_event_id     uuid,
  created_at              timestamptz   NOT NULL DEFAULT now(),
  updated_at              timestamptz   NOT NULL DEFAULT now(),
  schema_version          integer       NOT NULL DEFAULT 1
);

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS projects_install_slug_uq
  ON projects (install_id, slug);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS projects_install_idx
  ON projects (install_id);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS projects_archived_idx
  ON projects (archived_at);

-- ---------------------------------------------------------------------------
-- ADD COLUMN project_id (nullable) to existing aggregate tables.
-- ---------------------------------------------------------------------------

--> statement-breakpoint
ALTER TABLE epics
  ADD COLUMN IF NOT EXISTS project_id uuid;

--> statement-breakpoint
ALTER TABLE stories
  ADD COLUMN IF NOT EXISTS project_id uuid;

--> statement-breakpoint
ALTER TABLE sprints
  ADD COLUMN IF NOT EXISTS project_id uuid;

--> statement-breakpoint
ALTER TABLE vision_versions
  ADD COLUMN IF NOT EXISTS project_id uuid;

--> statement-breakpoint
ALTER TABLE vision_documents
  ADD COLUMN IF NOT EXISTS project_id uuid;

--> statement-breakpoint
ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS project_id uuid;

--> statement-breakpoint
ALTER TABLE ceremonies
  ADD COLUMN IF NOT EXISTS project_id uuid;

--> statement-breakpoint
ALTER TABLE retro_reports
  ADD COLUMN IF NOT EXISTS project_id uuid;

--> statement-breakpoint
ALTER TABLE uat_sessions
  ADD COLUMN IF NOT EXISTS project_id uuid;

--> statement-breakpoint
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS project_id uuid;

-- ---------------------------------------------------------------------------
-- Indexes on project_id for high-cardinality scoping.
-- ---------------------------------------------------------------------------

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS epics_project_idx
  ON epics (project_id);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS stories_project_idx
  ON stories (project_id);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sprints_project_idx
  ON sprints (project_id);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS vision_versions_project_idx
  ON vision_versions (project_id);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS vision_documents_project_idx
  ON vision_documents (project_id);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS channels_project_idx
  ON channels (project_id);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ceremonies_project_idx
  ON ceremonies (project_id);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS retro_reports_project_idx
  ON retro_reports (project_id);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS uat_sessions_project_idx
  ON uat_sessions (project_id);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS tasks_project_idx
  ON tasks (project_id);
