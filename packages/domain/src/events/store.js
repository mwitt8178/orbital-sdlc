/**
 * EventStore — the append-only event log service.
 *
 * Per Task 1A spec and TRD-07 §6:
 * - append(): writes a real row, generates UUIDv7 for event_id, returns full envelope.
 * - query(): paginated, filterable query with cursor pagination.
 * - subscribe(): LISTEN-based real-time delivery with cursor backfill on connect.
 *
 * Every write goes through this service. No direct db.insert(events) elsewhere.
 *
 * Per TRD-07 §8.1 (idempotency): if a duplicate event_id is inserted (Postgres
 * error 23505), the store treats it as success-by-prior-write and returns the
 * existing envelope.
 *
 * Round 7-06 — Local-mode write when hub is down
 * [Engineer-Sr · Sonnet · run-round7-06-offline-reconcile]
 *
 * append() always succeeds for the local write. The hub-bound mirror is handled
 * by the caller's fanout layer (7-02/7-04). When the hub is unreachable, the
 * caller queues to the persistent outbox instead. The EventStore itself is
 * hub-unaware — it writes to local Postgres unconditionally.
 *
 * This is already the behaviour from 7-02 and 7-04. The 7-06 addition is the
 * appendWithOutboxFallback() helper that the MCP audit middleware calls: it
 * attempts the hub fanout; if the hub client is offline or the call fails, it
 * enqueues to the persistent outbox rather than dropping the event.
 */
