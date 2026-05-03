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
import { eq } from 'drizzle-orm';
import { sprints } from '@orbital/db';
const NOT_AVAILABLE = 'STARTUP_ERROR: SprintService mutation not wired in this build';
export class ReadOnlySprintService {
    db;
    constructor(db) {
        this.db = db;
    }
    async list(filter) {
        if (filter?.status) {
            return await this.db.select().from(sprints).where(eq(sprints.status, filter.status));
        }
        return await this.db.select().from(sprints);
    }
    async get(sprintId) {
        const rows = await this.db.select().from(sprints).where(eq(sprints.sprintId, sprintId)).limit(1);
        return rows[0] ?? null;
    }
    async create(_params, _actor) {
        throw new Error(NOT_AVAILABLE);
    }
    async createCommitment(_input, _actor) {
        throw new Error(NOT_AVAILABLE);
    }
    async start(_sprintId, _actor) {
        throw new Error(NOT_AVAILABLE);
    }
    async pause(_sprintId, _reason, _actor) {
        throw new Error(NOT_AVAILABLE);
    }
    async resume(_sprintId, _actor) {
        throw new Error(NOT_AVAILABLE);
    }
    async complete(_sprintId, _actor) {
        throw new Error(NOT_AVAILABLE);
    }
}
export function createReadOnlySprintService(db) {
    return new ReadOnlySprintService(db);
}
//# sourceMappingURL=readonly-sprint-service.js.map