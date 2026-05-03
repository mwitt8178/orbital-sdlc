/**
 * replay/recorder.ts — Records LLM/tool/hook captures.
 *
 * [Engineer-Principal · Opus · run-round6-07-replay]
 *
 * Public API:
 *   Recorder.capture(input)           — generic capture entry point
 *   Recorder.captureLLM(input)        — convenience for LLM call sites
 *   Recorder.captureTool(input)       — convenience for MCP tool call sites
 *
 * Each capture:
 *   1. Persists the encrypted blob via the injected ReplayStore.
 *   2. Inserts a metadata row into `replay_captures`.
 *   3. Emits two audit events: ReplayCaptureStarted before, ReplayCaptureCompleted
 *      after — so the audit chain references the storage_uri.
 *
 * Failure semantics:
 *   - Storage / DB failures are caught and logged. Recorder MUST NOT block the
 *     external call it wraps — the request the operator wants to ship is more
 *     important than its replay metadata. A capture failure is logged at warn
 *     and a ReplayCorrupt event is best-effort emitted.
 */
import type { DB } from '../db/client.js';
import type { EventStore } from '../events/store.js';
import type { ReplayStore } from './store.js';
import type { CaptureInput, CaptureKind, CaptureRecord } from './types.js';
export interface RecorderDeps {
    db: DB;
    eventStore: EventStore;
    store: ReplayStore;
}
/**
 * Recorder — wraps the storage abstraction with audit-event emission.
 *
 * Construct once at boot via createRecorder(). Pass to call sites
 * (anthropic-driver, mcp/gateway, hooks/engine) so all captures use the
 * same store and the same event channel.
 */
export declare class Recorder {
    private readonly deps;
    constructor(deps: RecorderDeps);
    /**
     * Generic capture entry point. Returns the metadata record (including
     * storage_uri + hashes) so callers can reference it.
     *
     * Errors are caught, logged, and re-raised when fatal. Storage write
     * failures emit ReplayCorrupt.
     */
    capture(input: CaptureInput): Promise<CaptureRecord>;
    /** Convenience entry for LLM call sites. Sets kind='llm_request'. */
    captureLLM(input: Omit<CaptureInput, 'kind'>): Promise<CaptureRecord>;
    /** Convenience entry for MCP tool call sites. Sets kind='tool_call'. */
    captureTool(input: Omit<CaptureInput, 'kind' | 'provider' | 'model'>): Promise<CaptureRecord>;
    /** Convenience entry for hook invocation call sites. */
    captureHook(input: Omit<CaptureInput, 'kind' | 'provider' | 'model'>): Promise<CaptureRecord>;
    private appendEvent;
}
type _NonProviderKinds = Exclude<CaptureKind, 'llm_request'>;
export type { _NonProviderKinds };
export declare function createRecorder(deps: RecorderDeps): Recorder;
//# sourceMappingURL=recorder.d.ts.map