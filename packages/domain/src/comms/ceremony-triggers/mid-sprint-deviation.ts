/**
 * mid-sprint-deviation rule.
 *
 * Fires on: SprintProgressEvaluated (synthetic event emitted by Scheduler)
 *
 * Match condition: sprint.elapsed > 50% wallclock AND completed_tasks < 30%
 * total. The synthetic event payload carries the metrics so this rule does
 * not have to recompute progress.
 *
 * Spec: schedule an async_standup with the Scrum Master + active workers.
 */

import { sql as dSQL } from 'drizzle-orm'
import type { EventEnvelope } from '@orbital/types'
import type { CeremonySpec, CeremonyTriggerRule, TriggerContext } from '../ceremony-scheduler.js'

const RULE_ID = 'mid-sprint-deviation'

export const midSprintDeviationRule: CeremonyTriggerRule = {
  id: RULE_ID,
  description:
    'Schedule async standup when an active sprint has consumed >50% wallclock with <30% tasks done',
  triggers: ['SprintProgressEvaluated'],

  async match(envelope: EventEnvelope, ctx: TriggerContext): Promise<CeremonySpec | null> {
    const sprintId = envelope.aggregate_id
    const payload = envelope.payload as Record<string, unknown>
    const elapsedPct = Number(payload['elapsed_pct'] ?? 0)
    const completedPct = Number(payload['completed_task_pct'] ?? 0)

    if (!(elapsedPct > 50 && completedPct < 30)) return null

    // Confirm the sprint is still active (don't fire on a completed sprint).
    const rows = await ctx.db.execute<{ status: string }>(dSQL`
      SELECT status FROM sprints WHERE sprint_id = ${sprintId} LIMIT 1
    `)
    const status = (rows as unknown as Array<{ status: string }>)[0]?.status
    if (status !== 'active') return null

    return {
      ceremonyType: 'async_standup',
      scope: {
        sprint_id: sprintId,
        elapsed_pct: elapsedPct,
        completed_task_pct: completedPct,
        reason: 'mid_sprint_deviation',
      },
      triggeredBy: { type: 'system', component: 'ceremony_scheduler' },
      invitedRoles: ['scrum_master'],
    }
  },
}
