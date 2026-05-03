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
import type { FastifyInstance } from 'fastify';
/**
 * Register audit export REST routes on a Fastify instance.
 * Additive: does not modify any existing routes.
 *
 * Usage in index.ts (single line):
 *   registerAuditExportRoutes(app, {})
 */
export declare function registerAuditExportRoutes(app: FastifyInstance, _opts?: Record<string, unknown>): void;
//# sourceMappingURL=rest.d.ts.map