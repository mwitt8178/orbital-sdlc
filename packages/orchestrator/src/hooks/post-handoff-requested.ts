/**
 * post-handoff-requested.ts — Hook that fires after ChannelPostAdded is persisted
 * when the post is a handoff_note posted to a sprint channel.
 *
 * Round 6 #9 — Inter-Agent Channel Collaboration
 * [Engineer-Sr · Sonnet · run-round6-09-channel-collab]
 *
 * On ChannelPostAdded where post_type='handoff_note':
 *   1. Parse the post payload for target_persona and handoff_reason.
 *   2. Look up the source task from the posting worker's task_id.
 *   3. Emit HandOffRequested event.
 *   4. Create a child task with:
 *      - persona_id = target_persona from payload
 *      - parent_task_id = source task_id
 *      - sprint_id = source task sprint_id
 *      - state = 'ready'
 *      - title = suggested_title or "Hand-off from <source title>"
 *      - description = suggested_description or handoff_note body
 *
 * This is a post hook — it fires after the event is persisted and cannot gate it.
 */

import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'
import { defineHook, type HookSpec } from './types.js'
import type { DB } from '../db/client.js'
import type { EventStore } from '../events/store.js'
import { tasks } from '../db/schema/orchestration.js'
import {
  DEFAULT_WALL_CLOCK_TIMEOUT_MS,
  DEFAULT_TOKEN_BUDGET,
} from '../orchestration/types.js'
import { logger } from '../config/logger.js'

// ---------------------------------------------------------------------------
// Default retry budget for handoff child tasks
// ---------------------------------------------------------------------------

const HANDOFF_CHILD_RETRY_BUDGET = 3

// ---------------------------------------------------------------------------
// Payload schema (matches ChannelPostAdded)
// ---------------------------------------------------------------------------

const ChannelPostAddedPayloadSchema = z.object({
  post_id: z.string(),
  channel_id: z.string(),
  parent_post_id: z.string().nullable().optional(),
  post_type: z.string(),
  payload: z.record(z.string(), z.unknown()),
  ceremony_id: z.string().nullable().optional(),
  ceremony_turn_number: z.number().nullable().optional(),
  mentions: z.array(z.object({
    target_type: z.string(),
    target_ref: z.string(),
    priority: z.string().optional(),
  })).optional().default([]),
  cross_references: z.array(z.object({
    ref_type: z.string(),
    ref_id: z.string(),
  })).optional().default([]),
})

type ChannelPostAddedPayload = z.infer<typeof ChannelPostAddedPayloadSchema>

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Factory: binds db + eventStore to the post-handoff-requested hook.
 * Called at boot time with singleton instances.
 */
export function createPostHandoffRequestedHook(
  db: DB,
  eventStore: EventStore,
): HookSpec<typeof ChannelPostAddedPayloadSchema> {
  return defineHook({
    slug: 'post-handoff-requested',
    description:
      'After an agent posts a handoff_note to a sprint channel, emit HandOffRequested and ' +
      'create a child task targeting the specified persona.',
    appliesTo: ['ChannelPostAdded'],
    timing: 'post',
    declaredOrder: 215,
    errorCode: 'HOOK_REJECTED_GENERIC',
    payloadSchema: ChannelPostAddedPayloadSchema,

    validator: async (payload: ChannelPostAddedPayload, ctx) => {
      // Only handle handoff_note post type
      if (payload.post_type !== 'handoff_note') {
        return { allow: true }
      }

      void onHandoffNotePosted(payload, ctx.actor, db, eventStore).catch((err: unknown) => {
        logger.error(
          { err, post_id: payload.post_id, channel_id: payload.channel_id },
          'post-handoff-requested hook: handler threw (non-gating)',
        )
      })

      return { allow: true }
    },
  })
}

// ---------------------------------------------------------------------------
// Core logic (extracted for testability)
// ---------------------------------------------------------------------------

/**
 * Handles the handoff_note post side-effects.
 * Exported so integration tests can call it directly.
 */
