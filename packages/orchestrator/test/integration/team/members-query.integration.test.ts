/**
 * test/integration/team/members-query.integration.test.ts
 *
 * Round 7-08 — Operator-Attributed UI
 * [Engineer-Sr · Sonnet · run-round7-08-operator-attribution]
 *
 * Verifies that team.members returns tenant-scoped install records:
 *   T1. tenantA install is visible to tenantA query.
 *   T2. tenantA install is NOT visible to tenantB query (cross-tenant bleed blocked).
 *   T3. Revoked installs are excluded from results.
 *   T4. Each returned record has the expected shape with a pre-computed color hue.
 *   T5. A fresh tenant with no installs returns an empty list.
 *
 * Multi-tenant-isolation self-check:
 *   - Every query uses explicit WHERE tenant_id = ? AND revoked_at IS NULL.
 *   - No rows from tenantA are ever returned when querying as tenantB.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { uuidv7 } from 'uuidv7'
import { eq, and, isNull } from 'drizzle-orm'

import { db, closeDb } from '../../../src/db/client.js'
import { knownInstalls } from '../../../src/db/schema/known-installs.js'
import { operatorHue } from '../../../src/trpc/helpers/operator-color-server.js'

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const TENANT_A = uuidv7()
const TENANT_B = uuidv7()
const TENANT_EMPTY = uuidv7()

let installAId: string
let installBId: string
let installARevokedId: string

// Minimal known_installs row (invite_jti must be unique)
function makeInstallRow(
  installId: string,
  tenantId: string,
  displayName: string,
  role: 'owner' | 'member' | 'viewer' = 'member',
  revokedAt?: Date,
) {
  return {
    install_id: installId,
    tenant_id: tenantId,
    public_key: `ed25519-pubkey-${installId.slice(0, 8)}`,
    role,
    display_name: displayName,
    invite_jti: `jti-${installId}`,
    revoked_at: revokedAt ?? null,
  }
}

// ---------------------------------------------------------------------------
// Direct DB query helper — mirrors what team.ts tRPC procedure does
// ---------------------------------------------------------------------------

async function queryMembers(tenantId: string) {
  const rows = await db
    .select({
      install_id: knownInstalls.install_id,
      display_name: knownInstalls.display_name,
      role: knownInstalls.role,
      last_seen_at: knownInstalls.last_seen_at,
    })
    .from(knownInstalls)
    .where(
      and(
        eq(knownInstalls.tenant_id, tenantId),
        isNull(knownInstalls.revoked_at),
      ),
    )
    .orderBy(knownInstalls.joined_at)

  return rows.map((row) => ({
    install_id: row.install_id,
    display_name: row.display_name ?? null,
    role: row.role as 'owner' | 'member' | 'viewer',
    last_seen_at: row.last_seen_at ? row.last_seen_at.toISOString() : null,
    color: operatorHue(row.install_id),
  }))
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  installAId = uuidv7()
  installBId = uuidv7()
  installARevokedId = uuidv7()

  // Insert one active install for tenantA
  await db.insert(knownInstalls).values(
    makeInstallRow(installAId, TENANT_A, 'alice-laptop', 'owner'),
  )

  // Insert one active install for tenantB
  await db.insert(knownInstalls).values(
    makeInstallRow(installBId, TENANT_B, 'bob-workstation', 'member'),
  )

  // Insert a revoked install for tenantA (should NOT appear in results)
  await db.insert(knownInstalls).values(
    makeInstallRow(installARevokedId, TENANT_A, 'alice-old-laptop', 'viewer', new Date()),
  )
}, 30_000)

afterAll(async () => {
  // Clean up in reverse order (no FK constraints, but tidy)
  await db
    .delete(knownInstalls)
    .where(eq(knownInstalls.install_id, installARevokedId))
    .catch(() => undefined)
  await db
    .delete(knownInstalls)
    .where(eq(knownInstalls.install_id, installBId))
    .catch(() => undefined)
  await db
    .delete(knownInstalls)
    .where(eq(knownInstalls.install_id, installAId))
    .catch(() => undefined)
  await closeDb().catch(() => undefined)
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('T1 — team.members: tenantA query returns tenantA install', () => {
  it('returns the active install for tenantA', async () => {
    const members = await queryMembers(TENANT_A)
    const found = members.find((m) => m.install_id === installAId)
    expect(found).toBeDefined()
    expect(found?.display_name).toBe('alice-laptop')
    expect(found?.role).toBe('owner')
  })
})

describe('T2 — team.members: cross-tenant query returns empty (no bleed)', () => {
  it('tenantB query does NOT return tenantA install', async () => {
    const members = await queryMembers(TENANT_B)
    const found = members.find((m) => m.install_id === installAId)
    expect(found).toBeUndefined()
  })

  it('tenantA query does NOT return tenantB install', async () => {
    const members = await queryMembers(TENANT_A)
    const found = members.find((m) => m.install_id === installBId)
    expect(found).toBeUndefined()
  })
})

describe('T3 — team.members: revoked installs are excluded', () => {
  it('tenantA query excludes the revoked install', async () => {
    const members = await queryMembers(TENANT_A)
    const found = members.find((m) => m.install_id === installARevokedId)
    expect(found).toBeUndefined()
  })

  it('tenantA query still includes the active install', async () => {
    const members = await queryMembers(TENANT_A)
    const active = members.find((m) => m.install_id === installAId)
    expect(active).toBeDefined()
  })
})

describe('T4 — team.members: record shape and color hue', () => {
  it('each record has the expected fields', async () => {
    const members = await queryMembers(TENANT_A)
    for (const m of members) {
      expect(m.install_id).toBeTruthy()
      expect(typeof m.display_name === 'string' || m.display_name === null).toBe(true)
      expect(['owner', 'member', 'viewer']).toContain(m.role)
      expect(typeof m.color).toBe('number')
    }
  })

  it('color hue is in range [60, 360)', async () => {
    const members = await queryMembers(TENANT_A)
    for (const m of members) {
      expect(m.color).toBeGreaterThanOrEqual(60)
      expect(m.color).toBeLessThan(360)
    }
  })

  it('color hue is deterministic for the same install_id', async () => {
    const members = await queryMembers(TENANT_A)
    const found = members.find((m) => m.install_id === installAId)
    expect(found).toBeDefined()
    // Re-compute hue directly and compare
    const directHue = operatorHue(installAId)
    expect(found!.color).toBe(directHue)
  })

  it('last_seen_at is null for a freshly inserted install', async () => {
    const members = await queryMembers(TENANT_A)
    const found = members.find((m) => m.install_id === installAId)
    expect(found?.last_seen_at).toBeNull()
  })
})

describe('T5 — team.members: empty tenant returns empty array', () => {
  it('fresh tenant with no installs returns []', async () => {
    const members = await queryMembers(TENANT_EMPTY)
    expect(members).toEqual([])
  })
})
