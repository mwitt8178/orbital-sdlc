/**
 * trpc/middleware/auth.ts — tRPC middleware that validates a signed envelope
 * and injects { installId, tenantId, role } into the procedure context.
 *
 * Round 7-03 — Federation Auth (Identity & Pairing)
 * [Engineer-Principal · Opus · run-round7-03-federation-auth]
 *
 * Wraps publicProcedure with envelope verification. Procedures that need
 * an authenticated install identity should use `installProcedure` (exported
 * here) instead of `publicProcedure` or `tenantProcedure`. The new
 * procedure ALSO injects ctx.tenantId from the install's known_installs row,
 * which means it supersedes tenantProcedure for hub-mode auth-required calls.
 *
 * Why a custom procedure rather than a generic middleware?
 *   - tRPC's HTTP adapter doesn't natively expose the raw request body bytes
 *     to procedures. The auth check needs to compute sha256(body) for
 *     params_hash verification. We capture the raw body in the Fastify
 *     pre-parse hook (registered in src/index.ts) and stash it on req.
 *   - In hub mode this middleware MUST be on every authenticated procedure.
 *     The "default" should be authentication required; ergonomically, we
 *     export `installProcedure` so router authors flip a single import.
 *
 * Hard-codes the relevant wire codes:
 *   AUTH_HEADER_MISSING / AUTH_SIG_INVALID / AUTH_TS_EXPIRED / AUTH_REPLAY /
 *   AUTH_BODY_MALFORMED / AUTH_PARAMS_MISMATCH / INSTALL_UNKNOWN / INSTALL_REVOKED
 */

import { TRPCError } from '@trpc/server'
import { publicProcedure, middleware } from '../init.js'
import {
  verifyRequest,
  type AuthMiddlewareErrorCode,
} from '../../hub/auth/middleware.js'
import { loadEnv } from '../../config/env.js'
import { logger } from '../../config/logger.js'

// ---------------------------------------------------------------------------
// Augmented context
// ---------------------------------------------------------------------------

export interface InstallContext {
  installId: string
  tenantId: string
  role: 'owner' | 'member' | 'viewer'
  displayName: string | null
}

// ---------------------------------------------------------------------------
// Map wire code → tRPC error code
// ---------------------------------------------------------------------------

function trpcCodeFor(_code: AuthMiddlewareErrorCode): TRPCError['code'] {
  // tRPC codes are limited (UNAUTHORIZED / FORBIDDEN / BAD_REQUEST etc.). We
  // surface UNAUTHORIZED for everything 401-shaped; the client reads
  // err.data?.code (set via `cause`) to discriminate replay vs. expired etc.
  return 'UNAUTHORIZED'
}

// ---------------------------------------------------------------------------
// Body-bytes extractor
// ---------------------------------------------------------------------------

/**
 * Pull the raw request body bytes off the Fastify request. We register a
 * pre-parsing hook in src/index.ts (Round 7-03) that copies the buffer onto
 * req.rawBody. If the hook didn't run (e.g. local-mode tests not going
 * through Fastify), we fall back to an empty buffer — the params_hash check
 * will still pass for empty-body requests.
 */
function extractRawBodyBytes(req: unknown): Uint8Array {
  if (typeof req !== 'object' || req === null) return new Uint8Array(0)
  const obj = req as Record<string, unknown>
  const raw = obj['rawBody']
  if (raw instanceof Uint8Array) return raw
  if (Buffer.isBuffer(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
  if (typeof raw === 'string') return new TextEncoder().encode(raw)
  return new Uint8Array(0)
}

function extractHeaders(req: unknown): Record<string, string | string[] | undefined> {
  if (typeof req !== 'object' || req === null) return {}
  const headers = (req as { headers?: Record<string, string | string[] | undefined> }).headers
  return headers ?? {}
}

// ---------------------------------------------------------------------------
// installMiddleware — the actual tRPC middleware
// ---------------------------------------------------------------------------

export const installMiddleware = middleware(async ({ ctx, next }) => {
  const env = loadEnv()

  // In local mode, there is no hub auth — fall through with a sentinel
  // identity so local-only procedures keep working. The hub-mode check
  // is enforced when ORBITAL_MODE=hub.
  if (env.ORBITAL_MODE !== 'hub') {
    return next({
      ctx: {
        ...ctx,
        installId: '00000000-0000-0000-0000-000000000000',
        tenantId: env.ORBITAL_HUB_TENANT_ID,
        role: 'owner' as const,
        displayName: null,
      },
    })
  }

  const headers = extractHeaders(ctx.req)
  const rawBody = extractRawBodyBytes(ctx.req)

  const result = await verifyRequest({
    headers,
    requestBodyBytes: rawBody,
  })

  if (!result.ok) {
    logger.warn(
      { code: result.code, detail: result.detail },
      'auth-middleware: request rejected',
    )
    throw new TRPCError({
      code: trpcCodeFor(result.code),
      message: `${result.code}: ${result.detail}`,
      cause: { code: result.code },
    })
  }

  const { identity } = result
  return next({
    ctx: {
      ...ctx,
      installId: identity.installId,
      tenantId: identity.tenantId,
      role: identity.role,
      displayName: identity.displayName,
    },
  })
})

// ---------------------------------------------------------------------------
// installProcedure — opt-in procedure for routers that need install identity
// ---------------------------------------------------------------------------

/**
 * Use this in place of publicProcedure (or tenantProcedure) on procedures
 * that should only be reachable from a paired install. The procedure ctx
 * will carry { installId, tenantId, role, displayName }.
 */
export const installProcedure = publicProcedure.use(installMiddleware)
