/**
 * test/unit/hub/auth/nonce-replay.test.ts
 *
 * Round 7-03 — Federation Auth (Identity & Pairing)
 * [Engineer-Principal · Opus · run-round7-03-federation-auth]
 *
 * NonceLru replay-window behaviour:
 *   - First sighting accepted, second sighting rejected within TTL
 *   - After TTL expires, the same nonce can be re-recorded (a stale nonce
 *     would fail the ts-skew check anyway, so this is safe)
 *   - Capacity bound is honoured: when full, oldest entry is evicted
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { NonceLru } from '../../../../src/keys/envelope.js'

let lru: NonceLru

beforeEach(() => {
  lru = new NonceLru({ capacity: 4, ttlMs: 1_000 })
})

describe('NonceLru', () => {
  it('accepts a fresh nonce on first sighting', () => {
    expect(lru.recordIfFresh('nonce-A')).toBe(true)
  })

  it('rejects a replayed nonce within the TTL window', () => {
    expect(lru.recordIfFresh('nonce-A', 1_000)).toBe(true)
    expect(lru.recordIfFresh('nonce-A', 1_500)).toBe(false)
  })

  it('accepts a previously-seen nonce after the TTL window has passed', () => {
    expect(lru.recordIfFresh('nonce-A', 1_000)).toBe(true)
    // 1_000 + ttl 1_000 = 2_000 → at 2_001 the entry is expired
    expect(lru.recordIfFresh('nonce-A', 2_001)).toBe(true)
  })

  it('honours capacity by evicting the oldest entry', () => {
    expect(lru.recordIfFresh('A', 1_000)).toBe(true)
    expect(lru.recordIfFresh('B', 1_001)).toBe(true)
    expect(lru.recordIfFresh('C', 1_002)).toBe(true)
    expect(lru.recordIfFresh('D', 1_003)).toBe(true)
    // A capacity of 4 → adding E should evict A (oldest)
    expect(lru.recordIfFresh('E', 1_004)).toBe(true)
    // Re-attempting A within TTL should now succeed because A was evicted
    expect(lru.recordIfFresh('A', 1_005)).toBe(true)
    // C is still within TTL and was NOT evicted (only oldest is bumped)
    expect(lru.recordIfFresh('C', 1_006)).toBe(false)
  })

  it('size() reports the live entry count', () => {
    expect(lru.size()).toBe(0)
    lru.recordIfFresh('a')
    lru.recordIfFresh('b')
    expect(lru.size()).toBe(2)
  })

  it('clear() empties the LRU', () => {
    lru.recordIfFresh('x')
    lru.clear()
    expect(lru.size()).toBe(0)
    expect(lru.recordIfFresh('x')).toBe(true)
  })
})
