/**
 * Event type re-exports and internal helpers for the events subsystem.
 *
 * Per Task 1A spec: re-export from @orbital/types; add internal helpers.
 * No new Zod schemas are defined here — canonical shapes live in @orbital/types.
 *
 * Round 6 #8 additions: 5 new provider/routing event payload types.
 */
export { EventEnvelopeSchema, EventInputSchema, EventQueryFilterSchema, AggregateTypeSchema, ActorSchema, } from '@orbital/types';
import { EventEnvelopeSchema } from '@orbital/types';
/**
 * Normalize a timestamp string from Postgres (space-separated, +00) to ISO 8601
 * (T-separated, Z suffix) so Zod's z.string().datetime() accepts it.
 *
 * Postgres returns timestamps in the form "2026-05-01 15:42:18.123+00"
 * ISO 8601 requires "2026-05-01T15:42:18.123Z".
 */
function toIso8601(ts) {
    // Replace the space separator with T, and trailing +00 (with optional :00) with Z.
    return ts.replace(' ', 'T').replace(/\+00(:00)?$/, 'Z');
}
/**
 * Map a raw Drizzle EventRow to a validated EventEnvelope.
 * Throws ZodError if the row does not conform — schema_version included.
 *
 * Per TRD-07 §9 (schema versioning): the envelope is returned with its
 * original schema_version; callers dispatch on that version for payload parsing.
 */
export function rowToEnvelope(row) {
    return EventEnvelopeSchema.parse({
        event_id: row.eventId,
        aggregate_id: row.aggregateId,
        aggregate_type: row.aggregateType,
        event_type: row.eventType,
        payload: row.payload,
        actor: row.actor,
        capability_id: row.capabilityId ?? undefined,
        parent_event_id: row.parentEventId ?? undefined,
        trace_id: row.traceId,
        // Normalize Postgres timestamp format to ISO 8601 for Zod validation.
        occurred_at: toIso8601(row.occurredAt),
        ingested_at: toIso8601(row.ingestedAt),
        schema_version: row.schemaVersion,
    });
}
// ---------------------------------------------------------------------------
// Cursor helpers
// ---------------------------------------------------------------------------
/**
 * Encode a cursor from (occurred_at, event_id) for paginating the events query.
 * Cursor is base64url so it survives URL transmission.
 * Per TRD-07 §6.1.1 cursor semantics.
 */
export function encodeCursor(occurredAt, eventId) {
    return Buffer.from(JSON.stringify({ occurred_at: occurredAt, event_id: eventId })).toString('base64url');
}
/**
 * Decode a cursor. Returns null if the cursor is null/empty (start of list).
 * Throws if the cursor is malformed.
 */
export function decodeCursor(cursor) {
    if (!cursor)
        return null;
    try {
        const raw = Buffer.from(cursor, 'base64url').toString('utf8');
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' ||
            parsed === null ||
            typeof parsed['occurred_at'] !== 'string' ||
            typeof parsed['event_id'] !== 'string') {
            throw new Error('invalid cursor shape');
        }
        return parsed;
    }
    catch {
        throw new Error(`VALIDATION_INVALID_CURSOR: malformed cursor`);
    }
}
//# sourceMappingURL=types.js.map