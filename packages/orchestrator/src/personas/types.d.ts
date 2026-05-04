/**
 * PersonaDefinition — the strict compile-time + runtime contract for persona
 * definition files. Per TRD-03 §6.2.
 *
 * Every persona file exports a `definition` of type PersonaDefinition.
 * Zod mirrors the TypeScript interface for runtime validation at boot.
 */
import { z } from 'zod';
export declare const RiskClassSchema: z.ZodEnum<["low", "standard", "high", "critical"]>;
export type RiskClass = z.infer<typeof RiskClassSchema>;
export declare const ModelIdSchema: z.ZodEnum<["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-6"]>;
export type ModelId = z.infer<typeof ModelIdSchema>;
export declare const EscalationTriggerSchema: z.ZodEnum<["budget_exhausted", "verifier_failed", "capability_denied", "timeout", "tool_error_recurrent", "ambiguous_input"]>;
export type EscalationTrigger = z.infer<typeof EscalationTriggerSchema>;
export declare const EscalationActionSchema: z.ZodEnum<["spawn_resolver", "post_blocker", "request_human", "fail_task"]>;
export type EscalationAction = z.infer<typeof EscalationActionSchema>;
export declare const RoleBriefSchema: z.ZodObject<{
    headline: z.ZodString;
    bodyMd: z.ZodString;
    nonGoals: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    styleNotes: z.ZodString;
}, "strip", z.ZodTypeAny, {
    headline: string;
    bodyMd: string;
    nonGoals: string[];
    styleNotes: string;
}, {
    headline: string;
    bodyMd: string;
    styleNotes: string;
    nonGoals?: string[] | undefined;
}>;
export type RoleBrief = z.infer<typeof RoleBriefSchema>;
export declare const SkillRefSchema: z.ZodObject<{
    slug: z.ZodString;
    required: z.ZodBoolean;
    ordering: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    slug: string;
    required: boolean;
    ordering: number;
}, {
    slug: string;
    required: boolean;
    ordering: number;
}>;
export type SkillRef = z.infer<typeof SkillRefSchema>;
export declare const DefaultCapabilityProfileSchema: z.ZodObject<{
    filesRead: z.ZodArray<z.ZodString, "many">;
    filesWrite: z.ZodArray<z.ZodString, "many">;
    boardRead: z.ZodArray<z.ZodString, "many">;
    boardMutate: z.ZodArray<z.ZodString, "many">;
    channelRead: z.ZodArray<z.ZodString, "many">;
    channelPost: z.ZodArray<z.ZodString, "many">;
    /** Exact secret key names; never wildcards. */
    secrets: z.ZodEffects<z.ZodArray<z.ZodString, "many">, string[], string[]>;
    networkEgress: z.ZodArray<z.ZodString, "many">;
    spawnSubagent: z.ZodBoolean;
    gitCommit: z.ZodNullable<z.ZodObject<{
        branchPattern: z.ZodString;
        pathGlob: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        branchPattern: string;
        pathGlob: string;
    }, {
        branchPattern: string;
        pathGlob: string;
    }>>;
    ceremonyRole: z.ZodEnum<["chair", "participant", "observer", "none"]>;
}, "strip", z.ZodTypeAny, {
    secrets: string[];
    filesRead: string[];
    filesWrite: string[];
    boardRead: string[];
    boardMutate: string[];
    channelRead: string[];
    channelPost: string[];
    networkEgress: string[];
    spawnSubagent: boolean;
    gitCommit: {
        branchPattern: string;
        pathGlob: string;
    } | null;
    ceremonyRole: "chair" | "participant" | "observer" | "none";
}, {
    secrets: string[];
    filesRead: string[];
    filesWrite: string[];
    boardRead: string[];
    boardMutate: string[];
    channelRead: string[];
    channelPost: string[];
    networkEgress: string[];
    spawnSubagent: boolean;
    gitCommit: {
        branchPattern: string;
        pathGlob: string;
    } | null;
    ceremonyRole: "chair" | "participant" | "observer" | "none";
}>;
export type DefaultCapabilityProfile = z.infer<typeof DefaultCapabilityProfileSchema>;
export declare const ModelAffinityEntrySchema: z.ZodObject<{
    riskClass: z.ZodEnum<["low", "standard", "high", "critical"]>;
    preferredModel: z.ZodEnum<["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-6"]>;
    fallbackModel: z.ZodNullable<z.ZodEnum<["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-6"]>>;
    maxTokensHint: z.ZodNullable<z.ZodNumber>;
    rationale: z.ZodString;
}, "strip", z.ZodTypeAny, {
    rationale: string;
    riskClass: "critical" | "standard" | "low" | "high";
    preferredModel: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
    fallbackModel: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6" | null;
    maxTokensHint: number | null;
}, {
    rationale: string;
    riskClass: "critical" | "standard" | "low" | "high";
    preferredModel: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
    fallbackModel: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6" | null;
    maxTokensHint: number | null;
}>;
export type ModelAffinityEntry = z.infer<typeof ModelAffinityEntrySchema>;
export declare const EscalationRuleSchema: z.ZodEffects<z.ZodObject<{
    trigger: z.ZodEnum<["budget_exhausted", "verifier_failed", "capability_denied", "timeout", "tool_error_recurrent", "ambiguous_input"]>;
    action: z.ZodEnum<["spawn_resolver", "post_blocker", "request_human", "fail_task"]>;
    resolverPersona: z.ZodOptional<z.ZodString>;
    blockerChannel: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    trigger: "budget_exhausted" | "verifier_failed" | "capability_denied" | "timeout" | "tool_error_recurrent" | "ambiguous_input";
    action: "spawn_resolver" | "post_blocker" | "request_human" | "fail_task";
    resolverPersona?: string | undefined;
    blockerChannel?: string | undefined;
}, {
    trigger: "budget_exhausted" | "verifier_failed" | "capability_denied" | "timeout" | "tool_error_recurrent" | "ambiguous_input";
    action: "spawn_resolver" | "post_blocker" | "request_human" | "fail_task";
    resolverPersona?: string | undefined;
    blockerChannel?: string | undefined;
}>, {
    trigger: "budget_exhausted" | "verifier_failed" | "capability_denied" | "timeout" | "tool_error_recurrent" | "ambiguous_input";
    action: "spawn_resolver" | "post_blocker" | "request_human" | "fail_task";
    resolverPersona?: string | undefined;
    blockerChannel?: string | undefined;
}, {
    trigger: "budget_exhausted" | "verifier_failed" | "capability_denied" | "timeout" | "tool_error_recurrent" | "ambiguous_input";
    action: "spawn_resolver" | "post_blocker" | "request_human" | "fail_task";
    resolverPersona?: string | undefined;
    blockerChannel?: string | undefined;
}>;
export type EscalationRule = z.infer<typeof EscalationRuleSchema>;
export declare const EscalationPolicySchema: z.ZodObject<{
    maxRetries: z.ZodNumber;
    rules: z.ZodArray<z.ZodEffects<z.ZodObject<{
        trigger: z.ZodEnum<["budget_exhausted", "verifier_failed", "capability_denied", "timeout", "tool_error_recurrent", "ambiguous_input"]>;
        action: z.ZodEnum<["spawn_resolver", "post_blocker", "request_human", "fail_task"]>;
        resolverPersona: z.ZodOptional<z.ZodString>;
        blockerChannel: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        trigger: "budget_exhausted" | "verifier_failed" | "capability_denied" | "timeout" | "tool_error_recurrent" | "ambiguous_input";
        action: "spawn_resolver" | "post_blocker" | "request_human" | "fail_task";
        resolverPersona?: string | undefined;
        blockerChannel?: string | undefined;
    }, {
        trigger: "budget_exhausted" | "verifier_failed" | "capability_denied" | "timeout" | "tool_error_recurrent" | "ambiguous_input";
        action: "spawn_resolver" | "post_blocker" | "request_human" | "fail_task";
        resolverPersona?: string | undefined;
        blockerChannel?: string | undefined;
    }>, {
        trigger: "budget_exhausted" | "verifier_failed" | "capability_denied" | "timeout" | "tool_error_recurrent" | "ambiguous_input";
        action: "spawn_resolver" | "post_blocker" | "request_human" | "fail_task";
        resolverPersona?: string | undefined;
        blockerChannel?: string | undefined;
    }, {
        trigger: "budget_exhausted" | "verifier_failed" | "capability_denied" | "timeout" | "tool_error_recurrent" | "ambiguous_input";
        action: "spawn_resolver" | "post_blocker" | "request_human" | "fail_task";
        resolverPersona?: string | undefined;
        blockerChannel?: string | undefined;
    }>, "many">;
    defaultAction: z.ZodEnum<["spawn_resolver", "post_blocker", "request_human", "fail_task"]>;
}, "strip", z.ZodTypeAny, {
    maxRetries: number;
    rules: {
        trigger: "budget_exhausted" | "verifier_failed" | "capability_denied" | "timeout" | "tool_error_recurrent" | "ambiguous_input";
        action: "spawn_resolver" | "post_blocker" | "request_human" | "fail_task";
        resolverPersona?: string | undefined;
        blockerChannel?: string | undefined;
    }[];
    defaultAction: "spawn_resolver" | "post_blocker" | "request_human" | "fail_task";
}, {
    maxRetries: number;
    rules: {
        trigger: "budget_exhausted" | "verifier_failed" | "capability_denied" | "timeout" | "tool_error_recurrent" | "ambiguous_input";
        action: "spawn_resolver" | "post_blocker" | "request_human" | "fail_task";
        resolverPersona?: string | undefined;
        blockerChannel?: string | undefined;
    }[];
    defaultAction: "spawn_resolver" | "post_blocker" | "request_human" | "fail_task";
}>;
export type EscalationPolicy = z.infer<typeof EscalationPolicySchema>;
export declare const PersonaDefinitionSchema: z.ZodEffects<z.ZodObject<{
    slug: z.ZodString;
    displayName: z.ZodString;
    origin: z.ZodEnum<["baseline", "user"]>;
    roleBrief: z.ZodObject<{
        headline: z.ZodString;
        bodyMd: z.ZodString;
        nonGoals: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        styleNotes: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        headline: string;
        bodyMd: string;
        nonGoals: string[];
        styleNotes: string;
    }, {
        headline: string;
        bodyMd: string;
        styleNotes: string;
        nonGoals?: string[] | undefined;
    }>;
    skills: z.ZodArray<z.ZodObject<{
        slug: z.ZodString;
        required: z.ZodBoolean;
        ordering: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        slug: string;
        required: boolean;
        ordering: number;
    }, {
        slug: string;
        required: boolean;
        ordering: number;
    }>, "many">;
    defaultCapabilityProfile: z.ZodObject<{
        filesRead: z.ZodArray<z.ZodString, "many">;
        filesWrite: z.ZodArray<z.ZodString, "many">;
        boardRead: z.ZodArray<z.ZodString, "many">;
        boardMutate: z.ZodArray<z.ZodString, "many">;
        channelRead: z.ZodArray<z.ZodString, "many">;
        channelPost: z.ZodArray<z.ZodString, "many">;
        /** Exact secret key names; never wildcards. */
        secrets: z.ZodEffects<z.ZodArray<z.ZodString, "many">, string[], string[]>;
        networkEgress: z.ZodArray<z.ZodString, "many">;
        spawnSubagent: z.ZodBoolean;
        gitCommit: z.ZodNullable<z.ZodObject<{
            branchPattern: z.ZodString;
            pathGlob: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            branchPattern: string;
            pathGlob: string;
        }, {
            branchPattern: string;
            pathGlob: string;
        }>>;
        ceremonyRole: z.ZodEnum<["chair", "participant", "observer", "none"]>;
    }, "strip", z.ZodTypeAny, {
        secrets: string[];
        filesRead: string[];
        filesWrite: string[];
        boardRead: string[];
        boardMutate: string[];
        channelRead: string[];
        channelPost: string[];
        networkEgress: string[];
        spawnSubagent: boolean;
        gitCommit: {
            branchPattern: string;
            pathGlob: string;
        } | null;
        ceremonyRole: "chair" | "participant" | "observer" | "none";
    }, {
        secrets: string[];
        filesRead: string[];
        filesWrite: string[];
        boardRead: string[];
        boardMutate: string[];
        channelRead: string[];
        channelPost: string[];
        networkEgress: string[];
        spawnSubagent: boolean;
        gitCommit: {
            branchPattern: string;
            pathGlob: string;
        } | null;
        ceremonyRole: "chair" | "participant" | "observer" | "none";
    }>;
    modelAffinity: z.ZodEffects<z.ZodArray<z.ZodObject<{
        riskClass: z.ZodEnum<["low", "standard", "high", "critical"]>;
        preferredModel: z.ZodEnum<["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-6"]>;
        fallbackModel: z.ZodNullable<z.ZodEnum<["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-6"]>>;
        maxTokensHint: z.ZodNullable<z.ZodNumber>;
        rationale: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        rationale: string;
        riskClass: "critical" | "standard" | "low" | "high";
        preferredModel: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
        fallbackModel: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6" | null;
        maxTokensHint: number | null;
    }, {
        rationale: string;
        riskClass: "critical" | "standard" | "low" | "high";
        preferredModel: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
        fallbackModel: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6" | null;
        maxTokensHint: number | null;
    }>, "many">, {
        rationale: string;
        riskClass: "critical" | "standard" | "low" | "high";
        preferredModel: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
        fallbackModel: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6" | null;
        maxTokensHint: number | null;
    }[], {
        rationale: string;
        riskClass: "critical" | "standard" | "low" | "high";
        preferredModel: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
        fallbackModel: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6" | null;
        maxTokensHint: number | null;
    }[]>;
    escalationPolicy: z.ZodObject<{
        maxRetries: z.ZodNumber;
        rules: z.ZodArray<z.ZodEffects<z.ZodObject<{
            trigger: z.ZodEnum<["budget_exhausted", "verifier_failed", "capability_denied", "timeout", "tool_error_recurrent", "ambiguous_input"]>;
            action: z.ZodEnum<["spawn_resolver", "post_blocker", "request_human", "fail_task"]>;
            resolverPersona: z.ZodOptional<z.ZodString>;
            blockerChannel: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            trigger: "budget_exhausted" | "verifier_failed" | "capability_denied" | "timeout" | "tool_error_recurrent" | "ambiguous_input";
            action: "spawn_resolver" | "post_blocker" | "request_human" | "fail_task";
            resolverPersona?: string | undefined;
            blockerChannel?: string | undefined;
        }, {
            trigger: "budget_exhausted" | "verifier_failed" | "capability_denied" | "timeout" | "tool_error_recurrent" | "ambiguous_input";
            action: "spawn_resolver" | "post_blocker" | "request_human" | "fail_task";
            resolverPersona?: string | undefined;
            blockerChannel?: string | undefined;
        }>, {
            trigger: "budget_exhausted" | "verifier_failed" | "capability_denied" | "timeout" | "tool_error_recurrent" | "ambiguous_input";
            action: "spawn_resolver" | "post_blocker" | "request_human" | "fail_task";
            resolverPersona?: string | undefined;
            blockerChannel?: string | undefined;
        }, {
            trigger: "budget_exhausted" | "verifier_failed" | "capability_denied" | "timeout" | "tool_error_recurrent" | "ambiguous_input";
            action: "spawn_resolver" | "post_blocker" | "request_human" | "fail_task";
            resolverPersona?: string | undefined;
            blockerChannel?: string | undefined;
        }>, "many">;
        defaultAction: z.ZodEnum<["spawn_resolver", "post_blocker", "request_human", "fail_task"]>;
    }, "strip", z.ZodTypeAny, {
        maxRetries: number;
        rules: {
            trigger: "budget_exhausted" | "verifier_failed" | "capability_denied" | "timeout" | "tool_error_recurrent" | "ambiguous_input";
            action: "spawn_resolver" | "post_blocker" | "request_human" | "fail_task";
            resolverPersona?: string | undefined;
            blockerChannel?: string | undefined;
        }[];
        defaultAction: "spawn_resolver" | "post_blocker" | "request_human" | "fail_task";
    }, {
        maxRetries: number;
        rules: {
            trigger: "budget_exhausted" | "verifier_failed" | "capability_denied" | "timeout" | "tool_error_recurrent" | "ambiguous_input";
            action: "spawn_resolver" | "post_blocker" | "request_human" | "fail_task";
            resolverPersona?: string | undefined;
            blockerChannel?: string | undefined;
        }[];
        defaultAction: "spawn_resolver" | "post_blocker" | "request_human" | "fail_task";
    }>;
    metadata: z.ZodObject<{
        tags: z.ZodArray<z.ZodString, "many">;
        description: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        description: string;
        tags: string[];
    }, {
        description: string;
        tags: string[];
    }>;
}, "strip", z.ZodTypeAny, {
    slug: string;
    displayName: string;
    origin: "baseline" | "user";
    roleBrief: {
        headline: string;
        bodyMd: string;
        nonGoals: string[];
        styleNotes: string;
    };
    skills: {
        slug: string;
        required: boolean;
        ordering: number;
    }[];
    defaultCapabilityProfile: {
        secrets: string[];
        filesRead: string[];
        filesWrite: string[];
        boardRead: string[];
        boardMutate: string[];
        channelRead: string[];
        channelPost: string[];
        networkEgress: string[];
        spawnSubagent: boolean;
        gitCommit: {
            branchPattern: string;
            pathGlob: string;
        } | null;
        ceremonyRole: "chair" | "participant" | "observer" | "none";
    };
    modelAffinity: {
        rationale: string;
        riskClass: "critical" | "standard" | "low" | "high";
        preferredModel: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
        fallbackModel: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6" | null;
        maxTokensHint: number | null;
    }[];
    escalationPolicy: {
        maxRetries: number;
        rules: {
            trigger: "budget_exhausted" | "verifier_failed" | "capability_denied" | "timeout" | "tool_error_recurrent" | "ambiguous_input";
            action: "spawn_resolver" | "post_blocker" | "request_human" | "fail_task";
            resolverPersona?: string | undefined;
            blockerChannel?: string | undefined;
        }[];
        defaultAction: "spawn_resolver" | "post_blocker" | "request_human" | "fail_task";
    };
    metadata: {
        description: string;
        tags: string[];
    };
}, {
    slug: string;
    displayName: string;
    origin: "baseline" | "user";
    roleBrief: {
        headline: string;
        bodyMd: string;
        styleNotes: string;
        nonGoals?: string[] | undefined;
    };
    skills: {
        slug: string;
        required: boolean;
        ordering: number;
    }[];
    defaultCapabilityProfile: {
        secrets: string[];
        filesRead: string[];
        filesWrite: string[];
        boardRead: string[];
        boardMutate: string[];
        channelRead: string[];
        channelPost: string[];
        networkEgress: string[];
        spawnSubagent: boolean;
        gitCommit: {
            branchPattern: string;
            pathGlob: string;
        } | null;
        ceremonyRole: "chair" | "participant" | "observer" | "none";
    };
    modelAffinity: {
        rationale: string;
        riskClass: "critical" | "standard" | "low" | "high";
        preferredModel: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
        fallbackModel: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6" | null;
        maxTokensHint: number | null;
    }[];
    escalationPolicy: {
        maxRetries: number;
        rules: {
            trigger: "budget_exhausted" | "verifier_failed" | "capability_denied" | "timeout" | "tool_error_recurrent" | "ambiguous_input";
            action: "spawn_resolver" | "post_blocker" | "request_human" | "fail_task";
            resolverPersona?: string | undefined;
            blockerChannel?: string | undefined;
        }[];
        defaultAction: "spawn_resolver" | "post_blocker" | "request_human" | "fail_task";
    };
    metadata: {
        description: string;
        tags: string[];
    };
}>, {
    slug: string;
    displayName: string;
    origin: "baseline" | "user";
    roleBrief: {
        headline: string;
        bodyMd: string;
        nonGoals: string[];
        styleNotes: string;
    };
    skills: {
        slug: string;
        required: boolean;
        ordering: number;
    }[];
    defaultCapabilityProfile: {
        secrets: string[];
        filesRead: string[];
        filesWrite: string[];
        boardRead: string[];
        boardMutate: string[];
        channelRead: string[];
        channelPost: string[];
        networkEgress: string[];
        spawnSubagent: boolean;
        gitCommit: {
            branchPattern: string;
            pathGlob: string;
        } | null;
        ceremonyRole: "chair" | "participant" | "observer" | "none";
    };
    modelAffinity: {
        rationale: string;
        riskClass: "critical" | "standard" | "low" | "high";
        preferredModel: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
        fallbackModel: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6" | null;
        maxTokensHint: number | null;
    }[];
    escalationPolicy: {
        maxRetries: number;
        rules: {
            trigger: "budget_exhausted" | "verifier_failed" | "capability_denied" | "timeout" | "tool_error_recurrent" | "ambiguous_input";
            action: "spawn_resolver" | "post_blocker" | "request_human" | "fail_task";
            resolverPersona?: string | undefined;
            blockerChannel?: string | undefined;
        }[];
        defaultAction: "spawn_resolver" | "post_blocker" | "request_human" | "fail_task";
    };
    metadata: {
        description: string;
        tags: string[];
    };
}, {
    slug: string;
    displayName: string;
    origin: "baseline" | "user";
    roleBrief: {
        headline: string;
        bodyMd: string;
        styleNotes: string;
        nonGoals?: string[] | undefined;
    };
    skills: {
        slug: string;
        required: boolean;
        ordering: number;
    }[];
    defaultCapabilityProfile: {
        secrets: string[];
        filesRead: string[];
        filesWrite: string[];
        boardRead: string[];
        boardMutate: string[];
        channelRead: string[];
        channelPost: string[];
        networkEgress: string[];
        spawnSubagent: boolean;
        gitCommit: {
            branchPattern: string;
            pathGlob: string;
        } | null;
        ceremonyRole: "chair" | "participant" | "observer" | "none";
    };
    modelAffinity: {
        rationale: string;
        riskClass: "critical" | "standard" | "low" | "high";
        preferredModel: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
        fallbackModel: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6" | null;
        maxTokensHint: number | null;
    }[];
    escalationPolicy: {
        maxRetries: number;
        rules: {
            trigger: "budget_exhausted" | "verifier_failed" | "capability_denied" | "timeout" | "tool_error_recurrent" | "ambiguous_input";
            action: "spawn_resolver" | "post_blocker" | "request_human" | "fail_task";
            resolverPersona?: string | undefined;
            blockerChannel?: string | undefined;
        }[];
        defaultAction: "spawn_resolver" | "post_blocker" | "request_human" | "fail_task";
    };
    metadata: {
        description: string;
        tags: string[];
    };
}>;
export type PersonaDefinition = z.infer<typeof PersonaDefinitionSchema>;
export interface Persona {
    personaId: string;
    personaVersionId: string;
    slug: string;
    displayName: string;
    origin: 'baseline' | 'user';
    versionNumber: number;
    roleBriefMd: string;
    definitionHash: string;
    defaultCapabilityProfile: DefaultCapabilityProfile;
    modelAffinity: ModelAffinityEntry[];
    escalationPolicy: EscalationPolicy;
    skills: SkillRef[];
    metadata: {
        tags: string[];
        description: string;
    };
    isArchived: boolean;
}
//# sourceMappingURL=types.d.ts.map