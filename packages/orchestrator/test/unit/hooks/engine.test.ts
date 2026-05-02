/**
 * engine.test.ts — Unit tests for HookEngine.
 *
 * Per TRD-09 §15.1:
 * - Hook engine dispatch: all hooks run in declared_order; first rejection short-circuits.
 * - Fail-closed: exception in hook → HOOK_INTERNAL_ERROR rejection.
 * - All firings produce HookFired events; pass → HookPassed; reject → HookRejected.
 * - Disabled hooks are skipped.
 *
 * Uses real Postgres for event assertions.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { uuidv7 } from 'uuidv7'
import { eq, and, inArray } from 'drizzle-orm'
import { db, sql } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { HookEngine } from '../../../src/hooks/engine.js'
import type { HookDefinition, HookContext } from '../../../src/hooks/types.js'
import { events } from '../../../src/db/schema/events.js'
import {
  hooks as hooksTable,
  hookVersions,
  hookInvocations,
} from '../../../src/db/schema/determinism.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides?: Partial<HookContext>): HookContext {
  return {
    trace_id: uuidv7(),
    actor: { type: 'system', component: 'orchestrator' },
    ...overrides,
  }
}

/**
 * Seed a hooks + hook_versions row in the DB.
 * Checks by slug first to avoid FK violation from onConflictDoNothing.
 * Returns the actual hookId and versionId to use.
 */
