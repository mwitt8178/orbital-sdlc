-- Migration 0027: replay_captures table.
--
-- Round 6 #7 — Determinism / Replay
-- [Engineer-Principal · Opus · run-round6-07-replay]
--
-- Strategy: ADDITIVE ONLY per multi-tenant-migrations discipline.
-- Per DSQL constraints: DDL statements separated by breakpoints, no mixing with DML.
--
-- Purpose:
--   Persist a metadata row per LLM/tool/hook capture. The full request+response
--   blob lives at storage_uri (filesystem v1, S3 later). Each row carries a
--   sha256 hash of the canonical request and response so replay can verify
--   integrity on read; mismatch emits a ReplayCorrupt audit event.
--
-- Indices:
--   rc_worker_idx — list captures by worker_id, newest first
--   rc_task_idx   — list captures by task_id, newest first
--   rc_event_idx  — fast lookup of all captures attached to an audit event
--   rc_capture_kind_idx — filter by kind (llm_request | tool_call | hook_invocation)

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS replay_captures (
  capture_id      uuid        PRIMARY KEY,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  worker_id       uuid,
  task_id         uuid,
  event_id        uuid,
  capture_kind    text        NOT NULL CHECK (capture_kind IN ('llm_request','tool_call','hook_invocation')),
  provider        text,
  model           text,
  request_hash    text        NOT NULL,
  response_hash   text        NOT NULL,
  storage_uri     text        NOT NULL,
  size_bytes      integer     NOT NULL,
  schema_version  integer     NOT NULL DEFAULT 1
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS rc_worker_idx ON replay_captures (worker_id, occurred_at DESC);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS rc_task_idx ON replay_captures (task_id, occurred_at DESC);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS rc_event_idx ON replay_captures (event_id);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS rc_capture_kind_idx ON replay_captures (capture_kind, occurred_at DESC);
