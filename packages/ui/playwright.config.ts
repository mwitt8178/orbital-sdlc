import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env['PLAYWRIGHT_VITE_PORT'] ?? 5174)

// Smoke tests run directly against the live CloudFront URL — no local server.
const SMOKE_BASE_URL =
  process.env['SMOKE_BASE_URL'] ?? 'https://d2mtgpa71y9c8t.cloudfront.net'

export default defineConfig({
  // Default testDir for the e2e project; smoke project overrides with its own testDir.
  testDir: './test/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: 1,
  workers: 1,
  reporter: 'html',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    // ──────────────────────────────────────────────────────────────────────
    // smoke — hits the live CloudFront URL, no local server required.
    // Run with: npx playwright test test/smoke --project=smoke
    // ──────────────────────────────────────────────────────────────────────
    {
      name: 'smoke',
      testDir: './test/smoke',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: SMOKE_BASE_URL,
        // Longer timeouts because we're hitting real AWS endpoints
        actionTimeout: 30_000,
        navigationTimeout: 45_000,
      },
    },
  ],
  // webServer is only needed for the `chromium` (e2e) project.
  // When running smoke tests (`--project=smoke`) no local server is started
  // because smoke hits the live CloudFront URL directly.
  // Skip when PLAYWRIGHT_SKIP_WEB_SERVER is set (set by the CI smoke workflow).
  webServer: process.env['PLAYWRIGHT_SKIP_WEB_SERVER']
    ? undefined
    : {
        // Phase 1-4 verification runs against the PRODUCTION build (which
        // uses .env.production with VITE_TRPC_URL pointing at the deployed
        // mwitt API). Dev mode would proxy /trpc to localhost:3030 (no
        // server running) and fail.
        command: `npm run build && npx vite preview --port ${PORT} --strictPort`,
        url: `http://localhost:${PORT}`,
        reuseExistingServer: !process.env['CI'],
        timeout: 120_000,
      },
})
