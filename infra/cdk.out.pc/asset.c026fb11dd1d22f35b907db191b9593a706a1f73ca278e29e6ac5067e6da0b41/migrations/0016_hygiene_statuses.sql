-- Migration 0016: Add 'cancelled' to stories.status for hygiene sweep.
--
-- Strategy: ADDITIVE.
--   1. Drop the existing CHECK constraint on stories.status.
--   2. Add a new CHECK constraint that includes 'cancelled'.
--   3. sprints.budget_usd_cents check constraint: no change needed (already > 0).
--
-- Rationale:
--   HygieneService.cleanFixtureStories() transitions fixture/test stories to
--   status='cancelled' so they are suppressed from the production UI without
--   deleting any rows (audit trail preserved).
--
--   The 'cancelled' status is the cleanest semantic fit: the story is no longer
--   active, not "done" (no meaningful work completed), and clearly labelled for
--   operators. It is NOT a normal workflow status that personas or the planner
--   will set, so it does not pollute state-machine logic.
--
--   Per multi-tenant-migrations discipline: additive DDL only.
--   Per TRD-02: text columns accept any value within the CHECK constraint.

--> statement-breakpoint
ALTER TABLE stories
  DROP CONSTRAINT IF EXISTS stories_status_check;

--> statement-breakpoint
ALTER TABLE stories
  ADD CONSTRAINT stories_status_check
  CHECK (status IN (
    'backlog', 'ready', 'in_progress', 'in_review',
    'done', 'accepted', 'blocked', 'defective', 'cancelled'
  ));
