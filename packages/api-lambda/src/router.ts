/**
 * @orbital/api-lambda — narrow Lambda router.
 *
 * Built lazily inside `getLambdaAppRouter()` so module import is
 * side-effect-free — verified by the cold-import CI guard.
 *
 * INCLUDED: audit, audit-export, backlog, boards, channel, code-reviews,
 *           cost, github, memory, onboarding, orchestration (read), outbox,
 *           projects, providers, prs, replay, sprint, team, uat, vision.
 *
 * EXCLUDED (daemon-shaped):
 *   retro — agent-org git, analyst persona spawn (BLOCKER #5)
 *   admin (write paths) — destructive ops triggered by daemon work
 */

import { router } from '../../orchestrator/src/trpc/init.js'

// Static router exports (already constructed, cheap, no I/O)
import { githubRouter } from '../../orchestrator/src/trpc/routers/github.js'
import { auditRouter } from '../../orchestrator/src/trpc/routers/audit.js'
import { auditExportRouter } from '../../orchestrator/src/trpc/routers/audit-export.js'
import { channelsRouter } from '../../orchestrator/src/trpc/routers/channels.js'
import { codeReviewsRouter } from '../../orchestrator/src/trpc/routers/code-reviews.js'
import { costRouter } from '../../orchestrator/src/trpc/routers/cost.js'
import { orchestrationRouter } from '../../orchestrator/src/trpc/routers/orchestration.js'
import { outboxRouter } from '../../orchestrator/src/trpc/routers/outbox.js'
import { providersRouter } from '../../orchestrator/src/trpc/routers/providers.js'
import { prsRouter } from '../../orchestrator/src/trpc/routers/prs.js'
import { replayRouter } from '../../orchestrator/src/trpc/routers/replay.js'
import { teamRouter } from '../../orchestrator/src/trpc/routers/team.js'
import { visionRouter } from '../../orchestrator/src/trpc/routers/vision.js'
// Orbital Review UI — reviewer-facing story ops
// [Engineer-Principal · Opus · run-orbital-review-ui]
import { storiesRouter } from '../../orchestrator/src/trpc/routers/stories.js'

// Factory router imports — we control when they construct
import {
  createBacklogRouter,
  createSprintRouter,
} from '../../orchestrator/src/trpc/routers/backlog.js'
import { createUATRouter } from '../../orchestrator/src/trpc/routers/uat.js'
import { onboardingRouter as constructOnboardingRouter } from '../../orchestrator/src/trpc/routers/onboarding.js'
import { createProjectsRouter } from '../../orchestrator/src/trpc/routers/projects.js'
import { createBoardsRouter } from '../../orchestrator/src/trpc/routers/boards.js'
import { createMemoryRouter } from '../../orchestrator/src/trpc/routers/memory.js'
import { createRetrosRouter } from '../../orchestrator/src/trpc/routers/retros.js'
import { adminRouter as constructAdminRouter } from '../../orchestrator/src/trpc/routers/admin.js'

// Retro is a special case — read paths work in Lambda, write paths spawn
// `git` and require `~/.orbital/agent-org` which is daemon-shaped. We
// construct AgentOrgRepo with an explicit path that bypasses
// `getOrbitalHome()` so module init doesn't crash; write paths that hit
// git will surface descriptive errors at procedure-call time and Phase 2
// re-routes them through the daemon via outbox.
import { AgentOrgRepo } from '../../orchestrator/src/retros/agent-org.js'
import { createProposalService } from '../../orchestrator/src/retros/proposals.js'

// Service factories
import { createEventStore } from '../../orchestrator/src/events/store.js'
import { createBacklogService } from '../../orchestrator/src/backlog/service.js'
import { createUATService } from '../../orchestrator/src/uat/service.js'
import { createDefectService } from '../../orchestrator/src/uat/defects.js'
import { createPersonaOfRecord } from '../../orchestrator/src/uat/persona-of-record.js'
import { createMondayClient } from '../../orchestrator/src/backlog/monday-client.js'
import { createGithubClient } from '../../orchestrator/src/github/client.js'
import { createProjectsService } from '../../orchestrator/src/projects/service.js'
import { getScmClient } from '../../orchestrator/src/scm/factory.js'
import { createBoardDiscoveryService } from '../../orchestrator/src/backlog/board-discovery.js'
import { createBoardMappingService } from '../../orchestrator/src/backlog/board-mapping.js'
import { createBoardMappingResolver } from '../../orchestrator/src/backlog/board-mapping-resolver.js'
import { createMemoryService } from '../../orchestrator/src/memory/service.js'
// Cost service registry — must be wired at lambda boot, otherwise every
// cost.* tRPC procedure 500s with "CostService not registered".
// [Engineer-Principal · Opus · run-post-onboarding]
import { createCostService, registerCostService } from '../../orchestrator/src/cost/service.js'
import { loadOrCreateInstall } from '../../orchestrator/src/config/install.js'

