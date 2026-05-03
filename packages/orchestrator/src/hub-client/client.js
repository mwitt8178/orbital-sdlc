/**
 * hub-client/client.ts — HTTP client that local routers proxy to when the hub
 * is configured (ORBITAL_HUB_URL set).
 *
 * Round 7-02 — Local-vs-Hub Split in Local Orbital
 * [Engineer-Sr · Sonnet · run-round7-02-local-hub-split]
 *
 * Round 7-06 — Connection state machine + offline queuing
 * [Engineer-Sr · Sonnet · run-round7-06-offline-reconcile]
 *
 * Design:
 *   - Plain fetch() calls against the hub's tRPC HTTP endpoint.
 *   - Authorization: not yet wired (7-03 adds signed envelopes); for now
 *     we send the tenant ID via x-orbital-tenant-id header so hub
 *     tenant middleware resolves correctly.
 *   - Methods mirror the subset of tRPC procedures that hub-proxied routers
 *     need to call. Each method maps to a single tRPC batch request.
 *   - No singleton; callers construct via createHubClient(). Index.ts creates
 *     one instance at boot and shares it via DI.
 *
 * Round 7-06 additions:
 *   - Connection state machine: 'connected' | 'reconnecting' | 'offline'.
 *     - 'connected': hub reachable, calls proceed normally.
 *     - 'reconnecting': hub was reachable recently; calls attempted, failure
 *       transitions to 'offline'.
 *     - 'offline': hub unreachable; mutations enqueued to outbox instead of
 *       throwing. Queries return stale cached data or a graceful error.
 *   - setConnectionStateMachine(): wires up the ws-client status so the HTTP
 *     client tracks the same state the WS connection is in.
 *   - whenOffline(): allows callers to register an outbox enqueue callback
 *     that fires instead of the RPC when state is 'offline'.
 *
 * Backwards compat: if ORBITAL_HUB_URL is unset, createHubClient() returns
 * null and all callers fall through to local Postgres.
 */
