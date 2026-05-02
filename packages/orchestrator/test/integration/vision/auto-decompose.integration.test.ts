/**
 * Integration tests for VisionAutoDecomposeSubscriber + VisionDecomposer.
 *
 * Requires real Postgres (DATABASE_URL env var or default localhost).
 * Runs against the full migrated schema — migration 0018 must be applied.
 *
 * Flow tested:
 *   1. Insert a vision_documents row and a locked vision_versions row.
 *   2. Emit a VisionLocked event via EventStore.append.
 *   3. registerVisionAutoDecompose subscriber picks up the event.
 *   4. Within 2 seconds: epics + stories exist in DB with correct linkage.
 *   5. All rows have auto_generated_metadata.source = 'vision_lock'.
 *   6. BacklogAutoDecomposed event exists in the events log.
 *   7. Idempotency: emit VisionLocked again for the same version → no duplicate rows.
 *
 * Uses real EventStore subscribe (LISTEN-based). No mocks for DB/EventStore.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { uuidv7 } from 'uuidv7'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq, and } from 'drizzle-orm'
import { PostgresEventStore } from '../../../src/events/store.js'
import { visionDocuments, visionVersions } from '../../../src/db/schema/vision.js'
import { epics, stories, storyAcceptanceCriteria } from '../../../src/db/schema/backlog.js'
import { registerVisionAutoDecompose } from '../../../src/vision/auto-decompose-subscriber.js'
import { VisionDecomposer } from '../../../src/vision/auto-decompose.js'

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://orbital:orbital@localhost:5432/orbital'

let sqlPool: postgres.Sql
let eventStore: PostgresEventStore
let db: ReturnType<typeof drizzle>
let stopSubscriber: () => void

const INSTALL_ID = uuidv7()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal locked vision content that reliably matches 2 templates
 * (billing + auth) so we get exactly 3 epics (2 matched + 1 generic pad).
 * Deliberately avoids triggering >3 templates so the cap assertion holds.
 */
function makeLockedContent(title: string): Record<string, unknown> {
  return {
    schema_version: 1,
    title,
    summary: 'A recurring billing platform with subscription management and sign-in.',
    goals: [
      { id: 'g1', text: 'Users can subscribe to a plan and manage their billing.', rank: 0 },
    ],
    non_goals: [{ id: 'ng1', text: 'No mobile native app in v1.' }],
    target_users: [
      {
        id: 'u1',
        segment: 'paying customers',
        description: 'Users who pay monthly for the service.',
        primary: true,
      },
    ],
    acceptance_criteria: [{ id: 'ac1', text: 'Users can complete checkout without errors.', rank: 0 }],
    glossary: [],
    edge_cases: [],
    open_questions: [],
    assumptions_log: [],
    metadata: {
      pm_persona_id: 'pm',
      model_used: 'stub',
      intake_started_at: new Date().toISOString(),
      intake_token_total: 0,
    },
  }
}

/**
 * Wait up to `maxMs` for `predicate()` to return true, polling every `intervalMs`.
 */
async function waitFor(
  predicate: () => Promise<boolean>,
  maxMs = 4000,
  intervalMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return false
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  sqlPool = postgres(DATABASE_URL, {
    max: 10,
    idle_timeout: 15,
    onnotice: () => {},
  })
  db = drizzle(sqlPool)
  eventStore = new PostgresEventStore(db, sqlPool)

  // Register the subscriber under test.
  stopSubscriber = registerVisionAutoDecompose({ eventStore, db })
})

afterAll(async () => {
  stopSubscriber()
  await eventStore.stopNotifyClient()
  await sqlPool.end({ timeout: 5 })
})

// ---------------------------------------------------------------------------
// Test helpers for building DB state
// ---------------------------------------------------------------------------

async function insertLockedVision(
  visionDocumentId: string,
  visionVersionId: string,
  versionNumber: number,
  content: Record<string, unknown>,
): Promise<void> {
  // Insert the header row first.
  // Use the full visionDocumentId in the title to guarantee uniqueness under
  // the (install_id, title) unique constraint across all test runs.
  await db.insert(visionDocuments).values({
    visionDocumentId,
    installId: INSTALL_ID,
    title: `AutoDecompose Test ${visionDocumentId}`,
    lifecycleState: 'locked',
    currentVersionId: visionVersionId,
    currentVersionNumber: versionNumber,
    mondayItemId: null,
    createdBy: { type: 'user', user_id: 'test-user' },
    lastEventId: uuidv7(),
  })

  // Insert the locked version row.
  await db.insert(visionVersions).values({
    visionVersionId,
    visionDocumentId,
    versionNumber,
    content,
    contentHash: 'hash-' + visionVersionId,
    changelog: 'Initial lock',
    isLocked: 1,
    lockedAt: new Date(),
    lockedBy: { type: 'user', user_id: 'test-user' },
    lockEventId: uuidv7(),
    draftedBy: { type: 'persona', persona_id: 'pm' },
  })
}

