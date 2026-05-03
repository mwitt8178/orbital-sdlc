/**
 * replay/player.ts — Replay a captured run in one of three modes.
 *
 * [Engineer-Principal · Opus · run-round6-07-replay]
 *
 * Modes (see types.ts ReplayMode):
 *   - inspect             — render captured request/response without re-running.
 *   - replay-substituted  — re-run the captured request through a "substituted"
 *                           driver: feed the recorded response back. Verifies
 *                           determinism by hashing the substituted response
 *                           against the recorded hash. Should always match.
 *   - replay-live         — re-call the original LLM/tool with the same request.
 *                           Useful to detect non-determinism, model drift, or
 *                           environmental change. Requires liveExecutor injection.
 *
 * For Round 6 #7 v1, replay-live requires a `liveExecutor` callback that the
 * caller supplies. Without one, replay-live falls back to replay-substituted
 * with a logged warning. This keeps the player decoupled from any specific
 * provider — the orchestrator wires the live executor in boot.ts.
 *
 * Player emits ReplayPlayed on every invocation (and ReplayCorrupt if the blob
 * fails the integrity check on read).
 */
import type { DB } from '../db/client.js';
import type { EventStore } from '../events/store.js';
import { type ReplayStore } from './store.js';
import type { CaptureBody, ReplayMode, ReplayResult } from './types.js';
/**
 * Live executor — supplied by the caller, given the recorded request.
 * Returns the live response. Used by replay-live mode only.
 *
 * The executor is responsible for:
 *  - Routing to the correct provider (anthropic | openai | bedrock | tool gateway)
 *  - Honouring temperature/seed from the recorded determinism block.
 *
 * If null, replay-live degrades to replay-substituted with a log entry.
 */
export type LiveExecutor = (capture: CaptureBody) => Promise<Record<string, unknown>>;
export interface PlayerDeps {
    db: DB;
    eventStore: EventStore;
    store: ReplayStore;
    /** Optional live executor for replay-live mode. */
    liveExecutor?: LiveExecutor;
}
export declare class Player {
    private readonly deps;
    constructor(deps: PlayerDeps);
    /**
     * Replay a single captured call. Returns ReplayResult; emits ReplayPlayed.
     *
     * Throws ReplayCorruptError if the blob fails the integrity check on read,
     * or NotFoundError-equivalent if no capture exists for the id.
     */
    replay(captureId: string, mode: ReplayMode): Promise<ReplayResult>;
    private appendEvent;
}
export declare function createPlayer(deps: PlayerDeps): Player;
//# sourceMappingURL=player.d.ts.map