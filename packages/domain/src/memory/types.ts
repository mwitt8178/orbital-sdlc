/**
 * memory/types.ts — Domain types for the project memory subsystem.
 *
 * [Engineer-Sr · Sonnet · run-round6-04-project-memory]
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const MemoryKindSchema = z.enum([
  'decision',
  'convention',
  'learning',
  'anti_pattern',
  'glossary',
])
export type MemoryKind = z.infer<typeof MemoryKindSchema>

export const MemorySourceKindSchema = z.enum([
  'agent',
  'operator',
  'reviewer',
  'retro',
  'vision',
])
export type MemorySourceKind = z.infer<typeof MemorySourceKindSchema>

export const MemoryConfidenceSchema = z.enum(['low', 'medium', 'high'])
export type MemoryConfidence = z.infer<typeof MemoryConfidenceSchema>

export const MemoryScopeSchema = z.enum(['project', 'feature', 'file_pattern'])
export type MemoryScope = z.infer<typeof MemoryScopeSchema>

export const MemoryStatusSchema = z.enum(['active', 'archived', 'superseded'])
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>

export const MemoryLinkKindSchema = z.enum(['pr', 'task', 'retro', 'vision', 'adr'])
export type MemoryLinkKind = z.infer<typeof MemoryLinkKindSchema>

// ---------------------------------------------------------------------------
// Core domain objects
// ---------------------------------------------------------------------------

export const MemoryLinkSchema = z.object({
  linkId: z.string().uuid(),
  entryId: z.string().uuid(),
  linkKind: MemoryLinkKindSchema,
  linkValue: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }),
})
export type MemoryLink = z.infer<typeof MemoryLinkSchema>

export const MemoryEntrySchema = z.object({
  entryId: z.string().uuid(),
  projectId: z.string().uuid(),
  kind: MemoryKindSchema,
  title: z.string().min(1),
  body: z.string().min(1),
  sourceKind: MemorySourceKindSchema,
  sourceId: z.string().uuid().nullable(),
  confidence: MemoryConfidenceSchema,
  scope: MemoryScopeSchema,
  scopeValue: z.string().nullable(),
  status: MemoryStatusSchema,
  supersededBy: z.string().uuid().nullable(),
  tags: z.array(z.string()),
  links: z.array(MemoryLinkSchema),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
})
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export const CreateMemoryEntryInputSchema = z.object({
  projectId: z.string().uuid(),
  kind: MemoryKindSchema,
  title: z.string().min(1).max(300),
  body: z.string().min(1).max(20_000),
  sourceKind: MemorySourceKindSchema,
  sourceId: z.string().uuid().optional(),
  confidence: MemoryConfidenceSchema.default('medium'),
  scope: MemoryScopeSchema.default('project'),
  scopeValue: z.string().optional(),
  tags: z.array(z.string().min(1).max(64)).default([]),
  links: z
    .array(
      z.object({
        linkKind: MemoryLinkKindSchema,
        linkValue: z.string().min(1),
      }),
    )
    .default([]),
})
export type CreateMemoryEntryInput = z.infer<typeof CreateMemoryEntryInputSchema>

export const UpdateMemoryEntryInputSchema = z.object({
  entryId: z.string().uuid(),
  title: z.string().min(1).max(300).optional(),
  body: z.string().min(1).max(20_000).optional(),
  confidence: MemoryConfidenceSchema.optional(),
  scope: MemoryScopeSchema.optional(),
  scopeValue: z.string().optional(),
  tags: z.array(z.string().min(1).max(64)).optional(),
})
export type UpdateMemoryEntryInput = z.infer<typeof UpdateMemoryEntryInputSchema>

export const ArchiveMemoryEntryInputSchema = z.object({
  entryId: z.string().uuid(),
})

export const SupersedeMemoryEntryInputSchema = z.object({
  entryId: z.string().uuid(),
  supersededByEntryId: z.string().uuid(),
})

export const ListMemoryEntriesInputSchema = z.object({
  projectId: z.string().uuid(),
  kind: MemoryKindSchema.optional(),
  scope: MemoryScopeSchema.optional(),
  status: MemoryStatusSchema.default('active'),
  sourceKind: MemorySourceKindSchema.optional(),
  /** Free-text search (title + body match) */
  search: z.string().optional(),
  /** Tag filter — entries must have ALL of these tags */
  tags: z.array(z.string()).default([]),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
})
export type ListMemoryEntriesInput = z.infer<typeof ListMemoryEntriesInputSchema>

export const SearchMemoryInputSchema = z.object({
  projectId: z.string().uuid(),
  query: z.string().min(1),
  k: z.number().int().min(1).max(20).default(8),
  filter: z
    .object({
      kind: MemoryKindSchema.optional(),
      scope: MemoryScopeSchema.optional(),
    })
    .optional(),
})
export type SearchMemoryInput = z.infer<typeof SearchMemoryInputSchema>

// ---------------------------------------------------------------------------
// Event payloads
// ---------------------------------------------------------------------------

export interface MemoryEntryRecordedPayload {
  entry_id: string
  project_id: string
  kind: MemoryKind
  title: string
  source_kind: MemorySourceKind
  source_id: string | null
  tags: string[]
}

export interface MemoryEntryCuratedPayload {
  entry_id: string
  project_id: string
  field_changed: string
  old_value?: unknown
  new_value?: unknown
}

export interface MemoryEntryArchivedPayload {
  entry_id: string
  project_id: string
}

export interface MemoryRetrievedForBriefPayload {
  task_id: string
  project_id: string
  entry_ids: string[]
  retrieval_method: 'vector' | 'tag_fallback' | 'none'
  k: number
}
