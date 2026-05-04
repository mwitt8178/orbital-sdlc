/**
 * @orbital/orchestrator-daemon — long-running orchestrator daemon main.
 *
 * Runs in ECS Fargate. Owns:
 *   - scheduler tick loop (worker dispatch, ticket pickup)
 *   - Claude worker spawn via child_process
 *   - worktree management
 *   - agent-org git repo (on EFS at /var/orbital/agent-org)
 *   - persona dispatch (PM / Reviewer / QA / Retro analyst)
 *   - cost ledger writes
 *   - retry / dead-letter routing for failed workers
 *
 * Boot sequence:
 *   1. Initialize structured logging (pino, JSON, tenant_id required).
 *   2. Resolve secrets from Secrets Manager (5-minute TTL cache).
 *   3. Build Aurora client via RDS Proxy IAM auth.
 *   4. Subscribe to SQS daemon work queue.
 *   5. Start scheduler tick loop.
 *   6. Bind SIGTERM/SIGINT to graceful shutdown.
 *
 * The daemon does NOT serve HTTP. It reads work from Aurora and SQS,
 * publishes events to SNS. The api-lambda reads the state the daemon
 * produces.
 */

import { hostname } from 'node:os'
import http from 'node:http'
import { ulid } from 'ulid'
import pino from 'pino'

// Use @orbital/db directly — the DB client is now in its own package.
import { getDb, closeDb } from '@orbital/db'
import { getSecrets } from '../../orchestrator/dist/lambda/secrets-cache.js'
import { createEventStore } from '../../orchestrator/dist/events/store.js'
import { SqsConsumer, type EventHandler } from './sqs-consumer.js'
import { counter } from './metrics-emf.js'
import { handleStoryReady, isStoryReadyEvent } from './story-executor-bridge.js'
// Sprint tick loop — wired at boot
// [Engineer-Sr · Sonnet · run-sprint-loop]
import { SprintTickWorker, SprintTickLoop, buildTickDeps } from './sprint-tick-worker.js'

const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  base: {
    service: 'orchestrator-daemon',
    env: process.env['ORBITAL_ENV'] ?? 'unknown',
    instance: process.env['HOSTNAME'] ?? hostname(),
    boot_id: ulid(),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  redact: {
    paths: [
      'password',
      'secret',
      'token',
      'authorization',
      '*.password',
      '*.secret',
      '*.token',
      '*.authorization',
      'creds',
      'apiKey',
    ],
    censor: '[REDACTED]',
  },
})

let _shuttingDown = false
let _consumer: SqsConsumer | null = null
// Sprint tick loop — started in main(), stopped on SIGTERM
let _sprintTickLoop: SprintTickLoop | null = null

async function bootSecrets(): Promise<void> {
  logger.info({ tenant_id: 'system' }, 'daemon: resolving secrets from Secrets Manager')
  const t0 = Date.now()
  try {
    await getSecrets()
    logger.info({ tenant_id: 'system', elapsed_ms: Date.now() - t0 }, 'daemon: secrets resolved')
  } catch (err) {
    if (err instanceof Error && /hub master key is uninitialized/.test(err.message)) {
      logger.warn(
        { tenant_id: 'system', err: err.message },
        'daemon: hub master key uninitialized; running in degraded mode until KeyRotation Lambda runs',
      )
      return
    }
    throw err
  }
}

async function bootDb(): Promise<{ db: Awaited<ReturnType<typeof getDb>>['db'] }> {
  logger.info({ tenant_id: 'system' }, 'daemon: opening Aurora connection via RDS Proxy IAM auth')
  const t0 = Date.now()
  const { db } = await getDb()
  // Probe a trivial query to confirm the connection actually works before
  // we declare ready. If the proxy is misconfigured this fails fast.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const probe = await (db as any).execute('SELECT 1 AS ok')
  logger.info(
    { tenant_id: 'system', elapsed_ms: Date.now() - t0, probe: JSON.stringify(probe).slice(0, 80) },
    'daemon: Aurora connection ready',
  )
  return { db }
}

