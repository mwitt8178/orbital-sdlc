/**
 * tracing.ts — Fastify plugin that wraps each HTTP request in an OTel root span.
 *
 * Per Phase 6B spec:
 * - onRequest hook: starts a span named `http.{METHOD} {routerPath}`
 * - injects trace_id into req.headers so downstream code can read it
 * - onResponse hook: records http.status_code attribute and ends span
 *
 * Exports `registerTracing(app): Promise<void>`
 */

import type { FastifyInstance } from 'fastify'
import { trace, context, SpanStatusCode, type Span } from '@opentelemetry/api'
import { logger } from '../config/logger.js'

const tracer = trace.getTracer('orbital-orchestrator-http', '0.1.0')

// We store the span on the request object so onResponse can close it.
declare module 'fastify' {
  interface FastifyRequest {
    _otelSpan?: Span
    traceId?: string
  }
}

const NOOP_TRACE_ID = '00000000000000000000000000000000'

export async function registerTracing(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (req) => {
    // Route path may not be resolved yet; we use a placeholder and update on response.
    const routePath = req.routeOptions?.url ?? req.url ?? 'unknown'
    const spanName = `http.${req.method} ${routePath}`

    const span = tracer.startSpan(spanName, {
      attributes: {
        'http.method': req.method,
        'http.url': req.url,
        'http.route': routePath,
        'http.host': req.hostname,
      },
    })

    // Make the span active in the async context for this request.
    const ctx = trace.setSpan(context.active(), span)
    // Store for onResponse and downstream use.
    req._otelSpan = span

    const spanContext = span.spanContext()
    const traceId =
      spanContext.traceId && spanContext.traceId !== NOOP_TRACE_ID
        ? spanContext.traceId
        : // Fallback for no-op tracer (test env): generate a unique trace id per request
          `req-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`

    req.traceId = traceId

    // Inject into headers so EventStore.append wrappers can pick it up.
    // This mutates the incoming headers object (safe in Node; req.headers is plain object).
    // Using a non-standard header so it doesn't conflict with real propagation headers.
    ;(req.headers as Record<string, string>)['x-orbital-trace-id'] = traceId

    // Keep the active context alive for the duration of the request.
    // Fastify runs hooks in the request's async context; we re-activate here.
    void context.with(ctx, async () => {})
  })

  app.addHook('onResponse', async (req, reply) => {
    const span = req._otelSpan
    if (!span) return

    const routePath = req.routeOptions?.url ?? req.url ?? 'unknown'
    span.updateName(`http.${req.method} ${routePath}`)
    span.setAttribute('http.status_code', reply.statusCode)

    if (reply.statusCode >= 500) {
      span.setStatus({ code: SpanStatusCode.ERROR })
    } else {
      span.setStatus({ code: SpanStatusCode.OK })
    }

    span.end()

    logger.debug(
      { method: req.method, route: routePath, status: reply.statusCode, trace_id: req.traceId },
      'request span closed',
    )
  })
}
