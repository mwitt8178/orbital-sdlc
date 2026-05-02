import { test, expect } from '@playwright/test'

/**
 * Admin route E2E.
 *
 * The orchestrator may or may not be running. Each tab calls a real
 * admin.* tRPC procedure but the page must degrade gracefully:
 *   - read-only queries that fail surface as ErrorMessage
 *   - the layout (header, tab nav, danger styling) renders regardless
 */
test.describe('Admin', () => {
  test('default route renders the operations console heading', async ({ page }) => {
    await page.goto('/admin')
    await expect(page.locator('h1', { hasText: 'Operations console' })).toBeVisible()
  })

  test('all six tabs are present', async ({ page }) => {
    await page.goto('/admin')
    for (const label of ['Health', 'Workers', 'Keys', 'Backups', 'Verify', 'Reset']) {
      await expect(page.getByRole('link', { name: label, exact: true })).toBeVisible()
    }
  })

  test('Health tab shows subsystems region', async ({ page }) => {
    await page.goto('/admin')
    // Either the Subsystems heading OR an ErrorMessage is visible.
    const subsystems = page.getByRole('heading', { name: 'Subsystems' })
    const error = page.getByText('Could not load health').first()
    await expect(async () => {
      const visible = await Promise.all([
        subsystems.isVisible().catch(() => false),
        error.isVisible().catch(() => false),
      ])
      expect(visible.some(Boolean)).toBe(true)
    }).toPass({ timeout: 10_000 })
  })

  test('Workers tab navigates and renders a list region or empty state', async ({ page }) => {
    await page.goto('/admin/workers')
    const empty = page.getByText('No workers').first()
    const heading = page.getByRole('columnheader', { name: 'Persona' })
    const error = page.getByText('Could not load workers').first()
    await expect(async () => {
      const visible = await Promise.all([
        empty.isVisible().catch(() => false),
        heading.isVisible().catch(() => false),
        error.isVisible().catch(() => false),
      ])
      expect(visible.some(Boolean)).toBe(true)
    }).toPass({ timeout: 10_000 })
  })

  test('Keys tab shows Master keys section', async ({ page }) => {
    await page.goto('/admin/keys')
    const masters = page.getByRole('heading', { name: 'Master keys' })
    const rotateBtn = page.getByRole('button', { name: 'Rotate active sub-key' })
    await expect(async () => {
      const visible = await Promise.all([
        masters.isVisible().catch(() => false),
        rotateBtn.isVisible().catch(() => false),
      ])
      expect(visible.some(Boolean)).toBe(true)
    }).toPass({ timeout: 10_000 })
  })

  test('Backups tab shows Run backup now button', async ({ page }) => {
    await page.goto('/admin/backups')
    const button = page.getByRole('button', { name: 'Run backup now' })
    await expect(button).toBeVisible({ timeout: 10_000 })
  })

  test('Verify tab shows the input form', async ({ page }) => {
    await page.goto('/admin/verify')
    const input = page.getByLabel('Capability ID (UUID) or commit hash')
    await expect(input).toBeVisible({ timeout: 10_000 })
  })

  test('Reset tab shows danger zone with disabled button until phrase typed', async ({
    page,
  }) => {
    await page.goto('/admin/reset')
    const dangerHeading = page.getByRole('heading', { name: 'Danger zone' })
    await expect(dangerHeading).toBeVisible({ timeout: 10_000 })

    const resetBtn = page.getByRole('button', { name: 'Reset everything' })
    await expect(resetBtn).toBeDisabled()

    const phraseInput = page.getByLabel('Confirmation phrase')
    await phraseInput.fill('I understand this destroys everything')
    await expect(resetBtn).toBeEnabled()
  })

  test('admin token badge toggles visibility', async ({ page }) => {
    await page.goto('/admin')
    const setTokenBtn = page.getByRole('button', { name: /Set admin token|Admin token: set/ })
    await expect(setTokenBtn).toBeVisible({ timeout: 10_000 })
    await setTokenBtn.click()
    const tokenInput = page.locator('input[placeholder="x-orbital-admin-token"]')
    await expect(tokenInput).toBeVisible()
  })
})
