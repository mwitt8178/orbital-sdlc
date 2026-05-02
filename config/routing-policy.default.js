/**
 * Default routing policy — ships with Orbital v1.
 *
 * Per TRD-08 §5.3:
 * - haiku for low-risk / high-volume personas (jr-dev, scrum-master)
 * - sonnet for default implementation and analysis personas
 * - opus for high-stakes roles (pm, architect, principal-dev, security)
 * - risk_class=high forces complex tier; risk_class=critical pins opus
 *
 * Model IDs per SAO §5.7: claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5
 */
const policy = {
    schema_version: 1,
    description: 'Orbital v1 default routing policy.',
    persona_affinities: [
        { persona_id: 'pm', base_model: 'claude-opus-4-6', rationale: 'Vision and product judgment.' },
        { persona_id: 'architect', base_model: 'claude-opus-4-6', rationale: 'System-level design.' },
        { persona_id: 'principal-dev', base_model: 'claude-opus-4-6', rationale: 'Cross-cutting decisions.' },
        { persona_id: 'security', base_model: 'claude-opus-4-6', rationale: 'Threat modeling, sensitive review.' },
        { persona_id: 'sr-dev', base_model: 'claude-sonnet-4-6', rationale: 'Default implementation work.' },
        { persona_id: 'verifier', base_model: 'claude-sonnet-4-6', rationale: 'Cheap enough to run on every output, capable enough to catch real issues.' },
        { persona_id: 'retro-analyst', base_model: 'claude-sonnet-4-6', rationale: 'Pattern-finding over a sprint of events.' },
        { persona_id: 'qa', base_model: 'claude-sonnet-4-6', rationale: 'Test writing; balanced capability.' },
        { persona_id: 'em', base_model: 'claude-sonnet-4-6', rationale: 'Management tasks; balanced capability.' },
        { persona_id: 'jr-dev', base_model: 'claude-haiku-4-5', rationale: 'Scaffolding, simple CRUD, lint fixes.' },
        { persona_id: 'scrum-master', base_model: 'claude-haiku-4-5', rationale: 'Process orchestration; cheap.' },
    ],
    risk_class_rules: [
        { risk_class: 'low', min_capability_tier: 'simple' },
        { risk_class: 'standard', min_capability_tier: 'default' },
        { risk_class: 'high', min_capability_tier: 'complex' },
        { risk_class: 'critical', min_capability_tier: 'complex', pin_model: 'claude-opus-4-6' },
    ],
    retry_escalation: [
        { retry_depth: 1, bump_tiers: 1 },
        { retry_depth: 2, bump_tiers: 2 },
    ],
    latency_rules: [
        { if_below_ms: 5_000, prefer_tier: 'default' },
        { if_below_ms: 1_500, prefer_tier: 'simple' },
    ],
    default_escalation_policy: {
        on_failure: 'escalate_one_tier',
        max_retries: 3,
        escalate_after: 1,
    },
    default_task_caps_usd_micros: {
        low: 100_000,
        standard: 1_000_000,
        high: 5_000_000,
        critical: 20_000_000,
    },
};
export default policy;
//# sourceMappingURL=routing-policy.default.js.map