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
import type { DB } from '@orbital/db';
import type { EventStore } from '../events/store.js';
import type { CapabilityBundle, Actor } from '@orbital/types';
import { type CeremonyType, type CeremonyState, type CeremonyVote, type CeremonyVoteRule, type CeremonyOutputKind, type CeremonyParticipantRole } from '@orbital/db';
import type { ChannelsService } from './channels.js';
/**
 * Estimate tokens consumed by a body string. Production uses
 * @anthropic-ai/tokenizer if available.
 *
 * NOTE: The Anthropic tokenizer package is not currently a dependency of
 * @orbital/orchestrator (see package.json). The 4-char heuristic is good
 * enough for v1 budget enforcement; a Claude-specific tokenizer can be
 * swapped in v2 by replacing this function.
 */
export declare function estimateTokens(body: string): number;
export interface ScheduleCeremonyParams {
    ceremonyType: CeremonyType;
    /**
     * Spec id; if omitted the service looks up the latest version row in
     * `ceremony_specifications` for the given ceremony_type.
     */
    specId?: string;
    scope: Record<string, unknown>;
    triggeredBy: Actor;
    /** Override default budgets (optional). */
    turnsPerParticipant?: number;
    tokensPerTurn?: number;
    wallClockBudgetMs?: number;
}
export interface ScheduleCeremonyResult {
    ceremonyId: string;
    channelId: string;
}
export interface AddParticipantParams {
    ceremonyId: string;
    personaRole: string;
    personaId: string;
    sessionId: string;
    ceremonyRole: CeremonyParticipantRole;
    /** Override the ceremony's turns_per_participant for observers (typically 0). */
    turnsAllowed?: number;
}
export interface RecordTurnParams {
    ceremonyId: string;
    participantId: string;
    body: string;
    capability?: CapabilityBundle;
    references_turn?: number;
}
export interface RecordTurnResult {
    postId: string;
    turnNumber: number;
    tokensConsumed: number;
    turnsRemaining: number;
}
export interface CastVoteParams {
    ceremonyId: string;
    participantId: string;
    vote: CeremonyVote;
    capability?: CapabilityBundle;
    justification: string;
}
export interface WriteOutputParams {
    ceremonyId: string;
    outputKind: CeremonyOutputKind;
    payload: Record<string, unknown>;
    authoredByActor: Actor;
    capabilityId: string;
    isPartial?: boolean;
    unresolvedItems?: string[];
    linkedAdrId?: string;
    justification: string;
}
export interface CeremonyService {
    schedule(params: ScheduleCeremonyParams): Promise<ScheduleCeremonyResult>;
    addParticipant(params: AddParticipantParams): Promise<{
        participantId: string;
    }>;
    /** Open the ceremony for statements. */
    start(ceremonyId: string, agendaPostId: string): Promise<void>;
    recordTurn(params: RecordTurnParams): Promise<RecordTurnResult>;
    /** Chair calls vote / synthesis. */
    callClosure(params: {
        ceremonyId: string;
        closureMode: 'vote' | 'chair_synthesis';
        actor: Actor;
        capability?: CapabilityBundle;
        justification: string;
    }): Promise<{
        votePostId: string | null;
    }>;
    castVote(params: CastVoteParams): Promise<{
        tally: Record<CeremonyVote, number>;
        isQuorumReached: boolean;
    }>;
    writeOutput(params: WriteOutputParams): Promise<{
        outputId: string;
    }>;
    close(ceremonyId: string, params: {
        closureMode: 'vote_passed' | 'vote_failed' | 'chair_synthesis' | 'budget_exhausted';
        outputId?: string;
        isPartial?: boolean;
        actor?: Actor;
    }): Promise<void>;
    abort(ceremonyId: string, params: {
        reason: 'runaway_detected' | 'capability_revoked' | 'user_terminated' | 'system_error';
        actor?: Actor;
    }): Promise<void>;
    /** Internal helper used by tests. */
    getCeremony(ceremonyId: string): Promise<{
        ceremonyId: string;
        state: CeremonyState;
        turnsPerParticipant: number;
        tokensPerTurn: number;
        voteRule: CeremonyVoteRule;
        voteRequired: boolean;
        channelId: string;
    } | null>;
}
export declare class DefaultCeremonyService implements CeremonyService {
    private readonly db;
    private readonly eventStore;
    private readonly channels;
    constructor(db: DB, eventStore: EventStore, channels: ChannelsService);
    schedule(params: ScheduleCeremonyParams): Promise<ScheduleCeremonyResult>;
    addParticipant(params: AddParticipantParams): Promise<{
        participantId: string;
    }>;
    start(ceremonyId: string, agendaPostId: string): Promise<void>;
    recordTurn(params: RecordTurnParams): Promise<RecordTurnResult>;
    callClosure(params: {
        ceremonyId: string;
        closureMode: 'vote' | 'chair_synthesis';
        actor: Actor;
        capability?: CapabilityBundle;
        justification: string;
    }): Promise<{
        votePostId: string | null;
    }>;
    castVote(params: CastVoteParams): Promise<{
        tally: Record<CeremonyVote, number>;
        isQuorumReached: boolean;
    }>;
    writeOutput(params: WriteOutputParams): Promise<{
        outputId: string;
    }>;
    close(ceremonyId: string, params: {
        closureMode: 'vote_passed' | 'vote_failed' | 'chair_synthesis' | 'budget_exhausted';
        outputId?: string;
        isPartial?: boolean;
        actor?: Actor;
    }): Promise<void>;
    abort(ceremonyId: string, params: {
        reason: 'runaway_detected' | 'capability_revoked' | 'user_terminated' | 'system_error';
        actor?: Actor;
    }): Promise<void>;
    getCeremony(ceremonyId: string): Promise<{
        ceremonyId: string;
        state: CeremonyState;
        turnsPerParticipant: number;
        tokensPerTurn: number;
        voteRule: CeremonyVoteRule;
        voteRequired: boolean;
        channelId: string;
    } | null>;
}
/**
 * Insert a baseline architecture_review spec. Used by tests; production
 * loads specs from `config/ceremonies/*.ts` per TRD-05 §7.6 (deferred to
 * Phase 4).
 */
export declare function seedBaselineCeremonySpecs(db: DB): Promise<void>;
//# sourceMappingURL=ceremonies.d.ts.map