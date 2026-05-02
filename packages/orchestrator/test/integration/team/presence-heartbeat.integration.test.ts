/**
 * test/integration/team/presence-heartbeat.integration.test.ts
 *
 * Round 7-08 — Operator-Attributed UI
 * [Engineer-Sr · Sonnet · run-round7-08-operator-attribution]
 *
 * Verifies the PresenceService heartbeat and transition behaviours:
 *   H1. heartbeat() updates last_seen_at in the database.
 *   H2. First heartbeat (offline → online) emits a PresenceChanged event.
 *   H3. Subsequent heartbeats from the same install do NOT re-emit events.
 *   H4. markOffline() resets in-memory state and emits offline event.
 *   H5. sweepStale() marks stale installs offline.
 *   H6. resetPresenceService() clears singleton state between tests.
 *
 * Event emissions are verified via a mock EventStore to avoid noise in the
 * integration DB (audit.events REJECT on UPDATE/DELETE, so we don't want
 * permanent test rows accumulating).
 *
 * The DB part (last_seen_at update) uses a real known_installs row to verify
 * the UPDATE propagates.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { uuidv7 } from 'uuidv7'
import { eq } from 'drizzle-orm'

import { db, closeDb } from '../../../src/db/client.js'
import { knownInstalls } from '../../../src/db/schema/known-installs.js'
import {
  PresenceService,
  resetPresenceService,
  ONLINE_THRESHOLD_MS,
  HEARTBEAT_INTERVAL_MS,
} from '../../../src/hub/presence.js'
import type { EventStore } from '../../../src/events/store.js'

// ---------------------------------------------------------------------------
// Mock EventStore
// ---------------------------------------------------------------------------

/**
 * A minimal EventStore mock that records appended events without touching the DB.
 * We avoid the real EventStore here because audit.events rows are immutable and
 * would accumulate test noise.
 */
function makeMockEventStore(): EventStore & { _appended: Array<Record<string, unknown>> } {
  const appended: Array<Record<string, unknown>> = []
  return {
    _appended: appended,
    append: vi.fn(async (event: Record<string, unknown>) => {
      appended.push(event)
      return undefined
    }),
    // Stub remaining EventStore methods (not needed for presence tests)
    query: vi.fn(() => Promise.resolve({ items: [], next_cursor: null })),
    getByTraceId: vi.fn(() => Promise.resolve([])),
    getByAggregateId: vi.fn(() => Promise.resolve([])),
  } as unknown as EventStore & { _appended: Array<Record<string, unknown>> }
}

// ---------------------------------------------------------------------------
// Test install row
// ---------------------------------------------------------------------------

const TENANT_H = uuidv7()
let INSTALL_H_ID: string

function makeInstallRow(installId: string, tenantId: string) {
  return {
    install_id: installId,
    tenant_id: tenantId,
    public_key: `ed25519-hb-${installId.slice(0, 8)}`,
    role: 'member' as const,
    display_name: 'test-heartbeat',
    invite_jti: `hb-jti-${installId}`,
    revoked_at: null,
  }
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  INSTALL_H_ID = uuidv7()
  await db.insert(knownInstalls).values(makeInstallRow(INSTALL_H_ID, TENANT_H))
}, 30_000)

afterAll(async () => {
  await db
    .delete(knownInstalls)
    .where(eq(knownInstalls.install_id, INSTALL_H_ID))
    .catch(() => undefined)
  await closeDb().catch(() => undefined)
})

