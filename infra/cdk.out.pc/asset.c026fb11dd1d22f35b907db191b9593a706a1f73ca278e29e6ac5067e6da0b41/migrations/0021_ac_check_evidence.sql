-- Migration: 0021_ac_check_evidence
-- Round 5C — Real verifier per-AC evidence.
-- Per architecture.md (Engineer-Principal · run-round5c).
--
-- Tables:
--   audit.ac_check_evidence — one row per AC checked by the verifier.
--
-- Notes:
--   - Idempotent (CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS).
--   - No physical FKs; logical references documented inline (DSQL hard-no list).
--   - No triggers; INSERT-only at the application layer.
--   - The audit schema was created by migration 0001 (events).

-- ============================================================================
-- audit.ac_check_evidence
-- ============================================================================

CREATE TABLE IF NOT EXISTS audit.ac_check_evidence (
  evidence_id      uuid        PRIMARY KEY,
  verification_id  uuid        NOT NULL,                   -- logical FK → verifications.verification_id
  ac_id            uuid        NOT NULL,                   -- logical FK → story_acceptance_criteria.ac_id
  result           text        NOT NULL CHECK (result IN ('pass', 'fail', 'ambiguous')),
  evidence_kind    text        NOT NULL CHECK (
                     evidence_kind IN (
                       'test_run',
                       'static_analysis',
                       'llm_inspection',
                       'manual_required'
                     )
                   ),
  test_command     text,
  test_output      text,
  test_exit_code   integer,
  llm_reasoning    text,
  files_inspected  jsonb       NOT NULL DEFAULT '[]'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ac_check_evidence_ac_idx
  ON audit.ac_check_evidence (ac_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ac_check_evidence_verif_idx
  ON audit.ac_check_evidence (verification_id);
