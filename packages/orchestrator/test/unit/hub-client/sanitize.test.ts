/**
 * test/unit/hub-client/sanitize.test.ts
 *
 * Round 7-05 — sanitiser unit tests.
 * [Engineer-Principal · Opus · run-round7-05-local-only-isolation]
 *
 * Each rejection rule has a positive (legitimate request passes) and negative
 * (sensitive request rejected) case. The sanitiser MUST throw
 * `LocalDataLeakError` on a hit; we assert on `instanceof` to keep error
 * handling explicit at the wire boundary.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  sanitizeForHub,
  LocalDataLeakError,
  setKnownAnthropicKeyPrefix,
  resetSanitizerState,
} from '../../../src/hub-client/sanitize.js'

beforeEach(() => {
  resetSanitizerState()
})

// ---------------------------------------------------------------------------
// Field-name pattern rejections
// ---------------------------------------------------------------------------

describe('sanitizeForHub — field-name patterns', () => {
  const cases = [
    { name: 'api_key', body: { api_key: 'whatever' } },
    { name: 'API_KEY uppercase', body: { API_KEY: 'whatever' } },
    { name: 'apiKey camelCase', body: { apiKey: 'whatever' } },
    { name: 'api-token kebab', body: { 'api-token': 'whatever' } },
    { name: 'anthropic literal', body: { anthropic_key: 'whatever' } },
    { name: 'secret nested', body: { config: { secret: 'whatever' } } },
    { name: 'private_key snake', body: { private_key: 'whatever' } },
    { name: 'privKey camelCase', body: { privKey: 'whatever' } },
    { name: 'passphrase', body: { passphrase: 'whatever' } },
    { name: 'stdout buffer', body: { stdout: 'lots of bytes' } },
    { name: 'stderr_tail', body: { stderr_tail: 'bytes' } },
  ]

  for (const { name, body } of cases) {
    it(`rejects field name: ${name}`, () => {
      expect(() => sanitizeForHub(body)).toThrow(LocalDataLeakError)
    })
  }

  it('passes a benign payload through', () => {
    const body = { event_type: 'TaskClaimed', actor: { type: 'user' }, payload: { taskId: 't1' } }
    expect(() => sanitizeForHub(body)).not.toThrow()
  })

  it('passes payload with unrelated key like `name` through', () => {
    const body = { name: 'sprint-1', description: 'Initial sprint' }
    expect(() => sanitizeForHub(body)).not.toThrow()
  })

  it('rejects deeply nested sensitive field', () => {
    const body = {
      level1: { level2: { level3: { api_key: 'sneaky' } } },
    }
    expect(() => sanitizeForHub(body)).toThrow(LocalDataLeakError)
  })

  it('rejects sensitive field inside an array', () => {
    const body = {
      items: [{ ok: 'ok' }, { secret: 'oops' }],
    }
    expect(() => sanitizeForHub(body)).toThrow(LocalDataLeakError)
  })

  it('error reports which field triggered rejection', () => {
    const body = { foo: { bar: { api_key: 'x' } } }
    try {
      sanitizeForHub(body)
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(LocalDataLeakError)
      const e = err as LocalDataLeakError
      expect(e.path).toContain('foo.bar.api_key')
      expect(e.reason).toContain('field-name')
    }
  })
})

// ---------------------------------------------------------------------------
// Anthropic key prefix value rejections
// ---------------------------------------------------------------------------

describe('sanitizeForHub — Anthropic key prefix', () => {
  it('rejects sk-ant- prefix anywhere in payload values', () => {
    const body = { payload: { msg: 'My key is sk-ant-actual-key-123' } }
    expect(() => sanitizeForHub(body)).toThrow(LocalDataLeakError)
  })

  it('rejects sk-ant- in deeply-nested string', () => {
    const body = { a: { b: ['ok', 'sk-ant-leaked-key'] } }
    expect(() => sanitizeForHub(body)).toThrow(LocalDataLeakError)
  })

  it('rejects exact known prefix when configured', () => {
    setKnownAnthropicKeyPrefix('sk-ant-api03-special-prefix')
    const body = { msg: 'leaked: sk-ant-api03-special-prefix-xxxx' }
    expect(() => sanitizeForHub(body)).toThrow(LocalDataLeakError)
  })

  it('passes a payload without sensitive prefixes', () => {
    const body = { msg: 'all good here', count: 42 }
    expect(() => sanitizeForHub(body)).not.toThrow()
  })

  it('rejects sk- literal that looks like an OpenAI key', () => {
    const body = { msg: 'leaked sk-proj-1234567890abcdef key' }
    expect(() => sanitizeForHub(body)).toThrow(LocalDataLeakError)
  })

  it('does not false-positive on words containing sk in them', () => {
    const body = { msg: 'asks the user', rationale: 'task list' }
    expect(() => sanitizeForHub(body)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Local path rejections
// ---------------------------------------------------------------------------

describe('sanitizeForHub — local-only path values', () => {
  it('rejects a value pointing into ~/.orbital/keys/', () => {
    const body = { path: '/Users/me/.orbital/keys/install.json' }
    expect(() => sanitizeForHub(body)).toThrow(LocalDataLeakError)
  })

  it('rejects a value pointing into ~/.orbital/replays/', () => {
    const body = { ref: '/Users/me/.orbital/replays/2026-05-02/abc.bin' }
    expect(() => sanitizeForHub(body)).toThrow(LocalDataLeakError)
  })

  it('rejects file:// URI pointing into orbital keys dir', () => {
    const body = { uri: 'file:///Users/me/.orbital/keys/x.json' }
    expect(() => sanitizeForHub(body)).toThrow(LocalDataLeakError)
  })

  it('passes a generic path', () => {
    const body = { path: '/tmp/scratch.txt' }
    expect(() => sanitizeForHub(body)).not.toThrow()
  })

  it('passes /Users/me/Documents/foo without the orbital marker', () => {
    const body = { path: '/Users/me/Documents/foo.md' }
    expect(() => sanitizeForHub(body)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('sanitizeForHub — edge cases', () => {
  it('handles null body without throwing', () => {
    expect(() => sanitizeForHub(null)).not.toThrow()
  })

  it('handles primitive body without throwing', () => {
    expect(() => sanitizeForHub(42)).not.toThrow()
    expect(() => sanitizeForHub('hello')).not.toThrow()
    expect(() => sanitizeForHub(true)).not.toThrow()
  })

  it('handles empty object', () => {
    expect(() => sanitizeForHub({})).not.toThrow()
  })

  it('handles arrays as top-level', () => {
    expect(() => sanitizeForHub([{ ok: 1 }, { ok: 2 }])).not.toThrow()
  })

  it('rejects sensitive field at array root', () => {
    expect(() => sanitizeForHub([{ secret: 'x' }])).toThrow(LocalDataLeakError)
  })

  it('handles large/wide objects without crashing', () => {
    const body: Record<string, unknown> = {}
    for (let i = 0; i < 1_000; i++) body[`field_${i}`] = `value_${i}`
    expect(() => sanitizeForHub(body)).not.toThrow()
  })

  it('LocalDataLeakError preserves path info as machine-readable property', () => {
    try {
      sanitizeForHub({ foo: { secret: 'x' } })
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(LocalDataLeakError)
      const e = err as LocalDataLeakError
      expect(e.path).toBe('foo.secret')
      expect(typeof e.reason).toBe('string')
    }
  })
})
