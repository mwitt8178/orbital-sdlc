/**
 * backlog/sprint-service.ts — SprintService.
 *
 * Per TRD-02 v0.2 §6.1, §7.2 (sprint state machine), §10 (multi-sprint).
 *
 * Responsibilities:
 *   - create(params)               → inserts a sprint in 'planning'
 *   - createCommitment(params)     → writes the sprint_commitments row, transitions sprint to 'ready'
 *   - start(sprintId)              → transitions ready → active, builds DAG from
 *                                    sprint_commitments + tasks + task_dependencies,
 *                                    calls Scheduler.addSprint, emits SprintStarted
 *   - pause(sprintId)              → delegates to PauseController.pause; transitions active → paused
 *   - resume(sprintId)             → delegates to PauseController.resume; transitions paused → active
 *   - complete(sprintId)           → transitions active|completing → completed; calls Scheduler.removeSprint
 *
 * The BlockerService-onRoute callback is rebound at start() and unbound at
 * complete()/pause()-handle-resume cycle. Resolver tasks created via the
 * callback insert real `tasks` rows so the existing Scheduler.tick() loop
 * picks them up.
 */
import { type Actor } from '@orbital/types';
import type { DB } from '@orbital/db';
import type { EventStore } from '../events/store.js';
import type { Scheduler } from '../../../orchestrator/src/orchestration/scheduler.js';
import type { PauseController } from '../../../orchestrator/src/orchestration/pause.js';
import type { BlockerService } from '../comms/blockers.js';
import { type SprintRow, type SprintStatus, type SprintPriorityClass } from '@orbital/db';
import { type CreateSprintInput, type SprintCommitmentInput } from './types.js';
export interface SprintService {
    create(params: CreateSprintInput, actor?: Actor, tenantId?: string): Promise<SprintRow>;
    createCommitment(input: SprintCommitmentInput, actor?: Actor, tenantId?: string): Promise<void>;
    start(sprintId: string, actor?: Actor, tenantId?: string): Promise<{
        sprintId: string;
        startedAt: Date;
    }>;
    pause(sprintId: string, reason: string, actor?: Actor, tenantId?: string): Promise<{
        pausedAt: Date;
    }>;
    resume(sprintId: string, actor?: Actor, tenantId?: string): Promise<{
        resumedAt: Date;
    }>;
    complete(sprintId: string, actor?: Actor, tenantId?: string): Promise<{
        completedAt: Date;
    }>;
    list(filter?: {
        status?: SprintStatus;
    }, tenantId?: string): Promise<SprintRow[]>;
    get(sprintId: string, tenantId?: string): Promise<SprintRow | null>;
}
export interface SprintServiceOptions {
    /** Default install ceiling on max simultaneously active+paused sprints. */
    maxActiveSprints?: number;
    /** Optional BlockerService to wire Scheduler-aware resolver task creation. */
    blockerService?: BlockerService;
}
export declare class DefaultSprintService implements SprintService {
    private readonly db;
    private readonly eventStore;
    private readonly scheduler;
    private readonly pauseController;
    private readonly maxActiveSprints;
    private readonly blockerService?;
    private routeCallbackInstalled;
    constructor(db: DB, eventStore: EventStore, scheduler: Scheduler, pauseController: PauseController, options?: SprintServiceOptions);
    create(params: CreateSprintInput, actor?: Actor, tenantId?: string): Promise<SprintRow>;
    createCommitment(input: SprintCommitmentInput, actor?: Actor, tenantId?: string): Promise<void>;
    start(sprintId: string, actor?: Actor, tenantId?: string): Promise<{
        sprintId: string;
        startedAt: Date;
    }>;
    pause(sprintId: string, reason: string, actor?: Actor, tenantId?: string): Promise<{
        pausedAt: Date;
    }>;
    resume(sprintId: string, actor?: Actor, tenantId?: string): Promise<{
        resumedAt: Date;
    }>;
    complete(sprintId: string, actor?: Actor, tenantId?: string): Promise<{
        completedAt: Date;
    }>;
    list(filter?: {
        status?: SprintStatus;
    }, tenantId?: string): Promise<SprintRow[]>;
    get(sprintId: string, tenantId?: string): Promise<SprintRow | null>;
    private installRouteCallback;
    private uninstallRouteCallback;
}
/**
 * Map a TRD-02 priority class to the 1..5 scheduler priority weight.
 */
export declare function priorityClassToWeight(cls: SprintPriorityClass): 1 | 2 | 3 | 4 | 5;
export declare function createSprintService(db: DB, eventStore: EventStore, scheduler: Scheduler, pauseController: PauseController, options?: SprintServiceOptions): SprintService;
//# sourceMappingURL=sprint-service.d.ts.map