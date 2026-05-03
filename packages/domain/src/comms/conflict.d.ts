/**
 * conflict.ts — ConflictService.
 *
 * Per TRD-05 §4.5, §6.2.11–§6.2.12, §10.9 (tie-breaker selection),
 * §7.7 (state machine).
 *
 * Lifecycle: raised → tie_breaker_assigned → resolved (ADR written)
 *                                      ↓
 *                                  escalated (tie-breaker can't decide)
 *
 * The service exposes:
 *   - raise(domain, artifactRef, positions, detectionMode) → DisagreementId
 *   - assign(disagreementId, role) — selects tie-breaker via TieBreakerPolicy
 *   - decide(disagreementId, decisionText, rationale, capabilityId) — writes
 *     a TieBreakerDecision and (typically) an ADR via writeAdr()
 *   - writeAdr(params) — standalone ADR write; allocates monotonic adr_number
 */
import type { DB } from '@orbital/db';
import type { EventStore } from '../events/store.js';
import type { Actor } from '@orbital/types';
import { type DisagreementDomain } from '@orbital/db';
export declare const TieBreakerPolicy: Record<DisagreementDomain | 'default', string>;
export interface AdrInput {
    title: string;
    context: string;
    decision: string;
    rationale: string;
    consequences: {
        positive: string[];
        negative: string[];
        risks: string[];
    };
    alternatives: Array<{
        option: string;
        why_rejected: string;
    }>;
    authoredByActor: Actor;
    authoredByRole: string;
    capabilityId: string;
    ceremonyId?: string;
    disagreementId?: string;
    supersedesAdrId?: string;
    linkedTickets?: string[];
}
export interface ConflictService {
    raise(params: {
        domain: DisagreementDomain;
        detectionMode: 'explicit_flag' | 'orchestrator_heuristic';
        artifactRef: {
            type: string;
            id: string;
        };
        positions: Array<Record<string, unknown>>;
        raisedBy: Actor;
    }): Promise<{
        disagreementId: string;
        eventId: string;
    }>;
    assign(disagreementId: string): Promise<{
        tieBreakerRole: string;
        spawnedSessionId: string;
        eventId: string;
    }>;
    decide(params: {
        disagreementId: string;
        tieBreakerActor: Actor;
        tieBreakerRole: string;
        decisionText: string;
        rationale: string;
        capabilityId: string;
        adr?: AdrInput;
    }): Promise<{
        decisionId: string;
        adrId: string | null;
        eventId: string;
    }>;
    writeAdr(input: AdrInput): Promise<{
        adrId: string;
        adrNumber: number;
    }>;
}
export declare class DefaultConflictService implements ConflictService {
    private readonly db;
    private readonly eventStore;
    constructor(db: DB, eventStore: EventStore);
    raise(params: {
        domain: DisagreementDomain;
        detectionMode: 'explicit_flag' | 'orchestrator_heuristic';
        artifactRef: {
            type: string;
            id: string;
        };
        positions: Array<Record<string, unknown>>;
        raisedBy: Actor;
    }): Promise<{
        disagreementId: string;
        eventId: string;
    }>;
    assign(disagreementId: string): Promise<{
        tieBreakerRole: string;
        spawnedSessionId: string;
        eventId: string;
    }>;
    decide(params: {
        disagreementId: string;
        tieBreakerActor: Actor;
        tieBreakerRole: string;
        decisionText: string;
        rationale: string;
        capabilityId: string;
        adr?: AdrInput;
    }): Promise<{
        decisionId: string;
        adrId: string | null;
        eventId: string;
    }>;
    writeAdr(input: AdrInput): Promise<{
        adrId: string;
        adrNumber: number;
    }>;
}
//# sourceMappingURL=conflict.d.ts.map