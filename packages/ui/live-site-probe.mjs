// Live site probe — load the CloudFront URL in Playwright Chromium and
// capture every console error, every failed network request, the URL
// after a settle, and the page title.
import { chromium } from '@playwright/test'

const BASE = 'https://d2mtgpa71y9c8t.cloudfront.net'

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext()
const page = await ctx.newPage()

const consoleErrors = []
const failedRequests = []
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text())
})
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`))
page.on('requestfailed', (req) => {
  failedRequests.push(`${req.method()} ${req.url()} :: ${req.failure()?.errorText}`)
})
page.on('response', (resp) => {
  if (resp.status() >= 400) {
    failedRequests.push(`${resp.status()} ${resp.request().method()} ${resp.url()}`)
  }
})

console.log(`# Loading ${BASE}/`)
await page.goto(`${BASE}/`, { waitUntil: 'load', timeout: 60000 })

// Give SPA time to redirect/render.
await page.waitForTimeout(8000)

const url = page.url()
const title = await page.title()
const visibleText = (await page.evaluate(() => document.body.innerText)).slice(0, 800)

console.log('## URL after settle:', url)
console.log('## Title:', title)
console.log('## Visible text (first 800):')
console.log(visibleText)
console.log()
console.log('## Console errors (' + consoleErrors.length + '):')
for (const e of consoleErrors) console.log('  -', e)
console.log()
console.log('## Failed requests / >=400 (' + failedRequests.length + '):')
for (const f of failedRequests) console.log('  -', f)

await browser.close()
