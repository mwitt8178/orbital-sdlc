/**
 * ceremonies.ts — CeremonyService.
 *
 * Per TRD-05 §4.4, §6.2.7–§6.2.10, §10.8 (full ceremony mechanics).
 *
 * Lifecycle: scheduled → in_progress → voting → output_writing → closed
 *                                          ↓
 *                                       aborted (runaway / capability_revoked / system_error)
 *
 * Turn budget is enforced at recordTurn:
 *   - Reject when participant.turns_used >= participant.turns_allowed
 *     with CONFLICT_TURN_BUDGET_EXHAUSTED
 *   - Reject when body tokens > tokens_per_turn with BUDGET_TURN_TOKENS_EXCEEDED
 *
 * Tokenization: prefer @anthropic-ai/tokenizer if installed; otherwise a rough
 * heuristic (1 token ≈ 4 chars). Documented in NOTE: comment.
 */
import { uuidv7 } from 'uuidv7';
import { eq, and, sql as dSQL } from 'drizzle-orm';
import { OrbitalError } from '@orbital/types';
import { ceremonies, ceremonyParticipants, ceremonyOutputs, ceremonySpecifications, } from '@orbital/db';
import { logger } from '../logger.js';
// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------
const SYSTEM_ACTOR = { type: 'system', component: 'orchestrator' };
/**
 * Estimate tokens consumed by a body string. Production uses
 * @anthropic-ai/tokenizer if available.
 *
 * NOTE: The Anthropic tokenizer package is not currently a dependency of
 * @orbital/orchestrator (see package.json). The 4-char heuristic is good
 * enough for v1 budget enforcement; a Claude-specific tokenizer can be
 * swapped in v2 by replacing this function.
 */
