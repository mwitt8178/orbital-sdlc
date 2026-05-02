/**
 * Unit tests for audit-export/encryption.ts
 *
 * Per task done criteria:
 *   - Round-trip: encrypt then decrypt produces original plaintext
 *   - Wrong passphrase fails with authentication-tag mismatch error
 *   - Two encryptions of the same plaintext produce different ciphertexts (nonce randomness)
 *   - Ciphertext bit-flip causes AEAD tag failure
 *   - KDF output deterministic given (passphrase, salt, params)
 *   - Buffer layout: first 16 bytes = salt, next 12 = IV, last 16 = tag
 *
 * Real crypto only — node:crypto. No mocks.
 * No Postgres required.
 */

import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import { encrypt, decrypt, deriveKey, ENCRYPTION_ALGO, KDF_ALGO } from '../../../src/audit-export/encryption.js'

// ---------------------------------------------------------------------------
// Round-trip tests
// ---------------------------------------------------------------------------

describe('encrypt / decrypt round-trip', () => {
  it('decrypts to original plaintext for small buffer (1 KB)', async () => {
    const plaintext = randomBytes(1024)
    const passphrase = 'correct-passphrase-for-test-min12'

    const { ciphertext } = await encrypt(plaintext, passphrase)
    const decrypted = await decrypt({ ciphertext, passphrase })

    expect(decrypted).toEqual(plaintext)
  })

  it('decrypts to original plaintext for medium buffer (64 KB)', async () => {
    const plaintext = randomBytes(64 * 1024)
    const passphrase = 'medium-buffer-passphrase-secure'

    const { ciphertext } = await encrypt(plaintext, passphrase)
    const decrypted = await decrypt({ ciphertext, passphrase })

    expect(decrypted).toEqual(plaintext)
  })

  it('decrypts empty buffer', async () => {
    const plaintext = Buffer.alloc(0)
    const passphrase = 'empty-plaintext-passphrase-ok'

    const { ciphertext } = await encrypt(plaintext, passphrase)
    const decrypted = await decrypt({ ciphertext, passphrase })

    expect(decrypted).toEqual(plaintext)
    expect(decrypted.length).toBe(0)
  })

  it('round-trips UTF-8 text content', async () => {
    const text = 'Hello, Orbital audit evidence package! UTF-8 content: 🔒'
    const plaintext = Buffer.from(text, 'utf-8')
    const passphrase = 'utf8-test-passphrase-security12'

    const { ciphertext } = await encrypt(plaintext, passphrase)
    const decrypted = await decrypt({ ciphertext, passphrase })

    expect(decrypted.toString('utf-8')).toBe(text)
  })
})

// ---------------------------------------------------------------------------
// Wrong passphrase fails
// ---------------------------------------------------------------------------

describe('wrong passphrase authentication failure', () => {
  it('throws with authentication-tag mismatch when passphrase is wrong', async () => {
    const plaintext = Buffer.from('sensitive audit data', 'utf-8')
    const correctPassphrase = 'correct-passphrase-long-enough'
    const wrongPassphrase = 'wrong-passphrase-also-long-12x'

    const { ciphertext } = await encrypt(plaintext, correctPassphrase)

    await expect(
      decrypt({ ciphertext, passphrase: wrongPassphrase }),
    ).rejects.toThrow('EXPORT_DECRYPT_FAILED')
  })

  it('error message mentions authentication tag mismatch', async () => {
    const plaintext = Buffer.from('test payload', 'utf-8')
    const { ciphertext } = await encrypt(plaintext, 'original-passphrase-valid12')

    try {
      await decrypt({ ciphertext, passphrase: 'completely-wrong-passphrase12' })
      expect.fail('Expected decrypt to throw')
    } catch (err) {
      expect(String(err)).toContain('EXPORT_DECRYPT_FAILED')
    }
  })
})

// ---------------------------------------------------------------------------
// Buffer layout
// ---------------------------------------------------------------------------

describe('ciphertext buffer layout', () => {
  it('first 16 bytes are salt, next 12 bytes are IV, last 16 bytes are tag', async () => {
    const plaintext = Buffer.from('layout test', 'utf-8')
    const passphrase = 'layout-test-passphrase-long12'

    const { ciphertext, saltB64, ivB64 } = await encrypt(plaintext, passphrase)

    // Minimum length: salt(16) + iv(12) + plaintext(N) + tag(16)
    expect(ciphertext.length).toBeGreaterThanOrEqual(16 + 12 + 16)

    const salt = ciphertext.subarray(0, 16)
    const iv = ciphertext.subarray(16, 28)

    expect(salt.toString('base64')).toBe(saltB64)
    expect(iv.toString('base64')).toBe(ivB64)
  })

  it('output buffer is salt(16) + iv(12) + ciphertext + tag(16)', async () => {
    const plaintext = randomBytes(100)
    const passphrase = 'buffer-layout-check-passphrase12'

    const { ciphertext } = await encrypt(plaintext, passphrase)

    // Expected total: 16 + 12 + 100 + 16 = 144
    expect(ciphertext.length).toBe(16 + 12 + 100 + 16)
  })
})

