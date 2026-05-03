/**
 * audit-export/rest.ts — Fastify REST routes for audit export download.
 *
 * Per TRD-12 §6.2 and task spec:
 *   GET /api/v1/audit/export/:exportId
 *     - Serves the encrypted tarball with HTTP Range support (206 Partial Content)
 *     - Emits AuditExportDownloaded via EventStore on completion/abort
 *
 * Range support:
 *   - Parse Range: bytes=N-M header
 *   - Respond 206 with Content-Range: bytes N-M/total and Content-Length: M-N+1
 *   - If M omitted: use total-1
 *   - Supports resume: GET with Range from byte N returns bytes [N..end]
 *
 * Events emitted:
 *   - AuditExportDownloaded(completed=true) on full delivery
 *   - AuditExportDownloaded(completed=false, bytes_sent=N) on client disconnect
 */

import type { FastifyInstance } from 'fastify'
import { createReadStream, statSync } from 'node:fs'
import fs from 'node:fs/promises'
import { uuidv7 } from 'uuidv7'
import { eq } from 'drizzle-orm'
import { db, sql as sqlPool } from '@orbital/db'
import { createEventStore } from '../events/store.js'
import { auditExports, auditExportChunks, evidencePackages } from '@orbital/db'
import { logger } from '../logger.js'

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register audit export REST routes on a Fastify instance.
 * Additive: does not modify any existing routes.
 *
 * Usage in index.ts (single line):
 *   registerAuditExportRoutes(app, {})
 */
