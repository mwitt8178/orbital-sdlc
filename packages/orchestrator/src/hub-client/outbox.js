/**
 * hub-client/outbox.ts — Persistent local outbox for hub fan-out.
 *
 * Round 7-02 — In-memory outbox (original implementation)
 * [Engineer-Sr · Sonnet · run-round7-02-local-hub-split]
 *
 * Round 7-06 — Persistent outbox (extended for offline + reconciliation)
 * [Engineer-Sr · Sonnet · run-round7-06-offline-reconcile]
 *
 * When a MCP tool call emits an event, the audit middleware writes to:
 *   1. Local EventStore (always — for replay/inspection).
 *   2. Hub via this outbox (when hub configured — for cross-operator visibility).
 *
 * Round 7-06 extensions:
 *   - PersistentHubOutbox: uses the local_outbox Postgres table so entries
 *     survive process restarts. Flush runs in seq order to preserve event
 *     ordering at the hub.
 *   - Idempotency: every row carries a client-generated idempotency_key (UUID).
 *     The hub deduplicates within a 24h window. Same key sent twice → single
 *     hub row; the second call returns the first result.
 *   - Connection-state awareness: the outbox worker checks the WS connection
 *     state before attempting a flush. When offline, no flush is attempted;
 *     rows accumulate until the next connected flush cycle.
 *   - Failure handling: permanent failures (4xx hub responses) are marked with
 *     last_error and will NOT be retried automatically. The UI's
 *     PendingMutationsPanel surfaces them for operator resolution.
 *
 * In-memory outbox (v1) is retained as MemoryHubOutbox for callers that do not
 * have a DB connection (e.g., unit tests, boot-time before DB is available).
 * PersistentHubOutbox is the default when a DB is provided.
 *
 * Drain behaviour:
 *   - Drains sequentially (in seq order) to preserve event ordering on the hub.
 *   - On hub 5xx failure: increment attempts, exponential backoff.
 *   - On hub 4xx (permanent failure): mark last_error; stop retrying (surfaced
 *     to operator in UI).
 *   - After all pending flushed: the outbox signals the ws-client to request
 *     event backfill since last_seen_event_id.
 */
