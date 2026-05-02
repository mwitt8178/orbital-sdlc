// Test environment defaults — applied before every test file.
// Real Postgres + real keychain are required for integration tests.

// Load .env from repo root so DATABASE_URL and other vars are available.
// This is the only place process.env is read for test configuration.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

try {
  const envPath = resolve(process.cwd(), '.env')
  const envContent = readFileSync(envPath, 'utf-8')
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    // Only set if not already set in the environment.
    if (key && !(key in process.env)) {
      process.env[key] = value
    }
  }
} catch {
  // No .env file — rely on actual environment variables.
}

process.env.NODE_ENV = process.env.NODE_ENV ?? 'test'
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent'
// Use a file-based keychain shim only in test (per Implementation Plan §13).
process.env.ORBITAL_TEST_KEYCHAIN = process.env.ORBITAL_TEST_KEYCHAIN ?? '1'
// Per-worker shim path so parallel forks do not race on a shared file.
// Falls back to the canonical ~/.orbital-test-keychain.json when not set.
if (!process.env.ORBITAL_TEST_KEYCHAIN_PATH) {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
  process.env.ORBITAL_TEST_KEYCHAIN_PATH = `${home}/.orbital-test-keychain-${process.pid}.json`
}