function startHealthEndpoint(): void {
  // Daemon does NOT serve HTTP traffic; the only listener is a Fargate
  // task health probe on TCP port 3000 returning 200. We use a plain
  // node:http server so we don't pull Fastify into the daemon.
  const port = Number(process.env['DAEMON_HEALTH_PORT'] ?? '3000')
  const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/health/') {
      res.writeHead(_shuttingDown ? 503 : 200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          status: _shuttingDown ? 'draining' : 'ok',
          service: 'orchestrator-daemon',
          uptime_seconds: process.uptime(),
          timestamp: new Date().toISOString(),
        }),
      )
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })
  server.listen(port, '0.0.0.0', () => {
    logger.info({ tenant_id: 'system', port }, 'daemon: health endpoint listening')
  })
}

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (_shuttingDown) return
  _shuttingDown = true
  logger.warn({ tenant_id: 'system', signal }, 'daemon: SIGTERM received, draining')
  // Stop the SQS consumer first so no new messages are picked up; the
  // consumer drains in-flight handlers before its start() resolves.
  if (_consumer) {
    _consumer.stop()
  }
  // Stop the sprint tick loop.
  if (_sprintTickLoop) {
    _sprintTickLoop.stop()
  }
  try {
    await closeDb()
  } catch (err) {
    logger.error({ tenant_id: 'system', err }, 'daemon: error closing db pool during shutdown')
  }
  logger.info({ tenant_id: 'system' }, 'daemon: shutdown complete')
  process.exit(exitCode)
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM', 0)
})
process.on('SIGINT', () => {
  void shutdown('SIGINT', 0)
})
process.on('uncaughtException', (err) => {
  logger.fatal({ tenant_id: 'system', err }, 'daemon: uncaught exception')
  void shutdown('uncaughtException', 1)
})
process.on('unhandledRejection', (reason) => {
  logger.fatal(
    { tenant_id: 'system', reason: reason instanceof Error ? reason.stack : String(reason) },
    'daemon: unhandled rejection',
  )
  void shutdown('unhandledRejection', 1)
})

