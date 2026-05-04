// Walk every post-onboarding route as the test user. Print status per route.
import { chromium } from 'playwright'

const BASE = 'https://d2mtgpa71y9c8t.cloudfront.net'
const EMAIL = 'smoketest+login@orbital.local'
const PASSWORD = 'iO5MXE27g8pObTXanLhqAa1!'

const ROUTES = [
  '/',
  '/welcome',
  '/backlog',
  '/vision',
  '/stories',
  '/channels',
  '/ceremonies',
  '/uat',
  '/retro',
  '/audit',
  '/memory',
  '/agents',
  '/cost',
  '/settings/general',
  '/settings/integrations',
  '/settings/agents',
  '/settings/sprints',
  '/settings/team',
  '/settings/billing',
  '/admin',
  '/admin/integrations',
]

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await ctx.newPage()

let consoleErrors = []
let httpErrors = []
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text().slice(0, 200)))
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message.slice(0, 200)}`))
page.on('response', (r) => {
  const u = r.url()
  if (r.status() >= 400 && (u.includes('/trpc/') || u.includes('execute-api'))) {
    httpErrors.push(`${r.status()} ${r.request().method()} ${u.split('?')[0].slice(-120)}`)
  }
})

console.log('# Login')
await page.goto(`${BASE}/login`, { waitUntil: 'load', timeout: 60000 })
await page.waitForTimeout(1500)
await page.getByLabel(/email/i).fill(EMAIL)
await page.getByLabel(/password/i).fill(PASSWORD)
await page.getByRole('button', { name: /sign in|log ?in/i }).click()
await page.waitForTimeout(5000)
console.log('  url after login:', page.url())

const results = []

for (const r of ROUTES) {
  consoleErrors = []
  httpErrors = []
  try {
    await page.goto(`${BASE}${r}`, { waitUntil: 'load', timeout: 25000 })
    await page.waitForTimeout(2500)
  } catch (e) {
    results.push({ route: r, status: 'load-fail', error: e.message.slice(0, 150) })
    continue
  }
  const url = page.url()
  const text = (await page.evaluate(() => document.body?.innerText || '').catch(() => '')).slice(0, 500)
  const lc = text.toLowerCase()
  const hasErrorWord =
    lc.includes('error') || lc.includes('something went wrong') || lc.includes('could not load') ||
    lc.includes('not found') || lc.includes('failed to')
  const isEmpty = text.trim().length < 30
  const redirected = !url.endsWith(r) && !url.endsWith(r + '/')
  let status
  if (consoleErrors.length > 0 || httpErrors.length > 0) status = 'error'
  else if (hasErrorWord) status = 'error-text'
  else if (redirected && url.includes('/welcome')) status = 'gated-welcome'
  else if (redirected && url.includes('/login')) status = 'gated-login'
  else if (isEmpty) status = 'empty'
  else status = 'ok'
  results.push({
    route: r,
    url,
    status,
    consoleErrorsCount: consoleErrors.length,
    httpErrorsCount: httpErrors.length,
    sampleConsole: consoleErrors.slice(0, 1)[0],
    sampleHttp: httpErrors.slice(0, 1)[0],
    bodySnippet: text.slice(0, 120).replace(/\n/g, ' | '),
  })
}

console.log()
console.log('# Per-route status')
let okCount = 0
for (const r of results) {
  console.log(`${r.status.padEnd(15)} ${r.route.padEnd(35)} ${r.bodySnippet?.slice(0, 80)}`)
  if (r.status === 'ok' || r.status === 'gated-welcome' || r.status === 'gated-login') okCount++
}
console.log()
console.log(`# Summary: ${okCount}/${results.length} reachable-or-intentionally-gated; ${results.length - okCount} need fixing`)
console.log()
console.log('# Detailed errors')
for (const r of results) {
  if (r.status === 'error' || r.status === 'error-text' || r.status === 'load-fail' || r.status === 'empty') {
    console.log(`  ${r.route}: ${r.status} | ce=${r.consoleErrorsCount} he=${r.httpErrorsCount}`)
    if (r.sampleConsole) console.log(`    console: ${r.sampleConsole}`)
    if (r.sampleHttp) console.log(`    http: ${r.sampleHttp}`)
  }
}

await browser.close()
