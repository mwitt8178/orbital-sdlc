/**
 * authority.test.ts — issuance, verification, revocation lifecycle.
 *
 * These tests use the REAL database (Phase 1A's PostgresEventStore) and
 * the REAL keychain shim. No mocks for the cryptographic or persistence
 * layers — only the upstream Phase 1A interface contract is depended on.
 *
 * If the DB is unreachable, the test file will fail at beforeAll setup;
 * skipping is intentional (we want CI to surface a real DB outage).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { uuidv7 } from 'uuidv7'
import { eq } from 'drizzle-orm'

import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { capabilityGrants, capabilityRevocations, capabilityDenials } from '../../../src/db/schema/capabilities.js'
import { CapabilityAuthority } from '../../../src/capabilities/authority.js'
import { KeyManager } from '../../../src/capabilities/keys.js'
import { resetKeychainCache } from '../../../src/capabilities/keychain.js'
import { resetPolicyCache } from '../../../src/capabilities/policy.js'
import type { Actor, Scopes } from '@orbital/types'
import { OrbitalError } from '@orbital/types'

const eventStore = createEventStore(db, sql)
let installId: string
let keyManager: KeyManager
let authority: CapabilityAuthority

const systemActor: Actor = { type: 'system', component: 'capability_authority' }

const baseScopes: Scopes = {
  files_read: ['src/**'],
  files_write: [],
  board_read: ['ticket:ORB-1'],
  board_mutate: ['ticket:ORB-1.status'],
  channel_read: ['#sprint-1', '#orb-1'],
  channel_post: ['#orb-1'],
  secrets: [],
  network_egress: ['api.anthropic.com'],
  spawn_subagent: false,
  git_commit: [],
  ceremony_role: [],
}

beforeAll(async () => {
  // Sanity: confirm DB connectivity early.
  await sql`SELECT 1`
})

beforeEach(async () => {
  process.env.ORBITAL_TEST_KEYCHAIN = '1'
  resetKeychainCache()
  resetPolicyCache()
  // Fresh install + keychain shim for each test to keep key state isolated.
  const shimPath =
    process.env['ORBITAL_TEST_KEYCHAIN_PATH'] ??
    `${process.env.HOME ?? ''}/.orbital-test-keychain.json`
  await import('node:fs').then(({ promises: fs }) => fs.unlink(shimPath).catch(() => undefined))
  installId = uuidv7()
  keyManager = new KeyManager(installId, eventStore)
  authority = new CapabilityAuthority(eventStore, keyManager)
})

afterAll(async () => {
  await closeDb().catch(() => undefined)
})

describe('CapabilityAuthority.issue', () => {
  it('issues a signed bundle and persists a grant row', async () => {
    const result = await authority.issue({
      install_id: installId,
      persona_id: 'senior-developer',
      task_id: uuidv7(),
      sprint_id: uuidv7(),
      session_id: uuidv7(),
      scopes: baseScopes,
      justification: 'unit-test issue',
      actor: systemActor,
      trace_id: 'test-trace-1',
    })

    expect(result.bundle.capability_id).toBe(result.capability_id)
    expect(result.bundle.signature).toBeTruthy()
    expect(result.bundle.persona_id).toBe('senior-developer')

    // Verify grant row exists.
    const rows = await db
      .select()
      .from(capabilityGrants)
      .where(eq(capabilityGrants.capability_id, result.capability_id))
    expect(rows.length).toBe(1)
    expect(rows[0]?.status).toBe('issued')
  })

  it('verifies its own issued bundle', async () => {
    const result = await authority.issue({
      install_id: installId,
      persona_id: 'senior-developer',
      task_id: uuidv7(),
      sprint_id: uuidv7(),
      session_id: uuidv7(),
      scopes: baseScopes,
      justification: 'verify-self',
      actor: systemActor,
      trace_id: 'test-trace-2',
    })

    const verify = await authority.verify(result.bundle)
    expect(verify.ok).toBe(true)
  })

  it('rejects SoD violation: verifier with files_write', async () => {
    const sprintId = uuidv7()
    await expect(
      authority.issue({
        install_id: installId,
        persona_id: 'verifier',
        task_id: uuidv7(),
        sprint_id: sprintId,
        session_id: uuidv7(),
        scopes: { ...baseScopes, files_write: ['src/billing/**'] },
        justification: 'should-fail',
        actor: systemActor,
        trace_id: 'test-trace-sod',
      }),
    ).rejects.toBeInstanceOf(OrbitalError)
  })

  it('emits CapabilityDenied for SoD violation', async () => {
    const sprintId = uuidv7()
    const traceId = `test-trace-sod-emit-${uuidv7()}`
    try {
      await authority.issue({
        install_id: installId,
        persona_id: 'verifier',
        task_id: uuidv7(),
        sprint_id: sprintId,
        session_id: uuidv7(),
        scopes: { ...baseScopes, files_write: ['src/billing/**'] },
        justification: 'should-emit-denial',
        actor: systemActor,
        trace_id: traceId,
      })
    } catch {
      /* expected */
    }

    const denials = await db
      .select()
      .from(capabilityDenials)
      .where(eq(capabilityDenials.trace_id, traceId))
    expect(denials.length).toBe(1)
    expect(denials[0]?.reason_code).toBe('AUTH_SOD_VIOLATION')
  })

  it('requires justification', async () => {
    await expect(
      authority.issue({
        install_id: installId,
        persona_id: 'senior-developer',
        task_id: uuidv7(),
        sprint_id: uuidv7(),
        session_id: uuidv7(),
        scopes: baseScopes,
        justification: '',
        actor: systemActor,
        trace_id: 'test-trace-just',
      }),
    ).rejects.toThrow(/justification is required/)
  })
})

