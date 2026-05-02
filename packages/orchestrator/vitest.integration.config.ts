/**
 * vitest.integration.config.ts
 *
 * Separate vitest config for integration tests that share a Postgres DB.
 * Runs test FILES sequentially (singleFork: true) to prevent cross-test
 * contamination on shared tables like local_outbox.
 *
 * Usage:
 *   npx vitest run --config vitest.integration.config.ts test/integration/outbox/
 */

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['test/integration/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    poolOptions: {
      forks: {
        // Force sequential execution so test files sharing the local_outbox table
        // do not interfere with each other's drain loops and row queries.
        singleFork: true,
      },
    },
  },
})
