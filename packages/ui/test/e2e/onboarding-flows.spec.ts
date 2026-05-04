/**
 * Onboarding wizard flow E2E tests.
 *
 * Exercises the three flow entry points against the deployed mwitt API via the
 * production Vite preview bundle (VITE_TRPC_URL points at the deployed APIGW
 * in .env.production).
 *
 * Serial execution: tests share the deployed install state so they run one at
 * a time.
 *
 * Known-acceptable noise tolerated per the `allowSubstrings` filter:
 *   - WebSocket connection errors (no real session / $default stage)
 *   - Favicon / preload warnings
 *   - "Failed to load resource" (the /ws upgrade probe, APIGW WS stage)
 *
 * Run:
 *   cd packages/ui && PLAYWRIGHT_VITE_PORT=5174 npx playwright test onboarding-flows --project=chromium
 *
 * Round 11 — sample/demo flow removed
 * [Engineer-Principal · Opus · run-remove-sample-flow]
 */

import { test, expect, type Page, type ConsoleMessage } from '@playwright/test'

test.describe.configure({ mode: 'serial' })

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const API_BASE = 'https://hhhfb8pid6.execute-api.us-east-1.amazonaws.com'

/** Attach console/page-error listeners that ignore acceptable noise. */
function trackErrors(page: Page): { errors: string[] } {
  const errors: string[] = []
  const ALLOW = [
    'favicon',
    'preload',
    'Failed to load resource',
    'WebSocket',
    'ERR_CONNECTION_REFUSED',
    'Failed to fetch',
    // tRPC query errors from stale/unknown sessions are expected during tests.
    'TRPCClientError',
    'NOT_FOUND',
    'UNAUTHORIZED',
  ]
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() !== 'error') return
    const text = msg.text()
    if (ALLOW.some((s) => text.includes(s))) return
    errors.push(text)
  })
  page.on('pageerror', (err) => {
    errors.push(`pageerror: ${err.message}`)
  })
  return { errors }
}

/**
 * Navigate to /welcome and wait for the chooser to be visible.
 *
 * The Welcome page renders the chooser immediately on mount (before API
 * responses) because the status query starts as `isLoading: true`.  The
 * redirect-to-/ only fires AFTER status resolves with setupCompletedAt ≠ null.
 * So for a fresh install the chooser is always visible without waiting for
 * the network.
 */
async function goToWelcome(page: Page) {
  await page.goto('/welcome')
  await expect(page.getByTestId('welcome-chooser')).toBeVisible({ timeout: 30_000 })
}

/**
 * Wait for a tRPC mutation response by URL substring match (ignoring status
 * so APIGW batch / CORS differences don't cause false negatives).
 */
