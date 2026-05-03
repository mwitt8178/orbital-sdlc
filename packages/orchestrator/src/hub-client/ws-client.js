/**
 * hub-client/ws-client.ts — Local-side WS client for hub real-time push.
 *
 * Round 7-04 — Real-Time Push From Hub To Clients
 * [Engineer-Sr · Sonnet · run-round7-04-realtime-push]
 *
 * Round 7-06 — Hardened reconnect backfill + offline state mapping
 * [Engineer-Sr · Sonnet · run-round7-06-offline-reconcile]
 *
 * When the local Orbital instance is configured with a hub (ORBITAL_HUB_URL),
 * this client connects to the hub's WS endpoint using a signed envelope for
 * auth (same key as hub-client/auth.ts).
 *
 * Responsibilities:
 *   - Connect to hub WS over WSS/WS with envelope auth in query params.
 *   - Reconnect with exponential backoff: 1s → 2s → 4s → max 30s.
 *   - On reconnect: re-authenticate (fresh envelope signed at connect time),
 *     re-subscribe to all previous patterns, request events since
 *     last_seen_event_id via cursor in the subscribe message.
 *   - Emit events to registered handlers (one handler per subscription pattern).
 *   - Track the last_seen_event_id for backfill on reconnect.
 *   - Report connection status changes (connected/reconnecting/disconnected).
 *
 * Round 7-06 additions:
 *   - getConnectionStateForOutbox(): maps WsClientStatus → HubConnectionState
 *     so the persistent outbox can use the WS client as its connection source.
 *   - onReconnected callback: called after resubscription so the outbox can
 *     start its flush cycle after the WS is ready (events-since backfill
 *     request is already handled by the cursor in the subscribe message).
 *   - Hardened backfill: the cursor sent in the subscribe message on reconnect
 *     guarantees the hub replays any events missed during the disconnect window.
 *     The hub's subscribe handler looks up events > cursor and pushes them
 *     before resuming live push. This is the "events since last_seen_event_id"
 *     flow documented in architecture.md.
 *
 * Auth: a fresh signed envelope is created at each connect attempt. The
 * method signed is 'ws.connect'; body is empty. The params go on the WS URL
 * as query string (install_id, sig, sig_body).
 *
 * Design notes:
 *   - Uses Node.js native WebSocket (v22+) or falls back to the `ws` package.
 *   - Runs as a process singleton via hub-client/index.ts.
 *   - No mocks; callers in tests use a real hub or skip hub-client tests.
 */
