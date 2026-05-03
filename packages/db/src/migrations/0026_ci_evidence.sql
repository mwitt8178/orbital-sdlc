-- Migration 0026: CI evidence columns on audit.ac_check_evidence.
--
-- Round 6 #6 — CI/CD Bridge
-- [Engineer-Sr · Sonnet · run-round6-06-ci-bridge]
--
-- Strategy: ADDITIVE ONLY per multi-tenant-migrations discipline.
--
-- Context:
--   Migration 0021 created audit.ac_check_evidence with evidence_kind CHECK
--   constraining to ('test_run','static_analysis','llm_inspection','manual_required').
--   This migration:
--     1. Adds ci_run_url, ci_check_name, ci_conclusion columns.
--     2. Drops the old evidence_kind CHECK constraint and re-adds it with 'ci_run'.
--
-- Per DSQL constraints: DDL statements separated by breakpoints, no mixing with DML.

--> statement-breakpoint
ALTER TABLE audit.ac_check_evidence
  ADD COLUMN IF NOT EXISTS ci_run_url    text;

--> statement-breakpoint
ALTER TABLE audit.ac_check_evidence
  ADD COLUMN IF NOT EXISTS ci_check_name text;

--> statement-breakpoint
ALTER TABLE audit.ac_check_evidence
  ADD COLUMN IF NOT EXISTS ci_conclusion text;

--> statement-breakpoint
ALTER TABLE audit.ac_check_evidence
  ADD CONSTRAINT ac_check_evidence_ci_conclusion_check
  CHECK (ci_conclusion IS NULL OR ci_conclusion IN (
    'success','failure','cancelled','skipped','timed_out','neutral','action_required'
  ));

--> statement-breakpoint
ALTER TABLE audit.ac_check_evidence
  DROP CONSTRAINT IF EXISTS ac_check_evidence_evidence_kind_check;

--> statement-breakpoint
ALTER TABLE audit.ac_check_evidence
  ADD CONSTRAINT ac_check_evidence_evidence_kind_check
  CHECK (evidence_kind IN (
    'test_run','static_analysis','llm_inspection','manual_required','ci_run'
  ));
