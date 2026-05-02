import { z } from 'zod'

/** Per Primitives §5 — every action has an attributable actor. */
export const ActorSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('persona'),
    persona_id: z.string(),
    session_id: z.string(),
    task_id: z.string().optional(),
  }),
  z.object({
    type: z.literal('user'),
    user_id: z.string(),
    install_id: z.string(),
  }),
  z.object({
    type: z.literal('system'),
    component: z.enum([
      'orchestrator',
      'scheduler',
      'mcp_gateway',
      'capability_authority',
      'audit_service',
      'retro_service',
      'reconciler',
      'hook_engine',
      // Added by the agent-native CeremonyScheduler (see TRD-05 §6.2.6).
      // Distinct from 'scheduler' (which is the task scheduler) so audit
      // attribution stays unambiguous.
      'ceremony_scheduler',
    ]),
  }),
  z.object({
    type: z.literal('hook'),
    hook_id: z.string(),
    hook_version: z.string(),
  }),
])

export type Actor = z.infer<typeof ActorSchema>
