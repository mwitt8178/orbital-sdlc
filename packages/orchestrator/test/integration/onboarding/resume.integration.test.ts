/**
 * Round 9 — resume integration test.
 *
 * Verifies acceptance criterion #6: refresh mid-onboarding → return to same
 * step with same data.
 *
 * [Engineer-Principal · Opus · run-round9-onboarding-overhaul]
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq, sql as drizzleSql } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'

import { resetInstallCache } from '../../../src/config/install.js'
import { resetEnvCache } from '../../../src/config/env.js'
import { events as eventsTable } from '../../../src/db/schema/events.js'
import { onboardingSessions } from '../../../src/db/schema/onboarding.js'
import { createOnboardingFlowService } from '../../../src/onboarding/flows.js'
import { createEventStore } from '../../../src/events/store.js'

const DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgres://orbital:orbital_dev_password@localhost:5432/orbital'

let sqlPool: postgres.Sql
let tmpHome: string

beforeAll(async () => {
  sqlPool = postgres(DATABASE_URL, { max: 5, idle_timeout: 5, onnotice: () => {} })
  const db = drizzle(sqlPool)
  try {
    await db.execute(drizzleSql`SELECT 1 FROM onboarding_sessions LIMIT 0`)
  } catch {
    const { fileURLToPath } = await import('node:url')
    const migration = await fs.readFile(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../../src/db/migrations/0037_onboarding_state.sql',
      ),
      'utf-8',
    )
    const statements = migration
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith('--'))
    for (const stmt of statements) {
      await sqlPool.unsafe(stmt)
    }
  }
})

afterAll(async () => {
  await sqlPool.end({ timeout: 1 })
})

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'orbital-r9-resume-'))
  process.env['ORBITAL_HOME'] = tmpHome
  resetInstallCache()
  resetEnvCache()
})

afterEach(async () => {
  await fs.rm(tmpHome, { recursive: true, force: true })
})

describe('Round 9 — resume', () => {
  it('mid-flow refresh returns the same step + same state', async () => {
    const db = drizzle(sqlPool)
    const eventStore = createEventStore(db, sqlPool)
    const flow = createOnboardingFlowService(db, eventStore)

    const installId = uuidv7()
    const session = await flow.start({ installId, flow: 'new_project' })

    // Walk through 2 steps, persisting data.
    await flow.update({
      sessionId: session.sessionId,
      step: 'connect_tools',
      patch: { name: 'Apprentice', slug: 'apprentice' },
    })
    await flow.update({
      sessionId: session.sessionId,
      step: 'vision_intake',
      patch: { tools_anthropic_connected: true },
    })

    // Simulate refresh: drop the in-process flow service, re-create one,
    // call resume(installId).
    const flow2 = createOnboardingFlowService(db, eventStore)
    const resumed = await flow2.resume(installId)
    expect(resumed).not.toBeNull()
    expect(resumed!.sessionId).toBe(session.sessionId)
    expect(resumed!.currentStep).toBe('vision_intake')
    expect((resumed!.stateJson as Record<string, unknown>)['name']).toBe('Apprentice')
    expect((resumed!.stateJson as Record<string, unknown>)['slug']).toBe('apprentice')
    expect((resumed!.stateJson as Record<string, unknown>)['tools_anthropic_connected']).toBe(true)

    // audit.events append-only
    await db.delete(onboardingSessions).where(eq(onboardingSessions.sessionId, session.sessionId))
  })

  it('returns null when no active session exists for the install', async () => {
    const db = drizzle(sqlPool)
    const eventStore = createEventStore(db, sqlPool)
    const flow = createOnboardingFlowService(db, eventStore)

    const installId = uuidv7()
    const r = await flow.resume(installId)
    expect(r).toBeNull()
  })

  it('does not return abandoned sessions on resume', async () => {
    const db = drizzle(sqlPool)
    const eventStore = createEventStore(db, sqlPool)
    const flow = createOnboardingFlowService(db, eventStore)

    const installId = uuidv7()
    const session = await flow.start({ installId, flow: 'new_project' })
    await flow.abandon(session.sessionId, 'navigated_away')

    const resumed = await flow.resume(installId)
    expect(resumed).toBeNull()

    // audit.events append-only
    await db.delete(onboardingSessions).where(eq(onboardingSessions.sessionId, session.sessionId))
  })
})
