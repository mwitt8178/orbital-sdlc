/**
 * vision/auto-decompose.ts — VisionDecomposer: decomposes a locked vision
 * document into a starter backlog (3-5 epics, each with 2-3 stories + ACs).
 *
 * Entry point:
 *   new VisionDecomposer(db, eventStore).decompose(visionDocumentId)
 *
 * Behaviour:
 *   1. Reads the locked vision_versions row for the given vision_document_id.
 *   2. Calls suggestEpicsFromVision() (vision/epic-suggester.ts) for epic templates.
 *   3. For each epic, materialises 2-3 stories with titles, descriptions, ACs,
 *      story_points, and priority from the per-story template map.
 *   4. Wraps all DB inserts in a single db.transaction() — partial failures rollback.
 *   5. Emits EpicCreated and StoryCreated events per row, then a summary
 *      BacklogAutoDecomposed event.
 *   6. All events go through EventStore.append (no db.insert(events)).
 *
 * Idempotency is handled by the caller (auto-decompose-subscriber.ts) which
 * checks for a prior BacklogAutoDecomposed event before calling decompose().
 *
 * Auto-generated rows are marked with:
 *   auto_generated_metadata = { source: 'vision_lock', vision_document_id, version }
 *
 * The project_id written to epics/stories is read from vision_documents.install_id
 * (no cross-context FK; nullable uuid convention per TRD-04 §4.1).
 */

import { uuidv7 } from 'uuidv7'
import { eq, and } from 'drizzle-orm'
import { sql as dSQL } from 'drizzle-orm'
import type { DB } from '../db/client.js'
import type { EventStore } from '../events/store.js'
import { visionDocuments, visionVersions } from '../db/schema/vision.js'
import { epics, stories, storyAcceptanceCriteria } from '../db/schema/backlog.js'
import { suggestEpicsFromVision, type SuggestedEpic } from './epic-suggester.js'
import { logger } from '../config/logger.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * djb2 hash of a string → a signed bigint in the Postgres bigint range
 * [-2^63, 2^63-1]. Used as advisory lock keys.
 *
 * Pure function — same input always produces the same output. No crypto
 * dependency needed; we just need collision-resistance at the advisory-lock
 * level, not cryptographic strength.
 */
function djb2BigInt(s: string): bigint {
  let hash = 5381n
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5n) + hash + BigInt(s.charCodeAt(i))) & 0xffffffffffffffffn
  }
  // Convert unsigned 64-bit to signed 64-bit by sign-extending.
  const MAX_SIGNED = 0x7fffffffffffffffn
  return hash > MAX_SIGNED ? hash - 0x10000000000000000n : hash
}

// ---------------------------------------------------------------------------
// Public result type
// ---------------------------------------------------------------------------

export interface DecomposeResult {
  vision_document_id: string
  vision_version_id: string
  version_number: number
  epic_count: number
  story_count: number
  epic_ids: string[]
  story_ids: string[]
}

// ---------------------------------------------------------------------------
// Story template data
// ---------------------------------------------------------------------------

/**
 * Per-story template shape. Each SuggestedEpic has story_titles[] from
 * the suggester; we pair each title with a generic description, 2-3 ACs,
 * story_points and a priority offset.
 */
interface StoryTemplate {
  title: string
  description: string
  acceptance_criteria: string[]
  story_points: 1 | 2 | 3 | 5
}

/**
 * Build story templates for a suggested epic's story_titles[].
 * We take up to 3 story titles from the epic (the suggester may supply 2-4)
 * and fill in generic but plausible description + ACs.
 *
 * The AC texts are deliberately generic so they apply to any story:
 *   - "User can complete the action without errors"
 *   - "System persists the change durably"
 *   - "Audit log records the event with actor context"
 *
 * Points follow a simple repeating pattern: 2, 3, 1 (small numbers so the
 * user can adjust later without feeling the initial estimate is far off).
 */
function buildStoryTemplates(epic: SuggestedEpic): StoryTemplate[] {
  const POINT_CYCLE: Array<1 | 2 | 3 | 5> = [2, 3, 1]
  const MAX_STORIES = 3

  return epic.story_titles.slice(0, MAX_STORIES).map((title, idx) => ({
    title,
    description: `${title}. This story covers the core user journey for this capability within the ${epic.title} epic. Adjust the acceptance criteria below to match your specific requirements before pulling into a sprint.`,
    acceptance_criteria: [
      'User can complete the action without errors in the happy-path flow.',
      'System persists the change durably and the result is visible on the next page load.',
      'Audit log records the event with actor context so operators can trace the change.',
    ],
    story_points: POINT_CYCLE[idx % POINT_CYCLE.length]!,
  }))
}

