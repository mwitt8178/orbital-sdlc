/**
 * vision/types.ts — Domain types and Zod schemas for the vision intake module.
 *
 * Per TRD-01 §4.1, §4.2, §5.
 * All branded ID types come from @orbital/types.
 */
import { z } from 'zod';
type Brand<T, B> = T & {
    readonly __brand: B;
};
export type VisionDocumentId = Brand<string, 'VisionDocumentId'>;
export type VisionVersionId = Brand<string, 'VisionVersionId'>;
export type VisionSessionId = Brand<string, 'VisionSessionId'>;
export type VisionMessageId = Brand<string, 'VisionMessageId'>;
export type VisionQuestionId = Brand<string, 'VisionQuestionId'>;
export type VisionAnswerId = Brand<string, 'VisionAnswerId'>;
export type VisionAssumptionId = Brand<string, 'VisionAssumptionId'>;
export declare const asVisionDocumentId: (s: string) => VisionDocumentId;
export declare const asVisionSessionId: (s: string) => VisionSessionId;
export declare const asVisionVersionId: (s: string) => VisionVersionId;
export declare const GoalSchema: z.ZodObject<{
    id: z.ZodString;
    text: z.ZodString;
    rank: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    id: string;
    text: string;
    rank: number;
}, {
    id: string;
    text: string;
    rank: number;
}>;
export declare const NonGoalSchema: z.ZodObject<{
    id: z.ZodString;
    text: z.ZodString;
}, "strip", z.ZodTypeAny, {
    id: string;
    text: string;
}, {
    id: string;
    text: string;
}>;
export declare const TargetUserSchema: z.ZodObject<{
    id: z.ZodString;
    segment: z.ZodString;
    description: z.ZodString;
    primary: z.ZodDefault<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    description: string;
    primary: boolean;
    id: string;
    segment: string;
}, {
    description: string;
    id: string;
    segment: string;
    primary?: boolean | undefined;
}>;
export declare const AcceptanceCriterionSchema: z.ZodObject<{
    id: z.ZodString;
    text: z.ZodString;
    rank: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    id: string;
    text: string;
    rank: number;
}, {
    id: string;
    text: string;
    rank: number;
}>;
export declare const GlossaryEntrySchema: z.ZodObject<{
    term: z.ZodString;
    definition: z.ZodString;
}, "strip", z.ZodTypeAny, {
    term: string;
    definition: string;
}, {
    term: string;
    definition: string;
}>;
export declare const EdgeCaseSchema: z.ZodObject<{
    id: z.ZodString;
    text: z.ZodString;
    surfaced_by: z.ZodEnum<["user", "pm_persona"]>;
}, "strip", z.ZodTypeAny, {
    id: string;
    text: string;
    surfaced_by: "user" | "pm_persona";
}, {
    id: string;
    text: string;
    surfaced_by: "user" | "pm_persona";
}>;
export declare const OpenQuestionSchema: z.ZodObject<{
    id: z.ZodString;
    text: z.ZodString;
    raised_at: z.ZodString;
    raised_by: z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
        type: z.ZodLiteral<"persona">;
        persona_id: z.ZodString;
        session_id: z.ZodString;
        task_id: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        type: "persona";
        persona_id: string;
        session_id: string;
        task_id?: string | undefined;
    }, {
        type: "persona";
        persona_id: string;
        session_id: string;
        task_id?: string | undefined;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"user">;
        user_id: z.ZodString;
        install_id: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        type: "user";
        user_id: string;
        install_id: string;
    }, {
        type: "user";
        user_id: string;
        install_id: string;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"system">;
        component: z.ZodEnum<["orchestrator", "scheduler", "mcp_gateway", "capability_authority", "audit_service", "retro_service", "reconciler", "hook_engine", "ceremony_scheduler"]>;
    }, "strip", z.ZodTypeAny, {
        type: "system";
        component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
    }, {
        type: "system";
        component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
    }>, z.ZodObject<{
        type: z.ZodLiteral<"hook">;
        hook_id: z.ZodString;
        hook_version: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        type: "hook";
        hook_id: string;
        hook_version: string;
    }, {
        type: "hook";
        hook_id: string;
        hook_version: string;
    }>]>;
    blocking: z.ZodDefault<z.ZodBoolean>;
    resolved_at: z.ZodOptional<z.ZodString>;
    resolution_summary: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    blocking: boolean;
    id: string;
    text: string;
    raised_at: string;
    raised_by: {
        type: "persona";
        persona_id: string;
        session_id: string;
        task_id?: string | undefined;
    } | {
        type: "user";
        user_id: string;
        install_id: string;
    } | {
        type: "system";
        component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
    } | {
        type: "hook";
        hook_id: string;
        hook_version: string;
    };
    resolved_at?: string | undefined;
    resolution_summary?: string | undefined;
}, {
    id: string;
    text: string;
    raised_at: string;
    raised_by: {
        type: "persona";
        persona_id: string;
        session_id: string;
        task_id?: string | undefined;
    } | {
        type: "user";
        user_id: string;
        install_id: string;
    } | {
        type: "system";
        component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
    } | {
        type: "hook";
        hook_id: string;
        hook_version: string;
    };
    blocking?: boolean | undefined;
    resolved_at?: string | undefined;
    resolution_summary?: string | undefined;
}>;
export declare const AssumptionSchema: z.ZodObject<{
    id: z.ZodString;
    text: z.ZodString;
    appended_at: z.ZodString;
    appended_by: z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
        type: z.ZodLiteral<"persona">;
        persona_id: z.ZodString;
        session_id: z.ZodString;
        task_id: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        type: "persona";
        persona_id: string;
        session_id: string;
        task_id?: string | undefined;
    }, {
        type: "persona";
        persona_id: string;
        session_id: string;
        task_id?: string | undefined;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"user">;
        user_id: z.ZodString;
        install_id: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        type: "user";
        user_id: string;
        install_id: string;
    }, {
        type: "user";
        user_id: string;
        install_id: string;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"system">;
        component: z.ZodEnum<["orchestrator", "scheduler", "mcp_gateway", "capability_authority", "audit_service", "retro_service", "reconciler", "hook_engine", "ceremony_scheduler"]>;
    }, "strip", z.ZodTypeAny, {
        type: "system";
        component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
    }, {
        type: "system";
        component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
    }>, z.ZodObject<{
        type: z.ZodLiteral<"hook">;
        hook_id: z.ZodString;
        hook_version: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        type: "hook";
        hook_id: string;
        hook_version: string;
    }, {
        type: "hook";
        hook_id: string;
        hook_version: string;
    }>]>;
    confidence: z.ZodDefault<z.ZodEnum<["low", "medium", "high"]>>;
    evidence_link: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    id: string;
    text: string;
    confidence: "low" | "high" | "medium";
    appended_at: string;
    appended_by: {
        type: "persona";
        persona_id: string;
        session_id: string;
        task_id?: string | undefined;
    } | {
        type: "user";
        user_id: string;
        install_id: string;
    } | {
        type: "system";
        component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
    } | {
        type: "hook";
        hook_id: string;
        hook_version: string;
    };
    evidence_link?: string | undefined;
}, {
    id: string;
    text: string;
    appended_at: string;
    appended_by: {
        type: "persona";
        persona_id: string;
        session_id: string;
        task_id?: string | undefined;
    } | {
        type: "user";
        user_id: string;
        install_id: string;
    } | {
        type: "system";
        component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
    } | {
        type: "hook";
        hook_id: string;
        hook_version: string;
    };
    confidence?: "low" | "high" | "medium" | undefined;
    evidence_link?: string | undefined;
}>;
export declare const VisionDocumentContentSchema: z.ZodObject<{
    schema_version: z.ZodLiteral<1>;
    title: z.ZodString;
    summary: z.ZodString;
    goals: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        text: z.ZodString;
        rank: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        id: string;
        text: string;
        rank: number;
    }, {
        id: string;
        text: string;
        rank: number;
    }>, "many">;
    non_goals: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        text: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        id: string;
        text: string;
    }, {
        id: string;
        text: string;
    }>, "many">;
    target_users: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        segment: z.ZodString;
        description: z.ZodString;
        primary: z.ZodDefault<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        description: string;
        primary: boolean;
        id: string;
        segment: string;
    }, {
        description: string;
        id: string;
        segment: string;
        primary?: boolean | undefined;
    }>, "many">;
    acceptance_criteria: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        text: z.ZodString;
        rank: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        id: string;
        text: string;
        rank: number;
    }, {
        id: string;
        text: string;
        rank: number;
    }>, "many">;
    glossary: z.ZodArray<z.ZodObject<{
        term: z.ZodString;
        definition: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        term: string;
        definition: string;
    }, {
        term: string;
        definition: string;
    }>, "many">;
    edge_cases: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        text: z.ZodString;
        surfaced_by: z.ZodEnum<["user", "pm_persona"]>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        text: string;
        surfaced_by: "user" | "pm_persona";
    }, {
        id: string;
        text: string;
        surfaced_by: "user" | "pm_persona";
    }>, "many">;
    open_questions: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        text: z.ZodString;
        raised_at: z.ZodString;
        raised_by: z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
            type: z.ZodLiteral<"persona">;
            persona_id: z.ZodString;
            session_id: z.ZodString;
            task_id: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            type: "persona";
            persona_id: string;
            session_id: string;
            task_id?: string | undefined;
        }, {
            type: "persona";
            persona_id: string;
            session_id: string;
            task_id?: string | undefined;
        }>, z.ZodObject<{
            type: z.ZodLiteral<"user">;
            user_id: z.ZodString;
            install_id: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            type: "user";
            user_id: string;
            install_id: string;
        }, {
            type: "user";
            user_id: string;
            install_id: string;
        }>, z.ZodObject<{
            type: z.ZodLiteral<"system">;
            component: z.ZodEnum<["orchestrator", "scheduler", "mcp_gateway", "capability_authority", "audit_service", "retro_service", "reconciler", "hook_engine", "ceremony_scheduler"]>;
        }, "strip", z.ZodTypeAny, {
            type: "system";
            component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
        }, {
            type: "system";
            component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
        }>, z.ZodObject<{
            type: z.ZodLiteral<"hook">;
            hook_id: z.ZodString;
            hook_version: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            type: "hook";
            hook_id: string;
            hook_version: string;
        }, {
            type: "hook";
            hook_id: string;
            hook_version: string;
        }>]>;
        blocking: z.ZodDefault<z.ZodBoolean>;
        resolved_at: z.ZodOptional<z.ZodString>;
        resolution_summary: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        blocking: boolean;
        id: string;
        text: string;
        raised_at: string;
        raised_by: {
            type: "persona";
            persona_id: string;
            session_id: string;
            task_id?: string | undefined;
        } | {
            type: "user";
            user_id: string;
            install_id: string;
        } | {
            type: "system";
            component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
        } | {
            type: "hook";
            hook_id: string;
            hook_version: string;
        };
        resolved_at?: string | undefined;
        resolution_summary?: string | undefined;
    }, {
        id: string;
        text: string;
        raised_at: string;
        raised_by: {
            type: "persona";
            persona_id: string;
            session_id: string;
            task_id?: string | undefined;
        } | {
            type: "user";
            user_id: string;
            install_id: string;
        } | {
            type: "system";
            component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
        } | {
            type: "hook";
            hook_id: string;
            hook_version: string;
        };
        blocking?: boolean | undefined;
        resolved_at?: string | undefined;
        resolution_summary?: string | undefined;
    }>, "many">;
    assumptions_log: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        text: z.ZodString;
        appended_at: z.ZodString;
        appended_by: z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
            type: z.ZodLiteral<"persona">;
            persona_id: z.ZodString;
            session_id: z.ZodString;
            task_id: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            type: "persona";
            persona_id: string;
            session_id: string;
            task_id?: string | undefined;
        }, {
            type: "persona";
            persona_id: string;
            session_id: string;
            task_id?: string | undefined;
        }>, z.ZodObject<{
            type: z.ZodLiteral<"user">;
            user_id: z.ZodString;
            install_id: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            type: "user";
            user_id: string;
            install_id: string;
        }, {
            type: "user";
            user_id: string;
            install_id: string;
        }>, z.ZodObject<{
            type: z.ZodLiteral<"system">;
            component: z.ZodEnum<["orchestrator", "scheduler", "mcp_gateway", "capability_authority", "audit_service", "retro_service", "reconciler", "hook_engine", "ceremony_scheduler"]>;
        }, "strip", z.ZodTypeAny, {
            type: "system";
            component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
        }, {
            type: "system";
            component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
        }>, z.ZodObject<{
            type: z.ZodLiteral<"hook">;
            hook_id: z.ZodString;
            hook_version: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            type: "hook";
            hook_id: string;
            hook_version: string;
        }, {
            type: "hook";
            hook_id: string;
            hook_version: string;
        }>]>;
        confidence: z.ZodDefault<z.ZodEnum<["low", "medium", "high"]>>;
        evidence_link: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        text: string;
        confidence: "low" | "high" | "medium";
        appended_at: string;
        appended_by: {
            type: "persona";
            persona_id: string;
            session_id: string;
            task_id?: string | undefined;
        } | {
            type: "user";
            user_id: string;
            install_id: string;
        } | {
            type: "system";
            component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
        } | {
            type: "hook";
            hook_id: string;
            hook_version: string;
        };
        evidence_link?: string | undefined;
    }, {
        id: string;
        text: string;
        appended_at: string;
        appended_by: {
            type: "persona";
            persona_id: string;
            session_id: string;
            task_id?: string | undefined;
        } | {
            type: "user";
            user_id: string;
            install_id: string;
        } | {
            type: "system";
            component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
        } | {
            type: "hook";
            hook_id: string;
            hook_version: string;
        };
        confidence?: "low" | "high" | "medium" | undefined;
        evidence_link?: string | undefined;
    }>, "many">;
    metadata: z.ZodObject<{
        pm_persona_id: z.ZodString;
        model_used: z.ZodString;
        intake_started_at: z.ZodString;
        intake_token_total: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        pm_persona_id: string;
        model_used: string;
        intake_started_at: string;
        intake_token_total: number;
    }, {
        pm_persona_id: string;
        model_used: string;
        intake_started_at: string;
        intake_token_total: number;
    }>;
}, "strip", z.ZodTypeAny, {
    schema_version: 1;
    summary: string;
    title: string;
    acceptance_criteria: {
        id: string;
        text: string;
        rank: number;
    }[];
    metadata: {
        pm_persona_id: string;
        model_used: string;
        intake_started_at: string;
        intake_token_total: number;
    };
    glossary: {
        term: string;
        definition: string;
    }[];
    open_questions: {
        blocking: boolean;
        id: string;
        text: string;
        raised_at: string;
        raised_by: {
            type: "persona";
            persona_id: string;
            session_id: string;
            task_id?: string | undefined;
        } | {
            type: "user";
            user_id: string;
            install_id: string;
        } | {
            type: "system";
            component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
        } | {
            type: "hook";
            hook_id: string;
            hook_version: string;
        };
        resolved_at?: string | undefined;
        resolution_summary?: string | undefined;
    }[];
    goals: {
        id: string;
        text: string;
        rank: number;
    }[];
    non_goals: {
        id: string;
        text: string;
    }[];
    target_users: {
        description: string;
        primary: boolean;
        id: string;
        segment: string;
    }[];
    edge_cases: {
        id: string;
        text: string;
        surfaced_by: "user" | "pm_persona";
    }[];
    assumptions_log: {
        id: string;
        text: string;
        confidence: "low" | "high" | "medium";
        appended_at: string;
        appended_by: {
            type: "persona";
            persona_id: string;
            session_id: string;
            task_id?: string | undefined;
        } | {
            type: "user";
            user_id: string;
            install_id: string;
        } | {
            type: "system";
            component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
        } | {
            type: "hook";
            hook_id: string;
            hook_version: string;
        };
        evidence_link?: string | undefined;
    }[];
}, {
    schema_version: 1;
    summary: string;
    title: string;
    acceptance_criteria: {
        id: string;
        text: string;
        rank: number;
    }[];
    metadata: {
        pm_persona_id: string;
        model_used: string;
        intake_started_at: string;
        intake_token_total: number;
    };
    glossary: {
        term: string;
        definition: string;
    }[];
    open_questions: {
        id: string;
        text: string;
        raised_at: string;
        raised_by: {
            type: "persona";
            persona_id: string;
            session_id: string;
            task_id?: string | undefined;
        } | {
            type: "user";
            user_id: string;
            install_id: string;
        } | {
            type: "system";
            component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
        } | {
            type: "hook";
            hook_id: string;
            hook_version: string;
        };
        blocking?: boolean | undefined;
        resolved_at?: string | undefined;
        resolution_summary?: string | undefined;
    }[];
    goals: {
        id: string;
        text: string;
        rank: number;
    }[];
    non_goals: {
        id: string;
        text: string;
    }[];
    target_users: {
        description: string;
        id: string;
        segment: string;
        primary?: boolean | undefined;
    }[];
    edge_cases: {
        id: string;
        text: string;
        surfaced_by: "user" | "pm_persona";
    }[];
    assumptions_log: {
        id: string;
        text: string;
        appended_at: string;
        appended_by: {
            type: "persona";
            persona_id: string;
            session_id: string;
            task_id?: string | undefined;
        } | {
            type: "user";
            user_id: string;
            install_id: string;
        } | {
            type: "system";
            component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
        } | {
            type: "hook";
            hook_id: string;
            hook_version: string;
        };
        confidence?: "low" | "high" | "medium" | undefined;
        evidence_link?: string | undefined;
    }[];
}>;
export type VisionDocumentContent = z.infer<typeof VisionDocumentContentSchema>;
export declare const VisionDocumentContentDraftSchema: z.ZodObject<{
    schema_version: z.ZodLiteral<1>;
    title: z.ZodString;
    summary: z.ZodString;
    goals: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        text: z.ZodString;
        rank: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        id: string;
        text: string;
        rank: number;
    }, {
        id: string;
        text: string;
        rank: number;
    }>, "many">>>;
    non_goals: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        text: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        id: string;
        text: string;
    }, {
        id: string;
        text: string;
    }>, "many">>>;
    target_users: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        segment: z.ZodString;
        description: z.ZodString;
        primary: z.ZodDefault<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        description: string;
        primary: boolean;
        id: string;
        segment: string;
    }, {
        description: string;
        id: string;
        segment: string;
        primary?: boolean | undefined;
    }>, "many">>>;
    acceptance_criteria: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        text: z.ZodString;
        rank: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        id: string;
        text: string;
        rank: number;
    }, {
        id: string;
        text: string;
        rank: number;
    }>, "many">>>;
    glossary: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodObject<{
        term: z.ZodString;
        definition: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        term: string;
        definition: string;
    }, {
        term: string;
        definition: string;
    }>, "many">>>;
    edge_cases: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        text: z.ZodString;
        surfaced_by: z.ZodEnum<["user", "pm_persona"]>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        text: string;
        surfaced_by: "user" | "pm_persona";
    }, {
        id: string;
        text: string;
        surfaced_by: "user" | "pm_persona";
    }>, "many">>>;
    open_questions: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        text: z.ZodString;
        raised_at: z.ZodString;
        raised_by: z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
            type: z.ZodLiteral<"persona">;
            persona_id: z.ZodString;
            session_id: z.ZodString;
            task_id: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            type: "persona";
            persona_id: string;
            session_id: string;
            task_id?: string | undefined;
        }, {
            type: "persona";
            persona_id: string;
            session_id: string;
            task_id?: string | undefined;
        }>, z.ZodObject<{
            type: z.ZodLiteral<"user">;
            user_id: z.ZodString;
            install_id: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            type: "user";
            user_id: string;
            install_id: string;
        }, {
            type: "user";
            user_id: string;
            install_id: string;
        }>, z.ZodObject<{
            type: z.ZodLiteral<"system">;
            component: z.ZodEnum<["orchestrator", "scheduler", "mcp_gateway", "capability_authority", "audit_service", "retro_service", "reconciler", "hook_engine", "ceremony_scheduler"]>;
        }, "strip", z.ZodTypeAny, {
            type: "system";
            component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
        }, {
            type: "system";
            component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
        }>, z.ZodObject<{
            type: z.ZodLiteral<"hook">;
            hook_id: z.ZodString;
            hook_version: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            type: "hook";
            hook_id: string;
            hook_version: string;
        }, {
            type: "hook";
            hook_id: string;
            hook_version: string;
        }>]>;
        blocking: z.ZodDefault<z.ZodBoolean>;
        resolved_at: z.ZodOptional<z.ZodString>;
        resolution_summary: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        blocking: boolean;
        id: string;
        text: string;
        raised_at: string;
        raised_by: {
            type: "persona";
            persona_id: string;
            session_id: string;
            task_id?: string | undefined;
        } | {
            type: "user";
            user_id: string;
            install_id: string;
        } | {
            type: "system";
            component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
        } | {
            type: "hook";
            hook_id: string;
            hook_version: string;
        };
        resolved_at?: string | undefined;
        resolution_summary?: string | undefined;
    }, {
        id: string;
        text: string;
        raised_at: string;
        raised_by: {
            type: "persona";
            persona_id: string;
            session_id: string;
            task_id?: string | undefined;
        } | {
            type: "user";
            user_id: string;
            install_id: string;
        } | {
            type: "system";
            component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
        } | {
            type: "hook";
            hook_id: string;
            hook_version: string;
        };
        blocking?: boolean | undefined;
        resolved_at?: string | undefined;
        resolution_summary?: string | undefined;
    }>, "many">>>;
    assumptions_log: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        text: z.ZodString;
        appended_at: z.ZodString;
        appended_by: z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
            type: z.ZodLiteral<"persona">;
            persona_id: z.ZodString;
            session_id: z.ZodString;
            task_id: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            type: "persona";
            persona_id: string;
            session_id: string;
            task_id?: string | undefined;
        }, {
            type: "persona";
            persona_id: string;
            session_id: string;
            task_id?: string | undefined;
        }>, z.ZodObject<{
            type: z.ZodLiteral<"user">;
            user_id: z.ZodString;
            install_id: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            type: "user";
            user_id: string;
            install_id: string;
        }, {
            type: "user";
            user_id: string;
            install_id: string;
        }>, z.ZodObject<{
            type: z.ZodLiteral<"system">;
            component: z.ZodEnum<["orchestrator", "scheduler", "mcp_gateway", "capability_authority", "audit_service", "retro_service", "reconciler", "hook_engine", "ceremony_scheduler"]>;
        }, "strip", z.ZodTypeAny, {
            type: "system";
            component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
        }, {
            type: "system";
            component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
        }>, z.ZodObject<{
            type: z.ZodLiteral<"hook">;
            hook_id: z.ZodString;
            hook_version: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            type: "hook";
            hook_id: string;
            hook_version: string;
        }, {
            type: "hook";
            hook_id: string;
            hook_version: string;
        }>]>;
        confidence: z.ZodDefault<z.ZodEnum<["low", "medium", "high"]>>;
        evidence_link: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        text: string;
        confidence: "low" | "high" | "medium";
        appended_at: string;
        appended_by: {
            type: "persona";
            persona_id: string;
            session_id: string;
            task_id?: string | undefined;
        } | {
            type: "user";
            user_id: string;
            install_id: string;
        } | {
            type: "system";
            component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
        } | {
            type: "hook";
            hook_id: string;
            hook_version: string;
        };
        evidence_link?: string | undefined;
    }, {
        id: string;
        text: string;
        appended_at: string;
        appended_by: {
            type: "persona";
            persona_id: string;
            session_id: string;
            task_id?: string | undefined;
        } | {
            type: "user";
            user_id: string;
            install_id: string;
        } | {
            type: "system";
            component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
        } | {
            type: "hook";
            hook_id: string;
            hook_version: string;
        };
        confidence?: "low" | "high" | "medium" | undefined;
        evidence_link?: string | undefined;
    }>, "many">>>;
    metadata: z.ZodObject<{
        pm_persona_id: z.ZodString;
        model_used: z.ZodString;
        intake_started_at: z.ZodString;
        intake_token_total: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        pm_persona_id: string;
        model_used: string;
        intake_started_at: string;
        intake_token_total: number;
    }, {
        pm_persona_id: string;
        model_used: string;
        intake_started_at: string;
        intake_token_total: number;
    }>;
}, "strip", z.ZodTypeAny, {
    schema_version: 1;
    summary: string;
    title: string;
    acceptance_criteria: {
        id: string;
        text: string;
        rank: number;
    }[];
    metadata: {
        pm_persona_id: string;
        model_used: string;
        intake_started_at: string;
        intake_token_total: number;
    };
    glossary: {
        term: string;
        definition: string;
    }[];
    open_questions: {
        blocking: boolean;
        id: string;
        text: string;
        raised_at: string;
        raised_by: {
            type: "persona";
            persona_id: string;
            session_id: string;
            task_id?: string | undefined;
        } | {
            type: "user";
            user_id: string;
            install_id: string;
        } | {
            type: "system";
            component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
        } | {
            type: "hook";
            hook_id: string;
            hook_version: string;
        };
        resolved_at?: string | undefined;
        resolution_summary?: string | undefined;
    }[];
    goals: {
        id: string;
        text: string;
        rank: number;
    }[];
    non_goals: {
        id: string;
        text: string;
    }[];
    target_users: {
        description: string;
        primary: boolean;
        id: string;
        segment: string;
    }[];
    edge_cases: {
        id: string;
        text: string;
        surfaced_by: "user" | "pm_persona";
    }[];
    assumptions_log: {
        id: string;
        text: string;
        confidence: "low" | "high" | "medium";
        appended_at: string;
        appended_by: {
            type: "persona";
            persona_id: string;
            session_id: string;
            task_id?: string | undefined;
        } | {
            type: "user";
            user_id: string;
            install_id: string;
        } | {
            type: "system";
            component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
        } | {
            type: "hook";
            hook_id: string;
            hook_version: string;
        };
        evidence_link?: string | undefined;
    }[];
}, {
    schema_version: 1;
    summary: string;
    title: string;
    metadata: {
        pm_persona_id: string;
        model_used: string;
        intake_started_at: string;
        intake_token_total: number;
    };
    acceptance_criteria?: {
        id: string;
        text: string;
        rank: number;
    }[] | undefined;
    glossary?: {
        term: string;
        definition: string;
    }[] | undefined;
    open_questions?: {
        id: string;
        text: string;
        raised_at: string;
        raised_by: {
            type: "persona";
            persona_id: string;
            session_id: string;
            task_id?: string | undefined;
        } | {
            type: "user";
            user_id: string;
            install_id: string;
        } | {
            type: "system";
            component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
        } | {
            type: "hook";
            hook_id: string;
            hook_version: string;
        };
        blocking?: boolean | undefined;
        resolved_at?: string | undefined;
        resolution_summary?: string | undefined;
    }[] | undefined;
    goals?: {
        id: string;
        text: string;
        rank: number;
    }[] | undefined;
    non_goals?: {
        id: string;
        text: string;
    }[] | undefined;
    target_users?: {
        description: string;
        id: string;
        segment: string;
        primary?: boolean | undefined;
    }[] | undefined;
    edge_cases?: {
        id: string;
        text: string;
        surfaced_by: "user" | "pm_persona";
    }[] | undefined;
    assumptions_log?: {
        id: string;
        text: string;
        appended_at: string;
        appended_by: {
            type: "persona";
            persona_id: string;
            session_id: string;
            task_id?: string | undefined;
        } | {
            type: "user";
            user_id: string;
            install_id: string;
        } | {
            type: "system";
            component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
        } | {
            type: "hook";
            hook_id: string;
            hook_version: string;
        };
        confidence?: "low" | "high" | "medium" | undefined;
        evidence_link?: string | undefined;
    }[] | undefined;
}>;
export type VisionDocumentContentDraft = z.infer<typeof VisionDocumentContentDraftSchema>;
export declare const VisionSessionStartedPayloadSchemaV1: z.ZodObject<{
    vision_session_id: z.ZodString;
    vision_document_id: z.ZodString;
    initial_prompt: z.ZodString;
    pm_persona_request_id: z.ZodString;
    expected_required_capabilities: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
}, "strip", z.ZodTypeAny, {
    vision_document_id: string;
    vision_session_id: string;
    initial_prompt: string;
    pm_persona_request_id: string;
    expected_required_capabilities: string[];
}, {
    vision_document_id: string;
    vision_session_id: string;
    initial_prompt: string;
    pm_persona_request_id: string;
    expected_required_capabilities?: string[] | undefined;
}>;
export declare const VisionMessageSentPayloadSchemaV1: z.ZodObject<{
    vision_session_id: z.ZodString;
    vision_message_id: z.ZodString;
    author_type: z.ZodEnum<["user", "pm_persona"]>;
    body: z.ZodString;
    parent_message_id: z.ZodOptional<z.ZodString>;
    body_tokens: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    vision_session_id: string;
    vision_message_id: string;
    author_type: "user" | "pm_persona";
    body: string;
    body_tokens: number;
    parent_message_id?: string | undefined;
}, {
    vision_session_id: string;
    vision_message_id: string;
    author_type: "user" | "pm_persona";
    body: string;
    body_tokens: number;
    parent_message_id?: string | undefined;
}>;
export declare const VisionDraftedPayloadSchemaV1: z.ZodObject<{
    vision_session_id: z.ZodString;
    vision_document_id: z.ZodString;
    vision_version_id: z.ZodString;
    version_number: z.ZodNumber;
    content_hash: z.ZodString;
    draft_summary: z.ZodString;
    open_questions_count: z.ZodNumber;
    is_locked: z.ZodLiteral<false>;
}, "strip", z.ZodTypeAny, {
    version_number: number;
    content_hash: string;
    vision_document_id: string;
    vision_version_id: string;
    is_locked: false;
    vision_session_id: string;
    draft_summary: string;
    open_questions_count: number;
}, {
    version_number: number;
    content_hash: string;
    vision_document_id: string;
    vision_version_id: string;
    is_locked: false;
    vision_session_id: string;
    draft_summary: string;
    open_questions_count: number;
}>;
export declare const VisionAmbiguityRaisedPayloadSchemaV1: z.ZodObject<{
    vision_session_id: z.ZodString;
    vision_document_id: z.ZodString;
    vision_question_id: z.ZodString;
    prompt: z.ZodString;
    category: z.ZodEnum<["goal", "non_goal", "target_user", "edge_case", "glossary", "ambiguity", "other"]>;
    detected_signal: z.ZodString;
    proposed_resolution: z.ZodOptional<z.ZodString>;
    blocking: z.ZodBoolean;
}, "strip", z.ZodTypeAny, {
    blocking: boolean;
    vision_document_id: string;
    vision_session_id: string;
    vision_question_id: string;
    prompt: string;
    category: "glossary" | "goal" | "non_goal" | "target_user" | "edge_case" | "ambiguity" | "other";
    detected_signal: string;
    proposed_resolution?: string | undefined;
}, {
    blocking: boolean;
    vision_document_id: string;
    vision_session_id: string;
    vision_question_id: string;
    prompt: string;
    category: "glossary" | "goal" | "non_goal" | "target_user" | "edge_case" | "ambiguity" | "other";
    detected_signal: string;
    proposed_resolution?: string | undefined;
}>;
export declare const VisionLockedPayloadSchemaV1: z.ZodObject<{
    vision_document_id: z.ZodString;
    vision_version_id: z.ZodString;
    version_number: z.ZodNumber;
    content_hash: z.ZodString;
    locked_by: z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
        type: z.ZodLiteral<"persona">;
        persona_id: z.ZodString;
        session_id: z.ZodString;
        task_id: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        type: "persona";
        persona_id: string;
        session_id: string;
        task_id?: string | undefined;
    }, {
        type: "persona";
        persona_id: string;
        session_id: string;
        task_id?: string | undefined;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"user">;
        user_id: z.ZodString;
        install_id: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        type: "user";
        user_id: string;
        install_id: string;
    }, {
        type: "user";
        user_id: string;
        install_id: string;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"system">;
        component: z.ZodEnum<["orchestrator", "scheduler", "mcp_gateway", "capability_authority", "audit_service", "retro_service", "reconciler", "hook_engine", "ceremony_scheduler"]>;
    }, "strip", z.ZodTypeAny, {
        type: "system";
        component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
    }, {
        type: "system";
        component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
    }>, z.ZodObject<{
        type: z.ZodLiteral<"hook">;
        hook_id: z.ZodString;
        hook_version: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        type: "hook";
        hook_id: string;
        hook_version: string;
    }, {
        type: "hook";
        hook_id: string;
        hook_version: string;
    }>]>;
    monday_item_id: z.ZodOptional<z.ZodString>;
    changelog: z.ZodString;
    attestation: z.ZodObject<{
        no_edge_cases: z.ZodDefault<z.ZodBoolean>;
        confirmation_token: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        no_edge_cases: boolean;
        confirmation_token: string;
    }, {
        confirmation_token: string;
        no_edge_cases?: boolean | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    version_number: number;
    content_hash: string;
    vision_document_id: string;
    vision_version_id: string;
    changelog: string;
    locked_by: {
        type: "persona";
        persona_id: string;
        session_id: string;
        task_id?: string | undefined;
    } | {
        type: "user";
        user_id: string;
        install_id: string;
    } | {
        type: "system";
        component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
    } | {
        type: "hook";
        hook_id: string;
        hook_version: string;
    };
    attestation: {
        no_edge_cases: boolean;
        confirmation_token: string;
    };
    monday_item_id?: string | undefined;
}, {
    version_number: number;
    content_hash: string;
    vision_document_id: string;
    vision_version_id: string;
    changelog: string;
    locked_by: {
        type: "persona";
        persona_id: string;
        session_id: string;
        task_id?: string | undefined;
    } | {
        type: "user";
        user_id: string;
        install_id: string;
    } | {
        type: "system";
        component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
    } | {
        type: "hook";
        hook_id: string;
        hook_version: string;
    };
    attestation: {
        confirmation_token: string;
        no_edge_cases?: boolean | undefined;
    };
    monday_item_id?: string | undefined;
}>;
export declare const VisionRevisedPayloadSchemaV1: z.ZodObject<{
    vision_document_id: z.ZodString;
    prior_version_id: z.ZodString;
    prior_version_number: z.ZodNumber;
    new_version_id: z.ZodString;
    new_version_number: z.ZodNumber;
    delta: z.ZodArray<z.ZodRecord<z.ZodString, z.ZodAny>, "many">;
    changelog: z.ZodString;
    revised_by: z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
        type: z.ZodLiteral<"persona">;
        persona_id: z.ZodString;
        session_id: z.ZodString;
        task_id: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        type: "persona";
        persona_id: string;
        session_id: string;
        task_id?: string | undefined;
    }, {
        type: "persona";
        persona_id: string;
        session_id: string;
        task_id?: string | undefined;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"user">;
        user_id: z.ZodString;
        install_id: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        type: "user";
        user_id: string;
        install_id: string;
    }, {
        type: "user";
        user_id: string;
        install_id: string;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"system">;
        component: z.ZodEnum<["orchestrator", "scheduler", "mcp_gateway", "capability_authority", "audit_service", "retro_service", "reconciler", "hook_engine", "ceremony_scheduler"]>;
    }, "strip", z.ZodTypeAny, {
        type: "system";
        component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
    }, {
        type: "system";
        component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
    }>, z.ZodObject<{
        type: z.ZodLiteral<"hook">;
        hook_id: z.ZodString;
        hook_version: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        type: "hook";
        hook_id: string;
        hook_version: string;
    }, {
        type: "hook";
        hook_id: string;
        hook_version: string;
    }>]>;
    reason: z.ZodEnum<["user_initiated", "architect_feedback", "uat_defect", "retro_proposal"]>;
}, "strip", z.ZodTypeAny, {
    reason: "user_initiated" | "architect_feedback" | "uat_defect" | "retro_proposal";
    vision_document_id: string;
    changelog: string;
    prior_version_id: string;
    prior_version_number: number;
    new_version_id: string;
    new_version_number: number;
    delta: Record<string, any>[];
    revised_by: {
        type: "persona";
        persona_id: string;
        session_id: string;
        task_id?: string | undefined;
    } | {
        type: "user";
        user_id: string;
        install_id: string;
    } | {
        type: "system";
        component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
    } | {
        type: "hook";
        hook_id: string;
        hook_version: string;
    };
}, {
    reason: "user_initiated" | "architect_feedback" | "uat_defect" | "retro_proposal";
    vision_document_id: string;
    changelog: string;
    prior_version_id: string;
    prior_version_number: number;
    new_version_id: string;
    new_version_number: number;
    delta: Record<string, any>[];
    revised_by: {
        type: "persona";
        persona_id: string;
        session_id: string;
        task_id?: string | undefined;
    } | {
        type: "user";
        user_id: string;
        install_id: string;
    } | {
        type: "system";
        component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
    } | {
        type: "hook";
        hook_id: string;
        hook_version: string;
    };
}>;
export declare const VisionLockRejectedPayloadSchemaV1: z.ZodObject<{
    vision_document_id: z.ZodString;
    attempted_version_id: z.ZodString;
    rejecting_party: z.ZodEnum<["validator", "hook_engine"]>;
    error_code: z.ZodString;
    missing_fields: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    blocking_open_questions: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    hook_id: z.ZodOptional<z.ZodString>;
    hook_message: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    error_code: string;
    vision_document_id: string;
    attempted_version_id: string;
    rejecting_party: "hook_engine" | "validator";
    missing_fields: string[];
    blocking_open_questions: string[];
    hook_id?: string | undefined;
    hook_message?: string | undefined;
}, {
    error_code: string;
    vision_document_id: string;
    attempted_version_id: string;
    rejecting_party: "hook_engine" | "validator";
    hook_id?: string | undefined;
    missing_fields?: string[] | undefined;
    blocking_open_questions?: string[] | undefined;
    hook_message?: string | undefined;
}>;
export declare const AuditMetadataInputSchema: z.ZodObject<{
    actor: z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
        type: z.ZodLiteral<"persona">;
        persona_id: z.ZodString;
        session_id: z.ZodString;
        task_id: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        type: "persona";
        persona_id: string;
        session_id: string;
        task_id?: string | undefined;
    }, {
        type: "persona";
        persona_id: string;
        session_id: string;
        task_id?: string | undefined;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"user">;
        user_id: z.ZodString;
        install_id: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        type: "user";
        user_id: string;
        install_id: string;
    }, {
        type: "user";
        user_id: string;
        install_id: string;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"system">;
        component: z.ZodEnum<["orchestrator", "scheduler", "mcp_gateway", "capability_authority", "audit_service", "retro_service", "reconciler", "hook_engine", "ceremony_scheduler"]>;
    }, "strip", z.ZodTypeAny, {
        type: "system";
        component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
    }, {
        type: "system";
        component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
    }>, z.ZodObject<{
        type: z.ZodLiteral<"hook">;
        hook_id: z.ZodString;
        hook_version: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        type: "hook";
        hook_id: string;
        hook_version: string;
    }, {
        type: "hook";
        hook_id: string;
        hook_version: string;
    }>]>;
    capability_id: z.ZodOptional<z.ZodString>;
    justification: z.ZodString;
    parent_event_id: z.ZodOptional<z.ZodString>;
    trace_id: z.ZodString;
    linked_artifacts: z.ZodDefault<z.ZodArray<z.ZodObject<{
        type: z.ZodString;
        id: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        type: string;
        id: string;
    }, {
        type: string;
        id: string;
    }>, "many">>;
}, "strip", z.ZodTypeAny, {
    trace_id: string;
    actor: {
        type: "persona";
        persona_id: string;
        session_id: string;
        task_id?: string | undefined;
    } | {
        type: "user";
        user_id: string;
        install_id: string;
    } | {
        type: "system";
        component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
    } | {
        type: "hook";
        hook_id: string;
        hook_version: string;
    };
    linked_artifacts: {
        type: string;
        id: string;
    }[];
    justification: string;
    capability_id?: string | undefined;
    parent_event_id?: string | undefined;
}, {
    trace_id: string;
    actor: {
        type: "persona";
        persona_id: string;
        session_id: string;
        task_id?: string | undefined;
    } | {
        type: "user";
        user_id: string;
        install_id: string;
    } | {
        type: "system";
        component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
    } | {
        type: "hook";
        hook_id: string;
        hook_version: string;
    };
    justification: string;
    capability_id?: string | undefined;
    parent_event_id?: string | undefined;
    linked_artifacts?: {
        type: string;
        id: string;
    }[] | undefined;
}>;
export declare const SessionStartInputSchema: z.ZodObject<{
    title: z.ZodString;
    initial_prompt: z.ZodString;
    audit_metadata: z.ZodObject<{
        actor: z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
            type: z.ZodLiteral<"persona">;
            persona_id: z.ZodString;
            session_id: z.ZodString;
            task_id: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            type: "persona";
            persona_id: string;
            session_id: string;
            task_id?: string | undefined;
        }, {
            type: "persona";
            persona_id: string;
            session_id: string;
            task_id?: string | undefined;
        }>, z.ZodObject<{
            type: z.ZodLiteral<"user">;
            user_id: z.ZodString;
            install_id: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            type: "user";
            user_id: string;
            install_id: string;
        }, {
            type: "user";
            user_id: string;
            install_id: string;
        }>, z.ZodObject<{
            type: z.ZodLiteral<"system">;
            component: z.ZodEnum<["orchestrator", "scheduler", "mcp_gateway", "capability_authority", "audit_service", "retro_service", "reconciler", "hook_engine", "ceremony_scheduler"]>;
        }, "strip", z.ZodTypeAny, {
            type: "system";
            component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
        }, {
            type: "system";
            component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
        }>, z.ZodObject<{
            type: z.ZodLiteral<"hook">;
            hook_id: z.ZodString;
            hook_version: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            type: "hook";
            hook_id: string;
            hook_version: string;
        }, {
            type: "hook";
            hook_id: string;
            hook_version: string;
        }>]>;
        capability_id: z.ZodOptional<z.ZodString>;
        justification: z.ZodString;
        parent_event_id: z.ZodOptional<z.ZodString>;
        trace_id: z.ZodString;
        linked_artifacts: z.ZodDefault<z.ZodArray<z.ZodObject<{
            type: z.ZodString;
            id: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            type: string;
            id: string;
        }, {
            type: string;
            id: string;
        }>, "many">>;
    }, "strip", z.ZodTypeAny, {
        trace_id: string;
        actor: {
            type: "persona";
            persona_id: string;
            session_id: string;
            task_id?: string | undefined;
        } | {
            type: "user";
            user_id: string;
            install_id: string;
        } | {
            type: "system";
            component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
        } | {
            type: "hook";
            hook_id: string;
            hook_version: string;
        };
        linked_artifacts: {
            type: string;
            id: string;
        }[];
        justification: string;
        capability_id?: string | undefined;
        parent_event_id?: string | undefined;
    }, {
        trace_id: string;
        actor: {
            type: "persona";
            persona_id: string;
            session_id: string;
            task_id?: string | undefined;
        } | {
            type: "user";
            user_id: string;
            install_id: string;
        } | {
            type: "system";
            component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
        } | {
            type: "hook";
            hook_id: string;
            hook_version: string;
        };
        justification: string;
        capability_id?: string | undefined;
        parent_event_id?: string | undefined;
        linked_artifacts?: {
            type: string;
            id: string;
        }[] | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    title: string;
    initial_prompt: string;
    audit_metadata: {
        trace_id: string;
        actor: {
            type: "persona";
            persona_id: string;
            session_id: string;
            task_id?: string | undefined;
        } | {
            type: "user";
            user_id: string;
            install_id: string;
        } | {
            type: "system";
            component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
        } | {
            type: "hook";
            hook_id: string;
            hook_version: string;
        };
        linked_artifacts: {
            type: string;
            id: string;
        }[];
        justification: string;
        capability_id?: string | undefined;
        parent_event_id?: string | undefined;
    };
}, {
    title: string;
    initial_prompt: string;
    audit_metadata: {
        trace_id: string;
        actor: {
            type: "persona";
            persona_id: string;
            session_id: string;
            task_id?: string | undefined;
        } | {
            type: "user";
            user_id: string;
            install_id: string;
        } | {
            type: "system";
            component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
        } | {
            type: "hook";
            hook_id: string;
            hook_version: string;
        };
        justification: string;
        capability_id?: string | undefined;
        parent_event_id?: string | undefined;
        linked_artifacts?: {
            type: string;
            id: string;
        }[] | undefined;
    };
}>;
export declare const SendMessageInputSchema: z.ZodObject<{
    vision_session_id: z.ZodString;
    body: z.ZodString;
    parent_message_id: z.ZodOptional<z.ZodString>;
    audit_metadata: z.ZodObject<{
        actor: z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
            type: z.ZodLiteral<"persona">;
            persona_id: z.ZodString;
            session_id: z.ZodString;
            task_id: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            type: "persona";
            persona_id: string;
            session_id: string;
            task_id?: string | undefined;
        }, {
            type: "persona";
            persona_id: string;
            session_id: string;
            task_id?: string | undefined;
        }>, z.ZodObject<{
            type: z.ZodLiteral<"user">;
            user_id: z.ZodString;
            install_id: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            type: "user";
            user_id: string;
            install_id: string;
        }, {
            type: "user";
            user_id: string;
            install_id: string;
        }>, z.ZodObject<{
            type: z.ZodLiteral<"system">;
            component: z.ZodEnum<["orchestrator", "scheduler", "mcp_gateway", "capability_authority", "audit_service", "retro_service", "reconciler", "hook_engine", "ceremony_scheduler"]>;
        }, "strip", z.ZodTypeAny, {
            type: "system";
            component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
        }, {
            type: "system";
            component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
        }>, z.ZodObject<{
            type: z.ZodLiteral<"hook">;
            hook_id: z.ZodString;
            hook_version: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            type: "hook";
            hook_id: string;
            hook_version: string;
        }, {
            type: "hook";
            hook_id: string;
            hook_version: string;
        }>]>;
        capability_id: z.ZodOptional<z.ZodString>;
        justification: z.ZodString;
        parent_event_id: z.ZodOptional<z.ZodString>;
        trace_id: z.ZodString;
        linked_artifacts: z.ZodDefault<z.ZodArray<z.ZodObject<{
            type: z.ZodString;
            id: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            type: string;
            id: string;
        }, {
            type: string;
            id: string;
        }>, "many">>;
    }, "strip", z.ZodTypeAny, {
        trace_id: string;
        actor: {
            type: "persona";
            persona_id: string;
            session_id: string;
            task_id?: string | undefined;
        } | {
            type: "user";
            user_id: string;
            install_id: string;
        } | {
            type: "system";
            component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
        } | {
            type: "hook";
            hook_id: string;
            hook_version: string;
        };
        linked_artifacts: {
            type: string;
            id: string;
        }[];
        justification: string;
        capability_id?: string | undefined;
        parent_event_id?: string | undefined;
    }, {
        trace_id: string;
        actor: {
            type: "persona";
            persona_id: string;
            session_id: string;
            task_id?: string | undefined;
        } | {
            type: "user";
            user_id: string;
            install_id: string;
        } | {
            type: "system";
            component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
        } | {
            type: "hook";
            hook_id: string;
            hook_version: string;
        };
        justification: string;
        capability_id?: string | undefined;
        parent_event_id?: string | undefined;
        linked_artifacts?: {
            type: string;
            id: string;
        }[] | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    vision_session_id: string;
    body: string;
    audit_metadata: {
        trace_id: string;
        actor: {
            type: "persona";
            persona_id: string;
            session_id: string;
            task_id?: string | undefined;
        } | {
            type: "user";
            user_id: string;
            install_id: string;
        } | {
            type: "system";
            component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
        } | {
            type: "hook";
            hook_id: string;
            hook_version: string;
        };
        linked_artifacts: {
            type: string;
            id: string;
        }[];
        justification: string;
        capability_id?: string | undefined;
        parent_event_id?: string | undefined;
    };
    parent_message_id?: string | undefined;
}, {
    vision_session_id: string;
    body: string;
    audit_metadata: {
        trace_id: string;
        actor: {
            type: "persona";
            persona_id: string;
            session_id: string;
            task_id?: string | undefined;
        } | {
            type: "user";
            user_id: string;
            install_id: string;
        } | {
            type: "system";
            component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
        } | {
            type: "hook";
            hook_id: string;
            hook_version: string;
        };
        justification: string;
        capability_id?: string | undefined;
        parent_event_id?: string | undefined;
        linked_artifacts?: {
            type: string;
            id: string;
        }[] | undefined;
    };
    parent_message_id?: string | undefined;
}>;
export declare const LockInputSchema: z.ZodObject<{
    vision_document_id: z.ZodString;
    confirmation_token: z.ZodString;
    changelog: z.ZodString;
    attestation: z.ZodObject<{
        no_edge_cases: z.ZodDefault<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        no_edge_cases: boolean;
    }, {
        no_edge_cases?: boolean | undefined;
    }>;
    audit_metadata: z.ZodObject<{
        actor: z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
            type: z.ZodLiteral<"persona">;
            persona_id: z.ZodString;
            session_id: z.ZodString;
            task_id: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            type: "persona";
            persona_id: string;
            session_id: string;
            task_id?: string | undefined;
        }, {
            type: "persona";
            persona_id: string;
            session_id: string;
            task_id?: string | undefined;
        }>, z.ZodObject<{
            type: z.ZodLiteral<"user">;
            user_id: z.ZodString;
            install_id: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            type: "user";
            user_id: string;
            install_id: string;
        }, {
            type: "user";
            user_id: string;
            install_id: string;
        }>, z.ZodObject<{
            type: z.ZodLiteral<"system">;
            component: z.ZodEnum<["orchestrator", "scheduler", "mcp_gateway", "capability_authority", "audit_service", "retro_service", "reconciler", "hook_engine", "ceremony_scheduler"]>;
        }, "strip", z.ZodTypeAny, {
            type: "system";
            component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
        }, {
            type: "system";
            component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
        }>, z.ZodObject<{
            type: z.ZodLiteral<"hook">;
            hook_id: z.ZodString;
            hook_version: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            type: "hook";
            hook_id: string;
            hook_version: string;
        }, {
            type: "hook";
            hook_id: string;
            hook_version: string;
        }>]>;
        capability_id: z.ZodOptional<z.ZodString>;
        justification: z.ZodString;
        parent_event_id: z.ZodOptional<z.ZodString>;
        trace_id: z.ZodString;
        linked_artifacts: z.ZodDefault<z.ZodArray<z.ZodObject<{
            type: z.ZodString;
            id: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            type: string;
            id: string;
        }, {
            type: string;
            id: string;
        }>, "many">>;
    }, "strip", z.ZodTypeAny, {
        trace_id: string;
        actor: {
            type: "persona";
            persona_id: string;
            session_id: string;
            task_id?: string | undefined;
        } | {
            type: "user";
            user_id: string;
            install_id: string;
        } | {
            type: "system";
            component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
        } | {
            type: "hook";
            hook_id: string;
            hook_version: string;
        };
        linked_artifacts: {
            type: string;
            id: string;
        }[];
        justification: string;
        capability_id?: string | undefined;
        parent_event_id?: string | undefined;
    }, {
        trace_id: string;
        actor: {
            type: "persona";
            persona_id: string;
            session_id: string;
            task_id?: string | undefined;
        } | {
            type: "user";
            user_id: string;
            install_id: string;
        } | {
            type: "system";
            component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
        } | {
            type: "hook";
            hook_id: string;
            hook_version: string;
        };
        justification: string;
        capability_id?: string | undefined;
        parent_event_id?: string | undefined;
        linked_artifacts?: {
            type: string;
            id: string;
        }[] | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    vision_document_id: string;
    changelog: string;
    attestation: {
        no_edge_cases: boolean;
    };
    confirmation_token: string;
    audit_metadata: {
        trace_id: string;
        actor: {
            type: "persona";
            persona_id: string;
            session_id: string;
            task_id?: string | undefined;
        } | {
            type: "user";
            user_id: string;
            install_id: string;
        } | {
            type: "system";
            component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
        } | {
            type: "hook";
            hook_id: string;
            hook_version: string;
        };
        linked_artifacts: {
            type: string;
            id: string;
        }[];
        justification: string;
        capability_id?: string | undefined;
        parent_event_id?: string | undefined;
    };
}, {
    vision_document_id: string;
    changelog: string;
    attestation: {
        no_edge_cases?: boolean | undefined;
    };
    confirmation_token: string;
    audit_metadata: {
        trace_id: string;
        actor: {
            type: "persona";
            persona_id: string;
            session_id: string;
            task_id?: string | undefined;
        } | {
            type: "user";
            user_id: string;
            install_id: string;
        } | {
            type: "system";
            component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
        } | {
            type: "hook";
            hook_id: string;
            hook_version: string;
        };
        justification: string;
        capability_id?: string | undefined;
        parent_event_id?: string | undefined;
        linked_artifacts?: {
            type: string;
            id: string;
        }[] | undefined;
    };
}>;
export declare const ReviseInputSchema: z.ZodObject<{
    vision_document_id: z.ZodString;
    base_version_id: z.ZodString;
    delta: z.ZodArray<z.ZodRecord<z.ZodString, z.ZodAny>, "many">;
    changelog: z.ZodString;
    reason: z.ZodEnum<["user_initiated", "architect_feedback", "uat_defect", "retro_proposal"]>;
    audit_metadata: z.ZodObject<{
        actor: z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
            type: z.ZodLiteral<"persona">;
            persona_id: z.ZodString;
            session_id: z.ZodString;
            task_id: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            type: "persona";
            persona_id: string;
            session_id: string;
            task_id?: string | undefined;
        }, {
            type: "persona";
            persona_id: string;
            session_id: string;
            task_id?: string | undefined;
        }>, z.ZodObject<{
            type: z.ZodLiteral<"user">;
            user_id: z.ZodString;
            install_id: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            type: "user";
            user_id: string;
            install_id: string;
        }, {
            type: "user";
            user_id: string;
            install_id: string;
        }>, z.ZodObject<{
            type: z.ZodLiteral<"system">;
            component: z.ZodEnum<["orchestrator", "scheduler", "mcp_gateway", "capability_authority", "audit_service", "retro_service", "reconciler", "hook_engine", "ceremony_scheduler"]>;
        }, "strip", z.ZodTypeAny, {
            type: "system";
            component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
        }, {
            type: "system";
            component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
        }>, z.ZodObject<{
            type: z.ZodLiteral<"hook">;
            hook_id: z.ZodString;
            hook_version: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            type: "hook";
            hook_id: string;
            hook_version: string;
        }, {
            type: "hook";
            hook_id: string;
            hook_version: string;
        }>]>;
        capability_id: z.ZodOptional<z.ZodString>;
        justification: z.ZodString;
        parent_event_id: z.ZodOptional<z.ZodString>;
        trace_id: z.ZodString;
        linked_artifacts: z.ZodDefault<z.ZodArray<z.ZodObject<{
            type: z.ZodString;
            id: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            type: string;
            id: string;
        }, {
            type: string;
            id: string;
        }>, "many">>;
    }, "strip", z.ZodTypeAny, {
        trace_id: string;
        actor: {
            type: "persona";
            persona_id: string;
            session_id: string;
            task_id?: string | undefined;
        } | {
            type: "user";
            user_id: string;
            install_id: string;
        } | {
            type: "system";
            component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
        } | {
            type: "hook";
            hook_id: string;
            hook_version: string;
        };
        linked_artifacts: {
            type: string;
            id: string;
        }[];
        justification: string;
        capability_id?: string | undefined;
        parent_event_id?: string | undefined;
    }, {
        trace_id: string;
        actor: {
            type: "persona";
            persona_id: string;
            session_id: string;
            task_id?: string | undefined;
        } | {
            type: "user";
            user_id: string;
            install_id: string;
        } | {
            type: "system";
            component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
        } | {
            type: "hook";
            hook_id: string;
            hook_version: string;
        };
        justification: string;
        capability_id?: string | undefined;
        parent_event_id?: string | undefined;
        linked_artifacts?: {
            type: string;
            id: string;
        }[] | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    reason: "user_initiated" | "architect_feedback" | "uat_defect" | "retro_proposal";
    vision_document_id: string;
    changelog: string;
    delta: Record<string, any>[];
    audit_metadata: {
        trace_id: string;
        actor: {
            type: "persona";
            persona_id: string;
            session_id: string;
            task_id?: string | undefined;
        } | {
            type: "user";
            user_id: string;
            install_id: string;
        } | {
            type: "system";
            component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
        } | {
            type: "hook";
            hook_id: string;
            hook_version: string;
        };
        linked_artifacts: {
            type: string;
            id: string;
        }[];
        justification: string;
        capability_id?: string | undefined;
        parent_event_id?: string | undefined;
    };
    base_version_id: string;
}, {
    reason: "user_initiated" | "architect_feedback" | "uat_defect" | "retro_proposal";
    vision_document_id: string;
    changelog: string;
    delta: Record<string, any>[];
    audit_metadata: {
        trace_id: string;
        actor: {
            type: "persona";
            persona_id: string;
            session_id: string;
            task_id?: string | undefined;
        } | {
            type: "user";
            user_id: string;
            install_id: string;
        } | {
            type: "system";
            component: "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "hook_engine" | "ceremony_scheduler";
        } | {
            type: "hook";
            hook_id: string;
            hook_version: string;
        };
        justification: string;
        capability_id?: string | undefined;
        parent_event_id?: string | undefined;
        linked_artifacts?: {
            type: string;
            id: string;
        }[] | undefined;
    };
    base_version_id: string;
}>;
export declare const GetInputSchema: z.ZodObject<{
    vision_document_id: z.ZodString;
    version_number: z.ZodOptional<z.ZodEffects<z.ZodNumber, number, number>>;
}, "strip", z.ZodTypeAny, {
    vision_document_id: string;
    version_number?: number | undefined;
}, {
    vision_document_id: string;
    version_number?: number | undefined;
}>;
export declare const HistoryInputSchema: z.ZodObject<{
    vision_document_id: z.ZodString;
    after: z.ZodOptional<z.ZodString>;
    limit: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    limit: number;
    vision_document_id: string;
    after?: string | undefined;
}, {
    vision_document_id: string;
    limit?: number | undefined;
    after?: string | undefined;
}>;
export {};
//# sourceMappingURL=types.d.ts.map