// Lazy SprintService proxy — sprint procedures throw a clear error if the
// daemon hasn't registered a SprintService yet. The api-lambda is read-mostly
// so write-path sprint procedures are expected to fail without daemon backing.
import type { SprintService } from '../../orchestrator/src/backlog/sprint-service.js'
import { DefaultSprintService } from '@orbital/domain/backlog/sprint-service.js'
import type { Scheduler } from '../../orchestrator/src/orchestration/scheduler.js'
import type { PauseController } from '../../orchestrator/src/orchestration/pause.js'

import { getDb } from '@orbital/db'
import type { AnyRouter } from '@trpc/server'

let _router: AnyRouter | null = null
let _sprintService: SprintService | null = null

/**
 * Reset the cached router. Called from init.ts when the DB connection
 * needs to be refreshed (RDS Proxy IAM token > 12 min old). Without this,
 * the router holds service instances bound to a stale postgres client.
 */
export function _invalidateRouter(): void {
  _router = null
}

/**
 * Register a SprintService instance — called from a daemon-side bootstrap
 * if the api-lambda is run in-process during tests, otherwise unused.
 * In production Lambda, sprint write-paths fail with STARTUP_ERROR until
 * the daemon publishes via the outbox path.
 */
export function registerSprintService(service: SprintService): void {
  _sprintService = service
}

// In-Lambda read-only SprintService. Read paths (list/get) hit the DB
// directly. Write paths (start/pause/resume/complete) require Scheduler +
// PauseController which are daemon-shaped — those throw a descriptive error
// at call time. This unblocks the dashboard's `sprint.list` query that
// previously 500'd on every render. [run-post-onboarding]
function buildLambdaSprintService(db: typeof import('@orbital/db').db, events: ReturnType<typeof createEventStore>): SprintService {
  const noopScheduler = new Proxy({} as Scheduler, {
    get(_t, prop: string) {
      return () => {
        throw new Error(
          `STARTUP_ERROR: Scheduler.${prop} unavailable in api-lambda; sprint write paths must go through the outbox + daemon`,
        )
      }
    },
  })
  const noopPause = new Proxy({} as PauseController, {
    get(_t, prop: string) {
      return () => {
        throw new Error(
          `STARTUP_ERROR: PauseController.${prop} unavailable in api-lambda; sprint write paths must go through the outbox + daemon`,
        )
      }
    },
  })
  return new DefaultSprintService(db, events, noopScheduler, noopPause)
}

const lazySprintService = new Proxy({} as SprintService, {
  get(_t, prop: string) {
    return (...args: unknown[]) => {
      if (_sprintService === null) {
        throw new Error(
          'STARTUP_ERROR: SprintService not available in api-lambda. ' +
            'Sprint write-paths must go through the outbox + daemon.',
        )
      }
      const fn = (_sprintService as unknown as Record<string, unknown>)[prop]
      if (typeof fn !== 'function') {
        throw new Error(`STARTUP_ERROR: SprintService has no method '${prop}'`)
      }
      return (fn as (...a: unknown[]) => unknown).call(_sprintService, ...args)
    }
  },
})

/**
 * Construct the narrow Lambda app router. Side-effect-only on first call;
 * subsequent calls return the cached instance.
 *
 * IMPORTANT: callers must `await getDb()` before invoking — the singleton
 * routers reach into the db Proxy synchronously, which throws in AWS mode
 * if the proxy hasn't been hydrated yet.
 */
