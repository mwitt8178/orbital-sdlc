/**
 * pause-sigterm.test.ts — Unit tests for PauseController SIGTERM/SIGKILL semantics.
 *
 * These tests use a fixture process (the test process itself) and a mock killFn
 * to verify the signal flow without actually killing anything.
 *
 * Gap O1: Sprint pause SIGTERM contract.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
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
import { tasks } from '../../../src/db/schema/orchestration.js'
import { agentWorkers } from '../../../src/db/schema/worker-tables.js'

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
  await personaLoader.load()
})

afterAll(async () => {
  await closeDb().catch(() => undefined)
})

async function setupWorkerWithPid(
  sprintId: string,
  pid: number | null,
  status: 'active' | 'idle' | 'terminated' = 'active',
) {
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
    justification: 'sigterm test',
    actor: systemActor,
    trace_id: uuidv7(),
  })

  const fakeWorktreeId = uuidv7()
  await db.insert(tasks).values({
    taskId,
    sprintId,
    ticketId: `T-${taskId.slice(0, 8)}`,
    title: 'sigterm-test',
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
    status,
    startedAt: new Date(),
    capabilityId: issued.capability_id,
    pid,
  })

  return { taskId, sessionId, capabilityId: issued.capability_id }
}

describe('PauseController — SIGTERM/SIGKILL signaling', () => {
  it('sends SIGTERM to active worker with a pid', async () => {
    const sprintId = uuidv7()
    const fakePid = 99999 // unlikely to be a real process
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = []

    const killFn = (pid: number, signal: NodeJS.Signals) => {
      signals.push({ pid, signal })
      // Simulate ESRCH (no such process) — the worker "exited already"
      const err = Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
      throw err
    }

    await setupWorkerWithPid(sprintId, fakePid)

    const controller = new PauseController(
      db,
      eventStore,
      authority,
      personaLoader,
      installId,
      {
        drainGraceMs: 200,
        pollIntervalMs: 50,
        sigkillGraceMs: 0, // skip SIGKILL grace in tests
        killFn,
      },
    )

    await controller.pause(sprintId, uuidv7())

    // SIGTERM should have been attempted for our pid
    expect(signals.some((s) => s.pid === fakePid && s.signal === 'SIGTERM')).toBe(true)
  })

  it('does NOT signal workers in terminated status', async () => {
    const sprintId = uuidv7()
    const fakePid = 99998
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = []

    const killFn = (pid: number, signal: NodeJS.Signals) => {
      signals.push({ pid, signal })
      const err = Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
      throw err
    }

    // Insert a terminated worker — it should NOT be in the query result
    // (findActiveSprintWorkers excludes 'terminated')
    await setupWorkerWithPid(sprintId, fakePid, 'terminated')

    const controller = new PauseController(
      db,
      eventStore,
      authority,
      personaLoader,
      installId,
      {
        drainGraceMs: 200,
        pollIntervalMs: 50,
        sigkillGraceMs: 0,
        killFn,
      },
    )

    await controller.pause(sprintId, uuidv7())

    // No SIGTERM should be sent to a terminated worker
    expect(signals.filter((s) => s.pid === fakePid).length).toBe(0)
  })

  it('handles workers with no pid gracefully (no throw)', async () => {
    const sprintId = uuidv7()
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = []
    const killFn = (pid: number, signal: NodeJS.Signals) => {
      signals.push({ pid, signal })
    }

    // Worker has no pid
    await setupWorkerWithPid(sprintId, null)

    const controller = new PauseController(
      db,
      eventStore,
      authority,
      personaLoader,
      installId,
      {
        drainGraceMs: 200,
        pollIntervalMs: 50,
        sigkillGraceMs: 0,
        killFn,
      },
    )

    // Should not throw
    const result = await controller.pause(sprintId, uuidv7())
    expect(result.drainedWorkerIds.length).toBeGreaterThanOrEqual(0)
    // No kill attempts since no pid
    expect(signals.length).toBe(0)
  })

  it('sends SIGKILL after grace period if process survives SIGTERM', async () => {
    const sprintId = uuidv7()
    const fakePid = 99997
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = []

    // Track process.kill(pid, 0) calls too
    const originalProcessKill = process.kill.bind(process)
    const processKillSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (signal === 0) {
        // Simulate process still alive for SIGKILL check
        return true
      }
      return originalProcessKill(pid, signal as NodeJS.Signals)
    })

    const killFn = (pid: number, signal: NodeJS.Signals) => {
      signals.push({ pid, signal })
      // SIGTERM doesn't throw — process "still alive"
    }

    await setupWorkerWithPid(sprintId, fakePid)

    const controller = new PauseController(
      db,
      eventStore,
      authority,
      personaLoader,
      installId,
      {
        drainGraceMs: 500,
        pollIntervalMs: 50,
        sigkillGraceMs: 50, // very short for test
        killFn,
      },
    )

    await controller.pause(sprintId, uuidv7())

    processKillSpy.mockRestore()

    // Both SIGTERM and SIGKILL should have been sent
    const termSignals = signals.filter((s) => s.pid === fakePid && s.signal === 'SIGTERM')
    const killSignals = signals.filter((s) => s.pid === fakePid && s.signal === 'SIGKILL')
    expect(termSignals.length).toBeGreaterThanOrEqual(1)
    expect(killSignals.length).toBeGreaterThanOrEqual(1)
  })
})
