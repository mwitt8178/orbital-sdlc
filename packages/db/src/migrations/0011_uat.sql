-- Migration: 0011_uat
-- Phase 5A — UAT Workflow.
-- Per TRD-11 v0.2 §4.
--
-- Tables:
--   uat_sessions
--   uat_ac_results
--   defects
--   defect_lineage
--   persona_of_record_links
--
-- Notes:
--   - Idempotent (CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS).
--   - Within-context FKs: uat_ac_results → uat_sessions; defects → uat_sessions
--     and uat_ac_results; defect_lineage → defects (UNIQUE).
--   - Cross-context references (story_acceptance_criteria.ac_id, tasks.task_id,
--     stories.story_id, capability_grants) are nullable uuid columns WITHOUT
--     physical FKs — consistent with TRD-04 §4.1 reconciliation note pattern.
--   - No triggers; state-machine enforcement is at the application layer.
--   - defects.fixing_ticket_id is NULL until TRD-02's defect-promotion handler
--     writes the new fix story_id here (cross-TRD contract per §4.3).

-- ============================================================================
-- uat_sessions
-- ============================================================================

CREATE TABLE IF NOT EXISTS uat_sessions (
  uat_session_id        uuid        PRIMARY KEY,
  ticket_id             uuid        NOT NULL,
  story_version         integer     NOT NULL,
  session_version       integer     NOT NULL CHECK (session_version >= 1),
  state                 text        NOT NULL DEFAULT 'started'
                        CHECK (state IN (
                          'started', 'in_progress', 'submitted',
                          'accepted', 'partially_accepted', 'rejected'
                        )),
  triggered_by_event_id uuid        NOT NULL,
  build_ref             text        NOT NULL,
  started_by_user_id    text        NOT NULL,
  started_at            timestamptz NOT NULL DEFAULT now(),
  submitted_at          timestamptz,
  total_ac_count        integer     NOT NULL CHECK (total_ac_count >= 0),
  pass_count            integer     NOT NULL DEFAULT 0 CHECK (pass_count >= 0),
  fail_count            integer     NOT NULL DEFAULT 0 CHECK (fail_count >= 0),
  outcome_notes         text,
  assumptions_snapshot  jsonb       NOT NULL DEFAULT '[]',
  schema_version        integer     NOT NULL DEFAULT 1
);

-- UNIQUE per (ticket_id, session_version) — one session per sprint per TRD-11 §8.4.
-- The task prompt says "one UAT session per sprint"; the UNIQUE is on (ticket_id, session_version)
-- which effectively enforces one session per re-test cycle per story.
CREATE UNIQUE INDEX IF NOT EXISTS uat_sessions_ticket_version_uniq
  ON uat_sessions (ticket_id, session_version);

CREATE INDEX IF NOT EXISTS uat_sessions_ticket_idx
  ON uat_sessions (ticket_id, session_version);

CREATE INDEX IF NOT EXISTS uat_sessions_state_idx
  ON uat_sessions (state);

-- ============================================================================
-- uat_ac_results
-- ============================================================================

CREATE TABLE IF NOT EXISTS uat_ac_results (
  ac_result_id          uuid        PRIMARY KEY,
  uat_session_id        uuid        NOT NULL REFERENCES uat_sessions(uat_session_id),
  ac_id                 uuid        NOT NULL,   -- FK to story_acceptance_criteria (no physical FK, cross-schema)
  ac_ordinal            integer     NOT NULL CHECK (ac_ordinal >= 1),
  ac_text_snapshot      text        NOT NULL,
  status                text        NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'pass', 'fail')),
  observed_behavior     text,
  evidence_links        jsonb       NOT NULL DEFAULT '[]',
  marked_at             timestamptz,
  marked_by_user_id     text,
  schema_version        integer     NOT NULL DEFAULT 1
);

-- UNIQUE per (uat_session_id, ac_id) — one result row per AC per session.
CREATE UNIQUE INDEX IF NOT EXISTS uat_ac_results_session_ac_uniq
  ON uat_ac_results (uat_session_id, ac_id);

