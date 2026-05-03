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
import { PutObjectCommand, GetObjectCommand, } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { logger } from '../config/logger.js';
import { ReplayCorruptError } from './store.js';
// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
/**
 * Parse an s3://bucket/key URI into its components.
 * Throws if the URI is not a valid s3:// URI.
 */
function parseS3Uri(uri) {
    if (!uri.startsWith('s3://')) {
        throw new Error(`S3Store: unsupported URI scheme — expected s3://, got: ${uri}`);
    }
    const without = uri.slice('s3://'.length);
    const slashIdx = without.indexOf('/');
    if (slashIdx === -1) {
        throw new Error(`S3Store: malformed S3 URI — no key after bucket: ${uri}`);
    }
    const Bucket = without.slice(0, slashIdx);
    const Key = without.slice(slashIdx + 1);
    if (!Bucket || !Key) {
        throw new Error(`S3Store: malformed S3 URI — empty bucket or key: ${uri}`);
    }
    return { Bucket, Key };
}
/**
 * Buffer a Node.js Readable stream into a Buffer.
 * Used to consume the S3 GetObject Body stream.
 */
async function streamToBuffer(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
    });
}
/**
 * Compute the SHA-256 hex digest of a Buffer.
 */
function sha256Hex(data) {
    return createHash('sha256').update(data).digest('hex');
}
// ---------------------------------------------------------------------------
// S3Store — AWS S3 implementation of ReplayStore
// ---------------------------------------------------------------------------
/**
 * S3Store implements the replay blob storage interface using AWS S3.
 *
 * KMS encryption: every PutObject call specifies ServerSideEncryption: aws:kms
 * and SSEKMSKeyId resolved via the kmsKeyArnFor resolver. AWS S3 enforces
 * server-side encryption at the bucket level (deny-if-no-kms bucket policy
 * is set in 8-07); this driver also specifies it explicitly per-request.
 */
