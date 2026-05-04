/**
 * Unit tests for vision_decomposition_runs lifecycle.
 *
 * Covers:
 *   VD1. Tenant isolation — runStatus query is tenant-scoped (A cannot see B rows).
 *   VD2. JSON schema validation — ProposedDecompositionSchema rejects invalid shapes.
 *   VD3. Idempotency — approvePlan returns alreadyApproved=true on second call.
 *   VD4. Status transitions — discard of approved run is rejected.
 *   VD5. Status transitions — approve of discarded run is rejected.
 *   VD6. EpicCount / storyCount computed correctly from proposal.
 *
 * These are pure-logic tests using in-memory stubs. Integration coverage lives
 * alongside the planning_runs integration tests.
 *
 * [Engineer-Sr · Sonnet · run-vision-decompose]
 */

import { describe, it, expect } from 'vitest'
import {
  ProposedDecompositionSchema,
  type ProposedDecomposition,
} from '../../../src/vision/llm-decomposer.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TENANT_A = '11111111-1111-1111-1111-111111111111'
const TENANT_B = '22222222-2222-2222-2222-222222222222'
const VISION_ID = '33333333-3333-3333-3333-333333333333'
const SENTINEL = '00000000-0000-0000-0000-000000000000'

// ---------------------------------------------------------------------------
// In-memory store types (mirror vision_decomposition_runs table)
// ---------------------------------------------------------------------------

type DecompRunStatus = 'pending' | 'approved' | 'discarded' | 'failed'

type DecompRunRow = {
  id: string
  tenantId: string
  visionId: string
  status: DecompRunStatus
  epicCount: number | null
  storyCount: number | null
  error: string | null
}

// ---------------------------------------------------------------------------
// Helpers (reimplementing the WHERE clauses from the router)
// ---------------------------------------------------------------------------

function selectLatestRun(
  rows: DecompRunRow[],
  tenantId: string,
  visionId: string,
): DecompRunRow | null {
  const matching = rows.filter((r) => r.tenantId === tenantId && r.visionId === visionId)
  return matching[matching.length - 1] ?? null
}

function tryApprovePlan(
  rows: DecompRunRow[],
  runId: string,
  tenantId: string,
  visionId: string,
): { ok: true; alreadyApproved: boolean } | { ok: false; error: string } {
  const run = rows.find(
    (r) => r.id === runId && r.tenantId === tenantId && r.visionId === visionId,
  )
  if (!run) return { ok: false, error: 'NOT_FOUND' }
  if (run.status === 'approved') return { ok: true, alreadyApproved: true }
  if (run.status === 'discarded') return { ok: false, error: 'cannot approve discarded run' }
  if (run.status === 'failed') return { ok: false, error: 'cannot approve failed run' }
  run.status = 'approved'
  return { ok: true, alreadyApproved: false }
}

function tryDiscardPlan(
  rows: DecompRunRow[],
  runId: string,
  tenantId: string,
  visionId: string,
): { ok: true } | { ok: false; error: string } {
  const run = rows.find(
    (r) => r.id === runId && r.tenantId === tenantId && r.visionId === visionId,
  )
  if (!run) return { ok: false, error: 'NOT_FOUND' }
  if (run.status === 'approved') return { ok: false, error: 'cannot discard approved run' }
  if (run.status === 'discarded') return { ok: true } // idempotent
  run.status = 'discarded'
  return { ok: true }
}

function buildStore(): DecompRunRow[] {
  return [
    { id: 'run-a-1', tenantId: TENANT_A, visionId: VISION_ID, status: 'pending', epicCount: 3, storyCount: 9, error: null },
    { id: 'run-a-2', tenantId: TENANT_A, visionId: VISION_ID, status: 'approved', epicCount: 4, storyCount: 12, error: null },
    { id: 'run-b-1', tenantId: TENANT_B, visionId: VISION_ID, status: 'pending', epicCount: 3, storyCount: 7, error: null },
  ]
}

// ---------------------------------------------------------------------------
// Minimal valid proposal for schema tests
// ---------------------------------------------------------------------------

