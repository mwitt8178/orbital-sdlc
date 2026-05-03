/**
 * uat/types.ts — Shared types, Zod schemas, and error codes for the UAT workflow.
 *
 * Per TRD-11 v0.2 §5, §6, §9.
 *
 * All mutation schemas require a justification field (Primitives §14).
 * All payloads are validated by Zod and emitted via EventStore.
 */
import { z } from 'zod';
export type { UATSessionRow, UATSessionInsert, UATACResultRow, UATACResultInsert, DefectRow, DefectInsert, DefectLineageRow, DefectLineageInsert, PersonaOfRecordLinkRow, PersonaOfRecordLinkInsert, UATSessionState, UATACStatus, DefectSeverity, DefectState, PORRole, AssumptionItem, } from '@orbital/db';
export declare const StartSessionInputSchema: z.ZodObject<{
    ticket_id: z.ZodString;
    triggered_by_event_id: z.ZodString;
    build_ref: z.ZodString;
    resume_existing: z.ZodDefault<z.ZodBoolean>;
    justification: z.ZodString;
}, "strip", z.ZodTypeAny, {
    ticket_id: string;
    justification: string;
    triggered_by_event_id: string;
    build_ref: string;
    resume_existing: boolean;
}, {
    ticket_id: string;
    justification: string;
    triggered_by_event_id: string;
    build_ref: string;
    resume_existing?: boolean | undefined;
}>;
export type StartSessionInput = z.infer<typeof StartSessionInputSchema>;
export declare const MarkACInputSchema: z.ZodEffects<z.ZodObject<{
    uat_session_id: z.ZodString;
    ac_id: z.ZodString;
    status: z.ZodEnum<["pass", "fail"]>;
    observed_behavior: z.ZodOptional<z.ZodString>;
    evidence_links: z.ZodDefault<z.ZodArray<z.ZodObject<{
        type: z.ZodEnum<["screenshot", "log", "video", "audit_event", "channel_post"]>;
        uri: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        type: "channel_post" | "screenshot" | "log" | "video" | "audit_event";
        uri: string;
        label?: string | undefined;
    }, {
        type: "channel_post" | "screenshot" | "log" | "video" | "audit_event";
        uri: string;
        label?: string | undefined;
    }>, "many">>;
    justification: z.ZodString;
}, "strip", z.ZodTypeAny, {
    status: "pass" | "fail";
    ac_id: string;
    justification: string;
    uat_session_id: string;
    evidence_links: {
        type: "channel_post" | "screenshot" | "log" | "video" | "audit_event";
        uri: string;
        label?: string | undefined;
    }[];
    observed_behavior?: string | undefined;
}, {
    status: "pass" | "fail";
    ac_id: string;
    justification: string;
    uat_session_id: string;
    observed_behavior?: string | undefined;
    evidence_links?: {
        type: "channel_post" | "screenshot" | "log" | "video" | "audit_event";
        uri: string;
        label?: string | undefined;
    }[] | undefined;
}>, {
    status: "pass" | "fail";
    ac_id: string;
    justification: string;
    uat_session_id: string;
    evidence_links: {
        type: "channel_post" | "screenshot" | "log" | "video" | "audit_event";
        uri: string;
        label?: string | undefined;
    }[];
    observed_behavior?: string | undefined;
}, {
    status: "pass" | "fail";
    ac_id: string;
    justification: string;
    uat_session_id: string;
    observed_behavior?: string | undefined;
    evidence_links?: {
        type: "channel_post" | "screenshot" | "log" | "video" | "audit_event";
        uri: string;
        label?: string | undefined;
    }[] | undefined;
}>;
export type MarkACInput = z.infer<typeof MarkACInputSchema>;
export declare const UnmarkACInputSchema: z.ZodObject<{
    uat_session_id: z.ZodString;
    ac_id: z.ZodString;
    justification: z.ZodString;
}, "strip", z.ZodTypeAny, {
    ac_id: string;
    justification: string;
    uat_session_id: string;
}, {
    ac_id: string;
    justification: string;
    uat_session_id: string;
}>;
export type UnmarkACInput = z.infer<typeof UnmarkACInputSchema>;
export declare const SubmitSessionInputSchema: z.ZodObject<{
    uat_session_id: z.ZodString;
    outcome_notes: z.ZodOptional<z.ZodString>;
    justification: z.ZodString;
    confirm_unverified_assumptions: z.ZodDefault<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    justification: string;
    uat_session_id: string;
    confirm_unverified_assumptions: boolean;
    outcome_notes?: string | undefined;
}, {
    justification: string;
    uat_session_id: string;
    outcome_notes?: string | undefined;
    confirm_unverified_assumptions?: boolean | undefined;
}>;
export type SubmitSessionInput = z.infer<typeof SubmitSessionInputSchema>;
export declare const AcceptSessionInputSchema: z.ZodObject<{
    uat_session_id: z.ZodString;
    mode: z.ZodDefault<z.ZodOptional<z.ZodEnum<["full", "partial"]>>>;
    justification: z.ZodString;
}, "strip", z.ZodTypeAny, {
    mode: "full" | "partial";
    justification: string;
    uat_session_id: string;
}, {
    justification: string;
    uat_session_id: string;
    mode?: "full" | "partial" | undefined;
}>;
export type AcceptSessionInput = z.infer<typeof AcceptSessionInputSchema>;
export declare const ListDefectsInputSchema: z.ZodObject<{
    state: z.ZodOptional<z.ZodEnum<["open", "triaged", "assigned", "in_progress", "resolved", "verified", "reopened", "closed"]>>;
    severity: z.ZodOptional<z.ZodEnum<["critical", "high", "medium", "low"]>>;
    origin_story_id: z.ZodOptional<z.ZodString>;
    persona_of_record_id: z.ZodOptional<z.ZodString>;
    created_after: z.ZodOptional<z.ZodString>;
    limit: z.ZodDefault<z.ZodNumber>;
    after: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    limit: number;
    severity?: "low" | "medium" | "high" | "critical" | undefined;
    state?: "in_progress" | "closed" | "resolved" | "open" | "triaged" | "assigned" | "verified" | "reopened" | undefined;
    origin_story_id?: string | undefined;
    persona_of_record_id?: string | undefined;
    created_after?: string | undefined;
    after?: string | undefined;
}, {
    limit?: number | undefined;
    severity?: "low" | "medium" | "high" | "critical" | undefined;
    state?: "in_progress" | "closed" | "resolved" | "open" | "triaged" | "assigned" | "verified" | "reopened" | undefined;
    origin_story_id?: string | undefined;
    persona_of_record_id?: string | undefined;
    created_after?: string | undefined;
    after?: string | undefined;
}>;
export type ListDefectsInput = z.infer<typeof ListDefectsInputSchema>;
export declare const GetSessionInputSchema: z.ZodObject<{
    uat_session_id: z.ZodString;
}, "strip", z.ZodTypeAny, {
    uat_session_id: string;
}, {
    uat_session_id: string;
}>;
export type GetSessionInput = z.infer<typeof GetSessionInputSchema>;
export declare const ListSessionsInputSchema: z.ZodObject<{
    ticket_id: z.ZodString;
    include_ac_results: z.ZodDefault<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    ticket_id: string;
    include_ac_results: boolean;
}, {
    ticket_id: string;
    include_ac_results?: boolean | undefined;
}>;
export type ListSessionsInput = z.infer<typeof ListSessionsInputSchema>;
export interface MarkACOutput {
    ac_result_id: string;
    status: 'pass' | 'fail' | 'pending';
    pass_count: number;
    fail_count: number;
    pending_count: number;
}
export interface SubmitOutput {
    uat_session_id: string;
    outcome: 'accepted' | 'partially_accepted' | 'rejected';
    pass_count: number;
    fail_count: number;
    defects_created: Array<{
        defect_id: string;
        defect_key: string;
        origin_ac_id: string;
        severity: 'critical' | 'high' | 'medium' | 'low';
        preempts_sprint: boolean;
    }>;
}
export declare const UAT_ERROR_CODES: {
    readonly NOT_FOUND_UAT_SESSION: "NOT_FOUND_UAT_SESSION";
    readonly NOT_FOUND_TICKET: "NOT_FOUND_TICKET";
    readonly NOT_FOUND_AC: "NOT_FOUND_AC";
    readonly NOT_FOUND_DEFECT: "NOT_FOUND_DEFECT";
    readonly CONFLICT_INVALID_STATE_TRANSITION: "CONFLICT_INVALID_STATE_TRANSITION";
    readonly CONFLICT_STORY_NOT_DONE: "CONFLICT_STORY_NOT_DONE";
    readonly VALIDATION_REQUIRED_FIELD_MISSING: "VALIDATION_REQUIRED_FIELD_MISSING";
    readonly VALIDATION_PENDING_ACS_REMAIN: "VALIDATION_PENDING_ACS_REMAIN";
    readonly VERIFIER_AC_FAILED: "VERIFIER_AC_FAILED";
    readonly UAT_DEFECT_CREATION_FAILED: "UAT_DEFECT_CREATION_FAILED";
    readonly UAT_AC_NOT_MARKED: "UAT_AC_NOT_MARKED";
    readonly UAT_PERSONA_OF_RECORD_UNRESOLVABLE: "UAT_PERSONA_OF_RECORD_UNRESOLVABLE";
    readonly AUTH_SCOPE_DENIED: "AUTH_SCOPE_DENIED";
    readonly INTERNAL_DB_ERROR: "INTERNAL_DB_ERROR";
};
export type UATErrorCode = (typeof UAT_ERROR_CODES)[keyof typeof UAT_ERROR_CODES];
export interface SeverityRuleContext {
    acText: string;
    storyId: string;
    sessionId: string;
    failedAcCountForStory: number;
    totalAcCountForStory: number;
    isReopen: boolean;
    acTags?: string[];
    observedValue?: number;
    expectedValue?: number;
}
export type DefectSeverityResult = 'critical' | 'high' | 'medium' | 'low';
export interface CreateDefectParams {
    failedAcResultId: string;
    sessionId: string;
    storyId: string;
    acId: string;
    acText: string;
    observedBehavior: string;
    personaOfRecordId: string;
    severity: DefectSeverityResult;
    preemptsSprint: boolean;
    sprintId?: string;
}
//# sourceMappingURL=types.d.ts.map