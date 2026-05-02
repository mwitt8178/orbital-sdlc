/**
 * idempotency.ts — tRPC middleware for idempotent mutations.
 *
 * Round 3 Security Hardening — Gap S5.
 *
 * Reads the `Idempotency-Key` header from the inbound HTTP request. If
 * present, the middleware:
 *   1. Looks up `(idempotency_key, route_path)` in `audit.mutation_idempotency`.
 *   2. If a non-expired row exists, returns the cached result (success or
 *      error) WITHOUT re-running the mutation. The original mutation's
 *      side effects (event appends, etc.) are NOT replayed.
 *   3. If no row exists, runs the mutation. On success, persists the
 *      result keyed by (idempotency_key, route_path) with a 24h TTL via
 *      `INSERT ... ON CONFLICT DO NOTHING` so concurrent retries collapse.
 *      On error, persists the error envelope so a deterministically-failing
 *      mutation returns the original error rather than re-running.
 *
 * Storage choice: a small DB table (vs. an LRU in-memory cache) so retries
 * survive process restarts. The table is auto-pruned at read time via
 * `expires_at > now()`. Periodic cleanup is a future ops task.
 *
 * Failure mode: if the DB is unreachable when reading the cache, we FAIL OPEN
 * — log a warning and run the mutation. We'd rather process a possibly-
 * duplicate mutation than reject all writes when the cache is degraded. The
 * write path also tolerates failure (insert errors are logged).
 *
 * Wiring: `trpc/init.ts` exports `idempotentProcedure` which wraps
 * `publicProcedure` with this middleware. Routers opt in by importing
 * `idempotentProcedure` instead of `publicProcedure` for mutations.
 */

import { TRPCError } from '@trpc/server'
import { middlewareMarker } from '@trpc/server/unstable-core-do-not-import'
import { sql as drizzleSql } from 'drizzle-orm'
import type { DB } from '../db/client.js'
import { mutationIdempotency } from '../db/schema/idempotency.js'
import { logger } from '../config/logger.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** TTL for cached idempotency entries (24h). */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000

export interface IdempotencyDeps {
  /** DB used for the cache reads/writes. */
  db: DB
}

interface RequestLike {
  headers?: Record<string, unknown>
}

interface ContextLike {
  req?: RequestLike
}

interface CachedEntry {
  status: 'success' | 'error'
  result: unknown
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Pull the Idempotency-Key header from the request. Header name matching is
 * case-insensitive per RFC 9110 §5.1; fastify lower-cases header keys.
 */
export function readIdempotencyKey(ctx: unknown): string | null {
  const headers = (ctx as ContextLike | undefined)?.req?.headers
  if (!headers) return null
  const raw =
    headers['idempotency-key'] ??
    headers['Idempotency-Key'] ??
    headers['IDEMPOTENCY-KEY']
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed.length > 256) return null
  return trimmed
}

/** Quote a JSON value for inline embedding into a Postgres jsonb literal. */
function jsonbLiteral(value: unknown): string {
  return JSON.stringify(value).replace(/'/g, "''")
}

// ---------------------------------------------------------------------------
// Read / write helpers (exported for tests)
// ---------------------------------------------------------------------------

export async function readCached(
  db: DB,
  idempotencyKey: string,
  route: string,
): Promise<CachedEntry | null> {
  try {
    const rows = await db.execute<{
      status: string
      response_json: unknown
    }>(
      drizzleSql`
        SELECT status, response_json
        FROM ${mutationIdempotency}
        WHERE idempotency_key = ${idempotencyKey}
          AND route = ${route}
          AND expires_at > now()
        LIMIT 1
      `,
    )
    const row = rows[0]
    if (!row) return null
    return {
      status: row.status === 'error' ? 'error' : 'success',
      result: row.response_json,
    }
  } catch (err) {
    logger.warn(
      { err, route, idempotencyKey },
      'idempotency: cache read failed; proceeding to run mutation',
    )
    return null
  }
}

export async function writeCached(
  db: DB,
  idempotencyKey: string,
  route: string,
  status: 'success' | 'error',
  responseJson: unknown,
): Promise<void> {
  const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL_MS).toISOString()
  try {
    await db.execute(
      drizzleSql`
        INSERT INTO ${mutationIdempotency}
          (idempotency_key, route, status, response_json, created_at, expires_at)
        VALUES
          (${idempotencyKey}, ${route}, ${status}, ${drizzleSql.raw(`'${jsonbLiteral(responseJson)}'::jsonb`)}, now(), ${expiresAt})
        ON CONFLICT (idempotency_key, route) DO NOTHING
      `,
    )
  } catch (err) {
    logger.warn(
      { err, route, idempotencyKey, status },
      'idempotency: cache write failed; mutation already executed',
    )
  }
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Build a tRPC middleware function (compatible with `t.middleware(...)`) that
 * enforces idempotency on mutations.
 *
 * Usage (in trpc/init.ts):
 * ```ts
 * import { createIdempotencyMiddleware } from '../middleware/idempotency.js'
 * import { db } from '../db/client.js'
 *
 * export const idempotentProcedure = t.procedure.use(
 *   t.middleware(createIdempotencyMiddleware({ db })),
 * )
 * ```
 *
 * Routers opt-in per mutation:
 * ```ts
 * import { idempotentProcedure } from '../init.js'
 *
 * router({
 *   create: idempotentProcedure.input(...).mutation(...),
 * })
 * ```
 */
export function createIdempotencyMiddleware(deps: IdempotencyDeps) {
  const { db } = deps

  // The function signature is intentionally loose so it satisfies tRPC's
  // generic middleware factory. Inside, we pass through to next() and either
  // return its result or replace it with a cached envelope.
  return async function idempotencyMiddleware(opts: {
    ctx: unknown
    type: string
    path: string
    next: (params?: unknown) => Promise<unknown>
  }): Promise<unknown> {
    if (opts.type !== 'mutation') {
      return opts.next()
    }

    const key = readIdempotencyKey(opts.ctx)
    if (!key) {
      return opts.next()
    }

    const route = opts.path
    const cached = await readCached(db, key, route)

    if (cached) {
      logger.debug(
        { route, idempotencyKey: key, status: cached.status },
        'idempotency: returning cached response',
      )
      if (cached.status === 'error') {
        const errPayload = cached.result as { code?: string; message?: string }
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: errPayload?.message ?? 'cached error',
          cause: cached.result,
        })
      }
      // Synthesise a tRPC middleware OK envelope. Shape matches
      // MiddlewareOKResult in @trpc/server (ok: true, data, marker).
      return {
        ok: true as const,
        data: cached.result,
        marker: middlewareMarker,
      }
    }

    const next = (await opts.next()) as
      | { ok: true; data: unknown; marker: unknown }
      | { ok: false; error: TRPCError; marker: unknown }

    if (next.ok) {
      await writeCached(db, key, route, 'success', next.data)
      return next
    }

    // Error path — cache the error so retries see the original failure.
    const err = next.error
    const errEnvelope =
      err instanceof TRPCError
        ? { code: err.code, message: err.message }
        : { code: 'INTERNAL_SERVER_ERROR', message: String(err) }
    await writeCached(db, key, route, 'error', errEnvelope)
    return next
  }
}

