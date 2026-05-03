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
import type { DB } from '@orbital/db';
import type { EventStore } from '../events/store.js';
import { type RetrievalQuery } from './retrieval.js';
export interface MemoryBriefInjection {
    /** Markdown section to append to the brief (empty string if no entries) */
    markdown: string;
    /** Entry IDs that were included */
    entryIds: string[];
    /** Retrieval method used */
    method: 'vector' | 'tag_fallback' | 'none';
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
export declare function injectMemoryIntoBrief(db: DB, eventStore: EventStore, projectId: string, taskId: string, query: RetrievalQuery, k?: number): Promise<MemoryBriefInjection>;
//# sourceMappingURL=brief-injector.d.ts.map