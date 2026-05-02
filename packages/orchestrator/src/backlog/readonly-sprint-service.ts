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

import { eq } from 'drizzle-orm'
import { sprints, type SprintRow, type SprintStatus } from '../db/schema/backlog.js'
import type { DB } from '../db/client.js'
import type {
  CreateSprintInput,
  SprintCommitmentInput,
} from './types.js'
import type { Actor } from '@orbital/types'
import type { SprintService } from './sprint-service.js'

const NOT_AVAILABLE = 'STARTUP_ERROR: SprintService mutation not wired in this build'

export class ReadOnlySprintService implements SprintService {
  constructor(private readonly db: DB) {}

  async list(filter?: { status?: SprintStatus }): Promise<SprintRow[]> {
    if (filter?.status) {
      return await this.db.select().from(sprints).where(eq(sprints.status, filter.status))
    }
    return await this.db.select().from(sprints)
  }

  async get(sprintId: string): Promise<SprintRow | null> {
    const rows = await this.db.select().from(sprints).where(eq(sprints.sprintId, sprintId)).limit(1)
    return rows[0] ?? null
  }

  async create(_params: CreateSprintInput, _actor?: Actor): Promise<SprintRow> {
    throw new Error(NOT_AVAILABLE)
  }
  async createCommitment(_input: SprintCommitmentInput, _actor?: Actor): Promise<void> {
    throw new Error(NOT_AVAILABLE)
  }
  async start(_sprintId: string, _actor?: Actor): Promise<{ sprintId: string; startedAt: Date }> {
    throw new Error(NOT_AVAILABLE)
  }
  async pause(_sprintId: string, _reason: string, _actor?: Actor): Promise<{ pausedAt: Date }> {
    throw new Error(NOT_AVAILABLE)
  }
  async resume(_sprintId: string, _actor?: Actor): Promise<{ resumedAt: Date }> {
    throw new Error(NOT_AVAILABLE)
  }
  async complete(_sprintId: string, _actor?: Actor): Promise<{ completedAt: Date }> {
    throw new Error(NOT_AVAILABLE)
  }
}

export function createReadOnlySprintService(db: DB): SprintService {
  return new ReadOnlySprintService(db)
}
