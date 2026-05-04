/**
 * trpc/routers/webhooks.ts — Project-scoped webhook delivery surface.
 *
 * Procedures:
 *   webhooks.list({ projectId, limit })       → recent github_webhook_deliveries
 *                                                  filtered by tenant
 *   webhooks.testDelivery({ projectId })      → records a synthetic
 *                                                  pull_request.opened delivery
 *
 * The github_webhook_deliveries table is tenant-scoped but not project-scoped
 * (deliveries arrive at the install level). For per-project listing in v1 we
 * filter by tenant + limit; if multiple projects share the install, all
 * deliveries are surfaced. A future migration will add a project_id column.
 *
 * [Engineer-Principal · Opus · run-settings-integrations]
 */

import { z } from 'zod'
import { sql as drizzleSql } from 'drizzle-orm'
import { router } from '../init.js'
import { tenantProcedure } from '../middleware/tenant.js'
import { db } from '../../db/client.js'
import { logger } from '../../config/logger.js'
import { randomUUID, createHash } from 'node:crypto'

const listInputSchema = z.object({
  projectId: z.string().uuid(),
  limit: z.number().int().min(1).max(100).default(10),
})

const testDeliveryInputSchema = z.object({
  projectId: z.string().uuid(),
})

export const webhooksRouter = router({
  list: tenantProcedure.input(listInputSchema).query(async ({ input, ctx }) => {
    try {
      const rows = await db.execute<{
        delivery_id: string
        event_type: string
        action: string | null
        received_at: Date
        processed_at: Date | null
        result: string | null
      }>(drizzleSql`
        SELECT delivery_id, event_type, action, received_at, processed_at, result
          FROM github_webhook_deliveries
         WHERE tenant_id = ${ctx.tenantId}
         ORDER BY received_at DESC
         LIMIT ${input.limit}
      `)
      const arr = (Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? []) as Array<{
        delivery_id: string
        event_type: string
        action: string | null
        received_at: Date | string
        processed_at: Date | string | null
        result: string | null
      }>
      return arr.map((r) => ({
        deliveryId: r.delivery_id,
        eventType: r.event_type,
        action: r.action,
        receivedAt:
          r.received_at instanceof Date
            ? r.received_at.toISOString()
            : new Date(r.received_at).toISOString(),
        processedAt:
          r.processed_at === null
            ? null
            : r.processed_at instanceof Date
              ? r.processed_at.toISOString()
              : new Date(r.processed_at).toISOString(),
        result: r.result,
      }))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn({ err: msg, projectId: input.projectId }, 'webhooks.list: failed')
      return []
    }
  }),

  /**
   * testDelivery — synthesise a pull_request.opened delivery and write a row.
   *
   * This is intentionally local-only (no outbound HTTP) so it works on every
   * environment. The synthetic row is marked `result='synthetic'` so it is
   * visually distinct from real deliveries.
   */
  testDelivery: tenantProcedure
    .input(testDeliveryInputSchema)
    .mutation(async ({ input, ctx }) => {
      const deliveryId = `synthetic-${randomUUID()}`
      const payload = {
        action: 'opened',
        synthetic: true,
        projectId: input.projectId,
        sentAt: new Date().toISOString(),
      }
      const sha = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
      try {
        await db.execute(drizzleSql`
          INSERT INTO github_webhook_deliveries
            (delivery_id, tenant_id, installation_id, event_type, action,
             payload_sha256, received_at, processed_at, result)
          VALUES
            (${deliveryId}, ${ctx.tenantId}, NULL, 'pull_request', 'opened',
             ${sha}, clock_timestamp(), clock_timestamp(), 'synthetic')
        `)
        logger.info({ deliveryId, projectId: input.projectId }, 'webhooks.testDelivery: recorded synthetic delivery')
        return { ok: true as const, deliveryId, result: 'synthetic' }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error({ err: msg, projectId: input.projectId }, 'webhooks.testDelivery: failed')
        return { ok: false as const, message: msg }
      }
    }),
})

export type WebhooksRouter = typeof webhooksRouter
