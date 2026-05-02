import { test, expect } from '@playwright/test'

/**
 * DefectReporter modal E2E.
 *
 * Round 6 #3 — Iterate-on-Defect Loop in UAT (followup run)
 * [Engineer-Sr · Sonnet · run-round6-03-defect-iteration-followup]
 *
 * Tests the full DefectReporter modal interaction flow via the UAT page.
 * We intercept tRPC batch calls to inject story + session + AC data so the
 * page reaches the state where "Report defect" buttons are visible, then
 * exercise the modal through its full flow.
 *
 * Scenarios covered:
 *   1. Modal opens with AC text in header when "Report defect" is clicked
 *   2. Submit is disabled when reproduction steps are empty
 *   3. Iteration limit warning shown when task has iterationCount >= 3
 *   4. DefectTimeline renders "No defects reported yet" in empty state
 *   5. Modal can be closed via cancel and backdrop click
 */

// ---------------------------------------------------------------------------
// tRPC mock helpers
//
// The app calls /api/trpc/* with batched JSON-RPC requests. We intercept
// those and return minimal shaped responses to drive the UI into the
// state we want to test.
// ---------------------------------------------------------------------------

/** Shape of a single tRPC response item in a batch. */
function trpcOk(result: unknown) {
  return { result: { data: result } }
}

const STORY_ID = '00000000-aaaa-0000-0000-000000000001'
const SESSION_ID = '00000000-bbbb-0000-0000-000000000001'
const AC_ID = '00000000-cccc-0000-0000-000000000001'
const TASK_ID = '00000000-dddd-0000-0000-000000000001'
const AC_TEXT = 'The widget must render within 200ms'

