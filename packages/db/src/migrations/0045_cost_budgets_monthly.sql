-- 0045_cost_budgets_monthly.sql
-- Add monthly cap, hard-stop toggle, and digest email subscribers
-- to cost_budgets. Additive only; safe to apply against DSQL or local Postgres.
--
-- [Engineer-Principal · Opus · run-settings-billing]

ALTER TABLE cost_budgets
  ADD COLUMN IF NOT EXISTS monthly_cap_usd numeric(10,2);

ALTER TABLE cost_budgets
  ADD COLUMN IF NOT EXISTS hard_stop boolean NOT NULL DEFAULT false;

ALTER TABLE cost_budgets
  ADD COLUMN IF NOT EXISTS digest_emails text[] NOT NULL DEFAULT '{}';
