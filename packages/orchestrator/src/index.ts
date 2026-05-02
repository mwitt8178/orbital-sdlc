/**
 * index.ts — Orbital orchestrator daemon entry point.
 *
 * This file stays intentionally thin: every long-lived service is constructed
 * by `orchestration/boot.ts::assembleOrchestration`. We only handle the
 * top-level lifecycle (telemetry, install, metrics, Fastify, WS, shutdown).
 *
 * Closes the four boot DI gaps:
 *   C1 sprint mutations  — boot constructs the real DefaultSprintService
 *   C2 PM persona spawn  — boot wires Scheduler into VisionService DI
 *   C3 retro spawn       — boot wires Scheduler into RetroService DI
 *   C4 verifier spawn    — boot subscribes TaskCompleted → post-task hook
 */

import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify'
import { trace } from '@opentelemetry/api'
import { loadEnv } from './config/env.js'
import { logger } from './config/logger.js'
import { loadOrCreateInstall } from './config/install.js'
import { initTelemetry } from './config/telemetry.js'
import { closeDb, db, sql } from './db/client.js'
import { errorHandler } from './middleware/error-handler.js'
import { registerRequestLogger } from './middleware/request-logger.js'
import { registerTracing } from './middleware/tracing.js'
import { createEventStore, type EventStore } from './events/store.js'
import { registerMetrics } from './metrics/prometheus.js'
import { registerMetricsRoute } from './metrics/route.js'
import { startMetricsInstrumentation, wrapAppend } from './metrics/instrumentation.js'
import { assembleOrchestration } from './orchestration/boot.js'
import { registerBacklogWebhook } from './backlog/webhook.js'
import { registerGithubWebhook } from './github/webhook.js'
import { GitHubPROrchestrator } from './github/pr-orchestrator.js'
import { createGithubClient } from './github/client.js'
import { registerAuditExportRoutes } from './audit-export/rest.js'
import { registerHubAdminRoutes } from './admin/hub-admin.js'
import {
  registerHubRegisterRoute,
  registerProxyJoinRoute,
} from './hub/auth/routes.js'
import { appRouter } from './trpc/routers/index.js'
import { WebSocketHub } from './ws/hub.js'
import { registerWsRoutes } from './ws/server.js'
import { createDrainController } from './middleware/graceful-drain.js'
import type { MondaySyncService } from './backlog/monday-sync.js'

const env = loadEnv()

/**
 * Round 3 S1 — compute the CORS origin allowlist from env.
 *
 * Returns:
 *   - `true` (allow all) in `development` for local dev convenience.
 *   - `['*']` if CORS_ALLOWED_ORIGINS=`*` (test/dev only — guarded below).
 *   - An array of trimmed origin strings parsed from the comma-separated env.
 *     Empty array means "reject all"; the caller should warn at boot.
 */
function computeCorsOrigin(): boolean | string[] {
  if (env.NODE_ENV === 'development') return true

  const raw = (env.CORS_ALLOWED_ORIGINS ?? '').trim()
  if (raw.length === 0) return []

  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  if (parts.includes('*')) {
    if (env.NODE_ENV === 'production') {
      // Reject `*` in production — loudly. Fall back to empty allowlist so
      // every browser request fails the origin check (caller will warn).
      logger.warn(
        'CORS_ALLOWED_ORIGINS=`*` is rejected in production. Use an explicit allowlist.',
      )
      return []
    }
    return ['*']
  }

  return parts
}