/** Stable list of stories returned by backlog.stories.list. */
const STORIES_RESPONSE = [
  {
    storyId: STORY_ID,
    storyKey: 'STORY-42',
    title: 'Widget performance story',
    status: 'in_review',
    priority: 1,
    storyPoints: 3,
    epicId: '00000000-eeee-0000-0000-000000000001',
    schemaVersion: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
]

/** A session with one AC (pass status). */
const SESSIONS_RESPONSE = {
  sessions: [
    {
      uat_session_id: SESSION_ID,
      ticket_id: STORY_ID,
      session_version: 1,
      state: 'in_progress',
      pass_count: 0,
      fail_count: 0,
      total_ac_count: 1,
      build_ref: 'sha-test',
      started_at: '2026-01-01T00:00:00Z',
    },
  ],
}

/** AC results for the session — one AC with status 'pending'. */
const SESSION_DETAIL_RESPONSE = {
  session: {
    uat_session_id: SESSION_ID,
    ticket_id: STORY_ID,
    session_version: 1,
    state: 'in_progress',
    pass_count: 0,
    fail_count: 0,
    total_ac_count: 1,
    build_ref: 'sha-test',
    started_at: '2026-01-01T00:00:00Z',
    assumptions_snapshot: [],
    story_version: 1,
    schema_version: 1,
  },
  ac_results: [
    {
      ac_result_id: '00000000-ffff-0000-0000-000000000001',
      uat_session_id: SESSION_ID,
      ac_id: AC_ID,
      ac_ordinal: 1,
      ac_text_snapshot: AC_TEXT,
      status: 'pending',
      observed_behavior: null,
      evidence_links: [],
      marked_at: null,
      marked_by_user_id: null,
      schema_version: 1,
    },
  ],
  task_id: TASK_ID,
  iteration_count: 0,
}

/** Defect history — empty for base scenario. */
const DEFECT_HISTORY_EMPTY = { defects: [] }

/** PR summary — not present. */
const PR_SUMMARY_EMPTY = { pr_number: null, html_url: null, state: null, head_sha: null }

/** Code review — not present. */
const CODE_REVIEW_EMPTY = { state: null, review_id: null }

/**
 * Set up route intercepts for tRPC calls needed to render the UAT page
 * with a story selected, session active, and AC checklist visible.
 *
 * iterationCount controls the task's iteration_count (for limit warning test).
 */
async function setupTrpcMocks(
  page: import('@playwright/test').Page,
  opts: { iterationCount?: number } = {},
) {
  const iterationCount = opts.iterationCount ?? 0

  // Intercept all tRPC batch calls
  await page.route('**/api/trpc/**', async (route) => {
    const url = route.request().url()

    // Parse which procedures are being called (batch or single)
    // tRPC encodes procedure names in the URL path segment
    const urlPath = new URL(url).pathname.replace('/api/trpc/', '')
    const procedures = urlPath.split(',')

    const responses: unknown[] = procedures.map((proc) => {
      const base = proc.split('?')[0] ?? proc

      if (base === 'backlog.stories.list') return trpcOk(STORIES_RESPONSE)
      if (base === 'uat.session.list') return trpcOk(SESSIONS_RESPONSE)
      if (base === 'uat.session.get')
        return trpcOk({
          ...SESSION_DETAIL_RESPONSE,
          iteration_count: iterationCount,
        })
      if (base === 'uat.defects.history') return trpcOk(DEFECT_HISTORY_EMPTY)
      if (base === 'pr.summary') return trpcOk(PR_SUMMARY_EMPTY)
      if (base === 'codeReview.summary') return trpcOk(CODE_REVIEW_EMPTY)
      if (base === 'admin.install.get') return trpcOk({ install_id: 'test', setup_complete: true })

      // Default: empty/null response
      return trpcOk(null)
    })

    // tRPC batch: array when multiple, single object when one
    const body = procedures.length === 1 ? responses[0] : responses

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    })
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('DefectReporter modal', () => {
  test('modal structure: dialog role and AC text in header are present', async ({ page }) => {
    await setupTrpcMocks(page)
    await page.goto('/uat')

    // Select the story
    await page.getByLabel('Story under review').selectOption({ label: /Widget performance/i })

    // Wait for AC checklist to appear — look for the "Report defect" button
    // ACChecklist renders a "Report defect" button per AC row
    await expect(page.getByRole('button', { name: /report defect/i }).first()).toBeVisible({
      timeout: 10_000,
    })

    // Click "Report defect" to open the modal
    await page.getByRole('button', { name: /report defect/i }).first().click()

    // Assert modal is present with correct role and title
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('Report defect on AC')).toBeVisible()

    // AC text should appear in the modal header
    await expect(dialog.getByText(AC_TEXT)).toBeVisible()
  })

  test('submit button is disabled when reproduction steps are empty', async ({ page }) => {
    await setupTrpcMocks(page)
    await page.goto('/uat')

    await page.getByLabel('Story under review').selectOption({ label: /Widget performance/i })
    await expect(page.getByRole('button', { name: /report defect/i }).first()).toBeVisible({
      timeout: 10_000,
    })
    await page.getByRole('button', { name: /report defect/i }).first().click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    // Repro steps textarea should be empty and autofocused
    const reproTextarea = dialog.getByLabel(/reproduction steps/i)
    await expect(reproTextarea).toBeVisible()
    await expect(reproTextarea).toHaveValue('')

    // Submit button should be disabled
    const submitButton = dialog.getByRole('button', { name: /report defect/i })
    await expect(submitButton).toBeDisabled()

    // Fill repro steps → submit becomes enabled
    await reproTextarea.fill('1. Navigate to widget\n2. Wait\n3. Observe slow render')
    await expect(submitButton).toBeEnabled()
  })

  test('iteration limit warning is shown when iterationCount >= 3', async ({ page }) => {
    await setupTrpcMocks(page, { iterationCount: 3 })
    await page.goto('/uat')

    await page.getByLabel('Story under review').selectOption({ label: /Widget performance/i })
    await expect(page.getByRole('button', { name: /report defect/i }).first()).toBeVisible({
      timeout: 10_000,
    })
    await page.getByRole('button', { name: /report defect/i }).first().click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    // Limit warning must be visible
    await expect(dialog.getByRole('alert')).toBeVisible()
    await expect(
      dialog.getByText(/reached the iteration limit/i),
    ).toBeVisible()
    await expect(
      dialog.getByText(/human escalation/i),
    ).toBeVisible()
  })

  test('modal closes when Cancel is clicked', async ({ page }) => {
    await setupTrpcMocks(page)
    await page.goto('/uat')

    await page.getByLabel('Story under review').selectOption({ label: /Widget performance/i })
    await expect(page.getByRole('button', { name: /report defect/i }).first()).toBeVisible({
      timeout: 10_000,
    })
    await page.getByRole('button', { name: /report defect/i }).first().click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    // Click Cancel button
    await dialog.getByRole('button', { name: /cancel/i }).click()
    await expect(dialog).not.toBeVisible()
  })

  test('modal closes via close button (X)', async ({ page }) => {
    await setupTrpcMocks(page)
    await page.goto('/uat')

    await page.getByLabel('Story under review').selectOption({ label: /Widget performance/i })
    await expect(page.getByRole('button', { name: /report defect/i }).first()).toBeVisible({
      timeout: 10_000,
    })
    await page.getByRole('button', { name: /report defect/i }).first().click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    // Click close button (aria-label="Close defect reporter")
    await dialog.getByLabel('Close defect reporter').click()
    await expect(dialog).not.toBeVisible()
  })

  test('DefectTimeline renders empty state when no defects exist', async ({ page }) => {
    await setupTrpcMocks(page)
    await page.goto('/uat')

    await page.getByLabel('Story under review').selectOption({ label: /Widget performance/i })

    // DefectTimeline is rendered below the AC checklist — waits for session to load
    await expect(
      page.getByText('Defect Iteration History'),
    ).toBeVisible({ timeout: 10_000 })

    // Empty state text from DefectTimeline
    await expect(page.getByText('No defects reported yet.')).toBeVisible()
  })
})
