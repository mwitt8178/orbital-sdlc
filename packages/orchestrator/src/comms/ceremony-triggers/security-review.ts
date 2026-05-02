/**
 * security-review rule.
 *
 * Fires on: CapabilityDenied
 *
 * Match condition: >=5 denials in the last 60 minutes (across the install).
 * The query uses the audit.events table so the count includes the triggering
 * event itself.
 *
 * Spec: invite Security persona + the offending workers (the personas named
 * in the most recent denials).
 */

import { sql as dSQL } from 'drizzle-orm'
import type { EventEnvelope } from '@orbital/types'
import type { CeremonySpec, CeremonyTriggerRule, TriggerContext } from '../ceremony-scheduler.js'

const RULE_ID = 'security-review'

const DENIAL_THRESHOLD = 5
const WINDOW_MINUTES = 60

export const securityReviewRule: CeremonyTriggerRule = {
  id: RULE_ID,
  description:
    'Schedule a security review when >=5 capability denials occur within a 60-minute window',
  triggers: ['CapabilityDenied'],

  async match(_envelope: EventEnvelope, ctx: TriggerContext): Promise<CeremonySpec | null> {
    const totalRows = await ctx.db.execute<{ total: number }>(dSQL`
      SELECT COUNT(*)::int AS total
      FROM audit.events
      WHERE event_type = 'CapabilityDenied'
        AND occurred_at > now() - interval '60 minutes'
    `)
    const total = Number((totalRows as unknown as Array<{ total: number }>)[0]?.total ?? 0)
    if (total < DENIAL_THRESHOLD) return null

    const personaRows = await ctx.db.execute<{ persona_id: string; denials: number }>(dSQL`
      SELECT
        COALESCE(payload->>'persona_id', actor->>'persona_id') AS persona_id,
        COUNT(*)::int AS denials
      FROM audit.events
      WHERE event_type = 'CapabilityDenied'
        AND occurred_at > now() - interval '60 minutes'
      GROUP BY persona_id
      ORDER BY denials DESC
      LIMIT 5
    `)
    const offending = (personaRows as unknown as Array<{
      persona_id: string | null
      denials: number
    }>)
      .filter((r): r is { persona_id: string; denials: number } => r.persona_id !== null)
      .map((r) => r.persona_id)

    return {
      ceremonyType: 'ad_hoc',
      scope: {
        intent: 'security_review',
        denials_in_window: total,
        window_minutes: WINDOW_MINUTES,
        offending_personas: offending,
      },
      triggeredBy: { type: 'system', component: 'ceremony_scheduler' },
      invitedRoles: ['security_officer', ...offending],
    }
  },
}
