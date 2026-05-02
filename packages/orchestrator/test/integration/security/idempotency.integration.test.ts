/**
 * idempotency.integration.test.ts — Integration test demonstrating
 * idempotency end-to-end via the real tRPC backlog.epics.create mutation
 * (Round 3 S5 done-criterion).
 *
 * Asserts:
 *   - Calling backlog.epics.create twice with the same Idempotency-Key header
 *     returns the SAME response and produces only ONE EpicCreated event in
 *     audit.events.
 *   - Calling without the header runs the mutation each time (control).
 *
 * Uses createCallerFactory so we go through the real tRPC procedure builder,
 * including the idempotency middleware wired in trpc/init.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { sql as drizzleSql } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'

import { t } from '../../../src/trpc/init.js'
import { appRouter } from '../../../src/trpc/routers/index.js'
import { mutationIdempotency } from '../../../src/db/schema/idempotency.js'
import { events } from '../../../src/db/schema/events.js'

const DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgres://orbital:orbital_dev_password@localhost:5432/orbital'

let pool: postgres.Sql
let db: ReturnType<typeof drizzle>

beforeAll(async () => {
  pool = postgres(DATABASE_URL, { max: 5, onnotice: () => {} })
  db = drizzle(pool)
})

afterAll(async () => {
  await pool.end({ timeout: 5 })
})

async function countEpicsCreatedForTitle(title: string): Promise<number> {
  const rows = await db.execute<{ count: string }>(
    drizzleSql`
      SELECT COUNT(*)::text AS count
      FROM ${events}
      WHERE event_type = 'EpicCreated'
        AND payload->>'title' = ${title}
    `,
  )
  return Number(rows[0]?.count ?? '0')
}

async function cleanIdempotencyKey(key: string): Promise<void> {
  await db.execute(
    drizzleSql`DELETE FROM ${mutationIdempotency} WHERE idempotency_key = ${key}`,
  )
}

describe('Round 3 S5 — idempotent backlog.epics.create end-to-end', () => {
  it('two calls with the same Idempotency-Key produce ONE EpicCreated event', async () => {
    const idempotencyKey = `e2e-${uuidv7()}`
    const title = `E2E Idempotency Epic ${uuidv7()}`
    await cleanIdempotencyKey(idempotencyKey)

    const createCaller = t.createCallerFactory(appRouter)
    const caller = createCaller({
      req: { headers: { 'idempotency-key': idempotencyKey } },
    })

    const epicInput = {
      title,
      rationale: 'integration test epic for idempotency',
      priority: 1,
      vision_version_id: uuidv7(),
    }

    const r1 = (await caller.backlog.epics.create(epicInput)) as {
      epicId: string
      title: string
    }
    const r2 = (await caller.backlog.epics.create(epicInput)) as {
      epicId: string
      title: string
    }

    // Same response on retry.
    expect(r1).toBeDefined()
    expect(r2).toBeDefined()
    // The epicId must be identical between calls — proves the cache served
    // r2 rather than running the mutation again with a fresh UUIDv7.
    // (The cache is jsonb; Date round-trips as a string, so deep-equal of the
    // entire object is not appropriate. epicId equality alone proves cache.)
    expect(r2.epicId).toBe(r1.epicId)
    expect(r2.title).toBe(r1.title)

    // Only ONE event exists for this title — definitive proof that the
    // mutation was not re-executed.
    const eventCount = await countEpicsCreatedForTitle(title)
    expect(eventCount).toBe(1)
  })

  it('control: two calls WITHOUT the header create TWO events', async () => {
    const title = `E2E No-Idempotency Epic ${uuidv7()}`

    const createCaller = t.createCallerFactory(appRouter)
    const caller = createCaller({}) // no headers

    const epicInput = {
      title,
      rationale: 'integration test epic without idempotency',
      priority: 1,
      vision_version_id: uuidv7(),
    }

    await caller.backlog.epics.create(epicInput)
    await caller.backlog.epics.create(epicInput)

    const eventCount = await countEpicsCreatedForTitle(title)
    expect(eventCount).toBe(2)
  })
})
