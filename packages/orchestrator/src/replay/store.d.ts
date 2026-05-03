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
import type { CaptureBody } from './types.js';
/**
 * Driver-agnostic storage interface. Implementations:
 *   - FileSystemStore (this module) — v1.
 *   - S3Store (future, Round 8/cloud port) — drop-in.
 */
export interface ReplayStore {
    /**
     * Persist a capture body. Returns:
     *   - storage_uri: the canonical pointer (file:///… or s3://…)
     *   - size_bytes: bytes written to the underlying medium (post-encryption).
     *   - request_hash, response_hash: sha256 of canonical-JSON inputs.
     */
    put(captureId: string, body: CaptureBody): Promise<{
        storage_uri: string;
        size_bytes: number;
        request_hash: string;
        response_hash: string;
    }>;
    /**
     * Read and decrypt a capture body. Throws ReplayCorruptError if the file
     * cannot be decrypted or hashes do not match (integrity check).
     */
    get(storageUri: string, expectedRequestHash: string, expectedResponseHash: string): Promise<CaptureBody>;
    /**
     * Resolve the absolute on-disk path for inspection. Used by tests verifying
     * blob-at-rest encryption. Throws if the URI is not for this driver.
     */
    resolvePath(storageUri: string): string;
}
/**
 * Thrown by store.get when the on-disk blob fails the integrity check or is
 * undecryptable (auth tag mismatch).
 */
export declare class ReplayCorruptError extends Error {
    readonly captureUri: string;
    readonly reason: string;
    constructor(captureUri: string, reason: string);
}
/**
 * Stable JSON canonicalisation: sort object keys at every level. The output
 * is what we hash; replay-live verification rehashes the response with the
 * same algorithm to detect drift.
 */
declare function canonicalJSON(value: unknown): string;
declare function sha256Hex(input: string | Buffer): string;
/**
 * Construction parameters for FileSystemStore.
 */
export interface FileSystemStoreOptions {
    /**
     * Root directory for replay blobs. Typically `~/.orbital/replays/<install_id>`.
     * Created if missing with mode 0o700.
     */
    rootDir: string;
    /**
     * Passphrase used to derive the per-blob AES key via scrypt. In production
     * this is the install id (or a derived secret); in tests, any non-empty
     * string works. The salt is per-blob so two captures with identical content
     * still produce different ciphertext.
     */
    encryptionPassphrase: string | Buffer;
}
/**
 * On-disk layout:
 *   <rootDir>/<YYYY-MM-DD>/<capture_id>.bin
 *
 * The .bin extension signals to anyone browsing the directory that the file
 * is intentionally opaque (encrypted). The file is not JSON.
 */
export declare class FileSystemStore implements ReplayStore {
    private readonly options;
    constructor(options: FileSystemStoreOptions);
    put(captureId: string, body: CaptureBody): Promise<{
        storage_uri: string;
        size_bytes: number;
        request_hash: string;
        response_hash: string;
    }>;
    get(storageUri: string, expectedRequestHash: string, expectedResponseHash: string): Promise<CaptureBody>;
    resolvePath(storageUri: string): string;
}
/** Default factory used by boot.ts. */
export declare function createFileSystemStore(options: FileSystemStoreOptions): FileSystemStore;
export declare const _internal: {
    canonicalJSON: typeof canonicalJSON;
    sha256Hex: typeof sha256Hex;
};
/**
 * Environment variables required by the universal factory.
 * Only the fields relevant to store selection are declared here; the full
 * Env type from config/env.ts is a superset. This keeps store.ts independent
 * of the full config module (avoiding circular imports).
 */
export interface StoreFactoryEnv {
    /**
     * Deployment target selector.
     *   'aws'   — use S3Store backed by the replay blobs bucket.
     *   'local' — use FileSystemStore (default for self-hosted).
     */
    ORBITAL_DEPLOY_TARGET?: 'aws' | 'local';
    /**
     * S3 bucket name for replay blobs. Required when ORBITAL_DEPLOY_TARGET=aws.
     * Set from CDK stack output OrbitalHub-<env>-ReplayBucketName.
     */
    ORBITAL_REPLAY_BUCKET?: string;
    /**
     * AWS region for the S3 client. Defaults to AWS_REGION / AWS_DEFAULT_REGION.
     */
    AWS_REGION?: string;
    /**
     * Default KMS key ARN for replay blob encryption.
     * Used as the fallback when a per-tenant CMK is not resolved (pre-8-07).
     * Required when ORBITAL_DEPLOY_TARGET=aws.
     */
    ORBITAL_REPLAY_KMS_KEY_ARN?: string;
}
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
export declare function createReplayStore(env: StoreFactoryEnv, options?: {
    rootDir?: string;
    encryptionPassphrase?: string | Buffer;
}): ReplayStore | S3StoreType;
import { type S3Store as S3StoreType } from './store-s3.js';
export type { S3Store } from './store-s3.js';
//# sourceMappingURL=store.d.ts.map