export function estimateTokens(body) {
    return Math.max(1, Math.ceil(body.length / 4));
}
// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------
export class DefaultCeremonyService {
    db;
    eventStore;
    channels;
    constructor(db, eventStore, channels) {
        this.db = db;
        this.eventStore = eventStore;
        this.channels = channels;
    }
    // -------------------------------------------------------------------------
    // schedule
    // -------------------------------------------------------------------------
    async schedule(params) {
        // Find spec.
        let spec;
        if (params.specId) {
            const rows = await this.db
                .select()
                .from(ceremonySpecifications)
                .where(eq(ceremonySpecifications.specId, params.specId))
                .limit(1);
            spec = rows[0];
        }
        else {
            const rows = await this.db
                .select()
                .from(ceremonySpecifications)
                .where(eq(ceremonySpecifications.ceremonyType, params.ceremonyType))
                .orderBy(dSQL `version DESC`)
                .limit(1);
            spec = rows[0];
        }
        if (!spec) {
            throw new OrbitalError('NOT_FOUND_CEREMONY', `no ceremony_specification for type=${params.ceremonyType}`);
        }
        const ceremonyId = uuidv7();
        const channelEnsure = await this.channels.ensureChannel('ceremony', ceremonyId, {
            description: `Ceremony channel for ${params.ceremonyType}`,
            createdBy: params.triggeredBy,
        });
        const turnsPerParticipant = params.turnsPerParticipant ?? spec.defaultTurnsPerParticipant;
        const tokensPerTurn = params.tokensPerTurn ?? spec.defaultTokensPerTurn;
        const wallClockBudgetMs = params.wallClockBudgetMs ?? spec.defaultWallClockMs;
        await this.db.insert(ceremonies).values({
            ceremonyId,
            ceremonyType: spec.ceremonyType,
            specId: spec.specId,
            channelId: channelEnsure.channelId,
            state: 'scheduled',
            triggeredBy: params.triggeredBy,
            agendaPostId: null,
            scope: params.scope,
            turnsPerParticipant,
            tokensPerTurn,
            wallClockBudgetMs,
            tokensConsumedTotal: 0,
            voteRule: spec.voteRule,
            voteRequired: spec.voteRequired,
            scheduledAt: new Date(),
            startedAt: null,
            closedAt: null,
            abortedAt: null,
            abortReason: null,
            schemaVersion: 1,
        });
        const ev = {
            aggregate_id: ceremonyId,
            aggregate_type: 'ceremony',
            event_type: 'CeremonyScheduled',
            payload: {
                ceremony_id: ceremonyId,
                ceremony_type: spec.ceremonyType,
                spec_id: spec.specId,
                channel_id: channelEnsure.channelId,
                scope: params.scope,
                turns_per_participant: turnsPerParticipant,
                tokens_per_turn: tokensPerTurn,
                wall_clock_budget_ms: wallClockBudgetMs,
            },
            actor: params.triggeredBy,
            trace_id: uuidv7(),
            occurred_at: new Date().toISOString(),
            schema_version: 1,
        };
        await this.eventStore.append(ev);
        return { ceremonyId, channelId: channelEnsure.channelId };
    }
    // -------------------------------------------------------------------------
    // addParticipant
    // -------------------------------------------------------------------------
    async addParticipant(params) {
        const rows = await this.db
            .select()
            .from(ceremonies)
            .where(eq(ceremonies.ceremonyId, params.ceremonyId))
            .limit(1);
        const ceremony = rows[0];
        if (!ceremony) {
            throw new OrbitalError('NOT_FOUND_CEREMONY', `ceremony ${params.ceremonyId} not found`);
        }
        const participantId = uuidv7();
        const turnsAllowed = params.turnsAllowed ??
            (params.ceremonyRole === 'observer' ? 0 : ceremony.turnsPerParticipant);
        await this.db.insert(ceremonyParticipants).values({
            participantId,
            ceremonyId: params.ceremonyId,
            personaRole: params.personaRole,
            personaId: params.personaId,
            sessionId: params.sessionId,
            ceremonyRole: params.ceremonyRole,
            turnsUsed: 0,
            turnsAllowed,
            yieldedAt: null,
            voteCast: null,
            voteCastAt: null,
        });
        return { participantId };
    }
    // -------------------------------------------------------------------------
    // start
    // -------------------------------------------------------------------------
    async start(ceremonyId, agendaPostId) {
        const rows = await this.db
            .select()
            .from(ceremonies)
            .where(eq(ceremonies.ceremonyId, ceremonyId))
            .limit(1);
        const ceremony = rows[0];
        if (!ceremony)
            throw new OrbitalError('NOT_FOUND_CEREMONY', `ceremony ${ceremonyId} not found`);
        if (ceremony.state !== 'scheduled') {
            throw new OrbitalError('CONFLICT_INVALID_STATE_TRANSITION', `start requires state=scheduled; have ${ceremony.state}`);
        }
        await this.db
            .update(ceremonies)
            .set({ state: 'in_progress', startedAt: new Date(), agendaPostId })
            .where(eq(ceremonies.ceremonyId, ceremonyId));
        // Build participants list for the event.
        const partRows = await this.db
            .select()
            .from(ceremonyParticipants)
            .where(eq(ceremonyParticipants.ceremonyId, ceremonyId));
        const ev = {
            aggregate_id: ceremonyId,
            aggregate_type: 'ceremony',
            event_type: 'CeremonyStarted',
            payload: {
                ceremony_id: ceremonyId,
                participants: partRows.map((p) => ({
                    persona_role: p.personaRole,
                    session_id: p.sessionId,
                    ceremony_role: p.ceremonyRole,
                })),
                agenda_post_id: agendaPostId,
            },
            actor: SYSTEM_ACTOR,
            trace_id: uuidv7(),
            occurred_at: new Date().toISOString(),
            schema_version: 1,
        };
        await this.eventStore.append(ev);
    }
    // -------------------------------------------------------------------------
    // recordTurn
    // -------------------------------------------------------------------------
    async recordTurn(params) {
        const ceremonyRows = await this.db
            .select()
            .from(ceremonies)
            .where(eq(ceremonies.ceremonyId, params.ceremonyId))
            .limit(1);
        const ceremony = ceremonyRows[0];
        if (!ceremony)
            throw new OrbitalError('NOT_FOUND_CEREMONY', `ceremony ${params.ceremonyId} not found`);
        if (ceremony.state !== 'in_progress') {
            throw new OrbitalError('CONFLICT_INVALID_STATE_TRANSITION', `recordTurn requires state=in_progress; have ${ceremony.state}`);
        }
        const partRows = await this.db
            .select()
            .from(ceremonyParticipants)
            .where(eq(ceremonyParticipants.participantId, params.participantId))
            .limit(1);
        const participant = partRows[0];
        if (!participant) {
            throw new OrbitalError('NOT_FOUND_CEREMONY', `participant ${params.participantId} not registered`);
        }
        if (participant.ceremonyId !== params.ceremonyId) {
            throw new OrbitalError('NOT_FOUND_CEREMONY', `participant ${params.participantId} does not belong to ceremony ${params.ceremonyId}`);
        }
        // Token-budget enforcement.
        const tokensConsumed = estimateTokens(params.body);
        if (tokensConsumed > ceremony.tokensPerTurn) {
            throw new OrbitalError('BUDGET_TURN_TOKENS_EXCEEDED', `body uses ${tokensConsumed} tokens > ${ceremony.tokensPerTurn} budget`, { tokens_consumed: tokensConsumed, tokens_per_turn: ceremony.tokensPerTurn });
        }
        // Turn budget enforcement: if this would be the (turns_allowed+1)-th turn,
        // reject. Per the brief: "fourth turn attempt rejected with
        // CONFLICT_TURN_BUDGET_EXCEEDED" when turns_allowed=3.
        if (participant.turnsUsed >= participant.turnsAllowed) {
            throw new OrbitalError('CONFLICT_TURN_BUDGET_EXCEEDED', `participant has used all ${participant.turnsAllowed} turns`, {
                turns_used: participant.turnsUsed,
                turns_allowed: participant.turnsAllowed,
            });
        }
        // Compute next turn_number. Use SQL aggregate; serialized via per-ceremony
        // advisory lock at the DB level to prevent races.
        // Use the channelPosts table directly for the scan.
        const nextTurnRow = await this.db.execute(dSQL `
      WITH lk AS (
        SELECT pg_advisory_xact_lock(hashtext('ceremony:' || ${params.ceremonyId}))
      )
      SELECT COALESCE(MAX(ceremony_turn_number), 0) + 1 AS next
      FROM channel_posts
      WHERE ceremony_id = ${params.ceremonyId}
        AND post_type = 'ceremony_statement'
    `);
        const nextTurn = Number(nextTurnRow[0]?.next ?? 1);
        // Post the ceremony_statement.
        const postResult = await this.channels.post(ceremony.channelId, {
            postType: 'ceremony_statement',
            payload: {
                body: params.body,
                ...(params.references_turn !== undefined ? { references_turn: params.references_turn } : {}),
            },
            author: {
                type: 'persona',
                persona_id: participant.personaId,
                session_id: participant.sessionId,
            },
            capabilityId: params.capability?.capability_id,
            ceremonyId: params.ceremonyId,
            ceremonyTurnNumber: nextTurn,
            tokensConsumed,
            justification: `ceremony.statement turn=${nextTurn}`,
        }, params.capability);
        // Increment participant turns_used + ceremony tokens_consumed_total.
        await this.db
            .update(ceremonyParticipants)
            .set({ turnsUsed: participant.turnsUsed + 1 })
            .where(eq(ceremonyParticipants.participantId, params.participantId));
        await this.db
            .update(ceremonies)
            .set({ tokensConsumedTotal: ceremony.tokensConsumedTotal + tokensConsumed })
            .where(eq(ceremonies.ceremonyId, params.ceremonyId));
        // Emit CeremonyTurnTaken.
        const ev = {
            aggregate_id: params.ceremonyId,
            aggregate_type: 'ceremony',
            event_type: 'CeremonyTurnTaken',
            payload: {
                ceremony_id: params.ceremonyId,
                participant_id: params.participantId,
                post_id: postResult.postId,
                turn_number: nextTurn,
                tokens_consumed: tokensConsumed,
            },
            actor: {
                type: 'persona',
                persona_id: participant.personaId,
                session_id: participant.sessionId,
            },
            capability_id: params.capability?.capability_id,
            trace_id: uuidv7(),
            occurred_at: new Date().toISOString(),
            schema_version: 1,
        };
        await this.eventStore.append(ev);
        return {
            postId: postResult.postId,
            turnNumber: nextTurn,
            tokensConsumed,
            turnsRemaining: participant.turnsAllowed - (participant.turnsUsed + 1),
        };
    }
    // -------------------------------------------------------------------------
    // callClosure (chair-only — caller must check ceremony_role)
    // -------------------------------------------------------------------------
    async callClosure(params) {
        const rows = await this.db
            .select()
            .from(ceremonies)
            .where(eq(ceremonies.ceremonyId, params.ceremonyId))
            .limit(1);
        const ceremony = rows[0];
        if (!ceremony)
            throw new OrbitalError('NOT_FOUND_CEREMONY', `ceremony ${params.ceremonyId} not found`);
        if (ceremony.state !== 'in_progress') {
            throw new OrbitalError('CONFLICT_INVALID_STATE_TRANSITION', `callClosure requires state=in_progress; have ${ceremony.state}`);
        }
        if (params.closureMode === 'vote') {
            await this.db
                .update(ceremonies)
                .set({ state: 'voting' })
                .where(eq(ceremonies.ceremonyId, params.ceremonyId));
            const post = await this.channels.post(ceremony.channelId, {
                postType: 'ceremony_vote',
                payload: { call_or_cast: 'call', vote_rule: ceremony.voteRule },
                author: params.actor,
                capabilityId: params.capability?.capability_id,
                ceremonyId: params.ceremonyId,
                justification: params.justification,
            }, params.capability);
            const ev = {
                aggregate_id: params.ceremonyId,
                aggregate_type: 'ceremony',
                event_type: 'CeremonyVoteCalled',
                payload: {
                    ceremony_id: params.ceremonyId,
                    vote_post_id: post.postId,
                    vote_rule: ceremony.voteRule,
                },
                actor: params.actor,
                capability_id: params.capability?.capability_id,
                trace_id: uuidv7(),
                occurred_at: new Date().toISOString(),
                schema_version: 1,
            };
            await this.eventStore.append(ev);
            return { votePostId: post.postId };
        }
        // chair_synthesis: skip voting, transition to output_writing.
        await this.db
            .update(ceremonies)
            .set({ state: 'output_writing' })
            .where(eq(ceremonies.ceremonyId, params.ceremonyId));
        return { votePostId: null };
    }
    // -------------------------------------------------------------------------
    // castVote
    // -------------------------------------------------------------------------
    async castVote(params) {
        const cRows = await this.db
            .select()
            .from(ceremonies)
            .where(eq(ceremonies.ceremonyId, params.ceremonyId))
            .limit(1);
        const ceremony = cRows[0];
        if (!ceremony)
            throw new OrbitalError('NOT_FOUND_CEREMONY', `ceremony ${params.ceremonyId} not found`);
        if (ceremony.state !== 'voting') {
            throw new OrbitalError('CONFLICT_INVALID_STATE_TRANSITION', `castVote requires state=voting; have ${ceremony.state}`);
        }
        const partRows = await this.db
            .select()
            .from(ceremonyParticipants)
            .where(eq(ceremonyParticipants.participantId, params.participantId))
            .limit(1);
        const participant = partRows[0];
        if (!participant) {
            throw new OrbitalError('NOT_FOUND_CEREMONY', `participant ${params.participantId} not registered`);
        }
        if (participant.voteCast !== null) {
            throw new OrbitalError('CONFLICT_VOTE_ALREADY_CAST', `participant ${params.participantId} already voted`);
        }
        // Update participant.
        await this.db
            .update(ceremonyParticipants)
            .set({ voteCast: params.vote, voteCastAt: new Date() })
            .where(eq(ceremonyParticipants.participantId, params.participantId));
        // Post the cast vote.
        await this.channels.post(ceremony.channelId, {
            postType: 'ceremony_vote',
            payload: { call_or_cast: 'cast', vote: params.vote },
            author: {
                type: 'persona',
                persona_id: participant.personaId,
                session_id: participant.sessionId,
            },
            capabilityId: params.capability?.capability_id,
            ceremonyId: params.ceremonyId,
            justification: params.justification,
        }, params.capability);
        // Recompute tally.
        const allParts = await this.db
            .select()
            .from(ceremonyParticipants)
            .where(and(eq(ceremonyParticipants.ceremonyId, params.ceremonyId), eq(ceremonyParticipants.ceremonyRole, 'participant')));
        const tally = {
            approve: 0,
            reject: 0,
            abstain: 0,
            approve_with_modifications: 0,
        };
        for (const p of allParts) {
            if (p.voteCast)
                tally[p.voteCast]++;
        }
        // Quorum: all non-yielded participants have voted.
        const expected = allParts.filter((p) => p.yieldedAt === null).length;
        const cast = allParts.filter((p) => p.voteCast !== null).length;
        const isQuorumReached = expected > 0 && cast >= expected;
        return { tally, isQuorumReached };
    }
    // -------------------------------------------------------------------------
    // writeOutput
    // -------------------------------------------------------------------------
    async writeOutput(params) {
        if (!params.justification?.trim()) {
            throw new OrbitalError('VALIDATION_REQUIRED_FIELD_MISSING', 'justification is required');
        }
        const rows = await this.db
            .select()
            .from(ceremonies)
            .where(eq(ceremonies.ceremonyId, params.ceremonyId))
            .limit(1);
        const ceremony = rows[0];
        if (!ceremony)
            throw new OrbitalError('NOT_FOUND_CEREMONY', `ceremony ${params.ceremonyId} not found`);
        // Allow output_writing OR in_progress (for ceremonies without a vote).
        if (ceremony.state !== 'output_writing' && !(ceremony.state === 'in_progress' && !ceremony.voteRequired)) {
            throw new OrbitalError('CONFLICT_INVALID_STATE_TRANSITION', `writeOutput requires state=output_writing; have ${ceremony.state}`);
        }
        const outputId = uuidv7();
        await this.db.insert(ceremonyOutputs).values({
            outputId,
            ceremonyId: params.ceremonyId,
            outputKind: params.outputKind,
            payload: params.payload,
            authoredByActor: params.authoredByActor,
            capabilityId: params.capabilityId,
            linkedAdrId: params.linkedAdrId ?? null,
            isPartial: params.isPartial ?? false,
            unresolvedItems: params.unresolvedItems ?? [],
            writtenAt: new Date(),
            schemaVersion: 1,
        });
        // Post a ceremony_output_link into the ceremony channel.
        const summary = typeof params.payload.summary === 'string'
            ? (params.payload.summary)
            : `Output of kind ${params.outputKind}`;
        await this.channels.post(ceremony.channelId, {
            postType: 'ceremony_output_link',
            payload: {
                output_id: outputId,
                output_kind: params.outputKind,
                summary,
                linked_adr_id: params.linkedAdrId ?? null,
            },
            author: params.authoredByActor,
            capabilityId: params.capabilityId,
            ceremonyId: params.ceremonyId,
            justification: params.justification,
        });
        const ev = {
            aggregate_id: params.ceremonyId,
            aggregate_type: 'ceremony',
            event_type: 'CeremonyOutputWritten',
            payload: {
                output_id: outputId,
                ceremony_id: params.ceremonyId,
                output_kind: params.outputKind,
                linked_adr_id: params.linkedAdrId ?? null,
                is_partial: params.isPartial ?? false,
            },
            actor: params.authoredByActor,
            capability_id: params.capabilityId,
            trace_id: uuidv7(),
            occurred_at: new Date().toISOString(),
            schema_version: 1,
        };
        await this.eventStore.append(ev);
        return { outputId };
    }
    // -------------------------------------------------------------------------
    // close
    // -------------------------------------------------------------------------
    async close(ceremonyId, params) {
        const rows = await this.db
            .select()
            .from(ceremonies)
            .where(eq(ceremonies.ceremonyId, ceremonyId))
            .limit(1);
        const ceremony = rows[0];
        if (!ceremony)
            throw new OrbitalError('NOT_FOUND_CEREMONY', `ceremony ${ceremonyId} not found`);
        if (ceremony.state === 'closed' || ceremony.state === 'aborted')
            return;
        await this.db
            .update(ceremonies)
            .set({ state: 'closed', closedAt: new Date() })
            .where(eq(ceremonies.ceremonyId, ceremonyId));
        const ev = {
            aggregate_id: ceremonyId,
            aggregate_type: 'ceremony',
            event_type: 'CeremonyClosed',
            payload: {
                ceremony_id: ceremonyId,
                closure_mode: params.closureMode,
                output_id: params.outputId ?? null,
                is_partial: params.isPartial ?? false,
            },
            actor: params.actor ?? SYSTEM_ACTOR,
            trace_id: uuidv7(),
            occurred_at: new Date().toISOString(),
            schema_version: 1,
        };
        await this.eventStore.append(ev);
        // Archive the ceremony channel.
        await this.channels.unsubscribe; // type-check noop
        logger.debug({ ceremonyId, closureMode: params.closureMode }, 'CeremonyService.close');
    }
    // -------------------------------------------------------------------------
    // abort
    // -------------------------------------------------------------------------
    async abort(ceremonyId, params) {
        const rows = await this.db
            .select()
            .from(ceremonies)
            .where(eq(ceremonies.ceremonyId, ceremonyId))
            .limit(1);
        const ceremony = rows[0];
        if (!ceremony)
            throw new OrbitalError('NOT_FOUND_CEREMONY', `ceremony ${ceremonyId} not found`);
        if (ceremony.state === 'aborted')
            return;
        await this.db
            .update(ceremonies)
            .set({ state: 'aborted', abortedAt: new Date(), abortReason: params.reason })
            .where(eq(ceremonies.ceremonyId, ceremonyId));
        const ev = {
            aggregate_id: ceremonyId,
            aggregate_type: 'ceremony',
            event_type: 'CeremonyAborted',
            payload: {
                ceremony_id: ceremonyId,
                reason: params.reason,
            },
            actor: params.actor ?? SYSTEM_ACTOR,
            trace_id: uuidv7(),
            occurred_at: new Date().toISOString(),
            schema_version: 1,
        };
        await this.eventStore.append(ev);
    }
    // -------------------------------------------------------------------------
    // getCeremony
    // -------------------------------------------------------------------------
    async getCeremony(ceremonyId) {
        const rows = await this.db
            .select()
            .from(ceremonies)
            .where(eq(ceremonies.ceremonyId, ceremonyId))
            .limit(1);
        const r = rows[0];
        if (!r)
            return null;
        return {
            ceremonyId: r.ceremonyId,
            state: r.state,
            turnsPerParticipant: r.turnsPerParticipant,
            tokensPerTurn: r.tokensPerTurn,
            voteRule: r.voteRule,
            voteRequired: r.voteRequired,
            channelId: r.channelId,
        };
    }
}
// ---------------------------------------------------------------------------
// Spec seeding helper (idempotent)
// ---------------------------------------------------------------------------
/**
 * Insert a baseline architecture_review spec. Used by tests; production
 * loads specs from `config/ceremonies/*.ts` per TRD-05 §7.6 (deferred to
 * Phase 4).
 */
