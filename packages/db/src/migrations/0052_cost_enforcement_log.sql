-- migration 0052_cost_enforcement_log.sql
-- [Engineer-Sr · Sonnet · run-cost-guardrails-2026-05-04]
--
-- Cost enforcement audit log.
-- Every pre-flight budget check (allow / block / throttle) is recorded here
-- so operators can audit why a run was blocked and trend enforcement decisions
-- over time.
--
-- Prerequisites: 0028_cost_budgets.sql (cost_budgets, cost_ledger)

DO $$ BEGIN
  CREATE TYPE cost_enforcement_decision AS ENUM ('allow', 'block', 'throttle');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS cost_enforcement_log (
  id                          uuid          PRIMARY KEY,
  tenant_id                   uuid          NOT NULL,
  project_id                  uuid          NOT NULL,
  persona                     text,
  decision                    cost_enforcement_decision NOT NULL,
  budget_cap_usd              numeric(10,2),
  mtd_spend_usd               numeric(12,6) NOT NULL DEFAULT 0,
  would_be_cost_estimate_usd  numeric(12,6) NOT NULL DEFAULT 0,
  reason                      text,
  created_at                  timestamptz   NOT NULL DEFAULT now()
);

-- Indexes for operator queries: "show me all blocks for this tenant/project"
CREATE INDEX IF NOT EXISTS cel_tenant_project_idx
  ON cost_enforcement_log (tenant_id, project_id, created_at DESC);

-- Index for decision filtering: "show me all blocks in the last 7 days"
CREATE INDEX IF NOT EXISTS cel_decision_idx
  ON cost_enforcement_log (decision, created_at DESC);
