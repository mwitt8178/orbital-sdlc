-- Migration: 0001_events
-- Per TRD-07 §4.1.1 and §12.1: Drizzle does not emit native PARTITION BY DDL.
-- This migration is authored manually and is fully idempotent (safe to re-run).
--
-- It creates the partitioned events table, supporting tables, triggers, and
-- initial monthly partitions for the current and next month.

-- ============================================================================
-- Schema
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS audit;

-- ============================================================================
-- events table (partitioned)
-- Only created if it does not exist; if it already exists as a partitioned
-- table from a previous run, this is a no-op.
-- ============================================================================

-- We cannot use CREATE TABLE IF NOT EXISTS with PARTITION BY on an existing
-- table that may already be partitioned differently, so we check existence.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'audit' AND c.relname = 'events'
  ) THEN
    CREATE TABLE audit.events (
      event_id         uuid         NOT NULL,
      aggregate_id     uuid         NOT NULL,
      aggregate_type   text         NOT NULL,
      event_type       text         NOT NULL,
      payload          jsonb        NOT NULL,
      actor            jsonb        NOT NULL,
      capability_id    uuid,
      parent_event_id  uuid,
      trace_id         text         NOT NULL,
      occurred_at      timestamptz  NOT NULL,
      ingested_at      timestamptz  NOT NULL DEFAULT now(),
      schema_version   integer      NOT NULL,
      -- PK must include the partition key (ingested_at) per Postgres requirement.
      PRIMARY KEY (event_id, ingested_at)
    ) PARTITION BY RANGE (ingested_at);
  END IF;
END;
$$;

-- ============================================================================
-- Indexes
-- NOTE on uniqueness: Postgres does not allow a unique index on a partitioned
-- table unless it includes all partition-key columns (ingested_at). UUIDv7
-- collision probability is vanishingly small (~1 in 2^122). Uniqueness is
-- enforced per-partition automatically via the PK. The gateway treats INSERT
-- error code 23505 as success-by-prior-write (idempotency per TRD-07 §8.1).
-- ============================================================================

CREATE INDEX IF NOT EXISTS events_aggregate_occurred_at_idx
  ON audit.events (aggregate_id, occurred_at);

CREATE INDEX IF NOT EXISTS events_event_type_occurred_at_idx
  ON audit.events (event_type, occurred_at);

-- GIN expression index for actor->>'persona_id' filter (TRD-07 §6.1.1).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'audit'
      AND tablename = 'events'
      AND indexname = 'events_actor_persona_occurred_at_idx'
  ) THEN
    EXECUTE $idx$
      CREATE INDEX events_actor_persona_occurred_at_idx
        ON audit.events ((actor->>'persona_id'), occurred_at)
    $idx$;
  END IF;
END;
$$;

-- jsonb_path_ops for equality-path lookups; smaller than jsonb_ops (TRD-07 §12.7).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'audit'
      AND tablename = 'events'
      AND indexname = 'events_payload_gin'
  ) THEN
    EXECUTE $idx$
      CREATE INDEX events_payload_gin
        ON audit.events USING gin (payload jsonb_path_ops)
    $idx$;
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS events_capability_occurred_at_idx
  ON audit.events (capability_id, occurred_at);

CREATE INDEX IF NOT EXISTS events_trace_id_idx
  ON audit.events (trace_id);

-- Partition-key index; also serves cursor seek (ingested_at, event_id).
CREATE INDEX IF NOT EXISTS events_ingested_at_idx
  ON audit.events (ingested_at, event_id);

-- ============================================================================
-- Trigger: REJECT UPDATE / DELETE / TRUNCATE (append-only enforcement)
-- Per TRD-07 §4.1.3
-- ============================================================================

CREATE OR REPLACE FUNCTION audit.events_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'audit.events is append-only; % is not permitted (event_id=%)',
    TG_OP, COALESCE(OLD.event_id::text, NEW.event_id::text)
    USING ERRCODE = 'P0001',
          HINT = 'Restore-style operations write a new event with parent_event_id; '
                 'they never mutate an existing row.';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'audit' AND c.relname = 'events' AND t.tgname = 'events_reject_update'
  ) THEN
    EXECUTE $tg$
      CREATE TRIGGER events_reject_update
        BEFORE UPDATE ON audit.events
        FOR EACH ROW EXECUTE FUNCTION audit.events_reject_mutation()
    $tg$;
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'audit' AND c.relname = 'events' AND t.tgname = 'events_reject_delete'
  ) THEN
    EXECUTE $tg$
      CREATE TRIGGER events_reject_delete
        BEFORE DELETE ON audit.events
        FOR EACH ROW EXECUTE FUNCTION audit.events_reject_mutation()
    $tg$;
  END IF;
END;
$$;

