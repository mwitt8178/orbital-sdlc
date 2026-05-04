/**
 * trpc/routers/index.ts — Root tRPC application router.
 *
 * Per Implementation Plan §6 Task 2C exposes appRouter root.
 *
 * Subsequent phases append more sub-routers. Phase 4B adds backlog + sprint.
 *
 * Wiring strategy:
 *   - Routers with no heavy DI (channels, orchestration, audit, vision)
 *     self-construct via singletons.
 *   - Routers requiring heavy DI (sprint — needs Scheduler + PauseController)
 *     are wired via a registry that the index.ts startup populates.
 *     If the registry has not been populated, the relevant procedures throw
 *     a clear startup error rather than silently no-op.
 */

import { router } from '../init.js'
import { orchestrationRouter } from './orchestration.js'
import { channelsRouter } from './channels.js'
import { auditRouter } from './audit.js'
import { auditExportRouter } from './audit-export.js'
import { visionRouter } from './vision.js'
import { db, sql } from '../../db/client.js'
import { createEventStore } from '../../events/store.js'
import { createBacklogService } from '../../backlog/service.js'
import {
  createBacklogRouter,
  createSprintRouter,
  type BacklogRouter,
  type SprintRouter,
} from './backlog.js'
import type { SprintService } from '../../backlog/sprint-service.js'
import { createUATRouter, type UATRouter } from './uat.js'
import { createUATService } from '../../uat/service.js'
import { createDefectService } from '../../uat/defects.js'
import { createPersonaOfRecord } from '../../uat/persona-of-record.js'
import { createRetrosRouter, type RetrosRouter } from './retros.js'
import { createAgentOrgRepo } from '../../retros/agent-org.js'
import { createProposalService, type ProposalService } from '../../retros/proposals.js'
import { onboardingRouter as makeOnboardingRouter } from './onboarding.js'
import { adminRouter as makeAdminRouter } from './admin.js'
import { createProjectsRouter, type ProjectsRouter } from './projects.js'
import { createProjectsService } from '../../projects/service.js'
import { createMondayClient } from '../../backlog/monday-client.js'
import { createGithubClient } from '../../github/client.js'
import { createBoardsRouter, type BoardsRouter } from './boards.js'
import { createBoardDiscoveryService } from '../../backlog/board-discovery.js'
import { createBoardMappingService } from '../../backlog/board-mapping.js'
import { createBoardMappingResolver } from '../../backlog/board-mapping-resolver.js'
import { createMemoryRouter, type MemoryRouter } from './memory.js'
import { createMemoryService } from '../../memory/service.js'
import { providersRouter } from './providers.js'
// Round 6 #1 — GitHub PR loop
// [Engineer-Sr · Sonnet · run-round6-01-pr-loop]
import { prsRouter } from './prs.js'
// Round 6 #7 — Determinism / Replay
// [Engineer-Principal · Opus · run-round6-07-replay]
import { replayRouter } from './replay.js'
// Round 6 #5 — Cost Governance + Hard Kill Switches
// [Engineer-Sr · Sonnet · run-round6-05-cost-governance]
import { costRouter, billingRouter } from './cost.js'
// Round 6 #2 — Code-Review Persona + Agent-to-Agent Review Loop
// [Engineer-Sr · Sonnet · run-round6-02-reviewer-persona]
import { codeReviewsRouter } from './code-reviews.js'
// Round 7-08 — Operator-Attributed UI
// [Engineer-Sr · Sonnet · run-round7-08-operator-attribution]
import { teamRouter } from './team.js'
// Round 7-06 — Offline Cache + Reconciliation: local outbox management
// [Engineer-Sr · Sonnet · run-round7-06-offline-reconcile]
import { outboxRouter } from './outbox.js'
// Orbital Review UI — reviewer-facing story operations
// [Engineer-Principal · Opus · run-orbital-review-ui]
import { storiesRouter } from './stories.js'
// Settings → Integrations: per-project webhook delivery surface
// [Engineer-Principal · Opus · run-settings-integrations]
import { webhooksRouter } from './webhooks.js'
// Settings → Agents — per-project persona configuration
// [Engineer-Principal · Opus · run-settings-agents]
import { projectPersonasRouter } from './project-personas.js'
// Settings → Sprints — per-project sprint policy (cadence, capacity, budget, ceremony rules)
// [Engineer-Principal · Opus · run-settings-sprints]
import { sprintPolicyRouter } from './sprint-policy.js'
// GitHub App install flow — installation management + repo listing
// [Engineer-Sr · Sonnet · run-github-app-install]
import { githubRouter } from './github.js'
// QA test artifact generation + approval
// [Engineer-Sr · Sonnet · run-ac-test-generation]
import { testArtifactsRouter } from './test-artifacts.js'

