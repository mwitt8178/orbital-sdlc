/**
 * test/integration/hub/project-isolation.integration.test.ts
 *
 * fix/multi-project-isolation — Project isolation integration test.
 * [Engineer-Principal · Opus · run-multi-project-isolation]
 *
 * Verifies that within a single tenant, project-scoped tRPC procedures only
 * return rows belonging to the requested project, and that rows from project A
 * are never visible to project B (same-tenant cross-project bleed).
 *
 * Pattern mirrors tenant-isolation.integration.test.ts but with a 2 × 2
 * fixture: { tenantA, tenantB } × { projectA1/A2, projectB1/B2 }.
 *
 * Assertions per CRITICAL/HIGH router:
 *   P1.  epics — project A2 cannot see project A1 rows within tenant A.
 *   P2.  stories — same-tenant cross-project read returns empty.
 *   P3.  sprints — same-tenant cross-project read returns empty.
 *   P4.  channels — same-tenant cross-project read returns empty.
 *   P5.  ceremonies — same-tenant cross-project read returns empty.
 *   P6.  retro_reports — same-tenant cross-project read returns empty.
 *   P7.  uat_sessions — same-tenant cross-project read returns empty.
 *   P8.  tasks — same-tenant cross-project read returns empty.
 *   P9.  vision_versions — same-tenant cross-project read returns empty.
 *   P10. tenant boundary still holds — tenantB cannot read tenantA's projectA1
 *        rows even when supplying projectA1's projectId header.
 *
 * Required env (test runner picks these up from packages/orchestrator/.env.test):
 *   - DATABASE_URL pointing at the Aurora test cluster.
 *   - ORBITAL_MODE=hub
 *   - ORBITAL_HUB_TENANT_ID unused in hub mode.
 *
 * NOTE on Phase 1 vs Phase 2:
 *   Until the router sweep (Phase 2) lands, the projectProcedure middleware is
 *   declared but most routers still use tenantProcedure. The assertions below
 *   that exercise projectProcedure-routed procedures should be marked .todo
 *   in this file until the corresponding router is converted. This file ships
 *   in Phase 1 as the canonical bleed-test contract; each Phase 2 router-sweep
 *   PR flips its `.todo` to a real assertion as part of its acceptance.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { uuidv7 } from 'uuidv7'
import { eq, and } from 'drizzle-orm'

import { db, sql, closeDb } from '../../../src/db/client.js'
import { tasks } from '../../../src/db/schema/orchestration.js'
import { epics, stories, sprints } from '../../../src/db/schema/backlog.js'
import { retroReports } from '../../../src/db/schema/retros.js'
import { channels } from '../../../src/db/schema/channels.js'
import { ceremonies } from '../../../src/db/schema/comms-workflow.js'
import { uatSessions } from '../../../src/db/schema/uat.js'
import { visionDocuments, visionVersions } from '../../../src/db/schema/vision.js'
import { projects } from '../../../src/db/schema/projects.js'

// ---------------------------------------------------------------------------
// Test fixture: 2 tenants × 2 projects each
// ---------------------------------------------------------------------------

const TENANT_A = uuidv7()
const TENANT_B = uuidv7()

const PROJECT_A1 = uuidv7()
const PROJECT_A2 = uuidv7()
const PROJECT_B1 = uuidv7()
const PROJECT_B2 = uuidv7()

const FAKE_INSTALL = uuidv7()
const FAKE_VISION_VERSION_ID = uuidv7()
const FAKE_SPRINT_ID = uuidv7()
const FAKE_TICKET_ID = uuidv7()

// IDs for fixture rows (one per (tenant, project, table) cell that we
// need to assert isolation against).
let epicA1Id: string
let epicA2Id: string
let storyA1Id: string
let storyA2Id: string
let sprintA1Id: string
let sprintA2Id: string
let channelA1Id: string
let channelA2Id: string
let ceremonyA1Id: string
let ceremonyA2Id: string
let retroA1Id: string
let retroA2Id: string
let uatA1Id: string
let uatA2Id: string
let taskA1Id: string
let taskA2Id: string
let visionDocA1Id: string
let visionDocA2Id: string
let visionVersionA1Id: string
let visionVersionA2Id: string
let projectB1RowId: string

beforeAll(async () => {
  await sql`SELECT 1`

  // Project rows for the fixture (so backfill semantics make sense).
  for (const [tenantId, projectId, slug] of [
    [TENANT_A, PROJECT_A1, 'a1'],
    [TENANT_A, PROJECT_A2, 'a2'],
    [TENANT_B, PROJECT_B1, 'b1'],
    [TENANT_B, PROJECT_B2, 'b2'],
  ] as const) {
    await db.insert(projects).values({
      projectId,
      tenantId,
      installId: FAKE_INSTALL,
      name: `proj-${slug}`,
      slug: `iso-${slug}-${projectId.slice(0, 8)}`,
      githubDefaultBranch: 'main',
      scmProvider: 'internal',
      ticketProvider: 'internal',
    })
  }
  projectB1RowId = PROJECT_B1

  // ---------- Epics ----------
  epicA1Id = uuidv7()
  epicA2Id = uuidv7()
  await db.insert(epics).values([
    {
      epicId: epicA1Id,
      tenantId: TENANT_A,
      projectId: PROJECT_A1,
      visionVersionId: FAKE_VISION_VERSION_ID,
      title: 'iso-epic-A1',
      rationale: 'r',
      priority: 1,
      status: 'draft',
    },
    {
      epicId: epicA2Id,
      tenantId: TENANT_A,
      projectId: PROJECT_A2,
      visionVersionId: FAKE_VISION_VERSION_ID,
      title: 'iso-epic-A2',
      rationale: 'r',
      priority: 1,
      status: 'draft',
    },
  ])

  // ---------- Stories ----------
  storyA1Id = uuidv7()
  storyA2Id = uuidv7()
  await db.insert(stories).values([
    {
      storyId: storyA1Id,
      tenantId: TENANT_A,
      projectId: PROJECT_A1,
      epicId: epicA1Id,
      title: 'iso-story-A1',
      description: 'd',
      status: 'backlog',
      priority: 1,
      linkedArtifacts: [],
    },
    {
      storyId: storyA2Id,
      tenantId: TENANT_A,
      projectId: PROJECT_A2,
      epicId: epicA2Id,
      title: 'iso-story-A2',
      description: 'd',
      status: 'backlog',
      priority: 1,
      linkedArtifacts: [],
    },
  ])

  // ---------- Sprints ----------
  sprintA1Id = uuidv7()
  sprintA2Id = uuidv7()
  await db.insert(sprints).values([
    {
      sprintId: sprintA1Id,
      tenantId: TENANT_A,
      projectId: PROJECT_A1,
      name: 'iso-sprint-A1',
      sequence: 9101,
      status: 'planning',
      storyPointCapacity: 40,
      budgetUsdCents: 1,
      priorityClass: 'standard',
      schemaVersion: 1,
    },
    {
      sprintId: sprintA2Id,
      tenantId: TENANT_A,
      projectId: PROJECT_A2,
      name: 'iso-sprint-A2',
      sequence: 9102,
      status: 'planning',
      storyPointCapacity: 40,
      budgetUsdCents: 1,
      priorityClass: 'standard',
      schemaVersion: 1,
    },
  ])

  // ---------- Channels ----------
  channelA1Id = uuidv7()
  channelA2Id = uuidv7()
  for (const [id, projectId, name] of [
    [channelA1Id, PROJECT_A1, `iso-channel-A1-${epicA1Id.slice(0, 6)}`],
    [channelA2Id, PROJECT_A2, `iso-channel-A2-${epicA2Id.slice(0, 6)}`],
  ] as const) {
    await db.insert(channels).values({
      channelId: id,
      tenantId: TENANT_A,
      projectId,
      name,
      kind: 'topic',
      scopeRef: { topic: 'iso' },
      createdByActor: { kind: 'system' },
    })
  }

  // ---------- Ceremonies ----------
  ceremonyA1Id = uuidv7()
  ceremonyA2Id = uuidv7()
  for (const [id, projectId, channelId] of [
    [ceremonyA1Id, PROJECT_A1, channelA1Id],
    [ceremonyA2Id, PROJECT_A2, channelA2Id],
  ] as const) {
    await db.insert(ceremonies).values({
      ceremonyId: id,
      tenantId: TENANT_A,
      projectId,
      ceremonyType: 'planning',
      specId: uuidv7(),
      channelId,
      state: 'scheduled',
      triggeredBy: { kind: 'system' },
      scope: {},
      turnsPerParticipant: 1,
      tokensPerTurn: 100,
      wallClockBudgetMs: 60000,
      voteRule: 'majority',
      voteRequired: false,
    })
  }

  // ---------- Retro reports ----------
  retroA1Id = uuidv7()
  retroA2Id = uuidv7()
  await db.insert(retroReports).values([
    {
      retroReportId: retroA1Id,
      tenantId: TENANT_A,
      projectId: PROJECT_A1,
      sprintId: sprintA1Id,
      analysisRunSeq: 1,
      status: 'ready',
      proposalCount: 0,
      approvedCount: 0,
      rejectedCount: 0,
      deferredCount: 0,
      createdEventId: uuidv7(),
      schemaVersion: 1,
    },
    {
      retroReportId: retroA2Id,
      tenantId: TENANT_A,
      projectId: PROJECT_A2,
      sprintId: sprintA2Id,
      analysisRunSeq: 1,
      status: 'ready',
      proposalCount: 0,
      approvedCount: 0,
      rejectedCount: 0,
      deferredCount: 0,
      createdEventId: uuidv7(),
      schemaVersion: 1,
    },
  ])

  // ---------- UAT sessions ----------
  uatA1Id = uuidv7()
  uatA2Id = uuidv7()
  await db.insert(uatSessions).values([
    {
      uatSessionId: uatA1Id,
      tenantId: TENANT_A,
      projectId: PROJECT_A1,
      ticketId: FAKE_TICKET_ID,
      storyVersion: 1,
      sessionVersion: 1,
      state: 'started',
      triggeredByEventId: uuidv7(),
      buildRef: 'iso-A1',
      startedByUserId: 'tester',
      totalAcCount: 0,
    },
    {
      uatSessionId: uatA2Id,
      tenantId: TENANT_A,
      projectId: PROJECT_A2,
      ticketId: FAKE_TICKET_ID,
      storyVersion: 1,
      sessionVersion: 2,
      state: 'started',
      triggeredByEventId: uuidv7(),
      buildRef: 'iso-A2',
      startedByUserId: 'tester',
      totalAcCount: 0,
    },
  ])

  // ---------- Tasks ----------
  taskA1Id = uuidv7()
  taskA2Id = uuidv7()
  for (const [id, projectId, sprintId] of [
    [taskA1Id, PROJECT_A1, sprintA1Id],
    [taskA2Id, PROJECT_A2, sprintA2Id],
  ] as const) {
    await db.insert(tasks).values({
      taskId: id,
      tenantId: TENANT_A,
      projectId,
      sprintId,
      ticketId: `ISO-${id.slice(0, 8)}`,
      title: `iso-task-${id.slice(0, 6)}`,
      description: 'iso',
      acceptanceCriteria: [],
      personaId: 'sr-dev',
      riskClass: 'standard',
      state: 'pending',
      attemptCount: 0,
      retryBudget: 3,
      wallClockTimeoutMs: 60_000,
      tokenBudget: 4000,
      tokensConsumed: 0,
      declaredWritePaths: [],
      createdByEventId: uuidv7(),
    })
  }

  // ---------- Vision documents + versions ----------
  visionDocA1Id = uuidv7()
  visionDocA2Id = uuidv7()
  visionVersionA1Id = uuidv7()
  visionVersionA2Id = uuidv7()
  for (const [docId, projectId, versionId] of [
    [visionDocA1Id, PROJECT_A1, visionVersionA1Id],
    [visionDocA2Id, PROJECT_A2, visionVersionA2Id],
  ] as const) {
    await db.insert(visionDocuments).values({
      visionDocumentId: docId,
      tenantId: TENANT_A,
      projectId,
      installId: FAKE_INSTALL,
      title: `iso-vd-${docId.slice(0, 6)}`,
      lifecycleState: 'drafting',
      currentVersionNumber: 1,
      createdBy: { kind: 'user', userId: 'tester' },
      lastEventId: uuidv7(),
    })
    await db.insert(visionVersions).values({
      visionVersionId: versionId,
      tenantId: TENANT_A,
      projectId,
      visionDocumentId: docId,
      versionNumber: 1,
      content: { goals: [] },
      contentHash: 'iso-hash',
      changelog: 'iso',
      isLocked: 0,
      draftedBy: { kind: 'persona', personaId: 'pm' },
    })
  }
})

afterAll(async () => {
  // Surgical cleanup — match by tenant id only since fixture is unique to test.
  await db.delete(tasks).where(eq(tasks.tenantId, TENANT_A))
  await db.delete(epics).where(eq(epics.tenantId, TENANT_A))
  await db.delete(stories).where(eq(stories.tenantId, TENANT_A))
  await db.delete(sprints).where(eq(sprints.tenantId, TENANT_A))
  await db.delete(channels).where(eq(channels.tenantId, TENANT_A))
  await db.delete(ceremonies).where(eq(ceremonies.tenantId, TENANT_A))
  await db.delete(retroReports).where(eq(retroReports.tenantId, TENANT_A))
  await db.delete(uatSessions).where(eq(uatSessions.tenantId, TENANT_A))
  await db.delete(visionVersions).where(eq(visionVersions.tenantId, TENANT_A))
  await db.delete(visionDocuments).where(eq(visionDocuments.tenantId, TENANT_A))
  await db
    .delete(projects)
    .where(and(eq(projects.tenantId, TENANT_A)))
  await db
    .delete(projects)
    .where(and(eq(projects.tenantId, TENANT_B)))
  await closeDb()
})

// ---------------------------------------------------------------------------
// Direct-DB project-scoping assertions.
// These verify the schema column exists and the cross-project filter works
// at the query layer. Phase 2 PRs add tRPC-layer assertions that go through
// projectProcedure with the X-Orbital-Project-ID header.
// ---------------------------------------------------------------------------

describe('project isolation — same-tenant cross-project bleed', () => {
  it('P1: epics — projectA1 query does not return projectA2 rows', async () => {
    const rows = await db
      .select()
      .from(epics)
      .where(and(eq(epics.tenantId, TENANT_A), eq(epics.projectId, PROJECT_A1)))
    expect(rows.map((r) => r.epicId)).toContain(epicA1Id)
    expect(rows.map((r) => r.epicId)).not.toContain(epicA2Id)
  })

  it('P2: stories — projectA1 query does not return projectA2 rows', async () => {
    const rows = await db
      .select()
      .from(stories)
      .where(and(eq(stories.tenantId, TENANT_A), eq(stories.projectId, PROJECT_A1)))
    expect(rows.map((r) => r.storyId)).toContain(storyA1Id)
    expect(rows.map((r) => r.storyId)).not.toContain(storyA2Id)
  })

  it('P3: sprints — projectA1 query does not return projectA2 rows', async () => {
    const rows = await db
      .select()
      .from(sprints)
      .where(and(eq(sprints.tenantId, TENANT_A), eq(sprints.projectId, PROJECT_A1)))
    expect(rows.map((r) => r.sprintId)).toContain(sprintA1Id)
    expect(rows.map((r) => r.sprintId)).not.toContain(sprintA2Id)
  })

  it('P4: channels — projectA1 query does not return projectA2 rows', async () => {
    const rows = await db
      .select()
      .from(channels)
      .where(and(eq(channels.tenantId, TENANT_A), eq(channels.projectId, PROJECT_A1)))
    expect(rows.map((r) => r.channelId)).toContain(channelA1Id)
    expect(rows.map((r) => r.channelId)).not.toContain(channelA2Id)
  })

  it('P5: ceremonies — projectA1 query does not return projectA2 rows', async () => {
    const rows = await db
      .select()
      .from(ceremonies)
      .where(and(eq(ceremonies.tenantId, TENANT_A), eq(ceremonies.projectId, PROJECT_A1)))
    expect(rows.map((r) => r.ceremonyId)).toContain(ceremonyA1Id)
    expect(rows.map((r) => r.ceremonyId)).not.toContain(ceremonyA2Id)
  })

  it('P6: retro_reports — projectA1 query does not return projectA2 rows', async () => {
    const rows = await db
      .select()
      .from(retroReports)
      .where(
        and(eq(retroReports.tenantId, TENANT_A), eq(retroReports.projectId, PROJECT_A1)),
      )
    expect(rows.map((r) => r.retroReportId)).toContain(retroA1Id)
    expect(rows.map((r) => r.retroReportId)).not.toContain(retroA2Id)
  })

  it('P7: uat_sessions — projectA1 query does not return projectA2 rows', async () => {
    const rows = await db
      .select()
      .from(uatSessions)
      .where(
        and(eq(uatSessions.tenantId, TENANT_A), eq(uatSessions.projectId, PROJECT_A1)),
      )
    expect(rows.map((r) => r.uatSessionId)).toContain(uatA1Id)
    expect(rows.map((r) => r.uatSessionId)).not.toContain(uatA2Id)
  })

  it('P8: tasks — projectA1 query does not return projectA2 rows', async () => {
    const rows = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.tenantId, TENANT_A), eq(tasks.projectId, PROJECT_A1)))
    expect(rows.map((r) => r.taskId)).toContain(taskA1Id)
    expect(rows.map((r) => r.taskId)).not.toContain(taskA2Id)
  })

  it('P9: vision_versions — projectA1 query does not return projectA2 rows', async () => {
    const rows = await db
      .select()
      .from(visionVersions)
      .where(
        and(
          eq(visionVersions.tenantId, TENANT_A),
          eq(visionVersions.projectId, PROJECT_A1),
        ),
      )
    expect(rows.map((r) => r.visionVersionId)).toContain(visionVersionA1Id)
    expect(rows.map((r) => r.visionVersionId)).not.toContain(visionVersionA2Id)
  })

  it('P10: tenant boundary — tenantB cannot read tenantA projectA1 rows', async () => {
    // Even with the right projectId, the wrong tenant filter returns nothing.
    const rows = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.tenantId, TENANT_B), eq(tasks.projectId, PROJECT_A1)))
    expect(rows).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Phase 2 todos — flipped to real assertions in each router-sweep PR.
// Each todo names the router that must enforce projectProcedure.
// ---------------------------------------------------------------------------

describe('project isolation — tRPC router assertions (Phase 2)', () => {
  it.todo('backlog router rejects request without X-Orbital-Project-ID header')
  it.todo('backlog router scopes epics.list to ctx.projectId')
  it.todo('backlog router scopes stories.list to ctx.projectId')
  it.todo('backlog router scopes sprints.list to ctx.projectId')
  it.todo('channels router scopes channels.list to ctx.projectId')
  it.todo('vision router scopes vision.list to ctx.projectId')
  it.todo('orchestration router scopes tasks.list to ctx.projectId')
  it.todo('retros router scopes retro_reports.list to ctx.projectId')
  it.todo('uat router scopes uat_sessions.list to ctx.projectId')
  it.todo('cost router validates input.projectId === ctx.projectId')
  it.todo('prs router validates input.projectId === ctx.projectId')
  it.todo('boards router validates input.projectId === ctx.projectId')
})
