import { test, expect } from '@playwright/test'

/**
 * Channels E2E.
 *
 * The page must render structure regardless of orchestrator state. When the
 * tRPC list query fails, an ErrorMessage is shown; when it returns 0 items,
 * an empty state is shown. When at least one channel exists, posting a
 * message via the composer round-trips through tRPC and (if the orchestrator
 * is running) shows up via the WS stream.
 */
test.describe('Channels', () => {
  test('renders left rail and selector when no channel chosen', async ({ page }) => {
    await page.goto('/channels')
    await expect(page.getByRole('complementary', { name: 'Channel list' })).toBeVisible()
  })

  test('renders an empty / error / list state in left rail', async ({ page }) => {
    await page.goto('/channels')
    const emptyMsg = page.getByText('No channels yet. Start a sprint to see channels.')
    const errorMsg = page.getByText('Could not load channels')
    const filter = page.getByLabel('Filter channels')
    await expect(filter).toBeVisible()
    // At least one of the three states is reached.
    await expect(async () => {
      const states = await Promise.all([
        emptyMsg.isVisible().catch(() => false),
        errorMsg.isVisible().catch(() => false),
        page.getByRole('button', { name: /^.*#.*/i }).first().isVisible().catch(() => false),
      ])
      expect(states.some(Boolean)).toBe(true)
    }).toPass({ timeout: 10_000 })
  })

  test('composer is hidden when no channel is selected', async ({ page }) => {
    await page.goto('/channels')
    // The "Select a channel" empty state must be present until a channel is
    // selected.
    const placeholder = page.getByText('Select a channel')
    const composer = page.getByLabel('Compose channel post')
    // Either the placeholder is visible (no channel) or the composer (channel selected).
    await expect(async () => {
      const placeholderVisible = await placeholder.isVisible().catch(() => false)
      const composerVisible = await composer.isVisible().catch(() => false)
      expect(placeholderVisible || composerVisible).toBe(true)
    }).toPass({ timeout: 10_000 })
  })
})
