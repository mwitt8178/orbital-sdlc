/**
 * Onboarding screenshot harness.
 * Captures the rebuilt onboarding surfaces at 375px and 1280px against the
 * live deployment.
 *
 * [Engineer-Principal · Opus · run-orbital-onboarding-rework]
 */

import { test, expect, Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'

const BASE = process.env.E2E_BASE_URL ?? 'https://d2mtgpa71y9c8t.cloudfront.net'
const OUT_DIR = '/tmp/orbital-onboarding-screenshots'
const TEST_EMAIL = process.env.E2E_EMAIL ?? 'smoketest+login@orbital.local'
const TEST_PASSWORD = process.env.E2E_PASSWORD ?? 'iO5MXE27g8pObTXanLhqAa1!'

const VIEWPORTS: Array<{ name: string; width: number; height: number }> = [
  { name: 'mobile', width: 375, height: 812 },
  { name: 'desktop', width: 1280, height: 900 },
]

function ensureDir() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
}

async function login(page: Page) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  // Login page structure: email, password, submit
  await page.locator('input[type="email"], input[name="email"], input[autocomplete="email"]').first().fill(TEST_EMAIL)
  await page.locator('input[type="password"]').first().fill(TEST_PASSWORD)
  await page.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in")').first().click()
  // Wait for either /welcome or /
  await page.waitForURL(/\/(welcome|$)/, { timeout: 15_000 }).catch(() => null)
}

async function snap(page: Page, slug: string, vp: string) {
  const file = path.join(OUT_DIR, `${slug}-${vp}.png`)
  await page.screenshot({ path: file, fullPage: true })
}

test.describe.configure({ mode: 'serial' })

for (const vp of VIEWPORTS) {
  test.describe(`viewport: ${vp.name} (${vp.width}px)`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } })

    test('login page', async ({ page }) => {
      ensureDir()
      await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
      await page.waitForTimeout(400)
      await snap(page, '01-login', vp.name)
    })

    test('signup page', async ({ page }) => {
      await page.goto(`${BASE}/signup`, { waitUntil: 'networkidle' })
      await page.waitForTimeout(400)
      await snap(page, '02-signup', vp.name)
    })

    test('welcome chooser', async ({ page }) => {
      await login(page)
      await page.goto(`${BASE}/welcome`, { waitUntil: 'networkidle' })
      await expect(page.locator('[data-testid="welcome-chooser"], [data-testid="resume-banner"]').first()).toBeVisible({ timeout: 10_000 })
      await page.waitForTimeout(600)
      await snap(page, '03-welcome', vp.name)
    })

    test('onboarding new-project basics', async ({ page }) => {
      await login(page)
      await page.goto(`${BASE}/welcome`, { waitUntil: 'networkidle' })
      // If a resume banner is showing, abandon and start fresh.
      const startOver = page.getByRole('button', { name: 'Start over' })
      if (await startOver.count()) {
        await startOver.click().catch(() => null)
        await page.waitForTimeout(500)
      }
      await page.locator('[data-testid="flow-card-new_project"]').click()
      await page.waitForTimeout(2_500)
      await snap(page, '10-new-project-basics', vp.name)
    })

    test('onboarding existing-repo connect', async ({ page }) => {
      await login(page)
      await page.goto(`${BASE}/welcome`, { waitUntil: 'networkidle' })
      const startOver = page.getByRole('button', { name: 'Start over' })
      if (await startOver.count()) {
        await startOver.click().catch(() => null)
        await page.waitForTimeout(500)
      }
      await page.locator('[data-testid="flow-card-existing_repo"]').click()
      await page.waitForTimeout(2_500)
      await snap(page, '11-existing-repo-connect', vp.name)
    })

    test('onboarding join-hub', async ({ page }) => {
      await login(page)
      await page.goto(`${BASE}/welcome`, { waitUntil: 'networkidle' })
      const startOver = page.getByRole('button', { name: 'Start over' })
      if (await startOver.count()) {
        await startOver.click().catch(() => null)
        await page.waitForTimeout(500)
      }
      await page.locator('[data-testid="flow-card-join_hub"]').click()
      await page.waitForTimeout(800)
      await snap(page, '12-join-hub', vp.name)
    })

    test('settings general', async ({ page }) => {
      await login(page)
      await page.goto(`${BASE}/settings/general`, { waitUntil: 'networkidle' })
      await page.waitForTimeout(600)
      await snap(page, '04-settings-general', vp.name)
    })

    test('settings integrations', async ({ page }) => {
      await login(page)
      await page.goto(`${BASE}/settings/integrations`, { waitUntil: 'networkidle' })
      await page.waitForTimeout(600)
      await snap(page, '05-settings-integrations', vp.name)
    })

    test('settings agents', async ({ page }) => {
      await login(page)
      await page.goto(`${BASE}/settings/agents`, { waitUntil: 'networkidle' })
      await page.waitForTimeout(600)
      await snap(page, '06-settings-agents', vp.name)
    })

    test('settings sprints', async ({ page }) => {
      await login(page)
      await page.goto(`${BASE}/settings/sprints`, { waitUntil: 'networkidle' })
      await page.waitForTimeout(600)
      await snap(page, '07-settings-sprints', vp.name)
    })

    test('settings team coming-soon', async ({ page }) => {
      await login(page)
      await page.goto(`${BASE}/settings/team`, { waitUntil: 'networkidle' })
      await page.waitForTimeout(600)
      await snap(page, '08-settings-team', vp.name)
    })

    test('settings billing coming-soon', async ({ page }) => {
      await login(page)
      await page.goto(`${BASE}/settings/billing`, { waitUntil: 'networkidle' })
      await page.waitForTimeout(600)
      await snap(page, '09-settings-billing', vp.name)
    })
  })
}
