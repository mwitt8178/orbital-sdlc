/**
 * hooks/engine.ts — HookEngine: fail-closed hook dispatch.
 *
 * Per TRD-09 §6.2.1, §6.2.2.
 *
 * Algorithm (§6.2.2):
 *  1. Look up all hooks for (eventType, timing) sorted by declared_order ASC, then hook_id ASC.
 *  2. For each enabled hook:
 *     a. Call validator(payload, context) — catch any throw → HOOK_INTERNAL_ERROR.
 *     b. Write hook_invocations row (best-effort, background).
 *     c. Emit HookFired event (EventStore.append — never db.insert(events)).
 *     d. If allow → emit HookPassed; continue.
 *        If reject → emit HookRejected; SHORT-CIRCUIT; return reject decision.
 *  3. If all pass → return { allow: true }.
 *
 * Fail-closed: any exception from a hook validator is treated as a rejection.
 * Pure, in-process: hooks have no I/O surface beyond their inputs.
 */

import { createHash } from 'node:crypto'
import { uuidv7 } from 'uuidv7'
import type { EventStore } from '../events/store.js'
import type { DB } from '../db/client.js'
import { db as defaultDb } from '../db/client.js'
import { hookInvocations } from '../db/schema/determinism.js'
import { logger } from '../config/logger.js'
import type {
  HookDefinition,
  HookContext,
  HookEngineDecision,
} from './types.js'

// ---------------------------------------------------------------------------
// HookEngine class
// ---------------------------------------------------------------------------

export class HookEngine {
  /**
   * Registry: eventType → timing → sorted HookDefinition[]
   * Sorted by declared_order ASC, then hook_id ASC (tie-breaking per TRD-09 §6.2.2).
   */
  private readonly registry = new Map<string, Map<'pre' | 'post', HookDefinition[]>>()

  constructor(
    private readonly eventStore: EventStore,
    private readonly db: DB = defaultDb,
  ) {}

  // ---------------------------------------------------------------------------
  // register
  // ---------------------------------------------------------------------------

  register(hook: HookDefinition): void {
    for (const eventType of hook.applies_to) {
      let timingMap = this.registry.get(eventType)
      if (!timingMap) {
        timingMap = new Map()
        this.registry.set(eventType, timingMap)
      }

      const existing = timingMap.get(hook.timing) ?? []
      existing.push(hook)
      // Sort: declared_order ASC, then hook_id ASC
      existing.sort((a, b) => {
        if (a.declared_order !== b.declared_order) {
          return a.declared_order - b.declared_order
        }
        return a.hook_id.localeCompare(b.hook_id)
      })
      timingMap.set(hook.timing, existing)
    }
  }

  // ---------------------------------------------------------------------------
  // fire (the "validate" entrypoint from TRD-09 §6.2.1)
  // ---------------------------------------------------------------------------

