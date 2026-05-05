import { chromium } from 'playwright'
const BASE = 'https://d2mtgpa71y9c8t.cloudfront.net'
const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await ctx.newPage()
await page.goto(`${BASE}/login`, { waitUntil: 'load' })
await page.locator('input#email').fill('smoketest+login@orbital.local')
await page.locator('input#password').fill('iO5MXE27g8pObTXanLhqAa1!')
await page.getByRole('button', { name: /sign in|log ?in/i }).click()
await page.waitForTimeout(4000)
await page.evaluate(() =>
  fetch('https://hhhfb8pid6.execute-api.us-east-1.amazonaws.com/trpc/onboarding.complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }),
)
await page.goto(`${BASE}/settings/general`, { waitUntil: 'load' })
await page.waitForTimeout(2500)

const tabs = ['integrations', 'agents', 'sprints', 'team', 'billing', 'general']
for (const t of tabs) {
  // Scope to the settings sidebar nav (aria-label="Settings sections") so we
  // don't accidentally click the global WORKFLOW > Agents link.
  const nav = page.locator('nav[aria-label="Settings sections"]')
  await nav.locator(`a[href="/settings/${t}"]`).click().catch(() => {})
  await page.waitForTimeout(1500)
  const url = page.url().split('?')[0].replace(BASE, '')
  console.log(`click ${t} → ${url} ${url === `/settings/${t}` ? 'OK' : 'BAD'}`)
}
await browser.close()
