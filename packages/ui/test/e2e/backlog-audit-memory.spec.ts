/**
 * Phase 1-4 deep verification — Backlog / Audit / Memory pages + API smoke.
 *
 * Browser assertions (SetupGate redirect):
 *   Each of /backlog, /audit, /memory must:
 *     1. Redirect to /welcome (SetupGate fires because no session).
 *     2. Render "Welcome to Orbital" heading — wizard rendered, NOT stuck on
 *        the FullScreenLoader.
 *     3. Produce zero uncaught console errors.
 *
 * Direct API smoke (no auth):
 *   - backlog.epics.list  → 200, 400, or 401 (tenantProcedure; expects auth)
 *   - audit.events.query  → 200 or 401 (publicProcedure)
 *   - memory.list         → 200, 400, or 401 (tenantProcedure; expects auth + projectId)
 *
 *   The critical assertion is NOT 5xx — a 5xx proves the api-lambda either
 *   crashed on init or the procedure failed at runtime. The test fails on 5xx
 *   and surfaces the response body so the cause is immediately visible.
 *   200/400/401 all prove the router includes the procedure and it initialises.
 *
 * Known finding (2026-05-04):
 *   backlog.epics.list returns 500 with "IAM authentication failed for the
 *   role orbital_admin" — the DSQL IAM token is expired. This is a DB-layer
 *   failure, not a router crash, but the test correctly catches it as a 5xx.
 *   Fix: re-deploy or manually rotate the DSQL IAM token for orbital_admin.
 */

import { test, expect, type ConsoleMessage, type APIResponse } from '@playwright/test'

const API_BASE =
  process.env['VITE_TRPC_URL'] ?? 'https://hhhfb8pid6.execute-api.us-east-1.amazonaws.com'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Attach console-error and pageerror listeners to `page`.
 * Returns a ref whose `.errors` array is populated as events arrive.
 * Known-acceptable noise (favicon, preload, WebSocket) is filtered out.
 */
function trackConsoleErrors(page: import('@playwright/test').Page): { errors: string[] } {
  const errors: string[] = []
  const ignoreSubstrings = ['favicon', 'preload', 'Failed to load resource', 'WebSocket']

  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() !== 'error') return
    const text = msg.text()
    if (ignoreSubstrings.some((s) => text.includes(s))) return
    errors.push(text)
  })

  page.on('pageerror', (err) => {
    errors.push(`pageerror: ${err.message}`)
  })

  return { errors }
}

/**
 * Build a tRPC GET URL for a batch-1 query with an optional input payload.
 * Encodes the input object as the standard tRPC batch query string.
 */
function trpcGet(procedure: string, input: unknown = {}): string {
  const encoded = encodeURIComponent(JSON.stringify({ '0': input }))
  return `${API_BASE}/trpc/${procedure}?batch=1&input=${encoded}`
}

/**
 * Assert a tRPC response is not a 5xx.
 * Returns the body text so callers can log it.
 */
async function assertNot5xx(r: APIResponse, proc: string): Promise<string> {
  const body = await r.text()
  expect(
    r.status(),
    [
      `${proc} returned ${r.status()} (5xx) — router may have crashed on init or DB layer is unhealthy.`,
      `Response body: ${body.slice(0, 400)}`,
    ].join('\n'),
  ).toBeLessThan(500)
  return body
}

// ---------------------------------------------------------------------------
// Browser: SetupGate redirect + wizard rendering
// ---------------------------------------------------------------------------

