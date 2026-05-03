/**
 * hooks/types.ts — Zod schemas and TypeScript types for the Hook Engine.
 *
 * Per TRD-09 §6.2.1 (HookEngine.validate), §12.1 (HookSpec format), §5 (events).
 *
 * All hooks are pure functions: no network, no file I/O, no non-deterministic reads.
 * The HookEngine calls them synchronously (they may return a microtask, but no
 * real async I/O is permitted per §12.4).
 */
import { z } from 'zod';
declare const ActorSchema: z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
    type: z.ZodLiteral<"persona">;
    persona_id: z.ZodString;
    session_id: z.ZodString;
    task_id: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    type: "persona";
    session_id: string;
    persona_id: string;
    task_id?: string | undefined;
}, {
    type: "persona";
    session_id: string;
    persona_id: string;
    task_id?: string | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"user">;
    user_id: z.ZodString;
    install_id: z.ZodString;
}, "strip", z.ZodTypeAny, {
    type: "user";
    install_id: string;
    user_id: string;
}, {
    type: "user";
    install_id: string;
    user_id: string;
}>, z.ZodObject<{
    type: z.ZodLiteral<"system">;
    component: z.ZodEnum<["orchestrator", "scheduler", "mcp_gateway", "capability_authority", "audit_service", "retro_service", "reconciler", "hook_engine", "ceremony_scheduler"]>;
}, "strip", z.ZodTypeAny, {
    type: "system";
    component: "hook_engine" | "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "ceremony_scheduler";
}, {
    type: "system";
    component: "hook_engine" | "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "ceremony_scheduler";
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
export type HookActor = z.infer<typeof ActorSchema>;
export declare const HookContextSchema: z.ZodObject<{
    trace_id: z.ZodString;
    parent_event_id: z.ZodOptional<z.ZodString>;
    capability_id: z.ZodOptional<z.ZodString>;
    actor: z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
        type: z.ZodLiteral<"persona">;
        persona_id: z.ZodString;
        session_id: z.ZodString;
        task_id: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        type: "persona";
        session_id: string;
        persona_id: string;
        task_id?: string | undefined;
    }, {
        type: "persona";
        session_id: string;
        persona_id: string;
        task_id?: string | undefined;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"user">;
        user_id: z.ZodString;
        install_id: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        type: "user";
        install_id: string;
        user_id: string;
    }, {
        type: "user";
        install_id: string;
        user_id: string;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"system">;
        component: z.ZodEnum<["orchestrator", "scheduler", "mcp_gateway", "capability_authority", "audit_service", "retro_service", "reconciler", "hook_engine", "ceremony_scheduler"]>;
    }, "strip", z.ZodTypeAny, {
        type: "system";
        component: "hook_engine" | "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "ceremony_scheduler";
    }, {
        type: "system";
        component: "hook_engine" | "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "ceremony_scheduler";
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
}, "strip", z.ZodTypeAny, {
    trace_id: string;
    actor: {
        type: "persona";
        session_id: string;
        persona_id: string;
        task_id?: string | undefined;
    } | {
        type: "user";
        install_id: string;
        user_id: string;
    } | {
        type: "system";
        component: "hook_engine" | "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "ceremony_scheduler";
    } | {
        type: "hook";
        hook_id: string;
        hook_version: string;
    };
    capability_id?: string | undefined;
    parent_event_id?: string | undefined;
}, {
    trace_id: string;
    actor: {
        type: "persona";
        session_id: string;
        persona_id: string;
        task_id?: string | undefined;
    } | {
        type: "user";
        install_id: string;
        user_id: string;
    } | {
        type: "system";
        component: "hook_engine" | "orchestrator" | "scheduler" | "mcp_gateway" | "capability_authority" | "audit_service" | "retro_service" | "reconciler" | "ceremony_scheduler";
    } | {
        type: "hook";
        hook_id: string;
        hook_version: string;
    };
    capability_id?: string | undefined;
    parent_event_id?: string | undefined;
}>;
export type HookContext = z.infer<typeof HookContextSchema>;
export declare const HookDecisionSchema: z.ZodDiscriminatedUnion<"allow", [z.ZodObject<{
    allow: z.ZodLiteral<true>;
}, "strip", z.ZodTypeAny, {
    allow: true;
}, {
    allow: true;
}>, z.ZodObject<{
    allow: z.ZodLiteral<false>;
    reason: z.ZodString;
}, "strip", z.ZodTypeAny, {
    reason: string;
    allow: false;
}, {
    reason: string;
    allow: false;
}>]>;
export type HookDecision = z.infer<typeof HookDecisionSchema>;
export interface HookDefinition {
    hook_id: string;
    hook_version_id: string;
    slug: string;
    description: string;
    applies_to: readonly string[];
    timing: 'pre' | 'post';
    declared_order: number;
    error_code: string;
    enabled: boolean;
    /** Pure synchronous validator. May return a microtask but no real I/O. */
    validator: (payload: unknown, context: HookContext) => HookDecision | Promise<HookDecision>;
}
export interface HookSpec<TPayloadSchema extends z.ZodTypeAny> {
    slug: string;
    description: string;
    appliesTo: readonly string[];
    timing: 'pre' | 'post';
    declaredOrder: number;
    errorCode: string;
    payloadSchema: TPayloadSchema;
    validator: (payload: z.infer<TPayloadSchema>, context: HookContext) => HookDecision | Promise<HookDecision>;
    testFixturesPath?: string;
}
/**
 * defineHook — type helper for hook spec definition.
 * Validates the spec shape at definition time.
 */
export declare function defineHook<T extends z.ZodTypeAny>(spec: HookSpec<T>): HookSpec<T>;
export type HookEngineDecision = {
    allow: true;
} | {
    allow: false;
    reason: string;
    error_code: string;
    hook_id: string;
    hook_slug: string;
    invocation_id: string;
};
export declare const HookFiredPayloadV1: z.ZodObject<{
    schema_version: z.ZodLiteral<1>;
    hook_id: z.ZodString;
    hook_version_id: z.ZodString;
    hook_slug: z.ZodString;
    event_type_intercepted: z.ZodString;
    timing: z.ZodEnum<["pre", "post"]>;
    decision: z.ZodEnum<["allow", "reject"]>;
    duration_ms: z.ZodNumber;
    invocation_id: z.ZodString;
    payload_digest: z.ZodString;
    parent_event_id: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    schema_version: 1;
    hook_id: string;
    hook_slug: string;
    hook_version_id: string;
    timing: "pre" | "post";
    invocation_id: string;
    decision: "allow" | "reject";
    duration_ms: number;
    payload_digest: string;
    event_type_intercepted: string;
    parent_event_id?: string | undefined;
}, {
    schema_version: 1;
    hook_id: string;
    hook_slug: string;
    hook_version_id: string;
    timing: "pre" | "post";
    invocation_id: string;
    decision: "allow" | "reject";
    duration_ms: number;
    payload_digest: string;
    event_type_intercepted: string;
    parent_event_id?: string | undefined;
}>;
export declare const HookPassedPayloadV1: z.ZodObject<{
    schema_version: z.ZodLiteral<1>;
    invocation_id: z.ZodString;
    hook_id: z.ZodString;
    hook_slug: z.ZodString;
    event_type_intercepted: z.ZodString;
    timing: z.ZodEnum<["pre", "post"]>;
}, "strip", z.ZodTypeAny, {
    schema_version: 1;
    hook_id: string;
    hook_slug: string;
    timing: "pre" | "post";
    invocation_id: string;
    event_type_intercepted: string;
}, {
    schema_version: 1;
    hook_id: string;
    hook_slug: string;
    timing: "pre" | "post";
    invocation_id: string;
    event_type_intercepted: string;
}>;
export declare const HookRejectedPayloadV1: z.ZodObject<{
    schema_version: z.ZodLiteral<1>;
    invocation_id: z.ZodString;
    hook_id: z.ZodString;
    hook_slug: z.ZodString;
    event_type_intercepted: z.ZodString;
    timing: z.ZodEnum<["pre", "post"]>;
    reason: z.ZodString;
    error_code: z.ZodString;
    rejected_actor: z.ZodAny;
}, "strip", z.ZodTypeAny, {
    schema_version: 1;
    reason: string;
    hook_id: string;
    hook_slug: string;
    timing: "pre" | "post";
    invocation_id: string;
    error_code: string;
    event_type_intercepted: string;
    rejected_actor?: any;
}, {
    schema_version: 1;
    reason: string;
    hook_id: string;
    hook_slug: string;
    timing: "pre" | "post";
    invocation_id: string;
    error_code: string;
    event_type_intercepted: string;
    rejected_actor?: any;
}>;
export declare const VerifierStartedPayloadV1: z.ZodObject<{
    schema_version: z.ZodLiteral<1>;
    verification_id: z.ZodString;
    task_id: z.ZodString;
    ticket_id: z.ZodString;
    verifier_session_id: z.ZodString;
    ac_count: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    task_id: string;
    schema_version: 1;
    verification_id: string;
    ticket_id: string;
    verifier_session_id: string;
    ac_count: number;
}, {
    task_id: string;
    schema_version: 1;
    verification_id: string;
    ticket_id: string;
    verifier_session_id: string;
    ac_count: number;
}>;
export declare const VerifierPassedPayloadV1: z.ZodObject<{
    schema_version: z.ZodLiteral<1>;
    verification_id: z.ZodString;
    task_id: z.ZodString;
    ticket_id: z.ZodString;
    ac_pass_count: z.ZodNumber;
    duration_ms: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    task_id: string;
    schema_version: 1;
    duration_ms: number;
    verification_id: string;
    ticket_id: string;
    ac_pass_count: number;
}, {
    task_id: string;
    schema_version: 1;
    duration_ms: number;
    verification_id: string;
    ticket_id: string;
    ac_pass_count: number;
}>;
export declare const VerifierFailedPayloadV1: z.ZodObject<{
    schema_version: z.ZodLiteral<1>;
    verification_id: z.ZodString;
    task_id: z.ZodString;
    ticket_id: z.ZodString;
    failed_ac_indices: z.ZodArray<z.ZodNumber, "many">;
    feedback_summary: z.ZodString;
    duration_ms: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    task_id: string;
    schema_version: 1;
    duration_ms: number;
    verification_id: string;
    ticket_id: string;
    failed_ac_indices: number[];
    feedback_summary: string;
}, {
    task_id: string;
    schema_version: 1;
    duration_ms: number;
    verification_id: string;
    ticket_id: string;
    failed_ac_indices: number[];
    feedback_summary: string;
}>;
export declare const VerifierAmbiguousPayloadV1: z.ZodObject<{
    schema_version: z.ZodLiteral<1>;
    verification_id: z.ZodString;
    task_id: z.ZodString;
    ticket_id: z.ZodString;
    ambiguous_ac_indices: z.ZodArray<z.ZodNumber, "many">;
    resolution_path: z.ZodEnum<["escalated_to_persona", "escalated_to_user"]>;
    escalation_target: z.ZodString;
}, "strip", z.ZodTypeAny, {
    task_id: string;
    schema_version: 1;
    verification_id: string;
    ticket_id: string;
    ambiguous_ac_indices: number[];
    resolution_path: "escalated_to_persona" | "escalated_to_user";
    escalation_target: string;
}, {
    task_id: string;
    schema_version: 1;
    verification_id: string;
    ticket_id: string;
    ambiguous_ac_indices: number[];
    resolution_path: "escalated_to_persona" | "escalated_to_user";
    escalation_target: string;
}>;
export type HookFiredPayload = z.infer<typeof HookFiredPayloadV1>;
export type HookPassedPayload = z.infer<typeof HookPassedPayloadV1>;
export type HookRejectedPayload = z.infer<typeof HookRejectedPayloadV1>;
export type VerifierStartedPayload = z.infer<typeof VerifierStartedPayloadV1>;
export type VerifierPassedPayload = z.infer<typeof VerifierPassedPayloadV1>;
export type VerifierFailedPayload = z.infer<typeof VerifierFailedPayloadV1>;
export type VerifierAmbiguousPayload = z.infer<typeof VerifierAmbiguousPayloadV1>;
export declare const VerificationResultEnvelopeSchema: z.ZodObject<{
    ac_index: z.ZodNumber;
    ac_text: z.ZodString;
    verdict: z.ZodEnum<["pass", "fail", "ambiguous"]>;
    reason: z.ZodString;
    evidence_refs: z.ZodArray<z.ZodObject<{
        type: z.ZodEnum<["file", "test_result", "log_line", "channel_post"]>;
        ref: z.ZodString;
        excerpt: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        type: "channel_post" | "file" | "test_result" | "log_line";
        ref: string;
        excerpt?: string | undefined;
    }, {
        type: "channel_post" | "file" | "test_result" | "log_line";
        ref: string;
        excerpt?: string | undefined;
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    reason: string;
    ac_index: number;
    ac_text: string;
    verdict: "ambiguous" | "pass" | "fail";
    evidence_refs: {
        type: "channel_post" | "file" | "test_result" | "log_line";
        ref: string;
        excerpt?: string | undefined;
    }[];
}, {
    reason: string;
    ac_index: number;
    ac_text: string;
    verdict: "ambiguous" | "pass" | "fail";
    evidence_refs: {
        type: "channel_post" | "file" | "test_result" | "log_line";
        ref: string;
        excerpt?: string | undefined;
    }[];
}>;
export declare const VerificationSubmissionSchema: z.ZodObject<{
    verification_id: z.ZodString;
    results: z.ZodArray<z.ZodObject<{
        ac_index: z.ZodNumber;
        ac_text: z.ZodString;
        verdict: z.ZodEnum<["pass", "fail", "ambiguous"]>;
        reason: z.ZodString;
        evidence_refs: z.ZodArray<z.ZodObject<{
            type: z.ZodEnum<["file", "test_result", "log_line", "channel_post"]>;
            ref: z.ZodString;
            excerpt: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            type: "channel_post" | "file" | "test_result" | "log_line";
            ref: string;
            excerpt?: string | undefined;
        }, {
            type: "channel_post" | "file" | "test_result" | "log_line";
            ref: string;
            excerpt?: string | undefined;
        }>, "many">;
    }, "strip", z.ZodTypeAny, {
        reason: string;
        ac_index: number;
        ac_text: string;
        verdict: "ambiguous" | "pass" | "fail";
        evidence_refs: {
            type: "channel_post" | "file" | "test_result" | "log_line";
            ref: string;
            excerpt?: string | undefined;
        }[];
    }, {
        reason: string;
        ac_index: number;
        ac_text: string;
        verdict: "ambiguous" | "pass" | "fail";
        evidence_refs: {
            type: "channel_post" | "file" | "test_result" | "log_line";
            ref: string;
            excerpt?: string | undefined;
        }[];
    }>, "many">;
    summary: z.ZodString;
}, "strip", z.ZodTypeAny, {
    verification_id: string;
    summary: string;
    results: {
        reason: string;
        ac_index: number;
        ac_text: string;
        verdict: "ambiguous" | "pass" | "fail";
        evidence_refs: {
            type: "channel_post" | "file" | "test_result" | "log_line";
            ref: string;
            excerpt?: string | undefined;
        }[];
    }[];
}, {
    verification_id: string;
    summary: string;
    results: {
        reason: string;
        ac_index: number;
        ac_text: string;
        verdict: "ambiguous" | "pass" | "fail";
        evidence_refs: {
            type: "channel_post" | "file" | "test_result" | "log_line";
            ref: string;
            excerpt?: string | undefined;
        }[];
    }[];
}>;
export type VerificationResultEnvelope = z.infer<typeof VerificationResultEnvelopeSchema>;
export type VerificationSubmission = z.infer<typeof VerificationSubmissionSchema>;
export {};
//# sourceMappingURL=types.d.ts.map