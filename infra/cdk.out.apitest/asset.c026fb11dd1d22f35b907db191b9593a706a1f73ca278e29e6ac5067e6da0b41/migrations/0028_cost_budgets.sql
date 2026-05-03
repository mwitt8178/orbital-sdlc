-- migration 0028_cost_budgets.sql
-- [Engineer-Sr · Sonnet · run-round6-05-cost-governance]
--
-- Cost governance tables.
-- Adds:
--   cost_budgets  — per-install/project/sprint hard-cap + soft-threshold config
--   cost_ledger   — per-LLM-call cost record with token breakdown + computed cost_usd
--
-- Migration sequence: 0027 (replay_capture) → 0028 (cost_budgets)

CREATE TABLE IF NOT EXISTS cost_budgets (
  budget_id            uuid         PRIMARY KEY,
  scope                text         NOT NULL CHECK (scope IN ('install','project','sprint')),
  scope_id             uuid,                          -- nullable for install-scope (singleton)
  hard_cap_usd         numeric(10,2) NOT NULL,
  soft_threshold_pct   integer      NOT NULL DEFAULT 80 CHECK (soft_threshold_pct BETWEEN 1 AND 100),
  on_soft              text         NOT NULL DEFAULT 'alert' CHECK (on_soft IN ('alert','pause','none')),
  on_hard              text         NOT NULL DEFAULT 'pause' CHECK (on_hard IN ('pause','kill','alert_only')),
  active               boolean      NOT NULL DEFAULT true,
  created_at           timestamptz  NOT NULL DEFAULT now(),
  updated_at           timestamptz  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS cb_scope_idx ON cost_budgets (scope, scope_id);

CREATE TABLE IF NOT EXISTS cost_ledger (
  entry_id             uuid         PRIMARY KEY,
  occurred_at          timestamptz  NOT NULL DEFAULT now(),
  project_id           uuid         NOT NULL,
  sprint_id            uuid,
  task_id              uuid,
  worker_id            uuid,
  persona_id           text,
  model                text         NOT NULL,      -- e.g. 'claude-sonnet-4-6'
  provider             text         NOT NULL,      -- e.g. 'anthropic'
  input_tokens         integer      NOT NULL,
  output_tokens        integer      NOT NULL,
  cache_read_tokens    integer      NOT NULL DEFAULT 0,
  cache_write_tokens   integer      NOT NULL DEFAULT 0,
  cost_usd             numeric(12,6) NOT NULL,     -- computed at write time using pricing.ts
  request_id           text                        -- provider-side id for traceability
);

CREATE INDEX IF NOT EXISTS cl_project_time_idx ON cost_ledger (project_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS cl_sprint_idx       ON cost_ledger (sprint_id,  occurred_at DESC);
CREATE INDEX IF NOT EXISTS cl_task_idx         ON cost_ledger (task_id);