async function seedHookRow(
  hookId: string,
  versionId: string,
  slug: string,
): Promise<{ hookId: string; versionId: string }> {
  const existing = await db
    .select()
    .from(hooksTable)
    .where(eq(hooksTable.hook_slug, slug))
    .limit(1)

  if (existing[0]) {
    return { hookId: existing[0].hook_id, versionId: existing[0].current_version_id }
  }

  await db.insert(hooksTable).values({
    hook_id: hookId,
    hook_slug: slug,
    description: `Test hook: ${slug}`,
    current_version_id: versionId,
    enabled: true,
    created_at: new Date(),
    updated_at: new Date(),
  })

  await db.insert(hookVersions).values({
    hook_version_id: versionId,
    hook_id: hookId,
    version: 1,
    source_sha256: 'abc123',
    source_text: '// test',
    applies_to_event_types: ['TestEvent'],
    timing: 'pre',
    declared_order: 100,
    shipped_at: new Date(),
  })

  return { hookId, versionId }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let eventStore: ReturnType<typeof createEventStore>
let engine: HookEngine

beforeAll(async () => {
  eventStore = createEventStore(db, sql)
})

beforeEach(async () => {
  engine = new HookEngine(eventStore)
})

afterAll(async () => {
  await sql.end()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HookEngine', () => {
  describe('fire() with no registered hooks', () => {
    it('returns allow:true when no hooks registered for event type', async () => {
      const ctx = makeContext()
      const result = await engine.fire('UnknownEventType', {}, ctx, 'pre')
      expect(result.allow).toBe(true)
    })
  })

  describe('fire() with passing hooks', () => {
    it('runs all hooks in declared_order and returns allow:true', async () => {
      const executionOrder: number[] = []

      const slug1 = `pass-hook-order-10-${uuidv7().slice(0, 8)}`
      const slug2 = `pass-hook-order-50-${uuidv7().slice(0, 8)}`
      const { hookId: hId1, versionId: vId1 } = await seedHookRow(uuidv7(), uuidv7(), slug1)
      const { hookId: hId2, versionId: vId2 } = await seedHookRow(uuidv7(), uuidv7(), slug2)

      const h1: HookDefinition = {
        hook_id: hId1,
        hook_version_id: vId1,
        slug: slug1,
        description: 'test hook order 10',
        applies_to: ['OrderTestEvent'],
        timing: 'pre',
        declared_order: 10,
        error_code: 'HOOK_REJECTED_GENERIC',
        enabled: true,
        validator: () => { executionOrder.push(10); return { allow: true } },
      }
      const h2: HookDefinition = {
        hook_id: hId2,
        hook_version_id: vId2,
        slug: slug2,
        description: 'test hook order 50',
        applies_to: ['OrderTestEvent'],
        timing: 'pre',
        declared_order: 50,
        error_code: 'HOOK_REJECTED_GENERIC',
        enabled: true,
        validator: () => { executionOrder.push(50); return { allow: true } },
      }

      engine.register(h2) // register out of order
      engine.register(h1)

      const ctx = makeContext()
      const result = await engine.fire('OrderTestEvent', { test: true }, ctx, 'pre')

      expect(result.allow).toBe(true)
      expect(executionOrder).toEqual([10, 50]) // sorted by declared_order
    })

    it('emits HookFired and HookPassed events for passing hook', async () => {
      const slug = `passing-hook-${uuidv7().slice(0, 8)}`
      const { hookId, versionId: vId } = await seedHookRow(uuidv7(), uuidv7(), slug)

      const hook: HookDefinition = {
        hook_id: hookId,
        hook_version_id: vId,
        slug,
        description: 'test passing hook',
        applies_to: ['PassingTestEvent'],
        timing: 'pre',
        declared_order: 100,
        error_code: 'HOOK_REJECTED_GENERIC',
        enabled: true,
        validator: () => ({ allow: true }),
      }
      engine.register(hook)

      const ctx = makeContext()
      const traceId = ctx.trace_id
      await engine.fire('PassingTestEvent', { data: 'test' }, ctx, 'pre')

      // Wait briefly for background event writes
      await new Promise((r) => setTimeout(r, 100))

      const firedEvents = await db
        .select()
        .from(events)
        .where(and(eq(events.traceId, traceId), inArray(events.eventType, ['HookFired'])))

      const passedEvents = await db
        .select()
        .from(events)
        .where(and(eq(events.traceId, traceId), inArray(events.eventType, ['HookPassed'])))

      expect(firedEvents.length).toBe(1)
      expect(firedEvents[0]!.payload['decision']).toBe('allow')
      expect(passedEvents.length).toBe(1)
    })
  })

  describe('fire() with rejecting hooks', () => {
    it('short-circuits on first rejection and returns allow:false', async () => {
      let secondHookCalled = false

      const slug1 = `reject-first-${uuidv7().slice(0, 8)}`
      const slug2 = `reject-second-${uuidv7().slice(0, 8)}`
      const { hookId: hId1, versionId: vId1 } = await seedHookRow(uuidv7(), uuidv7(), slug1)
      const { hookId: hId2, versionId: vId2 } = await seedHookRow(uuidv7(), uuidv7(), slug2)

      const h1: HookDefinition = {
        hook_id: hId1,
        hook_version_id: vId1,
        slug: slug1,
        description: 'first hook that rejects',
        applies_to: ['RejectTestEvent'],
        timing: 'pre',
        declared_order: 10,
        error_code: 'HOOK_REJECTED_PRE_COMMIT',
        enabled: true,
        validator: () => ({ allow: false, reason: 'first hook rejected' }),
      }
      const h2: HookDefinition = {
        hook_id: hId2,
        hook_version_id: vId2,
        slug: slug2,
        description: 'second hook (should not run)',
        applies_to: ['RejectTestEvent'],
        timing: 'pre',
        declared_order: 20,
        error_code: 'HOOK_REJECTED_GENERIC',
        enabled: true,
        validator: () => { secondHookCalled = true; return { allow: true } },
      }
      engine.register(h1)
      engine.register(h2)

      const ctx = makeContext()
      const result = await engine.fire('RejectTestEvent', {}, ctx, 'pre')

      expect(result.allow).toBe(false)
      if (!result.allow) {
        expect(result.error_code).toBe('HOOK_REJECTED_PRE_COMMIT')
        expect(result.reason).toBe('first hook rejected')
        expect(result.hook_id).toBe(hId1)
      }
      expect(secondHookCalled).toBe(false)
    })

    it('emits HookFired(reject) and HookRejected events, not HookPassed', async () => {
      const slug = `rejecting-hook-${uuidv7().slice(0, 8)}`
      const { hookId, versionId: vId } = await seedHookRow(uuidv7(), uuidv7(), slug)

      const hook: HookDefinition = {
        hook_id: hookId,
        hook_version_id: vId,
        slug,
        description: 'rejecting hook',
        applies_to: ['RejectEventType'],
        timing: 'pre',
        declared_order: 100,
        error_code: 'HOOK_REJECTED_PRE_COMMIT',
        enabled: true,
        validator: () => ({ allow: false, reason: 'test rejection' }),
      }
      engine.register(hook)

      const ctx = makeContext()
      const traceId = ctx.trace_id
      await engine.fire('RejectEventType', { test: 1 }, ctx, 'pre')

      await new Promise((r) => setTimeout(r, 100))

      const firedEvents = await db
        .select()
        .from(events)
        .where(and(eq(events.traceId, traceId), eq(events.eventType, 'HookFired')))

      const rejectedEvents = await db
        .select()
        .from(events)
        .where(and(eq(events.traceId, traceId), eq(events.eventType, 'HookRejected')))

      const passedEvents = await db
        .select()
        .from(events)
        .where(and(eq(events.traceId, traceId), eq(events.eventType, 'HookPassed')))

      expect(firedEvents.length).toBe(1)
      expect(firedEvents[0]!.payload['decision']).toBe('reject')
      expect(rejectedEvents.length).toBe(1)
      expect(passedEvents.length).toBe(0)
    })
  })

  describe('fail-closed on exception', () => {
    it('returns HOOK_INTERNAL_ERROR when hook validator throws', async () => {
      const slug = `throwing-hook-${uuidv7().slice(0, 8)}`
      const { hookId, versionId: vId } = await seedHookRow(uuidv7(), uuidv7(), slug)

      const hook: HookDefinition = {
        hook_id: hookId,
        hook_version_id: vId,
        slug,
        description: 'throwing hook',
        applies_to: ['ThrowTestEvent'],
        timing: 'pre',
        declared_order: 100,
        error_code: 'HOOK_REJECTED_GENERIC',
        enabled: true,
        validator: () => { throw new Error('validator exploded') },
      }
      engine.register(hook)

      const ctx = makeContext()
      const result = await engine.fire('ThrowTestEvent', {}, ctx, 'pre')

      expect(result.allow).toBe(false)
      if (!result.allow) {
        expect(result.error_code).toBe('HOOK_INTERNAL_ERROR')
        expect(result.reason).toContain('validator exploded')
      }
    })
  })

  describe('disabled hooks are skipped', () => {
    it('skips a hook with enabled=false', async () => {
      const slug = `disabled-hook-${uuidv7().slice(0, 8)}`
      const { hookId, versionId: vId } = await seedHookRow(uuidv7(), uuidv7(), slug)

      let called = false
      const hook: HookDefinition = {
        hook_id: hookId,
        hook_version_id: vId,
        slug,
        description: 'disabled hook',
        applies_to: ['DisabledHookEvent'],
        timing: 'pre',
        declared_order: 100,
        error_code: 'HOOK_REJECTED_GENERIC',
        enabled: false,
        validator: () => { called = true; return { allow: false, reason: 'should not run' } },
      }
      engine.register(hook)

      const ctx = makeContext()
      const result = await engine.fire('DisabledHookEvent', {}, ctx, 'pre')

      expect(result.allow).toBe(true)
      expect(called).toBe(false)
    })
  })

  describe('timing isolation', () => {
    it('pre hooks do not run for post firing and vice versa', async () => {
      const slug = `pre-only-hook-${uuidv7().slice(0, 8)}`
      const { hookId, versionId: vId } = await seedHookRow(uuidv7(), uuidv7(), slug)

      let callCount = 0
      const hook: HookDefinition = {
        hook_id: hookId,
        hook_version_id: vId,
        slug,
        description: 'pre-only hook',
        applies_to: ['TimingTestEvent'],
        timing: 'pre',
        declared_order: 100,
        error_code: 'HOOK_REJECTED_GENERIC',
        enabled: true,
        validator: () => { callCount++; return { allow: true } },
      }
      engine.register(hook)

      const ctx = makeContext()
      // post firing: pre hook should not run
      await engine.fire('TimingTestEvent', {}, ctx, 'post')
      expect(callCount).toBe(0)

      // pre firing: hook runs
      await engine.fire('TimingTestEvent', {}, ctx, 'pre')
      expect(callCount).toBe(1)
    })
  })

  describe('hook_invocations row', () => {
    it('writes a hook_invocations row for each firing', async () => {
      const slug = `invocation-row-${uuidv7().slice(0, 8)}`
      const { hookId, versionId: vId } = await seedHookRow(uuidv7(), uuidv7(), slug)

      const hook: HookDefinition = {
        hook_id: hookId,
        hook_version_id: vId,
        slug,
        description: 'invocation row test hook',
        applies_to: ['InvocationRowEvent'],
        timing: 'pre',
        declared_order: 100,
        error_code: 'HOOK_REJECTED_GENERIC',
        enabled: true,
        validator: () => ({ allow: true }),
      }
      engine.register(hook)

      const ctx = makeContext()
      await engine.fire('InvocationRowEvent', { x: 1 }, ctx, 'pre')

      // Wait for background write
      await new Promise((r) => setTimeout(r, 150))

      const rows = await db
        .select()
        .from(hookInvocations)
        .where(eq(hookInvocations.hook_id, hookId))

      expect(rows.length).toBeGreaterThanOrEqual(1)
      const row = rows[rows.length - 1]!
      expect(row.decision).toBe('allow')
      expect(row.hook_version_id).toBe(vId)
      expect(row.event_type).toBe('InvocationRowEvent')
    })
  })
})
