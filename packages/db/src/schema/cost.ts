/**
 * db/schema/cost.ts — Drizzle schema for cost governance tables.
 *
 * [Engineer-Sr · Sonnet · run-round6-05-cost-governance]
 * [Engineer-Sr · Sonnet · run-cost-guardrails-2026-05-04] — added cost_enforcement_log
 *
 * Tables:
 *   - cost_budgets          — per-install/project/sprint budget configuration
 *   - cost_ledger           — per-LLM-call cost record with token breakdown
 *   - cost_enforcement_log  — audit log of every pre-flight budget decision
 */

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  numeric,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

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

// ---------------------------------------------------------------------------
// cost_enforcement_decision ENUM
// ---------------------------------------------------------------------------

export const costEnforcementDecisionEnum = pgEnum('cost_enforcement_decision', [
  'allow',
  'block',
  'throttle',
])

// ---------------------------------------------------------------------------
// cost_enforcement_log
// ---------------------------------------------------------------------------

/**
 * Audit log of every pre-flight budget decision.
 * A row is written for every assertBudget() call regardless of outcome.
 * Operators can query this to understand why a run was blocked.
 */
export const costEnforcementLog = pgTable(
  'cost_enforcement_log',
  {
    id:                       uuid('id').primaryKey(),
    tenantId:                 uuid('tenant_id').notNull(),
    projectId:                uuid('project_id').notNull(),
    persona:                  text('persona'),
    decision:                 costEnforcementDecisionEnum('decision').notNull(),
    budgetCapUsd:             numeric('budget_cap_usd', { precision: 10, scale: 2 }),
    mtdSpendUsd:              numeric('mtd_spend_usd', { precision: 12, scale: 6 }).notNull().default('0'),
    wouldBeCostEstimateUsd:   numeric('would_be_cost_estimate_usd', { precision: 12, scale: 6 }).notNull().default('0'),
    reason:                   text('reason'),
    createdAt:                timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantProjectIdx: index('cel_tenant_project_idx').on(t.tenantId, t.projectId, t.createdAt),
    decisionIdx:      index('cel_decision_idx').on(t.decision, t.createdAt),
  }),
)

export type CostEnforcementLogRow = typeof costEnforcementLog.$inferSelect
export type NewCostEnforcementLog  = typeof costEnforcementLog.$inferInsert
