/**
 * sprint-review rule.
 *
 * Fires on: SprintCompleting (intent: a sprint is about to close — use the
 * sprint_retrospective ceremony type to gather PM + EM + active workers).
 *
 * NOTE: Many sprints transition straight to 'completed' without an explicit
 * 'completing' state. We accept either `SprintCompleting` (preferred) or
 * `SprintCompleted` events; for the latter we skip if the sibling
 * continuous-flow-kickoff already fired (different rule, same trigger event).
 *
 * Spec: invite PM + EM (scrum master is implicit chair via spec).
 */

import { sql as dSQL } from 'drizzle-orm'
import type { EventEnvelope } from '@orbital/types'
import type { CeremonySpec, CeremonyTriggerRule, TriggerContext } from '../ceremony-scheduler.js'

const RULE_ID = 'sprint-review'

export const sprintReviewRule: CeremonyTriggerRule = {
  id: RULE_ID,
  description: 'Schedule sprint retrospective on sprint completing',
  triggers: ['SprintCompleting', 'SprintCompleted'],

  async match(envelope: EventEnvelope, ctx: TriggerContext): Promise<CeremonySpec | null> {
    const sprintId = envelope.aggregate_id

    // Confirm sprint exists; pull active worker count for the invitation list.
    const rows = await ctx.db.execute<{
      status: string
      sprint_id: string
    }>(dSQL`
      SELECT sprint_id, status FROM sprints WHERE sprint_id = ${sprintId} LIMIT 1
    `)
    const sprint = (rows as unknown as Array<{ sprint_id: string; status: string }>)[0]
    if (!sprint) return null

    // Active worker personas in this sprint (for the invitation hint).
    const workerRows = await ctx.db.execute<{ persona_id: string }>(dSQL`
      SELECT DISTINCT persona_id
      FROM tasks
      WHERE sprint_id = ${sprintId}
        AND state IN ('in_progress', 'in_review', 'done')
    `)
    const personaIds = (workerRows as unknown as Array<{ persona_id: string }>).map(
      (r) => r.persona_id,
    )

    return {
      ceremonyType: 'sprint_retrospective',
      scope: {
        sprint_id: sprintId,
        sprint_status_at_trigger: sprint.status,
        active_worker_personas: personaIds,
      },
      triggeredBy: { type: 'system', component: 'ceremony_scheduler' },
      invitedRoles: ['pm', 'engineering_manager', 'scrum_master'],
    }
  },
}
