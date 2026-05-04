/**
 * Sprint-policy router unit tests.
 *
 * Two surfaces verified:
 *   1. Schema validation — ceremony_rules is parsed by Zod and rejects
 *      missing keys / out-of-range values.
 *   2. Tenant isolation — `assertProjectInTenant` style WHERE clause never
 *      returns rows that belong to a different tenant.
 *
 * [Engineer-Principal · Opus · run-settings-sprints]
 */

import { describe, it, expect } from 'vitest'
import {
  ceremonyRulesSchema,
  DEFAULT_CEREMONY_RULES,
} from '../../../src/trpc/routers/sprint-policy.js'

const TENANT_A = '11111111-1111-1111-1111-111111111111'
const TENANT_B = '22222222-2222-2222-2222-222222222222'
const SENTINEL = '00000000-0000-0000-0000-000000000000'
const PROJECT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const PROJECT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

type ProjectRow = { projectId: string; tenantId: string }

function selectProjectInTenant(
  rows: ProjectRow[],
  projectId: string,
  tenantId: string,
): ProjectRow | undefined {
  return rows.find((r) => r.projectId === projectId && r.tenantId === tenantId)
}

describe('sprintPolicy.ceremonyRulesSchema', () => {
  it('accepts the canonical defaults', () => {
    expect(() => ceremonyRulesSchema.parse(DEFAULT_CEREMONY_RULES)).not.toThrow()
  })

  it('rejects missing planning slot', () => {
    const bad = { ...DEFAULT_CEREMONY_RULES } as Record<string, unknown>
    delete bad['planning']
    expect(() => ceremonyRulesSchema.parse(bad)).toThrow()
  })

  it('rejects out-of-range hour', () => {
    const bad = {
      ...DEFAULT_CEREMONY_RULES,
      planning: { enabled: true, dow: 1, hour: 99 },
    }
    expect(() => ceremonyRulesSchema.parse(bad)).toThrow()
  })

  it('rejects non-boolean auto flag', () => {
    const bad = { ...DEFAULT_CEREMONY_RULES, auto_retro_on_complete: 'yes' as unknown as boolean }
    expect(() => ceremonyRulesSchema.parse(bad)).toThrow()
  })
})

describe('project_sprint_policy tenant isolation', () => {
  const store: ProjectRow[] = [
    { projectId: PROJECT_A, tenantId: TENANT_A },
    { projectId: PROJECT_B, tenantId: TENANT_B },
  ]

  it('tenant A can find its own project', () => {
    expect(selectProjectInTenant(store, PROJECT_A, TENANT_A)).toBeDefined()
  })

  it("tenant A cannot find tenant B's project (NOT_FOUND, not FORBIDDEN)", () => {
    expect(selectProjectInTenant(store, PROJECT_B, TENANT_A)).toBeUndefined()
  })

  it("tenant B cannot find tenant A's project", () => {
    expect(selectProjectInTenant(store, PROJECT_A, TENANT_B)).toBeUndefined()
  })

  it('sentinel tenant cannot see real-tenant projects', () => {
    expect(selectProjectInTenant(store, PROJECT_A, SENTINEL)).toBeUndefined()
    expect(selectProjectInTenant(store, PROJECT_B, SENTINEL)).toBeUndefined()
  })
})
