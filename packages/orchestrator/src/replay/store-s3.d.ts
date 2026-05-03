/**
 * replay/store-s3.ts — AWS S3 storage driver for replay blobs.
 *
 * [Engineer-Sr · Sonnet · run-round8-06-s3-cloudfront]
 *
 * Architecture:
 *   - Implements ReplayStore using AWS S3 for blob storage.
 *   - Writes via PutObject with ServerSideEncryption: aws:kms and the
 *     per-tenant KMS key resolved via the injected kmsKeyArnFor resolver.
 *   - Stores SHA-256 of the raw payload (pre-encryption) in S3 object metadata
 *     as `x-amz-meta-sha256` so integrity can be verified without re-hashing
 *     from the DB row.
 *   - Reads back the object, re-computes SHA-256, throws REPLAY_BLOB_CORRUPT
 *     (as a ReplayCorruptError) on mismatch.
 *   - Object key layout: `<tenantId>/<YYYY-MM-DD>/<captureId>.bin`
 *
 * Multi-tenant: the kmsKeyArnFor resolver is called per-write with the tenantId
 * so that each tenant's blobs are encrypted with their own CMK. In the 8-06
 * initial deployment, a single stack-level CMK is provided; 8-07 wires
 * per-tenant CMKs.
 *
 * Note: the interface put/get signature is adapted for S3 by including tenantId
 * in put() (required for KMS key resolution and object key partitioning).
 * The base ReplayStore interface is preserved; S3Store adds a tenantId param
 * via an overloaded put method. The factory (createReplayStore) returns S3Store
 * as a ReplayStore, with the tenantId defaulting from env when not provided.
 *
 * No mocks in src/. The S3Client is injected for testability.
 */
import { S3Client } from '@aws-sdk/client-s3';
import type { CaptureBody } from './types.js';
/**
 * S3Store implements the replay blob storage interface using AWS S3.
 *
 * KMS encryption: every PutObject call specifies ServerSideEncryption: aws:kms
 * and SSEKMSKeyId resolved via the kmsKeyArnFor resolver. AWS S3 enforces
 * server-side encryption at the bucket level (deny-if-no-kms bucket policy
 * is set in 8-07); this driver also specifies it explicitly per-request.
 */
export declare class S3Store {
    private readonly s3;
    private readonly bucket;
    /**
     * Async resolver: given a tenantId, returns the KMS key ARN to use for
     * SSE-KMS encryption of that tenant's replay blobs.
     *
     * In the 8-06 initial deployment, this resolves to the stack-level CMK.
     * In 8-07, this resolves to a per-tenant CMK from Secrets Manager / KMS.
     */
    private readonly kmsKeyArnFor;
    constructor(s3: S3Client, bucket: string, 
    /**
     * Async resolver: given a tenantId, returns the KMS key ARN to use for
     * SSE-KMS encryption of that tenant's replay blobs.
     *
     * In the 8-06 initial deployment, this resolves to the stack-level CMK.
     * In 8-07, this resolves to a per-tenant CMK from Secrets Manager / KMS.
     */
    kmsKeyArnFor: (tenantId: string) => Promise<string>);
    /**
     * Persist a capture body to S3 with SSE-KMS encryption.
     *
     * Returns:
     *   - storage_uri: s3://<bucket>/<tenantId>/<YYYY-MM-DD>/<captureId>.bin
     *   - size_bytes: byte length of the uploaded payload
     *   - request_hash: SHA-256 of canonical-JSON request (mirrors FileSystemStore)
     *   - response_hash: SHA-256 of canonical-JSON response
     *
     * The raw payload stored in S3 is the JSON-stringified CaptureBody (NOT
     * encrypted at the application layer — we rely on S3 SSE-KMS for at-rest
     * encryption). SHA-256 of the raw payload bytes is stored in S3 object
     * metadata and also returned for DB row storage.
     */
    put(captureId: string, body: CaptureBody, tenantId: string): Promise<{
        storage_uri: string;
        size_bytes: number;
        request_hash: string;
        response_hash: string;
    }>;
    /**
     * Retrieve a capture body from S3 and verify integrity.
     *
     * Fetches the object, re-computes SHA-256 of the raw bytes, compares against
     * the expected hash provided by the caller (sourced from the DB row).
     * On mismatch → throws ReplayCorruptError with code REPLAY_BLOB_CORRUPT.
     *
     * Note: expectedSha256 here is the SHA-256 of the raw payload bytes stored in
     * S3 (not the request or response hash used by FileSystemStore). For the S3
     * driver, the "payload hash" is what guards blob integrity at the transport
     * layer; request/response hashes are validated separately at the service layer.
     *
     * expectedSha256 can be:
     *   - The payload SHA-256 (recommended — guards against S3 object tampering)
     *   - Pass the request_hash + response_hash for cross-driver compatibility
     *     (the get() signature below accepts both patterns via overload)
     */
    get(storageUri: string, expectedSha256: string): Promise<CaptureBody>;
    get(storageUri: string, expectedRequestHash: string, expectedResponseHash: string): Promise<CaptureBody>;
    /**
     * Returns the S3 URI as-is. Provided for interface compatibility with
     * FileSystemStore's resolvePath(); S3Store does not have a local filesystem path.
     * Throws if the URI is not an s3:// URI.
     */
    resolvePath(storageUri: string): string;
}
//# sourceMappingURL=store-s3.d.ts.map