// ---------------------------------------------------------------------------
// VisionDecomposer
// ---------------------------------------------------------------------------

export class VisionDecomposer {
  constructor(
    private readonly db: DB,
    private readonly eventStore: EventStore,
  ) {}

  /**
   * Decompose a locked vision into starter epics + stories.
   *
   * Throws if:
   *   - vision_documents row not found
   *   - no locked vision_versions row exists for this document
   *
   * All DB inserts happen inside a single transaction; on error the transaction
   * rolls back and the error propagates to the caller.
   */
  async decompose(visionDocumentId: string): Promise<DecomposeResult> {
    const now = new Date().toISOString()

    // ------------------------------------------------------------------
    // 1. Fetch vision document + locked version
    // ------------------------------------------------------------------
    const docRows = await this.db
      .select()
      .from(visionDocuments)
      .where(eq(visionDocuments.visionDocumentId, visionDocumentId))
      .limit(1)

    const doc = docRows[0]
    if (!doc) {
      throw new Error(`VisionDecomposer: vision_document ${visionDocumentId} not found`)
    }

    if (!doc.currentVersionId) {
      throw new Error(
        `VisionDecomposer: vision_document ${visionDocumentId} has no current version`,
      )
    }

    const versionRows = await this.db
      .select()
      .from(visionVersions)
      .where(eq(visionVersions.visionVersionId, doc.currentVersionId))
      .limit(1)

    const version = versionRows[0]
    if (!version) {
      throw new Error(
        `VisionDecomposer: vision_version ${doc.currentVersionId} not found`,
      )
    }
    if (version.isLocked !== 1) {
      throw new Error(
        `VisionDecomposer: vision_version ${version.visionVersionId} is not locked (isLocked=${version.isLocked})`,
      )
    }

    const content = version.content as Record<string, unknown>
    const versionNumber = version.versionNumber
    const visionVersionId = version.visionVersionId

    // ------------------------------------------------------------------
    // 2. Suggest epics from vision content
    // ------------------------------------------------------------------
    const { epics: suggestedEpics } = suggestEpicsFromVision(content)

    // Assign priority: first 2 get 'high' (priority=1,2); rest get 'medium' (3+).
    // We store priority as a dense integer (lower = higher priority) per backlog schema.
    const epicIds: string[] = []
    const storyIds: string[] = []

    const autoMeta = {
      source: 'vision_lock' as const,
      vision_document_id: visionDocumentId,
      version: versionNumber,
    }

    const actor = { type: 'system' as const, component: 'orchestrator' as const }

    // ------------------------------------------------------------------
    // 3. Write all rows in a single transaction
    //    The idempotency check runs INSIDE the transaction so the check
    //    and the first insert are atomic — prevents concurrent double-runs
    //    that both passed the pre-transaction check above.
    // ------------------------------------------------------------------
    let alreadyDoneInTx = false
    await this.db.transaction(async (tx) => {
      // Acquire a Postgres advisory lock scoped to this transaction.
      // The lock key is derived from the visionDocumentId + versionNumber via a
      // deterministic hash so concurrent decompose() calls for the same vision serialise:
      //   - first caller acquires the lock
      //   - second caller blocks until first commits (acquiring the lock after)
      //   - second caller then sees the existing epics via the in-tx re-check
      //
      // pg_advisory_xact_lock is transaction-scoped (auto-released on commit/rollback).
      // We hash the combination using djb2 and sign-extend to a JS-safe bigint range.
      //
      // NOTE: We use the blocking form (not try_), so this waits rather than
      // skipping — guarantees one-at-a-time serialisation.
      const lockKey = djb2BigInt(`${visionDocumentId}:${versionNumber}`)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tx as any).execute(dSQL`SELECT pg_advisory_xact_lock(${lockKey})`)

      // Re-check inside the tx for atomicity (after acquiring the advisory lock).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const existingEpics = await (tx as any)
        .select({ epicId: epics.epicId })
        .from(epics)
        .where(
          and(
            dSQL`${epics.autoGeneratedMetadata}->>'vision_document_id' = ${visionDocumentId}`,
            dSQL`(${epics.autoGeneratedMetadata}->>'version')::int = ${versionNumber}`,
          ),
        )
        .limit(1) as Array<{ epicId: string }>

      if (existingEpics.length > 0) {
        alreadyDoneInTx = true
        return // release lock on commit, no inserts
      }

      for (let epicIdx = 0; epicIdx < suggestedEpics.length; epicIdx++) {
        const suggested = suggestedEpics[epicIdx]!
        const epicId = uuidv7()
        epicIds.push(epicId)

        // Insert epic row
        await tx.insert(epics).values({
          epicId,
          visionVersionId,
          title: suggested.title,
          rationale: suggested.description,
          priority: epicIdx + 1,
          status: 'draft',
          autoGeneratedMetadata: autoMeta,
        })

        // Insert 2-3 story rows + ACs for this epic
        const storyTemplates = buildStoryTemplates(suggested)

        for (let storyIdx = 0; storyIdx < storyTemplates.length; storyIdx++) {
          const tmpl = storyTemplates[storyIdx]!
          const storyId = uuidv7()
          storyIds.push(storyId)

          await tx.insert(stories).values({
            storyId,
            epicId,
            title: tmpl.title,
            description: tmpl.description,
            status: 'backlog',
            storyPoints: tmpl.story_points,
            priority: storyIdx + 1,
            autoGeneratedMetadata: autoMeta,
          })

          // Insert ACs for this story
          for (let acIdx = 0; acIdx < tmpl.acceptance_criteria.length; acIdx++) {
            const acId = uuidv7()
            await tx.insert(storyAcceptanceCriteria).values({
              acId,
              storyId,
              ordinal: acIdx + 1,
              text: tmpl.acceptance_criteria[acIdx]!,
            })
          }
        }
      }
    })

