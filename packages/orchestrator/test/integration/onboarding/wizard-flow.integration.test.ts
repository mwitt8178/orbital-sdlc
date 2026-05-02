/**
 * Integration tests for the onboarding wizard end-to-end against real
 * Postgres.
 *
 * Covers:
 *   - status query reflects fresh state
 *   - setMode persists and emits InstallModeSet
 *   - loadSample populates sprints/channels/posts and emits events
 *   - resetDemo cleans up by name prefix
 *   - complete marks setup_completed_at and emits OnboardingCompleted
 *
 * Real Postgres via docker-compose (postgres://orbital:orbital_dev_password@localhost:5432/orbital
 * by default; override with DATABASE_URL).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq, like } from 'drizzle-orm'
import { createTRPCProxyClient } from '@trpc/client'
import { resetInstallCache } from '../../../src/config/install.js'
import { resetEnvCache } from '../../../src/config/env.js'
import { resetKeychainCache } from '../../../src/capabilities/keychain.js'
import { sprints, epics, stories } from '../../../src/db/schema/backlog.js'
import { channels, channelPosts } from '../../../src/db/schema/channels.js'
import { events as eventsTable } from '../../../src/db/schema/events.js'
import {
  setAnthropicValidator,
} from '../../../src/onboarding/anthropic-validate.js'
import {
  setMondayValidator,
} from '../../../src/onboarding/monday-validate.js'

const DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgres://orbital:orbital_dev_password@localhost:5432/orbital'

let sqlPool: postgres.Sql
let tmpHome: string
let originalHome: string | undefined
let originalDb: string | undefined
let originalKeychain: string | undefined
let originalKeychainPath: string | undefined

beforeAll(async () => {
  sqlPool = postgres(DATABASE_URL, { max: 5, idle_timeout: 5, onnotice: () => {} })
})

afterAll(async () => {
  await sqlPool.end({ timeout: 1 })
})

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'orbital-onboarding-int-'))
  originalHome = process.env['ORBITAL_HOME']
  originalDb = process.env['DATABASE_URL']
  originalKeychain = process.env['ORBITAL_TEST_KEYCHAIN']
  originalKeychainPath = process.env['ORBITAL_TEST_KEYCHAIN_PATH']
  process.env['ORBITAL_HOME'] = tmpHome
  process.env['DATABASE_URL'] = DATABASE_URL
  process.env['ORBITAL_TEST_KEYCHAIN'] = '1'
  process.env['ORBITAL_TEST_KEYCHAIN_PATH'] = path.join(tmpHome, 'keychain.json')
  resetInstallCache()
  resetEnvCache()
  resetKeychainCache()
})

afterEach(async () => {
  // Clean any demo data this test created so reruns are deterministic.
  const db = drizzle(sqlPool)
  // Posts before channels.
  const demoChans = await db
    .select({ channelId: channels.channelId })
    .from(channels)
    .where(like(channels.name, '[DEMO]%'))
  for (const c of demoChans) {
    await db.delete(channelPosts).where(eq(channelPosts.channelId, c.channelId))
  }
  await db.delete(channels).where(like(channels.name, '[DEMO]%'))
  // Stories before epics.
  const demoEpics = await db
    .select({ epicId: epics.epicId })
    .from(epics)
    .where(like(epics.title, '[DEMO]%'))
  for (const e of demoEpics) {
    await db.delete(stories).where(eq(stories.epicId, e.epicId))
  }
  await db.delete(epics).where(like(epics.title, '[DEMO]%'))
  await db.delete(sprints).where(like(sprints.name, '[DEMO]%'))

  if (originalHome !== undefined) process.env['ORBITAL_HOME'] = originalHome
  else delete process.env['ORBITAL_HOME']
  if (originalDb !== undefined) process.env['DATABASE_URL'] = originalDb
  else delete process.env['DATABASE_URL']
  if (originalKeychain !== undefined) process.env['ORBITAL_TEST_KEYCHAIN'] = originalKeychain
  else delete process.env['ORBITAL_TEST_KEYCHAIN']
  if (originalKeychainPath !== undefined)
    process.env['ORBITAL_TEST_KEYCHAIN_PATH'] = originalKeychainPath
  else delete process.env['ORBITAL_TEST_KEYCHAIN_PATH']
  resetInstallCache()
  resetEnvCache()
  resetKeychainCache()
  setAnthropicValidator(null)
  setMondayValidator(null)
  await fs.rm(tmpHome, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fresh onboarding router instance using the singleton cache reset
 * helpers. We import lazily so the router picks up our env overrides.
 */
