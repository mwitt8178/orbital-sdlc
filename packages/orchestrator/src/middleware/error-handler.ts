import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify'
import { OrbitalError, type ErrorResponse } from '@orbital/types'
import { logger } from '../config/logger.js'
import { trace } from '@opentelemetry/api'

/** Centralized error handler — converts errors to canonical Primitives §10 envelope. */
export function errorHandler(
  err: FastifyError | Error,
  req: FastifyRequest,
  reply: FastifyReply,
): void {
  const traceId = trace.getActiveSpan()?.spanContext().traceId ?? 'no-trace'

  if (err instanceof OrbitalError) {
    logger.warn({ err, code: err.code, traceId }, 'Domain error')
    const status = mapCodeToStatus(err.code)
    void reply.status(status).send(err.toResponse(traceId))
    return
  }

  // Validation error from Fastify schema
  const fastifyErr = err as FastifyError
  if (fastifyErr.validation) {
    const body: ErrorResponse = {
      error: {
        code: 'VALIDATION_INVALID_REQUEST',
        message: fastifyErr.message,
        details: { issues: fastifyErr.validation as unknown as Record<string, unknown> },
        trace_id: traceId,
      },
    }
    void reply.status(400).send(body)
    return
  }

  logger.error({ err, traceId, path: req.url }, 'Unhandled error')
  const body: ErrorResponse = {
    error: {
      code: 'INTERNAL_UNEXPECTED',
      message: 'An unexpected error occurred',
      trace_id: traceId,
    },
  }
  void reply.status(500).send(body)
}

function mapCodeToStatus(code: string): number {
  if (code.startsWith('AUTH_')) return code.includes('SCOPE_DENIED') ? 403 : 401
  if (code.startsWith('VALIDATION_')) return 400
  if (code.startsWith('CONFLICT_')) return 409
  if (code.startsWith('NOT_FOUND_')) return 404
  if (code.startsWith('RATE_LIMIT_')) return 429
  if (code.startsWith('TIMEOUT_')) return 408
  if (code.startsWith('BUDGET_')) return 422
  if (code.startsWith('UAT_AC_NOT_MARKED')) return 422
  return 500
}
