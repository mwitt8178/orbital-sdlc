/**
 * trpc/middleware/tenant.ts — Tenant resolution middleware.
 *
 * Round 7-01 — Extract Orchestrator Core Into Deployable Hub Service
 * [Engineer-Sr · Sonnet · run-round7-01-extract-hub]
 *
 * In 'hub' mode:
 *   Reads X-Orbital-Tenant-ID from the inbound HTTP request headers.
 *   If absent, returns HTTP 401 (UNAUTHORIZED). Hub mode requires explicit
 *   tenant scoping on every request.
 *
 * In 'local' mode:
 *   Injects the per-install tenant ID from ORBITAL_HUB_TENANT_ID env var
 *   (defaults to '00000000-0000-0000-0000-000000000000'). No header required.
 *
 * Usage: wrap publicProcedure with this middleware to get ctx.tenantId.
 *
 * Design:
 *   - Pure function factory: takes { mode, defaultTenantId } → tRPC middleware.
 *   - The created middleware is bound to the tRPC 't' context via t.middleware().
 *   - Downstream procedures access ctx.tenantId (string, always populated).
 *   - No external I/O; can be unit-tested without a DB.
 */

import { TRPCError } from '@trpc/server'
import { middleware } from '../init.js'
import { loadEnv } from '../../config/env.js'

// ---------------------------------------------------------------------------
// Augmented context
// ---------------------------------------------------------------------------

export interface TenantContext {
  /** Resolved tenant ID. Always a UUID string. Never undefined after this middleware runs. */
  tenantId: string
}

// ---------------------------------------------------------------------------
// Header name
// ---------------------------------------------------------------------------

export const TENANT_ID_HEADER = 'x-orbital-tenant-id'

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * createTenantMiddleware — build a tRPC middleware that injects ctx.tenantId.
 *
 * @param options.mode           ORBITAL_MODE value ('local' | 'hub')
 * @param options.defaultTenantId  Fallback for local mode (ORBITAL_HUB_TENANT_ID)
 */
export function createTenantMiddleware(options: {
  mode: 'local' | 'hub'
  defaultTenantId: string
}) {
  const { mode, defaultTenantId } = options

  return middleware(async ({ ctx, next }) => {
    let tenantId: string

    if (mode === 'hub') {
      // Hub mode: require explicit tenant header.
      const raw = ctx.req?.headers?.[TENANT_ID_HEADER]
      const headerValue = Array.isArray(raw) ? raw[0] : raw

      if (typeof headerValue !== 'string' || headerValue.trim() === '') {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message:
            `Missing required header '${TENANT_ID_HEADER}'. ` +
            'Hub mode requires explicit tenant scoping on every request.',
        })
      }

      // Basic UUID format check — guards against injection of junk values.
      const UUID_RE =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      if (!UUID_RE.test(headerValue.trim())) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Header '${TENANT_ID_HEADER}' must be a valid UUID v4/v7.`,
        })
      }

      tenantId = headerValue.trim()
    } else {
      // Local mode: use the per-install default tenant ID.
      tenantId = defaultTenantId
    }

    return next({
      ctx: {
        ...ctx,
        tenantId,
      },
    })
  })
}

// ---------------------------------------------------------------------------
// Singleton instance (loaded from env at first use)
// ---------------------------------------------------------------------------

let _tenantMiddleware: ReturnType<typeof createTenantMiddleware> | null = null

/**
 * getTenantMiddleware — returns the process-singleton tenant middleware instance.
 * Reads ORBITAL_MODE and ORBITAL_HUB_TENANT_ID from env on first call.
 *
 * Exposed so procedures can do:
 *   `publicProcedure.use(getTenantMiddleware()).query(...)`
 */
export function getTenantMiddleware(): ReturnType<typeof createTenantMiddleware> {
  if (_tenantMiddleware !== null) return _tenantMiddleware
  const env = loadEnv()
  _tenantMiddleware = createTenantMiddleware({
    mode: env.ORBITAL_MODE,
    defaultTenantId: env.ORBITAL_HUB_TENANT_ID,
  })
  return _tenantMiddleware
}

/** Reset singleton for tests. */
export function resetTenantMiddleware(): void {
  _tenantMiddleware = null
}

// ---------------------------------------------------------------------------
// tenantProcedure — publicProcedure pre-wrapped with tenant middleware.
// Import this instead of publicProcedure in any router that reads/writes
// tenant-scoped data.
// ---------------------------------------------------------------------------

import { publicProcedure } from '../init.js'

export const tenantProcedure = publicProcedure.use(getTenantMiddleware())
