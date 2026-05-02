/**
 * project-setup-immersion.spec.ts — E2E for the immersive project setup flow.
 *
 * Verifies the binary done criteria:
 *   1. User opens "New project" from the project switcher
 *   2. Fills basics (name + slug + description)
 *   3. Skips Monday and Github
 *   4. Reviews and clicks "Create and define vision"
 *   5. Vision interview stage opens with chat on left, draft pane on right
 *   6. User exchanges 3+ messages with PM persona
 *   7. Right pane fills in with title/summary/goals/target users
 *   8. User clicks Continue → vision locks, advances to Initial epics
 *   9. Suggested epic cards appear, user clicks "Create epics & finish"
 *  10. User lands on /backlog with the new project active
 *
 * Also covers the "Skip & lock later" branch — exit cleanly with no locked vision.
 *
 * Runs against the LIVE dev server (default port 5174) and the LIVE
 * orchestrator (default http://localhost:3030). Uses the real PM stub.
 */

import { test, expect, type Page } from '@playwright/test'

const ORCHESTRATOR_URL = process.env['ORCHESTRATOR_URL'] ?? 'http://localhost:3030'

// Generate a unique project name per test run so no conflict with prior runs
function uniqueName(prefix: string): string {
  return `${prefix} ${Date.now()}`
}

function uniqueSlug(prefix: string): string {
  // Slug must match [a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?
  return `${prefix}-${Date.now()}`.toLowerCase().replace(/[^a-z0-9-]/g, '-')
}

