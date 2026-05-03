/**
 * uat/service.ts — UATService.
 *
 * Per TRD-11 v0.2 §6.1, §7.1, §7.2, §8.
 *
 * Responsibilities:
 *   - startSession: open (or resume) a UAT session for a story. Snapshots ACs
 *     from story_acceptance_criteria at session start.
 *   - markAC: set an AC result to pass/fail. Idempotent on same status; emits
 *     UATACUnmarked + UATACMarked when changing from a prior non-pending state.
 *   - unmarkAC: revert an AC to pending.
 *   - submit: finalise a session. Guards: all ACs must be non-pending (no
 *     VALIDATION_PENDING_ACS_REMAIN). Creates defects for every failed AC.
 *     Transaction: insert N defects + lineage, resolve personas, write events.
 *   - accept / partialAccept: transition from submitted to terminal state.
 *
 * State machines enforced per TRD-11 §7.1 and §7.2.
 * Advisory lock per §8.5 to serialise concurrent submits on the same session.
 * All events via EventStore.append; no direct db.insert(events).
 */
import type { DB } from '@orbital/db';
import type { EventStore } from '../events/store.js';
import type { DefectService } from './defects.js';
import type { PersonaOfRecord } from './persona-of-record.js';
import { type UATSessionRow, type UATACResultRow, type StartSessionInput, type MarkACInput, type UnmarkACInput, type SubmitSessionInput, type MarkACOutput, type SubmitOutput } from './types.js';
export interface UATService {
    startSession(input: StartSessionInput, userActor: {
        userId: string;
        installId?: string;
    }, tenantId?: string): Promise<{
        session: UATSessionRow;
        acResults: UATACResultRow[];
    }>;
    markAC(input: MarkACInput, userId: string, tenantId?: string): Promise<MarkACOutput>;
    unmarkAC(input: UnmarkACInput, userId: string, tenantId?: string): Promise<MarkACOutput>;
    submit(input: SubmitSessionInput, userId: string, tenantId?: string): Promise<SubmitOutput>;
    /**
     * Accept a submitted session (all ACs passed).
     * Throws CONFLICT_INVALID_STATE_TRANSITION if session is not in 'submitted'
     * state or if there are any failed ACs (use partialAccept for that).
     */
    accept(sessionId: string, userId: string, tenantId?: string): Promise<UATSessionRow>;
    /**
     * Partial-accept: some ACs pass, defects already created by submit.
     * Transitions session to 'partially_accepted'. Emits UATPartialAcceptance.
     * Also writes a SprintCompleted event with partial:true flag so SprintService
     * can pick it up (5A does not touch SprintService directly).
     */
    partialAccept(sessionId: string, userId: string, tenantId?: string): Promise<UATSessionRow>;
    getSession(sessionId: string, tenantId?: string): Promise<{
        session: UATSessionRow;
        acResults: UATACResultRow[];
    } | null>;
    listSessions(ticketId: string, tenantId?: string): Promise<Array<{
        session: UATSessionRow;
        acResults: UATACResultRow[];
    }>>;
}
export declare class DefaultUATService implements UATService {
    private readonly db;
    private readonly eventStore;
    private readonly defectService;
    private readonly personaOfRecord;
    constructor(db: DB, eventStore: EventStore, defectService: DefectService, personaOfRecord: PersonaOfRecord);
    startSession(input: StartSessionInput, userActor: {
        userId: string;
        installId?: string;
    }, tenantId?: string): Promise<{
        session: UATSessionRow;
        acResults: UATACResultRow[];
    }>;
    markAC(input: MarkACInput, userId: string, tenantId?: string): Promise<MarkACOutput>;
    unmarkAC(input: UnmarkACInput, userId: string, tenantId?: string): Promise<MarkACOutput>;
    submit(input: SubmitSessionInput, userId: string, tenantId?: string): Promise<SubmitOutput>;
    accept(sessionId: string, userId: string, tenantId?: string): Promise<UATSessionRow>;
    partialAccept(sessionId: string, userId: string, tenantId?: string): Promise<UATSessionRow>;
    getSession(sessionId: string, tenantId?: string): Promise<{
        session: UATSessionRow;
        acResults: UATACResultRow[];
    } | null>;
    listSessions(ticketId: string, tenantId?: string): Promise<Array<{
        session: UATSessionRow;
        acResults: UATACResultRow[];
    }>>;
    /**
     * When all ACs pass AND the task that owns this ticket has iteration_count > 0,
     * emit UATResolutionVerified to signal the defect loop closed successfully.
     *
     * Looks up the most-recently-updated task matching the ticket_id. If no task
     * exists (e.g. test seeds that don't create a tasks row), the event is skipped
     * gracefully — the missing-task case is already validated by startSession.
     */
    private emitResolutionVerifiedIfIterating;
    private getACResults;
    private getCountsTx;
    private buildSubmitOutput;
}
export declare function createUATService(db: DB, eventStore: EventStore, defectService: DefectService, personaOfRecord: PersonaOfRecord): UATService;
//# sourceMappingURL=service.d.ts.map