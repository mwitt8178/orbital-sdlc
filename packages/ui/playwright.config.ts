import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env['PLAYWRIGHT_VITE_PORT'] ?? 5174)

export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  workers: process.env['CI'] ? 1 : undefined,
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
  ],
  webServer: {
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
