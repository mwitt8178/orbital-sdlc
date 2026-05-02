/**
 * orchestration/boot.ts — Full DI graph assembly for the orchestrator daemon.
 *
 * Closes the four critical wiring gaps identified in the boot DI audit:
 *   C1 — real SprintService (mutations) instead of read-only adapter
 *   C2 — VisionService receives Scheduler so PM persona actually spawns
 *   C3 — RetroService receives Scheduler so retro-analyst actually spawns
 *   C4 — post-task hook fires on TaskCompleted → spawns verifier
 *
 * Order is strict: each service depends only on services constructed before it.
 * See `.claude/tasks/orbital-boot-di/architecture.md` for the dependency map.
 *
 * Boot sequence (1-32) is documented in the architecture doc. Public surface is
 * a single `assembleOrchestration({...})` factory that returns every long-lived
 * service for index.ts to wire into the Fastify + WS + MCP gateway.
 */

import type postgres from 'postgres'
import type { DB } from '../db/client.js'
import type { EventStore } from '../events/store.js'
import { logger } from '../config/logger.js'

import { CapabilityAuthority } from '../capabilities/authority.js'
import { KeyManager } from '../capabilities/keys.js'
import { DefaultPersonaLoader } from '../personas/loader.js'
import {
  createRoutingEngine,
  buildDefaultCatalog,
  type RoutingEngine,
} from '../routing/engine.js'
import { loadDefaultPolicy, ensureActivePolicyInDb } from '../routing/policy.js'
import { createCostAccounting, type CostAccounting } from '../routing/cost.js'

import { DefaultChannelsService, seedChannelPostTypes } from '../comms/channels.js'
import { DefaultInboxService } from '../comms/inbox.js'
import { DefaultCeremonyService } from '../comms/ceremonies.js'
import { DefaultBlockerService } from '../comms/blockers.js'
import {
  DefaultCeremonyScheduler,
  type CeremonyScheduler,
} from '../comms/ceremony-scheduler.js'
import { defaultRules } from '../comms/ceremony-triggers/index.js'

import { WorktreeManager } from '../orchestration/worktree.js'
import { WorkerMonitor } from '../orchestration/monitor.js'
import { RetryPolicy } from '../orchestration/retry.js'
import { PauseController } from '../orchestration/pause.js'
import { DefaultScheduler, type Scheduler } from '../orchestration/scheduler.js'
import { bootstrapOrchestrationRegistry } from '../orchestration/registry-bootstrap.js'

import { ToolRegistry } from '../mcp/registry.js'
import { workerHeartbeatTool } from '../mcp/tools/worker_heartbeat.js'
import { taskCompleteTool } from '../mcp/tools/task_complete.js'
import { taskFailTool } from '../mcp/tools/task_fail.js'
import { taskRequestHelpTool } from '../mcp/tools/task_request_help.js'
import {
  memoryRecordTool,
  memorySearchTool,
} from '../mcp/tools/memory.js'
import { createMCPGateway, type MCPGateway } from '../mcp/server.js'

import { VerifierServiceImpl, type VerifierService } from '../verifiers/service.js'
import { HookEngine } from '../hooks/engine.js'
import { HookLoader } from '../hooks/loader.js'
import { createPostTaskHook } from '../hooks/baseline/post-task.js'
// Round 6 #3 — Iterate-on-Defect Loop: post-defect-reported hook
// [Engineer-Sr · Sonnet · run-round6-03-defect-iteration]
import { createPostDefectReportedHook } from '../hooks/post-defect-reported.js'
// Round 6 #9 — Inter-Agent Channel Collaboration: escalation + handoff hooks
// [Engineer-Sr · Sonnet · run-round6-09-channel-collab]
import { createPostEscalationRaisedHook } from '../hooks/post-escalation-raised.js'
import { createPostHandoffRequestedHook } from '../hooks/post-handoff-requested.js'

import { createSprintService, type SprintService } from '../backlog/sprint-service.js'
import { createBacklogService, type BacklogService } from '../backlog/service.js'
import { createMondayClient } from '../backlog/monday-client.js'
import {
  createMondaySyncService,
  type MondaySyncService,
} from '../backlog/monday-sync.js'
import { createBoardDiscoveryService, type BoardDiscoveryService } from '../backlog/board-discovery.js'
import {
  createBoardMappingService,
  type BoardMappingService,
} from '../backlog/board-mapping.js'
import {
  createBoardMappingResolver,
  type BoardMappingResolver,
} from '../backlog/board-mapping-resolver.js'
import { registerMappingResolveTool } from './registry-bootstrap.js'

import { createUATService, type UATService } from '../uat/service.js'
import { createDefectService } from '../uat/defects.js'
import { createPersonaOfRecord } from '../uat/persona-of-record.js'

import { DefaultRetroService, type RetroService } from '../retros/service.js'
import { createAgentOrgRepo } from '../retros/agent-org.js'
import { createProposalService, type ProposalService } from '../retros/proposals.js'

import {
  registerSprintService,
  registerProposalService,
} from '../trpc/routers/index.js'
import { registerScheduler } from '../trpc/routers/scheduler-ref.js'

// Round 2: ops helpers — wire periodic schedules at boot.
import { registerMondayReconciliation } from '../backlog/reconcile-bootstrap.js'
import { registerWorktreeCleanup } from './worktree-cleanup.js'
import { KeyZeroizeService } from '../capabilities/zeroize.js'
import { registerKeyZeroizeSchedule } from '../capabilities/zeroize-schedule.js'
import { loadEnv } from '../config/env.js'

// Round 3: audit reconciler with Monday drift check.
import { createDriftReconciler, type DriftReconciler } from '../audit/reconciler.js'
import { createMondayDriftCheck } from '../audit/monday-drift.js'

// Round 6 #1 — GitHub PR loop
// [Engineer-Sr · Sonnet · run-round6-01-pr-loop]
import { GitHubPROrchestrator } from '../github/pr-orchestrator.js'
import { createGithubClient } from '../github/client.js'
import { registerGithubWebhook } from '../github/webhook.js'

// Round 4: PM stub subscriber — provides deterministic PM responses in dev/demo mode.
import { registerVisionPMStub } from '../vision/pm-stub-subscriber.js'

// Round 5: Auto-decompose subscriber — fires on VisionLocked to seed starter backlog.
import { registerVisionAutoDecompose } from '../vision/auto-decompose-subscriber.js'

