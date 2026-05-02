/**
 * disagreement-tiebreaker rule.
 *
 * Fires on: DisagreementRaised
 *
 * ConflictService raises the event; this rule auto-spawns the tie-breaker
 * ceremony with the disputants. The tie-breaker role per domain is encoded
 * in TieBreakerPolicy (technical -> architect, product -> pm, etc.) — we
 * mirror that mapping here so the invited_roles hint is correct without
 * importing ConflictService internals.
 *
 * Spec: invite the tie-breaker persona + the actors named in the
 * DisagreementRaised payload.
 */

import type { EventEnvelope } from '@orbital/types'
import type { CeremonySpec, CeremonyTriggerRule, TriggerContext } from '../ceremony-scheduler.js'

const RULE_ID = 'disagreement-tiebreaker'

const TIE_BREAKER_BY_DOMAIN: Record<string, string> = {
  technical: 'architect',
  product: 'pm',
  security: 'security_officer',
  cross_cutting: 'principal_engineer',
}

export const disagreementTiebreakerRule: CeremonyTriggerRule = {
  id: RULE_ID,
  description: 'Schedule a tie-breaker ceremony when a disagreement is raised',
  triggers: ['DisagreementRaised'],

  async match(envelope: EventEnvelope, _ctx: TriggerContext): Promise<CeremonySpec | null> {
    const payload = envelope.payload as Record<string, unknown>
    const disagreementId = (payload['disagreement_id'] as string | undefined) ?? envelope.aggregate_id
    const domain = (payload['domain'] as string | undefined) ?? 'technical'
    const participants = Array.isArray(payload['participants']) ? payload['participants'] : []

    const tieBreakerRole = TIE_BREAKER_BY_DOMAIN[domain] ?? 'principal_engineer'
    const disputantRoles = (participants as Array<Record<string, unknown>>)
      .map((p) => {
        const actor = p['actor'] as Record<string, unknown> | null | undefined
        if (actor && typeof actor['persona_id'] === 'string') {
          return actor['persona_id']
        }
        return null
      })
      .filter((id): id is string => id !== null)

    return {
      ceremonyType: 'ad_hoc',
      scope: {
        intent: 'tie_breaker',
        disagreement_id: disagreementId,
        domain,
        disputants: disputantRoles,
      },
      triggeredBy: { type: 'system', component: 'ceremony_scheduler' },
      invitedRoles: [tieBreakerRole, ...disputantRoles],
    }
  },
}
