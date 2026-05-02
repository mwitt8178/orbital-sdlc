/**
 * replay.ts — Drizzle schema for the replay_captures table.
 *
 * [Engineer-Principal · Opus · run-round6-07-replay]
 *
 * Per Round 6 Task #7 (Determinism / Replay) architecture.md.
 *
 * Each row is metadata describing one capture (LLM request, tool call, or
 * hook invocation). The full request+response blob is stored at storage_uri
 * (filesystem v1; S3 later — abstracted via replay/store.ts). The
 * request_hash + response_hash columns are sha256 of the canonical JSON;
 * replay reads verify integrity by recomputing the hashes on the decrypted
 * blob.
 *
 * No physical FKs — DSQL constraints prohibit them. Logical relations:
 *   worker_id → orchestration.workers.worker_id
 *   task_id   → orchestration.tasks.task_id
 *   event_id  → audit.events.event_id (the audit event this capture "belongs to")
 */

import { pgTable, uuid, text, integer, index, timestamp } from 'drizzle-orm/pg-core'

export const replayCaptures = pgTable(
  'replay_captures',
  {
    captureId: uuid('capture_id').primaryKey(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    workerId: uuid('worker_id'),
    taskId: uuid('task_id'),
    /** The parent audit event this capture is attached to (e.g. LLMRequestCompleted). */
    eventId: uuid('event_id'),
    /** llm_request | tool_call | hook_invocation */
    captureKind: text('capture_kind').notNull(),
    /** 'anthropic' | 'openai' | 'bedrock' (only for llm_request) */
    provider: text('provider'),
    model: text('model'),
    /** sha256 of canonical request JSON */
    requestHash: text('request_hash').notNull(),
    /** sha256 of canonical response JSON */
    responseHash: text('response_hash').notNull(),
    /** file:///... or s3://... pointer to the encrypted blob. */
    storageUri: text('storage_uri').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    schemaVersion: integer('schema_version').notNull().default(1),
  },
  (t) => [
    index('rc_worker_idx').on(t.workerId, t.occurredAt),
    index('rc_task_idx').on(t.taskId, t.occurredAt),
    index('rc_event_idx').on(t.eventId),
    index('rc_capture_kind_idx').on(t.captureKind, t.occurredAt),
  ],
)

export type ReplayCaptureRow = typeof replayCaptures.$inferSelect
export type ReplayCaptureInsert = typeof replayCaptures.$inferInsert