// Round 5A: AnthropicDriver — canonical helper every persona uses for real
// LLM-backed work. When ANTHROPIC_API_KEY is set, personas route through it.
// When unset, the driver throws at invoke() time and personas fall back to
// templated stubs.
import {
  createAnthropicDriver,
  isAnthropicAvailable,
  type AnthropicDriver,
} from '../personas/anthropic-driver.js'
import { configureNLParserDriver } from '../backlog/nl-parser.js'
// Round 6 #8 — multi-provider driver registry
// [Engineer-Sr · Sonnet · run-round6-08-multi-model]
import { createAnthropicDriver as createCoreAnthropicDriver } from '../drivers/anthropic.js'

// Round 6 #10 — Live Operator Inspection Layer
// [Engineer-Sr · Sonnet · run-round6-10-inspection-followup]
import { createInspectionService } from '../inspection/service.js'
// Round 6 #7 — Determinism / Replay
// [Engineer-Principal · Opus · run-round6-07-replay]
import path from 'node:path'
import { createFileSystemStore } from '../replay/store.js'
import {
  createReplayService,
  registerReplayService,
  type ReplayService,
} from '../replay/service.js'
import { createRecorder, type Recorder } from '../replay/recorder.js'
import { getOrbitalHome } from '../config/env.js'
import { createOpenAIDriver } from '../drivers/openai.js'
import { createBedrockDriver } from '../drivers/bedrock.js'
import { createFallbackDriver } from '../drivers/fallback.js'
import { registerDriver, clearDrivers } from '../drivers/registry.js'
// Round 6 #5 — Cost Governance + Hard Kill Switches
// [Engineer-Sr · Sonnet · run-round6-05-cost-governance]
import {
  createCostService,
  registerCostService,
  type CostService as CostServiceType,
} from '../cost/service.js'
import {
  createCostEnforcer,
  registerCostEnforcer,
  type CostEnforcer,
} from '../cost/enforcer.js'

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface AssembleParams {
  db: DB
  sql: postgres.Sql
  eventStore: EventStore
  installId: string
  /**
   * Optional MCP socket path. Defaults to ORBITAL_MCP_GATEWAY_URL or
   * /tmp/orbital-mcp.sock per createMCPGateway / loadEnv defaults.
   */
  mcpSocketPath?: string
}

export interface AssembledOrchestration {
  // Core
  authority: CapabilityAuthority
  keyManager: KeyManager
  personaLoader: DefaultPersonaLoader
  routingEngine: RoutingEngine
  costAccounting: CostAccounting
  /**
   * Round 5A: canonical helper that wraps Anthropic SDK calls. Exported so
   * sibling services (verifier, future ceremony agents) can use it without
   * re-constructing routing/cost dependencies.
   */
  anthropicDriver: AnthropicDriver

  // Comms
  channelsService: DefaultChannelsService
  inboxService: DefaultInboxService
  ceremonyService: DefaultCeremonyService
  ceremonyScheduler: CeremonyScheduler
  blockerService: DefaultBlockerService

  // Orchestration
  worktreeManager: WorktreeManager
  workerMonitor: WorkerMonitor
  retryPolicy: RetryPolicy
  pauseController: PauseController
  scheduler: Scheduler

  // MCP
  mcpRegistry: ToolRegistry
  mcpGateway: MCPGateway

  // Hooks + verifier
  verifierService: VerifierService
  hookEngine: HookEngine

  // Backlog/sprint
  sprintService: SprintService
  backlogService: BacklogService
  mondaySyncService: MondaySyncService | null

  // Round 5: board discovery + mapping (null when Monday client unavailable)
  boardDiscoveryService: BoardDiscoveryService | null
  boardMappingService: BoardMappingService | null
  boardMappingResolver: BoardMappingResolver | null

  // UAT
  uatService: UATService

  // Retros
  retroService: RetroService
  proposalService: ProposalService

  // Round 2: ops helpers
  keyZeroizeService: KeyZeroizeService
  driftReconciler: DriftReconciler

  // Round 6 #1 — GitHub PR loop (null when ORBITAL_PR_LOOP=off or token absent)
  // [Engineer-Sr · Sonnet · run-round6-01-pr-loop]
  prOrchestrator: GitHubPROrchestrator | null

  // Round 6 #10 — Live Operator Inspection Layer
  // [Engineer-Sr · Sonnet · run-round6-10-inspection-followup]
  inspectionService: import('../inspection/service.js').InspectionService

  // Round 6 #7 — Determinism / Replay
  // [Engineer-Principal · Opus · run-round6-07-replay]
  replayService: ReplayService
  recorder: Recorder

  // Round 6 #5 — Cost Governance + Hard Kill Switches
  // [Engineer-Sr · Sonnet · run-round6-05-cost-governance]
  costService: CostServiceType
  costEnforcer: CostEnforcer

  // Cleanup hook for graceful shutdown. Internally walks stopFns LIFO before
  // tearing down subscribers + the MCP gateway.
  shutdown: () => Promise<void>
}

// ---------------------------------------------------------------------------
// Hub-mode assembly (Round 7-01)
// [Engineer-Sr · Sonnet · run-round7-01-extract-hub]
// ---------------------------------------------------------------------------

/**
 * assembleHubOrchestration — minimal boot path for ORBITAL_MODE=hub.
 *
 * Initialises shared-knowledge services only:
 *   - CapabilityAuthority + KeyManager (auth primitives, system-wide)
 *   - PersonaLoader (needed for persona-aware tRPC procedures)
 *   - RoutingEngine + CostAccounting (needed for backlog + sprint routers)
 *   - ChannelsService, InboxService, CeremonyService, CeremonyScheduler, BlockerService
 *   - BacklogService, SprintService (reads/writes shared knowledge)
 *   - ProjectMemory, UAT, Retros (all shared knowledge)
 *   - CostService + CostEnforcer (hub tracks aggregate spend)
 *   - InspectionService (event aggregator; no local worker state)
 *   - HookEngine (for hub-side automation hooks)
 *   - VerifierService (needed for hook procedures)
 *   - DriftReconciler (periodic integrity check)
 *
 * Explicitly skipped (local-resource-bound):
 *   - WorktreeManager, WorkerMonitor, Scheduler (no workers on hub)
 *   - MCPGateway (no Unix socket on hub)
 *   - AnthropicDriver / LLM providers (no API key on hub)
 *   - ReplayService / Recorder (blobs stay local)
 *   - GitHubPROrchestrator (local tool call, not hub concern)
 *   - MondaySyncService / Monday reconciliation (local operator concern)
 *   - KeyZeroize schedule (local key management)
 */
