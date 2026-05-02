/**
 * Routing types — Zod schemas and TypeScript types for the routing engine,
 * cost accounting, and budget management.
 *
 * Per TRD-08 §5 (policy schema) and §8 (event schemas).
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Re-export shared enums
// ---------------------------------------------------------------------------

export { RiskClassSchema, ModelIdSchema } from '../personas/types.js'
export type { RiskClass, ModelId } from '../personas/types.js'

// ---------------------------------------------------------------------------
// Model catalog
// ---------------------------------------------------------------------------

export const ModelCatalogEntrySchema = z.object({
  model_id: z.enum(['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-6']),
  display_name: z.string(),
  capability_tier: z.enum(['simple', 'default', 'complex']),
  input_cost_micros_per_mtok: z.number().int().nonnegative(),
  output_cost_micros_per_mtok: z.number().int().nonnegative(),
  cache_read_cost_micros_per_mtok: z.number().int().nonnegative(),
  cache_write_cost_micros_per_mtok: z.number().int().nonnegative(),
  latency_p50_ms: z.number().int().positive(),
  latency_p99_ms: z.number().int().positive(),
  default_token_budget: z.number().int().positive(),
  enabled: z.boolean(),
})
export type ModelCatalogEntry = z.infer<typeof ModelCatalogEntrySchema>

export type ModelCatalog = Map<string, ModelCatalogEntry>

// ---------------------------------------------------------------------------
// Routing policy
// ---------------------------------------------------------------------------

export const EscalationPolicyRoutingSchema = z.object({
  on_failure: z.enum(['retry_same', 'escalate_one_tier', 'escalate_to_opus', 'no_retry']),
  max_retries: z.number().int().min(0).max(5),
  escalate_after: z.number().int().min(0).max(5),
})
export type EscalationPolicyRouting = z.infer<typeof EscalationPolicyRoutingSchema>

export const PersonaAffinitySchema = z.object({
  persona_id: z.string(),
  base_model: z.enum(['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-6']),
  rationale: z.string(),
})
export type PersonaAffinity = z.infer<typeof PersonaAffinitySchema>

export const RiskClassRuleSchema = z.object({
  risk_class: z.enum(['low', 'standard', 'high', 'critical']),
  min_capability_tier: z.enum(['simple', 'default', 'complex']),
  pin_model: z.enum(['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-6']).optional(),
  default_token_budget: z.number().int().positive().optional(),
})
export type RiskClassRule = z.infer<typeof RiskClassRuleSchema>

export const RetryEscalationRuleSchema = z.object({
  retry_depth: z.number().int().min(1),
  bump_tiers: z.number().int().min(0).max(2),
})
export type RetryEscalationRule = z.infer<typeof RetryEscalationRuleSchema>

export const LatencyRuleSchema = z.object({
  if_below_ms: z.number().int().positive(),
  prefer_tier: z.enum(['simple', 'default']),
})
export type LatencyRule = z.infer<typeof LatencyRuleSchema>

export const RoutingPolicySchema = z.object({
  schema_version: z.literal(1),
  description: z.string(),
  persona_affinities: z.array(PersonaAffinitySchema),
  risk_class_rules: z.array(RiskClassRuleSchema),
  retry_escalation: z.array(RetryEscalationRuleSchema),
  latency_rules: z.array(LatencyRuleSchema),
  default_escalation_policy: EscalationPolicyRoutingSchema,
  default_task_caps_usd_micros: z.record(z.enum(['low', 'standard', 'high', 'critical']), z.number().int().positive()),
})
export type RoutingPolicy = z.infer<typeof RoutingPolicySchema>

// ---------------------------------------------------------------------------
// Routing decision
// ---------------------------------------------------------------------------

export const RoutingReasonRuleSchema = z.object({
  rule_type: z.enum(['risk_class', 'retry_escalation', 'latency', 'pin_model', 'persona_affinity']),
  detail: z.string(),
  before_model: z.enum(['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-6']),
  after_model: z.enum(['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-6']),
})
export type RoutingReasonRule = z.infer<typeof RoutingReasonRuleSchema>

export const RoutingReasonSchema = z.object({
  base_from_persona: z.enum(['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-6']),
  rules_applied: z.array(RoutingReasonRuleSchema),
})
export type RoutingReason = z.infer<typeof RoutingReasonSchema>

export const RoutingDecisionSchema = z.object({
  decision_id: z.string(),
  task_id: z.string(),
  persona_id: z.string(),
  risk_class: z.enum(['low', 'standard', 'high', 'critical']),
  retry_depth: z.number().int().min(0),
  latency_budget_ms: z.number().int().positive().optional(),
  model: z.enum(['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-6']),
  token_budget: z.number().int().positive(),
  escalation_policy: EscalationPolicyRoutingSchema,
  reason: RoutingReasonSchema,
  policy_version: z.number().int().positive(),
})
export type RoutingDecision = z.infer<typeof RoutingDecisionSchema>

// ---------------------------------------------------------------------------
// Router input
// ---------------------------------------------------------------------------

export const RouterInputSchema = z.object({
  task_id: z.string(),
  persona_id: z.string(),
  risk_class: z.enum(['low', 'standard', 'high', 'critical']),
  retry_depth: z.number().int().min(0).default(0),
  latency_budget_ms: z.number().int().positive().optional(),
  trace_id: z.string(),
})
export type RouterInput = z.infer<typeof RouterInputSchema>

// ---------------------------------------------------------------------------
// Anthropic usage (from SDK response.usage)
// ---------------------------------------------------------------------------

export const AnthropicUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_read_input_tokens: z.number().int().nonnegative().default(0),
  cache_creation_input_tokens: z.number().int().nonnegative().default(0),
})
export type AnthropicUsage = z.infer<typeof AnthropicUsageSchema>

// ---------------------------------------------------------------------------
// Cost summary
// ---------------------------------------------------------------------------

export interface CostSummary {
  total_usd_micros: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  turn_count: number
}

// ---------------------------------------------------------------------------
// Budget cap state
// ---------------------------------------------------------------------------

export type BudgetState = 'ok' | 'warned' | 'exceeded'

// ---------------------------------------------------------------------------
// Multi-provider routing (Round 6 #8)
// ---------------------------------------------------------------------------

export const ModelChoiceSchema = z.object({
  provider: z.string(),
  model: z.string(),
})
export type ModelChoice = z.infer<typeof ModelChoiceSchema>

export const ProviderHealthSchema = z.object({
  healthy: z.boolean(),
  providerId: z.string(),
  latencyMs: z.number().int().nonnegative().optional(),
  lastCheckedAt: z.string().datetime(),
  reason: z.string().optional(),
})
export type ProviderHealth = z.infer<typeof ProviderHealthSchema>

/**
 * Input for routeModel() — the new multi-provider routing method.
 */
export const RouteModelInputSchema = z.object({
  persona: z.string(),
  /** Task size estimate (S / M / L / XL). */
  estimate: z.enum(['S', 'M', 'L', 'XL']),
  /**
   * When the author of the content being reviewed used this provider+model,
   * the cross-family SoD rule kicks in: reviewer must be routed to a different
   * family.
   */
  authorProvider: z.string().optional(),
  authorModel: z.string().optional(),
  traceId: z.string().optional(),
})
export type RouteModelInput = z.infer<typeof RouteModelInputSchema>

export const RouteModelResultSchema = z.object({
  provider: z.string(),
  model: z.string(),
  /** Human-readable reason for the decision. */
  reason: z.string(),
  /** Whether the SoD cross-family rule was applied. */
  sodApplied: z.boolean(),
})
export type RouteModelResult = z.infer<typeof RouteModelResultSchema>
