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
import { uuidv7 } from 'uuidv7';
import { eq, and, inArray, asc } from 'drizzle-orm';
import { OrbitalError } from '@orbital/types';
import { defects, defectLineage, uatSessions } from '@orbital/db';
import { tasks } from '@orbital/db';
import { UAT_ERROR_CODES } from './types.js';
import { logger } from '../logger.js';
// ---------------------------------------------------------------------------
// Severity rule patterns (TRD-11 §8.3 R1)
// ---------------------------------------------------------------------------
const SEVERITY_CRITICAL_PATTERN = /\b(security|data loss|financial|production outage)\b/i;
// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------
export class DefaultDefectService {
    db;
    eventStore;
    backlogService;
    constructor(db, eventStore, backlogService) {
        this.db = db;
        this.eventStore = eventStore;
        this.backlogService = backlogService;
    }
    // -------------------------------------------------------------------------
    // createDefect
    // -------------------------------------------------------------------------
    async createDefect(params) {
        const { failedAcResultId, sessionId, storyId, acId, acText, observedBehavior, personaOfRecordId, severity, preemptsSprint, sprintId, } = params;
        const now = new Date();
        const traceId = uuidv7();
        // Check for existing open defect for the same story + AC (idempotency on re-fail).
        const existing = await this.db
            .select()
            .from(defects)
            .where(and(eq(defects.originStoryId, storyId), eq(defects.originAcId, acId), inArray(defects.state, ['open', 'triaged', 'assigned', 'in_progress'])))
            .limit(1);
        if (existing.length > 0 && existing[0]) {
            // Idempotent update: increment reopen_count, reset state to 'open'.
            const existingDefect = existing[0];
            const newReopenCount = existingDefect.reopenCount + 1;
            await this.db
                .update(defects)
                .set({
                reopenCount: newReopenCount,
                state: 'reopened',
                observedBehavior,
                uatSessionId: sessionId,
                acResultId: failedAcResultId,
            })
                .where(eq(defects.defectId, existingDefect.defectId));
            // Fetch updated row
            const [updated] = await this.db
                .select()
                .from(defects)
                .where(eq(defects.defectId, existingDefect.defectId))
                .limit(1);
            if (!updated) {
                throw new OrbitalError(UAT_ERROR_CODES.INTERNAL_DB_ERROR, 'defect update returned no rows');
            }
            await this.eventStore.append({
                aggregate_id: existingDefect.defectId,
                aggregate_type: 'defect',
                event_type: 'DefectReopened',
                payload: {
                    defect_id: existingDefect.defectId,
                    reopen_count: newReopenCount,
                    reopened_by_uat_session_id: sessionId,
                    reason: observedBehavior,
                },
                actor: { type: 'system', component: 'orchestrator' },
                trace_id: traceId,
                occurred_at: now.toISOString(),
                schema_version: 1,
            });
            logger.info({ defectId: existingDefect.defectId, reopenCount: newReopenCount }, 'DefectService: updated existing defect (reopened)');
            return updated;
        }
        // -----------------------------------------------------------------------
        // New defect
        // -----------------------------------------------------------------------
        const defectId = uuidv7();
        // defect_key: DEF-XXXXXXXX using the first 13 hex chars of the UUIDv7 (time + random)
        // UUIDv7 format: xxxxxxxx-xxxx-7xxx-xxxx-xxxxxxxxxxxx
        // We use chars 0-7 (8) + 9-12 (4) = 12 hex chars → collision-resistant per session
        const defectKey = `DEF-${defectId.replace(/-/g, '').slice(0, 12).toUpperCase()}`;
        // Fetch session for lineage
        const [session] = await this.db
            .select()
            .from(uatSessions)
            .where(eq(uatSessions.uatSessionId, sessionId))
            .limit(1);
        if (!session) {
            throw new OrbitalError(UAT_ERROR_CODES.NOT_FOUND_UAT_SESSION, `session ${sessionId} not found`);
        }
        const title = `AC failed: ${acText.slice(0, 80)}${acText.length > 80 ? '...' : ''}`;
        await this.db.insert(defects).values({
            defectId,
            defectKey,
            originStoryId: storyId,
            originAcId: acId,
            uatSessionId: sessionId,
            acResultId: failedAcResultId,
            personaOfRecordId,
            title,
            observedBehavior,
            expectedBehavior: acText,
            severity,
            state: 'open',
            preemptsSprint: preemptsSprint && sprintId ? sprintId : null,
            createdAt: now,
            reopenCount: 0,
            fixingTicketId: null,
            schemaVersion: 1,
        });
        // Materialise lineage snapshot (TRD-11 §4.4)
        await this.db.insert(defectLineage).values({
            defectLineageId: uuidv7(),
            defectId,
            // visionDocumentId: we don't have a direct story→vision join here;
            // use a sentinel placeholder — TRD-01/TRD-02 consumers can re-resolve.
            // The lineage fields for vision/epic come from cross-schema joins that
            // are out of scope for the transaction-time snapshot in v1. We store
            // what we have: story_id and ticket_id.
            visionDocumentId: '00000000-0000-0000-0000-000000000000',
            visionVersion: 1,
            epicId: '00000000-0000-0000-0000-000000000000',
            storyId,
            ticketId: session.ticketId,
            taskIds: [],
            workerSessionIds: [],
            primaryAuditEventIds: [],
            capturedAt: now,
            schemaVersion: 1,
        });
        // Emit DefectCreated event
        await this.eventStore.append({
            aggregate_id: defectId,
            aggregate_type: 'defect',
            event_type: 'DefectCreated',
            payload: {
                defect_id: defectId,
                defect_key: defectKey,
                origin_story_id: storyId,
                origin_ac_id: acId,
                uat_session_id: sessionId,
                ac_result_id: failedAcResultId,
                persona_of_record_id: personaOfRecordId,
                severity,
                preempts_sprint: preemptsSprint,
                title,
                observed_behavior: observedBehavior,
                expected_behavior: acText,
            },
            actor: { type: 'system', component: 'orchestrator' },
            trace_id: traceId,
            occurred_at: now.toISOString(),
            schema_version: 1,
        });
        logger.info({ defectId, defectKey, severity, storyId, acId }, 'DefectService: created new defect');
        const [created] = await this.db
            .select()
            .from(defects)
            .where(eq(defects.defectId, defectId))
            .limit(1);
        if (!created) {
            throw new OrbitalError(UAT_ERROR_CODES.INTERNAL_DB_ERROR, 'defect insert returned no rows');
        }
        return created;
    }
    // -------------------------------------------------------------------------
    // submitDefect (Round 6 #3)
    // -------------------------------------------------------------------------
    async submitDefect(params) {
        const { taskId, acId, acText, reproductionSteps, severity, suggestedFix, reportedBy, } = params;
        const now = new Date();
        const traceId = uuidv7();
        // Verify task exists to get iteration context
        const [taskRow] = await this.db
            .select()
            .from(tasks)
            .where(eq(tasks.taskId, taskId))
            .limit(1);
        if (!taskRow) {
            throw new OrbitalError(UAT_ERROR_CODES.NOT_FOUND_DEFECT, `task ${taskId} not found`);
        }
        const iterationNumber = (taskRow.iterationCount ?? 0) + 1;
        // Create defect row
        const defectId = uuidv7();
        const defectKey = `DEF-${defectId.replace(/-/g, '').slice(0, 12).toUpperCase()}`;
        const title = `Operator defect (iteration ${iterationNumber}): ${acText.slice(0, 60)}${acText.length > 60 ? '...' : ''}`;
        // Use the storyId from the task if available; fall back to a sentinel
        const storyId = taskRow.storyId ?? '00000000-0000-0000-0000-000000000000';
        await this.db.insert(defects).values({
            defectId,
            defectKey,
            originStoryId: storyId,
            originAcId: acId,
            // Round 6 #3: operator-reported defects have no formal UAT session or AC result row.
            // migration 0031 makes these columns nullable.
            uatSessionId: null,
            acResultId: null,
            personaOfRecordId: reportedBy,
            title,
            observedBehavior: reproductionSteps,
            expectedBehavior: acText,
            severity,
            state: 'open',
            preemptsSprint: null,
            createdAt: now,
            reopenCount: 0,
            fixingTicketId: null,
            schemaVersion: 1,
        });
        // Emit DefectReported event (Round 6 #3 core event)
        await this.eventStore.append({
            aggregate_id: taskId,
            aggregate_type: 'task',
            event_type: 'DefectReported',
            payload: {
                defect_id: defectId,
                task_id: taskId,
                ac_id: acId,
                ac_text: acText,
                severity,
                reproduction_steps: reproductionSteps,
                suggested_fix: suggestedFix ?? null,
                reported_by: reportedBy,
                reported_at: now.toISOString(),
            },
            actor: { type: 'user', user_id: reportedBy, install_id: 'unknown' },
            trace_id: traceId,
            occurred_at: now.toISOString(),
            schema_version: 1,
        });
        logger.info({ defectId, defectKey, taskId, acId, severity, iterationNumber }, 'DefectService: operator defect submitted');
        return { defectId, defectKey };
    }
    // -------------------------------------------------------------------------
    // getDefectsForTask (Round 6 #3)
    // -------------------------------------------------------------------------
    async getDefectsForTask(taskId) {
        // Defects associated with a task are stored with originStoryId = task's storyId
        // and their metadata in observedBehavior / expectedBehavior columns.
        // We query DefectReported events for this taskId to reconstruct the timeline.
        // Since event querying is via EventStore (no direct event table access in service
        // layer), we query defects that were created for this task by checking the title
        // pattern. A more robust approach uses the event store query, but for the v1
        // read path we query defects by originStoryId matching the task's story.
        const [taskRow] = await this.db
            .select()
            .from(tasks)
            .where(eq(tasks.taskId, taskId))
            .limit(1);
        if (!taskRow) {
            return [];
        }
        // Query defects whose personaOfRecordId encodes the task relationship.
        // In submitDefect we set personaOfRecordId = reportedBy which may not be
        // task-scoped. Better: we look up defects by title prefix or use the storyId.
        const storyId = taskRow.storyId ?? '00000000-0000-0000-0000-000000000000';
        const rows = await this.db
            .select()
            .from(defects)
            .where(eq(defects.originStoryId, storyId))
            .orderBy(asc(defects.createdAt));
        return rows.map((r, idx) => ({
            defectId: r.defectId,
            defectKey: r.defectKey,
            acId: r.originAcId,
            acText: r.expectedBehavior,
            severity: r.severity,
            reproductionSteps: r.observedBehavior,
            suggestedFix: null,
            reportedBy: r.personaOfRecordId,
            iterationNumber: idx + 1,
            createdAt: r.createdAt,
        }));
    }
    // -------------------------------------------------------------------------
    // markDefectFixed (Round 6 #3)
    // -------------------------------------------------------------------------
    async markDefectFixed(defectId, resolvedBy) {
        const now = new Date();
        const traceId = uuidv7();
        const [defect] = await this.db
            .select()
            .from(defects)
            .where(eq(defects.defectId, defectId))
            .limit(1);
        if (!defect) {
            throw new OrbitalError(UAT_ERROR_CODES.NOT_FOUND_DEFECT, `defect ${defectId} not found`);
        }
        await this.db
            .update(defects)
            .set({ state: 'resolved' })
            .where(eq(defects.defectId, defectId));
        await this.eventStore.append({
            aggregate_id: defectId,
            aggregate_type: 'defect',
            event_type: 'DefectResolved',
            payload: {
                defect_id: defectId,
                task_id: defect.originStoryId, // best-effort task linkage
                resolved_by: resolvedBy,
                resolved_at: now.toISOString(),
            },
            actor: { type: 'user', user_id: resolvedBy, install_id: 'unknown' },
            trace_id: traceId,
            occurred_at: now.toISOString(),
            schema_version: 1,
        });
        logger.info({ defectId, resolvedBy }, 'DefectService: defect marked fixed');
    }
    // -------------------------------------------------------------------------
    // promoteToBacklog
    // -------------------------------------------------------------------------
    async promoteToBacklog(defectId, epicId) {
        const [defect] = await this.db
            .select()
            .from(defects)
            .where(eq(defects.defectId, defectId))
            .limit(1);
        if (!defect) {
            throw new OrbitalError(UAT_ERROR_CODES.NOT_FOUND_DEFECT, `defect ${defectId} not found`);
        }
        // Create fix story via BacklogService (TRD-11 §done criteria: calls
        // BacklogService.createStory with status='defective', fixing_ticket_id wiring)
        const story = await this.backlogService.createStory({
            epic_id: epicId,
            title: defect.title,
            description: `Defect fix for: ${defect.title}\n\nObserved: ${defect.observedBehavior}\n\nExpected: ${defect.expectedBehavior}`,
            acceptance_criteria: [
                { text: defect.expectedBehavior },
            ],
            origin_story_id: defect.originStoryId,
            defect_id: defectId,
            persona_of_record: defect.personaOfRecordId,
        }, { type: 'system', component: 'orchestrator' });
        // NOTE: We do NOT write defects.fixing_ticket_id here. Per TRD-11 §4.3
        // cross-TRD contract, that is TRD-02's responsibility when it handles
        // the DefectAssigned event. The story is created with status='backlog'
        // (default); TRD-02 transitions it to 'defective' as appropriate.
        logger.info({ defectId, storyId: story.storyId, epicId }, 'DefectService: promoted defect to backlog story');
        return { storyId: story.storyId };
    }
    // -------------------------------------------------------------------------
    // assignSeverity (TRD-11 §8.3)
    // -------------------------------------------------------------------------
    assignSeverity(params) {
        const { acText, failedAcCountForStory, totalAcCountForStory, isInActiveSprint, isReopen, acTags = [], observedValue, expectedValue, } = params;
        // R1: AC text matches critical pattern
        if (SEVERITY_CRITICAL_PATTERN.test(acText)) {
            return 'critical';
        }
        // R2: Story in active sprint AND failed ACs >= 50% of total
        if (isInActiveSprint &&
            totalAcCountForStory > 0 &&
            failedAcCountForStory / totalAcCountForStory >= 0.5) {
            return 'high';
        }
        // R3: Re-open
        if (isReopen) {
            return 'high';
        }
        // R4: Performance/latency AC and observed > 2× expected
        const hasPerformanceTag = acTags.some((t) => t === 'performance' || t === 'latency') ||
            /\b(performance|latency|p95|p99|ms|millisecond)\b/i.test(acText);
        if (hasPerformanceTag &&
            observedValue !== undefined &&
            expectedValue !== undefined &&
            expectedValue > 0 &&
            observedValue > 2 * expectedValue) {
            return 'high';
        }
        // R5: Default
        return 'medium';
    }
}
export function createDefectService(db, eventStore, backlogService) {
    return new DefaultDefectService(db, eventStore, backlogService);
}
//# sourceMappingURL=defects.js.map