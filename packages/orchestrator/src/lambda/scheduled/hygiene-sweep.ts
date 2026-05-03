/**
 * lambda/scheduled/hygiene-sweep.ts — EventBridge-triggered hourly hygiene sweep.
 *
 * [Engineer-Sr · Sonnet · run-round8-05-event-bus]
 *
 * Fires every hour (EventBridge rate(1 hour) rule).
 *
 * Sweeps:
 *  1. Stale worker records (workers that last heartbeat > 10 minutes ago).
 *  2. Expired sessions (DynamoDB WS connections with expired TTL not yet purged by DDB).
 *  3. Orphaned tasks (tasks in 'running' state with no active worker).
 *
 * v1: structured CloudWatch log of sweep results.
 * v2 (deferred): actual DB cleanup of stale rows.
 *
 * The sweep is idempotent — running it multiple times produces the same result.
 */

import { logger } from '../../config/logger.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EventBridgeScheduledEvent {
  version: string
  id: string
  'detail-type': string
  source: string
  account: string
  time: string
  region: string
  detail: Record<string, unknown>
}

interface SweepResult {
  staleWorkersFound: number
  expiredSessionsFound: number
  orphanedTasksFound: number
  staleWorkersRemoved: number
  expiredSessionsRemoved: number
  orphanedTasksReset: number
  errors: string[]
}

// ---------------------------------------------------------------------------
// Sweep functions (v1 stubs; v2 wires DB)
// ---------------------------------------------------------------------------

/**
 * Sweep stale workers — workers with last_heartbeat_at > 10 minutes ago.
 *
 * v1: log intent.
 * v2 (deferred): UPDATE workers SET status='idle' WHERE status='running'
 *   AND last_heartbeat_at < NOW() - INTERVAL '10 minutes'
 */
async function sweepStaleWorkers(_utcNow: Date): Promise<{ found: number; removed: number }> {
  // v2 TODO (deferred): query and clean up stale worker rows
  logger.debug('hygiene-sweep: stale worker sweep — v1 stub (deferred)')
  return { found: 0, removed: 0 }
}

/**
 * Sweep expired sessions — WS connections in DynamoDB with TTL in the past.
 * DynamoDB TTL background deletion can lag up to 48h; this sweep proactively
 * cleans rows that have expired but not yet been removed.
 *
 * v1: log intent.
 * v2 (deferred): scan DynamoDB connections table for expired TTL rows.
 */
async function sweepExpiredSessions(_utcNow: Date): Promise<{ found: number; removed: number }> {
  // v2 TODO (deferred): scan DynamoDB connections table
  logger.debug('hygiene-sweep: expired session sweep — v1 stub (deferred)')
  return { found: 0, removed: 0 }
}

/**
 * Sweep orphaned tasks — tasks in 'running' state with no matching active worker.
 *
 * v1: log intent.
 * v2 (deferred): cross-join tasks and workers tables; reset orphaned tasks to 'queued'.
 */
async function sweepOrphanedTasks(_utcNow: Date): Promise<{ found: number; reset: number }> {
  // v2 TODO (deferred): query orphaned tasks and reset them
  logger.debug('hygiene-sweep: orphaned task sweep — v1 stub (deferred)')
  return { found: 0, reset: 0 }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler = async (event: EventBridgeScheduledEvent): Promise<void> => {
  const utcNow = new Date(event.time ?? Date.now())

  logger.info(
    { utc_now: utcNow.toISOString() },
    'hygiene-sweep: Lambda invoked',
  )

  const result: SweepResult = {
    staleWorkersFound: 0,
    expiredSessionsFound: 0,
    orphanedTasksFound: 0,
    staleWorkersRemoved: 0,
    expiredSessionsRemoved: 0,
    orphanedTasksReset: 0,
    errors: [],
  }

  // Run all sweeps in parallel; collect results independently so one failure
  // doesn't block the others.
  const [workers, sessions, tasks] = await Promise.allSettled([
    sweepStaleWorkers(utcNow),
    sweepExpiredSessions(utcNow),
    sweepOrphanedTasks(utcNow),
  ])

  if (workers.status === 'fulfilled') {
    result.staleWorkersFound = workers.value.found
    result.staleWorkersRemoved = workers.value.removed
  } else {
    result.errors.push(`stale-workers: ${String(workers.reason)}`)
    logger.error({ err: workers.reason }, 'hygiene-sweep: stale worker sweep failed')
  }

  if (sessions.status === 'fulfilled') {
    result.expiredSessionsFound = sessions.value.found
    result.expiredSessionsRemoved = sessions.value.removed
  } else {
    result.errors.push(`expired-sessions: ${String(sessions.reason)}`)
    logger.error({ err: sessions.reason }, 'hygiene-sweep: expired session sweep failed')
  }

  if (tasks.status === 'fulfilled') {
    result.orphanedTasksFound = tasks.value.found
    result.orphanedTasksReset = tasks.value.reset
  } else {
    result.errors.push(`orphaned-tasks: ${String(tasks.reason)}`)
    logger.error({ err: tasks.reason }, 'hygiene-sweep: orphaned task sweep failed')
  }

  logger.info(
    { ...result, utc_now: utcNow.toISOString() },
    'hygiene-sweep: sweep complete',
  )

  // Surface sweep errors by throwing so EventBridge records a failed invocation
  // and the DLQ catches persistent failures.
  if (result.errors.length > 0) {
    throw new Error(`hygiene-sweep: ${result.errors.length} sweep(s) failed: ${result.errors.join('; ')}`)
  }
}
