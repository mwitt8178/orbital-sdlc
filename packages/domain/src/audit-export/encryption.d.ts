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
import { type CipherGCM } from 'node:crypto';
export declare const ENCRYPTION_ALGO = "AES-256-GCM";
export declare const KDF_ALGO = "scrypt";
export declare const KDF_MEMORY_KIB: number;
export declare const KDF_ITERATIONS = 32768;
export declare const KDF_PARALLELISM = 1;
export interface EncryptResult {
    /** Full buffer: [salt(16) | iv(12) | ciphertext | tag(16)] */
    ciphertext: Buffer;
    saltB64: string;
    ivB64: string;
}
export interface DecryptParams {
    /** Full buffer: [salt(16) | iv(12) | ciphertext | tag(16)] */
    ciphertext: Buffer;
    passphrase: string;
}
/**
 * Derive a 256-bit key from passphrase + salt using scrypt.
 */
export declare function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer>;
/**
 * Encrypt `plaintext` with `passphrase` using AES-256-GCM + scrypt.
 *
 * Layout of output buffer:
 *   bytes  0-15: salt (16 bytes, random)
 *   bytes 16-27: IV (12 bytes, random)
 *   bytes 28-(N-17): ciphertext
 *   bytes (N-16)-(N-1): GCM auth tag (16 bytes)
 */
export declare function encrypt(plaintext: Buffer, passphrase: string): Promise<EncryptResult>;
/**
 * Decrypt a buffer produced by `encrypt`.
 *
 * Throws with authentication-tag mismatch error if the passphrase is wrong
 * or the ciphertext has been tampered with.
 */
export declare function decrypt(params: DecryptParams): Promise<Buffer>;
export interface StreamEncryptContext {
    salt: Buffer;
    iv: Buffer;
    key: Buffer;
    saltB64: string;
    ivB64: string;
}
/**
 * Prepare a streaming encrypt context. Caller writes plaintext chunks via
 * the returned cipher, then calls `finalize` to append the auth tag.
 */
export declare function createStreamEncryptContext(passphrase: string): Promise<{
    ctx: StreamEncryptContext;
    cipher: CipherGCM;
}>;
/**
 * Returns the GCM auth tag buffer (16 bytes) after `cipher.final()` has been
 * called. Must be appended to the ciphertext stream as the final 16 bytes.
 */
export declare function finalizeStreamEncrypt(cipher: CipherGCM): Buffer;
//# sourceMappingURL=encryption.d.ts.map