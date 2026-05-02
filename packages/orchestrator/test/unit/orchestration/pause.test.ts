/**
 * Unit tests for PauseController — uses real Postgres + real CapabilityAuthority.
 *
 * Pause:
 *   - marks active workers as terminating
 *   - revokes their capabilities
 *   - flips worker_pool_state.paused = true
 *   - emits OrchestrationPauseDrained
 *
 * Resume:
 *   - re-issues capabilities for ready tasks
 *   - flips worker_pool_state.paused = false
 *   - emits OrchestrationResumeApplied
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { promises as fsp } from 'node:fs'
import { uuidv7 } from 'uuidv7'
import { eq } from 'drizzle-orm'

import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { CapabilityAuthority } from '../../../src/capabilities/authority.js'
import { KeyManager } from '../../../src/capabilities/keys.js'
import { resetKeychainCache } from '../../../src/capabilities/keychain.js'
import { resetPolicyCache } from '../../../src/capabilities/policy.js'
import { createPersonaLoader } from '../../../src/personas/loader.js'
import { PauseController } from '../../../src/orchestration/pause.js'
import { tasks, workerPoolState } from '../../../src/db/schema/orchestration.js'
import { agentWorkers } from '../../../src/db/schema/worker-tables.js'
import { capabilityRevocations } from '../../../src/db/schema/capabilities.js'

const TEST_SHIM_FILE =
  process.env['ORBITAL_TEST_KEYCHAIN_PATH'] ??
  path.join(os.homedir(), `.orbital-test-keychain-${process.pid}.json`)

const systemActor = { type: 'system' as const, component: 'orchestrator' as const }

let eventStore: ReturnType<typeof createEventStore>
let keyManager: KeyManager
let authority: CapabilityAuthority
let personaLoader: ReturnType<typeof createPersonaLoader>
let installId: string

beforeEach(async () => {
  process.env.ORBITAL_TEST_KEYCHAIN = '1'
  resetKeychainCache()
  resetPolicyCache()
  await fsp.unlink(TEST_SHIM_FILE).catch(() => undefined)
  installId = uuidv7()
  eventStore = createEventStore(db, sql)
  keyManager = new KeyManager(installId, eventStore)
  authority = new CapabilityAuthority(eventStore, keyManager)
  personaLoader = createPersonaLoader(db, eventStore)
  // Ensure baseline personas exist (for sr-dev resume path).
  await personaLoader.load()
})

afterAll(async () => {
  await closeDb().catch(() => undefined)
})

// Helper: issue a real bundle and create a task + worker row matching it.
async function setupActiveWorker(sprintId: string) {
  const taskId = uuidv7()
  const sessionId = uuidv7()

  const issued = await authority.issue({
    install_id: installId,
    persona_id: 'sr-dev',
    task_id: taskId,
    sprint_id: sprintId,
    session_id: sessionId,
    scopes: {
      files_read: ['src/**'],
      files_write: ['src/**'],
      board_read: [],
      board_mutate: [],
      channel_read: [],
      channel_post: [],
      secrets: [],
      network_egress: [],
      spawn_subagent: false,
      git_commit: [],
      ceremony_role: [],
    },
    ttl_ms: 60_000,
    justification: 'pause test',
    actor: systemActor,
    trace_id: uuidv7(),
  })

  // For the in_progress CHECK constraint we need to also supply currentWorktreeId.
  const fakeWorktreeId = uuidv7()
  await db.insert(tasks).values({
    taskId,
    sprintId,
    ticketId: `T-${taskId.slice(0, 8)}`,
    title: 'pause-test',
    description: 'd',
    acceptanceCriteria: [],
    personaId: 'sr-dev',
    riskClass: 'standard',
    state: 'in_progress',
    attemptCount: 0,
    retryBudget: 3,
    wallClockTimeoutMs: 60_000,
    tokenBudget: 4000,
    tokensConsumed: 0,
    declaredWritePaths: ['src/**'],
    createdByEventId: uuidv7(),
    startedAt: new Date(),
    currentWorkerId: sessionId,
    currentCapabilityId: issued.capability_id,
    currentWorktreeId: fakeWorktreeId,
  })

  await db.insert(agentWorkers).values({
    workerId: sessionId,
    personaId: 'sr-dev',
    sessionId,
    taskId,
    status: 'active',
    startedAt: new Date(),
    capabilityId: issued.capability_id,
  })

  return { taskId, sessionId, capabilityId: issued.capability_id }
}

describe('PauseController.pause', () => {
  it('drains active workers, revokes their capabilities, sets paused=true', async () => {
    const sprintId = uuidv7()
    const { sessionId, capabilityId } = await setupActiveWorker(sprintId)

    const controller = new PauseController(
      db,
      eventStore,
      authority,
      personaLoader,
      installId,
      { drainGraceMs: 200, pollIntervalMs: 50 },
    )

    const result = await controller.pause(sprintId, uuidv7())

    expect(result.drainedWorkerIds).toContain(sessionId)
    expect(result.revokedCapabilityIds).toContain(capabilityId)

    // Worker is terminated.
    const w = await db
      .select()
      .from(agentWorkers)
      .where(eq(agentWorkers.workerId, sessionId))
      .limit(1)
    expect(w[0]?.status).toBe('terminated')

    // Capability is revoked.
    const r = await db
      .select()
      .from(capabilityRevocations)
      .where(eq(capabilityRevocations.capability_id, capabilityId))
      .limit(1)
    expect(r.length).toBe(1)

    // Pool flag flipped.
    expect(await controller.isPaused()).toBe(true)

    // Drained event written.
    const evs = await eventStore.query({
      event_type: 'OrchestrationPauseDrained',
      aggregate_id: sprintId,
    })
    expect(evs.items.length).toBeGreaterThanOrEqual(1)
  })

  it('is idempotent when no active workers exist', async () => {
    const sprintId = uuidv7()
    const controller = new PauseController(
      db,
      eventStore,
      authority,
      personaLoader,
      installId,
      { drainGraceMs: 100, pollIntervalMs: 25 },
    )

    const result = await controller.pause(sprintId, uuidv7())
    expect(result.drainedWorkerIds).toEqual([])
    expect(result.revokedCapabilityIds).toEqual([])
    expect(await controller.isPaused()).toBe(true)

    // Reset for the next test by also resuming.
    await controller.resume(sprintId, uuidv7())
  })
})

describe('PauseController.resume', () => {
  it('re-issues capabilities for ready tasks and clears paused flag', async () => {
    const sprintId = uuidv7()
    // Prep: pause the system first.
    const controller = new PauseController(
      db,
      eventStore,
      authority,
      personaLoader,
      installId,
      { drainGraceMs: 100, pollIntervalMs: 25 },
    )
    await controller.pause(sprintId, uuidv7())

    // Create a ready task in the sprint.
    const taskId = uuidv7()
    await db.insert(tasks).values({
      taskId,
      sprintId,
      ticketId: `T-${taskId.slice(0, 8)}`,
      title: 'resume-test',
      description: 'd',
      acceptanceCriteria: [],
      personaId: 'sr-dev',
      riskClass: 'standard',
      state: 'ready',
      attemptCount: 0,
      retryBudget: 3,
      wallClockTimeoutMs: 60_000,
      tokenBudget: 4000,
      tokensConsumed: 0,
      declaredWritePaths: ['src/**'],
      createdByEventId: uuidv7(),
    })

    const result = await controller.resume(sprintId, uuidv7())
    expect(result.reissuedCapabilityCount).toBe(1)
    expect(result.resumedTaskIds).toContain(taskId)

    // Pool unpaused.
    const pool = await db.select().from(workerPoolState).limit(1)
    expect(pool[0]?.paused).toBe(false)

    // Resume event written.
    const evs = await eventStore.query({
      event_type: 'OrchestrationResumeApplied',
      aggregate_id: sprintId,
    })
    expect(evs.items.length).toBeGreaterThanOrEqual(1)
  })
})