describe('CapabilityAuthority.verify', () => {
  it('rejects an expired bundle', async () => {
    const past = new Date(Date.now() - 60_000)
    const result = await authority.issue({
      install_id: installId,
      persona_id: 'senior-developer',
      task_id: uuidv7(),
      sprint_id: uuidv7(),
      session_id: uuidv7(),
      scopes: baseScopes,
      ttl_ms: 1, // tiny TTL
      justification: 'expiry-test',
      actor: systemActor,
      trace_id: 'test-trace-exp',
      now: past,
    })

    const verify = await authority.verify(result.bundle, new Date())
    expect(verify.ok).toBe(false)
    expect(verify.reason_code).toBe('AUTH_CAPABILITY_EXPIRED')
  })

  it('rejects a tampered bundle', async () => {
    const result = await authority.issue({
      install_id: installId,
      persona_id: 'senior-developer',
      task_id: uuidv7(),
      sprint_id: uuidv7(),
      session_id: uuidv7(),
      scopes: baseScopes,
      justification: 'tamper-test',
      actor: systemActor,
      trace_id: 'test-trace-tamper',
    })

    const tampered = { ...result.bundle, persona_id: 'attacker' }
    const verify = await authority.verify(tampered)
    expect(verify.ok).toBe(false)
    expect(verify.reason_code).toBe('AUTH_INVALID_SIGNATURE')
  })

  it('rejects malformed bundle', async () => {
    const verify = await authority.verify({ wrong: 'shape' } as never)
    expect(verify.ok).toBe(false)
    expect(verify.reason_code).toBe('AUTH_INVALID_CAPABILITY_FORMAT')
  })
})

describe('CapabilityAuthority.revoke', () => {
  it('writes revocation row + emits CapabilityRevoked', async () => {
    const result = await authority.issue({
      install_id: installId,
      persona_id: 'senior-developer',
      task_id: uuidv7(),
      sprint_id: uuidv7(),
      session_id: uuidv7(),
      scopes: baseScopes,
      justification: 'revoke-test',
      actor: systemActor,
      trace_id: 'test-trace-rev',
    })

    await authority.revoke(result.capability_id, {
      reason: 'task_complete',
      actor: systemActor,
      trace_id: 'test-trace-rev2',
    })

    const revs = await db
      .select()
      .from(capabilityRevocations)
      .where(eq(capabilityRevocations.capability_id, result.capability_id))
    expect(revs.length).toBe(1)

    // Subsequent verify fails with AUTH_CAPABILITY_REVOKED.
    const verify = await authority.verify(result.bundle)
    expect(verify.ok).toBe(false)
    expect(verify.reason_code).toBe('AUTH_CAPABILITY_REVOKED')
  })

  it('is idempotent', async () => {
    const result = await authority.issue({
      install_id: installId,
      persona_id: 'senior-developer',
      task_id: uuidv7(),
      sprint_id: uuidv7(),
      session_id: uuidv7(),
      scopes: baseScopes,
      justification: 'revoke-idempotent',
      actor: systemActor,
      trace_id: 'test-trace-rev-idem',
    })

    await authority.revoke(result.capability_id, {
      reason: 'task_complete',
      actor: systemActor,
      trace_id: 't1',
    })
    await authority.revoke(result.capability_id, {
      reason: 'task_complete',
      actor: systemActor,
      trace_id: 't2',
    })

    const revs = await db
      .select()
      .from(capabilityRevocations)
      .where(eq(capabilityRevocations.capability_id, result.capability_id))
    expect(revs.length).toBe(1)
  })

  it('fails for unknown capability', async () => {
    await expect(
      authority.revoke(uuidv7(), {
        reason: 'admin_action',
        actor: systemActor,
        trace_id: 'unknown',
      }),
    ).rejects.toBeInstanceOf(OrbitalError)
  })
})

