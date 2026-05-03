/**
 * audit-export/encryption.ts — AES-256-GCM encrypt/decrypt helpers.
 *
 * Per TRD-12 §12.3 (implementation guidance from task spec):
 *   - Cipher:   AES-256-GCM, 16-byte auth tag
 *   - KDF:      scrypt with N=2^15, r=8, p=1
 *   - Layout:   [salt(16) | iv(12) | ciphertext | tag(16)]
 *   - Salt and IV are stored as the first 28 bytes of the output buffer.
 *
 * The TRD specifies XChaCha20-Poly1305 + Argon2id for the full production
 * path; the task spec overrides to AES-256-GCM + scrypt (available natively
 * in node:crypto without native addons). This keeps the CI build hermetic.
 *
 * KDF parameters:
 *   N = 32768 (2^15), r = 8, p = 1, keylen = 32
 *   These produce ~100ms on modern hardware — acceptable for offline export.
 *
 * Tag length: 16 bytes (AES-GCM maximum; appended automatically by
 * `createCipheriv` / `createDecipheriv` `getAuthTag` / `setAuthTag`).
 *
 * No mock crypto — node:crypto only.
 */

import { createCipheriv, createDecipheriv, randomBytes, scrypt, type CipherGCM, type DecipherGCM } from 'node:crypto'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SALT_LENGTH = 16
const IV_LENGTH = 12
const TAG_LENGTH = 16
const KEY_LENGTH = 32

// scrypt parameters per task spec
const SCRYPT_N = 32768 // 2^15
const SCRYPT_R = 8
const SCRYPT_P = 1

export const ENCRYPTION_ALGO = 'AES-256-GCM'
export const KDF_ALGO = 'scrypt'
export const KDF_MEMORY_KIB = (SCRYPT_N * SCRYPT_R * 128) / 1024 // ~4096 KiB
export const KDF_ITERATIONS = SCRYPT_N
export const KDF_PARALLELISM = SCRYPT_P

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface EncryptResult {
  /** Full buffer: [salt(16) | iv(12) | ciphertext | tag(16)] */
  ciphertext: Buffer
  saltB64: string
  ivB64: string
}

export interface DecryptParams {
  /** Full buffer: [salt(16) | iv(12) | ciphertext | tag(16)] */
  ciphertext: Buffer
  passphrase: string
}

// ---------------------------------------------------------------------------
// KDF
// ---------------------------------------------------------------------------

/**
 * Derive a 256-bit key from passphrase + salt using scrypt.
 */
export async function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(
      passphrase,
      salt,
      KEY_LENGTH,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_N * SCRYPT_R * 128 * SCRYPT_P * 2 },
      (err, derivedKey) => {
        if (err) reject(err)
        else resolve(derivedKey)
      },
    )
  })
}

// ---------------------------------------------------------------------------
// Encrypt
// ---------------------------------------------------------------------------

/**
 * Encrypt `plaintext` with `passphrase` using AES-256-GCM + scrypt.
 *
 * Layout of output buffer:
 *   bytes  0-15: salt (16 bytes, random)
 *   bytes 16-27: IV (12 bytes, random)
 *   bytes 28-(N-17): ciphertext
 *   bytes (N-16)-(N-1): GCM auth tag (16 bytes)
 */
export async function encrypt(plaintext: Buffer, passphrase: string): Promise<EncryptResult> {
  const salt = randomBytes(SALT_LENGTH)
  const iv = randomBytes(IV_LENGTH)
  const key = await deriveKey(passphrase, salt)

  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LENGTH }) as CipherGCM
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()

  // Layout: [salt | iv | ciphertext | tag]
  const output = Buffer.concat([salt, iv, encrypted, tag])

  return {
    ciphertext: output,
    saltB64: salt.toString('base64'),
    ivB64: iv.toString('base64'),
  }
}

// ---------------------------------------------------------------------------
// Decrypt
// ---------------------------------------------------------------------------

/**
 * Decrypt a buffer produced by `encrypt`.
 *
 * Throws with authentication-tag mismatch error if the passphrase is wrong
 * or the ciphertext has been tampered with.
 */
export async function decrypt(params: DecryptParams): Promise<Buffer> {
  const { ciphertext: buf, passphrase } = params

  if (buf.length < SALT_LENGTH + IV_LENGTH + TAG_LENGTH) {
    throw new Error('EXPORT_DECRYPT_FAILED: buffer too short to contain header and tag')
  }

  const salt = buf.subarray(0, SALT_LENGTH)
  const iv = buf.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH)
  const tag = buf.subarray(buf.length - TAG_LENGTH)
  const ciphertext = buf.subarray(SALT_LENGTH + IV_LENGTH, buf.length - TAG_LENGTH)

  const key = await deriveKey(passphrase, salt)

  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LENGTH }) as DecipherGCM
  decipher.setAuthTag(tag)

  try {
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return decrypted
  } catch (err) {
    // Re-throw with a domain-prefixed message per TRD-12 §9
    throw new Error('EXPORT_DECRYPT_FAILED: authentication tag mismatch — wrong passphrase or tampered ciphertext', { cause: err })
  }
}

// ---------------------------------------------------------------------------
// Streaming helpers (for large tarballs)
// ---------------------------------------------------------------------------

export interface StreamEncryptContext {
  salt: Buffer
  iv: Buffer
  key: Buffer
  saltB64: string
  ivB64: string
}

/**
 * Prepare a streaming encrypt context. Caller writes plaintext chunks via
 * the returned cipher, then calls `finalize` to append the auth tag.
 */
export async function createStreamEncryptContext(passphrase: string): Promise<{
  ctx: StreamEncryptContext
  cipher: CipherGCM
}> {
  const salt = randomBytes(SALT_LENGTH)
  const iv = randomBytes(IV_LENGTH)
  const key = await deriveKey(passphrase, salt)

  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LENGTH }) as CipherGCM

  const ctx: StreamEncryptContext = {
    salt,
    iv,
    key,
    saltB64: salt.toString('base64'),
    ivB64: iv.toString('base64'),
  }

  return { ctx, cipher }
}

/**
 * Returns the GCM auth tag buffer (16 bytes) after `cipher.final()` has been
 * called. Must be appended to the ciphertext stream as the final 16 bytes.
 */
export function finalizeStreamEncrypt(cipher: CipherGCM): Buffer {
  return cipher.getAuthTag()
}