-- BEFORE TRUNCATE at statement level: row-level triggers do not fire on TRUNCATE.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'audit' AND c.relname = 'events' AND t.tgname = 'events_reject_truncate'
  ) THEN
    EXECUTE $tg$
      CREATE TRIGGER events_reject_truncate
        BEFORE TRUNCATE ON audit.events
        FOR EACH STATEMENT EXECUTE FUNCTION audit.events_reject_mutation()
    $tg$;
  END IF;
END;
$$;

-- ============================================================================
-- Trigger: NOTIFY on INSERT (live propagation)
-- Per TRD-07 §4.1.4
-- ============================================================================

CREATE OR REPLACE FUNCTION audit.events_notify_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Payload = event_id only (pg_notify limit is 8KB; subscribers re-fetch by id).
  PERFORM pg_notify('events_channel', NEW.event_id::text);
  RETURN NEW;
END;
$$;

-- AFTER INSERT so subscribers reading by id are guaranteed to find the row.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'audit' AND c.relname = 'events' AND t.tgname = 'events_notify_after_insert'
  ) THEN
    EXECUTE $tg$
      CREATE TRIGGER events_notify_after_insert
        AFTER INSERT ON audit.events
        FOR EACH ROW EXECUTE FUNCTION audit.events_notify_insert()
    $tg$;
  END IF;
END;
$$;

-- ============================================================================
-- Initial monthly partitions
-- Per TRD-07 §4.1.2: current month + next month created at migration time.
-- Maintenance job (Phase 4C) creates future partitions on the 25th of each month.
-- events_default catches any inserts outside explicit partition ranges.
-- ============================================================================

-- Current month (May 2026)
CREATE TABLE IF NOT EXISTS audit.events_y2026_m05
  PARTITION OF audit.events
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

-- Next month (June 2026)
CREATE TABLE IF NOT EXISTS audit.events_y2026_m06
  PARTITION OF audit.events
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

-- Default partition: catches inserts outside explicit partition ranges.
-- A daily alert fires if this partition is non-empty (TRD-07 §4.1.2).
CREATE TABLE IF NOT EXISTS audit.events_default
  PARTITION OF audit.events DEFAULT;

-- ============================================================================
-- reconciliation_runs
-- Per TRD-07 §4.2
-- ============================================================================

CREATE TABLE IF NOT EXISTS audit.reconciliation_runs (
  run_id                uuid         PRIMARY KEY,
  started_at            timestamptz  NOT NULL DEFAULT now(),
  completed_at          timestamptz,
  trigger               text         NOT NULL,
  triggered_by          jsonb        NOT NULL,
  window_from           timestamptz  NOT NULL,
  window_to             timestamptz  NOT NULL,
  git_commits_scanned   integer      NOT NULL DEFAULT 0,
  worktree_files_scanned integer     NOT NULL DEFAULT 0,
  monday_items_scanned  integer      NOT NULL DEFAULT 0,
  drift_events_emitted  integer      NOT NULL DEFAULT 0,
  status                text         NOT NULL,
  error_payload         jsonb
);

CREATE INDEX IF NOT EXISTS reconciliation_runs_started_idx
  ON audit.reconciliation_runs (started_at);

-- ============================================================================
-- drift_events
-- Per TRD-07 §4.2
-- ============================================================================

CREATE TABLE IF NOT EXISTS audit.drift_events (
  drift_id            uuid         PRIMARY KEY,
  run_id              uuid         NOT NULL,
  source              text         NOT NULL,
  drift_kind          text         NOT NULL,
  observed            jsonb        NOT NULL,
  expected            jsonb,
  severity            text         NOT NULL,
  detected_at         timestamptz  NOT NULL DEFAULT now(),
  detection_event_id  uuid         NOT NULL,
  resolution          text,
  resolution_note     text,
  resolved_at         timestamptz
);

CREATE INDEX IF NOT EXISTS drift_events_run_idx
  ON audit.drift_events (run_id);

-- Partial index: unresolved drift items for fast dashboard / alerting queries.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'audit'
      AND tablename = 'drift_events'
      AND indexname = 'drift_events_unresolved_idx'
  ) THEN
    EXECUTE $idx$
      CREATE INDEX drift_events_unresolved_idx
        ON audit.drift_events (detected_at)
        WHERE resolution IS NULL
    $idx$;
  END IF;
END;
$$;

-- ============================================================================
-- audit_query_cache  (§4.3 — schema stub; feature is off by default)
-- ============================================================================

CREATE TABLE IF NOT EXISTS audit.audit_query_cache (
  cache_key       text         PRIMARY KEY,
  result_page     jsonb        NOT NULL,
  total_estimate  integer,
  populated_at    timestamptz  NOT NULL DEFAULT now(),
  expires_at      timestamptz  NOT NULL,
  hit_count       integer      NOT NULL DEFAULT 0
);
