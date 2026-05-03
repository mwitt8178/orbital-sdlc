/**
 * architecture-review rule.
 *
 * Fires on: StoryStatusChanged (transition to 'ready')
 *
 * Match condition: story.risk_class == 'high'. The story-level risk_class is
 * derived from the linked epic and any explicit override carried on the
 * acceptance criteria; for v1 we read it via the story's monday/linked
 * artifacts, falling back to a heuristic on the description for stories
 * whose risk_class column hasn't been provisioned yet (story_acceptance
 * decisions are still wired in TRD-02 v0.3). Until the column exists, we
 * inspect linked_artifacts for { type: 'risk', id: 'high' }.
 *
 * Spec: invite Architect + Senior Developer.
 */

import { sql as dSQL } from 'drizzle-orm'
import type { EventEnvelope } from '@orbital/types'
import type { CeremonySpec, CeremonyTriggerRule, TriggerContext } from '../ceremony-scheduler.js'

const RULE_ID = 'architecture-review'

export const architectureReviewRule: CeremonyTriggerRule = {
  id: RULE_ID,
  description:
    'Schedule architecture review when a high-risk story transitions to ready',
  triggers: ['StoryStatusChanged'],

  async match(envelope: EventEnvelope, ctx: TriggerContext): Promise<CeremonySpec | null> {
    const payload = envelope.payload as Record<string, unknown>
    const newStatus = payload['new_status'] as string | undefined
    if (newStatus !== 'ready') return null

    const storyId = (payload['story_id'] as string | undefined) ?? envelope.aggregate_id

    const rows = await ctx.db.execute<{
      story_id: string
      title: string
      linked_artifacts: Array<{ type: string; id: string }>
    }>(dSQL`
      SELECT story_id, title, linked_artifacts
      FROM stories
      WHERE story_id = ${storyId}
      LIMIT 1
    `)
    const arr = rows as unknown as Array<{
      story_id: string
      title: string
      linked_artifacts: Array<{ type: string; id: string }> | null
    }>
    const story = arr[0]
    if (!story) return null

    const linked = Array.isArray(story.linked_artifacts) ? story.linked_artifacts : []
    const isHighRisk = linked.some((a) => a.type === 'risk' && a.id === 'high')
    if (!isHighRisk) return null

    return {
      ceremonyType: 'architecture_review',
      scope: {
        story_id: storyId,
        title: story.title,
      },
      triggeredBy: { type: 'system', component: 'ceremony_scheduler' },
      invitedRoles: ['architect', 'senior_developer'],
    }
  },
}
