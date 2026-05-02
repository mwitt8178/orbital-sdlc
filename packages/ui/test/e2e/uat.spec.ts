import { test, expect } from '@playwright/test'

/**
 * UAT E2E.
 *
 * Verifies that the page renders the story selector, the empty state when
 * no story is chosen, and the right-rail Defects panel.
 */
test.describe('UAT', () => {
  test('story selector renders', async ({ page }) => {
    await page.goto('/uat')
    await expect(page.getByLabel('Story under review')).toBeVisible()
  })

  test('shows empty state when no story chosen', async ({ page }) => {
    await page.goto('/uat')
    await expect(page.getByText('No story selected')).toBeVisible()
    await expect(page.getByText('Select a story to see defects.')).toBeVisible()
  })

  test('selecting empty option keeps empty state', async ({ page }) => {
    await page.goto('/uat')
    const selector = page.getByLabel('Story under review')
    await selector.selectOption({ label: 'Select a story…' })
    await expect(page.getByText('No story selected')).toBeVisible()
  })
})