    // If the in-transaction idempotency check found existing rows, skip event emission.
    if (alreadyDoneInTx) {
      logger.info(
        { visionDocumentId, versionNumber },
        'VisionDecomposer: already decomposed (detected inside tx); skipping event emission',
      )
      return {
        vision_document_id: visionDocumentId,
        vision_version_id: visionVersionId,
        version_number: versionNumber,
        epic_count: 0,
        story_count: 0,
        epic_ids: [],
        story_ids: [],
      }
    }

    // ------------------------------------------------------------------
    // 4. Emit events via EventStore.append (NOT db.insert(events))
    // ------------------------------------------------------------------

    // EpicCreated per epic
    for (const epicId of epicIds) {
      await this.eventStore.append({
        aggregate_id: epicId,
        aggregate_type: 'epic',
        event_type: 'EpicCreated',
        payload: {
          epic_id: epicId,
          vision_document_id: visionDocumentId,
          vision_version_id: visionVersionId,
          auto_generated: true,
          source: 'vision_lock',
        },
        actor,
        trace_id: visionDocumentId,
        occurred_at: now,
        schema_version: 1,
      })
    }

    // StoryCreated per story
    for (const storyId of storyIds) {
      await this.eventStore.append({
        aggregate_id: storyId,
        aggregate_type: 'story',
        event_type: 'StoryCreated',
        payload: {
          story_id: storyId,
          vision_document_id: visionDocumentId,
          auto_generated: true,
          source: 'vision_lock',
        },
        actor,
        trace_id: visionDocumentId,
        occurred_at: now,
        schema_version: 1,
      })
    }

    // BacklogAutoDecomposed summary event
    await this.eventStore.append({
      aggregate_id: visionDocumentId,
      aggregate_type: 'vision_document',
      event_type: 'BacklogAutoDecomposed',
      payload: {
        vision_document_id: visionDocumentId,
        vision_version_id: visionVersionId,
        locked_version_number: versionNumber,
        epic_count: epicIds.length,
        story_count: storyIds.length,
        epic_ids: epicIds,
        story_ids: storyIds,
      },
      actor,
      trace_id: visionDocumentId,
      occurred_at: now,
      schema_version: 1,
    })

    logger.info(
      {
        visionDocumentId,
        visionVersionId,
        versionNumber,
        epicCount: epicIds.length,
        storyCount: storyIds.length,
      },
      'VisionDecomposer: backlog auto-decomposed',
    )

    return {
      vision_document_id: visionDocumentId,
      vision_version_id: visionVersionId,
      version_number: versionNumber,
      epic_count: epicIds.length,
      story_count: storyIds.length,
      epic_ids: epicIds,
      story_ids: storyIds,
    }
  }
}
