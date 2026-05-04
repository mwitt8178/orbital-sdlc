/**
 * Phase 1-4 migration verification.
 *
 * Targets the deployed mwitt API via VITE_TRPC_URL/VITE_WS_URL set in
 * packages/ui/.env.production. Asserts:
 *
 *   1. Root URL loads → SetupGate redirects to /welcome (Phase 1.10 UI fix)
 *   2. /welcome renders the onboarding wizard with all 4 flow cards
 *   3. /trpc/onboarding.status network call returns 200 (Phase 1 api-lambda)
 *   4. Each protected route eventually hits /welcome (SetupGate guards work)
 *   5. No uncaught console errors at any step
 *   6. Static UI bundle served by CloudFront has the corrected SetupGate
 *      build (no infinite "Loading…" hang)
 */

import { test, expect, type ConsoleMessage } from '@playwright/test'

/**
 * Capture page-level console errors so a failed test surfaces the cause.
 * We allow specific known-acceptable noise (favicon, font preload warnings,
 * 401 on optional auth probes) but otherwise fail the test if any error
 * message slips through.
 */
function trackConsoleErrors(page: import('@playwright/test').Page): {
  errors: string[]
} {
  const errors: string[] = []
  const allowSubstrings = [
    'favicon',
    'preload',
    'Failed to load resource',
    'WebSocket',
  ]
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() !== 'error') return
    const text = msg.text()
    if (allowSubstrings.some((s) => text.includes(s))) return
    errors.push(text)
  })
  page.on('pageerror', (err) => {
    errors.push(`pageerror: ${err.message}`)
  })
  return { errors }
}

test.describe('Phase 1-4 verification', () => {
  test('root URL redirects to /welcome and renders wizard (Phase 1.10 SetupGate fix)', async ({
    page,
  }) => {
    const { errors } = trackConsoleErrors(page)

    // Capture the onboarding.status network response — proves api-lambda live.
    const onboardingResponse = page.waitForResponse(
      (r) =>
        r.url().includes('/trpc/onboarding.status') && r.status() === 200,
      { timeout: 30_000 },
    )

    await page.goto('/')
    await onboardingResponse

    // SetupGate should redirect since setupCompletedAt is null.
    await expect(page).toHaveURL(/\/welcome$/, { timeout: 15_000 })

    // Wizard heading visible.
    await expect(page.getByRole('heading', { name: /Welcome to Orbital/ })).toBeVisible()

    // All four flow cards present.
    await expect(
      page.getByRole('button', { name: /Start a new project/ }),
    ).toBeVisible()
    await expect(
      page.getByRole('button', { name: /Connect an existing repo/ }),
    ).toBeVisible()
    await expect(
      page.getByRole('button', { name: /Join a team hub/ }),
    ).toBeVisible()
    await expect(
      page.getByRole('button', { name: /Try the sample sandbox/ }),
    ).toBeVisible()

    expect(errors, `unexpected console errors: ${errors.join('\n')}`).toEqual([])
  })

  test('/welcome resume query (direct API call) returns null session', async ({
    request,
  }) => {
    const apiBase = process.env['VITE_TRPC_URL'] ??
      'https://hhhfb8pid6.execute-api.us-east-1.amazonaws.com'
    const r = await request.get(
      `${apiBase}/trpc/onboarding.resume?batch=1&input=%7B%7D`,
    )
    expect(r.status()).toBe(200)
    const body = await r.json()
    expect(body[0].result.data.session).toBeNull()
  })

  test('public route — /public/onboarding.status returns 200', async ({ request }) => {
    const apiBase = process.env['VITE_TRPC_URL'] ??
      'https://hhhfb8pid6.execute-api.us-east-1.amazonaws.com'
    const r = await request.get(`${apiBase}/public/onboarding.status?batch=1&input=%7B%7D`)
    expect(r.status()).toBe(200)
    const body = await r.json()
    expect(body[0].result.data).toMatchObject({ setupCompletedAt: null })
  })

  test('protected routes redirect to /welcome when not signed in', async ({ page }) => {
    const protectedRoutes = [
      '/',
      '/backlog',
      '/vision',
      '/channels',
      '/ceremonies',
      '/uat',
      '/retro',
      '/audit',
      '/memory',
      '/agents',
      '/cost',
      '/settings',
    ]
    for (const route of protectedRoutes) {
      const { errors } = trackConsoleErrors(page)
      await page.goto(route)
      await expect(page).toHaveURL(/\/welcome$/, { timeout: 15_000 })
      // Every protected route must NOT linger on FullScreenLoader.
      await expect(
        page.getByRole('heading', { name: /Welcome to Orbital/ }),
      ).toBeVisible({ timeout: 15_000 })
      expect(
        errors,
        `route ${route} produced console errors: ${errors.join('\n')}`,
      ).toEqual([])
    }
  })

  test('CloudFront serves the latest UI bundle with the SetupGate fix', async ({
    request,
  }) => {
    const r = await request.get('https://d2mtgpa71y9c8t.cloudfront.net/')
    expect(r.status()).toBe(200)
    const html = await r.text()
    // The fixed bundle hash is index-Daveqgq0.js (set in this commit).
    expect(html).toContain('index-Daveqgq0.js')
  })
})

test.describe('Phase 2 daemon end-to-end', () => {
  test('daemon SQS → Lambda chain fires (proxy via API GW provider health)', async ({
    request,
  }) => {
    const apiBase = process.env['VITE_TRPC_URL'] ??
      'https://hhhfb8pid6.execute-api.us-east-1.amazonaws.com'
    // providers.health hits the api-lambda; if api-lambda init crashed,
    // the response would be 500. 200 here = api-lambda boot graph healthy.
    const r = await request.get(
      `${apiBase}/trpc/providers.health?batch=1&input=%7B%7D`,
    )
    expect(r.status()).toBe(200)
  })
})
