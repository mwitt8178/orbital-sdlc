/**
 * memory/retrieval.ts — Semantic retrieval of project memory for brief injection.
 *
 * [Engineer-Sr · Sonnet · run-round6-04-project-memory]
 *
 * Algorithm:
 * 1. If EMBEDDING_PROVIDER is configured: generate embedding → cosine similarity
 *    search via pgvector → top-20 candidates → re-rank → top-k.
 * 2. Fallback (EMBEDDING_PROVIDER=none or extension missing): tag overlap +
 *    keyword matching + recency sort → top-k.
 *
 * v1 embedding is OPTIONAL. When not configured, retrieval still works (less
 * precise). This MUST NOT break when no embedding provider is configured.
 *
 * Kind preference order: decision > anti_pattern > convention > learning > glossary
 */
import type { DB } from '@orbital/db';
import type { MemoryEntry } from './types.js';
export interface RetrievalQuery {
    title: string;
    description: string;
    tags?: string[];
}
export interface RetrievalResult {
    entries: MemoryEntry[];
    method: 'vector' | 'tag_fallback' | 'none';
}
/**
 * Retrieve top-k memory entries relevant to the given query.
 *
 * @param db        Drizzle DB instance
 * @param projectId Project to scope retrieval to
 * @param query     Title + description from the task brief
 * @param k         Number of entries to return (default: 8)
 */
export declare function retrieveTopN(db: DB, projectId: string, query: RetrievalQuery, k?: number): Promise<RetrievalResult>;
//# sourceMappingURL=retrieval.d.ts.map