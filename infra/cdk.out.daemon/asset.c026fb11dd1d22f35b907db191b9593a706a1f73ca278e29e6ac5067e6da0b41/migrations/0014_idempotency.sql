-- Migration 0014: Idempotency table for tRPC mutations
-- Per Round 3 Security Hardening Gap S5.
-- DDL only — no DML, no FK (DSQL hard-no list compliant).
-- TTL is enforced at read time via expires_at > now(); cleanup is a future ops task.

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS audit.mutation_idempotency (
  idempotency_key  text         NOT NULL,
  route            text         NOT NULL,
  status           text         NOT NULL,
  response_json    jsonb        NOT NULL,
  created_at       timestamptz  NOT NULL DEFAULT now(),
  expires_at       timestamptz  NOT NULL,
  PRIMARY KEY (idempotency_key, route)
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mutation_idempotency_expires_at
  ON audit.mutation_idempotency (expires_at);
