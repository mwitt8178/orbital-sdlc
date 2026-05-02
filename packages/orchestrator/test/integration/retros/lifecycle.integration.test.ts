/**
 * Phase 5B - Retro lifecycle integration test.
 *
 * End-to-end:
 *   1. Insert a real sprint + sprint_commitment.
 *   2. Append a SprintCompleted event via EventStore.
 *   3. Synchronously call RetroService.onSprintCompleted - exercises the
 *      capability issuance + report-row creation + RetroAnalysisStarted emit.
 *   4. Synthesize a proposal via the test helper - exercises Zod validation
 *      + DB persistence + RetroProposed emit.
 *   5. Approve the proposal - exercises the real Git commit, system_versions
 *      insert, RetroApproved + SystemVersionShipped emit.
 *   6. Verify: agent-org git log contains the commit; SystemVersionShipped
 *      event in DB carries the same git_sha; outcome window is open.
 *   7. Roll back - exercises the rollback Git operation + new version row.
 *
 * Real Postgres. Real Git. Real EventStore. Real CapabilityAuthority.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { uuidv7 } from 'uuidv7'
import { eq, inArray } from 'drizzle-orm'

import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { CapabilityAuthority } from '../../../src/capabilities/authority.js'
import { KeyManager } from '../../../src/capabilities/keys.js'
import { resetKeychainCache } from '../../../src/capabilities/keychain.js'
import { resetPolicyCache } from '../../../src/capabilities/policy.js'
import { DefaultPersonaLoader } from '../../../src/personas/loader.js'
import { DefaultRetroService } from '../../../src/retros/service.js'
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
import { sprints, sprintCommitments } from '../../../src/db/schema/backlog.js'
import type { Proposal } from '../../../src/retros/types.js'

const ownedSprints: string[] = []
const ownedReports: string[] = []
const ownedProposals: string[] = []
const ownedVersions: string[] = []
const ownedOutcomes: string[] = []
const ownedCommitments: string[] = []

let tmpRoot: string
let agentOrg: AgentOrgRepo
let originalOrbitalHome: string | undefined
let originalKeychainFlag: string | undefined

const TEST_SHIM_FILE_PATTERN = (pid: number) =>
  path.join(os.homedir(), `.orbital-test-keychain-${pid}-retro.json`)

beforeAll(async () => {
  await sql`SELECT 1`
})

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), `orbital-retro-int-${process.pid}-`))
  // Override ORBITAL_HOME so any code that resolves it goes to the tmp dir.
  originalOrbitalHome = process.env['ORBITAL_HOME']
  process.env['ORBITAL_HOME'] = tmpRoot

  // Use the file-based keychain shim for tests (no system keychain).
  originalKeychainFlag = process.env['ORBITAL_TEST_KEYCHAIN']
  process.env['ORBITAL_TEST_KEYCHAIN'] = '1'
  process.env['ORBITAL_TEST_KEYCHAIN_PATH'] = TEST_SHIM_FILE_PATTERN(process.pid)
  resetKeychainCache()
  resetPolicyCache()
  await fs.unlink(TEST_SHIM_FILE_PATTERN(process.pid)).catch(() => undefined)

  // Initialize the agent-org repo at tmpRoot/agent-org.
  agentOrg = createAgentOrgRepo({ path: path.join(tmpRoot, 'agent-org') })
  await agentOrg.init()
})

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined)
  await fs.unlink(TEST_SHIM_FILE_PATTERN(process.pid)).catch(() => undefined)
  if (originalOrbitalHome === undefined) {
    delete process.env['ORBITAL_HOME']
  } else {
    process.env['ORBITAL_HOME'] = originalOrbitalHome
  }
  if (originalKeychainFlag === undefined) {
    delete process.env['ORBITAL_TEST_KEYCHAIN']
  } else {
    process.env['ORBITAL_TEST_KEYCHAIN'] = originalKeychainFlag
  }
})

afterAll(async () => {
  if (ownedOutcomes.length > 0) {
    await db.delete(retroOutcomes).where(inArray(retroOutcomes.retroOutcomeId, ownedOutcomes))
  }
  if (ownedVersions.length > 0) {
    await db
      .delete(systemVersionDiffs)
      .where(inArray(systemVersionDiffs.systemVersionId, ownedVersions))
    await db.delete(systemVersions).where(inArray(systemVersions.systemVersionId, ownedVersions))
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
  if (ownedCommitments.length > 0) {
    await db
      .delete(sprintCommitments)
      .where(inArray(sprintCommitments.commitmentId, ownedCommitments))
  }
  if (ownedSprints.length > 0) {
    await db.delete(sprints).where(inArray(sprints.sprintId, ownedSprints))
  }
  await closeDb().catch(() => undefined)
})

describe('Phase 5B - Retro lifecycle: sprint complete -> retro -> approve -> commit', () => {
  it('runs the full pipeline end-to-end', async () => {
    const eventStore = createEventStore(db, sql)
    const installId = uuidv7()
    const keyManager = new KeyManager(installId, eventStore)
    const authority = new CapabilityAuthority(eventStore, keyManager)
    const personaLoader = new DefaultPersonaLoader(db, eventStore)
    await personaLoader.load()

    const retroService = new DefaultRetroService(
      db,
      eventStore,
      authority,
      personaLoader,
      installId,
    )
    const proposalService = createProposalService(db, eventStore, agentOrg, installId)

    // 1. Create a real sprint + commitment.
    const sprintId = uuidv7()
    ownedSprints.push(sprintId)
    const sprintStart = new Date(Date.now() - 60 * 60 * 1000)
    const sprintEnd = new Date()
    await db.insert(sprints).values({
      sprintId,
      name: 'phase-5b-int-sprint',
      sequence: 1,
      status: 'completed',
      storyPointCapacity: 10,
      budgetUsdCents: 10000,
      startedAt: sprintStart,
      completedAt: sprintEnd,
    })
    const commitmentId = uuidv7()
    ownedCommitments.push(commitmentId)
    await db.insert(sprintCommitments).values({
      commitmentId,
      sprintId,
      selectedStoryIds: [],
      capacityUsedPoints: 5,
    })

    // 2. Append a SprintCompleted event.
    await eventStore.append({
      aggregate_id: sprintId,
      aggregate_type: 'sprint',
      event_type: 'SprintCompleted',
      payload: {
        sprint_id: sprintId,
        completed_at: sprintEnd.toISOString(),
        story_outcomes: [],
        capacity_used_points: 5,
        budget_used_usd_cents: 0,
      },
      actor: { type: 'system', component: 'orchestrator' },
      trace_id: uuidv7(),
      occurred_at: sprintEnd.toISOString(),
      schema_version: 1,
    })

    // 3. Run the retro pipeline synchronously.
    const analyzeResult = await retroService.onSprintCompleted(sprintId)
    ownedReports.push(analyzeResult.retroReportId)
    expect(analyzeResult.retroReportId).toMatch(/^[0-9a-f-]+$/)
    expect(analyzeResult.status).toEqual('analyzing')

    // The retro_reports row exists and has status='analyzing'.
    const reportRows = await db
      .select()
      .from(retroReports)
      .where(eq(retroReports.retroReportId, analyzeResult.retroReportId))
    expect(reportRows[0]!.status).toEqual('analyzing')
    expect(reportRows[0]!.sprintId).toEqual(sprintId)

    // RetroAnalysisStarted was emitted via EventStore (not direct insert).
    const startEvents = await db
      .select()
      .from(events)
      .where(eq(events.aggregateId, analyzeResult.retroReportId))
    expect(startEvents.some((e) => e.eventType === 'RetroAnalysisStarted')).toBe(true)

    // 4. Synthesize a proposal.
    const proposal: Proposal = {
      proposal_code: `PRP-${uuidv7()}`,
      title: 'Tighten sr-dev file scope',
      hypothesis:
        'sr-dev runs over token budget on large refactors; tighter file-read scoping should reduce by ~10% per sprint over the next two sprints.',
      expected_impact: { metric_key: 'cycle_time_p50', direction: 'decrease', pct_points: -1000 },
      rollback_path: 'revert system_version_id <id> to restore prior persona file',
      layers: [
        {
          layer: 'persona',
          target_path: 'personas/sr-dev.md',
          change_type: 'modify',
          is_dominant: true,
        },
      ],
      evidence_refs: [],
      confidence_score: 75,
      proposed_value:
        '# Senior Developer (Updated)\n\nTighter file-read scoping for refactor tasks.\n',
      is_global: true,
    }
    const synthResult = await retroService.synthesizeProposalForTest(
      analyzeResult.retroReportId,
      proposal,
    )
    ownedProposals.push(synthResult.retroProposalId)

    // 5. Finalize report.
    await retroService.finalizeReportForTest(analyzeResult.retroReportId)
    const reportAfter = await db
      .select()
      .from(retroReports)
      .where(eq(retroReports.retroReportId, analyzeResult.retroReportId))
    expect(reportAfter[0]!.status).toEqual('ready')

    // RetroProposed event exists.
    const proposedEvents = await db
      .select()
      .from(events)
      .where(eq(events.aggregateId, synthResult.retroProposalId))
    expect(proposedEvents.some((e) => e.eventType === 'RetroProposed')).toBe(true)

    // 6. Approve the proposal.
    const userId = uuidv7()
    const approval = await proposalService.approve(
      synthResult.retroProposalId,
      'Approved as part of integration test',
      userId,
    )
    ownedVersions.push(approval.mergedSystemVersionId)
    expect(approval.gitSha).toMatch(/^[0-9a-f]{40}$/)

    // The agent-org repo HAS a commit with this SHA.
    const log = await agentOrg.log(10)
    const matchingCommit = log.find((c) => c.hash === approval.gitSha)
    expect(matchingCommit).toBeDefined()
    expect(matchingCommit?.message).toContain('retro(persona):')
    expect(matchingCommit?.message).toContain('Tighten sr-dev file scope')

    // The committed file has the expected content.
    const committedContent = await agentOrg.readFile('personas/sr-dev.md')
    expect(committedContent).toContain('Senior Developer (Updated)')

    // The system_versions row exists with this SHA.
    const versionRows = await db
      .select()
      .from(systemVersions)
      .where(eq(systemVersions.systemVersionId, approval.mergedSystemVersionId))
    expect(versionRows).toHaveLength(1)
    expect(versionRows[0]!.gitSha).toEqual(approval.gitSha)

    // SystemVersionShipped event in DB carries the same git_sha.
    const shippedEvents = await db
      .select()
      .from(events)
      .where(eq(events.aggregateId, approval.mergedSystemVersionId))
    const shipped = shippedEvents.find((e) => e.eventType === 'SystemVersionShipped')
    expect(shipped).toBeDefined()
    const shippedPayload = shipped!.payload as Record<string, unknown>
    expect(shippedPayload['git_sha']).toEqual(approval.gitSha)
    expect(shippedPayload['retro_report_id']).toEqual(analyzeResult.retroReportId)

    // Outcome window is open.
    const outcomeRows = await db
      .select()
      .from(retroOutcomes)
      .where(eq(retroOutcomes.retroProposalId, synthResult.retroProposalId))
    expect(outcomeRows).toHaveLength(1)
    expect(outcomeRows[0]!.matchedExpectation).toBeNull()
    ownedOutcomes.push(outcomeRows[0]!.retroOutcomeId)

    // 7. Roll back. (No dependents in this test, so confirmWithDependents=false works.)
    const rollback = await proposalService.rollback(
      approval.mergedSystemVersionId,
      'integration test rollback verification',
      userId,
    )
    ownedVersions.push(rollback.newSystemVersionId)
    expect(rollback.gitSha).not.toEqual(approval.gitSha)

    // The proposal is now rolled_back.
    const rolledBackProposal = await db
      .select()
      .from(retroProposals)
      .where(eq(retroProposals.retroProposalId, synthResult.retroProposalId))
    expect(rolledBackProposal[0]!.status).toEqual('rolled_back')

    // RetroRolledBack event was emitted.
    const rollbackEvents = await db
      .select()
      .from(events)
      .where(
        inArray(events.aggregateId, [approval.mergedSystemVersionId, rollback.newSystemVersionId]),
      )
    expect(rollbackEvents.some((e) => e.eventType === 'RetroRolledBack')).toBe(true)
  })
})