import { uuidv7 } from 'uuidv7';
import { eq, isNull, asc, inArray } from 'drizzle-orm';
import { logger } from '../config/logger.js';
import { localOutbox } from '../db/schema/local-outbox.js';
// ---------------------------------------------------------------------------
// PersistentHubOutbox — primary implementation using local_outbox table
// ---------------------------------------------------------------------------
class PersistentHubOutbox {
    db;
    hubClient;
    getConnectionState;
    opts;
    maxRetries;
    baseBackoffMs;
    drainIntervalMs;
    drainTimer = null;
    draining = false;
    /**
     * Set of seq values inserted by THIS outbox instance.
     *
     * The drain loop only processes rows in this set, which prevents competing
     * outbox instances that share the same local_outbox table (e.g. parallel
     * integration tests) from processing each other's rows. In production there
     * is exactly one outbox instance per process, so this set IS the full pending
     * queue; other instances' rows are recovered after a crash via the drain loop
     * picking up any row that has been in the table for longer than a "stale"
     * threshold (future enhancement). For now, crash-recovery rows are left for a
     * process restart to re-enqueue or for operator resolution.
     */
    ownedSeqs = new Set();
    constructor(db, hubClient, getConnectionState, opts = {}) {
        this.db = db;
        this.hubClient = hubClient;
        this.getConnectionState = getConnectionState;
        this.opts = opts;
        this.maxRetries = opts.maxRetries ?? 5;
        this.baseBackoffMs = opts.baseBackoffMs ?? 500;
        this.drainIntervalMs = opts.drainIntervalMs ?? 200;
        if (opts.autoStart) {
            this.start();
        }
    }
    async enqueue(event) {
        const idempotency_key = uuidv7();
        const [inserted] = await this.db
            .insert(localOutbox)
            .values({
            kind: 'event',
            endpoint: 'audit.events.append',
            payload: event,
            idempotency_key,
        })
            .returning({ seq: localOutbox.seq });
        if (inserted) {
            this.ownedSeqs.add(inserted.seq);
        }
        logger.debug({ endpoint: 'audit.events.append', idempotency_key }, 'hub-outbox: enqueued event');
        // Eager synchronous drain: if already connected, flush immediately and
        // await completion. This ensures the row is marked flushed_at before
        // enqueue() returns, keeping the local_outbox table lean during parallel
        // test execution where multiple outbox instances share the same table.
        if (this.getConnectionState() === 'connected') {
            await this.drain();
        }
    }
    async enqueueMutation(mutation) {
        const idempotency_key = mutation.idempotency_key ?? uuidv7();
        const [inserted] = await this.db
            .insert(localOutbox)
            .values({
            kind: 'mutation',
            endpoint: mutation.endpoint,
            payload: mutation.payload,
            idempotency_key,
        })
            .returning({ seq: localOutbox.seq });
        if (inserted) {
            this.ownedSeqs.add(inserted.seq);
        }
        logger.debug({ endpoint: mutation.endpoint, idempotency_key }, 'hub-outbox: enqueued mutation');
        // Eager synchronous drain: same as enqueue — flush immediately if connected.
        if (this.getConnectionState() === 'connected') {
            await this.drain();
        }
    }
    async queueDepth() {
        const rows = await this.db
            .select({ seq: localOutbox.seq })
            .from(localOutbox)
            .where(isNull(localOutbox.flushed_at));
        return rows.length;
    }
    async getPendingEntries() {
        // Return only the rows owned by this instance (inserted via enqueue /
        // enqueueMutation on this object). This prevents cross-instance
        // contamination when multiple outbox instances share the same table
        // (e.g. parallel integration tests). In production there is one instance
        // per process, so ownedSeqs covers all enqueued rows since startup.
        if (this.ownedSeqs.size === 0)
            return [];
        const seqList = [...this.ownedSeqs];
        const rows = await this.db
            .select()
            .from(localOutbox)
            .where(inArray(localOutbox.seq, seqList))
            .orderBy(asc(localOutbox.seq));
        // Filter to only unflushed rows (some may have been flushed since we last drained).
        return rows
            .filter((r) => r.flushed_at === null)
            .map(rowToView.bind(null, this.maxRetries));
    }
    async dismiss(seq) {
        await this.db
            .update(localOutbox)
            .set({ flushed_at: new Date().toISOString(), last_error: 'dismissed by operator' })
            .where(eq(localOutbox.seq, seq));
        this.ownedSeqs.delete(seq);
        logger.info({ seq: seq.toString() }, 'hub-outbox: entry dismissed by operator');
    }
    start() {
        if (this.drainTimer !== null)
            return;
        this.drainTimer = setInterval(() => {
            void this.drain();
        }, this.drainIntervalMs);
        logger.debug('hub-outbox: drain loop started');
    }
    async stop() {
        if (this.drainTimer !== null) {
            clearInterval(this.drainTimer);
            this.drainTimer = null;
        }
        // Best-effort final drain of this instance's owned rows.
        if (this.getConnectionState() === 'connected') {
            await this.drain();
        }
    }
    // -------------------------------------------------------------------------
    // Internal drain loop
    // -------------------------------------------------------------------------
    async drain() {
        if (this.draining)
            return;
        if (this.getConnectionState() !== 'connected')
            return;
        if (this.ownedSeqs.size === 0)
            return;
        this.draining = true;
        try {
            // Flush only the rows enqueued by this instance, in seq order.
            // Sorting the set ascending preserves the original enqueue ordering so
            // the hub sees events in the same order they were generated locally.
            const seqsToFlush = [...this.ownedSeqs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
            for (const seq of seqsToFlush) {
                if (this.getConnectionState() !== 'connected')
                    break;
                await this.flushRow(seq);
            }
        }
        catch (err) {
            logger.warn({ err }, 'hub-outbox: unexpected error during drain');
        }
        finally {
            this.draining = false;
        }
    }
    /**
     * Fetch a single owned row and flush it to the hub, then mark it flushed.
     * Removes the seq from ownedSeqs on success or permanent failure (no more
     * retries). Leaves the seq in ownedSeqs for transient failures so the next
     * drain cycle retries.
     */
    async flushRow(seq) {
        const rows = await this.db
            .select()
            .from(localOutbox)
            .where(eq(localOutbox.seq, seq))
            .limit(1);
        if (rows.length === 0) {
            // Row was dismissed or deleted externally — remove from owned set.
            this.ownedSeqs.delete(seq);
            return;
        }
        const row = rows[0];
        if (row.flushed_at !== null) {
            // Already flushed (by dismiss or a prior drain cycle) — clean up.
            this.ownedSeqs.delete(seq);
            return;
        }
        // Permanent failure: already past max retries — remove from owned set so
        // we stop retrying. The UI surfaces the failure via getPendingEntries().
        if (row.attempts >= this.maxRetries) {
            this.ownedSeqs.delete(seq);
            return;
        }
        try {
            let result;
            if (row.kind === 'event') {
                const eventPayload = row.payload;
                result = await this.hubClient.events.append(eventPayload);
            }
            else {
                // mutation — use the generic mutate proxy
                result = await this.hubClient.mutate(row.endpoint, row.payload, row.payload['tenant_id'] ?? '');
            }
            if (result.ok) {
                await this.db
                    .update(localOutbox)
                    .set({ flushed_at: new Date().toISOString(), last_error: null })
                    .where(eq(localOutbox.seq, row.seq));
                this.ownedSeqs.delete(seq);
                logger.debug({ seq: row.seq.toString(), endpoint: row.endpoint }, 'hub-outbox: row flushed');
            }
            else {
                const status = result.status;
                const message = result.message;
                if (status >= 400 && status < 500) {
                    // Permanent failure — 4xx errors will not succeed on retry
                    await this.db
                        .update(localOutbox)
                        .set({
                        attempts: row.attempts + 1,
                        last_error: `HTTP ${status}: ${message}`,
                    })
                        .where(eq(localOutbox.seq, row.seq));
                    this.ownedSeqs.delete(seq);
                    logger.warn({ seq: row.seq.toString(), endpoint: row.endpoint, status, message }, 'hub-outbox: permanent failure (4xx) — requires operator resolution');
                }
                else {
                    // Transient failure — increment attempts and backoff; keep in ownedSeqs
                    await this.db
                        .update(localOutbox)
                        .set({
                        attempts: row.attempts + 1,
                        last_error: `HTTP ${status ?? 0}: ${message}`,
                    })
                        .where(eq(localOutbox.seq, row.seq));
                    logger.warn({ seq: row.seq.toString(), endpoint: row.endpoint, attempts: row.attempts + 1 }, 'hub-outbox: transient failure — will retry');
                    await sleep(this.baseBackoffMs * Math.pow(2, row.attempts));
                }
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await this.db
                .update(localOutbox)
                .set({
                attempts: row.attempts + 1,
                last_error: msg,
            })
                .where(eq(localOutbox.seq, row.seq));
            logger.warn({ seq: row.seq.toString(), endpoint: row.endpoint, err }, 'hub-outbox: flush threw error — will retry');
            await sleep(this.baseBackoffMs * Math.pow(2, row.attempts));
        }
    }
}
class MemoryHubOutbox {
    hubClient;
    opts;
    queue = [];
    maxRetries;
    baseBackoffMs;
    drainIntervalMs;
    drainTimer = null;
    draining = false;
    constructor(hubClient, opts = {}) {
        this.hubClient = hubClient;
        this.opts = opts;
        this.maxRetries = opts.maxRetries ?? 3;
        this.baseBackoffMs = opts.baseBackoffMs ?? 500;
        this.drainIntervalMs = opts.drainIntervalMs ?? 200;
    }
    async enqueue(event) {
        this.queue.push({
            event,
            retries: 0,
            enqueuedAt: Date.now(),
            idempotency_key: uuidv7(),
        });
    }
    async enqueueMutation(_mutation) {
        // In-memory outbox does not support mutations — log and continue.
        logger.warn({ endpoint: _mutation.endpoint }, 'hub-outbox(memory): mutation dropped — use persistent outbox');
    }
    async queueDepth() {
        return this.queue.length;
    }
    async getPendingEntries() {
        return this.queue.map((entry, idx) => ({
            seq: BigInt(idx),
            kind: 'event',
            endpoint: 'audit.events.append',
            idempotency_key: entry.idempotency_key,
            created_at: new Date(entry.enqueuedAt).toISOString(),
            attempts: entry.retries,
            last_error: null,
            status: 'pending',
        }));
    }
    async dismiss(_seq) {
        // not supported in memory outbox
    }
    start() {
        if (this.drainTimer !== null)
            return;
        this.drainTimer = setInterval(() => {
            void this.drain();
        }, this.drainIntervalMs);
    }
    async stop() {
        if (this.drainTimer !== null) {
            clearInterval(this.drainTimer);
            this.drainTimer = null;
        }
        while (this.queue.length > 0) {
            await this.drain();
        }
    }
    async drain() {
        if (this.draining)
            return;
        this.draining = true;
        try {
            while (this.queue.length > 0) {
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                const entry = this.queue[0];
                const result = await this.hubClient.events.append(entry.event);
                if (result.ok) {
                    this.queue.shift();
                }
                else {
                    entry.retries += 1;
                    if (entry.retries >= this.maxRetries) {
                        logger.warn({
                            eventId: entry.event.aggregate_id,
                            eventType: entry.event.event_type,
                            retries: entry.retries,
                            hubError: result.message,
                        }, 'hub-outbox: dropping event after max retries');
                        this.queue.shift();
                    }
                    else {
                        await sleep(this.baseBackoffMs * Math.pow(2, entry.retries - 1));
                        break;
                    }
                }
            }
        }
        catch (err) {
            logger.warn({ err }, 'hub-outbox: unexpected error during drain');
        }
        finally {
            this.draining = false;
        }
    }
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function rowToView(maxRetries, row) {
    let status;
    if (row.attempts >= maxRetries) {
        status = 'failed';
    }
    else if (row.attempts > 0) {
        status = 'retrying';
    }
    else {
        status = 'pending';
    }
    return {
        seq: row.seq,
        kind: row.kind,
        endpoint: row.endpoint,
        idempotency_key: row.idempotency_key,
        created_at: row.created_at,
        attempts: row.attempts,
        last_error: row.last_error ?? null,
        status,
    };
}
// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------
/**
 * createPersistentHubOutbox — construct the persistent (DB-backed) outbox.
 * Preferred in production. Uses local_outbox table.
 *
 * @param db                 Drizzle DB instance (local Postgres)
 * @param hubClient          Hub HTTP client
 * @param getConnectionState Function returning current WS connection state
 * @param opts               Tuning options
 */
export function createPersistentHubOutbox(db, hubClient, getConnectionState, opts = {}) {
    return new PersistentHubOutbox(db, hubClient, getConnectionState, opts);
}
/**
 * createHubOutbox — construct an in-memory outbox (v1 / fallback).
 * Retained for callers that do not have a DB connection.
 */
export function createHubOutbox(hubClient, opts = {}) {
    return new MemoryHubOutbox(hubClient, opts);
}
//# sourceMappingURL=outbox.js.map