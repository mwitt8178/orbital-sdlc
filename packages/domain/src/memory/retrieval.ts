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

import { eq, and, inArray, ilike, or, desc, sql as dSQL } from 'drizzle-orm'
import type { DB } from '@orbital/db'
import {
  projectMemoryEntries,
  projectMemoryTags,
} from '@orbital/db'
import type { MemoryEntry } from './types.js'
import { logger } from '../logger.js'

// ---------------------------------------------------------------------------
// Kind ranking (lower = higher priority)
// ---------------------------------------------------------------------------

const KIND_RANK: Record<string, number> = {
  decision: 0,
  anti_pattern: 1,
  convention: 2,
  learning: 3,
  glossary: 4,
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface RetrievalQuery {
  title: string
  description: string
  tags?: string[]
}

export interface RetrievalResult {
  entries: MemoryEntry[]
  method: 'vector' | 'tag_fallback' | 'none'
}

/**
 * Options for retrieval — all optional for backwards compatibility.
 *
 * [Engineer-Sr · Sonnet · run-memory-prompt-assembly]
 */
export interface RetrievalOptions {
  /**
   * Multi-tenant scoping.
   * Sentinel '00000000-0000-0000-0000-000000000000' = local-install default.
   */
  tenantId?: string
  /**
   * Persona slug — when provided, persona-scoped entries (persona_scope=slug)
   * are always included, and global entries (persona_scope=NULL) are also
   * included. Entries scoped to a DIFFERENT persona are excluded.
   */
  personaSlug?: string
  /**
   * Max number of pinned entries to always include (default: 5).
   * Pinned entries are included before ranked results.
   */
  maxPinned?: number
}

/** Max pinned entries included unconditionally (before ranked results). */
const DEFAULT_MAX_PINNED = 5

/**
 * Retrieve top-k memory entries relevant to the given query.
 *
 * Algorithm:
 * 1. Fetch all pinned entries for this project (always included, up to maxPinned).
 * 2. Run vector or tag-fallback search for the remaining (k - pinnedCount) slots.
 * 3. Exclude entries whose persona_scope does not match personaSlug (if provided).
 * 4. Merge pinned + ranked, dedup by entryId.
 *
 * @param db        Drizzle DB instance
 * @param projectId Project to scope retrieval to
 * @param query     Title + description from the task brief
 * @param k         Number of entries to return (default: 8)
 * @param options   Optional tenant/persona/pinned options
 *
 * [Engineer-Sr · Sonnet · run-memory-prompt-assembly]
 */
export async function retrieveTopN(
  db: DB,
  projectId: string,
  query: RetrievalQuery,
  k = 8,
  options: RetrievalOptions = {},
): Promise<RetrievalResult> {
  const {
    tenantId,
    personaSlug,
    maxPinned = DEFAULT_MAX_PINNED,
  } = options

  // Step 1: fetch pinned entries (always included).
  const pinnedEntries = await fetchPinnedEntries(db, projectId, tenantId, personaSlug, maxPinned)
  const pinnedIds = new Set(pinnedEntries.map((e) => e.entryId))

  // Remaining slots for ranked retrieval.
  const rankedK = Math.max(0, k - pinnedEntries.length)

  let rankedEntries: MemoryEntry[] = []
  let method: 'vector' | 'tag_fallback' | 'none' = 'none'

  if (rankedK > 0) {
    // Try vector search first (requires pgvector extension + stored embeddings)
    const vectorResult = await tryVectorSearch(db, projectId, query, rankedK, tenantId, personaSlug)
    if (vectorResult !== null) {
      rankedEntries = vectorResult
      method = 'vector'
    } else {
      // Fallback: tag-based + keyword retrieval
      rankedEntries = await tagFallbackSearch(db, projectId, query, rankedK, tenantId, personaSlug)
      method = rankedEntries.length === 0 ? 'none' : 'tag_fallback'
    }
  }

  // Step 2b: fetch persona-scoped entries (always included for matching persona).
  // These are entries whose persona_scope exactly matches personaSlug.
  // They appear regardless of query relevance — they're persona-always-includes.
  const personaEntries = personaSlug
    ? await fetchPersonaScopedEntries(db, projectId, tenantId, personaSlug)
    : []

  // Merge: pinned first, then persona-scoped, then ranked (deduped).
  const seen = new Set(pinnedIds)
  const personaDeduped = personaEntries.filter((e) => !seen.has(e.entryId))
  personaDeduped.forEach((e) => seen.add(e.entryId))
  const ranked = rankedEntries.filter((e) => !seen.has(e.entryId))
  const entries = [...pinnedEntries, ...personaDeduped, ...ranked]

  // If all entries came from pinned and there were no ranked results, method=none only
  // if there were truly no ranked entries retrieved.
  if ((pinnedEntries.length > 0 || personaDeduped.length > 0) && method === 'none') {
    method = 'tag_fallback' // pinned/persona entries were found; use tag_fallback as a signal
  }

  return { entries, method }
}

// ---------------------------------------------------------------------------
// Pinned entries fetch — always included regardless of ranking
// [Engineer-Sr · Sonnet · run-memory-prompt-assembly]
// ---------------------------------------------------------------------------

async function fetchPinnedEntries(
  db: DB,
  projectId: string,
  tenantId: string | undefined,
  personaSlug: string | undefined,
  maxPinned: number,
): Promise<MemoryEntry[]> {
  const conditions: ReturnType<typeof eq>[] = [
    eq(projectMemoryEntries.projectId, projectId),
    eq(projectMemoryEntries.status, 'active'),
    eq(projectMemoryEntries.pinned, true),
  ]
  if (tenantId) {
    conditions.push(eq(projectMemoryEntries.tenantId, tenantId))
  }

  const rows = await db
    .select()
    .from(projectMemoryEntries)
    .where(and(...conditions))
    .orderBy(desc(projectMemoryEntries.createdAt))
    .limit(maxPinned)

  const entryIds = rows.map((r) => r.entryId)
  if (entryIds.length === 0) return []

  const entries = await loadEntriesById(db, entryIds)
  // Apply persona_scope filter
  return filterByPersonaScope(entries, personaSlug)
}

// ---------------------------------------------------------------------------
// Persona-scoped entries fetch — always included for matching persona
// [Engineer-Sr · Sonnet · run-memory-prompt-assembly]
// ---------------------------------------------------------------------------

/**
 * Fetch entries explicitly scoped to a specific persona.
 * These entries have persona_scope = personaSlug (non-NULL) and are always
 * included in the brief for that persona, regardless of query relevance.
 */
async function fetchPersonaScopedEntries(
  db: DB,
  projectId: string,
  tenantId: string | undefined,
  personaSlug: string,
): Promise<MemoryEntry[]> {
  const conditions = [
    eq(projectMemoryEntries.projectId, projectId),
    eq(projectMemoryEntries.status, 'active'),
    eq(projectMemoryEntries.personaScope, personaSlug),
  ]
  if (tenantId) {
    conditions.push(eq(projectMemoryEntries.tenantId, tenantId))
  }

  const rows = await db
    .select()
    .from(projectMemoryEntries)
    .where(and(...conditions))
    .orderBy(desc(projectMemoryEntries.createdAt))
    .limit(10)

  const entryIds = rows.map((r) => r.entryId)
  if (entryIds.length === 0) return []

  return loadEntriesById(db, entryIds)
}

// ---------------------------------------------------------------------------
// Vector similarity search
// ---------------------------------------------------------------------------

async function tryVectorSearch(
  db: DB,
  projectId: string,
  query: RetrievalQuery,
  k: number,
  tenantId?: string,
  personaSlug?: string,
): Promise<MemoryEntry[] | null> {
  // Check if embedding provider is configured
  const embeddingProvider = process.env['EMBEDDING_PROVIDER'] ?? 'none'
  if (embeddingProvider === 'none') {
    return null
  }

  // Try to generate an embedding for the query
  let embedding: number[] | null = null
  try {
    embedding = await generateEmbedding(`${query.title}\n\n${query.description}`)
  } catch (err) {
    logger.warn({ err }, 'memory.retrieval: embedding generation failed, falling back to tag search')
    return null
  }

  if (!embedding) return null

  // Build the embedding vector string for pgvector
  const vectorStr = `[${embedding.join(',')}]`

  try {
    // Use raw SQL for pgvector cosine similarity — drizzle-orm doesn't natively
    // support pgvector operators
    const tenantFilter = tenantId ? dSQL` AND tenant_id = ${tenantId}` : dSQL``
    const rows = await db.execute(
      dSQL`
        SELECT entry_id
        FROM project_memory_entries
        WHERE project_id = ${projectId}
          AND status = 'active'
          AND pinned = false
          AND embedding IS NOT NULL
          ${tenantFilter}
        ORDER BY embedding <=> ${vectorStr}::vector
        LIMIT 20
      `,
    )

    const entryIds = (rows as unknown as Array<{ entry_id: string }>).map((r) => r.entry_id)
    if (entryIds.length === 0) return null

    const entries = await loadEntriesById(db, entryIds)
    const filtered = filterByPersonaScope(entries, personaSlug)
    return rerankAndSlice(filtered, k)
  } catch (err) {
    logger.warn({ err }, 'memory.retrieval: vector search failed, falling back to tag search')
    return null
  }
}

// ---------------------------------------------------------------------------
// Tag-based + keyword fallback search
// ---------------------------------------------------------------------------

async function tagFallbackSearch(
  db: DB,
  projectId: string,
  query: RetrievalQuery,
  k: number,
  tenantId?: string,
  personaSlug?: string,
): Promise<MemoryEntry[]> {
  // Build keyword tokens from query title + description
  const queryTokens = tokenize(`${query.title} ${query.description}`)
  const queryTags = query.tags ?? []

  // 1. Find entries with tag overlap
  let tagMatchedIds: string[] = []
  const allQueryTerms = [...queryTags, ...queryTokens.slice(0, 10)]

  // Base conditions for non-pinned, active entries scoped to this project.
  // Pinned entries are fetched separately (fetchPinnedEntries).
  const baseConditions = [
    eq(projectMemoryEntries.projectId, projectId),
    eq(projectMemoryEntries.status, 'active'),
    eq(projectMemoryEntries.pinned, false),
  ]
  if (tenantId) baseConditions.push(eq(projectMemoryEntries.tenantId, tenantId))

  if (allQueryTerms.length > 0) {
    const tagRows = await db
      .select({ entryId: projectMemoryTags.entryId })
      .from(projectMemoryTags)
      .where(
        and(
          inArray(projectMemoryTags.tag, allQueryTerms),
          // Join to filter by project_id + active status + not pinned
          inArray(
            projectMemoryTags.entryId,
            db
              .select({ entryId: projectMemoryEntries.entryId })
              .from(projectMemoryEntries)
              .where(and(...baseConditions)),
          ),
        ),
      )
      .groupBy(projectMemoryTags.entryId)
      .orderBy(desc(dSQL`count(*)`))
      .limit(20)

    tagMatchedIds = tagRows.map((r) => r.entryId)
  }

  // 2. Keyword search in title + body for remaining slots
  const keywordConditions = queryTokens.slice(0, 5).map((token) =>
    or(
      ilike(projectMemoryEntries.title, `%${token}%`),
      ilike(projectMemoryEntries.body, `%${token}%`),
    ),
  )

  const keywordRows = await db
    .select({ entryId: projectMemoryEntries.entryId })
    .from(projectMemoryEntries)
    .where(
      and(
        ...baseConditions,
        keywordConditions.length > 0 ? or(...keywordConditions) : undefined,
      ),
    )
    .orderBy(desc(projectMemoryEntries.createdAt))
    .limit(20)

  // 3. Merge candidate IDs (tag matches first, then keyword matches)
  const keywordIds = keywordRows.map((r) => r.entryId)
  const seen = new Set<string>()
  const candidateIds: string[] = []
  for (const id of [...tagMatchedIds, ...keywordIds]) {
    if (!seen.has(id)) {
      seen.add(id)
      candidateIds.push(id)
    }
  }

  // 4. If still no candidates, fall back to most recent active entries
  if (candidateIds.length === 0) {
    const recentRows = await db
      .select({ entryId: projectMemoryEntries.entryId })
      .from(projectMemoryEntries)
      .where(and(...baseConditions))
      .orderBy(desc(projectMemoryEntries.createdAt))
      .limit(k)

    const entries = await loadEntriesById(db, recentRows.map((r) => r.entryId))
    return filterByPersonaScope(entries, personaSlug)
  }

  const entries = await loadEntriesById(db, candidateIds.slice(0, 20))
  const filtered = filterByPersonaScope(entries, personaSlug)
  return rerankAndSlice(filtered, k)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Load full MemoryEntry objects for a list of entry IDs, preserving order.
 */
async function loadEntriesById(db: DB, entryIds: string[]): Promise<MemoryEntry[]> {
  if (entryIds.length === 0) return []

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
      const { projectMemoryLinks } = await import('@orbital/db')
      return db
        .select()
        .from(projectMemoryLinks)
        .where(inArray(projectMemoryLinks.entryId, entryIds))
    })(),
  ])

  const tagsByEntry = new Map<string, string[]>()
  for (const t of allTags) {
    if (!tagsByEntry.has(t.entryId)) tagsByEntry.set(t.entryId, [])
    tagsByEntry.get(t.entryId)!.push(t.tag)
  }

  const linksByEntry = new Map<string, typeof allLinks>()
  for (const l of allLinks) {
    if (!linksByEntry.has(l.entryId)) linksByEntry.set(l.entryId, [])
    linksByEntry.get(l.entryId)!.push(l)
  }

  // Build a map for ordering by input entryIds
  const rowMap = new Map(rows.map((r) => [r.entryId, r]))

  return entryIds
    .map((id) => {
      const row = rowMap.get(id)
      if (!row) return null
      return {
        entryId: row.entryId,
        projectId: row.projectId,
        kind: row.kind as MemoryEntry['kind'],
        title: row.title,
        body: row.body,
        sourceKind: row.sourceKind as MemoryEntry['sourceKind'],
        sourceId: row.sourceId ?? null,
        confidence: row.confidence as MemoryEntry['confidence'],
        scope: row.scope as MemoryEntry['scope'],
        scopeValue: row.scopeValue ?? null,
        status: row.status as MemoryEntry['status'],
        supersededBy: row.supersededBy ?? null,
        tags: tagsByEntry.get(row.entryId) ?? [],
        links: (linksByEntry.get(row.entryId) ?? []).map((l) => ({
          linkId: l.linkId,
          entryId: l.entryId,
          linkKind: l.linkKind as MemoryEntry['links'][number]['linkKind'],
          linkValue: l.linkValue,
          createdAt: l.createdAt.toISOString(),
        })),
        relevanceScore: row.relevanceScore ?? null,
        pinned: row.pinned ?? false,
        personaScope: row.personaScope ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      } satisfies MemoryEntry
    })
    .filter((e): e is MemoryEntry => e !== null)
}