async function assembleHubOrchestration(params: {
  db: AssembleParams['db']
  sql: AssembleParams['sql']
  eventStore: AssembleParams['eventStore']
  installId: string
  mcpSocketPath?: string
}): Promise<AssembledOrchestration> {
  const { db, sql, eventStore, installId, mcpSocketPath } = params

  logger.info({ installId, mode: 'hub' }, 'boot.assembleHubOrchestration: starting hub mode boot')

  // 1. Capability authority + persona loader
  const keyManager = new KeyManager(installId, eventStore)
  const authority = new CapabilityAuthority(eventStore, keyManager)
  const personaLoader = new DefaultPersonaLoader(db, eventStore)
  await personaLoader.load().catch((err: unknown) => {
    logger.warn({ err }, 'hub.boot: personaLoader.load failed; continuing')
  })

  // 2. Routing engine
  const policy = await loadDefaultPolicy()
  const policyVersion = await ensureActivePolicyInDb(db, policy).catch((err: unknown) => {
    logger.warn({ err }, 'hub.boot: ensureActivePolicyInDb failed; using version 1')
    return 1
  })
  const catalog = buildDefaultCatalog()
  const routingEngine = createRoutingEngine(db, eventStore, policy, catalog, policyVersion)

  // 3. Cost accounting (hub tracks team aggregate spend; no per-operator lines)
  const costAccounting = createCostAccounting(db, eventStore)

  // 3a. AnthropicDriver — hub mode: constructed as a stub (no key needed).
  //     Persona-aware procedures that invoke LLM calls are local-only.
  //     Constructing unconditionally so the NL parser compiles without errors;
  //     invoke() will throw because ANTHROPIC_API_KEY is absent on hub.
  const anthropicDriver = createAnthropicDriver({ routingEngine, costAccounting, installId })
  configureNLParserDriver(anthropicDriver)
  logger.info('hub.boot: AnthropicDriver constructed in stub mode (no ANTHROPIC_API_KEY expected)')

  // 3b. CostService + CostEnforcer
  const costService = createCostService(db, eventStore, installId)
  registerCostService(costService)
  const costEnforcer = createCostEnforcer(db, eventStore, costService)
  registerCostEnforcer(costEnforcer)

  // 3c. InspectionService
  const inspectionService = createInspectionService(eventStore)

  // 4. Comms services
  const channelsService = new DefaultChannelsService(db, eventStore)
  await seedChannelPostTypes(db).catch((err: unknown) => {
    logger.warn({ err }, 'hub.boot: seedChannelPostTypes failed; continuing')
  })
  await channelsService
    .bootstrapBaseline({ type: 'system', component: 'orchestrator' })
    .catch((err: unknown) => {
      logger.warn({ err }, 'hub.boot: channelsService.bootstrapBaseline failed; continuing')
    })
  const inboxService = new DefaultInboxService(db, eventStore)
  const ceremonyService = new DefaultCeremonyService(db, eventStore, channelsService)
  const ceremonySchedulerDisabled =
    process.env['CEREMONY_SCHEDULER_DISABLE'] === '1' ||
    process.env['CEREMONY_SCHEDULER_DISABLE'] === 'true'
  const ceremonyScheduler: CeremonyScheduler = new DefaultCeremonyScheduler({
    db,
    eventStore,
    ceremonyService,
    ruleRegistry: defaultRules,
    options: { disabled: ceremonySchedulerDisabled },
  })
  ceremonyScheduler.start()
  const blockerService = new DefaultBlockerService(db, eventStore, channelsService)

  // 5. Orchestration primitives — local-only services return no-op stubs.
  //    WorktreeManager, WorkerMonitor, RetryPolicy, PauseController, Scheduler
  //    are all skipped because they require local filesystem + claude binary.
  const worktreeManager = new WorktreeManager(db)
  const workerMonitor = new WorkerMonitor(db, eventStore)
  const retryPolicy = new RetryPolicy(db, eventStore)
  void retryPolicy
  const pauseController = new PauseController(db, eventStore, authority, personaLoader, installId)

  // Hub mode: no scheduler tick. We use a sentinel Scheduler that does nothing.
  // The existing DefaultScheduler constructor requires worktreeManager etc.
  // We create it but NEVER call tick() — hub mode never spawns workers.
  logger.info('hub.boot: Scheduler constructed but tick() will not run (hub mode)')
  const scheduler = new DefaultScheduler(
    db,
    eventStore,
    authority,
    personaLoader,
    routingEngine,
    worktreeManager,
    workerMonitor,
    pauseController,
    installId,
    { costEnforcer, projectId: installId },
  )

  // 6. MCP registry (no gateway on hub — Unix socket not started)
  const mcpRegistry = new ToolRegistry()
  mcpRegistry.register(workerHeartbeatTool)
  mcpRegistry.register(taskCompleteTool)
  mcpRegistry.register(taskFailTool)
  mcpRegistry.register(taskRequestHelpTool)
  mcpRegistry.register(memoryRecordTool)
  mcpRegistry.register(memorySearchTool)
  bootstrapOrchestrationRegistry({ registry: mcpRegistry, authority, db, eventStore })

  // Hub: create MCP gateway but do NOT start it (no Unix socket on hub).
  const mcpGateway = createMCPGateway({
    ...(mcpSocketPath !== undefined ? { socketPath: mcpSocketPath } : {}),
    authority,
    registry: mcpRegistry,
    eventStore,
    db,
  })
  logger.info('hub.boot: MCPGateway created but not started (hub mode skips MCP socket)')

  // 7. VerifierService + HookEngine
  const verifierService = new VerifierServiceImpl(eventStore, db)
  const hookEngine = new HookEngine(eventStore, db)
  const hookLoader = new HookLoader(db)
  const postTaskSpec = createPostTaskHook(verifierService)
  const postDefectReportedSpec = createPostDefectReportedHook(db, eventStore)
  const postEscalationRaisedSpec = createPostEscalationRaisedHook(db, eventStore)
  const postHandoffRequestedSpec = createPostHandoffRequestedHook(db, eventStore)
  const definitions = await hookLoader.load([
    postTaskSpec,
    postDefectReportedSpec,
    postEscalationRaisedSpec,
    postHandoffRequestedSpec,
  ])
  for (const def of definitions) {
    hookEngine.register(def)
  }

  // 8. Backlog + sprint
  const sprintService = createSprintService(db, eventStore, scheduler, pauseController, {
    blockerService,
  })
  const backlogService = createBacklogService(db, eventStore)
  registerSprintService(sprintService)

  // 9. UAT
  const personaOfRecord = createPersonaOfRecord(db, eventStore, anthropicDriver)
  const defectService = createDefectService(db, eventStore, backlogService)
  const uatService = createUATService(db, eventStore, defectService, personaOfRecord)

  // 10. Retros
  const agentOrg = createAgentOrgRepo()
  const proposalService = createProposalService(db, eventStore, agentOrg, installId)
  const retroService = new DefaultRetroService(db, eventStore, authority, personaLoader, installId, {
    scheduler,
    driver: anthropicDriver,
  })
  retroService.start()

  // 11. Replay — hub does not store blobs locally; stub service with local-only dir.
  const replayRootDir = path.join(getOrbitalHome(), 'replays', installId)
  const replayStore = createFileSystemStore({
    rootDir: replayRootDir,
    encryptionPassphrase: installId,
  })
  const recorder = createRecorder({ db, eventStore, store: replayStore })
  const replayService = createReplayService({ db, eventStore, store: replayStore })
  registerReplayService(replayService)

  // 12. Register DI refs for tRPC appRouter
  registerProposalService(proposalService)
  registerScheduler(scheduler)

  // 13. Ops helpers — key zeroize + drift reconciler on hub too.
  const stopFns: Array<{ label: string; stop: () => void | Promise<void> }> = []

  const keyZeroizeService = new KeyZeroizeService(eventStore, db)
  const keyZeroizeHandle = registerKeyZeroizeSchedule({ keyZeroizeService })
  stopFns.push({ label: 'keyZeroize', stop: () => keyZeroizeHandle.stop() })

  const checkMonday = undefined
  const driftReconciler = createDriftReconciler(db, sql, eventStore, {
    defaultIntervalMs: 300_000,
  })
  const stopDriftReconciler = driftReconciler.schedule(300_000)
  stopFns.push({ label: 'driftReconciler', stop: () => stopDriftReconciler() })

  // Hub-mode TaskCompleted subscriber (same as local — hub processes events from connected locals)
  const taskCompletedUnsubscribe = eventStore.subscribe(null, (envelope) => {
    if (envelope.event_type !== 'TaskCompleted') return
    const payload = envelope.payload as Record<string, unknown>
    void hookEngine
      .fire(
        'TaskCompleted',
        {
          task_id: envelope.aggregate_id,
          ticket_id: typeof payload['ticket_id'] === 'string' ? payload['ticket_id'] : undefined,
          ready_for_verification: true,
          artifact_paths: Array.isArray(payload['artifact_refs'])
            ? (payload['artifact_refs'] as Array<{ id?: string }>)
                .map((a) => (typeof a?.id === 'string' ? a.id : null))
                .filter((s): s is string => s !== null)
            : [],
          summary:
            typeof payload['summary'] === 'string' ? payload['summary'] : undefined,
        },
        {
          trace_id: envelope.trace_id,
          actor: envelope.actor,
          parent_event_id: envelope.event_id,
          capability_id: envelope.capability_id,
        },
        'post',
      )
      .catch((err: unknown) => {
        logger.error({ err }, 'hub.boot.subscribe(TaskCompleted): hookEngine.fire failed')
      })
  })

  const shutdown = async (): Promise<void> => {
    for (const { label, stop } of [...stopFns].reverse()) {
      try {
        await stop()
      } catch (err) {
        logger.warn({ err, label }, 'hub.boot.shutdown: stopFn failed (non-fatal)')
      }
    }
    try { taskCompletedUnsubscribe() } catch { /* swallow */ }
    try { inspectionService.stop() } catch { /* swallow */ }
    try { retroService.stop() } catch { /* swallow */ }
    try { ceremonyScheduler.stop() } catch { /* swallow */ }
    try { workerMonitor.stop() } catch { /* swallow */ }
  }

  logger.info(
    { installId, mode: 'hub', hookCount: definitions.length },
    'boot.assembleHubOrchestration: complete',
  )

  return {
    authority,
    keyManager,
    personaLoader,
    routingEngine,
    costAccounting,
    anthropicDriver,
    channelsService,
    inboxService,
    ceremonyService,
    ceremonyScheduler,
    blockerService,
    worktreeManager,
    workerMonitor,
    retryPolicy,
    pauseController,
    scheduler,
    mcpRegistry,
    mcpGateway,
    verifierService,
    hookEngine,
    sprintService,
    backlogService,
    mondaySyncService: null,
    boardDiscoveryService: null,
    boardMappingService: null,
    boardMappingResolver: null,
    uatService,
    retroService,
    proposalService,
    keyZeroizeService,
    driftReconciler,
    prOrchestrator: null,
    inspectionService,
    replayService,
    recorder,
    costService,
    costEnforcer,
    shutdown,
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function assembleOrchestration(
  params: AssembleParams,
): Promise<AssembledOrchestration> {
  // sql is used by DriftReconciler for raw queries. eventStore wraps it for
  // append; the reconciler needs it for ad-hoc analytics queries.
  const { db, sql, eventStore, installId, mcpSocketPath } = params

  // ------------------------------------------------------------------
  // Round 7-01 — ORBITAL_MODE branching.
  //
  // hub mode:  boots Fastify + tRPC + WS + Postgres only.
  //            Skips scheduler/spawn/worktree/MCP-gateway init.
  //            No Anthropic key needed. No cost ledger writes.
  //            Returns a partial AssembledOrchestration with all
  //            local-only fields null/stubbed.
  //
  // local mode: boots everything as today (100% backwards compat).
  //
  // [Engineer-Sr · Sonnet · run-round7-01-extract-hub]
  // ------------------------------------------------------------------
  const bootEnv = loadEnv()
  const orbitalMode = bootEnv.ORBITAL_MODE ?? 'local'

  if (orbitalMode === 'hub') {
    return assembleHubOrchestration({ db, sql, eventStore, installId, mcpSocketPath })
  }
  // local mode falls through to existing path below

  // ------------------------------------------------------------------
  // 1. Capability authority + persona loader
  // ------------------------------------------------------------------
  const keyManager = new KeyManager(installId, eventStore)
  const authority = new CapabilityAuthority(eventStore, keyManager)
  const personaLoader = new DefaultPersonaLoader(db, eventStore)
  // Best-effort persona load — continues on failure so boot stays robust.
  await personaLoader.load().catch((err: unknown) => {
    logger.warn({ err }, 'boot.assembleOrchestration: personaLoader.load failed; continuing')
  })

  // ------------------------------------------------------------------
  // 2. Routing engine (loads policy + catalog)
  // ------------------------------------------------------------------
  const policy = await loadDefaultPolicy()
  const policyVersion = await ensureActivePolicyInDb(db, policy).catch((err: unknown) => {
    logger.warn({ err }, 'boot.assembleOrchestration: ensureActivePolicyInDb failed; using version 1')
    return 1
  })
  const catalog = buildDefaultCatalog()
  const routingEngine = createRoutingEngine(db, eventStore, policy, catalog, policyVersion)

  // ------------------------------------------------------------------
  // 3. Cost accounting
  // ------------------------------------------------------------------
  const costAccounting = createCostAccounting(db, eventStore)

  // ------------------------------------------------------------------
  // 3a. AnthropicDriver — canonical LLM helper. Constructed unconditionally
  //     so call sites can inject it; the driver itself throws at invoke()
  //     time when ANTHROPIC_API_KEY is missing, and each call site catches
  //     and falls back to templated stubs.
  // ------------------------------------------------------------------
  const anthropicDriver = createAnthropicDriver({
    routingEngine,
    costAccounting,
    installId,
  })
  // Wire the driver into the NL parser singleton so backlog.parseAndCreate
  // routes through it on first use.
  configureNLParserDriver(anthropicDriver)
  if (!isAnthropicAvailable()) {
    logger.warn(
      'boot.assembleOrchestration: ANTHROPIC_API_KEY is unset. Personas will use ' +
        'templated stubs in dev mode. Set ANTHROPIC_API_KEY for real LLM-backed personas.',
    )
  } else {
    logger.info(
      'boot.assembleOrchestration: AnthropicDriver wired; personas will use real LLM calls',
    )
  }

  // ------------------------------------------------------------------
  // 3b. Driver registry (Round 6 #8) — register core provider drivers so the
  //     routing engine + tRPC providers router can query health + list models.
  // ------------------------------------------------------------------
  clearDrivers()
  const coreAnthropicDriver = createCoreAnthropicDriver()
  const openaiDriver = createOpenAIDriver()
  const bedrockDriver = createBedrockDriver()
  registerDriver(coreAnthropicDriver)
  registerDriver(openaiDriver)
  registerDriver(bedrockDriver)

  // Build fallback chain from MODEL_FALLBACK_CHAIN env var.
  const env = loadEnv()
  const chainIds = (env.MODEL_FALLBACK_CHAIN ?? 'anthropic').split(',').map((s) => s.trim())
  const chainDrivers = chainIds
    .map((id) => {
      if (id === 'anthropic') return coreAnthropicDriver
      if (id === 'openai') return openaiDriver
      if (id === 'bedrock') return bedrockDriver
      return null
    })
    .filter((d): d is NonNullable<typeof d> => d !== null)
  const fallbackDriver = createFallbackDriver(chainDrivers.length > 0 ? chainDrivers : [coreAnthropicDriver])
  registerDriver(fallbackDriver)

  // ------------------------------------------------------------------
  // 3b-cost. CostService + CostEnforcer (Round 6 #5).
  // Constructed after the fallback driver so we can wire the cost context
  // into the driver immediately.
  // [Engineer-Sr · Sonnet · run-round6-05-cost-governance]
  // ------------------------------------------------------------------
  const costService = createCostService(db, eventStore, installId)
  registerCostService(costService)

  const costEnforcer = createCostEnforcer(db, eventStore, costService)
  registerCostEnforcer(costEnforcer)

  // Wire cost context into the fallback driver so every LLM call via the
  // multi-model routing path appends a cost_ledger entry.
  // projectId is not yet known at this point (it's per-task, not per-install),
  // so we set a sentinel; the scheduler overrides it per-task via the
  // CostLedgerContext when known.
  fallbackDriver.setCostContext({
    costService,
    // projectId is populated per-spawn; leave undefined here and the service
    // will record 'unknown' until the per-task context is threaded through.
  })
  logger.info('boot.assembleOrchestration: CostService + CostEnforcer wired; cost ledger active')

  // ------------------------------------------------------------------
  // 3c. InspectionService (Round 6 #10) — constructed after eventStore is
  //     ready and BEFORE the WS hub starts so that subscriptions can resolve
  //     against an already-running aggregator. The tRPC inspect/timeline
  //     procedures read from the singleton via getInspectionService().
  // [Engineer-Sr · Sonnet · run-round6-10-inspection-followup]
  // ------------------------------------------------------------------
  const inspectionService = createInspectionService(eventStore)
  logger.info('boot.assembleOrchestration: InspectionService started')

  // ------------------------------------------------------------------
  // 3d. Replay subsystem (Round 6 #7) — encrypted-at-rest blob storage
  //     plus Recorder + Player. Wired here so anthropic-driver and the
  //     MCP gateway receive a live Recorder.
  //
  //     Storage root: ~/.orbital/replays/<install_id>/
  //     Encryption:   AES-256-GCM with key derived (scrypt) from install_id.
  //                   Per-blob salt + iv → identical content → distinct blob.
  // [Engineer-Principal · Opus · run-round6-07-replay]
  // ------------------------------------------------------------------
  const replayRootDir = path.join(getOrbitalHome(), 'replays', installId)
  const replayStore = createFileSystemStore({
    rootDir: replayRootDir,
    encryptionPassphrase: installId,
  })
  const recorder = createRecorder({ db, eventStore, store: replayStore })
  const replayService = createReplayService({ db, eventStore, store: replayStore })
  registerReplayService(replayService)
  // Late-attach the Recorder to the AnthropicDriver constructed in 3a.
  if (anthropicDriver.setRecorder) {
    anthropicDriver.setRecorder(recorder)
  }
  logger.info({ replayRootDir }, 'boot.assembleOrchestration: ReplayService started')

  // ------------------------------------------------------------------
  // 4. Comms services (channels → inbox → ceremony → blockers)
  // ------------------------------------------------------------------
  const channelsService = new DefaultChannelsService(db, eventStore)
  await seedChannelPostTypes(db).catch((err: unknown) => {
    logger.warn({ err }, 'boot.assembleOrchestration: seedChannelPostTypes failed; continuing')
  })
  await channelsService
    .bootstrapBaseline({ type: 'system', component: 'orchestrator' })
    .catch((err: unknown) => {
      logger.warn(
        { err },
        'boot.assembleOrchestration: channelsService.bootstrapBaseline failed; continuing',
      )
    })

  const inboxService = new DefaultInboxService(db, eventStore)
  const ceremonyService = new DefaultCeremonyService(db, eventStore, channelsService)
  // Agent-native CeremonyScheduler: subscribes to EventStore and auto-spawns
  // ceremonies on system state. Ceremonies fire on events, never on a clock.
  // Disable via CEREMONY_SCHEDULER_DISABLE=1 (rollback path: manual schedule
  // remains via tRPC ceremony.schedule mutation).
  const ceremonySchedulerDisabled =
    process.env['CEREMONY_SCHEDULER_DISABLE'] === '1' ||
    process.env['CEREMONY_SCHEDULER_DISABLE'] === 'true'
  const ceremonyScheduler: CeremonyScheduler = new DefaultCeremonyScheduler({
    db,
    eventStore,
    ceremonyService,
    ruleRegistry: defaultRules,
    options: { disabled: ceremonySchedulerDisabled },
  })
  ceremonyScheduler.start()
  const blockerService = new DefaultBlockerService(db, eventStore, channelsService)

  // ------------------------------------------------------------------
  // 5. Orchestration primitives (worktree, monitor, retry, pause)
  // ------------------------------------------------------------------
  const worktreeManager = new WorktreeManager(db)
  const workerMonitor = new WorkerMonitor(db, eventStore)
  const retryPolicy = new RetryPolicy(db, eventStore)
  void retryPolicy // returned for shutdown / future RetryPolicy-driven loops
  const pauseController = new PauseController(
    db,
    eventStore,
    authority,
    personaLoader,
    installId,
  )

  // ------------------------------------------------------------------
  // 6. MCP gateway (registry first; tools registered; gateway started later)
  // ------------------------------------------------------------------
  const mcpRegistry = new ToolRegistry()
  mcpRegistry.register(workerHeartbeatTool)
  mcpRegistry.register(taskCompleteTool)
  mcpRegistry.register(taskFailTool)
  mcpRegistry.register(taskRequestHelpTool)
  // Round 6 Task #4: memory tools for agents to record/search project memory
  // [Engineer-Sr · Sonnet · run-round6-04-project-memory]
  mcpRegistry.register(memoryRecordTool)
  mcpRegistry.register(memorySearchTool)
  bootstrapOrchestrationRegistry({ registry: mcpRegistry, authority, db, eventStore })

  // ------------------------------------------------------------------
  // 7. Scheduler (depends on db, eventStore, authority, personaLoader,
  //    routingEngine, worktreeManager, workerMonitor, pauseController, installId)
  // ------------------------------------------------------------------
  const scheduler = new DefaultScheduler(
    db,
    eventStore,
    authority,
    personaLoader,
    routingEngine,
    worktreeManager,
    workerMonitor,
    pauseController,
    installId,
    // Round 6 #5 — Cost Governance: wire enforcer into scheduler.
    // projectId will be resolved per sprint at tick() time in the future;
    // for now use installId as a fallback scope sentinel.
    // [Engineer-Sr · Sonnet · run-round6-05-cost-governance]
    { costEnforcer, projectId: installId },
  )

  // ------------------------------------------------------------------
  // 8. VerifierService (post-task hook target)
  // ------------------------------------------------------------------
  const verifierService = new VerifierServiceImpl(eventStore, db)

  // ------------------------------------------------------------------
  // 9. HookEngine + load baseline hooks + register post-task
  // ------------------------------------------------------------------
  const hookEngine = new HookEngine(eventStore, db)
  const hookLoader = new HookLoader(db)
  // Load the three pure baseline hooks (pre-commit, pre-status-transition,
  // pre-merge) plus the post-task hook bound to the live verifierService,
  // plus the post-defect-reported hook (Round 6 #3),
  // plus the escalation-raised and handoff-requested hooks (Round 6 #9).
  // [Engineer-Sr · Sonnet · run-round6-03-defect-iteration]
  // [Engineer-Sr · Sonnet · run-round6-09-channel-collab]
  const postTaskSpec = createPostTaskHook(verifierService)
  const postDefectReportedSpec = createPostDefectReportedHook(db, eventStore)
  const postEscalationRaisedSpec = createPostEscalationRaisedHook(db, eventStore)
  const postHandoffRequestedSpec = createPostHandoffRequestedHook(db, eventStore)
  const definitions = await hookLoader.load([
    postTaskSpec,
    postDefectReportedSpec,
    postEscalationRaisedSpec,
    postHandoffRequestedSpec,
  ])
  for (const def of definitions) {
    hookEngine.register(def)
  }
  logger.info(
    { count: definitions.length },
    'boot.assembleOrchestration: hooks registered',
  )

  // ------------------------------------------------------------------
  // 10. Real SprintService (closes C1) — replaces read-only registration
  // ------------------------------------------------------------------
  const sprintService = createSprintService(db, eventStore, scheduler, pauseController, {
    blockerService,
  })

  // ------------------------------------------------------------------
  // 11. Backlog + Monday sync
  // ------------------------------------------------------------------
  const backlogService = createBacklogService(db, eventStore)

  // ------------------------------------------------------------------
  // 11a. Round 5: board discovery + mapping resolver. Built BEFORE Monday sync
  //      so the sync service can use the resolver for mapping-aware writes.
  // ------------------------------------------------------------------
  let boardDiscoveryService: BoardDiscoveryService | null = null
  let boardMappingService: BoardMappingService | null = null
  let boardMappingResolver: BoardMappingResolver | null = null
  try {
    const mondayClientForDiscovery = createMondayClient()
    boardDiscoveryService = createBoardDiscoveryService(mondayClientForDiscovery)
    boardMappingService = createBoardMappingService(db, eventStore, {
      driver: anthropicDriver,
      installId,
    })
    boardMappingResolver = createBoardMappingResolver(boardMappingService)
    // Register the mapping.resolve MCP tool so persona workers can read it.
    registerMappingResolveTool({
      registry: mcpRegistry,
      resolver: boardMappingResolver,
    })
  } catch (err) {
    logger.warn(
      { err },
      'boot.assembleOrchestration: board discovery/mapping construction failed; mapping.resolve tool unavailable',
    )
  }

  // Monday sync is best-effort — requires API token; skip silently if absent.
  let mondaySyncService: MondaySyncService | null = null
  try {
    const mondayClient = createMondayClient()
    const syncOptions: Parameters<typeof createMondaySyncService>[3] = {}
    if (boardMappingResolver) {
      syncOptions.mappingResolver = boardMappingResolver
    }
    mondaySyncService = createMondaySyncService(db, eventStore, mondayClient, syncOptions)
  } catch (err) {
    logger.warn(
      { err },
      'boot.assembleOrchestration: Monday client construction failed; sync service will be null',
    )
  }

  // ------------------------------------------------------------------
  // 12. UAT — pass the AnthropicDriver so the resolver can run a reasoning
  //     step before falling back to tasks.persona_id when a defect description
  //     is supplied.
  // ------------------------------------------------------------------
  const personaOfRecord = createPersonaOfRecord(db, eventStore, anthropicDriver)
  const defectService = createDefectService(db, eventStore, backlogService)
  const uatService = createUATService(db, eventStore, defectService, personaOfRecord)

  // ------------------------------------------------------------------
  // 13. Retros — pass Scheduler (C3) and AnthropicDriver. When the driver is
  //     available, analyze() invokes the retro-analyst persona in-process and
  //     persists proposals immediately. When unavailable, the existing
  //     scheduler-based spawn path runs.
  // ------------------------------------------------------------------
  const agentOrg = createAgentOrgRepo()
  const proposalService = createProposalService(db, eventStore, agentOrg, installId)
  const retroService = new DefaultRetroService(
    db,
    eventStore,
    authority,
    personaLoader,
    installId,
    { scheduler, driver: anthropicDriver },
  )
  retroService.start() // subscribe to SprintCompleted

  // ------------------------------------------------------------------
  // 14. Wire EventStore.subscribe → post-task hook (closes C4)
  //     HookEngine.fire('post-task', payload, ctx, 'post') — fire-and-forget.
  // ------------------------------------------------------------------
  const taskCompletedUnsubscribe = eventStore.subscribe(null, (envelope) => {
    if (envelope.event_type !== 'TaskCompleted') return
    const payload = envelope.payload as Record<string, unknown>
    void hookEngine
      .fire(
        'TaskCompleted',
        {
          task_id: envelope.aggregate_id,
          ticket_id: typeof payload['ticket_id'] === 'string' ? payload['ticket_id'] : undefined,
          ready_for_verification: true, // every TaskCompleted triggers verification per TRD-09 §10.1
          artifact_paths: Array.isArray(payload['artifact_refs'])
            ? (payload['artifact_refs'] as Array<{ id?: string }>)
                .map((a) => (typeof a?.id === 'string' ? a.id : null))
                .filter((s): s is string => s !== null)
            : [],
          summary:
            typeof payload['output_summary'] === 'string' ? payload['output_summary'] : undefined,
        },
        {
          trace_id: envelope.trace_id,
          actor: envelope.actor,
          parent_event_id: envelope.event_id,
          capability_id: envelope.capability_id,
        },
        'post',
      )
      .catch((err: unknown) => {
        logger.error(
          { err, eventId: envelope.event_id, taskId: envelope.aggregate_id },
          'boot.subscribe(TaskCompleted): hookEngine.fire failed',
        )
      })
  })

  // ------------------------------------------------------------------
  // 14a-channel. Round 6 #9 — Inter-Agent Channel Collaboration.
  //   Subscribe to ChannelPostAdded to fire escalation + handoff hooks,
  //   and to EscalationRaised to notify the scheduler.
  // [Engineer-Sr · Sonnet · run-round6-09-channel-collab]
  // ------------------------------------------------------------------
  const channelPostAddedUnsubscribe = eventStore.subscribe(null, (envelope) => {
    if (envelope.event_type !== 'ChannelPostAdded') return
    const postType = (envelope.payload as Record<string, unknown>)['post_type']
    if (postType !== 'escalation_note' && postType !== 'handoff_note') return

    void hookEngine
      .fire(
        'ChannelPostAdded',
        envelope.payload,
        {
          trace_id: envelope.trace_id,
          actor: envelope.actor,
          parent_event_id: envelope.event_id,
          capability_id: envelope.capability_id,
        },
        'post',
      )
      .catch((err: unknown) => {
        logger.error(
          { err, eventId: envelope.event_id, postType },
          'boot.subscribe(ChannelPostAdded): hookEngine.fire failed',
        )
      })
  })

  const escalationRaisedUnsubscribe = eventStore.subscribe(null, (envelope) => {
    if (envelope.event_type !== 'EscalationRaised') return
    const payload = envelope.payload as unknown as import('../events/types.js').EscalationRaisedPayload
    scheduler.onEscalationRaised(payload)
  })

  // ------------------------------------------------------------------
  // 14b. PM stub subscriber — fires deterministic PM replies in dev/demo
  //      mode (when ANTHROPIC_API_KEY absent or CLAUDE_BIN not found).
  //      In production with a real worker this is a no-op per isStubMode().
  //      Fire-and-forget — boot continues immediately; stub mode is resolved
  //      lazily on first VisionMessageSent event.
  // ------------------------------------------------------------------
  const visionPMStubUnsubscribe = registerVisionPMStub({
    eventStore,
    db,
    driver: anthropicDriver,
  })

  // ------------------------------------------------------------------
  // 14c. Vision auto-decompose subscriber — on VisionLocked, seeds a
  //      starter backlog (3-5 epics + 2-3 stories each) without any user
  //      action. Idempotent: re-locking the same version is a no-op.
  //      Fire-and-forget — does not block the lock path.
  // ------------------------------------------------------------------
  const visionAutoDecomposeUnsubscribe = registerVisionAutoDecompose({ eventStore, db })

  // ------------------------------------------------------------------
  // 15. Register lazy DI for tRPC appRouter
  // ------------------------------------------------------------------
  registerSprintService(sprintService)
  registerProposalService(proposalService)
  registerScheduler(scheduler)

  // ------------------------------------------------------------------
  // 16. Start MCP gateway socket
  // ------------------------------------------------------------------
  const mcpGateway = createMCPGateway({
    ...(mcpSocketPath !== undefined ? { socketPath: mcpSocketPath } : {}),
    authority,
    registry: mcpRegistry,
    eventStore,
    db,
    // Round 6 #7 — pass the Recorder so every tool call captures a replay blob.
    recorder,
  })
  await mcpGateway.start()

  // ------------------------------------------------------------------
  // 17. Start the worker monitor poll loop
  // ------------------------------------------------------------------
  workerMonitor.start()

  // ------------------------------------------------------------------
  // 18. Round 2 — ops helpers (M1 Monday reconcile, M2 worktree cleanup,
  //     M6 key zeroize). Each helper returns a stop function that we
  //     collect into stopFns LIFO so shutdown runs:
  //       zeroize → worktreeCleanup → mondayReconcile.
  // ------------------------------------------------------------------
  const stopFns: Array<{ label: string; stop: () => void | Promise<void> }> = []

  // M1 — Monday periodic reconciliation. Only register if a sync service was
  // constructed AND a board id is configured. Both branches are idempotent.
  if (mondaySyncService) {
    const env = loadEnv()
    const boardId = env.MONDAY_BOARD_ID ?? ''
    const handle = registerMondayReconciliation({ syncService: mondaySyncService, boardId })
    stopFns.push({ label: 'mondayReconcile', stop: () => handle.stop() })
  } else {
    logger.warn(
      'boot.assembleOrchestration: MondaySyncService not constructed (likely missing MONDAY_API_TOKEN); skipping registerMondayReconciliation',
    )
  }

  // M2 — Worktree cleanup on TaskCompleted/TaskFailed.
  const worktreeCleanupHandle = registerWorktreeCleanup({ eventStore, worktreeManager, db })
  stopFns.push({ label: 'worktreeCleanup', stop: () => worktreeCleanupHandle.stop() })

  // M6 — Key zeroize schedule. Construct service + register periodic sweep.
  const keyZeroizeService = new KeyZeroizeService(eventStore, db)
  const keyZeroizeHandle = registerKeyZeroizeSchedule({ keyZeroizeService })
  stopFns.push({ label: 'keyZeroize', stop: () => keyZeroizeHandle.stop() })

  // O7 — DriftReconciler scheduled at boot every 5 min, with optional Monday
  // drift callback when MondaySyncService + boardId are configured.
  const reconcilerEnv = loadEnv()
  const checkMonday = mondaySyncService
    ? createMondayDriftCheck({
        syncService: mondaySyncService,
        boardId: reconcilerEnv.MONDAY_BOARD_ID,
      })
    : undefined
  const driftReconciler: DriftReconciler = createDriftReconciler(db, sql, eventStore, {
    ...(checkMonday ? { checkMonday } : {}),
    defaultIntervalMs: 300_000,
  })
  const stopDriftReconciler = driftReconciler.schedule(300_000)
  stopFns.push({ label: 'driftReconciler', stop: () => stopDriftReconciler() })
  logger.info(
    { intervalMs: 300_000, mondayDriftEnabled: !!checkMonday },
    'boot: DriftReconciler scheduled',
  )

  // ------------------------------------------------------------------
  // O8 — GitHub PR Orchestrator (Round 6 #1)
  // Only started when ORBITAL_PR_LOOP=on and GITHUB_API_TOKEN is set.
  // Feature-flagged so the system continues to work without a remote configured.
  // [Engineer-Sr · Sonnet · run-round6-01-pr-loop]
  // ------------------------------------------------------------------
  let prOrchestrator: GitHubPROrchestrator | null = null
  const prEnv = loadEnv()
  if (prEnv.ORBITAL_PR_LOOP === 'on') {
    const githubToken = prEnv.GITHUB_API_TOKEN
    if (!githubToken) {
      logger.warn(
        'boot: ORBITAL_PR_LOOP=on but GITHUB_API_TOKEN is not set; GitHubPROrchestrator not started. ' +
          'Set GITHUB_API_TOKEN or turn off with ORBITAL_PR_LOOP=off.',
      )
    } else {
      try {
        const githubClient = createGithubClient({ token: githubToken })
        prOrchestrator = new GitHubPROrchestrator({
          db,
          eventStore,
          githubClient,
          githubToken,
        })
        prOrchestrator.start()
        logger.info('boot: GitHubPROrchestrator started (ORBITAL_PR_LOOP=on)')
      } catch (err) {
        logger.error(
          { err },
          'boot: GitHubPROrchestrator construction failed; PR loop will not run',
        )
      }
    }
  } else {
    logger.info('boot: ORBITAL_PR_LOOP=off; GitHub PR loop disabled')
  }

  // ------------------------------------------------------------------
  // Shutdown handle — LIFO walk of stopFns runs first, then existing
  // teardown (event subscriber → retro → workerMonitor → mcpGateway).
  // ------------------------------------------------------------------
  const shutdown = async (): Promise<void> => {
    // Walk stopFns in reverse insertion order. Result: zeroize → worktreeCleanup
    // → mondayReconcile. Failures are non-fatal.
    for (const { label, stop } of [...stopFns].reverse()) {
      try {
        await stop()
      } catch (err) {
        logger.warn({ err, label }, 'boot.shutdown: stopFn failed (non-fatal)')
      }
    }
    try {
      taskCompletedUnsubscribe()
    } catch {
      /* swallow — best-effort */
    }
    // Round 6 #9 — Inter-Agent Channel Collaboration: unsubscribe channel hooks
    // [Engineer-Sr · Sonnet · run-round6-09-channel-collab]
    try {
      channelPostAddedUnsubscribe()
    } catch {
      /* swallow — best-effort */
    }
    try {
      escalationRaisedUnsubscribe()
    } catch {
      /* swallow — best-effort */
    }
    try {
      visionPMStubUnsubscribe()
    } catch {
      /* swallow — best-effort */
    }
    try {
      visionAutoDecomposeUnsubscribe()
    } catch {
      /* swallow — best-effort */
    }
    try {
      if (prOrchestrator) prOrchestrator.stop()
    } catch {
      /* swallow */
    }
    try {
      inspectionService.stop()
    } catch {
      /* swallow */
    }
    try {
      retroService.stop()
    } catch {
      /* swallow */
    }
    try {
      ceremonyScheduler.stop()
    } catch {
      /* swallow */
    }
    try {
      workerMonitor.stop()
    } catch {
      /* swallow */
    }
    try {
      await mcpGateway.stop()
    } catch (err) {
      logger.warn({ err }, 'boot.shutdown: mcpGateway.stop failed')
    }
  }

  logger.info(
    {
      installId,
      mcpSocketPath: mcpGateway.socketPath,
      hookCount: definitions.length,
    },
    'boot.assembleOrchestration: complete',
  )

  return {
    authority,
    keyManager,
    personaLoader,
    routingEngine,
    costAccounting,
    anthropicDriver,
    channelsService,
    inboxService,
    ceremonyService,
    ceremonyScheduler,
    blockerService,
    worktreeManager,
    workerMonitor,
    retryPolicy,
    pauseController,
    scheduler,
    mcpRegistry,
    mcpGateway,
    verifierService,
    hookEngine,
    sprintService,
    backlogService,
    mondaySyncService,
    boardDiscoveryService,
    boardMappingService,
    boardMappingResolver,
    uatService,
    retroService,
    proposalService,
    keyZeroizeService,
    driftReconciler,
    prOrchestrator,
    inspectionService,
    // Round 6 #7 — Determinism / Replay
    // [Engineer-Principal · Opus · run-round6-07-replay]
    replayService,
    recorder,
    // Round 6 #5 — Cost Governance + Hard Kill Switches
    // [Engineer-Sr · Sonnet · run-round6-05-cost-governance]
    costService,
    costEnforcer,
    shutdown,
  }
}
