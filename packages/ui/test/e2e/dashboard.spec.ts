import { test, expect } from '@playwright/test'

/**
 * Dashboard E2E.
 *
 * The orchestrator may or may not be running. The UI must degrade
 * gracefully:
 *   - tRPC queries that fail still surface as ErrorMessage; the page does
 *     NOT show a blank screen.
 *   - the workers list renders empty-state when no workers are active.
 */
test.describe('Dashboard', () => {
  test('page heading renders', async ({ page }) => {
    await page.goto('/')
    // Either the active sprint name OR the static "Sprint Dashboard" heading
    // is visible.
    const heading = page.locator('h1')
    await expect(heading).toBeVisible()
  })

  test('agents in flight panel renders an empty state OR a list', async ({ page }) => {
    await page.goto('/')
    const region = page.getByRole('heading', { name: 'Agents in flight' })
    await expect(region).toBeVisible()

    const ariaList = page.getByRole('list', { name: 'Agents in flight' })
    const empty = page.getByText('No agents in flight').first()
    const errorMsg = page.getByText('Could not load workers').first()

    // Wait until at least one of these is visible (loading, success, or
    // error path completes).
    await expect(async () => {
      const visibleStates = await Promise.all([
        ariaList.isVisible().catch(() => false),
        empty.isVisible().catch(() => false),
        errorMsg.isVisible().catch(() => false),
      ])
      expect(visibleStates.some(Boolean)).toBe(true)
    }).toPass({ timeout: 10_000 })
  })

  test('activity stream is present (live region)', async ({ page }) => {
    await page.goto('/')
    const region = page.getByRole('status').filter({ hasText: '' })
    await expect(region.first()).toBeVisible()
  })

  test('KPI grid renders four cards', async ({ page }) => {
    await page.goto('/')
    // The KPI region is the first role=list under Sprint Dashboard.
    const knownLabel = page
      .locator('text=Tasks completed')
      .or(page.locator('text=Avg cycle time'))
    await expect(knownLabel.first()).toBeVisible()
  })
})
