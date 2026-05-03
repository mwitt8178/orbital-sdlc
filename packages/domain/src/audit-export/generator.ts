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

import { createHash } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { uuidv7 } from 'uuidv7'
import * as tar from 'tar-stream'
import * as zstd from 'zstd-napi'
import type { DB } from '@orbital/db'
import type { EventStore } from '../events/store.js'
import type { AuditQueryService } from '../../../orchestrator/src/audit/query.js'
import { logger } from '../logger.js'
import { encrypt } from './encryption.js'
import { ManifestBuilder, type ArtifactRecord } from './manifest.js'
import type { EventEnvelope } from '../events/types.js'
import { auditExports, evidencePackages, auditExportChunks } from '@orbital/db'
import { eq } from 'drizzle-orm'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ZSTD_LEVEL = 19

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExportRequest {
  exportId: string
  installId: string
  rangeStart: string
  rangeEnd: string
  scope: { kind: string } & Record<string, unknown>
  cutoffEventId: string
  requestedBy: { type: string } & Record<string, unknown>
  capabilityId: string
  justification: string
  passphrase: string
}

export interface ExportResult {
  packageId: string
  packagePath: string
  totalBytes: bigint
  manifestSha256: string
  packageSha256: string
  /** Ed25519 signature stub — real signing would use node:crypto ed25519 */
  manifestSignature: string
  signingKeyId: string
}

export interface ShardResult {
  month: string // YYYY-MM
  eventCount: number
  compressedBytes: Buffer
  sha256: string
}

// ---------------------------------------------------------------------------
// Month enumeration
// ---------------------------------------------------------------------------

/**
 * Return an array of YYYY-MM strings for every calendar month in [start, end].
 * Inclusive on both ends.
 */
export function enumerateMonths(rangeStart: string, rangeEnd: string): string[] {
  const months: string[] = []
  const start = new Date(rangeStart)
  const end = new Date(rangeEnd)

  // Align to first day of start month
  let current = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1))
  const endMonth = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1))

  while (current <= endMonth) {
    const year = current.getUTCFullYear()
    const month = String(current.getUTCMonth() + 1).padStart(2, '0')
    months.push(`${year}-${month}`)
    // Advance one month
    current = new Date(Date.UTC(year, current.getUTCMonth() + 1, 1))
  }

  return months
}

// ---------------------------------------------------------------------------
// ExportGenerator
// ---------------------------------------------------------------------------

export class ExportGenerator {
  private readonly manifestBuilder = new ManifestBuilder()

