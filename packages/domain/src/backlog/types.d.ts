/**
 * backlog/types.ts — Shared types for the backlog + sprint subsystem.
 *
 * Per TRD-02 v0.2 §5 and §6.
 */
import { z } from 'zod';
export type { EpicRow, EpicInsert, StoryRow, StoryInsert, StoryAcceptanceCriterionRow, StoryAcceptanceCriterionInsert, SprintRow, SprintInsert, SprintCommitmentRow, SprintCommitmentInsert, MondaySyncStateRow, MondaySyncStateInsert, EpicStatus, StoryStatus, SprintStatus, SprintPriorityClass, MondayAggregateType, SprintPauseState, } from '@orbital/db';
import type { StoryStatus, SprintStatus } from '@orbital/db';
export declare function isValidStoryTransition(from: StoryStatus, to: StoryStatus): boolean;
export declare function isValidSprintTransition(from: SprintStatus, to: SprintStatus): boolean;
export declare const AcceptanceCriterionInputSchema: z.ZodObject<{
    text: z.ZodString;
    verifier_hint: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    text: string;
    verifier_hint?: string | undefined;
}, {
    text: string;
    verifier_hint?: string | undefined;
}>;
export type AcceptanceCriterionInput = z.infer<typeof AcceptanceCriterionInputSchema>;
export declare const CreateEpicInputSchema: z.ZodObject<{
    vision_version_id: z.ZodString;
    title: z.ZodString;
    rationale: z.ZodString;
    priority: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    title: string;
    priority: number;
    vision_version_id: string;
    rationale: string;
}, {
    title: string;
    priority: number;
    vision_version_id: string;
    rationale: string;
}>;
export type CreateEpicInput = z.infer<typeof CreateEpicInputSchema>;
export declare const CreateStoryInputSchema: z.ZodObject<{
    epic_id: z.ZodString;
    title: z.ZodString;
    description: z.ZodString;
    acceptance_criteria: z.ZodArray<z.ZodObject<{
        text: z.ZodString;
        verifier_hint: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        text: string;
        verifier_hint?: string | undefined;
    }, {
        text: string;
        verifier_hint?: string | undefined;
    }>, "many">;
    persona_of_record: z.ZodOptional<z.ZodString>;
    origin_story_id: z.ZodOptional<z.ZodString>;
    defect_id: z.ZodOptional<z.ZodString>;
    priority: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    description: string;
    title: string;
    epic_id: string;
    acceptance_criteria: {
        text: string;
        verifier_hint?: string | undefined;
    }[];
    priority?: number | undefined;
    persona_of_record?: string | undefined;
    origin_story_id?: string | undefined;
    defect_id?: string | undefined;
}, {
    description: string;
    title: string;
    epic_id: string;
    acceptance_criteria: {
        text: string;
        verifier_hint?: string | undefined;
    }[];
    priority?: number | undefined;
    persona_of_record?: string | undefined;
    origin_story_id?: string | undefined;
    defect_id?: string | undefined;
}>;
export type CreateStoryInput = z.infer<typeof CreateStoryInputSchema>;
export declare const UpdateStoryInputSchema: z.ZodObject<{
    story_id: z.ZodString;
    title: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    story_points: z.ZodOptional<z.ZodNumber>;
    status: z.ZodOptional<z.ZodEnum<["backlog", "ready", "in_progress", "in_review", "done", "accepted", "blocked", "defective"]>>;
    reason: z.ZodOptional<z.ZodString>;
    linked_artifacts: z.ZodOptional<z.ZodArray<z.ZodObject<{
        type: z.ZodString;
        id: z.ZodString;
        url: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        type: string;
        id: string;
        url?: string | undefined;
    }, {
        type: string;
        id: string;
        url?: string | undefined;
    }>, "many">>;
    persona_of_record: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    story_id: string;
    description?: string | undefined;
    status?: "done" | "in_progress" | "ready" | "backlog" | "in_review" | "accepted" | "blocked" | "defective" | undefined;
    reason?: string | undefined;
    title?: string | undefined;
    linked_artifacts?: {
        type: string;
        id: string;
        url?: string | undefined;
    }[] | undefined;
    story_points?: number | undefined;
    persona_of_record?: string | undefined;
}, {
    story_id: string;
    description?: string | undefined;
    status?: "done" | "in_progress" | "ready" | "backlog" | "in_review" | "accepted" | "blocked" | "defective" | undefined;
    reason?: string | undefined;
    title?: string | undefined;
    linked_artifacts?: {
        type: string;
        id: string;
        url?: string | undefined;
    }[] | undefined;
    story_points?: number | undefined;
    persona_of_record?: string | undefined;
}>;
export type UpdateStoryInput = z.infer<typeof UpdateStoryInputSchema>;
export declare const PrioritizeStoryInputSchema: z.ZodObject<{
    story_id: z.ZodString;
    position: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    story_id: string;
    position: number;
}, {
    story_id: string;
    position: number;
}>;
export type PrioritizeStoryInput = z.infer<typeof PrioritizeStoryInputSchema>;
export declare const CreateSprintInputSchema: z.ZodObject<{
    name: z.ZodString;
    story_point_capacity: z.ZodNumber;
    budget_usd_cents: z.ZodNumber;
    wall_clock_target_ms: z.ZodOptional<z.ZodNumber>;
    concurrency_share: z.ZodOptional<z.ZodNumber>;
    priority_class: z.ZodOptional<z.ZodEnum<["critical", "standard", "background"]>>;
}, "strip", z.ZodTypeAny, {
    name: string;
    story_point_capacity: number;
    budget_usd_cents: number;
    wall_clock_target_ms?: number | undefined;
    concurrency_share?: number | undefined;
    priority_class?: "critical" | "standard" | "background" | undefined;
}, {
    name: string;
    story_point_capacity: number;
    budget_usd_cents: number;
    wall_clock_target_ms?: number | undefined;
    concurrency_share?: number | undefined;
    priority_class?: "critical" | "standard" | "background" | undefined;
}>;
export type CreateSprintInput = z.infer<typeof CreateSprintInputSchema>;
export declare const SprintCommitmentInputSchema: z.ZodObject<{
    sprint_id: z.ZodString;
    selected_story_ids: z.ZodArray<z.ZodString, "many">;
    capacity_used_points: z.ZodNumber;
    ceremony_id: z.ZodOptional<z.ZodString>;
    identified_risks: z.ZodOptional<z.ZodArray<z.ZodObject<{
        risk: z.ZodString;
        severity: z.ZodEnum<["low", "medium", "high"]>;
        mitigation: z.ZodNullable<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        severity: "low" | "medium" | "high";
        risk: string;
        mitigation: string | null;
    }, {
        severity: "low" | "medium" | "high";
        risk: string;
        mitigation: string | null;
    }>, "many">>;
    raised_concerns: z.ZodOptional<z.ZodArray<z.ZodObject<{
        raisedBy: z.ZodString;
        concern: z.ZodString;
        disposition: z.ZodEnum<["accepted", "deferred", "rejected"]>;
        rationale: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        concern: string;
        rationale: string;
        raisedBy: string;
        disposition: "accepted" | "deferred" | "rejected";
    }, {
        concern: string;
        rationale: string;
        raisedBy: string;
        disposition: "accepted" | "deferred" | "rejected";
    }>, "many">>;
    is_partial: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    sprint_id: string;
    selected_story_ids: string[];
    capacity_used_points: number;
    ceremony_id?: string | undefined;
    is_partial?: boolean | undefined;
    identified_risks?: {
        severity: "low" | "medium" | "high";
        risk: string;
        mitigation: string | null;
    }[] | undefined;
    raised_concerns?: {
        concern: string;
        rationale: string;
        raisedBy: string;
        disposition: "accepted" | "deferred" | "rejected";
    }[] | undefined;
}, {
    sprint_id: string;
    selected_story_ids: string[];
    capacity_used_points: number;
    ceremony_id?: string | undefined;
    is_partial?: boolean | undefined;
    identified_risks?: {
        severity: "low" | "medium" | "high";
        risk: string;
        mitigation: string | null;
    }[] | undefined;
    raised_concerns?: {
        concern: string;
        rationale: string;
        raisedBy: string;
        disposition: "accepted" | "deferred" | "rejected";
    }[] | undefined;
}>;
export type SprintCommitmentInput = z.infer<typeof SprintCommitmentInputSchema>;
export declare const BACKLOG_ERROR_CODES: {
    readonly VALIDATION_REQUIRED_FIELD_MISSING: "VALIDATION_REQUIRED_FIELD_MISSING";
    readonly VALIDATION_LINKED_ARTIFACT_MISSING: "VALIDATION_LINKED_ARTIFACT_MISSING";
    readonly VALIDATION_AC_TEXT_EMPTY: "VALIDATION_AC_TEXT_EMPTY";
    readonly VALIDATION_CAPACITY_NEGATIVE: "VALIDATION_CAPACITY_NEGATIVE";
    readonly NOT_FOUND_EPIC: "NOT_FOUND_EPIC";
    readonly NOT_FOUND_STORY: "NOT_FOUND_STORY";
    readonly NOT_FOUND_SPRINT: "NOT_FOUND_SPRINT";
    readonly NOT_FOUND_TICKET: "NOT_FOUND_TICKET";
    readonly CONFLICT_INVALID_STATE_TRANSITION: "CONFLICT_INVALID_STATE_TRANSITION";
    readonly CONFLICT_SPRINT_CEILING_EXCEEDED: "CONFLICT_SPRINT_CEILING_EXCEEDED";
    readonly CONFLICT_STORY_IN_ACTIVE_SPRINT: "CONFLICT_STORY_IN_ACTIVE_SPRINT";
    readonly CONFLICT_NO_COMMITMENT: "CONFLICT_NO_COMMITMENT";
    readonly BUDGET_SPRINT_EXCEEDED: "BUDGET_SPRINT_EXCEEDED";
    readonly INTEGRATION_MONDAY_DOWN: "INTEGRATION_MONDAY_DOWN";
    readonly INTEGRATION_MONDAY_AUTH: "INTEGRATION_MONDAY_AUTH";
    readonly INTEGRATION_MONDAY_DRIFT: "INTEGRATION_MONDAY_DRIFT";
    readonly RATE_LIMIT_MONDAY_API: "RATE_LIMIT_MONDAY_API";
    readonly STARTUP_ERROR: "STARTUP_ERROR";
    readonly WEBHOOK_INVALID_SIGNATURE: "WEBHOOK_INVALID_SIGNATURE";
    readonly INTERNAL_DB_ERROR: "INTERNAL_DB_ERROR";
};
export type BacklogErrorCode = (typeof BACKLOG_ERROR_CODES)[keyof typeof BACKLOG_ERROR_CODES];
//# sourceMappingURL=types.d.ts.map