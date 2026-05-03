-- 0031_defect_nullable_session.sql
--
-- Round 6 #3 — Iterate-on-Defect Loop in UAT
-- [Engineer-Sr · Sonnet · run-round6-03-defect-iteration]
--
-- Make defects.uat_session_id nullable so that operator-reported defects
-- (submitted via the UAT UI without a formal session) can be inserted without
-- violating the FK constraint. Existing rows are unaffected (all have a
-- non-null session_id). New operator-reported defects will have NULL here.
--
-- Similarly make defects.ac_result_id nullable for operator-reported defects
-- that do not originate from a formal AC result row.
--
-- Additive: no existing data is changed, only the NOT NULL constraint is lifted.

ALTER TABLE defects
  ALTER COLUMN uat_session_id DROP NOT NULL,
  ALTER COLUMN ac_result_id   DROP NOT NULL;
