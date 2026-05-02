/**
 * RoutingEngine — selects the optimal LLM model for each task spawn.
 *
 * Per TRD-08 §6 (router function) and Implementation Plan §6 Task 2A.
 *
 * Key properties:
 * - The pure `decide()` function is < 1 ms: no I/O, no DB calls.
 * - Side effects (DB write, event emission) happen in `selectModel()`.
 * - RoutingDecisionMade is written via EventStore.append, never db.insert.
 */

import { uuidv7 } from 'uuidv7'
import type { DB } from '../db/client.js'
import type { EventStore } from '../events/store.js'
import { routingDecisions } from '../db/schema/routing.js'
import type {
  RouterInput,
  RoutingDecision,
  RoutingPolicy,
  ModelCatalog,
  ModelCatalogEntry,
  RoutingReason,
  RoutingReasonRule,
  RouteModelInput,
  RouteModelResult,
  ModelChoice,
} from './types.js'
import type { ModelId } from '../personas/types.js'

// ---------------------------------------------------------------------------
// Model tier ladder
// ---------------------------------------------------------------------------

const TIER_ORDER: Record<string, number> = {
  simple: 0,
  default: 1,
  complex: 2,
}

const TIER_MODELS: Record<string, ModelId> = {
  simple: 'claude-haiku-4-5',
  default: 'claude-sonnet-4-6',
  complex: 'claude-opus-4-6',
}

const MODEL_TIER: Record<ModelId, string> = {
  'claude-haiku-4-5': 'simple',
  'claude-sonnet-4-6': 'default',
  'claude-opus-4-6': 'complex',
}

// ---------------------------------------------------------------------------
// Pure decision function
// ---------------------------------------------------------------------------

/**
 * Pure router function — no I/O, no logging.
 * Per TRD-08 §6.1 and §6.2.
 */
