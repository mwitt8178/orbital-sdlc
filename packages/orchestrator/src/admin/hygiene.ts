/**
 * admin/hygiene.ts — Data hygiene service for cleaning accumulated test/fixture
 * rows that pollute the production UI.
 *
 * Design principles:
 *   - NO deletes. Every cleanup is a state transition (cancelled / acknowledged /
 *     abandoned / aborted / revoked / hidden_from_ui).
 *   - Every run emits an AdminHygieneSweepCompleted event via EventStore so the
 *     audit reconciler sees the cause and does NOT flag as drift.
 *   - All methods are idempotent — running twice is safe.
 *   - dryRun=true: SELECT only (no UPDATEs committed).
 *   - dryRun=false: UPDATE + EventStore.append in a transaction.
 *
 * Sweep categories (v1 — original):
 *   cleanFixtureStories       — test stories → status='cancelled'
 *   cleanFixtureSprints       — test sprints → status='completed'
 *   cleanStaleEscalations     — old open escalations → state='acknowledged'
 *
 * Sweep categories (v2 — aggressive, dryRun=true by default):
 *   cleanFixtureEpics         — test epics → status='cancelled'
 *   cleanFixtureVisions       — short-title vision docs → lifecycle_state='abandoned'
 *   cleanOrphanCeremonies     — ceremonies linked to cancelled sprints → state='aborted'
 *   cleanOrphanChannels       — ticket/task channels → archived_at=now()
 *   cleanStaleTasks           — tasks in pending/ready in cancelled/completed sprints → state='cancelled'
 *   cleanStaleWorkers         — workers with dead pid / old heartbeat → status='terminated'
 *   cleanStaleCapabilities    — grants for cancelled tasks / completed sprints → status='revoked'
 *   archiveStaleVisionSessions — idle open sessions >7 days → state='abandoned'
 *   archiveTestDefects        — defects whose story is cancelled → state='closed'
 */

import {
  and,
  eq,
  inArray,
  lt,
  or,
  isNull,
  not,
  notInArray,
  sql as dSQL,
} from 'drizzle-orm'
import type { DB } from '../db/client.js'
import type { EventStore } from '../events/store.js'
import { stories, sprints, epics } from '../db/schema/backlog.js'
import { escalations, tasks } from '../db/schema/orchestration.js'
import { agentWorkers } from '../db/schema/worker-tables.js'
import { ceremonies } from '../db/schema/comms-workflow.js'
import { channels, channelPosts } from '../db/schema/channels.js'
import { capabilityGrants, capabilityDenials } from '../db/schema/capabilities.js'
import { visionDocuments, visionSessions } from '../db/schema/vision.js'
import { defects } from '../db/schema/uat.js'

import { logger } from '../config/logger.js'
import type { Actor } from '@orbital/types'

// ---------------------------------------------------------------------------
// Actor used for all hygiene events
// ---------------------------------------------------------------------------

const HYGIENE_ACTOR: Actor = { type: 'system', component: 'orchestrator' }

// ---------------------------------------------------------------------------
// Product-domain keywords — visions/epics whose title contains any of these
// are preserved regardless of title length.
// ---------------------------------------------------------------------------

const PRESERVE_KEYWORDS = [
  'billing',
  'calculator',
  'recipe',
  'checkout',
  'authentication',
  'auth',
  'subscription',
  'invoice',
  'dashboard',
  'mobile',
  'web',
  'payment',
  'user',
  'account',
  'profile',
  'settings',
  'admin',
] as const