async function main(): Promise<void> {
  startHealthEndpoint()
  await bootSecrets()
  const { db } = await bootDb()

  // Construct event store — used by the scheduler tick loop and any consumer
  // that needs to write/read audit events.
  const events = createEventStore(db, (await getDb()).sql)
  logger.info(
    { tenant_id: 'system', event_store_ready: events !== null },
    'daemon: event store wired',
  )

  // ----- Phase 2.6 — SQS consumer wired live -----
  const queueUrl = process.env['DAEMON_WORK_QUEUE_URL']
  if (!queueUrl) {
    logger.fatal(
      { tenant_id: 'system' },
      'daemon: DAEMON_WORK_QUEUE_URL is not set — cannot start consumer',
    )
    void shutdown('config-missing', 1)
    return
  }

  _consumer = new SqsConsumer({ queueUrl })

  // Event handler — Phase 2.6 deliberately keeps this thin. Each event is
  // logged with its `kind` (extracted from the parsed body if present) so
  // we can verify end-to-end fan-out via the SNS topic. Real dispatch to
  // the scheduler / worker spawn is Phase 2.x and lives in domain/.
  const handler: EventHandler = async (event, raw) => {
    const kind =
      typeof event === 'object' && event !== null && 'kind' in event
        ? String((event as { kind?: unknown }).kind ?? 'unknown')
        : 'unknown'
    const tenant_id =
      typeof event === 'object' && event !== null && 'tenant_id' in event
        ? String((event as { tenant_id?: unknown }).tenant_id ?? 'system')
        : 'system'
    counter('events.received', { kind, tenant_id }, 'Orbital/Daemon')
    logger.info(
      { tenant_id, kind, messageId: raw.MessageId },
      'daemon: received event',
    )

    // ---- system.smoke_test handler ----
    // Benign event used by the smoke-e2e script to verify the full
    // SNS → SQS → daemon chain end-to-end in production. Logs a
    // structured line containing `correlationId` so the script can
    // grep CloudWatch Logs for it within the 60-second window.
    // ---- story.ready handler ----
    // Drives the real Anthropic-SDK loop in @orbital/story-executor per the
    // run's persona. Cost / token usage is recorded into worker_runs as
    // each turn completes.
    if (kind === 'story.ready') {
      if (!isStoryReadyEvent(event)) {
        logger.warn(
          { tenant_id, kind, messageId: raw.MessageId },
          'daemon: story.ready missing required fields, skipping',
        )
        return
      }
      try {
        const out = await handleStoryReady(event, logger)
        counter('story.completed', { kind: out.storyStatus, tenant_id }, 'Orbital/Daemon')
        logger.info(
          { tenant_id, kind, messageId: raw.MessageId, runId: out.runId, storyStatus: out.storyStatus, pr_url: out.pr_url, event: 'story_ready_handled' },
          'daemon: story_ready_handled',
        )
      } catch (err) {
        counter('story.failed', { tenant_id }, 'Orbital/Daemon')
        logger.error(
          { tenant_id, kind, messageId: raw.MessageId, err: err instanceof Error ? err.message : String(err) },
          'daemon: story.ready handler threw',
        )
        throw err
      }
      return
    }

    if (kind === 'system.smoke_test') {
      const correlationId =
        typeof event === 'object' && event !== null && 'correlationId' in event
          ? String((event as { correlationId?: unknown }).correlationId ?? 'unknown')
          : 'unknown'
      logger.info(
        { tenant_id, kind, correlationId, messageId: raw.MessageId, event: 'smoke_test_handled' },
        'daemon: smoke_test_handled',
      )
      return
    }

    // ---- story.run_requested handler ----
    // Reviewer clicked "Run agent" on a story. The api-lambda inserted a
    // story_pr_runs row (status=queued) and published this event. The daemon
    // owns the long-running clone → agent → commit → PR flow because the
    // api-lambda has a 30s budget and the agent spawn is minutes.
    //
    // [Engineer-Principal · Opus · run-story-pr-pipeline]
    if (kind === 'story.run_requested') {
      const payload = (event as Record<string, unknown>) ?? {}
      const runId = typeof payload['run_id'] === 'string' ? (payload['run_id'] as string) : null
      const storyId = typeof payload['story_id'] === 'string' ? (payload['story_id'] as string) : null
      if (!runId || !storyId || tenant_id === 'system') {
        logger.error(
          { tenant_id, runId, storyId },
          'daemon: story.run_requested missing run_id/story_id/tenant_id',
        )
        return
      }
      logger.info({ tenant_id, runId, storyId }, 'daemon: story.run_requested dispatching')
      const { runStoryPr } = await import('../../orchestrator/dist/story-runs/run.js')
      const result = await runStoryPr({ tenantId: tenant_id, runId, storyId })
      logger.info(
        { tenant_id, runId, storyId, status: result.status, pr_url: result.prUrl },
        'daemon: story.run_requested completed',
      )
      return
    }

    // Receipt is captured in CloudWatch + EMF metric. Real domain dispatch
    // (write an audit row + run scheduler) lands when the daemon migrates
    // its scheduler tick into this loop — Phase 2.x in the plan. The
    // event-store reference is held for that wiring.
    void events
  }

  // ----- Sprint tick loop — starts before the SQS consumer -----
  // The tick loop runs every 30 seconds per-tenant, independent of SQS events.
  // DAEMON_TENANT_ID controls which tenant this instance serves (defaults to
  // the sentinel single-tenant value used by local installs).
  const daemonTenantId =
    process.env['DAEMON_TENANT_ID'] ?? '00000000-0000-0000-0000-000000000000'
  const instanceId = `${process.env['HOSTNAME'] ?? hostname()}-${ulid()}`

  const tickWorker = new SprintTickWorker(
    buildTickDeps({ instanceId, tenantId: daemonTenantId, db }),
  )
  _sprintTickLoop = new SprintTickLoop(
    tickWorker,
    Number(process.env['SPRINT_TICK_INTERVAL_MS'] ?? '30000'),
  )

  logger.info(
    { tenant_id: daemonTenantId, instance_id: instanceId, interval_ms: process.env['SPRINT_TICK_INTERVAL_MS'] ?? '30000' },
    'daemon: sprint tick loop starting',
  )
  // Start the loop in background — it runs until stop() is called on shutdown.
  void _sprintTickLoop.start().catch((err) => {
    logger.error({ tenant_id: 'system', err }, 'daemon: sprint tick loop terminated unexpectedly')
  })

  logger.info(
    { tenant_id: 'system', queueUrl },
    'daemon: starting SQS consumer',
  )
  // Run the consumer; this never resolves until stop() is called. Other
  // workers (scheduler tick, etc.) can be spawned in parallel here.
  await _consumer.start(handler)
}

main().catch((err) => {
  logger.fatal(
    { tenant_id: 'system', err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
    'daemon: boot failed',
  )
  process.exit(1)
})
