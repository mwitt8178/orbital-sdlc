-- 0033_hub_tenant_scope.sql
-- Round 7-01 — Extract Orchestrator Core Into Deployable Hub Service
-- [Engineer-Sr · Sonnet · run-round7-01-extract-hub]
--
-- Adds tenant_id (uuid NOT NULL DEFAULT local-sentinel) to every shared table
-- so the same schema can serve both single-install (local mode) and multi-tenant
-- hub deployments without a fork.
--
-- Default sentinel: '00000000-0000-0000-0000-000000000000'
-- All existing rows are backfilled to this sentinel. In hub mode the column is
-- populated from the X-Orbital-Tenant-ID request header. In local mode it stays
-- at the sentinel for the lifetime of the install.
--
-- Tables scoped (knowledge-bound shared data):
--   tasks, sprints, sprint_commitments, epics, stories, story_acceptance_criteria
--   channels, channel_posts, channel_subscriptions
--   project_memory_entries, project_memory_tags, project_memory_links
--   defects, uat_sessions, code_reviews
--   retro_reports, retro_proposals
--   projects
--
-- Tables NOT scoped (system-wide / install-local data):
--   events (event_store internal — install-level audit log)
--   capabilities / capability_grants (install-level key management)
--   monday_sync_state (external integration state, install-level)
--   agent_workers, worker_heartbeats (local spawn; never on hub)
--   worktrees (local filesystem artefacts)
--   routing_decisions, routing_policy_versions (install-level)
--   cost_ledger, cost_budgets (operator-local spend; NEVER on hub)
--   replay_captures (local blobs; metadata only goes to hub in 7-02)
--
-- Multi-tenant-migrations discipline (additive, phase 1):
--   - ADD COLUMN IF NOT EXISTS with a non-null default (sentinel).
--   - Separate DDL from DML.
--   - No FK constraints added.
--   - Indexes added after backfill (separate statements).
--
-- DSQL discipline:
--   - DDL and DML in separate statements.
--   - No triggers, no sequences, no stored procs.

-- ============================================================
-- PHASE 1: ADD COLUMNS (DDL only)
-- ============================================================

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS tenant_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';

ALTER TABLE sprints
  ADD COLUMN IF NOT EXISTS tenant_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';

ALTER TABLE sprint_commitments
  ADD COLUMN IF NOT EXISTS tenant_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';

ALTER TABLE epics
  ADD COLUMN IF NOT EXISTS tenant_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';

ALTER TABLE stories
  ADD COLUMN IF NOT EXISTS tenant_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';

ALTER TABLE story_acceptance_criteria
  ADD COLUMN IF NOT EXISTS tenant_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';

ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS tenant_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';

ALTER TABLE channel_posts
  ADD COLUMN IF NOT EXISTS tenant_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';

ALTER TABLE channel_subscriptions
  ADD COLUMN IF NOT EXISTS tenant_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';

ALTER TABLE project_memory_entries
  ADD COLUMN IF NOT EXISTS tenant_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';

ALTER TABLE project_memory_tags
  ADD COLUMN IF NOT EXISTS tenant_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';

ALTER TABLE project_memory_links
  ADD COLUMN IF NOT EXISTS tenant_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';

ALTER TABLE defects
  ADD COLUMN IF NOT EXISTS tenant_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';

ALTER TABLE uat_sessions
  ADD COLUMN IF NOT EXISTS tenant_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';

ALTER TABLE code_reviews
  ADD COLUMN IF NOT EXISTS tenant_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';

ALTER TABLE retro_reports
  ADD COLUMN IF NOT EXISTS tenant_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';

ALTER TABLE retro_proposals
  ADD COLUMN IF NOT EXISTS tenant_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS tenant_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';

-- ============================================================
-- PHASE 2: BACKFILL EXISTING ROWS (DML — separate statements)
-- Existing rows already have the default sentinel from ADD COLUMN.
-- These UPDATE statements are idempotent no-ops if rows were already
-- created after this migration ran (they already have the sentinel).
-- ============================================================

UPDATE tasks
  SET tenant_id = '00000000-0000-0000-0000-000000000000'
  WHERE tenant_id = '00000000-0000-0000-0000-000000000000';

UPDATE sprints
  SET tenant_id = '00000000-0000-0000-0000-000000000000'
  WHERE tenant_id = '00000000-0000-0000-0000-000000000000';

UPDATE sprint_commitments
  SET tenant_id = '00000000-0000-0000-0000-000000000000'
  WHERE tenant_id = '00000000-0000-0000-0000-000000000000';

UPDATE epics
  SET tenant_id = '00000000-0000-0000-0000-000000000000'
  WHERE tenant_id = '00000000-0000-0000-0000-000000000000';

