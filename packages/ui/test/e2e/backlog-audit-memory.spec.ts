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
 *   - backlog.epics.list  → 200 or 401 (tenantProcedure: expects auth header)
 *   - audit.events.query  → 200 or 401 (publicProcedure, but may require tenant)
 *   - memory.list         → 200 or 401 (tenantProcedure: expects auth header)
 *
 *   The critical assertion is NOT 500 — a 500 would mean the api-lambda
 *   crashed on init or the procedure itself blew up before the auth check.
 *   200 or 401 proves the router includes the procedure and it initialises cleanly.
 */

import { test, expect, type ConsoleMessage } from '@playwright/test'

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

// ---------------------------------------------------------------------------
// Browser: SetupGate redirect + wizard rendering
// ---------------------------------------------------------------------------

test.describe('SetupGate redirects for protected pages', () => {
  const protectedPages = ['/backlog', '/audit', '/memory'] as const

  for (const path of protectedPages) {
    test(`${path} → redirects to /welcome and renders wizard heading`, async ({ page }) => {
      const { errors } = trackConsoleErrors(page)

      await page.goto(path)

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
// Direct API smoke: assert NOT 500 on these routes
// ---------------------------------------------------------------------------

test.describe('API smoke — backlog / audit / memory router init', () => {
  test('backlog.epics.list → 200 or 401 (NOT 500)', async ({ request }) => {
    const r = await request.get(trpcGet('backlog.epics.list', {}))
    const status = r.status()

    expect(
      [200, 401],
      `backlog.epics.list returned ${status} — expected 200 or 401, not a 5xx`,
    ).toContain(status)
  })

  test('audit.events.query → 200 or 401 (NOT 500)', async ({ request }) => {
    // audit.events.query is a publicProcedure with an optional filters input.
    const r = await request.get(trpcGet('audit.events.query', { filters: {} }))
    const status = r.status()

    expect(
      [200, 401],
      `audit.events.query returned ${status} — expected 200 or 401, not a 5xx`,
    ).toContain(status)
  })

  test('memory.list → 200, 400, or 401 (NOT 500)', async ({ request }) => {
    // memory.list requires a projectId in its input schema; calling without one
    // returns 400 BAD_REQUEST (tRPC input validation) — that is healthy. 400
    // means the procedure was reached and its schema ran; no Lambda crash.
    const r = await request.get(trpcGet('memory.list', {}))
    const status = r.status()

    expect(
      [200, 400, 401],
      `memory.list returned ${status} — expected 200/400/401 (not a 5xx crash)`,
    ).toContain(status)

    // If 400, confirm it is a schema validation error, not a server crash.
    if (status === 400) {
      const body = await r.text()
      expect(body).toContain('BAD_REQUEST')
      expect(body).not.toContain('INTERNAL_SERVER_ERROR')
    }
  })

  test('API smoke responses carry no tRPC INTERNAL_SERVER_ERROR body', async ({ request }) => {
    // Even when the API returns 200, a tRPC INTERNAL_SERVER_ERROR in the body
    // means the procedure itself crashed. Assert the body does NOT contain one.
    const endpoints: Array<{ proc: string; input: unknown }> = [
      { proc: 'backlog.epics.list', input: {} },
      { proc: 'audit.events.query', input: { filters: {} } },
      { proc: 'memory.list', input: {} },
    ]

    for (const { proc, input } of endpoints) {
      const r = await request.get(trpcGet(proc, input))
      const body = await r.text()

      // 401 and 400 (input-validation) are fine — the router reached the
      // procedure. Only 200 responses need the body checked for silent crashes.
      if (r.status() === 200) {
        expect(
          body,
          `${proc} returned 200 but body contains INTERNAL_SERVER_ERROR`,
        ).not.toContain('INTERNAL_SERVER_ERROR')
      }
      // Any 5xx is a hard failure regardless of body.
      expect(
        r.status(),
        `${proc} returned a 5xx — Lambda likely crashed on init`,
      ).toBeLessThan(500)
    }
  })
})
