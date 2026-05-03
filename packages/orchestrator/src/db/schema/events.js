/**
 * Drizzle schema for the audit.events table.
 *
 * Per TRD-07 §4.1.1: the table lives in the `audit` schema, is partitioned by
 * RANGE (ingested_at) with monthly partitions. Drizzle does not emit native
 * PARTITION BY DDL, so partitioning is applied via the companion manual
 * migration (0001_events.sql) that replaces the Drizzle-generated CREATE TABLE
 * with the partitioned form.
 *
 * The Drizzle pgTable declaration here serves TypeScript typing only.
 */
import { pgSchema, uuid, text, jsonb, integer, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
// timestamptz is accessed via a helper from drizzle-orm/pg-core — alias it clearly.
import { timestamp } from 'drizzle-orm/pg-core';
/** Logical schema grouping per SAO §5.3. */
export const audit = pgSchema('audit');
/**
 * The master append-only event log.
 *
 * Primary key is (event_id, ingested_at) because Postgres requires all
 * unique-constraint columns to include the partition key. Logical uniqueness
 * on event_id alone is enforced by events_event_id_unique.
 *
 * Per TRD-07 §4.1.1 and Primitives §7.
 */
export const events = audit.table('events', {
    // UUIDv7 generated in application code (stores.ts), never SERIAL.
    eventId: uuid('event_id').notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    aggregateType: text('aggregate_type').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    // ActorSchema discriminated union; stored as JSONB, validated in app.
    actor: jsonb('actor').notNull(),
    capabilityId: uuid('capability_id'),
    parentEventId: uuid('parent_event_id'),
    traceId: text('trace_id').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'string' }).notNull(),
    // Set by DB DEFAULT now(); application may pass explicit value for replay.
    ingestedAt: timestamp('ingested_at', { withTimezone: true, mode: 'string' })
        .notNull()
        .defaultNow(),
    schemaVersion: integer('schema_version').notNull(),
}, (t) => ({
    // Composite PK required by Postgres for partitioned unique constraints.
    // See migration SQL for actual PRIMARY KEY (event_id, ingested_at).
    eventIdUnique: uniqueIndex('events_event_id_unique').on(t.eventId),
    aggregateOccurredIdx: index('events_aggregate_occurred_at_idx').on(t.aggregateId, t.occurredAt),
    eventTypeOccurredIdx: index('events_event_type_occurred_at_idx').on(t.eventType, t.occurredAt),
    // GIN expression index for actor->>'persona_id' filter.
    // using() accepts (method, ...columns) in drizzle-orm 0.36.
    actorPersonaOccurredIdx: index('events_actor_persona_occurred_at_idx')
        .using('btree', sql `(actor->>'persona_id')`, t.occurredAt),
    payloadGin: index('events_payload_gin').using('gin', t.payload),
    capabilityOccurredIdx: index('events_capability_occurred_at_idx').on(t.capabilityId, t.occurredAt),
    traceIdx: index('events_trace_id_idx').on(t.traceId),
    // Partition key index — also used for cursor seek (ingested_at, event_id).
    ingestedAtIdx: index('events_ingested_at_idx').on(t.ingestedAt, t.eventId),
}));
//# sourceMappingURL=events.js.map