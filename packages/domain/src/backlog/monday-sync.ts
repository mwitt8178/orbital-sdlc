/**
 * backlog/monday-sync.ts — MondaySyncService.
 *
 * Per TRD-02 v0.2 §13.2 (push), §13.3 (pull/reconcile), §13.4 (webhook).
 *
 * Responsibilities:
 *   - onStoryCreated(story)        → push: createSubitem on Monday
 *   - onStoryStatusChanged(story)  → push: updateColumnValue
 *   - reconcile(boardId)           → pull: compare Monday board state to local;
 *                                    update last_seen_item_ids; emit MondaySyncCompleted
 *   - handleWebhookPayload(body)   → process Monday → Orbital push
 *
 * All push/pull cycles emit MondaySyncCompleted after each run.
 */

import { uuidv7 } from 'uuidv7'
import { createHash } from 'node:crypto'
import { eq, and } from 'drizzle-orm'
import { OrbitalError, type Actor, type EventInput } from '@orbital/types'
import type { DB } from '@orbital/db'
import type { EventStore } from '../events/store.js'
import type { MondayClient } from './monday-client.js'
import type { BoardMappingResolver } from './board-mapping-resolver.js'
import type { OrbitalState } from './board-mapping.js'
import {
  stories,
  mondaySyncState,
  type StoryRow,
  type MondayAggregateType,
} from '@orbital/db'
import { logger } from '../logger.js'
import { BACKLOG_ERROR_CODES } from './types.js'

const SYSTEM_ACTOR: Actor = { type: 'system', component: 'orchestrator' }

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MondaySyncServiceOptions {
  /** Default board id for reconciliation; null = no scheduled reconcile. */
  defaultBoardId?: string
  /** Reconciliation interval ms. Default 5 minutes. */
  reconcileIntervalMs?: number
  /**
   * Optional BoardMappingResolver. When provided, status writes use the
   * project's confirmed mapping instead of hardcoded column ids. When null
   * (or no mapping confirmed), the legacy hardcoded behavior is preserved.
   */
  mappingResolver?: BoardMappingResolver | null
}

export interface MondayWebhookPayload {
  /** Monday's challenge handshake. */
  challenge?: string
  /** Inbound event body. */
  event?: {
    type: string
    boardId?: number | string
    pulseId?: number | string
    columnId?: string
    value?: { label?: { text?: string } } | unknown
    previousValue?: unknown
  }
  /**
   * Webhook id for dedupe (Monday emits a unique id per delivery; tests pass
   * arbitrary strings).
   */
  webhookId?: string
}

export interface ReconcileResult {
  pulledCount: number
  driftCount: number
  boardId: string
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface MondaySyncService {
  onStoryCreated(story: StoryRow, parentEpicMondayItemId: string): Promise<{ mondaySubitemId: string }>
  onStoryStatusChanged(
    story: StoryRow,
    boardId: string,
    columnId: string,
    valueLabel: string,
  ): Promise<void>
  /**
   * Mapping-aware variant of onStoryStatusChanged. Resolves the project's
   * confirmed BoardMapping to determine the column id and label for the new
   * Orbital state, then writes to Monday. If no mapping is configured for the
   * project, logs a warning and skips the write (graceful degradation — does
   * NOT push canonical defaults onto an unmapped board).
   */
  onStoryStatusChangedWithMapping(
    story: StoryRow,
    boardId: string,
    projectId: string,
    newState: OrbitalState,
  ): Promise<{ skipped: boolean; reason?: string }>
  reconcile(boardId: string): Promise<ReconcileResult>
  handleWebhookPayload(
    payload: MondayWebhookPayload,
    actor?: Actor,
  ): Promise<{ accepted: boolean; reason?: string }>
  /**
   * Start the periodic reconcile timer. Idempotent — duplicate calls no-op.
   */
  startScheduledReconcile(boardId: string): void
  /**
   * Stop the periodic reconcile timer. Safe to call multiple times.
   */
  stopScheduledReconcile(): void
}

export class DefaultMondaySyncService implements MondaySyncService {
  private readonly reconcileIntervalMs: number
  private reconcileTimer: NodeJS.Timeout | null = null
  private readonly mappingResolver: BoardMappingResolver | null

  constructor(
    private readonly db: DB,
    private readonly eventStore: EventStore,
    private readonly client: MondayClient,
    options: MondaySyncServiceOptions = {},
  ) {
    this.reconcileIntervalMs = options.reconcileIntervalMs ?? 5 * 60 * 1000
    this.mappingResolver = options.mappingResolver ?? null
  }

  // -------------------------------------------------------------------------
  // Push: story created → Monday subitem
  // -------------------------------------------------------------------------