export function decide(
  input: RouterInput,
  policy: RoutingPolicy,
  catalog: ModelCatalog,
  policyVersion: number,
): Omit<RoutingDecision, 'decision_id'> {
  const rulesApplied: RoutingReasonRule[] = []

  // Step 1: base model from persona affinity
  const personaAffinity = policy.persona_affinities.find(
    (a) => a.persona_id === input.persona_id,
  )

  let candidate: ModelId = personaAffinity?.base_model ?? 'claude-sonnet-4-6'
  const baseFromPersona: ModelId = candidate

  if (!personaAffinity) {
    rulesApplied.push({
      rule_type: 'persona_affinity',
      detail: `No affinity for persona '${input.persona_id}'; falling back to sonnet`,
      before_model: candidate,
      after_model: candidate,
    })
  }

  // Step 2: risk class rules
  const riskRule = policy.risk_class_rules.find((r) => r.risk_class === input.risk_class)
  if (riskRule) {
    if (riskRule.pin_model) {
      const before = candidate
      candidate = riskRule.pin_model
      rulesApplied.push({
        rule_type: 'pin_model',
        detail: `risk_class=${input.risk_class} pins model to ${riskRule.pin_model}`,
        before_model: before,
        after_model: candidate,
      })
    } else if (riskRule.min_capability_tier) {
      const minTierOrder = TIER_ORDER[riskRule.min_capability_tier] ?? 0
      const currentTierOrder = TIER_ORDER[MODEL_TIER[candidate] ?? 'simple'] ?? 0
      if (currentTierOrder < minTierOrder) {
        const before = candidate
        candidate = TIER_MODELS[riskRule.min_capability_tier] ?? 'claude-sonnet-4-6'
        rulesApplied.push({
          rule_type: 'risk_class',
          detail: `risk_class=${input.risk_class} floor is ${riskRule.min_capability_tier}; upgraded from ${before}`,
          before_model: before,
          after_model: candidate,
        })
      }
    }
  }

  // Step 3: retry escalation (apply highest matching rule only)
  const retryDepth = input.retry_depth ?? 0
  if (retryDepth > 0) {
    const matchingRules = policy.retry_escalation
      .filter((r) => r.retry_depth <= retryDepth)
      .sort((a, b) => b.retry_depth - a.retry_depth)

    const bestRule = matchingRules[0]
    if (bestRule && bestRule.bump_tiers > 0) {
      const before = candidate
      candidate = bumpTiers(candidate, bestRule.bump_tiers)
      if (before !== candidate) {
        rulesApplied.push({
          rule_type: 'retry_escalation',
          detail: `retry_depth=${retryDepth} matches rule(retry_depth=${bestRule.retry_depth}, bump=${bestRule.bump_tiers}); upgraded from ${before}`,
          before_model: before,
          after_model: candidate,
        })
      }
    }
  }

  // Step 4: latency rules (can downgrade but not below risk floor)
  if (input.latency_budget_ms != null) {
    const catalogEntry = catalog.get(candidate)
    if (catalogEntry && input.latency_budget_ms < catalogEntry.latency_p50_ms) {
      // Find the tightest (smallest threshold) latency rule that still applies.
      // Sort ascending so the first match is the most-specific applicable rule.
      const sortedLatencyRules = [...policy.latency_rules].sort(
        (a, b) => a.if_below_ms - b.if_below_ms,
      )
      const latencyRule = sortedLatencyRules.find(
        (r) => input.latency_budget_ms != null && input.latency_budget_ms < r.if_below_ms,
      )

      if (latencyRule) {
        const preferredByLatency = TIER_MODELS[latencyRule.prefer_tier] ?? 'claude-sonnet-4-6'
        const preferredTierOrder = TIER_ORDER[latencyRule.prefer_tier] ?? 0

        // Compute risk floor
        const riskFloorTier = riskRule?.pin_model
          ? MODEL_TIER[riskRule.pin_model]
          : riskRule?.min_capability_tier ?? 'simple'
        const riskFloorOrder = TIER_ORDER[riskFloorTier ?? 'simple'] ?? 0

        // Only fire if the preferred tier is actually lower than current (downgrade) AND
        // doesn't violate the risk floor.
        const currentTierOrder = TIER_ORDER[MODEL_TIER[candidate] ?? 'simple'] ?? 0
        if (preferredTierOrder < currentTierOrder && preferredTierOrder >= riskFloorOrder) {
          const before = candidate
          candidate = preferredByLatency
          rulesApplied.push({
            rule_type: 'latency',
            detail: `latency_budget=${input.latency_budget_ms}ms < rule(if_below=${latencyRule.if_below_ms}ms); downgraded from ${before}`,
            before_model: before,
            after_model: candidate,
          })
        }
      }
    }
  }

  // Step 5: resolve token budget and escalation policy
  const catalogEntry = catalog.get(candidate)
  const riskClassRule = policy.risk_class_rules.find((r) => r.risk_class === input.risk_class)
  const tokenBudget =
    riskClassRule?.default_token_budget ??
    catalogEntry?.default_token_budget ??
    8000

  const reason: RoutingReason = {
    base_from_persona: baseFromPersona,
    rules_applied: rulesApplied,
  }

  return {
    task_id: input.task_id,
    persona_id: input.persona_id,
    risk_class: input.risk_class,
    retry_depth: retryDepth,
    latency_budget_ms: input.latency_budget_ms,
    model: candidate,
    token_budget: tokenBudget,
    escalation_policy: policy.default_escalation_policy,
    reason,
    policy_version: policyVersion,
  }
}

// ---------------------------------------------------------------------------
// Tier helpers
// ---------------------------------------------------------------------------

function bumpTiers(model: ModelId, tiers: number): ModelId {
  const currentOrder = TIER_ORDER[MODEL_TIER[model] ?? 'simple'] ?? 0
  const targetOrder = Math.min(2, currentOrder + tiers)
  return TIER_MODELS[Object.keys(TIER_ORDER).find((k) => TIER_ORDER[k] === targetOrder) ?? 'complex'] ?? 'claude-opus-4-6'
}

// ---------------------------------------------------------------------------
// RoutingEngine — stateful wrapper that persists decisions and emits events
// ---------------------------------------------------------------------------

