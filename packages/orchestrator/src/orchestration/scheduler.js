/**
 * scheduler.ts — Scheduler.
 *
 * Per TRD-04 v0.2 §7 and §8, and SAO §5.1.
 *
 * Responsibilities:
 *   - Track active sprints with priority weights.
 *   - On every tick(), compute the per-sprint share via weighted equal-share +
 *     deficit accumulation; pick the next sprint to allocate a slot to.
 *   - For each available worker slot, find the most-eligible feasible task in
 *     the picked sprint (FIFO by tasks.ordering then created_at). Feasibility:
 *       (1) state IN ('pending','ready') and blocking predecessors all 'done'
 *       (2) no file-conflict with any in-progress task's declaredWritePaths
 *       (3) sprint not paused; pool not paused
 *   - Once a task is selected: route → issue capability → create worktree →
 *     spawn worker → mark task in_progress → emit AgentSpawned (via spawn()).
 *
 * Public API matches the Scheduler interface declared in the brief:
 *
 *   interface Scheduler {
 *     addSprint(s, tasks): void
 *     removeSprint(sprintId): void
 *     tick(): Promise<void>
 *     pause(sprintId): Promise<void>
 *     resume(sprintId): Promise<void>
 *   }
 */
import { uuidv7 } from 'uuidv7';
import { eq, and, inArray, ne, sql as dSQL } from 'drizzle-orm';
import { tasks, taskDependencies, workerPoolState } from '../db/schema/orchestration.js';
import { agentWorkers } from '../db/schema/worker-tables.js';
// Round 7-02 — hub client for task list / claim when hub configured.
// [Engineer-Sr · Sonnet · run-round7-02-local-hub-split]
import { getHubClient } from '../hub-client/index.js';
import { loadEnv } from '../config/env.js';
import { resolvePersona } from './persona-lookup.js';
import { DEFAULT_RETRY_BUDGET, DEFAULT_TOKEN_BUDGET, DEFAULT_WALL_CLOCK_TIMEOUT_MS, } from './types.js';
import { computeReadySet } from './dag.js';
import { spawn } from './spawn.js';
import { logger } from '../config/logger.js';
const SYSTEM_ACTOR = { type: 'system', component: 'orchestrator' };
// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------
export class DefaultScheduler {
    db;
    eventStore;
    authority;
    personaLoader;
    routing;
    worktrees;
    monitor;
    pauseController;
    installId;
    maxWorkers;
    spawnExtraArgs;
    claudeBinOverride;
    mcpGatewayUrl;
    onSpawn;
    realClaude;
    // Round 6 #5 — Cost Governance
    // [Engineer-Sr · Sonnet · run-round6-05-cost-governance]
    costEnforcer;
    projectId;
    sprints = new Map();
    sprintDeficit = new Map();
    children = new Map();
    /**
     * Monotonic per-process tick counter. Used to emit SchedulerTick events at
     * a coarse cadence so downstream rules (e.g., the agent-native
     * CeremonyScheduler's code-conflict rule) can run on tick boundaries
     * without subscribing to wall-clock time.
     */
    tickSeq = 0;
    constructor(db, eventStore, authority, personaLoader, routing, worktrees, monitor, pauseController, installId, options = {}) {
        this.db = db;
        this.eventStore = eventStore;
        this.authority = authority;
        this.personaLoader = personaLoader;
        this.routing = routing;
        this.worktrees = worktrees;
        this.monitor = monitor;
        this.pauseController = pauseController;
        this.installId = installId;
        this.maxWorkers = options.maxWorkers ?? 8;
        this.spawnExtraArgs = options.spawnExtraArgs ?? [];
        if (options.claudeBinOverride !== undefined) {
            this.claudeBinOverride = options.claudeBinOverride;
        }
        if (options.mcpGatewayUrl !== undefined) {
            this.mcpGatewayUrl = options.mcpGatewayUrl;
        }
        if (options.onSpawn !== undefined) {
            this.onSpawn = options.onSpawn;
        }
        this.realClaude = options.realClaude ?? false;
        // Round 6 #5 — Cost Governance
        // [Engineer-Sr · Sonnet · run-round6-05-cost-governance]
        if (options.costEnforcer !== undefined) {
            this.costEnforcer = options.costEnforcer;
        }
        if (options.projectId !== undefined) {
            this.projectId = options.projectId;
        }
    }
    // -------------------------------------------------------------------------
    // addSprint / removeSprint
    // -------------------------------------------------------------------------
    addSprint(sprint, _tasks) {
        this.sprints.set(sprint.sprintId, sprint);
        if (!this.sprintDeficit.has(sprint.sprintId)) {
            this.sprintDeficit.set(sprint.sprintId, 0);
        }
    }
    removeSprint(sprintId) {
        this.sprints.delete(sprintId);
        this.sprintDeficit.delete(sprintId);
    }
    getDeficitFor(sprintId) {
        return this.sprintDeficit.get(sprintId) ?? 0;
    }
    // -------------------------------------------------------------------------
    // onEscalationRaised — Round 6 #9
    // -------------------------------------------------------------------------
    /**
     * Called by the boot EventStore subscription when EscalationRaised fires.
     * The post-escalation-raised hook already created the child task in state='ready',
     * so the scheduler's next tick() will pick it up automatically via the feasibility
     * query. This method logs the event for observability and ensures the sprint that
     * owns the source task is still tracked.
     *
     * Round 6 #9 — Inter-Agent Channel Collaboration
     * [Engineer-Sr · Sonnet · run-round6-09-channel-collab]
     */
    onEscalationRaised(payload) {
        logger.info({
            sourceTaskId: payload.source_task_id,
            sprintId: payload.sprint_id,
            targetPersonaHint: payload.target_persona_hint,
            raisedByPersona: payload.raised_by_persona,
            confidence: payload.confidence,
        }, 'scheduler.onEscalationRaised: EscalationRaised received; child task will be scheduled on next tick');
        // The child task is already in state='ready' (inserted by the hook).
        // No explicit addSprint call needed — the scheduler's tick() queries the DB
        // for all feasible tasks across active sprints; the child task row will appear
        // naturally on the next tick if the sprint is tracked.
        // If the sprint is not currently tracked (e.g., it finished), the escalation
        // child task stays in 'ready' state and will be picked up when the sprint
        // is re-added (or it will be handled by the EM / human).
    }
    // -------------------------------------------------------------------------
    // pause / resume — delegate to PauseController
    // -------------------------------------------------------------------------
    async pause(sprintId) {
        await this.pauseController.pause(sprintId, uuidv7());
    }
    async resume(sprintId) {
        await this.pauseController.resume(sprintId, uuidv7());
    }
    // -------------------------------------------------------------------------
    // tick — main scheduler loop
    // -------------------------------------------------------------------------
    async tick() {
        // Honor global pause flag.
        const poolRows = await this.db.select().from(workerPoolState).limit(1);
        const pool = poolRows[0];
        if (pool?.paused)
            return;
        // Compute available slots.
        const activeWorkerCount = await this.countActiveWorkers();
        let availableSlots = this.maxWorkers - activeWorkerCount;
        // Emit SchedulerTick for state-driven downstream consumers (e.g., the
        // CeremonyScheduler's code-conflict rule). Best-effort; never blocks the
        // tick loop. We emit before the early-return on no-slots so consumers can
        // observe steady-state ticks too.
        this.tickSeq += 1;
        try {
            const appendResult = this.eventStore.append({
                aggregate_id: this.installId,
                aggregate_type: 'orchestration',
                event_type: 'SchedulerTick',
                payload: {
                    tick_seq: this.tickSeq,
                    active_sprint_count: this.sprints.size,
                    active_worker_count: activeWorkerCount,
                    available_slots: Math.max(0, availableSlots),
                },
                actor: SYSTEM_ACTOR,
                trace_id: uuidv7(),
                occurred_at: new Date().toISOString(),
                schema_version: 1,
            });
            // Test stubs may return undefined / non-promise; guard with Promise.resolve.
            void Promise.resolve(appendResult).catch((err) => {
                logger.warn({ err, tickSeq: this.tickSeq }, 'Scheduler.tick: SchedulerTick emit failed');
            });
        }
        catch (err) {
            logger.warn({ err, tickSeq: this.tickSeq }, 'Scheduler.tick: SchedulerTick emit threw synchronously');
        }
        if (availableSlots <= 0)
            return;
        while (availableSlots > 0) {
            const sprintId = this.pickSprint();
            if (!sprintId)
                break;
            const task = await this.pickFeasibleTask(sprintId);
            if (!task) {
                // No feasible task in this sprint; the deficit was already accumulated.
                // Try to spend remaining slots on another sprint.
                const others = [...this.sprints.keys()].filter((s) => s !== sprintId);
                if (others.length === 0)
                    break;
                const altTask = await this.pickFeasibleTaskAcross(others);
                if (!altTask)
                    break;
                await this.allocateSlot(altTask.sprintId, altTask);
                availableSlots--;
                continue;
            }
            await this.allocateSlot(sprintId, task);
            availableSlots--;
        }
    }
    // -------------------------------------------------------------------------
    // pickSprint — weighted equal-share with deficit accumulation
    // -------------------------------------------------------------------------
    pickSprint() {
        if (this.sprints.size === 0)
            return null;
        const active = [...this.sprints.values()];
        if (active.length === 0)
            return null;
        const totalPriority = active.reduce((sum, s) => sum + s.priority, 0);
        if (totalPriority <= 0)
            return null;
        let bestId = null;
        let bestScore = Number.NEGATIVE_INFINITY;
        for (const s of active) {
            const share = s.priority / totalPriority;
            const deficit = this.sprintDeficit.get(s.sprintId) ?? 0;
            const score = deficit + share;
            if (score > bestScore) {
                bestScore = score;
                bestId = s.sprintId;
            }
        }
        if (!bestId)
            return null;
        // Update deficits: chosen sprint pays 1 - share; others gain share.
        for (const s of active) {
            const share = s.priority / totalPriority;
            const current = this.sprintDeficit.get(s.sprintId) ?? 0;
            if (s.sprintId === bestId) {
                this.sprintDeficit.set(s.sprintId, current + share - 1);
            }
            else {
                this.sprintDeficit.set(s.sprintId, current + share);
            }
        }
        return bestId;
    }
    // -------------------------------------------------------------------------
    // pickFeasibleTask — for a given sprint
    // Round 7-02: reads ready tasks from hub when in local-with-hub mode.
    // [Engineer-Sr · Sonnet · run-round7-02-local-hub-split]
    // -------------------------------------------------------------------------
    async pickFeasibleTask(sprintId) {
        const hubClient = getHubClient();
        const env = loadEnv();
        let sprintTasks;
        if (hubClient !== null) {
            // Hub mode: read ready tasks from hub for this sprint.
            const result = await hubClient.tasks.list(env.ORBITAL_HUB_TENANT_ID, sprintId);
            if (!result.ok) {
                logger.warn({ sprintId, hubError: result.message }, 'scheduler: hub task list failed; falling back to local');
                // Fall through to local DB.
                sprintTasks = await this.db
                    .select()
                    .from(tasks)
                    .where(and(eq(tasks.sprintId, sprintId), inArray(tasks.state, ['pending', 'ready', 'in_progress', 'in_review', 'blocked'])));
            }
            else {
                sprintTasks = result.data
                    .filter((t) => ['pending', 'ready', 'in_progress', 'in_review', 'blocked'].includes(t.state))
                    .map((t) => ({
                    taskId: t.task_id,
                    sprintId: t.sprint_id ?? sprintId,
                    title: t.title,
                    description: t.description ?? null,
                    state: t.state,
                    ordering: t.ordering ?? 0,
                    personaId: t.persona_id ?? 'default',
                    riskClass: (t.risk_class ?? 'standard'),
                    attemptCount: t.attempt_count ?? 0,
                    retryBudget: t.retry_budget ?? 3,
                    wallClockTimeoutMs: t.wall_clock_timeout_ms ?? 3_600_000,
                    tokenBudget: t.token_budget ?? 100_000,
                    declaredWritePaths: t.declared_write_paths ?? [],
                    createdAt: new Date(t.created_at),
                    updatedAt: new Date(t.updated_at),
                    tenantId: t.tenant_id,
                    tokensConsumed: 0,
                    linkedArtifacts: [],
                    iterationCount: 0,
                    lastDefectId: null,
                    escalationCount: 0,
                    parentTaskId: null,
                    currentWorkerId: null,
                    currentCapabilityId: null,
                    currentRoutingDecisionId: null,
                    currentWorktreeId: null,
                    githubPrNumber: null,
                    githubPrUrl: null,
                    githubPrMergedAt: null,
                    githubHeadSha: null,
                    githubPrState: null,
                    codeReviewState: null,
                    startedAt: null,
                    completedAt: null,
                    createdByEventId: t.task_id,
                    ticketId: null,
                    storyId: null,
                    estimatedDurationMs: null,
                }));
            }
        }
        else {
            // Local mode: load all tasks in the sprint that are not terminal.
            sprintTasks = await this.db
                .select()
                .from(tasks)
                .where(and(eq(tasks.sprintId, sprintId), inArray(tasks.state, ['pending', 'ready', 'in_progress', 'in_review', 'blocked'])));
        }
        if (sprintTasks.length === 0)
            return null;
        // Load dependencies relevant to this sprint.
        const taskIds = sprintTasks.map((t) => t.taskId);
        const deps = await this.db
            .select()
            .from(taskDependencies)
            .where(inArray(taskDependencies.successorTaskId, taskIds));
        // Compute ready-set (using dag.computeReadySet for a clean source of truth).
        const ready = new Set(computeReadySet(sprintTasks.map((t) => ({ taskId: t.taskId, state: t.state })), deps.map((d) => ({
            predecessorTaskId: d.predecessorTaskId,
            successorTaskId: d.successorTaskId,
            blocking: d.blocking,
        }))));
        // Build the BUSY path set from in-progress tasks (this sprint and others).
        const busy = await this.collectBusyPaths();
        // Among ready tasks, pick the FIFO winner (by ordering ASC, createdAt ASC) that has no file conflict.
        const candidates = sprintTasks
            .filter((t) => ready.has(t.taskId))
            .sort((a, b) => {
            const aOrd = a.ordering ?? Number.MAX_SAFE_INTEGER;
            const bOrd = b.ordering ?? Number.MAX_SAFE_INTEGER;
            if (aOrd !== bOrd)
                return aOrd - bOrd;
            return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        });
        for (const c of candidates) {
            if (this.worktrees.conflict(c.declaredWritePaths, busy))
                continue;
            return c;
        }
        return null;
    }
    async pickFeasibleTaskAcross(sprintIds) {
        for (const sid of sprintIds) {
            const t = await this.pickFeasibleTask(sid);
            if (t)
                return t;
        }
        return null;
    }
    // -------------------------------------------------------------------------
    // allocateSlot — route, issue capability, create worktree, spawn
    // -------------------------------------------------------------------------
    async allocateSlot(sprintId, task) {
        const traceId = uuidv7();
        try {
            // Round 6 #5 — Cost Governance: check budget BEFORE spawning.
            // [Engineer-Sr · Sonnet · run-round6-05-cost-governance]
            if (this.costEnforcer && this.projectId) {
                const enforcerResult = await this.costEnforcer.canSpawn({
                    projectId: this.projectId,
                    sprintId,
                    taskId: task.taskId,
                });
                if (!enforcerResult.allow) {
                    logger.warn({
                        taskId: task.taskId,
                        sprintId,
                        projectId: this.projectId,
                        runningCostUsd: enforcerResult.runningCostUsd,
                        hardCapUsd: enforcerResult.hardCapUsd,
                    }, 'Scheduler.allocateSlot: costEnforcer.canSpawn denied — skipping spawn');
                    // Pause the sprint scope due to cost ceiling.
                    await this.pauseController.pauseDueToCostCeiling('sprint', sprintId, enforcerResult.reason ?? 'budget_exceeded').catch((err) => {
                        logger.warn({ err }, 'Scheduler.allocateSlot: pauseDueToCostCeiling failed (non-fatal)');
                    });
                    return;
                }
                if (enforcerResult.warn) {
                    logger.warn({
                        taskId: task.taskId,
                        sprintId,
                        runningCostUsd: enforcerResult.runningCostUsd,
                        hardCapUsd: enforcerResult.hardCapUsd,
                    }, 'Scheduler.allocateSlot: cost soft threshold exceeded (continuing)');
                }
            }
            // 1. routing (legacy per-risk-class decision + new multi-provider routeModel)
            const decision = await this.routing.selectModel({
                task_id: task.taskId,
                persona_id: task.personaId,
                risk_class: task.riskClass,
                retry_depth: task.attemptCount,
                trace_id: traceId,
            });
            // routeModel: multi-provider routing decision (Round 6 #8).
            // Estimate is derived from risk_class as a coarse mapping; a future
            // enhancement can store explicit S/M/L/XL on the task row.
            const estimateFromRisk = {
                low: 'S',
                standard: 'M',
                high: 'L',
                critical: 'XL',
            };
            const estimate = estimateFromRisk[task.riskClass] ?? 'M';
            await this.routing.routeModel({
                persona: task.personaId,
                estimate,
                traceId,
            });
            // 2. resolve persona for capability scope template (accept slug or UUID)
            const persona = await resolvePersona(this.db, this.personaLoader, task.personaId);
            const profile = persona.defaultCapabilityProfile;
            // 3. issue capability
            const sessionId = uuidv7();
            const issueResult = await this.authority.issue({
                install_id: this.installId,
                persona_id: task.personaId,
                task_id: task.taskId,
                sprint_id: sprintId,
                session_id: sessionId,
                scopes: {
                    files_read: profile.filesRead,
                    files_write: profile.filesWrite,
                    board_read: profile.boardRead,
                    board_mutate: profile.boardMutate,
                    channel_read: profile.channelRead,
                    channel_post: profile.channelPost,
                    secrets: profile.secrets,
                    network_egress: profile.networkEgress,
                    spawn_subagent: profile.spawnSubagent,
                    git_commit: profile.gitCommit
                        ? [{ branch: profile.gitCommit.branchPattern, paths: [profile.gitCommit.pathGlob] }]
                        : [],
                    ceremony_role: profile.ceremonyRole === 'none' ? [] : [profile.ceremonyRole],
                },
                ttl_ms: 30 * 60 * 1000,
                justification: `Scheduler allocating slot for task ${task.taskId} (sprint ${sprintId})`,
                actor: SYSTEM_ACTOR,
                trace_id: traceId,
            });
            // 4. create worktree
            const branchName = `task/${task.taskId}`;
            const wt = await this.worktrees.create({
                taskId: task.taskId,
                branchName,
                parentBranch: 'main',
                declaredWritePaths: task.declaredWritePaths,
            });
            // 5. mark task in_progress, link worker/capability/decision/worktree
            await this.db
                .update(tasks)
                .set({
                state: 'in_progress',
                startedAt: new Date(),
                currentWorkerId: sessionId,
                currentCapabilityId: issueResult.capability_id,
                currentRoutingDecisionId: decision.decision_id,
                currentWorktreeId: wt.worktreeId,
            })
                .where(eq(tasks.taskId, task.taskId));
            // 6. spawn (real-claude or test-surrogate path)
            let realClaudeContext;
            if (this.realClaude) {
                // Build the persona brief from the task and capability.
                // Include memory context so the brief contains relevant project memory.
                // [Engineer-Sr · Sonnet · run-memory-prompt-assembly]
                const briefTask = {
                    task_id: task.taskId,
                    title: task.title,
                    description: task.description,
                    acceptance_criteria: task.acceptanceCriteria ?? [],
                    risk_class: task.riskClass,
                };
                const { buildBrief } = await import('../personas/brief.js');
                // Build memoryContext when projectId is available.
                // projectId comes from scheduler options (per-install active project).
                // tenantId comes from the task row (multi-tenant scoped).
                const memoryContext = this.projectId
                    ? {
                        db: this.db,
                        eventStore: this.eventStore,
                        projectId: this.projectId,
                        tenantId: task.tenantId ?? undefined,
                        personaSlug: task.personaId,
                    }
                    : undefined;
                const brief = await buildBrief(persona, briefTask, issueResult.bundle, {
                    memoryContext,
                });
                realClaudeContext = {
                    persona,
                    task: briefTask,
                    brief,
                };
            }
            const spawnResult = await spawn({
                taskId: task.taskId,
                personaId: task.personaId,
                personaDisplayName: persona.displayName,
                capability: issueResult.bundle,
                worktreePath: wt.path,
                traceId,
                model: decision.model,
                tokenBudget: decision.token_budget,
                extraArgs: this.spawnExtraArgs,
                ...(this.claudeBinOverride !== undefined && { claudeBinOverride: this.claudeBinOverride }),
                ...(this.mcpGatewayUrl !== undefined && { mcpGatewayUrl: this.mcpGatewayUrl }),
                ...(realClaudeContext !== undefined && { realClaude: realClaudeContext }),
            }, this.db, this.eventStore);
            // 7. track child for monitor.
            this.monitor.track(spawnResult.workerId, spawnResult.child);
            this.children.set(spawnResult.workerId, spawnResult.child);
            // 8. Post-run lesson extraction — fires after the worker exits.
            // Only runs in real-claude mode (no-op for test surrogates).
            // Non-blocking: errors are logged, never surface to the tick loop.
            // [Engineer-Sr · Sonnet · run-memory-prompt-assembly]
            if (this.realClaude && this.projectId) {
                const capturedTaskId = task.taskId;
                const capturedPersonaId = task.personaId;
                const capturedTitle = task.title;
                const capturedDescription = task.description;
                const capturedTenantId = task.tenantId ?? '00000000-0000-0000-0000-000000000000';
                const capturedProjectId = this.projectId;
                const capturedOutputStream = spawnResult.outputStream;
                void spawnResult.exited.then(async () => {
                    try {
                        const { extractAndStoreLessons } = await import('../memory/lesson-extractor.js');
                        const { loadEnv } = await import('../config/env.js');
                        const env = loadEnv();
                        // Collect worker output from the ring buffer.
                        const outputLines = capturedOutputStream
                            ? capturedOutputStream.getRecentLines(500).map((l) => l.line).join('\n')
                            : '';
                        if (outputLines.length === 0) {
                            logger.debug({ taskId: capturedTaskId }, 'scheduler: no worker output for lesson extraction, skipping');
                            return;
                        }
                        const written = await extractAndStoreLessons({
                            tenantId: capturedTenantId,
                            projectId: capturedProjectId,
                            taskId: capturedTaskId,
                            personaSlug: capturedPersonaId,
                            taskTitle: capturedTitle,
                            taskDescription: capturedDescription ?? '',
                            workerOutput: outputLines,
                            db: this.db,
                            eventStore: this.eventStore,
                            anthropicApiKey: env.ANTHROPIC_API_KEY,
                        });
                        logger.info({ taskId: capturedTaskId, personaSlug: capturedPersonaId, written }, 'scheduler: post-run lesson extraction complete');
                    }
                    catch (err) {
                        logger.warn({ err, taskId: capturedTaskId }, 'scheduler: post-run lesson extraction failed (non-fatal)');
                    }
                });
            }
            this.onSpawn?.(spawnResult);
        }
        catch (err) {
            logger.error({ err, taskId: task.taskId, sprintId }, 'Scheduler.allocateSlot failed; task will remain in current state');
            throw err;
        }
    }
    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------
    async countActiveWorkers() {
        const rows = await this.db
            .select()
            .from(agentWorkers)
            .where(and(ne(agentWorkers.status, 'terminated'), ne(agentWorkers.status, 'terminating')));
        return rows.length;
    }
    /**
     * Collect declared_write_paths from in-progress tasks whose worker is still
     * alive (status != terminated/terminating). This narrows the BUSY set to
     * tasks that actually have a running agent — orphan in_progress rows from
     * crashed prior runs (or test pollution) are correctly ignored.
     *
     * Returns a flat array of glob patterns; the caller passes this to
     * worktrees.conflict().
     */
    async collectBusyPaths() {
        // SELECT distinct task_id of in-progress tasks whose worker row is active.
        const rows = await this.db.execute(dSQL `
      SELECT t.task_id,
             t.declared_write_paths,
             t.linked_artifacts
      FROM tasks t
      INNER JOIN agent_workers aw ON aw.task_id = t.task_id
      WHERE t.state = 'in_progress'
        AND aw.status NOT IN ('terminated','terminating')
    `);
        const paths = [];
        for (const r of rows) {
            const declared = r.declared_write_paths ?? [];
            paths.push(...declared);
            const artifacts = r.linked_artifacts ?? [];
            for (const a of artifacts) {
                if (a.type === 'file' && typeof a.id === 'string')
                    paths.push(a.id);
            }
        }
        return paths;
    }
}
// ---------------------------------------------------------------------------
// Helper / utility for callers building tasks rows from scratch (Phase 4B)
// ---------------------------------------------------------------------------
export function defaultTaskInsertDefaults() {
    return {
        retryBudget: DEFAULT_RETRY_BUDGET,
        tokenBudget: DEFAULT_TOKEN_BUDGET,
        wallClockTimeoutMs: DEFAULT_WALL_CLOCK_TIMEOUT_MS,
    };
}
//# sourceMappingURL=scheduler.js.map