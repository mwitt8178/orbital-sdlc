/**
 * blocker-resolution rule.
 *
 * Fires on: BlockerRaised
 *
 * Match condition: blocker has been open >= 30 min wallclock without progress
 * (i.e., still in 'raised' state with no routing or resolution). The rule
 * inspects the blockers table to confirm.
 *
 * Note: this rule fires the first time a stale blocker is observed. The 30-min
 * staleness check fires *only* when the rule sees the BlockerRaised event
 * after enough time has passed. In practice, BlockerRaised arrives immediately;
 * if the blocker is still 'raised' after 30 min it has been routed/escalated
 * by then OR the routing has stalled (the case we care about). We therefore
 * gate with: state still 'raised' AND raised_at < now() - 30 min.
 *
 * Spec: invite the requested resolver role + the raising worker.
 */

import { sql as dSQL } from 'drizzle-orm'
import type { EventEnvelope } from '@orbital/types'
import type { CeremonySpec, CeremonyTriggerRule, TriggerContext } from '../ceremony-scheduler.js'

const RULE_ID = 'blocker-resolution'

export const blockerResolutionRule: CeremonyTriggerRule = {
  id: RULE_ID,
  description:
    'Schedule a blocker-resolution ceremony when a blocker has been open >=30 min without progress',
  triggers: ['BlockerRaised'],

  async match(envelope: EventEnvelope, ctx: TriggerContext): Promise<CeremonySpec | null> {
    const payload = envelope.payload as Record<string, unknown>
    const blockerId = payload['blocker_id'] as string | undefined
    if (!blockerId) return null

    const rows = await ctx.db.execute<{
      blocker_id: string
      state: string
      requested_resolver_role: string
      raising_actor: Record<string, unknown> | null
      raising_task_id: string
      raised_at: string
    }>(dSQL`
      SELECT
        blocker_id,
        state,
        requested_resolver_role,
        raising_actor,
        raising_task_id,
        raised_at
      FROM blockers
      WHERE blocker_id = ${blockerId}
        AND state = 'raised'
        AND raised_at < now() - interval '30 minutes'
      LIMIT 1
    `)
    const arr = rows as unknown as Array<{
      blocker_id: string
      state: string
      requested_resolver_role: string
      raising_actor: Record<string, unknown> | null
      raising_task_id: string
    }>
    const blocker = arr[0]
    if (!blocker) return null

    const resolverRole = blocker.requested_resolver_role
    const raisingPersona =
      blocker.raising_actor && typeof blocker.raising_actor['persona_id'] === 'string'
        ? (blocker.raising_actor['persona_id'] as string)
        : null

    return {
      ceremonyType: 'ad_hoc',
      scope: {
        intent: 'blocker_resolution',
        blocker_id: blockerId,
        raising_task_id: blocker.raising_task_id,
        requested_resolver_role: resolverRole,
      },
      triggeredBy: { type: 'system', component: 'ceremony_scheduler' },
      invitedRoles: [resolverRole, ...(raisingPersona ? [raisingPersona] : [])],
    }
  },
}
