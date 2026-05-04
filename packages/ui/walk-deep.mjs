// Deep semantic walk. For each route, capture not just "did it render" but
// what's ACTUALLY visible — empty states, hardcoded placeholders, broken
// buttons, forms that don't submit, links to dead routes, and cosmetic lies.
import { chromium } from 'playwright'

const BASE = 'https://d2mtgpa71y9c8t.cloudfront.net'
const EMAIL = 'smoketest+login@orbital.local'
const PASSWORD = 'iO5MXE27g8pObTXanLhqAa1!'

const ROUTES = [
  '/',
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

const SUSPICIOUS_STRINGS = [
  'Acme Product',
  'Coming soon',
  'No projects',
  'Loading…',
  'No data',
  'TODO',
  'Lorem',
  'placeholder',
  'sample data',
  'Reconnecting',
  'Failed to',
  'undefined',
  'null',
  '0 epics',
  '0 channels',
  '0 sprints',
]

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await ctx.newPage()

const errors = []
const fails = []
page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 200)))
page.on('response', (r) => {
  if (r.status() >= 400 && (r.url().includes('/trpc/') || r.url().includes('execute-api')))
    fails.push(`${r.status()} ${r.url().split('?')[0].slice(-100)}`)
})

console.log('# Login')
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: 60000 })
await page.waitForSelector('input#email', { timeout: 30000 })
await page.locator('input#email').fill(EMAIL)
await page.locator('input#password').fill(PASSWORD)
await page.getByRole('button', { name: /sign in|log ?in/i }).click()
await page.waitForTimeout(5000)

// Force setup complete
await page.evaluate(async () => {
  await fetch('https://hhhfb8pid6.execute-api.us-east-1.amazonaws.com/trpc/onboarding.complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
})
console.log('  setup forced complete')

const findings = []
for (const r of ROUTES) {
  errors.length = 0
  fails.length = 0
  try {
    await page.goto(`${BASE}${r}`, { waitUntil: 'load', timeout: 25000 })
    await page.waitForTimeout(3000)
  } catch (e) {
    findings.push({ route: r, status: 'load-fail', issue: e.message.slice(0, 100) })
    continue
  }
  const url = page.url()
  const text = (await page.evaluate(() => document.body?.innerText || '')).slice(0, 2000)
  const buttons = await page.locator('button:visible').evaluateAll((els) =>
    els.map((b) => b.innerText.trim().slice(0, 40)).filter((t) => t),
  )
  const links = await page.locator('a:visible').evaluateAll((els) =>
    els.map((a) => a.getAttribute('href')).filter((h) => h && !h.startsWith('http')),
  )
  const forms = await page.locator('form').count()
  const inputs = await page.locator('input:visible, textarea:visible').count()

  const issues = []
  if (url !== `${BASE}${r}` && !url.endsWith(r) && !url.endsWith(r + '/')) {
    issues.push(`redirected-to: ${url.replace(BASE, '')}`)
  }
  for (const s of SUSPICIOUS_STRINGS) {
    if (text.includes(s)) issues.push(`text-contains: "${s}"`)
  }
  if (errors.length) issues.push(`console-errors: ${errors.length}`)
  if (fails.length) issues.push(`http-fails: ${fails.length}`)
  if (text.trim().length < 100) issues.push('body-very-short')

  findings.push({
    route: r,
    url,
    body: text.slice(0, 200).replace(/\n/g, ' | '),
    buttons,
    links: [...new Set(links)].slice(0, 10),
    forms,
    inputs,
    issues,
    sampleConsole: errors.slice(0, 1)[0],
    sampleHttp: fails.slice(0, 1)[0],
  })
}

console.log()
console.log('# Per-route honest report')
for (const f of findings) {
  const status = f.issues.length === 0 ? '✓' : '✗'
  console.log()
  console.log(`${status} ${f.route}  →  ${f.url.replace(BASE, '')}`)
  console.log(`  body: ${f.body.slice(0, 150)}`)
  console.log(`  buttons: ${f.buttons.slice(0, 8).join(' | ').slice(0, 200)}`)
  console.log(`  links: ${f.links.join(' ').slice(0, 200)}`)
  console.log(`  forms=${f.forms} inputs=${f.inputs}`)
  if (f.issues.length) {
    console.log(`  ISSUES:`)
    for (const i of f.issues) console.log(`    - ${i}`)
    if (f.sampleConsole) console.log(`    console: ${f.sampleConsole.slice(0, 180)}`)
    if (f.sampleHttp) console.log(`    http: ${f.sampleHttp}`)
  }
}

const total = findings.length
const clean = findings.filter((f) => f.issues.length === 0).length
console.log()
console.log(`# Score: ${clean}/${total} clean (no suspicious strings, no errors, no http fails)`)

await browser.close()