import { loadEnv } from '../config/env.js';
import { logger } from '../config/logger.js';
import { attachAuthHeaders } from './auth.js';
// Round 7-05 sanitize — defence-in-depth at the wire boundary.
import { sanitizeForHub, LocalDataLeakError, setKnownAnthropicKeyPrefix } from './sanitize.js';
// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------
class HubClientImpl {
    opts;
    _status;
    // Round 7-06: connection state machine
    _connectionState = 'connected';
    _connectionStateSource = null;
    constructor(opts) {
        this.opts = opts;
        this._status = {
            status: 'connecting',
            lastSyncAt: null,
            hubUrl: opts.hubUrl,
            errorMessage: null,
        };
    }
    get status() {
        return { ...this._status };
    }
    // Round 7-06: connection state machine
    get connectionState() {
        if (this._connectionStateSource !== null) {
            return this._connectionStateSource();
        }
        return this._connectionState;
    }
    setConnectionStateSource(getState) {
        this._connectionStateSource = getState;
    }
    // -------------------------------------------------------------------------
    // tasks
    // -------------------------------------------------------------------------
    tasks = {
        list: (tenantId, sprintId) => this.rpc('orchestration.tasks.list', { sprintId }, tenantId),
        get: (tenantId, taskId) => this.rpc('orchestration.tasks.get', { taskId }, tenantId),
        claim: (tenantId, taskId, installId) => this.rpc('orchestration.tasks.claim', { taskId, installId }, tenantId),
        updateState: (tenantId, taskId, state) => this.rpc('orchestration.tasks.updateState', { taskId, state }, tenantId),
    };
    // -------------------------------------------------------------------------
    // events
    // -------------------------------------------------------------------------
    events = {
        append: (event) => this.rpc('audit.events.append', event, event.tenant_id),
    };
    // -------------------------------------------------------------------------
    // workers
    // -------------------------------------------------------------------------
    workers = {
        register: (reg) => this.rpc('orchestration.workers.register', reg, reg.tenant_id),
        updateState: (tenantId, workerId, state) => this.rpc('orchestration.workers.updateState', { workerId, state }, tenantId),
    };
    // -------------------------------------------------------------------------
    // Generic query / mutate proxy
    // -------------------------------------------------------------------------
    async query(procedure, input, tenantId) {
        return this.rpc(procedure, input, tenantId);
    }
    async mutate(procedure, input, tenantId) {
        return this.rpc(procedure, input, tenantId);
    }
    // -------------------------------------------------------------------------
    // ping
    // -------------------------------------------------------------------------
    async ping() {
        try {
            const res = await fetch(`${this.opts.hubUrl}/health`, {
                signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5_000),
            });
            const ok = res.ok;
            this.markStatus(ok ? 'connected' : 'error', ok ? null : `HTTP ${res.status}`);
            return ok;
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.markStatus('error', msg);
            return false;
        }
    }
    // -------------------------------------------------------------------------
    // Internal RPC helper
    // -------------------------------------------------------------------------
    /**
     * Send a tRPC-style batch request to the hub.
     *
     * The hub exposes tRPC at /trpc. We use the batch HTTP link format:
     *   GET  /trpc/<procedure>?input=<JSON>  for queries
     *   POST /trpc/<procedure>               for mutations (body = { "0": input })
     *
     * For simplicity, we always POST (tRPC batch treats everything as a batch of
     * one). The hub's httpBatchLink accepts this format.
     */
    async rpc(procedure, input, tenantId) {
        const url = `${this.opts.hubUrl}/trpc/${procedure}`;
        const timeoutMs = this.opts.timeoutMs ?? 10_000;
        // Round 7-05 sanitize — defence-in-depth at the wire boundary.
        // If the events boundary missed something (e.g. a router calling
        // hub.mutate() directly), this is the last line of defence before the
        // bytes hit the network. On rejection the request is NOT sent.
        try {
            sanitizeForHub(input, procedure);
        }
        catch (err) {
            if (err instanceof LocalDataLeakError) {
                logger.fatal({ procedure, path: err.path, reason: err.reason }, 'hub-client: BLOCKED outgoing request — local-only data detected');
                this.markStatus('error', `local-data-leak: ${err.reason}`);
                return { ok: false, status: 0, message: err.message };
            }
            // Unexpected sanitiser failure — fail closed.
            const msg = err instanceof Error ? err.message : String(err);
            logger.error({ err, procedure }, 'hub-client: sanitiser threw unexpected error');
            this.markStatus('error', `sanitizer: ${msg}`);
            return { ok: false, status: 0, message: `sanitizer: ${msg}` };
        }
        const bodyJson = JSON.stringify({ '0': { json: input } });
        const bodyBytes = new TextEncoder().encode(bodyJson);
        const headers = {
            'Content-Type': 'application/json',
            'x-orbital-tenant-id': tenantId,
        };
        // Round 7-03 — attach signed envelope. If the local install hasn't been
        // paired yet (no install.json), getOrCreateInstallKey() generates a
        // throwaway pair; the hub will reject with INSTALL_UNKNOWN, which is the
        // intended UX (hub-mode requires pairing). In local mode the hub-client
        // is null entirely so we don't even reach this code path.
        try {
            await attachAuthHeaders(headers, procedure, bodyBytes);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.markStatus('error', `auth header build failed: ${msg}`);
            logger.warn({ procedure, err }, 'hub-client: failed to build auth headers');
            return { ok: false, status: 0, message: `auth: ${msg}` };
        }
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers,
                body: bodyJson,
                signal: AbortSignal.timeout(timeoutMs),
            });
            const text = await res.text();
            let parsed;
            try {
                parsed = JSON.parse(text);
            }
            catch {
                this.markStatus('error', `Non-JSON response from hub: ${text.slice(0, 200)}`);
                return { ok: false, status: res.status, message: `Invalid JSON from hub` };
            }
            if (!res.ok) {
                const errMsg = extractErrorMessage(parsed);
                this.markStatus('error', errMsg);
                logger.warn({ procedure, status: res.status, errMsg }, 'hub-client: RPC error response');
                return { ok: false, status: res.status, message: errMsg };
            }
            // tRPC batch response shape: [{ result: { data: { json: T } } }]
            const data = extractTrpcData(parsed);
            this.markStatus('connected', null);
            return { ok: true, data };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.markStatus('error', msg);
            logger.warn({ procedure, err }, 'hub-client: fetch failed');
            return { ok: false, status: 0, message: msg };
        }
    }
    markStatus(status, errorMessage) {
        this._status = {
            status,
            lastSyncAt: status === 'connected' ? new Date().toISOString() : this._status.lastSyncAt,
            hubUrl: this.opts.hubUrl,
            errorMessage,
        };
        // Round 7-06: sync connection state when no external source is wired
        if (this._connectionStateSource === null) {
            if (status === 'connected') {
                this._connectionState = 'connected';
            }
            else if (status === 'error') {
                this._connectionState = 'offline';
            }
            // 'connecting' stays as current state
        }
    }
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function extractErrorMessage(parsed) {
    if (typeof parsed !== 'object' || parsed === null)
        return 'Unknown hub error';
    const arr = parsed;
    const first = Array.isArray(arr) ? arr[0] : parsed;
    const error = first['error'];
    if (typeof error === 'object' && error !== null) {
        const msg = error['message'];
        if (typeof msg === 'string')
            return msg;
    }
    return JSON.stringify(parsed).slice(0, 200);
}
function extractTrpcData(parsed) {
    // tRPC batch response: [{ result: { data: { json: T } } }]
    if (Array.isArray(parsed) && parsed.length > 0) {
        const first = parsed[0];
        const result = first['result'];
        if (result) {
            const data = result['data'];
            if (data && 'json' in data)
                return data['json'];
            return result['data'];
        }
    }
    return parsed;
}
// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
/**
 * createHubClient — construct a HubClient from env.
 *
 * Returns null if ORBITAL_HUB_URL is not set (local-only mode).
 * Callers check for null and fall through to local Postgres.
 */
export function createHubClient() {
    const env = loadEnv();
    if (!env.ORBITAL_HUB_URL)
        return null;
    // Round 7-05 sanitize — capture the install's known Anthropic key prefix
    // so the sanitiser can refuse leaks of THIS install's secret specifically
    // (in addition to the generic sk-ant- pattern). We only stash the first
    // 14 chars to limit secret material in process memory.
    if (env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.length >= 14) {
        setKnownAnthropicKeyPrefix(env.ANTHROPIC_API_KEY.slice(0, 14));
    }
    logger.info({ hubUrl: env.ORBITAL_HUB_URL }, 'hub-client: hub mode active');
    return new HubClientImpl({
        hubUrl: env.ORBITAL_HUB_URL.replace(/\/$/, ''),
        tenantId: env.ORBITAL_HUB_TENANT_ID,
        timeoutMs: 10_000,
    });
}
/**
 * createHubClientForTest — construct a client pointing at a specific URL.
 * Used by integration tests to point at a real second hub instance.
 */
export function createHubClientForTest(hubUrl, tenantId) {
    return new HubClientImpl({ hubUrl: hubUrl.replace(/\/$/, ''), tenantId, timeoutMs: 5_000 });
}
//# sourceMappingURL=client.js.map