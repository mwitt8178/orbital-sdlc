-- Migration 0024: provider_health + routing_rules
-- Round 6 #8 — Multi-Model Routing + Provider Fallback

-- ---------------------------------------------------------------------------
-- provider_health
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS provider_health (
  provider_id          text        NOT NULL PRIMARY KEY,
  healthy              boolean     NOT NULL DEFAULT true,
  consecutive_failures integer     NOT NULL DEFAULT 0,
  circuit_state        text        NOT NULL DEFAULT 'closed'
                         CHECK (circuit_state IN ('closed', 'open', 'half-open')),
  last_success_at      timestamptz,
  last_failure_at      timestamptz,
  last_checked_at      timestamptz NOT NULL DEFAULT now(),
  latency_p50_ms       integer,
  metadata             jsonb       NOT NULL DEFAULT '{}'
);

-- Seed known providers so the UI can display them even before any health check runs.
INSERT INTO provider_health (provider_id, healthy, circuit_state)
VALUES
  ('anthropic', true,  'closed'),
  ('openai',    false, 'closed'),
  ('bedrock',   false, 'closed')
ON CONFLICT (provider_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- routing_rules
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS routing_rules (
  rule_id              uuid        NOT NULL PRIMARY KEY,
  persona              text        NOT NULL,
  estimate             text        NOT NULL CHECK (estimate IN ('S', 'M', 'L', 'XL')),
  primary_provider     text        NOT NULL,
  primary_model        text        NOT NULL,
  fallback1_provider   text,
  fallback1_model      text,
  fallback2_provider   text,
  fallback2_model      text,
  updated_by           jsonb       NOT NULL DEFAULT '{}',
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS routing_rules_persona_estimate_unique
  ON routing_rules (persona, estimate);
