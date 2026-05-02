/**
 * Unit tests for RetroService.
 *
 * Real Postgres. The capability authority and persona loader are stubbed via
 * minimal type-compatible objects. The service paths under test are:
 *   - analyze() inserts a retro_reports row and emits RetroAnalysisStarted
 *   - synthesizeProposalForTest() validates + persists a proposal + emits
 *     RetroProposed; rejects mismatched layer/path; rejects multi-dominant
 *   - finalizeReportForTest() emits RetroReportGenerated and transitions the
 *     report to 'ready'
 *   - analyze() is idempotent on (sprint_id, run_seq)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { uuidv7 } from 'uuidv7'
import { eq, inArray } from 'drizzle-orm'

import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { DefaultRetroService } from '../../../src/retros/service.js'
import {
  retroReports,
  retroProposals,
  retroProposalLayers,
  retroAnalyses,
} from '../../../src/db/schema/retros.js'
import { events } from '../../../src/db/schema/events.js'
import { sprints } from '../../../src/db/schema/backlog.js'
import type { ICapabilityAuthority } from '../../../src/capabilities/authority.js'
import type { PersonaLoader } from '../../../src/personas/loader.js'
import type { Proposal } from '../../../src/retros/types.js'

const ownedSprints: string[] = []
const ownedReports: string[] = []
const ownedProposals: string[] = []

beforeAll(async () => {
  await sql`SELECT 1`
})

afterAll(async () => {
  if (ownedProposals.length > 0) {
    await db
      .delete(retroProposalLayers)
      .where(inArray(retroProposalLayers.retroProposalId, ownedProposals))
    await db.delete(retroProposals).where(inArray(retroProposals.retroProposalId, ownedProposals))
  }
  if (ownedReports.length > 0) {
    await db.delete(retroAnalyses).where(inArray(retroAnalyses.retroReportId, ownedReports))
    await db.delete(retroReports).where(inArray(retroReports.retroReportId, ownedReports))
  }
  if (ownedSprints.length > 0) {
    await db.delete(sprints).where(inArray(sprints.sprintId, ownedSprints))
  }
  await closeDb().catch(() => undefined)
})

// ---------------------------------------------------------------------------
// Stub doubles
// ---------------------------------------------------------------------------

class StubAuthority implements ICapabilityAuthority {
  public issuedScopes: Array<{ files_write: string[]; channel_read: string[] }> = []
  async issue(params: Parameters<ICapabilityAuthority['issue']>[0]) {
    this.issuedScopes.push({
      files_write: params.scopes.files_write,
      channel_read: params.scopes.channel_read,
    })
    return {
      bundle: {} as never,
      capability_id: uuidv7(),
    }
  }
  async verify() {
    return { ok: true } as never
  }
  async revoke() {
    return
  }
  hasScope() {
    return true
  }
  async validateAndEmit() {
    return { allowed: true } as never
  }
}

class StubPersonaLoader implements PersonaLoader {
  async load() {
    return
  }
  async get() {
    return {} as never
  }
  async getActive() {
    return []
  }
}

// ---------------------------------------------------------------------------
// Fixture: insert a real sprint row.
// ---------------------------------------------------------------------------

async function seedSprint(): Promise<string> {
  const sprintId = uuidv7()
  ownedSprints.push(sprintId)
  await db.insert(sprints).values({
    sprintId,
    name: 'retro-test-sprint',
    sequence: 1,
    status: 'completed',
    storyPointCapacity: 10,
    budgetUsdCents: 10000,
    startedAt: new Date(Date.now() - 60 * 60 * 1000),
    completedAt: new Date(),
  })
  return sprintId
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RetroService.analyze', () => {
  it('inserts a retro_reports row and emits RetroAnalysisStarted', async () => {
    const eventStore = createEventStore(db, sql)
    const installId = uuidv7()
    const service = new DefaultRetroService(
      db,
      eventStore,
      new StubAuthority(),
      new StubPersonaLoader(),
      installId,
    )

    const sprintId = await seedSprint()
    const result = await service.analyze(sprintId)
    ownedReports.push(result.retroReportId)

    const reports = await db
      .select()
      .from(retroReports)
      .where(eq(retroReports.retroReportId, result.retroReportId))
    expect(reports).toHaveLength(1)
    expect(reports[0]!.status).toEqual('analyzing')
    expect(reports[0]!.sprintId).toEqual(sprintId)

    const ev = await db
      .select()
      .from(events)
      .where(eq(events.aggregateId, result.retroReportId))
    expect(ev.some((e) => e.eventType === 'RetroAnalysisStarted')).toBe(true)
  })

  it('issues retro-analyst capability with files_write empty', async () => {
    const eventStore = createEventStore(db, sql)
    const authority = new StubAuthority()
    const installId = uuidv7()
    const service = new DefaultRetroService(
      db,
      eventStore,
      authority,
      new StubPersonaLoader(),
      installId,
    )

    const sprintId = await seedSprint()
    const result = await service.analyze(sprintId)
    ownedReports.push(result.retroReportId)

    expect(authority.issuedScopes).toHaveLength(1)
    expect(authority.issuedScopes[0]!.files_write).toEqual([])
    expect(authority.issuedScopes[0]!.channel_read).toEqual([`#sprint-${sprintId}`])
  })

  it('is idempotent on the same sprint with run_seq=1', async () => {
    const eventStore = createEventStore(db, sql)
    const installId = uuidv7()
    const service = new DefaultRetroService(
      db,
      eventStore,
      new StubAuthority(),
      new StubPersonaLoader(),
      installId,
    )

    const sprintId = await seedSprint()
    const r1 = await service.analyze(sprintId)
    const r2 = await service.analyze(sprintId)
    ownedReports.push(r1.retroReportId)
    expect(r2.retroReportId).toEqual(r1.retroReportId)
  })

  it('throws NOT_FOUND_SPRINT for unknown sprint', async () => {
    const eventStore = createEventStore(db, sql)
    const installId = uuidv7()
    const service = new DefaultRetroService(
      db,
      eventStore,
      new StubAuthority(),
      new StubPersonaLoader(),
      installId,
    )

    await expect(service.analyze(uuidv7())).rejects.toMatchObject({
      code: 'NOT_FOUND_SPRINT',
    })
  })
})

describe('RetroService.synthesizeProposalForTest', () => {
  it('persists a valid proposal and emits RetroProposed', async () => {
    const eventStore = createEventStore(db, sql)
    const installId = uuidv7()
    const service = new DefaultRetroService(
      db,
      eventStore,
      new StubAuthority(),
      new StubPersonaLoader(),
      installId,
    )

    const sprintId = await seedSprint()
    const { retroReportId } = await service.analyze(sprintId)
    ownedReports.push(retroReportId)

    const proposal: Proposal = {
      proposal_code: `PRP-${uuidv7()}`,
      title: 'Tighten sr-dev file-read scoping',
      hypothesis:
        'sr-dev runs over token budget on large refactors; tighter file-read globs reduce by ~10% per sprint.',
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
      confidence_score: 70,
      is_global: true,
    }

    const { retroProposalId } = await service.synthesizeProposalForTest(retroReportId, proposal)
    ownedProposals.push(retroProposalId)

    const rows = await db
      .select()
      .from(retroProposals)
      .where(eq(retroProposals.retroProposalId, retroProposalId))
    expect(rows[0]!.title).toEqual(proposal.title)

    const layerRows = await db
      .select()
      .from(retroProposalLayers)
      .where(eq(retroProposalLayers.retroProposalId, retroProposalId))
    expect(layerRows).toHaveLength(1)
    expect(layerRows[0]!.layer).toEqual('persona')
    expect(layerRows[0]!.isDominant).toBe(true)

    const evRows = await db.select().from(events).where(eq(events.aggregateId, retroProposalId))
    expect(evRows.some((e) => e.eventType === 'RetroProposed')).toBe(true)
  })

  it('rejects a proposal whose target_path does not match its layer glob', async () => {
    const eventStore = createEventStore(db, sql)
    const installId = uuidv7()
    const service = new DefaultRetroService(
      db,
      eventStore,
      new StubAuthority(),
      new StubPersonaLoader(),
      installId,
    )

    const sprintId = await seedSprint()
    const { retroReportId } = await service.analyze(sprintId)
    ownedReports.push(retroReportId)

    const bad: Proposal = {
      proposal_code: `PRP-${uuidv7()}`,
      title: 'Persona at the wrong path',
      hypothesis:
        'this proposal targets a hook path while declaring layer=persona; should be rejected.',
      expected_impact: { metric_key: 'cycle_time_p50', direction: 'decrease', pct_points: -500 },
      rollback_path: 'revert system_version_id <id>',
      layers: [
        {
          layer: 'persona',
          target_path: 'hooks/pre-commit/x.ts',
          change_type: 'modify',
          is_dominant: true,
        },
      ],
      evidence_refs: [],
      confidence_score: 50,
    }

    await expect(service.synthesizeProposalForTest(retroReportId, bad)).rejects.toThrow(
      /VALIDATION_LAYER_PATH_MISMATCH/,
    )
  })

  it('rejects a proposal with no dominant layer', async () => {
    const eventStore = createEventStore(db, sql)
    const installId = uuidv7()
    const service = new DefaultRetroService(
      db,
      eventStore,
      new StubAuthority(),
      new StubPersonaLoader(),
      installId,
    )

    const sprintId = await seedSprint()
    const { retroReportId } = await service.analyze(sprintId)
    ownedReports.push(retroReportId)

    const bad: Proposal = {
      proposal_code: `PRP-${uuidv7()}`,
      title: 'No dominant layer',
      hypothesis:
        'a proposal with multiple layers but none marked is_dominant should fail validation.',
      expected_impact: { metric_key: 'cycle_time_p50', direction: 'decrease', pct_points: -500 },
      rollback_path: 'revert system_version_id <id>',
      layers: [
        {
          layer: 'persona',
          target_path: 'personas/sr-dev.md',
          change_type: 'modify',
          is_dominant: false,
        },
        {
          layer: 'hook',
          target_path: 'hooks/pre-commit/x.ts',
          change_type: 'create',
          is_dominant: false,
        },
      ],
      evidence_refs: [],
      confidence_score: 50,
    }

    await expect(service.synthesizeProposalForTest(retroReportId, bad)).rejects.toThrow(
      /VALIDATION_PROPOSAL_MISSING_DOMINANT_LAYER/,
    )
  })
})

describe('RetroService.finalizeReportForTest', () => {
  it('transitions report to ready and emits RetroReportGenerated', async () => {
    const eventStore = createEventStore(db, sql)
    const installId = uuidv7()
    const service = new DefaultRetroService(
      db,
      eventStore,
      new StubAuthority(),
      new StubPersonaLoader(),
      installId,
    )

    const sprintId = await seedSprint()
    const { retroReportId } = await service.analyze(sprintId)
    ownedReports.push(retroReportId)

    await service.finalizeReportForTest(retroReportId)
    const rows = await db
      .select()
      .from(retroReports)
      .where(eq(retroReports.retroReportId, retroReportId))
    expect(rows[0]!.status).toEqual('ready')
    expect(rows[0]!.completedAt).not.toBeNull()

    const evRows = await db.select().from(events).where(eq(events.aggregateId, retroReportId))
    expect(evRows.some((e) => e.eventType === 'RetroReportGenerated')).toBe(true)
  })
})