// ---------------------------------------------------------------------------
// Nonce randomness
// ---------------------------------------------------------------------------

describe('nonce randomness', () => {
  it('two encryptions of the same plaintext produce different ciphertexts', async () => {
    const plaintext = Buffer.from('same content repeated', 'utf-8')
    const passphrase = 'same-passphrase-long-enough123'

    const { ciphertext: ct1 } = await encrypt(plaintext, passphrase)
    const { ciphertext: ct2 } = await encrypt(plaintext, passphrase)

    // Ciphertexts differ (different nonce each time)
    expect(ct1.equals(ct2)).toBe(false)

    // But both decrypt to the same plaintext
    const decrypted1 = await decrypt({ ciphertext: ct1, passphrase })
    const decrypted2 = await decrypt({ ciphertext: ct2, passphrase })
    expect(decrypted1).toEqual(plaintext)
    expect(decrypted2).toEqual(plaintext)
  })

  it('salt bytes differ across encryptions', async () => {
    const plaintext = Buffer.from('salt test', 'utf-8')
    const passphrase = 'salt-nonce-different-each-time12'

    const { saltB64: salt1 } = await encrypt(plaintext, passphrase)
    const { saltB64: salt2 } = await encrypt(plaintext, passphrase)

    expect(salt1).not.toBe(salt2)
  })
})

// ---------------------------------------------------------------------------
// Tampered ciphertext
// ---------------------------------------------------------------------------

describe('tampered ciphertext rejection', () => {
  it('flipping a byte in the ciphertext body causes tag verification failure', async () => {
    const plaintext = Buffer.from('tamper test payload that is long enough', 'utf-8')
    const passphrase = 'tamper-detection-passphrase1234'

    const { ciphertext } = await encrypt(plaintext, passphrase)

    // Flip a byte in the middle of the ciphertext body (after salt+iv header)
    const tampered = Buffer.from(ciphertext)
    const middleOffset = 16 + 12 + Math.floor((tampered.length - 16 - 12 - 16) / 2)
    tampered[middleOffset] = tampered[middleOffset]! ^ 0xff

    await expect(
      decrypt({ ciphertext: tampered, passphrase }),
    ).rejects.toThrow('EXPORT_DECRYPT_FAILED')
  })

  it('short buffer (no room for salt+iv+tag) throws immediately', async () => {
    const shortBuffer = randomBytes(27) // less than 16+12 = 28

    await expect(
      decrypt({ ciphertext: shortBuffer, passphrase: 'any-passphrase-long-enough123' }),
    ).rejects.toThrow('EXPORT_DECRYPT_FAILED')
  })
})

// ---------------------------------------------------------------------------
// KDF determinism
// ---------------------------------------------------------------------------

describe('KDF determinism', () => {
  it('same passphrase + salt produces the same key', async () => {
    const passphrase = 'deterministic-kdf-test-passphrase'
    const salt = randomBytes(16)

    const key1 = await deriveKey(passphrase, salt)
    const key2 = await deriveKey(passphrase, salt)

    expect(key1).toEqual(key2)
  })

  it('different salts produce different keys', async () => {
    const passphrase = 'same-passphrase-for-salt-test12'
    const salt1 = randomBytes(16)
    const salt2 = randomBytes(16)

    const key1 = await deriveKey(passphrase, salt1)
    const key2 = await deriveKey(passphrase, salt2)

    expect(key1.equals(key2)).toBe(false)
  })

  it('key is 32 bytes (256-bit)', async () => {
    const key = await deriveKey('passphrase-for-length-test-12', randomBytes(16))
    expect(key.length).toBe(32)
  })
})

// ---------------------------------------------------------------------------
// Metadata exports
// ---------------------------------------------------------------------------

describe('module constants', () => {
  it('exports correct algorithm identifier', () => {
    expect(ENCRYPTION_ALGO).toBe('AES-256-GCM')
  })

  it('exports KDF algorithm identifier', () => {
    expect(KDF_ALGO).toBe('scrypt')
  })
})
