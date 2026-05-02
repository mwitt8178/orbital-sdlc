/**
 * OTel tracing middleware for MCP tool calls.
 *
 * Per Implementation Plan §6 Task 2B: wraps each tool call in an OTel span.
 * Uses @opentelemetry/api (no-op SDK if no exporter is configured).
 *
 * trace_id: derived from the OTel span context. If the bundle carries a
 * trace_id it is used as the parent trace context; otherwise a new trace
 * is started and the generated trace_id is attached to the call.
 */

import { trace, context, SpanStatusCode, type Span } from '@opentelemetry/api'
import { logger } from '../../config/logger.js'

const tracer = trace.getTracer('orbital-mcp-gateway', '0.1.0')

export interface SpanResult<T> {
  result: T
  traceId: string
}

/**
 * Run `fn` inside an OTel span named `mcp.${toolName}`.
 * Returns the result and the hex trace_id from the active span context.
 *
 * If OTel is not configured (no-op tracer), returns a generated trace_id
 * from the span's context anyway (the no-op returns INVALID_TRACE_ID "0000...").
 * In that case we fall back to the provided fallbackTraceId.
 */
export async function withToolSpan<T>(
  toolName: string,
  fallbackTraceId: string,
  fn: (span: Span, traceId: string) => Promise<T>,
): Promise<SpanResult<T>> {
  return tracer.startActiveSpan(`mcp.${toolName}`, async (span) => {
    const spanContext = span.spanContext()
    // traceId is 32 hex chars from OTel; fall back if all zeros (no-op tracer).
    const rawTraceId = spanContext.traceId
    const traceId =
      rawTraceId && rawTraceId !== '00000000000000000000000000000000'
        ? rawTraceId
        : fallbackTraceId

    try {
      span.setAttribute('mcp.tool', toolName)
      const result = await fn(span, traceId)
      span.setStatus({ code: SpanStatusCode.OK })
      return { result, traceId }
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      })
      span.recordException(err instanceof Error ? err : new Error(String(err)))
      logger.error({ err, tool: toolName, trace_id: traceId }, 'mcp tool call failed')
      throw err
    } finally {
      span.end()
    }
  })
}

/**
 * Resolve a trace_id from a bundle or generate a new one.
 * In Phase 2B the bundle does not carry a trace_id field natively,
 * so we derive one from the capability_id (deterministic per call context).
 * Phase 6B will wire in OTel propagation headers.
 */
export function resolveTraceId(capabilityId: string, requestId: string | number | null): string {
  // Use the first 32 hex chars of the combined ids as a stable trace_id.
  const raw = `${capabilityId}${requestId ?? ''}`.replace(/-/g, '')
  return raw.substring(0, 32).padEnd(32, '0')
}
