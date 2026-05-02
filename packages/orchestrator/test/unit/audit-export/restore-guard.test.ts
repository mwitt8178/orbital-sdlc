/**
 * restore-guard.test.ts — Unit + integration tests for assertDatabaseEmptyOrConfirmed.
 *
 * Gap O2: Restore DB-non-empty guard.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { assertDatabaseEmptyOrConfirmed } from '../../../src/audit-export/restore-guard.js'
import { OrbitalError } from '@orbital/types'
import type { DB } from '../../../src/db/client.js'

// ---------------------------------------------------------------------------
// Unit tests using a mock DB
// ---------------------------------------------------------------------------

/** Build a DB mock where every table query returns a given count. */
function makeMockDb(counts: Record<string, number>): DB {
  let callIndex = 0
  const tableOrder = ['events', 'tasks', 'sprints', 'channel_posts', 'vision_documents']
  return {
    execute: vi.fn(async (_query: unknown) => {
      // The restore-guard queries tables in a fixed order.
      // Return the count for the table at the current call index.
      const table = tableOrder[callIndex % tableOrder.length]
      callIndex++
      return [{ n: table ? (counts[table] ?? 0) : 0 }]
    }),
  } as unknown as DB
}

describe('assertDatabaseEmptyOrConfirmed — unit (mock DB)', () => {
  it('resolves when all tables are empty', async () => {
    const db = makeMockDb({ events: 0, tasks: 0, sprints: 0, channel_posts: 0, vision_documents: 0 })
    await expect(assertDatabaseEmptyOrConfirmed(db)).resolves.toBeUndefined()
  })

  it('throws CONFLICT_RESTORE_NON_EMPTY when any table has rows', async () => {
    const db1 = makeMockDb({ events: 5, tasks: 0, sprints: 0, channel_posts: 0, vision_documents: 0 })
    const db2 = makeMockDb({ events: 5, tasks: 0, sprints: 0, channel_posts: 0, vision_documents: 0 })
    await expect(assertDatabaseEmptyOrConfirmed(db1)).rejects.toThrow(OrbitalError)
    await expect(assertDatabaseEmptyOrConfirmed(db2)).rejects.toMatchObject({
      code: 'CONFLICT_RESTORE_NON_EMPTY',
    })
  })

  it('throws with retry_advice=no_retry', async () => {
    const db = makeMockDb({ events: 1, tasks: 0, sprints: 0, channel_posts: 0, vision_documents: 0 })
    try {
      await assertDatabaseEmptyOrConfirmed(db)
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(OrbitalError)
      expect((err as OrbitalError).retryAdvice).toBe('no_retry')
    }
  })

  it('resolves immediately when force=true regardless of row counts', async () => {
    const db = makeMockDb({ events: 999, tasks: 500, sprints: 10, channel_posts: 100, vision_documents: 3 })
    await expect(assertDatabaseEmptyOrConfirmed(db, { force: true })).resolves.toBeUndefined()
  })

  it('includes non-empty table names in the error details', async () => {
    const db = makeMockDb({ events: 3, tasks: 0, sprints: 7, channel_posts: 0, vision_documents: 0 })
    try {
      await assertDatabaseEmptyOrConfirmed(db)
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(OrbitalError)
      const orbital = err as OrbitalError
      const details = orbital.details as { non_empty_tables?: Array<{ table: string; count: number }> }
      expect(details.non_empty_tables?.some((t) => t.table === 'events')).toBe(true)
      expect(details.non_empty_tables?.some((t) => t.table === 'sprints')).toBe(true)
    }
  })

  it('handles DB errors on individual table counts gracefully (treats as 0)', async () => {
    const db = {
      execute: vi.fn().mockRejectedValue(new Error('table does not exist')),
    } as unknown as DB

    // Should not throw — treats all counts as 0
    await expect(assertDatabaseEmptyOrConfirmed(db)).resolves.toBeUndefined()
  })
})