  async onStoryCreated(
    story: StoryRow,
    parentEpicMondayItemId: string,
  ): Promise<{ mondaySubitemId: string }> {
    const start = Date.now()

    try {
      const result = await this.client.createSubitem({
        parentItemId: parentEpicMondayItemId,
        itemName: story.title,
        columnValues: {
          status: { label: story.status },
        },
      })

      const now = new Date()
      const syncStateId = uuidv7()
      const pushHash = sha256Hash(
        JSON.stringify({ title: story.title, status: story.status }),
      )

      // Upsert mondaySyncState
      await this.db
        .insert(mondaySyncState)
        .values({
          syncStateId,
          aggregateType: 'story' as MondayAggregateType,
          aggregateId: story.storyId,
          mondayId: result.id,
          lastPushAt: now,
          lastPushHash: pushHash,
          lastSeenItemIds: [result.id],
          syncErrorCount: 0,
          schemaVersion: 1,
        })
        .onConflictDoUpdate({
          target: [mondaySyncState.aggregateType, mondaySyncState.aggregateId],
          set: {
            mondayId: result.id,
            lastPushAt: now,
            lastPushHash: pushHash,
            lastSeenItemIds: [result.id],
            syncErrorCount: 0,
            lastError: null,
          },
        })

      // Update local story with monday_item_id
      await this.db
        .update(stories)
        .set({ mondayItemId: result.id, updatedAt: now })
        .where(eq(stories.storyId, story.storyId))

      const ev: EventInput = {
        aggregate_id: story.storyId,
        aggregate_type: 'story',
        event_type: 'MondaySyncCompleted',
        payload: {
          direction: 'push',
          aggregate_type: 'story',
          count: 1,
          duration_ms: Date.now() - start,
          drift_count: 0,
        },
        actor: SYSTEM_ACTOR,
        trace_id: uuidv7(),
        occurred_at: now.toISOString(),
        schema_version: 1,
      }
      await this.eventStore.append(ev)

      return { mondaySubitemId: result.id }
    } catch (err) {
      await this.recordSyncError('story', story.storyId, err)
      throw err
    }
  }

  // -------------------------------------------------------------------------
  // Push: story status changed → Monday updateColumnValue
  // -------------------------------------------------------------------------

  async onStoryStatusChanged(
    story: StoryRow,
    boardId: string,
    columnId: string,
    valueLabel: string,
  ): Promise<void> {
    if (!story.mondayItemId) {
      logger.debug({ storyId: story.storyId }, 'MondaySyncService.onStoryStatusChanged: no monday_item_id; skip')
      return
    }
    const start = Date.now()

    try {
      const value = JSON.stringify({ label: valueLabel })
      await this.client.updateColumnValue({
        boardId,
        itemId: story.mondayItemId,
        columnId,
        value,
      })

      const now = new Date()
      const pushHash = sha256Hash(JSON.stringify({ status: story.status }))

      await this.db
        .update(mondaySyncState)
        .set({ lastPushAt: now, lastPushHash: pushHash, syncErrorCount: 0, lastError: null })
        .where(
          and(
            eq(mondaySyncState.aggregateType, 'story'),
            eq(mondaySyncState.aggregateId, story.storyId),
          ),
        )

      const ev: EventInput = {
        aggregate_id: story.storyId,
        aggregate_type: 'story',
        event_type: 'MondaySyncCompleted',
        payload: {
          direction: 'push',
          aggregate_type: 'story',
          count: 1,
          duration_ms: Date.now() - start,
          drift_count: 0,
        },
        actor: SYSTEM_ACTOR,
        trace_id: uuidv7(),
        occurred_at: now.toISOString(),
        schema_version: 1,
      }
      await this.eventStore.append(ev)
    } catch (err) {
      await this.recordSyncError('story', story.storyId, err)
      throw err
    }
  }

  // -------------------------------------------------------------------------
  // Push (mapping-aware): story status changed → Monday updateColumnValue
  // using the project's confirmed BoardMapping.
  // -------------------------------------------------------------------------

  async onStoryStatusChangedWithMapping(
    story: StoryRow,
    boardId: string,
    projectId: string,
    newState: OrbitalState,
  ): Promise<{ skipped: boolean; reason?: string }> {
    if (!story.mondayItemId) {
      logger.debug(
        { storyId: story.storyId },
        'MondaySyncService.onStoryStatusChangedWithMapping: no monday_item_id; skip',
      )
      return { skipped: true, reason: 'no_monday_item_id' }
    }
    if (!this.mappingResolver) {
      logger.warn(
        { storyId: story.storyId, projectId, boardId },
        'MondaySyncService.onStoryStatusChangedWithMapping: no resolver injected; skipping push',
      )
      return { skipped: true, reason: 'no_resolver' }
    }
    const status = await this.mappingResolver.resolveStatusColumn(projectId)
    if (!status) {
      logger.warn(
        { storyId: story.storyId, projectId, boardId },
        'MondaySyncService.onStoryStatusChangedWithMapping: no confirmed mapping; skipping push',
      )
      return { skipped: true, reason: 'no_mapping' }
    }
    const label = status.label_for_state(newState)
    if (!label) {
      logger.warn(
        { storyId: story.storyId, projectId, newState },
        'MondaySyncService.onStoryStatusChangedWithMapping: no label maps to state; skipping push',
      )
      return { skipped: true, reason: 'no_label_for_state' }
    }
    // Delegate to the existing low-level method so we share the rest of the
    // sync state / event-emit pipeline.
    await this.onStoryStatusChanged(story, boardId, status.column_id, label)
    return { skipped: false }
  }

