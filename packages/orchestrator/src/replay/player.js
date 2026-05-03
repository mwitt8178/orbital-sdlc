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
import { eq } from 'drizzle-orm';
import { ReplayCorruptError } from './store.js';
import { logger } from '../config/logger.js';
import { replayCaptures } from '../db/schema/replay.js';
import { createHash } from 'node:crypto';
const SYSTEM_ACTOR = { type: 'system', component: 'orchestrator' };
// ---------------------------------------------------------------------------
// Helpers — local copy of the canonicaliser used by store.ts
// ---------------------------------------------------------------------------
function canonicalJSON(value) {
    return JSON.stringify(value, sortedReplacer);
}
function sortedReplacer(_key, val) {
    if (val === null || typeof val !== 'object' || Array.isArray(val))
        return val;
    const obj = val;
    return Object.keys(obj)
        .sort()
        .reduce((acc, k) => {
        acc[k] = obj[k];
        return acc;
    }, {});
}
function sha256Hex(input) {
    return createHash('sha256').update(input).digest('hex');
}
export class Player {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    /**
     * Replay a single captured call. Returns ReplayResult; emits ReplayPlayed.
     *
     * Throws ReplayCorruptError if the blob fails the integrity check on read,
     * or NotFoundError-equivalent if no capture exists for the id.
     */
    async replay(captureId, mode) {
        const startMs = Date.now();
        // 1. Load the metadata row.
        const rows = await this.deps.db
            .select()
            .from(replayCaptures)
            .where(eq(replayCaptures.captureId, captureId))
            .limit(1);
        const row = rows[0];
        if (!row) {
            throw new Error(`REPLAY_NOT_FOUND: capture_id=${captureId}`);
        }
        // 2. Read + decrypt the blob. Hash check happens inside store.get.
        let body;
        try {
            body = await this.deps.store.get(row.storageUri, row.requestHash, row.responseHash);
        }
        catch (err) {
            if (err instanceof ReplayCorruptError) {
                const corruptPayload = {
                    capture_id: captureId,
                    storage_uri: row.storageUri,
                    reason: err.reason,
                    detected_at: new Date().toISOString(),
                };
                await this.appendEvent('ReplayCorrupt', captureId, corruptPayload).catch((e) => {
                    logger.warn({ err: e, captureId }, 'Player: ReplayCorrupt event append failed');
                });
            }
            throw err;
        }
        // 3. Execute the chosen mode.
        let replayResponse = null;
        let matchedHash = false;
        switch (mode) {
            case 'inspect': {
                // Just render — no execution.
                replayResponse = null;
                // For inspect, "matched" is trivially true because we are not comparing.
                matchedHash = true;
                break;
            }
            case 'replay-substituted': {
                // Substitute: the "executor" is the recorded response itself.
                // We deep-clone via JSON to ensure the comparison hash is computed on
                // a freshly-serialized object, not the same reference.
                replayResponse = JSON.parse(JSON.stringify(body.response));
                const replayHash = sha256Hex(canonicalJSON(replayResponse));
                matchedHash = replayHash === row.responseHash;
                break;
            }
            case 'replay-live': {
                if (!this.deps.liveExecutor) {
                    logger.warn({ captureId }, 'Player: replay-live requested but no liveExecutor configured; falling back to substituted');
                    replayResponse = JSON.parse(JSON.stringify(body.response));
                }
                else {
                    replayResponse = await this.deps.liveExecutor(body);
                }
                const replayHash = sha256Hex(canonicalJSON(replayResponse));
                matchedHash = replayHash === row.responseHash;
                break;
            }
            default: {
                throw new Error(`REPLAY_INVALID_MODE: ${mode}`);
            }
        }
        const durationMs = Date.now() - startMs;
        const playedAt = new Date().toISOString();
        // 4. Emit ReplayPlayed.
        const playedPayload = {
            capture_id: captureId,
            mode,
            matched_hash: matchedHash,
            duration_ms: durationMs,
            played_at: playedAt,
        };
        await this.appendEvent('ReplayPlayed', captureId, playedPayload).catch((err) => {
            logger.warn({ err, captureId }, 'Player: ReplayPlayed event append failed');
        });
        return {
            capture_id: captureId,
            mode,
            recorded_request: body.request,
            recorded_response: body.response,
            replay_response: replayResponse,
            matched_hash: matchedHash,
            duration_ms: durationMs,
            played_at: playedAt,
        };
    }
    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------
    async appendEvent(eventType, captureId, payload) {
        await this.deps.eventStore.append({
            aggregate_id: captureId,
            aggregate_type: 'orchestration',
            event_type: eventType,
            payload: payload,
            actor: SYSTEM_ACTOR,
            trace_id: captureId,
            occurred_at: new Date().toISOString(),
            schema_version: 1,
        });
    }
}
// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
export function createPlayer(deps) {
    return new Player(deps);
}
//# sourceMappingURL=player.js.map