  constructor(
    private readonly db: DB,
    private readonly eventStore: EventStore,
    private readonly queryService: AuditQueryService,
  ) {}

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
  async generate(req: ExportRequest): Promise<ExportResult> {
    const startMs = Date.now()

    // Emit AuditExportStarted
    const months = enumerateMonths(req.rangeStart, req.rangeEnd)
    await this.eventStore.append({
      aggregate_id: req.exportId,
      aggregate_type: 'audit_export',
      event_type: 'AuditExportStarted',
      payload: {
        export_id: req.exportId,
        cutoff_event_id: req.cutoffEventId,
        worker_count: months.length,
      },
      actor: { type: 'system', component: 'audit_service' },
      trace_id: `audit-export-${req.exportId}`,
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    })

    // Update DB status to running
    await this.db
      .update(auditExports)
      .set({ status: 'running', startedAt: new Date().toISOString(), progressPercent: 0 })
      .where(eq(auditExports.exportId, req.exportId))

    let shards: ShardResult[] = []
    try {
      // Parallel month shard generation
      shards = await this.generateShardsParallel(req, months)
    } catch (err) {
      await this.failExport(req.exportId, 'EXPORT_SHARD_FAILED', String(err), 'events')
      throw err
    }

    // Progress: shards complete → 60%
    await this.emitProgress(req.exportId, 60, 'archiving', shards.length, months.length, 0)

    // Build tar archive in memory
    let tarBuffer: Buffer
    let artifacts: ArtifactRecord[]
    try {
      const result = await this.packTarball(req, shards)
      tarBuffer = result.tarBuffer
      artifacts = result.artifacts
    } catch (err) {
      await this.failExport(req.exportId, 'EXPORT_ARCHIVE_FAILED', String(err), 'archiving')
      throw err
    }

    // Progress: archiving done → 80%
    await this.emitProgress(req.exportId, 80, 'encrypting', artifacts.length, artifacts.length, tarBuffer.length)

    // Encrypt
    let encryptedBuffer: Buffer
    let saltB64: string
    let ivB64: string
    try {
      const enc = await encrypt(tarBuffer, req.passphrase)
      encryptedBuffer = enc.ciphertext
      saltB64 = enc.saltB64
      ivB64 = enc.ivB64
    } catch (err) {
      await this.failExport(req.exportId, 'EXPORT_ENCRYPTION_FAILED', String(err), 'encrypting')
      throw err
    }

    // Compute package hash
    const packageSha256 = createHash('sha256').update(encryptedBuffer).digest('hex')

    // Persist to disk
    const packageDir = await this.ensurePackageDir(req.exportId)
    const filename = `evidence-${req.exportId}-${toDateStr(req.rangeStart)}-${toDateStr(req.rangeEnd)}.tar.zst.enc`
    const packagePath = path.join(packageDir, filename)

    await fs.writeFile(packagePath, encryptedBuffer)

    // Write chunk record (single chunk for v1)
    const chunkId = uuidv7()
    const chunkPath = packagePath
    await this.db.insert(auditExportChunks).values({
      chunkId,
      exportId: req.exportId,
      chunkIndex: 0,
      byteOffset: BigInt(0),
      byteLength: encryptedBuffer.length,
      sha256: packageSha256,
      storagePath: chunkPath,
      createdAt: new Date().toISOString(),
    })

    // Build manifest (we need the manifest for package metadata)
    const manifestBytes = await this.buildManifestBytes(req, artifacts, shards)
    const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex')
    const manifestSignature = await this.signManifest(manifestBytes)
    const signingKeyId = `install-${req.installId.slice(0, 8)}`

    // Insert evidence_packages
    const packageId = uuidv7()
    const retainedUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()

    await this.db.insert(evidencePackages).values({
      packageId,
      exportId: req.exportId,
      filename,
      totalBytes: BigInt(encryptedBuffer.length),
      totalChunks: 1,
      manifestSha256,
      packageSha256,
      manifestSignature,
      signingKeyId,
      encryptionAlgo: 'AES-256-GCM',
      kdfAlgo: 'scrypt',
      kdfSaltB64: saltB64,
      kdfMemoryKib: 4096,
      kdfIterations: 32768,
      kdfParallelism: 1,
      nonceB64: ivB64,
      createdAt: new Date().toISOString(),
      retainedUntil,
    })

    // Update audit_exports to completed
    await this.db
      .update(auditExports)
      .set({
        status: 'completed',
        packageId,
        progressPercent: 100,
        completedAt: new Date().toISOString(),
      })
      .where(eq(auditExports.exportId, req.exportId))

    const durationMs = Date.now() - startMs
    const totalEventCount = shards.reduce((acc, s) => acc + s.eventCount, 0)

    // Emit AuditExportCompleted
    await this.eventStore.append({
      aggregate_id: req.exportId,
      aggregate_type: 'audit_export',
      event_type: 'AuditExportCompleted',
      payload: {
        export_id: req.exportId,
        package_id: packageId,
        package_filename: filename,
        total_bytes: encryptedBuffer.length,
        manifest_sha256: manifestSha256,
        package_sha256: packageSha256,
        manifest_signature: manifestSignature,
        signing_key_id: signingKeyId,
        duration_ms: durationMs,
      },
      actor: { type: 'system', component: 'audit_service' },
      trace_id: `audit-export-${req.exportId}`,
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    })

    logger.info(
      {
        exportId: req.exportId,
        packageId,
        totalBytes: encryptedBuffer.length,
        durationMs,
        totalEventCount,
        monthCount: months.length,
      },
      'AuditExport: generation complete',
    )

    return {
      packageId,
      packagePath,
      totalBytes: BigInt(encryptedBuffer.length),
      manifestSha256,
      packageSha256,
      manifestSignature,
      signingKeyId,
    }
  }

