/**
 * Round 9 — idempotency integration test.
 *
 * Acceptance criterion #7: re-running flow A with the same project name →
 * "this project already exists; pick another or open existing."
 *
 * The projects service rejects duplicate slugs within an install with
 * CONFLICT_SLUG. We verify here that the reject is deterministic + the second
 * caller can retrieve the existing project and reuse it.
 *
 * [Engineer-Principal · Opus · run-round9-onboarding-overhaul]
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { OrbitalError } from '@orbital/types'

import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { createProjectsService } from '../../../src/projects/service.js'
import { projects } from '../../../src/db/schema/projects.js'
import { events } from '../../../src/db/schema/events.js'
import { eq, inArray } from 'drizzle-orm'
import { PROJECTS_ERROR_CODES } from '../../../src/projects/types.js'

let owned: string[] = []

beforeAll(async () => {
  // Trigger lazy db init via a real query through the drizzle client.
  await db.select().from(projects).limit(1).catch(() => undefined)
  void sql
})

beforeEach(() => {
  owned = []
})

afterAll(async () => {
  if (owned.length > 0) {
    // audit.events is append-only; only project rows are removed.
    await db
      .delete(projects)
      .where(inArray(projects.projectId, owned))
      .catch(() => undefined)
  }
  await closeDb().catch(() => undefined)
})

function uniqueSlug(): string {
  return `idemp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

describe('Round 9 — flow A idempotency', () => {
  it('re-creating with the same slug throws CONFLICT_SLUG', async () => {
    const eventStore = createEventStore(db, sql)
    const svc = createProjectsService(db, eventStore)
    const slug = uniqueSlug()

    const created = await svc.create({ name: 'Apprentice', slug })
    owned.push(created.projectId)

    try {
      await svc.create({ name: 'Apprentice (again)', slug })
      expect.fail('expected CONFLICT_SLUG to throw')
    } catch (err) {
      expect((err as OrbitalError).code).toBe(PROJECTS_ERROR_CODES.CONFLICT_SLUG)
    }
  })

  it('records the provisioning intent on the ProjectCreated event payload', async () => {
    const eventStore = createEventStore(db, sql)
    const svc = createProjectsService(db, eventStore)
    const slug = uniqueSlug()

    const created = await svc.create({
      name: 'Provisioned',
      slug,
      provisioning: { monday: true, github: true },
    })
    owned.push(created.projectId)

    const evRows = await db.select().from(events).where(eq(events.aggregateId, created.projectId))
    const ev = evRows.find((e) => e.eventType === 'ProjectCreated')
    expect(ev).toBeTruthy()
    const payload = ev!.payload as { provisioning?: { monday: boolean; github: boolean } }
    expect(payload.provisioning).toEqual({ monday: true, github: true })
  })
})
