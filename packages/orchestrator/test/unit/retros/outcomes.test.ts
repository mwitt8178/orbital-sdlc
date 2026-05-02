/**
 * Unit tests for OutcomeTracker.
 *
 * Real Postgres. The match logic + finalize path emit OutcomeRecorded.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { uuidv7 } from 'uuidv7'
import { eq, inArray } from 'drizzle-orm'

import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { DefaultOutcomeTracker } from '../../../src/retros/outcomes.js'
import {
  retroReports,
  retroProposals,
  retroProposalLayers,
  retroOutcomes,
  systemVersions,
} from '../../../src/db/schema/retros.js'
import { events } from '../../../src/db/schema/events.js'
import { sprints } from '../../../src/db/schema/backlog.js'

const ownedSprints: string[] = []
const ownedReports: string[] = []
const ownedProposals: string[] = []
const ownedVersions: string[] = []
const ownedOutcomes: string[] = []

beforeAll(async () => {
  await sql`SELECT 1`
})

afterAll(async () => {
  if (ownedOutcomes.length > 0) {
    await db.delete(retroOutcomes).where(inArray(retroOutcomes.retroOutcomeId, ownedOutcomes))
  }
  if (ownedProposals.length > 0) {
    await db
      .delete(retroProposalLayers)
      .where(inArray(retroProposalLayers.retroProposalId, ownedProposals))
    await db.delete(retroProposals).where(inArray(retroProposals.retroProposalId, ownedProposals))
  }
  if (ownedReports.length > 0) {
    await db.delete(retroReports).where(inArray(retroReports.retroReportId, ownedReports))
  }
  if (ownedVersions.length > 0) {
    await db.delete(systemVersions).where(inArray(systemVersions.systemVersionId, ownedVersions))
  }
  if (ownedSprints.length > 0) {
    await db.delete(sprints).where(inArray(sprints.sprintId, ownedSprints))
  }
  await closeDb().catch(() => undefined)
})

async function seed(): Promise<{
  sprintId: string
  retroReportId: string
  retroProposalId: string
  systemVersionId: string
  retroOutcomeId: string
}> {
  const sprintId = uuidv7()
  ownedSprints.push(sprintId)
  await db.insert(sprints).values({
    sprintId,
    name: 'outcome-test',
    sequence: 1,
    status: 'completed',
    storyPointCapacity: 10,
    budgetUsdCents: 10000,
    startedAt: new Date(Date.now() - 60 * 60 * 1000),
    completedAt: new Date(),
  })

  const retroReportId = uuidv7()
  ownedReports.push(retroReportId)
  await db.insert(retroReports).values({
    retroReportId,
    sprintId,
    analysisRunSeq: 1,
    status: 'ready',
    createdEventId: uuidv7(),
  })

  const retroProposalId = uuidv7()
  ownedProposals.push(retroProposalId)
  await db.insert(retroProposals).values({
    retroProposalId,
    retroReportId,
    proposalCode: `PRP-${retroProposalId}`,
    title: 'Reduce escalation rate',
    hypothesis:
      'tighter blocker triage rules reduce escalation rate by ~10% per sprint over the next two sprints.',
    expectedImpactMetric: 'escalation_rate',
    expectedImpactDirection: 'decrease',
    expectedImpactPctPoints: -1000,
    rollbackPath: 'revert system_version_id <id>',
    confidenceScore: 75,
    status: 'merged',
    createdEventId: uuidv7(),
  })

  await db.insert(retroProposalLayers).values({
    retroProposalLayerId: uuidv7(),
    retroProposalId,
    layer: 'hook',
    targetPath: 'hooks/pre-commit/blocker-triage.ts',
    changeType: 'create',
    isDominant: true,
  })

  const systemVersionId = uuidv7()
  ownedVersions.push(systemVersionId)
  await db.insert(systemVersions).values({
    systemVersionId,
    versionNumber: `org-v0.0.1-${systemVersionId}`,
    gitTag: `org-v0.0.1-${systemVersionId}`,
    gitSha: '0'.repeat(40),
    shippedBy: 'test-user',
    isRollback: false,
    retroReportId,
    createdEventId: uuidv7(),
  })

  const retroOutcomeId = uuidv7()
  ownedOutcomes.push(retroOutcomeId)
  await db.insert(retroOutcomes).values({
    retroOutcomeId,
    retroProposalId,
    systemVersionId,
    metricKey: 'escalation_rate',
    expectedDirection: 'decrease',
    expectedPctPoints: -1000,
    windowSprintCount: 2,
    toleranceBand: 500,
    baselineValue: { rate_bp: 3000, escalated_count: 6, raised_count: 20 },
  })

  return { sprintId, retroReportId, retroProposalId, systemVersionId, retroOutcomeId }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OutcomeTracker.finalize', () => {
  it('marks expectations as matched when sign and tolerance both pass', async () => {
    const eventStore = createEventStore(db, sql)
    const tracker = new DefaultOutcomeTracker(db, eventStore)
    const { retroOutcomeId } = await seed()

    // Expected -1000 (down 10%); actual -800 (down 8%); within +/- 500.
    const result = await tracker.finalize(retroOutcomeId, -800, [uuidv7()])
    expect(result.matchedExpectation).toBe(true)

    const rows = await db
      .select()
      .from(retroOutcomes)
      .where(eq(retroOutcomes.retroOutcomeId, retroOutcomeId))
    expect(rows[0]!.matchedExpectation).toBe(true)
    expect(rows[0]!.actualPctPoints).toBe(-800)

    const evRows = await db
      .select()
      .from(events)
      .where(eq(events.aggregateId, retroOutcomeId))
    expect(evRows.some((e) => e.eventType === 'OutcomeRecorded')).toBe(true)
  })

  it('marks expectations as unmatched when the sign is wrong', async () => {
    const eventStore = createEventStore(db, sql)
    const tracker = new DefaultOutcomeTracker(db, eventStore)
    const { retroOutcomeId } = await seed()

    const result = await tracker.finalize(retroOutcomeId, +500, [uuidv7()])
    expect(result.matchedExpectation).toBe(false)
  })

  it('marks expectations as unmatched when magnitude is out-of-band', async () => {
    const eventStore = createEventStore(db, sql)
    const tracker = new DefaultOutcomeTracker(db, eventStore)
    const { retroOutcomeId } = await seed()

    // Expected -1000, actual -200 — sign matches but |delta|=800 > tolerance 500.
    const result = await tracker.finalize(retroOutcomeId, -200, [uuidv7()])
    expect(result.matchedExpectation).toBe(false)
  })
})

describe('OutcomeTracker.onSprintCompleted', () => {
  it('finalizes open outcomes on a SprintCompleted', async () => {
    const eventStore = createEventStore(db, sql)
    const tracker = new DefaultOutcomeTracker(db, eventStore)
    const { sprintId, retroOutcomeId } = await seed()

    const result = await tracker.onSprintCompleted(sprintId)
    expect(result.finalizedOutcomes).toContain(retroOutcomeId)

    const rows = await db
      .select()
      .from(retroOutcomes)
      .where(eq(retroOutcomes.retroOutcomeId, retroOutcomeId))
    expect(rows[0]!.matchedExpectation).not.toBeNull()
  })
})
