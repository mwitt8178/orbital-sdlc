/**
 * Drizzle schema for routing and cost-accounting tables.
 *
 * Per TRD-08 §4 — routing_decisions, cost_accounting, routing_policies,
 * model_catalog, budget_caps.
 *
 * Cost is stored in micros (1 USD = 1_000_000 micros) as bigint to avoid
 * float drift.
 */

import {
  pgTable,
  uuid,
  text,
  jsonb,
  integer,
  boolean,
  timestamp,
  bigint,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

// ---------------------------------------------------------------------------
// routing_decisions
// ---------------------------------------------------------------------------

export const routingDecisions = pgTable(
  'routing_decisions',
  {
    decisionId: uuid('decision_id').primaryKey(),
    taskId: uuid('task_id').notNull(),
    sessionId: uuid('session_id'),
    personaId: text('persona_id').notNull(),
    riskClass: text('risk_class').notNull(),
    retryDepth: integer('retry_depth').notNull().default(0),
    latencyBudgetMs: integer('latency_budget_ms'),
    model: text('model').notNull(),
    tokenBudget: integer('token_budget').notNull(),
    escalationPolicy: jsonb('escalation_policy').notNull(),
    reason: jsonb('reason').notNull(),
    policyVersion: integer('policy_version').notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    traceId: text('trace_id').notNull(),
  },
  (t) => ({
    taskIdx: index('routing_decisions_task_idx').on(t.taskId),
    sessionIdx: index('routing_decisions_session_idx').on(t.sessionId),
    decidedAtIdx: index('routing_decisions_decided_at_idx').on(t.decidedAt),
  }),
)

// ---------------------------------------------------------------------------
// cost_accounting
// ---------------------------------------------------------------------------

export const costAccounting = pgTable(
  'cost_accounting',
  {
    costId: uuid('cost_id').primaryKey(),
    taskId: uuid('task_id').notNull(),
    sessionId: uuid('session_id').notNull(),
    sprintId: uuid('sprint_id').notNull(),
    ticketId: text('ticket_id'),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    costUsdMicros: bigint('cost_usd_micros', { mode: 'number' }).notNull(),
    turnIndex: integer('turn_index').notNull(),
    reportedAt: timestamp('reported_at', { withTimezone: true, mode: 'string' }).notNull(),
    ingestedAt: timestamp('ingested_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    traceId: text('trace_id').notNull(),
  },
  (t) => ({
    taskIdx: index('cost_accounting_task_idx').on(t.taskId),
    sprintIdx: index('cost_accounting_sprint_idx').on(t.sprintId),
    sessionIdx: index('cost_accounting_session_idx').on(t.sessionId),
    ticketIdx: index('cost_accounting_ticket_idx').on(t.ticketId),
    sessionTurnUnique: uniqueIndex('cost_accounting_session_turn_unique').on(
      t.sessionId,
      t.turnIndex,
    ),
  }),
)

// ---------------------------------------------------------------------------
// routing_policies
// ---------------------------------------------------------------------------

export const routingPolicies = pgTable('routing_policies', {
  policyId: uuid('policy_id').primaryKey(),
  version: integer('version').notNull().unique(),
  contentHash: text('content_hash').notNull(),
  policy: jsonb('policy').notNull(),
  isActive: boolean('is_active').notNull().default(false),
  loadedAt: timestamp('loaded_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  loadedFromPath: text('loaded_from_path').notNull(),
  loadedByActor: jsonb('loaded_by_actor').notNull(),
  justification: text('justification'),
})

// ---------------------------------------------------------------------------
// model_catalog
// ---------------------------------------------------------------------------

export const modelCatalog = pgTable('model_catalog', {
  modelId: text('model_id').primaryKey(),
  displayName: text('display_name').notNull(),
  capabilityTier: text('capability_tier').notNull(),
  inputCostMicrosPerMtok: bigint('input_cost_micros_per_mtok', { mode: 'number' }).notNull(),
  outputCostMicrosPerMtok: bigint('output_cost_micros_per_mtok', { mode: 'number' }).notNull(),
  cacheReadCostMicrosPerMtok: bigint('cache_read_cost_micros_per_mtok', { mode: 'number' }).notNull(),
  cacheWriteCostMicrosPerMtok: bigint('cache_write_cost_micros_per_mtok', { mode: 'number' }).notNull(),
  latencyP50Ms: integer('latency_p50_ms').notNull(),
  latencyP99Ms: integer('latency_p99_ms').notNull(),
  defaultTokenBudget: integer('default_token_budget').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  notes: text('notes'),
})

// ---------------------------------------------------------------------------
// budget_caps
// ---------------------------------------------------------------------------

export const budgetCaps = pgTable(
  'budget_caps',
  {
    capId: uuid('cap_id').primaryKey(),
    scope: text('scope').notNull().$type<'task' | 'sprint' | 'system'>(),
    scopeKey: text('scope_key'),
    riskClass: text('risk_class'),
    capUsdMicros: bigint('cap_usd_micros', { mode: 'number' }).notNull(),
    warningThresholdPct: integer('warning_threshold_pct').notNull().default(80),
    state: text('state').notNull().default('active').$type<'active' | 'warned' | 'exceeded' | 'overridden'>(),
    overrideJustification: text('override_justification'),
    overrideActor: jsonb('override_actor'),
    overriddenAt: timestamp('overridden_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => ({
    scopeKeyIdx: uniqueIndex('budget_caps_scope_key_idx').on(t.scope, t.scopeKey),
  }),
)

// ---------------------------------------------------------------------------
// provider_health (Round 6 #8)
// ---------------------------------------------------------------------------

/**
 * Persisted health snapshot per provider. Updated by the circuit-breaker on
 * success/failure. Used by the fallback driver to make initial routing
 * decisions across process restarts.
 */
export const providerHealth = pgTable(
  'provider_health',
  {
    providerId: text('provider_id').primaryKey(),
    healthy: boolean('healthy').notNull().default(true),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    circuitState: text('circuit_state').notNull().default('closed').$type<'closed' | 'open' | 'half-open'>(),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true, mode: 'string' }),
    lastFailureAt: timestamp('last_failure_at', { withTimezone: true, mode: 'string' }),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    latencyP50Ms: integer('latency_p50_ms'),
    metadata: jsonb('metadata').default({}),
  },
)

// ---------------------------------------------------------------------------
// routing_rules (Round 6 #8)
// ---------------------------------------------------------------------------

/**
 * Per-persona per-estimate routing rule. Overrides the in-memory DEFAULT_ROUTING
 * matrix when present. Managed via Settings → Models tab.
 */
export const routingRules = pgTable(
  'routing_rules',
  {
    ruleId: uuid('rule_id').primaryKey(),
    persona: text('persona').notNull(),
    estimate: text('estimate').notNull().$type<'S' | 'M' | 'L' | 'XL'>(),
    /** Primary provider + model. */
    primaryProvider: text('primary_provider').notNull(),
    primaryModel: text('primary_model').notNull(),
    /** Optional first fallback. */
    fallback1Provider: text('fallback1_provider'),
    fallback1Model: text('fallback1_model'),
    /** Optional second fallback. */
    fallback2Provider: text('fallback2_provider'),
    fallback2Model: text('fallback2_model'),
    /** Actor who last saved this rule. */
    updatedBy: jsonb('updated_by').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => ({
    personaEstimateUnique: uniqueIndex('routing_rules_persona_estimate_unique').on(t.persona, t.estimate),
  }),
)

// ---------------------------------------------------------------------------
// Type inference helpers
// ---------------------------------------------------------------------------

export type RoutingDecisionRow = typeof routingDecisions.$inferSelect
export type CostAccountingRow = typeof costAccounting.$inferSelect
export type RoutingPolicyRow = typeof routingPolicies.$inferSelect
export type ModelCatalogRow = typeof modelCatalog.$inferSelect
export type BudgetCapRow = typeof budgetCaps.$inferSelect
export type ProviderHealthRow = typeof providerHealth.$inferSelect
export type RoutingRuleRow = typeof routingRules.$inferSelect
