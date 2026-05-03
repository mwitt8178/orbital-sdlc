-- Migration: 0012_retros
-- Phase 5B - Retro Service.
-- Per TRD-10 v0.1 §4.
--
-- Tables (new):
--   retro_reports
--   retro_analyses
--   retro_proposals
--   retro_proposal_layers
--   system_versions
--   system_version_diffs
--   retro_outcomes
--
-- Additive change to existing table (Phase 4B-owned, extended here per Phase 5B brief):
--   sprint_commitments     ADD COLUMN system_version_id uuid (nullable; no FK).
--
-- Notes:
--   - Idempotent (CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS,
--     ADD COLUMN IF NOT EXISTS).
--   - Within-context FKs are real; cross-context references (sprint_id,
--     retro_report_id-from-other-aggregates) are nullable uuid columns without
--     physical FKs - consistent with TRD-04 §4.1 reconciliation pattern.
--   - No triggers; state-machine enforcement is at the application layer.
--   - sprint_commitments is owned by Phase 4B; this migration ONLY adds a
--     nullable column. No existing column, constraint, or index is altered.

-- ============================================================================
-- retro_reports
-- ============================================================================

CREATE TABLE IF NOT EXISTS retro_reports (
  retro_report_id            uuid        PRIMARY KEY,
  sprint_id                  uuid        NOT NULL,
  system_version_id          uuid,
  analysis_run_seq           integer     NOT NULL DEFAULT 1
                             CHECK (analysis_run_seq > 0),
  status                     text        NOT NULL DEFAULT 'analyzing'
                             CHECK (status IN (
                               'analyzing','ready','reviewing','closed','failed'
                             )),
  started_at                 timestamptz NOT NULL DEFAULT now(),
  completed_at               timestamptz,
  proposal_count             integer     NOT NULL DEFAULT 0,
  approved_count             integer     NOT NULL DEFAULT 0,
  rejected_count             integer     NOT NULL DEFAULT 0,
  deferred_count             integer     NOT NULL DEFAULT 0,
  retro_on_retro_accuracy    integer,
  failure_reason             text,
  created_event_id           uuid        NOT NULL,
  schema_version             integer     NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS retro_reports_sprint_run_uq
  ON retro_reports (sprint_id, analysis_run_seq);
CREATE INDEX IF NOT EXISTS retro_reports_version_idx
  ON retro_reports (system_version_id);
CREATE INDEX IF NOT EXISTS retro_reports_status_idx
  ON retro_reports (status);

-- ============================================================================
-- retro_analyses
-- ============================================================================

CREATE TABLE IF NOT EXISTS retro_analyses (
  retro_analysis_id      uuid        PRIMARY KEY,
  retro_report_id        uuid        NOT NULL REFERENCES retro_reports(retro_report_id),
  metric_key             text        NOT NULL,
  metric_value           jsonb       NOT NULL,
  prev_sprint_value      jsonb,
  pct_delta              integer,
  flagged                boolean     NOT NULL DEFAULT false,
  computed_at            timestamptz NOT NULL DEFAULT now(),
  query_trace_ref        text,
  schema_version         integer     NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS retro_analyses_report_idx
  ON retro_analyses (retro_report_id);
CREATE UNIQUE INDEX IF NOT EXISTS retro_analyses_metric_uq
  ON retro_analyses (retro_report_id, metric_key);

-- ============================================================================
-- retro_proposals
-- ============================================================================

CREATE TABLE IF NOT EXISTS retro_proposals (
  retro_proposal_id            uuid        PRIMARY KEY,
  retro_report_id              uuid        NOT NULL REFERENCES retro_reports(retro_report_id),
  proposal_code                text        NOT NULL,
  title                        text        NOT NULL,
  hypothesis                   text        NOT NULL,
  expected_impact_metric       text        NOT NULL,
  expected_impact_direction    text        NOT NULL
                               CHECK (expected_impact_direction IN ('decrease','increase')),
  expected_impact_pct_points   integer     NOT NULL,
  expected_impact_ci           jsonb,
  rollback_path                text        NOT NULL,
  evidence_refs                jsonb       NOT NULL DEFAULT '[]'::jsonb,
  applies_to_sprint_id         uuid,
  is_global                    boolean     NOT NULL DEFAULT false,
  current_value                jsonb,
  proposed_value               jsonb,
  confidence_score             integer     NOT NULL DEFAULT 50
                               CHECK (confidence_score >= 0 AND confidence_score <= 100),
  status                       text        NOT NULL DEFAULT 'pending'
                               CHECK (status IN (
                                 'pending','approved','rejected','deferred',
                                 'merged','rolled_back'
                               )),
  decided_by                   text,
  decided_at                   timestamptz,
  decision_rationale           text,
  pr_ref                       text,
  merged_system_version_id     uuid,
  deferred_from_proposal_id    uuid,
  created_event_id             uuid        NOT NULL,
  schema_version               integer     NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS retro_proposals_report_idx
  ON retro_proposals (retro_report_id);
CREATE INDEX IF NOT EXISTS retro_proposals_status_idx
  ON retro_proposals (status);
CREATE UNIQUE INDEX IF NOT EXISTS retro_proposals_code_uq
  ON retro_proposals (proposal_code);

-- ============================================================================
-- retro_proposal_layers
-- ============================================================================

CREATE TABLE IF NOT EXISTS retro_proposal_layers (
  retro_proposal_layer_id   uuid        PRIMARY KEY,
  retro_proposal_id         uuid        NOT NULL REFERENCES retro_proposals(retro_proposal_id) ON DELETE CASCADE,
  layer                     text        NOT NULL
                            CHECK (layer IN (
                              'persona','skill','hook','routing','ceremony',
                              'orchestrator','environment','board'
                            )),
  target_path               text        NOT NULL,
  change_type               text        NOT NULL
                            CHECK (change_type IN ('create','modify','delete')),
  diff_preview              text,
  is_dominant               boolean     NOT NULL DEFAULT false,
  schema_version            integer     NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS retro_proposal_layers_proposal_idx
  ON retro_proposal_layers (retro_proposal_id);
CREATE INDEX IF NOT EXISTS retro_proposal_layers_layer_idx
  ON retro_proposal_layers (layer);

-- ============================================================================
-- system_versions
-- ============================================================================

CREATE TABLE IF NOT EXISTS system_versions (
  system_version_id              uuid        PRIMARY KEY,
  version_number                 text        NOT NULL,
  parent_system_version_id       uuid,
  git_tag                        text        NOT NULL,
  git_sha                        text        NOT NULL,
  shipped_at                     timestamptz NOT NULL DEFAULT now(),
  shipped_by                     text        NOT NULL,
  is_rollback                    boolean     NOT NULL DEFAULT false,
  rolled_back_version_id         uuid,
  retro_report_id                uuid,
  notes                          text,
  created_event_id               uuid        NOT NULL,
  schema_version                 integer     NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS system_versions_number_uq
  ON system_versions (version_number);
CREATE UNIQUE INDEX IF NOT EXISTS system_versions_tag_uq
  ON system_versions (git_tag);
CREATE INDEX IF NOT EXISTS system_versions_parent_idx
  ON system_versions (parent_system_version_id);
CREATE INDEX IF NOT EXISTS system_versions_retro_idx
  ON system_versions (retro_report_id);

-- ============================================================================
-- system_version_diffs
-- ============================================================================

CREATE TABLE IF NOT EXISTS system_version_diffs (
  system_version_diff_id    uuid        PRIMARY KEY,
  system_version_id         uuid        NOT NULL REFERENCES system_versions(system_version_id),
  retro_proposal_id         uuid        REFERENCES retro_proposals(retro_proposal_id),
  layer                     text        NOT NULL,
  file_path                 text        NOT NULL,
  change_type               text        NOT NULL
                            CHECK (change_type IN ('added','modified','deleted')),
  unified_diff              text        NOT NULL,
  schema_version            integer     NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS system_version_diffs_version_idx
  ON system_version_diffs (system_version_id);
CREATE INDEX IF NOT EXISTS system_version_diffs_proposal_idx
  ON system_version_diffs (retro_proposal_id);

-- ============================================================================
-- retro_outcomes
-- ============================================================================

CREATE TABLE IF NOT EXISTS retro_outcomes (
  retro_outcome_id           uuid        PRIMARY KEY,
  retro_proposal_id          uuid        NOT NULL REFERENCES retro_proposals(retro_proposal_id),
  system_version_id          uuid        NOT NULL REFERENCES system_versions(system_version_id),
  metric_key                 text        NOT NULL,
  expected_direction         text        NOT NULL,
  expected_pct_points        integer     NOT NULL,
  window_sprint_count        integer     NOT NULL DEFAULT 2,
  window_start_sprint_id     uuid,
  window_end_sprint_id       uuid,
  baseline_value             jsonb,
  actual_pct_points          integer,
  tolerance_band             integer     NOT NULL DEFAULT 500,
  matched_expectation        boolean,
  computed_at                timestamptz,
  recorded_event_id          uuid,
  schema_version             integer     NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS retro_outcomes_proposal_idx
  ON retro_outcomes (retro_proposal_id);
CREATE INDEX IF NOT EXISTS retro_outcomes_version_idx
  ON retro_outcomes (system_version_id);

-- ============================================================================
-- ADDITIVE: sprint_commitments.system_version_id
-- ============================================================================
-- Per Phase 5B brief: extend the Phase 4B-owned sprint_commitments schema with
-- a nullable system_version_id column. No FK; cross-schema reference. No
-- existing column or constraint is altered.

ALTER TABLE sprint_commitments
  ADD COLUMN IF NOT EXISTS system_version_id uuid;

CREATE INDEX IF NOT EXISTS sprint_commitments_system_version_idx
  ON sprint_commitments (system_version_id);