export interface RoutingEngine {
  selectModel(input: RouterInput): Promise<RoutingDecision>
  /**
   * Multi-provider model routing.
   * Returns the provider + model to use for the given persona/estimate,
   * honouring the cross-family SoD rule when authorProvider/authorModel
   * are supplied.
   *
   * Per Round 6 #8 spec.
   */
  routeModel(input: RouteModelInput): Promise<RouteModelResult>
}

export class DefaultRoutingEngine implements RoutingEngine {
  constructor(
    private readonly db: DB,
    private readonly eventStore: EventStore,
    private readonly policy: RoutingPolicy,
    private readonly catalog: ModelCatalog,
    private readonly policyVersion: number,
  ) {}

  async selectModel(input: RouterInput): Promise<RoutingDecision> {
    // 1. Pure decision (< 1 ms)
    const decisionCore = decide(input, this.policy, this.catalog, this.policyVersion)
    const decisionId = uuidv7()

    const decision: RoutingDecision = { decision_id: decisionId, ...decisionCore }

    // 2. Persist routing_decisions row + emit event atomically
    await this.db.transaction(async (tx) => {
      await tx.insert(routingDecisions).values({
        decisionId,
        taskId: decision.task_id,
        sessionId: undefined,
        personaId: decision.persona_id,
        riskClass: decision.risk_class,
        retryDepth: decision.retry_depth,
        latencyBudgetMs: decision.latency_budget_ms,
        model: decision.model,
        tokenBudget: decision.token_budget,
        escalationPolicy: decision.escalation_policy as unknown as Record<string, unknown>,
        reason: decision.reason as unknown as Record<string, unknown>,
        policyVersion: decision.policy_version,
        traceId: input.trace_id,
      })
    })

    // 3. Emit RoutingDecisionMade via EventStore (NOT direct db.insert)
    await this.eventStore.append({
      aggregate_id: decision.task_id,
      aggregate_type: 'task',
      event_type: 'RoutingDecisionMade',
      payload: {
        decision_id: decisionId,
        task_id: decision.task_id,
        persona_id: decision.persona_id,
        risk_class: decision.risk_class,
        retry_depth: decision.retry_depth,
        latency_budget_ms: decision.latency_budget_ms,
        model: decision.model,
        token_budget: decision.token_budget,
        escalation_policy: decision.escalation_policy,
        reason: decision.reason,
        policy_version: decision.policy_version,
      },
      actor: { type: 'system', component: 'orchestrator' },
      trace_id: input.trace_id,
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    })

    return decision
  }

  async routeModel(input: RouteModelInput): Promise<RouteModelResult> {
    const key = `${input.persona}:${input.estimate}`
    const candidate: ModelChoice =
      DEFAULT_ROUTING[key] ??
      DEFAULT_ROUTING[`${input.persona}:M`] ??
      { provider: 'anthropic', model: 'claude-sonnet-4-6' }

    let choice = { ...candidate }
    let sodApplied = false
    let reason = `default routing for ${key}`

    // Cross-family SoD rule: when routing for 'reviewer' and the author used
    // an Opus-family model, the reviewer MUST NOT be routed to an Opus model.
    if (
      input.persona === 'reviewer' &&
      input.authorModel &&
      OPUS_MODELS.has(input.authorModel)
    ) {
      if (OPUS_MODELS.has(choice.model)) {
        choice = { ...REVIEWER_SOD_FALLBACK }
        sodApplied = true
        reason = `SoD: author used ${input.authorModel} (Opus); reviewer downgraded to ${choice.model}`
      }
    }

    const traceId = input.traceId ?? uuidv7()

    // Emit ModelRoutingDecided event
    await this.eventStore.append({
      aggregate_id: traceId,
      aggregate_type: 'task',
      event_type: 'ModelRoutingDecided',
      payload: {
        persona: input.persona,
        estimate: input.estimate,
        provider: choice.provider,
        model: choice.model,
        sod_applied: sodApplied,
        reason,
        author_provider: input.authorProvider,
        author_model: input.authorModel,
      },
      actor: { type: 'system', component: 'orchestrator' },
      trace_id: traceId,
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    })

    return { provider: choice.provider, model: choice.model, reason, sodApplied }
  }
}

