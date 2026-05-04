import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'story-executor',
    environment: 'node',
    include: ['test/**/*.test.js', 'src/**/*.test.js'],
    testTimeout: 20_000,
    pool: 'forks',
  },
})
