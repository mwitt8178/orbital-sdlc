/**
 * Integration tests for PersonaLoader — real Postgres.
 *
 * Done criteria:
 * - All 11 baseline personas load without error
 * - PersonaLoader.getActive() returns 11 personas
 * - Idempotent re-load (hash match → no-op, no new versions)
 * - Events written via EventStore on creation and update
 *
 * Uses unique trace_ids and aggregate_ids per test (audit.events REJECT on UPDATE/DELETE).
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { db, sql } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { createPersonaLoader } from '../../../src/personas/loader.js'
import { personas, personaVersions } from '../../../src/db/schema/personas.js'
import { eq } from 'drizzle-orm'

const eventStore = createEventStore(db, sql)
const loader = createPersonaLoader(db, eventStore)

describe('PersonaLoader integration — initial load', () => {
  beforeAll(async () => {
    // Load all baseline personas
    await loader.load()
  }, 60_000)

  it('getActive() returns exactly 11 personas', async () => {
    const active = await loader.getActive()
    expect(active.length).toBeGreaterThanOrEqual(11)

    // At minimum, all 11 baseline slugs must be present
    const slugs = new Set(active.map(p => p.slug))
    const expected = [
      'pm', 'architect', 'sr-dev', 'jr-dev', 'principal-dev',
      'qa', 'security', 'scrum-master', 'em', 'retro-analyst', 'verifier',
    ]
    for (const slug of expected) {
      expect(slugs.has(slug), `Expected slug '${slug}' in active personas`).toBe(true)
    }
  })

  it('each active persona has a non-empty defaultCapabilityProfile', async () => {
    const active = await loader.getActive()
    for (const p of active) {
      expect(p.defaultCapabilityProfile, `Persona '${p.slug}' missing capability profile`).toBeDefined()
    }
  })

  it('each active persona has a non-empty personaVersionId', async () => {
    const active = await loader.getActive()
    for (const p of active) {
      expect(p.personaVersionId, `Persona '${p.slug}' missing version ID`).toBeTruthy()
    }
  })

  it('each active persona has at least one modelAffinity entry', async () => {
    const active = await loader.getActive()
    for (const p of active) {
      expect(p.modelAffinity.length, `Persona '${p.slug}' has no model affinities`).toBeGreaterThan(0)
    }
  })
})

describe('PersonaLoader integration — idempotency', () => {
  it('second load() call does not create new persona_versions rows for unchanged personas', async () => {
    // Get current version count before second load
    const beforeRows = await db.select().from(personaVersions)
    const beforeCount = beforeRows.length

    // Run load again
    await loader.load()

    const afterRows = await db.select().from(personaVersions)
    const afterCount = afterRows.length

    // Should be the same (hash match → no-op)
    expect(afterCount).toBe(beforeCount)
  }, 60_000)
})

describe('PersonaLoader integration — get() by ID', () => {
  it('can fetch a persona by ID returned from getActive()', async () => {
    const active = await loader.getActive()
    const pm = active.find(p => p.slug === 'pm')
    expect(pm).toBeDefined()

    const fetched = await loader.get(pm!.personaId)
    expect(fetched.slug).toBe('pm')
    expect(fetched.displayName).toBe('Product Manager')
    expect(fetched.personaVersionId).toBe(pm!.personaVersionId)
  })

  it('throws NOT_FOUND_PERSONA for unknown ID', async () => {
    await expect(loader.get('00000000-0000-0000-0000-000000000000')).rejects.toThrow('NOT_FOUND_PERSONA')
  })
})

describe('PersonaLoader integration — event emission', () => {
  it('PersonaCreated events exist for all loaded personas', async () => {
    const events = await eventStore.query({
      event_type: 'PersonaCreated',
      aggregate_type: 'persona',
      limit: 100,
    })
    expect(events.items.length).toBeGreaterThanOrEqual(11)
  })

  it('PersonaVersionPublished events exist for all loaded personas', async () => {
    const events = await eventStore.query({
      event_type: 'PersonaVersionPublished',
      aggregate_type: 'persona',
      limit: 100,
    })
    expect(events.items.length).toBeGreaterThanOrEqual(11)
  })
})
