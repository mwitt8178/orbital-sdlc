/**
 * MCP tool: mapping.resolve
 *
 * Per Round 5 Monday Board Discovery spec.
 *
 * Allows persona workers to read the project's confirmed BoardMapping at
 * runtime so they can write to the correct Monday columns. The tool is
 * read-only (no mutation, no Monday API call) — it just looks up the mapping
 * the user confirmed via the Settings UI.
 *
 * Capability scope: bypassScopeCheck=true. The tool returns mapping
 * metadata only (column ids, labels, terminology) — no PII, no secrets.
 * The bundle's session validity is still enforced by the gateway.
 *
 * Use kinds:
 *   - 'status'    — { column_id, labels: [{label, state}] }
 *   - 'ac'        — { kind: 'column'|'subitem'|'none', column_id?, subitem_template_id? }
 *   - 'estimate'  — { column_id, unit }
 *   - 'priority'  — { column_id }
 *   - 'assignee'  — { column_id }
 *   - 'all'       — full BoardMapping
 *
 * The tool returns null when no mapping is confirmed for the project.
 */

import { z } from 'zod'
import type { MCPTool, ToolContext } from '../registry.js'
import type { BoardMappingResolver } from '../../backlog/board-mapping-resolver.js'
import { ORBITAL_STATES } from '../../backlog/board-mapping.js'

const MappingResolveInputSchema = z.object({
  /** project_id whose mapping to read. */
  project_id: z.string().uuid(),
  /** Which slice of the mapping to read. */
  kind: z.enum(['status', 'ac', 'estimate', 'priority', 'assignee', 'all']),
})

const MappingResolveOutputSchema = z.object({
  found: z.boolean(),
  /** Set when kind === 'all'. Full BoardMapping (already validated). */
  mapping: z.unknown().nullable(),
  /** Set when kind === 'status'. */
  status: z
    .object({
      column_id: z.string(),
      labels: z.array(
        z.object({
          label: z.string(),
          state: z.enum(ORBITAL_STATES),
        }),
      ),
    })
    .nullable(),
  /** Set when kind === 'ac'. */
  ac: z
    .object({
      kind: z.enum(['column', 'subitem', 'none']),
      column_id: z.string().optional(),
      subitem_template_id: z.string().optional(),
    })
    .nullable(),
  /** Set when kind === 'estimate'. */
  estimate: z
    .object({
      column_id: z.string(),
      unit: z.enum(['story_points', 'hours', 't_shirt', 'none']),
    })
    .nullable(),
  /** Set when kind === 'priority' or 'assignee'. */
  column_ref: z
    .object({
      column_id: z.string(),
    })
    .nullable(),
})

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the mapping.resolve MCP tool. We accept the resolver as a closure
 * capture so the tool registration site can wire any resolver instance
 * (production singleton, test fixture, etc.).
 */
export function buildMappingResolveTool(
  resolver: BoardMappingResolver,
): MCPTool<typeof MappingResolveInputSchema, typeof MappingResolveOutputSchema> {
  return {
    name: 'mapping.resolve',
    description:
      "Read the project's confirmed BoardMapping (Monday column ids and labels) so the persona writes to the correct columns. Read-only.",
    inputSchema: MappingResolveInputSchema,
    outputSchema: MappingResolveOutputSchema,
    bypassScopeCheck: true,

    async handler(input, _ctx: ToolContext) {
      const { project_id, kind } = input
      const empty = {
        found: false,
        mapping: null,
        status: null,
        ac: null,
        estimate: null,
        column_ref: null,
      }

      if (kind === 'all') {
        const mapping = await resolver.getMapping(project_id)
        if (!mapping) return empty
        return { ...empty, found: true, mapping }
      }

      if (kind === 'status') {
        const status = await resolver.resolveStatusColumn(project_id)
        if (!status) return empty
        const labels = status.labels.map((label) => {
          const state = status.state_for_label(label)
          return { label, state: state ?? 'backlog' }
        })
        return {
          ...empty,
          found: true,
          status: { column_id: status.column_id, labels },
        }
      }

      if (kind === 'ac') {
        const ac = await resolver.resolveACSource(project_id)
        if (ac.kind === 'none') return empty
        const out: { kind: 'column' | 'subitem'; column_id?: string; subitem_template_id?: string } = {
          kind: ac.kind,
        }
        if (ac.column_id) out.column_id = ac.column_id
        if (ac.subitem_template_id) out.subitem_template_id = ac.subitem_template_id
        return {
          ...empty,
          found: true,
          ac: out,
        }
      }

      if (kind === 'estimate') {
        const est = await resolver.resolveEstimateColumn(project_id)
        if (!est) return empty
        return { ...empty, found: true, estimate: est }
      }

      if (kind === 'priority') {
        const pr = await resolver.resolvePriorityColumn(project_id)
        if (!pr) return empty
        return { ...empty, found: true, column_ref: pr }
      }

      if (kind === 'assignee') {
        const a = await resolver.resolveAssigneeColumn(project_id)
        if (!a) return empty
        return { ...empty, found: true, column_ref: a }
      }

      return empty
    },
  }
}