function makeValidProposal(): ProposedDecomposition {
  const story = (suffix: string) => ({
    title: `Story ${suffix}`,
    description: 'User can complete this action without errors in the happy path.',
    story_points: 2 as const,
    acceptance_criteria: [
      'Given the user is logged in, when they perform the action, then it succeeds.',
      'The system persists the change and it is visible on next load.',
    ],
  })

  const epic = (idx: number) => ({
    title: `Epic ${idx}`,
    rationale: 'This epic addresses a core user need identified in the vision document.',
    stories: [story(`${idx}-1`), story(`${idx}-2`)],
  })

  return { epics: [epic(1), epic(2), epic(3)] }
}

// ---------------------------------------------------------------------------
// VD1: Tenant isolation
// ---------------------------------------------------------------------------

describe('VD1: vision_decomposition_runs tenant isolation', () => {
  it('runStatus for tenant A never returns tenant B rows', () => {
    const store = buildStore()
    const row = selectLatestRun(store, TENANT_A, VISION_ID)
    expect(row).not.toBeNull()
    expect(row!.tenantId).toBe(TENANT_A)
    expect(row!.tenantId).not.toBe(TENANT_B)
  })

  it('runStatus for tenant B never returns tenant A rows', () => {
    const store = buildStore()
    const row = selectLatestRun(store, TENANT_B, VISION_ID)
    expect(row).not.toBeNull()
    expect(row!.tenantId).toBe(TENANT_B)
    expect(row!.id).toBe('run-b-1')
  })

  it('sentinel tenant returns null when no rows for sentinel', () => {
    const store = buildStore()
    const row = selectLatestRun(store, SENTINEL, VISION_ID)
    expect(row).toBeNull()
  })

  it('approvePlan with wrong tenant returns NOT_FOUND', () => {
    const store = buildStore()
    const result = tryApprovePlan(store, 'run-a-1', TENANT_B, VISION_ID)
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error).toBe('NOT_FOUND')
  })

  it('discardPlan with wrong tenant returns NOT_FOUND', () => {
    const store = buildStore()
    const result = tryDiscardPlan(store, 'run-a-1', TENANT_B, VISION_ID)
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error).toBe('NOT_FOUND')
  })
})

// ---------------------------------------------------------------------------
// VD2: JSON schema validation (ProposedDecompositionSchema)
// ---------------------------------------------------------------------------

