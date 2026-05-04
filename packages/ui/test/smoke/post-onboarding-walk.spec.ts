/**
 * post-onboarding-walk.spec.ts — explicit per-route walk against the live
 * CloudFront URL.
 *
 * Phase 1: sign in. If onboarding not complete, walk the new_project wizard
 *          end-to-end with deterministic input. Capture a screenshot per step.
 * Phase 2: for every post-onboarding route, navigate, wait for networkidle,
 *          screenshot, capture body text + visible buttons + visible links +
 *          console errors + 4xx/5xx HTTP responses, classify, optionally click
 *          first primary CTA.
 * Phase 3: write evidence JSON to
 *          .claude/tasks/post-onboarding-fixes/walk-evidence.json
 *
 * Run:
 *   SMOKE_LOGIN_EMAIL=... SMOKE_LOGIN_PASSWORD=... \
 *     npx playwright test test/smoke/post-onboarding-walk.spec.ts \
 *     --project=smoke --headed
 *
 * [Engineer-Principal · Opus · run-post-onboarding]
 */

import { test, expect, type Page, type ConsoleMessage, type Response } from '@playwright/test'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const BASE_URL =
  process.env['SMOKE_BASE_URL'] ?? 'https://d2mtgpa71y9c8t.cloudfront.net'
const EMAIL = process.env['SMOKE_LOGIN_EMAIL']
const PASSWORD = process.env['SMOKE_LOGIN_PASSWORD']

const SCREENSHOT_DIR = '/tmp/post-onboarding-walk'
const EVIDENCE_PATH = resolve(
  process.cwd(),
  '../../.claude/tasks/post-onboarding-fixes/walk-evidence.json',
)

interface RouteEvidence {
  path: string
  url_after_load: string
  title: string
  body_snippet: string
  buttons_visible: string[]
  links_visible: string[]
  console_errors: string[]
  http_4xx_5xx: Array<{ status: number; url: string }>
  screenshot: string
  cta_clicked: string | null
  cta_result_url: string | null
  status: 'ok' | 'error' | 'empty' | 'broken-cta' | 'missing-feature'
  issue_summary: string | null
}

interface Evidence {
  timestamp: string
  base_url: string
  bundle_hash: string | null
  lambda_alias_version: string | null
  routes: RouteEvidence[]
}

const ROUTES: Array<{ path: string; allowEmpty?: boolean; skipCta?: boolean }> = [
  { path: '/' },
  { path: '/backlog' },
  { path: '/vision' },
  { path: '/stories' },
  { path: '/channels' },
  { path: '/ceremonies' },
  { path: '/uat' },
  { path: '/retro' },
  { path: '/audit' },
  { path: '/memory' },
  { path: '/agents' },
  { path: '/cost' },
  { path: '/settings' },
  { path: '/settings/general' },
  { path: '/settings/integrations' },
  { path: '/settings/agents' },
  { path: '/settings/sprints' },
  { path: '/settings/team' },
  { path: '/settings/billing' },
  { path: '/admin' },
  { path: '/admin/integrations' },
]

function ensureScreenshotDir() {
  if (!existsSync(SCREENSHOT_DIR)) {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
  }
}

