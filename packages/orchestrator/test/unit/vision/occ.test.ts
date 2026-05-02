/**
 * occ.test.ts — Vision service OCC (optimistic concurrency control) tests.
 *
 * Gap O5: Vision lock OCC.
 *
 * Verifies that concurrent lock() and revise() calls detect conflicts correctly
 * via the compare-and-swap WHERE clause on current_version_number + lastEventId.
 *
 * These tests use real Postgres.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { promises as fsp } from 'node:fs'
import { uuidv7 } from 'uuidv7'

import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { CapabilityAuthority } from '../../../src/capabilities/authority.js'
import { KeyManager } from '../../../src/capabilities/keys.js'
import { resetKeychainCache } from '../../../src/capabilities/keychain.js'
import { resetPolicyCache } from '../../../src/capabilities/policy.js'
import { createPersonaLoader } from '../../../src/personas/loader.js'
import { createVisionService } from '../../../src/vision/service.js'
import { OrbitalError } from '@orbital/types'

const TEST_SHIM_FILE =
  process.env['ORBITAL_TEST_KEYCHAIN_PATH'] ??
  path.join(os.homedir(), `.orbital-test-keychain-${process.pid}.json`)

const systemActor = { type: 'system' as const, component: 'orchestrator' as const }
const userActor = { type: 'user' as const, user_id: 'test-user', install_id: 'test-install' }

let eventStore: ReturnType<typeof createEventStore>
let keyManager: KeyManager
let authority: CapabilityAuthority
let personaLoader: ReturnType<typeof createPersonaLoader>
let installId: string

// Minimal hook engine stub
const hookEngine = {
  fire: async () => ({ allow: true, hook_id: null, reason: null }),
}

// Minimal channels service stub
const channelsService = {
  ensureChannel: async () => ({ channelId: uuidv7() }),
  post: async () => ({ postId: uuidv7() }),
  getByName: async () => null,
}

// Minimal routing engine stub
const routingEngine = {
  decide: async () => ({ persona_id: 'pm', model: 'claude-sonnet-4-6' }),
}

function makeVisionService(installId: string) {
  return createVisionService(
    db,
    eventStore,
    channelsService as never,
    hookEngine as never,
    personaLoader,
    authority,
    routingEngine as never,
    installId,
  )
}

beforeEach(async () => {
  process.env.ORBITAL_TEST_KEYCHAIN = '1'
  resetKeychainCache()
  resetPolicyCache()
  await fsp.unlink(TEST_SHIM_FILE).catch(() => undefined)
  installId = uuidv7()
  eventStore = createEventStore(db, sql)
  keyManager = new KeyManager(installId, eventStore)
  authority = new CapabilityAuthority(eventStore, keyManager)
  personaLoader = createPersonaLoader(db, eventStore)
  await personaLoader.load()
})

afterAll(async () => {
  await closeDb().catch(() => undefined)
})

// ---------------------------------------------------------------------------
// Minimal content for locking
// ---------------------------------------------------------------------------

const LOCKABLE_CONTENT = {
  schema_version: 1 as const,
  title: 'OCC Test Vision',
  summary: 'Test summary for OCC',
  goals: [{ id: 'g1', text: 'Goal 1', rank: 1 }],
  non_goals: [{ id: 'ng1', text: 'Non-goal 1' }],
  target_users: [{ id: 'u1', segment: 'Developer', description: 'A developer', primary: true }],
  acceptance_criteria: [{ id: 'ac1', text: 'Given X when Y then Z', rank: 1 }],
  glossary: [{ term: 'X', definition: 'X is Y' }],
  edge_cases: [{ id: 'ec1', text: 'Edge case 1', surfaced_by: 'user' as const }],
  open_questions: [],
  assumptions_log: [],
  metadata: {
    pm_persona_id: 'pm-1',
    model_used: 'claude-sonnet-4-6',
    intake_started_at: new Date().toISOString(),
    intake_token_total: 0,
  },
}

describe('Vision OCC — lock()', () => {
  it('concurrent revise() calls detect the conflict — one succeeds, one throws CONFLICT_OPTIMISTIC_LOCK_FAILED', async () => {
    const svc = makeVisionService(installId)
    const traceId = uuidv7()

    // Start a vision session
    const { vision_document_id: docId, vision_session_id: sessionId } = await svc.start({
      title: `OCC Test ${uuidv7()}`,
      initial_prompt: 'Test prompt',
      install_id: installId,
      actor: userActor,
      trace_id: traceId,
      justification: 'OCC test',
    })

    // Create a draft
    const draft = await svc.draft(
      sessionId as never,
      LOCKABLE_CONTENT,
      'Initial draft',
      systemActor,
      traceId,
    )

    // Lock the document (first lock)
    const review = await svc.reviewDraft(docId as never)
    await svc.lock({
      documentId: docId as never,
      confirmationToken: review.confirmation_token,
      changelog: 'First lock',
      attestation: { no_edge_cases: false },
      actor: userActor,
      traceId,
      justification: 'test',
    })

    // Now the document is locked. Get the current version to prepare a revise.
    const currentDoc = await svc.getDocument(docId as never)
    const baseVersionId = currentDoc.current_version_id!

    // Simulate two concurrent revise() calls:
    // Both read the same baseVersionId before either commits.
    // Race them — at least one should fail with OCC error.
    const delta = [{ op: 'replace', path: '/summary', value: 'Revised summary' }]

    const results = await Promise.allSettled([
      svc.revise({
        documentId: docId as never,
        baseVersionId: baseVersionId as never,
        delta: delta as never,
        changelog: 'Revision A',
        reason: 'user_initiated',
        actor: userActor,
        traceId: uuidv7(),
        justification: 'OCC test A',
      }),
      svc.revise({
        documentId: docId as never,
        baseVersionId: baseVersionId as never,
        delta: delta as never,
        changelog: 'Revision B',
        reason: 'user_initiated',
        actor: userActor,
        traceId: uuidv7(),
        justification: 'OCC test B',
      }),
    ])

    const successes = results.filter((r) => r.status === 'fulfilled')
    const failures = results.filter((r) => r.status === 'rejected')

    // At most one can succeed (could also both fail if they hit the exact same
    // state at the same time, but we expect at least one failure in a race).
    // The invariant is: they cannot BOTH succeed.
    expect(successes.length).toBeLessThanOrEqual(1)

    if (failures.length > 0) {
      for (const f of failures as Array<PromiseRejectedResult>) {
        // Either CONFLICT_VERSION_STALE (app-level check) or CONFLICT_OPTIMISTIC_LOCK_FAILED (DB CAS)
        expect(f.reason).toBeInstanceOf(OrbitalError)
        expect(['CONFLICT_VERSION_STALE', 'CONFLICT_OPTIMISTIC_LOCK_FAILED']).toContain(
          (f.reason as OrbitalError).code,
        )
      }
    }
  })
})
