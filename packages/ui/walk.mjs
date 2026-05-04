// Comprehensive UI walk against live URL. Logs in as the test user, walks
// every visible nav link / button / route, captures console errors,
// network failures, page errors. Output: structured JSON report.
import { chromium } from 'playwright'

const BASE = 'https://d2mtgpa71y9c8t.cloudfront.net'
const EMAIL = 'smoketest+login@orbital.local'
const PASSWORD = 'iO5MXE27g8pObTXanLhqAa1!'

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await ctx.newPage()

const findings = []
const consoleErrors = []
const networkFails = []
const pageErrors = []

page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push({ url: page.url(), text: m.text() })
})
page.on('pageerror', (e) => pageErrors.push({ url: page.url(), msg: e.message }))
page.on('requestfailed', (r) => networkFails.push({ url: page.url(), req: r.url(), method: r.method(), err: r.failure()?.errorText }))
page.on('response', (r) => {
  if (r.status() >= 400) networkFails.push({ url: page.url(), req: r.url(), status: r.status() })
})

const snap = async (label) => {
  await page.waitForTimeout(500)
  const url = page.url()
  const title = await page.title().catch(() => '')
  const visibleText = (await page.evaluate(() => document.body?.innerText || '').catch(() => '')).slice(0, 600)
  return { label, url, title, visibleText }
}

const log = (label, extra = {}) => async () => {
  const s = await snap(label)
  findings.push({ ...s, ...extra })
}

// 1) Login
console.log('## Login')
await page.goto(`${BASE}/login`, { waitUntil: 'load', timeout: 60000 })
await page.waitForTimeout(2000)
findings.push(await snap('login-loaded'))
try {
  await page.getByLabel(/email/i).fill(EMAIL)
  await page.getByLabel(/password/i).fill(PASSWORD)
  await page.getByRole('button', { name: /sign in|log ?in/i }).click()
  await page.waitForTimeout(5000)
  findings.push(await snap('post-login'))
} catch (e) {
  findings.push({ label: 'login-fill-fail', error: e.message, url: page.url() })
}

// 2) Try every reasonable route
const routes = [
  '/',
  '/welcome',
  '/stories',
  '/projects',
  '/settings',
  '/settings/general',
  '/settings/integrations',
  '/settings/agents',
  '/settings/sprints',
  '/settings/team',
  '/settings/billing',
  '/admin',
  '/admin/integrations',
  '/vision',
  '/dashboard',
  '/channels',
  '/backlog',
  '/sprints',
  '/install',
  '/oauth/github/callback',
]

for (const r of routes) {
  consoleErrors.length = 0
  networkFails.length = 0
  pageErrors.length = 0
  try {
    await page.goto(`${BASE}${r}`, { waitUntil: 'load', timeout: 30000 })
    await page.waitForTimeout(2500)
  } catch (e) {
    findings.push({ label: `route ${r}`, error: e.message, url: page.url() })
    continue
  }
  const s = await snap(`route ${r}`)
  // Detect blank or error-y states
  const lc = (s.visibleText || '').toLowerCase()
  const isError = lc.includes('error') || lc.includes('not found') || lc.includes('404') || lc.includes('something went wrong')
  const isEmpty = s.visibleText.trim().length < 30
  findings.push({
    ...s,
    isError,
    isEmpty,
    consoleErrorsCount: consoleErrors.length,
    consoleErrorsSample: consoleErrors.slice(0, 3).map((e) => e.text),
    networkFailsCount: networkFails.length,
    networkFailsSample: networkFails.slice(0, 3),
    pageErrorsSample: pageErrors.slice(0, 3),
  })
}

// 3) On welcome, count visible flow cards + nav items
try {
  await page.goto(`${BASE}/welcome`, { waitUntil: 'load', timeout: 30000 })
  await page.waitForTimeout(2000)
  const cards = await page.locator('[data-testid^=flow-card-]').count()
  const buttons = await page.locator('button').count()
  const links = await page.locator('a').count()
  findings.push({ label: 'welcome-stats', cards, buttons, links })
} catch (e) {
  findings.push({ label: 'welcome-stats-fail', error: e.message })
}

// 4) Walk nav: click each visible top-level link in the header (if any) and snapshot
try {
  await page.goto(`${BASE}/welcome`, { waitUntil: 'load', timeout: 30000 })
  await page.waitForTimeout(2000)
  const navLinks = await page.locator('nav a, header a').evaluateAll((els) =>
    els.map((a) => ({ href: a.getAttribute('href'), text: a.innerText?.trim() || '' })).filter((x) => x.href && !x.href.startsWith('http'))
  )
  findings.push({ label: 'nav-links', count: navLinks.length, links: navLinks })
  for (const link of navLinks.slice(0, 10)) {
    try {
      consoleErrors.length = 0; pageErrors.length = 0
      await page.goto(`${BASE}${link.href.startsWith('/') ? link.href : '/' + link.href}`, { waitUntil: 'load', timeout: 30000 })
      await page.waitForTimeout(1500)
      findings.push({
        label: `nav ${link.text || link.href}`,
        url: page.url(),
        href: link.href,
        consoleErrorsCount: consoleErrors.length,
        sample: consoleErrors.slice(0, 2).map((e) => e.text),
        bodySnippet: (await page.evaluate(() => document.body?.innerText || '')).slice(0, 200),
      })
    } catch (e) {
      findings.push({ label: `nav-fail ${link.href}`, error: e.message })
    }
  }
} catch (e) {
  findings.push({ label: 'nav-walk-fail', error: e.message })
}

console.log(JSON.stringify({ totalFindings: findings.length, findings }, null, 2))
await browser.close()
