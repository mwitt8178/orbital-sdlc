/**
 * test/unit/trpc/middleware/tenant.test.ts
 *
 * Round 7-01 — Unit tests for the tenant resolution middleware.
 * [Engineer-Sr · Sonnet · run-round7-01-extract-hub]
 *
 * Strategy:
 *   - The middleware is built via tRPC's `t.middleware()`, which returns a
 *     MiddlewareBuilder with an internal `_fn` callable field.
 *   - We call `(mw as any)._fn(opts)` to exercise the logic directly without
 *     needing a full tRPC procedure stack.
 *   - No DB, no network, no child processes.
 *
 * Assertions:
 *   1. Local mode injects the defaultTenantId sentinel into ctx.
 *   2. Hub mode reads X-Orbital-Tenant-ID header and injects ctx.tenantId.
 *   3. Hub mode — missing header → TRPCError UNAUTHORIZED.
 *   4. Hub mode — malformed UUID header → TRPCError BAD_REQUEST.
 *   5. Hub mode — array header uses first element.
 *   6. Sentinel UUID passes UUID regex in hub mode.
 *   7. getTenantMiddleware() returns same instance on repeated calls (singleton).
 *   8. resetTenantMiddleware() clears the singleton so next call re-reads env.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { TRPCError } from '@trpc/server'
import {
  createTenantMiddleware,
  getTenantMiddleware,
  resetTenantMiddleware,
  TENANT_ID_HEADER,
} from '../../../../src/trpc/middleware/tenant.js'
import { resetEnvCache } from '../../../../src/config/env.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SENTINEL = '00000000-0000-0000-0000-000000000000'
const VALID_TENANT = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'

/**
 * Build a synthetic tRPC middleware opts object and invoke the middleware.
 * tRPC's `t.middleware()` returns a MiddlewareBuilder with `_middlewares[0]`
 * as the underlying async function. We call that directly to unit-test logic
 * without needing a full tRPC procedure stack.
 */
async function invoke(
  mw: ReturnType<typeof createTenantMiddleware>,
  headerValue: string | string[] | undefined = undefined,
): Promise<{ ctx: Record<string, unknown> }> {
  const headers: Record<string, unknown> = {}
  if (headerValue !== undefined) {
    headers[TENANT_ID_HEADER] = headerValue
  }
  const ctx = { req: { headers } }
  const next = async (args: { ctx: Record<string, unknown> }) => ({ ctx: args.ctx })
  // tRPC MiddlewareBuilder stores the callback at ._middlewares[0].
  const builder = mw as unknown as { _middlewares: Array<(opts: unknown) => Promise<unknown>> }
  const fn = builder._middlewares[0]
  if (typeof fn !== 'function') {
    throw new Error('tRPC middleware internal structure changed — _middlewares[0] is not a function')
  }
  return fn({ ctx, next }) as Promise<{ ctx: Record<string, unknown> }>
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createTenantMiddleware — local mode', () => {
  it('T1: injects defaultTenantId sentinel when no header present', async () => {
    const mw = createTenantMiddleware({ mode: 'local', defaultTenantId: SENTINEL })
    const result = await invoke(mw)
    expect((result.ctx as { tenantId: string }).tenantId).toBe(SENTINEL)
  })

  it('T2: injects custom defaultTenantId in local mode (ignores any header)', async () => {
    const customTenant = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
    const mw = createTenantMiddleware({ mode: 'local', defaultTenantId: customTenant })
    // Even with a header present, local mode must ignore it.
    const result = await invoke(mw, VALID_TENANT)
    expect((result.ctx as { tenantId: string }).tenantId).toBe(customTenant)
  })
})

