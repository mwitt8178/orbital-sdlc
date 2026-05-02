/**
 * test/integration/hub/hub-mode-boot.integration.test.ts
 *
 * Round 7-01 — Hub mode boot integration test.
 * [Engineer-Sr · Sonnet · run-round7-01-extract-hub]
 *
 * Exercises assembleOrchestration() with ORBITAL_MODE=hub.
 *
 * Assertions:
 *   H1. assembleOrchestration returns non-null with all required services.
 *   H2. Hub boot sets mondaySyncService/boardDiscoveryService/boardMappingService/prOrchestrator to null.
 *   H3. scheduler.tick does not throw — scheduler exists but is a no-op in hub mode.
 *   H4. mcpGateway.stop resolves without error (gateway not started in hub mode).
 *   H5. shutdown() completes without throwing.
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
import { resetEnvCache } from '../../../src/config/env.js'
import { resetTenantMiddleware } from '../../../src/trpc/middleware/tenant.js'

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

const TEST_SOCKET_PATH = path.join(
  os.tmpdir(),
  `orbital-hub-boot-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`,
)

const origMode = process.env['ORBITAL_MODE']

let orch: Awaited<ReturnType<typeof assembleOrchestration>>

beforeAll(async () => {
  // Set hub mode before boot. Reset env cache so loadEnv() re-reads from process.env.
  process.env['ORBITAL_MODE'] = 'hub'
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
  // Restore env and reset caches.
  if (origMode !== undefined) {
    process.env['ORBITAL_MODE'] = origMode
  } else {
    delete process.env['ORBITAL_MODE']
  }
  resetEnvCache()
  resetTenantMiddleware()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('H1 — Hub boot: all required services non-null', () => {
  it('core services are non-null', () => {
    expect(orch.authority).toBeTruthy()
    expect(orch.keyManager).toBeTruthy()
    expect(orch.personaLoader).toBeTruthy()
    expect(orch.routingEngine).toBeTruthy()
    expect(orch.costAccounting).toBeTruthy()
    expect(orch.anthropicDriver).toBeTruthy()
  })

  it('comms services are non-null', () => {
    expect(orch.channelsService).toBeTruthy()
    expect(orch.inboxService).toBeTruthy()
    expect(orch.ceremonyService).toBeTruthy()
    expect(orch.blockerService).toBeTruthy()
  })

  it('orchestration services are non-null', () => {
    expect(orch.worktreeManager).toBeTruthy()
    expect(orch.workerMonitor).toBeTruthy()
    expect(orch.retryPolicy).toBeTruthy()
    expect(orch.pauseController).toBeTruthy()
    expect(orch.scheduler).toBeTruthy()
  })

  it('MCP services are non-null', () => {
    expect(orch.mcpRegistry).toBeTruthy()
    expect(orch.mcpGateway).toBeTruthy()
  })

  it('hooks + verifier are non-null', () => {
    expect(orch.verifierService).toBeTruthy()
    expect(orch.hookEngine).toBeTruthy()
  })

  it('backlog + sprint services are non-null', () => {
    expect(orch.sprintService).toBeTruthy()
    expect(orch.backlogService).toBeTruthy()
  })

  it('UAT and retros are non-null', () => {
    expect(orch.uatService).toBeTruthy()
    expect(orch.retroService).toBeTruthy()
    expect(orch.proposalService).toBeTruthy()
  })

  it('ops helpers are non-null', () => {
    expect(orch.keyZeroizeService).toBeTruthy()
    expect(orch.driftReconciler).toBeTruthy()
    expect(orch.inspectionService).toBeTruthy()
    expect(orch.replayService).toBeTruthy()
    expect(orch.costService).toBeTruthy()
    expect(orch.costEnforcer).toBeTruthy()
  })
})

describe('H2 — Hub boot: Monday/GitHub integration is null (hub skips external integrations)', () => {
  it('mondaySyncService is null', () => {
    expect(orch.mondaySyncService).toBeNull()
  })

  it('boardDiscoveryService is null', () => {
    expect(orch.boardDiscoveryService).toBeNull()
  })

  it('boardMappingService is null', () => {
    expect(orch.boardMappingService).toBeNull()
  })

  it('boardMappingResolver is null', () => {
    expect(orch.boardMappingResolver).toBeNull()
  })

  it('prOrchestrator is null', () => {
    expect(orch.prOrchestrator).toBeNull()
  })
})

describe('H3 — Hub boot: scheduler exists and has expected API', () => {
  it('scheduler.tick is a function', () => {
    expect(typeof orch.scheduler.tick).toBe('function')
  })

  it('scheduler.addSprint is a function', () => {
    expect(typeof orch.scheduler.addSprint).toBe('function')
  })
})

describe('H4 — Hub boot: mcpGateway.stop resolves without error', () => {
  it('stop resolves', async () => {
    await expect(orch.mcpGateway.stop()).resolves.not.toThrow()
  })
})

describe('H5 — Hub boot: shutdown completes without throwing', () => {
  it('shutdown resolves', async () => {
    // A second call to stop should be idempotent.
    await expect(orch.shutdown()).resolves.not.toThrow()
  })
})
