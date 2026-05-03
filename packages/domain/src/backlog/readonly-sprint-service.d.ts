/**
 * backlog/readonly-sprint-service.ts — minimal SprintService adapter for the
 * Phase 7 UI surface.
 *
 * The full DefaultSprintService requires Scheduler + PauseController +
 * BlockerService graph that is non-trivial to assemble at boot. The UI only
 * needs sprint.list and sprint.get for the Dashboard and TopBar pill; mutations
 * (start/pause/resume/complete/create/createCommitment) are out of UI scope
 * for v1 and would require the full DI graph.
 *
 * This service implements the SprintService interface read paths only, and
 * throws OrbitalError on any mutation — surfacing as a tRPC INTERNAL error to
 * the UI rather than silently no-opping. This is consistent with the
 * "STARTUP_ERROR: SprintService not registered" sentinel previously emitted
 * by the appRouter Proxy fallback.
 */
import { type SprintRow, type SprintStatus } from '@orbital/db';
import type { DB } from '@orbital/db';
import type { CreateSprintInput, SprintCommitmentInput } from './types.js';
import type { Actor } from '@orbital/types';
import type { SprintService } from './sprint-service.js';
export declare class ReadOnlySprintService implements SprintService {
    private readonly db;
    constructor(db: DB);
    list(filter?: {
        status?: SprintStatus;
    }): Promise<SprintRow[]>;
    get(sprintId: string): Promise<SprintRow | null>;
    create(_params: CreateSprintInput, _actor?: Actor): Promise<SprintRow>;
    createCommitment(_input: SprintCommitmentInput, _actor?: Actor): Promise<void>;
    start(_sprintId: string, _actor?: Actor): Promise<{
        sprintId: string;
        startedAt: Date;
    }>;
    pause(_sprintId: string, _reason: string, _actor?: Actor): Promise<{
        pausedAt: Date;
    }>;
    resume(_sprintId: string, _actor?: Actor): Promise<{
        resumedAt: Date;
    }>;
    complete(_sprintId: string, _actor?: Actor): Promise<{
        completedAt: Date;
    }>;
}
export declare function createReadOnlySprintService(db: DB): SprintService;
//# sourceMappingURL=readonly-sprint-service.d.ts.map