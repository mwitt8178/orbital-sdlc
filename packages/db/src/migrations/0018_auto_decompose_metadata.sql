-- Migration 0018: auto_generated_metadata — backlog auto-decomposition from VisionLocked.
--
-- Strategy: ADDITIVE.
--   1. ADD COLUMN auto_generated_metadata (nullable jsonb) to epics.
--   2. ADD COLUMN auto_generated_metadata (nullable jsonb) to stories.
--
-- Purpose:
--   When a vision is locked, VisionAutoDecomposeSubscriber inserts starter
--   epics + stories with this column set to:
--     { "source": "vision_lock", "vision_document_id": "<uuid>", "version": <n> }
--   This lets the UI flag auto-generated rows for user review, and lets the
--   subscriber check idempotency without a separate dedupe table.
--
-- Rules:
--   - Nullable: existing rows have NULL (not auto-generated).
--   - Default: NULL (not '{}') so callers can distinguish auto-generated rows
--     from manually-created rows without reading the column value.
--   - IF NOT EXISTS guard makes the migration idempotent.
--   - No FKs, no triggers, no SERIAL per DSQL discipline.
--   - DDL only in this migration (no DML).

--> statement-breakpoint
ALTER TABLE epics
  ADD COLUMN IF NOT EXISTS auto_generated_metadata jsonb;

--> statement-breakpoint
ALTER TABLE stories
  ADD COLUMN IF NOT EXISTS auto_generated_metadata jsonb;
