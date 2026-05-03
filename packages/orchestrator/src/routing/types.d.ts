/**
 * Routing types — Zod schemas and TypeScript types for the routing engine,
 * cost accounting, and budget management.
 *
 * Per TRD-08 §5 (policy schema) and §8 (event schemas).
 */
import { z } from 'zod';
export { RiskClassSchema, ModelIdSchema } from '../personas/types.js';
export type { RiskClass, ModelId } from '../personas/types.js';
export declare const ModelCatalogEntrySchema: z.ZodObject<{
    model_id: z.ZodEnum<["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-6"]>;
    display_name: z.ZodString;
    capability_tier: z.ZodEnum<["simple", "default", "complex"]>;
    input_cost_micros_per_mtok: z.ZodNumber;
    output_cost_micros_per_mtok: z.ZodNumber;
    cache_read_cost_micros_per_mtok: z.ZodNumber;
    cache_write_cost_micros_per_mtok: z.ZodNumber;
    latency_p50_ms: z.ZodNumber;
    latency_p99_ms: z.ZodNumber;
    default_token_budget: z.ZodNumber;
    enabled: z.ZodBoolean;
}, "strip", z.ZodTypeAny, {
    model_id: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
    display_name: string;
    capability_tier: "default" | "simple" | "complex";
    input_cost_micros_per_mtok: number;
    output_cost_micros_per_mtok: number;
    cache_read_cost_micros_per_mtok: number;
    cache_write_cost_micros_per_mtok: number;
    latency_p50_ms: number;
    latency_p99_ms: number;
    default_token_budget: number;
    enabled: boolean;
}, {
    model_id: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
    display_name: string;
    capability_tier: "default" | "simple" | "complex";
    input_cost_micros_per_mtok: number;
    output_cost_micros_per_mtok: number;
    cache_read_cost_micros_per_mtok: number;
    cache_write_cost_micros_per_mtok: number;
    latency_p50_ms: number;
    latency_p99_ms: number;
    default_token_budget: number;
    enabled: boolean;
}>;
export type ModelCatalogEntry = z.infer<typeof ModelCatalogEntrySchema>;
export type ModelCatalog = Map<string, ModelCatalogEntry>;
export declare const EscalationPolicyRoutingSchema: z.ZodObject<{
    on_failure: z.ZodEnum<["retry_same", "escalate_one_tier", "escalate_to_opus", "no_retry"]>;
    max_retries: z.ZodNumber;
    escalate_after: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    on_failure: "retry_same" | "escalate_one_tier" | "escalate_to_opus" | "no_retry";
    max_retries: number;
    escalate_after: number;
}, {
    on_failure: "retry_same" | "escalate_one_tier" | "escalate_to_opus" | "no_retry";
    max_retries: number;
    escalate_after: number;
}>;
export type EscalationPolicyRouting = z.infer<typeof EscalationPolicyRoutingSchema>;
export declare const PersonaAffinitySchema: z.ZodObject<{
    persona_id: z.ZodString;
    base_model: z.ZodEnum<["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-6"]>;
    rationale: z.ZodString;
}, "strip", z.ZodTypeAny, {
    persona_id: string;
    rationale: string;
    base_model: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
}, {
    persona_id: string;
    rationale: string;
    base_model: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
}>;
export type PersonaAffinity = z.infer<typeof PersonaAffinitySchema>;
export declare const RiskClassRuleSchema: z.ZodObject<{
    risk_class: z.ZodEnum<["low", "standard", "high", "critical"]>;
    min_capability_tier: z.ZodEnum<["simple", "default", "complex"]>;
    pin_model: z.ZodOptional<z.ZodEnum<["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-6"]>>;
    default_token_budget: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    risk_class: "low" | "standard" | "high" | "critical";
    min_capability_tier: "default" | "simple" | "complex";
    default_token_budget?: number | undefined;
    pin_model?: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6" | undefined;
}, {
    risk_class: "low" | "standard" | "high" | "critical";
    min_capability_tier: "default" | "simple" | "complex";
    default_token_budget?: number | undefined;
    pin_model?: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6" | undefined;
}>;
export type RiskClassRule = z.infer<typeof RiskClassRuleSchema>;
export declare const RetryEscalationRuleSchema: z.ZodObject<{
    retry_depth: z.ZodNumber;
    bump_tiers: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    retry_depth: number;
    bump_tiers: number;
}, {
    retry_depth: number;
    bump_tiers: number;
}>;
export type RetryEscalationRule = z.infer<typeof RetryEscalationRuleSchema>;
export declare const LatencyRuleSchema: z.ZodObject<{
    if_below_ms: z.ZodNumber;
    prefer_tier: z.ZodEnum<["simple", "default"]>;
}, "strip", z.ZodTypeAny, {
    if_below_ms: number;
    prefer_tier: "default" | "simple";
}, {
    if_below_ms: number;
    prefer_tier: "default" | "simple";
}>;
export type LatencyRule = z.infer<typeof LatencyRuleSchema>;
export declare const RoutingPolicySchema: z.ZodObject<{
    schema_version: z.ZodLiteral<1>;
    description: z.ZodString;
    persona_affinities: z.ZodArray<z.ZodObject<{
        persona_id: z.ZodString;
        base_model: z.ZodEnum<["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-6"]>;
        rationale: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        persona_id: string;
        rationale: string;
        base_model: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
    }, {
        persona_id: string;
        rationale: string;
        base_model: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
    }>, "many">;
    risk_class_rules: z.ZodArray<z.ZodObject<{
        risk_class: z.ZodEnum<["low", "standard", "high", "critical"]>;
        min_capability_tier: z.ZodEnum<["simple", "default", "complex"]>;
        pin_model: z.ZodOptional<z.ZodEnum<["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-6"]>>;
        default_token_budget: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        risk_class: "low" | "standard" | "high" | "critical";
        min_capability_tier: "default" | "simple" | "complex";
        default_token_budget?: number | undefined;
        pin_model?: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6" | undefined;
    }, {
        risk_class: "low" | "standard" | "high" | "critical";
        min_capability_tier: "default" | "simple" | "complex";
        default_token_budget?: number | undefined;
        pin_model?: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6" | undefined;
    }>, "many">;
    retry_escalation: z.ZodArray<z.ZodObject<{
        retry_depth: z.ZodNumber;
        bump_tiers: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        retry_depth: number;
        bump_tiers: number;
    }, {
        retry_depth: number;
        bump_tiers: number;
    }>, "many">;
    latency_rules: z.ZodArray<z.ZodObject<{
        if_below_ms: z.ZodNumber;
        prefer_tier: z.ZodEnum<["simple", "default"]>;
    }, "strip", z.ZodTypeAny, {
        if_below_ms: number;
        prefer_tier: "default" | "simple";
    }, {
        if_below_ms: number;
        prefer_tier: "default" | "simple";
    }>, "many">;
    default_escalation_policy: z.ZodObject<{
        on_failure: z.ZodEnum<["retry_same", "escalate_one_tier", "escalate_to_opus", "no_retry"]>;
        max_retries: z.ZodNumber;
        escalate_after: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        on_failure: "retry_same" | "escalate_one_tier" | "escalate_to_opus" | "no_retry";
        max_retries: number;
        escalate_after: number;
    }, {
        on_failure: "retry_same" | "escalate_one_tier" | "escalate_to_opus" | "no_retry";
        max_retries: number;
        escalate_after: number;
    }>;
    default_task_caps_usd_micros: z.ZodRecord<z.ZodEnum<["low", "standard", "high", "critical"]>, z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    description: string;
    schema_version: 1;
    persona_affinities: {
        persona_id: string;
        rationale: string;
        base_model: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
    }[];
    risk_class_rules: {
        risk_class: "low" | "standard" | "high" | "critical";
        min_capability_tier: "default" | "simple" | "complex";
        default_token_budget?: number | undefined;
        pin_model?: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6" | undefined;
    }[];
    retry_escalation: {
        retry_depth: number;
        bump_tiers: number;
    }[];
    latency_rules: {
        if_below_ms: number;
        prefer_tier: "default" | "simple";
    }[];
    default_escalation_policy: {
        on_failure: "retry_same" | "escalate_one_tier" | "escalate_to_opus" | "no_retry";
        max_retries: number;
        escalate_after: number;
    };
    default_task_caps_usd_micros: Partial<Record<"low" | "standard" | "high" | "critical", number>>;
}, {
    description: string;
    schema_version: 1;
    persona_affinities: {
        persona_id: string;
        rationale: string;
        base_model: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
    }[];
    risk_class_rules: {
        risk_class: "low" | "standard" | "high" | "critical";
        min_capability_tier: "default" | "simple" | "complex";
        default_token_budget?: number | undefined;
        pin_model?: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6" | undefined;
    }[];
    retry_escalation: {
        retry_depth: number;
        bump_tiers: number;
    }[];
    latency_rules: {
        if_below_ms: number;
        prefer_tier: "default" | "simple";
    }[];
    default_escalation_policy: {
        on_failure: "retry_same" | "escalate_one_tier" | "escalate_to_opus" | "no_retry";
        max_retries: number;
        escalate_after: number;
    };
    default_task_caps_usd_micros: Partial<Record<"low" | "standard" | "high" | "critical", number>>;
}>;
export type RoutingPolicy = z.infer<typeof RoutingPolicySchema>;
export declare const RoutingReasonRuleSchema: z.ZodObject<{
    rule_type: z.ZodEnum<["risk_class", "retry_escalation", "latency", "pin_model", "persona_affinity"]>;
    detail: z.ZodString;
    before_model: z.ZodEnum<["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-6"]>;
    after_model: z.ZodEnum<["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-6"]>;
}, "strip", z.ZodTypeAny, {
    detail: string;
    rule_type: "risk_class" | "pin_model" | "retry_escalation" | "latency" | "persona_affinity";
    before_model: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
    after_model: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
}, {
    detail: string;
    rule_type: "risk_class" | "pin_model" | "retry_escalation" | "latency" | "persona_affinity";
    before_model: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
    after_model: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
}>;
export type RoutingReasonRule = z.infer<typeof RoutingReasonRuleSchema>;
export declare const RoutingReasonSchema: z.ZodObject<{
    base_from_persona: z.ZodEnum<["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-6"]>;
    rules_applied: z.ZodArray<z.ZodObject<{
        rule_type: z.ZodEnum<["risk_class", "retry_escalation", "latency", "pin_model", "persona_affinity"]>;
        detail: z.ZodString;
        before_model: z.ZodEnum<["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-6"]>;
        after_model: z.ZodEnum<["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-6"]>;
    }, "strip", z.ZodTypeAny, {
        detail: string;
        rule_type: "risk_class" | "pin_model" | "retry_escalation" | "latency" | "persona_affinity";
        before_model: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
        after_model: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
    }, {
        detail: string;
        rule_type: "risk_class" | "pin_model" | "retry_escalation" | "latency" | "persona_affinity";
        before_model: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
        after_model: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    base_from_persona: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
    rules_applied: {
        detail: string;
        rule_type: "risk_class" | "pin_model" | "retry_escalation" | "latency" | "persona_affinity";
        before_model: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
        after_model: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
    }[];
}, {
    base_from_persona: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
    rules_applied: {
        detail: string;
        rule_type: "risk_class" | "pin_model" | "retry_escalation" | "latency" | "persona_affinity";
        before_model: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
        after_model: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
    }[];
}>;
export type RoutingReason = z.infer<typeof RoutingReasonSchema>;
export declare const RoutingDecisionSchema: z.ZodObject<{
    decision_id: z.ZodString;
    task_id: z.ZodString;
    persona_id: z.ZodString;
    risk_class: z.ZodEnum<["low", "standard", "high", "critical"]>;
    retry_depth: z.ZodNumber;
    latency_budget_ms: z.ZodOptional<z.ZodNumber>;
    model: z.ZodEnum<["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-6"]>;
    token_budget: z.ZodNumber;
    escalation_policy: z.ZodObject<{
        on_failure: z.ZodEnum<["retry_same", "escalate_one_tier", "escalate_to_opus", "no_retry"]>;
        max_retries: z.ZodNumber;
        escalate_after: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        on_failure: "retry_same" | "escalate_one_tier" | "escalate_to_opus" | "no_retry";
        max_retries: number;
        escalate_after: number;
    }, {
        on_failure: "retry_same" | "escalate_one_tier" | "escalate_to_opus" | "no_retry";
        max_retries: number;
        escalate_after: number;
    }>;
    reason: z.ZodObject<{
        base_from_persona: z.ZodEnum<["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-6"]>;
        rules_applied: z.ZodArray<z.ZodObject<{
            rule_type: z.ZodEnum<["risk_class", "retry_escalation", "latency", "pin_model", "persona_affinity"]>;
            detail: z.ZodString;
            before_model: z.ZodEnum<["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-6"]>;
            after_model: z.ZodEnum<["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-6"]>;
        }, "strip", z.ZodTypeAny, {
            detail: string;
            rule_type: "risk_class" | "pin_model" | "retry_escalation" | "latency" | "persona_affinity";
            before_model: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
            after_model: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
        }, {
            detail: string;
            rule_type: "risk_class" | "pin_model" | "retry_escalation" | "latency" | "persona_affinity";
            before_model: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
            after_model: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
        }>, "many">;
    }, "strip", z.ZodTypeAny, {
        base_from_persona: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
        rules_applied: {
            detail: string;
            rule_type: "risk_class" | "pin_model" | "retry_escalation" | "latency" | "persona_affinity";
            before_model: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
            after_model: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
        }[];
    }, {
        base_from_persona: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
        rules_applied: {
            detail: string;
            rule_type: "risk_class" | "pin_model" | "retry_escalation" | "latency" | "persona_affinity";
            before_model: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
            after_model: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
        }[];
    }>;
    policy_version: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    task_id: string;
    persona_id: string;
    reason: {
        base_from_persona: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
        rules_applied: {
            detail: string;
            rule_type: "risk_class" | "pin_model" | "retry_escalation" | "latency" | "persona_affinity";
            before_model: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
            after_model: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
        }[];
    };
    risk_class: "low" | "standard" | "high" | "critical";
    token_budget: number;
    escalation_policy: {
        on_failure: "retry_same" | "escalate_one_tier" | "escalate_to_opus" | "no_retry";
        max_retries: number;
        escalate_after: number;
    };
    model: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
    decision_id: string;
    retry_depth: number;
    policy_version: number;
    latency_budget_ms?: number | undefined;
}, {
    task_id: string;
    persona_id: string;
    reason: {
        base_from_persona: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
        rules_applied: {
            detail: string;
            rule_type: "risk_class" | "pin_model" | "retry_escalation" | "latency" | "persona_affinity";
            before_model: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
            after_model: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
        }[];
    };
    risk_class: "low" | "standard" | "high" | "critical";
    token_budget: number;
    escalation_policy: {
        on_failure: "retry_same" | "escalate_one_tier" | "escalate_to_opus" | "no_retry";
        max_retries: number;
        escalate_after: number;
    };
    model: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
    decision_id: string;
    retry_depth: number;
    policy_version: number;
    latency_budget_ms?: number | undefined;
}>;
export type RoutingDecision = z.infer<typeof RoutingDecisionSchema>;
export declare const RouterInputSchema: z.ZodObject<{
    task_id: z.ZodString;
    persona_id: z.ZodString;
    risk_class: z.ZodEnum<["low", "standard", "high", "critical"]>;
    retry_depth: z.ZodDefault<z.ZodNumber>;
    latency_budget_ms: z.ZodOptional<z.ZodNumber>;
    trace_id: z.ZodString;
}, "strip", z.ZodTypeAny, {
    task_id: string;
    persona_id: string;
    trace_id: string;
    risk_class: "low" | "standard" | "high" | "critical";
    retry_depth: number;
    latency_budget_ms?: number | undefined;
}, {
    task_id: string;
    persona_id: string;
    trace_id: string;
    risk_class: "low" | "standard" | "high" | "critical";
    retry_depth?: number | undefined;
    latency_budget_ms?: number | undefined;
}>;
export type RouterInput = z.infer<typeof RouterInputSchema>;
export declare const AnthropicUsageSchema: z.ZodObject<{
    input_tokens: z.ZodNumber;
    output_tokens: z.ZodNumber;
    cache_read_input_tokens: z.ZodDefault<z.ZodNumber>;
    cache_creation_input_tokens: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
}, {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | undefined;
    cache_creation_input_tokens?: number | undefined;
}>;
export type AnthropicUsage = z.infer<typeof AnthropicUsageSchema>;
export interface CostSummary {
    total_usd_micros: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    turn_count: number;
}
export type BudgetState = 'ok' | 'warned' | 'exceeded';
export declare const ModelChoiceSchema: z.ZodObject<{
    provider: z.ZodString;
    model: z.ZodString;
}, "strip", z.ZodTypeAny, {
    provider: string;
    model: string;
}, {
    provider: string;
    model: string;
}>;
export type ModelChoice = z.infer<typeof ModelChoiceSchema>;
export declare const ProviderHealthSchema: z.ZodObject<{
    healthy: z.ZodBoolean;
    providerId: z.ZodString;
    latencyMs: z.ZodOptional<z.ZodNumber>;
    lastCheckedAt: z.ZodString;
    reason: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    providerId: string;
    healthy: boolean;
    lastCheckedAt: string;
    reason?: string | undefined;
    latencyMs?: number | undefined;
}, {
    providerId: string;
    healthy: boolean;
    lastCheckedAt: string;
    reason?: string | undefined;
    latencyMs?: number | undefined;
}>;
export type ProviderHealth = z.infer<typeof ProviderHealthSchema>;
/**
 * Input for routeModel() — the new multi-provider routing method.
 */
export declare const RouteModelInputSchema: z.ZodObject<{
    persona: z.ZodString;
    /** Task size estimate (S / M / L / XL). */
    estimate: z.ZodEnum<["S", "M", "L", "XL"]>;
    /**
     * When the author of the content being reviewed used this provider+model,
     * the cross-family SoD rule kicks in: reviewer must be routed to a different
     * family.
     */
    authorProvider: z.ZodOptional<z.ZodString>;
    authorModel: z.ZodOptional<z.ZodString>;
    traceId: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    persona: string;
    estimate: "S" | "M" | "L" | "XL";
    traceId?: string | undefined;
    authorProvider?: string | undefined;
    authorModel?: string | undefined;
}, {
    persona: string;
    estimate: "S" | "M" | "L" | "XL";
    traceId?: string | undefined;
    authorProvider?: string | undefined;
    authorModel?: string | undefined;
}>;
export type RouteModelInput = z.infer<typeof RouteModelInputSchema>;
export declare const RouteModelResultSchema: z.ZodObject<{
    provider: z.ZodString;
    model: z.ZodString;
    /** Human-readable reason for the decision. */
    reason: z.ZodString;
    /** Whether the SoD cross-family rule was applied. */
    sodApplied: z.ZodBoolean;
}, "strip", z.ZodTypeAny, {
    reason: string;
    provider: string;
    model: string;
    sodApplied: boolean;
}, {
    reason: string;
    provider: string;
    model: string;
    sodApplied: boolean;
}>;
export type RouteModelResult = z.infer<typeof RouteModelResultSchema>;
//# sourceMappingURL=types.d.ts.map