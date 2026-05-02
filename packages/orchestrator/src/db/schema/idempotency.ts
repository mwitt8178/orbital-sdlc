/**
 * Drizzle schema for the audit.mutation_idempotency table.
 *
 * Round 3 Security Hardening — Gap S5 (idempotent tRPC mutations).
 *
 * Stores the cached response for a (idempotency_key, route) pair so that a
 * client retry of a timed-out mutation returns the original response (or
 * original error) rather than re-executing the mutation and producing
 * duplicate domain events.
 *
 * Constraints (DSQL hard-no list, see CLAUDE.md):
 *   - No FK to other tables.
 *   - No trigger.
 *   - No SERIAL — composite PK is application-supplied text.
 *   - No materialized view.
 *
 * TTL is enforced at read time (`expires_at > now()`); a periodic cleanup is
 * a future ops task — stale rows are functionally inert because the read
 * predicate excludes them.
 */

import { text, jsonb, timestamp, primaryKey, index } from 'drizzle-orm/pg-core'
import { audit } from './audit.js'

export const mutationIdempotency = audit.table(
  'mutation_idempotency',
  {
    /** Client-supplied Idempotency-Key header (UUIDv7 or any random string ≤256 chars). */
    idempotencyKey: text('idempotency_key').notNull(),
    /** tRPC route path, e.g. 'sprint.start' or 'backlog.epics.create'. */
    route: text('route').notNull(),
    /**
     * Outcome of the original call. 'success' or 'error' — both are cached so
     * a retry of a deterministically-failing mutation returns the original
     * error envelope rather than re-running and possibly succeeding twice.
     */
    status: text('status').notNull(),
    /**
     * Cached response. For success: the original tRPC result JSON. For error:
     * the canonical Primitives §10 error envelope.
     */
    responseJson: jsonb('response_json').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.idempotencyKey, t.route] }),
    expiresIdx: index('mutation_idempotency_expires_at').on(t.expiresAt),
  }),
)

export type MutationIdempotencyRow = typeof mutationIdempotency.$inferSelect
export type MutationIdempotencyInsert = typeof mutationIdempotency.$inferInsert
