/**
 * local-outbox.ts — Drizzle schema for the local_outbox table.
 *
 * Round 7-06 — Offline Cache + Reconciliation
 * [Engineer-Sr · Sonnet · run-round7-06-offline-reconcile]
 *
 * local_outbox is a LOCAL-ONLY table (not shared to the hub).
 * It persists hub-bound mutations and events when the hub is unreachable,
 * enabling ordered flush-on-reconnect with idempotency guarantees.
 *
 * Schema design:
 *   - seq: bigserial surrogate PK — drives strict flush ordering
 *   - kind: 'event' | 'mutation' — determines which hub endpoint receives the row
 *   - endpoint: tRPC procedure path, e.g. 'audit.events.append', 'tasks.claim'
 *   - payload: the full JSON body to send
 *   - idempotency_key: UUID generated at enqueue time; hub deduplicates within 24h
 *   - created_at: wall-clock enqueue time
 *   - attempts: incremented on each flush attempt; used for backoff
 *   - last_error: last error message for observability + UI
 *   - flushed_at: set when hub confirmed receipt; NULL = pending
 *
 * Per DSQL constraints:
 *   - No foreign keys
 *   - No triggers
 *   - No extensions
 *   - IDs generated in application layer
 *
 * Per multi-tenant-migrations: additive-only, CREATE TABLE IF NOT EXISTS.
 */
import { pgTable, bigserial, text, jsonb, uuid, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { isNull } from 'drizzle-orm';
export const localOutbox = pgTable('local_outbox', {
    seq: bigserial('seq', { mode: 'bigint' }).primaryKey(),
    kind: text('kind', { enum: ['event', 'mutation'] }).notNull(),
    endpoint: text('endpoint').notNull(),
    payload: jsonb('payload').notNull(),
    idempotency_key: uuid('idempotency_key').notNull(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' })
        .notNull()
        .defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    last_error: text('last_error'),
    flushed_at: timestamp('flushed_at', { withTimezone: true, mode: 'string' }),
}, (t) => ({
    pendingIdx: index('lo_pending_idx').on(t.created_at).where(isNull(t.flushed_at)),
}));
//# sourceMappingURL=local-outbox.js.map