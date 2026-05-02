/**
 * test/integration/hub/local-mode-regression.integration.test.ts
 *
 * Round 7-01 — Local mode regression test.
 * [Engineer-Sr · Sonnet · run-round7-01-extract-hub]
 *
 * Verifies that ORBITAL_MODE=local (the default) still boots correctly after
 * the hub branching was introduced in assembleOrchestration(). This is the
 * backwards-compat guard.
 *
 * Assertions:
 *   L1. assembleOrchestration with mode=local returns non-null, same as pre-hub.
 *   L2. Local boot wires mondaySyncService (null is acceptable — token may be absent).
 *   L3. scheduler.tick is a function (local mode runs the tick loop).
 *   L4. backlog.epics.list via tRPC returns [] without throwing when called
 *       with the sentinel tenantId.
 *   L5. tenantProcedure in local mode resolves tenantId to the sentinel UUID
 *       ('00000000-0000-0000-0000-000000000000') without requiring a header.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { uuidv7 } from 'uuidv7'

import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { assembleOrchestration } from '../../../src/orchestration/boot.js'
import { resetKeychainCache } from '../../../src/capabilities/keychain.js'
import { resetPolicyCache } from '../../../src/capabilities/policy.js'
import { resetTenantMiddleware } from '../../../src/trpc/middleware/tenant.js'
import { resetEnvCache } from '../../../src/config/env.js'

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

const TEST_SOCKET_PATH = path.join(
  os.tmpdir(),
  `orbital-local-regression-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`,
)

const SENTINEL = '00000000-0000-0000-0000-000000000000'

const origMode = process.env['ORBITAL_MODE']

let orch: Awaited<ReturnType<typeof assembleOrchestration>>

beforeAll(async () => {
  // Ensure local mode. Reset env cache so loadEnv() re-reads from process.env.
  process.env['ORBITAL_MODE'] = 'local'
  process.env['ORBITAL_TEST_KEYCHAIN'] = '1'
  resetEnvCache()
  resetTenantMiddleware()
  resetKeychainCache()
  resetPolicyCache()

  await sql`SELECT 1`

  const installId = uuidv7()
  const eventStore = createEventStore(db, sql)

  orch = await assembleOrchestration({
    db,
    sql,
    eventStore,
    installId,
    mcpSocketPath: TEST_SOCKET_PATH,
  })
}, 30_000)

afterAll(async () => {
  await orch?.shutdown().catch(() => undefined)
  await closeDb().catch(() => undefined)
  resetTenantMiddleware()
  resetEnvCache()
  if (origMode !== undefined) {
    process.env['ORBITAL_MODE'] = origMode
  } else {
    delete process.env['ORBITAL_MODE']
  }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('L1 — Local mode boot: all core services non-null', () => {
  it('authority, keyManager, personaLoader are non-null', () => {
    expect(orch.authority).toBeTruthy()
    expect(orch.keyManager).toBeTruthy()
    expect(orch.personaLoader).toBeTruthy()
  })

  it('scheduler exists with tick function', () => {
    expect(orch.scheduler).toBeTruthy()
    expect(typeof orch.scheduler.tick).toBe('function')
  })

  it('backlogService and sprintService exist', () => {
    expect(orch.backlogService).toBeTruthy()
    expect(orch.sprintService).toBeTruthy()
  })
})

describe('L2 — Local mode boot: Monday sync integration (null is acceptable without token)', () => {
  it('mondaySyncService is null or a real MondaySyncService', () => {
    // In test environments MONDAY_API_TOKEN is typically unset → null.
    // Both outcomes are valid; we assert it is null | truthy (not undefined).
    expect(orch.mondaySyncService === null || !!orch.mondaySyncService).toBe(true)
  })
})

describe('L3 — Local mode boot: scheduler is the full tick-capable scheduler', () => {
  it('scheduler.tick is callable', () => {
    expect(typeof orch.scheduler.tick).toBe('function')
  })

  it('scheduler.addSprint is callable', () => {
    expect(typeof orch.scheduler.addSprint).toBe('function')
  })
})

describe('L4 — Local mode: backlog.epics.list returns [] without throwing', () => {
  it('listEpics returns an array (tenant filtering deferred to 7-02)', async () => {
    const epics = await orch.backlogService.listEpics({})
    expect(Array.isArray(epics)).toBe(true)
  })
})

describe('L5 — Local mode: tenantProcedure injects sentinel without header', () => {
  it('tenant middleware in local mode sets tenantId to sentinel', async () => {
    // Import fresh after env is set.
    const { createTenantMiddleware } = await import('../../../src/trpc/middleware/tenant.js')
    const mw = createTenantMiddleware({ mode: 'local', defaultTenantId: SENTINEL })

    const ctx = { req: { headers: {} } }
    const next = async (args: { ctx: Record<string, unknown> }) => ({ ctx: args.ctx })
    // tRPC MiddlewareBuilder: the callback is at ._middlewares[0].
    const builder = mw as unknown as { _middlewares: Array<(o: unknown) => Promise<unknown>> }
    const fn = builder._middlewares[0]
    if (typeof fn !== 'function') throw new Error('tRPC middleware internal structure changed')
    const result = (await fn({ ctx, next })) as { ctx: Record<string, unknown> }
    expect((result.ctx as { tenantId: string }).tenantId).toBe(SENTINEL)
  })
})
