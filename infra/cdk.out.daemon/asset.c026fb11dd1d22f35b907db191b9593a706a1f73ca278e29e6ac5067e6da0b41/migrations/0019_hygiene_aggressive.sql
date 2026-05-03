-- Migration 0019: Aggressive hygiene support columns + epic cancelled status.
--
-- Strategy: ADDITIVE ONLY.
--   1. Extend epics.status CHECK to include 'cancelled'.
--   2. Add channel_posts.hidden_from_ui boolean column (default false).
--   3. Add capability_denials.hidden_from_ui boolean column (default false).
--   4. Indexes on new columns for query performance.
--
-- Rationale:
--   HygieneService v2 transitions:
--     - Test epics → status='cancelled'  (mirrors stories 'cancelled' from 0016)
--     - Old test channel posts → hidden_from_ui=true  (UI filter, not deletion)
--     - Stale capability denials → hidden_from_ui=true (UI filter, not deletion)
--
--   'cancelled' is the correct semantic: the epic had no meaningful work, is
--   not 'archived' (that implies deliberate closure of real work). UI should
--   filter cancelled epics from all planning views.
--
--   hidden_from_ui is a soft tombstone: the audit record is fully preserved in
--   the DB and the events table (immutable), but the UI's default tRPC query
--   excludes them. Operators can opt-in to show hidden rows via a query flag.
--
--   Per multi-tenant-migrations discipline: additive DDL only, no drops.
--   Per TRD-02: text CHECK constraints only; no enum types to migrate.

--> statement-breakpoint
ALTER TABLE epics
  DROP CONSTRAINT IF EXISTS epics_status_check;

--> statement-breakpoint
ALTER TABLE epics
  ADD CONSTRAINT epics_status_check
  CHECK (status IN ('draft', 'active', 'completed', 'archived', 'cancelled'));

--> statement-breakpoint
ALTER TABLE channel_posts
  ADD COLUMN IF NOT EXISTS hidden_from_ui boolean NOT NULL DEFAULT false;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS channel_posts_hidden_idx
  ON channel_posts (hidden_from_ui)
  WHERE hidden_from_ui = true;

--> statement-breakpoint
ALTER TABLE capability_denials
  ADD COLUMN IF NOT EXISTS hidden_from_ui boolean NOT NULL DEFAULT false;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS capability_denials_hidden_idx
  ON capability_denials (hidden_from_ui)
  WHERE hidden_from_ui = true;
