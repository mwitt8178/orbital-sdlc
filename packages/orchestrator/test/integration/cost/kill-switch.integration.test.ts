/**
 * Integration test: kill switch — AC #4
 *
 * Scenario: spawn 2 fake workers, call cost.killAll → assert both PIDs
 * receive SIGTERM and KillSwitchTripped events are written.
 *
 * Uses real Postgres. Worker PIDs are from real child processes spawned
 * via node --eval (no real claude bin needed).
 *
 * [Engineer-Sr · Sonnet · run-round6-05-cost-governance]
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { uuidv7 } from 'uuidv7'
import { spawn as nodeSpawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { sql as drizzleSql } from 'drizzle-orm'

import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { createCostService } from '../../../src/cost/service.js'
import { createCostEnforcer } from '../../../src/cost/enforcer.js'
import { agentWorkers } from '../../../src/db/schema/worker-tables.js'
import { tasks } from '../../../src/db/schema/orchestration.js'
import { events as eventsTable } from '../../../src/db/schema/events.js'

let installId: string
let eventStore: ReturnType<typeof createEventStore>

beforeAll(async () => {
  await sql`SELECT 1`
})

beforeEach(() => {
  installId = uuidv7()
  eventStore = createEventStore(db, sql)
})

afterAll(async () => {
  await closeDb().catch(() => undefined)
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spawn a long-lived child process that just sleeps.
 * Returns the pid + a cleanup handle.
 */
function spawnSleeper(): { child: ChildProcess; pid: number } {
  // node --eval 'setTimeout(() => {}, 60000)' — runs until SIGTERM
  const child = nodeSpawn(process.execPath, ['--eval', 'setTimeout(() => {}, 60000)'], {
    detached: false,
  })
  if (child.pid == null) throw new Error('spawn failed: no pid')
  return { child, pid: child.pid }
}

async function insertFakeWorker(
  workerId: string,
  sprintId: string,
  pid: number,
): Promise<void> {
  // Insert a minimal task row so the sprint join in _killAllInScope works.
  const taskId = uuidv7()
  await db.insert(tasks).values({
    taskId,
    sprintId,
    ticketId:            'KILL-TEST-' + workerId.slice(0, 6),
    title:               'Kill switch test task',
    description:         'Integration test task',
    personaId:           'engineer-sr',
    riskClass:           'low',
    state:               'ready',
    attemptCount:        0,
    retryBudget:         3,
    tokenBudget:         10000,
    wallClockTimeoutMs:  60000,
    declaredWritePaths:  [],
    linkedArtifacts:     [],
    ordering:            1,
    createdByEventId:    uuidv7(),
    createdAt:           new Date(),
  })

  await db.insert(agentWorkers).values({
    workerId,
    personaId:    'engineer-sr',
    sessionId:    uuidv7(),
    taskId,
    status:       'active',
    capabilityId: uuidv7(),
    pid,
    startedAt:    new Date(),
  })
}

async function getKillSwitchEvents(workerId: string) {
  const rows = await db.execute<{ event_type: string; payload: Record<string, unknown> }>(
    drizzleSql`SELECT event_type, payload FROM ${eventsTable} WHERE event_type = 'KillSwitchTripped' AND aggregate_id = ${workerId}`,
  )
  return rows as unknown as Array<{ event_type: string; payload: Record<string, unknown> }>
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('kill switch — AC #4', () => {
  it('SIGTERMs both workers and emits KillSwitchTripped per worker', async () => {
    const sprintId = uuidv7()

    // Spawn 2 real child processes
    const { child: child1, pid: pid1 } = spawnSleeper()
    const { child: child2, pid: pid2 } = spawnSleeper()

    const workerId1 = uuidv7()
    const workerId2 = uuidv7()

    // Insert worker rows linked to the sprint.
    await insertFakeWorker(workerId1, sprintId, pid1)
    await insertFakeWorker(workerId2, sprintId, pid2)

    // Capture SIGTERM signals.
    const sigtermedPids: number[] = []
    const killFn = (pid: number, _signal: NodeJS.Signals) => {
      sigtermedPids.push(pid)
      // Terminate the real process so test doesn't leave zombies.
      try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
    }

    const costService = createCostService(db, eventStore, installId)
    const enforcer = createCostEnforcer(db, eventStore, costService, killFn)

    // Act: kill all workers in the sprint scope.
    const result = await enforcer.killAll('sprint', sprintId, 'integration_test_kill', 'test-operator')

    // Assert: both workers were killed.
    expect(result.killedWorkerIds).toHaveLength(2)
    expect(result.killedWorkerIds).toContain(workerId1)
    expect(result.killedWorkerIds).toContain(workerId2)
    expect(result.signalsSent).toBe(2)
    expect(sigtermedPids).toContain(pid1)
    expect(sigtermedPids).toContain(pid2)

    // Assert: KillSwitchTripped events written.
    const events1 = await getKillSwitchEvents(workerId1)
    const events2 = await getKillSwitchEvents(workerId2)
    expect(events1.length).toBe(1)
    expect(events2.length).toBe(1)
    expect(events1[0]!.payload['scope']).toBe('sprint')
    expect(events1[0]!.payload['reason']).toBe('integration_test_kill')

    // Cleanup: ensure child processes are dead.
    child1.kill('SIGKILL')
    child2.kill('SIGKILL')
  })
})
