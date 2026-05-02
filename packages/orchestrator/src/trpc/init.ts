/**
 * trpc/init.ts — tRPC bootstrap.
 *
 * Per Implementation Plan §6 Task 2C and SAO §5.8.
 *
 * Exports the shared tRPC primitives consumed by every router under
 * src/trpc/routers/. We intentionally use the default context (empty record);
 * authentication and capability checks happen at the MCP gateway layer for
 * agent traffic, and at the Fastify middleware layer for UI traffic.
 *
 * Round 3 S5 — idempotentProcedure
 * --------------------------------
 * `idempotentProcedure` wraps `publicProcedure` with the idempotency
 * middleware (see middleware/idempotency.ts). Mutations defined with this
 * procedure honour the `Idempotency-Key` HTTP header: a retry of the same
 * mutation with the same key returns the original result (or original error)
 * without re-executing the handler. Adoption is opt-in per mutation — switch
 * `publicProcedure.mutation(...)` to `idempotentProcedure.mutation(...)` in
 * any router that wants the guarantee.
 *
 * `publicProcedure` is unchanged so existing routers continue to work.
 */

import { initTRPC } from '@trpc/server'
import { db } from '../db/client.js'
import { createIdempotencyMiddleware } from '../middleware/idempotency.js'

/**
 * tRPC request-bound context. Exported so router return types can name it.
 * The tRPC Fastify adapter sets `req` on the context (we wire `createContext`
 * in `src/index.ts` to forward `req.headers`). All other layers use the
 * default empty record semantics — the field is optional.
 *
 * Round 7-01 — tenantId is injected by the tenant middleware (tenant.ts).
 * It is optional at the base context level; after the tenant middleware runs
 * it is always a string. Procedures that require tenant scoping should use
 * `tenantProcedure` from `trpc/middleware/tenant.ts`.
 * [Engineer-Sr · Sonnet · run-round7-01-extract-hub]
 */
export interface ReqContext {
  /** Inbound HTTP request headers (Fastify). */
  req?: { headers?: Record<string, unknown> }
  /**
   * Resolved tenant ID — populated by the tenant middleware.
   * Always a UUID string after tenant middleware runs.
   * In local mode: '00000000-0000-0000-0000-000000000000' (sentinel).
   * In hub mode: from X-Orbital-Tenant-ID header.
   */
  tenantId?: string
}

export const t = initTRPC.context<ReqContext>().create()

export const publicProcedure = t.procedure
export const router = t.router
export const middleware = t.middleware

/**
 * Wraps publicProcedure with the idempotency middleware. Use this for
 * mutations where a retry must not produce duplicate side effects.
 *
 * The middleware factory uses an intentionally loose `next` signature
 * (per its own JSDoc, "intentionally loose so it satisfies tRPC's generic
 * middleware factory"). We bridge that loose function shape to the strict
 * `MiddlewareFunction<...>` typings via a typed bridge that preserves the
 * runtime behavior verbatim.
 */
const idempotencyImpl = createIdempotencyMiddleware({ db })
export const idempotentProcedure = t.procedure.use(
  middleware(async ({ ctx, type, path, next }) => {
    return (await idempotencyImpl({
      ctx,
      type,
      path,
      next: () => next() as Promise<unknown>,
    })) as Awaited<ReturnType<typeof next>>
  }),
)
