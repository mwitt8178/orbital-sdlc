/**
 * memory.ts — Drizzle schema for the project memory subsystem.
 *
 * [Engineer-Sr · Sonnet · run-round6-04-project-memory]
 *
 * Per Round 6 Task #4 architecture.md data model.
 *
 * Three tables:
 *   project_memory_entries  — core memory store with optional pgvector embedding
 *   project_memory_tags     — tag index for fallback retrieval
 *   project_memory_links    — cross-links to tasks, PRs, retros, ADRs, visions
 *
 * NOTE: drizzle-orm does not have a built-in `vector` column type for pgvector.
 * We represent the embedding column as `text` in the Drizzle schema (it stores
 * the vector in the native Postgres format '[0.1,0.2,...]') and cast to/from
 * `vector(1536)` in raw SQL when needed. When pgvector is not installed the
 * column stores NULL and tag-based retrieval is used instead.
 */

import { pgTable, uuid, text, timestamp, index, primaryKey, doublePrecision, boolean } from 'drizzle-orm/pg-core'

// ---------------------------------------------------------------------------
// project_memory_entries
// ---------------------------------------------------------------------------

export const projectMemoryEntries = pgTable(
  'project_memory_entries',
  {
    entryId: uuid('entry_id').primaryKey(),
    /**
     * Round 7-01 — Multi-tenant scoping.
     * Sentinel '00000000-0000-0000-0000-000000000000' = local-install default.
     * [Engineer-Sr · Sonnet · run-round7-01-extract-hub]
     */
    tenantId: uuid('tenant_id').notNull().default('00000000-0000-0000-0000-000000000000'),
    /** Logical FK → projects.project_id (nullable-uuid convention — no physical FK) */
    projectId: uuid('project_id').notNull(),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    sourceKind: text('source_kind').notNull(),
    /** task_id, retro_id, etc. — NULL for operator-authored entries */
    sourceId: uuid('source_id'),
    confidence: text('confidence').notNull().default('medium'),
    scope: text('scope').notNull().default('project'),
    /** e.g. 'auth' for feature, 'src/api/**' for file_pattern */
    scopeValue: text('scope_value'),
    status: text('status').notNull().default('active'),
    /** uuid of the entry that supersedes this one */
    supersededBy: uuid('superseded_by'),
    /**
     * pgvector embedding stored as text ('[0.1,0.2,...]' format).
     * NULL when pgvector extension is not available or embedding not generated.
     * Actual DB column type is vector(1536) — Drizzle represents it as text
     * since drizzle-orm/pg-core does not natively support pgvector types.
     */
    embedding: text('embedding'),
    /**
     * Migration 0051 — memory-prompt-assembly.
     * Pre-computed relevance score at retrieval time (0.0–1.0).
     * NULL until a retrieval scores this entry against a task context.
     * [Engineer-Sr · Sonnet · run-memory-prompt-assembly]
     */
    relevanceScore: doublePrecision('relevance_score'),
    /**
     * Migration 0051 — pinned entries are always injected into the prompt
     * regardless of retrieval ranking (up to MAX_PINNED_ENTRIES=5).
     */
    pinned: boolean('pinned').notNull().default(false),
    /**
     * Migration 0051 — optional persona slug filter.
     * When non-NULL, entry is only injected for the named persona.
     * When NULL, entry is injected for all personas.
     */
    personaScope: text('persona_scope'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('pm_entries_project_idx').on(t.projectId, t.status),
    index('pm_entries_kind_idx').on(t.projectId, t.kind, t.status),
    index('pm_entries_pinned_idx').on(t.projectId, t.pinned),
    index('pm_entries_tenant_project_idx').on(t.tenantId, t.projectId, t.status),
  ],
)

export type ProjectMemoryEntryRow = typeof projectMemoryEntries.$inferSelect
export type ProjectMemoryEntryInsert = typeof projectMemoryEntries.$inferInsert

// ---------------------------------------------------------------------------
// project_memory_tags
// ---------------------------------------------------------------------------

export const projectMemoryTags = pgTable(
  'project_memory_tags',
  {
    entryId: uuid('entry_id').notNull(),
    tag: text('tag').notNull(),
    /**
     * Round 7-01 — Multi-tenant scoping.
     * [Engineer-Sr · Sonnet · run-round7-01-extract-hub]
     */
    tenantId: uuid('tenant_id').notNull().default('00000000-0000-0000-0000-000000000000'),
  },
  (t) => [
    primaryKey({ columns: [t.entryId, t.tag] }),
    index('pm_tags_entry_idx').on(t.entryId),
  ],
)

export type ProjectMemoryTagRow = typeof projectMemoryTags.$inferSelect

// ---------------------------------------------------------------------------
// project_memory_links
// ---------------------------------------------------------------------------

export const projectMemoryLinks = pgTable(
  'project_memory_links',
  {
    linkId: uuid('link_id').primaryKey(),
    /**
     * Round 7-01 — Multi-tenant scoping.
     * [Engineer-Sr · Sonnet · run-round7-01-extract-hub]
     */
    tenantId: uuid('tenant_id').notNull().default('00000000-0000-0000-0000-000000000000'),
    entryId: uuid('entry_id').notNull(),
    linkKind: text('link_kind').notNull(),
    linkValue: text('link_value').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('pm_links_entry_idx').on(t.entryId)],
)

export type ProjectMemoryLinkRow = typeof projectMemoryLinks.$inferSelect
export type ProjectMemoryLinkInsert = typeof projectMemoryLinks.$inferInsert
