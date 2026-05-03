-- Migration 0017: ceremony_trigger_firings — dedupe log for the agent-native
-- CeremonyScheduler.
--
-- Strategy: ADDITIVE.
--   1. Create the table (idempotent IF NOT EXISTS).
--   2. Composite PK (rule_id, trigger_event_id) gives natural dedupe semantics:
--      INSERT ... ON CONFLICT DO NOTHING claims the firing slot atomically.
--   3. Optional ceremony_id back-pointer is updated after CeremonyService.schedule()
--      returns; NULL while in-flight.
--
-- DSQL compliance:
--   - No FKs (FK to ceremonies would couple two contexts; rule_id is a free-form
--     application-level identifier).
--   - No triggers, no sequences, no SERIAL.
--   - Composite PK is supported; no UNIQUE constraints required.

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ceremony_trigger_firings (
  rule_id            text        NOT NULL,
  trigger_event_id   uuid        NOT NULL,
  fired_at           timestamptz NOT NULL DEFAULT now(),
  ceremony_id        uuid,
  PRIMARY KEY (rule_id, trigger_event_id)
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS cer_trigger_firings_ceremony_idx
  ON ceremony_trigger_firings (ceremony_id);
