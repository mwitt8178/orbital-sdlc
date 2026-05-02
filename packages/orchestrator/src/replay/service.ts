/**
 * replay/service.ts — Public service API for the replay subsystem.
 *
 * [Engineer-Principal · Opus · run-round6-07-replay]
 *
 * This is the "front door" used by:
 *   - tRPC router (replay.ts)
 *   - Anthropic / tool driver call sites (which prefer to call captureLLM /
 *     captureTool here rather than reach into Recorder directly)
 *   - Tests (so they can construct one service object and exercise everything)
 *
 * Composition: a ReplayService bundles a Recorder + a Player + raw query
 * helpers over `replay_captures`. Construct once at boot via createReplayService.
 */

import { eq, desc, and, type SQL } from 'drizzle-orm'
import type { DB } from '../db/client.js'
import type { EventStore } from '../events/store.js'
import { Recorder, createRecorder } from './recorder.js'
import { Player, createPlayer, type LiveExecutor } from './player.js'
import { replayCaptures } from '../db/schema/replay.js'
import type {
  CaptureInput,
  CaptureRecord,
  ReplayMode,
  ReplayResult,
} from './types.js'
import type { ReplayStore } from './store.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReplayServiceDeps {
  db: DB
  eventStore: EventStore
  store: ReplayStore
  liveExecutor?: LiveExecutor
}

export interface ListFilter {
  workerId?: string
  taskId?: string
  eventId?: string
  limit?: number
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ReplayService {
  private readonly recorder: Recorder
  private readonly player: Player

  constructor(private readonly deps: ReplayServiceDeps) {
    this.recorder = createRecorder({
      db: deps.db,
      eventStore: deps.eventStore,
      store: deps.store,
    })
    const playerDeps: ConstructorParameters<typeof Player>[0] = {
      db: deps.db,
      eventStore: deps.eventStore,
      store: deps.store,
    }
    if (deps.liveExecutor !== undefined) {
      playerDeps.liveExecutor = deps.liveExecutor
    }
    this.player = createPlayer(playerDeps)
  }

  // -------------------------------------------------------------------------
  // Capture
  // -------------------------------------------------------------------------

  /** Generic capture entry. Most callers should use captureLLM / captureTool. */
  capture(input: CaptureInput): Promise<CaptureRecord> {
    return this.recorder.capture(input)
  }

  /** Capture an LLM request. Sets kind='llm_request'. */
  captureLLM(input: Omit<CaptureInput, 'kind'>): Promise<CaptureRecord> {
    return this.recorder.captureLLM(input)
  }

  /** Capture an MCP tool invocation. */
  captureTool(input: Omit<CaptureInput, 'kind' | 'provider' | 'model'>): Promise<CaptureRecord> {
    return this.recorder.captureTool(input)
  }

  /** Capture a hook invocation. */
  captureHook(input: Omit<CaptureInput, 'kind' | 'provider' | 'model'>): Promise<CaptureRecord> {
    return this.recorder.captureHook(input)
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  async getCapture(captureId: string): Promise<CaptureRecord | null> {
    const rows = await this.deps.db
      .select()
      .from(replayCaptures)
      .where(eq(replayCaptures.captureId, captureId))
      .limit(1)
    const row = rows[0]
    if (!row) return null
    return rowToRecord(row)
  }

  async list(filter: ListFilter): Promise<CaptureRecord[]> {
    const conditions: SQL[] = []
    if (filter.workerId) conditions.push(eq(replayCaptures.workerId, filter.workerId))
    if (filter.taskId) conditions.push(eq(replayCaptures.taskId, filter.taskId))
    if (filter.eventId) conditions.push(eq(replayCaptures.eventId, filter.eventId))

    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500)

    const baseQuery = this.deps.db
      .select()
      .from(replayCaptures)
      .orderBy(desc(replayCaptures.occurredAt))
      .limit(limit)

    const rows =
      conditions.length === 0
        ? await baseQuery
        : await baseQuery.where(conditions.length === 1 ? conditions[0]! : and(...conditions))

    return rows.map(rowToRecord)
  }

  /** True when at least one capture exists for the given event_id. */
  async hasCaptureForEvent(eventId: string): Promise<boolean> {
    const rows = await this.deps.db
      .select({ id: replayCaptures.captureId })
      .from(replayCaptures)
      .where(eq(replayCaptures.eventId, eventId))
      .limit(1)
    return rows.length > 0
  }

  // -------------------------------------------------------------------------
  // Replay
  // -------------------------------------------------------------------------

  replay(captureId: string, mode: ReplayMode): Promise<ReplayResult> {
    return this.player.replay(captureId, mode)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToRecord(row: typeof replayCaptures.$inferSelect): CaptureRecord {
  return {
    capture_id: row.captureId,
    occurred_at: row.occurredAt,
    worker_id: row.workerId,
    task_id: row.taskId,
    event_id: row.eventId,
    capture_kind: row.captureKind as CaptureRecord['capture_kind'],
    provider: row.provider,
    model: row.model,
    request_hash: row.requestHash,
    response_hash: row.responseHash,
    storage_uri: row.storageUri,
    size_bytes: row.sizeBytes,
  }
}

// ---------------------------------------------------------------------------
// Factory + module-scoped singleton (for trpc lazy resolve)
// ---------------------------------------------------------------------------

export function createReplayService(deps: ReplayServiceDeps): ReplayService {
  return new ReplayService(deps)
}

let _singleton: ReplayService | null = null

/** Boot wires the live ReplayService here so the tRPC router can lazily access it. */
export function registerReplayService(svc: ReplayService): void {
  _singleton = svc
}

/** Used by the tRPC router. Throws when no service has been registered. */
export function getReplayService(): ReplayService {
  if (!_singleton) {
    throw new Error(
      'STARTUP_ERROR: ReplayService not registered. boot.ts must call registerReplayService().',
    )
  }
  return _singleton
}

/** Test helper to clear the singleton between integration tests. */
export function resetReplayServiceForTest(): void {
  _singleton = null
}
