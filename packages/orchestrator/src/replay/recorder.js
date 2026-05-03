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
import { uuidv7 } from 'uuidv7';
import { logger } from '../config/logger.js';
import { replayCaptures } from '../db/schema/replay.js';
const SYSTEM_ACTOR = { type: 'system', component: 'orchestrator' };
// ---------------------------------------------------------------------------
// Header / key redaction helpers
// ---------------------------------------------------------------------------
/**
 * Redact known-secret fields from a request object before persisting.
 *
 * Replay blobs at rest are encrypted, but we still strip api keys and
 * Authorization headers as a defence-in-depth — if the install key leaks,
 * the blob still does not contain raw provider credentials.
 *
 * Conservative redaction: keys are case-insensitively matched against a list.
 */
const SECRET_KEYS = [
    'api_key',
    'apikey',
    'authorization',
    'x-api-key',
    'anthropic-api-key',
    'openai-api-key',
    'cookie',
    'set-cookie',
    'password',
    'token',
    'access_token',
    'refresh_token',
    'aws-secret',
    'aws_secret_access_key',
    'aws_access_key_id',
    'aws-secret-access-key',
    'aws-access-key-id',
];
function redact(value) {
    if (value === null || value === undefined)
        return value;
    if (Array.isArray(value))
        return value.map(redact);
    if (typeof value !== 'object')
        return value;
    const obj = value;
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        if (SECRET_KEYS.includes(k.toLowerCase())) {
            out[k] = '[REDACTED]';
        }
        else {
            out[k] = redact(v);
        }
    }
    return out;
}
/**
 * Recorder — wraps the storage abstraction with audit-event emission.
 *
 * Construct once at boot via createRecorder(). Pass to call sites
 * (anthropic-driver, mcp/gateway, hooks/engine) so all captures use the
 * same store and the same event channel.
 */
export class Recorder {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    /**
     * Generic capture entry point. Returns the metadata record (including
     * storage_uri + hashes) so callers can reference it.
     *
     * Errors are caught, logged, and re-raised when fatal. Storage write
     * failures emit ReplayCorrupt.
     */
    async capture(input) {
        const captureId = uuidv7();
        const occurredAt = new Date().toISOString();
        const traceId = input.traceId ?? captureId;
        // Build the full body — request is redacted, response is left as-is
        // (responses generally do not echo client headers, but if they do, the
        // operator can extend redact() above).
        const body = {
            capture_id: captureId,
            capture_kind: input.kind,
            occurred_at: occurredAt,
            worker_id: input.workerId,
            task_id: input.taskId,
            event_id: input.eventId,
            request: redact(input.request),
            response: input.response,
        };
        if (input.provider !== undefined) {
            body.provider = input.provider;
        }
        if (input.model !== undefined) {
            body.model = input.model;
        }
        if (input.determinism !== undefined) {
            body.determinism = input.determinism;
        }
        // Step 1: emit ReplayCaptureStarted (best-effort — does not block).
        const startedPayload = {
            capture_id: captureId,
            worker_id: input.workerId,
            task_id: input.taskId,
            event_id: input.eventId,
            capture_kind: input.kind,
            ...(input.provider !== undefined ? { provider: input.provider } : {}),
            ...(input.model !== undefined ? { model: input.model } : {}),
            started_at: occurredAt,
        };
        await this.appendEvent('ReplayCaptureStarted', captureId, startedPayload, traceId).catch((err) => {
            logger.warn({ err, captureId }, 'Recorder: ReplayCaptureStarted append failed');
        });
        // Step 2: persist the blob.
        let putResult;
        try {
            putResult = await this.deps.store.put(captureId, body);
        }
        catch (err) {
            logger.warn({ err, captureId }, 'Recorder: store.put failed; emitting ReplayCorrupt');
            const corruptPayload = {
                capture_id: captureId,
                storage_uri: '',
                reason: `put failed: ${err.message}`,
                detected_at: new Date().toISOString(),
            };
            await this.appendEvent('ReplayCorrupt', captureId, corruptPayload, traceId).catch(() => { });
            throw err;
        }
        // Step 3: insert the metadata row.
        try {
            await this.deps.db.insert(replayCaptures).values({
                captureId,
                occurredAt,
                workerId: input.workerId,
                taskId: input.taskId,
                eventId: input.eventId,
                captureKind: input.kind,
                provider: input.provider ?? null,
                model: input.model ?? null,
                requestHash: putResult.request_hash,
                responseHash: putResult.response_hash,
                storageUri: putResult.storage_uri,
                sizeBytes: putResult.size_bytes,
                schemaVersion: 1,
            });
        }
        catch (err) {
            logger.error({ err, captureId }, 'Recorder: DB insert failed; capture orphaned on disk');
            throw err;
        }
        // Step 4: emit ReplayCaptureCompleted.
        const completedPayload = {
            capture_id: captureId,
            worker_id: input.workerId,
            task_id: input.taskId,
            event_id: input.eventId,
            capture_kind: input.kind,
            ...(input.provider !== undefined ? { provider: input.provider } : {}),
            ...(input.model !== undefined ? { model: input.model } : {}),
            request_hash: putResult.request_hash,
            response_hash: putResult.response_hash,
            storage_uri: putResult.storage_uri,
            size_bytes: putResult.size_bytes,
            completed_at: new Date().toISOString(),
        };
        await this.appendEvent('ReplayCaptureCompleted', captureId, completedPayload, traceId).catch((err) => {
            logger.warn({ err, captureId }, 'Recorder: ReplayCaptureCompleted append failed');
        });
        return {
            capture_id: captureId,
            occurred_at: occurredAt,
            worker_id: input.workerId,
            task_id: input.taskId,
            event_id: input.eventId,
            capture_kind: input.kind,
            provider: input.provider ?? null,
            model: input.model ?? null,
            request_hash: putResult.request_hash,
            response_hash: putResult.response_hash,
            storage_uri: putResult.storage_uri,
            size_bytes: putResult.size_bytes,
        };
    }
    /** Convenience entry for LLM call sites. Sets kind='llm_request'. */
    async captureLLM(input) {
        return this.capture({ ...input, kind: 'llm_request' });
    }
    /** Convenience entry for MCP tool call sites. Sets kind='tool_call'. */
    async captureTool(input) {
        return this.capture({ ...input, kind: 'tool_call' });
    }
    /** Convenience entry for hook invocation call sites. */
    async captureHook(input) {
        return this.capture({ ...input, kind: 'hook_invocation' });
    }
    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------
    async appendEvent(eventType, captureId, payload, traceId) {
        await this.deps.eventStore.append({
            aggregate_id: captureId,
            aggregate_type: 'orchestration',
            event_type: eventType,
            payload: payload,
            actor: SYSTEM_ACTOR,
            trace_id: traceId,
            occurred_at: new Date().toISOString(),
            schema_version: 1,
        });
    }
}
// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
export function createRecorder(deps) {
    return new Recorder(deps);
}
//# sourceMappingURL=recorder.js.map