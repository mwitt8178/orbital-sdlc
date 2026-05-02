/**
 * memory/brief-injector.ts — Injects relevant project memory into a persona brief.
 *
 * [Engineer-Sr · Sonnet · run-round6-04-project-memory]
 *
 * Per Round 6 Task #4 architecture.md §"Brief injection":
 *   - Retrieves top-k entries via retrieveTopN()
 *   - Formats them as a markdown section
 *   - Emits MemoryRetrievedForBrief event with entry IDs
 *
 * This module is imported by personas/brief.ts.
 */

import { uuidv7 } from 'uuidv7'
import type { DB } from '../db/client.js'
import type { EventStore } from '../events/store.js'
import { retrieveTopN, type RetrievalQuery } from './retrieval.js'
import type { MemoryEntry } from './types.js'
import type { MemoryRetrievedForBriefPayload } from './types.js'
import { logger } from '../config/logger.js'

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface MemoryBriefInjection {
  /** Markdown section to append to the brief (empty string if no entries) */
  markdown: string
  /** Entry IDs that were included */
  entryIds: string[]
  /** Retrieval method used */
  method: 'vector' | 'tag_fallback' | 'none'
}

/**
 * Retrieve memory entries for a task brief and format them as markdown.
 * Emits MemoryRetrievedForBrief event.
 *
 * @param db         Drizzle DB
 * @param eventStore EventStore for audit
 * @param projectId  Project to scope retrieval to
 * @param taskId     Task being briefed (for event payload)
 * @param query      Title + description of the task
 * @param k          Number of entries to include (default: 8)
 */
export async function injectMemoryIntoBrief(
  db: DB,
  eventStore: EventStore,
  projectId: string,
  taskId: string,
  query: RetrievalQuery,
  k = 8,
): Promise<MemoryBriefInjection> {
  let entries: MemoryEntry[] = []
  let method: 'vector' | 'tag_fallback' | 'none' = 'none'

  try {
    const result = await retrieveTopN(db, projectId, query, k)
    entries = result.entries
    method = result.method
  } catch (err) {
    // Never fail brief generation because of memory retrieval errors
    logger.warn({ err, projectId, taskId }, 'memory.brief-injector: retrieval failed, continuing without memory')
    return { markdown: '', entryIds: [], method: 'none' }
  }

  const entryIds = entries.map((e) => e.entryId)

  // Emit MemoryRetrievedForBrief event for audit trail
  const payload: MemoryRetrievedForBriefPayload = {
    task_id: taskId,
    project_id: projectId,
    entry_ids: entryIds,
    retrieval_method: method,
    k,
  }
  await eventStore
    .append({
      aggregate_id: taskId,
      aggregate_type: 'task',
      event_type: 'MemoryRetrievedForBrief',
      payload: payload as unknown as Record<string, unknown>,
      actor: { type: 'system', component: 'orchestrator' },
      trace_id: uuidv7(),
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    })
    .catch((err) => {
      logger.warn({ err, taskId }, 'memory.brief-injector: event emit failed, continuing')
    })

  if (entries.length === 0) {
    return { markdown: '', entryIds: [], method }
  }

  const markdown = formatMemorySection(entries)
  return { markdown, entryIds, method }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatMemorySection(entries: MemoryEntry[]): string {
  const lines: string[] = [
    `## Project memory (top ${entries.length} relevant entries)`,
    '',
  ]

  for (const entry of entries) {
    lines.push(`### [${entry.kind}] ${entry.title}`)
    lines.push('')
    lines.push(entry.body)
    lines.push('')
    lines.push(
      `_Source: ${entry.sourceKind}, recorded ${new Date(entry.createdAt).toISOString().split('T')[0]}, confidence ${entry.confidence}_`,
    )
    lines.push('')
  }

  return lines.join('\n')
}