// ---------------------------------------------------------------------------
// Lazy singletons / DI registry
// ---------------------------------------------------------------------------

let _eventStore: ReturnType<typeof createEventStore> | null = null
function eventStore(): ReturnType<typeof createEventStore> {
  if (_eventStore === null) _eventStore = createEventStore(db, sql)
  return _eventStore
}

let _backlogRouter: BacklogRouter | null = null
function backlogRouter(): BacklogRouter {
  if (_backlogRouter === null) {
    const backlogService = createBacklogService(db, eventStore())
    _backlogRouter = createBacklogRouter({
      backlogService,
      // Vision context loader — used by parseAndCreate to ground proposals.
      // Reads only the two columns we need (title, version content) directly
      // via Drizzle to avoid spinning up the full VisionService DI graph on
      // every parse call. Failures degrade gracefully — the parser still
      // produces a proposal from the prompt alone.
      loadVisionContext: async (documentId: string) => {
        try {
          const { eq } = await import('drizzle-orm')
          const { visionDocuments, visionVersions } = await import(
            '../../db/schema/vision.js'
          )
          const docRows = await db
            .select({
              title: visionDocuments.title,
              currentVersionId: visionDocuments.currentVersionId,
            })
            .from(visionDocuments)
            .where(eq(visionDocuments.visionDocumentId, documentId))
            .limit(1)
          const doc = docRows[0]
          if (!doc || !doc.currentVersionId) return null
          const verRows = await db
            .select({ content: visionVersions.content })
            .from(visionVersions)
            .where(eq(visionVersions.visionVersionId, doc.currentVersionId))
            .limit(1)
          const ver = verRows[0]
          if (!ver || !ver.content) return null
          const content = ver.content as Record<string, unknown>
          const title = String(content['title'] ?? doc.title ?? '')
          const summary = String(content['summary'] ?? '').slice(0, 500)
          const rawGoals = content['goals']
          const topGoals = Array.isArray(rawGoals)
            ? rawGoals
                .slice(0, 5)
                .map((g) =>
                  typeof g === 'object' && g !== null && 'text' in g
                    ? String((g as { text?: unknown }).text ?? '')
                    : String(g ?? ''),
                )
                .filter((s) => s.length > 0)
            : []
          // existingEpicTitles is populated by the procedure itself from
          // backlogService.listEpics so we don't double-query the epic list.
          return { title, summary, topGoals, existingEpicTitles: [] }
        } catch {
          return null
        }
      },
    })
  }
  return _backlogRouter
}

let _sprintService: SprintService | null = null
let _sprintRouter: SprintRouter | null = null

/**
 * Register a SprintService for the appRouter to use. Index.ts calls this once
 * at startup with a fully-constructed SprintService (Scheduler, PauseController,
 * etc., wired up). Tests may also register a service.
 */
export function registerSprintService(service: SprintService): void {
  // Set the live ref. The lazySprintService proxy used inside the appRouter
  // forwards each method call to whatever is currently in _sprintService,
  // so we deliberately do NOT rebuild _sprintRouter here.
  _sprintService = service
}