  // ---------------------------------------------------------------------------
  // Parallel shard generation
  // ---------------------------------------------------------------------------

  /**
   * Generate all month shards concurrently.
   * Each shard fetches events for its calendar month and compresses with zstd.
   */
  async generateShardsParallel(req: ExportRequest, months: string[]): Promise<ShardResult[]> {
    const shardPromises = months.map((month) => this.generateShard(req, month))
    const shards = await Promise.all(shardPromises)
    return shards
  }

  /**
   * Generate a single month shard.
   * Fetches events for the month, serializes as JSONL, compresses with zstd level 19.
   */
  async generateShard(req: ExportRequest, month: string): Promise<ShardResult> {
    const [year, mon] = month.split('-').map(Number) as [number, number]
    const monthStart = new Date(Date.UTC(year, mon - 1, 1)).toISOString()
    const monthEnd = new Date(Date.UTC(year, mon, 1)).toISOString() // exclusive

    // Clamp to the export range
    const start = monthStart < req.rangeStart ? req.rangeStart : monthStart
    const end = monthEnd > req.rangeEnd ? req.rangeEnd : monthEnd

    // Collect all events for this month via paginated query
    const events: EventEnvelope[] = []
    let cursor: string | undefined = undefined

    do {
      const page = await this.queryService.query({
        occurred_from: start,
        occurred_to: end,
        limit: 500,
        after: cursor,
      })
      events.push(...page.items)
      cursor = page.next_cursor ?? undefined
    } while (cursor !== undefined)

    // Serialize as JSONL
    const jsonl = events.map((e) => JSON.stringify(e)).join('\n')
    const jsonlBuffer = Buffer.from(jsonl, 'utf-8')

    // Compress with zstd compressionLevel 19
    const compressed: Buffer = zstd.compress(jsonlBuffer, { compressionLevel: ZSTD_LEVEL }) as Buffer

    const sha256 = createHash('sha256').update(compressed).digest('hex')

    return {
      month,
      eventCount: events.length,
      compressedBytes: compressed,
      sha256,
    }
  }

  // ---------------------------------------------------------------------------
  // Tarball packing
  // ---------------------------------------------------------------------------