describe('createTenantMiddleware — hub mode', () => {
  it('T3: reads header and injects ctx.tenantId', async () => {
    const mw = createTenantMiddleware({ mode: 'hub', defaultTenantId: SENTINEL })
    const result = await invoke(mw, VALID_TENANT)
    expect((result.ctx as { tenantId: string }).tenantId).toBe(VALID_TENANT)
  })

  it('T4: missing header → TRPCError UNAUTHORIZED', async () => {
    const mw = createTenantMiddleware({ mode: 'hub', defaultTenantId: SENTINEL })
    await expect(invoke(mw, undefined)).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('T5: empty string header → TRPCError UNAUTHORIZED', async () => {
    const mw = createTenantMiddleware({ mode: 'hub', defaultTenantId: SENTINEL })
    await expect(invoke(mw, '   ')).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('T6: malformed UUID header → TRPCError BAD_REQUEST', async () => {
    const mw = createTenantMiddleware({ mode: 'hub', defaultTenantId: SENTINEL })
    await expect(invoke(mw, 'not-a-uuid')).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('T7: array header uses first element', async () => {
    const mw = createTenantMiddleware({ mode: 'hub', defaultTenantId: SENTINEL })
    const result = await invoke(mw, [VALID_TENANT, 'other'])
    expect((result.ctx as { tenantId: string }).tenantId).toBe(VALID_TENANT)
  })

  it('T8: sentinel UUID is a valid UUID and passes hub mode regex', async () => {
    const mw = createTenantMiddleware({ mode: 'hub', defaultTenantId: SENTINEL })
    const result = await invoke(mw, SENTINEL)
    expect((result.ctx as { tenantId: string }).tenantId).toBe(SENTINEL)
  })

  it('T9: TRPCError thrown is a real TRPCError instance', async () => {
    const mw = createTenantMiddleware({ mode: 'hub', defaultTenantId: SENTINEL })
    let caught: unknown
    try {
      await invoke(mw, undefined)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(TRPCError)
  })
})

describe('getTenantMiddleware / resetTenantMiddleware — singleton lifecycle', () => {
  const origMode = process.env['ORBITAL_MODE']
  const origTenantId = process.env['ORBITAL_HUB_TENANT_ID']

  beforeEach(() => {
    resetTenantMiddleware()
    resetEnvCache()
  })

  afterEach(() => {
    resetTenantMiddleware()
    resetEnvCache()
    // Restore env so other tests are unaffected.
    if (origMode !== undefined) {
      process.env['ORBITAL_MODE'] = origMode
    } else {
      delete process.env['ORBITAL_MODE']
    }
    if (origTenantId !== undefined) {
      process.env['ORBITAL_HUB_TENANT_ID'] = origTenantId
    } else {
      delete process.env['ORBITAL_HUB_TENANT_ID']
    }
  })

  it('T10: returns same instance on repeated calls before reset', () => {
    process.env['ORBITAL_MODE'] = 'local'
    const a = getTenantMiddleware()
    const b = getTenantMiddleware()
    expect(a).toBe(b)
  })

  it('T11: after reset, next call creates a fresh instance', () => {
    process.env['ORBITAL_MODE'] = 'local'
    const a = getTenantMiddleware()
    resetTenantMiddleware()
    const b = getTenantMiddleware()
    // Different builder object after reset.
    expect(a).not.toBe(b)
  })

  it('T12: re-reads mode from env after reset — hub mode respected', async () => {
    process.env['ORBITAL_MODE'] = 'hub'
    process.env['ORBITAL_HUB_TENANT_ID'] = SENTINEL
    const mw = getTenantMiddleware()
    // Hub mode: missing header should throw UNAUTHORIZED.
    await expect(invoke(mw, undefined)).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('T13: re-reads mode from env after reset — local mode injects sentinel', async () => {
    process.env['ORBITAL_MODE'] = 'local'
    process.env['ORBITAL_HUB_TENANT_ID'] = SENTINEL
    const mw = getTenantMiddleware()
    const result = await invoke(mw, undefined)
    expect((result.ctx as { tenantId: string }).tenantId).toBe(SENTINEL)
  })
})
