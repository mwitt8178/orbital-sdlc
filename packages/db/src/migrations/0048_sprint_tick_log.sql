-- 0048_sprint_tick_log.sql
-- Sprint tick infrastructure: sprint_tick_log + project_sprint_policy.
--
-- [Engineer-Sr · Sonnet · run-sprint-loop]
--
-- sprint_tick_log  — append-only audit log of every Workflow Status transition
--                    driven by the daemon sprint-tick worker. Each row records
--                    the sprint, the story, the transition, the actor, and
--                    the reason. Never updated or deleted.
--
-- project_sprint_policy — per-tenant per-project settings that govern how the
--                          sprint-tick worker dispatches story runs. Readable
--                          by the daemon on every tick; defaults are generous.
--
-- sprint_tick_leases — ephemeral single-row lease table used by the 30-second
--                      tick worker to elect exactly one daemon instance via
--                      SELECT ... FOR UPDATE SKIP LOCKED. Row is inserted at
--                      first boot and then updated in-place. DDL-only here;
--                      the seed row is inserted by the daemon on boot if absent.
--
-- story_pr_runs     — lightweight registry of daemon-spawned story execution runs.
--                      Tracks which story is being worked on, which sprint it
--                      belongs to, status, and a reference to the underlying
--                      worker_runs row (when the story-pr-pipeline is wired).
--
-- DSQL discipline:
--   - No foreign keys, triggers, sequences, or materialized views.
--   - IDs are uuid columns; app generates UUIDv7.
--   - DDL only (no DML). Additive — all tables use CREATE TABLE IF NOT EXISTS.
--   - Idempotent indexes with CREATE INDEX IF NOT EXISTS.

-- ============================================================================
-- sprint_tick_log
-- ============================================================================

CREATE TABLE IF NOT EXISTS sprint_tick_log (
  log_id          uuid        PRIMARY KEY,
  tenant_id       uuid        NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  sprint_id       uuid        NOT NULL,
  story_id        uuid        NOT NULL,
  from_status     text        NOT NULL,
  to_status       text        NOT NULL,
  actor           text        NOT NULL DEFAULT 'daemon:sprint-tick',
  reason          text        NOT NULL,
  tick_id         uuid        NOT NULL,
  logged_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  schema_version  integer     NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS sprint_tick_log_sprint_idx
  ON sprint_tick_log (tenant_id, sprint_id, logged_at DESC);

CREATE INDEX IF NOT EXISTS sprint_tick_log_story_idx
  ON sprint_tick_log (tenant_id, story_id, logged_at DESC);

CREATE INDEX IF NOT EXISTS sprint_tick_log_tick_idx
  ON sprint_tick_log (tick_id);

-- ============================================================================
-- project_sprint_policy
-- ============================================================================

CREATE TABLE IF NOT EXISTS project_sprint_policy (
  policy_id           uuid        PRIMARY KEY,
  tenant_id           uuid        NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  project_id          uuid        NOT NULL,
  -- max simultaneous in_progress stories across all active sprints for this project
  max_concurrent_runs integer     NOT NULL DEFAULT 3,
  -- story-point capacity ceiling per sprint (overrides sprint.story_point_capacity
  -- when lower). 0 = no additional cap beyond the sprint row.
  capacity_override   integer     NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  schema_version      integer     NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS project_sprint_policy_project_uq
  ON project_sprint_policy (tenant_id, project_id);

-- ============================================================================
-- sprint_tick_leases
-- ============================================================================
--
-- Exactly one row per tenant. The daemon's tick worker acquires this row via
-- SELECT ... FOR UPDATE SKIP LOCKED before doing any work, ensuring only one
-- daemon instance runs a tick for a given tenant at a time.

CREATE TABLE IF NOT EXISTS sprint_tick_leases (
  tenant_id   uuid        PRIMARY KEY,
  holder_id   text        NOT NULL DEFAULT '',
  acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at  timestamptz NOT NULL DEFAULT clock_timestamp() + interval '60 seconds'
);

-- ============================================================================
-- story_pr_runs (sprint-loop additions)
-- ============================================================================
--
-- The story-pr-pipeline branch already created story_pr_runs with the canonical
-- schema. Sprint-loop adds the columns + indexes it needs additively.

ALTER TABLE story_pr_runs ADD COLUMN IF NOT EXISTS sprint_id            uuid;
ALTER TABLE story_pr_runs ADD COLUMN IF NOT EXISTS attempt              integer NOT NULL DEFAULT 1;
ALTER TABLE story_pr_runs ADD COLUMN IF NOT EXISTS lambda_invocation_id text;
ALTER TABLE story_pr_runs ADD COLUMN IF NOT EXISTS worker_run_id        uuid;
ALTER TABLE story_pr_runs ADD COLUMN IF NOT EXISTS error_message        text;
ALTER TABLE story_pr_runs ADD COLUMN IF NOT EXISTS ended_at             timestamptz;
ALTER TABLE story_pr_runs ADD COLUMN IF NOT EXISTS schema_version       integer NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS story_pr_runs_sprint_idx
  ON story_pr_runs (tenant_id, sprint_id, started_at DESC);

CREATE INDEX IF NOT EXISTS story_pr_runs_story_idx
  ON story_pr_runs (tenant_id, story_id, started_at DESC);

CREATE INDEX IF NOT EXISTS story_pr_runs_status_idx
  ON story_pr_runs (status);
