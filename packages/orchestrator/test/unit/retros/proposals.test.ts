/**
 * Unit tests for ProposalService.
 *
 * Real Postgres + real AgentOrgRepo against a tmp dir per test.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { uuidv7 } from 'uuidv7'
import { eq, inArray } from 'drizzle-orm'

import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { createAgentOrgRepo, AgentOrgRepo } from '../../../src/retros/agent-org.js'
import { createProposalService } from '../../../src/retros/proposals.js'
import {
  retroReports,
  retroProposals,
  retroProposalLayers,
  retroOutcomes,
  systemVersions,
  systemVersionDiffs,
} from '../../../src/db/schema/retros.js'
import { events } from '../../../src/db/schema/events.js'

const ownedReports: string[] = []
const ownedProposals: string[] = []
const ownedVersions: string[] = []
const ownedAggregates: string[] = []

let tmpRoot: string
let agentOrg: AgentOrgRepo

beforeAll(async () => {
  await sql`SELECT 1`
})

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), `orbital-proposals-${process.pid}-`))
  agentOrg = createAgentOrgRepo({ path: path.join(tmpRoot, 'agent-org') })
  await agentOrg.init()
})

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined)
})

afterAll(async () => {
  // Clean up: outcomes -> diffs -> versions -> proposal_layers -> proposals -> reports.
  if (ownedProposals.length > 0) {
    await db.delete(retroOutcomes).where(inArray(retroOutcomes.retroProposalId, ownedProposals))
    await db.delete(systemVersionDiffs).where(inArray(systemVersionDiffs.retroProposalId, ownedProposals))
    await db
      .delete(retroProposalLayers)
      .where(inArray(retroProposalLayers.retroProposalId, ownedProposals))
  }
  if (ownedVersions.length > 0) {
    await db.delete(systemVersionDiffs).where(inArray(systemVersionDiffs.systemVersionId, ownedVersions))
    await db.delete(systemVersions).where(inArray(systemVersions.systemVersionId, ownedVersions))
  }
  if (ownedProposals.length > 0) {
    await db.delete(retroProposals).where(inArray(retroProposals.retroProposalId, ownedProposals))
  }
  if (ownedReports.length > 0) {
    await db.delete(retroReports).where(inArray(retroReports.retroReportId, ownedReports))
  }
  // Best-effort: events table is append-only; let trigger reject deletes.
  await closeDb().catch(() => undefined)
})

// Helper: insert a real retro report + proposal directly via DB.
async function seedReportAndProposal(): Promise<{
  retroReportId: string
  retroProposalId: string
}> {
  const sprintId = uuidv7()
  const retroReportId = uuidv7()
  const reportEventId = uuidv7()
  ownedReports.push(retroReportId)
  await db.insert(retroReports).values({
    retroReportId,
    sprintId,
    analysisRunSeq: 1,
    status: 'analyzing',
    createdEventId: reportEventId,
  })

  const retroProposalId = uuidv7()
  ownedProposals.push(retroProposalId)
  ownedAggregates.push(retroProposalId)
  await db.insert(retroProposals).values({
    retroProposalId,
    retroReportId,
    proposalCode: `PRP-${retroProposalId}`,
    title: 'Improve sr-dev token efficiency',
    hypothesis:
      'sr-dev exhausts token budget on large refactors; tighter file-read scoping should reduce by ~10%.',
    expectedImpactMetric: 'cycle_time_p50',
    expectedImpactDirection: 'decrease',
    expectedImpactPctPoints: -1000,
    rollbackPath: 'revert system_version_id <id> to restore prior persona file',
    evidenceRefs: [],
    confidenceScore: 75,
    proposedValue:
      '# senior-developer\n\nUpdated definition with tighter file-read scoping.\n',
    status: 'pending',
    createdEventId: uuidv7(),
  })

  // Layer row (dominant=true) targeting personas/sr-dev.md (matches glob).
  await db.insert(retroProposalLayers).values({
    retroProposalLayerId: uuidv7(),
    retroProposalId,
    layer: 'persona',
    targetPath: 'personas/sr-dev.md',
    changeType: 'modify',
    isDominant: true,
  })

  return { retroReportId, retroProposalId }
}

describe('ProposalService.approve', () => {
  it('produces a real git commit, system_versions row, and emits both events', async () => {
    const eventStore = createEventStore(db, sql)
    const installId = uuidv7()
    const proposalService = createProposalService(db, eventStore, agentOrg, installId)
    const { retroProposalId } = await seedReportAndProposal()
    const userId = uuidv7()

    const result = await proposalService.approve(
      retroProposalId,
      'Looks good — tightening scope is uncontroversial',
      userId,
    )
    expect(result.gitSha).toMatch(/^[0-9a-f]{40}$/)
    expect(result.versionNumber).toMatch(/^org-v/)
    ownedVersions.push(result.mergedSystemVersionId)

    // The agent-org commit is real.
    const log = await agentOrg.log(5)
    expect(log[0]?.hash).toEqual(result.gitSha)
    expect(log[0]?.message).toContain('retro(persona):')
    expect(log[0]?.message).toContain('Improve sr-dev token efficiency')

    // The system_versions row exists.
    const vRows = await db
      .select()
      .from(systemVersions)
      .where(eq(systemVersions.systemVersionId, result.mergedSystemVersionId))
    expect(vRows.length).toBe(1)
    expect(vRows[0]!.gitSha).toEqual(result.gitSha)
    expect(vRows[0]!.shippedBy).toEqual(userId)
    expect(vRows[0]!.isRollback).toBe(false)

    // The proposal transitioned to merged.
    const pRows = await db
      .select()
      .from(retroProposals)
      .where(eq(retroProposals.retroProposalId, retroProposalId))
    expect(pRows[0]!.status).toEqual('merged')
    expect(pRows[0]!.mergedSystemVersionId).toEqual(result.mergedSystemVersionId)

    // RetroApproved + SystemVersionShipped events were emitted.
    const evRows = await db
      .select()
      .from(events)
      .where(inArray(events.aggregateId, [retroProposalId, result.mergedSystemVersionId]))
    const types = evRows.map((e) => e.eventType)
    expect(types).toContain('RetroApproved')
    expect(types).toContain('SystemVersionShipped')

    // SystemVersionShipped's parent_event_id points at the RetroApproved event.
    const approved = evRows.find((e) => e.eventType === 'RetroApproved')!
    const shipped = evRows.find((e) => e.eventType === 'SystemVersionShipped')!
    expect(shipped.parentEventId).toEqual(approved.eventId)

    // An outcome window was opened.
    const outRows = await db
      .select()
      .from(retroOutcomes)
      .where(eq(retroOutcomes.retroProposalId, retroProposalId))
    expect(outRows.length).toBe(1)
    expect(outRows[0]!.matchedExpectation).toBeNull()
    expect(outRows[0]!.expectedPctPoints).toEqual(-1000)
  })

  it('rejects approve on a proposal already in merged state', async () => {
    const eventStore = createEventStore(db, sql)
    const installId = uuidv7()
    const proposalService = createProposalService(db, eventStore, agentOrg, installId)
    const { retroProposalId } = await seedReportAndProposal()
    const userId = uuidv7()

    const result = await proposalService.approve(retroProposalId, 'first', userId)
    ownedVersions.push(result.mergedSystemVersionId)

    // Second approve should throw CONFLICT_INVALID_STATE_TRANSITION.
    await expect(proposalService.approve(retroProposalId, 'again', userId)).rejects.toMatchObject({
      code: 'CONFLICT_INVALID_STATE_TRANSITION',
    })
  })

  it('rejects approve with empty rationale', async () => {
    const eventStore = createEventStore(db, sql)
    const installId = uuidv7()
    const proposalService = createProposalService(db, eventStore, agentOrg, installId)
    const { retroProposalId } = await seedReportAndProposal()

    await expect(proposalService.approve(retroProposalId, '   ', uuidv7())).rejects.toMatchObject({
      code: 'VALIDATION_REQUIRED_FIELD_MISSING',
    })
  })
})

describe('ProposalService.reject', () => {
  it('transitions pending -> rejected and emits RetroRejected', async () => {
    const eventStore = createEventStore(db, sql)
    const installId = uuidv7()
    const proposalService = createProposalService(db, eventStore, agentOrg, installId)
    const { retroProposalId } = await seedReportAndProposal()

    await proposalService.reject(retroProposalId, 'not the right scope right now', uuidv7())
    const pRows = await db
      .select()
      .from(retroProposals)
      .where(eq(retroProposals.retroProposalId, retroProposalId))
    expect(pRows[0]!.status).toEqual('rejected')

    const evRows = await db
      .select()
      .from(events)
      .where(eq(events.aggregateId, retroProposalId))
    expect(evRows.some((e) => e.eventType === 'RetroRejected')).toBe(true)
  })
})

describe('ProposalService.defer', () => {
  it('transitions pending -> deferred and emits RetroDeferred', async () => {
    const eventStore = createEventStore(db, sql)
    const installId = uuidv7()
    const proposalService = createProposalService(db, eventStore, agentOrg, installId)
    const { retroProposalId } = await seedReportAndProposal()

    await proposalService.defer(retroProposalId, 'next sprint', uuidv7())
    const pRows = await db
      .select()
      .from(retroProposals)
      .where(eq(retroProposals.retroProposalId, retroProposalId))
    expect(pRows[0]!.status).toEqual('deferred')

    const evRows = await db
      .select()
      .from(events)
      .where(eq(events.aggregateId, retroProposalId))
    expect(evRows.some((e) => e.eventType === 'RetroDeferred')).toBe(true)
  })
})

describe('ProposalService.rollback', () => {
  it('reverts the agent-org repo and creates a new version row with is_rollback=true', async () => {
    const eventStore = createEventStore(db, sql)
    const installId = uuidv7()
    const proposalService = createProposalService(db, eventStore, agentOrg, installId)
    const { retroProposalId } = await seedReportAndProposal()
    const userId = uuidv7()

    const approved = await proposalService.approve(retroProposalId, 'approve and roll back', userId)
    ownedVersions.push(approved.mergedSystemVersionId)

    const rollback = await proposalService.rollback(
      approved.mergedSystemVersionId,
      'reverting due to operational concern',
      userId,
    )
    ownedVersions.push(rollback.newSystemVersionId)
    expect(rollback.gitSha).toMatch(/^[0-9a-f]{40}$/)
    expect(rollback.gitSha).not.toEqual(approved.gitSha)

    const newRows = await db
      .select()
      .from(systemVersions)
      .where(eq(systemVersions.systemVersionId, rollback.newSystemVersionId))
    expect(newRows[0]!.isRollback).toBe(true)
    expect(newRows[0]!.rolledBackVersionId).toEqual(approved.mergedSystemVersionId)

    // Originating proposal becomes rolled_back.
    const pRows = await db
      .select()
      .from(retroProposals)
      .where(eq(retroProposals.retroProposalId, retroProposalId))
    expect(pRows[0]!.status).toEqual('rolled_back')

    // RetroRolledBack + SystemVersionShipped events emitted.
    const evRows = await db
      .select()
      .from(events)
      .where(
        inArray(events.aggregateId, [
          approved.mergedSystemVersionId,
          rollback.newSystemVersionId,
        ]),
      )
    const types = evRows.map((e) => e.eventType)
    expect(types).toContain('RetroRolledBack')
    expect(types).toContain('SystemVersionShipped')
  })
})
