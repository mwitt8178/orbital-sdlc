/**
 * replay/service.ts — Public service API for the replay subsystem.
 *
 * [Engineer-Principal · Opus · run-round6-07-replay]
 *
 * This is the "front door" used by:
 *   - tRPC router (replay.ts)
 *   - Anthropic / tool driver call sites (which prefer to call captureLLM /
 *     captureTool here rather than reach into Recorder directly)
 *   - Tests (so they can construct one service object and exercise everything)
 *
 * Composition: a ReplayService bundles a Recorder + a Player + raw query
 * helpers over `replay_captures`. Construct once at boot via createReplayService.
 */
import type { DB } from '../db/client.js';
import type { EventStore } from '../events/store.js';
import { type LiveExecutor } from './player.js';
import type { CaptureInput, CaptureRecord, ReplayMode, ReplayResult } from './types.js';
import type { ReplayStore } from './store.js';
export interface ReplayServiceDeps {
    db: DB;
    eventStore: EventStore;
    store: ReplayStore;
    liveExecutor?: LiveExecutor;
}
export interface ListFilter {
    workerId?: string;
    taskId?: string;
    eventId?: string;
    limit?: number;
}
export declare class ReplayService {
    private readonly deps;
    private readonly recorder;
    private readonly player;
    constructor(deps: ReplayServiceDeps);
    /** Generic capture entry. Most callers should use captureLLM / captureTool. */
    capture(input: CaptureInput): Promise<CaptureRecord>;
    /** Capture an LLM request. Sets kind='llm_request'. */
    captureLLM(input: Omit<CaptureInput, 'kind'>): Promise<CaptureRecord>;
    /** Capture an MCP tool invocation. */
    captureTool(input: Omit<CaptureInput, 'kind' | 'provider' | 'model'>): Promise<CaptureRecord>;
    /** Capture a hook invocation. */
    captureHook(input: Omit<CaptureInput, 'kind' | 'provider' | 'model'>): Promise<CaptureRecord>;
    getCapture(captureId: string): Promise<CaptureRecord | null>;
    list(filter: ListFilter): Promise<CaptureRecord[]>;
    /** True when at least one capture exists for the given event_id. */
    hasCaptureForEvent(eventId: string): Promise<boolean>;
    replay(captureId: string, mode: ReplayMode): Promise<ReplayResult>;
}
export declare function createReplayService(deps: ReplayServiceDeps): ReplayService;
/** Boot wires the live ReplayService here so the tRPC router can lazily access it. */
export declare function registerReplayService(svc: ReplayService): void;
/** Used by the tRPC router. Throws when no service has been registered. */
export declare function getReplayService(): ReplayService;
/** Test helper to clear the singleton between integration tests. */
export declare function resetReplayServiceForTest(): void;
//# sourceMappingURL=service.d.ts.map