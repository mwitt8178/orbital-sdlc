/**
 * board-mapping.ts — Drizzle schema for Round 5 board discovery + mapping.
 *
 * Per Round 5 Monday Board Discovery spec.
 *
 * The integration goal is to learn from each project's existing Monday board
 * shape, instead of pushing a fixed canonical schema. Two new tables:
 *
 *   - board_schemas — the introspected shape of a Monday board. Keyed on
 *     board_id; one row per board. Updated on every discover() call.
 *   - board_mappings — the canonical-to-board mapping a user (or LLM) has
 *     proposed/confirmed for a project. Keyed on (project_id, board_id) with
 *     unique index. confirmed_at IS NOT NULL means the personas should use
 *     this mapping; rows with confirmed_at IS NULL are pending proposals.
 *
 * No FKs — cross-context references (project_id) follow the TRD-01 §4.5
 * nullable uuid convention. No triggers, sequences, materialized views — all
 * DSQL-portable.
 *
 * The mapping_json blob is the BoardMapping shape from board-mapping.ts. We
 * store it as jsonb for flexibility while the API is iterated; once the
 * schema_version is locked, columns can be promoted to first-class fields.
 */

import { pgTable, uuid, text, jsonb, timestamp, integer, index, uniqueIndex } from 'drizzle-orm/pg-core'

// ---------------------------------------------------------------------------
// board_schemas — discovered Monday board structure
// ---------------------------------------------------------------------------

export const boardSchemas = pgTable(
  'board_schemas',
  {
    /** Monday board id (string per Monday API). */
    boardId: text('board_id').primaryKey(),
    /** Full BoardSchema as JSON; see board-discovery.ts for shape. */
    schemaJson: jsonb('schema_json').notNull(),
    /** Monday GraphQL API version that produced this schema (e.g. 2024-01). */
    mondayApiVersion: text('monday_api_version'),
    discoveredAt: timestamp('discovered_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    schemaVersion: integer('schema_version').notNull().default(1),
  },
)

export type BoardSchemaRow = typeof boardSchemas.$inferSelect
export type BoardSchemaInsert = typeof boardSchemas.$inferInsert

// ---------------------------------------------------------------------------
// board_mappings — canonical-to-board mapping per project
// ---------------------------------------------------------------------------

export const boardMappings = pgTable(
  'board_mappings',
  {
    mappingId: uuid('mapping_id').primaryKey(),
    /** Logical FK to projects.project_id. */
    projectId: uuid('project_id').notNull(),
    /** Monday board id (matches projects.monday_board_id). */
    boardId: text('board_id').notNull(),
    /** Full BoardMapping as JSON; see board-mapping.ts for shape. */
    mappingJson: jsonb('mapping_json').notNull(),
    /**
     * When the mapping was first proposed (heuristic or LLM). Always set on
     * insert.
     */
    proposedAt: timestamp('proposed_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    /**
     * When a user (or system) confirmed the mapping. Only confirmed mappings
     * are honored by the BoardMappingResolver. NULL = pending proposal.
     */
    confirmedAt: timestamp('confirmed_at', { withTimezone: true, mode: 'date' }),
    /** Free-form actor description (user email, system, etc.). */
    confirmedBy: text('confirmed_by'),
    schemaVersion: integer('schema_version').notNull().default(1),
  },
  (t) => ({
    projectBoardUq: uniqueIndex('board_mappings_project_board_uq').on(
      t.projectId,
      t.boardId,
    ),
    byProject: index('board_mappings_project_idx').on(t.projectId),
  }),
)

export type BoardMappingRow = typeof boardMappings.$inferSelect
export type BoardMappingInsert = typeof boardMappings.$inferInsert