import { uuidv7 } from 'uuidv7';
import { eq, and, lt, gt, gte, desc, asc, or } from 'drizzle-orm';
import { sql as dSQL } from 'drizzle-orm';
import { events } from '@orbital/db';
import { logger } from '../logger.js';
import { EventEnvelopeSchema, rowToEnvelope, encodeCursor, decodeCursor, } from './types.js';
import { NotifyClient } from './notify.js';
// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------
export class PostgresEventStore {
    db;
    sql;
    notifyClient;
    constructor(db, sql) {
        this.db = db;
        this.sql = sql;
        this.notifyClient = new NotifyClient(sql, (eventId) => this.getById(eventId), (afterEventId) => this.backfillSince(afterEventId));
    }
    // --------------------------------------------------------------------------
    // append
    // --------------------------------------------------------------------------
    async append(event) {
        // Validate input shape against canonical schema (minus event_id/ingested_at).
        // This catches malformed actor, aggregate_type enum violations, etc.
        const validated = EventEnvelopeSchema.omit({ event_id: true, ingested_at: true }).parse(event);
        const eventId = uuidv7();
        const insertRow = {
            eventId,
            aggregateId: validated.aggregate_id,
            aggregateType: validated.aggregate_type,
            eventType: validated.event_type,
            payload: validated.payload,
            actor: validated.actor,
            capabilityId: validated.capability_id ?? null,
            parentEventId: validated.parent_event_id ?? null,
            traceId: validated.trace_id,
            occurredAt: validated.occurred_at,
            schemaVersion: validated.schema_version,
            // ingestedAt defaults to now() in the DB; we do not set it here so the
            // partition routing uses the actual commit-time value.
        };
        try {
            const [row] = await this.db.insert(events).values(insertRow).returning();
            if (!row) {
                throw new Error('INTERNAL_DB_ERROR: INSERT returned no rows');
            }
            const envelope = rowToEnvelope(row);
            logger.debug({ event_id: envelope.event_id, event_type: envelope.event_type }, 'EventStore: appended event');
            return envelope;
        }
        catch (err) {
            // Per TRD-07 §8.1: duplicate event_id → treat as success-by-prior-write.
            if (isDuplicateKeyError(err)) {
                logger.warn({ eventId }, 'EventStore: duplicate event_id — returning existing envelope');
                const existing = await this.getById(eventId);
                if (!existing) {
                    throw new Error('INTERNAL_DB_ERROR: duplicate event_id but row not found');
                }
                return existing;
            }
            throw err;
        }
    }
    // --------------------------------------------------------------------------
    // query
    // --------------------------------------------------------------------------
    async query(filter) {
        const limit = filter.limit ?? 100;
        const cursor = decodeCursor(filter.after);
        const conditions = [];
        // Filter: aggregate_type
        if (filter.aggregate_type !== undefined) {
            conditions.push(eq(events.aggregateType, filter.aggregate_type));
        }
        // Filter: aggregate_id
        if (filter.aggregate_id !== undefined) {
            conditions.push(eq(events.aggregateId, filter.aggregate_id));
        }
        // Filter: event_type
        if (filter.event_type !== undefined) {
            conditions.push(eq(events.eventType, filter.event_type));
        }
        // Filter: actor_id — matches persona_id OR user_id depending on actor_type.
        // The actor column is JSONB; we extract the relevant field.
        if (filter.actor_id !== undefined) {
            // actor_type helps narrow, but actor_id matching is type-specific.
            if (filter.actor_type === 'persona') {
                conditions.push(dSQL `${events.actor}->>'persona_id' = ${filter.actor_id}`);
            }
            else if (filter.actor_type === 'user') {
                conditions.push(dSQL `${events.actor}->>'user_id' = ${filter.actor_id}`);
            }
            else if (filter.actor_type === 'hook') {
                conditions.push(dSQL `${events.actor}->>'hook_id' = ${filter.actor_id}`);
            }
            else {
                // No actor_type specified: match against any id field (OR).
                conditions.push(or(dSQL `${events.actor}->>'persona_id' = ${filter.actor_id}`, dSQL `${events.actor}->>'user_id' = ${filter.actor_id}`, dSQL `${events.actor}->>'hook_id' = ${filter.actor_id}`));
            }
        }
        else if (filter.actor_type !== undefined) {
            // Filter by actor type only (no specific id).
            conditions.push(dSQL `${events.actor}->>'type' = ${filter.actor_type}`);
        }
        // Filter: occurred_at range
        if (filter.occurred_after !== undefined) {
            conditions.push(gte(events.occurredAt, filter.occurred_after));
        }
        if (filter.occurred_before !== undefined) {
            conditions.push(lt(events.occurredAt, filter.occurred_before));
        }
        // Filter: trace_id
        if (filter.trace_id !== undefined) {
            conditions.push(eq(events.traceId, filter.trace_id));
        }
        // Cursor pagination (occurred_at DESC, event_id DESC for stable ordering).
        // Per TRD-07 §6.1.1: cursor = {occurred_at, event_id}.
        if (cursor !== null) {
            conditions.push(or(lt(events.occurredAt, cursor.occurred_at), and(eq(events.occurredAt, cursor.occurred_at), lt(events.eventId, cursor.event_id))));
        }
        const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
        const rows = await this.db
            .select()
            .from(events)
            .where(whereClause)
            .orderBy(desc(events.occurredAt), desc(events.eventId))
            // Fetch limit+1 to determine has_more without a separate COUNT query.
            .limit(limit + 1);
        const hasMore = rows.length > limit;
        const pageRows = hasMore ? rows.slice(0, limit) : rows;
        const items = pageRows.map((row) => rowToEnvelope(row));
        const lastItem = items[items.length - 1];
        const nextCursor = hasMore && lastItem !== undefined
            ? encodeCursor(lastItem.occurred_at, lastItem.event_id)
            : null;
        return {
            items,
            next_cursor: nextCursor,
            has_more: hasMore,
        };
    }
    // --------------------------------------------------------------------------
    // subscribe
    // --------------------------------------------------------------------------
    subscribe(cursor, handler) {
        const unregister = this.notifyClient.registerHandler(handler);
        // Start the LISTEN connection if not already started.
        // Idempotent — NotifyClient.start() checks this.connected.
        void this.notifyClient.start(cursor).catch((err) => {
            logger.error({ err }, 'EventStore: failed to start NotifyClient');
        });
        return () => {
            unregister();
        };
    }
    // --------------------------------------------------------------------------
    // Internal helpers
    // --------------------------------------------------------------------------
    /** Fetch a single event by id. Returns null if not found. */
    async getById(eventId) {
        const rows = await this.db
            .select()
            .from(events)
            .where(eq(events.eventId, eventId))
            .limit(1);
        const row = rows[0];
        if (!row)
            return null;
        return rowToEnvelope(row);
    }
    /**
     * Backfill events newer than afterEventId (ordered by event_id ASC).
     * Used by NotifyClient on (re)connect and periodic defensive poll.
     * Per TRD-07 §4.1.4.
     */
    async backfillSince(afterEventId) {
        const rows = afterEventId
            ? await this.db
                .select()
                .from(events)
                .where(gt(events.eventId, afterEventId))
                .orderBy(asc(events.eventId))
                .limit(1000)
            : [];
        return rows.map((row) => rowToEnvelope(row));
    }
    /** Expose stop for graceful shutdown. Awaitable. */
    async stopNotifyClient() {
        await this.notifyClient.stop();
    }
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function isDuplicateKeyError(err) {
    if (typeof err !== 'object' || err === null)
        return false;
    // postgres.js wraps Postgres errors as { code: '23505' }
    const e = err;
    return e['code'] === '23505';
}
// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
/**
 * Create and return a configured EventStore using the shared db+sql connections.
 * Call once at startup; reuse the instance.
 */
export function createEventStore(db, sql) {
    return new PostgresEventStore(db, sql);
}
// ---------------------------------------------------------------------------
// Round 7-05 sanitize — local-only enforcement at the events fanout boundary.
// [Engineer-Principal · Opus · run-round7-05-local-only-isolation]
//
// This section provides a sanitising wrapper that intercepts events BEFORE
// they are mirrored to the hub (via Round 7-04's WS fanout or Round 7-02's
// outbox). The sanitiser runs at TWO points by design — here, and again at
// the wire boundary in HubClient.rpc() — so that any router that bypasses
// the events boundary still cannot reach the hub without inspection.
//
// Append-only: do not edit existing code above; new helpers go here so 7-04's
// fanout hook can pick them up without merge conflicts.
// ---------------------------------------------------------------------------
import { sanitizeForHub, LocalDataLeakError } from '../../../orchestrator/src/hub-client/sanitize.js';
// ---------------------------------------------------------------------------
// Round 8-05 — AWS SNS publish path
// [Engineer-Sr · Sonnet · run-round8-05-event-bus]
//
// When ORBITAL_DEPLOY_TARGET=aws, after the local DB commit + sanitize pass,
// publish the event to the SNS topic so all downstream consumers receive it.
// Local-mode LISTEN/NOTIFY path is unchanged.
//
// Chain (AWS mode): local DB commit → sanitize → SNS publish
// Chain (local mode): local DB commit → LISTEN/NOTIFY (unchanged)
// ---------------------------------------------------------------------------
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { env } from '../../../orchestrator/src/config/env.js';
let _snsClient = null;
function getSnsClient() {
    if (!_snsClient) {
        _snsClient = new SNSClient({
            region: process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? 'us-east-1',
        });
    }
    return _snsClient;
}
/** Reset SNS client for tests. */
export function _resetSnsClientForTests() {
    _snsClient = null;
}
/**
 * publishToSns — publish a stored event envelope to the SNS topic.
 *
 * Called after appendToDb() succeeds AND the sanitize check passes.
 * Fire-and-forget from the caller's perspective: errors are logged but do NOT
 * roll back the local DB write (the local write is the source of truth).
 *
 * Message attributes carry tenant_id, aggregate_type, event_type so SNS
 * subscription filter policies can route to the correct SQS consumer queues.
 *
 * @param envelope  The stored EventEnvelope (fully written, with event_id).
 * @param topicArn  The SNS topic ARN (from EVENTS_TOPIC_ARN env var).
 */
async function publishToSns(envelope, topicArn) {
    const tenantId = typeof envelope.payload['tenant_id'] === 'string'
        ? envelope.payload['tenant_id']
        : '';
    await getSnsClient().send(new PublishCommand({
        TopicArn: topicArn,
        Message: JSON.stringify(envelope),
        MessageAttributes: {
            tenant_id: { DataType: 'String', StringValue: tenantId },
            aggregate_type: { DataType: 'String', StringValue: envelope.aggregate_type },
            event_type: { DataType: 'String', StringValue: envelope.event_type },
        },
    }));
}
/**
 * appendAndPublish — append event to local DB, then publish to SNS if in AWS mode.
 *
 * Usage (AWS mode hub Lambda):
 *   import { appendAndPublish } from '../events/store.js'
 *   const envelope = await appendAndPublish(store, eventInput)
 *
 * The SNS publish error does NOT throw — the local write is authoritative.
 * SNS failures are logged as errors so alarms can detect persistent publish failures.
 */
export async function appendAndPublish(store, input) {
    // Step 1: local DB write — always authoritative.
    const envelope = await store.append(input);
    // Step 2: SNS publish — only in AWS mode.
    if (env.ORBITAL_DEPLOY_TARGET === 'aws') {
        const topicArn = env.EVENTS_TOPIC_ARN;
        if (!topicArn) {
            logger.error({ event_id: envelope.event_id }, 'events/store: ORBITAL_DEPLOY_TARGET=aws but EVENTS_TOPIC_ARN is not set — SNS publish skipped');
            return envelope;
        }
        // Sanitize before publishing to SNS (same guard as hub fanout).
        const sanitised = sanitizeEventForHubFanout(envelope);
        if (!sanitised.ok) {
            logger.warn({ event_id: envelope.event_id, event_type: envelope.event_type }, 'events/store: sanitizer blocked SNS publish — local write kept, SNS skipped');
            return envelope;
        }
        try {
            await publishToSns(envelope, topicArn);
            logger.debug({ event_id: envelope.event_id, event_type: envelope.event_type }, 'events/store: SNS publish succeeded');
        }
        catch (err) {
            // SNS publish error is NOT fatal — local write is the source of truth.
            logger.error({ event_id: envelope.event_id, event_type: envelope.event_type, err }, 'events/store: SNS publish failed — event persisted locally but not sent to SNS');
        }
    }
    return envelope;
}
/**
 * Sanitise an outbound event payload before fanout to the hub.
 *
 * Returns:
 *   - { ok: true } when the payload is safe to forward.
 *   - { ok: false, error } when local-only data was detected; caller MUST
 *     drop the hub fanout for this event but still keep the local write.
 *
 * The local Postgres write is NEVER blocked by the sanitiser — the sanitiser
 * only gates the LOCAL → HUB fanout. Local audit fidelity is sacrosanct.
 */
export function sanitizeEventForHubFanout(envelope) {
    try {
        // Walk the entire envelope minus event_id/ingested_at (those are server-
        // generated and known-safe). Inspect payload, actor, and any custom
        // fields. We pass the full object rather than just payload because event
        // types like LLMRequestCompleted store the request body in a sibling
        // field; we want the whole tree inspected.
        sanitizeForHub({
            event_type: envelope.event_type,
            aggregate_type: envelope.aggregate_type,
            payload: envelope.payload,
            actor: envelope.actor,
            capability_id: envelope.capability_id,
            trace_id: envelope.trace_id,
        }, `event:${envelope.event_type}`);
        return { ok: true };
    }
    catch (err) {
        if (err instanceof LocalDataLeakError) {
            logger.fatal({ event_id: envelope.event_id, event_type: envelope.event_type, path: err.path, reason: err.reason }, 'CRITICAL: blocked event from hub fanout — local-only data detected');
            return { ok: false, error: err };
        }
        // Unknown error — treat as fail-closed.
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ event_id: envelope.event_id, err }, 'event sanitiser threw unexpected error');
        return { ok: false, error: new LocalDataLeakError('<unknown>', msg, `event:${envelope.event_type}`) };
    }
}
/**
 * appendWithOutboxFallback — write event locally and mirror to hub.
 *
 * Local write is unconditional. Hub fanout follows this policy:
 *   - hub null (local mode): no fanout — done.
 *   - hub 'offline': sanitise payload; if clean, enqueue to outbox.
 *   - hub 'connected'/'reconnecting': sanitise payload; attempt direct call.
 *     On failure: enqueue to outbox for retry.
 *
 * @param store      The local event store (writes to local Postgres).
 * @param input      The event to append.
 * @param hubClient  Hub HTTP client, or null when hub is not configured.
 * @param outbox     Persistent outbox, or null when hub is not configured.
 * @returns          The local EventEnvelope (hub result is fire-and-forget).
 */
