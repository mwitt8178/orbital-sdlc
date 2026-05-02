/**
 * Unit tests for github/client.ts.
 *
 * Verifies token resolution, error mapping (401, 403 with rate-limit, 404,
 * 5xx with retry), and the high-level API shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { OrbitalError } from '@orbital/types'
import { DefaultGithubClient } from '../../../src/github/client.js'
import { GITHUB_ERROR_CODES } from '../../../src/github/types.js'

interface MockResponseInit {
  status?: number
  body?: unknown
  headers?: Record<string, string>
}

function makeResponse(init: MockResponseInit): Response {
  const body =
    init.body === undefined
      ? ''
      : typeof init.body === 'string'
        ? init.body
        : JSON.stringify(init.body)
  return new Response(body, {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
}

describe('DefaultGithubClient', () => {
  let fetchStub: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchStub = vi.fn()
  })

  function makeClient(overrides: Partial<{ fetchImpl: typeof fetch }> = {}) {
    return new DefaultGithubClient({
      token: 'test-token',
      apiUrl: 'https://api.test.example',
      maxRetries: 2,
      baseBackoffMs: 1, // fast retries
      maxBackoffMs: 10,
      fetchImpl: (overrides.fetchImpl ?? (fetchStub as unknown as typeof fetch)),
      sleepFn: () => Promise.resolve(),
    })
  }

  it('uses the explicit token via Authorization: Bearer header', async () => {
    fetchStub.mockResolvedValueOnce(makeResponse({ status: 200, body: { login: 'octocat' } }))
    const c = makeClient()
    const u = await c.getAuthenticatedUser()
    expect(u.login).toBe('octocat')
    const call = fetchStub.mock.calls[0]
    const init = call[1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer test-token')
    expect(headers['Accept']).toBe('application/vnd.github+json')
  })

  it('throws STARTUP_ERROR when no token resolved', async () => {
    const realToken = process.env['GITHUB_API_TOKEN']
    delete process.env['GITHUB_API_TOKEN']
    try {
      const c = new DefaultGithubClient({
        apiUrl: 'https://api.test.example',
        fetchImpl: fetchStub as unknown as typeof fetch,
        sleepFn: () => Promise.resolve(),
      })
      await expect(c.getAuthenticatedUser()).rejects.toThrow(OrbitalError)
      try {
        await c.getAuthenticatedUser()
      } catch (err) {
        expect((err as OrbitalError).code).toBe(GITHUB_ERROR_CODES.STARTUP_ERROR)
      }
    } finally {
      if (realToken !== undefined) process.env['GITHUB_API_TOKEN'] = realToken
    }
  })

  it('throws INTEGRATION_GITHUB_AUTH on 401', async () => {
    fetchStub.mockResolvedValueOnce(makeResponse({ status: 401, body: { message: 'bad' } }))
    const c = makeClient()
    try {
      await c.getAuthenticatedUser()
      expect.fail('expected throw')
    } catch (err) {
      expect((err as OrbitalError).code).toBe(GITHUB_ERROR_CODES.INTEGRATION_GITHUB_AUTH)
    }
  })

  it('throws RATE_LIMIT_GITHUB_API on 403 with x-ratelimit-remaining=0 (after retries)', async () => {
    const rateLimitedResponse = () =>
      new Response('rate limit', {
        status: 403,
        headers: {
          'Content-Type': 'application/json',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 1),
        },
      })
    fetchStub.mockImplementation(() => Promise.resolve(rateLimitedResponse()))
    const c = makeClient()
    try {
      await c.getAuthenticatedUser()
      expect.fail('expected throw')
    } catch (err) {
      expect((err as OrbitalError).code).toBe(GITHUB_ERROR_CODES.RATE_LIMIT_GITHUB_API)
    }
    // should have tried initial + maxRetries (2) more = 3
    expect(fetchStub).toHaveBeenCalledTimes(3)
  })

  it('treats 403 without rate-limit headers as auth failure', async () => {
    fetchStub.mockResolvedValueOnce(
      makeResponse({ status: 403, body: { message: 'forbidden' } }),
    )
    const c = makeClient()
    try {
      await c.getAuthenticatedUser()
      expect.fail('expected throw')
    } catch (err) {
      expect((err as OrbitalError).code).toBe(GITHUB_ERROR_CODES.INTEGRATION_GITHUB_AUTH)
    }
  })

  it('retries on 5xx and eventually succeeds', async () => {
    fetchStub
      .mockResolvedValueOnce(makeResponse({ status: 502 }))
      .mockResolvedValueOnce(makeResponse({ status: 503 }))
      .mockResolvedValueOnce(makeResponse({ status: 200, body: { login: 'octocat' } }))
    const c = makeClient()
    const u = await c.getAuthenticatedUser()
    expect(u.login).toBe('octocat')
    expect(fetchStub).toHaveBeenCalledTimes(3)
  })

  it('throws INTEGRATION_GITHUB_DOWN after exhausting 5xx retries', async () => {
    fetchStub.mockImplementation(() => Promise.resolve(makeResponse({ status: 503 })))
    const c = makeClient()
    try {
      await c.getAuthenticatedUser()
      expect.fail('expected throw')
    } catch (err) {
      expect((err as OrbitalError).code).toBe(GITHUB_ERROR_CODES.INTEGRATION_GITHUB_DOWN)
    }
  })

  it('getRepo returns null on 404', async () => {
    fetchStub.mockResolvedValueOnce(
      makeResponse({ status: 404, body: { message: 'Not Found' } }),
    )
    const c = makeClient()
    const r = await c.getRepo('octo', 'missing')
    expect(r).toBeNull()
  })

  it('getRepo maps Github response on 200', async () => {
    fetchStub.mockResolvedValueOnce(
      makeResponse({
        status: 200,
        body: {
          id: 1,
          name: 'orbital',
          full_name: 'octo/orbital',
          owner: { login: 'octo' },
          private: false,
          default_branch: 'main',
          html_url: 'https://github.com/octo/orbital',
        },
      }),
    )
    const c = makeClient()
    const r = await c.getRepo('octo', 'orbital')
    expect(r).not.toBeNull()
    expect(r!.fullName).toBe('octo/orbital')
    expect(r!.defaultBranch).toBe('main')
    expect(r!.owner.login).toBe('octo')
  })

  it('getBranch returns null on 404', async () => {
    fetchStub.mockResolvedValueOnce(makeResponse({ status: 404, body: {} }))
    const c = makeClient()
    const b = await c.getBranch('octo', 'orbital', 'missing')
    expect(b).toBeNull()
  })

  it('listBranches maps array response', async () => {
    fetchStub.mockResolvedValueOnce(
      makeResponse({
        status: 200,
        body: [
          { name: 'main', commit: { sha: 'abc' }, protected: true },
          { name: 'dev', commit: { sha: 'def' }, protected: false },
        ],
      }),
    )
    const c = makeClient()
    const list = await c.listBranches('octo', 'orbital')
    expect(list).toHaveLength(2)
    expect(list[0]!.name).toBe('main')
    expect(list[0]!.protected).toBe(true)
    expect(list[1]!.commitSha).toBe('def')
  })

  it('createRepo posts to /user/repos when no org', async () => {
    fetchStub.mockResolvedValueOnce(
      makeResponse({
        status: 201,
        body: {
          id: 99,
          name: 'new',
          full_name: 'octo/new',
          owner: { login: 'octo' },
          private: true,
          default_branch: 'main',
          html_url: 'https://github.com/octo/new',
        },
      }),
    )
    const c = makeClient()
    const r = await c.createRepo({ name: 'new', private: true })
    expect(r.fullName).toBe('octo/new')
    const call = fetchStub.mock.calls[0]
    expect(call[0]).toBe('https://api.test.example/user/repos')
    expect((call[1] as RequestInit).method).toBe('POST')
  })

  it('createRepo posts to /orgs/{org}/repos when org provided', async () => {
    fetchStub.mockResolvedValueOnce(
      makeResponse({
        status: 201,
        body: {
          id: 100,
          name: 'foo',
          full_name: 'acme/foo',
          owner: { login: 'acme' },
          private: false,
          default_branch: 'main',
          html_url: 'https://github.com/acme/foo',
        },
      }),
    )
    const c = makeClient()
    await c.createRepo({ org: 'acme', name: 'foo' })
    const call = fetchStub.mock.calls[0]
    expect(call[0]).toBe('https://api.test.example/orgs/acme/repos')
  })

  it('createBranch uses git refs API', async () => {
    fetchStub.mockResolvedValueOnce(
      makeResponse({
        status: 201,
        body: {
          ref: 'refs/heads/feat/x',
          object: { sha: 'newsha' },
        },
      }),
    )
    const c = makeClient()
    const b = await c.createBranch('octo', 'orbital', 'feat/x', 'parentsha')
    expect(b.name).toBe('feat/x')
    expect(b.commitSha).toBe('newsha')
    const call = fetchStub.mock.calls[0]
    const body = JSON.parse((call[1] as RequestInit).body as string)
    expect(body).toEqual({ ref: 'refs/heads/feat/x', sha: 'parentsha' })
  })

  it('throws NOT_FOUND_GITHUB on 404 for endpoints that do not allow 404', async () => {
    fetchStub.mockResolvedValueOnce(
      makeResponse({ status: 404, body: { message: 'Not Found' } }),
    )
    const c = makeClient()
    try {
      await c.listBranches('octo', 'gone')
      expect.fail('expected throw')
    } catch (err) {
      expect((err as OrbitalError).code).toBe(GITHUB_ERROR_CODES.NOT_FOUND_GITHUB)
    }
  })
})
