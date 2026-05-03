/**
 * PersonaDefinition — the strict compile-time + runtime contract for persona
 * definition files. Per TRD-03 §6.2.
 *
 * Every persona file exports a `definition` of type PersonaDefinition.
 * Zod mirrors the TypeScript interface for runtime validation at boot.
 */
import { z } from 'zod';
// ---------------------------------------------------------------------------
// Primitive enums
// ---------------------------------------------------------------------------
export const RiskClassSchema = z.enum(['low', 'standard', 'high', 'critical']);
export const ModelIdSchema = z.enum([
    'claude-haiku-4-5',
    'claude-sonnet-4-6',
    'claude-opus-4-6',
]);
export const EscalationTriggerSchema = z.enum([
    'budget_exhausted',
    'verifier_failed',
    'capability_denied',
    'timeout',
    'tool_error_recurrent',
    'ambiguous_input',
]);
export const EscalationActionSchema = z.enum([
    'spawn_resolver',
    'post_blocker',
    'request_human',
    'fail_task',
]);
// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------
export const RoleBriefSchema = z.object({
    headline: z.string().min(1).max(200),
    bodyMd: z.string().min(1),
    nonGoals: z.array(z.string()).default([]),
    styleNotes: z.string(),
});
export const SkillRefSchema = z.object({
    slug: z.string().min(1),
    required: z.boolean(),
    ordering: z.number().int().nonnegative(),
});
export const DefaultCapabilityProfileSchema = z.object({
    filesRead: z.array(z.string()),
    filesWrite: z.array(z.string()),
    boardRead: z.array(z.string()),
    boardMutate: z.array(z.string()),
    channelRead: z.array(z.string()),
    channelPost: z.array(z.string()),
    /** Exact secret key names; never wildcards. */
    secrets: z.array(z.string()).refine((arr) => arr.every((s) => !s.includes('*')), { message: 'secrets scope must not contain wildcards' }),
    networkEgress: z.array(z.string()),
    spawnSubagent: z.boolean(),
    gitCommit: z
        .object({
        branchPattern: z.string(),
        pathGlob: z.string(),
    })
        .nullable(),
    ceremonyRole: z.enum(['chair', 'participant', 'observer', 'none']),
});
export const ModelAffinityEntrySchema = z.object({
    riskClass: RiskClassSchema,
    preferredModel: ModelIdSchema,
    fallbackModel: ModelIdSchema.nullable(),
    maxTokensHint: z.number().int().positive().nullable(),
    rationale: z.string(),
});
export const EscalationRuleSchema = z
    .object({
    trigger: EscalationTriggerSchema,
    action: EscalationActionSchema,
    resolverPersona: z.string().optional(),
    blockerChannel: z.string().optional(),
})
    .refine((r) => r.action !== 'spawn_resolver' || typeof r.resolverPersona === 'string', { message: 'spawn_resolver action requires resolverPersona' });
export const EscalationPolicySchema = z.object({
    maxRetries: z.number().int().min(0).max(5),
    rules: z.array(EscalationRuleSchema),
    defaultAction: EscalationActionSchema,
});
// ---------------------------------------------------------------------------
// PersonaDefinition — the top-level export shape for all persona files
// ---------------------------------------------------------------------------
export const PersonaDefinitionSchema = z
    .object({
    slug: z.string().regex(/^[a-z][a-z0-9-]*$/, 'slug must be kebab-case'),
    displayName: z.string().min(1),
    origin: z.enum(['baseline', 'user']),
    roleBrief: RoleBriefSchema,
    skills: z.array(SkillRefSchema),
    defaultCapabilityProfile: DefaultCapabilityProfileSchema,
    modelAffinity: z
        .array(ModelAffinityEntrySchema)
        .refine((arr) => arr.some((e) => e.riskClass === 'standard'), { message: 'modelAffinity must include an entry for riskClass="standard"' }),
    escalationPolicy: EscalationPolicySchema,
    metadata: z.object({
        tags: z.array(z.string()),
        description: z.string().min(1).max(280),
    }),
})
    .refine((d) => d.roleBrief.bodyMd.length <= 32768, { message: 'roleBrief.bodyMd must not exceed 32 KB' });
//# sourceMappingURL=types.js.map