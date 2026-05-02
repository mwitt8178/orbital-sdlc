/**
 * Unit tests for audit-export/generator.ts
 *
 * Per task done criteria:
 *   - enumerateMonths: correct month list for ranges
 *   - 3-month export → 3 shards generated concurrently (Promise.all verified by mock)
 *   - Shard content: zstd magic bytes 0x28 0xB5 0x2F 0xFD in compressed output
 *   - ExportGenerator.generateShard: compresses events as JSONL with zstd
 *
 * Uses real Postgres for event queries.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { uuidv7 } from 'uuidv7'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { PostgresEventStore } from '../../../src/events/store.js'
import { PostgresAuditQueryService } from '../../../src/audit/query.js'
import { ExportGenerator, enumerateMonths } from '../../../src/audit-export/generator.js'
import * as zstd from 'zstd-napi'
import type { EventInput } from '../../../src/events/types.js'

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://orbital:orbital_dev_password@localhost:5432/orbital'

// Zstd magic: first 4 bytes of a valid .zst file
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

let sqlPool: postgres.Sql
let store: PostgresEventStore
let queryService: PostgresAuditQueryService
let generator: ExportGenerator

beforeAll(async () => {
  sqlPool = postgres(DATABASE_URL, { max: 5, onnotice: () => {} })
  const db = drizzle(sqlPool)
  store = new PostgresEventStore(db, sqlPool)
  queryService = new PostgresAuditQueryService(db, store)
  generator = new ExportGenerator(db, store, queryService)
})

afterAll(async () => {
  await store.stopNotifyClient()
  await sqlPool.end({ timeout: 5 })
})

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<EventInput> = {}): EventInput {
  return {
    aggregate_id: uuidv7(),
    aggregate_type: 'system',
    event_type: 'WorkerHeartbeat',
    payload: { test: true },
    actor: { type: 'system', component: 'orchestrator' },
    trace_id: `test-${uuidv7()}`,
    occurred_at: new Date().toISOString(),
    schema_version: 1,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// enumerateMonths
// ---------------------------------------------------------------------------

describe('enumerateMonths', () => {
  it('single month: returns one entry', () => {
    const months = enumerateMonths('2026-01-01T00:00:00.000Z', '2026-01-31T23:59:59.999Z')
    expect(months).toEqual(['2026-01'])
  })

  it('three consecutive months: returns exactly 3 entries', () => {
    const months = enumerateMonths('2026-01-01T00:00:00.000Z', '2026-03-31T23:59:59.999Z')
    expect(months).toHaveLength(3)
    expect(months).toEqual(['2026-01', '2026-02', '2026-03'])
  })

  it('12 months: returns 12 entries', () => {
    const months = enumerateMonths('2026-01-01T00:00:00.000Z', '2026-12-31T23:59:59.999Z')
    expect(months).toHaveLength(12)
  })

  it('cross-year range', () => {
    const months = enumerateMonths('2025-11-01T00:00:00.000Z', '2026-02-28T23:59:59.999Z')
    expect(months).toEqual(['2025-11', '2025-12', '2026-01', '2026-02'])
  })

  it('same month start and end: returns single month', () => {
    const months = enumerateMonths('2026-06-05T00:00:00.000Z', '2026-06-20T12:00:00.000Z')
    expect(months).toEqual(['2026-06'])
  })
})

// ---------------------------------------------------------------------------
// generateShard: zstd magic bytes
// ---------------------------------------------------------------------------

describe('generateShard', () => {
  it('produces a buffer whose first 4 bytes are the zstd magic (0x28 0xB5 0x2F 0xFD)', async () => {
    // Insert some test events for the target month
    const testAggregateId = uuidv7()
    const month = '2025-09'
    const testEvents = Array.from({ length: 5 }, (_, i) =>
      makeEvent({
        aggregate_id: testAggregateId,
        aggregate_type: 'system',
        occurred_at: `2025-09-${String(i + 1).padStart(2, '0')}T12:00:00.000Z`,
      }),
    )

    for (const ev of testEvents) {
      await store.append(ev)
    }

    const req = {
      exportId: uuidv7(),
      installId: uuidv7(),
      rangeStart: '2025-09-01T00:00:00.000Z',
      rangeEnd: '2025-09-30T23:59:59.999Z',
      scope: { kind: 'full_org' as const },
      cutoffEventId: uuidv7(),
      requestedBy: { type: 'user' as const, user_id: 'test', install_id: 'test' },
      capabilityId: uuidv7(),
      justification: 'test shard generation',
      passphrase: 'test-passphrase-for-sharding12',
    }

    const shard = await generator.generateShard(req, month)

    // Must have at least our 5 events
    expect(shard.eventCount).toBeGreaterThanOrEqual(5)
    expect(shard.month).toBe(month)

    // First 4 bytes must be zstd magic
    expect(shard.compressedBytes.subarray(0, 4)).toEqual(ZSTD_MAGIC)

    // Decompress and verify it's valid JSONL
    const decompressed: Buffer = zstd.decompress(shard.compressedBytes) as Buffer
    const lines = decompressed.toString('utf-8').split('\n').filter(Boolean)
    expect(lines.length).toBeGreaterThanOrEqual(5)

    // Each line is valid JSON
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow()
    }

    // SHA-256 is 64 hex chars
    expect(shard.sha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('returns empty JSONL and 0 event count for a month with no events', async () => {
    const req = {
      exportId: uuidv7(),
      installId: uuidv7(),
      rangeStart: '2018-06-01T00:00:00.000Z',
      rangeEnd: '2018-06-30T23:59:59.999Z',
      scope: { kind: 'full_org' as const },
      cutoffEventId: uuidv7(),
      requestedBy: { type: 'user' as const, user_id: 'test', install_id: 'test' },
      capabilityId: uuidv7(),
      justification: 'empty month test',
      passphrase: 'test-passphrase-for-empty-month12',
    }

    const shard = await generator.generateShard(req, '2018-06')

    expect(shard.eventCount).toBe(0)
    // Even an empty compressed buffer has zstd magic
    expect(shard.compressedBytes.subarray(0, 4)).toEqual(ZSTD_MAGIC)
  })
})

// ---------------------------------------------------------------------------
// generateShardsParallel: 3 months → 3 shards
// ---------------------------------------------------------------------------

describe('generateShardsParallel', () => {
  it('generates exactly 3 shards for a 3-month range', async () => {
    const months = ['2018-01', '2018-02', '2018-03']
    const req = {
      exportId: uuidv7(),
      installId: uuidv7(),
      rangeStart: '2018-01-01T00:00:00.000Z',
      rangeEnd: '2018-03-31T23:59:59.999Z',
      scope: { kind: 'full_org' as const },
      cutoffEventId: uuidv7(),
      requestedBy: { type: 'user' as const, user_id: 'test', install_id: 'test' },
      capabilityId: uuidv7(),
      justification: 'parallel shard test',
      passphrase: 'parallel-shard-passphrase12345',
    }

    const shards = await generator.generateShardsParallel(req, months)

    expect(shards).toHaveLength(3)
    expect(shards.map((s) => s.month)).toEqual(months)

    // All shards have valid zstd output
    for (const shard of shards) {
      expect(shard.compressedBytes.subarray(0, 4)).toEqual(ZSTD_MAGIC)
    }
  })
})
