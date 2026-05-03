-- Migration: 0008_determinism
-- Phase 3B — Hook Engine + Verifiers.
-- Per TRD-09 §4.
--
-- Tables:
--   hooks
--   hook_versions
--   hook_invocations
--   verifications
--   verification_results
--   hook_specifications
--
-- Notes:
--   - Idempotent (CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS).
--   - No FK references to tables in other migrations by name to avoid
--     circular dependency issues in migration ordering.
--   - Logical FKs are documented in comments; enforcement is at application layer.

-- ============================================================================
-- hooks
-- ============================================================================

CREATE TABLE IF NOT EXISTS hooks (
  hook_id              uuid        PRIMARY KEY,
  hook_slug            text        NOT NULL UNIQUE,
  description          text        NOT NULL,
  current_version_id   uuid        NOT NULL,          -- logical FK → hook_versions.hook_version_id
  enabled              boolean     NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- hook_versions
-- ============================================================================

CREATE TABLE IF NOT EXISTS hook_versions (
  hook_version_id         uuid        PRIMARY KEY,
  hook_id                 uuid        NOT NULL REFERENCES hooks(hook_id),
  version                 integer     NOT NULL,
  source_sha256           text        NOT NULL,
  source_text             text        NOT NULL,
  applies_to_event_types  jsonb       NOT NULL,        -- string[]
  timing                  text        NOT NULL CHECK (timing IN ('pre', 'post')),
  declared_order          integer     NOT NULL DEFAULT 100,
  pr_url                  text,
  approved_by_user_id     uuid,
  approval_event_id       uuid,                        -- logical FK → events.event_id
  shipped_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hook_id, version)
);

CREATE INDEX IF NOT EXISTS hook_versions_hook_idx ON hook_versions(hook_id);

-- ============================================================================
-- hook_invocations
-- ============================================================================

CREATE TABLE IF NOT EXISTS hook_invocations (
  invocation_id    uuid        PRIMARY KEY,
  hook_id          uuid        NOT NULL REFERENCES hooks(hook_id),
  hook_version_id  uuid        NOT NULL REFERENCES hook_versions(hook_version_id),
  event_type       text        NOT NULL,
  timing           text        NOT NULL CHECK (timing IN ('pre', 'post')),
  decision         text        NOT NULL CHECK (decision IN ('allow', 'reject')),
  reason           text,
  error_code       text,
  duration_ms      integer     NOT NULL,
  trace_id         text        NOT NULL,
  parent_event_id  uuid,                               -- logical FK → events.event_id
  payload_digest   text        NOT NULL,
  fired_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hook_inv_hook_event_idx ON hook_invocations(hook_id, event_type, fired_at);
CREATE INDEX IF NOT EXISTS hook_inv_decision_idx   ON hook_invocations(decision, fired_at);
CREATE INDEX IF NOT EXISTS hook_inv_trace_idx      ON hook_invocations(trace_id);

-- ============================================================================
-- verifications
-- ============================================================================

CREATE TABLE IF NOT EXISTS verifications (
  verification_id       uuid        PRIMARY KEY,
  task_id               uuid        NOT NULL,          -- logical FK → tasks.task_id
  ticket_id             text        NOT NULL,
  verifier_session_id   uuid        NOT NULL,          -- SessionId of verifier worker
  status                text        NOT NULL CHECK (status IN ('running', 'passed', 'failed', 'ambiguous')),
  ac_count              integer     NOT NULL,
  ac_pass_count         integer     NOT NULL DEFAULT 0,
  ac_fail_count         integer     NOT NULL DEFAULT 0,
  ac_ambiguous_count    integer     NOT NULL DEFAULT 0,
  summary               text,
  ambiguity_resolution  text,
  duration_ms           integer,
  trace_id              text        NOT NULL,
  started_at            timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz
);

CREATE INDEX IF NOT EXISTS verifications_task_idx   ON verifications(task_id, started_at);
CREATE INDEX IF NOT EXISTS verifications_status_idx ON verifications(status);

-- ============================================================================
-- verification_results
-- ============================================================================

CREATE TABLE IF NOT EXISTS verification_results (
  result_id         uuid        PRIMARY KEY,
  verification_id   uuid        NOT NULL REFERENCES verifications(verification_id),
  ac_index          integer     NOT NULL,
  ac_text           text        NOT NULL,
  verdict           text        NOT NULL CHECK (verdict IN ('pass', 'fail', 'ambiguous')),
  reason            text        NOT NULL,
  evidence_refs     jsonb       NOT NULL DEFAULT '[]',
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (verification_id, ac_index)
);

CREATE INDEX IF NOT EXISTS vr_verification_idx ON verification_results(verification_id, ac_index);

-- ============================================================================
-- hook_specifications
-- ============================================================================

CREATE TABLE IF NOT EXISTS hook_specifications (
  spec_id                  uuid        PRIMARY KEY,
  hook_id                  uuid        NOT NULL REFERENCES hooks(hook_id),
  hook_version_id          uuid        NOT NULL REFERENCES hook_versions(hook_version_id),
  name                     text        NOT NULL,
  applies_to_event_types   jsonb       NOT NULL,        -- string[]
  timing                   text        NOT NULL CHECK (timing IN ('pre', 'post')),
  declared_order           integer     NOT NULL,
  declared_error_code      text        NOT NULL,
  rationale                text        NOT NULL,
  test_fixtures_path       text,
  loaded_at                timestamptz NOT NULL DEFAULT now()
);
