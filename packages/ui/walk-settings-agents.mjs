/**
 * walk-settings-agents.mjs — verify the new /settings/agents page does what the
 * spec says: edit a persona's budget, blur, refresh, value persists. Toggle a
 * persona off, verify the row state.
 *
 * [Engineer-Principal · Opus · run-settings-agents]
 */
import { chromium } from 'playwright'

const BASE = 'https://d2mtgpa71y9c8t.cloudfront.net'
const EMAIL = 'smoketest+login@orbital.local'
const PASSWORD = 'iO5MXE27g8pObTXanLhqAa1!'

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await ctx.newPage()

const log = (...a) => console.log(...a)
page.on('console', (m) => m.type() === 'error' && log('[console-error]', m.text().slice(0, 200)))
page.on('response', (r) => {
  if (r.status() >= 400 && r.url().includes('/trpc/')) {
    log('[trpc-fail]', r.status(), r.url().split('?')[0].slice(-120))
  }
})

log('# Login')
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: 60000 })
await page.waitForSelector('input#email', { timeout: 30000 })
await page.locator('input#email').fill(EMAIL)
await page.locator('input#password').fill(PASSWORD)
await page.getByRole('button', { name: /sign in|log ?in/i }).click()
await page.waitForTimeout(4000)

log('# /settings/agents')
await page.goto(`${BASE}/settings/agents`, { waitUntil: 'networkidle', timeout: 60000 })
await page.waitForTimeout(3000)

// Find the row for sr-dev (Senior Developer) and inspect its budget input.
// Ensure persona table actually rendered (loading skeleton may show first).
await page.waitForFunction(
  () => Array.from(document.querySelectorAll('code')).some((el) => el.textContent === 'sr-dev'),
  { timeout: 30000 },
)
const srDevRow = page.locator('tr', { has: page.locator('code', { hasText: /^sr-dev$/ }) })
await srDevRow.first().waitFor({ timeout: 15000 })

const budgetInput = srDevRow.first().locator('input[type="number"]')
const beforeVal = await budgetInput.inputValue()
log(`  sr-dev budget before: $${beforeVal}`)

// Pick a value distinct from current.
const newDollarStr = beforeVal === '7.50' ? '8.50' : '7.50'
await budgetInput.fill(newDollarStr)
await budgetInput.blur()
log(`  set sr-dev budget to: $${newDollarStr}`)

// Wait for mutation to flush, then refresh.
await page.waitForTimeout(2500)
await page.reload({ waitUntil: 'networkidle', timeout: 60000 })
await page.waitForTimeout(3000)

const refreshedRow = page.locator('tr', { has: page.locator('code', { hasText: 'sr-dev' }) })
await refreshedRow.first().waitFor({ timeout: 15000 })
const afterVal = await refreshedRow.first().locator('input[type="number"]').inputValue()
log(`  sr-dev budget after refresh: $${afterVal}`)

const persisted = afterVal === newDollarStr
log(`  PERSISTED: ${persisted ? 'YES' : 'NO'}`)

// Now toggle PM persona enabled checkbox off, verify state persists.
const pmRow = page.locator('tr', { has: page.locator('code', { hasText: /^pm$/ }) }).first()
await pmRow.waitFor({ timeout: 10000 })
const pmCheckbox = pmRow.locator('input[type="checkbox"]')
const beforeChecked = await pmCheckbox.isChecked()
log(`  pm enabled before: ${beforeChecked}`)
await pmCheckbox.click()
await page.waitForTimeout(2500)
await page.reload({ waitUntil: 'networkidle', timeout: 60000 })
await page.waitForTimeout(3000)
const afterChecked = await page
  .locator('tr', { has: page.locator('code', { hasText: /^pm$/ }) })
  .first()
  .locator('input[type="checkbox"]')
  .isChecked()
log(`  pm enabled after refresh: ${afterChecked}`)
const toggled = afterChecked === !beforeChecked
log(`  TOGGLED: ${toggled ? 'YES' : 'NO'}`)

// Restore pm to its original state so we don't pollute the env.
if (toggled) {
  await page
    .locator('tr', { has: page.locator('code', { hasText: /^pm$/ }) })
    .first()
    .locator('input[type="checkbox"]')
    .click()
  await page.waitForTimeout(2000)
}

await browser.close()

if (!persisted || !toggled) {
  console.error('FAIL: persistence walk did not pass')
  process.exit(1)
}
log('# OK — budget edit + enabled toggle both persisted')
