/**
 * backlog/board-mapping-resolver.ts — BoardMappingResolver.
 *
 * Per Round 5 Monday Board Discovery spec.
 *
 * Personas and the MondaySyncService need to know the project's confirmed
 * mapping at runtime so they write to the correct Monday columns. The resolver
 * is a thin caching wrapper over BoardMappingService.get(projectId), with
 * convenience helpers that surface common questions:
 *
 *   - resolveStatusColumn(projectId)  → { column_id, label_for_state(state) }
 *   - resolveACSource(projectId)      → { kind: 'column'|'subitem'|'none', ... }
 *   - resolveEstimateColumn(projectId)→ { column_id, unit }
 *
 * All methods return null/'none' when no confirmed mapping exists. The caller
 * decides whether to skip the write (graceful degradation) or surface an
 * error.
 *
 * Caching: a 60-second in-memory TTL keyed on projectId. The cache is small
 * (mappings are rare to confirm) and invalidated by calling invalidate(pid).
 */

import type { BoardMappingService, BoardMapping, OrbitalState } from './board-mapping.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ResolvedStatusColumn {
  column_id: string
  /**
   * Translate an Orbital state to the Monday status label TEXT. Returns null
   * when no label maps to this state (e.g. the team has no 'accepted' label).
   * The MondaySyncService should skip the write rather than synthesize a
   * label.
   */
  label_for_state(state: OrbitalState): string | null
  /** Inverse: Monday label → Orbital state. */
  state_for_label(label: string): OrbitalState | null
  /** All known labels (for UI surface). */
  labels: string[]
}

export interface ResolvedACSource {
  kind: 'column' | 'subitem' | 'none'
  /** Set when kind === 'column'. */
  column_id?: string
  /** Set when kind === 'subitem'. The special token 'name' means the subitem name itself is the AC. */
  subitem_template_id?: string
}

export interface ResolvedEstimateColumn {
  column_id: string
  unit: 'story_points' | 'hours' | 't_shirt' | 'none'
}

// ---------------------------------------------------------------------------
// Resolver interface
// ---------------------------------------------------------------------------

export interface BoardMappingResolver {
  /** Get the raw confirmed mapping. */
  getMapping(projectId: string): Promise<BoardMapping | null>
  resolveStatusColumn(projectId: string): Promise<ResolvedStatusColumn | null>
  resolveACSource(projectId: string): Promise<ResolvedACSource>
  resolveEstimateColumn(projectId: string): Promise<ResolvedEstimateColumn | null>
  resolvePriorityColumn(projectId: string): Promise<{ column_id: string } | null>
  resolveAssigneeColumn(projectId: string): Promise<{ column_id: string } | null>
  invalidate(projectId: string): void
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const DEFAULT_TTL_MS = 60_000

interface CacheEntry {
  mapping: BoardMapping | null
  expires_at: number
}

export class DefaultBoardMappingResolver implements BoardMappingResolver {
  private readonly cache = new Map<string, CacheEntry>()

  constructor(
    private readonly mappingService: BoardMappingService,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  async getMapping(projectId: string): Promise<BoardMapping | null> {
    const now = Date.now()
    const cached = this.cache.get(projectId)
    if (cached && cached.expires_at > now) {
      return cached.mapping
    }
    const fresh = await this.mappingService.get(projectId)
    this.cache.set(projectId, { mapping: fresh, expires_at: now + this.ttlMs })
    return fresh
  }

  async resolveStatusColumn(projectId: string): Promise<ResolvedStatusColumn | null> {
    const mapping = await this.getMapping(projectId)
    if (!mapping || !mapping.status_column_id) return null
    const stateToLabel = invertLabelToState(mapping.status_label_to_state)
    const labels = Object.keys(mapping.status_label_to_state)
    return {
      column_id: mapping.status_column_id,
      label_for_state: (state) => stateToLabel.get(state) ?? null,
      state_for_label: (label) => mapping.status_label_to_state[label] ?? null,
      labels,
    }
  }

  async resolveACSource(projectId: string): Promise<ResolvedACSource> {
    const mapping = await this.getMapping(projectId)
    if (!mapping) return { kind: 'none' }
    if (mapping.ac_subitem_template_id) {
      return { kind: 'subitem', subitem_template_id: mapping.ac_subitem_template_id }
    }
    if (mapping.ac_column_id) {
      return { kind: 'column', column_id: mapping.ac_column_id }
    }
    return { kind: 'none' }
  }

  async resolveEstimateColumn(projectId: string): Promise<ResolvedEstimateColumn | null> {
    const mapping = await this.getMapping(projectId)
    if (!mapping || !mapping.estimate_column_id) return null
    return {
      column_id: mapping.estimate_column_id,
      unit: mapping.story_points_unit,
    }
  }

  async resolvePriorityColumn(projectId: string): Promise<{ column_id: string } | null> {
    const mapping = await this.getMapping(projectId)
    if (!mapping || !mapping.priority_column_id) return null
    return { column_id: mapping.priority_column_id }
  }

  async resolveAssigneeColumn(projectId: string): Promise<{ column_id: string } | null> {
    const mapping = await this.getMapping(projectId)
    if (!mapping || !mapping.assignee_column_id) return null
    return { column_id: mapping.assignee_column_id }
  }

  invalidate(projectId: string): void {
    this.cache.delete(projectId)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function invertLabelToState(
  labelToState: Record<string, OrbitalState>,
): Map<OrbitalState, string> {
  const out = new Map<OrbitalState, string>()
  // First label wins for each state — deterministic given Object.entries order.
  for (const [label, state] of Object.entries(labelToState)) {
    if (!out.has(state)) {
      out.set(state, label)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createBoardMappingResolver(
  mappingService: BoardMappingService,
  ttlMs?: number,
): BoardMappingResolver {
  return new DefaultBoardMappingResolver(mappingService, ttlMs)
}