// ---------------------------------------------------------------------------
// Integration test: subscriber fires on VisionLocked → epics+stories appear
// ---------------------------------------------------------------------------

describe('VisionAutoDecomposeSubscriber — full lock → decompose flow', () => {
  it('creates 3-5 epics and 2-3 stories per epic within 4s of VisionLocked', async () => {
    const docId = uuidv7()
    const verId = uuidv7()
    const versionNumber = 1
    const content = makeLockedContent(`Billing Platform ${docId.slice(0, 8)}`)

    // --- Step 1: write DB rows representing a just-locked vision ---
    await insertLockedVision(docId, verId, versionNumber, content)

    // --- Step 2: emit VisionLocked via EventStore.append ---
    await eventStore.append({
      aggregate_id: docId,
      aggregate_type: 'vision_document',
      event_type: 'VisionLocked',
      payload: {
        vision_document_id: docId,
        vision_version_id: verId,
        version_number: versionNumber,
        content_hash: 'hash-' + verId,
        locked_by: { type: 'user', user_id: 'test-user' },
        changelog: 'Initial lock',
        attestation: { no_edge_cases: false, confirmation_token: '[consumed]' },
      },
      actor: { type: 'user', user_id: 'test-user', install_id: INSTALL_ID },
      trace_id: docId,
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    })

    // --- Step 3: wait up to 4s for epics to appear, then settle ---
    const epicsAppeared = await waitFor(async () => {
      const rows = await db
        .select()
        .from(epics)
        .where(eq(epics.visionVersionId, verId))
      return rows.length >= 3
    }, 4000)

    expect(epicsAppeared).toBe(true)

    // Give any concurrent async operations a moment to land so the epic count
    // is stable before we assert ≤ 5. 300ms is enough; Postgres round-trip is ~5ms.
    await new Promise((r) => setTimeout(r, 300))

    // --- Step 4: verify epics ---
    const epicRows = await db
      .select()
      .from(epics)
      .where(eq(epics.visionVersionId, verId))

    expect(epicRows.length).toBeGreaterThanOrEqual(3)
    expect(epicRows.length).toBeLessThanOrEqual(5)

    for (const epic of epicRows) {
      expect(epic.title).toBeTruthy()
      expect(epic.rationale).toBeTruthy()
      expect(epic.status).toBe('draft')

      // Verify auto_generated_metadata
      const meta = epic.autoGeneratedMetadata as Record<string, unknown> | null
      expect(meta).not.toBeNull()
      expect(meta?.['source']).toBe('vision_lock')
      expect(meta?.['vision_document_id']).toBe(docId)
      expect(meta?.['version']).toBe(versionNumber)
    }

    // --- Step 5: verify stories ---
    for (const epic of epicRows) {
      const storyRows = await db
        .select()
        .from(stories)
        .where(eq(stories.epicId, epic.epicId))

      expect(storyRows.length).toBeGreaterThanOrEqual(2)
      expect(storyRows.length).toBeLessThanOrEqual(3)

      for (const story of storyRows) {
        expect(story.title).toBeTruthy()
        expect(story.description).toBeTruthy()
        expect(story.status).toBe('backlog')
        expect([1, 2, 3, 5]).toContain(story.storyPoints)

        // Verify auto_generated_metadata
        const meta = story.autoGeneratedMetadata as Record<string, unknown> | null
        expect(meta).not.toBeNull()
        expect(meta?.['source']).toBe('vision_lock')
        expect(meta?.['vision_document_id']).toBe(docId)

        // Verify ACs exist
        const acRows = await db
          .select()
          .from(storyAcceptanceCriteria)
          .where(eq(storyAcceptanceCriteria.storyId, story.storyId))

        expect(acRows.length).toBeGreaterThanOrEqual(2)
        // Each AC has ordinal starting at 1
        const ordinals = acRows.map((a) => a.ordinal).sort((a, b) => a - b)
        expect(ordinals[0]).toBe(1)
      }
    }

    // --- Step 6: verify BacklogAutoDecomposed event ---
    const summaryEvents = await eventStore.query({
      aggregate_id: docId,
      aggregate_type: 'vision_document',
      event_type: 'BacklogAutoDecomposed',
    })
    expect(summaryEvents.items.length).toBeGreaterThanOrEqual(1)

    const summaryPayload = summaryEvents.items[0]!.payload as Record<string, unknown>
    expect(summaryPayload['vision_document_id']).toBe(docId)
    expect(typeof summaryPayload['epic_count']).toBe('number')
    expect(typeof summaryPayload['story_count']).toBe('number')
    expect((summaryPayload['epic_count'] as number)).toBe(epicRows.length)
  }, 10_000)

  // -------------------------------------------------------------------------
  // Idempotency: emitting VisionLocked twice for the same version is a no-op
  // -------------------------------------------------------------------------

  it('is idempotent: re-emitting VisionLocked for the same version creates no extra epics', async () => {
    const docId = uuidv7()
    const verId = uuidv7()
    const versionNumber = 1
    const content = makeLockedContent(`Idempotent Test ${docId.slice(0, 8)}`)

    await insertLockedVision(docId, verId, versionNumber, content)

    const lockPayload = {
      vision_document_id: docId,
      vision_version_id: verId,
      version_number: versionNumber,
      content_hash: 'hash-' + verId,
      locked_by: { type: 'user', user_id: 'test-user' },
      changelog: 'Initial lock',
      attestation: { no_edge_cases: false, confirmation_token: '[consumed]' },
    }
    const actor = { type: 'user' as const, user_id: 'test-user', install_id: INSTALL_ID }
    const now = new Date().toISOString()

    // First lock
    await eventStore.append({
      aggregate_id: docId,
      aggregate_type: 'vision_document',
      event_type: 'VisionLocked',
      payload: lockPayload,
      actor,
      trace_id: docId,
      occurred_at: now,
      schema_version: 1,
    })

    // Wait for first decomposition
    await waitFor(async () => {
      const rows = await db.select().from(epics).where(eq(epics.visionVersionId, verId))
      return rows.length >= 3
    }, 4000)

    const firstCount = (
      await db.select().from(epics).where(eq(epics.visionVersionId, verId))
    ).length

    // Second lock (same version number)
    await eventStore.append({
      aggregate_id: docId,
      aggregate_type: 'vision_document',
      event_type: 'VisionLocked',
      payload: lockPayload,
      actor,
      trace_id: docId,
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    })

    // Wait a bit to ensure the subscriber has a chance to run (it should skip).
    await new Promise((r) => setTimeout(r, 500))

    const secondCount = (
      await db.select().from(epics).where(eq(epics.visionVersionId, verId))
    ).length

    // Count must not have grown — second lock is a no-op.
    expect(secondCount).toBe(firstCount)
  }, 12_000)

  // -------------------------------------------------------------------------
  // Direct decomposer: VisionDecomposer.decompose() works end-to-end
  // -------------------------------------------------------------------------

  it('VisionDecomposer.decompose() inserts rows and returns counts', async () => {
    const docId = uuidv7()
    const verId = uuidv7()
    const content = makeLockedContent(`Direct Decompose Test ${docId.slice(0, 8)}`)

    await insertLockedVision(docId, verId, 1, content)

    const decomposer = new VisionDecomposer(db, eventStore)
    const result = await decomposer.decompose(docId)

    expect(result.vision_document_id).toBe(docId)
    expect(result.vision_version_id).toBe(verId)
    expect(result.version_number).toBe(1)
    expect(result.epic_count).toBeGreaterThanOrEqual(3)
    expect(result.story_count).toBeGreaterThanOrEqual(result.epic_count * 2)
    expect(result.epic_ids).toHaveLength(result.epic_count)
    expect(result.story_ids).toHaveLength(result.story_count)

    // Verify rows in DB
    for (const epicId of result.epic_ids) {
      const rows = await db.select().from(epics).where(eq(epics.epicId, epicId))
      expect(rows[0]).toBeTruthy()
    }
    for (const storyId of result.story_ids) {
      const rows = await db.select().from(stories).where(eq(stories.storyId, storyId))
      expect(rows[0]).toBeTruthy()
    }
  }, 10_000)
})