  // -------------------------------------------------------------------------
  // Pull: reconciliation diff
  // -------------------------------------------------------------------------

  async reconcile(boardId: string): Promise<ReconcileResult> {
    const start = Date.now()

    const items = await this.client.getBoardItems(boardId)
    const itemIds = items.map((i) => i.id)

    // Compare against local stories with monday_item_id IN itemIds
    const driftRows: Array<{ storyId: string; mondayId: string; reason: string }> = []

    for (const item of items) {
      // Find local story by monday_item_id
      const local = await this.db
        .select()
        .from(stories)
        .where(eq(stories.mondayItemId, item.id))
        .limit(1)
      const story = local[0]
      if (!story) continue

      // Check status column drift (best-effort: status column convention)
      const statusCol = item.columnValues.find((c) => c.id === 'status')
      if (statusCol?.value) {
        try {
          const parsed = JSON.parse(statusCol.value) as { label?: string }
          if (parsed.label && parsed.label !== story.status) {
            driftRows.push({
              storyId: story.storyId,
              mondayId: item.id,
              reason: `status drift: local=${story.status} monday=${parsed.label}`,
            })
          }
        } catch {
          // ignore parse failures
        }
      }
    }

    const now = new Date()

    // Update last_seen_item_ids on the install-level sync state for the board
    // (we use a synthetic syncState row keyed by aggregate_type='sprint' / aggregate_id=fake for board)
    // Instead: find every existing mondaySyncState row for these mondayIds and update last_pull_at.
    if (itemIds.length > 0) {
      for (const item of items) {
        await this.db
          .update(mondaySyncState)
          .set({
            lastPullAt: now,
            lastSeenItemIds: itemIds,
          })
          .where(eq(mondaySyncState.mondayId, item.id))
      }
    }

    // Mark drift on rows that drifted
    for (const drift of driftRows) {
      await this.db
        .update(mondaySyncState)
        .set({ driftDetectedAt: now, lastError: drift.reason })
        .where(eq(mondaySyncState.mondayId, drift.mondayId))
    }

    // Use a synthetic UUIDv7 as the aggregate_id for board-scoped events; the
    // boardId is preserved in the payload for queryability.
    const ev: EventInput = {
      aggregate_id: uuidv7(),
      aggregate_type: 'sprint',
      event_type: 'MondaySyncCompleted',
      payload: {
        direction: 'pull',
        aggregate_type: 'story',
        board_id: boardId,
        count: items.length,
        duration_ms: Date.now() - start,
        drift_count: driftRows.length,
      },
      actor: SYSTEM_ACTOR,
      trace_id: uuidv7(),
      occurred_at: now.toISOString(),
      schema_version: 1,
    }
    await this.eventStore.append(ev)

    if (driftRows.length > 0) {
      logger.warn({ boardId, drift_count: driftRows.length }, 'MondaySyncService.reconcile: drift detected')
    }

    return {
      pulledCount: items.length,
      driftCount: driftRows.length,
      boardId,
    }
  }

  // -------------------------------------------------------------------------
  // Webhook handler
  // -------------------------------------------------------------------------

