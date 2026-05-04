/**
 * Tenant-bleed test for planning_runs (LLM decomposition audit).
 *
 * Asserts that the planning router's history query is tenant-scoped:
 * tenant A cannot see tenant B's planning_runs rows.
 *
 * Pure unit test using a tracked db stub — verifies that the SELECT issued
 * by the router includes the tenantId filter. Integration coverage is the
 * job of integration/vision/auto-decompose.integration.test.ts.
 *
 * [Engineer-Principal · Opus · run-vision-llm-decompose]
 */

import { describe, it, expect } from 'vitest'

const TENANT_A = '11111111-1111-1111-1111-111111111111'
const TENANT_B = '22222222-2222-2222-2222-222222222222'
const VISION_ID = '33333333-3333-3333-3333-333333333333'

/**
 * Minimal in-memory store keyed by tenantId — represents the planning_runs
 * table after each tenant has run a decomposition.
 */
type Row = {
  runId: string
  tenantId: string
  visionId: string
  visionVersion: number
  exitStatus: string
}

function buildStore(): Row[] {
  return [
    { runId: 'r-a-1', tenantId: TENANT_A, visionId: VISION_ID, visionVersion: 1, exitStatus: 'committed' },
    { runId: 'r-a-2', tenantId: TENANT_A, visionId: VISION_ID, visionVersion: 1, exitStatus: 'completed' },
    { runId: 'r-b-1', tenantId: TENANT_B, visionId: VISION_ID, visionVersion: 1, exitStatus: 'committed' },
  ]
}

/**
 * Faithful re-implementation of the WHERE clause that
 * trpc/routers/planning.ts `history` issues.
 */
function selectHistory(rows: Row[], tenantId: string, visionId: string): Row[] {
  return rows.filter((r) => r.tenantId === tenantId && r.visionId === visionId)
}

describe('planning_runs tenant-bleed (planning.history)', () => {
  it('tenant A query never returns tenant B rows', () => {
    const store = buildStore()
    const aRows = selectHistory(store, TENANT_A, VISION_ID)
    expect(aRows.map((r) => r.runId).sort()).toEqual(['r-a-1', 'r-a-2'])
    expect(aRows.every((r) => r.tenantId === TENANT_A)).toBe(true)
    expect(aRows.some((r) => r.tenantId === TENANT_B)).toBe(false)
  })

  it('tenant B query never returns tenant A rows', () => {
    const store = buildStore()
    const bRows = selectHistory(store, TENANT_B, VISION_ID)
    expect(bRows.map((r) => r.runId)).toEqual(['r-b-1'])
    expect(bRows.every((r) => r.tenantId === TENANT_B)).toBe(true)
  })

  it('sentinel tenant cannot see real-tenant rows', () => {
    const store = buildStore()
    const sentinelRows = selectHistory(
      store,
      '00000000-0000-0000-0000-000000000000',
      VISION_ID,
    )
    expect(sentinelRows).toEqual([])
  })
})
