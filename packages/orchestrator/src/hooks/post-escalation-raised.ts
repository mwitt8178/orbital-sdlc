/**
 * post-escalation-raised.ts — Hook that fires after ChannelPostAdded is persisted
 * when the post is an escalation_note posted to an escalation channel.
 *
 * Round 6 #9 — Inter-Agent Channel Collaboration
 * [Engineer-Sr · Sonnet · run-round6-09-channel-collab]
 *
 * On ChannelPostAdded where post_type='escalation_note' and channel is #escalation-*:
 *   1. Parse the post payload to extract target_persona_hint and confidence.
 *   2. Look up the source task from the posting worker's task_id.
 *   3. Emit EscalationRaised event with source task_id + target_persona_hint.
 *   4. Create a child task in the tasks table with:
 *      - persona_id = target_persona_hint
 *      - parent_task_id = source task_id
 *      - sprint_id = source task sprint_id
 *      - state = 'ready'
 *      - title = "Escalation: <source task title>"
 *      - description = escalation note body + source context
 *      - escalation_count incremented on the source task
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
import { channels } from '../db/schema/channels.js'
import type { ChannelId } from '@orbital/types'
import {
  DEFAULT_WALL_CLOCK_TIMEOUT_MS,
  DEFAULT_TOKEN_BUDGET,
} from '../orchestration/types.js'
import { logger } from '../config/logger.js'

// ---------------------------------------------------------------------------
// Default retry budget for escalation child tasks
// ---------------------------------------------------------------------------

const ESCALATION_CHILD_RETRY_BUDGET = 2

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
 * Factory: binds db + eventStore to the post-escalation-raised hook.
 * Called at boot time with singleton instances.
 */
export function createPostEscalationRaisedHook(
  db: DB,
  eventStore: EventStore,
): HookSpec<typeof ChannelPostAddedPayloadSchema> {
  return defineHook({
    slug: 'post-escalation-raised',
    description:
      'After an agent posts an escalation_note to #escalation-*, emit EscalationRaised and ' +
      'create a child task targeting the hinted senior persona.',
    appliesTo: ['ChannelPostAdded'],
    timing: 'post',
    declaredOrder: 210,
    errorCode: 'HOOK_REJECTED_GENERIC',
    payloadSchema: ChannelPostAddedPayloadSchema,

    validator: async (payload: ChannelPostAddedPayload, ctx) => {
      // Only handle escalation_note post type
      if (payload.post_type !== 'escalation_note') {
        return { allow: true }
      }

      void onEscalationNotePosted(payload, ctx.actor, db, eventStore).catch((err: unknown) => {
        logger.error(
          { err, post_id: payload.post_id, channel_id: payload.channel_id },
          'post-escalation-raised hook: handler threw (non-gating)',
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
 * Handles the escalation_note post side-effects.
 * Exported so integration tests can call it directly.
 */
export async function onEscalationNotePosted(
  payload: ChannelPostAddedPayload,
  actor: { type: string; persona_id?: string; session_id?: string; task_id?: string },
  db: DB,
  eventStore: EventStore,
): Promise<void> {
  const now = new Date()
  const traceId = uuidv7()

  // Verify the channel is an escalation channel
  const [channelRow] = await db
    .select()
    .from(channels)
    .where(eq(channels.channelId, payload.channel_id as ChannelId))
    .limit(1)

  if (!channelRow || !channelRow.name.startsWith('#escalation-')) {
    // Not an escalation channel — skip
    return
  }

  // Extract actor task_id
  const sourceTaskId = actor.task_id ?? null
  if (!sourceTaskId) {
    logger.warn(
      { post_id: payload.post_id, actor },
      'post-escalation-raised: actor has no task_id; cannot create child task',
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
      'post-escalation-raised: source task not found; skipping',
    )
    return
  }

  // Extract escalation payload fields
  const postPayload = payload.payload as Record<string, unknown>
  const body = typeof postPayload['body'] === 'string' ? postPayload['body'] : ''
  const confidence = typeof postPayload['confidence'] === 'number' ? postPayload['confidence'] : -1
  const blockerType = typeof postPayload['blocker_type'] === 'string' ? postPayload['blocker_type'] : 'unknown'

  // Determine target persona from mentions (first @-mention) or fallback to 'principal-dev'
  const mentionedPersona = payload.mentions.find((m) => m.target_type === 'persona_role')
  const targetPersonaHint = mentionedPersona
    ? mentionedPersona.target_ref.replace(/^@/, '')
    : 'principal-dev'

  // Emit EscalationRaised event and capture the event envelope for createdByEventId
  const escalationEventEnvelope = await eventStore.append({
    aggregate_id: sourceTaskId,
    aggregate_type: 'task',
    event_type: 'EscalationRaised',
    payload: {
      post_id: payload.post_id,
      source_task_id: sourceTaskId,
      sprint_id: sourceTask.sprintId,
      target_persona_hint: targetPersonaHint,
      raised_by_persona: actor.persona_id ?? 'unknown',
      reason: `${blockerType}: ${body.slice(0, 500)}`,
      confidence,
      raised_at: now.toISOString(),
    },
    actor: { type: 'system', component: 'orchestrator' },
    trace_id: traceId,
    occurred_at: now.toISOString(),
    schema_version: 1,
  })

  // Increment escalation_count on the source task
  const newEscalationCount = (sourceTask.escalationCount ?? 0) + 1
  await db
    .update(tasks)
    .set({ escalationCount: newEscalationCount })
    .where(eq(tasks.taskId, sourceTaskId))

  // Create child task targeting the hinted persona
  const childTaskId = uuidv7()
  const childTitle = `Escalation: ${sourceTask.title}`
  const childDescription =
    `## Escalation from ${actor.persona_id ?? 'unknown'}\n\n` +
    `**Source task**: ${sourceTaskId}\n` +
    `**Reason**: ${blockerType}\n` +
    `**Confidence**: ${confidence}\n\n` +
    `${body}\n\n` +
    `---\n\n` +
    `**Original task description**:\n\n${sourceTask.description}`

  await db.insert(tasks).values({
    taskId: childTaskId,
    sprintId: sourceTask.sprintId,
    ticketId: sourceTask.ticketId,
    title: childTitle,
    description: childDescription,
    acceptanceCriteria: [`Resolve the escalation from task ${sourceTaskId}`, `Post resolution back to ${channelRow.name}`],
    personaId: targetPersonaHint,
    riskClass: sourceTask.riskClass,
    state: 'ready',
    attemptCount: 0,
    retryBudget: ESCALATION_CHILD_RETRY_BUDGET,
    parentTaskId: sourceTaskId,
    iterationCount: 0,
    escalationCount: 0,
    wallClockTimeoutMs: DEFAULT_WALL_CLOCK_TIMEOUT_MS,
    tokenBudget: DEFAULT_TOKEN_BUDGET,
    createdByEventId: escalationEventEnvelope.event_id,
  })

  logger.info(
    {
      sourceTaskId,
      childTaskId,
      targetPersonaHint,
      escalationCount: newEscalationCount,
    },
    'post-escalation-raised: EscalationRaised emitted; child task created',
  )
}
