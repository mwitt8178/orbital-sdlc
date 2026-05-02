import { z } from 'zod'
import { ActorSchema } from './actor.js'

/** Per Primitives §7 — canonical event envelope. */
export const AggregateTypeSchema = z.enum([
  'task',
  'sprint',
  'ticket',
  'vision_document',
  'persona',
  'capability',
  'channel',
  'channel_post',
  'ceremony',
  'disagreement',
  'retro',
  'defect',
  'adr',
  'install',
  'system',
  'verification',
  'audit_export',
  'cost_accounting_period',
  'system_version',
  'hook_invocation',
  'orchestration',
  'reconciliation_run',
  'monday_sync',
  'epic',
  'story',
  'uat_session',
  'presence',
])

export type AggregateType = z.infer<typeof AggregateTypeSchema>

export const EventEnvelopeSchema = z.object({
  event_id: z.string(),
  aggregate_id: z.string(),
  aggregate_type: AggregateTypeSchema,
  event_type: z.string(),
  payload: z.record(z.string(), z.unknown()),
  actor: ActorSchema,
  capability_id: z.string().optional(),
  parent_event_id: z.string().optional(),
  trace_id: z.string(),
  occurred_at: z.string().datetime(),
  ingested_at: z.string().datetime(),
  schema_version: z.number().int().positive(),
})

export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>

/** Input shape used when appending — server fills event_id and ingested_at. */
export const EventInputSchema = EventEnvelopeSchema.omit({
  event_id: true,
  ingested_at: true,
})

export type EventInput = z.infer<typeof EventInputSchema>

export const EventQueryFilterSchema = z.object({
  aggregate_type: AggregateTypeSchema.optional(),
  aggregate_id: z.string().optional(),
  event_type: z.string().optional(),
  actor_type: z.enum(['persona', 'user', 'system', 'hook']).optional(),
  actor_id: z.string().optional(),
  occurred_after: z.string().datetime().optional(),
  occurred_before: z.string().datetime().optional(),
  trace_id: z.string().optional(),
  after: z.string().optional(),
  limit: z.number().int().min(1).max(1000).default(100),
})

export type EventQueryFilter = z.infer<typeof EventQueryFilterSchema>
