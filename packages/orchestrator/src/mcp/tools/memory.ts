/**
 * MCP tools: memory.record and memory.search
 *
 * [Engineer-Sr · Sonnet · run-round6-04-project-memory]
 *
 * Capability gating:
 *   memory.record — requires `memory_write` scope in the capability bundle
 *   memory.search — requires `memory_read` scope (default: true for all personas)
 *
 * Both tools bypass the standard TOOL_TO_SCOPE_KEY gateway and perform their
 * own scope check, emitting AUTH_SCOPE_DENIED on rejection.
 */

import { z } from 'zod'
import { OrbitalError } from '@orbital/types'
import { uuidv7 } from 'uuidv7'
import type { MCPTool, ToolContext } from '../registry.js'
import { createMemoryService } from '../../memory/service.js'
import { retrieveTopN } from '../../memory/retrieval.js'
import {
  MemoryKindSchema,
  MemorySourceKindSchema,
  MemoryScopeSchema,
  MemoryLinkKindSchema,
} from '../../memory/types.js'

// ---------------------------------------------------------------------------
// Capability helpers
// ---------------------------------------------------------------------------

/**
 * Check if a capability bundle has the given custom scope.
 * Custom scopes are stored as channel_read entries in the format
 * 'capability:memory_write' or 'capability:memory_read'.
 *
 * For backwards compatibility with bundles that predate memory capability
 * gating, memory_read defaults to TRUE (all personas can search).
 * memory_write defaults to FALSE unless explicitly granted.
 */
function hasMemoryScope(ctx: ToolContext, scopeName: 'memory_read' | 'memory_write'): boolean {
  const { bundle } = ctx

  // Check channel_read for capability: entries (custom capability convention)
  const channelRead: string[] = Array.isArray(bundle.scopes?.channel_read)
    ? (bundle.scopes.channel_read as string[])
    : []

  const hasExplicit = channelRead.some(
    (s) => s === `capability:${scopeName}` || s === 'capability:*',
  )

  if (hasExplicit) return true

  // memory_read defaults to true for backwards compat (all agents can read memory)
  if (scopeName === 'memory_read') return true

  // memory_write requires explicit grant
  return false
}

// ---------------------------------------------------------------------------
// memory.record
// ---------------------------------------------------------------------------

const MemoryRecordInputSchema = z.object({
  project_id: z.string().uuid(),
  kind: MemoryKindSchema,
  title: z.string().min(1).max(300),
  body: z.string().min(1).max(20_000),
  scope: MemoryScopeSchema.default('project'),
  scope_value: z.string().optional(),
  tags: z.array(z.string().min(1).max(64)).default([]),
  links: z
    .array(
      z.object({
        link_kind: MemoryLinkKindSchema,
        link_value: z.string().min(1),
      }),
    )
    .default([]),
})

const MemoryRecordOutputSchema = z.object({
  entry_id: z.string().uuid(),
  project_id: z.string().uuid(),
  kind: z.string(),
  title: z.string(),
  created_at: z.string(),
})

export const memoryRecordTool: MCPTool<
  typeof MemoryRecordInputSchema,
  typeof MemoryRecordOutputSchema
> = {
  name: 'memory.record',
  description:
    'Record a noteworthy project memory entry (decision, convention, learning, anti_pattern, or glossary). ' +
    'Requires memory_write capability scope. ' +
    'Use when you discover something the team should remember: library choices, rejected approaches, naming conventions.',
  inputSchema: MemoryRecordInputSchema,
  outputSchema: MemoryRecordOutputSchema,
  bypassScopeCheck: true,

  async handler(input, ctx: ToolContext) {
    // Capability check: memory_write scope required
    if (!hasMemoryScope(ctx, 'memory_write')) {
      throw new OrbitalError(
        'AUTH_SCOPE_DENIED',
        'memory.record requires memory_write capability scope. ' +
          'This persona does not have write access to project memory.',
        { required_scope: 'memory_write' },
        'no_retry',
      )
    }

    const memoryService = createMemoryService(ctx.db, ctx.eventStore)

    const entry = await memoryService.record(
      {
        projectId: input.project_id,
        kind: input.kind,
        title: input.title,
        body: input.body,
        sourceKind: 'agent',
        sourceId: ctx.bundle.task_id,
        confidence: 'medium',
        scope: input.scope,
        scopeValue: input.scope_value,
        tags: input.tags,
        links: input.links.map((l) => ({
          linkKind: l.link_kind,
          linkValue: l.link_value,
        })),
      },
      ctx.bundle.persona_id,
    )

    return {
      entry_id: entry.entryId,
      project_id: entry.projectId,
      kind: entry.kind,
      title: entry.title,
      created_at: entry.createdAt,
    }
  },
}

// ---------------------------------------------------------------------------
// memory.search
// ---------------------------------------------------------------------------

const MemorySearchInputSchema = z.object({
  project_id: z.string().uuid(),
  query: z.string().min(1),
  k: z.number().int().min(1).max(20).default(8),
})

const MemorySearchOutputSchema = z.object({
  entries: z.array(
    z.object({
      entry_id: z.string().uuid(),
      kind: z.string(),
      title: z.string(),
      body: z.string(),
      confidence: z.string(),
      scope: z.string(),
      tags: z.array(z.string()),
      created_at: z.string(),
    }),
  ),
  method: z.enum(['vector', 'tag_fallback', 'none']),
  total: z.number().int(),
})

export const memorySearchTool: MCPTool<
  typeof MemorySearchInputSchema,
  typeof MemorySearchOutputSchema
> = {
  name: 'memory.search',
  description:
    'Search project memory for relevant entries. Returns top-k entries ranked by relevance. ' +
    'Requires memory_read capability scope (default: all personas have this). ' +
    'Use before starting work to discover prior decisions and conventions.',
  inputSchema: MemorySearchInputSchema,
  outputSchema: MemorySearchOutputSchema,
  bypassScopeCheck: true,

  async handler(input, ctx: ToolContext) {
    // Capability check: memory_read scope required (defaults to true)
    if (!hasMemoryScope(ctx, 'memory_read')) {
      throw new OrbitalError(
        'AUTH_SCOPE_DENIED',
        'memory.search requires memory_read capability scope.',
        { required_scope: 'memory_read' },
        'no_retry',
      )
    }

    const result = await retrieveTopN(
      ctx.db,
      input.project_id,
      { title: input.query, description: input.query },
      input.k,
    )

    return {
      entries: result.entries.map((e) => ({
        entry_id: e.entryId,
        kind: e.kind,
        title: e.title,
        body: e.body,
        confidence: e.confidence,
        scope: e.scope,
        tags: e.tags,
        created_at: e.createdAt,
      })),
      method: result.method,
      total: result.entries.length,
    }
  },
}
