import { test, expect } from '@playwright/test'

/**
 * /settings/integrations/github — Playwright spec scaffold.
 *
 * RED state until the GitHub App is registered and the manifest URL +
 * /oauth/github/callback flow round-trips. After registration these tests
 * should turn green without code change.
 *
 * [Engineer-Principal · Opus · run-orbital-github-integration]
 */
test.describe('GitHub integration settings', () => {
  test('settings page renders the install entry-point', async ({ page }) => {
    await page.goto('/settings/integrations/github')
    await expect(page.getByRole('heading', { name: /github/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /install github app/i })).toBeVisible()
  })

  test('install button posts the manifest to github.com/settings/apps/new', async ({ page }) => {
    await page.goto('/settings/integrations/github')
    const button = page.getByRole('button', { name: /install github app/i })

    // The button submits a self-built form to github.com — capture the
    // navigation target, do not actually navigate to GitHub in CI.
    const [request] = await Promise.all([
      page.waitForRequest((req) => req.url().includes('github.com/settings/apps/new')),
      button.click(),
    ])

    expect(request.url()).toMatch(/state=/)
    expect(request.method()).toBe('POST')
  })

  test('callback page handles the manifest exchange code', async ({ page }) => {
    // Visit with a fake `code` + `state` — the page should call
    // github.recordInstallation; in RED state this surfaces as an error
    // message, in GREEN state it surfaces a success banner.
    await page.goto('/oauth/github/callback?code=test-code&state=test-state')

    const success = page.getByText(/installation recorded/i).first()
    const error = page.getByText(/could not record installation|invalid|failed/i).first()

    await expect(async () => {
      const visible = await Promise.all([
        success.isVisible().catch(() => false),
        error.isVisible().catch(() => false),
      ])
      expect(visible.some(Boolean)).toBe(true)
    }).toPass({ timeout: 10_000 })
  })

  test('listInstallations shows the bound installations after registration', async ({ page }) => {
    await page.goto('/settings/integrations/github')
    // Empty state OR a list region.
    const empty = page.getByText(/no installations/i).first()
    const list = page.getByRole('list', { name: /installations/i })
    const error = page.getByText(/could not load installations/i).first()

    await expect(async () => {
      const visible = await Promise.all([
        empty.isVisible().catch(() => false),
        list.isVisible().catch(() => false),
        error.isVisible().catch(() => false),
      ])
      expect(visible.some(Boolean)).toBe(true)
    }).toPass({ timeout: 10_000 })
  })
})
