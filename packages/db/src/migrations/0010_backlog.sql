-- Migration: 0010_backlog
-- Phase 4B — Backlog + Sprint + Monday Sync.
-- Per TRD-02 v0.2 §4.
--
-- Tables:
--   epics
--   stories
--   story_acceptance_criteria
--   sprints
--   sprint_commitments
--   monday_sync_state
--
-- Notes:
--   - Idempotent (CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS).
--   - Within-context FKs are real (epics ← stories; stories ← ACs).
--   - Cross-context references (vision_versions, defects, tasks) are nullable
--     uuid columns without physical FKs, consistent with TRD-04 §4.1
--     reconciliation note pattern.
--   - No triggers; state-machine enforcement is at the application layer.

-- ============================================================================
-- epics
-- ============================================================================

CREATE TABLE IF NOT EXISTS epics (
  epic_id              uuid        PRIMARY KEY,
  vision_version_id    uuid        NOT NULL,
  title                text        NOT NULL,
  rationale            text        NOT NULL,
  priority             integer     NOT NULL,
  monday_group_id      text,
  status               text        NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft','active','completed','archived')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  schema_version       integer     NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS epics_vision_idx   ON epics (vision_version_id);
CREATE INDEX IF NOT EXISTS epics_priority_idx ON epics (priority);

-- ============================================================================
-- stories
-- ============================================================================

CREATE TABLE IF NOT EXISTS stories (
  story_id            uuid        PRIMARY KEY,
  epic_id             uuid        NOT NULL REFERENCES epics(epic_id),
  title               text        NOT NULL,
  description         text        NOT NULL,
  status              text        NOT NULL DEFAULT 'backlog'
                      CHECK (status IN (
                        'backlog','ready','in_progress','in_review',
                        'done','accepted','blocked','defective'
                      )),
  story_points        integer,
  priority            integer     NOT NULL,
  persona_of_record   text,
  monday_item_id      text,
  origin_story_id     uuid,
  defect_id           uuid,
  linked_artifacts    jsonb       NOT NULL DEFAULT '[]'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  schema_version      integer     NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS stories_epic_idx   ON stories (epic_id);
CREATE INDEX IF NOT EXISTS stories_status_idx ON stories (status);
CREATE INDEX IF NOT EXISTS stories_origin_idx ON stories (origin_story_id);

-- ============================================================================
-- story_acceptance_criteria
-- ============================================================================

CREATE TABLE IF NOT EXISTS story_acceptance_criteria (
  ac_id              uuid        PRIMARY KEY,
  story_id           uuid        NOT NULL REFERENCES stories(story_id) ON DELETE CASCADE,
  ordinal            integer     NOT NULL CHECK (ordinal >= 1),
  text               text        NOT NULL,
  verifier_hint      text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  schema_version     integer     NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS ac_story_idx ON story_acceptance_criteria (story_id);
CREATE UNIQUE INDEX IF NOT EXISTS ac_unique_ordinal_idx
  ON story_acceptance_criteria (story_id, ordinal);

-- ============================================================================
-- sprints
-- ============================================================================

CREATE TABLE IF NOT EXISTS sprints (
  sprint_id              uuid        PRIMARY KEY,
  name                   text        NOT NULL,
  sequence               integer     NOT NULL,
  status                 text        NOT NULL DEFAULT 'planning'
                         CHECK (status IN (
                           'planning','ready','active','completing','completed','paused'
                         )),
  story_point_capacity   integer     NOT NULL CHECK (story_point_capacity > 0),
  wall_clock_target_ms   integer,
  budget_usd_cents       integer     NOT NULL CHECK (budget_usd_cents > 0),
  concurrency_share      integer     NOT NULL DEFAULT 100 CHECK (concurrency_share > 0),
  priority_class         text        NOT NULL DEFAULT 'standard'
                         CHECK (priority_class IN ('critical','standard','background')),
  sprint_channel_id      uuid,
  monday_board_group_id  text,
  started_at             timestamptz,
  paused_at              timestamptz,
  completed_at           timestamptz,
  pause_state            jsonb,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  schema_version         integer     NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS sprints_status_idx   ON sprints (status);
CREATE INDEX IF NOT EXISTS sprints_sequence_idx ON sprints (sequence);

-- ============================================================================
-- sprint_commitments
-- ============================================================================

CREATE TABLE IF NOT EXISTS sprint_commitments (
  commitment_id          uuid        PRIMARY KEY,
  sprint_id              uuid        NOT NULL REFERENCES sprints(sprint_id),
  ceremony_id            uuid,
  selected_story_ids     jsonb       NOT NULL,
  capacity_used_points   integer     NOT NULL CHECK (capacity_used_points >= 0),
  identified_risks       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  raised_concerns        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  is_partial             boolean     NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL DEFAULT now(),
  schema_version         integer     NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS sprint_commitments_sprint_uq
  ON sprint_commitments (sprint_id);

-- ============================================================================
-- monday_sync_state
-- ============================================================================

CREATE TABLE IF NOT EXISTS monday_sync_state (
  sync_state_id        uuid        PRIMARY KEY,
  aggregate_type       text        NOT NULL
                       CHECK (aggregate_type IN ('epic','story','task','sprint','defect')),
  aggregate_id         uuid        NOT NULL,
  monday_id            text        NOT NULL,
  last_push_at         timestamptz,
  last_pull_at         timestamptz,
  last_push_hash       text,
  last_pull_hash       text,
  last_seen_item_ids   jsonb       NOT NULL DEFAULT '[]'::jsonb,
  drift_detected_at    timestamptz,
  sync_error_count     integer     NOT NULL DEFAULT 0,
  last_error           text,
  schema_version       integer     NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS monday_sync_aggregate_uq
  ON monday_sync_state (aggregate_type, aggregate_id);

CREATE INDEX IF NOT EXISTS monday_sync_monday_idx
  ON monday_sync_state (monday_id);