test.describe('SetupGate redirects for protected pages', () => {
  const protectedPages = ['/backlog', '/audit', '/memory'] as const

  for (const path of protectedPages) {
    test(`${path} → redirects to /welcome and renders wizard heading`, async ({ page }) => {
      const { errors } = trackConsoleErrors(page)

      // Capture onboarding.status so we know whether the Lambda was reachable.
      // SetupGate depends on this query; if it errors the gate falls through.
      const onboardingPromise = page.waitForResponse(
        (r) => r.url().includes('/trpc/onboarding.status'),
        { timeout: 25_000 },
      ).catch(() => null)

      await page.goto(path)
      const onboardingResp = await onboardingPromise

      // Surface the onboarding.status result to make failures diagnosable.
      if (onboardingResp) {
        const onboardingStatus = onboardingResp.status()
        const onboardingBody = await onboardingResp.text().catch(() => '<unreadable>')
        // onboarding.status must not 5xx — that would break SetupGate redirect.
        expect(
          onboardingStatus,
          [
            `${path}: onboarding.status returned ${onboardingStatus} — SetupGate cannot redirect when its query fails.`,
            `Body: ${onboardingBody.slice(0, 300)}`,
          ].join('\n'),
        ).toBeLessThan(500)
      }

      // SetupGate must redirect to /welcome.
      await expect(page).toHaveURL(/\/welcome$/, { timeout: 20_000 })

      // The wizard must render its heading — proves it's not stuck on the
      // FullScreenLoader (the bug fixed in Phase 1.10).
      await expect(
        page.getByRole('heading', { name: /Welcome to Orbital/i }),
      ).toBeVisible({ timeout: 15_000 })

      expect(
        errors,
        `${path} → uncaught console errors:\n${errors.join('\n')}`,
      ).toEqual([])
    })
  }
})

// ---------------------------------------------------------------------------
// Direct API smoke: assert NOT 5xx on these routes
// ---------------------------------------------------------------------------

test.describe('API smoke — backlog / audit / memory router init', () => {
  test('backlog.epics.list → not 5xx (200 or 401 expected)', async ({ request }) => {
    // tenantProcedure: without auth header returns 200 (empty) if the DB is
    // healthy, or 401 if the tenant middleware rejects. Never 500 on init.
    const r = await request.get(trpcGet('backlog.epics.list', {}))
    await assertNot5xx(r, 'backlog.epics.list')
  })

  test('audit.events.query → not 5xx (200 expected)', async ({ request }) => {
    // publicProcedure with optional filters. Should return 200 with event list.
    const r = await request.get(trpcGet('audit.events.query', { filters: {} }))
    await assertNot5xx(r, 'audit.events.query')
  })

  test('memory.list → not 5xx (200, 400, or 401 expected)', async ({ request }) => {
    // tenantProcedure; requires projectId in input → 400 BAD_REQUEST without it.
    // That is healthy: schema validation ran, no crash.
    const r = await request.get(trpcGet('memory.list', {}))
    const body = await assertNot5xx(r, 'memory.list')

    if (r.status() === 400) {
      // Must be a schema validation error, not a server crash.
      expect(body, 'memory.list 400 must be BAD_REQUEST not INTERNAL_SERVER_ERROR').toContain(
        'BAD_REQUEST',
      )
    }
  })

  test('no INTERNAL_SERVER_ERROR in 200 responses for all three routes', async ({ request }) => {
    // Even a 200 can hide a tRPC INTERNAL_SERVER_ERROR in the JSON body if
    // the procedure threw after the HTTP status was committed. Assert it does not.
    const endpoints: Array<{ proc: string; input: unknown }> = [
      { proc: 'backlog.epics.list', input: {} },
      { proc: 'audit.events.query', input: { filters: {} } },
      { proc: 'memory.list', input: {} },
    ]

    for (const { proc, input } of endpoints) {
      const r = await request.get(trpcGet(proc, input))
      const body = await r.text()

      // Surface any 5xx immediately with the body for diagnosis.
      expect(
        r.status(),
        `${proc} returned ${r.status()} — body: ${body.slice(0, 400)}`,
      ).toBeLessThan(500)

      // 200 responses must not carry a hidden INTERNAL_SERVER_ERROR.
      if (r.status() === 200) {
        expect(
          body,
          `${proc} returned 200 but JSON body contains INTERNAL_SERVER_ERROR`,
        ).not.toContain('INTERNAL_SERVER_ERROR')
      }
    }
  })
})