async function createRouter() {
  // Force module re-evaluation by jitter-busting the require cache via dynamic
  // import. Vitest caches modules per-worker, so we instead just import once
  // and ensure each test sets env BEFORE the router lazy-singleton wakes up.
  const { createOnboardingRouter } = await import(
    '../../../src/trpc/routers/onboarding.js'
  )
  return createOnboardingRouter()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('onboarding router (integration)', () => {
  it('status returns fresh state on first run', async () => {
    const router = await createRouter()
    const caller = router.createCaller({})
    const status = await caller.status()
    expect(status.setupCompletedAt).toBeNull()
    expect(status.mode).toBeNull()
    expect(status.hasAnthropicToken).toBe(false)
    expect(status.hasMondayToken).toBe(false)
    expect(status.hasSampleData).toBe(false)
    expect(status.installId).toMatch(/^[0-9a-f-]{36}$/i)
  })

  it('setMode persists, emits InstallModeSet, and is reflected in status', async () => {
    const router = await createRouter()
    const caller = router.createCaller({})
    const r = await caller.setMode({ mode: 'live' })
    expect(r.mode).toBe('live')
    const status = await caller.status()
    expect(status.mode).toBe('live')

    const db = drizzle(sqlPool)
    const rows = await db
      .select()
      .from(eventsTable)
      .where(eq(eventsTable.eventType, 'InstallModeSet'))
    expect(rows.length).toBeGreaterThanOrEqual(1)
    const ours = rows.find((r) => (r.payload as Record<string, unknown>)['mode'] === 'live')
    expect(ours).toBeDefined()
  })

  it('connect.anthropic stores token in keychain on a stubbed-success validator', async () => {
    setAnthropicValidator({
      validate: async () => ({ ok: true, balanceCents: null }),
    })
    const router = await createRouter()
    const caller = router.createCaller({})
    const r = await caller.connect.anthropic({ apiKey: 'sk-ant-test-int' })
    expect(r.ok).toBe(true)
    const status = await caller.status()
    expect(status.hasAnthropicToken).toBe(true)
  })

  it('connect.anthropic does NOT store on validation failure', async () => {
    setAnthropicValidator({
      validate: async () => ({ ok: false, message: 'bad' }),
    })
    const router = await createRouter()
    const caller = router.createCaller({})
    const r = await caller.connect.anthropic({ apiKey: 'sk-ant-bad' })
    expect(r.ok).toBe(false)
    const status = await caller.status()
    expect(status.hasAnthropicToken).toBe(false)
  })

  it('loadSample populates sprints, epics, stories, channels, posts and emits events', async () => {
    const router = await createRouter()
    const caller = router.createCaller({})
    const r = await caller.loadSample()
    expect(r.loaded).toBe(true)
    expect(r.alreadyLoaded).toBe(false)
    expect(r.sprintIds.length).toBe(2)
    expect(r.channelIds.length).toBe(4)
    expect(r.eventCount).toBeGreaterThan(0)

    const db = drizzle(sqlPool)
    const sprintRows = await db
      .select()
      .from(sprints)
      .where(like(sprints.name, '[DEMO]%'))
    expect(sprintRows.length).toBe(2)

    const channelRows = await db
      .select()
      .from(channels)
      .where(like(channels.name, '[DEMO]%'))
    expect(channelRows.length).toBe(4)

    const evRows = await db
      .select()
      .from(eventsTable)
      .where(eq(eventsTable.eventType, 'SampleDatasetLoaded'))
    expect(evRows.length).toBeGreaterThanOrEqual(1)

    // Status now reports hasSampleData
    const status = await caller.status()
    expect(status.hasSampleData).toBe(true)
  })

  it('loadSample is idempotent — second call returns alreadyLoaded', async () => {
    const router = await createRouter()
    const caller = router.createCaller({})
    await caller.loadSample()
    const r2 = await caller.loadSample()
    expect(r2.alreadyLoaded).toBe(true)
    expect(r2.loaded).toBe(false)
  })

  it('resetDemo removes demo sprints and channels', async () => {
    const router = await createRouter()
    const caller = router.createCaller({})
    await caller.loadSample()
    const r = await caller.resetDemo()
    expect(r.cleared).toBe(true)
    expect(r.removedSprints).toBe(2)
    expect(r.removedChannels).toBe(4)

    const db = drizzle(sqlPool)
    const sprintRows = await db
      .select()
      .from(sprints)
      .where(like(sprints.name, '[DEMO]%'))
    expect(sprintRows.length).toBe(0)
    const channelRows = await db
      .select()
      .from(channels)
      .where(like(channels.name, '[DEMO]%'))
    expect(channelRows.length).toBe(0)
  })

  it('complete sets setupCompletedAt and emits OnboardingCompleted', async () => {
    const router = await createRouter()
    const caller = router.createCaller({})
    await caller.setMode({ mode: 'demo' })
    const r = await caller.complete()
    expect(r.setupCompletedAt).toMatch(/T/)

    const status = await caller.status()
    expect(status.setupCompletedAt).not.toBeNull()

    const db = drizzle(sqlPool)
    const evRows = await db
      .select()
      .from(eventsTable)
      .where(eq(eventsTable.eventType, 'OnboardingCompleted'))
    expect(evRows.length).toBeGreaterThanOrEqual(1)
  })

  it('startDemo returns a replayId without waiting for the loop', async () => {
    const router = await createRouter()
    const caller = router.createCaller({})
    await caller.loadSample()
    const r = await caller.startDemo({ speedMultiplier: 100 })
    expect(r.replayId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(r.totalSteps).toBeGreaterThan(0)
  })
})

// Suppress an unused-import warning when the trpc client helper is not needed
// in some assertions.
void createTRPCProxyClient
