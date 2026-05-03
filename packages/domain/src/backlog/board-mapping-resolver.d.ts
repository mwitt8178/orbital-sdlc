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
import type { BoardMappingService, BoardMapping, OrbitalState } from './board-mapping.js';
export interface ResolvedStatusColumn {
    column_id: string;
    /**
     * Translate an Orbital state to the Monday status label TEXT. Returns null
     * when no label maps to this state (e.g. the team has no 'accepted' label).
     * The MondaySyncService should skip the write rather than synthesize a
     * label.
     */
    label_for_state(state: OrbitalState): string | null;
    /** Inverse: Monday label → Orbital state. */
    state_for_label(label: string): OrbitalState | null;
    /** All known labels (for UI surface). */
    labels: string[];
}
export interface ResolvedACSource {
    kind: 'column' | 'subitem' | 'none';
    /** Set when kind === 'column'. */
    column_id?: string;
    /** Set when kind === 'subitem'. The special token 'name' means the subitem name itself is the AC. */
    subitem_template_id?: string;
}
export interface ResolvedEstimateColumn {
    column_id: string;
    unit: 'story_points' | 'hours' | 't_shirt' | 'none';
}
export interface BoardMappingResolver {
    /** Get the raw confirmed mapping. */
    getMapping(projectId: string): Promise<BoardMapping | null>;
    resolveStatusColumn(projectId: string): Promise<ResolvedStatusColumn | null>;
    resolveACSource(projectId: string): Promise<ResolvedACSource>;
    resolveEstimateColumn(projectId: string): Promise<ResolvedEstimateColumn | null>;
    resolvePriorityColumn(projectId: string): Promise<{
        column_id: string;
    } | null>;
    resolveAssigneeColumn(projectId: string): Promise<{
        column_id: string;
    } | null>;
    invalidate(projectId: string): void;
}
export declare class DefaultBoardMappingResolver implements BoardMappingResolver {
    private readonly mappingService;
    private readonly ttlMs;
    private readonly cache;
    constructor(mappingService: BoardMappingService, ttlMs?: number);
    getMapping(projectId: string): Promise<BoardMapping | null>;
    resolveStatusColumn(projectId: string): Promise<ResolvedStatusColumn | null>;
    resolveACSource(projectId: string): Promise<ResolvedACSource>;
    resolveEstimateColumn(projectId: string): Promise<ResolvedEstimateColumn | null>;
    resolvePriorityColumn(projectId: string): Promise<{
        column_id: string;
    } | null>;
    resolveAssigneeColumn(projectId: string): Promise<{
        column_id: string;
    } | null>;
    invalidate(projectId: string): void;
}
export declare function createBoardMappingResolver(mappingService: BoardMappingService, ttlMs?: number): BoardMappingResolver;
//# sourceMappingURL=board-mapping-resolver.d.ts.map