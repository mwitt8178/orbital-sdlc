-- Migration: 0005_workers
-- Phase 2B: agent_workers and worker_heartbeats tables.
-- Phase 2C will add tasks, task_dependencies, retry_attempts, escalations, worktrees.
--
-- No foreign keys to tasks (tasks table doesn't exist yet; Phase 2C adds it).
-- No triggers — append-only is enforced at the application layer for heartbeats.

-- ============================================================================
-- Tables
-- ============================================================================

CREATE TABLE IF NOT EXISTS agent_workers (
  worker_id           uuid        PRIMARY KEY,
  persona_id          text        NOT NULL,
  session_id          uuid        NOT NULL,
  task_id             uuid,                                    -- nullable until task assigned
  status              text        NOT NULL DEFAULT 'connecting'
                                  CHECK (status IN ('connecting','active','idle','terminating','terminated')),
  started_at          timestamptz NOT NULL DEFAULT now(),
  last_heartbeat_at   timestamptz,
  capability_id       uuid        NOT NULL,
  pid                 integer
);

CREATE INDEX IF NOT EXISTS agent_workers_task_idx        ON agent_workers (task_id);
CREATE INDEX IF NOT EXISTS agent_workers_status_idx      ON agent_workers (status);
CREATE INDEX IF NOT EXISTS agent_workers_capability_idx  ON agent_workers (capability_id);

CREATE TABLE IF NOT EXISTS worker_heartbeats (
  heartbeat_id  uuid        PRIMARY KEY,
  worker_id     uuid        NOT NULL,
  task_id       uuid,
  ts            timestamptz NOT NULL DEFAULT now(),
  status        text        NOT NULL,
  files_touched jsonb       NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS hb_worker_time_idx ON worker_heartbeats (worker_id, ts);
CREATE INDEX IF NOT EXISTS hb_task_idx        ON worker_heartbeats (task_id);
