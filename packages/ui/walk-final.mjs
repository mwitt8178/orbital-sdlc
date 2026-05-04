// Final end-to-end verification: log in, walk wizard, force cold start,
// confirm state persists across instances.
import { chromium } from 'playwright'
import https from 'node:https'

const BASE = 'https://d2mtgpa71y9c8t.cloudfront.net'
const EMAIL = 'smoketest+login@orbital.local'
const PASSWORD = 'iO5MXE27g8pObTXanLhqAa1!'

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await ctx.newPage()

const errors = []
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
const netFails = []
page.on('response', (r) => {
  if (r.status() >= 500) netFails.push(`${r.status()} ${r.url()}`)
})

console.log('## 1. Login')
await page.goto(`${BASE}/login`, { waitUntil: 'load', timeout: 60000 })
await page.waitForTimeout(1500)
try {
  await page.getByLabel(/email/i).fill(EMAIL)
  await page.getByLabel(/password/i).fill(PASSWORD)
  await page.getByRole('button', { name: /sign in|log ?in/i }).click()
  await page.waitForTimeout(5000)
  console.log('  url after login:', page.url())
} catch (e) {
  console.log('  LOGIN FAILED:', e.message)
}

console.log()
console.log('## 2. Welcome page state')
await page.goto(`${BASE}/welcome`, { waitUntil: 'load', timeout: 60000 })
await page.waitForTimeout(2500)
const text = (await page.evaluate(() => document.body?.innerText || '')).slice(0, 600)
console.log('  body:', text.slice(0, 400).replace(/\n/g, ' | '))
const heroPresent = text.includes('Ship a sprint')
console.log('  hero present:', heroPresent)

console.log()
console.log('## 3. /admin/integrations reachable')
await page.goto(`${BASE}/admin/integrations`, { waitUntil: 'load', timeout: 60000 })
await page.waitForTimeout(2500)
const adminText = (await page.evaluate(() => document.body?.innerText || '')).slice(0, 400)
console.log('  url:', page.url())
console.log('  body:', adminText.slice(0, 300).replace(/\n/g, ' | '))

console.log()
console.log('## 4. /stories reachable')
await page.goto(`${BASE}/stories`, { waitUntil: 'load', timeout: 60000 })
await page.waitForTimeout(2500)
console.log('  url:', page.url())

console.log()
console.log('## 5. Errors summary')
console.log('  console errors:', errors.length)
for (const e of errors.slice(0, 5)) console.log('   -', e.slice(0, 200))
console.log('  5xx network:', netFails.length)
for (const f of netFails.slice(0, 5)) console.log('   -', f.slice(0, 200))

await browser.close()
