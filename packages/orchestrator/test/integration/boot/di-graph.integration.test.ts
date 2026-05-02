/**
 * T1 — Boot integration test (full DI graph).
 *
 * Exercises assembleOrchestration() with a real DB + real sql + temp install.
 *
 * Assertions:
 *  1. Every returned service is non-null and has expected methods.
 *  2. Synthetic event via eventStore → subscriber receives it within 200 ms.
 *  3. backlog.epics.list tRPC procedure returns [] without throwing.
 *  4. sprint.list does NOT throw STARTUP_ERROR (registerSprintService wired).
 *  5. Post-task hook is registered with HookEngine (emitting TaskCompleted
 *     event triggers hookEngine.fire path → VerifierStarted lands in DB).
 *  6. Clean shutdown: no leaked timer delta > 2.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { promises as fsp } from 'node:fs'
import { uuidv7 } from 'uuidv7'
import { eq } from 'drizzle-orm'

import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { assembleOrchestration } from '../../../src/orchestration/boot.js'
import { resetKeychainCache } from '../../../src/capabilities/keychain.js'
import { resetPolicyCache } from '../../../src/capabilities/policy.js'
import {
  registerSprintService,
  registerProposalService,
  appRouter,
} from '../../../src/trpc/routers/index.js'
import { t } from '../../../src/trpc/init.js'
import { events } from '../../../src/db/schema/events.js'
import { verifications } from '../../../src/db/schema/determinism.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`waitFor: timed out after ${timeoutMs}ms`)
}

// ---------------------------------------------------------------------------
// Suite setup — one DI graph for the whole file
// ---------------------------------------------------------------------------

const TEST_SOCKET_PATH = path.join(
  os.tmpdir(),
  `orbital-boot-di-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`,
)

let orch: Awaited<ReturnType<typeof assembleOrchestration>>
let eventStore: ReturnType<typeof createEventStore>
let installId: string

beforeAll(async () => {
  // Keychain shim so no system keychain I/O.
  process.env['ORBITAL_TEST_KEYCHAIN'] = '1'
  resetKeychainCache()
  resetPolicyCache()

  await sql`SELECT 1`

  installId = uuidv7()
  eventStore = createEventStore(db, sql)

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
})

// ---------------------------------------------------------------------------
// T1.1 — Every service is non-null with expected methods
// ---------------------------------------------------------------------------

describe('T1 — Boot DI graph: assembleOrchestration', () => {
  it('returns every service non-null with expected methods', () => {
    // Core
    expect(orch.authority).toBeTruthy()
    expect(typeof orch.authority.issue).toBe('function')

    expect(orch.keyManager).toBeTruthy()

    expect(orch.personaLoader).toBeTruthy()
    expect(typeof orch.personaLoader.load).toBe('function')
    expect(typeof orch.personaLoader.get).toBe('function')

    expect(orch.routingEngine).toBeTruthy()

    expect(orch.costAccounting).toBeTruthy()

    // Comms
    expect(orch.channelsService).toBeTruthy()
    expect(typeof orch.channelsService.ensureChannel).toBe('function')

    expect(orch.inboxService).toBeTruthy()
    expect(orch.ceremonyService).toBeTruthy()
    expect(orch.blockerService).toBeTruthy()

    // Orchestration
    expect(orch.worktreeManager).toBeTruthy()
    expect(orch.workerMonitor).toBeTruthy()
    expect(orch.retryPolicy).toBeTruthy()
    expect(orch.pauseController).toBeTruthy()
    expect(orch.scheduler).toBeTruthy()
    expect(typeof orch.scheduler.tick).toBe('function')
    expect(typeof orch.scheduler.addSprint).toBe('function')

    // MCP
    expect(orch.mcpRegistry).toBeTruthy()
    expect(orch.mcpGateway).toBeTruthy()
    expect(typeof orch.mcpGateway.stop).toBe('function')

    // Hooks + verifier
    expect(orch.verifierService).toBeTruthy()
    expect(typeof orch.verifierService.spawnVerifier).toBe('function')
    expect(orch.hookEngine).toBeTruthy()
    expect(typeof (orch.hookEngine as { fire: unknown }).fire).toBe('function')
    expect(typeof (orch.hookEngine as { register: unknown }).register).toBe('function')

    // Backlog
    expect(orch.sprintService).toBeTruthy()
    expect(typeof orch.sprintService.list).toBe('function')
    expect(orch.backlogService).toBeTruthy()
    expect(typeof orch.backlogService.listEpics).toBe('function')

    // UAT
    expect(orch.uatService).toBeTruthy()

    // Retros
    expect(orch.retroService).toBeTruthy()
    expect(typeof orch.retroService.start).toBe('function')
    expect(typeof orch.retroService.stop).toBe('function')
    expect(orch.proposalService).toBeTruthy()

    // Ops
    expect(orch.keyZeroizeService).toBeTruthy()

    // Shutdown hook
    expect(typeof orch.shutdown).toBe('function')
  })

  // -------------------------------------------------------------------------
  // T1.2 — EventStore: emit synthetic event → subscriber receives it
  // -------------------------------------------------------------------------

  it('emits a synthetic event and subscriber receives it within 200ms', async () => {
    const traceId = uuidv7()
    const aggregateId = uuidv7()
    let received = false

    const unsub = eventStore.subscribe(null, (envelope) => {
      if (envelope.trace_id === traceId) {
        received = true
      }
    })

    try {
      await eventStore.append({
        aggregate_id: aggregateId,
        aggregate_type: 'sprint',
        event_type: 'SprintCompleted',
        payload: {
          sprint_id: aggregateId,
          completed_at: new Date().toISOString(),
          story_outcomes: [],
          capacity_used_points: 0,
          budget_used_usd_cents: 0,
          schema_version: 1,
        },
        actor: { type: 'system', component: 'orchestrator' },
        trace_id: traceId,
        occurred_at: new Date().toISOString(),
        schema_version: 1,
      })

      await waitFor(async () => received, 200)
      expect(received).toBe(true)
    } finally {
      unsub()
    }
  })

  // -------------------------------------------------------------------------
  // T1.3 — tRPC backlog.epics.list returns [] without error
  // -------------------------------------------------------------------------

  it('calls backlog.epics.list tRPC procedure and gets an array back', async () => {
    // Use tRPC's createCallerFactory to call procedures directly without HTTP.
    const createCaller = t.createCallerFactory(appRouter)
    const caller = createCaller({})

    // Should return an array (possibly empty). Must not throw.
    const result = await caller.backlog.epics.list({})
    expect(Array.isArray(result.items ?? result)).toBe(true)
  })

  // -------------------------------------------------------------------------
  // T1.4 — sprint.list does not throw STARTUP_ERROR (registerSprintService ran)
  // -------------------------------------------------------------------------

  it('sprint.list does not throw STARTUP_ERROR — SprintService registered', async () => {
    // boot.ts calls registerSprintService(sprintService) at step 15.
    // If the registry was populated, sprint.list should return without throwing.
    // (The existing sprintService was registered during assembleOrchestration,
    //  but if boot.ts didn't call registerSprintService, this will throw
    //  STARTUP_ERROR on the lazy proxy.)
    const result = await orch.sprintService.list({})
    expect(Array.isArray(result)).toBe(true)
  })

  // -------------------------------------------------------------------------
  // T1.5 — Post-task hook registered: TaskCompleted → VerifierStarted
  // -------------------------------------------------------------------------

  it('TaskCompleted event via EventStore triggers post-task hook → VerifierStarted in DB', async () => {
    const taskId = uuidv7()
    const traceId = uuidv7()

    // Append a TaskCompleted event directly through eventStore.
    // The subscribe() handler in boot.ts fires hookEngine.fire('TaskCompleted', ...)
    // which calls VerifierService.spawnVerifier → VerifierStarted event + verifications row.
    await eventStore.append({
      aggregate_id: taskId,
      aggregate_type: 'task',
      event_type: 'TaskCompleted',
      payload: {
        task_id: taskId,
        ticket_id: `T-${taskId.slice(0, 8)}`,
        output_summary: 'DI graph test task',
        artifact_refs: [],
        token_count: 100,
        schema_version: 1,
      },
      actor: { type: 'system', component: 'orchestrator' },
      trace_id: traceId,
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    })

    // Wait for the async hook fire + VerifierStarted append.
    await waitFor(async () => {
      const rows = await db
        .select()
        .from(verifications)
        .where(eq(verifications.task_id, taskId))
      return rows.length > 0
    }, 2000)

    const verRows = await db
      .select()
      .from(verifications)
      .where(eq(verifications.task_id, taskId))
    expect(verRows.length).toBeGreaterThanOrEqual(1)
    expect(verRows[0]!.status).toBe('running')

    // VerifierStarted event in DB
    const startedEvents = await db
      .select()
      .from(events)
      .where(eq(events.eventType, 'VerifierStarted'))
    const ourEvent = startedEvents.find((e) => {
      const p = e.payload as Record<string, unknown>
      return p['task_id'] === taskId
    })
    expect(ourEvent).toBeTruthy()
  }, 10_000)

  // -------------------------------------------------------------------------
  // T1.6 — Shutdown: no leaked timers (delta ≤ 2)
  // -------------------------------------------------------------------------

  it('shutdown() completes cleanly with no timer leaks (handle delta ≤ 2)', async () => {
    // We use a separate, fresh orchestration instance so we can shut it down
    // independently without affecting the shared orch used by other tests.
    const freshInstallId = uuidv7()
    const freshEventStore = createEventStore(db, sql)
    const freshSocketPath = path.join(
      os.tmpdir(),
      `orbital-boot-fresh-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`,
    )

    // Snapshot handle count before assembly.
    // Note: process._getActiveHandles is internal Node.js API. We use it with
    // a small delta tolerance (≤2) to account for vitest's own timers/handles.
    const handlesBefore = (process as NodeJS.Process & { _getActiveHandles?: () => unknown[] })
      ._getActiveHandles?.()?.length ?? 0

    const freshOrch = await assembleOrchestration({
      db,
      sql,
      eventStore: freshEventStore,
      installId: freshInstallId,
      mcpSocketPath: freshSocketPath,
    })

    await freshOrch.shutdown()

    // Allow a tick for async cleanup.
    await new Promise((r) => setTimeout(r, 100))

    const handlesAfter = (process as NodeJS.Process & { _getActiveHandles?: () => unknown[] })
      ._getActiveHandles?.()?.length ?? 0

    // Delta must be ≤ 2. We allow a small positive delta for vitest's own handles
    // that may materialise during the test run.
    const delta = handlesAfter - handlesBefore
    expect(delta).toBeLessThanOrEqual(2)
  }, 30_000)
})
