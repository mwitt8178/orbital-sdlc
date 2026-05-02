import type { FastifyInstance } from 'fastify'
import { logger } from '../config/logger.js'

/** Logs every request with method, path, status, duration. */
export function registerRequestLogger(app: FastifyInstance): void {
  app.addHook('onResponse', async (req, reply) => {
    logger.info(
      {
        method: req.method,
        path: req.url,
        status: reply.statusCode,
        duration_ms: Math.round(reply.elapsedTime),
        userAgent: req.headers['user-agent'],
      },
      'Request completed',
    )
  })
}
