/**
 * db/schema/cost.ts — Drizzle schema for cost governance tables.
 *
 * [Engineer-Sr · Sonnet · run-round6-05-cost-governance]
 *
 * Tables:
 *   - cost_budgets   — per-install/project/sprint budget configuration
 *   - cost_ledger    — per-LLM-call cost record with token breakdown
 */

import {
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

// ---------------------------------------------------------------------------
// cost_budgets
// ---------------------------------------------------------------------------

export const costBudgets = pgTable(
  'cost_budgets',
  {
    budgetId:          uuid('budget_id').primaryKey(),
    scope:             text('scope').notNull(),
    scopeId:           uuid('scope_id'),
    hardCapUsd:        numeric('hard_cap_usd', { precision: 10, scale: 2 }).notNull(),
    softThresholdPct:  integer('soft_threshold_pct').notNull().default(80),
    onSoft:            text('on_soft').notNull().default('alert'),
    onHard:            text('on_hard').notNull().default('pause'),
    /**
     * Migration 0045: monthly cap (separate from per-sprint hardCapUsd).
     * NULL means no monthly cap configured.
     */
    monthlyCapUsd:     numeric('monthly_cap_usd', { precision: 10, scale: 2 }),
    /**
     * Migration 0045: when hardStop = true, agents PAUSE on any cap breach
     * (sprint, week, month). When false, the cap is advisory and only WARNS.
     * Distinct from onHard (which only governs the existing per-sprint hardCapUsd).
     */
    hardStop:          boolean('hard_stop').notNull().default(false),
    /**
     * Migration 0045: list of email addresses opted in to daily/weekly digest.
     * Empty array means no digest subscribers.
     */
    digestEmails:      text('digest_emails').array().notNull().default(sql`'{}'::text[]`),
    active:            boolean('active').notNull().default(true),
    createdAt:         timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt:         timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    scopeIdx: uniqueIndex('cb_scope_idx').on(t.scope, t.scopeId),
  }),
)

// ---------------------------------------------------------------------------
// cost_ledger
// ---------------------------------------------------------------------------

export const costLedger = pgTable(
  'cost_ledger',
  {
    entryId:           uuid('entry_id').primaryKey(),
    occurredAt:        timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    projectId:         uuid('project_id').notNull(),
    sprintId:          uuid('sprint_id'),
    taskId:            uuid('task_id'),
    workerId:          uuid('worker_id'),
    personaId:         text('persona_id'),
    model:             text('model').notNull(),
    provider:          text('provider').notNull(),
    inputTokens:       integer('input_tokens').notNull(),
    outputTokens:      integer('output_tokens').notNull(),
    cacheReadTokens:   integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens:  integer('cache_write_tokens').notNull().default(0),
    costUsd:           numeric('cost_usd', { precision: 12, scale: 6 }).notNull(),
    requestId:         text('request_id'),
  },
  (t) => ({
    projectTimeIdx: index('cl_project_time_idx').on(t.projectId, t.occurredAt),
    sprintIdx:      index('cl_sprint_idx').on(t.sprintId, t.occurredAt),
    taskIdx:        index('cl_task_idx').on(t.taskId),
  }),
)

export type CostBudgetRow = typeof costBudgets.$inferSelect
export type NewCostBudget  = typeof costBudgets.$inferInsert
export type CostLedgerRow  = typeof costLedger.$inferSelect
export type NewCostLedger  = typeof costLedger.$inferInsert
