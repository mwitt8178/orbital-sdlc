import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      // @orbital/db has no compiled dist during unit-test runs.
      // Route to the raw source so vite can resolve the package entry.
      '@orbital/db': resolve(__dirname, 'packages/db/src/index.ts'),
      '@orbital/types': resolve(__dirname, 'packages/types/src/index.ts'),
    },
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['packages/**/test/**/*.test.{ts,tsx}', 'packages/**/src/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/build/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: false } },
    setupFiles: ['./vitest.setup.ts'],
  },
})
