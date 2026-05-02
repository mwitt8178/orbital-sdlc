/**
 * lifecycle.integration.test.ts — full issue → use → revoke lifecycle.
 *
 * Real DB, real keychain shim, real Ed25519 signatures, real EventStore.
 * Verifies that:
 *   - issue persists a row, file shim contains the sub-key private bytes
 *   - validateToolCall on a tool the bundle authorizes returns allowed=true
 *   - validateToolCall denial path writes capability_denials + emits event
 *   - revoke is reflected within the next verify call
 *   - all events flow through EventStore (no direct events insert)
 *   - rotate generates a new sub-key and emits KeyRotated
 *   - archive zeroizes private and emits KeyArchived
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { uuidv7 } from 'uuidv7'
import { eq } from 'drizzle-orm'

import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import {
  capabilityGrants,
  capabilityRevocations,
  capabilityDenials,
  signingKeys,
} from '../../../src/db/schema/capabilities.js'
import { CapabilityAuthority } from '../../../src/capabilities/authority.js'
import { KeyManager } from '../../../src/capabilities/keys.js'
import {
  resetKeychainCache,
  getTestShimKeychain,
} from '../../../src/capabilities/keychain.js'
import { resetPolicyCache } from '../../../src/capabilities/policy.js'
import type { Actor, Scopes } from '@orbital/types'

const eventStore = createEventStore(db, sql)
let installId: string
let keyManager: KeyManager
let authority: CapabilityAuthority

const systemActor: Actor = { type: 'system', component: 'capability_authority' }

const TEST_SHIM_FILE =
  process.env['ORBITAL_TEST_KEYCHAIN_PATH'] ??
  path.join(os.homedir(), '.orbital-test-keychain.json')

const scopes: Scopes = {
  files_read: ['src/billing/**'],
  files_write: [],
  board_read: ['ticket:ORB-1'],
  board_mutate: [],
  channel_read: ['#orb-1'],
  channel_post: ['#orb-1'],
  secrets: [],
  network_egress: ['api.anthropic.com'],
  spawn_subagent: false,
  git_commit: [],
  ceremony_role: [],
}

beforeAll(async () => {
  await sql`SELECT 1`
})

beforeEach(async () => {
  process.env.ORBITAL_TEST_KEYCHAIN = '1'
  resetKeychainCache()
  resetPolicyCache()
  await fs.unlink(TEST_SHIM_FILE).catch(() => undefined)
  // Fresh install for each test ensures key state and shim state stay aligned.
  installId = uuidv7()
  keyManager = new KeyManager(installId, eventStore)
  authority = new CapabilityAuthority(eventStore, keyManager)
})

afterAll(async () => {
  await closeDb().catch(() => undefined)
  await fs.unlink(TEST_SHIM_FILE).catch(() => undefined)
})

describe('Phase 1B integration — full lifecycle', () => {
  it('issue → file shim contains sub-key private', async () => {
    const sprintId = uuidv7()
    const result = await authority.issue({
      install_id: installId,
      persona_id: 'senior-developer',
      task_id: uuidv7(),
      sprint_id: sprintId,
      session_id: uuidv7(),
      scopes,
      justification: 'lifecycle-issue',
      actor: systemActor,
      trace_id: 'lifecycle-1',
    })

    // Shim file should now exist with mode 0600.
    const shim = await getTestShimKeychain()
    await shim.assertSecure()

    const accounts = await shim.listAccounts()
    // At least one master + one sub.
    const masters = accounts.filter((a) => a.startsWith('master:'))
    const subs = accounts.filter((a) => a.startsWith('sub:'))
    expect(masters.length).toBeGreaterThanOrEqual(1)
    expect(subs.length).toBeGreaterThanOrEqual(1)

    // The grant row references our signing_sub_key.
    const grants = await db
      .select()
      .from(capabilityGrants)
      .where(eq(capabilityGrants.capability_id, result.capability_id))
    expect(grants[0]?.signing_sub_key_id).toBeTruthy()

    // The signing_keys table has the sub-key with parent_signature.
    const subKey = await db
      .select()
      .from(signingKeys)
      .where(eq(signingKeys.key_id, grants[0]!.signing_sub_key_id))
    expect(subKey[0]?.parent_signature).toBeTruthy()
    expect(subKey[0]?.parent_key_id).toBeTruthy()
    expect(subKey[0]?.key_kind).toBe('sub')
  })

  it('issue → validate (allow) → validate (deny) → revoke → validate (revoked)', async () => {
    const sprintId = uuidv7()
    const result = await authority.issue({
      install_id: installId,
      persona_id: 'senior-developer',
      task_id: uuidv7(),
      sprint_id: sprintId,
      session_id: uuidv7(),
      scopes,
      justification: 'lifecycle-full',
      actor: systemActor,
      trace_id: 'lifecycle-2',
    })

    // Allow
    const allow = await authority.validateAndEmit(
      result.bundle,
      'files.read',
      { path: 'src/billing/invoice.ts' },
      systemActor,
      'lifecycle-allow',
    )
    expect(allow.allowed).toBe(true)

    // Deny
    const denyTraceId = `lifecycle-deny-${uuidv7()}`
    const deny = await authority.validateAndEmit(
      result.bundle,
      'files.read',
      { path: 'src/admin/users.ts' },
      systemActor,
      denyTraceId,
    )
    expect(deny.allowed).toBe(false)

    const denialRows = await db
      .select()
      .from(capabilityDenials)
      .where(eq(capabilityDenials.trace_id, denyTraceId))
    expect(denialRows.length).toBe(1)

    // Revoke
    await authority.revoke(result.capability_id, {
      reason: 'task_complete',
      actor: systemActor,
      trace_id: 'lifecycle-revoke',
    })

    // Revoked verify
    const verify = await authority.verify(result.bundle)
    expect(verify.ok).toBe(false)
    expect(verify.reason_code).toBe('AUTH_CAPABILITY_REVOKED')

    // Grant row status updated to 'revoked'.
    const updated = await db
      .select()
      .from(capabilityGrants)
      .where(eq(capabilityGrants.capability_id, result.capability_id))
    expect(updated[0]?.status).toBe('revoked')

    // Revocation event present.
    const revEvents = await eventStore.query({
      aggregate_type: 'capability',
      aggregate_id: result.capability_id,
      event_type: 'CapabilityRevoked',
    })
    expect(revEvents.items.length).toBe(1)
  })

  it('reuses the active sub-key for the same sprint across issuances', async () => {
    const sprintId = uuidv7()
    const r1 = await authority.issue({
      install_id: installId,
      persona_id: 'senior-developer',
      task_id: uuidv7(),
      sprint_id: sprintId,
      session_id: uuidv7(),
      scopes,
      justification: 'reuse-1',
      actor: systemActor,
      trace_id: 'reuse-1',
    })
    const r2 = await authority.issue({
      install_id: installId,
      persona_id: 'senior-developer',
      task_id: uuidv7(),
      sprint_id: sprintId,
      session_id: uuidv7(),
      scopes,
      justification: 'reuse-2',
      actor: systemActor,
      trace_id: 'reuse-2',
    })
    expect(r1.bundle.signing_key_id).toBe(r2.bundle.signing_key_id)
  })

  it('rotate generates a new sub-key and emits KeyRotated', async () => {
    const sprintId = uuidv7()
    const r1 = await authority.issue({
      install_id: installId,
      persona_id: 'senior-developer',
      task_id: uuidv7(),
      sprint_id: sprintId,
      session_id: uuidv7(),
      scopes,
      justification: 'pre-rotate',
      actor: systemActor,
      trace_id: 'rot-1',
    })

    const { retiredKeyId, newKeyId } = await keyManager.rotate(sprintId, systemActor)
    expect(retiredKeyId).toBe(r1.bundle.signing_key_id)
    expect(newKeyId).not.toBe(retiredKeyId)

    const rotEvents = await eventStore.query({
      aggregate_type: 'system',
      event_type: 'KeyRotated',
    })
    expect(rotEvents.items.some((e) => (e.payload as Record<string, unknown>)['new_key_id'] === newKeyId)).toBe(true)

    // Old key is in 'retired' status.
    const oldRow = await db
      .select()
      .from(signingKeys)
      .where(eq(signingKeys.key_id, retiredKeyId))
    expect(oldRow[0]?.status).toBe('retired')
    expect(oldRow[0]?.active_until).not.toBeNull()
  })

  it('archive zeroizes private and emits KeyArchived', async () => {
    const sprintId = uuidv7()
    await authority.issue({
      install_id: installId,
      persona_id: 'senior-developer',
      task_id: uuidv7(),
      sprint_id: sprintId,
      session_id: uuidv7(),
      scopes,
      justification: 'arch-pre',
      actor: systemActor,
      trace_id: 'arch-pre',
    })

    const sub = await keyManager.getActiveSubKey(sprintId)
    expect(sub).toBeTruthy()
    if (!sub) throw new Error('no sub key')

    await keyManager.archive(sub.keyId, 'sprint_close_30d', systemActor)

    const after = await db
      .select()
      .from(signingKeys)
      .where(eq(signingKeys.key_id, sub.keyId))
    expect(after[0]?.status).toBe('archived')
    expect(after[0]?.private_zeroized_at).not.toBeNull()
    expect(after[0]?.keychain_ref).toBeNull()

    // The keychain entry is gone.
    const shim = await getTestShimKeychain()
    const stillThere = await shim.getPassword(`sub:${sub.keyId}`)
    expect(stillThere).toBeNull()

    const archEvents = await eventStore.query({
      aggregate_type: 'system',
      event_type: 'KeyArchived',
      aggregate_id: sub.keyId,
    })
    expect(archEvents.items.length).toBe(1)
  })

  it('all capability events are present in EventStore (no direct DB inserts)', async () => {
    const sprintId = uuidv7()
    const r = await authority.issue({
      install_id: installId,
      persona_id: 'senior-developer',
      task_id: uuidv7(),
      sprint_id: sprintId,
      session_id: uuidv7(),
      scopes,
      justification: 'event-sourcing-check',
      actor: systemActor,
      trace_id: 'evsrc',
    })
    await authority.validateAndEmit(
      r.bundle,
      'files.read',
      { path: 'src/billing/x.ts' },
      systemActor,
      'evsrc',
    )
    await authority.revoke(r.capability_id, {
      reason: 'task_complete',
      actor: systemActor,
      trace_id: 'evsrc',
    })

    const issued = await eventStore.query({
      aggregate_type: 'capability',
      aggregate_id: r.capability_id,
      event_type: 'CapabilityIssued',
    })
    const granted = await eventStore.query({
      aggregate_type: 'capability',
      aggregate_id: r.capability_id,
      event_type: 'CapabilityGranted',
    })
    const revoked = await eventStore.query({
      aggregate_type: 'capability',
      aggregate_id: r.capability_id,
      event_type: 'CapabilityRevoked',
    })
    expect(issued.items.length).toBe(1)
    expect(granted.items.length).toBeGreaterThanOrEqual(2) // initial + per-call
    expect(revoked.items.length).toBe(1)
  })
})
