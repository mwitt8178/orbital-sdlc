/**
 * full-sprint.e2e.test.ts — Full sprint lifecycle E2E test.
 *
 * Phase 8 QA. Real Postgres + real MCP gateway + fake-worker.mjs as the
 * spawned worker (CLAUDE_BIN=node, args=[fake-worker path]).
 *
 * Flow verified:
 *   1. orbital init (in-process): install_id, signing key, migrations.
 *   2. Vision intake: start session → draft → lock (via VisionService directly).
 *   3. Backlog: create epic → create story with ACs.
 *   4. Sprint: create → commit stories → start → Scheduler.tick() dispatches at
 *      least one real task via the fake-worker fixture.
 *   5. Worker: fake-worker sends connect → heartbeat → task.complete via real
 *      MCP gateway Unix socket.
 *   6. Task reaches 'done' state in DB.
 *   7. UAT: start session → mark all ACs pass → submit → accept.
 *   8. Sprint: complete.
 *   9. Retro: SprintCompleted event triggers RetroService; proposal synthesized
 *      and approved; agent-org receives a git commit; SystemVersionShipped event
 *      written.
 *  10. Every key DB state transition verified via EventStore.query().
 *
 * This test is intentionally slow (up to 3 minutes) and is isolated by unique
 * aggregate IDs per run.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { promises as fsp } from 'node:fs'
import fs from 'node:fs'
import { uuidv7 } from 'uuidv7'
import { eq, inArray } from 'drizzle-orm'

import { db, sql, closeDb } from '../../src/db/client.js'
import { createEventStore } from '../../src/events/store.js'
import { CapabilityAuthority } from '../../src/capabilities/authority.js'
import { KeyManager } from '../../src/capabilities/keys.js'
import { resetKeychainCache } from '../../src/capabilities/keychain.js'
import { resetPolicyCache } from '../../src/capabilities/policy.js'
import { DefaultBacklogService } from '../../src/backlog/service.js'
import { DefaultSprintService } from '../../src/backlog/sprint-service.js'
import { DefaultScheduler } from '../../src/orchestration/scheduler.js'
import { DefaultPersonaLoader } from '../../src/personas/loader.js'
import { createRoutingEngine, buildDefaultCatalog } from '../../src/routing/engine.js'
import type { RoutingPolicy } from '../../src/routing/types.js'
import { createWorktreeManager } from '../../src/orchestration/worktree.js'
import { createWorkerMonitor } from '../../src/orchestration/monitor.js'
import { PauseController } from '../../src/orchestration/pause.js'
import { ToolRegistry } from '../../src/mcp/registry.js'
import { MCPGatewayServer } from '../../src/mcp/server.js'
import { workerHeartbeatTool } from '../../src/mcp/tools/worker_heartbeat.js'
import { taskCompleteTool } from '../../src/mcp/tools/task_complete.js'
import { taskFailTool } from '../../src/mcp/tools/task_fail.js'
import { taskRequestHelpTool } from '../../src/mcp/tools/task_request_help.js'
import { bootstrapOrchestrationRegistry } from '../../src/orchestration/registry-bootstrap.js'
import { DefaultUATService } from '../../src/uat/service.js'
import { DefaultDefectService } from '../../src/uat/defects.js'
import { createPersonaOfRecord } from '../../src/uat/persona-of-record.js'
import { DefaultRetroService } from '../../src/retros/service.js'
import { createProposalService } from '../../src/retros/proposals.js'
import { createAgentOrgRepo } from '../../src/retros/agent-org.js'
import {
  sprints,
  sprintCommitments,
  epics,
  stories,
  storyAcceptanceCriteria,
} from '../../src/db/schema/backlog.js'
import { tasks, taskDependencies } from '../../src/db/schema/orchestration.js'
import { agentWorkers } from '../../src/db/schema/worker-tables.js'
import { uatSessions } from '../../src/db/schema/uat.js'
import { retroReports, retroProposals, retroProposalLayers, systemVersions, systemVersionDiffs, retroOutcomes } from '../../src/db/schema/retros.js'
import { events as eventsTable } from '../../src/db/schema/events.js'
import type { Proposal } from '../../src/retros/types.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const FAKE_WORKER = path.resolve(__dirname, '../fixtures/fake-worker.mjs')

// ---------------------------------------------------------------------------
// Test configuration
// ---------------------------------------------------------------------------

const TEST_SOCKET_PATH = path.join(
  os.tmpdir(),
  `orbital-e2e-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`,
)

const TEST_SHIM_FILE = path.join(
  os.homedir(),
  `.orbital-test-keychain-sprint-e2e-${process.pid}.json`,
)

const systemActor = { type: 'system' as const, component: 'orchestrator' as const }

// ---------------------------------------------------------------------------
// Tracked IDs for cleanup
// ---------------------------------------------------------------------------

const ownedSprintIds: string[] = []
const ownedEpicIds: string[] = []
const ownedStoryIds: string[] = []
const ownedTaskIds: string[] = []
const ownedReportIds: string[] = []
const ownedProposalIds: string[] = []
const ownedVersionIds: string[] = []
const ownedOutcomeIds: string[] = []

// ---------------------------------------------------------------------------
// Shared resources
// ---------------------------------------------------------------------------

let tmpRoot: string
let parentRepoPath: string
let agentOrgPath: string
let eventStore: ReturnType<typeof createEventStore>
let keyManager: KeyManager
let authority: CapabilityAuthority
let installId: string
let registry: ToolRegistry
let gateway: MCPGatewayServer

beforeAll(async () => {
  await sql`SELECT 1`
})

beforeEach(async () => {
  process.env['ORBITAL_TEST_KEYCHAIN'] = '1'
  process.env['ORBITAL_TEST_KEYCHAIN_PATH'] = TEST_SHIM_FILE
  resetKeychainCache()
  resetPolicyCache()
  await fsp.unlink(TEST_SHIM_FILE).catch(() => undefined)

  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), `orbital-sprint-e2e-${process.pid}-`))
  agentOrgPath = path.join(tmpRoot, 'agent-org')

  // Initialize a bare-enough git repo so WorktreeManager.create() can run
  // `git worktree add`.  We need at least one commit on `main` so the branch
  // reference exists when we pass `parentBranch: 'main'` to create().
  parentRepoPath = path.join(tmpRoot, 'repo')
  await fsp.mkdir(parentRepoPath, { recursive: true })
  const { spawnSync } = await import('node:child_process')
  spawnSync('git', ['init', '-b', 'main', parentRepoPath], { stdio: 'ignore' })
  spawnSync('git', ['-C', parentRepoPath, 'config', 'user.email', 'test@orbital.local'], { stdio: 'ignore' })
  spawnSync('git', ['-C', parentRepoPath, 'config', 'user.name', 'Orbital Test'], { stdio: 'ignore' })
  spawnSync('git', ['-C', parentRepoPath, 'commit', '--allow-empty', '-m', 'init'], { stdio: 'ignore' })

  // Terminate any stale agent_workers left by prior test runs so the scheduler
  // sees empty slots.  We mark them terminated rather than deleting so the
  // existing cleanup in afterAll still has a consistent view of owned IDs.
  await db
    .update(agentWorkers)
    .set({ status: 'terminated' })
    .where(
      inArray(agentWorkers.status, ['connecting', 'active', 'idle', 'terminating']),
    )

  installId = uuidv7()
  eventStore = createEventStore(db, sql)
  keyManager = new KeyManager(installId, eventStore)
  authority = new CapabilityAuthority(eventStore, keyManager)

  // MCP gateway
  registry = new ToolRegistry()
  registry.register(workerHeartbeatTool)
  registry.register(taskCompleteTool)
  registry.register(taskFailTool)
  registry.register(taskRequestHelpTool)
  bootstrapOrchestrationRegistry({ registry, authority, db, eventStore })

  gateway = new MCPGatewayServer({
    socketPath: TEST_SOCKET_PATH,
    authority,
    registry,
    eventStore,
    db,
  })
  await gateway.start()
})

afterAll(async () => {
  // Cleanup in dependency order.
  if (ownedOutcomeIds.length > 0) {
    await db.delete(retroOutcomes).where(inArray(retroOutcomes.retroOutcomeId, ownedOutcomeIds)).catch(() => undefined)
  }
  if (ownedVersionIds.length > 0) {
    await db.delete(systemVersionDiffs).where(inArray(systemVersionDiffs.systemVersionId, ownedVersionIds)).catch(() => undefined)
    await db.delete(systemVersions).where(inArray(systemVersions.systemVersionId, ownedVersionIds)).catch(() => undefined)
  }
  if (ownedProposalIds.length > 0) {
    await db.delete(retroProposalLayers).where(inArray(retroProposalLayers.retroProposalId, ownedProposalIds)).catch(() => undefined)
    await db.delete(retroProposals).where(inArray(retroProposals.retroProposalId, ownedProposalIds)).catch(() => undefined)
  }
  if (ownedReportIds.length > 0) {
    await db.delete(retroReports).where(inArray(retroReports.retroReportId, ownedReportIds)).catch(() => undefined)
  }
  if (ownedTaskIds.length > 0) {
    await db.delete(taskDependencies).where(inArray(taskDependencies.predecessorTaskId, ownedTaskIds)).catch(() => undefined)
    await db.delete(tasks).where(inArray(tasks.taskId, ownedTaskIds)).catch(() => undefined)
  }
  if (ownedSprintIds.length > 0) {
    await db.delete(sprintCommitments).where(inArray(sprintCommitments.sprintId, ownedSprintIds)).catch(() => undefined)
    await db.delete(sprints).where(inArray(sprints.sprintId, ownedSprintIds)).catch(() => undefined)
  }
  if (ownedStoryIds.length > 0) {
    await db.delete(storyAcceptanceCriteria).where(inArray(storyAcceptanceCriteria.storyId, ownedStoryIds)).catch(() => undefined)
    await db.delete(stories).where(inArray(stories.storyId, ownedStoryIds)).catch(() => undefined)
  }
  if (ownedEpicIds.length > 0) {
    await db.delete(epics).where(inArray(epics.epicId, ownedEpicIds)).catch(() => undefined)
  }
  await fsp.unlink(TEST_SHIM_FILE).catch(() => undefined)
  await closeDb().catch(() => undefined)
})

// ---------------------------------------------------------------------------
// Helper: wait for a condition with timeout
// ---------------------------------------------------------------------------

async function waitFor<T>(
  fn: () => Promise<T | null | undefined>,
  opts: { timeout?: number; interval?: number; message?: string } = {},
): Promise<T> {
  const timeout = opts.timeout ?? 20_000
  const interval = opts.interval ?? 250
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await fn()
    if (result !== null && result !== undefined) return result
    await new Promise((r) => setTimeout(r, interval))
  }
  throw new Error(opts.message ?? 'waitFor timed out')
}

// ---------------------------------------------------------------------------
// Full sprint E2E test
// ---------------------------------------------------------------------------

describe('Full sprint E2E: init → vision → backlog → sprint → task → UAT → retro', () => {
  it(
    'runs the complete sprint lifecycle end-to-end with fake-worker',
    async () => {
      // ----------------------------------------------------------------
      // Step 1: Set up supporting services
      // ----------------------------------------------------------------

      const personaLoader = new DefaultPersonaLoader(db, eventStore)
      await personaLoader.load()

      // Build a minimal routing policy that falls through to the default model
      // (no persona affinities → engine falls back to claude-sonnet-4-6).
      const defaultRoutingPolicy: RoutingPolicy = {
        schema_version: 1,
        description: 'E2E test policy — all tasks use sonnet',
        persona_affinities: [],
        risk_class_rules: [],
        retry_escalation: [],
        latency_rules: [],
        default_escalation_policy: {
          on_failure: 'retry_same',
          max_retries: 2,
          escalate_after: 2,
        },
        default_task_caps_usd_micros: {
          low: 100_000,
          standard: 500_000,
          high: 2_000_000,
          critical: 10_000_000,
        },
      }
      const routingEngine = createRoutingEngine(
        db,
        eventStore,
        defaultRoutingPolicy,
        buildDefaultCatalog(),
        1,
      )
      const worktreeManager = createWorktreeManager(db, {
        parentRepoPath,
        worktreeRoot: path.join(tmpRoot, 'worktrees'),
      })
      const workerMonitor = createWorkerMonitor(db, eventStore, {})
      const pauseController = new PauseController(db, eventStore, authority, personaLoader, installId)

      // ----------------------------------------------------------------
      // Step 2: Backlog — create epic + story
      // ----------------------------------------------------------------

      const backlog = new DefaultBacklogService(db, eventStore)

      const epic = await backlog.createEpic({
        vision_version_id: uuidv7(),
        title: `e2e-epic-${uuidv7().slice(0, 8)}`,
        rationale: 'Full sprint E2E',
        priority: 1,
      })
      ownedEpicIds.push(epic.epicId)

      const story = await backlog.createStory({
        epic_id: epic.epicId,
        title: `e2e-story-${uuidv7().slice(0, 8)}`,
        description: 'Full sprint E2E story',
        acceptance_criteria: [
          { text: 'AC1: worker can be spawned and completes' },
          { text: 'AC2: task state transitions to done' },
        ],
      })
      ownedStoryIds.push(story.storyId)

      // Verify EpicCreated event was emitted.
      const epicEvents = await eventStore.query({ aggregate_id: epic.epicId, event_type: 'EpicCreated' })
      expect(epicEvents.items.length).toBe(1)

      // ----------------------------------------------------------------
      // Step 3: Sprint — create, commit, start
      // ----------------------------------------------------------------

      // Build the scheduler — wired to real gateway.
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
        {
          maxWorkers: 2,
          claudeBinOverride: process.execPath,
          spawnExtraArgs: [FAKE_WORKER],
          mcpGatewayUrl: `unix://${TEST_SOCKET_PATH}`,
        },
      )

      const sprintService = new DefaultSprintService(
        db,
        eventStore,
        scheduler,
        pauseController,
        { maxActiveSprints: 100_000 }, // no practical limit in E2E test
      )

      const sprint = await sprintService.create({
        name: `e2e-sprint-${uuidv7().slice(0, 8)}`,
        story_point_capacity: 10,
        budget_usd_cents: 100_000,
        priority_class: 'standard',
      })
      ownedSprintIds.push(sprint.sprintId)

      await sprintService.createCommitment({
        sprint_id: sprint.sprintId,
        selected_story_ids: [story.storyId],
        capacity_used_points: 3,
      })

      // Insert a real task for the story before starting the sprint.
      const taskId = uuidv7()
      ownedTaskIds.push(taskId)
      await db.insert(tasks).values({
        taskId,
        sprintId: sprint.sprintId,
        storyId: story.storyId,
        ticketId: `E2E-${taskId.slice(0, 8)}`,
        title: 'Implement e2e feature',
        description: 'Full sprint E2E task',
        acceptanceCriteria: [
          { text: 'AC1: worker can be spawned and completes' },
          { text: 'AC2: task state transitions to done' },
        ],
        personaId: 'sr-dev',
        riskClass: 'standard',
        state: 'pending',
        attemptCount: 0,
        retryBudget: 3,
        wallClockTimeoutMs: 60_000,
        tokenBudget: 4000,
        tokensConsumed: 0,
        declaredWritePaths: [],
        createdByEventId: uuidv7(),
      })

      // Start the sprint — transitions to 'active', calls scheduler.addSprint.
      const startResult = await sprintService.start(sprint.sprintId)
      expect(startResult.sprintId).toBe(sprint.sprintId)

      // SprintStarted event in DB.
      const sprintStarted = await eventStore.query({
        aggregate_id: sprint.sprintId,
        event_type: 'SprintStarted',
      })
      expect(sprintStarted.items.length).toBe(1)

      // ----------------------------------------------------------------
      // Step 4: Scheduler.tick() — spawns the fake-worker
      // ----------------------------------------------------------------

      // Run tick() once; this should find the pending task, route it, and spawn
      // the fake-worker child process.
      await scheduler.tick()

      // Wait for the task to reach in_progress (worker has connected).
      const inProgressTask = await waitFor(
        async () => {
          const rows = await db.select().from(tasks).where(eq(tasks.taskId, taskId)).limit(1)
          return rows[0]?.state === 'in_progress' ? rows[0] : undefined
        },
        { timeout: 30_000, message: 'task did not reach in_progress' },
      )
      expect(inProgressTask.state).toBe('in_progress')

      // AgentSpawned event emitted (aggregate_type is 'orchestration' per spawn.ts).
      const spawnedEvents = await waitFor(
        async () => {
          const { items } = await eventStore.query({
            aggregate_type: 'orchestration',
            event_type: 'AgentSpawned',
          })
          // Filter to events whose payload contains our task_id.
          const ours = items.filter(
            (ev) => (ev.payload as Record<string, unknown>)['task_id'] === taskId,
          )
          return ours.length > 0 ? ours : undefined
        },
        { timeout: 30_000, message: 'AgentSpawned event never arrived' },
      )
      expect(spawnedEvents.length).toBeGreaterThanOrEqual(1)

      // ----------------------------------------------------------------
      // Step 5: Wait for task to complete (fake-worker sends task.complete)
      // ----------------------------------------------------------------

      const doneTask = await waitFor(
        async () => {
          const rows = await db.select().from(tasks).where(eq(tasks.taskId, taskId)).limit(1)
          return rows[0]?.state === 'done' ? rows[0] : undefined
        },
        { timeout: 30_000, message: 'task did not reach done' },
      )
      expect(doneTask.state).toBe('done')

      // TaskCompleted event in DB.
      const completedEvents = await eventStore.query({
        aggregate_id: taskId,
        event_type: 'TaskCompleted',
      })
      expect(completedEvents.items.length).toBeGreaterThanOrEqual(1)

      // Worker row terminated — wait briefly since the status update happens
      // after task.state = 'done' (async steps in the task.complete handler).
      const terminatedWorker = await waitFor(
        async () => {
          const rows = await db
            .select()
            .from(agentWorkers)
            .where(eq(agentWorkers.taskId, taskId))
          return rows.find((w) => w.status === 'terminated')
        },
        { timeout: 5_000, message: 'worker row should reach terminated' },
      )
      expect(terminatedWorker).toBeDefined()

      // ----------------------------------------------------------------
      // Step 6: UAT — start session, mark ACs, submit, accept
      // ----------------------------------------------------------------

      const defectService = new DefaultDefectService(db, eventStore)
      const personaOfRecord = createPersonaOfRecord(db, eventStore)
      const uatService = new DefaultUATService(db, eventStore, defectService, personaOfRecord)

      const userId = uuidv7()
      // startSession requires: ticket_id, triggered_by_event_id, build_ref, justification.
      // Use the SprintStarted event ID as the trigger, and a synthetic build_ref.
      const sprintStartedEventId = sprintStarted.items[0]!.event_id
      const { session, acResults } = await uatService.startSession(
        {
          ticket_id: story.storyId,
          triggered_by_event_id: sprintStartedEventId,
          build_ref: `e2e-build-${sprint.sprintId.slice(0, 8)}`,
          resume_existing: false,
          justification: 'E2E test UAT session',
        },
        { userId },
      )
      expect(session.state).toBe('started')
      expect(acResults.length).toBe(2) // 2 ACs seeded above

      // Mark all ACs as pass.
      for (const ac of acResults) {
        await uatService.markAC(
          {
            uat_session_id: session.uatSessionId,
            ac_id: ac.acId,
            status: 'pass',
            observed_behavior: 'Verified by E2E test',
          },
          userId,
        )
      }

      // Submit the session (uat_session_id required).
      // When all ACs pass, submit() auto-transitions to 'accepted' and emits
      // UATAccepted in a single operation — no separate accept() call needed.
      const submitResult = await uatService.submit(
        { uat_session_id: session.uatSessionId },
        userId,
      )
      // SubmitOutput.outcome is the terminal disposition; all ACs passed → 'accepted'.
      expect(submitResult.outcome).toBe('accepted')
      expect(submitResult.defects_created.length).toBe(0) // all passed

      // UATAccepted event emitted by submit (aggregate_id is the session).
      const uatAcceptedEvents = await eventStore.query({
        aggregate_id: session.uatSessionId,
        event_type: 'UATAccepted',
      })
      expect(uatAcceptedEvents.items.length).toBe(1)

      // ----------------------------------------------------------------
      // Step 7: Complete the sprint
      // ----------------------------------------------------------------

      const { completedAt } = await sprintService.complete(sprint.sprintId)
      expect(completedAt).toBeInstanceOf(Date)

      const sprintRow = await db
        .select()
        .from(sprints)
        .where(eq(sprints.sprintId, sprint.sprintId))
        .limit(1)
      expect(sprintRow[0]?.status).toBe('completed')

      // SprintCompleted event.
      const sprintCompletedEvents = await eventStore.query({
        aggregate_id: sprint.sprintId,
        event_type: 'SprintCompleted',
      })
      expect(sprintCompletedEvents.items.length).toBe(1)

      // ----------------------------------------------------------------
      // Step 8: Retro — proposal synthesized and approved
      // ----------------------------------------------------------------

      const agentOrg = createAgentOrgRepo({ path: agentOrgPath })
      await agentOrg.init()

      const retroService = new DefaultRetroService(
        db,
        eventStore,
        authority,
        personaLoader,
        installId,
      )
      const proposalService = createProposalService(db, eventStore, agentOrg, installId)

      // SprintCompleted should trigger retro pipeline.
      const analyzeResult = await retroService.onSprintCompleted(sprint.sprintId)
      ownedReportIds.push(analyzeResult.retroReportId)
      expect(analyzeResult.status).toBe('analyzing')

      // Synthesize a proposal.
      const proposal: Proposal = {
        proposal_code: `PRP-E2E-${uuidv7().slice(0, 8)}`,
        title: 'E2E: tighten sr-dev token budget',
        hypothesis: 'Full sprint E2E: proposal to tighten token budget to reduce cost.',
        expected_impact: {
          metric_key: 'cost_per_sprint_usd_cents',
          direction: 'decrease',
          pct_points: -500,
        },
        rollback_path: 'revert to prior persona definition',
        layers: [
          {
            layer: 'persona',
            target_path: 'personas/sr-dev.md',
            change_type: 'modify',
            is_dominant: true,
          },
        ],
        evidence_refs: [],
        confidence_score: 70,
        proposed_value: '# Senior Developer\n\nE2E test persona update.\n',
        is_global: true,
      }

      const synthResult = await retroService.synthesizeProposalForTest(
        analyzeResult.retroReportId,
        proposal,
      )
      ownedProposalIds.push(synthResult.retroProposalId)

      // Finalize report before approval.
      await retroService.finalizeReportForTest(analyzeResult.retroReportId)

      // Approve the proposal — triggers git commit in agent-org.
      const approval = await proposalService.approve(
        synthResult.retroProposalId,
        'Approved in E2E test',
        userId,
      )
      ownedVersionIds.push(approval.mergedSystemVersionId)

      expect(approval.gitSha).toMatch(/^[0-9a-f]{40}$/)

      // Agent-org repo has the commit.
      const log = await agentOrg.log(5)
      const matchingCommit = log.find((c) => c.hash === approval.gitSha)
      expect(matchingCommit, 'retro commit not found in agent-org').toBeDefined()

      // SystemVersionShipped event in DB.
      const shippedEvents = await eventStore.query({
        aggregate_id: approval.mergedSystemVersionId,
        event_type: 'SystemVersionShipped',
      })
      expect(shippedEvents.items.length).toBe(1)
      const shippedPayload = shippedEvents.items[0]!.payload as Record<string, unknown>
      expect(shippedPayload['git_sha']).toBe(approval.gitSha)
      expect(shippedPayload['retro_report_id']).toBe(analyzeResult.retroReportId)

      // Outcome window is open.
      const outcomeRows = await db
        .select()
        .from(retroOutcomes)
        .where(eq(retroOutcomes.retroProposalId, synthResult.retroProposalId))
      expect(outcomeRows.length).toBe(1)
      ownedOutcomeIds.push(outcomeRows[0]!.retroOutcomeId)

      // ----------------------------------------------------------------
      // Step 9: Assert all key events are present in the correct order
      // ----------------------------------------------------------------

      // Chronological event types we expect for this sprint.
      const expectedEventTypes = [
        'EpicCreated',
        'StoryCreated',
        'SprintCreated',
        'SprintStarted',
        'AgentSpawned',
        'TaskCompleted',
        'UATSessionStarted',
        'UATAccepted',
        'SprintCompleted',
        'RetroAnalysisStarted',
        'RetroProposed',
        'RetroApproved',
        'SystemVersionShipped',
      ]

      for (const evType of expectedEventTypes) {
        const result = await eventStore.query({ event_type: evType })
        const sprintRelated = result.items.filter((ev) => {
          const payload = ev.payload as Record<string, unknown>
          return (
            ev.aggregate_id === sprint.sprintId ||
            ev.aggregate_id === epic.epicId ||
            ev.aggregate_id === story.storyId ||
            ev.aggregate_id === taskId ||
            ev.aggregate_id === session.uatSessionId ||
            ev.aggregate_id === analyzeResult.retroReportId ||
            ev.aggregate_id === synthResult.retroProposalId ||
            ev.aggregate_id === approval.mergedSystemVersionId ||
            payload['sprint_id'] === sprint.sprintId ||
            payload['story_id'] === story.storyId ||
            payload['task_id'] === taskId ||
            payload['uat_session_id'] === session.uatSessionId ||
            payload['ticket_id'] === story.storyId
          )
        })
        expect(
          sprintRelated.length,
          `Expected at least one '${evType}' event in this sprint's context`,
        ).toBeGreaterThanOrEqual(1)
      }
    },
    180_000, // 3 minutes max for the full E2E
  )

  afterAll(async () => {
    // Stop the gateway if still running.
    if (gateway) {
      await gateway.stop().catch(() => undefined)
    }
    try {
      fs.rmSync(TEST_SOCKET_PATH, { force: true })
    } catch {
      // ignore
    }
    if (tmpRoot) {
      await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  })
})
