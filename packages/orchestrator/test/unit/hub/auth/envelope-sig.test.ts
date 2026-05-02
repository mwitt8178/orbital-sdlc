/**
 * test/unit/hub/auth/envelope-sig.test.ts
 *
 * Round 7-03 — Federation Auth (Identity & Pairing)
 * [Engineer-Principal · Opus · run-round7-03-federation-auth]
 *
 * Round-trip + tampering tests for signEnvelope/verifyEnvelope.
 * No network, no DB — pure crypto over real @noble/ed25519.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import * as ed from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha512'
import {
  signEnvelope,
  verifyEnvelope,
  bytesToBase64Url,
  base64UrlToBytes,
  freshNonce,
  sha256Hex,
} from '../../../../src/keys/envelope.js'

// Wire SHA-512 in case envelope module hasn't been loaded by anything else.
ed.etc.sha512Sync = (...messages: Uint8Array[]) =>
  sha512(messages.length === 1 ? (messages[0] as Uint8Array) : ed.etc.concatBytes(...messages))

let priv: Uint8Array
let pub: Uint8Array

beforeEach(async () => {
  priv = ed.utils.randomPrivateKey()
  pub = await ed.getPublicKeyAsync(priv)
})

describe('signEnvelope/verifyEnvelope round-trip', () => {
  it('verifies a freshly signed envelope', async () => {
    const body = new TextEncoder().encode('{"task_id":"abc"}')
    const env = await signEnvelope({
      method: 'tasks.list',
      bodyBytes: body,
      privateKey: priv,
    })

    const result = await verifyEnvelope({
      publicKey: pub,
      bodyB64: env.bodyB64,
      signatureB64: env.signatureB64,
      requestBodyBytes: body,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.body.method).toBe('tasks.list')
      expect(result.body.params_hash).toBe(sha256Hex(body))
    }
  })

  it('verifies an empty-body request', async () => {
    const empty = new Uint8Array(0)
    const env = await signEnvelope({
      method: 'health.check',
      bodyBytes: empty,
      privateKey: priv,
    })

    const result = await verifyEnvelope({
      publicKey: pub,
      bodyB64: env.bodyB64,
      signatureB64: env.signatureB64,
      requestBodyBytes: empty,
    })

    expect(result.ok).toBe(true)
  })

  it('rejects when sig was made with a different private key', async () => {
    const otherPriv = ed.utils.randomPrivateKey()
    const body = new TextEncoder().encode('{"foo":"bar"}')
    const env = await signEnvelope({
      method: 'tasks.list',
      bodyBytes: body,
      privateKey: otherPriv,
    })

    const result = await verifyEnvelope({
      publicKey: pub,
      bodyB64: env.bodyB64,
      signatureB64: env.signatureB64,
      requestBodyBytes: body,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('AUTH_SIG_INVALID')
    }
  })

  it('rejects when the request body has been tampered', async () => {
    const body = new TextEncoder().encode('{"amount":100}')
    const env = await signEnvelope({
      method: 'transfers.create',
      bodyBytes: body,
      privateKey: priv,
    })

    const tampered = new TextEncoder().encode('{"amount":999}')
    const result = await verifyEnvelope({
      publicKey: pub,
      bodyB64: env.bodyB64,
      signatureB64: env.signatureB64,
      requestBodyBytes: tampered,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('AUTH_PARAMS_MISMATCH')
    }
  })

  it('rejects when the signature bytes have been mangled', async () => {
    const body = new TextEncoder().encode('{}')
    const env = await signEnvelope({
      method: 'tasks.list',
      bodyBytes: body,
      privateKey: priv,
    })

    // Flip one byte of the signature
    const sigBytes = base64UrlToBytes(env.signatureB64)
    sigBytes[0] = sigBytes[0]! ^ 0xff
    const mangled = bytesToBase64Url(sigBytes)

    const result = await verifyEnvelope({
      publicKey: pub,
      bodyB64: env.bodyB64,
      signatureB64: mangled,
      requestBodyBytes: body,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('AUTH_SIG_INVALID')
    }
  })

  it('rejects when sig-body is malformed JSON', async () => {
    const body = new Uint8Array(0)
    const garbage = bytesToBase64Url(new TextEncoder().encode('not-json{['))

    const result = await verifyEnvelope({
      publicKey: pub,
      bodyB64: garbage,
      signatureB64: 'AAAA',
      requestBodyBytes: body,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('AUTH_BODY_MALFORMED')
    }
  })

  it('rejects when sig-body is missing required fields', async () => {
    const body = new Uint8Array(0)
    const partial = bytesToBase64Url(new TextEncoder().encode('{"method":"x"}'))

    const result = await verifyEnvelope({
      publicKey: pub,
      bodyB64: partial,
      signatureB64: 'AAAA',
      requestBodyBytes: body,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('AUTH_BODY_MALFORMED')
    }
  })
})

describe('helpers', () => {
  it('bytesToBase64Url round-trips through base64UrlToBytes', () => {
    const original = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255])
    const b64 = bytesToBase64Url(original)
    const back = base64UrlToBytes(b64)
    expect(Array.from(back)).toEqual(Array.from(original))
  })

  it('base64url has no padding chars', () => {
    const buf = new Uint8Array(17) // length not divisible by 3 → padding in plain base64
    const b64 = bytesToBase64Url(buf)
    expect(b64).not.toMatch(/=/)
  })

  it('freshNonce yields unique values', () => {
    const a = freshNonce()
    const b = freshNonce()
    expect(a).not.toBe(b)
    expect(a.length).toBeGreaterThanOrEqual(20) // 16 bytes → 22 chars base64url
  })

  it('sha256Hex is hex-encoded and length 64', () => {
    const h = sha256Hex(new TextEncoder().encode('hello'))
    expect(h).toHaveLength(64)
    expect(h).toMatch(/^[0-9a-f]+$/)
  })
})
