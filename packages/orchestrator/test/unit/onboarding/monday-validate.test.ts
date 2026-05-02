/**
 * Unit tests for monday-validate.ts.
 *
 * Mocks `fetch` to verify request shape and error handling.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  getMondayValidator,
  setMondayValidator,
} from '../../../src/onboarding/monday-validate.js'

let fetchStub: ReturnType<typeof vi.fn>
const realFetch = globalThis.fetch

beforeEach(() => {
  fetchStub = vi.fn()
  globalThis.fetch = fetchStub as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  setMondayValidator(null)
})

describe('monday-validate', () => {
  it('rejects an empty token', async () => {
    const v = getMondayValidator()
    const r = await v.validate('')
    expect(r.ok).toBe(false)
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it('returns ok with the account name on a valid response', async () => {
    fetchStub.mockResolvedValueOnce(
      new globalThis.Response(
        JSON.stringify({ data: { me: { id: '42', name: 'Alice' } } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    const v = getMondayValidator()
    const r = await v.validate('valid-token')
    expect(r.ok).toBe(true)
    expect(r.accountName).toBe('Alice')
    expect(fetchStub).toHaveBeenCalledWith(
      'https://api.monday.com/v2',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'valid-token' }),
      }),
    )
  })

  it('treats 401 as invalid credentials', async () => {
    fetchStub.mockResolvedValueOnce(
      new globalThis.Response(JSON.stringify({ error_message: 'unauth' }), { status: 401 }),
    )
    const v = getMondayValidator()
    const r = await v.validate('bad')
    expect(r.ok).toBe(false)
    expect(r.message?.toLowerCase()).toContain('invalid')
  })

  it('surfaces a GraphQL errors envelope', async () => {
    fetchStub.mockResolvedValueOnce(
      new globalThis.Response(
        JSON.stringify({ errors: [{ message: 'rate limited' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    const v = getMondayValidator()
    const r = await v.validate('token')
    expect(r.ok).toBe(false)
    expect(r.message).toBe('rate limited')
  })
})
