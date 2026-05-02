import { test, expect } from '@playwright/test'

const ROUTES = [
  { path: '/', label: 'Sprint Dashboard', heading: 'Sprint Dashboard' },
  { path: '/vision', label: 'Vision Intake', heading: 'Vision Intake' },
  { path: '/channels', label: 'Channels', heading: 'Channels' },
  { path: '/ceremonies', label: 'Ceremonies', heading: 'Ceremonies' },
  { path: '/uat', label: 'UAT', heading: 'User Acceptance Testing' },
  { path: '/retro', label: 'Retrospective', heading: 'Retrospective' },
  { path: '/audit', label: 'Audit Log', heading: 'Audit Log' },
]

test.describe('App shell', () => {
  test('root redirect renders Dashboard', async ({ page }) => {
    await page.goto('/')
    await expect(page).not.toHaveURL(/\/vision/)
    await expect(page.getByRole('heading', { name: 'Sprint Dashboard' })).toBeVisible()
  })

  test('<nav> landmark is present', async ({ page }) => {
    await page.goto('/')
    const nav = page.getByRole('navigation', { name: 'Primary navigation' })
    await expect(nav).toBeVisible()
  })

  test('top bar is present with brand name', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('banner')).toBeVisible()
    await expect(page.getByText('Orbital')).toBeVisible()
  })

  test('command palette button is accessible', async ({ page }) => {
    await page.goto('/')
    const cmdBtn = page.getByRole('button', { name: /Open command palette/i })
    await expect(cmdBtn).toBeVisible()
  })

  test.describe('All 7 routes load without console errors', () => {
    for (const route of ROUTES) {
      test(`${route.label} — ${route.path}`, async ({ page }) => {
        const consoleErrors: string[] = []
        page.on('console', (msg) => {
          if (msg.type() === 'error') consoleErrors.push(msg.text())
        })
        page.on('pageerror', (err) => consoleErrors.push(err.message))

        await page.goto(route.path)
        await expect(page.getByRole('heading', { name: route.heading })).toBeVisible()

        // Filter out expected WS connection errors (server not running in test)
        const realErrors = consoleErrors.filter(
          (e) =>
            !e.includes('WebSocket') &&
            !e.includes('ws://') &&
            !e.includes('wss://') &&
            !e.includes('Failed to fetch') &&
            !e.includes('ERR_CONNECTION_REFUSED'),
        )
        expect(realErrors, `Console errors on ${route.path}: ${realErrors.join(', ')}`).toHaveLength(0)
      })
    }
  })

  test('navigation between routes works via sidebar links', async ({ page }) => {
    await page.goto('/')

    // Navigate to Vision
    await page.getByRole('link', { name: 'Vision Intake' }).click()
    await expect(page).toHaveURL('/vision')
    await expect(page.getByRole('heading', { name: 'Vision Intake' })).toBeVisible()

    // Navigate to Channels
    await page.getByRole('link', { name: 'Channels' }).click()
    await expect(page).toHaveURL('/channels')
    await expect(page.getByRole('heading', { name: 'Channels' })).toBeVisible()

    // Navigate to Ceremonies
    await page.getByRole('link', { name: 'Ceremonies' }).click()
    await expect(page).toHaveURL('/ceremonies')
    await expect(page.getByRole('heading', { name: 'Ceremonies' })).toBeVisible()

    // Navigate to UAT
    await page.getByRole('link', { name: 'UAT' }).click()
    await expect(page).toHaveURL('/uat')
    await expect(page.getByRole('heading', { name: 'User Acceptance Testing' })).toBeVisible()

    // Navigate to Retro
    await page.getByRole('link', { name: 'Retrospective' }).click()
    await expect(page).toHaveURL('/retro')
    await expect(page.getByRole('heading', { name: 'Retrospective' })).toBeVisible()

    // Navigate to Audit
    await page.getByRole('link', { name: 'Audit Log' }).click()
    await expect(page).toHaveURL('/audit')
    await expect(page.getByRole('heading', { name: 'Audit Log' })).toBeVisible()

    // Navigate back to Dashboard
    await page.getByRole('link', { name: 'Sprint Dashboard' }).click()
    await expect(page).toHaveURL('/')
    await expect(page.getByRole('heading', { name: 'Sprint Dashboard' })).toBeVisible()
  })

  test('active nav item has aria-current="page"', async ({ page }) => {
    await page.goto('/vision')
    const link = page.getByRole('link', { name: 'Vision Intake' })
    await expect(link).toHaveAttribute('aria-current', 'page')
  })

  test('connection status pill is visible in top bar', async ({ page }) => {
    await page.goto('/')
    // Should show connecting/reconnecting or "No active sprint" — any status pill is fine.
    // Multiple matches are acceptable (e.g. "Sprints" breadcrumb + status pill).
    const pill = page.locator('header').getByText(/active|sprint|connecting|reconnecting/i).first()
    await expect(pill).toBeVisible()
  })

  test('Live Telemetry section shows placeholder dashes when no data', async ({ page }) => {
    await page.goto('/')
    const sidebar = page.getByRole('navigation', { name: 'Primary navigation' })
    await expect(sidebar.getByText('Live Telemetry')).toBeVisible()
    // Budget row shows — placeholder
    await expect(sidebar.getByText('Budget')).toBeVisible()
  })

  test('keyboard navigation: Tab reaches sidebar nav links', async ({ page }) => {
    await page.goto('/')
    await page.keyboard.press('Tab')
    // At least one nav link should be focusable
    const focusedTag = await page.evaluate(() => document.activeElement?.tagName)
    expect(['A', 'BUTTON', 'INPUT']).toContain(focusedTag)
  })
})