CREATE INDEX IF NOT EXISTS uat_ac_results_session_idx
  ON uat_ac_results (uat_session_id);

-- ============================================================================
-- defects
-- ============================================================================

CREATE TABLE IF NOT EXISTS defects (
  defect_id             uuid        PRIMARY KEY,
  defect_key            text        NOT NULL UNIQUE,
  origin_story_id       uuid        NOT NULL,   -- no physical FK, cross-schema
  origin_ac_id          uuid        NOT NULL,   -- no physical FK, cross-schema
  uat_session_id        uuid        NOT NULL REFERENCES uat_sessions(uat_session_id),
  ac_result_id          uuid        NOT NULL REFERENCES uat_ac_results(ac_result_id),
  persona_of_record_id  text        NOT NULL,
  title                 text        NOT NULL,
  observed_behavior     text        NOT NULL,
  expected_behavior     text        NOT NULL,
  severity              text        NOT NULL
                        CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  state                 text        NOT NULL DEFAULT 'open'
                        CHECK (state IN (
                          'open', 'triaged', 'assigned', 'in_progress',
                          'resolved', 'verified', 'reopened', 'closed'
                        )),
  preempts_sprint       text,                   -- sprint_id if it preempted, else null
  created_at            timestamptz NOT NULL DEFAULT now(),
  resolved_at           timestamptz,
  reopen_count          integer     NOT NULL DEFAULT 0 CHECK (reopen_count >= 0),
  -- Populated by TRD-02's defect-promotion handler; NULL until promoted.
  -- Value = TRD-02 stories.story_id. No physical FK (cross-schema).
  fixing_ticket_id      uuid,
  schema_version        integer     NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS defects_origin_idx
  ON defects (origin_story_id);

CREATE INDEX IF NOT EXISTS defects_persona_idx
  ON defects (persona_of_record_id);

CREATE INDEX IF NOT EXISTS defects_session_idx
  ON defects (uat_session_id);

CREATE INDEX IF NOT EXISTS defects_severity_idx
  ON defects (severity, state);

-- ============================================================================
-- defect_lineage
-- ============================================================================

CREATE TABLE IF NOT EXISTS defect_lineage (
  defect_lineage_id       uuid        PRIMARY KEY,
  defect_id               uuid        NOT NULL UNIQUE REFERENCES defects(defect_id),
  vision_document_id      uuid        NOT NULL,
  vision_version          integer     NOT NULL,
  epic_id                 uuid        NOT NULL,
  story_id                uuid        NOT NULL,
  ticket_id               uuid        NOT NULL,
  task_ids                jsonb       NOT NULL DEFAULT '[]',
  worker_session_ids      jsonb       NOT NULL DEFAULT '[]',
  primary_audit_event_ids jsonb       NOT NULL DEFAULT '[]',
  captured_at             timestamptz NOT NULL DEFAULT now(),
  schema_version          integer     NOT NULL DEFAULT 1
);

-- ============================================================================
-- persona_of_record_links
-- ============================================================================

CREATE TABLE IF NOT EXISTS persona_of_record_links (
  por_link_id         uuid        PRIMARY KEY,
  story_id            uuid        NOT NULL,
  ac_id               uuid,                     -- optional AC-level granularity
  persona_id          text        NOT NULL,
  role                text        NOT NULL
                      CHECK (role IN (
                        'implementation', 'verification', 'review',
                        'tests', 'design', 'architecture'
                      )),
  task_id             uuid        NOT NULL,
  worker_session_id   uuid        NOT NULL,
  recorded_at         timestamptz NOT NULL DEFAULT now(),
  schema_version      integer     NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS por_links_story_idx
  ON persona_of_record_links (story_id, role);

CREATE INDEX IF NOT EXISTS por_links_persona_idx
  ON persona_of_record_links (persona_id);

CREATE INDEX IF NOT EXISTS por_links_story_ac_idx
  ON persona_of_record_links (story_id, ac_id);