export function registerAuditExportRoutes(
  app: FastifyInstance,
  _opts: Record<string, unknown> = {},
): void {
  /**
   * GET /api/v1/audit/export/:exportId
   * Streams the encrypted package with Range support.
   *
   * @route   GET /api/v1/audit/export/:exportId
   * @summary Download the encrypted audit evidence package.
   * @access  Public (capability enforcement at MCP gateway layer in full impl)
   *
   * @param   exportId - The export ID (UUIDv7)
   *
   * @returns {200} Full file (no Range header)
   * @returns {206} Partial content (Range: bytes=N-M provided)
   * @returns {404} NOT_FOUND_EXPORT — export not found or no package yet
   * @returns {409} EXPORT_NOT_READY — export still pending/running
   */
  app.get<{
    Params: { exportId: string }
  }>('/api/v1/audit/export/:exportId', async (req, reply) => {
    const { exportId } = req.params

    // Look up export
    const exportRows = await db
      .select()
      .from(auditExports)
      .where(eq(auditExports.exportId, exportId))
      .limit(1)

    const exportRow = exportRows[0]
    if (!exportRow) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND_EXPORT', message: 'Export not found' },
      })
    }

    if (exportRow.status === 'pending' || exportRow.status === 'running') {
      return reply.status(409).send({
        error: {
          code: 'EXPORT_NOT_READY',
          message: `Export is not yet ready (status: ${exportRow.status})`,
        },
      })
    }

    if (exportRow.status !== 'completed' || !exportRow.packageId) {
      return reply.status(409).send({
        error: {
          code: 'EXPORT_NOT_READY',
          message: `Export is in terminal state: ${exportRow.status}`,
        },
      })
    }

    // Look up evidence package
    const pkgRows = await db
      .select()
      .from(evidencePackages)
      .where(eq(evidencePackages.packageId, exportRow.packageId))
      .limit(1)

    const pkg = pkgRows[0]
    if (!pkg) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND_EXPORT', message: 'Evidence package record not found' },
      })
    }

    // Look up chunk(s) — v1 has one chunk
    const chunkRows = await db
      .select()
      .from(auditExportChunks)
      .where(eq(auditExportChunks.exportId, exportId))
      .orderBy(auditExportChunks.chunkIndex)

    if (chunkRows.length === 0) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND_EXPORT', message: 'No chunks found for export' },
      })
    }

    // Total size from DB (not used directly; fileSize from statSync is authoritative)
    const _totalBytesFromDb = chunkRows.reduce((acc, c) => acc + c.byteLength, 0)
    const packagePath = chunkRows[0]!.storagePath

    // Verify file exists
    try {
      await fs.access(packagePath)
    } catch {
      return reply.status(404).send({
        error: { code: 'EXPORT_PURGED', message: 'Package file not found on disk' },
      })
    }

    const fileStat = statSync(packagePath)
    const fileSize = fileStat.size

    // Parse Range header
    const rangeHeader = req.headers['range'] as string | undefined
    let rangeStart = 0
    let rangeEnd = fileSize - 1
    let isRangeRequest = false

    if (rangeHeader) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader)
      if (match) {
        isRangeRequest = true
        rangeStart = parseInt(match[1]!, 10)
        rangeEnd = match[2] && match[2] !== '' ? parseInt(match[2]!, 10) : fileSize - 1

        // Clamp
        if (rangeEnd >= fileSize) rangeEnd = fileSize - 1
        if (rangeStart > rangeEnd) {
          return reply.status(416).send({
            error: { code: 'RANGE_NOT_SATISFIABLE', message: 'Range not satisfiable' },
          })
        }
      }
    }

    const contentLength = rangeEnd - rangeStart + 1

    // Set response headers
    void reply.header('Content-Type', 'application/octet-stream')
    void reply.header(
      'Content-Disposition',
      `attachment; filename="${pkg.filename}"`,
    )
    void reply.header('Content-Length', String(contentLength))
    void reply.header('X-Package-SHA256', pkg.packageSha256)
    void reply.header('X-Manifest-Signature', pkg.manifestSignature)
    void reply.header('X-Total-Bytes', String(fileSize))
    void reply.header('Accept-Ranges', 'bytes')

    if (isRangeRequest) {
      void reply.header('Content-Range', `bytes ${rangeStart}-${rangeEnd}/${fileSize}`)
      reply.status(206)
    } else {
      reply.status(200)
    }

    // Stream the file
    const downloadId = uuidv7()
    let bytesSent = 0
    let completed = false

    const eventStore = createEventStore(db, sqlPool)

    const fileStream = createReadStream(packagePath, {
      start: rangeStart,
      end: rangeEnd,
    })

    fileStream.on('data', (chunk: Buffer | string) => {
      bytesSent += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
    })

    // Handle client disconnect
    req.socket.on('close', () => {
      if (!completed) {
        void eventStore
          .append({
            aggregate_id: exportId,
            aggregate_type: 'audit_export',
            event_type: 'AuditExportDownloaded',
            payload: {
              export_id: exportId,
              package_id: pkg.packageId,
              download_id: downloadId,
              bytes_sent: bytesSent,
              client_ip: req.ip,
              user_agent: req.headers['user-agent'],
              completed: false,
            },
            actor: { type: 'system', component: 'audit_service' },
            trace_id: `audit-export-download-${downloadId}`,
            occurred_at: new Date().toISOString(),
            schema_version: 1,
          })
          .catch((err: unknown) => {
            logger.warn({ err, exportId }, 'AuditExport: failed to emit incomplete download event')
          })
      }
    })

    fileStream.on('end', () => {
      completed = true
      void eventStore
        .append({
          aggregate_id: exportId,
          aggregate_type: 'audit_export',
          event_type: 'AuditExportDownloaded',
          payload: {
            export_id: exportId,
            package_id: pkg.packageId,
            download_id: downloadId,
            bytes_sent: bytesSent,
            client_ip: req.ip,
            user_agent: req.headers['user-agent'],
            completed: true,
          },
          actor: { type: 'system', component: 'audit_service' },
          trace_id: `audit-export-download-${downloadId}`,
          occurred_at: new Date().toISOString(),
          schema_version: 1,
        })
        .catch((err: unknown) => {
          logger.warn({ err, exportId }, 'AuditExport: failed to emit completed download event')
        })
    })

    return reply.send(fileStream)
  })
}
