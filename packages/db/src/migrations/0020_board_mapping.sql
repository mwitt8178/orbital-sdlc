-- Migration 0020: Board discovery + mapping (Round 5 Monday adaptive integration)
-- Per Round 5 spec: learn each project's existing Monday process instead of
-- pushing a fixed canonical schema.
--
-- Strategy: ADDITIVE only.
--   1. CREATE TABLE board_schemas (one row per Monday board).
--   2. CREATE TABLE board_mappings (canonical-to-board mapping per project).
--   3. CREATE INDEX for project lookups.
--
-- Design decisions:
--   - mapping_json is jsonb so the BoardMapping interface can evolve while we
--     learn what real boards look like. schema_version is bumped when the
--     in-app shape changes.
--   - No FK from board_mappings.project_id → projects.project_id per TRD-01
--     §4.5 cross-context nullable uuid convention (and DSQL-no-FK rule).
--   - schema_version defaults to 1; readers must tolerate older versions per
--     forward-compatibility discipline.

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS board_schemas (
  board_id           text          PRIMARY KEY,
  schema_json        jsonb         NOT NULL,
  monday_api_version text,
  discovered_at      timestamptz   NOT NULL DEFAULT now(),
  schema_version     integer       NOT NULL DEFAULT 1
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS board_mappings (
  mapping_id      uuid          PRIMARY KEY,
  project_id      uuid          NOT NULL,
  board_id        text          NOT NULL,
  mapping_json    jsonb         NOT NULL,
  proposed_at     timestamptz   NOT NULL DEFAULT now(),
  confirmed_at    timestamptz,
  confirmed_by    text,
  schema_version  integer       NOT NULL DEFAULT 1
);

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS board_mappings_project_board_uq
  ON board_mappings (project_id, board_id);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS board_mappings_project_idx
  ON board_mappings (project_id);