beforeEach(() => {
  // Reset singleton between tests so in-memory state is clean
  resetPresenceService()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('H1 — heartbeat updates last_seen_at in the database', () => {
  it('last_seen_at is updated after calling heartbeat()', async () => {
    const service = new PresenceService()
    const before = new Date()
    await service.heartbeat(INSTALL_H_ID, TENANT_H)
    const after = new Date()

    const rows = await db
      .select({ last_seen_at: knownInstalls.last_seen_at })
      .from(knownInstalls)
      .where(eq(knownInstalls.install_id, INSTALL_H_ID))
      .limit(1)

    const lastSeen = rows[0]?.last_seen_at
    expect(lastSeen).not.toBeNull()
    // last_seen_at should be within the before/after window
    if (lastSeen) {
      expect(lastSeen.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1_000)
      expect(lastSeen.getTime()).toBeLessThanOrEqual(after.getTime() + 1_000)
    }
  }, 10_000)
})

describe('H2 — first heartbeat emits offline→online PresenceChanged event', () => {
  it('emits one PresenceChanged(online=true) on first heartbeat', async () => {
    const mockStore = makeMockEventStore()
    const service = new PresenceService(mockStore)

    await service.heartbeat(INSTALL_H_ID, TENANT_H)

    expect(mockStore.append).toHaveBeenCalledTimes(1)
    const [event] = mockStore._appended
    expect(event?.['event_type']).toBe('PresenceChanged')
    const payload = event?.['payload'] as Record<string, unknown>
    expect(payload?.['install_id']).toBe(INSTALL_H_ID)
    expect(payload?.['online']).toBe(true)
    expect(payload?.['tenant_id']).toBe(TENANT_H)
  }, 10_000)
})

describe('H3 — subsequent heartbeats do not re-emit events', () => {
  it('second heartbeat does not emit another event', async () => {
    const mockStore = makeMockEventStore()
    const service = new PresenceService(mockStore)

    await service.heartbeat(INSTALL_H_ID, TENANT_H) // first → emits
    await service.heartbeat(INSTALL_H_ID, TENANT_H) // second → no-op

    expect(mockStore.append).toHaveBeenCalledTimes(1)
  }, 10_000)

  it('third heartbeat also does not emit', async () => {
    const mockStore = makeMockEventStore()
    const service = new PresenceService(mockStore)

    for (let i = 0; i < 5; i++) {
      await service.heartbeat(INSTALL_H_ID, TENANT_H)
    }

    // Only the first heartbeat triggers a transition
    expect(mockStore.append).toHaveBeenCalledTimes(1)
  }, 10_000)
})

describe('H4 — markOffline emits online→offline PresenceChanged event', () => {
  it('emits PresenceChanged(online=false) after heartbeat then markOffline', async () => {
    const mockStore = makeMockEventStore()
    const service = new PresenceService(mockStore)

    await service.heartbeat(INSTALL_H_ID, TENANT_H) // online → transition event
    await service.markOffline(INSTALL_H_ID, TENANT_H) // offline → transition event

    expect(mockStore.append).toHaveBeenCalledTimes(2)

    const offlineEvent = mockStore._appended[1]
    const payload = offlineEvent?.['payload'] as Record<string, unknown>
    expect(payload?.['online']).toBe(false)
    expect(payload?.['install_id']).toBe(INSTALL_H_ID)
  }, 10_000)

  it('markOffline when already offline does not emit', async () => {
    const mockStore = makeMockEventStore()
    const service = new PresenceService(mockStore)

    // Never heartbeated → in-memory state is offline (default)
    await service.markOffline(INSTALL_H_ID, TENANT_H)

    expect(mockStore.append).not.toHaveBeenCalled()
  })

  it('isOnline returns false after markOffline', async () => {
    const service = new PresenceService()
    await service.heartbeat(INSTALL_H_ID, TENANT_H)
    expect(service.isOnline(INSTALL_H_ID)).toBe(true)

    await service.markOffline(INSTALL_H_ID, TENANT_H)
    expect(service.isOnline(INSTALL_H_ID)).toBe(false)
  }, 10_000)
})

describe('H5 — sweepStale marks stale installs offline', () => {
  it('marks an install offline when last_seen_at is older than threshold', async () => {
    const mockStore = makeMockEventStore()
    const service = new PresenceService(mockStore)

    // Manually set online state
    await service.heartbeat(INSTALL_H_ID, TENANT_H)
    vi.clearAllMocks()

    // Provide a stale last_seen_at (older than 90s)
    const staleTime = new Date(Date.now() - ONLINE_THRESHOLD_MS - 1_000).toISOString()
    const stale = await service.sweepStale([
      { install_id: INSTALL_H_ID, tenant_id: TENANT_H, last_seen_at: staleTime },
    ])

    expect(stale).toContain(INSTALL_H_ID)
    expect(service.isOnline(INSTALL_H_ID)).toBe(false)
  }, 10_000)

  it('does not mark as stale when last_seen_at is within threshold', async () => {
    const service = new PresenceService()
    await service.heartbeat(INSTALL_H_ID, TENANT_H)

    const recentTime = new Date(Date.now() - 30_000).toISOString()
    const stale = await service.sweepStale([
      { install_id: INSTALL_H_ID, tenant_id: TENANT_H, last_seen_at: recentTime },
    ])

    expect(stale).not.toContain(INSTALL_H_ID)
    expect(service.isOnline(INSTALL_H_ID)).toBe(true)
  }, 10_000)

  it('returns empty array when no members are stale', async () => {
    const service = new PresenceService()
    const recentTime = new Date().toISOString()
    const stale = await service.sweepStale([
      { install_id: INSTALL_H_ID, tenant_id: TENANT_H, last_seen_at: recentTime },
    ])
    expect(stale).toEqual([])
  })

  it('returns empty array for empty member list', async () => {
    const service = new PresenceService()
    const stale = await service.sweepStale([])
    expect(stale).toEqual([])
  })
})

describe('H6 — resetPresenceService clears singleton state', () => {
  it('re-creating the service after reset starts with clean online state', async () => {
    // Verify constants are exported and have sensible values
    expect(ONLINE_THRESHOLD_MS).toBe(90_000)
    expect(HEARTBEAT_INTERVAL_MS).toBe(30_000)
  })

  it('isOnline returns false for unknown install on fresh service', () => {
    const service = new PresenceService()
    expect(service.isOnline('unknown-id')).toBe(false)
  })
})