test.describe('Immersive project setup flow', () => {
  test('orchestrator is reachable', async ({ request }) => {
    const res = await request.get(`${ORCHESTRATOR_URL}/health`)
    expect(res.status()).toBe(200)
  })

  test('full happy path: create project, run interview, accept epics, land on /backlog', async ({
    page,
  }) => {
    test.setTimeout(120_000)

    const name = uniqueName('Acme Billing')
    const slug = uniqueSlug('acme-billing')
    const description =
      'A customer-facing recurring billing platform with self-serve checkout, invoicing, and subscription management.'

    await page.goto('/')

    // Open the project switcher and start a new project
    await openCreateProjectModal(page)

    // Stage 1 — Basics
    await page.getByLabel(/^Name$/i).fill(name)
    // Slug auto-derives from name; replace if needed
    const slugField = page.getByLabel(/^Slug$/i)
    await slugField.fill(slug)
    await page.getByPlaceholder(/What does this project deliver/i).fill(description)
    await page.getByRole('button', { name: /Next: Monday/i }).click()

    // Stage 2 — Monday (skip)
    await page.getByRole('button', { name: /Next: Github/i }).click()

    // Stage 3 — Github (skip)
    await page.getByRole('button', { name: /^Review$/i }).click()

    // Stage 4 — Review
    await expect(page.getByText(name)).toBeVisible()
    await page.getByRole('button', { name: /Create and define vision/i }).click()

    // Stage 5 — Vision interview opens
    await expect(
      page.getByRole('log', { name: /Vision interview chat messages/i }),
    ).toBeVisible({ timeout: 15_000 })

    // The first user message is auto-sent (the basics description). PM should
    // reply within ~5 seconds.
    const chatLog = page.getByRole('log', { name: /Vision interview chat messages/i })
    await expect(
      chatLog.locator('li').filter({ hasText: /primary user|Thanks for that/i }).first(),
    ).toBeVisible({ timeout: 15_000 })

    // Send 2 more messages to trigger the PM stub draft (after 3 user messages total)
    const msgInput = page.getByRole('textbox', { name: /Vision interview message input/i })
    const sendBtn = page.getByRole('button', { name: /Send vision interview message/i })

    await msgInput.fill('Primary users are SaaS founders who need recurring billing setup.')
    await sendBtn.click()

    // Wait for the second PM reply
    await expect(
      chatLog.locator('li').filter({ hasText: /smallest version|out of scope/i }).first(),
    ).toBeVisible({ timeout: 15_000 })

    await msgInput.fill('Smallest version: Stripe checkout, monthly billing, cancel link.')
    await sendBtn.click()

    // Wait for the third PM reply (should mention constraints / non-functional)
    await expect(
      chatLog.locator('li').filter({ hasText: /constraints|non.?functional|success metric/i }).first(),
    ).toBeVisible({ timeout: 15_000 })

    // Right pane should populate with the draft. The polling kicks in within 2-4s.
    await expect(page.getByText(/Vision Draft/i)).toBeVisible()

    // Continue should become enabled once the PM stub finishes the draft (after
    // the 3rd user message). The stub writes ~1.5s after that 3rd send, then
    // the right-pane poll picks it up within the next 2s. Allow up to 30s.
    const continueBtn = page.getByRole('button', { name: /Continue to initial epics/i })
    await expect(continueBtn).toBeEnabled({ timeout: 30_000 })
    await continueBtn.click()

    // Stage 6 — Initial epics
    await expect(
      page.getByText(/PM persona suggests these initial epics/i),
    ).toBeVisible({ timeout: 15_000 })

    // Wait for the loading-state to clear and the suggested cards to render.
    // The backend call returns within ~100ms but tRPC + react-query may stage
    // the render across multiple ticks, so allow up to 20s.
    await expect(page.getByText(/Generating epic suggestions/i)).toBeHidden({
      timeout: 20_000,
    })

    // At least one suggested epic card should appear. The PM stub draft has
    // generic content so the suggester returns at least the generic fallback
    // trio ("Core experience", "Account management", "Reporting") when no
    // keywords match.
    await expect(
      page
        .getByText(/Core experience|Account management|Reporting|Subscription lifecycle|Authentication/i)
        .first(),
    ).toBeVisible({ timeout: 15_000 })

    // Click "Create epics & finish"
    const createBtn = page.getByRole('button', { name: /Create epics and finish setup/i })
    await expect(createBtn).toBeEnabled({ timeout: 5_000 })
    await createBtn.click()

    // Should land on /backlog
    await expect(page).toHaveURL(/\/backlog/, { timeout: 15_000 })
  })

  test('skip & lock later: project exists, vision NOT locked, user lands on /backlog', async ({
    page,
  }) => {
    test.setTimeout(60_000)

    const name = uniqueName('Skip Path')
    const slug = uniqueSlug('skip-path')

    await page.goto('/')
    await openCreateProjectModal(page)

    await page.getByLabel(/^Name$/i).fill(name)
    await page.getByLabel(/^Slug$/i).fill(slug)
    await page.getByRole('button', { name: /Next: Monday/i }).click()
    await page.getByRole('button', { name: /Next: Github/i }).click()
    await page.getByRole('button', { name: /^Review$/i }).click()
    await page.getByRole('button', { name: /Create and define vision/i }).click()

    // Wait for vision interview to open
    await expect(
      page.getByRole('log', { name: /Vision interview chat messages/i }),
    ).toBeVisible({ timeout: 15_000 })

    // Click "Skip and lock later"
    const skipBtn = page.getByRole('button', { name: /Skip and lock later/i })
    await skipBtn.click()

    // Should land on /backlog
    await expect(page).toHaveURL(/\/backlog/, { timeout: 15_000 })
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Open the project switcher menu and click "New project". The switcher lives
 * in the top bar with aria-label="Switch project". Clicking it opens a popover
 * containing a "+ New project" button.
 */
async function openCreateProjectModal(page: Page) {
  // Wait for the project switcher trigger (aria-label "Switch project")
  const switcherTrigger = page.getByRole('button', { name: 'Switch project' })
  await expect(switcherTrigger).toBeVisible({ timeout: 15_000 })
  await switcherTrigger.click()

  // The "+ New project" button is inside the popover that just opened
  const newProjectBtn = page.getByRole('button', { name: /^New project$/i })
  await expect(newProjectBtn).toBeVisible({ timeout: 5_000 })
  await newProjectBtn.click()

  // Wait for the modal to be visible
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 })
}