  async handleWebhookPayload(
    payload: MondayWebhookPayload,
    _actor: Actor = SYSTEM_ACTOR,
  ): Promise<{ accepted: boolean; reason?: string }> {
    // Challenge handshake: Monday sometimes echos a challenge for setup.
    if (payload.challenge) {
      return { accepted: true, reason: 'challenge' }
    }

    if (!payload.event) {
      return { accepted: false, reason: 'no event' }
    }

    const event = payload.event
    const start = Date.now()

    if (event.type === 'update_column_value' || event.type === 'change_column_value') {
      const itemId = event.pulseId !== undefined ? String(event.pulseId) : null
      if (!itemId) {
        return { accepted: false, reason: 'no pulseId' }
      }
      // Find the story
      const localRows = await this.db
        .select()
        .from(stories)
        .where(eq(stories.mondayItemId, itemId))
        .limit(1)
      const story = localRows[0]
      if (!story) {
        logger.warn({ itemId }, 'MondaySyncService.handleWebhookPayload: no local story for itemId')
        return { accepted: true, reason: 'unknown_item' }
      }

      const newLabel = extractStatusLabel(event.value)
      if (newLabel && newLabel !== story.status) {
        // Apply the change locally; emit StoryStatusChanged with actor.type='user'
        // Note: StoryStatus values are constrained; we accept whatever Monday says
        // but only emit if it parses to a known status.
        const validStatuses = [
          'backlog',
          'ready',
          'in_progress',
          'in_review',
          'done',
          'accepted',
          'blocked',
          'defective',
        ] as const
        type ValidStatus = (typeof validStatuses)[number]
        if (!(validStatuses as readonly string[]).includes(newLabel)) {
          logger.warn({ newLabel, storyId: story.storyId }, 'MondaySyncService.handleWebhookPayload: unknown status label')
          return { accepted: true, reason: 'unknown_status_label' }
        }
        const newStatus = newLabel as ValidStatus
        const now = new Date()
        await this.db
          .update(stories)
          .set({ status: newStatus, updatedAt: now })
          .where(eq(stories.storyId, story.storyId))

        const statusEv: EventInput = {
          aggregate_id: story.storyId,
          aggregate_type: 'story',
          event_type: 'StoryStatusChanged',
          payload: {
            story_id: story.storyId,
            from_status: story.status,
            to_status: newStatus,
            reason: 'monday_webhook',
            linked_artifacts: [],
          },
          actor: SYSTEM_ACTOR,
          trace_id: uuidv7(),
          occurred_at: now.toISOString(),
          schema_version: 1,
        }
        await this.eventStore.append(statusEv)
      }
    }

    const ev: EventInput = {
      // aggregate_id must be UUID; boardId/pulseId come through in payload
      aggregate_id: uuidv7(),
      aggregate_type: 'sprint',
      event_type: 'MondaySyncCompleted',
      payload: {
        direction: 'webhook',
        aggregate_type: 'story',
        board_id: event.boardId !== undefined ? String(event.boardId) : null,
        pulse_id: event.pulseId !== undefined ? String(event.pulseId) : null,
        count: 1,
        duration_ms: Date.now() - start,
        drift_count: 0,
      },
      actor: SYSTEM_ACTOR,
      trace_id: uuidv7(),
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    }
    await this.eventStore.append(ev)

    return { accepted: true }
  }

  // -------------------------------------------------------------------------
  // Reconcile scheduling
  // -------------------------------------------------------------------------

  /**
   * Start a periodic reconcile timer. Caller is responsible for stopping
   * before shutdown.
   */
  startScheduledReconcile(boardId: string): void {
    if (this.reconcileTimer) return
    this.reconcileTimer = setInterval(() => {
      this.reconcile(boardId).catch((err) => {
        logger.warn({ err }, 'MondaySyncService scheduled reconcile failed')
      })
    }, this.reconcileIntervalMs)
    // Don't keep the event loop alive on this timer
    if (typeof this.reconcileTimer.unref === 'function') this.reconcileTimer.unref()
  }

  stopScheduledReconcile(): void {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer)
      this.reconcileTimer = null
    }
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private async recordSyncError(
    aggregateType: MondayAggregateType,
    aggregateId: string,
    err: unknown,
  ): Promise<void> {
    const message = err instanceof Error ? err.message : String(err)
    try {
      const existingRows = await this.db
        .select({ syncErrorCount: mondaySyncState.syncErrorCount })
        .from(mondaySyncState)
        .where(
          and(
            eq(mondaySyncState.aggregateType, aggregateType),
            eq(mondaySyncState.aggregateId, aggregateId),
          ),
        )
        .limit(1)
      const nextCount = (existingRows[0]?.syncErrorCount ?? 0) + 1
      await this.db
        .update(mondaySyncState)
        .set({
          syncErrorCount: nextCount,
          lastError: message.slice(0, 1024),
        })
        .where(
          and(
            eq(mondaySyncState.aggregateType, aggregateType),
            eq(mondaySyncState.aggregateId, aggregateId),
          ),
        )
    } catch {
      // best-effort; never let error tracking shadow the original error
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractStatusLabel(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as { label?: { text?: string } | string }
  if (typeof v.label === 'string') return v.label
  if (typeof v.label === 'object' && typeof v.label?.text === 'string') return v.label.text
  return null
}

function sha256Hash(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

// Throw on unused import (BACKLOG_ERROR_CODES retained for OrbitalError consumers in tests)
void BACKLOG_ERROR_CODES

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMondaySyncService(
  db: DB,
  eventStore: EventStore,
  client: MondayClient,
  options: MondaySyncServiceOptions = {},
): MondaySyncService {
  return new DefaultMondaySyncService(db, eventStore, client, options)
}

// Re-export OrbitalError for callers
export { OrbitalError }