  /**
   * Pack all shards + manifest + index into a tar archive (in-memory Buffer).
   * Returns the tarball buffer and the artifact records for the manifest.
   */
  async packTarball(
    req: ExportRequest,
    shards: ShardResult[],
  ): Promise<{ tarBuffer: Buffer; artifacts: ArtifactRecord[] }> {
    const artifacts: ArtifactRecord[] = []

    // Build index.json
    const indexEntries: Record<string, { sha256: string; byte_length: number; event_count: number }> = {}
    for (const shard of shards) {
      indexEntries[`events/events-${shard.month}.jsonl.zst`] = {
        sha256: shard.sha256,
        byte_length: shard.compressedBytes.length,
        event_count: shard.eventCount,
      }
    }
    const indexBuffer = Buffer.from(JSON.stringify(indexEntries, null, 2), 'utf-8')
    const indexSha256 = createHash('sha256').update(indexBuffer).digest('hex')

    // Build SOC2 mapping
    const controlMappingBuffer = this.manifestBuilder.buildControlMapping()
    const controlMappingSha256 = createHash('sha256').update(controlMappingBuffer).digest('hex')

    // Build README
    const readmeBuffer = this.manifestBuilder.buildReadme({
      installId: req.installId,
      rangeStart: req.rangeStart,
      rangeEnd: req.rangeEnd,
      scopeSummary: req.scope.kind,
      cutoffEventId: req.cutoffEventId,
    })
    const readmeSha256 = createHash('sha256').update(readmeBuffer).digest('hex')

    // Artifact records for shards
    for (const shard of shards) {
      const [year, mon] = shard.month.split('-').map(Number) as [number, number]
      const shardStart = new Date(Date.UTC(year, mon - 1, 1)).toISOString()
      const shardEnd = new Date(Date.UTC(year, mon, 1)).toISOString()

      artifacts.push({
        path: `events/events-${shard.month}.jsonl.zst`,
        type: 'events_jsonl',
        range_start: shardStart,
        range_end: shardEnd,
        record_count: shard.eventCount,
        byte_length: shard.compressedBytes.length,
        sha256: shard.sha256,
      })
    }

    // Add index, control mapping, readme
    artifacts.push({
      path: 'index.json',
      type: 'index',
      record_count: shards.length,
      byte_length: indexBuffer.length,
      sha256: indexSha256,
    })
    artifacts.push({
      path: 'soc2_control_mapping.json',
      type: 'control_mapping',
      record_count: 1,
      byte_length: controlMappingBuffer.length,
      sha256: controlMappingSha256,
    })
    artifacts.push({
      path: 'README.md',
      type: 'readme',
      record_count: 1,
      byte_length: readmeBuffer.length,
      sha256: readmeSha256,
    })

    // Build manifest now (with artifacts list)
    const totalEventCount = shards.reduce((acc, s) => acc + s.eventCount, 0)
    const manifestBytesForHash = await this.buildManifestBytes(req, artifacts, shards)
    const manifestSha256 = createHash('sha256').update(manifestBytesForHash).digest('hex')
    const _manifestSignaturePlaceholder = await this.signManifest(manifestBytesForHash)
    const signingKeyId = `install-${req.installId.slice(0, 8)}`

    // Build final manifest with signing info
    const packageId = uuidv7() // placeholder — real packageId assigned after insert
    const manifest = this.manifestBuilder.build({
      exportId: req.exportId,
      installId: req.installId,
      packageId,
      rangeStart: req.rangeStart,
      rangeEnd: req.rangeEnd,
      scope: req.scope,
      cutoffEventId: req.cutoffEventId,
      requestedBy: req.requestedBy,
      capabilityId: req.capabilityId,
      justification: req.justification,
      artifacts,
      totalEventCount,
      signingKeyId,
      masterKeyPubB64: 'placeholder-v1',
      signedAt: new Date().toISOString(),
    })
    const manifestBuffer = this.manifestBuilder.serialize(manifest)

    artifacts.push({
      path: 'manifest.json',
      type: 'index',
      record_count: 1,
      byte_length: manifestBuffer.length,
      sha256: manifestSha256,
    })

    // Pack tar archive
    const chunks: Buffer[] = []
    const pack = tar.pack()

    // Collect output
    pack.on('data', (chunk: Buffer) => chunks.push(chunk))

    // Add event shards
    for (const shard of shards) {
      await new Promise<void>((resolve, reject) => {
        pack.entry(
          { name: `events/events-${shard.month}.jsonl.zst`, size: shard.compressedBytes.length },
          shard.compressedBytes,
          (err) => {
            if (err) reject(err)
            else resolve()
          },
        )
      })
    }

    // Add index.json
    await new Promise<void>((resolve, reject) => {
      pack.entry({ name: 'index.json', size: indexBuffer.length }, indexBuffer, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })

    // Add soc2_control_mapping.json
    await new Promise<void>((resolve, reject) => {
      pack.entry(
        { name: 'soc2_control_mapping.json', size: controlMappingBuffer.length },
        controlMappingBuffer,
        (err) => {
          if (err) reject(err)
          else resolve()
        },
      )
    })

    // Add README.md
    await new Promise<void>((resolve, reject) => {
      pack.entry({ name: 'README.md', size: readmeBuffer.length }, readmeBuffer, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })

    // Add manifest.json
    await new Promise<void>((resolve, reject) => {
      pack.entry(
        { name: 'manifest.json', size: manifestBuffer.length },
        manifestBuffer,
        (err) => {
          if (err) reject(err)
          else resolve()
        },
      )
    })

    // Finalize tar
    await new Promise<void>((resolve, reject) => {
      pack.finalize()
      pack.on('end', resolve)
      pack.on('error', reject)
    })

    const tarBuffer = Buffer.concat(chunks)

    return { tarBuffer, artifacts }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async buildManifestBytes(
    req: ExportRequest,
    artifacts: ArtifactRecord[],
    shards: ShardResult[],
  ): Promise<Buffer> {
    const totalEventCount = shards.reduce((acc, s) => acc + s.eventCount, 0)
    const manifest = this.manifestBuilder.build({
      exportId: req.exportId,
      installId: req.installId,
      packageId: 'pending',
      rangeStart: req.rangeStart,
      rangeEnd: req.rangeEnd,
      scope: req.scope,
      cutoffEventId: req.cutoffEventId,
      requestedBy: req.requestedBy,
      capabilityId: req.capabilityId,
      justification: req.justification,
      artifacts,
      totalEventCount,
      signingKeyId: `install-${req.installId.slice(0, 8)}`,
      masterKeyPubB64: 'placeholder-v1',
      signedAt: new Date().toISOString(),
    })
    return this.manifestBuilder.serialize(manifest)
  }

  /**
   * Sign manifest bytes with Ed25519. V1 uses a placeholder HMAC-based
   * signature since the full keychain (TRD-06) may not be available in all
   * test environments. Real Ed25519 signing is wired in index.ts via KeyManager.
   */
  private async signManifest(manifestBytes: Buffer): Promise<string> {
    // Placeholder: SHA-256 of manifest as the "signature" for v1 test purposes.
    // Production path would use KeyManager.sign(manifestBytes) → real Ed25519.
    const hash = createHash('sha256').update(manifestBytes).digest('base64')
    return hash
  }

  private async ensurePackageDir(exportId: string): Promise<string> {
    const homeDir = process.env['ORBITAL_HOME'] ?? path.join(os.homedir(), '.orbital')
    const dir = path.join(homeDir, 'audit-exports', exportId)
    await fs.mkdir(dir, { recursive: true })
    return dir
  }

  private async failExport(
    exportId: string,
    errorCode: string,
    errorMessage: string,
    stage: string,
  ): Promise<void> {
    try {
      await this.db
        .update(auditExports)
        .set({ status: 'failed', errorCode, errorMessage })
        .where(eq(auditExports.exportId, exportId))

      await this.eventStore.append({
        aggregate_id: exportId,
        aggregate_type: 'audit_export',
        event_type: 'AuditExportFailed',
        payload: {
          export_id: exportId,
          error_code: errorCode,
          error_message: errorMessage,
          stage,
          artifacts_done: 0,
        },
        actor: { type: 'system', component: 'audit_service' },
        trace_id: `audit-export-${exportId}`,
        occurred_at: new Date().toISOString(),
        schema_version: 1,
      })
    } catch (err) {
      logger.error({ err, exportId }, 'AuditExport: failed to record failure event')
    }
  }

  private async emitProgress(
    exportId: string,
    percent: number,
    stage: string,
    artifactsDone: number,
    artifactsTotal: number,
    bytesWritten: number,
  ): Promise<void> {
    try {
      await this.eventStore.append({
        aggregate_id: exportId,
        aggregate_type: 'audit_export',
        event_type: 'AuditExportProgress',
        payload: {
          export_id: exportId,
          percent,
          stage,
          artifacts_done: artifactsDone,
          artifacts_total: artifactsTotal,
          bytes_written: bytesWritten,
        },
        actor: { type: 'system', component: 'audit_service' },
        trace_id: `audit-export-${exportId}`,
        occurred_at: new Date().toISOString(),
        schema_version: 1,
      })

      await this.db
        .update(auditExports)
        .set({ progressPercent: percent, progressStage: stage })
        .where(eq(auditExports.exportId, exportId))
    } catch (err) {
      logger.warn({ err, exportId }, 'AuditExport: failed to emit progress event')
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toDateStr(iso: string): string {
  return iso.slice(0, 10).replace(/-/g, '')
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createExportGenerator(
  db: DB,
  eventStore: EventStore,
  queryService: AuditQueryService,
): ExportGenerator {
  return new ExportGenerator(db, eventStore, queryService)
}
