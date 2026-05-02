/**
 * HubTabPairing.test.tsx
 *
 * Round 7-03 — Federation Auth (Identity & Pairing)
 * [Engineer-Principal · Opus · run-round7-03-federation-auth]
 *
 * Pure-logic tests for the JoinHubFlow component used inside HubTab.
 * Mirrors the test pattern of the existing HubTab.test.tsx — no DOM, just
 * the helpers and simulated fetch flow. Real DOM rendering is covered by
 * the E2E tests via the running app.
 */

import { describe, it, expect, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Pure helpers — re-implemented from JoinHubFlow.tsx
// ---------------------------------------------------------------------------

function parseInviteUrl(raw: string): { hubOrigin: string; inviteToken: string } | null {
  try {
    const url = new URL(raw.trim())
    const m = url.pathname.match(/^\/join\/(.+)$/)
    if (!m || !m[1]) return null
    return {
      hubOrigin: `${url.protocol}//${url.host}`,
      inviteToken: m[1],
    }
  } catch {
    return null
  }
}

function canSubmit(inviteUrl: string, status: string): boolean {
  return parseInviteUrl(inviteUrl) !== null && inviteUrl.length > 0 && status !== 'submitting'
}

// ---------------------------------------------------------------------------
// parseInviteUrl
// ---------------------------------------------------------------------------

describe('parseInviteUrl', () => {
  it('extracts origin + token from a valid URL', () => {
    const result = parseInviteUrl('https://orbital.team.dev/join/eyJ0xyz')
    expect(result).not.toBeNull()
    expect(result!.hubOrigin).toBe('https://orbital.team.dev')
    expect(result!.inviteToken).toBe('eyJ0xyz')
  })

  it('handles tokens with multiple dots (JWT format)', () => {
    const result = parseInviteUrl(
      'https://orbital.team.dev/join/eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    )
    expect(result).not.toBeNull()
    expect(result!.inviteToken).toContain('.')
  })

  it('preserves port number on hubOrigin', () => {
    const result = parseInviteUrl('http://localhost:3000/join/abc')
    expect(result!.hubOrigin).toBe('http://localhost:3000')
  })

  it('returns null for non-URL strings', () => {
    expect(parseInviteUrl('not a url')).toBeNull()
    expect(parseInviteUrl('')).toBeNull()
    expect(parseInviteUrl('  ')).toBeNull()
  })

  it('returns null for URLs without /join/ path', () => {
    expect(parseInviteUrl('https://orbital.team.dev')).toBeNull()
    expect(parseInviteUrl('https://orbital.team.dev/something-else/abc')).toBeNull()
  })

  it('returns null for URLs with /join/ but no token', () => {
    expect(parseInviteUrl('https://orbital.team.dev/join/')).toBeNull()
  })

  it('trims whitespace from input', () => {
    const result = parseInviteUrl('  https://hub/join/abc  ')
    expect(result).not.toBeNull()
    expect(result!.inviteToken).toBe('abc')
  })
})

// ---------------------------------------------------------------------------
// canSubmit
// ---------------------------------------------------------------------------

describe('canSubmit gating', () => {
  it('disabled when invite URL is empty', () => {
    expect(canSubmit('', 'idle')).toBe(false)
  })

  it('disabled when invite URL is malformed', () => {
    expect(canSubmit('not-a-url', 'idle')).toBe(false)
  })

  it('disabled while submitting', () => {
    expect(canSubmit('https://hub/join/abc', 'submitting')).toBe(false)
  })

  it('enabled with valid URL and idle status', () => {
    expect(canSubmit('https://hub/join/abc', 'idle')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Proxy-join fetch flow simulation
// ---------------------------------------------------------------------------

interface ProxyJoinResponse {
  ok: true
  install_id: string
  tenant_id: string
  role: 'owner' | 'member' | 'viewer'
  hub_pubkey: string
  hub_url: string
}

interface ProxyJoinErr {
  ok: false
  code: string
  message: string
}

async function postProxyJoin(
  fetchImpl: typeof fetch,
  body: { hub_url: string; invite_token: string; display_name: string },
): Promise<ProxyJoinResponse | ProxyJoinErr> {
  const res = await fetchImpl('/api/hub/proxy-join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return (await res.json()) as ProxyJoinResponse | ProxyJoinErr
}

describe('postProxyJoin fetch flow', () => {
  it('returns ok=true with identity on hub success', async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () =>
        ({
          ok: true,
          install_id: 'install-123',
          tenant_id: 'tenant-abc',
          role: 'member',
          hub_pubkey: 'fingerprint-xyz',
          hub_url: 'https://orbital.team.dev',
        }) satisfies ProxyJoinResponse,
    })

    const result = await postProxyJoin(fakeFetch as unknown as typeof fetch, {
      hub_url: 'https://orbital.team.dev',
      invite_token: 'tok',
      display_name: 'matt-laptop',
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.install_id).toBe('install-123')
      expect(result.role).toBe('member')
    }
    expect(fakeFetch).toHaveBeenCalledWith(
      '/api/hub/proxy-join',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('returns the hub error on registration failure', async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () =>
        ({
          ok: false,
          code: 'AUTH_INVITE_ALREADY_USED',
          message: 'invite token has already been redeemed',
        }) satisfies ProxyJoinErr,
    })

    const result = await postProxyJoin(fakeFetch as unknown as typeof fetch, {
      hub_url: 'https://orbital.team.dev',
      invite_token: 'tok',
      display_name: 'matt-laptop',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('AUTH_INVITE_ALREADY_USED')
    }
  })
})

// ---------------------------------------------------------------------------
// Status transitions (state-machine view of JoinHubFlow's internal state)
// ---------------------------------------------------------------------------

type Status =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'success'; result: ProxyJoinResponse }
  | { kind: 'error'; error: ProxyJoinErr }

function reducer(state: Status, action: { type: string; payload?: unknown }): Status {
  switch (action.type) {
    case 'submit':
      return { kind: 'submitting' }
    case 'success':
      return { kind: 'success', result: action.payload as ProxyJoinResponse }
    case 'error':
      return { kind: 'error', error: action.payload as ProxyJoinErr }
    default:
      return state
  }
}

describe('JoinHubFlow state transitions', () => {
  it('transitions idle → submitting → success', () => {
    let s: Status = { kind: 'idle' }
    s = reducer(s, { type: 'submit' })
    expect(s.kind).toBe('submitting')
    s = reducer(s, {
      type: 'success',
      payload: {
        ok: true,
        install_id: 'i',
        tenant_id: 't',
        role: 'member',
        hub_pubkey: 'fp',
        hub_url: 'https://x',
      } satisfies ProxyJoinResponse,
    })
    expect(s.kind).toBe('success')
    if (s.kind === 'success') {
      expect(s.result.role).toBe('member')
    }
  })

  it('transitions idle → submitting → error', () => {
    let s: Status = { kind: 'idle' }
    s = reducer(s, { type: 'submit' })
    s = reducer(s, {
      type: 'error',
      payload: { ok: false, code: 'AUTH_INVITE_EXPIRED', message: 'expired' } satisfies ProxyJoinErr,
    })
    expect(s.kind).toBe('error')
    if (s.kind === 'error') {
      expect(s.error.code).toBe('AUTH_INVITE_EXPIRED')
    }
  })
})
