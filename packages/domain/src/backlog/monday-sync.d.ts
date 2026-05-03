/**
 * backlog/monday-sync.ts — MondaySyncService.
 *
 * Per TRD-02 v0.2 §13.2 (push), §13.3 (pull/reconcile), §13.4 (webhook).
 *
 * Responsibilities:
 *   - onStoryCreated(story)        → push: createSubitem on Monday
 *   - onStoryStatusChanged(story)  → push: updateColumnValue
 *   - reconcile(boardId)           → pull: compare Monday board state to local;
 *                                    update last_seen_item_ids; emit MondaySyncCompleted
 *   - handleWebhookPayload(body)   → process Monday → Orbital push
 *
 * All push/pull cycles emit MondaySyncCompleted after each run.
 */
import { OrbitalError, type Actor } from '@orbital/types';
import type { DB } from '@orbital/db';
import type { EventStore } from '../events/store.js';
import type { MondayClient } from './monday-client.js';
import type { BoardMappingResolver } from './board-mapping-resolver.js';
import type { OrbitalState } from './board-mapping.js';
import { type StoryRow } from '@orbital/db';
export interface MondaySyncServiceOptions {
    /** Default board id for reconciliation; null = no scheduled reconcile. */
    defaultBoardId?: string;
    /** Reconciliation interval ms. Default 5 minutes. */
    reconcileIntervalMs?: number;
    /**
     * Optional BoardMappingResolver. When provided, status writes use the
     * project's confirmed mapping instead of hardcoded column ids. When null
     * (or no mapping confirmed), the legacy hardcoded behavior is preserved.
     */
    mappingResolver?: BoardMappingResolver | null;
}
export interface MondayWebhookPayload {
    /** Monday's challenge handshake. */
    challenge?: string;
    /** Inbound event body. */
    event?: {
        type: string;
        boardId?: number | string;
        pulseId?: number | string;
        columnId?: string;
        value?: {
            label?: {
                text?: string;
            };
        } | unknown;
        previousValue?: unknown;
    };
    /**
     * Webhook id for dedupe (Monday emits a unique id per delivery; tests pass
     * arbitrary strings).
     */
    webhookId?: string;
}
export interface ReconcileResult {
    pulledCount: number;
    driftCount: number;
    boardId: string;
}
export interface MondaySyncService {
    onStoryCreated(story: StoryRow, parentEpicMondayItemId: string): Promise<{
        mondaySubitemId: string;
    }>;
    onStoryStatusChanged(story: StoryRow, boardId: string, columnId: string, valueLabel: string): Promise<void>;
    /**
     * Mapping-aware variant of onStoryStatusChanged. Resolves the project's
     * confirmed BoardMapping to determine the column id and label for the new
     * Orbital state, then writes to Monday. If no mapping is configured for the
     * project, logs a warning and skips the write (graceful degradation — does
     * NOT push canonical defaults onto an unmapped board).
     */
    onStoryStatusChangedWithMapping(story: StoryRow, boardId: string, projectId: string, newState: OrbitalState): Promise<{
        skipped: boolean;
        reason?: string;
    }>;
    reconcile(boardId: string): Promise<ReconcileResult>;
    handleWebhookPayload(payload: MondayWebhookPayload, actor?: Actor): Promise<{
        accepted: boolean;
        reason?: string;
    }>;
    /**
     * Start the periodic reconcile timer. Idempotent — duplicate calls no-op.
     */
    startScheduledReconcile(boardId: string): void;
    /**
     * Stop the periodic reconcile timer. Safe to call multiple times.
     */
    stopScheduledReconcile(): void;
}
export declare class DefaultMondaySyncService implements MondaySyncService {
    private readonly db;
    private readonly eventStore;
    private readonly client;
    private readonly reconcileIntervalMs;
    private reconcileTimer;
    private readonly mappingResolver;
    constructor(db: DB, eventStore: EventStore, client: MondayClient, options?: MondaySyncServiceOptions);
    onStoryCreated(story: StoryRow, parentEpicMondayItemId: string): Promise<{
        mondaySubitemId: string;
    }>;
    onStoryStatusChanged(story: StoryRow, boardId: string, columnId: string, valueLabel: string): Promise<void>;
    onStoryStatusChangedWithMapping(story: StoryRow, boardId: string, projectId: string, newState: OrbitalState): Promise<{
        skipped: boolean;
        reason?: string;
    }>;
    reconcile(boardId: string): Promise<ReconcileResult>;
    handleWebhookPayload(payload: MondayWebhookPayload, _actor?: Actor): Promise<{
        accepted: boolean;
        reason?: string;
    }>;
    /**
     * Start a periodic reconcile timer. Caller is responsible for stopping
     * before shutdown.
     */
    startScheduledReconcile(boardId: string): void;
    stopScheduledReconcile(): void;
    private recordSyncError;
}
export declare function createMondaySyncService(db: DB, eventStore: EventStore, client: MondayClient, options?: MondaySyncServiceOptions): MondaySyncService;
export { OrbitalError };
//# sourceMappingURL=monday-sync.d.ts.map