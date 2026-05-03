-- Migration: 0006_orchestration
-- Phase 2C — Orchestration Engine.
-- Per TRD-04 v0.2 §4.
--
-- Tables:
--   tasks
--   task_dependencies
--   worktrees
--   retry_attempts
--   escalations
--   worker_pool_state (single-row)
--
-- Notes:
--   - Idempotent (CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS).
--   - No foreign keys to tables in other phases — by design (TRD-04 §4.1
--     reconciliation note: cross-schema FKs are conceptual; physical
--     enforcement is per-table).
--   - CHECK constraints encode the lifecycle invariants from TRD-04 §4.1.
--   - No triggers; append-only / state-machine enforcement is at the
--     application layer.

-- ============================================================================
-- tasks
-- ============================================================================

CREATE TABLE IF NOT EXISTS tasks (
  task_id                       uuid        PRIMARY KEY,
  sprint_id                     uuid        NOT NULL,
  ticket_id                     text        NOT NULL,
  title                         text        NOT NULL,
  description                   text        NOT NULL,
  acceptance_criteria           jsonb       NOT NULL DEFAULT '[]'::jsonb,

  -- Backlog linkage (TRD-02 supplies these at task-creation; nullable here).
  story_id                      uuid,
  monday_subitem_id             text,
  ordering                      integer,
  estimated_duration_ms         integer,
  linked_artifacts              jsonb       NOT NULL DEFAULT '[]'::jsonb,

  persona_id                    text        NOT NULL,
  risk_class                    text        NOT NULL DEFAULT 'standard'
                                CHECK (risk_class IN ('low','standard','high','critical')),

  state                         text        NOT NULL DEFAULT 'pending'
                                CHECK (state IN (
                                  'pending','ready','in_progress','in_review',
                                  'blocked','failed','escalated','done'
                                )),
  attempt_count                 integer     NOT NULL DEFAULT 0,
  retry_budget                  integer     NOT NULL,
  parent_task_id                uuid,

  current_worker_id             uuid,
  current_capability_id         uuid,
  current_routing_decision_id   uuid,
  current_worktree_id           uuid,

  wall_clock_timeout_ms         integer     NOT NULL,
  token_budget                  integer     NOT NULL,
  tokens_consumed               integer     NOT NULL DEFAULT 0,

  declared_write_paths          jsonb       NOT NULL DEFAULT '[]'::jsonb,

  created_at                    timestamptz NOT NULL DEFAULT now(),
  started_at                    timestamptz,
  completed_at                  timestamptz,
  created_by_event_id           uuid        NOT NULL,

  -- Lifecycle invariants (TRD-04 §4.1):
  --   state='in_progress' ⇔ all current_* fields are NOT NULL
  CONSTRAINT tasks_in_progress_link_invariant CHECK (
    (state = 'in_progress' AND current_worker_id IS NOT NULL
                           AND current_capability_id IS NOT NULL
                           AND current_worktree_id IS NOT NULL)
    OR
    (state <> 'in_progress')
  ),
  --   state IN ('pending','ready') ⇒ current_worker_id IS NULL
  CONSTRAINT tasks_pre_assign_no_worker CHECK (
    state NOT IN ('pending','ready') OR current_worker_id IS NULL
  ),
  --   attempt_count <= retry_budget + 1 (the +1 is the original attempt)
  CONSTRAINT tasks_attempt_within_budget CHECK (
    attempt_count <= retry_budget + 1
  )
);

CREATE INDEX IF NOT EXISTS tasks_sprint_idx  ON tasks (sprint_id, state);
CREATE INDEX IF NOT EXISTS tasks_ticket_idx  ON tasks (ticket_id);
CREATE INDEX IF NOT EXISTS tasks_state_idx   ON tasks (state);
CREATE INDEX IF NOT EXISTS tasks_story_idx   ON tasks (story_id);

-- ============================================================================
-- task_dependencies
-- ============================================================================

CREATE TABLE IF NOT EXISTS task_dependencies (
  predecessor_task_id     uuid        NOT NULL,
  successor_task_id       uuid        NOT NULL,
  dependency_type         text        NOT NULL
                          CHECK (dependency_type IN ('explicit','file_based','implicit')),
  blocking                boolean     NOT NULL DEFAULT true,
  file_path_pattern       text,
  derived_from_ticket_link text,
  rationale               text        NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (predecessor_task_id, successor_task_id),
  CONSTRAINT task_deps_no_self_edge CHECK (predecessor_task_id <> successor_task_id)
);

CREATE INDEX IF NOT EXISTS task_deps_successor_idx
  ON task_dependencies (successor_task_id);

-- ============================================================================
-- worktrees
-- ============================================================================

CREATE TABLE IF NOT EXISTS worktrees (
  worktree_id                 uuid        PRIMARY KEY,
  task_id                     uuid        NOT NULL,
  path                        text        NOT NULL,
  branch_name                 text        NOT NULL,
  parent_branch               text        NOT NULL,
  state                       text        NOT NULL
                              CHECK (state IN ('creating','active','draining','cleaning','released')),
  declared_write_paths        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  conflicts_with_worktree_id  uuid,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  released_at                 timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS worktrees_task_uq
  ON worktrees (task_id) WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS worktrees_task_idx ON worktrees (task_id);

-- ============================================================================
-- retry_attempts
-- ============================================================================

CREATE TABLE IF NOT EXISTS retry_attempts (
  retry_attempt_id        uuid        PRIMARY KEY,
  task_id                 uuid        NOT NULL,
  attempt_number          integer     NOT NULL CHECK (attempt_number >= 1),
  triggered_by_event_id   uuid        NOT NULL,
  error_code              text        NOT NULL,
  routing_adjustment      jsonb,
  decided_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS retry_task_idx
  ON retry_attempts (task_id, attempt_number);

-- ============================================================================
-- escalations
-- ============================================================================

CREATE TABLE IF NOT EXISTS escalations (
  escalation_id           uuid        PRIMARY KEY,
  task_id                 uuid        NOT NULL,
  reason                  text        NOT NULL
                          CHECK (reason IN (
                            'retry_budget_exhausted','timeout_after_retries',
                            'blocker_unresolvable','disagreement_unresolvable',
                            'hook_rejected_critical','manual_admin_kill'
                          )),
  triggering_event_id     uuid        NOT NULL,
  context                 jsonb       NOT NULL,
  state                   text        NOT NULL DEFAULT 'open'
                          CHECK (state IN ('open','acknowledged','resolved','cancelled')),
  resolved_at             timestamptz,
  resolution_note         text,
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS escalations_task_idx  ON escalations (task_id);
CREATE INDEX IF NOT EXISTS escalations_state_idx ON escalations (state);

-- ============================================================================
-- worker_pool_state — single-row, id=1 enforced by CHECK
-- ============================================================================

CREATE TABLE IF NOT EXISTS worker_pool_state (
  id                       integer     PRIMARY KEY DEFAULT 1
                           CHECK (id = 1),
  max_concurrent_workers   integer     NOT NULL DEFAULT 8,
  max_active_sprints       integer     NOT NULL DEFAULT 3,
  paused                   boolean     NOT NULL DEFAULT false,
  paused_reason            text,
  paused_at                timestamptz,
  scheduler_epoch          bigint      NOT NULL DEFAULT 0
);

-- Seed the singleton row (idempotent).
INSERT INTO worker_pool_state (id, max_concurrent_workers, max_active_sprints, paused, scheduler_epoch)
VALUES (1, 8, 3, false, 0)
ON CONFLICT (id) DO NOTHING;
