/**
 * replay/store.ts — Storage abstraction for replay blobs.
 *
 * [Engineer-Principal · Opus · run-round6-07-replay]
 *
 * Architecture:
 *   - The DB row in `replay_captures` carries metadata + storage_uri.
 *   - The actual request+response blob is stored at storage_uri, encrypted
 *     with a key derived from the install master key (`getInstallId()`).
 *   - storage_uri shape is `file:///<absolute-path>` for the filesystem driver
 *     and `s3://<bucket>/<key>` for the future cloud driver. The interface
 *     below is driver-agnostic; swap implementations in boot.ts only.
 *
 * Encryption:
 *   - Algorithm: AES-256-GCM (same primitive used by audit-export/encryption.ts).
 *   - Key: derived via scrypt(install_id, salt) — install-pinned, but salted
 *     per-blob so two captures of identical content do not produce identical
 *     ciphertext.
 *   - Layout on disk: [salt(16) | iv(12) | ciphertext | tag(16)] — same as
 *     audit-export, so future "export-replays" can reuse the same envelope.
 *
 * Integrity:
 *   - Each blob carries a sha256 of the canonical-JSON request and response.
 *     Hashes live in the DB row, not in the blob. Mismatch on read → throw
 *     ReplayCorruptError so the recorder can emit ReplayCorrupt to the audit
 *     log and fail loudly per CLAUDE.md.
 *
 * No mocks — Node's `node:crypto` only. The integration test
 * `blob-encryption.integration.test.ts` opens a written file and asserts the
 * raw bytes are NOT a parseable JSON document.
 */
import { promises as fs, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, scrypt as scryptCb, createCipheriv, createDecipheriv } from 'node:crypto';
import { logger } from '../config/logger.js';
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const SCRYPT_N = 32768; // 2^15
const SCRYPT_R = 8;
const SCRYPT_P = 1;
// File mode = 0o600 → owner read/write only. The directory is 0o700.
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
/**
 * Thrown by store.get when the on-disk blob fails the integrity check or is
 * undecryptable (auth tag mismatch).
 */
export class ReplayCorruptError extends Error {
    captureUri;
    reason;
    constructor(captureUri, reason) {
        super(`REPLAY_CORRUPT: ${captureUri} — ${reason}`);
        this.captureUri = captureUri;
        this.reason = reason;
        this.name = 'ReplayCorruptError';
    }
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * Stable JSON canonicalisation: sort object keys at every level. The output
 * is what we hash; replay-live verification rehashes the response with the
 * same algorithm to detect drift.
 */
function canonicalJSON(value) {
    return JSON.stringify(value, Object.keys(value).length > 0 ? sortedReplacer : undefined);
}
function sortedReplacer(_key, val) {
    if (val === null || typeof val !== 'object' || Array.isArray(val))
        return val;
    const obj = val;
    return Object.keys(obj)
        .sort()
        .reduce((acc, k) => {
        acc[k] = obj[k];
        return acc;
    }, {});
}
function sha256Hex(input) {
    return createHash('sha256').update(input).digest('hex');
}
function scryptKey(passphrase, salt) {
    return new Promise((resolve, reject) => {
        scryptCb(passphrase, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_N * SCRYPT_R * 128 * SCRYPT_P * 2 }, (err, key) => {
            if (err)
                reject(err);
            else
                resolve(key);
        });
    });
}
async function encryptBlob(plaintext, passphrase) {
    const salt = randomBytes(SALT_LENGTH);
    const iv = randomBytes(IV_LENGTH);
    const key = await scryptKey(passphrase, salt);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LENGTH });
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    // Best-effort zeroize key (Node Buffer is regular memory; this is hygiene).
    key.fill(0);
    return Buffer.concat([salt, iv, ciphertext, tag]);
}
async function decryptBlob(envelope, passphrase) {
    if (envelope.length < SALT_LENGTH + IV_LENGTH + TAG_LENGTH) {
        throw new Error('blob too short to contain salt + iv + tag');
    }
    const salt = envelope.subarray(0, SALT_LENGTH);
    const iv = envelope.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
    const tag = envelope.subarray(envelope.length - TAG_LENGTH);
    const ciphertext = envelope.subarray(SALT_LENGTH + IV_LENGTH, envelope.length - TAG_LENGTH);
    const key = await scryptKey(passphrase, salt);
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LENGTH });
    decipher.setAuthTag(tag);
    try {
        const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        key.fill(0);
        return plain;
    }
    catch (err) {
        key.fill(0);
        throw new Error(`auth tag mismatch — ${err.message}`);
    }
}
/**
 * On-disk layout:
 *   <rootDir>/<YYYY-MM-DD>/<capture_id>.bin
 *
 * The .bin extension signals to anyone browsing the directory that the file
 * is intentionally opaque (encrypted). The file is not JSON.
 */
