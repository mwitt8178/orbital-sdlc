/**
 * Tenant-bleed integration test scaffold.
 *
 * Phase 6.4 of the migration: cross-tenant data exposure check. Spins up
 * two real tenants, hits every authed procedure as tenant A using tenant
 * B's data IDs, expects 403/NOT_FOUND on each.
 *
 * Setup requirements (configured at runtime via env vars):
 *   ORBITAL_TEST_API_URL — the deployed API endpoint, e.g.
 *     https://hhhfb8pid6.execute-api.us-east-1.amazonaws.com
 *   ORBITAL_TEST_TENANT_A_JWT — pre-issued Cognito access token for tenant A
 *   ORBITAL_TEST_TENANT_B_JWT — pre-issued Cognito access token for tenant B
 *   ORBITAL_TEST_TENANT_B_PROJECT_ID — a project ID owned by tenant B
 *   ORBITAL_TEST_TENANT_B_TASK_ID    — a task ID owned by tenant B
 *
 * Run: vitest run packages/api-lambda/test/tenant-bleed.integration.test.ts
 *
 * The test is intentionally a SKELETON — fill in the per-procedure
 * assertions as procedures stabilize. Phase 6.4 gate requires at least
 * one assertion per protectedProcedure in the lambdaAppRouter.
 */

import { describe, it, expect } from 'vitest'

const API_URL = process.env['ORBITAL_TEST_API_URL']
const TOKEN_A = process.env['ORBITAL_TEST_TENANT_A_JWT']
const TOKEN_B = process.env['ORBITAL_TEST_TENANT_B_JWT']
const TENANT_B_PROJECT_ID = process.env['ORBITAL_TEST_TENANT_B_PROJECT_ID']
const TENANT_B_TASK_ID = process.env['ORBITAL_TEST_TENANT_B_TASK_ID']

const HAVE_CONFIG =
  Boolean(API_URL) &&
  Boolean(TOKEN_A) &&
  Boolean(TOKEN_B) &&
  Boolean(TENANT_B_PROJECT_ID) &&
  Boolean(TENANT_B_TASK_ID)

const skipIfNoConfig = HAVE_CONFIG ? describe : describe.skip

skipIfNoConfig('tenant bleed — tenant A cannot read tenant B data', () => {
  /**
   * Helper: call a tRPC procedure as a given tenant.
   * Returns `{ status, body }`. Treats every non-2xx as the actionable
   * outcome; tests assert on status code.
   */
  async function callAs(
    token: string,
    procedure: string,
    input: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const url = `${API_URL}/trpc/${procedure}?batch=1&input=${encodeURIComponent(
      JSON.stringify({ '0': input }),
    )}`
    const resp = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
    })
    const text = await resp.text()
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
    return { status: resp.status, body }
  }

  it('projects.get(tenant_B_project_id) AS tenant_A → 403/404', async () => {
    const r = await callAs(TOKEN_A!, 'projects.get', { id: TENANT_B_PROJECT_ID })
    expect([403, 404]).toContain(r.status)
  })

  it('projects.get(tenant_B_project_id) AS tenant_B → 200 (sanity check)', async () => {
    const r = await callAs(TOKEN_B!, 'projects.get', { id: TENANT_B_PROJECT_ID })
    expect(r.status).toBe(200)
  })

  it('memory.list(tenant_B_project_id) AS tenant_A → 403/404', async () => {
    const r = await callAs(TOKEN_A!, 'memory.list', { projectId: TENANT_B_PROJECT_ID })
    expect([403, 404]).toContain(r.status)
  })

  it('audit.list(tenant_B_task_id) AS tenant_A → 403/404 or empty', async () => {
    const r = await callAs(TOKEN_A!, 'audit.list', { taskId: TENANT_B_TASK_ID })
    // audit.list may return an empty array (data filtered out) — that's also
    // a valid pass: tenant A sees zero of tenant B's events.
    if (r.status === 200) {
      const body = r.body as Array<{ result?: { data?: unknown[] } }>
      const data = body[0]?.result?.data ?? []
      expect(Array.isArray(data) && data.length === 0).toBe(true)
    } else {
      expect([403, 404]).toContain(r.status)
    }
  })

  // TODO Phase 6.4: add at least one assertion per protectedProcedure in
  // packages/api-lambda/src/router.ts. The full list:
  //   admin.* (read-only paths only)
  //   audit.* (list / get)
  //   audit-export.* (list / get / status)
  //   backlog.* (list / get)
  //   boards.* (list / mappings)
  //   channel.* (list / get)
  //   code_reviews.* (list / get)
  //   cost.* (summary / breakdown)
  //   memory.* (list / get / search)
  //   onboarding.* (status / wizard state)
  //   orchestration.* (status read)
  //   outbox.* (list / get)
  //   projects.* (list / get / mappings)
  //   providers.* (health / list)
  //   prs.* (list / get)
  //   replay.* (list / get)
  //   retro.* (proposal.list / versions.list / report.get)
  //   sprint.* (list / get)
  //   team.* (members / presence)
  //   uat.* (status / list)
  //   vision.* (current / list / get)
})