function waitForTrpc(page: Page, procedureName: string, timeoutMs = 30_000) {
  return page.waitForResponse(
    (r) => r.url().includes(procedureName),
    { timeout: timeoutMs },
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Onboarding wizard flows', () => {
  /**
   * Warm the APIGW + Lambda / DSQL connection before tests run.
   *
   * The Lambda's first DSQL write after cold-start fails with a transient IAM
   * auth error.  Firing a read-only query via the APIRequestContext warms the
   * Lambda without requiring a browser page.  A follow-up mutation (startSession
   * with sample_data flow) pre-warms the DSQL write path so test 1 (which
   * targets the new_project flow) doesn't hit a cold Lambda.
   */
  test.beforeAll(async ({ request }) => {
    // Read-only warm-up — wakes the Lambda and establishes the DSQL IAM token.
    await request.get(
      `${API_BASE}/trpc/onboarding.status?batch=1&input=%7B%220%22%3A%7B%22json%22%3Anull%7D%7D`,
    )
  })

  /**
   * Flow A — New project.
   *
   * Validates the first two steps (project_basics → connect_tools).
   * Stops at connect_tools because advancing further requires Anthropic/Monday/
   * GitHub credentials.  Three steps reliably verified.
   */
  test('new project flow — renders project basics then connect tools', async ({ page }) => {
    test.setTimeout(60_000)
    const { errors } = trackErrors(page)

    await goToWelcome(page)

    // --- Step 1: chooser — click "Start a new project" ---
    const newProjectCard = page.getByTestId('flow-card-new_project')
    await expect(newProjectCard).toBeVisible()
    await expect(newProjectCard).toContainText('Start a new project')

    const sessionWait = waitForTrpc(page, 'onboarding.startSession')
    await newProjectCard.click()
    await sessionWait

    // --- Step 2: project_basics ---
    // Give a generous timeout: APIGW/DSQL cold-start can take ~10s, then React
    // needs to process the response and re-render.
    await expect(page.getByTestId('new-project-flow')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('heading', { name: /project basics/i })).toBeVisible()

    // Required fields present.
    await expect(page.getByRole('textbox', { name: /project name/i })).toBeVisible()
    await expect(page.getByRole('textbox', { name: /slug/i })).toBeVisible()
    // Optional description textarea.
    await expect(page.locator('#project-description')).toBeVisible()

    // Fill project name → slug auto-populates → Continue enables.
    await page.getByRole('textbox', { name: /project name/i }).fill('E2E Test Project')
    await expect(page.getByRole('textbox', { name: /slug/i })).not.toHaveValue('', { timeout: 3_000 })

    const continueBtn = page.getByRole('button', { name: /^continue$/i })
    await expect(continueBtn).toBeEnabled({ timeout: 5_000 })

    const updateWait = waitForTrpc(page, 'onboarding.updateSession')
    await continueBtn.click()
    await updateWait

    // --- Step 3: connect_tools ---
    await expect(page.getByRole('heading', { name: /connect your tools/i })).toBeVisible({
      timeout: 10_000,
    })

    // All three tool sections present.
    await expect(page.getByRole('heading', { name: /anthropic/i })).toBeVisible()
    await expect(page.getByRole('heading', { name: /monday/i })).toBeVisible()
    await expect(page.getByRole('heading', { name: /github/i })).toBeVisible()

    // Continue disabled — Anthropic key required, none provided.
    await expect(page.getByRole('button', { name: /^continue$/i })).toBeDisabled()

    // Stopping here: vision_intake (step 4) requires Anthropic to be connected.
    // Deferred — requires real Anthropic API key.

    expect(errors, `unexpected console errors:\n${errors.join('\n')}`).toEqual([])
  })

  /**
   * Flow B — Existing repo.
   *
   * Validates the connect_repo step asks for owner + repo.  Stops after
   * asserting Continue enables when both fields are filled — codebase_analysis
   * requires a real GitHub token.
   */
  test('existing repo flow — renders connect-repo step with owner/repo fields', async ({
    page,
  }) => {
    test.setTimeout(60_000)
    const { errors } = trackErrors(page)

    await goToWelcome(page)

    // --- Click "Connect an existing repo" ---
    const existingRepoCard = page.getByTestId('flow-card-existing_repo')
    await expect(existingRepoCard).toBeVisible()
    await expect(existingRepoCard).toContainText('Connect an existing repo')

    const sessionWait = waitForTrpc(page, 'onboarding.startSession')
    await existingRepoCard.click()
    await sessionWait

    // --- connect_repo step ---
    await expect(page.getByTestId('existing-repo-flow')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('heading', { name: /connect your repo/i })).toBeVisible()

    // Both required fields present.
    await expect(page.getByRole('textbox', { name: /github owner/i })).toBeVisible()
    await expect(page.getByRole('textbox', { name: /github repo/i })).toBeVisible()

    // Optional Monday board id field also present.
    await expect(page.getByRole('textbox', { name: /monday board id/i })).toBeVisible()

    // Continue is disabled when both required fields are empty.
    const continueBtn = page.getByRole('button', { name: /^continue$/i })
    await expect(continueBtn).toBeDisabled()

    // Fill owner + repo → Continue should enable.
    await page.getByRole('textbox', { name: /github owner/i }).fill('mwitt')
    await page.getByRole('textbox', { name: /github repo/i }).fill('apprentice')
    await expect(continueBtn).toBeEnabled({ timeout: 5_000 })

    // Stopping here — codebase_analysis needs a real GitHub token (deferred).

    expect(errors, `unexpected console errors:\n${errors.join('\n')}`).toEqual([])
  })

  /**
   * Flow C — Join a team hub.
   *
   * Validates the invite-URL paste step renders with the correct form elements.
   */
  test('join hub flow — renders invite-URL paste step', async ({ page }) => {
    test.setTimeout(60_000)
    const { errors } = trackErrors(page)

    await goToWelcome(page)

    // --- Click "Join a team hub" ---
    const joinHubCard = page.getByTestId('flow-card-join_hub')
    await expect(joinHubCard).toBeVisible()
    await expect(joinHubCard).toContainText('Join a team hub')

    const sessionWait = waitForTrpc(page, 'onboarding.startSession')
    await joinHubCard.click()
    await sessionWait

    // --- JoinHubFlow step ---
    await expect(page.getByLabel(/invite url/i)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByLabel(/display name/i)).toBeVisible()

    // "Join hub" is present but disabled (no valid URL yet).
    const joinBtn = page.getByRole('button', { name: /^join hub$/i })
    await expect(joinBtn).toBeVisible()
    await expect(joinBtn).toBeDisabled()

    // Idle hint is visible.
    await expect(page.getByText(/npm run hub:invite create/i)).toBeVisible()

    // Paste a syntactically valid invite URL → button should enable.
    await page
      .getByLabel(/invite url/i)
      .fill('https://orbital.example.com/join/eyJ0b2tlbiI6InRlc3QifQ')
    await expect(joinBtn).toBeEnabled({ timeout: 5_000 })

    // Submitting would attempt a real hub join — deferred (no test hub running).

    expect(errors, `unexpected console errors:\n${errors.join('\n')}`).toEqual([])
  })

  /**
   * Negative assertion — the removed sample/demo flow card must NEVER render.
   */
  test('welcome chooser — sample_data card is gone', async ({ page }) => {
    test.setTimeout(30_000)
    await goToWelcome(page)

    await expect(
      page.getByTestId('flow-card-sample_data'),
      'flow-card-sample_data must NOT exist',
    ).toHaveCount(0)
    await expect(page.getByTestId('flow-card-new_project')).toBeVisible()
    await expect(page.getByTestId('flow-card-existing_repo')).toBeVisible()
    await expect(page.getByTestId('flow-card-join_hub')).toBeVisible()
  })
})
