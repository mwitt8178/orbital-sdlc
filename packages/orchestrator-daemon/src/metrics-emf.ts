/**
 * EMF (Embedded Metric Format) metric helper.
 *
 * Phase 5.2 of the migration: emit custom metrics by writing structured
 * log lines that CloudWatch Logs auto-ingests as metrics. This avoids
 * the per-call cost of PutMetricData (which becomes substantial as the
 * fleet grows).
 *
 * Reference: https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html
 *
 * Usage:
 *   emitMetric({
 *     namespace: 'Orbital/Daemon',
 *     metric: 'workers_spawned',
 *     value: 1,
 *     unit: 'Count',
 *     dimensions: { tenant_id: '...', worker_kind: 'pm-persona' },
 *   })
 */

import { systemLogger } from './logger.js'

export interface EmitMetricArgs {
  /** CloudWatch namespace, e.g. 'Orbital/Daemon'. */
  readonly namespace: string
  readonly metric: string
  readonly value: number
  readonly unit?:
    | 'Count'
    | 'Seconds'
    | 'Milliseconds'
    | 'Bytes'
    | 'Bits'
    | 'Percent'
    | 'None'
  /** Dimensions are key/value pairs that fan out the metric. ALWAYS include
   * tenant_id when emitting per-tenant business metrics. */
  readonly dimensions?: Record<string, string>
  readonly timestampMs?: number
}

/**
 * Emit one EMF metric line. The line is JSON, CloudWatch Logs picks it up,
 * and the metric is created automatically without a PutMetricData call.
 */
export function emitMetric(args: EmitMetricArgs): void {
  const ts = args.timestampMs ?? Date.now()
  const dims = args.dimensions ?? {}
  const dimensionKeys = Object.keys(dims)

  // Build the EMF envelope. The `_aws.CloudWatchMetrics[0].Dimensions[0]`
  // is an array of arrays — each inner array is one fully-permuted
  // dimension set. We use a single permutation that includes all the keys.
  const emf: Record<string, unknown> = {
    _aws: {
      Timestamp: ts,
      CloudWatchMetrics: [
        {
          Namespace: args.namespace,
          Dimensions: dimensionKeys.length === 0 ? [[]] : [dimensionKeys],
          Metrics: [
            {
              Name: args.metric,
              Unit: args.unit ?? 'None',
            },
          ],
        },
      ],
    },
    [args.metric]: args.value,
    ...dims,
  }

  // CloudWatch picks the EMF up via the awslogs driver. We log at info
  // so non-prod log levels don't suppress it.
  systemLogger.info(emf, 'metric')
}

/**
 * Convenience: emit a counter increment.
 */
export function counter(name: string, dimensions?: Record<string, string>, namespace = 'Orbital/Daemon'): void {
  emitMetric({ namespace, metric: name, value: 1, unit: 'Count', dimensions })
}

/**
 * Convenience: emit a duration in milliseconds.
 */
export function duration(name: string, ms: number, dimensions?: Record<string, string>, namespace = 'Orbital/Daemon'): void {
  emitMetric({ namespace, metric: name, value: ms, unit: 'Milliseconds', dimensions })
}
