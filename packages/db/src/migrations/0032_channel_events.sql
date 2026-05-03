-- 0032_channel_events.sql
-- Round 6 #9 — Inter-Agent Channel Collaboration
-- [Engineer-Sr · Sonnet · run-round6-09-channel-collab]
--
-- 1. Adds escalation_count telemetry column to tasks for tracking how many
--    times an agent has raised an escalation on a given task.
-- 2. Extends the channel_posts_post_type_check constraint to include the three
--    new agent collaboration post types:
--      escalation_note  — agent escalates to a senior persona
--      handoff_note     — agent hands off work to a different persona
--      peer_question    — agent asks a peer question in #orb-engineering
--
-- Additive only (multi-tenant-migrations discipline, phase 1 of 4).
-- DDL and DML are in separate statements (DSQL discipline: never mix).

-- Step 1: escalation_count on tasks
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS escalation_count integer NOT NULL DEFAULT 0;

-- Step 2: extend the channel_posts post_type CHECK constraint.
-- There may be multiple copies of the constraint from previous migrations
-- that extended the original set. Drop them all by name and recreate once.
ALTER TABLE channel_posts
  DROP CONSTRAINT IF EXISTS channel_posts_post_type_check;

ALTER TABLE channel_posts
  ADD CONSTRAINT channel_posts_post_type_check CHECK (
    post_type = ANY (ARRAY[
      'status_update',
      'decision',
      'blocker',
      'alert',
      'system_event',
      'cross_post',
      'capability_event',
      'user_guidance',
      'ceremony_agenda',
      'ceremony_statement',
      'ceremony_vote',
      'ceremony_output_link',
      'reply',
      'escalation_note',
      'handoff_note',
      'peer_question'
    ]::text[])
  );
