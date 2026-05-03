/**
 * Round 9 — system teacher integration test.
 *
 * Verifies CLAUDE.md generation + skills.json write + ProjectSDLCConfigured
 * event emission. No GitHub provisioner injected → CLAUDE.md is local-only.
 *
 * [Engineer-Principal · Opus · run-round9-onboarding-overhaul]
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'

import { resetEnvCache } from '../../../src/config/env.js'
import { events as eventsTable } from '../../../src/db/schema/events.js'
import { createSystemTeacher } from '../../../src/onboarding/system-teacher.js'
import { createEventStore } from '../../../src/events/store.js'

const DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgres://orbital:orbital_dev_password@localhost:5432/orbital'

let sqlPool: postgres.Sql
let tmpHome: string

beforeAll(async () => {
  sqlPool = postgres(DATABASE_URL, { max: 5, idle_timeout: 5, onnotice: () => {} })
})

afterAll(async () => {
  await sqlPool.end({ timeout: 1 })
})

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'orbital-r9-teach-'))
  process.env['ORBITAL_HOME'] = tmpHome
  resetEnvCache()
})

afterEach(async () => {
  await fs.rm(tmpHome, { recursive: true, force: true })
})

describe('Round 9 — system teacher (integration)', () => {
  it('writes skills.json + CLAUDE.md locally and emits ProjectSDLCConfigured', async () => {
    const db = drizzle(sqlPool)
    const eventStore = createEventStore(db, sqlPool)
    const teacher = createSystemTeacher(eventStore, null)

    const projectId = uuidv7()
    const cfg = await teacher.teach({
      sessionId: uuidv7(),
      projectId,
      projectName: 'TeachProj',
      vision: { intent: 'Build the thing.', stack: ['nodejs', 'react', 'tailwind'] },
      memoryEntryIds: [uuidv7(), uuidv7()],
    })

    expect(cfg.claudeMdCommitted).toBe(false) // no GitHub provisioner
    expect(cfg.skillsEnabled).toContain('sdlc-monday-board')
    expect(cfg.skillsEnabled).toContain('design-fidelity') // because react+tailwind in stack

    const skillsContent = await fs.readFile(cfg.skillsConfigPath, 'utf-8')
    const skillsJson = JSON.parse(skillsContent)
    expect(skillsJson.projectId).toBe(projectId)
    expect(skillsJson.skills.length).toBeGreaterThan(0)

    const claudeMdContent = await fs.readFile(
      path.join(path.dirname(cfg.skillsConfigPath), 'CLAUDE.md'),
      'utf-8',
    )
    expect(claudeMdContent).toContain('TeachProj')
    expect(claudeMdContent).toContain('Build the thing')

    const evRows = await db
      .select()
      .from(eventsTable)
      .where(eq(eventsTable.aggregateId, projectId))
    expect(evRows.find((e) => e.eventType === 'ProjectSDLCConfigured')).toBeTruthy()

    // audit.events append-only — no cleanup of events
  })

  it('enables backend-only skills when stack lacks frontend libs', async () => {
    const db = drizzle(sqlPool)
    const eventStore = createEventStore(db, sqlPool)
    const teacher = createSystemTeacher(eventStore, null)

    const projectId = uuidv7()
    const cfg = await teacher.teach({
      sessionId: uuidv7(),
      projectId,
      projectName: 'BackendOnly',
      vision: { intent: 'API only.', stack: ['go'] },
      memoryEntryIds: [],
    })

    expect(cfg.skillsEnabled).toContain('sdlc-monday-board')
    expect(cfg.skillsEnabled).not.toContain('design-fidelity')

    // audit.events append-only — no cleanup of events
    void projectId
  })
})
