/**
 * test/unit/hub/auth/clock-drift.test.ts
 *
 * Round 7-03 — Federation Auth (Identity & Pairing)
 * [Engineer-Principal · Opus · run-round7-03-federation-auth]
 *
 * Wall-clock skew tolerance:
 *   - 30s of drift (forward or backward) is acceptable
 *   - Beyond ±60s default, AUTH_TS_EXPIRED is returned
 *   - Custom maxDriftMs can be tightened or loosened for tests
 */

import { describe, it, expect, beforeEach } from 'vitest'
import * as ed from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha512'
import {
  signEnvelope,
  verifyEnvelope,
} from '../../../../src/keys/envelope.js'

ed.etc.sha512Sync = (...messages: Uint8Array[]) =>
  sha512(messages.length === 1 ? (messages[0] as Uint8Array) : ed.etc.concatBytes(...messages))

let priv: Uint8Array
let pub: Uint8Array
let baseTs: number

beforeEach(async () => {
  priv = ed.utils.randomPrivateKey()
  pub = await ed.getPublicKeyAsync(priv)
  baseTs = 1_700_000_000_000 // 2023-11-14 ~22:13 UTC
})

describe('clock drift', () => {
  it('accepts an envelope with 30 seconds of drift (within ±60s default)', async () => {
    const body = new Uint8Array(0)
    const env = await signEnvelope({
      method: 'tasks.list',
      bodyBytes: body,
      privateKey: priv,
      nowMs: baseTs,
    })

    const result = await verifyEnvelope({
      publicKey: pub,
      bodyB64: env.bodyB64,
      signatureB64: env.signatureB64,
      requestBodyBytes: body,
      nowMs: baseTs + 30_000,
    })

    expect(result.ok).toBe(true)
  })

  it('accepts an envelope from 30 seconds in the future', async () => {
    const body = new Uint8Array(0)
    const env = await signEnvelope({
      method: 'tasks.list',
      bodyBytes: body,
      privateKey: priv,
      nowMs: baseTs + 30_000, // future-stamped
    })

    const result = await verifyEnvelope({
      publicKey: pub,
      bodyB64: env.bodyB64,
      signatureB64: env.signatureB64,
      requestBodyBytes: body,
      nowMs: baseTs,
    })

    expect(result.ok).toBe(true)
  })

  it('rejects an envelope with 5 minutes of drift', async () => {
    const body = new Uint8Array(0)
    const env = await signEnvelope({
      method: 'tasks.list',
      bodyBytes: body,
      privateKey: priv,
      nowMs: baseTs,
    })

    const result = await verifyEnvelope({
      publicKey: pub,
      bodyB64: env.bodyB64,
      signatureB64: env.signatureB64,
      requestBodyBytes: body,
      nowMs: baseTs + 5 * 60_000,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('AUTH_TS_EXPIRED')
    }
  })

  it('rejects an envelope from 5 minutes in the past', async () => {
    const body = new Uint8Array(0)
    const env = await signEnvelope({
      method: 'tasks.list',
      bodyBytes: body,
      privateKey: priv,
      nowMs: baseTs - 5 * 60_000,
    })

    const result = await verifyEnvelope({
      publicKey: pub,
      bodyB64: env.bodyB64,
      signatureB64: env.signatureB64,
      requestBodyBytes: body,
      nowMs: baseTs,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('AUTH_TS_EXPIRED')
    }
  })

  it('honours custom maxDriftMs (tighter)', async () => {
    const body = new Uint8Array(0)
    const env = await signEnvelope({
      method: 'tasks.list',
      bodyBytes: body,
      privateKey: priv,
      nowMs: baseTs,
    })

    // 10 seconds of drift, tight limit of 5 seconds → should fail
    const result = await verifyEnvelope({
      publicKey: pub,
      bodyB64: env.bodyB64,
      signatureB64: env.signatureB64,
      requestBodyBytes: body,
      nowMs: baseTs + 10_000,
      maxDriftMs: 5_000,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('AUTH_TS_EXPIRED')
    }
  })
})
