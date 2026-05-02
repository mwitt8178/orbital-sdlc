/**
 * E2E smoke checks for Round 4 cross-cutting UX:
 *   - Settings page renders all 7 tabs
 *   - Command palette opens via ⌘K and exposes navigate items
 *   - Audit page exposes filter chips + decrypt-instructions trigger
 *   - Retro page has a System Versions tab
 */

import { test, expect } from '@playwright/test'

test.describe('Round 4 cross-cutting UX', () => {
  test('Settings: 7 tabs render', async ({ page }) => {
    await page.goto('/settings')
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
    for (const label of [
      'Personas',
      'Routing policy',
      'Hooks',
      'Ceremonies',
      'Backups',
      'Notifications',
      'Identity',
    ]) {
      await expect(page.getByRole('tab', { name: label })).toBeVisible()
    }
  })

  test('Settings tab switching updates content + hash', async ({ page }) => {
    await page.goto('/settings')
    await page.getByRole('tab', { name: 'Hooks' }).click()
    await expect(page).toHaveURL(/#hooks/)
    await expect(page.getByText('post-task-trigger-verifier')).toBeVisible()
  })

  test('Command palette opens via Cmd+K and lists Navigate commands', async ({ page }) => {
    await page.goto('/')
    // Ensure the page has keyboard focus before sending the shortcut.
    await page.locator('body').click()
    const shortcut = process.platform === 'darwin' ? 'Meta+K' : 'Control+K'
    await page.keyboard.press(shortcut)
    const dialog = page.getByRole('dialog', { name: 'Command palette' })
    await expect(dialog).toBeVisible()
    await page.keyboard.type('vis')
    await expect(dialog.getByText(/Vision Intake/)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()
  })

  test('Command palette opens via TopBar button', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: /Open command palette/i }).click()
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible()
  })

  test('Audit page renders filter chips and decrypt-instructions trigger', async ({ page }) => {
    await page.goto('/audit')
    await expect(page.getByText('Aggregate type')).toBeVisible()
    await expect(page.getByText('Date range')).toBeVisible()
    await expect(page.getByText('Actor type')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Decrypt instructions' })).toBeVisible()
  })

  test('Decrypt instructions modal opens and shows the npm and openssl snippets', async ({ page }) => {
    await page.goto('/audit')
    await page.getByRole('button', { name: 'Decrypt instructions' }).click()
    const dialog = page.getByRole('dialog', { name: 'Decrypt an audit export' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText(/npm run restore/)).toBeVisible()
    await expect(dialog.getByText(/openssl enc -d/)).toBeVisible()
  })

  test('Retro page has System Versions tab and switches', async ({ page }) => {
    await page.goto('/retro')
    await expect(page.getByRole('tab', { name: 'System Versions' })).toBeVisible()
    await page.getByRole('tab', { name: 'System Versions' }).click()
  })

  test('Sidebar Settings link navigates to /settings', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: 'Settings' }).click()
    await expect(page).toHaveURL(/\/settings/)
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  })
})
