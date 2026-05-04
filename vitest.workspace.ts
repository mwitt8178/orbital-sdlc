/**
 * vitest.workspace.ts — Vitest workspace configuration.
 *
 * Separates unit tests (parallel) from integration tests (sequential) to
 * prevent cross-test contamination on shared Postgres tables (e.g. local_outbox)
 * when multiple test files run concurrently against the same database.
 *
 * [Engineer-Sr · Sonnet · run-round7-06-offline-reconcile-followup-df2]
 */

import { defineWorkspace } from 'vitest/config'
import { resolve } from 'node:path'

const sharedAlias = {
  // @orbital/db has no compiled dist during unit-test runs.
  // Point to the raw TS source so Vite can resolve the package entry.
  '@orbital/db': resolve(__dirname, 'packages/db/src/index.ts'),
  '@orbital/types': resolve(__dirname, 'packages/types/src/index.ts'),
}

export default defineWorkspace([
  // Unit and e2e tests: parallel file execution (fast).
  {
    resolve: { alias: sharedAlias },
    test: {
      name: 'unit',
      globals: false,
      environment: 'node',
      include: [
        'packages/**/test/unit/**/*.test.{ts,tsx}',
        'packages/**/test/e2e/**/*.test.{ts,tsx}',
        'packages/**/src/**/*.test.{ts,tsx}',
      ],
      exclude: ['**/node_modules/**', '**/dist/**', '**/build/**'],
      testTimeout: 30_000,
      hookTimeout: 30_000,
      pool: 'forks',
      poolOptions: {
        forks: {
          singleFork: false,
        },
      },
      setupFiles: ['./vitest.setup.ts'],
    },
  },

  // Integration tests: sequential file execution to prevent shared-DB races.
  // Multiple integration test files that touch the same Postgres tables
  // (audit.events, local_outbox, etc.) must not run in parallel — their
  // beforeAll/afterAll cleanup and row counting assumes they are the only
  // writer for the duration of a test file.
  {
    resolve: { alias: sharedAlias },
    test: {
      name: 'integration',
      globals: false,
      environment: 'node',
      include: [
        'packages/**/test/integration/**/*.test.{ts,tsx}',
      ],
      exclude: ['**/node_modules/**', '**/dist/**', '**/build/**'],
      testTimeout: 30_000,
      hookTimeout: 30_000,
      pool: 'forks',
      poolOptions: {
        forks: {
          // Sequential execution prevents cross-file contamination on shared tables.
          singleFork: true,
        },
      },
      setupFiles: ['./vitest.setup.ts'],
    },
  },
])
