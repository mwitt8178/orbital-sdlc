/**
 * telemetry.ts — OpenTelemetry SDK initialization.
 *
 * Per Phase 6B spec:
 * - NODE_ENV=test: NoopTracerProvider (no spans emitted; keeps tests fast)
 * - NODE_ENV=development: ConsoleSpanExporter (stdout trace output)
 * - OTEL_EXPORTER_OTLP_ENDPOINT set: OTLPTraceExporter to that URL
 * - NODE_ENV=production, no OTLP endpoint: ConsoleSpanExporter
 *
 * Exports `initTelemetry(): Promise<{ shutdown: () => Promise<void> }>`
 * which must be called once at process start, before imports that create spans.
 */

import { loadEnv } from './env.js'
import { logger } from './logger.js'

export interface TelemetryHandle {
  shutdown: () => Promise<void>
}

let initialized = false

export async function initTelemetry(): Promise<TelemetryHandle> {
  const env = loadEnv()

  // In test environment, skip all OTel SDK init; use no-op tracer.
  // The @opentelemetry/api package is always present and provides a no-op
  // tracer by default when no SDK is registered — so no action needed here.
  if (env.NODE_ENV === 'test') {
    return { shutdown: async () => {} }
  }

  if (initialized) {
    logger.warn('initTelemetry() called more than once; skipping duplicate init')
    return { shutdown: async () => {} }
  }
  initialized = true

  // Dynamic imports so that in test environments these heavy modules are
  // never loaded (keeps test startup fast and prevents OTel interference).
  const { NodeSDK } = await import('@opentelemetry/sdk-node')
  const { getNodeAutoInstrumentations } = await import(
    '@opentelemetry/auto-instrumentations-node'
  )

  let exporter
  if (env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http')
    exporter = new OTLPTraceExporter({ url: env.OTEL_EXPORTER_OTLP_ENDPOINT })
    logger.info(
      { endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT },
      'OTel: using OTLP trace exporter',
    )
  } else {
    const { ConsoleSpanExporter } = await import('@opentelemetry/sdk-trace-node')
    exporter = new ConsoleSpanExporter()
    logger.info('OTel: using console span exporter (no OTEL_EXPORTER_OTLP_ENDPOINT set)')
  }

  const sdk = new NodeSDK({
    traceExporter: exporter,
    instrumentations: [
      getNodeAutoInstrumentations({
        // Disable noisy instrumentations that aren't useful in orchestrator context
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
      }),
    ],
    serviceName: 'orbital-orchestrator',
  })

  await sdk.start()
  logger.info('OTel SDK started')

  return {
    shutdown: async () => {
      try {
        await sdk.shutdown()
        logger.info('OTel SDK shut down')
      } catch (err) {
        logger.error({ err }, 'OTel SDK shutdown error')
      }
    },
  }
}
