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
import { eq, and, inArray, ilike, or, desc, sql as dSQL } from 'drizzle-orm';
import { projectMemoryEntries, projectMemoryTags, } from '@orbital/db';
import { logger } from '../logger.js';
// ---------------------------------------------------------------------------
// Kind ranking (lower = higher priority)
// ---------------------------------------------------------------------------
const KIND_RANK = {
    decision: 0,
    anti_pattern: 1,
    convention: 2,
    learning: 3,
    glossary: 4,
};
/**
 * Retrieve top-k memory entries relevant to the given query.
 *
 * @param db        Drizzle DB instance
 * @param projectId Project to scope retrieval to
 * @param query     Title + description from the task brief
 * @param k         Number of entries to return (default: 8)
 */
export async function retrieveTopN(db, projectId, query, k = 8) {
    // Try vector search first (requires pgvector extension + stored embeddings)
    const vectorResult = await tryVectorSearch(db, projectId, query, k);
    if (vectorResult !== null) {
        return { entries: vectorResult, method: 'vector' };
    }
    // Fallback: tag-based + keyword retrieval
    const fallbackResult = await tagFallbackSearch(db, projectId, query, k);
    return { entries: fallbackResult, method: fallbackResult.length === 0 ? 'none' : 'tag_fallback' };
}
// ---------------------------------------------------------------------------
// Vector similarity search
// ---------------------------------------------------------------------------
async function tryVectorSearch(db, projectId, query, k) {
    // Check if embedding provider is configured
    const embeddingProvider = process.env['EMBEDDING_PROVIDER'] ?? 'none';
    if (embeddingProvider === 'none') {
        return null;
    }
    // Try to generate an embedding for the query
    let embedding = null;
    try {
        embedding = await generateEmbedding(`${query.title}\n\n${query.description}`);
    }
    catch (err) {
        logger.warn({ err }, 'memory.retrieval: embedding generation failed, falling back to tag search');
        return null;
    }
    if (!embedding)
        return null;
    // Build the embedding vector string for pgvector
    const vectorStr = `[${embedding.join(',')}]`;
    try {
        // Use raw SQL for pgvector cosine similarity — drizzle-orm doesn't natively
        // support pgvector operators
        const rows = await db.execute(dSQL `
        SELECT entry_id
        FROM project_memory_entries
        WHERE project_id = ${projectId}
          AND status = 'active'
          AND embedding IS NOT NULL
        ORDER BY embedding <=> ${vectorStr}::vector
        LIMIT 20
      `);
        const entryIds = rows.map((r) => r.entry_id);
        if (entryIds.length === 0)
            return null;
        const entries = await loadEntriesById(db, entryIds);
        return rerankAndSlice(entries, k);
    }
    catch (err) {
        logger.warn({ err }, 'memory.retrieval: vector search failed, falling back to tag search');
        return null;
    }
}
// ---------------------------------------------------------------------------
// Tag-based + keyword fallback search
// ---------------------------------------------------------------------------
async function tagFallbackSearch(db, projectId, query, k) {
    // Build keyword tokens from query title + description
    const queryTokens = tokenize(`${query.title} ${query.description}`);
    const queryTags = query.tags ?? [];
    // 1. Find entries with tag overlap
    let tagMatchedIds = [];
    const allQueryTerms = [...queryTags, ...queryTokens.slice(0, 10)];
    if (allQueryTerms.length > 0) {
        const tagRows = await db
            .select({ entryId: projectMemoryTags.entryId })
            .from(projectMemoryTags)
            .where(and(inArray(projectMemoryTags.tag, allQueryTerms), 
        // Join to filter by project_id + active status
        inArray(projectMemoryTags.entryId, db
            .select({ entryId: projectMemoryEntries.entryId })
            .from(projectMemoryEntries)
            .where(and(eq(projectMemoryEntries.projectId, projectId), eq(projectMemoryEntries.status, 'active'))))))
            .groupBy(projectMemoryTags.entryId)
            .orderBy(desc(dSQL `count(*)`))
            .limit(20);
        tagMatchedIds = tagRows.map((r) => r.entryId);
    }
    // 2. Keyword search in title + body for remaining slots
    const keywordConditions = queryTokens.slice(0, 5).map((token) => or(ilike(projectMemoryEntries.title, `%${token}%`), ilike(projectMemoryEntries.body, `%${token}%`)));
    const keywordRows = await db
        .select({ entryId: projectMemoryEntries.entryId })
        .from(projectMemoryEntries)
        .where(and(eq(projectMemoryEntries.projectId, projectId), eq(projectMemoryEntries.status, 'active'), keywordConditions.length > 0 ? or(...keywordConditions) : undefined))
        .orderBy(desc(projectMemoryEntries.createdAt))
        .limit(20);
    // 3. Merge candidate IDs (tag matches first, then keyword matches)
    const keywordIds = keywordRows.map((r) => r.entryId);
    const seen = new Set();
    const candidateIds = [];
    for (const id of [...tagMatchedIds, ...keywordIds]) {
        if (!seen.has(id)) {
            seen.add(id);
            candidateIds.push(id);
        }
    }
    // 4. If still no candidates, fall back to most recent active entries
    if (candidateIds.length === 0) {
        const recentRows = await db
            .select({ entryId: projectMemoryEntries.entryId })
            .from(projectMemoryEntries)
            .where(and(eq(projectMemoryEntries.projectId, projectId), eq(projectMemoryEntries.status, 'active')))
            .orderBy(desc(projectMemoryEntries.createdAt))
            .limit(k);
        return loadEntriesById(db, recentRows.map((r) => r.entryId));
    }
    const entries = await loadEntriesById(db, candidateIds.slice(0, 20));
    return rerankAndSlice(entries, k);
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * Load full MemoryEntry objects for a list of entry IDs, preserving order.
 */
async function loadEntriesById(db, entryIds) {
    if (entryIds.length === 0)
        return [];
    const [rows, allTags, allLinks] = await Promise.all([
        db
            .select()
            .from(projectMemoryEntries)
            .where(inArray(projectMemoryEntries.entryId, entryIds)),
        db
            .select()
            .from(projectMemoryTags)
            .where(inArray(projectMemoryTags.entryId, entryIds)),
        // Lazy import to avoid circular
        (async () => {
            const { projectMemoryLinks } = await import('@orbital/db');
            return db
                .select()
                .from(projectMemoryLinks)
                .where(inArray(projectMemoryLinks.entryId, entryIds));
        })(),
    ]);
    const tagsByEntry = new Map();
    for (const t of allTags) {
        if (!tagsByEntry.has(t.entryId))
            tagsByEntry.set(t.entryId, []);
        tagsByEntry.get(t.entryId).push(t.tag);
    }
    const linksByEntry = new Map();
    for (const l of allLinks) {
        if (!linksByEntry.has(l.entryId))
            linksByEntry.set(l.entryId, []);
        linksByEntry.get(l.entryId).push(l);
    }
    // Build a map for ordering by input entryIds
    const rowMap = new Map(rows.map((r) => [r.entryId, r]));
    return entryIds
        .map((id) => {
        const row = rowMap.get(id);
        if (!row)
            return null;
        return {
            entryId: row.entryId,
            projectId: row.projectId,
            kind: row.kind,
            title: row.title,
            body: row.body,
            sourceKind: row.sourceKind,
            sourceId: row.sourceId ?? null,
            confidence: row.confidence,
            scope: row.scope,
            scopeValue: row.scopeValue ?? null,
            status: row.status,
            supersededBy: row.supersededBy ?? null,
            tags: tagsByEntry.get(row.entryId) ?? [],
            links: (linksByEntry.get(row.entryId) ?? []).map((l) => ({
                linkId: l.linkId,
                entryId: l.entryId,
                linkKind: l.linkKind,
                linkValue: l.linkValue,
                createdAt: l.createdAt.toISOString(),
            })),
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
        };
    })
        .filter((e) => e !== null);
}
/**
 * Re-rank entries by kind preference + recency, then slice to top-k.
 *
 * Rank formula: kind_rank * 100 - recency_days_ago
 * Lower = better. Kind preference dominates within ~3 months.
 */
function rerankAndSlice(entries, k) {
    const now = Date.now();
    return entries
        .map((e) => {
        const kindRank = KIND_RANK[e.kind] ?? 5;
        const ageMs = now - new Date(e.createdAt).getTime();
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        const score = kindRank * 100 - ageDays;
        return { entry: e, score };
    })
        .sort((a, b) => a.score - b.score)
        .slice(0, k)
        .map((x) => x.entry);
}
/**
 * Tokenize a string into lowercase word tokens, filtering stop words.
 */
function tokenize(text) {
    const stopWords = new Set([
        'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
        'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
        'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
        'should', 'may', 'might', 'this', 'that', 'these', 'those', 'it', 'its',
        'we', 'our', 'us', 'they', 'them', 'their', 'i', 'my', 'you', 'your',
    ]);
    return text
        .toLowerCase()
        .replace(/[^a-z0-9\s_-]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !stopWords.has(w))
        .slice(0, 50); // cap token count
}
/**
 * Generate an embedding vector for the given text.
 * Calls the configured embedding provider (EMBEDDING_PROVIDER env var).
 * Currently supports: openai, anthropic-compatible, none.
 *
 * Throws if the provider is configured but the call fails.
 */
async function generateEmbedding(text) {
    const provider = process.env['EMBEDDING_PROVIDER'] ?? 'none';
    if (provider === 'none')
        return null;
    if (provider === 'openai') {
        const apiKey = process.env['OPENAI_API_KEY'];
        if (!apiKey)
            throw new Error('OPENAI_API_KEY required when EMBEDDING_PROVIDER=openai');
        const resp = await fetch('https://api.openai.com/v1/embeddings', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({ model: 'text-embedding-3-small', input: text.slice(0, 8192) }),
        });
        if (!resp.ok) {
            throw new Error(`OpenAI embeddings API error: ${resp.status} ${await resp.text()}`);
        }
        const data = (await resp.json());
        return data.data[0]?.embedding ?? null;
    }
    logger.warn({ provider }, 'memory.retrieval: unknown EMBEDDING_PROVIDER, treating as none');
    return null;
}
//# sourceMappingURL=retrieval.js.map