UPDATE stories
  SET tenant_id = '00000000-0000-0000-0000-000000000000'
  WHERE tenant_id = '00000000-0000-0000-0000-000000000000';

UPDATE story_acceptance_criteria
  SET tenant_id = '00000000-0000-0000-0000-000000000000'
  WHERE tenant_id = '00000000-0000-0000-0000-000000000000';

UPDATE channels
  SET tenant_id = '00000000-0000-0000-0000-000000000000'
  WHERE tenant_id = '00000000-0000-0000-0000-000000000000';

UPDATE channel_posts
  SET tenant_id = '00000000-0000-0000-0000-000000000000'
  WHERE tenant_id = '00000000-0000-0000-0000-000000000000';

UPDATE channel_subscriptions
  SET tenant_id = '00000000-0000-0000-0000-000000000000'
  WHERE tenant_id = '00000000-0000-0000-0000-000000000000';

UPDATE project_memory_entries
  SET tenant_id = '00000000-0000-0000-0000-000000000000'
  WHERE tenant_id = '00000000-0000-0000-0000-000000000000';

UPDATE project_memory_tags
  SET tenant_id = '00000000-0000-0000-0000-000000000000'
  WHERE tenant_id = '00000000-0000-0000-0000-000000000000';

UPDATE project_memory_links
  SET tenant_id = '00000000-0000-0000-0000-000000000000'
  WHERE tenant_id = '00000000-0000-0000-0000-000000000000';

UPDATE defects
  SET tenant_id = '00000000-0000-0000-0000-000000000000'
  WHERE tenant_id = '00000000-0000-0000-0000-000000000000';

UPDATE uat_sessions
  SET tenant_id = '00000000-0000-0000-0000-000000000000'
  WHERE tenant_id = '00000000-0000-0000-0000-000000000000';

UPDATE code_reviews
  SET tenant_id = '00000000-0000-0000-0000-000000000000'
  WHERE tenant_id = '00000000-0000-0000-0000-000000000000';

UPDATE retro_reports
  SET tenant_id = '00000000-0000-0000-0000-000000000000'
  WHERE tenant_id = '00000000-0000-0000-0000-000000000000';

UPDATE retro_proposals
  SET tenant_id = '00000000-0000-0000-0000-000000000000'
  WHERE tenant_id = '00000000-0000-0000-0000-000000000000';

UPDATE projects
  SET tenant_id = '00000000-0000-0000-0000-000000000000'
  WHERE tenant_id = '00000000-0000-0000-0000-000000000000';

-- ============================================================
-- PHASE 3: INDEXES (DDL — separate statements after backfill)
-- Composite (tenant_id, ...) indexes for efficient per-tenant queries.
-- ============================================================

CREATE INDEX IF NOT EXISTS tasks_tenant_state_idx
  ON tasks (tenant_id, state);

CREATE INDEX IF NOT EXISTS sprints_tenant_status_idx
  ON sprints (tenant_id, status);

CREATE INDEX IF NOT EXISTS sprint_commitments_tenant_idx
  ON sprint_commitments (tenant_id);

CREATE INDEX IF NOT EXISTS epics_tenant_idx
  ON epics (tenant_id, status);

CREATE INDEX IF NOT EXISTS stories_tenant_status_idx
  ON stories (tenant_id, status);

CREATE INDEX IF NOT EXISTS story_ac_tenant_idx
  ON story_acceptance_criteria (tenant_id);

CREATE INDEX IF NOT EXISTS channels_tenant_idx
  ON channels (tenant_id);

CREATE INDEX IF NOT EXISTS channel_posts_tenant_channel_idx
  ON channel_posts (tenant_id, channel_id, created_at);

CREATE INDEX IF NOT EXISTS channel_subscriptions_tenant_idx
  ON channel_subscriptions (tenant_id);

CREATE INDEX IF NOT EXISTS pm_entries_tenant_project_idx
  ON project_memory_entries (tenant_id, project_id, status);

CREATE INDEX IF NOT EXISTS pm_tags_tenant_idx
  ON project_memory_tags (tenant_id);

CREATE INDEX IF NOT EXISTS pm_links_tenant_idx
  ON project_memory_links (tenant_id);

CREATE INDEX IF NOT EXISTS defects_tenant_idx
  ON defects (tenant_id, state);

CREATE INDEX IF NOT EXISTS uat_sessions_tenant_idx
  ON uat_sessions (tenant_id);

CREATE INDEX IF NOT EXISTS code_reviews_tenant_idx
  ON code_reviews (tenant_id);

CREATE INDEX IF NOT EXISTS retro_reports_tenant_idx
  ON retro_reports (tenant_id);

CREATE INDEX IF NOT EXISTS retro_proposals_tenant_idx
  ON retro_proposals (tenant_id);

CREATE INDEX IF NOT EXISTS projects_tenant_idx
  ON projects (tenant_id);