export class S3Store {
    s3;
    bucket;
    kmsKeyArnFor;
    constructor(s3, bucket, 
    /**
     * Async resolver: given a tenantId, returns the KMS key ARN to use for
     * SSE-KMS encryption of that tenant's replay blobs.
     *
     * In the 8-06 initial deployment, this resolves to the stack-level CMK.
     * In 8-07, this resolves to a per-tenant CMK from Secrets Manager / KMS.
     */
    kmsKeyArnFor) {
        this.s3 = s3;
        this.bucket = bucket;
        this.kmsKeyArnFor = kmsKeyArnFor;
    }
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
    async put(captureId, body, tenantId) {
        const requestHash = sha256Hex(Buffer.from(canonicalJSON(body.request), 'utf-8'));
        const responseHash = sha256Hex(Buffer.from(canonicalJSON(body.response), 'utf-8'));
        const payload = Buffer.from(JSON.stringify(body), 'utf-8');
        const payloadSha256 = sha256Hex(payload);
        const day = new Date(body.occurred_at).toISOString().slice(0, 10); // YYYY-MM-DD
        const key = `${tenantId}/${day}/${captureId}.bin`;
        const kmsKeyArn = await this.kmsKeyArnFor(tenantId);
        const putParams = {
            Bucket: this.bucket,
            Key: key,
            Body: payload,
            ContentType: 'application/octet-stream',
            ContentLength: payload.length,
            ServerSideEncryption: 'aws:kms',
            SSEKMSKeyId: kmsKeyArn,
            Metadata: {
                sha256: payloadSha256,
                'request-hash': requestHash,
                'response-hash': responseHash,
                'capture-id': captureId,
                'tenant-id': tenantId,
            },
        };
        logger.debug({ bucket: this.bucket, key, tenantId, captureId, size: payload.length }, 'S3Store.put: uploading replay blob');
        await this.s3.send(new PutObjectCommand(putParams));
        const storageUri = `s3://${this.bucket}/${key}`;
        logger.info({ storageUri, tenantId, captureId, size_bytes: payload.length }, 'S3Store.put: replay blob stored');
        return {
            storage_uri: storageUri,
            size_bytes: payload.length,
            request_hash: requestHash,
            response_hash: responseHash,
        };
    }
    async get(storageUri, expectedSha256OrRequestHash, expectedResponseHash) {
        let Bucket;
        let Key;
        try {
            ;
            ({ Bucket, Key } = parseS3Uri(storageUri));
        }
        catch (err) {
            throw new ReplayCorruptError(storageUri, err.message);
        }
        logger.debug({ bucket: Bucket, key: Key }, 'S3Store.get: fetching replay blob');
        let rawBody;
        try {
            const result = await this.s3.send(new GetObjectCommand({ Bucket, Key }));
            if (!result.Body) {
                throw new ReplayCorruptError(storageUri, 'S3 returned empty body');
            }
            rawBody = await streamToBuffer(result.Body);
        }
        catch (err) {
            if (err instanceof ReplayCorruptError)
                throw err;
            throw new ReplayCorruptError(storageUri, `S3 GetObject failed: ${err.message}`);
        }
        // Integrity check: recompute SHA-256 of the raw payload bytes
        const actualSha256 = sha256Hex(rawBody);
        if (expectedResponseHash !== undefined) {
            // Called with (uri, requestHash, responseHash) — FileSystemStore-compatible mode.
            // We verify both request and response hashes after parsing.
            let body;
            try {
                body = JSON.parse(rawBody.toString('utf-8'));
            }
            catch (err) {
                throw new ReplayCorruptError(storageUri, `JSON parse failed: ${err.message}`);
            }
            const actualRequestHash = sha256Hex(Buffer.from(canonicalJSON(body.request), 'utf-8'));
            const actualResponseHash = sha256Hex(Buffer.from(canonicalJSON(body.response), 'utf-8'));
            if (actualRequestHash !== expectedSha256OrRequestHash) {
                throw new ReplayCorruptError(storageUri, `REPLAY_BLOB_CORRUPT: request_hash mismatch — expected ${expectedSha256OrRequestHash}, got ${actualRequestHash}`);
            }
            if (actualResponseHash !== expectedResponseHash) {
                throw new ReplayCorruptError(storageUri, `REPLAY_BLOB_CORRUPT: response_hash mismatch — expected ${expectedResponseHash}, got ${actualResponseHash}`);
            }
            return body;
        }
        else {
            // Called with (uri, payloadSha256) — S3-native integrity check.
            if (actualSha256 !== expectedSha256OrRequestHash) {
                throw new ReplayCorruptError(storageUri, `REPLAY_BLOB_CORRUPT: sha256 mismatch — expected ${expectedSha256OrRequestHash}, got ${actualSha256}`);
            }
            let body;
            try {
                body = JSON.parse(rawBody.toString('utf-8'));
            }
            catch (err) {
                throw new ReplayCorruptError(storageUri, `JSON parse failed: ${err.message}`);
            }
            return body;
        }
    }
    /**
     * Returns the S3 URI as-is. Provided for interface compatibility with
     * FileSystemStore's resolvePath(); S3Store does not have a local filesystem path.
     * Throws if the URI is not an s3:// URI.
     */
    resolvePath(storageUri) {
        if (!storageUri.startsWith('s3://')) {
            throw new Error(`S3Store.resolvePath: unsupported URI scheme — expected s3://, got: ${storageUri}`);
        }
        // S3Store has no local path; return the URI itself for compatibility.
        return storageUri;
    }
}
// ---------------------------------------------------------------------------
// canonicalJSON — stable key-sorted serialization (mirrors store.ts)
// ---------------------------------------------------------------------------
/**
 * Stable JSON canonicalisation: sort object keys at every level.
 * Mirrors the implementation in store.ts to produce identical hashes.
 */
function canonicalJSON(value) {
    return JSON.stringify(value, sortedReplacer);
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
//# sourceMappingURL=store-s3.js.map