describe('VD2: ProposedDecompositionSchema validation', () => {
  it('accepts a valid 3-epic proposal', () => {
    const result = ProposedDecompositionSchema.safeParse(makeValidProposal())
    expect(result.success).toBe(true)
  })

  it('rejects a proposal with fewer than 3 epics', () => {
    const proposal = makeValidProposal()
    proposal.epics = proposal.epics.slice(0, 2)
    const result = ProposedDecompositionSchema.safeParse(proposal)
    expect(result.success).toBe(false)
  })

  it('rejects a proposal with more than 5 epics', () => {
    const proposal = makeValidProposal()
    while (proposal.epics.length < 6) {
      proposal.epics.push({
        title: 'Extra Epic',
        rationale: 'Extra rationale for testing the max limit of the schema.',
        stories: [
          {
            title: 'Extra Story',
            description: 'Extra story description for testing purposes.',
            story_points: 1 as const,
            acceptance_criteria: ['Criterion A', 'Criterion B'],
          },
          {
            title: 'Extra Story Two',
            description: 'Second extra story description for testing purposes.',
            story_points: 1 as const,
            acceptance_criteria: ['Criterion A', 'Criterion B'],
          },
        ],
      })
    }
    const result = ProposedDecompositionSchema.safeParse(proposal)
    expect(result.success).toBe(false)
  })

  it('rejects an epic with fewer than 2 stories', () => {
    const proposal = makeValidProposal()
    proposal.epics[0]!.stories = proposal.epics[0]!.stories.slice(0, 1)
    const result = ProposedDecompositionSchema.safeParse(proposal)
    expect(result.success).toBe(false)
  })

  it('rejects a story with invalid story_points', () => {
    const proposal = makeValidProposal()
    // 4 is not in [1,2,3,5]
    ;(proposal.epics[0]!.stories[0] as Record<string, unknown>)['story_points'] = 4
    const result = ProposedDecompositionSchema.safeParse(proposal)
    expect(result.success).toBe(false)
  })

  it('rejects a story AC that is too short', () => {
    const proposal = makeValidProposal()
    proposal.epics[0]!.stories[0]!.acceptance_criteria[0] = 'short'
    const result = ProposedDecompositionSchema.safeParse(proposal)
    expect(result.success).toBe(false)
  })

  it('rejects a story with fewer than 2 ACs', () => {
    const proposal = makeValidProposal()
    proposal.epics[0]!.stories[0]!.acceptance_criteria = ['Only one AC here is too short']
    const result = ProposedDecompositionSchema.safeParse(proposal)
    expect(result.success).toBe(false)
  })

  it('rejects missing required fields (no title on epic)', () => {
    const raw = makeValidProposal() as unknown as Record<string, unknown>
    const epicsArr = raw['epics'] as Array<Record<string, unknown>>
    delete epicsArr[0]!['title']
    const result = ProposedDecompositionSchema.safeParse(raw)
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// VD3: Idempotency — approvePlan
// ---------------------------------------------------------------------------

describe('VD3: approvePlan idempotency', () => {
  it('second approval returns alreadyApproved=true without error', () => {
    const store = buildStore()
    // Approve run-a-1 (currently pending).
    const first = tryApprovePlan(store, 'run-a-1', TENANT_A, VISION_ID)
    expect(first.ok).toBe(true)
    expect((first as { ok: true; alreadyApproved: boolean }).alreadyApproved).toBe(false)

    // Approve again — should be idempotent.
    const second = tryApprovePlan(store, 'run-a-1', TENANT_A, VISION_ID)
    expect(second.ok).toBe(true)
    expect((second as { ok: true; alreadyApproved: boolean }).alreadyApproved).toBe(true)
  })

  it('discardPlan on already-discarded run returns ok (idempotent)', () => {
    const store = buildStore()
    // Discard run-a-1.
    const first = tryDiscardPlan(store, 'run-a-1', TENANT_A, VISION_ID)
    expect(first.ok).toBe(true)

    // Discard again — idempotent.
    const second = tryDiscardPlan(store, 'run-a-1', TENANT_A, VISION_ID)
    expect(second.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// VD4: Status transitions — discard of approved run is rejected
// ---------------------------------------------------------------------------

describe('VD4: status transition — discard approved run', () => {
  it('discarding an approved run returns an error', () => {
    const store = buildStore()
    // run-a-2 is already 'approved'.
    const result = tryDiscardPlan(store, 'run-a-2', TENANT_A, VISION_ID)
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error).toContain('discard approved')
  })
})

// ---------------------------------------------------------------------------
// VD5: Status transitions — approve of discarded/failed run is rejected
// ---------------------------------------------------------------------------

describe('VD5: status transition — approve discarded/failed run', () => {
  it('approving a discarded run returns an error', () => {
    const store = buildStore()
    // Discard run-a-1 first.
    tryDiscardPlan(store, 'run-a-1', TENANT_A, VISION_ID)
    const result = tryApprovePlan(store, 'run-a-1', TENANT_A, VISION_ID)
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error).toContain('discarded')
  })

  it('approving a failed run returns an error', () => {
    const store: DecompRunRow[] = [
      { id: 'run-fail-1', tenantId: TENANT_A, visionId: VISION_ID, status: 'failed', epicCount: null, storyCount: null, error: 'llm error' },
    ]
    const result = tryApprovePlan(store, 'run-fail-1', TENANT_A, VISION_ID)
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error).toContain('failed')
  })
})

// ---------------------------------------------------------------------------
// VD6: EpicCount / storyCount computed correctly from proposal
// ---------------------------------------------------------------------------

describe('VD6: epicCount and storyCount computed from proposal', () => {
  it('counts epics and stories from a 3-epic proposal', () => {
    const proposal = makeValidProposal()
    const epicCount = proposal.epics.length
    const storyCount = proposal.epics.reduce((sum, ep) => sum + ep.stories.length, 0)
    expect(epicCount).toBe(3)
    expect(storyCount).toBe(6) // 3 epics × 2 stories each
  })

  it('counts correctly for a mixed-story-count proposal', () => {
    const proposal = makeValidProposal()
    // Add a third story to the first epic.
    proposal.epics[0]!.stories.push({
      title: 'Third Story',
      description: 'A third story for the first epic with a full description.',
      story_points: 3,
      acceptance_criteria: [
        'Given conditions, when action, then outcome is as expected.',
        'System persists change and it is reflected immediately.',
      ],
    })
    const storyCount = proposal.epics.reduce((sum, ep) => sum + ep.stories.length, 0)
    expect(storyCount).toBe(7) // 3 + 2 + 2
  })
})
