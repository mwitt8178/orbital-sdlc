import { z } from 'zod'

/** Per Primitives §10 — canonical error envelope. */
export const RetryAdviceSchema = z.enum([
  'retry_now',
  'retry_with_backoff',
  'no_retry',
  'escalate_to_human',
])

export type RetryAdvice = z.infer<typeof RetryAdviceSchema>

export const ErrorBodySchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
  audit_id: z.string().optional(),
  retry_advice: RetryAdviceSchema.optional(),
  trace_id: z.string(),
})

export const ErrorResponseSchema = z.object({
  error: ErrorBodySchema,
})

export type ErrorBody = z.infer<typeof ErrorBodySchema>
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>

/** OrbitalError — domain error class. Surfaces with `code` + `traceId`. */
export class OrbitalError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
    public readonly retryAdvice?: RetryAdvice,
    public readonly auditId?: string,
    public readonly traceId?: string,
  ) {
    super(message)
    this.name = 'OrbitalError'
  }

  toResponse(traceId: string): ErrorResponse {
    return {
      error: {
        code: this.code,
        message: this.message,
        details: this.details,
        audit_id: this.auditId,
        retry_advice: this.retryAdvice,
        trace_id: this.traceId ?? traceId,
      },
    }
  }
}