  async fire(
    eventType: string,
    payload: unknown,
    context: HookContext,
    timing: 'pre' | 'post',
  ): Promise<HookEngineDecision> {
    const hooks = this.lookupHooks(eventType, timing)

    for (const hook of hooks) {
      if (!hook.enabled) continue

      const started = Date.now()
      let decision: { allow: boolean; reason?: string }

      try {
        const raw = await hook.validator(payload, context)
        decision = raw
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        decision = { allow: false, reason: `hook threw: ${msg}` }
      }

      const durationMs = Date.now() - started
      const invocationId = uuidv7()
      const payloadDigest = sha256(JSON.stringify(payload ?? {}))

      // Write invocation row and events in background — not on critical path.
      // Per TRD-09 §13: "writes to hook_invocations are best-effort after decision"
      void this.writeInvocationAndEvents(
        hook,
        eventType,
        timing,
        decision,
        durationMs,
        invocationId,
        payloadDigest,
        context,
      ).catch((writeErr: unknown) => {
        logger.error(
          { writeErr, hook_slug: hook.slug, invocationId },
          'HookEngine: failed to write invocation/events',
        )
      })

      if (!decision.allow) {
        const errorCode = decision.reason?.startsWith('hook threw:')
          ? 'HOOK_INTERNAL_ERROR'
          : hook.error_code

        return {
          allow: false,
          reason: decision.reason ?? 'hook rejected without reason',
          error_code: errorCode,
          hook_id: hook.hook_id,
          hook_slug: hook.slug,
          invocation_id: invocationId,
        }
      }
    }

    return { allow: true }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private lookupHooks(eventType: string, timing: 'pre' | 'post'): HookDefinition[] {
    const timingMap = this.registry.get(eventType)
    if (!timingMap) return []
    return timingMap.get(timing) ?? []
  }

  private async writeInvocationAndEvents(
    hook: HookDefinition,
    eventType: string,
    timing: 'pre' | 'post',
    decision: { allow: boolean; reason?: string },
    durationMs: number,
    invocationId: string,
    payloadDigest: string,
    context: HookContext,
  ): Promise<void> {
    const decisionStr = decision.allow ? 'allow' : 'reject'
    const errorCode = !decision.allow
      ? decision.reason?.startsWith('hook threw:')
        ? 'HOOK_INTERNAL_ERROR'
        : hook.error_code
      : null

    // Write hook_invocations row.
    await this.db.insert(hookInvocations).values({
      invocation_id: invocationId,
      hook_id: hook.hook_id,
      hook_version_id: hook.hook_version_id,
      event_type: eventType,
      timing,
      decision: decisionStr,
      reason: decision.reason ?? null,
      error_code: errorCode,
      duration_ms: durationMs,
      trace_id: context.trace_id,
      parent_event_id: (context.parent_event_id as string | undefined) ?? null,
      payload_digest: payloadDigest,
    })

    const actor = { type: 'hook' as const, hook_id: hook.hook_id, hook_version: hook.hook_version_id }
    const occurredAt = new Date().toISOString()

    // Emit HookFired (every invocation — pass or reject).
    await this.eventStore.append({
      aggregate_id: invocationId,
      aggregate_type: 'hook_invocation',
      event_type: 'HookFired',
      payload: {
        schema_version: 1,
        hook_id: hook.hook_id,
        hook_version_id: hook.hook_version_id,
        hook_slug: hook.slug,
        event_type_intercepted: eventType,
        timing,
        decision: decisionStr,
        duration_ms: durationMs,
        invocation_id: invocationId,
        payload_digest: payloadDigest,
        parent_event_id: context.parent_event_id,
      },
      actor,
      trace_id: context.trace_id,
      parent_event_id: context.parent_event_id,
      occurred_at: occurredAt,
      schema_version: 1,
    })

    if (decision.allow) {
      // Emit HookPassed.
      await this.eventStore.append({
        aggregate_id: invocationId,
        aggregate_type: 'hook_invocation',
        event_type: 'HookPassed',
        payload: {
          schema_version: 1,
          invocation_id: invocationId,
          hook_id: hook.hook_id,
          hook_slug: hook.slug,
          event_type_intercepted: eventType,
          timing,
        },
        actor,
        trace_id: context.trace_id,
        occurred_at: occurredAt,
        schema_version: 1,
      })
    } else {
      // Emit HookRejected.
      await this.eventStore.append({
        aggregate_id: invocationId,
        aggregate_type: 'hook_invocation',
        event_type: 'HookRejected',
        payload: {
          schema_version: 1,
          invocation_id: invocationId,
          hook_id: hook.hook_id,
          hook_slug: hook.slug,
          event_type_intercepted: eventType,
          timing,
          reason: decision.reason ?? 'hook rejected without reason',
          error_code: errorCode ?? hook.error_code,
          rejected_actor: context.actor,
        },
        actor,
        trace_id: context.trace_id,
        occurred_at: occurredAt,
        schema_version: 1,
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}