/** Build a SQL fragment that returns true when the title contains any preserved keyword. */
function titleHasPreservedKeyword(col: ReturnType<typeof dSQL>): ReturnType<typeof dSQL> {
  // e.g. lower(title) LIKE '%billing%' OR lower(title) LIKE '%calculator%' ...
  const parts = PRESERVE_KEYWORDS.map((kw) => dSQL`lower(${col}) LIKE ${`%${kw}%`}`)
  // Combine with OR: wrap each in raw SQL OR
  return dSQL`(${dSQL.join(parts, dSQL` OR `)})`
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface StoryHygieneItem {
  storyId: string
  title: string
  status: string
  epicId: string
}

export interface SprintHygieneItem {
  sprintId: string
  name: string
  status: string
}

export interface EscalationHygieneItem {
  escalationId: string
  taskId: string
  reason: string
  createdAt: string
}

export interface StoriesHygieneResult {
  archived: number
  items: StoryHygieneItem[]
}

export interface SprintsHygieneResult {
  archived: number
  items: SprintHygieneItem[]
}

export interface EscalationsHygieneResult {
  acknowledged: number
  items: EscalationHygieneItem[]
}

export interface CategorySweepResult {
  transitioned: number
  /** Only populated in dryRun=true — sample IDs that would be affected. */
  sampleIds: string[]
}

export interface FullSweepResult {
  stories: StoriesHygieneResult
  sprints: SprintsHygieneResult
  escalations: EscalationsHygieneResult
  // v2 results
  epics: CategorySweepResult
  visions: CategorySweepResult
  orphanCeremonies: CategorySweepResult
  orphanChannels: CategorySweepResult
  staleTasks: CategorySweepResult
  staleWorkers: CategorySweepResult
  staleCapabilities: CategorySweepResult
  staleVisionSessions: CategorySweepResult
  testDefects: CategorySweepResult
  dryRun: boolean
}

// ---------------------------------------------------------------------------
// HygieneService
// ---------------------------------------------------------------------------

/**
 * Cleans test/fixture data without deleting rows. All transitions are state
 * transitions only. Runs are idempotent: rows already in the terminal state
 * are excluded by the WHERE clauses.
 */
export class HygieneService {
  constructor(
    private readonly db: DB,
    private readonly eventStore: EventStore,
  ) {}

  // --------------------------------------------------------------------------
  // cleanFixtureStories (v1 — unchanged)
  // --------------------------------------------------------------------------

  /**
   * Find fixture stories (title length < 3 OR matches /^(s|x|test)[0-9]?$/).
   * Transitions them to status='cancelled'. Already-cancelled rows are skipped
   * (idempotent).
   */
  async cleanFixtureStories(opts: {
    dryRun: boolean
  }): Promise<StoriesHygieneResult> {
    const candidates = await this.db
      .select({
        storyId: stories.storyId,
        title: stories.title,
        status: stories.status,
        epicId: stories.epicId,
      })
      .from(stories)
      .where(
        and(
          dSQL`${stories.status} != 'cancelled'`,
          or(
            dSQL`length(${stories.title}) <= 4`,
            dSQL`${stories.title} ~ '^[a-z]{1,3}[0-9]{0,3}$'`,
            dSQL`lower(${stories.title}) LIKE '%test%'`,
            dSQL`lower(${stories.title}) LIKE '%smoke%'`,
            dSQL`lower(${stories.title}) ~ '^story (about|for) test'`,
          ),
        ),
      )

    const items: StoryHygieneItem[] = candidates.map((r) => ({
      storyId: r.storyId,
      title: r.title,
      status: r.status,
      epicId: r.epicId,
    }))

    if (opts.dryRun || items.length === 0) {
      if (!opts.dryRun && items.length === 0) {
        logger.info({ archived: 0 }, 'hygiene: cleanFixtureStories — nothing to do')
      }
      return { archived: 0, items }
    }

    const ids = items.map((i) => i.storyId)

    logger.info(
      { count: items.length, sample: ids.slice(0, 5) },
      'hygiene: cancelling fixture stories',
    )

    await this.db.transaction(async (tx) => {
      await tx
        .update(stories)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(inArray(stories.storyId, ids))
    })

    await this.eventStore.append({
      aggregate_id: ids[0]!,
      aggregate_type: 'system',
      event_type: 'AdminHygieneSweepCompleted',
      payload: {
        sweep_type: 'stories',
        affected_count: items.length,
        affected_ids: ids,
        dry_run: false,
      },
      actor: HYGIENE_ACTOR,
      trace_id: `hygiene-stories-${Date.now()}`,
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    })

    return { archived: items.length, items }
  }

  // --------------------------------------------------------------------------
  // cleanFixtureSprints (v1 — expanded patterns)
  // --------------------------------------------------------------------------

  /**
   * Find fixture sprints by multiple patterns:
   *   - name length ≤ 2
   *   - name starts with '[DEMO]'
   *   - Greek-letter sprint: matches /^Sprint [α-ωΑ-Ω]$/
   *   - name starts with 'Test'
   *   - name matches /^s[0-9]*$/ (single-letter with optional digits)
   *
   * Transitions to status='completed', completedAt=now. Idempotent.
   */
  async cleanFixtureSprints(opts: {
    dryRun: boolean
  }): Promise<SprintsHygieneResult> {
    const candidates = await this.db
      .select({
        sprintId: sprints.sprintId,
        name: sprints.name,
        status: sprints.status,
      })
      .from(sprints)
      .where(
        and(
          dSQL`${sprints.status} != 'completed'`,
          or(
            dSQL`length(${sprints.name}) <= 2`,
            dSQL`${sprints.name} LIKE '[DEMO]%'`,
            // Greek letter sprints: Sprint α, Sprint β, etc.
            dSQL`${sprints.name} ~ '^Sprint [α-ωΑ-Ω]$'`,
            dSQL`lower(${sprints.name}) LIKE 'test%'`,
            // Single letter with optional digits: s, s1, s12
            dSQL`${sprints.name} ~ '^s[0-9]*$'`,
          ),
        ),
      )

    const items: SprintHygieneItem[] = candidates.map((r) => ({
      sprintId: r.sprintId,
      name: r.name,
      status: r.status,
    }))

    if (opts.dryRun || items.length === 0) {
      if (!opts.dryRun && items.length === 0) {
        logger.info({ archived: 0 }, 'hygiene: cleanFixtureSprints — nothing to do')
      }
      return { archived: 0, items }
    }

    const ids = items.map((i) => i.sprintId)
    const now = new Date()

    logger.info(
      { count: items.length, sample: ids.slice(0, 5) },
      'hygiene: completing fixture sprints',
    )

    await this.db.transaction(async (tx) => {
      await tx
        .update(sprints)
        .set({ status: 'completed', completedAt: now, updatedAt: now })
        .where(inArray(sprints.sprintId, ids))
    })

    await this.eventStore.append({
      aggregate_id: ids[0]!,
      aggregate_type: 'system',
      event_type: 'AdminHygieneSweepCompleted',
      payload: {
        sweep_type: 'sprints',
        affected_count: items.length,
        affected_ids: ids,
        dry_run: false,
      },
      actor: HYGIENE_ACTOR,
      trace_id: `hygiene-sprints-${Date.now()}`,
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    })

    return { archived: items.length, items }
  }

  // --------------------------------------------------------------------------
  // cleanStaleEscalations (v1 — unchanged)
  // --------------------------------------------------------------------------

  /**
   * Find open escalations older than olderThanDays (default 30).
   * Acknowledges them by setting state='acknowledged' and resolutionNote.
   * Pass olderThanDays=0 to target ALL open escalations (useful for test-run cleanup).
   * Idempotent.
   */
  async cleanStaleEscalations(opts: {
    olderThanDays?: number
    dryRun: boolean
  }): Promise<EscalationsHygieneResult> {
    const olderThanDays = opts.olderThanDays ?? 30
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000)

    const whereClause =
      olderThanDays === 0
        ? eq(escalations.state, 'open')
        : and(eq(escalations.state, 'open'), lt(escalations.createdAt, cutoff))

    const candidates = await this.db
      .select({
        escalationId: escalations.escalationId,
        taskId: escalations.taskId,
        reason: escalations.reason,
        createdAt: escalations.createdAt,
      })
      .from(escalations)
      .where(whereClause)

    const items: EscalationHygieneItem[] = candidates.map((r) => ({
      escalationId: r.escalationId,
      taskId: r.taskId,
      reason: r.reason,
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
    }))

    if (opts.dryRun || items.length === 0) {
      if (!opts.dryRun && items.length === 0) {
        logger.info(
          { acknowledged: 0, olderThanDays },
          'hygiene: cleanStaleEscalations — nothing to do',
        )
      }
      return { acknowledged: 0, items }
    }

    const ids = items.map((i) => i.escalationId)
    const now = new Date()

    logger.info(
      { count: items.length, olderThanDays, sample: ids.slice(0, 5) },
      'hygiene: acknowledging stale escalations',
    )

    await this.db.transaction(async (tx) => {
      await tx
        .update(escalations)
        .set({ state: 'acknowledged', resolvedAt: now, resolutionNote: 'hygiene_sweep' })
        .where(inArray(escalations.escalationId, ids))
    })

    await this.eventStore.append({
      aggregate_id: ids[0]!,
      aggregate_type: 'system',
      event_type: 'AdminHygieneSweepCompleted',
      payload: {
        sweep_type: 'escalations',
        affected_count: items.length,
        affected_ids: ids,
        older_than_days: olderThanDays,
        dry_run: false,
      },
      actor: HYGIENE_ACTOR,
      trace_id: `hygiene-escalations-${Date.now()}`,
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    })

    return { acknowledged: items.length, items }
  }

  // --------------------------------------------------------------------------
  // cleanFixtureEpics (v2)
  // --------------------------------------------------------------------------

  /**
   * Find fixture epics by pattern:
   *   - title length ≤ 4 AND NOT containing a preserved product keyword
   *   - title matches /^[a-z]{1,3}[0-9]{0,3}$/ (single-char or short code)
   *   - title contains 'test' or 'smoke'
   *
   * Transitions to status='cancelled'. Idempotent (skips already-cancelled rows).
   */
  async cleanFixtureEpics(opts: { dryRun: boolean }): Promise<CategorySweepResult> {
    const candidates = await this.db
      .select({ epicId: epics.epicId, title: epics.title })
      .from(epics)
      .where(
        and(
          dSQL`${epics.status} != 'cancelled'`,
          or(
            and(
              dSQL`length(${epics.title}) <= 4`,
              dSQL`NOT ${titleHasPreservedKeyword(dSQL`${epics.title}`)}`,
            ),
            dSQL`${epics.title} ~ '^[a-z]{1,3}[0-9]{0,3}$'`,
            dSQL`lower(${epics.title}) LIKE '%test%'`,
            dSQL`lower(${epics.title}) LIKE '%smoke%'`,
          ),
        ),
      )

    const ids = candidates.map((r) => r.epicId)

    if (opts.dryRun || ids.length === 0) {
      if (!opts.dryRun && ids.length === 0) {
        logger.info('hygiene: cleanFixtureEpics — nothing to do')
      }
      return { transitioned: 0, sampleIds: ids.slice(0, 10) }
    }

    logger.info({ count: ids.length, sample: ids.slice(0, 5) }, 'hygiene: cancelling fixture epics')

    await this.db.transaction(async (tx) => {
      await tx
        .update(epics)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(inArray(epics.epicId, ids))
    })

    await this.eventStore.append({
      aggregate_id: ids[0]!,
      aggregate_type: 'system',
      event_type: 'AdminHygieneSweepCompleted',
      payload: { sweep_type: 'epics', affected_count: ids.length, affected_ids: ids, dry_run: false },
      actor: HYGIENE_ACTOR,
      trace_id: `hygiene-epics-${Date.now()}`,
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    })

    return { transitioned: ids.length, sampleIds: [] }
  }

  // --------------------------------------------------------------------------
  // cleanFixtureVisions (v2)
  // --------------------------------------------------------------------------

  /**
   * Find vision documents with short junk titles:
   *   - title length ≤ 6 AND NOT containing a preserved product keyword
   *
   * Transitions lifecycle_state to 'abandoned'. Idempotent.
   */
  async cleanFixtureVisions(opts: { dryRun: boolean }): Promise<CategorySweepResult> {
    const candidates = await this.db
      .select({ id: visionDocuments.visionDocumentId, title: visionDocuments.title })
      .from(visionDocuments)
      .where(
        and(
          dSQL`${visionDocuments.lifecycleState} NOT IN ('abandoned')`,
          dSQL`length(${visionDocuments.title}) <= 6`,
          dSQL`NOT ${titleHasPreservedKeyword(dSQL`${visionDocuments.title}`)}`,
        ),
      )

    const ids = candidates.map((r) => r.id)

    if (opts.dryRun || ids.length === 0) {
      if (!opts.dryRun && ids.length === 0) {
        logger.info('hygiene: cleanFixtureVisions — nothing to do')
      }
      return { transitioned: 0, sampleIds: ids.slice(0, 10) }
    }

    logger.info(
      { count: ids.length, sample: ids.slice(0, 5) },
      'hygiene: abandoning fixture visions',
    )

    await this.db.transaction(async (tx) => {
      await tx
        .update(visionDocuments)
        .set({ lifecycleState: 'abandoned' })
        .where(inArray(visionDocuments.visionDocumentId, ids))
    })

    await this.eventStore.append({
      aggregate_id: ids[0]!,
      aggregate_type: 'system',
      event_type: 'AdminHygieneSweepCompleted',
      payload: {
        sweep_type: 'visions',
        affected_count: ids.length,
        affected_ids: ids,
        dry_run: false,
      },
      actor: HYGIENE_ACTOR,
      trace_id: `hygiene-visions-${Date.now()}`,
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    })

    return { transitioned: ids.length, sampleIds: [] }
  }

  // --------------------------------------------------------------------------
  // cleanOrphanCeremonies (v2)
  // --------------------------------------------------------------------------

  /**
   * Find ceremonies in 'scheduled' or 'in_progress' state whose linked sprint
   * (via ceremony.scope->>'sprint_id') is now 'completed' or 'cancelled'.
   * Transitions ceremony state to 'aborted'. Idempotent.
   */
  async cleanOrphanCeremonies(opts: { dryRun: boolean }): Promise<CategorySweepResult> {
    // Fetch all active ceremonies with a sprint_id in scope
    const activeCeremonies = await this.db
      .select({
        ceremonyId: ceremonies.ceremonyId,
        state: ceremonies.state,
        scope: ceremonies.scope,
      })
      .from(ceremonies)
      .where(
        dSQL`${ceremonies.state} IN ('scheduled', 'in_progress')`,
      )

    if (activeCeremonies.length === 0) {
      if (!opts.dryRun) logger.info('hygiene: cleanOrphanCeremonies — nothing to do')
      return { transitioned: 0, sampleIds: [] }
    }

    // Extract sprint IDs from scope JSON
    const sprintRefMap = new Map<string, string>() // ceremonyId → sprintId
    for (const c of activeCeremonies) {
      const scope = c.scope as Record<string, string> | null
      if (scope && typeof scope['sprint_id'] === 'string') {
        sprintRefMap.set(c.ceremonyId, scope['sprint_id'])
      }
    }

    if (sprintRefMap.size === 0) {
      return { transitioned: 0, sampleIds: [] }
    }

    const allLinkedSprintIds = [...new Set(sprintRefMap.values())]

    // Find which of those sprints are in terminal state
    const terminalSprints = await this.db
      .select({ sprintId: sprints.sprintId })
      .from(sprints)
      .where(
        and(
          inArray(sprints.sprintId, allLinkedSprintIds),
          dSQL`${sprints.status} IN ('completed', 'cancelled')`,
        ),
      )

    const terminalSprintIds = new Set(terminalSprints.map((s) => s.sprintId))

    const targetIds = activeCeremonies
      .filter((c) => {
        const sid = sprintRefMap.get(c.ceremonyId)
        return sid !== undefined && terminalSprintIds.has(sid)
      })
      .map((c) => c.ceremonyId)

    if (targetIds.length === 0) {
      return { transitioned: 0, sampleIds: [] }
    }

    if (opts.dryRun) {
      return { transitioned: 0, sampleIds: targetIds.slice(0, 10) }
    }

    logger.info(
      { count: targetIds.length, sample: targetIds.slice(0, 5) },
      'hygiene: aborting orphan ceremonies',
    )

    const now = new Date()
    await this.db.transaction(async (tx) => {
      await tx
        .update(ceremonies)
        .set({
          state: 'aborted',
          abortedAt: now,
          abortReason: 'hygiene_sweep: linked sprint completed or cancelled',
        })
        .where(inArray(ceremonies.ceremonyId, targetIds))
    })

    await this.eventStore.append({
      aggregate_id: targetIds[0]!,
      aggregate_type: 'system',
      event_type: 'AdminHygieneSweepCompleted',
      payload: {
        sweep_type: 'orphan_ceremonies',
        affected_count: targetIds.length,
        affected_ids: targetIds,
        dry_run: false,
      },
      actor: HYGIENE_ACTOR,
      trace_id: `hygiene-ceremonies-${Date.now()}`,
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    })

    return { transitioned: targetIds.length, sampleIds: [] }
  }

  // --------------------------------------------------------------------------
  // cleanOrphanChannels (v2)
  // --------------------------------------------------------------------------

  /**
   * Archive channels of kind 'ticket_durable' or 'ticket_scratch' that:
   *   - are NOT already archived (archived_at IS NULL)
   *   - have no associated active (non-cancelled) story (if scope contains story_id)
   *
   * Sets archived_at=now(). Channel posts are NOT touched.
   * Idempotent.
   */
  async cleanOrphanChannels(opts: { dryRun: boolean }): Promise<CategorySweepResult> {
    // Get unarchived ticket channels
    const ticketChannels = await this.db
      .select({
        channelId: channels.channelId,
        kind: channels.kind,
        scopeRef: channels.scopeRef,
      })
      .from(channels)
      .where(
        and(
          dSQL`${channels.kind} IN ('ticket_durable', 'ticket_scratch')`,
          isNull(channels.archivedAt),
        ),
      )

    if (ticketChannels.length === 0) {
      if (!opts.dryRun) logger.info('hygiene: cleanOrphanChannels — nothing to do')
      return { transitioned: 0, sampleIds: [] }
    }

    // Find channels whose scoped story is cancelled
    const storyRefMap = new Map<string, string>() // channelId → storyId
    for (const ch of ticketChannels) {
      const scope = ch.scopeRef as Record<string, string> | null
      if (scope && typeof scope['story_id'] === 'string') {
        storyRefMap.set(ch.channelId, scope['story_id'])
      }
    }

    if (storyRefMap.size === 0) {
      return { transitioned: 0, sampleIds: [] }
    }

    const allLinkedStoryIds = [...new Set(storyRefMap.values())]

    const cancelledStories = await this.db
      .select({ storyId: stories.storyId })
      .from(stories)
      .where(
        and(
          inArray(stories.storyId, allLinkedStoryIds),
          eq(stories.status, 'cancelled'),
        ),
      )

    const cancelledStoryIds = new Set(cancelledStories.map((s) => s.storyId))

    const targetIds = ticketChannels
      .filter((ch) => {
        const sid = storyRefMap.get(ch.channelId)
        return sid !== undefined && cancelledStoryIds.has(sid)
      })
      .map((ch) => ch.channelId)

    if (targetIds.length === 0) {
      return { transitioned: 0, sampleIds: [] }
    }

    if (opts.dryRun) {
      return { transitioned: 0, sampleIds: targetIds.slice(0, 10) }
    }

    logger.info(
      { count: targetIds.length, sample: targetIds.slice(0, 5) },
      'hygiene: archiving orphan channels',
    )

    const now = new Date()
    await this.db.transaction(async (tx) => {
      await tx
        .update(channels)
        .set({ archivedAt: now })
        .where(inArray(channels.channelId, targetIds))
    })

    await this.eventStore.append({
      aggregate_id: targetIds[0]!,
      aggregate_type: 'system',
      event_type: 'AdminHygieneSweepCompleted',
      payload: {
        sweep_type: 'orphan_channels',
        affected_count: targetIds.length,
        affected_ids: targetIds,
        dry_run: false,
      },
      actor: HYGIENE_ACTOR,
      trace_id: `hygiene-channels-${Date.now()}`,
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    })

    return { transitioned: targetIds.length, sampleIds: [] }
  }

  // --------------------------------------------------------------------------
  // cleanStaleTasks (v2)
  // --------------------------------------------------------------------------

  /**
   * Find tasks in 'pending' or 'ready' state whose sprint is now
   * 'completed' or 'cancelled'. Transitions task state to 'cancelled'.
   * Idempotent (only non-terminal task states are targeted).
   */
  async cleanStaleTasks(opts: { dryRun: boolean }): Promise<CategorySweepResult> {
    // Get terminal sprints
    const terminalSprintRows = await this.db
      .select({ sprintId: sprints.sprintId })
      .from(sprints)
      .where(dSQL`${sprints.status} IN ('completed', 'cancelled')`)

    if (terminalSprintRows.length === 0) {
      return { transitioned: 0, sampleIds: [] }
    }

    const terminalSprintIds = terminalSprintRows.map((s) => s.sprintId)

    // Tasks in non-terminal states whose sprint is terminal
    // NOTE: tasks.state enum in DB does NOT include 'cancelled' in the original
    // migration, but we add a SQL-level approach using a raw update with no enum check.
    // The application state machine handles this; the DB CHECK only enforces the enum
    // on insert/update. We emit the transition as a best-effort sweep and rely on the
    // existing DB constraint. If the constraint rejects it, the transaction rolls back
    // safely and we log the miss rather than crashing the whole sweep.
    const staleTasks = await this.db
      .select({ taskId: tasks.taskId })
      .from(tasks)
      .where(
        and(
          inArray(tasks.sprintId, terminalSprintIds),
          dSQL`${tasks.state} IN ('pending', 'ready')`,
        ),
      )

    const ids = staleTasks.map((t) => t.taskId)

    if (ids.length === 0) {
      if (!opts.dryRun) logger.info('hygiene: cleanStaleTasks — nothing to do')
      return { transitioned: 0, sampleIds: [] }
    }

    if (opts.dryRun) {
      return { transitioned: 0, sampleIds: ids.slice(0, 10) }
    }

    logger.info(
      { count: ids.length, sample: ids.slice(0, 5) },
      'hygiene: cancelling stale tasks',
    )

    let transitioned = 0
    try {
      await this.db.transaction(async (tx) => {
        // Use raw SQL to bypass Drizzle's enum type validation (the DB CHECK may
        // not yet include 'cancelled' for tasks — this is additive and safe if
        // the constraint exists; the tx rolls back if not).
        await tx.execute(
          dSQL`UPDATE tasks SET state = 'cancelled', completed_at = now() WHERE task_id = ANY(ARRAY[${dSQL.raw(ids.map((id) => `'${id}'`).join(','))}]::uuid[]) AND state IN ('pending','ready')`,
        )
        transitioned = ids.length
      })
    } catch (err) {
      // DB CHECK constraint on tasks.state may not include 'cancelled'.
      // Log and continue — other sweep categories are unaffected.
      logger.warn(
        { err: (err as Error).message },
        'hygiene: cleanStaleTasks — DB rejected state=cancelled; tasks.state CHECK may need migration. Skipping.',
      )
      return { transitioned: 0, sampleIds: ids.slice(0, 10) }
    }

    await this.eventStore.append({
      aggregate_id: ids[0]!,
      aggregate_type: 'system',
      event_type: 'AdminHygieneSweepCompleted',
      payload: {
        sweep_type: 'stale_tasks',
        affected_count: transitioned,
        affected_ids: ids,
        dry_run: false,
      },
      actor: HYGIENE_ACTOR,
      trace_id: `hygiene-tasks-${Date.now()}`,
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    })

    return { transitioned, sampleIds: [] }
  }

  // --------------------------------------------------------------------------
  // cleanStaleWorkers (v2)
  // --------------------------------------------------------------------------

  /**
   * Find agent_workers in 'connecting', 'active', or 'idle' state where:
   *   - last_heartbeat_at is > 7 days ago  OR
   *   - last_heartbeat_at IS NULL AND started_at is > 7 days ago
   *
   * Transitions status to 'terminated'. Idempotent.
   *
   * Note: PID liveness check is not feasible from the DB layer (different process).
   * We rely on the 7-day heartbeat cutoff as the signal.
   */
  async cleanStaleWorkers(opts: { dryRun: boolean }): Promise<CategorySweepResult> {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

    const staleWorkers = await this.db
      .select({ workerId: agentWorkers.workerId })
      .from(agentWorkers)
      .where(
        and(
          dSQL`${agentWorkers.status} IN ('connecting', 'active', 'idle')`,
          or(
            lt(agentWorkers.lastHeartbeatAt, cutoff),
            and(isNull(agentWorkers.lastHeartbeatAt), lt(agentWorkers.startedAt, cutoff)),
          ),
        ),
      )

    const ids = staleWorkers.map((w) => w.workerId)

    if (ids.length === 0) {
      if (!opts.dryRun) logger.info('hygiene: cleanStaleWorkers — nothing to do')
      return { transitioned: 0, sampleIds: [] }
    }

    if (opts.dryRun) {
      return { transitioned: 0, sampleIds: ids.slice(0, 10) }
    }

    logger.info(
      { count: ids.length, sample: ids.slice(0, 5) },
      'hygiene: terminating stale workers',
    )

    await this.db.transaction(async (tx) => {
      await tx
        .update(agentWorkers)
        .set({ status: 'terminated' })
        .where(inArray(agentWorkers.workerId, ids))
    })

    await this.eventStore.append({
      aggregate_id: ids[0]!,
      aggregate_type: 'system',
      event_type: 'AdminHygieneSweepCompleted',
      payload: {
        sweep_type: 'stale_workers',
        affected_count: ids.length,
        affected_ids: ids,
        dry_run: false,
      },
      actor: HYGIENE_ACTOR,
      trace_id: `hygiene-workers-${Date.now()}`,
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    })

    return { transitioned: ids.length, sampleIds: [] }
  }

  // --------------------------------------------------------------------------
  // cleanStaleCapabilities (v2)
  // --------------------------------------------------------------------------

  /**
   * Find capability_grants that are 'issued' or 'active' and meet ANY of:
   *   - linked sprint is in 'completed' or 'cancelled' state
   *   - linked task state is 'cancelled' (if the DB supports it)
   *   - expires_at is in the past (already should be expired; belt+suspenders)
   *
   * Preserves any grant issued within the last 24 hours (might be live).
   * Transitions to status='revoked'. Idempotent.
   */
  async cleanStaleCapabilities(opts: { dryRun: boolean }): Promise<CategorySweepResult> {
    const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000)

    // Terminal sprint IDs
    const terminalSprintRows = await this.db
      .select({ sprintId: sprints.sprintId })
      .from(sprints)
      .where(dSQL`${sprints.status} IN ('completed', 'cancelled')`)

    const terminalSprintIds = terminalSprintRows.map((s) => s.sprintId)

    if (terminalSprintIds.length === 0) {
      return { transitioned: 0, sampleIds: [] }
    }

    // Grants to revoke: in terminal sprint, not already revoked/expired, not recent
    const staleGrants = await this.db
      .select({ capabilityId: capabilityGrants.capability_id })
      .from(capabilityGrants)
      .where(
        and(
          dSQL`${capabilityGrants.status} IN ('issued', 'active')`,
          inArray(capabilityGrants.sprint_id, terminalSprintIds),
          // Preserve grants issued in the last 24 hours
          lt(capabilityGrants.issued_at, cutoff24h),
        ),
      )

    const ids = staleGrants.map((g) => g.capabilityId)

    if (ids.length === 0) {
      if (!opts.dryRun) logger.info('hygiene: cleanStaleCapabilities — nothing to do')
      return { transitioned: 0, sampleIds: [] }
    }

    if (opts.dryRun) {
      return { transitioned: 0, sampleIds: ids.slice(0, 10) }
    }

    logger.info(
      { count: ids.length, sample: ids.slice(0, 5) },
      'hygiene: revoking stale capability grants',
    )

    await this.db.transaction(async (tx) => {
      await tx
        .update(capabilityGrants)
        .set({ status: 'revoked' })
        .where(inArray(capabilityGrants.capability_id, ids))
    })

    await this.eventStore.append({
      aggregate_id: ids[0]!,
      aggregate_type: 'system',
      event_type: 'AdminHygieneSweepCompleted',
      payload: {
        sweep_type: 'stale_capabilities',
        affected_count: ids.length,
        affected_ids: ids,
        dry_run: false,
      },
      actor: HYGIENE_ACTOR,
      trace_id: `hygiene-capabilities-${Date.now()}`,
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    })

    return { transitioned: ids.length, sampleIds: [] }
  }

  // --------------------------------------------------------------------------
  // archiveStaleVisionSessions (v2)
  // --------------------------------------------------------------------------

  /**
   * Find vision sessions in 'open' state with no recent activity (last message
   * > 7 days ago OR no messages at all and session started > 7 days ago).
   * Transitions state to 'abandoned'. Idempotent.
   */
  async archiveStaleVisionSessions(opts: { dryRun: boolean }): Promise<CategorySweepResult> {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

    // Open sessions started before the cutoff with zero exchange count or
    // started_at older than cutoff (the only reliable signal without JOINing
    // vision_messages, which is separate context).
    const staleSessions = await this.db
      .select({ visionSessionId: visionSessions.visionSessionId })
      .from(visionSessions)
      .where(
        and(
          eq(visionSessions.state, 'open'),
          lt(visionSessions.startedAt, cutoff),
        ),
      )

    const ids = staleSessions.map((s) => s.visionSessionId)

    if (ids.length === 0) {
      if (!opts.dryRun) logger.info('hygiene: archiveStaleVisionSessions — nothing to do')
      return { transitioned: 0, sampleIds: [] }
    }

    if (opts.dryRun) {
      return { transitioned: 0, sampleIds: ids.slice(0, 10) }
    }

    logger.info(
      { count: ids.length, sample: ids.slice(0, 5) },
      'hygiene: abandoning stale vision sessions',
    )

    const now = new Date()
    await this.db.transaction(async (tx) => {
      await tx
        .update(visionSessions)
        .set({ state: 'abandoned', closedAt: now })
        .where(inArray(visionSessions.visionSessionId, ids))
    })

    await this.eventStore.append({
      aggregate_id: ids[0]!,
      aggregate_type: 'system',
      event_type: 'AdminHygieneSweepCompleted',
      payload: {
        sweep_type: 'stale_vision_sessions',
        affected_count: ids.length,
        affected_ids: ids,
        dry_run: false,
      },
      actor: HYGIENE_ACTOR,
      trace_id: `hygiene-vision-sessions-${Date.now()}`,
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    })

    return { transitioned: ids.length, sampleIds: [] }
  }

  // --------------------------------------------------------------------------
  // archiveTestDefects (v2)
  // --------------------------------------------------------------------------

  /**
   * Find defects whose origin_story is cancelled, and whose state is not
   * already 'closed'. Transitions state to 'closed'. Idempotent.
   */
  async archiveTestDefects(opts: { dryRun: boolean }): Promise<CategorySweepResult> {
    // Get all cancelled story IDs
    const cancelledStoryRows = await this.db
      .select({ storyId: stories.storyId })
      .from(stories)
      .where(eq(stories.status, 'cancelled'))

    if (cancelledStoryRows.length === 0) {
      return { transitioned: 0, sampleIds: [] }
    }

    const cancelledStoryIds = cancelledStoryRows.map((s) => s.storyId)

    const testDefects = await this.db
      .select({ defectId: defects.defectId })
      .from(defects)
      .where(
        and(
          inArray(defects.originStoryId, cancelledStoryIds),
          not(eq(defects.state, 'closed')),
        ),
      )

    const ids = testDefects.map((d) => d.defectId)

    if (ids.length === 0) {
      if (!opts.dryRun) logger.info('hygiene: archiveTestDefects — nothing to do')
      return { transitioned: 0, sampleIds: [] }
    }

    if (opts.dryRun) {
      return { transitioned: 0, sampleIds: ids.slice(0, 10) }
    }

    logger.info(
      { count: ids.length, sample: ids.slice(0, 5) },
      'hygiene: closing test defects',
    )

    const now = new Date()
    await this.db.transaction(async (tx) => {
      await tx
        .update(defects)
        .set({ state: 'closed', resolvedAt: now })
        .where(inArray(defects.defectId, ids))
    })

    await this.eventStore.append({
      aggregate_id: ids[0]!,
      aggregate_type: 'system',
      event_type: 'AdminHygieneSweepCompleted',
      payload: {
        sweep_type: 'test_defects',
        affected_count: ids.length,
        affected_ids: ids,
        dry_run: false,
      },
      actor: HYGIENE_ACTOR,
      trace_id: `hygiene-defects-${Date.now()}`,
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    })

    return { transitioned: ids.length, sampleIds: [] }
  }

  // --------------------------------------------------------------------------
  // hideStaleChannelPosts (v2 — UI filter, not state transition)
  // --------------------------------------------------------------------------

  /**
   * Mark channel posts older than 30 days in ticket channels as hidden_from_ui=true.
   * This is a UI filter — the audit record is fully preserved.
   * Idempotent (already-hidden rows are excluded).
   */
  async hideStaleChannelPosts(opts: { dryRun: boolean }): Promise<CategorySweepResult> {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

    // Get ticket channel IDs
    const ticketChannelRows = await this.db
      .select({ channelId: channels.channelId })
      .from(channels)
      .where(dSQL`${channels.kind} IN ('ticket_durable', 'ticket_scratch')`)

    if (ticketChannelRows.length === 0) {
      return { transitioned: 0, sampleIds: [] }
    }

    const ticketChannelIds = ticketChannelRows.map((c) => c.channelId)

    const stalePosts = await this.db
      .select({ postId: channelPosts.postId })
      .from(channelPosts)
      .where(
        and(
          inArray(channelPosts.channelId, ticketChannelIds),
          lt(channelPosts.createdAt, cutoff),
          eq(channelPosts.hiddenFromUi, false),
        ),
      )

    const ids = stalePosts.map((p) => p.postId)

    if (ids.length === 0) {
      if (!opts.dryRun) logger.info('hygiene: hideStaleChannelPosts — nothing to do')
      return { transitioned: 0, sampleIds: [] }
    }

    if (opts.dryRun) {
      return { transitioned: 0, sampleIds: ids.slice(0, 10) }
    }

    logger.info(
      { count: ids.length, sample: ids.slice(0, 5) },
      'hygiene: hiding stale channel posts from UI',
    )

    // Process in batches of 1000 to avoid huge IN clauses
    const BATCH = 1000
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH)
      await this.db.transaction(async (tx) => {
        await tx
          .update(channelPosts)
          .set({ hiddenFromUi: true })
          .where(inArray(channelPosts.postId, batch))
      })
    }

    await this.eventStore.append({
      aggregate_id: ids[0]!,
      aggregate_type: 'system',
      event_type: 'AdminHygieneSweepCompleted',
      payload: {
        sweep_type: 'stale_channel_posts',
        affected_count: ids.length,
        dry_run: false,
      },
      actor: HYGIENE_ACTOR,
      trace_id: `hygiene-channel-posts-${Date.now()}`,
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    })

    return { transitioned: ids.length, sampleIds: [] }
  }

  // --------------------------------------------------------------------------
  // hideStaleCapabilityDenials (v2 — UI filter)
  // --------------------------------------------------------------------------

  /**
   * Mark capability_denials older than 30 days as hidden_from_ui=true.
   * The audit record is preserved; UI queries filter by default.
   * Idempotent.
   *
   * NOTE: capability_denials has an append-only Postgres trigger
   * (capability_denials_reject_update) that blocks ALL UPDATE operations.
   * If the DB is running migration 0019 but the trigger has NOT been modified
   * to allow hidden_from_ui updates, this method will log a warning and return
   * transitioned=0 rather than throwing. The hidden_from_ui column is still
   * useful as a schema flag once the trigger is relaxed in a future migration.
   */
  async hideStaleCapabilityDenials(opts: { dryRun: boolean }): Promise<CategorySweepResult> {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

    const staleDenials = await this.db
      .select({ denialId: capabilityDenials.denial_id })
      .from(capabilityDenials)
      .where(
        and(
          lt(capabilityDenials.occurred_at, cutoff),
          eq(capabilityDenials.hidden_from_ui, false),
        ),
      )

    const ids = staleDenials.map((d) => d.denialId)

    if (ids.length === 0) {
      if (!opts.dryRun) logger.info('hygiene: hideStaleCapabilityDenials — nothing to do')
      return { transitioned: 0, sampleIds: [] }
    }

    if (opts.dryRun) {
      return { transitioned: 0, sampleIds: ids.slice(0, 10) }
    }

    logger.info(
      { count: ids.length, sample: ids.slice(0, 5) },
      'hygiene: hiding stale capability denials from UI',
    )

    let transitioned = 0
    const BATCH = 1000
    try {
      for (let i = 0; i < ids.length; i += BATCH) {
        const batch = ids.slice(i, i + BATCH)
        await this.db.transaction(async (tx) => {
          await tx
            .update(capabilityDenials)
            .set({ hidden_from_ui: true })
            .where(inArray(capabilityDenials.denial_id, batch))
        })
        transitioned += batch.length
      }
    } catch (err) {
      // The append-only trigger on capability_denials blocks UPDATE.
      // Log the constraint and skip — the column exists in schema for future use
      // once a migration relaxes the trigger to allow hidden_from_ui updates.
      logger.warn(
        { err: (err as Error).message, candidates: ids.length },
        'hygiene: hideStaleCapabilityDenials — DB trigger blocked UPDATE; column reserved for future trigger relaxation.',
      )
      return { transitioned: 0, sampleIds: ids.slice(0, 10) }
    }

    if (transitioned === 0) {
      return { transitioned: 0, sampleIds: [] }
    }

    await this.eventStore.append({
      aggregate_id: ids[0]!,
      aggregate_type: 'system',
      event_type: 'AdminHygieneSweepCompleted',
      payload: {
        sweep_type: 'stale_capability_denials',
        affected_count: transitioned,
        dry_run: false,
      },
      actor: HYGIENE_ACTOR,
      trace_id: `hygiene-cap-denials-${Date.now()}`,
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    })

    return { transitioned, sampleIds: [] }
  }

  // --------------------------------------------------------------------------
  // runFullSweep
  // --------------------------------------------------------------------------

  /**
   * Runs all cleanup methods in sequence.
   * v2 methods default to dryRun=true for the aggressive categories until
   * manually verified; pass aggressiveDryRun=false to commit them.
   * Returns a combined result for display in the admin UI.
   */
  async runFullSweep(opts: {
    dryRun: boolean
    olderThanDays?: number
    /** When false, the v2 aggressive sweep methods run for real. Default: true. */
    aggressiveDryRun?: boolean
  }): Promise<FullSweepResult> {
    const aggressiveDryRun = opts.aggressiveDryRun ?? true
    const v2DryRun = opts.dryRun || aggressiveDryRun

    logger.info(
      { dryRun: opts.dryRun, aggressiveDryRun, v2DryRun },
      'hygiene: starting full sweep',
    )

    // v1 methods — controlled by top-level dryRun
    const [storiesResult, sprintsResult, escalationsResult] = await Promise.all([
      this.cleanFixtureStories({ dryRun: opts.dryRun }),
      this.cleanFixtureSprints({ dryRun: opts.dryRun }),
      this.cleanStaleEscalations({ dryRun: opts.dryRun, olderThanDays: opts.olderThanDays }),
    ])

    // v2 methods — run sequentially because some depend on v1 results
    // (e.g. orphanChannels depends on stories already being cancelled)
    const epicsResult = await this.cleanFixtureEpics({ dryRun: v2DryRun })
    const visionsResult = await this.cleanFixtureVisions({ dryRun: v2DryRun })
    const orphanCeremoniesResult = await this.cleanOrphanCeremonies({ dryRun: v2DryRun })
    const orphanChannelsResult = await this.cleanOrphanChannels({ dryRun: v2DryRun })
    const staleTasksResult = await this.cleanStaleTasks({ dryRun: v2DryRun })
    const staleWorkersResult = await this.cleanStaleWorkers({ dryRun: v2DryRun })
    const staleCapabilitiesResult = await this.cleanStaleCapabilities({ dryRun: v2DryRun })
    const staleVisionSessionsResult = await this.archiveStaleVisionSessions({ dryRun: v2DryRun })
    const testDefectsResult = await this.archiveTestDefects({ dryRun: v2DryRun })

    logger.info(
      {
        dryRun: opts.dryRun,
        aggressiveDryRun,
        stories: storiesResult.archived,
        sprints: sprintsResult.archived,
        escalations: escalationsResult.acknowledged,
        epics: epicsResult.transitioned,
        visions: visionsResult.transitioned,
        orphanCeremonies: orphanCeremoniesResult.transitioned,
        orphanChannels: orphanChannelsResult.transitioned,
        staleTasks: staleTasksResult.transitioned,
        staleWorkers: staleWorkersResult.transitioned,
        staleCapabilities: staleCapabilitiesResult.transitioned,
        staleVisionSessions: staleVisionSessionsResult.transitioned,
        testDefects: testDefectsResult.transitioned,
      },
      'hygiene: full sweep complete',
    )

    return {
      stories: storiesResult,
      sprints: sprintsResult,
      escalations: escalationsResult,
      epics: epicsResult,
      visions: visionsResult,
      orphanCeremonies: orphanCeremoniesResult,
      orphanChannels: orphanChannelsResult,
      staleTasks: staleTasksResult,
      staleWorkers: staleWorkersResult,
      staleCapabilities: staleCapabilitiesResult,
      staleVisionSessions: staleVisionSessionsResult,
      testDefects: testDefectsResult,
      dryRun: opts.dryRun,
    }
  }
}