export class FileSystemStore {
    options;
    constructor(options) {
        this.options = options;
        if (!options.rootDir || !path.isAbsolute(options.rootDir)) {
            throw new Error('FileSystemStore: rootDir must be an absolute path');
        }
        if (!options.encryptionPassphrase) {
            throw new Error('FileSystemStore: encryptionPassphrase is required');
        }
    }
    async put(captureId, body) {
        // 1. Hash the canonical request + response BEFORE encrypting; the hashes
        //    are the integrity primitive that survives encryption.
        const requestHash = sha256Hex(canonicalJSON(body.request));
        const responseHash = sha256Hex(canonicalJSON(body.response));
        // 2. Serialize the full body (which carries everything — including hashes
        //    we just computed — for self-validation on read).
        const plaintext = Buffer.from(JSON.stringify(body), 'utf-8');
        // 3. Encrypt at rest with a per-blob salt + iv.
        const ciphertext = await encryptBlob(plaintext, this.options.encryptionPassphrase);
        // 4. Compute the on-disk path.
        const day = new Date(body.occurred_at).toISOString().slice(0, 10); // YYYY-MM-DD
        const dir = path.join(this.options.rootDir, day);
        await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
        const file = path.join(dir, `${captureId}.bin`);
        // 5. Write atomically — write to .tmp first, then rename. This avoids
        //    half-written files if the process is killed mid-flush.
        const tmp = `${file}.tmp`;
        await fs.writeFile(tmp, ciphertext, { mode: FILE_MODE });
        await fs.rename(tmp, file);
        // 6. Best-effort: ensure directory permissions are correct (mkdir respects
        //    umask in some environments).
        try {
            await fs.chmod(dir, DIR_MODE);
        }
        catch (err) {
            logger.warn({ err, dir }, 'replay/store: chmod on dir failed (non-fatal)');
        }
        const sizeBytes = ciphertext.length;
        const storageUri = `file://${file}`;
        return {
            storage_uri: storageUri,
            size_bytes: sizeBytes,
            request_hash: requestHash,
            response_hash: responseHash,
        };
    }
    async get(storageUri, expectedRequestHash, expectedResponseHash) {
        const file = this.resolvePath(storageUri);
        let envelope;
        try {
            // Existence check first to give a clearer error than "ENOENT".
            await fs.access(file, fsConstants.R_OK);
            envelope = await fs.readFile(file);
        }
        catch (err) {
            throw new ReplayCorruptError(storageUri, `unreadable: ${err.message}`);
        }
        let plaintext;
        try {
            plaintext = await decryptBlob(envelope, this.options.encryptionPassphrase);
        }
        catch (err) {
            throw new ReplayCorruptError(storageUri, `decrypt failed: ${err.message}`);
        }
        let body;
        try {
            body = JSON.parse(plaintext.toString('utf-8'));
        }
        catch (err) {
            throw new ReplayCorruptError(storageUri, `JSON parse failed: ${err.message}`);
        }
        // Integrity check against the metadata-row hashes.
        const reqHash = sha256Hex(canonicalJSON(body.request));
        const respHash = sha256Hex(canonicalJSON(body.response));
        if (reqHash !== expectedRequestHash) {
            throw new ReplayCorruptError(storageUri, `request_hash mismatch: expected ${expectedRequestHash}, got ${reqHash}`);
        }
        if (respHash !== expectedResponseHash) {
            throw new ReplayCorruptError(storageUri, `response_hash mismatch: expected ${expectedResponseHash}, got ${respHash}`);
        }
        return body;
    }
    resolvePath(storageUri) {
        if (!storageUri.startsWith('file://')) {
            throw new Error(`FileSystemStore.resolvePath: unsupported URI scheme: ${storageUri}`);
        }
        return storageUri.slice('file://'.length);
    }
}
// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
/** Default factory used by boot.ts. */
export function createFileSystemStore(options) {
    return new FileSystemStore(options);
}
// Re-export hash helper for tests + recorder code path.
export const _internal = { canonicalJSON, sha256Hex };
/**
 * createReplayStore — universal factory.
 *
 * Returns S3Store when `env.ORBITAL_DEPLOY_TARGET === 'aws'`, otherwise
 * FileSystemStore. Designed for boot.ts to call once at startup.
 *
 * Because the orchestrator is an ES module ("type": "module"), we statically
 * import S3Store and S3Client at the top of this file (below). The S3Store
 * constructor does not make any network calls so importing it in non-aws
 * environments is safe — it just means @aws-sdk/client-s3 must be installed.
 *
 * @param env - environment variables (from loadEnv() or process.env in tests)
 * @param options - rootDir + encryptionPassphrase for FileSystemStore; ignored for S3
 */
