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
import type { DB } from '../db/client.js';
/** TTL for cached idempotency entries (24h). */
export declare const IDEMPOTENCY_TTL_MS: number;
export interface IdempotencyDeps {
    /** DB used for the cache reads/writes. */
    db: DB;
}
interface CachedEntry {
    status: 'success' | 'error';
    result: unknown;
}
/**
 * Pull the Idempotency-Key header from the request. Header name matching is
 * case-insensitive per RFC 9110 §5.1; fastify lower-cases header keys.
 */
export declare function readIdempotencyKey(ctx: unknown): string | null;
export declare function readCached(db: DB, idempotencyKey: string, route: string): Promise<CachedEntry | null>;
export declare function writeCached(db: DB, idempotencyKey: string, route: string, status: 'success' | 'error', responseJson: unknown): Promise<void>;
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
export declare function createIdempotencyMiddleware(deps: IdempotencyDeps): (opts: {
    ctx: unknown;
    type: string;
    path: string;
    next: (params?: unknown) => Promise<unknown>;
}) => Promise<unknown>;
export {};
//# sourceMappingURL=idempotency.d.ts.map