export async function onHandoffNotePosted(
  payload: ChannelPostAddedPayload,
  actor: { type: string; persona_id?: string; session_id?: string; task_id?: string },
  db: DB,
  eventStore: EventStore,
): Promise<void> {
  const now = new Date()
  const traceId = uuidv7()

  // Extract actor task_id
  const sourceTaskId = actor.task_id ?? null
  if (!sourceTaskId) {
    logger.warn(
      { post_id: payload.post_id, actor },
      'post-handoff-requested: actor has no task_id; cannot create child task',
    )
    return
  }

  // Load source task
  const [sourceTask] = await db
    .select()
    .from(tasks)
    .where(eq(tasks.taskId, sourceTaskId))
    .limit(1)

  if (!sourceTask) {
    logger.warn(
      { sourceTaskId, post_id: payload.post_id },
      'post-handoff-requested: source task not found; skipping',
    )
    return
  }

  // Extract handoff payload fields
  const postPayload = payload.payload as Record<string, unknown>
  const body = typeof postPayload['body'] === 'string' ? postPayload['body'] : ''
  const targetPersona = typeof postPayload['target_persona'] === 'string' ? postPayload['target_persona'] : null
  const handoffReason = typeof postPayload['handoff_reason'] === 'string' ? postPayload['handoff_reason'] : body
  const suggestedTitle = typeof postPayload['suggested_title'] === 'string' ? postPayload['suggested_title'] : null
  const suggestedDescription = typeof postPayload['suggested_description'] === 'string' ? postPayload['suggested_description'] : null

  if (!targetPersona) {
    logger.warn(
      { post_id: payload.post_id, sourceTaskId },
      'post-handoff-requested: handoff_note missing target_persona; skipping',
    )
    return
  }

  // Emit HandOffRequested event and capture envelope for createdByEventId
  const handoffEventEnvelope = await eventStore.append({
    aggregate_id: sourceTaskId,
    aggregate_type: 'task',
    event_type: 'HandOffRequested',
    payload: {
      post_id: payload.post_id,
      source_task_id: sourceTaskId,
      sprint_id: sourceTask.sprintId,
      target_persona: targetPersona,
      handoff_reason: handoffReason,
      suggested_title: suggestedTitle ?? `Hand-off: ${sourceTask.title}`,
      suggested_description: suggestedDescription ?? body,
      requested_at: now.toISOString(),
    },
    actor: { type: 'system', component: 'orchestrator' },
    trace_id: traceId,
    occurred_at: now.toISOString(),
    schema_version: 1,
  })

  // Create child task targeting the specified persona
  const childTaskId = uuidv7()
  const childTitle = suggestedTitle ?? `Hand-off: ${sourceTask.title}`
  const childDescription =
    suggestedDescription ??
    `## Hand-off from ${actor.persona_id ?? 'unknown'}\n\n` +
    `**Source task**: ${sourceTaskId}\n` +
    `**Reason**: ${handoffReason}\n\n` +
    `${body}`

  await db.insert(tasks).values({
    taskId: childTaskId,
    sprintId: sourceTask.sprintId,
    ticketId: sourceTask.ticketId,
    title: childTitle,
    description: childDescription,
    acceptanceCriteria: [`Complete the handed-off work: ${handoffReason.slice(0, 200)}`],
    personaId: targetPersona,
    riskClass: sourceTask.riskClass,
    state: 'ready',
    attemptCount: 0,
    retryBudget: HANDOFF_CHILD_RETRY_BUDGET,
    parentTaskId: sourceTaskId,
    iterationCount: 0,
    escalationCount: 0,
    wallClockTimeoutMs: DEFAULT_WALL_CLOCK_TIMEOUT_MS,
    tokenBudget: DEFAULT_TOKEN_BUDGET,
    createdByEventId: handoffEventEnvelope.event_id,
  })

  logger.info(
    {
      sourceTaskId,
      childTaskId,
      targetPersona,
    },
    'post-handoff-requested: HandOffRequested emitted; child task created',
  )
}