function ensureEvidenceDir() {
  const dir = resolve(EVIDENCE_PATH, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

async function captureRoute(
  page: Page,
  path: string,
  consoleErrors: string[],
  httpFails: Array<{ status: number; url: string }>,
): Promise<RouteEvidence> {
  // Reset accumulators for this route
  consoleErrors.length = 0
  httpFails.length = 0

  const slug = path.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'root'
  const screenshot = `${SCREENSHOT_DIR}/route-${slug}.png`

  try {
    await page.goto(`${BASE_URL}${path}`, { waitUntil: 'load', timeout: 30_000 })
  } catch (e) {
    return {
      path,
      url_after_load: page.url(),
      title: '',
      body_snippet: `NAVIGATION_FAILED: ${(e as Error).message}`,
      buttons_visible: [],
      links_visible: [],
      console_errors: [...consoleErrors],
      http_4xx_5xx: [...httpFails],
      screenshot,
      cta_clicked: null,
      cta_result_url: null,
      status: 'error',
      issue_summary: 'Navigation timeout or hard failure',
    }
  }

  // Wait for networkidle or 4s, whichever first.
  await Promise.race([
    page.waitForLoadState('networkidle', { timeout: 4_000 }).catch(() => null),
    page.waitForTimeout(4_000),
  ])

  await page.screenshot({ path: screenshot, fullPage: false }).catch(() => null)

  const url_after_load = page.url()
  const title = await page.title().catch(() => '')

  const body_snippet = await page
    .evaluate(() => document.body?.innerText?.slice(0, 1000) ?? '')
    .catch(() => '')

  const buttons_visible = await page
    .locator('button:visible')
    .evaluateAll((els) =>
      els
        .map((b) => (b as HTMLElement).innerText.trim())
        .filter((t) => t.length > 0 && t.length < 80),
    )
    .catch(() => [] as string[])

  const links_visible = await page
    .locator('a:visible')
    .evaluateAll((els) =>
      els
        .map((a) => `${(a as HTMLElement).innerText.trim()} → ${(a as HTMLAnchorElement).getAttribute('href') ?? ''}`)
        .filter((t) => t.length > 0 && t.length < 120),
    )
    .catch(() => [] as string[])

  // Classify
  let status: RouteEvidence['status'] = 'ok'
  let issue_summary: string | null = null

  const errSnippets = ['Could not load', 'Something went wrong', 'Error:', 'Application error', '500']
  const emptySnippets = ['No data', 'Nothing here', 'Empty', 'Coming soon']
  if (httpFails.some((f) => f.status >= 500) || consoleErrors.length > 3) {
    status = 'error'
    issue_summary = `HTTP ${httpFails[0]?.status ?? 'n/a'} or console errors: ${consoleErrors[0] ?? 'multiple'}`
  } else if (errSnippets.some((s) => body_snippet.includes(s))) {
    status = 'error'
    issue_summary = `Body shows error string: "${errSnippets.find((s) => body_snippet.includes(s))}"`
  } else if (body_snippet.trim().length < 40) {
    status = 'empty'
    issue_summary = 'Body has near-zero text content'
  } else if (emptySnippets.some((s) => body_snippet.includes(s)) && buttons_visible.length === 0) {
    status = 'empty'
    issue_summary = 'Empty state with no CTAs'
  }

  // Try clicking first primary-ish button (skip destructive)
  let cta_clicked: string | null = null
  let cta_result_url: string | null = null
  const SKIP_CTA = /sign out|delete|disconnect|remove|revoke|log out|cancel/i
  const candidate = buttons_visible.find((t) => !SKIP_CTA.test(t))
  if (candidate) {
    try {
      const before = page.url()
      await page
        .locator(`button:visible`, { hasText: candidate })
        .first()
        .click({ timeout: 3_000 })
      await page.waitForTimeout(2_000)
      cta_clicked = candidate
      cta_result_url = page.url()
      // Re-classify if the click triggered a hard error
      const postBody = await page.evaluate(() => document.body?.innerText?.slice(0, 500) ?? '').catch(() => '')
      if (errSnippets.some((s) => postBody.includes(s))) {
        status = 'broken-cta'
        issue_summary = `CTA "${candidate}" surfaced an error`
      } else if (cta_result_url !== before && /\/404|not-found/.test(cta_result_url)) {
        status = 'broken-cta'
        issue_summary = `CTA "${candidate}" navigated to 404`
      }
    } catch {
      // CTA click failed — non-fatal
    }
  }

  return {
    path,
    url_after_load,
    title,
    body_snippet,
    buttons_visible,
    links_visible,
    console_errors: [...consoleErrors],
    http_4xx_5xx: [...httpFails],
    screenshot,
    cta_clicked,
    cta_result_url,
    status,
    issue_summary,
  }
}

test.describe('Post-onboarding walk', () => {
  test.skip(!EMAIL || !PASSWORD, 'SMOKE_LOGIN_EMAIL / SMOKE_LOGIN_PASSWORD must be set')
  test.setTimeout(15 * 60_000)

  test('walk every route, write evidence JSON', async ({ page, context }) => {
    ensureScreenshotDir()
    ensureEvidenceDir()

    const consoleErrors: string[] = []
    const httpFails: Array<{ status: number; url: string }> = []
    page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'error') {
        const text = msg.text()
        if (text.length > 0 && text.length < 500) consoleErrors.push(text)
      }
    })
    page.on('response', (resp: Response) => {
      const status = resp.status()
      const url = resp.url()
      if (status >= 400 && !url.includes('/favicon') && !url.includes('cloudfront.net/assets')) {
        httpFails.push({ status, url: url.slice(0, 200) })
      }
    })

    // ─────────── Phase 1: sign in ───────────
    await context.clearCookies()
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'load', timeout: 30_000 })
    await page.screenshot({ path: `${SCREENSHOT_DIR}/01-login.png` }).catch(() => null)
    await page.locator('#email').fill(EMAIL!)
    await page.locator('#password').fill(PASSWORD!)
    await page.getByTestId('login-submit').click()
    await page.waitForURL(/\/welcome|\/$/, { timeout: 30_000 })
    await page.waitForTimeout(2_000)

    // Determine current URL — if /welcome and chooser is shown, run the wizard.
    const onWelcome = /\/welcome/.test(page.url())
    if (onWelcome) {
      // Check setup status via API (cheap, deterministic).
      const status = await page.evaluate(async () => {
        const r = await fetch('/api/onboarding.status')
        return r.json().catch(() => null)
      })
      const completed = !!(status as { result?: { data?: { setupCompletedAt?: string | null } } })
        ?.result?.data?.setupCompletedAt

      if (!completed) {
        await page.screenshot({ path: `${SCREENSHOT_DIR}/02-welcome-chooser.png` }).catch(() => null)

        // Pick "New project" — the card has data-testid "flow-card-new_project"
        // but the actual click target is the inner Start button. Click the card.
        const newProjectCard = page.getByTestId('flow-card-new_project')
        if (await newProjectCard.isVisible({ timeout: 2_000 }).catch(() => false)) {
          // Click the "Start" button inside the card.
          await newProjectCard.locator('button').first().click({ timeout: 5_000 }).catch(async () => {
            await newProjectCard.click({ timeout: 5_000 }).catch(() => null)
          })
        }
        await page.waitForTimeout(2_000)
        await page.screenshot({ path: `${SCREENSHOT_DIR}/03-basics.png` }).catch(() => null)

        // ProjectBasicsStep — Project name + slug + description
        const uniqueSlug = `walk-test-${Date.now()}`
        // The InlineValidationField uses label-for-input; first input is name, second is slug.
        const inputs = page.locator('input[type="text"], input:not([type])').filter({ visible: true } as never)
        // Fall back to label-based selectors
        await page.getByLabel(/Project name/i).first().fill('Walk Test').catch(async () => {
          // Fallback to first visible input
          await inputs.nth(0).fill('Walk Test')
        })
        await page.waitForTimeout(500)
        await page.getByLabel(/^Slug$/i).first().fill(uniqueSlug).catch(async () => {
          await inputs.nth(1).fill(uniqueSlug)
        })
        await page.locator('#project-description').fill('Automated post-onboarding walk').catch(() => null)
        await page.waitForTimeout(500)

        // Click Continue (footer button text: "Continue")
        await page.getByRole('button', { name: /^Continue$/ }).click({ timeout: 5_000 }).catch(() => null)
        await page.waitForTimeout(2_000)
        await page.screenshot({ path: `${SCREENSHOT_DIR}/04-tooling.png` }).catch(() => null)

        // ToolingStep — defaults are internal/internal; just continue.
        await page.getByRole('button', { name: /^Continue$/ }).click({ timeout: 5_000 }).catch(() => null)
        await page.waitForTimeout(2_000)
        await page.screenshot({ path: `${SCREENSHOT_DIR}/05-vision.png` }).catch(() => null)

        // VisionIntakeStep — needs >=20 chars in #vision-intent.
        await page.locator('#vision-intent').fill(
          'A simple notes app with markdown support and tagging for personal knowledge management.',
        )
        await page.waitForTimeout(500)
        await page.getByRole('button', { name: /^Continue$/ }).click({ timeout: 5_000 }).catch(() => null)

        // Provisioning steps may auto-advance. Wait up to 90s for Mode step.
        const modeHeading = page.getByRole('heading', { name: /Pick a mode|Mode/i })
        await modeHeading.waitFor({ timeout: 90_000 }).catch(() => null)
        await page.screenshot({ path: `${SCREENSHOT_DIR}/06-mode.png` }).catch(() => null)

        // Click "Live" mode card (radio button).
        await page
          .locator('[role="radio"]')
          .filter({ hasText: /Live/i })
          .first()
          .click({ timeout: 5_000 })
          .catch(() => null)
        await page.waitForTimeout(500)
        await page.getByRole('button', { name: /^Continue$/ }).click({ timeout: 5_000 }).catch(() => null)
        await page.waitForTimeout(2_000)
        await page.screenshot({ path: `${SCREENSHOT_DIR}/07-first-sprint.png` }).catch(() => null)

        // FirstSprintStep — click "Skip" via SkipWithRecoveryHint
        await page
          .getByTestId('skip-with-recovery')
          .locator('button')
          .first()
          .click({ timeout: 5_000 })
          .catch(() => null)
        await page.waitForTimeout(3_000)
        await page.screenshot({ path: `${SCREENSHOT_DIR}/08-done.png` }).catch(() => null)

        // DoneStep — "Launch" button.
        await page.getByRole('button', { name: /Launch|Take the tour|Start/i }).first().click({ timeout: 5_000 }).catch(() => null)
        await page.waitForTimeout(3_000)
        await page.screenshot({ path: `${SCREENSHOT_DIR}/09-after-done.png` }).catch(() => null)
      }
    }

    // Capture bundle hash + check final URL.
    const bundleHash = await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll('script[src]'))
      const m = scripts
        .map((s) => (s as HTMLScriptElement).src.match(/index-([A-Za-z0-9_-]+)\.js/))
        .find((x) => x)
      return m ? m[0].split('/').pop() ?? null : null
    })

    // ─────────── Phase 2: walk each route ───────────
    const routes: RouteEvidence[] = []
    for (const r of ROUTES) {
      const ev = await captureRoute(page, r.path, consoleErrors, httpFails)
      routes.push(ev)
      // small breather
      await page.waitForTimeout(500)
    }

    // ─────────── Phase 3: write evidence ───────────
    const evidence: Evidence = {
      timestamp: new Date().toISOString(),
      base_url: BASE_URL,
      bundle_hash: bundleHash ?? null,
      lambda_alias_version: process.env['LAMBDA_ALIAS_VERSION'] ?? null,
      routes,
    }
    writeFileSync(EVIDENCE_PATH, JSON.stringify(evidence, null, 2))
    console.log(`[walk] wrote evidence → ${EVIDENCE_PATH}`)
    console.log(`[walk] summary:`, {
      total: routes.length,
      ok: routes.filter((r) => r.status === 'ok').length,
      error: routes.filter((r) => r.status === 'error').length,
      empty: routes.filter((r) => r.status === 'empty').length,
      broken_cta: routes.filter((r) => r.status === 'broken-cta').length,
    })

    // Soft assertion — we want the JSON regardless, but flag if catastrophic.
    expect(routes.length).toBeGreaterThan(0)
  })
})