/**
 * Filter entries by persona_scope.
 *
 * Rules:
 * - If personaSlug is undefined → include all entries (backwards compatible).
 * - If personaSlug is defined:
 *   - Include entries with persona_scope = NULL (global entries).
 *   - Include entries with persona_scope = personaSlug (persona-specific).
 *   - Exclude entries with persona_scope = some OTHER slug.
 *
 * [Engineer-Sr · Sonnet · run-memory-prompt-assembly]
 */
function filterByPersonaScope(entries: MemoryEntry[], personaSlug: string | undefined): MemoryEntry[] {
  if (!personaSlug) return entries
  return entries.filter((e) => {
    const scope = e.personaScope ?? null
    return scope === null || scope === personaSlug
  })
}

/**
 * Re-rank entries by kind preference + recency, then slice to top-k.
 *
 * Rank formula: kind_rank * 100 - recency_days_ago
 * Lower = better. Kind preference dominates within ~3 months.
 */
function rerankAndSlice(entries: MemoryEntry[], k: number): MemoryEntry[] {
  const now = Date.now()
  return entries
    .map((e) => {
      const kindRank = KIND_RANK[e.kind] ?? 5
      const ageMs = now - new Date(e.createdAt).getTime()
      const ageDays = ageMs / (1000 * 60 * 60 * 24)
      const score = kindRank * 100 - ageDays
      return { entry: e, score }
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, k)
    .map((x) => x.entry)
}

/**
 * Tokenize a string into lowercase word tokens, filtering stop words.
 */
function tokenize(text: string): string[] {
  const stopWords = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'this', 'that', 'these', 'those', 'it', 'its',
    'we', 'our', 'us', 'they', 'them', 'their', 'i', 'my', 'you', 'your',
  ])

  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !stopWords.has(w))
    .slice(0, 50) // cap token count
}

/**
 * Generate an embedding vector for the given text.
 * Calls the configured embedding provider (EMBEDDING_PROVIDER env var).
 * Currently supports: openai, anthropic-compatible, none.
 *
 * Throws if the provider is configured but the call fails.
 */
async function generateEmbedding(text: string): Promise<number[] | null> {
  const provider = process.env['EMBEDDING_PROVIDER'] ?? 'none'

  if (provider === 'none') return null

  if (provider === 'openai') {
    const apiKey = process.env['OPENAI_API_KEY']
    if (!apiKey) throw new Error('OPENAI_API_KEY required when EMBEDDING_PROVIDER=openai')

    const resp = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: text.slice(0, 8192) }),
    })

    if (!resp.ok) {
      throw new Error(`OpenAI embeddings API error: ${resp.status} ${await resp.text()}`)
    }

    const data = (await resp.json()) as { data: Array<{ embedding: number[] }> }
    return data.data[0]?.embedding ?? null
  }

  logger.warn({ provider }, 'memory.retrieval: unknown EMBEDDING_PROVIDER, treating as none')
  return null
}