export async function getLambdaAppRouter(): Promise<AnyRouter> {
  if (_router) return _router

  // Hydrate the synchronous db Proxy so downstream construction doesn't throw.
  const { db, sql } = await getDb()
  const events = createEventStore(db, sql)

  // Register the cost service singleton so cost.* procedures resolve.
  // Without this, every cost.summary/cost.scope call 500s in Lambda.
  // [Engineer-Principal · Opus · run-post-onboarding]
  try {
    const install = await loadOrCreateInstall()
    registerCostService(createCostService(db, events, install.install_id))
  } catch (err) {
    // Non-fatal: cost.* will continue to 500 with a clear message until the
    // install bootstrap recovers, but everything else stays up.
    console.error('[api-lambda] cost service registration failed:', err)
  }

  // Project services
  const monday = createMondayClient()
  const github = createGithubClient()
  // Default to CodeCommit at the construction-root. When the project row
  // specifies github, the service-layer will reach for a different client.
  const scmClient = getScmClient(
    { scmProvider: 'internal' },
    { region: process.env['AWS_REGION'] ?? 'us-east-1', githubClient: github },
  )
  const projectsService = createProjectsService(db, events, {
    mondayClient: monday,
    githubClient: github,
    scmClient,
  })
  const projectsR = createProjectsRouter({
    projectsService,
    mondayClient: monday,
    githubClient: github,
  })

  // Boards
  const discovery = createBoardDiscoveryService(monday)
  const mapping = createBoardMappingService(db, events)
  const resolver = createBoardMappingResolver(mapping)
  const boardsR = createBoardsRouter({
    db,
    eventStore: events,
    discoveryService: discovery,
    mappingService: mapping,
    resolver,
  })

  // Memory
  const memoryService = createMemoryService(db, events)
  const memoryR = createMemoryRouter({ memoryService, db })

  // Onboarding (constructs internal singletons lazily on first procedure call)
  const onboardingR = constructOnboardingRouter()

  // Admin (read-only ops are safe in Lambda; write ops like backup/export
  // are daemon-shaped and will fail at runtime — those are Phase 2 outbox).
  const adminR = constructAdminRouter()

  // Retros — explicit AgentOrgRepo path avoids the getOrbitalHome BLOCKER.
  // Reads work; git-touching writes will throw at procedure time.
  const agentOrg = new AgentOrgRepo({ path: '/tmp/orbital-agent-org' })
  const proposalService = createProposalService(db, events, agentOrg, 'lambda-install')
  const retrosR = createRetrosRouter({ db, proposalService })

  // Backlog + sprint
  const backlogService = createBacklogService(db, events)
  const backlogR = createBacklogRouter({
    backlogService,
    loadVisionContext: async () => null, // Lambda path: vision context is read via vision router separately
  })
  // Wire a real read-capable SprintService in-process so sprint.list / sprint.get
  // succeed (write paths throw via the noop scheduler/pause). [run-post-onboarding]
  if (_sprintService === null) {
    _sprintService = buildLambdaSprintService(db, events)
  }
  const sprintR = createSprintRouter({ sprintService: lazySprintService })

  // UAT
  const personaOfRecord = createPersonaOfRecord(db, events)
  const defectService = createDefectService(db, events, backlogService)
  const uatService = createUATService(db, events, defectService, personaOfRecord)
  const uatR = createUATRouter({ uatService, defectService, db })

  _router = router({
    admin: adminR,
    audit: auditRouter,
    auditExport: auditExportRouter,
    backlog: backlogR,
    boards: boardsR,
    channel: channelsRouter,
    code_reviews: codeReviewsRouter,
    cost: costRouter,
    // GitHub App install flow — installation management + repo listing
    // [Engineer-Sr · Sonnet · run-github-app-install]
    github: githubRouter,
    memory: memoryR,
    onboarding: onboardingR,
    orchestration: orchestrationRouter,
    outbox: outboxRouter,
    projects: projectsR,
    providers: providersRouter,
    prs: prsRouter,
    replay: replayRouter,
    retro: retrosR,
    sprint: sprintR,
    // Orbital Review UI — reviewer queue + per-story actions
    // [Engineer-Principal · Opus · run-orbital-review-ui]
    stories: storiesRouter,
    team: teamRouter,
    uat: uatR,
    vision: visionRouter,
  }) as AnyRouter

  return _router
}

export type LambdaAppRouter = Awaited<ReturnType<typeof getLambdaAppRouter>>
