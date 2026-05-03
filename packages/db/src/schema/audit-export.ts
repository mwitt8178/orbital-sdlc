/**
 * Drizzle schema for audit export tables.
 *
 * Per TRD-12 §4.2 — three tables in the audit schema:
 *   - audit_exports: one row per export request; status-mutable, otherwise immutable
 *   - audit_export_chunks: append-only byte chunks of the encrypted package
 *   - evidence_packages: append-only metadata for completed packages
 *
 * Migration: 0013_audit_export.sql
 */

import {
  uuid,
  text,
  jsonb,
  timestamp,
  integer,
  bigint,
  index,
} from 'drizzle-orm/pg-core'

// Re-use the existing audit schema object declared in audit.ts.
// We import it to share the schema namespace rather than re-declaring it.
import { audit } from './audit.js'

// ---------------------------------------------------------------------------
// audit_exports
// ---------------------------------------------------------------------------

export const auditExports = audit.table(
  'audit_exports',
  {
    exportId: uuid('export_id').primaryKey(),
    installId: uuid('install_id').notNull(),
    /** ActorSchema — must be type='user'. Stored as JSONB. */
    requestedBy: jsonb('requested_by').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true, mode: 'string' }).notNull(),
    rangeStart: timestamp('range_start', { withTimezone: true, mode: 'string' }).notNull(),
    rangeEnd: timestamp('range_end', { withTimezone: true, mode: 'string' }).notNull(),
    /** ScopeFilterSchema — discriminated union stored as JSONB. */
    scopeFilter: jsonb('scope_filter').notNull(),
    /** event_id of the AuditExportRequested event that set the cutoff. */
    cutoffEventId: uuid('cutoff_event_id').notNull(),
    /** pending | running | completed | failed | cancelled */
    status: text('status').notNull(),
    progressPercent: integer('progress_percent').notNull().default(0),
    /** 'events' | 'capabilities' | 'ceremonies' | 'archiving' | 'encrypting' */
    progressStage: text('progress_stage'),
    /** FK to evidence_packages.package_id — set on completion. */
    packageId: uuid('package_id'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'string' }),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'string' }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'string' }),
    /** capability_id that authorized the export. */
    capabilityId: uuid('capability_id').notNull(),
    /** Free-text justification — SOC2 CC8. */
    justification: text('justification').notNull(),
    schemaVersion: integer('schema_version').notNull().default(1),
  },
  (t) => ({
    byInstallTime: index('audit_exports_install_time').on(t.installId, t.requestedAt),
    byStatus: index('audit_exports_status').on(t.status),
  }),
)

// ---------------------------------------------------------------------------
// audit_export_chunks
// ---------------------------------------------------------------------------

export const auditExportChunks = audit.table(
  'audit_export_chunks',
  {
    chunkId: uuid('chunk_id').primaryKey(),
    exportId: uuid('export_id').notNull(),
    /** 0-based, contiguous. */
    chunkIndex: integer('chunk_index').notNull(),
    /** Byte offset of this chunk within the full package file. */
    byteOffset: bigint('byte_offset', { mode: 'bigint' }).notNull(),
    byteLength: integer('byte_length').notNull(),
    /** SHA-256 hex of this chunk's bytes. */
    sha256: text('sha256').notNull(),
    /** Absolute filesystem path, e.g. ~/.orbital/audit-exports/{id}/chunks/{index}.bin */
    storagePath: text('storage_path').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (t) => ({
    byExport: index('audit_export_chunks_export').on(t.exportId, t.chunkIndex),
  }),
)

// ---------------------------------------------------------------------------
// evidence_packages
// ---------------------------------------------------------------------------

export const evidencePackages = audit.table('evidence_packages', {
  packageId: uuid('package_id').primaryKey(),
  exportId: uuid('export_id').notNull(),
  /** evidence-{export_id}-{range_start_yyyymmdd}-{range_end_yyyymmdd}.tar.zst.enc */
  filename: text('filename').notNull(),
  totalBytes: bigint('total_bytes', { mode: 'bigint' }).notNull(),
  totalChunks: integer('total_chunks').notNull(),
  /** SHA-256 hex of manifest.json (plaintext). */
  manifestSha256: text('manifest_sha256').notNull(),
  /** SHA-256 hex of the full encrypted tarball. */
  packageSha256: text('package_sha256').notNull(),
  /** Base64 Ed25519 signature of manifest bytes, signed by master key. */
  manifestSignature: text('manifest_signature').notNull(),
  /** Master key fingerprint (hex of SHA-256 of public key bytes). */
  signingKeyId: text('signing_key_id').notNull(),
  /** Encryption algorithm description. AES-256-GCM (v1 implementation). */
  encryptionAlgo: text('encryption_algo').notNull(),
  /** KDF algorithm: scrypt (v1 implementation). */
  kdfAlgo: text('kdf_algo').notNull(),
  /** Base64 salt fed to scrypt. 16 bytes, first bytes of encrypted file. */
  kdfSaltB64: text('kdf_salt_b64').notNull(),
  /** scrypt N parameter (cost factor). */
  kdfMemoryKib: integer('kdf_memory_kib').notNull(),
  /** scrypt r parameter. */
  kdfIterations: integer('kdf_iterations').notNull(),
  /** scrypt p parameter. */
  kdfParallelism: integer('kdf_parallelism').notNull(),
  /** Base64 IV (12 bytes) fed to AES-256-GCM. Second field in encrypted file header. */
  nonceB64: text('nonce_b64').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  downloadedAt: timestamp('downloaded_at', { withTimezone: true, mode: 'string' }),
  downloadCount: integer('download_count').notNull().default(0),
  /** Server-side cleanup horizon. */
  retainedUntil: timestamp('retained_until', { withTimezone: true, mode: 'string' }).notNull(),
  schemaVersion: integer('schema_version').notNull().default(1),
})