// Lazy proxy: every method call resolves _sprintService at *invocation* time,
// so registerSprintService() populating the ref AFTER appRouter module load
// still wires correctly. createSprintRouter is called once with this proxy;
// the proxy forwards to whichever SprintService is registered at call time.
const lazySprintService = new Proxy({} as SprintService, {
  get(_t, prop: string) {
    return (...args: unknown[]) => {
      if (_sprintService === null) {
        throw new Error(
          'STARTUP_ERROR: SprintService not registered. Call registerSprintService() at boot.',
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

function sprintRouter(): SprintRouter {
  if (_sprintRouter !== null) return _sprintRouter
  _sprintRouter = createSprintRouter({ sprintService: lazySprintService })
  return _sprintRouter
}

// ---------------------------------------------------------------------------
// UAT router — singleton
// ---------------------------------------------------------------------------

let _uatRouter: UATRouter | null = null
function uatRouter(): UATRouter {
  if (_uatRouter !== null) return _uatRouter
  const es = eventStore()
  const backlogService = createBacklogService(db, es)
  const personaOfRecord = createPersonaOfRecord(db, es)
  const defectService = createDefectService(db, es, backlogService)
  const uatService = createUATService(db, es, defectService, personaOfRecord)
  _uatRouter = createUATRouter({ uatService, defectService, db })
  return _uatRouter
}

// ---------------------------------------------------------------------------
// Scheduler ref (for VisionService DI). Re-exported from scheduler-ref.ts to
// avoid a circular import between this module and vision.ts.
// ---------------------------------------------------------------------------

export { registerScheduler, getRegisteredScheduler } from './scheduler-ref.js'

// ---------------------------------------------------------------------------
// Retros router — singleton (with optional override registration for tests)
// ---------------------------------------------------------------------------

let _retroProposalService: ProposalService | null = null
let _retrosRouter: RetrosRouter | null = null

/**
 * Register a ProposalService override (used by integration tests to inject a
 * service constructed against a tmp agent-org repo). If not registered, the
 * router constructs a default ProposalService against the ~/.orbital/agent-org
 * repo using a default install_id placeholder; the integration test path
 * SHOULD always register before calling appRouter procedures.
 */
export function registerProposalService(service: ProposalService): void {
  _retroProposalService = service
  _retrosRouter = createRetrosRouter({ db, proposalService: service })
}

function retrosRouter(): RetrosRouter {
  if (_retrosRouter !== null) return _retrosRouter
  if (_retroProposalService !== null) {
    _retrosRouter = createRetrosRouter({ db, proposalService: _retroProposalService })
    return _retrosRouter
  }
  // Default: construct a service against the user's ~/.orbital/agent-org.
  // The install_id is a placeholder until index.ts registers a real service.
  const agentOrg = createAgentOrgRepo()
  const defaultProposalService = createProposalService(
    db,
    eventStore(),
    agentOrg,
    'default-install-id',
  )
  _retrosRouter = createRetrosRouter({ db, proposalService: defaultProposalService })
  return _retrosRouter
}

// ---------------------------------------------------------------------------
// Projects router — singleton (Monday + Github clients lazily resolved)
// ---------------------------------------------------------------------------

let _projectsRouter: ProjectsRouter | null = null
function projectsRouter(): ProjectsRouter {
  if (_projectsRouter !== null) return _projectsRouter
  // Both Monday and Github clients are optional: if no token, the inner
  // resolveToken() throws STARTUP_ERROR on first use, so the router still
  // mounts. ProjectsService is forgiving — if the client is null, it skips
  // validation and logs a warn.
  const monday = createMondayClient()
  const github = createGithubClient()
  const service = createProjectsService(db, eventStore(), {
    mondayClient: monday,
    githubClient: github,
  })
  _projectsRouter = createProjectsRouter({
    projectsService: service,
    mondayClient: monday,
    githubClient: github,
  })
  return _projectsRouter
}

// ---------------------------------------------------------------------------
// Memory router — singleton
// [Engineer-Sr · Sonnet · run-round6-04-project-memory]
// ---------------------------------------------------------------------------

let _memoryRouter: MemoryRouter | null = null
function memoryRouter(): MemoryRouter {
  if (_memoryRouter !== null) return _memoryRouter
  const memoryService = createMemoryService(db, eventStore())
  _memoryRouter = createMemoryRouter({ memoryService, db })
  return _memoryRouter
}

// ---------------------------------------------------------------------------
// Boards router — singleton (Monday-aware board discovery + mapping)
// ---------------------------------------------------------------------------

let _boardsRouter: BoardsRouter | null = null
function boardsRouter(): BoardsRouter {
  if (_boardsRouter !== null) return _boardsRouter
  const monday = createMondayClient()
  const discovery = createBoardDiscoveryService(monday)
  // BoardMappingService accepts an optional AnthropicDriver. We don't wire
  // one here; Round5A's anthropic-driver is wired at boot in index.ts. For
  // now we use the heuristic baseline; LLM refinement is opt-in via a
  // re-registration after boot completes.
  const mapping = createBoardMappingService(db, eventStore())
  const resolver = createBoardMappingResolver(mapping)
  _boardsRouter = createBoardsRouter({
    db,
    eventStore: eventStore(),
    discoveryService: discovery,
    mappingService: mapping,
    resolver,
  })
  return _boardsRouter
}

/**
 * Expose the resolver to other modules that need to read the active mapping
 * (e.g. MondaySyncService when wiring scheduled writes). Lazily creates the
 * boards subsystem on first call.
 */
let _resolverSingleton: ReturnType<typeof createBoardMappingResolver> | null = null
export function getBoardMappingResolver(): ReturnType<typeof createBoardMappingResolver> {
  if (_resolverSingleton !== null) return _resolverSingleton
  // Trigger the boards router init (which creates the resolver as a side
  // effect, kept inside the closure). To avoid duplicating the wiring logic,
  // we construct a fresh resolver pointing at the same mapping service.
  const mapping = createBoardMappingService(db, eventStore())
  _resolverSingleton = createBoardMappingResolver(mapping)
  return _resolverSingleton
}

// ---------------------------------------------------------------------------
// appRouter — root
// ---------------------------------------------------------------------------

export const appRouter = router({
  orchestration: orchestrationRouter,
  channel: channelsRouter,
  audit: auditRouter,
  auditExport: auditExportRouter,
  vision: visionRouter,
  backlog: backlogRouter(),
  sprint: sprintRouter(),
  uat: uatRouter(),
  retro: retrosRouter(),
  onboarding: makeOnboardingRouter(),
  admin: makeAdminRouter(),
  projects: projectsRouter(),
  boards: boardsRouter(),
  // Round 6 Task #4: project memory
  // [Engineer-Sr · Sonnet · run-round6-04-project-memory]
  memory: memoryRouter(),
  // Round 6 Task #8: multi-model routing + provider fallback
  // [Engineer-Sr · Sonnet · run-round6-08-multi-model]
  providers: providersRouter,
  // Round 6 #1 — GitHub PR loop
  // [Engineer-Sr · Sonnet · run-round6-01-pr-loop]
  prs: prsRouter,
  // Round 6 #7 — Determinism / Replay
  // [Engineer-Principal · Opus · run-round6-07-replay]
  replay: replayRouter,
  // Round 6 #5 — Cost Governance + Hard Kill Switches
  // [Engineer-Sr · Sonnet · run-round6-05-cost-governance]
  cost: costRouter,
  // /settings/billing — real cost surface per project
  // [Engineer-Principal · Opus · run-settings-billing]
  billing: billingRouter,
  // Round 6 #2 — Code-Review Persona + Agent-to-Agent Review Loop
  // [Engineer-Sr · Sonnet · run-round6-02-reviewer-persona]
  code_reviews: codeReviewsRouter,
  // Round 7-08 — Operator-Attributed UI: team members + presence
  // [Engineer-Sr · Sonnet · run-round7-08-operator-attribution]
  team: teamRouter,
  // Round 7-06 — Offline Cache + Reconciliation: local outbox management
  // [Engineer-Sr · Sonnet · run-round7-08-operator-attribution]
  outbox: outboxRouter,
  // Orbital Review UI — reviewer-facing story ops (list/byId/timeline/attempts/cost + accept/reject/redirect)
  // [Engineer-Principal · Opus · run-orbital-review-ui]
  stories: storiesRouter,
  // Settings → Integrations: per-project webhook delivery surface
  // [Engineer-Principal · Opus · run-settings-integrations]
  webhooks: webhooksRouter,
  // Settings → Agents — per-project persona configuration
  // [Engineer-Principal · Opus · run-settings-agents]
  projectPersonas: projectPersonasRouter,
  // Settings → Sprints — per-project sprint policy (cadence, capacity, budget, ceremony rules)
  // [Engineer-Principal · Opus · run-settings-sprints]
  sprintPolicy: sprintPolicyRouter,
  // GitHub App install flow — installation management + repo listing
  // [Engineer-Sr · Sonnet · run-github-app-install]
  github: githubRouter,
  // QA-generated failing tests per story (generate/approve/reject)
  // [Engineer-Sr · Sonnet · run-ac-test-generation]
  testArtifacts: testArtifactsRouter,
})

export type AppRouter = typeof appRouter
