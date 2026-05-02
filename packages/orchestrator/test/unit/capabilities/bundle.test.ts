/**
 * bundle.test.ts — sign / verify round-trip + tamper / TTL detection.
 *
 * These tests use real Ed25519 from @noble/ed25519 + a stub KeyManager.
 * No DB writes for the pure-signature tests; revocation tests use the
 * full integration test suite.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { uuidv7 } from 'uuidv7'
import * as ed from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha512'

import { signBundle, verifyBundleSignatureOnly, bundleHash } from '../../../src/capabilities/bundle.js'
import { canonicalJson } from '../../../src/capabilities/canonical-json.js'
import type { CapabilityBundleUnsigned } from '@orbital/types'
import type { KeyManager, SubKey } from '../../../src/capabilities/keys.js'

beforeAll(() => {
  ed.etc.sha512Sync = (...messages: Uint8Array[]) =>
    sha512(messages.length === 1 ? (messages[0] as Uint8Array) : ed.etc.concatBytes(...messages))
  ed.etc.sha512Async = async (...messages: Uint8Array[]) =>
    sha512(messages.length === 1 ? (messages[0] as Uint8Array) : ed.etc.concatBytes(...messages))
})

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

function unsignedBundle(signingKeyId: string): CapabilityBundleUnsigned {
  const now = new Date()
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
      board_read: ['ticket:ORB-1'],
      board_mutate: [],
      channel_read: ['#sprint-1'],
      channel_post: [],
      secrets: [],
      network_egress: ['api.anthropic.com'],
      spawn_subagent: false,
      git_commit: [],
      ceremony_role: [],
    },
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 60_000).toISOString(),
    signing_key_id: signingKeyId,
    schema_version: 1,
  }
}

describe('canonical JSON', () => {
  it('produces stable output regardless of key insertion order', () => {
    const a = canonicalJson({ b: 1, a: 2 })
    const b = canonicalJson({ a: 2, b: 1 })
    expect(a).toBe(b)
    expect(a).toBe('{"a":2,"b":1}')
  })

  it('drops undefined fields', () => {
    const out = canonicalJson({ a: 1, b: undefined as unknown as number })
    expect(out).toBe('{"a":1}')
  })
})

describe('signBundle / verifyBundleSignatureOnly', () => {
  it('round-trips a real Ed25519 signature', async () => {
    const key = await makeFakeKey()
    const km = fakeKeyManager(key)
    const unsigned = unsignedBundle(key.keyId)
    const signed = await signBundle(unsigned, km)
    expect(signed.signature.length).toBeGreaterThan(0)

    const r = await verifyBundleSignatureOnly(signed, key.publicKey)
    expect(r.ok).toBe(true)
  })

  it('rejects a tampered bundle', async () => {
    const key = await makeFakeKey()
    const km = fakeKeyManager(key)
    const unsigned = unsignedBundle(key.keyId)
    const signed = await signBundle(unsigned, km)

    const tampered = { ...signed, persona_id: 'attacker' }
    const r = await verifyBundleSignatureOnly(tampered, key.publicKey)
    expect(r.ok).toBe(false)
    expect(r.reasonCode).toBe('AUTH_INVALID_SIGNATURE')
  })

  it('rejects a malformed bundle (shape error)', async () => {
    const key = await makeFakeKey()
    const r = await verifyBundleSignatureOnly({ not: 'a bundle' }, key.publicKey)
    expect(r.ok).toBe(false)
    expect(r.reasonCode).toBe('AUTH_INVALID_CAPABILITY_FORMAT')
  })

  it('produces a stable bundle hash for canonical input', async () => {
    const key = await makeFakeKey()
    const km = fakeKeyManager(key)
    const unsigned = unsignedBundle(key.keyId)
    const signed = await signBundle(unsigned, km)

    const h1 = bundleHash(unsigned)
    const sameUnsigned = { ...signed }
    delete (sameUnsigned as Record<string, unknown>)['signature']
    const h2 = bundleHash(sameUnsigned as CapabilityBundleUnsigned)
    expect(h1).toBe(h2)
    expect(h1).toMatch(/^[0-9a-f]{64}$/)
  })
})
