/**
 * bundle-clock-skew.test.ts — Tests for clock-drift tolerance in verifyBundle.
 *
 * Gap O8: Capability TTL clock-drift tolerance.
 *
 * Proves:
 * - A bundle issued 10s in the future verifies successfully (within default 30s tolerance).
 * - A bundle issued 60s in the future fails (exceeds default 30s tolerance).
 * - Custom clockSkewMs override works correctly.
 * - Expiry tolerance extends the acceptance window by clockSkewMs.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { uuidv7 } from 'uuidv7'
import * as ed from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha512'

import {
  signBundle,
  verifyBundle,
  CLOCK_SKEW_TOLERANCE_MS,
} from '../../../src/capabilities/bundle.js'
import type { CapabilityBundleUnsigned } from '@orbital/types'
import type { KeyManager, SubKey } from '../../../src/capabilities/keys.js'

beforeAll(() => {
  ed.etc.sha512Sync = (...messages: Uint8Array[]) =>
    sha512(messages.length === 1 ? (messages[0] as Uint8Array) : ed.etc.concatBytes(...messages))
  ed.etc.sha512Async = async (...messages: Uint8Array[]) =>
    sha512(messages.length === 1 ? (messages[0] as Uint8Array) : ed.etc.concatBytes(...messages))
})

// ---------------------------------------------------------------------------
// Helpers (duplicated from bundle.test.ts — keeps tests independent)
// ---------------------------------------------------------------------------

interface FakeKey {
  keyId: string
  privateKey: Uint8Array
  publicKey: Uint8Array
}

async function makeFakeKey(): Promise<FakeKey> {
  const privateKey = ed.utils.randomPrivateKey()
  const publicKey = await ed.getPublicKeyAsync(privateKey)
  return { keyId: uuidv7(), privateKey, publicKey }
}

function fakeKeyManager(key: FakeKey): KeyManager {
  return {
    async signWithSubKey(_keyId: string, message: Uint8Array) {
      const sig = await ed.signAsync(message, key.privateKey)
      return { signature: Buffer.from(sig).toString('base64'), signingKeyId: key.keyId }
    },
    async getSubKeyById(keyId: string): Promise<SubKey | null> {
      if (keyId !== key.keyId) return null
      return {
        keyId: key.keyId,
        parentKeyId: 'fake-master',
        publicKey: key.publicKey,
        installId: 'install',
        sprintId: 'sprint',
        parentSignature: '',
        createdAt: new Date(0).toISOString(),
        activeFrom: new Date(0).toISOString(),
        activeUntil: null,
        status: 'active',
      }
    },
    async verifySubKeyChain(_keyId: string, _at: string) {
      return true
    },
  } as unknown as KeyManager
}

function makeBundle(
  signingKeyId: string,
  offsetMs: number,
  ttlMs = 60_000,
): CapabilityBundleUnsigned {
  const issuedAt = new Date(Date.now() + offsetMs)
  const expiresAt = new Date(issuedAt.getTime() + ttlMs)
  return {
    capability_id: uuidv7(),
    install_id: uuidv7(),
    sprint_id: uuidv7(),
    task_id: uuidv7(),
    persona_id: 'senior-developer',
    session_id: uuidv7(),
    scopes: {
      files_read: ['src/**'],
      files_write: [],
      board_read: [],
      board_mutate: [],
      channel_read: [],
      channel_post: [],
      secrets: [],
      network_egress: [],
      spawn_subagent: false,
      git_commit: [],
      ceremony_role: [],
    },
    issued_at: issuedAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    signing_key_id: signingKeyId,
    schema_version: 1,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CLOCK_SKEW_TOLERANCE_MS', () => {
  it('defaults to 30 seconds', () => {
    expect(CLOCK_SKEW_TOLERANCE_MS).toBe(30_000)
  })
})

describe('verifyBundle — clock-skew tolerance', () => {
  it('accepts a bundle issued 10s in the future (within default 30s tolerance)', async () => {
    const key = await makeFakeKey()
    const km = fakeKeyManager(key)
    const unsigned = makeBundle(key.keyId, 10_000) // issued 10s in the future
    const signed = await signBundle(unsigned, km)

    const now = new Date() // current time
    const result = await verifyBundle(signed, km, now)

    expect(result.ok).toBe(true)
  })

  it('rejects a bundle issued 60s in the future (exceeds default 30s tolerance)', async () => {
    const key = await makeFakeKey()
    const km = fakeKeyManager(key)
    const unsigned = makeBundle(key.keyId, 60_000) // issued 60s in the future
    const signed = await signBundle(unsigned, km)

    const now = new Date()
    const result = await verifyBundle(signed, km, now)

    expect(result.ok).toBe(false)
    expect(result.reasonCode).toBe('AUTH_CAPABILITY_NOT_YET_VALID')
  })

  it('accepts a bundle expired 10s ago (within default 30s expiry tolerance)', async () => {
    const key = await makeFakeKey()
    const km = fakeKeyManager(key)
    // Issued 120s ago, TTL 110s → expired 10s ago
    const unsigned = makeBundle(key.keyId, -120_000, 110_000)
    const signed = await signBundle(unsigned, km)

    const now = new Date()
    const result = await verifyBundle(signed, km, now)

    expect(result.ok).toBe(true)
  })

  it('rejects a bundle expired 60s ago (exceeds default 30s expiry tolerance)', async () => {
    const key = await makeFakeKey()
    const km = fakeKeyManager(key)
    // Issued 130s ago, TTL 70s → expired 60s ago
    const unsigned = makeBundle(key.keyId, -130_000, 70_000)
    const signed = await signBundle(unsigned, km)

    const now = new Date()
    const result = await verifyBundle(signed, km, now)

    expect(result.ok).toBe(false)
    expect(result.reasonCode).toBe('AUTH_CAPABILITY_EXPIRED')
  })

  it('custom clockSkewMs=0 (strict mode) rejects a bundle issued 1ms in the future', async () => {
    const key = await makeFakeKey()
    const km = fakeKeyManager(key)
    const unsigned = makeBundle(key.keyId, 1_000) // issued 1s in the future
    const signed = await signBundle(unsigned, km)

    const now = new Date()
    const result = await verifyBundle(signed, km, now, { clockSkewMs: 0 })

    expect(result.ok).toBe(false)
    expect(result.reasonCode).toBe('AUTH_CAPABILITY_NOT_YET_VALID')
  })

  it('custom clockSkewMs=120000 allows a bundle issued 90s in the future', async () => {
    const key = await makeFakeKey()
    const km = fakeKeyManager(key)
    const unsigned = makeBundle(key.keyId, 90_000) // issued 90s in the future
    const signed = await signBundle(unsigned, km)

    const now = new Date()
    const result = await verifyBundle(signed, km, now, { clockSkewMs: 120_000 })

    expect(result.ok).toBe(true)
  })

  it('error detail includes clock_skew_tolerance_ms when rejecting', async () => {
    const key = await makeFakeKey()
    const km = fakeKeyManager(key)
    const unsigned = makeBundle(key.keyId, 60_000) // 60s future → exceeds default 30s
    const signed = await signBundle(unsigned, km)

    const now = new Date()
    const result = await verifyBundle(signed, km, now)

    expect(result.reasonDetail).toContain('clock_skew_tolerance_ms=30000')
  })
})
