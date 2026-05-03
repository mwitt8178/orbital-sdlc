/**
 * vision/service.ts — VisionService implementation.
 *
 * Per TRD-01 §6.1, §12, Implementation Plan §8 Task 4A.
 *
 * Responsibilities:
 *   - start(): create vision_documents + vision_sessions rows, spawn PM persona,
 *     post initial welcome to #vision-intake channel, emit VisionSessionStarted.
 *   - sendMessage(): persist user message, relay to PM persona via channel post,
 *     emit VisionMessageSent.
 *   - draft(): PM persona produces a draft snapshot (vision_versions is_locked=0);
 *     emit VisionDrafted.
 *   - lock(): validate fields, fire pre-status-transition hook, insert locked
 *     vision_versions row, advance header pointer, emit VisionLocked.
 *   - revise(): copy-on-write new version, emit VisionRevised.
 *
 * Rules:
 *   - No direct db.insert(events) — all events via EventStore.append.
 *   - PM persona spawn uses a synthetic task with persona='pm', special capability
 *     profile: channel_post on #vision-intake-{sessionId} only, no files_write.
 *   - HookEngine.fire('pre-status-transition', ...) called on lock and revise.
 */
import type { Actor } from '@orbital/types';
import type { DB } from '../db/client.js';
import type { EventStore } from '../events/store.js';
import type { ChannelsService } from '../comms/channels.js';
import type { HookEngine } from '../hooks/engine.js';
import type { PersonaLoader } from '../personas/loader.js';
import type { ICapabilityAuthority } from '../capabilities/authority.js';
import type { RoutingEngine } from '../routing/engine.js';
import type { Scheduler } from '../orchestration/scheduler.js';
import type { VisionDocumentId, VisionSessionId, VisionVersionId, VisionDocumentContentDraft } from './types.js';
export interface VisionMessage {
    vision_message_id: string;
    vision_session_id: string;
    author_type: 'user' | 'pm_persona';
    body: string;
    posted_at: string;
}
export interface VisionDocument {
    vision_document_id: string;
    install_id: string;
    title: string;
    lifecycle_state: 'drafting' | 'locked' | 'revised' | 'abandoned';
    current_version_id: string | null;
    current_version_number: number;
    monday_item_id: string | null;
    created_at: string;
}
export interface VisionDocumentVersion {
    vision_version_id: string;
    vision_document_id: string;
    version_number: number;
    content: Record<string, unknown>;
    content_hash: string;
    changelog: string;
    is_locked: boolean;
    locked_at: string | null;
    drafted_at: string;
}
export interface StartSessionResult {
    vision_document_id: VisionDocumentId;
    vision_session_id: VisionSessionId;
    pm_persona_request_id: string;
}
export interface VisionService {
    start(params: {
        title: string;
        initial_prompt: string;
        install_id: string;
        actor: Actor;
        trace_id: string;
        justification: string;
    }): Promise<StartSessionResult>;
    sendMessage(sessionId: VisionSessionId, message: string, actor: Actor, traceId: string): Promise<VisionMessage>;
    draft(sessionId: VisionSessionId, content: VisionDocumentContentDraft, draftSummary: string, actor: Actor, traceId: string): Promise<VisionDocumentVersion>;
    reviewDraft(documentId: VisionDocumentId): Promise<{
        vision_document_id: string;
        current_version: VisionDocumentVersion | null;
        blocking_open_questions: string[];
        missing_required_fields: string[];
        confirmation_token: string;
        ready_to_lock: boolean;
    }>;
    lock(params: {
        documentId: VisionDocumentId;
        confirmationToken: string;
        changelog: string;
        attestation: {
            no_edge_cases: boolean;
        };
        actor: Actor;
        traceId: string;
        justification: string;
    }): Promise<VisionDocumentVersion>;
    revise(params: {
        documentId: VisionDocumentId;
        baseVersionId: VisionVersionId;
        delta: Array<Record<string, unknown>>;
        changelog: string;
        reason: 'user_initiated' | 'architect_feedback' | 'uat_defect' | 'retro_proposal';
        actor: Actor;
        traceId: string;
        justification: string;
    }): Promise<VisionDocumentVersion>;
    getDocument(documentId: VisionDocumentId): Promise<VisionDocument>;
    getVersion(documentId: VisionDocumentId, versionNumber?: number): Promise<VisionDocumentVersion | null>;
    listVersions(documentId: VisionDocumentId, after?: string, limit?: number): Promise<VisionDocumentVersion[]>;
    listMessages(sessionId: VisionSessionId, limit?: number): Promise<VisionMessage[]>;
}
export declare class DefaultVisionService implements VisionService {
    private readonly db;
    private readonly eventStore;
    private readonly channelsService;
    private readonly hookEngine;
    private readonly personaLoader;
    private readonly capabilityAuthority;
    private readonly routingEngine;
    private readonly installId;
    /**
     * Optional Scheduler. When present, VisionService.start() enqueues a real
     * PM-persona task so the worker actually spawns. When absent, the session
     * is opened and the channel is created but the PM persona never runs (the
     * existing PR-1 fallback behavior). Boot wires the real Scheduler in
     * production; existing unit tests construct the service without it.
     */
    private readonly scheduler?;
    constructor(db: DB, eventStore: EventStore, channelsService: ChannelsService, hookEngine: HookEngine, personaLoader: PersonaLoader, capabilityAuthority: ICapabilityAuthority, routingEngine: RoutingEngine, installId: string, 
    /**
     * Optional Scheduler. When present, VisionService.start() enqueues a real
     * PM-persona task so the worker actually spawns. When absent, the session
     * is opened and the channel is created but the PM persona never runs (the
     * existing PR-1 fallback behavior). Boot wires the real Scheduler in
     * production; existing unit tests construct the service without it.
     */
    scheduler?: Scheduler | undefined);
    start(params: {
        title: string;
        initial_prompt: string;
        install_id: string;
        actor: Actor;
        trace_id: string;
        justification: string;
    }): Promise<StartSessionResult>;
    sendMessage(sessionId: VisionSessionId, message: string, actor: Actor, traceId: string): Promise<VisionMessage>;
    draft(sessionId: VisionSessionId, content: VisionDocumentContentDraft, draftSummary: string, actor: Actor, traceId: string): Promise<VisionDocumentVersion>;
    reviewDraft(documentId: VisionDocumentId): Promise<{
        vision_document_id: string;
        current_version: VisionDocumentVersion | null;
        blocking_open_questions: string[];
        missing_required_fields: string[];
        confirmation_token: string;
        ready_to_lock: boolean;
    }>;
    lock(params: {
        documentId: VisionDocumentId;
        confirmationToken: string;
        changelog: string;
        attestation: {
            no_edge_cases: boolean;
        };
        actor: Actor;
        traceId: string;
        justification: string;
    }): Promise<VisionDocumentVersion>;
    revise(params: {
        documentId: VisionDocumentId;
        baseVersionId: VisionVersionId;
        delta: Array<Record<string, unknown>>;
        changelog: string;
        reason: 'user_initiated' | 'architect_feedback' | 'uat_defect' | 'retro_proposal';
        actor: Actor;
        traceId: string;
        justification: string;
    }): Promise<VisionDocumentVersion>;
    getDocument(documentId: VisionDocumentId): Promise<VisionDocument>;
    getVersion(documentId: VisionDocumentId, versionNumber?: number): Promise<VisionDocumentVersion | null>;
    listVersions(documentId: VisionDocumentId, _after?: string, limit?: number): Promise<VisionDocumentVersion[]>;
    listMessages(sessionId: VisionSessionId, limit?: number): Promise<VisionMessage[]>;
    private _mapVersion;
}
export declare function createVisionService(db: DB, eventStore: EventStore, channelsService: ChannelsService, hookEngine: HookEngine, personaLoader: PersonaLoader, capabilityAuthority: ICapabilityAuthority, routingEngine: RoutingEngine, installId: string, scheduler?: Scheduler): VisionService;
//# sourceMappingURL=service.d.ts.map