async function buildApp(
  metricsRegistry: ReturnType<typeof registerMetrics>,
  _eventStore: EventStore,
  wsHub: WebSocketHub | undefined,
  mondaySyncService: MondaySyncService | null,
  githubOpts?: { webhookSecret: string; eventStore: EventStore; db: import('./db/client.js').DB },
) {
  const app = Fastify({
    logger: false,
    trustProxy: true,
    bodyLimit: 10 * 1024 * 1024,
  })

  app.setErrorHandler(errorHandler)

  // Round 3 S3 — Set a 404 handler that emits the canonical Primitives §10
  // error envelope so unknown routes never leak Fastify's default body.
  app.setNotFoundHandler((req, reply) => {
    void reply.status(404).send({
      error: {
        code: 'NOT_FOUND_ROUTE',
        message: `Route ${req.method}:${req.url} not found`,
        trace_id: trace.getActiveSpan()?.spanContext().traceId ?? 'no-trace',
      },
    })
  })

  registerRequestLogger(app)
  await registerTracing(app)
  registerMetricsRoute(app, metricsRegistry)

  // Round 3 S2 — Helmet security headers.
  // Sets X-Frame-Options=DENY, X-Content-Type-Options=nosniff,
  // Referrer-Policy=no-referrer, Strict-Transport-Security (HSTS), and a CSP.
  // CSP is disabled in development so Vite's HMR (inline scripts/sockets) works.
  // Production CSP allows: self for everything, plus self-WS for live event
  // streams; Google Fonts CSS+font for the default UI font stack.
  await app.register(helmet, {
    contentSecurityPolicy:
      env.NODE_ENV === 'development'
        ? false
        : {
            directives: {
              defaultSrc: ["'self'"],
              styleSrc: ["'self'", "'unsafe-inline'", 'fonts.googleapis.com'],
              fontSrc: ["'self'", 'fonts.gstatic.com'],
              connectSrc: ["'self'", 'ws:', 'wss:'],
            },
          },
  })

  // Round 3 S1 — CORS allowlist.
  // Production / test: parse CORS_ALLOWED_ORIGINS into an array.
  // Development: allow any origin so any local dev server can hit the API.
  // If production has an empty allowlist, log a loud warning at boot time
  // (still register cors so existing handlers don't break — every browser
  // request will simply fail the origin check).
  const corsOrigin = computeCorsOrigin()
  if (env.NODE_ENV === 'production' && Array.isArray(corsOrigin) && corsOrigin.length === 0) {
    logger.warn(
      'CORS_ALLOWED_ORIGINS is empty in production; CORS will reject all browser traffic. ' +
        'Set CORS_ALLOWED_ORIGINS=https://your.domain in env to allow specific origins.',
    )
  }

  await app.register(cors, {
    origin: corsOrigin,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      'x-orbital-admin-token',
    ],
  })

  // Phase 7: tRPC HTTP plugin (UI consumes this).
  // Round 3 S5 — pass `req` into tRPC context so the idempotency middleware
  // can read the Idempotency-Key header from `ctx.req.headers`.
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: appRouter,
      createContext: ({ req }: { req: { headers: Record<string, unknown> } }) => ({
        req: { headers: req.headers },
      }),
      onError: ({ error, path }: { error: unknown; path: string | undefined }) => {
        logger.error({ err: error, path }, 'tRPC error')
      },
    },
  })

  // Phase 7 + Round 3 S4: WebSocket route for live event stream.
  // Auth gate (S4): if WS_SESSION_TOKEN is configured the upgrade requires it.
  // Dev (NODE_ENV=development) without a configured token is permitted but
  // the boot caller logs a warning so it is hard to ship to prod by accident.
  if (wsHub) {
    const wsToken = env.WS_SESSION_TOKEN
    const opts = wsToken
      ? { hub: wsHub, token: wsToken }
      : { hub: wsHub }
    await registerWsRoutes(app, opts)
  }

  app.get('/health', async () => {
    // Round 7-01 — report ORBITAL_MODE and tenant metadata in hub mode.
    // [Engineer-Sr · Sonnet · run-round7-01-extract-hub]
    const healthEnv = loadEnv()
    const mode = healthEnv.ORBITAL_MODE ?? 'local'
    const base = {
      status: 'ok' as const,
      mode,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    }

    if (mode === 'hub') {
      // Count distinct tenants that have data in the tasks table.
      // Best-effort — falls back to 0 on error so health never blocks.
      let tenantCount = 0
      try {
        const { tasks } = await import('./db/schema/orchestration.js')
        const { countDistinct } = await import('drizzle-orm')
        const rows = await db
          .select({ cnt: countDistinct(tasks.tenantId) })
          .from(tasks)
        tenantCount = rows[0]?.cnt ?? 0
      } catch {
        tenantCount = 0
      }
      return { ...base, tenant_count: tenantCount, version: process.env['npm_package_version'] ?? 'unknown' }
    }

    return base
  })

  app.get('/health/ready', async (_req, reply) => {
    try {
      await sql`SELECT 1`
      return { status: 'ready', timestamp: new Date().toISOString() }
    } catch (err) {
      logger.error({ err }, 'Readiness check failed')
      return reply.status(503).send({
        error: {
          code: 'INTERNAL_DB_ERROR',
          message: 'Database not reachable',
          trace_id: 'health-check',
        },
      })
    }
  })

  // Phase 6A: register audit export REST routes (single additive line).
  registerAuditExportRoutes(app)

  // Round 7-03 — federation auth routes.
  // /hub/register is hub-mode only; /api/hub/proxy-join is local-mode only.
  registerHubRegisterRoute(app)
  registerProxyJoinRoute(app)

  // Round 7-07 — hub admin endpoints (no-op in local mode).
  registerHubAdminRoutes(app)

  // Phase 4B: register Monday → Orbital webhook receiver. Requires
  // MONDAY_WEBHOOK_SECRET; if absent at boot we skip registration with a
  // warning rather than abort startup.
  const webhookSecret = env.MONDAY_WEBHOOK_SECRET
  if (webhookSecret && webhookSecret.length > 0 && mondaySyncService) {
    registerBacklogWebhook(app, { secret: webhookSecret, syncService: mondaySyncService })
    logger.info('Monday webhook route registered at POST /api/v1/webhooks/monday')
  } else if (!webhookSecret || webhookSecret.length === 0) {
    logger.warn(
      'MONDAY_WEBHOOK_SECRET not set; skipping Monday webhook registration. Set it in env or keychain to enable.',
    )
  } else {
    logger.warn(
      'MondaySyncService not constructed (likely missing MONDAY_API_TOKEN); skipping webhook registration.',
    )
  }

  // Round 5D: register GitHub → Orbital webhook receiver.
  // Only registered when GITHUB_WEBHOOK_SECRET is set — same pattern as Monday.
  if (githubOpts?.webhookSecret && githubOpts.webhookSecret.length > 0) {
    registerGithubWebhook(app, {
      secret: githubOpts.webhookSecret,
      eventStore: githubOpts.eventStore,
      db: githubOpts.db,
    })
    logger.info('GitHub webhook route registered at POST /api/v1/webhooks/github')
  }

  return app
}

