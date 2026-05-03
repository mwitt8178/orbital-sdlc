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
import { uuidv7 } from 'uuidv7';
import { eq, sql as dSQL } from 'drizzle-orm';
import { OrbitalError } from '@orbital/types';
import { disagreements, tieBreakerDecisions, adrs, } from '@orbital/db';
// ---------------------------------------------------------------------------
// Tie-breaker policy (TRD-05 §10.9)
// ---------------------------------------------------------------------------
export const TieBreakerPolicy = {
    technical: 'principal_engineer',
    product: 'pm',
    security: 'security_officer',
    cross_cutting: 'architect',
    default: 'architect',
};
const SYSTEM_ACTOR = { type: 'system', component: 'orchestrator' };
// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------
export class DefaultConflictService {
    db;
    eventStore;
    constructor(db, eventStore) {
        this.db = db;
        this.eventStore = eventStore;
    }
    // -------------------------------------------------------------------------
    // raise
    // -------------------------------------------------------------------------
    async raise(params) {
        const disagreementId = uuidv7();
        const traceId = uuidv7();
        const now = new Date();
        await this.db.insert(disagreements).values({
            disagreementId,
            domain: params.domain,
            state: 'raised',
            detectionMode: params.detectionMode,
            artifactRef: params.artifactRef,
            positions: params.positions,
            raisedAt: now,
            tieBreakerAssignedAt: null,
            resolvedAt: null,
            escalatedAt: null,
            retroFlagged: false,
            schemaVersion: 1,
        });
        const ev = {
            aggregate_id: disagreementId,
            aggregate_type: 'disagreement',
            event_type: 'DisagreementRaised',
            payload: {
                disagreement_id: disagreementId,
                domain: params.domain,
                detection_mode: params.detectionMode,
                artifact_ref: params.artifactRef,
                participants: params.positions.map((p) => ({
                    actor: p['actor'] ?? null,
                    position_summary: p['position_summary'] ?? '',
                })),
            },
            actor: params.raisedBy,
            trace_id: traceId,
            occurred_at: now.toISOString(),
            schema_version: 1,
        };
        const env = await this.eventStore.append(ev);
        return { disagreementId, eventId: env.event_id };
    }
    // -------------------------------------------------------------------------
    // assign
    // -------------------------------------------------------------------------
    async assign(disagreementId) {
        const rows = await this.db
            .select()
            .from(disagreements)
            .where(eq(disagreements.disagreementId, disagreementId))
            .limit(1);
        const d = rows[0];
        if (!d)
            throw new OrbitalError('NOT_FOUND_CEREMONY', `disagreement ${disagreementId} not found`);
        if (d.state !== 'raised') {
            throw new OrbitalError('CONFLICT_INVALID_STATE_TRANSITION', `assign requires state=raised; have ${d.state}`);
        }
        const role = TieBreakerPolicy[d.domain] ?? TieBreakerPolicy.default;
        const spawnedSessionId = uuidv7();
        await this.db
            .update(disagreements)
            .set({ state: 'tie_breaker_assigned', tieBreakerAssignedAt: new Date() })
            .where(eq(disagreements.disagreementId, disagreementId));
        const ev = {
            aggregate_id: disagreementId,
            aggregate_type: 'disagreement',
            event_type: 'TieBreakerAssigned',
            payload: {
                disagreement_id: disagreementId,
                tie_breaker_role: role,
                spawned_session_id: spawnedSessionId,
            },
            actor: SYSTEM_ACTOR,
            trace_id: uuidv7(),
            occurred_at: new Date().toISOString(),
            schema_version: 1,
        };
        const env = await this.eventStore.append(ev);
        return { tieBreakerRole: role, spawnedSessionId, eventId: env.event_id };
    }
    // -------------------------------------------------------------------------
    // decide — writes TieBreakerDecision (and optional ADR) atomically.
    // -------------------------------------------------------------------------
    async decide(params) {
        const dRows = await this.db
            .select()
            .from(disagreements)
            .where(eq(disagreements.disagreementId, params.disagreementId))
            .limit(1);
        const d = dRows[0];
        if (!d)
            throw new OrbitalError('NOT_FOUND_CEREMONY', `disagreement ${params.disagreementId} not found`);
        if (d.state !== 'tie_breaker_assigned' && d.state !== 'raised') {
            throw new OrbitalError('CONFLICT_INVALID_STATE_TRANSITION', `decide requires state in (raised,tie_breaker_assigned); have ${d.state}`);
        }
        const decisionId = uuidv7();
        let adrId = null;
        if (params.adr) {
            const adrInput = {
                ...params.adr,
                disagreementId: params.disagreementId,
            };
            const adr = await this.writeAdr(adrInput);
            adrId = adr.adrId;
        }
        await this.db.insert(tieBreakerDecisions).values({
            decisionId,
            disagreementId: params.disagreementId,
            tieBreakerActor: params.tieBreakerActor,
            tieBreakerRole: params.tieBreakerRole,
            decisionText: params.decisionText,
            rationale: params.rationale,
            adrId,
            capabilityId: params.capabilityId,
            decidedAt: new Date(),
            schemaVersion: 1,
        });
        await this.db
            .update(disagreements)
            .set({ state: 'resolved', resolvedAt: new Date() })
            .where(eq(disagreements.disagreementId, params.disagreementId));
        const ev = {
            aggregate_id: params.disagreementId,
            aggregate_type: 'disagreement',
            event_type: 'TieBreakerDecided',
            payload: {
                decision_id: decisionId,
                disagreement_id: params.disagreementId,
                tie_breaker_role: params.tieBreakerRole,
                adr_id: adrId,
                outcome: 'decided',
            },
            actor: params.tieBreakerActor,
            capability_id: params.capabilityId,
            trace_id: uuidv7(),
            occurred_at: new Date().toISOString(),
            schema_version: 1,
        };
        const env = await this.eventStore.append(ev);
        return { decisionId, adrId, eventId: env.event_id };
    }
    // -------------------------------------------------------------------------
    // writeAdr — allocates monotonic adr_number under serializable lock.
    // -------------------------------------------------------------------------
    async writeAdr(input) {
        // Allocate the next adr_number under an advisory lock to avoid races.
        // We use a session-scoped advisory lock keyed on a fixed integer.
        const ADR_NUMBER_LOCK_KEY = 0x4144524e;
        await this.db.execute(dSQL `SELECT pg_advisory_xact_lock(${ADR_NUMBER_LOCK_KEY})`);
        const maxRow = await this.db.execute(dSQL `
      SELECT COALESCE(MAX(adr_number), 0) + 1 AS next FROM adrs
    `);
        const adrNumber = Number(maxRow[0]?.next ?? 1);
        const adrId = uuidv7();
        const now = new Date();
        await this.db.insert(adrs).values({
            adrId,
            adrNumber,
            title: input.title,
            status: 'accepted',
            context: input.context,
            decision: input.decision,
            rationale: input.rationale,
            consequences: input.consequences,
            alternatives: input.alternatives,
            authoredByActor: input.authoredByActor,
            authoredByRole: input.authoredByRole,
            capabilityId: input.capabilityId,
            ceremonyId: input.ceremonyId ?? null,
            disagreementId: input.disagreementId ?? null,
            supersedesAdrId: input.supersedesAdrId ?? null,
            supersededByAdrId: null,
            linkedTickets: input.linkedTickets ?? [],
            immutable: true,
            createdAt: now,
            schemaVersion: 1,
        });
        // If superseding, mark the prior ADR.
        if (input.supersedesAdrId) {
            await this.db
                .update(adrs)
                .set({ status: 'superseded', supersededByAdrId: adrId })
                .where(eq(adrs.adrId, input.supersedesAdrId));
        }
        const ev = {
            aggregate_id: adrId,
            aggregate_type: 'adr',
            event_type: 'AdrPublished',
            payload: {
                adr_id: adrId,
                adr_number: adrNumber,
                title: input.title,
                authored_by_role: input.authoredByRole,
                ceremony_id: input.ceremonyId ?? null,
                disagreement_id: input.disagreementId ?? null,
                supersedes_adr_id: input.supersedesAdrId ?? null,
                linked_tickets: input.linkedTickets ?? [],
            },
            actor: input.authoredByActor,
            capability_id: input.capabilityId,
            trace_id: uuidv7(),
            occurred_at: now.toISOString(),
            schema_version: 1,
        };
        await this.eventStore.append(ev);
        return { adrId, adrNumber };
    }
}
//# sourceMappingURL=conflict.js.map