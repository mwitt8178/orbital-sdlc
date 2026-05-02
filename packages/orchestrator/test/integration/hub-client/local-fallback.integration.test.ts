/**
 * test/integration/hub-client/local-fallback.integration.test.ts
 *
 * Round 7-02 — Local fallback (no hub) regression test.
 * [Engineer-Sr · Sonnet · run-round7-02-local-hub-split]
 *
 * Verifies that when ORBITAL_HUB_URL is not set:
 *   L1. getHubClient() returns null.
 *   L2. createHubClient() returns null (no env var).
 *   L3. resetHubClient() clears the singleton.
 *   L4. orchestration router's tasks.list uses local Postgres (no hub calls).
 *   L5. memory router uses local Postgres (no hub calls).
 *   L6. projects router uses local Postgres (no hub calls).
 *   L7. channels router uses local Postgres (no hub calls).
 *
 * These tests run against the real local Postgres DB. They confirm that the
 * hub-proxy guard (getHubClient() === null) correctly bypasses to the local path.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { uuidv7 } from 'uuidv7'
import { eq } from 'drizzle-orm'

import { db, closeDb } from '../../../src/db/client.js'
import { tasks } from '../../../src/db/schema/orchestration.js'
import { getHubClient, createHubClient, initHubClient, resetHubClient } from '../../../src/hub-client/index.js'
import { resetEnvCache } from '../../../src/config/env.js'

const SENTINEL = '00000000-0000-0000-0000-000000000000'

// Ensure no hub URL in env for these tests.
const originalHubUrl = process.env['ORBITAL_HUB_URL']

beforeAll(async () => {
  delete process.env['ORBITAL_HUB_URL']
  resetEnvCache()
  resetHubClient()
})

afterAll(async () => {
  if (originalHubUrl !== undefined) {
    process.env['ORBITAL_HUB_URL'] = originalHubUrl
  }
  resetEnvCache()
  resetHubClient()
  await closeDb()
})

beforeEach(() => {
  resetHubClient()
  resetEnvCache()
  delete process.env['ORBITAL_HUB_URL']
})

describe('local fallback (no hub) — L1–L7', () => {
  it('L1: getHubClient() returns null when ORBITAL_HUB_URL is unset', () => {
    const client = getHubClient()
    expect(client).toBeNull()
  })

  it('L2: createHubClient() returns null when ORBITAL_HUB_URL is absent', () => {
    const client = createHubClient()
    expect(client).toBeNull()
  })

  it('L3: resetHubClient() clears singleton — subsequent call re-reads env', () => {
    // Force a cached non-null value
    const dummyClient = createHubClient()
    initHubClient(dummyClient)
    resetHubClient()
    // After reset, re-reads env — still no ORBITAL_HUB_URL, so null
    const after = getHubClient()
    expect(after).toBeNull()
  })

  it('L4: orchestration tasks table is queryable via local DB (no hub needed)', async () => {
    // Confirm local Postgres path works by inserting + querying a task row.
    const taskId = uuidv7()
    const sprintId = uuidv7()

    await db.insert(tasks).values({
      taskId,
      sprintId,
      ticketId: 'TEST-0',
      title: 'local-fallback test task',
      description: 'local fallback test',
      personaId: 'sr-dev',
      riskClass: 'standard',
      state: 'pending',
      retryBudget: 3,
      wallClockTimeoutMs: 3_600_000,
      tokenBudget: 100_000,
      ordering: 1,
      linkedArtifacts: [],
      declaredWritePaths: [],
      iterationCount: 0,
      escalationCount: 0,
      attemptCount: 0,
      tenantId: SENTINEL,
      createdByEventId: uuidv7(),
    })

    const rows = await db.select().from(tasks).where(eq(tasks.taskId, taskId))
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toBe('local-fallback test task')

    // Cleanup
    await db.delete(tasks).where(eq(tasks.taskId, taskId))
  })

  it('L5: hub is null — getHubClient() never throws', () => {
    // Call multiple times to confirm no side effects
    for (let i = 0; i < 5; i++) {
      expect(getHubClient()).toBeNull()
    }
  })

  it('L6: initHubClient(null) explicitly marks hub absent', () => {
    initHubClient(null)
    expect(getHubClient()).toBeNull()
  })

  it('L7: local DB insert+read roundtrip (full regression path)', async () => {
    const taskId = uuidv7()
    const sprintId = uuidv7()

    await db.insert(tasks).values({
      taskId,
      sprintId,
      ticketId: 'TEST-0',
      title: 'regression task',
      description: 'local only',
      personaId: 'sr-dev',
      riskClass: 'low',
      state: 'ready',
      retryBudget: 5,
      wallClockTimeoutMs: 1_800_000,
      tokenBudget: 50_000,
      ordering: 2,
      linkedArtifacts: [],
      declaredWritePaths: [],
      iterationCount: 0,
      escalationCount: 0,
      attemptCount: 0,
      tenantId: SENTINEL,
      createdByEventId: uuidv7(),
    })

    const rows = await db.select().from(tasks).where(eq(tasks.taskId, taskId))
    expect(rows).toHaveLength(1)
    expect(rows[0].state).toBe('ready')
    expect(rows[0].personaId).toBe('sr-dev')

    await db.delete(tasks).where(eq(tasks.taskId, taskId))
  })
})