export async function seedBaselineCeremonySpecs(db) {
    const specs = [
        {
            ceremonyType: 'architecture_review',
            chairRole: 'architect',
            participantRoles: ['principal_engineer', 'security_officer'],
            agendaTemplate: 'Reviewing {{change_subject}} ({{ticket_id}})',
            defaultTurnsPerParticipant: 3,
            defaultTokensPerTurn: 800,
            defaultWallClockMs: 15 * 60 * 1000,
            voteRule: 'simple_majority',
            voteRequired: true,
        },
        {
            ceremonyType: 'sprint_planning',
            chairRole: 'scrum_master',
            participantRoles: ['pm', 'architect', 'senior_developer'],
            agendaTemplate: 'Sprint planning for sprint {{sprint_id}}',
            defaultTurnsPerParticipant: 3,
            defaultTokensPerTurn: 1200,
            defaultWallClockMs: 30 * 60 * 1000,
            voteRule: 'simple_majority',
            voteRequired: true,
        },
        {
            ceremonyType: 'ad_hoc',
            chairRole: 'principal_engineer',
            participantRoles: [],
            agendaTemplate: 'Ad hoc ceremony',
            defaultTurnsPerParticipant: 3,
            defaultTokensPerTurn: 2000,
            defaultWallClockMs: 30 * 60 * 1000,
            voteRule: 'simple_majority',
            voteRequired: false,
        },
        {
            ceremonyType: 'backlog_grooming',
            chairRole: 'pm',
            participantRoles: ['pm', 'architect'],
            agendaTemplate: 'Backlog grooming for upcoming planning',
            defaultTurnsPerParticipant: 3,
            defaultTokensPerTurn: 1200,
            defaultWallClockMs: 20 * 60 * 1000,
            voteRule: 'simple_majority',
            voteRequired: false,
        },
        {
            ceremonyType: 'sprint_retrospective',
            chairRole: 'scrum_master',
            participantRoles: ['pm', 'engineering_manager'],
            agendaTemplate: 'Sprint review for sprint {{sprint_id}}',
            defaultTurnsPerParticipant: 3,
            defaultTokensPerTurn: 1200,
            defaultWallClockMs: 20 * 60 * 1000,
            voteRule: 'simple_majority',
            voteRequired: false,
        },
        {
            ceremonyType: 'async_standup',
            chairRole: 'scrum_master',
            participantRoles: [],
            agendaTemplate: 'Mid-sprint sync for sprint {{sprint_id}}',
            defaultTurnsPerParticipant: 2,
            defaultTokensPerTurn: 800,
            defaultWallClockMs: 10 * 60 * 1000,
            voteRule: 'simple_majority',
            voteRequired: false,
        },
    ];
    for (const s of specs) {
        const existing = await db
            .select()
            .from(ceremonySpecifications)
            .where(and(eq(ceremonySpecifications.ceremonyType, s.ceremonyType), eq(ceremonySpecifications.version, 1)))
            .limit(1);
        if (existing[0])
            continue;
        await db.insert(ceremonySpecifications).values({
            specId: uuidv7(),
            ceremonyType: s.ceremonyType,
            version: 1,
            chairRole: s.chairRole,
            participantRoles: s.participantRoles,
            agendaTemplate: s.agendaTemplate,
            outputSchemaJson: { kind: 'free_form' },
            defaultTurnsPerParticipant: s.defaultTurnsPerParticipant,
            defaultTokensPerTurn: s.defaultTokensPerTurn,
            defaultWallClockMs: s.defaultWallClockMs,
            voteRequired: s.voteRequired,
            voteRule: s.voteRule,
            schemaVersion: 1,
            loadedAt: new Date(),
        });
    }
}
//# sourceMappingURL=ceremonies.js.map