export async function appendWithOutboxFallback(store, input, hubClient, outbox) {
    // Step 1: local write — always.
    const envelope = await store.append(input);
    // Step 2: hub fanout.
    if (hubClient === null || outbox === null) {
        // Local-only mode — no hub configured.
        return envelope;
    }
    // Sanitise before any fanout.
    const sanitised = sanitizeEventForHubFanout(envelope);
    if (!sanitised.ok) {
        // Payload contains local-only data — never send to hub.
        return envelope;
    }
    const hubEventInput = {
        aggregate_id: envelope.aggregate_id,
        aggregate_type: envelope.aggregate_type,
        event_type: envelope.event_type,
        payload: envelope.payload,
        actor: envelope.actor,
        capability_id: envelope.capability_id,
        trace_id: envelope.trace_id,
        occurred_at: envelope.occurred_at,
        schema_version: envelope.schema_version,
        tenant_id: envelope.payload['tenant_id'] ?? '',
    };
    if (hubClient.connectionState === 'offline') {
        // Hub down — queue to outbox for deferred delivery.
        await outbox.enqueue(hubEventInput);
        logger.debug({ event_id: envelope.event_id, event_type: envelope.event_type }, 'events/store: hub offline — enqueued to outbox');
    }
    else {
        // Hub reachable — attempt direct fanout.
        const result = await hubClient.events.append(hubEventInput);
        if (!result.ok) {
            // Fanout failed — fallback to outbox.
            await outbox.enqueue(hubEventInput);
            logger.warn({ event_id: envelope.event_id, event_type: envelope.event_type }, 'events/store: hub fanout failed — enqueued to outbox');
        }
    }
    return envelope;
}
//# sourceMappingURL=store.js.map