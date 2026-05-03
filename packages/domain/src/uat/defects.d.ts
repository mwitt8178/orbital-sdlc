/**
 * uat/defects.ts — DefectService.
 *
 * Per TRD-11 v0.2 §4.3, §8.1, §8.3.
 *
 * Responsibilities:
 *   - createDefect: one defect per failed AC (TRD-11 §8.1 decision). If a defect
 *     for the same (origin_story_id, origin_ac_id) already exists and is still
 *     open/triaged/assigned, update it rather than create a duplicate (idempotent
 *     on re-fail). Emit DefectCreated (new) or DefectReopened (update).
 *   - promoteToBacklog: calls BacklogService.createStory with status='defective'
 *     and wires origin_story_id + defect_id. The fixing_ticket_id on the defects
 *     row is populated by TRD-02 when it receives the DefectAssigned event —
 *     this service does not write fixing_ticket_id (cross-TRD contract).
 *   - assignSeverity: default rule set per TRD-11 §8.3 (R1–R5, first-match-wins).
 *
 * All mutations use EventStore.append; never direct db.insert(events).
 */
import type { DB } from '@orbital/db';
import type { EventStore } from '../events/store.js';
import type { BacklogService } from '../backlog/service.js';
import { type DefectRow, type DefectSeverity, type CreateDefectParams } from './types.js';
export interface SubmitDefectParams {
    /** Task that produced the failing AC (the author task to re-spawn). */
    taskId: string;
    /** AC id that failed. */
    acId: string;
    /** AC text snapshot. */
    acText: string;
    /** Reproduction steps (markdown). */
    reproductionSteps: string;
    /** Operator-declared severity. */
    severity: 'low' | 'medium' | 'high' | 'critical';
    /** Optional suggested fix (markdown). */
    suggestedFix?: string;
    /** User who reported the defect. */
    reportedBy: string;
}
export interface SubmitDefectResult {
    defectId: string;
    defectKey: string;
}
export interface DefectHistoryEntry {
    defectId: string;
    defectKey: string;
    acId: string;
    acText: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    reproductionSteps: string;
    suggestedFix: string | null;
    reportedBy: string;
    iterationNumber: number;
    createdAt: Date;
}
export interface DefectService {
    /**
     * Create a defect for a failed AC, or update an existing open defect for the
     * same AC (idempotent on duplicate re-fail). Returns the defect row.
     */
    createDefect(params: CreateDefectParams): Promise<DefectRow>;
    /**
     * Promote a defect to the backlog as a new story with status='defective'.
     * Calls BacklogService.createStory. Does NOT write fixing_ticket_id — that
     * is TRD-02's responsibility when it handles the DefectAssigned event.
     */
    promoteToBacklog(defectId: string, epicId: string): Promise<{
        storyId: string;
    }>;
    /**
     * Submit a defect from the UAT operator UI.
     * Inserts a uat_defects row (re-using the existing defects table via the
     * metadata jsonb column for repro/suggestedFix), emits DefectReported event.
     * Returns {defectId, defectKey}.
     *
     * Round 6 #3: drives the post-defect-reported hook → re-spawn loop.
     */
    submitDefect(params: SubmitDefectParams): Promise<SubmitDefectResult>;
    /**
     * Return all defects reported against a given task_id, ordered by
     * iteration_number ASC. Used by uat.defects.history tRPC procedure.
     */
    getDefectsForTask(taskId: string): Promise<DefectHistoryEntry[]>;
    /**
     * Mark a defect as resolved (operator clicks "Mark fixed").
     * Transitions state to 'resolved', emits DefectResolved.
     */
    markDefectFixed(defectId: string, resolvedBy: string): Promise<void>;
    /**
     * Assign severity using the TRD-11 §8.3 rule set.
     */
    assignSeverity(params: {
        acText: string;
        failedAcCountForStory: number;
        totalAcCountForStory: number;
        isInActiveSprint: boolean;
        isReopen: boolean;
        acTags?: string[];
        observedValue?: number;
        expectedValue?: number;
    }): DefectSeverity;
}
export declare class DefaultDefectService implements DefectService {
    private readonly db;
    private readonly eventStore;
    private readonly backlogService;
    constructor(db: DB, eventStore: EventStore, backlogService: BacklogService);
    createDefect(params: CreateDefectParams): Promise<DefectRow>;
    submitDefect(params: SubmitDefectParams): Promise<SubmitDefectResult>;
    getDefectsForTask(taskId: string): Promise<DefectHistoryEntry[]>;
    markDefectFixed(defectId: string, resolvedBy: string): Promise<void>;
    promoteToBacklog(defectId: string, epicId: string): Promise<{
        storyId: string;
    }>;
    assignSeverity(params: {
        acText: string;
        failedAcCountForStory: number;
        totalAcCountForStory: number;
        isInActiveSprint: boolean;
        isReopen: boolean;
        acTags?: string[];
        observedValue?: number;
        expectedValue?: number;
    }): DefectSeverity;
}
export declare function createDefectService(db: DB, eventStore: EventStore, backlogService: BacklogService): DefectService;
//# sourceMappingURL=defects.d.ts.map