// ---------------------------------------------------------------------------
// Multi-provider default routing matrix (Round 6 #8)
// ---------------------------------------------------------------------------

/**
 * Default routing matrix: persona × estimate → { provider, model }.
 * Overridable via DB routing_rules table (future).
 */
const DEFAULT_ROUTING: Record<string, ModelChoice> = {
  'jr-dev:S':            { provider: 'anthropic', model: 'claude-haiku-4-5' },
  'jr-dev:M':            { provider: 'anthropic', model: 'claude-haiku-4-5' },
  'sr-dev:M':            { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  'sr-dev:L':            { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  'principal-dev:L':     { provider: 'anthropic', model: 'claude-opus-4-7' },
  'principal-dev:XL':    { provider: 'anthropic', model: 'claude-opus-4-7' },
  'reviewer:M':          { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  'reviewer:L':          { provider: 'anthropic', model: 'claude-opus-4-7' },
  'verifier:S':          { provider: 'anthropic', model: 'claude-haiku-4-5' },
  'verifier:M':          { provider: 'anthropic', model: 'claude-haiku-4-5' },
  'qa:M':                { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  'pm:M':                { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  'pm:L':                { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  'architect:L':         { provider: 'anthropic', model: 'claude-opus-4-7' },
  'scrum-master:S':      { provider: 'anthropic', model: 'claude-haiku-4-5' },
  'scrum-master:M':      { provider: 'anthropic', model: 'claude-haiku-4-5' },
}

/**
 * Opus-family models (cross-family SoD: reviewer must not use these when
 * the author used them).
 */
const OPUS_MODELS = new Set([
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-3-opus-20240229-v1:0',              // Bedrock short form
  'anthropic.claude-3-opus-20240229-v1:0',    // Bedrock full model ID
])

/**
 * Fallback model for reviewer when SoD forces a non-Opus selection.
 */
const REVIEWER_SOD_FALLBACK: ModelChoice = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
}

// ---------------------------------------------------------------------------
// Default model catalog (static, used when DB is not yet seeded)
// ---------------------------------------------------------------------------

export function buildDefaultCatalog(): ModelCatalog {
  const catalog: ModelCatalog = new Map<string, ModelCatalogEntry>()

  const models: ModelCatalogEntry[] = [
    {
      model_id: 'claude-opus-4-6',
      display_name: 'Claude Opus 4.6',
      capability_tier: 'complex',
      input_cost_micros_per_mtok: 15_000_000,
      output_cost_micros_per_mtok: 75_000_000,
      cache_read_cost_micros_per_mtok: 1_500_000,
      cache_write_cost_micros_per_mtok: 18_750_000,
      latency_p50_ms: 6000,
      latency_p99_ms: 30000,
      default_token_budget: 16000,
      enabled: true,
    },
    {
      model_id: 'claude-sonnet-4-6',
      display_name: 'Claude Sonnet 4.6',
      capability_tier: 'default',
      input_cost_micros_per_mtok: 3_000_000,
      output_cost_micros_per_mtok: 15_000_000,
      cache_read_cost_micros_per_mtok: 300_000,
      cache_write_cost_micros_per_mtok: 3_750_000,
      latency_p50_ms: 2500,
      latency_p99_ms: 10000,
      default_token_budget: 8000,
      enabled: true,
    },
    {
      model_id: 'claude-haiku-4-5',
      display_name: 'Claude Haiku 4.5',
      capability_tier: 'simple',
      input_cost_micros_per_mtok: 800_000,
      output_cost_micros_per_mtok: 4_000_000,
      cache_read_cost_micros_per_mtok: 80_000,
      cache_write_cost_micros_per_mtok: 1_000_000,
      latency_p50_ms: 800,
      latency_p99_ms: 3000,
      default_token_budget: 4000,
      enabled: true,
    },
  ]

  for (const m of models) {
    catalog.set(m.model_id, m)
  }

  return catalog
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRoutingEngine(
  db: DB,
  eventStore: EventStore,
  policy: RoutingPolicy,
  catalog: ModelCatalog,
  policyVersion: number,
): RoutingEngine {
  return new DefaultRoutingEngine(db, eventStore, policy, catalog, policyVersion)
}