import { logger } from '../config/logger.js';
import { getOrCreateInstallKey } from '../keys/install-key.js';
import { signEnvelope } from '../keys/envelope.js';
// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------
const DEFAULT_INITIAL_RECONNECT_MS = 1_000;
const DEFAULT_MAX_RECONNECT_MS = 30_000;
const WS_CONNECT_METHOD = 'ws.connect';
class HubWsClientImpl {
    opts;
    ws = null;
    stopped = false;
    reconnectTimer = null;
    reconnectDelayMs;
    _status = 'disconnected';
    _lastSeenEventId = null;
    /** All active subscriptions. Map from pattern → Set<handler>. */
    subscriptions = new Map();
    constructor(opts) {
        this.opts = opts;
        this.reconnectDelayMs = opts.initialReconnectMs ?? DEFAULT_INITIAL_RECONNECT_MS;
    }
    status() {
        return this._status;
    }
    isConnected() {
        return this._status === 'connected';
    }
    lastSeenEventId() {
        return this._lastSeenEventId;
    }
    // Round 7-06: map WS status → HubConnectionState for outbox
    connectionStateForOutbox() {
        switch (this._status) {
            case 'connected':
                return 'connected';
            case 'connecting':
            case 'reconnecting':
                return 'reconnecting';
            case 'disconnected':
                return 'offline';
        }
    }
    start() {
        this.stopped = false;
        this.setStatus('connecting');
        void this.connect();
    }
    stop() {
        this.stopped = true;
        if (this.reconnectTimer !== null) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            try {
                this.ws.close();
            }
            catch { /* ignore */ }
            this.ws = null;
        }
        this.setStatus('disconnected');
    }
    subscribe(pattern, handler) {
        let handlers = this.subscriptions.get(pattern);
        if (!handlers) {
            handlers = new Set();
            this.subscriptions.set(pattern, handlers);
            // If already connected, send live subscribe message
            if (this.ws && this._status === 'connected') {
                this.sendSubscribe([pattern], null);
            }
        }
        handlers.add(handler);
        return () => {
            this.unsubscribeHandler(pattern, handler);
        };
    }
    unsubscribe(pattern) {
        const handlers = this.subscriptions.get(pattern);
        if (handlers) {
            handlers.clear();
            this.subscriptions.delete(pattern);
            // Send unsubscribe if connected
            if (this.ws && this._status === 'connected') {
                try {
                    this.ws.send(JSON.stringify({ type: 'unsubscribe', patterns: [pattern] }));
                }
                catch { /* ignore */ }
            }
        }
    }
    unsubscribeHandler(pattern, handler) {
        const handlers = this.subscriptions.get(pattern);
        if (handlers) {
            handlers.delete(handler);
            if (handlers.size === 0) {
                this.unsubscribe(pattern);
            }
        }
    }
    // -------------------------------------------------------------------------
    // Connect
    // -------------------------------------------------------------------------
    async connect() {
        if (this.stopped)
            return;
        logger.info({ hubWsUrl: this.opts.hubWsUrl }, 'hub-ws-client: connecting');
        // Build signed URL
        let url;
        try {
            url = await this.buildAuthUrl();
        }
        catch (err) {
            logger.warn({ err }, 'hub-ws-client: failed to build auth URL; scheduling reconnect');
            this.scheduleReconnect();
            return;
        }
        let ws;
        try {
            ws = new WebSocket(url);
        }
        catch (err) {
            logger.warn({ err }, 'hub-ws-client: WebSocket construction failed; scheduling reconnect');
            this.scheduleReconnect();
            return;
        }
        this.ws = ws;
        ws.addEventListener('open', () => {
            logger.info({ hubWsUrl: this.opts.hubWsUrl }, 'hub-ws-client: connected');
            this.reconnectDelayMs = this.opts.initialReconnectMs ?? DEFAULT_INITIAL_RECONNECT_MS;
            this.setStatus('connected');
            // Re-subscribe all patterns with cursor for backfill.
            // Round 7-06: the cursor in the subscribe message causes the hub to
            // replay any events missed during the disconnect window (events since
            // last_seen_event_id). This is the canonical backfill path.
            this.resubscribeAll();
            // Round 7-06: notify outbox that we're reconnected so it can start
            // flushing queued mutations immediately.
            this.opts.onReconnected?.();
        });
        ws.addEventListener('message', (ev) => {
            try {
                const msg = JSON.parse(ev.data);
                this.handleMessage(msg);
            }
            catch (err) {
                logger.warn({ err }, 'hub-ws-client: failed to parse message');
            }
        });
        ws.addEventListener('close', () => {
            logger.info({ hubWsUrl: this.opts.hubWsUrl }, 'hub-ws-client: connection closed');
            this.ws = null;
            if (!this.stopped) {
                this.setStatus('reconnecting');
                this.scheduleReconnect();
            }
            else {
                this.setStatus('disconnected');
            }
        });
        ws.addEventListener('error', (ev) => {
            logger.warn({ event: ev }, 'hub-ws-client: WS error');
        });
    }
    // -------------------------------------------------------------------------
    // Message handling
    // -------------------------------------------------------------------------
    handleMessage(msg) {
        if (msg['ws_type'] === 'event') {
            const cursor = msg['cursor'];
            if (typeof cursor === 'string') {
                this._lastSeenEventId = cursor;
            }
            const payload = msg['payload'];
            const envelope = {
                event_id: String(payload['event_id'] ?? ''),
                aggregate_id: String(payload['aggregate_id'] ?? ''),
                aggregate_type: String(payload['aggregate_type'] ?? ''),
                event_type: String(payload['event_type'] ?? ''),
                payload: payload['payload'] ?? {},
                actor: payload['actor'],
                capability_id: payload['capability_id'],
                trace_id: String(msg['trace_id'] ?? ''),
                occurred_at: String(payload['occurred_at'] ?? new Date().toISOString()),
                ingested_at: new Date().toISOString(),
                schema_version: Number(payload['schema_version'] ?? 1),
            };
            this.dispatchEvent(envelope);
        }
    }
    dispatchEvent(event) {
        // Dispatch to all pattern handlers that match this event.
        for (const [pattern, handlers] of this.subscriptions) {
            if (patternMatchesEvent(pattern, event) && handlers.size > 0) {
                for (const handler of handlers) {
                    try {
                        handler(event);
                    }
                    catch (err) {
                        logger.warn({ err, pattern }, 'hub-ws-client: event handler threw');
                    }
                }
            }
        }
    }
    // -------------------------------------------------------------------------
    // Subscription management
    // -------------------------------------------------------------------------
    resubscribeAll() {
        const patterns = Array.from(this.subscriptions.keys());
        if (patterns.length === 0)
            return;
        this.sendSubscribe(patterns, this._lastSeenEventId);
    }
    sendSubscribe(patterns, cursor) {
        if (!this.ws || this._status !== 'connected')
            return;
        const msg = { type: 'subscribe', patterns };
        if (cursor)
            msg['cursor'] = cursor;
        try {
            this.ws.send(JSON.stringify(msg));
        }
        catch (err) {
            logger.warn({ err }, 'hub-ws-client: send subscribe failed');
        }
    }
    // -------------------------------------------------------------------------
    // Reconnect
    // -------------------------------------------------------------------------
    scheduleReconnect() {
        if (this.stopped)
            return;
        const delay = this.reconnectDelayMs;
        this.reconnectDelayMs = Math.min(delay * 2, this.opts.maxReconnectMs ?? DEFAULT_MAX_RECONNECT_MS);
        logger.info({ delayMs: delay }, 'hub-ws-client: scheduling reconnect');
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            void this.connect();
        }, delay);
    }
    // -------------------------------------------------------------------------
    // Auth URL builder
    // -------------------------------------------------------------------------
    async buildAuthUrl() {
        const key = await getOrCreateInstallKey();
        const env = await signEnvelope({
            method: WS_CONNECT_METHOD,
            bodyBytes: new Uint8Array(0),
            privateKey: key.privateKey,
        });
        const base = this.opts.hubWsUrl.replace(/\/$/, '');
        const params = new URLSearchParams({
            install_id: key.installId,
            sig: env.signatureB64,
            sig_body: env.bodyB64,
        });
        if (this._lastSeenEventId) {
            params.set('cursor', this._lastSeenEventId);
        }
        return `${base}/ws?${params.toString()}`;
    }
    // -------------------------------------------------------------------------
    // Status
    // -------------------------------------------------------------------------
    setStatus(s) {
        if (this._status !== s) {
            this._status = s;
            this.opts.onStatusChange?.(s);
        }
    }
}
// ---------------------------------------------------------------------------
// Client-side pattern matcher (for dispatching received events to handlers)
// ---------------------------------------------------------------------------
function patternMatchesEvent(pattern, event) {
    const payload = event.payload;
    if (pattern.startsWith('task:')) {
        const id = pattern.slice('task:'.length);
        return event.aggregate_id === id || payload['task_id'] === id;
    }
    if (pattern.startsWith('channel:')) {
        const name = pattern.slice('channel:'.length);
        return ((event.aggregate_type === 'channel' || event.aggregate_type === 'channel_post') &&
            (payload['channel_name'] === name || payload['channel_id'] === name || event.aggregate_id === name));
    }
    if (pattern.startsWith('project:') && pattern.endsWith(':events')) {
        const id = pattern.slice('project:'.length, -':events'.length);
        return event.aggregate_id === id || payload['project_id'] === id;
    }
    // worker:* check BEFORE worker:<id>:* to avoid 'worker:*' matching the
    // startsWith/endsWith branch (which would compute installId='', then fail silently).
    if (pattern === 'worker:*') {
        return event.aggregate_type === 'orchestration';
    }
    if (pattern.startsWith('worker:') && pattern.endsWith(':*')) {
        const installId = pattern.slice('worker:'.length, -':*'.length);
        if (!installId)
            return false;
        return (event.aggregate_type === 'orchestration' &&
            (payload['install_id'] === installId ||
                event.actor?.['install_id'] === installId));
    }
    if (pattern === 'team:presence') {
        return event['aggregate_type'] === 'presence' ||
            event.event_type === 'PresenceUpdated';
    }
    // Fallback: treat as direct aggregate_id match
    return event.aggregate_id === pattern;
}
// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
export function createHubWsClient(opts) {
    return new HubWsClientImpl(opts);
}
/**
 * Create from env (ORBITAL_HUB_URL → derive ws URL).
 * Returns null if ORBITAL_HUB_URL not set.
 */
export function createHubWsClientFromEnv(onStatusChange) {
    const hubUrl = process.env['ORBITAL_HUB_URL'];
    if (!hubUrl)
        return null;
    // Convert http(s) → ws(s)
    const wsUrl = hubUrl.replace(/^http/, 'ws').replace(/\/$/, '');
    return createHubWsClient({ hubWsUrl: wsUrl, onStatusChange });
}
//# sourceMappingURL=ws-client.js.map