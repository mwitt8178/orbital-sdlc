// Focused walk: open project switcher, click "+ New project", fill the
// quick-create modal, submit, verify the new project appears in the switcher
// list and is set as active.
import { chromium } from 'playwright'

const BASE = 'https://d2mtgpa71y9c8t.cloudfront.net'
const EMAIL = 'smoketest+login@orbital.local'
const PASSWORD = 'iO5MXE27g8pObTXanLhqAa1!'

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await ctx.newPage()

const consoleErrors = []
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200))
})

console.log('# Login')
await page.goto(`${BASE}/login`, { waitUntil: 'load', timeout: 60000 })
await page.waitForTimeout(1500)
await page.getByLabel(/email/i).fill(EMAIL)
await page.getByLabel(/password/i).fill(PASSWORD)
await page.getByRole('button', { name: /sign in|log ?in/i }).click()
await page.waitForTimeout(5000)
await page.evaluate(async () => {
  await fetch('https://hhhfb8pid6.execute-api.us-east-1.amazonaws.com/trpc/onboarding.complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
})
console.log('  setup forced complete')
await page.goto(`${BASE}/`, { waitUntil: 'load', timeout: 30000 })
await page.waitForTimeout(3000)

console.log('# Open switcher')
const switcherBtn = page.getByTestId('project-switcher-name')
await switcherBtn.waitFor({ timeout: 10000 })
const beforeName = (await switcherBtn.textContent())?.trim() ?? ''
console.log('  active before: ' + beforeName)
await switcherBtn.click()
await page.waitForTimeout(300)

console.log('# Click "New project"')
await page.getByRole('button', { name: /new project/i }).click()
await page.waitForTimeout(500)
await page.screenshot({ path: 'create-step1.png' })

console.log('# Modal — fill basics')
const uniq = `walk${Date.now().toString().slice(-6)}`
const projectName = 'Walk Test ' + uniq
await page.getByLabel(/^name$/i).fill(projectName)
await page.waitForTimeout(200)
await page.getByRole('button', { name: /^review$/i }).click()
await page.waitForTimeout(400)
await page.screenshot({ path: 'create-step2.png' })

console.log('# Modal — submit')
await page.getByRole('button', { name: /create project/i }).click()
await page.waitForTimeout(4000)
await page.screenshot({ path: 'create-after.png' })

const url = page.url()
console.log('  current url: ' + url)

const afterName = (await page.getByTestId('project-switcher-name').textContent())?.trim() ?? ''
console.log('  active after: ' + afterName)

await page.getByTestId('project-switcher-name').click()
await page.waitForTimeout(300)
const text = (await page.locator('[role=menu]').textContent()) ?? ''
const found = text.toLowerCase().includes(projectName.toLowerCase())
console.log('  switcher list contains new project: ' + (found ? 'YES' : 'NO'))

console.log('# Console errors observed: ' + consoleErrors.length)
for (const e of consoleErrors.slice(0, 5)) console.log('  - ' + e.slice(0, 200))

const ok = afterName === projectName && found
console.log()
console.log(ok ? 'PASS' : 'FAIL')
await browser.close()
process.exit(ok ? 0 : 1)
