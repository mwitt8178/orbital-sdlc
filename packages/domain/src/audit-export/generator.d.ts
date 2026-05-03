/**
 * audit-export/generator.ts — ExportGenerator: parallel month-shard generation.
 *
 * Per TRD-12 §12.2 and task spec:
 *   - One Promise.all over calendar months in range (one worker per month)
 *   - Each shard → events-{YYYY-MM}.jsonl.zst (zstd compressed, level 19)
 *   - Final tarball: tar-stream pack → zstd compress → AES-256-GCM encrypt
 *   - manifest.json and index.json included in tarball
 *   - Lifecycle events via EventStore.append (never db.insert(events))
 *
 * Pack format:
 *   events/events-{YYYY-MM}.jsonl.zst  — one per calendar month in range
 *   manifest.json                       — PackageManifest
 *   index.json                          — per-shard byte offsets and SHA-256
 *   soc2_control_mapping.json
 *   README.md
 *
 * Encryption layout: [salt(16) | iv(12) | ciphertext | tag(16)]
 * Zstd magic: 0x28 0xB5 0x2F 0xFD (first 4 bytes of each .zst shard)
 */
import type { DB } from '@orbital/db';
import type { EventStore } from '../events/store.js';
import type { AuditQueryService } from '../../../orchestrator/src/audit/query.js';
import { type ArtifactRecord } from './manifest.js';
export interface ExportRequest {
    exportId: string;
    installId: string;
    rangeStart: string;
    rangeEnd: string;
    scope: {
        kind: string;
    } & Record<string, unknown>;
    cutoffEventId: string;
    requestedBy: {
        type: string;
    } & Record<string, unknown>;
    capabilityId: string;
    justification: string;
    passphrase: string;
}
export interface ExportResult {
    packageId: string;
    packagePath: string;
    totalBytes: bigint;
    manifestSha256: string;
    packageSha256: string;
    /** Ed25519 signature stub — real signing would use node:crypto ed25519 */
    manifestSignature: string;
    signingKeyId: string;
}
export interface ShardResult {
    month: string;
    eventCount: number;
    compressedBytes: Buffer;
    sha256: string;
}
/**
 * Return an array of YYYY-MM strings for every calendar month in [start, end].
 * Inclusive on both ends.
 */
export declare function enumerateMonths(rangeStart: string, rangeEnd: string): string[];
export declare class ExportGenerator {
    private readonly db;
    private readonly eventStore;
    private readonly queryService;
    private readonly manifestBuilder;
    constructor(db: DB, eventStore: EventStore, queryService: AuditQueryService);
    /**
     * Generate a full evidence package for the given export request.
     *
     * Flow:
     *   1. Emit AuditExportStarted
     *   2. Generate month shards in parallel (Promise.all)
     *   3. Emit AuditExportProgress per shard completion
     *   4. Build manifest + index
     *   5. Pack tarball (tar-stream → zstd → encrypt)
     *   6. Write chunks to disk
     *   7. Insert evidence_packages row
     *   8. Emit AuditExportCompleted
     */
    generate(req: ExportRequest): Promise<ExportResult>;
    /**
     * Generate all month shards concurrently.
     * Each shard fetches events for its calendar month and compresses with zstd.
     */
    generateShardsParallel(req: ExportRequest, months: string[]): Promise<ShardResult[]>;
    /**
     * Generate a single month shard.
     * Fetches events for the month, serializes as JSONL, compresses with zstd level 19.
     */
    generateShard(req: ExportRequest, month: string): Promise<ShardResult>;
    /**
     * Pack all shards + manifest + index into a tar archive (in-memory Buffer).
     * Returns the tarball buffer and the artifact records for the manifest.
     */
    packTarball(req: ExportRequest, shards: ShardResult[]): Promise<{
        tarBuffer: Buffer;
        artifacts: ArtifactRecord[];
    }>;
    private buildManifestBytes;
    /**
     * Sign manifest bytes with Ed25519. V1 uses a placeholder HMAC-based
     * signature since the full keychain (TRD-06) may not be available in all
     * test environments. Real Ed25519 signing is wired in index.ts via KeyManager.
     */
    private signManifest;
    private ensurePackageDir;
    private failExport;
    private emitProgress;
}
export declare function createExportGenerator(db: DB, eventStore: EventStore, queryService: AuditQueryService): ExportGenerator;
//# sourceMappingURL=generator.d.ts.map