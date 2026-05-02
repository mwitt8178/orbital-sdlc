/**
 * Audit middleware for MCP tool calls.
 *
 * Per Implementation Plan §6 Task 2B:
 * - Emits CapabilityDenied event on validation denial.
 * - Emits AuditQueryExecuted on expensive queries (cost-gated).
 *
 * All events flow through EventStore.append — never direct db.insert(events).
 *
 * Round 7-02 — dual-write: when hub is configured, each tool-call event is
 * also enqueued in the HubOutbox for cross-operator visibility on the hub.
 * The local EventStore write is always primary (for replay); the hub write is
 * best-effort (queued, retried, then dropped on max retries).
 * [Engineer-Sr · Sonnet · run-round7-02-local-hub-split]
 */

import { uuidv7 } from 'uuidv7'
import { eq } from 'drizzle-orm'
import { capabilityDenials } from '../../db/schema/capabilities.js'
import type { EventStore } from '../../events/store.js'
import type { DB } from '../../db/client.js'
import type { CapabilityBundle, Actor, EventInput } from '@orbital/types'
import type { ValidationDeny } from '../../capabilities/gateway.js'
import { logger } from '../../config/logger.js'
// Round 7-02 — hub outbox for dual-write fan-out
// [Engineer-Sr · Sonnet · run-round7-02-local-hub-split]
import type { HubOutbox } from '../../hub-client/outbox.js'
import type { HubEventInput } from '../../hub-client/types.js'
import { loadEnv } from '../../config/env.js'

/**
 * Write a CapabilityDenied audit record for a denied tool call.
 *
 * Called by the router on every deny result from validateToolCall or
 * when bundle verification fails.
 *
 * Round 7-02: accepts optional hubOutbox. When present, the event is also
 * enqueued in the hub outbox for cross-operator visibility.
 * [Engineer-Sr · Sonnet · run-round7-02-local-hub-split]
 */
export async function emitCapabilityDenied(
  eventStore: EventStore,
  db: DB,
  bundle: CapabilityBundle | null,
  toolName: string,
  denial: ValidationDeny | { reason_code: string; reason_detail: string; attempted_target: string },
  traceId: string,
  /** Round 7-02: optional hub outbox for dual-write fan-out. */
  hubOutbox?: HubOutbox | null,
): Promise<void> {
  const denialId = uuidv7()
  const occurredAt = new Date().toISOString()

  const capabilityId = bundle?.capability_id ?? null
  const taskId = bundle?.task_id ?? null
  const sessionId = bundle?.session_id ?? null
  const personaId = bundle?.persona_id ?? null

  // Write to capability_denials table for fast forensic lookup.
  try {
    await db.insert(capabilityDenials).values({
      denial_id: denialId,
      capability_id: capabilityId,
      task_id: taskId,
      session_id: sessionId,
      persona_id: personaId,
      attempted_tool: toolName,
      attempted_target: denial.attempted_target,
      reason_code: denial.reason_code,
      reason_detail: denial.reason_detail,
      prompt_excerpt: null,
      trace_id: traceId,
      occurred_at: new Date(occurredAt),
      schema_version: 1,
    })
  } catch (err) {
    // Log but do not block — audit write failure must not affect denial path.
    logger.error({ err, denial_id: denialId }, 'audit: failed to write capability_denials row')
  }

  const actor: Actor = bundle
    ? {
        type: 'persona',
        persona_id: bundle.persona_id,
        session_id: bundle.session_id,
        task_id: bundle.task_id,
      }
    : { type: 'system', component: 'mcp_gateway' }

  const ev: EventInput = {
    aggregate_id: denialId,
    aggregate_type: 'capability',
    event_type: 'CapabilityDenied',
    payload: {
      capability_id: capabilityId,
      task_id: taskId,
      session_id: sessionId,
      persona_id: personaId,
      attempted_tool: toolName,
      attempted_target: denial.attempted_target,
      reason_code: denial.reason_code,
      reason_detail: denial.reason_detail,
      channel_post_target: '#capability-violations',
    },
    actor,
    capability_id: capabilityId ?? undefined,
    trace_id: traceId,
    occurred_at: occurredAt,
    schema_version: 1,
  }

  try {
    const envelope = await eventStore.append(ev)

    // Round 7-02 — dual-write: enqueue in hub outbox if configured.
    // [Engineer-Sr · Sonnet · run-round7-02-local-hub-split]
    if (hubOutbox) {
      try {
        const env = loadEnv()
        const hubEvent: HubEventInput = {
          aggregate_id: denialId,
          aggregate_type: 'capability',
          event_type: 'CapabilityDenied',
          payload: ev.payload as Record<string, unknown>,
          actor: actor as unknown as Record<string, unknown>,
          capability_id: capabilityId ?? undefined,
          trace_id: traceId,
          occurred_at: occurredAt,
          schema_version: 1,
          tenant_id: env.ORBITAL_HUB_TENANT_ID,
        }
        // Use the event_id assigned by the local store for idempotency on the hub.
        if (envelope && typeof (envelope as Record<string, unknown>)['event_id'] === 'string') {
          hubEvent.aggregate_id = (envelope as Record<string, unknown>)['event_id'] as string
        }
        hubOutbox.enqueue(hubEvent)
      } catch (outboxErr) {
        logger.warn({ outboxErr, denial_id: denialId }, 'audit: hub outbox enqueue failed (non-fatal)')
      }
    }
  } catch (err) {
    logger.error({ err, denial_id: denialId }, 'audit: failed to emit CapabilityDenied event')
  }
}

/**
 * Emit AuditQueryExecuted for expensive query introspection.
 * Only fired when query cost exceeds the threshold (cost-gated per spec).
 *
 * Phase 4C (Audit Reconciler) consumes this event. For Phase 2B we define
 * the emission point; the cost threshold is a simple duration check.
 */
export async function emitAuditQueryExecuted(
  eventStore: EventStore,
  aggregateId: string,
  toolName: string,
  durationMs: number,
  traceId: string,
  actor: Actor,
): Promise<void> {
  const COST_THRESHOLD_MS = 500

  if (durationMs < COST_THRESHOLD_MS) return

  const ev: EventInput = {
    aggregate_id: aggregateId,
    aggregate_type: 'system',
    event_type: 'AuditQueryExecuted',
    payload: {
      tool: toolName,
      duration_ms: durationMs,
    },
    actor,
    trace_id: traceId,
    occurred_at: new Date().toISOString(),
    schema_version: 1,
  }

  await eventStore.append(ev).catch((err) => {
    logger.error({ err, tool: toolName }, 'audit: failed to emit AuditQueryExecuted')
  })
}
