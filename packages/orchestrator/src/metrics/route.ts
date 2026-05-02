/**
 * route.ts — Fastify route that serves Prometheus text-format metrics.
 *
 * Per Phase 6B spec:
 *   GET /metrics → registry.metrics() as text/plain; charset=utf-8
 *
 * Exports `registerMetricsRoute(app, registry): void`
 */

import type { FastifyInstance } from 'fastify'
import type { Registry } from 'prom-client'

export function registerMetricsRoute(app: FastifyInstance, registry: Registry): void {
  app.get('/metrics', async (_req, reply) => {
    const output = await registry.metrics()
    return reply
      .status(200)
      .header('Content-Type', registry.contentType)
      .send(output)
  })
}