export function createReplayStore(env, options) {
    if (env.ORBITAL_DEPLOY_TARGET === 'aws') {
        const bucket = env.ORBITAL_REPLAY_BUCKET;
        if (!bucket) {
            throw new Error('createReplayStore: ORBITAL_REPLAY_BUCKET must be set when ORBITAL_DEPLOY_TARGET=aws');
        }
        const defaultKmsArn = env.ORBITAL_REPLAY_KMS_KEY_ARN;
        if (!defaultKmsArn) {
            throw new Error('createReplayStore: ORBITAL_REPLAY_KMS_KEY_ARN must be set when ORBITAL_DEPLOY_TARGET=aws');
        }
        // S3Client is imported at module load time (static import, see bottom of file).
        // The constructor is synchronous; no network calls are made here.
        const s3 = new S3ClientCtor({ region: env.AWS_REGION ?? process.env['AWS_REGION'] });
        // kmsKeyArnFor: per-tenant resolution. Pre-8-07, all tenants use the stack CMK.
        // 8-07 will replace this with a Secrets Manager lookup keyed by tenantId.
        const kmsKeyArnFor = async (_tenantId) => defaultKmsArn;
        return new S3StoreCtor(s3, bucket, kmsKeyArnFor);
    }
    // FileSystemStore (default: local / self-hosted)
    const rootDir = options?.rootDir;
    const encryptionPassphrase = options?.encryptionPassphrase;
    if (!rootDir) {
        throw new Error('createReplayStore: rootDir is required for FileSystemStore (ORBITAL_DEPLOY_TARGET != aws)');
    }
    if (!encryptionPassphrase) {
        throw new Error('createReplayStore: encryptionPassphrase is required for FileSystemStore');
    }
    return new FileSystemStore({ rootDir, encryptionPassphrase });
}
// ---------------------------------------------------------------------------
// Static imports for S3 — imported at module load time per ESM rules.
// These are tree-shaken by bundlers that do not include the aws path.
// S3Client constructor does not make network calls so this is side-effect free.
// ---------------------------------------------------------------------------
// We import via a type alias to distinguish from the local classes above.
import { S3Client as S3ClientCtor } from '@aws-sdk/client-s3';
import { S3Store as S3StoreCtor } from './store-s3.js';
//# sourceMappingURL=store.js.map