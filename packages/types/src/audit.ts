import { z } from 'zod'
import { ActorSchema } from './actor.js'

/** Per Primitives §14 — audit metadata required on every state-changing action. */
export const AuditMetadataSchema = z.object({
  actor: ActorSchema,
  capability_id: z.string().optional(),
  justification: z.string().min(1),
  parent_event_id: z.string().optional(),
  trace_id: z.string(),
  linked_artifacts: z
    .array(z.object({ type: z.string(), id: z.string() }))
    .default([]),
})

export type AuditMetadata = z.infer<typeof AuditMetadataSchema>