describe('CapabilityAuthority.hasScope', () => {
  it('returns true for granted file path', async () => {
    const result = await authority.issue({
      install_id: installId,
      persona_id: 'senior-developer',
      task_id: uuidv7(),
      sprint_id: uuidv7(),
      session_id: uuidv7(),
      scopes: { ...baseScopes, files_read: ['src/billing/**'] },
      justification: 'scope-check',
      actor: systemActor,
      trace_id: 'test-trace-scope',
    })

    expect(authority.hasScope(result.bundle, 'files_read', 'src/billing/x.ts')).toBe(true)
    expect(authority.hasScope(result.bundle, 'files_read', 'src/admin/y.ts')).toBe(false)
  })

  it('returns true for exact secret match', async () => {
    const result = await authority.issue({
      install_id: installId,
      persona_id: 'senior-developer',
      task_id: uuidv7(),
      sprint_id: uuidv7(),
      session_id: uuidv7(),
      scopes: { ...baseScopes, secrets: ['stripe.api_key'] },
      justification: 'secrets-check',
      actor: systemActor,
      trace_id: 'test-trace-secret',
    })
    expect(authority.hasScope(result.bundle, 'secrets', 'stripe.api_key')).toBe(true)
    expect(authority.hasScope(result.bundle, 'secrets', 'github.token')).toBe(false)
  })
})

describe('CapabilityAuthority.validateAndEmit', () => {
  it('emits CapabilityGranted on allow', async () => {
    const allowTraceId = `trace-allow-${uuidv7()}`
    const result = await authority.issue({
      install_id: installId,
      persona_id: 'senior-developer',
      task_id: uuidv7(),
      sprint_id: uuidv7(),
      session_id: uuidv7(),
      scopes: { ...baseScopes, files_read: ['src/billing/**'] },
      justification: 'validate-allow',
      actor: systemActor,
      trace_id: 'test-trace-validate',
    })

    const r = await authority.validateAndEmit(
      result.bundle,
      'files.read',
      { path: 'src/billing/invoice.ts' },
      systemActor,
      allowTraceId,
    )
    expect(r.allowed).toBe(true)

    const granted = await eventStore.query({
      aggregate_type: 'capability',
      event_type: 'CapabilityGranted',
      trace_id: allowTraceId,
    })
    expect(granted.items.length).toBeGreaterThan(0)
  })

  it('writes denial row + emits CapabilityDenied on deny', async () => {
    const denyTraceId = `trace-deny-${uuidv7()}`
    const result = await authority.issue({
      install_id: installId,
      persona_id: 'senior-developer',
      task_id: uuidv7(),
      sprint_id: uuidv7(),
      session_id: uuidv7(),
      scopes: { ...baseScopes, files_read: ['src/billing/**'] },
      justification: 'validate-deny',
      actor: systemActor,
      trace_id: 'test-trace-validate-deny',
    })

    const r = await authority.validateAndEmit(
      result.bundle,
      'files.read',
      { path: 'src/admin/users.ts' },
      systemActor,
      denyTraceId,
    )
    expect(r.allowed).toBe(false)

    const denials = await db
      .select()
      .from(capabilityDenials)
      .where(eq(capabilityDenials.trace_id, denyTraceId))
    expect(denials.length).toBe(1)
    expect(denials[0]?.reason_code).toBe('AUTH_SCOPE_DENIED')
  })
})
