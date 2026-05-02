/**
 * Unit tests for onboarding/github-validate.ts.
 *
 * Mocks `fetch` to verify request shape and error handling against the
 * GET /user endpoint.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  validateGithubToken,
  getGithubValidator,
  setGithubValidator,
} from '../../../src/onboarding/github-validate.js'

let fetchStub: ReturnType<typeof vi.fn>
const realFetch = globalThis.fetch

beforeEach(() => {
  fetchStub = vi.fn()
  globalThis.fetch = fetchStub as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  setGithubValidator(null)
})

describe('github-validate', () => {
  it('rejects an empty token without making a network call', async () => {
    const r = await validateGithubToken('')
    expect(r.ok).toBe(false)
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it('returns ok with the login on a 200 response', async () => {
    fetchStub.mockResolvedValueOnce(
      new globalThis.Response(JSON.stringify({ login: 'octocat' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const r = await validateGithubToken('valid-token')
    expect(r.ok).toBe(true)
    expect(r.login).toBe('octocat')
    expect(fetchStub).toHaveBeenCalledWith(
      'https://api.github.com/user',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer valid-token',
          Accept: 'application/vnd.github+json',
        }),
      }),
    )
  })

  it('treats 401 as invalid credentials', async () => {
    fetchStub.mockResolvedValueOnce(
      new globalThis.Response(JSON.stringify({ message: 'Bad credentials' }), {
        status: 401,
      }),
    )
    const r = await validateGithubToken('bad')
    expect(r.ok).toBe(false)
    expect(r.message?.toLowerCase()).toContain('invalid')
  })

  it('treats 403 as invalid credentials', async () => {
    fetchStub.mockResolvedValueOnce(
      new globalThis.Response(JSON.stringify({ message: 'forbidden' }), {
        status: 403,
      }),
    )
    const r = await validateGithubToken('weak-token')
    expect(r.ok).toBe(false)
  })

  it('reports a non-2xx error from the API', async () => {
    fetchStub.mockResolvedValueOnce(
      new globalThis.Response('Server error', { status: 502 }),
    )
    const r = await validateGithubToken('token')
    expect(r.ok).toBe(false)
    expect(r.message).toContain('502')
  })

  it('returns ok=false if no login present in body', async () => {
    fetchStub.mockResolvedValueOnce(
      new globalThis.Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const r = await validateGithubToken('token')
    expect(r.ok).toBe(false)
    expect(r.message).toBeDefined()
  })

  it('singleton getGithubValidator() returns a working validator', async () => {
    fetchStub.mockResolvedValueOnce(
      new globalThis.Response(JSON.stringify({ login: 'mona' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const v = getGithubValidator()
    const r = await v.validate('any')
    expect(r.ok).toBe(true)
    expect(r.login).toBe('mona')
  })
})
