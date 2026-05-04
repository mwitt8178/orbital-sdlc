#!/usr/bin/env node
// walk-settings.mjs
//
// Per-tab live verification of /settings/<tab> routes. Used as a deploy gate
// in deploy-mwitt.yml. Must report 6/6 PASS for the deploy to be tagged.
//
// For each of the 6 settings tabs:
//   - navigate to /settings/<tab>
//   - assert the route resolves (no client-side redirect to login or 404)
//   - assert the rendered <body> innerText is > 500 chars (i.e. not an
//     empty fallback)
//   - assert no console errors fired during the page lifecycle
//   - assert no tRPC / fetch responses came back 4xx or 5xx
//
// Env:
//   BASE_URL       — required, e.g. https://d2mtgpa71y9c8t.cloudfront.net
//   ORBITAL_USER   — required, login email
//   ORBITAL_PASS   — required, login password
//   HEADLESS       — optional, defaults to true. Set to '0' for visible runs.
//
// Exit codes: 0 = 6/6 PASS, 1 = any FAIL or unexpected error.

import { chromium } from 'playwright'

const BASE = process.env.BASE_URL
const EMAIL = process.env.ORBITAL_USER
const PASSWORD = process.env.ORBITAL_PASS
const HEADLESS = process.env.HEADLESS !== '0'

if (!BASE || !EMAIL || !PASSWORD) {
  console.error('walk-settings: missing required env: BASE_URL, ORBITAL_USER, ORBITAL_PASS')
  process.exit(1)
}

const TABS = ['general', 'integrations', 'agents', 'sprints', 'team', 'billing']
const MIN_BODY_CHARS = 500

async function login(page) {
  await page.goto(BASE, { waitUntil: 'networkidle' })
  // The login form may not be present if we're already authed. Try, but
  // don't fail if the email field never appears.
  try {
    await page.waitForSelector('input[type="email"]', { timeout: 5_000 })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASSWORD)
    await page.click('button[type="submit"]')
    await page.waitForLoadState('networkidle', { timeout: 15_000 })
  } catch {
    // already logged in — fine
  }
}

async function checkTab(page, tab) {
  const url = `${BASE}/settings/${tab}`
  const consoleErrors = []
  const httpErrors = []

  const onConsole = (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  }
  const onResponse = (res) => {
    const status = res.status()
    const url = res.url()
    // Only flag tRPC / API calls. Static asset 404s are noise.
    if (status >= 400 && (url.includes('/trpc/') || url.includes('/api/'))) {
      httpErrors.push(`${status} ${url}`)
    }
  }

  page.on('console', onConsole)
  page.on('response', onResponse)

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 20_000 })
    // Confirm we didn't bounce to login
    const currentUrl = page.url()
    if (!currentUrl.includes(`/settings/${tab}`)) {
      return {
        tab,
        pass: false,
        reason: `redirected away from /settings/${tab} to ${currentUrl}`,
      }
    }

    const bodyText = await page.evaluate(() => document.body.innerText || '')
    if (bodyText.length < MIN_BODY_CHARS) {
      return {
        tab,
        pass: false,
        reason: `body too short: ${bodyText.length} chars (< ${MIN_BODY_CHARS})`,
      }
    }

    if (consoleErrors.length > 0) {
      return {
        tab,
        pass: false,
        reason: `${consoleErrors.length} console error(s): ${consoleErrors.slice(0, 3).join(' | ')}`,
      }
    }

    if (httpErrors.length > 0) {
      return {
        tab,
        pass: false,
        reason: `${httpErrors.length} HTTP error(s): ${httpErrors.slice(0, 3).join(' | ')}`,
      }
    }

    return { tab, pass: true, bodyLen: bodyText.length }
  } catch (err) {
    return { tab, pass: false, reason: `exception: ${err.message}` }
  } finally {
    page.off('console', onConsole)
    page.off('response', onResponse)
  }
}

async function main() {
  console.log(`walk-settings: BASE=${BASE} HEADLESS=${HEADLESS}`)
  const browser = await chromium.launch({ headless: HEADLESS })
  const context = await browser.newContext()
  const page = await context.newPage()

  let pass = 0
  let fail = 0
  const results = []

  try {
    await login(page)

    for (const tab of TABS) {
      const result = await checkTab(page, tab)
      results.push(result)
      if (result.pass) {
        pass++
        console.log(`  PASS  /settings/${tab}  (body=${result.bodyLen} chars)`)
      } else {
        fail++
        console.log(`  FAIL  /settings/${tab}  — ${result.reason}`)
      }
    }
  } finally {
    await browser.close()
  }

  console.log('')
  console.log(`walk-settings: ${pass}/${TABS.length} PASS`)
  if (fail > 0) {
    console.error('walk-settings: FAILURES detected — deploy gate tripped.')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('walk-settings: unexpected error:', err)
  process.exit(1)
})
