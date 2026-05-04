/**
 * Unit test: InstallationTokenProvider token refresh behaviour.
 *
 * Tests:
 *   - Returns cached token within TTL
 *   - Refreshes token when within TOKEN_REFRESH_LEAD_MS of expiry
 *   - Single-flights concurrent refresh requests (no stampede)
 *
 * [Engineer-Sr · Sonnet · run-github-app-install]
 */

import { describe, it, expect, vi, beforeAll } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { InstallationTokenProvider } from '../../../src/github/app-auth.js'

const FAKE_APP_ID = 12345

// Generate a real (but ephemeral) RSA key pair for tests so JWT minting succeeds.
let TEST_PRIVATE_KEY_PEM = ''

beforeAll(() => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  TEST_PRIVATE_KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
})

function makeTokenProvider(fetchImpl: typeof fetch, nowMs: () => number) {
  return new InstallationTokenProvider({
    appId: FAKE_APP_ID,
    privateKeyPem: TEST_PRIVATE_KEY_PEM,
    fetchImpl,
    nowMs,
  })
}

describe('InstallationTokenProvider', () => {
  it('returns fresh token from GitHub on first call', async () => {
    let nowMs = 1_000_000
    const expiresAt = new Date(nowMs + 60 * 60_000).toISOString() // 1h from now
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: 'ghs_fresh_token', expires_at: expiresAt }),
    })

    const provider = makeTokenProvider(mockFetch, () => nowMs)
    const token = await provider.getInstallationToken(42)
    expect(token).toBe('ghs_fresh_token')
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('returns cached token without hitting GitHub on second call', async () => {
    let nowMs = 1_000_000
    const expiresAt = new Date(nowMs + 60 * 60_000).toISOString()
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: 'ghs_cached_token', expires_at: expiresAt }),
    })

    const provider = makeTokenProvider(mockFetch, () => nowMs)
    await provider.getInstallationToken(42)
    const token2 = await provider.getInstallationToken(42)

    expect(token2).toBe('ghs_cached_token')
    expect(mockFetch).toHaveBeenCalledTimes(1) // only one fetch
  })

  it('refreshes token when within TOKEN_REFRESH_LEAD_MS (10 min) of expiry', async () => {
    let nowMs = 1_000_000
    // Token expires in 9 minutes — within the 10-min lead window
    const expiresAt = new Date(nowMs + 9 * 60_000).toISOString()
    let fetchCount = 0
    const mockFetch = vi.fn().mockImplementation(async () => {
      fetchCount++
      if (fetchCount === 1) {
        return { ok: true, json: async () => ({ token: 'ghs_old', expires_at: expiresAt }) }
      }
      return {
        ok: true,
        json: async () => ({
          token: 'ghs_refreshed',
          expires_at: new Date(nowMs + 60 * 60_000).toISOString(),
        }),
      }
    })

    const provider = makeTokenProvider(mockFetch, () => nowMs)
    // First call populates cache
    await provider.getInstallationToken(42)

    // Advance time so we're within 10 min of expiry (which is already the case here)
    // Second call should refresh because the cached token expires in < 10 min
    const token2 = await provider.getInstallationToken(42)

    // The token should have been refreshed (2 fetches total)
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(token2).toBe('ghs_refreshed')
  })

  it('single-flights concurrent requests for the same installation', async () => {
    let nowMs = 1_000_000
    const expiresAt = new Date(nowMs + 60 * 60_000).toISOString()
    let fetchCount = 0
    const mockFetch = vi.fn().mockImplementation(async () => {
      fetchCount++
      // Simulate async delay
      await new Promise((r) => setTimeout(r, 1))
      return { ok: true, json: async () => ({ token: `ghs_concurrent_${fetchCount}`, expires_at: expiresAt }) }
    })

    const provider = makeTokenProvider(mockFetch, () => nowMs)
    // Fire 5 concurrent requests
    const results = await Promise.all([
      provider.getInstallationToken(42),
      provider.getInstallationToken(42),
      provider.getInstallationToken(42),
      provider.getInstallationToken(42),
      provider.getInstallationToken(42),
    ])

    // Only one fetch should have happened
    expect(fetchCount).toBe(1)
    // All results should be the same token
    expect(new Set(results).size).toBe(1)
  })

  it('uses different cache slots for different installation IDs', async () => {
    let nowMs = 1_000_000
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      const installId = /\/(\d+)\/access_tokens/.exec(url)?.[1]
      return {
        ok: true,
        json: async () => ({
          token: `ghs_inst_${installId}`,
          expires_at: new Date(nowMs + 60 * 60_000).toISOString(),
        }),
      }
    })

    const provider = makeTokenProvider(mockFetch, () => nowMs)
    const [tok10, tok20] = await Promise.all([
      provider.getInstallationToken(10),
      provider.getInstallationToken(20),
    ])

    expect(tok10).toBe('ghs_inst_10')
    expect(tok20).toBe('ghs_inst_20')
  })

  it('throws when GitHub returns non-ok status', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    })

    const provider = makeTokenProvider(mockFetch, () => Date.now())
    await expect(provider.getInstallationToken(42)).rejects.toThrow(/401/)
  })
})
