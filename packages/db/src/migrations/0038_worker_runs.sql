-- 0038_worker_runs.sql
-- Orbital Story Executor — verification run.
-- [Engineer-Principal · Opus · run-orbital-story-executor]
--
-- Adds the worker_runs append-style aggregate that records every story-executor
-- attempt: spawn, lifecycle, cost, exit, PR url, failure reason.
--
-- Additive only. No FKs (DSQL discipline; soft references to stories.story_id).
-- DDL only (no DML). Safe to apply against local Postgres or DSQL.

CREATE TABLE IF NOT EXISTS worker_runs (
  run_id           uuid        PRIMARY KEY,
  tenant_id        uuid        NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  story_id         uuid        NOT NULL,
  attempt          integer     NOT NULL DEFAULT 1,
  status           text        NOT NULL DEFAULT 'spawning'
                   CHECK (status IN (
                     'spawning','running','succeeded','failed',
                     'cancelled','timed_out','budget_killed'
                   )),
  started_at       timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz,
  pid              integer,
  branch           text,
  pr_url           text,
  cost_usd_cents   integer     NOT NULL DEFAULT 0,
  prompt_tokens    integer     NOT NULL DEFAULT 0,
  output_tokens    integer     NOT NULL DEFAULT 0,
  exit_code        integer,
  failure_reason   text,
  schema_version   integer     NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS worker_runs_story_idx   ON worker_runs (story_id);
CREATE INDEX IF NOT EXISTS worker_runs_status_idx  ON worker_runs (status);
CREATE INDEX IF NOT EXISTS worker_runs_started_idx ON worker_runs (started_at DESC);
