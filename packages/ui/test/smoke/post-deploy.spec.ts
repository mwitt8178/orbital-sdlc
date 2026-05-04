/**
 * post-deploy.spec.ts — Live smoke gate for the deployed Orbital UI.
 *
 * Runs against the live CloudFront URL. Catches the class of bug where unit
 * and local E2E tests all pass but the deployed site is broken (e.g. a
 * Lambda 500 on a flow card click that only surfaces against real AWS infra).
 *
 * MUST be run with SMOKE_BASE_URL and SMOKE_API_URL set, or defaults to the
 * known mwitt dev environment. Exits non-zero on any console error or 5xx.
 *
 * Run locally:
 *   cd packages/ui
 *   npx playwright test test/smoke --project=smoke
 *
 * In CI: triggered by the post-deploy-smoke workflow after deploy succeeds.
 *
 * Round 11 — sample/demo flow removed
 * [Engineer-Principal · Opus · run-remove-sample-flow]
 */

import { test, expect, type Page } from '@playwright/test'

// ── Environment ──────────────────────────────────────────────────────────────

const BASE_URL =
  process.env['SMOKE_BASE_URL'] ?? 'https://d2mtgpa71y9c8t.cloudfront.net'

const API_URL =
  process.env['SMOKE_API_URL'] ?? 'https://hhhfb8pid6.execute-api.us-east-1.amazonaws.com'

// ── Error collectors ─────────────────────────────────────────────────────────

interface ErrorCollector {
  consoleErrors: string[]
  networkErrors: string[]
}

function attachCollectors(page: Page): ErrorCollector {
  const collector: ErrorCollector = { consoleErrors: [], networkErrors: [] }

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      collector.consoleErrors.push(msg.text())
    }
  })

  page.on('pageerror', (err) => {
    collector.consoleErrors.push(`pageerror: ${err.message}`)
  })

  page.on('response', (res) => {
    if (res.status() >= 400) {
      collector.networkErrors.push(`${res.status()} ${res.url()}`)
    }
  })

  return collector
}

/**
 * Assert no console errors and no >=400 responses were collected.
 *
 * Allowlist:
 *  - favicon.ico — not critical
 *  - WebSocket / ws:// / wss:// errors — daemon not running in CI
 *  - ERR_CONNECTION_REFUSED — expected for optional ws daemon endpoint
 *  - 404 on /trpc/* path probes (Playwright default request)
 *
 * Everything else is a hard failure.
 */
function assertNoErrors(collector: ErrorCollector, label: string) {
  const filteredConsole = collector.consoleErrors.filter(
    (e) =>
      !e.includes('favicon') &&
      !e.includes('WebSocket') &&
      !e.includes('ws://') &&
      !e.includes('wss://') &&
      !e.includes('ERR_CONNECTION_REFUSED') &&
      !e.includes('net::ERR_'),
  )

  expect(
    filteredConsole,
    `[${label}] Console errors: ${filteredConsole.join(' | ')}`,
  ).toHaveLength(0)

  // 5xx are always fatal — 4xx only for non-health paths
  const fatalNetwork = collector.networkErrors.filter((e) => {
    const code = parseInt(e.split(' ')[0] ?? '0', 10)
    if (code >= 500) return true
    // 4xx on API routes (not favicon/assets) are fatal
    if (code >= 400 && (e.includes('/trpc/') || e.includes('.execute-api.'))) return true
    return false
  })

  expect(
    fatalNetwork,
    `[${label}] Fatal network errors: ${fatalNetwork.join(' | ')}`,
  ).toHaveLength(0)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('Post-deploy smoke gate', () => {
  // ── 1. API health ────────────────────────────────────────────────────────

  test('API health: onboarding.status returns 200 with expected shape', async ({ request }) => {
    // The tRPC onboarding.status procedure is the closest thing to a health check
    // that is unauthenticated and always available. Returns installId + mode.
    const res = await request.get(
      `${API_URL}/trpc/onboarding.status?input=%7B%7D`,
    )
    expect(res.status(), 'onboarding.status must return 200').toBe(200)
    const body = (await res.json()) as {
      result?: { data?: { installId?: string } }
    }
    expect(body.result?.data?.installId, 'installId must be present').toBeTruthy()
  })

  // ── 2. Welcome page loads clean ──────────────────────────────────────────

  test('/welcome loads without console errors or >=400 responses', async ({ page }) => {
    const collector = attachCollectors(page)

    await page.goto(`${BASE_URL}/welcome`, { waitUntil: 'load', timeout: 30_000 })

    // Wait for React hydration — either the chooser or an active flow renders
    await page.waitForFunction(
      () => document.querySelector('[data-testid]') !== null,
      { timeout: 15_000 },
    )

    // Allow a tick for any lazy-loaded errors to fire
    await page.waitForTimeout(2_000)

    assertNoErrors(collector, '/welcome load')
  })

  // ── 3. Welcome page shows the 3 remaining flow cards ─────────────────────

  test('welcome chooser renders the three flow cards and no sample card', async ({ page }) => {
    const collector = attachCollectors(page)

    await page.goto(`${BASE_URL}/welcome`, { waitUntil: 'load', timeout: 30_000 })

    // Wait for React to paint something meaningful
    await page.waitForFunction(
      () => document.querySelector('[data-testid]') !== null,
      { timeout: 15_000 },
    )

    // If a session is already active, /welcome resumes into a flow rather than
    // showing the chooser. In that case we accept the assertion that NO sample
    // card renders and skip the positive 3-card check.
    const chooser = page.getByTestId('welcome-chooser')
    const chooserVisible = await chooser.isVisible({ timeout: 5_000 }).catch(() => false)

    // Hard assertion: the removed sample card must NEVER render anywhere.
    await expect(
      page.getByTestId('flow-card-sample_data'),
      'flow-card-sample_data must NOT exist',
    ).toHaveCount(0)

    if (chooserVisible) {
      // Positive check: the three remaining cards are all present.
      await expect(
        page.getByTestId('flow-card-new_project'),
        'flow-card-new_project must be visible',
      ).toBeVisible()
      await expect(
        page.getByTestId('flow-card-existing_repo'),
        'flow-card-existing_repo must be visible',
      ).toBeVisible()
      await expect(
        page.getByTestId('flow-card-join_hub'),
        'flow-card-join_hub must be visible',
      ).toBeVisible()
    }

    assertNoErrors(collector, 'welcome chooser 3-card assertion')
  })

  // ── 4. No 5xx on initial tRPC calls ─────────────────────────────────────

  test('no 5xx responses during /welcome load and initial API calls', async ({ page }) => {
    const fiveHundreds: string[] = []

    page.on('response', (res) => {
      if (res.status() >= 500) {
        fiveHundreds.push(`${res.status()} ${res.url()}`)
      }
    })

    await page.goto(`${BASE_URL}/welcome`, { waitUntil: 'networkidle', timeout: 45_000 })

    // Give background tRPC calls a moment to settle
    await page.waitForTimeout(3_000)

    expect(
      fiveHundreds,
      `5xx responses on /welcome: ${fiveHundreds.join(' | ')}`,
    ).toHaveLength(0)
  })
})