async function start(): Promise<void> {
  // Phase 6B: initialize OTel SDK before any spans are emitted.
  const telemetry = await initTelemetry()

  const install = await loadOrCreateInstall()
  logger.info({ install_id: install.install_id }, 'Orbital orchestrator starting')

  // Phase 6B: initialize Prometheus metrics registry.
  const metricsRegistry = registerMetrics()

  // Wire orchestration-aware MCP tool registry once at boot.
  const baseEventStore = createEventStore(db, sql)
  // Phase 6B: wrap append to inject active OTel trace_id automatically.
  const eventStore = wrapAppend(baseEventStore)

  // Phase 6B: start metrics instrumentation (EventStore subscription + periodic DB syncs).
  const stopInstrumentation = startMetricsInstrumentation({ eventStore, db })

  // Closes C1-C4: assemble the full orchestration DI graph.
  const orchestration = await assembleOrchestration({
    db,
    sql,
    eventStore,
    installId: install.install_id,
  })

  // Round 4 Projects Feature: ensure a "Default Project" row exists for this
  // install and backfill any aggregate rows that have project_id IS NULL.
  // Idempotent — safe to call on every boot.
  try {
    const { createProjectsService } = await import('./projects/service.js')
    const projectsService = createProjectsService(db, eventStore)
    await projectsService.ensureDefaultProject()
    logger.info('Default project ensured (Round 4 Projects Feature)')
  } catch (err) {
    // Do not crash boot if backfill fails; log loudly so ops sees it.
    logger.error({ err }, 'ensureDefaultProject failed; multi-project state may be inconsistent')
  }

  // Phase 7: start the WebSocket hub before app.listen so subscribers
  // see events from the moment the HTTP listener is up.
  const wsHub = new WebSocketHub(eventStore)
  await wsHub.start()

  // Round 3 S4 — loud warning if WS auth is disabled.
  if (!env.WS_SESSION_TOKEN) {
    if (env.NODE_ENV === 'development') {
      logger.warn(
        'WS_SESSION_TOKEN not set — WebSocket upgrades accept all connections. ' +
          'Set WS_SESSION_TOKEN before running in production.',
      )
    } else {
      logger.error(
        'WS_SESSION_TOKEN not set in non-development environment. ' +
          'WebSocket upgrades will accept ALL connections, including untrusted origins. ' +
          'Set WS_SESSION_TOKEN immediately or downgrade to NODE_ENV=development.',
      )
    }
  }

  // Round 6 #1 — GitHubPROrchestrator is now started inside assembleOrchestration
  // under the ORBITAL_PR_LOOP feature flag. Keep the local reference for shutdown
  // compatibility — use the one returned from orchestration.
  // [Engineer-Sr · Sonnet · run-round6-01-pr-loop]
  const prOrchestrator: GitHubPROrchestrator | null = orchestration.prOrchestrator

  const githubWebhookSecret = env.GITHUB_WEBHOOK_SECRET
  const app = await buildApp(
    metricsRegistry,
    eventStore,
    wsHub,
    orchestration.mondaySyncService,
    githubWebhookSecret && githubWebhookSecret.length > 0
      ? { webhookSecret: githubWebhookSecret, eventStore, db }
      : undefined,
  )

  // Round 3 O4 — graceful HTTP drain on shutdown. The controller wraps
  // onRequest/onResponse hooks to track in-flight requests; drain() waits up
  // to drainTimeoutMs for them to complete before app.close() kills them.
  const drainController = createDrainController(app, { drainTimeoutMs: 30_000 })

  await app.listen({ port: env.PORT, host: env.HOST })
  logger.info(
    {
      port: env.PORT,
      host: env.HOST,
      mcp_socket: orchestration.mcpGateway.socketPath,
    },
    'Orbital orchestrator listening',
  )

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down')
    try {
      // Round 5D: stop PR orchestrator first (LIFO — started after assembleOrchestration)
      if (prOrchestrator) prOrchestrator.stop()
      stopInstrumentation()
      await wsHub.stop()
      await orchestration.shutdown()
      await drainController.drain()
      await app.close()
      await closeDb()
      await telemetry.shutdown()
      logger.info('Shutdown complete')
      process.exit(0)
    } catch (err) {
      logger.error({ err }, 'Shutdown failed')
      process.exit(1)
    }
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

start().catch((err) => {
  logger.error({ err }, 'Fatal startup error')
  process.exit(1)
})

export { buildApp }
