/**
 * worker-tables.ts — Drizzle schema for agent_workers and worker_heartbeats.
 *
 * Owned by Phase 2B (MCP Gateway). Phase 2C will own tasks, task_dependencies,
 * retry_attempts, escalations, and worktrees in a separate orchestration.ts file.
 *
 * Per TRD-04 §4.4 — agent worker pool tables.
 */

import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  index,
} from 'drizzle-orm/pg-core'

// ---------------------------------------------------------------------------
// agent_workers — one row per spawned worker process
// ---------------------------------------------------------------------------

export const agentWorkers = pgTable(
  'agent_workers',
  {
    /** SessionId — UUIDv7, matches session_id in the capability bundle. */
    workerId: uuid('worker_id').primaryKey(),
    /** PersonaId — references personas table (owned by Phase 2A). */
    personaId: text('persona_id').notNull(),
    /**
     * SessionId from the capability bundle. Redundant with workerId but
     * kept for explicit join with capability_grants.session_id.
     */
    sessionId: uuid('session_id').notNull(),
    /**
     * Task being executed. Nullable because a worker can be in
     * 'connecting' state before a task is assigned. Phase 2C will add
     * the FK constraint once tasks table exists.
     */
    taskId: uuid('task_id'),
    /** Worker lifecycle state. */
    status: text('status', {
      enum: ['connecting', 'active', 'idle', 'terminating', 'terminated'],
    })
      .notNull()
      .default('connecting'),
    /** Timestamp when the worker was spawned. */
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    /** Last heartbeat received from the worker. Null until first heartbeat. */
    lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
    /**
     * The capability bundle ID issued to this worker.
     * References capability_grants.capability_id; no FK constraint to avoid
     * cross-schema FK complexity at this phase.
     */
    capabilityId: uuid('capability_id').notNull(),
    /** OS process ID of the spawned Claude Code child process. */
    pid: integer('pid'),
  },
  (t) => ({
    byTask: index('agent_workers_task_idx').on(t.taskId),
    byStatus: index('agent_workers_status_idx').on(t.status),
    byCapability: index('agent_workers_capability_idx').on(t.capabilityId),
  }),
)

export type AgentWorkerRow = typeof agentWorkers.$inferSelect
export type AgentWorkerInsert = typeof agentWorkers.$inferInsert

// ---------------------------------------------------------------------------
// worker_heartbeats — append-only heartbeat log per worker+task
// ---------------------------------------------------------------------------

export const workerHeartbeats = pgTable(
  'worker_heartbeats',
  {
    heartbeatId: uuid('heartbeat_id').primaryKey(),
    workerId: uuid('worker_id').notNull(),
    taskId: uuid('task_id'),
    /** Wall-clock time the heartbeat was received by the gateway. */
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    /** Current status reported by the worker. */
    status: text('status').notNull(),
    /** File paths touched since the last heartbeat (optional). */
    filesTouched: jsonb('files_touched').default([]),
  },
  (t) => ({
    byWorkerTime: index('hb_worker_time_idx').on(t.workerId, t.ts),
    byTask: index('hb_task_idx').on(t.taskId),
  }),
)

export type WorkerHeartbeatRow = typeof workerHeartbeats.$inferSelect
export type WorkerHeartbeatInsert = typeof workerHeartbeats.$inferInsert
