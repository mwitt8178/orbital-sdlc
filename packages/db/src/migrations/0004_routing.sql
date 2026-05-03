-- Migration: 0004_routing
-- Per TRD-08 §4: routing_decisions, cost_accounting, routing_policies,
-- model_catalog, budget_caps.
-- Idempotent (safe to re-run).

-- ============================================================================
-- model_catalog
-- (Seeded first so routing_decisions can reference it implicitly.)
-- ============================================================================

CREATE TABLE IF NOT EXISTS model_catalog (
  model_id                       text         PRIMARY KEY,
  display_name                   text         NOT NULL,
  capability_tier                text         NOT NULL CHECK (capability_tier IN ('simple', 'default', 'complex')),
  input_cost_micros_per_mtok     bigint       NOT NULL,
  output_cost_micros_per_mtok    bigint       NOT NULL,
  cache_read_cost_micros_per_mtok  bigint     NOT NULL,
  cache_write_cost_micros_per_mtok bigint     NOT NULL,
  latency_p50_ms                 integer      NOT NULL,
  latency_p99_ms                 integer      NOT NULL,
  default_token_budget           integer      NOT NULL,
  enabled                        boolean      NOT NULL DEFAULT true,
  notes                          text
);

-- Seed v1 model catalog per TRD-08 §4.4 and task done-criteria.
-- Rates per SAO §5.7 and task spec:
--   opus:   $15 in  / $75 out  / cache_read 10% of input rate / cache_creation 1.25x input
--   sonnet: $3 in   / $15 out  / cache_read 10% / cache_creation 1.25x
--   haiku:  $0.80 in / $4 out  / cache_read 10% / cache_creation 1.25x
-- Stored in micros per million tokens (1 USD = 1_000_000 micros).

INSERT INTO model_catalog (
  model_id, display_name, capability_tier,
  input_cost_micros_per_mtok,
  output_cost_micros_per_mtok,
  cache_read_cost_micros_per_mtok,
  cache_write_cost_micros_per_mtok,
  latency_p50_ms, latency_p99_ms, default_token_budget,
  notes
) VALUES
  (
    'claude-opus-4-6', 'Claude Opus 4.6', 'complex',
    15000000,   -- $15 / Mtok
    75000000,   -- $75 / Mtok
    1500000,    -- 10% of $15 = $1.50 / Mtok
    18750000,   -- 1.25x of $15 = $18.75 / Mtok
    6000, 30000, 16000, 'High-capability model; use for critical/high risk tasks.'
  ),
  (
    'claude-sonnet-4-6', 'Claude Sonnet 4.6', 'default',
    3000000,    -- $3 / Mtok
    15000000,   -- $15 / Mtok
    300000,     -- 10% of $3 = $0.30 / Mtok
    3750000,    -- 1.25x of $3 = $3.75 / Mtok
    2500, 10000, 8000, 'Default model; balanced quality and cost.'
  ),
  (
    'claude-haiku-4-5', 'Claude Haiku 4.5', 'simple',
    800000,     -- $0.80 / Mtok
    4000000,    -- $4 / Mtok
    80000,      -- 10% of $0.80 = $0.08 / Mtok
    1000000,    -- 1.25x of $0.80 = $1.00 / Mtok
    800, 3000, 4000, 'Fast, cheap; use for low-risk and high-volume tasks.'
  )
ON CONFLICT (model_id) DO NOTHING;

-- ============================================================================
-- routing_policies
-- ============================================================================

CREATE TABLE IF NOT EXISTS routing_policies (
  policy_id         uuid         PRIMARY KEY,
  version           integer      NOT NULL UNIQUE,
  content_hash      text         NOT NULL,
  policy            jsonb        NOT NULL,
  is_active         boolean      NOT NULL DEFAULT false,
  loaded_at         timestamptz  NOT NULL DEFAULT now(),
  loaded_from_path  text         NOT NULL,
  loaded_by_actor   jsonb        NOT NULL,
  justification     text
);

-- ============================================================================
-- routing_decisions
-- ============================================================================

CREATE TABLE IF NOT EXISTS routing_decisions (
  decision_id       uuid         PRIMARY KEY,
  task_id           uuid         NOT NULL,
  session_id        uuid,
  persona_id        text         NOT NULL,
  risk_class        text         NOT NULL,
  retry_depth       integer      NOT NULL DEFAULT 0,
  latency_budget_ms integer,
  model             text         NOT NULL,
  token_budget      integer      NOT NULL,
  escalation_policy jsonb        NOT NULL,
  reason            jsonb        NOT NULL,
  policy_version    integer      NOT NULL,
  decided_at        timestamptz  NOT NULL DEFAULT now(),
  trace_id          text         NOT NULL
);

CREATE INDEX IF NOT EXISTS routing_decisions_task_idx
  ON routing_decisions (task_id);

CREATE INDEX IF NOT EXISTS routing_decisions_session_idx
  ON routing_decisions (session_id);

CREATE INDEX IF NOT EXISTS routing_decisions_decided_at_idx
  ON routing_decisions (decided_at);

-- ============================================================================
-- cost_accounting
-- ============================================================================

CREATE TABLE IF NOT EXISTS cost_accounting (
  cost_id           uuid         PRIMARY KEY,
  task_id           uuid         NOT NULL,
  session_id        uuid         NOT NULL,
  sprint_id         uuid         NOT NULL,
  ticket_id         text,
  model             text         NOT NULL,
  input_tokens      integer      NOT NULL,
  output_tokens     integer      NOT NULL,
  cache_read_tokens integer      NOT NULL DEFAULT 0,
  cache_write_tokens integer     NOT NULL DEFAULT 0,
  cost_usd_micros   bigint       NOT NULL,
  turn_index        integer      NOT NULL,
  reported_at       timestamptz  NOT NULL,
  ingested_at       timestamptz  NOT NULL DEFAULT now(),
  trace_id          text         NOT NULL
);

CREATE INDEX IF NOT EXISTS cost_accounting_task_idx
  ON cost_accounting (task_id);

CREATE INDEX IF NOT EXISTS cost_accounting_sprint_idx
  ON cost_accounting (sprint_id);

CREATE INDEX IF NOT EXISTS cost_accounting_session_idx
  ON cost_accounting (session_id);

CREATE INDEX IF NOT EXISTS cost_accounting_ticket_idx
  ON cost_accounting (ticket_id);

CREATE UNIQUE INDEX IF NOT EXISTS cost_accounting_session_turn_unique
  ON cost_accounting (session_id, turn_index);

-- ============================================================================
-- budget_caps
-- ============================================================================

CREATE TABLE IF NOT EXISTS budget_caps (
  cap_id                 uuid         PRIMARY KEY,
  scope                  text         NOT NULL CHECK (scope IN ('task', 'sprint', 'system')),
  scope_key              text,
  risk_class             text,
  cap_usd_micros         bigint       NOT NULL,
  warning_threshold_pct  integer      NOT NULL DEFAULT 80,
  state                  text         NOT NULL DEFAULT 'active'
                           CHECK (state IN ('active', 'warned', 'exceeded', 'overridden')),
  override_justification text,
  override_actor         jsonb,
  overridden_at          timestamptz,
  created_at             timestamptz  NOT NULL DEFAULT now(),
  updated_at             timestamptz  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS budget_caps_scope_key_idx
  ON budget_caps (scope, scope_key);
