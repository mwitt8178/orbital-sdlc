import { test, expect } from '@playwright/test'

/**
 * Backlog page E2E (post AI-pivot).
 *
 * The orchestrator may or may not be running. The UI must degrade gracefully:
 *   - Header always renders ("Backlog — Tickets visualized").
 *   - VisionSummaryHeader either shows the vision card OR the "lock your
 *     vision first" CTA — both are valid first-render states.
 *   - The NL ticket creator is the primary creation surface (chat-style
 *     input at the top of the epic list).
 *   - "Manual ▾" menu opens, listing only "Epic" (bugs/stories go through NL).
 *   - The full BacklogFilters bar (status / sprint / epic chips) is gone;
 *     a single search input replaces it.
 *   - Sprint panel renders an empty state OR a list when sprints exist.
 *   - The page does NOT show a blank screen on tRPC failure.
 */

test.describe('Backlog (AI-pivot)', () => {
  test('page heading + scope hint copy renders', async ({ page }) => {
    await page.goto('/backlog')
    await expect(page.getByRole('heading', { name: /^Backlog/, level: 1 })).toBeVisible()
    // Scope hint copy that distinguishes Orbital from Monday
    await expect(page.getByText(/orchestration metadata Monday can.t show/i)).toBeVisible()
  })

  test('vision summary or lock-vision-first CTA is shown', async ({ page }) => {
    await page.goto('/backlog')

    const summaryTitle = page.getByTestId('vision-summary-title')
    const lockCta = page.getByText('Lock your vision first')

    await expect(async () => {
      const visible = await Promise.all([
        summaryTitle.isVisible().catch(() => false),
        lockCta.isVisible().catch(() => false),
      ])
      expect(visible.some(Boolean)).toBe(true)
    }).toPass({ timeout: 10_000 })
  })

  test('NL ticket creator renders at the top of the page', async ({ page }) => {
    await page.goto('/backlog')
    const creator = page.getByTestId('nl-ticket-creator')
    await expect(creator).toBeVisible()
    const input = page.getByTestId('nl-ticket-creator-input')
    await expect(input).toBeVisible()
    // Submit button shows the arrow affordance
    await expect(page.getByTestId('nl-ticket-creator-submit')).toBeVisible()
  })

  test('NL input is autofocused on page load', async ({ page }) => {
    await page.goto('/backlog')
    const input = page.getByTestId('nl-ticket-creator-input')
    await expect(input).toBeFocused()
  })

  test('typing a story-language prompt and pressing Enter surfaces a proposal card', async ({
    page,
  }) => {
    await page.goto('/backlog')
    const input = page.getByTestId('nl-ticket-creator-input')
    await input.click()
    await input.fill('I want password reset via email')
    await input.press('Enter')

    // The proposal card may not surface if no orchestrator is running; the
    // assertion accepts either the proposal card OR an inline error toast.
    const proposal = page.getByTestId('nl-ticket-creator-proposal')
    const error = page.getByText(/Could not parse prompt/i)

    await expect(async () => {
      const seen = await Promise.all([
        proposal.isVisible().catch(() => false),
        error.isVisible().catch(() => false),
      ])
      expect(seen.some(Boolean)).toBe(true)
    }).toPass({ timeout: 10_000 })

    // If the proposal is visible, sanity check the populated title field.
    if (await proposal.isVisible().catch(() => false)) {
      const titleField = page.getByTestId('nl-ticket-creator-title')
      const value = await titleField.inputValue()
      expect(value.length).toBeGreaterThan(0)
      expect(value.toLowerCase()).toContain('password reset')
      // Discard so the next test starts from a clean state.
      await page.getByTestId('nl-ticket-creator-discard').click()
    }
  })

  test('Manual menu opens and lists Epic only (no Story / no Bug)', async ({ page }) => {
    await page.goto('/backlog')
    const button = page.getByTestId('backlog-manual-menu-button')
    await expect(button).toBeVisible()
    await button.click()

    const menu = page.getByTestId('backlog-manual-menu')
    await expect(menu).toBeVisible()
    await expect(menu.getByText('Epic', { exact: true })).toBeVisible()
    // Bugs and stories are removed from this menu — they go through the NL
    // creator now.
    await expect(menu.getByText('Story', { exact: true })).toHaveCount(0)
    await expect(menu.getByText('Bug', { exact: true })).toHaveCount(0)
  })

  test('clicking Manual → Epic opens the Create epic modal', async ({ page }) => {
    await page.goto('/backlog')
    await page.getByTestId('backlog-manual-menu-button').click()
    await page.getByTestId('backlog-manual-menu').getByText('Epic', { exact: true }).click()

    const modal = page.getByRole('dialog', { name: 'Create epic' })
    await expect(modal).toBeVisible()
    await expect(modal.getByLabel('Title')).toBeVisible()
    await expect(modal.getByLabel('Rationale')).toBeVisible()
  })

  test('search input replaces the old filter bar', async ({ page }) => {
    await page.goto('/backlog')
    const search = page.getByTestId('backlog-search-input')
    await expect(search).toBeVisible()
    await expect(search).toHaveAttribute('placeholder', /Search stories/i)

    // The full filter region (status chips, sprint dropdown, epic chips) is gone.
    await expect(page.getByRole('region', { name: 'Backlog filters' })).toHaveCount(0)
  })

  test('sprint panel is present (header visible)', async ({ page }) => {
    await page.goto('/backlog')
    await expect(page.getByRole('heading', { name: 'Sprints', level: 2 })).toBeVisible()
  })

  test('clicking outside closes the manual menu', async ({ page }) => {
    await page.goto('/backlog')
    await page.getByTestId('backlog-manual-menu-button').click()
    await expect(page.getByTestId('backlog-manual-menu')).toBeVisible()

    await page.locator('body').click({ position: { x: 10, y: 10 } })
    await expect(page.getByTestId('backlog-manual-menu')).not.toBeVisible()
  })
})
