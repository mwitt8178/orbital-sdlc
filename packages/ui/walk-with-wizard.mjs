// Walk the new_project wizard end-to-end, then walk every route to verify
// the project actually got created and pages have data.
import { chromium } from 'playwright'

const BASE = 'https://d2mtgpa71y9c8t.cloudfront.net'
const EMAIL = 'smoketest+login@orbital.local'
const PASSWORD = 'iO5MXE27g8pObTXanLhqAa1!'
const SUSPICIOUS = [
  'Acme Product',
  'No projects',
  'Loading…',
  'TODO',
  'Lorem',
  'placeholder',
  'sample data',
  'Reconnecting',
  'Could not load',
  'Failed to',
  'Something went wrong',
  '0 epics',
  '0 stories',
]

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
  '/settings/sprints',
  '/admin/integrations',
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

const dump = async (label) => {
  await page.waitForTimeout(800)
  console.log(`\n## ${label} (${page.url()})`)
  const t = (await page.evaluate(() => document.body?.innerText || '')).slice(0, 200).replace(/\n/g, ' | ')
  console.log(`   ${t}`)
}

// 1. Login
console.log('# Login')
await page.goto(`${BASE}/login`, { waitUntil: 'load', timeout: 60000 })
await page.waitForTimeout(1500)
await page.getByLabel(/email/i).fill(EMAIL)
await page.getByLabel(/password/i).fill(PASSWORD)
await page.getByRole('button', { name: /sign in|log ?in/i }).click()
await page.waitForTimeout(4500)
await dump('post-login')

// 2. If we're not on /welcome, force it
if (!page.url().endsWith('/welcome')) {
  await page.goto(`${BASE}/welcome`, { waitUntil: 'load', timeout: 60000 })
  await page.waitForTimeout(2000)
}

// 3. Click "Start a new project" / new_project flow card
const startBtn = page.getByTestId('flow-card-new_project').or(page.getByRole('button', { name: /start a new project/i })).first()
const seen = await startBtn.count()
console.log(`new_project card seen: ${seen}`)
if (seen === 0) {
  // already in active session — try Continue
  const cont = page.getByRole('button', { name: /continue/i })
  if ((await cont.count()) > 0) await cont.click()
} else {
  await startBtn.click()
}
await page.waitForTimeout(2500)
await dump('clicked-new_project')

// 4. Project basics — fill name + slug + description
const slug = `walk-${Date.now().toString(36)}`
try {
  const name = page.getByLabel(/name/i).first()
  if (await name.count()) await name.fill('Walk Test')
  const slugIn = page.getByLabel(/slug|url/i).first()
  if (await slugIn.count()) await slugIn.fill(slug)
  const desc = page.getByLabel(/description/i).first()
  if (await desc.count()) await desc.fill('Automated walk verification project')
  await page.waitForTimeout(800)
  // Continue
  const next = page.getByRole('button', { name: /continue|next|save/i }).first()
  await next.click()
  await page.waitForTimeout(2500)
  await dump('after-basics')
} catch (e) {
  console.log('basics step failed:', e.message)
}

// 5. Iteratively click "Continue" / "Save" / "Done" / "Lock" / "Skip" until we leave /welcome or run out
let prevUrl = page.url()
for (let i = 0; i < 25; i++) {
  errors.length = 0; fails.length = 0
  // Try buttons in priority order
  const ctas = ['Done', 'Launch', 'Open dashboard', 'Continue', 'Next', 'Save', 'Save & validate', 'Skip', 'Generate plan', 'Lock', 'Confirm']
  let clicked = false
  for (const cta of ctas) {
    const b = page.getByRole('button', { name: new RegExp(`^${cta}$|^${cta}\\b`, 'i') }).first()
    if ((await b.count()) > 0 && (await b.isVisible().catch(() => false)) && (await b.isEnabled().catch(() => false))) {
      await b.click().catch(() => {})
      clicked = true
      console.log(`  clicked: ${cta}`)
      break
    }
  }
  if (!clicked) {
    console.log(`  no actionable button at iter ${i}`)
    break
  }
  await page.waitForTimeout(2000)
  const u = page.url()
  if (u !== prevUrl) {
    console.log(`  url change: ${prevUrl} → ${u}`)
    prevUrl = u
  }
  if (!u.endsWith('/welcome')) {
    console.log(`  exited /welcome at iter ${i}`)
    break
  }
}

await dump('post-wizard')

// 6. Verify project list
const projects = await page.evaluate(async () => {
  const r = await fetch('https://hhhfb8pid6.execute-api.us-east-1.amazonaws.com/trpc/projects.list')
  return r.json()
})
console.log('\n# projects.list:', JSON.stringify(projects?.result?.data ?? projects, null, 2).slice(0, 600))

// 7. Walk routes
console.log('\n# Per-route deep check')
const findings = []
for (const r of ROUTES) {
  errors.length = 0
  fails.length = 0
  await page.goto(`${BASE}${r}`, { waitUntil: 'load', timeout: 25000 }).catch(() => null)
  await page.waitForTimeout(2500)
  const url = page.url()
  const text = (await page.evaluate(() => document.body?.innerText || '')).slice(0, 1500)
  const issues = []
  if (url.endsWith('/welcome') && r !== '/welcome') issues.push('redirected-to-welcome')
  for (const s of SUSPICIOUS) if (text.includes(s)) issues.push(`text:"${s}"`)
  if (errors.length) issues.push(`console:${errors.length}`)
  if (fails.length) issues.push(`http:${fails.length}`)
  findings.push({ r, url, issues, body: text.slice(0, 120).replace(/\n/g, ' | '), sampleErr: errors[0]?.slice(0, 150), sampleFail: fails[0] })
}

console.log()
let ok = 0
for (const f of findings) {
  const mark = f.issues.length ? '✗' : '✓'
  console.log(`${mark} ${f.r.padEnd(28)} ${(f.issues.join(', ') || 'clean').slice(0, 80)}`)
  if (f.issues.length) {
    console.log(`     body: ${f.body.slice(0, 100)}`)
    if (f.sampleErr) console.log(`     err: ${f.sampleErr}`)
    if (f.sampleFail) console.log(`     fail: ${f.sampleFail}`)
  }
  if (!f.issues.length) ok++
}
console.log(`\n# ${ok}/${findings.length} clean`)
await browser.close()
