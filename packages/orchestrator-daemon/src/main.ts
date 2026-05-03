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

// Use deep relative paths so tsc resolves directly to source rather than
// requiring orchestrator package subpath exports. esbuild/tsc bundle this.
import { getDb, closeDb } from '../../orchestrator/dist/db/client.js'
import { getSecrets } from '../../orchestrator/dist/lambda/secrets-cache.js'
import { createEventStore } from '../../orchestrator/dist/events/store.js'

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

async function bootSecrets(): Promise<void> {
  logger.info({ tenant_id: 'system' }, 'daemon: resolving secrets from Secrets Manager')
  const t0 = Date.now()
  await getSecrets()
  logger.info({ tenant_id: 'system', elapsed_ms: Date.now() - t0 }, 'daemon: secrets resolved')
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
  // TODO Phase 2.6: stop SQS consumer and finish in-flight messages.
  // TODO Phase 2.x: stop scheduler tick loop and let current tick finish.
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

  // ----- Phase 2.6 — SQS consumer (placeholder until queue exists) -----
  // The actual consumer is wired in a follow-up commit once the SQS
  // daemon-work queue is created in CDK (Phase 2.6 item).
  logger.info(
    { tenant_id: 'system' },
    'daemon: ready (scheduler tick loop + SQS consumer wired in Phase 2.6)',
  )

  // Keep process alive — health server holds the event loop. When SIGTERM
  // fires the shutdown handler exits cleanly.
}

main().catch((err) => {
  logger.fatal(
    { tenant_id: 'system', err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
    'daemon: boot failed',
  )
  process.exit(1)
})
