/**
 * engine.integration.test.ts — Integration tests for HookEngine + VerifierService.
 *
 * Per task spec "Done criteria":
 * 1. pre-commit hook blocks out-of-scope write → HookRejected, no AgentCommitted in events
 * 2. post-task hook triggers real verifier spawn (fake-verifier fixture) → verification cycle
 * 3. All events visible in DB (via EventStore.append only)
 *
 * Uses real Postgres.
 * For verifier spawn: CLAUDE_BIN=node, extraArgs=[fake-verifier.mjs path]
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { uuidv7 } from 'uuidv7'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { db, sql } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { HookEngine } from '../../../src/hooks/engine.js'
import { VerifierServiceImpl } from '../../../src/verifiers/service.js'
import { createPostTaskHook } from '../../../src/hooks/baseline/post-task.js'
import preCommitHook from '../../../src/hooks/baseline/pre-commit.js'
import type { HookDefinition, HookContext } from '../../../src/hooks/types.js'
import { events } from '../../../src/db/schema/events.js'
import {
  hooks as hooksTable,
  hookVersions,
  verifications,
} from '../../../src/db/schema/determinism.js'
import { eq, and } from 'drizzle-orm'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FAKE_VERIFIER_PATH = path.resolve(
  __dirname,
  '../../fixtures/fake-verifier.mjs',
)

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let eventStore: ReturnType<typeof createEventStore>
let engine: HookEngine
let verifierService: VerifierServiceImpl

beforeAll(async () => {
  eventStore = createEventStore(db, sql)
})

beforeEach(async () => {
  verifierService = new VerifierServiceImpl(eventStore, db)
  engine = new HookEngine(eventStore)
})

afterAll(async () => {
  await sql.end()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedHookRow(
  hookId: string,
  versionId: string,
  slug: string,
  timing: 'pre' | 'post',
): Promise<{ hookId: string; versionId: string }> {
  // Check if hook already exists by slug (unique constraint)
  const existing = await db
    .select()
    .from(hooksTable)
    .where(eq(hooksTable.hook_slug, slug))
    .limit(1)

  if (existing[0]) {
    // Return existing ids so tests can reference them
    return { hookId: existing[0].hook_id, versionId: existing[0].current_version_id }
  }

  await db.insert(hooksTable).values({
    hook_id: hookId,
    hook_slug: slug,
    description: `Integration test hook: ${slug}`,
    current_version_id: versionId,
    enabled: true,
    created_at: new Date(),
    updated_at: new Date(),
  })

  await db.insert(hookVersions).values({
    hook_version_id: versionId,
    hook_id: hookId,
    version: 1,
    source_sha256: 'integration-test-sha256',
    source_text: '// integration test',
    applies_to_event_types: ['AgentCommitted', 'TaskCompleted'],
    timing,
    declared_order: 100,
    shipped_at: new Date(),
  })

  return { hookId, versionId }
}

function makeContext(overrides?: Partial<HookContext>): HookContext {
  return {
    trace_id: uuidv7(),
    actor: { type: 'system', component: 'orchestrator' },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe('HookEngine integration', () => {
  describe('pre-commit hook blocks out-of-scope write', () => {
    it('rejects AgentCommitted with file outside files_write_scope', async () => {
      const slug = preCommitHook.slug
      const { hookId, versionId: vId } = await seedHookRow(uuidv7(), uuidv7(), slug, 'pre')

      // Wrap the baseline pre-commit hook spec into a HookDefinition
      const hookDef: HookDefinition = {
        hook_id: hookId,
        hook_version_id: vId,
        slug,
        description: preCommitHook.description,
        applies_to: preCommitHook.appliesTo,
        timing: preCommitHook.timing,
        declared_order: preCommitHook.declaredOrder,
        error_code: preCommitHook.errorCode,
        enabled: true,
        validator: (payload, ctx) => preCommitHook.validator(payload as Parameters<typeof preCommitHook.validator>[0], ctx),
      }
      engine.register(hookDef)

      const traceId = uuidv7()
      const ctx = makeContext({ trace_id: traceId })

      // Payload: file outside scope
      const payload = {
        commit_message: 'ORB-100: add billing webhook',
        ticket_id: 'ORB-100',
        files_changed: ['src/billing/webhooks.ts', 'src/secrets/prod.key'],
        files_write_scope: ['src/billing/**'],
      }

      const result = await engine.fire('AgentCommitted', payload, ctx, 'pre')

      expect(result.allow).toBe(false)
      if (!result.allow) {
        expect(result.error_code).toBe('HOOK_REJECTED_PRE_COMMIT')
      }

      // Wait for events to be written
      await new Promise((r) => setTimeout(r, 100))

      // Assert: HookRejected event exists in DB
      const rejectedEvents = await db
        .select()
        .from(events)
        .where(and(eq(events.traceId, traceId), eq(events.eventType, 'HookRejected')))

      expect(rejectedEvents.length).toBe(1)
      expect(rejectedEvents[0]!.payload['error_code']).toBe('HOOK_REJECTED_PRE_COMMIT')

      // Assert: no AgentCommitted event (action was blocked)
      const committedEvents = await db
        .select()
        .from(events)
        .where(and(eq(events.traceId, traceId), eq(events.eventType, 'AgentCommitted')))

      expect(committedEvents.length).toBe(0)
    })

    it('allows AgentCommitted with all files within scope', async () => {
      const uniqueSuffix = uuidv7().slice(0, 8)
      const slug = `${preCommitHook.slug}-allow-${uniqueSuffix}`
      const { hookId, versionId: vId } = await seedHookRow(uuidv7(), uuidv7(), slug, 'pre')

      const hookDef: HookDefinition = {
        hook_id: hookId,
        hook_version_id: vId,
        slug,
        description: preCommitHook.description,
        applies_to: ['AgentCommittedAllow'],
        timing: 'pre',
        declared_order: 100,
        error_code: preCommitHook.errorCode,
        enabled: true,
        validator: (payload, ctx) => preCommitHook.validator(payload as Parameters<typeof preCommitHook.validator>[0], ctx),
      }
      engine.register(hookDef)

      const ctx = makeContext()
      const payload = {
        commit_message: 'ORB-101: add billing service',
        ticket_id: 'ORB-101',
        files_changed: ['src/billing/service.ts'],
        files_write_scope: ['src/billing/**'],
      }

      const result = await engine.fire('AgentCommittedAllow', payload, ctx, 'pre')
      expect(result.allow).toBe(true)
    })
  })

  describe('post-task hook triggers verifier spawn', () => {
    it('post-task hook causes VerifierStarted event when ready_for_verification=true', async () => {
      const uniqueSuffix = uuidv7().slice(0, 8)
      const slug = `post-task-trigger-verifier-int-${uniqueSuffix}`
      const { hookId, versionId: vId } = await seedHookRow(uuidv7(), uuidv7(), slug, 'post')

      const postTaskHookSpec = createPostTaskHook(verifierService)

      const hookDef: HookDefinition = {
        hook_id: hookId,
        hook_version_id: vId,
        slug,
        description: postTaskHookSpec.description,
        applies_to: postTaskHookSpec.appliesTo,
        timing: postTaskHookSpec.timing,
        declared_order: postTaskHookSpec.declaredOrder,
        error_code: postTaskHookSpec.errorCode,
        enabled: true,
        validator: (payload, ctx) =>
          postTaskHookSpec.validator(payload as Parameters<typeof postTaskHookSpec.validator>[0], ctx),
      }
      engine.register(hookDef)

      const taskId = uuidv7()
      const traceId = uuidv7()
      const ctx = makeContext({ trace_id: traceId })

      const payload = {
        task_id: taskId,
        ticket_id: 'ORB-200',
        ready_for_verification: true,
        artifact_paths: ['src/billing/webhooks.ts'],
        summary: 'Task completed all requirements',
      }

      const result = await engine.fire('TaskCompleted', payload, ctx, 'post')
      expect(result.allow).toBe(true)

      // Wait for async verifier spawn + event writes
      await new Promise((r) => setTimeout(r, 200))

      // Assert: VerifierStarted event exists
      const startedEvents = await db
        .select()
        .from(events)
        .where(eq(events.eventType, 'VerifierStarted'))

      // Find an event related to our task
      const ourEvent = startedEvents.find((e) => e.payload['task_id'] === taskId)
      expect(ourEvent).toBeTruthy()

      // Assert: verifications row exists with status='running'
      const verRows = await db
        .select()
        .from(verifications)
        .where(eq(verifications.task_id, taskId))

      expect(verRows.length).toBe(1)
      expect(verRows[0]!.status).toBe('running')
    })
  })

  describe('SoD enforcement at CBAC layer', () => {
    it('rejects capability issuance with same persona as task (AUTH_SOD_VIOLATION)', async () => {
      const taskId = uuidv7()
      const ticketId = 'ORB-400'

      // spawnVerifier with verifierPersonaId matching actingPersonaId → SoD violation
      await expect(
        verifierService.spawnVerifier(
          taskId,
          ticketId,
          ['src/billing/webhooks.ts'],
          'verifier',
          { verifierPersonaId: 'verifier' },
        ),
      ).rejects.toThrow('AUTH_SOD_VIOLATION')
    })

    it('allows verifier spawn when personas differ', async () => {
      const taskId = uuidv7()
      const ticketId = 'ORB-401'

      const verificationId = await verifierService.spawnVerifier(
        taskId,
        ticketId,
        ['src/billing/webhooks.ts'],
        'sr-dev', // acting persona (task executor)
        { verifierPersonaId: 'qa' }, // distinct verifier persona
      )

      expect(verificationId).toBeTruthy()
    })
  })
})
